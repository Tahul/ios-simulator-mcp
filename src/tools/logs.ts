import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { collectLogs, resolveBootedUdid } from '../lib/baguette'
import { isToolFiltered, udidSchema } from '../lib/constants'
import { errorResult, textResult } from '../lib/errors'

export interface AppLogsParams {
  udid?: string
  level?: 'default' | 'info' | 'debug'
  predicate?: string
  bundle_id?: string
  window_s?: number
  max_lines?: number
}

export async function appLogsHandler({ udid, level, predicate, bundle_id, window_s, max_lines }: AppLogsParams): Promise<CallToolResult> {
  try {
    const actualUdid = await resolveBootedUdid(udid)
    const maxLines = max_lines ?? 200
    const windowMs = (window_s ?? 4) * 1000

    const lines = await collectLogs(actualUdid, {
      level,
      predicate,
      bundleId: bundle_id,
      maxLines,
      windowMs,
    })

    if (lines.length === 0) {
      return textResult(
        `No log entries within ${windowMs / 1000}s${bundle_id ? ` for bundle "${bundle_id}"` : ''}. `
        + 'The simulator may be idle, or the filter excluded everything.',
      )
    }

    const truncated = lines.length >= maxLines
    const header = truncated
      ? `(captured ${lines.length} lines — raise max_lines or narrow with bundle_id/predicate)\n`
      : ''
    return textResult(header + lines.join('\n'), { lines, totalLines: lines.length, truncated })
  }
  catch (error) {
    return errorResult(
      'Error reading simulator logs',
      error,
      'Logs stream from a running baguette server. Ensure the simulator is booted and baguette serve is reachable.',
    )
  }
}

export function registerLogTools(server: McpServer): void {
  if (isToolFiltered('app_logs'))
    return

  server.tool(
    'app_logs',
    'Reads a bounded batch of recent unified-log lines from the simulator (via baguette\'s live log stream). JS errors, '
    + 'RedBox messages, and native crashes surface here — use this to debug instead of relying on screenshots alone. '
    + 'Filter by bundle_id or an NSPredicate to cut system noise. Captures until max_lines or window_s elapses.',
    {
      udid: udidSchema,
      level: z.enum(['default', 'info', 'debug']).optional().describe('Log level (iOS runtime accepts only default | info | debug). Default info-and-above'),
      predicate: z.string().max(512).optional().describe('Raw NSPredicate (e.g. subsystem == "com.facebook.react"). ANDed with bundle_id'),
      bundle_id: z.string().max(256).optional().describe('Filter to a process/bundle id (shorthand for process == "<id>")'),
      window_s: z.number().min(1).max(30).optional().describe('Seconds to collect before returning (default 4)'),
      max_lines: z.number().int().min(1).max(2000).optional().describe('Stop after this many lines (default 200)'),
    },
    { title: 'App Logs', readOnlyHint: true, openWorldHint: true },
    appLogsHandler,
  )
}
