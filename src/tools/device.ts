import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { isToolFiltered, udidSchema } from '../lib/constants'
import { getBootedDeviceId } from '../lib/devices'
import { errorResult, textResult } from '../lib/errors'
import { getTmpRoot } from '../lib/paths'
import { run } from '../lib/run'

const PRIVACY_SERVICES = [
  'all',
  'calendar',
  'camera',
  'contacts-limited',
  'contacts',
  'location',
  'location-always',
  'media-library',
  'microphone',
  'motion',
  'photos-add',
  'photos',
  'reminders',
  'siri',
] as const

export async function openUrlHandler({ udid, url }: { udid?: string, url: string }): Promise<CallToolResult> {
  try {
    const actualUdid = await getBootedDeviceId(udid)
    await run('xcrun', ['simctl', 'openurl', actualUdid, '--', url])
    return textResult(`Opened URL: ${url}`)
  }
  catch (error) {
    return errorResult(
      'Error opening URL',
      error,
      'Ensure an app handles this URL scheme. For Expo dev clients, use the exp+<slug>:// or exp:// URL printed by Metro.',
    )
  }
}

export interface SetPermissionsParams {
  udid?: string
  action: 'grant' | 'revoke' | 'reset'
  service: (typeof PRIVACY_SERVICES)[number]
  bundle_id?: string
}

export async function setPermissionsHandler({ udid, action, service, bundle_id }: SetPermissionsParams): Promise<CallToolResult> {
  try {
    const actualUdid = await getBootedDeviceId(udid)
    await run('xcrun', [
      'simctl',
      'privacy',
      actualUdid,
      action,
      service,
      ...(bundle_id ? [bundle_id] : []),
    ])
    return textResult(`Permission "${service}" ${action}${action === 'reset' ? '' : 'ed'}${bundle_id ? ` for ${bundle_id}` : ''}`)
  }
  catch (error) {
    return errorResult('Error setting permissions', error)
  }
}

export interface PushNotificationParams {
  udid?: string
  bundle_id: string
  payload: Record<string, unknown>
}

export async function pushNotificationHandler({ udid, bundle_id, payload }: PushNotificationParams): Promise<CallToolResult> {
  try {
    const actualUdid = await getBootedDeviceId(udid)

    if (!('aps' in payload))
      throw new Error('Payload must contain an "aps" key (e.g. { "aps": { "alert": "Hello" } })')

    const payloadFile = path.join(getTmpRoot(), `push-${Date.now()}.json`)
    fs.writeFileSync(payloadFile, JSON.stringify(payload))
    try {
      await run('xcrun', ['simctl', 'push', actualUdid, bundle_id, payloadFile])
    }
    finally {
      try {
        fs.unlinkSync(payloadFile)
      }
      catch {
        // ignore cleanup errors
      }
    }

    return textResult(`Push notification delivered to ${bundle_id}`)
  }
  catch (error) {
    return errorResult(
      'Error sending push notification',
      error,
      'The app must be installed and have notification permission (see set_permissions).',
    )
  }
}

export async function setLocationHandler({ udid, latitude, longitude }: { udid?: string, latitude: number, longitude: number }): Promise<CallToolResult> {
  try {
    const actualUdid = await getBootedDeviceId(udid)
    await run('xcrun', ['simctl', 'location', actualUdid, 'set', `${latitude},${longitude}`])
    return textResult(`Simulated location set to (${latitude}, ${longitude})`)
  }
  catch (error) {
    return errorResult('Error setting location', error)
  }
}

export async function setAppearanceHandler({ udid, appearance }: { udid?: string, appearance: 'light' | 'dark' }): Promise<CallToolResult> {
  try {
    const actualUdid = await getBootedDeviceId(udid)
    await run('xcrun', ['simctl', 'ui', actualUdid, 'appearance', appearance])
    return textResult(`Appearance set to ${appearance}`)
  }
  catch (error) {
    return errorResult('Error setting appearance', error)
  }
}

export interface StatusBarParams {
  udid?: string
  action: 'override' | 'clear'
  time?: string
  battery_level?: number
  battery_state?: 'charged' | 'charging' | 'discharging'
  cellular_bars?: number
  wifi_bars?: number
  operator_name?: string
}

export async function statusBarHandler({ udid, action, time, battery_level, battery_state, cellular_bars, wifi_bars, operator_name }: StatusBarParams): Promise<CallToolResult> {
  try {
    const actualUdid = await getBootedDeviceId(udid)

    if (action === 'clear') {
      await run('xcrun', ['simctl', 'status_bar', actualUdid, 'clear'])
      return textResult('Status bar overrides cleared')
    }

    const overrides = [
      ...(time != null ? ['--time', time] : []),
      ...(battery_level != null ? ['--batteryLevel', String(battery_level)] : []),
      ...(battery_state != null ? ['--batteryState', battery_state] : []),
      ...(cellular_bars != null ? ['--cellularBars', String(cellular_bars)] : []),
      ...(wifi_bars != null ? ['--wifiBars', String(wifi_bars)] : []),
      ...(operator_name != null ? ['--operatorName', operator_name] : []),
    ]

    if (overrides.length === 0)
      throw new Error('Provide at least one override (time, battery_level, battery_state, cellular_bars, wifi_bars, operator_name)')

    await run('xcrun', ['simctl', 'status_bar', actualUdid, 'override', ...overrides])
    return textResult('Status bar overridden')
  }
  catch (error) {
    return errorResult('Error overriding status bar', error)
  }
}

export function registerDeviceTools(server: McpServer): void {
  if (!isToolFiltered('open_url')) {
    server.tool(
      'open_url',
      'Opens a URL on the iOS Simulator: https:// links, custom URL schemes, and deep links. '
      + 'For Expo: this is the correct way to point a dev-client build at a specific Metro instance — open the '
      + 'exp:// or dev-client URL that Metro prints (never via launch env vars).',
      {
        udid: udidSchema,
        url: z.string().min(1).max(2048).describe('URL to open (e.g. https://example.com, exp://192.168.1.10:8081, myapp://path)'),
      },
      { title: 'Open URL', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      openUrlHandler,
    )
  }

  if (!isToolFiltered('set_permissions')) {
    server.tool(
      'set_permissions',
      'Grants, revokes, or resets a privacy permission (camera, microphone, location, photos, contacts, calendar, '
      + 'reminders, motion, media-library, siri) for an app. Pre-grant permissions before automation runs so system '
      + 'permission dialogs never block the flow. Note: this does not cover the notifications prompt.',
      {
        udid: udidSchema,
        action: z.enum(['grant', 'revoke', 'reset']).describe('What to do with the permission'),
        service: z.enum(PRIVACY_SERVICES).describe('The privacy service to modify'),
        bundle_id: z
          .string()
          .max(256)
          .optional()
          .describe('Target app bundle identifier. Omit (only valid with action=reset) to affect all apps'),
      },
      { title: 'Set Permissions', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      setPermissionsHandler,
    )
  }

  if (!isToolFiltered('push_notification')) {
    server.tool(
      'push_notification',
      'Delivers a simulated APNs push notification to an app. The payload must contain an "aps" dictionary '
      + '(e.g. { "aps": { "alert": { "title": "Hi", "body": "There" } } }).',
      {
        udid: udidSchema,
        bundle_id: z.string().max(256).describe('Bundle identifier of the target app'),
        payload: z
          .record(z.unknown())
          .describe('APNs payload object; must include an "aps" key'),
      },
      { title: 'Push Notification', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      pushNotificationHandler,
    )
  }

  if (!isToolFiltered('set_location')) {
    server.tool(
      'set_location',
      'Sets the simulated GPS location of the device. Apps using CoreLocation will receive the new coordinates.',
      {
        udid: udidSchema,
        latitude: z.number().min(-90).max(90).describe('Latitude in decimal degrees'),
        longitude: z.number().min(-180).max(180).describe('Longitude in decimal degrees'),
      },
      { title: 'Set Location', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      setLocationHandler,
    )
  }

  if (!isToolFiltered('set_appearance')) {
    server.tool(
      'set_appearance',
      'Switches the simulator between light and dark appearance. Useful for verifying both themes in screenshots.',
      {
        udid: udidSchema,
        appearance: z.enum(['light', 'dark']).describe('The interface style to apply'),
      },
      { title: 'Set Appearance', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      setAppearanceHandler,
    )
  }

  if (!isToolFiltered('status_bar')) {
    server.tool(
      'status_bar',
      'Overrides the simulator status bar (time, battery, signal, carrier) for clean screenshots — e.g. the classic '
      + '9:41 with full battery — or clears previous overrides.',
      {
        udid: udidSchema,
        action: z.enum(['override', 'clear']).describe('Apply overrides or clear all of them'),
        time: z.string().max(64).optional().describe('Time string to display (e.g. "9:41")'),
        battery_level: z.number().int().min(0).max(100).optional().describe('Battery level percentage'),
        battery_state: z.enum(['charged', 'charging', 'discharging']).optional().describe('Battery state'),
        cellular_bars: z.number().int().min(0).max(4).optional().describe('Cellular signal bars (0-4)'),
        wifi_bars: z.number().int().min(0).max(3).optional().describe('Wi-Fi signal bars (0-3)'),
        operator_name: z.string().max(64).optional().describe('Carrier name to display'),
      },
      { title: 'Status Bar', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      statusBarHandler,
    )
  }
}
