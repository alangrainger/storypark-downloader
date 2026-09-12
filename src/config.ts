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
  }
}
