#!/usr/bin/env bash
# Install the policy-bank marketplace and the SDLC plugins for one or more roles.
#
#   ./install.sh --role po                 product owners: write intents, review and accept specs
#   ./install.sh --role spec               spec writers: spec-from-intent
#   ./install.sh --role plan               engineers: plan-from-spec
#   ./install.sh --role po --role plan     several roles
#   ./install.sh --role agents             example subagents (policy-reviewer, adr-scout, ...)
#   ./install.sh --role all                everything
#
# Every role also gets org-policies (brand, security, UX) and org-guardrails (hooks),
# pulled in as dependencies.
# Options: --scope user|project|local (default user). Safe to re-run.
# POLICY_BANK_SOURCE overrides the marketplace source (default lemon-official/policy-bank).
set -euo pipefail

MARKETPLACE=policy-bank
SOURCE="${POLICY_BANK_SOURCE:-lemon-official/policy-bank}"
SCOPE=user
roles=()

usage() { sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --role)  [ $# -ge 2 ] || usage 2; roles+=("$2"); shift 2 ;;
    --scope) [ $# -ge 2 ] || usage 2; SCOPE="$2"; shift 2 ;;
    -h|--help) usage 0 ;;
    *) echo "unknown argument: $1" >&2; usage 2 ;;
  esac
done
[ ${#roles[@]} -gt 0 ] || { echo "at least one --role is required" >&2; usage 2; }
command -v claude >/dev/null || { echo "claude (Claude Code) is not on PATH" >&2; exit 1; }

plugins=(org-policies org-guardrails)
for r in "${roles[@]}"; do
  case "$r" in
    po)   plugins+=(sdlc-intent) ;;
    spec) plugins+=(sdlc-spec) ;;
    plan) plugins+=(sdlc-plan) ;;
    agents) plugins+=(example-agents) ;;
    all)  plugins+=(sdlc-intent sdlc-spec sdlc-plan example-agents) ;;
    *) echo "unknown role: $r (po, spec, plan, agents, all)" >&2; exit 2 ;;
  esac
done

if claude plugin marketplace list 2>/dev/null | grep -qw "$MARKETPLACE"; then
  echo "marketplace $MARKETPLACE already added; updating"
  claude plugin marketplace update "$MARKETPLACE"
else
  claude plugin marketplace add "$SOURCE"
fi

installed="$(claude plugin list 2>/dev/null || true)"
for p in $(printf '%s\n' "${plugins[@]}" | awk '!seen[$0]++'); do
  if grep -q "$p@$MARKETPLACE" <<<"$installed"; then
    echo "$p@$MARKETPLACE already installed"
  else
    claude plugin install "$p@$MARKETPLACE" --scope "$SCOPE"
  fi
done
echo "done. Restart Claude Code to load the skills and hooks."
