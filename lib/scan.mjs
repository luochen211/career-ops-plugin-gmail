import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createGmailClient, createReplyQuery } from './gmail.mjs';
import { classifyMessage } from './classify.mjs';
import { atomicJson, privateDirectory, readJson } from './files.mjs';

export const accountIdentity = address => createHash('sha256').update(address.trim().toLowerCase()).digest('hex');

/** All I/O is injected or explicitly scoped to the plugin cursor. */
export async function scanReplies(ctx, { applications = [], stateDirectory, publish, display = () => {} } = {}) {
  if (!stateDirectory || typeof publish !== 'function') throw new Error('gmail: scanner needs a cursor directory and proposal publisher');
  const query = createReplyQuery(ctx.settings, applications);
  const client = await createGmailClient(ctx);
  const accountId = accountIdentity(await client.getAccountAddress());
  const statePath = path.join(stateDirectory, `${accountId}.json`);
  const lockPath = `${statePath}.lock`;
  let lock;
  try {
    // Serialize a whole scan, including publication and cursor persistence. A
    // crash leaves a lock that the user must remove after checking no scan runs.
    if (!ctx.dryRun) {
      ctx.assertActive?.();
      privateDirectory(stateDirectory);
      try { lock = fs.openSync(lockPath, 'wx', 0o600); }
      catch (error) {
        if (error.code === 'EEXIST') throw new Error('gmail: reply scan already locked; check for an active scan before removing its .lock file');
        throw error;
      }
    }
    let state;
    try { state = readJson(statePath); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (state !== undefined && (!state || typeof state !== 'object' || state.schema_version !== 1 || state.account_id !== accountId
        || !Array.isArray(state.processed_message_ids)
        || state.processed_message_ids.some(id => typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(id)))) {
      throw new Error('gmail: invalid reply cursor; refusing to discard deduplication history');
    }
    const processed = new Set(state?.processed_message_ids || []);
    const candidates = [];
    const failed = [];
    for await (const messages of client.messagePages(query)) {
      for (const { id } of messages) {
        ctx.assertActive?.();
        if (processed.has(id)) continue;
        let message;
        try { message = await client.getMetadata(id); }
        catch {
          failed.push(id);
          continue; // Leave failed messages eligible for retry.
        }
        const candidate = classifyMessage(message, applications);
        if (candidate) {
          // Publication happens BEFORE cursor advancement; deterministic drop
          // identity makes retry after a crash safe, even after core accepts it.
          ctx.assertActive?.();
          const delivery = await publish(candidate, { accountId, dryRun: ctx.dryRun === true });
          await display(candidate, delivery);
          candidates.push(candidate);
        }
        processed.add(id);
        ctx.assertActive?.();
        if (!ctx.dryRun) atomicJson(statePath, {
          schema_version: 1, account_id: accountId, processed_message_ids: [...processed],
        });
      }
    }
    ctx.assertActive?.();
    return { candidates, failed, accountId, processedCount: processed.size };
  } finally {
    if (lock !== undefined) {
      fs.closeSync(lock);
      fs.unlinkSync(lockPath);
    }
  }
}
