import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { isToolFiltered } from '../lib/constants'
import { getBootedDevice, parseDeviceList, resolveTargetDevice, setDefaultDevice } from '../lib/devices'
import { errorResult, textResult } from '../lib/errors'
import { run } from '../lib/run'

export async function getBootedSimIdHandler(): Promise<CallToolResult> {
  try {
    const { id, name } = await getBootedDevice()
    return textResult(`Booted Simulator: "${name}". UUID: "${id}"`, { udid: id, name })
  }
  catch (error) {
    return errorResult('Error', error)
  }
}

export async function openSimulatorHandler(): Promise<CallToolResult> {
  try {
    await run('open', ['-a', 'Simulator.app'])
    return textResult('Simulator.app opened successfully')
  }
  catch (error) {
    return errorResult('Error opening Simulator.app', error)
  }
}

export interface SelectDefaultDeviceParams {
  udid?: string
  name?: string
}

export async function selectDefaultDeviceHandler({ udid, name }: SelectDefaultDeviceParams): Promise<CallToolResult> {
  try {
    if (!udid && !name) {
      setDefaultDevice(null)
      return textResult('Cleared the default device. Tools now use the currently booted simulator.')
    }

    const { stdout } = await run('xcrun', ['simctl', 'list', 'devices', '--json'])
    const device = resolveTargetDevice(parseDeviceList(stdout), { udid, name })
    setDefaultDevice(device.udid)

    return textResult(
      `Default device set to ${device.name} (${device.udid}). Subsequent tools target it unless a udid is passed.`,
      { udid: device.udid, name: device.name },
    )
  }
  catch (error) {
    return errorResult('Error selecting default device', error)
  }
}

export function registerSimulatorTools(server: McpServer): void {
  if (!isToolFiltered('get_booted_sim_id')) {
    server.tool(
      'get_booted_sim_id',
      'Returns the name and UDID of the currently booted iOS simulator. Rarely needed: every other tool already '
      + 'defaults to the booted simulator when udid is omitted — only call this when you must target a specific '
      + 'device among several booted ones.',
      { title: 'Get Booted Simulator ID', readOnlyHint: true, openWorldHint: true },
      getBootedSimIdHandler,
    )
  }

  if (!isToolFiltered('open_simulator')) {
    server.tool(
      'open_simulator',
      'Opens the iOS Simulator application on the host Mac (boots the default device if none is running). '
      + 'Call this first if other tools report "No booted simulator found".',
      { title: 'Open Simulator', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      openSimulatorHandler,
    )
  }

  if (!isToolFiltered('select_default_device')) {
    server.tool(
      'select_default_device',
      'Sets a session default simulator (by udid or name) so subsequent tools target it without passing udid every '
      + 'time — useful when several simulators are booted. Call with no arguments to clear it. The explicit udid '
      + 'argument on individual tools always overrides this default.',
      {
        udid: z.string().optional().describe('UDID of the simulator to make default'),
        name: z.string().optional().describe('Device name to match (e.g. "iPhone 17 Pro")'),
      },
      { title: 'Select Default Device', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      selectDefaultDeviceHandler,
    )
  }
}
