# midi

`midi` 是一个 TypeScript MCP 服务器，通过官方 [MuScriptor](https://github.com/muscriptor/muscriptor) CLI 将音频转录为多乐器 MIDI。它支持受限本地路径和公网 HTTPS URL，并默认串行执行转录，避免多个模型进程同时耗尽 CPU/GPU 内存。

## 功能

- `vocal_audio_to_midi`：对含主唱音乐运行 Demucs，分别转写人声和伴奏，再输出带独立主唱轨的完整 MIDI。
- `instrumental_audio_to_midi`：直接把纯音乐或其他非人声音频转成多乐器 MIDI，不运行 Demucs。
- `check_model`：检查 MuScriptor CLI、输出目录和 Hugging Face 认证线索，不加载模型权重。
- 本地输入目录白名单及符号链接逃逸防护。
- HTTPS-only 下载、建连时 DNS 校验、私网/保留地址拦截、逐跳重定向复查。
- 下载大小、下载超时和转录进程超时限制。
- MuScriptor 子进程使用参数数组启动，不经过 shell。
- MCP 请求取消或超时时先终止 MuScriptor 进程组，必要时升级为强制终止。

## 前置条件

- Linux
- Node.js 22 或更高版本
- 已安装可执行的 `muscriptor` CLI；本项目开发环境使用 `ALLLLLL703/muscriptor` fork
- 已在 Hugging Face 接受所选 MuScriptor 模型许可
- 首次下载模型时已通过 `hf auth login` 登录，或设置 `HF_TOKEN`

- `vocal_audio_to_midi` 需要可执行的 Demucs；首次使用会下载人声分离模型。
- Arch Linux 开发环境优先使用 pacman/AUR Python 包与 `python-pytorch-xpu`，不要求项目 `.venv` 或 uv tool。

模型权重使用 `CC BY-NC 4.0`，仅限非商业用途。此仓库的 TypeScript 代码使用 MIT 许可。

## 开发

```bash
npm install
npm run check
npm test
npm run build
```

启动 stdio MCP 服务器：

```bash
node dist/index.js
```

## MCP 配置

构建后可在 MCP 宿主中添加：

```json
{
  "mcpServers": {
    "midi": {
      "command": "node",
      "args": ["/absolute/path/to/midi/dist/index.js"],
      "env": {
        "MIDI_MCP_ALLOWED_INPUT_DIRS": "/home/user/Music:/home/user/Downloads",
        "MIDI_MCP_OUTPUT_DIR": "/home/user/Music/midi-output",
        "MIDI_MCP_DEMUCS_COMMAND": "/home/user/.local/bin/demucs",
        "MIDI_MCP_DEMUCS_DEVICE": "xpu"
      }
    }
  }
}
```

## 配置变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `MIDI_MCP_MUSCRIPTOR_COMMAND` | `muscriptor` | MuScriptor 可执行文件名或绝对路径 |
| `MIDI_MCP_DEMUCS_COMMAND` | `demucs` | 主唱增强使用的 Demucs 可执行文件 |
| `MIDI_MCP_DEMUCS_DEVICE` | `auto` | Demucs 设备，例如 `cpu`、`cuda` 或 `xpu` |
| `MIDI_MCP_ALLOWED_INPUT_DIRS` | MCP 进程工作目录 | 允许读取的本地根目录，以系统路径分隔符分隔 |
| `MIDI_MCP_OUTPUT_DIR` | `<cwd>/.midi-output` | MIDI 和临时下载目录 |
| `MIDI_MCP_DOWNLOAD_MAX_BYTES` | `209715200` | 单个本地或远程音频最大字节数，即 200 MB |
| `MIDI_MCP_DOWNLOAD_TIMEOUT_MS` | `300000` | 整个下载的超时时间，即 5 分钟 |
| `MIDI_MCP_PROCESS_TIMEOUT_MS` | `3600000` | 单次 MuScriptor 进程超时，即 1 小时 |

环境变量在进程启动时一次性验证并形成不可变快照。修改配置后重启 MCP 服务器即可应用完整新配置。

## 工具

### `check_model`

无参数。返回：

- `ready`：CLI 可执行且输出目录可写。
- `cli`：`muscriptor --help` 的检查结果。
- `outputDirectory`：专用输出目录状态。
- `authentication`：是否发现 Hugging Face token 环境变量。`unknown` 不代表不可用，因为本机可能已有缓存登录或模型权重。
- `leadVocal`：Demucs 是否可执行；人声与伴奏 stem 均复用已检查的 MuScriptor。该状态不影响普通转录的 `ready`。

该工具不会下载或加载模型。

### `instrumental_audio_to_midi`

主要参数：

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `source` | 必填 | 允许目录中的本地路径，或公网 HTTPS URL |
| `outputFileName` | 自动唯一名称 | 输出目录内的安全文件名；自动补 `.mid`，已存在时拒绝覆盖 |
| `model` | `medium` | `small`、`medium` 或 `large` |
| `device` | `auto` | `auto`、`cpu`、`cuda`、`cuda:N`、`mps` 或 `xpu` |
| `dtype` | MuScriptor 默认 | `float32`、`float16` 或 `bfloat16` |
| `instruments` | 自动检测 | MuScriptor 乐器组名称数组 |
| `sampling` | `false` | 使用温度采样 |
| `temperature` | `1` | 采样温度，必须大于 0 |
| `cfgCoef` | `1` | classifier-free guidance 系数 |
| `batchSize` | MuScriptor 默认 | 每个 forward pass 的 5 秒分块数 |
| `strictEos` | `false` | 分块没有生成 EOS 时是否失败 |
| `beamSize` | `1` | beam search 宽度 |
| `preludeForcing` | `true` | 跨分块延音前奏强制 |

`batchSize > 1` 要求 `preludeForcing=false`。模型来源只允许官方 `small/medium/large`，避免自定义路径或 URL 绕过 MCP 的文件和网络边界。

该工具直接转写输入音频，适合纯音乐或不需要单独提取主唱的场景。

### `vocal_audio_to_midi`

共享 `source`、输出名、模型和解码参数，但默认使用已试听验收的高质量配置：

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `model` | `large` | 高质量 MuScriptor 模型 |
| `device` | `xpu` | Intel XPU |
| `dtype` | `float16` | FP16 推理 |
| `cfgCoef` | `1` | 全局 classifier-free guidance；避免整首重复条件计算 |
| `beamSize` | `1` | 全局贪心解码；仅空块使用 beam 3 回退 |
| `batchSize` | MuScriptor 默认 1 | 与 prelude forcing 配合顺序转写 |
| `preludeForcing` | `true` | 保持跨分块延音上下文 |
| `emptyOutputRetries` | `3` | 人声空块最大回退次数 |
| `emptyOutputBeamSize` | `3` | 首次空块回退的 beam 宽度 |
| `emptyOutputTemperature` | `0.6` | 后续采样回退温度 |
| `emptyOutputCfgCoef` | `1.75` | 空块回退 CFG |
| `leadVocalVelocity` | `127` | 主唱音符固定 velocity |
| `leadVocalAccompanimentVolume` | `89` | 非鼓伴奏通道 CC7 音量 |

上述默认值均可覆盖并用于人声 stem。人声始终使用 `voice` 约束和空块回退；伴奏 stem 保留调用者的 `instruments` 过滤，使用上次流程的确定性 `beamSize=1`、`cfgCoef=1`，且不启用空块回退。

MCP 固定使用 `--detect-tempo false`，保持人声与伴奏的秒级对齐，并避免依赖可选的 `beat_this`。

成功结果包含 `outputPath`、`outputBytes`、`model`、`sourceKind`、`leadVocalIncluded`；人声工具还包含 `leadVocalNotes`。本地和 URL 音频都会复制到 0600 权限的私有快照，转录完成或失败后删除。生成结果经 Standard MIDI File 解析验证后才从私有暂存区原子发布。

人声工具先用 Demucs 生成 `vocals.wav` 和 `no_vocals.wav`，先转写人声，再转写伴奏。伴奏 MIDI 只从 `no_vocals.wav` 生成；人声音符按秒折叠为一个 `lead vocal` 轨。该轨使用 General MIDI Choir Aahs（Program 53，零基代码 52），默认 velocity 127 且 CC7/CC11 为最大值；非鼓伴奏通道默认写入 CC7=89（约 70%）。MIDI 只保存旋律音高与节奏，不保存真实嗓音或歌词。

## 安全说明

公网地址拒绝策略降低了 SSRF 风险，但不能代替部署环境的出站防火墙。如果内部服务使用公网 IP，应额外配置网络层 allowlist。MCP 服务器拥有其运行账户的权限，建议使用最小化的输入目录和独立输出目录。
