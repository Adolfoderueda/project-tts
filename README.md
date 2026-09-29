# Project Voice Bridge

Local OpenCode V2 event capture CLI.

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
```

`start` subscribes once to OpenCode V2's global event stream and routes events to configured projects by directory. Captured events are written to the shared SQLite inbox. Press `Ctrl+C` to stop and close the store.

The V2 event stream is live-only: events that occur while the bridge is disconnected are not replayed. The bridge warns when the stream ends or disconnects, then reconnects with backoff; events during the outage may be missed.

## Local Spanish voice service (manual setup)

Install and start Docker Desktop with WSL2 and NVIDIA GPU support. On this Windows machine, if `docker` is not on PATH, add `C:\Program Files\Docker\Docker\resources\bin` to PATH (or reinstall Docker Desktop). Check `docker compose version` before starting. Speaches is pinned by image digest in `deploy/compose.voice.yaml`; do not replace it with a moving upstream Compose download. Docker must be running before issuing these commands from the repository root in PowerShell:

```powershell
.\scripts\voice.ps1 start
.\scripts\voice.ps1 status
.\scripts\voice.ps1 models
.\scripts\voice.ps1 stop
```

`start` and `stop` are explicit; neither Windows nor the Node CLI starts this service automatically. `models` requires a running service at `http://127.0.0.1:8000`, checks its live registry before downloading only `Systran/faster-whisper-small` and `speaches-ai/Kokoro-82M-v1.0-ONNX`, then checks both are installed. Spanish speech uses Kokoro voice `ef_dora`. The first `start` downloads the pinned CUDA image; the first `models` downloads model files and may take several minutes. Allow several GB of free disk space for the image, models, and cache; actual usage varies by image and model revisions. Docker's named volume `voice-model-cache` stores the Hugging Face model cache at `/home/ubuntu/.cache/huggingface/hub` inside the container; list volumes with `docker volume ls --filter name=voice-model-cache` and inspect the matching volume with `docker volume inspect <volume-name>` (Compose adds a project prefix). `stop` retains this volume; do not use `down -v` unless you intend to delete downloaded models.

The service publishes only `127.0.0.1:8000`; it does not send recordings to a hosted speech provider. Docker Desktop/WSL2 and NVIDIA driver support are needed for the GPU reservation. A successful container start alone does not demonstrate GPU inference for every TTS operation; measure actual provider, VRAM, and latency on the target PC before making that claim.
