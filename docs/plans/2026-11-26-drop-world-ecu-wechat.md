# 方案 v2：移除 world、接 evolution-computer-use、微信链移植进 SurfCore

> 2026-11-26 · 待拍板

## 0. 结论先行

| 事 | 做法 |
|---|---|
| dsh-world | **整体卸载**（插件 + `~/.dsh/worlds` 备份后删除） |
| 记忆 | 不借 world 了：SurfCore 自建 `elysia-memory.sqlite`（原文全存 + FTS + 日记），迁 1143 条记忆卡；顺手把 world 那 34 行对话 / 认识页 / 日记作为一期归档导进去 |
| 电脑/浏览器 | 接 **evolution-computer-use (ECU)** 0.1.0：MCP server 形式，白名单放行给 QQ 会话 |
| 微信 | 把 world 的 Windows 适配器（`src/ecosystem/wechat/windows/` + `.host/wechat/` 运行时）**整套复制**到 `D:\surfcore\runtimes\wechat\`，模块端点改指 SurfCore，出站写本站 outbox |
| 房间壁纸 | 卸载 world 后会失去实时快照 → 退成静态图（见 §5） |

## 1. ECU 是什么、怎么接
**是什么**：从 world 0.8 里拆出来的独立计算机使用层（MIT，Node ≥22.16）。
- 自带浏览器：单独 profile 的系统 Edge/Chrome，走 CDP，**不碰你的鼠标键盘、不碰你日常浏览器**
- 用户电脑（Windows）：`--desktop background`（往单个窗口投递输入，不抢焦点）／`foreground`（真鼠标键盘）
- **程序库**：做完一次就存成 procedure，下次直接回放（不吃模型），页面改版时停在失败那步说原因
- 形态：**MCP server（stdio）+ JS 库**；命令 `npx -y evolution-computer-use [--desktop background]`
- 工具：`computer_use`（认程序/站点）、`procedure_run/save/note/routines`、`page_*` 原语、`desktop`、`inbox_read`；工具表固定，不破坏 prompt 缓存

**怎么接（三选一，推荐 A）**
- **A. 作为 SurfCore 的 MCP server**：在 SurfCore 的 MCP 配置里加一条
  `evolution-computer-use`（`cmd /c npx -y evolution-computer-use --desktop background --data D:\surfcore\runtimes\ecu`），
  `setup-dsh` 重生成预设；`plugins/surfcore/qq-tool-restrict.mjs` 的 `SAFE_PREFIXES` 加 `mcp__evolution-computer-use__`。
  → 她就多了"会自己开浏览器/操作电脑"的手，且只在 owner 私聊可用。
- B. 嵌进 bridge（`lib/index.js` 直连）：可控性最好，但要自己包一层工具 + 审计，工作量大。
- C. 单独跑一个 MCP 给主 GUI 用（QQ 侧不给）：能力浪费。

**风险**：`--desktop foreground` 会真的抢鼠标键盘 → 默认只开 `background`；开 foreground 需要她在 QQ 里先问、你点头。

## 2. 微信链移植（核心工作量）
### 2.1 适配器协议（已确认）
适配器（Python）轮询微信库 → POST 到 `moduleFile` 指向的端点：
- 入站：`{protocol:4, identity:{channel:'wechat', accountId, conversationId, conversationType, speakerId, speakerName}, text|messages, media...}`
- 出站拉取：`{outbox:{accountId, chats:[{id,name}], receipt?:{id,confirmed,status}, ...}}` → 家侧返回一条待发 job `{id, accountId, chatId, messages:[...]}`；适配器发完回执
- 家侧 job 库：`jobs(id, sessionId, messageId, status['staged','queued','claimed','sent','uncertain','failed'], confirmed, total, body)` + `receipts`

### 2.2 移植后的样子
```
D:\surfcore\runtimes\wechat\
  adapter.py, binding.py, incoming.py, messages.py, groups.py, sender..., engine\dsh-wechat.dll
  .venv\            （重建，装 wechatauto-replica + pywin32/uiautomation/opencv/zstandard）
  config.json       （moduleFile → SurfCore；chats 绑定；dbDir D:/WChats/xwechat_files）
  wechat.ps1        （Build/Start/Stop/status，原样）
SurfCore：
  src/wechat.mjs            —— 入站解析 / 出站队列（state/wechat-outbox.sqlite，schema 同 world）
  src/bridge.js             —— POST /api/socialV2/wechat/ask（protocol 4，校验 state/wechat-token）
  plugins/surfcore/lib/qq-tools.js —— 新增 qq_wechat_send（文字/图片，最多 9 张）
```
- 入站：`conversationType==='private' && speakerId===owner 的微信 wxid` → 走和 QQ 同一条 owner 路径（人格卡/记忆/目的都复用）；群聊只在她被 @ 时进
- 出站：她的回复由 `wechat_send` 或自动回复写入 outbox，适配器拉走；回执写回 `jobs.confirmed`
- 语音：微信语音先落成文件 → 走本地 faster-whisper（`/audio/transcriptions`）转文字再处理

### 2.3 迁移步骤
1. 复制 world 的 `src/ecosystem/wechat/windows/*`（代码，MIT）与 `.host/wechat/engine`、按新路径重建 venv
2. `config.json` 改 `moduleFile` → `{origin:'http://127.0.0.1:3100', token:<新生成>, path:'/api/socialV2/wechat/ask', protocol:4}`，`chats` 保留现有绑定
3. 起适配器 → `status` 应报 `configured:true, moduleReady:true`
4. 用真消息验证：你发一句 → `state/wechat-inbox` 有记录 → 她回 → `jobs.status='sent'`

## 3. 记忆（P0，独立于 world）
沿用 v1 §2 的库设计，改动点：
- 迁移源只保留自己的 1143 条（`char-mws63fse/memory/memory-card-full.jsonl`）
- **顺手归档** world 的 34 行对话、`diary/*.md`、`room/认识/*.md` 到 `cards(kind='world-archive')`，删 world 前一次性导完
- 检索工具 `qq_memory_search/get/day`；prompt 三级拼装不变
- 开关 `socialV2.memory.backend: 'card' | 'elysia'`

## 4. 移除 world 的顺序（防丢东西）
1. `dsh plugin --profile desktop remove dsh-world`（先备份）
2. 备份 `~/.dsh/worlds/default` → `D:\surfcore\_backup\world-2026-11-26\`（含 archive.sqlite / conversations / diary / room / bridge.json）
3. 迁移：34 行对话 + 日记 + 认识页 → `cards`；微信配置/引擎 → `runtimes\wechat`
4. 删 `~/.dsh/worlds`、删 cordis 里的 dsh-world 块、删 `world-compaction` 行
5. 停 `SurfCoreWorldRoom` 任务、删 8790 服务（壁纸改成静态，见 §5）

## 5. 房间壁纸怎么办（必须选一个）
- **a. 静态图**：用现在这张 1920×1080 房间截图当壁纸（她不动，最简单）
- **b. 保留 `dsh-world-room` 包自己跑**：它是独立包，但没有 world 的 snapshot 就没有"她在哪/几点"，只能当装饰；要 hack 一个假 snapshot 服务
- **c. 换成 ECU 的浏览器截图**：让她的浏览器常开小屋页面，定时截全屏 —— 能跟着房间变，但吃 CPU
- 我建议 **a**，等 ECU 稳住后再考虑 c。

## 6. 分期
| 期 | 内容 | 工时 |
|---|---|---|
| P0 | 记忆库 + 迁移（含 world 归档） | 1~2 天 |
| P1 | 微信移植（复制/重建 venv/改端点/入站出站/语音） | 1 天 |
| P2 | ECU 接入（MCP 条目 + 白名单 + dataDir + 试跑一个 procedure） | 半天 |
| P3 | 卸载 world + 壁纸降级 + 文档 | 半天 |

顺序理由：P0/P1 不依赖删除 world（可并行验证），P3 最后删，随时能退。

## 7. 回滚
- world 卸载前整目录备份；`dsh plugin add dsh-world@0.8.4 --ignore-scripts` 一条命令回来
- 微信：新适配器独立目录，旧的 `.host/wechat` 不动，切 `config.json` 的 moduleFile 即可回退
- 记忆：`memory.backend='card'` 即回旧路径
- ECU：删 MCP 条目 + 白名单，零残留

## 8. 需要你拍
1. 房间壁纸：a 静态 / b 假快照 / c ECU 截图？
2. ECU 桌面模式：只开 `background`（推荐）还是也给 `foreground`？
3. 微信入站范围：只接你私聊（推荐）/ 也接群（仅 @ 她时）？

---

## 9. 拍板结果（2026-11-26）

### 9.1 微信：做成配置项
- `socialV2.wechat`（新）：
  ```json
  {
    "enabled": true,
    "primaryChannel": "qq",          // qq | wechat —— 主通道，默认 qq
    "scope": "whitelist",            // whitelist | blacklist
    "whitelist": ["<wxid>"],         // scope=whitelist 时只接这些人/群
    "blacklist": [],                 // scope=blacklist 时排除
    "groups": "mention",             // off | mention | all
    "autoReply": true,
    "adapter": { "python": "...", "config": "D:/surfcore/runtimes/wechat/config.json" }
  }
  ```
- 设置页新增「微信」标签（`plugins/surfcore/lib/client.js`）：开关 / 主通道单选（QQ・微信）/ 黑白名单表格 + 搜索添加 / 群聊策略 / 适配器状态灯（`/api/socialV2/wechat/status`）。
- **主通道语义**：`primaryChannel` 只决定「她主动开口时默认走哪边」（目的引擎、日程、提醒）；两边都能收发。任一端的对话都进同一份记忆与目的状态。
- **目的配置不受影响**：`purpose.enabled` 与 `primaryChannel` 解耦——无论主通道是哪端，目的引擎都按 `gapMinMs/gapMaxMs/dailyMax` 跑，只是投递口不同。

### 9.2 壁纸：全部移除
- 删 `SurfCoreWorldRoom` 计划任务、停 8790 服务、WE 里不再挂 `xiaoxi-room`。
- **保留** `F:\SteamLibrary\steamapps\common\wallpaper_engine\projects\myprojects\xiaoxi-room\` 里的工程文件，给以后的家用（只删运行链，不删资产）。
- 桌面壁纸回落到系统默认/你自己选的图。

### 9.3 ECU：允许 foreground
- `--desktop` 默认 `background`，配置项 `socialV2.computer.mode: 'background' | 'foreground'`。
- 允许她调皮：foreground 下她会真的动鼠标键盘；人格卡补一条「偶尔会捣乱，但动手前先说一句」。
- 安全兜底：`qq_run_code` 的破坏性黑名单照旧；ECU 的 `desktop` 调用写审计（`state/owner-audit.jsonl`）。

### 9.4 see-now 与 ECU 冲突吗
**不冲突，但互相看得见**：
- see-now 是只读采集（ffmpeg ddagrab/gdigrab），ECU 是输入注入（SendInput / 后台投递），两者不抢同一把锁。
- 真影响有三点：① ECU 一动，画面变化大，see-now 出图变多 → token 涨；② ECU 前台操作时鼠标满屏飞，采集帧里全是光标；③ ECU 自带浏览器窗口会出现在采集里（这其实是好事，能看到她在干什么）。
- 建议策略：`computer.mode==='foreground'` 期间把 see-now 自动降到 `pace:'calm'` 或直接 `stop`，操作完再恢复；这条写进 bridge 的 ECU 调用包装里。

## 10. 修订后的分期
| 期 | 内容 | 变化 |
|---|---|---|
| P0 | 记忆库 + 迁移 | 不变 |
| P1 | 微信移植 + 配置项 + 设置页「微信」标签 + 主通道 | 增加 UI 与黑白名单 |
| P2 | ECU 接入（background 默认，foreground 可切）+ 审计 + see-now 联动降频 | 增加联动 |
| P3 | 卸载 world + 壁纸移除（保留工程文件）+ 文档 | 壁纸改为"只留资产" |
