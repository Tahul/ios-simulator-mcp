import type { RunResult } from '../src/lib/run'
import { afterEach, describe, expect, it } from 'bun:test'
import { setRunner } from '../src/lib/run'
import { uiTapHandler, uiTypeHandler } from '../src/tools/ui'

const UDID = '37A360EC-75F9-4AEC-8EFA-10F4A58D8CCA'

interface RecordedCall {
  cmd: string
  args: string[]
}

function recordCalls(results: Record<string, Partial<RunResult>> = {}): RecordedCall[] {
  const calls: RecordedCall[] = []
  setRunner((cmd, args) => {
    calls.push({ cmd, args })
    const result = results[cmd] ?? {}
    return Promise.resolve({ stdout: result.stdout ?? '', stderr: result.stderr ?? '' })
  })
  return calls
}

afterEach(() => {
  setRunner(null)
})

describe('ui_tap', () => {
  it('builds idb args with -- separating user coordinates', async () => {
    const calls = recordCalls()

    const result = await uiTapHandler({ udid: UDID, x: 10, y: 20 })

    expect(result.isError).toBe(false)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.args).toEqual([
      'ui',
      'tap',
      '--udid',
      UDID,
      '--json',
      '--',
      '10',
      '20',
    ])
  })

  it('includes --duration when provided', async () => {
    const calls = recordCalls()

    await uiTapHandler({ udid: UDID, x: 1, y: 2, duration: '0.5' })

    expect(calls[0]?.args).toContain('--duration')
    expect(calls[0]?.args).toContain('0.5')
  })

  it('does not treat stderr warnings as failures', async () => {
    recordCalls({ idb: { stderr: 'some non-fatal idb warning' } })

    const result = await uiTapHandler({ udid: UDID, x: 1, y: 2 })

    expect(result.isError).toBe(false)
  })

  it('falls back to the booted simulator when udid is omitted', async () => {
    const deviceList = JSON.stringify({
      devices: {
        runtime: [{ udid: UDID, name: 'iPhone 15', state: 'Booted' }],
      },
    })
    const calls = recordCalls({ xcrun: { stdout: deviceList } })

    const result = await uiTapHandler({ x: 5, y: 6 })

    expect(result.isError).toBe(false)
    expect(calls[0]?.cmd).toBe('xcrun')
    expect(calls[0]?.args).toEqual(['simctl', 'list', 'devices', '--json'])
    expect(calls[1]?.args).toContain(UDID)
  })

  it('returns an error result when the command fails', async () => {
    setRunner(() => Promise.reject(new Error('idb not found')))

    const result = await uiTapHandler({ udid: UDID, x: 1, y: 2 })

    expect(result.isError).toBe(true)
    const block = result.content[0]
    expect(block?.type === 'text' && block.text).toContain('idb not found')
    expect(block?.type === 'text' && block.text).toContain('Troubleshooting Guide')
  })
})

describe('ui_type', () => {
  it('separates user text with --', async () => {
    const calls = recordCalls()

    await uiTypeHandler({ udid: UDID, text: '--rm -rf' })

    expect(calls[0]?.args).toEqual([
      'ui',
      'text',
      '--udid',
      UDID,
      '--',
      '--rm -rf',
    ])
  })
})
