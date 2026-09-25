# policy: central ADR/controls check

A required workflow that every PR in targeted repos must pass. It fails when:

1. a control in scope has no ADR, or its ADR is missing or not `Accepted`;
2. the PR touches `.claude/**`, `policy/**` or `**/managed-settings*.json` without citing an
   Accepted ADR, either in the PR body or as a changed file under `docs/adr/`;
3. a repo loosens an org control. That covers disabling one, a `permissions.allow` entry that
   covers an org deny, a threshold below the org floor, and removing a required CODEOWNERS line.

Each failure names the ADR and its path, for example
`FAIL [ORG-0002 policy:adr/0002-agents-cannot-merge.md] .claude/settings.json allows 'Bash(gh pr *)' ...`.

Only controls whose `applies_to` globs match a changed file are evaluated. When
`policy/controls.yaml` itself changes, all of them are.

## Layout

```
.github/workflows/adr-controls-check.yml   the workflow the org ruleset requires
.github/workflows/adr-controls-reusable.yml  same check via workflow_call (Free/Team plans)
.github/CODEOWNERS                         architecture + security own this repo
scripts/check_controls.py                  the check (Python 3.9+, PyYAML)
org-controls.yaml                          org controls, protected paths, governing ADR
adr/NNNN-*.md                              org ADRs (ORG-NNNN)
templates/controls.yaml                    copy to <repo>/policy/controls.yaml
templates/adr-template.md                  copy to <repo>/docs/adr/NNNN-title.md
tests/make_fixtures.sh                     builds 3 fixture repos and runs the check
```

In a service repo: `docs/adr/NNNN-title.md` (ids `ADR-NNNN`) and `policy/controls.yaml`.

## Try it locally

```
pip install pyyaml
bash tests/make_fixtures.sh /tmp/fixtures      # expect: pass=0, missing-adr=1, loosens=1
python3 scripts/check_controls.py --repo ../my-service --policy . \
  --base origin/main --head HEAD --pr-body-file body.txt
```

## Free/Team plan: reusable workflow

Org rulesets with required workflows need Enterprise Cloud. On other plans each service repo
calls `.github/workflows/adr-controls-reusable.yml` from its own workflow and makes the
resulting check (`adr-controls / check`) required in a branch ruleset on its default branch.
The policy repo is public, so no reader token is needed. Reference repo:
[lemon-official/retro-raven](https://github.com/lemon-official/retro-raven).

```yaml
on: { pull_request: {}, merge_group: {} }
permissions: { contents: read }
jobs:
  adr-controls:
    uses: lemon-official/policy-bank/.github/workflows/adr-controls-reusable.yml@main
    with: { policy-ref: main }        # pin both to a policy-vN tag once you cut one
```

## Set up in GitHub (Enterprise Cloud)

Checked against the github/docs source. "Require workflows to pass before merging" and
Evaluate mode are GitHub Enterprise Cloud (and GHES 3.12+) features.

1. **Create the repo** `<org>/policy-bank` with **internal** visibility. An internal workflow can
   run on internal and private repos; a private one only on private repos. Push this kit.
2. **Allow Actions access.** Go to policy repo, Settings, Actions, General, Access, and choose
   "Accessible from repositories in the `<org>` organization".
3. **Create a read token for the policy files.** The workflow runs in the context of the PR's
   repo, so it needs a token to check out `<org>/policy-bank`. Create a GitHub App with
   `Contents: read`, install it on `policy-bank` only, then add org variable `POLICY_READER_APP_ID`,
   org secret `POLICY_READER_PRIVATE_KEY`, and org variable `POLICY_REF` (a release tag such as
   `policy-v1`).
4. **Create the org ruleset.** Go to Org settings, Repository, Rulesets, New branch ruleset.
   - Target repositories: all repos, a name pattern, or a custom property (for example `props.sdlc-gates:true`).
   - Target branches: the default branch only. The rule blocks direct pushes, so don't target all branches.
   - Rules:
     - Require a pull request before merging, with "Require review from Code Owners" and
       "Dismiss stale approvals".
     - Require status checks to pass.
     - Require workflows to pass before merging: add workflow, choose `<org>/policy-bank`,
       `.github/workflows/adr-controls-check.yml`, and pin it to a tag or SHA.
   - Enforcement: **Evaluate** first and watch Rule Insights, then **Active**.
   - Bypass: org admins only, audited. Creating a new repo needs bypass or Evaluate, because
     a required workflow can't run on an empty repo.
5. **Each service repo** gets CODEOWNERS lines for `/docs/changes/` and `/docs/adr/`,
   plus `policy/controls.yaml` and `docs/adr/` from `templates/`.

### How the workflow reads the PR

- **PR body:** read from the event payload (`github.event.pull_request.body`) and passed
  through an env var, never interpolated into shell. No API call, so
  `permissions: contents: read` is enough.
- **Diff:** `actions/checkout` with `fetch-depth: 0`, then
  `git diff --name-only <base.sha>...<head.sha>`.
- **`merge_group` runs:** these have no single PR body. They pass `--skip-pr-reference` and
  keep every other check.
- **Triggers:** ruleset workflows ignore `paths`/`branches`/`types` filters and don't run on
  events triggered by `GITHUB_TOKEN`. PRs already open when you add the rule need a new push.
  Don't use `cancel-in-progress`.

## Changing a control

- **Org control:** PR here with a superseding ADR in `adr/`. CODEOWNERS approve, then tag
  `policy-vN` and update `POLICY_REF`.
- **Local control:** PR in the service repo with a local ADR (`Accepted`) and the
  `policy/controls.yaml` change. This check blocks it if it loosens an org control.
