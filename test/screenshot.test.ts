import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'bun:test'
import { setFetchImpl } from '../src/lib/baguette'
import { screenshotHandler } from '../src/tools/screenshot'

const UDID = '37A360EC-75F9-4AEC-8EFA-10F4A58D8CCA'

function stubScreenshot(): void {
  setFetchImpl((async () => ({
    ok: true,
    status: 200,
    text: async () => '',
    arrayBuffer: async () => new TextEncoder().encode('FAKEJPEG').buffer,
  })) as any)
}

afterEach(() => {
  setFetchImpl(null)
})

describe('screenshot', () => {
  it('creates missing parent directories for a nested output_path', async () => {
    stubScreenshot()
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shot-test-'))
    const out = path.join(dir, 'nested', 'deep', 'shot.jpg')
    try {
      const result = await screenshotHandler({ udid: UDID, output_path: out })

      expect(result.isError).toBe(false)
      expect(fs.existsSync(out)).toBe(true)
    }
    finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
