---
name: review-spec-against-intent
description: Review a spec.md against the intent.md it came from — does it solve the stated problem, are open questions answered or carried forward, are concerns flagged. Use when a product owner is reviewing a spec PR.
---

# Review a spec against its intent

The product owner who wrote the intent reviews the spec. The question is "does this solve
what I asked for", not "is this good engineering".

## Steps

1. Read `docs/changes/<id>/intent.md` and `docs/changes/<id>/spec.md` side by side.
2. For each item, answer yes, no or partly, with a line reference:
   - **Problem:** does the spec address the problem as stated, for the users named?
   - **Outcome and success measures:** does each measure map to a requirement that makes it
     observable?
   - **Out of scope:** does the spec stay out of it?
   - **Open questions:** is every intent question answered in the spec, or listed under
     "Carried forward" with an owner? Name any that are neither.
   - **Constraints:** does every constraint appear as a requirement or a flagged concern?
   - **Policies:** does the spec cite the brand, security and UX rules it applies?
3. List flagged concerns that are still `open`. Those go to `resolve-concerns` first.
4. Give a verdict: **ready to accept**, **needs changes** (list them), or **back to intent**
   (the intent itself was wrong or incomplete).
5. Post the review as PR review comments on the lines concerned, and the verdict as the review
   summary. Do not approve on the owner's behalf.
