# tikleap-studies

Config-driven Node.js-Collector für die Tikleap-API. Füllt eine SQLite-Datenbank (idempotent, mehrfach lauffähig), damit danach ein Dashboard (Metabase/Grafana oder eigenes React-Frontend) aufgesetzt werden kann.

Benötigt Node >= 23.4 (nutzt das eingebaute `node:sqlite`, keine nativen Abhängigkeiten mehr).

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

## toktracker

Parallelprojekt in diesem Repo: Live-Tracking und Statistik-Historie über die Tikleap-API, mit eigener UI.

```bash
npm run toktracker   # Tracker + UI auf http://127.0.0.1:3100
```

- **Tracking-Liste** (`tt_tracked`): getrackt werden nur explizit hinzugefügte Streamer – per UI (Tab „Tracking", mit Vorschlägen aus den Collector-Daten, Einzel- oder Bulk-Add über Textfeld/„Alle Vorschläge tracken") oder API (`GET/POST/DELETE /api/tracked`, `POST` akzeptiert `{username}` oder `{usernames: [...]}`, idempotent, `@` wird ignoriert). Beim Entfolgen werden offene Sessions dichtgemacht.
- **Tracker** (`src/toktracker/tracker.js`): pollt `GET /creators/{username}/streams` für alle **getrackten** Usernames in *gestuften Intervallen* – aktuell live: 60 s, in den letzten 24 h live gewesen: 5 min, sonst: 30 min. Pro Tick werden maximal `TOKTRACKER_MAX_REQUESTS_PER_TICK` Requests verbraucht. Jeder Live-Stream wird als Snapshot in die Zeitreihe geschrieben und als Session registriert (Start, Ende, Peak, kumulative Diamonds/Earnings/Gifts/Likes). Alle 5 Minuten wird für Live-Creator zusätzlich `live-video` geholt und die HLS-URL der Session gespeichert.
- **Statistik-Snapshots** (`tt_creator_snapshots`): stündlich werden Rang/Earnings/Diamonds aus `records` in Historientabellen kopiert – daraus berechnen Leaderboard-Deltas und Creator-Charts.
- **Historie-Import**: beim Start (und beim Tracken neuer Streamer) werden beendete Streams aus den Collector-Sweeps (`creator_stream_details` mit `ended_at`, inkl. Final-Stats und Events) als abgeschlossene Sessions in `tt_live_sessions` übernommen. Wichtig: die Tikleap-Exposure-Liste `GET /creators/{username}/streams` enthält nur den *aktuellen* Stream – echte Historie entsteht daher erst ab Sammelbeginn; Vor-Backfill ist API-seitig nicht möglich. Chart-Metrik „Diamonds je Session" zeigt sowohl gemessene als auch importierte Sessions.

### Datenmodell (Zusatztabellen in derselben SQLite-Datei)

- `tt_stream_snapshots` – eine Zeile pro Live-Stream pro Poll (append-only Zeitreihe)
- `tt_live_sessions` – eine Zeile pro erkannter Live-Session `(username, stream_id)`
- `tt_creator_snapshots` – stündliche Statistik-Historie pro Creator
- `tt_tracker_errors` – Fehlerlog des Trackers
- `tt_tracked` – getrackte Streamer (Tracking-Liste)

### toktracker-UI/API

```bash
GET /api/health                # Tracker-Status
GET /api/live                  # aktuell live: Session-Dauer, Diamonds/min, Peak, Unique
GET /api/leaderboard?by=&days= # Deltas über den Zeitraum (diamonds|earnings|amount|gifts|rank)
GET /api/watchlist?days=       # meiste Diamonds der letzten Tage
GET /api/sessions?username=    # abgeschlossene Sessions
GET /api/creator/:username     # Profil, Sessions, aktiver Session-Verlauf, Stundensnapshots
GET /api/tracked               # Tracking-Liste + Vorschläge
POST /api/tracked              # {username} oder {usernames: [...]} (Bulk) hinzufügen
DELETE /api/tracked/:username  # entfolgen (schließt offene Session)
GET /api/charts?metric=&days=  # Zeitreihe (diamonds|earnings) je getracktem Streamer aus tt_creator_snapshots
GET /api/donors?days=&username= # Top-Spender, aggregiert aus creator_stream_events (type=gift)
GET /api/settings               # Kurse (brutto/netto USD pro Diamond, EUR-Kurs, Primärwährung)
PUT /api/settings               # Kurse zur Laufzeit überschreiben (persistiert in tt_settings)
```

### Finanzschicht

Wie im Python-Original werden zwei Betragsebenen getrennt:

- **Brutto** = Zuschauer-Ausgaben (`earnings_before_commission` der Tikleap-API, sonst `diamonds × usd_per_diamond_gross`)
- **Netto** = Creator-Auszahlung (`earnings` der Tikleap-API, sonst `diamonds × usd_per_diamond_net`)

Beide werden mit dem konfigurierbaren EUR-Kurs umgerechnet und in der UI sowie allen API-Antworten (`revenue`-Objekt mit `usdNet`, `usdGross`, `eurNet`, `eurGross`) mitgeführt. Kurse stehen in `tt_settings` und lassen sich im Tab „Top-Spender" oder per `PUT /api/settings` ändern.

Nicht Teil der Node-Umsetzung: direkter TikTok-Live-WebSocket-Ingest, Telegram-Bot und Redis/Sharding – die Tikleap-API ist reines REST-Polling; der Tracker ersetzt den Echtzeit-Stream durch gestuftes Polling (60 s / 5 min / 30 min).
```

Hinweis: Die API liefert keinen *aktuellen* Viewer-Count – `viewers_peak`/`viewers_unique` sind kumulativ je Session. Die UI zeigt daher Diamonds/min als Live-Trend, abgeleitet aus aufeinanderfolgenden Snapshots.
