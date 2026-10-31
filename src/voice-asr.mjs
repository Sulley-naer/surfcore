// 收到语音消息的自动转写（STT）。
//
// 两条路，按 backend 选择：
//   1) qq    —— 问 QQ 自己：POST {snowluma.httpUrl}/fetch_ptt_text {message_id}。
//               零依赖、零延迟；但只有 QQ 服务端转写过的语音才有结果（别人发来的通常有，
//               自己发出去的没有，实测 retcode=100「消息中不包含语音」）。
//   2) local —— 拿音频走本地 faster-whisper：get_record → ffmpeg 转 16k 单声道 → python 脚本。
//               离线可用、结果稳定；代价是要装 faster-whisper 和模型。
//
// backend='auto' 时先试 qq，拿不到文本再走 local。两条都失败返回 { text: '' }，
// 由调用方决定提示词里怎么写（桥接会写成「[语音]（转写失败）」）。
//
// 这个模块只负责「一条语音 → 一段文字」，不碰会话状态、不发消息。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { resolveFfmpeg } from './voice-core.js';

const SILK_MAGIC = Buffer.from('#!SILK_V3', 'latin1');
/** QQ 语音是腾讯 SILK v3，魔数 `#!SILK_V3`；ffmpeg 解不了，交给 python 的 pilk。 */
function isSilk(buf) {
  try { return Buffer.isBuffer(buf) && buf.includes(SILK_MAGIC); } catch { return false; }
}

export const ASR_DEFAULTS = Object.freeze({  enabled: true,
  backend: 'auto',            // auto | qq | local
  scope: 'owner',             // owner | whitelist | all
  maxSeconds: 60,             // 超过这个时长的语音不转写（省算力）
  maxBytes: 20 * 1024 * 1024,
  timeoutMs: 30000,           // 单条总预算
  qqTimeoutMs: 8000,
  localTimeoutMs: 60000,
  python: 'E:/DeepSeeK/faster-whisper/.venv/Scripts/python.exe',
  script: 'E:/DeepSeeK/faster-whisper/transcribe.py',
  modelDir: 'E:/DeepSeeK/faster-whisper/models/small',
  device: 'cpu',
  computeType: 'int8',
  language: 'zh',
  cacheTtlMs: 30 * 60 * 1000,
});

function text(value, max = 4000) {
  const s = String(value ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) : s;
}

/** 合并默认值 + 用户配置；路径允许相对仓库根。 */
export function normalizeAsrConfig(input = {}, { root = process.cwd() } = {}) {
  const src = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const abs = (v, fallback) => {
    const raw = String(v ?? '').trim() || fallback;
    return path.isAbsolute(raw) ? raw : path.resolve(root, raw);
  };
  const num = (v, fallback, min, max) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  };
  const backend = ['auto', 'qq', 'local'].includes(String(src.backend)) ? String(src.backend) : ASR_DEFAULTS.backend;
  const scope = ['owner', 'whitelist', 'all'].includes(String(src.scope)) ? String(src.scope) : ASR_DEFAULTS.scope;
  return {
    enabled: src.enabled !== false,
    backend,
    scope,
    maxSeconds: num(src.maxSeconds, ASR_DEFAULTS.maxSeconds, 1, 600),
    maxBytes: num(src.maxBytes, ASR_DEFAULTS.maxBytes, 1024, 200 * 1024 * 1024),
    timeoutMs: num(src.timeoutMs, ASR_DEFAULTS.timeoutMs, 1000, 300000),
    qqTimeoutMs: num(src.qqTimeoutMs, ASR_DEFAULTS.qqTimeoutMs, 500, 120000),
    localTimeoutMs: num(src.localTimeoutMs, ASR_DEFAULTS.localTimeoutMs, 1000, 300000),
    python: abs(src.python, ASR_DEFAULTS.python),
    script: abs(src.script, ASR_DEFAULTS.script),
    modelDir: abs(src.modelDir, ASR_DEFAULTS.modelDir),
    device: String(src.device ?? ASR_DEFAULTS.device).trim() || ASR_DEFAULTS.device,
    computeType: String(src.computeType ?? ASR_DEFAULTS.computeType).trim() || ASR_DEFAULTS.computeType,
    language: String(src.language ?? ASR_DEFAULTS.language).trim() || ASR_DEFAULTS.language,
    cacheTtlMs: num(src.cacheTtlMs, ASR_DEFAULTS.cacheTtlMs, 0, 24 * 3600 * 1000),
  };
}

/** 从 record 段或 get_record 返回体里找出「音频在哪」。 */
export function extractAudioRef(payload = {}) {
  const d = payload && typeof payload === 'object' ? (payload.data && typeof payload.data === 'object' ? payload.data : payload) : {};
  const first = (...keys) => {
    for (const k of keys) {
      const v = d[k];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return '';
  };
  const base64 = first('base64', 'b64', 'data_base64');
  if (base64) return { kind: 'base64', value: base64.replace(/^data:[^,]*,/, '') };
  // QQ 的 record 段里 `url` 才是可下载的真地址，`file` 往往只是个内部 amr 文件名（如
  // 7d159ca….amr），不是本地路径。所以 url 优先级要高于 file。
  const url = first('url', 'http_url');
  if (url) return { kind: 'url', value: url };
  const file = first('file', 'path', 'file_path');
  if (file.startsWith('base64://')) return { kind: 'base64', value: file.slice('base64://'.length) };
  if (/^data:[^,]*;base64,/i.test(file)) return { kind: 'base64', value: file.replace(/^data:[^,]*,/, '') };
  if (/^https?:\/\//i.test(file)) return { kind: 'url', value: file };
  if (file) return { kind: 'file', value: file };
  return null;
}

/** QQ 自己的转写（fetch_ptt_text）。拿不到就返回 null，不抛。 */
export async function qqTranscribe({ httpUrl, token, messageId, timeoutMs = 8000 }) {
  const base = String(httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
  const res = await fetch(`${base}/fetch_ptt_text`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ message_id: String(messageId) }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await res.json().catch(() => ({}));
  const data = body?.data ?? {};
  const got = typeof data === 'string' ? data : (data.text ?? data.ptt_text ?? data.transcription ?? '');
  return text(got) || null;
}

/** 用打包好的 python 脚本跑 faster-whisper。 */
function runWhisper({ cfg, audioFile, timeoutMs }) {
  return new Promise((resolve) => {
    const args = [cfg.script, '--audio', audioFile, '--model', cfg.modelDir,
      '--device', cfg.device, '--compute-type', cfg.computeType, '--language', cfg.language];
    let out = '';
    let err = '';
    let done = false;
    let child;
    const finish = (value) => {
      if (done) return;
      done = true;
      try { child?.kill(); } catch {}
      resolve(value);
    };
    try {
      // Windows 上 python 被管道捕获时默认用 GBK 输出，中文会变成乱码；强制 UTF-8。
      child = spawn(cfg.python, ['-X', 'utf8', ...args], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      });
    } catch (error) {
      resolve({ text: '', error: `启动 whisper 失败：${error?.message ?? error}` });
      return;
    }
    const timer = setTimeout(() => finish({ text: '', error: `whisper 超时（${timeoutMs}ms）` }), timeoutMs);
    child.stdout.on('data', (buf) => { out += buf.toString('utf8'); });
    child.stderr.on('data', (buf) => { err += buf.toString('utf8'); });
    child.on('error', (error) => { clearTimeout(timer); finish({ text: '', error: `whisper 不可用：${error?.message ?? error}` }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return finish({ text: '', error: `whisper 退出码 ${code}：${text(err, 200)}` });
      const line = out.split(/\r?\n/).reverse().find((l) => l.trim().startsWith('{'));
      if (!line) return finish({ text: '', error: 'whisper 没有返回 JSON' });
      try {
        const parsed = JSON.parse(line);
        finish({ text: text(parsed.text), error: parsed.error ? String(parsed.error) : '' });
      } catch (error) {
        finish({ text: '', error: `whisper 输出解析失败：${error?.message ?? error}` });
      }
    });
  });
}

/** 把任意音频转成 16k 单声道 wav。 */
function toWav(ffmpeg, inputFile, outputFile, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    let done = false;
    const finish = (value) => { if (done) return; done = true; try { child?.kill(); } catch {} resolve(value); };
    try {
      child = spawn(ffmpeg, ['-y', '-v', 'error', '-i', inputFile, '-ar', '16000', '-ac', '1', '-f', 'wav', outputFile], { windowsHide: true, stdio: 'ignore' });
    } catch (error) {
      return resolve({ ok: false, error: `ffmpeg 启动失败：${error?.message ?? error}` });
    }
    const timer = setTimeout(() => finish({ ok: false, error: 'ffmpeg 超时' }), timeoutMs);
    child.on('error', (error) => { clearTimeout(timer); finish({ ok: false, error: `ffmpeg 不可用：${error?.message ?? error}` }); });
    child.on('close', (code) => { clearTimeout(timer); finish(code === 0 ? { ok: true } : { ok: false, error: `ffmpeg 退出码 ${code}` }); });
  });
}

/**
 * 创建转写控制器。
 * @param {{getCfg:()=>object, log?:(...a:any[])=>void}} deps
 */
export function createVoiceAsr({ getCfg, log = () => {} } = {}) {
  const cache = new Map();     // messageId -> { text, source, at }
  const inflight = new Map();  // messageId -> Promise

  function cfgNow() {
    const cfg = typeof getCfg === 'function' ? (getCfg() ?? {}) : {};
    const raw = cfg?.socialV2?.voice?.asr ?? {};
    return { cfg, asr: normalizeAsrConfig(raw) };
  }

  function prune(now = Date.now()) {
    for (const [k, v] of cache) if (now - v.at > ASR_DEFAULTS.cacheTtlMs) cache.delete(k);
    while (cache.size > 500) cache.delete(cache.keys().next().value);
  }

  async function download(url, { maxBytes, timeoutMs }) {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const len = Number(res.headers.get('content-length') ?? 0);
    if (len > maxBytes) throw new Error(`音频过大（${len} 字节）`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) throw new Error(`音频过大（${buf.length} 字节）`);
    return buf;
  }

  async function getRecord({ cfg, record, timeoutMs }) {
    const base = String(cfg?.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    const fileId = record?.file_id ?? record?.file ?? record?.file_id_str ?? '';
    const res = await fetch(`${base}/get_record`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cfg?.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {}),
      },
      body: JSON.stringify({ file_id: String(fileId), file: String(fileId) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`get_record HTTP ${res.status}`);
    return body;
  }

  async function localTranscribe({ cfg, asr, record, timeoutMs }) {
    const vc = cfg?.socialV2?.voice ?? {};
    let ref = extractAudioRef(record);
    if (!ref) {
      const body = await getRecord({ cfg, record, timeoutMs: Math.min(timeoutMs, 15000) });
      ref = extractAudioRef(body);
    }
    if (!ref) throw new Error('拿不到语音文件（get_record 没有返回可用字段）');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-asr-'));
    try {
      let buf;
      if (ref.kind === 'base64') buf = Buffer.from(ref.value, 'base64');
      else if (ref.kind === 'url') buf = await download(ref.value, { maxBytes: asr.maxBytes, timeoutMs });
      else buf = fs.readFileSync(ref.value);
      if (!buf?.length) throw new Error('语音文件为空');
      if (buf.length > asr.maxBytes) throw new Error(`音频过大（${buf.length} 字节）`);
      const raw = path.join(tmp, 'in.bin');
      fs.writeFileSync(raw, buf);
      let audioFile;
      if (isSilk(buf)) {
        // 腾讯 SILK v3：ffmpeg 解不了，直接交给 transcribe.py（它用 pilk 解成 16k PCM）。
        audioFile = raw;
      } else {
        const wav = path.join(tmp, 'in.wav');
        const ffmpeg = resolveFfmpeg({ ffmpegPath: vc.ffmpegPath || null });
        const conv = await toWav(ffmpeg, raw, wav, Math.min(timeoutMs, 30000));
        if (!conv.ok) throw new Error(conv.error || '音频转码失败');
        audioFile = wav;
      }
      const out = await runWhisper({ cfg: { ...asr, script: asr.script, python: asr.python, modelDir: asr.modelDir, device: asr.device, computeType: asr.computeType, language: asr.language }, audioFile, timeoutMs: Math.min(asr.localTimeoutMs, timeoutMs) });
      if (out.error) throw new Error(out.error);
      return out.text;
    } finally {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    }
  }

  async function doTranscribe({ messageId, record, key, senderId }) {
    const { cfg, asr } = cfgNow();
    if (!asr.enabled) return { text: '', source: '', error: 'disabled' };
    if (asr.scope === 'owner' && String(senderId ?? '') !== String(cfg?.ownerQQ ?? '')) {
      return { text: '', source: '', error: 'scope' };
    }
    const cached = cache.get(String(messageId));
    if (cached && Date.now() - cached.at < asr.cacheTtlMs) return { ...cached, cached: true };

    const started = Date.now();
    const deadline = started + asr.timeoutMs;
    let lastError = '';

    const tryQq = async () => {
      if (!messageId) throw new Error('没有 message_id，无法问 QQ');
      const limit = Math.min(asr.qqTimeoutMs, Math.max(1000, deadline - Date.now()));
      const got = await qqTranscribe({
        httpUrl: cfg?.snowluma?.httpUrl,
        token: cfg?.snowluma?.accessToken,
        messageId,
        timeoutMs: limit,
      });
      if (!got) throw new Error('QQ 没有这条语音的转写');
      return { text: got, source: 'qq' };
    };
    const tryLocal = async () => {
      const limit = Math.max(3000, deadline - Date.now());
      const got = await localTranscribe({ cfg, asr, record, timeoutMs: limit });
      if (!got) throw new Error('本地 ASR 没有识别出文字');
      return { text: got, source: 'local' };
    };

    const order = asr.backend === 'local' ? [tryLocal] : asr.backend === 'qq' ? [tryQq] : [tryQq, tryLocal];
    for (const step of order) {
      try {
        const result = await step();
        const entry = { ...result, at: Date.now() };
        cache.set(String(messageId), entry);
        prune();
        log(`[asr] ${key ?? ''} ${messageId} 转写成功（${result.source}，${result.text.length} 字）`);
        return entry;
      } catch (error) {
        lastError = String(error?.message ?? error).slice(0, 200);
        log(`[asr] ${key ?? ''} ${messageId} 转写失败：${lastError}`);
      }
    }
    return { text: '', source: '', error: lastError || 'unknown' };
  }

  /** 同一条消息并发只跑一次。 */
  function transcribe({ messageId, record, key, senderId }) {
    const id = String(messageId ?? '');
    if (!id) return Promise.resolve({ text: '', source: '', error: 'no-message-id' });
    const pending = inflight.get(id);
    if (pending) return pending;
    const task = doTranscribe({ messageId: id, record, key, senderId })
      .finally(() => inflight.delete(id));
    inflight.set(id, task);
    return task;
  }

  function status() {
    const { asr } = cfgNow();
    return {
      enabled: asr.enabled,
      backend: asr.backend,
      scope: asr.scope,
      pythonReady: (() => { try { return fs.existsSync(asr.python); } catch { return false; } })(),
      scriptReady: (() => { try { return fs.existsSync(asr.script); } catch { return false; } })(),
      modelReady: (() => { try { return fs.existsSync(asr.modelDir); } catch { return false; } })(),
      modelDir: asr.modelDir,
      cached: cache.size,
    };
  }

  return { transcribe, status };
}
