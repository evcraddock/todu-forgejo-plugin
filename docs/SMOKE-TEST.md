# Smoke Test Guide

Manual validation path for the Forgejo sync provider against a live Forgejo instance.

## Prerequisites

- Node.js 24 for source builds and development tooling (the installed provider runtime supports Node.js 20+)
- [overmind](https://github.com/DarthSim/overmind)
- `todu` CLI installed
- A Forgejo instance with API access
- A Forgejo personal access token with repo permissions
- A test repository on the Forgejo instance

## Setup

### 1. Build the plugin

```bash
npm ci
npm run build
```

### 2. Configure the dev environment

```bash
cp config/dev.todu.yaml.template config/dev.todu.yaml
make dev
```

### 3. Configure the plugin

Use an editor to add the following settings under `daemon.plugins.config` in the ignored `config/dev.todu.yaml`. Replace placeholders locally, keep the file owner-readable only, and never put a real token in shell history, logs, task comments, or tracked files. See the README's protected-configuration guidance.

```yaml
forgejo:
  settings:
    baseUrl: https://your-forgejo.example.com
    token: <test-repository-token>
    storageDir: /absolute/path/to/checkout/.dev/todu/forgejo-plugin-state
  intervalSeconds: 30
```

If migrating state from an old cwd-relative directory, use the migration script on each machine before starting the daemon with the new config. See [Forgejo Storage Migration](FORGEJO-STORAGE-MIGRATION.md) for the full repeatable procedure.

### 4. Create a project and integration binding

```bash
make dev-cli CMD="project create --name smoke-test"
make dev-cli CMD="integration add --provider forgejo --project smoke-test --target-kind repository --target owner/repo --strategy bidirectional"
```

### 5. Restart to pick up the config

```bash
make dev-stop && make dev
```

## Test Matrix

### Push: task creation

```bash
make dev-cli CMD="task create --project smoke-test --title 'Smoke test' --priority medium"
```

Wait one sync interval. Verify a new issue appears in the Forgejo repo with:

- correct title
- `status:active` label
- `priority:medium` label

### Push: field updates

```bash
make dev-cli CMD="task update <task-id> --priority high"
make dev-cli CMD="task update <task-id> --status inprogress"
make dev-cli CMD="task update <task-id> --title 'Updated title'"
```

Wait one sync interval after each. Verify the Forgejo issue reflects:

- `priority:high` label (replacing `priority:medium`)
- `status:inprogress` label (replacing `status:active`)
- updated title

### Push: description sync

Update the task description and verify it appears as the issue body.

### Push: close/reopen

```bash
make dev-cli CMD="task update <task-id> --status done"
```

Verify the issue closes with `status:done` label.

```bash
make dev-cli CMD="task update <task-id> --status active"
```

Verify the issue reopens with `status:active` label.

### Push: comment sync

Add a note to the task and verify it appears as a comment on the Forgejo issue with a todu attribution header.

### Pull: issue creation

Create an issue directly in the Forgejo UI. Wait one sync interval. Verify:

- a new task appears in the dev project
- title, status, priority, and labels are imported

### Pull: comment-only sync

After an issue is linked, add or edit a comment directly in Forgejo without changing the issue title, body, state, labels, or assignees. Wait one sync interval. Verify the comment is imported or updated in todu. This confirms comment polling does not rely on Forgejo updating the issue `updated_at` timestamp for comment-only changes.

### Pull: issue close

Close an issue in Forgejo. Verify the todu task status becomes `done`.

### Labels

- Verify `status:` and `priority:` labels are created in the repo automatically
- Verify custom labels (e.g., `bug`, `feature`) sync correctly
- Verify label changes in either direction propagate

## Missing-issue and duplicate-task regression

Run `npm test -- src/forgejo-identity-host.test.ts src/forgejo-access-host.test.ts src/forgejo-bootstrap-identity.test.ts src/forgejo-provider-hardening.test.ts src/forgejo-http-error.test.ts` for isolated missing-identity, retry/restart, comment-endpoint failure, and host link-application checks. These tests use temporary host/plugin storage and in-memory Forgejo clients; no live daemon or remote writes are needed. Missing linked issues must produce an explicit identity-repair error with unchanged original task IDs and links, no replacement issues/comments, and no duplicate task imports. The host must still reject conflicting returned external IDs and retain error status rather than reporting an end-to-end successful cycle.

Do not reproduce this scenario by deleting issues in an existing bound repository. If duplicates from an older version already exist, keep the affected binding disabled and follow the README's separately approved identity/data-repair procedure. Installing the fixed package alone does not reconcile those records.

## Monitoring

```bash
# Check integration status
make dev-cli CMD="integration status"

# View daemon logs
TMUX_SOCKET=$(find /tmp -name 'overmind-todu-forgejo-plugin-*' -type s 2>/dev/null | head -1)
tmux -S "$TMUX_SOCKET" capture-pane -p -t daemon -S -50

# List tasks in the test project
make dev-cli CMD="task list --project smoke-test"
```

## Teardown

```bash
make dev-stop
```

Remove `.dev/todu/` to reset all dev state.
