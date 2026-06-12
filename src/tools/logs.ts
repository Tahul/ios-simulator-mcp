import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { isToolFiltered, udidSchema } from '../lib/constants'
import { getBootedDeviceId } from '../lib/devices'
import { errorResult, textResult } from '../lib/errors'
import { run } from '../lib/run'

export interface LogArgsInput {
  udid: string
  process?: string
  predicate?: string
  sinceS: number
}

/**
 * Builds the `simctl spawn <udid> log show` argument list. Uses `log show
 * --last` (bounded) rather than `log stream` so the tool call always returns.
 */
export function buildLogArgs({ udid, process, predicate, sinceS }: LogArgsInput): string[] {
  const args = ['simctl', 'spawn', udid, 'log', 'show', '--style', 'compact', '--last', `${sinceS}s`]

  const predicates: string[] = []
  if (process)
    predicates.push(`process == "${process}"`)
  if (predicate)
    predicates.push(`(${predicate})`)
  if (predicates.length > 0)
    args.push('--predicate', predicates.join(' AND '))

  return args
}

export interface AppLogsParams {
  udid?: string
  process?: string
  predicate?: string
  since_s?: number
  max_lines?: number
}

export async function appLogsHandler({ udid, process, predicate, since_s, max_lines }: AppLogsParams): Promise<CallToolResult> {
  try {
    const actualUdid = await getBootedDeviceId(udid)
    const sinceS = since_s ?? 60
    const maxLines = max_lines ?? 200

    const { stdout } = await run(
      'xcrun',
      buildLogArgs({ udid: actualUdid, process, predicate, sinceS }),
    )

    const lines = stdout.split('\n').filter(line => line.length > 0)
    if (lines.length === 0)
      return textResult(`No log entries in the last ${sinceS}s${process ? ` for process "${process}"` : ''}.`)

    const shown = lines.slice(-maxLines)
    const header = lines.length > shown.length
      ? `(showing last ${shown.length} of ${lines.length} lines — narrow with process/predicate or raise max_lines)\n`
      : ''

    return textResult(header + shown.join('\n'), {
      lines: shown,
      totalLines: lines.length,
      truncated: lines.length > shown.length,
    })
  }
  catch (error) {
    return errorResult(
      'Error reading simulator logs',
      error,
      'Check the process name with list_apps (CFBundleExecutable is usually the process name, not the bundle id).',
    )
  }
}

export function registerLogTools(server: McpServer): void {
  if (isToolFiltered('app_logs'))
    return

  server.tool(
    'app_logs',
    'Reads recent console logs from the iOS Simulator (unified logging via `log show`). JS errors, RedBox messages, '
    + 'and native crashes surface here — use this to debug instead of relying on screenshots alone. '
    + 'Filter by process name (the app\'s executable name, e.g. "Expo Go" or your app target name — NOT the bundle id) '
    + 'to avoid system noise. Returns at most max_lines of the newest entries.',
    {
      udid: udidSchema,
      process: z
        .string()
        .max(128)
        .regex(/^[\w .()-]+$/)
        .optional()
        .describe('Process name to filter by (executable name, not bundle id)'),
      predicate: z
        .string()
        .max(512)
        .optional()
        .describe('Advanced: raw NSPredicate for `log show` (e.g. subsystem CONTAINS "com.facebook.react"). ANDed with the process filter'),
      since_s: z
        .number()
        .int()
        .min(1)
        .max(3600)
        .optional()
        .describe('How many seconds back to read (default 60)'),
      max_lines: z
        .number()
        .int()
        .min(1)
        .max(2000)
        .optional()
        .describe('Maximum number of newest lines to return (default 200)'),
    },
    { title: 'App Logs', readOnlyHint: true, openWorldHint: true },
    appLogsHandler,
  )
}
