import { run } from './run'

export interface BootedDevice {
  id: string
  name: string
}

export interface SimDevice {
  udid: string
  name: string
  state: string
  isAvailable: boolean
}

interface SimctlDevice {
  udid?: string
  name?: string
  state?: string
  isAvailable?: boolean
}

/**
 * Parses `xcrun simctl list devices --json` output and returns the first
 * booted device. JSON parsing is robust to device names containing
 * parentheses (e.g. "iPad Pro (12.9-inch)").
 */
export function parseBootedDevice(json: string): BootedDevice {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  }
  catch {
    throw new Error('Failed to parse simctl device list: invalid JSON')
  }

  const devices = (parsed as { devices?: Record<string, SimctlDevice[]> }).devices ?? {}

  const available: string[] = []
  for (const runtimeDevices of Object.values(devices)) {
    for (const device of runtimeDevices) {
      if (device.state === 'Booted' && device.udid && device.name)
        return { id: device.udid, name: device.name }
      if (device.isAvailable && device.udid && device.name)
        available.push(`${device.name} (${device.udid})`)
    }
  }

  // List bootable devices so an agent can recover in one step instead of
  // guessing UDIDs. Note: a window showing a physical iPhone (iPhone
  // Mirroring) is not a simulator and cannot be targeted.
  const suggestion = available.length > 0
    ? ` Available simulators (all shutdown): ${available.slice(0, 5).join(', ')}${available.length > 5 ? ', …' : ''}. Boot one with open_simulator, or \`xcrun simctl boot <udid>\` for a specific device.`
    : ''
  throw new Error(`No booted simulator found.${suggestion}`)
}

export async function getBootedDevice(): Promise<BootedDevice> {
  const { stdout } = await run('xcrun', ['simctl', 'list', 'devices', '--json'])
  return parseBootedDevice(stdout)
}

/** Returns the provided device id, or falls back to the currently booted simulator. */
export async function getBootedDeviceId(deviceId?: string): Promise<string> {
  if (deviceId)
    return deviceId

  const { id } = await getBootedDevice()
  return id
}

/** Flattens `simctl list devices --json` into available devices across runtimes. */
export function parseDeviceList(json: string): SimDevice[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  }
  catch {
    throw new Error('Failed to parse simctl device list: invalid JSON')
  }

  const devices = (parsed as { devices?: Record<string, SimctlDevice[]> }).devices ?? {}
  const result: SimDevice[] = []
  for (const runtimeDevices of Object.values(devices)) {
    for (const device of runtimeDevices) {
      if (device.udid && device.name) {
        result.push({
          udid: device.udid,
          name: device.name,
          state: device.state ?? 'Unknown',
          isAvailable: device.isAvailable ?? false,
        })
      }
    }
  }
  return result
}

/**
 * Resolves a target simulator from an explicit udid, a device name, or
 * "first available booted, else first available device". Throws with a
 * helpful list when nothing matches.
 */
export function resolveTargetDevice(
  devices: SimDevice[],
  selector?: { udid?: string, name?: string },
): SimDevice {
  const available = devices.filter(d => d.isAvailable)

  if (selector?.udid) {
    const match = devices.find(d => d.udid === selector.udid)
    if (!match)
      throw new Error(`No simulator with udid ${selector.udid}.${listSuggestion(available)}`)
    return match
  }

  if (selector?.name) {
    const needle = selector.name.toLowerCase()
    // Prefer an already-booted match, then an exact name, then substring.
    const matches = available.filter(d => d.name.toLowerCase().includes(needle))
    const chosen
      = matches.find(d => d.state === 'Booted')
        ?? matches.find(d => d.name.toLowerCase() === needle)
        ?? matches[0]
    if (!chosen)
      throw new Error(`No available simulator matching "${selector.name}".${listSuggestion(available)}`)
    return chosen
  }

  const booted = available.find(d => d.state === 'Booted')
  if (booted)
    return booted

  const first = available[0]
  if (!first)
    throw new Error('No available simulators found. Create one in Xcode (Window > Devices and Simulators).')
  return first
}

function listSuggestion(available: SimDevice[]): string {
  if (available.length === 0)
    return ''
  const names = available.slice(0, 6).map(d => `${d.name} (${d.udid})`)
  return ` Available: ${names.join(', ')}${available.length > 6 ? ', …' : ''}.`
}

async function listDevices(): Promise<SimDevice[]> {
  const { stdout } = await run('xcrun', ['simctl', 'list', 'devices', '--json'])
  return parseDeviceList(stdout)
}

export interface EnsureBootedResult {
  device: SimDevice
  alreadyBooted: boolean
}

const BOOT_POLL_INTERVAL_MS = 500

/**
 * Ensures a simulator is booted and ready. Boots the resolved device if
 * needed and polls until its state is "Booted" (simctl boot returns before
 * the device is usable). Idempotent: an already-booted device returns fast.
 */
export async function ensureBooted(
  selector?: { udid?: string, name?: string },
  { timeoutMs = 60000 }: { timeoutMs?: number } = {},
): Promise<EnsureBootedResult> {
  const target = resolveTargetDevice(await listDevices(), selector)

  if (target.state === 'Booted')
    return { device: target, alreadyBooted: true }

  // `simctl boot` errors if the device is already booting/booted; tolerate that.
  try {
    await run('xcrun', ['simctl', 'boot', target.udid])
  }
  catch (error) {
    const message = (error as Error).message ?? ''
    if (!/current state: Boot/i.test(message) && !/Unable to boot device in current state/i.test(message))
      throw error
  }

  const start = Date.now()
  while (true) {
    const device = resolveTargetDevice(await listDevices(), { udid: target.udid })
    if (device.state === 'Booted')
      return { device, alreadyBooted: false }

    if (Date.now() - start >= timeoutMs)
      throw new Error(`Simulator "${target.name}" did not reach Booted state within ${Math.round(timeoutMs / 1000)}s (current: ${device.state}).`)

    await new Promise(resolve => setTimeout(resolve, BOOT_POLL_INTERVAL_MS))
  }
}
