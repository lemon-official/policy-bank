---
id: ORG-0003
title: No bypassPermissions mode
status: Accepted
date: 2026-09-01
---
# ORG-0003 No bypassPermissions mode

## Context
Bypass mode skips every permission check.

## Decision
managed-settings.json sets permissions.disableBypassPermissionsMode to disable.

## Consequences
Enforced by the control(s) in org-controls.yaml that cite ORG-0003.
