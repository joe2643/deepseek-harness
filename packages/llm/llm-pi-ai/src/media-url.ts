/**
 * Optional signed-URL promotion for durable video.
 *
 * A video reaches an OpenAI-compatible route one of two ways: inlined as a
 * base64 data URI inside the request body, or as a URL the provider fetches
 * itself. Inlining is self-contained and always available; it costs a body
 * 4/3 the size of the file, and a gateway rejects an oversized one outright
 * (measured on one deployment: an 8.7 MB body succeeded, a 13.0 MB body
 * returned HTTP 413 `RequestTooLarge`). A URL keeps the body at a few hundred
 * bytes regardless of clip length — the same 13 MB clip that failed inline
 * succeeded as a URL — but only if the origin is reachable from the provider.
 *
 * Hence this seam is a *promotion*, never a replacement: a resolver may
 * decline, and the caller falls back to inlining. The one rule that must not
 * be relaxed is the loopback refusal below.
 *
 * @module dsh-llm-pi-ai/media-url
 */

import type { VideoAttachmentRef } from '@deepseek-ai/dsh-attachment'

/**
 * Promote one durable video to a URL the provider can fetch.
 *
 * @param ref - the durable reference whose bytes need an address.
 * @returns an absolute `http(s)` URL, or `undefined` to inline instead.
 */
export type VideoUrlResolver = (ref: VideoAttachmentRef) => Promise<string | undefined>

/**
 * Origins no remote provider can reach.
 *
 * A loopback or unspecified host means no tunnel fronts this deployment, so
 * handing that URL to a cloud provider trades a working inline request for a
 * fetch that cannot resolve. Measured against a live route, the two failures
 * are distinguishable and both useless: an unreachable private address times
 * out (`Download multimodal file timed out`) while a bare loopback URL is
 * rejected as malformed. Inlining is strictly better than either.
 */
const UNREACHABLE_ORIGINS = ['127.', 'localhost', '[::1]', '0.0.0.0', '::1']

/**
 * Decide whether a resolved URL can serve a remote provider.
 *
 * Deliberately conservative: only an absolute `http(s)` URL on a non-loopback
 * host passes. A private LAN address is *not* rejected here — a self-hosted
 * provider on the same network is a legitimate deployment, and only the
 * operator knows which side of the boundary their route sits on.
 * @param url - the candidate the resolver returned.
 * @returns whether the URL may be sent instead of inline bytes.
 */
export function isFetchableByProvider(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  const host = parsed.hostname.toLowerCase()
  return !UNREACHABLE_ORIGINS.some(origin => host === origin || host.startsWith(origin))
}

/**
 * Run a resolver and keep only a URL a provider could actually fetch.
 *
 * A resolver that throws is treated as declining: promotion is an
 * optimisation, and a signing outage must degrade to inlining rather than
 * failing a request that would otherwise have succeeded.
 * @param resolve - the deployment's resolver, when one is configured.
 * @param ref - the durable video reference.
 * @returns the usable URL, or `undefined` to inline the bytes.
 */
export async function resolveFetchableVideoUrl(
  resolve: VideoUrlResolver | undefined,
  ref: VideoAttachmentRef,
): Promise<string | undefined> {
  if (resolve === undefined) return undefined
  let candidate: string | undefined
  try {
    candidate = await resolve(ref)
  } catch {
    return undefined
  }
  if (typeof candidate !== 'string' || candidate.length === 0) return undefined
  return isFetchableByProvider(candidate) ? candidate : undefined
}
