import { Buffer } from 'node:buffer'
import { ToolError } from './errors'

/**
 * Client for a running `baguette serve` instance (HTTP + WebSocket).
 *
 * Transport split (confirmed against a live server):
 * - Plain HTTP: list, boot, shutdown, orientation, definition.json/chrome.json, screenshot.jpg.
 * - Stream WebSocket (/simulators/:udid/stream): ALL interactive input
 *   (tap/swipe/type/key/press/scroll/pinch/pan/streaming touches) plus the
 *   request/reply verbs describe_ui and snapshot. The stream socket does NOT
 *   ack gestures — only describe_ui/snapshot get a reply — so callers verify
 *   effects with a follow-up describe_ui or screenshot.
 *
 * If no server is reachable, every call fails fast with a METRO_UNREACHABLE
 * ToolError pointing the user at `baguette serve` / BAGUETTE_URL.
 */

const DEFAULT_BASES = ['http://localhost:8421']

/** Resolves candidate base URLs: env override first, then the defaults. */
export function resolveBaseUrls(): string[] {
  const env = process.env.BAGUETTE_URL?.trim()
  if (env)
    return [env.replace(/\/$/, '')]
  return DEFAULT_BASES
}

export interface FetchLike {
  (url: string, init?: { method?: string, body?: string, headers?: Record<string, string>, signal?: AbortSignal }): Promise<{
    ok: boolean
    status: number
    text: () => Promise<string>
    arrayBuffer: () => Promise<ArrayBuffer>
  }>
}

// Test seam: HTTP transport. Null → late-bound global fetch (so tests that
// stub globalThis.fetch still work).
let fetchOverride: FetchLike | null = null

function fetchImpl(url: string, init?: { method?: string, body?: string, headers?: Record<string, string>, signal?: AbortSignal }): ReturnType<FetchLike> {
  const impl = fetchOverride ?? (globalThis.fetch as unknown as FetchLike)
  return impl(url, init)
}

/** Test seam: replace the HTTP transport. Pass null to restore global fetch. */
export function setFetchImpl(impl: FetchLike | null): void {
  fetchOverride = impl
}

// Test seam: WebSocket session factory. Defaults to a global-WebSocket impl.
let wsSessionFactory: WsSessionFactory | null = null

/** Test seam: replace the WS session factory. Pass null to restore default. */
export function setWsSessionFactory(factory: WsSessionFactory | null): void {
  wsSessionFactory = factory
}

const HTTP_TIMEOUT_MS = 10000

function baguetteToken(): string | null {
  return process.env.BAGUETTE_TOKEN?.trim() || process.env.BAGUETTE_AUTH_TOKEN?.trim() || null
}

function authHeaders(): Record<string, string> | undefined {
  const token = baguetteToken()
  return token ? { Authorization: `Bearer ${token}` } : undefined
}

function appendQuery(path: string, params: Record<string, string | undefined>): string {
  const url = new URL(path, 'http://internal')
  for (const [key, value] of Object.entries(params)) {
    if (value != null && value !== '')
      url.searchParams.set(key, value)
  }
  return `${url.pathname}${url.search}`
}

function baseUsesVersionedApi(base: string): boolean {
  if (/\/api\/v1\/?$/.test(base))
    return true

  // Authenticated/hosted baguette exposes the consumer contract under /api/v1.
  // Local legacy baguette (no token, :8421) keeps the original unversioned tree.
  return !!baguetteToken() || /^https:\/\/ios\.yael\.dev(?:\/|$)/.test(base)
}

function stripApiPrefix(base: string): string {
  return base.replace(/\/api\/v1\/?$/, '')
}

function apiPath(base: string, versioned: string, legacy: string): string {
  return baseUsesVersionedApi(base) ? versioned : legacy
}

async function httpFetch(
  path: string | ((base: string) => string),
  init: { method?: string } = {},
): Promise<{ base: string, status: number, text: string }> {
  const bases = resolveBaseUrls()
  let lastError: unknown

  for (const base of bases) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS)
    try {
      const resolvedPath = typeof path === 'function' ? path(base) : path
      const res = await fetchImpl(`${stripApiPrefix(base)}${resolvedPath}`, {
        method: init.method ?? 'GET',
        headers: authHeaders(),
        signal: controller.signal,
      })
      clearTimeout(timer)
      const text = await res.text()
      return { base, status: res.status, text }
    }
    catch (error) {
      clearTimeout(timer)
      lastError = error
      // Try the next candidate base URL.
    }
  }

  throw new ToolError(
    `Could not reach a baguette server at any of: ${bases.join(', ')}. `
    + `Start one with \`baguette serve\` or set BAGUETTE_URL. (${(lastError as Error)?.message ?? 'unknown error'})`,
    'METRO_UNREACHABLE',
  )
}

export interface BaguetteDevice {
  udid: string
  name: string
  runtime: string
  state: string
}

export interface DeviceList {
  running: BaguetteDevice[]
  available: BaguetteDevice[]
}

function parseJson<T>(text: string, what: string): T {
  try {
    return JSON.parse(text) as T
  }
  catch {
    throw new ToolError(`baguette returned malformed JSON for ${what}.`, 'UNKNOWN')
  }
}

function statusMessage(action: string, status: number): string {
  if (status === 401)
    return `${action} failed (HTTP 401 Unauthorized). Set BAGUETTE_TOKEN to the shared baguette token.`
  if (status === 403)
    return `${action} failed (HTTP 403 Forbidden). The token was rejected for this request.`
  return `${action} failed (HTTP ${status})`
}

export async function listDevices(): Promise<DeviceList> {
  const { status, text } = await httpFetch(base => apiPath(base, '/api/v1/simulators', '/simulators.json'))
  if (status !== 200)
    throw new ToolError(statusMessage('baguette list', status), status === 401 || status === 403 ? 'INVALID_ARGUMENT' : 'UNKNOWN')
  const data = parseJson<Partial<DeviceList>>(text, 'device list')
  return { running: data.running ?? [], available: data.available ?? [] }
}

// Session default device; honored by resolveBootedUdid when no explicit udid.
let defaultUdid: string | null = null

/** Sets (or clears, with null) the session default device UDID. */
export function setDefaultDevice(udid: string | null): void {
  defaultUdid = udid
}

/** Returns the session default device UDID, if any. */
export function getDefaultDevice(): string | null {
  return defaultUdid
}

/** Returns the UDID of the target device, honoring explicit > default > sole booted. */
export async function resolveBootedUdid(explicit?: string): Promise<string> {
  if (explicit)
    return explicit
  if (defaultUdid)
    return defaultUdid
  const { running } = await listDevices()
  if (running.length === 0)
    throw new ToolError('No booted simulator found. Boot one with boot_sim.', 'NO_BOOTED_SIM')
  return running[0]!.udid
}

interface OkResult {
  ok: boolean
  error?: string
}

function parseOk(text: string): OkResult {
  try {
    return JSON.parse(text) as OkResult
  }
  catch {
    return { ok: true }
  }
}

export async function bootDevice(udid: string): Promise<{ alreadyBooted: boolean }> {
  const { status, text } = await httpFetch(
    base => apiPath(base, `/api/v1/simulators/${udid}/boot`, `/simulators/${udid}/boot`),
    { method: 'POST' },
  )
  if (status === 200)
    return { alreadyBooted: false }
  const body = parseOk(text)
  // The server may report an already-booted device as `bootFailed`. Verify
  // with a fresh list before treating that opaque error as success; otherwise
  // a real boot failure for a shutdown device would be masked.
  if (/bootfailed|already/i.test(body.error ?? '')) {
    const { running } = await listDevices()
    if (running.some(d => d.udid === udid))
      return { alreadyBooted: true }
  }
  throw new ToolError(body.error ? `boot failed: ${body.error}` : statusMessage('boot', status), status === 401 || status === 403 ? 'INVALID_ARGUMENT' : 'UNKNOWN')
}

export async function shutdownDevice(udid: string): Promise<void> {
  const { status, text } = await httpFetch(
    base => apiPath(base, `/api/v1/simulators/${udid}/shutdown`, `/simulators/${udid}/shutdown`),
    { method: 'POST' },
  )
  if (status !== 200) {
    const body = parseOk(text)
    throw new ToolError(body.error ? `shutdown failed: ${body.error}` : statusMessage('shutdown', status), status === 401 || status === 403 ? 'INVALID_ARGUMENT' : 'UNKNOWN')
  }
}

export type Orientation = 'portrait' | 'landscape-left' | 'landscape-right' | 'portrait-upside-down'

export async function setOrientation(udid: string, value: Orientation): Promise<void> {
  const { status, text } = await httpFetch(
    base => apiPath(
      base,
      `/api/v1/simulators/${udid}/orientation?value=${encodeURIComponent(value)}`,
      `/simulators/${udid}/orientation?value=${encodeURIComponent(value)}`,
    ),
    { method: 'POST' },
  )
  if (status !== 200) {
    const body = parseOk(text)
    throw new ToolError(body.error ? `orientation failed: ${body.error}` : statusMessage('orientation', status), status === 401 || status === 403 ? 'INVALID_ARGUMENT' : 'UNKNOWN')
  }
}

export interface ScreenSize {
  width: number
  height: number
}

interface ChromeLayout {
  screen?: { width: number, height: number }
  composite?: { width: number, height: number }
}

interface SimulatorDefinition {
  screen?: {
    rect?: { width: number, height: number }
    viewport?: { width: number, height: number }
  }
}

function screenSizeFromGeometry(data: ChromeLayout & SimulatorDefinition): ScreenSize | null {
  if (data.screen?.rect && typeof data.screen.rect.width === 'number' && typeof data.screen.rect.height === 'number')
    return { width: data.screen.rect.width, height: data.screen.rect.height }

  if (data.screen && typeof data.screen.width === 'number' && typeof data.screen.height === 'number')
    return { width: data.screen.width, height: data.screen.height }

  return null
}

// Screen size (device points) per UDID. Stable for a device, so caching avoids
// a geometry round-trip on every gesture.
const screenSizeCache = new Map<string, ScreenSize>()

/** Test seam: clear the per-UDID screen-size cache. */
export function resetScreenSizeCache(): void {
  screenSizeCache.clear()
}

/**
 * Resolves a device's screen size in points. Versioned baguette exposes this
 * through definition.json; legacy local baguette also supports chrome.json.
 * Required for every gesture (baguette normalizes x/y against width/height).
 * Cached.
 */
export async function getScreenSize(udid: string): Promise<ScreenSize> {
  const cached = screenSizeCache.get(udid)
  if (cached)
    return cached

  const { status, text } = await httpFetch(
    base => apiPath(base, `/api/v1/simulators/${udid}/definition.json`, `/simulators/${udid}/chrome.json`),
  )
  if (status !== 200)
    throw new ToolError(status === 401 || status === 403 ? statusMessage('screen geometry', status) : `Could not read screen geometry for ${udid} (HTTP ${status})`, status === 401 || status === 403 ? 'INVALID_ARGUMENT' : 'DEVICE_NOT_FOUND')

  const geometry = parseJson<ChromeLayout & SimulatorDefinition>(text, 'screen geometry')
  const size = screenSizeFromGeometry(geometry)
  if (!size)
    throw new ToolError(`Screen geometry for ${udid} has no usable screen size`, 'UNKNOWN')

  screenSizeCache.set(udid, size)
  return size
}

/** Captures a screenshot as base64 JPEG via the HTTP route. */
export async function captureScreenshot(udid: string, opts: { quality?: number, scale?: number } = {}): Promise<string> {
  const params = new URLSearchParams()
  if (opts.quality != null)
    params.set('quality', String(opts.quality))
  if (opts.scale != null)
    params.set('scale', String(opts.scale))
  const qs = params.toString()
  const bases = resolveBaseUrls()
  let lastError: unknown
  for (const base of bases) {
    const route = apiPath(
      base,
      `/api/v1/simulators/${udid}/screenshot.jpg${qs ? `?${qs}` : ''}`,
      `/simulators/${udid}/screenshot.jpg${qs ? `?${qs}` : ''}`,
    )
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS)
    try {
      const res = await fetchImpl(`${stripApiPrefix(base)}${route}`, {
        headers: authHeaders(),
        signal: controller.signal,
      })
      clearTimeout(timer)
      if (res.status === 404) {
        throw new ToolError(
          'Screenshot unavailable: the simulator emitted no frame (it may be idle). '
          + 'Send a gesture to wake it, then retry.',
          'UNKNOWN',
        )
      }
      if (!res.ok)
        throw new ToolError(statusMessage('screenshot', res.status), res.status === 401 || res.status === 403 ? 'INVALID_ARGUMENT' : 'UNKNOWN')
      const buf = await res.arrayBuffer()
      return Buffer.from(buf).toString('base64')
    }
    catch (error) {
      clearTimeout(timer)
      if (error instanceof ToolError)
        throw error
      lastError = error
    }
  }
  throw new ToolError(
    `Could not reach a baguette server for screenshot (${(lastError as Error)?.message ?? 'unknown'})`,
    'METRO_UNREACHABLE',
  )
}

// ---------------------------------------------------------------------------
// WebSocket stream session: gesture send + describe_ui/snapshot request-reply.
// ---------------------------------------------------------------------------

export interface WsSession {
  /** Sends a fire-and-forget gesture envelope (no ack on the stream socket). */
  send: (envelope: Record<string, unknown>) => void
  /** Sends a request and waits for the matching reply type. */
  request: (envelope: Record<string, unknown>, replyType: string, timeoutMs?: number) => Promise<Record<string, unknown>>
  close: () => void
}

export type WsSessionFactory = (udid: string) => Promise<WsSession>

const WS_CONNECT_TIMEOUT_MS = 8000
const WS_REPLY_TIMEOUT_MS = 8000

function toWsUrl(base: string, udid: string): string {
  const wsBase = stripApiPrefix(base).replace(/^http/, 'ws')
  const path = apiPath(base, `/api/v1/simulators/${udid}/stream`, `/simulators/${udid}/stream`)
  return `${wsBase}${appendQuery(path, {
    format: 'mjpeg',
    version: baseUsesVersionedApi(base) ? 'v2' : undefined,
    token: baguetteToken() ?? undefined,
  })}`
}

/** Default WS session over the global WebSocket, racing candidate base URLs. */
const defaultWsSessionFactory: WsSessionFactory = async (udid) => {
  const bases = resolveBaseUrls()
  let lastError: unknown

  for (const base of bases) {
    try {
      return await openWs(toWsUrl(base, udid))
    }
    catch (error) {
      lastError = error
    }
  }
  throw new ToolError(
    `Could not open a baguette stream for ${udid} at: ${bases.join(', ')} `
    + `(${(lastError as Error)?.message ?? 'unknown'})`,
    'METRO_UNREACHABLE',
  )
}

interface PendingRequest {
  resolve: (v: Record<string, unknown>) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
}

function openWs(url: string): Promise<WsSession> {
  return new Promise<WsSession>((resolve, reject) => {
    const ws = new WebSocket(url)
    ws.binaryType = 'arraybuffer'
    let opened = false
    let settledConnect = false
    let connectTimer: ReturnType<typeof setTimeout>

    // FIFO queue per reply type: concurrent requests of the same type (e.g.
    // overlapping describe_ui) each get the next matching reply in order,
    // instead of clobbering one another.
    const pending = new Map<string, PendingRequest[]>()

    function settleNext(type: string, value: Record<string, unknown>): void {
      const queue = pending.get(type)
      if (!queue || queue.length === 0)
        return
      const entry = queue.shift()!
      if (queue.length === 0)
        pending.delete(type)
      clearTimeout(entry.timer)
      entry.resolve(value)
    }

    function rejectPending(error: Error): void {
      for (const queue of pending.values()) {
        for (const entry of queue) {
          clearTimeout(entry.timer)
          entry.reject(error)
        }
      }
      pending.clear()
    }

    function rejectConnect(error: Error): void {
      if (settledConnect)
        return
      settledConnect = true
      clearTimeout(connectTimer)
      reject(error)
    }

    const session: WsSession = {
      send(envelope) {
        ws.send(JSON.stringify(envelope))
      },
      request(envelope, replyType, timeoutMs = WS_REPLY_TIMEOUT_MS) {
        return new Promise<Record<string, unknown>>((res, rej) => {
          const entry: PendingRequest = { resolve: res, reject: rej, timer: undefined as unknown as ReturnType<typeof setTimeout> }
          entry.timer = setTimeout(() => {
            const queue = pending.get(replyType)
            if (queue) {
              const idx = queue.indexOf(entry)
              if (idx !== -1)
                queue.splice(idx, 1)
              if (queue.length === 0)
                pending.delete(replyType)
            }
            rej(new ToolError(`Timed out waiting for ${replyType}`, 'COMMAND_TIMEOUT'))
          }, timeoutMs)
          const queue = pending.get(replyType)
          if (queue)
            queue.push(entry)
          else
            pending.set(replyType, [entry])
          ws.send(JSON.stringify(envelope))
        })
      },
      close() {
        rejectPending(new Error('WebSocket closed'))
        closeSocket(ws)
      },
    }

    connectTimer = setTimeout(() => {
      closeSocket(ws)
      rejectConnect(new Error('WebSocket connect timed out'))
    }, WS_CONNECT_TIMEOUT_MS)

    ws.onopen = () => {
      opened = true
      settledConnect = true
      resolve(session)
    }

    ws.onerror = () => {
      if (!opened)
        rejectConnect(new Error('WebSocket error'))
      else
        rejectPending(new Error('WebSocket error'))
    }

    ws.onclose = () => {
      if (!opened)
        rejectConnect(new Error('WebSocket closed before opening'))
      else
        rejectPending(new Error('WebSocket closed'))
    }

    ws.onmessage = (ev: MessageEvent) => {
      // Binary frames are the live video stream — ignore them here.
      if (typeof ev.data !== 'string')
        return
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(ev.data) as Record<string, unknown>
      }
      catch {
        return
      }
      const type = msg.type as string | undefined
      if (type)
        settleNext(type, msg)
    }
  })
}

function closeSocket(ws: WebSocket): void {
  try {
    ws.close()
  }
  catch {
    // already closed
  }
}

/** Opens a stream session (test seam aware). Caller must close it. */
export function openSession(udid: string): Promise<WsSession> {
  return (wsSessionFactory ?? defaultWsSessionFactory)(udid)
}

export interface LogOptions {
  level?: 'default' | 'info' | 'debug'
  predicate?: string
  bundleId?: string
  /** Stop after this many lines (default 200). */
  maxLines?: number
  /** Stop after this many ms even if maxLines isn't reached (default 4000). */
  windowMs?: number
}

// Test seam: log collector. Defaults to a global-WebSocket implementation.
let logCollector: ((udid: string, opts: LogOptions) => Promise<string[]>) | null = null

/** Test seam: replace the log collector. Pass null to restore default. */
export function setLogCollector(fn: ((udid: string, opts: LogOptions) => Promise<string[]>) | null): void {
  logCollector = fn
}

function logWsUrl(base: string, udid: string, opts: LogOptions): string {
  const wsBase = stripApiPrefix(base).replace(/^http/, 'ws')
  const path = apiPath(base, `/api/v1/simulators/${udid}/logs`, `/simulators/${udid}/logs`)
  return `${wsBase}${appendQuery(path, {
    level: opts.level,
    predicate: opts.predicate,
    bundleId: opts.bundleId,
    token: baguetteToken() ?? undefined,
  })}`
}

/**
 * Collects a bounded batch of unified-log lines from the logs WS: closes after
 * `maxLines` lines or `windowMs`, whichever comes first. Keeps the tool call
 * bounded (the underlying stream is open-ended).
 */
export function collectLogs(udid: string, opts: LogOptions = {}): Promise<string[]> {
  if (logCollector)
    return logCollector(udid, opts)

  const maxLines = opts.maxLines ?? 200
  const windowMs = opts.windowMs ?? 4000
  const bases = resolveBaseUrls()

  return new Promise<string[]>((resolve, reject) => {
    const lines: string[] = []
    let settled = false

    const tryBase = (i: number): void => {
      if (i >= bases.length) {
        reject(new ToolError(`Could not reach a baguette server for logs at: ${bases.join(', ')}`, 'METRO_UNREACHABLE'))
        return
      }
      const socket = new WebSocket(logWsUrl(bases[i]!, udid, opts))
      let timer: ReturnType<typeof setTimeout>
      let opened = false
      let socketDone = false

      const finish = (): void => {
        if (settled || socketDone)
          return
        socketDone = true
        settled = true
        clearTimeout(timer)
        closeSocket(socket)
        resolve(lines)
      }

      const tryNext = (): void => {
        if (settled || socketDone)
          return
        socketDone = true
        clearTimeout(timer)
        closeSocket(socket)
        tryBase(i + 1)
      }

      timer = setTimeout(finish, windowMs)

      socket.onopen = () => {
        opened = true
      }

      socket.onmessage = (ev: MessageEvent) => {
        if (typeof ev.data !== 'string')
          return
        try {
          const msg = JSON.parse(ev.data) as { type?: string, line?: string }
          if (msg.type === 'log' && typeof msg.line === 'string') {
            lines.push(msg.line)
            if (lines.length >= maxLines)
              finish()
          }
        }
        catch {
          // ignore non-JSON frames
        }
      }
      socket.onerror = () => {
        tryNext()
      }
      socket.onclose = () => {
        if (!opened)
          tryNext()
        else
          finish()
      }
    }

    tryBase(0)
  })
}

// Grace period before closing a session so the last fire-and-forget gesture
// (send() returns before the frame is on the wire) is flushed. close() flushes
// queued data on spec-compliant sockets, but this removes any cross-runtime race.
const FLUSH_BEFORE_CLOSE_MS = 50

/**
 * Convenience: open a session, run `fn`, always close. Most tools send one or
 * two envelopes per call, so a short-lived session keeps the model simple.
 * `flushMs` waits before closing so a trailing fire-and-forget send is
 * guaranteed delivered (gestures get no ack on the stream socket).
 */
export async function withSession<T>(
  udid: string,
  fn: (session: WsSession) => Promise<T>,
  { flushMs = 0 }: { flushMs?: number } = {},
): Promise<T> {
  const session = await openSession(udid)
  try {
    const result = await fn(session)
    if (flushMs > 0)
      await new Promise(resolve => setTimeout(resolve, flushMs))
    return result
  }
  finally {
    session.close()
  }
}

/** Default flush grace for fire-and-forget gesture tools. */
export const GESTURE_FLUSH_MS = FLUSH_BEFORE_CLOSE_MS
