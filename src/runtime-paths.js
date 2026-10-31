// 运行时路径解析：把 config.json 里那些「这台机器上的绝对路径」抽出来，
// 让跨设备迁移只需要改 paths.json（仓库根，gitignored）或设环境变量，
// 不用动 config.json（那里面还有一堆密钥/白名单，迁移时不该整份覆盖）。
//
// 优先级（高 → 低）：
//   环境变量  >  paths.json  >  config.json 现有值  >  默认值/空
//
// paths.json 的键见 PATH_KEYS，示例见 paths.example.json。
import fs from 'node:fs';
import path from 'node:path';

export const PATH_KEYS = Object.freeze([
  'snowlumaHome',       // SnowLuma 主目录（config/ 的上一级，onebot_*.json 所在）
  'snowlumaLauncher',   // SnowLuma 启动器（launcherPath）
  'ffmpeg',             // ffmpeg 可执行文件
  'voiceDir',           // 语音包根目录（socialV2.voice.dir）
  'asrPython',          // faster-whisper venv 的 python.exe
  'asrScript',          // transcribe.py
  'asrModelDir',        // faster-whisper 模型目录
  'asrServerPython',    // stt_server.py 用的 python（常驻服务）
  'asrServerScript',    // stt_server.py
]);

export const PATH_ENV = Object.freeze({
  snowlumaHome: 'SURFCORE_SNOWLUMA_HOME',
  snowlumaLauncher: 'SURFCORE_SNOWLUMA_LAUNCHER',
  ffmpeg: 'SURFCORE_FFMPEG',
  voiceDir: 'SURFCORE_VOICE_DIR',
  asrPython: 'SURFCORE_ASR_PYTHON',
  asrScript: 'SURFCORE_ASR_SCRIPT',
  asrModelDir: 'SURFCORE_ASR_MODEL_DIR',
  asrServerPython: 'SURFCORE_ASR_SERVER_PYTHON',
  asrServerScript: 'SURFCORE_ASR_SERVER_SCRIPT',
});

/**
 * 读 paths.json（或 SURFCORE_PATHS 指向的文件）。读不到/读坏都回退成 {}，绝不抛。
 */
export function readPathsFile(root = process.cwd()) {
  const candidates = [process.env.SURFCORE_PATHS, path.join(root, 'paths.json')].filter(Boolean);
  for (const file of candidates) {
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const j = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
      if (j && typeof j === 'object' && !Array.isArray(j)) return j;
    } catch {
      // 忽略，试下一个
    }
  }
  return {};
}

/** 相对路径按仓库根解析成绝对路径；已经是绝对路径/空则原样。 */
export function resolveAgainst(value, root) {
  const s = String(value ?? '').trim();
  if (!s) return '';
  return path.isAbsolute(s) ? s : path.resolve(root, s);
}

/**
 * 取某一个运行时路径的最终值。name ∈ PATH_KEYS。
 */
export function runtimePath(name, { cfgValue = '', root = process.cwd(), fallback = '' } = {}) {
  const envKey = PATH_ENV[name];
  if (envKey && String(process.env[envKey] ?? '').trim()) {
    return resolveAgainst(process.env[envKey], root);
  }
  const paths = readPathsFile(root);
  if (paths && paths[name] != null && String(paths[name]).trim()) {
    return resolveAgainst(paths[name], root);
  }
  if (cfgValue != null && String(cfgValue).trim()) return String(cfgValue).trim();
  if (fallback) return resolveAgainst(fallback, root);
  return '';
}

/**
 * 把 paths.json / 环境变量里的运行时路径覆盖到已加载的 cfg 上（原地改）。
 * 只在「有更优来源」时才覆盖，否则保留 config.json 原值 —— 因此 paths.json
 * 不存在时对现有行为零影响。
 */
export function applyRuntimePaths(cfg, root = process.cwd()) {
  if (!cfg || typeof cfg !== 'object') return cfg;
  const paths = readPathsFile(root);
  const pick = (name) => {
    const envKey = PATH_ENV[name];
    if (envKey && String(process.env[envKey] ?? '').trim()) return resolveAgainst(process.env[envKey], root);
    if (paths[name] != null && String(paths[name]).trim()) return resolveAgainst(paths[name], root);
    return null;
  };

  const sl = cfg.snowluma || (cfg.snowluma = {});
  const home = pick('snowlumaHome');
  if (home) sl.homeDir = home;
  const launcher = pick('snowlumaLauncher');
  if (launcher) sl.launcherPath = launcher;

  if (!cfg.socialV2) cfg.socialV2 = {};
  if (!cfg.socialV2.voice) cfg.socialV2.voice = {};
  const voice = cfg.socialV2.voice;
  const ffmpeg = pick('ffmpeg');
  if (ffmpeg) voice.ffmpegPath = ffmpeg;
  const voiceDir = pick('voiceDir');
  if (voiceDir) voice.dir = voiceDir;

  if (!voice.asr) voice.asr = {};
  const asr = voice.asr;
  const ap = pick('asrPython'); if (ap) asr.python = ap;
  const as = pick('asrScript'); if (as) asr.script = as;
  const am = pick('asrModelDir'); if (am) asr.modelDir = am;
  const asp = pick('asrServerPython'); if (asp) asr.serverPython = asp;
  const ass = pick('asrServerScript'); if (ass) asr.serverScript = ass;

  return cfg;
}
