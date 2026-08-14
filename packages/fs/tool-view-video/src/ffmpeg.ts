/**
 * ffmpeg/ffprobe invocation behind `ctx.subprocess`.
 *
 * Both binaries are addressed as argv, never a shell string, so no path or
 * caption is ever quoted into a command line. The rendered sheet is streamed
 * from ffmpeg's stdout: writing it to disk first would leave a temporary file
 * inside whatever directory the session happens to own.
 *
 * @module @deepseek-ai/dsh-tool-view-video/ffmpeg
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Readable } from 'node:stream'
import type {} from '@deepseek-ai/dsh-subprocess'
import type { SheetPlan, VideoFacts } from './plan.ts'

/** Cap for one ffprobe JSON reply; a container's header summary is tiny. */
const PROBE_STDOUT_LIMIT = 256 * 1024
/** Cap for either binary's diagnostics. */
const STDERR_LIMIT = 64 * 1024
/** Wall-clock cap for one container probe. */
const PROBE_TIMEOUT_MS = 30_000
/** Grace period before an over-running child is killed outright. */
const TERMINATE_GRACE_MS = 2_000
/** Frame rate assumed when a container reports none. */
const FALLBACK_FPS = 24

/** One completed child process. */
interface Completed {
  code: number | null
  stdout: Buffer
  stderr: string
}

/** Collect one stream into a single buffer, refusing to grow past `maxBytes`. */
async function collect(stream: Readable | undefined, maxBytes: number, what: string): Promise<Buffer> {
  if (stream === undefined) return Buffer.alloc(0)
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    total += buffer.length
    if (total > maxBytes) throw new Error(`${what} exceeded ${maxBytes} bytes`)
    chunks.push(buffer)
  }
  return Buffer.concat(chunks, total)
}

/** Run one binary to completion, capturing stdout and stderr. */
async function run(
  ctx: Context,
  argv: readonly string[],
  options: { cwd: string; signal?: AbortSignal | undefined; maxStdoutBytes: number; timeoutMs: number },
): Promise<Completed> {
  const handle = ctx.subprocess.spawn({
    argv,
    cwd: options.cwd,
    stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
    graceMs: TERMINATE_GRACE_MS,
    ...options.signal === undefined ? {} : { signal: options.signal },
  })
  // terminate() is the seam's only termination verb; it escalates to SIGKILL.
  const timer = setTimeout(() => { handle.terminate() }, options.timeoutMs)
  try {
    const [stdout, stderr, outcome] = await Promise.all([
      collect(handle.stdout, options.maxStdoutBytes, `${argv[0]} stdout`),
      collect(handle.stderr, STDERR_LIMIT, `${argv[0]} stderr`),
      handle.done,
    ])
    return { code: outcome.exitCode, stdout, stderr: stderr.toString('utf8') }
  } finally {
    clearTimeout(timer)
  }
}

/** One ffprobe stream description, as far as this tool reads it. */
interface ProbeJson {
  streams?: { width?: number; height?: number; nb_frames?: string; r_frame_rate?: string; codec_name?: string }[]
  format?: { duration?: string; size?: string }
}

/**
 * Read geometry, timing and codec from one container.
 * @param ctx - scope supplying `subprocess`.
 * @param path - absolute path to the video.
 * @param cwd - working directory for the child.
 * @param signal - cancellation for the probe.
 * @returns the container facts sampling and reporting depend on.
 * @throws when ffprobe fails, replies unparsably, or the file carries no video stream.
 */
export async function probeVideo(
  ctx: Context,
  path: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<VideoFacts> {
  const result = await run(ctx, [
    'ffprobe', '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,nb_frames,r_frame_rate,codec_name',
    '-show_entries', 'format=duration,size',
    '-of', 'json', path,
  ], { cwd, signal, maxStdoutBytes: PROBE_STDOUT_LIMIT, timeoutMs: PROBE_TIMEOUT_MS })

  if (result.code !== 0) {
    throw new Error(`cannot probe "${path}": ${result.stderr.trim() || `ffprobe exit ${String(result.code)}`}`)
  }
  let parsed: ProbeJson
  try {
    parsed = JSON.parse(result.stdout.toString('utf8')) as ProbeJson
  } catch {
    throw new Error(`ffprobe returned unparsable JSON for "${path}"`)
  }
  const stream = parsed.streams?.[0] ?? {}
  const [numerator, denominator = '1'] = (stream.r_frame_rate ?? '0/1').split('/')
  const rate = Number(numerator) / Number(denominator)
  const fps = Number.isFinite(rate) && rate > 0 ? rate : 0
  const duration = Number(parsed.format?.duration)
  const declared = Number(stream.nb_frames)
  const width = stream.width ?? 0
  const height = stream.height ?? 0
  if (width === 0 || height === 0) throw new Error(`"${path}" has no decodable video stream`)
  return {
    width,
    height,
    codec: stream.codec_name ?? 'unknown',
    fps,
    duration: Number.isFinite(duration) ? duration : 0,
    frames: Number.isFinite(declared) && declared > 0
      ? declared
      : (fps > 0 && Number.isFinite(duration) ? Math.round(fps * duration) : 0),
    bytes: Number(parsed.format?.size) || 0,
  }
}

/**
 * Escape one caption for ffmpeg's `drawtext`.
 *
 * Both separators take exactly ONE backslash inside a single-quoted `text=`
 * value; a doubled colon escape reaches the option parser as a literal `:` and
 * fails the graph with "No option name near …" (verified against ffmpeg).
 * Backslashes, quotes and `%` are dropped rather than escaped, so a caption can
 * neither close the quoting nor introduce a drawtext expansion.
 */
function escapeCaption(value: string): string {
  return value
    .replace(/[\\'%]/g, '')
    .replace(/:/g, '\\:')
    .replace(/,/g, '\\,')
}

/** Everything one sheet render needs. */
export interface RenderRequest {
  path: string
  cwd: string
  plan: SheetPlan
  video: VideoFacts
  quality: number
  maxBytes: number
  timeoutMs: number
  label?: string
  signal?: AbortSignal | undefined
}

/**
 * Render one tiled contact sheet, streamed from ffmpeg's stdout.
 * @param ctx - scope supplying `subprocess`.
 * @param request - resolved paths, sampling plan and encoder limits.
 * @returns the encoded JPEG and the row count the tiling produced.
 * @throws when ffmpeg fails, emits nothing, or emits something that is not a JPEG.
 */
export async function renderSheet(
  ctx: Context,
  request: RenderRequest,
): Promise<{ data: Uint8Array; rows: number }> {
  const { plan, video } = request
  const rows = Math.ceil(plan.picked.length / plan.columns)
  const fps = video.fps > 0 ? video.fps : FALLBACK_FPS
  const suffix = request.label === undefined || request.label.length === 0
    ? ''
    : `  ${escapeCaption(request.label)}`
  const caption = `f%{eif\\:t*${fps.toFixed(6)}+0.5\\:d}  %{pts\\:hms}${suffix}`
  const filter = [
    `select='between(t\\,${plan.start.toFixed(6)}\\,${plan.end.toFixed(6)})*not(mod(n\\,${plan.stride}))'`,
    `scale=${plan.tileWidth}:-2`,
    `drawtext=text='${caption}':x=3:y=3:fontsize=${plan.fontSize}`
      + ':fontcolor=yellow:box=1:boxcolor=black@0.65',
    `tile=${plan.columns}x${rows}`,
  ].join(',')

  const result = await run(ctx, [
    'ffmpeg', '-v', 'error', '-i', request.path,
    '-vf', filter,
    '-frames:v', '1', '-f', 'image2', '-c:v', 'mjpeg', '-q:v', String(request.quality),
    'pipe:1',
  ], {
    cwd: request.cwd,
    signal: request.signal,
    maxStdoutBytes: request.maxBytes,
    timeoutMs: request.timeoutMs,
  })

  if (result.code !== 0) {
    throw new Error(`ffmpeg failed on "${request.path}": ${result.stderr.trim() || `exit ${String(result.code)}`}`)
  }
  const data = result.stdout
  if (data.length === 0) {
    throw new Error('ffmpeg produced no frames; check that the time window overlaps the clip')
  }
  if (data[0] !== 0xff || data[1] !== 0xd8) {
    throw new Error(`ffmpeg did not produce a JPEG (got ${data.length} bytes)`)
  }
  return { data, rows }
}
