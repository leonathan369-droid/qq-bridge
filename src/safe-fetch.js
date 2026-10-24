// 只读 HTTP(S) 安全抓取工具：供 qq-bridge / MCP 共用。
// 设计目标与 mcp-web-search-safe 一致：
// - 仅 http/https
// - 禁止 localhost / .local / 私有 IP / 环回 / 链路本地 / CGNAT 等内网地址
// - 域名先 DNS 解析并检查全部解析结果，避免 DNS rebinding
// - 手动跟随重定向，每一跳重新校验
// - 响应体限量读取，每次请求有包含响应体的总时限
import dns from 'node:dns';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { StringDecoder } from 'node:string_decoder';

const dnsLookup = dns.promises.lookup;

// 代理 fake-IP 兼容开关（默认关闭，保持上游的严格判定）。
//
// 背景：Clash / Surge / sing-box 等工具的 TUN + fake-IP 模式会把**所有**域名的 DNS
// 结果换成一个保留段地址（典型是 198.18.0.0/15，本机实测 baidu 也解析到 198.18.0.14），
// 真实流量由 utun 设备接管。此时「域名解析到内网 ⇒ 拒绝」会把全部公网抓取误杀，
// 现象是图片/表情/web_fetch 全部报「域名解析到内网/本机地址，已阻止」。
//
// 放过时**只**放过 198.18.0.0/15 这一个 IETF 基准测试保留段；10/127/172.16/192.168/
// 169.254/CGNAT 等真正的内网段仍然照常拦截，IPv6 判定完全不变。
// 安全边界说明：fake-IP 环境里内网服务本来就不会解析到 198.18，因此放过该段不会
// 让攻击者借此访问内网；这是「代理环境可用性」与「SSRF 防护」之间的显式取舍。
//
// 默认策略（2026-10-24 改）：**自动识别**。以前只有手动设 QQ_BRIDGE_ALLOW_PROXY_FAKE_IP=1
// 才放行，普通用户不知道要设，结果"看得到消息、看不到图"（图片/表情/web_fetch 全部报
// 「域名解析到内网/本机地址，已阻止」）。现在启动时探测几个固定公网域名：如果它们的
// DNS 结果全都落在 198.18.0.0/15，就判定本机处于 TUN fake-IP 代理环境并自动放行。
// 仍然可以手动覆盖：QQ_BRIDGE_ALLOW_PROXY_FAKE_IP=1 强制放行 / =0 强制严格。
// 关键限制：放行**只对域名生效**。URL 里直接写 IP 字面量（包括直接写 198.18.x.x）
// 一律仍按内网拦截 —— fake-IP 是 DNS 层现象，不该成为「用 IP 直连某段地址」的许可。
const PROXY_FAKE_IP_ENV = String(process.env.QQ_BRIDGE_ALLOW_PROXY_FAKE_IP ?? '').trim();
// 探测用固定公网域名（不依赖任何用户输入，避免被诱导去解析攻击者域名）。
const FAKE_IP_PROBE_HOSTS = ['www.baidu.com', 'www.qq.com', 'example.com'];
const FAKE_IP_CACHE_MS = 5 * 60_000;

/** 198.18.0.0/15 是 IETF 基准测试保留段，Clash/Surge/sing-box 的 fake-IP 常用它。 */
export function isProxyFakeIpv4(ip) {
  const parts = String(ip ?? '').split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n))) return false;
  return parts[0] === 198 && parts[1] >= 18 && parts[1] <= 19;
}

/**
 * 由探测结果判定是否为 fake-IP 环境（纯函数，便于回归测试）。
 * @param {Array<string[]|null>} probeAddresses 每个探测域名解析出的地址列表；失败给 null
 * @returns {boolean} 至少两个域名答出来、且这些域名的解析结果**全部**落在 198.18.0.0/15
 */
export function evaluateFakeIpProbe(probeAddresses = []) {
  let answered = 0;
  let hits = 0;
  for (const addresses of probeAddresses) {
    if (!Array.isArray(addresses) || addresses.length === 0) continue;
    answered += 1;
    if (addresses.every((address) => isProxyFakeIpv4(address))) hits += 1;
  }
  return answered >= 2 && hits >= 2;
}

let fakeIpCache = { at: 0, value: false };
let fakeIpInflight = null;

/** 仅供测试：清掉探测缓存，让下一次判定重新解析。 */
export function resetProxyFakeIpCache() {
  fakeIpCache = { at: 0, value: false };
  fakeIpInflight = null;
}

/**
 * 本机是否处于 TUN fake-IP 代理环境（DNS 把公网域名映射进保留段）。
 * 结果缓存 5 分钟：用户可能中途才开代理，不必重启桥接。
 */
export async function detectProxyFakeIpMode() {
  if (Date.now() - fakeIpCache.at < FAKE_IP_CACHE_MS) return fakeIpCache.value;
  if (fakeIpInflight) return fakeIpInflight;
  fakeIpInflight = (async () => {
    const probes = await Promise.all(FAKE_IP_PROBE_HOSTS.map(async (host) => {
      try {
        const list = await withTimeout(dnsLookup(host, { all: true, verbatim: true }), 2000, `DNS 探测 ${host}`);
        return (list ?? []).map((row) => row.address);
      } catch {
        return null; // 探测失败按"没答"处理，绝不影响正常抓取
      }
    }));
    const value = evaluateFakeIpProbe(probes);
    fakeIpCache = { at: Date.now(), value };
    return value;
  })().finally(() => { fakeIpInflight = null; });
  return fakeIpInflight;
}

/** 当前是否放行 198.18.0.0/15：env 显式设置优先，否则自动识别。 */
export async function proxyFakeIpAllowed() {
  if (PROXY_FAKE_IP_ENV === '1') return true;
  if (PROXY_FAKE_IP_ENV === '0') return false;
  return detectProxyFakeIpMode();
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`操作超时(${ms}ms)：${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function ipv4FromLast32(lower) {
  const parts = String(lower || '').split(':');
  if (parts.length < 2) return null;
  const last = parts[parts.length - 1];
  const secondLast = parts[parts.length - 2];
  if (/^\d+\.\d+\.\d+\.\d+$/.test(last)) return last;
  if (/^[0-9a-f]{1,4}$/.test(secondLast) && /^[0-9a-f]{1,4}$/.test(last)) {
    const num = (parseInt(secondLast, 16) << 16) + parseInt(last, 16);
    return `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
  }
  return null;
}

function parseEmbeddedIpv4(h) {
  const lower = String(h || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!lower.includes(':')) return null;
  const dotted = lower.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) return dotted[1];
  const m = lower.match(/^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (m) {
    const num = (parseInt(m[1], 16) << 16) + parseInt(m[2], 16);
    return `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
  }
  // 兼容 ::ffff:0:7f00:1、::ffff:0:c0a8:101、::c0a8:101 等非规范 IPv4-mapped/compatible 写法。
  if (lower.startsWith('::ffff:') || lower.startsWith('::')) {
    const embedded = ipv4FromLast32(lower);
    if (embedded) return embedded;
  }
  // NAT64 前缀（64:ff9b::/96 与 64:ff9b:1::/48）内嵌 IPv4，例如 64:ff9b::c0a8:101 -> 192.168.1.1
  if (lower.startsWith('64:ff9b')) {
    const embedded = ipv4FromLast32(lower);
    if (embedded) return embedded;
  }
  const nat64 = lower.match(/^64:ff9b:(?:::)?(?:([0-9a-f]{1,4}):([0-9a-f]{1,4})|(\d+\.\d+\.\d+\.\d+))$/i);
  if (nat64) {
    if (nat64[3]) return nat64[3];
    const num = (parseInt(nat64[1], 16) << 16) + parseInt(nat64[2], 16);
    return `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
  }
  return null;
}

/**
 * @param {string} ip
 * @param {{ allowProxyFakeIp?: boolean }} [options]
 *   显式指定是否放过 198.18.0.0/15（fake-IP 代理段）。默认只认 env 开关；
 *   异步调用方（resolveSafeHost）会传入自动识别结果。
 */
export function isPrivateIp(ip, options = {}) {
  const allowProxyFakeIp = options.allowProxyFakeIp === undefined
    ? PROXY_FAKE_IP_ENV === '1'
    : options.allowProxyFakeIp === true;
  let h = String(ip || '').toLowerCase().replace(/^\[|\]$/g, '');
  const family = net.isIP(h);
  // DNS 返回值也必须是有效 IP；不能把非法地址当成公网地址。
  if (!family || h.includes('%')) return true;
  if (family === 6) h = new URL(`http://[${h}]/`).hostname.slice(1, -1);

  if (net.isIP(h) === 4) {
    const parts = h.split('.').map(Number);
    if (parts[0] === 10) return true;
    if (parts[0] === 127) return true;
    if (parts[0] === 0) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
    if (parts[0] === 198 && parts[1] >= 18 && parts[1] <= 19 && !allowProxyFakeIp) return true;
    if (parts[0] === 192 && parts[1] === 0 && parts[2] === 0) return true;
    if (parts[0] >= 224) return true;
    return false;
  }

  if (net.isIP(h) === 6) {
    if (h === '::' || h === '::1') return true;
    if (h.startsWith('fc') || h.startsWith('fd')) return true;
    if (/^fe[89ab]/.test(h)) return true;
    if (h.startsWith('fec') || h.startsWith('fed') || h.startsWith('fee') || h.startsWith('fef')) return true;
    // 本地 NAT64 前缀的 IPv4 位布局不等同 /96；整个本地前缀均不可供公网抓取。
    if (h.startsWith('64:ff9b:1:')) return true;
    const embedded = parseEmbeddedIpv4(h);
    if (embedded) return isPrivateIp(embedded, { allowProxyFakeIp });
    if (h.startsWith('2001:db8')) return true;
    if (h.startsWith('2001:2:') || h.startsWith('2001:10:') || h.startsWith('2001:20:')) return true;
    const sixth4 = h.match(/^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4}):/i);
    if (sixth4) {
      const num = (parseInt(sixth4[1], 16) << 16) + parseInt(sixth4[2], 16);
      const ipv4 = `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
      if (isPrivateIp(ipv4, { allowProxyFakeIp })) return true;
    }
    if (h.startsWith('ff')) return true;
    return false;
  }

  return true;
}

export async function resolveSafeHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!h) throw new Error('主机名为空');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) {
    throw new Error('禁止访问内网/本机地址');
  }
  if (net.isIP(h)) {
    // IP 字面量永远按内网规则判定：fake-IP 放行只服务于"域名 → 保留段"这种 DNS 现象，
    // 不能让 URL 里直接写 198.18.x.x 也获得通行证。
    if (isPrivateIp(h, { allowProxyFakeIp: false })) throw new Error('禁止访问内网/本机地址');
    return h;
  }
  let addresses;
  try {
    addresses = await withTimeout(dnsLookup(h, { all: true, verbatim: true }), 5000, `DNS 解析 ${h}`);
  } catch (error) {
    throw new Error(`域名解析失败：${error?.message ?? error}`);
  }
  if (!addresses.length) throw new Error('域名没有解析结果');
  // 只有"主机名是域名"的路径才可能拿到 fake-IP 放行，并且要真的探测到本机是 fake-IP 环境。
  const allowProxyFakeIp = await proxyFakeIpAllowed();
  for (const { address } of addresses) {
    if (isPrivateIp(address, { allowProxyFakeIp })) {
      const hint = isProxyFakeIpv4(address) && !allowProxyFakeIp
        ? '（该地址属于 198.18.0.0/15：看起来本机在用 Clash/Surge 的 TUN fake-IP 代理。'
          + '可设 QQ_BRIDGE_ALLOW_PROXY_FAKE_IP=1 强制放行；自动识别失败时也会提示到这里）'
        : '';
      throw new Error(`域名解析到内网/本机地址，已阻止${hint}`);
    }
  }
  return addresses[0].address;
}

export async function validateFetchUrl(raw) {
  let url;
  try {
    url = new URL(String(raw ?? '').trim());
  } catch {
    throw new Error('URL 无效');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('仅允许 http/https');
  if (url.username || url.password) throw new Error('URL 不能包含凭据');
  const ip = await resolveSafeHost(url.hostname);
  return { url, ip };
}

const REQUEST_TIMEOUT_MS = 20000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function validateLimit(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} 必须为正整数`);
}

// 使用已校验的 IP 发起请求，保留原始 Host/SNI，禁止重新解析 DNS。
// 总时限包含 TCP/TLS、响应头和响应体；仅 socket idle timeout 无法阻止慢速滴流。
function requestOnce(url, ip, limit, binary = false) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let req;
    let response;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result);
    };
    const timer = setTimeout(() => {
      const error = new Error(`请求超时：${url.hostname}`);
      finish(error);
      req?.destroy(error);
      response?.destroy();
    }, REQUEST_TIMEOUT_MS);
    const mod = url.protocol === 'https:' ? https : http;
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    try {
      req = mod.request({
        hostname: ip,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: 'GET',
        headers: {
          host: url.host,
          'user-agent': 'Mozilla/5.0',
          accept: binary ? 'image/*,*/*;q=0.8' : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'accept-language': 'zh-CN,zh;q=0.9',
        },
        servername: url.protocol === 'https:' && !net.isIP(hostname) ? hostname : undefined,
        rejectUnauthorized: url.protocol === 'https:',
        timeout: REQUEST_TIMEOUT_MS,
      }, (res) => {
        response = res;
        res.on('error', (error) => finish(error));
        res.on('aborted', () => finish(new Error('响应体读取中断')));
        res.on('close', () => {
          if (!res.complete) finish(new Error('响应体读取中断'));
        });
        if (settled) { res.destroy(); return; }
        const statusCode = res.statusCode || 0;
        if (REDIRECT_STATUSES.has(statusCode)) {
          finish(null, { statusCode, redirect: String(res.headers.location || '') });
          // 不下载重定向正文：攻击者可以发送无限正文消耗连接和带宽。
          res.destroy();
          return;
        }
        const chunks = [];
        const decoder = binary ? null : new StringDecoder('utf8');
        let size = 0;
        const appendText = (text) => {
          const points = Array.from(text);
          const remaining = limit - size;
          chunks.push(points.slice(0, remaining).join(''));
          size += Math.min(points.length, remaining);
          if (size >= limit) {
            finish(null, { statusCode, body: chunks.join(''), truncated: true });
            res.destroy();
          }
        };
        res.on('data', (chunk) => {
          if (settled) return;
          if (!binary) { appendText(decoder.write(chunk)); return; }
          size += chunk.length;
          if (size > limit) {
            finish(new Error(`图片超过大小限制（${limit} 字节）`));
            res.destroy();
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          if (settled) return;
          if (binary) finish(null, { statusCode, buffer: Buffer.concat(chunks) });
          else {
            appendText(decoder.end());
            finish(null, { statusCode, body: chunks.join(''), truncated: false });
          }
        });
      });
      req.on('timeout', () => {
        const error = new Error(`请求超时：${url.hostname}`);
        finish(error);
        req.destroy(error);
        response?.destroy();
      });
      req.on('error', (error) => finish(error));
      req.end();
    } catch (error) {
      finish(error);
      req?.destroy();
    }
  });
}

export async function safeFetch(urlString, maxChars = 50000) {
  validateLimit(maxChars, 'maxChars');
  const MAX_REDIRECTS = 5;
  let { url, ip } = await validateFetchUrl(urlString);
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const result = await requestOnce(url, ip, maxChars);
    if ([301, 302, 303, 307, 308].includes(result.statusCode)) {
      if (!result.redirect) throw new Error(`重定向缺少 Location: ${result.statusCode}`);
      const next = new URL(result.redirect, url).toString();
      ({ url, ip } = await validateFetchUrl(next));
      continue;
    }
    const body = result.body || '';
    return {
      url: url.toString(),
      statusCode: result.statusCode,
      truncated: result.truncated,
      body,
    };
  }
  throw new Error('重定向次数过多，已停止');
}

/** 仅接受 DSH 支持的四种图片格式：PNG/JPEG/GIF/WebP。 */
export function looksLikeImageBuffer(buf) {
  if (!buf || buf.length < 12) return false;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true;
  if (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a') return true;
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return true;
  return false;
}

/** 抓取图片字节并返回 Buffer（带 SSRF 防护，且校验确实为图片）。 */
export async function safeFetchBuffer(urlString, maxBytes = 4 * 1024 * 1024) {
  validateLimit(maxBytes, 'maxBytes');
  const MAX_REDIRECTS = 5;
  let { url, ip } = await validateFetchUrl(urlString);
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const result = await requestOnce(url, ip, maxBytes, true);
    if ([301, 302, 303, 307, 308].includes(result.statusCode)) {
      if (!result.redirect) throw new Error(`重定向缺少 Location: ${result.statusCode}`);
      const next = new URL(result.redirect, url).toString();
      ({ url, ip } = await validateFetchUrl(next));
      continue;
    }
    if (result.statusCode < 200 || result.statusCode >= 300) {
      throw new Error(`图片抓取失败：HTTP ${result.statusCode}`);
    }
    if (!looksLikeImageBuffer(result.buffer)) {
      throw new Error(`抓取内容不是有效图片（PNG/JPEG/GIF/WebP）`);
    }
    return { url: url.toString(), statusCode: result.statusCode, buffer: result.buffer };
  }
  throw new Error('重定向次数过多，已停止');
}
