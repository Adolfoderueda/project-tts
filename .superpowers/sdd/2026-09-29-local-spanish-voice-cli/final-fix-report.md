# Final fix wave — 2026-09-29

Status: **non-billable synthetic voice smoke passed, with remaining acceptance gaps**. Exact commands, timings, GPU samples, startup/download failure and cache-assisted recovery are in `docs/validation/2026-09-29-local-spanish-voice-cli.md`.

- Added tests for selected-event status, M4A multipart bytes/MIME/filename, and default OpenCode service discovery plus auth-header forwarding (mocked, no prompt).
- Corrected README codec-error promise; documented that speech-output inode check is best-effort and not atomic rather than falsely guaranteeing replacement safety.
- Pinned localhost container started, installed approved Whisper Small normally and restored *approved* Kokoro model cache from a read-only existing probe volume after CDN DNS failure; verified `/v1/models`, Spanish synthetic WAV and AAC M4A transcription, locally decodable WAV output, sampled latency and GPU memory/utilization, then stopped the container. No user recordings or OpenCode prompts were used; neither cache volume was removed.
- Verification: focused suite 37/37, full suite 133/133, typecheck, build, and `git diff --check` all passed. Residual risks: first-run Kokoro download DNS failure, readiness race, human playback/recording untested, GPU TTS provider unproven, no live event/prompt, and non-atomic output cleanup race.
