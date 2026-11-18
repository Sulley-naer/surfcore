// phone-wake（手机唤醒通道）离线回归：纯逻辑层，只测队列/投递语义/超时/心跳，不碰网络。
import assert from 'node:assert/strict';
import {
  DEFAULT_PHONE_WAKE_CONFIG,
  makeTaskId,
  normalizePhoneWakeConfig,
  normalizePhoneWakeState,
  addPhoneTask,
  nextPendingTask,
  markDelivered,
  completePhoneTask,
  sweepTimeouts,
  touchHeartbeat,
  trimPhoneWakeState,
  taskById,
  pendingTasks,
  deliveredTasks,
  summarizePhoneWake,
} from '../src/phone-wake.mjs';

const NOW = 1730000000000;
const cfg = normalizePhoneWakeConfig({});
const mkState = () => normalizePhoneWakeState(null, NOW);
const add = (state, title, prompt, extra = {}) =>
  addPhoneTask(state, { title, prompt, now: NOW, config: cfg, ...extra });

// ── 1. 配置归一化 ───────────────────────────────────────────────────────────
{
  assert.equal(cfg.enabled, true, '默认开启');
  assert.equal(cfg.port, 8787, '默认端口 8787');
  assert.equal(cfg.host, '0.0.0.0', '默认监听 0.0.0.0');
  assert.equal(cfg.maxQueue, 20, '默认排队上限 20');
  assert.equal(cfg.taskTimeoutMs, 10 * 60 * 1000, '默认任务超时 10 分钟');
  assert.equal(cfg.maxPullWaitMs, 25000, '长轮询上限 25s');
  assert.equal(normalizePhoneWakeConfig({ enabled: false }).enabled, false, '可显式关闭');
  const clamped = normalizePhoneWakeConfig({ port: 1, maxQueue: 9999, taskTimeoutMs: 1 });
  assert.equal(clamped.port, 1024, '端口下限 1024');
  assert.equal(clamped.maxQueue, 200, 'maxQueue 上限 200');
  assert.equal(clamped.taskTimeoutMs, 30 * 1000, '超时下限 30s');
}

// ── 2. 任务 id 格式 ─────────────────────────────────────────────────────────
{
  const id = makeTaskId(NOW, () => 0.5);
  assert.match(id, /^\d{8}-\d{6}-[0-9a-f]{6}$/, `id 形如 20241119-123456-abcdef，实际 ${id}`);
}

// ── 3. 入队：字段、序号、非法输入 ───────────────────────────────────────────
{
  const state = mkState();
  const r1 = add(state, '算个乘法', '计算 402 乘以 7 的结果');
  assert.equal(r1.ok, true);
  assert.equal(r1.task.status, 'pending');
  assert.equal(r1.task.seq, 1);
  assert.equal(r1.task.timeoutMs, cfg.taskTimeoutMs, '未指定时用默认超时');
  assert.equal(add(state, '', 'x').reason, 'invalid-title', '空标题拒绝');
  assert.equal(add(state, 'x', '').reason, 'invalid-prompt', '空指令拒绝');
  assert.equal(addPhoneTask(state, { title: 'x', prompt: 'y', now: NOW, config: { ...cfg, enabled: false } }).reason, 'disabled', '关闭时拒绝');
}

// ── 4. 队列上限 ─────────────────────────────────────────────────────────────
{
  const state = mkState();
  const small = { ...cfg, maxQueue: 2 };
  assert.equal(addPhoneTask(state, { title: 'a', prompt: 'p', now: NOW, config: small }).ok, true);
  assert.equal(addPhoneTask(state, { title: 'b', prompt: 'p', now: NOW, config: small }).ok, true);
  assert.equal(addPhoneTask(state, { title: 'c', prompt: 'p', now: NOW, config: small }).reason, 'queue-full', '第 3 条被拒');
  // 取走一条（delivered 不算 pending）后可再入队
  markDelivered(state, state.queue[0].id, NOW);
  assert.equal(addPhoneTask(state, { title: 'c', prompt: 'p', now: NOW, config: small }).ok, true, 'delivered 腾出名额');
}

// ── 5. FIFO + at-most-once ──────────────────────────────────────────────────
{
  const state = mkState();
  const a = add(state, '一', 'p1').task;
  const b = add(state, '二', 'p2').task;
  assert.equal(nextPendingTask(state).id, a.id, '最旧优先');
  assert.equal(markDelivered(state, a.id, NOW).ok, true);
  assert.equal(markDelivered(state, a.id, NOW).ok, false, '同一任务不能重复投递');
  assert.equal(nextPendingTask(state).id, b.id, '下一条顶上');
  assert.equal(deliveredTasks(state).length, 1);
  assert.equal(pendingTasks(state).length, 1);
}

// ── 6. 回传结果 ─────────────────────────────────────────────────────────────
{
  const state = mkState();
  const t = add(state, 'ping', '回一句 ping 成功').task;
  markDelivered(state, t.id, NOW);
  const r = completePhoneTask(state, { id: t.id, ok: true, result: 'ping 成功', durationMs: 1234, device: 'dshgo', now: NOW + 5000 });
  assert.equal(r.ok, true);
  assert.equal(r.task.status, 'done');
  assert.equal(r.task.result, 'ping 成功');
  assert.equal(state.results.length, 1);

  const f = add(state, '失败案例', 'x').task;
  markDelivered(state, f.id, NOW);
  completePhoneTask(state, { id: f.id, ok: false, error: '超时', now: NOW + 1000 });
  assert.equal(taskById(state, f.id).status, 'failed', '失败也记录');
  assert.equal(completePhoneTask(state, { id: 'nope', ok: true }).reason, 'not-found', '未知 id 返回 not-found');
}

// ── 7. 超时扫描：已投递未消费 ───────────────────────────────────────────────
{
  const state = mkState();
  const t = add(state, '慢任务', 'p', { timeoutMs: 60_000 }).task;
  markDelivered(state, t.id, NOW);
  assert.deepEqual(sweepTimeouts(state, NOW + 30_000).map((x) => x.id), [], '未超时不标');
  const expired = sweepTimeouts(state, NOW + 61_000);
  assert.equal(expired.length, 1);
  assert.equal(taskById(state, t.id).status, 'expired');
  assert.match(taskById(state, t.id).error, /已投递未消费/);
  assert.deepEqual(sweepTimeouts(state, NOW + 90_000), [], '只标一次');
}

// ── 8. 重启恢复：delivered → expired ────────────────────────────────────────
{
  const raw = {
    version: 1,
    seq: 3,
    queue: [
      { id: 'a', seq: 1, title: 't1', prompt: 'p', status: 'delivered', createdAt: NOW, deliveredAt: NOW, timeoutMs: 600000 },
      { id: 'b', seq: 2, title: 't2', prompt: 'p', status: 'done', createdAt: NOW, finishedAt: NOW, result: 'ok' },
    ],
  };
  const state = normalizePhoneWakeState(raw, NOW + 1000);
  assert.equal(taskById(state, 'a').status, 'expired', '重启时已投递的标 expired');
  assert.match(taskById(state, 'a').error, /桥接重启/);
  assert.equal(taskById(state, 'b').status, 'done', '已完成的不动');
  assert.equal(state.seq, 3, '序号保留');
}

// ── 9. 心跳 ─────────────────────────────────────────────────────────────────
{
  const state = mkState();
  touchHeartbeat(state, { device: 'dshgo', note: 'alive', now: NOW });
  assert.equal(state.heartbeat.at, NOW);
  assert.equal(state.heartbeat.device, 'dshgo');
  const sum = summarizePhoneWake(state, NOW + 5000);
  assert.equal(sum.heartbeat.ageMs, 5000);
}

// ── 10. 裁剪与概览 ──────────────────────────────────────────────────────────
{
  const state = mkState();
  for (let i = 0; i < 8; i += 1) {
    const t = add(state, `t${i}`, 'p').task;
    markDelivered(state, t.id, NOW);
    completePhoneTask(state, { id: t.id, ok: true, result: 'ok', now: NOW + i });
  }
  const trimmed = trimPhoneWakeState(state, { ...cfg, maxResults: 3 });
  const finished = trimmed.queue.filter((t) => ['done', 'failed', 'expired'].includes(t.status));
  assert.equal(finished.length, 3, '只留最近 3 条完成记录');
  const sum = summarizePhoneWake(trimmed, NOW + 10);
  assert.equal(sum.pendingCount, 0);
  assert.equal(sum.seq, 8, '序号不因裁剪回退');
  const e = mkState();
  const p1 = add(e, '待执行', 'p').task;
  assert.equal(summarizePhoneWake(e).pending[0].id, p1.id);
}

console.log('✅ phone-wake（手机唤醒通道）通过');
