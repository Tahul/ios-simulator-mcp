import { afterEach, describe, expect, it } from 'bun:test'
import { resetSnapshotState } from '../src/lib/ax'
import { resetScreenSizeCache, setFetchImpl, setWsSessionFactory } from '../src/lib/baguette'
import {
  uiKeyHandler,
  uiPressHandler,
  uiScrollHandler,
  uiSwipeHandler,
  uiTapHandler,
  uiTypeHandler,
} from '../src/tools/ui'
import { axTree, installMockSession, makeMockSession } from './helpers/baguette-mock'

const UDID = '37A360EC-75F9-4AEC-8EFA-10F4A58D8CCA'

// Geometry fetch stub: every gesture resolves screen size first.
function stubScreen(width = 400, height = 872): void {
  setFetchImpl((async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ screen: { width, height } }),
    arrayBuffer: async () => new ArrayBuffer(0),
  })) as any)
}

function stubMissingGeometry(): void {
  setFetchImpl((async () => ({
    ok: false,
    status: 404,
    text: async () => '',
    arrayBuffer: async () => new ArrayBuffer(0),
  })) as any)
}

afterEach(() => {
  setWsSessionFactory(null)
  setFetchImpl(null)
  resetScreenSizeCache()
  resetSnapshotState()
})

describe('ui_tap', () => {
  it('sends a tap envelope with injected width/height', async () => {
    stubScreen()
    const session = makeMockSession(() => axTree([{ label: 'A', frame: { x: 0, y: 0, width: 10, height: 10 } }]))
    installMockSession(session)

    const result = await uiTapHandler({ udid: UDID, x: 10, y: 20, expect_appears: 'A' })

    expect(result.isError).toBe(false)
    const tap = session.sent.find(e => e.type === 'tap')
    expect(tap).toMatchObject({ type: 'tap', x: 10, y: 20, width: 400, height: 872 })
  })

  it('includes duration when provided', async () => {
    stubScreen()
    const session = makeMockSession(() => axTree([]))
    installMockSession(session)
    await uiTapHandler({ udid: UDID, x: 1, y: 2, duration: 0.5, expect_gone: 'X' })
    expect(session.sent.find(e => e.type === 'tap')).toMatchObject({ duration: 0.5 })
  })

  it('warns when the screen does not change after a tap', async () => {
    stubScreen()
    // Same tree before and after → fingerprint identical → no-op warning.
    installMockSession(makeMockSession(() => axTree([{ label: 'A', frame: { x: 0, y: 0, width: 10, height: 10 } }])))

    const result = await uiTapHandler({ udid: UDID, x: 1, y: 2 })

    const block = result.content[0]
    expect(block?.type === 'text' && block.text).toContain('screen did not change')
    expect(result.structuredContent?.screenUnchanged).toBe(true)
  })

  it('does not warn when the screen changes', async () => {
    stubScreen()
    let n = 0
    installMockSession(makeMockSession(() => {
      n += 1
      return axTree([{ label: n >= 2 ? 'B' : 'A', frame: { x: 0, y: 0, width: 10, height: 10 } }])
    }))

    const result = await uiTapHandler({ udid: UDID, x: 1, y: 2 })
    expect(result.structuredContent?.screenUnchanged).toBeUndefined()
  })

  it('recovers screen size from the accessibility tree when geometry is unavailable', async () => {
    stubMissingGeometry()
    const session = makeMockSession(() => axTree([{ label: 'Spotter', frame: { x: 200, y: 200, width: 80, height: 40 } }]))
    installMockSession(session)

    const result = await uiTapHandler({ udid: UDID, label: 'Spotter', expect_appears: 'Spotter' })

    expect(result.isError).toBe(false)
    const tap = session.sent.find(e => e.type === 'tap')
    expect(tap).toMatchObject({ type: 'tap', x: 240, y: 220, width: 400, height: 872 })
    const block = result.content[0]
    expect(block?.type === 'text' && block.text).toContain('recovered screen size')
    expect(result.structuredContent?.recoveryWarning).toContain('recovered screen size')
  })

  it('steers agents back to MCP tools when input still fails', async () => {
    stubMissingGeometry()
    installMockSession(makeMockSession(() => null))

    const result = await uiTapHandler({ udid: UDID, label: 'Safari' })

    expect(result.isError).toBe(true)
    const block = result.content[0]
    expect(block?.type === 'text' && block.text).toContain('Do not fall back to shell idb/xcrun coordinate tapping')
    expect(result.structuredContent?.error).toMatchObject({
      mcpRecovery: expect.stringContaining('Stay within the MCP tools'),
    })
  })
})

describe('ui_type', () => {
  it('sends a type envelope', async () => {
    stubScreen()
    const session = makeMockSession(() => axTree([]))
    installMockSession(session)
    await uiTypeHandler({ udid: UDID, text: 'hello' })
    expect(session.sent.find(e => e.type === 'type')).toMatchObject({ type: 'type', text: 'hello' })
  })

  it('taps the target field first when a label is given', async () => {
    stubScreen()
    const session = makeMockSession(() => axTree([{ role: 'AXTextField', identifier: 'email', frame: { x: 20, y: 300, width: 300, height: 40 } }]))
    installMockSession(session)
    await uiTypeHandler({ udid: UDID, text: 'hi', label: 'email' })
    const types = session.sent.map(e => e.type)
    expect(types).toContain('tap')
    expect(types.indexOf('tap')).toBeLessThan(types.indexOf('type'))
  })
})

describe('ui_key / ui_scroll / ui_press', () => {
  it('sends a key envelope with modifiers', async () => {
    const session = makeMockSession(() => axTree([]))
    installMockSession(session)
    await uiKeyHandler({ udid: UDID, code: 'KeyA', modifiers: ['shift', 'command'] })
    expect(session.sent[0]).toMatchObject({ type: 'key', code: 'KeyA', modifiers: ['shift', 'command'] })
  })

  it('sends a scroll envelope', async () => {
    const session = makeMockSession(() => axTree([]))
    installMockSession(session)
    await uiScrollHandler({ udid: UDID, delta_y: -50 })
    expect(session.sent[0]).toMatchObject({ type: 'scroll', deltaX: 0, deltaY: -50 })
  })

  it('sends a button envelope', async () => {
    const session = makeMockSession(() => axTree([]))
    installMockSession(session)
    await uiPressHandler({ udid: UDID, button: 'home' })
    expect(session.sent[0]).toMatchObject({ type: 'button', button: 'home' })
  })
})

describe('ui_swipe', () => {
  it('sends a swipe envelope with screen size', async () => {
    stubScreen(400, 872)
    const session = makeMockSession(() => axTree([]))
    installMockSession(session)
    await uiSwipeHandler({ udid: UDID, x_start: 200, y_start: 700, x_end: 200, y_end: 100 })
    expect(session.sent.find(e => e.type === 'swipe')).toMatchObject({
      type: 'swipe',
      startX: 200,
      startY: 700,
      endX: 200,
      endY: 100,
      width: 400,
      height: 872,
    })
  })

  it('recovers screen size from the accessibility tree when geometry is unavailable', async () => {
    stubMissingGeometry()
    const session = makeMockSession(() => axTree([]))
    installMockSession(session)

    const result = await uiSwipeHandler({ udid: UDID, x_start: 350, y_start: 400, x_end: 50, y_end: 400 })

    expect(result.isError).toBe(false)
    expect(session.sent.find(e => e.type === 'swipe')).toMatchObject({
      type: 'swipe',
      width: 400,
      height: 872,
    })
    expect(result.structuredContent?.recoveryWarning).toContain('recovered screen size')
  })
})
