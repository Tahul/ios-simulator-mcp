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

| Tool | Description |
| --- | --- |
| `get_booted_sim_id` | Get the ID of the currently booted simulator |
| `open_simulator` | Open the iOS Simulator application |
| `ui_describe_all` | Accessibility information for the entire screen |
| `ui_tap` | Tap at coordinates |
| `ui_type` | Input text |
| `ui_swipe` | Swipe gesture |
| `ui_describe_point` | Accessibility element at given coordinates |
| `ui_find_element` | Search the accessibility tree by label, identifier, or type |
| `ui_view` | Compressed screenshot returned inline as JPEG |
| `screenshot` | Save a screenshot to a file |
| `record_video` | Start a video recording |
| `stop_recording` | Stop the active video recording |
| `install_app` | Install an app bundle (.app or .ipa) |
| `launch_app` | Launch an app by bundle identifier |

All UI tools accept an optional `udid`; when omitted, the currently booted simulator is used.

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
