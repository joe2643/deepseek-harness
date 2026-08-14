# @deepseek-ai/dsh-tool-view-video

[English](README.md) | 中文

**面向模型的 `view_video` 工具**：把视频采样成带标注的联系表图片，并以普通 `image` 内容块返回，因此只要模型接受图片，就能在部署本身不接受视频的情况下检视动态画面。

它通过 `ctx.fs` 提供者契约（[`@deepseek-ai/dsh-fs`](../fs)）读取文件，通过 `ctx.subprocess`（[`@deepseek-ai/dsh-subprocess`](../../subprocess/subprocess)）调用 `ffprobe`/`ffmpeg`，并通过 `ctx.attachments.saveImage`（[`@deepseek-ai/dsh-attachment`](../../attachment/attachment)）提交每张渲染出的联系表。`ffmpeg` 与 `ffprobe` 必须位于宿主 `PATH` 上；本包不内置它们。

```ts ignore-check
await ctx.plugin(LocalFileSystem, { cwd: process.cwd() }) // @deepseek-ai/dsh-fs-local
await ctx.plugin(LocalSubprocessRuntime)                  // @deepseek-ai/dsh-subprocess-local
await ctx.plugin(LocalAttachmentStore, { dshHome })        // @deepseek-ai/dsh-attachment-local
await ctx.plugin(ToolViewVideo)                            // this package
```

## 为什么它与原生视频输入并存

`VideoBlock`（[`@deepseek-ai/dsh-llm`](../../llm/llm)）把整段片子交给提供方，由提供方自行决定抽帧频率。该频率既不会被报告，也无法控制：在一个 OpenAI 兼容网关上实测，一段 5 秒 120 帧的片子计费 1262 个视频 token，约合五帧。对照已知事实（两次各 6 帧的眨眼与 7 次口型脉动），模型回答"眨眼一次"和"嘴从未张开"，因为这两个事件完全落在提供方的采样间隙之间。

本工具的存在就是为了把这个决定交还**调用方**。窗口加帧数决定步长，报告同时以帧数和每秒采样数说明该步长，而窄窗口配合高帧数可让步长降到 1 —— 窗口内每一帧都在，从而让短于提供方采样间隔的事件变得可见。

需要模型整体观看一段片子时用 `VideoBlock`；结论依赖提供方不保证的时间分辨率时，用 `view_video`。

## 配置

所有键均为可选。

| 键 | 默认值 | 含义 |
|---|---|---|
| `maxSheetBytes` | `3145728` | 交给附件服务的联系表体积上限。实际上限取本值、`maxImageBytes` 与 `maxMessageImageBytes` 三者的最小值。 |
| `jpegQuality` | `4` | mjpeg 质量档位，2（最佳）至 31（最差）。 |
| `renderTimeoutMs` | `180000` | 单次 `ffmpeg` 渲染在子进程被终止前的挂钟上限。 |

## 工具

| 工具 | 参数 | 行为 |
|---|---|---|
| `view_video` | `file_path`、`count?`、`start?`、`end?`、`columns?`、`tile_width?`、`label?` | 在窗口内采样 `count` 帧（1–64，默认 16），按每行 `columns` 张（1–8，默认 4）、每张 `tile_width` 像素宽（96–480，默认 216）拼贴，返回一张 JPEG 联系表图片块及一份采样报告。 |

`count` 是目标而非配额：步长为 `round(windowFrames / count)`，因此对一段 240 帧的片子请求 999 帧，得到的是 60 帧等距采样，而不是 64 帧疏密不均的采样。每格都标注其**真实源帧号**与时间戳，因此结论可以引用帧号，后续调用也能据此放大。

相对 `file_path` 会先以调用会话的 cwd、再以部署工作区根目录为基准解析；`ctx.fs.resolve()` 两者都不套用，因此未命中时会列出尝试过的每一个候选路径，而不是对一个调用方在磁盘上看得见的路径只报"文件不存在"。

## 模型体验

### 工具结果

#### 模型看到的内容

一段文本信封，其后是联系表图片。信封说明来源、实际执行的采样、表上的确切帧号，以及该采样隐含的盲区；盲区那一行是刻意为之，而非点缀：本工具要防止的失败，正是模型从一张步长宽于眨眼的联系表得出"没有眨眼"的结论。步长为 1 时，它转而声明该窗口已被完整展示。

##### 采样报告

```markdown
<video>/clips/rig.mp4</video>
<source>432x576 h264, 240 frames @ 24.00fps, 10.00s</source>
<sampled>16 frames, every 15 source frame(s) (1.60 samples/sec) over 0.00s..10.00s, tiled 4x4</sampled>
<frames>0, 15, 30, 45, 60, 75, 90, 105, 120, 135, 150, 165, 180, 195, 210, 225</frames>
<blind-spot>Events shorter than ~0.58s can fall entirely between these samples, so absence of evidence here is NOT evidence of absence. To check a suspected fast event, call again with a narrow start/end and a count high enough that stride reaches 1.</blind-spot>
<reading>Each tile is captioned with its true source frame number and timestamp, in reading order (left to right, top to bottom). Cite frame numbers in any finding.</reading>
```


#### Token effect

一张联系表就是一张图片，因此其 token 成本等于路由模型对一张 `columns × tile_width` 乘 `rows × tile_height` 光栅图的成本，而不是各帧成本之和。所以在 `tile_width` 固定时提高 `count`，增大的是这张表，而不是请求数量。

#### KV Cache effect

每次调用都会向对话追加一张新图片，先前轮次不受影响，因此提示前缀仍可缓存。

## 已知限制与后续工作

- **没有音轨。** 联系表只承载画面；意义在声音里的片子不适用本工具。
- **每次调用一张表。** 需要超过 64 帧的窗口必须拆成多次调用；本工具不做分页。
- **`ffmpeg` 与 `ffprobe` 取自宿主 `PATH`。** 缺少它们的部署会得到一个指明缺失二进制的探测失败，而不是降级结果。
- **格高按源画面宽高比决定。** 调用方只能设定 `tile_width` 这一个版面尺寸，因此混合朝向的一批画面无法在同一张表内归一。
