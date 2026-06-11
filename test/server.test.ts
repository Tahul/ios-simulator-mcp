import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'bun:test'
import { isToolFiltered } from '../src/lib/constants'
import { resolveIdbPath } from '../src/lib/run'
import { createServer } from '../src/server'

const ORIGINAL_FILTER = process.env.IOS_SIMULATOR_MCP_FILTERED_TOOLS

afterEach(() => {
  if (ORIGINAL_FILTER === undefined)
    delete process.env.IOS_SIMULATOR_MCP_FILTERED_TOOLS
  else
    process.env.IOS_SIMULATOR_MCP_FILTERED_TOOLS = ORIGINAL_FILTER
})

function registeredToolNames(server: ReturnType<typeof createServer>): string[] {
  // _registeredTools is private SDK state; acceptable to peek at in tests
  const tools = (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools
  return Object.keys(tools)
}

describe('isToolFiltered', () => {
  it('returns false when the env var is unset', () => {
    delete process.env.IOS_SIMULATOR_MCP_FILTERED_TOOLS
    expect(isToolFiltered('ui_tap')).toBe(false)
  })

  it('matches trimmed, comma-separated entries', () => {
    process.env.IOS_SIMULATOR_MCP_FILTERED_TOOLS = 'ui_tap, screenshot'
    expect(isToolFiltered('ui_tap')).toBe(true)
    expect(isToolFiltered('screenshot')).toBe(true)
    expect(isToolFiltered('ui_swipe')).toBe(false)
  })
})

describe('createServer', () => {
  it('registers all tools by default', () => {
    delete process.env.IOS_SIMULATOR_MCP_FILTERED_TOOLS
    const names = registeredToolNames(createServer())
    expect(names.sort()).toEqual([
      'get_booted_sim_id',
      'install_app',
      'launch_app',
      'open_simulator',
      'record_video',
      'screenshot',
      'stop_recording',
      'ui_describe_all',
      'ui_describe_point',
      'ui_find_element',
      'ui_swipe',
      'ui_tap',
      'ui_type',
      'ui_view',
    ])
  })

  it('skips tools listed in IOS_SIMULATOR_MCP_FILTERED_TOOLS', () => {
    process.env.IOS_SIMULATOR_MCP_FILTERED_TOOLS = 'record_video,stop_recording'
    const names = registeredToolNames(createServer())
    expect(names).not.toContain('record_video')
    expect(names).not.toContain('stop_recording')
    expect(names).toContain('ui_tap')
  })
})

describe('resolveIdbPath', () => {
  it('defaults to "idb" when no custom path is set', () => {
    expect(resolveIdbPath(undefined)).toBe('idb')
  })

  it('returns an existing custom path', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idb-test-'))
    const idbPath = path.join(dir, 'idb')
    fs.writeFileSync(idbPath, '')
    expect(resolveIdbPath(idbPath)).toBe(idbPath)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('throws when the custom path does not exist', () => {
    expect(() => resolveIdbPath('/nonexistent/idb')).toThrow('does not exist')
  })
})
