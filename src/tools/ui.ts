import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { ScreenSize, WsSession } from '../lib/baguette'
import { z } from 'zod'
import { describeUi, fingerprintTree, frameCenter, resolveTarget } from '../lib/ax'
import { GESTURE_FLUSH_MS, getScreenSize, resolveBootedUdid, withSession } from '../lib/baguette'
import { isToolFiltered, udidSchema } from '../lib/constants'
import { errorResult, textResult } from '../lib/errors'
import { verifyExpectation } from './snapshot'

const expectAppearsSchema = z
  .string()
  .optional()
  .describe('After the action, wait briefly and confirm an element with this label/identifier appears. Reports changed/no-change.')

const expectGoneSchema = z
  .string()
  .optional()
  .describe('After the action, wait briefly and confirm an element with this label/identifier disappears.')

const refSchema = z
  .string()
  .optional()
  .describe('Element ref from the most recent ui_snapshot (e.g. "e12"). Resolves to the element\'s center.')

const labelSchema = z
  .string()
  .optional()
  .describe('Element label or accessibility identifier to target (exact match preferred, then substring, case-insensitive)')

function expectationSuffix(result: Awaited<ReturnType<typeof verifyExpectation>>): string {
  if (!result)
    return ''
  return result.verified ? ` Verified: ${result.detail}.` : ` Warning: ${result.detail} (action was still sent).`
}

const NOOP_SETTLE_MS = 600

const SCREEN_UNCHANGED_WARNING
  = ' Warning: the screen did not change after this action — it may have hit dead space, a stale ref, or a disabled '
    + 'control. Call ui_snapshot to re-orient and target by label instead of repeating.'

const GEOMETRY_RECOVERY_WARNING
  = ' Warning: recovered screen size from the accessibility tree because baguette geometry was unavailable.'

const UI_RECOVERY_HINT
  = 'Stay within the MCP tools: call ui_snapshot/ui_inspect to re-orient, boot_sim/select_default_device for stale devices, '
    + 'or doctor for server health. Do not fall back to shell idb/xcrun coordinate tapping.'

async function fingerprint(session: WsSession): Promise<string | null> {
  try {
    return fingerprintTree(await describeUi(session))
  }
  catch {
    return null
  }
}

function buildStructured(
  verification: Awaited<ReturnType<typeof verifyExpectation>>,
  refWarning: string | undefined,
  screenUnchanged: boolean,
  recoveryWarning?: string,
): Record<string, unknown> | undefined {
  const structured: Record<string, unknown> = {}
  if (verification)
    structured.verification = verification
  if (refWarning)
    structured.refWarning = refWarning
  if (screenUnchanged)
    structured.screenUnchanged = true
  if (recoveryWarning)
    structured.recoveryWarning = recoveryWarning
  return Object.keys(structured).length > 0 ? structured : undefined
}

async function resolveGestureSize(udid: string, session: WsSession): Promise<{ size: ScreenSize, warning?: string }> {
  try {
    return { size: await getScreenSize(udid) }
  }
  catch (geometryError) {
    try {
      const tree = await describeUi(session)
      const frame = tree.frame
      if (frame && typeof frame.width === 'number' && typeof frame.height === 'number' && frame.width > 0 && frame.height > 0)
        return { size: { width: frame.width, height: frame.height }, warning: GEOMETRY_RECOVERY_WARNING }
    }
    catch {
      // Preserve the original geometry error; it has the most actionable route/status detail.
    }
    throw geometryError
  }
}

function uiErrorResult(prefix: string, error: unknown): CallToolResult {
  const result = errorResult(prefix, error, UI_RECOVERY_HINT)
  const block = result.content[0]
  if (block?.type === 'text' && !block.text.includes('Do not fall back to shell idb/xcrun coordinate tapping.'))
    block.text = `${block.text}\n\nMCP recovery: ${UI_RECOVERY_HINT}`
  if (result.structuredContent?.error && typeof result.structuredContent.error === 'object')
    result.structuredContent.error = { ...result.structuredContent.error, mcpRecovery: UI_RECOVERY_HINT }
  return result
}

export interface UiTapParams {
  duration?: number
  udid?: string
  x?: number
  y?: number
  ref?: string
  label?: string
  expect_appears?: string
  expect_gone?: string
}

export async function uiTapHandler({ duration, udid, x, y, ref, label, expect_appears, expect_gone }: UiTapParams): Promise<CallToolResult> {
  try {
    const actualUdid = await resolveBootedUdid(udid)

    return await withSession(actualUdid, async (session) => {
      const { size, warning: sizeWarning } = await resolveGestureSize(actualUdid, session)
      const target = await resolveTarget(session, { x, y, ref, label })
      const hasExpectation = !!expect_appears || !!expect_gone
      const before = hasExpectation ? null : await fingerprint(session)

      session.send({
        type: 'tap',
        x: target.x,
        y: target.y,
        width: size.width,
        height: size.height,
        ...(duration != null ? { duration } : {}),
      })

      const verification = await verifyExpectation(session, { appears: expect_appears, gone: expect_gone })

      let noopWarning = ''
      if (before != null) {
        await new Promise(resolve => setTimeout(resolve, NOOP_SETTLE_MS))
        const after = await fingerprint(session)
        if (after != null && after === before)
          noopWarning = SCREEN_UNCHANGED_WARNING
      }

      const refWarning = target.warning ? ` Warning: ${target.warning}` : ''
      return textResult(
        `Tapped (${target.x}, ${target.y}) successfully.${expectationSuffix(verification)}${refWarning}${noopWarning}${sizeWarning ?? ''}`,
        buildStructured(verification, target.warning, noopWarning !== '', sizeWarning),
      )
    }, { flushMs: GESTURE_FLUSH_MS })
  }
  catch (error) {
    return uiErrorResult('Error tapping on the screen', error)
  }
}

export interface UiDoubleTapParams {
  udid?: string
  x?: number
  y?: number
  ref?: string
  label?: string
}

export async function uiDoubleTapHandler({ udid, x, y, ref, label }: UiDoubleTapParams): Promise<CallToolResult> {
  try {
    const actualUdid = await resolveBootedUdid(udid)

    return await withSession(actualUdid, async (session) => {
      const { size, warning: sizeWarning } = await resolveGestureSize(actualUdid, session)
      const target = await resolveTarget(session, { x, y, ref, label })
      // Two touch1 down/up pairs at the same point on one connection — the
      // recognizer aggregates them into a double-tap.
      const base = { x: target.x, y: target.y, width: size.width, height: size.height }
      session.send({ type: 'touch1-down', ...base })
      session.send({ type: 'touch1-up', ...base })
      await new Promise(resolve => setTimeout(resolve, 60))
      session.send({ type: 'touch1-down', ...base })
      session.send({ type: 'touch1-up', ...base })
      return textResult(`Double-tapped (${target.x}, ${target.y}) successfully.${sizeWarning ?? ''}`, sizeWarning ? { recoveryWarning: sizeWarning } : undefined)
    }, { flushMs: GESTURE_FLUSH_MS })
  }
  catch (error) {
    return uiErrorResult('Error double-tapping on the screen', error)
  }
}

export interface UiTypeParams {
  udid?: string
  text: string
  ref?: string
  label?: string
  expect_appears?: string
  expect_gone?: string
}

export async function uiTypeHandler({ udid, text, ref, label, expect_appears, expect_gone }: UiTypeParams): Promise<CallToolResult> {
  try {
    const actualUdid = await resolveBootedUdid(udid)

    return await withSession(actualUdid, async (session) => {
      const { size, warning: sizeWarning } = await resolveGestureSize(actualUdid, session)
      let refWarning: string | undefined
      if (ref || label) {
        const target = await resolveTarget(session, { ref, label })
        refWarning = target.warning
        session.send({ type: 'tap', x: target.x, y: target.y, width: size.width, height: size.height })
        await new Promise(resolve => setTimeout(resolve, 300))
      }

      session.send({ type: 'type', text })

      const verification = await verifyExpectation(session, { appears: expect_appears, gone: expect_gone })
      const refWarningSuffix = refWarning ? ` Warning: ${refWarning}` : ''
      return textResult(
        `Typed successfully.${expectationSuffix(verification)}${refWarningSuffix}${sizeWarning ?? ''}`,
        buildStructured(verification, refWarning, false, sizeWarning),
      )
    }, { flushMs: GESTURE_FLUSH_MS })
  }
  catch (error) {
    return uiErrorResult('Error typing text into the simulator', error)
  }
}

const KEY_CODE_REGEX = /^(?:Key[A-Z]|Digit\d|Enter|Escape|Backspace|Tab|Space|Arrow(?:Up|Down|Left|Right)|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Backquote|Comma|Period|Slash)$/

export interface UiKeyParams {
  udid?: string
  code: string
  modifiers?: Array<'shift' | 'control' | 'option' | 'command'>
  duration?: number
}

export async function uiKeyHandler({ udid, code, modifiers, duration }: UiKeyParams): Promise<CallToolResult> {
  try {
    const actualUdid = await resolveBootedUdid(udid)
    return await withSession(actualUdid, async (session) => {
      session.send({
        type: 'key',
        code,
        ...(modifiers && modifiers.length > 0 ? { modifiers } : {}),
        ...(duration != null ? { duration } : {}),
      })
      return textResult(`Sent key ${code}${modifiers?.length ? ` + ${modifiers.join(',')}` : ''}.`)
    }, { flushMs: GESTURE_FLUSH_MS })
  }
  catch (error) {
    return uiErrorResult('Error sending key', error)
  }
}

export interface UiSwipeParams {
  duration?: number
  udid?: string
  x_start: number
  y_start: number
  x_end: number
  y_end: number
  expect_appears?: string
  expect_gone?: string
}

export async function uiSwipeHandler({ duration, udid, x_start, y_start, x_end, y_end, expect_appears, expect_gone }: UiSwipeParams): Promise<CallToolResult> {
  try {
    const actualUdid = await resolveBootedUdid(udid)

    return await withSession(actualUdid, async (session) => {
      const { size, warning: sizeWarning } = await resolveGestureSize(actualUdid, session)
      session.send({
        type: 'swipe',
        startX: x_start,
        startY: y_start,
        endX: x_end,
        endY: y_end,
        width: size.width,
        height: size.height,
        ...(duration != null ? { duration } : {}),
      })
      const verification = await verifyExpectation(session, { appears: expect_appears, gone: expect_gone })
      return textResult(
        `Swiped (${x_start}, ${y_start}) -> (${x_end}, ${y_end}) successfully.${expectationSuffix(verification)}${sizeWarning ?? ''}`,
        buildStructured(verification, undefined, false, sizeWarning),
      )
    }, { flushMs: GESTURE_FLUSH_MS })
  }
  catch (error) {
    return uiErrorResult('Error swiping on the screen', error)
  }
}

export interface UiScrollParams {
  udid?: string
  delta_x?: number
  delta_y?: number
}

export async function uiScrollHandler({ udid, delta_x, delta_y }: UiScrollParams): Promise<CallToolResult> {
  try {
    const actualUdid = await resolveBootedUdid(udid)
    return await withSession(actualUdid, async (session) => {
      session.send({ type: 'scroll', deltaX: delta_x ?? 0, deltaY: delta_y ?? 0 })
      return textResult(`Scrolled (dx=${delta_x ?? 0}, dy=${delta_y ?? 0}).`)
    }, { flushMs: GESTURE_FLUSH_MS })
  }
  catch (error) {
    return uiErrorResult('Error scrolling', error)
  }
}

export interface UiPinchParams {
  udid?: string
  cx: number
  cy: number
  start_spread: number
  end_spread: number
  duration?: number
}

export async function uiPinchHandler({ udid, cx, cy, start_spread, end_spread, duration }: UiPinchParams): Promise<CallToolResult> {
  try {
    const actualUdid = await resolveBootedUdid(udid)
    return await withSession(actualUdid, async (session) => {
      const { size, warning: sizeWarning } = await resolveGestureSize(actualUdid, session)
      session.send({
        type: 'pinch',
        cx,
        cy,
        startSpread: start_spread,
        endSpread: end_spread,
        width: size.width,
        height: size.height,
        ...(duration != null ? { duration } : {}),
      })
      const verb = end_spread > start_spread ? 'in' : 'out'
      return textResult(`Pinched ${verb} at (${cx}, ${cy}) (${start_spread} -> ${end_spread} pts).${sizeWarning ?? ''}`, sizeWarning ? { recoveryWarning: sizeWarning } : undefined)
    }, { flushMs: GESTURE_FLUSH_MS })
  }
  catch (error) {
    return uiErrorResult('Error pinching', error)
  }
}

export interface UiPanParams {
  udid?: string
  x1: number
  y1: number
  x2: number
  y2: number
  dx: number
  dy: number
  duration?: number
}

export async function uiPanHandler({ udid, x1, y1, x2, y2, dx, dy, duration }: UiPanParams): Promise<CallToolResult> {
  try {
    const actualUdid = await resolveBootedUdid(udid)
    return await withSession(actualUdid, async (session) => {
      const { size, warning: sizeWarning } = await resolveGestureSize(actualUdid, session)
      session.send({
        type: 'pan',
        x1,
        y1,
        x2,
        y2,
        dx,
        dy,
        width: size.width,
        height: size.height,
        ...(duration != null ? { duration } : {}),
      })
      return textResult(`Panned two fingers by (${dx}, ${dy}).${sizeWarning ?? ''}`, sizeWarning ? { recoveryWarning: sizeWarning } : undefined)
    }, { flushMs: GESTURE_FLUSH_MS })
  }
  catch (error) {
    return uiErrorResult('Error panning', error)
  }
}

const BUTTONS = [
  'home',
  'lock',
  'power',
  'volume-up',
  'volume-down',
  'action',
  'app-switcher',
  'swipe-to-app-switcher',
  'swipe-to-home',
  'pull-down-to-lock-screen',
  'pull-down-to-notification-center',
] as const

export interface UiPressParams {
  udid?: string
  button: (typeof BUTTONS)[number]
  duration?: number
}

export async function uiPressHandler({ udid, button, duration }: UiPressParams): Promise<CallToolResult> {
  try {
    const actualUdid = await resolveBootedUdid(udid)
    return await withSession(actualUdid, async (session) => {
      session.send({ type: 'button', button, ...(duration != null ? { duration } : {}) })
      return textResult(`Pressed ${button}${duration != null ? ` for ${duration}s` : ''}.`)
    }, { flushMs: GESTURE_FLUSH_MS })
  }
  catch (error) {
    return uiErrorResult('Error pressing button', error)
  }
}

export interface UiDescribePointParams {
  udid?: string
  x: number
  y: number
}

export async function uiDescribePointHandler({ udid, x, y }: UiDescribePointParams): Promise<CallToolResult> {
  try {
    const actualUdid = await resolveBootedUdid(udid)
    return await withSession(actualUdid, async (session) => {
      const node = await describeUi(session, { x, y })
      const center = node.frame ? frameCenter(node.frame) : null
      return textResult(
        JSON.stringify({
          role: node.role ?? null,
          label: node.label ?? null,
          value: node.value ?? null,
          identifier: node.identifier ?? null,
          frame: node.frame ?? null,
          center,
        }),
        { node },
      )
    })
  }
  catch (error) {
    return uiErrorResult(`Error describing point (${x}, ${y})`, error)
  }
}

const durationSchema = z.number().min(0).max(60).optional()

export function registerUiTools(server: McpServer): void {
  if (!isToolFiltered('ui_tap')) {
    server.tool(
      'ui_tap',
      'Taps the screen. Target by label (preferred), by ref from ui_snapshot, or by x/y coordinates in points — '
      + 'provide exactly one. Prefer label over ref: refs are renumbered by every ui_snapshot, so a reused ref can hit '
      + 'the wrong element. Coordinates are device points (NOT pixels, NOT normalized); the screen size is resolved for '
      + 'you. Without expect_appears/expect_gone the result warns if the screen did not change — when you see that, take '
      + 'a fresh ui_snapshot and retarget rather than repeating the tap.',
      {
        udid: udidSchema,
        x: z.number().optional().describe('X coordinate in device points (use with y)'),
        y: z.number().optional().describe('Y coordinate in device points (use with x)'),
        ref: refSchema,
        label: labelSchema,
        duration: durationSchema.describe('Press dwell time in seconds (e.g. 1.5 for a long press)'),
        expect_appears: expectAppearsSchema,
        expect_gone: expectGoneSchema,
      },
      { title: 'UI Tap', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      uiTapHandler,
    )
  }

  if (!isToolFiltered('ui_double_tap')) {
    server.tool(
      'ui_double_tap',
      'Double-taps the screen (two quick taps the recognizer aggregates). Target by label, ref, or x/y in points.',
      {
        udid: udidSchema,
        x: z.number().optional().describe('X coordinate in device points (use with y)'),
        y: z.number().optional().describe('Y coordinate in device points (use with x)'),
        ref: refSchema,
        label: labelSchema,
      },
      { title: 'UI Double Tap', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      uiDoubleTapHandler,
    )
  }

  if (!isToolFiltered('ui_type')) {
    server.tool(
      'ui_type',
      'Types US-ASCII text into the focused field. Pass ref or label to tap the target field first, or tap it yourself '
      + 'with ui_tap beforehand. Non-ASCII (emoji, accented, CJK) is not supported on this path.',
      {
        udid: udidSchema,
        text: z.string().max(500).regex(/^[\x20-\x7E]+$/).describe('Text to input (printable US-ASCII only)'),
        ref: refSchema,
        label: labelSchema,
        expect_appears: expectAppearsSchema,
        expect_gone: expectGoneSchema,
      },
      { title: 'UI Type', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      uiTypeHandler,
    )
  }

  if (!isToolFiltered('ui_key')) {
    server.tool(
      'ui_key',
      'Sends a single keystroke by W3C KeyboardEvent.code (e.g. "Enter", "KeyA", "ArrowDown") with optional modifiers. '
      + 'Use for special keys (Enter/Tab/Escape/arrows) and shortcuts; use ui_type for plain text.',
      {
        udid: udidSchema,
        code: z.string().regex(KEY_CODE_REGEX).describe('W3C KeyboardEvent.code: KeyA-KeyZ, Digit0-9, Enter, Escape, Backspace, Tab, Space, Arrow*, US punctuation'),
        modifiers: z.array(z.enum(['shift', 'control', 'option', 'command'])).optional().describe('Modifier keys held for the keystroke'),
        duration: durationSchema.describe('Hold time in seconds'),
      },
      { title: 'UI Key', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      uiKeyHandler,
    )
  }

  if (!isToolFiltered('ui_swipe')) {
    server.tool(
      'ui_swipe',
      'Swipes between two points (device points). The server interpolates intermediate points. Useful for scrolling '
      + 'lists, dismissing sheets, and paging. For scrolling, swipe from the center of the scrollable area.',
      {
        udid: udidSchema,
        x_start: z.number().describe('Start X in device points'),
        y_start: z.number().describe('Start Y in device points'),
        x_end: z.number().describe('End X in device points'),
        y_end: z.number().describe('End Y in device points'),
        duration: durationSchema.describe('End-to-end swipe duration in seconds (e.g. 0.3)'),
        expect_appears: expectAppearsSchema,
        expect_gone: expectGoneSchema,
      },
      { title: 'UI Swipe', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      uiSwipeHandler,
    )
  }

  if (!isToolFiltered('ui_scroll')) {
    server.tool(
      'ui_scroll',
      'Sends a scroll-wheel event. Negative delta_y scrolls content up (macOS convention). Target-agnostic — no '
      + 'coordinates needed; use ui_swipe for a positional drag.',
      {
        udid: udidSchema,
        delta_x: z.number().optional().describe('Horizontal scroll delta (default 0)'),
        delta_y: z.number().optional().describe('Vertical scroll delta; negative scrolls content up (default 0)'),
      },
      { title: 'UI Scroll', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      uiScrollHandler,
    )
  }

  if (!isToolFiltered('ui_pinch')) {
    server.tool(
      'ui_pinch',
      'Two-finger pinch around a center point (device points). end_spread > start_spread zooms in; the server '
      + 'interpolates the gesture. Use for map/photo zoom.',
      {
        udid: udidSchema,
        cx: z.number().describe('Center X in device points'),
        cy: z.number().describe('Center Y in device points'),
        start_spread: z.number().describe('Initial finger separation in points'),
        end_spread: z.number().describe('Final finger separation in points'),
        duration: durationSchema.describe('Gesture duration in seconds (e.g. 0.6)'),
      },
      { title: 'UI Pinch', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      uiPinchHandler,
    )
  }

  if (!isToolFiltered('ui_pan')) {
    server.tool(
      'ui_pan',
      'Two-finger parallel pan: both fingers (starting at x1,y1 and x2,y2) translate by (dx, dy) in points. Useful for '
      + 'two-finger scrolling in apps that ignore single-finger pans (e.g. Maps).',
      {
        udid: udidSchema,
        x1: z.number().describe('First finger start X'),
        y1: z.number().describe('First finger start Y'),
        x2: z.number().describe('Second finger start X'),
        y2: z.number().describe('Second finger start Y'),
        dx: z.number().describe('Translation X in points'),
        dy: z.number().describe('Translation Y in points'),
        duration: durationSchema.describe('Gesture duration in seconds (e.g. 0.5)'),
      },
      { title: 'UI Pan', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      uiPanHandler,
    )
  }

  if (!isToolFiltered('ui_press')) {
    server.tool(
      'ui_press',
      'Presses a hardware or virtual button: home, lock, power, volume-up, volume-down, action, app-switcher, '
      + 'swipe-to-app-switcher, swipe-to-home, pull-down-to-lock-screen, pull-down-to-notification-center. '
      + 'Pass duration for long-press semantics (e.g. power held ~1.5s → Siri). "siri" is intentionally unavailable.',
      {
        udid: udidSchema,
        button: z.enum(BUTTONS).describe('Button name'),
        duration: durationSchema.describe('Hold time in seconds (omit for a short press)'),
      },
      { title: 'UI Press', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      uiPressHandler,
    )
  }

  if (!isToolFiltered('ui_describe_point')) {
    server.tool(
      'ui_describe_point',
      'Returns the topmost accessibility element at the given point coordinates (device points). Useful to verify what '
      + 'a tap at (x, y) would hit — e.g. to diagnose a tap that warned the screen did not change.',
      {
        udid: udidSchema,
        x: z.number().describe('X coordinate in device points'),
        y: z.number().describe('Y coordinate in device points'),
      },
      { title: 'Describe UI Point', readOnlyHint: true, openWorldHint: true },
      uiDescribePointHandler,
    )
  }
}
