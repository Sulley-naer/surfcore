/**
 * owner 控制类 qq_* 工具（插件内注册版）。
 *
 * 为什么有一份放在插件层：
 *   · 这些工具原本由 src/mcp-snowluma-safe.js 在 DSH 启动时注册，改一次描述/参数就得重启 DSH；
 *   · 插件内用 ctx.tools.register 注册后，可以随设置页/配置变化「内层插件重挂」生效，
 *     不必整进程重启（见 lib/index.js 的 remountQqTools）。
 *
 * 开关：config.json 的 `socialV2.toolSource`。
 *   - 'mcp'（默认）：MCP server 注册，插件不注册（避免同名工具打架）。
 *   - 'plugin'：插件注册，MCP 侧跳过这 9 个工具。
 *
 * 这里只做「描述 + 参数 + 转发桥接端点」，与 MCP 版行为一致：
 * 鉴权头 x-agent-token（工具参数里的 token）+ x-console-token（config）+ x-agent-call: 1。
 */
import { readQqConfig } from './store.js';

function bridgeBase(qq = readQqConfig().config ?? {}) {
  const port = Number(qq.consolePort) || 3100;
  return `http://127.0.0.1:${port}`;
}

function bridgeHeaders(token) {
  const qq = readQqConfig().config ?? {};
  const consoleToken = String(qq.consoleToken ?? '').trim();
  return {
    'content-type': 'application/json',
    ...(consoleToken ? { 'x-console-token': consoleToken } : {}),
    'x-agent-call': '1',
    ...(token ? { 'x-agent-token': String(token) } : {}),
  };
}

/** 调桥接 agent 端点；返回解析后的 JSON，HTTP 非 2xx / ok:false 抛错（与 MCP 版同语义）。 */
export async function callBridge(path, body, { token, timeoutMs = 30000 } = {}) {
  const res = await fetch(`${bridgeBase()}${path}`, {
    method: 'POST',
    headers: bridgeHeaders(token),
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(Math.max(1000, Number(timeoutMs) || 30000)),
  });
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok) throw new Error(data?.error ? String(data.error) : `桥接 API HTTP ${res.status}`);
  if (data && typeof data === 'object' && data.ok === false) throw new Error(String(data.error ?? '桥接 API 返回 ok:false'));
  return data;
}

const KEY_DESC = '会话 key，格式 private:QQ号（仅管理员私聊）';
const TOKEN_DESC = '会话令牌（见唤醒提示中的【会话令牌】）';

/** 工具定义表：9 个 owner 控制工具。 */
export const QQ_TOOL_SPECS = [
  {
    id: 'qq_run_code',
    configFlag: 'runCode',
    name: 'qq_run_code',
    description: '在管理员本机执行一条命令并返回输出（约 90 秒超时，只适合短命令；长任务用 qq_task_run 挂后台）。仅管理员私聊可用。默认黑名单模式：放行任意命令、只拦破坏性指令，可写文件、改配置。Windows cmd 没有 ls/cat，用 dir/type。注意：findstr/grep 没搜到内容时退出码是 1，属正常未命中，工具会标成功并说明，不要重复重试。',
    parameters: {
      key: { type: 'string', required: true, description: KEY_DESC },
      token: { type: 'string', required: true, description: TOKEN_DESC },
      command: { type: 'string', required: true, description: '要执行的单条命令，如 "git status"、"dir"、"type README.md"' },
    },
    endpoint: '/api/socialV2/run-code',
    timeoutMs: 95000,
    body: (a) => ({ key: a.key, command: String(a.command) }),
  },
  {
    id: 'qq_task_run',
    configFlag: 'taskRun',
    name: 'qq_task_run',
    description: '把一个长任务挂到后台队列执行，立即结束当前对话回合、不占用消息通道。适合下载、安装环境、构建这类耗时长的命令。最多 2 个并行、排队最多 10 个。执行日志会写到文件（对话里只报日志路径，别把日志正文塞回对话）。任务完成后会在唤醒时收到【任务】汇报块：先向主人汇报结果再回应其他内容；失败或需要拍板的任务会当场主动通知。参数：title 一句话标题；command 要跑的命令；timeoutMs 可选超时毫秒（默认 30 分钟、上限 6 小时）。仅管理员私聊可用。',
    parameters: {
      key: { type: 'string', required: true, description: KEY_DESC },
      token: { type: 'string', required: true, description: TOKEN_DESC },
      title: { type: 'string', required: true, description: '一句话标题，如「下载 faster-whisper 模型」' },
      command: { type: 'string', required: true, description: '要后台执行的命令，如 "pip download torch --dest C:/dl"' },
      timeoutMs: { type: 'number', description: '可选超时毫秒（默认 30 分钟、上限 6 小时）' },
    },
    endpoint: '/api/socialV2/task-run',
    body: (a) => ({ key: a.key, title: String(a.title), command: String(a.command), ...(Number(a.timeoutMs) > 0 ? { timeoutMs: Number(a.timeoutMs) } : {}) }),
  },
  {
    id: 'qq_task_status',
    configFlag: 'taskStatus',
    name: 'qq_task_status',
    description: '查看后台任务队列：运行中 / 排队中 / 待汇报的任务与最近历史（含日志路径）。适合主人问「任务跑得怎么样了」时用。仅管理员私聊可用。',
    parameters: {
      key: { type: 'string', required: true, description: KEY_DESC },
      token: { type: 'string', required: true, description: TOKEN_DESC },
    },
    endpoint: '/api/socialV2/tasks',
    body: (a) => ({ key: a.key }),
  },
  {
    id: 'qq_task_cancel',
    configFlag: 'taskCancel',
    name: 'qq_task_cancel',
    description: '撤销一个还在排队（未开始执行）的任务。运行中的任务第一版不支持喊停。taskId 用 qq_task_status 返回的 id（如 t3）。仅管理员私聊可用。',
    parameters: {
      key: { type: 'string', required: true, description: KEY_DESC },
      token: { type: 'string', required: true, description: TOKEN_DESC },
      taskId: { type: 'string', required: true, description: '要撤销的任务 id（来自 qq_task_status，如 t3）' },
    },
    endpoint: '/api/socialV2/task-cancel',
    body: (a) => ({ key: a.key, taskId: String(a.taskId) }),
  },
  {
    id: 'qq_schedule_add',
    configFlag: 'scheduleAdd',
    name: 'qq_schedule_add',
    description: '把一件事排到某个时间点：到点桥接会唤醒你，把「该做这件事了」塞进你的指令里，你再用自己的工具去执行（比如刷 B 站、把链接发给主人）。适合「晚上 8 点去刷两条 B 站，把链接甩给你」这类日程。time 用 "HH:mm" 或 "HH:mm:ss"（24 小时制；今天这个点已过就排到明天），也可以传绝对毫秒时间戳。repeat="daily" 表示每天同一时刻重复（适合「每天下班甩链接」），默认一次性。仅管理员私聊可用。到点前后 `qq_schedule_list` 可查。',
    parameters: {
      key: { type: 'string', required: true, description: KEY_DESC },
      token: { type: 'string', required: true, description: TOKEN_DESC },
      title: { type: 'string', required: true, description: '一句话标题，如「刷两条 B 站」' },
      time: { type: 'string', required: true, description: '时间，如 "20:00"、"20:30:00"，或绝对毫秒时间戳' },
      description: { type: 'string', description: '要做什么（可空），比如「刷两条 B 站，把链接发给主人」' },
      repeat: { type: 'string', enum: ['none', 'daily'], description: 'none=一次性（默认），daily=每天同一时刻' },
    },
    endpoint: '/api/socialV2/schedule-add',
    body: (a) => ({ key: a.key, title: String(a.title), time: String(a.time), description: a.description ?? '', repeat: a.repeat === 'daily' ? 'daily' : 'none' }),
  },
  {
    id: 'qq_schedule_list',
    configFlag: 'scheduleList',
    name: 'qq_schedule_list',
    description: '查看你安排的所有日程：待触发的（按时间排序）、已完成的、已取消的。仅管理员私聊可用。',
    parameters: {
      key: { type: 'string', required: true, description: KEY_DESC },
      token: { type: 'string', required: true, description: TOKEN_DESC },
    },
    endpoint: '/api/socialV2/schedules',
    body: (a) => ({ key: a.key }),
  },
  {
    id: 'qq_schedule_cancel',
    configFlag: 'scheduleCancel',
    name: 'qq_schedule_cancel',
    description: '取消一条日程（一次性或每天重复的都行）。scheduleId 用 qq_schedule_list 返回的 id（如 s3）。仅管理员私聊可用。',
    parameters: {
      key: { type: 'string', required: true, description: KEY_DESC },
      token: { type: 'string', required: true, description: TOKEN_DESC },
      scheduleId: { type: 'string', required: true, description: '要取消的日程 id（来自 qq_schedule_list，如 s3）' },
    },
    endpoint: '/api/socialV2/schedule-cancel',
    body: (a) => ({ key: a.key, scheduleId: String(a.scheduleId) }),
  },
  {
    id: 'qq_wake_phone',
    configFlag: 'wakePhone',
    name: 'qq_wake_phone',
    description: '把一条任务派给主人的手机 agent 执行，返回任务 id；结果稍后可用 qq_phone_result 查。手机通过反向长轮询主动来取任务，电脑不需要能连到手机，只要求两边同时在线（内网同一局域网）。一次只派一条、以手机实际结果为准，不要假设已完成。仅管理员私聊可用。',
    parameters: {
      key: { type: 'string', required: true, description: KEY_DESC },
      token: { type: 'string', required: true, description: TOKEN_DESC },
      title: { type: 'string', required: true, description: '一句话标题，如「在手机上记一笔备忘录」' },
      prompt: { type: 'string', required: true, description: '给手机 agent 的完整指令（它会独立执行，不要依赖当前对话上下文）' },
      timeoutMs: { type: 'number', description: '可选超时毫秒（默认 10 分钟）' },
    },
    endpoint: '/api/socialV2/wake-phone',
    body: (a) => ({ key: a.key, title: String(a.title), prompt: String(a.prompt), ...(Number(a.timeoutMs) > 0 ? { timeoutMs: Number(a.timeoutMs) } : {}) }),
  },
  {
    id: 'qq_phone_result',
    configFlag: 'phoneResult',
    name: 'qq_phone_result',
    description: '查看派给手机 agent 的任务结果。不传 taskId 时返回最近 5 条（含状态、结果摘要、耗时、设备）；传 taskId 返回那一条的完整结果。状态 done/failed/expired。仅管理员私聊可用。',
    parameters: {
      key: { type: 'string', required: true, description: KEY_DESC },
      token: { type: 'string', required: true, description: TOKEN_DESC },
      taskId: { type: 'string', description: '可选：手机任务 id（来自 qq_wake_phone 返回的 task.id）' },
    },
    endpoint: '/api/socialV2/phone-result',
    body: (a) => ({ key: a.key, ...(a.taskId ? { taskId: String(a.taskId) } : {}) }),
  },
];


/** 参数规格 → JSON Schema（与 dsh-tools 的 parameterSchemaSpecToJsonSchema 保持同形）。 */
function specToJsonSchema(parameters = {}) {
  const properties = {};
  const required = [];
  for (const [name, spec] of Object.entries(parameters)) {
    const prop = { type: spec?.type === 'integer' ? 'integer' : (spec?.type === 'number' ? 'number' : 'string') };
    if (spec?.description) prop.description = String(spec.description);
    if (Array.isArray(spec?.enum) && spec.enum.length) prop.enum = spec.enum.slice();
    properties[name] = prop;
    if (spec?.required === true) required.push(name);
  }
  return { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false };
}

/**
 * 最小 defineTool 实现：DSH 运行时若拿不到 @deepseek-ai/dsh-tools（插件是 junction 进 profile 的，
 * 依赖解析可能落不到 DSH 自己的 node_modules），用这个等价物兜底，保证工具能注册。
 */
export function minimalDefineTool(options) {
  const jsonSchema = specToJsonSchema(options.parameters);
  return {
    name: options.name,
    description: options.description,
    parameters: jsonSchema,
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value ?? '') }],
    },
    isConcurrencySafe: typeof options.isConcurrencySafe === 'function' ? options.isConcurrencySafe : () => false,
    execute: options.execute,
  };
}

/** 当前应注册哪些工具（按 config.json 的 socialV2.tools.* 开关过滤）。 */
export function enabledQqToolSpecs(cfg = readQqConfig().config ?? {}) {
  const tools = cfg?.socialV2?.tools ?? {};
  return QQ_TOOL_SPECS.filter((spec) => tools?.[spec.configFlag] !== false);
}

/**
 * 注册到 actx.tools。
 * @param {object} actx        内层插件上下文（inject: ['tools']）
 * @param {object} opts        { defineTool, log?, cfg? }
 * @returns {string[]} 实际注册的工具名
 */
export function registerQqTools(actx, { defineTool, log, cfg } = {}) {
  const factory = typeof defineTool === 'function' ? defineTool : minimalDefineTool;
  const config = cfg ?? (readQqConfig().config ?? {});
  if (config?.socialV2?.toolSource !== 'plugin') return [];
  const registered = [];
  for (const spec of enabledQqToolSpecs(config)) {
    actx.tools.register(factory({
      name: spec.name,
      description: spec.description,
      parameters: spec.parameters,
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value ?? '') }] },
      isConcurrencySafe: () => false,
      async execute(args = {}) {
        try {
          const data = await callBridge(spec.endpoint, spec.body(args), { token: args.token, timeoutMs: spec.timeoutMs ?? 30000 });
          return JSON.stringify(data ?? { ok: true }, null, 2);
        } catch (error) {
          log?.warn?.('[qq-tools] %s 失败: %s', spec.name, error?.message ?? error);
          return `调用失败：${String(error?.message ?? error)}`;
        }
      },
    }));
    registered.push(spec.name);
  }
  return registered;
}
