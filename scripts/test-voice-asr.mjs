// 语音转写（voice-asr）离线回归：全部用 mock，不连真 QQ / 不跑真模型。
import assert from 'node:assert/strict';
import { normalizeAsrConfig, extractAudioRef, qqTranscribe, createVoiceAsr, ASR_DEFAULTS } from '../src/voice-asr.mjs';

// ── 1. 配置归一化 ───────────────────────────────────────────────────────────
{
  const cfg = normalizeAsrConfig({ backend: 'nope', scope: 'x', timeoutMs: -5, maxSeconds: 9999 });
  assert.equal(cfg.backend, 'auto', '未知 backend 回退 auto');
  assert.equal(cfg.scope, 'owner', '未知 scope 回退 owner');
  assert.equal(cfg.maxSeconds, 600, 'maxSeconds 夹到 600');
  assert.ok(cfg.timeoutMs >= 1000, 'timeoutMs 下限 1000');
  assert.equal(cfg.enabled, true, '默认开启');
  assert.equal(normalizeAsrConfig({ enabled: false }).enabled, false, '可显式关闭');
}

// ── 2. 从各种形状里找音频 ───────────────────────────────────────────────────
{
  assert.deepEqual(extractAudioRef({ base64: 'ABC' }), { kind: 'base64', value: 'ABC' });
  assert.deepEqual(extractAudioRef({ file: 'base64://QQ==' }), { kind: 'base64', value: 'QQ==' });
  assert.deepEqual(extractAudioRef({ url: 'https://x/y.amr' }), { kind: 'url', value: 'https://x/y.amr' });
  assert.deepEqual(extractAudioRef({ data: { file: 'D:/tmp/a.amr' } }), { kind: 'file', value: 'D:/tmp/a.amr' });
  assert.deepEqual(extractAudioRef({ file: 'data:audio/amr;base64,ZZZ' }), { kind: 'base64', value: 'ZZZ' }, 'data: URI 也当 base64');
  assert.equal(extractAudioRef({}), null);
  assert.equal(extractAudioRef(null), null);
}

// ── 3. QQ 转写：成功 / 空 / HTTP 失败 ───────────────────────────────────────
{
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ status: 'ok', retcode: 0, data: { text: ' 你好呀 ' } }) });
    assert.equal(await qqTranscribe({ httpUrl: 'http://127.0.0.1:3000', token: 't', messageId: '1' }), '你好呀');

    globalThis.fetch = async () => ({ ok: true, json: async () => ({ status: 'ok', retcode: 0, data: {} }) });
    assert.equal(await qqTranscribe({ httpUrl: 'http://127.0.0.1:3000', messageId: '2' }), null, '没有文本时返回 null');

    globalThis.fetch = async () => ({ ok: false, json: async () => ({ retcode: 100, message: '消息中不包含语音' }) });
    assert.equal(await qqTranscribe({ httpUrl: 'http://127.0.0.1:3000', messageId: '3' }), null);
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ── 4. 控制器：QQ 成功 / 缓存去重 / 非主人跳过 / 全失败 ─────────────────────
{
  const realFetch = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async () => {
      calls += 1;
      return { ok: true, json: async () => ({ data: { text: '第一次转写' } }) };
    };
    const asr = createVoiceAsr({ getCfg: () => ({ ownerQQ: 1444736434, snowluma: { httpUrl: 'http://127.0.0.1:3000' }, socialV2: { voice: { asr: { enabled: true, backend: 'auto' } } } }) });
    const r1 = await asr.transcribe({ messageId: 'm1', record: { file: 'x' }, key: 'private:1', senderId: '1444736434' });
    assert.equal(r1.text, '第一次转写');
    assert.equal(r1.source, 'qq');
    const r2 = await asr.transcribe({ messageId: 'm1', record: { file: 'x' }, key: 'private:1', senderId: '1444736434' });
    assert.equal(r2.text, '第一次转写');
    assert.equal(calls, 1, '同一 messageId 只问一次 QQ');

    const r3 = await asr.transcribe({ messageId: 'm2', record: { file: 'x' }, key: 'private:2', senderId: '999' });
    assert.equal(r3.text, '', '非主人（scope=owner）不转写');
    assert.equal(r3.error, 'scope');

    const st = asr.status();
    assert.equal(st.enabled, true);
    assert.equal(st.backend, 'auto');
    assert.equal(typeof st.modelReady, 'boolean');
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ── 5. 全失败时返回空文本 + 错误原因（不抛） ────────────────────────────────
{
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => { throw new Error('connect ECONNREFUSED'); };
    const asr = createVoiceAsr({ getCfg: () => ({
      ownerQQ: 1,
      snowluma: { httpUrl: 'http://127.0.0.1:9' },
      socialV2: { voice: { asr: { enabled: true, backend: 'qq', python: 'nope', script: 'nope', modelDir: 'nope' } } },
    }) });
    const r = await asr.transcribe({ messageId: 'bad', record: {}, key: 'private:1', senderId: '1' });
    assert.equal(r.text, '');
    assert.ok(r.error, '失败要带原因');
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ── 6. 关闭时直接返回 disabled，不发任何请求 ────────────────────────────────
{
  let called = 0;
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => { called += 1; return { ok: true, json: async () => ({}) }; };
    const asr = createVoiceAsr({ getCfg: () => ({ ownerQQ: 1, socialV2: { voice: { asr: { enabled: false } } } }) });
    const r = await asr.transcribe({ messageId: 'x', record: {}, key: 'k', senderId: '1' });
    assert.equal(r.text, '');
    assert.equal(r.error, 'disabled');
    assert.equal(called, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log('✅ voice-asr 回归通过（配置归一化 / 音频定位 / QQ 转写 / 缓存 / scope / 关闭）');
console.log('默认值抽查:', JSON.stringify(ASR_DEFAULTS).slice(0, 120));
