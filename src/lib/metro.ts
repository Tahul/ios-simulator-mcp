/**
 * Talks to the Expo/Metro dev server to resolve the exact deep link the
 * CLI itself would open, rather than guessing the URL scheme. This is the
 * single biggest reliability lever for Expo launches.
 *
 * @see https://docs.expo.dev/more/expo-cli/#open-endpoint
 */

export interface OpenEndpointResponse {
  runtime?: 'expo' | 'custom' | 'web'
  url?: string
  scheme?: string | null
  availableRuntimes?: Array<'expo' | 'custom'>
}

export interface ResolvedDeepLink {
  url: string
  runtime: 'expo' | 'custom' | 'unknown'
  /** How the link was obtained, for diagnostics. */
  source: 'metro-open-endpoint' | 'constructed-custom' | 'constructed-expo'
}

export interface ResolveOptions {
  /** Base dev-server URL, e.g. http://localhost:8081 */
  metroUrl: string
  /** 'custom' forces the dev-build link, 'expo' forces Expo Go. */
  runtime?: 'default' | 'expo' | 'custom'
  /** Project scheme (exp+slug) used only for the construction fallback. */
  scheme?: string
  /** Fetch seam for tests. */
  fetchImpl?: typeof fetch
}

const DEFAULT_TIMEOUT_MS = 4000

function withTimeout(ms: number): { signal: AbortSignal, cancel: () => void } {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  return { signal: controller.signal, cancel: () => clearTimeout(timer) }
}

export function normalizeMetroUrl(input: string): string {
  let url = input.trim()
  if (!/^https?:\/\//i.test(url))
    url = `http://${url}`
  return url.replace(/\/+$/, '')
}

/**
 * Polls the dev server root until it responds (any HTTP status counts as
 * "up"). Returns when ready; throws on timeout.
 */
export async function waitForMetro(
  metroUrl: string,
  { timeoutMs = 15000, intervalMs = 500, fetchImpl = fetch }: { timeoutMs?: number, intervalMs?: number, fetchImpl?: typeof fetch } = {},
): Promise<void> {
  const base = normalizeMetroUrl(metroUrl)
  const statusUrl = `${base}/status`
  const start = Date.now()

  while (true) {
    const probe = withTimeout(Math.min(intervalMs * 2, DEFAULT_TIMEOUT_MS))
    try {
      // Expo dev server answers /status with "packager-status:running".
      await fetchImpl(statusUrl, { signal: probe.signal })
      probe.cancel()
      return
    }
    catch {
      probe.cancel()
      if (Date.now() - start >= timeoutMs)
        throw new Error(`Metro dev server at ${base} is not responding after ${Math.round(timeoutMs / 1000)}s. Start it with \`npx expo start\` (optionally --dev-client).`)
      await new Promise(resolve => setTimeout(resolve, intervalMs))
    }
  }
}

/**
 * Resolves the deep link to open. Tries Metro's /_expo/open endpoint first
 * (authoritative), then falls back to constructing the link from the scheme
 * and Metro host.
 */
export async function resolveDeepLink({
  metroUrl,
  runtime = 'default',
  scheme,
  fetchImpl = fetch,
}: ResolveOptions): Promise<ResolvedDeepLink> {
  const base = normalizeMetroUrl(metroUrl)

  const params = new URLSearchParams({ platform: 'ios' })
  if (runtime !== 'default')
    params.set('runtime', runtime)

  const openUrl = `${base}/_expo/open?${params.toString()}`
  const probe = withTimeout(DEFAULT_TIMEOUT_MS)
  try {
    const res = await fetchImpl(openUrl, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: probe.signal,
    })
    probe.cancel()
    if (res.ok) {
      const data = (await res.json()) as OpenEndpointResponse
      if (data.url) {
        const runtime = data.runtime === 'expo' || data.runtime === 'custom' ? data.runtime : 'unknown'
        return {
          url: data.url,
          runtime,
          source: 'metro-open-endpoint',
        }
      }
    }
  }
  catch {
    probe.cancel()
    // fall through to construction
  }

  return constructDeepLink({ metroUrl: base, runtime, scheme })
}

/**
 * Builds a deep link without contacting Metro. Used as a fallback when the
 * /_expo/open endpoint is unavailable (older Expo, restricted network).
 */
export function constructDeepLink({
  metroUrl,
  runtime = 'default',
  scheme,
}: {
  metroUrl: string
  runtime?: 'default' | 'expo' | 'custom'
  scheme?: string
}): ResolvedDeepLink {
  const base = normalizeMetroUrl(metroUrl)

  // Dev client: {scheme}://expo-development-client/?url={encoded http metro url}
  if (runtime === 'custom') {
    if (!scheme) {
      throw new Error(
        'Cannot construct a dev-client deep link without a scheme. Provide `scheme` (e.g. exp+your-slug), '
        + 'or start Metro so /_expo/open can resolve it automatically.',
      )
    }
    const cleanScheme = scheme.replace(/:.*$/, '')
    return {
      url: `${cleanScheme}://expo-development-client/?url=${encodeURIComponent(base)}`,
      runtime: 'custom',
      source: 'constructed-custom',
    }
  }

  // Expo Go: exp:// pointing at the Metro host.
  const expUrl = base.replace(/^https?:\/\//i, 'exp://')
  return {
    url: expUrl,
    runtime: 'expo',
    source: 'constructed-expo',
  }
}

/** Appends disableOnboarding=1 to a dev-client link (skips first-launch screen). */
export function withDisableOnboarding(link: ResolvedDeepLink): string {
  if (link.runtime !== 'custom')
    return link.url
  const sep = link.url.includes('?') ? '&' : '?'
  if (/[?&]disableOnboarding=/.test(link.url))
    return link.url
  return `${link.url}${sep}disableOnboarding=1`
}
