import { describe, expect, it } from 'bun:test'
import { errorResult, inferErrorCode, textResult, ToolError } from '../src/lib/errors'

describe('inferErrorCode', () => {
  it('maps known messages to codes', () => {
    expect(inferErrorCode('No booted simulator found')).toBe('NO_BOOTED_SIM')
    expect(inferErrorCode('idb: command not found')).toBe('IDB_MISSING')
    expect(inferErrorCode('Invalid device: ABC')).toBe('DEVICE_NOT_FOUND')
    expect(inferErrorCode('Could not open a baguette stream')).toBe('BAGUETTE_UNREACHABLE')
    expect(inferErrorCode('Metro dev server is not responding')).toBe('METRO_UNREACHABLE')
    expect(inferErrorCode('No on-screen element matching "x"')).toBe('ELEMENT_NOT_FOUND')
    expect(inferErrorCode('something weird')).toBe('UNKNOWN')
  })
})

describe('errorResult', () => {
  it('uses the ToolError code and recovery', () => {
    const result = errorResult('Failed', new ToolError('No booted simulator found', 'NO_BOOTED_SIM'))
    expect(result.isError).toBe(true)
    const block = result.content[0]
    expect(block?.type === 'text' && block.text).toContain('[NO_BOOTED_SIM]')
    expect(result.structuredContent).toMatchObject({
      error: { code: 'NO_BOOTED_SIM' },
    })
    const struct = result.structuredContent as { error: { recovery: string } }
    expect(struct.error.recovery).toContain('boot_sim')
  })

  it('infers a code from a plain error', () => {
    const result = errorResult('Failed', new Error('Metro not responding'))
    const struct = result.structuredContent as { error: { code: string } }
    expect(struct.error.code).toBe('METRO_UNREACHABLE')
  })

  it('uses the baguette recovery for baguette ToolErrors', () => {
    const result = errorResult(
      'Failed',
      new ToolError('Could not open a baguette stream', 'BAGUETTE_UNREACHABLE'),
    )
    const struct = result.structuredContent as { error: { code: string, recovery: string } }
    expect(struct.error.code).toBe('BAGUETTE_UNREACHABLE')
    expect(struct.error.recovery).toContain('baguette serve')
  })

  it('prefers an explicit hint over the default recovery', () => {
    const result = errorResult('Failed', new Error('weird'), 'do this instead')
    const block = result.content[0]
    expect(block?.type === 'text' && block.text).toContain('do this instead')
  })
})

describe('textResult', () => {
  it('attaches structured content when provided', () => {
    const result = textResult('hi', { a: 1 })
    expect(result.structuredContent).toEqual({ a: 1 })
  })

  it('omits structured content when not provided', () => {
    const result = textResult('hi')
    expect(result.structuredContent).toBeUndefined()
  })
})
