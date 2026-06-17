import { afterEach, describe, expect, it } from 'bun:test'
import { setFetchImpl } from '../src/lib/baguette'
import { getBootedDeviceId, getDefaultDevice, setDefaultDevice } from '../src/lib/devices'
import { setRunner } from '../src/lib/run'
import { selectDefaultDeviceHandler } from '../src/tools/simulator'

const BAG_LIST = JSON.stringify({
  running: [{ udid: 'BBB', name: 'iPhone 17', runtime: 'iOS 26.5', state: 'Booted' }],
  available: [{ udid: 'AAA', name: 'iPhone 17 Pro', runtime: 'iOS 26.5', state: 'Shutdown' }],
})

interface Call { url: string, method: string }

function stubBaguetteList(): Call[] {
  const calls: Call[] = []
  setFetchImpl((async (url: string, init?: { method?: string }) => {
    calls.push({ url, method: init?.method ?? 'GET' })
    return {
      ok: true,
      status: 200,
      text: async () => BAG_LIST,
      arrayBuffer: async () => new ArrayBuffer(0),
    }
  }) as any)
  return calls
}

afterEach(() => {
  setRunner(null)
  setFetchImpl(null)
  setDefaultDevice(null)
})

describe('select_default_device', () => {
  it('boots a shutdown device before pinning it as default', async () => {
    const calls = stubBaguetteList()

    const result = await selectDefaultDeviceHandler({ name: 'iPhone 17 Pro' })

    expect(result.isError).toBe(false)
    expect(getDefaultDevice()).toBe('AAA')
    // no explicit udid -> falls back to the session default
    expect(await getBootedDeviceId()).toBe('AAA')
    // the shutdown device was booted so screen/input tools work immediately
    expect(calls.some(c => c.method === 'POST' && c.url.includes('/simulators/AAA/boot'))).toBe(true)
    const block = result.content[0]
    expect(block?.type === 'text' && block.text).toContain('booted it')
  })

  it('pins an already-booted device without rebooting it', async () => {
    const calls = stubBaguetteList()

    const result = await selectDefaultDeviceHandler({ name: 'iPhone 17' })

    expect(result.isError).toBe(false)
    expect(getDefaultDevice()).toBe('BBB')
    expect(calls.some(c => c.method === 'POST' && c.url.includes('/boot'))).toBe(false)
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
