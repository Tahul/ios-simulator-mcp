import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { setFetchImpl } from '../src/lib/baguette'
import { cleanupStaleTmpDirs } from '../src/lib/paths'
import { setRunner } from '../src/lib/run'
import { resetRecordingState } from '../src/tools/recording'
import { cleanupSessionHandler } from '../src/tools/session'

const UDID = '37A360EC-75F9-4AEC-8EFA-10F4A58D8CCA'

function text(result: { content: Array<{ type: string, text?: string }> }): string {
  const block = result.content[0]
  return block?.type === 'text' ? block.text ?? '' : ''
}

beforeEach(() => {
  // Device resolution prefers baguette; keep it offline so tests exercise the
  // simctl fallback (the runner seam) deterministically.
  setFetchImpl((async () => { throw new Error('offline') }) as any)
})

afterEach(() => {
  setRunner(null)
  setFetchImpl(null)
  resetRecordingState()
})

describe('cleanupStaleTmpDirs', () => {
  it('removes leftover ios-simulator-mcp-* directories', () => {
    const stale1 = fs.mkdtempSync(path.join(os.tmpdir(), 'ios-simulator-mcp-'))
    const stale2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ios-simulator-mcp-'))
    fs.writeFileSync(path.join(stale1, 'leftover.png'), '')

    const removed = cleanupStaleTmpDirs()

    expect(removed).toBeGreaterThanOrEqual(2)
    expect(fs.existsSync(stale1)).toBe(false)
    expect(fs.existsSync(stale2)).toBe(false)
  })
})

describe('cleanup_session', () => {
  it('runs all default steps and reports each one', async () => {
    const calls: string[][] = []
    setRunner((cmd, args) => {
      calls.push([cmd, ...args])
      if (cmd === 'pkill') {
        const error = new Error('no match') as Error & { code: number }
        error.code = 1
        return Promise.reject(error)
      }
      return Promise.resolve({ stdout: '', stderr: '' })
    })

    const result = await cleanupSessionHandler({ udid: UDID })

    expect(result.isError).toBe(false)
    const output = text(result)
    expect(output).toContain('[ok] stop recordings: No active recording found.')
    expect(output).toContain('[ok] remove stale temp files')
    expect(output).toContain('[ok] clear status bar overrides')
    expect(output).toContain('[ok] clear simulated location')
    expect(calls).toContainEqual(['xcrun', 'simctl', 'status_bar', UDID, 'clear'])
    expect(calls).toContainEqual(['xcrun', 'simctl', 'location', UDID, 'clear'])
  })

  it('terminates requested apps and tolerates per-step failures', async () => {
    setRunner((cmd, args) => {
      if (cmd === 'pkill') {
        const error = new Error('no match') as Error & { code: number }
        error.code = 1
        return Promise.reject(error)
      }
      if (args[1] === 'terminate' && args[3] === 'com.example.dead')
        return Promise.reject(new Error('found nothing to terminate'))
      return Promise.resolve({ stdout: '', stderr: '' })
    })

    const result = await cleanupSessionHandler({
      udid: UDID,
      terminate_apps: ['com.example.app', 'com.example.dead'],
    })

    expect(result.isError).toBe(false)
    const output = text(result)
    expect(output).toContain('[ok] terminate com.example.app')
    expect(output).toContain('[failed] terminate com.example.dead: found nothing to terminate')
  })

  it('skips device steps when no simulator is booted', async () => {
    setRunner((cmd) => {
      if (cmd === 'pkill') {
        const error = new Error('no match') as Error & { code: number }
        error.code = 1
        return Promise.reject(error)
      }
      // simctl list devices --json with nothing booted
      return Promise.resolve({ stdout: '{"devices":{}}', stderr: '' })
    })

    const result = await cleanupSessionHandler({})

    expect(result.isError).toBe(false)
    const output = text(result)
    expect(output).toContain('[skipped] device cleanup: no booted simulator found')
    expect(output).toContain('[ok] stop recordings')
  })

  it('honors opt-out flags', async () => {
    const calls: string[][] = []
    setRunner((cmd, args) => {
      calls.push([cmd, ...args])
      return Promise.resolve({ stdout: '', stderr: '' })
    })

    const result = await cleanupSessionHandler({
      udid: UDID,
      stop_recordings: false,
      clear_status_bar: false,
      clear_location: false,
      remove_temp_files: false,
    })

    expect(result.isError).toBe(false)
    expect(calls).toHaveLength(0)
  })
})
