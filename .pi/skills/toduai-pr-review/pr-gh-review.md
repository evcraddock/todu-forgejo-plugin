# PR GitHub Review Worker

Review GitHub PR content and post review artifacts.

## Required Inputs

- PR number
- task ID (required)

## Procedure

1. Validate PR exists and is open, then load context:
   - `gh pr view <number> --json number,title,body,state`
   - require `state=OPEN`
   - `gh pr diff <number>`
2. Follow shared review logic in `./pr-review-common.md`.
3. Post structured PR review comment:
   - `gh pr comment <number> --body-file <review-file>`
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
