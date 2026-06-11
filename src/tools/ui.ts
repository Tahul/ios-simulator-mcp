import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { isToolFiltered, udidSchema } from '../lib/constants'
import { getBootedDeviceId } from '../lib/devices'
import { errorResult, textResult } from '../lib/errors'
import { idb } from '../lib/run'

const durationSchema = z
  .string()
  .regex(/^\d+(?:\.\d+)?$/)
  .optional()

export interface UiTapParams {
  duration?: string
  udid?: string
  x: number
  y: number
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

export async function uiTapHandler({ duration, udid, x, y }: UiTapParams): Promise<CallToolResult> {
  try {
    const actualUdid = await getBootedDeviceId(udid)

    await idb(
      'ui',
      'tap',
      '--udid',
      actualUdid,
      ...(duration ? ['--duration', duration] : []),
      '--json',
      // `--` separates options from user-provided positional arguments so
      // they cannot be misinterpreted as flags.
      '--',
      String(x),
      String(y),
    )

    return textResult('Tapped successfully')
  }
  catch (error) {
    return errorResult('Error tapping on the screen', error)
  }
}

export async function uiTypeHandler({ udid, text }: { udid?: string, text: string }): Promise<CallToolResult> {
  try {
    const actualUdid = await getBootedDeviceId(udid)

    await idb(
      'ui',
      'text',
      '--udid',
      actualUdid,
      '--',
      text,
    )

    return textResult('Typed successfully')
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
}

export async function uiSwipeHandler({ duration, udid, x_start, y_start, x_end, y_end, delta }: UiSwipeParams): Promise<CallToolResult> {
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

    return textResult('Swiped successfully')
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
      'Describes accessibility information for the entire screen in the iOS Simulator',
      { udid: udidSchema },
      { title: 'Describe All UI Elements', readOnlyHint: true, openWorldHint: true },
      uiDescribeAllHandler,
    )
  }

  if (!isToolFiltered('ui_tap')) {
    server.tool(
      'ui_tap',
      'Tap on the screen in the iOS Simulator',
      {
        duration: durationSchema.describe('Press duration'),
        udid: udidSchema,
        x: z.number().describe('The x-coordinate'),
        y: z.number().describe('The y-coordinate'),
      },
      { title: 'UI Tap', readOnlyHint: false, openWorldHint: true },
      uiTapHandler,
    )
  }

  if (!isToolFiltered('ui_type')) {
    server.tool(
      'ui_type',
      'Input text into the iOS Simulator',
      {
        udid: udidSchema,
        text: z
          .string()
          .max(500)
          .regex(/^[\x20-\x7E]+$/)
          .describe('Text to input'),
      },
      { title: 'UI Type', readOnlyHint: false, openWorldHint: true },
      uiTypeHandler,
    )
  }

  if (!isToolFiltered('ui_swipe')) {
    server.tool(
      'ui_swipe',
      'Swipe on the screen in the iOS Simulator',
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
      },
      { title: 'UI Swipe', readOnlyHint: false, openWorldHint: true },
      uiSwipeHandler,
    )
  }

  if (!isToolFiltered('ui_describe_point')) {
    server.tool(
      'ui_describe_point',
      'Returns the accessibility element at given co-ordinates on the iOS Simulator\'s screen',
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
