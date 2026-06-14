import { describe, expect, it } from 'bun:test'
import { verifyExpectation } from '../src/tools/snapshot'
import { axTree, makeMockSession } from './helpers/baguette-mock'

describe('verifyExpectation', () => {
  it('returns null when no expectation is given', async () => {
    const session = makeMockSession(() => axTree([]))
    expect(await verifyExpectation(session, {})).toBeNull()
  })

  it('confirms an element appears', async () => {
    const session = makeMockSession(() => axTree([{ label: 'Dashboard' }]))
    const result = await verifyExpectation(session, { appears: 'Dashboard', timeoutMs: 1000 })
    expect(result?.verified).toBe(true)
    expect(result?.detail).toContain('appeared')
  })

  it('confirms an element is gone', async () => {
    const session = makeMockSession(() => axTree([{ label: 'Home' }]))
    const result = await verifyExpectation(session, { gone: 'Sign in', timeoutMs: 1000 })
    expect(result?.verified).toBe(true)
    expect(result?.detail).toContain('gone')
  })

  it('reports failure when the expectation is not met in time', async () => {
    const session = makeMockSession(() => axTree([{ label: 'Loading' }]))
    const result = await verifyExpectation(session, { appears: 'Dashboard', timeoutMs: 300 })
    expect(result?.verified).toBe(false)
    expect(result?.detail).toContain('did not appear')
  })
})
