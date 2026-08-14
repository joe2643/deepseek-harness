import { describe, expect, it } from 'vitest'
import { planSampling, summarize } from '../src/plan.ts'
import type { SamplingReport, VideoFacts } from '../src/plan.ts'

/**
 * Sampling is the tool's whole reason to exist, so this suite pins the two
 * properties a caller depends on: the stride follows from the window and the
 * requested count, and the report states the blind spot that stride implies.
 */

const CLIP: VideoFacts = {
  width: 432,
  height: 576,
  codec: 'h264',
  fps: 24,
  duration: 10,
  frames: 240,
  bytes: 1_044_445,
}

function report(plan: ReturnType<typeof planSampling>, rows: number): SamplingReport {
  return {
    start: plan.start,
    end: plan.end,
    stride: plan.stride,
    count: plan.picked.length,
    cols: plan.columns,
    rows,
    picked: plan.picked,
  }
}

describe('planSampling', () => {
  it('spreads the requested count across the whole clip by default', () => {
    const plan = planSampling({}, CLIP)
    expect(plan).toMatchObject({ start: 0, end: 10, stride: 15, columns: 4 })
    expect(plan.picked).toEqual([0, 15, 30, 45, 60, 75, 90, 105, 120, 135, 150, 165, 180, 195, 210, 225])
  })

  it('reaches stride 1 when a narrow window is sampled densely', () => {
    // The reason the tool exists: a 6-frame blink is invisible at stride 15.
    const plan = planSampling({ start: 9.35, end: 10, count: 16 }, CLIP)
    expect(plan.stride).toBe(1)
    expect(plan.picked).toEqual([224, 225, 226, 227, 228, 229, 230, 231, 232, 233, 234, 235, 236, 237, 238, 239])
  })

  it('clamps count, columns and tile width into their supported ranges', () => {
    const low = planSampling({ count: 0, columns: 0, tile_width: 1 }, CLIP)
    expect(low).toMatchObject({ columns: 1, tileWidth: 96, fontSize: 12 })
    expect(low.picked).toHaveLength(1)
    const high = planSampling({ count: 999, columns: 99, tile_width: 9999 }, CLIP)
    expect(high).toMatchObject({ columns: 8, tileWidth: 480, fontSize: 15 })
    // count is a target, not a quota: 240 frames over a clamped 64 rounds the
    // stride to 4, which yields 60 evenly spaced frames rather than 64 uneven ones.
    expect(high.stride).toBe(4)
    expect(high.picked).toHaveLength(60)
  })

  it('ignores non-finite and out-of-order window arguments', () => {
    expect(planSampling({ count: Number.NaN }, CLIP).picked).toHaveLength(16)
    expect(planSampling({ start: -5 }, CLIP).start).toBe(0)
    // end before start cannot describe a window, so the whole clip is used.
    expect(planSampling({ start: 4, end: 2 }, CLIP)).toMatchObject({ start: 4, end: 10 })
    expect(planSampling({ end: 99 }, CLIP).end).toBe(10)
  })

  it('never lets columns exceed the frames actually picked', () => {
    expect(planSampling({ count: 2, columns: 8 }, CLIP).columns).toBe(2)
  })

  it('falls back to a nominal rate and window for a container reporting neither', () => {
    const unknown: VideoFacts = { ...CLIP, fps: 0, duration: 0 }
    const plan = planSampling({}, unknown)
    expect(plan).toMatchObject({ start: 0, end: 1, stride: 2 })
    expect(plan.picked.length).toBeGreaterThan(0)
  })

  it('yields the start frame when the window rounds below one frame', () => {
    const plan = planSampling({ start: 2, end: 2.000001, count: 4 }, CLIP)
    expect(plan.picked).toEqual([48])
  })
})

describe('summarize', () => {
  it('states the blind spot a sparse stride implies', () => {
    const plan = planSampling({}, CLIP)
    const text = summarize('/clips/a.mp4', CLIP, report(plan, 4))
    expect(text).toContain('<source>432x576 h264, 240 frames @ 24.00fps, 10.00s</source>')
    expect(text).toContain('every 15 source frame(s) (1.60 samples/sec)')
    expect(text).toContain('Events shorter than ~0.58s')
    expect(text).toContain('NOT evidence of absence')
  })

  it('reports an exhaustive window as exhaustive', () => {
    const plan = planSampling({ start: 9.35, end: 10, count: 16 }, CLIP)
    const text = summarize('/clips/a.mp4', CLIP, report(plan, 4))
    expect(text).toContain('stride=1: every source frame in this window is shown')
    expect(text).not.toContain('NOT evidence of absence')
  })

  it('reports an unknown frame rate without inventing one', () => {
    const unknown: VideoFacts = { ...CLIP, fps: 0 }
    const plan = planSampling({}, unknown)
    expect(summarize('/clips/a.mp4', unknown, report(plan, 1))).toContain('(? samples/sec)')
  })
})
