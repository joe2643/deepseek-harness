# @deepseek-ai/dsh-tool-view-video

English | [中文](README.zh.md)

The **model-facing `view_video` tool**: it samples a video into labelled contact-sheet image(s) and returns them as ordinary `image` content blocks, so a model that accepts images can inspect motion without the deployment accepting video.

It reads through the `ctx.fs` provider contract ([`@deepseek-ai/dsh-fs`](../fs)), runs `ffprobe`/`ffmpeg` through `ctx.subprocess` ([`@deepseek-ai/dsh-subprocess`](../../subprocess/subprocess)), and commits each rendered sheet through `ctx.attachments.saveImage` ([`@deepseek-ai/dsh-attachment`](../../attachment/attachment)). `ffmpeg` and `ffprobe` must be on the host `PATH`; the package does not vendor them.

```ts ignore-check
await ctx.plugin(LocalFileSystem, { cwd: process.cwd() }) // @deepseek-ai/dsh-fs-local
await ctx.plugin(LocalSubprocessRuntime)                  // @deepseek-ai/dsh-subprocess-local
await ctx.plugin(LocalAttachmentStore, { dshHome })        // @deepseek-ai/dsh-attachment-local
await ctx.plugin(ToolViewVideo)                            // this package
```

## Why this exists beside native video input

A `VideoBlock` ([`@deepseek-ai/dsh-llm`](../../llm/llm)) hands a whole clip to a provider, and the provider then chooses its own frame sampling. That rate is neither reported nor controllable: measured on one OpenAI-compatible gateway, a 5-second 120-frame clip billed 1262 video tokens — roughly five frames. Against known ground truth (two 6-frame blinks and a 7-pulse mouth flutter) the model answered "one blink" and "the mouth never opens", because both events fell entirely between the provider's samples.

This tool exists so the **caller** owns that decision. A window plus a frame count determines the stride, the report states the stride in both frames and samples per second, and a narrow window with a high count reaches stride 1 — every frame in the window, which makes an event shorter than a provider's sample interval visible.

Use a `VideoBlock` when a model should watch a clip whole. Use `view_video` when a finding depends on temporal resolution the provider will not guarantee.

## Config

All keys are optional.

| Key | Default | Meaning |
|---|---|---|
| `maxSheetBytes` | `3145728` | Largest rendered sheet handed to the attachment service. The effective cap is the smallest of this, `maxImageBytes`, and `maxMessageImageBytes`. |
| `jpegQuality` | `4` | mjpeg quality scale, 2 (best) to 31 (worst). |
| `renderTimeoutMs` | `180000` | Wall-clock cap for one `ffmpeg` render before the child is terminated. |

## Tool

| Tool | Arguments | Behavior |
|---|---|---|
| `view_video` | `file_path`, `count?`, `start?`, `end?`, `columns?`, `tile_width?`, `label?` | Samples the window into `count` frames (1–64, default 16), tiles them `columns` wide (1–8, default 4) at `tile_width` pixels (96–480, default 216), and returns one JPEG sheet as an image block beside a sampling report. |

`count` is a target, not a quota: the stride is `round(windowFrames / count)`, so a request for 999 frames of a 240-frame clip yields 60 evenly spaced frames rather than 64 uneven ones. Every tile is captioned with its **true source frame number** and timestamp, so a finding can cite one and a follow-up call can zoom to it.

The canonical success value is `{ path, video: { width, height, codec, fps, duration, frames, bytes }, sampling: { start, end, stride, count, cols, rows, picked }, sheet: { attachmentId, mediaType, bytes, width, height, name } }`.

A relative `file_path` is anchored on the calling session's cwd and then the deployment workspace root; `ctx.fs.resolve()` applies neither, so a miss names every candidate it tried rather than reporting a bare "no such file" for a path the caller can see on disk.

## Model Experience

### Tool result

#### What the model sees

One text envelope followed by the sheet image. The envelope names the source, the sampling actually performed, the exact frames on the sheet, and the blind spot that sampling implies. The blind-spot line is deliberate rather than decorative: the failure this tool prevents is a model concluding "no blink occurs" from a sheet whose stride is wider than a blink. At stride 1 it instead reports that the window is shown exhaustively.

##### Sampling report

```markdown
<video>/clips/rig.mp4</video>
<source>432x576 h264, 240 frames @ 24.00fps, 10.00s</source>
<sampled>16 frames, every 15 source frame(s) (1.60 samples/sec) over 0.00s..10.00s, tiled 4x4</sampled>
<frames>0, 15, 30, 45, 60, 75, 90, 105, 120, 135, 150, 165, 180, 195, 210, 225</frames>
<blind-spot>Events shorter than ~0.58s can fall entirely between these samples, so absence of evidence here is NOT evidence of absence. To check a suspected fast event, call again with a narrow start/end and a count high enough that stride reaches 1.</blind-spot>
<reading>Each tile is captioned with its true source frame number and timestamp, in reading order (left to right, top to bottom). Cite frame numbers in any finding.</reading>
```


#### Token effect

One sheet is one image, so its token cost is the routed model's cost for a raster of `columns × tile_width` by `rows × tile_height` — not the cost of the frames individually. Raising `count` at a fixed `tile_width` therefore grows the sheet rather than multiplying requests.

#### KV Cache effect

Each call appends a new image to the conversation; earlier turns are untouched, so the prompt prefix stays cacheable.

## Known Limitations and Deferred Work

- **No audio.** A sheet carries frames only; a clip whose meaning is in its soundtrack is not served by this tool.
- **One sheet per call.** A window needing more than 64 frames must be split across calls; the tool does not paginate.
- **`ffmpeg` and `ffprobe` come from the host `PATH`.** A deployment without them gets a probe failure naming the missing binary, rather than a degraded result.
- **Tile height follows the source aspect ratio.** `tile_width` is the only layout dimension a caller sets, so a mixed-orientation batch cannot be normalised in one sheet.
