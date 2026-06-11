import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { isToolFiltered, udidSchema } from '../lib/constants'
import { getBootedDeviceId } from '../lib/devices'
import { errorResult, textResult } from '../lib/errors'
import { run } from '../lib/run'

const bundleIdSchema = z
  .string()
  .max(256)
  .describe('Bundle identifier of the app (e.g., com.apple.mobilesafari). Use list_apps to discover installed bundle ids instead of guessing.')

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
 *
 * Rejects EX_UPDATES_* variables: overriding them sends expo-updates into a
 * reload loop against Metro. Dev-client builds connect to Metro on their own.
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
      if (/^EX_UPDATES_/i.test(key)) {
        throw new Error(
          `Refusing to set "${key}": EX_UPDATES_* environment variables cause an expo-updates reload loop against Metro. `
          + 'Expo dev-client builds connect to Metro automatically — launch with bundle_id (+ terminate_running) only, '
          + 'or use open_url with an exp:// or dev-client URL to target a specific Metro instance.',
        )
      }
      simctlEnv[`SIMCTL_CHILD_${key}`] = value
    }
  }

  args.push(udid, bundleId)
  return { args, env: simctlEnv }
}

export interface InstalledApp {
  bundleId: string
  name: string | null
  type: string | null
}

function plistValue(line: string): string | null {
  const idx = line.indexOf('=')
  if (idx === -1)
    return null
  const value = line
    .slice(idx + 1)
    .trim()
    .replace(/;$/, '')
    .replace(/^"(.*)"$/, '$1')
  return value || null
}

/**
 * Parses `simctl listapps` NextStep-plist output into a flat app list.
 * Only top-level bundle blocks (indented 4 spaces) open a new entry.
 */
export function parseListApps(output: string): InstalledApp[] {
  const apps: InstalledApp[] = []
  let current: InstalledApp | null = null

  for (const line of output.split('\n')) {
    const blockStart = line.match(/^ {4}"?([\w.-]+)"?\s+=\s+\{/)
    if (blockStart) {
      current = { bundleId: blockStart[1] ?? '', name: null, type: null }
      apps.push(current)
      continue
    }
    if (!current)
      continue

    const trimmed = line.trim()
    if (!current.name && (trimmed.startsWith('CFBundleDisplayName =') || trimmed.startsWith('CFBundleName =')))
      current.name = plistValue(trimmed)
    else if (trimmed.startsWith('ApplicationType ='))
      current.type = plistValue(trimmed)
  }

  return apps
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
    return errorResult(
      'Error launching app',
      error,
      'If the app is not installed, call list_apps to see installed bundle identifiers, or install_app first.',
    )
  }
}

export async function terminateAppHandler({ udid, bundle_id }: { udid?: string, bundle_id: string }): Promise<CallToolResult> {
  try {
    const actualUdid = await getBootedDeviceId(udid)
    await run('xcrun', ['simctl', 'terminate', actualUdid, bundle_id])
    return textResult(`App ${bundle_id} terminated`)
  }
  catch (error) {
    return errorResult(
      'Error terminating app',
      error,
      'The app may not be running. Call list_apps to verify the bundle identifier.',
    )
  }
}

export async function uninstallAppHandler({ udid, bundle_id }: { udid?: string, bundle_id: string }): Promise<CallToolResult> {
  try {
    const actualUdid = await getBootedDeviceId(udid)
    await run('xcrun', ['simctl', 'uninstall', actualUdid, bundle_id])
    return textResult(`App ${bundle_id} uninstalled`)
  }
  catch (error) {
    return errorResult('Error uninstalling app', error)
  }
}

export async function listAppsHandler({ udid }: { udid?: string }): Promise<CallToolResult> {
  try {
    const actualUdid = await getBootedDeviceId(udid)
    const { stdout } = await run('xcrun', ['simctl', 'listapps', actualUdid])

    const apps = parseListApps(stdout)
    if (apps.length === 0)
      return textResult('No apps found on the simulator.')

    const lines = apps.map(app =>
      `${app.bundleId}${app.name ? ` — ${app.name}` : ''}${app.type ? ` (${app.type})` : ''}`,
    )
    return textResult(lines.join('\n'))
  }
  catch (error) {
    return errorResult('Error listing apps', error)
  }
}

export function registerAppTools(server: McpServer): void {
  if (!isToolFiltered('install_app')) {
    server.tool(
      'install_app',
      'Installs an app bundle (.app directory or .ipa file) on the iOS Simulator. '
      + 'Reinstalling over an existing app keeps its data. After installing, use launch_app with the app\'s bundle identifier.',
      {
        udid: udidSchema,
        app_path: z
          .string()
          .max(1024)
          .describe('Path to the app bundle (.app directory or .ipa file) to install'),
      },
      { title: 'Install App', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      installAppHandler,
    )
  }

  if (!isToolFiltered('launch_app')) {
    server.tool(
      'launch_app',
      'Launches an app on the iOS Simulator by bundle identifier and returns its PID. '
      + 'If the app is already running, pass terminate_running to restart it. '
      + 'Expo/React Native: dev-client builds connect to Metro automatically — do NOT pass EX_UPDATES_* env vars (rejected); '
      + 'to target a specific Metro instance, use open_url with an exp:// or dev-client URL instead. '
      + 'Use app_logs afterwards to check for startup errors.',
      {
        udid: udidSchema,
        bundle_id: bundleIdSchema,
        terminate_running: z
          .boolean()
          .optional()
          .describe('Terminate the app if it is already running before launching'),
        env: z
          .record(z.string())
          .optional()
          .describe('Environment variables forwarded to the app (SIMCTL_CHILD_ prefixing is handled for you). EX_UPDATES_* keys are rejected.'),
      },
      { title: 'Launch App', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      launchAppHandler,
    )
  }

  if (!isToolFiltered('terminate_app')) {
    server.tool(
      'terminate_app',
      'Terminates a running app on the iOS Simulator by bundle identifier. Unsaved in-app state is lost. '
      + 'No-op error if the app is not running.',
      {
        udid: udidSchema,
        bundle_id: bundleIdSchema,
      },
      { title: 'Terminate App', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
      terminateAppHandler,
    )
  }

  if (!isToolFiltered('uninstall_app')) {
    server.tool(
      'uninstall_app',
      'Uninstalls an app from the iOS Simulator by bundle identifier, deleting the app and all of its data.',
      {
        udid: udidSchema,
        bundle_id: bundleIdSchema,
      },
      { title: 'Uninstall App', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
      uninstallAppHandler,
    )
  }

  if (!isToolFiltered('list_apps')) {
    server.tool(
      'list_apps',
      'Lists apps installed on the iOS Simulator with their bundle identifier, display name, and type (User/System). '
      + 'Use this to find the exact bundle_id for launch_app / terminate_app / app_logs instead of guessing.',
      { udid: udidSchema },
      { title: 'List Installed Apps', readOnlyHint: true, openWorldHint: true },
      listAppsHandler,
    )
  }
}
