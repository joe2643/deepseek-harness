/**
 * Path resolution for one `view_video` call.
 *
 * `ctx.fs.resolve()` does not apply a session working directory, so a
 * workspace-relative path must be anchored explicitly before it is resolved.
 * The session's own cwd is tried first and the deployment root second, and a
 * failure names every candidate rather than reporting a bare "no such file"
 * for a path the caller can see on disk.
 *
 * @module @deepseek-ai/dsh-tool-view-video/locate
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-sandbox-policy'

/** A resolved video path plus the directory its ffmpeg child should run in. */
export interface LocatedVideo {
  path: string
  cwd: string
}

/**
 * The directories a relative path may be taken against, most specific first.
 *
 * Only scalar strings are read out of the live session; the object itself is
 * never retained.
 */
function candidateRoots(ctx: Context, exec: ToolRunContext): string[] {
  const roots: string[] = []
  const session = exec.agent?.session
  const cwd = session?.header.cwd
  if (typeof cwd === 'string' && cwd.length > 0) roots.push(cwd)
  const policy = ctx.get('sandboxPolicy')
  if (policy !== undefined) {
    // The `workspaceRoot` PROPERTY is the process-wide default; the
    // per-session boundary only comes out of resolve({ session }).
    const resolved = policy.resolve(session === undefined ? {} : { session })
    if (roots[0] !== resolved.workspaceRoot) roots.push(resolved.workspaceRoot)
  }
  return roots
}

/**
 * Resolve one caller-supplied path to an existing file.
 * @param ctx - scope supplying `fs` and, when mounted, `sandboxPolicy`.
 * @param requested - the raw `file_path` argument.
 * @param exec - the tool execution, for its agent session and cancellation.
 * @returns the resolved absolute path and the child working directory.
 * @throws when no candidate resolves to an existing file.
 */
export async function locateVideo(
  ctx: Context,
  requested: string,
  exec: ToolRunContext,
): Promise<LocatedVideo> {
  const roots = candidateRoots(ctx, exec)
  const candidates: string[] = []
  if (requested.startsWith('/')) {
    candidates.push(requested)
  } else {
    const relative = requested.replace(/^\.\//, '')
    for (const root of roots) candidates.push(`${root.replace(/\/+$/, '')}/${relative}`)
    candidates.push(requested)
  }
  // ffmpeg receives an absolute path, so cwd only anchors the child; the
  // subprocess seam applies no default and requires one explicitly.
  const cwd = roots[0] ?? '/'

  const tried: string[] = []
  for (const candidate of candidates) {
    const target = await ctx.fs.resolve(candidate, { signal: exec.signal })
    const info = await ctx.fs.stat(target, exec.signal)
    if (info !== undefined) return { path: ctx.fs.processPath(target), cwd }
    tried.push(candidate)
  }
  throw new Error(`cannot read "${requested}": no such file (tried ${tried.join(', ')})`)
}
