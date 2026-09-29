# Task 2 report — exact event selection and visible IDs

## What changed

- Added `EventStore.get(id)` using an exact parameterized event-ID query; missing IDs return `undefined`. The existing row mapping is shared with `list` and the schema is unchanged.
- Added `selectEvent(store, projects, id)` to reject unknown IDs and stored project identities whose configured ID or name no longer matches. It does not look up events by session, does not fall back to the newest event, and does not verify session directory (reserved for the later reply flow).
- Added event ID beside the session ID in human-readable `events` rows. The JSON output branch is unchanged.

## TDD evidence

- RED: `npm test -- --run tests/store.test.ts tests/event-selection.test.ts tests/cli.test.ts` exited 1. Selection suite could not import the absent module; store test failed with `store.get is not a function`; CLI test did not find `event-0` alongside `session-0`. The store test also caused a Windows `EBUSY` cleanup error because failure skipped `close`, corrected in the test with `finally` before production changes.
- GREEN: Same focused command exited 0: 3 files, 19 tests passed.

## Verification

- `npm test -- --run`: 9 files, 56 tests passed, exit 0.
- `npm run typecheck`: exit 0.
- `npm run build`: exit 0.
- `git diff --check`: exit 0 (Git reported only LF-to-CRLF working-tree warnings).

## Self-review and risks

- Reviewed changed files against the task brief: exact ID lookup, duplicate session IDs, removed/renamed/reused project ID rejection, readable ID, and unchanged JSON branch. No speech or prompt calls added.
- Selection checks stored project ID and name, not project directory or live session identity; later task must verify the session's directory independently before any send. No live OpenCode prompts or hosted speech were used.
