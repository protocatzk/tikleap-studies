import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { request, getPathValue } from './api.js';
import { saveItems, saveRaw, markSync, sourceCombos } from './db.js';

export function loadEndpoints() {
  const file = resolve(process.cwd(), 'config/endpoints.json');
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  return parsed.endpoints.filter((e) => e.enabled);
}

function resolveTemplate(value, context) {
  return typeof value === 'string' && value in context ? context[value] : value;
}

function paramParts(spec, key, context) {
  const value = spec[key];
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return sourceCombos(value);
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) =>
      entry && typeof entry === 'object' ? sourceCombos(entry) : [{ [key]: resolveTemplate(entry, context) }]
    );
  }
  return [{ [key]: resolveTemplate(value, context) }];
}

export function expandParams(spec, context = {}) {
  let combos = [{}];
  for (const key of Object.keys(spec || {})) {
    const parts = paramParts(spec, key, context);
    const next = [];
    for (const base of combos) {
      for (const part of parts) {
        next.push({ ...base, ...part });
      }
    }
    combos = next;
  }
  const seen = new Set();
  return combos.filter((combo) => {
    const serialized = JSON.stringify(combo);
    if (seen.has(serialized)) return false;
    seen.add(serialized);
    return true;
  });
}

function fillPath(path, params) {
  return path.replace(/\{(\w+)\}/g, (_, key) => encodeURIComponent(params[key] ?? ''));
}

function pathParamKeys(path) {
  return [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
}

async function fetchPage(endpoint, params) {
  const path = fillPath(endpoint.path, params);
  const query = { ...params };
  for (const key of pathParamKeys(endpoint.path)) delete query[key];
  return request(endpoint.method || 'GET', path, query);
}

export async function runEndpoint(endpoint, { maxPages = 50 } = {}) {
  const context = {
    today: new Date().toISOString().slice(0, 10),
    yesterday: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
  };
  const combos = expandParams(endpoint.params, context);
  if (combos.length === 0) {
    console.log(`SKIP ${endpoint.name}: no parameter combos (source endpoints empty yet?)`);
    markSync(endpoint.name, 'skipped', 0);
    return 0;
  }

  const pathKeys = pathParamKeys(endpoint.path);
  let total = 0;
  for (const combo of combos) {
    let cursor;
    let pages = 0;
    const seen = new Set();
    do {
      const params = { ...combo };
      if (cursor !== undefined) params[endpoint.pagination?.cursorParam || 'cursor'] = cursor;

      const payload = await fetchPage(endpoint, params);
      saveRaw(endpoint.name, endpoint.path, params, payload);

      const items = getPathValue(payload, endpoint.itemsPath);
      const list = Array.isArray(items) ? items : items ? [items] : [];
      const enriched = list.map((item) => {
        const injected = {};
        for (const key of pathKeys) injected[key] = combo[key];
        return { _params: injected, ...item };
      });
      const fresh = enriched.filter((item) => {
        const values = (endpoint.itemKeyFields || []).map((f) => getPathValue(item, f));
        const key = values.every((v) => v !== undefined && v !== null) ? values.join(':') : JSON.stringify(item);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      total += saveItems(endpoint.name, fresh, endpoint.itemKeyFields || []);

      cursor = endpoint.pagination ? getPathValue(payload, endpoint.pagination.cursorPath) : undefined;
      const hasMore = endpoint.pagination ? getPathValue(payload, endpoint.pagination.hasMorePath) : undefined;
      pages += 1;

      if (endpoint.pagination && hasMore === false) break;
      if (pages >= maxPages) {
        console.warn(`WARN ${endpoint.name}: hit maxPages=${maxPages}, stopping pagination`);
        break;
      }
    } while (cursor !== undefined && cursor !== null && cursor !== '');
  }

  markSync(endpoint.name, 'ok', total);
  console.log(`OK ${endpoint.name}: ${total} items upserted (${combos.length} combos)`);
  return total;
}
