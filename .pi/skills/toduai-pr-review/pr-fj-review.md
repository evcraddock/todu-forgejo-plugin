# PR Forgejo Review Worker

Review Forgejo PR content and post review artifacts.

## Required Inputs

- PR number
- task ID (required)

## Procedure

1. Validate PR exists and is open, then load context:
   - `fj pr view <number>`
   - require open state
   - `fj pr view <number> diff`
2. Follow shared review logic in `./pr-review-common.md`.
3. Post structured PR review comment:
   - `fj pr comment <number> --body-file <review-file>`
4. Add matching task review note:
   - `toduai note add --task <task-id> <content>`

## Output Contract (Required)

```text
PR Review Worker Result
- pr: open|invalid|closed
- review: approved|warnings|changes-requested
- pr_comment: posted|failed
- task_note: posted|failed
- blocking_issues: <count>
- warnings: <count>
- criteria_total: <count>
- criteria_met: <count>
- criteria_missing: <count>
```

If any required artifact fails to post, status is not complete.
