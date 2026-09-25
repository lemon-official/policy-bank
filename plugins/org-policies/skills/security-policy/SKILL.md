---
name: security-policy
description: Company security policy — data classification, authentication, secrets, logging, third parties. Use when writing or reviewing an intent, spec or plan that touches data, auth, infrastructure, dependencies or external services.
---

# Security policy

> Placeholder: security owns this file. Replace the rules below with the real policy. Keep each
> rule numbered so specs can cite it (for example `SEC-2`). Org ADRs in `adr/` in the
> policy-bank repo are binding; cite them by id (for example `ORG-0002`).

## Rules

1. **SEC-1 Data classification.** Every new data field is classified (public, internal,
   confidential, restricted). Restricted data needs a security review before build.
2. **SEC-2 Authentication.** All endpoints authenticate through the shared identity service.
   No custom auth.
3. **SEC-3 Secrets.** Secrets come from the secret manager only. Never in code, config or logs.
4. **SEC-4 Third parties.** A new vendor or external API needs a vendor assessment first.
5. **SEC-5 Agents.** Agents never merge PRs or push with force (`ORG-0002`), and never run
   in bypass mode (`ORG-0003`).

## How to apply

- In a spec, add a "Security" section that lists data classes touched and the rules that apply.
- Anything classified restricted, any new vendor, or any change to auth sets `risk: high`.
- Conflicts go in "Flagged concerns" with `policy_owner: security`.
