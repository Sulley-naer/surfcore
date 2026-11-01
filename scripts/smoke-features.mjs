/**
 * 线上功能冒烟测试（手工跑，不进离线回归 test-audit）。
 *
 * 前提：桥接正在运行（restart.bat 启动的那个），且 SnowLuma/QQ 已登录。
 * 覆盖：qq_run_code 管理员命令 / qq_task_run 后台任务 / qq_schedule_add|list|cancel 日程 /
 *       本地语音识别服务（8766 /health）/ qq_send_image 表情包发图 / 记忆卡文件。
 *
 * 用法：node scripts/smoke-features.mjs
 * 注意：第 5 节会真实往 QQ 私聊发一张图（assets/deepseek娘.png），介意就把该节注释掉。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const BASE = 'http://127.0.0.1:3100';
const key = 'private:1444736434';
const st = JSON.parse(fs.readFileSync(path.join(ROOT, 'state/social-v2.json'), 'utf8'));
const token = st.conversations[key]?.agentToken || '';
const consoleTok = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')).consoleToken || '';
const results = [];
const report = (name, ok, detail) => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); };

async function post(p, body) {
  const r = await fetch(BASE + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-agent-token': token, 'x-console-token': consoleTok },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, ...j };
}

if (!token) { console.log('NO TOKEN'); process.exit(1); }

// 1. 管理员命令
try {
  const j = await post('/api/socialV2/run-code', { key, command: 'git --version' });
  report('qq_run_code 管理员命令', j.ok === true && /git version/i.test(String(j.output || '')), `exit=${j.code} ${String(j.output || '').trim().slice(0, 50)}`);
} catch (e) { report('qq_run_code 管理员命令', false, e.message); }

// 2. 后台任务
let taskId = '';
try {
  const j = await post('/api/socialV2/task-run', { key, title: '冒烟测试任务', command: 'echo smoke-task-ok' });
  taskId = j.task?.id || '';
  report('qq_task_run 后台任务（入队）', j.ok === true && Boolean(taskId), `id=${taskId}`);
} catch (e) { report('qq_task_run 后台任务（入队）', false, e.message); }
await new Promise((r) => setTimeout(r, 4000));
try {
  const j = await post('/api/socialV2/tasks', { key });
  const rep = (j.reports || []).find((t) => t.id === taskId);
  report('qq_task_status 任务收尾', Boolean(rep) && rep.status === 'done', rep ? `status=${rep.status} ${String(rep.summary || '').slice(0, 40)}` : '未找到任务');
} catch (e) { report('qq_task_status 任务收尾', false, e.message); }

// 3. 日程
let schedId = '';
try {
  const d = new Date(Date.now() + 5 * 60 * 1000);
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const j = await post('/api/socialV2/schedule-add', { key, title: '冒烟测试日程', time: hhmm, repeat: 'none' });
  schedId = j.schedule?.id || '';
  report('qq_schedule_add 日程', j.ok === true && Boolean(schedId), `${hhmm} id=${schedId}`);
} catch (e) { report('qq_schedule_add 日程', false, e.message); }
try {
  const j = await post('/api/socialV2/schedules', { key });
  report('qq_schedule_list 日程列表', j.ok === true, `pending=${(j.pending || []).length}`);
} catch (e) { report('qq_schedule_list 日程列表', false, e.message); }
try {
  const j = await post('/api/socialV2/schedule-cancel', { key, scheduleId: schedId });
  report('qq_schedule_cancel 撤销日程', j.ok === true, j.error || '');
} catch (e) { report('qq_schedule_cancel 撤销日程', false, e.message); }

// 4. 语音识别服务
try {
  const r = await fetch('http://127.0.0.1:8766/health', { signal: AbortSignal.timeout(5000) });
  const j = await r.json();
  report('语音识别 STT 服务', r.ok && j.ok !== false, JSON.stringify(j).slice(0, 70));
} catch (e) { report('语音识别 STT 服务', false, String(e.message).slice(0, 80)); }

// 5. 表情包发图
try {
  const img = path.join(ROOT, 'assets', 'deepseek娘.png');
  const j = await post('/api/socialV2/send-image', { key, image: img, caption: '冒烟测试：表情包发图' });
  report('qq_send_image 发图', j.ok === true, j.error || `bytes=${j.bytes ?? '?'}`);
} catch (e) { report('qq_send_image 发图', false, e.message); }

// 6. 记忆卡（char 级 memory 目录：~/.dsh/surfcore/characters/<charId>/memory/memory-card.json）
try {
  const base = path.join(process.env.USERPROFILE || '', '.dsh', 'surfcore', 'characters');
  let best = null;
  for (const c of fs.readdirSync(base)) {
    const f = path.join(base, c, 'memory', 'memory-card.json');
    if (!fs.existsSync(f)) continue;
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    const n = (j.records || []).length;
    if (!best || n > best.n) best = { char: c, n, updatedAt: j.updatedAt };
  }
  report('记忆卡 memory-card', Boolean(best) && best.n > 0, best ? `${best.char}: ${best.n} 条（更新于 ${String(best.updatedAt || '').slice(0, 19)}）` : '未找到');
} catch (e) { report('记忆卡 memory-card', false, e.message); }

const ok = results.filter((r) => r.ok).length;
console.log(`\nRESULT ${ok}/${results.length}`);
process.exit(ok === results.length ? 0 : 1);
