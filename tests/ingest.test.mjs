import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import hooks from '../index.mjs';

const original = process.cwd();
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-leads-')));
const calls = [];
const ctx = {
  env: { GMAIL_CLIENT_ID: 'fixture-client', GMAIL_CLIENT_SECRET: 'fixture-secret', GMAIL_REFRESH_TOKEN: 'fixture-refresh' },
  settings: {}, dryRun: true, log: () => {},
  fetch: async url => {
    calls.push(new URL(url));
    const response = data => ({ ok: true, json: async () => data });
    if (url.includes('oauth2')) return response({ access_token: 'fixture-access' });
    if (url.includes('/messages?')) return response({ messages: [{ id: 'lead1' }] });
    return response({ payload: {
      headers: [{ name: 'Subject', value: 'Engineer at Example Labs' }, { name: 'Authentication-Results', value: 'mx.google.com; dmarc=pass header.from=example.test' }],
      body: { data: Buffer.from('https://jobs.lever.co/example/123 https://cdn.example.test/logo.png').toString('base64url') },
    } });
  },
};
try {
  process.chdir(root);
  const jobs = await hooks.ingest(ctx);
  assert.deepStrictEqual(jobs, [{ title: 'Engineer', url: 'https://jobs.lever.co/example/123', company: 'example', location: '' }]);
  assert.strictEqual(calls[1].searchParams.get('q'), 'label:"Job Leads" newer_than:7d');
  assert.strictEqual(fs.existsSync(path.join(root, 'data')), false);
  await hooks.ingest({ ...ctx, dryRun: false });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(root, 'data', 'gmail-state.json'), 'utf8')).processed_message_ids, ['lead1']);
  assert.deepStrictEqual(await hooks.ingest({ ...ctx, dryRun: false }), []);
  console.log('ok - default job-lead ingest preserves Job[], label, cursor and dry-run behavior');
  await assert.rejects(hooks.ingest({ ...ctx, settings: { mode: 'other' } }), /mode must be/);
  const before = calls.length;
  await assert.rejects(hooks.ingest({ ...ctx, settings: { mode: 'replies', career_ops_root: root } }), /requires the #3333/);
  assert.strictEqual(calls.length, before);
  console.log('ok - invalid mode and missing core bridge fail before network calls');
} finally { process.chdir(original); fs.rmSync(root, { recursive: true, force: true }); }
