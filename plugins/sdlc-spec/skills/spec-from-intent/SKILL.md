---
name: spec-from-intent
description: Produce a requirements and design spec.md from an accepted intent.md, applying the org brand, security and UX policy skills and flagging every concern. Use after an intent is accepted, or when asked to write, draft or generate a spec.
---

# Spec from intent

Read the intent and produce a requirements and design spec for integrating it into the
existing codebase, ready to hand to engineering. Describe clearly any areas of concern,
especially where contradicting policies can't all be satisfied.

## Steps

1. Read `docs/changes/<id>/intent.md`. If `status` isn't `accepted` and the intent isn't on
   the default branch, stop and say so.
2. Read the ADRs in `relevant_adrs`, the repo's `docs/adr/` index and `CLAUDE.md`.
3. Explore the code the change touches. Note the modules, data and interfaces involved.
4. Apply the `brand-guidelines`, `security-policy` and `ux-standards` skills. Cite each rule
   you rely on by id.
5. Write `docs/changes/<id>/spec.md` from [template.md](template.md):
   - one requirement per line, `R-n`, each with an acceptance criterion;
   - answer each intent open question, or list it under "Carried forward" with an owner;
   - add a flagged concern (`C-n`, `status: open`) for every conflict, ambiguity, or rule you
     can't satisfy. Never resolve a conflict by picking a side yourself.
6. Keep `risk` from the intent unless the design raises it; say why if it does.
7. Open a PR titled `spec: <id> <title>`. CODEOWNERS requests the intent's owner and the spec
   writers. Summarise the flagged concerns in the PR body.
