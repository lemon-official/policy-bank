#!/usr/bin/env bash
# PreToolUse hook for ORG-0006: during a fix task, block edits to tests, test data and
# test/coverage config. Active only when SDLC_TASK=fix (set by the fix workflow, or run
# `SDLC_TASK=fix claude` by hand). Exit 2 blocks the tool call and shows Claude the reason.
#
# Keep TEST_RE in step with org.fix-keeps-tests in org-controls.yaml. The Bash check is a
# best-effort heuristic; the required adr-controls-check workflow is the real control.
set -uo pipefail
[ "${SDLC_TASK:-}" = "fix" ] || exit 0
command -v jq >/dev/null || { echo "sdlc-guards: jq is required for ORG-0006 checks" >&2; exit 2; }

TEST_RE='(^|/)(tests?|__tests__|testdata|fixtures)/|_test\.[A-Za-z0-9]+$|\.(test|spec)\.[A-Za-z0-9]+$|(^|/)test_[^/]*\.py$|(^|/)conftest\.py$|(^|/)(jest|vitest)\.config\.[A-Za-z0-9]+$|(^|/)(pytest\.ini|\.coveragerc|codecov\.yml)$|(^|/)policy/controls\.yaml$'
WHY="Blocked by ORG-0006 (fix tasks can't change the tests that judge them): see adr/0006-fix-tasks-keep-tests.md in lemon-official/policy-bank. Fix the code instead. If the test itself is wrong, say so in the PR description and leave the test for a person to change in a separate PR."

input=$(cat)
tool=$(jq -r '.tool_name // empty' <<<"$input")

if [ "$tool" = "Bash" ]; then
  cmd=$(jq -r '.tool_input.command // empty' <<<"$input")
  # Redirects to /dev/null or between file descriptors don't write files.
  cmd=$(sed -E 's#[0-9]*>>?[[:space:]]*/dev/null##g; s#[0-9]*>&[0-9-]##g' <<<"$cmd")
  # Only commands that write, move or delete files, and that name a test path.
  if grep -Eq '(^|[^<])>|\btee\b|\bsed\b[^|;&]*-i|\bperl\b[^|;&]*-i|\b(rm|mv|cp|truncate|git (checkout|restore|rm|mv|apply))\b' <<<"$cmd"; then
    for tok in $cmd; do
      tok=${tok#[\'\"]}; tok=${tok%[\'\";]}
      if grep -Eq "$TEST_RE" <<<"$tok"; then
        echo "$WHY (command touches $tok)" >&2
        exit 2
      fi
    done
  fi
  exit 0
fi

f=$(jq -r '.tool_input.file_path // .tool_input.notebook_path // empty' <<<"$input")
[ -n "$f" ] || exit 0
cwd=$(jq -r '.cwd // empty' <<<"$input")
rel=${f#"${cwd:+$cwd/}"}
if grep -Eq "$TEST_RE" <<<"$rel"; then
  echo "$WHY (file: $rel)" >&2
  exit 2
fi
exit 0
