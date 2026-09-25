# policy: central ADR/controls check

A required workflow that every PR in targeted repos must pass. It fails when:

1. a control in scope has no ADR, or its ADR is missing or not `Accepted`;
2. the PR touches `.claude/**`, `policy/**` or `**/managed-settings*.json` without citing an
   Accepted ADR, either in the PR body or as a changed file under `docs/adr/`;
3. a repo loosens an org control. That covers disabling one, a `permissions.allow` entry that
   covers an org deny, a threshold below the org floor, and removing a required CODEOWNERS line;
4. a fix PR changes tests, test data or test config (ORG-0006, see below).

Each failure names the ADR and its path, for example
`FAIL [ORG-0002 policy:adr/0002-agents-cannot-merge.md] .claude/settings.json allows 'Bash(gh pr *)' ...`.

Only controls whose `applies_to` globs match a changed file are evaluated. When
`policy/controls.yaml` itself changes, all of them are.

## Skills marketplace

This repo is also a Claude Code plugin marketplace named `policy-bank`:

```
/plugin marketplace add lemon-official/policy-bank
/plugin install sdlc-intent@policy-bank
```

| plugin | for | skills |
|---|---|---|
| `org-policies` | everyone (installed as a dependency of the others) | brand-guidelines, security-policy, ux-standards |
| `sdlc-intent` | product owners | write-intent, review-spec-against-intent, resolve-concerns, accept-spec |
| `sdlc-spec` | spec writers | spec-from-intent |
| `sdlc-plan` | engineers | plan-from-spec |
| `sdlc-guards` | recommended for anyone running fixes | hook: no test edits during fix tasks (ORG-0006) |

The policy skills are placeholders until brand, security and design replace their rules.
Intent, spec and plan templates sit next to the skill that writes them.

**Install by role** (safe to re-run; restart Claude Code afterwards):

```
./scripts/install.sh --role po            # po | spec | plan | all, repeatable
./scripts/install.sh --role spec --role plan --scope project
```

**Roll out without the script:** put `templates/claude/settings.json` in a service repo as
`.claude/settings.json` (Claude Code prompts people to install when they trust the folder),
or put the same keys in managed settings to enable them for everyone.

**Reviewers by role:** copy `templates/CODEOWNERS.sdlc` into each service repo's
`.github/CODEOWNERS`. With "Require review from Code Owners" in the org ruleset, intent PRs
request product owners, spec PRs product owners and spec writers, plan PRs engineering leads.

**Changing a skill:** PR under `plugins/`, owned per `.github/CODEOWNERS`. Bump `version` in
the plugin's `plugin.json` and its entry in `.claude-plugin/marketplace.json`; people get it on
`/plugin marketplace update policy-bank`. `validate-plugins.yml` runs
`claude plugin validate --strict` on every change.

## Fix PRs can't change tests (ORG-0006)

An agent fixing failing code must not be able to weaken the check on that code. Two layers:

| layer | what | status |
|---|---|---|
| PR check | `org.fix-keeps-tests` in the required workflow fails a fix PR that touches a test path | **the control** |
| Claude Code hook | `sdlc-guards` plugin blocks the same edits while Claude works | recommended |

A PR is a **fix PR** when its head branch matches `fix/**` or it has the `fix` label. The test
paths are the `applies_to` list of `org.fix-keeps-tests` in `org-controls.yaml`: test dirs and
files, `testdata/`, `fixtures/`, `conftest.py`, jest/vitest/pytest/coverage config, and
`policy/controls.yaml` (it holds coverage thresholds). A failure reads:

```
FAIL [ORG-0006 policy:adr/0006-fix-tasks-keep-tests.md] fix PR (branch 'fix/null-check') changes
tests/test_app.py. Fix PRs can't change tests or test config ('org.fix-keeps-tests'); ...
```

When a test really is wrong, the fix PR says so in its description, and a person changes the
test in a separate PR that isn't on a `fix/` branch and has no `fix` label.

### Set up the PR check

The check runs inside the existing required workflow, so there is no new ruleset rule.

1. Merge this, tag a new policy release (for example `policy-v2`) and set org variable
   `POLICY_REF` to it. Until then, repos run the old ref without the rule.
2. Make every automated fix open its PR from a `fix/` branch. For claude-code-action that is
   `branch_prefix: fix/`; `templates/workflows/claude-fix.yml` is a ready workflow.
3. Prefer the branch over the label. A ruleset-required workflow runs on the default
   `pull_request` events (opened, synchronize, reopened), not on `labeled`, so a label added
   after the PR opens only counts from the next push. The branch name can't change.
4. Try it: open a PR from `fix/test-guard` that edits a file under `tests/`. The
   `ORG-0006 control-traceability` check should fail with the message above.
5. Optional, for PRs by people: add a CODEOWNERS line for test paths (for example
   `**/tests/ @my-org/qa`) so any test change needs an owner's review.

To add or remove a test path, change `applies_to` in `org-controls.yaml` and the `TEST_RE` in
`plugins/sdlc-guards/scripts/protect-tests.sh` together, in a PR citing ORG-0006.

### The recommended hook

`sdlc-guards` ships a PreToolUse hook on Edit, Write, MultiEdit, NotebookEdit and Bash. It
does nothing unless `SDLC_TASK=fix` is set. Then it blocks edits to the same test paths,
and Claude sees the ORG-0006 reason and fixes the code instead. The Bash check covers common
writes (`>`, `tee`, `sed -i`, `rm`, `mv`, `cp`, `git checkout|restore`) but is a heuristic;
the PR check catches what it misses.

- **One person:** `./scripts/install.sh --role plan --guards`, then run fixes as
  `SDLC_TASK=fix claude`.
- **Everyone:** add `templates/managed-settings.sdlc-guards.json` to managed settings. The
  hook still only acts when `SDLC_TASK=fix` is set.
- **CI fixes:** `templates/workflows/claude-fix.yml` sets `SDLC_TASK=fix` and installs the
  plugin. policy-bank is private, so give the runner read access to it: make it internal, or
  pass a token that can read it.

## Layout

```
.github/workflows/adr-controls-check.yml   the workflow the org ruleset requires
.github/CODEOWNERS                         architecture + security own this repo
scripts/check_controls.py                  the check (Python 3.9+, PyYAML)
org-controls.yaml                          org controls, protected paths, governing ADR
adr/NNNN-*.md                              org ADRs (ORG-NNNN)
templates/controls.yaml                    copy to <repo>/policy/controls.yaml
templates/adr-template.md                  copy to <repo>/docs/adr/NNNN-title.md
tests/make_fixtures.sh                     builds 3 fixture repos and runs the check
.claude-plugin/marketplace.json            the policy-bank marketplace
plugins/<name>/                            role plugins and their skills
scripts/install.sh                         installs the plugins for one or more roles
templates/CODEOWNERS.sdlc                  role reviewers for intent/spec/plan PRs
templates/claude/settings.json             repo settings that offer the plugins
templates/managed-settings.sdlc-guards.json  managed settings that enable the sdlc-guards hook
templates/workflows/claude-fix.yml         fix workflow: fix/ branches, SDLC_TASK=fix
```

In a service repo: `docs/adr/NNNN-title.md` (ids `ADR-NNNN`) and `policy/controls.yaml`.

## Try it locally

```
pip install pyyaml
bash tests/make_fixtures.sh /tmp/fixtures      # expect: pass=0, missing-adr=1, loosens=1,
                                                #   fix-edits-tests=1, fix-code-only=0
python3 scripts/check_controls.py --repo ../my-service --policy . \
  --base origin/main --head HEAD --pr-body-file body.txt
```

## Set up in GitHub

Checked against the github/docs source. "Require workflows to pass before merging" and
Evaluate mode are GitHub Enterprise Cloud (and GHES 3.12+) features.

1. **Create the repo** `<org>/policy-bank` with **internal** visibility. An internal workflow can
   run on internal and private repos; a private one only on private repos. Push this kit.
   Action refs are pinned to commit SHAs; bump them deliberately.
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
