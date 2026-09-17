/*
Minimal RFC 5545 writer: enough of iCalendar to publish a read-only feed that Google
Calendar and Apple Calendar can subscribe to. Times are emitted in UTC rather than with
a TZID, which avoids shipping VTIMEZONE definitions; both clients render them correctly.
*/

const PRODID = '-//storypark-downloader//EN'

/** One entry in the feed. An event with no start time is all-day. */
export interface CalendarEvent {
  /** Stable across runs: the feed is republished in full every cycle. */
  uid: string
  summary: string
  /** Instant of the start, or the local day for an all-day event. */
  start: Date | string
  end: Date | string
  description?: string
  location?: string
  url?: string
}

/** Escape a TEXT value: backslash, semicolon, comma and newlines are all special. */
const escape = (value: string) =>
  value.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n')

/** "20260620T193000Z" */
const utcStamp = (date: Date) => date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')

/** "2026-07-07" -> "20260707" */
const dateValue = (day: string) => day.replace(/-/g, '')

/**
 * Fold to 75 octets per line, continuing with CRLF + one space. Counts bytes rather than
 * characters and never splits a UTF-8 sequence, so macrons survive the trip.
 */
function fold(line: string): string {
  const bytes = Buffer.from(line, 'utf8')
  if (bytes.length <= 75) return line
  const chunks: string[] = []
  for (let start = 0; start < bytes.length; ) {
    /* A continuation line spends one of its 75 octets on the leading space. */
    let end = Math.min(start + (chunks.length === 0 ? 75 : 74), bytes.length)
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--
    chunks.push(bytes.subarray(start, end).toString('utf8'))
    start = end
  }
  return chunks.join('\r\n ')
}

/** DTSTART/DTEND differ in form between a timed event and an all-day one. */
function timeProperty(name: string, value: Date | string): string {
  return typeof value === 'string' ? `${name};VALUE=DATE:${dateValue(value)}` : `${name}:${utcStamp(value)}`
}

/** Serialise a whole calendar. `name` is what the subscriber sees as the calendar title. */
export function buildCalendar(name: string, events: CalendarEvent[], now = new Date()): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${PRODID}`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escape(name)}`,
    /* Hints to the client that polling more often than this is pointless. */
    'REFRESH-INTERVAL;VALUE=DURATION:PT6H',
    'X-PUBLISHED-TTL:PT6H',
  ]
  for (const event of events) {
    lines.push(
      'BEGIN:VEVENT',
      `UID:${event.uid}`,
      `DTSTAMP:${utcStamp(now)}`,
      timeProperty('DTSTART', event.start),
      timeProperty('DTEND', event.end),
      `SUMMARY:${escape(event.summary)}`,
    )
    if (event.description) lines.push(`DESCRIPTION:${escape(event.description)}`)
    if (event.location) lines.push(`LOCATION:${escape(event.location)}`)
    if (event.url) lines.push(`URL:${escape(event.url)}`)
    lines.push('END:VEVENT')
  }
  lines.push('END:VCALENDAR')
  return lines.map(fold).join('\r\n') + '\r\n'
}
