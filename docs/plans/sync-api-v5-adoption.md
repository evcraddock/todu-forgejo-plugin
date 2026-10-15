# Safe Forgejo Field-Group Adoption (API v7 target)

## Status

Implementation in progress for `task-417bb5b9` after human approval of Option B and the five-stage adapter plan. Both host prerequisites are done and API v7 is published. Approved dependency minimums are `@todu/core` 0.28.0, `@todu/daemon` 0.28.1, and `@todu/engine` 0.24.5. The last two patches add replication socket cleanup without changing the v7 contract. Initial dependency upgrade typecheck and all 434 existing tests pass. The normal provider now explicitly registers v7 in source. No live cutover, deployment, restart, or state migration is authorized.

## Implementation progress

- [x] Published dependency upgrade and explicit v7 registration; the root factory/public types now use v7.
- [x] Canonical four-group payloads, fresh per-invocation observations, equality-only unknown initialization, grouped outbound exports, and complete/deferred assignment boundaries.
- [x] Tagged durable `fieldSync` replay/attempt ledger, receipt validation, independent unresolved/remote-write queues, and selective verified remote writes.
- [x] Explicit `@todu/forgejo/v4-drain` entrypoint. It persists the captured boundary in `v4-drain.json`, rejects changed/new batches across restart, validates scope before application, and never discovers or pushes.
- [x] Published native host fixtures for initialization, approval/mapping, mixed winners, comments, flush/ack/push failure, fresh-token replay, concurrent edits, partial endpoints, and operator workflow intent. Existing v4 regression tests explicitly import the retained internal legacy implementation; they do not assert the default v7 contract. Public exports and new host tests exercise the real v7 default.
- [x] Packed isolated consumer checks cover root API v7 and the explicit drain subpath API v4, including strict consumer declarations.
- [ ] Final verification, task-linked PR, independent review, and human merge gate.

The orchestration is in `src/forgejo-provider.ts`; normalization/write decisions, durable state validation, and receipt validation are separated into `forgejo-v7-fields.ts`, `forgejo-v7-ledger.ts`, and `forgejo-v7-receipts.ts`. The retained internal v4 provider supplies lifecycle/storage wiring and original replay acknowledgment only to the explicit drain path; the normal v7 path never invokes its legacy pull/push. The drain is a separate bundle/registration, not an automatic downgrade. Full legacy regression tests remain internal, not an alternate public unrestricted v4 entrypoint.

New outbound creates durably journal uncertain/returned identities before link persistence. Ambiguous responses require explicit identity repair rather than duplicate creation or metadata guessing. Complete host push exports retain the existing local-deletion closure with workflow-only writes; provisional/unapplied imports are not interpreted as local deletion, and unavailable targets retain their identities. Detailed local-deletion comment cleanup remains separate work. Native host invocation guards do not lock subsequent asynchronous remote writes.

### Independent review follow-ups

The first review of PR #79 (`c9eefb7`) requested changes for five reproduced defects. The follow-up enforces complete unique authorized remote-assignment mappings and durable native assignment deferrals; gates ambiguous/returned-but-unlinked creations before discovery; restores missing repository-label provisioning before issue writes; allows bidirectional local-deletion closure without recreating the local task, retaining omitted comments independently of cursors; and validates new receipts/queued values with canonical v7 content/limits rather than the legacy snapshot shape validator. Postwrite checks also assert exact issue/source identity, and the fixture harness now waits for a fresh terminal host-status write rather than accepting a previous cycle's error.

Regressions were added before fixes and reproduced all five blockers, including both bidirectional/push-only assignment replacement, actual HTTP labels, ambiguous restart, returned-identity linking, and native malformed acknowledgment. Additional coverage checks deferred assignment across strategy/restart, explicit creation identity repair, missing-local comment replay, creation-label failure without false quarantine, postwrite identity substitution, journal cleanup after local deletion, and content normalization/size limits. The follow-up passes `./scripts/pre-pr.sh` (519 tests across 34 files), build, packed consumer checks, and diff checks. A fresh independent review and human merge approval are still required; no live operation or task closure is implied.

The second review independently confirmed those five fixes and identified two further lifecycle boundaries: comment-only pending replay after local deletion, and imported-task cleanup failure after item-link removal. The next follow-up revalidates every replayed task reference, keeps exact deferred original batches/comment provenance (including the latest captured comment if it subsequently disappears remotely), and persists cleanup before item-link removal for every real linked task. Repeated unchanged captures are deduplicated without rewriting the retained original. An additional isolated native probe found that remote source-URL assertions must not reject a uniquely identified legacy task whose local source URL is absent; only actually present local assertions are supplied, with strict post-fetch identity checks retained.

Native regressions cover real engine/provider restart for both review failures, external-ID-only equality adoption, and omitted comment edits/deletion before restoration. The follow-up passes the full pre-PR gate (525 tests / 34 files), build, packed consumer checks, and diff checks. A fresh independent review of the updated commit remains required before the human merge gate.

## Goal and boundaries

Adopt a field-group provider boundary for all four existing task groups without fabricated history, unsafe whole-task fallback, discarded replay batches, or unnoticed loss of ordinary imports. Preserve task/comment identity, independent read/write checkpoints, strategies, and restart recovery. Keep group-specific normalization/repair enhancements in their existing tasks except where shared partial-write plumbing is necessary for a usable cutover.

This task does not deploy the plugin, modify live state, implement issue-deletion confirmation, or change Todu core without separate authorization. It must not report deletion handling unblocked merely because a workflow payload is accepted.

## Revalidation against the completed Todu host work

### Source support versus published support

Todu main at `fcc7f690f5cff4522a43b7e971f9c98511672829` contains the completed API v7 host implementation from PR #573. Scoped identity/lifecycle support from PR #569 is also present. The canonical provider contract is Todu's `docs/plans/sync-api-v7-adoption.md`, together with `docs/plugin-sync-provider-api.md`, `packages/core/src/sync-initialization.ts`, and the actual daemon implementation. The unchecked review/merge checklist in the host plan is stale; task completion and the local main commit establish the merged state.

Registry metadata and actual downloaded npm tarballs agree on a separate distribution boundary: latest `@todu/core` 0.27.0, `@todu/daemon` 0.27.0, and `@todu/engine` 0.24.3 were published from `5aed44dfcede4008467f23f83da7a4ba7e91ce5b`, before the v7 merge. Published core declares latest API 6, and the downloaded daemon/engine have no v7 initialization or workflow-intent implementation. Upgrading to those versions alone does not unblock this task. No future package version is assumed. The tarball inspection is retained under `/tmp/forgejo-417bb5b9-host-audit-8TETxv`; these are temporary audit artifacts, not dependencies or shipped code.

Revalidation ran the existing native fixtures from Todu main: core initialization validation, daemon initialization, durable initialization/recovery, daemon workflow intent, and engine workflow intent. All 132 tests across five files passed. This verifies the source contract in disposable fixtures, not published v7 availability, a Forgejo adapter implementation, or live readiness. No dependency installation, live daemon/configuration/data changes, or production code edits were performed.

### What Option B now means concretely

| Earlier requirement       | Delivered host contract                                                                                                    | Forgejo responsibility                                                                                                                                                                    |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Safe local observation    | `context.observeTaskGroups`, scoped identity assertions, immutable canonical known/deferred groups, invocation-local token | Obtain the observation before fetching/revalidating authoritative remote initialization values; reject missing/ambiguous identity.                                                        |
| Unknown history           | Explicit `{ state: "unknown" }` versus `{ state: "known", value }`                                                         | Initialize only verified equality automatically. Preserve disagreements without local or remote writes and retain them for explicit resolution.                                           |
| Actual persisted outcomes | Ordered `bootstrapResults` and `taskResults`, actual IDs, persisted/deferred group receipts after guarded flush            | Validate receipts against the actual issued attempt; only mirrored receipts can advance a base without an additional verified remote write.                                               |
| Durable legacy recovery   | Required `recoveryState`; only exact ready admits v7 pull/push                                                             | Inspect the durable ledger, implement a bounded original-v4 drain, preserve original bytes/checkpoints, and block unreadable or unknown state. There is no automatic v4-to-v7 conversion. |
| Safe outbound groups      | `ExportedTaskInputV7.groups`, known/deferred envelopes and native pre-invocation freshness guards                          | Replace the flattened/full-issue write path; preserve deferred groups and remote fields and revalidate before asynchronous remote writes.                                                 |
| Confirmed cancellation    | Separate private local `integration.prepareWorkflowIntent` / `integration.confirmWorkflowIntent` RPCs                      | Leave confirmation, tombstone coordination, and operator command design to `task-f4d98619`; ordinary pull updates have no operator authority.                                             |

### Compatibility changes requiring explicit rollout disclosure

- Unknown-history disagreements remain unresolved, even in pull-only operation. Host support removes the need for manual equality initialization, not the need for an explicit policy/operator decision when values differ. Do not silently label preservation as completed reconciliation or introduce remote/local-wins defaults.
- V7 requires complete existing actor mappings and project authorization for assignment application, including bootstrap. It does not automatically create/authorize missing assignees to establish equality. Preserve unresolved remote assignments durably and retry after mapping/authorization changes; never turn them into empty/partial replacements. This is a deliberate compatibility boundary relative to legacy automatic assignee import and needs implementation-plan approval, not a hidden regression or new plugin-owned actor service.
- Content pending approval remains deferred. Bootstrap receipts can prove other groups while content is still unknown. Existing verbatim snapshots must not be silently rewritten to satisfy canonical trimming rules.
- Pull-only receives the required observations and receipts without push. Push-only receives grouped exports but no pull observation token or receipt: retain unknown disagreements, and establish history only through supported verified equality or verified permitted creation/writes, never by inventing a pull acknowledgment.
- Host receipts certify guarded local persistence against the provider's remote observation, not current remote freshness or durability. Local freshness guards end at callback invocation. The adapter still owns remote revalidation, durable pending writes, selective endpoint updates, and rechecking current intent during retries.
- V7 inherits v6 cancellation exclusions. Every pull must include `cancelledTaskExclusions`, empty when unused. Any cancellation-based omission needs a fresh scoped lifecycle token and must not overlap returned tasks/comments. This is not deletion evidence, an initialized baseline, or permission to suppress authentication/permission/transient failures.
- Existing pending v7 work needs fresh invocation tokens on every retry. Keep the original durable work and checkpoint; journal the actual attempt's remote observations separately so receipt validation cannot accidentally compare a fresh attempt to a different frozen remote value. Never reuse persisted observation or cancellation-exclusion tokens. The detailed attempt/journal design remains part of the implementation-plan gate.
- The required drain is bounded: freeze existing v4 work, use the original v4 host contract only for that work, and stop at its acknowledged boundary without new discovery or push. Define and test the concrete drain-only entrypoint/control before implementation. Do not use automatic downgrade, an unbounded old-provider sync loop, or a second process opening live engine storage.
- Cancellation uses a single-use, five-minute, revision-bound local preview/confirm token, exact identity/source assertions, explicit human confirmation, and a status-only mutation. It works without a baseline and after reopening but is not a sync payload or persistent cancellation permission. Detection remains ambiguous on 404, and durable tombstone/RPC ordering and crash recovery remain deletion-task design work.

The approved Option B still fits. No new host capability gap was identified in the bounded revalidation. Subsequently, actual published 0.28.0 core/daemon and 0.24.4 engine tarballs were inspected and confirmed to contain v7 initialization, readiness, receipts, and operator-intent support (release `8a5a96c`). Daemon 0.28.1 / engine 0.24.5 (`81b01fa`) retain that contract and include socket cleanup fixes. The user approved implementation against this updated combination; the original publication and plan-approval blockers are cleared. The earlier npm inspection above is historical evidence, not current availability.

## Original v5 investigation and evidence

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

## Original v5 adoption gaps (historical)

### Unknown baselines and local observation

Existing links can have no snapshots or only some groups. V5 does not accept an unknown `base`, and the provider's `pull(binding, project)` receives neither local task values nor a read-only local task service. An empty group update is not an observation request: acknowledgments report supplied outcomes only.

V4 acknowledgment proves batch application completed, not which whole-task values won. V5 bootstrap acknowledgment likewise does not return the persisted task values. An existing newer local task can survive a replay unchanged. Neither acknowledgment alone proves that the remote values now form a common baseline.

A successful push can establish some common values when complete host-exported values and a verified remote result agree. It is not a complete migration solution: pull-only bindings have no push, deferred assignments cannot be treated as an empty set, and a normal whole-record push must not first destroy a disagreement merely to create a baseline. New pull-only bootstrap records need a trustworthy persisted-value receipt or explicit initialization too.

### Pending v4 replay

A pending v4 batch can contain both new records and changes to existing records, possibly after partial local application. V5 cannot simply return that batch in `tasks`. Reclassifying all rows as bootstrap, clearing the batch, advancing cursors, or creating missing bases from its values can lose updates or erase local edits.

Without a host-assisted migration path, the safe operational alternative is to finish and acknowledge pending work using the v4 release before cutover. If pending v4 work is encountered after cutover, preserve it and refuse to guess; recovery must remain possible with the v4 release. This is an explicit drain requirement, not seamless v5 replay.

### Confirmed deletion is not ordinary last-write-wins

A workflow-only v5 update is supported when its baseline is known, but it is not an unconditional cancellation directive. In particular, `base=canceled`, `local=active`, `remote=canceled` is a local-only edit, so timestamp tie rules are not consulted and the host selects active. A newer divergent local workflow can also win a timestamp conflict.

Do not falsify a baseline or clock to make cancellation win. The deletion follow-up needs either a separately authorized status-only operator action, or a versioned host capability that represents confirmed operator intent without treating it as ordinary remote last-write-wins. These were alternative designs at the original investigation. The completed v7 host now supplies the separate guarded local operator action described above; the Forgejo confirmation/tombstone flow remains unimplemented.

## Assessed rollout options

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

Option B is selected, and its host source work is complete. Todu task `task-6daf1fb2` delivered v7 initialization, persisted-value receipts, legacy readiness/drain support, and the separate guarded local workflow RPC, building on `task-c5d79d45`. After a verified v7 distribution is available and the concrete plugin plan is approved, implement the adapter and run the published-host integration matrix. This plugin task does not authorize publishing/editing Todu core or deploying either project.

## Shared plugin implementation stages after design approval

### 1. Contract boundary and payloads

Require a verified published v7 core/engine/daemon combination and explicitly register `SYNC_PROVIDER_API_VERSION_V7` / `SyncProviderV7`, rejecting older hosts without fallback. Implement required `recoveryState` and consume grouped outbound exports as well as token-bearing pull updates and v7 receipts; a registration-only change is insufficient. Separate creates from linked updates; preserve all four ordinary field groups within the disclosed initialization/approval/mapping boundaries. Normalize content according to the actual host validation rules, label sets according to the existing snapshot contract, and assignments according to canonical mapped identities. Do not silently alter old verbatim content snapshots to fit host trimming rules; validate/reinitialize them under the approved policy.

### 2. Initialization and durable migration

Implement equality-only unknown-baseline initialization with fresh local observation followed by authoritative remote revalidation. Retain disagreements, approval-deferred groups, and incomplete assignments outside read progress. Implement a durable readiness gate and bounded original-v4 drain, not conversion under v7 or automatic downgrade. Version the pending batch schema explicitly, preserving old data and recovery paths; keep ephemeral tokens out of reusable state and bind receipts to the actual fresh attempt without overwriting original pending work. Never infer an initialized group merely from `lastMirroredAt`. Validate malformed, sparse, partially initialized, mismatched-identity, and deferred-assignment state.

### 3. Acknowledgment and partial writes

Validate both `bootstrapResults` and `taskResults`: count, ordering, actual local/external identities, supplied group membership, canonical values, and persisted/deferred/baseline states against the staged work and issued attempt. Do not expect v5 conflict/winner objects in the v7 receipt shape. Commit snapshots only when local persistence and any required remote mirror are verified. Persist required remote writes before committing pull progress; preserve newer local/exported intent during retry. Replace the ordinary full-issue builder in the grouped path with selective updates. Workflow/classification share Forgejo's label endpoint, so retain unrelated reserved/normal labels through a verified read/merge rather than clobbering another group. This necessary shared write isolation is included here; detailed repair policies stay in follow-up tasks.

### 4. Strategy and recovery coverage

Exercise pull-only, push-only, bidirectional, and disabled bindings; fresh bootstrap, established links, partial snapshots, mixed winners, and incomplete mappings. Test failed host apply/flush, interrupted remote writes, failed acknowledgment, stale receipts, partial v4 replay, and provider restart. Push-only must not invent host pull receipts or commit pull progress. Preserve independent comment sync and existing identity safety.

### 5. Documentation and review gates

Update architecture/storage compatibility and operational recovery documentation. Run format, lint, typecheck, tests, build, pre-PR checks, and relevant isolated dev checks. Open a task-linked PR and obtain independent review. Human merge approval and separate close-gate approval remain mandatory.

## Approved decision and next gate

The user selected Option B; both host prerequisites and the published-distribution gate are satisfied. The user approved the five-stage implementation plan, including deliberate initialization/assignment compatibility boundaries and a separately selected bounded v4 drain. Preflight passed and the task is `inprogress`. The deletion follow-up `task-f4d98619` remains waiting on plugin adoption.

Implement the adapter against the approved published v7 minimums, with durable attempt journaling and explicit v4 drain-only selection rather than automatic downgrade. Cancellation plumbing remains a documented/tested host prerequisite for the deletion follow-up, not authority added to ordinary pull. Next gates are local verification, task-linked PR, independent review, explicit human merge approval, and separately approved closure. Neither a live cutover nor the manual Option A workaround is selected.

The previous statement that no Todu change would be needed was too broad: known-baseline v5 updates require only plugin changes, but the investigated v5 interface does not itself provide the missing initialization/observation and authoritative cancellation semantics described above. Option B required that upstream change, and it is now complete in source; publication and Forgejo adoption remain separate gates.
