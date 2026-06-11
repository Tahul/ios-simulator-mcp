import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

const TROUBLESHOOTING_URL = 'https://github.com/Tahul/ios-simulator-mcp/blob/main/docs/TROUBLESHOOTING.md'

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

/** Builds a successful text tool result. */
export function textResult(text: string): CallToolResult {
  return {
    isError: false,
    content: [{ type: 'text', text }],
  }
}

/**
 * Builds an error tool result with an optional recovery hint and a
 * troubleshooting link appended. Hints tell the agent what to do next
 * so it can recover in one turn.
 */
export function errorResult(prefix: string, error: unknown, hint?: string): CallToolResult {
  const message = `${prefix}: ${toError(error).message}`
  const withHint = hint ? `${message}\n\nHint: ${hint}` : message
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: errorWithTroubleshooting(withHint),
      },
    ],
  }
}
