/**
 * owner 日程 / 定时器（纯逻辑、零 I/O）。
 *
 * 用途：让她（星苑织）把一件事排到某个时间点，到点桥接会唤醒她、把「该做这件事了」
 * 注入她的指令里，由她自主用工具去执行（发链接 / 发消息等）。
 *
 * 语义：
 * - 一次性（repeat: 'none'）：到点触发后 status → done（「到点提醒」这个动作即完成）。
 * - 每天（repeat: 'daily'）：到点触发后 dueAt 自动推进 +24h（保持同一时刻），status 仍 pending，
 *   直到取消。适合「每天下班把链接甩给主人」这类循环日程。
 *
 * 时间表示：dueAt 是绝对毫秒时间戳。addSchedule 的 time 参数支持两种写法：
 * - "HH:mm" / "HH:mm:ss"（24 小时制，按本机时区；已过则排到明天）
 * - 纯数字串（10~13 位，当作绝对毫秒时间戳）
 */

export const SCHEDULE_VERSION = 1;
export const DEFAULT_SCHEDULE_CONFIG = {
  enabled: true,
  maxItems: 50,
  summaryMaxChars: 500,
  fireWindowMs: 5 * 60 * 1000,
};
const REPEATS = ['none', 'daily'];

function clampInt(value, fallback, min, max) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return Math.round(n);
}

function clip(text, max) {
  const s = String(text ?? '');
  return s.length > max ? s.slice(0, max) : s;
}

export function normalizeScheduleConfig(input) {
  const src = input ?? {};
  const enabled = src.enabled !== false;
  return {
    enabled,
    maxItems: clampInt(src.maxItems, 50, 1, 500),
    summaryMaxChars: clampInt(src.summaryMaxChars, 500, 200, 4000),
    fireWindowMs: clampInt(src.fireWindowMs, 5 * 60 * 1000, 30 * 1000, 60 * 60 * 1000),
  };
}

export function normalizeScheduleState(raw, now = Date.now()) {
  const items = Array.isArray(raw?.items) ? raw.items : [];
  return {
    version: SCHEDULE_VERSION,
    seq: clampInt(raw?.seq, 0, 0, Number.MAX_SAFE_INTEGER),
    items: items
      .filter((it) => it && typeof it === 'object')
      .map((it) => ({
        id: String(it.id ?? ''),
        seq: Number(it.seq) || 0,
        title: clip(String(it.title ?? ''), 120),
        description: clip(String(it.description ?? ''), 500),
        dueAt: Number(it.dueAt) || 0,
        repeat: REPEATS.includes(String(it.repeat)) ? String(it.repeat) : 'none',
        status: ['pending', 'done', 'cancelled'].includes(String(it.status)) ? String(it.status) : 'pending',
        createdAt: Number(it.createdAt) || 0,
        lastFiredAt: Number(it.lastFiredAt) || 0,
      }))
      .filter((it) => it.id),
  };
}

/** 解析 time 参数为绝对毫秒时间戳。 */
export function parseClockTime(str, now = Date.now()) {
  const raw = String(str ?? '').trim();
  if (!raw) return { ok: false, reason: '时间不能为空' };
  // 绝对毫秒时间戳（10~13 位纯数字）
  if (/^\d{10,13}$/.test(raw)) {
    const ts = Number(raw);
    if (!Number.isFinite(ts)) return { ok: false, reason: '时间戳无效' };
    return { ok: true, ts };
  }
  // HH:mm 或 HH:mm:ss
  const m = raw.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return { ok: false, reason: '时间格式应为 HH:mm 或 HH:mm:ss（或绝对毫秒时间戳）' };
  const hh = Number(m[1]); const mm = Number(m[2]); const ss = Number(m[3] ?? 0);
  if (hh > 23 || mm > 59 || ss > 59) return { ok: false, reason: '时间越界（时≤23 / 分≤59 / 秒≤59）' };
  const d = new Date(now);
  d.setHours(hh, mm, ss, 0);
  let ts = d.getTime();
  if (ts <= now) ts += 24 * 3600_000; // 今天这个点已过 → 排到明天
  return { ok: true, ts };
}

export function addSchedule(state, { title, description, time, repeat = 'none', now = Date.now(), config }) {
  const cfg = config ?? DEFAULT_SCHEDULE_CONFIG;
  if (cfg.enabled === false) return { ok: false, reason: '日程已关闭（socialV2.schedules.enabled=false）' };
  const t = clip(String(title ?? ''), 120);
  const desc = clip(String(description ?? ''), 500);
  if (!t) return { ok: false, reason: '标题不能为空' };
  const parsed = parseClockTime(time, now);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  const rep = REPEATS.includes(String(repeat)) ? String(repeat) : 'none';
  if ((state.items || []).length >= cfg.maxItems) return { ok: false, reason: `日程已满（最多 ${cfg.maxItems} 条），先取消一些` };
  state.seq = (state.seq || 0) + 1;
  const item = {
    id: `s${state.seq}`,
    seq: state.seq,
    title: t,
    description: desc,
    dueAt: parsed.ts,
    repeat: rep,
    status: 'pending',
    createdAt: now,
    lastFiredAt: 0,
  };
  state.items.push(item);
  return { ok: true, item };
}

export function dueSchedules(state, now = Date.now()) {
  return (state.items || []).filter((it) => it.status === 'pending' && Number(it.dueAt) <= now);
}

export function fireSchedule(state, id, now = Date.now()) {
  const item = (state.items || []).find((it) => it.id === id);
  if (!item) return { ok: false, reason: 'not-found' };
  if (item.status !== 'pending') return { ok: false, reason: `not-pending:${item.status}` };
  item.lastFiredAt = now;
  if (item.repeat === 'daily') {
    let next = Number(item.dueAt);
    do { next += 24 * 3600_000; } while (next <= now);
    item.dueAt = next; // 保持 pending，明天同一时刻再来
  } else {
    item.status = 'done';
  }
  return { ok: true, item };
}

export function cancelSchedule(state, id, now = Date.now()) {
  const item = (state.items || []).find((it) => it.id === id);
  if (!item) return { ok: false, reason: 'not-found' };
  if (item.status === 'cancelled') return { ok: false, reason: 'already-cancelled' };
  item.status = 'cancelled';
  return { ok: true, item };
}

/** 唤醒 prompt 注入块：最近刚触发的 + 待触发的日程。无内容返回空串。 */
export function scheduleBlock(state, { maxChars = 500, recentFires = [], now = Date.now(), fireWindowMs = 5 * 60 * 1000 } = {}) {
  if (!state) return '';
  const pending = (state.items || []).filter((it) => it.status === 'pending').sort((a, b) => Number(a.dueAt) - Number(b.dueAt));
  const recent = (recentFires || []).filter((f) => f && Number(f.at) && now - Number(f.at) < fireWindowMs);
  if (!pending.length && !recent.length) return '';
  const lines = [];
  if (recent.length) {
    lines.push('到点了，先做这件事：');
    for (const f of recent) lines.push(`· #${f.seq}「${f.title}」${f.description ? `——${f.description}` : ''}`);
    lines.push('做完后把结果（比如链接）发给主人。');
  }
  if (pending.length) {
    lines.push('你安排的日程（到点会自动叫醒你）：');
    for (const it of pending.slice(0, 6)) {
      const when = new Date(Number(it.dueAt)).toLocaleString();
      lines.push(`· #${it.seq}「${it.title}」${it.repeat === 'daily' ? '每天 ' : ''}${when}${it.description ? `——${it.description}` : ''}`);
    }
    if (pending.length > 6) lines.push(`· …还有 ${pending.length - 6} 条`);
  }
  const out = `【日程】\n${lines.join('\n')}`;
  return out.length > maxChars ? out.slice(0, maxChars) : out;
}

export function summarize(state) {
  const items = state.items || [];
  const pending = items.filter((it) => it.status === 'pending').sort((a, b) => Number(a.dueAt) - Number(b.dueAt));
  return {
    version: state.version,
    seq: state.seq,
    pending: pending.map((it) => ({
      id: it.id, seq: it.seq, title: it.title, description: it.description,
      dueAt: it.dueAt, repeat: it.repeat, dueText: new Date(Number(it.dueAt)).toLocaleString(),
    })),
    recent: items.filter((it) => it.status !== 'pending').slice(-5).map((it) => ({ id: it.id, seq: it.seq, title: it.title, status: it.status })),
    counts: { pending: pending.length, done: items.filter((it) => it.status === 'done').length, cancelled: items.filter((it) => it.status === 'cancelled').length, total: items.length },
  };
}
