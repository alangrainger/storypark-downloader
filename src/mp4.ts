import { open, rename } from 'node:fs/promises'
import { createReadStream, createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'

/* Seconds between the QuickTime epoch (1904-01-01) and the Unix epoch. */
const QT_EPOCH_OFFSET = 2082844800n
/* Boxes that contain the header boxes we patch, and are safe to walk into. */
const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl'])
/* Full boxes whose first two fields after version/flags are creation_time and modification_time. */
const HEADERS = new Set(['mvhd', 'tkhd', 'mdhd'])
/* Apple QuickTime metadata key that carries a creation date with a UTC offset. */
const CREATION_KEY = 'com.apple.quicktime.creationdate'

interface Box {
  type: string
  start: number
  /** Offset of the first byte after the box header. */
  payload: number
  end: number
}

function readBox(buf: Buffer, offset: number, limit: number): Box | undefined {
  if (offset + 8 > limit) return undefined
  let size = buf.readUInt32BE(offset)
  const type = buf.toString('latin1', offset + 4, offset + 8)
  let headerLen = 8
  if (size === 1) {
    if (offset + 16 > limit) return undefined
    size = Number(buf.readBigUInt64BE(offset + 8))
    headerLen = 16
  } else if (size === 0) {
    size = limit - offset
  }
  if (size < headerLen) return undefined
  return { type, start: offset, payload: offset + headerLen, end: Math.min(offset + size, limit) }
}

function* boxes(buf: Buffer, start: number, limit: number): Generator<Box> {
  let offset = start
  while (offset < limit) {
    const box = readBox(buf, offset, limit)
    if (!box) return
    yield box
    offset = box.end
  }
}

/** Write creation_time and modification_time into an mvhd, tkhd or mdhd box. */
function patchHeader(buf: Buffer, box: Box, qtSeconds: bigint): void {
  const at = box.payload + 4 // skip version (1) + flags (3)
  if (buf[box.payload] === 1) {
    buf.writeBigUInt64BE(qtSeconds, at)
    buf.writeBigUInt64BE(qtSeconds, at + 8)
  } else {
    const v = Number(qtSeconds > 0xffffffffn ? 0xffffffffn : qtSeconds)
    buf.writeUInt32BE(v, at)
    buf.writeUInt32BE(v, at + 4)
  }
}

/** Shift every chunk offset (stco/co64) that points past `from` by `delta` bytes. */
function shiftChunkOffsets(buf: Buffer, box: Box, from: number, delta: number): void {
  const count = buf.readUInt32BE(box.payload + 4)
  let at = box.payload + 8
  for (let i = 0; i < count; i++) {
    if (box.type === 'stco') {
      const v = buf.readUInt32BE(at)
      if (v >= from) buf.writeUInt32BE(v + delta, at)
      at += 4
    } else {
      const v = buf.readBigUInt64BE(at)
      if (v >= BigInt(from)) buf.writeBigUInt64BE(v + BigInt(delta), at)
      at += 8
    }
  }
}

function walk(buf: Buffer, start: number, limit: number, visit: (box: Box) => void): void {
  for (const box of boxes(buf, start, limit)) {
    visit(box)
    if (CONTAINERS.has(box.type)) walk(buf, box.payload, box.end, visit)
  }
}

function box(type: string, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts)
  const hdr = Buffer.alloc(8)
  hdr.writeUInt32BE(8 + body.length, 0)
  hdr.write(type, 4, 'latin1')
  return Buffer.concat([hdr, body])
}

const u32 = (n: number) => {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(n, 0)
  return b
}

/** Values written into the Apple "Keys" metadata box. */
export interface Mp4Metadata {
  /** Local time with UTC offset, e.g. "2026-01-22T20:36:27+1300" (exiftool: CreationDate). */
  creationDate: string
  /** Free text (exiftool: Description). */
  description?: string
  /** ISO 6709 point, e.g. "-41.2865+174.7762/" (exiftool: GPSCoordinates). */
  location?: string
}

/**
 * Build a QuickTime "Keys" metadata box (moov/meta with an mdta handler) holding the given
 * com.apple.quicktime.* entries. Each key is listed once in `keys`; each `ilst` item refers to
 * its key by 1-based index and carries one UTF-8 `data` box.
 */
function buildKeysMeta(meta: Mp4Metadata): Buffer {
  const entries: [string, string][] = [[CREATION_KEY, meta.creationDate]]
  if (meta.description) entries.push(['com.apple.quicktime.description', meta.description])
  if (meta.location) entries.push(['com.apple.quicktime.location.ISO6709', meta.location])

  const hdlr = box('hdlr', u32(0), u32(0), Buffer.from('mdta', 'latin1'), Buffer.alloc(12), Buffer.from([0]))
  const keyParts = entries.map(([k]) => {
    const key = Buffer.from(k, 'latin1')
    return Buffer.concat([u32(8 + key.length), Buffer.from('mdta', 'latin1'), key])
  })
  const keys = box('keys', u32(0), u32(entries.length), ...keyParts)
  const items = entries.map(([, v], i) => {
    const data = box('data', u32(1), u32(0), Buffer.from(v, 'utf8')) // type 1 = UTF-8, locale 0
    return Buffer.concat([u32(8 + data.length), u32(i + 1), data])
  })
  const ilst = box('ilst', ...items)
  // Apple-style moov/meta has no version/flags field (unlike ISO udta/meta); exiftool relies on that.
  return box('meta', hdlr, keys, ilst)
}

/** Remove any moov-level meta box that carries our key, so re-stamping never duplicates it. */
function stripOurMeta(moov: Buffer): Buffer {
  const top = readBox(moov, 0, moov.length)
  if (!top) return moov
  const keep: Buffer[] = [moov.subarray(0, top.payload)]
  for (const child of boxes(moov, top.payload, moov.length)) {
    const ours = child.type === 'meta' && moov.subarray(child.start, child.end).includes(CREATION_KEY)
    if (!ours) keep.push(moov.subarray(child.start, child.end))
  }
  return Buffer.concat(keep)
}

function withSize(moovBody: Buffer, size: number): Buffer {
  const out = Buffer.from(moovBody)
  if (out.readUInt32BE(0) === 1) out.writeBigUInt64BE(BigInt(size), 8)
  else out.writeUInt32BE(size, 0)
  return out
}

/**
 * Stamp an MP4/MOV: creation_time/modification_time in every mvhd, tkhd and mdhd (UTC, the only
 * thing many readers look at) plus an Apple Keys box with the creation date carrying its UTC
 * offset (how Immich and exiftool learn the local zone), and optionally a description and a
 * location. The moov box changes size, so chunk offsets are shifted and the file is rewritten via
 * a temp file; a re-stamp with identical values is the same size and happens in place. Returns
 * false if the file has no moov box.
 */
export async function stampMp4Date(file: string, when: Date, meta: Mp4Metadata): Promise<boolean> {
  const qtSeconds = BigInt(Math.floor(when.getTime() / 1000)) + QT_EPOCH_OFFSET
  const fh = await open(file, 'r+')
  let moovStart = -1
  let oldMoov: Buffer | undefined
  let fileSize = 0
  try {
    fileSize = (await fh.stat()).size
    const hdr = Buffer.alloc(16)
    let offset = 0
    while (offset + 8 <= fileSize) {
      await fh.read(hdr, 0, 16, offset)
      const b = readBox(hdr, 0, 16)
      if (!b) break
      let size = hdr.readUInt32BE(0)
      if (size === 1) size = Number(hdr.readBigUInt64BE(8))
      else if (size === 0) size = fileSize - offset
      if (b.type === 'moov') {
        moovStart = offset
        oldMoov = Buffer.alloc(size)
        await fh.read(oldMoov, 0, size, offset)
        break
      }
      offset += size
    }
    if (!oldMoov) return false

    const stripped = stripOurMeta(oldMoov)
    const rebuilt = Buffer.concat([stripped, buildKeysMeta(meta)])
    const moov = withSize(rebuilt, rebuilt.length)
    const delta = moov.length - oldMoov.length
    const oldMoovEnd = moovStart + oldMoov.length
    walk(moov, 0, moov.length, b => {
      if (HEADERS.has(b.type)) patchHeader(moov, b, qtSeconds)
      else if (delta !== 0 && (b.type === 'stco' || b.type === 'co64')) shiftChunkOffsets(moov, b, oldMoovEnd, delta)
    })

    if (delta === 0) {
      await fh.write(moov, 0, moov.length, moovStart)
      return true
    }
    await fh.close()
    const tmp = file + '.tmp'
    const out = createWriteStream(tmp)
    await pipeline(createReadStream(file, { start: 0, end: moovStart - 1 }), out, { end: false })
    await new Promise<void>((res, rej) => out.write(moov, err => (err ? rej(err) : res())))
    await pipeline(createReadStream(file, { start: oldMoovEnd }), out)
    await rename(tmp, file)
    return true
  } finally {
    await fh.close().catch(() => {})
  }
}
