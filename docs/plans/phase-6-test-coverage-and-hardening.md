# Phase 6: Test Coverage and Hardening

## Purpose

Add the broader test coverage and hardening work needed to trust the provider in regular use.

This phase should validate the full architecture across bootstrap, steady-state sync, strategies, normalization, and error handling, including a real Forgejo-backed smoke path.

## Scope

- end-to-end coverage across realistic binding lifecycles
- strategy coverage for `bidirectional`, `pull`, `push`, and `none`
- reopen/close/cancel edge cases
- status and priority normalization edge cases
- comment mirroring edge cases
- failure-path and recovery-path coverage
- disposable local Forgejo test environment or documented smoke-test workflow

## Deliverables

- expanded unit coverage
- integration or end-to-end sync tests
- documented test matrix for major sync behaviors
- hardening fixes identified by the new coverage
- smoke-test documentation for a local Forgejo instance

## Acceptance Criteria

- automated coverage exists for bootstrap and steady-state sync paths
- strategy-specific behavior is exercised and verified
- reopen/close/cancel transitions behave as documented
- label normalization edge cases are covered
- comment lifecycle edge cases are covered
- failure and recovery behavior is covered well enough to support implementation confidence
- at least one reproducible local Forgejo validation path exists for manual smoke tests

## Out of Scope

- new architecture decisions that contradict `../ARCHITECTURE.md`
- adding new provider capabilities beyond the approved design
- broad GitHub/Forgejo abstraction work unrelated to hardening this plugin
