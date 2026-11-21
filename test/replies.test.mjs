// Offline tests for employer-reply review. No network: ctx.fetch is a stub.
// Plain node:assert with a small runner: the plugin audit allows no node:test.
import assertModule from 'node:assert';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import plugin from '../index.mjs';
import {
  accountId, buildQuery, classifyReply, isForward, matchApplication, parseTracker, statusId,
} from '../_replies.mjs';

const assert = assertModule.strict;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const TRACKER = `# Applications Tracker

| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
|---|------|---------|------|-------|--------|-----|--------|-------|
| 1 | 2026-06-20 | 杭州赢云贸易有限公司 | PY01_python开发工程师 | 4.1/5 | Applied | ❌ | — | |
| 2 | 2026-06-21 | Acme Inc. | Backend Engineer | 4.0/5 | Applied | ✅ | [2](../reports/002-acme-2026-06-21.md) | |
| 3 | 2026-06-22 | Acme Inc. | Data Engineer | 3.9/5 | Interview | ✅ | — | |
| 4 | 2026-06-23 | Meta | ML Engineer | 4.2/5 | Applied | ✅ | — | |
| 5 | 2026-06-24 | Closed Co | Designer | 3.0/5 | Rejected | ❌ | — | |
`;

test('a Chinese interview invitation is an interview signal', () => {
  const r = classifyReply({ subject: '恭喜简历通过，杭州赢云贸易有限公司邀您面试', body: '' });
  assert.equal(r?.to, 'interview');
  assert.match(r.evidence, /邀您面试/);
});

test('job-lead marketing is never a reply', () => {
  assert.equal(classifyReply({ subject: '邀请投递：面试邀请 Python 开发', body: '抢面试先机' }), null);
  assert.equal(classifyReply({ subject: 'Your job alert', body: 'interview invitation tips' }), null);
});

test('a rejection after an interview is a rejection', () => {
  const r = classifyReply({ subject: 'Your interview', body: 'Unfortunately we will not be moving forward.' });
  assert.equal(r?.to, 'rejected');
});

test('evidence is a verbatim, control-free excerpt', () => {
  const body = 'Hello\nWe would like to invite you to an interview next week.\nThanks';
  const r = classifyReply({ subject: 'Update', body });
  assert.equal(r?.to, 'interview');
  assert.ok(body.includes(r.evidence));
  assert.doesNotMatch(r.evidence, /[\x00-\x1f]/);
});

test('the tracker parser reads the header by alias', () => {
  const rows = parseTracker(TRACKER.replace('| # | Date | Company | Role |', '| # | Fecha | Empresa | Puesto |'));
  assert.equal(rows.length, 5);
  assert.deepEqual(
    { num: rows[1].num, company: rows[1].company, report: rows[1].report, status: rows[1].status },
    { num: 2, company: 'Acme Inc.', report: '[2](../reports/002-acme-2026-06-21.md)', status: 'Applied' },
  );
});

test('matching needs one active row; the role breaks a company tie', () => {
  const rows = parseTracker(TRACKER);
  assert.equal(matchApplication(rows, { from: 'Notice@fundeliver.com', subject: '杭州赢云贸易邀您面试', body: '' }).row?.num, 1);
  assert.equal(matchApplication(rows, { from: 'jobs@acme.com', subject: 'Acme update', body: '' }).row, null);
  assert.equal(matchApplication(rows, { from: 'jobs@acme.com', subject: 'Acme: Backend Engineer', body: '' }).row?.num, 2);
  assert.equal(matchApplication(rows, { from: 'jobs@acme.com', subject: 'Acme: Backend Engineer, Data Engineer', body: '' }).row, null);
  assert.equal(matchApplication(rows, { from: 'x@y.com', subject: 'metadata review', body: '' }).row, null);
  assert.equal(matchApplication(rows, { from: 'x@closedco.com', subject: 'Closed Co interview', body: '' }).row, null);
});

test('only forward moves are proposed', () => {
  assert.ok(isForward('applied', 'interview'));
  assert.ok(isForward('interview', 'rejected'));
  assert.ok(!isForward('interview', 'assessment'));
  assert.ok(!isForward('rejected', 'interview'));
  assert.equal(statusId('applied'), 'applied');
  assert.equal(statusId('Aplicado'), null);
});

test('the search covers signal words and active companies only', () => {
  const q = buildQuery(parseTracker(TRACKER), 30);
  assert.match(q, /^newer_than:30d /);
  assert.match(q, /"Meta"/);
  assert.doesNotMatch(q, /Closed Co/);
});

// ── end to end, with a stubbed Gmail ─────────────────────────────────────────

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64url');
const AUTH_PASS = { name: 'Authentication-Results', value: 'mx.google.com; dmarc=pass (p=NONE) header.from=fundeliver.com' };

function message(id, { subject, from, body, auth = true }) {
  return {
    id,
    payload: {
      mimeType: 'text/plain',
      headers: [{ name: 'Subject', value: subject }, { name: 'From', value: from }, ...(auth ? [AUTH_PASS] : [])],
      body: { data: b64(body) },
    },
  };
}

function setup(messages) {
  const root = mkdtempSync(path.join(tmpdir(), 'gmail-replies-'));
  mkdirSync(path.join(root, 'data'));
  writeFileSync(path.join(root, 'data', 'applications.md'), TRACKER);
  const calls = [];
  const json = (v) => ({ ok: true, json: async () => v, text: async () => JSON.stringify(v) });
  const fetch = async (url) => {
    calls.push(url);
    if (url.startsWith('https://oauth2.googleapis.com/token')) return json({ access_token: 't' });
    if (url.endsWith('/profile')) return json({ emailAddress: ' Me@Example.com ' });
    if (url.includes('/messages?q=')) return json({ messages: messages.map(m => ({ id: m.id })) });
    const id = url.split('/messages/')[1].split('?')[0];
    return json(messages.find(m => m.id === id));
  };
  const ctx = (extra = {}) => ({
    env: { GMAIL_CLIENT_ID: 'a', GMAIL_CLIENT_SECRET: 'b', GMAIL_REFRESH_TOKEN: 'c' },
    settings: { leads: false, replies: true },
    fetch, log: () => {}, dataRoot: root, dryRun: false, ...extra,
  });
  const drops = () => {
    try { return readdirSync(path.join(root, 'data', 'reply-proposals')).filter(f => f.endsWith('.json')); } catch { return []; }
  };
  return { root, ctx, drops, calls };
}

const INVITE = message('18f0aaa', {
  subject: '恭喜简历通过，杭州赢云贸易有限公司邀您面试',
  from: 'Notice@fundeliver.com',
  body: '您好，您投递的 PY01_python开发工程师 简历通过筛选，邀您参加 AI微信小程序面试。',
});

test('an authenticated invitation becomes one v1 proposal, once', async () => {
  const { root, ctx, drops } = setup([INVITE]);
  const jobs = await plugin.ingest(ctx());
  assert.deepEqual(jobs, []);
  const files = drops();
  assert.equal(files.length, 1);
  const p = JSON.parse(readFileSync(path.join(root, 'data', 'reply-proposals', files[0]), 'utf8'));
  assert.deepEqual(Object.keys(p).sort(),
    ['application', 'evidence', 'from_status', 'schema_version', 'source', 'to_status', 'tracker_path']);
  assert.deepEqual(p.source, { kind: 'gmail', account_id: accountId('me@example.com'), message_id: '18f0aaa' });
  assert.deepEqual(p.application, { num: 1, date: '2026-06-20', company: '杭州赢云贸易有限公司', role: 'PY01_python开发工程师', report: '—' });
  assert.equal(p.from_status, 'applied');
  assert.equal(p.to_status, 'interview');
  assert.ok(path.isAbsolute(p.tracker_path));

  await plugin.ingest(ctx());
  assert.equal(drops().length, 1, 'a processed message is not proposed again');
});

test('unauthenticated mail and dry runs write nothing', async () => {
  const spoof = message('18f0bbb', { ...{ subject: INVITE.payload.headers[0].value, from: 'x@evil.test', body: '邀您面试' }, auth: false });
  const a = setup([spoof]);
  await plugin.ingest(a.ctx());
  assert.equal(a.drops().length, 0);

  const b = setup([INVITE]);
  await plugin.ingest(b.ctx({ dryRun: true }));
  assert.equal(b.drops().length, 0);
});

test('a reply that would move a row back is not proposed', async () => {
  const late = message('18f0ccc', {
    subject: 'Acme: Data Engineer online assessment',
    from: 'jobs@acme.com',
    body: 'Please complete the assessment.',
  });
  const { ctx, drops } = setup([late]);
  await plugin.ingest(ctx());
  assert.equal(drops().length, 0);
});

test('replies stay off unless enabled', async () => {
  const { ctx, calls } = setup([INVITE]);
  await plugin.ingest(ctx({ settings: { leads: false } }));
  assert.ok(!calls.some(u => u.endsWith('/profile')));
});

test('a failed reply scan keeps the leads fetched in the same run', async () => {
  const lead = message('18f0ddd', {
    subject: 'Data Engineer at Acme',
    from: 'jobs@acme.com',
    body: 'Apply here: https://boards.greenhouse.io/acme/jobs/123',
  });
  const { ctx } = setup([lead]);
  const base = ctx();
  const fetch = async (url, init) => {
    if (url.endsWith('/profile')) throw new Error('profile 503');
    return base.fetch(url, init);
  };
  const warn = console.warn;
  console.warn = () => {};
  try {
    const jobs = await plugin.ingest(ctx({ settings: { replies: true }, fetch }));
    assert.deepEqual(jobs.map(j => j.url), ['https://boards.greenhouse.io/acme/jobs/123']);
  } finally { console.warn = warn; }
  await assert.rejects(plugin.ingest(ctx({ fetch })), /profile 503/, 'replies-only still fails loudly');
});

test('already processed mail does not use up the scan cap', async () => {
  const old = Array.from({ length: 250 }, (_, i) => ({ id: `old${i}` }));
  const { root, ctx, drops } = setup([...old, INVITE]);
  writeFileSync(path.join(root, 'data', 'gmail-replies-state.json'),
    JSON.stringify({ processed_message_ids: old.map(m => m.id) }));
  await plugin.ingest(ctx());
  assert.equal(drops().length, 1);
});

test('a stale proposal is re-pointed at the current status until accepted', async () => {
  const { root, ctx, drops } = setup([INVITE]);
  const tracker = path.join(root, 'data', 'applications.md');
  const drop = () => JSON.parse(readFileSync(path.join(root, 'data', 'reply-proposals', drops()[0]), 'utf8'));
  const setRow1 = (status, notes = '') => writeFileSync(tracker, TRACKER.replace(
    '| PY01_python开发工程师 | 4.1/5 | Applied | ❌ | — | |', `| PY01_python开发工程师 | 4.1/5 | ${status} | ❌ | — | ${notes} |`));
  await plugin.ingest(ctx());
  assert.equal(drop().from_status, 'applied');

  setRow1('Responded');
  await plugin.ingest(ctx({ dryRun: true }));
  assert.equal(drop().from_status, 'applied', 'a dry run rewrites nothing');
  await plugin.ingest(ctx());
  assert.equal(drops().length, 1);
  assert.equal(drop().from_status, 'responded');
  assert.equal(drop().to_status, 'interview');

  setRow1('Rejected');
  await plugin.ingest(ctx());
  assert.equal(drop().from_status, 'responded', 'no longer a forward move: left as it was');

  const digest = createHash('sha256').update(JSON.stringify(['gmail', accountId('me@example.com'), '18f0aaa'])).digest('hex');
  setRow1('Assessment', `[reply-proposal:${digest}]`);
  await plugin.ingest(ctx());
  assert.equal(drop().from_status, 'responded', 'an accepted source is never re-proposed');
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    failed++;
    console.error(`✗ ${name}`);
    console.error(err);
  }
}
console.log(`${tests.length - failed}/${tests.length} reply tests passed`);
if (failed) process.exit(1);
