import { describe, it, expect } from 'vitest'
import { avatarColorClass, contactInitials } from './avatar'

describe('avatarColorClass', () => {
  it('is stable for the same key', () => {
    const a = avatarColorClass('c1b2a3d4-0000-0000-0000-000000000001')
    const b = avatarColorClass('c1b2a3d4-0000-0000-0000-000000000001')
    expect(a).toBe(b)
  })

  it('spreads different keys across the palette', () => {
    const keys = Array.from({ length: 60 }, (_, i) => `contact-${i}`)
    const distinct = new Set(keys.map(avatarColorClass))
    // Not a distribution proof — just a guard against a hash that
    // collapses everything onto one or two colours.
    expect(distinct.size).toBeGreaterThan(5)
  })

  it('falls back to a real colour for a missing key', () => {
    expect(avatarColorClass(null)).toMatch(/^bg-/)
    expect(avatarColorClass(undefined)).toMatch(/^bg-/)
    expect(avatarColorClass('')).toMatch(/^bg-/)
  })
})

describe('contactInitials', () => {
  it('takes two initials from a full name', () => {
    expect(contactInitials('Michael Sosa')).toBe('MS')
    expect(contactInitials('  maria   perez  ')).toBe('MP')
  })

  it('takes one initial from a single-word name', () => {
    expect(contactInitials('Michael')).toBe('M')
  })

  it('ignores emoji and punctuation', () => {
    expect(contactInitials('Michael 🔧')).toBe('M')
    expect(contactInitials('🔧 Michael Sosa')).toBe('MS')
  })

  it('uses the LAST two digits for a phone-only contact', () => {
    // The first two would be the country code — identical for every
    // local contact, so useless for telling them apart.
    expect(contactInitials('18292585106')).toBe('06')
    expect(contactInitials('+1 (829) 258-5106')).toBe('06')
  })

  it('falls back to # when there is nothing usable', () => {
    expect(contactInitials('')).toBe('#')
    expect(contactInitials('   ')).toBe('#')
    expect(contactInitials('🔧')).toBe('#')
    expect(contactInitials(null)).toBe('#')
    expect(contactInitials(undefined)).toBe('#')
  })
})
