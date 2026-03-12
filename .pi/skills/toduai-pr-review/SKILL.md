---
name: toduai-pr-review
description: Review a pull request, verify it against a toduai task, post a PR review comment plus a matching toduai task note, and stop at the human merge gate. Use when user says "request review", "review PR", or "get this reviewed" in projects that track work in toduai.
allowed-tools: Bash
---

# Toduai PR Review

Review a PR and stop before merge.

## Inputs

- PR number
- task ID (required)

## Steps

1. Validate task ID is provided.
   - if missing, stop as `BLOCKED`
2. Detect host from `origin` remote.
   - GitHub => follow `./pr-gh-review.md`
   - otherwise => follow `./pr-fj-review.md`
3. Use worker output as source of truth.
   - required: `pr=open`
   - required: `pr_comment=posted`
   - required: `task_note=posted`
   - required: criteria fields reported (`criteria_total`, `criteria_met`, `criteria_missing`)
   - if required artifacts are missing: status is not complete
4. Report outcome and stop at merge gate.
   - `approved` => wait for explicit human merge approval
   - `warnings` => fix by default unless human waives
   - `changes-requested` => fix and rerun review

## Rules

- Never merge in this skill.
- Never claim completion while required artifacts are missing.
- Do not phrase required next steps as optional.

## Output Contract

```text
PR Review Status
- review: pending|approved|warnings|changes-requested
- merge_approval: waiting-human|approved
```

## Worker Output Contract (Required)

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
