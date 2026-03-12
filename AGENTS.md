# AI Agent Guidelines for todu-forgejo-plugin

## Before Starting Any Task

Always run a task readiness check before implementation when the user asks to start or work on a task.

## Required Reading

Before making implementation changes, read and follow:

- `docs/ARCHITECTURE.md` for the approved design
- the relevant file in `docs/plans/` for the current phase or work item

## Project Overview

A todu plugin that will synchronize Forgejo issues with the todu system.

## Tech Stack

- Language: TypeScript
- Framework: None
- Build: TypeScript + esbuild
- Test: Vitest

## Development

Start the dev environment with `make dev` when the task needs background services.

Key commands:

- `make dev` - start the local dev environment scaffold
- `make dev-stop` - stop the local dev environment
- `make dev-cli CMD="..."` - run `toduai` commands against the isolated dev config
- `npm test` - run tests
- `npm run lint` - run the linter
- `npm run format` - format code
- `npm run typecheck` - run the TypeScript compiler in check mode
- `npm run build` - build the plugin bundle and type declarations

## Conventions

- Use TypeScript strict mode
- Prefer named exports over default exports
- Use path aliases (`@/...`) when they improve readability
- Keep changes incremental and aligned with `todu-github-plugin` unless Forgejo-specific behavior requires divergence
- Add or update tests when behavior changes
- Do not disable failing checks to get work through

## Quality Gate

Before considering work complete, run the relevant local verification for the scope. At minimum, prefer:

1. `npm run format`
2. `npm run lint`
3. `npm run typecheck`
4. `npm test`

Use `./scripts/pre-pr.sh` when preparing work for review.
