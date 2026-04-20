# Raycast-scripts — repo audit

Generated from a full pass over the workspace: inventory, correctness gaps (especially **Bolt Admin Hub**), Raycast extension viability, and how pieces relate to the **CX Operations app** (`CX_OPERATIONS_APP_PLAN.md`).

---

## 1. High-level map

| Area | Purpose | Keep / migrate / review |
|------|---------|-------------------------|
| **Shell Raycast scripts** (`*.sh`) | bolt-admin, hub, org limits, token reset, AI email helpers, Codespace agent | **Keep** until CX app ships; lowest friction for macOS |
| **cx-briefing/** | Node HTML briefing (Front, Slack, Sentry); aligns with plan Phase D | **Migrate** logic to new StackBlitz org repo BFF; keep as interim generator |
| **CX_OPERATIONS_APP_PLAN.md** | Target architecture | **Source of truth** for the new app |
| **BOLT_FLOWS.md** | Support flow cheat sheet | **Keep**; sync URL/query params with hub + future app |
| **raycast-extensions/bolt-admin-tools/** | Raycast extension: admin search, user id capture, Stripe promo | **Likely deprecate** with CX app if Raycast store/private extensions are unused |
| **raycast-stripe-promo-extension/** | Standalone Stripe promo command | Same as above |
| **raycast-extensions/** (`getting-started`) | Template / scratch | **Review** — probably delete or move out |
| **raycast-extensions-111/**** | Nested “private extension store” template + duplicate `getting-started` | **Strong candidate to delete** — looks accidental; duplicates noise |
| **bolt-admin-tools/** (repo root) | Only `package.json` + one test file — **not** a full extension | **Remove or merge** into `raycast-extensions/bolt-admin-tools` to avoid confusion |
| **cx-briefing/CX Briefing.app** | macOS applet for Claude Desktop path | Keep until briefing is fully in-app |
| **.claude/commands/cx-briefing.md** | Claude command hook | Keep with cx-briefing |

---

## 2. Shell scripts (Raycast-oriented)

Scripts observed in repo root (non-exhaustive if new files appear):

| Script | Role |
|--------|------|
| `bolt-admin.sh` | StackBlitz admin user filter by ID or email |
| `bolt-admin-hub.sh` | Menu / actions for bolt.new admin sections + rate limits |
| `org-rate-limits.sh` | Org user rate limits with **browser org ID extraction** |
| `open-org-token-stats.sh` | Org token stats / org admin URL |
| `user-admin-actions.sh` | Rate limits JSON / reset via browser |
| `copy-user-id-from-browser.sh` | Extract user id from Chromium |
| `reset_tokens.sh` | Token reset URLs |
| `stripe-promo-code-checker.sh` | Stripe promo (Keychain) |
| `reply_bolt_support.sh`, `gemini.js`, `copilot.js`, `chatgpt.js`, `notion.js` | AI / reply helpers |
| `gh-cx-agent.sh`, `start-cx-agent-codespace.sh` | Codespace CX agent |
| `url-encode-email.sh`, `mailbox_with_mail.sh`, `localhost.sh`, `test.sh` | Utilities |
| `copy-email-to-*.sh` | Clipboard → various tools |
| `token-snippet.sh`, `token_allocation.sh`, `org_limits.sh`, `fill-token-allocation.js`, etc. | Token / admin helpers |

**Composition:** Flows are designed to chain (clipboard user id → hub / user-admin-actions). Documented in `README.md` and `BOLT_FLOWS.md`.

---

## 3. Bolt Admin Hub — issues (and one fix applied)

### 3.1 Numeric ID ambiguity (main design gap)

`bolt-admin-hub.sh` accepts **one** optional numeric `ID`. Admin pages differ on whether that number is a **user id** or **project id** (see `BOLT_FLOWS.md`).

| Action | Current filter | Problem |
|--------|----------------|---------|
| `sites` | `q[project_id_eq]` | Docs also allow **creator user id**; a **user** id opens the wrong filter |
| `static-hosting` | `q[project_id_eq]` only | Docs: domain, **project id, or user id** — user id not represented |
| `bolt-db` | `q[project_id_eq]` only | Docs: **project id or slug**; non-numeric slug never gets a filter |
| `token-usage` | `q[user_id_eq]` only | If agent passes **project id**, filter is wrong |
| `snapshots` | `q[project_id_eq]` only | Docs: **project or user** — user id case missing |
| `netlify` | `q[user_id_eq]` only | Docs mention org id / slug — not handled for non-user cases |

**Recommendation:** In the CX app, treat **user id** and **project id** as separate fields (or a type toggle). For the hub script, either:

- Add **two Raycast arguments** (e.g. user id + project id), or  
- Split menu entries (e.g. “Sites by project ID” / “Sites by creator user ID”) **after** confirming the real query param names in bolt.new admin (inspect network tab on each page).

### 3.2 Org rate limits (improved)

The hub previously guessed org id from **clipboard** with `grep -Eo '^\d+$'`, which often matched the **same** user id as `ORGID` and fell back to generic pages.

**Change:** `org-rate-limits` now **delegates to `org-rate-limits.sh`**, which already implements browser extraction + dialog — same behavior as running the dedicated command.

### 3.3 Minor / consistency

- **User id length:** Hub uses `^\d{4,}$` from clipboard for rate limits / org path; `user-admin-actions.sh` uses the same. Very short numeric ids (edge case) are ignored.
- **`urls.ts` vs `bolt-admin-search.tsx`:** Duplicated URL building; `urls.ts` exists but inline duplicate in `bolt-admin-search.tsx` — consolidate when touching the extension.

---

## 4. Raycast extensions — “may never work” / viability

Extensions **do** work in principle if:

- Developers run `npm install` / `npm run dev` in the extension folder and load the folder in Raycast.
- **bolt-admin-tools** requires Raycast **preferences** Stripe key; AppleScript-heavy flows stay in shell scripts.

Why they might **not** be worth keeping long-term:

- **CX Operations app** will subsume lookup, briefing, and many links (per your direction).
- **Private org store** (`owner: bolt-new` in `package.json`) still needs install/update discipline; shell scripts are often faster for agents.
- **Duplicate / orphan trees:** `raycast-extensions-111/` and root `bolt-admin-tools/` add confusion without adding capability.

**Recommendation:**

1. Mark in README: **canonical** extension path is `raycast-extensions/bolt-admin-tools/` only.  
2. Archive or delete `raycast-extensions-111/` after confirming no unique code.  
3. Remove or merge root `bolt-admin-tools/` (incomplete duplicate).  
4. When the CX app reaches Phase B, **freeze** extension features and point README to the new repo.

---

## 5. cx-briefing

- **Well aligned** with plan: `index.js` header already references Phase D and eventual BFF.  
- **Secrets:** `.env` / 1Password — do not commit.  
- **Outputs:** HTML to disk — fine until internal app + auth exists.  
- **Scheduling:** `launchd/cx-briefing.plist`, `run-now.sh` — migrate to bolt.new cron/worker later.

---

## 6. Suggested follow-ups (checklist)

- [ ] Confirm **Rails query keys** for sites / static-hosting / snapshots for **user vs project** (then update hub + `BOLT_FLOWS.md`).  
- [ ] Remove or merge **raycast-extensions-111** and root **bolt-admin-tools**.  
- [ ] Deduplicate URL helpers in **bolt-admin-tools** (`urls.ts` vs `bolt-admin-search.tsx`).  
- [ ] Add top-level **README** pointer to `REPO_AUDIT.md` and `CX_OPERATIONS_APP_PLAN.md` (optional one line).  
- [ ] When new CX repo exists: **port** `cx-briefing/index.js` connector patterns + env var names into the BFF.

---

## 7. Files worth human eyeball (non-code)

- `cx-briefing/index.js` — default Query URLs may be personal/workspace-specific (`DEFAULT_QUERY_*`).  
- `gemini.js` / API usage — ensure keys are env-only, not committed.

---

*Last updated: repo audit pass + hub `org-rate-limits` delegation fix.*
