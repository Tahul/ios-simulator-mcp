import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { isToolFiltered } from '../lib/constants'
import { ensureBooted } from '../lib/devices'
import { errorResult, textResult } from '../lib/errors'
import { run } from '../lib/run'

export interface BootSimParams {
  udid?: string
  name?: string
  open_app?: boolean
}

export async function bootSimHandler({ udid, name, open_app = true }: BootSimParams): Promise<CallToolResult> {
  try {
    const { device, alreadyBooted } = await ensureBooted({ udid, name })

    if (open_app) {
      // Bring the Simulator window forward so the boot is visible.
      try {
        await run('open', ['-a', 'Simulator.app'])
      }
      catch {
        // non-fatal: the device is booted regardless of the window
      }
    }

    return textResult(
      alreadyBooted
        ? `Simulator already booted: ${device.name} (${device.udid})`
        : `Booted simulator: ${device.name} (${device.udid})`,
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
    'Boots an iOS simulator and waits until it is actually ready (simctl boot returns before the device is usable, '
    + 'so this polls for the Booted state). Selects by udid, by name (e.g. "iPhone 17 Pro"), or picks an already-booted '
    + 'device, otherwise the first available one. Idempotent — safe to call when a device is already booted. '
    + 'Note: a macOS window showing a physical iPhone (iPhone Mirroring) is NOT a simulator and cannot be controlled.',
    {
      udid: z.string().optional().describe('Exact simulator UDID to boot'),
      name: z.string().optional().describe('Device name to match (e.g. "iPhone 17 Pro"); booted/exact matches preferred'),
      open_app: z.boolean().optional().describe('Bring Simulator.app to the foreground after booting (default true)'),
    },
    { title: 'Boot Simulator', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    bootSimHandler,
  )
}
