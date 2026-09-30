// Optional interoperability test against the actual draft core reader. All
// tracker/mail data is synthetic and isolated in a temporary directory.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { classifyMessage } from '../lib/classify.mjs';
import { proposalPublisher } from '../lib/proposals.mjs';
import hooks from '../index.mjs';

const coreRoot = process.argv[2];
if (!coreRoot) throw new Error('Usage: node test/core-bridge.mjs /path/to/core-with-3333');
const { readReplyProposals } = await import(pathToFileURL(path.join(path.resolve(coreRoot), 'lib', 'reply-proposals.mjs')).href);
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-core-bridge-')));
const previousEnv = Object.fromEntries(['CAREER_OPS_ROOT', 'CAREER_OPS_DATA_DIR', 'CAREER_OPS_TRACKER'].map(key => [key, process.env[key]]));
try {
  const trackerPath = path.join(root, 'applications.md');
  fs.writeFileSync(trackerPath, 'synthetic tracker; no personal data');
  const applications = [{ num: 7, date: '2026-09-01', company: 'Example Labs', role: 'Backend Engineer', report: '', status: 'Applied', notes: '' }];
  const states = [{ id: 'applied', label: 'Applied' }, { id: 'interview', label: 'Interview' }];
  const message = {
    id: 'abc123', threadId: 'thread1', internalDate: '1780000000000',
    snippet: 'We would like to invite you to an interview for Backend Engineer at Example Labs.',
    payload: { headers: [
      { name: 'From', value: 'hr@example.test' },
      { name: 'Subject', value: 'Your Example Labs application' },
      { name: 'Authentication-Results', value: 'mx.google.com; dmarc=pass header.from=example.test' },
    ] },
  };
  const candidate = classifyMessage(message, applications);
  assert.strictEqual(candidate.matched_application, 7);
  await proposalPublisher({ dataRoot: root, trackerPath, applications, states })(candidate, { accountId: 'a'.repeat(64) });
  const result = readReplyProposals(root, trackerPath, applications, states);
  assert.deepStrictEqual(result.warnings, []);
  assert.strictEqual(result.recommendations.length, 1);
  assert.strictEqual(result.recommendations[0].num, 7);
  assert.strictEqual(result.recommendations[0].newStatus, 'Interview');
  assert.strictEqual(fs.readFileSync(trackerPath, 'utf8'), 'synthetic tracker; no personal data');
  console.log('ok - plugin output accepted by the draft core reader; tracker unchanged');

  const dataRoot = path.join(root, 'separate-data');
  fs.mkdirSync(dataRoot);
  // A tracker override outside DATA_ROOT exercises both canonical resolvers.
  const overridden = path.join(root, 'overridden-tracker.md');
  const trackerBytes = '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n'
    + '|---|---|---|---|---|---|---|---|---|\n'
    + '| 7 | 2026-09-01 | Example Labs | Backend Engineer | 4/5 | Applied | ❌ | | |\n';
  fs.writeFileSync(overridden, trackerBytes);
  process.env.CAREER_OPS_ROOT = dataRoot;
  process.env.CAREER_OPS_TRACKER = overridden;
  const ctx = {
    dryRun: true,
    settings: { mode: 'replies', career_ops_root: path.resolve(coreRoot) },
    env: { GMAIL_CLIENT_ID: 'fixture-client', GMAIL_CLIENT_SECRET: 'fixture-secret', GMAIL_REFRESH_TOKEN: 'fixture-refresh' },
    log: () => {},
    fetch: async input => {
      const url = new URL(input);
      let data;
      if (url.hostname === 'oauth2.googleapis.com') data = { access_token: 'fixture-access' };
      else if (url.pathname.endsWith('/profile')) data = { emailAddress: 'fixture@example.test' };
      else if (url.pathname.endsWith('/messages')) data = { messages: [{ id: message.id, threadId: message.threadId }] };
      else data = message;
      return { ok: true, status: 200, json: async () => data };
    },
  };
  assert.deepStrictEqual(await hooks.ingest(ctx), []);
  assert.deepStrictEqual(fs.readdirSync(dataRoot), []);
  assert.deepStrictEqual(await hooks.ingest({ ...ctx, dryRun: false }), []);
  const actual = readReplyProposals(dataRoot, overridden, applications, states);
  assert.deepStrictEqual(actual.warnings, []);
  assert.strictEqual(actual.recommendations.length, 1);
  assert.strictEqual(actual.recommendations[0].newStatus, 'Interview');
  assert.strictEqual(fs.readFileSync(overridden, 'utf8'), trackerBytes);
  console.log('ok - reply-mode hook uses actual core parser, separate data root and tracker override; dry-run writes nothing');
} finally {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  fs.rmSync(root, { recursive: true, force: true });
}
