import type { AxNode } from '../../src/lib/ax'
import type { WsSession } from '../../src/lib/baguette'
import { setWsSessionFactory } from '../../src/lib/baguette'

export interface SentEnvelope {
  type: string
  [k: string]: unknown
}

export interface MockSession extends WsSession {
  sent: SentEnvelope[]
}

/**
 * Builds a fake WsSession. `treeFor` supplies the AXNode returned by
 * describe_ui (optionally varying by call index). Gestures are recorded in
 * `sent`. snapshot/force_idr etc. are accepted as no-op replies.
 */
export function makeMockSession(treeFor: (callIndex: number) => AxNode | null): MockSession {
  const sent: SentEnvelope[] = []
  let describeCalls = 0

  const session: MockSession = {
    sent,
    send(envelope) {
      sent.push(envelope as SentEnvelope)
    },
    request(envelope, replyType) {
      sent.push(envelope as SentEnvelope)
      if (replyType === 'describe_ui_result') {
        const tree = treeFor(describeCalls)
        describeCalls += 1
        if (tree == null)
          return Promise.resolve({ type: replyType, ok: false, error: 'no accessibility data' })
        return Promise.resolve({ type: replyType, ok: true, tree: tree as unknown as Record<string, unknown> })
      }
      return Promise.resolve({ type: replyType, ok: true })
    },
    close() {},
  }
  return session
}

/** Installs a WS session factory that always returns the given session. */
export function installMockSession(session: WsSession): void {
  setWsSessionFactory(() => Promise.resolve(session))
}

/** Builds a simple AX tree (application root + labeled children). */
export function axTree(children: Array<Partial<AxNode> & { label?: string }>): AxNode {
  return {
    role: 'AXApplication',
    label: 'App',
    frame: { x: 0, y: 0, width: 400, height: 872 },
    children: children.map(c => ({
      role: c.role ?? 'AXStaticText',
      label: c.label ?? null,
      value: c.value ?? null,
      identifier: c.identifier ?? null,
      frame: c.frame ?? { x: 0, y: 0, width: 100, height: 40 },
      children: c.children ?? [],
    })),
  }
}
