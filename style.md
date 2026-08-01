# midi MCP 实现方案

## 目标

构建一个面向 MuScriptor 的 TypeScript MCP 服务器 `midi`。服务器通过 stdio 暴露 `audio_to_midi` 与 `check_model`，调用本机 `muscriptor` CLI 完成多乐器音频转 MIDI。

## 已确定边界

- Node.js 22+，TypeScript，MCP stdio transport。
- Linux 首版，默认模型 `medium`。
- 输入支持允许目录内的本地文件，以及仅公网可达的 HTTPS URL。
- 远程下载默认上限 200 MB、超时 5 分钟；两者可配置。
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
  tools/        check_model and audio_to_midi registrations
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
- `xiaolaa2/ableton-copilot-mcp`：仅参考其 TypeScript MCP 的分层方向；不采用装饰器、数据库等与本项目无关的复杂结构。
- 使用 SDK 自带 MCP 能力、Zod 配置校验和 Node 标准库下载/子进程 API。公网 IP 分类若标准库不足，将选用成熟的小型依赖，避免手写易错地址规则。

## 阶段

1. 工程脚手架、配置与安全输入边界。
2. MuScriptor 适配器、串行队列与两个 MCP 工具。
3. 场景测试、文档、构建验证和发布准备。
