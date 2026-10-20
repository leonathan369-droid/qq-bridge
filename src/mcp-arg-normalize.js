// MCP 工具入参兜底：把模型多包的一层 `{"arguments": {...}}` 摊平。
//
// 为什么需要：部分模型（实测 AMD 的 DeepSeek-V4-Flash-Vision-Exp）调用工具时会把参数
// 再包一层，变成 `{"arguments": {"key": "...", "messages": "..."}}`；MCP SDK 在
// CallToolRequest 处理器里先用 zod 按工具 schema 校验，于是直接抛
// `MCP error -32602: Input validation error: ... expected string, received undefined at key`，
// 模型只能反复重试（实测一次发送连错 6 次，白烧 30 秒和 6 个回合）。
//
// 这里给低层 Server 的 setRequestHandler 包一层：只命中「唯一键是 arguments、值是普通对象」
// 的形态才摊平，正常参数一个字节都不动，因此不会掩盖真正的参数错误。
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

/**
 * 在注册任何工具**之前**调用，才能包到 McpServer 稍后装上的 CallTool 处理器。
 * @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} server
 */
export function installMcpArgumentUnwrapper(server) {
  const low = server.server;
  if (!low || typeof low.setRequestHandler !== 'function') return;
  const originalSet = low.setRequestHandler.bind(low);
  low.setRequestHandler = (schema, handler) => {
    if (schema !== CallToolRequestSchema) return originalSet(schema, handler);
    return originalSet(schema, async (request, extra) => {
      try {
        let args = request?.params?.arguments;
        for (let depth = 0; depth < 10; depth += 1) {
          if (!args || typeof args !== 'object' || Array.isArray(args)) break;
          const keys = Object.keys(args);
          if (keys.length !== 1 || keys[0] !== 'arguments') break;
          const inner = args.arguments;
          if (!inner || typeof inner !== 'object' || Array.isArray(inner)) break;
          args = inner;
        }
        if (args !== request?.params?.arguments) request.params.arguments = args;
      } catch {}
      return handler(request, extra);
    });
  };
}
