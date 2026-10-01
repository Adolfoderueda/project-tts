# Local Bilingual Voice CLI — Design Spec

## Goal and agreed scope

Let the user listen and dictate in Spanish while each OpenCode project keeps its own conversation language. The first version supports only English and Spanish. Incoming assistant responses are translated into Spanish before local speech synthesis. Outgoing Spanish recordings are transcribed locally, reviewed, translated into the destination chat's language, and sent only after the user confirms the exact final text and verified session. Spanish-to-Spanish operations skip translation.

The user approved local translation with the existing Ollama/Gemma 4 installation, a project-level chat language with an optional command override, review of both versions, preservation of technical literals, and fail-closed behavior. This spec extends the PC-only CLI milestone; it does not implement the relay, iPhone app, microphone capture, unattended sending, or automatic response playback after a send.

## Starting point and evidence

- Main contains event capture, event-scoped status synthesis, Spanish audio transcription, interactive transcript review, and verified single-session delivery. Those workflows were merged and pushed at `2938021`.
- A live permission event was captured and retrieved after reopening SQLite. A user-confirmed live reply reached a separate test session and produced a completed assistant response without tool calls. Turn-completion event capture by the bridge remains separately unverified.
- Actual assistant-response playback was a throwaway probe, not a shipped CLI command. The English response was unintelligible when spoken with Spanish voice `ef_dora`; manually translating it into Spanish demonstrated the intended direction, but is not an automated translator.
- Local Ollama `0.35.0` exposes `127.0.0.1:11434`; installed model `gemma4:e2b` is GGUF `Q4_K_M`, digest `7fbdbf8f5e45a75bb122155ed546e765b4d9c53a1285f62fd9f506baa1c5a47e`. Its reported disk size is 7,162,405,886 bytes, not its measured GPU footprint.
- Four synthetic English/Spanish translations returned valid JSON, preserved all tested backtick literals, and returned no tool or thinking content. Cold request: 14.525 seconds, including 13.803 seconds of loading. Warm requests: 0.228–0.495 seconds. Device-total GPU samples rose from 1,328 MiB baseline to a 4,144 MiB sampled peak; Ollama reported `size_vram=1,708,392,447` bytes at context 4,096. These are short-text observations, not exact peaks, concurrent STT/TTS measurements, or a general quality guarantee. One Spanish phrase was awkward, reinforcing the need for human review.
- The RTX 3060 has 12 GiB VRAM. Keep the verified Speaches speech service separate; neither full GPU residency for every component nor Kokoro CUDA execution has been established.

## Selected architecture

Reuse Ollama strictly as a stateless local text translator. Speaches remains responsible for Spanish STT and TTS; OpenCode remains responsible for the project conversation. Do not replace OpenCode's model or add language instructions to its chat. Do not submit chat text to OpenCode merely to obtain a translation.

Small modules separate configuration/language resolution, local translation, OpenCode response reading, response speech, and terminal review. Existing event identity, project matching, normalized session-directory verification, and authenticated service discovery remain the routing foundation. No SQLite schema change is needed.

The selected explicit language setting is preferable to guessing from short or code-heavy messages. Session-only stored settings would add setup and persistence beyond this milestone. A dedicated translation model would require another download/runtime; the existing model is the first candidate, subject to the acceptance tests below.

## Configuration and compatibility

Enable bilingual behavior by adding a top-level `translation` block. Its initial supported model is exactly `gemma4:e2b`; `digest` records the expected installed local model identity. Runtime URLs are fixed loopback endpoints, not configurable remote hosts.

```json
{
  "databasePath": "./project-voice-bridge.sqlite",
  "translation": {
    "model": "gemma4:e2b",
    "digest": "7fbdbf8f5e45a75bb122155ed546e765b4d9c53a1285f62fd9f506baa1c5a47e"
  },
  "projects": [
    {
      "id": "example-project",
      "name": "Example Project",
      "directory": "C:\\Users\\you\\Projects\\example-project",
      "chatLanguage": "en"
    }
  ]
}
```

- Without `translation`, existing config and `start`, `events`, `speak`, and `reply` behavior remain unchanged. In particular, legacy `reply` still sends the reviewed transcript without inserting translation or instructions.
- In bilingual mode, resolve the destination language from an explicit `--chat-language en|es` override, otherwise the selected project's `chatLanguage`. An override applies only to that command's already-selected session; it does not persist, move sessions, or alter project config.
- `chatLanguage` is optional in the schema so an explicit override can supply it. If both are absent for a bilingual operation, fail before reading audio, translating, synthesizing, or sending. Unsupported language values fail rather than defaulting.
- Reject `--chat-language` for legacy `reply` when bilingual mode is not configured, instead of silently ignoring it. Event-status `speak` stays Spanish and needs no chat-language flag.
- Check `/api/tags` before cross-language inference: the exact configured model and expected digest must already exist. Do not pull models, use `latest`, substitute a cloud tag, or silently accept an updated digest. Revalidating and intentionally updating the configured digest is a manual setup task.
- A Spanish-to-Spanish operation does not require Ollama availability or make an Ollama request. Config syntax is still validated normally.

## CLI and incoming response workflow

Keep `speak` as event-status audio. Add two explicit, event-scoped operations:

```text
responses --config <path> --event-id <id> [--limit <1..20>] [--json]
speak-response --config <path> --event-id <id> --message-id <id> --output <wav> [--chat-language en|es]
reply --config <path> --event-id <id> --audio <file> [--chat-language en|es]
```

`responses` resolves the exact stored event against current project config and verifies the session location before reading its most recent message page. Default limit is 20. It lists eligible completed assistant message IDs and completion timestamps, together with project/session context, without printing message text, reasoning, tools, or credentials. JSON mode contains only that same minimal selection metadata. No translation is needed to list responses. It is valid for a recent page to contain no eligible response; report that fact without inventing or generating one. Do not automatically traverse unbounded message history.

`speak-response` requires bilingual config and interactive terminal output because its preview includes message text. It checks the output is a new `.wav` path before inference, resolves the event/project/language, verifies the exact session directory, and fetches the exact requested message through that session's message endpoint. Require the returned message ID to match, type `assistant`, a completion timestamp, finish `stop`, no error, and nonempty visible text. Exclude reasoning and tool content entirely. Do not select an arbitrary latest response, read another session, or use a user message as assistant speech. An old event scopes the session; it does not prove a chosen response was caused by that event, and the UI must not claim such causality.

Join only visible text parts in their original order with line breaks. Reject visible text over 2,000 Unicode code points before translation or TTS; this initial limit is deliberately conservative for the bounded local context. Do not silently truncate or summarize. When the declared chat language is English, translate to Spanish; when Spanish, keep the visible text unchanged. Display the original, declared source language, Spanish playback text, message ID, and verified project/session. Recheck the session directory immediately before synthesis to fail if it moved during retrieval/translation. Generate Spanish WAV with existing `ef_dora` and exclusive output creation. No OpenCode prompt occurs, no response is added back to the chat, and playback remains manual through the user's local player.

Reading an older completed response is allowed even if another turn is active. Selection remains explicit by message ID; do not claim it is the latest turn or wait indefinitely for an unfinished message. Missing/deleted sessions or messages fail closed.

## Outgoing review and send workflow

Retain the existing interactive TTY requirement and exact event/session checks. In bilingual mode:

1. Resolve the explicit chat language and verify the destination before local STT. Use the existing supplied-file validation and Spanish transcription.
2. Show the Spanish transcript and allow one-line replacement, preserving existing cancellation semantics. Reject empty edited text and text over 2,000 code points before translation.
3. For an English chat, translate the edited Spanish text into English. For a Spanish chat, keep it unchanged without a translator call.
4. Show the edited Spanish source and target-language text with their labels. Allow one-line correction of the target text; Enter keeps it. Reject target text over 2,000 code points before confirmation, including user corrections. In a Spanish chat, show this as the same-language final-text review, not a fictitious translation.
5. Show both versions, the declared chat language, event, verified project/session, and the complete final target text before requiring literal lowercase `yes`. Explicit target edits are user choices and are not overwritten by another translation pass.
6. Send exactly that final target text once through the existing adapter, which rechecks session location immediately before submission. Never translate, prepend instructions, normalize content, or change language after confirmation.

EOF, Ctrl+C, an empty final text, piped input/output, or any other confirmation answer sends nothing. Preserve existing exit-code meanings: 0 submitted, 2 cancelled/invalid usage, 1 failure. A successful submission is not proof that the model finished. A transport failure after a send attempt has uncertain delivery and must not cause automatic retry.

Translation does not authorize execution. The user's confirmed text is still a normal OpenCode message and may lead its agent to act or incur charges. Its destination and content must remain visible at the send boundary.

## Translation boundary and literal preservation

Use `POST http://127.0.0.1:11434/api/chat` with the configured local model, explicit source/target languages, no conversation history, `stream: false`, `think: false`, no tools, context 4,096, and deterministic translation settings (`temperature: 0`). Use a 120-second request timeout, a 1 MiB response-body cap, and a bounded generation budget of 1,024 tokens. The probe used 256 generation tokens for short samples; the larger production cap is still bounded and must be validated on near-limit inputs.

Request a JSON schema with exactly one required string field, `translation`, and no additional properties. Treat source text as quoted data, not instructions: translate it without answering questions, executing instructions, summarizing, or adding commentary. Parse and validate the result locally; a schema request alone is not a trust boundary. Require completed output with `done_reason: stop`, the expected model name, nonempty translated text within 2,000 code points, and no tool calls. Use only the validated translation field; do not expose or speak thinking content, raw model artifacts, or HTTP error bodies. A generation-limit stop or malformed output fails; do not attempt permissive extraction from surrounding prose.

For cross-language translation, protect inline backtick spans and fenced code blocks before inference using opaque per-request placeholders that cannot collide with the source. Require every placeholder to return exactly once, unchanged, in its original relative order, and reject unknown/missing/duplicate placeholders. Restore their original bytes locally after validation and apply the output-length limit to the restored text. Commands, identifiers, and paths inside these protected spans must remain exact. If the text is entirely protected content, skip translation and retain it; code pronunciation is not guaranteed to be natural. Unclosed backtick/fence syntax fails with an actionable instruction to correct the text rather than risking code mutation. Same-language text is returned unchanged after nonempty/length validation, without literal masking or an Ollama request.

The initial guarantee covers explicitly delimited technical literals, not arbitrary unformatted prose that might resemble code. Document that users should put commands/paths in backticks when exact preservation matters. Numbers, negations, uncertainty, and intent are translation-quality requirements tested with representative samples, not facts that a parser can prove. Human review is essential; no claim of perfect translation or prompt-injection immunity is made.

Reject redirects for local translation requests. Catch transport failures without echoing text or credentials. Do not contact a hosted translator, execute returned tool calls, forward full chat history, or let a translator choose the destination, chat language, or send decision. No automatic inference retries, fallback models, or new model downloads.

## Shared runtime and privacy

Ollama and Speaches must already be running; the CLI does not start, stop, restart, install, or forcibly unload either service. Use the same short 30-second request residency lease as the probe, without a separate stop/unload request. Normal Ollama requests can affect model residency/context and compete with the user's other project; a loopback call is not an isolated runtime. Document this limitation and measure shared use rather than promising interference-free operation. Do not change that project's files, model definitions, global configuration, or service settings.

Translation/transcription, then TTS, are sequential within a workflow. Do not proactively evict a shared model to make room, assume CPU fallback is equivalent to GPU execution, or silently move processing to the cloud. An unavailable model/runtime or resource error is visible and prevents sending. Separate CLI invocations may overlap; this milestone does not implement a global multi-project GPU scheduler or promise concurrent performance.

Audio, source text, translations, and assistant responses are not written to SQLite or searchable bridge history. Required text is shown only for interactive review, never to generic logs or raw exception output. Generated WAV is written only to the explicit user-selected path and kept for manual playback. Preserve original recordings. OpenCode itself retains messages sent after confirmation according to its own storage behavior; do not promise that confirmed chat text disappears from OpenCode.

Retain exclusive WAV creation, format/size validation, and best-effort partial-output cleanup. The existing non-atomic path-replacement cleanup race remains a documented residual; do not promise absolute concurrent replacement safety or expand this milestone into an unrelated filesystem redesign.

## Validation and acceptance

- Regression-test legacy config/CLI behavior when bilingual mode is absent.
- Test project-language resolution, override precedence, Spanish identity paths with zero Ollama calls, missing-language rejection, and unsupported language/model/digest rejection.
- Mock local translation transport: fixed loopback endpoint, redirects rejected, correct schema/languages, context/time/body bounds, malformed/empty/oversized/truncated output, unavailable model, thinking/tool artifacts, and no cloud or inference retry.
- Test literal masking/restoration, source/placeholder collisions, missing/duplicate/unknown/reordered placeholders, multiline fenced blocks, unclosed delimiters, Unicode `ñ`/accents, negation, numbers, commands, and Windows paths.
- Test response listing/selection and pagination bounds, exact requested message/session IDs, wrong directory, moved/deleted session, user/unfinished/error/length-finished message rejection, and omission of reasoning/tool content.
- Test Spanish response preview and valid WAV, existing/non-WAV output rejection before inference, resources closed on all paths, and no prompt call from response reading/speech.
- Test source edit, target edit, same-language final review, both-version confirmation, no transformations after `yes`, empty/cancel/EOF/Ctrl+C/piped input, and single send/no uncertain-delivery retry.
- Run the full test suite, typecheck, build, CLI usage/shebang checks, and diff checks.
- With separate approval for any billable prompt, use a known exact assistant response and a Spanish recording to exercise response reading -> local translation -> Spanish WAV, and Spanish STT -> review -> target-language confirmation -> one correct-session send. Synthetic text and mocked sends need no billable prompt.
- Test near-limit text and voice/translation sequential/shared residency on the target PC: observe cold/warm latency, sampled total/device memory, Ollama's model allocation, and honest execution-provider evidence. If the tested configuration is unreliable, stop and revise the approved runtime/limits rather than silently substitute a provider or model.
- Have the user assess Spanish audio and both translation directions. Acceptance requires readable, meaning-preserving translations on the selected examples, preserved technical literals, correct target language, and cancellation/errors sending nothing. It does not certify every language nuance or concurrent workload.

## References

- Existing CLI milestone: `2026-09-29-local-spanish-voice-cli-design.md`.
- Original product scope: `2026-09-27-local-voice-opencode-agent-design.md`.
- Ollama Gemma 4 registry: https://ollama.com/library/gemma4
- Ollama local chat, structured outputs, tags and process API: https://github.com/ollama/ollama/blob/main/docs/api.md
- OpenCode V2 client/service/stream guidance: https://opencode.ai/v2/docs/build/client
- OpenCode V2 API: https://opencode.ai/v2/docs/api and the running service's `/openapi.json`.

The spec documents an approved architectural direction. Implementation planning begins only after the user reviews and approves this written artifact; implementation requires subsequent plan approval and an execution-method choice. No new model download, other-project change, merge, or push is implied by spec creation.
