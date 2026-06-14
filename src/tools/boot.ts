import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { bootDevice, listDevices } from '../lib/baguette'
import { isToolFiltered } from '../lib/constants'
import { errorResult, textResult, ToolError } from '../lib/errors'

export interface BootSimParams {
  udid?: string
  name?: string
}

/** Resolves a target device from the baguette device list by udid or name. */
async function resolveDevice(udid?: string, name?: string): Promise<{ udid: string, name: string, alreadyBooted: boolean }> {
  const { running, available } = await listDevices()
  const all = [...running, ...available]

  if (udid) {
    const match = all.find(d => d.udid === udid)
    if (!match)
      throw new ToolError(`No simulator with udid ${udid}.`, 'DEVICE_NOT_FOUND')
    return { udid: match.udid, name: match.name, alreadyBooted: running.some(d => d.udid === udid) }
  }

  if (name) {
    const match = all.find(d => d.name.toLowerCase().includes(name.toLowerCase()))
    if (!match)
      throw new ToolError(`No simulator matching name "${name}".`, 'DEVICE_NOT_FOUND')
    return { udid: match.udid, name: match.name, alreadyBooted: running.some(d => d.udid === match.udid) }
  }

  // No selector: prefer an already-running device, else the first available.
  const target = running[0] ?? available[0]
  if (!target)
    throw new ToolError('No simulators available to boot.', 'DEVICE_NOT_FOUND')
  return { udid: target.udid, name: target.name, alreadyBooted: running.some(d => d.udid === target.udid) }
}

export async function bootSimHandler({ udid, name }: BootSimParams): Promise<CallToolResult> {
  try {
    const device = await resolveDevice(udid, name)
    if (device.alreadyBooted)
      return textResult(`Simulator already booted: ${device.name} (${device.udid})`, { udid: device.udid, name: device.name })

    const { alreadyBooted } = await bootDevice(device.udid)
    return textResult(
      alreadyBooted
        ? `Simulator already booted: ${device.name} (${device.udid})`
        : `Booted simulator: ${device.name} (${device.udid})`,
      { udid: device.udid, name: device.name },
    )
  }
  catch (error) {
    return errorResult('Error booting simulator', error)
  }
}

export function registerBootTools(server: McpServer): void {
  if (isToolFiltered('boot_sim'))
    return

  server.tool(
    'boot_sim',
    'Boots an iOS simulator headlessly via baguette and reports its name + UDID. Selects by udid, by name '
    + '(e.g. "iPhone 17 Pro"), or picks an already-booted device, otherwise the first available one. Idempotent.',
    {
      udid: z.string().optional().describe('Exact simulator UDID to boot'),
      name: z.string().optional().describe('Device name to match (e.g. "iPhone 17 Pro")'),
    },
    { title: 'Boot Simulator', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    bootSimHandler,
  )
}
