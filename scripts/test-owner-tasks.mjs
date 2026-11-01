// owner-tasks（后台任务台账）离线回归：纯逻辑层，只测状态机/队列/汇报块，不碰进程与 QQ。
import assert from 'node:assert/strict';
import {
  DEFAULT_TASK_CONFIG,
  normalizeTaskConfig,
  normalizeTaskState,
  createTask,
  popNextTask,
  startTask,
  finishTask,
  cancelTask,
  taskById,
  runningTasks,
  pendingTasks,
  pendingReports,
  urgentReports,
  markNotified,
  archiveNotified,
  reportBlock,
  summarize,
} from '../src/owner-tasks.mjs';

const NOW = 1730000000000;
const mkState = () => normalizeTaskState(null, NOW);
const cfg = normalizeTaskConfig({});
const add = (state, title, command, extra = {}) =>
  createTask(state, { title, command, now: NOW, config: cfg, ...extra });

// ── 1. 配置归一化 ───────────────────────────────────────────────────────────
{
  assert.equal(cfg.enabled, true, '默认开启');
  assert.equal(cfg.maxActive, 2, '默认并发 2');
  assert.equal(cfg.maxQueue, 10, '默认排队上限 10');
  assert.equal(cfg.defaultTimeoutMs, 30 * 60 * 1000, '默认单任务 30 分钟');
  assert.equal(normalizeTaskConfig({ enabled: false }).enabled, false, '可显式关闭');
  const clamped = normalizeTaskConfig({ maxActive: 99, maxQueue: 9999, defaultTimeoutMs: 1 });
  assert.equal(clamped.maxActive, 8, 'maxActive 上限 8');
  assert.equal(clamped.maxQueue, 100, 'maxQueue 上限 100');
  assert.equal(clamped.defaultTimeoutMs, 60 * 1000, 'timeoutMs 下限 60s');
}

// ── 2. 创建任务：字段、序列号、非法输入 ─────────────────────────────────────
{
  const state = mkState();
  const r1 = add(state, '下载模型', 'curl -o model.bin https://x/model.bin');
  assert.equal(r1.ok, true, '正常创建');
  assert.equal(r1.task.id, 't1', '第一个任务 id=t1');
  assert.equal(r1.task.status, 'pending', '初始 pending');
  assert.equal(r1.task.timeoutMs, cfg.defaultTimeoutMs, '默认超时');
  const r2 = add(state, '跑测试', 'node scripts/test-audit.mjs', { timeoutMs: 999999999 });
  assert.equal(r2.task.timeoutMs, cfg.maxTimeoutMs, '超时上限夹取');
  assert.equal(add(state, '', 'ls').ok, false, '空标题拒');
  assert.equal(add(state, 'x', '   ').ok, false, '空命令拒');
  assert.equal(add(state, '', 'ls').reason, 'invalid-title', '空标题 reason');
  assert.equal(add(state, 'x', '   ').reason, 'invalid-command', '空命令 reason');
  assert.equal(createTask(state, { title: 'x', command: 'ls', config: { ...cfg, enabled: false } }).ok, false, 'disabled 拒');
}

// ── 3. 队列语义：并发 2、排队上限 3 直接拒 ─────────────────────────────────
{
  const state = mkState();
  const small = { ...cfg, maxQueue: 3 };
  // 先创建 2 个并启动 → running=2；再挂 3 个排队；第 6 个直接拒。
  const ids = [];
  for (let i = 0; i < 2; i++) {
    const r = createTask(state, { title: `跑${i}`, command: `echo ${i}`, now: NOW, config: small });
    assert.equal(r.ok, true, `running 候选 ${i + 1} 创建成功`);
    ids.push(r.task.id);
    startTask(state, r.task.id);
  }
  assert.equal(runningTasks(state).length, 2, 'running=2');
  for (let i = 0; i < 3; i++) {
    const r = createTask(state, { title: `排${i}`, command: `echo ${i}`, now: NOW, config: small });
    assert.equal(r.ok, true, `排队第 ${i + 1} 个创建成功`);
  }
  assert.equal(pendingTasks(state).length, 3, 'pending=3（满）');
  const over = createTask(state, { title: '第 6 个', command: 'echo 6', now: NOW, config: small });
  assert.equal(over.ok, false, '超过排队上限拒绝');
  assert.equal(over.reason, 'queue-full', 'reason=queue-full');
}

// ── 4. popNextTask FIFO + startTask 幂等约束 ────────────────────────────────
{
  const state = mkState();
  add(state, 'A', 'echo a');
  add(state, 'B', 'echo b');
  assert.equal(popNextTask(state).title, 'A', 'FIFO 取最旧 pending');
  startTask(state, 't1');
  assert.equal(popNextTask(state).title, 'B', '下一个是 B');
  assert.equal(startTask(state, 't1').ok, false, 'running 不能重复 start');
  assert.equal(startTask(state, 'nope').ok, false, '不存在任务 start 拒');
}

// ── 5. finishTask 状态机：done / failed / need-decision ─────────────────────
{
  const state = mkState();
  add(state, '成功任务', 'echo ok');
  add(state, '失败任务', 'exit 1');
  add(state, '要拍板', 'echo choose');
  startTask(state, 't1', NOW); startTask(state, 't2', NOW); startTask(state, 't3', NOW);
  // 但并发语义由 bridge 控制，这里只测纯状态迁移。
  const f1 = finishTask(state, 't1', { ok: true, code: 0, summary: '下载完成', outputFile: 'task-outputs/t1.log', now: NOW + 5000 });
  assert.equal(f1.ok, true, '完成');
  assert.equal(f1.task.status, 'done', 'ok→done');
  assert.equal(f1.task.durationMs, 5000, '时长 5s');
  const f2 = finishTask(state, 't2', { ok: false, code: 1, summary: 'exit 1', now: NOW + 8000 });
  assert.equal(f2.task.status, 'failed', 'fail→failed');
  const f3 = finishTask(state, 't3', { ok: true, code: 0, needDecision: true, now: NOW + 9000 });
  assert.equal(f3.task.status, 'need-decision', 'needDecision 优先');
  assert.equal(finishTask(state, 't1').ok, false, 'done 不能再 finish');
  assert.equal(finishTask(state, 'nope').ok, false, '不存在任务 finish 拒');
}

// ── 6. cancelTask：只撤排队中 ───────────────────────────────────────────────
{
  const state = mkState();
  add(state, '排队中', 'echo q');
  add(state, '跑着的', 'echo r');
  startTask(state, 't2');
  assert.equal(cancelTask(state, 't1').ok, true, 'pending 可撤');
  assert.equal(taskById(state, 't1').status, 'cancelled', '撤后 cancelled');
  assert.equal(cancelTask(state, 't2').ok, false, 'running 不撤（第一版不喊停）');
  assert.equal(cancelTask(state, 't2').reason, 'not-pending:running', 'reason 明确');
  assert.equal(cancelTask(state, 'nope').ok, false, '不存在任务撤拒');
}

// ── 7. 汇报分类：紧急（failed/need-decision）vs 攒着（done/cancelled） ──────
{
  const state = mkState();
  add(state, 'd1', 'echo 1'); add(state, 'd2', 'echo 2');
  add(state, 'f1', 'exit 1'); add(state, 'n1', 'echo n');
  startTask(state, 't1'); startTask(state, 't2'); startTask(state, 't3'); startTask(state, 't4');
  finishTask(state, 't1', { ok: true, code: 0, summary: 'ok1', now: NOW });
  finishTask(state, 't2', { ok: true, code: 0, summary: 'ok2', now: NOW });
  finishTask(state, 't3', { ok: false, code: 1, summary: 'boom', now: NOW });
  finishTask(state, 't4', { ok: true, code: 0, needDecision: true, summary: '选哪个', now: NOW });
  assert.equal(pendingReports(state).length, 4, '四个都待汇报');
  assert.equal(urgentReports(state).length, 2, 'failed+need-decision=2 个紧急');
  markNotified(state, ['t1', 't3'], NOW + 1);
  assert.equal(pendingReports(state).length, 2, '汇报两个剩两个');
  assert.equal(urgentReports(state).length, 1, '剩一个紧急（t4）');
  archiveNotified(state);
  assert.equal(state.history.length, 2, '已汇报的进 history');
  assert.equal(state.queue.length, 2, 'queue 只剩待汇报');
}

// ── 8. reportBlock：紧急在前、不塞日志正文、urgentOnly ─────────────────────
{
  const state = mkState();
  add(state, '跑着的', 'echo r');
  startTask(state, 't1');
  add(state, '成功任务', 'echo ok');
  const block = reportBlock(state, { maxChars: 2000 });
  assert.ok(block.includes('【任务】'), '有块头');
  assert.ok(block.includes('运行中'), '含运行中');
  assert.ok(block.includes('先向主人汇报'), '含汇报指令');
  // 完成一个 + 失败一个：紧急在前。
  const state2 = mkState();
  add(state2, 'a', 'echo a'); add(state2, 'b', 'exit 1');
  startTask(state2, 't1'); startTask(state2, 't2');
  finishTask(state2, 't1', { ok: true, code: 0, summary: '干完了', now: NOW });
  finishTask(state2, 't2', { ok: false, code: 1, summary: '炸了', now: NOW });
  const block2 = reportBlock(state2, { maxChars: 2000 });
  const idxFailed = block2.indexOf('失败');
  const idxDone = block2.indexOf('已完成');
  assert.ok(idxFailed >= 0 && idxDone >= 0, '两类都在');
  assert.ok(idxFailed < idxDone, '失败排在已完成前面');
  const urgentBlock = reportBlock(state2, { maxChars: 2000, urgentOnly: true });
  assert.ok(urgentBlock.includes('炸了'), 'urgentOnly 含失败');
  assert.ok(!urgentBlock.includes('干完了'), 'urgentOnly 不含普通完成');
  // 日志不塞正文：summary 截断、只有文件路径。
  const state3 = mkState();
  add(state3, '长日志', 'echo x');
  startTask(state3, 't1');
  finishTask(state3, 't1', { ok: true, code: 0, summary: '好'.repeat(900), outputFile: 'task-outputs/t1.log', now: NOW });
  const block3 = reportBlock(state3, { maxChars: 2000 });
  assert.ok(block3.includes('state/task-outputs/t1.log'), '含日志路径');
  assert.ok(!block3.includes('好'.repeat(300)), 'summary 已截断');
}

// ── 9. normalizeTaskState：中断 running → failed；history 截断 ──────────────
{
  const state = mkState();
  add(state, '跑一半', 'echo r');
  startTask(state, 't1');
  const revived = normalizeTaskState({ version: 1, seq: state.seq, queue: state.queue }, NOW + 10000);
  assert.equal(taskById(revived, 't1').status, 'failed', '重启后 running→failed');
  assert.ok(taskById(revived, 't1').summary.includes('中断'), 'summary 标注中断');
  // history 截断
  const many = mkState();
  for (let i = 0; i < 60; i++) many.history.push({ id: `h${i}`, status: 'done', title: 'x', command: 'y', createdAt: NOW });
  assert.equal(many.history.length, 60, '先塞 60');
  const trimmed = normalizeTaskState({ version: 1, queue: [], history: many.history, maxHistory: 10 }, NOW);
  assert.ok(trimmed.history.length <= 10, 'history 截断到上限');
}

// ── 10. summarize 概览 ──────────────────────────────────────────────────────
{
  const state = mkState();
  add(state, 's1', 'echo 1');
  const s = summarize(state);
  assert.equal(s.seq, 1, 'seq=1');
  assert.equal(s.pending.length, 1, 'pending 1 个');
  assert.ok(Array.isArray(s.reports) && Array.isArray(s.recentHistory), '数组字段齐全');
}

console.log('✅ test-owner-tasks 通过');
