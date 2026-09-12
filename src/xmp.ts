import { readFile, writeFile } from 'node:fs/promises'

/*
Minimal XMP writer for JPEGs. XMP lives in an APP1 segment that starts with this namespace
header; everything after it is an XML packet. Used for dc:description, which readers such as
Immich and exiftool report as "Description". Unlike the EXIF ImageDescription field, XMP is
UTF-8, so macrons and emoji in story titles survive.
*/

const XMP_HEADER = Buffer.from('http://ns.adobe.com/xap/1.0/\0', 'latin1')
const SOI = 0xffd8
const APP1 = 0xffe1
const SOS = 0xffda

function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c] as string)
}

function buildPacket(description: string): Buffer {
  const xml =
    '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>' +
    '<x:xmpmeta xmlns:x="adobe:ns:meta/">' +
    '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
    '<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">' +
    `<dc:description><rdf:Alt><rdf:li xml:lang="x-default">${escapeXml(description)}</rdf:li></rdf:Alt></dc:description>` +
    '</rdf:Description></rdf:RDF></x:xmpmeta>' +
    '<?xpacket end="w"?>'
  const body = Buffer.concat([XMP_HEADER, Buffer.from(xml, 'utf8')])
  if (body.length + 2 > 0xffff) throw new Error('XMP packet too large for one APP1 segment')
  const seg = Buffer.alloc(4)
  seg.writeUInt16BE(APP1, 0)
  seg.writeUInt16BE(body.length + 2, 2)
  return Buffer.concat([seg, body])
}

/**
 * Replace (or add) the XMP packet in a JPEG so that dc:description equals `description`.
 * The new segment goes after any existing APP1 EXIF segment, as the spec recommends.
 * Returns false when the file is not a JPEG.
 */
export async function writeXmpDescription(file: string, description: string): Promise<boolean> {
  const buf = await readFile(file)
  if (buf.length < 4 || buf.readUInt16BE(0) !== SOI) return false

  const parts: Buffer[] = [buf.subarray(0, 2)]
  let insertAt = 1 // index in `parts` after which the XMP segment is inserted
  let pos = 2
  while (pos + 4 <= buf.length) {
    const marker = buf.readUInt16BE(pos)
    if (marker === SOS || (marker & 0xff00) !== 0xff00) break
    const len = buf.readUInt16BE(pos + 2)
    const seg = buf.subarray(pos, pos + 2 + len)
    const isXmp = marker === APP1 && seg.subarray(4, 4 + XMP_HEADER.length).equals(XMP_HEADER)
    if (!isXmp) {
      parts.push(seg)
      if (marker === APP1) insertAt = parts.length // after EXIF
    }
    pos += 2 + len
  }
  parts.splice(insertAt, 0, buildPacket(description))
  parts.push(buf.subarray(pos))
  await writeFile(file, Buffer.concat(parts))
  return true
}
