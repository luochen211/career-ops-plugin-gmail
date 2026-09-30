import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Read-only host APIs, loaded only after explicit reply-mode opt-in. */
export async function loadCoreContext(settings = {}) {
  const root = path.resolve(settings.career_ops_root || process.cwd());
  // A current host without #3333 must fail before OAuth or local writes.
  if (!fs.existsSync(path.join(root, 'lib', 'reply-proposals.mjs'))) {
    throw new Error('gmail: reply mode requires the #3333 core proposal reader; set career_ops_root to that career-ops checkout');
  }
  const modules = await Promise.all(['path-resolver.mjs', 'tracker-parse.mjs', 'tracker-utils.mjs']
    .map(name => import(pathToFileURL(path.join(root, name)).href)));
  const [paths, parser, tracker] = modules;
  const dataRoot = fs.realpathSync(paths.getCareerOpsRoot());
  const trackerPath = fs.realpathSync(paths.resolveTrackerPath(dataRoot));
  const lines = fs.readFileSync(trackerPath, 'utf8').split('\n');
  const columns = parser.resolveColumns(lines);
  const applications = lines.map(line => parser.parseTrackerRow(line, columns)).filter(Boolean);
  // Contact hints are explicit local settings keyed by tracker row number. Do
  // not guess employer identity from a shared ATS or a report URL's hostname.
  for (const app of applications) {
    const hints = settings.reply_contacts?.[app.num];
    if (!hints || typeof hints !== 'object') continue;
    for (const key of ['recruiter_emails', 'recruiter_domains']) {
      if (Array.isArray(hints[key]) && hints[key].every(value => typeof value === 'string')) app[key] = hints[key];
    }
  }
  const states = tracker.loadCanonicalStates(path.join(root, 'templates', 'states.yml'));
  return { dataRoot, trackerPath, applications, states };
}
