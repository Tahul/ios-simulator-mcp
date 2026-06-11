import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { isToolFiltered } from '../lib/constants'
import { getBootedDevice } from '../lib/devices'
import { errorResult, textResult } from '../lib/errors'
import { run } from '../lib/run'

export async function getBootedSimIdHandler(): Promise<CallToolResult> {
  try {
    const { id, name } = await getBootedDevice()
    return textResult(`Booted Simulator: "${name}". UUID: "${id}"`)
  }
  catch (error) {
    return errorResult('Error', error)
  }
}

export async function openSimulatorHandler(): Promise<CallToolResult> {
  try {
    await run('open', ['-a', 'Simulator.app'])
    return textResult('Simulator.app opened successfully')
  }
  catch (error) {
    return errorResult('Error opening Simulator.app', error)
  }
}

export function registerSimulatorTools(server: McpServer): void {
  if (!isToolFiltered('get_booted_sim_id')) {
    server.tool(
      'get_booted_sim_id',
      'Get the ID of the currently booted iOS simulator',
      { title: 'Get Booted Simulator ID', readOnlyHint: true, openWorldHint: true },
      getBootedSimIdHandler,
    )
  }

  if (!isToolFiltered('open_simulator')) {
    server.tool(
      'open_simulator',
      'Opens the iOS Simulator application',
      { title: 'Open Simulator', readOnlyHint: false, openWorldHint: true },
      openSimulatorHandler,
    )
  }
}
