# Phase 5: Runtime and Observability

## Purpose

Implement the runtime support layer needed for stable long-running Forgejo sync execution.

This phase should focus on local runtime state, per-binding scheduling, loop prevention, retry behavior, and publication of shared high-level binding status.

## Scope

- local runtime state keyed by binding identity
- cursors/checkpoints
- retry/backoff state
- loop-prevention bookkeeping
- per-binding scheduling behavior
- shared integration binding status updates
- local logging and diagnostics
- Forgejo-aware HTTP failure classification for retry decisions

## Deliverables

- local runtime storage abstraction/schema
- retry/backoff implementation
- loop-prevention implementation
- binding-status publishing behavior
- logging/diagnostic structure
- failure classification for auth, rate-limit, transport, and transient server errors
- tests for retry/reset and status update behavior

## Acceptance Criteria

- each binding has isolated runtime state and scheduling behavior
- failed sync cycles retry with bounded exponential backoff
- successful sync cycles reset retry state
- loop prevention avoids repeated mirror writes
- high-level binding status is published through the core integration status surface
- detailed runtime diagnostics remain local
- auth failures, missing permissions, and transient server failures are surfaced distinctly enough for debugging
- automated tests cover runtime state transitions and retry behavior

## Out of Scope

- foundational binding parsing
- basic bootstrap linking
- primary non-comment field mapping
- comment behavior itself
