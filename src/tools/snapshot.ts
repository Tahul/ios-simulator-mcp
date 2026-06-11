import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { isToolFiltered, udidSchema } from '../lib/constants'
import { getBootedDeviceId } from '../lib/devices'
import { errorResult, textResult } from '../lib/errors'
import { idb } from '../lib/run'

export interface ElementFrame {
  x: number
  y: number
  width: number
  height: number
}

export interface RawElement {
  AXLabel?: string | null
  AXUniqueId?: string | null
  type?: string
  frame?: Partial<ElementFrame>
  children?: RawElement[]
}

export interface SnapshotEntry {
  ref: string
  type: string
  label: string | null
  identifier: string | null
  frame: ElementFrame
}

/**
 * Element types an agent can act on. Labeled elements of other types
 * (StaticText, Image, ...) are still included so screen content is visible.
 */
const INTERACTIVE_TYPES = new Set([
  'button',
  'cell',
  'checkbox',
  'link',
  'menuitem',
  'picker',
  'pickerwheel',
  'radiobutton',
  'searchfield',
  'securetextfield',
  'segmentedcontrol',
  'slider',
  'switch',
  'tab',
  'textfield',
  'textview',
  'toggle',
])

const CONTAINER_TYPES = new Set(['group', 'other', 'window', 'application', 'scrollview', 'table', 'collectionview'])

function hasVisibleFrame(element: RawElement): element is RawElement & { frame: ElementFrame } {
  const frame = element.frame
  return (
    !!frame
    && typeof frame.x === 'number'
    && typeof frame.y === 'number'
    && typeof frame.width === 'number'
    && typeof frame.height === 'number'
    && frame.width > 0
    && frame.height > 0
  )
}

export interface SnapshotResult {
  entries: SnapshotEntry[]
  text: string
}

/**
 * Builds a compact, depth-limited snapshot of the accessibility tree:
 * interactive elements plus anything labeled, one line per element with a
 * short ref usable by ui_tap / ui_type. Unlabeled containers are skipped
 * (but still traversed).
 */
export function buildSnapshot(tree: RawElement[], { maxDepth = 25 }: { maxDepth?: number } = {}): SnapshotResult {
  const entries: SnapshotEntry[] = []
  let counter = 0

  function visit(elements: RawElement[], depth: number): void {
    if (depth > maxDepth)
      return

    for (const element of elements) {
      const type = element.type ?? 'Unknown'
      const label = element.AXLabel ?? null
      const identifier = element.AXUniqueId ?? null
      const interactive = INTERACTIVE_TYPES.has(type.toLowerCase())
      const container = CONTAINER_TYPES.has(type.toLowerCase())
      const include
        = hasVisibleFrame(element)
          && (interactive || ((!!label || !!identifier) && !container))

      if (include && hasVisibleFrame(element)) {
        counter += 1
        entries.push({
          ref: `e${counter}`,
          type,
          label,
          identifier,
          frame: element.frame,
        })
      }

      if (element.children && element.children.length > 0)
        visit(element.children, depth + 1)
    }
  }

  visit(tree, 0)

  const lines = entries.map((entry) => {
    const center = frameCenter(entry.frame)
    const parts = [`${entry.ref} ${entry.type}`]
    if (entry.label)
      parts.push(`"${entry.label}"`)
    if (entry.identifier && entry.identifier !== entry.label)
      parts.push(`id=${entry.identifier}`)
    parts.push(`(${center.x}, ${center.y})`)
    return parts.join(' ')
  })

  return { entries, text: lines.join('\n') }
}

export function frameCenter(frame: ElementFrame): { x: number, y: number } {
  return {
    x: Math.round(frame.x + frame.width / 2),
    y: Math.round(frame.y + frame.height / 2),
  }
}

// Refs from the most recent ui_snapshot. Invalidated by the next snapshot.
let currentRefs = new Map<string, SnapshotEntry>()

/** Test seam: clear stored snapshot refs. */
export function resetSnapshotState(): void {
  currentRefs = new Map()
}

async function describeAll(udid: string): Promise<RawElement[]> {
  const { stdout } = await idb('ui', 'describe-all', '--udid', udid, '--json', '--nested')
  return JSON.parse(stdout) as RawElement[]
}

function elementMatchesLabel(element: RawElement, label: string): boolean {
  const needle = label.toLowerCase()
  const axLabel = element.AXLabel?.toLowerCase()
  const axId = element.AXUniqueId?.toLowerCase()
  return axLabel === needle || axId === needle || !!axLabel?.includes(needle) || !!axId?.includes(needle)
}

function collectLabelMatches(elements: RawElement[], label: string): Array<RawElement & { frame: ElementFrame }> {
  const matches: Array<RawElement & { frame: ElementFrame }> = []
  for (const element of elements) {
    if (hasVisibleFrame(element) && elementMatchesLabel(element, label))
      matches.push(element)
    if (element.children)
      matches.push(...collectLabelMatches(element.children, label))
  }
  return matches
}

export interface TargetParams {
  x?: number
  y?: number
  ref?: string
  label?: string
}

/**
 * Resolves a tap/type target from coordinates, a snapshot ref, or a label.
 * Label resolution queries the live accessibility tree and prefers exact
 * matches over substring matches.
 */
export async function resolveTarget(udid: string, { x, y, ref, label }: TargetParams): Promise<{ x: number, y: number }> {
  if (typeof x === 'number' && typeof y === 'number')
    return { x, y }

  if (ref) {
    const entry = currentRefs.get(ref)
    if (!entry) {
      throw new Error(
        `Unknown or stale ref "${ref}". Refs are only valid for the most recent ui_snapshot — call ui_snapshot again.`,
      )
    }
    return frameCenter(entry.frame)
  }

  if (label) {
    const tree = await describeAll(udid)
    const matches = collectLabelMatches(tree, label)
    if (matches.length === 0) {
      throw new Error(
        `No on-screen element matching "${label}". Call ui_snapshot to inspect the current screen.`,
      )
    }
    const exact = matches.find(m =>
      m.AXLabel?.toLowerCase() === label.toLowerCase()
      || m.AXUniqueId?.toLowerCase() === label.toLowerCase(),
    )
    return frameCenter((exact ?? matches[0]!).frame)
  }

  throw new Error('Provide either x/y coordinates, a ref from ui_snapshot, or a label.')
}

export async function uiSnapshotHandler({ udid, max_depth }: { udid?: string, max_depth?: number }): Promise<CallToolResult> {
  try {
    const actualUdid = await getBootedDeviceId(udid)
    const tree = await describeAll(actualUdid)
    const { entries, text } = buildSnapshot(tree, { maxDepth: max_depth })

    currentRefs = new Map(entries.map(entry => [entry.ref, entry]))

    const screen = tree[0] && hasVisibleFrame(tree[0])
      ? `Screen ${tree[0].frame.width}x${tree[0].frame.height} points. `
      : ''

    return textResult(
      `${screen}${entries.length} elements (coordinates are point centers; pass ref or label to ui_tap / ui_type):\n${text}`,
    )
  }
  catch (error) {
    return errorResult('Error taking UI snapshot', error)
  }
}

const POLL_INTERVAL_MS = 500

export interface WaitForElementParams {
  udid?: string
  search: string
  type?: string
  timeout?: number
}

export async function waitForElementHandler({ udid, search, type, timeout }: WaitForElementParams): Promise<CallToolResult> {
  try {
    const actualUdid = await getBootedDeviceId(udid)
    const timeoutMs = (timeout ?? 10) * 1000
    const start = Date.now()

    while (true) {
      const tree = await describeAll(actualUdid)
      const matches = collectLabelMatches(tree, search).filter(
        m => type == null || m.type?.toLowerCase() === type.toLowerCase(),
      )

      const match = matches[0]
      if (match) {
        const center = frameCenter(match.frame)
        const elapsed = ((Date.now() - start) / 1000).toFixed(1)
        return textResult(
          `Found ${match.type ?? 'element'} "${match.AXLabel ?? match.AXUniqueId ?? search}" at (${center.x}, ${center.y}) after ${elapsed}s`,
        )
      }

      if (Date.now() - start >= timeoutMs)
        throw new Error(`Element matching "${search}" did not appear within ${timeout ?? 10}s`)

      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))
    }
  }
  catch (error) {
    return errorResult(
      'Error waiting for element',
      error,
      'Call ui_snapshot to see what is currently on screen — the app may be on a different screen than expected.',
    )
  }
}

export function registerSnapshotTools(server: McpServer): void {
  if (!isToolFiltered('ui_snapshot')) {
    server.tool(
      'ui_snapshot',
      'Compact view of the current screen: visible interactive and labeled elements, one per line, each with a '
      + 'stable ref (e1, e2, ...) and its center coordinates in points. Strongly preferred over ui_describe_all '
      + '(which dumps the raw accessibility tree). Pass a ref or label directly to ui_tap / ui_type. '
      + 'Refs are invalidated by the next ui_snapshot call.',
      {
        udid: udidSchema,
        max_depth: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe('Maximum tree depth to traverse (default 25)'),
      },
      { title: 'UI Snapshot', readOnlyHint: true, openWorldHint: true },
      uiSnapshotHandler,
    )
  }

  if (!isToolFiltered('wait_for_element')) {
    server.tool(
      'wait_for_element',
      'Polls the accessibility tree until an element matching the search string (against label or identifier) appears, '
      + 'then returns its type, label, and center coordinates. Use this after navigation or launches instead of '
      + 'sleeping and re-describing. Fails after the timeout.',
      {
        udid: udidSchema,
        search: z
          .string()
          .min(1)
          .describe('Text matched (case-insensitive substring, exact preferred) against AXLabel or AXUniqueId'),
        type: z
          .string()
          .optional()
          .describe('Optionally restrict to an element type (e.g. \'Button\'). Case-insensitive exact match'),
        timeout: z
          .number()
          .min(1)
          .max(60)
          .optional()
          .describe('Maximum seconds to wait (default 10)'),
      },
      { title: 'Wait For Element', readOnlyHint: true, openWorldHint: true },
      waitForElementHandler,
    )
  }
}
