# Local Voice Agent for OpenCode — Design Spec

## Goal

Build an iPhone companion that helps the user manage multiple development projects by reporting when an OpenCode session finishes a turn, waits for input, or encounters an error. The user should be able to open an alert, hear a spoken summary, answer by voice, and have that reply delivered to the correct OpenCode session.

Speech recognition (STT) and speech synthesis (TTS) run on the user's computer using the local NVIDIA GTX 3060 with 12 GB VRAM. The service must not depend on a hosted voice-processing provider.

## Agreed product decisions

- The first coding-agent integration is OpenCode.
- OpenCode runs on the user's local computer across multiple project folders.
- The iPhone experience is a native app with push notifications and a turn-based voice exchange, not an always-open call.
- Local STT transcribes the user's recorded reply; local TTS speaks the agent's response.
- A cloud relay is used for push delivery and temporary transfer of voice audio between the iPhone and the local computer.
- The relay temporarily buffers audio, encrypted in transit and at rest, then deletes it after delivery/processing or expiration. Raw audio and transcripts are not kept as searchable history.
- “Stopped” initially means an explicit OpenCode session event (turn ended, waiting for input, or error), not an independent claim that all project work is complete.
- The system forwards the user's explicit reply to OpenCode; it does not trigger separate actions from inferred completion status.
- If the computer is offline, already-created push notifications can still be delivered. Voice processing and session replies wait until the computer reconnects.

## User workflow

1. The user enables the bridge for selected OpenCode projects/sessions.
2. The bridge observes an OpenCode turn-end, waiting-for-input, or error event, prepares a concise spoken summary using local TTS, and sends the event record and temporary summary audio to the relay.
3. The relay applies a short debounce/deduplication window, queues the event if needed, and sends a minimal push notification to the iPhone.
4. The user taps the notification. The app displays the project/session, retrieves the temporary summary audio, and speaks the status summary.
5. The app records a voice reply and uploads it to the relay over an authenticated encrypted connection.
6. The local bridge downloads the pending recording and runs STT locally on the GTX 3060. The app presents the transcript for review; only after the user confirms does the bridge deliver it to the matching OpenCode session as its next user message.
7. OpenCode's response is returned to the bridge. Local TTS synthesizes spoken audio; the bridge sends it through the relay for the app to play.
8. Temporary audio is deleted after acknowledgement or expiration. Basic event metadata may be retained for delivery/retry diagnostics, but not audio or searchable transcripts.

## System components

### OpenCode bridge

- Runs on the user's computer and has an outbound authenticated connection to the relay, avoiding a requirement to expose a local port to the public internet.
- Observes OpenCode session lifecycle events and associates each event with a configured project/session.
- Queues events while disconnected and synchronizes them after reconnecting.
- Downloads pending voice recordings, invokes local STT, routes the transcript to the correct session, and invokes local TTS for the response.
- Exposes no project files to the relay. Only event summaries and temporary audio required for the voice exchange leave the computer.
- The exact supported OpenCode event and session-resume interfaces must be verified against current OpenCode documentation during implementation planning.

### Local voice service

- Hosts one local STT model and one local TTS model, using the GTX 3060 where supported.
- Model selection must fit the 12 GB VRAM budget and be benchmarked for quality, latency, and memory use on the user's machine.
- Audio processing is local; no hosted voice API is called.
- The service may need serialized inference or controlled model loading if simultaneous STT/TTS would exceed available VRAM.

### Cloud relay

- Authenticates the bridge and iPhone app, routes events to the user's device, and integrates with Apple's push notification service.
- Buffers voice payloads only for delivery and processing; encrypts data in transit and at rest; deletes acknowledged or expired audio.
- Keeps push payloads minimal and avoids putting project prompts, transcripts, or sensitive code content into push notifications.
- Does not access local project files or run voice models.

### iPhone app

- Registers for push notifications and associates each alert with a project/session.
- Shows a concise status and starts a turn-based recording/playback interaction after the user opens the alert.
- Clearly indicates when a voice message is uploading, waiting for the computer, being transcribed, or ready for playback.
- Displays the recognized transcript for review and correction before the user confirms sending it to OpenCode.
- Does not retain raw audio as history.

## Event semantics and notification behavior

- Initial event types: turn ended, waiting for user input, and session error.
- Events are grouped by project and session. A short configurable quiet period suppresses duplicate/intermediate alerts; it must not hide an error or a new explicit request for input.
- The notification identifies the project and event category, with a short safe summary where available.
- Completion is presented as “OpenCode turn finished” unless a future, separately designed feature establishes stronger completion semantics.
- Replies are scoped to the session referenced by the notification. The app must show that context before submitting a reply.

## Privacy, security, and retention

- Use authenticated connections and TLS for all network traffic; encrypt temporary relay audio at rest.
- Store only account/device identity, routing metadata, event identifiers/status, and the minimum pending payload needed for delivery.
- Do not retain raw audio or conversation transcripts as searchable history.
- Apply a defined expiration to pending audio and provide an acknowledgement/deletion path for successful processing.
- Keep notification text minimal to reduce exposure on a locked screen.
- Secrets and device credentials must be stored using platform-appropriate secure storage and must be revocable.
- Threat model and key management details are implementation-plan decisions; this spec does not claim end-to-end encryption.

## Offline and failure behavior

- The bridge retries relay connectivity with backoff and sends queued OpenCode events after reconnecting.
- The relay deduplicates event IDs so retries do not generate repeated alerts.
- If the local computer is offline when the user records a reply, the app marks it as pending and explains that it cannot be processed until the computer reconnects. Pending audio expires rather than being stored indefinitely.
- If an audio upload, STT, OpenCode delivery, TTS, or playback step fails, show a recoverable status and preserve only the minimum temporary data needed to retry.
- If GPU inference is unavailable or runs out of memory, report a clear local error. CPU fallback behavior must be explicitly chosen during implementation planning rather than silently sending audio to a cloud service.
- Push notification delivery is best-effort; the app should refresh pending event status when opened.

## MVP scope

1. Observe one or more configured OpenCode sessions on one local computer.
2. Report turn-ended, waiting-for-input, and error events with deduplication.
3. Deliver iPhone push notifications and open the relevant session context.
4. Speak a concise local-TTS event summary when the user opens an alert.
5. Record a voice reply on iPhone, run local STT on the computer, and deliver the user-confirmed transcript to the correct OpenCode session.
6. Run local TTS on the computer and play the response on iPhone.
7. Use temporary relay audio buffering, minimal metadata retention, and offline/reconnect handling.

## Out of scope for the MVP

- Integrations with coding agents other than OpenCode.
- GitHub/CI monitoring or project-file indexing.
- Autonomous task execution or inferred project completion decisions.
- Always-on or real-time full-duplex voice conversations.
- Searchable conversation history or retained audio.
- Remote access to local project files.
- Guaranteed push delivery while the local computer is powered off, beyond delivery of notifications already created by the relay.

## Acceptance criteria

- An OpenCode event produces at most one alert per event after retry/deduplication.
- A notification opens the correct project/session context.
- Opening an alert plays a concise spoken status summary synthesized locally.
- A recorded reply is transcribed locally, reviewable/correctable by the user, and only delivered after confirmation to the matching session.
- The response is synthesized locally and playable in the iPhone app.
- Network inspection/configuration confirms no voice-processing request is sent to a hosted STT/TTS provider.
- Temporary audio is deleted after acknowledgement/processing or expiration; no searchable raw audio/transcript history is retained.
- The flow recovers from relay disconnection and local-computer reconnection without losing or duplicating a valid event/reply.
- The selected STT/TTS models run within the 12 GB VRAM budget in the intended operating mode, or provide a clearly surfaced error/fallback as specified.

## Validation plan

- Unit-test event classification, event deduplication, routing, retention expiry, and retry state transitions.
- Integration-test OpenCode event capture and session-specific reply delivery using a test project/session.
- Exercise the full voice loop and verify STT/TTS execute locally on the GTX 3060.
- Test delayed push, duplicate events, relay outage, computer offline/reconnect, expired audio, failed STT/TTS, and incorrect-session prevention.
- Verify deletion of temporary audio and confirm that push payloads do not include sensitive transcript or project content.
- Benchmark model latency, recognition quality, speech quality, and peak VRAM use on the target computer before locking model choices.
