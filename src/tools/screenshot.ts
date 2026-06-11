import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { isToolFiltered, udidSchema } from '../lib/constants'
import { getBootedDeviceId } from '../lib/devices'
import { errorResult, textResult } from '../lib/errors'
import { ensureAbsolutePath, getTmpRoot } from '../lib/paths'
import { idb, run } from '../lib/run'

export async function uiViewHandler({ udid }: { udid?: string }): Promise<CallToolResult> {
  try {
    const actualUdid = await getBootedDeviceId(udid)

    // Get screen dimensions in points from the accessibility tree
    const { stdout: uiDescribeOutput } = await idb(
      'ui',
      'describe-all',
      '--udid',
      actualUdid,
      '--json',
      '--nested',
    )

    let uiData: unknown
    try {
      uiData = JSON.parse(uiDescribeOutput)
    }
    catch {
      throw new Error('Failed to parse screen dimensions: idb returned invalid JSON')
    }

    const screenFrame = (uiData as Array<{ frame?: { width: unknown, height: unknown } }>)[0]?.frame
    if (
      !screenFrame
      || typeof screenFrame.width !== 'number'
      || typeof screenFrame.height !== 'number'
      || screenFrame.width <= 0
      || screenFrame.height <= 0
    ) {
      throw new Error('Could not determine valid screen dimensions from idb output')
    }

    const pointWidth = screenFrame.width
    const pointHeight = screenFrame.height

    // Unique file names (timestamp + random suffix) to avoid collisions
    const ts = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const tmpRoot = getTmpRoot()
    const rawPng = path.join(tmpRoot, `ui-view-${ts}-raw.png`)
    const compressedJpg = path.join(tmpRoot, `ui-view-${ts}-compressed.jpg`)

    await run('xcrun', [
      'simctl',
      'io',
      actualUdid,
      'screenshot',
      '--type=png',
      '--',
      rawPng,
    ])

    // Resize to point dimensions and compress to JPEG using sips
    await run('sips', [
      '-z',
      String(pointHeight),
      String(pointWidth),
      '-s',
      'format',
      'jpeg',
      '-s',
      'formatOptions',
      '80',
      rawPng,
      '--out',
      compressedJpg,
    ])

    const base64Data = fs.readFileSync(compressedJpg).toString('base64')
    try {
      fs.unlinkSync(rawPng)
      fs.unlinkSync(compressedJpg)
    }
    catch {
      // ignore cleanup errors — the temp dir is removed on server exit
    }

    return {
      isError: false,
      content: [
        {
          type: 'image',
          data: base64Data,
          mimeType: 'image/jpeg',
        },
        {
          type: 'text',
          text: 'Screenshot captured',
        },
      ],
    }
  }
  catch (error) {
    return errorResult('Error capturing screenshot', error)
  }
}

export interface ScreenshotParams {
  udid?: string
  output_path: string
  type?: 'png' | 'tiff' | 'bmp' | 'gif' | 'jpeg'
  display?: 'internal' | 'external'
  mask?: 'ignored' | 'alpha' | 'black'
}

export async function screenshotHandler({ udid, output_path, type, display, mask }: ScreenshotParams): Promise<CallToolResult> {
  try {
    const actualUdid = await getBootedDeviceId(udid)
    const absolutePath = ensureAbsolutePath(output_path)

    // simctl quirk: reports success on stderr, stdout stays blank
    const { stderr } = await run('xcrun', [
      'simctl',
      'io',
      actualUdid,
      'screenshot',
      ...(type ? [`--type=${type}`] : []),
      ...(display ? [`--display=${display}`] : []),
      ...(mask ? [`--mask=${mask}`] : []),
      '--',
      absolutePath,
    ])

    if (stderr && !stderr.includes('Wrote screenshot to'))
      throw new Error(stderr)

    return textResult(stderr || `Wrote screenshot to: ${absolutePath}`)
  }
  catch (error) {
    return errorResult('Error taking screenshot', error)
  }
}

export function registerScreenshotTools(server: McpServer): void {
  if (!isToolFiltered('ui_view')) {
    server.tool(
      'ui_view',
      'Get the image content of a compressed screenshot of the current simulator view',
      { udid: udidSchema },
      { title: 'View Screenshot', readOnlyHint: true, openWorldHint: true },
      uiViewHandler,
    )
  }

  if (!isToolFiltered('screenshot')) {
    server.tool(
      'screenshot',
      'Takes a screenshot of the iOS Simulator',
      {
        udid: udidSchema,
        output_path: z
          .string()
          .max(1024)
          .describe(
            'File path where the screenshot will be saved. If relative, it uses the directory specified by the `IOS_SIMULATOR_MCP_DEFAULT_OUTPUT_DIR` env var, or `~/Downloads` if not set.',
          ),
        type: z
          .enum(['png', 'tiff', 'bmp', 'gif', 'jpeg'])
          .optional()
          .describe('Image format (png, tiff, bmp, gif, or jpeg). Default is png.'),
        display: z
          .enum(['internal', 'external'])
          .optional()
          .describe('Display to capture (internal or external). Default depends on device type.'),
        mask: z
          .enum(['ignored', 'alpha', 'black'])
          .optional()
          .describe('For non-rectangular displays, handle the mask by policy (ignored, alpha, or black)'),
      },
      { title: 'Take Screenshot', readOnlyHint: false, openWorldHint: true },
      screenshotHandler,
    )
  }
}
