// All network traffic uses the host's allowlisted ctx.fetch. No mailbox mutations.
export const GMAIL_READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const MESSAGES_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages';
const PROFILE_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/profile?fields=emailAddress';
const HEADER_NAMES = ['From', 'Subject', 'Date', 'Authentication-Results'];
const HEADER_SET = new Set(HEADER_NAMES.map(name => name.toLowerCase()));
const MAX_QUERY_LENGTH = 2048;
const SIGNALS = [
  'interview', 'assessment', 'application', 'offer', 'unfortunately',
  'regret', 'not selected', 'next steps', '面试', '笔试', '测评', '录用',
  '申请', '应聘', '遗憾', '未通过', '下一步',
];

function failure(code, status) {
  const safeStatus = Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined;
  const error = new Error(`gmail: ${code}${safeStatus === undefined ? '' : ` (HTTP ${safeStatus})`}`);
  error.code = code;
  if (safeStatus !== undefined) error.status = safeStatus;
  return error;
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function identifier(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,256}$/u.test(value);
}

async function requestJson(fetchFn, url, options, operation) {
  let response;
  try {
    // Request no redirects. The host owns enforcement of its fetch policy.
    response = await fetchFn(url, { ...options, redirect: 'error' });
  } catch (error) {
    // ctx.fetch can throw an error containing a response body. Never retain it.
    if (error?.code === 'scan-deadline') throw failure('scan-deadline');
    throw failure(`${operation}-request-failed`, error?.status);
  }
  if (!response || response.redirected || response.ok !== true ||
      (typeof response.url === 'string' && response.url && response.url !== url)) {
    throw failure(`${operation}-request-failed`, response?.status);
  }
  try {
    const data = await response.json();
    if (!object(data)) throw new Error('invalid');
    return data;
  } catch (error) {
    if (error?.code === 'scan-deadline') throw failure('scan-deadline');
    throw failure(`${operation}-invalid-json`);
  }
}

/**
 * Exchange a pre-provisioned read-only refresh token. Google may omit scope in
 * a refresh response; in that case the caller must have provisioned the token
 * with GMAIL_READONLY_SCOPE alone. The requested scope cannot elevate a grant.
 * Neither tokens nor response bodies are included in errors.
 */
export async function createGmailClient(ctx) {
  if (typeof ctx?.fetch !== 'function') throw failure('missing-context-fetch');
  const credentials = ['GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'GMAIL_REFRESH_TOKEN']
    .map(key => ctx?.env?.[key]);
  if (credentials.some(value => typeof value !== 'string' || !value.trim())) {
    throw failure('missing-oauth-credentials');
  }
  const fetchFn = ctx.fetch.bind(ctx);
  const tokenData = await requestJson(fetchFn, TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: credentials[0],
      client_secret: credentials[1],
      refresh_token: credentials[2],
      grant_type: 'refresh_token',
      scope: GMAIL_READONLY_SCOPE,
    }),
  }, 'token');
  if (typeof tokenData.access_token !== 'string' || !tokenData.access_token ||
      tokenData.access_token.length > 8192 || /[\s\x00-\x1f\x7f]/u.test(tokenData.access_token)) {
    throw failure('invalid-access-token');
  }
  if (tokenData.token_type !== undefined &&
      (typeof tokenData.token_type !== 'string' || tokenData.token_type.toLowerCase() !== 'bearer')) {
    throw failure('invalid-token-type');
  }
  if (tokenData.scope !== undefined) {
    const scopes = typeof tokenData.scope === 'string' ? tokenData.scope.trim().split(/\s+/u) : [];
    if (scopes.length !== 1 || scopes[0] !== GMAIL_READONLY_SCOPE) {
      throw failure('oauth-scope-not-readonly');
    }
  }
  const headers = { Authorization: `Bearer ${tokenData.access_token}` };

  async function* messagePages(query) {
    if (typeof query !== 'string' || !query.trim() || query.length > MAX_QUERY_LENGTH) {
      throw failure('invalid-reply-query');
    }
    const messages = new Map();
    const pages = new Set();
    let pageToken;
    do {
      const url = new URL(MESSAGES_URL);
      url.searchParams.set('q', query);
      url.searchParams.set('maxResults', '100');
      url.searchParams.set('fields', 'messages(id,threadId),nextPageToken');
      if (pageToken !== undefined) url.searchParams.set('pageToken', pageToken);
      const data = await requestJson(fetchFn, url.toString(), { method: 'GET', headers }, 'list');
      if (data.messages !== undefined && !Array.isArray(data.messages)) throw failure('invalid-message-list');
      const page = [];
      for (const message of data.messages || []) {
        if (!object(message) || !identifier(message.id) || !identifier(message.threadId)) {
          throw failure('invalid-message-list');
        }
        if (messages.has(message.id) && messages.get(message.id) !== message.threadId) {
          throw failure('inconsistent-message-thread');
        }
        if (!messages.has(message.id)) page.push({ id: message.id, threadId: message.threadId });
        messages.set(message.id, message.threadId);
      }
      if (data.nextPageToken !== undefined &&
          (typeof data.nextPageToken !== 'string' || data.nextPageToken.length > 4096)) {
        throw failure('invalid-page-token');
      }
      pageToken = data.nextPageToken || undefined;
      if (pageToken !== undefined) {
        if (pages.has(pageToken)) throw failure('repeated-page-token');
        pages.add(pageToken);
      }
      // Yield only after validating the entire page. The caller can durably
      // process these messages before requesting another potentially failing
      // page; no subsequent list request is started until iteration resumes.
      yield page;
    } while (pageToken !== undefined);
  }

  return {
    async getAccountAddress() {
      const data = await requestJson(fetchFn, PROFILE_URL, { method: 'GET', headers }, 'profile');
      const address = typeof data.emailAddress === 'string' ? data.emailAddress.trim() : '';
      if (address.length > 254 ||
          !/^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9.-]*[A-Z0-9])?\.[A-Z]{2,63}$/iu.test(address)) {
        throw failure('invalid-account-address');
      }
      // The scanner hashes this address for identity and never persists it.
      return address;
    },

    messagePages,

    async listMessages(query) {
      const messages = [];
      for await (const page of messagePages(query)) messages.push(...page);
      return messages;
    },

    async getMetadata(id) {
      if (!identifier(id)) throw failure('invalid-message-id');
      const url = new URL(`${MESSAGES_URL}/${encodeURIComponent(id)}`);
      url.searchParams.set('format', 'metadata');
      url.searchParams.set('fields', 'id,threadId,internalDate,snippet,payload(headers)');
      for (const name of HEADER_NAMES) url.searchParams.append('metadataHeaders', name);
      const data = await requestJson(fetchFn, url.toString(), { method: 'GET', headers }, 'metadata');
      if (data.id !== id || !identifier(data.threadId) ||
          typeof data.internalDate !== 'string' || !/^\d+$/u.test(data.internalDate) ||
          !Number.isSafeInteger(Number(data.internalDate)) ||
          typeof data.snippet !== 'string' || !object(data.payload) ||
          (data.payload.headers !== undefined && !Array.isArray(data.payload.headers))) {
        throw failure('invalid-message-metadata');
      }
      const selectedHeaders = [];
      for (const header of data.payload.headers || []) {
        if (!object(header) || typeof header.name !== 'string' || typeof header.value !== 'string') {
          throw failure('invalid-message-metadata');
        }
        if (HEADER_SET.has(header.name.toLowerCase())) selectedHeaders.push({ name: header.name, value: header.value });
      }
      // Project the response too: unexpected body/attachment fields never reach
      // classification or storage, even if a server returns more than requested.
      return {
        id: data.id, threadId: data.threadId, internalDate: data.internalDate,
        snippet: data.snippet, payload: { headers: selectedHeaders },
      };
    },
  };
}

function literal(value) {
  if (typeof value !== 'string') return '';
  return value.normalize('NFKC').replace(/[^\p{L}\p{N}\s@._+-]/gu, ' ')
    .replace(/\s+/gu, ' ').trim().slice(0, 80).trim();
}

/** Only company, role and contact phrases leave the tracker, in a bounded query. */
export function createReplyQuery(settings = {}, applications = []) {
  if (!object(settings) || !Array.isArray(applications)) throw failure('invalid-query-settings');
  const days = Number(settings.reply_days_back ?? 30);
  if (!Number.isInteger(days) || days < 1 || days > 365) throw failure('invalid-reply-days-back');
  let suffix = '';
  if (settings.reply_label !== undefined && settings.reply_label !== '') {
    if (typeof settings.reply_label !== 'string' || settings.reply_label.length > 100 ||
        /["\\\x00-\x1f\x7f]/u.test(settings.reply_label) || !settings.reply_label.trim()) {
      throw failure('invalid-reply-label');
    }
    suffix = ` label:"${settings.reply_label.trim()}"`;
  }
  const prefix = `newer_than:${days}d `;
  if (settings.reply_query !== undefined && settings.reply_query !== '') {
    if (typeof settings.reply_query !== 'string' || !settings.reply_query.trim() ||
        /[\x00-\x1f\x7f]/u.test(settings.reply_query)) throw failure('invalid-reply-query');
    // User-supplied Gmail syntax is explicitly configured, never tracker text.
    const query = `${prefix}(${settings.reply_query.trim()})${suffix}`;
    if (query.length > MAX_QUERY_LENGTH) throw failure('invalid-reply-query');
    return query;
  }
  const phrases = new Set(SIGNALS);
  for (const application of applications) {
    if (!object(application)) continue;
    for (const field of ['company', 'role', 'contact', 'recruiter_emails', 'recruiter_domains']) {
      const values = Array.isArray(application[field]) ? application[field] : [application[field]];
      for (const value of values) {
        const phrase = literal(value);
        if (phrase.length >= 2) phrases.add(phrase);
      }
    }
  }
  let group = '';
  for (const phrase of phrases) {
    const next = `${group}${group ? ' ' : ''}"${phrase}"`;
    if (`${prefix}{${next}}${suffix}`.length > MAX_QUERY_LENGTH) break;
    group = next;
  }
  // Gmail braces mean OR: a known application can surface a terse reply, and a
  // clear signal can surface an unmatched application for conservative review.
  return `${prefix}{${group}}${suffix}`;
}
