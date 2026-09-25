---
id: ORG-0006
title: Guardrail hooks run on every machine
status: Accepted
date: 2026-09-25
---
# ORG-0006 Guardrail hooks run on every machine

## Context
Permission denies match command text, so `git push -f` or `gh api .../merge` slip past
`Bash(git push --force *)`. The CI check only sees a PR after the work is done. Agents need
the gates while they work: before a tool call, and before they say they're finished.

## Decision
The `org-guardrails` plugin in policy-bank ships Claude Code hooks, and every SDLC plugin
depends on it. Repos may not turn it off (`enabledPlugins` false or `disableAllHooks`).

| event | matcher | check | rule |
|---|---|---|---|
| SessionStart | startup, resume, clear, compact | say which change is active, its stage and the next skill | ORG-0001 |
| PreToolUse | Bash | deny `gh pr merge`, the merge API, and force-push in any form | ORG-0002 |
| PreToolUse | Bash, Read, Grep, Edit, Write | deny reading `.env` / `.env.*` (not `.example`, `.sample`, `.template`, `.dist`) | ORG-0002 |
| PreToolUse | Edit, Write | deny edits to settings that turn hooks off, disable the plugin or default to bypass | ORG-0006, ORG-0003 |
| PreToolUse | Edit, Write | spec gate: gated paths need the change's spec accepted and merged (opt-in) | ORG-0001 |
| PostToolUse | Edit, Write | once per file per session: a protected path needs an ADR cited in the PR | ORG-0005 |
| Stop | | stop gate: the repo's test command passes when code changed (opt-in) | repo ADR |

Opt-in gates turn on when the repo's `policy/controls.yaml` lists `spec-gate` or `stop-gate`,
which must cite a repo ADR like every other control.

A hook that crashes fails open. The permission denies and the required
control-traceability check stay the backstop.

## Consequences
Enforced by the control(s) in org-controls.yaml that cite ORG-0006, and by the hooks above.
Hooks can't see a Bash command that writes a gated file (`cat > src/x`); CI and review catch that.
