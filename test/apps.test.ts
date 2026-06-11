import { afterEach, describe, expect, it } from 'bun:test'
import { setRunner } from '../src/lib/run'
import { buildLaunchArgs, listAppsHandler, parseListApps, terminateAppHandler, uninstallAppHandler } from '../src/tools/apps'

const UDID = '37A360EC-75F9-4AEC-8EFA-10F4A58D8CCA'

afterEach(() => {
  setRunner(null)
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
