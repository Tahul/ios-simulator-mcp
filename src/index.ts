#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { cleanupTmpRoot } from './lib/paths'
import { createServer } from './server'

const server = createServer()

async function main(): Promise<void> {
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

process.stdin.on('close', () => {
  // stderr only: stdout is the MCP protocol channel
  console.error('iOS Simulator MCP Server closed')
  void server.close()
  cleanupTmpRoot()
})

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
