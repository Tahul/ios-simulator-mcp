import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import pkg from '../package.json' with { type: 'json' }
import { registerAppTools } from './tools/apps'
import { registerFindElementTool } from './tools/find-element'
import { registerRecordingTools } from './tools/recording'
import { registerScreenshotTools } from './tools/screenshot'
import { registerSimulatorTools } from './tools/simulator'
import { registerUiTools } from './tools/ui'

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'ios-simulator',
    version: pkg.version,
  })

  registerSimulatorTools(server)
  registerUiTools(server)
  registerFindElementTool(server)
  registerScreenshotTools(server)
  registerRecordingTools(server)
  registerAppTools(server)

  return server
}
