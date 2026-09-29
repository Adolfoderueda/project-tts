# Local Spanish Voice CLI — Design Spec

## Goal and boundaries

Make the existing OpenCode V2 bridge useful as a PC-only, turn-based Spanish voice loop. The user starts the voice service manually, selects a stored event, listens to a locally synthesized status, supplies a separately recorded audio file, reviews or edits its transcript in the terminal, and explicitly confirms before the text is submitted to the event's OpenCode session. Success means the correct session is visibly identified before confirmation and cancellation never sends a message.

This is an intermediate milestone toward the native iPhone companion described in `2026-09-27-local-voice-opencode-agent-design.md`. No relay, push, phone app, microphone capture, automatic Windows startup, hosted speech service, or autonomous OpenCode prompts are part of this milestone. A live send that may invoke an OpenCode model requires separate approval during validation.

## Starting point and evidence

- The current Node CLI has `start` and `events`; SQLite stores normalized events with stable IDs, project IDs/names, session IDs, kind, timestamp, and summary. It has no get-by-ID, voice, or reply operation.
- The event monitor discovers and authenticates to the existing OpenCode V2 service. The event stream is live-only; a real lifecycle-event persistence smoke test remains pending.
- A throwaway localhost-only Speaches CUDA probe transcribed Spanish using multilingual Whisper Small and synthesized Spanish speech with Kokoro `ef_dora`. Warm inference worked; the container was stopped. This establishes feasibility, not that every Kokoro operation ran on the GPU. The native Windows probe and the untracked handoff are not production assets.
- The user's PC has an RTX 3060 with 12 GB VRAM, Docker Desktop/WSL2 GPU access, and a separately supplied audio file for the first CLI version.

## Selected architecture

Choose a pinned, manually started Speaches Docker setup separate from the existing Node bridge CLI. The voice service binds only to `127.0.0.1`, uses a persistent local model cache, and exposes local transcription and speech endpoints. Pin the tested image by immutable reference at implementation time and verify model IDs against that image's live registry; use multilingual Whisper Small and Spanish-capable Kokoro `ef_dora` unless verification reveals an incompatibility. Do not silently substitute hosted services, languages, voices, or unapproved large models. A start command and a stop command manage this service; do not configure Windows autostart. Document first-run model download and cache footprint; avoid downloading unrelated models. Startup and model-download errors must be visible.

Extend the bridge CLI with two separate, event-scoped commands (final flag spelling may follow existing CLI conventions):

The existing human-readable `events` output must expose each event ID so the user can select one without requiring JSON mode.

- `speak --config <path> --event-id <id> --output <wav>` looks up a stored event, synthesizes a concise Spanish status identifying its project and event kind without claiming the whole project is complete, and writes a local playable file. It does not submit an OpenCode prompt. Reject an existing output path rather than silently overwriting it.
- `reply --config <path> --event-id <id> --audio <file>` verifies the event and session context, transcribes the supplied recording locally, then shows the project, session, event summary, and full transcript. The user can edit the text in the terminal and must explicitly confirm the final text and destination. EOF, Ctrl+C, an empty final text, or any answer other than explicit confirmation means no send. Never infer approval from the mere presence of a recording or transcript.

The initial commands are interactive except for `speak`. There is no unattended `--yes` or direct-text bypass in this milestone. The supplied recording stays where the user put it; the bridge neither uploads it to a hosted API nor stores its contents or transcript in SQLite. The generated speech file stays local under the user-selected path. The CLI reports where the file was written; the user may play it with a local player.

## Routing and send boundary

Add an exact `EventStore` lookup by event ID. An unknown ID fails closed. Resolve the stored project ID against the current config and reject missing/mismatched project context rather than guessing by name. Discover the existing authenticated OpenCode V2 service using the same local helper as the monitor, fetch the target session, and verify its ID and location directory exactly match the configured project's normalized directory before showing a send confirmation. A missing session, changed location, service failure, or unverifiable response fails closed. The confirmation displays the verified project and session ID immediately before sending, not merely the voice-generated text.

Submit only the edited, confirmed text to that session through the supported OpenCode V2 session prompt API. Never construct a new session or forward a reply to another session as a fallback. No automatic send retry: if submission fails or times out, report that delivery may be uncertain and require the user to inspect the session before trying again, to avoid duplicate prompts. Confirmation is a send boundary, not a guarantee that an already-running OpenCode session finished processing.

## Failure behavior and privacy

Check the input file exists and is within a documented size limit; reject unsupported audio formats with an actionable local diagnostic. Check the localhost service is available before an inference request and distinguish service/model failures from empty transcription. Reject empty or whitespace-only transcripts. No silent CPU/GPU or cloud switch: report measured execution provider and timing honestly in documentation rather than treating CUDA provider availability as proof all TTS operations ran on GPU. If GPU inference is unavailable, surface an actionable local failure or document an explicit local CPU fallback; neither behavior may invoke a hosted endpoint.

Keep voice URL fixed or constrained to loopback, not a configurable arbitrary remote speech endpoint in this milestone. Do not log OpenCode credentials, audio bytes, or transcripts. No transcript history table or automatic retention of newly generated audio. Clean up partially written output on failed speech synthesis where safe; never delete the user's input file. Errors before confirmation never call the OpenCode prompt endpoint.

## Validation and acceptance

- Test event lookup, wrong/missing project, cross-project and changed-session-location rejection, and unknown event ID.
- Test synthesis request and output creation without overwriting existing files; failures leave no misleading successful output.
- Test file validation, local transcription, review/edit flow, empty result, cancellation/EOF/Ctrl+C, confirmation, and send uncertainty. Assert the prompt API is never called before an explicit confirmation and is called for only the verified session with the final edited text.
- Test unavailable Speaches/OpenCode and malformed responses with injected clients; run existing bridge regression tests, typecheck, and build.
- Manually verify Docker is bound to localhost, Spanish STT/TTS results and local playback, model cache/start/stop, and observed GPU/VRAM/latency on the target PC. Do not claim all TTS operations use GPU from provider lists alone.
- A real lifecycle-event capture and any live OpenCode prompt are separate smoke tests. Use natural activity when possible; ask before issuing a potentially billable prompt. A fully live confirmed-send test remains unverified until separately approved.

The local milestone is complete when a stored event can be spoken and a supplied Spanish recording can be reviewed, edited, and explicitly sent to that event's verified OpenCode session, or cancelled with no send; failures are safe and the voice service remains local and manually controlled.
