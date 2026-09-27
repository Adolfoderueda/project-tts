# Project Voice Bridge

Local OpenCode event capture CLI.

## Build

```bash
npm run build
```

The npm bin is `project-voice-bridge` and points to `dist/cli.js`.

## Use

Create a config file like `config.example.json`, then run:

```bash
project-voice-bridge start --config ./config.json
project-voice-bridge events --config ./config.json --limit 20
project-voice-bridge events --config ./config.json --json
```

`start` monitors every configured OpenCode project and writes captured events to the shared SQLite inbox. Press `Ctrl+C` to stop and close the store.
