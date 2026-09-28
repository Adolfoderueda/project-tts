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
