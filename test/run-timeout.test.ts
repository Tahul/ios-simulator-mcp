import { afterEach, describe, expect, it } from 'bun:test'
import { run, setRunner } from '../src/lib/run'

afterEach(() => {
  setRunner(null)
})

describe('run() exec timeout', () => {
  it('kills and throws COMMAND_TIMEOUT when a command exceeds its timeout', async () => {
    setRunner(null) // use the real exec layer
    const start = Date.now()

    let code: string | undefined
    try {
      // `sleep 10` would hang for 10s without the timeout
      await run('sleep', ['10'], { timeoutMs: 300 })
      throw new Error('expected a timeout')
    }
    catch (error) {
      code = (error as { code?: string }).code
    }

    const elapsed = Date.now() - start
    expect(code).toBe('COMMAND_TIMEOUT')
    // Killed promptly, nowhere near the 10s sleep
    expect(elapsed).toBeLessThan(3000)
  })

  it('returns normally for fast commands within the timeout', async () => {
    setRunner(null)
    const { stdout } = await run('echo', ['hello'], { timeoutMs: 5000 })
    expect(stdout).toBe('hello')
  })
})
