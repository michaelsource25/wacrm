// ============================================================
// Contact avatar fallback: deterministic colour + initials.
//
// WhatsApp's Cloud API never gives us a customer's profile photo (Meta
// doesn't expose it), so most contacts will never have an `avatar_url`.
// A wall of identical grey circles makes the inbox hard to scan, so the
// fallback earns its keep: the same contact always gets the same colour
// on every surface, which is what makes a thread recognisable at a
// glance before you've read the name.
//
// Keyed on `contacts.id` — immutable, unlike the phone (the send path's
// phone-variant retry can rewrite it, which would change the colour
// under the user).
// ============================================================

/**
 * Fixed Tailwind colours, not theme tokens: the palette must look the
 * same in light and dark, and white text has to stay readable on every
 * entry (hence 500/600 weights — no pastels).
 */
const AVATAR_COLORS = [
  'bg-violet-500',
  'bg-blue-500',
  'bg-emerald-600',
  'bg-amber-600',
  'bg-rose-500',
  'bg-cyan-600',
  'bg-fuchsia-500',
  'bg-indigo-500',
  'bg-teal-600',
  'bg-orange-600',
] as const

/** djb2. Any stable hash works; this one is short and well-spread for
 *  the short keys (UUIDs / phone numbers) we feed it. */
function hash(key: string): number {
  let h = 5381
  for (let i = 0; i < key.length; i++) {
    h = ((h << 5) + h + key.charCodeAt(i)) | 0
  }
  return Math.abs(h)
}

/**
 * Background colour class for a contact's fallback avatar. Always pair
 * with white text — the palette is chosen for that contrast.
 */
export function avatarColorClass(key: string | null | undefined): string {
  if (!key) return AVATAR_COLORS[0]
  return AVATAR_COLORS[hash(key) % AVATAR_COLORS.length]
}

/**
 * Up to two initials for a display name.
 *
 * Handles the shapes that actually show up in a WhatsApp inbox:
 *   "Michael Sosa"  → "MS"
 *   "Michael"       → "M"
 *   "Michael 🔧"    → "M"    (emoji are not initials)
 *   "18292585106"   → "06"   (LAST two digits — the first two are the
 *                             country code, identical for every local
 *                             contact and therefore useless)
 *   "🔧" / ""       → "#"
 */
export function contactInitials(displayName: string | null | undefined): string {
  const name = (displayName ?? '').trim()
  if (!name) return '#'

  // Letters only — strips emoji, punctuation, and digits so a name like
  // "Michael 🔧" doesn't yield a wrench as its initial.
  const words = name
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}]/gu, ''))
    .filter(Boolean)

  if (words.length >= 2) {
    return (words[0][0] + words[1][0]).toUpperCase()
  }
  if (words.length === 1) {
    return words[0][0].toUpperCase()
  }

  // No letters at all: a phone-only contact (no name saved yet).
  const digits = name.replace(/\D/g, '')
  if (digits.length >= 2) return digits.slice(-2)
  return '#'
}
