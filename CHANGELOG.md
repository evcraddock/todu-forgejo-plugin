# todu-forgejo-plugin

## Unreleased

Initial npm release preparation. No npm version has been published by this work.

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
