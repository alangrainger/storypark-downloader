/*
One-off geocoding of a centre's address via OpenStreetMap's Nominatim. Called once per centre and
cached in the state file, which keeps well inside Nominatim's usage policy (identify yourself,
at most one request per second, cache results).
*/

export interface GeoPoint {
  lat: number
  lon: number
  /** Human-readable match, logged so a wrong hit is easy to spot and override. */
  label: string
}

const ENDPOINT = 'https://nominatim.openstreetmap.org/search'
const USER_AGENT = 'storypark-downloader (https://github.com/alangrainger/storypark-downloader)'

/** Look a free-text query up; undefined when nothing matches or the service is unreachable. */
export async function geocode(query: string): Promise<GeoPoint | undefined> {
  const url = `${ENDPOINT}?format=jsonv2&limit=1&q=${encodeURIComponent(query)}`
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } })
  if (!res.ok) throw new Error(`geocoder -> HTTP ${res.status}`)
  const hits = (await res.json()) as { lat: string; lon: string; display_name: string }[]
  const hit = hits[0]
  if (!hit) return undefined
  return { lat: Number(hit.lat), lon: Number(hit.lon), label: hit.display_name }
}
