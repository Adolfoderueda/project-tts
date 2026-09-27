# OpenCode Bridge and Event Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local TypeScript bridge that observes configured OpenCode session events and persists normalized events for later notification delivery.

**Architecture:** A Node.js 22 process uses the official OpenCode TypeScript SDK to subscribe to one event stream per configured project endpoint. It normalizes supported lifecycle events into a project-scoped SQLite inbox and reconnects with bounded exponential backoff. The CLI can inspect the inbox; relay delivery, voice processing, and the iPhone app are intentionally separate follow-on plans.

**Tech Stack:** Node.js 22, TypeScript, `@opencode-ai/sdk`, `better-sqlite3`, Zod, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-27-local-voice-opencode-agent-design.md`

## Global Constraints

- The first coding-agent integration is OpenCode.
- OpenCode runs on the user's local computer across multiple project folders.
- Initial event types: turn ended, waiting for user input, and session error.
- Completion is presented as “OpenCode turn finished” unless a future, separately designed feature establishes stronger completion semantics.
- The bridge exposes no project files to the relay; this subsystem does not implement a relay.
- No hosted speech-processing provider is introduced by this subsystem.
- A relay, voice processing, push delivery, and iPhone UI are out of scope for this plan.

## Review Focus

- Unknown or malformed SDK events must be ignored or recorded as unsupported without crashing the event stream; test this in Task 2.
- Two project endpoints that report the same session ID must remain isolated by project; test this in Task 3.
- A transient SSE disconnect must reconnect with bounded backoff and keep the process alive; test this in Task 4.
- A process restart must preserve captured event records, and retrying a store insert with the same event ID must not duplicate it; test this in Task 3.
- An unavailable endpoint or invalid project configuration must produce a clear diagnostic rather than an unhandled rejection; test this in Tasks 4 and 5.

---

## File Structure

- `package.json`, `tsconfig.json`, `vitest.config.ts`: Node/TypeScript scripts, compiler settings, and test configuration.
- `src/config.ts`: Zod-validated configuration for configured project IDs, labels, and OpenCode server base URLs.
- `src/events.ts`: normalized event types and mapping from OpenCode SDK events.
- `src/store.ts`: SQLite schema and durable event-inbox operations.
- `src/opencode-monitor.ts`: one SDK event-stream consumer per project endpoint, including reconnect/backoff and shutdown.
- `src/cli.ts`: start monitoring and inspect stored events.
- `tests/config.test.ts`, `tests/events.test.ts`, `tests/store.test.ts`, `tests/opencode-monitor.test.ts`, `tests/cli.test.ts`: unit and integration tests, using temporary SQLite files and fake SDK streams.

## Interfaces

- `ProjectConfig = { id: string; name: string; baseURL: string }`.
- `BridgeConfig = { databasePath: string; projects: ProjectConfig[] }`.
- `CapturedEvent = { id: string; projectId: string; projectName: string; sessionId: string; kind: 'turn-ended' | 'waiting-for-input' | 'error'; occurredAt: string; summary: string; rawEventType: string }`.
- `loadConfig(path: string): BridgeConfig` validates JSON configuration and throws a user-readable `ConfigError` on invalid input.
- `mapOpenCodeEvent(project: ProjectConfig, event: unknown, occurredAt: Date, sourceEventId?: string): CapturedEvent | null` returns a normalized event or `null` for irrelevant/unsupported events. `session.idle` maps to `turn-ended`, `permission.updated` maps to `waiting-for-input`, and `session.error` maps to `error` when a session ID is present. When the SDK provides an SSE event ID, use a stable project-namespaced ID; use a random UUID only when no source ID is available.
- `EventStore.insert(event: CapturedEvent): void` persists one received event; `EventStore.list(limit: number): CapturedEvent[]` returns newest first. Event IDs are created once during event normalization and remain unchanged in SQLite.
- `OpenCodeMonitor.run(signal: AbortSignal): Promise<void>` reads the configured SDK event stream, writes supported events to `EventStore`, reconnects with exponential backoff capped at 30 seconds, and exits cleanly when aborted.
- `createMonitorClient(project: ProjectConfig): Pick<OpencodeClient, 'event'>` is injected into the monitor so tests can provide fake async event streams. It uses `createOpencodeClient({ baseUrl })` and `client.event.subscribe({ signal, sseMaxRetryAttempts: 1 })`, whose result contains an async `stream`. The signal cancels the SSE request; limiting SDK attempts to `1` leaves reconnect timing to the monitor.

## Tasks

### Task 1: Bootstrap the TypeScript CLI and test harness

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `src/cli.ts`
- Create: `tests/cli.test.ts`

**Interfaces:**
- Produces: `npm test`, `npm run typecheck`, and `npm run dev -- <args>` scripts; `src/cli.ts` exports `main(argv: string[], io?: { stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream }): Promise<number>` and only invokes it when run as the entry point.

- [ ] **Step 1: Write the failing CLI smoke test**

Add `main_returns_usage_for_missing_command`, asserting that an empty argument list writes usage to `io.stderr` and returns exit code `2`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- --run tests/cli.test.ts`
Expected: FAIL because the CLI entry point and test setup do not exist.

- [ ] **Step 3: Add the minimal TypeScript/Vitest project setup and CLI entry point**

Use Node.js 22, strict TypeScript, Vitest, and `tsx` for local execution. Keep argument parsing dependency-free. Add package scripts named `test`, `typecheck`, and `dev`.

- [ ] **Step 4: Run the focused test and typecheck**

Run: `npm test -- --run tests/cli.test.ts`
Expected: PASS.

Run: `npm run typecheck`
Expected: exit code `0`.

### Task 2: Validate project configuration and normalize lifecycle events

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `src/config.ts`
- Create: `src/events.ts`
- Create: `tests/config.test.ts`
- Create: `tests/events.test.ts`

**Interfaces:**
- Consumes: Task 1 project/test setup.
- Produces: `ProjectConfig`, `BridgeConfig`, `loadConfig(path)`, `CapturedEvent`, and `mapOpenCodeEvent(project, event, occurredAt)` as defined above.

- [ ] **Step 1: Write failing config and event-mapping tests**

Add tests for a valid config with two project endpoints; reject missing IDs, duplicate project IDs, non-HTTP(S) URLs, and an empty project list. Add event tests mapping `session.idle`, `permission.updated`, and `session.error`; verify unrelated event types and `session.error` without a session ID return `null`. Verify source SSE IDs yield the same project-namespaced event ID across repeated normalization and different projects yield distinct IDs; verify missing source IDs receive a UUID.

- [ ] **Step 2: Run the focused tests to verify they fail**

Run: `npm test -- --run tests/config.test.ts tests/events.test.ts`
Expected: FAIL because the configuration and event modules do not exist.

- [ ] **Step 3: Add dependencies and implement Zod config parsing and typed lifecycle-event mapping**

Add `zod` and `@opencode-ai/sdk` as runtime dependencies and update the lockfile. Use SDK event type guards at the boundary, persist only the concise status summary and event type in the normalized event, and preserve a stable project-namespaced upstream SSE ID when available (UUID fallback only when absent). Do not infer project completion from `session.idle`.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `npm test -- --run tests/config.test.ts tests/events.test.ts`
Expected: PASS, including the unknown/malformed event cases.

Run: `npm run typecheck`
Expected: exit code `0`.

### Task 3: Persist events in a project-scoped SQLite inbox

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `src/store.ts`
- Create: `tests/store.test.ts`
- Modify: `src/events.ts`

**Interfaces:**
- Consumes: Task 2 `CapturedEvent`.
- Produces: `EventStore(databasePath)`, `insert(event)`, `list(limit)`, and `close()`.

- [ ] **Step 1: Write failing inbox persistence tests**

Add tests asserting that an event survives closing and reopening the store, `list(10)` returns newest first, duplicate IDs are not inserted twice, and identical session IDs from different project IDs remain separate records.

- [ ] **Step 2: Run the focused tests to verify they fail**

Run: `npm test -- --run tests/store.test.ts`
Expected: FAIL because `EventStore` does not exist.

- [ ] **Step 3: Add SQLite dependencies and implement the inbox**

Add `better-sqlite3` and its required TypeScript definitions as runtime/development dependencies, then update the lockfile. Create a table with `id` as the primary key and columns for `project_id`, `project_name`, `session_id`, `kind`, `occurred_at`, `summary`, and `raw_event_type`. Use parameterized statements and a temporary database file in tests.

- [ ] **Step 4: Run the focused tests and verify restart persistence**

Run: `npm test -- --run tests/store.test.ts`
Expected: PASS, including close/reopen persistence and project isolation.

Run: `npm run typecheck` and `npm audit`
Expected: exit code `0` and no vulnerable dependencies.

### Task 4: Subscribe to OpenCode events and reconnect safely

**Files:**
- Create: `src/opencode-monitor.ts`
- Create: `tests/opencode-monitor.test.ts`

**Interfaces:**
- Consumes: Task 2 `ProjectConfig`, `mapOpenCodeEvent`; Task 3 `EventStore`.
- Produces: `OpenCodeMonitor.run(signal)` and injectable `createMonitorClient(project)`.

- [ ] **Step 1: Write failing monitor tests using fake async streams**

Add tests asserting that supported events are persisted with the configured project identity and source SSE ID, replaying the same source ID after reconnect does not duplicate the inbox event, unsupported events do not reach the store, a rejected stream reconnects with delays of 1, 2, 4 seconds up to a 30-second cap, and aborting the signal ends the monitor without another reconnect. Assert an endpoint that remains unavailable does not reject the top-level monitor promise.

- [ ] **Step 2: Run the focused tests to verify they fail**

Run: `npm test -- --run tests/opencode-monitor.test.ts`
Expected: FAIL because `OpenCodeMonitor` does not exist.

- [ ] **Step 3: Implement SDK subscription and reconnect behavior**

Use the installed `@opencode-ai/sdk` API `createOpencodeClient({ baseUrl: project.baseURL })` and `client.event.subscribe({ signal, sseMaxRetryAttempts: 1, onSseEvent })`, then consume the returned `stream` as an async iterable. Correlate the SSE frame ID exposed to `onSseEvent` with its yielded data object and pass that stable ID to `mapOpenCodeEvent`; repeated source IDs must be deduplicated by the SQLite primary key. Create one monitor per configured endpoint. On stream failure or normal stream end, log a sanitized diagnostic when appropriate and reconnect using capped exponential backoff; do not emit an error event for a transport failure. Persistence failures are fatal to that monitor and must propagate rather than being treated as reconnectable transport failures. Pass the `AbortSignal` to the SDK so aborting cancels its SSE request, then stop cleanly.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `npm test -- --run tests/opencode-monitor.test.ts`
Expected: PASS, including reconnect and shutdown cases.

Run: `npm run typecheck`
Expected: exit code `0`.

### Task 5: Add start and inbox-inspection CLI commands

**Files:**
- Modify: `src/cli.ts`
- Modify: `package.json`
- Create: `tsconfig.build.json`
- Create: `tests/cli.test.ts` (extend)
- Create: `README.md`
- Create: `config.example.json`

**Interfaces:**
- Consumes: Task 2 `loadConfig`; Task 3 `EventStore`; Task 4 `OpenCodeMonitor`.
- Produces: `project-voice-bridge start --config <path>` and `project-voice-bridge events --config <path> [--limit <n>] [--json]` commands.
- Extends: `main(argv, io?, dependencies?)` to accept `CliDependencies = { createStore(path: string): EventStore; createMonitor(project: ProjectConfig, store: EventStore): Pick<OpenCodeMonitor, 'run'>; onSigint(handler: () => void): () => void }`, keeping defaults wired to the real store, monitor, and process.

- [ ] **Step 1: Write failing command tests**

Test that `events` prints records from a real temporary inbox, defaults to the newest 20, `--limit` accepts only positive integers and is applied, `start` starts monitors for every configured project, invoking the injected SIGINT handler aborts each monitor and closes the store, and invalid config prints a concise diagnostic with exit code `1`. Preserve Task 1's missing-command behavior.

- [ ] **Step 2: Run the focused CLI tests to verify they fail**

Run: `npm test -- --run tests/cli.test.ts`
Expected: FAIL because the commands are not implemented.

- [ ] **Step 3: Implement CLI commands and example config**

Keep output machine-readable for `events --json`; the default output should show timestamp, project, session, event kind, and summary. Set `package.json` bin `project-voice-bridge` to `dist/cli.js`; add a Node shebang to the CLI and a `build` script that emits `src/**/*.ts` to `dist/` via a focused `tsconfig.build.json`. Preserve the `dev` script for local source execution. Document `npm run build` followed by running the generated CLI, and that each configured `baseURL` must point to a reachable OpenCode server for that project.

- [ ] **Step 4: Run all tests and typecheck**

Run: `npm test -- --run`
Expected: PASS.

Run: `npm run typecheck`
Expected: exit code `0`.

Run: `npm run build`
Expected: exit code `0` and `dist/cli.js` is generated with a Node shebang.

- [ ] **Step 5: Perform a manual OpenCode smoke test**

Start an OpenCode server for a test project, configure its base URL, start the bridge, complete a turn, request a permission, and trigger a test session error if available. Verify `bridge events` shows the correct event categories and project/session IDs. Confirm Ctrl+C exits cleanly and a restart retains the inbox.

## Deferred subsystem plans

1. Local voice service: GTX 3060 STT/TTS model selection, local audio processing API, transcript confirmation, and GPU/latency tests.
2. Cloud relay: authenticated device pairing, event delivery, push notifications, temporary encrypted audio buffers, expiry, and retry/deduplication.
3. Native iPhone app and integration: notification registration, project/session UI, audio capture/playback, transcript confirmation, and end-to-end offline/reconnect tests.

Each follow-on plan must consume the event-store and monitor interfaces above or explicitly revise them before implementation.

## Git Note

The current workspace is not a Git repository. Do not initialize Git or create commits as part of this subsystem plan without the user's authorization. Once the user establishes a repository, implementers should make a focused commit after each independently verified task.
