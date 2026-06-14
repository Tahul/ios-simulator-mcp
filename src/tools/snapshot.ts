import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { AxNode } from '../lib/ax'
import type { WsSession } from '../lib/baguette'
import { z } from 'zod'
import {
  buildSnapshot,
  collectLabelMatches,
  describeUi,
  frameCenter,
  storeRefs,
} from '../lib/ax'
import { captureScreenshot, resolveBootedUdid, withSession } from '../lib/baguette'
import { isToolFiltered, udidSchema } from '../lib/constants'
import { errorResult, textResult, ToolError } from '../lib/errors'

export type { AxNode } from '../lib/ax'
export { fingerprintTree, frameCenter, resolveTarget } from '../lib/ax'

interface SnapshotRender {
  text: string
  structured: Record<string, unknown>
}

/** Describes the screen, stores refs, returns text + structured payloads. */
async function takeSnapshot(session: WsSession, maxDepth?: number): Promise<SnapshotRender> {
  const tree = await describeUi(session)
  const { entries, text } = buildSnapshot(tree, { maxDepth })
  storeRefs(entries)

  const rootFrame = tree.frame
  const screen = rootFrame ? `Screen ${Math.round(rootFrame.width)}x${Math.round(rootFrame.height)} points. ` : ''

  return {
    text: `${screen}${entries.length} elements (coordinates are point centers; pass ref or label to ui_tap / ui_type):\n${text}`,
    structured: {
      screen: rootFrame ? { width: rootFrame.width, height: rootFrame.height } : null,
      elements: entries.map(e => ({
        ref: e.ref,
        role: e.role,
        label: e.label,
        value: e.value,
        identifier: e.identifier,
        center: frameCenter(e.frame),
        frame: e.frame,
      })),
    },
  }
}

export async function uiSnapshotHandler({ udid, max_depth }: { udid?: string, max_depth?: number }): Promise<CallToolResult> {
  try {
    const actualUdid = await resolveBootedUdid(udid)
    const { text, structured } = await withSession(actualUdid, s => takeSnapshot(s, max_depth))
    return textResult(text, structured)
  }
  catch (error) {
    return errorResult('Error taking UI snapshot', error)
  }
}

export async function uiInspectHandler({ udid, max_depth }: { udid?: string, max_depth?: number }): Promise<CallToolResult> {
  try {
    const actualUdid = await resolveBootedUdid(udid)
    const { text, structured } = await withSession(actualUdid, s => takeSnapshot(s, max_depth))
    const base64 = await captureScreenshot(actualUdid)
    return {
      isError: false,
      content: [
        { type: 'image', data: base64, mimeType: 'image/jpeg' },
        { type: 'text', text },
      ],
      structuredContent: structured,
    }
  }
  catch (error) {
    return errorResult('Error inspecting UI', error)
  }
}

const POLL_INTERVAL_MS = 500

export interface WaitForElementParams {
  udid?: string
  search: string
  role?: string
  timeout?: number
}

export async function waitForElementHandler({ udid, search, role, timeout }: WaitForElementParams): Promise<CallToolResult> {
  try {
    const actualUdid = await resolveBootedUdid(udid)
    const timeoutMs = (timeout ?? 10) * 1000
    const start = Date.now()

    return await withSession(actualUdid, async (session) => {
      while (true) {
        try {
          const tree = await describeUi(session)
          const matches = collectLabelMatches(tree, search).filter(
            m => role == null || m.role?.toLowerCase() === role.toLowerCase(),
          )
          const match = matches[0]
          if (match) {
            const center = frameCenter(match.frame)
            const elapsed = ((Date.now() - start) / 1000).toFixed(1)
            return textResult(
              `Found ${match.role ?? 'element'} "${match.label ?? match.identifier ?? search}" at (${center.x}, ${center.y}) after ${elapsed}s`,
              { found: true, center, role: match.role ?? null, label: match.label ?? match.identifier ?? null },
            )
          }
        }
        catch {
          // transient describe failure (idle screen, mid-transition) — keep polling
        }

        if (Date.now() - start >= timeoutMs)
          throw new ToolError(`Element matching "${search}" did not appear within ${timeout ?? 10}s`, 'ELEMENT_NOT_FOUND')

        await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))
      }
    })
  }
  catch (error) {
    return errorResult(
      'Error waiting for element',
      error,
      'Call ui_snapshot to see what is currently on screen — the app may be on a different screen than expected.',
    )
  }
}

export interface Expectation {
  appears?: string
  gone?: string
  timeoutMs?: number
}

export interface VerificationResult {
  verified: boolean
  detail: string
}

const VERIFY_POLL_MS = 400

/**
 * Polls describe_ui to confirm a post-action expectation. Reuses the caller's
 * session so a tap + its verification share one stream connection.
 */
export async function verifyExpectation(session: WsSession, { appears, gone, timeoutMs = 4000 }: Expectation): Promise<VerificationResult | null> {
  if (!appears && !gone)
    return null

  const start = Date.now()
  while (true) {
    try {
      const tree = await describeUi(session)
      if (appears && collectLabelMatches(tree, appears).length > 0)
        return { verified: true, detail: `"${appears}" appeared` }
      if (gone && collectLabelMatches(tree, gone).length === 0)
        return { verified: true, detail: `"${gone}" is gone` }
    }
    catch {
      // transient describe failure — keep polling
    }

    if (Date.now() - start >= timeoutMs) {
      const what = appears ? `"${appears}" did not appear` : `"${gone}" is still present`
      return { verified: false, detail: `${what} within ${Math.round(timeoutMs / 1000)}s` }
    }
    await new Promise(resolve => setTimeout(resolve, VERIFY_POLL_MS))
  }
}

/** Standalone AX tree query (verification path for expo_launch). */
export async function describeTree(udid: string, hit?: { x: number, y: number }): Promise<AxNode> {
  return withSession(udid, s => describeUi(s, hit))
}

export function registerSnapshotTools(server: McpServer): void {
  if (!isToolFiltered('ui_snapshot')) {
    server.tool(
      'ui_snapshot',
      'Compact view of the current screen from the accessibility tree: visible interactive and labeled elements, one '
      + 'per line, each with a stable ref (e1, e2, ...) and its center coordinates in points. Pass a ref or label '
      + 'directly to ui_tap / ui_type. Refs are invalidated by the next ui_snapshot call.',
      {
        udid: udidSchema,
        max_depth: z.number().int().min(1).max(100).optional().describe('Maximum tree depth to traverse (default 40)'),
      },
      { title: 'UI Snapshot', readOnlyHint: true, openWorldHint: true },
      uiSnapshotHandler,
    )
  }

  if (!isToolFiltered('ui_inspect')) {
    server.tool(
      'ui_inspect',
      'Returns the compact element snapshot (refs + coordinates) AND an inline screenshot of the current screen in one '
      + 'call. Use this at the start of an act cycle when you want both the structure to target and the pixels to reason '
      + 'about — it saves a round-trip versus calling ui_snapshot and ui_view separately.',
      {
        udid: udidSchema,
        max_depth: z.number().int().min(1).max(100).optional().describe('Maximum tree depth to traverse (default 40)'),
      },
      { title: 'UI Inspect', readOnlyHint: true, openWorldHint: true },
      uiInspectHandler,
    )
  }

  if (!isToolFiltered('wait_for_element')) {
    server.tool(
      'wait_for_element',
      'Polls the accessibility tree until an element matching the search string (against label, value, or identifier) '
      + 'appears, then returns its role, label, and center coordinates. Use this to wait for a screen that loads '
      + 'asynchronously (after a launch or network-driven navigation) instead of sleeping and re-describing. '
      + 'If you are confirming the immediate result of a tap/type, prefer that action\'s expect_appears/expect_gone. '
      + 'Fails after the timeout.',
      {
        udid: udidSchema,
        search: z.string().min(1).describe('Text matched (case-insensitive substring, exact preferred) against label, value, or identifier'),
        role: z.string().optional().describe('Optionally restrict to an AX role (e.g. \'AXButton\'). Case-insensitive exact match'),
        timeout: z.number().min(1).max(60).optional().describe('Maximum seconds to wait (default 10)'),
      },
      { title: 'Wait For Element', readOnlyHint: true, openWorldHint: true },
      waitForElementHandler,
    )
  }
}
