# Local Spanish Voice CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Manually start a local Spanish voice service and use stored bridge events to speak status and send a separately recorded, reviewed, explicitly confirmed reply to the verified OpenCode V2 session.

**Architecture:** A pinned localhost-only Speaches Docker setup stays separate from the Node CLI. Small CLI workflow modules handle event selection, local speech HTTP, terminal review, and authenticated OpenCode session delivery; SQLite continues storing only event metadata.

**Tech Stack:** Node >=22.12, TypeScript, Vitest, better-sqlite3, `@opencode/client` V2, Docker Desktop/WSL2 with NVIDIA GPU, Speaches CUDA.

**Spec:** `docs/superpowers/specs/2026-09-29-local-spanish-voice-cli-design.md`

## Global Constraints

- PC-only Spanish, manual service startup, supplied audio file; no relay, iPhone, microphone capture, Windows autostart, hosted voice provider, or unattended send.
- Service listens on `127.0.0.1` only; use the tested image digest `sha256:6ec12ebf890a17e0d4b242a8ba9e0eb1fb836e60e8a3c857aea9838d541579ac` and verify live model IDs before download.
- Never log credentials, audio bytes, or transcripts; store no new audio/transcript history in SQLite; never delete the supplied recording.
- Never issue a potentially billable OpenCode prompt during verification without separate user approval; mocked tests are fine.

## Review Focus

- An existing or non-WAV speech output path must fail without overwriting it; Task 3 tests both.
- A recording with misleading extension or excessive size must fail before inference; Task 4 tests invalid content/size.
- A stored event from a removed project or a session in a different location must fail closed; Tasks 2 and 5 test both.
- EOF, Ctrl+C, and an unexpected confirmation answer must send nothing; Task 6 tests all three.
- A transport timeout after confirmation has uncertain delivery and must not retry automatically; Task 5 tests this.

---

## File map

- `deploy/compose.voice.yaml`: immutable Speaches image, localhost port, GPU access, persistent named model cache.
- `scripts/voice.ps1`: explicit `start`, `stop`, `status`, and approved-model installation against the live registry; do not manage Docker inside Node.
- `src/store.ts`: exact event lookup; `src/event-selection.ts`: resolve event against current project config.
- `src/voice-client.ts`: fixed-loopback Speaches HTTP speech/transcription with bounded input and response handling.
- `src/speak.ts`: event-scoped Spanish status text and WAV output, exclusive file creation.
- `src/opencode-reply.ts`: discover authenticated V2 service, verify session location, submit one confirmed text.
- `src/reply.ts`: terminal transcript editing and explicit confirmation; `src/cli.ts`: parse/dispatch, human-readable IDs, dependency wiring.
- `tests/*.test.ts`, `README.md`: behavior tests and human setup/use guidance.

### Task 1: Manually managed local service

**Files:** Create `deploy/compose.voice.yaml`, `scripts/voice.ps1`, `tests/voice-setup.test.ts`; modify `README.md`.

**Interfaces:** Produces localhost Speaches on port 8000; installed model IDs `Systran/faster-whisper-small` and `speaches-ai/Kokoro-82M-v1.0-ONNX` with `ef_dora` (verify against the pinned image registry; if absent, stop and revise the design rather than substituting). Script verbs `start`, `stop`, `status`, `models`.

- [ ] **Step 1: Write failing tests** in `tests/voice-setup.test.ts` checking compose binds `127.0.0.1:8000:8000`, references the exact digest and a named cache volume, requests an NVIDIA GPU, and script has explicit verbs without autostart or unrelated model IDs.
- [ ] **Step 2: Run** `npm test -- --run tests/voice-setup.test.ts`; expect FAIL because files do not exist.
- [ ] **Step 3: Implement** the compose file and `scripts/voice.ps1` with `param([ValidateSet('start','stop','status','models')] [string]$Action)`; `models` queries the running image's registry, installs only the two verified IDs, and checks presence. Document first-run downloads, cache size/location, Docker PATH on this Windows install, and local start/stop in `README.md`. Avoid pulling moving upstream compose files.
- [ ] **Step 4: Run** `npm test -- --run tests/voice-setup.test.ts`; expect PASS. Without downloading, check the PowerShell script parses and `docker compose -f deploy/compose.voice.yaml config` resolves. If Docker/GPU is unavailable, report it rather than claiming a live pass.
- [ ] **Step 5: Commit** only Task 1 files as `feat: add manually started local voice service`.

### Task 2: Exact event selection and visible IDs

**Files:** Modify `src/store.ts`, `src/cli.ts`, `tests/store.test.ts`, `tests/cli.test.ts`; create `src/event-selection.ts`, `tests/event-selection.test.ts`.

**Interfaces:** `EventStore.get(id: string): CapturedEvent | undefined`; `selectEvent(store: Pick<EventStore, 'get'>, projects: readonly ProjectConfig[], id: string): { event: CapturedEvent; project: ProjectConfig }` throws for unknown ID or missing project. Compare stored project identity against configured ID and name; later session verification compares directory independently.

- [ ] **Step 1: Write failing tests** for exact get/missing/duplicate session IDs, removed or renamed project, and human-readable `events` containing `event-0` beside its session. Keep JSON output unchanged.
- [ ] **Step 2: Run** `npm test -- --run tests/store.test.ts tests/event-selection.test.ts tests/cli.test.ts`; expect FAIL for absent APIs/ID display.
- [ ] **Step 3: Implement** `get(id)` and `selectEvent(...)` with no schema changes; add ID column to non-JSON `events` rows. Do not select by session ID or newest event.
- [ ] **Step 4: Run** the same focused tests; expect PASS.
- [ ] **Step 5: Commit** Task 2 files as `feat: select stored events by exact id`.

### Task 3: Local speech and output file

**Files:** Create `src/voice-client.ts`, `src/speak.ts`, `tests/voice-client.test.ts`, `tests/speak.test.ts`; modify `src/cli.ts`, `tests/cli.test.ts`.

**Interfaces:** `VoiceClient` exposes `synthesize(text: string): Promise<Uint8Array>` and `transcribe(filePath: string): Promise<string>`; constructor accepts injected `fetch` for tests, fixed `http://127.0.0.1:8000`, model IDs from Task 1, `ef_dora`, `response_format: 'wav'`, and per-request timeouts. `speakEvent(event: CapturedEvent, outputPath: string, voice: Pick<VoiceClient, 'synthesize'>): Promise<void>` builds conservative Spanish status and writes output exclusively. CLI: `speak --config <path> --event-id <id> --output <wav>`.

- [ ] **Step 1: Write failing tests** for `/v1/audio/speech` request fields, readable Spanish status for each event kind, event ID/project selection, successful WAV file, existing path and non-`.wav` rejection, non-2xx/malformed/non-WAV response, and partial-file cleanup on write failure.
- [ ] **Step 2: Run** `npm test -- --run tests/voice-client.test.ts tests/speak.test.ts tests/cli.test.ts`; expect FAIL.
- [ ] **Step 3: Implement** synthesize and `speakEvent(...)`; validate WAV header and response byte limit before writing with exclusive creation. Wire `speak` into CLI with injectable voice dependency and close the store on every path.
- [ ] **Step 4: Run** the focused tests; expect PASS.
- [ ] **Step 5: Commit** Task 3 files as `feat: speak stored event status locally`.

### Task 4: File-based local transcription

**Files:** Modify `src/voice-client.ts`, `tests/voice-client.test.ts`; create `src/audio-input.ts`, `tests/audio-input.test.ts`.

**Interfaces:** `validateAudioInput(path: string): Promise<{ bytes: Uint8Array; filename: string; mimeType: string }>` accepts documented WAV and M4A under 25 MiB using file signature, not extension alone; `VoiceClient.transcribe(filePath)` sends multipart `file`, multilingual `model`, and `language: 'es'` to `/v1/audio/transcriptions`, returns trimmed nonempty text.

- [ ] **Step 1: Write failing tests** for real WAV/M4A signatures, nonexistent/mismatched/oversized/empty file, unsupported type, Spanish multipart fields, empty transcript, non-2xx and malformed JSON. Assert a failed validation never calls `fetch` and input file is preserved.
- [ ] **Step 2: Run** `npm test -- --run tests/audio-input.test.ts tests/voice-client.test.ts`; expect FAIL.
- [ ] **Step 3: Implement** `validateAudioInput(...)` and transcription using built-in Node `Blob`/`FormData`; cap input, response, and timeouts and avoid logging transcript or bytes. If the pinned server does not support M4A, reject with an explicit format diagnostic and update README/tests rather than silently converting or uploading elsewhere.
- [ ] **Step 4: Run** the focused tests; expect PASS.
- [ ] **Step 5: Commit** Task 4 files as `feat: transcribe supplied Spanish audio locally`.

### Task 5: Verified OpenCode V2 destination

**Files:** Create `src/opencode-reply.ts`, `tests/opencode-reply.test.ts`.

**Interfaces:** Export `VerifiedDestination = { project: ProjectConfig; sessionId: string }`; `OpenCodeReply` has `verify(project: ProjectConfig, sessionId: string): Promise<VerifiedDestination>` and `send(destination: VerifiedDestination, text: string): Promise<void>`. Default adapter uses `Service.discover()`, `OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) })`, V2 `session.get` and `session.prompt` methods, and `normalizeProjectDirectory(...)` for exact `session.location.directory` match.

- [ ] **Step 1: Write failing tests** using an injected V2 client for valid session/location, absent service, missing session, wrong ID, wrong directory, untrusted missing location, and a simulated send timeout that makes only one prompt call and surfaces uncertain delivery. Assert no prompt on verification failure.
- [ ] **Step 2: Run** `npm test -- --run tests/opencode-reply.test.ts`; expect FAIL.
- [ ] **Step 3: Implement** `verify` and `send`; inspect installed `@opencode/client` types for the actual method arguments. V2 `/api/session/{sessionID}/prompt` requires `{ text }`; re-check the session's directory immediately before sending to narrow time-of-check/time-of-use risk. If the API cannot verify session location or cannot safely send, stop and revise the design rather than guessing. Do not automatically start the service, redirect to a new session, or retry.
- [ ] **Step 4: Run** the focused tests and `npm run typecheck`; expect PASS.
- [ ] **Step 5: Commit** Task 5 files as `feat: verify destination before OpenCode reply`.

### Task 6: Interactive reply and documentation

**Files:** Create `src/reply.ts`, `tests/reply.test.ts`; modify `src/cli.ts`, `tests/cli.test.ts`, `README.md`.

**Interfaces:** `replyToEvent(event: CapturedEvent, project: ProjectConfig, audioPath: string, voice: Pick<VoiceClient, 'transcribe'>, opencode: Pick<OpenCodeReply, 'verify' | 'send'>, prompt: TerminalPrompt): Promise<'sent' | 'cancelled'>`; `TerminalPrompt` exposes `edit(initial: string): Promise<string | null>` and `confirm(destination: VerifiedDestination, text: string): Promise<boolean>` (null/false cancel). The real implementation uses line input from injectable terminal streams, displays project/session/event and the full final text before accepting literal `yes`; Ctrl+C/EOF cancel. CLI: `reply --config <path> --event-id <id> --audio <file>`; no `--yes`.

- [ ] **Step 1: Write failing tests** for transcript edit and confirmed send with final text, verified project/session displayed before confirmation, default reject, unexpected answer, EOF, Ctrl+C, empty text, transcription failure, unverified session, and failed send with uncertain-delivery message. Assert zero sends before explicit yes and correct store close on cancellation/error.
- [ ] **Step 2: Run** `npm test -- --run tests/reply.test.ts tests/cli.test.ts`; expect FAIL.
- [ ] **Step 3: Implement** the terminal workflow and CLI parsing/dispatch; distinguish cancellation from failure in exit codes, do not persist audio/text, never echo raw transport errors containing credentials. Document exact commands and billable-send warning in `README.md`.
- [ ] **Step 4: Run** `npm test -- --run`, `npm run typecheck`, `npm run build`, `git diff --check`; expect all PASS. Validate CLI shebang/usage and Docker localhost bind. Perform live STT/TTS/GPU measurements only with locally provided recording; do not trigger a billable prompt without separate approval; record any unverified live acceptance explicitly.
- [ ] **Step 5: Commit** Task 6 files as `feat: review and confirm event-scoped voice replies`.

## Final review

- [ ] Compare shipped CLI and Docker setup to the spec, including privacy, local-only network, explicit confirmation, no wrong-session fallback, no automatic retries, and honest GPU claims.
- [ ] Run a fresh full test/typecheck/build verification and document which live smoke tests were performed versus deferred pending user approval.
