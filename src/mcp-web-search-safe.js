// 安全版 Web Search / Fetch MCP server（stdio）。由 DSH 的 MCP 客户端 spawn。
//
// 安全设计：
// - 只暴露只读工具 `web_search` 与 `web_fetch`：查网络用语/梗/黑话、抓取网页正文。
// - 不暴露任何本地文件、命令执行、写操作。
// - 查询词做基础清洗：去 CQ 码、控制字符、超长截断。
// - `web_fetch` 仅允许 http/https：
//   - 禁止 URL 内嵌凭据；
//   - 禁止 localhost / .local / 私有 IP / 环回 / 链路本地 / CGNAT 等内网地址；
//   - 域名会先做 DNS 解析并检查全部解析结果，避免解析到内网；
//   - 手动跟随重定向，每一跳都重新校验；
//   - 响应体按字节流限量读取，避免超大响应拖垮进程。
// - 搜索结果/抓取结果仅作为“候选解释”，最终是否入库仍由控制台人工确认。
import { safeFetch } from './safe-fetch.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

function sanitizeQuery(query) {
  return String(query ?? '')
    // 去掉 CQ 码（[CQ:xxx]）
    .replace(/\[CQ:[^\]]*\]/gi, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

function decodeHtml(s) {
  return String(s ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function bingSearch(query) {
  // 必须用 www.bing.com：cn.bing.com 在本机网络下会对中文长查询直接返回
  // 「没有与此相关的结果」空页（实测 10 条常见黑话查询里 7 条为 0 结果），
  // 而同一 query 走 www.bing.com 12/12 都有结果。
  const url = new URL('https://www.bing.com/search');
  url.searchParams.set('q', query);
  // 搜索也使用同一条受限传输链路，重定向必须重新校验，正文最多 512K 字符。
  const res = await safeFetch(url.toString(), 512000);
  if (res.statusCode < 200 || res.statusCode >= 300) throw new Error(`搜索服务 HTTP ${res.statusCode}`);
  const html = res.body;
  const results = [];
  const blocks = html.split('<li class="b_algo"').slice(1);
  for (const block of blocks) {
    const hrefMatch = block.match(/<a[^>]+href="(https?:\/\/[^"]+)"/i);
    if (!hrefMatch) continue;
    const urlStr = decodeHtml(hrefMatch[1]);
    const titleMatch = block.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
    const title = titleMatch ? decodeHtml(titleMatch[1]) : '';
    const snippetMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const snippet = snippetMatch ? decodeHtml(snippetMatch[1]) : '';
    if (urlStr && title) results.push({ title, url: urlStr, snippet });
    if (results.length >= 8) break;
  }
  return { query, results };
}

// 360 搜索作为主引擎：中文网络用语/梗的召回明显好于 Bing
// （实测「难绷 什么意思」「神金 梗」「可乐标 小米」等 Bing 返回单字词典垃圾结果，
// 360 能直接返回「难以绷住」「神经谐音」「小米徕卡可乐标」这类可用释义）。
async function soSearch(query) {
  const url = new URL('https://www.so.com/s');
  url.searchParams.set('q', query);
  const res = await safeFetch(url.toString(), 512000);
  if (res.statusCode < 200 || res.statusCode >= 300) throw new Error(`搜索服务 HTTP ${res.statusCode}`);
  const results = [];
  for (const block of res.body.split('<li class="res-list').slice(1)) {
    const head = block.match(/<h3[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!head) continue;
    const urlStr = decodeHtml(head[1]);
    const title = decodeHtml(head[2]);
    const descMatch = block.match(/<p class="res-desc"[^>]*>([\s\S]*?)<\/p>/i);
    const snippet = descMatch ? decodeHtml(descMatch[1]) : '';
    if (!urlStr || !title) continue;
    results.push({ title, url: urlStr, snippet });
    if (results.length >= 8) break;
  }
  return { query, results, engine: 'so' };
}

import { installMcpArgumentUnwrapper } from './mcp-arg-normalize.js';

const server = new McpServer({ name: 'web-search-safe', version: '0.2.0-r3' });
installMcpArgumentUnwrapper(server);

server.tool(
  'web_search',
  '只读搜索网络用语/梗/黑话的含义，返回搜索结果（标题/URL/摘要）。主引擎 360、回退 Bing。仅用于理解词义，不执行任何本地操作。',
  { query: z.string().describe('要搜索确认的网络用语/黑话/梗') },
  async ({ query }) => {
    const clean = sanitizeQuery(query);
    if (!clean) {
      return { content: [{ type: 'text', text: '查询词为空，已拒绝。' }], isError: true };
    }
    try {
      // 主引擎 360（中文梗/黑话召回好），失败或 0 结果再回退 Bing。
      let result = null;
      let lastError = null;
      try {
        const so = await soSearch(clean);
        if (so.results.length) result = so;
      } catch (error) {
        lastError = error;
      }
      if (!result) {
        try {
          result = await bingSearch(clean);
        } catch (error) {
          lastError = error;
        }
      }
      if (!result) throw lastError ?? new Error('搜索无结果');
      // 结果里混着「_360图片」「短视频大全」这类没有摘要的条目；有至少 3 条带摘要时
      // 只保留带摘要的，避免模型把「难绷图片」当正文去 fetch 而浪费回合。
      const rich = result.results.filter((r) => String(r.snippet || '').length >= 10);
      if (rich.length >= 3) result = { ...result, results: rich };
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `搜索失败：${error?.message ?? error}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  'web_fetch',
  '只读抓取 HTTP(S) 网页正文，返回纯文本/HTML 前 50000 字符。禁止访问内网/本机地址，不执行任何本地操作。',
  { url: z.string().describe('要抓取的 http(s) URL') },
  async ({ url }) => {
    try {
      const result = await safeFetch(url);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `抓取失败：${error?.message ?? error}` }],
        isError: true,
      };
    }
  }
);

await server.connect(new StdioServerTransport());
