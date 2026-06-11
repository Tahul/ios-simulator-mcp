import { afterEach, describe, expect, it } from 'bun:test'
import { setRunner } from '../src/lib/run'
import {
  openUrlHandler,
  pushNotificationHandler,
  setAppearanceHandler,
  setLocationHandler,
  setPermissionsHandler,
  statusBarHandler,
} from '../src/tools/device'

const UDID = '37A360EC-75F9-4AEC-8EFA-10F4A58D8CCA'

function recordCalls(): string[][] {
  const calls: string[][] = []
  setRunner((_cmd, args) => {
    calls.push(args)
    return Promise.resolve({ stdout: '', stderr: '' })
  })
  return calls
}

afterEach(() => {
  setRunner(null)
})

describe('open_url', () => {
  it('separates the URL with --', async () => {
    const calls = recordCalls()

    const result = await openUrlHandler({ udid: UDID, url: 'exp://192.168.1.10:8081' })

    expect(result.isError).toBe(false)
    expect(calls[0]).toEqual(['simctl', 'openurl', UDID, '--', 'exp://192.168.1.10:8081'])
  })
})

describe('set_permissions', () => {
  it('builds grant command with bundle id', async () => {
    const calls = recordCalls()

    await setPermissionsHandler({ udid: UDID, action: 'grant', service: 'camera', bundle_id: 'com.example.app' })

    expect(calls[0]).toEqual(['simctl', 'privacy', UDID, 'grant', 'camera', 'com.example.app'])
  })

  it('omits bundle id for global reset', async () => {
    const calls = recordCalls()

    await setPermissionsHandler({ udid: UDID, action: 'reset', service: 'all' })

    expect(calls[0]).toEqual(['simctl', 'privacy', UDID, 'reset', 'all'])
  })
})

describe('push_notification', () => {
  it('rejects payloads without an aps key', async () => {
    recordCalls()

    const result = await pushNotificationHandler({ udid: UDID, bundle_id: 'com.example.app', payload: { foo: 1 } })

    expect(result.isError).toBe(true)
    const block = result.content[0]
    expect(block?.type === 'text' && block.text).toContain('"aps" key')
  })

  it('pushes a payload file to the app', async () => {
    const calls = recordCalls()

    const result = await pushNotificationHandler({
      udid: UDID,
      bundle_id: 'com.example.app',
      payload: { aps: { alert: 'Hello' } },
    })

    expect(result.isError).toBe(false)
    expect(calls[0]?.slice(0, 4)).toEqual(['simctl', 'push', UDID, 'com.example.app'])
    expect(calls[0]?.[4]).toMatch(/push-\d+\.json$/)
  })
})

describe('set_location / set_appearance', () => {
  it('formats coordinates as lat,lon', async () => {
    const calls = recordCalls()

    await setLocationHandler({ udid: UDID, latitude: 48.8566, longitude: 2.3522 })

    expect(calls[0]).toEqual(['simctl', 'location', UDID, 'set', '48.8566,2.3522'])
  })

  it('sets dark appearance', async () => {
    const calls = recordCalls()

    await setAppearanceHandler({ udid: UDID, appearance: 'dark' })

    expect(calls[0]).toEqual(['simctl', 'ui', UDID, 'appearance', 'dark'])
  })
})

describe('status_bar', () => {
  it('builds override flags', async () => {
    const calls = recordCalls()

    await statusBarHandler({ udid: UDID, action: 'override', time: '9:41', battery_level: 100, battery_state: 'charged' })

    expect(calls[0]).toEqual([
      'simctl',
      'status_bar',
      UDID,
      'override',
      '--time',
      '9:41',
      '--batteryLevel',
      '100',
      '--batteryState',
      'charged',
    ])
  })

  it('clears overrides', async () => {
    const calls = recordCalls()

    await statusBarHandler({ udid: UDID, action: 'clear' })

    expect(calls[0]).toEqual(['simctl', 'status_bar', UDID, 'clear'])
  })

  it('requires at least one override', async () => {
    recordCalls()

    const result = await statusBarHandler({ udid: UDID, action: 'override' })

    expect(result.isError).toBe(true)
    const block = result.content[0]
    expect(block?.type === 'text' && block.text).toContain('at least one override')
  })
})
