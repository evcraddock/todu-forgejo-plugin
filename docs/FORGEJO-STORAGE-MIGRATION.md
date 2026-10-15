# Forgejo Storage Migration

Use this guide on each machine that has Forgejo plugin state in a repository-local or otherwise cwd-dependent directory.

The Forgejo plugin state files are:

- `item-links.json`
- `comment-links.json`
- `runtime-state.json`
- `issue-tombstones.json` (optional until a confirmed deletion is recorded)
- `v4-drain.json` (the frozen legacy recovery boundary, created only by the explicit drain entrypoint)

The migration script moves only those files. It does not overwrite destination files, leaves unrelated files in the old directory, and removes the old directory only if it becomes empty.

## API v7 adoption and bounded v4 drain

This source uses explicit API v7. Supported minimum libraries are core 0.28.0, daemon 0.28.1, and engine 0.24.5; upgrade the supported host before selecting the v7 entrypoint. There is no automatic downgrade or v4-to-v7 payload conversion. Deploying, changing plugin paths/strategies, restarting services, and migrating live data each require separate operational approval; the development task does none of them.

1. Stop the sole sync owner with approval and back up the host data together with every plugin state file. Never run a second engine process against live storage or load both Forgejo entrypoints at once.
2. Inspect the protected `runtime-state.json` without publishing its imported content. If legacy `pendingPull` exists, select the explicit `@todu/forgejo/v4-drain` entrypoint (or its absolute bundled `dist/forgejo-v4-drain.js` path) instead of the normal entrypoint. Keep the same provider configuration, durable directory, binding/project/repository identity, and supported host. A push-only/disabled binding cannot drain until a separately approved strategy/enablement change permits pull.
3. On initialization, drain mode atomically creates `v4-drain.json`, including an empty boundary if no work exists. It records SHA-256 digests of the complete original pending batches. It serves only those batches through the original v4 contract, retaining their payloads, identities, timestamps, and checkpoint boundaries. It never discovers new issues/comments and never pushes, even for a bidirectional binding. Scope changes and changed/new batches fail before application. The frozen journal survives restart; do not delete it to admit later work.
4. Application, flush, acknowledgment failure, or restart leaves the original work recoverable. Retry the same bounded drain. Equal-clock legacy detail repair remains v4 behavior, not proof of per-group mirroring. Corruption, ambiguous provenance, or an unexpected batch requires explicit recovery; preserve every record rather than resetting cursors or guessing.
5. Only after captured legacy `pendingPull` is durably acknowledged, select the normal v7 entrypoint under separate cutover approval. Its required `recoveryState` blocks all v7 pull/push if legacy pending work exists or the ledger is unreadable/unknown. Keep the frozen drain journal in backups. Do not resume the old unrestricted v4 provider or downgrade after new v7 work has been staged.
6. Allow fresh group observations to establish equality without writes. A drained v4 batch, `lastMirroredAt`, or an old whole-record clock is not a field baseline. Resolve actual disagreements through separately authorized edits/policy, approve imported content through the normal host approval tools, and configure complete authorized actor mappings before expecting those groups to initialize. There is no implicit remote/local-wins initialization command.

### V7 durable replay and receipts

The outer checkpoint schema remains version 2. An optional `fieldSync` ledger tagged `version: 7` contains the scope, immutable original discovery/comment batch, current token-free issued attempt, unresolved `retryIssueNumbers`, independent `remoteWrites`, creation recovery journal, durable native-host `deferredAssignments`, `deferredCommentIssueNumbers` for unapplied missing-local comments, and last acknowledgment receipt. Missing `fieldSync` is an old installation with unknown field history, not a fabricated baseline. Existing legacy `pendingPull` remains separate and is never relabeled as v7 work. Malformed/sparse/mismatched state blocks recovery rather than resetting it.

Every eligible replay obtains a fresh local observation before rereading authoritative remote initialization values. Original pending bytes/IDs/cursors remain intact; the separately journaled actual attempt supplies the values against which receipts are checked. Observation/exclusion authority tokens are invocation-local and never saved for reuse. The opaque acknowledgment checkpoint includes the immutable original boundary ID/scope and a fresh attempt ID; stale-attempt acknowledgments cannot commit a newer attempt.

The host's ordered `bootstrapResults` and `taskResults` prove actual guarded, flushed local outcomes. New persisted values and queued writes are independently checked against v7 canonical content normalization and engine title/description limits; the historical snapshot validator is not sufficient and existing verbatim history is never silently trimmed to pass. The adapter validates counts, identities, supplied groups, canonical values, and persisted/deferred states before any progress. Only `baseline: mirrored` receipts matching that attempt's remote values advance a base without a remote write. Unknown disagreements, pending approval, unmapped assignments, and required remote writes remain durable independently of the committed issue/comment cursors. Acknowledgment saves this work before links/snapshots and saves read progress last; duplicate acknowledgments of the same committed attempt/receipt are harmless. Failed acknowledgment and interrupted commits remain replayable.

Push receives explicit known/deferred groups, not flattened potentially partial assignments. It reconciles fresh exports and remote observations against proven history, uses selective patches, preserves the other label group when workflow/classification share the labels endpoint, and verifies the remote result with a fresh read. Missing repository label definitions are provisioned before create/workflow/classification/closure writes, preserving ordinary sync support; the final remote reread follows label preparation. Partial endpoint failure retains unverified work; only verified groups with the exact issue/source identity advance. Remote assignment replacement requires complete unique authorized mappings for the entire observed remote set, not just complete local exports. A native assignment deferral persists across push/restart and is cleared only by a fresh successful pull receipt for that assignment; fixing mappings while staying push-only does not bypass it. Push success cannot commit a pull checkpoint or discard deferred work. Native host guards cover invocation, not a distributed lock during asynchronous API calls; read/revalidate/write is not an atomic Forgejo compare-and-swap or a remote durability guarantee.

Before a new outbound create, after label preparation succeeds, the adapter durably records an uncertain creation intent. A returned identity is journaled before link persistence. An uncertain journal blocks discovery/bootstrap as well as repeated create, including after bidirectional restart: a remotely successful lost response must not import a duplicate local task. Explicit canonical identity repair on the original task is verified against the remote before the journal can proceed; never use metadata guessing. A durably returned identity whose original task remains unlinked defers discovery for the supported bidirectional push-link acknowledgment first, without advancing pull cursors. Pull-only recovery requires explicit identity repair instead. Preserve the journal and remote issue while investigating. Deferred required create groups do not authorize empty defaults. Existing explicit external IDs/source URLs recover links without assuming a common field baseline.

### Existing local-deletion closure

Fresh scoped absence of an existing real local task suppresses bootstrap of that task, not the rest of the binding. Pull retains the original item/comment identities and durably defers that issue and its unapplied comments before acknowledging read progress. Staged provenance for omitted rows is not committed. If the task returns before closure, the deferred issue's comments are fetched without the global cursor so they are not silently skipped or duplicated. Complete current host push exports can then close an actually absent local task's known issue using a selective workflow-only patch, without assuming provisional/unapplied imports were deleted. Known creation journals also recover interruption between closure/link removal and cleanup. Existing comment-link cleanup remains separate work.

This preserves ordinary bidirectional pull-before-push local-deletion behavior. It is not remote-deletion detection, a remote-deletion tombstone, or permission to cancel any existing local task. Missing/inaccessible remote targets still preserve identity for explicit repair.

### Workflow-only deletion follow-up boundary

Ordinary known-baseline workflow updates use three-way reconciliation; they do not force cancellation after local reopening. The supported host separately exposes private local RPCs `integration.prepareWorkflowIntent` and `integration.confirmWorkflowIntent`. Preview asserts binding/task/external identity and the exact source URL when present; confirmation requires explicit human approval and a single-use, five-minute, revision-bound token. Success changes only status to `canceled` and the ordinary edit clock after guarded persistence/flush. Failure, expiry, restart, concurrent edits, or reuse require a new preview; do not persist/replay the token as standing authority.

This path works without a workflow baseline and after reopening. It is not provider pull authority, and a tombstone or HTTP 404 must not be fabricated into a v7 base/clock to force the outcome. Forgejo deletion detection, operator UI/command, tombstone/RPC ordering, crash recovery, and fresh cancellation-exclusion adoption remain `task-f4d98619`. No such operation is implemented or executed by adapter adoption. Issue/comment identity and history stay intact.

## Legacy runtime checkpoint schema upgrade

Acknowledged pull checkpoints upgrade unversioned and version 1 `runtime-state.json` records when the plugin reads them. This schema upgrade is independent of moving the storage directory and does not require running the directory-migration script. This describes the retained legacy v4 checkpoint foundation. The normal provider now uses v7; only the explicit bounded drain entrypoint processes old pending batches using v4 semantics.

- New records contain `checkpointVersion: 2`, `issuePullCursor`, `commentPullCursor`, `lastPushSuccessAt`, `pendingPull`, and `lastAcknowledgedPull`.
- Version 1 split pull cursors are archived in `preAcknowledgmentCheckpoint` and reset to null: they were recorded before host application and are not proof of local persistence. The known `lastPushSuccessAt` remains intact.
- Legacy `cursor` and `lastSuccessAt` values are retained in `legacyCheckpoint`; `lastSuccessAt` also remains an aggregate diagnostic. Legacy timestamps are not trusted as read checkpoints because they may have been advanced by a push.
- Both pull cursors and the unknown push-success timestamp start at null for legacy records. The first eligible pull rereads repository issues and linked comments without a `since` filter. Existing item/comment links and external identities remain in use; linked closed issues are still imported.
- Retry count, next retry time, pending comment issue numbers, errors, and failure/progress diagnostics are preserved. An outstanding backoff still delays the reread. Outstanding read diagnostics persist separately as `unresolvedPullFailure` so an intervening push failure cannot erase them. A later push success restores the read error; only successful pull acknowledgment clears it. Legacy errors with no recorded phase are retained conservatively with their phase still unknown, while explicit push-only failures without pending reads remain clearable by a successful push.
- Reads normalize records in memory without rewriting the file. The next ordinary save persists the upgraded records, and later restarts retain the separate checkpoints and archived legacy values. Unsupported checkpoint versions or malformed split timestamps fail explicitly rather than silently resetting progress.
- Push-only operation leaves pull cursors null until a real pull is acknowledged. Push success never advances read progress or clears unresolved pull work.
- Version 2 restarts retain the complete unacknowledged task/comment batch and token. Do not remove `pendingPull` to recover an application failure: the host must replay and acknowledge it. A fetched empty batch also requires acknowledgment; skipped pulls use a null token and do not commit progress.
- Runtime and link files use flushed, owner-only temporary files and atomic replacement. Acknowledgment commits staged link changes before the final runtime save. If a link or runtime replacement fails, retry/backoff and `pull:acknowledgment` diagnostics retain the batch; eligible pulls replay it and idempotent acknowledgment completes the commit. The runtime replay batch contains imported issue/comment content, so protect backups as carefully as host data.

Expect extra API reads on the first eligible pull after upgrade. Back up plugin state before deploying the upgrade, and preserve both the checkpoint version marker and legacy archive when inspecting or manually repairing records. Do not copy archived shared or pre-acknowledgment timestamps into the new pull cursor fields. This implementation task does not modify live state, deploy the plugin, or restart a daemon.

## Optional item field-group baselines

`item-links.json` supports an optional `fieldSnapshots` map for content, workflow, classification, and assignment. There is no new file to move and no additional runtime checkpoint-version change. Old links remain readable without snapshots; each missing group stays unknown until later reconciliation explicitly proves and saves a complete mirrored value. The storage foundation does not seed baselines from existing `lastMirroredAt` values or ordinary v4 pulls/acknowledgments.

Snapshot values use published core group types. Labels and stable assignee identities are deduplicated and sorted; an account ID takes precedence over login/display-name metadata, while login-only identities remain exact. Explicit empty values represent deliberately empty content/sets, not missing history. In-memory and file-backed stores share these rules and reject malformed snapshot data instead of silently resetting it. Metadata-only link updates and same-identity task-ID relinking preserve existing baselines. Acknowledgment preserves current baselines rather than reverting to the copies staged earlier.

Protect state backups: content baselines include the mirrored description. Keep snapshots with their binding and external identity during migration/repair. Do not copy baselines onto an unrelated repository or issue, or treat a legacy missing group as an empty value. V7 adoption uses these snapshots for shared independent reconciliation. Detailed field-specific repair policies remain separate follow-up tasks; unknown history is never silently rewritten to make it compatible with canonical content normalization.

## Issue-deletion tombstones

`issue-tombstones.json` stores binding-scoped confirmed-deletion evidence: `bindingId`, `taskId`, `externalId`, `issueNumber`, `deletedAt`, `reason`, and `source`. The provider selects a file-backed store under configured `settings.storageDir`, or an in-memory store when no storage directory is configured. Existing installations without this file load with an empty tombstone store; loading does not create the file or alter other state. File-backed records survive provider restart and use the same owner-only, flushed atomic writes as the other state files.

The exported tombstone stores support task, issue-number, and external-ID lookup; binding-scoped and global lists; save; and explicit removal by binding/task. Each binding permits one tombstone per task and remote issue. Identical saves are idempotent. Tombstones are immutable: a conflicting identity, timestamp, reason, or source fails explicitly without replacing existing evidence. Replacement requires explicit removal first. Malformed or conflicting files fail rather than silently resetting deletion history. Keep this file with the other state files during directory migration and backups.

This is a storage foundation only. It does not detect remote deletion, interpret a 404, cancel a Todu task, or suppress issue creation yet. Those behaviors belong to the deletion-handling follow-up. Only confirmed deletion may be recorded; an ambiguous 404 is not deletion evidence. Do not remove a tombstone casually: once the follow-up consumes these records, removal can permit recreation.

## Destination directory

Recommended durable destination paths:

- macOS: `~/Library/Application Support/todu/forgejo-plugin`
- Linux: `${XDG_STATE_HOME:-~/.local/state}/todu/forgejo-plugin`
- Windows: `%LOCALAPPDATA%\todu\forgejo-plugin`

The script defaults `--to` to the platform destination above. You can pass `--to` explicitly when you want a different absolute path.

## 1. Update the plugin checkout

On the machine being migrated, update the `todu-forgejo-plugin` checkout so the migration script is available:

```bash
git checkout main
git pull --ff-only
npm install
npm run build
```

## 2. Find the old storage directory

Look for old repo-local plugin state directories:

```bash
find ~/Private/code -type d \( -name '.todu-forgejo-plugin' -o -name '.todu-github-plugin' \) -print 2>/dev/null
```

Use the absolute path for the directory that contains the Forgejo plugin state files.

## 3. Dry-run the migration

Run the script without `--write` first:

```bash
npm run migrate:forgejo-storage -- \
  --from /absolute/path/to/old/.todu-forgejo-plugin
```

If your old directory has a different name, such as `.todu-github-plugin`, pass that exact absolute path:

```bash
npm run migrate:forgejo-storage -- \
  --from /absolute/path/to/old/.todu-github-plugin
```

To choose the destination explicitly:

```bash
npm run migrate:forgejo-storage -- \
  --from /absolute/path/to/old/.todu-forgejo-plugin \
  --to "$HOME/Library/Application Support/todu/forgejo-plugin"
```

Review the planned `MOVE`, `SKIP`, and `ERROR` lines before continuing.

## 4. Move the files

When the dry-run looks correct, rerun with `--write`:

```bash
npm run migrate:forgejo-storage -- \
  --from /absolute/path/to/old/.todu-forgejo-plugin \
  --write
```

Or with an explicit destination:

```bash
npm run migrate:forgejo-storage -- \
  --from /absolute/path/to/old/.todu-forgejo-plugin \
  --to "$HOME/Library/Application Support/todu/forgejo-plugin" \
  --write
```

## 5. Configure the daemon to use the migrated directory

Edit `~/.config/todu/config.yaml` and set Forgejo `storageDir` to the migrated location. Do not print plugin config in terminals or logs because plugin settings can contain tokens.

Example Forgejo config block:

```yaml
daemon:
  plugins:
    config:
      forgejo:
        settings:
          baseUrl: https://forgejo.example.com
          token: <existing-token>
          authType: token
          storageDir: "/Users/example/Library/Application Support/todu/forgejo-plugin"
```

Keep the existing token value; only add or update `storageDir`.

## 6. Restart the daemon

```bash
todu daemon restart
```

## 7. Verify sync uses the migrated storage

Check for a Forgejo plugin cycle after restart:

```bash
grep 'daemon.runtime.sync-plugin.forgejo' ~/.config/todu/data/daemon.out.log | tail -1
```

Check that migrated files update:

```bash
ls -l "$HOME/Library/Application Support/todu/forgejo-plugin"
```

To verify a specific task was linked after sync, search only for the task ID:

```bash
grep -R 'task-xxxxxxxx' "$HOME/Library/Application Support/todu/forgejo-plugin"
```

A match in `item-links.json` means the Forgejo plugin is writing link state to the migrated app-owned directory.

## Repair missing `item-links.json` entries

If `item-links.json` is missing or stale, first keep the affected binding in `pull` or `none` while inspecting state so the daemon does not create new remote issues during repair. Back up the current storage directory, then run one pull cycle with the corrected `storageDir`; open Forgejo issues are re-imported and the plugin rebuilds links for those issues. For existing local tasks that already have a Forgejo external ID or source URL, a later push cycle relinks the task before updating it. If the plugin logs an ambiguous metadata match, repair the item manually by adding a single JSON object with `bindingId`, `taskId`, `issueNumber`, `externalId`, and optional `lastMirroredAt`, or by restoring the entry from backup. Only return the binding to `bidirectional` after `item-links.json` contains the expected task/issue pair and a dry push cycle no longer reports skipped ambiguous creates.

## Troubleshooting

- `Legacy storage directory does not exist`: confirm the `--from` path is absolute and exists on this machine.
- `destination already exists`: the script refuses to overwrite existing files. Inspect both directories and decide manually which copy to keep.
- No task appears in `item-links.json`: confirm `storageDir` is configured, restart the daemon, then wait for one Forgejo sync interval.
- Forgejo plugin cycles run but files do not update: confirm the running daemon loaded the rebuilt plugin path and the configured `storageDir` matches the migration destination.
