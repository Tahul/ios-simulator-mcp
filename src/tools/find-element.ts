import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { isToolFiltered, udidSchema } from '../lib/constants'
import { getBootedDeviceId } from '../lib/devices'
import { errorResult, textResult } from '../lib/errors'
import { idb } from '../lib/run'

export type MatchMode = 'substring' | 'exact'

export interface FindCriteria {
  search: string[]
  type?: string
  matchMode: MatchMode
  caseSensitive: boolean
}

export type UiElement = Record<string, unknown>

export function matchesSearch(
  value: string | null | undefined,
  term: string,
  mode: MatchMode,
  sensitive: boolean,
): boolean {
  if (value == null)
    return false
  const v = sensitive ? value : value.toLowerCase()
  const t = sensitive ? term : term.toLowerCase()
  return mode === 'exact' ? v === t : v.includes(t)
}

/** Recursively collects elements matching the search criteria. */
export function findElements(elements: UiElement[], criteria: FindCriteria): UiElement[] {
  const { search, type, matchMode, caseSensitive } = criteria
  const results: UiElement[] = []

  for (const element of elements) {
    const label = element.AXLabel as string | null
    const uniqueId = element.AXUniqueId as string | null
    const elementType = element.type as string | undefined

    const matchesAnySearch = search.some(
      term =>
        matchesSearch(label, term, matchMode, caseSensitive)
        || matchesSearch(uniqueId, term, matchMode, caseSensitive),
    )

    const matchesType
      = type == null
        || (elementType != null && elementType.toLowerCase() === type.toLowerCase())

    if (matchesAnySearch && matchesType)
      results.push(element)

    const children = element.children as UiElement[] | undefined
    if (children && children.length > 0)
      results.push(...findElements(children, criteria))
  }

  return results
}

export interface UiFindElementParams {
  udid?: string
  search: string[]
  type?: string
  matchMode: MatchMode
  caseSensitive: boolean
}

export async function uiFindElementHandler({ search, type, matchMode, caseSensitive, udid }: UiFindElementParams): Promise<CallToolResult> {
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

    const uiData = JSON.parse(stdout) as UiElement[]
    const results = findElements(uiData, { search, type, matchMode, caseSensitive })

    return textResult(JSON.stringify(results))
  }
  catch (error) {
    return errorResult('Error finding UI elements', error)
  }
}

export function registerFindElementTool(server: McpServer): void {
  if (isToolFiltered('ui_find_element'))
    return

  server.tool(
    'ui_find_element',
    'Searches the accessibility tree and returns full JSON for elements matching the given criteria (label, '
    + 'identifier, type). Use when you need element details like exact frames; for general screen orientation '
    + 'prefer ui_snapshot, and to wait for something to appear use wait_for_element.',
    {
      udid: udidSchema,
      search: z
        .array(z.string().min(1))
        .min(1)
        .describe(
          'Array of search strings. An element matches if ANY string matches against its AXLabel or AXUniqueId',
        ),
      type: z
        .string()
        .optional()
        .describe(
          'Filter by element type (e.g. \'Button\', \'StaticText\', \'Group\'). Case-insensitive exact match',
        ),
      matchMode: z
        .enum(['substring', 'exact'])
        .optional()
        .default('substring')
        .describe('Match mode for search strings: \'substring\' (default) or \'exact\''),
      caseSensitive: z
        .boolean()
        .optional()
        .default(false)
        .describe('Whether search matching is case-sensitive (default: false)'),
    },
    { title: 'Find UI Element', readOnlyHint: true, openWorldHint: true },
    uiFindElementHandler,
  )
}
