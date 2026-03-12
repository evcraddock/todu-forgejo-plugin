# Phase 3: Field Sync

## Purpose

Implement steady-state task/issue synchronization for all non-comment fields described in `../ARCHITECTURE.md`.

This phase is the core mapping layer for linked tasks and Forgejo issues.

## Scope

- title sync
- markdown body/description sync
- status sync with open/closed plus `status:*` labels
- priority sync with `priority:*` labels
- normal label sync
- label creation on Forgejo when needed for mirrored normal labels
- Forgejo assignee import into todu
- field-group last-write-wins behavior for non-comment fields
- support for binding strategies `bidirectional`, `pull`, `push`, and `none`

## Deliverables

- field mapping utilities
- status normalization logic
- priority normalization logic
- reserved vs normal label handling
- Forgejo label creation behavior
- assignee import behavior
- tests for mapping and strategy behavior

## Acceptance Criteria

- title and body sync correctly between linked tasks and Forgejo issues
- status mapping follows the architecture rules and normalizes conflicting `status:*` labels deterministically
- priority mapping follows the architecture rules and normalizes conflicting `priority:*` labels deterministically
- non-reserved labels mirror bidirectionally
- missing normal labels can be created in the target Forgejo repository before assignment
- Forgejo assignees sync into todu and do not sync back to Forgejo
- sync execution honors binding strategy for non-comment fields
- automated tests cover pull, push, and bidirectional cases

## Out of Scope

- comment syncing
- retry/backoff scheduling
- binding status publishing
- webhook triggering
