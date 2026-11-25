// 全量记忆底座：原文永不删，卡片只做权重。
// 依赖 node:sqlite（Node >= 22.5，含 FTS5）。
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export const MEMORY_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  day TEXT NOT NULL,
  channel TEXT NOT NULL,
  conv_key TEXT,
  role TEXT NOT NULL,
  speaker TEXT,
  text TEXT NOT NULL,
  meta TEXT
);
CREATE INDEX IF NOT EXISTS events_day ON events(day);
CREATE INDEX IF NOT EXISTS events_conv ON events(conv_key, id);
CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
  text, content='events', content_rowid='id', tokenize='trigram'
);
CREATE TRIGGER IF NOT EXISTS events_ai AFTER INSERT ON events BEGIN
  INSERT INTO events_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS events_ad AFTER DELETE ON events BEGIN
  INSERT INTO events_fts(events_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;

CREATE TABLE IF NOT EXISTS cards (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  title TEXT,
  body TEXT NOT NULL,
  tags TEXT,
  importance INTEGER DEFAULT 50,
  emotional REAL DEFAULT 0,
  clarity REAL DEFAULT 0.5,
  first_seen INTEGER,
  last_seen INTEGER,
  refs TEXT
);
CREATE INDEX IF NOT EXISTS cards_kind ON cards(kind);

CREATE TABLE IF NOT EXISTS days (
  day TEXT PRIMARY KEY,
  summary TEXT,
  events INTEGER DEFAULT 0,
  tokens INTEGER DEFAULT 0,
  updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
`;

export function dayOf(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function openMemory(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL');
  db.exec(SCHEMA);
  return db;
}

export function appendEvent(db, e) {
  const ts = Number(e.ts ?? Date.now());
  const day = e.day ?? dayOf(ts);
  const info = db
    .prepare(
      `INSERT INTO events (ts, day, channel, conv_key, role, speaker, text, meta)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      ts,
      day,
      String(e.channel ?? 'unknown'),
      e.convKey == null ? null : String(e.convKey),
      String(e.role ?? 'owner'),
      e.speaker == null ? null : String(e.speaker),
      String(e.text ?? ''),
      e.meta ? JSON.stringify(e.meta) : null,
    );
  const id = Number(info.lastInsertRowid);
  db.prepare(
    `INSERT INTO days (day, events, updated_at) VALUES (?, 1, ?)
     ON CONFLICT(day) DO UPDATE SET events = events + 1, updated_at = excluded.updated_at`,
  ).run(day, Date.now());
  return id;
}

/** 查询：>=3 字走 FTS5 trigram，短词退回 LIKE（中文两字词常见）。 */
export function searchEvents(db, query, limit = 8) {
  const q = String(query ?? '').trim();
  if (!q) return [];
  const n = Math.max(1, Math.min(50, Number(limit) || 8));
  if ([...q].length >= 3) {
    try {
      return db
        .prepare(
          `SELECT e.id, e.ts, e.day, e.channel, e.role, e.speaker, e.text
             FROM events_fts f JOIN events e ON e.id = f.rowid
            WHERE events_fts MATCH ? ORDER BY rank LIMIT ?`,
        )
        .all(toFtsQuery(q), n);
    } catch {
      /* 落到 LIKE */
    }
  }
  const like = `%${q.replace(/[%_]/g, (m) => '\\' + m)}%`;
  return db
    .prepare(
      `SELECT id, ts, day, channel, role, speaker, text FROM events
        WHERE text LIKE ? ESCAPE '\\' ORDER BY ts DESC LIMIT ?`,
    )
    .all(like, n);
}

function toFtsQuery(q) {
  return q
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t.replace(/"/g, '""')}"`)
    .join(' AND ');
}


/** 卡片检索：标题/正文 LIKE（中文短词友好），按重要度和新旧加权。 */
export function searchCards(db, query, limit = 8) {
  const q = String(query ?? '').trim();
  if (!q) return [];
  const n = Math.max(1, Math.min(50, Number(limit) || 8));
  const safe = q.replace(/[%_]/g, ' ');
  const like = '%' + safe + '%';
  return db
    .prepare(
      `SELECT id, kind, title, body, importance, last_seen FROM cards
        WHERE body LIKE ? OR IFNULL(title,'') LIKE ?
        ORDER BY importance DESC, last_seen DESC LIMIT ?`,
    )
    .all(like, like, n);
}

/** 统一检索：事件 + 卡片一起，标注来源。 */
export function searchAll(db, query, limit = 8) {
  const half = Math.max(1, Math.ceil((Number(limit) || 8) / 2));
  const events = searchEvents(db, query, half).map((r) => ({ ...r, kind: 'event' }));
  const cards = searchCards(db, query, half).map((r) => ({
    id: `card:${r.id}`,
    ts: r.last_seen,
    day: dayOf(r.last_seen || Date.now()),
    channel: 'card',
    role: r.kind,
    speaker: null,
    text: r.body,
    kind: 'card',
  }));
  return [...events, ...cards].slice(0, Number(limit) || 8);
}

export function recentEvents(db, limit = 120) {
  return db
    .prepare(
      `SELECT id, ts, day, channel, role, speaker, text FROM events
        ORDER BY id DESC LIMIT ?`,
    )
    .all(Math.max(1, Math.min(2000, Number(limit) || 120)));
}

export function upsertCard(db, c) {
  const now = Date.now();
  db.prepare(
    `INSERT INTO cards (id, kind, title, body, tags, importance, emotional, clarity, first_seen, last_seen, refs)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       kind=excluded.kind, title=excluded.title, body=excluded.body, tags=excluded.tags,
       importance=excluded.importance, emotional=excluded.emotional, clarity=excluded.clarity,
       last_seen=excluded.last_seen, refs=excluded.refs`,
  ).run(
    String(c.id),
    String(c.kind ?? 'fact'),
    c.title == null ? null : String(c.title),
    String(c.body ?? ''),
    c.tags ? JSON.stringify(c.tags) : null,
    Number.isFinite(c.importance) ? Math.round(c.importance) : 50,
    Number.isFinite(c.emotional) ? c.emotional : 0,
    Number.isFinite(c.clarity) ? c.clarity : 0.5,
    Number(c.firstSeen ?? c.createdAt ?? now),
    Number(c.lastSeen ?? c.createdAt ?? now),
    c.refs ? JSON.stringify(c.refs) : null,
  );
}

export function getCard(db, id) {
  return db.prepare('SELECT * FROM cards WHERE id = ?').get(String(id));
}


export function getEvent(db, id) {
  return db.prepare('SELECT * FROM events WHERE id = ?').get(Number(id));
}

export function listCards(db, kind, limit = 20) {
  const n = Math.max(1, Math.min(500, Number(limit) || 20));
  return kind
    ? db.prepare('SELECT * FROM cards WHERE kind = ? ORDER BY last_seen DESC LIMIT ?').all(String(kind), n)
    : db.prepare('SELECT * FROM cards ORDER BY last_seen DESC LIMIT ?').all(n);
}

export function setDaySummary(db, day, summary, tokens = 0) {
  db.prepare(
    `INSERT INTO days (day, summary, tokens, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(day) DO UPDATE SET summary=excluded.summary, tokens=excluded.tokens, updated_at=excluded.updated_at`,
  ).run(String(day), String(summary ?? ''), Number(tokens) || 0, Date.now());
}

export function getDay(db, day) {
  return db.prepare('SELECT * FROM days WHERE day = ?').get(String(day));
}

export function stats(db) {
  const one = (sql) => db.prepare(sql).get();
  return {
    events: one('SELECT COUNT(*) n FROM events').n,
    cards: one('SELECT COUNT(*) n FROM cards').n,
    days: one('SELECT COUNT(*) n FROM days').n,
    firstDay: one('SELECT MIN(day) d FROM events').d,
    lastDay: one('SELECT MAX(day) d FROM events').d,
  };
}

export function closeMemory(db) {
  try {
    db.close();
  } catch {
    /* ignore */
  }
}
