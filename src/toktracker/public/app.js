const $ = (sel) => document.querySelector(sel);
const fmtInt = (n) => n === null || n === undefined ? '—' : Number(n).toLocaleString('de-DE');
const fmtUsd = (n) => n === null || n === undefined ? '—' : '$' + Number(n).toLocaleString('de-DE', { maximumFractionDigits: 2 });
const fmtEur = (n) => n === null || n === undefined ? '—' : Number(n).toLocaleString('de-DE', { maximumFractionDigits: 2 }) + ' €';
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
let primaryCurrency = 'EUR';
const curKey = () => (primaryCurrency === 'USD' ? 'usdNet' : 'eurNet');
const curLabel = () => primaryCurrency;
const curFmt = () => (primaryCurrency === 'USD' ? fmtUsd : fmtEur);
const fmtMoney = (n) => curFmt()(n);
async function loadCurrency() {
  try { primaryCurrency = (await api('/api/settings')).primaryCurrency || 'EUR'; } catch { /* keep default */ }
}

async function api(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${res.status} ${path}`);
  return res.json();
}

// Simple canvas line chart with min/max labels, no external deps.
function drawChart(canvas, series, color, fmt = fmtInt) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width = canvas.clientWidth * devicePixelRatio;
  const h = canvas.height = 160 * devicePixelRatio;
  ctx.clearRect(0, 0, w, h);
  const values = series.map((p) => p.v).filter((v) => Number.isFinite(v));
  if (values.length < 2) {
    ctx.fillStyle = '#8b949e';
    ctx.font = `${12 * devicePixelRatio}px system-ui`;
    ctx.fillText('Noch zu wenig Daten', 10 * devicePixelRatio, h / 2);
    return;
  }
  const min = Math.min(...values), max = Math.max(...values);
  const pad = 8 * devicePixelRatio;
  const x = (i) => pad + (i / (series.length - 1)) * (w - 2 * pad);
  const y = (v) => max === min ? h / 2 : h - pad - ((v - min) / (max - min)) * (h - 2 * pad);

  ctx.beginPath();
  series.forEach((p, i) => i === 0 ? ctx.moveTo(x(i), y(p.v)) : ctx.lineTo(x(i), y(p.v)));
  ctx.strokeStyle = color;
  ctx.lineWidth = 2 * devicePixelRatio;
  ctx.stroke();
  ctx.lineTo(x(series.length - 1), h); ctx.lineTo(x(0), h); ctx.closePath();
  ctx.globalAlpha = 0.12; ctx.fillStyle = color; ctx.fill(); ctx.globalAlpha = 1;

  ctx.fillStyle = '#8b949e';
  ctx.font = `${11 * devicePixelRatio}px system-ui`;
  ctx.fillText(fmt(max), pad, 12 * devicePixelRatio);
  ctx.fillText(fmt(min), pad, h - 4 * devicePixelRatio);
}

const CHART_COLORS = ['#fe2c55', '#4dd8e6', '#ffd166', '#8bd450', '#b388ff', '#ff8a65', '#64b5f6', '#f06292', '#a1887f', '#4db6ac'];

// Multi-series line chart: series = [{label, points: [{v}]}]
function drawMultiChart(canvas, series, fmt = fmtInt) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width = canvas.clientWidth * devicePixelRatio;
  const h = canvas.height = 200 * devicePixelRatio;
  ctx.clearRect(0, 0, w, h);
  const all = series.flatMap((s) => s.points.map((p) => p.v)).filter((v) => Number.isFinite(v));
  if (all.length < 2 || series.length === 0) {
    ctx.fillStyle = '#8b949e';
    ctx.font = `${12 * devicePixelRatio}px system-ui`;
    ctx.fillText('Noch zu wenig Daten — Snapshots kommen stündlich.', 10 * devicePixelRatio, h / 2);
    return;
  }
  const min = Math.min(...all), max = Math.max(...all);
  const pad = 8 * devicePixelRatio;
  const allTs = series.flatMap((s) => s.points).map((p) => Date.parse(p.ts));
  const t0 = Math.min(...allTs), t1 = Math.max(...allTs);
  const toX = (ts) => (t1 === t0 ? pad : pad + ((Date.parse(ts) - t0) / (t1 - t0)) * (w - 2 * pad));
  const toY = (v) => max === min ? h / 2 : h - pad - ((v - min) / (max - min)) * (h - 2 * pad);

  series.forEach((s, si) => {
    const color = CHART_COLORS[si % CHART_COLORS.length];
    ctx.beginPath();
    s.points.forEach((p, i) => (i === 0 ? ctx.moveTo(toX(p.ts), toY(p.v)) : ctx.lineTo(toX(p.ts), toY(p.v))));
    ctx.strokeStyle = color;
    ctx.lineWidth = 2 * devicePixelRatio;
    ctx.stroke();
  });

  ctx.fillStyle = '#8b949e';
  ctx.font = `${11 * devicePixelRatio}px system-ui`;
  ctx.fillText(fmt(max), pad, 12 * devicePixelRatio);
  ctx.fillText(fmt(min), pad, h - 4 * devicePixelRatio);
}

function renderLegend(container, series, label, fmt) {
  container.innerHTML = series.map((s, si) => `
    <span class="legend-item">
      <span class="swatch" style="background:${CHART_COLORS[si % CHART_COLORS.length]}"></span>
      @${esc(s.username)} <span class="muted">${esc(label)} aktuell: ${fmt(s.points.at(-1)?.v)}</span>
    </span>
  `).join('') || '<span class="muted">Keine Daten.</span>';
}

// ---- Tabs -----------------------------------------------------------------

document.querySelectorAll('nav button').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('nav button').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('main section').forEach((s) => s.classList.add('hidden'));
    $(`#tab-${btn.dataset.tab}`).classList.remove('hidden');
    if (btn.dataset.tab === 'live') refreshLive();
    if (btn.dataset.tab === 'tracked') { refreshTracked(); refreshTrackedChart(); }
    if (btn.dataset.tab === 'leaderboard') refreshLeaderboard();
    if (btn.dataset.tab === 'donors') refreshDonors();
  });
});

// ---- Tracking --------------------------------------------------------------

let trackedNames = new Set();

async function setTracked(username, on) {
  if (on) {
    const res = await fetch('/api/tracked', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username })
    });
    if (!res.ok) throw new Error((await res.json()).error || res.status);
  } else {
    await fetch(`/api/tracked/${encodeURIComponent(username)}`, { method: 'DELETE' });
  }
  trackedNames = new Set(on ? [...trackedNames, username] : [...trackedNames].filter((n) => n !== username));
}

async function refreshTracked() {
  const { rows, suggestions } = await api('/api/tracked');
  trackedNames = new Set(rows.map((r) => r.username));
  $('#track-suggestions').innerHTML = suggestions.map((s) => `<option value="${esc(s.username)}">${esc(s.name || '')}</option>`).join('');
  $('#track-table tbody').innerHTML = rows.map((r) => `
    <tr>
      <td><span class="clickable" data-user="${esc(r.username)}">@${esc(r.username)}</span></td>
      <td>${r.isLive ? '<span class="up">LIVE</span>' : '<span class="muted">offline</span>'}</td>
      <td class="muted">${esc((r.added_at || '').replace('T', ' ').slice(0, 16))}</td>
      <td><button class="btn-danger" data-untrack="${esc(r.username)}">Entfolgen</button></td>
    </tr>
  `).join('') || '<tr><td colspan="4" class="muted">Noch niemand getrackt — Streamer unten hinzufügen oder einen Vorschlag anklicken.</td></tr>';
  $('#track-suggest-box').innerHTML = suggestions.map((s) => `
    <span class="suggest clickable" data-suggest="${esc(s.username)}">@${esc(s.username)}${s.rank ? ` <span class="muted">Rang ${esc(s.rank)}</span>` : ''}</span>
  `).join('') || '<span class="muted">Keine Vorschläge — erst <code>npm run collect</code> ausführen.</span>';
  $('#track-table tbody').querySelectorAll('[data-untrack]').forEach((el) => {
    el.addEventListener('click', () => setTracked(el.dataset.untrack, false).then(refreshTracked));
  });
  $('#track-table tbody').querySelectorAll('[data-user]').forEach((el) => {
    el.addEventListener('click', () => openCreator(el.dataset.user));
  });
  $('#track-suggest-box').querySelectorAll('[data-suggest]').forEach((el) => {
    el.addEventListener('click', () => setTracked(el.dataset.suggest, true).then(refreshTracked));
  });
}

$('#track-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = $('#track-input').value.trim().replace(/^@/, '');
  if (!username) return;
  try {
    await setTracked(username, true);
    $('#track-input').value = '';
    refreshTracked();
    refreshTrackedChart();
  } catch (err) {
    alert(err.message);
  }
});

async function refreshTrackedChart() {
  const metric = $('#tc-metric').value;
  const days = $('#tc-days').value;
  try {
    const { series } = await api(`/api/charts?metric=${metric}&days=${days}`);
    const field = metric === 'sessions' ? 'diamonds' : metric;
    const points = series.map((s) => ({
      username: s.username,
      points: s.points.map((p) => ({ ts: p.ts, v: p[field] })).filter((p) => Number.isFinite(p.v))
    })).filter((s) => s.points.length > 0);
    const fmt = metric === 'earnings' ? fmtUsd : fmtInt;
    const label = metric === 'sessions' ? 'Diamonds je Session' : metric === 'earnings' ? 'Earnings' : 'Diamonds';
    drawMultiChart($('#tc-chart'), points, fmt);
    renderLegend($('#tc-legend'), points, label, fmt);
  } catch { /* chart is optional */ }
}

$('#tc-metric').addEventListener('change', refreshTrackedChart);
$('#tc-days').addEventListener('change', refreshTrackedChart);

async function bulkTrack(usernames) {
  const res = await fetch('/api/tracked', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ usernames })
  });
  if (!res.ok) throw new Error((await res.json()).error || res.status);
  return res.json();
}

$('#track-bulk-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const usernames = $('#track-bulk-input').value.split(/[\s,;]+/).map((s) => s.trim().replace(/^@/, '')).filter(Boolean);
  if (usernames.length === 0) return;
  try {
    const { requested, added, totalTracked } = await bulkTrack(usernames);
    $('#track-feedback').textContent = `${requested} Usernames übergeben, ${added} neu getrackt, ${totalTracked} insgesamt.`;
    $('#track-bulk-input').value = '';
    refreshTracked();
  } catch (err) {
    $('#track-feedback').textContent = `Fehler: ${err.message}`;
  }
});

$('#track-suggest-all').addEventListener('click', async () => {
  const { suggestions } = await api('/api/tracked');
  if (suggestions.length === 0) return;
  try {
    const { requested, added, totalTracked } = await bulkTrack(suggestions.map((s) => s.username));
    $('#track-feedback').textContent = `${requested} Vorschläge übergeben, ${added} neu getrackt, ${totalTracked} insgesamt.`;
    refreshTracked();
  } catch (err) {
    $('#track-feedback').textContent = `Fehler: ${err.message}`;
  }
});

function openCreator(username) {
  document.querySelector('nav button[data-tab="creator"]').click();
  $('#cr-search').value = username;
  refreshCreator();
}

$('#cr-load').addEventListener('click', refreshCreator);
$('#cr-search').addEventListener('keydown', (e) => { if (e.key === 'Enter') refreshCreator(); });
$('#lb-by').addEventListener('change', refreshLeaderboard);
$('#lb-days').addEventListener('change', refreshLeaderboard);

// ---- Live board -----------------------------------------------------------

async function refreshHealth() {
  try {
    const h = await api('/api/health');
    $('#health').textContent = h.lastPoll ? `Letzter Poll: ${h.lastPoll.replace('T', ' ').slice(0, 16)} UTC · ${h.live} live · ${h.snapshots} Snapshots` : 'Tracker läuft, wartet auf ersten Poll';
  } catch { /* ignore */ }
}

async function refreshLive() {
  try {
    const { live, ts } = await api('/api/live');
    $('#live-ts').textContent = `Stand ${new Date(ts).toLocaleTimeString('de-DE')}`;
    $('#live-empty').classList.toggle('hidden', live.length > 0);
    $('#live-grid').innerHTML = live.map((c) => `
      <div class="live-card">
        <div class="top">
          ${c.avatar ? `<img src="${esc(c.avatar)}" alt="" />` : ''}
          <div>
            <div class="name clickable" data-user="${esc(c.username)}">@${esc(c.username)}</div>
            <div class="muted">${esc(c.name)}${c.region ? ' · ' + esc(c.region) : ''}${c.rank ? ' · Rang ' + esc(c.rank) : ''}</div>
          </div>
          <div class="badge">LIVE${c.duration ? ' ' + esc(c.duration) : ''}</div>
        </div>
        <div class="stats">
          <div class="stat"><div class="v">${fmtInt(c.diamonds)}</div><div class="l">Diamonds ${c.diamondsPerMin !== null ? `· +${c.diamondsPerMin}/min` : ''}</div></div>
          <div class="stat"><div class="v">${fmtUsd(c.revenue?.usdNet)}</div><div class="l">Earnings</div></div>
          <div class="stat"><div class="v">${fmtEur(c.revenue?.eurNet)}</div><div class="l">Earnings (EUR)</div></div>
          <div class="stat"><div class="v">${fmtInt(c.viewersPeak)}</div><div class="l">Peak</div></div>
          <div class="stat"><div class="v">${fmtInt(c.viewersUnique)}</div><div class="l">Unique</div></div>
          <div class="stat"><div class="v">${fmtInt(c.gifts)}</div><div class="l">Gifts</div></div>
          <div class="stat"><div class="v">${fmtInt(c.likes)}</div><div class="l">Likes</div></div>
        </div>
      </div>
    `).join('');
    $('#live-grid').querySelectorAll('[data-user]').forEach((el) => {
      el.addEventListener('click', () => openCreator(el.dataset.user));
    });
  } catch (e) {
    $('#live-empty').textContent = `Fehler: ${e.message}`;
    $('#live-empty').classList.remove('hidden');
  }
}

// ---- Leaderboard ----------------------------------------------------------

async function refreshLeaderboard() {
  const by = $('#lb-by').value;
  const days = $('#lb-days').value;
  const { rows, currency } = await api(`/api/leaderboard?by=${by}&days=${days}`);
  primaryCurrency = currency || primaryCurrency;
  const money = by === 'diamonds' || by === 'earnings' || by === 'amount';
  const fmtBy = money ? fmtMoney
    : by === 'gifts' ? fmtInt
    : (v) => 'Rang ' + fmtInt(v);
  $('#lb-current').textContent = by === 'rank' ? 'Rang' : money ? `Aktuell (${curLabel()})` : 'Aktuell';
  $('#lb-table tbody').innerHTML = rows.map((r, i) => {
    const moneyRow = money && r.revenue;
    const showVal = moneyRow ? moneyRow.value?.[curKey()] : r.value;
    const showDelta = moneyRow ? moneyRow.delta?.[curKey()] : r.delta ?? 0;
    const delta = showDelta ?? 0;
    const cls = by === 'rank' ? (delta < 0 ? 'up' : delta > 0 ? 'down' : '') : (delta > 0 ? 'up' : delta < 0 ? 'down' : '');
    const sign = delta > 0 ? '+' : '';
    return `<tr class="clickable" data-user="${esc(r.username)}">
      <td class="muted">${i + 1}</td>
      <td>@${esc(r.username)}</td>
      <td>${fmtBy(showVal)}</td>
      <td class="${cls}">${sign}${fmtBy(showDelta)}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="4" class="muted">Noch keine Snapshots — der Tracker sammelt die Historie stündlich.</td></tr>';
  $('#lb-table tbody').querySelectorAll('[data-user]').forEach((el) => {
    el.addEventListener('click', () => openCreator(el.dataset.user));
  });
}

// ---- Top-Spender + Kurse ---------------------------------------------------

async function refreshDonors() {
  const days = $('#do-days').value;
  const creator = $('#do-creator').value;
  const { rows, rates } = await api(`/api/donors?days=${days}${creator ? `&username=${encodeURIComponent(creator)}` : ''}`);
  $('#do-rates').textContent = `Kurse: ${rates.usdPerDiamondGross} $/Diamant brutto · ${rates.usdPerDiamondNet} $/Diamant netto · 1 $ = ${rates.usdToEur} €`;

  const select = $('#do-creator');
  const current = select.dataset.value ?? creator;
  select.innerHTML = '<option value="">Alle Creator</option>'
    + creators.map((c) => `<option value="${esc(c)}" ${c === current ? 'selected' : ''}>@${esc(c)}</option>`).join('');
  select.dataset.value = current;

  const fmtNet = (r) => {
    const usd = r.diamonds * rates.usdPerDiamondNet;
    return primaryCurrency === 'USD' ? fmtUsd(usd) : fmtEur(usd * rates.usdToEur);
  };
  $('#do-table tbody').innerHTML = rows.map((r, i) => `
    <tr>
      <td class="muted">${i + 1}</td>
      <td>@${esc(r.username)}${r.name ? ` <span class="muted">${esc(r.name)}</span>` : ''}</td>
      <td>${fmtInt(r.gifts)}</td>
      <td>${fmtInt(r.diamonds)}</td>
      <td>${fmtNet(r)}</td>
      <td>${r.creators_gifted}</td>
      <td class="muted">${esc((r.last_gift_at || '').replace('T', ' ').slice(0, 16))}</td>
    </tr>
  `).join('') || '<tr><td colspan="7" class="muted">Noch keine Gift-Events gesammelt — der Collector braucht einen Lauf von <code>creator_stream_events</code>.</td></tr>';
}

$('#do-days').addEventListener('change', refreshDonors);
$('#do-creator').addEventListener('change', () => {
  $('#do-creator').dataset.value = $('#do-creator').value;
  refreshDonors();
});

async function refreshRateForm() {
  const s = await api('/api/settings');
  const form = $('#rate-form');
  form.usd_per_diamond_gross.value = s.usdPerDiamondGross;
  form.usd_per_diamond_net.value = s.usdPerDiamondNet;
  form.usd_to_eur.value = s.usdToEur;
  form.primary_currency.value = s.primaryCurrency;
}

$('#rate-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  $('#rate-status').textContent = '';
  try {
    const res = await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        usd_per_diamond_gross: form.usd_per_diamond_gross.value,
        usd_per_diamond_net: form.usd_per_diamond_net.value,
        usd_to_eur: form.usd_to_eur.value,
        primary_currency: form.primary_currency.value
      })
    });
    if (!res.ok) throw new Error((await res.json()).error || res.status);
    $('#rate-status').textContent = 'Gespeichert.';
    primaryCurrency = (await res.json()).primaryCurrency;
  } catch (err) {
    $('#rate-status').textContent = `Fehler: ${err.message}`;
  }
});

// ---- Creator detail -------------------------------------------------------

async function refreshCreator() {
  const username = $('#cr-search').value.trim().replace(/^@/, '');
  if (!username) return;
  const data = await api(`/api/creator/${encodeURIComponent(username)}?days=7`);
  const trackBtn = $('#cr-track');
  trackBtn.classList.remove('hidden');
  trackBtn.textContent = data.tracked ? 'Entfolgen' : 'Tracken';
  trackBtn.onclick = () => setTracked(username, !data.tracked).then(refreshCreator).then(refreshTracked);
  $('#cr-empty').classList.toggle('hidden', Boolean(data.tracked));
  const p = data.profile;
  $('#cr-profile').innerHTML = `
    <div class="profile">
      ${p.avatar ? `<img src="${esc(p.avatar)}" alt="" />` : ''}
      <div class="facts">
        <div class="fact"><div class="v">@${esc(username)}</div><div class="l">${esc(p.name || '')}</div></div>
        <div class="fact"><div class="v">${p.rank ?? '—'}</div><div class="l">Globaler Rang</div></div>
        <div class="fact"><div class="v">${fmtInt(p.diamonds)}</div><div class="l">Diamonds</div></div>
        <div class="fact"><div class="v">${fmtUsd(p.earnings)}</div><div class="l">Earnings</div></div>
        <div class="fact"><div class="v">${esc(p.region || '—')}</div><div class="l">Region</div></div>
      </div>
    </div>`;

  $('#cr-charts').innerHTML = `
    <div class="chart"><h4>Diamonds während der aktiven Session</h4><canvas id="ch-session"></canvas></div>
    <div class="chart"><h4>Diamonds-Historie (7 Tage, Stundensnapshots)</h4><canvas id="ch-history"></canvas></div>`;

  if (data.active) {
    drawChart($('#ch-session'), data.active.curve.map((pt) => ({ v: pt.diamonds })), '#fe2c55');
  } else {
    drawChart($('#ch-session'), [], '#fe2c55');
  }
  drawChart($('#ch-history'), data.stats.filter((s) => s.diamonds !== null).map((s) => ({ v: s.diamonds, ts: s.ts })), '#4dd8e6');

  $('#cr-sessions tbody').innerHTML = data.sessions.map((s) => `
    <tr>
      <td>${esc((s.started_at || s.first_seen_at || '').replace('T', ' ').slice(0, 16))}</td>
      <td>${esc(s.duration || '—')}</td>
      <td>${fmtInt(s.diamonds)}</td>
      <td>${fmtUsd(s.revenue?.usdNet)} · ${fmtEur(s.revenue?.eurNet)}</td>
      <td>${fmtInt(s.gifts)}</td>
      <td>${fmtInt(s.viewers_peak)}</td>
      <td>${fmtInt(s.viewers_unique)}</td>
      <td>${s.ended_at ? '<span class="muted">beendet</span>' : '<span class="up">LIVE</span>'}</td>
    </tr>
  `).join('') || '<tr><td colspan="8" class="muted">Noch keine getrackten Sessions für diesen Creator.</td></tr>';
}

// ---- Boot -----------------------------------------------------------------

loadCurrency();
refreshHealth();
refreshLive();
refreshRateForm();
setInterval(refreshLive, 15_000);
setInterval(refreshHealth, 60_000);
