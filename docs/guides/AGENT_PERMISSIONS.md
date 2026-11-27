# 她能调用的工具与权限边界

> 这份是「问答侧（QQ 私聊）」的工具面说明。三层开关从粗到细，改任何一层都要重启 DSH 才生效。
> 相关文件：`plugins/surfcore/qq-tool-restrict.mjs`、`config.json` 的 `socialV2.tools.*`、设置页「功能开关」。

只有 `private:<ownerQQ>` 这条会话能调，群里和别人的私聊都拒。三层开关，从粗到细：

| 层 | 在哪 | 作用 |
| --- | --- | --- |
| 注册期隐藏 | `plugins/surfcore/qq-tool-restrict.mjs` 的 `KNOWN_DANGEROUS_GLOBAL_TOOLS` | 从工具表里彻底不出现（`read/write/bash/spawn_teammate/workflow` 等） |
| 执行期白名单 | 同文件 `SAFE_EXACT` + `SAFE_PREFIXES` | 放行单个工具名（`see_now` / `sticker_*` / `subagent` …）或整个命名空间（`mcp__snowluma__` / `mcp__evolution-computer-use__` / `mcp__web-search-safe__`） |
| 功能开关 | `config.json` 的 `socialV2.tools.*` 与设置页「功能开关」 | 13+17 项，关掉即隐藏对应工具，无需改代码 |

现在她能用的执行类工具：

| 工具 | 能做什么 | 关掉的办法 |
| --- | --- | --- |
| `qq_run_code` | 在本机跑命令（黑名单模式：只拦 `del /s`、`format`、`shutdown`、`taskkill` 这类破坏性指令；cwd=用户主目录） | `socialV2.exec.enabled=false` 或 `tools.runCode=false` |
| `qq_task_run` / `qq_task_status` / `qq_task_cancel` | 挂后台长任务（并发 2、排队 10），完成后走 purpose 链路汇报 | `tools.taskRun/taskStatus/taskCancel` |
| `qq_schedule_add` / `qq_schedule_list` / `qq_schedule_cancel` | 排日程，到点唤醒她自己执行 | `socialV2.schedules.enabled` |
| `qq_wake_phone` / `qq_phone_result` | 反向长轮询派活给手机 agent（公网 `https://wake.xinzhi.stream`，UA 要 `dshgo/1.0`） | `socialV2.phoneWake.enabled` |
| `qq_memory_search` / `qq_memory_get` / `qq_memory_day` | 查全量记忆（原文 + 卡片 + 日记） | `socialV2.memory.enabled` |
| `qq_wechat_send` | 发微信（走本机适配器；当前微信版本不支持，先挂着） | `socialV2.wechat.enabled` |
| `qq_send_image` / `qq_send_sticker` / `sticker_*` | 发图/表情包 | `tools.sendImage/sendSticker` |
| `mcp__evolution-computer-use__*` | 操作她自己的浏览器 + 用户电脑（后台投递），带拟人鼠标路径与 procedure 沉淀 | 从 `SAFE_PREFIXES` 摘掉该前缀 |
| `subagent` / `subagent_fork` | 把独立耗时的活派给子 agent，结论回来自己核 | 从 `SAFE_EXACT` 摘掉，或加回 `KNOWN_DANGEROUS_GLOBAL_TOOLS` |
| `see_now` | 看屏幕 / 悬浮窗说话（只读像素） | 从 `SAFE_EXACT` 摘掉 |
| `compress` / `decompress` / `search_context` | 上下文压缩（不放行时模型会反复重试被拒工具） | 同上 |

没开的口子（保持隐藏）：`read/write/edit/glob/grep`、`bash/pwsh`、`spawn_teammate`、`team_task_*`、`workflow/ralph`、
`plugin_manager`、`schedule_*`（DSH 自带那套，避免与 SurfCore 日程抢）、`send_message/interrupt_agent/list_agents`。
