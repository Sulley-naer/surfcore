# 方案：记忆全量下沉 + world 降级为工具层

> 2026-11-26 · 待拍板 · 不改代码，先定架构

## 0. 先把一件事说清楚

world 现在的「全量记忆」只有 **114 条 records**（`archive.sqlite`）+ **34 行对话**（11-24、11-25 两天）；
SurfCore 的记忆卡是 **1143 条 / 1.1MB**（`memory-card-full.jsonl`）。

所以「全量采用 world 的记忆」这句话，落地时应该是：**采用它的机制**（原文全存 + 检索 + 日记 + wiki），
不是采用它那 114 条数据。真正要保住的是我们那 1143 条 + 往后每一天。

## 1. 目标架构

```
QQ 私聊 ──▶ SurfCore bridge
              ├─ 人格卡 / 目的引擎 / 日程 / 任务 / 语音  （唯一的「她」）
              ├─ 记忆检索（唤醒 prompt 拼装 + QQ 工具）
              └─ 双写 ──▶ elysia-memory.sqlite （全量原文底座）

world（无脸工具层）
              ├─ 房间渲染（壁纸 / 8790 代理）
              ├─ 记忆归档服务（只写不聊）
              └─ 电脑操作（可选，见 §3 的 A/B）
```

一句话：**嘴巴只留一张（SurfCore），记忆只存一份（新库），world 变成插座。**

## 2. 记忆方案（P0）

### 2.1 存储位置
`D:\surfcore\repo\state\memory\elysia-memory.sqlite`（放进 SurfCore 自己的 state，**不写进 `~/.dsh/worlds/`**，
避免 world 升级/重建把底座连锅端）。

### 2.2 表结构

```sql
events(            -- 全量逐条，永不删
  id INTEGER PK, ts INTEGER, day TEXT, channel TEXT,   -- qq / wechat / life / tool
  conv_key TEXT, role TEXT,                            -- owner / self / system / tool
  speaker TEXT, text TEXT, meta TEXT                   -- JSON：tool 名、任务 id、情绪标记
);
events_fts USING fts5(text, content='events', content_rowid='id', tokenize='trigram');

cards(             -- 结构化摘录：吸收现记忆卡全部字段
  id TEXT PK, kind TEXT,        -- fact / preference / event / wiki / diary / lesson
  title TEXT, body TEXT, tags TEXT,
  importance INTEGER, emotional REAL, clarity REAL,
  first_seen INTEGER, last_seen INTEGER, refs TEXT
);

days(day TEXT PK, summary TEXT, events INTEGER, tokens INTEGER);
```

### 2.3 写入（双写）
| 时机 | 写什么 |
|---|---|
| 收到主人消息 | `events(role='owner')` |
| 她发出回复 | `events(role='self', meta.botReplyOf=<owner event id>)` |
| 目的引擎 | `events(role='system', meta.kind='purpose')` |
| 工具/任务结果 | `events(role='tool')` |
| 每日 04:00 | `days.summary` + 把当天事件压成 3~8 张 `cards(kind='diary')` |

写失败只记日志、不阻断对话；每晚 04:30 对账（events 条数 vs bridge 日志）补漏。

### 2.4 读取（拼进唤醒 prompt）
三级拼装，顺序固定：
1. `memory-card` 摘要（现有 `memory-card-prompt-qq.md`，3000 字上限）——不变
2. 最近 N 条原文（N=120~200，按字符预算截断）
3. FTS 命中：用最近一句/目的关键词查 `events_fts`，取 3~5 条，带日期

总计仍受 `injectMaxChars.qq = 3000` 约束，超了按 3→2→1 的优先级裁。

### 2.5 QQ 侧工具（给「她」用）
- `qq_memory_search(query, limit=8)` → 命中片段（日期 + 摘要）
- `qq_memory_get(id)` → 单条全文
- `qq_memory_day(date)` → 某天日记摘要 + 事件数

白名单：`plugins/surfcore/qq-tool-restrict.mjs` 的 `SAFE_EXACT` 加三个名字。

### 2.6 迁移（一次性）
1. `char-mws63fse/memory/memory-card-full.jsonl` 1143 条 → `cards`
2. `world/conversations/*.jsonl` 34 行 → `events`
3. `world/room/认识/*.md` → `cards(kind='wiki')`
4. `world/diary/*.md` → `cards(kind='diary')`
5. 迁移脚本 `scripts/migrate-memory.mjs`，跑完打印条数对照表

### 2.7 衰减策略变更
现在：`forgetAfterDays=180` 会把旧记忆**删掉**。
改：原文永不删；衰减只作用于 `cards.importance` 权重（越旧越轻），检索时按权重排序。
磁盘估算：每天 300 条 × 200 字 ≈ 60KB/天 ≈ 22MB/年，可以忽略。

## 3. world 降级为工具层（P1）

### 3.1 配置开关（`~/.dsh/worlds/default/world.json` + cordis 块）
| 项 | 现在 | 改成 | 影响 |
|---|---|---|---|
| `life` | true | **false** | 不起家会话 / 闹钟 / 每日回顾 / `reach_out` |
| `qqNative.enabled` | false | false | 已经是关的 |
| `bridge` | true | **false** | 不再暴露 say 接口（SurfCore 侧 `world.enabled` 已 false） |
| `wechat` | true | **false** | 微信不再走 world |
| `desktopEnabled` | true | **false** | 不盯前台窗口 |
| `cottageEnabled` | true | true | 房间保留（壁纸要用） |
| `computerEnabled` | true | 见 A/B | 电脑操作 |

### 3.2 A/B 选择：电脑操作给谁？
**A（推荐）**：关掉 `computerEnabled`。她的「操作电脑」走 SurfCore 的 `qq_run_code` + DSH 全套工具
（`ops_bash`/read/write/web/see_now 都在她手里）。world 只剩房间渲染，零重复人格。
**B**：保留 `computerEnabled`，但关 life 后它没有家会话可挂——需要 world 支持「任务型会话」，
改造成本高、且会出现第二个「她」。不推荐。

### 3.3 persona 处理
`persona.md` 只留 `## 名字 / 小汐`，其余层删掉；`world-prompt.md` 不再注入。理由：它不说话就不需要人格，
留着反而会在房间/日记里长出自己的版本，和 SurfCore 的记忆打架。

## 4. 接口清单（改造后）
| 接口 | 用途 | 状态 |
|---|---|---|
| `GET :8790/health` | 房间健康 | 保留 |
| `GET :8790/snapshot` | 房间状态 | 保留 |
| `worldSay()` / `world-reply` | world 说话 | **停用**（代码留着，开关关） |
| `qq_memory_*` 三个工具 | 记忆检索 | 新增 |

## 5. 分期与验收

| 阶段 | 内容 | 工时 | 验收 |
|---|---|---|---|
| P0 | 建库 + 双写 + 迁移 + 检索工具 + prompt 拼装 | 1~2 天 | QQ 里问「上周三我说过啥」能命中原文；`memory_search` 返回带日期 |
| P1 | world 瘦身（life/qq/wechat/desktop 关，persona 清空） | 半天 | 房间壁纸仍正常；`/health` world ok；无第二个「她」发言 |
| P2 | 清理 world-reply 路径 + 文档 + 迁移包补记忆库 | 半天 | 迁移包 `runtimes/` 之外新增 `state/memory/` |
| P3（可选） | world 日记/认识页 nightly 摘要进 `cards` | 半天 | 次日 `cards(kind='diary')` 有新增 |

## 6. 风险与回滚
| 风险 | 应对 |
|---|---|
| 双写丢消息 | 异步队列 + 每晚对账 |
| FTS5 中文 | 先用 `tokenize='trigram'`；不行退回 LIKE |
| prompt 膨胀 | 固定三级预算，超了先砍命中片段 |
| 想退回旧行为 | `config.json` 加 `socialV2.memory.backend: 'card' | 'elysia'`，默认 **card**，出问题一键切回 |
| world 升级覆盖 | 记忆库在 SurfCore state，不在 world 目录 |
| 房间壁纸依赖 DSH | 已有 `SurfCoreDsh`（登录 20 秒自启）+ `SurfCoreWorldRoom` |

## 7. 需要你拍的三件事
1. 电脑操作给谁：**A 全给 SurfCore**（推荐）还是 B 留 world 任务会话？
2. 检索分词：先用 trigram（零依赖）还是上 jieba（更准但要装包）？
3. `memory.backend` 默认值：先 `card`（稳，需手动切）还是直接 `elysia`（一步到位）？
