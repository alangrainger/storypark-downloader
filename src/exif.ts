import { readFile, writeFile } from 'node:fs/promises'

/*
Minimal EXIF writer for JPEGs. Storypark strips every EXIF field from the images it serves, so
the whole APP1 Exif segment is (re)built from scratch each time: IFD0, the Exif sub-IFD and,
when a position is known, the GPS sub-IFD. Layout follows TIFF 6 / EXIF 2.32: entries sorted by
tag, every IFD terminated by a next-IFD pointer, out-of-line values word-aligned.
*/

const SOI = 0xffd8
const APP0 = 0xffe0
const APP1 = 0xffe1
const SOS = 0xffda
const EXIF_HEADER = Buffer.from('Exif\0\0', 'latin1')

const BYTE = 1
const ASCII = 2
const SHORT = 3
const LONG = 4
const RATIONAL = 5
const UNDEFINED = 7

const TAG_DATETIME = 0x0132
const TAG_YCBCR_POSITIONING = 0x0213
const TAG_EXIF_IFD = 0x8769
const TAG_GPS_IFD = 0x8825
const TAG_EXIF_VERSION = 0x9000
const TAG_DATETIME_ORIGINAL = 0x9003
const TAG_DATETIME_DIGITIZED = 0x9004
const TAG_OFFSET_TIME = 0x9010
const TAG_OFFSET_TIME_ORIGINAL = 0x9011
const TAG_OFFSET_TIME_DIGITIZED = 0x9012
const TAG_COMPONENTS_CONFIGURATION = 0x9101
const TAG_COLOR_SPACE = 0xa001
const TAG_EXIF_IMAGE_WIDTH = 0xa002
const TAG_EXIF_IMAGE_HEIGHT = 0xa003
const GPS_VERSION_ID = 0x0000
const GPS_LATITUDE_REF = 0x0001
const GPS_LATITUDE = 0x0002
const GPS_LONGITUDE_REF = 0x0003
const GPS_LONGITUDE = 0x0004

interface Entry {
  tag: number
  type: number
  count: number
  value: Buffer
}

const ascii = (tag: number, s: string): Entry => {
  const value = Buffer.from(s + '\0', 'latin1')
  return { tag, type: ASCII, count: value.length, value }
}
const short = (tag: number, n: number): Entry => {
  const value = Buffer.alloc(2)
  value.writeUInt16BE(n, 0)
  return { tag, type: SHORT, count: 1, value }
}
const long = (tag: number, n: number): Entry => {
  const value = Buffer.alloc(4)
  value.writeUInt32BE(n, 0)
  return { tag, type: LONG, count: 1, value }
}
const bytes = (tag: number, type: number, b: number[]): Entry => ({ tag, type, count: b.length, value: Buffer.from(b) })

/** Degrees as the three EXIF rationals: degrees/1, minutes/1, seconds/10000. */
function dms(tag: number, deg: number): Entry {
  const abs = Math.abs(deg)
  const d = Math.floor(abs)
  const m = Math.floor((abs - d) * 60)
  const s = Math.round(((abs - d) * 60 - m) * 60 * 10000)
  const value = Buffer.alloc(24)
  for (const [i, [num, den]] of [[d, 1], [m, 1], [s, 10000]].entries()) {
    value.writeUInt32BE(num, i * 8)
    value.writeUInt32BE(den, i * 8 + 4)
  }
  return { tag, type: RATIONAL, count: 3, value }
}

const ifdSize = (entries: Entry[]) => 2 + entries.length * 12 + 4

/**
 * Serialise IFDs into one TIFF structure (big-endian). Every IFD's out-of-line values go into a
 * shared data area after the last IFD, each at an even offset.
 */
function buildTiff(ifds: Entry[][]): Buffer {
  let cursor = 8
  for (const ifd of ifds) cursor += ifdSize(ifd)
  const chunks: Buffer[] = [Buffer.from('MM\0\x2a\0\0\0\x08', 'latin1')]
  const data: Buffer[] = []
  let dataCursor = cursor
  for (const ifd of ifds) {
    const sorted = [...ifd].sort((a, b) => a.tag - b.tag)
    const buf = Buffer.alloc(ifdSize(sorted))
    buf.writeUInt16BE(sorted.length, 0)
    sorted.forEach((e, i) => {
      const at = 2 + i * 12
      buf.writeUInt16BE(e.tag, at)
      buf.writeUInt16BE(e.type, at + 2)
      buf.writeUInt32BE(e.count, at + 4)
      if (e.value.length <= 4) {
        e.value.copy(buf, at + 8)
      } else {
        if (dataCursor % 2) {
          data.push(Buffer.alloc(1))
          dataCursor++
        }
        buf.writeUInt32BE(dataCursor, at + 8)
        data.push(e.value)
        dataCursor += e.value.length
      }
    })
    buf.writeUInt32BE(0, buf.length - 4) // next IFD: none
    chunks.push(buf)
  }
  return Buffer.concat([...chunks, ...data])
}

/** Pixel size from the JPEG's start-of-frame segment, if found. */
function frameSize(buf: Buffer): { width: number; height: number } | undefined {
  let pos = 2
  while (pos + 4 <= buf.length) {
    const marker = buf.readUInt16BE(pos)
    if (marker === SOS || (marker & 0xff00) !== 0xff00) return undefined
    const isSof = marker >= 0xffc0 && marker <= 0xffcf && ![0xffc4, 0xffc8, 0xffcc].includes(marker)
    if (isSof && pos + 9 <= buf.length) return { height: buf.readUInt16BE(pos + 5), width: buf.readUInt16BE(pos + 7) }
    pos += 2 + buf.readUInt16BE(pos + 2)
  }
  return undefined
}

function buildExif(local: string, offset: string, gps: { lat: number; lon: number } | undefined, size?: { width: number; height: number }): Buffer {
  const exifIfd: Entry[] = [
    bytes(TAG_EXIF_VERSION, UNDEFINED, [0x30, 0x32, 0x33, 0x32]), // "0232"
    bytes(TAG_COMPONENTS_CONFIGURATION, UNDEFINED, [1, 2, 3, 0]), // YCbCr
    short(TAG_COLOR_SPACE, 0xffff), // uncalibrated: Storypark does not say
    ascii(TAG_DATETIME_ORIGINAL, local),
    ascii(TAG_DATETIME_DIGITIZED, local),
    ascii(TAG_OFFSET_TIME, offset),
    ascii(TAG_OFFSET_TIME_ORIGINAL, offset),
    ascii(TAG_OFFSET_TIME_DIGITIZED, offset),
  ]
  if (size) exifIfd.push(long(TAG_EXIF_IMAGE_WIDTH, size.width), long(TAG_EXIF_IMAGE_HEIGHT, size.height))
  const gpsIfd: Entry[] | undefined = gps && [
    bytes(GPS_VERSION_ID, BYTE, [2, 3, 0, 0]),
    ascii(GPS_LATITUDE_REF, gps.lat < 0 ? 'S' : 'N'),
    dms(GPS_LATITUDE, gps.lat),
    ascii(GPS_LONGITUDE_REF, gps.lon < 0 ? 'W' : 'E'),
    dms(GPS_LONGITUDE, gps.lon),
  ]
  // IFD0 holds the pointers, so its size (and thus the pointers' values) is known up front.
  const ifd0: Entry[] = [ascii(TAG_DATETIME, local), short(TAG_YCBCR_POSITIONING, 1), long(TAG_EXIF_IFD, 0)]
  if (gpsIfd) ifd0.push(long(TAG_GPS_IFD, 0))
  const exifOffset = 8 + ifdSize(ifd0)
  ifd0.find(e => e.tag === TAG_EXIF_IFD)!.value.writeUInt32BE(exifOffset, 0)
  if (gpsIfd) ifd0.find(e => e.tag === TAG_GPS_IFD)!.value.writeUInt32BE(exifOffset + ifdSize(exifIfd), 0)
  return buildTiff(gpsIfd ? [ifd0, exifIfd, gpsIfd] : [ifd0, exifIfd])
}

/**
 * Write DateTimeOriginal, DateTimeDigitized and DateTime ("YYYY:MM:DD HH:MM:SS", local time),
 * their UTC offset tags ("+13:00") and optionally a GPS position into a JPEG, replacing any
 * existing Exif segment. Without the offset tags readers such as Immich assume UTC.
 * Returns false when the file is not a JPEG.
 */
export async function stampExifDate(file: string, local: string, offset: string, gps?: { lat: number; lon: number }): Promise<boolean> {
  const buf = await readFile(file)
  if (buf.length < 4 || buf.readUInt16BE(0) !== SOI) return false

  const body = buildExif(local, offset, gps, frameSize(buf))
  const seg = Buffer.alloc(4)
  seg.writeUInt16BE(APP1, 0)
  seg.writeUInt16BE(2 + EXIF_HEADER.length + body.length, 2)
  const exifSegment = Buffer.concat([seg, EXIF_HEADER, body])

  const parts: Buffer[] = [buf.subarray(0, 2)]
  let insertAt = 1 // right after SOI, or after a leading JFIF APP0
  let pos = 2
  while (pos + 4 <= buf.length) {
    const marker = buf.readUInt16BE(pos)
    if (marker === SOS || (marker & 0xff00) !== 0xff00) break
    const len = buf.readUInt16BE(pos + 2)
    const segment = buf.subarray(pos, pos + 2 + len)
    const isExif = marker === APP1 && segment.subarray(4, 4 + EXIF_HEADER.length).equals(EXIF_HEADER)
    if (!isExif) {
      parts.push(segment)
      if (marker === APP0 && insertAt === 1) insertAt = parts.length
    }
    pos += 2 + len
  }
  parts.splice(insertAt, 0, exifSegment)
  parts.push(buf.subarray(pos))
  await writeFile(file, Buffer.concat(parts))
  return true
}
