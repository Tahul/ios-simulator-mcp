import { describe, expect, it } from 'bun:test'
import { buildLaunchArgs } from '../src/tools/apps'

const UDID = '37A360EC-75F9-4AEC-8EFA-10F4A58D8CCA'

describe('buildLaunchArgs', () => {
  it('builds basic launch args', () => {
    const { args, env } = buildLaunchArgs({ udid: UDID, bundleId: 'com.example.app' })
    expect(args).toEqual(['launch', UDID, 'com.example.app'])
    expect(env).toEqual({})
  })

  it('adds --terminate-running-process before positional args', () => {
    const { args } = buildLaunchArgs({
      udid: UDID,
      bundleId: 'com.example.app',
      terminateRunning: true,
    })
    expect(args).toEqual(['launch', '--terminate-running-process', UDID, 'com.example.app'])
  })

  it('prefixes env vars with SIMCTL_CHILD_ and sorts keys', () => {
    const { env } = buildLaunchArgs({
      udid: UDID,
      bundleId: 'com.example.app',
      env: { ZED: '1', ALPHA: '2' },
    })
    expect(Object.keys(env)).toEqual(['SIMCTL_CHILD_ALPHA', 'SIMCTL_CHILD_ZED'])
    expect(env.SIMCTL_CHILD_ZED).toBe('1')
  })

  it('trims env keys and rejects empty ones', () => {
    const { env } = buildLaunchArgs({
      udid: UDID,
      bundleId: 'com.example.app',
      env: { ' PADDED ': 'x' },
    })
    expect(env.SIMCTL_CHILD_PADDED).toBe('x')

    expect(() =>
      buildLaunchArgs({
        udid: UDID,
        bundleId: 'com.example.app',
        env: { '  ': 'x' },
      }),
    ).toThrow('Environment variable keys must be non-empty.')
  })
})
