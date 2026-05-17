# PoC Report — Can AI judge correctness from raw Mongo state diffs alone?

**Date**: 2026-05-17
**Hypothesis**: Given (a) a one-paragraph statement of business intent and the
exact API call made, and (b) a raw document-level JSON diff of MongoDB
collections before/after the call, can an AI agent correctly judge whether
the operation behaved as intended?

## Setup

- **Targets**: two tiny Express + Mongo apps in `mini-app/` (clean) and
  `mini-app-buggy/` (three planted bugs, gated by env var `BUG`).
- **Bugs planted**:
  - **A** — `POST /posts` skips the `audit_log` insert.
  - **B** — `POST /posts` with `state='AVAILABLE'` forgets to set `publishedAt`.
  - **C** — `POST /follows` update branch writes `!status` instead of `status`.
- **Mongo**: single-node `mongo:6` on `localhost:27018`, no replica set
  (Change Streams deliberately not used — we use raw collection scans).
- **Pipeline**: `lib/runner.js` orchestrates per-scenario: drop DB → start
  app variant → run preconditions → snapshot → trigger → snapshot → diff →
  write `runs/<id>/`.
- **Judge**: `lib/judge.js` builds a fresh prompt from `judge-prompt.md` for
  each scenario (only intent + API call + raw diff — **no source code, no
  ground truth**) and sends it to a one-shot `claude -p` invocation.

## Scenarios

| # | Scenario | Variant | Operation |
|---|---|---|---|
| 01 | create-post | clean | `POST /posts` (DRAFT) |
| 02 | publish-post | clean | `PATCH /posts/:id/publish` (→AVAILABLE) |
| 03 | first-follow | clean | `POST /follows` (status=true) |
| 04 | toggle-unfollow | clean | `POST /follows` (status=false on existing) |
| 05 | BUG no-audit | buggy A | `POST /posts` |
| 06 | BUG no-publishedAt | buggy B | `POST /posts` (state=AVAILABLE) |
| 07 | BUG inverted-status | buggy C | `POST /follows` (status=false on existing) |

## Results

| # | Verdict | Confidence | Ground truth | Correct? |
|---|---|---|---|---|
| 01 | matches_intent | 0.95 | clean | ✅ |
| 02 | matches_intent | 0.90 | clean | ✅ |
| 03 | matches_intent | 0.90 | clean | ✅ |
| 04 | matches_intent | 0.85 | clean | ✅ |
| 05 | matches_intent | 0.90 | buggy | ❌ **missed** |
| 06 | deviates_from_intent | 0.85 | buggy | ✅ caught |
| 07 | deviates_from_intent | 0.85 | buggy | ✅ caught |

- Baseline (clean) accuracy: **4 / 4** ✅ (success bar: ≥ 4 / 4)
- Bug detection accuracy: **2 / 3** ✅ (success bar: ≥ 2 / 3 — at the floor)

## What failure mode #05 actually looked like

The buggy `POST /posts` skipped the `audit_log` insert. The AI's judgment:

> *"A single new document was added to the posts collection ... No other
> collections were touched. ... verdict: matches_intent (0.90).
> concerns: 'No entry was written to audit_log, which may or may not be
> expected for draft creation.'
> missing_information: 'Whether the system is expected to write an audit_log
> entry on post creation.'"*

The AI **saw the signal** (audit_log absent) and even **flagged it** in
`concerns` and `missing_information`, but had no basis to call it a bug —
nothing told it that creating a post should always write to `audit_log`.

It hedged in the safe direction.

## What the bugs the AI did catch had in common

Scenarios 06 and 07 were caught because the bug was **a value visible inside
the diff itself**:

- **06**: post `state` is `'AVAILABLE'` but `publishedAt` is `null`. The
  internal contradiction is local to a single document and reads as obviously
  wrong without any external knowledge.
- **07**: user asked for `status=false` but the diff shows only `updatedAt`
  changed — nothing about `status`. Intent and observed change directly
  contradict, again purely local.

Scenario 05 had no such local contradiction. Everything visible in the diff
was internally consistent. The bug was a **missing side effect**, and the diff
cannot tell you about something that didn't happen.

## Implications for v1 design

This PoC validates three things and rejects one assumption:

**Validated**

1. **For value-level correctness, raw diff plus business intent is enough.**
   AI catches contradictions inside the visible data confidently. This is
   the strongest finding — most "did I write the right value?" bugs are
   detectable from diff alone.
2. **The "AI judges, tool only provides diff" division of labor mostly works**
   for the clean and value-bug cases — 6 / 7 scenarios came back correct.
3. **AI hedges honestly when it lacks information.** It flagged exactly the
   concern that would have caught bug 05 and explicitly listed the missing
   piece of context. That telemetry is itself useful — the tool can surface
   "AI uncertainty hot spots" without needing to know ground truth.

**Rejected**

1. **"AI can detect missing side effects from a single diff."** No. Without
   either a reference (what *should* have happened) or a manifest (what
   collections this endpoint is contracted to write to), AI cannot
   distinguish "this side effect wasn't needed" from "this side effect was
   needed and is missing." This is exactly what Codex predicted.

## Concrete v1 product asks falling out of this

In priority order:

1. **`scenario.replay` or differential diff** — biggest fix. Run the same
   trigger against a baseline (e.g., previous commit, golden recording) and
   diff the two diffs. The audit_log absence in scenario 05 becomes glaring
   when compared against a clean baseline that *did* write to audit_log. This
   alone would have caught the one bug we missed, with no manifest required.
2. **Surface `concerns` and `missing_information` to the user** even when the
   verdict is `matches_intent`. AI's hedging is signal, not noise. A `matches_intent`
   with `concerns: ["no audit_log entry"]` should not pass silently.
3. **Optional manifest layer** — `state.contract.yaml` listing
   "endpoint X writes to collections [posts, audit_log]". Cheap to author,
   converts a known unknown into a checkable assertion. Don't require it,
   but let teams opt in.
4. **Noise filtering on diff output** — `updatedAt`, computed timestamps,
   ObjectId generation. Currently the AI navigates this fine, but at higher
   scale it will erode signal. Defer until we see it bite.
5. **Multi-backend diff (Redis / Postgres)** — out of scope for the PoC but
   confirmed real. The "Redis can't carry provenance" observation made
   during planning is the canonical instance: state lives in places the
   `state.diff` tool doesn't see.

## What this PoC did NOT test (intentionally)

- **MongoDB Change Streams** — used full collection scan instead. Change
  Streams have their own gotchas (pre-images, resume tokens, delete payload
  shape) — out of scope for the "is raw diff enough" question.
- **Concurrent noise (scenario 8)** — deferred. Want to see how AI behaves
  on noise-free diffs first; the noise question becomes interesting only if
  the baseline works, which it now does.
- **Cross-DB writes** — `blog-backend`'s `saveFollow` straddles two Mongo
  instances. The toy app collapses to one, so this stayed unobserved.
- **External API calls / Mocks** — explicitly out of v1.
- **Large diffs (10+ collections, 100+ docs)** — toy data is small; signal
  may degrade at scale.

## Verdict

**The core hypothesis holds with one named caveat**: raw structural diff +
plain-English intent is enough for AI to catch value-level bugs, but
**cannot detect missing side effects without a reference**.

The strongest next step is not "richer diff" but **differential diff against
a baseline**. That single feature would have brought this PoC to 7 / 7 and
turns the tool from "AI inspects this one run" into "AI catches regressions
between any two versions of the code."

This is enough signal to proceed to a v1 with `state.diff` + `scenario.replay`
as the two primitives, rather than expanding the diff format itself.

---

# Round 2 — Differential diff PoC

**Hypothesis**: feeding the AI both a clean baseline diff and the current diff
of the same operation lets it catch the side-effect bug that the single-diff
prompt missed.

## Setup

For each buggy scenario (05 / 06 / 07), ran the **same trigger** against the
clean app to produce a paired baseline (`05-baseline-clean`, etc.). Then
asked the AI:

> "Here is the diff when this operation ran against the prior known-good
> version of the code, and here is the diff against the version under test.
> Same input both times. Is the new version a regression?"

Prompt: `judge-differential-prompt.md`. Runner: `lib/judge-differential.js`.
Outputs: `runs/<scenario>/judgment-differential.json`.

## Results

| # | Bug | Single-diff verdict | **Differential verdict** | Confidence |
|---|---|---|---|---|
| 05 | missing audit_log | matches_intent (**miss**) | **regression** | 0.95 |
| 06 | publishedAt null | deviates_from_intent | **regression** | 0.95 |
| 07 | inverted status | deviates_from_intent | **regression** | 0.97 |

**3 / 3 caught**, up from 2 / 3. The previously-missed scenario 05 now reads
loud and clear:

> *"Baseline wrote an audit_log entry for the insertPost operation; current
> wrote none."* (confidence 0.95)

AI no longer needs a manifest or domain knowledge to recognize the missing
side effect — the baseline acts as the reference.

## What this confirms

1. **Differential diff is the v1 keystone**, not richer single-diff formats.
   With baseline + current, the AI's reasoning shifts from "is this
   plausible?" to "what changed between two runs?" — a strictly easier and
   more answerable question.
2. **No false positives on incidental differences.** The prompt explicitly
   asked the AI to ignore freshly generated `_id`s and timestamps, and it
   did — every reported difference was a real regression.
3. **Confidence rose from ~0.85–0.90 to ~0.95–0.97.** The differential
   framing also makes the AI more certain, not just more correct.

## Updated v1 design implications

The two-primitive design holds, but with sharper priorities:

1. **`scenario.replay(scenarioId, against: gitRef|snapshot)`** — record a
   scenario once (trigger + collections of interest), then replay against any
   code version to produce a paired diff. This is the primary value prop.
2. **`state.diff(snapshot_a, snapshot_b)`** — the underlying primitive,
   useful on its own.
3. **`diff.compare(diff_a, diff_b)`** — explicit diff-of-diffs primitive
   that strips incidental fields (configurable noise filter) and surfaces
   only the structural deltas.
4. **Manifest / contracts demoted to *optional***. The PoC originally
   suggested an opt-in manifest (`state.contract.yaml`). Differential diff
   makes that unnecessary for the common case. Keep manifests as a fallback
   for "first-ever run, no baseline available" situations, not as the
   primary mechanism.

## Verdict (round 2)

The PoC has now exercised the strongest known counter-argument to the
"tool gives diff, AI judges" design (Codex's critique: "AI can't see what
didn't happen") and shown that **a baseline diff resolves the gap without
requiring semantic schema, manifests, or domain knowledge**.

Recommendation: proceed to v1 with `scenario.replay` + `diff.compare` as the
defining feature pair. Single-shot diff is a useful debug primitive but
should not be the headline product.

---

# Round 3 — Async, multi-backend, with settle (the Codex challenge)

After Round 2, Codex pushed back: the experiment was too easy. We controlled
away async work, queues, retries, multi-backend state, settlement timing,
and external IO. It demanded a load-bearing experiment with at least
Mongo + Redis + async worker + outbox + retry.

This round implements exactly that.

## Setup

- **Apps**: `mini-orders/` (clean) and `mini-orders-buggy/`. Each is a single
  Node process serving as API + in-process worker + in-process mock payment.
  Worker polls `outbox_events` every 100ms and runs side effects (decrement
  inventory, write `audit_log`, mark order `paid`).
- **Multi-backend**: Mongo for `orders` / `outbox_events` / `inventory` /
  `audit_log`. Redis for idempotency keys (`idemp:<key>` with 60s TTL).
- **New primitive — `lib/settle.js`**: between trigger and `after`
  snapshot, polls `GET /_debug/outbox-pending` until 0 or timeout. Records
  `settled: bool`, `waitedMs`, `polls`, `finalPending`, and any
  `timeout_reason`. The settle outcome is passed to the judge as evidence.
- **New primitive — `lib/state-capture.js`**: snapshots Mongo collections
  AND Redis keys (`SCAN` by pattern, then `GET` + `TTL`).
- **New primitive — `lib/diff-multi.js`**: structured diff over both
  Mongo and Redis sections.
- **Bugs planted (env-gated in the buggy app)**:
  - `WORKER_DOWN` — worker `setInterval` never starts.
  - `NO_IDEMP_KEY` — API skips writing the Redis idempotency key.
  - `DOUBLE_INVENTORY` — worker decrements `2 * qty` per item.
  - `NO_CONSUME` — worker marks outbox events processed but performs zero
    side effects (order stays `pending`, no inventory change, no audit).
    This is **the trap**: settle reports `true`, but the system is wrong.

## Scenarios

| # | Scenario | Variant | Bug |
|---|---|---|---|
| 01 | happy order | clean | — |
| 02 | retry same idempotency key | clean | — |
| 03 | worker down | buggy | WORKER_DOWN |
| 04 | double inventory | buggy | DOUBLE_INVENTORY |
| 05 | no idempotency key | buggy | NO_IDEMP_KEY |
| 06 | no-consume worker | buggy | NO_CONSUME |
| baseline | shared clean baseline | clean | — |

## Results — single-diff judging (with settle)

| # | Variant | Verdict | Confidence |
|---|---|---|---|
| 01 happy | clean | matches_intent | 0.92 |
| 02 retry | clean | matches_intent | 0.85 |
| 03 worker-down | buggy | **deviates_from_intent** | 0.95 |
| 04 double-inv | buggy | **deviates_from_intent** | 0.90 |
| 05 no-idemp | buggy | **deviates_from_intent** | 0.85 |
| 06 no-consume | buggy | **deviates_from_intent** | 0.92 |

**Clean baselines: 2/2. Bugs caught: 4/4.** Bug detection actually rose
compared to Round 1 (2/3 there). Single-diff is *more*, not less, capable
in the async / multi-backend setting — for three reasons:

1. The `settle` outcome carries strong semantic weight by itself. Scenario
   03's `settled: false, finalPending: 1` is a louder signal than any
   single missing document.
2. Multi-backend evidence makes some bugs detectable that couldn't be from
   Mongo alone. Scenario 05's NO_IDEMP_KEY produces **identical Mongo
   state** to the clean run; only the Redis section shows it.
3. Async pipelines naturally create internal cross-collection contradictions
   — `order.status: pending` while the outbox event for that order is
   already marked `processedAt`. Scenario 06 was caught at 0.92 because the
   AI noticed that mismatch and refused to be fooled by `settled: true`.

## Results — differential judging (paired with `async-baseline-clean`)

| # | Bug | Single verdict | **Differential verdict** | Confidence |
|---|---|---|---|---|
| 03 | worker down | deviates | **regression** | 0.97 |
| 04 | double inv | deviates | **regression** | 0.92 |
| 05 | no idemp | deviates | **regression** | 0.90 |
| 06 | no consume | deviates | **regression** | 0.98 |

**4/4.** Confidence rose uniformly. For scenario 05, the differential AI
wrote verbatim:

> *"Redis: baseline added 'idemp:<key>' -> orderId with TTL 60; current run
> added no Redis keys at all. This is a real missing side effect, not TTL
> drift on the same key."*

Notice it explicitly disambiguated *real missing side effect* from *TTL
drift*. Good signal that the prompt's noise-filter instructions land.

## Methodology note — name leakage caught and fixed

The first version of scenario 05 used an idempotency key named
`ord-key-noidemp`. The judge flagged this honestly in its `concerns`:

> *"The key name 'ord-key-noidemp' hints this scenario specifically
> exercises the missing-idempotency-cache bug."*

We renamed it to a neutral `tx-2026-05-17-a1b2` and re-ran. The verdict
held (still `deviates_from_intent`, 0.85), and the AI's primary
justification became:

> *"Redis diff is entirely empty — no idempotency key was cached. The
> intent explicitly requires the idempotency key to be cached so a retry
> would not produce a duplicate."*

The catch wasn't keyword-driven — it was an intent-vs-evidence cross-check.
But the original framing was contaminated. Lesson for v1: **never let the
scenario name, key name, or comment leak the expected outcome.**

## What this confirms about Codex's Round 2 critique

| Codex prediction | Outcome |
|---|---|
| Multi-backend state is essential | **Confirmed.** Scenario 05's bug was Mongo-invisible; Redis section caught it. |
| `scenario.settle` is a load-bearing primitive | **Confirmed.** Scenario 03's bug was *primarily* signaled by `settled: false`. |
| "Settle passes" ≠ correct | **Confirmed.** Scenario 06 settled cleanly (worker drained the outbox in 108ms) while leaving the system in an inconsistent state — caught at 0.92 / 0.98. |
| Test was too easy in Round 1 | **Partially.** Bug rate didn't drop in the harder setting, but we still haven't tested baseline drift, real concurrency, schema migration, randomness, retries-under-failure, or external IO. |
| `diff.explain` (pre-aggregate before AI) | Not needed at this scale. JSON is still readable for the AI. Will matter at production scale. |

## What this PoC still has NOT tested (carrying forward)

1. **Baseline trustworthiness** — Codex's strongest critique. We never
   tested what happens when the baseline itself encodes wrong behavior.
   This requires a baseline-governance model and is the obvious next PoC.
2. **Non-determinism beyond ids/timestamps** — random IDs, A/B bucketing,
   retry attempt counters, race-condition tie-breaks. The fields we
   filtered were the easy ones.
3. **Real external IO** — payments are an in-process mock function. mTLS,
   webhooks, signed callbacks, gRPC, retries, partial failures — all
   absent.
4. **Schema drift between baseline and current** — what if current code
   adds a new collection that didn't exist when the baseline was recorded?
   Or removes a field? Currently the diff would over-report this as a
   "regression".
5. **Production-scale diff size** — 10+ collections, 1000+ docs touched
   per scenario. Will the AI still be able to read the diff directly, or
   does `diff.explain` become a hard requirement?
6. **Concurrent scenarios** — multiple agents replaying scenarios against
   the same backend simultaneously.

## Verdict (Round 3)

Codex predicted Round 1's success was a toy result and that the same
approach would fall apart on async / multi-backend / settling. **It
didn't.** With three additional primitives (`state.capture`, `settle`,
`diff-multi`), the same "AI judges from evidence" formula caught
**4/4 async bugs in single-diff mode** and **4/4 in differential mode**,
including the `NO_CONSUME` trap that was specifically designed to defeat
naïve settle-based judging.

But Codex was right that Round 1 alone wasn't load-bearing. The PoC now
covers:

- ✅ multi-backend state capture and diff
- ✅ asynchronous side effect timing via explicit settle
- ✅ Redis-only bug detection
- ✅ "settled but wrong" detection
- ✅ differential against a baseline

It still does not cover:

- ❌ baseline trust/governance
- ❌ non-determinism beyond ids/timestamps
- ❌ external IO realism
- ❌ schema drift
- ❌ production-scale diff size

If v1 ships with `scenario.replay` + `state.capture` (Mongo + Redis at
minimum) + `scenario.settle` + `diff.compare` + a clear story for
**baseline governance** (owner, git ref, intent, approval state), the
evidence supports Codex's 7/10 estimate. **8/10 still requires the
non-determinism, IO realism, and scale items above.**

---

# Round 4 — Baseline governance 4-case matrix (Codex's deepest critique)

After Round 3, Codex's strongest remaining complaint was that we had never
tested what happens when the baseline itself is wrong. A differential-diff
system that trusts the baseline blindly will confidently preserve broken
behavior, the same trap that has bitten snapshot testing for a decade.

Codex prescribed an exact experiment: a 2×2 matrix of (baseline-correct?
× current-correct?) plus a vocabulary expansion from binary
`regression / no_regression` to a six-label set:

- `regression` — baseline fulfills intent, current doesn't.
- `no_regression` — both fulfill intent.
- `intent_violation_in_both` — neither fulfills intent in the same way.
- `intent_improvement` — baseline violated intent, current fixes it.
- `baseline_stale` — current matches baseline but intent has moved.
- `inconclusive`.

This forces the judge into **three-way reasoning**: intent↔baseline,
baseline↔current, intent↔current. The prompt
(`judge-governance-prompt.md`) is rewritten around this.

## Setup

| Case | Baseline run | Current run | Expected verdict |
|---|---|---|---|
| **A — broken both** | gov-baseline-broken (DOUBLE_INV) | async-04-double-inventory (DOUBLE_INV) | `intent_violation_in_both` |
| **B — broken→fixed** | gov-baseline-broken (DOUBLE_INV) | async-baseline-clean | `intent_improvement` |
| **C — intent revised** | async-baseline-clean | gov-current-clean (also clean) | `baseline_stale` |
| **D — accidental regression** | async-baseline-clean | async-04-double-inventory | `regression` |

Cases A, B, D share one intent text (the "standard" order requirements).
Case C uses a revised intent that adds *"audit_log entries must include
userId — this is a NEW compliance requirement"*. The code didn't change
between A's baseline and Case C's baseline; only the intent did.

## Results

| Case | Expected | Verdict | Confidence | Match? |
|---|---|---|---|---|
| A | `intent_violation_in_both` | `intent_violation_in_both` | 0.95 | ✅ |
| B | `intent_improvement` | `intent_improvement` | 0.95 | ✅ |
| C | `baseline_stale` | `intent_violation_in_both` | 0.95 | ⚠️ near-miss |
| D | `regression` | `regression` | 0.95 | ✅ |

**3 / 4 verdict-exact. Case C is the most interesting result of the
entire PoC.**

## Why Case C "miss" is actually a product-level finding

The AI's rationale on Case C explicitly nailed the staleness:

> *"both runs fail in exactly the same way with no behavioral change
> between them, this is not a regression but a shared intent violation —
> **likely the baseline was recorded before the userId requirement was
> added** and the code was never updated."*

The AI **correctly diagnosed the cause**. It picked the wrong label
because `baseline_stale` and `intent_violation_in_both` are not disjoint
in our vocabulary — `baseline_stale` is really a *causal sub-case* of
`intent_violation_in_both`, with the cause being "intent was revised
after baseline was recorded."

To make the labels reliably distinguishable, the AI would need explicit
temporal metadata it currently doesn't have:

- when was the baseline recorded?
- when was the intent last revised?
- (optionally) the diff of the intent text itself between recordings

Without that, both labels apply to the same evidence and the choice
between them is a coin flip.

## Implications for v1

Round 4 produces three concrete architecture decisions:

1. **Verdict vocabulary must be hierarchical, not flat.** Codex's six
   labels collapse into a top level (`regression` / `no_regression` /
   `intent_violation` / `inconclusive`) and a secondary cause attribute
   (`shared_bug`, `intent_drift`, `improvement`, `accidental`). Either
   change the prompt to force the cause attribute, or accept that
   "intent_violation" subsumes `baseline_stale` and provide rationale
   text as the disambiguator.
2. **Baseline artifacts must carry temporal metadata.** Minimum fields:
   `recorded_at`, `code_ref`, `intent_revision_at`, `intent_revision_hash`.
   Without these, `baseline_stale` is not detectable in principle.
3. **Cases A and B are exactly the trap Codex warned about, and they
   were both caught at 0.95.** A naive baseline-vs-current judge would
   have called Case A "no_regression" (preserving the bug) and Case B
   "regression" (penalizing the fix). The three-way reasoning prompt
   makes the AI immune to both traps as long as the intent text is
   sufficiently explicit — which loops directly into the next gap.

## The unsolved problem this PoC surfaced (and did not test)

Codex named this in Round 3 and the PoC has now confirmed its bite:
**scenario intent quality is the next architectural cliff.**

Every result in this PoC, including the 3/4 in Round 4, depended on an
intent text written by the experimenter with full knowledge of what to
require. In real codebases:

- intent is often vague ("fix order checkout")
- side effects are undocumented
- the baseline IS the documentation, accidents and all
- if the AI writes intent from baseline, it encodes the bug as expectation

This is an **oracle problem**, not a UX problem. The next experiment is
not "make the diff better"; it is "test what happens when intent is
*incomplete* or *AI-generated from the baseline*."

Plausible Round 5 PoCs (none built yet):

- **Vague intent**: feed the AI an intent like "fix order checkout"
  alongside the diff, see whether it asks for clarification or hallucinates
  requirements.
- **AI-generated intent**: have the AI write the intent from observing
  the baseline, then run governance Case A. Does the AI-generated
  intent capture audit_log as required, or skip it because the baseline
  did?
- **Side-effect inventory**: have the AI list every collection / Redis
  key the baseline touched, and surface coverage gaps when the intent
  text doesn't mention some of them.
- **Mutation testing**: programmatically plant 20 minor behavioral
  changes in the clean code, measure scenario sensitivity.

## Verdict (Round 4)

Three-way reasoning works. The four-case matrix is tractable. The verdict
vocabulary needs one design pass before shipping. Baseline artifacts must
carry temporal metadata from day one.

After Round 4, the evidence supports:

- `scenario.replay` — yes (Round 2 keystone, Round 3 multi-backend, Round
  4 governance)
- `state.capture` — yes (Round 3 NO_IDEMP_KEY case)
- `scenario.settle` as evidence not oracle — yes (Round 3 NO_CONSUME)
- `diff.compare` with noise filters — yes (Round 2/3)
- **`baseline.governance` with `recorded_at` / `code_ref` / `intent_revision_at`** — yes (Round 4 Case C miss)
- Hierarchical verdict vocabulary — yes (Round 4 label overlap)

What still has not been tested and now blocks 8/10:

- **scenario intent quality** (Codex's "unnamed failure mode" from Round 3
  — surfaced again sharply in Round 4)
- non-determinism beyond `_id` and timestamp
- schema drift between code refs
- production-scale diff size
- real external IO

The most important sentence Codex has said across three reviews:

> *"You become very good at comparing evidence for scenarios whose intent
> is already well specified, but weak at creating trustworthy scenarios in
> messy real projects."*

After Round 4, that is the single highest-leverage problem left.
