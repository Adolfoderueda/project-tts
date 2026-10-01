# Local bilingual voice CLI — performed / deferred acceptance

Date: 2026-10-01. Scope: Task 7 of the approved [plan](../superpowers/plans/2026-10-01-local-bilingual-voice.md), following Tasks 1–6. **Offline verification passed; live bilingual acceptance is deferred, not passed.** No separate approval was given for live PC probes, shared-GPU inference/listening, private recording access, or billable prompts. This task did not contact Ollama, Speaches, or OpenCode services, including `/api/ps`.

## Performed on the implementation

| Verification | Observed result |
| --- | --- |
| `npm test -- --run tests/bilingual-cli.integration.test.ts` | 22/22 passed; final focused run 2.63 s |
| `npm test -- --run tests` | 26 files, 441/441 tests passed; final run 1.78 s |
| `npm run typecheck` | Exit 0 |
| `npm run build` | Exit 0 |
| `git diff --check` | Exit 0; Git's LF-to-CRLF notice on README is informational |
| Source and built CLI shebang | Both start with `#!/usr/bin/env node` |
| Built CLI with no arguments | Prints all six commands and language override syntax to stderr; expected exit 2, empty stdout |

The integration tests run production `main`, `LineTerminalPrompt`, `EventStore`, `OllamaTranslator`, `OpenCodeResponses`, `OpenCodeReply` (including the final session recheck and actual adapter send boundary), `VoiceClient`, and WAV helpers. Only fetch/client transports are injected. There is no mocked workflow/send bypass, live HTTP, service discovery, or billable prompt; `session.prompt` is a named mock at the transport boundary.

Coverage includes distinct events/projects/sessions, bounded metadata-only listing, exact response IDs, English/Spanish directions, config and override precedence including omitted project language, zero Ollama calls on Spanish identity, Spanish TTS input, original synthetic recording preservation, source/target edits, protected paths and commands, visible escaped bidi control review with byte-exact confirmed send, literal lowercase confirmation, cancellation/EOF/Ctrl+C, redacted transport failures, and moved sessions before inference and at the send boundary. SQLite snapshots compare table names, schema SQL, explicit row counts, and all rows before/after; no text/history schema or records are added. Named `prompt`, `speechInputs`, `store`, and `seededEvent` assertions pin the planned success case.

The synthetic WAV fixture only has the signature required by production validation. Its mocked output proves file plumbing and TTS request content, **not decodable audio, actual speech quality, codec compatibility, or GPU execution**. Deterministic translation fixtures return masked placeholders intact; they prove wiring/restoration, not model accuracy. The broader unit suite covers length/Unicode bounds, malformed model responses, literal failures, digest/redirect checks, legacy compatibility, and uncertain-delivery/no-retry handling.

No real regression was observed; no RED phase was manufactured and no production files were changed. Task 7 fixture directories (config, SQLite, synthetic recording/output) are removed after each test; a post-run directory check found zero `bilingual-integration-*` directories in the system temp root. No live OpenCode test sessions or recordings were created or accessed. Existing suites may retain their own synthetic temporary fixtures; this task did not sweep or delete unrelated artifacts. Build output remains in ignored `dist/`.

## Historical evidence — explicitly preimplementation

The [design spec](../superpowers/specs/2026-10-01-local-bilingual-voice-design.md#starting-point-and-evidence) records earlier synthetic probes against Ollama 0.35.0, local `gemma4:e2b`, Q4_K_M, digest `7fbdbf8f5e45a75bb122155ed546e765b4d9c53a1285f62fd9f506baa1c5a47e`:

- Four short translations; tested backtick literals preserved; one awkward Spanish phrase.
- Cold 14.525 s including 13.803 s loading; warm 0.228–0.495 s.
- Device-total sampled baseline 1,328 MiB and sampled peak 4,144 MiB; **not an exact peak or model attribution**.
- Ollama reported `size_vram=1,708,392,447` bytes at context 4,096; **model-reported allocation**, not equivalent to device-total samples. Disk size 7,162,405,886 bytes is a third distinct measure.

These were **before this implementation**, not newly performed Task 7 acceptance. Short probes used a 256-token generation cap; production uses 1,024. They establish neither near-limit reliability nor simultaneous STT/TTS/translation residency. Earlier voice-only [validation](2026-09-29-local-spanish-voice-cli.md) and [listening acceptance](2026-10-01-spanish-voice-acceptance.md) are also historical, not acceptance of this new bilingual flow; no private recording from those records was reopened here. Kokoro CUDA provider, turn-completion event capture, and fresh model-download limitations are not resolved by this task.

## Deferred acceptance and prerequisites

All rows below are **not performed** in Task 7:

| Deferred check | Required evidence after separate approval |
| --- | --- |
| Current runtime/model identity and shared residency | Inspect `/api/ps` before any inference; verify `/api/tags` against configured digest; coordinate if another project's model is loaded. Never force eviction or alter its settings. |
| Actual production translation in both directions | Short and near-2,000-code-point synthetic examples, Unicode accents, negation/numbers/uncertainty, inline/fenced commands and paths; assess intent and exact protected bytes. Use production context 4,096 and generation cap 1,024. |
| Actual voice and human listening | Approved synthetic WAV/STT -> edits -> target review; exact completed response -> translation -> Spanish WAV; inspect intelligibility with the user. No send required for local-only acceptance. |
| Sequential/shared GPU residency and latency | Cold/warm request timing and load time; time-stamped device-total samples and separate `/api/ps` model allocations; disclose sample intervals, other workload and provider evidence. Do not infer concurrent fit from short isolated samples or CPU fallback. |
| Live exact-session OpenCode send/retention | Separate billable-send approval and approved recording/text/session; verify exact final target once and inspect uncertain delivery manually. No automatic retries. |

Private recording access requires separate explicit approval even for local processing. No download, service start/stop, lifecycle action, global configuration change, or billable prompt is authorized by this record. README probe snippets are future guidance only and were not executed.

## Remaining constraints and acceptance decision

- Live semantic quality, actual audio, near-limit production generation, and concurrent VRAM fit remain unaccepted. If approved probes fail, stop and revise the approved model/runtime/limits rather than declaring pass or silently falling back to cloud/another model.
- `keep_alive: '30s'` is a request lease, not isolation or a guaranteed unload deadline. Shared Ollama requests can change residency/context and compete with other projects; the CLI has no global GPU scheduler.
- Session location is rechecked immediately before synthesis/send, not transactionally locked through an external service operation. Deleted/moved sessions detected at the boundary fail closed.
- WAV exclusive creation is retained, but best-effort cleanup still has the documented non-atomic stat/inode-check-to-unlink replacement race.
- The bridge does not persist text/history; terminals/output WAVs can retain review material, and OpenCode retains confirmed messages by its own policy.

Only offline readiness is established. Choose separately whether to authorize live synthetic acceptance and, independently, a billable send. No merge or push was performed.
