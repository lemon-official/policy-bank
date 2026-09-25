# policy: central ADR/controls check

A required workflow that every PR in targeted repos must pass. It fails when:

1. a control in scope has no ADR, or its ADR is missing or not `Accepted`;
2. the PR touches `.claude/**`, `policy/**` or `**/managed-settings*.json` without citing an
   Accepted ADR, either in the PR body or as a changed file under `docs/adr/`;
3. a repo loosens an org control. That covers disabling one, a `permissions.allow` entry that
   covers an org deny, a threshold below the org floor, removing a required CODEOWNERS line,
   and turning off the org guardrail hooks.

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

| plugin | for | contents |
|---|---|---|
| `org-policies` | everyone (a dependency of the SDLC plugins) | skills: brand-guidelines, security-policy, ux-standards |
| `org-guardrails` | everyone (a dependency of the SDLC plugins) | hooks, see [Guardrail hooks](#guardrail-hooks) |
| `sdlc-intent` | product owners | skills: write-intent, review-spec-against-intent, resolve-concerns, accept-spec |
| `sdlc-spec` | spec writers | skills: spec-from-intent |
| `sdlc-plan` | engineers | skills: plan-from-spec |
| `example-agents` | anyone, opt-in | agents: policy-reviewer, adr-scout, requirements-tracer, green-keeper |

The policy skills are placeholders until brand, security and design replace their rules.
Intent, spec and plan templates sit next to the skill that writes them.

**Install by role** (safe to re-run; restart Claude Code afterwards):

```
./scripts/install.sh --role po            # po | spec | plan | agents | all, repeatable
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

## Guardrail hooks

`org-guardrails` enforces the org ADRs while Claude works, not only at PR time
([ORG-0006](adr/0006-guardrail-hooks.md)). One script, `plugins/org-guardrails/hooks/guard.py`,
handles every event:

| when | event (matcher) | what it does | rule | on |
|---|---|---|---|---|
| session starts, resumes, clears or compacts | `SessionStart` | tells Claude the active change, its stage and the next skill to run | ORG-0001 | always |
| before any shell command | `PreToolUse` (`Bash`) | denies `gh pr merge`, the merge API, force-push (`-f`, `--force*`, `+ref`, `--mirror`) | ORG-0002 | always |
| before reading or searching a file, or a shell command naming one | `PreToolUse` (`Read`, `Grep`, `Bash`, edits) | denies `.env` and `.env.*`; `.example`, `.sample`, `.template`, `.dist` are fine | ORG-0002 | always |
| before editing settings | `PreToolUse` (`Edit`, `Write`, `MultiEdit`) | denies `disableAllHooks`, disabling `org-guardrails`, `defaultMode: bypassPermissions` | ORG-0006, ORG-0003 | always |
| before editing gated code | `PreToolUse` (`Edit`, `Write`, `MultiEdit`, `NotebookEdit`) | spec gate: denies until `docs/changes/<id>/spec.md` is `accepted` on the default branch | ORG-0001 | `spec-gate` control |
| after editing a protected path | `PostToolUse` (edits) | once per file per session: the PR must cite an Accepted ADR | ORG-0005 | always |
| before Claude says it's done | `Stop` | stop gate: runs `command` when gated paths changed since the last green run; blocks on red, gives up after `max_blocks` | repo ADR | `stop-gate` control |

**Turn on the gates in a service repo** by adding `spec-gate` and `stop-gate` to
`policy/controls.yaml` (see [templates/controls.yaml](templates/controls.yaml)). Each cites a
repo ADR like any other control. Keys: `paths` (both), `command`, `timeout`, `max_blocks`
(stop gate).

**The active change** is `SDLC_CHANGE` if set, else the `docs/changes/<id>` named in the
branch (`feat/2026-14-guest-checkout`), else any `<yyyy>-<nn>-<slug>` in the branch name.

**Limits:** hooks match tool inputs, so a shell command that writes a gated file slips past the
spec gate. A hook that crashes fails open. The permission denies and the required check stay
the backstop. Hooks need `python3` (3.9+) on `PATH`; PyYAML is optional.

Test them with `python3 -m unittest discover -s tests`.

## Example agents

`example-agents` holds subagents to copy into a repo's `.claude/agents/` or a role plugin and
adapt. Each shows a different pattern:

| agent | pattern | use when |
|---|---|---|
| `policy-reviewer` | read-only, applies the org-policies skills, table output | before a spec or plan PR |
| `adr-scout` | cheap model (`haiku`), Bash scoped to `git diff`/`log`/`ls-files` | a PR touches protected paths, or the ADR check fails |
| `requirements-tracer` | read-only traceability, spec to plan to tests to code | after plan-from-spec, before calling a build done |
| `green-keeper` | can edit, with explicit "never" rules | the stop gate blocks or CI is red |

Claude delegates to them on its own when a task matches the `description`, or ask for one
by name ("use adr-scout on this branch").

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
plugins/org-guardrails/hooks/              guardrail hooks (hooks.json + guard.py)
plugins/example-agents/agents/             example subagents
tests/test_guard.py                        tests for the guardrail hooks
scripts/install.sh                         installs the plugins for one or more roles
templates/CODEOWNERS.sdlc                  role reviewers for intent/spec/plan PRs
templates/claude/settings.json             repo settings that offer the plugins
```

In a service repo: `docs/adr/NNNN-title.md` (ids `ADR-NNNN`) and `policy/controls.yaml`.

## Try it locally

```
pip install pyyaml
bash tests/make_fixtures.sh /tmp/fixtures      # expect: pass=0, missing-adr=1, loosens=1
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
