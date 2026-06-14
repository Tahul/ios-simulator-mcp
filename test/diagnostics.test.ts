import { afterEach, describe, expect, it } from 'bun:test'
import { setFetchImpl } from '../src/lib/baguette'
import { setRunner } from '../src/lib/run'
import { doctorHandler } from '../src/tools/diagnostics'

const BAG_LIST = JSON.stringify({
  running: [{ udid: 'AAA', name: 'iPhone 17 Pro', runtime: 'iOS 26.5', state: 'Booted' }],
  available: [{ udid: 'BBB', name: 'iPhone 17', runtime: 'iOS 26.5', state: 'Shutdown' }],
})

const realFetch = globalThis.fetch

// baguette list goes through the fetch seam; return the device list JSON.
function stubBaguette(reachable: boolean): void {
  setFetchImpl((async () => {
    if (!reachable)
      throw new Error('connection refused')
    return { ok: true, status: 200, text: async () => BAG_LIST, arrayBuffer: async () => new ArrayBuffer(0) }
  }) as any)
}

afterEach(() => {
  setRunner(null)
  setFetchImpl(null)
  globalThis.fetch = realFetch
})

describe('doctor', () => {
  it('reports a healthy environment', async () => {
    setRunner((cmd, args) => {
      if (cmd === 'xcode-select')
        return Promise.resolve({ stdout: '/Applications/Xcode.app/Contents/Developer', stderr: '' })
      if (args.includes('list'))
        return Promise.resolve({ stdout: JSON.stringify({ devices: { rt: [{ udid: 'AAA', name: 'iPhone 17 Pro', state: 'Booted', isAvailable: true }] } }), stderr: '' })
      return Promise.resolve({ stdout: 'ok', stderr: '' })
    })
    stubBaguette(true)
    globalThis.fetch = (async () => ({ ok: true } as Response)) as unknown as typeof fetch

    const result = await doctorHandler({})

    expect(result.isError).toBe(false)
    const struct = result.structuredContent as { healthy: boolean, checks: Array<{ name: string, ok: boolean }> }
    expect(struct.healthy).toBe(true)
    const baguette = struct.checks.find(c => c.name === 'baguette')
    expect(baguette?.ok).toBe(true)
  })

  it('flags an unreachable baguette server as blocking', async () => {
    setRunner((cmd, args) => {
      if (cmd === 'xcode-select')
        return Promise.resolve({ stdout: '/dev', stderr: '' })
      if (args.includes('list'))
        return Promise.resolve({ stdout: '{"devices":{}}', stderr: '' })
      return Promise.resolve({ stdout: 'ok', stderr: '' })
    })
    stubBaguette(false)
    globalThis.fetch = (async () => { throw new Error('no metro') }) as unknown as typeof fetch

    const result = await doctorHandler({})

    const struct = result.structuredContent as { healthy: boolean, checks: Array<{ name: string, ok: boolean }> }
    expect(struct.healthy).toBe(false)
    expect(struct.checks.find(c => c.name === 'baguette')?.ok).toBe(false)
  })

  it('does not let a missing optional idb block health', async () => {
    setRunner((cmd, args) => {
      if (cmd === 'xcode-select')
        return Promise.resolve({ stdout: '/dev', stderr: '' })
      if (args.includes('list'))
        return Promise.resolve({ stdout: '{"devices":{}}', stderr: '' })
      if (args.includes('help'))
        return Promise.resolve({ stdout: 'ok', stderr: '' })
      return Promise.reject(new Error('idb: command not found'))
    })
    stubBaguette(true)
    globalThis.fetch = (async () => ({ ok: true } as Response)) as unknown as typeof fetch

    const result = await doctorHandler({})

    const struct = result.structuredContent as { healthy: boolean, checks: Array<{ name: string, ok: boolean }> }
    const idb = struct.checks.find(c => c.name.startsWith('idb'))
    expect(idb?.ok).toBe(false)
    // idb is optional → environment still healthy.
    expect(struct.healthy).toBe(true)
  })
})
