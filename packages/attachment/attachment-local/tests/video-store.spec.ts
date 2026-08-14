import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AttachmentError, AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { VideoAttachmentLimits, VideoAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { readVideoFile, saveVideoFile, validateVideoFile } from '../src/store.ts'

/**
 * The video half of the local store. Admission, publication and verified reads
 * are exercised on a synthetic ISO base media container, so the suite asserts
 * storage behaviour rather than a codec's output; `video.spec.ts` owns the
 * container parser itself.
 */

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

/** One well-formed 640x480, 10s, 24fps container. */
function container(brand = 'isom', width = 640, height = 480, duration = 6000): Uint8Array {
  const tkhd = box('tkhd', [...u32(0), ...new Array<number>(72).fill(0), ...u32(width * 65536), ...u32(height * 65536)])
  const hdlr = box('hdlr', [...u32(0), ...u32(0), ...ascii('vide')])
  const mdhd = box('mdhd', [...u32(0), ...u32(0), ...u32(0), ...u32(600), ...u32(duration), ...u32(0)])
  const stts = box('stts', [...u32(0), ...u32(1), ...u32(240), ...u32(1)])
  const mdia = box('mdia', [...hdlr, ...mdhd, ...box('minf', box('stbl', stts))])
  const ftyp = box('ftyp', [...ascii(brand), ...u32(512), ...ascii('isomiso2')])
  return Uint8Array.from([...ftyp, ...box('moov', box('trak', [...tkhd, ...mdia]))])
}

const MP4 = container()

const LIMITS: VideoAttachmentLimits = {
  maxVideoBytes: 4096,
  maxVideosPerMessage: 2,
  maxMessageVideoBytes: 8192,
  maxVideoDurationSeconds: 60,
  mediaTypes: ['video/mp4', 'video/quicktime'],
}

const roots: string[] = []

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'dsh-video-attachment-'))
  roots.push(value)
  return join(value, 'attachments', 'v1')
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('local video attachment store', () => {
  it('publishes a content-addressed reference carrying geometry and timing', async () => {
    const ref = await saveVideoFile(await root(), { data: MP4, mediaType: 'video/mp4', name: 'clip.mp4' }, LIMITS)
    expect(ref).toEqual({
      attachmentId: AttachmentId(`sha256:${createHash('sha256').update(MP4).digest('hex')}`),
      mediaType: 'video/mp4',
      bytes: MP4.byteLength,
      width: 640,
      height: 480,
      durationSeconds: 10,
      frameRate: 24,
      name: 'clip.mp4',
    })
  })

  it('strips path information from a display name', async () => {
    const ref = await saveVideoFile(await root(), { data: MP4, mediaType: 'video/mp4', name: 'C:\\clips\\a.mp4' }, LIMITS)
    expect(ref.name).toBe('a.mp4')
  })

  it('omits the name when the caller supplies none', async () => {
    const ref = await saveVideoFile(await root(), { data: MP4, mediaType: 'video/mp4' }, LIMITS)
    expect(ref.name).toBeUndefined()
  })

  it('deduplicates identical bytes onto one object', async () => {
    const storageRoot = await root()
    const first = await saveVideoFile(storageRoot, { data: MP4, mediaType: 'video/mp4' }, LIMITS)
    const second = await saveVideoFile(storageRoot, { data: MP4, mediaType: 'video/mp4' }, LIMITS)
    expect(second.attachmentId).toBe(first.attachmentId)
  })

  it('reads back the exact bytes it published', async () => {
    const storageRoot = await root()
    const ref = await saveVideoFile(storageRoot, { data: MP4, mediaType: 'video/mp4' }, LIMITS)
    await expect(readVideoFile(storageRoot, ref)).resolves.toEqual({ ref, data: MP4 })
  })

  it('validates without publishing anything', async () => {
    await expect(validateVideoFile({ data: MP4, mediaType: 'video/mp4' }, LIMITS)).resolves.toBeUndefined()
  })

  it.each([
    ['validate', validateVideoFile],
  ])('refuses an oversized video at %s', async (_label, run) => {
    const limits: VideoAttachmentLimits = { ...LIMITS, maxVideoBytes: 4 }
    await expect(run({ data: MP4, mediaType: 'video/mp4' }, limits)).rejects.toThrow('exceeds the configured byte limit')
  })

  it('refuses an oversized video at save', async () => {
    const limits: VideoAttachmentLimits = { ...LIMITS, maxVideoBytes: 4 }
    await expect(saveVideoFile(await root(), { data: MP4, mediaType: 'video/mp4' }, limits))
      .rejects.toThrow('exceeds the configured byte limit')
  })

  it('refuses an empty video', async () => {
    await expect(saveVideoFile(await root(), { data: new Uint8Array(0), mediaType: 'video/mp4' }, LIMITS))
      .rejects.toThrow('Video is empty')
  })

  it('refuses a declared type that contradicts the container', async () => {
    await expect(saveVideoFile(await root(), { data: MP4, mediaType: 'video/quicktime' }, LIMITS))
      .rejects.toThrow('Declared video type does not match its bytes')
  })

  it('refuses a video longer than the configured duration', async () => {
    const limits: VideoAttachmentLimits = { ...LIMITS, maxVideoDurationSeconds: 1 }
    await expect(saveVideoFile(await root(), { data: MP4, mediaType: 'video/mp4' }, limits))
      .rejects.toThrow('exceeds the configured duration limit')
  })

  it('refuses a malformed attachment reference', async () => {
    const ref = { attachmentId: AttachmentId('not-a-digest'), mediaType: 'video/mp4', bytes: 1, width: 1, height: 1, durationSeconds: 1, frameRate: 1 } satisfies VideoAttachmentRef
    await expect(readVideoFile(await root(), ref)).rejects.toThrow(AttachmentError)
  })

  it('reports a missing object distinctly from a read failure', async () => {
    const ref = {
      attachmentId: AttachmentId(`sha256:${'b'.repeat(64)}`),
      mediaType: 'video/mp4', bytes: 1, width: 1, height: 1, durationSeconds: 1, frameRate: 1,
    } satisfies VideoAttachmentRef
    await expect(readVideoFile(await root(), ref)).rejects.toThrow('Attachment object is missing')
  })

  it('rejects an aborted read before touching storage', async () => {
    const storageRoot = await root()
    const ref = await saveVideoFile(storageRoot, { data: MP4, mediaType: 'video/mp4' }, LIMITS)
    await expect(readVideoFile(storageRoot, ref, AbortSignal.abort())).rejects.toThrow()
  })

  it('detects bytes that no longer digest to their reference', async () => {
    const storageRoot = await root()
    const ref = await saveVideoFile(storageRoot, { data: MP4, mediaType: 'video/mp4' }, LIMITS)
    const digest = String(ref.attachmentId).slice('sha256:'.length)
    await writeFile(join(storageRoot, 'objects', digest.slice(0, 2), digest), Buffer.from(container('isom', 320, 240)))
    await expect(readVideoFile(storageRoot, ref)).rejects.toThrow('failed integrity verification')
  })

  it('reports an unreadable object as a read failure', async () => {
    // A directory where the object belongs makes readFile fail with EISDIR,
    // which is the non-ENOENT branch of the read path.
    const storageRoot = await root()
    const digest = createHash('sha256').update(MP4).digest('hex')
    await mkdir(join(storageRoot, 'objects', digest.slice(0, 2), digest), { recursive: true })
    const ref = {
      attachmentId: AttachmentId(`sha256:${digest}`),
      mediaType: 'video/mp4', bytes: MP4.byteLength, width: 640, height: 480, durationSeconds: 10, frameRate: 24,
    } satisfies VideoAttachmentRef
    await expect(readVideoFile(storageRoot, ref)).rejects.toMatchObject({ code: 'ATTACHMENT_READ_FAILED' })
  })

  it('detects stored metadata that contradicts its reference', async () => {
    const storageRoot = await root()
    const ref = await saveVideoFile(storageRoot, { data: MP4, mediaType: 'video/mp4' }, LIMITS)
    const drifted: VideoAttachmentRef = { ...ref, width: 1 }
    await expect(readVideoFile(storageRoot, drifted)).rejects.toThrow('does not match its reference')
  })
})
