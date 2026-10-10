# todu-forgejo-plugin

A sync provider for [todu](https://github.com/evcraddock/todu) that synchronizes Forgejo issues with tasks and mirrors comment creation/editing in both directions.

Implemented features include issue/task bootstrap, title and markdown body sync, status/priority labels, normal labels, mapped assignees, structured comment provenance, default/named Forgejo instances, durable links, binding-scoped retry state, and acknowledged pull replay. This is working sync functionality, not a minimal provider stub.

## Compatibility and limitations

- The plugin declares **sync-provider API v4**. Use a Todu daemon supporting v4 acknowledgment; this is independent of the npm package version.
- The runtime requires Node.js 20 or newer; source builds/versioning use Node.js 24.
- Issue fields still use whole-record timestamps/replacement; concurrent changes can overwrite unrelated fields. Optional field snapshots are storage foundations, not API v5 reconciliation.
- An absent Todu description does not clear the existing Forgejo body. Empty/partially mapped assignee exports are not yet complete safe set replacement.
- Missing/inaccessible remote issues can be recreated from local tasks. Metadata equality can currently relink unrelated records. Comment conflicts remain origin-sensitive; comment deletion does not propagate.

See [CHANGELOG.md](CHANGELOG.md) for capabilities and remaining limitations. Start new bindings in `pull` mode and inspect the imports before enabling bidirectional writes.

## Installation

### npm distribution

npm is the approved distribution channel. This source change prepares the release process; it does **not** publish a package. The commands below apply only after the selected version is actually available on npm:

```bash
# Set VERSION to an explicitly published version from the changelog.
npm install -g "todu-forgejo-plugin@$VERSION"
PLUGIN_ENTRY="$(npm root -g)/todu-forgejo-plugin/dist/index.js"
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
2. Back up Todu data and plugin state. Preserve `pendingPull`, links, snapshots, and checkpoint archives; never clear them merely to force sync.
3. With deployment approval, install an exact published version or build the reviewed source commit. When moving from a source path to npm, remove only the exact old configured entry so two copies do not declare the same provider.
4. Restart the daemon with separate approval, verify the reported plugin version and binding status, and follow the [smoke-test guide](docs/SMOKE-TEST.md).

Publishing does not update an installed plugin. Do not downgrade across storage schema changes without verified compatibility or an approved coordinated backup restore.

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

`package.json` owns the provider release version. Changesets prepares versions/changelogs locally; publishing requires separate approval. See [the release process](docs/release.md).

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Implementation plans](docs/plans/README.md)
- [Release process](docs/release.md)
- [Storage migration](docs/FORGEJO-STORAGE-MIGRATION.md)
- [Smoke tests](docs/SMOKE-TEST.md)

## License

MIT
