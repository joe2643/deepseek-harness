/** Durable attachment vocabulary. @module @deepseek-ai/dsh-attachment/types */

import type { AttachmentId } from './brand.ts'

export type { AttachmentId } from './brand.ts'

/** Raster image formats accepted by the version-one attachment path. */
export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'

/** Durable, serializable metadata for one immutable image object. */
export interface ImageAttachmentRef {
  /** Opaque storage identifier; never a filesystem path or bearer URL. */
  attachmentId: AttachmentId
  /** Media type verified from the stored bytes. */
  mediaType: ImageMediaType
  /** Exact encoded byte length. */
  bytes: number
  /** Intrinsic encoded width in pixels. */
  width: number
  /** Intrinsic encoded height in pixels. */
  height: number
  /** Optional display name stripped of local path information. */
  name?: string
}

/** Deployment-resolved limits used by upload admission and request buffering. */
export interface ImageAttachmentLimits {
  maxImageBytes: number
  maxImagesPerMessage: number
  maxMessageImageBytes: number
  maxImagePixels: number
  mediaTypes: readonly ImageMediaType[]
}

/** Request to validate and durably commit one image. */
export interface SaveImageAttachment {
  data: Uint8Array
  /** Caller-declared media type, checked against fully decoded bytes. */
  mediaType: ImageMediaType
  /** Optional browser/provider display name; it is never interpreted as a path. */
  name?: string
}

/** Stored image bytes returned after reference and digest verification. */
export interface StoredImageAttachment {
  ref: ImageAttachmentRef
  data: Uint8Array
}

/**
 * Container formats accepted by the video attachment path.
 *
 * Deliberately narrower than the image set: both members are ISO base media
 * containers, so admission verifies geometry and timing from the stored bytes
 * with one parser instead of trusting the caller's declaration. Matroska
 * (`video/webm`) needs an unrelated EBML reader and is therefore not accepted
 * yet — an unsupported container is refused at admission rather than stored
 * with unverified metadata.
 */
export type VideoMediaType = 'video/mp4' | 'video/quicktime'

/** Durable, serializable metadata for one immutable video object. */
export interface VideoAttachmentRef {
  /** Opaque storage identifier; never a filesystem path or bearer URL. */
  attachmentId: AttachmentId
  /** Media type verified from the stored bytes. */
  mediaType: VideoMediaType
  /** Exact encoded byte length. */
  bytes: number
  /** Intrinsic encoded width in pixels. */
  width: number
  /** Intrinsic encoded height in pixels. */
  height: number
  /** Container duration in seconds. */
  durationSeconds: number
  /** Nominal frame rate, frames per second. */
  frameRate: number
  /** Optional display name stripped of local path information. */
  name?: string
}

/**
 * Deployment-resolved limits for video admission.
 *
 * Duration and frame count are limited beside raw bytes because a provider
 * bills and samples by decoded frames: a short high-rate clip and a long
 * low-rate one can carry the same byte count and cost very different amounts.
 */
export interface VideoAttachmentLimits {
  maxVideoBytes: number
  maxVideosPerMessage: number
  maxMessageVideoBytes: number
  maxVideoDurationSeconds: number
  mediaTypes: readonly VideoMediaType[]
}

/** Request to validate and durably commit one video. */
export interface SaveVideoAttachment {
  data: Uint8Array
  /** Caller-declared media type, checked against the probed container. */
  mediaType: VideoMediaType
  /** Optional browser/provider display name; it is never interpreted as a path. */
  name?: string
}

/** Stored video bytes returned after reference and digest verification. */
export interface StoredVideoAttachment {
  ref: VideoAttachmentRef
  data: Uint8Array
}
