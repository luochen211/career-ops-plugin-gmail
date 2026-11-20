// @ts-check
// Employer-reply review: read recent Gmail messages, match each one to a tracker
// row, and drop a status proposal for career-ops' human-confirmed review
// (`node reply-watch.mjs`). The proposal format is core's v1 draft contract in
// docs/REPLY_PROPOSALS.md. This module never writes the tracker, and it never
// sends, labels, archives or deletes mail.
//
// Pure helpers are exported for tests; `scanReplies` is the only part that
// touches the network or the disk.

import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { getMessageBody, isAuthenticEmail } from './_helpers.mjs';

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const STATE_FILE = join('data', 'gmail-replies-state.json');
const DROP_DIR = join('data', 'reply-proposals');
const MAX_EVIDENCE = 2000;
const MAX_MESSAGES = 200;
const MAX_QUERY_COMPANIES = 30;

// The same controls core's reader refuses in any string field.
const CONTROLS = /[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;

// Canonical states from core's templates/states.yml: id → label.
export const STATES = Object.freeze({
  evaluated: 'Evaluated', speculative: 'Speculative', applied: 'Applied',
  responded: 'Responded', assessment: 'Assessment', interview: 'Interview',
  offer: 'Offer', hired: 'Hired', rejected: 'Rejected', discarded: 'Discarded', skip: 'SKIP',
});

// Rows still waiting on the employer, in process order. Only these can move.
const ACTIVE = ['applied', 'responded', 'assessment', 'interview'];
const RANK = { applied: 0, responded: 1, assessment: 2, interview: 3, offer: 4 };

// Header labels → field, a copy of core's tracker-aliases.json. The plugin
// cannot import core, so the table is copied; a label it does not know makes
// the tracker unreadable here (a clear error), never a shifted row.
const HEADER_ALIASES = {
  '#': 'num', num: 'num', date: 'date', fecha: 'date', datum: 'date', data: 'date',
  dato: 'date', tanggal: 'date', tarih: 'date', company: 'company', empresa: 'company',
  firma: 'company', virksomhed: 'company', virksomhet: 'company', perusahaan: 'company',
  entreprise: 'company', azienda: 'company', 'şirket': 'company', via: 'via', role: 'role',
  puesto: 'role', rolle: 'role', rola: 'role', vaga: 'role', ruolo: 'role', rol: 'role',
  location: 'location', ort: 'location', score: 'score', punteggio: 'score', puan: 'score',
  status: 'status', statut: 'status', stato: 'status', durum: 'status', pdf: 'pdf',
  materials: 'pdf', report: 'report', rapor: 'report', 'apply link': 'applylink',
  apply: 'applylink', 'follow-up': 'followup', 'follow up': 'followup', followup: 'followup',
  notes: 'notes', notlar: 'notes', url: 'url',
};
const REQUIRED_HEADER = ['num', 'company', 'role', 'score', 'status'];

// Signals, strongest first: a message that says both "unfortunately" and
// "interview" is a rejection after an interview, not an invitation.
const SIGNALS = [
  ['offer', [
    /录用通知/, /拟录用/, /录用意向/, /offer\s*letter/i, /pleased to (?:extend|offer)/i,
    /(?:extend|make) (?:you )?an offer/i,
  ]],
  ['rejected', [
    /很遗憾/, /不太合适/, /暂不合适/, /未能(?:通过|进入)/, /不予录用/,
    /unfortunately/i, /regret to inform/i, /not (?:to )?(?:be )?mov(?:e|ing) forward/i,
    /decided to (?:move forward|proceed|pursue) (?:with )?other candidates/i,
    /(?:position|role) has been filled/i,
  ]],
  ['interview', [
    /邀您面试/, /面试邀请/, /邀请您参加.{0,6}面试/, /简历通过/, /安排.{0,4}面试/,
    /invit(?:e|ing) you (?:to|for) (?:an? )?(?:\w+ )?interview/i, /interview invitation/i,
    /schedule (?:an? |your )?(?:\w+ )?(?:interview|call)/i,
  ]],
  ['assessment', [
    /笔试/, /测评/, /在线测试/, /online assessment/i, /coding (?:challenge|assessment)/i,
    /take[- ]home/i, /complete (?:the|an|this) assessment/i,
  ]],
];

// Lead generation and digests that borrow the same words. A message matching
// one of these never becomes a proposal.
const NOISE = [
  /邀请投递/, /抢面试先机/, /职位推荐/, /为你推荐/, /猜你喜欢/, /新职位/,
  /job alert/i, /jobs? (?:you may|you might) (?:like|be interested)/i, /recommended jobs?/i,
  /new jobs? (?:for you|matching)/i, /newsletter/i, /weekly digest/i,
];

// Gmail search terms for the same signals (Gmail matches CJK phrases without
// word boundaries).
const QUERY_TERMS = [
  '简历通过', '邀您面试', '面试邀请', '笔试', '测评', '很遗憾', '不合适', '录用',
  'offer', 'interview', 'assessment', '"next steps"', 'unfortunately',
];

const CORPORATE = new RegExp([
  '\\b(?:inc|llc|ltd|limited|corp|corporation|co|company|gmbh|ag|sa|sas|bv|plc|pte|pty|srl|spa|kk)\\b\\.?',
  '(?:股份)?有限(?:责任)?公司', '集团', '公司', '[(（](?:中国|上海|北京|深圳|杭州)[)）]',
].join('|'), 'giu');

/** sha256 hex of a string. */
const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

/** The v1 account id: sha256 of the trimmed, lowercased mailbox address. */
export function accountId(address) {
  return sha256(String(address).trim().toLowerCase());
}

/** Lowercased company name without corporate forms or punctuation, for matching. */
export function companyKey(name) {
  return String(name || '').toLowerCase().replace(CORPORATE, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** Text normalized the same way, so a key can be searched inside it. */
function textKey(text) {
  return ` ${String(text || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ')} `;
}

/** Whether a company key is distinctive enough to match on. */
function usableKey(key) {
  return /[\u3400-\u9fff]/u.test(key) ? key.length >= 2 : key.length >= 3;
}

/** Whether `key` appears in normalized text, on word boundaries for Latin names. */
function containsKey(haystack, key) {
  if (!usableKey(key)) return false;
  return /[\u3400-\u9fff]/u.test(key) ? haystack.includes(key) : haystack.includes(` ${key} `);
}

/**
 * Parse the tracker the way core's parseTrackerRow does: header by alias, full
 * row width required, trimmed cells. Returns rows with the raw status cell.
 * @param {string} markdown
 */
export function parseTracker(markdown) {
  const lines = String(markdown).split(/\r?\n/);
  let colmap = null;
  for (const line of lines) {
    if (!line.startsWith('|')) continue;
    const map = {};
    line.split('|').forEach((c, i) => {
      const field = HEADER_ALIASES[c.trim().toLowerCase()];
      if (field) map[field] = i;
    });
    if (REQUIRED_HEADER.every(k => map[k] != null)) { colmap = map; break; }
  }
  if (!colmap) throw new Error('gmail replies: tracker header not recognized (need #, Company, Role, Score, Status)');
  const rows = [];
  for (const line of lines) {
    if (!line.startsWith('|')) continue;
    const parts = line.split('|').map(s => s.trim());
    const width = Math.max(...Object.values(colmap)) + (line.trimEnd().endsWith('|') ? 2 : 1);
    if (parts.length < width) continue;
    const num = parseInt(parts[colmap.num], 10);
    if (Number.isNaN(num)) continue;
    const at = (k) => (colmap[k] != null ? (parts[colmap[k]] ?? '') : '');
    rows.push({
      num, date: at('date'), company: at('company'), role: at('role'),
      report: at('report'), status: at('status'), notes: at('notes'),
    });
  }
  return rows;
}

/** The canonical state id of a status cell, or null for anything else. */
export function statusId(cell) {
  const want = String(cell || '').trim().toLowerCase();
  const hit = Object.entries(STATES).find(([, label]) => label.toLowerCase() === want);
  return hit ? hit[0] : null;
}

/**
 * The strongest post-application signal in a message, with a verbatim excerpt.
 * @param {{ subject: string, body: string }} msg
 * @returns {{ to: string, evidence: string } | null}
 */
export function classifyReply({ subject, body }) {
  const text = `${subject}\n${body}`;
  if (NOISE.some(re => re.test(text))) return null;
  for (const [to, patterns] of SIGNALS) {
    for (const re of patterns) {
      const evidence = excerpt(subject, re) || excerpt(body, re);
      if (evidence) return { to, evidence };
    }
  }
  return null;
}

/** The control-free run of `text` around the first match of `re`, verbatim. */
function excerpt(text, re) {
  const m = re.exec(String(text || ''));
  if (!m) return '';
  const src = String(text);
  // Grow from the match to the nearest control character or sentence end.
  let start = m.index;
  while (start > 0 && !CONTROLS.test(src[start - 1]) && !/[。！？.!?]/u.test(src[start - 1])) start--;
  let end = m.index + m[0].length;
  while (end < src.length && !CONTROLS.test(src[end]) && !/[。！？.!?]/u.test(src[end - 1] || '')) end++;
  const run = src.slice(start, end).trim();
  if (!run || CONTROLS.test(run)) return '';
  return run.length > MAX_EVIDENCE ? run.slice(0, MAX_EVIDENCE).trim() : run;
}

/**
 * The single active tracker row a message is about, or a reason it has none.
 * A company must appear in the sender, subject or body; when one company has
 * several active rows, the role has to appear too.
 * @param {ReturnType<typeof parseTracker>} rows
 * @param {{ from: string, subject: string, body: string }} msg
 */
export function matchApplication(rows, { from, subject, body }) {
  const hay = textKey(`${from}\n${subject}\n${body}`);
  const active = rows.filter(r => ACTIVE.includes(statusId(r.status) || ''));
  const byCompany = active.filter(r => containsKey(hay, companyKey(r.company)));
  if (byCompany.length === 0) return { row: null, reason: 'no active application matches' };
  if (byCompany.length === 1) return { row: byCompany[0], reason: '' };
  const byRole = byCompany.filter(r => containsKey(hay, companyKey(r.role)));
  if (byRole.length === 1) return { row: byRole[0], reason: '' };
  return { row: null, reason: 'several active applications match' };
}

/** Whether a reply moves a row forward (a rejection can end any active row). */
export function isForward(from, to) {
  if (!ACTIVE.includes(from) || from === to) return false;
  if (to === 'rejected') return true;
  return RANK[to] != null && RANK[to] > RANK[from];
}

/**
 * The proposal object core's reader validates: exactly these fields.
 * @param {{ account: string, messageId: string, trackerPath: string, row: any, from: string, to: string, evidence: string }} p
 */
export function buildProposal({ account, messageId, trackerPath, row, from, to, evidence }) {
  return {
    schema_version: 1,
    source: { kind: 'gmail', account_id: account, message_id: messageId },
    tracker_path: trackerPath,
    application: { num: row.num, date: row.date, company: row.company, role: row.role, report: row.report },
    from_status: from,
    to_status: to,
    evidence,
  };
}

/** The Gmail search for recent replies: signal words, or an active company name. */
export function buildQuery(rows, daysBack) {
  const companies = rows
    .filter(r => ACTIVE.includes(statusId(r.status) || ''))
    .map(r => r.company.replace(/["\\]/g, ' ').trim())
    .filter(Boolean)
    .slice(-MAX_QUERY_COMPANIES)
    .map(c => `"${c}"`);
  const terms = [...QUERY_TERMS, ...companies].join(' ');
  return `newer_than:${daysBack}d -in:sent -in:drafts -in:chats {${terms}}`;
}

/** core's rawTrackerPath + canonicalizeTrackerPath, from the plugin's side. */
export function trackerPathFor(dataRoot, override = '') {
  let raw;
  if (override) {
    if (!isAbsolute(override)) {
      throw new Error('gmail replies: CAREER_OPS_TRACKER must be an absolute path for this plugin');
    }
    raw = override;
  } else {
    raw = existsSync(join(dataRoot, 'data/applications.md'))
      ? join(dataRoot, 'data/applications.md')
      : join(dataRoot, 'applications.md');
  }
  try { return realpathSync(resolve(raw)); } catch { return resolve(raw); }
}

function loadState(path) {
  try { return new Set(JSON.parse(readFileSync(path, 'utf-8')).processed_message_ids || []); } catch { return new Set(); }
}

function saveState(path, ids) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ processed_message_ids: [...ids] }, null, 2), 'utf-8');
}

/** Write one proposal: temporary file, then rename into the drop directory. */
function writeProposal(dir, proposal) {
  mkdirSync(dir, { recursive: true });
  const id = sha256(JSON.stringify([proposal.source.account_id, proposal.source.message_id])).slice(0, 24);
  const final = join(dir, `gmail-${id}.json`);
  const tmp = join(dir, `.gmail-${id}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(proposal, null, 2)}\n`, 'utf-8');
  renameSync(tmp, final);
  return final;
}

const header = (headers, name) => headers.find(h => h.name?.toLowerCase() === name)?.value || '';
const plain = (html) => String(html).replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>|<\/tr>/gi, '\n').replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/[ \t]+/g, ' ');

/**
 * Scan recent mail and drop proposals. Returns a summary; writes nothing in a
 * dry run.
 * @param {any} ctx plugin context
 * @param {Record<string, string>} auth Authorization header
 * @param {{ daysBack: number, trackerOverride?: string }} opts
 */
export async function scanReplies(ctx, auth, { daysBack, trackerOverride = '' }) {
  const dataRoot = ctx?.dataRoot || process.cwd();
  const trackerPath = trackerPathFor(dataRoot, trackerOverride);
  if (!existsSync(trackerPath)) {
    ctx.log(`gmail replies: no tracker at ${trackerPath}; nothing to match`);
    return { proposals: 0, scanned: 0 };
  }
  const rows = parseTracker(readFileSync(trackerPath, 'utf-8'));
  if (!rows.some(r => ACTIVE.includes(statusId(r.status) || ''))) {
    ctx.log('gmail replies: no application is waiting on an employer');
    return { proposals: 0, scanned: 0 };
  }

  const profile = await (await ctx.fetch(`${GMAIL_API}/profile`, { headers: auth })).json();
  if (!profile.emailAddress) throw new Error('gmail replies: Gmail profile returned no address');
  const account = accountId(profile.emailAddress);

  const query = buildQuery(rows, daysBack);
  const ids = [];
  let pageToken = null;
  do {
    let url = `${GMAIL_API}/messages?q=${encodeURIComponent(query)}`;
    if (pageToken) url += `&pageToken=${encodeURIComponent(pageToken)}`;
    const data = await (await ctx.fetch(url, { headers: auth })).json();
    for (const m of data.messages || []) ids.push(m.id);
    pageToken = data.nextPageToken;
  } while (pageToken && ids.length < MAX_MESSAGES);

  const statePath = join(dataRoot, STATE_FILE);
  const processed = loadState(statePath);
  const dropDir = join(dataRoot, DROP_DIR);
  let written = 0;
  let scanned = 0;

  for (const id of ids.slice(0, MAX_MESSAGES)) {
    if (processed.has(id) || !/^[A-Za-z0-9_-]{1,256}$/.test(id)) continue;
    let msg;
    try {
      msg = await (await ctx.fetch(`${GMAIL_API}/messages/${id}?format=full`, { headers: auth })).json();
    } catch (err) {
      console.warn(`gmail replies: failed to fetch message ${id}: ${err.message}`);
      continue;
    }
    scanned++;
    const headers = msg.payload?.headers || [];
    const subject = header(headers, 'subject');
    const from = header(headers, 'from');
    if (!isAuthenticEmail(headers)) {
      processed.add(id); // fail closed: an unauthenticated reply is never proposed
      continue;
    }
    const body = plain(getMessageBody(msg.payload) || msg.snippet || '');
    const signal = classifyReply({ subject, body });
    if (!signal) { processed.add(id); continue; }
    const { row, reason } = matchApplication(rows, { from, subject, body });
    if (!row) {
      // Not marked processed: a row added later can still match it while the
      // message is inside the search window.
      ctx.log(`gmail replies: ${signal.to} reply not proposed: ${reason}`);
      continue;
    }
    const fromId = /** @type {string} */ (statusId(row.status));
    processed.add(id);
    if (!isForward(fromId, signal.to)) continue;
    const proposal = buildProposal({
      account, messageId: id, trackerPath, row, from: fromId, to: signal.to, evidence: signal.evidence,
    });
    if (ctx?.dryRun) {
      ctx.log(`gmail replies: would propose #${row.num} ${STATES[fromId]} → ${STATES[signal.to]}`);
    } else {
      writeProposal(dropDir, proposal);
      ctx.log(`gmail replies: proposed #${row.num} ${STATES[fromId]} → ${STATES[signal.to]}`);
    }
    written++;
  }

  if (!ctx?.dryRun) saveState(statePath, processed);
  if (written) ctx.log('gmail replies: review with `node reply-watch.mjs`; nothing changes until you accept');
  return { proposals: written, scanned };
}
