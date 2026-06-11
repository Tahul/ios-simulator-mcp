import { describe, expect, it } from 'bun:test'
import { parseBootedDevice } from '../src/lib/devices'

const FIXTURE = JSON.stringify({
  devices: {
    'com.apple.CoreSimulator.SimRuntime.iOS-17-5': [
      {
        udid: '11111111-2222-3333-4444-555555555555',
        name: 'iPhone 15',
        state: 'Shutdown',
        isAvailable: true,
      },
      {
        udid: '37A360EC-75F9-4AEC-8EFA-10F4A58D8CCA',
        name: 'iPad Pro (12.9-inch) (6th generation)',
        state: 'Booted',
        isAvailable: true,
      },
    ],
    'com.apple.CoreSimulator.SimRuntime.iOS-16-4': [],
  },
})

describe('parseBootedDevice', () => {
  it('returns the booted device with full name, including parentheses', () => {
    const device = parseBootedDevice(FIXTURE)
    expect(device.id).toBe('37A360EC-75F9-4AEC-8EFA-10F4A58D8CCA')
    expect(device.name).toBe('iPad Pro (12.9-inch) (6th generation)')
  })

  it('throws when no device is booted, listing available devices', () => {
    const noneBooted = JSON.stringify({
      devices: {
        runtime: [{ udid: 'A', name: 'iPhone 15', state: 'Shutdown', isAvailable: true }],
      },
    })
    expect(() => parseBootedDevice(noneBooted)).toThrow(/No booted simulator found.*iPhone 15 \(A\)/)
  })

  it('throws when devices map is empty', () => {
    expect(() => parseBootedDevice('{"devices":{}}')).toThrow('No booted simulator found')
  })

  it('throws on invalid JSON', () => {
    expect(() => parseBootedDevice('not json')).toThrow('invalid JSON')
  })
})
