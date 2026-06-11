import { run } from './run'

export interface BootedDevice {
  id: string
  name: string
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
