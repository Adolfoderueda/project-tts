# Final review fix report

## Scope and verified root causes

Starting HEAD: `a31e17f`; working tree initially clean. Read `final-fix-brief.md` before investigating.

1. `TranslationError` already produced content-free diagnostics for invalid text, malformed literals, model/digest failures, and local response failures, but carried no separate trusted category. `runReply` fell back to `safeReplyDiagnostic`; `runSpeakResponse` discarded every exception in a bare catch. Both therefore hid actionable backtick correction guidance.
2. `OllamaTranslator.request` combined non-success HTTP status and absent-body checks into an immediate throw. Non-success response bodies were not cancelled. Successful response streaming already had size-bound cancellation; that unrelated behavior was left intact.

## Changes and files

- `src/translation-client.ts`: record constructor-established categories in a module-private WeakMap; expose a diagnostic mapper that selects existing fixed strings without reading `error.message`, public category properties, or causes. Forged names/prototypes are not sufficient to establish provenance. On non-success status, await optional body cancellation in a local try/catch before throwing the same sanitized translation failure. Never read the error body or retry.
- `src/cli.ts`: apply this mapper only for bilingual reply; preserve legacy diagnostics and generic delivery-uncertainty fallback.
- `src/cli-responses.ts`: apply this mapper to speech failures, retaining the existing generic fallback for arbitrary exceptions.
- `tests/cli.test.ts`: actual translator regressions for unclosed inline literals and multiline fences, four modified-message category cases, and forged-name/prototype privacy cases. Widen the existing translator-factory mock to its declared dependency interface so it can return the real translator.
- `tests/cli-responses.test.ts`: corresponding malformed-literal, category/message-mutation, forged-error, no-TTS/no-WAV/privacy cases.
- `tests/translation-client.test.ts`: non-success tags/chat stream cancellation, both resolving and rejecting cancellation, with secret-bearing body and cancellation rejection; assert sanitized failure, no reader acquisition, no cause, and exact request counts.
- This report only; no unrelated files changed.

## Red evidence (before production edits)

Command:

```text
npm test -- --run tests/translation-client.test.ts tests/cli.test.ts tests/cli-responses.test.ts
```

Observed exit 1 at 11:29:33:

```text
Test Files 3 failed (3)
Tests 16 failed | 142 passed (158)
```

- Four cancellation cases failed with `expected +0 to be 1` (body cancellation count was zero).
- Two actual malformed-literal cases in each CLI flow failed because generic reply/speech text did not match correction/backtick/try-again guidance.
- Four trusted categories in each CLI flow, with messages replaced by `PRIVATE_TEXT Bearer secret-token`, failed because generic text did not match the corresponding corrective diagnostic.
- These were assertion failures at the intended missing behaviors, not setup or import failures. All existing focused tests passed.

## Green evidence and verification history

First expanded focused run at 11:29:54:

```text
npm test -- --run tests/translation-client.test.ts tests/cli.test.ts tests/cli-responses.test.ts tests/bilingual-reply.test.ts tests/response-speech.test.ts
Test Files 5 passed (5)
Tests 179 passed (179)
```

The subsequent `npm run typecheck` initially exited 1: `tests/cli.test.ts(37,40): TS2345`, because the existing factory mock inferred a return type requiring a Vitest mock method rather than the Translator interface. Corrected only that test declaration. Added four supplementary forged-error characterization/privacy tests; these passed immediately against the hardened mapping (not claimed as additional red tests).

Final verification sequence, with exit-code guards between test/typecheck/build commands, at 11:30:31 onward:

```text
npm test -- --run tests/translation-client.test.ts tests/cli.test.ts tests/cli-responses.test.ts tests/bilingual-reply.test.ts tests/response-speech.test.ts
Test Files 5 passed (5)
Tests 183 passed (183)

npm test -- --run
Test Files 26 passed (26)
Tests 461 passed (461)

npm run typecheck
tsc --noEmit

npm run build
tsc -p tsconfig.build.json

git diff --check
```

Final tests, typecheck, build, and diff whitespace check all exited 0. No failing/skipped tests or runtime warnings were reported by the final test commands. Git emitted repository line-ending notices (`LF will be replaced by CRLF`) for edited files; no whitespace errors. The initial npm invocation also printed an npm upgrade notice; no upgrade was performed.

## Self-review

- Diagnostics use existing fixed content-free text selected through constructor provenance, never arbitrary exception text. Mutating a real error message preserves correct guidance; forged `name`, public `reason`, or prototype produces the generic fallback.
- Both malformed delimiter cases exercise real masking/translator code beneath the CLI, not a stubbed diagnostic generator. They fail before any HTTP; reply sends nothing, speech performs no TTS and creates no WAV. Store/prompt cleanup remains covered.
- Reply intentionally still displays user text in its interactive review; privacy assertions target failure diagnostics. Speech malformed-literal cases never reach the preview and additionally assert no private stdout content.
- HTTP cancellation is attempted once before reporting failure at either request stage. Rejection is swallowed locally, without message/cause leakage; request counts prove no retries or inference after a metadata failure. No reader is acquired for an error response.
- Legacy reply diagnostics, identity bypass, literal byte preservation, explicit final confirmation/single-send, WAV behavior, model/digest validation, loopback URL, redirect policy, request parameters, and timeouts were not changed. Existing full-suite tests cover those boundaries.
- Mutation check: removing cancellation breaks four regressions; reverting either CLI mapper breaks its six red cases; switching to message passthrough breaks modified-message privacy assertions; trusting a public category/prototype breaks forged-error fallback assertions.
- Reviewed the production diff and scoped file status after final verification. Artifact directory is ignored by Git, so only this requested report is explicitly force-staged, not the other artifacts.

## Remaining concerns / assumptions

- No known unresolved issue in the assigned findings. Cancellation is best-effort: the underlying transport can reject cleanup; this must not supersede the sanitized failure. No new cancellation deadline or retry policy was introduced.
- Trusted mapping applies to this module's constructor-established error instances; arbitrary adapters and errors from other module instances retain generic fallback, intentionally.
- No live service validation, human terminal prompting, downloads, dependency upgrades, subagents, external configuration changes, merge, or push were performed. CLI interaction in tests uses the existing in-process terminal adapters and mocked external boundaries.
