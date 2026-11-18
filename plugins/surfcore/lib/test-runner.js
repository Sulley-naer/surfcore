/**
 * 自检执行器（插件内）。
 *
 * 为什么放在 DSH 插件里而不是再写一个脚本：
 *   · 测试清单落在配置里（见 test-suites.js），改配置就能增删套件，不用改代码；
 *   · 结果留档到 ~/.dsh/surfcore/test-runs/<runId>.json，DSH 里能直接看历史；
 *   · 一次只跑一个 run，避免两条全量回归把机器压死。
 *
 * 只做「串行跑命令 + 留档」，不解析测试内部语义：退出码 0 即 pass。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { TEST_RUNS_DIR, loadTestSuites, resolveNodeExe } from './test-suites.js';

const MAX_TAIL_LINES = 400;
const MAX_RUNS_KEPT = 30;
// 最近一次失败的标记文件：设置页轮询它来弹提示（插件无法主动推 toast 给已关闭的页面）。
const LAST_FAILURE_FILE = path.join(TEST_RUNS_DIR, 'last-failure.json');

let currentRun = null;

function nowIso() { return new Date().toISOString(); }

function tailLines(text, limit = MAX_TAIL_LINES) {
  const lines = String(text ?? '').split(/\r?\n/);
  return lines.length <= limit ? lines.join('\n') : lines.slice(-limit).join('\n');
}

function ensureRunsDir() {
  try { fs.mkdirSync(TEST_RUNS_DIR, { recursive: true }); } catch {}
}

function persist(run) {
  ensureRunsDir();
  const file = path.join(TEST_RUNS_DIR, `${run.id}.json`);
  try { fs.writeFileSync(file, JSON.stringify(run, null, 2), 'utf8'); } catch {}
  run.file = file;
  return file;
}

/** 记下最近一次失败（供设置页提示），成功时清空。 */
function writeFailureMarker(run) {
  ensureRunsDir();
  try {
    const failed = (run.suites ?? []).filter((s) => s.status !== 'pass');
    if (!failed.length) {
      if (fs.existsSync(LAST_FAILURE_FILE)) fs.unlinkSync(LAST_FAILURE_FILE);
      return;
    }
    const payload = {
      runId: run.id,
      finishedAt: run.finishedAt,
      summary: run.summary,
      suites: failed.map((s) => ({ id: s.id, status: s.status, exitCode: s.exitCode ?? null })),
    };
    fs.writeFileSync(LAST_FAILURE_FILE, JSON.stringify(payload, null, 2), 'utf8');
  } catch {}
}

/** 读最近一次失败标记（没有返回 null）。 */
export function readLastFailure() {
  try {
    const raw = fs.readFileSync(LAST_FAILURE_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function pruneOldRuns() {
  try {
    const files = fs.readdirSync(TEST_RUNS_DIR)
      .filter((name) => name.endsWith('.json'))
      .map((name) => ({ name, at: fs.statSync(path.join(TEST_RUNS_DIR, name)).mtimeMs }))
      .sort((a, b) => b.at - a.at);
    for (const file of files.slice(MAX_RUNS_KEPT)) {
      try { fs.unlinkSync(path.join(TEST_RUNS_DIR, file.name)); } catch {}
    }
  } catch {}
}

function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
      process.kill(-pid, 'SIGKILL');
    }
  } catch {
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }
}

function runOneSuite(suite) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const nodeExe = resolveNodeExe();
    const child = spawn(nodeExe, suite.args, {
      cwd: suite.cwd || process.cwd(),
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', ...(suite.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const append = (buf) => {
      out += String(buf);
      if (out.length > 4 * 1024 * 1024) out = out.slice(-2 * 1024 * 1024);
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, suite.timeoutMs);
    const finish = (code, error) => {
      clearTimeout(timer);
      resolve({
        id: suite.id,
        title: suite.title,
        status: timedOut ? 'timeout' : (code === 0 ? 'pass' : 'fail'),
        exitCode: code ?? null,
        durationMs: Date.now() - startedAt,
        tail: tailLines(out),
        error: error ? String(error?.message ?? error) : '',
      });
    };
    child.on('error', (error) => finish(null, error));
    child.on('close', (code) => finish(code));
  });
}

/** 选要跑的套件：ids 优先，其次 tags，默认跑所有 enabled 的。 */
export function selectSuites({ ids = [], tags = [] } = {}) {
  const { suites } = loadTestSuites();
  let picked = suites;
  if (Array.isArray(ids) && ids.length) {
    const wanted = new Set(ids.map(String));
    picked = suites.filter((suite) => wanted.has(suite.id));
  } else if (Array.isArray(tags) && tags.length) {
    const wanted = new Set(tags.map(String));
    picked = suites.filter((suite) => suite.tags.some((tag) => wanted.has(tag)));
  } else {
    picked = suites.filter((suite) => suite.enabled !== false);
  }
  return picked;
}

export function getCurrentRun() {
  return currentRun ? { ...currentRun, suites: currentRun.suites.map((s) => ({ ...s })) } : null;
}

export function isRunning() {
  return Boolean(currentRun);
}

/**
 * 启动一次自检（后台串行执行，立即返回 runId）。
 * @returns {{ok: boolean, runId?: string, error?: string, suites?: string[]}}
 */
export function startRun({ ids = [], tags = [] } = {}) {
  if (currentRun) return { ok: false, error: `已有自检在跑：${currentRun.id}`, code: 'busy' };
  const chosen = selectSuites({ ids, tags });
  if (!chosen.length) return { ok: false, error: '没有选到套件（检查 test-suites.json 的 enabled/ids）', code: 'empty' };
  const id = `run-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const run = {
    id,
    startedAt: nowIso(),
    finishedAt: '',
    status: 'running',
    suites: chosen.map((suite) => ({
      id: suite.id, title: suite.title, status: 'pending', exitCode: null, durationMs: 0, tail: '', error: '',
    })),
    summary: { total: chosen.length, pass: 0, fail: 0, timeout: 0 },
  };
  currentRun = run;
  persist(run);

  (async () => {
    for (let index = 0; index < chosen.length; index += 1) {
      const suite = chosen[index];
      run.suites[index].status = 'running';
      persist(run);
      const result = await runOneSuite(suite);
      run.suites[index] = result;
      if (result.status === 'pass') run.summary.pass += 1;
      else if (result.status === 'timeout') { run.summary.timeout += 1; run.summary.fail += 1; } else run.summary.fail += 1;
      persist(run);
    }
    run.finishedAt = nowIso();
    run.status = run.summary.fail ? 'fail' : 'pass';
    persist(run);
    writeFailureMarker(run);
    pruneOldRuns();
    currentRun = null;
  })().catch((error) => {
    if (currentRun) {
      currentRun.status = 'error';
      currentRun.finishedAt = nowIso();
      currentRun.error = String(error?.message ?? error);
      persist(currentRun);
      writeFailureMarker(currentRun);
    }
    currentRun = null;
  });

  return { ok: true, runId: id, suites: chosen.map((suite) => suite.id) };
}

/** 列出历史 run（按时间倒序，轻量摘要）。 */
export function listRuns(limit = 10) {
  ensureRunsDir();
  try {
    return fs.readdirSync(TEST_RUNS_DIR)
      .filter((name) => name.endsWith('.json'))
      .map((name) => {
        const file = path.join(TEST_RUNS_DIR, name);
        const stat = fs.statSync(file);
        let summary = null;
        let status = 'unknown';
        try {
          const data = JSON.parse(fs.readFileSync(file, 'utf8'));
          summary = data.summary ?? null;
          status = data.status ?? 'unknown';
        } catch {}
        return { id: name.replace(/\.json$/, ''), at: stat.mtimeMs, status, summary };
      })
      .sort((a, b) => b.at - a.at)
      .slice(0, Math.max(1, Number(limit) || 10));
  } catch {
    return [];
  }
}

export function getRun(runId) {
  const safe = String(runId ?? '').replace(/[^A-Za-z0-9._-]/g, '');
  if (!safe) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(TEST_RUNS_DIR, `${safe}.json`), 'utf8'));
  } catch {
    return null;
  }
}

// ── 定时自检（配置在 test-suites.json 的 schedule 段）──────────────────────
let scheduleTimer = null;

export function schedulerStatus() {
  return { running: Boolean(scheduleTimer) };
}

export function stopScheduler() {
  if (scheduleTimer) { clearTimeout(scheduleTimer); scheduleTimer = null; }
}

/**
 * 按配置起定时自检。intervalMinutes>0 时循环跑；onStart=true 时启动先跑一次。
 * 用 setTimeout 递归而不是 setInterval：上一轮没跑完时不会叠加。
 */
export function startScheduler({ intervalMinutes = 0, tags = ['unit'], onStart = false } = {}) {
  stopScheduler();
  const minutes = Math.max(0, Number(intervalMinutes) || 0);
  const fire = () => {
    if (!currentRun) { try { startRun({ tags }); } catch {} }
    if (minutes > 0) {
      scheduleTimer = setTimeout(fire, minutes * 60000);
      try { scheduleTimer.unref?.(); } catch {}
    }
  };
  if (minutes > 0) {
    scheduleTimer = setTimeout(fire, minutes * 60000);
    try { scheduleTimer.unref?.(); } catch {}
  }
  if (onStart) setTimeout(fire, 15000); // 启动 15 秒后再跑，避开 DSH 启动高峰
  return { intervalMinutes: minutes, tags, onStart };
}

