import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { locateVideo } from '../src/locate.ts'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'

/**
 * Path anchoring. `ctx.fs.resolve()` applies no session working directory, so
 * a relative path must be tried against the session cwd and the deployment
 * root explicitly; a miss has to name what it tried, because "no such file"
 * for a path the caller can see on disk is otherwise unactionable.
 */

interface FsStub {
  /** Absolute paths that exist. */
  present: readonly string[]
}

function contextWith(fs: FsStub, options: { cwd?: string; workspaceRoot?: string } = {}): Context {
  const ctx = new Context()
  ctx.provide('fs', {
    resolve: (path: string) => Promise.resolve({ path }),
    stat: (target: { path: string }) => Promise.resolve(
      fs.present.includes(target.path) ? { version: 1 } : undefined,
    ),
    processPath: (target: { path: string }) => target.path,
  } as never)
  if (options.workspaceRoot !== undefined) {
    ctx.provide('sandboxPolicy', {
      workspaceRoot: options.workspaceRoot,
      resolve: () => ({ mode: 'workspace-write', workspaceRoot: options.workspaceRoot }),
    } as never)
  }
  return ctx
}

function execWith(cwd?: string): ToolRunContext {
  const signal = new AbortController().signal
  if (cwd === undefined) return { signal } as unknown as ToolRunContext
  return { signal, agent: { session: { header: { cwd } } } } as unknown as ToolRunContext
}

describe('locateVideo', () => {
  it('anchors a relative path on the session working directory', async () => {
    const ctx = contextWith({ present: ['/work/clips/a.mp4'] })
    await expect(locateVideo(ctx, 'clips/a.mp4', execWith('/work')))
      .resolves.toEqual({ path: '/work/clips/a.mp4', cwd: '/work' })
  })

  it('strips a leading ./ before anchoring', async () => {
    const ctx = contextWith({ present: ['/work/a.mp4'] })
    await expect(locateVideo(ctx, './a.mp4', execWith('/work')))
      .resolves.toMatchObject({ path: '/work/a.mp4' })
  })

  it('falls back to the deployment workspace root', async () => {
    // The session declares no cwd, so only the policy root can anchor it.
    const ctx = contextWith({ present: ['/deploy/a.mp4'] }, { workspaceRoot: '/deploy' })
    await expect(locateVideo(ctx, 'a.mp4', execWith()))
      .resolves.toEqual({ path: '/deploy/a.mp4', cwd: '/deploy' })
  })

  it('does not repeat a policy root identical to the session cwd', async () => {
    const ctx = contextWith({ present: [] }, { workspaceRoot: '/work' })
    await expect(locateVideo(ctx, 'missing.mp4', execWith('/work')))
      .rejects.toThrow('tried /work/missing.mp4, missing.mp4')
  })

  it('takes an absolute path as given', async () => {
    const ctx = contextWith({ present: ['/elsewhere/a.mp4'] })
    await expect(locateVideo(ctx, '/elsewhere/a.mp4', execWith('/work')))
      .resolves.toEqual({ path: '/elsewhere/a.mp4', cwd: '/work' })
  })

  it('runs the child from the filesystem root when nothing declares one', async () => {
    const ctx = contextWith({ present: ['/a.mp4'] })
    await expect(locateVideo(ctx, '/a.mp4', execWith())).resolves.toEqual({ path: '/a.mp4', cwd: '/' })
  })

  it('names every candidate it tried when none resolves', async () => {
    const ctx = contextWith({ present: [] }, { workspaceRoot: '/deploy' })
    await expect(locateVideo(ctx, 'gone.mp4', execWith('/work')))
      .rejects.toThrow('cannot read "gone.mp4": no such file (tried /work/gone.mp4, /deploy/gone.mp4, gone.mp4)')
  })
})
