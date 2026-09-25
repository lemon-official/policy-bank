---
id: ORG-0005
title: Every control traces to an Accepted ADR
status: Accepted
date: 2026-09-01
---
# ORG-0005 Every control traces to an Accepted ADR

## Context
Controls without a recorded reason get cargo-culted or removed.

## Decision
The required workflow adr-controls-check fails PRs whose controls lack an Accepted ADR, that change protected paths without citing one, or that loosen an org control.

## Consequences
Enforced by the control(s) in org-controls.yaml that cite ORG-0005.
