---
name: resolve-concerns
description: Work through the flagged concerns in a spec.md with each concern's policy owner and record the resolution. Use when a spec has open concerns, contradicting policies, or escalations to brand, security, UX or architecture.
---

# Resolve flagged concerns

Flagged concerns are what an analyst would have escalated. Resolve them before engineering
sees the spec. An accepted spec with an open concern fails the spec gate.

## Steps

1. List every concern in the spec's "Flagged concerns" section whose `status` is `open`.
2. For each, show: the requirement, the policy rule it conflicts with (for example `SEC-3` or
   `ORG-0002`), and the `policy_owner`.
3. Draft options for the policy owner, cheapest first:
   - change the requirement so it complies;
   - carry it forward as a follow-up intent;
   - get a documented exception, which needs a new or superseding ADR (`docs/adr/`).
4. Record the owner's decision on the concern itself:
   ```yaml
   - id: C-2
     requirement: R-4
     conflicts_with: SEC-3
     policy_owner: security
     status: resolved       # open | resolved | carried-forward
     resolution: "Use the secret manager; drop the env-file option."
     decided_by: "@handle"
   ```
5. Update the affected requirements so the spec reads consistently, then push to the spec PR.
6. Never mark a concern resolved without a named `decided_by` from the policy owner's team.
