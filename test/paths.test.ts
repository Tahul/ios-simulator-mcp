import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'bun:test'
import { ensureAbsolutePath, expandTilde, prepareOutputPath } from '../src/lib/paths'

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

describe('prepareOutputPath', () => {
  it('creates missing parent directories recursively and returns the absolute path', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'prep-'))
    try {
      const target = path.join(base, 'a', 'b', 'c', 'shot.jpg')
      const result = prepareOutputPath(target)

      expect(result).toBe(target)
      expect(fs.existsSync(path.dirname(target))).toBe(true)
    }
    finally {
      fs.rmSync(base, { recursive: true, force: true })
    }
  })
})
