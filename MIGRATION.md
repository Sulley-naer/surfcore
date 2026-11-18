# 跨设备迁移（Windows → Windows）

把 SurfCore（QQ 桥接 + 语音 + 本地语音转写）从旧机搬到新机，按「代码 / 数据 / 运行时」三层分离：

| 层 | 内容 | 迁移方式 |
| --- | --- | --- |
| 代码 | 仓库源码（含语音转写、可移植改动） | `git clone`（从你的 fork） |
| 数据 | QQ 会话映射、记忆卡、角色卡、表情库、黑话库、参考音频 | 导出包（export → restore） |
| 运行时 | Node/Python/ffmpeg、两个 venv、GPT-SoVITS 权重、faster-whisper 模型、SnowLuma | 目标机重建（bootstrap） |

> 为什么 venv 不搬：`state/voice-packs/voice-local/.venv-gsv` 有 5.7G，且 Windows 上 venv 绑定绝对路径，换机必坏，不如在新机用 `requirements*.txt` 重装。

---

## 一、旧机：导出数据包

```powershell
cd D:\surfcore\repo
node scripts/portable/export-port.mjs --voice refs   # 推荐：代码+参考音频，不带 1.5G 权重
# 或 --voice none（纯数据，最小）/ --voice all（连 GPT-SoVITS 权重一起打包，约 1.6G）
# 可选 --mask 打码敏感值；默认只报告不打码（见 manifest.redactions）
```

产物在 `D:\surfcore\repo\_exports\surfcore-port-<时间戳>\`（默认再压成同名 `.zip`），内含：

- `surfcore/` — `repo/state` 的数据（`mode.json`、`sessions.json`、`social-v2.json`、表情库、`console-token`、`phone-tasks.json` 等）
- `surfcore-home/` — `~/.dsh/surfcore` 的合体层（角色卡 `characters/char-*/`、**每角色记忆卡**、`alignments.json` 等）
- `runtimes/` — 新功能运行时脚本：`see-now-voice-adapter.mjs`、`faster-whisper/{transcribe.py,stt_server.py}`、`start-cloudflared.ps1`、`cloudflared-named.bat`、`clean-start-bridge.ps1` 等（**不含 venv / 模型 / 二进制**）
- `dsh-home/` — `~/.dsh` 下与 SurfCore 相关的配置：`voice.json`（TTS adapter）、`asr.json`（听声音）、`see-window.json`（listenPython）、`see-now.json`（listen.source=device）
- `cloudflared/` — `~/.cloudflared/config.yml`（命名隧道 ingress；**凭据 JSON 属密钥，不打包**，新机需 `cloudflared tunnel login` 重建或手动拷贝）
- `templates/` — `config.example.json` + `paths.example.json`（新机照着填）
- `portable/` — `bootstrap-windows.ps1` + `port-doctor.mjs` + `export-port.mjs`（自包含，新机解压就能跑）
- `manifest.json` — 版本、逐文件 sha256、机器路径清单、`runtimesDir` / `cloudflaredConfig` / `scheduledTasks`、跳过的大文件清单、脱敏扫描报告

**明确不打包**：`config.json`（含密钥）、`~/.dsh/surfcore/config.json`、所有 `.venv*`、`backups/`、`billing/`、`*.log`、`bridge.lock`、telemetry jsonl、`~/.cloudflared/*.json`（隧道凭据）。语音包里的权重/venv 见 `--voice` 档位；`runtimes/` 只带脚本，venv/模型/二进制由新机重建。

把 `surfcore-port-<时间戳>.zip` 拷到新机（U 盘 / 网盘都行）。

---

## 二、新机：重建

```powershell
# 解压后进入包目录，运行：
powershell -ExecutionPolicy Bypass -File <包目录>\portable\bootstrap-windows.ps1 -Package <包目录> -Voice refs
# 参数：-RepoDir（默认 D:\surfcore\repo）-RuntimeBase（默认 E:\DeepSeeK）-RuntimeDir（默认 D:\surfcore\runtimes）
#       -SkipVoice / -SkipAsr / -SkipSnowluma 跳过对应重建
```

bootstrap 会依次：装基础工具 → clone 代码仓 → 恢复数据 → **恢复 runtimes/ 与 ~/.dsh 配置、~/.cloudflared/config.yml** → 生成 `config.json`/`paths.json` 模板 → `npm install` + `setup-dsh` → **注册登录自启计划任务（SurfCoreCloudflared / SurfCoreVoiceLocal）** → 重建语音 venv → 提示 faster-whisper / SnowLuma 的手工步骤。

---

## 三、新机：手工填密钥（脚本不会代填）

1. **`repo/config.json`**：`consoleToken`、`snowluma.accessToken`（HTTP 那套）、`admin.qq`、`ownerQQ`、`allow.private`/`allow.groups` 白名单、`consoleToken`。这些是账号凭据，导出包里故意没有。
2. **`repo/paths.json`**：把本机真实路径填进去——`snowlumaHome`、`snowlumaLauncher`、`ffmpeg`、`asrPython`、`asrScript`、`asrModelDir`。优先级：环境变量 > `paths.json` > `config.json` 现有值。
   - 对应环境变量：`SURFCORE_SNOWLUMA_HOME` / `SURFCORE_SNOWLUMA_LAUNCHER` / `SURFCORE_FFMPEG` / `SURFCORE_VOICE_DIR` / `SURFCORE_ASR_PYTHON` / `SURFCORE_ASR_SCRIPT` / `SURFCORE_ASR_MODEL_DIR` / `SURFCORE_ASR_SERVER_PYTHON` / `SURFCORE_ASR_SERVER_SCRIPT`
3. **SnowLuma**：把旧机 SnowLuma 的 `config/onebot_*.json` 搬来（里面有 **WS token**，和 HTTP token 是两套）。`snowluma.accessToken`（HTTP）另填在 config.json。
4. **语音权重**（`--voice refs` 时）：重新下载 GPT-SoVITS 预训练模型到 `state/voice-packs/voice-local/vendor/GPT-SoVITS/code/GPT_SoVITS/pretrained_models/` 和 `models/`。
5. **faster-whisper**（本地转写）：`D:\surfcore\runtimes\faster-whisper\` 的 venv（`python -m venv .venv` + `pip install faster-whisper av==15.1.0 pilk opencc-python-reimplemented numpy pyaudiowpatch`）+ `models/small/model.bin`（hf-mirror 下 `Systran/faster-whisper-small`）。脚本已随包，模型/venv 需重建。
6. **Cloudflare 隧道凭据**：`~/.cloudflared/config.yml` 已随包恢复，但 `2907add0-*.json` 凭据不在包里。新机二选一：① `cloudflared tunnel login` → `cloudflared tunnel create surfcore-phone` → 用新 ID 改 config.yml + `tunnel route dns`；② 手动从旧机拷贝 `C:\Users\<你>\.cloudflared\2907add0-5192-4746-b619-8d3d3356a826.json`。
7. **手机通道令牌**：新机首次启动桥接会自动生成 `state/phone-token`（32 位 hex）。把手机端 `pull_config.json` 的 `baseUrl` 改成新机的局域网地址或隧道域名，`token` 换成新值，并确保手机请求带普通 `User-Agent`（如 `dshgo/1.0`，否则 Cloudflare 返回 403/1010）。
8. **see-now 配置**：`~/.dsh/see-window.json` 的 `listenPython`、`~/.dsh/asr.json` 的 `manage.start`、`~/.dsh/voice.json` 的 `adapter` 里都是旧机的绝对路径，按新机改（adapter/asr 脚本随 `runtimes/` 恢复）。

---

## 四、体检 + 收尾

```powershell
node scripts/portable/port-doctor.mjs     # 全绿即迁移成功（含 runtimes / ~/.dsh / cloudflared / 计划任务 / 8787 检查）
node scripts/test-audit.mjs               # 功能回归（应 111/113，历史失败 2 个属正常）
```

然后**重启 DSH**，让插件与桥接加载新配置，再发一条私聊验证（语音转写 / 表情包 / 主动播报）。

---

## 附：语音包结构（迁移口径）

`state/voice-packs/voice-local/` 里：

- **要随包走**：`voicepack/`（参考音频 wav，你的声线素材）、`config.toml`、`requirements*.txt`、`models.json`、`version.json`、`vendor/**/*.py`（GPT-SoVITS 代码）、`scripts/`、`examples/`、`docs/`、`run.bat`/`gsv.bat`
- **不随包走（重建/重下）**：`.venv`（220M）、`.venv-gsv`（5.7G）、`vendor/**/pretrained_models/`（1.3G）、`models/`（onnx + `.download` 1.8G）、`nltk_data/`（26M）、`cache/`、`logs/`
