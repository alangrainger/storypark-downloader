/*
Event extraction from one post, via any OpenAI-compatible chat completions API that accepts
image input and a JSON schema response format: Ollama's /v1, LM Studio, vLLM or llama.cpp.
Nothing here is Storypark-specific; the caller supplies the post text and the image bytes.
*/

import type { EventsConfig } from './config.js'

/* Bumped whenever the prompt or the schema changes: posts extracted under an older version are re-read. */
export const PROMPT_VERSION = 2

/** A model request can include a cold model load, so allow minutes rather than seconds. */
const REQUEST_TIMEOUT_MS = 300_000

/** One post handed to the model. */
export interface PostInput {
  /** YYYY-MM-DD the post is dated; relative dates in the text resolve against it. */
  date: string
  title: string
  text: string
  images: { contentType: string; data: Buffer }[]
}

/** One event as the model reported it, after validation. */
export interface ExtractedEvent {
  title: string
  /** YYYY-MM-DD */
  startDate: string
  endDate: string
  /** HH:MM in the centre's time zone, or "" for an all-day event. */
  startTime: string
  endTime: string
  location: string
  /** 0 to 1, the model's own judgement. */
  confidence: number
}

const SYSTEM = `You extract calendar events from a childcare centre's community posts.

A post may contain no events at all - most do not. Only extract something a family would put in a
calendar: an outing, a fundraiser, a celebration, a closure, a parent evening, a photo day, a
term or holiday period, a deadline. Never extract a routine daily activity, something that already happened, or a general
reminder with no date.

Rules:
- Resolve every relative date ("next Friday", "this Thursday") against the post date given below.
- start_date and end_date are YYYY-MM-DD. For a single-day event both are the same day.
- start_time and end_time are 24-hour HH:MM, or "" when the post gives no time (an all-day event).
- location is the place named in the post, or "" if none is named.
- confidence is 0.0 to 1.0: how sure you are that this is a real, dated, future event that a family
  should see. Use below 0.5 when the date is a guess.
- Output {"events": []} when the post contains no event.`

const SCHEMA = {
  type: 'object',
  properties: {
    events: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          start_date: { type: 'string' },
          end_date: { type: 'string' },
          start_time: { type: 'string' },
          end_time: { type: 'string' },
          location: { type: 'string' },
          confidence: { type: 'number' },
        },
        required: ['title', 'start_date', 'end_date', 'start_time', 'end_time', 'location', 'confidence'],
      },
    },
  },
  required: ['events'],
}

const isDay = (value: unknown): value is string =>
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))

const isTime = (value: unknown): value is string => typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value)

/** Pull the JSON object out of a reply, tolerating a code fence or a stray preamble. */
function parseJsonObject(content: string): unknown {
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '')
  try {
    return JSON.parse(trimmed)
  } catch {
    const start = trimmed.indexOf('{')
    const end = trimmed.lastIndexOf('}')
    if (start === -1 || end <= start) throw new Error(`model did not return JSON: ${content.slice(0, 200)}`)
    return JSON.parse(trimmed.slice(start, end + 1))
  }
}

/**
 * Keep only events that make sense: a real start date, times that parse, a title. Anything the
 * model got creative with is dropped rather than guessed at.
 */
function validate(raw: unknown): ExtractedEvent[] {
  const list = (raw as { events?: unknown }).events
  if (!Array.isArray(list)) return []
  const events: ExtractedEvent[] = []
  for (const item of list) {
    const e = item as Record<string, unknown>
    const title = typeof e.title === 'string' ? e.title.trim() : ''
    if (!title || !isDay(e.start_date)) continue
    const startDate = e.start_date
    const startTime = isTime(e.start_time) ? e.start_time : ''
    events.push({
      title,
      startDate,
      endDate: isDay(e.end_date) && e.end_date >= startDate ? e.end_date : startDate,
      startTime,
      /* An end time without a start time describes nothing we can place on a calendar. */
      endTime: startTime && isTime(e.end_time) ? e.end_time : '',
      location: typeof e.location === 'string' ? e.location.trim() : '',
      confidence: typeof e.confidence === 'number' ? Math.min(1, Math.max(0, e.confidence)) : 0,
    })
  }
  return events
}

/** Ask the model to read one post. Throws if the server is unreachable or answers with nonsense. */
export async function extractEvents(config: EventsConfig, post: PostInput): Promise<ExtractedEvent[]> {
  const parts: unknown[] = [
    {
      type: 'text',
      text: `Post date: ${post.date}\nPost title: ${post.title || '(none)'}\n\nPost text:\n${post.text || '(no text)'}`,
    },
  ]
  for (const image of post.images) {
    parts.push({ type: 'image_url', image_url: { url: `data:${image.contentType};base64,${image.data.toString('base64')}` } })
  }
  if (post.images.length) {
    parts.push({ type: 'text', text: 'The attached image(s) are part of the post. Read any text in them.' })
  }

  const res = await fetch(`${config.apiUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    body: JSON.stringify({
      model: config.model,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: parts },
      ],
      temperature: 0,
      max_tokens: 2000,
      stream: false,
      response_format: { type: 'json_schema', json_schema: { name: 'events', schema: SCHEMA, strict: true } },
      /* Reasoning costs minutes on a local box and buys nothing here; servers that do not know
         this field ignore it. */
      chat_template_kwargs: { enable_thinking: false },
    }),
  })
  if (!res.ok) throw new Error(`POST /chat/completions -> HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`)

  const body = (await res.json()) as { choices?: { message?: { content?: string } }[] }
  const content = body.choices?.[0]?.message?.content
  if (!content) throw new Error('model returned an empty reply')
  return validate(parseJsonObject(content))
}
