# midi

`midi` 是一个 TypeScript MCP 服务器，通过官方 [MuScriptor](https://github.com/muscriptor/muscriptor) CLI 将音频转录为多乐器 MIDI。它支持受限本地路径和公网 HTTPS URL，并默认串行执行转录，避免多个模型进程同时耗尽 CPU/GPU 内存。

## 功能

- `audio_to_midi`：把本地音频或公网 HTTPS 音频转成唯一命名的 `.mid` 文件。
- `check_model`：检查 MuScriptor CLI、输出目录和 Hugging Face 认证线索，不加载模型权重。
- 可选主唱增强：Demucs 分离人声，Basic Pitch 提取主唱旋律，并以独立 `lead vocal` / Voice Oohs 轨合并进 MIDI。
- 本地输入目录白名单及符号链接逃逸防护。
- HTTPS-only 下载、建连时 DNS 校验、私网/保留地址拦截、逐跳重定向复查。
- 下载大小、下载超时和转录进程超时限制。
- MuScriptor 子进程使用参数数组启动，不经过 shell。
- MCP 请求取消或超时时先终止 MuScriptor 进程组，必要时升级为强制终止。

## 前置条件

- Linux
- Node.js 22 或更高版本
- 已安装可执行的 `muscriptor` CLI
- 已在 Hugging Face 接受所选 MuScriptor 模型许可
- 首次下载模型时已通过 `hf auth login` 登录，或设置 `HF_TOKEN`

安装 MuScriptor：

```bash
pip install muscriptor
```

如需 `includeLeadVocal=true`，建议通过隔离的 Python 3.11 uv tool 安装：

```bash
uv tool install --python 3.11 --with numpy demucs
uv tool install --python 3.11 --with 'setuptools<81' basic-pitch
```

`numpy` 和 setuptools 版本限制用于规避当前 Demucs 4.1.0 与 Basic Pitch 0.4.0 的上游依赖声明问题。首次使用 Demucs 会下载人声分离模型。

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
        "MIDI_MCP_DEMUCS_DEVICE": "xpu",
        "MIDI_MCP_BASIC_PITCH_COMMAND": "/home/user/.local/bin/basic-pitch"
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
| `MIDI_MCP_BASIC_PITCH_COMMAND` | `basic-pitch` | 主唱增强使用的 Basic Pitch 可执行文件 |
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
- `leadVocal`：Demucs 与 Basic Pitch 是否可执行。该状态不影响普通 MuScriptor 转录的 `ready`。

该工具不会下载或加载模型。

### `audio_to_midi`

主要参数：

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `source` | 必填 | 允许目录中的本地路径，或公网 HTTPS URL |
| `model` | `medium` | `small`、`medium` 或 `large` |
| `device` | `auto` | `auto`、`cpu`、`cuda`、`cuda:N` 或 `mps` |
| `dtype` | MuScriptor 默认 | `float32`、`float16` 或 `bfloat16` |
| `instruments` | 自动检测 | MuScriptor 乐器组名称数组 |
| `sampling` | `false` | 使用温度采样 |
| `temperature` | `1` | 采样温度，必须大于 0 |
| `cfgCoef` | `1` | classifier-free guidance 系数 |
| `batchSize` | MuScriptor 默认 | 每个 forward pass 的 5 秒分块数 |
| `strictEos` | `false` | 分块没有生成 EOS 时是否失败 |
| `beamSize` | `1` | beam search 宽度 |
| `preludeForcing` | `true` | 跨分块延音前奏强制 |
| `includeLeadVocal` | `false` | 分离人声并新增独立主唱旋律轨；需要 Demucs 和 Basic Pitch |
| `leadVocalVelocity` | `127` | 主唱音符固定 velocity，范围 1～127 |
| `leadVocalAccompanimentVolume` | `89` | 非鼓伴奏通道 CC7 音量，默认约为最大值的 70% |

`batchSize > 1` 要求 `preludeForcing=false`。模型来源只允许官方 `small/medium/large`，避免自定义路径或 URL 绕过 MCP 的文件和网络边界。

成功结果包含 `outputPath`、`outputBytes`、`model`、`sourceKind`、`leadVocalIncluded`，启用增强时还包含 `leadVocalNotes`。本地和 URL 音频都会复制到 0600 权限的私有快照，转录完成或失败后删除。生成结果经 Standard MIDI File 解析验证后才从私有暂存区原子发布。

主唱增强保留 MuScriptor 原有的 `voice` 伴唱轨，新增 `lead vocal` 轨并使用 General MIDI Voice Oohs（Program 54，零基代码 53）。主唱默认使用 velocity 127 和 CC7/CC11 最大值，非鼓伴奏通道默认写入 CC7=89（约 70%），以确保主唱明显可听。MIDI 只保存旋律音高与节奏，不保存真实嗓音或歌词。

## 安全说明

公网地址拒绝策略降低了 SSRF 风险，但不能代替部署环境的出站防火墙。如果内部服务使用公网 IP，应额外配置网络层 allowlist。MCP 服务器拥有其运行账户的权限，建议使用最小化的输入目录和独立输出目录。
