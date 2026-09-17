/** Optional event extraction and iCal feed, off unless EVENTS_API_URL is set. */
export interface EventsConfig {
  /** Base URL of an OpenAI-compatible API, including the /v1 path. */
  apiUrl: string
  /** Model id as that server names it; must accept image input. */
  model: string
  /** Bearer token, for servers that want one. */
  apiKey?: string
  /** Drop events the model is less sure of than this. */
  minConfidence: number
  /** Oldest post worth reading, in days. Not a limit on the events themselves: the feed always
      runs from today onwards, but a post announces an event weeks before it happens. */
  maxPostAgeDays: number
  /** Secret path segment for the feed, for when the port is not private. */
  token?: string
}

/** Runtime configuration, read once from environment variables. */
export interface Config {
  /** Full Cookie header value sent to Storypark. */
  cookie: string
  outputDir: string
  /** Milliseconds between runs; 0 means run once and exit. */
  intervalMs: number
  /** Child IDs to sync; empty means every child on the account. */
  childIds: string[]
  concurrency: number
  port: number
  /** Fallback IANA time zone, used when a centre does not report one. */
  timeZone: string
  /** Manual coordinates per centre id, overriding geocoding. */
  centreGps: Record<string, { lat: number; lon: number }>
  /** Undefined when EVENTS_API_URL is unset, which is the default. */
  events?: EventsConfig
}

/** Parse CENTRE_GPS="100001=-41.2865,174.7762;100002=-36.8485,174.7633". */
export function parseCentreGps(value: string): Record<string, { lat: number; lon: number }> {
  const out: Record<string, { lat: number; lon: number }> = {}
  for (const entry of value.split(';').map(s => s.trim()).filter(Boolean)) {
    const m = /^(\d+)\s*=\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/.exec(entry)
    if (!m) throw new Error(`CENTRE_GPS entry "${entry}" must look like "<centre id>=<lat>,<lon>"`)
    out[m[1]] = { lat: Number(m[2]), lon: Number(m[3]) }
  }
  return out
}

/** Parse a duration such as "6h", "30m", "90s" or "0" into milliseconds. */
export function parseInterval(value: string): number {
  const match = /^(\d+)\s*([smhd]?)$/.exec(value.trim())
  if (!match) throw new Error(`INTERVAL must look like "6h", "30m" or "0", got "${value}"`)
  const unit: Record<string, number> = { '': 1000, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }
  return Number(match[1]) * unit[match[2]]
}

/** Accept either the bare _session_id value or a whole Cookie header. */
function toCookieHeader(value: string): string {
  const v = value.trim()
  return v.includes('=') ? v : `_session_id=${v}`
}

/** Accept a bare "http://host:11434" as well as a full "http://host:11434/v1". */
export function normaliseApiUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    throw new Error(`EVENTS_API_URL must be a URL such as "http://localhost:11434/v1", got "${value}"`)
  }
  return url.origin + (url.pathname.replace(/\/+$/, '') || '/v1')
}

/** Read a number from the environment, rejecting anything outside the range. */
function numberInRange(name: string, raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw.trim() === '') return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be a number between ${min} and ${max}, got "${raw}"`)
  }
  return value
}

function loadEventsConfig(env: NodeJS.ProcessEnv): EventsConfig | undefined {
  const apiUrl = env.EVENTS_API_URL?.trim()
  if (!apiUrl) return undefined
  const model = env.EVENTS_MODEL?.trim()
  if (!model) throw new Error('EVENTS_MODEL is required when EVENTS_API_URL is set')
  const token = env.EVENTS_TOKEN?.trim() || undefined
  if (token && !/^[A-Za-z0-9._~-]+$/.test(token)) {
    throw new Error('EVENTS_TOKEN must contain only letters, digits and "._~-", since it becomes part of the URL')
  }
  /* These two pass the character check, but HTTP clients rewrite dot segments away before sending,
     so the feed would be unreachable while the log still advertised it. */
  if (token === '.' || token === '..') throw new Error('EVENTS_TOKEN cannot be "." or ".."')
  return {
    apiUrl: normaliseApiUrl(apiUrl),
    model,
    apiKey: env.EVENTS_API_KEY?.trim() || undefined,
    minConfidence: numberInRange('EVENTS_MIN_CONFIDENCE', env.EVENTS_MIN_CONFIDENCE, 0.6, 0, 1),
    maxPostAgeDays: numberInRange('EVENTS_MAX_POST_AGE_DAYS', env.EVENTS_MAX_POST_AGE_DAYS, 60, 1, 3650),
    token,
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const session = env.STORYPARK_SESSION_ID
  if (!session) throw new Error('STORYPARK_SESSION_ID is required (see README for how to get it)')
  return {
    cookie: toCookieHeader(session),
    outputDir: env.OUTPUT_DIR || '/data',
    intervalMs: parseInterval(env.INTERVAL ?? '6h'),
    childIds: (env.CHILD_IDS ?? '').split(',').map(s => s.trim()).filter(Boolean),
    concurrency: Math.max(1, Number(env.CONCURRENCY ?? 4)),
    port: Number(env.PORT ?? 3000),
    timeZone: env.TZ || 'Pacific/Auckland',
    centreGps: parseCentreGps(env.CENTRE_GPS ?? ''),
    events: loadEventsConfig(env),
  }
}
