# Agent Note: 原生视频内容块，以及与之并存的采样工具

Status: implemented

[English](2026-08-14-native-video-content-blocks.md) | 中文

## 问题

Harness 无法把视频送到模型。`ContentBlockMap` 只有 text | reasoning | image | tool-call | tool-result，`ModelModalityMap` 只有 text | image，而通用多提供方适配器背后的 `@earendil-works/pi-ai`，无论 0.82.1 还是最新的 0.84.1，都不含 *video* 这个词。于是网关路由到支持视频的模型的部署，根本没有接缝可用；而部署自带的 `read_image` 仅凭扩展名就拒收 `.mp4`。

在 harness 之外把帧采样成图片是可行的，但每一个这类变通都会把同样三件事重新做错一遍：工作区相对路径在哪里解析、如何在不往别人仓库里留临时文件的前提下从编码器取出字节，以及要如何告诉模型它**没有**看到哪些帧。

## 决定

**`VideoBlock` 进入核心词汇表。** `ContentBlockMap` 增加 `video`，`ModelModalityMap` 增加 `video`，`contentHasVideo()` 是 `contentHasImage()` 的递归孪生，因此能力门控与纯文本序列化不会在嵌套深度上产生分歧。该块在文档中被标注为实践中由用户侧发出：没有任何适配器声明视频**输出**。

**附件接缝增加视频一半。** `VideoAttachmentRef` 除几何信息外还携带 `durationSeconds` 与 `frameRate`，`videoLimits` 同时约束字节、数量、总字节与时长 —— 之所以约束时长，是因为提供方按解码帧计费和采样，一段短而高帧率的片子与一段长而低帧率的片子可能字节数相同，成本却相差甚远。

**准入以结构方式探测容器。** `attachment-local` 读取 ISO base media 的 box 树（`ftyp` brand，首条视频 `trak` 的 `tkhd`/`mdhd`/`stts`），从不解码任何一帧，因此准入成本由文件头而非负载决定。接受的类型是 `video/mp4` 与 `video/quicktime` —— 二者同属 ISO base media，同一个解析器即可验证。Matroska（`video/webm`）需要一个无关的 EBML 读取器，因此在准入处直接拒绝，而不是带着未经验证的元数据存下来。图片与视频路径现在共用同一条持久化阶梯（`persistBytes`），不再重复暂存／fsync／link 序列。

**pi-ai 被打了补丁，因为它的内容联合类型无法表达视频。** `UserMessage.content` 是 `(TextContent | ImageContent)[]`，其 OpenAI-completions 序列化器会把所有非文本条目映射成 `image_url` 部件。这并非"标错了但仍能工作"：对着真实网关验证过，以那种方式发送的 mp4 会被提供方直接拒绝（"The image format is illegal and cannot be opened"）。一个 `pnpm` 补丁 —— 仓库对 `node-pty` 已经在用的机制 —— 为 `ImageContent` 增加可选的 `dshVideo` 判别字段，在两处序列化点把带标记的条目输出为 `video_url`，放宽工具结果的媒体门控以接纳支持视频的模型，并阻止 `downgradeUnsupportedImages` 把带标记的条目替换成 `(image omitted…)`。没有该标记时，此文件的行为与已发布版本完全一致，因此不含视频的请求逐字节相同。

**两个纯文本适配器都显式拒绝视频**，而不是把它压扁成空无一物；**会话导出通过 `readVideo` 解析视频引用**，因此导出的归档保留其媒体。

**`view_video` 与该块并存，而非取而代之。** 收到 `VideoBlock` 的提供方会自行选择抽帧频率，而该频率既不被报告也无法控制：在一个 OpenAI 兼容网关上实测，一段 5 秒 120 帧的片子计费 1262 个视频 token，约合五帧。对照已知事实（两次各 6 帧的眨眼与 7 次口型脉动），两个不同模型都回答"眨眼一次"和"嘴从未张开"，其中较大的那个还编造了缺陷来填补空白。因此本工具把步长交给**调用方**：窗口加帧数，窄窗口可让步长降到 1 以完整检视。其报告同时以帧数和每秒采样数说明步长，并明确点出盲区，因为它要防止的失败正是模型从一张采样比眨眼更粗的联系表得出"没有眨眼"的结论。

## 考虑过的替代方案

**等待 pi-ai 支持视频。** 已核查：最新发布的 0.84.1 仍然是零出现。等待意味着把接缝卡在一个看不出要动的上游后面。

**拦截 `globalThis.fetch` 改写请求体。** 已验证可行 —— pi-ai 构造的 OpenAI SDK 会遵循被替换的全局 fetch。因其属于进程级副作用而否决：这既违反仓库的 effect 纪律，也会悄悄捕获同进程内其他所有消费者的流量。

**在适配器 `PROTOCOLS` 表里手写一个 `openai-completions-video` 协议。** 该表由适配器自有，无需改动 vendor。因负担更大而否决：为了改一个内容部件，要分叉并长期维护第二套 SSE 流式实现、工具调用组装与错误映射。

**完全不做 `VideoBlock`，只做帧采样。** 仅凭工具即可满足实测用例。因为那样 harness 仍无法表达"应当整体观看"的视频，且"模型看不到视频"会继续是 harness 的事实而非路由的事实，故否决。

**通过 shell 字符串调用 `ffmpeg`。** 因参数引用问题否决：路径与标题以 argv 形式送入 `ctx.subprocess`，drawtext 标题针对滤镜图做转义并丢弃 `%`，因此调用方的标签绝无可能引入展开。

## 后果

`ffmpeg` 与 `ffprobe` 仅成为 `view_video` 的宿主依赖；内容块、接缝与适配器路径都不需要它们。接受视频的部署必须逐模型声明（`input: [text, video]`），因为过度声明会让一段片子被放行，随后在消息已经落盘之后被提供方在半途拒绝。

pi-ai 补丁是维护成本：版本升级需要在三个文件中重新套用四处 hunk，而 `pnpm patch` 在 hunk 不再匹配时会大声失败，因此失败模式是安装被拒绝，而不是一条悄悄退化成纯文本的路由。
