/**
 * Route capability gate for `view_video`.
 *
 * The tool returns a contact sheet as an `image` block, so the calling route
 * must declare `image` input — a video-capable route that cannot carry images
 * is still unusable here. The check runs before any encoding or storage,
 * because a tool result enters durable session history: emitting an image on
 * a route that cannot carry it breaks that route's continuation, and the work
 * spent producing it is wasted. Unknown capability refuses rather than
 * relying on the adapter guard, matching `read_image`.
 *
 * @module @deepseek-ai/dsh-tool-view-video/route
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-llm'

/**
 * Require the calling route to declare image input.
 * @param ctx - scope used to resolve the optional `llm` service.
 * @param exec - the tool execution supplying the calling agent.
 * @param requestedPath - the raw path, rendered in refusal messages.
 * @throws when the route is unresolvable or declares no image input.
 */
export async function assertImageCapableRoute(
  ctx: Context,
  exec: ToolRunContext,
  requestedPath: string,
): Promise<void> {
  const routed = exec.agent?.session.requestHeader()?.config
  const provider = routed?.provider ?? exec.agent?.options.provider
  const model = routed?.model ?? exec.agent?.options.model
  const llm = ctx.get('llm')
  if (provider === undefined || model === undefined || llm === undefined) {
    throw new Error(`cannot watch "${requestedPath}": the current model route could not be resolved`)
  }
  const active = await llm.resolveModelInfo(provider, model, exec.signal)
  if (active.inputModalities === undefined || !active.inputModalities.includes('image')) {
    throw new Error(
      `cannot watch "${requestedPath}": model "${model}" does not declare image input,`
      + ' and view_video returns its frames as an image; switch to an image-capable model',
    )
  }
}
