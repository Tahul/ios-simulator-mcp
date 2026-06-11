import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Expands a leading `~/` to the user's home directory. */
export function expandTilde(filePath: string): string {
  return filePath.startsWith('~/')
    ? path.join(os.homedir(), filePath.slice(2))
    : filePath
}

/**
 * Resolves a user-provided output path to an absolute path. Relative paths
 * are joined with IOS_SIMULATOR_MCP_DEFAULT_OUTPUT_DIR (or ~/Downloads).
 */
export function ensureAbsolutePath(filePath: string): string {
  if (path.isAbsolute(filePath))
    return filePath

  if (filePath.startsWith('~/'))
    return expandTilde(filePath)

  const customDefaultDir = process.env.IOS_SIMULATOR_MCP_DEFAULT_OUTPUT_DIR
  const defaultDir = customDefaultDir
    ? expandTilde(customDefaultDir)
    : path.join(os.homedir(), 'Downloads')

  return path.join(defaultDir, filePath)
}

let tmpRoot: string | null = null

/** Lazily creates (and caches) a private temp directory for intermediate files. */
export function getTmpRoot(): string {
  tmpRoot ??= fs.mkdtempSync(path.join(os.tmpdir(), 'ios-simulator-mcp-'))
  return tmpRoot
}

/** Removes the temp directory if it was created. Safe to call multiple times. */
export function cleanupTmpRoot(): void {
  if (!tmpRoot)
    return
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  }
  catch {
    // ignore cleanup errors
  }
  tmpRoot = null
}
