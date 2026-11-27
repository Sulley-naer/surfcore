# 电脑操作（evolution-computer-use）

> 本地 fork 的 ECU：她自己的浏览器 + 用户电脑（后台投递），点击前带拟人鼠标路径，学会的操作会沉淀成 procedure。

- 本地 fork：`D:\surfcore\runtimes\ecu-src`（从 `npx` 缓存复制，0.1.0，MIT），MCP 条目 `mcp-computer-use` 用
  `cmd.exe /c node D:\surfcore\runtimes\ecu-src\lib\cli.js --desktop background --data D:\surfcore\runtimes\ecu` 启动。
- `plugins/surfcore/qq-tool-restrict.mjs` 的 `SAFE_PREFIXES` 放行 `mcp__evolution-computer-use__`：QQ 侧的她可直接调
  `computer_use / procedure_run / procedure_save / procedure_note / routines / page_* / desktop / inbox_read`。
- **像人手一样点**（fork 新增，`src/shared/human.js`）：点击前用随机三次贝塞尔走过去，30~60 个采样点、300~900ms、
  落点 ±3px 抖动、连点之间随机停 80~250ms。参数在 `D:\surfcore\runtimes\ecu\input.json`（或 `ECU_INPUT_JSON` 指向的文件）：

  ```json
  { "samplesMin": 30, "samplesMax": 60, "durationMinMs": 300, "durationMaxMs": 900,
    "jitterPx": 3, "clickGapMinMs": 80, "clickGapMaxMs": 250 }
  ```
- **学会的操作要沉淀**（preset 第 16.5 条）：动手前先 `computer_use(target="对象名")` 查有没有学过；走通一次就
  `procedure_save` + `procedure_note`（写网址/程序、登录状态、关键按钮原文、常见坑），回放失败就地修并覆盖同名操作。
- 与 see-now 共存：ECU 前台操作时画面变化大，把 see-now 的 `pace` 降档或 `stop`。
