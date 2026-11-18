// 迁移后体检：对照导出包/目标机检查 SurfCore 数据与运行时是否齐全。
// 用法：node scripts/portable/port-doctor.mjs [--json]
// 退出码：0 全绿；1 有 FAIL（阻断级缺失）；2 有 WARN（建议处理）。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const HOME = process.env.USERPROFILE || os.homedir();
const DSH_HOME = process.env.DSH_HOME || path.join(HOME, '.dsh');
const SURFCORE_HOME = path.join(DSH_HOME, 'surfcore');
const JSON_MODE = process.argv.includes('--json');

const results = [];
function add(level, check, detail = '') { results.push({ level, check, detail }); }
const exists = (p) => { try { return fs.existsSync(p); } catch { return false; } };
function check(cond, level, check, detail = '') { add(cond ? 'pass' : level, check, detail); }

// 1. 代码仓与依赖
check(exists(ROOT) && exists(path.join(ROOT, 'package.json')), exists(ROOT) ? 'pass' : 'fail', '代码仓 package.json', ROOT);
check(exists(path.join(ROOT, 'node_modules')), 'warn', 'node_modules 已安装', '若缺：npm install');
check(exists(path.join(ROOT, 'config.json')), 'fail', 'repo/config.json', '从 templates/config.example.json 复制并填密钥');
check(exists(path.join(ROOT, 'paths.json')), 'warn', 'repo/paths.json', '从 templates/paths.example.json 复制并填本机路径');

// 2. 运行时数据 repo/state
for (const f of ['mode.json', 'sessions.json', 'social-v2.json', 'self-identity.json']) {
  check(exists(path.join(ROOT, 'state', f)), 'warn', `state/${f}`);
}

// 3. 合体层 ~/.dsh/surfcore
check(exists(path.join(SURFCORE_HOME, 'characters', 'index.json')), 'fail', '合体层 characters/index.json');
check(exists(path.join(SURFCORE_HOME, 'characters', 'current.json')), 'warn', '合体层 characters/current.json');
const charsDir = path.join(SURFCORE_HOME, 'characters');
let charIds = [];
try {
  charIds = fs.readdirSync(charsDir).filter((d) => d.startsWith('char-') && fs.statSync(path.join(charsDir, d)).isDirectory());
} catch {}
for (const cid of charIds) {
  check(exists(path.join(charsDir, cid, 'memory', 'memory-card.json')), 'warn', `记忆卡 ${cid}/memory/memory-card.json`);
  check(exists(path.join(charsDir, cid, 'character.json')), 'warn', `角色卡 ${cid}/character.json`);
}
if (charIds.length === 0) check(false, 'fail', '未发现任何角色目录（char-*）');

// 4. paths.json 里的路径能否落地
let paths = {};
try { paths = JSON.parse(fs.readFileSync(path.join(ROOT, 'paths.json'), 'utf8')); } catch {}
const pathChecks = [
  ['snowlumaHome', 'snowlumaHome', 'dir'],
  ['snowlumaLauncher', 'snowlumaLauncher', 'file'],
  ['ffmpeg', 'ffmpeg', 'file'],
  ['asrPython', 'asrPython', 'file'],
  ['asrScript', 'asrScript', 'file'],
  ['asrModelDir', 'asrModelDir', 'dir'],
];
for (const [name, key, kind] of pathChecks) {
  const v = paths[key];
  if (!v) continue;
  check(exists(v), 'warn', `paths.json.${key}`, v);
}

// 5. 语音包
const vp = path.join(ROOT, 'state', 'voice-packs', 'voice-local');
if (exists(vp)) {
  check(exists(path.join(vp, 'config.toml')), 'warn', '语音包 config.toml');
  check(exists(path.join(vp, 'voicepack')), 'warn', '语音包参考音频 voicepack/');
  for (const v of ['.venv', '.venv-gsv']) {
    check(exists(path.join(vp, v, 'Scripts', 'python.exe')), 'warn', `语音包 ${v}`, '若缺：python -m venv + pip install -r requirements*.txt');
  }
  check(exists(path.join(vp, 'vendor', 'GPT-SoVITS', 'code', 'GPT_SoVITS', 'pretrained_models')), 'warn', 'GPT-SoVITS 预训练权重', '若缺：重新下载到 vendor/.../pretrained_models');
} else {
  add('info', '语音包 voice-local 不存在（--voice none 迁移）', '');
}

// 6. 本地 ASR
const asrScript = paths.asrScript || path.join('E:', 'DeepSeeK', 'faster-whisper', 'transcribe.py');
const asrDir = path.dirname(asrScript);
check(exists(asrScript), 'warn', 'ASR transcribe.py', asrScript);
check(exists(path.join(asrDir, 'stt_server.py')), 'warn', 'ASR stt_server.py');
check(exists(path.join(asrDir, 'models', 'small', 'model.bin')), 'warn', 'ASR 模型 model.bin', '若缺：hf-mirror 下载 Systran/faster-whisper-small');

// 7. SnowLuma
const slHome = paths.snowlumaHome;
if (slHome) {
  check(exists(slHome), 'warn', 'SnowLuma homeDir', slHome);
  check(exists(path.join(slHome, 'config')), 'warn', 'SnowLuma config/（onebot_*.json 含 WS token）');
} else add('info', 'paths.json 未填 snowlumaHome，跳过 SnowLuma 检查', '');

// 8. 新功能运行时（see-now / phone 通道 / 隧道）
const RUNTIMES = process.env.SURFCORE_RUNTIMES || path.join('D:', 'surfcore', 'runtimes');
check(exists(RUNTIMES), 'warn', 'runtimes 目录', RUNTIMES);
check(exists(path.join(RUNTIMES, 'see-now-voice-adapter.mjs')), 'warn', 'see-now voice adapter');
check(exists(path.join(RUNTIMES, 'start-cloudflared.ps1')), 'warn', 'cloudflared 启动脚本', '隧道自启用');
for (const f of ['voice.json', 'asr.json', 'see-window.json']) {
  check(exists(path.join(DSH_HOME, f)), 'warn', `~/.dsh/${f}`, '从旧机导出包 dsh-home/ 恢复');
}
const cfCfg = path.join(HOME, '.cloudflared', 'config.yml');
check(exists(cfCfg), 'warn', '~/.cloudflared/config.yml', '公网隧道；凭据 JSON 需 tunnel login 重建');

// 计划任务（登录自启）
try {
  const out = execFileSync('schtasks', ['/query', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true });
  for (const name of ['SurfCoreCloudflared', 'SurfCoreVoiceLocal']) {
    check(out.includes(name), 'warn', `计划任务 ${name}`, '若缺：重跑 bootstrap 或手动 Register-ScheduledTask');
  }
} catch { add('info', 'schetasks 查询失败，跳过计划任务检查', ''); }

// phone 通道端口
try {
  const nl = execFileSync('cmd', ['/c', 'netstat -ano | findstr :8787'], { encoding: 'utf8', windowsHide: true });
  check(/LISTENING/i.test(nl), 'warn', '手机通道 8787 监听', '若缺：重启桥接后应自动监听');
} catch { check(false, 'warn', '手机通道 8787 监听', '未监听（桥接没起或端口被占）'); }

// 输出
const fails = results.filter((r) => r.level === 'fail');
const warns = results.filter((r) => r.level === 'warn');
const passes = results.filter((r) => r.level === 'pass');
const info = results.filter((r) => r.level === 'info');

if (JSON_MODE) { console.log(JSON.stringify(results, null, 2)); }
else {
  for (const r of results) {
    const [icon, col] = r.level === 'fail' ? ['✗', '[FAIL]'] : r.level === 'warn' ? ['△', '[WARN]'] : r.level === 'pass' ? ['✓', '[pass]'] : ['·', '[info]'];
    console.log(`${icon} ${col} ${r.check}${r.detail ? '  → ' + r.detail : ''}`);
  }
  console.log(`\n结果：PASS ${passes.length} · WARN ${warns.length} · FAIL ${fails.length}`);
}
process.exit(fails.length ? 1 : warns.length ? 2 : 0);
