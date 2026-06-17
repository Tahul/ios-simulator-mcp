import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { isToolFiltered, udidSchema } from '../lib/constants'
import { getBootedDeviceId } from '../lib/devices'
import { errorResult, textResult } from '../lib/errors'
import { ensureAbsolutePath } from '../lib/paths'
import { run } from '../lib/run'

/** Minimal child-process surface needed for recording, satisfied by ChildProcess. */
export interface RecordingProcess {
  stderr: {
    on: (event: 'data', listener: (data: Buffer) => void) => unknown
    off: (event: 'data', listener: (data: Buffer) => void) => unknown
  } | null
  on: (event: 'exit', listener: (code: number | null) => void) => unknown
  off: (event: 'exit', listener: (code: number | null) => void) => unknown
  once: (event: 'exit', listener: (code: number | null) => void) => unknown
  kill: (signal?: NodeJS.Signals) => boolean
  exitCode: number | null
  killed: boolean
}

export type Spawner = (cmd: string, args: string[]) => RecordingProcess

const defaultSpawner: Spawner = (cmd, args) => spawn(cmd, args, {
  // stdout is the MCP JSON-RPC channel; child output must never inherit it.
  stdio: ['ignore', 'ignore', 'pipe'],
})

let currentSpawner: Spawner = defaultSpawner

/** Test seam: replace the process spawner. Pass `null` to restore the default. */
export function setSpawner(spawner: Spawner | null): void {
  currentSpawner = spawner ?? defaultSpawner
}

// The active recording process, tracked so stop_recording can terminate
// exactly the recording this server started instead of pkill-ing globally.
let activeRecording: RecordingProcess | null = null

/** Test seam: clear the tracked recording between tests. */
export function resetRecordingState(): void {
  activeRecording = null
}

const START_TIMEOUT_MS = 5000
const STOP_TIMEOUT_MS = 5000

/**
 * Waits until simctl reports "Recording started" on stderr, the process
 * exits early (failure), or the timeout elapses (assume started if the
 * process is still alive). Listeners and the timer are always cleaned up.
 */
function waitForRecordingStart(proc: RecordingProcess): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let errorOutput = ''
    let settled = false
    let timer: ReturnType<typeof setTimeout>

    function settle(fn: () => void): void {
      if (settled)
        return
      settled = true
      clearTimeout(timer)
      proc.stderr?.off('data', onData)
      proc.off('exit', onExit)
      fn()
    }

    function onData(data: Buffer): void {
      const message = data.toString()
      if (message.includes('Recording started'))
        settle(() => resolve())
      else
        errorOutput += message
    }

    function onExit(code: number | null): void {
      settle(() => reject(new Error(
        errorOutput.trim() || `Recording process exited early with code ${code}`,
      )))
    }

    timer = setTimeout(() => {
      if (proc.killed || proc.exitCode !== null) {
        settle(() => reject(new Error(
          errorOutput.trim() || 'Recording process terminated unexpectedly',
        )))
      }
      else {
        // Still running with no error output — assume the recording started
        settle(() => resolve())
      }
    }, START_TIMEOUT_MS)

    proc.stderr?.on('data', onData)
    proc.on('exit', onExit)
  })
}

export interface RecordVideoParams {
  udid?: string
  output_path?: string
  codec?: 'h264' | 'hevc'
  display?: 'internal' | 'external'
  mask?: 'ignored' | 'alpha' | 'black'
  force?: boolean
  duration_s?: number
}

/**
 * Sends SIGINT (lets simctl finalize the video) and waits for exit, bounded
 * by STOP_TIMEOUT_MS. If the process is still alive at the deadline it is
 * SIGKILLed so we never leave an orphaned recorder behind.
 */
async function stopProcess(proc: RecordingProcess): Promise<void> {
  const exited = new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      if (proc.exitCode === null) {
        try {
          proc.kill('SIGKILL')
        }
        catch {
          // already gone
        }
      }
      resolve()
    }, STOP_TIMEOUT_MS)
    proc.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
  proc.kill('SIGINT')
  await exited
}

export async function recordVideoHandler({ udid, output_path, codec, display, mask, force, duration_s }: RecordVideoParams): Promise<CallToolResult> {
  try {
    if (activeRecording && activeRecording.exitCode === null) {
      throw new Error(
        'A recording is already in progress. Stop it first with stop_recording.',
      )
    }

    const actualUdid = await getBootedDeviceId(udid)
    const defaultFileName = `simulator_recording_${Date.now()}.mp4`
    const outputFile = ensureAbsolutePath(output_path ?? defaultFileName)
    // Create the parent dir so a nested output_path doesn't make simctl fail.
    fs.mkdirSync(path.dirname(outputFile), { recursive: true })

    const recordingProcess = currentSpawner('xcrun', [
      'simctl',
      'io',
      actualUdid,
      'recordVideo',
      ...(codec ? [`--codec=${codec}`] : []),
      ...(display ? [`--display=${display}`] : []),
      ...(mask ? [`--mask=${mask}`] : []),
      ...(force ? ['--force'] : []),
      '--',
      outputFile,
    ])

    await waitForRecordingStart(recordingProcess)

    // Time-boxed mode: record for duration_s, stop, and return the path —
    // no start/act/stop choreography needed.
    if (duration_s != null) {
      await new Promise(resolve => setTimeout(resolve, duration_s * 1000))
      await stopProcess(recordingProcess)
      return textResult(`Recording complete. Video saved to: ${outputFile}`)
    }

    activeRecording = recordingProcess
    recordingProcess.on('exit', () => {
      if (activeRecording === recordingProcess)
        activeRecording = null
    })

    return textResult(
      `Recording started. The video will be saved to: ${outputFile}\nTo stop recording, use the stop_recording command.`,
    )
  }
  catch (error) {
    return errorResult('Error starting recording', error)
  }
}

/**
 * Stops the tracked recording if there is one, otherwise SIGINTs any
 * orphaned `simctl recordVideo` process (e.g. from a previous server
 * instance). Returns a human-readable summary. Shared with cleanup_session.
 */
export async function stopAnyRecording(): Promise<string> {
  const proc = activeRecording

  if (proc && proc.exitCode === null) {
    await stopProcess(proc)
    activeRecording = null
    return 'Recording stopped successfully.'
  }

  // Fallback for recordings not started by this server instance.
  try {
    await run('pkill', ['-SIGINT', '-f', 'simctl.*recordVideo'])
  }
  catch (error) {
    // pkill exits with code 1 when no process matched
    if ((error as { code?: number }).code === 1)
      return 'No active recording found.'
    throw error
  }

  // Give simctl a moment to finalize the video file
  await new Promise(resolve => setTimeout(resolve, 1000))

  return 'Recording stopped successfully.'
}

export async function stopRecordingHandler(): Promise<CallToolResult> {
  try {
    return textResult(await stopAnyRecording())
  }
  catch (error) {
    return errorResult('Error stopping recording', error)
  }
}

export function registerRecordingTools(server: McpServer): void {
  if (!isToolFiltered('record_video')) {
    server.tool(
      'record_video',
      'Records a video of the iOS Simulator screen and returns the output path. Two modes: pass duration_s to record '
      + 'for a fixed time and get the finished file back in one call (preferred), or omit it to start an open-ended '
      + 'recording that you must end with stop_recording. Only one recording can be active at a time.',
      {
        udid: udidSchema,
        output_path: z
          .string()
          .max(1024)
          .optional()
          .describe(
            'Optional output path. If not provided, a default name will be used. The file will be saved in the directory specified by `IOS_SIMULATOR_MCP_DEFAULT_OUTPUT_DIR` or in `~/Downloads` if the environment variable is not set.',
          ),
        duration_s: z
          .number()
          .min(1)
          .max(600)
          .optional()
          .describe('Record for this many seconds, then stop automatically and return the file path. Omit for open-ended recording.'),
        codec: z
          .enum(['h264', 'hevc'])
          .optional()
          .describe('Specifies the codec type: "h264" or "hevc". Default is "hevc".'),
        display: z
          .enum(['internal', 'external'])
          .optional()
          .describe('Display to capture: "internal" or "external". Default depends on device type.'),
        mask: z
          .enum(['ignored', 'alpha', 'black'])
          .optional()
          .describe('For non-rectangular displays, handle the mask by policy: "ignored", "alpha", or "black".'),
        force: z
          .boolean()
          .optional()
          .describe('Force the output file to be written to, even if the file already exists.'),
      },
      { title: 'Record Video', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      recordVideoHandler,
    )
  }

  if (!isToolFiltered('stop_recording')) {
    server.tool(
      'stop_recording',
      'Stops the open-ended video recording started by record_video and finalizes the file. '
      + 'Not needed when record_video was called with duration_s.',
      {},
      { title: 'Stop Recording', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      stopRecordingHandler,
    )
  }
}
