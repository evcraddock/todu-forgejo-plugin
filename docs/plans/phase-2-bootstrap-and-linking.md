# Phase 2: Bootstrap and Linking

## Purpose

Implement the initial bootstrap behavior and durable task/issue linking model from `../ARCHITECTURE.md`.

This phase should make it possible for a Forgejo integration binding to create and discover linked tasks/issues using the agreed Forgejo-aware `external_id` convention.

## Scope

- bootstrap from Forgejo open issues into todu
- bootstrap from todu tasks in `active`, `inprogress`, and `waiting` into Forgejo
- ignore existing todu tasks in `done` and `canceled` during bootstrap
- assign and honor Forgejo external IDs in the form:
  - `<normalizedBaseUrl>/<owner>/<repo>#<issueNumber>`
- generate source URLs for linked Forgejo issues
- follow the duplicate policy from the architecture doc
- implement item-link persistence in local runtime storage
- support linking an existing task when it already carries a matching Forgejo external ID for the same configured instance and repo

## Deliverables

- bootstrap import path from Forgejo to todu
- bootstrap export path from todu to Forgejo
- durable item-link creation logic
- Forgejo external ID assignment/update logic
- source URL helpers for issues
- tests for bootstrap creation and linking behavior

## Acceptance Criteria

- a new Forgejo binding can bootstrap open Forgejo issues into the linked todu project
- a new Forgejo binding can bootstrap active/inprogress/waiting todu tasks into Forgejo
- linked items receive the expected Forgejo external ID format
- source URLs point to the configured Forgejo instance issue pages
- duplicate handling follows the architecture decision rather than fuzzy matching
- bootstrap logic respects binding strategy where applicable
- automated tests cover both import and export bootstrap paths
- automated tests cover existing external ID linking for the configured instance/repo

## Out of Scope

- full steady-state field reconciliation
- comment sync
- retry/backoff behavior
- shared status publishing
