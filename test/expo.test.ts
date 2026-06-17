import type { AxNode } from '../src/lib/ax'
import type { RunResult } from '../src/lib/run'
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { setLogCollector, setWsSessionFactory } from '../src/lib/baguette'
import { setRunner } from '../src/lib/run'
import { expoLaunchHandler } from '../src/tools/expo'
import { makeMockSession } from './helpers/baguette-mock'

const BOOTED = JSON.stringify({
  devices: {
    rt: [{ udid: 'AAA', name: 'iPhone 17 Pro', state: 'Booted', isAvailable: true }],
  },
})

// A loaded RN screen: many labeled elements (baguette AxNode shape).
const LOADED_TREE: AxNode = {
  role: 'AXApplication',
  frame: { x: 0, y: 0, width: 393, height: 852 },
  children: Array.from({ length: 8 }, (_, i) => ({
    role: 'AXStaticText',
    label: `Item ${i}`,
    frame: { x: 0, y: i * 30, width: 100, height: 20 },
    children: [],
  })),
}

const REDBOX_TREE: AxNode = {
  role: 'AXApplication',
  frame: { x: 0, y: 0, width: 393, height: 852 },
  children: [
    { role: 'AXStaticText', label: 'Unable to load script. Make sure Metro is running', frame: { x: 0, y: 0, width: 300, height: 40 }, children: [] },
    { role: 'AXButton', label: 'Reload', frame: { x: 0, y: 50, width: 80, height: 30 }, children: [] },
    { role: 'AXButton', label: 'Dismiss', frame: { x: 90, y: 50, width: 80, height: 30 }, children: [] },
  ],
}

const DEV_MENU_TREE: AxNode = {
  role: 'AXApplication',
  frame: { x: 0, y: 0, width: 393, height: 852 },
  children: [
    { role: 'AXStaticText', label: 'React Native Developer Menu', frame: { x: 40, y: 120, width: 280, height: 40 }, children: [] },
    { role: 'AXButton', label: 'Reload', frame: { x: 40, y: 200, width: 180, height: 40 }, children: [] },
    { role: 'AXButton', label: 'Close', frame: { x: 300, y: 80, width: 60, height: 40 }, children: [] },
  ],
}

const DEV_MENU_WITHOUT_CLOSE_TREE: AxNode = {
  role: 'AXApplication',
  frame: { x: 0, y: 0, width: 393, height: 852 },
  children: [
    { role: 'AXStaticText', label: 'Development Menu', frame: { x: 40, y: 120, width: 280, height: 40 }, children: [] },
    { role: 'AXButton', label: 'Open Debugger', frame: { x: 40, y: 200, width: 180, height: 40 }, children: [] },
  ],
}

interface RecordedCall {
  cmd: string
  args: string[]
}

function text(result: { content: Array<{ type: string, text?: string }> }): string {
  const block = result.content[0]
  return block?.type === 'text' ? block.text ?? '' : ''
}

const realFetch = globalThis.fetch

afterEach(() => {
  setLogCollector(null)
  setRunner(null)
  setWsSessionFactory(null)
  globalThis.fetch = realFetch
})

describe('expo_launch', () => {
  it('boots, waits for Metro, resolves the deep link, opens it, and verifies load', async () => {
    const calls: RecordedCall[] = []
    setRunner((cmd, args): Promise<RunResult> => {
      calls.push({ cmd, args })
      if (args.includes('list'))
        return Promise.resolve({ stdout: BOOTED, stderr: '' })
      return Promise.resolve({ stdout: '', stderr: '' })
    })
    setWsSessionFactory(() => Promise.resolve(makeMockSession(() => LOADED_TREE)))

    globalThis.fetch = mock(async (url: string | URL) => {
      const u = url.toString()
      if (u.includes('/_expo/open')) {
        return {
          ok: true,
          json: async () => ({ url: 'exp+spotter://expo-development-client/?url=enc', runtime: 'custom' }),
        } as Response
      }
      // /status readiness probe
      return { ok: true } as Response
    }) as unknown as typeof fetch

    const result = await expoLaunchHandler({ udid: 'AAA', metro_url: 'http://localhost:8081' })

    expect(result.isError).toBe(false)
    const out = text(result)
    expect(out).toContain('Expo launch succeeded')
    expect(out).toContain('resolved custom link via metro-open-endpoint')
    expect(out).toContain('verify: loaded')
    expect((result.structuredContent as { outcome: string }).outcome).toBe('loaded')

    const openCall = calls.find(c => c.args.includes('openurl'))
    expect(openCall).toBeDefined()
    expect(openCall?.args.at(-1)).toContain('disableOnboarding=1')
  })

  it('reports a RedBox error overlay as the outcome', async () => {
    const session = makeMockSession(() => REDBOX_TREE)
    setRunner((_cmd, args) => {
      if (args.includes('list'))
        return Promise.resolve({ stdout: BOOTED, stderr: '' })
      return Promise.resolve({ stdout: '', stderr: '' })
    })
    setWsSessionFactory(() => Promise.resolve(session))

    globalThis.fetch = mock(async (url: string | URL) => {
      const u = url.toString()
      if (u.includes('/_expo/open'))
        return { ok: true, json: async () => ({ url: 'exp://localhost:8081', runtime: 'expo' }) } as Response
      return { ok: true } as Response
    }) as unknown as typeof fetch

    const result = await expoLaunchHandler({ udid: 'AAA', runtime: 'expo', verify_timeout_s: 2 })

    expect(result.isError).toBe(false)
    const out = text(result)
    expect(out).toContain('shows an error')
    expect((result.structuredContent as { outcome: string }).outcome).toBe('redbox')
    expect(session.sent.some(e => e.type === 'tap')).toBe(false)
  })

  it('dismisses the React Native development menu before verification', async () => {
    const session = makeMockSession(call => call === 0 ? DEV_MENU_TREE : LOADED_TREE)
    const calls: RecordedCall[] = []
    setRunner((cmd, args) => {
      calls.push({ cmd, args })
      if (args.includes('list'))
        return Promise.resolve({ stdout: BOOTED, stderr: '' })
      return Promise.resolve({ stdout: '', stderr: '' })
    })
    setWsSessionFactory(() => Promise.resolve(session))

    globalThis.fetch = mock(async (url: string | URL) => {
      const u = url.toString()
      if (u.includes('/_expo/open'))
        return { ok: true, json: async () => ({ url: 'exp://localhost:8081', runtime: 'expo' }) } as Response
      return { ok: true } as Response
    }) as unknown as typeof fetch

    const result = await expoLaunchHandler({ udid: 'AAA', runtime: 'expo' })

    expect(result.isError).toBe(false)
    expect(text(result)).toContain('dismissed development menu')
    expect(session.sent.find(e => e.type === 'tap')).toMatchObject({
      type: 'tap',
      x: 330,
      y: 100,
      width: 393,
      height: 852,
    })
    expect(calls.some(c => c.args.includes('openurl'))).toBe(true)
  })

  it('uses Escape when a development menu has no dismiss button', async () => {
    const session = makeMockSession(call => call === 0 ? DEV_MENU_WITHOUT_CLOSE_TREE : LOADED_TREE)
    setRunner((_cmd, args) => {
      if (args.includes('list'))
        return Promise.resolve({ stdout: BOOTED, stderr: '' })
      return Promise.resolve({ stdout: '', stderr: '' })
    })
    setWsSessionFactory(() => Promise.resolve(session))

    globalThis.fetch = mock(async (url: string | URL) => {
      const u = url.toString()
      if (u.includes('/_expo/open'))
        return { ok: true, json: async () => ({ url: 'exp://localhost:8081', runtime: 'expo' }) } as Response
      return { ok: true } as Response
    }) as unknown as typeof fetch

    const result = await expoLaunchHandler({ udid: 'AAA', runtime: 'expo' })

    expect(result.isError).toBe(false)
    expect(session.sent.find(e => e.type === 'key')).toMatchObject({ type: 'key', code: 'Escape' })
  })

  it('cold-starts Expo Go by terminating it before opening', async () => {
    const calls: RecordedCall[] = []
    setRunner((cmd, args) => {
      calls.push({ cmd, args })
      if (args.includes('list'))
        return Promise.resolve({ stdout: BOOTED, stderr: '' })
      return Promise.resolve({ stdout: '', stderr: '' })
    })

    globalThis.fetch = mock(async (url: string | URL) => {
      const u = url.toString()
      if (u.includes('/_expo/open'))
        return { ok: true, json: async () => ({ url: 'exp://localhost:8081', runtime: 'expo' }) } as Response
      return { ok: true } as Response
    }) as unknown as typeof fetch

    const result = await expoLaunchHandler({ udid: 'AAA', runtime: 'expo', verify: false })

    expect(result.isError).toBe(false)
    const terminateIdx = calls.findIndex(c => c.args.includes('terminate') && c.args.includes('host.exp.Exponent'))
    const openIdx = calls.findIndex(c => c.args.includes('openurl'))
    expect(terminateIdx).toBeGreaterThanOrEqual(0)
    // terminate must happen before the open
    expect(terminateIdx).toBeLessThan(openIdx)
  })

  it('terminates an explicit bundle_id for a dev-client clean start', async () => {
    const calls: RecordedCall[] = []
    setRunner((cmd, args) => {
      calls.push({ cmd, args })
      if (args.includes('list'))
        return Promise.resolve({ stdout: BOOTED, stderr: '' })
      return Promise.resolve({ stdout: '', stderr: '' })
    })

    globalThis.fetch = mock(async (url: string | URL) => {
      const u = url.toString()
      if (u.includes('/_expo/open'))
        return { ok: true, json: async () => ({ url: 'exp+spotter://expo-development-client/?url=enc', runtime: 'custom' }) } as Response
      return { ok: true } as Response
    }) as unknown as typeof fetch

    const result = await expoLaunchHandler({ udid: 'AAA', bundle_id: 'com.tahul.spotter', verify: false })

    expect(result.isError).toBe(false)
    expect(calls.some(c => c.args.includes('terminate') && c.args.includes('com.tahul.spotter'))).toBe(true)
  })

  it('reuses an already-running app instead of cold-restarting it', async () => {
    const calls: RecordedCall[] = []
    setRunner((cmd, args) => {
      calls.push({ cmd, args })
      // launchctl probe reports the dev client as running (numeric pid).
      if (args.includes('launchctl') && args.includes('list'))
        return Promise.resolve({ stdout: '40509\t0\tUIKitApplication:com.tahul.spotter[93a2][rb-legacy]', stderr: '' })
      if (args.includes('list') && args.includes('devices'))
        return Promise.resolve({ stdout: BOOTED, stderr: '' })
      return Promise.resolve({ stdout: '', stderr: '' })
    })
    setWsSessionFactory(() => Promise.resolve(makeMockSession(() => LOADED_TREE)))

    globalThis.fetch = mock(async (url: string | URL) => {
      const u = url.toString()
      if (u.includes('/_expo/open'))
        return { ok: true, json: async () => ({ url: 'exp+spotter://expo-development-client/?url=enc', runtime: 'custom' }) } as Response
      return { ok: true } as Response
    }) as unknown as typeof fetch

    const result = await expoLaunchHandler({ udid: 'AAA', bundle_id: 'com.tahul.spotter', verify: false })

    expect(result.isError).toBe(false)
    // Reuse path: no reboot — no terminate, no deep-link re-open.
    expect(calls.some(c => c.args.includes('terminate'))).toBe(false)
    expect(calls.some(c => c.args.includes('openurl'))).toBe(false)
    // Just a foreground launch of the running bundle.
    expect(calls.some(c => c.args.includes('launch') && c.args.includes('com.tahul.spotter'))).toBe(true)
    expect(text(result)).toContain('reused running')
    expect((result.structuredContent as { reused: boolean }).reused).toBe(true)
  })

  it('restarts via the deep link when if_running="restart", even if running', async () => {
    const calls: RecordedCall[] = []
    setRunner((cmd, args) => {
      calls.push({ cmd, args })
      if (args.includes('launchctl') && args.includes('list'))
        return Promise.resolve({ stdout: '40509\t0\tUIKitApplication:com.tahul.spotter[aa]', stderr: '' })
      if (args.includes('list') && args.includes('devices'))
        return Promise.resolve({ stdout: BOOTED, stderr: '' })
      return Promise.resolve({ stdout: '', stderr: '' })
    })
    setWsSessionFactory(() => Promise.resolve(makeMockSession(() => LOADED_TREE)))

    globalThis.fetch = mock(async (url: string | URL) => {
      const u = url.toString()
      if (u.includes('/_expo/open'))
        return { ok: true, json: async () => ({ url: 'exp+spotter://expo-development-client/?url=enc', runtime: 'custom' }) } as Response
      return { ok: true } as Response
    }) as unknown as typeof fetch

    const result = await expoLaunchHandler({ udid: 'AAA', bundle_id: 'com.tahul.spotter', if_running: 'restart', verify: false })

    expect(result.isError).toBe(false)
    expect(calls.some(c => c.args.includes('openurl'))).toBe(true)
    expect(calls.some(c => c.args.includes('terminate') && c.args.includes('com.tahul.spotter'))).toBe(true)
  })

  it('does not terminate anything when clean is false', async () => {
    const calls: RecordedCall[] = []
    setRunner((cmd, args) => {
      calls.push({ cmd, args })
      if (args.includes('list'))
        return Promise.resolve({ stdout: BOOTED, stderr: '' })
      return Promise.resolve({ stdout: '', stderr: '' })
    })

    globalThis.fetch = mock(async (url: string | URL) => {
      const u = url.toString()
      if (u.includes('/_expo/open'))
        return { ok: true, json: async () => ({ url: 'exp://localhost:8081', runtime: 'expo' }) } as Response
      return { ok: true } as Response
    }) as unknown as typeof fetch

    await expoLaunchHandler({ udid: 'AAA', runtime: 'expo', clean: false, verify: false })

    expect(calls.some(c => c.args.includes('terminate'))).toBe(false)
  })

  it('includes simulator logs when opening the deep link fails', async () => {
    setRunner((_cmd, args): Promise<RunResult> => {
      if (args.includes('list'))
        return Promise.resolve({ stdout: BOOTED, stderr: '' })
      if (args[0] === '-a')
        return Promise.resolve({ stdout: '', stderr: '' })
      if (args.includes('openurl'))
        throw new Error('openurl failed')
      return Promise.resolve({ stdout: '', stderr: '' })
    })
    setLogCollector((udid, opts) => {
      expect(udid).toBe('AAA')
      expect(opts.bundleId).toBe('host.exp.Exponent')
      return Promise.resolve(['host.exp.Exponent: unable to load bundle'])
    })

    globalThis.fetch = mock(async (url: string | URL) => {
      const u = url.toString()
      if (u.includes('/_expo/open'))
        return { ok: true, json: async () => ({ url: 'exp://localhost:8081', runtime: 'expo' }) } as Response
      return { ok: true } as Response
    }) as unknown as typeof fetch

    const result = await expoLaunchHandler({ udid: 'AAA', runtime: 'expo', clean: false })

    expect(result.isError).toBe(true)
    const out = text(result)
    expect(out).toContain('Simulator logs captured after failure for host.exp.Exponent')
    expect(out).toContain('unable to load bundle')
    expect(result.structuredContent?.recentLogs).toEqual({
      udid: 'AAA',
      bundleId: 'host.exp.Exponent',
      lines: ['host.exp.Exponent: unable to load bundle'],
      totalLines: 1,
      truncated: false,
    })
  })

  it('fails clearly when Metro never responds', async () => {
    setRunner((_cmd, args) => {
      if (args.includes('list'))
        return Promise.resolve({ stdout: BOOTED, stderr: '' })
      return Promise.resolve({ stdout: '', stderr: '' })
    })
    setLogCollector(() => {
      throw new Error('logs should not be collected before app open')
    })

    globalThis.fetch = mock(async () => {
      throw new Error('connection refused')
    }) as unknown as typeof fetch

    const result = await expoLaunchHandler({ udid: 'AAA', metro_timeout_s: 1 })

    expect(result.isError).toBe(true)
    const out = text(result)
    expect(out).toContain('simulator ready: iPhone 17 Pro')
    expect(out).toContain('not responding')
    expect(out).toContain('Hint:')
    expect(result.structuredContent?.recentLogs).toBeUndefined()
  })

  it('skips the Metro wait but still resolves via construction fallback', async () => {
    const calls: RecordedCall[] = []
    setRunner((cmd, args) => {
      calls.push({ cmd, args })
      if (args.includes('list'))
        return Promise.resolve({ stdout: BOOTED, stderr: '' })
      return Promise.resolve({ stdout: '', stderr: '' })
    })

    globalThis.fetch = mock(async () => {
      throw new Error('no metro')
    }) as unknown as typeof fetch

    const result = await expoLaunchHandler({
      udid: 'AAA',
      wait_for_metro: false,
      runtime: 'custom',
      scheme: 'exp+spotter',
      verify: false,
    })

    expect(result.isError).toBe(false)
    const openCall = calls.find(c => c.args.includes('openurl'))
    expect(openCall?.args.at(-1)).toContain('exp+spotter://expo-development-client')
  })
})
