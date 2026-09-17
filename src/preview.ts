/*
Shows what the event extraction would find in recent posts, without writing anything: no state
file, no calendar feed, nothing kept on disk. Handy for choosing a model, for settling on a value
for EVENTS_MIN_CONFIDENCE, and for seeing why a particular post did or did not produce an event.

  npm run preview -- --days 14     read the last 14 days of posts
  npm run preview -- --story 123   read a single post, by the story id in its Storypark URL

It prints your own posts and their text, so treat the output as private.
*/

import { type Story, StoryparkClient } from './api.js'
import { loadConfig } from './config.js'
import { loadImages } from './events.js'
import { extractEvents } from './extract.js'
import { addDays, localDay } from './files.js'

/** Parse "--days 14 --story 123" into { days: "14", story: "123" }. */
function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue
    const next = argv[i + 1]
    args[argv[i].slice(2)] = next && !next.startsWith('--') ? next : ''
  }
  return args
}

const preview = (value: unknown, width = 90): string => {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  const oneLine = (text ?? 'null').replace(/\s+/g, ' ')
  return oneLine.length > width ? `${oneLine.slice(0, width)}...` : oneLine
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const config = loadConfig()
  const client = new StoryparkClient(config.cookie)
  const timeZone = config.timeZone

  let children = await client.children()
  if (config.childIds.length) children = children.filter(c => config.childIds.includes(c.id))
  console.log(`${children.length} children on the account`)

  const stories = new Map<string, Story>()
  for (const child of children) {
    const found = await client.stories(child.id)
    console.log(`  child ${child.id}: ${found.length} stories`)
    for (const story of found) stories.set(story.id, story)
  }
  const all = [...stories.values()].sort((a, b) => b.date.localeCompare(a.date))
  console.log(`${all.length} distinct stories, newest ${all[0]?.date}, oldest ${all[all.length - 1]?.date}`)

  const days = Number(args.days || config.events?.maxPostAgeDays || 60)
  const cutoff = addDays(localDay(new Date(), timeZone), -days)
  const window = args.story ? all.filter(s => s.id === args.story) : all.filter(s => s.date >= cutoff).reverse()
  console.log(args.story ? `\npost ${args.story}` : `\n${window.length} posts since ${cutoff}`)
  if (!config.events) throw new Error('set EVENTS_API_URL and EVENTS_MODEL to run the extraction')

  for (const story of window) {
    const images = await loadImages(client, story.media ?? [])
    const started = Date.now()
    try {
      const text = await client.storyText(story.id)
      const events = await extractEvents(config.events, {
        date: story.date,
        title: story.title ?? '',
        text,
        images,
      })
      const seconds = ((Date.now() - started) / 1000).toFixed(1)
      console.log(`\n--- ${story.date}  ${preview(story.title)}  [${images.length} images, ${seconds}s]`)
      if (text) console.log(`    text: ${preview(text, 200)}`)
      for (const event of events) {
        const days = event.endDate > event.startDate ? `${event.startDate} to ${event.endDate}` : event.startDate
        const when = event.startTime ? `${days} ${event.startTime}-${event.endTime || '?'}` : `${days} (all day)`
        console.log(`    -> ${when}  ${event.title}  @${event.location || '-'}  confidence ${event.confidence.toFixed(2)}`)
      }
      if (!events.length) console.log('    -> no events')
    } catch (err) {
      console.log(`\n--- ${story.date}  ${preview(story.title)}\n    FAILED: ${(err as Error).message}`)
    }
  }
}

main().catch(err => {
  console.error(String(err))
  process.exit(1)
})
