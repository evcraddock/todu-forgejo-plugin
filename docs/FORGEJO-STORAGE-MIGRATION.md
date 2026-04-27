# Forgejo Storage Migration

Use this guide on each machine that has Forgejo plugin state in a repository-local or otherwise cwd-dependent directory.

The Forgejo plugin state files are:

- `item-links.json`
- `comment-links.json`
- `runtime-state.json`

The migration script moves only those files. It does not overwrite destination files, leaves unrelated files in the old directory, and removes the old directory only if it becomes empty.

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

## Troubleshooting

- `Legacy storage directory does not exist`: confirm the `--from` path is absolute and exists on this machine.
- `destination already exists`: the script refuses to overwrite existing files. Inspect both directories and decide manually which copy to keep.
- No task appears in `item-links.json`: confirm `storageDir` is configured, restart the daemon, then wait for one Forgejo sync interval.
- Forgejo plugin cycles run but files do not update: confirm the running daemon loaded the rebuilt plugin path and the configured `storageDir` matches the migration destination.
