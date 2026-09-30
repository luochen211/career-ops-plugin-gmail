// Pure classification of Gmail metadata. Email content stays untrusted data;
// this module performs no I/O and never changes application state.

const MAX_SUBJECT = 512;
const MAX_SNIPPET = 2048;
const CONTROLS = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const SHARED_DOMAINS = [
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com',
  'yahoo.com', 'icloud.com', 'aol.com', 'proton.me', 'protonmail.com',
  'qq.com', '163.com', '126.com', 'foxmail.com',
  'greenhouse.io', 'greenhouse-mail.io', 'lever.co', 'ashbyhq.com',
  'myworkday.com', 'myworkdayjobs.com', 'workday.com', 'icims.com',
  'smartrecruiters.com', 'workable.com', 'bamboohr.com', 'successfactors.com',
  'recruitee.com', 'teamtailor.com', 'jobvite.com', 'personio.com',
  'personio.de', 'applytojob.com', 'jazz.co', 'zhaopin.com', 'zhipin.com',
  '51job.com', 'linkedin.com', 'indeed.com', 'monster.com',
];

function clean(value, limit) {
  if (typeof value !== 'string') return '';
  return value.slice(0, limit).replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function validDomain(value) {
  return typeof value === 'string' && value.length <= 253
    && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(value);
}

function mailbox(from) {
  // A single, unambiguous mailbox only; address groups and multiple From
  // addresses need a real mail parser and are deliberately left for review.
  const angle = from.match(/^(?:[^<>]*)<([^<>]+)>$/);
  const address = (angle ? angle[1] : from).trim().toLowerCase();
  if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+$/i.test(address)) return null;
  const [local, domain] = address.split('@');
  if (local.length > 64 || local.startsWith('.') || local.endsWith('.') || local.includes('..') || !validDomain(domain)) return null;
  if (angle && /[,;@]/.test(from.slice(0, from.indexOf('<')).replace(/"[^"\r\n]*"/g, ''))) return null;
  return { address, domain };
}

function withoutComments(value) {
  let depth = 0;
  let result = '';
  let escaped = false;
  for (const char of value) {
    if (escaped) { escaped = false; continue; }
    if (depth && char === '\\') { escaped = true; continue; }
    if (char === '(') { if (++depth > 10) return null; continue; }
    if (char === ')') { if (!depth) return null; if (--depth === 0) result += ' '; continue; }
    if (!depth) result += char;
  }
  return depth || escaped ? null : result;
}

function authenticated(headers, senderDomain) {
  // Only Gmail's authserv-id can establish trust. ARC assertions and results
  // supplied by the sending domain do not. This relies on Gmail supplying its
  // own Authentication-Results when metadata is read through the Gmail API.
  const trusted = headers.filter(header => header.name.toLowerCase() === 'authentication-results')
    .map(header => header.value)
    .filter(value => /^\s*mx\.google\.com(?=\s|;|\()/i.test(value));
  if (!trusted.length) return false;
  return trusted.every(value => {
    if (value.length > 16384) return false;
    const parsed = withoutComments(value);
    if (parsed === null || !/^\s*mx\.google\.com(?:\s+1)?\s*;/i.test(parsed)) return false;
    const methods = parsed.split(';').slice(1).map(part => part.trim());
    // Conservatively reject conflicting or explicitly failed checks, even
    // where DMARC could pass through its other aligned authentication method.
    if (methods.some(part => /^(?:spf|dkim|dmarc)\s*=\s*(?:fail|softfail|temperror|permerror)(?=\s|$)/i.test(part))) return false;
    const dmarc = methods.filter(part => /^dmarc\s*=/i.test(part));
    if (dmarc.length !== 1 || !/^dmarc\s*=\s*pass(?=\s|$)/i.test(dmarc[0])) return false;
    const domains = [...dmarc[0].matchAll(/(?:^|\s)header\.from\s*=\s*([a-z0-9.-]+)(?=\s|$)/gi)];
    return domains.length === 1 && domains[0][1].toLowerCase() === senderDomain;
  });
}

function phraseMatch(text, phrase) {
  if (typeof phrase !== 'string' || phrase.length > 256) return false;
  const name = clean(phrase, 256).normalize('NFC');
  if (!/[\p{L}\p{N}]/u.test(name) || /^(?:unknown|n\/a|none|not available|tbd|待定|未知)$/iu.test(name)) return false;
  const haystack = text.normalize('NFC').toLowerCase();
  const needle = name.toLowerCase();
  // Han and Japanese names naturally appear without spaces. Other scripts
  // use Unicode letter/mark/number boundaries, including long company names.
  if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(needle)) return haystack.includes(needle);
  let offset = haystack.indexOf(needle);
  while (offset >= 0) {
    const before = Array.from(haystack.slice(0, offset)).at(-1) || '';
    const after = Array.from(haystack.slice(offset + needle.length))[0] || '';
    if (!/[\p{L}\p{M}\p{N}]/u.test(before) && !/[\p{L}\p{M}\p{N}]/u.test(after)) return true;
    offset = haystack.indexOf(needle, offset + 1);
  }
  return false;
}

function sharedDomain(domain) {
  return SHARED_DOMAINS.some(shared => domain === shared || domain.endsWith(`.${shared}`));
}

function appDomains(app) {
  // Only explicitly configured employer domains count. A job URL may belong
  // to any shared ATS or job board, including vendors absent from our list.
  const domains = Array.isArray(app.recruiter_domains) ? app.recruiter_domains : [];
  return domains.filter(domain => validDomain(domain) && !sharedDomain(domain.toLowerCase())).map(domain => domain.toLowerCase());
}

function matchApplication(text, sender, applications) {
  const rows = (Array.isArray(applications) ? applications : [])
    .filter(app => app && Number.isSafeInteger(app.num) && app.num > 0)
    .map(app => {
      const company = phraseMatch(text, app.company);
      const role = phraseMatch(text, app.role);
      const email = Array.isArray(app.recruiter_emails) && app.recruiter_emails.some(value => mailbox(clean(value, 320))?.address === sender.address);
      const domain = appDomains(app).some(value => sender.domain === value || sender.domain.endsWith(`.${value}`));
      return { app, company, role, email, domain, score: Number(company) * 3 + Number(role) * 5 + Number(email) * 4 + Number(domain) * 2 };
    });
  // A title by itself never identifies its employer. Company-only rows stay
  // unmatched until corroborated by the full role or known recruiter contact.
  const possible = rows.filter(row => row.email || row.domain || (row.company && row.role));
  const named = rows.filter(row => row.company);
  const ranked = possible.sort((a, b) => b.score - a.score);
  const top = ranked[0];
  let ambiguous = Boolean(top && ranked[1]?.score === top.score);
  let chosen = top && !ambiguous ? top : null;
  if (chosen) {
    const companyKey = clean(chosen.app.company, 256).normalize('NFC').toLowerCase();
    const sameCompany = rows.filter(row => clean(row.app.company, 256).normalize('NFC').toLowerCase() === companyKey);
    // A shared recruiting contact does not identify a particular application.
    // Even uneven contact metadata must not break ties between same-company
    // rows; require one explicit full role when that company has several rows.
    if (sameCompany.length > 1) {
      const roles = sameCompany.filter(row => row.role && (row.company || row.email || row.domain));
      chosen = roles.length === 1 ? roles[0] : null;
      ambiguous = !chosen;
    }
  }
  const companies = [...new Set(named.map(row => clean(row.app.company, 256)))];
  const roles = [...new Set(named.filter(row => row.role).map(row => clean(row.app.role, 256)))];
  const evidence = [];
  if (chosen) {
    if (chosen.company) evidence.push(`Company: ${JSON.stringify(clean(chosen.app.company, 256))}`);
    if (chosen.role) evidence.push(`Role: ${JSON.stringify(clean(chosen.app.role, 256))}`);
    if (chosen.email) evidence.push(`Known recruiter address: ${sender.address}`);
    if (chosen.domain) evidence.push(`Known employer domain: ${sender.domain}`);
  } else if (ambiguous || named.length > 1) {
    evidence.push('Multiple tracker applications fit; no application selected.');
  }
  return {
    row: chosen,
    ambiguous: ambiguous || (!chosen && named.length > 1),
    company: chosen ? clean(chosen.app.company, 256) : companies.length === 1 ? companies[0] : '',
    role: chosen ? clean(chosen.app.role, 256) : roles.length === 1 ? roles[0] : '',
    evidence,
  };
}

const RULES = [
  { signal: 'rejection', status: 'rejected', hard: true, patterns: [
    /\bwe (?:have )?(?:decided|chosen) (?:not to (?:proceed|move forward)|to (?:move forward|proceed) with (?:another|other) candidates?)\b/i,
    /\bwe (?:will|are) not (?:be )?(?:moving|move|proceeding|proceed) (?:forward )?with your (?:application|candidacy)\b/i,
    /\byour (?:application|candidacy) (?:was |is |has been )?(?:unsuccessful|not successful|not selected|rejected)\b/i,
    /\b(?:unfortunately|we regret)[^.?!\n]{0,100}(?:not (?:be )?(?:moving|proceeding) (?:forward )?with your (?:application|candidacy)|you (?:were|have) not (?:been )?selected|selected another candidate|position has been filled)\b/i,
    /\bwe (?:are (?:unable|not able) to|cannot|can't|will not|won't) offer you (?:the |a |an )?(?:position|role|job|employment)\b/i,
    /\b(?:unfortunately|we regret)[^.?!\n]{0,60}(?:the|this|your) (?:role|position|application) (?:has (?:now |already )?been|is(?: now)?|was(?: recently)?) (?:closed|withdrawn|cancelled|canceled)\b/i,
    /\bwe have (?:now )?(?:closed|withdrawn|cancelled|canceled) (?:the|this|your) (?:role|position|application)\b/i,
    /(?:很遗憾|非常遗憾|遗憾地?通知)[^。！？\n]{0,100}(?:未能|无法|没有|不再|不符合|不匹配|不合适|其他候选人)/u,
    /(?:您|你)的(?:申请|应聘|简历)[^。！？\n]{0,40}(?:未通过|未被选中|未能进入|未能通过|暂不匹配|不符合)/u,
    /(?:很遗憾|非常遗憾|遗憾地?通知|我司|我们)[^。！？\n]{0,35}(?:该|此|本|您应聘的|您申请的)?(?:岗位|职位)(?:已(?:经)?|现已)?(?:关闭|取消|撤销|停止招聘)/u,
  ] },
  { signal: 'offer', status: 'offer', hard: true, patterns: [
    /\bwe (?:are (?:pleased|delighted|excited) to |would like to )?offer you (?:the |a |an )?(?:position|role|job|employment)\b/i,
    /\bwe (?:are (?:pleased|delighted|excited) to |would like to )extend (?:you )?an offer of employment\b/i,
    /\byour (?:formal |written |employment |job )?offer (?:letter|of employment) (?:is |has been )?(?:attached|ready|available|approved)\b/i,
    /\bplease (?:review|sign|accept) (?:your|the) (?:attached )?(?:employment|job) offer\b/i,
    /(?:向您|向你)(?:正式)?(?:发出|发送|提供)[^。！？\n]{0,20}(?:录用通知|聘用通知|入职\s*offer)/iu,
    /(?:您|你)(?:已|已经)?(?:被我司录用|被正式录用|获得[^。！？\n]{0,20}录用通知)/u,
    /(?:录用通知书|聘用通知书)(?:已发送|已随信附上|见附件|已附)/u,
  ] },
  { signal: 'interview_invite', status: 'interview', hard: true, patterns: [
    /\byour (?:technical |phone |video |final )?interview (?:has been |is )?(?:scheduled|confirmed|booked)\b/i,
    /(?:您|你)的(?:首轮|第[一二三四五六七八九十\d]+轮|技术|视频|电话|最终)?面试(?:将于|定于|已(?:经)?(?:安排|确认)|是)/u,
  ] },
  { signal: 'interview_invite', status: 'interview', hard: false, patterns: [
    /\bwe (?:(?:would|'d) like to |are (?:pleased|excited) to )?invite you (?:to|for) (?:an? |the )?(?:(?:technical|first|second|final|initial|phone|video|onsite|on-site|panel) )?interview\b/i,
    /\b(?:we (?:would like to|want to)|please) (?:schedule|arrange|book) (?:an? |your |the )?(?:(?:technical|phone|video|final) )?interview\b/i,
    /\b(?:are|would) you (?:be )?available (?:for|to attend) (?:an? |the )?(?:(?:technical|first|second|final|initial|phone|video|onsite|on-site|panel) )?interview\b/i,
    /\bplease (?:share|send|confirm) (?:your )?availability (?:for|to schedule) (?:an? |the )?(?:technical |phone |video )?interview\b/i,
    /(?:邀请|邀)(?:您|你)(?:参加|进行)?(?:第[一二三四五六七八九十\d]+轮|首轮|线上|线下|现场|视频|电话|技术|AI|微信小程序|远程|最终|一轮|二轮|的|\s){0,3}面试/iu,
    /(?:请|麻烦)(?:您|你)?(?:确认|提供|回复)[^。！？\n]{0,20}面试(?:时间|安排)/u,
  ] },
  { signal: 'assessment', status: 'responded', hard: false, patterns: [
    /\b(?:please|we (?:ask|invite) you to) (?:complete|take|submit|finish) (?:your |the |an? )?(?:(?:technical|online|coding|skills?|take-home|pre-employment) )?(?:assessment|test|exercise|assignment)\b/i,
    /\byour (?:coding|technical|skills) assessment (?:is|has been) (?:ready|assigned)\b/i,
    /(?:请|邀请)(?:您|你)?(?:在[^。！？\n]{1,30}前)?(?:完成|参加|提交)(?:本次|以下|线上|在线|技术|编程|能力|岗位|招聘|入职|您的?){0,3}(?:测评|笔试|编程测试|技术测试)/u,
  ] },
  { signal: 'action_required', status: 'responded', hard: false, patterns: [
    /\bplease (?:provide|send|submit|upload|update|confirm) (?:us with )?(?:your |an? |the )?(?:updated |current |latest |missing |additional )?(?:resume|cv|portfolio|application (?:details|information)|work authorization|availability)\b/i,
    /\bcould you (?:please )?(?:provide|send|submit|upload|confirm) (?:your |an? |the )?(?:updated |current |latest |additional )?(?:resume|cv|portfolio|application (?:details|information)|work authorization|availability)\b/i,
    /(?:请|邀请|麻烦)(?:您|你)[^。！？\n]{0,30}(?:更新|补充|提供|提交)[^。！？\n]{0,12}(?:应聘信息|申请信息|简历|作品集|工作许可)/u,
  ] },
];

const MARKETING = /\b(?:job alerts?|recommended jobs?|jobs for you|invitation to apply|invite you to apply|apply now|newsletter|webinar|interview (?:tips|prep|coaching|practice|training|workshop|course))\b|邀请投递|抢面试先机|立即投递|热门职位|职位推荐|推荐职位|热招职位|招聘快讯|求职技巧|面试技巧|求职课程/u;
const PRIOR_PROGRESSION = /\b(?:review(?:ed|ing)|consider(?:ed|ing)) your (?:application|resume|cv)\b|\byour (?:application|resume|cv) (?:has )?(?:passed|progressed)\b|(?:您|你)的(?:申请|简历)(?:已(?:经)?)?通过/iu;
const RECRUITMENT_CONTEXT = /\b(?:application|candidacy|recruiting|hiring|position|role|job|interview|candidate|coding|technical)\b|招聘|应聘|申请|简历|面试|笔试|入职|编程/iu;
const CONDITIONAL = /\b(?:if|unless)\b|\b(?:after|once|when) you (?:apply|submit|register)\b|\bupon (?:application|registration)\b|如果|假如|若是|如若|(?:投递|报名|申请|简历通过|申请通过|筛选通过|通过筛选)(?:之)?后/iu;

function intentMatches(text) {
  const matches = [];
  for (const rule of RULES) {
    for (const pattern of rule.patterns) {
      // Allow ordinary repeated/NBSP spacing without rewriting the source:
      // the returned quote must be an exact substring for the proposal bridge.
      const match = new RegExp(pattern.source.replace(/ /g, '[ \\u00a0]+'), pattern.flags).exec(text);
      if (!match) continue;
      const before = text.slice(0, match.index).split(/[.!?。！？\n]/).at(-1);
      const after = text.slice(match.index + match[0].length).split(/[.!?。！？\n]/)[0];
      if (/(?:\b(?:cannot|can't|unable to|not able to|not|won't|do not|don't|without)|不(?:会|能|再|可)|无法|未能|暂不|并非|并未|不要)\s*$/iu.test(before)) continue;
      if (CONDITIONAL.test(`${before}${match[0]}${after}`)) continue;
      if (rule.signal === 'interview_invite' && /^\s*(?:(?:webinar|workshop|course|coaching|preparation|practice|training|tips)\b|技巧|课程|培训)/iu.test(after)) continue;
      matches.push({ ...rule, quote: match[0] });
      break;
    }
  }
  return matches;
}

/**
 * Return a review candidate or null using only Gmail metadata and optional
 * normalized tracker context. There is deliberately no status mutation here.
 */
export function classifyMessage(message, applications = []) {
  if (!message || typeof message !== 'object' || typeof message.id !== 'string' || !/^[a-zA-Z0-9_-]{1,256}$/.test(message.id)) return null;
  if (typeof message.threadId !== 'string' || !/^[a-zA-Z0-9_-]{1,256}$/.test(message.threadId)) return null;
  const timestamp = typeof message.internalDate === 'string' && /^\d{1,16}$/.test(message.internalDate)
    ? Number(message.internalDate) : typeof message.internalDate === 'number' ? message.internalDate : NaN;
  if (!Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp > 8640000000000000) return null;
  const headers = (Array.isArray(message.payload?.headers) ? message.payload.headers : [])
    .filter(header => header && typeof header.name === 'string' && typeof header.value === 'string');
  const fromHeaders = headers.filter(header => header.name.toLowerCase() === 'from');
  const subjects = headers.filter(header => header.name.toLowerCase() === 'subject');
  if (fromHeaders.length !== 1 || subjects.length > 1 || fromHeaders[0].value.length > 320) return null;
  const from = fromHeaders[0].value;
  if (CONTROLS.test(from)) return null;
  const sender = mailbox(from);
  if (!sender || !authenticated(headers, sender.domain)) return null;
  // Keep the original bytes within the metadata limits. Display/proposal
  // consumers need verbatim evidence; control-bearing text is rejected rather
  // than silently altered into a different claim.
  const subject = (subjects[0]?.value || '').slice(0, MAX_SUBJECT);
  const body = typeof message.snippet === 'string' ? message.snippet.slice(0, MAX_SNIPPET) : '';
  if (CONTROLS.test(subject) || CONTROLS.test(body)) return null;
  const text = `${subject}\n${body}`;
  const matching = matchApplication(text, sender, applications);
  // Never manufacture a quote by joining the end of a header to the snippet.
  const intents = [...intentMatches(subject), ...intentMatches(body)].filter(intent => {
    if (MARKETING.test(text.toLowerCase()) && !intent.hard && !PRIOR_PROGRESSION.test(text)) return false;
    if ((intent.signal === 'assessment' || intent.signal === 'action_required') && !matching.row && !RECRUITMENT_CONTEXT.test(text)) return false;
    return true;
  });
  if (!intents.length) return null;
  const statuses = new Set(intents.map(item => item.status));
  // A requested assessment or document can be a prerequisite for an already
  // confirmed interview or offer. Keep the furthest explicit positive stage;
  // a rejection alongside any positive progression still needs human review.
  const positiveStage = { responded: 1, interview: 2, offer: 3 };
  const intent = intents.reduce((best, item) =>
    (positiveStage[item.status] || 0) > (positiveStage[best.status] || 0) ? item : best);
  const conflict = statuses.has('rejected') && statuses.size > 1;
  const confidence = conflict || matching.ambiguous ? 'low'
    : matching.row && matching.row.score >= 5 ? 'high' : 'medium';
  // Proposal consumers select the first valid quote. Put the recommended
  // stage's own evidence first, retaining lower-stage requests for review.
  const evidence = [...new Set([intent.quote, ...intents.map(item => item.quote)])];
  const matchEvidence = [`Authentication: Gmail DMARC passed for ${sender.domain}`, ...matching.evidence];
  if (conflict) matchEvidence.push('Conflicting progression signals; no status recommendation.');
  return {
    message_id: message.id,
    thread_id: message.threadId,
    received_at: new Date(timestamp).toISOString(),
    from,
    subject,
    body_snippet: body,
    company_hint: matching.company,
    role_hint: matching.role,
    matched_application: matching.row?.app.num ?? null,
    signal: intent.signal,
    confidence,
    evidence,
    match_evidence: matchEvidence,
    suggested_status: conflict ? null : intent.status,
  };
}
