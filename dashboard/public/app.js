const PAGE_SIZES = [25, 50, 100, 200];
const state = {
  endpoints: [],
  records: { endpoint: null, offset: 0, q: '', pageSize: 50 },
  autoRefreshTimer: null
};

// ---------- helpers ----------

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return response.json();
}

const $ = (sel) => document.querySelector(sel);
const el = (id) => document.getElementById(id);
const esc = (text) => String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function fmtDateTime(value) {
  if (!value) return '—';
  return value.replace('T', ' ').replace('Z', '');
}

function fmtNumber(value) {
  if (value === null || value === undefined) return '—';
  return Number(value).toLocaleString('de-DE');
}

function badge(status) {
  const cls = status === 'ok' ? 'ok' : status === 'skipped' ? 'warn' : 'bad';
  return `<span class="badge ${cls}">${esc(status)}</span>`;
}

let countsChart = null;
let facetChart = null;

function renderBar(canvasId, labels, data, existingChart) {
  if (existingChart) existingChart.destroy();
  return new Chart(el(canvasId), {
    type: 'bar',
    data: {
      labels,
      datasets: [{ label: 'Anzahl', data, backgroundColor: '#4f8cff' }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: { x: { ticks: { color: '#9aa3b2' }, grid: { display: false } }, y: { ticks: { color: '#9aa3b2' } } }
    }
  });
}

// ---------- tabs ----------

document.querySelectorAll('#tabs button').forEach((button) => {
  button.addEventListener('click', () => {
    document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b === button));
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === `tab-${button.dataset.tab}`));
  });
});

// ---------- overview ----------

async function loadOverview() {
  const { totals, counts, sync } = await fetchJson('/api/summary');

  const lastOk = sync.filter((s) => s.last_status === 'ok').map((s) => s.last_run_at).sort().at(-1);
  el('kpi-bar').innerHTML = [
    { label: 'Records gesamt', value: fmtNumber(totals.records), warn: totals.records === 0 && 'Noch keine Daten gesammelt' },
    { label: 'Raw-Payloads', value: fmtNumber(totals.raws) },
    { label: 'Endpunkte mit Daten', value: `${totals.endpoints}` },
    { label: 'Sync-Probleme', value: `${totals.problems}`, warn: totals.problems > 0 },
    { label: 'Letzter OK-Lauf', value: fmtDateTime(lastOk) === '—' ? 'nie' : fmtDateTime(lastOk), warn: !lastOk }
  ].map((kpi) => `
    <div class="kpi ${kpi.warn ? 'warn' : ''}">
      <div class="value">${esc(kpi.value)}</div>
      <div class="label">${esc(kpi.label)}</div>
    </div>`).join('');

  if (totals.records === 0) {
    el('counts-chart').closest('.bar').innerHTML =
      '<div class="empty">Noch keine Records. Der Collector hat noch keinen erfolgreichen API-Lauf ' +
      '(z.&nbsp;B. weil die API regional/Netzwerk-blockiert ist). Der Auto-Run füllt die Tabellen, sobald ' +
      'erstmals HTTP 200 kommt.</div>';
  } else {
    countsChart = renderBar('counts-chart', counts.map((c) => c.endpoint), counts.map((c) => c.items), countsChart);
  }

  el('sync-table').querySelector('tbody').innerHTML = sync.map((s) => `
    <tr>
      <td>${esc(s.endpoint)}</td>
      <td>${esc(fmtDateTime(s.last_run_at))}</td>
      <td>${badge(s.last_status)}</td>
      <td>${esc(s.items_upserted)}</td>
    </tr>`).join('');
}

// ---------- health ----------

async function loadHealth() {
  try {
    const health = await fetchJson('/api/health');
    el('health').textContent = `DB ok · letzte Aktivität: ${fmtDateTime(health.lastActivity) || 'nie'} · Node ${health.node}`;
  } catch {
    el('health').textContent = 'API nicht erreichbar';
  }
}

// ---------- endpoints tab ----------

async function loadEndpointSelects() {
  const endpoints = await fetchJson('/api/endpoints');
  state.endpoints = endpoints;
  const options = endpoints.length
    ? endpoints.map((e) => `<option>${esc(e)}</option>`).join('')
    : '<option value="">— keine Endpunkte mit Daten —</option>';
  for (const id of ['endpoint-select', 'facet-endpoint', 'raw-endpoint']) el(id).innerHTML = options;
}

async function loadRecords() {
  const { endpoint, offset, q, pageSize } = state.records;
  const list = el('records-table').querySelector('tbody');
  if (!endpoint) {
    list.innerHTML = '<tr><td colspan="3" class="empty">Keine Endpunkte mit Daten vorhanden.</td></tr>';
    el('page-info').textContent = '';
    return;
  }
  const { total, rows } = await fetchJson(
    `/api/records/${encodeURIComponent(endpoint)}?limit=${pageSize}&offset=${offset}&q=${encodeURIComponent(q)}`
  );

  if (rows.length === 0) {
    list.innerHTML = `<tr><td colspan="3" class="empty">Keine Treffer.</td></tr>`;
  } else {
    list.innerHTML = rows.map((row) => {
      const preview = JSON.stringify(row.data);
      return `
        <tr>
          <td class="row-key">${esc(row.item_key)}</td>
          <td>${esc(fmtDateTime(row.fetched_at))}</td>
          <td><div class="row-cell" title="Klicken für vollständiges JSON">${esc(preview)}</div></td>
        </tr>`;
    }).join('');
    list.querySelectorAll('.row-cell').forEach((cell, i) => {
      cell.addEventListener('click', () => showDialog(rowKey(rows[i]), rows[i].data));
    });
  }

  const page = Math.floor(offset / pageSize) + 1;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  el('page-info').textContent = `Seite ${page} / ${pages} · ${fmtNumber(total)} Rows`;
  el('prev').disabled = offset === 0;
  el('next').disabled = offset + pageSize >= total;
}

const rowKey = (row) => row.item_key;

function showDialog(title, data) {
  el('json-title').textContent = title;
  el('json-view').textContent = JSON.stringify(data, null, 2);
  el('json-dialog').showModal();
}

function bindEndpointControls() {
  el('endpoint-select').addEventListener('change', () => {
    state.records.endpoint = el('endpoint-select').value;
    state.records.offset = 0;
    loadRecords();
  });
  let searchTimer = null;
  el('endpoint-search').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.records.q = el('endpoint-search').value;
      state.records.offset = 0;
      loadRecords();
    }, 300);
  });
  el('page-size').addEventListener('change', () => {
    state.records.pageSize = Number(el('page-size').value);
    state.records.offset = 0;
    loadRecords();
  });
  el('prev').addEventListener('click', () => {
    state.records.offset = Math.max(0, state.records.offset - state.records.pageSize);
    loadRecords();
  });
  el('next').addEventListener('click', () => {
    state.records.offset += state.records.pageSize;
    loadRecords();
  });
}

// ---------- explorer tab ----------

async function loadFieldSelects() {
  const endpoint = el('facet-endpoint').value;
  const fieldSelects = [el('facet-field'), el('metric-field')];
  if (!endpoint) {
    for (const sel of fieldSelects) sel.innerHTML = '<option value="">— kein Endpunkt —</option>';
    return;
  }
  const { rows } = await fetchJson(`/api/records/${encodeURIComponent(endpoint)}?limit=1`);
  const fields = collectFields(rows[0]?.data, '', new Set());
  const options = [...fields]
    .sort()
    .map((f) => `<option value="${esc(f)}">${esc(f)}</option>`)
    .join('');
  for (const sel of fieldSelects) sel.innerHTML = options || '<option value="">— keine Felder —</option>';
}

function collectFields(obj, prefix, out, depth = 0) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj) || depth > 2) return out;
  for (const [key, value] of Object.entries(obj)) {
    if (key === '_params') continue;
    const path = prefix ? `${prefix}.${key}` : key;
    out.add(path);
    if (typeof value === 'object') collectFields(value, path, out, depth + 1);
  }
  return out;
}

async function loadFacet() {
  const endpoint = el('facet-endpoint').value;
  const field = el('facet-field').value;
  if (!endpoint || !field) return;
  const { rows } = await fetchJson(
    `/api/facets/${encodeURIComponent(endpoint)}?field=${encodeURIComponent(field)}`
  );
  if (rows.length === 0 || rows.every((r) => r.value === '(fehlt)')) {
    facetChart?.destroy();
    facetChart = null;
    el('facet-chart').closest('.bar').innerHTML =
      `<div class="empty">Feld "${esc(field)}" ist in diesem Endpunkt leer oder fehlt.</div>`;
    return;
  }
  facetChart = renderBar('facet-chart', rows.map((r) => r.value), rows.map((r) => r.n), facetChart);
}

async function loadMetrics() {
  const tbody = el('metrics-table').querySelector('tbody');
  const endpoint = el('facet-endpoint').value;
  const field = el('metric-field').value;
  if (!endpoint || !field) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty">Endpunkt und numerisches Feld wählen.</td></tr>';
    return;
  }
  const { metrics } = await fetchJson(`/api/metrics/${encodeURIComponent(endpoint)}?field=${encodeURIComponent(field)}`);
  const cells = ['n', 'sum', 'avg', 'min', 'max'].map((k) => `<td>${esc(fmtNumber(metrics[k]))}</td>`).join('');
  tbody.innerHTML = `<tr>${cells}</tr>`;
}

function bindExplorerControls() {
  el('facet-endpoint').addEventListener('change', loadFieldSelects);
  el('facet-load').addEventListener('click', loadFacet);
  el('metric-load').addEventListener('click', loadMetrics);
}

// ---------- raw tab ----------

async function loadRaw() {
  const endpoint = el('raw-endpoint').value;
  const list = el('raw-list');
  if (!endpoint) {
    list.innerHTML = '<div class="empty">Keine Endpunkte vorhanden.</div>';
    return;
  }
  const { total, rows } = await fetchJson(`/api/raw/${encodeURIComponent(endpoint)}`);
  if (rows.length === 0) {
    list.innerHTML = `
      <div class="empty">
        Keine Raw-Payloads für "${esc(endpoint)}" gespeichert. raw_responses wird nur gefüllt,
        wenn der Collector endlich HTTP 200 von der API bekommt.
      </div>`;
    return;
  }
  list.innerHTML = rows.map((row) => `
    <div class="raw-item">
      <div class="raw-meta">#${row.id} · ${esc(fmtDateTime(row.fetched_at))} · ${esc(row.url)}</div>
      <pre class="row-json">${esc(JSON.stringify(row.payload, null, 2).slice(0, 4000))}</pre>
    </div>`).join('') + (total > rows.length ? `<div class="empty">${fmtNumber(total - rows.length)} weitere ältere Runs nicht angezeigt.</div>` : '');
}

function bindRawControls() {
  el('raw-load').addEventListener('click', loadRaw);
}

// ---------- refresh ----------

async function refreshAll() {
  el('refresh').disabled = true;
  try {
    await Promise.all([loadHealth(), loadOverview()]);
  } catch (error) {
    el('health').textContent = `Refresh fehlgeschlagen: ${error.message}`;
  } finally {
    el('refresh').disabled = false;
  }
}

el('refresh').addEventListener('click', refreshAll);
el('auto-refresh').addEventListener('change', () => {
  if (state.autoRefreshTimer) clearInterval(state.autoRefreshTimer);
  state.autoRefreshTimer = el('auto-refresh').checked ? setInterval(refreshAll, 10_000) : null;
});

// ---------- init ----------

await loadEndpointSelects();
state.records.endpoint = state.endpoints[0] || null;
bindEndpointControls();
bindExplorerControls();
bindRawControls();
await refreshAll();
await loadRecords();
await loadFieldSelects();
