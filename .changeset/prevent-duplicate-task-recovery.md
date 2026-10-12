---
"@todu/forgejo": patch
---

Prevent duplicate Todu tasks caused by silently recreating unavailable linked Forgejo issues. Preserve existing task/comment identities, block mismatched or missing explicit references with an operator-repair diagnostic, and retain errors through retry backoff and restart. Read HTTP response codes independently of issue numbers and preserve authentication/permission failures during backoff. Existing duplicates require separately approved cleanup; the host's existing-link guard remains intact.
