# Spanish voice acceptance — 2026-10-01

- Started the pinned Speaches service and verified it publishes only `127.0.0.1:8000`. Both approved models were already installed in the persistent cache; no fresh model download was tested.
- Transcribed a user-supplied Spanish M4A locally with the project's `VoiceClient` in 3,215 ms. The user confirmed the transcript matched their recording. A before/after SHA256 comparison verified the original file was unchanged. Neither the recording nor its transcript is included in this repository.
- The user reported missing `ñ` and accented pronunciation in the initial synthetic listening sample. A diagnostic reproduced Windows PowerShell 5.1's ASCII pipeline replacing these characters with `?` before the Node script executed. This was a sample-generation command issue, not evidence of a production CLI defect.
- Regenerated synthetic speech with Unicode escapes in the diagnostic Node script, checked the speech request retained the intended Unicode text, and played the resulting WAV locally. Generation took 2,008 ms. The user confirmed the corrected voice sounded good.
- No OpenCode prompt was sent. Live confirmed-send and lifecycle-event persistence remain unverified; a potentially billable send still requires separate authorization.
- Remaining limitations from the earlier validation remain: fresh Kokoro CDN download was not retested, Kokoro CUDA execution provider is unverified, startup readiness can require a retry, and partial-output cleanup has a non-atomic replacement race. This acceptance covers this recording and listening sample, not every codec or pronunciation.

For ad-hoc Node scripts piped through Windows PowerShell 5.1, use Unicode escapes or explicitly configure a UTF-8 pipeline. Do not strip Spanish accents or `ñ` to work around an encoding problem.
