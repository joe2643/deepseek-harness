/**
 * Frame-sampling policy and the model-facing report describing it.
 *
 * Pure functions of the caller's arguments and the probed container, so the
 * sheet a call produces is reproducible from its report alone.
 *
 * @module @deepseek-ai/dsh-tool-view-video/plan
 */

/** Container facts the sampler and the report both read. */
export interface VideoFacts {
  width: number
  height: number
  codec: string
  fps: number
  duration: number
  frames: number
  bytes: number
}

/** One resolved sampling and layout decision. */
export interface SheetPlan {
  start: number
  end: number
  stride: number
  picked: number[]
  columns: number
  tileWidth: number
  fontSize: number
}

/** The sampling half of a completed result, as reported to the model. */
export interface SamplingReport {
  start: number
  end: number
  stride: number
  count: number
  cols: number
  rows: number
  picked: number[]
}

/** Caller-facing sampling arguments; every field falls back to a default. */
export interface SampleArgs {
  count?: number | undefined
  start?: number | undefined
  end?: number | undefined
  columns?: number | undefined
  tile_width?: number | undefined
}

const DEFAULT_COUNT = 16
const DEFAULT_COLUMNS = 4
const DEFAULT_TILE_WIDTH = 216
const MAX_COUNT = 64
const MAX_COLUMNS = 8
const MIN_TILE_WIDTH = 96
const MAX_TILE_WIDTH = 480
/** Frame rate assumed when a container reports none, so sampling stays defined. */
const FALLBACK_FPS = 24

/** Clamp one optional numeric argument into an inclusive range. */
function clamp(value: number | undefined, fallback: number, min: number, max: number): number {
  const parsed = Math.floor(Number(value ?? fallback))
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, parsed))
}

/**
 * Resolve which absolute source frames to show, and how to lay them out.
 *
 * The stride is derived from the window and the requested count rather than
 * accepted directly: a caller asks for "16 frames of these two seconds" and
 * the plan reports the temporal resolution that produced, including when it
 * reaches 1 and the window is shown exhaustively.
 * @param args - caller-supplied window, density and layout.
 * @param video - probed container facts.
 * @returns the sampling and layout decision.
 */
export function planSampling(args: SampleArgs, video: VideoFacts): SheetPlan {
  const duration = video.duration > 0 ? video.duration : 0
  const startArg = Number(args.start ?? 0)
  const start = Number.isFinite(startArg) && startArg > 0 ? startArg : 0
  const endArg = Number(args.end ?? duration)
  let end = Number.isFinite(endArg) && endArg > start ? endArg : duration
  if (duration > 0 && end > duration) end = duration
  if (!(end > start)) end = start + (duration > 0 ? duration : 1)

  const count = clamp(args.count, DEFAULT_COUNT, 1, MAX_COUNT)
  const fps = video.fps > 0 ? video.fps : FALLBACK_FPS
  const windowFrames = Math.max(1, Math.round((end - start) * fps))
  const stride = Math.max(1, Math.round(windowFrames / count))
  const startFrame = Math.round(start * fps)

  const picked: number[] = []
  for (let offset = 0; offset < windowFrames && picked.length < count; offset += 1) {
    const absolute = startFrame + offset
    if (absolute % stride === 0) picked.push(absolute)
  }
  if (picked.length === 0) picked.push(startFrame)

  const tileWidth = clamp(args.tile_width, DEFAULT_TILE_WIDTH, MIN_TILE_WIDTH, MAX_TILE_WIDTH)
  return {
    start,
    end,
    stride,
    picked,
    columns: Math.min(clamp(args.columns, DEFAULT_COLUMNS, 1, MAX_COLUMNS), picked.length),
    tileWidth,
    fontSize: tileWidth >= 200 ? 15 : 12,
  }
}

/**
 * The text half of the result.
 *
 * It states the blind spot explicitly because the failure this tool exists to
 * prevent is a model concluding "no blink occurs" from a sheet whose stride is
 * wider than a blink. Absence of evidence at 1.6 samples/sec is not evidence
 * of absence, and the report says so rather than leaving it inferable.
 * @param path - the resolved video path.
 * @param video - probed container facts.
 * @param sampling - the sampling actually performed.
 * @returns the model-facing envelope accompanying the sheet image.
 */
export function summarize(path: string, video: VideoFacts, sampling: SamplingReport): string {
  const fps = video.fps > 0 ? video.fps : FALLBACK_FPS
  const perSecond = video.fps > 0 ? (video.fps / sampling.stride).toFixed(2) : '?'
  const lines = [
    `<video>${path}</video>`,
    `<source>${video.width}x${video.height} ${video.codec}, ${video.frames} frames`
      + ` @ ${video.fps.toFixed(2)}fps, ${video.duration.toFixed(2)}s</source>`,
    `<sampled>${sampling.count} frames, every ${sampling.stride} source frame(s)`
      + ` (${perSecond} samples/sec) over ${sampling.start.toFixed(2)}s..${sampling.end.toFixed(2)}s,`
      + ` tiled ${sampling.cols}x${sampling.rows}</sampled>`,
    `<frames>${sampling.picked.join(', ')}</frames>`,
  ]
  if (sampling.stride > 1) {
    lines.push(`<blind-spot>Events shorter than ~${((sampling.stride - 1) / fps).toFixed(2)}s can`
      + ' fall entirely between these samples, so absence of evidence here is NOT evidence of'
      + ' absence. To check a suspected fast event, call again with a narrow start/end and a'
      + ' count high enough that stride reaches 1.</blind-spot>')
  } else {
    lines.push('<blind-spot>stride=1: every source frame in this window is shown.</blind-spot>')
  }
  lines.push('<reading>Each tile is captioned with its true source frame number and timestamp,'
    + ' in reading order (left to right, top to bottom). Cite frame numbers in any finding.</reading>')
  return lines.join('\n')
}
