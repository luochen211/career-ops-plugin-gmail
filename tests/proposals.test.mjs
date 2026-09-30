import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { buildProposal, proposalPublisher } from '../lib/proposals.mjs';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-proposals-')));
const trackerPath = path.join(root, 'applications.md');
fs.writeFileSync(trackerPath, 'fixture tracker bytes');
const applications = [{ num: 7, date: '2026-09-01', company: 'Example Labs', role: 'Backend Engineer', report: '[12](../reports/012-example.md)', status: 'Applied', notes: '' }];
const states = [
  { id: 'applied', label: 'Applied' }, { id: 'responded', label: 'Responded' },
  { id: 'interview', label: 'Interview' }, { id: 'offer', label: 'Offer', terminal: true },
  { id: 'rejected', label: 'Rejected', terminal: true },
];
const accountId = 'a'.repeat(64);
const candidate = {
  message_id: 'abc123', matched_application: 7, confidence: 'high', suggested_status: 'interview',
  subject: 'Example Labs interview', body_snippet: 'We would like to invite you to an interview.',
  evidence: ['We would like to invite you to an interview'],
};
const options = { accountId, dataRoot: root, trackerPath, applications, states };
let count = 0;
async function test(name, run) { await run(); console.log(`ok ${++count} - ${name}`); }
try {
  await test('emits exactly the draft core fields with tracker row identity', () => {
    const row = buildProposal(candidate, options);
    assert.deepStrictEqual(row, {
      schema_version: 1, source: { kind: 'gmail', account_id: accountId, message_id: 'abc123' },
      tracker_path: trackerPath,
      application: { num: 7, date: '2026-09-01', company: 'Example Labs', role: 'Backend Engineer', report: '[12](../reports/012-example.md)' },
      from_status: 'applied', to_status: 'interview', evidence: candidate.evidence[0],
    });
  });
  await test('unmatched, duplicate row IDs, unsafe evidence and aliases yield no proposal', () => {
    assert.strictEqual(buildProposal({ ...candidate, matched_application: null }, options), null);
    assert.strictEqual(buildProposal(candidate, { ...options, applications: [...applications, applications[0]] }), null);
    for (const evidence of [['Not in the message'], ['interview\n'], ['a'.repeat(2001)]]) {
      assert.strictEqual(buildProposal({ ...candidate, evidence }, options), null);
    }
    assert.strictEqual(buildProposal(candidate, { ...options, applications: [{ ...applications[0], status: 'aplicado' }] }), null);
  });
  await test('same, backward and terminal transitions stay review-only candidates', () => {
    for (const [status, next] of [['Interview', 'interview'], ['Interview', 'responded'], ['Offer', 'rejected']]) {
      assert.strictEqual(buildProposal({ ...candidate, suggested_status: next }, { ...options, applications: [{ ...applications[0], status }] }), null);
    }
  });
  await test('dry run builds a proposal without creating directories', async () => {
    const result = await proposalPublisher(options)(candidate, { accountId, dryRun: true });
    assert.strictEqual(result.published, false);
    assert.strictEqual(result.proposal.evidence, candidate.evidence[0]);
    assert.strictEqual(fs.existsSync(path.join(root, 'data')), false);
  });
  await test('publication is stable, private and never touches tracker', async () => {
    const publish = proposalPublisher(options);
    assert.strictEqual((await publish(candidate, { accountId })).published, true);
    assert.strictEqual((await publish(candidate, { accountId })).duplicate, true);
    const files = fs.readdirSync(path.join(root, 'data', 'reply-proposals'));
    assert.strictEqual(files.length, 1);
    assert.ok(files[0].endsWith('.json'));
    assert.strictEqual(fs.statSync(path.join(root, 'data', 'reply-proposals', files[0])).mode & 0o777, 0o600);
    assert.strictEqual(fs.readFileSync(trackerPath, 'utf8'), 'fixture tracker bytes');
  });
  await test('an existing source identity cannot be rebound to another transition', async () => {
    const retry = await proposalPublisher(options)({ ...candidate, suggested_status: 'offer' }, { accountId });
    assert.strictEqual(retry.retainedOriginal, true);
    const filename = fs.readdirSync(path.join(root, 'data', 'reply-proposals'))[0];
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(root, 'data', 'reply-proposals', filename), 'utf8')).to_status, 'interview');
    const changed = proposalPublisher({ ...options, applications: [{ ...applications[0], status: 'Responded' }] });
    assert.strictEqual((await changed(candidate, { accountId })).retainedOriginal, true);
    assert.strictEqual((await changed({ ...candidate, message_id: 'later_message' }, { accountId })).published, true);
  });
  await test('accepted receipt suppresses publication even without the old drop', async () => {
    const source = ['gmail', accountId, 'new_message'];
    const receipt = `[reply-proposal:${createHash('sha256').update(JSON.stringify(source)).digest('hex')}]`;
    const publish = proposalPublisher({ ...options, applications: [{ ...applications[0], notes: `note; ${receipt}` }] });
    assert.strictEqual((await publish({ ...candidate, message_id: 'new_message' }, { accountId })).accepted, true);
    assert.strictEqual(fs.readdirSync(path.join(root, 'data', 'reply-proposals')).length, 2);
  });
  await test('a symlinked proposal directory is rejected before write, including preview', async () => {
    const other = path.join(root, 'other');
    fs.mkdirSync(path.join(other, 'data'), { recursive: true });
    fs.symlinkSync(path.join(root, 'data', 'reply-proposals'), path.join(other, 'data', 'reply-proposals'));
    await assert.rejects(proposalPublisher({ ...options, dataRoot: other })(candidate, { accountId, dryRun: true }), /unsafe proposal directory/);
  });
} finally { fs.rmSync(root, { recursive: true, force: true }); }
