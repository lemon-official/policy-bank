---
name: accept-spec
description: Decide whether a spec.md and its intent progress to build, check it's ready, and mark it accepted. Use when a product owner wants to accept, approve or sign off a spec.
---

# Accept a spec

A human always makes this call. Accepting the spec (merging it with `status: accepted`)
starts plan mode (`plan-from-spec`).

## Readiness check

Stop and report if any of these fail:

- every intent open question is answered or carried forward with an owner;
- no flagged concern has `status: open`;
- every requirement has an acceptance criterion;
- `risk` matches the intent, or the change is explained.

## Steps

1. Run the readiness check and show the result.
2. If `risk: high`, tell the owner a tech lead must approve the PR too; the spec gate blocks
   the merge until one does.
3. On the owner's go-ahead, set `status: accepted` and `accepted_by` in the spec front matter,
   and push to the PR. The owner then approves and merges; you don't.
