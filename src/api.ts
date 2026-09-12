/*
Thin client for Storypark's internal JSON API (app.storypark.com/api/v3).
Undocumented; field names verified against live responses on 2026-09-11.
*/

const BASE = 'https://app.storypark.com'

/** Web page for a story, as a family member sees it. */
export const storyUrl = (storyId: string) => `${BASE}/stories/${storyId}`

/** "12 Example Street\nWellington\nZip/Post Code: 6011\nNZ" -> "12 Example Street, Wellington, 6011, NZ". */
function oneLineAddress(raw: string | null | undefined): string | undefined {
  const line = (raw ?? '')
    .split(/\r?\n/)
    .map(s => s.replace(/^\s*zip\/post\s*code:\s*/i, '').trim())
    .filter(Boolean)
    .join(', ')
  return line || undefined
}

/** Thrown when Storypark rejects the session cookie. */
export class AuthError extends Error {
  constructor(msg = 'Storypark rejected the session cookie. Log in again and update STORYPARK_SESSION_ID.') {
    super(msg)
    this.name = 'AuthError'
  }
}

export interface Child {
  id: string
  display_name: string
  first_name: string
  last_name: string
  centre_ids: string[]
}

export interface Media {
  id: string
  /** "image", "video" or "story_pdf" (rendered PDF pages, served as images). */
  type: string
  content_type: string
  file_name: string
  file_size: number
  /** ISO timestamp of the upload; the closest thing to when the photo was taken. */
  created_at: string
  /** Redirects to a short-lived signed CDN URL. */
  original_url: string
  resized_url: string
}

export interface Story {
  id: string
  title: string
  /** YYYY-MM-DD */
  date: string
  status: string
  published_at: string
  media: Media[]
}

interface StoriesPage {
  stories: Story[]
  next_page_token: string | null
}

/** What we use from a centre (a school / daycare) record. */
export interface CentreInfo {
  id: string
  name: string
  country?: string
  /** IANA zone, e.g. "Pacific/Auckland". */
  timeZone?: string
  /** Postal address as one line, when the centre has one on file. */
  address?: string
}

interface CentreResponse {
  centre: {
    id: string
    name: string
    country?: string
    tzdb_time_zone?: string
    plan?: { billing_address?: string | null }
  }
}

export class StoryparkClient {
  private readonly centres = new Map<string, Promise<CentreInfo | undefined>>()

  constructor(private readonly cookie: string) {}

  private headers(accept: string): Record<string, string> {
    return { Cookie: this.cookie, Accept: accept, 'User-Agent': 'storypark-downloader' }
  }

  /** GET a JSON endpoint. A 401, or a redirect to the login page, means the cookie is dead. */
  private async getJson<T>(path: string): Promise<T> {
    const res = await fetch(BASE + path, { headers: this.headers('application/json'), redirect: 'manual' })
    if (res.status === 401 || (res.status >= 300 && res.status < 400)) throw new AuthError()
    if (!res.ok) throw new Error(`GET ${path} -> HTTP ${res.status}`)
    return res.json() as Promise<T>
  }

  async children(): Promise<Child[]> {
    const body = await this.getJson<{ user: { children: Child[] } }>('/api/v3/users/me')
    return body.user.children
  }

  /** Every story for a child, following next_page_token until exhausted. */
  async stories(childId: string): Promise<Story[]> {
    const all: Story[] = []
    let token = ''
    for (;;) {
      const page = await this.getJson<StoriesPage>(
        `/api/v3/children/${childId}/stories?sort_by=updated_at&story_type=all&page_token=${encodeURIComponent(token)}`,
      )
      all.push(...page.stories)
      if (!page.next_page_token) return all
      token = page.next_page_token
    }
  }

  /** A centre's details, or undefined if the record is not readable. Cached for the client's life. */
  centre(centreId: string): Promise<CentreInfo | undefined> {
    let p = this.centres.get(centreId)
    if (!p) {
      p = this.getJson<CentreResponse>(`/api/v3/centres/${centreId}`)
        .then(({ centre }) => ({
          id: centre.id,
          name: centre.name,
          country: centre.country || undefined,
          timeZone: centre.tzdb_time_zone || undefined,
          address: oneLineAddress(centre.plan?.billing_address),
        }))
        .catch(err => {
          if (err instanceof AuthError) throw err
          return undefined
        })
      this.centres.set(centreId, p)
    }
    return p
  }

  /** Open a media download, following the redirect to the CDN. Caller streams the body. */
  async openMedia(url: string): Promise<Response> {
    const res = await fetch(url, { headers: this.headers('*/*'), redirect: 'follow' })
    if (res.status === 401 || res.url.includes('/users/sign_in')) throw new AuthError()
    if (!res.ok) throw new Error(`GET media -> HTTP ${res.status}`)
    if ((res.headers.get('content-type') ?? '').startsWith('text/html')) throw new AuthError()
    return res
  }
}
