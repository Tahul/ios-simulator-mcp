import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { collectLogs, resolveBootedUdid } from './baguette'
import { errorResult } from './errors'

interface ErrorResultWithLogsOptions {
  udid?: string
  bundleId?: string
  hint?: string
  windowMs?: number
  maxLines?: number
}

const DEFAULT_FAILURE_LOG_WINDOW_MS = 1000
const DEFAULT_FAILURE_LOG_LINES = 80

function appendText(result: CallToolResult, extra: string): void {
  const block = result.content[0]
  if (block?.type === 'text')
    block.text = `${block.text}\n\n${extra}`
}

/**
 * Builds an error result and appends a short, best-effort simulator log capture.
 * Log collection is bounded and never masks the original tool failure.
 */
export async function errorResultWithLogs(
  prefix: string,
  error: unknown,
  { udid, bundleId, hint, windowMs = DEFAULT_FAILURE_LOG_WINDOW_MS, maxLines = DEFAULT_FAILURE_LOG_LINES }: ErrorResultWithLogsOptions = {},
): Promise<CallToolResult> {
  const result = errorResult(prefix, error, hint)

  try {
    const actualUdid = await resolveBootedUdid(udid)
    const lines = await collectLogs(actualUdid, {
      bundleId,
      maxLines,
      windowMs,
    })
    const truncated = lines.length >= maxLines
    const label = bundleId ? ` for ${bundleId}` : ''
    const header = `Simulator logs captured after failure${label} (${windowMs / 1000}s):`
    const text = lines.length > 0
      ? `${header}\n${lines.join('\n')}${truncated ? '\n(capture truncated)' : ''}`
      : `${header}\n(no entries captured)`

    appendText(result, text)
    result.structuredContent = {
      ...result.structuredContent,
      recentLogs: { udid: actualUdid, bundleId: bundleId ?? null, lines, totalLines: lines.length, truncated },
    }
  }
  catch (logError) {
    result.structuredContent = {
      ...result.structuredContent,
      recentLogs: {
        udid: udid ?? null,
        bundleId: bundleId ?? null,
        lines: [],
        totalLines: 0,
        truncated: false,
        unavailable: logError instanceof Error ? logError.message : String(logError),
      },
    }
  }

  return result
}
