# 全量记忆（elysia）

> SurfCore 从「衰减卡 + 全量卡」扩到「可检索的全量库」。卡还在，用于人格与情绪权重；库用于原文召回。

- 后端：`src/memory-store.mjs`（Node 自带 `node:sqlite` + FTS5 trigram），库文件 `state/memory/elysia-memory.sqlite`。
  表：`events`（每条聊天原文，含 role/speaker/ts/day/channel）、`events_fts`、`cards`（记忆卡/日记/认识页，带 importance/emotional/clarity）、`days`、`meta`。
- 迁移：`node scripts/migrate-memory.mjs`（支持 `--dry-run`）。当前库：events 114 / cards 1187 / days 3。
- 接线：`socialV2.memory = {enabled, backend:'card'|'elysia', recentCount, hitCount, maxChars}`。
  backend 为 `elysia` 时，唤醒 prompt 在记忆卡之后注入「【记忆·原文】最近 N 条」+「【记忆·相关】FTS 命中」两段；来信/发出消息都会写 `events`。
- 工具（owner 私聊）：`qq_memory_search`（query/limit）、`qq_memory_get`（id，卡片或原文）、`qq_memory_day`（day，默认今天：日摘要 + 事件 + 最近）。
- 端点：`POST /api/socialV2/memory-search` / `memory-get` / `memory-day`，都走 owner-only + agent token + `socialV2.tools.memorySearch|memoryGet|memoryDay`。
