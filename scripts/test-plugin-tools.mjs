/**
 * 插件层工具的离线回归：
 *   · lib/qq-tools.js —— 9 个 owner 控制工具的定义/开关/参数 schema/注册门控（toolSource）
 *   · lib/features.js —— 17 个桥接功能开关的读/写语义
 *
 * 不碰网络、不碰 DSH：actx.tools.register 用假实现收注册结果。
 */
import assert from 'node:assert/strict';

import {
  QQ_TOOL_SPECS,
  enabledQqToolSpecs,
  minimalDefineTool,
  registerQqTools,
} from '../plugins/surfcore/lib/qq-tools.js';
import {
  FEATURE_TOGGLES,
  applyFeatureState,
  readFeatureState,
  readPath,
  writePath,
} from '../plugins/surfcore/lib/features.js';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('qq-tools：9 个工具定义齐全且端点/开关正确', () => {
  assert.equal(QQ_TOOL_SPECS.length, 9);
  const names = QQ_TOOL_SPECS.map((s) => s.name);
  assert.deepEqual(names, [
    'qq_run_code', 'qq_task_run', 'qq_task_status', 'qq_task_cancel',
    'qq_schedule_add', 'qq_schedule_list', 'qq_schedule_cancel',
    'qq_wake_phone', 'qq_phone_result',
  ]);
  for (const spec of QQ_TOOL_SPECS) {
    assert.match(spec.endpoint, /^\/api\/socialV2\//, `${spec.name} endpoint`);
    assert.equal(typeof spec.body, 'function');
    assert.equal(typeof spec.parameters.key?.required, 'boolean');
    assert.equal(spec.parameters.key.required, true, `${spec.name} 需要 key`);
    assert.equal(spec.parameters.token.required, true, `${spec.name} 需要 token`);
  }
});

test('qq-tools：toolSource=mcp 时不注册（默认走 MCP server）', () => {
  const got = [];
  registerQqTools({ tools: { register: (d) => got.push(d) } }, {
    defineTool: minimalDefineTool,
    cfg: { socialV2: { toolSource: 'mcp' } },
  });
  assert.equal(got.length, 0);
});

test('qq-tools：toolSource=plugin 时注册 9 个并尊重 tools 开关', () => {
  const got = [];
  const names = registerQqTools({ tools: { register: (d) => got.push(d) } }, {
    defineTool: minimalDefineTool,
    cfg: { socialV2: { toolSource: 'plugin', tools: { getImages: false } } },
  });
  assert.equal(names.length, 9);
  assert.equal(got.length, 9);
  assert.equal(enabledQqToolSpecs({ socialV2: { tools: { wakePhone: false } } }).some((s) => s.name === 'qq_wake_phone'), false);
});

test('qq-tools：参数 schema 与 required 列表正确', () => {
  const got = [];
  registerQqTools({ tools: { register: (d) => got.push(d) } }, {
    defineTool: minimalDefineTool,
    cfg: { socialV2: { toolSource: 'plugin' } },
  });
  const run = got.find((d) => d.name === 'qq_task_run');
  assert.equal(run.parameters.type, 'object');
  assert.deepEqual(run.parameters.required.sort(), ['command', 'key', 'title', 'token']);
  assert.equal(run.parameters.properties.timeoutMs.type, 'number');
  const add = got.find((d) => d.name === 'qq_schedule_add');
  assert.deepEqual(add.parameters.properties.repeat.enum, ['none', 'daily']);
  assert.equal(add.parameters.required.includes('repeat'), false);
});

test('qq-tools：body() 只传业务字段', () => {
  const run = QQ_TOOL_SPECS.find((s) => s.name === 'qq_task_run');
  assert.deepEqual(run.body({ key: 'private:1', token: 'x', title: 't', command: 'c' }), {
    key: 'private:1', title: 't', command: 'c',
  });
  const schedule = QQ_TOOL_SPECS.find((s) => s.name === 'qq_schedule_add');
  assert.equal(schedule.body({ key: 'k', token: 't', title: 'a', time: '20:00' }).repeat, 'none');
  assert.equal(schedule.body({ key: 'k', token: 't', title: 'a', time: '20:00', repeat: 'daily' }).repeat, 'daily');
});

test('features：17 个开关，缺省视为开', () => {
  assert.equal(FEATURE_TOGGLES.length, 17);
  const state = readFeatureState({ socialV2: {} });
  assert.equal(state.length, 17);
  assert.equal(state.every((item) => item.value === true && item.explicit === false), true);
});

test('features：显式 false/true 与读写往返', () => {
  const cfg = { socialV2: { tools: { runCode: false }, exec: { enabled: false } } };
  const state = readFeatureState(cfg);
  assert.equal(state.find((i) => i.id === 'runCode').value, false);
  assert.equal(state.find((i) => i.id === 'runCode').explicit, true);
  assert.equal(state.find((i) => i.id === 'runCode').path, 'socialV2.tools.runCode');
  assert.equal(state.find((i) => i.id === 'execEnabled').value, false);

  const copy = { socialV2: {} };
  const result = applyFeatureState(copy, { schedulesEnabled: false, unknownKey: true });
  assert.equal(result.ok, true);
  assert.deepEqual(result.ids, ['schedulesEnabled']);
  assert.deepEqual(result.unknown, ['unknownKey']);
  assert.equal(readPath(copy, ['socialV2', 'schedules', 'enabled']), false);

  writePath(copy, ['socialV2', 'tools', 'sendImage'], true);
  assert.equal(readPath(copy, ['socialV2', 'tools', 'sendImage']), true);
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`✅ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`❌ ${name}\n   ${error?.message ?? error}`);
  }
}
if (failed > 0) {
  console.error(`插件工具回归：${failed}/${tests.length} 失败`);
  process.exit(1);
}
console.log(`插件工具回归：${tests.length}/${tests.length} 通过`);
