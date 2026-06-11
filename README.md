# iOS Simulator MCP

A [Model Context Protocol](https://modelcontextprotocol.io/) server for interacting with iOS simulators. Lets AI assistants inspect the accessibility tree, tap and type on the screen, take screenshots, record videos, and install or launch apps.

Forked from [joshuayoes/ios-simulator-mcp](https://github.com/joshuayoes/ios-simulator-mcp) and restructured: modular source, automated tests with `bun:test`, bun-based tooling, and bug fixes (device name parsing, recording process tracking, MCP stdio hygiene).

## Prerequisites

- macOS with Xcode and iOS simulators installed
- [Facebook IDB](https://fbidb.io/) available in your PATH ([install guide](docs/TROUBLESHOOTING.md#2-installing-idb))
- Node.js or Bun

## Installation

### Cursor

Add to `~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project):

```json
{
  "mcpServers": {
    "ios-simulator": {
      "command": "bunx",
      "args": ["@yaelg/ios-simulator-mcp"]
    }
  }
}
```

### Claude Code

```bash
claude mcp add ios-simulator -- bunx @yaelg/ios-simulator-mcp
```

`npx @yaelg/ios-simulator-mcp` works the same way if you prefer npm.

## Tools

### See the screen

| Tool | Description |
| --- | --- |
| `ui_snapshot` | Compact list of visible interactive/labeled elements with refs (`e1`, `e2`, ...) and point coordinates |
| `ui_view` | Compressed screenshot returned inline as JPEG, downscaled to point resolution |
| `ui_describe_all` | Raw accessibility tree as JSON (verbose — prefer `ui_snapshot`) |
| `ui_describe_point` | Accessibility element at given coordinates |
| `ui_find_element` | Search the accessibility tree by label, identifier, or type |
| `wait_for_element` | Poll until an element appears (use after navigation instead of sleeping) |

### Act

| Tool | Description |
| --- | --- |
| `ui_tap` | Tap by `ref`, `label`, or x/y coordinates |
| `ui_type` | Input text; pass `ref`/`label` to focus the field first |
| `ui_swipe` | Swipe gesture |
| `open_url` | Open https://, deep links, or exp:// dev-client URLs |
| `expo_launch` | One-call Expo launch: boot + wait for Metro + resolve deep link + open |

### Apps

| Tool | Description |
| --- | --- |
| `install_app` | Install an app bundle (.app or .ipa) |
| `launch_app` | Launch by bundle identifier, returns the PID (EX_UPDATES_* env rejected) |
| `terminate_app` | Terminate a running app |
| `uninstall_app` | Uninstall an app and its data |
| `list_apps` | List installed apps with bundle id, name, and type |
| `app_logs` | Recent console logs (JS errors, crashes) filtered by process |

### Device

| Tool | Description |
| --- | --- |
| `get_booted_sim_id` | Get the booted simulator's UDID (rarely needed — see below) |
| `boot_sim` | Boot a simulator by udid/name and wait until it is actually ready |
| `open_simulator` | Open the iOS Simulator application |
| `set_permissions` | Grant/revoke/reset privacy permissions (camera, location, ...) |
| `push_notification` | Deliver a simulated APNs push |
| `set_location` | Set the simulated GPS location |
| `set_appearance` | Switch light/dark mode |
| `status_bar` | Override time/battery/signal for clean screenshots |
| `cleanup_session` | Reset leftovers from previous sessions: orphaned recordings, temp files, status-bar/location overrides, running apps |

### Media

| Tool | Description |
| --- | --- |
| `screenshot` | Inline downscaled JPEG by default; full-res to file with `output_path` |
| `record_video` | Record video; pass `duration_s` for a self-stopping clip |
| `stop_recording` | Stop an open-ended recording |

All tools accept an optional `udid`; when omitted, the currently booted simulator is used. The server also ships usage instructions via the MCP `initialize` response (including Expo/Metro guidance), which compatible hosts surface to the agent automatically.

### Launching Expo apps

`expo_launch` is the reliable, one-call path for starting an Expo app on the simulator. It:

1. boots a simulator if none is ready (and waits for the real `Booted` state — `simctl boot` returns early),
2. waits for the Metro dev server to respond,
3. asks Metro's `/_expo/open` endpoint for the exact deep link (dev client or Expo Go) instead of guessing the URL scheme, falling back to constructing it from the scheme + host,
4. opens the link with `simctl openurl` (adding `disableOnboarding=1` for dev-client first launch).

It never uses `EX_UPDATES_*` env vars (the source of expo-updates reload loops). Force a runtime with `runtime: "custom"` (dev build) or `"expo"` (Expo Go); point at a non-default server with `metro_url`.

## Configuration

| Environment variable | Effect |
| --- | --- |
| `IOS_SIMULATOR_MCP_FILTERED_TOOLS` | Comma-separated list of tool names to disable (e.g. `record_video,stop_recording`) |
| `IOS_SIMULATOR_MCP_DEFAULT_OUTPUT_DIR` | Directory for relative output paths (default: `~/Downloads`) |
| `IOS_SIMULATOR_MCP_IDB_PATH` | Path to a specific `idb` executable (default: `idb` from PATH) |

## Development

```bash
bun install        # install dependencies
bun test           # run the test suite
bun run lint       # eslint (@antfu/eslint-config)
bun run typecheck  # tsc --noEmit
bun run build      # bundle to dist/ with tsdown
bun run dev        # MCP inspector against src/index.ts
```

Releases follow the `bumpp` flow: `bun run release` bumps the version, tags, and pushes; the [release workflow](.github/workflows/release.yml) publishes to npm.

## Documentation

- [Troubleshooting](docs/TROUBLESHOOTING.md)
- [Security policy](docs/SECURITY.md)
- [Manual QA scenarios](docs/QA.md)

## License

MIT
