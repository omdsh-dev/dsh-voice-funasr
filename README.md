# dsh-voice-funasr


DSH Web UI 的**本地离线语音输入**插件：录音按钮按住说话 → 本地 FunASR 引擎
（paraformer-large + FSMN-VAD + ct-punc，全部官方 int8 ONNX）精准转写 → 可选
**两段式润色**（LLM 修正口头禅/口误）→ 自动进 composer 并发送。本地引擎不可用
时**自动回退**浏览器 Web Speech API。

与 dsh-voice-chat 的差异化：本地 ASR（中文精准、隐私、断网可用）+ 两段式润色。

## 兼容性

- DSH：`>=0.1.0-rc.3 <0.2.0`（Profile Bundle 与嵌套 `dsh.client` 契约）
- Node.js：`^22.19.0 || >=24.0.0`
- Web profile；浏览器需要 `MediaDevices` / `AudioWorklet`，或可用的 Web Speech API 回退

插件由 `package.json#dsh.bundle.patch` 自动加入 profile。不要再把
`dsh-voice-funasr` 手工插入 profile 的 `cordis.patch.yml`，否则同一 loader id 会重复。

## 架构

```
浏览器客户端                       DSH host (Node)                      Python sidecar
RecorderButton ──AudioWorklet 16k PCM16──▶ /asr RPC 通道 ──stdio 行 JSON──▶ funasr_engine.py
（按住说话 + 状态徽标）                  （ctx.connection.rpc）            （funasr-onnx，模型常驻）
设置面板（引擎状态/安装指引/润色开关）
```

- 音频仅在内存流转：base64 PCM → host → 引擎 stdin；引擎的临时 WAV 用后即删，**不落盘**。
- 模型推理全本地，断网可用；唯一可能出网的是可选润色（走用户自己的 LLM 端点，
  与普通对话同信任边界）。
- 实测（Ryzen 7 5800H）：5s 话语端到端 0.4–0.5s（含 VAD+ASR+标点），引擎常驻后
  热转写 ~0.3s；三模型 int8 权重共 ~520MB，引擎内存 ~1GB。

## 安装

### 1. 前置：Python + funasr-onnx

```bash
python3 -m pip install -U funasr-onnx modelscope
# 仅这两个包：funasr-onnx 只依赖 onnxruntime，不需要 torch（省 2GB）
```

### 2. 下载模型（~520MB，int8 官方量化权重）

```bash
python3 python/download_models.py --model-root ~/.dsh/voice-funasr/models
```

默认模型目录 `~/.dsh/voice-funasr/models`（可在 profile 的插件 config 里改
`modelRoot`）。三个子目录：`paraformer/`、`vad/`、`punc/`。

### 3. 安装插件到 profile

```sh
# 在插件 checkout 内安装开发链接
dsh plugin --profile web add .

# 或安装已经验收的发布包
dsh plugin --profile web add ./dsh-voice-funasr-0.1.2.tgz
```

重启 `dsh web`。首次说话前可在 设置 → 本地语音（FunASR）→「加载模型」预热
（约 15s，一次），之后每次识别 ~0.3s。

## 使用

- 输入框左侧麦克风按钮：**按住说话**，松手自动发送（润色开启时先润色再发）。
- 按钮上的小圆点：绿=本地引擎就绪；灰=检测中；红=引擎不可用（已回退浏览器识别）。
- 设置面板：识别后端（自动/仅本地/仅浏览器）、语言、润色开关与模式
  （最小润色/仅纠错/格式化分段）、引擎状态与「重新检测」「加载模型」。

## 隐私与卸载

- 音频默认**不落盘**；无任何遥测；识别文本只进你的会话。
- 卸载：`dsh plugin --profile web remove dsh-voice-funasr`，然后删除模型目录
  `~/.dsh/voice-funasr/` 与 Python 包（可选）：`pip uninstall funasr-onnx onnxruntime modelscope`。

## 配置（cordis.yml / patch）

| 键 | 默认 | 说明 |
|---|---|---|
| `pythonCommands` | `[python3, python]` | 引擎解释器候选（Windows 上 python3 常不存在） |
| `modelRoot` | `~/.dsh/voice-funasr/models` | 模型根目录 |
| `threads` | `4` | onnxruntime 线程数 |
| `channelAuthority` | `loopback` | /asr 通道信任围栏；局域网访问用 `trusted-host` |
| `maxAudioSeconds` | `120` | 单次转写音频上限 |

## 与 dsh-voice-chat 的关系

独立实现，不复用其代码；两个插件都注册 `conversation.input.left` 槽位，
**请勿同时启用**（会出现两个麦克风按钮），选其一即可。

## 开发

```sh
# DSH 私有依赖是 peer，不写入任何个人 staging 的绝对路径
pnpm install
pnpm run dev:link-dsh -- --runtime /path/to/dsh-0.1.0-rc.3/node_modules
pnpm run verify
pnpm pack
```

`dev:link-dsh` 会核验 npm DSH 运行时版本和每个包名，再只在本 checkout 的 `node_modules`
中创建链接；它不会修改 DSH 源码、active profile 或 `package.json`。发布包通过
`prepack` 从干净源码重建 `lib/`。建议再在全新的 `DSH_HOME` 中安装 tarball，执行
`--dump-config` 与真实 Web 启动 smoke。

DSH/React peer 标记为 package-manager optional：它们由所安装的 DSH 与 Web 平台
提供，不应被树外插件复制一份；版本范围仍用于记录并检查兼容契约。

- host 半：`src/index.ts`（tsc → lib/index.js，@deepseek-ai/* 依赖保持外部）
- 引擎：`python/funasr_engine.py`（stdio 行 JSON 协议：boot/status/transcribe/warmup/stats/exit）
- 客户端：`src/client/`（tsdown → lib/client.js，`__ModuleLoader__` 注册）
- 协议冒烟：见 `python/` 内可直接 `echo '{"action":"status","id":1}' | python3 funasr_engine.py --model-root <root>`

## 路线图

- v1：整段识别 + 润色 + 自动回退 + 安装指引 ✅
- v1.1：SenseVoice-Small 质量档后端；自由对话模式
- v2：FunASR 2pass 真流式（paraformer-online + SenseVoice 离线校正）
