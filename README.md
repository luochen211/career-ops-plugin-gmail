# career-ops-plugin-gmail

Opt-in Gmail job leads and employer-reply review for career-ops, maintained by
[@luochen211](https://github.com/luochen211). Default job-lead ingestion stays
compatible with the bundled Gmail seed. Explicit `mode: replies` adds English
and Chinese interview, assessment, action-required, rejection and offer signals.

**Draft, awaiting maintainer agreement.** This implements the plugin part of
[#1583](https://github.com/career-ops-hq/career-ops/issues/1583) against the draft
core proposal reader in [#3333](https://github.com/career-ops-hq/career-ops/issues/3333).
The core reader must land first. No registry entry or npm release is published;
this repository does not replace the bundled plugin. A later approved registry
entry would use the same `gmail` ID and `supersedesBundled: true`.

## Try the offline fixtures

Node.js 22 or newer; no dependencies, credentials or network access required:

```sh
npm test
node examples/mock-replies.mjs
```

The demo reads synthetic English/Chinese messages, prints normalized candidates
as JSON and ignores the marketing examples. It creates no files. To check the
draft producer/reader contract with synthetic data in a disposable directory:

```sh
node test/core-bridge.mjs /path/to/draft-core
```

## Modes and future configuration

Both modes use the existing `ingest` hook; there is no new hook. `leads` is the
default: `label` defaults to `Job Leads`, `days_back` to `7`, and the plugin returns
`Job[]` for the host's normal pipeline writer. That inherited mode reads full
message bodies to extract job URLs and uses `data/gmail-state.json` in the run
directory. The metadata-only behavior below applies to `replies`.

Reply mode returns an empty job array, displays review candidates, and writes
only eligible status proposals for the draft core reader. It never writes the
application tracker, sends email, or marks, moves or deletes messages. A core
checkout without the draft reader fails before OAuth or local writes.

After core acceptance and registry approval, install the approved successor
through career-ops and review its capability card before enabling it. These are
the intended local `config/plugins.yml` settings, not an installation bypass:

```yaml
plugins:
  gmail:
    enabled: true                   # only after reviewing the capability card
    mode: replies
    career_ops_root: /absolute/path/to/career-ops
    reply_days_back: 30
    reply_label: Application Replies  # optional
    # reply_query: 'from:employer.example.test'  # optional custom Gmail query
    reply_contacts:
      "7":                           # tracker row number, not report number
        recruiter_emails: [hiring@employer.example.test]
        recruiter_domains: [employer.example.test]
```

`career_ops_root` selects the career-ops source checkout; set it explicitly when
running from another directory. Shared core path readers resolve the data root
(`CAREER_OPS_ROOT`, `CAREER_OPS_DATA_DIR`, marker, then repository default) and
the `CAREER_OPS_TRACKER` override. The plugin reads tracker rows and canonical
states through those core modules; it does not guess another tracker location.

The default query searches the last 30 days (valid range 1–365), combining
English/Chinese signal terms **or** minimal company, role and recruiter contact
phrases. Only those bounded search phrases are sent to Gmail, not the tracker
file or CV. Tracker text cannot supply Gmail operators. A configured
`reply_query` replaces the default terms while retaining the lookback and optional
label. Queries are capped at 2,048 characters. Shared ATS and consumer email
domains alone do not establish an application match.

Only once the successor is approved, installed and explicitly enabled in
career-ops, run the normal commands from that career-ops checkout:

```sh
node plugins.mjs run gmail --dry-run
node plugins.mjs run gmail
node reply-watch.mjs
```

Dry run still reads Gmail, but creates no proposals, cursors, directories or
locks. The final command is the core's separate human review step; the plugin
never calls the tracker writer or approves a transition.

## Gmail access

Provision OAuth manually using a Google Cloud project with the Gmail API and a
Desktop OAuth client. Complete Google's consent flow yourself with exactly
`https://www.googleapis.com/auth/gmail.readonly` and offline access, then keep the
client ID, client secret and refresh token in the host's local, ignored `.env`
under `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN`. Do not place
credentials in plugin settings or fixtures. This repository has no interactive
authorization command and its tests never use live credentials.

Reply mode requests the read-only scope on refresh and rejects a returned scope
that differs. Google can omit `scope` from a refresh response; acceptance then
assumes the refresh token was originally provisioned with that scope alone.
Network calls go through the host's allowlisted `ctx.fetch`. Redirect enforcement
belongs to that host; the transport also rejects reported redirects or changed
response URLs. Errors contain safe codes and HTTP status, never provider bodies
or credentials.

Reply scans read `/profile?fields=emailAddress` only to identify the authorized
mailbox. The trimmed, lowercased address is SHA-256 hashed for account identity;
the raw account address is not persisted. Message lists request IDs and thread
IDs. Detail requests use `format=metadata`, with
`id,threadId,internalDate,snippet,payload(headers)` and only `From`, `Subject`,
`Date`, `Authentication-Results`. Reply mode fetches no body or attachment.

## Candidates, evidence and progress

Normalized candidate output contains message/thread IDs, received time, sender,
subject, snippet, company/role hints, matched tracker row (or `null`), signal,
suggested canonical status, and `low`/`medium`/`high` confidence. `evidence` holds
exact excerpts from the retained subject or snippet. `match_evidence` separately
explains authentication and application matching; it is not a quoted email claim.
Opposing outcomes remove the suggested status; an interview with a prerequisite
assessment still suggests Interview. Confidence is a deterministic
rule result, not a probability or permission to change the tracker.

Classification requires a valid single sender and aligned `dmarc=pass` in Gmail's
`mx.google.com` Authentication-Results. Missing, conflicting or failed checks
are skipped. The classifier uses at most 512 subject characters and 2,048 snippet
characters, rejects control-bearing text, and ignores generic marketing or
invitations to apply. Truncated snippets, missing authentication and unfamiliar
phrasing can therefore miss genuine replies; review Gmail normally as well.

Reply files live under the resolved data root:

| Path | Purpose |
| --- | --- |
| `data/gmail-replies/<account-hash>.json` | Processed immutable message IDs for that mailbox |
| `data/gmail-replies/<account-hash>.json.lock` | One active scan per account |
| `data/reply-proposals/gmail-<source-hash>.json` | Draft core proposal with exact tracker identity, canonical states and one evidence excerpt |

New directories use mode `0700` and files `0600`. Proposal contents remain local
user data. The plugin atomically publishes a proposal before checkpointing its
message ID; repeated messages and account namespaces are deduplicated. Detail
fetch failures remain retryable, publication failures stop the scan without
consuming that message, and completed messages retain their checkpoints.
Corrupt cursors stop processing rather than erase history. A leftover lock
requires checking that no scan is active before manually removing it.

Successfully inspected messages, including ignored or unmatched replies, are
checkpointed; changing contact hints does not replay them. Unmatched, ambiguous,
unchanged or ineligible transitions stay display-only. The draft core revalidates
proposals against the current tracker and requires human confirmation. Its
receipt prevents replay after acceptance; proposal files remain available.
If a retry encounters an earlier proposal whose tracker snapshot differs, that
original file is retained and diagnosed rather than rebound to the changed row;
other messages can still progress. Core reports stale proposals during review.

Reply scanning has its own 12-second budget inside the host's 15-second hook
limit. If that budget expires, narrow `reply_query`, `reply_label` or
`reply_days_back` and retry; completed checkpoints are retained. This keeps the
scan bounded rather than promising to finish every mailbox in one invocation.

## Attribution

MIT licensed. Started from career-ops' bundled Gmail reference seed at
`d6a6c12`, with the original Gmail ingestion contribution by
[@SparshGarg999](https://github.com/SparshGarg999) in
[#1203](https://github.com/career-ops-hq/career-ops/pull/1203).
The original source attribution and license are preserved.
