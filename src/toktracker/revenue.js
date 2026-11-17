import { db } from '../db.js';

// Finance layer, ported from toktracker's shared/revenue.py concept:
// gross = what viewers spent (pre-commission), net = what the creator receives.
// rates live in tt_settings so they can be tuned at runtime without a restart.

db.exec(`
  CREATE TABLE IF NOT EXISTS tt_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
`);

export const RATE_KEYS = {
  usd_per_diamond_gross: '0.01',
  usd_per_diamond_net: '0.005',
  usd_to_eur: '0.92',
  primary_currency: 'EUR'
};

const selectAll = db.prepare('SELECT key, value FROM tt_settings');

export function getSettings() {
  const stored = Object.fromEntries(selectAll.all().map((row) => [row.key, row.value]));
  const settings = { ...RATE_KEYS };
  for (const key of Object.keys(RATE_KEYS)) if (stored[key] !== undefined) settings[key] = stored[key];
  return {
    usdPerDiamondGross: Number(settings.usd_per_diamond_gross) || Number(RATE_KEYS.usd_per_diamond_gross),
    usdPerDiamondNet: Number(settings.usd_per_diamond_net) || Number(RATE_KEYS.usd_per_diamond_net),
    usdToEur: Number(settings.usd_to_eur) || Number(RATE_KEYS.usd_to_eur),
    primaryCurrency: settings.primary_currency === 'USD' ? 'USD' : 'EUR'
  };
}

const upsertSetting = db.prepare(`
  INSERT INTO tt_settings (key, value) VALUES (?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
`);

export function setSetting(key, value) {
  if (!(key in RATE_KEYS)) throw new Error(`Unknown setting: ${key}`);
  if (key !== 'primary_currency') {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) throw new Error(`${key} must be a non-negative number`);
    upsertSetting.run(key, String(n));
  } else {
    if (value !== 'USD' && value !== 'EUR') throw new Error('primary_currency must be USD or EUR');
    upsertSetting.run(key, value);
  }
  return getSettings();
}

const round4 = (n) => Math.round(n * 10000) / 10000;

// Map a Tikleap stream/session row (diamonds, earnings, earnings_before_commission)
// to the four money figures. API-provided values win over rate-based estimates.
export function revenueFor(row, settings = getSettings()) {
  const diamonds = Number(row.diamonds);
  const hasDiamonds = Number.isFinite(diamonds);
  if (!hasDiamonds && row.earnings == null && row.earnings_before_commission == null) return null;

  const netUsd = row.earnings != null
    ? Number(row.earnings)
    : hasDiamonds ? diamonds * settings.usdPerDiamondNet : null;
  const grossUsd = row.earnings_before_commission != null
    ? Number(row.earnings_before_commission)
    : hasDiamonds ? diamonds * settings.usdPerDiamondGross : null;

  return {
    usdNet: netUsd == null ? null : round4(netUsd),
    usdGross: grossUsd == null ? null : round4(grossUsd),
    eurNet: netUsd == null ? null : round4(netUsd * settings.usdToEur),
    eurGross: grossUsd == null ? null : round4(grossUsd * settings.usdToEur)
  };
}
