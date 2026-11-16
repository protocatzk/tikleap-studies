import { config } from './config.js';

const minIntervalMs = () => 1000 / config.rateLimitRps;
let lastRequestAt = 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function throttle() {
  const elapsed = Date.now() - lastRequestAt;
  const wait = minIntervalMs() - elapsed;
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();
}

function authHeaders() {
  const key = config.apiKey();
  if (config.authStyle === 'x-api-key') return { 'x-api-key': key };
  return { Authorization: `Bearer ${key}` };
}

export class ApiError extends Error {
  constructor(status, body, url) {
    super(`HTTP ${status} for ${url}: ${body.slice(0, 300)}`);
    this.status = status;
    this.body = body;
  }
}

export async function request(method, path, params = {}, { maxRetries = 5 } = {}) {
  const url = new URL(path, config.baseUrl);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }

  let attempt = 0;
  for (;;) {
    await throttle();
    const response = await fetch(url, {
      method,
      headers: { ...authHeaders(), Accept: 'application/json' },
      signal: AbortSignal.timeout(30_000)
    });

    if (response.ok) {
      return response.json();
    }

    const retryable = response.status === 429 || response.status === 503 || response.status >= 500;
    if (!retryable || attempt >= maxRetries) {
      throw new ApiError(response.status, await response.text(), url.toString());
    }

    const retryAfter = Number(response.headers.get('retry-after'));
    const backoff = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000
      : Math.min(2 ** attempt * 1000, 60_000);
    console.warn(`WARN ${response.status} on ${url.pathname}, retry in ${backoff}ms (attempt ${attempt + 1}/${maxRetries})`);
    await sleep(backoff);
    attempt += 1;
  }
}

export function getPathValue(obj, path) {
  if (!path) return undefined;
  return String(path)
    .split('.')
    .reduce((acc, key) => (acc === null || acc === undefined ? undefined : acc[key]), obj);
}
