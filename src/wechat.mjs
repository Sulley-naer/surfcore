// wechat（微信通道）纯逻辑层：出站队列 + 回执 + 状态快照，全部无 I/O，方便单测。
// 适配器（runtimes/wechat/adapter.py）每 pollSeconds 来问一次 outbox，取走一条 job 发送并回执。

export const WECHAT_STATE_VERSION = 1;

export const DEFAULT_WECHAT_CONFIG = {
  enabled: true,
  chatId: '',
  token: '',
  autoReply: true,
  maxQueue: 50,
  maxResults: 200,
};

const clone = (v) => JSON.parse(JSON.stringify(v));

export function normalizeWechatConfig(input = {}) {
  const src = input && typeof input === 'object' ? input : {};
  const clampInt = (v, fallback, min, max) => {
    if (v === null || v === undefined || v === '') return fallback;
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, Math.trunc(n)));
  };
  return {
    enabled: src.enabled !== false,
    chatId: typeof src.chatId === 'string' ? src.chatId.trim() : '',
    token: typeof src.token === 'string' ? src.token.trim() : '',
    autoReply: src.autoReply !== false,
    maxQueue: clampInt(src.maxQueue, DEFAULT_WECHAT_CONFIG.maxQueue, 1, 500),
    maxResults: clampInt(src.maxResults, DEFAULT_WECHAT_CONFIG.maxResults, 10, 2000),
  };
}

export function normalizeWechatState(raw) {
  const base = { version: WECHAT_STATE_VERSION, jobs: [], results: [], status: null, inbound: 0 };
  if (!raw || typeof raw !== 'object') return base;
  const jobs = Array.isArray(raw.jobs)
    ? raw.jobs
        .filter((j) => j && typeof j.id === 'string' && Array.isArray(j.messages))
        .map((j) => ({
          id: j.id,
          chatId: String(j.chatId ?? ''),
          messages: j.messages.map((m) => ({ text: String(m?.text ?? '') })),
          status: ['pending', 'delivered', 'sent', 'failed'].includes(j.status) ? j.status : 'pending',
          createdAt: Number(j.createdAt) || 0,
          deliveredAt: Number(j.deliveredAt) || 0,
          finishedAt: Number(j.finishedAt) || 0,
          confirmed: Number(j.confirmed) || 0,
          total: Number(j.total) || 0,
          error: j.error ? String(j.error) : null,
        }))
    : [];
  const results = Array.isArray(raw.results) ? raw.results.slice(-400) : [];
  return {
    version: WECHAT_STATE_VERSION,
    jobs,
    results,
    status: raw.status && typeof raw.status === 'object' ? raw.status : null,
    inbound: Number(raw.inbound) || 0,
  };
}

export function makeWechatJobId(now = Date.now(), rand = Math.random) {
  const d = new Date(now);
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `wx-${stamp}-${Math.floor(rand() * 1e6).toString(16).padStart(5, '0')}`;
}

export function pendingJobs(state) {
  return (state?.jobs ?? []).filter((j) => j.status === 'pending');
}

export function enqueueJob(state, { chatId, text, now = Date.now(), config } = {}) {
  const cfg = config ?? DEFAULT_WECHAT_CONFIG;
  const body = String(text ?? '').trim();
  if (!body) return { ok: false, reason: 'empty-text' };
  const target = String(chatId ?? cfg.chatId ?? '').trim();
  if (!target) return { ok: false, reason: 'no-chat' };
  if (pendingJobs(state).length >= cfg.maxQueue) return { ok: false, reason: 'queue-full' };
  const job = {
    id: makeWechatJobId(now),
    chatId: target,
    messages: chunkText(body, 900).map((t) => ({ text: t })),
    status: 'pending',
    createdAt: now,
    deliveredAt: 0,
    finishedAt: 0,
    confirmed: 0,
    total: chunkText(body, 900).length,
    error: null,
  };
  state.jobs.push(job);
  return { ok: true, job };
}

export function chunkText(text, size = 900) {
  const s = String(text ?? '');
  if (s.length <= size) return [s];
  const out = [];
  let rest = s;
  while (rest.length > size) {
    let cut = rest.lastIndexOf('\n', size);
    if (cut < size * 0.5) cut = size;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

export function takeJob(state, { accountId, chatIds = [], now = Date.now() } = {}) {
  const allowed = new Set(chatIds.map((x) => String(x)));
  const job = state.jobs.find((j) => j.status === 'pending' && (!allowed.size || allowed.has(j.chatId)));
  if (!job) return null;
  job.status = 'delivered';
  job.deliveredAt = now;
  return job;
}

export function applyReceipt(state, receipt, now = Date.now()) {
  const id = String(receipt?.id ?? '');
  const job = state.jobs.find((j) => j.id === id);
  if (!job) return { ok: false, reason: 'not-found' };
  const confirmed = Number(receipt?.confirmed);
  const total = Number(receipt?.total) || job.total;
  if (Number.isFinite(confirmed)) job.confirmed = confirmed;
  if (Number.isFinite(total) && total > 0) job.total = total;
  const status = String(receipt?.status ?? '');
  if (status) job.status = status === 'sent' ? 'sent' : status === 'failed' ? 'failed' : job.status;
  if (receipt?.error) job.error = String(receipt.error).slice(0, 300);
  if (job.status === 'sent' || job.status === 'failed') job.finishedAt = now;
  state.results.push({
    id: job.id,
    chatId: job.chatId,
    status: job.status,
    confirmed: job.confirmed,
    total: job.total,
    at: now,
    error: job.error,
  });
  if (state.results.length > 400) state.results = state.results.slice(-400);
  return { ok: true, job };
}

export function noteStatus(state, status) {
  state.status = { ...(status && typeof status === 'object' ? status : {}), at: Date.now() };
}

export function trimWechatState(state, config = DEFAULT_WECHAT_CONFIG) {
  const keep = new Set(['pending', 'delivered']);
  const done = state.jobs.filter((j) => !keep.has(j.status));
  if (done.length > config.maxResults) {
    const drop = new Set(done.slice(0, done.length - config.maxResults).map((j) => j.id));
    state.jobs = state.jobs.filter((j) => !drop.has(j.id));
  }
  return state;
}

export function summarizeWechat(state) {
  const jobs = state?.jobs ?? [];
  return {
    pending: jobs.filter((j) => j.status === 'pending').length,
    delivered: jobs.filter((j) => j.status === 'delivered').length,
    sent: jobs.filter((j) => j.status === 'sent').length,
    failed: jobs.filter((j) => j.status === 'failed').length,
    inbound: Number(state?.inbound) || 0,
    status: clone(state?.status ?? null),
    recent: (state?.results ?? []).slice(-5).reverse(),
  };
}
