import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanReplies, accountIdentity } from '../lib/scan.mjs';
import { atomicJson, privateDirectory, readJson } from '../lib/files.mjs';
import { boundedContext } from '../lib/budget.mjs';

const ACCOUNT = 'fixture.user@example.test';
const ACCOUNT_ID = accountIdentity(ACCOUNT);
const applications = [{ num: 7, company: 'Fixture Company', role: 'Software Engineer',
  recruiter_emails: ['hiring@fixture.example.test'] }];
const response = data => ({ ok: true, status: 200, json: async () => data });

function metadata(id) {
  return {
    id, threadId: `thread_${id}`, internalDate: '1780000000000',
    snippet: 'We invite you to an interview for the Software Engineer role at Fixture Company.',
    payload: { headers: [
      { name: 'From', value: 'Fixture Recruiting <hiring@fixture.example.test>' },
      { name: 'Subject', value: 'Fixture Company: Software Engineer interview' },
      { name: 'Date', value: 'Thu, 28 May 2026 20:26:40 +0000' },
      { name: 'Authentication-Results', value: 'mx.google.com; dmarc=pass header.from=fixture.example.test' },
    ] },
  };
}

function mailbox({ account = ACCOUNT, ids = ['message1'], detailFailures = [], detailHook, dryRun = false } = {}) {
  const calls = [];
  const ctx = {
    env: { GMAIL_CLIENT_ID: 'fixture-client', GMAIL_CLIENT_SECRET: 'fixture-secret', GMAIL_REFRESH_TOKEN: 'fixture-refresh' },
    settings: {}, dryRun,
    fetch: async (input, options) => {
      const url = new URL(input);
      calls.push({ url, options });
      if (url.toString() === 'https://oauth2.googleapis.com/token') {
        assert.strictEqual(options.method, 'POST');
        return response({ access_token: 'fixture-access', scope: 'https://www.googleapis.com/auth/gmail.readonly' });
      }
      assert.strictEqual(url.origin, 'https://gmail.googleapis.com');
      assert.strictEqual(options.method, 'GET');
      if (url.pathname === '/gmail/v1/users/me/profile') {
        assert.strictEqual(url.searchParams.get('fields'), 'emailAddress');
        return response({ emailAddress: account });
      }
      if (url.pathname === '/gmail/v1/users/me/messages') {
        assert.ok(url.searchParams.get('q').includes('newer_than:30d'));
        return response({ messages: ids.map(id => ({ id, threadId: `thread_${id}` })) });
      }
      const match = /^\/gmail\/v1\/users\/me\/messages\/([A-Za-z0-9_-]+)$/u.exec(url.pathname);
      assert.ok(match, 'unexpected transport endpoint');
      assert.strictEqual(url.searchParams.get('format'), 'metadata');
      const id = match[1];
      if (detailFailures.includes(id)) throw new Error('fixture detail failure');
      return detailHook ? detailHook(id) : response(metadata(id));
    },
  };
  return { ctx, calls, detailCalls: () => calls.filter(call => /\/messages\//u.test(call.url.pathname)) };
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function cursor(directory, accountId = ACCOUNT_ID) {
  return path.join(directory, `${accountId}.json`);
}

let count = 0;
async function test(name, run) {
  const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-scan-test-')));
  try {
    await run(temporary);
    count += 1;
    console.log(`ok ${count} - ${name}`);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

await test('mock pipeline classifies metadata and checkpoints each unique message privately', async root => {
  const stateDirectory = path.join(root, 'state');
  const mocked = mailbox({ ids: ['message1', 'message1'] });
  const published = [];
  const displayed = [];
  const result = await scanReplies(mocked.ctx, { applications, stateDirectory,
    publish: async (candidate, context) => published.push({ candidate, context }),
    display: candidate => displayed.push(candidate) });
  assert.strictEqual(result.candidates.length, 1);
  assert.strictEqual(result.candidates[0].matched_application, 7);
  assert.strictEqual(result.candidates[0].signal, 'interview_invite');
  assert.strictEqual(result.candidates[0].confidence, 'high');
  assert.strictEqual(result.processedCount, 1);
  assert.deepStrictEqual(result.failed, []);
  assert.strictEqual(result.accountId, ACCOUNT_ID);
  assert.strictEqual(published.length, 1);
  assert.deepStrictEqual(published[0].context, { accountId: ACCOUNT_ID, dryRun: false });
  assert.strictEqual(displayed.length, 1);
  assert.strictEqual(mocked.detailCalls().length, 1);
  assert.deepStrictEqual(readJson(cursor(stateDirectory)), {
    schema_version: 1, account_id: ACCOUNT_ID, processed_message_ids: ['message1'],
  });
  assert.strictEqual(fs.statSync(stateDirectory).mode & 0o777, 0o700);
  assert.strictEqual(fs.statSync(cursor(stateDirectory)).mode & 0o777, 0o600);
  assert.deepStrictEqual(fs.readdirSync(stateDirectory), [`${ACCOUNT_ID}.json`]);
});

await test('repeated scans suppress publication and metadata fetch of processed messages', async root => {
  const stateDirectory = path.join(root, 'state');
  let publications = 0;
  const options = { applications, stateDirectory, publish: async () => { publications += 1; } };
  await scanReplies(mailbox().ctx, options);
  const second = mailbox();
  const result = await scanReplies(second.ctx, options);
  assert.strictEqual(publications, 1);
  assert.deepStrictEqual(result.candidates, []);
  assert.strictEqual(result.processedCount, 1);
  assert.strictEqual(second.detailCalls().length, 0);
});

await test('identical Gmail message IDs are independently processed across accounts', async root => {
  const stateDirectory = path.join(root, 'state');
  const account2 = 'another.fixture@example.test';
  const published = [];
  const options = { applications, stateDirectory, publish: async (_, context) => published.push(context.accountId) };
  await scanReplies(mailbox().ctx, options);
  await scanReplies(mailbox({ account: account2 }).ctx, options);
  assert.deepStrictEqual(published, [ACCOUNT_ID, accountIdentity(account2)]);
  assert.strictEqual(accountIdentity('  FIXTURE.USER@EXAMPLE.TEST  '), ACCOUNT_ID);
  assert.strictEqual(fs.readdirSync(stateDirectory).length, 2);
  for (const filename of fs.readdirSync(stateDirectory)) {
    const contents = fs.readFileSync(path.join(stateDirectory, filename), 'utf8');
    assert.ok(!contents.includes('@example.test'));
    assert.deepStrictEqual(JSON.parse(contents).processed_message_ids, ['message1']);
  }
});

await test('failed detail requests remain eligible for a later successful scan', async root => {
  const stateDirectory = path.join(root, 'state');
  const published = [];
  const options = { applications, stateDirectory, publish: async candidate => published.push(candidate.message_id) };
  const first = await scanReplies(mailbox({ detailFailures: ['message1'] }).ctx, options);
  assert.deepStrictEqual(first.failed, ['message1']);
  assert.strictEqual(first.processedCount, 0);
  if (fs.existsSync(cursor(stateDirectory))) assert.deepStrictEqual(readJson(cursor(stateDirectory)).processed_message_ids, []);
  const second = await scanReplies(mailbox().ctx, options);
  assert.deepStrictEqual(published, ['message1']);
  assert.strictEqual(second.processedCount, 1);
});

await test('publication failure does not consume a message and releases the scan lock', async root => {
  const stateDirectory = path.join(root, 'state');
  await assert.rejects(scanReplies(mailbox().ctx, { applications, stateDirectory,
    publish: async () => { throw new Error('fixture publication failed'); } }), /fixture publication failed/u);
  assert.ok(!fs.existsSync(cursor(stateDirectory)));
  assert.ok(!fs.existsSync(`${cursor(stateDirectory)}.lock`));
  const result = await scanReplies(mailbox().ctx, { applications, stateDirectory, publish: async () => {} });
  assert.strictEqual(result.candidates.length, 1);
});

await test('an earlier successful publication survives a later publication failure', async root => {
  const stateDirectory = path.join(root, 'state');
  await assert.rejects(scanReplies(mailbox({ ids: ['message1', 'message2'] }).ctx, { applications, stateDirectory,
    publish: async candidate => { if (candidate.message_id === 'message2') throw new Error('second publication failed'); } }), /second publication failed/u);
  assert.deepStrictEqual(readJson(cursor(stateDirectory)).processed_message_ids, ['message1']);
  const published = [];
  const result = await scanReplies(mailbox({ ids: ['message1', 'message2'] }).ctx, { applications, stateDirectory,
    publish: async candidate => published.push(candidate.message_id) });
  assert.deepStrictEqual(published, ['message2']);
  assert.strictEqual(result.processedCount, 2);
});

await test('dry run returns proposals without creating directories, cursor files or locks', async root => {
  const stateDirectory = path.join(root, 'not-created', 'state');
  const contexts = [];
  const result = await scanReplies(mailbox({ dryRun: true }).ctx, { applications, stateDirectory,
    publish: async (_, context) => contexts.push(context) });
  assert.strictEqual(result.candidates.length, 1);
  assert.deepStrictEqual(contexts, [{ accountId: ACCOUNT_ID, dryRun: true }]);
  assert.deepStrictEqual(fs.readdirSync(root), []);
});

await test('corrupt cursors fail closed without replacing history', async root => {
  const stateDirectory = path.join(root, 'state');
  privateDirectory(stateDirectory);
  const valid = { schema_version: 1, account_id: ACCOUNT_ID, processed_message_ids: ['message1'] };
  const corrupt = ['{broken', 'null', 'false', '0', '[]', '{}',
    JSON.stringify({ ...valid, account_id: accountIdentity('other@example.test') }),
    JSON.stringify({ ...valid, processed_message_ids: ['bad/id'] })];
  for (const contents of corrupt) {
    fs.writeFileSync(cursor(stateDirectory), contents, { mode: 0o600 });
    const mocked = mailbox();
    let published = false;
    await assert.rejects(scanReplies(mocked.ctx, { applications, stateDirectory, publish: async () => { published = true; } }));
    assert.strictEqual(fs.readFileSync(cursor(stateDirectory), 'utf8'), contents);
    assert.strictEqual(published, false);
    assert.strictEqual(mocked.detailCalls().length, 0);
    assert.ok(!fs.existsSync(`${cursor(stateDirectory)}.lock`));
  }
});

await test('overlapping scans fail on the account lock without clobbering the active scan', async root => {
  const stateDirectory = path.join(root, 'state');
  const entered = deferred();
  const finish = deferred();
  const first = scanReplies(mailbox().ctx, { applications, stateDirectory,
    publish: async () => { entered.resolve(); await finish.promise; } });
  await entered.promise;
  try {
    assert.ok(fs.existsSync(`${cursor(stateDirectory)}.lock`));
    await assert.rejects(scanReplies(mailbox().ctx, { applications, stateDirectory,
      publish: async () => { assert.fail('second scan must not publish'); } }), /already locked/u);
    assert.ok(fs.existsSync(`${cursor(stateDirectory)}.lock`));
  } finally {
    finish.resolve();
    await first;
  }
  assert.deepStrictEqual(readJson(cursor(stateDirectory)).processed_message_ids, ['message1']);
  assert.ok(!fs.existsSync(`${cursor(stateDirectory)}.lock`));
});

await test('deadline prevents publication or cursor writes after an in-flight request resolves late', async root => {
  const stateDirectory = path.join(root, 'state');
  const late = deferred();
  const mocked = mailbox({ detailHook: () => late.promise });
  const ctx = boundedContext(mocked.ctx, 40);
  let publications = 0;
  await assert.rejects(scanReplies(ctx, { applications, stateDirectory,
    publish: async () => { publications += 1; } }), /deadline/u);
  late.resolve(response(metadata('message1')));
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.strictEqual(publications, 0);
  assert.ok(!fs.existsSync(cursor(stateDirectory)));
  assert.deepStrictEqual(fs.existsSync(stateDirectory) ? fs.readdirSync(stateDirectory) : [], []);
  for (const { options } of mocked.calls) {
    assert.ok(options.timeoutMs > 0 && options.timeoutMs <= 40);
  }
});

await test('deadline retains the prior checkpoint and leaves unfinished messages retryable', async root => {
  const stateDirectory = path.join(root, 'state');
  let expired = false;
  const mocked = mailbox({ ids: ['message1', 'message2'],
    detailHook: id => { if (id === 'message2') expired = true; return response(metadata(id)); } });
  const published = [];
  const ctx = { ...mocked.ctx, assertActive: () => { if (expired) throw new Error('fixture deadline'); } };
  await assert.rejects(scanReplies(ctx, { applications, stateDirectory,
    publish: async candidate => published.push(candidate.message_id) }), /deadline/u);
  assert.deepStrictEqual(published, ['message1']);
  assert.deepStrictEqual(readJson(cursor(stateDirectory)).processed_message_ids, ['message1']);
  const retried = await scanReplies(mailbox({ ids: ['message1', 'message2'] }).ctx, { applications, stateDirectory,
    publish: async candidate => published.push(candidate.message_id) });
  assert.deepStrictEqual(published, ['message1', 'message2']);
  assert.strictEqual(retried.processedCount, 2);
});

await test('atomic JSON failure preserves existing bytes and cleans temporary files', async root => {
  const filename = path.join(root, 'state.json');
  atomicJson(filename, { original: true });
  const original = fs.readFileSync(filename, 'utf8');
  const circular = {};
  circular.self = circular;
  assert.throws(() => atomicJson(filename, circular));
  assert.strictEqual(fs.readFileSync(filename, 'utf8'), original);
  assert.deepStrictEqual(fs.readdirSync(root), ['state.json']);
});

await test('symlinked state files and directories cannot redirect local writes', async root => {
  const targetDirectory = path.join(root, 'target');
  privateDirectory(targetDirectory);
  const target = path.join(targetDirectory, 'original.json');
  atomicJson(target, { preserved: true });
  const alias = path.join(root, 'alias.json');
  fs.symlinkSync(target, alias);
  assert.throws(() => readJson(alias), /regular local file/u);
  assert.throws(() => atomicJson(alias, { overwritten: true }), /regular local file/u);
  const aliasDirectory = path.join(root, 'alias-directory');
  fs.symlinkSync(targetDirectory, aliasDirectory);
  assert.throws(() => privateDirectory(aliasDirectory), /symlinked local directory/u);
  assert.deepStrictEqual(readJson(target), { preserved: true });
});

console.log(`gmail scanner: ${count} tests passed`);
