import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { isToolFiltered } from '../lib/constants'
import { ensureBooted } from '../lib/devices'
import { errorResult, textResult } from '../lib/errors'
import {
  normalizeMetroUrl,
  resolveDeepLink,
  waitForMetro,
  withDisableOnboarding,
} from '../lib/metro'
import { run } from '../lib/run'

export interface ExpoLaunchParams {
  udid?: string
  device_name?: string
  metro_url?: string
  runtime?: 'default' | 'expo' | 'custom'
  scheme?: string
  wait_for_metro?: boolean
  metro_timeout_s?: number
  clean?: boolean
  bundle_id?: string
}

const DEFAULT_METRO_URL = 'http://localhost:8081'
const EXPO_GO_BUNDLE_ID = 'host.exp.Exponent'

/**
 * Resolves which app to terminate for a cold start. Expo Go has a fixed
 * bundle id; for a dev client we derive it from the scheme (exp+slug ->
 * the project's bundle id is not the scheme, so this only handles the
 * explicit override and Expo Go). Returns null when it can't be determined.
 */
function resolveCleanBundleId(
  link: { runtime: 'expo' | 'custom' | 'unknown' },
  explicit?: string,
): string | null {
  if (explicit)
    return explicit
  if (link.runtime === 'expo')
    return EXPO_GO_BUNDLE_ID
  return null
}

/**
 * One-shot, deterministic Expo launch on the iOS Simulator. Sequence:
 *   1. ensure a simulator is booted and ready (boots + polls if needed),
 *   2. wait for the Metro dev server to respond,
 *   3. ask Metro's /_expo/open for the exact deep link (dev-client or Expo Go),
 *      falling back to constructing it from scheme + host,
 *   4. open the link via simctl openurl.
 *
 * Avoids the EX_UPDATES_* env footgun entirely by driving the app through
 * the same deep link the Expo CLI would use.
 */
export async function expoLaunchHandler({
  udid,
  device_name,
  metro_url,
  runtime = 'default',
  scheme,
  wait_for_metro = true,
  metro_timeout_s = 30,
  clean = true,
  bundle_id,
}: ExpoLaunchParams): Promise<CallToolResult> {
  const steps: string[] = []
  try {
    const metroUrl = normalizeMetroUrl(metro_url ?? DEFAULT_METRO_URL)

    // 1. Simulator ready
    const { device, alreadyBooted } = await ensureBooted({ udid, name: device_name })
    steps.push(alreadyBooted
      ? `simulator ready: ${device.name}`
      : `booted simulator: ${device.name}`)

    // Make sure the Simulator window is visible so openurl has a target UI.
    try {
      await run('open', ['-a', 'Simulator.app'])
    }
    catch {
      // non-fatal
    }

    // 2. Metro reachable
    if (wait_for_metro) {
      await waitForMetro(metroUrl, { timeoutMs: metro_timeout_s * 1000 })
      steps.push(`metro reachable at ${metroUrl}`)
    }

    // 3. Resolve the exact deep link
    const link = await resolveDeepLink({ metroUrl, runtime, scheme })
    const finalUrl = withDisableOnboarding(link)
    steps.push(`resolved ${link.runtime} link via ${link.source}`)

    // 3b. Cold start: terminate the host app so no stale JS state or
    // leftover error overlay carries into the new session. Best-effort —
    // terminating an app that isn't running is not an error here.
    if (clean) {
      const cleanTarget = resolveCleanBundleId(link, bundle_id)
      if (cleanTarget) {
        try {
          await run('xcrun', ['simctl', 'terminate', device.udid, cleanTarget])
          steps.push(`terminated ${cleanTarget} for clean start`)
        }
        catch {
          // app wasn't running — already clean
          steps.push(`clean start: ${cleanTarget} not running`)
        }
      }
      else {
        steps.push('clean start: skipped (pass bundle_id for a dev client)')
      }
    }

    // 4. Open it
    await run('xcrun', ['simctl', 'openurl', device.udid, '--', finalUrl])
    steps.push('opened deep link')

    return textResult(
      `Expo launch succeeded on ${device.name} (${device.udid}).\n`
      + `Deep link: ${finalUrl}\n`
      + `Steps: ${steps.join(' -> ')}\n`
      + `If the app does not appear, check app_logs (process is your app/Expo Go) for a Metro connection error.`,
    )
  }
  catch (error) {
    return errorResult(
      `Error launching Expo app (completed: ${steps.join(' -> ') || 'none'})`,
      error,
      'Verify Metro is running (`npx expo start`), the dev build/Expo Go is installed on the simulator, '
      + 'and for a dev client pass runtime="custom". For a specific Metro instance set metro_url.',
    )
  }
}

export function registerExpoTools(server: McpServer): void {
  if (isToolFiltered('expo_launch'))
    return

  server.tool(
    'expo_launch',
    'Reliably opens an Expo app on the iOS Simulator in one call. Boots a simulator if needed and waits until it is '
    + 'ready, waits for the Metro dev server, asks Metro for the exact deep link (dev client or Expo Go — no scheme '
    + 'guessing), and opens it. This is the preferred way to start an Expo app: it is deterministic and never uses '
    + 'EX_UPDATES_* env vars. Use runtime="custom" to force a development build, "expo" to force Expo Go. '
    + 'By default does a clean (cold) start by terminating the host app first so no stale JS state or error overlay '
    + 'carries over; for a dev client pass bundle_id so it knows which app to terminate. '
    + 'Note: the in-app Expo dev menu (Cmd+D) cannot be toggled via simctl/idb and does not auto-open after a deep-link '
    + 'launch. Defaults to Metro at http://localhost:8081.',
    {
      udid: z.string().optional().describe('Specific simulator UDID (default: booted, else first available)'),
      device_name: z.string().optional().describe('Boot/select a simulator by name (e.g. "iPhone 17 Pro")'),
      metro_url: z.string().max(2048).optional().describe('Metro dev server URL (default http://localhost:8081)'),
      runtime: z
        .enum(['default', 'expo', 'custom'])
        .optional()
        .describe('"default" lets Metro decide, "custom" forces a dev build, "expo" forces Expo Go'),
      scheme: z
        .string()
        .max(256)
        .optional()
        .describe('Project URL scheme (e.g. exp+your-slug), only used if Metro cannot be reached to resolve it'),
      wait_for_metro: z.boolean().optional().describe('Wait for the Metro dev server before opening (default true)'),
      metro_timeout_s: z.number().min(1).max(180).optional().describe('Seconds to wait for Metro (default 30)'),
      clean: z
        .boolean()
        .optional()
        .describe('Cold start: terminate the host app before opening so no stale state/overlay carries over (default true)'),
      bundle_id: z
        .string()
        .max(256)
        .optional()
        .describe('Host app bundle id to terminate for a clean start (defaults to Expo Go; required to clean-start a dev client)'),
    },
    { title: 'Expo Launch', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    expoLaunchHandler,
  )
}
