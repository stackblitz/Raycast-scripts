#!/usr/bin/env node
'use strict';

/**
 * CX Daily Briefing
 *
 * Prototype for Phase D of the CX Operations app (see CX_OPERATIONS_APP_PLAN.md
 * in the Raycast-scripts repo): same connectors + summary idea; production
 * target is the internal app BFF + scheduled job + UI route, not this script.
 *
 * Fetches data from Slack, Front, Sentry, and optionally Linear then opens an HTML dashboard.
 * Works WITHOUT an Anthropic API key — generates a structured data dashboard.
 * If ANTHROPIC_API_KEY is set, Claude adds an AI-synthesized summary on top.
 *
 * Usage:
 *   node index.js                       # 16h lookback (default)
 *   node index.js --hours=8             # custom window
 *   node index.js --slack-json=/tmp/x   # Slack from file (Claude Desktop MCP export / merged JSON)
 *   node index.js --no-slack-api       # skip Slack REST even if SLACK_BOT_TOKEN is set (pair with --slack-json)
 *   node index.js --serve              # keep running on http://127.0.0.1:3751/ — refresh / “Fetch again” rebuilds data
 *   node index.js --serve=4080         # custom port
 *   node index.js --hours=24 --search=billing   # last 24h, substring match (Front subject, Slack message text, Sentry titles)
 *   node index.js --scope=slack --search=refund # Slack-only custom run
 *   node index.js --scope=front --subject=acme  # Front-only; --subject= same as --search=
 *   node index.js --scope=linear                # Linear bugs only (needs LINEAR_TEAM_IDS)
 *   node index.js --help               # flag reference
 *
 * Required env (at least one data source):
 *   FRONT_API_KEY       — Front token (Conversations:Read, Tags:Read, Inboxes:Read)
 *   SLACK_BOT_TOKEN     — xoxb-... (unless using --slack-json or --no-slack-api)
 *
 * Optional:
 *   ANTHROPIC_API_KEY   — adds AI synthesis layer (not required)
 *   SENTRY_AUTH_TOKEN   — Sentry errors section
 *   SENTRY_ORG          — org slug (default: stackblitz)
 *   LINEAR_API_KEY      — optional: Linear GraphQL (personal API key)
 *   LINEAR_TEAM_IDS     — comma-separated team UUIDs (Linear Cmd/Ctrl+K → copy team id)
 *   LOOKBACK_HOURS      — override default 16h
 *   QUERY_NEW_URL       — Query.new / Query home (default https://query.new/)
 *   QUERY_DASHBOARD_URL — Query dashboard deep link in header
 *   QUERY_TICKET_ANALYZER_URL — ticket analyzer workflow link
 *   FRONT_APP_BASE_URL  — base for ticket links (default https://app.frontapp.com → …/open/cnv_…)
 *   FRONT_MRR_FIELD_KEYS — optional comma-separated conversation custom_field keys for monthly $ (sorts queue by tier)
 *   FRONT_SEATS_FIELD_KEYS — optional comma-separated keys for seat/member count (team + MRR enterprise rule)
 */

const https  = require('https');
const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const { execSync } = require('child_process');

// ── Load .env ──────────────────────────────────────────────────────────────────
(function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    const key = t.slice(0, eq).trim();
    const val = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (key && !process.env[key]) process.env[key] = val;
  }
})();

// ── Config ─────────────────────────────────────────────────────────────────────
const hoursArg  = process.argv.find(a => a.startsWith('--hours='));
const HOURS     = hoursArg ? parseInt(hoursArg.split('=')[1]) : parseInt(process.env.LOOKBACK_HOURS || '16');
const SINCE_TS  = Math.floor(Date.now() / 1000) - HOURS * 3600;
const SINCE_ISO = new Date(SINCE_TS * 1000).toISOString();
const NOW_LABEL = new Date().toLocaleString('en-US', {
  weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  hour: '2-digit', minute: '2-digit',
});
const DEFAULT_QUERY_NEW_URL = 'https://query.new/';
const DEFAULT_QUERY_DASHBOARD_URL = 'https://query-new.utility.stackblitz.dev/dashboard/ba70a056-06d3-4a46-8340-6d18ac188683?chat=collapsed';
const DEFAULT_QUERY_TICKET_ANALYZER_URL = 'https://query-new.utility.stackblitz.dev/workflows/7ccc7ec0-0de6-4ab2-a5e7-c9c178d29f43/798873df-143f-4632-ac45-ee417a68a47a';
const DEFAULT_FRONT_APP_BASE = 'https://app.frontapp.com';

const argv = process.argv;
const NO_SLACK_API = argv.includes('--no-slack-api');

function getServePort() {
  const spec = argv.find(a => a === '--serve' || a.startsWith('--serve='));
  if (!spec) return 0;
  if (spec === '--serve') return parseInt(process.env.CX_BRIEFING_PORT || '3751', 10) || 3751;
  const n = parseInt(spec.slice('--serve='.length), 10);
  return Number.isFinite(n) && n > 0 ? n : 3751;
}
const SERVE_PORT = getServePort();

/** First `=` separates value; value may contain `=`. */
function argvFlagValue(...prefixes) {
  for (const prefix of prefixes) {
    const a = argv.find(x => x.startsWith(prefix));
    if (a) {
      const eq = a.indexOf('=');
      if (eq >= 0) return a.slice(eq + 1);
    }
  }
  return '';
}

const CUSTOM_SEARCH = (argvFlagValue('--search=', '--subject=', '--q=') || '').trim();
const SCOPE_ARG = (argvFlagValue('--scope=', '--source=') || 'all').toLowerCase().trim();
const SEARCH_SCOPE = ['front', 'slack', 'sentry', 'linear', 'all'].includes(SCOPE_ARG) ? SCOPE_ARG : 'all';
const FETCH_SLACK  = SEARCH_SCOPE === 'all' || SEARCH_SCOPE === 'slack';
const FETCH_FRONT  = SEARCH_SCOPE === 'all' || SEARCH_SCOPE === 'front';
const FETCH_SENTRY = SEARCH_SCOPE === 'all' || SEARCH_SCOPE === 'sentry';
const FETCH_LINEAR = SEARCH_SCOPE === 'all' || SEARCH_SCOPE === 'linear';

const ENV = {
  claude:    process.env.ANTHROPIC_API_KEY,
  slack:     process.env.SLACK_BOT_TOKEN,
  front:     process.env.FRONT_API_KEY,
  sentry:    process.env.SENTRY_AUTH_TOKEN,
  sentryOrg: process.env.SENTRY_ORG || 'stackblitz',
  linear:    (process.env.LINEAR_API_KEY || '').trim(),
  queryNewUrl: (() => {
    const v = process.env.QUERY_NEW_URL;
    if (v === '0' || v === 'false' || v === 'off') return '';
    return (v != null && v !== '') ? v : DEFAULT_QUERY_NEW_URL;
  })(),
  queryDashboardUrl: process.env.QUERY_DASHBOARD_URL || DEFAULT_QUERY_DASHBOARD_URL,
  queryTicketAnalyzerUrl: process.env.QUERY_TICKET_ANALYZER_URL || DEFAULT_QUERY_TICKET_ANALYZER_URL,
  frontAppBase: (process.env.FRONT_APP_BASE_URL || DEFAULT_FRONT_APP_BASE).replace(/\/$/, ''),
};

const SLACK_CHANNELS = [
  { name: 'bolt-bugs',               priority: 'critical' },
  { name: 'cx-core',                 priority: 'high'     },
  { name: 'cx-team',                 priority: 'high'     },
  { name: 'product-releases',        priority: 'high'     },
  { name: 'announcements',           priority: 'high'     },
  { name: 'bolt-eng-support',        priority: 'medium'   },
  { name: 'ext-parahelp-stackblitz', priority: 'medium'   },
  { name: 'general',                 priority: 'low'      },
];

// ── HTTP util ──────────────────────────────────────────────────────────────────
function apiRequest(urlStr, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const url  = new URL(urlStr);
    const req  = https.request({
      hostname: url.hostname,
      path:     url.pathname + url.search,
      method,
      headers:  { 'Content-Type': 'application/json', 'User-Agent': 'cx-briefing/1.0', ...headers },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

function slackMessageMatchesSearch(msg) {
  if (!CUSTOM_SEARCH) return true;
  if (SEARCH_SCOPE !== 'all' && SEARCH_SCOPE !== 'slack') return true;
  return String(msg.text || '').toLowerCase().includes(CUSTOM_SEARCH.toLowerCase());
}

/** Apply --search= to Slack channel payloads (API or MCP JSON). */
function filterSlackPayload(data) {
  if (!data || data.skipped || !CUSTOM_SEARCH || (SEARCH_SCOPE !== 'all' && SEARCH_SCOPE !== 'slack')) return data;
  const out = {};
  let total = 0;
  for (const [name, block] of Object.entries(data)) {
    if (!block || typeof block !== 'object') {
      out[name] = block;
      continue;
    }
    const msgs = Array.isArray(block.messages) ? block.messages.filter(slackMessageMatchesSearch) : block.messages;
    if (Array.isArray(msgs)) total += msgs.length;
    out[name] = { ...block, messages: msgs || [] };
  }
  console.log(`  · Slack text filter "${CUSTOM_SEARCH}": ${total} messages`);
  return out;
}

// ── Slack ──────────────────────────────────────────────────────────────────────
async function fetchSlackData() {
  // MCP / Claude Desktop: pre-gathered Slack JSON (--slack-json=path)
  const slackJsonArg = argv.find(a => a.startsWith('--slack-json='));
  if (slackJsonArg) {
    const jsonPath = slackJsonArg.split('=')[1];
    console.log(`→ Slack data from file (Claude Desktop / MCP merge): ${jsonPath}`);
    const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    const filtered = filterSlackPayload(data);
    const total = Object.values(filtered).reduce((n, ch) => n + (ch.messages?.length || 0), 0);
    console.log(`  ✓ ${total} messages from ${Object.keys(filtered).length} channels`);
    return filtered;
  }

  if (NO_SLACK_API) {
    return { skipped: true, reason: 'Slack API skipped (--no-slack-api). Use Claude Desktop Slack MCP, save JSON, then run with --slack-json=/path/to.json' };
  }

  if (!ENV.slack) return { skipped: true, reason: 'No SLACK_BOT_TOKEN (or use --slack-json=… from Claude Desktop MCP)' };
  console.log('→ Fetching Slack...');

  const channelMap = {};
  let cursor = '';
  do {
    const res = await apiRequest(
      `https://slack.com/api/conversations.list?limit=1000&types=public_channel,private_channel${cursor ? `&cursor=${cursor}` : ''}`,
      { headers: { Authorization: `Bearer ${ENV.slack}` } }
    );
    if (!res.body.ok) { console.warn(`  Slack list error: ${res.body.error}`); break; }
    for (const c of res.body.channels || []) channelMap[c.name] = c.id;
    cursor = res.body.response_metadata?.next_cursor || '';
  } while (cursor);

  const results = {};
  for (const ch of SLACK_CHANNELS) {
    const id = channelMap[ch.name];
    if (!id) {
      results[ch.name] = { priority: ch.priority, messages: [], note: 'channel not visible to bot' };
      continue;
    }
    const res = await apiRequest(
      `https://slack.com/api/conversations.history?channel=${id}&oldest=${SINCE_TS}&limit=100`,
      { headers: { Authorization: `Bearer ${ENV.slack}` } }
    );
    if (!res.body.ok) {
      const note = res.body.error === 'not_in_channel' ? 'bot not in channel' : res.body.error;
      results[ch.name] = { priority: ch.priority, messages: [], note };
      console.warn(`  ⚠ #${ch.name}: ${note}`);
      continue;
    }
    const messages = sortSlackMessagesByTraction(
      (res.body.messages || [])
        .filter(m => m.type === 'message' && !m.subtype)
        .map(m => ({
          time:      new Date(parseFloat(m.ts) * 1000).toISOString(),
          text:      (m.text || '').slice(0, 700),
          reactions: (m.reactions || []).reduce((n, r) => n + r.count, 0),
          replies:   m.reply_count || 0,
        }))
    );
    results[ch.name] = { priority: ch.priority, messages };
    console.log(`  ✓ #${ch.name}: ${messages.length} messages`);
  }
  return filterSlackPayload(results);
}

/** Higher = more team attention on the thread (Slack reply_count + reactions). */
function slackThreadTractionScore(msg) {
  const r = msg.replies || 0;
  const x = msg.reactions || 0;
  return r * 1000 + x;
}

function sortSlackMessagesByTraction(messages) {
  return [...(messages || [])].sort((a, b) => {
    const sb = slackThreadTractionScore(b) - slackThreadTractionScore(a);
    if (sb !== 0) return sb;
    return new Date(b.time).getTime() - new Date(a.time).getTime();
  });
}

function sortSlackCrossChannelByTraction(rows) {
  const PRI = { critical: 0, high: 1, medium: 2, low: 3 };
  return [...(rows || [])].sort((a, b) => {
    const sb = slackThreadTractionScore(b) - slackThreadTractionScore(a);
    if (sb !== 0) return sb;
    const pa = PRI[a.channelPriority] ?? 9;
    const pb = PRI[b.channelPriority] ?? 9;
    if (pa !== pb) return pa - pb;
    return new Date(b.time).getTime() - new Date(a.time).getTime();
  });
}

/** Cross-channel threads sorted by reply traction (for dashboard + AI context). */
function collectSlackHotThreads(slack, limit = 14) {
  if (!slack || slack.skipped) return [];
  const rows = [];
  for (const ch of SLACK_CHANNELS) {
    const block = slack[ch.name];
    if (!block || !Array.isArray(block.messages)) continue;
    const pri = block.priority || ch.priority;
    for (const msg of block.messages) {
      rows.push({ ...msg, channel: ch.name, channelPriority: pri });
    }
  }
  return sortSlackCrossChannelByTraction(rows).slice(0, limit);
}

// ── Front subscription / MRR (sort queue: highest commercial value first) ───
function normalizeFrontCustomFields(cf) {
  if (!cf) return {};
  if (Array.isArray(cf)) {
    const o = {};
    for (const row of cf) {
      const k = row.name || row.id || row.key;
      if (k != null) o[String(k)] = row.value;
    }
    return o;
  }
  if (typeof cf === 'object') return { ...cf };
  return {};
}

function parseNumericLike(raw) {
  if (raw == null) return null;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  const s0 = String(raw).trim();
  const km = s0.match(/^([\d,]+(?:\.\d+)?)\s*k$/i);
  if (km) return parseFloat(km[1].replace(/,/g, '')) * 1000;
  const n = parseFloat(s0.replace(/[$,]/g, '').replace(/[^\d.+-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function mrrFromTagAndTextStrings(strings) {
  let best = null;
  const blob = strings.filter(Boolean).join(' | ');
  const patterns = [
    /\bMRR\s*[:\s]+\$?\s*([\d,]+(?:\.\d+)?)\s*k?\b/gi,
    /\bARR\s*[:\s]+\$?\s*([\d,]+(?:\.\d+)?)\s*k?\b/gi,
    /\$\s*([\d,]+(?:\.\d+)?)\s*(?:\/\s*mo|\/mo|\/m\b|\/month)/gi,
    /\b([\d,]+(?:\.\d+)?)\s*\/\s*mo\b/gi,
  ];
  for (const re of patterns) {
    let m;
    const r = new RegExp(re.source, re.flags.replace('g', '') + 'g');
    while ((m = r.exec(blob)) !== null) {
      let v = parseFloat(m[1].replace(/,/g, ''));
      if (/ARR/i.test(m[0]) && v >= 1000) v /= 12;
      if (/[\d,]+(?:\.\d+)?\s*k\b/i.test(m[0]) && v >= 1 && v < 500) v *= 1000;
      if (Number.isFinite(v) && v > 0) best = Math.max(best || 0, v);
    }
  }
  return best;
}

function seatsFromTagAndTextStrings(strings) {
  const blob = strings.filter(Boolean).join(' ');
  const m = blob.match(/\b(?:seats?|members?|team[_\s-]?size)\s*[:\s]*(\d+)\b/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

function readCustomFieldNumber(cfObj, keysFromEnv, defaults) {
  const extra = (keysFromEnv || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  const keys = [...extra, ...defaults];
  for (const k of keys) {
    if (cfObj[k] != null && cfObj[k] !== '') {
      const n = parseNumericLike(cfObj[k]);
      if (n != null) return n;
    }
  }
  for (const [k, v] of Object.entries(cfObj)) {
    if (/mrr|recurring|subscription|plan.?price|monthly/i.test(k)) {
      const n = parseNumericLike(v);
      if (n != null) return n;
    }
  }
  return null;
}

function readCustomFieldInt(cfObj, keysFromEnv, defaults) {
  const extra = (keysFromEnv || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  const keys = [...extra, ...defaults];
  for (const k of keys) {
    if (cfObj[k] != null && cfObj[k] !== '') {
      const n = parseInt(String(cfObj[k]).replace(/\D/g, ''), 10);
      if (Number.isFinite(n)) return n;
    }
  }
  for (const [k, v] of Object.entries(cfObj)) {
    if (/seats?|members?|team[_\s-]?size|headcount/i.test(k)) {
      const n = parseInt(String(v).replace(/\D/g, ''), 10);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

/**
 * Stackblitz-style commercial tiers (monthly $). Unknown MRR sorts after known paid.
 * Enterprise: ≥$500/mo OR team plan with ≥$500 MRR and ≥3 seats.
 */
function classifyFrontSubscriptionTier(mrr, { isTeamPlan, seats }) {
  const seatsN = seats == null ? null : Number(seats);
  const enterpriseTeam = isTeamPlan && mrr != null && mrr >= 500 && seatsN != null && seatsN >= 3;
  const enterpriseMrr = mrr != null && mrr >= 500;

  if (enterpriseMrr || enterpriseTeam) {
    return {
      tier: 'enterprise',
      rank: 600,
      label: 'Enterprise (≥$500/mo or team ≥$500 MRR + 3+ seats)',
    };
  }
  if (mrr == null || !Number.isFinite(mrr)) {
    return { tier: 'unknown', rank: 55, label: 'MRR unknown' };
  }
  if (mrr > 400 && mrr < 500) {
    return { tier: 'scale', rank: 550, label: 'Scale ($401–499/mo)' };
  }
  if (mrr >= 300 && mrr <= 400) {
    return { tier: 'premium', rank: 500, label: 'Premium ($300–400/mo)' };
  }
  if (mrr >= 200 && mrr < 300) {
    return { tier: 'high', rank: 400, label: 'High (~$200/mo tier)' };
  }
  if (mrr > 100 && mrr < 200) {
    return { tier: 'standard', rank: 350, label: '$100–199/mo' };
  }
  if (mrr >= 50 && mrr <= 100) {
    return { tier: 'medium', rank: 300, label: 'Medium ($50–100/mo)' };
  }
  if (mrr > 25 && mrr < 50) {
    return { tier: 'low', rank: 200, label: 'Low (>$25–50/mo)' };
  }
  if (mrr <= 25) {
    return { tier: 'free', rank: 100, label: 'Free / ≤$25/mo' };
  }
  return { tier: 'standard', rank: 330, label: `~$${Math.round(mrr)}/mo` };
}

function frontBillingFromConversation(c) {
  const cf = normalizeFrontCustomFields(c.custom_fields);
  const tagNames = (c.tags || []).map(t => (typeof t === 'string' ? t : t.name) || '').filter(Boolean);
  const isTeamPlan = tagNames.some(n => /team|teams|organization|org plan|multi[-\s]?seat|business plan/i.test(n));

  const mrrKeys = process.env.FRONT_MRR_FIELD_KEYS || '';
  const seatKeys = process.env.FRONT_SEATS_FIELD_KEYS || '';

  let mrr = readCustomFieldNumber(cf, mrrKeys, ['mrr', 'MRR', 'monthly_recurring_revenue', 'subscription_mrr', 'plan_mrr']);
  if (mrr == null) mrr = mrrFromTagAndTextStrings([...tagNames, c.subject || '']);

  let seats = readCustomFieldInt(cf, seatKeys, ['seats', 'members', 'team_size', 'seat_count', 'team_members']);
  if (seats == null) seats = seatsFromTagAndTextStrings([...tagNames, c.subject || '']);

  const tier = classifyFrontSubscriptionTier(mrr, { isTeamPlan, seats });
  return { mrr, seats, isTeamPlan, ...tier };
}

function frontSubscriptionSortKey(conv) {
  const bill = frontBillingFromConversation(conv);
  const vol = (() => {
    const n = conv.message_count ?? conv.messageCount ?? conv?.metrics?.num_messages ?? conv?.metrics?.messages;
    if (typeof n === 'number' && n >= 0) return n;
    return 0;
  })();
  const t = conv.last_message?.created_at || 0;
  return bill.rank * 1e15 + vol * 1e9 + t;
}

/** Next page URL from Front list pagination (`_pagination.next`). */
function frontOpenListNextUrl(pagination) {
  if (!pagination || typeof pagination !== 'object') return null;
  const n = pagination.next;
  if (typeof n !== 'string' || !n.length) return null;
  if (n.startsWith('http')) return n;
  if (n.startsWith('/')) return `https://api2.frontapp.com${n}`;
  return null;
}

// ── Front ──────────────────────────────────────────────────────────────────────
async function fetchFrontData() {
  if (!ENV.front) return { skipped: true, reason: 'No FRONT_API_KEY' };
  console.log('→ Fetching Front...');

  const h = { Authorization: `Bearer ${ENV.front}` };
  try {
    // Front statuses: 'unassigned' and 'assigned' = open. 'archived' = resolved.
    const maxPages = Math.max(1, Math.min(500, parseInt(process.env.FRONT_BRIEFING_MAX_PAGES || '30', 10) || 30));
    const [convRes, inboxRes] = await Promise.all([
      apiRequest('https://api2.frontapp.com/conversations?q[statuses][]=unassigned&q[statuses][]=assigned&sort_by=date&sort_order=desc&limit=100', { headers: h }),
      apiRequest('https://api2.frontapp.com/inboxes', { headers: h }),
    ]);

    let convs = [...(convRes.body._results || [])];
    let pagesFetched = 1;
    let nextUrl = frontOpenListNextUrl(convRes.body._pagination);
    while (nextUrl && pagesFetched < maxPages) {
      const nextRes = await apiRequest(nextUrl, { headers: h });
      const batch = nextRes.body._results || [];
      convs.push(...batch);
      pagesFetched++;
      nextUrl = frontOpenListNextUrl(nextRes.body._pagination);
      if (!batch.length) break;
    }
    const openTotalTruncated = Boolean(nextUrl);

    if (CUSTOM_SEARCH && (SEARCH_SCOPE === 'all' || SEARCH_SCOPE === 'front')) {
      const q = CUSTOM_SEARCH.toLowerCase();
      const n0 = convs.length;
      convs = convs.filter(c => String(c.subject || '').toLowerCase().includes(q));
      console.log(`  · Front subject filter "${CUSTOM_SEARCH}": ${convs.length}/${n0} open`);
    }
    const inboxes = inboxRes.body._results || [];
    const sinceMs = SINCE_TS * 1000;
    const recent  = convs.filter(c => (c.last_message?.created_at * 1000 || 0) > sinceMs);
    const urgent  = convs.filter(c =>
      c.tags?.some(t => /urgent|escalat|critical|vip|p[01]|high|churn/i.test(t.name || ''))
    );
    const frontVolume = c => {
      const n = c.message_count ?? c.messageCount ?? c?.metrics?.num_messages ?? c?.metrics?.messages;
      if (typeof n === 'number' && n >= 0) return n;
      return 0;
    };
    const urgentSorted = [...urgent].sort((a, b) => frontSubscriptionSortKey(b) - frontSubscriptionSortKey(a));
    const recentSorted = [...recent].sort((a, b) => frontSubscriptionSortKey(b) - frontSubscriptionSortKey(a));
    const fmt = c => {
      const id = c.id || '';
      const openUrl = id ? `${ENV.frontAppBase}/open/${encodeURIComponent(id)}` : '';
      const vol = frontVolume(c);
      const bill = frontBillingFromConversation(c);
      return {
        id,
        openUrl,
        subject: c.subject,
        tags:    c.tags?.map(t => t.name) || [],
        updated: new Date((c.last_message?.created_at || 0) * 1000).toISOString(),
        messageCount: vol > 0 ? vol : null,
        mrr: bill.mrr,
        seats: bill.seats,
        subscriptionTier: bill.tier,
        subscriptionRank: bill.rank,
        subscriptionLabel: bill.label,
      };
    };

    const openNote = openTotalTruncated ? ' (≥ — more open beyond this fetch; raise FRONT_BRIEFING_MAX_PAGES)' : '';
    console.log(`  ✓ Front: ${openTotalTruncated ? '≥' : ''}${convs.length} open${openNote}, ${urgent.length} urgent, ${recent.length} in window`);
    return {
      openTotal:            convs.length,
      openTotalTruncated,
      urgentCount:          urgent.length,
      recentCount:          recent.length,
      inboxes:              inboxes.slice(0, 8).map(i => i.name),
      urgentSamples:        urgentSorted.slice(0, 10).map(fmt),
      recentSamples:        recentSorted.slice(0, 15).map(fmt),
    };
  } catch (e) {
    console.warn(`  ✗ Front: ${e.message}`);
    return { error: e.message };
  }
}

// ── Sentry ─────────────────────────────────────────────────────────────────────
async function fetchSentryData() {
  if (!ENV.sentry) return { skipped: true, reason: 'No SENTRY_AUTH_TOKEN' };
  console.log('→ Fetching Sentry...');
  try {
    const res = await apiRequest(
      `https://sentry.io/api/0/organizations/${ENV.sentryOrg}/issues/?project=-1&query=firstSeen:>${SINCE_ISO}&sort=date&limit=20`,
      { headers: { Authorization: `Bearer ${ENV.sentry}` } }
    );
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    let issues = (Array.isArray(res.body) ? res.body : []).map(i => ({
      title: i.title, level: i.level, count: i.count,
      users: i.userCount, project: i.project?.slug,
      first: i.firstSeen, last: i.lastSeen,
    }));
    if (CUSTOM_SEARCH && (SEARCH_SCOPE === 'all' || SEARCH_SCOPE === 'sentry')) {
      const q = CUSTOM_SEARCH.toLowerCase();
      const n0 = issues.length;
      issues = issues.filter(i => String(i.title || '').toLowerCase().includes(q));
      console.log(`  · Sentry title filter "${CUSTOM_SEARCH}": ${issues.length}/${n0}`);
    }
    console.log(`  ✓ Sentry: ${issues.length} issues`);
    return { issues };
  } catch (e) {
    console.warn(`  ✗ Sentry: ${e.message}`);
    return { error: e.message };
  }
}

// ── Linear (GraphQL) — CX bug radar: new in window + trending by links/activity ─
const LINEAR_ISSUES_GQL = `
query CxBriefingIssues($filter: IssueFilter!, $first: Int!, $after: String) {
  issues(filter: $filter, first: $first, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id
      identifier
      title
      url
      createdAt
      updatedAt
      description
      priority
      state { name type }
      assignee { name }
      creator { name }
      labels(first: 12) { nodes { name } }
      relations(first: 25) {
        nodes {
          type
          relatedIssue { identifier title url }
        }
      }
    }
  }
}`;

async function linearGraphql(query, variables) {
  const res = await apiRequest('https://api.linear.app/graphql', {
    method: 'POST',
    headers: {
      Authorization: ENV.linear,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  if (typeof res.body !== 'object' || res.body == null) throw new Error('non-JSON response');
  if (res.body.errors?.length) throw new Error(res.body.errors.map(e => e.message).join('; '));
  return res.body.data;
}

function linearDescSnippet(desc) {
  if (!desc) return '';
  const flat = String(desc).replace(/[#*`_\[\]()]/g, ' ').replace(/\s+/g, ' ').trim();
  if (flat.length <= 180) return flat;
  return `${flat.slice(0, 177)}…`;
}

function normalizeLinearIssue(node) {
  const rels = (node.relations?.nodes || []).filter(Boolean);
  const relationCount = rels.length;
  const labels = (node.labels?.nodes || []).map(l => l.name).filter(Boolean);
  return {
    id: node.id,
    identifier: node.identifier,
    title: node.title,
    url: node.url,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    summary: linearDescSnippet(node.description),
    stateName: node.state?.name || '',
    priority: node.priority,
    assignee: node.assignee?.name || null,
    creatorName: node.creator?.name || null,
    labels,
    relationCount,
    linkedIssues: rels.slice(0, 8).map(r => ({
      type: r.type,
      id: r.relatedIssue?.identifier || '',
      title: r.relatedIssue?.title || '',
      url: r.relatedIssue?.url || '',
    })),
  };
}

function linearTrendScore(i) {
  const pri = typeof i.priority === 'number' ? (5 - Math.min(4, i.priority)) : 0;
  return i.relationCount * 120 + pri * 8 + Date.parse(i.updatedAt || 0) / 1e9;
}

async function fetchLinearData() {
  if (!FETCH_LINEAR) return { skipped: true, reason: `Not loaded (--scope=${SEARCH_SCOPE})` };
  if (!ENV.linear) return { skipped: true, reason: 'No LINEAR_API_KEY' };

  const teamIds = (process.env.LINEAR_TEAM_IDS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  if (!teamIds.length) {
    return { skipped: true, reason: 'No LINEAR_TEAM_IDS (comma-separated team UUIDs from Linear Cmd/Ctrl+K)' };
  }

  const labelNames = (process.env.LINEAR_LABEL_NAMES || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  const newDays = Math.max(1, Math.min(120, parseInt(process.env.LINEAR_NEW_BUGS_DAYS || '7', 10) || 7));
  const newCutoff = new Date(Date.now() - newDays * 864e5).toISOString();
  const maxFetch = Math.max(50, Math.min(500, parseInt(process.env.LINEAR_MAX_ISSUES_FETCH || '200', 10) || 200));
  const creatorEmail = (process.env.LINEAR_CREATOR_EMAIL || '').trim();

  const teamClause = teamIds.length === 1
    ? { team: { id: { eq: teamIds[0] } } }
    : { or: teamIds.map(id => ({ team: { id: { eq: id } } })) };

  const filter = {
    ...teamClause,
    state: { type: { nin: ['completed', 'canceled'] } },
  };
  if (labelNames.length) filter.labels = { name: { in: labelNames } };
  if (creatorEmail) filter.creator = { email: { eq: creatorEmail } };

  console.log('→ Fetching Linear...');

  try {
    const nodes = [];
    let after = null;
    let listTruncated = false;
    while (nodes.length < maxFetch) {
      const first = Math.min(50, maxFetch - nodes.length);
      const variables = { filter, first };
      if (after) variables.after = after;
      const data = await linearGraphql(LINEAR_ISSUES_GQL, variables);
      const conn = data.issues;
      if (!conn) throw new Error('missing issues in GraphQL response');
      const batch = conn.nodes || [];
      nodes.push(...batch);
      const hasNext = Boolean(conn.pageInfo?.hasNextPage);
      after = conn.pageInfo?.endCursor || null;
      if (!batch.length || !hasNext) break;
      if (nodes.length >= maxFetch) {
        listTruncated = hasNext;
        break;
      }
    }

    let normalized = nodes.map(normalizeLinearIssue);
    if (CUSTOM_SEARCH && (SEARCH_SCOPE === 'all' || SEARCH_SCOPE === 'linear')) {
      const q = CUSTOM_SEARCH.toLowerCase();
      const n0 = normalized.length;
      normalized = normalized.filter(i =>
        String(i.title || '').toLowerCase().includes(q) ||
        String(i.summary || '').toLowerCase().includes(q)
      );
      console.log(`  · Linear filter "${CUSTOM_SEARCH}": ${normalized.length}/${n0}`);
    }

    const newBugs = normalized
      .filter(i => Date.parse(i.createdAt) >= Date.parse(newCutoff))
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

    const trending = [...normalized].sort(
      (a, b) => linearTrendScore(b) - linearTrendScore(a) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt)
    );

    console.log(`  ✓ Linear: ${normalized.length} open${listTruncated ? '+' : ''}, ${newBugs.length} new in last ${newDays}d`);

    return {
      newIssuesLookbackDays: newDays,
      newCutoff,
      newBugs: newBugs.slice(0, 20),
      trending: trending.slice(0, 20),
      listTruncated,
      fetchedTotal: normalized.length,
    };
  } catch (e) {
    console.warn(`  ✗ Linear: ${e.message}`);
    return { error: e.message };
  }
}

// ── Claude API synthesis (if ANTHROPIC_API_KEY set) ───────────────────────────
async function synthesizeViaAPI(data) {
  console.log('→ Synthesizing via Claude API...');
  const res = await apiRequest('https://api.anthropic.com/v1/messages', {
    method:  'POST',
    headers: { 'x-api-key': ENV.claude, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: `You are a CX briefing assistant for bolt.new support.
Analyze this data (last ${HOURS}h) and return ONLY valid JSON — no prose, no fences:
{
  "status": "normal"|"elevated"|"incident",
  "statusReason": "<one sentence>",
  "summary": "<2-3 sentences for an agent starting their shift>",
  "topActions": ["<action>"]
}
Max 5 topActions. Highlight anything needing a reply or follow-up.
Prioritize: (1) Slack threads in slackHotThreads and high "replies" in slack channel messages; (2) Front tickets — each row includes subscriptionTier / subscriptionLabel / mrr when known: favor enterprise & premium customers in topActions; (3) Sentry spikes; (4) DATA.linear — newBugs vs trending: high relationCount (linked issues) suggests broad impact; call out hot vs. quiet bugs when useful.
Custom run: briefingFilters in DATA lists search (substring) and scope if set — only matching items are included.
DATA: ${JSON.stringify(data, null, 2)}`,
      }],
    }),
  });
  if (res.status !== 200) throw new Error(`Claude API ${res.status}`);
  let text = res.body.content?.[0]?.text?.trim() || '';
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  return JSON.parse(text);
}

// ── Claude CLI synthesis (uses subscription via `claude` binary + Slack MCP) ──
async function synthesizeViaCLI(briefingInput) {
  console.log('→ Using claude CLI for Slack + synthesis...');

  const claudeBin = (() => {
    for (const p of [
      '/opt/homebrew/bin/claude', '/usr/local/bin/claude',
      `${process.env.HOME}/.volta/bin/claude`,
    ]) { if (fs.existsSync(p)) return p; }
    try { return execSync('which claude', { encoding: 'utf8' }).trim(); } catch { return null; }
  })();
  if (!claudeBin) throw new Error('claude CLI not found');

  const front = briefingInput && typeof briefingInput === 'object' && briefingInput.front !== undefined
    ? briefingInput.front
    : briefingInput;
  const linear = briefingInput && typeof briefingInput === 'object' ? briefingInput.linear : null;

  const frontPath = path.join(os.tmpdir(), 'cx-front.json');
  const outPath   = path.join(os.tmpdir(), `cx-briefing-${Date.now()}.html`);
  fs.writeFileSync(frontPath, JSON.stringify(front, null, 2));

  let linearStep = '';
  if (linear && !linear.skipped && !linear.error) {
    const linearPath = path.join(os.tmpdir(), `cx-linear-${Date.now()}.json`);
    fs.writeFileSync(linearPath, JSON.stringify(linear, null, 2));
    linearStep = `
Step 2b — Linear CX bugs (pre-fetched JSON)
Read: ${linearPath}
Use newBugs (recently created) and trending (relationCount = linked issues; higher = more cross-links / likely hotter). Contrast busy vs. quiet bugs when useful.
`;
  }

  const prompt = `You are generating a CX daily briefing for bolt.new support agents (last ${HOURS}h).

Step 1 — Read Slack channels
Use the slack_read_channel tool for each channel (read all, skip none):
${SLACK_CHANNELS.map(c => `• ${c.name} (${c.priority})`).join('\n')}
Focus on: questions needing replies, reported bugs, incidents, product changes, team updates.
When choosing what to highlight first, favor Slack threads with the most replies (high engagement = likely biggest live issues).

Step 2 — Read Front queue data
Read the file at: ${frontPath}
Each ticket may include subscriptionLabel, subscriptionTier, mrr, seats — prioritize higher commercial tiers when advising.
${linearStep}
Step 3 — Generate HTML briefing
Write a complete self-contained HTML file (inline CSS only, no external deps) to: ${outPath}

The HTML must include:
- Dark header: "⚡ CX Briefing" + date + status badge (🔴 INCIDENT / 🟡 ELEVATED / 🟢 NORMAL)
- Quick links row with:
  - Query.new: ${ENV.queryNewUrl || DEFAULT_QUERY_NEW_URL}
  - Query Dashboard: ${ENV.queryDashboardUrl}
  - Ticket Analyzer: ${ENV.queryTicketAnalyzerUrl}
- Bold summary box: 2-3 sentences on what happened + what needs attention
- "Needs Reply" section: Slack threads/messages that need a CX response (highlight these prominently)
- Priority Actions: numbered list of top 5 things the team must do
- Cards: Incidents & Bugs | Product Updates | CX Highlights | Support Queue | Engineering Signals
- Style: bolt.new-inspired — near-black void background, cyan–violet–pink accents, glass cards, rounded corners, no cluttered borders

Step 4 — Output ONLY this exact line when done (nothing else):
FILE:${outPath}`;

  const result = execSync(
    `"${claudeBin}" --dangerously-skip-permissions -p ${JSON.stringify(prompt)}`,
    { encoding: 'utf8', timeout: 180000, maxBuffer: 10 * 1024 * 1024 }
  );

  if (fs.existsSync(outPath)) return outPath;
  const m = result.match(/FILE:(.+\.html)/);
  if (m && fs.existsSync(m[1].trim())) return m[1].trim();
  throw new Error('claude CLI did not write the HTML file');
}

// ── HTML helpers ───────────────────────────────────────────────────────────────
function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function relTime(iso) {
  if (!iso) return '';
  const d = Date.now() - new Date(iso).getTime();
  const h = Math.floor(d / 3600000), m = Math.floor((d % 3600000) / 60000);
  return h > 0 ? `${h}h ${m}m ago` : `${m}m ago`;
}
function fmtTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
}
function buildQueryLinks() {
  const links = [];
  if (ENV.queryNewUrl) links.push({ label: 'Query.new', url: ENV.queryNewUrl });
  if (ENV.queryDashboardUrl) links.push({ label: 'Query dashboard', url: ENV.queryDashboardUrl });
  if (ENV.queryTicketAnalyzerUrl) links.push({ label: 'Ticket analyzer', url: ENV.queryTicketAnalyzerUrl });
  return links;
}

function renderQuickLinks(links = []) {
  const validLinks = links.filter(link => link?.url);
  if (!validLinks.length) return '';
  const linkHTML = validLinks.map(link =>
    `<a class="quick-link" href="${esc(link.url)}" target="_blank" rel="noopener noreferrer"><span class="ql-dot"></span>${esc(link.label)}</a>`
  ).join('');
  return `<div class="quick-strip"><span class="quick-strip-lbl">Launch</span><div class="quick-links">${linkHTML}</div></div>`;
}

/** Terminal hint when not using --serve (file:// cannot re-run Node). */
function refetchShellCommandHint() {
  const extra = argv.slice(2).filter(a => a !== '--serve' && !a.startsWith('--serve='));
  const parts = extra.map(a => (/\s|'|"/.test(a) ? JSON.stringify(a) : a));
  const d = __dirname.replace(/"/g, '\\"');
  return `cd "${d}" && node index.js${parts.length ? ' ' + parts.join(' ') : ''}`;
}

function refetchButtonHtml() {
  const cmd = refetchShellCommandHint();
  return `<span class="h2-spacer" aria-hidden="true"></span><button type="button" class="btn-refetch" title="Re-fetch data (localhost) or copy command" data-cmd="${esc(cmd)}" onclick="(function(b){var h=location.hostname,p=location.protocol,c=b.getAttribute('data-cmd');if((p==='http:'||p==='https:')&&(h==='127.0.0.1'||h==='localhost')){location.replace(location.origin+location.pathname+'?_='+Date.now());}else{prompt('Copy and run in Terminal:',c);}})(this)">Fetch again</button>`;
}

/** Empty Slack JSON shape for Claude Desktop MCP → file → --slack-json */
function printSlackJsonStub() {
  const stub = {};
  for (const ch of SLACK_CHANNELS) stub[ch.name] = { priority: ch.priority, messages: [] };
  console.error('Save stdout to a .json file, merge channel messages from Slack MCP, then run:');
  console.error(`  node ${path.basename(process.argv[1])} --no-slack-api --slack-json=/path/to/that.json\n`);
  process.stdout.write(`${JSON.stringify(stub, null, 2)}\n`);
}

const FRONT_TIER_PILL_STYLES = {
  enterprise: 'background:rgba(251,191,36,.22);color:#fde68a;border:1px solid rgba(251,191,36,.42)',
  scale:      'background:rgba(244,114,182,.16);color:#fbcfe8;border:1px solid rgba(244,114,182,.38)',
  premium:    'background:rgba(167,139,250,.22);color:#ddd6fe;border:1px solid rgba(167,139,250,.42)',
  high:       'background:rgba(56,189,248,.16);color:#bae6fd;border:1px solid rgba(56,189,248,.38)',
  standard:   'background:rgba(148,163,184,.14);color:#e2e8f0;border:1px solid rgba(148,163,184,.28)',
  medium:     'background:rgba(52,211,153,.12);color:#a7f3d0;border:1px solid rgba(52,211,153,.28)',
  low:        'background:rgba(148,163,184,.1);color:#cbd5e1;border:1px solid rgba(100,116,139,.32)',
  free:       'background:rgba(71,85,105,.28);color:#94a3b8;border:1px solid rgba(71,85,105,.45)',
  unknown:    'background:rgba(71,85,105,.14);color:#94a3b8;border:1px solid rgba(71,85,105,.28)',
};

function frontTicketRow(c) {
  const tags = (c.tags || []).map(t => `<span class="tag">${esc(t)}</span>`).join('');
  const volNote = c.messageCount ? ` · ${c.messageCount} msgs` : '';
  const tier = c.subscriptionTier || 'unknown';
  const pillStyle = FRONT_TIER_PILL_STYLES[tier] || FRONT_TIER_PILL_STYLES.unknown;
  const mrrNote = c.mrr != null && Number.isFinite(c.mrr) ? ` · ~$${Math.round(c.mrr)}/mo` : '';
  const seatNote = c.seats != null && Number.isFinite(c.seats) ? ` · ${c.seats} seats` : '';
  const tierLine = c.subscriptionLabel
    ? `<div class="sub-tier-row"><span class="sub-tier-pill" style="${pillStyle}">${esc(c.subscriptionLabel)}${esc(mrrNote)}${esc(seatNote)}</span></div>`
    : '';
  const body = `
    <div class="item-top">
      <span class="hl">${esc(c.subject || '(no subject)')}</span>
      <span class="meta">${relTime(c.updated)}${esc(volNote)}</span>
    </div>
    ${tierLine}
    ${tags ? `<div class="item-tags">${tags}</div>` : ''}
    ${c.openUrl ? '<div class="item-cta"><span>Open in Front</span><span class="cta-icon">↗</span></div>' : ''}`;
  if (c.openUrl) {
    return `<a class="item item-link" href="${esc(c.openUrl)}" target="_blank" rel="noopener noreferrer">${body}</a>`;
  }
  return `<div class="item">${body}</div>`;
}

const CSS = `
  :root{
    --cyan:#22d3ee;--cyan-dim:rgba(34,211,238,.55);
    --violet:#a78bfa;--pink:#f472b6;--indigo:#6366f1;
    --void:#030712;--void-mid:#0a0f1c;--void-top:#0c1222;
    --text:#f1f5f9;--text-soft:#e2e8f0;--muted:#94a3b8;--muted2:#64748b;
    --glass:rgba(255,255,255,.04);--glass-strong:rgba(255,255,255,.07);
    --stroke:rgba(148,163,184,.14);--stroke-bright:rgba(165,243,252,.22);
    --radius-lg:22px;--radius-md:14px;--radius-sm:10px;
    --shadow-lg:0 24px 80px rgba(0,0,0,.55),0 0 0 1px rgba(255,255,255,.04) inset;
    --glow-cyan:0 0 40px rgba(34,211,238,.22);
    --content-max:1180px;
    --font:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Inter',sans-serif;
  }
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  html{scroll-behavior:smooth}
  @media (prefers-reduced-motion:reduce){
    *,*::before,*::after{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important}
  }
  @keyframes edge-shimmer{
    0%{background-position:0% 50%}
    100%{background-position:200% 50%}
  }
  body{
    font-family:var(--font);
    color:var(--text-soft);
    min-height:100vh;
    -webkit-font-smoothing:antialiased;
    text-rendering:optimizeLegibility;
    padding:clamp(16px,3vw,28px) calc(max(20px,(100vw - var(--content-max)) / 2)) 56px;
    background-color:var(--void);
    background-image:
      radial-gradient(ellipse 100% 80% at 50% -30%,rgba(34,211,238,.16),transparent 55%),
      radial-gradient(ellipse 70% 50% at 100% 0%,rgba(167,139,250,.14),transparent 50%),
      radial-gradient(ellipse 60% 45% at 0% 20%,rgba(244,114,182,.08),transparent 45%),
      radial-gradient(circle at 50% 100%,rgba(99,102,241,.12),transparent 40%),
      linear-gradient(180deg,var(--void-top) 0%,var(--void-mid) 42%,var(--void) 100%);
    background-attachment:fixed;
  }
  body::before{
    content:'';position:fixed;inset:0;pointer-events:none;z-index:0;
    background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32' width='32' height='32' fill='none' stroke='rgba(148,163,184,0.06)' stroke-width='1'%3E%3Cpath d='M0 .5H32M.5 0V32'/%3E%3C/svg%3E");
    opacity:.9;
  }
  body > *{position:relative;z-index:1}
  .header{
    position:relative;
    max-width:var(--content-max);
    margin:0 auto 8px;
    padding:clamp(20px,3vw,32px) clamp(20px,3vw,32px) clamp(18px,2.5vw,26px);
    border-radius:var(--radius-lg);
    color:#f8fafc;
    background:linear-gradient(165deg,rgba(15,23,42,.72) 0%,rgba(15,23,42,.38) 50%,rgba(30,27,75,.25) 100%);
    border:1px solid var(--stroke);
    backdrop-filter:blur(20px) saturate(1.35);
    box-shadow:var(--shadow-lg),var(--glow-cyan);
    overflow:hidden;
  }
  .header::before{
    content:'';position:absolute;inset:0;pointer-events:none;border-radius:inherit;
    background:linear-gradient(105deg,transparent,rgba(34,211,238,.1),rgba(167,139,250,.1),rgba(244,114,182,.06),transparent);
    background-size:200% 100%;
    animation:edge-shimmer 10s linear infinite;
    opacity:.75;
  }
  .header::after{
    content:'';position:absolute;top:0;left:8%;right:8%;height:1px;
    background:linear-gradient(90deg,transparent,rgba(165,243,252,.45),rgba(167,139,250,.35),transparent);
    border-radius:inherit;
  }
  .header > *{position:relative;z-index:1}
  .h1{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap}
  .title-block{display:flex;flex-direction:column;gap:6px;min-width:0}
  .title-row{display:flex;align-items:center;gap:14px;flex-wrap:nowrap}
  .bolt-mark{
    width:42px;height:42px;border-radius:14px;flex-shrink:0;
    display:grid;place-items:center;
    background:linear-gradient(135deg,rgba(34,211,238,.45) 0%,rgba(99,102,241,.55) 48%,rgba(232,121,249,.4) 100%);
    border:1px solid rgba(165,243,252,.5);
    box-shadow:0 0 32px rgba(34,211,238,.35),inset 0 1px 0 rgba(255,255,255,.25);
  }
  .bolt-mark::after{
    content:'⚡';
    font-size:21px;line-height:1;
    filter:drop-shadow(0 0 8px rgba(255,255,255,.5));
  }
  .subtitle{
    font-size:11px;font-weight:600;letter-spacing:.22em;text-transform:uppercase;
    color:rgba(148,163,184,.85);
    margin-top:2px;
  }
  .subtitle-dot{color:var(--cyan);font-weight:800}
  .title{
    font-size:clamp(1.4rem,2.4vw + .5rem,1.95rem);
    font-weight:800;
    letter-spacing:-.03em;
    line-height:1.1;
    background:linear-gradient(92deg,#fff 0%,#a5f3fc 32%,#c4b5fd 58%,#f9a8d4 100%);
    -webkit-background-clip:text;background-clip:text;color:transparent;
  }
  .status-pill{
    display:inline-flex;align-items:center;gap:7px;
    padding:8px 16px;border-radius:999px;
    font-size:11px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;
    cursor:default;
    color:var(--pill-fg,#22d3ee);
    background:linear-gradient(165deg,rgba(255,255,255,.08),rgba(15,23,42,.55));
    border:1px solid rgba(255,255,255,.14);
    box-shadow:0 0 0 1px rgba(255,255,255,.05) inset,0 8px 28px rgba(0,0,0,.35),0 0 36px rgba(34,211,238,.1);
    backdrop-filter:blur(10px);
  }
  .h2{margin-top:14px;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
  .h2-spacer{flex:1;min-width:8px}
  .btn-refetch{
    appearance:none;cursor:pointer;flex-shrink:0;
    font-size:10px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;
    padding:8px 16px;border-radius:999px;color:#030712;
    background:linear-gradient(135deg,#22d3ee,#818cf8 55%,#c084fc);
    border:1px solid rgba(255,255,255,.38);
    box-shadow:0 4px 22px rgba(34,211,238,.28),0 0 0 1px rgba(255,255,255,.1) inset;
    transition:transform .16s ease,filter .16s ease,box-shadow .16s ease;
  }
  .btn-refetch:hover{transform:translateY(-1px);filter:brightness(1.07);box-shadow:0 8px 28px rgba(99,102,241,.35)}
  .btn-refetch:active{transform:translateY(0)}
  .btn-refetch:focus-visible{outline:2px solid #f472b6;outline-offset:3px}
  .ts{font-size:12px;color:var(--muted);font-weight:500}
  .src{
    font-size:10px;font-weight:700;padding:5px 11px;border-radius:999px;
    border:1px solid transparent;
    transition:transform .18s ease,box-shadow .18s ease,border-color .18s ease;
  }
  .src.on{
    color:#cffafe;background:rgba(34,211,238,.1);
    border-color:rgba(34,211,238,.32);
    box-shadow:0 0 20px rgba(34,211,238,.12);
  }
  .src.off{color:var(--muted2);background:rgba(15,23,42,.55);border-color:rgba(51,65,85,.5)}
  .quick-strip{margin:18px 0 0;display:flex;align-items:center;gap:14px;flex-wrap:wrap}
  .quick-strip-lbl{
    font-size:10px;font-weight:800;letter-spacing:.24em;text-transform:uppercase;
    color:rgba(148,163,184,.8);
  }
  .quick-links{display:flex;gap:10px;flex-wrap:wrap;flex:1;min-width:0}
  .quick-link{
    font-size:12px;font-weight:700;text-decoration:none;
    padding:10px 18px;border-radius:999px;
    color:#ecfeff;
    background:linear-gradient(135deg,rgba(34,211,238,.14),rgba(99,102,241,.12),rgba(167,139,250,.1));
    border:1px solid rgba(165,243,252,.28);
    box-shadow:0 4px 24px rgba(0,0,0,.2),0 0 0 1px rgba(255,255,255,.05) inset;
    transition:transform .2s ease,box-shadow .2s ease,border-color .2s ease,filter .2s ease;
    cursor:pointer;display:inline-flex;align-items:center;gap:8px;
  }
  .ql-dot{
    width:7px;height:7px;border-radius:50%;
    background:linear-gradient(135deg,var(--cyan),var(--violet));
    box-shadow:0 0 12px rgba(34,211,238,.75);
    flex-shrink:0;
  }
  .quick-link:hover{
    transform:translateY(-2px);
    border-color:rgba(244,114,182,.42);
    box-shadow:0 10px 36px rgba(99,102,241,.25),0 0 32px rgba(34,211,238,.18);
    filter:brightness(1.05);
  }
  .quick-link:active{transform:translateY(0)}
  .quick-link:focus-visible{outline:2px solid var(--cyan);outline-offset:3px}
  .ai-bar{
    max-width:var(--content-max);
    margin:20px auto 0;
    padding:18px 22px;
    border-radius:var(--radius-lg);
    background:linear-gradient(165deg,rgba(255,255,255,.07) 0%,rgba(255,255,255,.025) 100%);
    border:1px solid var(--stroke);
    border-left:3px solid var(--sc,var(--cyan));
    backdrop-filter:blur(16px) saturate(1.2);
    box-shadow:0 16px 48px rgba(0,0,0,.3),0 0 0 1px rgba(255,255,255,.04) inset;
  }
  .ai-summary{font-size:15px;color:#f8fafc;line-height:1.65;font-weight:500}
  .ai-reason{margin-top:10px;font-size:12px;color:var(--muted);line-height:1.5}
  .actions{
    max-width:var(--content-max);
    margin:16px auto 0;
    padding:18px 22px;
    border-radius:var(--radius-lg);
    background:linear-gradient(165deg,rgba(49,46,129,.35) 0%,rgba(15,23,42,.55) 100%);
    border:1px solid rgba(129,140,248,.22);
    box-shadow:0 16px 48px rgba(49,46,129,.15),0 0 0 1px rgba(255,255,255,.03) inset;
    backdrop-filter:blur(14px);
  }
  .actions-lbl{
    font-size:10px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;
    color:#ddd6fe;margin-bottom:12px;
  }
  .action{
    display:flex;align-items:flex-start;gap:12px;font-size:13px;color:var(--text-soft);
    margin-bottom:10px;line-height:1.55;
    padding:12px 14px;border-radius:var(--radius-md);
    background:rgba(255,255,255,.03);
    border:1px solid rgba(148,163,184,.1);
    transition:background .18s ease,border-color .18s ease,transform .18s ease;
    cursor:default;
  }
  .action:hover{
    background:rgba(255,255,255,.06);
    border-color:rgba(34,211,238,.28);
    transform:translateX(3px);
  }
  .action:last-child{margin-bottom:0}
  .action-n{
    flex-shrink:0;width:24px;height:24px;border-radius:50%;
    background:linear-gradient(135deg,var(--cyan),var(--indigo));
    color:#030712;
    font-size:11px;font-weight:900;display:flex;align-items:center;justify-content:center;margin-top:1px;
    box-shadow:0 0 20px rgba(34,211,238,.4);
  }
  .grid{
    display:grid;
    grid-template-columns:1fr 1fr;
    gap:clamp(14px,2vw,22px);
    max-width:var(--content-max);
    margin:0 auto;
    padding:20px 0 36px;
  }
  @media(max-width:900px){.grid{grid-template-columns:1fr}}
  .card{
    position:relative;
    border-radius:var(--radius-lg);
    overflow:hidden;
    background:linear-gradient(165deg,rgba(255,255,255,.06) 0%,rgba(255,255,255,.02) 45%,rgba(15,23,42,.35) 100%);
    border:1px solid var(--stroke);
    backdrop-filter:blur(18px) saturate(1.15);
    box-shadow:0 8px 32px rgba(0,0,0,.28),0 0 0 1px rgba(255,255,255,.04) inset;
    transition:transform .22s ease,box-shadow .22s ease,border-color .22s ease;
  }
  .card::before{
    content:'';position:absolute;top:0;left:10%;right:10%;height:1px;
    background:linear-gradient(90deg,transparent,rgba(165,243,252,.35),rgba(167,139,250,.25),transparent);
    pointer-events:none;
  }
  .card:hover{
    transform:translateY(-4px);
    border-color:var(--stroke-bright);
    box-shadow:0 20px 56px rgba(0,0,0,.38),0 0 48px rgba(34,211,238,.1);
  }
  .card-hdr{
    display:flex;align-items:center;gap:11px;
    padding:16px 18px 13px;
    border-bottom:1px solid rgba(148,163,184,.1);
    background:linear-gradient(180deg,rgba(255,255,255,.05),transparent);
    cursor:default;
  }
  .icon{font-size:19px;line-height:1;filter:drop-shadow(0 0 10px rgba(34,211,238,.35))}
  .card-title{
    font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.1em;
    flex:1;color:#cbd5e1;
  }
  .badge{
    font-size:9px;font-weight:800;color:#fff;padding:4px 11px;border-radius:999px;
    letter-spacing:.04em;text-transform:uppercase;
    box-shadow:0 2px 12px rgba(0,0,0,.25);
  }
  .count-badge{font-size:11px;font-weight:700;color:#cbd5e1;background:rgba(15,23,42,.45);padding:3px 10px;border-radius:999px;border:1px solid rgba(148,163,184,.12)}
  .card-body{padding:14px 18px 16px}
  .item{
    padding:11px 12px;margin:0 -2px 8px;border-radius:var(--radius-md);
    border:1px solid transparent;
    border-bottom:1px solid rgba(148,163,184,.07);
    transition:background .16s ease,border-color .16s ease,transform .14s ease;
    cursor:default;
  }
  .item:last-child{border-bottom-color:transparent;margin-bottom:0}
  .item:hover{
    background:rgba(34,211,238,.07);
    border-color:rgba(34,211,238,.12);
    transform:translateY(-1px);
  }
  a.item-link{text-decoration:none;color:inherit;display:block;border-radius:var(--radius-md)}
  a.item-link:hover .hl{color:#fff}
  a.item-link .item-cta{
    display:flex;align-items:center;justify-content:space-between;margin-top:9px;padding-top:10px;
    border-top:1px dashed rgba(148,163,184,.18);
    font-size:11px;font-weight:700;color:#5eead4;letter-spacing:.02em;
  }
  a.item-link:hover .item-cta{color:#a5f3fc}
  .cta-icon{font-size:13px;opacity:.9}
  .item-tags{margin-top:7px}
  .item-top{display:flex;justify-content:space-between;align-items:flex-start;gap:10px}
  .hl{font-size:13px;font-weight:600;color:#f8fafc;line-height:1.45}
  .meta{font-size:10px;color:var(--muted);white-space:nowrap;flex-shrink:0;margin-top:2px;font-weight:500}
  .detail{font-size:12px;color:#cbd5e1;margin-top:4px;line-height:1.5}
  .tag{
    font-size:10px;font-weight:600;
    background:rgba(129,140,248,.16);color:#e9d5ff;
    padding:3px 9px;border-radius:8px;margin-right:5px;
    border:1px solid rgba(167,139,250,.22);
  }
  .empty{font-size:12px;color:var(--muted);font-style:italic;padding:10px 4px}
  .msg-text{font-size:12px;color:var(--text-soft);line-height:1.58;word-break:break-word}
  .msg-stats{font-size:10px;color:var(--muted);margin-top:5px;font-weight:500}
  .stat-row{display:flex;gap:clamp(16px,4vw,28px);padding:14px 0 12px;border-bottom:1px solid rgba(148,163,184,.08)}
  .stat-row:last-child{border-bottom:none}
  .stat-val{
    font-size:clamp(1.5rem,2vw + 1rem,2rem);font-weight:800;line-height:1;
    background:linear-gradient(90deg,#fff,#a5f3fc);
    -webkit-background-clip:text;background-clip:text;color:transparent;
  }
  .stat-lbl{font-size:11px;color:var(--muted);margin-top:5px;font-weight:500}
  .stat-crit .stat-val{background:none;-webkit-text-fill-color:unset;color:#fca5a5}
  .stat-warn .stat-val{background:none;-webkit-text-fill-color:unset;color:#fcd34d}
  .stat-ok .stat-val{background:none;-webkit-text-fill-color:unset;color:#6ee7b7}
  .footer{
    text-align:center;max-width:var(--content-max);margin:0 auto;
    padding:18px 12px 8px;font-size:11px;color:var(--muted2);font-weight:500;
  }
  .fab{
    position:fixed;bottom:max(22px,env(safe-area-inset-bottom));right:max(22px,env(safe-area-inset-right));
    z-index:50;
    background:linear-gradient(135deg,var(--cyan),var(--indigo) 55%,var(--violet));
    color:#030712;border:none;border-radius:50%;
    width:52px;height:52px;font-size:21px;font-weight:800;
    cursor:pointer;
    box-shadow:0 12px 40px rgba(99,102,241,.45),0 0 0 1px rgba(255,255,255,.22) inset,0 0 36px rgba(34,211,238,.25);
    transition:transform .22s ease,box-shadow .22s ease,filter .22s ease;
    display:flex;align-items:center;justify-content:center;
  }
  .fab:hover{transform:scale(1.07) rotate(-6deg);filter:brightness(1.08);box-shadow:0 16px 48px rgba(34,211,238,.4)}
  .fab:active{transform:scale(.96)}
  .fab:focus-visible{outline:2px solid var(--pink);outline-offset:4px}
  .note{font-size:11px;color:var(--muted);font-style:italic;padding:8px 0;line-height:1.5}
  .note strong{color:#e2e8f0;font-style:normal;font-weight:600}
  .mono-hint{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10px;color:#a5b4fc;font-style:normal;font-weight:500}
  .sub-tier-row{margin-top:8px}
  .sub-tier-pill{font-size:10px;font-weight:700;padding:4px 10px;border-radius:999px;line-height:1.4;display:inline-block;max-width:100%}
  .section-kicker{
    margin-top:12px;margin-bottom:8px;
    font-size:10px;font-weight:800;letter-spacing:.16em;text-transform:uppercase;
    background:linear-gradient(90deg,var(--cyan),var(--violet));
    -webkit-background-clip:text;background-clip:text;color:transparent;
  }
  .card.span-2{grid-column:1/-1}
  .slack-hot-top{align-items:center;margin-bottom:6px}
  .channel-chip{
    font-size:10px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;
    color:#a5f3fc;background:rgba(34,211,238,.1);border:1px solid rgba(34,211,238,.26);
    padding:4px 11px;border-radius:999px;flex-shrink:0;
  }
  .traction-pill{
    font-size:10px;font-weight:800;color:#fed7aa;background:rgba(234,88,12,.14);
    border:1px solid rgba(251,146,60,.32);padding:4px 11px;border-radius:999px;white-space:nowrap;
  }
  .item.item-hot{
    background:rgba(234,88,12,.07);
    border:1px solid rgba(251,146,60,.18);
    border-radius:var(--radius-md);
  }
  .filter-banner{
    max-width:var(--content-max);margin:14px auto 0;padding:12px 16px;border-radius:var(--radius-md);
    font-size:12px;font-weight:600;color:#e0f2fe;line-height:1.45;
    background:linear-gradient(135deg,rgba(34,211,238,.12),rgba(129,140,248,.1));
    border:1px solid rgba(165,243,252,.22);
    box-shadow:0 8px 28px rgba(0,0,0,.2);
  }
  .item.linear-quiet{opacity:.72}
`;

function filterRunBanner(meta) {
  if (!meta) return '';
  const hasSearch = Boolean(meta.briefingSearch);
  const scopeNarrow = meta.searchScope && meta.searchScope !== 'all';
  if (!hasSearch && !scopeNarrow) return '';
  const bits = [`Custom run · last ${meta.hours}h`];
  if (hasSearch) bits.push(`contains “${esc(meta.briefingSearch)}”`);
  if (scopeNarrow) bits.push(`${esc(meta.searchScope)} only`);
  return `<div class="filter-banner">${bits.join(' · ')}</div>`;
}

// ── Raw HTML (no Claude) ───────────────────────────────────────────────────────
function generateRawHTML(data, meta) {
  const { front, slack, sentry, linear } = data;

  // Derive a simple status from data
  const urgentCount = front?.urgentCount || 0;
  const openCount   = front?.openTotal   || 0;
  const openTrunc   = Boolean(front?.openTotalTruncated);
  const openVal     = openTrunc ? `≥${openCount}` : String(openCount);
  const openLbl     = openTrunc ? 'Open (at least)' : 'Open tickets';
  const hasSlackBugs = slack && !slack.skipped && (slack['bolt-bugs']?.messages?.length || 0) > 0;
  const status = urgentCount > 5 || hasSlackBugs ? 'elevated' : 'normal';
  const STATUS_CONFIG = {
    elevated: { color: '#d97706', bg: '#fffbeb', label: 'ELEVATED', dot: '🟡' },
    normal:   { color: '#059669', bg: '#ecfdf5', label: 'NORMAL',   dot: '🟢' },
    incident: { color: '#dc2626', bg: '#fef2f2', label: 'INCIDENT', dot: '🔴' },
  };
  const sc = STATUS_CONFIG[status];

  const srcPills = [
    meta.slack  ? `<span class="src on">✓ Slack</span>`  : `<span class="src off">✗ Slack</span>`,
    meta.front  ? `<span class="src on">✓ Front</span>`  : `<span class="src off">✗ Front</span>`,
    meta.sentry ? `<span class="src on">✓ Sentry</span>` : `<span class="src off">✗ Sentry</span>`,
    meta.linear ? `<span class="src on">✓ Linear</span>` : `<span class="src off">✗ Linear</span>`,
  ].join('');
  const quickLinks = renderQuickLinks(meta.queryLinks);

  // Front card
  function frontCard() {
    if (!front || front.skipped) {
      return card('🎫', 'Support Queue', 'info', '#94a3b8',
        `<div class="empty">Front not connected — add FRONT_API_KEY to .env</div>`);
    }
    if (front.error) {
      return card('🎫', 'Support Queue', 'info', '#94a3b8',
        `<div class="empty">Front error: ${esc(front.error)}</div>`);
    }

    const urgClass = urgentCount > 5 ? 'stat-crit' : urgentCount > 0 ? 'stat-warn' : 'stat-ok';
    const stats = `
      <div class="stat-row">
        <div><div class="stat-val">${openVal}</div><div class="stat-lbl">${openLbl}</div></div>
        <div class="${urgClass}"><div class="stat-val">${urgentCount}</div><div class="stat-lbl">Urgent</div></div>
        <div><div class="stat-val">${front.recentCount || 0}</div><div class="stat-lbl">Active last ${meta.hours}h</div></div>
      </div>
      ${openTrunc ? `<div class="note" style="margin-top:6px">Open count is a lower bound: Front returns up to 100 per request and there are more pages, or the run hit <span class="mono-hint">FRONT_BRIEFING_MAX_PAGES</span>.</div>` : ''}
      <div class="note" style="margin-top:10px;line-height:1.5">
        Sorted by <strong>subscription value</strong> (enterprise ≥$500/mo and qualifying teams first, then premium $300–400, high ~$200, medium $50–100, low &gt;$25–50, free ≤$25), then thread activity.
        Optional env: <span class="mono-hint">FRONT_MRR_FIELD_KEYS</span>, <span class="mono-hint">FRONT_SEATS_FIELD_KEYS</span> (comma-separated custom field keys).
      </div>`;

    const urgentItems = (front.urgentSamples || []).map(c => frontTicketRow(c)).join('');

    const recentItems = !urgentItems ? (front.recentSamples || []).slice(0, 8).map(c => frontTicketRow(c)).join('') : '';

    const body = stats + (urgentItems || recentItems
      ? `<div class="section-kicker">${urgentItems ? 'Urgent' : 'Recent'}</div>${urgentItems || recentItems}`
      : `<div class="note" style="margin-top:8px">No urgent tickets — queue looks calm</div>`);

    const badgeColor = urgentCount > 0 ? '#d97706' : '#059669';
    const badgeLabel = urgentCount > 0 ? 'urgent' : 'ok';
    return card('🎫', 'Support Queue', badgeLabel, badgeColor, body);
  }

  // Cross-channel Slack heat (reply traction first)
  function slackHotThreadsCard() {
    if (!slack || slack.skipped) return '';
    const hot = collectSlackHotThreads(slack, 16);
    const withReplies = hot.filter(h => (h.replies || 0) > 0).length;
    const badgeLabel = !hot.length ? 'no messages'
      : `${withReplies} with replies · top ${hot.length}`;
    const body = hot.length
      ? hot.map(msg => {
        const rep = msg.replies || 0;
        const rx = msg.reactions || 0;
        const hotCls = rep >= 3 ? ' item-hot' : '';
        return `
        <div class="item${hotCls}">
          <div class="item-top slack-hot-top">
            <span class="channel-chip">#${esc(msg.channel)}</span>
            <span class="traction-pill">${rep} repl${rep === 1 ? 'y' : 'ies'}${rx ? ` · ${rx} reactions` : ''}</span>
          </div>
          <div class="msg-text">${esc(msg.text)}</div>
          <div class="msg-stats">${fmtTime(msg.time)} · ${relTime(msg.time)}</div>
        </div>`;
      }).join('')
      : `<div class="empty">${meta.briefingSearch ? `No Slack threads match “${esc(meta.briefingSearch)}” in the last ${meta.hours}h` : `No Slack messages in the last ${meta.hours}h`}</div>`;
    const badgeColor = withReplies >= 4 ? '#ea580c' : hot.length ? '#d97706' : '#64748b';
    return card('🔥', 'Slack — hottest threads (reply traction)', badgeLabel, badgeColor, body, 'span-2');
  }

  // Slack channel cards
  function slackCards() {
    if (!slack || slack.skipped) {
      const hint = esc(slack?.reason || 'Add SLACK_BOT_TOKEN, or use Claude Desktop Slack MCP → JSON → node index.js --no-slack-api --slack-json=file.json (see .cursor/skills/cx-briefing-claude-desktop/SKILL.md)');
      return card('💬', 'Slack', 'info', '#94a3b8',
        `<div class="empty">Slack not in this run.</div><div class="note">${hint}</div>`);
    }

    const CHANNEL_META = {
      'bolt-bugs':               { icon: '🐛', title: 'Bolt Bugs',       color: '#dc2626' },
      'cx-core':                 { icon: '🎯', title: 'CX Core',         color: '#3b82f6' },
      'cx-team':                 { icon: '👥', title: 'CX Team',         color: '#3b82f6' },
      'product-releases':        { icon: '🚀', title: 'Releases',        color: '#7c3aed' },
      'announcements':           { icon: '📢', title: 'Announcements',   color: '#7c3aed' },
      'bolt-eng-support':        { icon: '🔧', title: 'Eng Support',     color: '#0891b2' },
      'ext-parahelp-stackblitz': { icon: '🤝', title: 'Parahelp',       color: '#0891b2' },
      'general':                 { icon: '💬', title: 'General',         color: '#64748b' },
    };

    return SLACK_CHANNELS.map(({ name, priority: defaultPri }) => {
      const ch = slack[name] || { messages: [], priority: defaultPri };
      const m  = CHANNEL_META[name] || { icon: '#', title: name, color: '#64748b' };
      const msgs = sortSlackMessagesByTraction(ch.messages || []);
      if (ch.note && !msgs.length) {
        return card(m.icon, `#${name}`, 'info', '#94a3b8',
          `<div class="empty">${esc(ch.note)}</div>`);
      }
      const pri = ch.priority || defaultPri;
      const items = msgs.slice(0, 8).map(msg => {
        const rep = msg.replies || 0;
        const rowHot = rep >= 3 ? ' item-hot' : '';
        return `
        <div class="item${rowHot}">
          <div class="msg-text">${esc(msg.text)}</div>
          <div class="msg-stats">
            ${fmtTime(msg.time)}
            ${msg.reactions ? ` · ${msg.reactions} reactions` : ''}
            ${rep ? ` · ${rep} repl${rep === 1 ? 'y' : 'ies'}` : ''}
          </div>
        </div>`;
      }).join('');
      const count = msgs.length;
      const body  = items || `<div class="empty">${meta.briefingSearch ? `No messages match “${esc(meta.briefingSearch)}” in the last ${meta.hours}h` : `No messages in the last ${meta.hours}h`}</div>`;
      const badgeColor = name === 'bolt-bugs' && count > 0 ? '#dc2626'
        : pri === 'high' && count > 0 ? '#d97706' : '#94a3b8';
      const badgeLabel = count > 0 ? `${count} msg${count > 1 ? 's' : ''}` : 'quiet';
      return card(m.icon, `#${name}`, badgeLabel, badgeColor, body);
    }).join('\n');
  }

  // Sentry card
  function sentryCard() {
    if (!sentry || sentry.skipped) {
      return card('🐞', 'Sentry Errors', 'info', '#94a3b8',
        `<div class="empty">Sentry not connected — add SENTRY_AUTH_TOKEN to .env</div>`);
    }
    const issues = sentry.issues || [];
    const items  = issues.slice(0, 8).map(i => `
      <div class="item">
        <div class="item-top">
          <span class="hl">${esc(i.title)}</span>
          <span class="meta">${esc(i.project || '')} · ${relTime(i.last)}</span>
        </div>
        <div class="detail">${i.count || 0} events · ${i.users || 0} users affected</div>
      </div>`).join('');
    const badgeColor = issues.length > 5 ? '#dc2626' : issues.length > 0 ? '#d97706' : '#059669';
    return card('🐞', 'Sentry Errors', `${issues.length} new`, badgeColor,
      items || `<div class="empty">${meta.briefingSearch ? `No Sentry issues match “${esc(meta.briefingSearch)}” in the last ${meta.hours}h` : `No new errors in the last ${meta.hours}h`}</div>`);
  }

  function linearIssueRow(issue, { quiet } = {}) {
    const links = (issue.linkedIssues || []).slice(0, 4).map(L =>
      (L.url
        ? `<a href="${esc(L.url)}" target="_blank" rel="noopener noreferrer">${esc(L.id || L.title || 'link')}</a>`
        : esc(L.id || L.title || ''))
    ).filter(Boolean).join(', ');
    const relPill = issue.relationCount
      ? `<span class="traction-pill">${issue.relationCount} linked</span>`
      : `<span class="meta">0 linked</span>`;
    const hotCls = issue.relationCount >= 3 ? ' item-hot' : '';
    const qCls = quiet ? ' linear-quiet' : '';
    return `
      <div class="item${hotCls}${qCls}">
        <div class="item-top slack-hot-top">
          <a class="hl" href="${esc(issue.url)}" target="_blank" rel="noopener noreferrer">${esc(issue.identifier)} · ${esc(issue.title)}</a>
          ${relPill}
        </div>
        ${issue.summary ? `<div class="msg-text">${esc(issue.summary)}</div>` : ''}
        <div class="detail">${esc(issue.stateName || '')}${issue.assignee ? ` · ${esc(issue.assignee)}` : ''}${issue.creatorName ? ` · by ${esc(issue.creatorName)}` : ''} · upd ${relTime(issue.updatedAt)} · new ${relTime(issue.createdAt)}${links ? ` · ${links}` : ''}</div>
      </div>`;
  }

  function linearCard() {
    if (!linear || linear.skipped) {
      const why = linear?.reason ? esc(linear.reason) : 'Add <span class="mono-hint">LINEAR_API_KEY</span> + <span class="mono-hint">LINEAR_TEAM_IDS</span> (team UUIDs from Linear Cmd/Ctrl+K).';
      return card('◆', 'Linear — CX bugs', 'info', '#94a3b8',
        `<div class="empty">${why}</div>
         <div class="note" style="margin-top:8px">New vs. trending bugs (linked issues + recency). Optional: <span class="mono-hint">LINEAR_LABEL_NAMES</span> (e.g. <span class="mono-hint">Bug,CX</span>), <span class="mono-hint">LINEAR_CREATOR_EMAIL</span>, <span class="mono-hint">LINEAR_NEW_BUGS_DAYS</span>, <span class="mono-hint">LINEAR_MAX_ISSUES_FETCH</span>.</div>`);
    }
    if (linear.error) {
      return card('◆', 'Linear — CX bugs', 'info', '#94a3b8',
        `<div class="empty">Linear error: ${esc(linear.error)}</div>`);
    }
    const nd = linear.newIssuesLookbackDays || 7;
    const newList = (linear.newBugs || []).slice(0, 12);
    const trend = (linear.trending || []).slice(0, 14);
    const trendRows = trend.map((issue, idx) => {
      const quiet = issue.relationCount === 0 && idx >= Math.max(0, trend.length - 5);
      return linearIssueRow(issue, { quiet });
    }).join('');
    const newRows = newList.length
      ? newList.map(issue => linearIssueRow(issue, { quiet: false })).join('')
      : `<div class="empty">No issues created in the last ${nd} days (in this fetch).</div>`;
    const truncNote = linear.listTruncated
      ? `<div class="note" style="margin-top:8px">List may be incomplete — raise <span class="mono-hint">LINEAR_MAX_ISSUES_FETCH</span> or narrow <span class="mono-hint">LINEAR_LABEL_NAMES</span>.</div>`
      : '';
    const badge = `${(linear.newBugs || []).length} new / ${linear.fetchedTotal || 0} open`;
    const body = `
      <div class="note" style="margin-bottom:10px;line-height:1.5">
        <strong>New</strong> = created in the last <strong>${nd}</strong> days (not the Slack lookback). <strong>Trending</strong> = same open set, ranked by linked issues + priority + last update — busy bugs float up, quiet ones sink.
      </div>
      <div class="section-kicker">New (last ${nd} days)</div>
      ${newRows}
      <div class="section-kicker" style="margin-top:14px">Trending (activity / links)</div>
      ${trendRows || `<div class="empty">No open issues matched filters.</div>`}
      ${truncNote}`;
    const badgeColor = (linear.newBugs || []).length > 6 ? '#ea580c' : (linear.fetchedTotal || 0) > 0 ? '#6366f1' : '#64748b';
    return card('◆', 'Linear — CX bugs', badge, badgeColor, body, 'span-2');
  }

  function card(icon, title, badgeLabel, badgeColor, body, extraClass = '') {
    return `
    <div class="card${extraClass ? ` ${extraClass}` : ''}">
      <div class="card-hdr">
        <span class="icon">${icon}</span>
        <span class="card-title">${esc(title)}</span>
        <span class="badge" style="background:${badgeColor}">${esc(badgeLabel)}</span>
      </div>
      <div class="card-body">${body}</div>
    </div>`;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>CX Briefing</title>
<style>
  ${CSS}
  :root { --sc: ${sc.color}; }
</style>
</head>
<body>
<div class="header">
  <div class="h1">
    <div class="title-block">
      <div class="title-row">
        <span class="bolt-mark" aria-hidden="true"></span>
        <div class="title">CX Daily Briefing</div>
      </div>
      <div class="subtitle">bolt<span class="subtitle-dot">.</span>new</div>
    </div>
    <div class="status-pill" style="--pill-fg:${sc.color}">${sc.dot} ${sc.label}</div>
  </div>
  <div class="h2">
    <span class="ts">${esc(NOW_LABEL)} · last ${meta.hours}h</span>
    ${srcPills}
    ${refetchButtonHtml()}
  </div>
  ${quickLinks}
</div>
${filterRunBanner(meta)}

<div class="grid">
  ${slackHotThreadsCard()}
  ${frontCard()}
  ${sentryCard()}
  ${linearCard()}
  ${slackCards()}
</div>

<div class="footer">Generated ${esc(NOW_LABEL)} · ${HOURS}h window · cx-briefing</div>
<button class="fab" onclick="location.reload()" title="Reload this page (same saved file)">↻</button>
</body>
</html>`;
}

// ── AI HTML (with Claude) ──────────────────────────────────────────────────────
function generateAIHTML(briefing, data, meta) {
  const STATUS = {
    incident: { color: '#dc2626', bg: '#fef2f2', label: 'INCIDENT', dot: '🔴' },
    elevated: { color: '#d97706', bg: '#fffbeb', label: 'ELEVATED', dot: '🟡' },
    normal:   { color: '#059669', bg: '#ecfdf5', label: 'NORMAL',   dot: '🟢' },
  };
  const sc = STATUS[briefing.status] || STATUS.normal;

  const srcPills = [
    meta.slack  ? `<span class="src on">✓ Slack</span>`  : `<span class="src off">✗ Slack</span>`,
    meta.front  ? `<span class="src on">✓ Front</span>`  : `<span class="src off">✗ Front</span>`,
    meta.sentry ? `<span class="src on">✓ Sentry</span>` : `<span class="src off">✗ Sentry</span>`,
    meta.linear ? `<span class="src on">✓ Linear</span>` : `<span class="src off">✗ Linear</span>`,
    `<span class="src on">✓ AI summary</span>`,
  ].join('');
  const quickLinks = renderQuickLinks(meta.queryLinks);

  const actionsHTML = (briefing.topActions || []).map((a, i) =>
    `<div class="action"><span class="action-n">${i + 1}</span><span>${esc(a)}</span></div>`
  ).join('');

  // Embed the raw data dashboard inside the AI version too (below the summary)
  const rawContent = generateRawHTML(data, meta)
    .replace(/.*<body>/s, '') // strip everything up to body
    .replace(/<\/body>.*/s, '') // strip everything after body
    .replace(/<div class="header">.*?<\/div>\s*<\/div>\s*<\/div>/s, '') // remove header
    .replace(/<div class="filter-banner">[\s\S]*?<\/div>\s*/, '') // avoid duplicate banner (shown on AI header)
    .replace(/<div class="footer">.*?<\/div>/s, '') // remove footer
    .replace(/<button class="fab".*?<\/button>/s, ''); // remove fab

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>CX Briefing — AI</title>
<style>
  ${CSS}
  :root { --sc: ${sc.color}; }
</style>
</head>
<body>
<div class="header">
  <div class="h1">
    <div class="title-block">
      <div class="title-row">
        <span class="bolt-mark" aria-hidden="true"></span>
        <div class="title">CX Daily Briefing</div>
      </div>
      <div class="subtitle">bolt<span class="subtitle-dot">.</span>new</div>
    </div>
    <div class="status-pill" style="--pill-fg:${sc.color}">${sc.dot} ${sc.label}</div>
  </div>
  <div class="h2">
    <span class="ts">${esc(NOW_LABEL)} · last ${meta.hours}h</span>
    ${srcPills}
    ${refetchButtonHtml()}
  </div>
  ${quickLinks}
</div>
${filterRunBanner(meta)}

<div class="ai-bar" style="--sc:${sc.color}">
  <div class="ai-summary">${esc(briefing.summary)}</div>
  <div class="ai-reason">${esc(briefing.statusReason)}</div>
</div>

${actionsHTML ? `<div class="actions"><div class="actions-lbl">Priority Actions</div>${actionsHTML}</div>` : ''}

${rawContent}

<div class="footer">Generated ${esc(NOW_LABEL)} · ${HOURS}h window · cx-briefing + Claude</div>
<button class="fab" onclick="location.reload()" title="Reload this page (same saved file)">↻</button>
</body>
</html>`;
}

// ── Front summary mode (for Claude Desktop prompt injection) ───────────────────
async function frontSummaryMode() {
  if (!FETCH_FRONT) {
    console.log('Front summary skipped (--scope excludes front)');
    return;
  }
  const data = await fetchFrontData();
  if (data.skipped || data.error) {
    console.log('Front: not available');
    return;
  }
  const subBits = c => {
    const bits = [c.subscriptionLabel, c.mrr != null && Number.isFinite(c.mrr) ? `~$${Math.round(c.mrr)}/mo` : null, c.seats != null ? `${c.seats} seats` : null]
      .filter(Boolean);
    return bits.length ? ` | ${bits.join(' · ')}` : '';
  };
  const lines = [
    `Open tickets: ${data.openTotalTruncated ? `≥${data.openTotal} (lower bound — more pages or page cap)` : data.openTotal}`,
    `Urgent/escalated: ${data.urgentCount}`,
    `Active in last ${HOURS}h: ${data.recentCount}`,
    `Inboxes: ${(data.inboxes || []).join(', ')}`,
    'Sort: subscription tier (enterprise → free), then activity.',
    ...(CUSTOM_SEARCH ? [`Subject filter: ${CUSTOM_SEARCH}`] : []),
  ];
  if (data.urgentSamples?.length) {
    lines.push('\nUrgent tickets (open in Front):');
    data.urgentSamples.forEach(c =>
      lines.push(`  • ${c.subject || '(no subject)'} [${(c.tags || []).join(', ')}]${c.messageCount ? ` (${c.messageCount} msgs)` : ''}${subBits(c)}${c.openUrl ? ` — ${c.openUrl}` : ''}`)
    );
  }
  if (data.recentSamples?.length) {
    lines.push('\nRecent activity:');
    data.recentSamples.slice(0, 8).forEach(c =>
      lines.push(`  • ${c.subject || '(no subject)'} [${(c.tags || []).join(', ')}]${subBits(c)}${c.openUrl ? ` — ${c.openUrl}` : ''}`)
    );
  }
  process.stdout.write(lines.join('\n') + '\n');
}

/** Build HTML (and optional path from Claude CLI). When skipCLI, skips long CLI path (for --serve refresh). */
async function buildBriefingHtmlAndPath(options = {}) {
  const skipCLI = Boolean(options.skipCLI);

  console.log(`\n⚡ CX Briefing — last ${HOURS}h\n`);
  if (CUSTOM_SEARCH || SEARCH_SCOPE !== 'all') {
    console.log(`  Custom: scope=${SEARCH_SCOPE}${CUSTOM_SEARCH ? ` search=${JSON.stringify(CUSTOM_SEARCH)}` : ''}`);
  }

  const [slackData, frontData, sentryData, linearData] = await Promise.all([
    FETCH_SLACK  ? fetchSlackData()  : Promise.resolve({ skipped: true, reason: `Not loaded (--scope=${SEARCH_SCOPE})` }),
    FETCH_FRONT  ? fetchFrontData()  : Promise.resolve({ skipped: true, reason: `Not loaded (--scope=${SEARCH_SCOPE})` }),
    FETCH_SENTRY ? fetchSentryData() : Promise.resolve({ skipped: true, reason: `Not loaded (--scope=${SEARCH_SCOPE})` }),
    FETCH_LINEAR ? fetchLinearData() : Promise.resolve({ skipped: true, reason: `Not loaded (--scope=${SEARCH_SCOPE})` }),
  ]);

  const rawData = {
    slack: slackData,
    front: frontData,
    sentry: sentryData,
    linear: linearData,
    slackHotThreads: collectSlackHotThreads(slackData),
    briefingFilters: {
      hours: HOURS,
      search: CUSTOM_SEARCH || null,
      scope: SEARCH_SCOPE,
    },
  };
  const meta = {
    hours:  HOURS,
    slack:  !slackData?.skipped,
    front:  !frontData?.skipped,
    sentry: !sentryData?.skipped,
    linear: Boolean(linearData && !linearData.skipped && !linearData.error),
    queryLinks: buildQueryLinks(),
    briefingSearch: CUSTOM_SEARCH || null,
    searchScope: SEARCH_SCOPE,
  };

  let html = null;

  if (ENV.claude) {
    try {
      console.log('  Mode: Claude API');
      const briefing = await synthesizeViaAPI(rawData);
      html = generateAIHTML(briefing, rawData, meta);
    } catch (e) {
      console.warn(`  ⚠ API synthesis failed (${e.message})`);
    }
  }

  if (!html && !skipCLI) {
    try {
      console.log('  Mode: claude CLI (reads Slack via MCP)');
      const cliPath = await synthesizeViaCLI({ front: frontData, linear: linearData });
      if (cliPath && fs.existsSync(cliPath)) {
        return {
          html:      fs.readFileSync(cliPath, 'utf8'),
          outPath:   cliPath,
          fromCli:   true,
        };
      }
    } catch (e) {
      console.warn(`  ⚠ Claude CLI failed (${e.message}), falling back to raw view`);
    }
  } else if (!html && skipCLI) {
    console.log('  (serve refresh: skipping claude CLI — use API key or raw dashboard)');
  }

  if (!html) {
    console.log('  Mode: raw data dashboard');
    html = generateRawHTML(rawData, meta);
  }

  const outPath = path.join(os.tmpdir(), `cx-briefing-${Date.now()}.html`);
  fs.writeFileSync(outPath, html, 'utf8');
  return { html, outPath, fromCli: false };
}

// ── Main ───────────────────────────────────────────────────────────────────────
async function main() {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`
cx-briefing — usage

  node index.js [options]

Time
  --hours=N                 Lookback (default 16 or LOOKBACK_HOURS)

Custom slice (optional)
  --search=TEXT             Case-insensitive substring on:
                            · Front: conversation subject (open queue)
                            · Slack: message text (--scope slack|all)
                            · Sentry: issue title (--scope sentry|all)
                            · Linear: issue title + description snippet (--scope linear|all)
  --subject=TEXT            Alias for --search=
  --q=TEXT                  Alias for --search=
  --scope=SCOPE             all | front | slack | sentry | linear — which APIs to call

Slack
  --slack-json=PATH         Slack from MCP merge JSON
  --no-slack-api            Skip Slack REST

Serve / misc
  --serve[=PORT]            http://127.0.0.1:PORT/ with live refetch (default 3751)
  --mode=front-summary      Print Front text to stdout
  --mode=slack-json-stub    Print empty Slack JSON shape

Examples
  node index.js --hours=48 --search=invoice
  node index.js --scope=slack --search=refund --hours=24
  node index.js --scope=front --subject=acme
  node index.js --scope=linear --hours=24
`);
    return;
  }
  if (process.argv.includes('--mode=front-summary')) return frontSummaryMode();
  if (process.argv.includes('--mode=slack-json-stub')) return printSlackJsonStub();

  if (SERVE_PORT > 0) {
    const server = http.createServer(async (req, res) => {
      const pathOnly = (req.url || '').split('?')[0];
      if (pathOnly !== '/') {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
        return;
      }
      try {
        console.log('\n→ Refetch (HTTP)…');
        const { html } = await buildBriefingHtmlAndPath({ skipCLI: true });
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store, no-cache, must-revalidate',
        });
        res.end(html);
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(`Error: ${e.message}`);
      }
    });

    server.listen(SERVE_PORT, '127.0.0.1', () => {
      const url = `http://127.0.0.1:${SERVE_PORT}/`;
      console.log(`\n✅  Live briefing: ${url}`);
      console.log('   “Fetch again” in the header (or any refresh) re-runs Front + Slack + Sentry (+ Linear when configured).');
      console.log('   Stop with Ctrl+C.\n');
      try { execSync(`open "${url}"`); }
      catch { console.log(`   Open manually: open "${url}"`); }
    });

    server.on('error', err => {
      console.error('\n❌ Serve failed:', err.message);
      process.exit(1);
    });
    return;
  }

  const { outPath } = await buildBriefingHtmlAndPath({ skipCLI: false });

  console.log(`\n✅  Dashboard: ${outPath}`);
  try { execSync(`open "${outPath}"`); }
  catch { console.log(`   Open manually: open "${outPath}"`); }
}

main().catch(e => { console.error('\n❌ Fatal:', e.message); process.exit(1); });
