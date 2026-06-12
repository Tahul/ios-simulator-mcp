import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { isToolFiltered, udidSchema } from '../lib/constants'
import { getBootedDeviceId } from '../lib/devices'
import { errorResult, textResult } from '../lib/errors'
import { idb } from '../lib/run'
import { resolveTarget, verifyExpectation } from './snapshot'

const expectAppearsSchema = z
  .string()
  .optional()
  .describe('After the action, wait briefly and confirm an element with this label/identifier appears. Reports changed/no-change.')

const expectGoneSchema = z
  .string()
  .optional()
  .describe('After the action, wait briefly and confirm an element with this label/identifier disappears.')

function expectationSuffix(result: Awaited<ReturnType<typeof verifyExpectation>>): string {
  if (!result)
    return ''
  return result.verified ? ` Verified: ${result.detail}.` : ` Warning: ${result.detail} (action was still sent).`
}

const durationSchema = z
  .string()
  .regex(/^\d+(?:\.\d+)?$/)
  .optional()

const refSchema = z
  .string()
  .optional()
  .describe('Element ref from the most recent ui_snapshot (e.g. "e12"). Taps the element\'s center.')

const labelSchema = z
  .string()
  .optional()
  .describe('Element label or accessibility identifier to target (exact match preferred, then substring, case-insensitive)')

export interface UiTapParams {
  duration?: string
  udid?: string
  x?: number
  y?: number
  ref?: string
  label?: string
  expect_appears?: string
  expect_gone?: string
}

export async function uiDescribeAllHandler({ udid }: { udid?: string }): Promise<CallToolResult> {
  try {
    const actualUdid = await getBootedDeviceId(udid)

    const { stdout } = await idb(
      'ui',
      'describe-all',
      '--udid',
      actualUdid,
      '--json',
      '--nested',
    )

    return textResult(stdout)
  }
  catch (error) {
    return errorResult('Error describing all of the ui', error)
  }
}

async function tap(udid: string, x: number, y: number, duration?: string): Promise<void> {
  await idb(
    'ui',
    'tap',
    '--udid',
    udid,
    ...(duration ? ['--duration', duration] : []),
    '--json',
    // `--` separates options from user-provided positional arguments so
    // they cannot be misinterpreted as flags.
    '--',
    String(x),
    String(y),
  )
}

export async function uiTapHandler({ duration, udid, x, y, ref, label, expect_appears, expect_gone }: UiTapParams): Promise<CallToolResult> {
  try {
    const actualUdid = await getBootedDeviceId(udid)
    const target = await resolveTarget(actualUdid, { x, y, ref, label })

    await tap(actualUdid, target.x, target.y, duration)

    const verification = await verifyExpectation(actualUdid, { appears: expect_appears, gone: expect_gone })
    return textResult(
      `Tapped (${target.x}, ${target.y}) successfully.${expectationSuffix(verification)}`,
      verification ? { verification } : undefined,
    )
  }
  catch (error) {
    return errorResult('Error tapping on the screen', error)
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
    const actualUdid = await getBootedDeviceId(udid)

    // When a target is given, tap it first so the field has focus.
    if (ref || label) {
      const target = await resolveTarget(actualUdid, { ref, label })
      await tap(actualUdid, target.x, target.y)
      await new Promise(resolve => setTimeout(resolve, 300))
    }

    await idb(
      'ui',
      'text',
      '--udid',
      actualUdid,
      '--',
      text,
    )

    const verification = await verifyExpectation(actualUdid, { appears: expect_appears, gone: expect_gone })
    return textResult(
      `Typed successfully.${expectationSuffix(verification)}`,
      verification ? { verification } : undefined,
    )
  }
  catch (error) {
    return errorResult('Error typing text into the iOS Simulator', error)
  }
}

export interface UiSwipeParams {
  duration?: string
  udid?: string
  x_start: number
  y_start: number
  x_end: number
  y_end: number
  delta?: number
  expect_appears?: string
  expect_gone?: string
}

export async function uiSwipeHandler({ duration, udid, x_start, y_start, x_end, y_end, delta, expect_appears, expect_gone }: UiSwipeParams): Promise<CallToolResult> {
  try {
    const actualUdid = await getBootedDeviceId(udid)

    await idb(
      'ui',
      'swipe',
      '--udid',
      actualUdid,
      ...(duration ? ['--duration', duration] : []),
      ...(delta ? ['--delta', String(delta)] : []),
      '--json',
      '--',
      String(x_start),
      String(y_start),
      String(x_end),
      String(y_end),
    )

    const verification = await verifyExpectation(actualUdid, { appears: expect_appears, gone: expect_gone })
    return textResult(
      `Swiped successfully.${expectationSuffix(verification)}`,
      verification ? { verification } : undefined,
    )
  }
  catch (error) {
    return errorResult('Error swiping on the screen', error)
  }
}

export async function uiDescribePointHandler({ udid, x, y }: { udid?: string, x: number, y: number }): Promise<CallToolResult> {
  try {
    const actualUdid = await getBootedDeviceId(udid)

    const { stdout } = await idb(
      'ui',
      'describe-point',
      '--udid',
      actualUdid,
      '--json',
      '--',
      String(x),
      String(y),
    )

    return textResult(stdout)
  }
  catch (error) {
    return errorResult(`Error describing point (${x}, ${y})`, error)
  }
}

export function registerUiTools(server: McpServer): void {
  if (!isToolFiltered('ui_describe_all')) {
    server.tool(
      'ui_describe_all',
      'Dumps the raw accessibility tree for the entire screen as JSON. Output is large — prefer ui_snapshot for a '
      + 'compact, ref-based view, or ui_find_element to search. Use this only when you need the full tree with frames.',
      { udid: udidSchema },
      { title: 'Describe All UI Elements', readOnlyHint: true, openWorldHint: true },
      uiDescribeAllHandler,
    )
  }

  if (!isToolFiltered('ui_tap')) {
    server.tool(
      'ui_tap',
      'Taps the screen. Target by ref (from ui_snapshot), by label, or by x/y coordinates in points — provide exactly one. '
      + 'Refs and labels are resolved to the element\'s center, which avoids retina-scaling mis-taps. '
      + 'Verify the result with ui_snapshot or wait_for_element.',
      {
        duration: durationSchema.describe('Press duration in seconds (e.g. "1.5" for a long press)'),
        udid: udidSchema,
        x: z.number().optional().describe('The x-coordinate in points (use with y)'),
        y: z.number().optional().describe('The y-coordinate in points (use with x)'),
        ref: refSchema,
        label: labelSchema,
        expect_appears: expectAppearsSchema,
        expect_gone: expectGoneSchema,
      },
      { title: 'UI Tap', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      uiTapHandler,
    )
  }

  if (!isToolFiltered('ui_type')) {
    server.tool(
      'ui_type',
      'Types text into the iOS Simulator (ASCII only, max 500 chars). Requires a focused text field: pass ref or label '
      + 'to tap the target field first, or tap it yourself with ui_tap beforehand.',
      {
        udid: udidSchema,
        text: z
          .string()
          .max(500)
          .regex(/^[\x20-\x7E]+$/)
          .describe('Text to input (printable ASCII only)'),
        ref: refSchema,
        label: labelSchema,
        expect_appears: expectAppearsSchema,
        expect_gone: expectGoneSchema,
      },
      { title: 'UI Type', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      uiTypeHandler,
    )
  }

  if (!isToolFiltered('ui_swipe')) {
    server.tool(
      'ui_swipe',
      'Swipes between two points on the screen (coordinates in points). Useful for scrolling, dismissing sheets, '
      + 'and pull-to-refresh. For scrolling lists, swipe from the center of the list.',
      {
        duration: durationSchema.describe('Swipe duration in seconds (e.g., 0.1)'),
        udid: udidSchema,
        x_start: z.number().describe('The starting x-coordinate'),
        y_start: z.number().describe('The starting y-coordinate'),
        x_end: z.number().describe('The ending x-coordinate'),
        y_end: z.number().describe('The ending y-coordinate'),
        delta: z
          .number()
          .optional()
          .describe('The size of each step in the swipe (default is 1)')
          .default(1),
        expect_appears: expectAppearsSchema,
        expect_gone: expectGoneSchema,
      },
      { title: 'UI Swipe', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      uiSwipeHandler,
    )
  }

  if (!isToolFiltered('ui_describe_point')) {
    server.tool(
      'ui_describe_point',
      'Returns the accessibility element at the given point coordinates. Useful to verify what a tap at (x, y) would hit.',
      {
        udid: udidSchema,
        x: z.number().describe('The x-coordinate'),
        y: z.number().describe('The y-coordinate'),
      },
      { title: 'Describe UI Point', readOnlyHint: true, openWorldHint: true },
      uiDescribePointHandler,
    )
  }
}
