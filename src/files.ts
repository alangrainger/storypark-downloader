import { mkdir, readFile, rename, stat, utimes, writeFile } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import path from 'node:path'

/** Make a string safe as a single path component on Linux, macOS and Windows. */
export function safeName(input: string, fallback = 'unknown'): string {
  const cleaned = input
    .normalize('NFC')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .trim()
  return (cleaned || fallback).slice(0, 120)
}

const EXT_BY_TYPE: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
}

export function extensionFor(contentType: string): string {
  const ct = contentType.split(';')[0].trim().toLowerCase()
  return EXT_BY_TYPE[ct] ?? (ct.split('/')[1] || 'bin').replace(/[^a-z0-9]/g, '')
}

interface LocalParts {
  year: string
  month: string
  day: string
  hour: string
  minute: string
  second: string
}

/** Wall-clock components of an instant in the given IANA time zone. */
export function localParts(date: Date, timeZone: string): LocalParts {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date)
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? '00'
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute'), second: get('second') }
}

/** YYYYMMDD_HHMMSS, for file names. */
export function timestampName(date: Date, timeZone: string): string {
  const p = localParts(date, timeZone)
  return `${p.year}${p.month}${p.day}_${p.hour}${p.minute}${p.second}`
}

/** "YYYY:MM:DD HH:MM:SS", the EXIF date format. */
export function exifDateString(date: Date, timeZone: string): string {
  const p = localParts(date, timeZone)
  return `${p.year}:${p.month}:${p.day} ${p.hour}:${p.minute}:${p.second}`
}

/** UTC offset of the zone at that instant, as "+13:00" / "-05:00" (EXIF OffsetTime format). */
export function utcOffsetString(date: Date, timeZone: string): string {
  const name = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
    .formatToParts(date).find(p => p.type === 'timeZoneName')?.value ?? 'GMT'
  const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(name)
  if (!m) return '+00:00'
  return `${m[1]}${m[2].padStart(2, '0')}:${m[3] ?? '00'}`
}

/** ISO 8601 local time with offset, Apple QuickTime style: "2026-01-22T20:36:27+1300". */
export function isoLocalWithOffset(date: Date, timeZone: string): string {
  const p = localParts(date, timeZone)
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${utcOffsetString(date, timeZone).replace(':', '')}`
}

/** YYYY-MM-DD of an instant in the given time zone. */
export function localDay(date: Date, timeZone: string): string {
  const p = localParts(date, timeZone)
  return `${p.year}-${p.month}-${p.day}`
}

/** The instant of 12:00 local time on a YYYY-MM-DD day in the given time zone. */
export function zonedNoon(day: string, timeZone: string): Date {
  const guess = new Date(`${day}T12:00:00Z`)
  const p = localParts(guess, timeZone)
  const wall = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second)
  return new Date(guess.getTime() - (wall - guess.getTime()))
}

export async function exists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

export async function readJson<T>(p: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(p, 'utf8')) as T
  } catch {
    return undefined
  }
}

/** Write JSON atomically (temp file + rename) so a crash never truncates it. */
export async function writeJson(p: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(p), { recursive: true })
  await writeFile(p + '.tmp', JSON.stringify(value, null, 2) + '\n')
  await rename(p + '.tmp', p)
}

/** Stream a response body to disk via a .part file, then set the mtime. */
export async function saveStream(res: Response, dest: string, mtime: Date): Promise<void> {
  if (!res.body) throw new Error('empty response body')
  await mkdir(path.dirname(dest), { recursive: true })
  const part = dest + '.part'
  await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), createWriteStream(part))
  await utimes(part, mtime, mtime)
  await rename(part, dest)
}
