# Phase 1: Provider Foundation

## Purpose

Create the Forgejo sync provider foundation that plugs into the core integration binding architecture described in `../ARCHITECTURE.md`.

This phase should establish the provider runtime shape, binding interpretation, Forgejo-specific configuration loading, and HTTP client foundation, but should not attempt full sync behavior yet.

## Scope

- scaffold the `syncProvider` registration for provider identity `forgejo`
- implement provider initialization and shutdown structure
- accept host-supplied integration bindings
- parse and validate Forgejo bindings with:
  - `provider = forgejo`
  - `targetKind = repository`
  - `targetRef = owner/repo`
- load local provider configuration with:
  - `settings.baseUrl`
  - `settings.token`
  - optional local storage configuration
- normalize and validate the configured Forgejo base URL
- derive the Forgejo API base URL from `baseUrl`
- implement the Forgejo client interface and an initial HTTP client adapter
- produce clear errors for invalid bindings, invalid base URLs, or missing local config/auth

## Deliverables

- provider registration/export
- runtime skeleton that can iterate applicable bindings
- binding parsing and validation utilities
- provider config/auth loading utilities
- normalized base URL and API URL helpers
- Forgejo client interface and HTTP client foundation
- tests for valid and invalid binding/config cases

## Acceptance Criteria

- the plugin exports a valid `syncProvider` registration
- bindings with `provider = forgejo` and `targetKind = repository` are accepted
- malformed `targetRef` values fail with contextual errors
- missing or invalid `settings.baseUrl` fails clearly
- missing or invalid token configuration fails clearly
- the provider derives a stable `/api/v1` base from the configured Forgejo instance URL
- provider runtime can start and stop cleanly without performing full sync yet
- automated tests cover target parsing, base URL normalization, and config validation behavior

## Out of Scope

- bootstrap sync
- external ID assignment and linking
- field mapping
- comment sync
- retry scheduling
- observability/status publishing
