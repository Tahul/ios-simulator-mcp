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

const TMP_PREFIX = 'ios-simulator-mcp-'

let tmpRoot: string | null = null

/** Lazily creates (and caches) a private temp directory for intermediate files. */
export function getTmpRoot(): string {
  tmpRoot ??= fs.mkdtempSync(path.join(os.tmpdir(), TMP_PREFIX))
  return tmpRoot
}

/**
 * Removes temp directories left behind by previous server instances that
 * crashed or were killed before their exit cleanup ran. The current
 * instance's directory is preserved.
 */
export function cleanupStaleTmpDirs(): number {
  let removed = 0
  const tmpDir = os.tmpdir()
  const currentName = tmpRoot ? path.basename(tmpRoot) : null

  for (const entry of fs.readdirSync(tmpDir)) {
    if (!entry.startsWith(TMP_PREFIX) || entry === currentName)
      continue
    try {
      fs.rmSync(path.join(tmpDir, entry), { recursive: true, force: true })
      removed += 1
    }
    catch {
      // ignore directories we cannot remove
    }
  }

  return removed
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
