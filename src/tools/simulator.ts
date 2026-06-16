import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { listDevices, resolveBootedUdid, setDefaultDevice, shutdownDevice } from '../lib/baguette'
import { isToolFiltered } from '../lib/constants'
import { errorResult, textResult, ToolError } from '../lib/errors'

export async function getBootedSimIdHandler({ udid }: { udid?: string } = {}): Promise<CallToolResult> {
  try {
    const id = await resolveBootedUdid(udid)
    const { running } = await listDevices()
    const device = running.find(d => d.udid === id)
    return textResult(
      `Booted Simulator: "${device?.name ?? 'unknown'}". UDID: "${id}"`,
      { udid: id, name: device?.name ?? null },
    )
  }
  catch (error) {
    return errorResult('Error getting booted simulator id', error)
  }
}

export async function listSimsHandler(): Promise<CallToolResult> {
  try {
    const { running, available } = await listDevices()
    const fmt = (d: { name: string, runtime: string, udid: string }, booted: boolean): string =>
      `${booted ? '● ' : '○ '}${d.name} — ${d.runtime} (${d.udid})`
    const lines = [
      ...running.map(d => fmt(d, true)),
      ...available.filter(a => !running.some(r => r.udid === a.udid)).map(d => fmt(d, false)),
    ]
    return textResult(lines.join('\n') || 'No simulators found.', { running, available })
  }
  catch (error) {
    return errorResult('Error listing simulators', error)
  }
}

export async function shutdownSimHandler({ udid }: { udid?: string }): Promise<CallToolResult> {
  try {
    const actualUdid = await resolveBootedUdid(udid)
    await shutdownDevice(actualUdid)
    return textResult(`Shut down ${actualUdid}.`)
  }
  catch (error) {
    return errorResult('Error shutting down simulator', error)
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
      return textResult('Cleared the default device. Tools now use the booted simulator.')
    }

    const { running, available } = await listDevices()
    const all = [...running, ...available]
    const device = udid
      ? all.find(d => d.udid === udid)
      : all.find(d => d.name.toLowerCase().includes(name!.toLowerCase()))
    if (!device)
      throw new ToolError(`No simulator matching ${udid ?? name}.`, 'DEVICE_NOT_FOUND')

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
  if (!isToolFiltered('list_sims')) {
    server.tool(
      'list_sims',
      'Lists simulators known to baguette (running and available) with name, runtime, and UDID. Use to discover a UDID '
      + 'or check what is booted.',
      {},
      { title: 'List Simulators', readOnlyHint: true, openWorldHint: true },
      listSimsHandler,
    )
  }

  if (!isToolFiltered('get_booted_sim_id')) {
    server.tool(
      'get_booted_sim_id',
      'Returns the name and UDID of the booted simulator. Rarely needed: every other tool already defaults to the '
      + 'booted simulator when udid is omitted — only call this to disambiguate among several.',
      {},
      { title: 'Get Booted Simulator ID', readOnlyHint: true, openWorldHint: true },
      getBootedSimIdHandler,
    )
  }

  if (!isToolFiltered('shutdown_sim')) {
    server.tool(
      'shutdown_sim',
      'Shuts down a booted simulator (defaults to the booted one).',
      { udid: z.string().optional().describe('UDID to shut down (default: booted)') },
      { title: 'Shutdown Simulator', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
      shutdownSimHandler,
    )
  }

  if (!isToolFiltered('select_default_device')) {
    server.tool(
      'select_default_device',
      'Sets a session default simulator (by udid or name) so subsequent tools target it without passing udid every '
      + 'time. Call with no arguments to clear it. An explicit udid argument always overrides this default.',
      {
        udid: z.string().optional().describe('UDID of the simulator to make default'),
        name: z.string().optional().describe('Device name to match (e.g. "iPhone 17 Pro")'),
      },
      { title: 'Select Default Device', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      selectDefaultDeviceHandler,
    )
  }
}
