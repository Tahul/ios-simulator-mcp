import type { AxNode } from '../src/lib/ax'
import { afterEach, describe, expect, it } from 'bun:test'
import { buildSnapshot, frameCenter, resetSnapshotState, resolveTarget } from '../src/lib/ax'
import { setFetchImpl, setWsSessionFactory } from '../src/lib/baguette'
import { uiSnapshotHandler, waitForElementHandler } from '../src/tools/snapshot'
import { axTree, installMockSession, makeMockSession } from './helpers/baguette-mock'

const UDID = '37A360EC-75F9-4AEC-8EFA-10F4A58D8CCA'

const TREE: AxNode = {
  role: 'AXApplication',
  label: 'Spotter',
  frame: { x: 0, y: 0, width: 393, height: 852 },
  children: [
    { role: 'AXStaticText', label: 'Welcome back', frame: { x: 20, y: 100, width: 200, height: 30 }, children: [] },
    { role: 'AXTextField', identifier: 'email-field', frame: { x: 20, y: 300, width: 353, height: 44 }, children: [] },
    { role: 'AXButton', label: 'Sign in', identifier: 'login-button', frame: { x: 100, y: 400, width: 194, height: 40 }, children: [] },
    { role: 'AXButton', label: 'Hidden', frame: { x: 0, y: 0, width: 0, height: 0 }, children: [] },
  ],
}

afterEach(() => {
  setWsSessionFactory(null)
  setFetchImpl(null)
  resetSnapshotState()
})

describe('buildSnapshot', () => {
  it('includes labeled/identified nodes, skips invisible ones', () => {
    const { entries } = buildSnapshot(TREE)
    expect(entries.map(e => e.role)).toEqual(['AXStaticText', 'AXTextField', 'AXButton'])
    expect(entries.map(e => e.ref)).toEqual(['e1', 'e2', 'e3'])
  })

  it('renders compact lines with center coordinates', () => {
    const { text } = buildSnapshot(TREE)
    expect(text).toContain('e3 AXButton "Sign in" id=login-button (197, 420)')
    expect(text).toContain('e2 AXTextField id=email-field (197, 322)')
    expect(text).not.toContain('Hidden')
  })
})

describe('frameCenter', () => {
  it('rounds to the nearest point', () => {
    expect(frameCenter({ x: 100, y: 400, width: 194, height: 40 })).toEqual({ x: 197, y: 420 })
  })
})

describe('resolveTarget', () => {
  it('passes through explicit coordinates', async () => {
    const session = makeMockSession(() => TREE)
    expect(await resolveTarget(session, { x: 10, y: 20 })).toEqual({ x: 10, y: 20 })
  })

  it('rejects stale refs with a recovery message', async () => {
    const session = makeMockSession(() => TREE)
    expect(resolveTarget(session, { ref: 'e99' })).rejects.toThrow(/stale ref .* ui_snapshot/)
  })

  it('resolves refs stored by ui_snapshot, warns on reuse', async () => {
    installMockSession(makeMockSession(() => TREE))
    await uiSnapshotHandler({ udid: UDID })

    const session = makeMockSession(() => TREE)
    const first = await resolveTarget(session, { ref: 'e3' })
    expect(first).toMatchObject({ x: 197, y: 420 })
    expect(first.warning).toBeUndefined()

    const second = await resolveTarget(session, { ref: 'e3' })
    expect(second.warning).toContain('renumbered by every snapshot')
  })

  it('resolves labels against the live tree, preferring exact matches', async () => {
    const session = makeMockSession(() => TREE)
    expect(await resolveTarget(session, { label: 'sign in' })).toEqual({ x: 197, y: 420 })
    expect(await resolveTarget(session, { label: 'email-field' })).toEqual({ x: 197, y: 322 })
  })

  it('errors with a hint when no element matches the label', async () => {
    const session = makeMockSession(() => TREE)
    expect(resolveTarget(session, { label: 'Logout' })).rejects.toThrow(/No on-screen element matching/)
  })

  it('requires some target', async () => {
    const session = makeMockSession(() => TREE)
    expect(resolveTarget(session, {})).rejects.toThrow(/Provide either/)
  })
})

describe('ui_snapshot handler', () => {
  it('returns the compact listing with a screen header', async () => {
    installMockSession(makeMockSession(() => TREE))

    const result = await uiSnapshotHandler({ udid: UDID })

    expect(result.isError).toBe(false)
    const block = result.content[0]
    const text = block?.type === 'text' ? block.text : ''
    expect(text).toContain('Screen 393x852 points')
    expect(text).toContain('3 elements')
    expect(text).toContain('e3 AXButton "Sign in"')
  })

  it('errors when the screen has no accessibility data', async () => {
    installMockSession(makeMockSession(() => null))
    const result = await uiSnapshotHandler({ udid: UDID })
    expect(result.isError).toBe(true)
  })
})

describe('wait_for_element', () => {
  it('returns immediately when the element is already present', async () => {
    installMockSession(makeMockSession(() => axTree([{ role: 'AXButton', label: 'Sign in', frame: { x: 100, y: 400, width: 194, height: 40 } }])))

    const result = await waitForElementHandler({ udid: UDID, search: 'Sign in', role: 'AXButton' })

    expect(result.isError).toBe(false)
    const block = result.content[0]
    expect(block?.type === 'text' && block.text).toContain('Found AXButton "Sign in" at (197, 420)')
  })

  it('polls until the element appears', async () => {
    let calls = 0
    installMockSession(makeMockSession(() => {
      calls += 1
      return calls >= 2
        ? axTree([{ role: 'AXButton', label: 'Sign in', frame: { x: 100, y: 400, width: 194, height: 40 } }])
        : axTree([])
    }))

    const result = await waitForElementHandler({ udid: UDID, search: 'Sign in', timeout: 5 })
    expect(result.isError).toBe(false)
    expect(calls).toBeGreaterThanOrEqual(2)
  })

  it('fails with a hint after the timeout', async () => {
    installMockSession(makeMockSession(() => axTree([])))

    const result = await waitForElementHandler({ udid: UDID, search: 'Never', timeout: 1 })

    expect(result.isError).toBe(true)
    const block = result.content[0]
    expect(block?.type === 'text' && block.text).toContain('did not appear within 1s')
    expect(block?.type === 'text' && block.text).toContain('Hint:')
  })
})
