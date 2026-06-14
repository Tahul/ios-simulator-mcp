import type { SimDevice } from '../src/lib/devices'
import { afterEach, describe, expect, it } from 'bun:test'
import { setFetchImpl } from '../src/lib/baguette'
import { ensureBooted, parseDeviceList, resolveTargetDevice } from '../src/lib/devices'
import { setRunner } from '../src/lib/run'
import { bootSimHandler } from '../src/tools/boot'

const FIXTURE = JSON.stringify({
  devices: {
    'com.apple.CoreSimulator.SimRuntime.iOS-26-2': [
      { udid: 'AAA', name: 'iPhone 17 Pro', state: 'Shutdown', isAvailable: true },
      { udid: 'BBB', name: 'iPhone 17', state: 'Booted', isAvailable: true },
      { udid: 'CCC', name: 'iPad Air', state: 'Shutdown', isAvailable: false },
    ],
  },
})

const DEVICES = parseDeviceList(FIXTURE)

afterEach(() => {
  setRunner(null)
  setFetchImpl(null)
})

describe('parseDeviceList', () => {
  it('flattens devices across runtimes with state and availability', () => {
    expect(DEVICES).toHaveLength(3)
    expect(DEVICES[0]).toEqual({ udid: 'AAA', name: 'iPhone 17 Pro', state: 'Shutdown', isAvailable: true })
  })
})

describe('resolveTargetDevice', () => {
  it('matches by exact udid', () => {
    expect(resolveTargetDevice(DEVICES, { udid: 'AAA' }).name).toBe('iPhone 17 Pro')
  })

  it('throws for an unknown udid', () => {
    expect(() => resolveTargetDevice(DEVICES, { udid: 'ZZZ' })).toThrow(/No simulator with udid ZZZ/)
  })

  it('matches by name, preferring booted', () => {
    expect(resolveTargetDevice(DEVICES, { name: 'iPhone 17' }).udid).toBe('BBB')
  })

  it('defaults to the first available device when none is booted', () => {
    const noneBooted: SimDevice[] = DEVICES.map(d => ({ ...d, state: 'Shutdown' }))
    expect(resolveTargetDevice(noneBooted).udid).toBe('AAA')
  })
})

describe('ensureBooted (simctl path, used by expo_launch)', () => {
  it('returns fast when the target is already booted', async () => {
    const calls: string[][] = []
    setRunner((_cmd, args) => {
      calls.push(args)
      return Promise.resolve({ stdout: FIXTURE, stderr: '' })
    })

    const result = await ensureBooted({ udid: 'BBB' })

    expect(result.alreadyBooted).toBe(true)
    expect(calls.every(args => !args.includes('boot'))).toBe(true)
  })
})

// baguette list response shape: { running, available }.
function bagFetch(running: any[], available: any[], bootStatus = 200) {
  setFetchImpl((async (url: string, init?: { method?: string }) => {
    if (url.endsWith('/simulators.json')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ running, available }), arrayBuffer: async () => new ArrayBuffer(0) }
    }
    if ((init?.method ?? 'GET') === 'POST' && url.includes('/boot')) {
      return { ok: bootStatus === 200, status: bootStatus, text: async () => (bootStatus === 200 ? '' : JSON.stringify({ ok: false, error: 'bootFailed' })), arrayBuffer: async () => new ArrayBuffer(0) }
    }
    return { ok: false, status: 404, text: async () => '', arrayBuffer: async () => new ArrayBuffer(0) }
  }) as any)
}

describe('boot_sim handler (baguette)', () => {
  it('reports an already-booted device by name', async () => {
    bagFetch(
      [{ udid: 'BBB', name: 'iPhone 17', runtime: 'iOS 26.5', state: 'Booted' }],
      [{ udid: 'AAA', name: 'iPhone 17 Pro', runtime: 'iOS 26.5', state: 'Shutdown' }],
    )

    const result = await bootSimHandler({ name: 'iPhone 17 Pro' })

    // "iPhone 17 Pro" matches the shutdown AAA → boots it.
    expect(result.isError).toBe(false)
    const block = result.content[0]
    expect(block?.type === 'text' && block.text).toContain('iPhone 17 Pro (AAA)')
  })

  it('short-circuits when the selected device is already running', async () => {
    bagFetch(
      [{ udid: 'BBB', name: 'iPhone 17', runtime: 'iOS 26.5', state: 'Booted' }],
      [],
    )
    const result = await bootSimHandler({ udid: 'BBB' })
    const block = result.content[0]
    expect(block?.type === 'text' && block.text).toContain('already booted: iPhone 17 (BBB)')
  })
})
