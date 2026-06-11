import { afterEach, describe, expect, it } from 'bun:test'
import { setRunner } from '../src/lib/run'
import { appLogsHandler, buildLogArgs } from '../src/tools/logs'

const UDID = '37A360EC-75F9-4AEC-8EFA-10F4A58D8CCA'

afterEach(() => {
  setRunner(null)
})

describe('buildLogArgs', () => {
  it('builds a bounded log show command', () => {
    expect(buildLogArgs({ udid: UDID, sinceS: 60 })).toEqual([
      'simctl',
      'spawn',
      UDID,
      'log',
      'show',
      '--style',
      'compact',
      '--last',
      '60s',
    ])
  })

  it('adds a process predicate', () => {
    const args = buildLogArgs({ udid: UDID, process: 'Spotter', sinceS: 30 })
    expect(args).toContain('--predicate')
    expect(args[args.indexOf('--predicate') + 1]).toBe('process == "Spotter"')
  })

  it('ANDs process and raw predicates', () => {
    const args = buildLogArgs({
      udid: UDID,
      process: 'Spotter',
      predicate: 'subsystem CONTAINS "react"',
      sinceS: 30,
    })
    expect(args[args.indexOf('--predicate') + 1]).toBe(
      'process == "Spotter" AND (subsystem CONTAINS "react")',
    )
  })
})

describe('app_logs handler', () => {
  it('caps output to max_lines, newest last', async () => {
    const lines = Array.from({ length: 300 }, (_, i) => `line ${i + 1}`)
    setRunner(() => Promise.resolve({ stdout: lines.join('\n'), stderr: '' }))

    const result = await appLogsHandler({ udid: UDID, max_lines: 100 })

    expect(result.isError).toBe(false)
    const block = result.content[0]
    const text = block?.type === 'text' ? block.text : ''
    expect(text).toContain('showing last 100 of 300 lines')
    expect(text).toContain('line 300')
    expect(text).not.toContain('line 200\n')
  })

  it('reports when there are no entries', async () => {
    setRunner(() => Promise.resolve({ stdout: '', stderr: '' }))

    const result = await appLogsHandler({ udid: UDID, process: 'Spotter' })

    expect(result.isError).toBe(false)
    const block = result.content[0]
    expect(block?.type === 'text' && block.text).toContain('No log entries in the last 60s for process "Spotter"')
  })
})
