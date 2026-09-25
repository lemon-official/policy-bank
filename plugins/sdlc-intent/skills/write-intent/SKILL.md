---
name: write-intent
description: Draft an intent.md for a new change — the problem, who has it, the outcome wanted, constraints and open questions. Use when a product owner wants to start a change, write an intent, or capture an idea for the requirements and design pass.
---

# Write an intent

An intent says what is wanted and why. It does not say how. Accepting it (merging the PR)
starts the requirements and design pass (`spec-from-intent`).

## Steps

1. Ask for anything missing: the problem, who has it, how we'll know it's solved, and any
   deadline or constraint. Don't invent answers; put unknowns under "Open questions".
2. Pick the change id: `<yyyy>-<nn>-<short-slug>`, for example `2026-14-guest-checkout`.
3. Write `docs/changes/<id>/intent.md` from [template.md](template.md). Fill the front matter:
   - `owner`: the product owner's GitHub handle.
   - `risk`: `low`, `medium` or `high`. Use `high` for anything touching restricted data,
     auth, payments, or a new vendor (see the `security-policy` skill).
   - `relevant_adrs`: org ADRs (`ORG-NNNN`) and repo ADRs (`ADR-NNNN`) that constrain it.
4. Keep "Out of scope" explicit. A spec can only be reviewed against what the intent says.
5. Open a PR titled `intent: <id> <title>`. CODEOWNERS requests the product owners.
   Leave `status: proposed`; the merge is the acceptance.

## Checks before opening the PR

- Every success measure is observable (a metric, an event, a user action).
- No solution is prescribed unless it's a real constraint, and then it's under "Constraints".
- Each open question names who can answer it.
