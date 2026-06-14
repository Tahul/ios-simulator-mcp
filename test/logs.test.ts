import { afterEach, describe, expect, it } from 'bun:test'
import { setFetchImpl, setLogCollector } from '../src/lib/baguette'
import { appLogsHandler } from '../src/tools/logs'

const UDID = '37A360EC-75F9-4AEC-8EFA-10F4A58D8CCA'

afterEach(() => {
  setLogCollector(null)
  setFetchImpl(null)
})

describe('app_logs', () => {
  it('returns collected lines with a structured payload', async () => {
    setLogCollector(() => Promise.resolve(['line one', 'line two']))

    const result = await appLogsHandler({ udid: UDID })

    expect(result.isError).toBe(false)
    const block = result.content[0]
    expect(block?.type === 'text' && block.text).toContain('line one')
    expect(result.structuredContent?.totalLines).toBe(2)
    expect(result.structuredContent?.truncated).toBe(false)
  })

  it('passes filters through to the collector', async () => {
    let captured: any
    setLogCollector((udid, opts) => {
      captured = { udid, opts }
      return Promise.resolve(['x'])
    })

    await appLogsHandler({ udid: UDID, bundle_id: 'com.example.app', level: 'debug', max_lines: 50, window_s: 2 })

    expect(captured.udid).toBe(UDID)
    expect(captured.opts).toMatchObject({ bundleId: 'com.example.app', level: 'debug', maxLines: 50, windowMs: 2000 })
  })

  it('reports an empty capture clearly', async () => {
    setLogCollector(() => Promise.resolve([]))
    const result = await appLogsHandler({ udid: UDID, window_s: 1 })
    const block = result.content[0]
    expect(block?.type === 'text' && block.text).toContain('No log entries')
  })

  it('flags truncation when maxLines is hit', async () => {
    setLogCollector(() => Promise.resolve(['a', 'b', 'c']))
    const result = await appLogsHandler({ udid: UDID, max_lines: 3 })
    expect(result.structuredContent?.truncated).toBe(true)
  })
})
