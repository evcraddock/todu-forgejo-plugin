# @todu/forgejo

A sync provider for [todu](https://github.com/evcraddock/todu) that synchronizes Forgejo issues with tasks and mirrors comment creation/editing in both directions.

Implemented features include issue/task bootstrap, title and markdown body sync, status/priority labels, normal labels, mapped assignees, structured comment provenance, default/named Forgejo instances, durable links, binding-scoped retry state, and acknowledged pull replay. This is working sync functionality, not a minimal provider stub.

## Compatibility and limitations

- This source declares **sync-provider API v7**. Minimum supported libraries are `@todu/core` 0.28.0, `@todu/daemon` 0.28.1, and `@todu/engine` 0.24.5. Older hosts fail registration rather than silently downgrading; the provider API is independent of the npm plugin version. This source change is not a new published Forgejo release.
- The runtime requires Node.js 20 or newer; source builds/versioning use Node.js 24.
- Content, workflow, classification, and assignment reconcile independently from verified mirrored snapshots. Unknown history initializes automatically only on equality; disagreements remain unresolved rather than choosing a winner or overwriting either side.
- Pending content approval and incomplete/unauthorized actor mappings defer the affected group. V7 does not automatically create/authorize missing assignees. Complete known empty descriptions/assignments are explicit values; deferred groups never become empty replacements. Field-specific repair/enhancement tasks remain separate.
- Missing/inaccessible linked issues block sync with an explicit identity-repair diagnostic, except a missing issue for a currently cancelled task during push is skipped; original task/comment links are retained and no replacement issue is created. This does not automatically clean up duplicates produced by older versions. V7 links by explicit identity, not metadata equality; an ambiguous outbound create is quarantined for explicit identity repair instead of retried blindly. Comment conflicts remain origin-sensitive; comment deletion does not propagate.

See [CHANGELOG.md](CHANGELOG.md) for capabilities and remaining limitations. Start new bindings in `pull` mode and inspect the imports before enabling bidirectional writes.

## Installation

### npm distribution

npm is the distribution channel for `@todu/forgejo`. Source version preparation does **not** publish a package. Install only a version verified as publicly available on npm:

```bash
# Set VERSION to an explicitly published version from the changelog.
npm install -g "@todu/forgejo@$VERSION"
PLUGIN_ENTRY="$(npm root -g)/@todu/forgejo/dist/index.js"
todu plugin install "$PLUGIN_ENTRY"
```

Registering the absolute entrypoint avoids differences between host versions' npm package-name resolution. The tarball includes the bundled provider and declarations; no source checkout is needed. Package checking installs into temporary local directories only, not globally or into your live daemon.

### Source builds (available now)

```bash
git clone https://github.com/evcraddock/todu-forgejo-plugin.git
cd todu-forgejo-plugin
npm ci
npm run build
todu plugin install /absolute/path/to/todu-forgejo-plugin/dist/index.js
```

Use the actual checkout path. Installation/configuration changes are activated on daemon restart; deploying or restarting a live daemon is separate from publishing a package.

### Configuration

Use a Forgejo instance URL and personal access token. Supply the actual token through your protected configuration workflow; do not put credentials in source files, shared logs, task comments, or shell history. The following configuration shapes use placeholders, not real tokens.

Single-instance plugin settings:

```json
{
  "settings": {
    "baseUrl": "https://code.example.com",
    "token": "<forgejo-pat>",
    "storageDir": "/absolute/path/to/durable/forgejo-state"
  },
  "intervalSeconds": 300
}
```

Multi-instance settings keep one provider named `forgejo`. Bindings without an instance option use `defaultInstance`:

```json
{
  "settings": {
    "defaultInstance": "primary",
    "instances": {
      "primary": {
        "baseUrl": "https://code.example.com",
        "token": "<primary-pat>"
      },
      "secondary": {
        "baseUrl": "https://forge.example.com",
        "token": "<secondary-pat>",
        "authType": "token"
      }
    },
    "storageDir": "/absolute/path/to/durable/forgejo-state"
  },
  "intervalSeconds": 300
}
```

Apply the protected settings with `todu plugin config forgejo --set "$CONFIG"`. Named instances support `authType` values `token` and `bearer`. Use durable `storageDir` for restart-safe links and replay batches; without it, provider state lasts only for the process lifetime. Relative directories resolve under the app-owned state root, not the daemon working directory.

Repository bindings use `owner/repo` as the target. Select a named instance through binding options:

```bash
todu integration add \
  --provider forgejo \
  --project "<project-name-or-id>" \
  --target-kind repository \
  --target "<owner/repo>" \
  --strategy pull \
  --options '{"instance":"secondary"}'
```

After a separately approved daemon restart, verify with `todu plugin list` and `todu integration list`. Confirm the repository imports correctly before switching with `todu integration set-strategy <binding-id> bidirectional`.

## Upgrades

1. Review the new version's changelog, host compatibility, and [storage migration guide](docs/FORGEJO-STORAGE-MIGRATION.md).
2. Back up Todu data and all plugin state. Preserve legacy `pendingPull`, v7 `fieldSync` work, `v4-drain.json`, links, snapshots, and checkpoint archives. Follow the [bounded v4 drain procedure](docs/FORGEJO-STORAGE-MIGRATION.md#api-v7-adoption-and-bounded-v4-drain) before cutover; never clear or relabel pending work merely to force sync.
3. With deployment approval, install an exact published version or build the reviewed source commit. When moving from a source path to npm, remove only the exact old configured entry so two copies do not declare the same provider.
4. Restart the daemon with separate approval, verify the reported plugin version and binding status, and follow the [smoke-test guide](docs/SMOKE-TEST.md).

Publishing does not update an installed plugin. Do not downgrade across storage schema changes without verified compatibility or an approved coordinated backup restore.

## Identity failures and duplicate-task recovery

A `Forgejo requires explicit identity repair` error means a linked issue/comment endpoint is unavailable or the exported task identity disagrees with plugin-owned storage. A 404 is not proof of deletion. Sync preserves known identities instead of creating a replacement issue or silently choosing another issue with matching metadata. The error remains visible during retry backoff and after restart; authentication and permission failures also retain blocked host-visible status without issuing new requests during backoff. HTTP response status is tracked separately from issue numbers. A skipped blocked operation is not an end-to-end successful sync.

During push, a currently cancelled task (`canceled` in the core API) with an unavailable issue is an acceptable no-op. A missing issue read or issue-update HTTP 404 skips that task and its comment push, preserving its references, notes, approvals/provenance, item/comment links, and snapshots while allowing other tasks to sync. Available linked issues still receive cancellation normally. Authentication/permission failures, rate limits, server errors, non-cancelled tasks, and conflicting identities remain errors. Skips are logged and re-evaluated from the current exported status each push; no cancellation or deletion tombstone is inferred or cached.

Missing linked comment endpoints remain blocking during pull, even after a cancelled push; a prior skip cannot safely prove current cancellation. V7 now supplies scoped current-task context, but this adapter does not yet submit cancellation-based exclusions. The deletion follow-up must explicitly adopt fresh scoped exclusion receipts and coordinate its operator confirmation/tombstone flow; blanket 404 suppression remains forbidden. This push fix handles cancelled tasks with external references but no saved plugin links, including the observed dotfiles blocker; it does not promise recovery of every cancelled linked task in a bidirectional or pull-only binding. Existing binding backoff is retained until the next eligible cycle; a successful push cannot clear an unresolved pull failure.

Disable the affected binding before investigating. Compare the original task's `externalId`/`sourceUrl`, remote issue, `item-links.json`, `comment-links.json`, and any pending pull batch. Keep backups of Todu data and plugin state. Existing duplicates require an explicitly approved repair: preserve original task IDs and all unique descriptions, notes, approval/provenance and link state before removing the exact duplicate records. Do not simply delete a duplicate while its remote issue can be imported again, clear plugin state, bypass the host's existing-link guard, or re-enable the binding to test a repair. Determine and reconcile the canonical identities first; remote deletion is a separate approval.

The provider's `lastPushSuccessAt` records remote push work only: API v7 task/comment link application follows provider return and has no provider push-application acknowledgment. Use `todu integration status <binding-id>` and daemon cycle logs for the host's end-to-end application result. A provider timestamp alone cannot establish successful host persistence.

## Development

Prerequisites: Node.js 24, npm, [overmind](https://github.com/DarthSim/overmind), and the `todu` CLI for the isolated dev daemon.

```bash
npm ci
cp config/dev.todu.yaml.template config/dev.todu.yaml
make dev
make dev-stop
make dev-status
```

Overmind runs declaration watch-build, bundled ESM watch-build, and an isolated Todu daemon using `.dev/todu/data/`, separate from production data.

```bash
make dev-cli CMD="plugin list"
make dev-cli CMD="daemon status"
make dev-logs
npm test
npm run typecheck
./scripts/pre-pr.sh
npm run build
npm run release:check
```

`package.json` owns the provider release version. Run `/skill:release` in Pi (or ask the assistant to release) to prepare an automatic stable increment, normally 0.1.1 → 0.1.2 → 0.1.3. The assistant manages Changesets and local version/changelog preparation; releases use `latest`, not prerelease suffixes. Publication retries keep the already prepared version. Merging a reviewed version PR to `main` publishes automatically through GitHub OIDC, without npm login/2FA or a second release approval. Already-published versions are skipped. See [the release process](docs/release.md).

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Implementation plans](docs/plans/README.md)
- [Release process](docs/release.md)
- [Storage migration](docs/FORGEJO-STORAGE-MIGRATION.md)
- [Smoke tests](docs/SMOKE-TEST.md)

## License

MIT
