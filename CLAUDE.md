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

Two backends. **baguette** (a running `baguette serve`, HTTP + WebSocket) is the primary backend for everything interactive — screen control, input, the accessibility tree, screenshots, lifecycle, orientation, logs. Configure it with `BAGUETTE_URL`; for authenticated/hosted baguette set `BAGUETTE_TOKEN` (REST uses `Authorization: Bearer`, WS/log sockets append `?token=`). Hosted/versioned URLs such as `https://ios.yael.dev` route through `/api/v1`; local unauthenticated `:8421` keeps the legacy unversioned routes. **simctl/idb** still backs app lifecycle and OS features baguette has no equivalent for (install/launch/permissions/push/location/appearance/status-bar/Expo). idb is optional now (doctor reports it as such); nothing requires it.

- `src/index.ts` — executable entry: creates the server, connects stdio transport, cleans up on exit. stdout is the MCP protocol channel; log to stderr only.
- `src/server.ts` — `createServer()`: registers all tool modules; ships agent-facing usage instructions via the MCP initialize response (point-coordinate model, describe_ui-first, verify-via-re-describe, Expo EX_UPDATES_* guidance).
- `src/lib/baguette.ts` — the baguette client. Base-URL resolution (`BAGUETTE_URL` → `http://localhost:8421`), token resolution (`BAGUETTE_TOKEN` / `BAGUETTE_AUTH_TOKEN`), `/api/v1` vs legacy route selection, and auth placement (Bearer for HTTP, query token for WS). HTTP helpers (`listDevices`, `bootDevice`, `shutdownDevice`, `setOrientation`, `getScreenSize` via versioned `definition.json` or legacy `chrome.json` with a per-UDID cache, `captureScreenshot`). A stream-WS session (`openSession`/`withSession`) that sends fire-and-forget gesture envelopes and does `describe_ui`/`snapshot` request/reply (the stream socket does NOT ack gestures). `collectLogs` reads a bounded batch off the logs WS. Session-default device (`setDefaultDevice`, honored by `resolveBootedUdid`). Test seams: `setFetchImpl`, `setWsSessionFactory`, `setLogCollector`.
- `src/lib/ax.ts` — accessibility tree (`describe_ui`) → compact ref-based snapshot. `buildSnapshot` (skips container roles), `resolveTarget` (x/y | ref | label, with stale-ref reuse warning), `collectLabelMatches`, `fingerprintTree` (no-op detection), and the ref store (`storeRefs`/`resetSnapshotState`). Refs are invalidated by the next snapshot.
- `src/lib/run.ts` — process execution with a `setRunner` test seam, `idb` resolution, hard per-command timeout that SIGKILLs the child (default 30s). Used by the kept simctl tools. `src/lib/devices.ts` — simctl device discovery (`parseDeviceList`, `ensureBooted` for Expo); its default-device store delegates to baguette so both backends resolve the same device. `paths.ts`, `errors.ts` (`ToolError` codes + result builders), `constants.ts` (UDID schema, tool filtering).
- No-hang invariant: every simctl command goes through `run()` (timeout + SIGKILL); every poll loop (`ensureBooted`, `waitForMetro`, `verifyExpectation`, `wait_for_element`, `verifyAppLoaded`) is bounded by an elapsed-time deadline and swallows transient per-iteration failures; all HTTP `fetch` calls use an AbortController timeout; the stream WS request/reply and `collectLogs` are timer-bounded.
- `src/tools/` — one module per tool group. baguette-backed: `simulator` (list_sims/get_booted_sim_id/shutdown_sim/select_default_device), `boot`, `orientation`, `ui` (tap/double_tap/type/key/swipe/scroll/pinch/pan/press/describe_point), `snapshot` (ui_snapshot/ui_inspect/wait_for_element + verifyExpectation/describeTree), `screenshot` (ui_view/screenshot), `logs`. simctl-backed: `apps`, `device`, `expo`, `recording`, `session`, `diagnostics`. Each exports handlers (for tests) and a `registerXxxTools(server)` that honors `IOS_SIMULATOR_MCP_FILTERED_TOOLS`.
- Agent-reliability primitives: machine-readable `ToolError` codes; post-action verification (`expect_appears`/`expect_gone` via `verifyExpectation`) and the screen-unchanged + stale-ref-reuse warnings on `ui_tap`/`ui_type`; refs from `ui_snapshot`. Read tools attach `structuredContent`.
- Coordinates are device points. Gesture tools resolve the screen size (`getScreenSize`) and inject `width`/`height` into every envelope, so the model passes plain x/y (or, preferably, label/ref).
- Expo launches go through `src/tools/expo.ts` (`expo_launch`): `ensureBooted` (simctl) + the Metro client (`src/lib/metro.ts`, `/_expo/open` deep-link resolution with a construction fallback) + `simctl openurl`; the post-launch render/RedBox check uses baguette `describeTree`.
- `test/` — bun:test suite. baguette is stubbed via `setFetchImpl` / `setWsSessionFactory` / `setLogCollector` (see `test/helpers/baguette-mock.ts`); simctl via `setRunner` / `setSpawner`. No real server or simulator needed.

## Design Principles

- **baguette-first**: interactive control goes through the baguette server; only use simctl/idb for what baguette can't do.
- **Security first**: always pass user input through `execFile` argument arrays with a `--` separator (simctl path), validate with Zod.
- **Testable seams, no frameworks**: `setFetchImpl` / `setWsSessionFactory` / `setLogCollector` (baguette) and `setRunner` / `setSpawner` (simctl) are the only injection points.
- **Real use cases only**: don't add hypothetical features.

## Testing

`bun test` covers parsing and handler logic. Integration against a real simulator is manual: build, point an MCP client at `dist/index.js` (or `bun src/index.ts`), and run the scenarios in [docs/QA.md](docs/QA.md).

## Additional Documentation

- [README.md](README.md) — installation, tools, configuration
- [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) — common issues, IDB install help
- [docs/SECURITY.md](docs/SECURITY.md) — security policy
- [docs/QA.md](docs/QA.md) — manual QA scenarios
