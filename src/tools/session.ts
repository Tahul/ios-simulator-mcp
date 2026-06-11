import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { isToolFiltered, udidSchema } from '../lib/constants'
import { getBootedDeviceId } from '../lib/devices'
import { errorResult, textResult, toError } from '../lib/errors'
import { cleanupStaleTmpDirs } from '../lib/paths'
import { run } from '../lib/run'
import { stopAnyRecording } from './recording'

export interface CleanupSessionParams {
  udid?: string
  stop_recordings?: boolean
  clear_status_bar?: boolean
  clear_location?: boolean
  remove_temp_files?: boolean
  terminate_apps?: string[]
}

/**
 * Each cleanup step runs independently: one failing step (e.g. an app that
 * is not running) must not abort the rest of the cleanup.
 */
async function step(label: string, fn: () => Promise<string | null>): Promise<string> {
  try {
    const detail = await fn()
    return `[ok] ${label}${detail ? `: ${detail}` : ''}`
  }
  catch (error) {
    return `[failed] ${label}: ${toError(error).message}`
  }
}

export async function cleanupSessionHandler({
  udid,
  stop_recordings = true,
  clear_status_bar = true,
  clear_location = true,
  remove_temp_files = true,
  terminate_apps,
}: CleanupSessionParams): Promise<CallToolResult> {
  try {
    const lines: string[] = []

    // Host-side cleanup works even without a booted simulator.
    if (stop_recordings)
      lines.push(await step('stop recordings', () => stopAnyRecording()))

    if (remove_temp_files) {
      lines.push(await step('remove stale temp files', async () => {
        const removed = cleanupStaleTmpDirs()
        return removed > 0 ? `${removed} stale temp dir(s) removed` : 'nothing to remove'
      }))
    }

    // Device-bound cleanup needs a target simulator.
    const needsDevice = clear_status_bar || clear_location || (terminate_apps?.length ?? 0) > 0
    if (needsDevice) {
      let actualUdid: string | null = null
      try {
        actualUdid = await getBootedDeviceId(udid)
      }
      catch {
        lines.push('[skipped] device cleanup: no booted simulator found')
      }

      if (actualUdid) {
        const deviceId = actualUdid

        if (clear_status_bar) {
          lines.push(await step('clear status bar overrides', async () => {
            await run('xcrun', ['simctl', 'status_bar', deviceId, 'clear'])
            return null
          }))
        }

        if (clear_location) {
          lines.push(await step('clear simulated location', async () => {
            await run('xcrun', ['simctl', 'location', deviceId, 'clear'])
            return null
          }))
        }

        for (const bundleId of terminate_apps ?? []) {
          lines.push(await step(`terminate ${bundleId}`, async () => {
            await run('xcrun', ['simctl', 'terminate', deviceId, bundleId])
            return null
          }))
        }
      }
    }

    return textResult(`Session cleanup:\n${lines.join('\n')}`)
  }
  catch (error) {
    return errorResult('Error cleaning up session', error)
  }
}

export function registerSessionTools(server: McpServer): void {
  if (isToolFiltered('cleanup_session'))
    return

  server.tool(
    'cleanup_session',
    'Resets state left over from previous automation sessions. Stops orphaned video recordings (including ones '
    + 'started by a previous server instance), removes stale temp files, clears status-bar overrides and the '
    + 'simulated location, and optionally terminates the given apps. Steps run independently and the result reports '
    + 'each one. Call this at the start of a session for a clean slate, or at the end to leave the simulator tidy.',
    {
      udid: udidSchema,
      stop_recordings: z
        .boolean()
        .optional()
        .describe('Stop any active or orphaned simctl recordVideo process (default true)'),
      clear_status_bar: z
        .boolean()
        .optional()
        .describe('Clear status bar overrides set via the status_bar tool (default true)'),
      clear_location: z
        .boolean()
        .optional()
        .describe('Clear the simulated GPS location set via set_location (default true)'),
      remove_temp_files: z
        .boolean()
        .optional()
        .describe('Remove stale temp directories from previous server instances (default true)'),
      terminate_apps: z
        .array(z.string().max(256))
        .optional()
        .describe('Bundle identifiers of apps to terminate (e.g. the app under test)'),
    },
    { title: 'Cleanup Session', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    cleanupSessionHandler,
  )
}
