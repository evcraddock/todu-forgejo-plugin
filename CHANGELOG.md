# @todu/forgejo

## 0.1.3

### Patch Changes

- 2e17374: Skip unavailable Forgejo issues for currently cancelled tasks during push instead of blocking the binding. Preserve task/comment identities, approvals, provenance, and link snapshots, and omit comment pushes for those skipped tasks. Keep active-task identity guards and authentication/permission failures intact. API v4 pull still blocks missing linked comment endpoints because it has no current local task status.

## 0.1.2

### Patch Changes

- 51ef47b: Prevent duplicate Todu tasks caused by silently recreating unavailable linked Forgejo issues. Preserve existing task/comment identities, block mismatched or missing explicit references with an operator-repair diagnostic, and retain errors through retry backoff and restart. Read HTTP response codes independently of issue numbers and preserve authentication/permission failures during backoff. Existing duplicates require separately approved cleanup; the host's existing-link guard remains intact.

## 0.1.1

Normal stable version of `@todu/forgejo`, prepared for the `latest` channel. Existing capabilities and known sync limitations listed under 0.1.1-next.0 still apply; provider API v4 and storage checkpoint schema 2 are unchanged.

### Patch Changes

- Exit Changesets prerelease mode and remove the `next` version suffix. Future releases use incrementing stable versions, normally 0.1.2, 0.1.3, and so on.
- Add a repository release skill that handles patch Changesets and local version preparation automatically, without another bump when retrying publication.
- Restrict publication guards and the manual npm workflow to stable versions on `latest`. Retain exact-artifact review and publication approval gates.

## 0.1.1-next.0 - 2026-10-11

First experimental npm release as `@todu/forgejo`, intended for the `next` channel. Plugin versions are independent of the sync-provider API (v4) and runtime storage checkpoint schema (2). This prerelease is for controlled evaluation, not a claim of production-hardened conflict or deletion handling.

### Patch Changes

- Finalized the npm package name as `@todu/forgejo` before first publication. Provider identity `forgejo`, repository identity, version, and storage locations are unchanged; no old-name package was published.

- Updated Vitest and coverage tooling to 4.1.11, esbuild to 0.28.2, and ESLint to 10.12.0; refreshed compatible affected test/build/lint dependencies.
- Verified isolated package installation, provider loading/version/API, package contents, and strict consumer declarations. Existing sync behavior and host dependencies remain unchanged.

### Implemented

- Bidirectional issue/task bootstrap and synchronization of title, body, status, priority, normal labels, and mapped assignees.
- Bidirectional comment creation/editing with structured provenance; comment deletion does not propagate.
- Default and named Forgejo instances, instance-aware external identities, durable item/comment links, and optional file-backed storage.
- Sync-provider API v4 pull acknowledgments, durable pending-batch replay, independent issue/comment read checkpoints, and push-success tracking.
- Bounded pagination, binding-scoped retry/backoff, diagnostics, and optional field-group snapshot storage.
- Local Changesets version preparation, generated provider version, manually gated npm publication, and isolated tarball installation/loading/type checks.

### Known limitations

- Issue fields still use whole-record timestamps and replacement, not independent field-group reconciliation. Stored group snapshots do not enable API v5 behavior.
- An absent Todu description does not currently clear an existing Forgejo body.
- An empty outbound assignee set is omitted; incomplete actor mappings can produce incomplete replacement sets.
- Missing or inaccessible remote issues can lose links and be recreated from local tasks. Confirmed-deletion tombstones are not implemented.
- Exact metadata matching can relink unrelated records; it is not yet disabled by default.
- Comment edit conflicts remain origin-sensitive. Repository/instance identity migration tooling and a disposable real-Forgejo integration suite are not implemented.

See [issue-sync research](https://github.com/evcraddock/todu-forgejo-plugin/blob/main/docs/ISSUE-SYNC-RESEARCH.md) for the approved follow-up model. Publication and live deployment require separate approval.
