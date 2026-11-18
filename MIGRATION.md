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
6. **Cloudflare 隧道凭据**：`~/.cloudflared/config.yml` 已随包恢复，但 `2907add0-*.json` 凭据不在包里。新机二选一：① `cloudflared tunnel login` → `cloudflared tunnel create surfcore-phone` → 用新 ID 改 config.yml + `tunnel route dns`；② 手动从旧机拷贝 `C:\Users\<你>\.cloudflared\2907add0-5192-4746-b619-8d3d3356a826.json`。**完整的安装 + 配置步骤见下一节「三之二」**。
7. **手机通道令牌**：新机首次启动桥接会自动生成 `state/phone-token`（32 位 hex）。把手机端 `pull_config.json` 的 `baseUrl` 改成新机的局域网地址或隧道域名，`token` 换成新值，并确保手机请求带普通 `User-Agent`（如 `dshgo/1.0`，否则 Cloudflare 返回 403/1010）。
8. **see-now 配置**：`~/.dsh/see-window.json` 的 `listenPython`、`~/.dsh/asr.json` 的 `manage.start`、`~/.dsh/voice.json` 的 `adapter` 里都是旧机的绝对路径，按新机改（adapter/asr 脚本随 `runtimes/` 恢复）。

---

## 三之二、Cloudflare 隧道（手机在外网也要能收到任务时才需要）

**先说清楚：这一步 bootstrap 不会替你做**——它只恢复 `config.yml` 和注册启动计划任务，`cloudflared` 本身要装、隧道本身要登录授权，都需要人工。

如果手机和电脑永远在同一个局域网，**可以整节跳过**，手机端 `baseUrl` 直接填 `http://<电脑内网IP>:8787`。

### 1. 安装 cloudflared

```powershell
winget install -e --id Cloudflare.cloudflared
# 装完确认（新开一个终端）
cloudflared --version
```

### 2. 登录 Cloudflare（需要账号，且域名已托管在 CF）

```powershell
cloudflared tunnel login
# 会弹浏览器，选你的域名（如 xinzhi.stream）并授权
# 成功后生成 %USERPROFILE%\.cloudflared\cert.pem
```

### 3. 建一条命名隧道

```powershell
cloudflared tunnel create surfcore-phone
# 输出：Tunnel credentials written to C:\Users\<你>\.cloudflared\<隧道ID>.json
# 记下这个 隧道ID 和 凭据 JSON 路径
```

### 4. 写 `%USERPROFILE%\.cloudflared\config.yml`

```yaml
tunnel: <隧道ID>
credentials-file: C:\Users\<你>\.cloudflared\<隧道ID>.json
ingress:
  - hostname: wake.你的域名
    service: http://127.0.0.1:8787
  - service: http_status:404
```

> `ingress` 最后一条必须是兜底规则，否则 cloudflared 启动会报错退出。

### 5. 给隧道绑域名（DNS 会自动加一条 CNAME）

```powershell
cloudflared tunnel route dns surfcore-phone wake.你的域名
```

### 6. 启动并做开机自启

前台先验证一次：

```powershell
cloudflared tunnel --config "$env:USERPROFILE\.cloudflared\config.yml" run surfcore-phone
```

通了之后做常驻（导出包里已有 `runtimes\start-cloudflared.ps1` 和 `cloudflared-named.bat`，改成新机的隧道名/路径即可）：

- 不要用 `cloudflared service install`——它生成的 Windows 服务 ImagePath 不带 `--config`，服务起来没有 ingress 规则，公网请求会 502（本机踩过）；
- 用计划任务 `SurfCoreCloudflared`（登录时触发，跑 `start-cloudflared.ps1`，脚本内部用 WMI `Win32_Process.Create` 脱离启动 cloudflared）；
- 验证：`schtasks /query /tn SurfCoreCloudflared` 状态 Ready，`cloudflared` 进程在跑。

### 7. 验证

```powershell
# TOKEN 取自 repo\state\phone-token（桥接首次启动自动生成）
curl.exe -H "x-wake-token: <TOKEN>" https://wake.你的域名/v1/ping
# 期望：{"ok":true,"ts":...,"server":"pc"}
```

### 8. 两个必踩的坑

- **UA 拦截**：Cloudflare Bot 检查会把默认 `Python-urllib` 的请求挡成 `403 error code: 1010`。手机端每个请求都要显式带普通 UA（如 `User-Agent: dshgo/1.0`）。
- **临时地址**：没有域名时可以先跑 `cloudflared tunnel --url http://127.0.0.1:8787` 拿一个 `*.trycloudflare.com` 临时地址，每次重启都会变，只适合先验证连通性。

---

## 三之三、DSH 插件（新机重装）

**这一步 bootstrap 也不会替你做。** 插件装在用户目录、不随迁移包走（体积大、且含平台二进制），新机要按清单重装。

### 装在哪

```
%USERPROFILE%\.dsh\profiles\desktop\
  package.json     ← dependencies（版本）+ dsh.profile.bundles（哪些真的加载）
  node_modules\    ← 实际代码
```

只写进 `dependencies` 但没进 `dsh.profile.bundles` 的包**不会加载**。用 `dsh plugin add` 装会自动两处都写。

### 装法

`dsh plugin` 只是把参数转发给 profile 目录里的 pnpm：

```powershell
# dsh 在 PATH 里就用 dsh；桌面版没加 PATH 时用绝对路径
$dsh = "E:\DeepSeeK\resources\runtime\cli\bin\dsh.cmd"

# 版本按旧机锁，避免新机自动升到不兼容版本
& $dsh plugin --profile desktop add dsh-ops@0.4.4 billion-context@0.1.216 dsh-mnemon@0.5.46 cc-safety-net@2.7.1 ds-harness-remote@0.6.5 dsh-see-now@0.2.2
& $dsh plugin --profile desktop add dsh-nekowhale-stickers@1.1.2 dsh-cost-meter@1.9.67 dsh-whale-widget@0.4.2 dsh-better-sidebar@0.28.2 dshmarket@1.73.20 "@michengai/dsh-codex-ui@2.0.9" dsh-plugin-wallpaper-engine@1.4.2
& $dsh plugin --profile desktop add "github:kingcharleslzy-ai/dsh-purge#v1.7.20"
```

装完**重启 DSH**（插件在 DSH 进程内加载，不重启不生效）。

### surfcore 本体是特例：junction，不是 npm 包

repo 里的 `plugins\surfcore` 通过 junction 挂进 profile：

```
%USERPROFILE%\.dsh\plugins\surfcore                      →  <repo>\plugins\surfcore
%USERPROFILE%\.dsh\profiles\desktop\node_modules\surfcore →  link:C:/Users/<你>/.dsh/plugins/surfcore
```

新机在 clone 完代码后跑：

```powershell
cd <repo>
node scripts\setup-dsh.mjs                # 建 junction + 生成 presets + 注册 MCP
& $dsh plugin --profile desktop install   # 把 link: 依赖装上
```

**不要** `dsh plugin add surfcore`——那样会从 npm 拉一个和本地魔改无关的版本。

### 旧机插件清单（2026-11-19 快照）

| 包 | 版本 | 作用 | 必需 |
|---|---|---|---|
| `surfcore` | 0.8.6 | QQ × B站 合体插件（本项目本体，junction） | **必需** |
| `dsh-ops` | 0.4.4 | 本机文件/shell/PTC 工具（`ops_bash` 等来自它） | **必需** |
| `dsh-see-now` | 0.2.2 | 屏幕/摄像头实时视觉感知；TTS/ASR 走 voxd + faster-whisper | 功能需要 |
| `dsh-nekowhale-stickers` | 1.1.2 | 大肥鱼/GPT娘 表情包检索与模板 | 功能需要 |
| `cc-safety-net` | 2.7.1 | 危险命令/密钥文件拦截（`ops_bash`、`qq_run_code` 的网关） | 建议 |
| `billion-context` | 0.1.216 | 上下文压缩（长会话不爆窗） | 建议 |
| `dsh-mnemon` | 0.5.46 | 记忆源/视图 | 建议 |
| `dsh-cost-meter` | 1.9.67 | 会话/当日费用统计 | 可选 |
| `dsh-whale-widget` | 0.4.2 | Web 右下角余额挂件 | 可选 |
| `dsh-better-sidebar` | 0.28.2 | 侧栏文件树/编辑器/变更 | 可选 |
| `@michengai/dsh-codex-ui` | 2.0.9 | 设置皮肤/侧栏/历史召回 UI | 可选 |
| `dsh-plugin-wallpaper-engine` | 1.4.2 | 网页壁纸引擎背景 | 可选 |
| `dshmarket` | 1.73.20 | 插件市场 UI | 可选 |
| `dsh-purge-community` | 1.7.20 | 提示词/规则清洗与备份（github:kingcharleslzy-ai/dsh-purge） | 可选 |
| `ds-harness-remote` | 0.6.5 | P2P 端到端加密远程访问 | 可选 |
| `@deepseek-harness-tui/dsh-tui` | 0.17.0 | 终端 UI；与桌面版 0.2.1-rc.5 有版本告警 | 不用装 |

### 想一字不差地恢复版本

旧机的 profile `package.json` 只有几 KB，可单独备份；新机覆盖同路径后：

```powershell
& $dsh plugin --profile desktop install
# surfcore 那行是 link: 本地路径 —— 先跑 setup-dsh 再 install
```

`dependencies` 和 `dsh.profile.bundles` 两段都要在，否则包装了也不加载。

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
