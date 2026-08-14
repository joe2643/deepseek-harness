/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-tool-view-video`.
 * @module @deepseek-ai/dsh-tool-view-video/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-tool-view-video'

/** Cordis companion plugin name. */
export const name = 'tool-view-video-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this model-facing adapter owns no lifecycle stream. Its
 * one durable effect is an attachment the attachment seam commits and verifies,
 * and its frame sampling is a pure function of the call arguments asserted in
 * package tests.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
