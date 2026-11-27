/**
 * 能力地图：一份数据，三处消费。
 *
 *   1) `renderPresetBlock()` → 写进 QQ 预设的 system prompt（她每轮都能看到，短）
 *   2) `renderHelp(topic)`    → `qq_help` 工具 / `/api/socialV2/help`（要看细节时查，长）
 *   3) `node scripts/render-capabilities.mjs --write` → 把 1) 自动贴进 preset 与 README
 *
 * 改能力只改这里，别在 preset 里手抄第二份——不然两边一定会漂。
 */

export const CAPABILITIES = [
  {
    id: 'run_code',
    title: '在本机跑命令',
    tools: ['qq_run_code'],
    when: '要看文件、查进程、跑脚本、git 操作、装东西',
    limits: '黑名单模式：只拦 del /s、format、shutdown、taskkill、reg 这类破坏性指令；cwd 是用户主目录；输出超过 8000 字会截断',
    example: 'qq_run_code(command="git -C D:/surfcore/repo log --oneline -5")',
  },
  {
    id: 'tasks',
    title: '挂后台长任务',
    tools: ['qq_task_run', 'qq_task_status', 'qq_task_cancel'],
    when: '下载、构建、批量处理这种要跑几分钟的活，别占着聊天回合',
    limits: '并发 2、排队 10；产出一律写日志文件，不把日志塞回对话；失败/要你拍板才当场打断',
    example: 'qq_task_run(title="跑回归", command="node scripts/test-audit.mjs")',
  },
  {
    id: 'schedule',
    title: '日程 / 定时器',
    tools: ['qq_schedule_add', 'qq_schedule_list', 'qq_schedule_cancel'],
    when: '「晚上 8 点去刷两条 B 站」「每天 21:00 提醒他吃药」',
    limits: '到点唤醒你自己去执行；一次性或每天重复；注入成一条【日程】消息',
    example: 'qq_schedule_add(title="刷B站", time="20:00", repeat="daily")',
  },
  {
    id: 'phone',
    title: '派活给手机',
    tools: ['qq_wake_phone', 'qq_phone_result'],
    when: '需要在手机上做的事（看 App、点东西、手机上的相册/通知）',
    limits: '手机端要在线并挂着 puller；结果回来会进【手机任务】块；执行上限约 5 分钟',
    example: 'qq_wake_phone(title="看一眼电量", prompt="把手机当前电量告我")',
  },
  {
    id: 'memory',
    title: '查记忆',
    tools: ['qq_memory_search', 'qq_memory_get', 'qq_memory_day'],
    when: '想确认「他之前说过什么」「那天发生什么」时，先查再答，别硬编',
    limits: '全量库（原文 + 卡片 + 日记），FTS 检索；查到的是原话，引用时别改意思',
    example: 'qq_memory_search(query="工资")',
  },
  {
    id: 'computer',
    title: '操作电脑 / 浏览器',
    tools: ['computer_use', 'procedure_run', 'procedure_save', 'procedure_note', 'routines', 'page_*'],
    when: '要开网页、点按钮、看用户屏幕上的东西、重复上次学会的操作',
    limits: '自带浏览器不抢用户鼠标；用户电脑默认后台投递；点击带拟人路径；只做让做的（不碰支付/系统设置）',
    example: 'computer_use(target="B站")  # 先看有没有学会的操作',
  },
  {
    id: 'see',
    title: '看屏幕 / 在小窗说话',
    tools: ['see_now'],
    when: '他在电脑前，你想陪着看/说一句；或他说「你看下屏幕」',
    limits: '只读像素；`say` 是唯一进悬浮窗并被念出来的通道；别为刷存在感而说话',
    example: 'see_now(action="watch", say="看到了，别熬太晚。")',
  },
  {
    id: 'images',
    title: '发图片 / 表情包 / 语音',
    tools: ['qq_send_image', 'qq_send_sticker', 'sticker_search', 'qq_send_voice', 'qq_list_voices'],
    when: '想给他看图、发表情、用语音说一句',
    limits: '图片支持本地路径/URL/base64；表情包先搜索再发；语音默认关（要开才发）',
    example: 'sticker_search(query="委屈") → sticker_send(name=…) → qq_send_image(image=…)',
  },
  {
    id: 'subagent',
    title: '派子 agent',
    tools: ['subagent', 'subagent_fork'],
    when: '查一堆资料、跑独立分析、批量整理——不打断当前聊天的活',
    limits: '别把闲聊或一句话能答的事派出去；它的结论自己核一眼再说',
    example: 'subagent(prompt="把这份 README 的自用改动整理成清单")',
  },
  {
    id: 'wechat',
    title: '发微信',
    tools: ['qq_wechat_send'],
    when: '他说「微信上说」或者你想在微信里留一句',
    limits: '走本机适配器；当前微信版本不支持（4.2.1.8），消息会排队 pending，先别指望它',
    example: 'qq_wechat_send(text="到家了说一声")',
  },
  {
    id: 'context',
    title: '上下文压缩',
    tools: ['compress', 'decompress', 'search_context'],
    when: '回合太长、要翻旧内容',
    limits: 'compress 一次至少要 5000 字符；报「太小」是正常提示，别重试',
    example: 'search_context(query="工资那条")',
  },
]

/** 预设里那段短地图（每行一条，控制长度）。 */
export function renderPresetBlock() {
  const lines = [
    '【你能做什么·地图】（细节用 `qq_help(topic=…)` 查，别凭印象编）',
  ]
  for (const c of CAPABILITIES) {
    lines.push(`- ${c.title}（${c.tools[0]}${c.tools.length > 1 ? ' 等' : ''}）：${c.when}`)
  }
  lines.push('- 没列到的能力就是没有：先 `qq_help()` 看一眼，别硬试被拒的工具。')
  return lines.join('\n')
}

/** `qq_help` 的正文。topic 为空 → 总览；否则返回该条的完整说明。 */
export function renderHelp(topic) {
  const key = String(topic ?? '').trim().toLowerCase()
  if (!key) {
    const lines = ['能做的事（按主题）：']
    for (const c of CAPABILITIES) lines.push(`- ${c.id}｜${c.title}｜${c.tools.join(' / ')}｜${c.when}`)
    lines.push('', '要看某一条的边界和例子：qq_help(topic="run_code")')
    return lines.join('\n')
  }
  const hit = CAPABILITIES.find((c) => c.id === key || c.title.includes(topic) || c.tools.includes(topic))
  if (!hit) {
    return `没有这个主题：${topic}\n可用：${CAPABILITIES.map((c) => c.id).join('、')}`
  }
  return [
    `## ${hit.title}`,
    `工具：${hit.tools.join(' / ')}`,
    `什么时候用：${hit.when}`,
    `边界：${hit.limits}`,
    `例子：${hit.example}`,
  ].join('\n')
}

export function capabilityIds() {
  return CAPABILITIES.map((c) => c.id)
}
