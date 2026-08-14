/**
 * ISO base media (MP4 / QuickTime) inspection: container geometry and timing
 * read from the box tree at admission, and re-derived on verified reads.
 *
 * This parser is deliberately structural rather than a decode. It walks only
 * the boxes that carry the reference fields — `ftyp` for the brand, and the
 * first video `trak`'s `tkhd`/`mdhd`/`stts` for geometry, duration and frame
 * rate — and refuses anything it cannot read. No frame is ever decoded, so a
 * hostile file cannot amplify admission into arbitrary work: the cost is
 * bounded by the header, not by the payload.
 */

import { AttachmentError } from '@deepseek-ai/dsh-attachment'
import type { VideoMediaType } from '@deepseek-ai/dsh-attachment'

/** Probed metadata from a supported video container. */
export interface DetectedVideo {
  mediaType: VideoMediaType
  width: number
  height: number
  durationSeconds: number
  frameRate: number
}

/** QuickTime-only brands; every other ISO brand reports as MP4. */
const QUICKTIME_BRANDS = new Set(['qt  '])

/** Largest box header the walker will trust before declaring the tree malformed. */
const MIN_BOX_HEADER = 8

interface Box {
  type: string
  start: number
  end: number
}

function fail(reason: string): never {
  throw new AttachmentError(`Unsupported or malformed video data: ${reason}.`, 'INVALID_VIDEO')
}

/**
 * Enumerate the boxes directly inside one byte range.
 *
 * A zero-size box means "extends to the end of the parent" and a size below
 * the header length is corrupt; both are terminal, because continuing would
 * loop forever on the same offset.
 */
function boxes(view: DataView, start: number, end: number): Box[] {
  const found: Box[] = []
  let offset = start
  while (offset + MIN_BOX_HEADER <= end) {
    let size = view.getUint32(offset)
    const type = String.fromCharCode(
      view.getUint8(offset + 4),
      view.getUint8(offset + 5),
      view.getUint8(offset + 6),
      view.getUint8(offset + 7),
    )
    let header = MIN_BOX_HEADER
    if (size === 1) {
      if (offset + 16 > end) fail('truncated 64-bit box header')
      const large = view.getBigUint64(offset + 8)
      if (large > BigInt(Number.MAX_SAFE_INTEGER)) fail('box size exceeds addressable range')
      size = Number(large)
      header = 16
    } else if (size === 0) {
      size = end - offset
    }
    if (size < header || offset + size > end) fail(`box "${type}" overruns its parent`)
    found.push({ type, start: offset + header, end: offset + size })
    offset += size
  }
  return found
}

function findBox(list: readonly Box[], type: string): Box | undefined {
  return list.find(box => box.type === type)
}

/** Read the brand from `ftyp` and map it onto an accepted media type. */
function brandMediaType(view: DataView, ftyp: Box): VideoMediaType {
  if (ftyp.start + 4 > ftyp.end) fail('ftyp box carries no major brand')
  const brand = String.fromCharCode(
    view.getUint8(ftyp.start),
    view.getUint8(ftyp.start + 1),
    view.getUint8(ftyp.start + 2),
    view.getUint8(ftyp.start + 3),
  )
  return QUICKTIME_BRANDS.has(brand) ? 'video/quicktime' : 'video/mp4'
}

/**
 * Intrinsic display geometry from a track header, honouring its version.
 *
 * Offsets are measured from the box BODY (after the 8- or 16-byte box header
 * the walker already consumed): 76 for v0, and 88 for v1, which widens
 * creation/modification/duration from 32 to 64 bits and pushes the trailing
 * fields 12 bytes later. Verified against a real 432x576 clip.
 */
function trackGeometry(view: DataView, tkhd: Box): { width: number; height: number } {
  const version = view.getUint8(tkhd.start)
  const widthOffset = tkhd.start + (version === 1 ? 88 : 76)
  if (widthOffset + 8 > tkhd.end) fail('tkhd box is truncated before its dimensions')
  // 16.16 fixed point.
  const width = view.getUint32(widthOffset) / 65536
  const height = view.getUint32(widthOffset + 4) / 65536
  return { width: Math.round(width), height: Math.round(height) }
}

/** Timescale and duration from a media header, honouring its version. */
function mediaTiming(view: DataView, mdhd: Box): { timescale: number; duration: number } {
  const version = view.getUint8(mdhd.start)
  if (version === 1) {
    if (mdhd.start + 28 > mdhd.end) fail('mdhd box is truncated')
    const timescale = view.getUint32(mdhd.start + 20)
    const duration = Number(view.getBigUint64(mdhd.start + 24))
    return { timescale, duration }
  }
  if (mdhd.start + 20 > mdhd.end) fail('mdhd box is truncated')
  return { timescale: view.getUint32(mdhd.start + 12), duration: view.getUint32(mdhd.start + 16) }
}

/** Total decoding-time samples from a time-to-sample table. */
function sampleCount(view: DataView, stts: Box): number {
  if (stts.start + 8 > stts.end) fail('stts box is truncated')
  const entries = view.getUint32(stts.start + 4)
  let total = 0
  for (let index = 0; index < entries; index += 1) {
    const entry = stts.start + 8 + index * 8
    if (entry + 8 > stts.end) fail('stts entry table overruns its box')
    total += view.getUint32(entry)
  }
  return total
}

/** The first `trak` whose handler declares video media. */
function videoTrack(view: DataView, moov: Box): { mdia: Box; tkhd: Box } {
  for (const trak of boxes(view, moov.start, moov.end).filter(box => box.type === 'trak')) {
    const children = boxes(view, trak.start, trak.end)
    const mdia = findBox(children, 'mdia')
    const tkhd = findBox(children, 'tkhd')
    if (mdia === undefined || tkhd === undefined) continue
    const hdlr = findBox(boxes(view, mdia.start, mdia.end), 'hdlr')
    if (hdlr === undefined || hdlr.start + 12 > hdlr.end) continue
    const handler = String.fromCharCode(
      view.getUint8(hdlr.start + 8),
      view.getUint8(hdlr.start + 9),
      view.getUint8(hdlr.start + 10),
      view.getUint8(hdlr.start + 11),
    )
    if (handler === 'vide') return { mdia, tkhd }
  }
  fail('no video track')
}

/**
 * Probe one ISO base media container and return its intrinsic metadata.
 * @param data - complete encoded video bytes.
 * @returns verified container type, geometry, duration and frame rate.
 * @throws AttachmentError when the container is unreadable or carries no video track.
 */
export function probeVideo(data: Uint8Array): DetectedVideo {
  if (data.byteLength < MIN_BOX_HEADER) fail('shorter than one box header')
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const top = boxes(view, 0, data.byteLength)
  const ftyp = findBox(top, 'ftyp')
  if (ftyp === undefined) fail('no ftyp box')
  const moov = findBox(top, 'moov')
  if (moov === undefined) fail('no moov box')

  const { mdia, tkhd } = videoTrack(view, moov)
  const mdiaChildren = boxes(view, mdia.start, mdia.end)
  const mdhd = findBox(mdiaChildren, 'mdhd')
  if (mdhd === undefined) fail('video track has no mdhd box')
  const minf = findBox(mdiaChildren, 'minf')
  if (minf === undefined) fail('video track has no minf box')
  const stbl = findBox(boxes(view, minf.start, minf.end), 'stbl')
  if (stbl === undefined) fail('video track has no stbl box')
  const stts = findBox(boxes(view, stbl.start, stbl.end), 'stts')
  if (stts === undefined) fail('video track has no stts box')

  const { timescale, duration } = mediaTiming(view, mdhd)
  if (timescale === 0) fail('media timescale is zero')
  const durationSeconds = duration / timescale
  const frames = sampleCount(view, stts)
  const { width, height } = trackGeometry(view, tkhd)
  if (width === 0 || height === 0) fail('video track has no dimensions')

  return {
    mediaType: brandMediaType(view, ftyp),
    width,
    height,
    durationSeconds,
    frameRate: durationSeconds > 0 ? frames / durationSeconds : 0,
  }
}
