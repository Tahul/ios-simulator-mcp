import { afterEach, describe, expect, it } from 'bun:test'
import { setLogCollector } from '../src/lib/baguette'
import { setRunner } from '../src/lib/run'
import { buildLaunchArgs, launchAppHandler, listAppsHandler, parseAppRunning, parseListApps, terminateAppHandler, uninstallAppHandler } from '../src/tools/apps'

const UDID = '37A360EC-75F9-4AEC-8EFA-10F4A58D8CCA'

afterEach(() => {
  setLogCollector(null)
  setRunner(null)
})

describe('parseAppRunning', () => {
  const LINE = '40509\t0\tUIKitApplication:com.tahul.spotter[93a2][rb-legacy]'

  it('returns true when the bundle has a numeric pid', () => {
    expect(parseAppRunning(LINE, 'com.tahul.spotter')).toBe(true)
  })

  it('returns false when registered but not running (pid "-")', () => {
    expect(parseAppRunning('-\t0\tUIKitApplication:com.tahul.spotter[93a2]', 'com.tahul.spotter')).toBe(false)
  })

  it('returns false when the bundle is absent', () => {
    expect(parseAppRunning('40509\t0\tUIKitApplication:com.apple.mobilesafari[aa]', 'com.tahul.spotter')).toBe(false)
  })

  it('does not match a bundle that is only a prefix of another', () => {
    expect(parseAppRunning('40509\t0\tUIKitApplication:com.tahul.spotter2[aa]', 'com.tahul.spotter')).toBe(false)
  })
})

describe('buildLaunchArgs EX_UPDATES guard', () => {
  it('rejects EX_UPDATES_* env vars with an explanation', () => {
    expect(() =>
      buildLaunchArgs({
        udid: UDID,
        bundleId: 'com.example.app',
        env: { EX_UPDATES_URL: 'http://localhost:8081' },
      }),
    ).toThrow(/expo-updates reload loop/)
  })

  it('rejects EX_UPDATES_* case-insensitively', () => {
    expect(() =>
      buildLaunchArgs({
        udid: UDID,
        bundleId: 'com.example.app',
        env: { ex_updates_enabled: '0' },
      }),
    ).toThrow(/Refusing to set/)
  })

  it('still accepts unrelated env vars', () => {
    const { env } = buildLaunchArgs({
      udid: UDID,
      bundleId: 'com.example.app',
      env: { API_URL: 'http://localhost:3000' },
    })
    expect(env.SIMCTL_CHILD_API_URL).toBe('http://localhost:3000')
  })
})

const LISTAPPS_FIXTURE = `{
    "com.apple.Bridge" =     {
        ApplicationType = System;
        Bundle = "file:///path/Bridge.app/";
        CFBundleDisplayName = Watch;
        CFBundleExecutable = Bridge;
        CFBundleIdentifier = "com.apple.Bridge";
        CFBundleName = Watch;
    };
    "com.tahul.spotter" =     {
        ApplicationType = User;
        CFBundleDisplayName = Spotter;
        CFBundleExecutable = Spotter;
        CFBundleIdentifier = "com.tahul.spotter";
        CFBundleName = Spotter;
    };
    "com.apple.mobilesafari" =     {
        ApplicationType = System;
        CFBundleDisplayName = Safari;
        CFBundleIdentifier = "com.apple.mobilesafari";
    };
}`

describe('parseListApps', () => {
  it('parses bundle ids, names, and types', () => {
    const apps = parseListApps(LISTAPPS_FIXTURE)
    expect(apps).toHaveLength(3)
    expect(apps[1]).toEqual({ bundleId: 'com.tahul.spotter', name: 'Spotter', type: 'User' })
    expect(apps[2]).toEqual({ bundleId: 'com.apple.mobilesafari', name: 'Safari', type: 'System' })
  })

  it('returns empty array for empty output', () => {
    expect(parseListApps('')).toEqual([])
  })
})

describe('list_apps handler', () => {
  it('returns compact bundle lines', async () => {
    setRunner((_cmd, args) => {
      expect(args).toEqual(['simctl', 'listapps', UDID])
      return Promise.resolve({ stdout: LISTAPPS_FIXTURE, stderr: '' })
    })

    const result = await listAppsHandler({ udid: UDID })

    expect(result.isError).toBe(false)
    const block = result.content[0]
    expect(block?.type === 'text' && block.text).toContain('com.tahul.spotter — Spotter (User)')
  })
})

describe('launch_app handler', () => {
  it('does not collect logs for pre-launch validation failures', async () => {
    setRunner(() => {
      throw new Error('runner should not be called')
    })
    setLogCollector(() => {
      throw new Error('logs should not be collected')
    })

    const result = await launchAppHandler({
      udid: UDID,
      bundle_id: 'com.example.app',
      env: { EX_UPDATES_URL: 'http://localhost:8081' },
    })

    expect(result.isError).toBe(true)
    expect(result.structuredContent?.recentLogs).toBeUndefined()
  })

  it('includes bounded simulator logs when launch fails', async () => {
    setRunner((_cmd, args) => {
      expect(args).toEqual(['simctl', 'launch', UDID, 'com.example.app'])
      throw new Error('launch failed')
    })
    setLogCollector((udid, opts) => {
      expect(udid).toBe(UDID)
      expect(opts.bundleId).toBe('com.example.app')
      expect(opts.maxLines).toBe(80)
      expect(opts.windowMs).toBe(1000)
      return Promise.resolve(['com.example.app: fatal JS exception'])
    })

    const result = await launchAppHandler({ udid: UDID, bundle_id: 'com.example.app' })

    expect(result.isError).toBe(true)
    const block = result.content[0]
    expect(block?.type === 'text' && block.text).toContain('Simulator logs captured after failure for com.example.app')
    expect(block?.type === 'text' && block.text).toContain('fatal JS exception')
    expect(result.structuredContent?.recentLogs).toEqual({
      udid: UDID,
      bundleId: 'com.example.app',
      lines: ['com.example.app: fatal JS exception'],
      totalLines: 1,
      truncated: false,
    })
  })
})

describe('terminate_app / uninstall_app', () => {
  it('builds the simctl terminate command', async () => {
    const calls: string[][] = []
    setRunner((_cmd, args) => {
      calls.push(args)
      return Promise.resolve({ stdout: '', stderr: '' })
    })

    const result = await terminateAppHandler({ udid: UDID, bundle_id: 'com.example.app' })

    expect(result.isError).toBe(false)
    expect(calls[0]).toEqual(['simctl', 'terminate', UDID, 'com.example.app'])
  })

  it('builds the simctl uninstall command', async () => {
    const calls: string[][] = []
    setRunner((_cmd, args) => {
      calls.push(args)
      return Promise.resolve({ stdout: '', stderr: '' })
    })

    const result = await uninstallAppHandler({ udid: UDID, bundle_id: 'com.example.app' })

    expect(result.isError).toBe(false)
    expect(calls[0]).toEqual(['simctl', 'uninstall', UDID, 'com.example.app'])
  })
})
