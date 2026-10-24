#!/usr/bin/env node
// build-agent-preset-patches.mjs — 把 dsh/agent-presets/<preset>/ 的 preset 源文件
// 渲染成 DSH 0.1.7 的 bundle patch 文件（plugins/qq-agent-presets/presets/<preset>.patch.yml）。
//
// 背景（为什么需要「生成」这一步）：
//   0.1.5：preset = ~/.dsh/.agent-presets/<preset>/{preset.yml,agent.cordis.yml} 目录，DSH 扫目录。
//   0.1.7：注册表既不扫目录也不接受 preset 路径，preset 变成一条普通 loader 行
//          （@deepseek-ai/dsh-agent-preset），它的 config.plugins 必须是**内联的行列表**，
//          只能由 bundle 的 patch 文件插入。于是同一份行列表必然存在两种表示：
//            源（人写/控制台改）：dsh/agent-presets/<preset>/{preset.yml,agent.cordis.yml}
//            装（DSH 读）：      plugins/qq-agent-presets/presets/<preset>.patch.yml
//          本脚本是两者之间**唯一**的转换器：源是唯一权威，产物是纯生成物（文件头写明「请勿手工编辑」）。
//          setup-dsh.mjs 在安装时会重新生成；test-agent-preset-patches.mjs 用 --check 钉住不漂移。
//
// 用法：
//   node scripts/build-agent-preset-patches.mjs           # 生成/刷新 patch 文件
//   node scripts/build-agent-preset-patches.mjs --check    # 只校验产物与源一致（不一致 exit 1）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, '..');

/** 由桥接托管的两个 preset（顺序即 patch 层顺序）。 */
export const PRESETS = ['qq-chat', 'qq-chat-v2'];

/** preset 行 id：与 config.id（桥接解析的 preset 名）区分开，方便在 profile patch 里按行定位。 */
export function presetRowId(name) {
  return `preset-${name}`;
}

/**
 * 守卫行的引用方式：从 profile 目录可解析的裸说明符。
 *
 * 子行 name 按声明它的 loader 上下文解析（profile 目录），不是按 patch 文件或 preset 目录；
 * bundle patch 的「相对路径锚定」只作用于 insert 行自身（见 dsh-app-boot 的
 * anchorInsertedPluginNames），走不进 preset 行的 config.plugins。因此这里用
 * `<bundle 包名>/<子路径>`：profile package.json 以 link: 依赖声明该包，
 * node_modules junction 由 setup-dsh.mjs 或 dev_heal_links 维护。
 */
export const GUARD_SPECIFIER = 'qq-agent-presets/qq-tool-restrict.mjs';

/** 源里允许出现的相对行名 → 新机制下的等价引用。其它相对名一律报错（避免静默装不上）。 */
const RELATIVE_ROW_REWRITES = new Map([
  ['./qq-tool-restrict.mjs', GUARD_SPECIFIER],
]);

export const BUNDLE_DIR = path.join(REPO_ROOT, 'plugins', 'qq-agent-presets');

// ── 可移植性：源文件里不写死本机绝对路径 ────────────────────────────────────
//
// 为什么：preset 源（dsh/agent-presets/<preset>/agent.cordis.yml）会带 3 条 MCP 行，
// 每条都需要「node 可执行文件的绝对路径」和「本仓库里 MCP server 脚本的绝对路径」。
// 早期这两处直接写成了作者本机的路径（/Users/<名字>/...），于是：
//   ① 公开仓库会泄露作者用户名与本机目录结构（隐私）；
//   ② 别人 clone 下来跑 setup-dsh 时，生成的 preset 会指向**根本不存在的路径**，
//      MCP server 一个都起不来（可用性）。
// 现在源里只写占位符，渲染 patch 时再替换成本机真实路径：
//   __QQ_BRIDGE_NODE__ → process.execPath（当前跑 setup 的 Node）
//   __QQ_BRIDGE_ROOT__ → 本仓库根目录
export const PRESET_PLACEHOLDERS = Object.freeze({
  __QQ_BRIDGE_NODE__: () => process.execPath,
  __QQ_BRIDGE_ROOT__: () => REPO_ROOT,
});

/** 把一段文本里的占位符替换成本机真实值（用于最终写进 patch 的 YAML 字符串）。 */
export function resolvePresetPlaceholders(text, overrides = {}) {
  let out = String(text ?? '');
  for (const [token, factory] of Object.entries(PRESET_PLACEHOLDERS)) {
    const value = overrides[token] ?? factory();
    out = out.split(token).join(value);
  }
  return out;
}

/** 递归把结构里所有字符串的占位符替换（测试对比「源 vs 产物」时用）。 */
export function resolvePresetPlaceholdersDeep(value, overrides = {}) {
  if (typeof value === 'string') return resolvePresetPlaceholders(value, overrides);
  if (Array.isArray(value)) return value.map((item) => resolvePresetPlaceholdersDeep(item, overrides));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolvePresetPlaceholdersDeep(v, overrides)]));
  }
  return value;
}
export function patchFileFor(name) {
  return path.join(BUNDLE_DIR, 'presets', `${name}.patch.yml`);
}
function sourceDirFor(name) {
  return path.join(REPO_ROOT, 'dsh', 'agent-presets', name);
}

function readYaml(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    throw new Error(`读取失败 ${file}：${error?.message ?? error}`);
  }
  try {
    return yaml.load(text);
  } catch (error) {
    throw new Error(`${file} 不是合法 YAML：${error?.message ?? error}`);
  }
}

/**
 * 校验并改写行列表：只允许已知的相对行名（守卫），其余相对名视为错误。
 * @param {unknown} rows agent.cordis.yml 解析出的行列表
 * @param {string} preset preset 名（诊断用）
 * @returns {object[]} 可写进 patch 的行列表（深拷贝后的新对象）
 */
function normalizeRows(rows, preset) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error(`${preset}: agent.cordis.yml 必须是「非空的插件行列表」（顶层数组）`);
  }
  const seen = new Set();
  const walk = (list, at) => list.map((row, index) => {
    const label = `${preset}: ${at} 第 ${index + 1} 行`;
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error(`${label} 不是插件行（应为带 name 的映射）`);
    if (typeof row.name !== 'string' || row.name === '') throw new Error(`${label} 缺少 name`);
    if (typeof row.id !== 'string' || row.id === '') throw new Error(`${label} 缺少 id`);
    if (seen.has(row.id)) throw new Error(`${preset}: 行 id 重复：${row.id}`);
    seen.add(row.id);
    const next = { ...row };
    if (next.name.startsWith('.') || path.isAbsolute(next.name)) {
      const rewrite = RELATIVE_ROW_REWRITES.get(next.name);
      if (rewrite === undefined) {
        throw new Error(`${label}: 相对/绝对插件名 ${JSON.stringify(next.name)} 在 0.1.7 下会按 profile 目录解析，`
          + '必须改写为「bundle 包名/子路径」或去掉；请在 build-agent-preset-patches.mjs 里显式登记改写规则');
      }
      next.name = rewrite;
    }
    if (row.group === true) {
      if (!Array.isArray(row.config)) throw new Error(`${label} 是 group 行但 config 不是行列表`);
      next.config = walk(row.config, `${at}/${row.id}`);
    }
    return next;
  });
  const normalized = walk(rows, 'plugins');
  for (const required of ['persona', 'qq-tool-restrict']) {
    if (!seen.has(required)) throw new Error(`${preset}: 行列表缺少 ${required} 行（安全/人格边界不允许缺失）`);
  }
  return normalized;
}

/** 渲染一个 preset 的 patch 文件内容。 */
// 角色卡同步标记（见 scripts/sync-role-to-preset.mjs）：preset 源文件里用
// `<!-- ROLE-CARD:BEGIN/END -->` 圈出角色卡，方便脚本把 roles/<名字>.md 同步进去。
// 这些标记只是给同步脚本看的，**不能进**最终 prompt（它们会变成 system prompt 正文），
// 所以生成 patch 时统一剥掉。
const ROLE_CARD_MARKER_RE = /^[ \t]*<!--[ \t]*ROLE-CARD:(?:BEGIN|END)[^\n]*-->[ \t]*\n?/gm;

export function stripRoleCardMarkers(text) {
  if (typeof text !== 'string') return text;
  return text.replace(ROLE_CARD_MARKER_RE, '');
}

export function stripRoleCardMarkersDeep(value) {
  if (typeof value === 'string') return stripRoleCardMarkers(value);
  if (Array.isArray(value)) return value.map((item) => stripRoleCardMarkersDeep(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, stripRoleCardMarkersDeep(v)]));
  }
  return value;
}

export function renderPatch(name) {
  const dir = sourceDirFor(name);
  const meta = readYaml(path.join(dir, 'preset.yml'));
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) throw new Error(`${name}: preset.yml 必须是映射`);
  for (const field of ['name', 'description', 'order']) {
    if (meta[field] === undefined) throw new Error(`${name}: preset.yml 缺少 ${field}`);
  }
  // 去掉给同步脚本看的 <!-- ROLE-CARD:... --> 标记行（不能进 prompt）
  const plugins = stripRoleCardMarkersDeep(normalizeRows(readYaml(path.join(dir, 'agent.cordis.yml')), name));
  const row = {
    id: presetRowId(name),
    name: '@deepseek-ai/dsh-agent-preset',
    config: {
      id: name,
      name: meta.name,
      description: meta.description,
      order: meta.order,
      plugins,
    },
  };
  const header = [
    `# 本文件由 scripts/build-agent-preset-patches.mjs 生成，请勿手工编辑。`,
    `# 源：dsh/agent-presets/${name}/preset.yml + agent.cordis.yml（人格正文与工具面都在那里改）。`,
    `# 作用：把 ${name} 作为一条 @deepseek-ai/dsh-agent-preset 行插入 profile（DSH 0.1.7+ 的 preset 机制）。`,
    `# 守卫行 qq-tool-restrict 用裸说明符 ${GUARD_SPECIFIER}：子行 name 按 profile 目录解析，`,
    `# 该包以 link: 依赖注册在 profile package.json（node_modules junction 由 setup-dsh.mjs 维护）。`,
    '',
  ].join('\n');
  // lineWidth: -1 —— 长行不折行，产物与源逐字对应，diff 只反映真实改动。
  // 占位符在这里一次性替换成本机真实路径；patch 文件本身**不进版本控制**（见 .gitignore），
  // 每台机器 setup 时生成，因此不会泄露作者的路径、也不会在别人机器上指向错误位置。
  return resolvePresetPlaceholders(`${header}${yaml.dump([{ insert: [row] }], { lineWidth: -1, noRefs: true })}`);
}

/** 生成（或校验）全部 patch 文件。@returns {{file:string,changed:boolean}[]} */
export function buildPatches({ check = false, log = () => {} } = {}) {
  const results = [];
  for (const name of PRESETS) {
    const file = patchFileFor(name);
    const content = renderPatch(name);
    const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    const changed = current !== content;
    if (changed && !check) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content, 'utf8');
    }
    log(`${changed ? (check ? '✗ 需重新生成' : '✓ 已生成') : '· 已是最新'} ${path.relative(REPO_ROOT, file)}`);
    results.push({ file, changed });
  }
  return results;
}

// 直接执行时：默认生成，--check 只校验。
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check');
  const results = buildPatches({ check, log: (line) => console.log(`[preset-patches] ${line}`) });
  const stale = results.filter((r) => r.changed);
  if (check && stale.length > 0) {
    console.error(`[preset-patches] ERROR: ${stale.length} 个 patch 文件与源不一致；请运行 node scripts/build-agent-preset-patches.mjs`);
    process.exit(1);
  }
  console.log('[preset-patches] Done');
}
