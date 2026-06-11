import { execFile } from 'node:child_process'
import fs from 'node:fs'
import { promisify } from 'node:util'
import { expandTilde } from './paths'

const execFileAsync = promisify(execFile)

export interface RunResult {
  stdout: string
  stderr: string
}

export interface RunOptions {
  env?: Record<string, string>
}

export type Runner = (cmd: string, args: string[], options?: RunOptions) => Promise<RunResult>

/**
 * Runs a command with arguments and returns the trimmed stdout and stderr.
 * Throws on non-zero exit code (via execFile).
 */
async function defaultRunner(cmd: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  const mergedEnv = options.env ? { ...process.env, ...options.env } : process.env
  const { stdout, stderr } = await execFileAsync(cmd, args, {
    shell: false,
    env: mergedEnv,
  })
  return {
    stdout: stdout.trim(),
    stderr: stderr.trim(),
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
