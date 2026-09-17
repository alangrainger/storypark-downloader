# Storypark downloader

Downloads your children's photos and videos from [Storypark](https://www.storypark.com/) into a folder you own, ready for [Immich](https://immich.app/), Google Photos or any other photo library. Optionally, it also turns the centre's notices into a calendar feed.

Storypark lets families view stories but not keep the originals. This container checks for new stories on a schedule and saves every photo and video with the metadata a photo library needs:

- 📅 **Dated correctly.** Storypark strips all metadata. The capture time is reconstructed and written back as EXIF (photos) and QuickTime creation dates (videos), time zone included.
- 📍 **Located.** Each file carries the centre's GPS position.
- 🔗 **Linked to the story.** The description holds the story title and a link back to it.
- 🔤 **Named to sort.** `storypark_20260908_102523_01.jpg` sorts chronologically anywhere.
- 🔁 **Safe to re-run.** Only new items are fetched.
- 🖼️ **Immich-friendly.** Add the folder as an external library and let a workflow file each child's photos into an album.
- 🗓️ **Calendar feed (optional).** A vision model on your own network reads the centre's notices and posters and publishes the events as an iCal feed. See [Calendar feed](docs/calendar-feed.md).

> [!IMPORTANT]
> This container is intended to be served on your local network. It holds a session cookie with full
> access to your Storypark account, and its HTTP endpoints have no authentication: anyone who can
> reach the port can read `/health` and, if the calendar feed is on, your centre's notices.
>
> If you want to make the calendar feed public, use a reverse proxy that exposes only that one path,
> and set `EVENTS_TOKEN` so the URL is not guessable.

## Contents

- [Quick start](#quick-start)
- [Getting the cookie](#getting-the-cookie)
- [Configuration](#configuration)
- [What you get](#what-you-get)
- [How dates are worked out](#how-dates-are-worked-out)
- [Using with Immich](#using-with-immich)
- [Calendar feed](#calendar-feed)
- [When the cookie expires](#when-the-cookie-expires)
- [Updating](#updating)
- [How it works](#how-it-works)
- [Development](#development)

## Quick start

Needs Docker with the compose plugin. The image is `ghcr.io/alangrainger/storypark-downloader`, for amd64 and arm64.

```sh
mkdir storypark-downloader && cd storypark-downloader
curl -O https://raw.githubusercontent.com/alangrainger/storypark-downloader/main/compose.yaml
curl -o .env https://raw.githubusercontent.com/alangrainger/storypark-downloader/main/.env.example
mkdir downloads state
```

Paste your cookie into `STORYPARK_SESSION_ID` in `.env` (see [Getting the cookie](#getting-the-cookie)), then:

```sh
docker compose up -d
docker compose logs -f
```

Photos land in `./downloads`, which holds nothing else and can be handed to a photo library as-is. The tool's own files go in `./state`. The first run downloads everything; after that it checks every six hours.

Without compose:

```sh
docker run -d --name storypark-downloader --restart unless-stopped \
  -e STORYPARK_SESSION_ID=your-cookie-value \
  -v /path/to/photos:/downloads \
  -v /path/to/state:/state \
  -p 3000:3000 \
  ghcr.io/alangrainger/storypark-downloader:latest
```

The container runs as UID 1000; both folders must be writable by it. `http://localhost:3000/health` returns 200 while the last run succeeded and 503 after a failure or an expired cookie.

## Getting the cookie

Storypark has no API keys for families, so the tool signs in with your browser session cookie.

1. Log in at [app.storypark.com](https://app.storypark.com) in Chrome or Firefox.
2. Press F12 to open the developer tools.
3. Open the **Application** tab (Chrome) or **Storage** tab (Firefox).
4. Expand **Cookies** and select `https://app.storypark.com`.
5. Copy the **Value** of the row named `_session_id`.
6. Paste it into `.env` as `STORYPARK_SESSION_ID=<value>`.

Copying the whole `Cookie:` request header from the Network tab works too.

## Configuration

Environment variables, normally set in `.env`.

| Variable | Default | Meaning |
|---|---|---|
| `STORYPARK_SESSION_ID` | required | `_session_id` cookie value, or a full Cookie header |
| `INTERVAL` | `6h` | time between runs (`30m`, `6h`, `1d`); `0` runs once and exits |
| `CHILD_IDS` | all | comma-separated child IDs to include |
| `CONCURRENCY` | `4` | parallel downloads |
| `CENTRE_GPS` | none | manual coordinates per centre, e.g. `100001=-41.2865,174.7762;100002=-36.8485,174.7633` |
| `TZ` | `Pacific/Auckland` | fallback time zone, used only when a centre does not report one |
| `HEALTH_PORT` | `3000` | host port for `/health` (compose only) |
| `EVENTS_*` | off | the [calendar feed](docs/calendar-feed.md) |

Child and centre IDs appear in the log on every run.

## What you get

```
/downloads/                           photos and videos, nothing else
  Jane Smith/
    2025/
      storypark_20251103_094512_01.jpg
      storypark_20251103_094512_02.jpg
      storypark_20251103_101500_01.mp4
    2026/
      storypark_20260212_140301_01.jpg

/state/                               the tool's own files
  state.json                          what has been saved, geocoded centres, extracted events
  events.ics                          the calendar feed, when it is on
```

One folder per child, one per year. The file name is the local date and time the item was taken; `_01`, `_02` separate items from the same second. A child who moves centre gets a second Storypark profile with the same name, and both merge into one folder.

Videos are the 720p MP4 stream the web app plays; the originals are not downloadable, even with a valid session.

Photos carry EXIF `DateTimeOriginal` with UTC offset, GPS coordinates and an XMP description. Videos carry QuickTime creation times plus Apple-style creation date, description and location keys. The file modification time matches. The description is the story title and its URL:

```
Painting with leaves
https://app.storypark.com/stories/123456789
```

The GPS position is the centre's. Storypark publishes no coordinates, so the centre's postal address, or failing that its name and country, is looked up once with OpenStreetMap's Nominatim and cached. The log shows the match. If it is wrong or missing, set `CENTRE_GPS`; the next run rewrites the files.

## How dates are worked out

Storypark keeps no capture time, so it is reconstructed from the story date - the day the educator says it happened, often backdated - and the upload time, in the centre's own time zone.

| Upload happened | Date used |
|---|---|
| On the story date | The upload time, so the photo has a real time of day |
| After the story date | 12:00 on the story date; stories have a date but no time |
| Before the story date | The upload time, since a photo cannot be taken after it was uploaded. This is an older image reused in a new story |

## Using with Immich

Add `downloads` as an [external library](https://docs.immich.app/features/libraries/). Immich reads the embedded date, time zone, location and description directly.

**Albums.** An Immich workflow with the *asset created* trigger, a filter on the path, and the *add to album* action files new items as they arrive - one workflow per child, filtering on the child's folder name. Every file starts with `storypark_`, so one workflow on that prefix collects everything instead.

If an update rewrites metadata on existing files, select those assets (search for `storypark_`) and choose **Refresh metadata**; Immich will not notice on its own.

## Calendar feed

Optional. A vision model on your own network reads each new post - stories, centre notices and classroom posts, posters included - and publishes anything dated as an iCal feed at `/events.ics`, for Apple Calendar, Home Assistant or any client that polls a URL. Two variables turn it on:

```sh
EVENTS_API_URL=http://localhost:11434/v1
EVENTS_MODEL=qwen3-vl:8b
```

Subscribing, thresholds, more than one centre and what gets sent where: [docs/calendar-feed.md](docs/calendar-feed.md).

## When the cookie expires

The container keeps running, logs `COOKIE EXPIRED` every cycle, and `/health` returns 503 with `"status": "auth_error"`. Repeat [Getting the cookie](#getting-the-cookie), update `.env`, restart.

## Updating

```sh
docker compose pull
docker compose up -d
```

When a version changes what is embedded in the files, the next run rewrites the metadata on every saved file once. The log says when it happens.

## How it works

The Storypark web app talks to an internal JSON API at `app.storypark.com/api/v3`, authenticated by the session cookie. This tool calls the same endpoints to list your children, page through their stories and community posts and read centre details, then downloads each media file. Nothing is scraped from HTML; no browser is needed.

Metadata is written by small purpose-built writers: EXIF and XMP for JPEGs, and an MP4 box editor that patches the header times and appends an Apple metadata block, shifting chunk offsets as needed. Files are never re-encoded.

## Development

Node 22 or newer, no runtime dependencies. `OUTPUT_DIR` and `STATE_DIR` override the container's `/downloads` and `/state`, which only matters when running from a checkout.

```sh
git clone https://github.com/alangrainger/storypark-downloader.git
cd storypark-downloader
npm ci
npm run build
STORYPARK_SESSION_ID=... OUTPUT_DIR=./downloads STATE_DIR=./state INTERVAL=0 node dist/index.js
```

`npm run preview -- --days 14` reads recent posts through the calendar-feed model and prints what it finds, writing nothing. Build the image locally with `docker build -t storypark-downloader .`

## Licence

Public domain, under the [Unlicense](LICENSE).
