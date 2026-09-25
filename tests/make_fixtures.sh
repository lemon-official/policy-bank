#!/usr/bin/env bash
# Builds five throwaway git repos (base commit + PR head commit) and runs the check on each.
set -euo pipefail
KIT=$(cd "$(dirname "$0")/.." && pwd)
OUT=${1:-$(mktemp -d)}
rm -rf "$OUT"; mkdir -p "$OUT"
g(){ git -C "$1" -c user.name=t -c user.email=t@example.com "${@:2}"; }

base_repo(){ # common baseline: accepted ADRs, registry, CODEOWNERS, settings
  local r=$1; mkdir -p "$r"/{docs/adr,docs/changes,policy,.claude,.github,src}
  git init -q -b main "$r"
  cat > "$r/.github/CODEOWNERS" <<'X'
/docs/changes/   @my-org/product-owners
/docs/adr/       @my-org/architecture
/.claude/        @my-org/platform
/policy/         @my-org/platform
X
  for n in 0012:artifact-gates 0014:green-before-done; do
    printf -- '---\nid: ADR-%s\ntitle: %s\nstatus: Accepted\n---\n# ADR-%s\n' "${n%%:*}" "${n#*:}" "${n%%:*}" > "$r/docs/adr/${n%%:*}-${n#*:}.md"
  done
  cat > "$r/policy/controls.yaml" <<'X'
controls:
  - id: spec-gate
    kind: hook
    adr: ADR-0012
    applies_to: ["src/**", ".claude/**"]
  - id: coverage
    kind: threshold
    key: coverage_min
    value: 85
    adr: ADR-0014
    applies_to: ["src/**"]
X
  echo '{ "permissions": { "allow": ["Bash(npm test *)"] } }' > "$r/.claude/settings.json"
  echo 'print("hi")' > "$r/src/app.py"
  g "$r" add -A; g "$r" commit -qm base
}

# 1) pass: PR changes a hook and src, cites an Accepted ADR in the body
R="$OUT/pass"; base_repo "$R"
echo '{ "permissions": { "allow": ["Bash(npm test *)", "Bash(npm run lint *)"] } }' > "$R/.claude/settings.json"
echo 'print("hello")' > "$R/src/app.py"
g "$R" commit -qam "tighten hooks"
printf 'Adds lint to the allowlist per ADR-0014.\n' > "$OUT/pass.body"

# 2) missing ADR: new control cites ADR-0020 (no file), another has no adr, a
#    Proposed ADR, and .claude/ changes with no ADR in the body
R="$OUT/missing-adr"; base_repo "$R"
printf -- '---\nid: ADR-0019\nstatus: Proposed\n---\n# ADR-0019\n' > "$R/docs/adr/0019-new-guard.md"
cat >> "$R/policy/controls.yaml" <<'X'
  - id: migrations-guard
    kind: hook
    adr: ADR-0020
    applies_to: ["migrations/**"]
  - id: no-reason
    kind: hook
    applies_to: ["src/**"]
  - id: new-guard
    kind: hook
    adr: ADR-0019
    applies_to: [".claude/**"]
X
echo '{ "permissions": { "allow": ["Bash(npm test *)"] }, "hooks": {} }' > "$R/.claude/settings.json"
g "$R" add -A; g "$R" commit -qm "add guards"
printf 'Adds a couple of guards.\n' > "$OUT/missing-adr.body"

# 3) loosens org rules: allows gh pr *, disables an org control, coverage below floor,
#    drops the /docs/adr/ CODEOWNERS line. Body cites an Accepted ADR, so only loosening fails.
R="$OUT/loosens"; base_repo "$R"
echo '{ "permissions": { "allow": ["Bash(npm test *)", "Bash(gh pr *)"] } }' > "$R/.claude/settings.json"
sed -i.bak 's/value: 85/value: 70/' "$R/policy/controls.yaml" && rm "$R/policy/controls.yaml.bak"
printf 'overrides:\n  disable: [org.no-bypass-mode]\n' >> "$R/policy/controls.yaml"
sed -i.bak '/docs\/adr/d' "$R/.github/CODEOWNERS" && rm "$R/.github/CODEOWNERS.bak"
g "$R" commit -qam "speed things up"
printf 'Per ADR-0012.\n' > "$OUT/loosens.body"

# 4) fix PR edits a test: fix/ branch changes src and weakens the test -> ORG-0006 fails
R="$OUT/fix-edits-tests"; base_repo "$R"
mkdir -p "$R/tests"; echo 'def test_app(): assert 1 == 1' > "$R/tests/test_app.py"
g "$R" add -A; g "$R" commit -qm "add test"
g "$R" checkout -qb fix/null-check
echo 'print("fixed")' > "$R/src/app.py"
echo 'def test_app(): pass' > "$R/tests/test_app.py"
g "$R" commit -qam "fix null check"
printf 'Fixes the null check.\n' > "$OUT/fix-edits-tests.body"

# 5) fix PR that only changes code, labelled fix -> passes
R="$OUT/fix-code-only"; base_repo "$R"
mkdir -p "$R/tests"; echo 'def test_app(): assert 1 == 1' > "$R/tests/test_app.py"
g "$R" add -A; g "$R" commit -qm "add test"
echo 'print("fixed")' > "$R/src/app.py"
g "$R" commit -qam "fix null check"
printf 'Fixes the null check.\n' > "$OUT/fix-code-only.body"

head_ref(){ case "$1" in fix-edits-tests) echo fix/null-check ;; *) echo feature/x ;; esac; }
labels(){ case "$1" in fix-code-only) echo '["fix"]' ;; *) echo '[]' ;; esac; }

for f in pass missing-adr loosens fix-edits-tests fix-code-only; do
  echo "================ fixture: $f"
  set +e
  python3 "$KIT/scripts/check_controls.py" --repo "$OUT/$f" --policy "$KIT" \
    --base HEAD~1 --head HEAD --pr-body-file "$OUT/$f.body" \
    --head-ref "$(head_ref "$f")" --pr-labels "$(labels "$f")"
  echo "exit code: $?"
  set -e
done
