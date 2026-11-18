# 视觉感知融合（dsh-see-now）：看得见、说得出、听得见

> 2026-11-17 接入。目标：让 DSH 侧的 agent（桌面 GUI 的我，以及后续 QQ 侧的她）**能看屏幕、
> 用自己的声音说话、能听系统声音转文字**，并且这些能力尽量复用 SurfCore 已有的语音基建。

- 插件：[`dsh-see-now`](https://github.com/SAOS-3624/dsh-see-now)（Apache-2.0，npm 包同名）
- 本机安装版本：**0.2.2**，装在 desktop profile
- 插件目录：`C:\Users\xin_zhi\.dsh\profiles\desktop\node_modules\dsh-see-now`

---

## 一、装了什么

```bash
dsh plugin --profile desktop add dsh-see-now   # 装完必须重启 DSH
```

装完重启 DSH 后：

- 工具 `see_now` 出现（主 GUI 会话与 QQ 侧会话能否调用，取决于各自的工具白名单）；
- 斜杠命令 `/seenow` 注册（开窗 / `off` / `status` / `show` / `hide`）；
- 首次 `watch` 会拉起悬浮窗（Tk 实现，`npx dsh-see-window`）。

**SurfCore 侧唯一改动**：`plugins/surfcore/qq-tool-restrict.mjs` 的 `SAFE_EXACT` 加入
`'see_now'`（提交 `1ddde19`），否则 QQ 桥接会把她的 `see_now` 调用当越权工具拒掉。

---

## 二、三条链路

### 2.1 看（屏幕 → 宫格图喂模型）

`see_now({ action: "watch" | "peek" | "status" | "stop" | ... })`

- 采集：ffmpeg（Windows 优先 ddagrab，失败自动退 gdigrab）；一张图拼 4~8 帧；
- 筛选：64×36 网格 HSV 变化分 0~255，静止几乎不出图（光标 ≈0.7、切窗口 30~42）；
- 画布：798×462（low）/ 1050×630 / 1260×756 / 1596×924，token 约 222 / 392 / 560 / 860 每张；
- `pace` 控制"多久算换一次画面"：`calm` 省钱、`normal` 默认、`dense` 灵敏、`game-economic` 只适合动作游戏；
- `say` 是**唯一**进悬浮窗并被 TTS 念出来的通道；工具返回的图是 DSH GUI 内联展示。

### 2.2 说（她自己的声音朗读）

`~/.dsh/voice.json`：

```json
{
  "adapter": "D:/surfcore/runtimes/see-now-voice-adapter.mjs",
  "options": {
    "baseUrl": "http://127.0.0.1:8765",
    "character": "xiaoyu",
    "maxQueue": 4,
    "maxAgeMs": 30000,
    "timeoutMs": 90000
  }
}
```

- 适配器文件：`D:\surfcore\runtimes\see-now-voice-adapter.mjs`（**repo 外**，不进 git）
  - 监听 `due` 事件 → 串行队列 → `POST http://127.0.0.1:8765/v1/speak/file`
    `{text, format:'wav', sr:24000, cache:true, character|voice}` → wav 字节 + `x-duration-ms`；
  - 播放：`powershell.exe -NoProfile -Command "$s = New-Object System.Media.SoundPlayer '<wav>'; $s.PlaySync()"`；
  - **播放前一瞬** `emitSpoken({state:'spoken', durationMs})`（展示层靠它决定何时写字）；
  - `noPlay:true` 只合成不播（调试用）；`maxQueue` 满丢最旧、`maxAgeMs` 超龄跳过；
  - **预热**：attach 时后台合成一句「嗯」，把 voxd/gsv 冷启动（首次约 30 秒）藏起来；
- 音色走 SurfCore 语音包（`state/voice-packs/voice-local`，voxd 8765 / GPT-SoVITS 9880），
  默认 `xiaoyu` → `loli12-gsv`（见 `docs/VOICE-PACKS.md`）。

### 2.3 听（系统声音回环 → 转文字）

`~/.dsh/asr.json`：

```json
{
  "baseUrl": "http://127.0.0.1:8766",
  "api": "openai-audio",
  "key": "",
  "model": "small",
  "language": "zh",
  "manage": {
    "start": [
      "D:/surfcore/runtimes/faster-whisper/.venv/Scripts/python.exe",
      "stt_server.py", "--host", "127.0.0.1", "--port", "8766",
      "--model", "models/small", "--device", "cpu", "--compute-type", "int8"
    ]
  }
}
```

- 转写服务：`D:\surfcore\runtimes\faster-whisper\stt_server.py`（**repo 外**）
  - 原有 `GET /health`、`POST /transcribe {audio_base64}`；
  - **新增** OpenAI 兼容 `POST /audio/transcriptions`：支持 multipart（`file` 字段）与 JSON
    `{audio_base64, model, language}`，返回 `{"text": "..."}` → 见-now 的 `openai-audio` 直接能用；
- 采集：`pyaudiowpatch` 抓 WASAPI loopback；
  - 装包：`D:/surfcore/runtimes/faster-whisper/.venv/Scripts/python -m pip install pyaudiowpatch`；
  - 解释器：`~/.dsh/see-window.json` → `{"listenPython":"D:/surfcore/runtimes/faster-whisper/.venv/Scripts/pythonw.exe"}`
    （不给就报「没在听 —— 没有能用的 Python」）；
- **必须指定设备源**：`~/.dsh/see-now.json` → `{"listen": {"source": "device"}}`
  - `source` 默认 `auto`，实测会选中**进程回环**（`media-bridge-win32-x64.exe`）→ 只抓那个进程的音频，
    系统播放的声音完全收不到，电平恒 `-95dB`、0 句、无 `seg-*.wav`；
  - 改 `device` 后正常：电平 -20 dB 左右、播放期间生成 `seg-*.wav`、转写正常。

---

## 三、文件与配置清单

### repo 内（进 git）

| 文件 | 改动 |
| --- | --- |
| `plugins/surfcore/qq-tool-restrict.mjs` | `SAFE_EXACT` 加 `'see_now'`（提交 `1ddde19`） |

### repo 外（本机，不进 git；换机需重建）

| 路径 | 作用 |
| --- | --- |
| `C:\Users\xin_zhi\.dsh\profiles\desktop\node_modules\dsh-see-now` | 插件本体（`dsh plugin add` 安装） |
| `D:\surfcore\runtimes\see-now-voice-adapter.mjs` | TTS 适配器（接 voxd） |
| `C:\Users\xin_zhi\.dsh\voice.json` | 指向上面的适配器 + options |
| `C:\Users\xin_zhi\.dsh\asr.json` | 听声音的转写服务（8766 / openai-audio） |
| `C:\Users\xin_zhi\.dsh\see-window.json` | `listenPython` 指向 faster-whisper venv 的 pythonw |
| `C:\Users\xin_zhi\.dsh\see-now.json` | 插件行为配置（本例只设 `listen.source=device`） |
| `D:\surfcore\runtimes\faster-whisper\` | STT 服务 + 模型（`stt_server.py` / `transcribe.py` / `models/small`） |
| `D:\surfcore\repo\state\voice-packs\voice-local\` | 本地语音包（voxd 8765 / gsv 9880） |

---

## 四、生效条件（重要）

| 改了什么 | 要做什么 |
| --- | --- |
| `~/.dsh/see-now.json`（如 `listen.source`） | **重启 DSH**（插件加载时读一次，无热重载） |
| `~/.dsh/voice.json` / 适配器文件 | **重启 DSH**（适配器在插件加载时 import） |
| `~/.dsh/asr.json` / `see-window.json` | 重新 `stop`→`watch` 即可（下一轮采集生效） |
| `stt_server.py` / 语音包 | 重启对应进程（STT 8766 / `run.bat`） |
| `qq-tool-restrict.mjs` | **重启 DSH**（模块在 DSH 进程内加载） |

---

## 五、排障

| 现象 | 原因 / 处置 |
| --- | --- |
| `ffmpeg exit ... gdigrab: Failed to capture image (error 5)` / `Desktop duplication access denied` | **屏幕锁屏**（LogonUI 在跑）。解锁后再 `watch`，不是代码问题 |
| 听声音「没在听 —— 没有能用的 Python」 | 装 `pyaudiowpatch` + 写 `~/.dsh/see-window.json` 的 `listenPython` |
| 听声音「在听」但累计 0 句、`levels.json` 全 -95dB | `listen.source` 是 `auto` 且选中了进程回环 → 改 `device` 并重启 DSH |
| 首次 `say` 要等 ~30 秒才出声 | voxd/gsv 冷启动；适配器已加预热，热态新文本约 2~3 秒 |
| 8766 有两个进程同时 LISTENING | 旧进程没退（taskkill 在 MSYS 下 `/PID` 会被改写，用 `cmd //c "taskkill /PID <pid> /F"`） |
| 悬浮窗没出来 | `npx dsh-see-window --status`；窗口日志 `~/.dsh/see-now-window.log` |

---

## 六、已知限制 / 待验证

1. **QQ 侧的她能否看图**：`see_now` 已过白名单，但她的会话模型（`deepseek-account/deepseek-flash`）
   是否支持图像输入**尚未验证**；不支持则需换支持视觉的模型或让桌面侧代看。
2. **听声音需重启 DSH 后复验**：`listen.source=device` 已写，等下一次重启后播一段系统声音，
   确认 `status` 里累计句数 > 0。
3. 长会话看图会累积图片，触发宿主「图片省略」（默认 20 MiB ≈120 张）并破坏前缀缓存 → 陪看宜分段。
4. 派子代理看图一次约 22K token，不划算；直接在主会话看。
5. 插件自带的「结果预览对话框」**不存在**：UI 只有悬浮窗 + 采集指示框；工具结果是 DSH GUI 内联展示。
