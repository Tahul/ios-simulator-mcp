import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'

function sourceFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  return entries.flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory())
      return sourceFiles(full)
    return entry.isFile() && entry.name.endsWith('.ts') ? [full] : []
  })
}

describe('stdio hygiene', () => {
  it('does not write application logs to stdout', () => {
    const offenders = sourceFiles(path.join(process.cwd(), 'src')).flatMap((file) => {
      const text = fs.readFileSync(file, 'utf8')
      return /\bconsole\.log\b|\bprocess\.stdout\b/.test(text) ? [path.relative(process.cwd(), file)] : []
    })

    expect(offenders).toEqual([])
  })
})
