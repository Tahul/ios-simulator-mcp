import type { RawElement } from '../src/tools/snapshot'
import { afterEach, describe, expect, it } from 'bun:test'
import { setRunner } from '../src/lib/run'
import {
  buildSnapshot,
  frameCenter,
  resetSnapshotState,
  resolveTarget,
  uiSnapshotHandler,
  waitForElementHandler,
} from '../src/tools/snapshot'

const UDID = '37A360EC-75F9-4AEC-8EFA-10F4A58D8CCA'

const TREE: RawElement[] = [
  {
    type: 'Application',
    AXLabel: 'Spotter',
    frame: { x: 0, y: 0, width: 393, height: 852 },
    children: [
      {
        type: 'Other',
        frame: { x: 0, y: 0, width: 393, height: 852 },
        children: [
          {
            type: 'StaticText',
            AXLabel: 'Welcome back',
            frame: { x: 20, y: 100, width: 200, height: 30 },
          },
          {
            type: 'TextField',
            AXLabel: null,
            AXUniqueId: 'email-field',
            frame: { x: 20, y: 300, width: 353, height: 44 },
          },
          {
            type: 'Button',
            AXLabel: 'Sign in',
            AXUniqueId: 'login-button',
            frame: { x: 100, y: 400, width: 194, height: 40 },
          },
          {
            type: 'Group',
            AXLabel: null,
            frame: { x: 0, y: 500, width: 393, height: 100 },
          },
          {
            type: 'Button',
            AXLabel: 'Hidden',
            frame: { x: 0, y: 0, width: 0, height: 0 },
          },
        ],
      },
    ],
  },
]

afterEach(() => {
  setRunner(null)
  resetSnapshotState()
})

describe('buildSnapshot', () => {
  it('includes interactive and labeled elements, skips containers and invisible ones', () => {
    const { entries } = buildSnapshot(TREE)
    expect(entries.map(e => e.type)).toEqual(['StaticText', 'TextField', 'Button'])
    expect(entries.map(e => e.ref)).toEqual(['e1', 'e2', 'e3'])
  })

  it('renders compact lines with center coordinates', () => {
    const { text } = buildSnapshot(TREE)
    expect(text).toContain('e3 Button "Sign in" id=login-button (197, 420)')
    expect(text).toContain('e2 TextField id=email-field (197, 322)')
    expect(text).not.toContain('Hidden')
  })

  it('respects the depth limit', () => {
    const { entries } = buildSnapshot(TREE, { maxDepth: 1 })
    expect(entries).toHaveLength(0)
  })
})

describe('frameCenter', () => {
  it('rounds to the nearest point', () => {
    expect(frameCenter({ x: 100, y: 400, width: 194, height: 40 })).toEqual({ x: 197, y: 420 })
  })
})

describe('resolveTarget', () => {
  it('passes through explicit coordinates', async () => {
    expect(await resolveTarget(UDID, { x: 10, y: 20 })).toEqual({ x: 10, y: 20 })
  })

  it('rejects stale refs with a recovery message', async () => {
    expect(resolveTarget(UDID, { ref: 'e99' })).rejects.toThrow(/stale ref .* ui_snapshot/)
  })

  it('resolves refs stored by ui_snapshot', async () => {
    setRunner(() => Promise.resolve({ stdout: JSON.stringify(TREE), stderr: '' }))
    await uiSnapshotHandler({ udid: UDID })

    expect(await resolveTarget(UDID, { ref: 'e3' })).toEqual({ x: 197, y: 420 })
  })

  it('warns when the same ref is reused without a fresh snapshot', async () => {
    setRunner(() => Promise.resolve({ stdout: JSON.stringify(TREE), stderr: '' }))
    await uiSnapshotHandler({ udid: UDID })

    const first = await resolveTarget(UDID, { ref: 'e3' })
    expect(first.warning).toBeUndefined()

    const second = await resolveTarget(UDID, { ref: 'e3' })
    expect(second.warning).toContain('renumbered by every snapshot')

    // A new snapshot clears the re-use guard.
    await uiSnapshotHandler({ udid: UDID })
    const afterSnapshot = await resolveTarget(UDID, { ref: 'e3' })
    expect(afterSnapshot.warning).toBeUndefined()
  })

  it('resolves labels against the live tree, preferring exact matches', async () => {
    setRunner(() => Promise.resolve({ stdout: JSON.stringify(TREE), stderr: '' }))

    expect(await resolveTarget(UDID, { label: 'sign in' })).toEqual({ x: 197, y: 420 })
    expect(await resolveTarget(UDID, { label: 'email-field' })).toEqual({ x: 197, y: 322 })
  })

  it('errors with a hint when no element matches the label', async () => {
    setRunner(() => Promise.resolve({ stdout: JSON.stringify(TREE), stderr: '' }))

    expect(resolveTarget(UDID, { label: 'Logout' })).rejects.toThrow(/No on-screen element matching/)
  })

  it('requires some target', async () => {
    expect(resolveTarget(UDID, {})).rejects.toThrow(/Provide either/)
  })
})

describe('ui_snapshot handler', () => {
  it('returns the compact listing with a screen header', async () => {
    setRunner(() => Promise.resolve({ stdout: JSON.stringify(TREE), stderr: '' }))

    const result = await uiSnapshotHandler({ udid: UDID })

    expect(result.isError).toBe(false)
    const block = result.content[0]
    const text = block?.type === 'text' ? block.text : ''
    expect(text).toContain('Screen 393x852 points')
    expect(text).toContain('3 elements')
    expect(text).toContain('e3 Button "Sign in"')
  })
})

describe('wait_for_element', () => {
  it('returns immediately when the element is already present', async () => {
    setRunner(() => Promise.resolve({ stdout: JSON.stringify(TREE), stderr: '' }))

    const result = await waitForElementHandler({ udid: UDID, search: 'Sign in', type: 'Button' })

    expect(result.isError).toBe(false)
    const block = result.content[0]
    expect(block?.type === 'text' && block.text).toContain('Found Button "Sign in" at (197, 420)')
  })

  it('polls until the element appears', async () => {
    let calls = 0
    setRunner(() => {
      calls += 1
      return Promise.resolve({ stdout: JSON.stringify(calls >= 2 ? TREE : []), stderr: '' })
    })

    const result = await waitForElementHandler({ udid: UDID, search: 'Sign in', timeout: 5 })

    expect(result.isError).toBe(false)
    expect(calls).toBeGreaterThanOrEqual(2)
  })

  it('fails with a hint after the timeout', async () => {
    setRunner(() => Promise.resolve({ stdout: '[]', stderr: '' }))

    const result = await waitForElementHandler({ udid: UDID, search: 'Never', timeout: 1 })

    expect(result.isError).toBe(true)
    const block = result.content[0]
    expect(block?.type === 'text' && block.text).toContain('did not appear within 1s')
    expect(block?.type === 'text' && block.text).toContain('Hint:')
  })
})
