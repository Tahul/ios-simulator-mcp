import { z } from 'zod'

/**
 * Strict UDID/UUID pattern: 8-4-4-4-12 hexadecimal characters
 * (e.g. 37A360EC-75F9-4AEC-8EFA-10F4A58D8CCA)
 */
export const UDID_REGEX
  = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i

/** Shared zod schema for the optional target simulator UDID. */
export const udidSchema = z
  .string()
  .regex(UDID_REGEX)
  .optional()
  .describe(
    'Target simulator UDID. Omit to use the currently booted simulator (or the one set via select_default_device). '
    + 'Only pass this when several simulators are booted and you must disambiguate.',
  )

/** Checks the IOS_SIMULATOR_MCP_FILTERED_TOOLS env var for a tool name. */
export function isToolFiltered(toolName: string): boolean {
  const raw = process.env.IOS_SIMULATOR_MCP_FILTERED_TOOLS
  if (!raw)
    return false
  return raw.split(',').map(tool => tool.trim()).includes(toolName)
}
