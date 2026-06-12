import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import pkg from '../package.json' with { type: 'json' }
import { registerAppTools } from './tools/apps'
import { registerBootTools } from './tools/boot'
import { registerDeviceTools } from './tools/device'
import { registerDiagnosticsTools } from './tools/diagnostics'
import { registerExpoTools } from './tools/expo'
import { registerFindElementTool } from './tools/find-element'
import { registerLogTools } from './tools/logs'
import { registerRecordingTools } from './tools/recording'
import { registerScreenshotTools } from './tools/screenshot'
import { registerSessionTools } from './tools/session'
import { registerSimulatorTools } from './tools/simulator'
import { registerSnapshotTools } from './tools/snapshot'
import { registerUiTools } from './tools/ui'

/**
 * Server-level usage guidance, surfaced to MCP hosts via the initialize
 * response. Hosts like zidane render these into the agent's system context.
 */
const INSTRUCTIONS = `iOS Simulator automation. Tools wrap \`xcrun simctl\` and Facebook idb.

Workflow:
- If anything is misbehaving or at session start, call doctor — it reports Xcode/idb/simulator/Metro health and how to fix gaps.
- Every tool accepts an optional \`udid\` and defaults to the currently booted simulator — do not call get_booted_sim_id first. To pin a device for the session, call select_default_device once.
- See the screen with ui_snapshot (compact, ref-based) or ui_inspect (snapshot + screenshot in one call). Prefer these over ui_describe_all.
- Act by passing \`ref\` (from the latest ui_snapshot) or \`label\` to ui_tap / ui_type instead of raw coordinates. Pass expect_appears / expect_gone to confirm the action took effect in the same call.
- After navigation or launches, use wait_for_element instead of sleeping and re-describing.
- Debug with app_logs (JS errors, RedBox, native crashes) — do not rely on screenshots alone.
- Find bundle identifiers with list_apps; reset an app to a clean state with reset_app.
- Errors include a machine-readable [CODE] and a recovery hint — branch on it (e.g. NO_BOOTED_SIM -> boot_sim, METRO_UNREACHABLE -> start Metro).

Expo / React Native:
- To start an Expo app, use expo_launch — it boots a simulator if needed, waits for Metro, resolves the exact deep link (dev client or Expo Go) from Metro, and opens it in one call. Pass runtime="custom" for a dev build, "expo" for Expo Go.
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
  registerDiagnosticsTools(server)
  registerExpoTools(server)
  registerUiTools(server)
  registerSnapshotTools(server)
  registerFindElementTool(server)
  registerScreenshotTools(server)
  registerRecordingTools(server)
  registerLogTools(server)
  registerAppTools(server)
  registerDeviceTools(server)
  registerSessionTools(server)

  return server
}
