import { describe, expect, it } from 'vitest'
import { AttachmentError } from '@deepseek-ai/dsh-attachment'
import { probeVideo } from '../src/video.ts'

/**
 * Minimal ISO base media containers, assembled byte by byte.
 *
 * The probe reads structure, not pixels, so a synthetic box tree exercises it
 * exactly as a real recording does — and unlike a committed binary these
 * fixtures make each malformed case (a truncated header, an overrunning child,
 * a missing track) readable at the point it is asserted. `probeVideo` was
 * additionally validated against four real ffmpeg-produced clips whose
 * geometry, duration, and frame rate it reported identically to ffprobe.
 */

function u32(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]
}

function u64(value: number): number[] {
  return [...u32(Math.floor(value / 2 ** 32)), ...u32(value >>> 0)]
}

function ascii(text: string): number[] {
  // Box types and brands are ASCII by specification, so a code-unit walk is
  // exact here; spreading the string would decompose nothing differently.
  return Array.from({ length: text.length }, (_unused, index) => text.charCodeAt(index))
}

/** One box: `size(4) type(4) payload`. */
function box(type: string, payload: number[]): number[] {
  return [...u32(payload.length + 8), ...ascii(type), ...payload]
}

/** One 64-bit box: `1(4) type(4) largesize(8) payload`. */
function largeBox(type: string, payload: number[], declaredSize?: number): number[] {
  return [...u32(1), ...ascii(type), ...u64(declaredSize ?? payload.length + 16), ...payload]
}

function ftyp(brand = 'isom'): number[] {
  return box('ftyp', [...ascii(brand), ...u32(512), ...ascii('isomiso2')])
}

/** `tkhd` v0: 4 version/flags + 72 leading fields, then 16.16 width/height. */
function tkhd(width: number, height: number): number[] {
  return box('tkhd', [...u32(0), ...new Array<number>(72).fill(0), ...u32(width * 65536), ...u32(height * 65536)])
}

/** `tkhd` v1: the same layout with 64-bit times, pushing dimensions 12 bytes later. */
function tkhdV1(width: number, height: number): number[] {
  return box('tkhd', [
    ...u32(0x01000000), ...new Array<number>(84).fill(0),
    ...u32(width * 65536), ...u32(height * 65536),
  ])
}

function hdlr(handler: string): number[] {
  return box('hdlr', [...u32(0), ...u32(0), ...ascii(handler)])
}

/** `mdhd` v0: version/flags, creation, modification, timescale, duration. */
function mdhd(timescale: number, duration: number): number[] {
  return box('mdhd', [...u32(0), ...u32(0), ...u32(0), ...u32(timescale), ...u32(duration), ...u32(0)])
}

/** `mdhd` v1: 64-bit creation/modification and duration around a 32-bit timescale. */
function mdhdV1(timescale: number, duration: number): number[] {
  return box('mdhd', [...u32(0x01000000), ...u64(0), ...u64(0), ...u32(timescale), ...u64(duration), ...u32(0)])
}

/** `stts` with one entry declaring `frames` samples. */
function stts(frames: number): number[] {
  return box('stts', [...u32(0), ...u32(1), ...u32(frames), ...u32(1)])
}

interface TrackParts {
  handler?: string
  header?: number[]
  media?: number[]
  sampleTable?: number[] | null
  minfPresent?: boolean
  mdhdPresent?: boolean
}

function trak(parts: TrackParts = {}): number[] {
  const {
    handler = 'vide',
    header = tkhd(640, 480),
    media = mdhd(600, 6000),
    sampleTable = stts(240),
    minfPresent = true,
    mdhdPresent = true,
  } = parts
  const stbl = sampleTable === null ? [] : box('stbl', sampleTable)
  const minf = minfPresent ? box('minf', stbl) : []
  const mdia = box('mdia', [...hdlr(handler), ...(mdhdPresent ? media : []), ...minf])
  return box('trak', [...header, ...mdia])
}

function mp4(tracks: number[][] = [trak()], brand = 'isom'): Uint8Array {
  return Uint8Array.from([...ftyp(brand), ...box('moov', tracks.flat())])
}

function expectFailure(data: Uint8Array, fragment: string): void {
  expect(() => probeVideo(data)).toThrow(AttachmentError)
  expect(() => probeVideo(data)).toThrow(fragment)
}

describe('probeVideo', () => {
  it('reports geometry, duration and frame rate from a well-formed container', () => {
    expect(probeVideo(mp4())).toEqual({
      mediaType: 'video/mp4',
      width: 640,
      height: 480,
      durationSeconds: 10,
      frameRate: 24,
    })
  })

  it('maps the QuickTime brand onto its own media type', () => {
    expect(probeVideo(mp4([trak()], 'qt  ')).mediaType).toBe('video/quicktime')
  })

  it('reads 64-bit track and media headers', () => {
    const detected = probeVideo(mp4([trak({ header: tkhdV1(1920, 1080), media: mdhdV1(1000, 5000) })]))
    expect(detected).toMatchObject({ width: 1920, height: 1080, durationSeconds: 5 })
  })

  it('skips a non-video track and selects the video one', () => {
    const audio = trak({ handler: 'soun', header: tkhd(0, 0) })
    expect(probeVideo(mp4([audio, trak()])).width).toBe(640)
  })

  it('skips a track whose mdia or tkhd is absent', () => {
    const headerless = box('trak', box('mdia', hdlr('vide')))
    expect(probeVideo(mp4([headerless, trak()])).width).toBe(640)
  })

  it('skips a track whose handler box is truncated', () => {
    const shortHandler = box('trak', [...tkhd(1, 1), ...box('mdia', box('hdlr', u32(0)))])
    expect(probeVideo(mp4([shortHandler, trak()])).width).toBe(640)
  })

  it('reports zero frame rate for a zero-duration container', () => {
    expect(probeVideo(mp4([trak({ media: mdhd(600, 0) })])).frameRate).toBe(0)
  })

  it('sums every stts entry', () => {
    const twoEntries = box('stts', [...u32(0), ...u32(2), ...u32(100), ...u32(1), ...u32(140), ...u32(1)])
    expect(probeVideo(mp4([trak({ sampleTable: twoEntries })])).frameRate).toBe(24)
  })

  it('accepts a 64-bit box header', () => {
    const data = Uint8Array.from([...ftyp(), ...largeBox('moov', trak())])
    expect(probeVideo(data).width).toBe(640)
  })

  it('treats a zero-size box as extending to the end of its parent', () => {
    const trailing = [...u32(0), ...ascii('free')]
    const data = Uint8Array.from([...ftyp(), ...box('moov', trak()), ...trailing])
    expect(probeVideo(data).width).toBe(640)
  })

  it.each([
    ['shorter than one box header', Uint8Array.of(1, 2, 3)],
    ['no ftyp box', Uint8Array.from(box('moov', trak()))],
    ['no moov box', Uint8Array.from(ftyp())],
    ['no video track', Uint8Array.from([...ftyp(), ...box('moov', trak({ handler: 'soun' }))])],
    ['ftyp box carries no major brand', Uint8Array.from([...box('ftyp', []), ...box('moov', trak())])],
  ])('refuses a container with %s', (fragment, data) => {
    expectFailure(data, fragment)
  })

  it('refuses a video track without an mdhd box', () => {
    expectFailure(mp4([trak({ mdhdPresent: false })]), 'no mdhd box')
  })

  it('refuses a video track without a minf box', () => {
    expectFailure(mp4([trak({ minfPresent: false })]), 'no minf box')
  })

  it('refuses a video track without an stbl box', () => {
    expectFailure(mp4([trak({ sampleTable: null })]), 'no stbl box')
  })

  it('refuses a video track without an stts box', () => {
    expectFailure(mp4([trak({ sampleTable: [] })]), 'no stts box')
  })

  it('refuses a zero media timescale', () => {
    expectFailure(mp4([trak({ media: mdhd(0, 100) })]), 'media timescale is zero')
  })

  it('refuses a track declaring no dimensions', () => {
    expectFailure(mp4([trak({ header: tkhd(0, 0) })]), 'has no dimensions')
  })

  it('refuses a truncated tkhd box', () => {
    expectFailure(mp4([trak({ header: box('tkhd', u32(0)) })]), 'tkhd box is truncated')
  })

  it.each([
    ['v0', box('mdhd', u32(0))],
    ['v1', box('mdhd', [...u32(0x01000000), ...u32(0)])],
  ])('refuses a truncated %s mdhd box', (_version, media) => {
    expectFailure(mp4([trak({ media })]), 'mdhd box is truncated')
  })

  it('refuses a truncated stts box', () => {
    expectFailure(mp4([trak({ sampleTable: box('stts', u32(0)) })]), 'stts box is truncated')
  })

  it('refuses an stts entry table that overruns its box', () => {
    const lying = box('stts', [...u32(0), ...u32(4), ...u32(1), ...u32(1)])
    expectFailure(mp4([trak({ sampleTable: lying })]), 'stts entry table overruns')
  })

  it('refuses a box whose size overruns its parent', () => {
    const overrun = Uint8Array.from([...ftyp(), ...u32(4096), ...ascii('moov')])
    expectFailure(overrun, 'overruns its parent')
  })

  it('refuses a truncated 64-bit box header', () => {
    const data = Uint8Array.from([...ftyp(), ...u32(1), ...ascii('moov'), ...u32(0)])
    expectFailure(data, 'truncated 64-bit box header')
  })

  it('refuses a 64-bit box size beyond the addressable range', () => {
    const huge = [...u32(1), ...ascii('moov'), ...u32(0xffffffff), ...u32(0xffffffff)]
    expectFailure(Uint8Array.from([...ftyp(), ...huge]), 'exceeds addressable range')
  })
})
