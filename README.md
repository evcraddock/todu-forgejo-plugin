# todu-forgejo-plugin

A sync provider plugin for [todu](https://github.com/evcraddock/todu) that is intended to provide bidirectional synchronization between Forgejo issues and todu tasks.

The repository is currently scaffolded with a minimal provider stub so the project can build, test, and run under a local isolated `todu` daemon while the implementation is developed in phases.

## Installation

### 1. Clone and build

```bash
git clone https://github.com/evcraddock/todu-forgejo-plugin.git
cd todu-forgejo-plugin
npm install
npm run build
```

### 2. Install the plugin

```bash
todu plugin install /absolute/path/to/todu-forgejo-plugin/dist/index.js
```

This registers the plugin with the `todu` daemon. Use the actual path where you cloned the repo.

### 3. Configure plugin settings

Single-instance configuration uses one Forgejo base URL and token for all `forgejo` repository bindings:

```bash
todu plugin config forgejo --set '{"settings":{"baseUrl":"https://forgejo.caradoc.com","token":"forgejo_pat"},"intervalSeconds":300}'
```

Multi-instance configuration keeps one provider named `forgejo` and defines named Forgejo instances. Bindings without an instance option use `defaultInstance`.

```bash
todu plugin config forgejo --set '{"settings":{"defaultInstance":"forgejo","instances":{"forgejo":{"baseUrl":"https://forgejo.caradoc.com","token":"forgejo_pat"},"forge":{"baseUrl":"https://forge.caradoc.com","token":"forge_pat"}}},"intervalSeconds":300}'
```

Repository bindings continue to use `owner/repo` as `targetRef`. Select a non-default Forgejo instance through binding options:

```json
{
  "provider": "forgejo",
  "targetKind": "repository",
  "targetRef": "owner/repo",
  "options": {
    "instance": "forge"
  }
}
```

Each named instance supports `baseUrl`, `token`, and optional `authType` (`token` or `bearer`).

### 4. Verify

```bash
todu plugin list
todu integration list
```

## Development

### Prerequisites

- Node.js 20+
- [overmind](https://github.com/DarthSim/overmind) (process manager)
- `todu` CLI installed

### Setup

```bash
npm install
cp config/dev.todu.yaml.template config/dev.todu.yaml
```

### Dev environment

```bash
make dev          # Start all services
make dev-stop     # Stop all services
make dev-status   # Check status
```

This runs three processes via overmind:

- **build** — `tsc --watch` for type declarations
- **bundle** — `esbuild --watch` to produce `dist/index.js` with all dependencies inlined
- **daemon** — isolated `todu` daemon using the dev config

The dev environment uses a project-local data directory (`.dev/todu/data/`) separate from any production daemon.

### Common commands

```bash
make dev-cli CMD="plugin list"
make dev-cli CMD="daemon status"
make dev-logs
npm test
npm run typecheck
./scripts/pre-pr.sh
```

## Architecture

- [Architecture design](docs/ARCHITECTURE.md)
- [Implementation phase plans](docs/plans/README.md)

## License

MIT
