import type { WsSession } from './baguette'
import { ToolError } from './errors'

/** A node in baguette's accessibility tree (describe_ui). Frames are in points. */
export interface AxNode {
  role?: string | null
  subrole?: string | null
  label?: string | null
  value?: string | null
  identifier?: string | null
  title?: string | null
  help?: string | null
  frame?: { x: number, y: number, width: number, height: number }
  enabled?: boolean
  focused?: boolean
  hidden?: boolean
  children?: AxNode[]
}

export interface AxFrame {
  x: number
  y: number
  width: number
  height: number
}

export interface SnapshotEntry {
  ref: string
  role: string
  label: string | null
  value: string | null
  identifier: string | null
  frame: AxFrame
}

export function frameCenter(frame: AxFrame): { x: number, y: number } {
  return {
    x: Math.round(frame.x + frame.width / 2),
    y: Math.round(frame.y + frame.height / 2),
  }
}

function hasVisibleFrame(node: AxNode): node is AxNode & { frame: AxFrame } {
  const f = node.frame
  return (
    !!f
    && typeof f.x === 'number'
    && typeof f.y === 'number'
    && typeof f.width === 'number'
    && typeof f.height === 'number'
    && f.width > 0
    && f.height > 0
  )
}

export interface SnapshotResult {
  entries: SnapshotEntry[]
  text: string
}

// Structural container roles: traversed but never listed as actionable targets
// even when labeled (the app/window root, generic groups, scroll containers).
const CONTAINER_ROLES = new Set([
  'axapplication',
  'axwindow',
  'axgroup',
  'axscrollarea',
  'axscrollview',
  'axtable',
  'axcollectionview',
  'axlayoutarea',
  'axlayoutitem',
])

/**
 * Flattens the AX tree into a compact, ref-tagged listing of actionable /
 * labeled nodes. Nodes with no label, value, or identifier and that are hidden
 * are skipped (but still traversed). Mirrors the idb snapshot contract so the
 * tool surface is unchanged for the model.
 */
export function buildSnapshot(root: AxNode, { maxDepth = 40 }: { maxDepth?: number } = {}): SnapshotResult {
  const entries: SnapshotEntry[] = []
  let counter = 0

  function visit(node: AxNode, depth: number): void {
    if (depth > maxDepth)
      return

    const label = node.label ?? null
    const value = node.value ?? null
    const identifier = node.identifier ?? null
    const informative = !!label || !!value || !!identifier
    const isContainer = CONTAINER_ROLES.has((node.role ?? '').toLowerCase())
    const include = hasVisibleFrame(node) && informative && !isContainer && node.hidden !== true

    if (include && hasVisibleFrame(node)) {
      counter += 1
      entries.push({
        ref: `e${counter}`,
        role: node.role ?? 'Unknown',
        label,
        value,
        identifier,
        frame: node.frame,
      })
    }

    if (node.children) {
      for (const child of node.children)
        visit(child, depth + 1)
    }
  }

  // The root itself is usually the application container; start at its children
  // but still allow the root to register if it is informative.
  visit(root, 0)

  const lines = entries.map((entry) => {
    const center = frameCenter(entry.frame)
    const parts = [`${entry.ref} ${entry.role}`]
    if (entry.label)
      parts.push(`"${entry.label}"`)
    if (entry.value && entry.value !== entry.label)
      parts.push(`=${entry.value}`)
    if (entry.identifier && entry.identifier !== entry.label)
      parts.push(`id=${entry.identifier}`)
    parts.push(`(${center.x}, ${center.y})`)
    return parts.join(' ')
  })

  return { entries, text: lines.join('\n') }
}

function nodeMatchesLabel(node: AxNode, needle: string): boolean {
  const n = needle.toLowerCase()
  const label = node.label?.toLowerCase()
  const id = node.identifier?.toLowerCase()
  const value = node.value?.toLowerCase()
  return (
    label === n || id === n || value === n
    || !!label?.includes(n) || !!id?.includes(n) || !!value?.includes(n)
  )
}

export function collectLabelMatches(root: AxNode, label: string): Array<AxNode & { frame: AxFrame }> {
  const matches: Array<AxNode & { frame: AxFrame }> = []
  function visit(node: AxNode): void {
    if (hasVisibleFrame(node) && nodeMatchesLabel(node, label))
      matches.push(node)
    if (node.children) {
      for (const child of node.children)
        visit(child)
    }
  }
  visit(root)
  return matches
}

// ---------------------------------------------------------------------------
// describe_ui over a WS session + ref state shared by tap/type/snapshot.
// ---------------------------------------------------------------------------

const DESCRIBE_TIMEOUT_MS = 8000

/** Requests the AX tree from a stream session. Throws ToolError on failure. */
export async function describeUi(session: WsSession, hit?: { x: number, y: number }): Promise<AxNode> {
  const envelope: Record<string, unknown> = { type: 'describe_ui' }
  if (hit) {
    envelope.x = hit.x
    envelope.y = hit.y
  }
  const reply = await session.request(envelope, 'describe_ui_result', DESCRIBE_TIMEOUT_MS)
  if (reply.ok !== true) {
    throw new ToolError(
      `describe_ui failed: ${(reply.error as string) ?? 'no accessibility data'}. `
      + 'The screen may be idle or unfocused — send a gesture to wake it, then retry.',
      'ELEMENT_NOT_FOUND',
    )
  }
  if (reply.tree == null || typeof reply.tree !== 'object') {
    throw new ToolError(
      'describe_ui returned no tree. The screen may be idle or unfocused — send a gesture to wake it, then retry.',
      'ELEMENT_NOT_FOUND',
    )
  }
  return reply.tree as AxNode
}

// Refs from the most recent ui_snapshot. Invalidated by the next snapshot.
let currentRefs = new Map<string, SnapshotEntry>()
// Repeated resolution of the same ref between snapshots is the renumbering-trap
// loop; we flag it so callers can warn instead of silently retargeting.
let refResolveCounts = new Map<string, number>()

/** Test seam: clear stored snapshot refs + reuse counters. */
export function resetSnapshotState(): void {
  currentRefs = new Map()
  refResolveCounts = new Map()
}

export function storeRefs(entries: SnapshotEntry[]): void {
  currentRefs = new Map(entries.map(e => [e.ref, e]))
  refResolveCounts = new Map()
}

export interface ResolvedTarget {
  x: number
  y: number
  warning?: string
}

export interface TargetParams {
  x?: number
  y?: number
  ref?: string
  label?: string
}

/**
 * Resolves a tap/type target from coordinates, a snapshot ref, or a label.
 * Refs come from the last snapshot (with a reuse warning); labels resolve
 * against a freshly described tree, preferring exact matches.
 */
export async function resolveTarget(session: WsSession, { x, y, ref, label }: TargetParams): Promise<ResolvedTarget> {
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
    const tree = await describeUi(session)
    const matches = collectLabelMatches(tree, label)
    if (matches.length === 0) {
      throw new ToolError(
        `No on-screen element matching "${label}". Call ui_snapshot to inspect the current screen.`,
        'ELEMENT_NOT_FOUND',
      )
    }
    const exact = matches.find(m =>
      m.label?.toLowerCase() === label.toLowerCase()
      || m.identifier?.toLowerCase() === label.toLowerCase(),
    )
    return frameCenter((exact ?? matches[0]!).frame)
  }

  throw new ToolError('Provide either x/y coordinates, a ref from ui_snapshot, or a label.', 'INVALID_ARGUMENT')
}

/**
 * Structural fingerprint of the tree (roles + labels + frames) for detecting
 * gestures that changed nothing on screen.
 */
export function fingerprintTree(root: AxNode): string {
  const parts: string[] = []
  function visit(node: AxNode): void {
    if (hasVisibleFrame(node)) {
      const f = node.frame
      parts.push(`${node.role ?? '?'}|${node.label ?? ''}|${node.value ?? ''}|${node.identifier ?? ''}|${f.x},${f.y},${f.width},${f.height}`)
    }
    if (node.children) {
      for (const child of node.children)
        visit(child)
    }
  }
  visit(root)
  return parts.join('\n')
}
