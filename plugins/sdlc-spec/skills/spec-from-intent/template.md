---
intent: <id>
title: <short title>
status: draft           # draft | accepted
risk: low               # low | medium | high (inherits from intent)
relevant_adrs: []
accepted_by:            # "@handle", set by accept-spec
---
# Spec: <title>

## Summary
Two or three sentences: what will be built and how it meets the intent's outcome.

## Requirements
| id  | requirement | acceptance criterion | covers |
|-----|-------------|----------------------|--------|
| R-1 |             |                      | outcome / success measure |

## Design
Components, data, interfaces, flows. Link the code the change touches.

## Policies applied
- Brand: <BRAND-n, ...>
- Security: <SEC-n, ORG-NNNN, ...> and data classes touched
- UX: <UX-n, ...>

## Answers to intent questions
- <question> — <answer>

## Carried forward
- <question> — owner: <person or team>

## Flagged concerns
```yaml
- id: C-1
  requirement: R-1
  conflicts_with: <rule id>
  policy_owner: <brand | security | design | architecture>
  status: open
  resolution:
  decided_by:
```
