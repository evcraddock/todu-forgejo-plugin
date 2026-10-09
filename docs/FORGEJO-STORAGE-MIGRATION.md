# Forgejo Storage Migration

Use this guide on each machine that has Forgejo plugin state in a repository-local or otherwise cwd-dependent directory.

The Forgejo plugin state files are:

- `item-links.json`
- `comment-links.json`
- `runtime-state.json`

The migration script moves only those files. It does not overwrite destination files, leaves unrelated files in the old directory, and removes the old directory only if it becomes empty.

## Runtime checkpoint schema upgrade

The read/write checkpoint split upgrades unversioned `runtime-state.json` records when the plugin reads them. This schema upgrade is independent of moving the storage directory and does not require running the directory-migration script.

- New records contain `checkpointVersion: 1`, `issuePullCursor`, `commentPullCursor`, and `lastPushSuccessAt`.
- Legacy `cursor` and `lastSuccessAt` values are retained in `legacyCheckpoint`; `lastSuccessAt` also remains an aggregate diagnostic. Legacy timestamps are not trusted as read checkpoints because they may have been advanced by a push.
- Both pull cursors and the unknown push-success timestamp start at null for legacy records. The first eligible pull rereads repository issues and linked comments without a `since` filter. Existing item/comment links and external identities remain in use; linked closed issues are still imported.
- Retry count, next retry time, pending comment issue numbers, errors, and failure/progress diagnostics are preserved. An outstanding backoff still delays the reread. Outstanding read diagnostics persist separately as `unresolvedPullFailure` so an intervening push failure cannot erase them. A later push success restores the read error; only successful pull clears it. Legacy errors with no recorded phase are retained conservatively with their phase still unknown, while explicit push-only failures without pending reads remain clearable by a successful push.
- Reads normalize records in memory without rewriting the file. The next ordinary save persists the upgraded records, and later restarts retain the separate checkpoints and archived legacy values. Unsupported checkpoint versions or malformed split timestamps fail explicitly rather than silently resetting progress.
- Push-only operation leaves pull cursors null until a real pull succeeds. Push success never advances read progress or clears unresolved pull work.

Expect extra API reads on the first eligible pull after upgrade. Back up plugin state before deploying the upgrade, and preserve both the checkpoint version marker and legacy archive when inspecting or manually repairing records. Do not copy archived shared timestamps into the new pull cursor fields. This implementation task does not modify live state, deploy the plugin, or restart a daemon.

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
