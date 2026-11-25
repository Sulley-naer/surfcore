// wechat（微信通道）离线回归：只测出站队列/回执/状态与分段，不碰网络。
import assert from 'node:assert/strict';
import {
  DEFAULT_WECHAT_CONFIG,
  normalizeWechatConfig,
  normalizeWechatState,
  enqueueJob,
  takeJob,
  applyReceipt,
  noteStatus,
  chunkText,
  summarizeWechat,
  trimWechatState,
} from '../src/wechat.mjs';

console.log('Running test-wechat.mjs');

// 1) 配置归一化
const cfg = normalizeWechatConfig({ enabled: true, chatId: 'wxid_x', maxQueue: 2, maxResults: 5 });
assert.equal(cfg.chatId, 'wxid_x');
assert.equal(cfg.maxQueue, 2);
assert.equal(normalizeWechatConfig({}).enabled, true);
assert.equal(normalizeWechatConfig({ enabled: false }).enabled, false);
assert.equal(normalizeWechatConfig({ maxQueue: 9999 }).maxQueue, 500);

// 2) 入队：空文本 / 无会话 / 队列上限
const state = normalizeWechatState(null);
assert.equal(enqueueJob(state, { text: '  ', chatId: 'wxid_x', config: cfg }).ok, false);
assert.equal(enqueueJob(state, { text: 'hi', chatId: '', config: { ...cfg, chatId: '' } }).reason, 'no-chat');
assert.equal(enqueueJob(state, { text: 'a', chatId: 'wxid_x', config: cfg }).ok, true);
assert.equal(enqueueJob(state, { text: 'b', chatId: 'wxid_x', config: cfg }).ok, true);
assert.equal(enqueueJob(state, { text: 'c', chatId: 'wxid_x', config: cfg }).reason, 'queue-full');

// 3) 投递：只投给它绑定的会话，投过不再投（at-most-once）
const job = takeJob(state, { accountId: 'wxid_self', chatIds: ['wxid_other'] });
assert.equal(job, null, '未绑定的会话不该拿到任务');
const j1 = takeJob(state, { accountId: 'wxid_self', chatIds: ['wxid_x'], now: 1000 });
assert.ok(j1 && j1.status === 'delivered');
assert.equal(takeJob(state, { accountId: 'wxid_self', chatIds: ['wxid_x'] }).id, state.jobs[1].id);

// 4) 回执：sent / failed / 未知 id
const ok = applyReceipt(state, { id: j1.id, status: 'sent', confirmed: 1, total: 1 }, 2000);
assert.equal(ok.ok, true);
assert.equal(ok.job.status, 'sent');
assert.equal(ok.job.finishedAt, 2000);
const bad = applyReceipt(state, { id: 'nope', status: 'sent' });
assert.equal(bad.ok, false);
assert.equal(bad.reason, 'not-found');

// 5) 长文本分段
const parts = chunkText('a'.repeat(2000), 900);
assert.equal(parts.length >= 3, true);
assert.equal(parts.join('').length, 2000);

// 6) 状态快照 + 裁剪
noteStatus(state, { bound: true });
const sum = summarizeWechat(state);
assert.equal(sum.pending + sum.delivered + sum.sent + sum.failed >= 2, true);
assert.equal(sum.status.bound, true);
for (let i = 0; i < 20; i += 1) {
  const r = enqueueJob(state, { text: `m${i}`, chatId: 'wxid_x', config: { ...cfg, maxQueue: 100 } });
  const j = takeJob(state, { accountId: 'wxid_self', chatIds: ['wxid_x'] });
  applyReceipt(state, { id: r.job.id, status: 'sent', confirmed: 1, total: 1 });
}
trimWechatState(state, { ...DEFAULT_WECHAT_CONFIG, maxResults: 5 });
const done = state.jobs.filter((x) => x.status === 'sent');
assert.equal(done.length <= 5, true);

console.log('✅ wechat 全部通过');
