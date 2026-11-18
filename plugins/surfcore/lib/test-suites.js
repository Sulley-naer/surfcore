/**
 * 自检套件清单（声明式）。
 *
 * 设计目标：**测试要写在配置里，而不是散在脚本命令里**。
 *   · 默认清单 = 本文件内置（跟着 repo 走，升级不会丢）；
 *   · 用户清单 = ~/.dsh/surfcore/test-suites.json（可覆盖 enabled/timeout/args，
 *     可以新增自己的套件，也可以 `{"id":"x","remove":true}` 摘掉某个）；
 *   · 合并规则：按 id 覆盖，内置顺序保底。
 *
 * 套件只描述「怎么跑一条命令」，怎么调度、怎么留档在 test-runner.js。
 */
import fs from 'node:fs';
import path from 'node:path';
import { QQBOT_ROOT, STATE_DIR, findNodeExe } from './paths.js';

export const USER_SUITES_FILE = path.join(STATE_DIR, 'test-suites.json');
export const TEST_RUNS_DIR = path.join(STATE_DIR, 'test-runs');

const NODE = () => {
  try { return findNodeExe() || process.execPath; } catch { return process.execPath; }
};

/** 内置套件：id 稳定，日志/报告按 id 索引。 */
export const BUILTIN_SUITES = [
  {
    id: 'smoke',
    title: '功能冒烟（桥接在线时跑）',
    args: ['scripts/smoke-features.mjs'],
    tags: ['smoke', 'e2e'],
    timeoutMs: 300000,
    requires: 'bridge',
    note: '真发一张图到 QQ 私聊，会消耗通道；确认主人不在睡觉时再跑。',
  },
  {
    id: 'audit',
    title: '离线回归全量（test-audit）',
    args: ['scripts/test-audit.mjs'],
    tags: ['audit'],
    timeoutMs: 900000,
  },
  { id: 'voice-asr', title: '语音转写单测', args: ['scripts/test-voice-asr.mjs'], tags: ['unit'], timeoutMs: 120000 },
  { id: 'qq-exec', title: '受控命令执行单测', args: ['scripts/test-qq-exec.mjs'], tags: ['unit'], timeoutMs: 120000 },
  { id: 'owner-tasks', title: '后台任务队列单测', args: ['scripts/test-owner-tasks.mjs'], tags: ['unit'], timeoutMs: 120000 },
  { id: 'schedules', title: '日程/定时器单测', args: ['scripts/test-schedules.mjs'], tags: ['unit'], timeoutMs: 120000 },
  { id: 'phone-wake', title: '手机唤醒通道单测', args: ['scripts/test-phone-wake.mjs'], tags: ['unit'], timeoutMs: 120000 },
  {
    id: 'portable-doctor',
    title: '迁移体检（port-doctor）',
    args: ['scripts/portable/port-doctor.mjs'],
    tags: ['ops'],
    timeoutMs: 180000,
  },
];

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function normalizeSuite(raw, base) {
  const id = String(raw?.id ?? base?.id ?? '').trim();
  if (!id) return null;
  const args = Array.isArray(raw?.args) && raw.args.length
    ? raw.args.map(String)
    : base?.args ?? [];
  if (!args.length) return null;
  return {
    id,
    title: String(raw?.title ?? base?.title ?? id),
    args,
    cwd: String(raw?.cwd ?? base?.cwd ?? QQBOT_ROOT),
    env: { ...(base?.env ?? {}), ...(raw?.env && typeof raw.env === 'object' ? raw.env : {}) },
    tags: Array.isArray(raw?.tags) ? raw.tags.map(String) : base?.tags ?? ['custom'],
    timeoutMs: Math.max(5000, Number(raw?.timeoutMs ?? base?.timeoutMs ?? 300000) || 300000),
    enabled: raw?.enabled !== undefined ? Boolean(raw.enabled) : base?.enabled !== false,
    requires: String(raw?.requires ?? base?.requires ?? ''),
    note: String(raw?.note ?? base?.note ?? ''),
  };
}

/**
 * 合并后的套件表。
 * @returns {{suites: Array, source: {builtin: number, user: number}, file: string}}
 */
export function loadTestSuites({ file = USER_SUITES_FILE } = {}) {
  const byId = new Map();
  for (const suite of BUILTIN_SUITES) {
    const normalized = normalizeSuite(suite, null);
    if (normalized) byId.set(normalized.id, normalized);
  }
  const user = readJson(file, null);
  let userCount = 0;
  const removals = [];
  if (Array.isArray(user?.suites)) {
    for (const raw of user.suites) {
      const id = String(raw?.id ?? '').trim();
      if (!id) continue;
      if (raw?.remove === true) { removals.push(id); continue; }
      const normalized = normalizeSuite(raw, byId.get(id) ?? null);
      if (normalized) { byId.set(normalized.id, normalized); userCount += 1; }
    }
  }
  for (const id of removals) byId.delete(id);
  return {
    suites: [...byId.values()],
    source: { builtin: BUILTIN_SUITES.length, user: userCount },
    file,
  };
}

/** 写一个可编辑的用户套件模板（不存在才写，避免覆盖手改）。 */
export function ensureUserSuitesTemplate({ file = USER_SUITES_FILE } = {}) {
  if (fs.existsSync(file)) return false;
  const template = {
    $comment: '自定义/覆盖自检套件。args 里的脚本路径相对 QQBOT_ROOT（repo 根）。remove:true 可摘掉内置套件。',
    schedule: { enabled: false, intervalMinutes: 0, tags: ['unit'], onStart: false },
    suites: [
      { id: 'smoke', enabled: false, note: '默认关：要真发一张图到 QQ 私聊时才打开。' },
      { id: 'portable-doctor', enabled: true },
    ],
  };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(template, null, 2), 'utf8');
    return true;
  } catch {
    return false;
  }
}

/** 套件要用的 node 可执行文件（自检子进程统一用它）。 */
export function resolveNodeExe() {
  return NODE();
}

/**
 * 定时自检配置（同样写在 ~/.dsh/surfcore/test-suites.json 的 `schedule` 段）：
 *   { "enabled": true, "intervalMinutes": 60, "tags": ["unit"], "onStart": true }
 * intervalMinutes=0 表示只 onStart、不定时。
 */
export function readSuiteSchedule({ file = USER_SUITES_FILE } = {}) {
  const user = readJson(file, null);
  const raw = user?.schedule && typeof user.schedule === 'object' ? user.schedule : {};
  const minutes = Math.max(0, Math.min(24 * 60, Math.round(Number(raw.intervalMinutes) || 0)));
  return {
    enabled: raw.enabled !== false && (minutes > 0 || raw.onStart === true),
    intervalMinutes: minutes,
    tags: Array.isArray(raw.tags) && raw.tags.length ? raw.tags.map(String) : ['unit'],
    onStart: raw.onStart === true,
  };
}
