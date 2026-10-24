// safe-fetch 的「TUN fake-IP 代理」兼容回归测试（纯逻辑，不需要联网/代理）。
//
// 事故（2026-10-24，用户现场「他看不到图」）：本机跑了 Clash/Surge 之类 TUN fake-IP 代理，
// 所有域名都解析到 198.18.0.0/15（实测 multimedia.nt.qq.com.cn→198.18.0.9、
// www.baidu.com→198.18.0.17）。safe-fetch 的 SSRF 防护把该保留段当内网 → 图片/表情/
// web_fetch **全部**被拦，桥接日志刷「get_image 解析失败: 域名解析到内网/本机地址，已阻止」，
// QQ 上表现为「消息能看到、图永远看不到」。
//
// 修法：自动识别 fake-IP 环境后只放行 198.18.0.0/15，且**只对域名生效**；
// IP 字面量与其它真内网段一律照旧拦截。本测试就是钉住这条安全边界。
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const m = await import(pathToFileURL(path.join(ROOT, 'src/safe-fetch.js')).href)
const { isPrivateIp, isProxyFakeIpv4, evaluateFakeIpProbe, resolveSafeHost, detectProxyFakeIpMode } = m

let failed = 0
const check = (label, cond, extra = '') => {
  console.log(`${cond ? '✅' : '❌'} ${label}${extra ? ` — ${extra}` : ''}`)
  if (!cond) failed += 1
}

// ── ① 识别 fake-IP 段的边界 ───────────────────────────────────────────────────
{
  check('198.18.0.1 属于 fake-IP 段', isProxyFakeIpv4('198.18.0.1') === true)
  check('198.19.255.254 属于 fake-IP 段（整个 /15）', isProxyFakeIpv4('198.19.255.254') === true)
  check('198.17.x 不属于', isProxyFakeIpv4('198.17.0.1') === false)
  check('198.20.x 不属于', isProxyFakeIpv4('198.20.0.1') === false)
  check('非法值不误判', isProxyFakeIpv4('198.18') === false && isProxyFakeIpv4('') === false)
}

// ── ② 探测判定：至少两个域名答出来、且全部落在保留段 ──────────────────────────
{
  check('两个域名都解析到 198.18/15 → 判定 fake-IP',
    evaluateFakeIpProbe([['198.18.0.9'], ['198.19.0.2']]) === true)
  check('正常公网 DNS → 不判定',
    evaluateFakeIpProbe([['110.242.68.66'], ['111.161.64.40']]) === false)
  check('只有 1 个域名答出来 → 不判定（避免误伤）',
    evaluateFakeIpProbe([['198.18.0.9'], null]) === false)
  check('一个正常一个 fake → 不判定（不是整体 fake-IP 环境）',
    evaluateFakeIpProbe([['198.18.0.9'], ['110.242.68.66']]) === false)
  check('域名解析出多个地址且混有公网 → 不判定',
    evaluateFakeIpProbe([['198.18.0.9', '110.242.68.66'], ['198.18.0.10']]) === false)
  check('空输入不炸', evaluateFakeIpProbe([]) === false && evaluateFakeIpProbe() === false)
}

// ── ③ 核心安全断言：放行 fake-IP 不等于放行内网 ───────────────────────────────
{
  const allow = { allowProxyFakeIp: true }
  check('未放行时 198.18.0.9 算内网', isPrivateIp('198.18.0.9') === true)
  check('放行时 198.18.0.9 不算内网（这是本次修复的目标）', isPrivateIp('198.18.0.9', allow) === false)

  const stillPrivate = ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.254', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0']
  for (const ip of stillPrivate) {
    check(`放行 fake-IP 后 ${ip} 仍判内网`, isPrivateIp(ip, allow) === true)
  }
  check('放行 fake-IP 后 ::1 仍判内网', isPrivateIp('::1', allow) === true)
  check('放行 fake-IP 后 fe80::1 仍判内网', isPrivateIp('fe80::1', allow) === true)
  check('IPv4-mapped 的内网地址仍判内网（::ffff:192.168.1.1）',
    isPrivateIp('::ffff:192.168.1.1', allow) === true)
}

// ── ④ IP 字面量永不放行（fake-IP 是 DNS 现象，不是"可以直连保留段"的许可） ─────
{
  let literalBlocked = false
  try {
    await resolveSafeHost('198.18.0.9')
  } catch (error) {
    literalBlocked = /内网|本机/.test(String(error?.message ?? error))
  }
  check('URL 里直接写 198.18.0.9 仍被拦截', literalBlocked)
  let localhostBlocked = false
  try {
    await resolveSafeHost('localhost')
  } catch (error) {
    localhostBlocked = /内网|本机/.test(String(error?.message ?? error))
  }
  check('localhost 仍被拦截', localhostBlocked)
}

// ── ⑤ 真机环境探测（只报告，不因环境不同而失败） ──────────────────────────────
{
  const mode = await detectProxyFakeIpMode()
  check('fake-IP 探测返回布尔值', typeof mode === 'boolean', `本机 = ${mode}`)
  let allowedPublic = false
  let dnsUnavailable = false
  try {
    const ip = await resolveSafeHost('www.baidu.com')
    allowedPublic = Boolean(ip)
  } catch (error) {
    dnsUnavailable = /域名解析失败/.test(String(error?.message ?? error))
  }
  if (dnsUnavailable) console.log('ℹ️ 本机 DNS 不可用，跳过公网域名解析断言（不算失败）')
  else check('公网域名在两种环境下都能通过（正常 DNS / fake-IP 自动放行）', allowedPublic)
}

console.log(failed === 0 ? '\n✅ safe-fetch fake-IP 兼容与安全边界测试通过' : `\n❌ ${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
