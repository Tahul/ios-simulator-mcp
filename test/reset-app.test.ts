import { afterEach, describe, expect, it } from 'bun:test'
import { setRunner } from '../src/lib/run'
import { resetAppHandler } from '../src/tools/apps'

const UDID = '37A360EC-75F9-4AEC-8EFA-10F4A58D8CCA'

afterEach(() => {
  setRunner(null)
})

describe('reset_app', () => {
  it('terminates, resets privacy, and uninstalls', async () => {
    const calls: string[][] = []
    setRunner((cmd, args) => {
      calls.push([cmd, ...args])
      if (args.includes('list'))
        return Promise.resolve({ stdout: JSON.stringify({ devices: { rt: [{ udid: UDID, name: 'X', state: 'Booted', isAvailable: true }] } }), stderr: '' })
      return Promise.resolve({ stdout: '', stderr: '' })
    })

    const result = await resetAppHandler({ udid: UDID, bundle_id: 'com.example.app' })

    expect(result.isError).toBe(false)
    const verbs = calls.map(c => c[2]).filter(Boolean)
    expect(verbs).toContain('terminate')
    expect(verbs).toContain('privacy')
    expect(verbs).toContain('uninstall')
    const block = result.content[0]
    expect(block?.type === 'text' && block.text).toContain('uninstalled')
  })

  it('tolerates an app that is not running', async () => {
    setRunner((_cmd, args) => {
      if (args[1] === 'terminate')
        return Promise.reject(new Error('not running'))
      return Promise.resolve({ stdout: '', stderr: '' })
    })

    const result = await resetAppHandler({ udid: UDID, bundle_id: 'com.example.app' })

    expect(result.isError).toBe(false)
    const block = result.content[0]
    expect(block?.type === 'text' && block.text).toContain('not running')
  })
})
