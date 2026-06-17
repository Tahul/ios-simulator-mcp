import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { Buffer } from 'node:buffer'
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { captureScreenshot, resolveBootedUdid } from '../lib/baguette'
import { isToolFiltered, udidSchema } from '../lib/constants'
import { errorResult, textResult } from '../lib/errors'
import { ensureAbsolutePath } from '../lib/paths'

function inlineImageResult(base64Data: string): CallToolResult {
  return {
    isError: false,
    content: [
      { type: 'image', data: base64Data, mimeType: 'image/jpeg' },
      { type: 'text', text: 'Screenshot captured (coordinates in points match ui_snapshot / ui_tap)' },
    ],
  }
}

export async function uiViewHandler({ udid }: { udid?: string }): Promise<CallToolResult> {
  try {
    const actualUdid = await resolveBootedUdid(udid)
    return inlineImageResult(await captureScreenshot(actualUdid))
  }
  catch (error) {
    return errorResult('Error capturing screenshot', error)
  }
}

export interface ScreenshotParams {
  udid?: string
  output_path?: string
  quality?: number
  scale?: number
}

export async function screenshotHandler({ udid, output_path, quality, scale }: ScreenshotParams): Promise<CallToolResult> {
  try {
    const actualUdid = await resolveBootedUdid(udid)
    const base64 = await captureScreenshot(actualUdid, { quality, scale })

    if (!output_path)
      return inlineImageResult(base64)

    const absolutePath = ensureAbsolutePath(output_path)
    // Create the parent dir so a nested output_path (e.g. artifacts/shot.jpg)
    // doesn't fail with ENOENT.
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true })
    fs.writeFileSync(absolutePath, Buffer.from(base64, 'base64'))
    return textResult(`Wrote screenshot to: ${absolutePath}`)
  }
  catch (error) {
    return errorResult('Error taking screenshot', error)
  }
}

export function registerScreenshotTools(server: McpServer): void {
  if (!isToolFiltered('ui_view')) {
    server.tool(
      'ui_view',
      'Returns a JPEG screenshot of the current simulator screen as an inline image; coordinates in the image are in '
      + 'points and match ui_tap / ui_snapshot. Use this to visually verify state; pair with ui_snapshot for structure. '
      + 'If the simulator is idle it may emit no frame — send a gesture to wake it, then retry.',
      { udid: udidSchema },
      { title: 'View Screenshot', readOnlyHint: true, openWorldHint: true },
      uiViewHandler,
    )
  }

  if (!isToolFiltered('screenshot')) {
    server.tool(
      'screenshot',
      'Takes a JPEG screenshot. Without output_path, returns an inline image (same as ui_view). With output_path, saves '
      + 'the JPEG to that file. quality (0-1) and scale (integer downscale divisor) tune size.',
      {
        udid: udidSchema,
        output_path: z.string().max(1024).optional().describe('File path to save the JPEG. Relative paths resolve against IOS_SIMULATOR_MCP_DEFAULT_OUTPUT_DIR or ~/Downloads. Omit for an inline image.'),
        quality: z.number().min(0).max(1).optional().describe('JPEG quality 0-1 (default 0.85)'),
        scale: z.number().int().min(1).max(4).optional().describe('Integer downscale divisor: 1=native, 2=half, 3=third (default 1)'),
      },
      { title: 'Take Screenshot', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      screenshotHandler,
    )
  }
}
