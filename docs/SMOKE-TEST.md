# Smoke Test Guide

Manual validation path for the Forgejo sync provider against a live Forgejo instance.

## Prerequisites

- Node.js 20+
- [overmind](https://github.com/DarthSim/overmind)
- `toduai` CLI installed
- A Forgejo instance with API access
- A Forgejo personal access token with repo permissions
- A test repository on the Forgejo instance

## Setup

### 1. Build the plugin

```bash
npm install
npm run build
```

### 2. Configure the dev environment

```bash
cp config/dev.toduai.yaml.template config/dev.toduai.yaml
make dev
```

### 3. Configure the plugin

```bash
make dev-cli CMD="plugin config forgejo --set '{\"settings\":{\"baseUrl\":\"https://your-forgejo.example.com\",\"token\":\"YOUR_TOKEN\",\"storageDir\":\"'\"${PWD}\"'/.dev/todu/forgejo-plugin-state\"},\"intervalSeconds\":30}'"
```

If migrating state from an old cwd-relative directory, add `legacyStorageDir` with the absolute old path for one startup. The provider moves `item-links.json`, `comment-links.json`, and `runtime-state.json` into `storageDir` without overwriting destination files.

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

### Pull: issue close

Close an issue in Forgejo. Verify the todu task status becomes `done`.

### Labels

- Verify `status:` and `priority:` labels are created in the repo automatically
- Verify custom labels (e.g., `bug`, `feature`) sync correctly
- Verify label changes in either direction propagate

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
