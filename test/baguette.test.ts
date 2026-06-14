import { afterEach, describe, expect, it } from 'bun:test'
import {
  bootDevice,
  collectLogs,
  getScreenSize,
  listDevices,
  resetScreenSizeCache,
  resolveBaseUrls,
  resolveBootedUdid,
  setDefaultDevice,
  setFetchImpl,
  setWsSessionFactory,
  withSession,
} from '../src/lib/baguette'

interface Stub {
  status?: number
  body?: string
}

function stub(routes: (url: string, method: string) => Stub): void {
  setFetchImpl((async (url: string, init?: { method?: string }) => {
    const { status = 200, body = '' } = routes(url, init?.method ?? 'GET')
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => body,
      arrayBuffer: async () => new ArrayBuffer(0),
    }
  }) as any)
}

const origWebSocket = globalThis.WebSocket

afterEach(() => {
  setFetchImpl(null)
  setWsSessionFactory(null)
  resetScreenSizeCache()
  setDefaultDevice(null)
  delete process.env.BAGUETTE_URL
  delete process.env.BAGUETTE_TOKEN
  delete process.env.BAGUETTE_AUTH_TOKEN
  if (origWebSocket)
    globalThis.WebSocket = origWebSocket
})

// Minimal fake WebSocket to exercise openWs's request/reply FIFO. Echoes a
// reply of the same `type` for each text frame it receives, after a tick.
class FakeWebSocket {
  static urls: string[] = []
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  binaryType = 'arraybuffer'
  sent: string[] = []
  constructor(url: string) {
    FakeWebSocket.urls.push(url)
    queueMicrotask(() => this.onopen?.())
  }

  send(data: string): void {
    this.sent.push(data)
    const msg = JSON.parse(data) as { type: string, seq?: number }
    // Reply asynchronously with a result echoing the request's seq.
    setTimeout(() => {
      this.onmessage?.({ data: JSON.stringify({ type: `${msg.type}_result`, seq: msg.seq, ok: true }) })
    }, 5)
  }

  close(): void {}
}

class ClosingBeforeOpenWebSocket {
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  binaryType = 'arraybuffer'
  constructor(_url: string) {
    queueMicrotask(() => this.onclose?.())
  }

  send(_data: string): void {}
  close(): void {}
}

class ClosingAfterSendWebSocket {
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  binaryType = 'arraybuffer'
  constructor(_url: string) {
    queueMicrotask(() => this.onopen?.())
  }

  send(_data: string): void {
    queueMicrotask(() => this.onclose?.())
  }

  close(): void {}
}

class LogFallbackWebSocket {
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  binaryType = 'arraybuffer'
  constructor(url: string) {
    if (url.includes('power-yael')) {
      queueMicrotask(() => this.onclose?.())
      return
    }

    queueMicrotask(() => {
      this.onopen?.()
      this.onmessage?.({ data: JSON.stringify({ type: 'log', line: 'ready' }) })
    })
  }

  send(_data: string): void {}
  close(): void {}
}

describe('resolveBaseUrls', () => {
  it('uses BAGUETTE_URL when set (stripping trailing slash)', () => {
    process.env.BAGUETTE_URL = 'http://example:9000/'
    expect(resolveBaseUrls()).toEqual(['http://example:9000'])
  })

  it('falls back to power-yael then localhost', () => {
    delete process.env.BAGUETTE_URL
    expect(resolveBaseUrls()).toEqual(['http://power-yael:8421', 'http://localhost:8421'])
  })
})

describe('listDevices', () => {
  it('parses running and available', async () => {
    stub(() => ({ body: JSON.stringify({ running: [{ udid: 'A', name: 'X', runtime: 'iOS', state: 'Booted' }], available: [] }) }))
    const list = await listDevices()
    expect(list.running).toHaveLength(1)
    expect(list.running[0]?.udid).toBe('A')
  })

  it('uses /api/v1 and Bearer auth for hosted/authenticated baguette', async () => {
    process.env.BAGUETTE_URL = 'https://ios.yael.dev'
    process.env.BAGUETTE_TOKEN = 'secret-token'
    let captured: { url?: string, auth?: string } = {}
    setFetchImpl((async (url: string, init?: { headers?: Record<string, string> }) => {
      captured = { url, auth: init?.headers?.Authorization }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ running: [], available: [] }),
        arrayBuffer: async () => new ArrayBuffer(0),
      }
    }) as any)

    await listDevices()

    expect(captured.url).toBe('https://ios.yael.dev/api/v1/simulators')
    expect(captured.auth).toBe('Bearer secret-token')
  })
})

describe('resolveBootedUdid', () => {
  it('prefers explicit, then default, then the sole running device', async () => {
    expect(await resolveBootedUdid('EXPLICIT')).toBe('EXPLICIT')

    setDefaultDevice('DEFAULT')
    expect(await resolveBootedUdid()).toBe('DEFAULT')
    setDefaultDevice(null)

    stub(() => ({ body: JSON.stringify({ running: [{ udid: 'RUN', name: 'X', runtime: 'iOS', state: 'Booted' }], available: [] }) }))
    expect(await resolveBootedUdid()).toBe('RUN')
  })

  it('throws when nothing is booted', async () => {
    stub(() => ({ body: JSON.stringify({ running: [], available: [] }) }))
    expect(resolveBootedUdid()).rejects.toThrow(/No booted simulator/)
  })
})

describe('bootDevice', () => {
  it('treats bootFailed as already booted only when a fresh list confirms it', async () => {
    stub((url) => {
      if (url.endsWith('/simulators.json')) {
        return {
          body: JSON.stringify({
            running: [{ udid: 'A', name: 'X', runtime: 'iOS', state: 'Booted' }],
            available: [],
          }),
        }
      }
      return { status: 500, body: JSON.stringify({ ok: false, error: 'bootFailed' }) }
    })

    expect(await bootDevice('A')).toEqual({ alreadyBooted: true })
  })

  it('does not mask a real boot failure for a shutdown device', async () => {
    stub((url) => {
      if (url.endsWith('/simulators.json'))
        return { body: JSON.stringify({ running: [], available: [] }) }
      return { status: 500, body: JSON.stringify({ ok: false, error: 'bootFailed' }) }
    })

    expect(bootDevice('A')).rejects.toThrow(/boot failed: bootFailed/)
  })

  it('reports a fresh boot on 200', async () => {
    stub(() => ({ status: 200, body: '' }))
    expect(await bootDevice('A')).toEqual({ alreadyBooted: false })
  })
})

describe('WS request/reply FIFO', () => {
  afterEach(() => {
    FakeWebSocket.urls = []
  })

  it('matches concurrent same-type replies in order without clobbering', async () => {
    // Use the default WS factory against the fake global WebSocket.
    setWsSessionFactory(null)
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket

    const seqs = await withSession('UDID', async (session) => {
      // Two concurrent requests of the same reply type.
      const a = session.request({ type: 'describe_ui', seq: 1 }, 'describe_ui_result')
      const b = session.request({ type: 'describe_ui', seq: 2 }, 'describe_ui_result')
      const [ra, rb] = await Promise.all([a, b])
      return [ra.seq, rb.seq]
    })

    // Both resolved (neither clobbered/leaked); FIFO maps replies in order.
    expect(seqs.sort()).toEqual([1, 2])
  })

  it('uses /api/v1 and token query for authenticated WebSockets', async () => {
    process.env.BAGUETTE_URL = 'https://ios.yael.dev'
    process.env.BAGUETTE_TOKEN = 'secret-token'
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket

    await withSession('UDID', async (session) => {
      session.send({ type: 'button', button: 'home' })
    })

    expect(FakeWebSocket.urls[0]).toBe('wss://ios.yael.dev/api/v1/simulators/UDID/stream?format=mjpeg&version=v2&token=secret-token')
  })

  it('rejects immediately when the stream closes before opening', async () => {
    process.env.BAGUETTE_URL = 'https://ios.yael.dev'
    globalThis.WebSocket = ClosingBeforeOpenWebSocket as unknown as typeof WebSocket

    await expect(withSession('UDID', async () => {})).rejects.toThrow(/closed before opening/)
  })

  it('rejects pending requests when the stream closes after opening', async () => {
    process.env.BAGUETTE_URL = 'https://ios.yael.dev'
    globalThis.WebSocket = ClosingAfterSendWebSocket as unknown as typeof WebSocket

    await expect(withSession('UDID', async (session) => {
      await session.request({ type: 'describe_ui' }, 'describe_ui_result', 1000)
    })).rejects.toThrow(/WebSocket closed/)
  })
})

describe('collectLogs', () => {
  it('falls through when a logs socket closes before opening', async () => {
    globalThis.WebSocket = LogFallbackWebSocket as unknown as typeof WebSocket

    await expect(collectLogs('UDID', { maxLines: 1, windowMs: 1000 })).resolves.toEqual(['ready'])
  })
})

describe('getScreenSize', () => {
  it('reads screen from chrome.json and caches it', async () => {
    let hits = 0
    stub((url) => {
      if (url.includes('/chrome.json')) {
        hits += 1
        return { body: JSON.stringify({ screen: { width: 400, height: 872 }, composite: { width: 454, height: 908 } }) }
      }
      return { status: 404 }
    })

    expect(await getScreenSize('A')).toEqual({ width: 400, height: 872 })
    // second call is served from cache (no extra fetch)
    expect(await getScreenSize('A')).toEqual({ width: 400, height: 872 })
    expect(hits).toBe(1)
  })
})
