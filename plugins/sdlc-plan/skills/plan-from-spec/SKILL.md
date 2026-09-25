---
name: plan-from-spec
description: Turn an accepted spec.md into plan.md — ordered, reviewable implementation steps for plan mode. Use after a spec is accepted, or when asked to plan the build for a change.
---

# Plan from spec

The plan is how engineering will build an accepted spec. It lives in the repo where the code
changes, at `docs/changes/<id>/plan.md`.

## Steps

1. Read `docs/changes/<id>/spec.md`. If `status` isn't `accepted`, stop: no code or plan
   before an accepted spec (`ORG-0001`).
2. Read the code each requirement touches. Use plan mode; don't edit code yet.
3. Write `plan.md` from [template.md](template.md):
   - small steps, each a reviewable PR or commit, in dependency order;
   - each step lists the requirements (`R-n`) it delivers and the tests that prove it;
   - every requirement is covered by at least one step;
   - migrations, feature flags and rollback for anything risky.
4. Note anything the spec got wrong about the code as a question on the spec, not a silent
   change of design.
5. Open a PR titled `plan: <id> <title>`. CODEOWNERS requests the engineering leads. The merge
   starts the build.
