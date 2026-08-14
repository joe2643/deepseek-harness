import { Context } from '@deepseek-ai/cordis'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import LocalAttachmentStore, {
  DEFAULT_MAX_IMAGE_BYTES,
  DEFAULT_MAX_IMAGE_PIXELS,
  DEFAULT_MAX_IMAGES_PER_MESSAGE,
  DEFAULT_MAX_MESSAGE_IMAGE_BYTES,
  DEFAULT_MAX_MESSAGE_VIDEO_BYTES,
  DEFAULT_MAX_VIDEO_BYTES,
  DEFAULT_MAX_VIDEO_DURATION_SECONDS,
  DEFAULT_MAX_VIDEOS_PER_MESSAGE,
} from '../src/index.ts'

function u32(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]
}

function ascii(text: string): number[] {
  // Box types and brands are ASCII by specification, so a code-unit walk is
  // exact here; spreading the string would decompose nothing differently.
  return Array.from({ length: text.length }, (_unused, index) => text.charCodeAt(index))
}

function box(type: string, payload: number[]): number[] {
  return [...u32(payload.length + 8), ...ascii(type), ...payload]
}

/** One well-formed 640x480, 10s, 24fps ISO base media container. */
function mp4(): Uint8Array {
  const tkhd = box('tkhd', [...u32(0), ...new Array<number>(72).fill(0), ...u32(640 * 65536), ...u32(480 * 65536)])
  const hdlr = box('hdlr', [...u32(0), ...u32(0), ...ascii('vide')])
  const mdhd = box('mdhd', [...u32(0), ...u32(0), ...u32(0), ...u32(600), ...u32(6000), ...u32(0)])
  const stts = box('stts', [...u32(0), ...u32(1), ...u32(240), ...u32(1)])
  const mdia = box('mdia', [...hdlr, ...mdhd, ...box('minf', box('stbl', stts))])
  const ftyp = box('ftyp', [...ascii('isom'), ...u32(512), ...ascii('isomiso2')])
  return Uint8Array.from([...ftyp, ...box('moov', box('trak', [...tkhd, ...mdia]))])
}

describe('local attachment service', () => {
  it('resolves every omitted admission limit explicitly', () => {
    const service = new LocalAttachmentStore(new Context(), {})
    expect(DEFAULT_MAX_IMAGE_BYTES).toBe(5 * 1024 * 1024)
    expect(service.imageLimits).toEqual({
      maxImageBytes: DEFAULT_MAX_IMAGE_BYTES,
      maxImagesPerMessage: DEFAULT_MAX_IMAGES_PER_MESSAGE,
      maxMessageImageBytes: DEFAULT_MAX_MESSAGE_IMAGE_BYTES,
      maxImagePixels: DEFAULT_MAX_IMAGE_PIXELS,
      mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
    })
  })

  it('saves and reads through the service boundary', async () => {
    const dshHome = await mkdtemp(join(tmpdir(), 'dsh-attachment-service-'))
    try {
      const service = new LocalAttachmentStore(new Context(), { dshHome })
      const data = Uint8Array.from(Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        'base64',
      ))
      const ref = await service.saveImage({ data, mediaType: 'image/png' })
      await expect(service.readImage(ref)).resolves.toEqual({ ref, data })
    } finally {
      await rm(dshHome, { recursive: true, force: true })
    }
  })

  it('validates without persisting: a rejected image leaves no storage root behind', async () => {
    const dshHome = await mkdtemp(join(tmpdir(), 'dsh-attachment-validate-'))
    try {
      const service = new LocalAttachmentStore(new Context(), { dshHome })
      await expect(service.validateImage({ data: Uint8Array.of(1, 2, 3), mediaType: 'image/png' }))
        .rejects.toThrow(/Unsupported or malformed image data/)
      const valid = Uint8Array.from(Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        'base64',
      ))
      const limited = new LocalAttachmentStore(new Context(), { dshHome, maxImageBytes: 1 })
      await expect(limited.validateImage({ data: valid, mediaType: 'image/png' }))
        .rejects.toMatchObject({ code: 'IMAGE_TOO_LARGE' })
      await expect(service.validateImage({ data: valid, mediaType: 'image/png' })).resolves.toBeUndefined()
      expect(existsSync(service.root)).toBe(false)
    } finally {
      await rm(dshHome, { recursive: true, force: true })
    }
  })

  it('resolves every omitted video admission limit explicitly', () => {
    const service = new LocalAttachmentStore(new Context(), {})
    expect(DEFAULT_MAX_VIDEO_BYTES).toBe(64 * 1024 * 1024)
    expect(service.videoLimits).toEqual({
      maxVideoBytes: DEFAULT_MAX_VIDEO_BYTES,
      maxVideosPerMessage: DEFAULT_MAX_VIDEOS_PER_MESSAGE,
      maxMessageVideoBytes: DEFAULT_MAX_MESSAGE_VIDEO_BYTES,
      maxVideoDurationSeconds: DEFAULT_MAX_VIDEO_DURATION_SECONDS,
      mediaTypes: ['video/mp4', 'video/quicktime'],
    })
  })

  it('saves and reads a video through the service boundary', async () => {
    const dshHome = await mkdtemp(join(tmpdir(), 'dsh-video-service-'))
    try {
      const service = new LocalAttachmentStore(new Context(), { dshHome })
      const data = mp4()
      const ref = await service.saveVideo({ data, mediaType: 'video/mp4' })
      expect(ref).toMatchObject({ width: 640, height: 480, durationSeconds: 10, frameRate: 24 })
      await expect(service.readVideo(ref)).resolves.toEqual({ ref, data })
    } finally {
      await rm(dshHome, { recursive: true, force: true })
    }
  })

  it('validates a video without persisting it', async () => {
    const dshHome = await mkdtemp(join(tmpdir(), 'dsh-video-validate-'))
    try {
      const service = new LocalAttachmentStore(new Context(), { dshHome })
      await expect(service.validateVideo({ data: Uint8Array.of(1, 2, 3), mediaType: 'video/mp4' }))
        .rejects.toThrow(/Unsupported or malformed video data/)
      await expect(service.validateVideo({ data: mp4(), mediaType: 'video/mp4' })).resolves.toBeUndefined()
      expect(existsSync(service.root)).toBe(false)
    } finally {
      await rm(dshHome, { recursive: true, force: true })
    }
  })
})
