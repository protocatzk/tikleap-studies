import { db } from '../db.js';

function normalizeUsername(username) {
  const clean = String(username ?? '').trim().replace(/^@/, '');
  return clean || null;
}

// Toktracker tables: append-only time series + live session register.
// The collector's `records` table only ever stores the newest state per item,
// so toktracker keeps its own history here (same database, tt_ prefix).

db.exec(`PRAGMA busy_timeout = 5000`);

db.exec(`
  CREATE TABLE IF NOT EXISTS tt_stream_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    username TEXT NOT NULL,
    stream_id TEXT NOT NULL,
    data TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tt_live_sessions (
    username TEXT NOT NULL,
    stream_id TEXT NOT NULL,
    room_id TEXT,
    started_at TEXT,
    first_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    ended_at TEXT,
    hls_url TEXT,
    diamonds REAL,
    earnings REAL,
    gifts INTEGER,
    likes INTEGER,
    comments INTEGER,
    shares INTEGER,
    joins INTEGER,
    new_followers INTEGER,
    viewers_peak INTEGER,
    viewers_unique INTEGER,
    PRIMARY KEY (username, stream_id)
  );

  CREATE TABLE IF NOT EXISTS tt_creator_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    username TEXT NOT NULL,
    name TEXT,
    rank INTEGER,
    earnings REAL,
    diamonds REAL,
    amount REAL,
    gifts INTEGER,
    receivers_count INTEGER,
    source TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_tt_snap_stream ON tt_stream_snapshots(username, stream_id, ts);
  CREATE INDEX IF NOT EXISTS idx_tt_snap_creator ON tt_creator_snapshots(username, ts);
  CREATE INDEX IF NOT EXISTS idx_tt_sessions_user ON tt_live_sessions(username, first_seen_at);

  CREATE TABLE IF NOT EXISTS tt_tracker_errors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    username TEXT,
    message TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tt_tracked (
    username TEXT PRIMARY KEY,
    added_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    note TEXT
  );
`);

const appendSnapshot = db.prepare(`
  INSERT INTO tt_stream_snapshots (username, stream_id, data) VALUES (@username, @streamId, @data)
`);

const upsertSession = db.prepare(`
  INSERT INTO tt_live_sessions (username, stream_id, room_id, started_at, last_seen_at, hls_url,
    diamonds, earnings, gifts, likes, comments, shares, joins, new_followers, viewers_peak, viewers_unique)
  VALUES (@username, @streamId, @roomId, @startedAt,
    strftime('%Y-%m-%dT%H:%M:%fZ','now'), @hlsUrl,
    @diamonds, @earnings, @gifts, @likes, @comments, @shares, @joins, @newFollowers, @viewersPeak, @viewersUnique)
  ON CONFLICT(username, stream_id) DO UPDATE SET
    last_seen_at = excluded.last_seen_at,
    ended_at = NULL,
    diamonds = COALESCE(excluded.diamonds, diamonds),
    earnings = COALESCE(excluded.earnings, earnings),
    gifts = COALESCE(excluded.gifts, gifts),
    likes = COALESCE(excluded.likes, likes),
    comments = COALESCE(excluded.comments, comments),
    shares = COALESCE(excluded.shares, shares),
    joins = COALESCE(excluded.joins, joins),
    new_followers = COALESCE(excluded.new_followers, new_followers),
    viewers_peak = COALESCE(excluded.viewers_peak, viewers_peak),
    viewers_unique = COALESCE(excluded.viewers_unique, viewers_unique),
    hls_url = COALESCE(excluded.hls_url, hls_url)
`);

const appendCreatorSnapshots = db.prepare(`
  INSERT INTO tt_creator_snapshots (username, name, rank, earnings, diamonds, amount, gifts, receivers_count, source)
  VALUES (@username, @name, @rank, @earnings, @diamonds, @amount, @gifts, @receiversCount, @source)
`);

const appendError = db.prepare(`
  INSERT INTO tt_tracker_errors (username, message) VALUES (@username, @message)
`);

export const ttStore = {
  appendSnapshot(row) {
    appendSnapshot.run(row);
  },

  logError(username, message) {
    appendError.run({ username, message: String(message).slice(0, 500) });
  },

  trackedUsernames() {
    return db.prepare(`SELECT username, added_at, note FROM tt_tracked ORDER BY added_at DESC`).all();
  },

  addTracked(username, note = null) {
    const clean = normalizeUsername(username);
    if (!clean) throw new Error('username required');
    db.prepare(`INSERT OR IGNORE INTO tt_tracked (username, note) VALUES (?, ?)`).run(clean, note);
    return db.prepare(`SELECT username, added_at, note FROM tt_tracked WHERE username = ?`).get(clean);
  },

  addTrackedMany(usernames) {
    const clean = [...new Set(usernames.map(normalizeUsername).filter(Boolean))];
    if (clean.length === 0) throw new Error('no valid usernames given');
    const before = db.prepare('SELECT COUNT(*) AS n FROM tt_tracked').get().n;
    db.exec('BEGIN');
    try {
      for (const username of clean) {
        db.prepare(`INSERT OR IGNORE INTO tt_tracked (username) VALUES (?)`).run(username);
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    const after = db.prepare('SELECT COUNT(*) AS n FROM tt_tracked').get().n;
    return { requested: clean.length, added: after - before, totalTracked: after };
  },

  removeTracked(username) {
    const clean = normalizeUsername(username);
    return db.prepare(`DELETE FROM tt_tracked WHERE username = ?`).run(clean).changes;
  },

  trackedSet() {
    return new Set(
      db.prepare(`SELECT username FROM tt_tracked`).all().map((row) => row.username)
    );
  },

  // Historical sessions for a tracked streamer, reconstructed from the
  // collector's daily creator_stream_details sweeps (ended streams with final stats).
  importHistory(usernames) {
    if (usernames.length === 0) return { imported: 0 };
    let imported = 0;
    const insert = db.prepare(`
      INSERT OR IGNORE INTO tt_live_sessions
        (username, stream_id, room_id, started_at, first_seen_at, last_seen_at, ended_at,
         diamonds, earnings, gifts, likes, comments, shares, joins, new_followers,
         viewers_peak, viewers_unique)
      VALUES (@username, @streamId, @roomId, @startedAt, COALESCE(@startedAt, '1970-01-01'),
              @endedAt, @endedAt,
              @diamonds, @earnings, @gifts, @likes, @comments, @shares, @joins,
              @newFollowers, @viewersPeak, @viewersUnique)
    `);
    db.exec('BEGIN');
    try {
      for (const username of usernames) {
        const rows = db
          .prepare(`
            SELECT data FROM records
            WHERE endpoint = 'creator_stream_details'
              AND json_extract(data, '$._params.username') = ?
              AND json_extract(data, '$.ended_at') IS NOT NULL
          `)
          .all(username);
        for (const r of rows) {
          const d = JSON.parse(r.data);
          const result = insert.run({
            username,
            streamId: String(d.id),
            roomId: d.room_id ?? null,
            startedAt: d.started_at ?? null,
            endedAt: d.ended_at,
            diamonds: d.diamonds ?? null,
            earnings: d.earnings ?? null,
            gifts: d.gifts ?? null,
            likes: d.likes ?? null,
            comments: d.comments ?? null,
            shares: d.shares ?? null,
            joins: d.joins ?? null,
            newFollowers: d.new_followers ?? null,
            viewersPeak: d.viewers_peak ?? null,
            viewersUnique: d.viewers_unique ?? null
          });
          imported += result.changes;
        }
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return { imported };
  },

  closeSessionsFor(username) {
    const clean = normalizeUsername(username);
    return db
      .prepare(`UPDATE tt_live_sessions SET ended_at = last_seen_at WHERE username = ? AND ended_at IS NULL`)
      .run(clean).changes;
  },

  upsertSession(row) {
    upsertSession.run(row);
  },

  closeStaleSessions(streamIdsByUsername) {
    const open = db
      .prepare(`SELECT username, stream_id FROM tt_live_sessions WHERE ended_at IS NULL`)
      .all();
    for (const session of open) {
      const seen = streamIdsByUsername.get(session.username) || new Set();
      if (!seen.has(session.stream_id)) {
        db.prepare(`UPDATE tt_live_sessions SET ended_at = last_seen_at WHERE username = ? AND stream_id = ?`).run(
          session.username,
          session.stream_id
        );
      }
    }
    return open.length;
  },

  copyCreatorSnapshots() {
    // Only write a snapshot when the newest already-stored row for a user (within
    // the last hour) differs — otherwise the table grows with identical duplicates.
    const recent = new Map();
    for (const row of db
      .prepare(`
        SELECT username, name, rank, earnings, diamonds, amount, gifts, receivers_count
        FROM (SELECT *, ROW_NUMBER() OVER (PARTITION BY username ORDER BY ts DESC) AS rn
              FROM tt_creator_snapshots WHERE ts >= datetime('now', '-25 hours'))
        WHERE rn = 1
      `)
      .all()) {
      recent.set(row.username, row);
    }
    const rows = [
      ...db
        .prepare(`
          SELECT json_extract(data, '$.username') AS username, json_extract(data, '$.name') AS name,
                 json_extract(data, '$.rank') AS rank, json_extract(data, '$.earnings') AS earnings,
                 json_extract(data, '$.diamonds') AS diamonds, NULL AS amount,
                 NULL AS gifts, NULL AS receiversCount, 'global_rankings' AS source
          FROM records WHERE endpoint = 'global_rankings'
        `)
        .all(),
      ...db
        .prepare(`
          SELECT json_extract(data, '$.username') AS username, json_extract(data, '$.name') AS name,
                 NULL AS rank, NULL AS earnings, json_extract(data, '$.diamonds') AS diamonds,
                 json_extract(data, '$.amount') AS amount, json_extract(data, '$.gifts') AS gifts,
                 json_extract(data, '$.receivers_count') AS receiversCount, 'gifters' AS source
          FROM records WHERE endpoint = 'gifters'
        `)
        .all()
    ];
    db.exec('BEGIN');
    try {
      let written = 0;
      for (const row of rows) {
        const last = recent.get(row.username);
        const unchanged = last && last.name === row.name && last.rank === row.rank
          && last.earnings === row.earnings && last.diamonds === row.diamonds
          && last.amount === row.amount && last.gifts === row.gifts
          && last.receivers_count === row.receiversCount;
        if (!unchanged) {
          appendCreatorSnapshots.run(row);
          written += 1;
        }
      }
      db.exec('COMMIT');
      return written;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  },

  openSessions() {
    return db
      .prepare(`
        SELECT * FROM tt_live_sessions WHERE ended_at IS NULL ORDER BY diamonds DESC
      `)
      .all();
  },

  sessionCurve(username, streamId, since) {
    return db
      .prepare(`
        SELECT ts, data FROM tt_stream_snapshots
        WHERE username = ? AND stream_id = ? AND ts >= ?
        ORDER BY ts
      `)
      .all(username, streamId, since)
      .map((row) => ({ ts: row.ts, ...JSON.parse(row.data) }));
  },

  sessionsFor(username) {
    return db
      .prepare(`
        SELECT * FROM tt_live_sessions WHERE username = ? ORDER BY first_seen_at DESC LIMIT 100
      `)
      .all(username);
  },

  creatorSeries(username, since) {
    return db
      .prepare(`
        SELECT ts, username, rank, earnings, diamonds, amount, gifts, source
        FROM tt_creator_snapshots WHERE username = ? AND ts >= ? ORDER BY ts
      `)
      .all(username, since);
  },

  leaderboard({ field, since, source }) {
    const columns = {
      diamonds: 'diamonds',
      earnings: 'earnings',
      amount: 'amount',
      gifts: 'gifts',
      rank: 'rank'
    };
    const col = columns[field] || 'diamonds';
    const sourceFilter = source ? 'AND source = ?' : '';
    const sourceArgs = source ? [source] : [];
    // Latest and earliest value per username inside the window, delta between them.
    const rows = db
      .prepare(`
        WITH latest AS (
          SELECT username, name, ts, value FROM (
            SELECT username, name, ts, ${col} AS value,
                   ROW_NUMBER() OVER (PARTITION BY username ORDER BY ts DESC) AS rn
            FROM tt_creator_snapshots WHERE ts >= ? ${sourceFilter} AND ${col} IS NOT NULL
          ) WHERE rn = 1
        ),
        earliest AS (
          SELECT username, value FROM (
            SELECT username, ${col} AS value,
                   ROW_NUMBER() OVER (PARTITION BY username ORDER BY ts ASC) AS rn
            FROM tt_creator_snapshots WHERE ts >= ? ${sourceFilter} AND ${col} IS NOT NULL
          ) WHERE rn = 1
        )
        SELECT latest.username, latest.name, latest.value,
               latest.value - COALESCE(earliest.value, latest.value) AS delta
        FROM latest LEFT JOIN earliest USING (username)
        ORDER BY ${field === 'rank' ? 'delta ASC' : 'delta DESC'}
        LIMIT 100
      `)
      .all(since, ...sourceArgs, since, ...sourceArgs);
    return rows;
  },

  topWatchMinutes(since) {
    return db
      .prepare(`
        SELECT username, COUNT(*) AS polls,
               MAX(CAST(json_extract(data, '$.viewers_peak') AS INTEGER)) AS viewers_peak,
               MAX(CAST(json_extract(data, '$.viewers_unique') AS INTEGER)) AS viewers_unique,
               MAX(CAST(json_extract(data, '$.diamonds') AS REAL)) AS diamonds,
               MAX(CAST(json_extract(data, '$.gifts') AS INTEGER)) AS gifts
        FROM tt_stream_snapshots WHERE ts >= ? AND json_extract(data, '$.status') = 'live'
        GROUP BY username ORDER BY diamonds DESC LIMIT 50
      `)
      .all(since);
  },

  topDonors(since, creator = null) {
    const creatorFilter = creator ? 'AND json_extract(data, \'$._params.username\') = ?' : '';
    const args = [since, ...(creator ? [creator] : [])];
    return db
      .prepare(`
        SELECT json_extract(data, '$.username') AS username,
               MAX(json_extract(data, '$.name')) AS name,
               COUNT(*) AS gift_events,
               SUM(json_extract(data, '$.count')) AS gifts,
               SUM(json_extract(data, '$.diamonds')) AS diamonds,
               COUNT(DISTINCT json_extract(data, '$._params.username')) AS creators_gifted,
               MAX(json_extract(data, '$.time')) AS last_gift_at,
               MAX(json_extract(data, '$.gift_name')) AS last_gift_name
        FROM records
        WHERE endpoint = 'creator_stream_events'
          AND json_extract(data, '$.type') = 'gift'
          AND fetched_at >= strftime('%Y-%m-%d %H:%M:%S', ?)
          AND json_extract(data, '$.username') IS NOT NULL
          ${creatorFilter}
        GROUP BY json_extract(data, '$.username')
        ORDER BY diamonds DESC LIMIT 100
      `)
      .all(...args);
  },

  trackerStats() {
    const latest = db.prepare(`SELECT MAX(ts) AS lastPoll FROM tt_stream_snapshots`).get();
    const live = db.prepare(`SELECT COUNT(*) AS n FROM tt_live_sessions WHERE ended_at IS NULL`).get().n;
    const sessions = db.prepare(`SELECT COUNT(*) AS n FROM tt_live_sessions`).get().n;
    const snapshots = db.prepare(`SELECT COUNT(*) AS n FROM tt_stream_snapshots`).get().n;
    const creatorSnaps = db.prepare(`SELECT COUNT(*) AS n FROM tt_creator_snapshots`).get().n;
    const errors = db.prepare(`SELECT COUNT(*) AS n FROM tt_tracker_errors`).get().n;
    return { lastPoll: latest.lastPoll, live, sessions, snapshots, creatorSnaps, errors };
  }
};
