# OpenCode V2 Bridge Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the local bridge from OpenCode V1's `/event` API to the user's installed OpenCode V2 service while retaining project-scoped durable event capture.

**Architecture:** Replace the V1 SDK with the official `@opencode/client` V2 Promise client. Discover the already-running local service, open one global native event subscription, and route events to configured projects by normalized `location.directory`. Keep the SQLite inbox and user-facing event categories; reconnect on stream failure and clearly report that V2 does not replay missed events.

**Tech Stack:** Node.js `>=22.12.0`, TypeScript, `@opencode/client` 2.0.18+, `better-sqlite3`, Zod, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-28-opencode-v2-bridge-design.md` (supplements `docs/superpowers/specs/2026-09-27-local-voice-opencode-agent-design.md`).

## Global Constraints

- The first coding-agent integration is OpenCode.
- OpenCode runs on the user's local computer across multiple project folders.
- Initial event types: turn ended, waiting for user input, and session error.
- Completion is presented as “OpenCode turn finished” unless a future, separately designed feature establishes stronger completion semantics.
- The bridge exposes no project files to the relay; this subsystem does not implement a relay.
- No hosted speech-processing provider is introduced by this subsystem.
- A relay, voice processing, push delivery, and iPhone UI are out of scope for this plan.
- This migration targets OpenCode V2 only; do not add V1 compatibility adapters.
- Use the existing V2 background service and its official authentication helper; do not store service tokens in config and do not silently start a service.
- V2's global event stream is live-only. Reconnect and warn about possible missed events; do not add a durable plugin/outbox in this MVP migration.
- Persistence failures propagate; they are not treated as stream failures.
- Preserve the approved dependency-script policy: do not approve any new install script without explicit user authorization.

## Review Focus

- Windows path case and trailing separators must still match the exact configured project; cover with `normalizes_windows_project_directories_for_exact_matching` in Task 1.
- An event with absent, malformed, or unconfigured `location.directory` must not be attributed to an arbitrary project; cover with `ignores_events_without_a_configured_location` in Task 1.
- V2 permission variants and session errors may have different or missing `data.sessionID` fields; cover both permission names and session-less events in Task 1.
- Missing/malformed event IDs and repeated IDs must not create unstable or cross-project inbox identities; cover with `uses_project_scoped_v2_event_ids_and_ignores_missing_ids` in Task 1.
- An unavailable/unauthorized service or stream failure must neither leak auth details nor be reported as a session error; cover with `retries_when_v2_service_is_unavailable_without_leaking_diagnostics` and `reports_v2_stream_gaps_without_persisting_transport_errors` in Task 1.

---

## File Structure

- `src/project-paths.ts`: platform-aware normalization for configured and event-reported project directories.
- `src/config.ts`: V2 `ProjectConfig`/`BridgeConfig` validation; project entries contain an absolute `directory`, not a per-project `baseURL`.
- `src/events.ts`: safe V2 event parsing, directory routing, and normalization into the existing `CapturedEvent` shape.
- `src/opencode-monitor.ts`: V2 service discovery/client creation, one global stream, event persistence, abort, reconnect, and gap diagnostics.
- `src/cli.ts`: start exactly one monitor for the configured project set; keep `events` behavior unchanged.
- `package.json`, `package-lock.json`: replace `@opencode-ai/sdk` with `@opencode/client`.
- `config.example.json`, `README.md`: document absolute project directories and the requirement that an OpenCode V2 background service is running.
- `tests/config.test.ts`, `tests/events.test.ts`, `tests/opencode-monitor.test.ts`, `tests/cli.test.ts`: update/extend behavior coverage using V2-shaped event fixtures and injected service/client boundaries.

## Interfaces

- `ProjectConfig = { id: string; name: string; directory: string }`, where `directory` is absolute.
- `BridgeConfig = { databasePath: string; projects: ProjectConfig[] }`.
- `normalizeProjectDirectory(directory: string, platform?: NodeJS.Platform): string` returns a normalized absolute path, applying case folding on Windows only.
- `CapturedEvent` remains `{ id; projectId; projectName; sessionId; kind; occurredAt; summary; rawEventType }` with the existing field types.
- `mapOpenCodeEvent(projects: readonly ProjectConfig[], event: unknown, occurredAt: Date): CapturedEvent | null` routes using `event.location.directory`; it uses `JSON.stringify([project.id, event.id])` as the captured ID.
- `OpenCodeMonitor(projects: readonly ProjectConfig[], store: EventStore, options?)` owns one global stream and exposes `run(signal: AbortSignal): Promise<void>`.
- `MonitorClient = { event: { subscribe(options: { signal: AbortSignal }): AsyncIterable<unknown> } }` and `CreateMonitorClient = () => Promise<MonitorClient>`; the default factory uses `Service.discover()`, `Service.headers(endpoint)`, and `OpenCode.make({ baseUrl: endpoint.url, headers })`. A missing service is reported and retried; no service is started automatically.
- `CliDependencies.createMonitor(projects: readonly ProjectConfig[], store: EventStore): Pick<OpenCodeMonitor, 'run'>`; `start` constructs one monitor, not one monitor per project.

## Tasks

### Task 1: Replace the V1 boundary with the V2 global event stream

**Files:**
- Modify: `package.json`, `package-lock.json`
- Create: `src/project-paths.ts`
- Modify: `src/config.ts`, `src/events.ts`, `src/opencode-monitor.ts`, `src/cli.ts`
- Modify: `config.example.json`, `README.md`
- Modify: `tests/config.test.ts`, `tests/events.test.ts`, `tests/opencode-monitor.test.ts`, `tests/cli.test.ts`

**Interfaces:**
- Consumes: existing `EventStore`, `CapturedEvent`, and CLI `main(argv, io?, dependencies?)`.
- Produces: the V2 interfaces in the plan's **Interfaces** section. The SQLite schema and `events` command remain unchanged.

- [x] **Step 1: Write config and event-normalization tests first**

Update config fixtures to use two absolute `directory` values. Add named tests for duplicate normalized directories, relative paths, Windows case/trailing-separator matching, and duplicate project IDs. Add V2 event fixtures shaped `{ id, type, data, location }` and cover `session.idle`, `permission.asked`, `permission.v2.asked`, and `session.error`; assert exact category, summary, session, project, and stable namespaced ID. Assert unknown/malformed events, absent IDs, absent session IDs, and unconfigured/missing locations return `null`.

- [x] **Step 2: Run the focused tests and verify the expected RED**

Run: `npm test -- --run tests/config.test.ts tests/events.test.ts`
Expected: FAIL because the current config requires `baseURL` and the normalizer expects V1 `properties` instead of V2 `data`/`location`.

- [x] **Step 3: Implement project path normalization and V2 config/event mapping**

Add `normalizeProjectDirectory`; reject non-absolute and duplicate normalized directories. Replace `ProjectConfig.baseURL` with `directory`. Parse only the V2 event envelope fields needed by the bridge. Map `session.idle` → `turn-ended`, `permission.asked` and `permission.v2.asked` → `waiting-for-input`, and `session.error` → `error`, only when the V2 event has a configured directory and a nonempty `data.sessionID`. Require a nonempty upstream `event.id`; namespace it with the matched project ID. Do not generate a random fallback for malformed V2 IDs.

- [x] **Step 4: Run focused config/event tests and typecheck**

Run: `npm test -- --run tests/config.test.ts tests/events.test.ts`
Expected: PASS for all V2 routing, mapping, path, and malformed-input cases.

Run: `npm run typecheck`
Expected: exit code `0`.

- [x] **Step 5: Write failing V2 monitor and CLI tests**

Update monitor tests to inject a V2 client with `event.subscribe({ signal })` returning an async iterable. Assert one subscription handles two configured directories, routes events only to the matching project, uses the upstream V2 `event.id`, reconnects with delays `1000, 2000, 4000, 8000, 16000, 30000` ms, reports a sanitized gap on failure/end, never stores transport errors as session errors, propagates persistence failures, and stops without warning on abort. Test missing service as a retryable diagnostic without automatic startup. Update CLI tests to assert `start` creates one monitor with all projects and still closes the shared store on SIGINT/failure; keep `events` output/limit tests unchanged.

- [x] **Step 6: Run focused monitor/CLI tests and verify the expected RED**

Run: `npm test -- --run tests/opencode-monitor.test.ts tests/cli.test.ts`
Expected: FAIL because the current monitor creates a V1 client per project and the CLI starts one monitor per project.

- [x] **Step 7: Replace SDK dependency and implement the V2 service monitor**

Replace `@opencode-ai/sdk` with `@opencode/client` at `^2.0.18` and update the lockfile without approving additional lifecycle scripts. Use `Service.discover()` for each connection attempt; if it returns no healthy service, log a fixed actionable message that OpenCode V2 must be running, then retry with the same capped backoff. Build the client with `OpenCode.make` and `Service.headers`. Consume `client.event.subscribe({ signal })`; route each yielded event through `mapOpenCodeEvent` and persist before continuing. On stream failure or ordinary stream end, warn that V2 does not replay events missed during the outage, then reconnect. Keep storage errors fatal and keep diagnostics free of tokens or error response bodies.

- [x] **Step 8: Update CLI startup and user-facing configuration docs**

Change the injected/default startup path to create one `OpenCodeMonitor(config.projects, store)`. Change `config.example.json` to use absolute `directory` entries and remove `baseURL`. Update README usage to state that a healthy OpenCode V2 background service must already be running and that a stream outage can miss events. Do not change inbox inspection behavior.

- [x] **Step 9: Run focused tests, full verification, and dependency checks**

Run: `npm test -- --run tests/config.test.ts tests/events.test.ts tests/opencode-monitor.test.ts tests/cli.test.ts`
Expected: all focused tests pass.

Run: `npm test -- --run`
Expected: all tests pass.

Run: `npm run typecheck` and `npm run build`
Expected: both exit code `0`; `dist/cli.js` retains its Node shebang.

Run: `npm audit`
Expected: zero vulnerabilities.

- [x] **Step 10: Review staged files and commit the V2 migration**

Confirm `node_modules/`, `dist/`, local databases, real config, and credentials are not staged. Run `git diff --cached --check`, then commit with message `feat: migrate OpenCode bridge to V2`.

### Task 2: Validate event capture against the user's V2 service

**Files:**
- No product files; record smoke outcome in the implementation ledger/report.

**Interfaces:**
- Consumes: Task 1 V2 config, global monitor, and `project-voice-bridge start/events` commands.
- Produces: verified manual evidence or a precise environment limitation.

- [ ] **Step 1: Confirm the V2 service and prepare a local-only test config**

Use `opencode service status` and `opencode api get /api/info` to confirm a healthy V2 service. Use a temporary config/database outside the repository and configure only a test project directory. Do not include service credentials in the config.

- [ ] **Step 2: Start the bridge and generate a real event without unsolicited model usage**

Start the bridge and verify it subscribes to the V2 stream. Use a naturally occurring event or a user-provided test session if available. If generating a turn requires sending a prompt to the configured model, stop and ask the user before sending it; the prompt may incur provider cost. Do not simulate a native event by modifying OpenCode's database or emitting a fabricated event through a private endpoint.

- [ ] **Step 3: Verify routing, persistence, reconnect warning, and shutdown**

Confirm the real event appears once with the expected V2 type, project ID, and session ID. Restart the bridge and confirm the stored inbox record persists. Verify Ctrl+C stops the stream and closes the database. If safely possible, interrupt only the bridge subscription, confirm it reconnects, and verify its warning clearly states that events during the gap may have been missed.

- [ ] **Step 4: Record smoke results and remaining limitations**

Record the commands/results, whether a real turn-end and permission event were observed, whether a model prompt required additional approval, and any remaining Windows signal-delivery limitation. Do not claim an event category was smoke-tested unless a real event was captured.

---
