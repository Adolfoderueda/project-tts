# Local Bilingual Voice CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Speak selected OpenCode responses in Spanish and translate reviewed Spanish replies into the explicitly selected chat language before a single confirmed send.

**Architecture:** Opt-in config and explicit language resolution sit above stateless localhost Ollama translation. Separate literal protection, session-response reading, WAV output, and bilingual terminal workflow modules reuse existing event selection, Speaches, and verified OpenCode delivery. Legacy commands remain compatible; no transcript/history schema is added.

**Tech Stack:** Node >=22.12, TypeScript, Vitest, Zod, better-sqlite3, installed `@opencode/client` V2, native fetch, existing localhost Ollama 0.35.0/Gemma 4 E2B and Speaches.

**Spec:** `docs/superpowers/specs/2026-10-01-local-bilingual-voice-design.md`

## Global Constraints

- English/Spanish only; listening/dictation language is Spanish. Project `chatLanguage` is overridden only for the current command by `--chat-language en|es`; never guess or persist the override.
- Optional top-level `translation` enables bilingual behavior. Without it, existing config and `start`, `events`, `speak`, and `reply` behavior remain unchanged.
- Translation model is exactly `gemma4:e2b`; expected installed digest is configured explicitly. The tested digest is `7fbdbf8f5e45a75bb122155ed546e765b4d9c53a1285f62fd9f506baa1c5a47e`.
- Ollama endpoints are fixed to `http://127.0.0.1:11434/api/tags` and `/api/chat`; reject redirects. No cloud, pull, fallback model, service startup/restart/stop, forced unload, or other-project changes.
- Cross-language inference is stateless: `stream: false`, `think: false`, no tools, `num_ctx: 4096`, `num_predict: 1024`, `temperature: 0`, `keep_alive: '30s'`, 120-second timeout, 1 MiB response cap, exact one-field JSON schema `{ translation: string }`.
- Source and restored/final target text are bounded to 2,000 Unicode code points. Identity and entirely protected-code paths make no Ollama request. Never truncate/summarize to fit.
- Preserve delimited code/command/path bytes; no thinking/tool content is spoken. No audio/text/translation SQLite history or generic content logging. Interactive preview is allowed; confirmed final text is retained by OpenCode, not duplicated by the bridge.
- TTY review, literal `yes`, exact event/session/project binding, pre-send directory recheck, no transformation after confirmation, and no automatic inference/send retry remain mandatory.
- User-selected WAV only; exclusive creation and <=20 MiB RIFF/WAVE validation. Preserve input recordings and honestly document existing best-effort cleanup race/GPU attribution limits.
- No potentially billable live OpenCode prompt during verification without separate approval. Do not reuse deleted probe sessions. Approved spec and plan do not authorize a push/merge or other-project installation.

## Review Focus

- Supplementary Unicode characters must count as one code point: 2,000 emoji are within the text limit, 2,001 are not — Task 1.
- ANSI/carriage-return/bidirectional controls must not hide text at bilingual review: render them visibly without changing the bytes eventually sent — Tasks 1, 5, 6.
- A fenced code block containing a shorter backtick run, or an escaped backtick in prose, must not corrupt literal boundaries — Task 2.
- A stale model digest or an HTTP redirect to a remote host must fail before chat inference or cloud contact — Task 3.
- A session moved after response translation or a user-edited target exceeding the text limit must fail before synthesis/confirmation/send — Tasks 5, 6.

---

## File map and execution preflight

- Modify `src/config.ts`, `tests/config.test.ts`, `config.example.json`: optional bilingual config and supported language/model identity.
- Create `src/chat-language.ts`, `src/voice-text.ts` and matching tests: language precedence, code-point bounds, safe review rendering.
- Create `src/literal-protection.ts`, `src/translation-client.ts` and matching tests: exact code protection and bounded loopback translator.
- Create `src/opencode-session.ts`, `src/opencode-responses.ts` and matching tests; modify `src/opencode-reply.ts`: shared session assertion and read-only exact response access.
- Create `src/wav-output.ts`, `src/response-speech.ts`, `src/cli-responses.ts` and matching tests; modify `src/speak.ts`, `src/cli.ts`: shared WAV output and explicit response commands.
- Create `src/bilingual-reply.ts`, `tests/bilingual-reply.test.ts`; modify `src/reply.ts`, `src/cli.ts` and tests: both-version editing/confirmation while retaining legacy flow.
- Add `tests/bilingual-cli.integration.test.ts`; update `README.md`; record approved live evidence in `docs/validation/2026-10-01-local-bilingual-voice-cli.md`.

At execution time use an isolated feature worktree via using-git-worktrees; do not code on main. Preserve the current untracked handoff and ignored recording/brainstorming notes. Record baseline `npm test -- --run tests`, typecheck, and build. Supplying `tests` avoids discovering nested worktree test copies from the main checkout. If dependencies are missing, the prior Windows install used `npm ci --ignore-scripts` with the packaged SQLite prebuild; do not reinstall existing dependencies or provision a C++ toolchain without cause. Inspect current AGENTS.md and installed API types again before execution.

### Task 1: Opt-in configuration, language resolution, and text safeguards

**Files:** Modify `src/config.ts`, `config.example.json`, `tests/config.test.ts`; create `src/chat-language.ts`, `src/voice-text.ts`, `tests/chat-language.test.ts`, `tests/voice-text.test.ts`.

**Interfaces:** `config.ts` exports `ChatLanguage = 'en' | 'es'`, `TranslationConfig = { model: 'gemma4:e2b'; digest: string }`; add optional `ProjectConfig.chatLanguage` and `BridgeConfig.translation`. `resolveChatLanguage(project: ProjectConfig, override?: ChatLanguage): ChatLanguage` throws for no declared language. `voice-text.ts` exports `MAX_VOICE_TEXT_CODE_POINTS = 2000`, `assertVoiceText(text: string): void`, and `formatReviewText(text: string): string`.

- [ ] **Step 1: Write failing tests** for legacy config equality, optional fields, override precedence, missing/unsupported language, non-E2B/cloud model, and a digest that is not exactly 64 lowercase hex characters. Add these precise guard assertions:

```ts
expect(resolveChatLanguage({ ...project, chatLanguage: 'en' }, 'es')).toBe('es');
expect(() => assertVoiceText('😀'.repeat(2000))).not.toThrow();
expect(() => assertVoiceText('😀'.repeat(2001))).toThrow();
expect(formatReviewText('a\x1b[2J\r\u202eb')).toBe('a\\u001b[2J\\u000d\\u202eb');
```

Define `project` locally with an absolute directory. Also assert whitespace-only input throws and ordinary Spanish text/newlines are preserved by review rendering.
- [ ] **Step 2: Run** `npm test -- --run tests/config.test.ts tests/chat-language.test.ts tests/voice-text.test.ts`; expect FAIL for missing exports/new schema behavior.
- [ ] **Step 3: Implement** the interfaces. Render C0 controls except LF, DEL/C1, and bidi controls U+202A–U+202E/U+2066–U+2069 as lowercase `\uXXXX` escapes, leaving original data unchanged. Config defaults must not silently enable translation. Update the example with the tested model/digest and `chatLanguage: 'en'`; explain its opt-in meaning later in README.
- [ ] **Step 4: Run** the focused tests and `npm run typecheck`; expect PASS, including existing config tests.
- [ ] **Step 5: Commit** only Task 1 files as `feat: configure opt-in bilingual voice languages`.

### Task 2: Exact delimited-literal protection

**Files:** Create `src/literal-protection.ts`, `tests/literal-protection.test.ts`.

**Interfaces:** Export `ProtectedLiterals = { maskedText: string; hasProse: boolean; literals: readonly { placeholder: string; value: string }[] }`, `protectLiterals(text: string, createNonce?: () => string): ProtectedLiterals`, and `restoreLiterals(translated: string, protectedText: ProtectedLiterals): string`. Default nonce comes from `node:crypto` `randomUUID()`.

- [ ] **Step 1: Write failing tests** asserting exact restoration of `` `npm test` ``, `` `src/cli.ts` ``, `` `VOICE_MODEL` ``, and a backtick Windows path; code-only `hasProse === false`; and missing/duplicate/unknown/current-namespace-reordered placeholders throw. Assert `restoreLiterals(protectedText.maskedText, protectedText) === original` for CRLF fenced text containing shorter interior backticks and for double-backtick inline code. Inject a nonce sequence to prove collision avoidance when the first proposed placeholder namespace already appears in source. Test escaped prose backticks and unmatched inline/fence rejection.

```ts
test('literal_round_trip_preserves_command_bytes', () => {
  const original = 'No ejecutes `npm test` todavía.';
  const protectedText = protectLiterals(original);
  expect(restoreLiterals(protectedText.maskedText, protectedText)).toBe(original);
  expect(() => restoreLiterals('No ejecutes nada.', protectedText)).toThrow();
});
```
- [ ] **Step 2: Run** `npm test -- --run tests/literal-protection.test.ts`; expect FAIL for absent module.
- [ ] **Step 3: Implement** ordered scanning, not global replacement. Recognize inline delimiters as equal-length backtick runs; ignore escaped prose delimiters. Recognize backtick fences of length >=3 after at most three leading spaces, closing only on a line containing an equal/longer run plus whitespace. Preserve entire literal slices including delimiters, language labels, and line endings. Use a unique `__PVB_<nonce>_<index>__` namespace absent from source. Restore only after checking exact occurrence counts/order and rejecting unknown markers in that namespace. No parser dependency or content execution.
- [ ] **Step 4: Run** focused tests and typecheck; expect PASS with byte-exact literal round trips.
- [ ] **Step 5: Commit** Task 2 files as `feat: protect translation code and command literals`.

### Task 3: Bounded stateless local Ollama translator

**Files:** Create `src/translation-client.ts`, `tests/translation-client.test.ts`.

**Interfaces:** Export `Translator = { translate(text: string, source: ChatLanguage, target: ChatLanguage): Promise<string> }`, `TranslationError extends Error` with static content-free diagnostics, and `OllamaTranslator implements Translator`, constructor `(config: TranslationConfig, fetchClient?: typeof fetch)`. Consume Task 1 guards/types and Task 2 protection. No lifecycle/download API is exposed.

- [ ] **Step 1: Write failing tests** with injected fetch: identity returns exact unchanged text with zero requests; entirely protected input also skips HTTP; en/es directions carry explicit language labels; expected tags name/digest precede exactly one chat call; malformed/changed digest causes zero chat calls; every request has `redirect: 'error'` and loopback URL. Assert the global constraint values in the serialized request, a one-field schema, no history/tools, and protected rather than raw code in the submitted source. Assert valid JSON restores exact literals, retains `ñ`, and enforces the restored 2,000-code-point bound.

Test non-2xx, unavailable/timeout, metadata/chat responses exceeding 1 MiB even without Content-Length, invalid JSON/envelope, wrong returned model, `done: false`, length/non-stop finishes, empty/extra translation fields, returned tool calls, missing placeholders, and artifact text. A bare `<|channel>`/`<channel|>`/`<|think|>` in the translated masked prose must fail; delimiters inside preserved original code remain untouched. Thinking fields are never returned to callers. Assert error messages contain neither synthetic `PRIVATE_TEXT` nor raw response bodies, and no inference retries occur.

```ts
test('spanish_identity_preserves_text_without_http', async () => {
  const fetchClient = vi.fn<typeof fetch>();
  const translator = new OllamaTranslator({ model: 'gemma4:e2b', digest: 'a'.repeat(64) }, fetchClient);
  expect(await translator.translate('mañana', 'es', 'es')).toBe('mañana');
  expect(fetchClient).not.toHaveBeenCalled();
});
```
- [ ] **Step 2: Run** `npm test -- --run tests/translation-client.test.ts`; expect FAIL for absent translator.
- [ ] **Step 3: Implement** text validation -> identity bypass -> literal masking/code-only bypass -> bounded `/api/tags` check -> single `/api/chat` -> strict envelope/JSON/placeholder validation -> restored-text validation. Use `AbortSignal.timeout(120_000)` and a streaming reader capped at `1024 * 1024` bytes for metadata and inference responses, cancelling on overflow. Quote source as JSON data with an explicit translate-only system instruction. Ignore separate thinking content, reject tools and visible model-control artifacts, and expose only the translation string. Do not catch failures by retrying, pulling, unloading, or selecting another model.
- [ ] **Step 4: Run** focused tests and typecheck; expect PASS and exact HTTP call counts.
- [ ] **Step 5: Commit** Task 3 files as `feat: translate voice text through local Ollama`.

### Task 4: Verified read-only assistant response access

**Files:** Create `src/opencode-session.ts`, `src/opencode-responses.ts`, `tests/opencode-session.test.ts`, `tests/opencode-responses.test.ts`; modify `src/opencode-reply.ts`; retain/run existing reply/default-adapter tests.

**Interfaces:** Export `assertSessionLocation(session: unknown, project: ProjectConfig, sessionId: string): void` from the shared session module, preserving existing rejection messages. `opencode-responses.ts` exports `ResponseSummary = { id: string; completedAt: number }`, `CompletedResponse = ResponseSummary & { sessionId: string; text: string }`, `ResponseClient` with `session.get`, `session.message.get`, and `message.list`, and `createResponseClient(): Promise<ResponseClient>`. Request options are `{ signal: AbortSignal }`; input shapes are `{ sessionID: string }`, `{ sessionID: string; messageID: string }`, and `{ sessionID: string; limit: number; order: 'desc'; type: 'assistant' }` respectively, returning `Promise<unknown>`. Export `OpenCodeResponses` with constructor `({createClient?: () => Promise<ResponseClient>} = {})`, `verify(project: ProjectConfig, sessionId: string): Promise<void>`, `list(project: ProjectConfig, sessionId: string, limit?: number): Promise<ResponseSummary[]>` (default 20), and `get(project: ProjectConfig, sessionId: string, messageId: string): Promise<CompletedResponse>`.

- [ ] **Step 1: Write failing tests** for exact ID/absolute normalized directory checking; preserve all existing `OpenCodeReply` send-count/recheck tests. Assert response reads use correct scoped API inputs, authenticated discover/headers wiring, and 30-second request signals without starting the service. List bounds are 1..20; exactly one recent descending assistant page is read and cursor.next is not followed. Listing contains only IDs/numeric completion timestamps, never content. Test no eligible messages, malformed page envelope, absent service, deleted/wrong/moved session, wrong returned message ID, user/incomplete/error/length-finished messages, invalid timestamps, >2,000-code-point text, and exclusion of reasoning/tools while joining visible text in order. Include a client prompt spy and assert zero calls.

```ts
test('shared_assertion_rejects_wrong_session_id', () => {
  const project = { id: 'demo', name: 'Demo', directory: 'C:\\demo' };
  expect(() => assertSessionLocation({ id: 'ses-other', location: { directory: project.directory } }, project, 'ses-one')).toThrow();
});
```
- [ ] **Step 2: Run** `npm test -- --run tests/opencode-session.test.ts tests/opencode-responses.test.ts tests/opencode-reply.test.ts tests/opencode-reply-default.test.ts`; expect FAIL only for new missing APIs, not legacy behavior.
- [ ] **Step 3: Implement** the shared assertion by moving the current private location-check logic without changing send behavior. Default response factory uses `Service.discover()`, `Service.headers(endpoint)`, and `OpenCode.make`; it never ensures/starts a service. Every read verifies location first. List filters eligible records and returns metadata; get rejects instead of selecting another response. Require finite completion timestamps, `type: 'assistant'`, `finish: 'stop'`, no error, and nonempty bounded visible text. Inspect installed client types to confirm the specified method inputs; do not guess a V1 endpoint.
- [ ] **Step 4: Run** focused tests and typecheck; expect PASS, with legacy authenticated-send tests unchanged.
- [ ] **Step 5: Commit** Task 4 files as `feat: read exact responses from verified OpenCode sessions`.

### Task 5: Explicit Spanish response-speech CLI

**Files:** Create `src/wav-output.ts`, `src/response-speech.ts`, `src/cli-responses.ts`, `tests/wav-output.test.ts`, `tests/response-speech.test.ts`, `tests/cli-responses.test.ts`; modify `src/speak.ts`, `src/cli.ts`, `tests/speak.test.ts`, `tests/cli.test.ts`.

**Interfaces:** `wav-output.ts` exports `assertNewWavPath(path: string): Promise<void>` and `writeNewWav(path: string, bytes: Uint8Array): Promise<void>` (exclusive writer). `ResponseSpeechInput = { event: CapturedEvent; project: ProjectConfig; messageId: string; outputPath: string; chatLanguage: ChatLanguage }`; `ResponsePreview = { project: ProjectConfig; sessionId: string; messageId: string; sourceLanguage: ChatLanguage; originalText: string; spanishText: string }`. `speakResponse(input: ResponseSpeechInput, responses: Pick<OpenCodeResponses,'get'|'verify'>, translator: Translator, voice: Pick<VoiceClient,'synthesize'>, preview: (value: ResponsePreview) => void): Promise<void>` consumes Tasks 1/3/4. Add optional `CliDependencies.createTranslator?(config: TranslationConfig): Translator` and `createResponses?(): Pick<OpenCodeResponses,'list'|'get'|'verify'>`, keeping old injected dependency objects valid. `cli-responses.ts` exports `runResponses(args: string[], io: CliIo, deps: CliDependencies): Promise<number>` and `runSpeakResponse(args: string[], io: CliIo, deps: CliDependencies): Promise<number>`; import CLI types with `import type` to avoid runtime cycles.

- [ ] **Step 1: Write failing tests** for response get -> en-to-es translation -> preview -> directory recheck -> synthesis -> WAV write ordering; Spanish bypass; original/Spanish/message/project labels; and unchanged control-bearing data passed to TTS while preview renders controls visibly. Wrong/moved directory after translation causes zero synthesis/output. Existing path/directory/non-WAV output is rejected before response inference; use `lstat` so a dangling symlink also counts as existing (mock that filesystem condition if Windows cannot create one). Invalid/oversized WAV and partial-write failure preserve exclusive creation and best-effort cleanup. Run existing `speak` tests to pin its Spanish status text.

For CLI tests, assert exact flag spellings from the spec, duplicate/missing/unknown flag rejection, `responses` bounds/default/metadata-only JSON/no-eligible message, unknown event/removed project rejection, no translation requirement for listing, required bilingual config/language for response speech, stdout TTY gate before content retrieval, exact selected response ID, no prompts, resource close on all paths, and content-free diagnostics even for errors containing `PRIVATE_TEXT`/credentials.

```ts
test('existing_wav_is_rejected_without_overwrite', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bilingual-wav-'));
  const output = join(directory, 'existing.wav');
  await writeFile(output, 'original');
  await expect(assertNewWavPath(output)).rejects.toThrow();
  expect(await readFile(output, 'utf8')).toBe('original');
});
```
- [ ] **Step 2: Run** `npm test -- --run tests/wav-output.test.ts tests/response-speech.test.ts tests/cli-responses.test.ts tests/speak.test.ts tests/cli.test.ts`; expect FAIL for new exports/commands.
- [ ] **Step 3: Implement** shared WAV helpers with <=20 MiB RIFF/WAVE validation and existing inode-comparison cleanup, without promising atomic replacement safety. Reuse helpers from event-status `speak` without changing wording. Implement the response workflow using exact scoped get and a fresh verify immediately before synthesize. Add dispatcher/usage entries and default factories; keep response argument parsing/handlers in `cli-responses.ts` rather than expanding the main CLI with two large handlers. Render previews with Task 1's display helper, leave data untouched, return 0 on successful list/synthesis, 2 on invalid usage, 1 on failure. No automatic playback or model prompt.
- [ ] **Step 4: Run** focused tests, typecheck, and build; expect PASS, including legacy CLI tests.
- [ ] **Step 5: Commit** Task 5 files as `feat: synthesize selected responses in Spanish`.

### Task 6: Bilingual edit/confirmation and exact single-send boundary

**Files:** Create `src/bilingual-reply.ts`, `tests/bilingual-reply.test.ts`; modify `src/reply.ts`, `src/cli.ts`, `tests/reply.test.ts`, `tests/cli.test.ts`.

**Interfaces:** Export `BilingualReview = { spanishText: string; targetText: string; chatLanguage: ChatLanguage }`, `BilingualTerminalPrompt = { edit(initial: string): Promise<string|null>; editTarget(review: BilingualReview): Promise<string|null>; confirmBilingual(destination: VerifiedDestination, review: BilingualReview): Promise<boolean> }`, and `replyBilingualToEvent(event: CapturedEvent, project: ProjectConfig, audioPath: string, chatLanguage: ChatLanguage, voice: Pick<VoiceClient,'transcribe'>, translator: Translator, opencode: Pick<OpenCodeReply,'verify'|'send'>, prompt: BilingualTerminalPrompt): Promise<'sent'|'cancelled'>`. Extend `LineTerminalPrompt` constructor to `(input: NodeJS.ReadableStream, output: NodeJS.WritableStream, event: CapturedEvent, options?: { bilingual?: boolean })` and add `editTarget`/`confirmBilingual` using its existing line reader and interruption/queued-input guards; do not replace the legacy `TerminalPrompt` interface or `replyToEvent` flow.

- [ ] **Step 1: Write failing tests** following current reply fixtures: verify before transcription; Spanish source edit precedes es-to-en translation; target edit is shown verbatim in both-version confirmation; send receives exactly the final target once. Spanish destination makes zero translator calls and still offers final review. Source/translated/final-target >2,000 code points throws before the next stage; whitespace/EOF/Ctrl+C cancels without send. A translator failure or digest error must not reach confirmation. Assert translator call count remains one after a target correction and after `yes` (no post-confirmation translation).

Exercise real interactive `LineTerminalPrompt` at each stage: pre-typed `yes` after source/target lines is discarded, unexpected answers reject, `yes` followed by EOF/Ctrl+C cannot send, non-TTY input cannot approve, both labeled versions/project/session/event are displayed, and ANSI/CR/bidi characters are visibly escaped without altering the confirmed data. Preserve existing terminal EOF regression tests. CLI tests assert opt-in branch selection, legacy no-translator behavior, override precedence/missing language before STT, clear exit codes, redaction, and store/prompt closure on cancellation/failure.

Use local project/event/destination fixtures matching `tests/reply.test.ts` and named `translate`, `send`, and `confirmBilingual` spies. In the target-correction test, source edit returns `texto revisado`, translation returns `reviewed text`, target edit returns `final correction`, and confirmation approves; pin the send boundary with:

```ts
expect(translate).toHaveBeenCalledExactlyOnceWith('texto revisado', 'es', 'en');
expect(confirmBilingual).toHaveBeenCalledWith(destination, { spanishText: 'texto revisado', targetText: 'final correction', chatLanguage: 'en' });
expect(send).toHaveBeenCalledExactlyOnceWith(destination, 'final correction');
```
- [ ] **Step 2: Run** `npm test -- --run tests/bilingual-reply.test.ts tests/reply.test.ts tests/cli.test.ts`; expect FAIL only for the new workflow/terminal methods/flags.
- [ ] **Step 3: Implement** the exact sequence from the spec using Task 1 validation after source editing, after translation, and after target editing. Handle null/whitespace edits as cancellation before the throwing bound guard. Use content-free labels/errors. Bilingual `edit` displays Spanish source safely; retain legacy rendering/behavior by adding an optional constructor mode `{ bilingual?: boolean }`, default false. `editTarget` clears queued input and displays both versions, preserving full multiline translated text on Enter while accepting one-line replacements. `confirmBilingual` clears queued input and displays both final versions/language/destination with safe review rendering. Share the existing literal-yes/EOF-race protection through a private answer-check helper used by both confirmation methods; do not call legacy raw-text rendering after a safe bilingual preview. In CLI resolve bilingual language before STT and call the new workflow only when `config.translation` exists; no transformations or prefixes after final approval. Keep the existing adapter's directory recheck and no-retry policy.
- [ ] **Step 4: Run** focused tests and typecheck; expect PASS, including unchanged legacy reply behavior and exact single-send assertions.
- [ ] **Step 5: Commit** Task 6 files as `feat: review bilingual replies before confirmed delivery`.

### Task 7: Whole-flow integration, setup guidance, and acceptance evidence

**Files:** Create `tests/bilingual-cli.integration.test.ts`; modify `README.md`; add `docs/validation/2026-10-01-local-bilingual-voice-cli.md` after permitted probes.

**Interfaces:** Consume production `main`, real `EventStore`, `OllamaTranslator`, `OpenCodeResponses`, `VoiceClient`/WAV helpers, and `LineTerminalPrompt`. Use injected fetch/client adapters and interactive stream fixtures; no new product API or test-only send bypass.

- [ ] **Step 1: Write integration tests** that seed distinct events for two projects and verify the en/es direction matrix across config and override. Instantiate the real translator with deterministic tags/chat fetch fixtures (return translated placeholders intact), real response reader with scoped client fixtures, and production CLI/terminal logic. Assert persisted metadata is unchanged, generated WAV uses the Spanish translation, protected commands survive to the exact confirmed send, cancel/failure branches send zero prompts, a moved session prevents inference/send, and diagnostics exclude private fixture text. Snapshot SQLite table names/counts before/after to prove no text/history schema or records are added; preserve original synthetic recording bytes. Use named `prompt` and `speechInputs` spies and `store`/`seededEvent` fixtures to pin the success case:

```ts
expect(prompt).toHaveBeenCalledExactlyOnceWith({ sessionID: seededEvent.sessionId, text: 'Do not delete `src/cli.ts`.' });
expect(speechInputs).toContain('No borres `src/cli.ts`.');
expect(store.get(seededEvent.id)).toEqual(seededEvent);
```

- [ ] **Step 2: Run** `npm test -- --run tests/bilingual-cli.integration.test.ts`; expect PASS if Tasks 1–6 fulfill their contracts. This is additional coverage, not a new product feature; do not manufacture a red phase by disabling working code. If a real regression appears, stop and diagnose it, record its failing test, and fix only that demonstrated gap before continuing.
- [ ] **Step 3: Write** README and the performed/deferred acceptance record. README must include legacy versus opt-in config, explicit language override, list/exact-message speech commands, the two-stage reply edit/confirmation, runtime/model/digest setup without automated pulls, 14.5-second observed cold-start caveat, 2,000-code-point bounds, backticks for technical literals, manual playback, Unicode-safe ad-hoc PowerShell probes, no cloud fallback, shared-runtime residency limits, OpenCode retention, billable-send warning, and the known cleanup race. Do not change other project/service settings or add unrelated production behavior.
- [ ] **Step 4: Run** `npm test -- --run tests`, `npm run typecheck`, `npm run build`, and `git diff --check`; expect all PASS. Verify CLI shebang/usage. With separately approved local synthetic probes, test both directions at short and near-limit lengths, protected literals, actual speech, and sequential/shared GPU residency; collect cold/warm latency and sampled versus model-attributed memory honestly. Inspect `/api/ps` before any probe and do not evict another project's loaded model. No private recording or billable OpenCode prompt is allowed without separate approval. Document performed versus deferred acceptance and revise design/limits if production settings fail rather than declaring a pass.
- [ ] **Step 5: Commit** only integration tests, README, and permitted acceptance evidence as `test: document and verify local bilingual voice workflows` (include a demonstrated scoped wiring fix only with its test).

## Final review and integration gate

- [ ] Perform a fresh whole-branch review against the approved spec: legacy compatibility, exact response/session IDs, explicit language precedence, loopback/model/digest checks, literal protection, privacy, controls visible at review, final-text immutability, and no automatic retry/cloud/lifecycle action.
- [ ] Run fresh tests/typecheck/build/diff checks on the final feature tree. Do not infer semantic translation quality or concurrent VRAM fit from mocked tests.
- [ ] Report any live acceptance gaps, retained test sessions/artifacts, and shared-runtime constraints. Present integration choices promptly; do not merge/push or accumulate unrelated features without the user's choice.
