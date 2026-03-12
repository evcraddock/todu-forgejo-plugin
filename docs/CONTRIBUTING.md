# Contributing

This document defines how to work in `todu-forgejo-plugin`.

## Required workflow

1. Work only within the requested task scope.
2. Read relevant files before editing.
3. Make the smallest change that satisfies the task.
4. Follow `AGENTS.md`, `docs/ARCHITECTURE.md`, and the relevant file in `docs/plans/`.
5. Do not add manual line breaks in markdown paragraphs.
6. If blocked or requirements are ambiguous, stop and report `BLOCKED` with the reason.
7. Summarize changed files and verification results clearly.

## Plan disclosure and approval

Before implementation begins on a task, disclose the plan and get approval.

Do not ask for approval on an undisclosed plan.

Use this format:

### Plan for task #<id>

#### Goal

- <one sentence summary>

#### Files to read

- `<path>`
- `<path>`

#### Files likely to change

- `<path>`
- `<path>`

If the exact file list is not known yet, say so explicitly and keep the eventual changes scoped.

#### Implementation steps

1. <step>
2. <step>
3. <step>

#### Verification

- `<command>`
- `<command>`

#### Open questions / risks

- <item>
- or `None`

#### Approval

Reply with `approve` to proceed with this plan.

## Branch and commits

Start from the latest `main` branch and create a task branch:

```bash
git checkout main && git pull
git checkout -b <task-id>-short-description
```

For example:

```bash
git checkout -b task-a789120b-scaffold-project-dev-environment
```

If the work is not tied to a task, use a short descriptive branch name with one of these prefixes:

- `feat/` - new features
- `fix/` - bug fixes
- `docs/` - documentation only
- `chore/` - maintenance

Commit format:

```text
<type>: <short description>

Task: #<task-id>
```

## Verification setup

Use the project's local verification commands before asking for review:

- `npm run format`
- `npm run lint`
- `npm run typecheck`
- `npm test`

Use `./scripts/pre-pr.sh` when preparing work for review.

If the task touches the local daemon workflow, also run the relevant dev-environment checks such as:

- `make dev`
- `make dev-stop`

## Review and integration

- Push your branch to GitHub.
- Use pull requests for review and integration.
- Run the `toduai-pr-review` skill as part of the review gate.
- Treat the `toduai-pr-review` result as part of the approval gate and stop for explicit human merge approval after review is complete.
- Never auto-merge without explicit human approval.

## When stuck

After 3 failed attempts at the same problem:

1. Stop.
2. Document what was tried and why it failed.
3. Ask for guidance or propose alternatives.
