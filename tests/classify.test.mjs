import assert from 'node:assert';
import { classifyMessage } from '../lib/classify.mjs';

const tests = [];
function test(name, run) { tests.push({ name, run }); }
const AUTH = 'mx.google.com; dkim=pass header.i=@acme.example; spf=pass; dmarc=pass (p=NONE sp=NONE dis=NONE) header.from=acme.example';
function mail(subject = 'Acme — Backend Engineer', snippet = 'We would like to invite you to an interview.', extra = {}) {
  return {
    id: 'message-1', threadId: 'thread-1', internalDate: '1790748000000', snippet,
    payload: { headers: [
      { name: 'From', value: 'Acme Recruiting <recruiter@acme.example>' },
      { name: 'Subject', value: subject },
      { name: 'Authentication-Results', value: AUTH },
    ] }, ...extra,
  };
}
const APPS = [{ num: 11, company: 'Acme', role: 'Backend Engineer', status: 'applied', recruiter_domains: ['acme.example'] }];
function withAuth(value, message = mail()) {
  message.payload.headers = message.payload.headers.filter(header => header.name !== 'Authentication-Results');
  if (value !== null) message.payload.headers.push({ name: 'Authentication-Results', value });
  return message;
}
function fromSender(message, address, domain) {
  message.payload.headers[0].value = address;
  return withAuth(`mx.google.com; dmarc=pass header.from=${domain}`, message);
}

test('normalizes an authenticated interview into a review candidate', () => {
  const candidate = classifyMessage(mail(), APPS);
  assert.equal(candidate.signal, 'interview_invite');
  assert.equal(candidate.suggested_status, 'interview');
  assert.equal(candidate.matched_application, 11);
  assert.equal(candidate.confidence, 'high');
  assert.equal(candidate.company_hint, 'Acme');
  assert.equal(candidate.role_hint, 'Backend Engineer');
  assert.equal(candidate.received_at, new Date(1790748000000).toISOString());
  assert.ok(candidate.evidence.includes('We would like to invite you to an interview'));
  assert.ok(candidate.match_evidence.some(value => value.startsWith('Authentication: ')));
});

test('requires aligned, boundary-safe Gmail DMARC results', () => {
  for (const auth of [null, '', 'sender.example; dmarc=pass header.from=acme.example',
    'mx.google.com.evil.example; dmarc=pass header.from=acme.example',
    'evil-mx.google.com; dmarc=pass header.from=acme.example',
    'mx.google.com; dmarc=passenger header.from=acme.example',
    'mx.google.com; dmarc=pass header.from=acme.example.evil.example',
    'mx.google.com; dmarc=pass header.from=evil-acme.example',
    'mx.google.com; dmarc=pass',
    'mx.google.com; spf=pass; dkim=pass',
    'mx.google.com; dmarc=pass header.from=acme.example; dmarc=fail header.from=acme.example',
    'mx.google.com; dmarc=fail header.from=acme.example',
    'mx.google.com; spf=fail; dmarc=pass header.from=acme.example',
    'mx.google.com; dkim=permerror; dmarc=pass header.from=acme.example',
    'mx.google.com; (dmarc=pass header.from=acme.example)',
    'mx.google.com; dmarc=pass (unclosed header.from=acme.example',
  ]) assert.equal(classifyMessage(withAuth(auth), APPS), null, String(auth));
});

test('ignores forged third-party and ARC assertions, and rejects trusted conflicts', () => {
  const message = withAuth(null);
  message.payload.headers.push({ name: 'ARC-Authentication-Results', value: `i=1; ${AUTH}` });
  assert.equal(classifyMessage(message, APPS), null);
  message.payload.headers.push({ name: 'Authentication-Results', value: AUTH });
  message.payload.headers.push({ name: 'Authentication-Results', value: 'sender.example; dmarc=fail header.from=acme.example' });
  assert.ok(classifyMessage(message, APPS));
  message.payload.headers.push({ name: 'Authentication-Results', value: 'mx.google.com; dmarc=fail header.from=acme.example' });
  assert.equal(classifyMessage(message, APPS), null);
});

test('accepts folded, mixed-case Gmail results and nested result comments', () => {
  assert.ok(classifyMessage(withAuth('MX.GOOGLE.COM;\r\n dmarc=PASS (policy (nested note)) header.from=ACME.EXAMPLE'), APPS));
});

test('rejects malformed and duplicate sender identities', () => {
  for (const from of ['a@acme.example, b@acme.example', 'a@acme.example <b@acme.example>',
    'a@acme..example', '.a@acme.example', 'a..b@acme.example', '<a@acme.example> <b@acme.example>']) {
    const message = mail(); message.payload.headers[0].value = from;
    assert.equal(classifyMessage(message, APPS), null, from);
  }
  const message = mail(); message.payload.headers.push({ name: 'from', value: 'other@acme.example' });
  assert.equal(classifyMessage(message, APPS), null);
  const quoted = mail(); quoted.payload.headers[0].value = '"Doe, Jane" <jane@acme.example>';
  assert.ok(classifyMessage(quoted, APPS));
});

test('classifies clear English and Chinese progression with source quotes', () => {
  const cases = [
    ['Application update', 'Your application was unsuccessful.', 'rejection', 'rejected'],
    ['Application update', 'We have decided to move forward with another candidate.', 'rejection', 'rejected'],
    ['应聘结果', '很遗憾地通知您，您的简历与岗位需求暂不匹配，未能进入下一轮。', 'rejection', 'rejected'],
    ['Acme offer', 'We are pleased to offer you the position of Backend Engineer.', 'offer', 'offer'],
    ['录用通知', '我们向您正式发出录用通知，请查收。', 'offer', 'offer'],
    ['恭喜简历通过，Acme邀您面试', '您的首轮面试是AI微信小程序面试，时长约15分钟。', 'interview_invite', 'interview'],
    ['面试安排', '我们邀请您参加技术面试。', 'interview_invite', 'interview'],
    ['Acme — Backend Engineer', 'Please complete your coding assessment by Friday.', 'assessment', 'responded'],
    ['招聘测评', '请您完成在线测评。', 'assessment', 'responded'],
    ['Acme application', 'Please send your updated resume.', 'action_required', 'responded'],
    ['补充信息', '邀请您在面试/入职之前更新或补充最新的应聘信息。', 'action_required', 'responded'],
  ];
  for (const [subject, snippet, signal, status] of cases) {
    const candidate = classifyMessage(mail(subject, snippet), APPS);
    assert.ok(candidate, `${subject}: ${snippet}`);
    assert.equal(candidate.signal, signal, snippet);
    assert.equal(candidate.suggested_status, status, snippet);
    assert.ok(candidate.evidence.length > 0);
    for (const quote of candidate.evidence) assert.ok(subject.includes(quote) || snippet.includes(quote), quote);
  }
});

test('does not classify isolated words, generic assessments, or negated invitations', () => {
  for (const text of ['Interview', 'Offer', 'Assessment', 'A list of interview questions.',
    'Please complete your health assessment.', 'Please confirm your availability.',
    'Unfortunately, we are not moving this summer.',
    'We cannot invite you to an interview.', 'We do not offer you the position.',
    'If selected, we invite you to an interview.', '我们无法邀请您参加技术面试。',
    '如果通过筛选，我们邀请您面试。', '我们邀请您参加面试培训。']) {
    assert.equal(classifyMessage(mail('Update', text)), null, text);
  }
});

test('ignores alerts, application solicitation and interview event marketing', () => {
  for (const text of [
    '我们为您推荐了以下职位：邀请投递测试工程师岗位，现在沟通，抢面试先机！',
    '立即投递！我们邀请您参加技术面试。',
    'Recommended jobs: we invite you to an interview. Apply now.',
    'We invite you to an interview webinar.',
    '面试技巧课程：邀请您参加面试培训。',
    'Job alert: Please complete your coding assessment to find recommended jobs.',
  ]) assert.equal(classifyMessage(mail('Job alert', text), APPS), null, text);
});

test('does not turn conditional promises into personalized progression', () => {
  for (const [subject, snippet] of [
    ['Job alert', 'If you apply, your interview is confirmed for Tuesday.'],
    ['Job alert', 'Your interview is confirmed if you apply now.'],
    ['Apply now', 'After you apply, we are pleased to offer you the position.'],
    ['Job alert', 'We offer you the job once you register.'],
    ['职位推荐', '如果投递，您的面试将于周五进行。'],
    ['立即投递', '您的面试将于报名后安排。'],
    ['招聘快讯', '您的简历通过后，邀请您面试。'],
    ['招聘快讯', '申请通过后，我们向您正式发出录用通知。'],
  ]) assert.equal(classifyMessage(mail(subject, snippet), APPS), null, snippet);
});

test('returns only verbatim evidence and preserves original spacing', () => {
  for (const [subject, snippet] of [
    ['Acme — Backend Engineer', '  We  would like to invite you to an interview.  '],
    ['Your\u00a0interview is confirmed', 'Acme Backend Engineer'],
    ['面试安排', '您的首轮面试是 AI 微信小程序面试。'],
    ['  Your interview is confirmed  ', '  Please confirm your availability for the interview.  '],
  ]) {
    const candidate = classifyMessage(mail(subject, snippet), APPS);
    assert.ok(candidate, snippet);
    assert.equal(candidate.subject, subject);
    assert.equal(candidate.body_snippet, snippet);
    for (const quote of candidate.evidence) assert.ok(subject.includes(quote) || snippet.includes(quote), quote);
    assert.ok(candidate.evidence.every(quote => !quote.startsWith('Authentication:')));
  }
  assert.equal(classifyMessage(mail('We would like to invite you to', 'an interview.'), APPS), null);
});

test('rejects control-bearing source text instead of changing its evidence', () => {
  for (const control of ['\u001b', '\n', '\r', '\t', '\u0000', '\u061c', '\u200e', '\u202e', '\u2066']) {
    assert.equal(classifyMessage(mail(`Interview${control} update`), APPS), null);
    assert.equal(classifyMessage(mail('Acme', `Your interview is${control}confirmed.`), APPS), null);
    const message = mail(); message.payload.headers[0].value = `Recruiter${control} <recruiter@acme.example>`;
    assert.equal(classifyMessage(message, APPS), null);
  }
});

test('keeps unequivocal personal progression despite incidental alert text', () => {
  const scheduled = classifyMessage(mail('Your interview', 'Your interview is confirmed for Tuesday. You can manage job alerts in your account.'), APPS);
  assert.equal(scheduled.signal, 'interview_invite');
  const reviewed = classifyMessage(mail('Acme application', 'After reviewing your application, we invite you to an interview. Manage recommended jobs in your account.'), APPS);
  assert.equal(reviewed.signal, 'interview_invite');
});

test('uses bounded full names and does not infer from similar names', () => {
  const applications = [{ num: 1, company: 'HP', role: 'Engineer' }, { num: 2, company: 'Acme', role: 'Backend Engineer' }, { num: 3, company: '?', role: 'Engineer' }];
  for (const subject of ['PHP Engineer', 'Acmeology Backend Engineer', 'Would you join us? Engineer']) {
    assert.equal(classifyMessage(mail(subject), applications).matched_application, null, subject);
  }
  assert.equal(classifyMessage(mail('HP Engineer'), applications).matched_application, 1);
  assert.equal(classifyMessage(mail('Acme Backend Engineer'), applications).matched_application, 2);
  assert.equal(classifyMessage(mail('Acme Backend Engineers'), applications).matched_application, null);
  assert.equal(classifyMessage(mail('我们是腾讯招聘团队，招聘后端工程师'), [{ num: 4, company: '腾讯', role: '后端工程师' }]).matched_application, 4);
});

test('requires employer evidence in addition to a role and corroborates company names', () => {
  assert.equal(classifyMessage(mail('Backend Engineer'), [{ num: 1, company: 'Different Corp', role: 'Backend Engineer' }]).matched_application, null);
  assert.equal(classifyMessage(mail('Acme'), [{ num: 1, company: 'Acme', role: 'Backend Engineer' }]).matched_application, null);
});

test('does not choose among same-company roles without distinguishing evidence', () => {
  const applications = [...APPS, { ...APPS[0], num: 12, role: 'Frontend Engineer' }];
  const ambiguous = classifyMessage(mail('Acme application'), applications);
  assert.equal(ambiguous.matched_application, null);
  assert.equal(ambiguous.confidence, 'low');
  assert.equal(ambiguous.company_hint, 'Acme');
  assert.ok(ambiguous.match_evidence.some(value => value.includes('Multiple tracker applications')));
  assert.equal(classifyMessage(mail(), applications).matched_application, 11);
  assert.equal(classifyMessage(mail('Acme Frontend Engineer'), applications).matched_application, 12);
  const uneven = [{ ...applications[0], recruiter_emails: ['recruiter@acme.example'] }, { ...applications[1], recruiter_domains: [] }];
  assert.equal(classifyMessage(mail('Acme application'), uneven).matched_application, null);
  assert.equal(classifyMessage(mail('Acme Frontend Engineer'), uneven).matched_application, 12);
  assert.equal(classifyMessage(mail(), [...applications, { ...applications[0], num: 13 }]).matched_application, null);
});

test('uses explicit recruiter addresses and employer domains with safe boundaries', () => {
  const message = mail('Application update');
  assert.equal(classifyMessage(message, [{ num: 1, company: 'Acme', role: 'Engineer', recruiter_emails: ['recruiter@acme.example'] }]).matched_application, 1);
  assert.equal(classifyMessage(message, [{ num: 1, company: 'Acme', role: 'Engineer', recruiter_domains: ['acme.example'] }]).matched_application, 1);
  assert.equal(classifyMessage(message, [{ num: 1, company: 'Acme', role: 'Engineer', url: 'https://acme.example/careers' }]).matched_application, null);
  assert.equal(classifyMessage(message, [{ num: 1, company: 'Acme', role: 'Engineer', recruiter_domains: ['example'] }]).matched_application, null);
  const lookalike = fromSender(mail('Update'), 'hr@acme.example.evil.example', 'acme.example.evil.example');
  assert.equal(classifyMessage(lookalike, APPS).matched_application, null);
});

test('shared ATS and public mailbox domains never identify the employer by themselves', () => {
  for (const domain of ['greenhouse.io', 'mail.greenhouse.io', 'gmail.com', 'myworkdayjobs.com', 'zhaopin.com']) {
    const message = fromSender(mail('Application update'), `hr@${domain}`, domain);
    const app = { num: 1, company: 'Acme', role: 'Engineer', recruiter_domains: [domain], url: `https://${domain}/acme` };
    assert.equal(classifyMessage(message, [app]).matched_application, null, domain);
    assert.equal(classifyMessage(message, [{ ...app, recruiter_emails: [`hr@${domain}`] }]).matched_application, 1, domain);
  }
  const unknownAts = fromSender(mail('Application update'), 'hr@new-ats.example', 'new-ats.example');
  assert.equal(classifyMessage(unknownAts, [{ num: 1, company: 'Acme', role: 'Engineer', url: 'https://new-ats.example/acme/job' }]).matched_application, null);
});

test('retains conflicting signals for review without recommending a state', () => {
  const candidate = classifyMessage(mail('Application update', 'Your interview is confirmed. Unfortunately, we are not proceeding with your application.'), APPS);
  assert.equal(candidate.confidence, 'low');
  assert.equal(candidate.suggested_status, null);
  assert.ok(candidate.match_evidence.some(value => value.includes('Conflicting progression signals')));
});

test('keeps an explicit positive stage when lower-stage tasks are prerequisites', () => {
  for (const [subject, snippet, status, signal, leadingEvidence] of [
    ['Acme Backend Engineer', 'Your interview is confirmed for Tuesday. Please complete your online assessment beforehand.', 'interview', 'interview_invite', 'Your interview is confirmed'],
    ['Please complete your coding assessment', 'Your interview is confirmed for Tuesday.', 'interview', 'interview_invite', 'Your interview is confirmed'],
    ['Please send your updated resume', 'Your employment offer letter is attached.', 'offer', 'offer', 'Your employment offer letter is attached'],
    ['Acme Backend Engineer', 'Your interview is confirmed. Your employment offer letter is attached.', 'offer', 'offer', 'Your employment offer letter is attached'],
    ['Acme Backend Engineer', '您的面试已确认，请您完成在线测评。', 'interview', 'interview_invite', '您的面试已确认'],
  ]) {
    const candidate = classifyMessage(mail(subject, snippet), APPS);
    assert.equal(candidate.suggested_status, status, snippet);
    assert.equal(candidate.signal, signal, snippet);
    assert.equal(candidate.evidence[0], leadingEvidence, snippet);
    assert.ok(candidate.evidence.length >= 2);
    assert.notEqual(candidate.confidence, 'low');
    assert.ok(candidate.evidence.every(quote => subject.includes(quote) || snippet.includes(quote)));
  }
});

test('recognizes explicit inability to offer a job and employer closure of a role', () => {
  for (const snippet of [
    'Unfortunately, we are unable to offer you the position.',
    'We cannot offer you the role.',
    'Unfortunately, the role has now been closed.',
    'We regret to inform you that this position has been withdrawn.',
    'We have closed your application.',
    'We have now withdrawn the position.',
    '很遗憾地通知您，该岗位已关闭。',
    '我司该职位已停止招聘。',
  ]) {
    const candidate = classifyMessage(mail('Acme Backend Engineer', snippet), APPS);
    assert.ok(candidate, snippet);
    assert.equal(candidate.signal, 'rejection', snippet);
    assert.equal(candidate.suggested_status, 'rejected', snippet);
    assert.ok(candidate.evidence.every(quote => snippet.includes(quote)));
  }
});

test('never recommends advancement when an invitation or offer contradicts a rejection', () => {
  for (const snippet of [
    'We would like to invite you to an interview. Unfortunately, the role has now been closed.',
    'Your employment offer letter is attached. Unfortunately, we are unable to offer you the position.',
    'Your interview is confirmed. We have now withdrawn the position.',
    '我们邀请您面试。很遗憾，该岗位已关闭。',
  ]) {
    const candidate = classifyMessage(mail('Acme Backend Engineer', snippet), APPS);
    assert.equal(candidate.suggested_status, null, snippet);
    assert.equal(candidate.confidence, 'low', snippet);
    assert.ok(candidate.evidence.length >= 2);
    assert.ok(candidate.evidence.every(quote => snippet.includes(quote)));
  }
});

test('does not mistake generic cancellations or unrelated offers for rejection', () => {
  for (const snippet of [
    'Unfortunately, your appointment has now been canceled.',
    'We have canceled your interview.',
    'Unfortunately, the meeting has now been closed.',
    'The application window is closed.',
    'We cannot offer you a discount.',
    'If the role has been closed, we cannot offer you the position.',
    '我司会议已取消。',
    '如果该岗位已关闭，我们将联系您。',
  ]) assert.equal(classifyMessage(mail('Acme Backend Engineer', snippet), APPS), null, snippet);
});

test('quoted old replies cannot resolve conflicting current progression', () => {
  for (const snippet of [
    'Your application was unsuccessful. On Monday, recruiting wrote: "Your interview is confirmed."',
    '很遗憾地通知您，您的申请未能通过。原始邮件：“您的面试已确认，请准时参加。”',
  ]) {
    const candidate = classifyMessage(mail('Application update', snippet), APPS);
    assert.equal(candidate.confidence, 'low');
    assert.equal(candidate.suggested_status, null);
    assert.ok(candidate.evidence.length >= 2);
    assert.ok(candidate.evidence.every(quote => snippet.includes(quote)));
  }
});

test('validates metadata, bounds retained text, and leaves inputs untouched', () => {
  for (const invalid of [null, {}, mail('', '', { id: '' }), mail('', '', { id: 123 }), mail('', '', { threadId: '' }), mail('', '', { threadId: 123 }),
    mail('', '', { internalDate: 'bad' }), mail('', '', { internalDate: Infinity }), mail('', '', { internalDate: -1 })]) {
    assert.equal(classifyMessage(invalid, APPS), null);
  }
  const message = mail('Acme — Backend Engineer', `Your interview is confirmed. ${'x'.repeat(3000)}\u001b[31m`);
  const copy = JSON.stringify({ message, APPS });
  const candidate = classifyMessage(message, APPS);
  assert.ok(candidate.body_snippet.length <= 2048);
  assert.equal(JSON.stringify({ message, APPS }), copy);
  assert.equal(classifyMessage(message, null).matched_application, null);
});

let failed = 0;
for (const { name, run } of tests) {
  try { run(); console.log(`PASS ${name}`); }
  catch (error) { failed++; console.error(`FAIL ${name}\n${error.stack}`); }
}
if (failed) process.exitCode = 1;
else console.log(`Classifier: ${tests.length} tests passed.`);
