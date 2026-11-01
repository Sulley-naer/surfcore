/**
 * 后台任务台账（owner tasks）—— 纯逻辑层。
 *
 * 背景（2026-11-01）：主人在 QQ 里让 AI 跑长任务（下载模型 / 装环境 / 回归测试…）。
 * 以前这些活走 qq_run_code 一问一答：60 秒超时、占住整个对话回合、别的消息排队，
 * 长任务还可能把事件循环卡到"后续死在那"。现在改成后台队列：
 *   · AI 只负责「把任务挂上队列」（快，立即结束回合）；
 *   · 桥接后台 spawn 执行（不阻塞消息处理）；
 *   · 完成后**攒着**，等自然醒来一起汇报；失败 / 需要拍板才当场打断（由 bridge 调度）；
 *   · 产出（stdout/stderr）写文件，对话里只放一句话结论 + 文件路径，不塞日志。
 *
 * 本文件只做「算」：配置归一化、任务状态机、队列/上限判断、汇报块生成。
 * 不碰进程、不写盘、不发 QQ —— 副作用都在 src/bridge.js。
 */

export const TASK_STATE_VERSION = 1;

/** 默认配置：并发 2、排队上限 10（超了直接拒）、单任务默认 30 分钟超时。 */
export const DEFAULT_TASK_CONFIG = Object.freeze({
  enabled: true,
  maxActive: 2,
  maxQueue: 10,
  defaultTimeoutMs: 30 * 60 * 1000,
  maxTimeoutMs: 6 * 60 * 60 * 1000,
  maxHistory: 50,
  summaryMaxChars: 500,
  // 「主人在不在聊」的判定窗口：距主人最后发言/她最后回复超过该值算空闲（可当场打断）。
  notifyIdleMs: 10 * 60 * 1000,
});

/** 任务状态机。done/cancelled 攒着报；failed/need-decision 当场打断。 */
export const TASK_STATUSES = Object.freeze([
  'pending',
  'running',
  'done',
  'failed',
  'need-decision',
  'cancelled',
]);

export const URGENT_TASK_STATUSES = Object.freeze(['failed', 'need-decision']);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clampInt(value, fallback, min, max) {
  // null/undefined/空串都算「没传」——否则 Number(null)=0 是有限数，会被 min 夹成最小值
  // （qq_task_run 不传 timeoutMs 时曾因此把默认 30 分钟变成 60 秒）。
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function clip(text, max) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export function normalizeTaskConfig(input) {
  const src = isPlainObject(input) ? input : {};
  return {
    enabled: src.enabled !== false,
    maxActive: clampInt(src.maxActive, DEFAULT_TASK_CONFIG.maxActive, 1, 8),
    maxQueue: clampInt(src.maxQueue, DEFAULT_TASK_CONFIG.maxQueue, 0, 100),
    defaultTimeoutMs: clampInt(src.defaultTimeoutMs, DEFAULT_TASK_CONFIG.defaultTimeoutMs, 60 * 1000, 24 * 60 * 60 * 1000),
    maxTimeoutMs: clampInt(src.maxTimeoutMs, DEFAULT_TASK_CONFIG.maxTimeoutMs, 60 * 1000, 24 * 60 * 60 * 1000),
    maxHistory: clampInt(src.maxHistory, DEFAULT_TASK_CONFIG.maxHistory, 1, 500),
    summaryMaxChars: clampInt(src.summaryMaxChars, DEFAULT_TASK_CONFIG.summaryMaxChars, 40, 4000),
    notifyIdleMs: clampInt(src.notifyIdleMs, DEFAULT_TASK_CONFIG.notifyIdleMs, 60 * 1000, 6 * 60 * 60 * 1000),
  };
}

function normalizeTask(raw, fallback = {}) {
  if (!isPlainObject(raw)) return null;
  const status = TASK_STATUSES.includes(raw.status) ? raw.status : fallback.status;
  if (!status) return null;
  return {
    id: String(raw.id ?? fallback.id ?? ''),
    seq: Number(raw.seq ?? fallback.seq ?? 0) || 0,
    title: String(raw.title ?? fallback.title ?? '').slice(0, 120),
    command: String(raw.command ?? fallback.command ?? ''),
    status,
    needDecision: Boolean(raw.needDecision ?? fallback.needDecision ?? false),
    createdAt: Number(raw.createdAt ?? fallback.createdAt ?? 0) || 0,
    startedAt: Number(raw.startedAt ?? fallback.startedAt ?? 0) || 0,
    finishedAt: Number(raw.finishedAt ?? fallback.finishedAt ?? 0) || 0,
    code: raw.code == null ? null : Number(raw.code),
    durationMs: Number(raw.durationMs ?? fallback.durationMs ?? 0) || 0,
    summary: String(raw.summary ?? fallback.summary ?? '').slice(0, 2000),
    outputFile: String(raw.outputFile ?? fallback.outputFile ?? ''),
    notifiedAt: Number(raw.notifiedAt ?? fallback.notifiedAt ?? 0) || 0,
  };
}

export function normalizeTaskState(raw, now = Date.now()) {
  const src = isPlainObject(raw) ? raw : {};
  const queue = [];
  const seen = new Set();
  for (const item of Array.isArray(src.queue) ? src.queue : []) {
    const task = normalizeTask(item, { status: 'pending' });
    if (!task || !task.id || seen.has(task.id)) continue;
    seen.add(task.id);
    queue.push(task);
  }
  const history = [];
  for (const item of Array.isArray(src.history) ? src.history : []) {
    const task = normalizeTask(item);
    if (!task || !task.id || seen.has(task.id)) continue;
    seen.add(task.id);
    history.push(task);
  }
  // 重启后：跑了一半的任务按失败收尾（下次唤醒时自然汇报"上次没跑完"）。
  for (const task of queue) {
    if (task.status === 'running') {
      task.status = 'failed';
      task.finishedAt = Number(task.finishedAt) || now;
      task.summary = task.summary || '桥接重启，任务中断';
      task.durationMs = task.durationMs || Math.max(0, task.finishedAt - (task.startedAt || task.createdAt || now));
    }
  }
  const state = {
    version: TASK_STATE_VERSION,
    seq: clampInt(src.seq, 0, 0, 1000000),
    queue,
    history: history.slice(-(clampInt(src.maxHistory, 50, 1, 500))),
  };
  ageOutHistory(state, now, clampInt(src.maxHistory, 50, 1, 500));
  return state;
}

export function runningTasks(state) {
  return (state.queue || []).filter((t) => t.status === 'running');
}

export function pendingTasks(state) {
  return (state.queue || []).filter((t) => t.status === 'pending');
}

export function activeTasks(state) {
  return (state.queue || []).filter((t) => t.status === 'pending' || t.status === 'running');
}

/** 已完成但还没汇报的任务（done/failed/need-decision/cancelled 且 notifiedAt 为空）。 */
export function pendingReports(state) {
  const done = new Set(['done', 'failed', 'need-decision', 'cancelled']);
  return (state.queue || []).filter((t) => done.has(t.status) && !t.notifiedAt);
}

export function urgentReports(state) {
  return pendingReports(state).filter((t) => URGENT_TASK_STATUSES.includes(t.status));
}

export function taskById(state, id) {
  return (state.queue || []).find((t) => t.id === String(id)) || null;
}

/**
 * 挂一个新任务。队列语义：running 满 → 进 pending 排队；pending 超 maxQueue → 直接拒。
 * 返回 { ok, task? , reason? }；reason 取值 'disabled' | 'invalid-title' | 'invalid-command' | 'queue-full'。
 */
export function createTask(state, { title, command, timeoutMs, now = Date.now(), config }) {
  const cfg = config ?? DEFAULT_TASK_CONFIG;
  if (cfg.enabled === false) return { ok: false, reason: 'disabled' };
  const t = clip(String(title ?? ''), 120);
  const c = String(command ?? '').trim();
  if (!t) return { ok: false, reason: 'invalid-title' };
  if (!c) return { ok: false, reason: 'invalid-command' };
  if (pendingTasks(state).length >= cfg.maxQueue) return { ok: false, reason: 'queue-full' };
  state.seq = (state.seq || 0) + 1;
  const task = {
    id: `t${state.seq}`,
    seq: state.seq,
    title: t,
    command: c,
    status: 'pending',
    needDecision: false,
    createdAt: now,
    startedAt: 0,
    finishedAt: 0,
    code: null,
    durationMs: 0,
    summary: '',
    outputFile: '',
    notifiedAt: 0,
    timeoutMs: clampInt(timeoutMs, cfg.defaultTimeoutMs, 60 * 1000, cfg.maxTimeoutMs),
  };
  state.queue.push(task);
  return { ok: true, task };
}

/** 取下一个该跑的 pending（FIFO）；没有返回 null。 */
export function popNextTask(state) {
  const idx = state.queue.findIndex((t) => t.status === 'pending');
  if (idx < 0) return null;
  return state.queue[idx];
}

export function startTask(state, id, now = Date.now()) {
  const task = taskById(state, id);
  if (!task) return { ok: false, reason: 'not-found' };
  if (task.status !== 'pending') return { ok: false, reason: `not-pending:${task.status}` };
  task.status = 'running';
  task.startedAt = now;
  return { ok: true, task };
}

/**
 * 收尾一个任务。needDecision=true 时即使 ok 也标 need-decision（当场打断）。
 * summary 一句话结论；outputFile 是产出日志的路径（相对 state 目录），对话里只报路径。
 */
export function finishTask(state, id, options = {}) {
  const { ok, code = null, summary = '', outputFile = '', needDecision = false, now = Date.now() } = options;
  const task = taskById(state, id);
  if (!task) return { ok: false, reason: 'not-found' };
  if (task.status !== 'running') return { ok: false, reason: `not-running:${task.status}` };
  task.finishedAt = now;
  task.durationMs = Math.max(0, now - (task.startedAt || task.createdAt || now));
  task.code = code;
  task.summary = clip(summary, 2000);
  task.outputFile = String(outputFile ?? '');
  task.needDecision = Boolean(needDecision);
  task.status = needDecision ? 'need-decision' : (ok ? 'done' : 'failed');
  return { ok: true, task };
}

/** 只允许撤「排队中」的任务；running 不撤（第一版不做喊停），done 类无意义。 */
export function cancelTask(state, id, now = Date.now()) {
  const task = taskById(state, id);
  if (!task) return { ok: false, reason: 'not-found' };
  if (task.status !== 'pending') return { ok: false, reason: `not-pending:${task.status}` };
  task.status = 'cancelled';
  task.finishedAt = now;
  task.summary = clip(task.summary || '任务已取消', 2000);
  return { ok: true, task };
}

export function markNotified(state, ids, now = Date.now()) {
  const wanted = new Set((Array.isArray(ids) ? ids : []).map(String));
  for (const task of state.queue || []) {
    if (wanted.has(task.id) && !task.notifiedAt) task.notifiedAt = now;
  }
  return true;
}

/** 已汇报的完成项挪进 history，queue 只留活任务（pending/running/待汇报）。 */
export function archiveNotified(state) {
  const keep = [];
  for (const task of state.queue || []) {
    const finished = ['done', 'failed', 'need-decision', 'cancelled'].includes(task.status);
    if (finished && task.notifiedAt) state.history.push(task);
    else keep.push(task);
  }
  state.queue = keep;
  return true;
}

export function ageOutHistory(state, now = Date.now(), maxHistory = 50) {
  const limit = clampInt(maxHistory, 50, 1, 500);
  if (state.history.length > limit) state.history = state.history.slice(-limit);
  return true;
}

function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} 秒`;
  if (s < 3600) return `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
  return `${Math.floor(s / 3600)} 小时 ${Math.floor((s % 3600) / 60)} 分`;
}

function statusText(task) {
  switch (task.status) {
    case 'pending': return '排队中';
    case 'running': return '运行中';
    case 'done': return '已完成';
    case 'failed': return '失败';
    case 'need-decision': return '需要主人拍板';
    case 'cancelled': return '已取消';
    default: return task.status;
  }
}

/**
 * 给 DSH 的汇报块（注入唤醒 prompt / purpose 素材）。
 * 顺序：紧急（failed/need-decision）在前，其次待汇报（done/cancelled），再运行中、排队中。
 * 只放标题/状态/一句话结论/日志路径，**不塞日志正文**。
 */
export function reportBlock(state, { maxChars = 1600, urgentOnly = false } = {}) {
  if (!state) return '';
  const urgent = urgentReports(state);
  const reports = pendingReports(state);
  const lines = [];
  const push = (line) => lines.push(line);

  for (const task of urgent) {
    const bits = [`#${task.seq}「${task.title}」${statusText(task)}`];
    if (task.durationMs) bits.push(fmtDuration(task.durationMs));
    if (task.summary) bits.push(task.summary.slice(0, 200));
    if (task.outputFile) bits.push(`日志：state/${task.outputFile}`);
    push(`· ${bits.join('，')}`);
  }
  if (!urgentOnly) {
    for (const task of reports) {
      if (URGENT_TASK_STATUSES.includes(task.status)) continue;
      const bits = [`#${task.seq}「${task.title}」${statusText(task)}`];
      if (task.durationMs) bits.push(fmtDuration(task.durationMs));
      if (task.summary) bits.push(task.summary.slice(0, 200));
      if (task.outputFile) bits.push(`日志：state/${task.outputFile}`);
      push(`· ${bits.join('，')}`);
    }
    for (const task of runningTasks(state)) {
      const since = task.startedAt ? fmtDuration(Date.now() - task.startedAt) : '';
      push(`· #${task.seq}「${task.title}」运行中${since ? `（已 ${since}）` : ''}`);
    }
    const pending = pendingTasks(state);
    if (pending.length) {
      push(`· 排队中（${pending.length} 个）：${pending.map((t) => `#${t.seq}「${t.title}」`).join('、')}`);
    }
  }
  if (!lines.length) return '';
  const header = urgent.length
    ? '【任务】有失败或需要拍板的任务，**先向主人汇报任务情况**，再回应其他内容：'
    : '【任务】先向主人汇报任务结果，再回应其他内容：';
  const body = lines.join('\n');
  const out = `${header}\n${body}`;
  return out.length > maxChars ? out.slice(0, maxChars) : out;
}

/** 状态概览（供 /api/socialV2/tasks 返回）。 */
export function summarize(state) {
  return {
    version: state.version,
    seq: state.seq,
    running: runningTasks(state).map((t) => ({ id: t.id, seq: t.seq, title: t.title, status: t.status, startedAt: t.startedAt })),
    pending: pendingTasks(state).map((t) => ({ id: t.id, seq: t.seq, title: t.title, status: t.status, createdAt: t.createdAt })),
    reports: pendingReports(state).map((t) => ({
      id: t.id, seq: t.seq, title: t.title, status: t.status, summary: t.summary, outputFile: t.outputFile, durationMs: t.durationMs,
    })),
    recentHistory: (state.history || []).slice(-5).map((t) => ({ id: t.id, seq: t.seq, title: t.title, status: t.status, summary: t.summary.slice(0, 120) })),
  };
}
