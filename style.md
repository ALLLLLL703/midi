# midi MCP 实现方案

## 目标

构建一个面向 MuScriptor 的 TypeScript MCP 服务器 `midi`。服务器通过 stdio 暴露 `vocal_audio_to_midi`、`instrumental_audio_to_midi` 与 `check_model`，调用本机 `muscriptor` CLI 完成音频转 MIDI。

## 已确定边界

- Node.js 22+，TypeScript，MCP stdio transport。
- Linux 首版，默认模型 `medium`。
- 输入支持允许目录内的本地文件，以及仅公网可达的 HTTPS URL。
- 本地和远程音频默认上限 200 MB，远程下载超时 5 分钟；两者可配置。
- 输出写入专用目录并使用唯一文件名，不覆盖已有文件。
- 转录任务使用进程内串行队列，避免多个模型进程争抢 CPU/GPU 内存。
- 固定生成 MIDI，不提供 JSON 事件或 auralization；开放其余相关 CLI 转录参数。
- 所有 MCP 工具描述、诊断和错误使用英文。
- MuScriptor 命令默认为 `muscriptor`，可执行文件路径可配置。

## 模块职责

```text
src/
  app/          MCP server composition and startup
  config/       validated environment-backed runtime configuration
  i18n/         stable English message keys and translator
  services/     downloader, serial queue, MuScriptor process adapter
  tools/        vocal, instrumental, and check_model registrations
  util/         path, URL, process, and error helpers shared across domains
  index.ts      stdio entry point
tests/          unit and MCP-level scenario tests
```

核心转录参数和 CLI 参数拼装保持纯函数；下载、文件系统和子进程放在服务边界。依赖通过小接口注入，以便测试真实工具入口时替换昂贵的模型进程。

## 安全策略

- 本地输入必须解析真实路径，并位于 `MIDI_MCP_ALLOWED_INPUT_DIRS` 中。
- HTTPS 下载在每次连接及重定向后解析 DNS，拒绝 loopback、link-local、私网、保留地址和非 HTTPS 协议。
- 下载流同时执行 Content-Length 预检和实际字节计数，超限立即中止并删除临时文件。
- 输出路径只由服务器生成，文件名使用安全 stem 与随机 UUID。
- 子进程使用参数数组和 `shell: false`，不拼接 shell 命令。
- 日志只写 stderr，避免破坏 stdio JSON-RPC。

## 配置

使用启动时验证的不可变环境变量快照：

- `MIDI_MCP_MUSCRIPTOR_COMMAND`，默认 `muscriptor`
- `MIDI_MCP_ALLOWED_INPUT_DIRS`，以平台分隔符分隔，默认当前工作目录
- `MIDI_MCP_OUTPUT_DIR`，默认当前工作目录下 `.midi-output`
- `MIDI_MCP_DOWNLOAD_MAX_BYTES`，默认 `209715200`
- `MIDI_MCP_DOWNLOAD_TIMEOUT_MS`，默认 `300000`
- `MIDI_MCP_PROCESS_TIMEOUT_MS`，默认 `3600000`

MCP 是由宿主按配置启动的 stdio 子进程；变更环境变量后重启即可原子替换全部配置，避免半更新状态。

## 测试方案

- 配置：默认值、非法数值、多个允许目录。
- 路径：允许目录内文件、目录逃逸、符号链接逃逸。
- URL：仅 HTTPS、公网地址、重定向复查、大小限制、超时和临时文件清理。
- CLI 参数：默认值、全部可选项、互斥/依赖约束、无 shell 注入。
- 队列：任务严格串行，失败后后续任务继续。
- 工具：本地输入成功、URL 输入成功、非法输入、CLI 失败、分层健康诊断。
- 真实环境：运行构建、类型检查、单元测试，并执行不加载模型的 `check_model` 冒烟测试。

## 外部参考与依赖决策

- `muscriptor/muscriptor`：以官方 `muscriptor transcribe` 参数和错误行为为唯一 CLI 契约来源，避免自行实现音频转录。
- `@modelcontextprotocol/sdk` v1.29：采用官方 `McpServer.registerTool`、Zod schema、`structuredContent` 和 `StdioServerTransport`。
- `midi-file` v1.2.4：解析并验证 MuScriptor 产出的 Standard MIDI File，拒绝损坏或无轨道结果。
- `xiaolaa2/ableton-copilot-mcp`：仅参考其 TypeScript MCP 的分层方向；不采用装饰器、数据库等与本项目无关的复杂结构。
- 使用 SDK 自带 MCP 能力、Zod 配置校验和 Node 标准库下载/子进程 API。公网 IP 分类若标准库不足，将选用成熟的小型依赖，避免手写易错地址规则。

## 阶段

1. 工程脚手架、配置与安全输入边界。
2. MuScriptor 适配器、串行队列与两个 MCP 工具。
3. 场景测试、文档、构建验证和发布准备。

## OpenCode 参数暴露修复

MCP SDK v1.29 无法从经过 `superRefine()` 包装的 Zod object 导出属性，导致 `tools/list` 将 `audio_to_midi` 声明成空参数工具。公开注册 schema 保持为基础 `z.object()`；`batchSize` 与 `preludeForcing` 的跨字段约束由独立纯函数在处理器入口执行。集成测试直接检查 `Client.listTools()` 返回的 `source` 属性和 required 列表，防止服务端校验正常但 MCP 客户端看不到参数的回归。

## 主唱旋律增强

- 删除含义混杂的 `audio_to_midi`。`vocal_audio_to_midi` 固定执行 Demucs 双 stem、人声转写、伴奏转写和完整 MIDI 合并；`instrumental_audio_to_midi` 直接转写无主唱音频，不运行 Demucs。
- 人声工具默认使用《长征》验证后的快速高质量配置：`large`、XPU、float16、batch 1、prelude forcing、全局 beam 1、CFG 1；这些参数仍可由调用者覆盖。
- 人声 stem 固定使用 `voice` 约束，并默认启用 3 次空块回退：优先 beam 3，再以 temperature 0.6、CFG 1.75 采样。伴奏 stem 沿用已验收流程的 beam 1、CFG 1，且不启用空块回退。
- 两个 stem 均固定传 `--detect-tempo false`，与已验收流程一致，并避免系统包环境因可选 `beat_this` 缺失而在推理前失败。
- Demucs 必须先以 `--two-stems=vocals` 生成 `vocals.wav` 和 `no_vocals.wav`，禁止先转写原始混音后再叠加人声。
- MuScriptor 顺序转写两个 stem；先完成人声，再转写伴奏，避免并发争抢 XPU。伴奏 MIDI 只来自 `no_vocals.wav`。
- 合并阶段忽略人声源 MIDI 的轨道名，将全部音符按秒映射到伴奏 tempo map，折叠成一个 `lead vocal` 轨。
- `lead vocal` 使用 Choir Aahs（零基 Program 52），避免 Voice Oohs 的异常“wu”音色。
- 主唱默认固定 velocity=127 并写入 CC7/CC11=127；非鼓伴奏通道默认写入可调用配置的 CC7=89（约 70%），确保常见 SoundFont 下主唱明显可听。
- Demucs 与 MuScriptor 保持为外部可执行依赖，分别由 `MIDI_MCP_DEMUCS_COMMAND` 和 `MIDI_MCP_MUSCRIPTOR_COMMAND` 配置。
- 本机 MuScriptor 命令固定指向自有 fork 的 `scripts/muscriptor`；该脚本使用系统 Python、pacman 依赖和 `python-pytorch-xpu`，不创建项目 `.venv` 或 uv tool 环境。
- Intel GPU 可通过 PyTorch XPU wheel 加速 MuScriptor，并用 `MIDI_MCP_DEMUCS_DEVICE=xpu` 加速 Demucs。
- 生产请求的所有 stem、中间 MIDI 和合并暂存文件位于 0700 私有工作目录，请求结束后清理；任一步失败都不返回缺少主唱轨的半成品。方法实验阶段改用 0700 持久实验目录，复用已验收 stem，并保留每个 0600 中间产物供试听和回溯。
- 方法实验仍采用人工试听门；正式 `vocal_audio_to_midi` 工具按已验收默认参数自动生成完整 MIDI，不暴露中间 stem。
- 测试覆盖 Demucs 双 stem、两次 MuScriptor 调用、人声 voice/空块参数、伴奏参数隔离、全部源轨折叠、按秒合并、Choir Aahs 音色、依赖缺失、清理以及纯音乐工具不调用外部流水线。

参考：Demucs 官方 two-stems vocals CLI；MuScriptor 官方多乐器转写参数；Tonejs/Midi 的秒级 note API。Demucs 和 Tonejs/Midi 均为 MIT。

## 自定义输出文件名

- 两个转写工具的 `outputFileName` 均可选；只接受专用输出目录内的单一 basename，缺少 `.mid` 时自动补全。
- 拒绝路径分隔符、控制字符、`.` 和 `..`，不允许借此突破输出目录。
- 自定义目标通过同文件系统原子硬链接发布；目标已存在时返回 `OUTPUT_ALREADY_EXISTS`，绝不覆盖并发或历史结果。
- 未指定时继续使用安全 stem 与 UUID，保持原行为。
