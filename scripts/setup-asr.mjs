#!/usr/bin/env node
// 下载并自检本机 whisper.cpp ggml 模型；模型只写入 gitignore 覆盖的 state/models/。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { transcribeAudio } from '../src/asr.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODELS = {
  base: { min: 130_000_000, max: 180_000_000 },
  small: { min: 430_000_000, max: 510_000_000 },
  'large-v3-turbo': { min: 1_350_000_000, max: 1_750_000_000 }
};

function parseArgs(args) {
  const options = { model: 'small', dir: 'state/models', force: false };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--force') options.force = true;
    else if (arg === '--model' || arg === '--dir') {
      const value = args[++i];
      if (!value) throw new Error(`${arg} 后面需要一个值`);
      options[arg.slice(2)] = value;
    } else if (arg === '--help' || arg === '-h') {
      console.log('用法：node scripts/setup-asr.mjs [--model small|large-v3-turbo|base] [--dir 路径] [--force]');
      process.exit(0);
    } else {
      throw new Error(`不支持的参数：${arg}`);
    }
  }
  if (!Object.hasOwn(MODELS, options.model)) throw new Error(`不支持的模型：${options.model}`);
  return options;
}

function insideExpectedRange(size, model) {
  const range = MODELS[model];
  return size >= range.min && size <= range.max;
}

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function downloadModel(url, target) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || !response.body) throw new Error(`模型下载失败：HTTP ${response.status}`);
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(target, { mode: 0o600 }));
}

async function selfCheck(modelPath) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-asr-setup-'));
  const aiff = path.join(temp, 'self-check.aiff');
  const wav = path.join(temp, 'self-check.wav');
  try {
    const say = spawnSync('/usr/bin/say', ['-v', 'Eddy (中文（中国大陆）)', '-o', aiff, '你好，我是鲸鲸'], { encoding: 'utf8' });
    if (say.error || say.status !== 0) throw new Error(`say 自检音频生成失败：${say.stderr || say.error || say.status}`);
    const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
    const convert = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', aiff, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav], { encoding: 'utf8' });
    if (convert.error || convert.status !== 0) throw new Error(`ffmpeg 自检转码失败：${convert.stderr || convert.error || convert.status}`);
    const result = await transcribeAudio(fs.readFileSync(wav), {
      format: 'wav',
      config: { enabled: true, modelPath, binPath: process.env.WHISPER_CLI_PATH || '', ffmpegPath: process.env.FFMPEG_PATH || '' }
    });
    if (!result.ok) throw new Error(`whisper-cli 自检失败：${result.reason}`);
    console.log(`自检转写：${result.text}`);
    console.log(`实测耗时：${(result.ms / 1000).toFixed(2)} 秒`);
  } finally {
    for (const file of [aiff, wav]) {
      try { fs.unlinkSync(file); } catch {}
    }
    try { fs.rmdirSync(temp); } catch {}
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const dir = path.isAbsolute(options.dir) ? options.dir : path.resolve(ROOT, options.dir);
  const modelFile = `ggml-${options.model}.bin`;
  const target = path.join(dir, modelFile);
  const part = `${target}.download`;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  if (fs.existsSync(target) && !options.force) {
    const size = fs.statSync(target).size;
    if (!insideExpectedRange(size, options.model)) {
      throw new Error(`已有模型文件大小不在预期范围（${size} 字节）；确认后用 --force 重新下载`);
    }
    console.log(`模型已存在且大小正常，跳过下载：${target}`);
  } else {
    const url = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${modelFile}`;
    console.log(`正在下载 ${options.model} 模型到 ${target}`);
    try {
      await downloadModel(url, part);
      const size = fs.statSync(part).size;
      if (!insideExpectedRange(size, options.model)) {
        throw new Error(`下载文件大小不在预期范围（${size} 字节）`);
      }
      fs.renameSync(part, target);
      fs.chmodSync(target, 0o600);
    } finally {
      try { fs.unlinkSync(part); } catch {}
    }
  }

  const size = fs.statSync(target).size;
  console.log(`模型大小：${size} 字节`);
  console.log(`SHA-256：${await sha256(target)}`);
  const modelPath = path.relative(ROOT, target).split(path.sep).join('/');
  await selfCheck(modelPath);
  console.log('ASR 模型安装与自检完成');
}

main().catch((error) => {
  console.error(`ASR 模型安装失败：${error?.message ?? error}`);
  process.exitCode = 1;
});
