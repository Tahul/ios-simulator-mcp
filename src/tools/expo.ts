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
import { describeAll } from './snapshot'

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
  verify?: boolean
  verify_timeout_s?: number
}

const DEFAULT_METRO_URL = 'http://localhost:8081'
const EXPO_GO_BUNDLE_ID = 'host.exp.Exponent'

interface RawAxElement {
  AXLabel?: string | null
  type?: string
  children?: RawAxElement[]
}

function flatten(elements: RawAxElement[], out: RawAxElement[] = []): RawAxElement[] {
  for (const el of elements) {
    out.push(el)
    if (el.children)
      flatten(el.children, out)
  }
  return out
}

export type LaunchOutcome = 'loaded' | 'redbox' | 'unconfirmed'

export interface LaunchVerification {
  outcome: LaunchOutcome
  detail: string
}

const VERIFY_POLL_MS = 750

/**
 * After opening the deep link, polls the accessibility tree to decide whether
 * the JS bundle actually rendered (many labeled elements), surfaced a RedBox
 * error overlay, or never confirmed within the timeout. Best-effort — returns
 * an outcome rather than throwing, since the link was already opened.
 */
export async function verifyAppLoaded(udid: string, timeoutMs: number): Promise<LaunchVerification> {
  const start = Date.now()
  let lastCount = 0

  while (true) {
    try {
      const tree = await describeAll(udid)
      const flat = flatten(tree)
      const labels = flat
        .map(e => e.AXLabel?.trim())
        .filter((l): l is string => !!l)

      const redbox = labels.find(l =>
        /redbox/i.test(l)
        || /console was not able to connect/i.test(l)
        || /unable to (?:load|resolve|connect)/i.test(l)
        || (/^(?:error|warning):/i.test(l) && labels.some(x => /reload|dismiss/i.test(x))),
      )
      if (redbox)
        return { outcome: 'redbox', detail: `error overlay detected: "${redbox.slice(0, 120)}"` }

      lastCount = labels.length
      // A loaded RN screen exposes many labeled nodes; an unconnected dev
      // client / blank splash exposes very few.
      if (labels.length >= 5)
        return { outcome: 'loaded', detail: `${labels.length} labeled elements rendered` }
    }
    catch {
      // tree not describable yet — keep polling
    }

    if (Date.now() - start >= timeoutMs)
      return { outcome: 'unconfirmed', detail: `only ${lastCount} labeled elements after ${Math.round(timeoutMs / 1000)}s; check app_logs` }

    await new Promise(resolve => setTimeout(resolve, VERIFY_POLL_MS))
  }
}

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
  verify = true,
  verify_timeout_s = 20,
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

    // 5. Verify the app actually rendered (not just that the link opened)
    let verification = null
    if (verify) {
      verification = await verifyAppLoaded(device.udid, verify_timeout_s * 1000)
      steps.push(`verify: ${verification.outcome}`)
    }

    const headline = verification?.outcome === 'redbox'
      ? `Expo launch opened but the app shows an error on ${device.name}.`
      : verification?.outcome === 'unconfirmed'
        ? `Expo launch opened on ${device.name} but could not confirm the app loaded.`
        : `Expo launch succeeded on ${device.name} (${device.udid}).`

    const reportLines = [
      headline,
      `Deep link: ${finalUrl}`,
      `Steps: ${steps.join(' -> ')}`,
      ...(verification ? [`Verification: ${verification.detail}`] : []),
      'If the app misbehaves, check app_logs (process is your app/Expo Go) for details.',
    ]

    return textResult(
      reportLines.join('\n'),
      {
        udid: device.udid,
        deepLink: finalUrl,
        runtime: link.runtime,
        outcome: verification?.outcome ?? 'opened',
      },
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
        .describe('"default" (the default) lets Metro decide, "custom" forces a dev build, "expo" forces Expo Go'),
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
      verify: z
        .boolean()
        .optional()
        .describe('After opening, poll the screen to confirm the app loaded vs showing a RedBox error (default true)'),
      verify_timeout_s: z
        .number()
        .min(1)
        .max(120)
        .optional()
        .describe('Seconds to wait for the app to render before reporting unconfirmed (default 20)'),
    },
    { title: 'Expo Launch', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    expoLaunchHandler,
  )
}
