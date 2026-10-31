// 导出跨设备迁移数据包（不导出任何 venv / 密钥 / 日志 / 大模型权重）。
//
// 用法：
//   node scripts/portable/export-port.mjs [--out DIR] [--voice none|refs|all] [--mask] [--no-zip] [--dry-run]
//
// 产出：<out>/surfcore-port-<时间戳>/
//   ├─ surfcore/          # repo/state 的运行时数据（QQ 会话映射、记忆、表情库、黑话库…）
//   ├─ surfcore-home/     # ~/.dsh/surfcore 的合体层数据（角色卡、记忆卡、B站数据、对齐记录…）
//   ├─ templates/         # config.example.json / paths.example.json（新机照着填）
//   ├─ portable/          # bootstrap-windows.ps1 / port-doctor.mjs / export-port.mjs（自包含）
//   └─ manifest.json      # 版本、机器路径清单、逐文件 sha256、脱敏扫描报告
// 默认再压缩成 surfcore-port-<时间戳>.zip（用系统 tar.exe）。
//
// 明确不打包：config.json（含密钥）、~/.dsh/surfcore/config.json、bili 凭据、
// 所有 .venv*、*.log、backups/、billing/、telemetry jsonl、bridge.lock。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as pp from '../../plugins/surfcore/lib/paths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const HOME = process.env.USERPROFILE || os.homedir();
const DSH_HOME = process.env.DSH_HOME || path.join(HOME, '.dsh');
const SURFCORE_HOME = path.join(DSH_HOME, 'surfcore');
const QQ_STATE = path.join(ROOT, 'state');

// ── 参数 ──
function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  return fallback;
}
const has = (name) => process.argv.includes(`--${name}`);
const OUT = arg('out', path.join(ROOT, '_exports'));
const VOICE = ['none', 'refs', 'all'].includes(arg('voice', 'none')) ? arg('voice', 'none') : 'none';
const MASK = has('mask');
const NO_ZIP = has('no-zip');
const DRY_RUN = has('dry-run');

// ── 排除规则（相对路径，统一用 / 分隔；命中即排除）──
const ALWAYS_EXCLUDE = [
  /(^|\/)\.venv[^/]*(\/|$)/,
  /(^|\/)\.pip-cache(\/|$)/,
  /(^|\/)\.pytest_cache(\/|$)/,
  /(^|\/)__pycache__(\/|$)/,
  /(^|\/)node_modules(\/|$)/,
  /\.log(\.\d+)?$/,
  /(^|\/)bridge\.lock$/,
  /(^|\/)backups(\/|$)/,
  /(^|\/)billing(\/|$)/,
  /(^|\/)logs(\/|$)/,
  /(^|\/)context-telemetry.*\.jsonl$/,
  /(^|\/)gate-events.*\.jsonl$/,
  /(^|\/)audit\.jsonl$/,
  /(^|\/)config\.json$/,          // 合体层 config.json（含 consoleToken/accessToken）
  /credentials.*\.json$/,
  /(^|\/)\.git(\/|$)/,
];
// 语音包专用排除。语音包的「代码 + 参考音频」要随包走，「权重/venv/缓存」不随包走。
// - ALWAYS：venv / pip 缓存 / 日志 / pycache / .download 模型缓存，任何档位都不带。
// - WEIGHT：可重新下载的权重（refs 不带，all 才带）。
const VOICE_ALWAYS_EXCLUDE = [
  /(^|\/)\.venv[^/]*(\/|$)/,
  /(^|\/)\.pip-cache(\/|$)/,
  /(^|\/)\.pytest_cache(\/|$)/,
  /(^|\/)__pycache__(\/|$)/,
  /(^|\/)logs(\/|$)/,
  /(^|\/)cache(\/|$)/,
  /(^|\/)\.download(\/|$)/,
  /\.log(\.\d+)?$/,
  /\.pyc$/,
];
const VOICE_WEIGHT_EXCLUDE = [
  /(^|\/)models(\/|$)/,              // 顶层 models/：piper onnx 等权重
  /pretrained_models(\/|$)/,         // GPT-SoVITS 预训练权重
  /G2PWModel(\/|$)/,                 // 拼音 G2PW 的 g2pW.onnx
  /(^|\/)nltk_data(\/|$)/,
];
const VOICE_EXCLUDE = {
  none: [/./],                        // 整目录排除 voice-packs
  refs: [...VOICE_ALWAYS_EXCLUDE, ...VOICE_WEIGHT_EXCLUDE],
  all: [...VOICE_ALWAYS_EXCLUDE],
}[VOICE];

function excluded(rel) {
  const r = rel.replace(/\\/g, '/');
  if (ALWAYS_EXCLUDE.some((re) => re.test(r))) return true;
  if (r.includes('voice-packs')) return VOICE_EXCLUDE.some((re) => re.test(r));
  return false;
}

// ── 遍历 ──
function walk(dir, baseRel) {
  const out = [];
  let stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const abs = path.join(d, e.name);
      const rel = path.join(baseRel, path.relative(dir, abs)).split(path.sep).join('/');
      if (e.isDirectory()) {
        if (excluded(rel + '/')) continue;
        stack.push(abs);
      } else if (e.isFile()) {
        if (excluded(rel)) continue;
        out.push({ abs, rel });
      }
    }
  }
  return out;
}

function sha256File(abs) {
  return new Promise((resolve) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(abs);
    s.on('data', (c) => h.update(c));
    s.on('end', () => resolve(h.digest('hex')));
    s.on('error', () => resolve(''));
  });
}

function isTextFile(abs) {
  if (fs.statSync(abs).size > 2 * 1024 * 1024) return false;
  const buf = fs.readFileSync(abs);
  if (buf.includes(0)) return false; // 有 NUL 字节就当二进制
  const s = buf.toString('utf8');
  return !s.includes('\uFFFD');
}

// 脱敏扫描：只报告「哪些文件疑似含敏感信息」，绝不打印值。
const SECRET_RE = [
  { name: 'qq', re: /\b[1-9]\d{5,10}\b/g },
  { name: 'token', re: /\b[A-Za-z0-9_-]{24,64}\b/g },
  { name: 'rkey-url', re: /rkey=[A-Za-z0-9_-]{8,}/g },
  { name: 'access-token', re: /accessToken["']?\s*[:=]\s*["'][^"']+/g },
];
function scanSecrets(abs) {
  if (!isTextFile(abs)) return [];
  const s = fs.readFileSync(abs, 'utf8');
  const kinds = [];
  for (const { name, re } of SECRET_RE) { if (re.test(s)) kinds.push(name); }
  return kinds;
}

function maskSecrets(s) {
  let t = s;
  t = t.replace(/\b[1-9]\d{5,10}\b/g, (m) => (m.length === 6 && /^19|20\d{2}/.test(m) ? m : '[REDACTED-QQ]'));
  t = t.replace(/\b[A-Za-z0-9_-]{24,64}\b/g, '[REDACTED-TOKEN]');
  t = t.replace(/rkey=[A-Za-z0-9_-]{8,}/g, 'rkey=[REDACTED]');
  return t;
}

async function copyRoots(stageRoot) {
  const jobs = [
    { src: QQ_STATE, baseRel: 'surfcore' },
    { src: SURFCORE_HOME, baseRel: 'surfcore-home' },
  ].filter((j) => fs.existsSync(j.src));
  const manifest = [];
  const redactions = [];
  let totalBytes = 0;
  for (const j of jobs) {
    for (const f of walk(j.src, j.baseRel)) {
      const dest = path.join(stageRoot, f.rel);
      if (DRY_RUN) { manifest.push({ path: f.rel, size: fs.statSync(f.abs).size, sha256: '(dry-run)' }); continue; }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      let data = fs.readFileSync(f.abs);
      const kinds = scanSecrets(f.abs);
      if (kinds.length) redactions.push({ path: f.rel, kinds });
      if (MASK && kinds.length && isTextFile(f.abs)) {
        data = Buffer.from(maskSecrets(data.toString('utf8')), 'utf8');
      }
      fs.writeFileSync(dest, data);
      const size = data.length;
      totalBytes += size;
      manifest.push({ path: f.rel, size, sha256: await sha256File(dest) });
    }
  }
  // 模板
  fs.mkdirSync(path.join(stageRoot, 'templates'), { recursive: true });
  for (const t of ['config.example.json', 'paths.example.json']) {
    const src = path.join(ROOT, t);
    if (fs.existsSync(src) && !DRY_RUN) fs.copyFileSync(src, path.join(stageRoot, 'templates', t));
  }
  // portable 脚本（自包含：新机解压即可跑 bootstrap，不必先 clone）
  fs.mkdirSync(path.join(stageRoot, 'portable'), { recursive: true });
  for (const t of ['export-port.mjs', 'bootstrap-windows.ps1', 'port-doctor.mjs']) {
    const src = path.join(ROOT, 'scripts', 'portable', t);
    if (fs.existsSync(src) && !DRY_RUN) fs.copyFileSync(src, path.join(stageRoot, 'portable', t));
  }
  return { manifest, redactions, totalBytes };
}

function gitInfo() {
  const out = {};
  for (const [k, args] of [['branch', ['rev-parse', '--abbrev-ref', 'HEAD']], ['commit', ['rev-parse', 'HEAD']], ['describe', ['describe', '--tags', '--always']]]) {
    const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
    if (r.status === 0) out[k] = r.stdout.trim();
  }
  return out;
}

async function main() {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dirName = `surfcore-port-${ts}`;
  const stageRoot = path.join(OUT, dirName);
  if (DRY_RUN) console.log(`[dry-run] 目标：${stageRoot}`);
  else fs.mkdirSync(stageRoot, { recursive: true });

  const { manifest, redactions, totalBytes } = await copyRoots(stageRoot);

  const config = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')); } catch { return {}; } })();
  const machinePaths = {
    snowluma: { homeDir: config.snowluma?.homeDir, launcherPath: config.snowluma?.launcherPath },
    voice: { ffmpegPath: config.socialV2?.voice?.ffmpegPath, dir: config.socialV2?.voice?.dir },
    asr: {
      python: config.socialV2?.voice?.asr?.python,
      script: config.socialV2?.voice?.asr?.script,
      modelDir: config.socialV2?.voice?.asr?.modelDir,
    },
  };
  const doc = {
    exportedAt: new Date().toISOString(),
    surfcore: gitInfo(),
    voiceMode: VOICE,
    masked: MASK,
    node: process.version,
    platform: `${os.platform()} ${os.release()}`,
    dshHome: DSH_HOME,
    machinePaths,
    totalFiles: manifest.length,
    totalBytes,
    redactions,
    files: manifest,
  };
  const manifestPath = path.join(stageRoot, 'manifest.json');
  if (!DRY_RUN) fs.writeFileSync(manifestPath, JSON.stringify(doc, null, 2));

  console.log(`\n导出完成：${stageRoot}`);
  console.log(`  文件 ${manifest.length} 个，共 ${(totalBytes / 1024 / 1024).toFixed(1)} MB`);
  console.log(`  疑似含敏感信息 ${redactions.length} 处${MASK ? '（已按 --mask 打码）' : '（未打码，见 manifest.redactions）'}`);
  if (!NO_ZIP && !DRY_RUN) {
    const zip = stageRoot + '.zip';
    const r = spawnSync('tar', ['-a', '-c', '-f', zip, '-C', OUT, dirName], { encoding: 'utf8' });
    if (r.status === 0) console.log(`  已压缩：${zip}`);
    else console.log(`  压缩失败（${r.stderr?.trim() || 'tar 不可用'}），保留目录形态`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
