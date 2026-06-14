import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { listDevices, resolveBaseUrls } from '../lib/baguette'
import { isToolFiltered } from '../lib/constants'
import { parseDeviceList } from '../lib/devices'
import { textResult } from '../lib/errors'
import { normalizeMetroUrl, waitForMetro } from '../lib/metro'
import { resolveIdbPath, run } from '../lib/run'

interface Check {
  name: string
  ok: boolean
  detail: string
}

async function tryRun(cmd: string, args: string[]): Promise<{ ok: boolean, out: string }> {
  try {
    const { stdout, stderr } = await run(cmd, args)
    return { ok: true, out: (stdout || stderr).split('\n')[0] ?? '' }
  }
  catch (error) {
    return { ok: false, out: (error as Error).message.split('\n')[0] ?? '' }
  }
}

export interface DoctorParams {
  metro_url?: string
}

/**
 * One-call environment preflight: surfaces exactly what an Expo/simulator
 * automation session needs (Xcode, idb, runtimes, booted devices, Metro) so
 * an agent or human can fix the environment before acting.
 */
export async function doctorHandler({ metro_url }: DoctorParams): Promise<CallToolResult> {
  const checks: Check[] = []

  const xcode = await tryRun('xcode-select', ['-p'])
  checks.push({ name: 'Xcode', ok: xcode.ok, detail: xcode.out })

  const simctl = await tryRun('xcrun', ['simctl', 'help'])
  checks.push({ name: 'simctl', ok: simctl.ok, detail: simctl.ok ? 'available' : simctl.out })

  // baguette server — the primary backend for screen control + input.
  let baguetteOk = false
  let baguetteDetail = ''
  const bases = resolveBaseUrls()
  try {
    const { running, available } = await listDevices()
    baguetteOk = true
    baguetteDetail = `reachable (${running.length} booted, ${available.length} available)`
  }
  catch (error) {
    baguetteDetail = `unreachable at ${bases.join(', ')}: ${(error as Error).message.split('\n')[0]}`
  }
  checks.push({ name: 'baguette', ok: baguetteOk, detail: baguetteDetail })

  // idb is optional now (only a legacy fallback); report but never block.
  let idbDetail = ''
  let idbOk = false
  try {
    const idbPath = resolveIdbPath()
    const probe = await tryRun(idbPath, ['--help'])
    idbOk = probe.ok
    idbDetail = probe.ok ? `available (${idbPath})` : `optional — not found (${probe.out})`
  }
  catch (error) {
    idbDetail = `optional — ${(error as Error).message}`
  }
  checks.push({ name: 'idb (optional)', ok: idbOk, detail: idbDetail })

  // Runtimes + devices
  let bootedSummary = 'none'
  let deviceLines: string[] = []
  const devicesRun = await tryRun('xcrun', ['simctl', 'list', 'devices', '--json'])
  if (devicesRun.ok) {
    // tryRun only kept the first line; re-run for full JSON
    try {
      const { stdout } = await run('xcrun', ['simctl', 'list', 'devices', '--json'])
      const devices = parseDeviceList(stdout)
      const booted = devices.filter(d => d.state === 'Booted')
      const available = devices.filter(d => d.isAvailable)
      bootedSummary = booted.length > 0
        ? booted.map(d => `${d.name} (${d.udid})`).join(', ')
        : 'none'
      deviceLines = available.slice(0, 8).map(d => `${d.state === 'Booted' ? '● ' : '○ '}${d.name} (${d.udid})`)
      checks.push({ name: 'Simulators', ok: available.length > 0, detail: `${available.length} available, ${booted.length} booted` })
    }
    catch (error) {
      checks.push({ name: 'Simulators', ok: false, detail: (error as Error).message })
    }
  }
  else {
    checks.push({ name: 'Simulators', ok: false, detail: devicesRun.out })
  }

  // Metro (optional; only a warning if down)
  const metroUrl = normalizeMetroUrl(metro_url ?? 'http://localhost:8081')
  let metroOk = false
  try {
    await waitForMetro(metroUrl, { timeoutMs: 1500, intervalMs: 500 })
    metroOk = true
  }
  catch {
    metroOk = false
  }

  const lines = checks.map(c => `${c.ok ? '✓' : '✗'} ${c.name}: ${c.detail}`)
  lines.push(`${metroOk ? '✓' : '○'} Metro (${metroUrl}): ${metroOk ? 'reachable' : 'not running (only needed for Expo)'}`)
  lines.push(`Booted: ${bootedSummary}`)
  if (deviceLines.length > 0)
    lines.push('', 'Available simulators:', ...deviceLines)

  const blocking = checks
    .filter(c => !c.ok && c.name !== 'Simulators' && !c.name.includes('optional'))
    .map(c => c.name)
  const summary = blocking.length === 0
    ? 'Environment looks healthy.'
    : `Problems with: ${blocking.join(', ')}. See the troubleshooting guide.`

  return textResult(
    `${summary}\n\n${lines.join('\n')}`,
    {
      healthy: blocking.length === 0,
      checks: checks.map(c => ({ name: c.name, ok: c.ok, detail: c.detail })),
      metro: { url: metroUrl, reachable: metroOk },
      booted: bootedSummary === 'none' ? [] : bootedSummary.split(', '),
    },
  )
}

export function registerDiagnosticsTools(server: McpServer): void {
  if (isToolFiltered('doctor'))
    return

  server.tool(
    'doctor',
    'Preflight check of the automation environment: Xcode, simctl, the baguette server (the screen-control + input '
    + 'backend), available and booted simulators, optional idb, and whether Metro is reachable. Call this first when '
    + 'something is not working, or at the start of a session — it reports exactly what is missing and how to fix it.',
    {
      metro_url: z.string().max(2048).optional().describe('Metro URL to probe (default http://localhost:8081)'),
    },
    { title: 'Doctor', readOnlyHint: true, openWorldHint: true },
    doctorHandler,
  )
}
