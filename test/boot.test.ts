import type { SimDevice } from '../src/lib/devices'
import { afterEach, describe, expect, it } from 'bun:test'
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
    // "iPhone 17" substring matches both, but BBB is booted
    expect(resolveTargetDevice(DEVICES, { name: 'iPhone 17' }).udid).toBe('BBB')
  })

  it('matches an exact name when not booted', () => {
    expect(resolveTargetDevice(DEVICES, { name: 'iPhone 17 Pro' }).udid).toBe('AAA')
  })

  it('skips unavailable devices', () => {
    expect(() => resolveTargetDevice(DEVICES, { name: 'iPad Air' })).toThrow(/No available simulator/)
  })

  it('defaults to the booted device when no selector is given', () => {
    expect(resolveTargetDevice(DEVICES).udid).toBe('BBB')
  })

  it('defaults to the first available device when none is booted', () => {
    const noneBooted: SimDevice[] = DEVICES.map(d => ({ ...d, state: 'Shutdown' }))
    expect(resolveTargetDevice(noneBooted).udid).toBe('AAA')
  })
})

describe('ensureBooted', () => {
  it('returns fast when the target is already booted', async () => {
    const calls: string[][] = []
    setRunner((_cmd, args) => {
      calls.push(args)
      return Promise.resolve({ stdout: FIXTURE, stderr: '' })
    })

    const result = await ensureBooted({ udid: 'BBB' })

    expect(result.alreadyBooted).toBe(true)
    // Only the device list call, no boot command
    expect(calls.every(args => !args.includes('boot'))).toBe(true)
  })

  it('boots a shutdown device and waits until Booted', async () => {
    let listCalls = 0
    const booting = JSON.stringify({
      devices: {
        rt: [{ udid: 'AAA', name: 'iPhone 17 Pro', state: 'Booting', isAvailable: true }],
      },
    })
    const booted = JSON.stringify({
      devices: {
        rt: [{ udid: 'AAA', name: 'iPhone 17 Pro', state: 'Booted', isAvailable: true }],
      },
    })

    setRunner((_cmd, args) => {
      if (args.includes('boot') && args[1] === 'boot')
        return Promise.resolve({ stdout: '', stderr: '' })
      // list devices: first the initial (shutdown), then booting, then booted
      listCalls += 1
      if (listCalls === 1)
        return Promise.resolve({ stdout: FIXTURE, stderr: '' })
      return Promise.resolve({ stdout: listCalls < 3 ? booting : booted, stderr: '' })
    })

    const result = await ensureBooted({ udid: 'AAA' }, { timeoutMs: 5000 })

    expect(result.alreadyBooted).toBe(false)
    expect(result.device.state).toBe('Booted')
  })

  it('tolerates a "current state: Booted" boot error', async () => {
    let listCalls = 0
    setRunner((_cmd, args) => {
      if (args[1] === 'boot') {
        return Promise.reject(new Error('Unable to boot device in current state: Booted'))
      }
      listCalls += 1
      const state = listCalls === 1 ? 'Shutdown' : 'Booted'
      return Promise.resolve({
        stdout: JSON.stringify({ devices: { rt: [{ udid: 'AAA', name: 'X', state, isAvailable: true }] } }),
        stderr: '',
      })
    })

    const result = await ensureBooted({ udid: 'AAA' }, { timeoutMs: 5000 })
    expect(result.device.state).toBe('Booted')
  })
})

describe('boot_sim handler', () => {
  it('reports an already-booted device', async () => {
    setRunner((cmd) => {
      if (cmd === 'open')
        return Promise.resolve({ stdout: '', stderr: '' })
      return Promise.resolve({ stdout: FIXTURE, stderr: '' })
    })

    const result = await bootSimHandler({ name: 'iPhone 17', open_app: false })

    expect(result.isError).toBe(false)
    const block = result.content[0]
    expect(block?.type === 'text' && block.text).toContain('already booted: iPhone 17 (BBB)')
  })
})
