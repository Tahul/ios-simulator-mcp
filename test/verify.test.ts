import type { RawElement } from '../src/tools/snapshot'
import { afterEach, describe, expect, it } from 'bun:test'
import { setRunner } from '../src/lib/run'
import { verifyExpectation } from '../src/tools/snapshot'

const UDID = '37A360EC-75F9-4AEC-8EFA-10F4A58D8CCA'

function tree(labels: string[]): RawElement[] {
  return [{
    type: 'Application',
    frame: { x: 0, y: 0, width: 393, height: 852 },
    children: labels.map(l => ({
      type: 'StaticText',
      AXLabel: l,
      frame: { x: 0, y: 0, width: 100, height: 20 },
    })),
  }]
}

afterEach(() => {
  setRunner(null)
})

describe('verifyExpectation', () => {
  it('returns null when no expectation is given', async () => {
    expect(await verifyExpectation(UDID, {})).toBeNull()
  })

  it('confirms an element appears', async () => {
    setRunner(() => Promise.resolve({ stdout: JSON.stringify(tree(['Dashboard'])), stderr: '' }))

    const result = await verifyExpectation(UDID, { appears: 'Dashboard', timeoutMs: 1000 })

    expect(result?.verified).toBe(true)
    expect(result?.detail).toContain('appeared')
  })

  it('confirms an element is gone', async () => {
    setRunner(() => Promise.resolve({ stdout: JSON.stringify(tree(['Home'])), stderr: '' }))

    const result = await verifyExpectation(UDID, { gone: 'Sign in', timeoutMs: 1000 })

    expect(result?.verified).toBe(true)
    expect(result?.detail).toContain('gone')
  })

  it('reports failure when the expectation is not met in time', async () => {
    setRunner(() => Promise.resolve({ stdout: JSON.stringify(tree(['Loading'])), stderr: '' }))

    const result = await verifyExpectation(UDID, { appears: 'Dashboard', timeoutMs: 300 })

    expect(result?.verified).toBe(false)
    expect(result?.detail).toContain('did not appear')
  })
})
