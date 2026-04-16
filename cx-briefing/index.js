#!/usr/bin/env node
'use strict';

/**
 * CX Daily Briefing
 *
 * Fetches data from Slack, Front, and Sentry then opens an HTML dashboard.
 * Works WITHOUT an Anthropic API key — generates a structured data dashboard.
 * If ANTHROPIC_API_KEY is set, Claude adds an AI-synthesized summary on top.
 *
 * Usage:
 *   node index.js                       # 16h lookback (default)
 *   node index.js --hours=8             # custom window
 *   node index.js --slack-json=/tmp/x   # use pre-fetched Slack data (MCP mode)
 *
 * Required env (at least one data source):
 *   FRONT_API_KEY       — Front token (Conversations:Read, Tags:Read, Inboxes:Read)
 *   SLACK_BOT_TOKEN     — xoxb-... (channels:history, channels:read, groups:history, groups:read)
 *
 * Optional:
 *   ANTHROPIC_API_KEY   — adds AI synthesis layer (not required)
 *   SENTRY_AUTH_TOKEN   — Sentry errors section
 *   SENTRY_ORG          — org slug (default: stackblitz)
 *   LOOKBACK_HOURS      — override default 16h
 *   QUERY_DASHBOARD_URL — internal Query dashboard link shown in briefing
 *   QUERY_TICKET_ANALYZER_URL — internal ticket analyzer link shown in briefing
 */

const https  = require('https');
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
const DEFAULT_QUERY_DASHBOARD_URL = 'https://query-new.utility.stackblitz.dev/dashboard/ba70a056-06d3-4a46-8340-6d18ac188683?chat=collapsed';
const DEFAULT_QUERY_TICKET_ANALYZER_URL = 'https://query-new.utility.stackblitz.dev/workflows/7ccc7ec0-0de6-4ab2-a5e7-c9c178d29f43/798873df-143f-4632-ac45-ee417a68a47a';

const ENV = {
  claude:    process.env.ANTHROPIC_API_KEY,
  slack:     process.env.SLACK_BOT_TOKEN,
  front:     process.env.FRONT_API_KEY,
  sentry:    process.env.SENTRY_AUTH_TOKEN,
  sentryOrg: process.env.SENTRY_ORG || 'stackblitz',
  queryDashboardUrl: process.env.QUERY_DASHBOARD_URL || DEFAULT_QUERY_DASHBOARD_URL,
  queryTicketAnalyzerUrl: process.env.QUERY_TICKET_ANALYZER_URL || DEFAULT_QUERY_TICKET_ANALYZER_URL,
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

// ── Slack ──────────────────────────────────────────────────────────────────────
async function fetchSlackData() {
  // MCP mode: pre-gathered Slack data passed in as a JSON file
  const slackJsonArg = process.argv.find(a => a.startsWith('--slack-json='));
  if (slackJsonArg) {
    const jsonPath = slackJsonArg.split('=')[1];
    console.log(`→ Slack data from file (MCP mode): ${jsonPath}`);
    const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    const total = Object.values(data).reduce((n, ch) => n + (ch.messages?.length || 0), 0);
    console.log(`  ✓ ${total} messages from ${Object.keys(data).length} channels`);
    return data;
  }

  if (!ENV.slack) return { skipped: true, reason: 'No SLACK_BOT_TOKEN' };
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
    const messages = (res.body.messages || [])
      .filter(m => m.type === 'message' && !m.subtype)
      .map(m => ({
        time:      new Date(parseFloat(m.ts) * 1000).toISOString(),
        text:      (m.text || '').slice(0, 700),
        reactions: (m.reactions || []).reduce((n, r) => n + r.count, 0),
        replies:   m.reply_count || 0,
      }));
    results[ch.name] = { priority: ch.priority, messages };
    console.log(`  ✓ #${ch.name}: ${messages.length} messages`);
  }
  return results;
}

// ── Front ──────────────────────────────────────────────────────────────────────
async function fetchFrontData() {
  if (!ENV.front) return { skipped: true, reason: 'No FRONT_API_KEY' };
  console.log('→ Fetching Front...');

  const h = { Authorization: `Bearer ${ENV.front}` };
  try {
    // Front statuses: 'unassigned' and 'assigned' = open. 'archived' = resolved.
    const [convRes, inboxRes] = await Promise.all([
      apiRequest('https://api2.frontapp.com/conversations?q[statuses][]=unassigned&q[statuses][]=assigned&sort_by=date&sort_order=desc&limit=100', { headers: h }),
      apiRequest('https://api2.frontapp.com/inboxes', { headers: h }),
    ]);

    const convs   = convRes.body._results  || [];
    const inboxes = inboxRes.body._results || [];
    const sinceMs = SINCE_TS * 1000;
    const recent  = convs.filter(c => (c.last_message?.created_at * 1000 || 0) > sinceMs);
    const urgent  = convs.filter(c =>
      c.tags?.some(t => /urgent|escalat|critical|vip|p[01]|high|churn/i.test(t.name || ''))
    );
    const fmt = c => ({
      subject: c.subject,
      tags:    c.tags?.map(t => t.name) || [],
      updated: new Date((c.last_message?.created_at || 0) * 1000).toISOString(),
    });

    console.log(`  ✓ Front: ${convs.length} open, ${urgent.length} urgent, ${recent.length} in window`);
    return {
      openTotal:     convs.length,
      urgentCount:   urgent.length,
      recentCount:   recent.length,
      inboxes:       inboxes.slice(0, 8).map(i => i.name),
      urgentSamples: urgent.slice(0, 10).map(fmt),
      recentSamples: recent.slice(0, 15).map(fmt),
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
    const issues = (Array.isArray(res.body) ? res.body : []).map(i => ({
      title: i.title, level: i.level, count: i.count,
      users: i.userCount, project: i.project?.slug,
      first: i.firstSeen, last: i.lastSeen,
    }));
    console.log(`  ✓ Sentry: ${issues.length} issues`);
    return { issues };
  } catch (e) {
    console.warn(`  ✗ Sentry: ${e.message}`);
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
async function synthesizeViaCLI(frontData) {
  console.log('→ Using claude CLI for Slack + synthesis...');

  const claudeBin = (() => {
    for (const p of [
      '/opt/homebrew/bin/claude', '/usr/local/bin/claude',
      `${process.env.HOME}/.volta/bin/claude`,
    ]) { if (fs.existsSync(p)) return p; }
    try { return execSync('which claude', { encoding: 'utf8' }).trim(); } catch { return null; }
  })();
  if (!claudeBin) throw new Error('claude CLI not found');

  const frontPath = path.join(os.tmpdir(), 'cx-front.json');
  const outPath   = path.join(os.tmpdir(), `cx-briefing-${Date.now()}.html`);
  fs.writeFileSync(frontPath, JSON.stringify(frontData, null, 2));

  const prompt = `You are generating a CX daily briefing for bolt.new support agents (last ${HOURS}h).

Step 1 — Read Slack channels
Use the slack_read_channel tool for each channel (read all, skip none):
${SLACK_CHANNELS.map(c => `• ${c.name} (${c.priority})`).join('\n')}
Focus on: questions needing replies, reported bugs, incidents, product changes, team updates.

Step 2 — Read Front queue data
Read the file at: ${frontPath}

Step 3 — Generate HTML briefing
Write a complete self-contained HTML file (inline CSS only, no external deps) to: ${outPath}

The HTML must include:
- Dark header: "⚡ CX Briefing" + date + status badge (🔴 INCIDENT / 🟡 ELEVATED / 🟢 NORMAL)
- Quick links row with:
  - Query Dashboard: ${ENV.queryDashboardUrl}
  - Ticket Analyzer: ${ENV.queryTicketAnalyzerUrl}
- Bold summary box: 2-3 sentences on what happened + what needs attention
- "Needs Reply" section: Slack threads/messages that need a CX response (highlight these prominently)
- Priority Actions: numbered list of top 5 things the team must do
- Cards: Incidents & Bugs | Product Updates | CX Highlights | Support Queue | Engineering Signals
- Style: clean, readable, #0f172a header, card grid, color-coded by severity

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
function renderQuickLinks(links = []) {
  const validLinks = links.filter(link => link?.url);
  if (!validLinks.length) return '';
  const linkHTML = validLinks.map(link =>
    `<a class="quick-link" href="${esc(link.url)}" target="_blank" rel="noopener noreferrer">${esc(link.label)} ↗</a>`
  ).join('');
  return `<div class="quick-links">${linkHTML}</div>`;
}

const CSS = `
  :root{
    --bolt-cyan:#22d3ee;--bolt-violet:#a78bfa;--bolt-pink:#f472b6;
    --surface:#0b1220;--surface-2:#111b2e;--text:#e2e8f0;--muted:#94a3b8;
    --card-bg:rgba(255,255,255,.04);--card-border:rgba(148,163,184,.12);
    --glow:0 0 24px rgba(34,211,238,.25);
  }
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  html{scroll-behavior:smooth}
  body{
    font-family:-apple-system,BlinkMacSystemFont,'Inter','Segoe UI',sans-serif;
    color:var(--text);min-height:100vh;
    background:radial-gradient(1200px 600px at 10% -10%,rgba(34,211,238,.18),transparent 55%),
      radial-gradient(900px 500px at 95% 0%,rgba(167,139,250,.16),transparent 50%),
      linear-gradient(165deg,#020617 0%,#0f172a 38%,#0c1322 100%);
    background-attachment:fixed;
  }
  @keyframes header-shine{
    0%{background-position:0% 50%}
    100%{background-position:200% 50%}
  }
  .header{
    position:relative;color:#f8fafc;padding:22px 28px 20px;
    background:linear-gradient(135deg,rgba(15,23,42,.95) 0%,rgba(30,27,75,.55) 100%);
    border-bottom:1px solid rgba(148,163,184,.15);
    box-shadow:0 12px 40px rgba(0,0,0,.35);
    overflow:hidden;
  }
  .header::before{
    content:'';position:absolute;inset:-1px;pointer-events:none;
    background:linear-gradient(110deg,transparent,rgba(34,211,238,.12),rgba(167,139,250,.12),transparent);
    background-size:200% 100%;animation:header-shine 8s linear infinite;
    opacity:.85;
  }
  .header > *{position:relative;z-index:1}
  .h1{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
  .title-block{display:flex;flex-direction:column;gap:2px}
  .subtitle{font-size:10px;font-weight:700;letter-spacing:.28em;text-transform:uppercase;color:rgba(165,243,252,.55)}
  .title{
    font-size:22px;font-weight:800;letter-spacing:-.4px;
    background:linear-gradient(90deg,#f8fafc 0%,#a5f3fc 45%,#c4b5fd 100%);
    -webkit-background-clip:text;background-clip:text;color:transparent;
    text-shadow:0 0 40px rgba(34,211,238,.35);
  }
  .status-pill{
    display:inline-flex;align-items:center;gap:6px;padding:6px 14px;border-radius:999px;
    font-size:11px;font-weight:800;letter-spacing:.85px;
    border:1px solid rgba(255,255,255,.12);backdrop-filter:blur(8px);
    box-shadow:0 0 0 1px rgba(255,255,255,.06) inset,0 4px 16px rgba(0,0,0,.2);
    cursor:default;
  }
  .h2{margin-top:10px;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
  .ts{font-size:12px;color:var(--muted)}
  .src{font-size:10px;font-weight:700;padding:4px 9px;border-radius:999px;border:1px solid transparent;transition:transform .15s ease,box-shadow .15s ease}
  .src.on{background:rgba(34,211,238,.12);color:#a5f3fc;border-color:rgba(34,211,238,.25);box-shadow:0 0 12px rgba(34,211,238,.12)}
  .src.off{background:rgba(30,41,59,.6);color:#64748b;border-color:rgba(71,85,105,.4)}
  .quick-links{margin:14px 0 0;display:flex;gap:10px;flex-wrap:wrap}
  .quick-link{
    font-size:12px;font-weight:700;text-decoration:none;padding:10px 16px;border-radius:999px;
    color:#ecfeff;background:linear-gradient(135deg,rgba(34,211,238,.2),rgba(167,139,250,.18));
    border:1px solid rgba(165,243,252,.35);
    box-shadow:0 4px 20px rgba(34,211,238,.15),0 0 0 1px rgba(255,255,255,.06) inset;
    transition:transform .18s ease,box-shadow .18s ease,border-color .18s ease,filter .18s ease;
    cursor:pointer;
  }
  .quick-link:hover{
    transform:translateY(-2px);
    border-color:rgba(244,114,182,.45);
    box-shadow:0 8px 28px rgba(167,139,250,.35),var(--glow);
    filter:brightness(1.06);
  }
  .quick-link:active{transform:translateY(0)}
  .quick-link:focus-visible{outline:2px solid #22d3ee;outline-offset:3px}
  .ai-bar{
    margin:18px 24px 0;
    background:linear-gradient(145deg,rgba(255,255,255,.08),rgba(255,255,255,.03));
    border:1px solid rgba(148,163,184,.2);
    border-left:4px solid var(--sc);
    border-radius:14px;padding:16px 20px;
    backdrop-filter:blur(12px);
    box-shadow:0 8px 32px rgba(0,0,0,.25),0 0 0 1px rgba(255,255,255,.04) inset;
  }
  .ai-summary{font-size:15px;color:#f1f5f9;line-height:1.65;font-weight:500}
  .ai-reason{margin-top:8px;font-size:12px;color:var(--muted)}
  .actions{
    margin:14px 24px 0;
    background:linear-gradient(160deg,rgba(30,27,75,.55),rgba(15,23,42,.75));
    border:1px solid rgba(129,140,248,.25);
    border-radius:14px;padding:16px 20px;
    box-shadow:0 12px 36px rgba(79,70,229,.12);
  }
  .actions-lbl{font-size:10px;font-weight:800;letter-spacing:1.1px;text-transform:uppercase;color:#c4b5fd;margin-bottom:12px}
  .action{
    display:flex;align-items:flex-start;gap:12px;font-size:13px;color:#e2e8f0;margin-bottom:10px;line-height:1.55;
    padding:10px 12px;border-radius:10px;background:rgba(255,255,255,.03);
    border:1px solid rgba(148,163,184,.1);
    transition:background .15s ease,border-color .15s ease,transform .15s ease;
    cursor:default;
  }
  .action:hover{background:rgba(255,255,255,.06);border-color:rgba(34,211,238,.25);transform:translateX(2px)}
  .action:last-child{margin-bottom:0}
  .action-n{
    flex-shrink:0;width:22px;height:22px;border-radius:50%;
    background:linear-gradient(135deg,#22d3ee,#818cf8);color:#0f172a;
    font-size:11px;font-weight:900;display:flex;align-items:center;justify-content:center;margin-top:1px;
    box-shadow:0 0 16px rgba(34,211,238,.35);
  }
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;padding:18px 24px 32px}
  @media(max-width:860px){.grid{grid-template-columns:1fr}}
  .card{
    border-radius:16px;overflow:hidden;
    background:var(--card-bg);
    border:1px solid var(--card-border);
    backdrop-filter:blur(14px);
    box-shadow:0 4px 24px rgba(0,0,0,.2),0 0 0 1px rgba(255,255,255,.04) inset;
    transition:transform .2s ease,box-shadow .2s ease,border-color .2s ease;
  }
  .card:hover{
    transform:translateY(-3px);
    border-color:rgba(34,211,238,.28);
    box-shadow:0 16px 48px rgba(0,0,0,.35),0 0 40px rgba(34,211,238,.08);
  }
  .card-hdr{
    display:flex;align-items:center;gap:10px;padding:14px 16px 12px;
    border-bottom:1px solid rgba(148,163,184,.12);
    background:linear-gradient(180deg,rgba(255,255,255,.06),transparent);
    cursor:default;
  }
  .icon{font-size:18px;line-height:1;filter:drop-shadow(0 0 8px rgba(34,211,238,.25))}
  .card-title{font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.75px;flex:1;color:#cbd5e1}
  .badge{font-size:9px;font-weight:800;color:#fff;padding:3px 9px;border-radius:999px;letter-spacing:.35px;text-transform:uppercase;box-shadow:0 2px 10px rgba(0,0,0,.2)}
  .count-badge{font-size:11px;font-weight:700;color:#cbd5e1;background:rgba(15,23,42,.5);padding:3px 10px;border-radius:999px;border:1px solid rgba(148,163,184,.15)}
  .card-body{padding:12px 16px 14px}
  .item{
    padding:10px 12px;margin:0 -4px 6px;border-radius:10px;
    border:1px solid transparent;
    border-bottom:1px solid rgba(148,163,184,.08);
    transition:background .15s ease,border-color .15s ease,transform .12s ease;
    cursor:default;
  }
  .item:last-child{border-bottom-color:transparent;margin-bottom:0}
  .item:hover{
    background:rgba(34,211,238,.06);
    border-color:rgba(34,211,238,.15);
    transform:scale(1.01);
  }
  .item-top{display:flex;justify-content:space-between;align-items:flex-start;gap:10px}
  .hl{font-size:13px;font-weight:600;color:#f8fafc;line-height:1.45}
  .meta{font-size:10px;color:var(--muted);white-space:nowrap;flex-shrink:0;margin-top:2px}
  .detail{font-size:12px;color:#cbd5e1;margin-top:4px;line-height:1.5}
  .tag{
    font-size:10px;background:rgba(129,140,248,.2);color:#e9d5ff;
    padding:2px 8px;border-radius:6px;margin-right:4px;border:1px solid rgba(167,139,250,.25);
  }
  .empty{font-size:12px;color:var(--muted);font-style:italic;padding:8px 4px}
  .msg-text{font-size:12px;color:#e2e8f0;line-height:1.55;word-break:break-word}
  .msg-stats{font-size:10px;color:var(--muted);margin-top:4px}
  .stat-row{display:flex;gap:20px;padding:12px 0;border-bottom:1px solid rgba(148,163,184,.1)}
  .stat-row:last-child{border-bottom:none}
  .stat-val{font-size:24px;font-weight:800;line-height:1;background:linear-gradient(90deg,#f8fafc,#a5f3fc);-webkit-background-clip:text;background-clip:text;color:transparent}
  .stat-lbl{font-size:11px;color:var(--muted);margin-top:4px}
  .stat-crit .stat-val{background:none;-webkit-text-fill-color:unset;color:#fca5a5}
  .stat-warn .stat-val{background:none;-webkit-text-fill-color:unset;color:#fcd34d}
  .stat-ok .stat-val{background:none;-webkit-text-fill-color:unset;color:#6ee7b7}
  .footer{text-align:center;padding:14px;font-size:11px;color:var(--muted)}
  .fab{
    position:fixed;bottom:22px;right:22px;
    background:linear-gradient(135deg,#22d3ee,#6366f1);color:#0f172a;border:none;
    border-radius:50%;width:48px;height:48px;font-size:20px;font-weight:800;
    cursor:pointer;
    box-shadow:0 8px 28px rgba(99,102,241,.45),0 0 0 1px rgba(255,255,255,.2) inset;
    transition:transform .2s ease,box-shadow .2s ease,filter .2s ease;
    display:flex;align-items:center;justify-content:center;
  }
  .fab:hover{transform:scale(1.08) rotate(-8deg);filter:brightness(1.08);box-shadow:0 12px 36px rgba(34,211,238,.5)}
  .fab:active{transform:scale(.96)}
  .fab:focus-visible{outline:2px solid #f472b6;outline-offset:4px}
  .note{font-size:11px;color:var(--muted);font-style:italic;padding:8px 0}
`;

// ── Raw HTML (no Claude) ───────────────────────────────────────────────────────
function generateRawHTML(data, meta) {
  const { front, slack, sentry } = data;

  // Derive a simple status from data
  const urgentCount = front?.urgentCount || 0;
  const openCount   = front?.openTotal   || 0;
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
        <div><div class="stat-val">${openCount}</div><div class="stat-lbl">Open tickets</div></div>
        <div class="${urgClass}"><div class="stat-val">${urgentCount}</div><div class="stat-lbl">Urgent</div></div>
        <div><div class="stat-val">${front.recentCount || 0}</div><div class="stat-lbl">Active last ${meta.hours}h</div></div>
      </div>`;

    const urgentItems = (front.urgentSamples || []).map(c => `
      <div class="item">
        <div class="item-top">
          <span class="hl">${esc(c.subject || '(no subject)')}</span>
          <span class="meta">${relTime(c.updated)}</span>
        </div>
        <div style="margin-top:3px">${(c.tags || []).map(t => `<span class="tag">${esc(t)}</span>`).join('')}</div>
      </div>`).join('');

    const recentItems = !urgentItems ? (front.recentSamples || []).slice(0, 8).map(c => `
      <div class="item">
        <div class="item-top">
          <span class="hl">${esc(c.subject || '(no subject)')}</span>
          <span class="meta">${relTime(c.updated)}</span>
        </div>
        <div style="margin-top:3px">${(c.tags || []).map(t => `<span class="tag">${esc(t)}</span>`).join('')}</div>
      </div>`).join('') : '';

    const body = stats + (urgentItems || recentItems
      ? `<div style="margin-top:8px;font-size:11px;font-weight:700;color:#64748b;margin-bottom:4px">${urgentItems ? 'URGENT' : 'RECENT'}</div>${urgentItems || recentItems}`
      : `<div class="note" style="margin-top:8px">No urgent tickets — queue looks calm</div>`);

    const badgeColor = urgentCount > 0 ? '#d97706' : '#059669';
    const badgeLabel = urgentCount > 0 ? 'urgent' : 'ok';
    return card('🎫', 'Support Queue', badgeLabel, badgeColor, body);
  }

  // Slack channel cards
  function slackCards() {
    if (!slack || slack.skipped) {
      return card('💬', 'Slack', 'info', '#94a3b8',
        `<div class="empty">Slack not connected — add SLACK_BOT_TOKEN to .env or use /cx-briefing in Claude</div>`);
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

    return Object.entries(slack).map(([name, ch]) => {
      const m  = CHANNEL_META[name] || { icon: '#', title: name, color: '#64748b' };
      const msgs = ch.messages || [];
      if (ch.note && !msgs.length) {
        return card(m.icon, `#${name}`, 'info', '#94a3b8',
          `<div class="empty">${esc(ch.note)}</div>`);
      }
      const items = msgs.slice(0, 8).map(msg => `
        <div class="item">
          <div class="msg-text">${esc(msg.text)}</div>
          <div class="msg-stats">
            ${fmtTime(msg.time)}
            ${msg.reactions ? ` · ${msg.reactions} reactions` : ''}
            ${msg.replies   ? ` · ${msg.replies} replies`   : ''}
          </div>
        </div>`).join('');
      const count = msgs.length;
      const body  = items || `<div class="empty">No messages in the last ${meta.hours}h</div>`;
      const badgeColor = name === 'bolt-bugs' && count > 0 ? '#dc2626'
        : ch.priority === 'high' && count > 0 ? '#d97706' : '#94a3b8';
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
      items || `<div class="empty">No new errors in the last ${meta.hours}h</div>`);
  }

  function card(icon, title, badgeLabel, badgeColor, body) {
    return `
    <div class="card">
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
      <div class="title">⚡ CX Daily Briefing</div>
      <div class="subtitle">bolt.new</div>
    </div>
    <div class="status-pill" style="background:${sc.bg};color:${sc.color}">${sc.dot} ${sc.label}</div>
  </div>
  <div class="h2">
    <span class="ts">${esc(NOW_LABEL)} · last ${meta.hours}h</span>
    ${srcPills}
  </div>
  ${quickLinks}
</div>

<div class="grid">
  ${frontCard()}
  ${sentryCard()}
  ${slackCards()}
</div>

<div class="footer">Generated ${esc(NOW_LABEL)} · ${HOURS}h window · cx-briefing</div>
<button class="fab" onclick="location.reload()" title="Refresh">↻</button>
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
      <div class="title">⚡ CX Daily Briefing</div>
      <div class="subtitle">bolt.new</div>
    </div>
    <div class="status-pill" style="background:${sc.bg};color:${sc.color}">${sc.dot} ${sc.label}</div>
  </div>
  <div class="h2">
    <span class="ts">${esc(NOW_LABEL)} · last ${meta.hours}h</span>
    ${srcPills}
  </div>
  ${quickLinks}
</div>

<div class="ai-bar" style="--sc:${sc.color}">
  <div class="ai-summary">${esc(briefing.summary)}</div>
  <div class="ai-reason">${esc(briefing.statusReason)}</div>
</div>

${actionsHTML ? `<div class="actions"><div class="actions-lbl">Priority Actions</div>${actionsHTML}</div>` : ''}

${rawContent}

<div class="footer">Generated ${esc(NOW_LABEL)} · ${HOURS}h window · cx-briefing + Claude</div>
<button class="fab" onclick="location.reload()" title="Refresh">↻</button>
</body>
</html>`;
}

// ── Front summary mode (for Claude Desktop prompt injection) ───────────────────
async function frontSummaryMode() {
  const data = await fetchFrontData();
  if (data.skipped || data.error) {
    console.log('Front: not available');
    return;
  }
  const lines = [
    `Open tickets: ${data.openTotal}`,
    `Urgent/escalated: ${data.urgentCount}`,
    `Active in last ${HOURS}h: ${data.recentCount}`,
    `Inboxes: ${(data.inboxes || []).join(', ')}`,
  ];
  if (data.urgentSamples?.length) {
    lines.push('\nUrgent tickets:');
    data.urgentSamples.forEach(c =>
      lines.push(`  • ${c.subject || '(no subject)'} [${(c.tags || []).join(', ')}]`)
    );
  }
  if (data.recentSamples?.length) {
    lines.push('\nRecent activity:');
    data.recentSamples.slice(0, 8).forEach(c =>
      lines.push(`  • ${c.subject || '(no subject)'} [${(c.tags || []).join(', ')}]`)
    );
  }
  process.stdout.write(lines.join('\n') + '\n');
}

// ── Main ───────────────────────────────────────────────────────────────────────
async function main() {
  if (process.argv.includes('--mode=front-summary')) return frontSummaryMode();
  console.log(`\n⚡ CX Briefing — last ${HOURS}h\n`);

  // Fetch data sources in parallel
  const [slackData, frontData, sentryData] = await Promise.all([
    fetchSlackData(),
    fetchFrontData(),
    fetchSentryData(),
  ]);

  const rawData = { slack: slackData, front: frontData, sentry: sentryData };
  const meta    = {
    hours:  HOURS,
    slack:  !slackData?.skipped,
    front:  !frontData?.skipped,
    sentry: !sentryData?.skipped,
    queryLinks: [
      { label: 'Query Dashboard', url: ENV.queryDashboardUrl },
      { label: 'Ticket Analyzer', url: ENV.queryTicketAnalyzerUrl },
    ],
  };

  let outPath;

  // Mode 1: Anthropic API key available → fast API synthesis
  if (ENV.claude) {
    try {
      console.log('  Mode: Claude API');
      const briefing = await synthesizeViaAPI(rawData);
      const html = generateAIHTML(briefing, rawData, meta);
      outPath = path.join(os.tmpdir(), `cx-briefing-${Date.now()}.html`);
      fs.writeFileSync(outPath, html, 'utf8');
    } catch (e) {
      console.warn(`  ⚠ API synthesis failed (${e.message})`);
    }
  }

  // Mode 2: No API key but claude CLI available → reads Slack via MCP + generates full briefing
  if (!outPath) {
    try {
      console.log('  Mode: claude CLI (reads Slack via MCP)');
      outPath = await synthesizeViaCLI(frontData);
    } catch (e) {
      console.warn(`  ⚠ Claude CLI failed (${e.message}), falling back to raw view`);
    }
  }

  // Mode 3: Fallback → clean data dashboard, no AI
  if (!outPath) {
    console.log('  Mode: raw data dashboard');
    const html = generateRawHTML(rawData, meta);
    outPath = path.join(os.tmpdir(), `cx-briefing-${Date.now()}.html`);
    fs.writeFileSync(outPath, html, 'utf8');
  }

  console.log(`\n✅  Dashboard: ${outPath}`);
  try { execSync(`open "${outPath}"`); }
  catch { console.log(`   Open manually: open "${outPath}"`); }
}

main().catch(e => { console.error('\n❌ Fatal:', e.message); process.exit(1); });
