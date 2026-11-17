import { request } from '../api.js';
import { db } from '../db.js';
import { ttStore } from './store.js';

const POLLS = {
  hot: 60_000, // currently live or live within the linger window
  warm: 5 * 60_000, // live within the last 24h
  cold: 30 * 60_000 // everyone else
};

const LINGER_MS = 15 * 60_000; // keep polling at hot rate for a while after going offline
const WARM_MS = 24 * 60 * 60_000;

function knownUsernames() {
  // Only explicitly tracked streamers are polled; the collector tables remain
  // the discovery pool that the UI suggests from.
  return ttStore.trackedUsernames().map((row) => row.username);
}

function streamRowToSession(username, row, hlsUrl) {
  return {
    username,
    streamId: row.id,
    roomId: row.room_id ?? null,
    startedAt: row.started_at ?? null,
    hlsUrl: hlsUrl ?? null,
    diamonds: row.diamonds ?? null,
    earnings: row.earnings ?? null,
    gifts: row.gifts ?? null,
    likes: row.likes ?? null,
    comments: row.comments ?? null,
    shares: row.shares ?? null,
    joins: row.joins ?? null,
    newFollowers: row.new_followers ?? null,
    viewersPeak: row.viewers_peak ?? null,
    viewersUnique: row.viewers_unique ?? null
  };
}

export function createTracker({ tickMs = 30_000, maxRequestsPerTick = 40 } = {}) {
  // In-memory schedule: username -> { tier, nextPollAt, lastLiveAt }
  const state = new Map();
  let timer = null;
  let running = false;

  function schedule(username, wasLive, now) {
    const entry = state.get(username) || { lastLiveAt: 0 };
    if (wasLive) entry.lastLiveAt = now;
    const sinceLive = now - (entry.lastLiveAt || 0);
    entry.tier = wasLive || (entry.lastLiveAt && sinceLive < LINGER_MS)
      ? 'hot'
      : entry.lastLiveAt && sinceLive < WARM_MS
        ? 'warm'
        : 'cold';
    entry.nextPollAt = now + POLLS[entry.tier];
    state.set(username, entry);
  }

  async function pollUser(username) {
    const payload = await request('GET', `/creators/${encodeURIComponent(username)}/streams`);
    const list = Array.isArray(payload?.data) ? payload.data : [];
    const liveRows = list.filter((row) => row.status === 'live');

    for (const row of liveRows) {
      ttStore.appendSnapshot({ username, streamId: String(row.id), data: JSON.stringify(row) });
      ttStore.upsertSession(streamRowToSession(username, row, row.hls_url ?? null));
    }
    schedule(username, liveRows.length > 0, Date.now());
    return liveRows.length;
  }

  // Fetch the playback URL for the freshest open session of a currently-live user.
  async function refreshHls(username) {
    try {
      const payload = await request('GET', `/creators/${encodeURIComponent(username)}/live-video`);
      const first = Array.isArray(payload?.data) ? payload.data.find((v) => v.hls_url) : null;
      if (first?.hls_url) {
        db.prepare(
          `UPDATE tt_live_sessions SET hls_url = ?
           WHERE username = ?
             AND (ended_at IS NULL OR ended_at = (
               SELECT ended_at FROM tt_live_sessions WHERE username = ? AND ended_at IS NOT NULL
               ORDER BY last_seen_at DESC LIMIT 1))
           ORDER BY (ended_at IS NULL) DESC, last_seen_at DESC
           LIMIT 1`
        ).run(first.hls_url, username, username);
      }
    } catch (error) {
      // Non-critical: playback URL stays empty.
      ttStore.logError(username, `hls: ${error.message}`);
    }
  }

  async function tick() {
    if (running) return;
    running = true;
    try {
      const usernames = knownUsernames();
      for (const username of usernames) if (!state.has(username)) state.set(username, { tier: 'cold', nextPollAt: 0, lastLiveAt: 0 });
      // drop schedule entries of users that are no longer tracked
      for (const username of [...state.keys()]) if (!usernames.includes(username)) state.delete(username);

      const now = Date.now();
      const due = usernames
        .map((username) => ({ username, entry: state.get(username) }))
        .filter(({ entry }) => (entry.nextPollAt ?? 0) <= now)
        // lowest tier first so discovery keeps advancing even while hot users re-poll
        .sort((a, b) => (a.entry.tier === b.entry.tier
          ? a.entry.nextPollAt - b.entry.nextPollAt
          : b.entry.tier.localeCompare(a.entry.tier)));

      let requests = 0;
      for (const { username, entry } of due) {
        if (requests >= maxRequestsPerTick) break;
        try {
          const liveCount = await pollUser(username);
          requests += 1;
          if (liveCount > 0 && now >= (entry.nextVideoAt || 0) && requests < maxRequestsPerTick) {
            await refreshHls(username);
            requests += 1;
            entry.nextVideoAt = now + 5 * 60_000;
          }
        } catch (error) {
          ttStore.logError(username, error.message);
          schedule(username, false, Date.now());
        }
      }

      // Close sessions whose user no longer reports any of its streams as live:
      // recompute from the youngest snapshot per open stream, with a small grace
      // period so a single missed poll during a live session does not close it.
      const graceCutoff = new Date(Date.now() - 2 * POLLS.hot).toISOString();
      const stillLive = new Map();
      for (const row of db
        .prepare(`
          SELECT username, stream_id, MAX(ts) AS last_ts FROM tt_stream_snapshots
          WHERE json_extract(data, '$.status') = 'live' GROUP BY username, stream_id
        `)
        .all()) {
        if (row.last_ts >= graceCutoff) {
          if (!stillLive.has(row.username)) stillLive.set(row.username, new Set());
          stillLive.get(row.username).add(String(row.stream_id));
        }
      }
      ttStore.closeStaleSessions(stillLive);
      console.log(`tracker tick: ${requests}/${due.length} polled, ${ttStore.openSessions().length} live`);
    } finally {
      running = false;
    }
  }

  function snapshotCreators() {
    try {
      const count = ttStore.copyCreatorSnapshots();
      console.log(`tracker: ${count} creator snapshots taken`);
    } catch (error) {
      ttStore.logError(null, `snapshot: ${error.message}`);
    }
  }

  async function start() {
    snapshotCreators();
    try {
      const { imported } = ttStore.importHistory(knownUsernames());
      if (imported > 0) console.log(`tracker: ${imported} historical sessions imported from collector records`);
    } catch (error) {
      ttStore.logError(null, `history import: ${error.message}`);
    }
    await tick();
    timer = setInterval(() => {
      tick().catch((error) => ttStore.logError(null, `tick: ${error.message}`));
    }, tickMs);
    setInterval(snapshotCreators, 60 * 60_000);
    console.log('toktracker tracking started');
  }

  function stop() {
    if (timer) clearInterval(timer);
  }

  return { start, stop, state, tick };
}
