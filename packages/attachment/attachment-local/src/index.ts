/** Local durable attachment backend rooted below `DSH_HOME`. @module @deepseek-ai/dsh-attachment-local */

import { join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type {
  ImageAttachmentLimits,
  ImageAttachmentRef,
  SaveImageAttachment,
  SaveVideoAttachment,
  StoredImageAttachment,
  StoredVideoAttachment,
  VideoAttachmentLimits,
  VideoAttachmentRef,
} from '@deepseek-ai/dsh-attachment'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { readImageFile, readVideoFile, saveImageFile, saveVideoFile, validateImageFile, validateVideoFile } from './store.ts'

export { detectImage } from './image.ts'
export { probeVideo } from './video.ts'
export { readImageFile, readVideoFile, saveImageFile, saveVideoFile, validateImageFile, validateVideoFile } from './store.ts'

/** Default maximum encoded bytes for one image. */
export const DEFAULT_MAX_IMAGE_BYTES = 5 * 1024 * 1024
/** Default maximum images in one prompt. */
export const DEFAULT_MAX_IMAGES_PER_MESSAGE = 20
/** Default maximum aggregate image bytes in one prompt. */
export const DEFAULT_MAX_MESSAGE_IMAGE_BYTES = 100 * 1024 * 1024
/** Default maximum intrinsic pixels for one image. */
export const DEFAULT_MAX_IMAGE_PIXELS = 40_000_000
/** Default maximum encoded bytes for one video. */
export const DEFAULT_MAX_VIDEO_BYTES = 64 * 1024 * 1024
/** Default maximum videos in one prompt. */
export const DEFAULT_MAX_VIDEOS_PER_MESSAGE = 4
/** Default maximum aggregate video bytes in one prompt. */
export const DEFAULT_MAX_MESSAGE_VIDEO_BYTES = 128 * 1024 * 1024
/** Default maximum container duration for one video, in seconds. */
export const DEFAULT_MAX_VIDEO_DURATION_SECONDS = 600

/** Local attachment backend configuration. */
export interface Config {
  /** Explicit harness home; omitted follows `DSH_HOME`, then `~/.dsh`. */
  dshHome?: string
  /** Maximum encoded bytes accepted for one image. */
  maxImageBytes?: number
  /** Maximum image count accepted in one submitted message. */
  maxImagesPerMessage?: number
  /** Maximum aggregate encoded image bytes accepted in one submitted message. */
  maxMessageImageBytes?: number
  /** Maximum intrinsic width multiplied by height accepted for one image. */
  maxImagePixels?: number
  /** Maximum encoded bytes accepted for one video. */
  maxVideoBytes?: number
  /** Maximum video count accepted in one submitted message. */
  maxVideosPerMessage?: number
  /** Maximum aggregate encoded video bytes accepted in one submitted message. */
  maxMessageVideoBytes?: number
  /** Maximum container duration in seconds accepted for one video. */
  maxVideoDurationSeconds?: number
}

/** Persistent content-addressed local attachment store. */
export class LocalAttachmentStore extends AttachmentStore {
  static Config: z<Config> = z.object({
    dshHome: z.string(),
    maxImageBytes: z.number().step(1).min(1).default(DEFAULT_MAX_IMAGE_BYTES),
    maxImagesPerMessage: z.number().step(1).min(1).default(DEFAULT_MAX_IMAGES_PER_MESSAGE),
    maxMessageImageBytes: z.number().step(1).min(1).default(DEFAULT_MAX_MESSAGE_IMAGE_BYTES),
    maxImagePixels: z.number().step(1).min(1).default(DEFAULT_MAX_IMAGE_PIXELS),
    maxVideoBytes: z.number().step(1).min(1).default(DEFAULT_MAX_VIDEO_BYTES),
    maxVideosPerMessage: z.number().step(1).min(1).default(DEFAULT_MAX_VIDEOS_PER_MESSAGE),
    maxMessageVideoBytes: z.number().step(1).min(1).default(DEFAULT_MAX_MESSAGE_VIDEO_BYTES),
    maxVideoDurationSeconds: z.number().min(Number.MIN_VALUE).default(DEFAULT_MAX_VIDEO_DURATION_SECONDS),
  })

  /** Absolute versioned storage root. */
  readonly root: string
  readonly imageLimits: ImageAttachmentLimits
  readonly videoLimits: VideoAttachmentLimits

  constructor(ctx: Context, config: Config) {
    super(ctx)
    this.root = resolve(join(resolveDshHome(config.dshHome), 'attachments', 'v1'))
    this.imageLimits = Object.freeze({
      maxImageBytes: config.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES,
      maxImagesPerMessage: config.maxImagesPerMessage ?? DEFAULT_MAX_IMAGES_PER_MESSAGE,
      maxMessageImageBytes: config.maxMessageImageBytes ?? DEFAULT_MAX_MESSAGE_IMAGE_BYTES,
      maxImagePixels: config.maxImagePixels ?? DEFAULT_MAX_IMAGE_PIXELS,
      mediaTypes: Object.freeze(['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const),
    })
    this.videoLimits = Object.freeze({
      maxVideoBytes: config.maxVideoBytes ?? DEFAULT_MAX_VIDEO_BYTES,
      maxVideosPerMessage: config.maxVideosPerMessage ?? DEFAULT_MAX_VIDEOS_PER_MESSAGE,
      maxMessageVideoBytes: config.maxMessageVideoBytes ?? DEFAULT_MAX_MESSAGE_VIDEO_BYTES,
      maxVideoDurationSeconds: config.maxVideoDurationSeconds ?? DEFAULT_MAX_VIDEO_DURATION_SECONDS,
      mediaTypes: Object.freeze(['video/mp4', 'video/quicktime'] as const),
    })
  }

  async validateImage(input: SaveImageAttachment): Promise<void> {
    await validateImageFile(input, this.imageLimits)
  }

  async saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef> {
    return saveImageFile(this.root, input, this.imageLimits)
  }

  async readImage(ref: ImageAttachmentRef, signal?: AbortSignal): Promise<StoredImageAttachment> {
    return readImageFile(this.root, ref, signal)
  }

  async validateVideo(input: SaveVideoAttachment): Promise<void> {
    await validateVideoFile(input, this.videoLimits)
  }

  async saveVideo(input: SaveVideoAttachment): Promise<VideoAttachmentRef> {
    return saveVideoFile(this.root, input, this.videoLimits)
  }

  async readVideo(ref: VideoAttachmentRef, signal?: AbortSignal): Promise<StoredVideoAttachment> {
    return readVideoFile(this.root, ref, signal)
  }
}

export default LocalAttachmentStore
