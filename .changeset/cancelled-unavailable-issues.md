---
"@todu/forgejo": patch
---

Skip unavailable Forgejo issues for currently cancelled tasks during push instead of blocking the binding. Preserve task/comment identities, approvals, provenance, and link snapshots, and omit comment pushes for those skipped tasks. Keep active-task identity guards and authentication/permission failures intact. API v4 pull still blocks missing linked comment endpoints because it has no current local task status.
