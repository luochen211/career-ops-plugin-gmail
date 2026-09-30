# career-ops-plugin-gmail

Independent, opt-in Gmail integration for career-ops, maintained by @luochen211.
Starts from career-ops' MIT-licensed bundled Gmail reference seed at
`d6a6c12`, originally contributed by @SparshGarg999 in #1203.

The default `ingest` hook reads job leads from a configured label and returns
`Job[]` for career-ops to add to its pipeline. OAuth credentials arrive only
through `ctx.env`; network calls use the engine's guarded `ctx.fetch`.

Development of post-application reply review is tracked in
[career-ops #1583](https://github.com/career-ops-hq/career-ops/issues/1583),
dependent on the core proposal bridge in
[#3333](https://github.com/career-ops-hq/career-ops/issues/3333).
This repository is not registry approved and does not shadow the bundled seed.

Run `npm test` for the offline smoke check. MIT license; upstream attribution is
preserved in the source and LICENSE.
