# MIDI 转译标准工作流

## 适用范围

本文定义本项目处理普通音乐和需要保留人声音乐时的标准流程。除非用户明确要求速度优先，否则统一使用高质量顺序转译配置。

## 共同前置条件

- MCP 使用 TypeScript 构建产物 `dist/index.js`。
- MuScriptor 使用 fork 的系统包启动脚本：`/home/sanae/CodeProject/pythonPro/muscriptor-fork/scripts/muscriptor`。脚本从当前 fork 导入源码，并加载 pacman `python-pytorch-xpu` 所需的 oneAPI 环境；禁止使用 uv/pip 虚拟环境或上游 AUR `muscriptor` 包。
- Intel Arc Graphics 必须通过 `torch.xpu.is_available()` 检测成功。
- 模型推理使用 Intel XPU；音频解码、文件暂存和 MIDI 编码仍由 CPU 处理。
- 输入必须位于 `MIDI_MCP_ALLOWED_INPUT_DIRS` 允许目录中。
- 输出统一写入 `MIDI_MCP_OUTPUT_DIR`。
- 使用 `outputFileName` 指定可读文件名。只允许 basename，自动补 `.mid`，已存在时拒绝覆盖。
- 默认使用 `large` 模型和 `float16`。用户明确表示不在乎精度或要求快速预览时才改用 `small`。

推荐 OpenCode 环境：

```json
{
  "MIDI_MCP_MUSCRIPTOR_COMMAND": "/home/sanae/CodeProject/pythonPro/muscriptor-fork/scripts/muscriptor",
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

## 工作流 B：分离后折叠 MuScriptor 人声

### 目标

调用 `vocal_audio_to_midi`：先使用 Demucs 分离人声与伴奏，以已验收的 voice 约束和 beam-first 空块回退转写人声，再转写伴奏并合并完整 MIDI。不使用 Basic Pitch。

### 第一步：Demucs 分离

执行：

```bash
demucs --two-stems=vocals --device xpu --out <private-work-dir> <audio>
```

必须同时得到 `vocals.wav` 和 `no_vocals.wav`。缺少任一 stem 都终止，不发布半成品。

### 第二步：转写人声

先只转写 `vocals.wav`，默认参数如下：

- 使用项目指定的 `ALLLLLL703/muscriptor` fork，不得切换回上游 PyPI 版本或其他转写模型。
- 使用 `large`、XPU、float16、batch 1、prelude forcing、全局 beam 1、CFG 1。
- 固定传入 `instruments:["voice"]`。
- 空块默认重试 3 次：第一次 beam 3，随后 temperature 0.6、CFG 1.75 采样。
- 正式 MCP 工具自动继续完整流水线；只有参数或源码实验需要单独保留人声 MIDI 并通过 question 试听验收。

### 第三步：转写伴奏

- `no_vocals.wav` 保留用户传入的 `instruments` 过滤，生成基础伴奏 MIDI。
- 伴奏使用确定性 `beamSize=1`、`cfgCoef=1`，与已验收完整 MIDI 的伴奏参数一致。
- 伴奏关闭 `emptyOutputRetries`，避免对无指定乐器的伴奏强制补音。
- 人声与伴奏 MuScriptor 推理顺序执行，不并发争抢 XPU 显存。
- 不转写原始混音，避免一次无效的额外推理。

### 第四步：折叠并合并人声

- 读取 `vocals.wav` 转写 MIDI 的全部音符轨。
- 忽略源轨 program 和名称，使用音符的绝对秒位置映射到伴奏 MIDI 的 tempo map。
- 将全部人声音符写入单一 `lead vocal` 轨，使用 Choir Aahs（零基 Program 52）。
- 主唱所有 note-on velocity 使用 `leadVocalVelocity`，CC7/CC11 固定为 127。
- 非鼓伴奏通道写入 `leadVocalAccompanimentVolume`。
- 保留 `no_vocals.wav` 伴奏 MIDI 的 tempo、PPQ、meta 事件和全部原轨。
- 最终文件仍通过私有暂存和排他发布，拒绝覆盖已有结果。

使用 `midi-file` 保留基础伴奏事件，只用 Tonejs/Midi 读取人声源轨的秒级音符。不要用 Tonejs 全量重编码基础 MIDI，因为它可能拆分轨道或丢失未建模事件。

### 人声增强验证

1. 输出基础轨来自 `no_vocals.wav` 转写结果，而不是原混音。
2. `lead vocal` 音符数量等于人声 stem MIDI 全部源轨音符数量之和。
3. `lead vocal` velocity 等于请求值，CC7 和 CC11 均为 `1.0`。
4. `lead vocal` program 为零基 52，不得使用 Voice Oohs 53。
5. 人声源 MIDI 与伴奏 MIDI PPQ 或 tempo 不同时，起音秒数仍保持一致。
6. 最终 MIDI 可解析，输出权限为 0600，私有 stem 工作目录已清空。

### 实验阶段规则

在人声方案尚未通过试听验收时，不使用生产请求的自动清理策略：

- 如果已有用户试听确认的 `vocals.wav` 和 `no_vocals.wav`，直接复用，不重复运行 Demucs。
- 在 `MIDI_MCP_OUTPUT_DIR/stems/<song>/<experiment>/` 下保留两个 stem、两次 MuScriptor 原始输出、每个分段 WAV/MIDI、折叠后的人声源 MIDI 和最终合并 MIDI。
- 自动音色、强制 voice、分段等不同策略必须使用不同文件名，禁止覆盖失败结果；空 MIDI 也保留为失败证据。
- 所有实验目录权限设为 0700，文件权限设为 0600。
- 只有方案通过试听验收后，才更新 `vocal_audio_to_midi` 的生产默认值并恢复请求结束自动清理。
- 即使已有可用伴奏 MIDI，新生成的人声版本也必须先独立试听验收；不得利用已有伴奏绕过 question 门。

## 禁止的默认流程

- 禁止使用 Demucs + Basic Pitch 生成 `lead vocal` 轨。实测会出现明显音准错误和异常高音。
- 人声 stem 必须传 `instruments:["voice"]`，并使用 fork 的空块回退补偿稀疏分块。
- 不通过降低模型质量、增加 batch size 或关闭 prelude forcing 来伪装加速，除非用户明确选择速度优先。
- 不覆盖历史 MIDI 文件。
