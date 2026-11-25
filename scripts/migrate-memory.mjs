// 一次性迁移：SurfCore 记忆卡 + dsh-world 归档 → elysia-memory.sqlite
// 用法：
//   node scripts/migrate-memory.mjs --dry-run          # 只数数
//   node scripts/migrate-memory.mjs                    # 真写
//   node scripts/migrate-memory.mjs --world <dir>      # 指定 world 目录（默认 ~/.dsh/worlds/default）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openMemory, appendEvent, upsertCard, stats, closeMemory, dayOf } from '../src/memory-store.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const worldArg = args.indexOf('--world');
const WORLD = worldArg >= 0 ? path.resolve(args[worldArg + 1]) : path.join(os.homedir(), '.dsh', 'worlds', 'default');
const DB_FILE = path.join(ROOT, 'state', 'memory', 'elysia-memory.sqlite');

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, 'utf-8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      /* 坏行跳过 */
    }
  }
  return out;
}

function findCharacterMemoryDir() {
  const base = path.join(os.homedir(), '.dsh', 'surfcore', 'characters');
  if (!fs.existsSync(base)) return null;
  const cur = path.join(base, 'current.json');
  let id = null;
  try {
    id = JSON.parse(fs.readFileSync(cur, 'utf-8')).id;
  } catch {
    /* ignore */
  }
  const candidates = id ? [path.join(base, id, 'memory')] : [];
  for (const name of fs.readdirSync(base)) candidates.push(path.join(base, name, 'memory'));
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'memory-card-full.jsonl'))) return dir;
  }
  return null;
}

function main() {
  const memDir = findCharacterMemoryDir();
  const cardRows = memDir ? readJsonl(path.join(memDir, 'memory-card-full.jsonl')) : [];
  const convDir = path.join(WORLD, 'conversations');
  const convRows = fs.existsSync(convDir)
    ? fs.readdirSync(convDir).filter((f) => f.endsWith('.jsonl')).sort().flatMap((f) => readJsonl(path.join(convDir, f)))
    : [];
  const diaryFiles = fs.existsSync(path.join(WORLD, 'diary'))
    ? fs.readdirSync(path.join(WORLD, 'diary')).filter((f) => f.endsWith('.md'))
    : [];
  const wikiDir = path.join(WORLD, 'room', '认识');
  const wikiFiles = fs.existsSync(wikiDir) ? fs.readdirSync(wikiDir).filter((f) => f.endsWith('.md')) : [];

  console.log('记忆卡目录:', memDir ?? '(未找到)');
  console.log('world 目录 :', WORLD, fs.existsSync(WORLD) ? '' : '(不存在)');
  console.log(`卡片 ${cardRows.length} 条 / world 对话 ${convRows.length} 行 / 日记 ${diaryFiles.length} 篇 / 认识 ${wikiFiles.length} 页`);

  if (dryRun) {
    const sample = cardRows[0] ?? convRows[0] ?? null;
    console.log('样例:', JSON.stringify(sample)?.slice(0, 300));
    console.log('dry-run：不写库。目标', DB_FILE);
    return;
  }

  const db = openMemory(DB_FILE);
  let cards = 0;
  for (const row of cardRows) {
    const ts = Date.parse(row.createdAt ?? row.lastSeenAt ?? '') || Date.now();
    upsertCard(db, {
      id: String(row.id ?? `card-${cards}`),
      kind: row.kind === 'owner' ? 'event' : String(row.kind ?? 'fact'),
      title: row.title ?? '',
      body: row.text ?? row.detail ?? '',
      tags: row.tags ?? [],
      importance: Number(row.importance) || 50,
      emotional: Number(row.emotional) || 0,
      clarity: Number(row.clarity) || 0.5,
      firstSeen: ts,
      lastSeen: Date.parse(row.lastSeenAt ?? '') || ts,
      refs: { source: row.source, platform: row.platform, conversationKey: row.conversationKey, botReply: row.botReply ?? null },
    });
    cards += 1;
  }

  let events = 0;
  for (const row of convRows) {
    const ts = Date.parse(row.occurredAt ?? '') || Date.now();
    appendEvent(db, {
      ts,
      day: row.day || dayOf(ts),
      channel: row.channel || 'world',
      convKey: row.conversationId || row.sourceSessionId || null,
      role: row.role === 'assistant' ? 'self' : 'owner',
      speaker: row.speakerName || null,
      text: row.content || row.text || '',
      meta: { source: 'world-archive', recordId: row.recordId, turnId: row.turnId },
    });
    events += 1;
  }

  for (const f of diaryFiles) {
    const body = fs.readFileSync(path.join(WORLD, 'diary', f), 'utf-8');
    upsertCard(db, {
      id: `world-diary-${f.replace(/\.md$/, '')}`,
      kind: 'world-archive',
      title: f,
      body,
      tags: ['diary', 'world'],
      importance: 40,
    });
  }

  for (const f of wikiFiles) {
    if (f === '目录.md') continue;
    const body = fs.readFileSync(path.join(WORLD, 'room', '认识', f), 'utf-8');
    upsertCard(db, {
      id: `world-wiki-${f.replace(/\.md$/, '')}`,
      kind: 'world-archive',
      title: f,
      body,
      tags: ['wiki', 'world'],
      importance: 45,
    });
  }

  console.log(`写入完成：卡片 ${cards} / 事件 ${events} / 日记 ${diaryFiles.length} / 认识 ${wikiFiles.length}`);
  console.log('库统计:', stats(db));
  closeMemory(db);
}

main();
