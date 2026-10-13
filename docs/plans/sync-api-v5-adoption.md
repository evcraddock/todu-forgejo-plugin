# Safe Forgejo Sync API v5 Adoption

## Status

Design investigation for `task-417bb5b9`. Setup and isolated investigation were approved; production implementation and live cutover are not approved. The plugin remains registered as API v4. The design decision below must be resolved before changing that registration.

## Goal and boundaries

Adopt a field-group provider boundary for all four existing task groups without fabricated history, unsafe whole-task fallback, discarded replay batches, or unnoticed loss of ordinary imports. Preserve task/comment identity, independent read/write checkpoints, strategies, and restart recovery. Keep group-specific normalization/repair enhancements in their existing tasks except where shared partial-write plumbing is necessary for a usable cutover.

This task does not deploy the plugin, modify live state, implement issue-deletion confirmation, or change Todu core without separate authorization. It must not report deletion handling unblocked merely because a workflow payload is accepted.

## Investigated versions and evidence

The installed published packages are `@todu/core` 0.25.2, `@todu/engine` 0.24.1, and `@todu/daemon` 0.25.1. The inspected public types are `sync-provider.d.ts` and `sync-field-groups.d.ts`. The application behavior is implemented by the published daemon's `sync-worker-runtime.js` and `sync-field-group-pull.js`, with decisions in the engine's `sync-field-groups.js`.

Ten isolated in-process host probes passed using the real engine and worker runtime, with temporary storage and no daemon process, network, credentials, or live catalog access. Temporary fixture storage was removed. The investigation artifacts are `/tmp/task-417bb5b9-v5-probes.mjs` and `/tmp/task-417bb5b9-v5-probe-results.json`; these temporary files are evidence, not shipped runtime code.

| Probe                                                         | Observed result                                                                                                              |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Known workflow baseline, remote cancellation                  | Status changes to `canceled`; title, description, priority, and labels remain intact; acknowledgment contains workflow only. |
| Missing workflow baseline                                     | Validation fails before mutation; no acknowledgment.                                                                         |
| Newer whole-task v4 replay under v5                           | Host rejects the linked task: use `taskUpdates`, not whole-task replacement.                                                 |
| The same replay under v4                                      | Application and legacy acknowledgment succeed.                                                                               |
| All four groups with known baselines                          | Application succeeds and all four independently selected outcomes are acknowledged.                                          |
| Mixed local content / remote workflow winners                 | Local content survives; workflow changes; the content receipt still requires a remote write.                                 |
| Unmapped local assignment                                     | Assignment is deferred and preserved while workflow still applies.                                                           |
| Older bootstrap payload against an existing local task        | Host can skip the imported values and still acknowledge with an empty `taskResults` array.                                   |
| Canceled baseline, reopened local task, remote canceled value | Host chooses `local-only`; local remains active even with an omitted source timestamp.                                       |
| Host flush failure followed by replay                         | Failure does not acknowledge; replay converges and then acknowledges.                                                        |

These probes verify contract behavior, not a finished plugin implementation or a deployable migration.

## What API v5 already supports

- `tasks` represents bootstrap creates and narrowly permitted interrupted creation replay, not a general replacement path for existing linked tasks.
- `taskUpdates` identifies an existing local task by canonical external identity and optionally asserts its local task ID.
- Supplied groups contain complete `base` and `remote` values. Omitted groups are unchanged. Each `base` is defined as the last value proven mirrored on both sides.
- Host acknowledgment returns selected group values, conflict decisions, deferred assignment, and whether each selected value still requires a remote write. Host persistence and flush precede acknowledgment.
- Known-baseline content, workflow, classification, and assignment updates can select different winners without replacing unrelated groups.

Consequently, a manifest-only upgrade, a content-only upgrade that silently drops other imports, or a v5 wrapper that retains linked whole-task replacement is not an acceptable implementation.

## Remaining adoption gaps

### Unknown baselines and local observation

Existing links can have no snapshots or only some groups. V5 does not accept an unknown `base`, and the provider's `pull(binding, project)` receives neither local task values nor a read-only local task service. An empty group update is not an observation request: acknowledgments report supplied outcomes only.

V4 acknowledgment proves batch application completed, not which whole-task values won. V5 bootstrap acknowledgment likewise does not return the persisted task values. An existing newer local task can survive a replay unchanged. Neither acknowledgment alone proves that the remote values now form a common baseline.

A successful push can establish some common values when complete host-exported values and a verified remote result agree. It is not a complete migration solution: pull-only bindings have no push, deferred assignments cannot be treated as an empty set, and a normal whole-record push must not first destroy a disagreement merely to create a baseline. New pull-only bootstrap records need a trustworthy persisted-value receipt or explicit initialization too.

### Pending v4 replay

A pending v4 batch can contain both new records and changes to existing records, possibly after partial local application. V5 cannot simply return that batch in `tasks`. Reclassifying all rows as bootstrap, clearing the batch, advancing cursors, or creating missing bases from its values can lose updates or erase local edits.

Without a host-assisted migration path, the safe operational alternative is to finish and acknowledge pending work using the v4 release before cutover. If pending v4 work is encountered after cutover, preserve it and refuse to guess; recovery must remain possible with the v4 release. This is an explicit drain requirement, not seamless v5 replay.

### Confirmed deletion is not ordinary last-write-wins

A workflow-only v5 update is supported when its baseline is known, but it is not an unconditional cancellation directive. In particular, `base=canceled`, `local=active`, `remote=canceled` is a local-only edit, so timestamp tie rules are not consulted and the host selects active. A newer divergent local workflow can also win a timestamp conflict.

Do not falsify a baseline or clock to make cancellation win. The deletion follow-up needs either a separately authorized status-only operator action, or a versioned host capability that represents confirmed operator intent without treating it as ordinary remote last-write-wins. These are alternative designs; neither is implemented or silently selected here.

## Rollout options requiring a human decision

### A. Plugin-only, operator-assisted cutover

1. Finish pending v4 batches before enabling v5. Preserve any unexpected v4 batches and report actionable recovery instructions rather than rewriting them.
2. Add an explicit initialization tool that reads the local task and actor mappings through a supported local CLI/RPC interface and reads the corresponding Forgejo issue. Produce a dry-run comparison per group and require explicit approval for resolving disagreements. Do not open live engine storage from a second process.
3. Save a baseline only after re-reading and verifying a common normalized value and matching binding/task/remote identities. Preserve unknown and unmapped groups. Account for concurrent edits, errors, content approval, and partial initialization; no arbitrary bootstrap values.
4. During v5 operation, diagnose and preserve unknown groups rather than silently importing them or overwriting them on push. Automatic verification after push can supplement initialization, but does not cover pure pull operation. Pull-only records created later will still need verified initialization without additional host support.
5. Separately agree that the deletion confirmation operation directly performs the narrow local status action, or keep deletion handling blocked on a dedicated host capability. A normal v5 receipt alone does not guarantee cancellation.

This avoids a Todu code change, but adds manual onboarding/recovery work and changes pull-only ergonomics. Those tradeoffs require explicit approval; they are not presumed to satisfy seamless compatibility. The CLI/RPC helper, concurrency guarantees, and initialization operations still require focused implementation/proof tests.

### B. Versioned host support for safe adoption

Identify an upstream contract prerequisite providing these capabilities, without changing existing v3/v4/v5 semantics in place:

- A host-owned local observation/initialization path for groups with an unknown baseline, including canonical assignment mapping and persisted bootstrap outcomes. Report equal values as verified convergence; preserve disagreements unless an explicit initialization policy has been approved. Do not call an unproven remote value a historical baseline.
- A documented route for durable mixed/partially applied v4 batches, or an explicitly enforced drain phase. Recovery must retain the original batch, local edits, identities, and read boundaries.
- If sync itself must enforce confirmed deletion, a narrowly scoped operator-authorized workflow action with identity checks and guarded status-only persistence; keep this separate from ordinary timestamp conflict resolution.

After the published host provides the chosen initialization path, implement the plugin adapter and run the same published-host integration matrix. Host work is not authorized by this plugin task. A new upstream task must be drafted and approved separately if this option is selected.

## Shared plugin implementation stages after design approval

### 1. Contract boundary and payloads

Register the explicitly supported version; separate creates from linked updates; preserve all four ordinary field groups. Normalize content according to the actual host validation rules, label sets according to the existing snapshot contract, and assignments according to canonical mapped identities. Do not silently alter old verbatim content snapshots to fit host trimming rules; validate/reinitialize them under the approved policy.

### 2. Initialization and durable migration

Implement the selected unknown-baseline and v4 replay policy. Version the pending batch schema explicitly, preserving old data and recovery paths. Never infer an initialized group merely from `lastMirroredAt`. Validate malformed, sparse, partially initialized, mismatched-identity, and deferred-assignment state.

### 3. Acknowledgment and partial writes

Validate receipt count, ordering, identities, group membership, and outcome shapes against the saved batch. Commit snapshots only when local persistence and any required remote mirror are verified. Persist required remote writes before committing pull progress; preserve newer local/exported intent during retry. Replace the ordinary full-issue builder in the grouped path with selective updates. Workflow/classification share Forgejo's label endpoint, so retain unrelated reserved/normal labels through a verified read/merge rather than clobbering another group. This necessary shared write isolation is included here; detailed repair policies stay in follow-up tasks.

### 4. Strategy and recovery coverage

Exercise pull-only, push-only, bidirectional, and disabled bindings; fresh bootstrap, established links, partial snapshots, mixed winners, and incomplete mappings. Test failed host apply/flush, interrupted remote writes, failed acknowledgment, stale receipts, partial v4 replay, and provider restart. Push-only must not invent host pull receipts or commit pull progress. Preserve independent comment sync and existing identity safety.

### 5. Documentation and review gates

Update architecture/storage compatibility and operational recovery documentation. Run format, lint, typecheck, tests, build, pre-PR checks, and relevant isolated dev checks. Open a task-linked PR and obtain independent review. Human merge approval and separate close-gate approval remain mandatory.

## Recommendation and approval gate

Do not change the provider registration yet. Select option A only if the additional manual initialization/drain workflow and the separately scoped cancellation action are acceptable. For automatic safe adoption across pull-only and bidirectional operation, prefer option B's explicit initialization/observation capability rather than a fabricated v5 baseline or hidden runtime CLI workaround.

The previous statement that no Todu change would be needed was too broad: known-baseline v5 updates require only plugin changes, but the investigated v5 interface does not itself provide the missing initialization/observation and authoritative cancellation semantics described above. Whether an upstream change is required depends on the operational policy chosen here.
