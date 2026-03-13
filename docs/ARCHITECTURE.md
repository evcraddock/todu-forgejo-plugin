# Architecture

## Status

Draft

## Summary

`todu-forgejo-plugin` should be a `syncProvider` plugin for `toduai` that synchronizes one Forgejo repository with one todu project.

The design intentionally mirrors `todu-github-plugin` as closely as practical so implementation can reuse the same mental model, module boundaries, and operator workflow:

- plugin installed into the todu daemon
- shared integration bindings managed by core todu
- daemon-driven polling sync
- plugin-owned local storage for links, cursors, and retry state
- bidirectional synchronization for issues/tasks and comments/notes

The main required divergence from the GitHub plugin is that Forgejo is self-hosted and instance-specific. That affects configuration, durable external IDs, HTTP client behavior, and compatibility/rate-limit assumptions.

## Goals

- Reuse the architecture and module split from `todu-github-plugin` wherever it remains valid.
- Support bidirectional synchronization between Forgejo issues and todu tasks.
- Preserve parity for title, body, status, priority, labels, comments, and assignee import.
- Keep the operator workflow nearly identical to the GitHub plugin.
- Isolate Forgejo-specific differences to config, ID handling, and HTTP client/API mapping.
- Produce a design that can be split into follow-up implementation tasks without major unknowns.

## Non-Goals for v1

- Multiple Forgejo instances from one plugin configuration.
- Webhook-driven sync.
- Pull request synchronization.
- Milestones, projects, due dates, reactions, attachments, or issue relationships.
- Full bidirectional assignee management.
- A shared generic SCM provider abstraction across GitHub and Forgejo before the Forgejo plugin exists.

## Design Principles

1. **Match the GitHub plugin first.** Prefer copying proven shapes over inventing new ones.
2. **Keep the provider boundary clean.** Shared integration binding state stays in core todu; provider runtime state stays local to the plugin.
3. **Optimize for deterministic sync.** Explicit mappings and normalization beat inference.
4. **Support self-hosted reality.** Instance URL, auth behavior, and rate limits vary across Forgejo deployments.
5. **Defer abstraction.** Build a working Forgejo plugin first; generalize common pieces later if duplication becomes painful.

## Architecture Overview

```text
core todu integration bindings/status
        │
        ▼
forgejo-provider
  ├─ forgejo-config          load plugin config
  ├─ forgejo-binding         validate provider/target and parse owner/repo
  ├─ forgejo-http-client     Forgejo REST API adapter
  ├─ forgejo-bootstrap       issue/task bootstrap and steady-state item sync
  ├─ forgejo-fields          field mapping and normalization
  ├─ forgejo-comments        note/comment mirroring
  ├─ forgejo-links           task↔issue durable links
  ├─ forgejo-comment-links   note↔comment durable links
  ├─ forgejo-runtime         cursor, retry, backoff state
  ├─ forgejo-loop-prevention write bookkeeping
  ├─ forgejo-binding-status  runtime state projection
  └─ forgejo-logger          structured logs
```

## Comparison to `todu-github-plugin`

### Reuse almost directly

These modules should port with mostly mechanical renaming and small type changes:

- binding parsing and validation
- bootstrap orchestration
- field mapping and normalization rules
- item link store
- comment link store
- comment attribution format
- binding runtime state and retry logic
- loop prevention store
- binding status projection
- structured logging
- provider `pull` / `push` orchestration

### Rewrite or materially adapt

These areas need real Forgejo-specific work:

- HTTP client implementation
- configuration loading and validation
- external ID format and parsing
- source URL generation
- pagination and API contract mapping
- auth header handling
- optional assignee compatibility shims across Forgejo versions/instances

## Binding Model

### Cardinality

Keep the same model as the GitHub plugin:

- one Forgejo repository ↔ one todu project
- a todu project has at most one Forgejo binding
- a Forgejo repository has at most one todu binding

### Shared integration binding

Use the generic todu integration control plane rather than plugin-owned binding commands.

Example:

```bash
toduai integration add \
  --provider forgejo \
  --project my-project \
  --target-kind repository \
  --target owner/repo \
  --strategy bidirectional
```

Expected binding fields:

- `provider = forgejo`
- `targetKind = repository`
- `targetRef = owner/repo`
- `projectId`
- `strategy = bidirectional | pull | push | none`
- `enabled`
- timestamps and binding id

### Why `targetRef` stays `owner/repo`

This preserves the GitHub plugin UX and keeps repo selection simple. The Forgejo instance itself comes from plugin config rather than from each binding.

### v1 instance model

v1 assumes one configured Forgejo base URL per plugin installation.

Implication:

- one daemon/plugin config talks to one Forgejo instance
- many repo bindings on that instance are allowed
- multiple Forgejo instances require separate plugin configs/daemons today, or a future per-binding instance field

This keeps v1 aligned with the GitHub plugin's single-host assumption while still supporting self-hosted Forgejo.

## Authentication and Configuration

## Required plugin settings

Recommended config shape:

```json
{
  "enabled": true,
  "intervalSeconds": 300,
  "retryInitialSeconds": 5,
  "retryMaxSeconds": 300,
  "settings": {
    "baseUrl": "https://code.example.com",
    "token": "<forgejo-pat>",
    "storageDir": ".todu-forgejo-plugin"
  }
}
```

### Settings

- `settings.baseUrl` — required. Base web URL for the Forgejo instance. The plugin derives API paths from this.
- `settings.token` — required. Personal access token used for all bindings.
- `settings.storageDir` — optional. Directory for plugin-owned local state. When omitted, the provider keeps local state in memory for the current process only.

### Derived local files

Inside `storageDir`, the plugin should keep separate files or equivalent DB collections for:

- item links
- comment links
- binding runtime state
- optional diagnostics/error snapshots

### Authentication differences vs GitHub

Forgejo diverges here:

- GitHub vends one stable public API host and version headers.
- Forgejo is instance-local and may vary by version or deployment.
- Some Forgejo/Gitea-compatible installations accept `Authorization: token <PAT>`, others also support bearer tokens.

Recommendation:

- default to `Authorization: token <PAT>`
- allow a small internal compatibility layer if an instance requires `Bearer <PAT>`
- do not require GitHub-style API version headers

### API base URL derivation

The plugin should derive the API base from `baseUrl`:

```text
apiBaseUrl = <normalized baseUrl> + /api/v1
```

This supports both root-hosted and subpath-hosted Forgejo installs as long as `baseUrl` is the user-facing root.

## Durable Identity

## External ID

GitHub can use `owner/repo#number` because the host is fixed. Forgejo cannot.

Recommended Forgejo external ID format:

```text
<normalizedBaseUrl>/<owner>/<repo>#<issueNumber>
```

Example:

```text
https://code.example.com/evcraddock/todu-forgejo-plugin#1
```

Why this format:

- globally unique across Forgejo instances
- still human-readable
- remains close to the GitHub plugin's `owner/repo#number` shape
- works for subpath-hosted instances

### Source URL

Source URL should remain the issue HTML URL:

```text
<normalizedBaseUrl>/<owner>/<repo>/issues/<issueNumber>
```

### Internal link state

Keep the same logical stores as the GitHub plugin:

- `item_links`: binding id, task id, issue number, external id
- `comment_links`: binding id, task id, note id, issue number, comment id
- `binding_runtime_state`: cursor, retry, timestamps, last error

## Sync Scope

### Included in v1

- repository issues
- title and markdown body
- state/status mapping
- priority mapping
- normal labels
- comments/notes create, edit, delete
- assignee import from Forgejo into todu
- bootstrap plus incremental polling sync

### Excluded in v1

- pull requests
- milestones
- due dates
- issue dependencies/relations
- attachments
- reactions
- review workflows

## Data Model Mapping

## Task / issue mapping

| todu             | Forgejo                      | Notes                        |
| ---------------- | ---------------------------- | ---------------------------- |
| Task             | Issue                        | 1:1 link once bound          |
| Title            | Title                        | bidirectional                |
| Description      | Body                         | markdown on both sides       |
| Status           | Issue state + reserved label | same scheme as GitHub plugin |
| Priority         | Reserved label               | same scheme as GitHub plugin |
| Labels           | Labels                       | non-reserved only            |
| Comments / notes | Issue comments               | strict 1:1 mirror            |
| Assignees        | Assignees                    | import only in v1            |
| Due date         | none                         | stays local to todu          |

## Status mapping

Keep the GitHub plugin's status model unchanged.

Reserved labels:

- `status:active`
- `status:inprogress`
- `status:waiting`
- `status:done`
- `status:canceled`

State mapping:

| Forgejo issue state | status label        | todu status  |
| ------------------- | ------------------- | ------------ |
| open                | `status:active`     | `active`     |
| open                | `status:inprogress` | `inprogress` |
| open                | `status:waiting`    | `waiting`    |
| closed              | `status:done`       | `done`       |
| closed              | `status:canceled`   | `canceled`   |

Normalization rules stay the same:

- open issues normalize to one open status label
- closed issues normalize to `status:done` or `status:canceled`
- if multiple status labels exist, precedence is deterministic
- if issue state conflicts with label, state wins and the label is rewritten

## Priority mapping

Keep the same reserved labels:

- `priority:low`
- `priority:medium`
- `priority:high`

Rules:

- sync bidirectionally
- normalize to exactly one label
- precedence: `high > medium > low`

## Normal labels

All labels that are not `status:*` or `priority:*` sync bidirectionally.

If a label exists in todu but not in the Forgejo repository, the plugin should create the label before assigning it.

## Assignees

Assignee sync remains asymmetric in v1:

- Forgejo assignees → imported into todu
- todu assignees → not pushed to Forgejo

Reason:

- this matches the GitHub plugin's simpler operator model
- Forgejo assignee APIs and permissions may vary slightly by version/instance
- delaying push support reduces risky write behavior early on

If an instance only supports one assignee, the plugin should treat it as a one-element list when importing.

## Comments / notes

Use the same strict mirrored model as `todu-github-plugin`:

- one Forgejo comment ↔ one todu note
- create syncs both ways
- edit syncs both ways
- delete syncs both ways

Use visible attribution headers, unchanged except for the provider name:

```md
_Synced from Forgejo comment by @alice on 2026-03-11T20:00:00Z_

Original comment body.
```

```md
_Synced from todu comment by @bob on 2026-03-11T20:05:00Z_

Original note body.
```

This keeps mirrored comments understandable when viewed outside the plugin.

## Sync Lifecycle

## 1. Binding created

When a shared integration binding is created:

1. core todu persists the binding
2. daemon loads the Forgejo plugin
3. plugin validates config and binding
4. plugin begins bootstrap for that binding

## 2. Bootstrap pull: Forgejo → todu

On first sync, import all open issues for the bound repo.

Rules:

- create item links for unseen issues
- skip already linked issues only if they are already represented locally
- closed issues are ignored during first import unless already linked and seen later through incremental sync
- import comments for linked items after issue/task links are established

## 3. Bootstrap push: todu → Forgejo

Export all tasks in the bound project with status:

- `active`
- `inprogress`
- `waiting`

Do not export tasks already marked:

- `done`
- `canceled`

If a task already has a matching Forgejo external ID for the same instance/repo, create the durable link instead of opening a duplicate issue.

## 4. Steady-state polling

Each polling cycle processes the binding according to strategy:

- `bidirectional`: pull then push
- `pull`: import only
- `push`: export only
- `none`: no sync work

### Pull path

- list issues updated since the last successful checkpoint
- refresh linked item field state
- discover newly created open issues
- list comments for linked issues
- mirror comment creates/edits/deletes into todu
- normalize reserved labels/state if needed

### Push path

- inspect local task changes supplied by the host
- create issues for newly eligible unlinked tasks
- update linked issues when task state wins conflict resolution
- create/update/delete mirrored comments
- update links and loop-prevention bookkeeping

## Conflict Resolution

Use the same high-level rule as the GitHub plugin: **field-group last-write-wins**, not whole-item last-write-wins.

Field groups:

1. title/body
2. status/priority/labels
3. comments

Rationale:

- a new comment should not overwrite a newer title change
- label normalization should not erase a newer description update
- comment edit resolution needs comment-level timestamps, not issue-level timestamps alone

## Deletion Semantics

Do not hard-delete linked items across systems.

Deletion or disappearance of the linked issue/task maps to cancelation:

- Forgejo issue target becomes closed + `status:canceled`
- todu task target becomes `canceled`

Comments remain the exception: mirrored comment deletes propagate as hard deletes to preserve 1:1 comment state.

## Polling, Retry, and Observability

## Polling

- default interval: 300 seconds
- interval configurable in plugin config
- each binding keeps independent cursor and retry state

## Retry

Reuse the GitHub plugin's per-binding exponential backoff model:

- retry attempt count
- next retry timestamp
- last error
- last success timestamp

Forgejo-specific note: do not assume GitHub-style rate-limit headers. Treat these as retriable when appropriate:

- `429`
- temporary `5xx`
- transport failures
- instance maintenance windows

If `Retry-After` is present, honor it; otherwise use local exponential backoff.

## Observability

Shared binding status surfaced through `toduai integration status` should include:

- binding id
- state: `running | idle | blocked | error`
- last attempted sync
- last successful sync
- last error summary
- updated timestamp

Local logs should include at minimum:

- binding id
- project id
- repo
- sync direction
- entity type
- item identifier
- failure reason

## Forgejo-Specific Differences from GitHub

## 1. Host is not fixed

GitHub plugin assumption:

- host is always `github.com`

Forgejo plugin requirement:

- require `baseUrl`
- derive API and source URLs from config
- include instance identity in `external_id`

## 2. API compatibility is close, not identical

Expected similarities:

- issues and comments endpoints are conceptually similar
- open/closed state and labels map cleanly
- issue numbers are repo-scoped integers

Expected differences to handle explicitly:

- API base path is `/api/v1`
- pagination parameters may differ from GitHub conventions
- auth header handling may vary across versions/installations
- response shapes may be Gitea/Forgejo-specific rather than GitHub-specific
- rate limiting may be absent, proxy-defined, or instance-defined

## 3. Webhooks are less attractive for v1

GitHub has a strong webhook story for public SaaS use. Forgejo is often self-hosted behind private networks, so webhook setup can be awkward.

Recommendation for v1:

- use polling only
- keep architecture compatible with adding optional webhook triggers later
- do not block implementation on inbound webhook infrastructure

## 4. Assignee and capability variance

Different Forgejo instances may vary by version or admin settings.

Recommendation:

- support the core issue/comment/label workflow only
- treat advanced capability detection as future work
- fail clearly when a required endpoint or permission is unavailable

## Proposed Module Layout

Mirror the GitHub plugin layout one-for-one:

```text
src/
  forgejo-binding.ts
  forgejo-binding-status.ts
  forgejo-bootstrap.ts
  forgejo-client.ts
  forgejo-comment-links.ts
  forgejo-comments.ts
  forgejo-config.ts
  forgejo-fields.ts
  forgejo-http-client.ts
  forgejo-ids.ts
  forgejo-links.ts
  forgejo-logger.ts
  forgejo-loop-prevention.ts
  forgejo-provider.ts
  forgejo-runtime.ts
  index.ts
```

### Boundary notes

- `forgejo-client.ts` defines provider-local types and interface, independent of raw REST responses.
- `forgejo-http-client.ts` is the only module that knows actual Forgejo endpoint shapes.
- `forgejo-provider.ts` orchestrates strategies, bootstrap, retry, and loop prevention.
- Stores remain provider-local and file-backed initially, matching the GitHub plugin approach.

## Migration / Reuse Plan

## Adapt directly first

These GitHub modules should be copied and renamed first, then minimally edited:

- `github-binding.ts` → `forgejo-binding.ts`
- `github-binding-status.ts` → `forgejo-binding-status.ts`
- `github-bootstrap.ts` → `forgejo-bootstrap.ts`
- `github-comment-links.ts` → `forgejo-comment-links.ts`
- `github-comments.ts` → `forgejo-comments.ts`
- `github-fields.ts` → `forgejo-fields.ts`
- `github-links.ts` → `forgejo-links.ts`
- `github-logger.ts` → `forgejo-logger.ts`
- `github-loop-prevention.ts` → `forgejo-loop-prevention.ts`
- `github-runtime.ts` → `forgejo-runtime.ts`
- large parts of `github-provider.ts`

## Rewrite second

These pieces should be reimplemented with Forgejo semantics:

- `forgejo-config.ts`
- `forgejo-http-client.ts`
- `forgejo-ids.ts`
- any source URL helpers inside bootstrap/client code

## Do not refactor shared abstractions yet

Avoid starting with a cross-provider refactor that tries to unify GitHub and Forgejo into a common SCM library. That increases scope and risk before behavior is proven.

A later cleanup can extract shared pieces once both providers exist and real duplication is visible.

## Testing and Validation Plan

## 1. Unit tests for pure logic

Port the GitHub plugin's logic tests first for:

- binding parsing
- external ID formatting/parsing
- status normalization
- priority normalization
- label filtering/merging
- retry/backoff calculations
- loop-prevention bookkeeping
- comment attribution stripping/formatting

## 2. In-memory provider tests

Keep an in-memory Forgejo client equivalent to the GitHub in-memory client for deterministic provider tests:

- bootstrap import of open issues
- bootstrap export of active tasks
- linking existing external IDs
- bidirectional field sync
- comment create/edit/delete mirroring
- strategy gating: `pull`, `push`, `none`

## 3. HTTP contract tests

Add focused tests around `forgejo-http-client.ts` that verify:

- request paths
- auth headers
- pagination handling
- response mapping into provider types
- error handling for 401/403/404/429/5xx

These can use mocked HTTP responses rather than a live server.

## 4. Disposable integration tests against real Forgejo

Add a small end-to-end suite against a disposable local Forgejo instance.

Recommended scenarios:

1. create repo binding and bootstrap open issues into todu
2. create local task and verify issue creation
3. change issue state/labels and verify task update
4. add/edit/delete comments on both sides
5. recover from temporary auth or network failure

## 5. Manual smoke-test checklist

For pre-release validation, run:

- plugin install
- plugin config with local Forgejo URL/token
- project creation
- integration add
- bootstrap verification
- task→issue update
- issue→task update
- comment round-trip
- disable/enable binding
- retry after induced API failure

## Suggested local dev setup

Use the same developer ergonomics as the GitHub plugin:

- Node/TypeScript project
- local todu daemon config
- watch build producing `dist/index.js`
- isolated local plugin data directory

For Forgejo-specific dev:

- run a disposable local Forgejo instance
- create a test user and PAT
- seed one or two repositories with issues, labels, and comments
- point `settings.baseUrl` to that instance

## Risks and Open Questions

1. **External ID final shape** — the proposed `<baseUrl>/<owner>/<repo>#<number>` format is workable, but should be locked before implementation starts.
2. **Single-instance assumption** — v1 uses one configured Forgejo base URL per plugin installation. If multi-instance support is needed soon, binding shape may need to grow.
3. **Auth compatibility** — some deployments may require header compatibility handling beyond one default mode.
4. **Assignee support variance** — verify expected response shapes against the target Forgejo version.
5. **Label creation permissions** — some tokens may read issues but lack label-management rights.
6. **Comment timestamps** — confirm the API supplies stable create/update timestamps suitable for last-write-wins.
7. **Deleted issue detection** — verify how disappeared or permission-restricted issues should surface during incremental sync.

## Phased Implementation Plan

### Phase 1: Provider foundation

- scaffold module layout
- load config
- validate bindings
- implement Forgejo client types and HTTP client
- register plugin entry point

### Phase 2: Linking and bootstrap

- external ID parsing/formatting
- item link store
- Forgejo→todu bootstrap
- todu→Forgejo bootstrap

### Phase 3: Field synchronization

- title/body
- status/state normalization
- priority labels
- normal labels
- assignee import

### Phase 4: Comment synchronization

- comment link store
- attribution formatting
- create/edit/delete mirroring
- comment conflict resolution

### Phase 5: Runtime hardening

- retry and backoff
- per-binding status
- loop prevention
- structured logging

### Phase 6: Validation and release prep

- unit/in-memory/integration test coverage
- local smoke-test guide
- README and operator docs
- compatibility notes for supported Forgejo versions

## Acceptance Criteria

The architecture is satisfied when the implementation can support all of the following:

1. a user configures one Forgejo base URL and token for the plugin
2. a user creates a `forgejo` integration binding for `owner/repo`
3. bootstrap imports open Forgejo issues and exports active/inprogress/waiting todu tasks
4. linked items receive globally unique Forgejo-aware `external_id` values
5. title/body/status/priority/labels sync bidirectionally according to the documented rules
6. comments sync bidirectionally with strict 1:1 mirrored behavior
7. Forgejo assignees import into todu
8. polling, retry, and binding status behave independently per binding
9. Forgejo-specific API/auth/rate-limit differences are isolated to config and client layers
10. the resulting implementation can be planned as small follow-up tasks without major design gaps
