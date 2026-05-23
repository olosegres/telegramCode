#!/usr/bin/env node

// Kept as a thin shim for backwards compatibility with older `yarn start`
// invocations and any external scripts that still point at `dist/index.js`.
// All real entrypoint logic — DNS fix, env loading, subcommand dispatch —
// lives in `./cli.ts`, which is the `bin` target as of the iter-1 CLI
// wrapper (`agent/tasks/actual/2026-05-16-telegramcode-cli-wrapper.md`).
import './cli';
