// Producer for the draft #3333 core contract. No tracker writes or writer imports.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { atomicJson, readJson, privateDirectory } from './files.mjs';

const CONTROLS = /[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const digest = source => createHash('sha256').update(JSON.stringify([source.kind, source.account_id, source.message_id])).digest('hex');

export function buildProposal(candidate, { accountId, trackerPath, applications, states }) {
  const matches = applications.filter(app => app.num === candidate.matched_application);
  if (matches.length !== 1) return null;
  const app = matches[0];
  // Core checks the exact canonical label on read. Unknown/legacy cells must
  // be normalized by the user in core, never guessed in this integration.
  const from = states.find(state => state.label === app.status);
  const to = states.find(state => state.id === candidate.suggested_status);
  if (!from || !to || from.id === to.id || from.terminal) return null;
  if (!to.terminal && states.indexOf(to) <= states.indexOf(from)) return null;
  const evidence = candidate.evidence.find(text => typeof text === 'string' && text.trim()
    && text.length <= 2000 && !CONTROLS.test(text)
    && (candidate.subject.includes(text) || candidate.body_snippet.includes(text)));
  if (!evidence) return null;
  if (!/^[a-f0-9]{64}$/.test(accountId) || !/^[A-Za-z0-9_-]{1,256}$/.test(candidate.message_id)) {
    throw new Error('gmail: invalid proposal source identity');
  }
  if (!path.isAbsolute(trackerPath) || fs.realpathSync(trackerPath) !== trackerPath) {
    throw new Error('gmail: proposal tracker path must be canonical');
  }
  const application = Object.fromEntries(['num', 'date', 'company', 'role', 'report'].map(key => [key, app[key]]));
  if (!Number.isSafeInteger(application.num) || application.num <= 0
      || ['date', 'company', 'role', 'report'].some(key => typeof application[key] !== 'string' || CONTROLS.test(application[key]))
      || !application.company.trim() || !application.role.trim()
      || application.date.length > 100 || application.company.length > 1000
      || application.role.length > 1000 || application.report.length > 2000) return null;
  return {
    schema_version: 1,
    source: { kind: 'gmail', account_id: accountId, message_id: candidate.message_id },
    tracker_path: trackerPath, application,
    from_status: from.id, to_status: to.id, evidence,
  };
}

export function proposalPublisher({ dataRoot, trackerPath, applications, states }) {
  return async (candidate, { accountId, dryRun }) => {
    const proposal = buildProposal(candidate, { accountId, trackerPath, applications, states });
    if (!proposal) return { published: false };
    const key = digest(proposal.source);
    const receipt = `[reply-proposal:${key}]`;
    if (applications.some(app => app.notes?.split(';').some(note => note.trim() === receipt))) return { published: false, accepted: true };
    const directory = path.join(dataRoot, 'data', 'reply-proposals');
    const filename = path.join(directory, `gmail-${key}.json`);
    // Never replace an earlier drop: it captures the original identity and
    // from-state. Rebinding an old message to a new row would defeat review.
    if (fs.existsSync(directory)) {
      const stat = fs.lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('gmail: unsafe proposal directory');
    }
    if (fs.existsSync(filename)) {
      const old = readJson(filename);
      if (old?.schema_version !== 1 || old.tracker_path !== trackerPath
          || JSON.stringify(old.source) !== JSON.stringify(proposal.source)) {
        throw new Error('gmail: invalid existing proposal; review the original drop before retrying');
      }
      return { published: false, duplicate: true, retainedOriginal: JSON.stringify(old) !== JSON.stringify(proposal) };
    }
    if (!dryRun) {
      privateDirectory(directory);
      atomicJson(filename, proposal);
    }
    return { published: !dryRun, proposal };
  };
}
