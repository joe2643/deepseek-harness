/**
 * Harness request-history conversion into pi-ai's Context vocabulary.
 *
 * @module dsh-llm-pi-ai/context
 */

import { CallId, contentHasImage, contentHasVideo, LlmError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { Context as PiContext, ImageContent, Message as PiMessage, TextContent, Tool as PiTool } from '@earendil-works/pi-ai'
import { toPiAssistant } from './replay.ts'
import { resolveFetchableVideoUrl } from './media-url.ts'
import type { VideoUrlResolver } from './media-url.ts'

/**
 * Marker for a video carried inside pi-ai's user-content array.
 *
 * pi-ai 0.82 has no video vocabulary: `UserMessage.content` is
 * `(TextContent | ImageContent)[]`, and its OpenAI-completions serializer maps
 * every non-text entry to an `image_url` part. An mp4 sent that way is not
 * merely mislabelled — the provider rejects it outright ("The image format is
 * illegal and cannot be opened"), so video cannot ride the image path.
 *
 * The marker therefore travels in the same ordered array (keeping a video
 * beside the text that introduces it) and the adapter rewrites it into the
 * provider's `video_url` part before dispatch.
 */
export interface PiVideoContent extends ImageContent {
  /** Discriminates this adapter's marker from a real image entry. */
  dshVideo: true
  /**
   * A provider-fetchable URL for these bytes, when the deployment resolved
   * one. Present means `data` is empty and the serializer emits this address
   * instead of a base64 data URI, which keeps the request body small enough
   * to clear a gateway's size limit.
   */
  dshVideoUrl?: string
}

/** Join the text blocks of a harness message. */
function flattenText(message: Message): string {
  return message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}


/** Flatten text recursively inside one tool result. */
function toolResultText(blocks: readonly ContentBlock[]): string {
  return blocks.map(block => block.type === 'text'
    ? block.text
    : block.type === 'tool-result' ? toolResultText(block.content) : '').join('')
}

async function userContent(
  blocks: readonly ContentBlock[],
  attachments: AttachmentStore,
  resolveVideoUrl?: VideoUrlResolver,
): Promise<string | (TextContent | ImageContent)[]> {
  const content: (TextContent | ImageContent)[] = []
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        if (block.text.length > 0) content.push({ type: 'text', text: block.text })
        break
      case 'image': {
        const stored = await attachments.readImage(block.attachment)
        content.push({
          type: 'image',
          data: Buffer.from(stored.data).toString('base64'),
          mimeType: stored.ref.mediaType,
        })
        break
      }
      case 'video': {
        // Try a URL first: it keeps the request body at a few hundred bytes,
        // which is the difference between a long clip arriving and the
        // gateway refusing an oversized body. Reading the bytes is skipped
        // entirely when promotion succeeds.
        const url = await resolveFetchableVideoUrl(resolveVideoUrl, block.attachment)
        if (url !== undefined) {
          content.push({
            type: 'image',
            dshVideo: true,
            dshVideoUrl: url,
            data: '',
            mimeType: block.attachment.mediaType,
          } satisfies PiVideoContent)
          break
        }
        const stored = await attachments.readVideo(block.attachment)
        content.push({
          type: 'image',
          dshVideo: true,
          data: Buffer.from(stored.data).toString('base64'),
          mimeType: stored.ref.mediaType,
        } satisfies PiVideoContent)
        break
      }
      case 'tool-result':
        {
          const nested = await userContent(block.content, attachments, resolveVideoUrl)
          if (typeof nested === 'string') {
            if (nested.length > 0) content.push({ type: 'text', text: nested })
          } else {
            content.push(...nested)
          }
        }
        break
      default:
        // Other merge-extensible blocks are not user-input vocabulary for pi-ai.
        break
    }
  }
  if (content.every(block => block.type === 'text')) return content.map(block => block.text).join('')
  return content
}

function toolsOf(options: GenerateOptions): PiTool[] | undefined {
  return options.tools?.map(tool => ({
    name: tool.name,
    description: tool.description,
    // ToolSchema.parameters is a JSON Schema object; pi-ai's TSchema
    // (TypeBox) is structurally JSON Schema, so it assigns directly.
    parameters: tool.parameters,
  }))
}

/** Assemble the request-level pi-ai context envelope shared by both conversion paths. */
function piContext(options: GenerateOptions, messages: PiMessage[]): PiContext {
  const tools = toolsOf(options)
  return {
    ...options.system !== undefined ? { systemPrompt: options.system } : {},
    messages,
    ...tools !== undefined && tools.length > 0 ? { tools } : {},
  }
}

function textOnlyContext(options: GenerateOptions): PiContext {
  const toolNames = new Map<CallId, string>()
  const messages: PiMessage[] = []
  for (const message of options.messages) {
    if (contentHasImage(message.content)) {
      throw new LlmError('pi-ai image conversion requires the durable attachment service', 'UNSUPPORTED_CONTENT')
    }
    if (contentHasVideo(message.content)) {
      throw new LlmError('pi-ai video conversion requires the durable attachment service', 'UNSUPPORTED_CONTENT')
    }
    if (message.role === 'system') {
      messages.push({ role: 'user', content: flattenText(message), timestamp: 0 })
      continue
    }
    if (message.role === 'assistant') {
      const assistant = toPiAssistant(message)
      for (const block of assistant.content) if (block.type === 'toolCall') toolNames.set(CallId(block.id), block.name)
      messages.push(assistant)
      continue
    }
    const text = flattenText(message)
    const results = message.content.filter(block => block.type === 'tool-result')
    if (text.length > 0 || results.length === 0) messages.push({ role: 'user', content: text, timestamp: 0 })
    for (const result of results) {
      messages.push({
        role: 'toolResult',
        toolCallId: result.toolCallId,
        toolName: toolNames.get(result.toolCallId) ?? 'unknown',
        content: [{
          type: 'text',
          text: toolResultText(result.content) || '(no output)',
        }],
        isError: result.isError ?? false,
        timestamp: 0,
      })
    }
  }
  return piContext(options, messages)
}

/**
 * Convert text-only harness history to a synchronous pi-ai Context. Tool
 * result names are recovered from preceding assistant tool calls.
 * @param options - the harness request; `options.system` maps to pi-ai's single `systemPrompt` slot.
 * @returns the pi-ai context; `tools` is omitted when the request declares none.
 */
export function toPiContext(options: GenerateOptions): PiContext
/**
 * Convert harness history to a pi-ai Context while resolving durable images.
 * Tool result names are recovered from preceding assistant tool calls.
 * @param options - the harness request; `options.system` maps to pi-ai's single `systemPrompt` slot.
 * @param attachments - durable byte resolver for image and video references.
 * @param resolveVideoUrl - optional promotion of a video to a provider-fetchable
 *   URL; declining (or its absence) inlines the bytes instead.
 * @returns the asynchronously resolved pi-ai context.
 */
export function toPiContext(
  options: GenerateOptions,
  attachments: AttachmentStore,
  resolveVideoUrl?: VideoUrlResolver,
): Promise<PiContext>
export function toPiContext(
  options: GenerateOptions,
  attachments?: AttachmentStore,
  resolveVideoUrl?: VideoUrlResolver,
): PiContext | Promise<PiContext> {
  return attachments === undefined
    ? textOnlyContext(options)
    : toPiContextWithImages(options, attachments, resolveVideoUrl)
}

async function toPiContextWithImages(
  options: GenerateOptions,
  attachments: AttachmentStore,
  resolveVideoUrl?: VideoUrlResolver,
): Promise<PiContext> {
  const toolNames = new Map<CallId, string>()
  const messages: PiMessage[] = []

  for (const message of options.messages) {
    if (message.role === 'system') {
      if (contentHasImage(message.content)) {
        throw new LlmError('pi-ai cannot represent an image in an in-history system message', 'UNSUPPORTED_CONTENT')
      }
      if (contentHasVideo(message.content)) {
        throw new LlmError('pi-ai cannot represent a video in an in-history system message', 'UNSUPPORTED_CONTENT')
      }
      // pi-ai has a single systemPrompt slot; in-history system messages are
      // folded into user messages to preserve order (rare in practice — the
      // harness sends the system prompt via options.system).
      messages.push({ role: 'user', content: flattenText(message), timestamp: 0 })
      continue
    }
    if (message.role === 'assistant') {
      const assistant = toPiAssistant(message)
      for (const block of assistant.content) {
        if (block.type === 'toolCall') toolNames.set(CallId(block.id), block.name)
      }
      messages.push(assistant)
      continue
    }
    // user role: text + tool results (each result becomes its own message).
    const regular = message.content.filter(block => block.type !== 'tool-result')
    const content = await userContent(regular, attachments, resolveVideoUrl)
    const results = message.content.filter(block => block.type === 'tool-result')
    if (content.length > 0 || results.length === 0) {
      messages.push({ role: 'user', content, timestamp: 0 })
    }
    for (const result of results) {
      const resultContent = await userContent(result.content, attachments, resolveVideoUrl)
      messages.push({
        role: 'toolResult',
        toolCallId: result.toolCallId,
        toolName: toolNames.get(result.toolCallId) ?? 'unknown',
        content: typeof resultContent === 'string'
          ? [{ type: 'text', text: resultContent || '(no output)' }]
          : resultContent,
        isError: result.isError ?? false,
        timestamp: 0,
      })
    }
  }

  return piContext(options, messages)
}
