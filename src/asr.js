// 本机 ASR 只管理音频转码与识别进程，不记录音频或转写正文。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULTS = Object.freeze({
  enabled: false,
  modelPath: 'state/models/ggml-small.bin',
  binPath: '',
  ffmpegPath: '',
  language: 'zh',
  maxSeconds: 60,
  timeoutMs: 10000,
  maxChars: 400,
  maxPerMinute: 6,
  eager: true
});
const TRANSCRIPT_PROMPT = '群友昵称：鲸鲸';
const CACHE_LIMIT = 500;
const RESULT_CACHE = new Map();
const RATE_TIMES = [];
let serialQueue = Promise.resolve();

function clampNumber(value, fallback, min, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.round(number))) : fallback;
}

function executablePath(value, fallbackName) {
  const name = String(value ?? '').trim() || fallbackName;
  const candidates = path.isAbsolute(name) || name.includes(path.sep)
    ? [path.resolve(name)]
    : String(process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, name));
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {}
  }
  return null;
}

function configInput(cfg) {
  if (cfg?.socialV2?.asr && typeof cfg.socialV2.asr === 'object') return cfg.socialV2.asr;
  if (cfg?.asr && typeof cfg.asr === 'object') return cfg.asr;
  return cfg && typeof cfg === 'object' ? cfg : {};
}

export function resolveAsrConfig(cfg = {}) {
  try {
    const input = configInput(cfg);
    const merged = { ...DEFAULTS, ...input };
    merged.enabled = merged.enabled === true;
    merged.eager = merged.eager !== false;
    merged.modelPath = String(merged.modelPath || DEFAULTS.modelPath);
    merged.language = /^[a-z]{2,3}(?:-[A-Za-z0-9]+)?$/.test(String(merged.language)) ? String(merged.language) : 'zh';
    merged.maxSeconds = clampNumber(merged.maxSeconds, DEFAULTS.maxSeconds, 1, 600);
    merged.timeoutMs = clampNumber(merged.timeoutMs, DEFAULTS.timeoutMs, 100, 300000);
    merged.maxChars = clampNumber(merged.maxChars, DEFAULTS.maxChars, 1, 10000);
    merged.maxPerMinute = clampNumber(merged.maxPerMinute, DEFAULTS.maxPerMinute, 1, 120);
    const model = path.isAbsolute(merged.modelPath) ? merged.modelPath : path.resolve(ROOT, merged.modelPath);
    const binPath = executablePath(merged.binPath, 'whisper-cli');
    const ffmpegPath = executablePath(merged.ffmpegPath, 'ffmpeg');
    const ffprobePath = executablePath('', 'ffprobe');
    if (!binPath) return { ...merged, ok: false, reason: '找不到可执行的 whisper-cli', model, ffprobePath };
    if (!ffmpegPath) return { ...merged, ok: false, reason: '找不到可执行的 ffmpeg', binPath, model, ffprobePath };
    try {
      if (!fs.statSync(model).isFile() || fs.statSync(model).size <= 0) {
        return { ...merged, ok: false, reason: 'ASR 模型文件为空或不是普通文件', binPath, ffmpegPath, model, ffprobePath };
      }
    } catch {
      return { ...merged, ok: false, reason: 'ASR 模型未安装', binPath, ffmpegPath, model, ffprobePath };
    }
    return { ...merged, ok: true, reason: '', binPath, ffmpegPath, ffprobePath, model };
  } catch (error) {
    return { ...DEFAULTS, ok: false, reason: `ASR 配置无效：${error?.message ?? error}` };
  }
}

function cacheGet(key) {
  const result = RESULT_CACHE.get(key);
  if (!result) return null;
  RESULT_CACHE.delete(key);
  RESULT_CACHE.set(key, result);
  return { ...result, cached: true };
}

function cacheSet(key, result) {
  RESULT_CACHE.delete(key);
  RESULT_CACHE.set(key, result);
  while (RESULT_CACHE.size > CACHE_LIMIT) RESULT_CACHE.delete(RESULT_CACHE.keys().next().value);
}

function cleanTranscript(output, maxChars) {
  const text = String(output ?? '')
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/\[(?:BLANK_AUDIO|blank_audio|SILENCE|silence)\]/gi, ' ')
    .replace(/<\|(?:endoftext|startoftranscript|nospeech|audio|text)[^|]*\|>/gi, ' ')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^\[(?:BLANK_AUDIO|blank_audio)\]$/i.test(line))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = Array.from(text);
  if (chars.length <= maxChars) return { text, clipped: false };
  return { text: `${chars.slice(0, Math.max(0, maxChars - 1)).join('')}…`, clipped: true };
}

function runChild(command, args, timeoutMs) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let killTimer = null;
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({ ...result, stdout, stderr, timedOut });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch {}
      killTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 250);
    }, timeoutMs);
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.once('error', (error) => finish({ code: null, error }));
    child.once('close', (code) => finish({ code, error: null }));
  });
}

async function transcribeNow(buffer, options, config, digest) {
  const startedAt = Date.now();
  const maxSeconds = config.maxSeconds;
  const timeoutMs = config.timeoutMs;
  const requestedTmpDir = options.tmpDir ?? config.tmpDir;
  const tmpRoot = requestedTmpDir ? path.resolve(String(requestedTmpDir)) : path.join(ROOT, 'state', 'tmp', 'asr');
  let workDir = '';
  try {
    fs.mkdirSync(tmpRoot, { recursive: true, mode: 0o700 });
    workDir = fs.mkdtempSync(path.join(tmpRoot, 'job-'));
    fs.chmodSync(workDir, 0o700);
    const suffix = String(options.format ?? 'audio').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12) || 'audio';
    const inputPath = path.join(workDir, `input.${suffix}`);
    const wavPath = path.join(workDir, 'converted.wav');
    fs.writeFileSync(inputPath, buffer, { mode: 0o600 });

    let sourceDuration = Number(options.duration) || 0;
    if (sourceDuration <= 0 && config.ffprobePath) {
      const probeTimeoutMs = Math.min(1000, timeoutMs - (Date.now() - startedAt));
      if (probeTimeoutMs > 0) {
        const probe = await runChild(config.ffprobePath, [
          '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', inputPath
        ], probeTimeoutMs);
        const probedDuration = Number(String(probe.stdout ?? '').trim());
        if (!probe.timedOut && probe.code === 0 && Number.isFinite(probedDuration) && probedDuration > 0) sourceDuration = probedDuration;
      }
    }

    const remainingBeforeFfmpeg = Math.max(1, timeoutMs - (Date.now() - startedAt));
    const converted = await runChild(config.ffmpegPath, [
      '-hide_banner', '-loglevel', 'error', '-y', '-i', inputPath,
      '-t', String(maxSeconds), '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wavPath
    ], remainingBeforeFfmpeg);
    if (converted.timedOut) return { ok: false, reason: '音频转码超时', ms: Date.now() - startedAt, model: config.modelPath };
    if (converted.error || converted.code !== 0) return { ok: false, reason: 'ffmpeg 无法读取该语音格式', ms: Date.now() - startedAt, model: config.modelPath };

    const remainingBeforeWhisper = timeoutMs - (Date.now() - startedAt);
    if (remainingBeforeWhisper <= 0) return { ok: false, reason: 'ASR 单条处理超时', ms: Date.now() - startedAt, model: config.modelPath };
    const recognized = await runChild(config.binPath, [
      '-m', config.model, '-l', config.language, '-nt', '-np', '--prompt', TRANSCRIPT_PROMPT, '-f', wavPath
    ], remainingBeforeWhisper);
    if (recognized.timedOut) return { ok: false, reason: 'whisper-cli 转写超时', ms: Date.now() - startedAt, model: config.modelPath };
    if (recognized.error || recognized.code !== 0) return { ok: false, reason: 'whisper-cli 转写失败', ms: Date.now() - startedAt, model: config.modelPath };
    const cleaned = cleanTranscript(recognized.stdout, config.maxChars);
    if (!cleaned.text) return { ok: false, reason: '未识别到语音内容', ms: Date.now() - startedAt, model: config.modelPath };
    const truncated = sourceDuration > maxSeconds;
    let text = cleaned.text;
    let clipped = cleaned.clipped;
    if (truncated && !text.endsWith('…')) {
      text = `${Array.from(text).slice(0, Math.max(0, config.maxChars - 1)).join('')}…`;
      clipped = true;
    }
    const result = {
      ok: true,
      text,
      ms: Date.now() - startedAt,
      model: config.modelPath,
      cached: false,
      truncated,
      clipped
    };
    cacheSet(digest, result);
    return result;
  } catch (error) {
    return { ok: false, reason: `ASR 本机处理失败：${error?.message ?? error}`, ms: Date.now() - startedAt, model: config.modelPath };
  } finally {
    if (workDir) {
      const names = fs.existsSync(workDir) ? fs.readdirSync(workDir).filter((item) => item.startsWith('input.')) : [];
      for (const name of new Set(['converted.wav', ...names])) {
        const target = path.join(workDir, name);
        try { fs.unlinkSync(target); } catch {}
      }
      try { fs.rmdirSync(workDir); } catch {}
    }
  }
}

export async function transcribeAudio(buffer, options = {}) {
  try {
    const rawConfig = options.config ?? {};
    if (configInput(rawConfig).enabled !== true) {
      return { ok: false, text: '', ms: 0, model: '', reason: 'ASR 未启用' };
    }
    const config = resolveAsrConfig(rawConfig);
    if (!config.ok) return { ok: false, text: '', ms: 0, model: config.modelPath, reason: config.reason };
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) return { ok: false, text: '', ms: 0, model: config.modelPath, reason: '音频数据为空' };
    const digest = crypto.createHash('sha1').update(buffer).digest('hex');
    const cached = cacheGet(digest);
    if (cached) return cached;

    const queuedAt = Date.now();
    const queueTimeoutMs = clampNumber(options.queueTimeoutMs ?? config.timeoutMs, config.timeoutMs, 100, 300000);
    let queueTimer;
    const queueExpired = new Promise((resolve) => {
      queueTimer = setTimeout(() => resolve({
        ok: false, text: '', ms: 0, model: config.modelPath, reason: 'ASR 排队超时'
      }), queueTimeoutMs);
    });
    const work = serialQueue.then(async () => {
      clearTimeout(queueTimer);
      if (Date.now() - queuedAt > queueTimeoutMs) {
        return { ok: false, text: '', ms: 0, model: config.modelPath, reason: 'ASR 排队超时' };
      }
      const afterQueue = cacheGet(digest);
      if (afterQueue) return afterQueue;
      const now = Date.now();
      while (RATE_TIMES.length && RATE_TIMES[0] <= now - 60000) RATE_TIMES.shift();
      if (RATE_TIMES.length >= config.maxPerMinute) {
        return { ok: false, text: '', ms: 0, model: config.modelPath, reason: 'ASR 每分钟调用次数已达上限' };
      }
      RATE_TIMES.push(now);
      return transcribeNow(buffer, options, config, digest);
    }).catch((error) => ({ ok: false, text: '', ms: 0, model: config.modelPath, reason: `ASR 队列失败：${error?.message ?? error}` }));
    serialQueue = work.then(() => undefined, () => undefined);
    return await Promise.race([work, queueExpired]);
  } catch (error) {
    return { ok: false, text: '', ms: 0, model: '', reason: `ASR 处理失败：${error?.message ?? error}` };
  }
}

export function asrModelStatus(cfg = {}) {
  const config = resolveAsrConfig(cfg);
  return {
    ok: config.ok,
    enabled: config.enabled,
    modelPath: config.modelPath,
    reason: config.reason || '',
    binPath: config.binPath || '',
    ffmpegPath: config.ffmpegPath || ''
  };
}
