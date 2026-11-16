import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { config } from './config.js';

const dbPath = resolve(process.cwd(), config.dbPath);
mkdirSync(dirname(dbPath), { recursive: true });

export const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    endpoint TEXT NOT NULL,
    item_key TEXT NOT NULL,
    data TEXT NOT NULL,
    fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(endpoint, item_key)
  );

  CREATE TABLE IF NOT EXISTS raw_responses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    endpoint TEXT NOT NULL,
    url TEXT NOT NULL,
    params_hash TEXT NOT NULL,
    payload TEXT NOT NULL,
    fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sync_state (
    endpoint TEXT PRIMARY KEY,
    last_run_at TEXT NOT NULL,
    last_status TEXT NOT NULL,
    items_upserted INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_records_endpoint_fetched ON records(endpoint, fetched_at);
`);

const upsertRecord = db.prepare(`
  INSERT INTO records (endpoint, item_key, data)
  VALUES (@endpoint, @itemKey, @data)
  ON CONFLICT(endpoint, item_key) DO UPDATE SET
    data = excluded.data,
    fetched_at = excluded.fetched_at
`);

const insertRaw = db.prepare(`
  INSERT INTO raw_responses (endpoint, url, params_hash, payload)
  VALUES (@endpoint, @url, @paramsHash, @payload)
`);

const upsertSyncState = db.prepare(`
  INSERT INTO sync_state (endpoint, last_run_at, last_status, items_upserted)
  VALUES (@endpoint, datetime('now'), @status, @count)
  ON CONFLICT(endpoint) DO UPDATE SET
    last_run_at = excluded.last_run_at,
    last_status = excluded.last_status,
    items_upserted = excluded.items_upserted
`);

export function saveItems(endpoint, items, keyFields) {
  const persist = db.transaction((rows) => {
    for (const row of rows) upsertRecord.run(row);
  });
  const rows = items.map((item) => {
    const keySource = keyFields.length ? keyFields.map((f) => item[f]).join(':') : JSON.stringify(item);
    return { endpoint, itemKey: String(keySource), data: JSON.stringify(item) };
  });
  persist(rows);
  return rows.length;
}

export function saveRaw(endpoint, url, params, payload) {
  insertRaw.run({
    endpoint,
    url: url.toString(),
    paramsHash: JSON.stringify(params),
    payload: JSON.stringify(payload)
  });
}

export function markSync(endpoint, status, count) {
  upsertSyncState.run({ endpoint, status, count });
}

export function knownItemKeys(endpoint) {
  return new Set(db.prepare('SELECT item_key FROM records WHERE endpoint = ?').all(endpoint).map((r) => r.item_key));
}
