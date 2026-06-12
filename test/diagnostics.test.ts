import { afterEach, describe, expect, it } from 'bun:test'
import { setRunner } from '../src/lib/run'
import { doctorHandler } from '../src/tools/diagnostics'

const DEVICES = JSON.stringify({
  devices: {
    rt: [
      { udid: 'AAA', name: 'iPhone 17 Pro', state: 'Booted', isAvailable: true },
      { udid: 'BBB', name: 'iPhone 17', state: 'Shutdown', isAvailable: true },
    ],
  },
})

const realFetch = globalThis.fetch

afterEach(() => {
  setRunner(null)
  globalThis.fetch = realFetch
})

describe('doctor', () => {
  it('reports a healthy environment', async () => {
    setRunner((cmd, args) => {
      if (cmd === 'xcode-select')
        return Promise.resolve({ stdout: '/Applications/Xcode.app/Contents/Developer', stderr: '' })
      if (args.includes('list'))
        return Promise.resolve({ stdout: DEVICES, stderr: '' })
      // simctl help, idb --help
      return Promise.resolve({ stdout: 'ok', stderr: '' })
    })
    globalThis.fetch = (async () => ({ ok: true } as Response)) as unknown as typeof fetch

    const result = await doctorHandler({})

    expect(result.isError).toBe(false)
    const struct = result.structuredContent as { healthy: boolean, booted: string[], metro: { reachable: boolean } }
    expect(struct.healthy).toBe(true)
    expect(struct.metro.reachable).toBe(true)
    expect(struct.booted[0]).toContain('iPhone 17 Pro')
  })

  it('flags a missing idb', async () => {
    setRunner((cmd, args) => {
      if (cmd === 'xcode-select')
        return Promise.resolve({ stdout: '/Applications/Xcode.app/Contents/Developer', stderr: '' })
      if (args.includes('list'))
        return Promise.resolve({ stdout: DEVICES, stderr: '' })
      if (args.includes('help'))
        return Promise.resolve({ stdout: 'ok', stderr: '' })
      // idb --help fails
      return Promise.reject(new Error('idb: command not found'))
    })
    globalThis.fetch = (async () => {
      throw new Error('no metro')
    }) as unknown as typeof fetch

    const result = await doctorHandler({})

    const struct = result.structuredContent as { healthy: boolean, checks: Array<{ name: string, ok: boolean }> }
    expect(struct.healthy).toBe(false)
    const idb = struct.checks.find(c => c.name === 'idb')
    expect(idb?.ok).toBe(false)
  })
})
