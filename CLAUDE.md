# CLAUDE.md

This file provides guidance to AI coding agents working in this repository.

## Project Overview

iOS Simulator MCP (`@yaelg/ios-simulator-mcp`) — a Model Context Protocol server that lets AI assistants interact with iOS simulators by wrapping `xcrun simctl` and Facebook's `idb`.

## Commands

```bash
bun install        # install dependencies
bun test           # run the bun:test suite (test/)
bun run lint       # eslint (@antfu/eslint-config)
bun run lint:fix   # eslint with autofix
bun run typecheck  # tsc --noEmit
bun run build      # bundle to dist/ with tsdown
bun run dev        # MCP inspector against src/index.ts
```

## Architecture

- `src/index.ts` — executable entry: creates the server, connects stdio transport, cleans up on exit. stdout is the MCP protocol channel; log to stderr only.
- `src/server.ts` — `createServer()`: registers all tool modules.
- `src/lib/` — shared helpers: `run.ts` (process execution with a `setRunner` test seam, `idb` resolution), `devices.ts` (booted-device discovery via `simctl list devices --json`), `paths.ts` (path expansion, temp dir), `errors.ts` (tool result builders), `constants.ts` (UDID schema, tool filtering).
- `src/tools/` — one module per tool group (`simulator`, `ui`, `snapshot`, `find-element`, `screenshot`, `recording`, `logs`, `apps`, `device`). Each exports its handlers (for tests) and a `registerXxxTools(server)` function that honors `IOS_SIMULATOR_MCP_FILTERED_TOOLS`.
- `src/tools/snapshot.ts` also owns the ref system: `ui_snapshot` assigns short refs (e1, e2, ...) to visible elements; `ui_tap`/`ui_type` resolve `ref`/`label` targets through `resolveTarget`. Refs are invalidated by the next snapshot.
- `src/server.ts` ships agent-facing usage instructions (incl. Expo EX_UPDATES_* guidance) via the MCP initialize response; `buildLaunchArgs` rejects EX_UPDATES_* env keys.
- Expo launches go through `src/tools/expo.ts` (`expo_launch`), which orchestrates `ensureBooted` ([src/lib/devices.ts](src/lib/devices.ts), boots + polls for the real Booted state) and the Metro client ([src/lib/metro.ts](src/lib/metro.ts), `/_expo/open` deep-link resolution with a construction fallback). `boot_sim` ([src/tools/boot.ts](src/tools/boot.ts)) exposes booting standalone. Both Metro fetch and the exec layer have test seams (`fetchImpl`, `setRunner`).
- `test/` — bun:test suite. Process execution is stubbed via `setRunner` / `setSpawner`; no simulator needed.

## Design Principles

- **Security first**: always pass user input through `execFile` argument arrays with a `--` separator, validate with Zod.
- **Testable seams, no frameworks**: `setRunner` / `setSpawner` are the only injection points.
- **Real use cases only**: don't add hypothetical features.

## Testing

`bun test` covers parsing and handler logic. Integration against a real simulator is manual: build, point an MCP client at `dist/index.js` (or `bun src/index.ts`), and run the scenarios in [docs/QA.md](docs/QA.md).

## Additional Documentation

- [README.md](README.md) — installation, tools, configuration
- [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) — common issues, IDB install help
- [docs/SECURITY.md](docs/SECURITY.md) — security policy
- [docs/QA.md](docs/QA.md) — manual QA scenarios
