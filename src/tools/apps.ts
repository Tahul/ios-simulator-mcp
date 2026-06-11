import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { isToolFiltered, udidSchema } from '../lib/constants'
import { getBootedDeviceId } from '../lib/devices'
import { errorResult, textResult } from '../lib/errors'
import { run } from '../lib/run'

export interface LaunchArgsInput {
  udid: string
  bundleId: string
  terminateRunning?: boolean
  env?: Record<string, string>
}

export interface LaunchArgsOutput {
  args: string[]
  env: Record<string, string>
}

/**
 * Builds the `simctl launch` argument list and the SIMCTL_CHILD_-prefixed
 * environment that simctl forwards to the launched app.
 */
export function buildLaunchArgs({ udid, bundleId, terminateRunning, env }: LaunchArgsInput): LaunchArgsOutput {
  const args: string[] = ['launch']

  if (terminateRunning)
    args.push('--terminate-running-process')

  const simctlEnv: Record<string, string> = {}

  if (env) {
    const entries = Object.entries(env)
      .map(([key, value]) => [key.trim(), value] as const)
      .sort(([a], [b]) => a.localeCompare(b))

    for (const [key, value] of entries) {
      if (!key)
        throw new Error('Environment variable keys must be non-empty.')
      simctlEnv[`SIMCTL_CHILD_${key}`] = value
    }
  }

  args.push(udid, bundleId)
  return { args, env: simctlEnv }
}

export async function installAppHandler({ udid, app_path }: { udid?: string, app_path: string }): Promise<CallToolResult> {
  try {
    const actualUdid = await getBootedDeviceId(udid)
    const absolutePath = path.isAbsolute(app_path)
      ? app_path
      : path.resolve(app_path)

    if (!fs.existsSync(absolutePath))
      throw new Error(`App bundle not found at: ${absolutePath}`)

    await run('xcrun', ['simctl', 'install', actualUdid, absolutePath])

    return textResult(`App installed successfully from: ${absolutePath}`)
  }
  catch (error) {
    return errorResult('Error installing app', error)
  }
}

export interface LaunchAppParams {
  udid?: string
  bundle_id: string
  terminate_running?: boolean
  env?: Record<string, string>
}

export async function launchAppHandler({ udid, bundle_id, terminate_running, env }: LaunchAppParams): Promise<CallToolResult> {
  try {
    const actualUdid = await getBootedDeviceId(udid)

    const { args, env: simctlEnv } = buildLaunchArgs({
      udid: actualUdid,
      bundleId: bundle_id,
      terminateRunning: terminate_running,
      env,
    })

    const { stdout } = await run('xcrun', ['simctl', ...args], {
      env: simctlEnv,
    })

    // simctl launch outputs the PID as the first token in stdout
    const pidMatch = stdout.match(/^(\d+)/)
    const pid = pidMatch ? pidMatch[1] : null

    return textResult(
      pid
        ? `App ${bundle_id} launched successfully with PID: ${pid}`
        : `App ${bundle_id} launched successfully`,
    )
  }
  catch (error) {
    return errorResult('Error launching app', error)
  }
}

export function registerAppTools(server: McpServer): void {
  if (!isToolFiltered('install_app')) {
    server.tool(
      'install_app',
      'Installs an app bundle (.app or .ipa) on the iOS Simulator',
      {
        udid: udidSchema,
        app_path: z
          .string()
          .max(1024)
          .describe('Path to the app bundle (.app directory or .ipa file) to install'),
      },
      { title: 'Install App', readOnlyHint: false, openWorldHint: true },
      installAppHandler,
    )
  }

  if (!isToolFiltered('launch_app')) {
    server.tool(
      'launch_app',
      'Launches an app on the iOS Simulator by bundle identifier',
      {
        udid: udidSchema,
        bundle_id: z
          .string()
          .max(256)
          .describe('Bundle identifier of the app to launch (e.g., com.apple.mobilesafari)'),
        terminate_running: z
          .boolean()
          .optional()
          .describe('Terminate the app if it is already running before launching'),
        env: z
          .record(z.string())
          .optional()
          .describe('Environment variables to pass to simctl launch'),
      },
      { title: 'Launch App', readOnlyHint: false, openWorldHint: true },
      launchAppHandler,
    )
  }
}
