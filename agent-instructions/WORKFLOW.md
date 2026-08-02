# MIDI 转译标准工作流

## 适用范围

本文定义本项目处理普通音乐和需要保留人声音乐时的标准流程。除非用户明确要求速度优先，否则统一使用高质量顺序转译配置。

## 共同前置条件

- MCP 使用 TypeScript 构建产物 `dist/index.js`。
- MuScriptor 使用隔离安装的 XPU 版本：`/home/sanae/.local/bin/muscriptor`。
- Intel Arc Graphics 必须通过 `torch.xpu.is_available()` 检测成功。
- 模型推理使用 Intel XPU；音频解码、文件暂存和 MIDI 编码仍由 CPU 处理。
- 输入必须位于 `MIDI_MCP_ALLOWED_INPUT_DIRS` 允许目录中。
- 输出统一写入 `MIDI_MCP_OUTPUT_DIR`。
- 使用 `outputFileName` 指定可读文件名。只允许 basename，自动补 `.mid`，已存在时拒绝覆盖。
- 默认使用 `large` 模型和 `float16`。用户明确表示不在乎精度或要求快速预览时才改用 `small`。

推荐 OpenCode 环境：

```json
{
  "MIDI_MCP_MUSCRIPTOR_COMMAND": "/home/sanae/.local/bin/muscriptor",
  "MIDI_MCP_ALLOWED_INPUT_DIRS": "/home/sanae/go-musicfox:/home/sanae/Music:/home/sanae/Downloads",
  "MIDI_MCP_OUTPUT_DIR": "/home/sanae/Music/midi-output",
  "MIDI_MCP_PROCESS_TIMEOUT_MS": "3600000"
}
```

## 工作流 A：非人声或普通转译

### 目标

仅使用 MuScriptor 生成多轨 MIDI，不运行 Demucs、Basic Pitch 或任何额外主唱旋律提取。

### MCP 参数

```json
{
  "source": "/absolute/path/to/audio.mp3",
  "outputFileName": "song-large-xpu",
  "model": "large",
  "device": "xpu",
  "dtype": "float16",
  "includeLeadVocal": false,
  "preludeForcing": true
}
```

### 质量规则

- 不设置 `batchSize`，让 MuScriptor 使用顺序分块，即实际 batch size 为 1。
- 保持 `preludeForcing=true`，减少分块边界出现错误乐器、断音或重启音符。
- 禁止在正式高质量输出中使用 `batchSize=4 + preludeForcing=false`。该组合只适合快速预览，会降低分块边界质量。
- 不使用主唱增强流水线，避免 Basic Pitch 对复杂人声产生错误音高。

### 完成验证

1. MCP 返回 `leadVocalIncluded=false`。
2. 使用 `file` 确认输出是 Standard MIDI data。
3. 解析轨道名称、program、音符数量和持续时间。
4. 确认输出文件权限为 `0600`。
5. 向用户报告模型、XPU、FP16、耗时、轨道和音符数量。

## 工作流 B：保留并增强 MuScriptor 原生人声

### 目标

使用 MuScriptor 自己识别的 `voice` 轨保留人声旋律，再只调整该轨的 MIDI 响度。该流程不重新估计人声音高，因此不会引入 Basic Pitch 主唱音准偏差。

### 第一步：标准 MuScriptor 转译

先执行工作流 A。保持：

```json
{
  "model": "large",
  "device": "xpu",
  "dtype": "float16",
  "includeLeadVocal": false,
  "preludeForcing": true
}
```

MuScriptor 自动检测乐器，不传 `instruments:["voice"]`，否则会硬性排除其他乐器。转译后必须检查是否存在名称为 `voice` 的轨道。

如果没有 `voice` 轨：

- 不得伪造成功结果。
- 不得自动启用 Demucs + Basic Pitch。
- 向用户说明 MuScriptor 没有识别人声，并询问是否接受其他方案。

### 第二步：增强现有 voice 轨

保留原始 MIDI，另存为 `<原名>-voice-boost.mid`。在 Standard MIDI 原始事件层完成以下修改：

- 只选择轨道名严格等于 `voice` 的轨道。
- 将该轨所有非零 `noteOn.velocity` 设置为 `127`。
- 在该轨使用的 MIDI 通道写入 CC7 Channel Volume `127`。
- 在该轨使用的 MIDI 通道写入 CC11 Expression `127`。
- 保留 Choir Aahs program、音高、起止时间、其他控制事件及所有其他轨道。
- 以排他创建方式写入新文件，拒绝覆盖已有结果。

优先使用项目已有的 `midi-file` 直接修改原始 SMF 事件。不要用 Tonejs 全量重编码基础 MIDI，因为它可能拆分轨道或丢失未建模事件。

不要默认使用 `midish` 重新导出：它可通过 `tvcurve 63` 提升 velocity，但导入/导出只保留有限 meta 事件，可能丢失轨道名称和其他元数据。只有用户明确接受该损失时才使用。

### 人声增强验证

1. 输出 MIDI 的 format、PPQ 和轨道数量与原文件一致。
2. `voice` 轨音符数量与原文件一致。
3. `voice` 轨 velocity 的 min、avg、max 均为 `1.0`，即 127/127。
4. `voice` 轨 CC7 和 CC11 均为 `1.0`。
5. 其他轨道的音高、节奏、program 和音符数量保持不变。
6. 原文件保留，新文件使用 `-voice-boost.mid` 后缀。

## 禁止的默认流程

- 不默认使用 Demucs + Basic Pitch 生成 `lead vocal` 轨。实测该方案会出现明显人声音准错误。
- 不把“存在 voice 音色”误报为“准确提取了主唱”。必须检查实际轨道内容。
- 不通过降低模型质量、增加 batch size 或关闭 prelude forcing 来伪装加速，除非用户明确选择速度优先。
- 不覆盖历史 MIDI 文件。
- 不因响度不足重新运行音频转录；优先对已生成 MIDI 的原生 `voice` 轨做无损事件级响度调整。
