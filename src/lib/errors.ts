import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

const TROUBLESHOOTING_URL = 'https://github.com/Tahul/ios-simulator-mcp/blob/main/docs/TROUBLESHOOTING.md'

/**
 * Machine-readable error codes so an agent can branch on a failure and
 * self-route in one turn instead of parsing prose.
 */
export type ErrorCode
  = | 'NO_BOOTED_SIM'
    | 'DEVICE_NOT_FOUND'
    | 'BAGUETTE_UNREACHABLE'
    | 'METRO_UNREACHABLE'
    | 'ELEMENT_NOT_FOUND'
    | 'STALE_REF'
    | 'APP_NOT_INSTALLED'
    | 'IDB_MISSING'
    | 'INVALID_ARGUMENT'
    | 'VERIFICATION_FAILED'
    | 'COMMAND_TIMEOUT'
    | 'UNKNOWN'

/** The recommended recovery tool/action for each error code. */
const RECOVERY: Partial<Record<ErrorCode, string>> = {
  NO_BOOTED_SIM: 'Call boot_sim (or expo_launch, which boots automatically).',
  DEVICE_NOT_FOUND: 'Call doctor or boot_sim to see available simulators.',
  BAGUETTE_UNREACHABLE: 'Start `baguette serve`, or set BAGUETTE_URL/BAGUETTE_TOKEN.',
  METRO_UNREACHABLE: 'Start Metro with `npx expo start`, or pass metro_url.',
  ELEMENT_NOT_FOUND: 'Call ui_snapshot to see the current screen.',
  STALE_REF: 'Call ui_snapshot again to refresh element refs.',
  APP_NOT_INSTALLED: 'Call list_apps to find the bundle id, or install_app first.',
  IDB_MISSING: 'Install idb — see the troubleshooting guide.',
  COMMAND_TIMEOUT: 'The simulator or idb may be wedged. Run doctor, or restart the simulator / `idb kill`.',
}

/** Error that carries a machine-readable code (and optional recovery hint). */
export class ToolError extends Error {
  code: ErrorCode
  recovery?: string

  constructor(message: string, code: ErrorCode = 'UNKNOWN', recovery?: string) {
    super(message)
    this.name = 'ToolError'
    this.code = code
    this.recovery = recovery ?? RECOVERY[code]
  }
}

export function toError(input: unknown): Error {
  if (input instanceof Error)
    return input

  if (
    typeof input === 'object'
    && input
    && 'message' in input
    && typeof input.message === 'string'
  ) {
    return new Error(input.message)
  }

  return new Error(JSON.stringify(input))
}

export function errorWithTroubleshooting(message: string): string {
  return `${message}\n\nFor help, see the [Troubleshooting Guide](${TROUBLESHOOTING_URL})`
}

/**
 * Infers an error code from a raw error message for errors thrown without a
 * ToolError wrapper (e.g. from idb/simctl). Keeps codes consistent without
 * having to wrap every throw site.
 */
export function inferErrorCode(message: string): ErrorCode {
  const m = message.toLowerCase()
  if (m.includes('no booted simulator'))
    return 'NO_BOOTED_SIM'
  if (m.includes('idb') && (m.includes('not found') || m.includes('enoent') || m.includes('command not found')))
    return 'IDB_MISSING'
  if (m.includes('unable to find') || m.includes('no devices') || m.includes('invalid device') || m.includes('not found in device set'))
    return 'DEVICE_NOT_FOUND'
  if (m.includes('baguette'))
    return 'BAGUETTE_UNREACHABLE'
  if (m.includes('not responding') || m.includes('metro') || m.includes('econnrefused'))
    return 'METRO_UNREACHABLE'
  if (m.includes('no on-screen element') || m.includes('did not appear'))
    return 'ELEMENT_NOT_FOUND'
  if (m.includes('stale ref') || m.includes('unknown or stale'))
    return 'STALE_REF'
  if (m.includes('not installed') || m.includes('no such application'))
    return 'APP_NOT_INSTALLED'
  return 'UNKNOWN'
}

/** Builds a successful text tool result, with optional structured content. */
export function textResult(text: string, structured?: Record<string, unknown>): CallToolResult {
  const result: CallToolResult = {
    isError: false,
    content: [{ type: 'text', text }],
  }
  if (structured)
    result.structuredContent = structured
  return result
}

/**
 * Builds an error tool result with a machine-readable code, a recovery hint,
 * and a troubleshooting link. The code/recovery are also exposed via
 * structuredContent so agents and hosts can branch without parsing prose.
 */
export function errorResult(prefix: string, error: unknown, hint?: string): CallToolResult {
  const err = toError(error)
  const code = error instanceof ToolError ? error.code : inferErrorCode(err.message)
  const recovery = (error instanceof ToolError ? error.recovery : undefined) ?? hint ?? RECOVERY[code]

  const message = `${prefix}: ${err.message}`
  const withHint = recovery ? `${message}\n\nHint: ${recovery}` : message

  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: errorWithTroubleshooting(`[${code}] ${withHint}`),
      },
    ],
    structuredContent: {
      error: { code, message: err.message, recovery: recovery ?? null },
    },
  }
}
