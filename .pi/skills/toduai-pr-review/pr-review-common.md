# PR Review Common Logic

Shared review logic for all hosts.

## Required Inputs

- task ID (required)
- PR title/body
- PR diff

## Procedure

1. Load task details with `toduai --format json task show <task-id>`.
2. Extract the task objective and acceptance criteria from the task description.
3. Review PR changes against each acceptance criterion.
   - mark each criterion as: `met` | `partial` | `not-evident`
4. Run quality checks during review:
   - scope alignment
   - code quality and maintainability
   - tests for logic changes
   - security concerns
   - documentation impact
5. Decide exactly one outcome:
   - `approved`
   - `warnings`
   - `changes-requested`

## Decision Rules

- Any acceptance criterion marked `not-evident` => `changes-requested`
- Missing tests for logic changes => `changes-requested`
- Potential bugs/correctness issues => `changes-requested`
- Policy violations => `changes-requested`
- `warnings` only for non-blocking concerns

## Required Review Content

Review comment content must include:

- summary
- acceptance criteria checklist with per-criterion status
- blocking issues (if any)
- warnings (if any)
- final verdict

## Task Note Requirement

After posting the PR comment, add a matching task note with `toduai note add --task <task-id> <content>`.

## Common Result Fields

```text
- review: approved|warnings|changes-requested
- blocking_issues: <count>
- warnings: <count>
- criteria_total: <count>
- criteria_met: <count>
- criteria_missing: <count>
```
