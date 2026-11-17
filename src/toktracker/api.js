import { db } from '../db.js';
import { ttStore } from './store.js';
import { getSettings, setSetting, revenueFor, RATE_KEYS } from './revenue.js';

const dur = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
};

function liveNow() {
  const tracked = ttStore.trackedSet();
  return ttStore.openSessions().map((session) => {
    const profile = db
      .prepare(`
        SELECT json_extract(data, '$.name') AS name, json_extract(data, '$.avatar') AS avatar,
               json_extract(data, '$.region') AS region, json_extract(data, '$.rank') AS rank
        FROM records
        WHERE endpoint = 'global_rankings' AND json_extract(data, '$.username') = ?
        LIMIT 1
      `)
      .get(session.username) || {};

    // Growth rate from the last two snapshots of this session (diamonds / min).
    const lastTwo = db
      .prepare(`
        SELECT ts, data FROM tt_stream_snapshots
        WHERE username = ? AND stream_id = ?
        ORDER BY ts DESC LIMIT 2
      `)
      .all(session.username, session.stream_id)
      .reverse()
      .map((r) => ({ ts: Date.parse(r.ts), diamonds: JSON.parse(r.data).diamonds }));
    let diamondsPerMin = null;
    if (lastTwo.length === 2 && Number.isFinite(lastTwo[0].diamonds) && Number.isFinite(lastTwo[1].diamonds)) {
      const minutes = (lastTwo[1].ts - lastTwo[0].ts) / 60_000;
      if (minutes > 0) diamondsPerMin = (lastTwo[1].diamonds - lastTwo[0].diamonds) / minutes;
    }

    const durationMs = Date.parse(session.last_seen_at) - Date.parse(session.started_at || session.first_seen_at);
    return {
      username: session.username,
      name: profile.name || session.username,
      avatar: profile.avatar || null,
      region: profile.region || null,
      rank: profile.rank ?? null,
      streamId: session.stream_id,
      startedAt: session.started_at,
      firstSeenAt: session.first_seen_at,
      duration: Number.isFinite(durationMs) && durationMs >= 0 ? dur(durationMs) : null,
      diamonds: session.diamonds,
      earnings: session.earnings,
      revenue: revenueFor(session),
      gifts: session.gifts,
      likes: session.likes,
      comments: session.comments,
      joins: session.joins,
      newFollowers: session.new_followers,
      viewersPeak: session.viewers_peak,
      viewersUnique: session.viewers_unique,
      diamondsPerMin: diamondsPerMin === null ? null : Math.round(diamondsPerMin * 10) / 10,
      hasVideo: Boolean(session.hls_url),
      tracked: tracked.has(session.username)
    };
  });
}

export function createTokTrackerApi() {
  const api = [];

  api.push(['GET', '/api/health', (_req, res) => {
    res.json({ ok: true, ...ttStore.trackerStats() });
  }]);

  api.push(['GET', '/api/live', (_req, res) => {
    res.json({ live: liveNow(), ts: new Date().toISOString() });
  }]);

  api.push(['GET', '/api/leaderboard', (req, res) => {
    const field = ['diamonds', 'earnings', 'amount', 'gifts', 'rank'].includes(req.query.by) ? req.query.by : 'diamonds';
    const days = Math.min(Math.max(Number(req.query.days) || 7, 1), 90);
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    const source = field === 'rank' || field === 'earnings' ? 'global_rankings'
      : field === 'amount' || field === 'gifts' ? 'gifters' : null;
    const settings = getSettings();
    const convert = (money, value) => {
      if (money === 'diamonds') return revenueFor({ diamonds: value }, settings);
      if (money === 'earnings') return { usdNet: value, eurNet: Math.round(value * settings.usdToEur * 10000) / 10000 };
      if (money === 'amount') return { usdNet: value, eurNet: Math.round(value * settings.usdToEur * 10000) / 10000 };
      return null;
    };
    const money = { diamonds: 'diamonds', earnings: 'earnings', amount: 'amount' }[field] || null;
    const rows = ttStore.leaderboard({ field, since, source }).map((row) => ({
      ...row,
      ...(money ? {
        revenue: { value: convert(money, row.value), delta: convert(money, row.delta) }
      } : {})
    }));
    res.json({ by: field, days, currency: settings.primaryCurrency, rows });
  }]);

  api.push(['GET', '/api/watchlist', (req, res) => {
    const days = Math.min(Math.max(Number(req.query.days) || 1, 1), 30);
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    res.json({ days, rows: ttStore.topWatchMinutes(since) });
  }]);

  api.push(['GET', '/api/sessions', (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const username = (req.query.username || '').toString().trim();
    const where = username ? 'WHERE ended_at IS NOT NULL AND username = ?' : 'WHERE ended_at IS NOT NULL';
    const countArgs = username ? [username] : [];
    const args = username ? [username, limit, offset] : [limit, offset];
    const total = db.prepare(`SELECT COUNT(*) AS n FROM tt_live_sessions ${where}`).get(...countArgs).n;
    const rows = db
      .prepare(`
        SELECT * FROM tt_live_sessions ${where} ORDER BY last_seen_at DESC LIMIT ? OFFSET ?
      `)
      .all(...args)
      .map((row) => ({
        ...row,
        revenue: revenueFor(row),
        duration: row.started_at && row.ended_at
          ? dur(Date.parse(row.ended_at) - Date.parse(row.started_at))
          : dur(Date.parse(row.last_seen_at) - Date.parse(row.started_at || row.first_seen_at))
      }));
    res.json({ total, limit, offset, rows });
  }]);

  api.push(['GET', '/api/creator/:username', (req, res) => {
    const username = req.params.username;
    const days = Math.min(Math.max(Number(req.query.days) || 7, 1), 90);
    const since = new Date(Date.now() - days * 86_400_000).toISOString();

    const profile = db
      .prepare(`
        SELECT json_extract(data, '$.name') AS name, json_extract(data, '$.avatar') AS avatar,
               json_extract(data, '$.region') AS region, json_extract(data, '$.rank') AS rank,
               json_extract(data, '$.earnings') AS earnings, json_extract(data, '$.diamonds') AS diamonds,
               json_extract(data, '$.audience_language') AS audience_language
        FROM records
        WHERE endpoint = 'global_rankings' AND json_extract(data, '$.username') = ?
        ORDER BY fetched_at DESC LIMIT 1
      `)
      .get(username) || {};

    const sessions = ttStore.sessionsFor(username);
    const active = sessions.find((s) => s.ended_at === null);
    const curve = active ? ttStore.sessionCurve(username, active.stream_id, active.first_seen_at) : [];
    const stats = ttStore.creatorSeries(username, since);

    res.json({
      username,
      profile: { ...profile, revenue: revenueFor(profile) },
      tracked: ttStore.trackedSet().has(username),
      sessions: sessions.map((s) => ({ ...s, revenue: revenueFor(s) })),
      active: active ? { ...active, curve, revenue: revenueFor(active) } : null,
      stats,
      windowDays: days
    });
  }]);

  api.push(['GET', '/api/charts', (req, res) => {
    const days = Math.min(Math.max(Number(req.query.days) || 7, 1), 90);
    const metric = ['diamonds', 'earnings', 'sessions'].includes(req.query.metric) ? req.query.metric : 'diamonds';
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    const tracked = ttStore.trackedUsernames().map((row) => row.username);
    if (tracked.length === 0) return res.json({ days, metric, series: [] });

    if (metric === 'sessions') {
      // One point per completed session (incl. history imported from the collector).
      const rows = db
        .prepare(`
          SELECT username, started_at, ended_at, last_seen_at, diamonds
          FROM tt_live_sessions
          WHERE COALESCE(started_at, first_seen_at) >= ? AND username IN (${tracked.map(() => '?').join(',')})
          ORDER BY COALESCE(started_at, first_seen_at)
        `)
        .all(since, ...tracked);
      const byUser = new Map();
      for (const row of rows) {
        if (!byUser.has(row.username)) byUser.set(row.username, { username: row.username, name: null, points: [] });
        byUser.get(row.username).points.push({
          ts: row.started_at ?? row.first_seen_at,
          diamonds: row.diamonds,
          ended: Boolean(row.ended_at)
        });
      }
      return res.json({ days, metric, series: [...byUser.values()] });
    }

    const rows = db
      .prepare(`
        SELECT username, name, ts, diamonds, earnings, rank
        FROM tt_creator_snapshots
        WHERE ts >= ? AND username IN (${tracked.map(() => '?').join(',')})
        ORDER BY ts
      `)
      .all(since, ...tracked);

    const byUser = new Map();
    for (const row of rows) {
      if (!byUser.has(row.username)) byUser.set(row.username, { username: row.username, name: row.name, points: [] });
      byUser.get(row.username).points.push({ ts: row.ts, diamonds: row.diamonds, earnings: row.earnings, rank: row.rank });
    }
    res.json({ days, metric, series: [...byUser.values()] });
  }]);

  api.push(['GET', '/api/donors', (req, res) => {
    const days = Math.min(Math.max(Number(req.query.days) || 7, 1), 90);
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    const username = (req.query.username || '').toString().trim() || null;
    const rows = ttStore.topDonors(since, username);
    for (const row of rows) {
      const gifter = db
        .prepare(`SELECT data FROM records WHERE endpoint = 'gifters' AND json_extract(data, '$.username') = ? LIMIT 1`)
        .get(row.username);
      row.amount = gifter ? JSON.parse(gifter.data).amount ?? null : null;
    }
    const creators = db
      .prepare(`
        SELECT DISTINCT json_extract(data, '$._params.username') AS username
        FROM records
        WHERE endpoint = 'creator_stream_events'
          AND json_extract(data, '$.type') = 'gift'
          AND fetched_at >= strftime('%Y-%m-%d %H:%M:%S', ?)
        ORDER BY username
      `)
      .all(since)
      .map((r) => r.username);
    res.json({ days, username, rows, creators, rates: getSettings() });
  }]);

  api.push(['GET', '/api/tracked', (_req, res) => {
    const tracked = ttStore.trackedUsernames();
    const live = new Set(ttStore.openSessions().map((session) => session.username));
    // Discovery pool: best-known creators from the collector, excluding tracked ones.
    const suggestions = db
      .prepare(`
        SELECT json_extract(data, '$.username') AS username,
               json_extract(data, '$.name') AS name,
               MAX(json_extract(data, '$.rank')) AS rank
        FROM records
        WHERE endpoint = 'global_rankings' AND json_extract(data, '$.username') IS NOT NULL
        GROUP BY json_extract(data, '$.username')
        ORDER BY rank IS NULL, rank
        LIMIT 60
      `)
      .all()
      .filter((row) => !tracked.some((t) => t.username === row.username))
      .slice(0, 25);
    res.json({
      rows: tracked.map((row) => ({ ...row, isLive: live.has(row.username) })),
      suggestions
    });
  }]);

  api.push(['POST', '/api/tracked', (req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        if (Array.isArray(payload.usernames)) {
          const result = ttStore.addTrackedMany(payload.usernames);
          ttStore.importHistory(
            ttStore.trackedUsernames().map((r) => r.username).filter((u) => payload.usernames.some((s) => String(s).trim().replace(/^@/, '') === u))
          );
          res.status(201).json({ ok: true, ...result });
        } else {
          const row = ttStore.addTracked(payload.username);
          ttStore.importHistory([row.username]);
          res.status(201).json({ ok: true, row });
        }
      } catch (error) {
        res.status(400).json({ error: error.message });
      }
    });
  }]);

  api.push(['DELETE', '/api/tracked/:username', (req, res) => {
    const changes = ttStore.removeTracked(req.params.username);
    if (changes > 0) ttStore.closeSessionsFor(req.params.username);
    res.json({ ok: true, removed: changes });
  }]);

  api.push(['GET', '/api/settings', (_req, res) => {
    res.json(getSettings());
  }]);

  api.push(['PUT', '/api/settings', (req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const updates = JSON.parse(body || '{}');
        for (const [key, value] of Object.entries(updates)) setSetting(key, value);
        res.json(getSettings());
      } catch (error) {
        res.status(400).json({ error: error.message, knownKeys: Object.keys(RATE_KEYS) });
      }
    });
  }]);

  return api;
}
