import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { config } from './config.js';

const dbPath = resolve(process.cwd(), config.dbPath);
mkdirSync(dirname(dbPath), { recursive: true });

export const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode = WAL');

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

function getByPath(obj, path) {
  return String(path).split('.').reduce((acc, key) => (acc === null || acc === undefined ? undefined : acc[key]), obj);
}

export function saveItems(endpoint, items, keyFields) {
  const rows = items.map((item) => {
    const values = keyFields.map((f) => getByPath(item, f));
    const keySource = values.every((v) => v !== undefined && v !== null) ? values.join(':') : JSON.stringify(item);
    return { endpoint, itemKey: String(keySource), data: JSON.stringify(item) };
  });
  db.exec('BEGIN');
  try {
    for (const row of rows) upsertRecord.run(row);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
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

export function sourceCombos({ fromEndpoint, fields }, { limit = 5000 } = {}) {
  const entries = Object.entries(fields);
  const cols = entries
    .map(([param, field]) => `json_extract(data, '$.${field}') AS "${param}"`)
    .join(', ');
  const rows = db.prepare(`SELECT DISTINCT ${cols} FROM records WHERE endpoint = ? LIMIT ?`).all(fromEndpoint, limit);
  return rows
    .map((row) => {
      const combo = {};
      for (const [param] of entries) combo[param] = row[param];
      return combo;
    })
    .filter((combo) => Object.values(combo).every((v) => v !== null && v !== undefined && v !== ''));
}
