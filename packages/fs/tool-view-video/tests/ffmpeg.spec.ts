import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { probeVideo, renderSheet } from '../src/ffmpeg.ts'
import type { SheetPlan, VideoFacts } from '../src/plan.ts'

/**
 * The failure branches of the ffmpeg boundary.
 *
 * `tool.spec.ts` drives the real binaries for the success path; these cases
 * need outputs a working ffmpeg will not produce on request — a truncated JSON
 * reply, an empty stream, a non-JPEG payload — so the child is stubbed here and
 * only here.
 */

const CLIP: VideoFacts = {
  width: 160, height: 120, codec: 'h264', fps: 24, duration: 2, frames: 48, bytes: 1024,
}

const PLAN: SheetPlan = {
  start: 0, end: 2, stride: 12, picked: [0, 12, 24, 36], columns: 2, tileWidth: 120, fontSize: 12,
}

/** A context whose subprocess seam replays one fixed child result. */
function contextWith(result: { stdout: Uint8Array | string; stderr?: string; exitCode?: number }): Context {
  const ctx = new Context()
  ctx.provide('subprocess', {
    spawn: () => ({
      stdout: Readable.from([Buffer.from(result.stdout as never)]),
      stderr: Readable.from([Buffer.from(result.stderr ?? '')]),
      done: Promise.resolve({ exitCode: result.exitCode ?? 0, signal: null }),
      terminate: () => {},
    }),
  } as never)
  return ctx
}

async function render(ctx: Context, maxBytes = 1 << 20): Promise<unknown> {
  return renderSheet(ctx, {
    path: '/clips/a.mp4', cwd: '/clips', plan: PLAN, video: CLIP,
    quality: 4, maxBytes, timeoutMs: 1000,
  })
}

describe('probeVideo failure branches', () => {
  it('refuses a reply that is not JSON', async () => {
    await expect(probeVideo(contextWith({ stdout: 'not json at all' }), '/clips/a.mp4', '/clips'))
      .rejects.toThrow('ffprobe returned unparsable JSON for "/clips/a.mp4"')
  })

  it('reports ffprobe diagnostics on a non-zero exit', async () => {
    const ctx = contextWith({ stdout: '', stderr: 'moov atom not found', exitCode: 1 })
    await expect(probeVideo(ctx, '/clips/a.mp4', '/clips')).rejects.toThrow('moov atom not found')
  })

  it('reports the exit code when ffprobe says nothing', async () => {
    const ctx = contextWith({ stdout: '', stderr: '', exitCode: 3 })
    await expect(probeVideo(ctx, '/clips/a.mp4', '/clips')).rejects.toThrow('ffprobe exit 3')
  })

  it('refuses a container reporting no dimensions', async () => {
    const ctx = contextWith({ stdout: JSON.stringify({ streams: [{ codec_name: 'h264' }], format: {} }) })
    await expect(probeVideo(ctx, '/clips/a.mp4', '/clips')).rejects.toThrow('has no decodable video stream')
  })

  it('derives a frame count when the container declares none', async () => {
    const ctx = contextWith({
      stdout: JSON.stringify({
        streams: [{ width: 160, height: 120, r_frame_rate: '24/1', codec_name: 'h264' }],
        format: { duration: '2', size: '1024' },
      }),
    })
    await expect(probeVideo(ctx, '/clips/a.mp4', '/clips')).resolves.toMatchObject({ frames: 48, fps: 24 })
  })

  it('reports zero rate and frames for a container describing neither', async () => {
    const ctx = contextWith({
      stdout: JSON.stringify({ streams: [{ width: 160, height: 120 }], format: {} }),
    })
    await expect(probeVideo(ctx, '/clips/a.mp4', '/clips')).resolves.toMatchObject({
      fps: 0, frames: 0, duration: 0, bytes: 0, codec: 'unknown',
    })
  })

  it('refuses a reply carrying an empty stream list', async () => {
    const ctx = contextWith({ stdout: JSON.stringify({ streams: [], format: {} }) })
    await expect(probeVideo(ctx, '/clips/a.mp4', '/clips')).rejects.toThrow('has no decodable video stream')
  })
})

describe('stream collection', () => {
  it('accepts a child stream yielding plain byte arrays', async () => {
    // A Readable in object mode can yield Uint8Array rather than Buffer; the
    // collector must normalise instead of assuming Node's subclass.
    const ctx = new Context()
    ctx.provide('subprocess', {
      spawn: () => ({
        stdout: Readable.from([Uint8Array.of(0xff, 0xd8, 0xff, 0xd9)], { objectMode: true }),
        stderr: Readable.from([], { objectMode: true }),
        done: Promise.resolve({ exitCode: 0, signal: null }),
        terminate: () => {},
      }),
    } as never)
    await expect(render(ctx)).resolves.toMatchObject({ rows: 2 })
  })
})

describe('timeout', () => {
  it('terminates a child that outruns its deadline', async () => {
    // The only termination verb is terminate(); the render must invoke it
    // rather than waiting on a child that never settles by itself.
    let terminated = false
    const ctx = new Context()
    ctx.provide('subprocess', {
      spawn: () => {
        let finish: (outcome: { exitCode: number; signal: null }) => void = () => {}
        const done = new Promise<{ exitCode: number; signal: null }>((resolve) => { finish = resolve })
        const stdout = new Readable({ read() {} })
        const stderr = new Readable({ read() {} })
        return {
          stdout,
          stderr,
          done,
          terminate: () => {
            terminated = true
            stdout.push(null)
            stderr.push(null)
            finish({ exitCode: 137, signal: null })
          },
        }
      },
    } as never)
    await expect(renderSheet(ctx, {
      path: '/clips/a.mp4', cwd: '/clips', plan: PLAN, video: CLIP,
      quality: 4, maxBytes: 1 << 20, timeoutMs: 10,
    })).rejects.toThrow('exit 137')
    expect(terminated).toBe(true)
  })
})

describe('renderSheet failure branches', () => {
  it('reports an empty encoder stream', async () => {
    await expect(render(contextWith({ stdout: new Uint8Array(0) })))
      .rejects.toThrow('ffmpeg produced no frames')
  })

  it('refuses output that does not start with a JPEG marker', async () => {
    await expect(render(contextWith({ stdout: Uint8Array.of(0x89, 0x50, 0x4e, 0x47) })))
      .rejects.toThrow('ffmpeg did not produce a JPEG (got 4 bytes)')
  })

  it('reports ffmpeg diagnostics on a non-zero exit', async () => {
    const ctx = contextWith({ stdout: '', stderr: 'Invalid argument', exitCode: 1 })
    await expect(render(ctx)).rejects.toThrow('ffmpeg failed on "/clips/a.mp4": Invalid argument')
  })

  it('reports the exit code when ffmpeg says nothing', async () => {
    await expect(render(contextWith({ stdout: '', stderr: '', exitCode: 9 })))
      .rejects.toThrow('exit 9')
  })

  it('refuses a stream larger than the caller allows', async () => {
    const oversized = new Uint8Array(4096).fill(0x41)
    oversized[0] = 0xff
    oversized[1] = 0xd8
    await expect(render(contextWith({ stdout: oversized }), 64))
      .rejects.toThrow('stdout exceeded 64 bytes')
  })

  it('treats absent child streams as empty output', async () => {
    // stdout is `Readable | undefined` on the seam: 'pipe' supplies it, but the
    // contract admits its absence, so the collector must not assume a stream.
    const ctx = new Context()
    ctx.provide('subprocess', {
      spawn: () => ({
        stdout: undefined,
        stderr: undefined,
        done: Promise.resolve({ exitCode: 0, signal: null }),
        terminate: () => {},
      }),
    } as never)
    await expect(render(ctx)).rejects.toThrow('ffmpeg produced no frames')
  })

  it('captions with a nominal rate when the container reports none', async () => {
    const jpeg = Uint8Array.of(0xff, 0xd8, 0xff, 0xd9)
    const rateless: VideoFacts = { ...CLIP, fps: 0 }
    await expect(renderSheet(contextWith({ stdout: jpeg }), {
      path: '/clips/a.mp4', cwd: '/clips', plan: PLAN, video: rateless,
      quality: 4, maxBytes: 1 << 20, timeoutMs: 1000, label: '',
    })).resolves.toMatchObject({ rows: 2 })
  })

  it('escapes a caption carrying filtergraph separators', async () => {
    const jpeg = Uint8Array.of(0xff, 0xd8, 0xff, 0xd9)
    await expect(renderSheet(contextWith({ stdout: jpeg }), {
      path: '/clips/a.mp4', cwd: '/clips', plan: PLAN, video: CLIP,
      quality: 4, maxBytes: 1 << 20, timeoutMs: 1000, label: "pass: 1, of 2 %{x} '\\",
    })).resolves.toMatchObject({ rows: 2 })
  })

  it('accepts a well-formed JPEG and reports its tiling', async () => {
    const jpeg = Uint8Array.of(0xff, 0xd8, 0xff, 0xd9)
    await expect(render(contextWith({ stdout: jpeg }))).resolves.toEqual({ data: Buffer.from(jpeg), rows: 2 })
  })
})
