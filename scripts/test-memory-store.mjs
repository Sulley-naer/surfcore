// memory-store（全量记忆库）离线回归：node:sqlite + FTS5，只在临时目录建库，不碰线上数据。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  openMemory,
  appendEvent,
  searchEvents,
  searchCards,
  searchAll,
  recentEvents,
  upsertCard,
  getCard,
  getEvent,
  setDaySummary,
  getDay,
  stats,
  dayOf,
  closeMemory,
} from '../src/memory-store.mjs';

console.log('Running test-memory-store.mjs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'elysia-memory-'));
const dbFile = path.join(tmpDir, 'test.sqlite');

const mem = openMemory(dbFile);
assert.ok(mem, 'openMemory 应返回句柄');

// 1) 写事件 + 读回
const id1 = appendEvent(mem, {
  ts: Date.parse('2026-11-15T10:00:00+08:00'),
  channel: 'qq',
  convKey: 'private:1444736434',
  role: 'owner',
  speaker: '主人',
  text: '说好 18 块一小时变成现在这么低，一天 134',
});
assert.equal(typeof id1, 'number', 'appendEvent 应返回数字 id');
const got = getEvent(mem, id1);
assert.equal(got.text.includes('134'), true, 'getEvent 应能取回原文');

// 2) FTS 中文检索（trigram）
const hit = searchEvents(mem, '工资', 5);
assert.equal(Array.isArray(hit), true);
const byPay = searchEvents(mem, '134', 5);
assert.equal(byPay.length >= 1, true, '按数字也应能命中');
const byTime = searchEvents(mem, '店里', 5);
assert.equal(Array.isArray(byTime), true);

// 3) recentEvents 顺序 & 条数
appendEvent(mem, { ts: Date.now(), role: 'self', text: '晚安', channel: 'qq' });
const recent = recentEvents(mem, 10);
assert.equal(recent.length >= 2, true, 'recentEvents 应有两条以上');
assert.equal(recent[0].text, '晚安', 'recentEvents 最新在前');

// 4) 卡片：写入/覆盖/检索
upsertCard(mem, {
  id: 'card-wage',
  kind: 'fact',
  title: '工资那事',
  body: '11-15 他说工资从 18 掉到一天 134',
  tags: ['工作', '钱'],
  importance: 4,
  emotional: 3,
});
const card = getCard(mem, 'card-wage');
assert.equal(card.title, '工资那事');
const cardHits = searchCards(mem, '工资', 5);
assert.equal(cardHits.length >= 1, true, 'searchCards 应命中');
const allHits = searchAll(mem, '工资', 5);
assert.equal(allHits.some((x) => x.kind === 'card' || x.kind === 'event'), true);

// 5) 日记摘要
setDaySummary(mem, '2026-11-26', '平静的一天，下午修了壁纸');
const day = getDay(mem, '2026-11-26');
assert.equal(day.summary.includes('壁纸'), true);
assert.equal(dayOf(Date.parse('2026-11-26T23:00:00+08:00')), '2026-11-26');

// 6) 统计
const st = stats(mem);
assert.equal(st.events >= 2, true);
assert.equal(st.cards >= 1, true);

closeMemory(mem);
fs.rmSync(tmpDir, { recursive: true, force: true });

console.log('✅ memory-store 全部通过');
