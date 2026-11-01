// schedules（日程/定时器）离线回归：纯逻辑层，只测时间解析/增删/触发/daily 推进/注入块。
import assert from 'node:assert/strict';
import {
  DEFAULT_SCHEDULE_CONFIG,
  normalizeScheduleConfig,
  normalizeScheduleState,
  parseClockTime,
  addSchedule,
  dueSchedules,
  fireSchedule,
  cancelSchedule,
  scheduleBlock,
  summarize,
} from '../src/schedules.mjs';

const NOW = new Date('2026-11-02T12:00:00+08:00').getTime();
const mkState = () => normalizeScheduleState(null, NOW);
const cfg = normalizeScheduleConfig({});
const add = (state, title, time, extra = {}) =>
  addSchedule(state, { title, time, now: NOW, config: cfg, ...extra });

// ── 1. 配置归一化 ───────────────────────────────────────────────────────────
{
  const c = normalizeScheduleConfig({ maxItems: 999, summaryMaxChars: 99999, fireWindowMs: 1000 });
  assert.equal(c.enabled, true);
  assert.equal(c.maxItems, 500);
  assert.equal(c.summaryMaxChars, 4000);
  assert.equal(c.fireWindowMs, 30000); // 夹到 min 30s
  assert.equal(normalizeScheduleConfig({ enabled: false }).enabled, false);
  assert.deepEqual(Object.keys(normalizeScheduleConfig(null)).sort(), Object.keys(DEFAULT_SCHEDULE_CONFIG).sort());
  console.log('✅ 配置归一化通过');
}

// ── 2. 时间解析 ─────────────────────────────────────────────────────────────
{
  // HH:mm 未来时刻
  const r1 = parseClockTime('20:00', NOW);
  assert.equal(r1.ok, true);
  assert.equal(r1.ts, new Date('2026-11-02T20:00:00+08:00').getTime());
  // 已过的时刻 → 明天
  const r2 = parseClockTime('08:00', NOW); // 12:00 已过 08:00
  assert.equal(r2.ts, new Date('2026-11-03T08:00:00+08:00').getTime());
  // 带秒
  const r3 = parseClockTime('12:00:30', NOW);
  assert.equal(r3.ts, new Date('2026-11-02T12:00:30+08:00').getTime());
  // 绝对时间戳
  const r4 = parseClockTime('1730000000000', NOW);
  assert.equal(r4.ts, 1730000000000);
  // 非法
  assert.equal(parseClockTime('').ok, false);
  assert.equal(parseClockTime('abc').ok, false);
  assert.equal(parseClockTime('25:00').ok, false);
  assert.equal(parseClockTime('12:99').ok, false);
  console.log('✅ 时间解析通过');
}

// ── 3. 添加字段 ─────────────────────────────────────────────────────────────
{
  const state = mkState();
  const r = add(state, '刷两条B站', '20:00', { description: '发链接', repeat: 'daily' });
  assert.equal(r.ok, true);
  assert.equal(r.item.id, 's1');
  assert.equal(r.item.seq, 1);
  assert.equal(r.item.repeat, 'daily');
  assert.equal(r.item.status, 'pending');
  assert.equal(r.item.description, '发链接');
  assert.equal(r.item.dueAt, new Date('2026-11-02T20:00:00+08:00').getTime());
  // 空标题
  assert.equal(add(state, '', '20:00').ok, false);
  assert.equal(add(state, '', '20:00').reason, '标题不能为空');
  // 非法时间
  assert.equal(add(state, 'x', 'bad').reason, '时间格式应为 HH:mm 或 HH:mm:ss（或绝对毫秒时间戳）');
  console.log('✅ 添加字段通过');
}

// ── 4. 上限与计数 ───────────────────────────────────────────────────────────
{
  const state = mkState();
  const cap = normalizeScheduleConfig({ maxItems: 2 });
  assert.equal(addSchedule(state, { title: 'a', time: '20:00', now: NOW, config: cap }).ok, true);
  assert.equal(addSchedule(state, { title: 'b', time: '21:00', now: NOW, config: cap }).ok, true);
  const r3 = addSchedule(state, { title: 'c', time: '22:00', now: NOW, config: cap });
  assert.equal(r3.ok, false);
  assert.match(r3.reason, /已满/);
  assert.equal(state.items.length, 2);
  console.log('✅ 上限与计数通过');
}

// ── 5. 到期与一次性触发 ─────────────────────────────────────────────────────
{
  const state = mkState();
  const past = NOW - 1000;
  // 直接塞一个 dueAt 过去的 pending（用绝对时间戳）
  addSchedule(state, { title: '过去的一次性', time: String(past), now: NOW, config: cfg });
  assert.equal(dueSchedules(state, NOW).length, 1);
  const r = fireSchedule(state, 's1', NOW);
  assert.equal(r.ok, true);
  assert.equal(r.item.status, 'done');
  assert.equal(r.item.lastFiredAt, NOW);
  assert.equal(dueSchedules(state, NOW).length, 0); // 触发后不再到期
  console.log('✅ 到期与一次性触发通过');
}

// ── 6. daily 触发推进到明天 ─────────────────────────────────────────────────
{
  const state = mkState();
  add(state, '每天甩链接', '20:00', { repeat: 'daily' });
  const due0 = dueSchedules(state, new Date('2026-11-02T20:00:00+08:00').getTime());
  assert.equal(due0.length, 1);
  const r = fireSchedule(state, 's1', new Date('2026-11-02T20:00:00+08:00').getTime());
  assert.equal(r.ok, true);
  assert.equal(r.item.status, 'pending'); // daily 保持 pending
  assert.equal(r.item.dueAt, new Date('2026-11-03T20:00:00+08:00').getTime());
  console.log('✅ daily 触发推进到明天通过');
}

// ── 7. 取消 ─────────────────────────────────────────────────────────────────
{
  const state = mkState();
  add(state, '要取消的', '20:00');
  assert.equal(cancelSchedule(state, 's1').ok, true);
  assert.equal(cancelSchedule(state, 's1').reason, 'already-cancelled');
  assert.equal(cancelSchedule(state, 'nope').reason, 'not-found');
  assert.equal(dueSchedules(state, NOW).length, 0);
  console.log('✅ 取消通过');
}

// ── 8. 注入块 ───────────────────────────────────────────────────────────────
{
  const state = mkState();
  add(state, '刷两条B站', '20:00', { description: '把链接发给主人', repeat: 'daily' });
  const block = scheduleBlock(state, { now: NOW, fireWindowMs: 300000 });
  assert.match(block, /【日程】/);
  assert.match(block, /刷两条B站/);
  assert.match(block, /每天/);
  // 最近触发也进块
  const fired = scheduleBlock(mkState(), { now: NOW, fireWindowMs: 300000, recentFires: [{ seq: 1, title: '刚触发的事', description: '做掉', at: NOW - 1000 }] });
  assert.match(fired, /到点了，先做这件事/);
  assert.match(fired, /刚触发的事/);
  // 空状态返回空串
  assert.equal(scheduleBlock(mkState(), { now: NOW }), '');
  console.log('✅ 注入块通过');
}

// ── 9. 概览 ─────────────────────────────────────────────────────────────────
{
  const state = mkState();
  add(state, 'a', '20:00');
  add(state, 'b', '21:00', { repeat: 'daily' });
  const s = summarize(state);
  assert.equal(s.counts.pending, 2);
  assert.equal(s.counts.total, 2);
  assert.equal(s.pending[0].title, 'a'); // 按 dueAt 升序
  assert.equal(s.pending[1].title, 'b');
  assert.match(s.pending[0].dueText, /\d/);
  console.log('✅ 概览通过');
}

console.log('\nschedules 离线回归全部通过');
