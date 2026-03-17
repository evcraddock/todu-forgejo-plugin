# Phase 4: Comment Sync

## Purpose

Implement the mirrored comment model from `../ARCHITECTURE.md`.

This phase should complete the user-visible sync behavior by handling comment creation, editing, attribution, and conflict resolution for Forgejo issue comments and todu notes while following the current GitHub-aligned non-propagating delete semantics.

## Scope

- create mirrored comments in both directions
- edit mirrored comments in both directions
- do not propagate mirrored comment deletes in either direction
- maintain local comment link state
- apply visible attribution headers in mirrored markdown comments
- resolve comment edit conflicts with comment-level last-write-wins behavior where applicable
- preserve Forgejo author identity in imported comment attribution

## Deliverables

- comment mapping/link storage
- comment create/edit sync logic
- Forgejo/todu attribution formatting helpers
- tests for comment lifecycle behavior and conflicts

## Acceptance Criteria

- one Forgejo comment maps to one todu comment and vice versa when linked
- mirrored comments include the expected attribution format
- editing a comment on one side updates the mirrored comment on the other side
- deleting a comment on one side does not delete the mirrored comment on the other side
- comment conflicts resolve according to the architecture rules in the supported sync model
- automated tests cover comment creation, edits, non-propagating deletes, and conflict handling
- automated tests cover attribution stripping so mirrored comments do not endlessly nest headers

## Out of Scope

- retry/backoff scheduling
- shared binding status publishing
- broader runtime cleanup behavior outside comment links
