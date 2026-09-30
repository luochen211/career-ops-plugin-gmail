import path from 'node:path';
import leads from './ingest.mjs';
import { loadCoreContext } from './lib/core.mjs';
import { boundedContext } from './lib/budget.mjs';
import { proposalPublisher } from './lib/proposals.mjs';
import { scanReplies } from './lib/scan.mjs';

export { scanReplies } from './lib/scan.mjs';

export default {
  async ingest(ctx) {
    const mode = ctx?.settings?.mode ?? 'leads';
    if (mode === 'leads') return leads.ingest(ctx);
    if (mode !== 'replies') throw new Error('gmail: mode must be leads or replies');
    const bounded = boundedContext(ctx);
    const core = await loadCoreContext(ctx.settings);
    bounded.assertActive();
    const publish = proposalPublisher(core);
    const result = await scanReplies(bounded, {
      applications: core.applications,
      stateDirectory: path.join(core.dataRoot, 'data', 'gmail-replies'),
      publish: (candidate, options) => {
        bounded.assertActive();
        return publish(candidate, options);
      },
      // JSON quoting prevents terminal controls in untrusted mail from taking
      // effect. The normalized result carries confidence and quoted evidence;
      // only the narrow core row format is persisted as a proposal.
      display: (candidate, delivery) => {
        ctx.log(`gmail reply candidate: ${JSON.stringify(candidate)}`);
        if (delivery?.retainedOriginal) ctx.log('gmail: the original proposal for this message was retained; core will report any stale row or status.');
      },
    });
    ctx.log(`gmail: ${result.candidates.length} new reply candidates; ${result.failed.length} message fetches pending retry${ctx.dryRun ? ' (dry run)' : ''}. Review proposals with node reply-watch.mjs.`);
    return []; // Reply candidates are never Job[] or pipeline rows.
  },
};
