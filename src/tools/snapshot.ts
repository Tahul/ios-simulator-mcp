import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { isToolFiltered, udidSchema } from '../lib/constants'
import { getBootedDeviceId } from '../lib/devices'
import { errorResult, textResult, ToolError } from '../lib/errors'
import { idbWithTimeout } from '../lib/run'
import { captureCompressedScreenshot } from './screenshot'

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
// Tracks how many times a given ref has been resolved within one refs
// generation. Repeatedly tapping the same ref without an intervening
// ui_snapshot is the classic renumbering-trap loop, so we flag it.
let refResolveCounts = new Map<string, number>()

/** Test seam: clear stored snapshot refs. */
export function resetSnapshotState(): void {
  currentRefs = new Map()
  refResolveCounts = new Map()
}

// A single accessibility dump should be quick; inside poll loops we cap it
// tighter than the global exec timeout so one slow call can't blow the loop
// budget. A wedged idb gets killed and the loop simply retries.
const DESCRIBE_TIMEOUT_MS = 8000

export async function describeAll(udid: string, timeoutMs = DESCRIBE_TIMEOUT_MS): Promise<RawElement[]> {
  const { stdout } = await idbWithTimeout(timeoutMs, 'ui', 'describe-all', '--udid', udid, '--json', '--nested')
  return JSON.parse(stdout) as RawElement[]
}

function elementMatchesLabel(element: RawElement, label: string): boolean {
  const needle = label.toLowerCase()
  const axLabel = element.AXLabel?.toLowerCase()
  const axId = element.AXUniqueId?.toLowerCase()
  return axLabel === needle || axId === needle || !!axLabel?.includes(needle) || !!axId?.includes(needle)
}

export function collectLabelMatches(elements: RawElement[], label: string): Array<RawElement & { frame: ElementFrame }> {
  const matches: Array<RawElement & { frame: ElementFrame }> = []
  for (const element of elements) {
    if (hasVisibleFrame(element) && elementMatchesLabel(element, label))
      matches.push(element)
    if (element.children)
      matches.push(...collectLabelMatches(element.children, label))
  }
  return matches
}

/** True if any visible element matches the label (live tree). */
export async function isElementPresent(udid: string, label: string): Promise<boolean> {
  const tree = await describeAll(udid)
  return collectLabelMatches(tree, label).length > 0
}

/**
 * Cheap structural fingerprint of the visible tree (types + labels + frames),
 * used to detect taps that changed nothing on screen. Order-sensitive on
 * purpose: a reordered list is a real change.
 */
export function fingerprintTree(elements: RawElement[]): string {
  const parts: string[] = []
  function visit(nodes: RawElement[]): void {
    for (const node of nodes) {
      if (hasVisibleFrame(node)) {
        const f = node.frame
        parts.push(`${node.type ?? '?'}|${node.AXLabel ?? ''}|${node.AXUniqueId ?? ''}|${f.x},${f.y},${f.width},${f.height}`)
      }
      if (node.children)
        visit(node.children)
    }
  }
  visit(elements)
  return parts.join('\n')
}

/** Fingerprints the current live screen; null if it can't be read. */
export async function screenFingerprint(udid: string, timeoutMs?: number): Promise<string | null> {
  try {
    return fingerprintTree(await describeAll(udid, timeoutMs))
  }
  catch {
    return null
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
 * Polls the accessibility tree to confirm a post-action expectation:
 * `appears` waits for a label to show up, `gone` waits for it to disappear.
 * Returns a result instead of throwing so callers can fold it into a
 * partial-success message (the action itself already happened).
 */
export async function verifyExpectation(udid: string, { appears, gone, timeoutMs = 4000 }: Expectation): Promise<VerificationResult | null> {
  if (!appears && !gone)
    return null

  const start = Date.now()
  while (true) {
    try {
      if (appears && await isElementPresent(udid, appears))
        return { verified: true, detail: `"${appears}" appeared` }
      if (gone && !(await isElementPresent(udid, gone)))
        return { verified: true, detail: `"${gone}" is gone` }
    }
    catch {
      // transient describe failure (e.g. mid-transition) — keep polling
    }

    if (Date.now() - start >= timeoutMs) {
      const what = appears ? `"${appears}" did not appear` : `"${gone}" is still present`
      return { verified: false, detail: `${what} within ${Math.round(timeoutMs / 1000)}s` }
    }
    await new Promise(resolve => setTimeout(resolve, VERIFY_POLL_MS))
  }
}

export interface TargetParams {
  x?: number
  y?: number
  ref?: string
  label?: string
}

export interface ResolvedTarget {
  x: number
  y: number
  /** Non-fatal advisory (e.g. ref resolved without a fresh snapshot). */
  warning?: string
}

/**
 * Resolves a tap/type target from coordinates, a snapshot ref, or a label.
 * Label resolution queries the live accessibility tree and prefers exact
 * matches over substring matches.
 */
export async function resolveTarget(udid: string, { x, y, ref, label }: TargetParams): Promise<ResolvedTarget> {
  if (typeof x === 'number' && typeof y === 'number')
    return { x, y }

  if (ref) {
    const entry = currentRefs.get(ref)
    if (!entry) {
      throw new ToolError(
        `Unknown or stale ref "${ref}". Refs are only valid for the most recent ui_snapshot — call ui_snapshot again.`,
        'STALE_REF',
      )
    }

    const seen = (refResolveCounts.get(ref) ?? 0) + 1
    refResolveCounts.set(ref, seen)
    const warning = seen > 1
      ? `Ref "${ref}" was already used since the last ui_snapshot; refs are renumbered by every snapshot, so this may target a different element. Call ui_snapshot or target by label.`
      : undefined

    return { ...frameCenter(entry.frame), warning }
  }

  if (label) {
    const tree = await describeAll(udid)
    const matches = collectLabelMatches(tree, label)
    if (matches.length === 0) {
      throw new ToolError(
        `No on-screen element matching "${label}". Call ui_snapshot to inspect the current screen.`,
        'ELEMENT_NOT_FOUND',
      )
    }
    const exact = matches.find(m =>
      m.AXLabel?.toLowerCase() === label.toLowerCase()
      || m.AXUniqueId?.toLowerCase() === label.toLowerCase(),
    )
    return frameCenter((exact ?? matches[0]!).frame)
  }

  throw new ToolError('Provide either x/y coordinates, a ref from ui_snapshot, or a label.', 'INVALID_ARGUMENT')
}

interface SnapshotRender {
  text: string
  structured: Record<string, unknown>
}

/** Runs a snapshot, stores refs, and returns text + structured payloads. */
async function takeSnapshot(udid: string, maxDepth?: number): Promise<SnapshotRender> {
  const tree = await describeAll(udid)
  const { entries, text } = buildSnapshot(tree, { maxDepth })

  currentRefs = new Map(entries.map(entry => [entry.ref, entry]))
  // Fresh snapshot ⇒ refs renumbered ⇒ reset the re-use guard.
  refResolveCounts = new Map()

  const screenFrame = tree[0] && hasVisibleFrame(tree[0]) ? tree[0].frame : null
  const screen = screenFrame ? `Screen ${screenFrame.width}x${screenFrame.height} points. ` : ''

  return {
    text: `${screen}${entries.length} elements (coordinates are point centers; pass ref or label to ui_tap / ui_type):\n${text}`,
    structured: {
      screen: screenFrame ? { width: screenFrame.width, height: screenFrame.height } : null,
      elements: entries.map(e => ({
        ref: e.ref,
        type: e.type,
        label: e.label,
        identifier: e.identifier,
        center: frameCenter(e.frame),
        frame: e.frame,
      })),
    },
  }
}

export async function uiSnapshotHandler({ udid, max_depth }: { udid?: string, max_depth?: number }): Promise<CallToolResult> {
  try {
    const actualUdid = await getBootedDeviceId(udid)
    const { text, structured } = await takeSnapshot(actualUdid, max_depth)
    return textResult(text, structured)
  }
  catch (error) {
    return errorResult('Error taking UI snapshot', error)
  }
}

export async function uiInspectHandler({ udid, max_depth }: { udid?: string, max_depth?: number }): Promise<CallToolResult> {
  try {
    const actualUdid = await getBootedDeviceId(udid)
    const { text, structured } = await takeSnapshot(actualUdid, max_depth)
    const base64 = await captureCompressedScreenshot(actualUdid)

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
  type?: string
  timeout?: number
}

export async function waitForElementHandler({ udid, search, type, timeout }: WaitForElementParams): Promise<CallToolResult> {
  try {
    const actualUdid = await getBootedDeviceId(udid)
    const timeoutMs = (timeout ?? 10) * 1000
    const start = Date.now()

    while (true) {
      try {
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
            { found: true, center, type: match.type ?? null, label: match.AXLabel ?? match.AXUniqueId ?? null },
          )
        }
      }
      catch {
        // transient describe failure — keep polling until the deadline
      }

      if (Date.now() - start >= timeoutMs)
        throw new ToolError(`Element matching "${search}" did not appear within ${timeout ?? 10}s`, 'ELEMENT_NOT_FOUND')

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

  if (!isToolFiltered('ui_inspect')) {
    server.tool(
      'ui_inspect',
      'Returns the compact element snapshot (refs + coordinates) AND an inline screenshot of the current screen in '
      + 'one call. Use this at the start of an act cycle when you want both the structure to target and the pixels to '
      + 'reason about — it saves a round-trip versus calling ui_snapshot and ui_view separately.',
      {
        udid: udidSchema,
        max_depth: z.number().int().min(1).max(100).optional().describe('Maximum tree depth to traverse (default 25)'),
      },
      { title: 'UI Inspect', readOnlyHint: true, openWorldHint: true },
      uiInspectHandler,
    )
  }

  if (!isToolFiltered('wait_for_element')) {
    server.tool(
      'wait_for_element',
      'Polls the accessibility tree until an element matching the search string (against label or identifier) appears, '
      + 'then returns its type, label, and center coordinates. Use this to wait for a screen that loads asynchronously '
      + '(after a launch or network-driven navigation) instead of sleeping and re-describing. '
      + 'If you are confirming the immediate result of a tap/type, prefer that action\'s expect_appears/expect_gone — '
      + 'it verifies in the same call. Fails after the timeout.',
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
