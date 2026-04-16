# CX Operations App — Implementation Plan

Companion to the unified CX operations concept: one internal workspace for lookups, signals, briefing, and safe actions. Raycast scripts remain for quick actions; this app is the audited, shared layer.

---

## 1. Goals (unchanged)

- **Consolidate** context (customer, billing, support, engineering signals) in one place.
- **Tight access**: Google OAuth; only `@bolt.new` and `@stackblitz.com` on **verified** emails; optional explicit allowlist for rare exceptions.
- **CX-friendly**: one search (email ± project id) → profile + deep links + API-backed panels.
- **Auditable**: log lookups and every write; all CX agents are **operators** for now (revisit read-only roles later).

---

## 2. Decisions log (updated)

| Topic | Decision |
|-------|----------|
| **Hosting** | **bolt.new** hosting, **internal-only**. Prefer running in **WebContainers** on Bolt; if the UX or platform limits require it, a **macOS desktop app (e.g. Electron)** is an acceptable alternative. |
| **Repository** | **New repo** under the **StackBlitz org** on GitHub (not this Raycast-scripts folder). |
| **Stack** | Choose a stack that **runs well in WebContainers**; **Electron** only if WC or deploy constraints push you to desktop. |
| **User / project ID** | **Email** is the primary key from **Front**. **User ID** discovery: open **StackBlitz admin** user search with email (same idea as `bolt-admin.sh` — `stackblitz.com/admin/users?...by_email_address...`). **Front** may already expose **user id** via integrations (**ChargeDesk**, **Snowflake**); validate and prefer showing that in the profile when present to skip manual admin hops. |
| **Data retention** | No formal policy yet; **default to safest**: minimize persisted PII, prefer **ephemeral display + links** to Front/Stripe/admin; expand storage only after policy exists. Team secrets stay in **1Password** until centralized app secrets are provisioned. |
| **Timezones** | **Defer** detailed briefing scheduling; team spans **EU (~2) and US (majority)** — when briefing lands, support **per-user or dual “cutoff”** windows rather than one implicit TZ. |
| **Slack** | **Required at some phase** (not necessarily day one): ability to **push** briefing snippets or alerts to an internal channel. |
| **Roles** | **All CX agents are operators** for now (token resets, rate limits, etc. when implemented); keep **audit log** anyway for accountability. |
| **Adjacent tooling** | Team already uses **Cursor**, **Claude Enterprise**, **GitHub Codespaces** (StackBlitz org) for deep dives on customer issues. **Mintlify** (docs) has **MCP** — consider exposing **customer-facing doc lookup** via MCP or deep links so the app stays aligned with **one source of public truth** without duplicating content. |

**WebContainers / secrets note:** Pure in-browser WC cannot safely hold Stripe/Front OAuth client secrets. If the UI runs in WC, you still need a **small server or edge BFF** (Bolt-hosted API routes, worker, or Electron main process) for Google OAuth callback, token exchange, and connector calls. Plan the split up front.

---

## 3. Access & auth (locked in)

| Item | Decision |
|------|----------|
| Identity | Google OAuth (OIDC). |
| Eligibility | `email_verified === true` and domain suffix `@bolt.new` OR `@stackblitz.com` (case-insensitive domain). |
| Exceptions | Small manual allowlist (e.g. env var or DB table) if ever needed; default off. |
| Session | Server session cookie: `HttpOnly`, `Secure`, `SameSite` appropriate for your host. |
| Secrets | Stripe, Front, Sentry, Linear keys **server-only**; never exposed to the client. |

**Implementation note:** If both brands use different Google Workspace orgs, rely on **email suffix**, not solely hosted-domain (`hd`).

---

## 4. Architecture (recommended starting shape)

```
[Browser / WebContainer UI]
        │
        ▼
[bolt.new-hosted BFF or edge — required for secrets]
        │
        ├── Session + domain gate
        ├── Connectors: Stripe, Front, (later Sentry, Linear, Slack)
        ├── Optional: Mintlify or internal docs API / MCP bridge (read-only)
        └── Data store (if used): Postgres or platform-native DB — audit log, briefing snapshots, minimal PII
```

- **UI**: Vite + React (or similar) is a common **WebContainers-friendly** default; avoid coupling to stacks that assume a long-running Node server in the same process unless Bolt’s hosting model supports it.
- **BFF**: Any OAuth and server-side API keys live here only.
- **Jobs**: Daily briefing + future Slack push — use **whatever scheduler bolt.new / internal infra provides** (cron, queue worker); define when Phase D starts.
- **Electron path**: Same BFF URLs; desktop shell loads the web app with optional tighter system integration later.

---

## 5. Integration matrix

| System | MVP | Mechanism | Notes |
|--------|-----|-----------|--------|
| **Google** | Yes | OAuth | Domain gate on callback. |
| **Stripe** | Yes | REST API | Customer by email, subscriptions, invoices; read-first. |
| **Front** | Yes | REST API | Conversations/contact by email; volume metrics; PII policy in UI. |
| **Bolt admin (sites, static, DB, tokens, snapshots, Netlify)** | Yes (phase 1) | **Deep links** with `userId` / `projectId` in URL | Align with `BOLT_FLOWS.md` patterns until internal APIs exist. |
| **bolt.new rate limits / token reset** | Later / gated | Existing API paths (`/api/rate-limits/...`) via **server proxy** + RBAC + audit | Only after roles and logging are defined. |
| **Sentry** | Phase 2 | API +/or webhooks | Issue counts, projects; later alert ingestion. |
| **Linear** | Phase 2 | API | Issues by label/search; link-out. |
| **Snowflake** | Later | Read-only scoped role | Marketing-parity access policy. |
| **Mixpanel / Netlify (non-admin)** | Later | As needed | |
| **Slack** | Phase D or E | Incoming webhook or Slack API (bot token in BFF) | Briefing post or alert fan-out. |
| **Mintlify / docs** | Later | MCP (Cursor etc.) and/or **link-out** to canonical URLs | Do not fork doc content in the app; **lookup** or summarize via approved tools. |
| **Snowflake** | Later | Read-only scoped role | Align with Front/ChargeDesk id fields when designing profile. |

---

## 6. Roadmap (suggested phases)

### Phase A — Foundation (weeks 1–2)

- Repo + deploy target + env management (staging vs prod OAuth clients).
- Google OAuth + **domain gate** + session + logout.
- **Audit log**: `actor_email`, `action`, `resource_type`, `resource_id`, `timestamp`, `metadata` (no raw ticket bodies unless policy allows).
- Shell UI: layout, nav, “not authorized” page.

### Phase B — Customer profile (weeks 2–4)

- **Global search**: email (required); optional project id pasted or secondary field.
- Resolve **Stripe** customer + subscriptions summary panel.
- **Front** panel: recent conversations / links to Front (respect retention/redaction).
- **Bolt admin links** section: one-click URLs for user id + project id (from manual entry, clipboard helper, or future API) — mirror `bolt-admin-hub` destinations (sites, static hosting, import zip, bolt DB, token usage, snapshots, Netlify partner accounts).
- Copy-to-clipboard for ids everywhere.

### Phase C — Signals (weeks 4–6)

- Sentry summary (saved project/issue views or API aggregates).
- Linear: open issues linked by conventions you use (labels, search).
- Optional: webhook endpoints (signed) to store “signal” events for briefing.

### Phase D — Daily briefing (weeks 6–8)

- Scheduled job: pull **cached aggregates** from DB + connector calls.
- Store structured JSON + render UI (sections from original concept: incidents, ticket trends, clusters placeholder, Linear closed needing CX follow-up, billing anomalies).
- Optional LLM **summarization** only over **stored facts** (no hallucinated incidents).

### Phase E — Workflows (ongoing)

- Highest-frequency flows from CX interviews: e.g. token reset, coupon check, routing tags — each behind **audit** + confirmation (all users are operators for now).

### Phase F — Slack + timezone-aware briefing (when ready)

- Post structured briefing or alerts to an internal Slack channel.
- Briefing windows: respect **EU vs US** (e.g. user preference or two scheduled summaries).

---

## 7. Customer profile page (MVP detail)

**Inputs**

- **Email** (primary — usually from Front).
- Optional: **User ID**, **Project ID** (from ticket, Front custom fields / ChargeDesk / Snowflake, or manual paste).

**Sections (top to bottom)**

1. **Identity** — Display name if available; ids with copy; **link to StackBlitz admin user search by email** (equivalent to `bolt-admin.sh`).
2. **Billing (Stripe)** — Customer id, subscription status, plan, past-due, key dates; link to Stripe dashboard if allowed.
3. **Support (Front)** — Last N conversations; link to Front inbox/search.
4. **Engineering (placeholder)** — Linear/Sentry “coming soon” or read-only stubs in Phase C.
5. **Bolt operations** — Grid of buttons: Static hosting, Sites, Bolt DB, Token usage, Snapshots, Netlify, Import ZIP — each opens the correct `bolt.new/admin/...` URL pattern with query params you standardize on.

**Empty states**

- Clear messaging when Stripe/Front returns nothing (wrong email, no account).

---

## 8. Daily briefing (MVP detail)

**Inputs (automated)**

- Front: ticket counts by inbox/tag, day-over-day delta.
- Sentry: error volume / new issues (if connected).
- Linear: issues closed in last 24h with tags that imply CX follow-up (define convention).
- Stripe: optional — new failed payments, churn signals (scoped, low-risk metrics first).

**Output**

- Dated briefing record + web page; **Slack push** in Phase F (or earlier if prioritized).

**Quality bar**

- Every bullet should trace to a **source link** or stored metric; LLM text is optional garnish.

---

## 9. Security checklist (before any write actions)

- [ ] Domain gate tested with allowed and denied Google accounts.
- [ ] Staging uses separate OAuth client and keys.
- [ ] Rate limiting on auth and search endpoints.
- [ ] **Audit log** on all searches and writes (operators only for now; roles may expand later).
- [ ] BFF-only secrets; WebContainer / client bundle contains **no** API keys.
- [ ] Audit log queryable for security reviews.
- [ ] Dependency scanning + minimal CSP for the app.

---

## 10. Remaining open items (shorter list)

1. **Exact Bolt hosting surface** for the BFF (API routes project type, separate worker, etc.) — pick with whoever owns bolt.new internal deploys.
2. **Front → user id**: Confirm where ChargeDesk/Snowflake exposes **StackBlitz user id** (custom field, plugin, link) so the profile can auto-fill without opening admin.
3. **Mintlify MCP**: Decide whether the **CX app** calls docs through a **server-side** proxy, or docs stay a **Cursor/MCP** workflow only (lower scope).
4. **Slack**: Workspace app vs incoming webhook; channel naming; who can trigger manual “post briefing.”

---

## 11. Success criteria for “MVP done”

- Any authorized CX user can sign in with Google and **cannot** sign in with a non-company email.
- Search by email shows **Stripe + Front** in one view plus **working deep links** to Bolt admin surfaces when ids are present.
- Every search and sign-in event is **audited**.
- Staging environment mirrors prod auth flow with test accounts.

---

## 12. References in this repo

- `BOLT_FLOWS.md` — URL patterns and Raycast script mapping (keep in sync when admin URLs stabilize).
- `bolt-admin.sh` — StackBlitz admin user lookup by email (encode for `q[by_email_address]`).

---

*Next step: create the **new StackBlitz org repo**, confirm **BFF deploy target** on bolt.new, scaffold **Vite + React** (or chosen WC-friendly UI) + minimal **OAuth + domain gate** on the server path.*
