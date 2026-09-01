# In-House Analytics Implementation Plan

A step-by-step plan to build simple in-house analytics that records user traffic.
This document is written to be executed by an AI model or an engineer. It is
**stack-agnostic**: any web app with a UI layer, a gateway/BFF layer, a backend
API, and a database can implement it.

---

## 0. How to read and use this document

> **Instructions for the AI model or engineer implementing this plan.**

1. Implement the layers in the order given: **Layer 1 → Layer 2 → Layer 3 → Layer 4**, then metrics.
2. `ALL_CAPS_IN_ANGLE_BRACKETS` like `<AUTH_CONTEXT>` are **placeholders**. Replace them with the real value for your stack.
3. Do **not** invent new event fields or event types. Use only the ones defined in Section 3.
4. If a small detail is not specified (e.g. exact buffer size), pick the simplest reasonable default and keep it consistent everywhere.
5. Every layer ends with a **Definition of Done** checklist. Do not move to the next layer until all boxes are satisfied.
6. Never trust the client for identity. `user_id` and `user_domain` are always determined on the server from the authenticated session (see Section 5).

### 0.1 Terminology (used throughout)

| Term | Meaning |
|------|---------|
| **Event** | One recorded thing that happened (a page was opened, a button was clicked, a session started). |
| **Session** | A continuous period of app usage by one user. Ends after inactivity or when the app closes. |
| **user_id** | Stable unique identifier of the logged-in user. Comes from the auth system. |
| **user_domain** | The business domain / group the user belongs to (examples: `Cash`, `COO`, `DFT`, `Delivery`). Comes from the auth system, not typed by the user. |
| **page / route** | A distinct screen in the app. In a single-page app this is a route change, not a full browser reload. |
| **dwell time** | How long a user stayed on one page. |
| **DAU / MAU** | Daily Active Users / Monthly Active Users. |

### 0.2 Reference architecture (map your stack onto these 4 roles)

```
[ UI LAYER ]  --send events-->  [ GATEWAY LAYER ]  --forward-->  [ BACKEND LAYER ]  --write-->  [ DATABASE ]
 captures                        enriches with                    validates &                    stores raw
 raw events                      server identity                  persists                       events

Example concrete mapping (adapt to your stack):
  UI LAYER      = plugin-ui        (TypeScript / Lit)
  GATEWAY LAYER = experience-api   (GraphQL)
  BACKEND LAYER = process-api      (REST)
  DATABASE      = lpp              (database schema)

Flow: UI --(GraphQL mutation)--> GATEWAY --(REST call)--> BACKEND --(SQL insert)--> DATABASE
```

If your app has fewer layers (e.g. no separate gateway), merge the responsibilities but keep the same rules, especially server-side identity enrichment.

---

## 1. Goals: the metrics and what data each one needs

Each requested metric is listed with the **exact data it requires**. If the data column is captured, the metric is computable.

| # | Metric | Definition | Data required |
|---|--------|-----------|---------------|
| 1a | **Last login** | Timestamp of each user's most recent login | `login` event with `user_id`, `server_timestamp` |
| 1b | **Retention rate** | % of users from a start group who return N days later | daily active `user_id`s over time |
| 2a | **DAU** | Distinct users active on a given calendar day | any event with `user_id`, `server_timestamp` |
| 2b | **MAU** | Distinct users active in a given month | same as DAU |
| 3 | **Domain usage** | Which `user_domain` uses the app most | events grouped by `user_domain` |
| 4 | **User journey** | Ordered pages visited and actions taken | `page_enter`, `page_exit`, `action` events with `session_id`, `server_timestamp` |
| 5 | **Session duration** | How long a user used the app in one sitting | `session_start` … `session_end` (or first…last event) per `session_id` |
| 6 | **Page dwell time** | How long a user stayed on one page | `page_enter` + `page_exit` with duration per page |

**Conclusion:** every metric above is produced from **one stream of events** with a shared schema. Build the event stream once; compute all metrics from it. Do **not** build a separate pipeline per metric.

---

## 2. The core idea (one paragraph)

The UI captures small **events** as the user interacts. Events are **buffered** and sent in **batches** to the gateway. The gateway **enriches** each event with the trusted server identity (`user_id`, `user_domain`) and a **server timestamp**, then forwards them to the backend. The backend **validates** and **writes** them to one table. All metrics are then simple **queries or scheduled roll-ups** over that table.

---

## 3. The canonical event schema (THE CONTRACT — do not deviate)

Every event, of every type, uses the same envelope. Event-specific data goes inside `properties`.

### 3.1 Event envelope

**Fields sent by the UI (client):**

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `event_id` | UUID (v4) | yes | Generated on the client. Used to remove duplicates. |
| `event_type` | string enum | yes | One of the types in 3.2. |
| `session_id` | UUID | yes | Generated on the client when a session starts. |
| `client_timestamp` | ISO-8601 string | yes | Time on the user's device (may be wrong; kept for reference only). |
| `schema_version` | string | yes | Start at `"1"`. Increment if the schema ever changes. |
| `app_version` | string | no | Build/version of the UI. |
| `page_path` | string | no | Current route path, e.g. `/orders/123`. |
| `page_title` | string | no | Human-readable page name. |
| `referrer` | string | no | Previous path, for journey linking. |
| `properties` | JSON object | no | Event-type-specific fields (see 3.2). |
| `device` | JSON object | no | `{ user_agent, viewport, language }`. Optional. |

**Fields added by the server (never trust these from the client):**

| Field | Added by | Notes |
|-------|----------|-------|
| `user_id` | Gateway | From authenticated session `<AUTH_CONTEXT>`. |
| `user_domain` | Gateway | From authenticated session `<AUTH_CONTEXT>`. |
| `server_timestamp` | Gateway | UTC time the event was received. **This is the authoritative time** for all metrics. |
| `ingest_id` | Backend | Server-generated primary key. |
| `tenant_id` / `app_id` | Gateway | Optional, only if multi-tenant. |

### 3.2 Event types and their `properties`

Use exactly these event types. Do not add more without updating this section.

| `event_type` | When it fires | `properties` payload |
|--------------|---------------|----------------------|
| `login` | On successful authentication | `{ "method": "<OPTIONAL>" }` |
| `session_start` | First activity of a new session | `{}` |
| `session_heartbeat` | Every N seconds while the app is open and visible | `{}` |
| `session_end` | App closed / tab hidden long enough / logout | `{ "reason": "unload"|"timeout"|"logout", "duration_ms": <int> }` |
| `page_enter` | User navigates to a route | `{ "view_id": "<UUID>" }` |
| `page_exit` | User leaves that route | `{ "view_id": "<UUID>", "dwell_ms": <int>, "active_ms": <int> }` |
| `action` | A meaningful UI action (click, submit, filter) | `{ "action_name": "<string>", "target": "<string>", "value": "<OPTIONAL>" }` |

> `dwell_ms` = total time on page. `active_ms` = time on page while the tab was **visible/foreground** (see 4.4). Report both; prefer `active_ms` for "real" attention time.

### 3.3 Example event (as sent by the UI)

```json
{
  "event_id": "b3f1c2a4-...-9de1",
  "event_type": "action",
  "session_id": "8a2e...-77c0",
  "client_timestamp": "2026-09-01T08:15:04.221+08:00",
  "schema_version": "1",
  "app_version": "2.14.0",
  "page_path": "/orders/list",
  "page_title": "Orders",
  "referrer": "/dashboard",
  "properties": { "action_name": "export_csv", "target": "orders_table" },
  "device": { "user_agent": "...", "viewport": "1440x900", "language": "en" }
}
```

---

## 4. Layer 1 — UI: capture events

Build a small self-contained **analytics module** inside the UI layer. It has no product logic; it only records events. Below is language-neutral pseudocode. Adapt syntax to your UI framework (`<UI_FRAMEWORK>`, e.g. TS/Lit).

### 4.1 Module public interface

```
analytics.init(config)
analytics.track(eventType, properties)      // generic event
analytics.trackAction(actionName, target, value?)
analytics.trackPageEnter(pagePath, pageTitle)
analytics.trackPageExit()                    // called automatically on route change
analytics.flush()                            // force-send buffered events
```

`config` includes: `endpointUrl`, `appVersion`, `flushIntervalMs` (default `10000`), `maxBatchSize` (default `20`), `heartbeatIntervalMs` (default `20000`), `inactivityTimeoutMs` (default `1800000` = 30 min).

### 4.2 Session management

```
function getOrCreateSession():
    now = currentTime()
    stored = readSessionFromStorage()          // sessionStorage or in-memory
    if stored exists AND (now - stored.lastActivity) < inactivityTimeoutMs:
        stored.lastActivity = now
        return stored
    else:
        newSession = { session_id: newUUID(), startedAt: now, lastActivity: now }
        writeSessionToStorage(newSession)
        track("session_start", {})
        return newSession

// Call getOrCreateSession() at app load and before every track() call.
// Every track() updates lastActivity = now.
```

Rules:
- A **new** `session_id` is created on app load if there is no live session, or after `inactivityTimeoutMs` of no events.
- Store session in `sessionStorage` (survives route changes, dies with the tab) or in memory.

### 4.3 Login tracking

When authentication succeeds in the UI, call `analytics.track("login", { method })`.
(The server will attach `user_id`/`user_domain`, so the UI does not send them.)

### 4.4 Page view + dwell time (single-page-app safe)

Because the app is a single-page app, a "page view" is a **route change**, not a browser reload.

```
state: currentView = null   // { view_id, path, enterTime, activeMs, lastResumeTime, visible }

function onRouteChange(newPath, newTitle):
    if currentView != null:
        trackPageExit()                        // close the previous page
    currentView = {
        view_id: newUUID(),
        path: newPath,
        enterTime: currentTime(),
        activeMs: 0,
        lastResumeTime: currentTime(),
        visible: documentIsVisible()
    }
    track("page_enter", { view_id: currentView.view_id }, page=newPath, title=newTitle)

function trackPageExit():
    if currentView == null: return
    accumulateActiveTime()                     // add foreground time up to now
    dwell = currentTime() - currentView.enterTime
    track("page_exit", {
        view_id: currentView.view_id,
        dwell_ms: dwell,
        active_ms: currentView.activeMs
    }, page=currentView.path)
    currentView = null

// Foreground-only "active" time using the Page Visibility API:
function onVisibilityChange():
    if documentBecameHidden():
        accumulateActiveTime()                 // stop the clock
        currentView.visible = false
    if documentBecameVisible():
        currentView.lastResumeTime = currentTime()  // restart the clock
        currentView.visible = true

function accumulateActiveTime():
    if currentView.visible:
        currentView.activeMs += currentTime() - currentView.lastResumeTime
        currentView.lastResumeTime = currentTime()
```

**How to hook `onRouteChange`:** subscribe to your router's navigation event (`<ROUTER_NAVIGATION_HOOK>`). If the framework has no router event, listen to the browser History API (`popstate` + wrap `pushState`).

### 4.5 Action tracking

Call `analytics.trackAction(name, target)` at meaningful interactions (submit, export, filter, open modal). Keep `action_name` a short stable string. Do **not** put personal data in `target` or `value`.

### 4.6 Heartbeats and session end

```
// Heartbeat: while the tab is visible, every heartbeatIntervalMs:
if documentIsVisible():
    track("session_heartbeat", {})

// Session end: on 'pagehide' or when the tab has been hidden past a short grace period, or on logout:
function endSession(reason):
    trackPageExit()                            // close current page first
    duration = currentTime() - session.startedAt
    track("session_end", { reason, duration_ms: duration })
    flush(useBeacon=true)                       // must send even while unloading
```

> Browsers do **not** reliably fire unload events. Therefore the server must also be able to **infer** session end from the last heartbeat/event if no `session_end` arrives (see Section 8.5). Heartbeats make this reliable.

### 4.7 Buffering and transport (reliability)

```
buffer = []

function track(eventType, properties, page, title):
    session = getOrCreateSession()
    event = buildEnvelope(eventType, properties, session, page, title)  // Section 3.1 client fields
    buffer.push(event)
    if buffer.length >= maxBatchSize:
        flush()

// Timer: every flushIntervalMs -> flush()
// Visibility: on tab hidden -> flush(useBeacon=true)

function flush(useBeacon=false):
    if buffer is empty: return
    batch = take all events from buffer
    if useBeacon AND sendBeaconAvailable():
        sendBeacon(endpointUrl, batch)          // fire-and-forget, survives unload
    else:
        POST endpointUrl with body=batch, keepalive=true
        on failure: re-add batch to front of buffer, retry with backoff (max 3 tries)
```

Rules:
- Send events **in batches**, not one request per event.
- Flush triggers: buffer full, timer, or tab hidden.
- Use `sendBeacon` (or `fetch` with `keepalive`) so events survive page close.
- Never block the UI or throw errors that reach the user. Analytics failures must be silent.

### 4.8 Layer 1 — Definition of Done

- [ ] A session is created and reused correctly, with a 30-minute inactivity reset.
- [ ] `login`, `session_start`, `session_heartbeat`, `page_enter`, `page_exit`, `action`, `session_end` all fire at the right moments.
- [ ] Route changes produce paired `page_enter` / `page_exit` with `dwell_ms` and `active_ms`.
- [ ] Events are batched and sent to the gateway; unload uses `sendBeacon`.
- [ ] No `user_id` / `user_domain` is set on the client.
- [ ] Analytics never blocks or breaks the UI.

---

## 5. Layer 2 — Gateway: receive, enrich, forward

The gateway exposes **one** ingestion operation. It attaches trusted identity and forwards to the backend. Below uses GraphQL as the example transport (`<GATEWAY_TRANSPORT>`); adapt if yours differs.

### 5.1 Ingestion operation (GraphQL example)

```graphql
scalar JSON

input AnalyticsEventInput {
  eventId: ID!
  eventType: String!
  sessionId: ID!
  clientTimestamp: String!
  schemaVersion: String!
  appVersion: String
  pagePath: String
  pageTitle: String
  referrer: String
  properties: JSON
  device: JSON
}

type AnalyticsIngestResult {
  accepted: Int!
  rejected: Int!
}

type Mutation {
  recordAnalyticsEvents(events: [AnalyticsEventInput!]!): AnalyticsIngestResult!
}
```

If your gateway is REST instead: `POST /analytics/events` with a JSON array body and a `202` response.

### 5.2 Enrichment logic (critical — this is where identity is set)

```
function recordAnalyticsEvents(events, requestContext):
    auth = requestContext.<AUTH_CONTEXT>        // the authenticated session
    if auth is not authenticated:
        reject all (return { accepted: 0, rejected: events.length })

    serverTime = nowUtc()
    enriched = []
    for e in events:
        if e.eventType not in ALLOWED_EVENT_TYPES: skip (count as rejected); continue
        enriched.push({
            ...e,
            user_id:      auth.userId,           // SERVER decides identity
            user_domain:  auth.userDomain,       // SERVER decides domain
            server_timestamp: serverTime,        // authoritative time
            tenant_id:    auth.tenantId          // optional
        })

    forwardToBackend(enriched)                   // Section 6
    return { accepted: enriched.length, rejected: events.length - enriched.length }
```

Rules:
- **`user_id` and `user_domain` are read from `<AUTH_CONTEXT>`, never from the request body.** This is what makes the "domain usage" metric trustworthy and prevents spoofing.
- `server_timestamp` is set here, once, for the whole batch — it is the time used by every metric.
- Reject unknown event types. Do not crash the whole batch for one bad event.

### 5.3 Layer 2 — Definition of Done

- [ ] The ingestion operation accepts a **batch** of events.
- [ ] Unauthenticated requests are rejected.
- [ ] Every forwarded event has server-set `user_id`, `user_domain`, `server_timestamp`.
- [ ] Unknown `event_type` values are dropped without failing the batch.

---

## 6. Layer 3 — Backend: validate and persist

The backend receives enriched events and writes them to the database. Keep it thin.

### 6.1 Endpoint (REST example)

```
POST <BACKEND_BASE_URL>/internal/analytics/events
Body: JSON array of enriched events (fields from Section 3.1, both client and server fields)
Response: 202 Accepted { "written": <int> }
Auth: internal service-to-service auth only (not public)
```

### 6.2 Persistence logic

```
function writeEvents(events):
    valid = []
    for e in events:
        if missing any required field (event_id, event_type, session_id, user_id, server_timestamp):
            log and skip
        else:
            valid.push(e)
    bulkInsert("analytics_events", valid)        // one multi-row insert, not row-by-row
    return { written: valid.length }
```

Rules:
- Use **idempotent insert on `event_id`** (insert-or-ignore / upsert) so retried batches do not create duplicates.
- Bulk-insert the whole batch in one statement.
- This endpoint must not be reachable by end users — internal only.

### 6.3 Layer 3 — Definition of Done

- [ ] Endpoint is internal-only and writes batches in one insert.
- [ ] Duplicate `event_id`s are ignored (idempotent).
- [ ] Rows land in `analytics_events` with all required fields populated.

---

## 7. Layer 4 — Database schema

One raw table stores everything. Summary tables (7.2) are optional and only for speed at scale. SQL below is standard; adjust types to your engine (`<DB_ENGINE>`).

### 7.1 Raw events table (required)

```sql
CREATE TABLE analytics_events (
    ingest_id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id          UUID        NOT NULL UNIQUE,       -- idempotency key
    event_type        VARCHAR(40) NOT NULL,
    user_id           VARCHAR(128) NOT NULL,
    user_domain       VARCHAR(64),
    session_id        UUID        NOT NULL,
    server_timestamp  TIMESTAMPTZ NOT NULL,             -- authoritative time (UTC)
    client_timestamp  TIMESTAMPTZ,
    page_path         TEXT,
    page_title        TEXT,
    referrer          TEXT,
    app_version       VARCHAR(40),
    schema_version    VARCHAR(10),
    properties        JSONB,                            -- event-specific payload
    device            JSONB
);

-- Indexes for the metric queries in Section 8:
CREATE INDEX idx_ae_user_time    ON analytics_events (user_id, server_timestamp);
CREATE INDEX idx_ae_time         ON analytics_events (server_timestamp);
CREATE INDEX idx_ae_session      ON analytics_events (session_id, server_timestamp);
CREATE INDEX idx_ae_domain_time  ON analytics_events (user_domain, server_timestamp);
CREATE INDEX idx_ae_type_time    ON analytics_events (event_type, server_timestamp);
```

> Optional at scale: **partition `analytics_events` by day** on `server_timestamp` so old data is cheap to drop.

### 7.2 Summary tables (optional — add only when raw queries get slow)

```sql
-- Fast "last login / last seen" lookups.
CREATE TABLE user_last_seen (
    user_id       VARCHAR(128) PRIMARY KEY,
    user_domain   VARCHAR(64),
    last_login    TIMESTAMPTZ,
    last_seen     TIMESTAMPTZ
);

-- One row per user per active day. Powers DAU/MAU/retention fast.
CREATE TABLE user_activity_daily (
    activity_date DATE         NOT NULL,
    user_id       VARCHAR(128) NOT NULL,
    user_domain   VARCHAR(64),
    event_count   INT,
    session_count INT,
    active_ms     BIGINT,
    PRIMARY KEY (activity_date, user_id)
);
```

### 7.3 Layer 4 — Definition of Done

- [ ] `analytics_events` exists with the unique `event_id` constraint and all indexes.
- [ ] (If used) summary tables exist and are populated by the roll-up job (Section 9).

---

## 8. Metric computation (copy-paste queries)

All queries run against `analytics_events`. Replace `:start` / `:end` with your date range. Choose one reporting timezone (`<REPORT_TZ>`); apply it consistently.

### 8.1 Last login (metric 1a)

```sql
SELECT user_id, MAX(server_timestamp) AS last_login
FROM analytics_events
WHERE event_type = 'login'
GROUP BY user_id;
```

### 8.2 DAU — Daily Active Users (metric 2a)

```sql
SELECT (server_timestamp AT TIME ZONE '<REPORT_TZ>')::date AS day,
       COUNT(DISTINCT user_id) AS dau
FROM analytics_events
WHERE server_timestamp >= :start AND server_timestamp < :end
GROUP BY day
ORDER BY day;
```

### 8.3 MAU — Monthly Active Users (metric 2b)

```sql
-- Calendar month:
SELECT date_trunc('month', server_timestamp AT TIME ZONE '<REPORT_TZ>') AS month,
       COUNT(DISTINCT user_id) AS mau
FROM analytics_events
GROUP BY month
ORDER BY month;

-- Rolling 30-day MAU ending on date :D
SELECT COUNT(DISTINCT user_id) AS mau_30d
FROM analytics_events
WHERE server_timestamp >= (:D - INTERVAL '30 days') AND server_timestamp < :D;
```

**Stickiness (bonus):** `stickiness = DAU / MAU`.

### 8.4 Domain usage (metric 3)

```sql
SELECT user_domain,
       COUNT(DISTINCT user_id)    AS users,
       COUNT(DISTINCT session_id) AS sessions,
       COUNT(*)                   AS events
FROM analytics_events
WHERE server_timestamp >= :start AND server_timestamp < :end
GROUP BY user_domain
ORDER BY users DESC;
```

### 8.5 Session duration (metric 5)

```sql
-- Duration = last event minus first event in each session.
-- Works even if session_end was never received (unreliable unload).
SELECT session_id,
       MIN(user_id)     AS user_id,
       MIN(user_domain) AS user_domain,
       MIN(server_timestamp) AS started,
       MAX(server_timestamp) AS ended,
       EXTRACT(EPOCH FROM (MAX(server_timestamp) - MIN(server_timestamp))) AS duration_seconds
FROM analytics_events
GROUP BY session_id;

-- Average session duration per domain:
WITH sessions AS (
    SELECT session_id, MIN(user_domain) AS user_domain,
           EXTRACT(EPOCH FROM (MAX(server_timestamp) - MIN(server_timestamp))) AS dur_s
    FROM analytics_events
    GROUP BY session_id
)
SELECT user_domain, AVG(dur_s) AS avg_session_seconds, COUNT(*) AS session_count
FROM sessions GROUP BY user_domain ORDER BY avg_session_seconds DESC;
```

### 8.6 Page dwell time (metric 6)

```sql
-- Uses the active_ms computed on the client (foreground time).
SELECT page_path,
       COUNT(*)                                    AS views,
       AVG((properties->>'active_ms')::numeric)    AS avg_active_ms,
       AVG((properties->>'dwell_ms')::numeric)     AS avg_dwell_ms
FROM analytics_events
WHERE event_type = 'page_exit'
GROUP BY page_path
ORDER BY avg_active_ms DESC;
```

### 8.7 User journey (metric 4)

```sql
-- Full ordered path of one session:
SELECT server_timestamp,
       event_type,
       page_path,
       properties
FROM analytics_events
WHERE session_id = :session_id
ORDER BY server_timestamp ASC;

-- Most common first page after login (funnel starting points):
SELECT page_path, COUNT(*) AS n
FROM analytics_events
WHERE event_type = 'page_enter'
GROUP BY page_path ORDER BY n DESC;
```

### 8.8 Retention rate (metric 1b) — classic day-N cohort

```sql
WITH first_seen AS (
    SELECT user_id,
           MIN((server_timestamp AT TIME ZONE '<REPORT_TZ>')::date) AS cohort_date
    FROM analytics_events
    GROUP BY user_id
),
activity AS (
    SELECT DISTINCT user_id,
           (server_timestamp AT TIME ZONE '<REPORT_TZ>')::date AS active_date
    FROM analytics_events
)
SELECT f.cohort_date,
       COUNT(DISTINCT f.user_id) AS cohort_size,
       COUNT(DISTINCT CASE WHEN a.active_date = f.cohort_date + 1  THEN a.user_id END) AS day_1,
       COUNT(DISTINCT CASE WHEN a.active_date = f.cohort_date + 7  THEN a.user_id END) AS day_7,
       COUNT(DISTINCT CASE WHEN a.active_date = f.cohort_date + 30 THEN a.user_id END) AS day_30
FROM first_seen f
LEFT JOIN activity a ON a.user_id = f.user_id
GROUP BY f.cohort_date
ORDER BY f.cohort_date;

-- Retention rate for a cohort = day_N / cohort_size  (e.g. day_7 / cohort_size).
```

---

## 9. Roll-up job (optional, for speed)

When raw queries get slow, run a scheduled job (once per day, e.g. 01:00 `<REPORT_TZ>`) that fills the summary tables so dashboards read pre-aggregated rows.

```
JOB daily_rollup(for_date):
    -- 1) user_activity_daily
    INSERT/UPSERT into user_activity_daily
    SELECT for_date, user_id, min(user_domain),
           count(*) , count(distinct session_id),
           sum( (properties->>'active_ms')::bigint ) filter (where event_type='page_exit')
    FROM analytics_events
    WHERE server_timestamp during for_date (in <REPORT_TZ>)
    GROUP BY user_id;

    -- 2) user_last_seen
    UPSERT user_last_seen
    SELECT user_id, min(user_domain),
           max(server_timestamp) filter (where event_type='login') AS last_login,
           max(server_timestamp) AS last_seen
    FROM analytics_events WHERE server_timestamp during for_date
    GROUP BY user_id;
```

After this, DAU/MAU/retention can be computed from `user_activity_daily` (much smaller than raw events).

---

## 10. Privacy, security, and data hygiene

Follow all of these:

1. **No PII in events.** Do not put names, emails, phone numbers, tokens, or free-text user input into `properties`, `target`, or `value`. Use IDs and stable action names only.
2. **Identity is server-side.** `user_id` / `user_domain` come from `<AUTH_CONTEXT>` only (already enforced in Section 5).
3. **`user_domain` is a business group** (Cash, COO, DFT, Delivery), not personal data — safe to aggregate.
4. **Internal endpoints stay internal.** The backend write endpoint (Section 6) is not public.
5. **Retention/expiry.** Decide how long to keep raw events (e.g. 90–365 days). Drop or archive older partitions. Keep summary tables longer since they hold no fine-grained PII.
6. **Consent.** If your jurisdiction requires it, gate analytics behind user consent and provide an opt-out that stops `track()` calls.
7. **Fail silent.** Analytics errors must never affect the product.

---

## 11. Rollout plan (phases)

Implement in this order so you get value early:

**Phase 0 — Foundation (MVP)**
- Create `analytics_events` table (7.1).
- Backend write endpoint (Section 6).
- Gateway ingestion + enrichment (Section 5).
- UI module with: `session_start`, `login`, `action`, and batching (4.1–4.3, 4.7).
- ✅ Now computable: last login, DAU, MAU, domain usage.

**Phase 1 — Journeys & time on page**
- Add `page_enter` / `page_exit` with dwell + active time (4.4).
- ✅ Now computable: user journey, page dwell time.

**Phase 2 — Sessions & retention**
- Add `session_heartbeat` and `session_end` (4.6).
- ✅ Now computable: session duration, retention.

**Phase 3 — Scale (only if needed)**
- Add roll-up job + summary tables (Sections 7.2, 9).
- Partition raw table by day.

---

## 12. Acceptance criteria (test before calling it done)

- [ ] Logging in produces exactly one `login` event with correct `user_id` and `user_domain` (verified in DB).
- [ ] Navigating A → B → C produces `page_enter`/`page_exit` pairs with sensible `dwell_ms` and `active_ms`; switching browser tabs pauses `active_ms`.
- [ ] Closing the tab still delivers buffered events (via `sendBeacon`).
- [ ] DAU query returns the number of distinct users you tested with.
- [ ] Domain usage query groups correctly by `user_domain`.
- [ ] A session's events share one `session_id`; after 30 min idle, the next event has a new `session_id`.
- [ ] Session duration query returns a plausible duration for a test session.
- [ ] Retweeting the same batch twice does **not** create duplicate rows (idempotency via `event_id`).
- [ ] No PII appears anywhere in `analytics_events`.

---

## 13. Quick reference: what each metric maps to

| Requested metric | Event(s) used | Query section |
|------------------|---------------|---------------|
| Last login | `login` | 8.1 |
| Retention rate | any (daily active) | 8.8 |
| Active users / day (DAU) | any | 8.2 |
| Active users / month (MAU) | any | 8.3 |
| Domain using app more | any (grouped by `user_domain`) | 8.4 |
| User journey (pages, actions) | `page_enter`, `page_exit`, `action` | 8.7 |
| Time using the webapp (session) | `session_start`…`session_end` / first…last event | 8.5 |
| Time in a page | `page_exit` (`dwell_ms`, `active_ms`) | 8.6 |

**End of plan.**
