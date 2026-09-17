# Calendar feed

Centres announce events as ordinary posts: a line of text, often with a poster or a PDF newsletter. Nothing is structured, so there is nothing to subscribe to. This feature reads each new post with a vision model, keeps whatever is dated, and publishes it as an iCal feed.

It reads every channel a family account can see - learning stories, centre-wide community posts and classroom posts - because Storypark keeps them apart and a notice in one never appears in the others.

## Setup

Any server that speaks the OpenAI chat completions API and serves a model that accepts images will do: Ollama, LM Studio, vLLM, llama.cpp.

```sh
EVENTS_API_URL=http://localhost:11434/v1
EVENTS_MODEL=qwen3-vl:8b
```

| Variable | Default | Meaning |
|---|---|---|
| `EVENTS_API_URL` | none | base URL of the API; setting it turns the feature on |
| `EVENTS_MODEL` | required | model id; must accept images |
| `EVENTS_API_KEY` | none | bearer token, if the server wants one |
| `EVENTS_MIN_CONFIDENCE` | `0.6` | drop events the model is less sure of than this |
| `EVENTS_MAX_POST_AGE_DAYS` | `60` | oldest post to read; see below |
| `EVENTS_IGNORE_CENTRES` | none | comma-separated centre IDs never read for events |
| `EVENTS_TOKEN` | none | secret path segment for the feed URL |

The feed is at `http://<host>:3000/events.ics`, rewritten every cycle, and holds events from today onwards. Each entry carries the centre, the post text and a link to the post.

`EVENTS_MAX_POST_AGE_DAYS` limits posts, not events. Notices go up weeks ahead, so a first run has to read back far enough to catch them. After that only unseen posts are read and the setting stops mattering.

## Subscribing

- **Apple Calendar:** *File > New Calendar Subscription*, refresh hourly. On iOS: *Settings > Apps > Calendar > Accounts > Add Account > Other > Add Subscribed Calendar*.
- **Home Assistant:** the Remote Calendar integration.
- **Google Calendar** fetches from Google's own servers, so it cannot see a feed on your network. Reaching it means a reverse proxy on that one path plus `EVENTS_TOKEN`, as the warning in the [README](../README.md) says. A client that polls from your own device avoids the question.

`EVENTS_TOKEN` moves the feed to `/<token>/events.ics` and disables the bare path. Use something long, such as `openssl rand -hex 16`. It is obscurity, not authentication: it stops a scan, not anyone who has the URL.

## More than one centre

When two centres post to your account, each entry is prefixed with its centre: `Sunnyvale Preschool: Photo Day`. With one centre the prefix is left off. The centre name is always the first line of the entry's notes.

A child who changes centre keeps the old profile, and the old centre keeps posting to it. Put its ID in `EVENTS_IGNORE_CENTRES` to stop reading those posts. Photos are unaffected. Centre IDs are in the log on every run.

## What gets sent where

Post text and attached images go to `EVENTS_API_URL`, once per post. On your own network they stay there; a hosted API receives your centre's posts and photos.

## Accuracy

The model reads posters as well as text, and occasionally misreads a date. Every event has a confidence score, and anything below `EVENTS_MIN_CONFIDENCE` is dropped. Treat an entry as a prompt to check the original post, which is one tap away. Raising the threshold gives fewer, safer entries.

## Trying it out

From a checkout (see Development in the [README](../README.md)), with the two variables above set:

```sh
npm run preview -- --days 14     # what the model finds in the last fortnight, writing nothing
npm run preview -- --story 123   # one post, by the id in its Storypark URL
```
