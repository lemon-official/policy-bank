---
id: ORG-0002
title: Agents cannot merge or force-push
status: Accepted
date: 2026-09-01
---
# ORG-0002 Agents cannot merge or force-push

## Context
The human gate is the merge.

## Decision
Claude Code may not run gh pr merge or force-push, and may not read .env files. Repos may not allow these.

## Consequences
Enforced by the control(s) in org-controls.yaml that cite ORG-0002.
