# QQ Incoming Voice ASR Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add opt-in local ASR before QQ voice messages enter bridge context, with a lazy text-only recovery tool.

**Architecture:** A new ASR module owns local process execution, bounded LRU caching, rate limits, serialization, and cleanup. The bridge fetches OneBot records, applies transcripts before storage/wake evaluation, and exposes an authenticated lazy endpoint. Existing console, MCP, and preset patterns remain the integration points.

**Tech Stack:** Node.js 22 ESM, built-in `child_process`/`crypto`/`fs`, local `ffmpeg`, local `whisper-cli`, existing console and OneBot SDK.

**Spec:** `docs/superpowers/specs/2026-10-31-qq-incoming-asr-design.md`

## Global Constraints

- No DSH-core or unrelated voice-send/TTS, image, provider, model, or price changes.
- No cloud ASR and no new npm dependency.
- ASR defaults disabled; model path is configurable; transcript input is untrusted and capped at 400 characters.
- Process at most one transcription at a time; default per-item timeout is 10 seconds; kill timed-out children and remove temporary files.
- Never log transcript text or commit model/audio/state artifacts.
- All new code comments are Chinese and explain why.

## Review Focus

- Missing binary/model, malformed OneBot response, and timeout must preserve message ingestion; test each fallback.
- Concurrent identical buffers must not spawn duplicate ASR; test serialization and cache hit.
- Long audio must be capped by ffmpeg and output length capped; test a >60-second fixture.
- An authenticated endpoint must reject missing/invalid tokens, forbidden modes, and disabled tools; test its gates.
- Transcripts must be presented as untrusted content and never exceed the configured character cap; test prompt text.

---

### Task 1: Local ASR module and model setup

**Files:**
- Create: `src/asr.js`
- Create: `scripts/setup-asr.mjs`
- Create: `scripts/test-asr.mjs`
- Modify: `package.json`

**Interfaces:**
- `resolveAsrConfig(cfg) -> { ok, reason?, ...resolvedConfig }`
- `transcribeAudio(buffer, { format, config? }) -> { ok, text, ms, model, reason?, truncated? }`

- [x] Add tests for resolver defaults/missing tools, missing-model no-throw, real Chinese `say` sample, capped long audio, single-process queue, and duplicate-buffer cache; run to confirm expected failures.
- [x] Implement the ASR module with `ffmpeg -t`, `whisper-cli -m ... -l zh -nt -np`, a 500-entry SHA-1 LRU, six-per-minute limit, queue deadline, child kill, metadata-only result, and `finally` cleanup.
- [x] Implement idempotent model setup with `--model`, `--dir`, `--force`, size validation, SHA-256 output, and transcription self-check.
- [x] Add `setup:asr` and `test:asr` scripts; run `npm run test:asr` and install/self-check `small` into `state/models/`.

### Task 2: Bridge ingestion, lazy endpoint, and tests

**Files:**
- Modify: `src/bridge.js`
- Modify: `src/safe-fetch.js`
- Modify: `scripts/audit-bridge-harness.mjs`
- Modify: `scripts/test-asr.mjs`
- Modify: `scripts/test-safe-fetch-fakeip.mjs`

**Interfaces:**
- Extract record metadata `{ kind, file, url, duration }` while preserving synchronous `[语音]` rendering.
- Add a record fetch helper using `bot.getRecord({ file })` and compatible `data/base64/file/url` responses.
- Allow the existing safe URL fetcher to return non-image bytes only when the ASR caller explicitly opts out of image-signature validation; retain URL safety and byte limits.
- `GET /api/voice/message?key=...&messageId=...` returns text-only transcript data under existing image-route auth and mode gates.

- [x] Extend the harness tests first for eager-transcript insertion, disabled fallback, voice hints, and endpoint authorization; run to confirm failure.
- [x] Add deep-merged `socialV2.asr` defaults and `tools.getVoice=false`; transcribe before appending messages, keep record media out of image-only inlining, and use the same capped, untrusted annotation for prompts.
- [x] Add per-minute rate limiting and one warning on failure without blocking the message path; avoid transcript logging.
- [x] Add the authenticated lazy endpoint, cache-first lookup, and ASR model-status data used by the console.
- [x] Run the focused ASR harness checks and existing bridge contract checks.

### Task 3: Console configuration

**Files:**
- Modify: `public/console.html`
- Modify: `src/bridge.js`
- Modify: `config.example.json`
- Modify: `README.md`
- Modify: `docs/FOLDER_MAP.md`
- Modify: `docs/README.md`
- Modify: `scripts/test-console-ui.mjs`

- [x] Add a failing UI contract for the ASR enable switch and model status.
- [x] Display enabled state, model availability, and model path; save `asr.enabled` through `/api/socialV2/config`.
- [x] Deep-merge and normalize `asr` on save so partial updates preserve defaults and hot-update the running bridge.
- [ ] Run `npm run test:console-ui` (Playwright is unavailable locally; static checks and the offline browser fixture were used instead).

### Task 4: Lazy MCP tool and preset protocol

**Files:**
- Modify: `src/mcp-snowluma-safe.js`
- Modify: `dsh/agent-presets/qq-chat/agent.cordis.yml`
- Modify: `dsh/agent-presets/qq-chat-v2/agent.cordis.yml`
- Modify: `scripts/test-qq-preset-contract.mjs`

- [x] Add contract checks for the tool flag and exact protocol rule before implementation; confirm failure.
- [x] Register `qq_get_message_voice` only when `getVoice` is enabled and return concise transcript/error text.
- [x] Append rule 17 to the `qq-chat-v2` tool protocol and an unnumbered runtime voice rule to `qq-chat`; its numbered list is persona text, not a tool protocol, and the generated role card must remain unchanged.
- [x] Regenerate preset patches, run `--check`, and run `npm run test:token`.

### Task 5: Full requested verification and local checkpoints

**Files:**
- No additional product files.

- [ ] Run `npm run test:asr`, `npm run test:audit`, `npm run test:voice`, `npm run test:voice:system`, `npm run test:token`, `npm run test:console-ui`, `npm run test:mcp-servers`, `npm run privacy-scan`, and preset patch `--check`; report each real result.
- [ ] Inspect `git diff --stat` and `git status`; ensure no model, generated audio, config, or state artifact is tracked.
- [ ] Commit each verified task milestone on the current branch. Push only if the existing remote can accept the branch without publishing unrelated local history or rewriting history.
