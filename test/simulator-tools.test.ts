import { afterEach, describe, expect, it } from 'bun:test'
import { getBootedDeviceId, getDefaultDevice, setDefaultDevice } from '../src/lib/devices'
import { setRunner } from '../src/lib/run'
import { selectDefaultDeviceHandler } from '../src/tools/simulator'

const FIXTURE = JSON.stringify({
  devices: {
    rt: [
      { udid: 'AAA', name: 'iPhone 17 Pro', state: 'Shutdown', isAvailable: true },
      { udid: 'BBB', name: 'iPhone 17', state: 'Booted', isAvailable: true },
    ],
  },
})

afterEach(() => {
  setRunner(null)
  setDefaultDevice(null)
})

describe('select_default_device', () => {
  it('sets a session default that getBootedDeviceId honors', async () => {
    setRunner(() => Promise.resolve({ stdout: FIXTURE, stderr: '' }))

    const result = await selectDefaultDeviceHandler({ name: 'iPhone 17 Pro' })

    expect(result.isError).toBe(false)
    expect(getDefaultDevice()).toBe('AAA')
    // no explicit udid -> falls back to the session default, not the booted one
    expect(await getBootedDeviceId()).toBe('AAA')
  })

  it('explicit udid overrides the session default', async () => {
    setDefaultDevice('AAA')
    expect(await getBootedDeviceId('ZZZ')).toBe('ZZZ')
  })

  it('clears the default when called with no arguments', async () => {
    setDefaultDevice('AAA')

    const result = await selectDefaultDeviceHandler({})

    expect(result.isError).toBe(false)
    expect(getDefaultDevice()).toBeNull()
  })
})
