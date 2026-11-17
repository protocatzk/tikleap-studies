import express from 'express';
import { resolve } from 'node:path';
import { db } from '../db.js';

const app = express();
app.use(express.static(resolve(process.cwd(), 'dashboard/public')));

// Whitelist for json_extract paths coming from query strings: only
// [A-Za-z0-9_.$] allowed, so the expression can never leave JSON path syntax.
const safeField = (field) => {
  if (!field || !/^[\w.$]+$/.test(field)) return null;
  return field;
};

app.get('/api/health', (_req, res) => {
  const row = db.prepare('SELECT MAX(fetched_at) AS last_activity FROM records').get();
  const lastRun = db.prepare('SELECT MAX(last_run_at) AS last_run FROM sync_state').get();
  res.json({
    ok: true,
    db: 'connected',
    lastActivity: row.last_activity,
    lastRun: lastRun.last_run,
    node: process.version,
    uptimeSec: Math.round(process.uptime())
  });
});

app.get('/api/summary', (_req, res) => {
  const counts = db.prepare(`
    SELECT endpoint, COUNT(*) AS items, MAX(fetched_at) AS last_fetch
    FROM records GROUP BY endpoint ORDER BY endpoint
  `).all();
  const sync = db.prepare('SELECT * FROM sync_state ORDER BY endpoint').all();
  const totals = db.prepare('SELECT COUNT(*) AS records FROM records').get().records;
  const rawCount = db.prepare('SELECT COUNT(*) AS raws FROM raw_responses').get().raws;
  const problems = sync.filter((s) => s.last_status !== 'ok').length;
  res.json({ totals: { records: totals, raws: rawCount, problems, endpoints: counts.length }, counts, sync });
});

app.get('/api/endpoints', (_req, res) => {
  res.json(db.prepare('SELECT DISTINCT endpoint FROM records ORDER BY endpoint').all().map((r) => r.endpoint));
});

app.get('/api/records/:endpoint', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 500);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const { endpoint } = req.params;
  const search = (req.query.q || '').toString().trim();

  const where = search
    ? 'WHERE endpoint = ? AND (item_key LIKE ? OR data LIKE ?)'
    : 'WHERE endpoint = ?';
  const args = search ? [endpoint, `%${search}%`, `%${search}%`] : [endpoint];

  const total = db.prepare(`SELECT COUNT(*) AS n FROM records ${where}`).get(...args).n;
  const rows = db
    .prepare(`SELECT item_key, data, fetched_at FROM records ${where} ORDER BY fetched_at DESC, item_key LIMIT ? OFFSET ?`)
    .all(...args, limit, offset)
    .map((row) => ({ ...row, data: JSON.parse(row.data) }));
  res.json({ total, limit, offset, rows });
});

// Top-N distribution for one JSON field inside an endpoint's records.
app.get('/api/facets/:endpoint', (req, res) => {
  const field = safeField(req.query.field);
  if (!field) return res.status(400).json({ error: 'invalid field: use [A-Za-z0-9_.$] only' });
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  const rows = db
    .prepare(`
      SELECT json_extract(data, '$.${field}') AS value, COUNT(*) AS n
      FROM records WHERE endpoint = ?
      GROUP BY value ORDER BY n DESC LIMIT ?
    `)
    .all(req.params.endpoint, limit);
  res.json({ field, rows: rows.map((r) => ({ value: r.value === null ? '(fehlt)' : String(r.value), n: r.n })) });
});

// Numeric aggregate (SUM/AVG/MIN/MAX) for one JSON field per endpoint.
app.get('/api/metrics/:endpoint', (req, res) => {
  const field = safeField(req.query.field);
  if (!field) return res.status(400).json({ error: 'invalid field: use [A-Za-z0-9_.$] only' });
  const row = db
    .prepare(`
      SELECT
        COUNT(json_extract(data, '$.${field}')) AS n,
        SUM(CAST(json_extract(data, '$.${field}') AS REAL)) AS sum,
        AVG(CAST(json_extract(data, '$.${field}') AS REAL)) AS avg,
        MIN(CAST(json_extract(data, '$.${field}') AS REAL)) AS min,
        MAX(CAST(json_extract(data, '$.${field}') AS REAL)) AS max
      FROM records WHERE endpoint = ?
    `)
    .get(req.params.endpoint);
  res.json({ field, metrics: row });
});

// Latest raw API payloads for an endpoint (for debugging collector runs).
app.get('/api/raw/:endpoint', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  const rows = db
    .prepare(`
      SELECT id, url, payload, fetched_at FROM raw_responses
      WHERE endpoint = ? ORDER BY fetched_at DESC, id DESC LIMIT ?
    `)
    .all(req.params.endpoint, limit)
    .map((row) => ({ ...row, payload: JSON.parse(row.payload) }));
  const total = db.prepare('SELECT COUNT(*) AS n FROM raw_responses WHERE endpoint = ?').get(req.params.endpoint).n;
  res.json({ total, rows });
});

const port = Number(process.env.DASHBOARD_PORT || 3000);
app.listen(port, '127.0.0.1', () => {
  console.log(`Dashboard: http://127.0.0.1:${port}`);
});
