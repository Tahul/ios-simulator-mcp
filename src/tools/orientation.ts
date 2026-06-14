import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { Orientation } from '../lib/baguette'
import { z } from 'zod'
import { resetScreenSizeCache, resolveBootedUdid, setOrientation } from '../lib/baguette'
import { isToolFiltered, udidSchema } from '../lib/constants'
import { errorResult, textResult } from '../lib/errors'

const ORIENTATIONS = ['portrait', 'landscape-left', 'landscape-right', 'portrait-upside-down'] as const

export interface SetOrientationParams {
  udid?: string
  value: Orientation
}

export async function setOrientationHandler({ udid, value }: SetOrientationParams): Promise<CallToolResult> {
  try {
    const actualUdid = await resolveBootedUdid(udid)
    await setOrientation(actualUdid, value)
    // Rotating swaps screen width/height; drop the cached size so the next
    // gesture re-resolves it.
    resetScreenSizeCache()
    return textResult(`Orientation set to ${value}.`)
  }
  catch (error) {
    return errorResult('Error setting orientation', error)
  }
}

export function registerOrientationTools(server: McpServer): void {
  if (isToolFiltered('set_orientation'))
    return

  server.tool(
    'set_orientation',
    'Rotates the booted simulator to portrait, landscape-left, landscape-right, or portrait-upside-down. Rotating '
    + 'changes the screen point size, so gesture coordinates after a rotation use the new dimensions automatically.',
    {
      udid: udidSchema,
      value: z.enum(ORIENTATIONS).describe('Target orientation'),
    },
    { title: 'Set Orientation', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    setOrientationHandler,
  )
}
