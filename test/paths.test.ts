import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'bun:test'
import { ensureAbsolutePath, expandTilde } from '../src/lib/paths'

const ORIGINAL_ENV = process.env.IOS_SIMULATOR_MCP_DEFAULT_OUTPUT_DIR

afterEach(() => {
  if (ORIGINAL_ENV === undefined)
    delete process.env.IOS_SIMULATOR_MCP_DEFAULT_OUTPUT_DIR
  else
    process.env.IOS_SIMULATOR_MCP_DEFAULT_OUTPUT_DIR = ORIGINAL_ENV
})

describe('expandTilde', () => {
  it('expands a leading ~/', () => {
    expect(expandTilde('~/foo/bar.png')).toBe(path.join(os.homedir(), 'foo/bar.png'))
  })

  it('leaves other paths untouched', () => {
    expect(expandTilde('/tmp/foo')).toBe('/tmp/foo')
    expect(expandTilde('relative/foo')).toBe('relative/foo')
  })
})

describe('ensureAbsolutePath', () => {
  it('returns absolute paths as-is', () => {
    expect(ensureAbsolutePath('/tmp/shot.png')).toBe('/tmp/shot.png')
  })

  it('expands ~/ paths', () => {
    expect(ensureAbsolutePath('~/shot.png')).toBe(path.join(os.homedir(), 'shot.png'))
  })

  it('joins relative paths with ~/Downloads by default', () => {
    delete process.env.IOS_SIMULATOR_MCP_DEFAULT_OUTPUT_DIR
    expect(ensureAbsolutePath('shot.png')).toBe(path.join(os.homedir(), 'Downloads', 'shot.png'))
  })

  it('honors IOS_SIMULATOR_MCP_DEFAULT_OUTPUT_DIR', () => {
    process.env.IOS_SIMULATOR_MCP_DEFAULT_OUTPUT_DIR = '/var/output'
    expect(ensureAbsolutePath('shot.png')).toBe('/var/output/shot.png')
  })

  it('expands tilde in IOS_SIMULATOR_MCP_DEFAULT_OUTPUT_DIR', () => {
    process.env.IOS_SIMULATOR_MCP_DEFAULT_OUTPUT_DIR = '~/captures'
    expect(ensureAbsolutePath('shot.png')).toBe(path.join(os.homedir(), 'captures', 'shot.png'))
  })
})
