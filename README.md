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

## Endpunkte

Vorkonfiguriert sind die Tikleap-Endpunkte in `config/endpoints.json`:

- `GET /global-rankings`, `GET /gifters` – Einstiegspunkte und Quelle der Usernamens
- `GET /gifters/{username}`, `GET /gifters/{username}/gift-gallery[/{period}]` – Gifter-Profile und Galerien
- `GET /creators/{username}/streams`, `.../streams/{stream_id}`, `.../streams/{stream_id}/events` – Streams und Events pro Creator
- `GET /creators/{username}/live-video` – aktueller Live-Status
- `GET /search` (deaktiviert, bis Suchbegriffe/Query-Param feststehen), `POST /creators/{username}/streams` (deaktiviert, Schreibaktion)

Konfiguration pro Endpunkt:

- `path`: URL-Pfad, Platzhalter wie `{username}`/`{stream_id}` werden aus `params` gefüllt
- `params`: feste Werte, Arrays (ein Request pro Wert) oder `{today}`/`{yesterday}`
- Verkettung: `{ "fromEndpoint": "gifters", "fields": { "username": "username" } }` holt Werte aus bereits gesammelten Items – so laufen z.B. Creator-Endpunkte automatisch über alle bekannten Usernamens. Mehrere Felder (z.B. `username` + `stream_id` aus `creator_streams`) werden als Paar kombiniert. Gespeicherte Items enthalten ihre Pfad-Parameter unter `_params`.
- `pagination`: `cursorParam` (Query-Param), `cursorPath`/`hasMorePath` (JSON-Pfade in der Response)
- `itemsPath`: JSON-Pfad zur Item-Liste, `itemKeyFields`: Felder, die ein Item eindeutig machen (Upsert-Key)
- `schedule`: cron-Ausdruck für den Dauerbetrieb

Noch unbekannt aus der Doku: exakte Response-Struktur (`itemsPath`, Cursor-Felder) und die Perioden-Werte für `gift-gallery/{period}` – bei Bedarf in `config/endpoints.json` anpassen.

## Datenmodell (SQLite, `DB_PATH`)

- `records` – ein Row pro Item, eindeutig pro `(endpoint, item_key)`, Upsert bei erneutem Lauf
- `raw_responses` – Rohantworten als Archiv (nützlich, wenn Felder nachträglich gemappt werden sollen)
- `sync_state` – letzter Lauf, Status und Item-Anzahl pro Endpunkt

## Dashboard

Nach dem ersten Sammeln (`npm run collect`) startet das Dashboard lokal auf `http://127.0.0.1:3000` (Port via `DASHBOARD_PORT` änderbar, lauscht nur auf Loopback):

```bash
npm run dashboard
```

Es zeigt Items pro Endpunkt als Chart, den Sync-Status je Endpunkt und einen Record-Browser mit Pagination. Die REST-API dahinter:

- `GET /api/summary` – Item-Anzahlen und Sync-Status pro Endpunkt
- `GET /api/endpoints` – Liste der gesammelten Endpunkte
- `GET /api/records/:endpoint?limit=&offset=` – Records mit geparstem JSON

Sobald die echten Felder der Tikleap-Responses bekannt sind, lässt sich die UI um konkrete Charts erweitern (Top-Gifter, Earnings über Zeit etc.). Alternativ kann jede BI-Tools (Metabase/Grafana) direkt auf die SQLite-Datei in `DB_PATH` verbunden werden.

## Verhalten

- Rate-Limit: `TIKLEAP_RATE_LIMIT_RPS` (Default 1 req/s), respektiert `Retry-After`
- Retry mit exponentiellem Backoff bei 429/5xx, harter Fehler bei 4xx
- Idempotent: erneute Läufe updaten vorhandene Items statt Duplikate anzulegen
