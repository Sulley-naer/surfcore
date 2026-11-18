/**
 * 手机唤醒通道（反向长轮询）：纯逻辑，只做队列/状态机，不碰网络、文件、时间源。
 *
 * 语义：
 *   · 电脑端排队「任务」；手机主动 GET /v1/pull 长轮询取走；
 *   · at-most-once：任务被 pull 返回后即标 delivered，不会再下发第二次；
 *   · 手机 POST /v1/result 回传结果（成功/失败都要回）；
 *   · 超过 timeoutMs 未回结果 → 标 expired（「已投递未消费」），由桥接告警。
 *
 * 契约见 docs/guides/PHONE_WAKE_CHANNEL.md。
 */
export const PHONE_WAKE_VERSION = 1;

export const DEFAULT_PHONE_WAKE_CONFIG = Object.freeze({
  enabled: true,
  host: '0.0.0.0',
  port: 8787,
  token: '',
  maxQueue: 20,
  taskTimeoutMs: 10 * 60 * 1000,
  maxResults: 50,
  maxPullWaitMs: 25000,
});

const TASK_STATUSES = ['pending', 'delivered', 'done', 'failed', 'expired', 'cancelled'];

function clampInt(value, fallback, min, max) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function clip(text, max) {
  const s = String(text ?? '');
  return s.length > max ? s.slice(0, max) : s;
}

/** 归一化配置：坏值一律回退默认，不让脏配置把服务搞挂。 */
export function normalizePhoneWakeConfig(input) {
  const src = input && typeof input === 'object' ? input : {};
  return {
    enabled: src.enabled !== false,
    host: typeof src.host === 'string' && src.host.trim() ? src.host.trim() : DEFAULT_PHONE_WAKE_CONFIG.host,
    port: clampInt(src.port, DEFAULT_PHONE_WAKE_CONFIG.port, 1024, 65535),
    token: typeof src.token === 'string' ? src.token.trim() : '',
    maxQueue: clampInt(src.maxQueue, DEFAULT_PHONE_WAKE_CONFIG.maxQueue, 1, 200),
    taskTimeoutMs: clampInt(src.taskTimeoutMs, DEFAULT_PHONE_WAKE_CONFIG.taskTimeoutMs, 30_000, 6 * 60 * 60 * 1000),
    maxResults: clampInt(src.maxResults, DEFAULT_PHONE_WAKE_CONFIG.maxResults, 5, 500),
    maxPullWaitMs: clampInt(src.maxPullWaitMs, DEFAULT_PHONE_WAKE_CONFIG.maxPullWaitMs, 0, 25_000),
  };
}

/** 生成任务 id：本地时间戳 + 6 位随机 hex（可读、可排序）。 */
export function makeTaskId(now = Date.now(), rand = Math.random) {
  const d = new Date(now);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const tail = Math.floor(rand() * 0xffffff).toString(16).padStart(6, '0');
  return `${stamp}-${tail}`;
}

/** 归一化持久化状态：重启后把「已投递但没回结果」的标成 expired（不算丢，留痕迹）。 */
export function normalizePhoneWakeState(raw, now = Date.now()) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const queue = Array.isArray(src.queue) ? src.queue.filter((t) => t && t.id).map((t) => ({
    id: String(t.id),
    seq: Number(t.seq) || 0,
    title: clip(t.title, 120),
    prompt: String(t.prompt ?? ''),
    status: TASK_STATUSES.includes(t.status) ? t.status : 'pending',
    createdAt: Number(t.createdAt) || now,
    deliveredAt: Number(t.deliveredAt) || 0,
    finishedAt: Number(t.finishedAt) || 0,
    timeoutMs: Number(t.timeoutMs) || DEFAULT_PHONE_WAKE_CONFIG.taskTimeoutMs,
    result: typeof t.result === 'string' ? t.result : '',
    error: typeof t.error === 'string' ? t.error : '',
    durationMs: Number(t.durationMs) || 0,
    device: typeof t.device === 'string' ? t.device : '',
  })) : [];
  for (const t of queue) {
    if (t.status === 'delivered') {
      t.status = 'expired';
      t.finishedAt = t.finishedAt || now;
      t.error = t.error || '桥接重启：已投递未回结果';
    }
  }
  const results = Array.isArray(src.results) ? src.results.filter((r) => r && r.id).slice(-200) : [];
  const heartbeat = src.heartbeat && typeof src.heartbeat === 'object'
    ? { at: Number(src.heartbeat.at) || 0, device: String(src.heartbeat.device ?? ''), note: String(src.heartbeat.note ?? '') }
    : { at: 0, device: '', note: '' };
  return { version: PHONE_WAKE_VERSION, seq: Number(src.seq) || 0, queue, results, heartbeat };
}

export function pendingTasks(state) {
  return state?.queue ? state.queue.filter((t) => t.status === 'pending') : [];
}

export function deliveredTasks(state) {
  return state?.queue ? state.queue.filter((t) => t.status === 'delivered') : [];
}

export function taskById(state, id) {
  return state?.queue ? state.queue.find((t) => t.id === id) ?? null : null;
}

/** 入队一条任务。队列满/参数非法返回原因。 */
export function addPhoneTask(state, { title, prompt, timeoutMs, now = Date.now(), config } = {}) {
  const cfg = config ?? DEFAULT_PHONE_WAKE_CONFIG;
  if (cfg.enabled === false) return { ok: false, reason: 'disabled' };
  const t = clip(String(title ?? '').trim(), 120);
  const p = String(prompt ?? '').trim();
  if (!t) return { ok: false, reason: 'invalid-title' };
  if (!p) return { ok: false, reason: 'invalid-prompt' };
  if (pendingTasks(state).length >= cfg.maxQueue) return { ok: false, reason: 'queue-full' };
  state.seq = (Number(state.seq) || 0) + 1;
  const task = {
    id: makeTaskId(now),
    seq: state.seq,
    title: t,
    prompt: p,
    status: 'pending',
    createdAt: now,
    deliveredAt: 0,
    finishedAt: 0,
    timeoutMs: clampInt(timeoutMs, cfg.taskTimeoutMs, 30_000, 6 * 60 * 60 * 1000),
    result: '',
    error: '',
    durationMs: 0,
    device: '',
  };
  state.queue.push(task);
  return { ok: true, task };
}

/** 取最旧的一条 pending（不改变状态）。 */
export function nextPendingTask(state) {
  return pendingTasks(state)[0] ?? null;
}

/** 标记已投递：pull 返回给手机的那一刻调用。at-most-once 就靠这里。 */
export function markDelivered(state, id, now = Date.now()) {
  const task = taskById(state, id);
  if (!task || task.status !== 'pending') return { ok: false, reason: 'not-pending' };
  task.status = 'delivered';
  task.deliveredAt = now;
  return { ok: true, task };
}

/** 回传结果。id 不存在/状态不对都要如实返回，方便服务端回 404。 */
export function completePhoneTask(state, { id, ok, result, error, durationMs, device, now = Date.now() } = {}) {
  const task = taskById(state, id);
  if (!task) return { ok: false, reason: 'not-found' };
  if (task.status !== 'delivered' && task.status !== 'pending') return { ok: false, reason: `not-deliverable:${task.status}` };
  task.status = ok ? 'done' : 'failed';
  task.finishedAt = now;
  task.result = clip(result, 20000);
  task.error = clip(error, 2000);
  task.durationMs = clampInt(durationMs, task.deliveredAt ? now - task.deliveredAt : 0, 0, 24 * 60 * 60 * 1000);
  task.device = clip(device, 40);
  state.results.push({ id: task.id, seq: task.seq, ok: Boolean(ok), finishedAt: now });
  if (state.results.length > 200) state.results = state.results.slice(-200);
  return { ok: true, task };
}

/** 超时扫描：delivered 且超过 timeoutMs 未回 → expired（「已投递未消费」）。 */
export function sweepTimeouts(state, now = Date.now()) {
  const expired = [];
  for (const task of deliveredTasks(state)) {
    if (task.deliveredAt && now - task.deliveredAt > task.timeoutMs) {
      task.status = 'expired';
      task.finishedAt = now;
      task.error = '已投递未消费：手机侧超时未回结果';
      expired.push(task);
    }
  }
  return expired;
}

/** 心跳记录（手机在线证明）。 */
export function touchHeartbeat(state, { device = '', note = '', now = Date.now() } = {}) {
  state.heartbeat = { at: now, device: clip(device, 40), note: clip(note, 200) };
  return state.heartbeat;
}

/** 队列裁剪：完成的只留最近 maxResults 条。 */
export function trimPhoneWakeState(state, config) {
  const cfg = config ?? DEFAULT_PHONE_WAKE_CONFIG;
  const done = state.queue.filter((t) => ['done', 'failed', 'expired', 'cancelled'].includes(t.status));
  if (done.length <= cfg.maxResults) return state;
  const keep = new Set(done.slice(-cfg.maxResults).map((t) => t.id));
  state.queue = state.queue.filter((t) => !['done', 'failed', 'expired', 'cancelled'].includes(t.status) || keep.has(t.id));
  return state;
}

/** 概览（给控制台/状态接口）。 */
export function summarizePhoneWake(state, now = Date.now()) {
  const pending = pendingTasks(state);
  const delivered = deliveredTasks(state);
  const heartbeatAgeMs = state.heartbeat?.at ? now - state.heartbeat.at : -1;
  return {
    version: state.version,
    seq: state.seq,
    pendingCount: pending.length,
    deliveredCount: delivered.length,
    pending: pending.map((t) => ({ id: t.id, seq: t.seq, title: t.title, createdAt: t.createdAt })),
    delivered: delivered.map((t) => ({ id: t.id, seq: t.seq, title: t.title, deliveredAt: t.deliveredAt })),
    heartbeat: { ...state.heartbeat, ageMs: heartbeatAgeMs },
    recent: state.queue.slice(-8).map((t) => ({
      id: t.id, seq: t.seq, title: t.title, status: t.status, finishedAt: t.finishedAt,
      ok: t.status === 'done', error: t.error ? clip(t.error, 120) : '',
    })),
  };
}
