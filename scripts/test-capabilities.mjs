import assert from 'node:assert/strict';
import { CAPABILITIES, capabilityIds, renderHelp, renderPresetBlock } from '../src/capabilities.mjs';

// 1) 数据完整
const ids = capabilityIds();
assert.equal(new Set(ids).size, ids.length, 'id 不能重复');
for (const c of CAPABILITIES) {
  for (const k of ['id', 'title', 'when', 'limits', 'example']) {
    assert.ok(String(c[k] ?? '').trim(), `${c.id} 缺 ${k}`);
  }
  assert.ok(Array.isArray(c.tools) && c.tools.length > 0, `${c.id} 缺 tools`);
}

// 2) 总览：每一条都出现
const all = renderHelp();
for (const id of ids) assert.ok(all.includes(id), `总览缺 ${id}`);
assert.ok(all.includes('qq_help(topic='), '总览要给查法');

// 3) 单条：带边界和例子
const one = renderHelp('run_code');
assert.ok(one.includes('## 在本机跑命令'), '单条标题');
assert.ok(one.includes('边界：'), '单条要有边界');
assert.ok(one.includes('qq_run_code(command='), '单条要有例子');

// 4) 未知主题要说清楚
const miss = renderHelp('nope');
assert.ok(miss.includes('没有这个主题'), '未知主题要明说');
assert.ok(miss.includes('run_code'), '未知主题要列可用 id');

// 5) 预设块够短、能一行一条
const block = renderPresetBlock();
assert.ok(block.startsWith('【你能做什么·地图】'), '预设块要有标题');
for (const c of CAPABILITIES) assert.ok(block.includes(c.title), `预设块缺 ${c.title}`);
assert.ok(block.split('\n').length <= CAPABILITIES.length + 3, '预设块别太长');

console.log('capabilities 回归全部通过');
