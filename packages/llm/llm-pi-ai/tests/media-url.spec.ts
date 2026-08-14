import { describe, expect, it, vi } from 'vitest'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { VideoAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { isFetchableByProvider, resolveFetchableVideoUrl } from '../src/media-url.ts'

/**
 * Promotion is an optimisation with one hard rule: a URL the provider cannot
 * fetch must never displace bytes that would have worked. Every decline path
 * therefore has to reach the same inline fallback.
 */

const ref: VideoAttachmentRef = {
  attachmentId: AttachmentId(`sha256:${'d'.repeat(64)}`),
  mediaType: 'video/mp4',
  bytes: 4,
  width: 640,
  height: 480,
  durationSeconds: 10,
  frameRate: 24,
}

describe('isFetchableByProvider', () => {
  it.each([
    'https://media.example.com/media?t=x&exp=1&sig=y',
    'http://media.example.com/clip.mp4',
    // A private LAN address is the operator's call: a self-hosted provider on
    // the same network can reach it, and only they know where the route sits.
    'http://192.168.1.20:8089/media?t=x',
  ])('accepts %s', (url) => {
    expect(isFetchableByProvider(url)).toBe(true)
  })

  it.each([
    ['loopback IPv4', 'http://127.0.0.1:8089/media?t=x'],
    ['loopback name', 'http://localhost:8089/media?t=x'],
    ['loopback IPv6', 'http://[::1]:8089/media?t=x'],
    ['unspecified', 'http://0.0.0.0:8089/media?t=x'],
    ['data URI', 'data:video/mp4;base64,AAAA'],
    ['file URL', 'file:///clips/a.mp4'],
    ['relative path', '/clips/a.mp4'],
    ['nonsense', 'not-a-url'],
  ])('refuses a %s', (_label, url) => {
    expect(isFetchableByProvider(url)).toBe(false)
  })
})

describe('resolveFetchableVideoUrl', () => {
  it('promotes a reachable URL', async () => {
    const resolve = vi.fn(() => Promise.resolve('https://media.example.com/m?t=x'))
    await expect(resolveFetchableVideoUrl(resolve, ref)).resolves.toBe('https://media.example.com/m?t=x')
    expect(resolve).toHaveBeenCalledWith(ref)
  })

  it('inlines when no resolver is configured', async () => {
    await expect(resolveFetchableVideoUrl(undefined, ref)).resolves.toBeUndefined()
  })

  it.each([
    ['the resolver declines', undefined],
    ['the resolver returns an empty string', ''],
    ['the URL is a loopback origin', 'http://127.0.0.1:8089/media'],
    ['the URL is malformed', 'not-a-url'],
  ])('inlines when %s', async (_label, value) => {
    await expect(resolveFetchableVideoUrl(() => Promise.resolve(value), ref))
      .resolves.toBeUndefined()
  })

  it('inlines when the resolver throws', async () => {
    // A signing outage must degrade a large request, never fail one that
    // would have succeeded inline.
    await expect(resolveFetchableVideoUrl(() => Promise.reject(new Error('signing down')), ref))
      .resolves.toBeUndefined()
  })

  it('inlines when the resolver returns a non-string', async () => {
    await expect(resolveFetchableVideoUrl(() => Promise.resolve(42 as unknown as string), ref))
      .resolves.toBeUndefined()
  })
})
