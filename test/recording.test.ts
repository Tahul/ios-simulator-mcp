import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { Buffer } from 'node:buffer'
import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it } from 'bun:test'
import { setRunner } from '../src/lib/run'
import {
  recordVideoHandler,
  resetRecordingState,
  setSpawner,
  stopRecordingHandler,
} from '../src/tools/recording'

const UDID = '37A360EC-75F9-4AEC-8EFA-10F4A58D8CCA'

class FakeRecordingProcess extends EventEmitter {
  stderr = new EventEmitter()
  exitCode: number | null = null
  killed = false
  lastSignal: string | undefined

  kill(signal?: NodeJS.Signals): boolean {
    this.lastSignal = signal
    this.killed = true
    this.exitCode = 0
    this.emit('exit', 0)
    return true
  }
}

function firstText(result: CallToolResult): string {
  const block = result.content[0]
  return block && block.type === 'text' ? block.text : ''
}

afterEach(() => {
  setSpawner(null)
  setRunner(null)
  resetRecordingState()
})

describe('record_video', () => {
  it('resolves once simctl reports "Recording started"', async () => {
    const fake = new FakeRecordingProcess()
    let spawnedArgs: string[] = []
    setSpawner((_cmd, args) => {
      spawnedArgs = args
      setTimeout(() => fake.stderr.emit('data', Buffer.from('Recording started')), 0)
      return fake
    })

    const result = await recordVideoHandler({ udid: UDID, output_path: '/tmp/video.mp4', codec: 'h264' })

    expect(result.isError).toBe(false)
    expect(firstText(result)).toContain('/tmp/video.mp4')
    expect(spawnedArgs).toEqual([
      'simctl',
      'io',
      UDID,
      'recordVideo',
      '--codec=h264',
      '--',
      '/tmp/video.mp4',
    ])
  })

  it('reports an error when the process exits early', async () => {
    const fake = new FakeRecordingProcess()
    setSpawner(() => {
      setTimeout(() => {
        fake.stderr.emit('data', Buffer.from('Invalid device'))
        fake.exitCode = 1
        fake.emit('exit', 1)
      }, 0)
      return fake
    })

    const result = await recordVideoHandler({ udid: UDID })

    expect(result.isError).toBe(true)
    expect(firstText(result)).toContain('Invalid device')
  })

  it('records for duration_s then stops automatically and returns the path', async () => {
    const fake = new FakeRecordingProcess()
    setSpawner(() => {
      setTimeout(() => fake.stderr.emit('data', Buffer.from('Recording started')), 0)
      return fake
    })

    const result = await recordVideoHandler({ udid: UDID, output_path: '/tmp/clip.mp4', duration_s: 0.05 })

    expect(result.isError).toBe(false)
    expect(fake.lastSignal).toBe('SIGINT')
    expect(firstText(result)).toContain('Recording complete. Video saved to: /tmp/clip.mp4')
  })

  it('refuses to start a second recording while one is active', async () => {
    const fake = new FakeRecordingProcess()
    setSpawner(() => {
      setTimeout(() => fake.stderr.emit('data', Buffer.from('Recording started')), 0)
      return fake
    })

    await recordVideoHandler({ udid: UDID })
    const second = await recordVideoHandler({ udid: UDID })

    expect(second.isError).toBe(true)
    expect(firstText(second)).toContain('already in progress')
  })
})

describe('stop_recording', () => {
  it('SIGINTs the tracked recording process', async () => {
    const fake = new FakeRecordingProcess()
    setSpawner(() => {
      setTimeout(() => fake.stderr.emit('data', Buffer.from('Recording started')), 0)
      return fake
    })

    await recordVideoHandler({ udid: UDID })
    const result = await stopRecordingHandler()

    expect(result.isError).toBe(false)
    expect(fake.lastSignal).toBe('SIGINT')
    expect(firstText(result)).toContain('Recording stopped successfully')
  })

  it('reports no active recording when pkill matches nothing', async () => {
    setRunner(() => {
      const error = new Error('pkill failed') as Error & { code: number }
      error.code = 1
      return Promise.reject(error)
    })

    const result = await stopRecordingHandler()

    expect(result.isError).toBe(false)
    expect(firstText(result)).toBe('No active recording found.')
  })

  it('surfaces real pkill failures', async () => {
    setRunner(() => {
      const error = new Error('pkill exploded') as Error & { code: number }
      error.code = 2
      return Promise.reject(error)
    })

    const result = await stopRecordingHandler()

    expect(result.isError).toBe(true)
    expect(firstText(result)).toContain('pkill exploded')
  })
})
