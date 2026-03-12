# Implementation Plans

These phase plans break `docs/ARCHITECTURE.md` into small, testable deliverables for `todu-forgejo-plugin`.

## Recommended order

1. [Phase 1: Provider Foundation](phase-1-provider-foundation.md)
2. [Phase 2: Bootstrap and Linking](phase-2-bootstrap-and-linking.md)
3. [Phase 3: Field Sync](phase-3-field-sync.md)
4. [Phase 4: Comment Sync](phase-4-comment-sync.md)
5. [Phase 5: Runtime and Observability](phase-5-runtime-and-observability.md)
6. [Phase 6: Test Coverage and Hardening](phase-6-test-coverage-and-hardening.md)

## Usage

Each phase document defines:

- purpose
- scope
- deliverables
- acceptance criteria
- explicit out-of-scope boundaries

The intent is to implement one phase at a time, keep changes reviewable, and avoid mixing foundational work with behavior hardening.
