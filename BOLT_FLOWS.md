# Bolt support flows – scripts and connections

Quick reference for how the Raycast scripts fit together with Front, Stripe, GitHub Code Spaces (CX Agent), and bolt.new/StackBlitz admin.

---

## 1. Daily Bolt admin (rate limits, user lookup, token reset)

| Goal | Script | How |
|------|--------|-----|
| Find user by email or ID | **bolt-admin** | Run with email or User ID → opens StackBlitz admin users; then **Copy UserID from Admin Page** (or bolt-admin runs it for you) copies ID and offers Rate Limits / Reset Tokens. |
| One menu for all admin sections | **Bolt Admin Hub** | Run with optional User ID or Project ID → pick: Admin dashboard, Users, Rate limits, Token reset, Sites & Deployments, Static Hosting, Import ZIP, Bolt DB, Token Usage, Snapshots, Netlify, Org rate limits. |
| Rate limits for a user (ID in clipboard) | **User Admin Actions** or **Open Bolt Rate Limits** | User Admin Actions: menu → Show Rate Limits (in Raycast) or Open / Reset. Open Bolt Rate Limits: opens `bolt.new/api/rate-limits/{clipboard}`. |
| Reset tokens (monthly/all) | **Reset Tokens** or **User Admin Actions** | `Reset Tokens <UserID> monthly|all` or use User Admin Actions → Reset Tokens. |
| Org-level rate limits | **Org User Rate Limits** or **Open Org Token Stats** | Org User Rate Limits: `<UserID> [OrgID]` (OrgID from clipboard or current admin page). Open Org Token Stats: opens org page or org rate limits URL. |

**Paths:** User lookup = `stackblitz.com/admin/users`. Rate limits / reset = `bolt.new/api/rate-limits/...`. Admin sections (all under `bolt.new/admin`):
- **Sites & Deployments** – `https://bolt.new/admin/sites` (filter: project ID, user ID createdBy)
- **Static Hosting Sites** – `https://bolt.new/admin/static-hosting` (search: domain, project ID, user ID)
- **Import ZIP** – `https://bolt.new/admin/import-zip` (upload form; no ID in URL)
- **Bolt DB** – `https://bolt.new/admin/bolt-db` (Supabase integrations: project ID or slug)
- **Token Usage** – `https://bolt.new/admin/token-usage` (filter: user ID, project ID, trace ID, date)
- **Snapshots** – `https://bolt.new/admin/snapshots` (filter: project ID, user ID)
- **Netlify Partner Accounts** – `https://bolt.new/admin/netlify-partner-accounts` (search: user ID, org ID, account slug)

---

## 2. Front (email) → Bolt support reply

| Goal | Script | How |
|------|--------|-----|
| Reply to support email with Bolt tone | **Reply (Bolt Support)** | Copy the email in Front → run script (optional: instructions, recipient name). Uses `gemini.js` with `BOLT_SUPPORT=1`. |

---

## 3. Stripe (payments)

| Goal | Script | How |
|------|--------|-----|
| Check promo code | **Stripe Promo Code Checker** (script or extension) | Run with promo code; API key from Keychain (`raycast-stripe-api` / `stripe-api-key`). |
| Extension (form + copy URL) | **bolt-admin-tools** → Stripe Promo Code Checker | Same check inside the Bolt Admin Tools Raycast extension. |

**Possible addition:** “Stripe customer by email” → open Bolt admin user search with that email (same as bolt-admin with email argument).

---

## 4. GitHub Code Spaces – CX Agent (Claude)

| Goal | Script | How |
|------|--------|-----|
| Start the agent Codespace | **Start CX Agent Codespace** | Starts the `stackblitz/cx-agent` Codespace if not running. |
| Ask the agent (logs, Notion, Linear, Slack) | **Ask CX Agent** | `<Prompt> [Project ID] [User ID]`. Runs `claude` in the Codespace with optional projectId/userId in the message. |

**Flow:** Support ticket or user issue → copy Project ID or User ID from admin → run **Ask CX Agent** with a question and those IDs so the agent can use logs/Notion/Linear/Slack.

---

## 5. End-to-end support flow (suggestion)

1. **Front:** Copy customer email or ticket content.
2. **Bolt:** Run **bolt-admin** with that email → open user in admin, copy User ID, then Rate Limits or Token reset from the dialog.
3. **Stripe:** If it’s about billing or a promo, run **Stripe Promo Code Checker** with the code.
4. **Deep dive:** Run **Ask CX Agent** with the User ID or Project ID and a prompt (e.g. “Check logs and Notion for this user”).
5. **Reply:** Run **Reply (Bolt Support)** with the email in the clipboard and any instructions.

For a single entry point to admin sections (Sites, Deployments, Static Hosting, Bolt DB, Token Usage, Snapshots, Netlify) plus user lookup and rate limits, use **Bolt Admin Hub** with an optional User ID or Project ID.

---

## Script locations (summary)

- **Bolt / admin:** `bolt-admin.sh`, `bolt-admin-hub.sh`, `copy-user-id-from-browser.sh`, `user-admin-actions.sh`, `org-rate-limits.sh`, `open-org-token-stats.sh`, `reset_tokens.sh`, `open-user-url.js`
- **Stripe:** `stripe-promo-code-checker.sh`, `raycast-extensions/bolt-admin-tools` (Stripe Promo Code Checker)
- **CX Agent:** `start-cx-agent-codespace.sh`, `gh-cx-agent.sh`
- **Support reply:** `reply_bolt_support.sh`, `gemini.js`
