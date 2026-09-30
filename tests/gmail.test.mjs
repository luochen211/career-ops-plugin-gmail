import assert from 'node:assert';
import { createGmailClient, createReplyQuery, GMAIL_READONLY_SCOPE } from '../lib/gmail.mjs';

const env = {
  GMAIL_CLIENT_ID: 'fixture-client', GMAIL_CLIENT_SECRET: 'fixture-secret',
  GMAIL_REFRESH_TOKEN: 'fixture-refresh',
};
const token = { access_token: 'fixture-access', token_type: 'Bearer', scope: GMAIL_READONLY_SCOPE };
const message = {
  id: 'abc1', threadId: 'thread1', internalDate: '1780000000000', snippet: 'An interview invitation',
  payload: { headers: [{ name: 'From', value: 'Recruiter <recruiter@example.test>' }] },
};
const response = data => ({ ok: true, status: 200, json: async () => data });

function mock(...replies) {
  const calls = [];
  return {
    calls,
    ctx: {
      env,
      fetch: async (url, options) => {
        calls.push({ url: new URL(url), options });
        assert.ok(replies.length > 0, 'unexpected network request');
        const reply = replies.shift();
        if (reply instanceof Error) throw reply;
        return reply;
      },
    },
  };
}

let count = 0;
async function test(name, run) {
  await run();
  count += 1;
  console.log(`ok ${count} - ${name}`);
}

await test('requires scoped fetch and credentials before making a request', async () => {
  await assert.rejects(createGmailClient({ env }), { code: 'missing-context-fetch' });
  const mocked = mock();
  for (const key of Object.keys(env)) {
    await assert.rejects(createGmailClient({ ...mocked.ctx, env: { ...env, [key]: '' } }), {
      code: 'missing-oauth-credentials',
    });
  }
  assert.strictEqual(mocked.calls.length, 0);
});

await test('exchanges readonly scope via the injected fetch only', async () => {
  const mocked = mock(response(token));
  await createGmailClient(mocked.ctx);
  const { url, options } = mocked.calls[0];
  assert.strictEqual(url.toString(), 'https://oauth2.googleapis.com/token');
  assert.strictEqual(options.method, 'POST');
  assert.strictEqual(options.redirect, 'error');
  assert.strictEqual(options.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.deepStrictEqual(Object.fromEntries(options.body), {
    client_id: env.GMAIL_CLIENT_ID, client_secret: env.GMAIL_CLIENT_SECRET,
    refresh_token: env.GMAIL_REFRESH_TOKEN, grant_type: 'refresh_token', scope: GMAIL_READONLY_SCOPE,
  });
});

await test('rejects wider or malformed returned scopes; accepts an omitted scope', async () => {
  for (const scope of ['', null, {}, 'https://mail.google.com/',
    'https://www.googleapis.com/auth/gmail.modify',
    `${GMAIL_READONLY_SCOPE} https://www.googleapis.com/auth/gmail.send`]) {
    await assert.rejects(createGmailClient(mock(response({ ...token, scope })).ctx), { code: 'oauth-scope-not-readonly' });
  }
  await createGmailClient(mock(response({ access_token: 'fixture-access' })).ctx);
});

await test('rejects invalid access tokens and token types', async () => {
  for (const access_token of ['', null, 'contains\r\ninjection', 'a'.repeat(8193)]) {
    await assert.rejects(createGmailClient(mock(response({ ...token, access_token })).ctx), { code: 'invalid-access-token' });
  }
  await assert.rejects(createGmailClient(mock(response({ ...token, token_type: 'mac' })).ctx), { code: 'invalid-token-type' });
});

await test('reads account identity without profile history or message counts', async () => {
  const mocked = mock(response(token), response({ emailAddress: 'Fixture.User@example.test', historyId: 'private' }));
  const client = await createGmailClient(mocked.ctx);
  assert.strictEqual(await client.getAccountAddress(), 'Fixture.User@example.test');
  const { url, options } = mocked.calls[1];
  assert.strictEqual(url.toString(), 'https://gmail.googleapis.com/gmail/v1/users/me/profile?fields=emailAddress');
  assert.strictEqual(options.method, 'GET');
  assert.strictEqual(options.redirect, 'error');
  for (const emailAddress of [null, '', 'no-address', 'a@b', 'a@example.test\r\nInjected: value']) {
    const malformed = await createGmailClient(mock(response(token), response({ emailAddress })).ctx);
    await assert.rejects(malformed.getAccountAddress(), { code: 'invalid-account-address' });
  }
});

await test('exhausts pages, encodes page tokens and deduplicates IDs', async () => {
  const mocked = mock(response(token),
    response({ messages: [{ id: 'abc1', threadId: 'thread1' }], nextPageToken: 'page/&?# +=' }),
    response({ messages: [{ id: 'abc1', threadId: 'thread1' }, { id: 'abc2', threadId: 'thread2' }] }));
  const client = await createGmailClient(mocked.ctx);
  const query = 'newer_than:30d {"interview" "面试"}';
  assert.deepStrictEqual(await client.listMessages(query), [
    { id: 'abc1', threadId: 'thread1' }, { id: 'abc2', threadId: 'thread2' },
  ]);
  for (const { url, options } of mocked.calls.slice(1)) {
    assert.strictEqual(url.origin, 'https://gmail.googleapis.com');
    assert.strictEqual(url.pathname, '/gmail/v1/users/me/messages');
    assert.strictEqual(url.searchParams.get('q'), query);
    assert.strictEqual(url.searchParams.get('fields'), 'messages(id,threadId),nextPageToken');
    assert.strictEqual(options.method, 'GET');
    assert.deepStrictEqual(options.headers, { Authorization: 'Bearer fixture-access' });
    assert.strictEqual(options.redirect, 'error');
  }
  assert.strictEqual(mocked.calls[2].url.searchParams.get('pageToken'), 'page/&?# +=');
});

await test('requests pages lazily and deduplicates within and across pages', async () => {
  const mocked = mock(response(token),
    response({ messages: [{ id: 'abc1', threadId: 'thread1' }, { id: 'abc1', threadId: 'thread1' }], nextPageToken: 'second' }),
    response({ messages: [{ id: 'abc1', threadId: 'thread1' }, { id: 'abc2', threadId: 'thread2' }] }));
  const client = await createGmailClient(mocked.ctx);
  const pages = client.messagePages('interview');
  assert.strictEqual(mocked.calls.length, 1, 'iterator creation must not request a list');
  assert.deepStrictEqual(await pages.next(), { value: [{ id: 'abc1', threadId: 'thread1' }], done: false });
  assert.strictEqual(mocked.calls.length, 2, 'first page must yield before the next list request');
  await Promise.resolve();
  assert.strictEqual(mocked.calls.length, 2, 'pages must not be prefetched');
  assert.deepStrictEqual(await pages.next(), { value: [{ id: 'abc2', threadId: 'thread2' }], done: false });
  assert.strictEqual(mocked.calls.length, 3);
  assert.strictEqual(mocked.calls[2].url.searchParams.get('pageToken'), 'second');
  assert.deepStrictEqual(await pages.next(), { value: undefined, done: true });
  assert.strictEqual(mocked.calls.length, 3);
});

await test('stopping iteration after a page never requests its successor', async () => {
  const mocked = mock(response(token), response({ messages: [{ id: 'abc1', threadId: 'thread1' }], nextPageToken: 'later' }));
  const client = await createGmailClient(mocked.ctx);
  for await (const page of client.messagePages('interview')) {
    assert.deepStrictEqual(page, [{ id: 'abc1', threadId: 'thread1' }]);
    break;
  }
  assert.strictEqual(mocked.calls.length, 2);
});

await test('a later page failure preserves delivery of earlier messages and remains an error', async () => {
  const mocked = mock(response(token),
    response({ messages: [{ id: 'abc1', threadId: 'thread1' }], nextPageToken: 'later' }),
    response({ messages: [{ id: 'abc2', threadId: 'thread2' }, null] }));
  const client = await createGmailClient(mocked.ctx);
  const delivered = [];
  await assert.rejects(async () => {
    for await (const page of client.messagePages('interview')) delivered.push(...page);
  }, { code: 'invalid-message-list' });
  assert.deepStrictEqual(delivered, [{ id: 'abc1', threadId: 'thread1' }]);
  assert.strictEqual(mocked.calls.length, 3);
});

await test('generator validates query and rejects repeated tokens and conflicting threads before yielding', async () => {
  const unused = mock(response(token));
  const client = await createGmailClient(unused.ctx);
  for (const query of ['', '  ', null, 'x'.repeat(2049)]) {
    await assert.rejects(client.messagePages(query).next(), { code: 'invalid-reply-query' });
  }
  assert.strictEqual(unused.calls.length, 1);
  for (const [second, code] of [
    [{ messages: [{ id: 'abc2', threadId: 'thread2' }], nextPageToken: 'again' }, 'repeated-page-token'],
    [{ messages: [{ id: 'abc1', threadId: 'different-thread' }] }, 'inconsistent-message-thread'],
    [{ messages: [{ id: 'abc2', threadId: 'thread2' }], nextPageToken: {} }, 'invalid-page-token'],
  ]) {
    const paged = await createGmailClient(mock(response(token),
      response({ messages: [{ id: 'abc1', threadId: 'thread1' }], nextPageToken: 'again' }), response(second)).ctx);
    const iterator = paged.messagePages('interview');
    const first = await iterator.next();
    assert.deepStrictEqual(first.value, [{ id: 'abc1', threadId: 'thread1' }]);
    first.value[0].threadId = 'changed-by-consumer';
    await assert.rejects(iterator.next(), { code });
  }
});

await test('empty mailbox is valid and looping pagination fails', async () => {
  const empty = await createGmailClient(mock(response(token), response({})).ctx);
  assert.deepStrictEqual(await empty.listMessages('interview'), []);
  const looping = await createGmailClient(mock(response(token), response({ nextPageToken: 'again' }),
    response({ nextPageToken: 'again' })).ctx);
  await assert.rejects(looping.listMessages('interview'), { code: 'repeated-page-token' });
});

await test('rejects malformed lists, tokens and conflicting duplicate message IDs', async () => {
  for (const data of [{ messages: null }, { messages: {} }, { messages: [null] },
    { messages: [{ id: 'abc1' }] }, { messages: [{ id: '', threadId: 'thread1' }] }]) {
    const client = await createGmailClient(mock(response(token), response(data)).ctx);
    await assert.rejects(client.listMessages('interview'), { code: 'invalid-message-list' });
  }
  const badPage = await createGmailClient(mock(response(token), response({ nextPageToken: {} })).ctx);
  await assert.rejects(badPage.listMessages('interview'), { code: 'invalid-page-token' });
  const conflict = await createGmailClient(mock(response(token), response({
    messages: [{ id: 'abc1', threadId: 'thread1' }, { id: 'abc1', threadId: 'thread2' }],
  })).ctx);
  await assert.rejects(conflict.listMessages('interview'), { code: 'inconsistent-message-thread' });
});

await test('requests metadata and minimum headers, and discards extra response fields', async () => {
  const id = 'message_id-2';
  const supplied = { ...message, id, labelIds: ['INBOX'], payload: {
    body: { data: 'should-not-leave-transport' }, parts: [{ filename: 'resume.pdf' }],
    headers: [...message.payload.headers, { name: 'X-Private', value: 'unneeded' }],
  } };
  const mocked = mock(response(token), response(supplied));
  const client = await createGmailClient(mocked.ctx);
  assert.deepStrictEqual(await client.getMetadata(id), { ...message, id });
  const { url, options } = mocked.calls[1];
  assert.strictEqual(url.pathname, `/gmail/v1/users/me/messages/${encodeURIComponent(id)}`);
  assert.strictEqual(url.searchParams.get('format'), 'metadata');
  assert.strictEqual(url.searchParams.get('fields'), 'id,threadId,internalDate,snippet,payload(headers)');
  assert.deepStrictEqual(url.searchParams.getAll('metadataHeaders'), ['From', 'Subject', 'Date', 'Authentication-Results']);
  assert.strictEqual(options.method, 'GET');
});

await test('rejects malformed metadata and path traversal IDs', async () => {
  for (const supplied of [{ ...message, id: 'different' }, { ...message, threadId: null },
    { ...message, snippet: null }, { ...message, internalDate: 'not-a-time' },
    { ...message, internalDate: '999999999999999999999999' }, { ...message, payload: null },
    { ...message, payload: { headers: [{ name: 'From', value: null }] } }]) {
    const client = await createGmailClient(mock(response(token), response(supplied)).ctx);
    await assert.rejects(client.getMetadata('abc1'), { code: 'invalid-message-metadata' });
  }
  const mocked = mock(response(token));
  const client = await createGmailClient(mocked.ctx);
  for (const id of ['', '.', '..', null, 'contains\nnewline', 'message/id?&=', 'a'.repeat(257)]) {
    await assert.rejects(client.getMetadata(id), { code: 'invalid-message-id' });
  }
  assert.strictEqual(mocked.calls.length, 1);
});

await test('errors never disclose upstream bodies, exceptions, credentials or tokens', async () => {
  const secret = 'sensitive-provider-response fixture-secret fixture-refresh fixture-access';
  for (const reply of [
    { ok: false, status: 401, text: () => { throw new Error('body must not be read'); } },
    Object.assign(new Error(secret), { status: 403 }),
    { ok: true, status: 200, json: async () => { throw new Error(secret); } },
    response(null),
    { ok: true, status: 200, redirected: true, json: async () => token },
    { ok: true, status: 200, url: 'https://gmail.googleapis.com/redirect-target', json: async () => token },
  ]) {
    await assert.rejects(createGmailClient(mock(reply).ctx), error => {
      assert.ok(!error.message.includes('fixture'));
      assert.ok(!error.message.includes('sensitive'));
      assert.strictEqual(error.cause, undefined);
      assert.match(error.message, /^gmail: token-(request-failed|invalid-json)( \(HTTP \d{3}\))?$/u);
      return true;
    });
  }
  const client = await createGmailClient(mock(response(token), new Error(secret)).ctx);
  await assert.rejects(client.listMessages('interview'), { message: 'gmail: list-request-failed' });
});

await test('default query includes English/Chinese signals OR minimal tracker context', () => {
  const query = createReplyQuery({}, [{ company: 'Example Company', role: 'Engineer',
    recruiter_emails: ['recruiter@example.test'], recruiter_domains: ['employer.example.test'],
    notes: 'PRIVATE NOTES', cv: 'PRIVATE CV' }]);
  assert.ok(query.startsWith('newer_than:30d {'));
  for (const phrase of ['"interview"', '"面试"', '"未通过"', '"Example Company"', '"Engineer"',
    '"recruiter@example.test"', '"employer.example.test"']) {
    assert.ok(query.includes(phrase));
  }
  assert.ok(!query.includes('PRIVATE'));
  assert.strictEqual((query.match(/\{/gu) || []).length, 1);
});

await test('tracker text cannot inject Gmail operators, braces or quotes', () => {
  const query = createReplyQuery({}, [{ company: '"} OR in:anywhere {"', role: 'from:evil@example.test', contact: '【面试】' }]);
  assert.ok(!query.includes('in:anywhere'));
  assert.ok(!query.includes('from:evil'));
  assert.ok(query.includes('"OR in anywhere"'));
  assert.strictEqual((query.match(/\{/gu) || []).length, 1);
  assert.strictEqual((query.match(/\}/gu) || []).length, 1);
});

await test('query construction is bounded and deterministic with many applications', () => {
  const applications = Array.from({ length: 1000 }, (_, i) => ({ company: `Company ${i} ${'z'.repeat(100)}` }));
  const query = createReplyQuery({ reply_days_back: 7, reply_label: 'Application Replies' }, applications);
  assert.ok(query.length <= 2048);
  assert.strictEqual(query, createReplyQuery({ reply_days_back: 7, reply_label: 'Application Replies' }, applications));
  assert.ok(query.startsWith('newer_than:7d '));
  assert.ok(query.endsWith(' label:"Application Replies"'));
});

await test('custom query retains lookback and invalid settings fail safely', () => {
  assert.strictEqual(createReplyQuery({ reply_query: 'from:example.test', reply_days_back: 14 }),
    'newer_than:14d (from:example.test)');
  for (const settings of [{ reply_days_back: 0 }, { reply_days_back: 1.5 }, { reply_days_back: 366 },
    { reply_query: 'x'.repeat(2048) }, { reply_query: {} }, { reply_label: '" OR in:anywhere' },
    { reply_label: 'has\nnewline' }]) assert.throws(() => createReplyQuery(settings), /^Error: gmail: invalid-/u);
});

console.log(`gmail transport: ${count} tests passed`);
