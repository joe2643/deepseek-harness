# Agent Note: Native video content blocks, and the sampling tool beside them

Status: implemented

English | [中文](2026-08-14-native-video-content-blocks.zh.md)

## Problem

The harness could not carry a video to a model. `ContentBlockMap` was text | reasoning | image | tool-call | tool-result, `ModelModalityMap` was text | image, and `@earendil-works/pi-ai` — the library behind the generic multi-provider adapter — contained no occurrence of the word *video* at 0.82.1 or at its latest 0.84.1. A deployment whose gateway routed to a video-capable model therefore had no seam to reach it through, while the deployment's own `read_image` refused an `.mp4` on extension alone.

Sampling frames into images was possible from outside the harness, but every such workaround re-derived the same three facts badly: where a workspace-relative path resolves, how to get bytes out of an encoder without leaving a temporary file in someone's repository, and what to tell the model about the frames it did *not* see.

## Decision

**`VideoBlock` joins the core vocabulary.** `ContentBlockMap` gains `video`, `ModelModalityMap` gains `video`, and `contentHasVideo()` is the recursive twin of `contentHasImage()` so capability gating and text-only serialization cannot diverge on nesting depth. The block is documented as user-directed in practice: no adapter declares video *output*.

**The attachment seam gains a video half.** `VideoAttachmentRef` carries geometry plus `durationSeconds` and `frameRate`, and `videoLimits` bounds bytes, count, aggregate bytes and duration — duration because a provider bills and samples by decoded frames, so a short high-rate clip and a long low-rate one can share a byte count and cost very differently.

**Admission probes the container structurally.** `attachment-local` reads the ISO base media box tree (`ftyp` brand, the first video `trak`'s `tkhd`/`mdhd`/`stts`) and never decodes a frame, so admission cost is bounded by the header rather than the payload. Accepted types are `video/mp4` and `video/quicktime` — both ISO base media, both verifiable by that one parser. Matroska (`video/webm`) would need an unrelated EBML reader and is refused at admission rather than stored with unverified metadata. The image and video paths now share one durability ladder (`persistBytes`) instead of duplicating the staging/fsync/link sequence.

**pi-ai is patched, because its content union cannot express video.** `UserMessage.content` is `(TextContent | ImageContent)[]` and the OpenAI-completions serializer maps every non-text entry to an `image_url` part. That is not a mislabelling that happens to work: a provider rejects an mp4 sent that way outright ("The image format is illegal and cannot be opened"), verified against a live gateway. A `pnpm` patch — the mechanism the repository already uses for `node-pty` — adds an optional `dshVideo` discriminator to `ImageContent`, emits a marked entry as `video_url` at both serializer sites, widens the tool-result media gate to admit a video-capable model, and stops `downgradeUnsupportedImages` from replacing a marked entry with `(image omitted…)`. Absent the marker the file behaves exactly as published, so a request carrying no video is byte-identical.

**Both text-only adapters refuse video explicitly** rather than flattening it into nothing, and **session export resolves video references through `readVideo`** so an exported archive keeps its media.

**`view_video` ships beside the block, not instead of it.** A provider that receives a `VideoBlock` chooses its own frame sampling, and that rate is neither reported nor controllable: measured on one OpenAI-compatible gateway, a 5-second 120-frame clip billed 1262 video tokens — about five frames. Against known ground truth (two 6-frame blinks and a 7-pulse mouth flutter) two different models answered "one blink" and "the mouth never opens", and the larger one additionally invented defects to fill the gap. The tool therefore gives the *caller* the stride: a window plus a frame count, reaching stride 1 for exhaustive inspection of a narrow window. Its report states the stride in frames and samples per second and names the blind spot explicitly, because the failure it exists to prevent is a model concluding "no blink occurs" from a sheet sampled more coarsely than a blink.

**A video may travel as a URL instead of bytes.** Inlining is self-contained and always available, but the body is 4/3 the file and a gateway rejects an oversized one: measured on one deployment, an 8.7 MB body succeeded and a 13.0 MB body returned HTTP 413 `RequestTooLarge`. `PiAiAdapterOptions.resolveVideoUrl` therefore lets a deployment promote a durable video to an address the provider fetches itself; the same 13 MB clip that failed inline succeeded as a URL, and a 963 KB clip went out in a 390-byte request. Promotion is optional in both directions — this package signs and serves nothing, and a resolver that declines, throws, or returns a loopback origin falls back to inlining, because a URL the provider cannot fetch must never displace bytes that would have worked.

## Alternatives considered

**Waiting for pi-ai to add video.** Checked: 0.84.1, the latest release, still has zero occurrences. Waiting would have blocked the seam behind an upstream that shows no sign of moving.

**Intercepting `globalThis.fetch` to rewrite the request body.** Verified to work — the OpenAI SDK pi-ai constructs honours a replaced global. Rejected because it is a process-wide side effect, which the repository's effect discipline forbids, and because it would silently capture every other consumer's traffic in the same process.

**A hand-written `openai-completions-video` protocol in the adapter's `PROTOCOLS` table.** The table is adapter-owned, so this needed no vendor change. Rejected as the larger liability: it would fork and then maintain a second SSE streaming implementation, tool-call assembly and error mapping, to change one content part.

**Sampling frames instead of shipping `VideoBlock` at all.** The tool alone would have served the measured use case. Rejected because it leaves the harness unable to express a video a provider *should* watch whole, and because "the model cannot see video" would remain a harness fact rather than a route fact.

**`ffmpeg` invoked through a shell string.** Rejected for argument quoting: paths and captions reach `ctx.subprocess` as argv, and the drawtext caption is escaped for the filtergraph with `%` dropped so a caller's label can never introduce an expansion.

## Consequences

`ffmpeg` and `ffprobe` become a host requirement for `view_video` only; the block, the seam and the adapter path need neither. A deployment that accepts video must state it per model (`input: [text, video]`), because over-claiming admits a clip the provider then rejects mid-turn, after the message is durable.

The pi-ai patch is the maintenance cost: a version bump must re-apply four hunks across three files, and `pnpm patch` fails loudly if a hunk no longer matches, so the failure mode is a refused install rather than a silently text-only route.
