import { describe, expect, it } from 'bun:test'
import {
  constructDeepLink,
  normalizeMetroUrl,
  resolveDeepLink,
  waitForMetro,
  withDisableOnboarding,
} from '../src/lib/metro'

describe('normalizeMetroUrl', () => {
  it('adds http:// when missing and strips trailing slashes', () => {
    expect(normalizeMetroUrl('localhost:8081')).toBe('http://localhost:8081')
    expect(normalizeMetroUrl('http://localhost:8081/')).toBe('http://localhost:8081')
    expect(normalizeMetroUrl('https://tunnel.exp.direct/')).toBe('https://tunnel.exp.direct')
  })
})

describe('constructDeepLink', () => {
  it('builds an Expo Go exp:// link from the host', () => {
    const link = constructDeepLink({ metroUrl: 'http://192.168.1.5:8081', runtime: 'expo' })
    expect(link).toEqual({ url: 'exp://192.168.1.5:8081', runtime: 'expo', source: 'constructed-expo' })
  })

  it('builds a dev-client link with an encoded url and the scheme', () => {
    const link = constructDeepLink({ metroUrl: 'http://192.168.1.5:8081', runtime: 'custom', scheme: 'exp+spotter' })
    expect(link.runtime).toBe('custom')
    expect(link.url).toBe('exp+spotter://expo-development-client/?url=http%3A%2F%2F192.168.1.5%3A8081')
  })

  it('throws for a dev-client link without a scheme', () => {
    expect(() => constructDeepLink({ metroUrl: 'http://localhost:8081', runtime: 'custom' }))
      .toThrow(/without a scheme/)
  })
})

describe('withDisableOnboarding', () => {
  it('adds disableOnboarding=1 to dev-client links', () => {
    const link = constructDeepLink({ metroUrl: 'http://localhost:8081', runtime: 'custom', scheme: 'exp+app' })
    expect(withDisableOnboarding(link)).toContain('disableOnboarding=1')
  })

  it('leaves Expo Go links untouched', () => {
    const link = constructDeepLink({ metroUrl: 'http://localhost:8081', runtime: 'expo' })
    expect(withDisableOnboarding(link)).toBe(link.url)
  })

  it('does not duplicate the flag', () => {
    const link = constructDeepLink({ metroUrl: 'http://localhost:8081', runtime: 'custom', scheme: 'exp+app' })
    const once = withDisableOnboarding(link)
    const twice = withDisableOnboarding({ ...link, url: once })
    expect(twice).toBe(once)
  })
})

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as unknown as Response
}

describe('resolveDeepLink', () => {
  it('prefers the Metro /_expo/open endpoint', async () => {
    const fetchImpl = (async (url: string) => {
      expect(url).toBe('http://localhost:8081/_expo/open?platform=ios')
      return jsonResponse({ url: 'exp+spotter://expo-development-client/?url=enc', runtime: 'custom' })
    }) as unknown as typeof fetch

    const link = await resolveDeepLink({ metroUrl: 'http://localhost:8081', fetchImpl })

    expect(link.source).toBe('metro-open-endpoint')
    expect(link.runtime).toBe('custom')
    expect(link.url).toContain('expo-development-client')
  })

  it('forwards the runtime override as a query param', async () => {
    let calledUrl = ''
    const fetchImpl = (async (url: string) => {
      calledUrl = url
      return jsonResponse({ url: 'exp://localhost:8081', runtime: 'expo' })
    }) as unknown as typeof fetch

    await resolveDeepLink({ metroUrl: 'http://localhost:8081', runtime: 'expo', fetchImpl })

    expect(calledUrl).toContain('runtime=expo')
  })

  it('falls back to construction when the endpoint fails', async () => {
    const fetchImpl = (async () => {
      throw new Error('connection refused')
    }) as unknown as typeof fetch

    const link = await resolveDeepLink({
      metroUrl: 'http://192.168.1.5:8081',
      runtime: 'custom',
      scheme: 'exp+spotter',
      fetchImpl,
    })

    expect(link.source).toBe('constructed-custom')
    expect(link.url).toContain('exp+spotter://expo-development-client')
  })

  it('falls back to Expo Go construction on a non-ok response', async () => {
    const fetchImpl = (async () => jsonResponse({}, false)) as unknown as typeof fetch

    const link = await resolveDeepLink({ metroUrl: 'http://localhost:8081', fetchImpl })

    expect(link.source).toBe('constructed-expo')
    expect(link.url).toBe('exp://localhost:8081')
  })
})

describe('waitForMetro', () => {
  it('resolves once the dev server responds', async () => {
    let calls = 0
    const fetchImpl = (async () => {
      calls += 1
      if (calls < 2)
        throw new Error('not up yet')
      return { ok: true } as Response
    }) as unknown as typeof fetch

    await waitForMetro('http://localhost:8081', { timeoutMs: 2000, intervalMs: 10, fetchImpl })

    expect(calls).toBeGreaterThanOrEqual(2)
  })

  it('throws a helpful error on timeout', async () => {
    const fetchImpl = (async () => {
      throw new Error('refused')
    }) as unknown as typeof fetch

    await expect(
      waitForMetro('http://localhost:8081', { timeoutMs: 30, intervalMs: 10, fetchImpl }),
    ).rejects.toThrow(/not responding.*expo start/)
  })
})
