// The v1 host does not cancel work when its 15-second ingest timeout expires.
// Bound this plugin sooner and check the deadline before every local write.
export function boundedContext(ctx, milliseconds = 12_000) {
  const deadline = Date.now() + milliseconds;
  let timedOut = false;
  function expired() {
    timedOut = true;
    const error = new Error('gmail: scan deadline reached; narrow reply_query or reply_days_back and retry');
    error.code = 'scan-deadline';
    return error;
  }
  function assertActive() {
    if (timedOut || Date.now() >= deadline) throw expired();
  }
  async function bounded(operation) {
    assertActive();
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(operation),
        new Promise((_, reject) => { timer = setTimeout(() => reject(expired()), Math.max(1, deadline - Date.now())); }),
      ]);
    } finally { clearTimeout(timer); }
  }
  return {
    ...ctx, assertActive,
    fetch: async (url, options) => {
      const response = await bounded(() => ctx.fetch(url, { ...options, timeoutMs: Math.max(1, Math.min(4000, deadline - Date.now())) }));
      assertActive();
      return {
        ok: response.ok, status: response.status, redirected: response.redirected, url: response.url,
        json: () => bounded(() => response.json()),
      };
    },
  };
}
