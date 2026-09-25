---
id: ORG-0006
title: Fix tasks can't change the tests that judge them
status: Accepted
date: 2026-09-25
---
# ORG-0006 Fix tasks can't change the tests that judge them

## Context
An agent fixing failing code can make the failure go away by editing the test, loosening a
coverage threshold or changing test config. The loop then reports green while the defect stays.

## Decision
A fix PR (branch `fix/**`, or labelled `fix`) must not change tests, test data or test and
coverage config. When a test is wrong, the fix PR says so and a person changes the test in a
separate, non-fix PR that goes through normal review.

## Consequences
- Enforced by org control `org.fix-keeps-tests` in the required adr-controls-check workflow.
- Fix workflows must open PRs from a `fix/` branch.
- Recommended guardrail: the `sdlc-guards` plugin's hook blocks the same edits while Claude
  works, when `SDLC_TASK=fix` is set. The CI check is the control; the hook only saves a round trip.
