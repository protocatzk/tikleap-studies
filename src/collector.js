import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { request, getPathValue } from './api.js';
import { saveItems, saveRaw, markSync } from './db.js';

export function loadEndpoints() {
  const file = resolve(process.cwd(), 'config/endpoints.json');
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  return parsed.endpoints.filter((e) => e.enabled);
}

function resolveParams(spec, context) {
  const params = {};
  for (const [key, value] of Object.entries(spec || {})) {
    if (Array.isArray(value)) {
      params[key] = value;
    } else if (typeof value === 'string') {
      params[key] = value in context ? context[value] : value;
    } else {
      params[key] = value;
    }
  }
  return params;
}

function expandParams(params) {
  const keys = Object.keys(params);
  const combos = [{}];
  for (const key of keys) {
    const value = params[key];
    const values = Array.isArray(value) ? value : [value];
    const next = [];
    for (const base of combos) {
      for (const v of values) next.push({ ...base, [key]: v });
    }
    combos.length = 0;
    combos.push(...next);
  }
  return combos;
}

function fillPath(path, params) {
  return path.replace(/\{(\w+)\}/g, (_, key) => encodeURIComponent(params[key] ?? ''));
}

async function fetchPage(endpoint, pathParams) {
  const path = fillPath(endpoint.path, pathParams);
  const baseParams = { ...pathParams };
  Object.keys(baseParams).forEach((k) => {
    if (endpoint.path.includes(`{${k}}`)) delete baseParams[k];
  });
  return request(endpoint.method || 'GET', path, baseParams);
}

export async function runEndpoint(endpoint, { maxPages = 50 } = {}) {
  const context = {
    today: new Date().toISOString().slice(0, 10),
    yesterday: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
  };
  const paramSpec = resolveParams(endpoint.params, context);
  const combos = expandParams(paramSpec);

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
      const fresh = list.filter((item) => {
        const key = (endpoint.itemKeyFields || []).map((f) => item[f]).join(':') || JSON.stringify(item);
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
  console.log(`OK ${endpoint.name}: ${total} items upserted`);
  return total;
}
