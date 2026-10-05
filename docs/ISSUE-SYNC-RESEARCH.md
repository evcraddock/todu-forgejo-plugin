# Todu–Forgejo Issue Sync Research

## Status

This document records the behavior verified in `todu-forgejo-plugin` at commit `cdf0008` and compares it with `docs/ARCHITECTURE.md`, the phase plans, `todu-github-plugin`, and the Todu sync-provider v3 host runtime. It describes current behavior separately from recommendations. No runtime changes are part of this research task.

## Executive summary

The plugin already supports a substantial bidirectional issue-sync workflow: bootstrap in both directions, durable task/issue links, title and body sync, status and priority labels, normal labels, actor-based assignees, comments, lifecycle transitions, retry state, and stale-link recovery. The implementation is more capable than the original architecture in some areas, especially outbound assignee handling and recovery from missing item-link state.

The main design gap is conflict handling. The architecture calls for field-group last-write-wins, but issue fields currently use whole-record timestamps and whole-record replacement. Comment conflicts are origin-sensitive rather than true comment-level last-write-wins. Unrelated edits can therefore overwrite each other, and the outcome depends on cycle order and which side originally created a comment.

The most urgent reliability gap is checkpoint ownership. Pull and push share one cursor and one `lastSuccessAt`; successful pushes advance values later used by remote issue and comment pulls. The provider also commits pull progress before the Todu host applies returned records. This creates windows where remote changes or failed host-side imports can be skipped. Active task `task-912aa03b` addresses one partial-failure cursor case, but the recommended design separates issue, comment, and push checkpoints and introduces host acknowledgment or periodic replay.

Other important gaps are inconsistent assignee policy, remote hard-deletion behavior, missing remote normalization writes, inability to clear an undefined Todu description, and heuristic duplicate reconciliation that can link unrelated records with identical metadata.

## Evidence reviewed

- `docs/ARCHITECTURE.md` and phase plans 2–5
- `src/forgejo-provider.ts`
- `src/forgejo-bootstrap.ts`
- `src/forgejo-fields.ts`
- `src/forgejo-comments.ts`
- `src/forgejo-links.ts`, `src/forgejo-comment-links.ts`, and `src/forgejo-ids.ts`
- `src/forgejo-runtime.ts` and `src/forgejo-loop-prevention.ts`
- `src/forgejo-client.ts` and `src/forgejo-http-client.ts`
- Corresponding unit and hardening tests
- Current `todu-github-plugin` field, bootstrap, provider, and test-matrix behavior
- Todu sync-provider v3 types and `packages/daemon/src/sync-worker-runtime.ts`
- Completed Forgejo project tasks concerning field sync, deletion, missing issues, actor sync, comment sync, and duplicate creation

## Current sync cycle

For a `bidirectional` binding, the Todu daemon runs pull before push. Pull returns normalized tasks and comments, the daemon applies them to Todu, then the daemon rebuilds export payloads from the resulting project state and calls push. `pull` and `push` strategies run only their named direction, while `none` runs neither.

The provider keeps binding-scoped item links, comment links, cursor/retry state, and in-memory loop-prevention writes. The daemon owns integration bindings, local task and note persistence, actor mappings, imported-content approval, and application of provider results.

## Current record linking and bootstrap

### Durable identity

A linked Forgejo issue uses the external ID `<normalizedBaseUrl>/<owner>/<repo>#<issueNumber>`. Including the instance URL makes the identity unique across self-hosted Forgejo instances. The task source URL is the issue HTML URL.

`item-links.json` stores `bindingId`, `taskId`, `issueNumber`, `externalId`, and an optional `lastMirroredAt`. Store writes enforce one task and one issue per link within a binding.

On pull, a previously unseen issue first receives a provisional link whose task ID is derived from `forgejo:<externalId>`. The Todu host then creates or updates a real local task by external ID. A later push replaces the provisional link with the actual local task ID.

### Forgejo to Todu bootstrap

The HTTP client lists issues with `state=all` and excludes pull requests. Initial bootstrap imports open issues. Closed issues are imported only when `binding.options.importClosedOnBootstrap` is true. Incremental pulls import changed linked issues regardless of open or closed state.

Each imported issue includes title, body, normalized status, normalized priority, non-reserved labels, assignee actor references, source URL, and remote timestamps. The Todu host upserts tasks by external ID within the bound project.

### Todu to Forgejo bootstrap

Unlinked tasks in `active`, `inprogress`, or `waiting` are eligible for issue creation. Unlinked `done` and `canceled` tasks are skipped. Already linked tasks can push any status, allowing close, cancel, and reopen transitions.

Before creating an issue, the plugin tries to reconcile the task by explicit external ID, Forgejo issue source URL, an imported `forgejo:` local task ID, or one unique issue with exactly matching title, body, state, and label set. Multiple exact metadata matches cause a skip. Recognized duplicate-create database errors are logged as a task-level skip so later tasks continue processing.

### Duplicate behavior

External ID and source URL matching are deterministic and safe when the configured instance and repository match. Exact metadata reconciliation helps recover after local link loss or an ambiguous create response, but it is still a heuristic: two unrelated records can legitimately have identical metadata. A unique metadata match is therefore not equivalent to durable identity.

A successful remote create followed by a crash before local link persistence is partly recoverable because the next cycle can find the exact metadata match. There is no remote idempotency key or provider marker that proves the issue was created for that task.

## Current field mapping

| Todu field or event        | Forgejo representation                                | Current direction      | Current behavior                                                                                                                                       |
| -------------------------- | ----------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Task identity              | Issue number plus instance/repository external ID     | Both                   | One durable link per task/issue within a binding                                                                                                       |
| Title                      | Issue title                                           | Both                   | Whole value replaced when the winning record is pushed or pulled                                                                                       |
| Description                | Issue body                                            | Both, with a clear gap | Markdown is preserved; an empty string clears, but `undefined` is omitted by the HTTP update and cannot clear an existing body                         |
| Status                     | Issue open/closed state plus `status:*` label         | Both                   | Open supports `active`, `inprogress`, `waiting`; closed supports `done`, `canceled`                                                                    |
| Priority                   | `priority:low`, `priority:medium`, or `priority:high` | Both                   | Missing remote priority imports as `medium`                                                                                                            |
| Normal labels              | Forgejo labels excluding `status:*` and `priority:*`  | Both                   | Push replaces the complete normalized label set and creates missing repository labels                                                                  |
| Assignees                  | Forgejo assignees and Todu actors                     | Both, partially        | Pull replaces local assignees; push sends mapped non-empty assignee lists, but an empty outbound list is omitted and cannot clear all remote assignees |
| Comments/notes             | Issue comments and task notes                         | Create/edit both ways  | Visible attribution and structured provenance are used; deletes do not propagate                                                                       |
| Due date and relationships | None                                                  | Local only             | Not in v1 scope                                                                                                                                        |

### Status normalization

For open issues, precedence is `active > inprogress > waiting`; without a recognized open label, status defaults to `active`. For closed issues, precedence is `done > canceled`; without a recognized closed label, status defaults to `done`. The Forgejo state determines whether an open or closed status is valid.

The pull path normalizes values only in the imported Todu task. It does not repair conflicting or missing reserved labels on Forgejo. In a bidirectional cycle, the immediately following push normally skips an equal-timestamp task, so malformed remote labels can remain indefinitely until a later local update triggers a full issue write.

### Priority normalization

Priority precedence is `high > medium > low`; no recognized label becomes `medium`. As with status, pull does not write the normalized priority label back to Forgejo.

### Assignee behavior differs from the architecture

The architecture and Phase 3 task say assignees are import-only. The v3 actor migration later added outbound assignees intentionally. The current code imports stable Forgejo account IDs, logins, and display names into core-owned actor mappings, and exports mapped local assignees using a login, display name, or account ID.

Outbound behavior is incomplete set replacement. A non-empty mapped list replaces Forgejo assignees, while zero outbound assignees produces `undefined`, causing the HTTP client to preserve existing Forgejo assignees. Unmapped local assignees are skipped by the Todu host, so a partial mapped list can also remove remote assignees that are not represented in the payload.

## Current lifecycle behavior

| Change                                                | Current result                                                                     |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------- |
| New open Forgejo issue                                | Creates a Todu task and durable link                                               |
| New eligible Todu task                                | Creates a Forgejo issue and durable link                                           |
| Forgejo issue closes without `status:canceled`        | Todu task becomes `done`                                                           |
| Forgejo issue closes with `status:canceled`           | Todu task becomes `canceled`                                                       |
| Forgejo issue reopens                                 | Todu task becomes the recognized open status, defaulting to `active`               |
| Linked Todu task becomes `done`                       | Forgejo issue closes with `status:done`                                            |
| Linked Todu task becomes `canceled`                   | Forgejo issue closes with `status:canceled`                                        |
| Linked Todu task returns to an open status            | Forgejo issue reopens with the corresponding status label                          |
| Todu task is hard-deleted                             | Forgejo issue closes with `status:canceled`; the item link is removed              |
| Forgejo issue is hard-deleted or becomes inaccessible | A comment-fetch 404 removes item and comment links; the local task is not canceled |
| Local note is deleted                                 | Remote comment remains; local comment link is removed                              |
| Remote comment is deleted                             | Local note and durable comment link remain                                         |

Remote hard deletion is not symmetric with local hard deletion. In a bidirectional binding, the still-active local task can be treated as unlinked during the same or next push and create a replacement Forgejo issue. A 404 caused by permissions is indistinguishable from deletion and can enter the same recovery path. This does not match the architecture statement that disappearance should map to local cancelation.

Hard-deleting a local task removes its item link but does not remove its comment-link records, leaving unreachable local plugin state.

## Current conflict behavior

### Issue fields

The documented design says field-group last-write-wins. The implementation instead uses one issue `updatedAt`, one task `updatedAt`, and one item-link `lastMirroredAt` for all non-comment fields.

The Todu host skips an imported issue when its remote timestamp is not newer than the local task timestamp. If it applies the issue, it replaces title, description, status, priority, labels, and assignees together. On push, the provider skips a linked task when the task timestamp is not newer than `lastMirroredAt`; otherwise it sends a full issue update. Timestamp comparison is performed as an ISO string comparison, so correctness assumes consistently normalized timestamp representations.

This is whole-record last-write-wins, not field-group last-write-wins. For example, a newer local title edit can overwrite a newer remote label intent if the local task timestamp wins overall. Likewise, a remote assignee change can overwrite an unrelated newer local description unless the local task timestamp causes the entire pull to be skipped.

### Comments

Comments have independent links and `lastMirroredBody` values, but conflict outcomes depend on origin. A linked Todu-origin comment encountered on pull is not imported; the remote body is recorded as the last mirrored body, and push can write the local body back. A Forgejo-origin comment is emitted on pull and can replace the local note through the Todu host. Local edits to an imported Forgejo note are pushed when the stripped body differs from the stored mirror.

The Todu host currently exports comment creation time but does not include a local note update time in its push payload, even though the provider interface supports one. The host also compares a pulled comment update against local note creation time. True comment-level last-write-wins is therefore not available end to end.

### Loop prevention

Issue and comment writes are recorded by entity ID and remote timestamp in an in-memory store. This reduces repeated writes during the running process, but it is not a durable conflict ledger and does not provide per-field merge history.

## Current cursor and failure behavior

The plugin keeps one binding runtime `cursor` and one `lastSuccessAt`. Pull uses the cursor for issue `since` and `lastSuccessAt` for comment `since`. Comment-only changes are found by querying every linked issue with a comment `since` filter.

A comment failure can save pending issue numbers and partial-progress diagnostics. Active task `task-912aa03b` correctly identifies that the current post-fetch local timestamp can advance beyond unobserved issue updates.

There are two broader checkpoint risks:

1. A successful push calls the same success function as pull and advances both the cursor and `lastSuccessAt`, even though push did not establish a remote-read checkpoint. In bidirectional mode this moves the next issue and comment `since` values to the end of push. In push-only mode it can move them through an arbitrarily long period before a later strategy change enables pull.
2. Pull saves provider success before the Todu daemon applies the returned tasks and comments. If host-side application fails, the provider has already advanced its checkpoint and updated item-link mirror timestamps. Forgejo lacks the periodic linked-issue reconciliation present in the current GitHub plugin, so the failed import may not be replayed.

These risks can silently skip records rather than merely retry them.

## Capability and gap summary

| Area                 | Existing capability                                                                   | Gap or inconsistency                                                                                                            |
| -------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Identity             | Instance-aware external IDs and source URLs                                           | Repository rename, instance URL migration, and duplicate local external IDs have no automated migration or diagnosis            |
| Bootstrap            | Open pull, active/inprogress/waiting push, optional closed pull                       | No explicit bootstrap completion state; behavior relies on cursors and links                                                    |
| Duplicate prevention | Explicit references, exact metadata recovery, duplicate-create isolation              | Exact metadata can false-link; repeated skipped conflicts have no durable quarantine state                                      |
| Field sync           | Title, body, status, priority, labels, and assignees                                  | Whole-record timestamps instead of field-group conflict handling                                                                |
| Normalization        | Deterministic status and priority mapping                                             | Pull does not repair malformed reserved labels remotely                                                                         |
| Assignees            | Structured actor import and partial export                                            | Docs say import-only; empty local set cannot clear remote; partial mappings can destructively replace                           |
| Lifecycle            | Close, cancel, reopen, and local hard-delete handling                                 | Remote hard deletion can recreate an issue instead of canceling the task; stale comment links remain after local task deletion  |
| Comments             | Bidirectional create/edit, attribution, structured provenance, non-propagating delete | Origin-sensitive conflicts, no end-to-end local edit timestamp, and body-based recovery can choose the wrong duplicate          |
| Checkpoints          | Incremental issue/comment reads, retry state, pending comment issues                  | Pull and push share checkpoints; provider commits before host apply; active partial-failure bug                                 |
| Validation           | Extensive in-memory unit and hardening tests                                          | `vitest.integration.config.ts` exists, but no real Forgejo `*.integration.test.ts` suite exists                                 |
| Documentation        | Detailed intended architecture                                                        | README still describes a minimal stub, assignee direction is stale, and architecture overstates conflict and deletion semantics |

## Proposed sync model

### 1. Keep external ID as canonical record identity

Retain `<normalizedBaseUrl>/<owner>/<repo>#<issueNumber>` and the 1:1 binding-scoped item link. Treat external ID, source URL, and an existing durable link as authoritative identity sources.

Do not automatically accept metadata equality as identity in steady state. Recommended behavior is to use exact metadata only as a recovery candidate: record the candidate and require either an explicit operator repair or a provider-created idempotency marker before linking. If automatic metadata recovery remains enabled, make it an explicit binding option and retain the current ambiguous-match skip.

Add migration tooling for base URL and repository rename changes so a configured identity change does not create a second set of issues.

### 2. Use explicit field groups and mirrored snapshots

Store the last successfully mirrored normalized value for each group in the item link or a dedicated item-sync record:

1. content: title and body
2. workflow: status plus issue state and status label
3. classification: priority and normal labels
4. assignment: assignee identities
5. comments: one snapshot and clock per linked comment

For each group, compare local and remote values with the last mirrored snapshot:

- neither changed: no-op
- one side changed: copy that side to the other
- both changed to the same normalized value: advance the snapshot without writing
- both changed differently: apply the configured conflict policy and record a diagnostic

Use side timestamps only after detecting that both sides changed. Forgejo exposes an issue-level timestamp, and Todu currently exposes a task-level timestamp, so timestamps can choose a deterministic winner but cannot prove which individual field changed last. A future host/provider contract can expose per-group clocks if exact field-level last-write-wins is required.

Recommended tie behavior is remote-wins for equal or missing timestamps during pull, because the cycle already reads remote first and this avoids an immediate unverified write. Record every true two-sided conflict with binding, task, issue, field group, both timestamps, and selected winner.

### 3. Adopt the following field directions

| Group                                            | Recommended direction                       | Notes                                                                                                                             |
| ------------------------------------------------ | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Title and body                                   | Bidirectional                               | Support explicit body clearing with `""`                                                                                          |
| Status and lifecycle                             | Bidirectional                               | State is authoritative for open versus closed; one normalized status label is written back                                        |
| Priority and normal labels                       | Bidirectional                               | Normalize to one priority label and preserve the complete shared normal-label set                                                 |
| Assignees                                        | Bidirectional only when mapping is complete | Preserve remote assignees and warn if any local assignee is unmapped; send an explicit empty list when a deliberate clear is safe |
| Comments                                         | Bidirectional create/edit                   | Keep deletes non-propagating in v1                                                                                                |
| Due dates, relationships, attachments, reactions | No sync                                     | Remain out of scope                                                                                                               |

This recommendation recognizes the actor-sync rollout rather than reverting to the now-stale import-only architecture. If complete assignee replacement cannot be made safe, choose import-only explicitly and remove outbound writes until the contract is ready.

### 4. Make lifecycle and deletion rules explicit

Keep close, cancel, and reopen mapping as implemented. Continue skipping creation of unlinked terminal tasks.

For a hard-deleted local task, close the issue with `status:canceled`, remove item and comment links, and retain an optional tombstone long enough to prevent immediate re-import.

For a confirmed hard-deleted remote issue, set the local task to `canceled`, retain a tombstone link that records remote deletion, and do not recreate automatically. Distinguish confirmed deletion from permission or transient errors where the API permits it. If a 404 remains ambiguous, block that item with a diagnostic rather than unlinking and recreating. Re-creation should require an explicit operator action.

Keep comment deletes non-propagating. A deleted comment should not delete the opposite record, and stale links should be retained or tombstoned only as needed to prevent accidental recreation.

### 5. Separate read checkpoints from write success

Maintain distinct binding state for:

- issue pull cursor
- comment pull cursor
- pending comment issue numbers
- last successful push
- retry state and failure phase

A push must never advance either pull cursor. Capture a pull boundary at sync start or use the maximum safely observed remote timestamp with a bounded overlap window. Deduplicate replayed items by external ID and timestamp.

Provider progress should be committed only after the host successfully applies pull results. The clean design is an acknowledgment or transactional checkpoint API in a future sync-provider contract. Until that exists, use overlap replay plus periodic reconciliation of linked issues and comments so a host-side apply failure is eventually repaired.

Expand `task-912aa03b` or add a companion task so the fix covers shared push/pull checkpoint state and host-apply failure, not only partial comment failures.

### 6. Make comment conflict handling symmetric

Persist the last mirrored normalized body and timestamps for both sides. Add local note `updatedAt` to the host export payload and compare it with Forgejo `updated_at` only when both bodies changed from the mirrored snapshot. Do not make one origin permanently authoritative.

Continue using structured provenance as canonical comment identity. Attribution and body matching should be legacy recovery only. If multiple candidates match, skip and emit a repair diagnostic instead of selecting the lowest comment ID.

## Open decisions for Erik

1. Should assignee sync remain bidirectional, as introduced by the v3 actor rollout, or return to the architecture's import-only policy? Recommendation: bidirectional only with complete actor mapping and explicit empty-list support.
2. Should unique exact metadata be allowed to auto-link an unlinked task, or should it produce an operator-approved repair candidate? Recommendation: require explicit identity by default.
3. What should happen when a remote issue is hard-deleted? Recommendation: cancel locally and tombstone the link; never recreate automatically.
4. Is remote-wins acceptable when a true two-sided field-group conflict has equal or missing timestamps? Recommendation: yes, with a diagnostic.
5. Should malformed remote reserved labels be repaired during pull even for a pull-only binding? Recommendation: no writes in pull-only; report normalization drift. In bidirectional mode, repair on the subsequent push without requiring an unrelated local edit.
6. Is a sync-provider API change acceptable to acknowledge host-side application before advancing cursors? Recommendation: yes; use overlap replay as an interim plugin-only mitigation.
7. Should repository or Forgejo base URL changes preserve identity through a migration command, or intentionally create a new binding namespace? Recommendation: provide an explicit migration command and never infer migration automatically.

## Recommended follow-up work

### Priority 0: prevent skipped remote changes

- Complete `task-912aa03b` with a safe pull boundary and pending-comment retry coverage.
- Split issue pull cursor, comment pull cursor, and push success state so push cannot advance remote-read checkpoints.
- Add replay or reconciliation coverage for a provider pull that succeeds but fails while the Todu host applies its results.

### Priority 1: align conflict and lifecycle semantics

- Add per-field-group mirrored snapshots and three-way reconciliation for content, workflow, classification, and assignment.
- Replace origin-sensitive comment conflict handling with snapshot-based comment reconciliation and end-to-end local note update timestamps.
- Implement a remote-deletion tombstone flow that cancels the local task and prevents automatic issue recreation.
- Remove stale comment links when a local task is hard-deleted.

### Priority 1: resolve unsafe mapping inconsistencies

- Decide and document assignee direction; implement complete mapped replacement or import-only behavior consistently.
- Support explicit remote body clearing when the Todu description is absent.
- Repair normalized reserved labels during bidirectional sync and surface drift without writing in pull-only mode.
- Change duplicate recovery so metadata matches are candidates rather than authoritative links, or gate automatic recovery behind a binding option.

### Priority 2: validation and operator support

- Add real Forgejo integration tests for bootstrap, field conflicts, assignee clear, remote deletion, comments, and cursor boundaries.
- Add diagnostics and repair commands for duplicate local external IDs, repository/base URL migration, ambiguous item matches, and ambiguous comment matches.
- Update `docs/ARCHITECTURE.md`, phase documentation, and README after decisions are made so they describe implemented behavior rather than the original design intent.

## Acceptance-criteria traceability

- Current issue-sync behavior and gaps are documented in the linking, field mapping, lifecycle, conflict, cursor, and capability sections.
- The proposed model covers canonical links, field mappings, lifecycle changes, duplicate policy, conflict handling, and failure checkpoints.
- Open decisions and prioritized implementation follow-ups are listed for Erik's review.
