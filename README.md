# Project Voice Bridge

Local OpenCode V2 event capture and opt-in English/Spanish voice CLI.

## Build

```bash
npm run build
```

The npm bin is `project-voice-bridge` and points to `dist/cli.js`.

## Use

Create a config file like `config.example.json`, replacing `directory` with the absolute path of each project to monitor. OpenCode's V2 background service must already be running; the bridge discovers and connects to it but does not start it.

Then run:

```bash
project-voice-bridge start --config ./config.json
project-voice-bridge events --config ./config.json --limit 20
project-voice-bridge events --config ./config.json --json
project-voice-bridge speak --config ./config.json --event-id '<id-from-events>' --output ./status.wav
project-voice-bridge reply --config ./config.json --event-id '<id-from-events>' --audio ./recording.wav
```

`start` subscribes once to OpenCode V2's global event stream and routes events to configured projects by directory. Captured events are written to the shared SQLite inbox. Press `Ctrl+C` to stop and close the store.

The V2 event stream is live-only: events that occur while the bridge is disconnected are not replayed. The bridge warns when the stream ends or disconnects, then reconnects with backoff; events during the outage may be missed.

`events` displays the exact event ID to use in `speak` or `reply` (quote IDs containing shell punctuation). `speak` writes a new local WAV file and refuses to overwrite an existing file; play the result with your local audio player. Start the voice service manually and install its models (below) before either voice command. For `reply`, supply a recording you made separately and run the command in an interactive terminal: redirected or piped input/output is refused. In legacy mode the CLI transcribes it on localhost, displays the transcript, and lets you replace it with a single line (press Enter to keep it). It then shows the verified project, event, session ID, and **full final text**. Bilingual mode adds a second edit stage as described below. Only typing lowercase `yes` exactly at the final confirmation sends the final text to the selected OpenCode session. Any other answer, EOF, or Ctrl+C cancels without a send; there is no `--yes` flag. Exit codes: 0 sent, 2 cancelled or invalid usage, 1 failure. A confirmed send can invoke a **billable OpenCode model prompt**; inspect the session before retrying after an uncertain-delivery failure. Verification never falls back to another session and the bridge does not automatically retry sends. The original recording stays where you put it; the CLI does not store the recording or transcript in SQLite.

## Local Spanish voice service (manual setup)

Install and start Docker Desktop with WSL2 and NVIDIA GPU support. On this Windows machine the verified Docker CLI directory is `$env:LOCALAPPDATA\Programs\DockerDesktop\resources\bin`. If `docker` is not on PATH, add that directory for the current PowerShell session with `$env:PATH = "$env:LOCALAPPDATA\Programs\DockerDesktop\resources\bin;$env:PATH"` (some Docker Desktop installs instead use `C:\Program Files\Docker\Docker\resources\bin`). Check `docker compose version` before starting. Speaches is pinned by image digest in `deploy/compose.voice.yaml`; do not replace it with a moving upstream Compose download. Docker must be running before issuing these commands from the repository root in PowerShell:

```powershell
.\scripts\voice.ps1 start
.\scripts\voice.ps1 status
.\scripts\voice.ps1 models
.\scripts\voice.ps1 stop
```

`start` and `stop` are explicit; neither Windows nor the Node CLI starts this service automatically. `models` requires a running service at `http://127.0.0.1:8000`, checks its live registry before downloading only `Systran/faster-whisper-small` and `speaches-ai/Kokoro-82M-v1.0-ONNX`, then checks both are installed. Spanish speech uses Kokoro voice `ef_dora`. The first `start` downloads the pinned CUDA image; the first `models` downloads model files and may take several minutes. Allow several GB of free disk space for the image, models, and cache; actual usage varies by image and model revisions. Docker's named volume `voice-model-cache` stores the Hugging Face model cache at `/home/ubuntu/.cache/huggingface/hub` inside the container; list volumes with `docker volume ls --filter name=voice-model-cache` and inspect the matching volume with `docker volume inspect <volume-name>` (Compose adds a project prefix). `stop` retains this volume; do not use `down -v` unless you intend to delete downloaded models.

The service publishes only `127.0.0.1:8000`; it does not send recordings to a hosted speech provider. Docker Desktop/WSL2 and NVIDIA driver support are needed for the GPU reservation. A successful container start alone does not demonstrate GPU inference for every TTS operation; measure actual provider, VRAM, and latency on the target PC before making that claim.

Local transcription accepts an existing `.wav` (RIFF/WAVE) or `.m4a` (MP4 audio) recording smaller than 25 MiB. The file extension and signature must agree; the original file is never deleted. A matching container signature does not guarantee its audio codec can be decoded: the local service may reject it, and the CLI reports the service failure without promising a codec-specific explanation. A synthetic AAC M4A was verified locally; other codecs and real recordings are not yet verified.

## Opt-in bilingual configuration

Without a top-level `translation` block, legacy `start`, `events`, `speak`, and `reply` retain their behavior: `reply` sends the reviewed Spanish transcript, without translation or inserted language instructions. `speak` always speaks event status, **not an assistant response**. `config.example.json` includes bilingual settings; remove `translation` to keep legacy behavior. Merely setting a project language does not enable translation.

For bilingual mode, add the following to your config and declare `chatLanguage` on each project:

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

Only `en` and `es` are supported. `--chat-language en|es` takes precedence over the selected project's setting **for that invocation only**; it does not save settings or select a different session. Bilingual speech/reply fails before audio/inference if neither is declared. Language is never guessed. Legacy `reply` rejects this override without `translation`.

### Select an exact response and listen in Spanish

```powershell
project-voice-bridge responses --config ./config.json --event-id '<event-id>' --limit 20 --json
project-voice-bridge speak-response --config ./config.json --event-id '<event-id>' --message-id '<message-id>' --output ./response.wav
# Optional explicit override for this session's declared language:
project-voice-bridge speak-response --config ./config.json --event-id '<event-id>' --message-id '<message-id>' --output ./other-response.wav --chat-language es
```

`responses` works with legacy or bilingual config, verifies the event's session/project, and lists only eligible completed assistant IDs and completion timestamps, never message text. It reads one recent page (limit 1–20, default 20), not unbounded history. An empty list does not generate a response. Choose an exact ID; the event scopes the session but does not prove that message was caused by the event.

`speak-response` requires bilingual config and interactive terminal **output**. It reads only visible text from the exact requested completed assistant message; reasoning, tools, unfinished/error messages are excluded. English text is translated to Spanish; Spanish text is unchanged with zero Ollama calls. The terminal shows both versions and project/session/message IDs with controls escaped visibly, then the session location is rechecked before TTS. It writes a new `.wav`, refuses overwrite, makes no OpenCode prompt, and does not play automatically. Open the WAV with your local player; speech of code literals may sound unnatural.

### Dictate in Spanish; review before sending

```powershell
project-voice-bridge reply --config ./config.json --event-id '<event-id>' --audio ./recording.wav --chat-language en
```

The bilingual sequence is: verify destination -> local Spanish transcription -> **edit Spanish source** -> translate to English (or keep Spanish for `es`) -> **edit final target** -> show both versions, language, full final text and verified destination -> require exact lowercase `yes`. Enter keeps the complete text at either edit; replacements are one line. Spanish chats still get a same-language final-text review. Target corrections are not retranslated. The send boundary rechecks session location and submits exactly the approved target once, without prefixes or further transformations. A submitted prompt does not mean the assistant has completed its turn.

Any other confirmation answer, whitespace-only replacement, EOF or Ctrl+C cancels; redirected/piped reply input or output cannot authorize sending. No `--yes`, automatic send/retry, or automatic response playback exists. A confirmed prompt can be **billable** and can cause agent actions. On uncertain delivery, inspect OpenCode before retrying manually.

Visible assistant text, edited source, translated text, and final corrections must each be nonempty and at most **2,000 Unicode code points** (not bytes or UTF-16 units); there is no truncation or summarization. This conservative limit and the 1,024-token translation generation budget still require near-limit live acceptance. Put commands, identifiers, and paths in backticks (or fenced code blocks) when their exact bytes matter. Cross-language translation masks those literals and restores them only if placeholders survive exactly once and in order; unclosed delimiters or corrupted placeholders fail closed. Unformatted technical prose is not guaranteed exact. Human review remains essential for intent, negation, numbers, and uncertainty; parser checks cannot prove semantic accuracy or prompt-injection immunity.

## Local translation runtime and shared GPU

Ollama must already be running at `http://127.0.0.1:11434`, and Speaches at `http://127.0.0.1:8000`. The CLI never starts/stops services, pulls/downloads translation models, unloads another model, or changes other projects' settings. There is no cloud translator, fallback model, or automatic inference retry. Spanish identity workflows require no running Ollama (config syntax is still validated).

The **preimplementation** probe used Ollama 0.35.0 with local `gemma4:e2b` GGUF Q4_K_M and the digest above. This is historical setup evidence, not a new acceptance of the shipped CLI. Manually install/approve the local runtime/model if missing, outside CLI execution; do not use a cloud tag or silently substitute an updated model. Before cross-language inference the CLI checks `/api/tags` for the exact name and a configured 64-character lowercase hexadecimal digest. A missing/changed digest fails. Revalidate an intentional model update and explicitly update your config; the example digest is not a promise about your installation. Translation uses loopback only, rejects redirects, and sends masked source without conversation history or tools, with context 4,096, temperature 0, `think: false`, a 120-second per-request timeout, and a 1 MiB response cap.

Historical short synthetic probes observed about **14.5 seconds cold** (13.8 seconds loading), versus 0.228–0.495 seconds warm. Expect a cold-start delay, not a latency guarantee. They did not validate near-limit production output or combined voice/translation residency. See [performed/deferred acceptance](docs/validation/2026-10-01-local-bilingual-voice-cli.md).

Translation requests use `keep_alive: '30s'`, not an explicit unload. Normal requests can alter shared Ollama residency/context and compete with another project. Operations within one workflow are sequential; separate CLI invocations can overlap. There is no global GPU scheduler or promise that STT, TTS and translation all fit concurrently in 12 GiB VRAM. Sampled device-total memory is not per-model allocation or an exact peak; Ollama `/api/ps` model memory is distinct. Kokoro CUDA execution remains unverified. Do not evict another project's loaded model to make probes pass or assume CPU fallback proves GPU execution.

### Unicode-safe ad-hoc PowerShell probes (only after separate approval)

The following is guidance, **not a performed probe**. Before any approved inference, inspect shared residency; if another project's model is loaded or ownership is uncertain, coordinate and defer rather than evicting it:

```powershell
Invoke-RestMethod http://127.0.0.1:11434/api/ps
Invoke-RestMethod http://127.0.0.1:11434/api/tags
```

Avoid piping literal accented text through a Windows legacy code page. An ASCII-only Node snippet with Unicode escapes preserves Spanish UTF-8 JSON and uses the production translator checks/settings. This invokes local inference; do not run it without the separate live-probe approval:

```powershell
@'
import { readFileSync } from "node:fs";
import { OllamaTranslator } from "./dist/translation-client.js";
const c = JSON.parse(readFileSync("config.json", "utf8"));
const t = new OllamaTranslator(c.translation);
console.log(await t.translate("No borres el archivo; conserva el n\u00famero y la se\u00f1al.", "es", "en"));
'@ | node --input-type=module
```

For direct HTTP PowerShell requests, encode JSON explicitly with `[System.Text.Encoding]::UTF8.GetBytes($json)` and send those bytes with `application/json; charset=utf-8`, rather than relying on pipeline encoding. Do not send private chat/recordings in ad-hoc probes. Future acceptance must cover both directions, short and near-limit text, backtick literals, listening, cold/warm timing, and sequential/shared memory at actual production settings. If settings fail, stop and revise the approved design/limits rather than claiming acceptance or changing providers.

## Privacy and residual limitations

The bridge SQLite inbox stores event metadata, not audio, assistant text, source transcripts, translations, or new searchable history. Text appears in interactive review; terminal scrollback/capture can retain it. Original recordings stay untouched; explicit output WAVs remain until you remove them. **OpenCode retains confirmed sent messages according to its own storage behavior**; local voice processing does not erase chat retention. No private recording or billable send is approved by running offline tests.

WAV creation is exclusive and partial-output cleanup is best effort. The existing non-atomic stat/inode comparison followed by unlink has a **path-replacement cleanup race**: concurrent replacement can occur between check and deletion. Do not promise absolute concurrent replacement safety; use a fresh output path without competing writers.
