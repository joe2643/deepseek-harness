/**
 * `view_video`: sample a video into labelled contact-sheet image(s) that enter
 * model context as ordinary `image` content blocks.
 *
 * This tool exists BESIDE native video input, not instead of it. A provider
 * that accepts a `VideoBlock` decides its own frame sampling, and that rate is
 * neither reported nor controllable — measured on one OpenAI-compatible
 * gateway, a 5s/120-frame clip billed 1262 video tokens, i.e. roughly five
 * frames. Against known ground truth (two 6-frame blinks and a 7-pulse mouth
 * flutter) the model answered "one blink" and "the mouth never opens", because
 * both events lived entirely between the provider's samples.
 *
 * Choosing the frame stride is therefore the whole point: the caller picks a
 * window and a count, and can reach stride 1 (every frame) to inspect an event
 * shorter than a provider sample interval. The sheet is a deterministic
 * function of that choice, and every tile is captioned with its true source
 * frame number so a finding can cite one.
 *
 * @module @deepseek-ai/dsh-tool-view-video
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { VideoAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { locateVideo } from './locate.ts'
import { probeVideo, renderSheet } from './ffmpeg.ts'
import { planSampling, summarize } from './plan.ts'
import type { SheetPlan, VideoFacts } from './plan.ts'

export const name = 'tool-view-video'
export const inject = ['tools', 'attachments', 'fs', 'subprocess']

/** Deployment-owned limits for one rendered contact sheet. */
export interface Config {
  /** Largest sheet this deployment will hand to the attachment service. */
  maxSheetBytes?: number
  /** mjpeg quality scale, 2 (best) to 31 (worst). */
  jpegQuality?: number
  /** Wall-clock cap for one ffmpeg render. */
  renderTimeoutMs?: number
}

/** The canonical result of one `view_video` call. */
interface ViewVideoValue {
  path: string
  video: VideoFacts
  sampling: {
    start: number
    end: number
    stride: number
    count: number
    cols: number
    rows: number
    picked: number[]
  }
  sheet: {
    attachmentId: string
    mediaType: string
    bytes: number
    width: number
    height: number
    name?: string
  }
}

/** Model-facing content: the sampling report plus the sheet itself. */
function viewVideoContent(value: ViewVideoValue): ContentBlock[] {
  return [
    { type: 'text', text: summarize(value.path, value.video, value.sampling) },
    {
      type: 'image',
      attachment: {
        attachmentId: value.sheet.attachmentId,
        mediaType: value.sheet.mediaType,
        bytes: value.sheet.bytes,
        width: value.sheet.width,
        height: value.sheet.height,
        ...value.sheet.name === undefined ? {} : { name: value.sheet.name },
      },
    } as ContentBlock,
  ]
}

/** Schemastery configuration for the contact-sheet renderer. */
export const Config: z<Config> = z.object({
  maxSheetBytes: z.number().step(1).min(1).default(3 * 1024 * 1024),
  jpegQuality: z.number().step(1).min(2).max(31).default(4),
  renderTimeoutMs: z.number().step(1).min(1).default(180_000),
})

/**
 * Register `view_video` into the calling scope.
 * @param ctx - registration scope; execution uses `fs`, `subprocess`, and `attachments`.
 * @param config - resolved deployment limits for one rendered sheet.
 */
export function apply(ctx: Context, config: Config): void {
  const maxSheetBytes = config.maxSheetBytes ?? 3 * 1024 * 1024
  const jpegQuality = config.jpegQuality ?? 4
  const renderTimeoutMs = config.renderTimeoutMs ?? 180_000

  ctx.tools.register(defineTool({
    name: 'view_video',
    description: 'Watch a video file by sampling it into labelled contact-sheet image(s) that'
      + ' enter context as real images. Every tile is captioned with its true source frame'
      + ' number and timestamp. Use start/end plus count to control the sampling rate: the'
      + ' default spreads count frames over the whole clip, while a narrow window with a high'
      + ' count reaches stride 1 (every frame), making sub-second events such as a 0.3s blink'
      + ' visible. Requires an image-capable model.',
    parameters: {
      file_path: { type: 'string', required: true, description: 'Absolute or workspace-relative path to the video file.' },
      count: { type: 'number', description: 'How many frames to sample, 1-64. Default 16.' },
      start: { type: 'number', description: 'Window start in seconds. Default 0.' },
      end: { type: 'number', description: 'Window end in seconds. Default: end of clip.' },
      columns: { type: 'number', description: 'Tiles per row, 1-8. Default 4.' },
      tile_width: { type: 'number', description: 'Pixel width per tile, 96-480. Default 216.' },
      label: { type: 'string', description: 'Optional short caption appended to every tile.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          video: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              width: { type: 'number', required: true },
              height: { type: 'number', required: true },
              codec: { type: 'string', required: true },
              fps: { type: 'number', required: true },
              duration: { type: 'number', required: true },
              frames: { type: 'number', required: true },
              bytes: { type: 'number', required: true },
            },
          },
          sampling: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              start: { type: 'number', required: true },
              end: { type: 'number', required: true },
              stride: { type: 'number', required: true },
              count: { type: 'number', required: true },
              cols: { type: 'number', required: true },
              rows: { type: 'number', required: true },
              picked: { type: 'array', required: true, items: { type: 'number' } },
            },
          },
          sheet: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              attachmentId: { type: 'string', required: true },
              mediaType: { type: 'string', required: true },
              bytes: { type: 'number', required: true },
              width: { type: 'number', required: true },
              height: { type: 'number', required: true },
              name: { type: 'string' },
            },
          },
        },
      },
      render: (_args, value) => viewVideoContent(value),
    },
    isConcurrencySafe: () => true,
    presentCall: (args: { file_path: string }) => ({
      card: 'generic' as const,
      title: `Watch video ${args.file_path}`,
      kind: 'read' as const,
      locations: [{ path: args.file_path }],
    }),
    async execute(args: {
      file_path: string
      count?: number
      start?: number
      end?: number
      columns?: number
      tile_width?: number
      label?: string
    }, exec: ToolRunContext) {
      const requested = args.file_path.trim()
      if (requested.length === 0) throw new Error('file_path must be a non-empty string')

      const limits = ctx.attachments.imageLimits
      if (!limits.mediaTypes.includes('image/jpeg')) {
        throw new Error('this deployment does not accept image/jpeg, which view_video uses for its sheets')
      }

      const { path, cwd } = await locateVideo(ctx, requested, exec)
      const video = await probeVideo(ctx, path, cwd, exec.signal)
      const plan: SheetPlan = planSampling(args, video)
      const byteCap = Math.min(maxSheetBytes, limits.maxImageBytes, limits.maxMessageImageBytes)
      const { data, rows } = await renderSheet(ctx, {
        path, cwd, plan, video, quality: jpegQuality, maxBytes: byteCap,
        timeoutMs: renderTimeoutMs, signal: exec.signal,
        ...args.label === undefined ? {} : { label: args.label },
      })

      // planSampling always admits at least the window's first frame.
      const [first] = plan.picked as [number, ...number[]]
      const last = plan.picked[plan.picked.length - 1]
      const leaf = path.slice(path.lastIndexOf('/') + 1)
      const ref = await ctx.attachments.saveImage({
        data,
        mediaType: 'image/jpeg',
        name: `${leaf} f${first}-f${last}.jpg`,
      })

      return {
        path,
        video,
        sampling: {
          start: plan.start,
          end: plan.end,
          stride: plan.stride,
          count: plan.picked.length,
          cols: plan.columns,
          rows,
          picked: plan.picked,
        },
        sheet: {
          attachmentId: String(ref.attachmentId),
          mediaType: ref.mediaType,
          bytes: ref.bytes,
          width: ref.width,
          height: ref.height,
          // The save above always supplies a name, so the store always echoes one.
          name: ref.name as string,
        },
      }
    },
  }))
}

export type { VideoAttachmentRef }
export default apply
