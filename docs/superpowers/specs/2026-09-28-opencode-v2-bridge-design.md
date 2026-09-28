# OpenCode V2 Bridge Integration — Design Spec

## Goal

Update the existing OpenCode bridge to integrate with the user's installed OpenCode V2 service. Replace the legacy V1 event API and event payload assumptions while preserving the bridge's durable local inbox, project/session routing, explicit event semantics, and current CLI workflow.

## Context and discovery

- The project currently depends on `@opencode-ai/sdk` V1 and subscribes to `/event`, expecting `{ type, properties }` events.
- The user's installed OpenCode is V2.0.18. Its OpenAPI document exposes the native event endpoint at `/api/event`; `/event` responds with the V2 web application rather than an event stream.
- OpenCode V2's official TypeScript HTTP client is `@opencode/client` (the published version observed during design is 2.0.18). Its client API yields native events as an async iterable.
- The V2 event API is live-only: events that occur while the bridge is disconnected are not replayed. The MVP will reconnect and report this limitation rather than adding a durable plugin/outbox in this phase.

## Decisions

- Target OpenCode V2 only. Do not keep V1 compatibility adapters.
- Connect to the existing local OpenCode background service using the official V2 service discovery/authentication helpers. Do not put service credentials in bridge config and do not silently start a server if discovery fails; report how to start OpenCode.
- Subscribe once per bridge process to the V2 server's global native event stream. The stream spans server locations, so route events by their `location.directory`, not by starting one subscription per project.
- Project configuration identifies local project directories. Normalize paths for exact matching, accounting for platform path rules; reject ambiguous duplicate configured directories. Events for unconfigured locations or missing location metadata are ignored rather than guessed.
- V2 events use `{ id, type, data, location? }`; use the upstream event `id`, namespaced with the configured project ID, as the stable inbox ID.
- Mapping:
  - `session.idle` with `data.sessionID` → `turn-ended` / “OpenCode turn finished”.
  - `permission.asked` with `data.sessionID` → `waiting-for-input`.
  - `session.execution.failed` with `data.sessionID` → `error`.
  - Unknown, malformed, unconfigured-location, or session-less events are ignored.
- Keep the existing SQLite schema and CLI `events` command unless implementation planning identifies a necessary interface change. Persist normalized events locally before any future relay work.
- Reconnect using bounded exponential backoff and stop on abort. Since V2 cannot replay events missed during an OpenCode-stream outage, emit a clear sanitized warning when a subscription fails or ends and never infer completion from current session state.
- The user accepts this live-stream gap for the MVP. A durable local outbox/plugin is a possible future reliability improvement, not part of this migration.

## Out of scope

- OpenCode V1 support.
- A plugin or local durable event outbox for replay across stream outages.
- Relay, cloud push, local STT/TTS, and iPhone app changes.
- Session reply delivery through OpenCode V2; that belongs to the later voice-service integration plan.

## Security and privacy

- Use the V2 service helper for authentication headers; never print or store tokens in config, logs, tests, or event rows.
- Connect only to the user's existing local OpenCode service in the MVP.
- Continue persisting concise normalized event metadata only. Do not read or transmit project files.
- Keep stream failure diagnostics sanitized and do not persist transport failures as OpenCode session errors.

## Validation

- Unit-test typed V2 event mappings (including the V2 SDK's `session.execution.failed` event), stable project-scoped IDs, path routing across multiple configured projects, unknown/malformed events, and duplicate event IDs.
- Test one global subscription, abort/shutdown, reconnect delay/cap, sanitized stream-failure diagnostics, and the explicit no-replay warning behavior.
- Test configuration with two project directories and reject duplicate/invalid directories.
- Keep persistence failures fatal to the monitor rather than classifying them as transport failures.
- Run the full unit suite, TypeScript typecheck, production build, and dependency audit.
- Perform a manual smoke against the user's V2 service: capture a real turn-end and permission event, verify project/session routing and SQLite restart persistence, and verify clean shutdown. A prompt that invokes the configured model may incur provider cost; ask the user before submitting one if a natural session event cannot be generated without it.

## Acceptance criteria

- The bridge subscribes to the V2 `/api/event` surface through the official V2 client/service integration and does not call the legacy `/event` endpoint.
- Events from two configured project directories are attributed only to the matching project; unknown locations are ignored.
- The three event categories map from the V2 SDK's current event names and payloads (`session.idle`, `permission.asked`, `session.execution.failed`) without inferring stronger completion semantics.
- Repeated delivery of the same V2 event ID for a project produces at most one inbox row.
- Stream abort and reconnect are handled safely; storage failures propagate.
- Logs clearly disclose that the live V2 stream does not replay events missed during disconnection.
- No project file contents or OpenCode credentials are copied into the event store or logs.
