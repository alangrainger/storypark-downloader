# Storypark downloader

Automatically download your children's photos and videos from [Storypark](https://www.storypark.com/) into a folder you own, ready for [Immich](https://immich.app/), Google Photos or any other photo library.

Storypark lets families view stories but gives them no way to keep the originals. This container runs in the background, checks for new stories on a schedule, and saves every photo and video with the metadata a photo library needs:

- 📅 **Dated correctly.** Storypark strips all metadata from its files. The tool works out when each item was taken and writes it back as EXIF (photos) and QuickTime creation dates (videos), including the time zone, so nothing lands on the wrong day.
- 📍 **Located.** Each file carries the centre's GPS position, so it shows up on the map and in place search.
- 🔗 **Linked to the story.** The description holds the story title and a link back to it on Storypark.
- 🔤 **Named to sort.** `storypark_20260908_102523_01.jpg` sorts chronologically in any file browser.
- 🔁 **Safe to re-run.** Only new items are fetched. Everything already saved is left alone.
- 🖼️ **Immich-friendly.** Add the folder as an external library and let an Immich workflow drop every new item into an album for each child.

## Contents

- [Quick start](#quick-start)
- [Getting the cookie](#getting-the-cookie)
- [Configuration](#configuration)
- [What you get](#what-you-get)
- [How dates are worked out](#how-dates-are-worked-out)
- [Using with Immich](#using-with-immich)
- [When the cookie expires](#when-the-cookie-expires)
- [Updating](#updating)
- [How it works](#how-it-works)
- [Development](#development)

## Quick start

You need Docker with the compose plugin. The image is published at `ghcr.io/alangrainger/storypark-downloader` for amd64 and arm64.

```sh
mkdir storypark-downloader && cd storypark-downloader
curl -O https://raw.githubusercontent.com/alangrainger/storypark-downloader/main/compose.yaml
curl -o .env https://raw.githubusercontent.com/alangrainger/storypark-downloader/main/.env.example
```

Edit `.env`: paste your cookie into `STORYPARK_SESSION_ID` (see [Getting the cookie](#getting-the-cookie)) and set `PHOTOS_HOST_PATH` to the folder that should receive the files. Then:

```sh
docker compose up -d
docker compose logs -f
```

The first run downloads everything. After that the container checks for new stories every six hours.

Without compose:

```sh
docker run -d --name storypark-downloader --restart unless-stopped \
  -e STORYPARK_SESSION_ID=your-cookie-value \
  -v /path/to/photos:/data \
  -p 3000:3000 \
  ghcr.io/alangrainger/storypark-downloader:latest
```

The container runs as a non-root user (UID 1000). Make sure the photos folder is writable by that user.

`http://localhost:3000/health` returns JSON, with HTTP 200 while the last run succeeded and 503 after a failure or an expired cookie. Point your uptime monitor at it.

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

All settings are environment variables, normally set in `.env`.

| Variable | Default | Meaning |
|---|---|---|
| `STORYPARK_SESSION_ID` | required | `_session_id` cookie value, or a full Cookie header |
| `PHOTOS_HOST_PATH` | required | host folder mounted at `/data` (compose only) |
| `INTERVAL` | `6h` | time between runs (`30m`, `6h`, `1d`); `0` runs once and exits |
| `CHILD_IDS` | all | comma-separated child IDs to include |
| `CONCURRENCY` | `4` | parallel downloads |
| `CENTRE_GPS` | none | manual coordinates per centre, e.g. `100001=-41.2865,174.7762;100002=-36.8485,174.7633` |
| `TZ` | `Pacific/Auckland` | fallback time zone, used only when a centre does not report one |
| `HEALTH_PORT` | `3000` | host port for `/health` (compose only) |

Child and centre IDs appear in the log on every run.

## What you get

```
/data/
  .storypark-downloader.json          state: what has been saved, geocoded centres
  Ada Lovelace/
    2025/
      storypark_20251103_094512_01.jpg
      storypark_20251103_094512_02.jpg
      storypark_20251103_101500_01.mp4
    2026/
      storypark_20260212_140301_01.jpg
```

One folder per child, one per year. The file name is the local date and time the item was taken; `_01`, `_02` and so on separate items from the same second. A child who moves centre gets a second Storypark profile with the same name, and both merge into one folder.

Videos are saved as the 720p MP4 stream the Storypark web app plays. The original uploads are not downloadable, even with a valid session.

Each photo carries EXIF `DateTimeOriginal` with its UTC offset, GPS coordinates, and an XMP description. Each video carries QuickTime creation times plus Apple-style creation date, description and location keys. The file's modification time matches too.

The description is the story title and its URL:

```
Painting with leaves
https://app.storypark.com/stories/123456789
```

The GPS position is the centre's. Storypark does not publish coordinates, so the centre's postal address, or failing that its name and country, is looked up once with OpenStreetMap's Nominatim and cached. The log shows the match. If it is wrong, or a centre cannot be found, set `CENTRE_GPS`; the next run rewrites the files.

## How dates are worked out

Storypark keeps no capture time, so the date is reconstructed from two clues: the story date, which is the day the educator says it happened and is often backdated, and the time the file was uploaded. The centre's own time zone is used throughout; Storypark reports it for every centre.

| Upload happened | Date used |
|---|---|
| On the story date | The upload time, so the photo has a real time of day |
| After the story date | 12:00 on the story date, as stories have a date only but no time |
| Before the story date | The upload time, because a photo cannot be taken after it was uploaded. This happens when an older image is reused in a new story |

## Using with Immich

Add the output folder as an [external library](https://docs.immich.app/features/libraries/). Immich reads the embedded date, time zone, location and description directly.

**Albums.** Immich's Workflows feature can file new items into an album as they arrive. Create a workflow with the *asset created* trigger, a filter on the file name or path, and the *add to album* action. One workflow per child works well: filter on the child's folder name, and add to that child's album. Every file this tool writes starts with `storypark_`, so a single workflow filtering on that prefix collects everything into one album instead. Workflows fire for external library scans in recent Immich versions.

If an update rewrites metadata on existing files, Immich will not notice on its own. Select the affected assets, for example by searching for the file name prefix `storypark_`, and choose **Refresh metadata**.

## When the cookie expires

Storypark sessions eventually expire. When that happens the container keeps running, logs `COOKIE EXPIRED` on every cycle, and `/health` returns 503 with `"status": "auth_error"`. Repeat [Getting the cookie](#getting-the-cookie), update `.env`, and restart the container.

## Updating

```sh
docker compose pull
docker compose up -d
```

When a new version changes what is embedded in the files, the next run rewrites the metadata on every saved file once. This is tracked by a version number in the state file, and the log says when it happens.

## How it works

The Storypark web app talks to an internal JSON API at `app.storypark.com/api/v3`, authenticated by the session cookie. This tool calls the same endpoints the web app uses to list your children, page through their stories and read centre details, then downloads each media file. Nothing is scraped from HTML and no browser is needed.

Metadata is written by small purpose-built writers: an EXIF and XMP writer for JPEGs, and an MP4 box editor that patches the header times and appends an Apple metadata block, shifting chunk offsets as needed. Files are never re-encoded.

## Development

Needs Node 22 or newer. There are no runtime dependencies.

```sh
git clone https://github.com/alangrainger/storypark-downloader.git
cd storypark-downloader
npm ci
npm run build
STORYPARK_SESSION_ID=... OUTPUT_DIR=./data INTERVAL=0 node dist/index.js
```

To build the image locally: `docker build -t storypark-downloader .`

Releases are cut by pushing a `v*` tag matching the version in `package.json`; GitHub Actions builds the multi-arch image, pushes it to GHCR and attaches a build provenance attestation.

## Licence

Public domain, under the [Unlicense](LICENSE).
