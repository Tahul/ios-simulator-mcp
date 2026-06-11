import type { UiElement } from '../src/tools/find-element'
import { describe, expect, it } from 'bun:test'
import { findElements, matchesSearch } from '../src/tools/find-element'

describe('matchesSearch', () => {
  it('matches substrings case-insensitively by default', () => {
    expect(matchesSearch('Submit Button', 'submit', 'substring', false)).toBe(true)
    expect(matchesSearch('Submit Button', 'SUBMIT', 'substring', false)).toBe(true)
  })

  it('respects case sensitivity', () => {
    expect(matchesSearch('Submit Button', 'submit', 'substring', true)).toBe(false)
    expect(matchesSearch('Submit Button', 'Submit', 'substring', true)).toBe(true)
  })

  it('supports exact mode', () => {
    expect(matchesSearch('Submit', 'Submit', 'exact', true)).toBe(true)
    expect(matchesSearch('Submit Button', 'Submit', 'exact', true)).toBe(false)
  })

  it('never matches null values', () => {
    expect(matchesSearch(null, 'anything', 'substring', false)).toBe(false)
  })
})

const TREE: UiElement[] = [
  {
    AXLabel: 'Root',
    type: 'Group',
    children: [
      { AXLabel: 'Login', AXUniqueId: 'login-button', type: 'Button' },
      {
        AXLabel: 'Form',
        type: 'Group',
        children: [
          { AXLabel: null, AXUniqueId: 'username-field', type: 'TextField' },
          { AXLabel: 'Login', type: 'StaticText' },
        ],
      },
    ],
  },
]

describe('findElements', () => {
  it('finds nested elements by label', () => {
    const results = findElements(TREE, {
      search: ['login'],
      matchMode: 'substring',
      caseSensitive: false,
    })
    expect(results).toHaveLength(2)
  })

  it('filters by type (case-insensitive exact)', () => {
    const results = findElements(TREE, {
      search: ['login'],
      type: 'button',
      matchMode: 'substring',
      caseSensitive: false,
    })
    expect(results).toHaveLength(1)
    expect(results[0]?.AXUniqueId).toBe('login-button')
  })

  it('matches against AXUniqueId when AXLabel is null', () => {
    const results = findElements(TREE, {
      search: ['username'],
      matchMode: 'substring',
      caseSensitive: false,
    })
    expect(results).toHaveLength(1)
    expect(results[0]?.type).toBe('TextField')
  })

  it('matches if ANY search string matches', () => {
    const results = findElements(TREE, {
      search: ['nonexistent', 'root'],
      matchMode: 'substring',
      caseSensitive: false,
    })
    expect(results).toHaveLength(1)
    expect(results[0]?.AXLabel).toBe('Root')
  })

  it('returns empty array when nothing matches', () => {
    const results = findElements(TREE, {
      search: ['nope'],
      matchMode: 'exact',
      caseSensitive: false,
    })
    expect(results).toHaveLength(0)
  })
})
