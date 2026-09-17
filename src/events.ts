/*
Reads each unseen post with a vision model, records what it finds in the state file, and
republishes the whole feed as one .ics. Does nothing unless EVENTS_API_URL is set. Errors are
logged and swallowed rather than thrown: the photo sync must not fail because a model did.
*/

import { createHash } from 'node:crypto'
import path from 'node:path'
import { type Media, type Story, StoryparkClient, storyUrl } from './api.js'
import type { Config, EventsConfig } from './config.js'
import { type ExtractedEvent, extractEvents, PROMPT_VERSION } from './extract.js'
import { addDays, localDay, writeFileAtomic, zonedTime } from './files.js'
import { buildCalendar, type CalendarEvent } from './ical.js'
import { log } from './log.js'

export const EVENTS_FILE = 'events.ics'
const CALENDAR_NAME = 'Storypark'
/** A poster is normally the first attachment; a post with a dozen photos does not need them all read. */
const MAX_IMAGES = 3
/** Skip anything too big to be a poster. The resized rendition is normally far under this. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024
/** A date further out than this is a misread year rather than a real event. */
const MAX_DAYS_AHEAD = 550
/** Media types worth showing the model: images, and the page renderings of a PDF newsletter. */
const READABLE_TYPES = new Set(['image', 'story_pdf'])
/** How much of the post text to carry into the calendar entry. */
const MAX_DESCRIPTION = 800

/** A post gathered while the media sync walks the feed. */
export interface FeedPost {
  story: Story
  /** The centre's time zone, which is what times written in the post mean. */
  timeZone: string
}

/** What the model found in each post, kept in the state file so a post is only read once. */
export interface EventsState {
  /** story id -> extraction result; an empty events array means "read it, found nothing". */
  posts: Record<string, { version: number; date: string; text: string; events: ExtractedEvent[] }>
}

export interface EventStats {
  /** Posts inside the window, whether or not they needed reading. */
  posts: number
  /** Posts sent to the model this run. */
  read: number
  /** Events in the published feed. */
  published: number
  failed: number
}

/** Download the attachments worth reading, skipping anything oversized or not an image. */
export async function loadImages(client: StoryparkClient, media: Media[]): Promise<{ contentType: string; data: Buffer }[]> {
  const images: { contentType: string; data: Buffer }[] = []
  for (const item of media.filter(m => READABLE_TYPES.has(m.type)).slice(0, MAX_IMAGES)) {
    try {
      /* The resized rendition is what the web app shows: smaller, quicker, and always downloadable. */
      const res = await client.openMedia(item.resized_url || item.original_url)
      const contentType = (res.headers.get('content-type') || item.content_type).split(';')[0].trim()
      if (!contentType.startsWith('image/')) continue
      const data = Buffer.from(await res.arrayBuffer())
      if (data.length > MAX_IMAGE_BYTES) continue
      images.push({ contentType, data })
    } catch (err) {
      log.warn(`events: could not read attachment ${item.id}: ${(err as Error).message}`)
    }
  }
  return images
}

/** Sortable form of a start, which is either a day or an instant. */
const startKey = (event: CalendarEvent) => (typeof event.start === 'string' ? event.start : event.start.toISOString())

/** Lowercase, punctuation-free form of a title, so the same event announced twice collides. */
const titleKey = (title: string) => title.toLowerCase().normalize('NFC').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

/**
 * Turn one extracted event into a calendar entry, or undefined if it is in the past or so far
 * ahead that the model must have misread the year. All-day events use exclusive end dates,
 * as RFC 5545 requires.
 */
function toCalendarEvent(event: ExtractedEvent, story: Story, text: string, timeZone: string, now: Date): CalendarEvent | undefined {
  const today = localDay(now, timeZone)
  if (event.startDate > addDays(today, MAX_DAYS_AHEAD)) return undefined

  let start: Date | string
  let end: Date | string
  if (event.startTime) {
    start = zonedTime(event.startDate, event.startTime, timeZone)
    const stated = event.endTime ? zonedTime(event.endDate, event.endTime, timeZone) : undefined
    end = stated && stated > start ? stated : new Date(start.getTime() + 3_600_000)
    if (end < now) return undefined
  } else {
    start = event.startDate
    end = addDays(event.endDate, 1)
    if (end <= today) return undefined
  }

  const description = [
    story.title?.trim(),
    text.length > MAX_DESCRIPTION ? `${text.slice(0, MAX_DESCRIPTION)}...` : text,
    storyUrl(story.id),
  ]
    .filter(Boolean)
    .join('\n\n')

  return {
    /* Keyed on when and what rather than on the post, so the reminder post that repeats an
       announcement lands on the same entry instead of a duplicate. */
    uid: `${createHash('sha1').update(`${event.startDate}|${event.startTime}|${titleKey(event.title)}`).digest('hex').slice(0, 20)}@storypark-downloader`,
    summary: event.title,
    start,
    end,
    description,
    location: event.location || undefined,
    url: storyUrl(story.id),
  }
}

/**
 * Read every post in the window that has not been read yet, then republish the whole feed.
 * Model failures are logged and skipped: the post stays unread and is retried next cycle.
 */
export async function updateEvents(
  client: StoryparkClient,
  config: Config,
  events: EventsConfig,
  posts: Map<string, FeedPost>,
  state: EventsState,
): Promise<EventStats> {
  const now = new Date()
  const cutoff = addDays(localDay(now, config.timeZone), -events.maxPostAgeDays)
  const stats: EventStats = { posts: 0, read: 0, published: 0, failed: 0 }

  const recent = [...posts.values()].filter(p => p.story.date >= cutoff).sort((a, b) => a.story.date.localeCompare(b.story.date))
  for (const { story } of recent) {
    stats.posts++
    if (state.posts[story.id]?.version === PROMPT_VERSION) continue
    try {
      /* The stories list carries only an excerpt, and the feed entry wants the whole post. */
      const text = await client.storyText(story.id)
      const found = await extractEvents(events, {
        date: story.date,
        title: story.title ?? '',
        text,
        images: await loadImages(client, story.media ?? []),
      })
      state.posts[story.id] = { version: PROMPT_VERSION, date: story.date, text, events: found }
      stats.read++
      for (const event of found) {
        log.info(`events: "${event.title}" on ${event.startDate} ${event.startTime} (confidence ${event.confidence.toFixed(2)})`)
      }
    } catch (err) {
      stats.failed++
      log.warn(`events: reading post ${story.id} failed: ${(err as Error).message}`)
    }
  }

  /* Forget posts that have dropped out of the window, so the state file stays a fixed size. */
  for (const [id, entry] of Object.entries(state.posts)) {
    if (entry.date < cutoff) delete state.posts[id]
  }

  const calendar = new Map<string, { event: CalendarEvent; confidence: number }>()
  for (const { story, timeZone } of recent) {
    const entry = state.posts[story.id]
    for (const extracted of entry?.events ?? []) {
      if (extracted.confidence < events.minConfidence) continue
      const event = toCalendarEvent(extracted, story, entry?.text ?? '', timeZone, now)
      if (!event) continue
      const seen = calendar.get(event.uid)
      if (!seen || extracted.confidence > seen.confidence) calendar.set(event.uid, { event, confidence: extracted.confidence })
    }
  }

  const list = [...calendar.values()].map(entry => entry.event).sort((a, b) => startKey(a).localeCompare(startKey(b)))
  stats.published = list.length
  await writeFileAtomic(path.join(config.stateDir, EVENTS_FILE), buildCalendar(CALENDAR_NAME, list, now))
  return stats
}
