# tikleap-studies

Config-driven Node.js-Collector für die Tikleap-API. Füllt eine SQLite-Datenbank (idempotent, mehrfach lauffähig), damit danach ein Dashboard (Metabase/Grafana oder eigenes React-Frontend) aufgesetzt werden kann.

## Setup

```bash
npm install
cp .env.example .env   # TIKLEAP_API_KEY eintragen (Key NIE committen)
```

## Verwendung

```bash
npm run collect    # einmalig alle aktiven Endpunkte ziehen
npm run backfill   # Backfill: zieht für datumsparametrisierte Endpunkte die letzten 30 Tage
npm start          # Scheduler: läuft und führt Endpunkte nach ihrem cron-Schedule aus
```

## Endpunkte konfigurieren

Alle Endpunkte stehen in `config/endpoints.json` – dort `path`, `params`, Paginierung und cron-Schedule an die offizielle Tikleap-API-Doku anpassen:

- `path`: URL-Pfad, Platzhalter `{country}` o.ä. werden aus `params` gefüllt
- `params`: feste Werte, Arrays (wird zu einem Request pro Wert) oder `{today}`/`{yesterday}`
- `pagination`: `cursorParam` (Query-Param), `cursorPath`/`hasMorePath` (JSON-Pfade in der Response)
- `itemsPath`: JSON-Pfad zur Item-Liste, `itemKeyFields`: Felder, die ein Item eindeutig machen (Upsert-Key)
- `schedule`: cron-Ausdruck für den Dauerbetrieb

## Datenmodell (SQLite, `DB_PATH`)

- `records` – ein Row pro Item, eindeutig pro `(endpoint, item_key)`, Upsert bei erneutem Lauf
- `raw_responses` – Rohantworten als Archiv (nützlich, wenn Felder nachträglich gemappt werden sollen)
- `sync_state` – letzter Lauf, Status und Item-Anzahl pro Endpunkt

## Verhalten

- Rate-Limit: `TIKLEAP_RATE_LIMIT_RPS` (Default 1 req/s), respektiert `Retry-After`
- Retry mit exponentiellem Backoff bei 429/5xx, harter Fehler bei 4xx
- Idempotent: erneute Läufe updaten vorhandene Items statt Duplikate anzulegen
