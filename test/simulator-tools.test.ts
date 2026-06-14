import { afterEach, describe, expect, it } from 'bun:test'
import { setFetchImpl } from '../src/lib/baguette'
import { getBootedDeviceId, getDefaultDevice, setDefaultDevice } from '../src/lib/devices'
import { setRunner } from '../src/lib/run'
import { selectDefaultDeviceHandler } from '../src/tools/simulator'

const BAG_LIST = JSON.stringify({
  running: [{ udid: 'BBB', name: 'iPhone 17', runtime: 'iOS 26.5', state: 'Booted' }],
  available: [{ udid: 'AAA', name: 'iPhone 17 Pro', runtime: 'iOS 26.5', state: 'Shutdown' }],
})

function stubBaguetteList(): void {
  setFetchImpl((async () => ({
    ok: true,
    status: 200,
    text: async () => BAG_LIST,
    arrayBuffer: async () => new ArrayBuffer(0),
  })) as any)
}

afterEach(() => {
  setRunner(null)
  setFetchImpl(null)
  setDefaultDevice(null)
})

describe('select_default_device', () => {
  it('sets a session default that getBootedDeviceId honors', async () => {
    stubBaguetteList()

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
