# v1 Spec — Outline & Locked Decisions

Status: **outline only**. Drafted at end of four-round PoC. The full spec
should be written in a dedicated session using this as the skeleton.

---

## 1. Product framing (locked)

> **Scenario replay evidence collector** for AI coding agents.
>
> Records a business operation once (trigger + multi-backend state snapshot
> + settle conditions + intent), replays it against any code version, and
> hands the resulting evidence to the agent for three-way reasoning
> (intent × baseline × current).

Not: "AI-native DB diff." That framing was a Round 2 hypothesis Codex
correctly punctured.

## 2. Transport / packaging (locked)

- **MCP server** (TypeScript + `@modelcontextprotocol/sdk`). Generic across
  any MCP-capable agent (Claude Code, Cursor, Codex, etc.).
- **Primary target stack** for v1: Node + MongoDB + Redis. Other stacks
  follow the same `state.capture` interface but ship later.
- **Containerization**: host code stays on host, only dependencies run in
  Docker. (PoC validated this is enough.)

## 3. Primitives (six locked, signatures sketched)

| Primitive | Validated in | Purpose |
|---|---|---|
| `scenario.record` | R3/R4 | Capture trigger + preconditions + capture-config + intent + code_ref into a portable artifact. |
| `scenario.replay` | R2/R3/R4 | Run a recorded scenario against a target code ref. Outputs a run artifact. |
| `state.capture` | R3 | Multi-backend snapshot — Mongo collections + Redis keys; extensible. |
| `scenario.settle` | R3 | Poll for explicit quiescence conditions (NOT just sleep). Output recorded as evidence, not as a verdict. |
| `diff.compare` | R2/R3/R4 | Diff two run artifacts with a configurable noise-filter. |
| `baseline.governance` | R4 | Promote/invalidate/list baselines. Baseline artifacts carry temporal metadata. |

### Sketched signatures (to refine)

```ts
scenario.record(input: {
  id: string,
  trigger: HttpRequest,
  preconditions?: HttpRequest[],
  capture: {
    mongo?: { collections: string[] },
    redis?: { keyPatterns: string[] },
    // ...extensible: postgres, fs, queue, etc.
  },
  settle?: SettleCondition,
  intent: IntentSpec,
}): ScenarioArtifact

scenario.replay(input: {
  scenario: ScenarioArtifact,
  against: { kind: 'gitRef'|'image'|'live', value: string },
}): RunArtifact

diff.compare(input: {
  baseline: RunArtifact,
  current: RunArtifact,
  noisePolicy?: NoiseFilter,
}): DiffArtifact

baseline.promote(input: {
  runArtifact: RunArtifact,
  approvedBy: string,
  intentRevision?: string,
}): BaselineArtifact

baseline.invalidate(input: {
  baseline: BaselineArtifact,
  reason: 'intent_changed'|'schema_drift'|'stale'|'rejected',
}): void
```

## 4. Artifact schemas (locked structure, fields to confirm)

### `ScenarioArtifact`
- `id`, `version`, `created_at`, `created_by`
- `trigger`, `preconditions`, `capture`, `settle`
- `intent`: `IntentSpec` (see §5)
- `code_ref`: git sha at recording time
- `dependency_versions`: hashes / package versions captured at record time
- `noise_policy_default`

### `RunArtifact`
- `scenario_id`, `code_ref`, `run_at`
- `pre_snapshot`, `post_snapshot`, `settle_outcome`, `trigger_response`,
  `external_calls` (placeholder for v2 mocks)

### `BaselineArtifact` ← **the v1 differentiator**
Carries the temporal metadata Round 4 proved is mandatory:
- `recorded_at`, `code_ref`, `dependency_versions`
- `intent_revision_at`, `intent_revision_hash` ← required for `baseline_stale`
- `approval_status`: `unreviewed | trusted | stale | rejected`
- `approved_by`, `approval_notes`
- `side_effect_inventory`: list of backends + collections + key patterns
  the recording touched (set up the v2 intent-coverage warnings)
- `parent_baseline_id` (lineage)

### `DiffArtifact`
- `mongo`: per-collection `{ added, removed, modified }` (R3 shape works)
- `redis`: `{ added, removed, modified }` with TTL drift filtering (R3 shape works)
- `settle_comparison`: `{ baseline_settle, current_settle }`
- `noise_filter_applied`

## 5. Intent specification (LOCKED structure, OPEN authoring story)

Locked:
- `IntentSpec` is plain English + a structured `required_side_effects` field
  to help cross-checking.
- Intent has its own revision history: `revisions: [{ at, by, hash, summary }]`.

Open (for the v1 spec session):
- Does the user write intent by hand, or does the AI propose it from
  baseline observation and a user approves?
- How do we surface "intent doesn't mention this side effect" warnings?
- What is the authoring UX in the MCP context (a JSON tool argument? a
  separate file? interactive?).

## 6. Verdict vocabulary (LOCKED — hierarchical)

Top-level verdict (one of):
- `regression`
- `no_regression`
- `intent_violation`
- `inconclusive`

Required `cause` attribute when verdict is `intent_violation` or `regression`:
- `shared_bug` (both runs violate same intent — Case A)
- `intent_drift` (baseline was correct under prior intent; intent has been
  revised — Case C)
- `improvement` (current fixes baseline's bug — Case B)
- `accidental` (current introduces a new bug — Case D)

Round 4 evidence: a flat six-label enum produces label-overlap. AI's
rationale was correct on Case C but the label choice was a coin flip
between `intent_violation_in_both` and `baseline_stale`. Hierarchical
verdict + cause attribute resolves this without losing the information.

## 7. Judge prompt structure (LOCKED — three-way reasoning)

Mandatory inputs:
- INTENT (spec text + structured required side effects)
- BASELINE (diff + settle + baseline metadata)
- CURRENT (diff + settle + code ref)

Mandatory output fields (validated in Round 4):
- `intent_vs_baseline`
- `baseline_vs_current`
- `intent_vs_current`
- `verdict` (hierarchical)
- `cause` (when applicable)
- `confidence`
- `rationale`
- `concerns` (carry-forward signal — Round 1 lesson: AI's "concerns" field
  is itself product output, not noise to discard)

## 8. Noise filtering (LOCKED defaults, OPEN policy)

Default filters (Round 2/3 evidence shows these are necessary):
- `_id` differences between two independent runs
- timestamp fields set to "now" on each run
- Redis TTL drift on the same key
- Mongo ObjectId allocation order

Open:
- How is the policy configured? Default profile + per-scenario overrides?
- Logical-entity matching when `_id`s differ (Codex's "diff.matchEntities"
  — not validated yet; defer to v1.x).

## 9. Security posture (UNLOCKED — must address before v1 ships)

Codex Round 1 critique that we haven't addressed:

> "Same Node process can exec arbitrary commands, write Mongo, manage
> Docker containers, potentially intercept HTTP. This is a high-privilege
> local agent supervisor, not a normal MCP server."

Required before any external user runs this:
- typed tool surface (no generic `exec.run`)
- command allowlist
- secret redaction in diffs (PII / API keys)
- network policy (no outbound by default in v1)
- audit trail of every state-mutating call

**This section is the v1 spec's hardest open chapter.** Worth its own
review pass after the spec is drafted.

## 10. Out of scope for v1 (deferred to v1.x or v2)

- External API mocks / Mock factory (Codex was right — defer)
- Postgres, MySQL, Kafka, S3 capture adapters (architecture supports it,
  but only Mongo + Redis ship in v1)
- Production-scale diff summarization (`diff.explain`)
- Mutation testing for scenario coverage
- Multi-agent concurrent replay against the same backend
- Non-determinism beyond `_id` / timestamp (random codes, A/B buckets,
  race tie-breaks)
- Schema drift handling between code refs

## 11. The blocker that prevents 8/10 score

**Scenario intent quality** is the only remaining oracle problem. Codex
named it in Round 3 and Round 4 confirmed the bite (every Round 4 result
depended on a manually-authored intent with full ground truth).

Required before v1 GA (or accepted as a known limit and documented):
- Decision: does the AI write intent from baseline (and risk encoding
  bugs as expectation), or does the user write it (and risk adoption
  friction)?
- Side-effect inventory surfaced as "your intent doesn't mention these
  side effects we observed in baseline — is that intentional?"
- `inconclusive` should be a normal verdict, not a failure mode, when
  intent is incomplete.

This may be the single most important decision in the v1 spec.

## 12. Where to start writing the actual spec

Open this file. Read REPORT.md alongside. The order for drafting:

1. §1 framing — copy from above
2. §3 primitives — turn sketches into precise TypeScript signatures
3. §4 artifacts — define exact JSON schemas, version them
4. §6 verdict — finalize hierarchical structure
5. §7 judge prompt — write the actual prompt template that will ship
6. §9 security — this is the long pole; treat as a sub-spec
7. §5 intent — decide the authoring story (open question)
8. §10/§11 scope — write the explicit "we are not doing this in v1" list

The PoC code at `state-diff-poc/` is the working reference for §3/§4/§6/§7
— every primitive listed there is implemented in some form already.
