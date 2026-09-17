/*
Shows what the event extraction would find in recent posts, without writing anything: no state
file, no calendar feed, nothing kept on disk. Handy for choosing a model, for settling on a value
for EVENTS_MIN_CONFIDENCE, and for seeing why a particular post did or did not produce an event.

  npm run preview -- --days 14     read the last 14 days of posts, from every channel
  npm run preview -- --story 123   read a single post, by the id in its Storypark URL

It prints your own posts and their text, so treat the output as private.
*/

import { StoryparkClient } from './api.js'
import { loadConfig } from './config.js'
import { communityPostsSince, fromStory, loadImages, type Post } from './events.js'
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

const preview = (text: string, width = 90): string => {
  const oneLine = text.replace(/\s+/g, ' ')
  return oneLine.length > width ? `${oneLine.slice(0, width)}...` : oneLine
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const config = loadConfig()
  if (!config.events) throw new Error('set EVENTS_API_URL and EVENTS_MODEL to run the extraction')
  const client = new StoryparkClient(config.cookie)
  const days = Number(args.days || config.events.maxPostAgeDays)
  const cutoff = addDays(localDay(new Date(), config.timeZone), -days)

  let children = await client.children()
  if (config.childIds.length) children = children.filter(c => config.childIds.includes(c.id))
  console.log(`${children.length} children on the account`)

  const posts = new Map<string, Post>()
  for (const child of children) {
    const found = await client.stories(child.id)
    console.log(`  child ${child.id}: ${found.length} stories`)
    for (const story of found) posts.set(story.id, fromStory(client, story, config.timeZone))
  }
  const community = await communityPostsSince(client, config, cutoff)
  console.log(`  ${community.length} centre and classroom community posts since ${cutoff}`)
  for (const post of community) posts.set(post.key, post)

  const window = args.story
    ? [...posts.values()].filter(p => p.key === args.story || p.key === `cp:${args.story}`)
    : [...posts.values()].filter(p => p.date >= cutoff).sort((a, b) => a.date.localeCompare(b.date))
  console.log(args.story ? `\npost ${args.story}` : `\n${window.length} posts since ${cutoff}`)

  for (const post of window) {
    const images = await loadImages(client, post.media)
    const started = Date.now()
    try {
      const text = await post.text()
      const events = await extractEvents(config.events, { date: post.date, title: post.title, text, images })
      const seconds = ((Date.now() - started) / 1000).toFixed(1)
      console.log(`\n--- ${post.date}  ${post.key}  ${post.centreName ?? ''}  ${preview(post.title)}  [${images.length} images, ${seconds}s]`)
      if (text) console.log(`    text: ${preview(text, 200)}`)
      for (const event of events) {
        const dates = event.endDate > event.startDate ? `${event.startDate} to ${event.endDate}` : event.startDate
        const when = event.startTime ? `${dates} ${event.startTime}-${event.endTime || '?'}` : `${dates} (all day)`
        console.log(`    -> ${when}  ${event.title}  @${event.location || '-'}  confidence ${event.confidence.toFixed(2)}`)
      }
      if (!events.length) console.log('    -> no events')
    } catch (err) {
      console.log(`\n--- ${post.date}  ${post.key}\n    FAILED: ${(err as Error).message}`)
    }
  }
}

main().catch(err => {
  console.error(String(err))
  process.exit(1)
})
