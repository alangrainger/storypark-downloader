import path from 'node:path'
import { existsSync } from 'node:fs'
import { utimes } from 'node:fs/promises'
import { AuthError, type CentreInfo, type Media, type Story, StoryparkClient, storyUrl } from './api.js'
import type { Config } from './config.js'
import { stampExifDate } from './exif.js'
import {
  exifDateString, exists, extensionFor, isoLocalWithOffset, localDay, readJson, safeName, saveStream, timestampName,
  utcOffsetString, writeJson, zonedNoon,
} from './files.js'
import { type EventsState, type EventStats, type FeedPost, updateEvents } from './events.js'
import { geocode, type GeoPoint } from './geocode.js'
import { log } from './log.js'
import { stampMp4Date } from './mp4.js'
import { writeXmpDescription } from './xmp.js'

const STATE_FILE = 'state.json'
/* Where the state lived up to v1.0.0: hidden, and in among the photos. */
const LEGACY_STATE_FILE = '.storypark-downloader.json'
const PREFIX = 'storypark_'
const WANTED_TYPES = new Set(['image', 'video'])
/* Bumped whenever the embedded metadata changes; older state triggers a one-off re-stamp of every saved file. */
const STATE_VERSION = 7

/** Persistent record of what has been saved and looked up. */
interface State {
  version: number
  /** media id -> path relative to the output dir */
  files: Record<string, string>
  /** centre id -> geocoded position (null = looked up, nothing found) */
  centres?: Record<string, (GeoPoint & { query: string }) | null>
  /** Only present when the events feature is on. */
  events?: EventsState
}

export interface SyncStats {
  children: number
  stories: number
  downloaded: number
  skipped: number
  stamped: number
  failed: number
  /** Only present when the events feature is on. */
  events?: EventStats
}

/** Everything embedded into a file besides the bytes themselves. */
interface Stamp {
  when: Date
  tz: string
  description: string
  gps?: { lat: number; lon: number }
}

/** Minimal concurrency limiter; avoids a dependency for one function. */
function limiter(n: number) {
  let active = 0
  const queue: (() => void)[] = []
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= n) await new Promise<void>(r => queue.push(r))
    active++
    try {
      return await fn()
    } finally {
      active--
      queue.shift()?.()
    }
  }
}

/**
 * When the item was taken. Storypark strips EXIF, so this is reconstructed from two clues:
 * the story date (the day the educator says it happened, often backdated) and the upload instant.
 * - Uploaded on the story date: the upload instant, which gives a real time of day.
 * - Uploaded later: 12:00 local time on the story date; the educator backdated the story.
 * - Uploaded earlier: the upload instant; a photo cannot be taken after it was uploaded
 *   (this happens when an older image is reused in a new story).
 */
export function takenAt(media: Media, story: Story, tz: string): Date {
  const noon = zonedNoon(story.date, tz)
  const upload = media.created_at ? new Date(media.created_at) : undefined
  if (!upload || Number.isNaN(upload.getTime())) return noon
  if (localDay(upload, tz) === story.date) return upload
  return upload < noon ? upload : noon
}

/**
 * Open the best available rendition. Video originals are not downloadable (the CDN returns 403),
 * so those fall back to the streaming rendition the web app plays.
 */
async function openBest(client: StoryparkClient, media: Media): Promise<Response> {
  try {
    return await client.openMedia(media.original_url)
  } catch (err) {
    const httpError = err instanceof Error && err.message.startsWith('GET media')
    if (!httpError || !media.resized_url) throw err
    if (media.type !== 'video') log.warn(`original unavailable for ${media.id} (${err.message}); saving the resized copy`)
    return client.openMedia(media.resized_url)
  }
}

/**
 * Pick <child>/<year>/storypark_YYYYMMDD_HHMMSS_NN.<ext>; NN counts up from 01 within the same second.
 * Synchronous on purpose: with no await inside, concurrent jobs cannot pick the same name.
 */
function allocateName(outputDir: string, childName: string, stamp: string, ext: string, reserved: Set<string>): string {
  const dir = path.join(childName, stamp.slice(0, 4))
  for (let n = 1; ; n++) {
    const rel = path.join(dir, `${PREFIX}${stamp}_${String(n).padStart(2, '0')}.${ext}`)
    if (!reserved.has(rel) && !existsSync(path.join(outputDir, rel))) {
      reserved.add(rel)
      return rel
    }
  }
}

/** ISO 6709 point as used by Apple's location key: "-41.2865+174.7762/". */
const iso6709 = (g: { lat: number; lon: number }) =>
  `${g.lat < 0 ? '-' : '+'}${Math.abs(g.lat).toFixed(4)}${g.lon < 0 ? '-' : '+'}${Math.abs(g.lon).toFixed(4)}/`

/**
 * Write the metadata into the file itself: EXIF + XMP for JPEGs, the QuickTime headers and Keys
 * for MP4/MOV. Other formats are left alone. Restores the mtime the write disturbed.
 */
async function stamp(file: string, s: Stamp): Promise<boolean> {
  let written = false
  if (/\.jpe?g$/i.test(file)) {
    written = await stampExifDate(file, exifDateString(s.when, s.tz), utcOffsetString(s.when, s.tz), s.gps)
    if (written) await writeXmpDescription(file, s.description)
  } else if (/\.(mp4|mov|m4v)$/i.test(file)) {
    written = await stampMp4Date(file, s.when, {
      creationDate: isoLocalWithOffset(s.when, s.tz),
      description: s.description,
      location: s.gps && iso6709(s.gps),
    })
  }
  if (written) await utimes(file, s.when, s.when)
  return written
}

/** The first of the child's centres that is readable, plus its position. */
async function resolveCentre(
  client: StoryparkClient,
  centreIds: string[],
  config: Config,
  state: State,
): Promise<{ info?: CentreInfo; gps?: { lat: number; lon: number } }> {
  for (const id of centreIds ?? []) {
    const info = await client.centre(id)
    if (!info) continue
    return { info, gps: await centreGps(info, config, state) }
  }
  return {}
}

/** Manual override, else a cached geocode, else one Nominatim lookup (address first, then name). */
async function centreGps(centre: CentreInfo, config: Config, state: State): Promise<{ lat: number; lon: number } | undefined> {
  const manual = config.centreGps[centre.id]
  if (manual) return manual
  const cache = (state.centres ??= {})
  if (centre.id in cache) return cache[centre.id] ?? undefined
  const query = centre.address ?? [centre.name, centre.country].filter(Boolean).join(', ')
  try {
    const hit = await geocode(query)
    cache[centre.id] = hit ? { ...hit, query } : null
    if (hit) log.info(`geocoded "${centre.name}" (${centre.id}) via "${query}" -> ${hit.lat}, ${hit.lon}: ${hit.label}`)
    else log.warn(`no geocode result for "${centre.name}" (${centre.id}) via "${query}"; set CENTRE_GPS to add a position`)
    return hit ?? undefined
  } catch (err) {
    log.warn(`geocoding "${centre.name}" failed (${(err as Error).message}); will retry next run`)
    return undefined
  }
}

/**
 * Read the state file, falling back to where v1.0.0 kept it: hidden, in the photo folder. Without
 * that fallback, renaming the file or splitting the directories would look like an empty state and
 * re-download the whole library.
 */
async function loadState(config: Config): Promise<State | undefined> {
  const current = await readJson<State>(path.join(config.stateDir, STATE_FILE))
  if (current) return current
  const legacyPath = path.join(config.outputDir, LEGACY_STATE_FILE)
  const legacy = await readJson<State>(legacyPath)
  if (legacy) {
    log.warn(
      `reading the old state file at ${legacyPath}; this run writes it to ${path.join(config.stateDir, STATE_FILE)} ` +
        `instead. Delete the old copy once this run has finished cleanly.`,
    )
  }
  return legacy
}

/** One full pass over every child and story. Throws AuthError if the cookie is dead. */
export async function syncAll(config: Config): Promise<SyncStats> {
  const client = new StoryparkClient(config.cookie)
  const stats: SyncStats = { children: 0, stories: 0, downloaded: 0, skipped: 0, stamped: 0, failed: 0 }
  const run = limiter(config.concurrency)
  const statePath = path.join(config.stateDir, STATE_FILE)
  const state: State = (await loadState(config)) ?? { version: STATE_VERSION, files: {} }
  const backfill = state.version < STATE_VERSION
  if (backfill) log.info('older state file: rewriting embedded metadata on previously saved files')
  const reserved = new Set<string>()
  const posts = new Map<string, FeedPost>()

  let children = await client.children()
  if (config.childIds.length) children = children.filter(c => config.childIds.includes(c.id))
  if (children.length === 0) log.warn('no children found on this account (check CHILD_IDS)')

  for (const child of children) {
    stats.children++
    // A child who moves centre gets a second profile with the same name; both land in one folder.
    const childName = safeName(child.display_name || `${child.first_name} ${child.last_name}`)
    const centre = await resolveCentre(client, child.centre_ids, config, state)
    const tz = centre.info?.timeZone ?? config.timeZone
    const stories = await client.stories(child.id)
    log.info(`${childName} (${child.id}): ${stories.length} stories, centre ${centre.info?.name ?? 'unknown'}, time zone ${tz}`)

    for (const story of stories) {
      stats.stories++
      /* Siblings share the centre's community posts, so the map keeps one copy of each. */
      if (config.events) posts.set(story.id, { story, timeZone: tz })
      const description = `${story.title.trim()}\n${storyUrl(story.id)}`
      const jobs: Promise<void>[] = []
      for (const media of story.media.filter(m => WANTED_TYPES.has(m.type))) {
        const s: Stamp = { when: takenAt(media, story, tz), tz, description, gps: centre.gps }
        const known = state.files[media.id]
        if (known && (await exists(path.join(config.outputDir, known)))) {
          stats.skipped++
          if (backfill) jobs.push(run(async () => {
            if (await stamp(path.join(config.outputDir, known), s)) stats.stamped++
          }))
          continue
        }
        jobs.push(run(async () => {
          try {
            const res = await openBest(client, media)
            // Name by what was actually served: a QuickTime original is streamed back as MP4.
            const ext = extensionFor(res.headers.get('content-type') || media.content_type)
            const rel = allocateName(config.outputDir, childName, timestampName(s.when, tz), ext, reserved)
            const abs = path.join(config.outputDir, rel)
            await saveStream(res, abs, s.when)
            if (await stamp(abs, s)) stats.stamped++
            state.files[media.id] = rel
            stats.downloaded++
            log.info(`saved ${rel}  (${story.date} "${story.title.trim()}")`)
          } catch (err) {
            if (err instanceof AuthError) throw err
            stats.failed++
            log.error(`failed ${media.id} in "${story.title.trim()}": ${(err as Error).message}`)
          }
        }))
      }
      if (jobs.length === 0) continue
      await Promise.all(jobs)
      await writeJson(statePath, state)
    }
  }

  if (config.events) {
    try {
      stats.events = await updateEvents(client, config, config.events, posts, (state.events ??= { posts: {} }))
      const e = stats.events
      log.info(`events: ${e.posts} posts in the window, ${e.read} read, ${e.failed} failed, ${e.published} in the feed`)
    } catch (err) {
      /* The photos are the point; a model or disk problem here must not fail the run. */
      log.error(`events: update failed: ${(err as Error).message}`)
    }
  }

  if (backfill && stats.failed === 0) state.version = STATE_VERSION
  await writeJson(statePath, state)
  return stats
}
