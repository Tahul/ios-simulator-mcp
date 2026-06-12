import { execFile } from 'node:child_process'
import fs from 'node:fs'
import { promisify } from 'node:util'
import { ToolError } from './errors'
import { expandTilde } from './paths'

const execFileAsync = promisify(execFile)

/**
 * Default hard timeout for any external command. No simctl/idb/xcrun call we
 * make should legitimately run longer than this; without it a wedged device
 * or an idb companion stuck connecting hangs the tool (and the agent) forever.
 * Long-running work (video recording) uses spawn, not run(), so it is exempt.
 */
const DEFAULT_TIMEOUT_MS = 30000

// Accessibility dumps for rich screens can be large; 16MB headroom avoids
// ENOBUFS truncation failures while still bounding a runaway stream.
// (Node's implicit default was only 1MB.)
const MAX_BUFFER = 16 * 1024 * 1024

export interface RunResult {
  stdout: string
  stderr: string
}

export interface RunOptions {
  env?: Record<string, string>
  /** Hard timeout in ms; the child is SIGKILLed past it. Default 30s. */
  timeoutMs?: number
}

export type Runner = (cmd: string, args: string[], options?: RunOptions) => Promise<RunResult>

/**
 * Runs a command with arguments and returns the trimmed stdout and stderr.
 * Throws on non-zero exit code, and SIGKILLs + throws a COMMAND_TIMEOUT
 * ToolError if the command exceeds its timeout.
 */
async function defaultRunner(cmd: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  const mergedEnv = options.env ? { ...process.env, ...options.env } : process.env
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      shell: false,
      env: mergedEnv,
      timeout,
      // SIGTERM can be ignored by idb; SIGKILL cannot.
      killSignal: 'SIGKILL',
      maxBuffer: MAX_BUFFER,
    })
    return {
      stdout: stdout.trim(),
      stderr: stderr.trim(),
    }
  }
  catch (error) {
    // execFile sets `killed` + signal when the timeout fired.
    const e = error as NodeJS.ErrnoException & { killed?: boolean, signal?: string }
    if (e.killed && (e.signal === 'SIGKILL' || e.signal === 'SIGTERM')) {
      throw new ToolError(
        `Command timed out after ${Math.round(timeout / 1000)}s and was killed: ${cmd} ${args.join(' ')}`,
        'COMMAND_TIMEOUT',
      )
    }
    throw error
  }
}

let currentRunner: Runner = defaultRunner

/** Test seam: replace the process runner. Pass `null` to restore the default. */
export function setRunner(runner: Runner | null): void {
  currentRunner = runner ?? defaultRunner
}

export function run(cmd: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  return currentRunner(cmd, args, options)
}

/**
 * Resolves the idb executable path from IOS_SIMULATOR_MCP_IDB_PATH,
 * expanding a leading tilde. Defaults to "idb" on PATH.
 * @throws if a custom path is specified but doesn't exist
 */
export function resolveIdbPath(customPath = process.env.IOS_SIMULATOR_MCP_IDB_PATH): string {
  if (!customPath)
    return 'idb'

  const expandedPath = expandTilde(customPath)

  if (!fs.existsSync(expandedPath)) {
    throw new Error(
      `Custom IDB path specified in IOS_SIMULATOR_MCP_IDB_PATH does not exist: ${expandedPath}`,
    )
  }

  return expandedPath
}

let cachedIdbPath: string | undefined

/**
 * Runs the idb command with the given arguments. The executable path is
 * resolved once and cached for the lifetime of the process.
 * @see https://fbidb.io/docs/commands
 */
export function idb(...args: string[]): Promise<RunResult> {
  cachedIdbPath ??= resolveIdbPath()
  return run(cachedIdbPath, args)
}

/** Like idb(), but with an explicit per-call timeout. */
export function idbWithTimeout(timeoutMs: number, ...args: string[]): Promise<RunResult> {
  cachedIdbPath ??= resolveIdbPath()
  return run(cachedIdbPath, args, { timeoutMs })
}
