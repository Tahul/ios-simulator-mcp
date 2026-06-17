import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import pkg from '../package.json' with { type: 'json' }
import { registerAppTools } from './tools/apps'
import { registerBootTools } from './tools/boot'
import { registerDeviceTools } from './tools/device'
import { registerDiagnosticsTools } from './tools/diagnostics'
import { registerExpoTools } from './tools/expo'
import { registerLogTools } from './tools/logs'
import { registerOrientationTools } from './tools/orientation'
import { registerRecordingTools } from './tools/recording'
import { registerScreenshotTools } from './tools/screenshot'
import { registerSessionTools } from './tools/session'
import { registerSimulatorTools } from './tools/simulator'
import { registerSnapshotTools } from './tools/snapshot'
import { registerUiTools } from './tools/ui'

/**
 * Server-level usage guidance, surfaced to MCP hosts via the initialize
 * response. Hosts render these into the agent's system context.
 */
const INSTRUCTIONS = `iOS Simulator automation. Screen control, input, and the accessibility tree run through a baguette server (HTTP + WebSocket, default http://localhost:8421; override with BAGUETTE_URL). For authenticated/hosted baguette (e.g. https://ios.yael.dev), also set BAGUETTE_TOKEN; REST uses Authorization: Bearer and WebSockets use ?token=. App lifecycle (install/launch/permissions/push/Expo) still uses xcrun simctl.

Workflow:
- If anything misbehaves or at session start, call doctor — it reports baguette/Xcode/simctl/Metro health and how to fix gaps.
- Every tool accepts an optional \`udid\` and defaults to the booted simulator — do not look it up first. To pin a device for the session, call select_default_device once. List devices with list_sims; boot with boot_sim.
- See the screen with ui_snapshot (compact, ref-based, from the accessibility tree) or ui_inspect (snapshot + screenshot in one call), or ui_view for just the image.
- COORDINATES ARE DEVICE POINTS — not pixels, not normalized. The screen size is resolved for you; just pass x/y in points, or (better) target by label/ref so you never compute coordinates.
- Act by passing \`label\` (preferred) or \`ref\` to ui_tap / ui_type. Refs are renumbered by every ui_snapshot, so a reused ref can hit a different element — re-snapshot before reusing one, or target by label.
- Confirm actions in the same call with expect_appears / expect_gone. Otherwise a tap that changes nothing returns a "screen did not change" warning — when you see it (or a ref-reuse warning), re-snapshot and retarget; do NOT repeat the same tap. Use ui_describe_point to check what is at a coordinate.
- Input vocabulary: ui_tap, ui_double_tap, ui_swipe, ui_scroll, ui_type (US-ASCII), ui_key (Enter/Tab/arrows/shortcuts), ui_pinch, ui_pan, and ui_press for hardware/virtual buttons (home/lock/power/volume/action/app-switcher/swipe-to-home/...). Rotate with set_orientation.
- If an input tool fails, recover with MCP tools (ui_snapshot/ui_inspect, boot_sim/select_default_device, doctor). Do NOT switch to shell idb/xcrun coordinate tapping; it bypasses refs, warnings, and recovery.
- After an async load (launch, network navigation), use wait_for_element instead of sleeping and re-describing.
- Debug with app_logs (JS errors, RedBox, native crashes) — do not rely on screenshots alone. Find bundle ids with list_apps; reset an app with reset_app.
- App lifecycle is reuse-first: expo_launch/launch_app foreground a running app WITHOUT rebooting it (pass if_running="restart" or terminate_running to force one). To interact with a running app use ui_* tools, not open_url. set_permissions restarts the target app to apply TCC, so set it before launching. set_appearance/set_orientation/status_bar/set_location/push_notification and every read/input tool never restart the app; terminate_app/uninstall_app/reset_app/shutdown_sim are the only intentionally destructive ones.
- Screenshots/AX need a frame: an idle simulator may emit nothing — send a gesture (e.g. ui_press home) to wake it, then retry.
- Errors include a machine-readable [CODE] and a recovery hint — branch on it.

Expo / React Native:
- To start an Expo app, use expo_launch — it boots a simulator if needed, waits for Metro, resolves the exact deep link, opens it, best-effort dismisses the RN/Expo development menu, and verifies render in one call. Pass runtime="custom" for a dev build, "expo" for Expo Go. It is reuse-by-default: re-calling it does NOT reboot an already-running app (it foregrounds it); pass if_running="restart" to force a fresh launch.
- NEVER pass EX_UPDATES_URL or any EX_UPDATES_* env var to launch_app — it sends expo-updates into a reload loop against Metro. These keys are rejected.
- Only fall back to launch_app/open_url if you specifically need to bypass Metro resolution.`

export function createServer(): McpServer {
  const server = new McpServer(
    {
      name: 'ios-simulator',
      version: pkg.version,
    },
    {
      instructions: INSTRUCTIONS,
    },
  )

  registerSimulatorTools(server)
  registerBootTools(server)
  registerOrientationTools(server)
  registerDiagnosticsTools(server)
  registerExpoTools(server)
  registerUiTools(server)
  registerSnapshotTools(server)
  registerScreenshotTools(server)
  registerRecordingTools(server)
  registerLogTools(server)
  registerAppTools(server)
  registerDeviceTools(server)
  registerSessionTools(server)

  return server
}
