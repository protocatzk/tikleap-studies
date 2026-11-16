import express from 'express';
import { resolve } from 'node:path';
import { db } from '../db.js';

const app = express();
app.use(express.static(resolve(process.cwd(), 'dashboard/public')));

app.get('/api/summary', (_req, res) => {
  const counts = db.prepare(`
    SELECT endpoint, COUNT(*) AS items, MAX(fetched_at) AS last_fetch
    FROM records GROUP BY endpoint ORDER BY endpoint
  `).all();
  const sync = db.prepare('SELECT * FROM sync_state ORDER BY endpoint').all();
  res.json({ counts, sync });
});

app.get('/api/endpoints', (_req, res) => {
  res.json(db.prepare('SELECT DISTINCT endpoint FROM records ORDER BY endpoint').all().map((r) => r.endpoint));
});

app.get('/api/records/:endpoint', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 500);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const { endpoint } = req.params;
  const total = db.prepare('SELECT COUNT(*) AS n FROM records WHERE endpoint = ?').get(endpoint).n;
  const rows = db
    .prepare('SELECT item_key, data, fetched_at FROM records WHERE endpoint = ? ORDER BY fetched_at DESC, item_key LIMIT ? OFFSET ?')
    .all(endpoint, limit, offset)
    .map((row) => ({ ...row, data: JSON.parse(row.data) }));
  res.json({ total, limit, offset, rows });
});

const port = Number(process.env.DASHBOARD_PORT || 3000);
app.listen(port, '127.0.0.1', () => {
  console.log(`Dashboard: http://127.0.0.1:${port}`);
});
