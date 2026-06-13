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

function tapCall(calls: RecordedCall[]): RecordedCall | undefined {
  return calls.find(call => call.args[1] === 'tap')
}

describe('ui_tap', () => {
  it('builds idb args with -- separating user coordinates', async () => {
    const calls = recordCalls()

    const result = await uiTapHandler({ udid: UDID, x: 10, y: 20 })

    expect(result.isError).toBe(false)
    expect(tapCall(calls)?.args).toEqual([
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

    expect(tapCall(calls)?.args).toContain('--duration')
    expect(tapCall(calls)?.args).toContain('0.5')
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

  it('warns when the screen does not change after a tap', async () => {
    const tree = JSON.stringify([
      { type: 'Button', AXLabel: 'A', frame: { x: 0, y: 0, width: 10, height: 10 } },
    ])
    setRunner((_cmd, args) =>
      Promise.resolve({ stdout: args.includes('describe-all') ? tree : '', stderr: '' }),
    )

    const result = await uiTapHandler({ udid: UDID, x: 1, y: 2 })

    expect(result.isError).toBe(false)
    const block = result.content[0]
    expect(block?.type === 'text' && block.text).toContain('screen did not change')
    expect(result.structuredContent?.screenUnchanged).toBe(true)
  })

  it('does not warn when the screen changes after a tap', async () => {
    let calls = 0
    setRunner((_cmd, args) => {
      if (!args.includes('describe-all'))
        return Promise.resolve({ stdout: '', stderr: '' })
      calls += 1
      const tree = JSON.stringify([
        { type: 'Button', AXLabel: calls >= 2 ? 'B' : 'A', frame: { x: 0, y: 0, width: 10, height: 10 } },
      ])
      return Promise.resolve({ stdout: tree, stderr: '' })
    })

    const result = await uiTapHandler({ udid: UDID, x: 1, y: 2 })

    const block = result.content[0]
    expect(block?.type === 'text' && block.text).not.toContain('screen did not change')
    expect(result.structuredContent?.screenUnchanged).toBeUndefined()
  })

  it('skips the no-op check when an expectation is provided', async () => {
    const tree = JSON.stringify([
      { type: 'Button', AXLabel: 'A', frame: { x: 0, y: 0, width: 10, height: 10 } },
    ])
    const calls = recordCalls({ idb: { stdout: tree } })

    await uiTapHandler({ udid: UDID, x: 1, y: 2, expect_appears: 'A' })

    // No pre-tap fingerprint: the first idb call is the tap itself.
    expect(calls.find(c => c.args.includes('describe-all') && c.args[1] === 'describe-all')).toBeDefined()
    expect(calls[0]?.args[1]).toBe('tap')
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

  it('taps the target field first when a label is given', async () => {
    const tree = [
      {
        type: 'TextField',
        AXUniqueId: 'email-field',
        frame: { x: 20, y: 300, width: 353, height: 44 },
      },
    ]
    const calls: RecordedCall[] = []
    setRunner((cmd, args) => {
      calls.push({ cmd, args })
      const isDescribe = args.includes('describe-all')
      return Promise.resolve({ stdout: isDescribe ? JSON.stringify(tree) : '', stderr: '' })
    })

    const result = await uiTypeHandler({ udid: UDID, text: 'hello', label: 'email-field' })

    expect(result.isError).toBe(false)
    expect(calls.map(call => call.args[1])).toEqual(['describe-all', 'tap', 'text'])
  })
})

describe('ui_tap with ref/label targeting', () => {
  it('rejects calls without any target', async () => {
    recordCalls()

    const result = await uiTapHandler({ udid: UDID })

    expect(result.isError).toBe(true)
    const block = result.content[0]
    expect(block?.type === 'text' && block.text).toContain('Provide either')
  })
})
