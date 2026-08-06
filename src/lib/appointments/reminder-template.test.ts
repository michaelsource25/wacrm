import { describe, it, expect } from 'vitest'
import {
  DEFAULT_REMINDER_TEMPLATE,
  dueReminderKind,
  formatLocalParts,
  renderReminderTemplate,
} from './reminder-template'

const H = 60 * 60_000

describe('renderReminderTemplate', () => {
  it('fills every placeholder in business local time', () => {
    const text = renderReminderTemplate({
      template: '{name} | {service} | {date} | {time}',
      contactName: 'Carlos',
      serviceName: 'Corte + barba',
      // 19:00 UTC → 15:00 in Santo Domingo (UTC-4)
      startsAt: '2026-08-07T19:00:00.000Z',
      timezone: 'America/Santo_Domingo',
    })
    expect(text).toBe('Carlos | Corte + barba | 07/08/2026 | 3:00 PM')
  })

  it('falls back to the default template and generic values', () => {
    const text = renderReminderTemplate({
      template: null,
      contactName: null,
      serviceName: null,
      startsAt: '2026-08-07T09:30:00.000Z',
      timezone: null,
    })
    expect(text).toBe(
      DEFAULT_REMINDER_TEMPLATE.replaceAll('{name}', 'there')
        .replaceAll('{service}', 'appointment')
        .replaceAll('{date}', '07/08/2026')
        .replaceAll('{time}', '9:30 AM'),
    )
  })

  it('renders midnight and noon correctly', () => {
    expect(formatLocalParts('2026-08-07T00:00:00.000Z', null)).toEqual({
      date: '07/08/2026',
      time: '12:00 AM',
    })
    expect(formatLocalParts('2026-08-07T12:00:00.000Z', null)).toEqual({
      date: '07/08/2026',
      time: '12:00 PM',
    })
  })
})

describe('dueReminderKind', () => {
  const now = Date.parse('2026-08-06T12:00:00.000Z')
  const at = (h: number) => now + h * H

  it('picks the 24h reminder inside its window', () => {
    expect(
      dueReminderKind({ nowMs: now, startsAtMs: at(20), sent24h: false, sent2h: false }),
    ).toBe('24h')
  })

  it('picks the 2h reminder inside its window, even if 24h never fired', () => {
    expect(
      dueReminderKind({ nowMs: now, startsAtMs: at(1.5), sent24h: false, sent2h: false }),
    ).toBe('2h')
  })

  it('returns null when already sent, too far out, or too close', () => {
    expect(
      dueReminderKind({ nowMs: now, startsAtMs: at(20), sent24h: true, sent2h: false }),
    ).toBeNull()
    expect(
      dueReminderKind({ nowMs: now, startsAtMs: at(1.5), sent24h: false, sent2h: true }),
    ).toBeNull()
    expect(
      dueReminderKind({ nowMs: now, startsAtMs: at(30), sent24h: false, sent2h: false }),
    ).toBeNull()
    expect(
      dueReminderKind({ nowMs: now, startsAtMs: now + 5 * 60_000, sent24h: false, sent2h: false }),
    ).toBeNull()
    expect(
      dueReminderKind({ nowMs: now, startsAtMs: at(-1), sent24h: false, sent2h: false }),
    ).toBeNull()
  })
})
