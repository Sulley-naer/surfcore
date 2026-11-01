<!-- ⚠️ 自用改动记录（维护备忘） -->

## 对 SurfCore 的改动（自用）

> 本仓库是自用 fork（`Sulley-naer/surfcore`，上游 `origin = Mieksido/surfcore`）。
> 自用改动在 `feat/voice-asr` 分支（语音转写 + 发图 + 受控命令 / 后台任务 / 日程），迁移工具在 `feat/portable` 分支（基于 `feat/voice-asr`）。
> 上游基线：已合并到 **v0.8.6**（2026-11-01）。**暂不合并进 `main`**（合进后设置页「一键更新」的 `--ff-only` 会永久失效），更新上游走手动 `git fetch origin && git merge origin/main`，`main` 保持干净。

### 新增：收到 QQ 语音自动转写

- `src/voice-asr.mjs`（新增）：转写控制器 —— 先问 QQ `fetch_ptt_text`，失败走本地 faster-whisper；按 messageId 缓存、限并发、超时降级；管理常驻 STT 服务（自启动 / 复用 / 退出回收）。
- `src/bridge.js`（改动）：`segmentsToText` 的 `record` 分支接入转写（输出 `[语音] 文本`）；`main()` 启动时自拉起 STT 服务。
- `scripts/test-voice-asr.mjs`（新增）＋ `scripts/test-audit.mjs` / `scripts/audit-bridge-harness.mjs`（登记/接线）。
- 运行时（不在 git 里）：`E:\DeepSeeK\faster-whisper\`（venv + small 模型 + `transcribe.py` + `stt_server.py`，常驻端口 8766）。
- 配置：`config.json` 的 `socialV2.voice.asr`（gitignored，不随仓库走）。
### 新增：把图片真正发到 QQ（`qq_send_image`）

`sticker_send` 之类的插件只返回 `![名字](本地路径或 URL)`，QQ 客户端看不见；这个工具负责把图真的发出去。

- `src/bridge.js`：新增 `sendImageV2()` 与端点 `POST /api/socialV2/send-image`。入参支持本地路径 / `http(s)` URL / `base64://` / Markdown 图片行（自动剥掉 `![..](..)` 外壳），统一转 base64 走 SnowLuma 的 `image` 段；挂在 `sendChain` 上保证「先文字后图」。沿用 agent token、白名单、reserved2、静默模式四道校验，单图 8MB 上限。
- `src/bridge.js`：新增 `loopbackImageUrl()`。SSRF 防护（`src/safe-fetch.js`）原本拒绝一切内网/回环地址，而表情包插件默认把图回成 `http://127.0.0.1:4386/x-nekowhale-stickers/s/<hash>.gif`，于是发图必然报「禁止访问内网/本机地址」。现在只放行「回环 host（`127.0.0.1` / `localhost` / `::1`）＋ 命中 `socialV2.images.loopbackPrefixes` 的路径前缀」（默认 `["/x-nekowhale-stickers/"]`），其余地址仍走 `safeFetchBuffer`，不会被诱导去读本机别的接口。
- `src/mcp-snowluma-safe.js`：注册 MCP 工具 `qq_send_image`（参数 `key` / `token` / `image` / `caption?` / `replyToMessageId?` / `atUserId?`）。
- `plugins/surfcore/qq-tool-restrict.mjs`：`SAFE_EXACT` 增加 `sticker_search`、`sticker_send`、`meme_render`、`sticker_manage`，否则表情包插件的工具一调就被桥接守卫拒绝（该模块在 DSH 进程内加载，改完要重启 DSH）。
- `dsh/agent-presets/qq-chat-v2/agent.cordis.yml`：表情段落补一句用法——`sticker_send` 的返回值要交给 `qq_send_image` 才会真的出现在 QQ 里。
- 配置：`config.json` 的 `socialV2.images.loopbackPrefixes`（gitignored）。
- 生效条件：改 `src/` 要重启桥接；改 MCP 工具/preset 要重启 DSH 并重跑 `node scripts/setup-dsh.mjs`。

### 新增：跨设备迁移工具（路径抽象 + 导出/重建/体检）

换新机时不用手动改一堆绝对路径，也避免把 5.7G 的 venv 和密钥搬来搬去。改在 `feat/portable` 分支。

- `src/runtime-paths.js`（新增）：9 个路径键的解析层，优先级 环境变量 > `paths.json` > `config.json` 现有值 > 默认；相对路径按仓库根解析。`paths.json` 不存在时零行为改变。
- `paths.example.json`（新增）＋ `.gitignore`（忽略 `paths.json`、`_exports/`、`roles/阿眠.md`）。
- `src/bridge.js` / `src/voice-asr.mjs` / `scripts/audit-bridge-harness.mjs`（改动）：接线 `applyRuntimePaths` 与 `runtimePath`，把 snowluma home、ffmpeg、asr 的 python/script/modelDir 抽成可配置路径。
- `scripts/portable/export-port.mjs`（新增）：导出数据包（`--voice none|refs|all`、`--mask`、`--no-zip`、`--dry-run`），逐文件 sha256 + 脱敏扫描进 `manifest.json`。
- `scripts/portable/bootstrap-windows.ps1`（新增）：新机重建（装工具 / clone / 恢复数据 / 重建 venv）。
- `scripts/portable/port-doctor.mjs`（新增）：迁移后体检（数据/路径/语音/ASR/SnowLuma 逐项 PASS/WARN/FAIL）。
- `MIGRATION.md`（新增）：完整迁移手册。

**怎么迁移（`feat/portable` 分支上）**

旧机（现在这台）导出：

```powershell
cd D:\surfcore\repo
git checkout feat/portable
node scripts/portable/export-port.mjs --voice refs
# 产物：_exports\surfcore-port-<时间戳>.zip（内含 portable\ 三个脚本，自包含）
```

`--voice` 三档：`none`（纯数据，最小）/ `refs`（推荐，含语音代码＋参考音频，约 85MB）/ `all`（连 GPT-SoVITS 权重一起，约 1.6G）。

把 zip 拷到新机，解压后直接跑（不用先 clone，bootstrap 会自己 clone）：

```powershell
powershell -ExecutionPolicy Bypass -File <包目录>\portable\bootstrap-windows.ps1 -Package <包目录> -Voice refs
```

手工填密钥（脚本故意不代填）：

- `repo\config.json`：`consoleToken`、`snowluma.accessToken`（HTTP）、`admin.qq`、`ownerQQ`、`allow` 白名单
- `repo\paths.json`：本机路径（SnowLuma / ffmpeg / faster-whisper）
- SnowLuma 的 `config\onebot_*.json`（WS token，和 HTTP 是两套）从旧机搬来

体检收尾：

```powershell
node scripts\portable\port-doctor.mjs   # 全绿即成功
node scripts\test-audit.mjs             # 106/108（历史失败 2 个属正常）
```

然后重启 DSH。完整手册见 `MIGRATION.md`。

### 新增：owner 受控命令执行（`qq_run_code`）

让 QQ 私聊里的管理员能让我在本机跑命令，一问一答式，结果贴回 QQ。**默认黑名单模式**：放行任意命令、只拦破坏性指令（递归/强制删除、格式化、关机、改 ACL、注册表、杀进程、服务/账户操作等）；可切回**白名单模式**（首词白名单，仅只读命令）作保守回退。

- `src/qq-exec.mjs`（新增）：命令策略 + 执行器，支持 `mode: blacklist|whitelist`（默认 blacklist）。黑名单模式＝破坏性指令黑名单（扫描整条命令，拦 `del /s`·`rm -rf`·`format`·`shutdown`·`icacls`·`reg delete`·`taskkill`·`sc stop`·`net user`·`robocopy /mir`·fork bomb 等）＋ 高危元字符（拒反引号 `$ % ^` 与控制符，放行 `; | & < > ( )` 拼接/重定向/分组）；白名单模式＝旧的首词白名单＋危险词。两种模式都超时 60s ＋ 输出截断 8k。
- `src/bridge.js`（改动）：端点 `POST /api/socialV2/run-code`。owner 强校验（`key === private:ownerQQ`，非主人 403）＋ agent token ＋ reserved2 ＋ 工具开关四道校验；黑名单模式 `cwd` 用用户主目录、不脱敏路径（要「动整台电脑」），白名单模式 `cwd` 用 repo 根并脱敏；执行留痕 `state/owner-audit.jsonl`（`qq_run_code` 事件，不写 token）。
- `src/mcp-snowluma-safe.js`（改动）：注册 MCP 工具 `qq_run_code`（参数 `key` / `token` / `command`）。
- `scripts/test-qq-exec.mjs`（新增）＋ `scripts/test-audit.mjs` / `scripts/audit-bridge-harness.mjs`（登记 / 接线）。
- 配置：`config.json` 的 `socialV2.exec`（`mode` / 超时 / 输出上限 / 总开关）与 `socialV2.tools.runCode`（工具开关，默认开）。
- 生效条件：改 `src/` 要重启桥接；改 MCP 工具要重启 DSH 并重跑 `node scripts/setup-dsh.mjs`。

### 新增：owner 后台任务队列（`qq_task_run` / `qq_task_status` / `qq_task_cancel`）

让 QQ 私聊里的管理员能挂长任务（下载/安装/构建）到后台队列，不占对话回合；完成/失败后我自然醒来时先汇报任务，失败或要拍板的任务当场主动通知主人。并发 2、排队上限 10；执行日志写文件（对话里只报路径）；唤醒 prompt 注入【任务】块；命令策略与 `qq_run_code` 共用黑名单模式。

- `src/owner-tasks.mjs`（新增）：纯逻辑状态机。`TASK_STATE_VERSION=1`；默认配置 `maxActive:2 / maxQueue:10 / defaultTimeoutMs:30min / maxTimeoutMs:6h / maxHistory:50`；状态 `pending/running/done/failed/need-decision/cancelled`；`createTask`（超队拒 `queue-full`）/ `startTask` / `finishTask` / `cancelTask`（只撤 pending，running 第一版不喊停）/ `pendingReports`（done 类且未汇报）/ `urgentReports`（failed/need-decision）/ `reportBlock`（汇报块，紧急在前、只放结论与日志路径）/ `summarize`。重启时 running→failed 并补「桥接重启，任务中断」。
- `src/bridge.js`（改动）：import/归一化 `cfg.socialV2.ownerTasks`；状态文件 `state/owner-tasks.json`、日志目录 `state/task-outputs/<id>.log`；后台执行器 `spawn cmd /c` + 超时 kill + drain 循环；端点 `POST /api/socialV2/task-run`（owner-only、agent token、reserved2、`tools.taskRun`、`ownerTasks.enabled`、命令策略同 qq_run_code）、`/api/socialV2/tasks`（状态概览）、`/api/socialV2/task-cancel`（撤排队）；通知调度 `scheduleOwnerTaskNotify`（urgent 才 force purpose 当场打断，普通攒着）；`markNotified` 收口 = 唤醒注入任务块后她给主人私聊发出消息即标已汇报（`recordSentMessagesV2` 钩子）；direct wake prompt 与 `purposeContextBlocks` 都注入【任务】块；启动时 `drainOwnerTasks` + 30s 后 `scheduleOwnerTaskNotify`；审计留痕 `qq_task_run` / `qq_task_cancel`。
- `src/mcp-snowluma-safe.js`（改动）：注册 MCP 工具 `qq_task_run`（`key/token/title/command/timeoutMs`）、`qq_task_status`、`qq_task_cancel`。
- `scripts/test-owner-tasks.mjs`（新增）＋ `scripts/test-audit.mjs` / `scripts/audit-bridge-harness.mjs`（登记 / 接线）。
- 配置：`config.json` 的 `socialV2.ownerTasks`（`enabled/maxActive/maxQueue/defaultTimeoutMs/maxTimeoutMs/maxHistory/summaryMaxChars`）与 `socialV2.tools.taskRun / taskStatus / taskCancel`（默认开）。
- 生效条件：同上（重启桥接 + 重启 DSH + `setup-dsh`）。

### 新增：owner 日程 / 定时器（`qq_schedule_add` / `qq_schedule_list` / `qq_schedule_cancel`）

让她能把一件事排到某个时间点（「晚上 8 点去刷两条 B 站，等你下班把链接甩给你」）：到点桥接唤醒她、把【日程】块（含刚触发的日程）注入她的唤醒 prompt，由她自主用工具执行并汇报。支持一次性与每天重复；重启不丢；可查可取消。

- `src/schedules.mjs`（新增）：纯逻辑。`SCHEDULE_VERSION=1`；默认配置 `maxItems:50 / summaryMaxChars:500 / fireWindowMs:5min`；`parseClockTime`（`HH:mm` / `HH:mm:ss` / 绝对毫秒时间戳；今天已过则排到明天）；`addSchedule`（超上限拒）/ `dueSchedules` / `fireSchedule`（daily 触发后 dueAt 自动 +24h 保持 pending；一次性触发后 status→done）/ `cancelSchedule` / `scheduleBlock`（唤醒注入块：最近触发 + 待触发列表）/ `summarize`。
- `src/bridge.js`（改动）：import/归一化 `cfg.socialV2.schedules`；状态文件 `state/schedules.json`；`checkSchedules()` 每 30s 检查到期 → `fireSchedule` + `deliverPrompt(ownerPrivateKey, '', { wakeReason: 'schedule' })` 唤醒她自己执行；`buildWakePromptV2` 新增 `reason === 'schedule'` 分支注入【日程】块；端点 `POST /api/socialV2/schedule-add`（owner-only、agent token、reserved2、`tools.scheduleAdd`、`schedules.enabled`）、`/api/socialV2/schedules`（列表）、`/api/socialV2/schedule-cancel`（取消）；审计留痕 `qq_schedule_add` / `qq_schedule_cancel` / `qq_schedule_fire`。
- `src/mcp-snowluma-safe.js`（改动）：注册 `qq_schedule_add`（`key/token/title/time/description/repeat`）、`qq_schedule_list`、`qq_schedule_cancel`（`scheduleId`）。
- `scripts/test-schedules.mjs`（新增）＋ `scripts/test-audit.mjs` / `scripts/audit-bridge-harness.mjs`（登记 / 接线）。
- 配置：`config.json` 的 `socialV2.schedules`（`enabled/maxItems/summaryMaxChars/fireWindowMs`）与 `socialV2.tools.scheduleAdd / scheduleList / scheduleCancel`（默认开）。
- 生效条件：同上（重启桥接 + 重启 DSH + `setup-dsh`）。


### 更新到上游新版本（怎么合并官方更新）

**分支模型**（不要把自用改动合进 `main`，否则设置页「一键更新」的 `--ff-only` 会永久失效）：

| 分支 | 内容 | 用途 |
| --- | --- | --- |
| `main` | 纯上游，保持干净 | 设置页「一键更新」仍可用 |
| `feat/voice-asr` | 自用功能（语音转写、发图、受控命令、后台任务、日程） | 日常开发分支 |
| `feat/portable` | 上面这些 + 跨设备迁移工具 | 迁移时给新机拉的集成分支 |

**标准更新流程**（以合并到 v0.8.6 为例）：

```bash
cd D:\surfcore\repo
git fetch origin --tags                 # 拿上游新版本（v0.8.5 / v0.8.6 ...）
git checkout feat/voice-asr
git merge origin/main --no-edit         # 冲突通常只在 README.md / src/bridge.js / scripts/test-audit.mjs / scripts/audit-bridge-harness.mjs
# ↑ 冲突原则：两边都要保留（自用功能的 import/注册 + 上游新增的模块/测试登记）
node --check src/bridge.js
node scripts/test-audit.mjs             # 回归（当前基线：110/112，2 个历史性失败不算）
git push mine feat/voice-asr
git checkout feat/portable
git merge feat/voice-asr --no-edit      # 再同步到集成分支
git push mine feat/portable
```

**更新后按需处理**：
- `package.json` 依赖变了 → `npm install`
- `plugins/surfcore/presets/*` 变了 → `node scripts/setup-dsh.mjs`（跑完不影响运行中的 DSH，需完全退出重开）
- 上游新增了测试/模块 → 记得在 `scripts/test-audit.mjs` 与 `scripts/audit-bridge-harness.mjs` 里登记/接线
- 重启桥接（`restart.bat`）+ 完全退出重开 DSH，新代码才生效

**上游 v0.8.5 起的新行为**（要知道，否则会以为出 bug）：
- `src/dsh-health.js`：DSH 升级若摘掉 profile 的 3 条 MCP，桥接会弹 **L2 `dsh-profile-mcp-missing`**，提示在宿主机跑 `node scripts/setup-dsh.mjs`；
- 已映射会话的 `agentPreset` 与当前配置不一致时**自动退役重建**（旧会话工具表创建时定死），所以重启后 QQ 会话上下文重新开始是预期行为。

**功能冒烟测试**（桥接在跑时手工执行，覆盖管理员命令 / 后台任务 / 日程 / 本地语音识别 / 表情包发图 / 记忆卡）：

```bash
node scripts\smoke-features.mjs
```

会真实往 QQ 私聊发一张图（`assets/deepseek娘.png`），介意就把脚本第 5 节注释掉；结果最后一行是 `RESULT 9/9`。

**如果哪天想恢复「设置页一键更新」**：把 `main` 上的本地提交全部 discards（`git checkout main && git reset --hard origin/main`），之后设置页更新即恢复；代价是自用改动只存在于功能分支。

**main 上合并（旧做法，保留备查）**：

```bash
git checkout main
git checkout -- plugins/surfcore/presets/qq-chat.patch.yml \
                 plugins/surfcore/presets/qq-chat-v2.patch.yml \
                 package-lock.json          # 清脏（preset 换行符/锁文件/未跟踪都算 dirty）
git fetch origin && git merge origin/main   # 冲突主要在 src/bridge.js 与本 README
node scripts/setup-dsh.mjs && npm install
npm run test:audit
# 重启 DSH（插件吃新代码）→ 重启桥接
```

---

# SurfCore — 给 DSH agent 一个真实的身份：QQ × B站 × 桌宠

**中文** | [English](README.en.md)

> 一句话：**它不是"把大模型接进 QQ"的机器人框架，而是给模型一个身份、一套会遗忘的记忆、
> 一份作息、两只手（QQ / B站）和一个能坐在你桌面上的分身。**

| | |
| --- | --- |
| 版本 | `0.8.6` |
| 目标 DSH | `0.2.1-rc.2 或更新（rc.3 已能安装，功能未完整回归）`（`npm run verify:adaptation` 可逐项复核） |
| 平台 | Windows（沙箱 ACL / SnowLuma / 启动脚本都与它绑定） |
| 许可 | MIT（SnowLuma 是第三方专有运行时，**不随本仓库分发**） |
| 配套仓库 | [surfvoicelocal](https://github.com/Mieksido/surfvoicelocal) · [surfvoicecloud](https://github.com/Mieksido/surfvoicecloud) · [surfpet](https://github.com/Mieksido/surfpet) |

> 🔒 **本仓库不含任何真实数据**：角色卡是脱敏示例（`roles/`），记忆卡是空壳（`examples/`），
> 群号 / 群友名单 / QQ 号 / B站 mid 全部为占位符。运行时数据永远只在你自己的机器上。

---

## 让 DSH 自己装（也可以只发一条链接）

把这句话发给 DSH：

> 帮我安装 https://github.com/Mieksido/surfcore ，按 README 的步骤来。

**顺序很重要**（DSH 常常先 install_bundle、后装依赖，结果激活时报 `Cannot find module '@deepseek-ai/schemastery'`）：

1. `npm install`（没有 npm 就用 DSH 自带的 pnpm：`~/.dsh/dsh-runtimes/.../pnpm/bin/pnpm.cjs`）
2. 再 `plugin_manager install_bundle`（或 `node scripts/setup-dsh.mjs`）
3. 重启 DSH → 设置 → SurfCore → 诊断 → 一键安装

> 用 junction 链接安装时，模块是从**仓库真实路径**解析的，所以仓库根必须有 `node_modules` —— 这就是第 1 步不能省的原因。

两个实测踩过的点（v0.4.5）：

- **必须从仓库根目录安装**：插件里有 19 处 `../../../src/xxx.js`（人设、存储、token 预算等），
  只装 `plugins/surfcore` 会去找 `D:\src\...` 然后报模块不存在。
- **装完要刷新页面**（F5）或重启 DSH：客户端模块图是页面加载时的快照，新 bundle 要重新拉，
  否则设置里暂时看不到 SurfCore —— 不是装坏了。

## 第一次装（4 条命令）

```powershell
git clone --depth 1 https://github.com/Mieksido/surfcore.git
cd surfcore
npm install
node scripts/setup-dsh.mjs      # 自动判断 DSH 用的 profile，不用填
```

重启 DSH → 设置 → SurfCore → **诊断 → 一键安装（全部）**（自动发现 SnowLuma、写白名单、起桥接）。

> 不想敲命令：`powershell -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/Mieksido/surfcore/main/scripts/bootstrap.ps1 | iex"`

前置：Windows + Node ≥22.13 + DSH 0.2.1-rc.2 或更新（rc.3 已能安装，功能未完整回归） + SnowLuma（第三方，需自己装并扫码）。详见 [INSTALL.md](docs/guides/INSTALL.md)。

---

## 目录

- [一、这是什么](#一这是什么)
- [二、安装（新用户从这里开始）](#二安装新用户从这里开始)
- [三、日常使用](#三日常使用)
- [四、能力总览](#四能力总览)
- [五、架构一图](#五架构一图)
- [六、文档地图](#六文档地图)
- [七、安全与边界](#七安全与边界摘要)
- [八、常见问题（FAQ）](#八常见问题faq)
- [九、开发](#九开发)
- [十、许可与合规](#十许可与合规)

---

## 一、这是什么

一个跑在**你自己电脑上**的双进程系统：

- **一条腿在 DSH 里**：`surfcore` 插件 —— 设置窗口、B站 生物钟、记忆卡维护、桌宠接口。
- **一条腿是独立进程**：`src/bridge.js` —— QQ 收发、会话映射、控制台、安全闸门。

合起来，它让 agent 能：

1. **在 QQ 里当一个群友**：自己判断要不要看、要不要说、说几条、引用谁；说完能判断"这段可以结束了"，带着"下次怎么接"潜水。
2. **在 B站 当一个用户**：有自己的作息、偏好、每日额度；看视频会打分、会评论、会回帖、会发动态。
3. **记得住也忘得掉**：一份会衰减的记忆卡（进提示词）+ 一份永不遗忘的全量卡（只存档）。
4. **会主动找你**：从近期记忆里提炼"我想弄明白/想做点什么"，安静时段主动分享或索取；载体可选 QQ 或桌宠。
5. **有一个桌面分身**：仓库外的 Electron 桌宠可以跟她文字/语音对话，也能接主动搭话的气泡。

> 它**不做**：不代你登录/扫码/绕过平台风控，不做多用户，不把控制台暴露到内网以外，
> 不删除任何不可恢复的数据。完整边界见 [BOUNDARIES.md](docs/guides/BOUNDARIES.md)。

---

## 二、安装（新用户从这里开始）

### 2.1 环境要求

| 需要 | 版本 / 说明 | 必装？ |
| --- | --- | --- |
| Windows | 10/11（沙箱 ACL 与 `.bat` 启动器按 Windows 写） | ✅ |
| Node.js | **≥ 22.13**（`node -v` 确认） | ✅ |
| DeepSeek Harness（DSH） | **`0.2.1-rc.2 或更新（rc.3 已能安装，功能未完整回归）`**，能正常打开 Web GUI | ✅ |
| SnowLuma2 | 第三方 QQ 运行时，**自己去官方 Releases 下载**并扫码登录 | ✅（只收 QQ 才需要） |
| 语音引擎 | 两个配套仓库之一（本地/云端） | ⭕ 可选 |
| 桌宠 | 配套仓库 `surfpet` | ⭕ 可选 |

> ⚠️ **SurfCore 不下载、不安装、不打包 SnowLuma**（EULA §5.4）。它只做"检测已安装 + 一键打开窗口 + 连接状态"，
> 登录与扫码始终由你自己完成。

### 2.2 五步装好

> 第一次装、或卡在某一步：看 [INSTALL.md](docs/guides/INSTALL.md)（手把手，含 SnowLuma 配置、白名单、排错表）。

```bash
# 1) 取代码
git clone https://github.com/Mieksido/surfcore.git
cd surfcore

# 2) 装依赖（postinstall 会自动修补 @snowluma/sdk 的 ESM bug）
npm install

# 3) 复制配置模板，然后编辑 config.json（见 2.3，只填 4 处）
#    Windows CMD: copy config.example.json config.json
cp config.example.json config.json

# 4) 装进 DSH（preset + 三个 MCP server + surfcore bundle，幂等，可重复跑）
node scripts/setup-dsh.mjs

# 5) 重启 DSH → 设置里出现 SurfCore →
#    在「概览」点「启动QQ」（或命令行 npm start / start.bat）
```

`setup-dsh.mjs` 做三件事：

1. 把 `qq-chat` / `qq-chat-v2` 两条 **agent preset** 插进 DSH profile（DSH 0.1.7 起的 bundle patch 机制）；
2. 在 profile 的 `cordis.patch.yml` 挂 **三个 MCP server**（QQ 工具 / SnowLuma 探活 / 只读联网搜索）；
3. 在 profile `package.json` 注册唯一一个 bundle：`surfcore`。

> 需要装到别的 profile：`node scripts/setup-dsh.mjs <profile名>`（默认 `web`）。

### 2.3 最小配置（只填这 4 处）

打开仓库根目录的 `config.json`：

| 位置 | 填什么 | 不填会怎样 |
| --- | --- | --- |
| `snowluma.wsUrl` / `httpUrl` / `accessToken` | SnowLuma 的 OneBot WS、HTTP、token（**HTTP 与 WS 可能是两个不同的值**） | 桥接连不上 QQ，控制台显示"未连接" |
| `ownerQQ` | 你自己的 QQ 号（`closed-agent` 模式只认这个人） | 管理员功能失效 |
| `allow.private` / `allow.groups` | 允许她接触的私聊/群（数组） | **白名单为空 = 谁都不响应**（不是全放行） |
| `consoleToken` | 控制台令牌；留空会自动生成到 `state/console-token` | 控制台需要令牌才能进 |

最小可用示例（把占位符换成你的）：

```jsonc
{
  "snowluma": { "wsUrl": "ws://127.0.0.1:3001", "httpUrl": "http://127.0.0.1:3000", "accessToken": "<SnowLuma token>" },
  "ownerQQ": 1000000001,
  "allow": { "private": [1000000001], "groups": [100000004] },
  "consoleToken": ""
}
```

> 其余几百个键都有默认值，全部含义见 [DATA-AND-CONFIG.md §1](docs/guides/DATA-AND-CONFIG.md)。
> 装好之后**建议一切都在设置页里改**（保存即生效，且会自动备份）。

### 2.4 首次验证

```bash
npm run test:audit                              # 离线回归（不联网、不发消息）
node scripts/check-onebot-status.mjs            # OneBot 连通性（只读）
node scripts/verify-dsh-020-adaptation.mjs      # 对本机 DSH 版本逐项复核
```

真机验证三件事：**在群里 @ 她 → DSH 里出现对应会话 → 回复回到 QQ**。

### 2.5 安装常见失败

| 症状 | 原因 | 处理 |
| --- | --- | --- |
| 设置页找不到 SurfCore | bundle 没装上 / DSH 没重启 | 重跑 `setup-dsh.mjs`，重启 DSH |
| 桥接起来了但收不到消息 | SnowLuma 未登录 / token 不对 / WS 端口不是 3001 | 控制台「运行总览」看状态；对照 `config.json` 的 `snowluma.*` |
| 群里 @ 她没反应 | 白名单没加这个群 / 模式不对 / 已暂停 | 看「访问与安全」页；确认 `allow.groups` |
| agent 只会说话、不调工具 | MCP 没挂上 / 工具被安全守卫隐藏 / 工具开关关了 | 重跑 `setup-dsh.mjs`；看设置页工具开关 |
| 控制台 401 | 没带令牌 | 用 `http://127.0.0.1:3100/?token=<consoleToken>` |
| `npm install` 后启动报 ESM 错 | postinstall 补丁没跑 | `npm rebuild` 或手动 `node scripts/patch-snowluma-sdk.mjs` |

更多故障与恢复见 [BOUNDARIES.md §3](docs/guides/BOUNDARIES.md)。

---

## 三、日常使用

### 3.1 设置页（DSH → 设置 → SurfCore）

14 个标签：概览 / 角色 / 目的 / QQ / 语音 / 桌宠 / B站 / Token 额度 / 观看历史 / 记忆 / 对齐 / 扩展 / 全部参数 / 诊断。
逐个说明见 [UI-AND-CONSOLE.md](docs/guides/UI-AND-CONSOLE.md)。

### 3.2 四种运行模式

| 模式 | 她是谁 | 能干什么 |
| --- | --- | --- |
| `chat` | 群友 | 白名单内聊天，工具面受安全守卫限制 |
| `closed-agent` | 只理管理员 | 私聊 owner，可用完整 DSH 工具 |
| `reserved` | 一代仿真群友 | 状态机 + 空格分条 + `[SILENT]` |
| `reserved2` | 二代仿真群友（**默认**） | 一切皆工具：自己看消息、发言、等待、潜水、收尾 |

### 3.3 让她主动找你（可选）

设置页「目的」：选载体（QQ / 桌宠）、节奏、安静时段；先点**预览**（零副作用）再"试一次"。
硬闸门：安静时段 / 每日上限 / 主人在聊 / token 额度 / 专注模式。

### 3.4 可选装语音

两个独立仓库（[surfvoicelocal](https://github.com/Mieksido/surfvoicelocal) / [surfvoicecloud](https://github.com/Mieksido/surfvoicecloud)），装在仓库**外面**：

| 仓库 | 端口 | 特点 |
| --- | --- | --- |
| `surfvoicelocal` | 8765 | 本地 GPT-SoVITS，免费、断网可用 |
| `surfvoicecloud` | 8767 | 云端声音复刻，质量最好、按字符计费 |

装法：`git clone` 到 `surfcore/state/voice-packs/voice-local`（或 `voice-cloud`）→ 按该仓库 README 下载模型 →
`run.bat` → 回到 SurfCore **设置 → 语音** 选本地/云端并点「启动」。
**AI 发语音默认关闭**（`socialV2.voice.enabled=false` + 工具开关 `tools.sendVoice`），要显式打开。

> 模型不进 GitHub（太大）。仓库里只有启动脚本、配置与说明；模型按各自 README 的 `fetch-models` 下载。

### 3.5 可选装桌宠

[surfpet](https://github.com/Mieksido/surfpet)：Electron 桌面分身（Release 里有安装包）。**用户装 Release 的 zip，开发者 clone 源码自己构建。**

装法：设置页 **桌宠** → 填 zip 地址/目录 → 安装 → 选 `electron.exe` → 启动。
装好后：右键「文本对话 / 语音对话」，气泡上所有她的话都有「回复」按钮，右键/托盘有**专注模式**。

> 桌宠通过 `~/.dsh/surfcore/pet/host.json` 发现插件接口（本机 + 一次性令牌），不需要 DSH 的登录态。

### 3.6 B站（可选）

设置页 **B站** → 扫码登录 → 填作息窗口（例如 `20:00–24:00`）→ 选偏好 → 设额度。
她会在窗口内自己看视频、打分、评论、发动态；**默认不分享到 QQ**（可开）。

### 3.7 角色与记忆

- **角色包** = 人格卡 + 记忆卡 + B站 行为账本，整包切换。
- 新建：设置页「角色」→ 新建（或复制 `examples/character/` 到 `~/.dsh/surfcore/characters/<id>/`）。
- 记忆：QQ/B站/桌宠 三个场景写进**同一张卡**；每 10 分钟摄取一次，会衰减、会遗忘、80/90/100% 告警。
- 示例人格卡在 `roles/`（已脱敏），记忆卡空壳在 `examples/`。

### 3.8 浏览器控制台（可选）

`http://127.0.0.1:3100/?token=<consoleToken>`：运行总览、会话与审批、令牌与花费、访问与安全、调试与运维、工具参考。
只接受本机回环访问。

### 3.9 检查更新

**设置 → 概览 → 更新**：一次同时查 SurfCore / 两个语音包 / 桌宠。

- 本体与语音包走 **git**（`fetch` 只读 + `merge --ff-only`；本地有改动会拒绝）；
- 桌宠走 **Release 的 `version.json`**（比版本号 → 下 zip → sha256 校验 → 替换，**保留 `data/`**）；
- DSH 启动后 20 秒自动查一次，有更新时打开概览会弹窗，可勾「不再提示本次」。

---

## 四、能力总览

| 子系统 | 你能看到的能力 | 细节 |
| --- | --- | --- |
| **QQ** | 群/私聊收发、引用回复、分条、表情包、图片/动图、语音、拍一拍、合并转发展开、上线补历史、提问/审批回传、四种运行模式 | [MODULE-BRIDGE.md](docs/guides/MODULE-BRIDGE.md) |
| **B站** | 扫码登录、看视频/打分/收藏、评论与回帖、发动态、分享到 QQ、私信、直播间监听、34 个 CLI 命令 | [SUBSYSTEM-BILI.md](docs/guides/SUBSYSTEM-BILI.md) |
| **记忆** | 衰减卡（清晰度/遗忘/容量告警/压缩）、全量卡（append-only）、三场景共享、隐私 scope、双向记忆 | [MEMORY_CARD.md](docs/guides/MEMORY_CARD.md) |
| **人格** | 多角色整包切换、自动存档/回档、管理员双身份、身份对齐 | [CHARACTER_PERSONA.md](docs/guides/CHARACTER_PERSONA.md) |
| **主动** | 目的机制（目标假设/载体 QQ·桌宠/互斥回落）、对话收尾、二代 proactive | [PURPOSE_OUTREACH.md](docs/guides/PURPOSE_OUTREACH.md) |
| **语音** | 语音库发送、本地/云端 TTS 现场合成、语音包安装启停、音量/响度、频率上限；`qq_send_voice` / `qq_list_voices`（**AI 发语音默认关闭**） | [SUBSYSTEM-VOICE.md](docs/guides/SUBSYSTEM-VOICE.md) |
| **桌宠** | 文本/语音对话、气泡与回复按钮、专注模式、目的载体、断线重连 | [SUBSYSTEM-PET.md](docs/guides/SUBSYSTEM-PET.md) |
| **额度** | 每日 token 额度（QQ/B站/其他/总额，双单位，80% 提醒、100% 停）、消费看板 | [DATA-AND-CONFIG.md](docs/guides/DATA-AND-CONFIG.md) |
| **工具面** | 39 个 `qq_*` 工具、三个 MCP server、两代 preset、fail-closed 工具守卫 | [AGENT-TOOLS-AND-PRESETS.md](docs/guides/AGENT-TOOLS-AND-PRESETS.md) |
| **界面** | 设置页 14 个标签、控制台 10 个页面 | [UI-AND-CONSOLE.md](docs/guides/UI-AND-CONSOLE.md) |

---

## 五、架构一图

```
┌──────────────── 用户可见 ────────────────┐
│ DSH Web GUI    控制台 :3100    桌宠窗口   │
└──────┬──────────────┬─────────────┬──────┘
┌──────▼──────────────▼─────────────▼──────────────────────────┐
│ DSH 宿主  └─ surfcore 插件（bundle）                            │
│     设置页 · 设置页 API · 桌宠 API · B站调度 · 记忆卡 · 额度    │
└──────┬───────────────────────────────────────────────────────┘
       │ HTTP（会话 Cookie） + 子进程管理
┌──────▼───────────────────────────────────────────────────────┐
│ QQ 桥接进程（node src/bridge.js，单实例）                       │
│   OneBot WS · DSH 客户端 · 控制台 :3100 · 三个 MCP server       │
└──┬────────────┬──────────────┬───────────────────────────────┘
   │ WS         │ stdio        │ HTTP
┌──▼────────┐ ┌─▼──────────┐ ┌─▼─────────────────┐
│ SnowLuma2 │ │ DSH MCP    │ │ 语音引擎 8765/8767 │
│（第三方）  │ │ 客户端      │ │（surfvoice*）      │
└───────────┘ └────────────┘ └───────────────────┘
```

- **两套状态根**：桥接数据在 `<仓库根>/state/`，插件数据在 `~/.dsh/surfcore/`。
- **三份配置**：`config.json`（QQ）、`~/.dsh/surfcore/config.json`（合体层）、`~/.dsh/surfcore/bili.config.json`（B站）。
- **DSH 端口会漂移**：桥接与插件都用 `discoverDshBaseUrl()` 发现，不要硬编码。

完整说明（含 6 条数据流与重启矩阵）：[ARCHITECTURE.md](docs/guides/ARCHITECTURE.md)。

---

## 六、文档地图

> **2026-10-26 全仓库逐行梳理**：12 篇、约 8,700 行、3,150 处 `文件:行号`。

| 步 | 读什么 | 读到什么程度 |
| --- | --- | --- |
| 1️⃣ 5 分钟 | **本文** | 它是什么、怎么装 |
| 2️⃣ 15 分钟 | [ARCHITECTURE.md](docs/guides/ARCHITECTURE.md) | 几个进程、怎么分层、改什么要重启什么 |
| 3️⃣ 按需 | 下面分册 | 改哪个子系统翻哪本 |

| # | 文档 | 行数 | 什么时候翻它 |
| --- | --- | --- | --- |
| 1 | [ARCHITECTURE.md](docs/guides/ARCHITECTURE.md) | 335 | 总纲 |
| 2 | [DATA-AND-CONFIG.md](docs/guides/DATA-AND-CONFIG.md) | 351 | 三份配置每个键、约 95 个状态文件 |
| 3 | [BOUNDARIES.md](docs/guides/BOUNDARIES.md) | 181 | 做不到什么、坏了怎么恢复 |
| 4 | [MODULE-BRIDGE.md](docs/guides/MODULE-BRIDGE.md) | 1,020 | 桥接全文 |
| 5 | [MODULE-CORE-A.md](docs/guides/MODULE-CORE-A.md) | 1,001 | 记忆/人格/目的/收尾/额度/账本/计价/身份 |
| 6 | [MODULE-CORE-B.md](docs/guides/MODULE-CORE-B.md) | 1,098 | B站/鱼群/表情/黑话/文本化/SSRF/DSH 客户端 |
| 7 | [MODULE-PLUGIN.md](docs/guides/MODULE-PLUGIN.md) | 1,101 | 插件宿主：装配、配置模型、设置页 API、B站 调度 |
| 8 | [UI-AND-CONSOLE.md](docs/guides/UI-AND-CONSOLE.md) | 677 | 设置页 14 标签 + 控制台 10 页 |
| 9 | [SUBSYSTEM-VOICE.md](docs/guides/SUBSYSTEM-VOICE.md) | 855 | 语音三条链路 |
| 10 | [SUBSYSTEM-PET.md](docs/guides/SUBSYSTEM-PET.md) | 904 | 桌宠全链路 |
| 11 | [SUBSYSTEM-BILI.md](docs/guides/SUBSYSTEM-BILI.md) | 981 | B站 34 命令 / 23 库 |
| 12 | [AGENT-TOOLS-AND-PRESETS.md](docs/guides/AGENT-TOOLS-AND-PRESETS.md) | 233 | 39 个工具、守卫、两代 preset |

其它：DSH 装配 [DSH_SETUP.md](docs/guides/DSH_SETUP.md) · 安全基线 [SECURITY_BASELINE.md](docs/guides/SECURITY_BASELINE.md) ·
踩坑 [PITFALLS.md](docs/PITFALLS.md) · 风险台账 [RISK_REGISTER.md](docs/RISK_REGISTER.md) · 全部索引 [docs/README.md](docs/README.md)。

---

## 七、安全与边界（摘要）

- **群友碰不到你的机器**：仿真会话的工具面是白名单、fail-closed，本地执行能力全部被 restrict。
- **发送必须命中白名单**：没有"管理员例外"这种后门。
- **控制台只接受本机回环** + 令牌（定长比较）+ Host/Origin 校验 + 写操作强制 JSON。
- **密钥不落日志**；`state/` 用 icacls 切断 ACL 继承。
- **不可逆删除 = 事故**：清理一律先隔离到 `_backups/`。
- **不承诺**提示注入的语义层 100% 防护（真正的边界是工具面与白名单）。

详见 [SECURITY_BASELINE.md](docs/guides/SECURITY_BASELINE.md)、[BOUNDARIES.md](docs/guides/BOUNDARIES.md)、[RULES.md](RULES.md)。

---

## 八、常见问题（FAQ）

| 问题 | 回答 |
| --- | --- |
| 能不装 SnowLuma 吗？ | QQ 部分不能（它负责登录与收发）。只要 B站/记忆/桌宠可以。 |
| 能不用 DSH 吗？ | 不能，插件与 preset 都跑在 DSH 里。 |
| 会自己发消息吗？ | 默认不会。主动搭话要显式开「目的」；二代下发言必须调工具。 |
| 数据会上传吗？ | 只有拼进提示词的文本会发给模型 API；不想让黑话词条出机就关 `slang.autoResearch`。 |
| 支持 Linux/macOS 吗？ | 暂不支持（沙箱 ACL 与启动脚本按 Windows 写）。 |
| 能多用户/远程吗？ | 不做。控制台只接受回环。 |
| 语音包/桌宠必须装吗？ | 不必须。不装则语音不可用、目的机制走 QQ。 |
| 改名/换角色会丢记忆吗？ | 不会。角色包整包隔离，切换带快照，可回档。 |

---

## 九、开发

```bash
npm run test:audit              # 默认门禁（75 个脚本，离线）
npm run test:regressions        # 桥接/协议回归
cd plugins/surfcore && npm test # 插件侧（含更新检查、桌宠更新保留数据的回归）

npm run privacy-scan:strict     # 发布前隐私扫描（0 命中才可发布）
npm run guard:check             # DSH 升级后先跑（asar 会话护栏补丁是否还在）
node scripts/setup-dsh.mjs      # 重装 preset + MCP
```

目录结构见 [docs/FOLDER_MAP.md](docs/FOLDER_MAP.md)；代码分层与"改什么要重启什么"见
[ARCHITECTURE.md](docs/guides/ARCHITECTURE.md)。

---

## 十、许可与合规

- 本仓库 **MIT**。
- **SnowLuma2 是第三方专有组件**，不随仓库分发、不打包；按 EULA §5.4，本程序不对它做安装/部署/代扫码。
- 请自行遵守 QQ / B站 服务条款与当地法律；本项目不提供绕过风控的能力。

> 老版本（≤0.6.18）无法自动更新：用 [强制更新提示词.txt](dist/强制更新提示词.txt)（复制给 DSH）或 [在线版说明](docs/guides/FORCE_UPDATE_PROMPT.md)。
