#!/usr/bin/env python3
"""Central ADR/controls check.

Run by the org-required workflow against every PR in a targeted repository.
Fails when:
  1. a control in scope has no ADR, or its ADR file is missing or not Accepted;
  2. the diff touches protected paths (.claude/**, policy/**, managed settings)
     without referencing an Accepted ADR in the PR body or in a changed ADR file;
  3. a repo-local rule loosens an org control (disables it, allows what it
     denies, drops a threshold below the org floor, removes a required
     CODEOWNERS line, turns off the org guardrail hooks).

A control is in scope when one of its `applies_to` globs matches a changed
file, or when the registry file that defines it changed.

Dependencies: Python 3.9+ stdlib and PyYAML.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path

try:
    import yaml
except ImportError:  # pragma: no cover
    sys.exit("check_controls.py needs PyYAML: pip install pyyaml")

LOCAL_REGISTRY = "policy/controls.yaml"
LOCAL_ADR_DIR = "docs/adr"
ORG_REGISTRY = "org-controls.yaml"
ORG_ADR_DIR = "adr"
ID_RE = re.compile(r"\b(ADR|ORG)-(\d{4})\b")


# ---------------------------------------------------------------- helpers

def glob_to_regex(pattern: str) -> re.Pattern:
    """gitignore-ish glob: ** spans directories, * and ? stay in one segment."""
    p = pattern.lstrip("/")
    out, i = [], 0
    while i < len(p):
        if p.startswith("**/", i):
            out.append(r"(?:.*/)?")
            i += 3
        elif p.startswith("**", i):
            out.append(r".*")
            i += 2
        elif p[i] == "*":
            out.append(r"[^/]*")
            i += 1
        elif p[i] == "?":
            out.append(r"[^/]")
            i += 1
        else:
            out.append(re.escape(p[i]))
            i += 1
    return re.compile("^" + "".join(out) + "$")


def matches_any(path: str, globs) -> bool:
    return any(glob_to_regex(g).match(path) for g in (globs or []))


def load_yaml(path: Path) -> dict:
    if not path.exists():
        return {}
    with path.open(encoding="utf-8") as fh:
        data = yaml.safe_load(fh) or {}
    if not isinstance(data, dict):
        raise SystemExit(f"{path}: expected a YAML mapping at the top level")
    return data


def changed_files(repo: Path, base: str, head: str) -> list[str]:
    out = subprocess.run(
        ["git", "-C", str(repo), "diff", "--name-only", f"{base}...{head}"],
        check=True, capture_output=True, text=True,
    ).stdout
    return [line.strip() for line in out.splitlines() if line.strip()]


def adr_status(path: Path) -> str | None:
    """Status from YAML front matter (`status:`) or a `Status:` line."""
    text = path.read_text(encoding="utf-8")
    if text.startswith("---"):
        end = text.find("\n---", 3)
        if end != -1:
            try:
                fm = yaml.safe_load(text[3:end]) or {}
                if isinstance(fm, dict) and fm.get("status"):
                    return str(fm["status"]).strip()
            except yaml.YAMLError:
                pass
    m = re.search(r"^\s*(?:\*\*)?status(?:\*\*)?\s*:\s*(?:\*\*)?\s*([A-Za-z ]+)",
                  text, re.IGNORECASE | re.MULTILINE)
    return m.group(1).strip() if m else None


@dataclass
class Adr:
    ident: str
    path: str | None      # display path, e.g. docs/adr/0012-x.md or policy:adr/0001-x.md
    status: str | None

    @property
    def accepted(self) -> bool:
        return bool(self.status) and self.status.lower().startswith("accepted")

    def label(self) -> str:
        return f"[{self.ident} {self.path or '(no file)'}]"


@dataclass
class Checker:
    repo: Path
    policy: Path
    failures: list[str] = field(default_factory=list)

    def resolve(self, ident: str | None) -> Adr | None:
        if not ident:
            return None
        m = ID_RE.fullmatch(str(ident).strip())
        if not m:
            return Adr(str(ident), None, None)
        kind, num = m.groups()
        root, prefix, shown = (
            (self.repo / LOCAL_ADR_DIR, LOCAL_ADR_DIR, "") if kind == "ADR"
            else (self.policy / ORG_ADR_DIR, ORG_ADR_DIR, "policy:")
        )
        hits = sorted(root.glob(f"{num}-*.md")) if root.exists() else []
        if not hits:
            return Adr(ident, None, None)
        return Adr(ident, f"{shown}{prefix}/{hits[0].name}", adr_status(hits[0]))

    def fail(self, adr_label: str, message: str, file: str | None = None) -> None:
        self.failures.append(f"FAIL {adr_label} {message}")
        if os.environ.get("GITHUB_ACTIONS") == "true":
            loc = f" file={file}" if file else ""
            print(f"::error{loc}::{adr_label} {message}")


# ---------------------------------------------------------------- checks

def check_adrs(ck: Checker, controls: list[dict], origin: str) -> None:
    for c in controls:
        cid = c.get("id", "(no id)")
        adr = ck.resolve(c.get("adr"))
        if adr is None:
            ck.fail("[no ADR]", f"{origin} control '{cid}' has no adr: field", LOCAL_REGISTRY)
        elif adr.path is None:
            ck.fail(adr.label(), f"{origin} control '{cid}' cites {adr.ident}, but no ADR file exists for it")
        elif not adr.accepted:
            ck.fail(adr.label(), f"{origin} control '{cid}': ADR status is "
                    f"'{adr.status or 'missing'}', must be Accepted", adr.path)


def check_reference(ck: Checker, changed: list[str], protected: list[str],
                    pr_body: str, governing: Adr | None) -> None:
    touched = [f for f in changed if matches_any(f, protected)]
    if not touched:
        return
    ids = {f"{k}-{n}" for k, n in ID_RE.findall(pr_body)}
    for f in changed:
        m = re.match(rf"^{re.escape(LOCAL_ADR_DIR)}/(\d{{4}})-.*\.md$", f)
        if m:
            ids.add(f"ADR-{m.group(1)}")
    accepted = [a for a in (ck.resolve(i) for i in sorted(ids)) if a and a.accepted]
    if not accepted:
        seen = ", ".join(sorted(ids)) or "none"
        lbl = governing.label() if governing else "[policy]"
        ck.fail(lbl, f"PR changes protected paths ({', '.join(touched)}) but references no "
                f"Accepted ADR (found: {seen}). Cite one in the PR body or add a superseding ADR.")


def rule_parts(rule: str) -> tuple[str, str | None]:
    m = re.fullmatch(r"\s*([A-Za-z0-9_:.\-]+)\s*(?:\((.*)\))?\s*", rule)
    if not m:
        return rule.strip(), None
    return m.group(1), m.group(2)


def allow_covers_deny(allow: str, deny: str) -> bool:
    """True when an allow rule would permit something the deny rule forbids."""
    at, aspec = rule_parts(allow)
    dt, dspec = rule_parts(deny)
    if at != dt:
        return False
    if aspec is None or aspec.strip() in ("*", "**"):
        return True
    if dspec is None:
        return False
    a = aspec.replace(":*", " *")
    d = dspec.replace(":*", " *")
    if a == d:
        return True
    # allow pattern matches the deny pattern text (e.g. "gh pr *" covers "gh pr merge *")
    rx = re.compile("^" + re.escape(a).replace(r"\*", ".*") + "$")
    return bool(rx.match(d))


def local_settings(repo: Path) -> list[tuple[str, dict | str]]:
    """(path, parsed settings) per repo settings file; a string when the JSON is invalid."""
    out = []
    for rel in (".claude/settings.json", ".claude/settings.local.json"):
        p = repo / rel
        if p.exists():
            try:
                out.append((rel, json.loads(p.read_text(encoding="utf-8"))))
            except json.JSONDecodeError as e:
                out.append((rel, str(e)))
    return out


def local_allow_rules(repo: Path) -> list[tuple[str, str]]:
    rules = []
    for rel, data in local_settings(repo):
        if isinstance(data, str):
            rules.append((rel, f"__invalid__:{data}"))
            continue
        for r in (data.get("permissions") or {}).get("allow") or []:
            rules.append((rel, r))
    return rules


def check_loosening(ck: Checker, org: list[dict], local_doc: dict,
                    in_scope: set[str]) -> None:
    org_by_id = {c.get("id"): c for c in org}
    local_controls = local_doc.get("controls") or []

    # a) disabling an org control, via overrides.disable or a control's `disables:`
    disabled = list((local_doc.get("overrides") or {}).get("disable") or [])
    for c in local_controls:
        disabled += c.get("disables") or []
    for cid in disabled:
        if cid in org_by_id:
            adr = ck.resolve(org_by_id[cid].get("adr"))
            ck.fail(adr.label() if adr else "[org]",
                    f"repo tries to disable org control '{cid}'. Org controls can only change "
                    f"through a superseding org ADR in the policy repo.", LOCAL_REGISTRY)

    allows = local_allow_rules(ck.repo)
    for c in org:
        cid = c.get("id")
        if cid not in in_scope:
            continue
        adr = ck.resolve(c.get("adr"))
        lbl = adr.label() if adr else "[org]"
        kind = c.get("kind")

        # b) allow entries that cover an org deny
        if kind == "permission-deny":
            for src, rule in allows:
                if rule.startswith("__invalid__:"):
                    ck.fail(lbl, f"{src} is not valid JSON ({rule[12:]})", src)
                    continue
                for deny in c.get("deny") or []:
                    if allow_covers_deny(rule, deny):
                        ck.fail(lbl, f"{src} allows '{rule}', which org control '{cid}' denies "
                                f"('{deny}')", src)

        # c) thresholds below the org floor
        elif kind == "threshold":
            key, floor = c.get("key"), c.get("min")
            for lc in local_controls:
                if lc.get("key") == key and lc.get("value") is not None and floor is not None:
                    if float(lc["value"]) < float(floor):
                        ck.fail(lbl, f"local control '{lc.get('id')}' sets {key}={lc['value']}, "
                                f"below the org floor {floor} ('{cid}')", LOCAL_REGISTRY)

        # d) turning off an org plugin's hooks
        elif kind == "plugin-enabled":
            plugin = c.get("plugin")
            for src, data in local_settings(ck.repo):
                if isinstance(data, str):
                    continue
                if data.get("disableAllHooks") is True:
                    ck.fail(lbl, f"{src} sets disableAllHooks, which turns off org control "
                            f"'{cid}' ({plugin})", src)
                if (data.get("enabledPlugins") or {}).get(plugin) is False:
                    ck.fail(lbl, f"{src} disables {plugin} (org control '{cid}')", src)

        # e) required CODEOWNERS lines
        elif kind == "codeowners":
            owners = next((ck.repo / p for p in (".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS")
                           if (ck.repo / p).exists()), None)
            text = owners.read_text(encoding="utf-8") if owners else ""
            patterns = {ln.split()[0] for ln in text.splitlines()
                        if ln.strip() and not ln.lstrip().startswith("#")}
            for req in c.get("require_codeowners") or []:
                if req not in patterns:
                    ck.fail(lbl, f"CODEOWNERS has no owner line for '{req}' (org control '{cid}')",
                            str(owners.relative_to(ck.repo)) if owners else ".github/CODEOWNERS")


# ---------------------------------------------------------------- main

def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--repo", required=True, help="checkout of the repository under review")
    ap.add_argument("--policy", required=True, help="checkout of the central policy repo")
    ap.add_argument("--base", required=True)
    ap.add_argument("--head", required=True)
    ap.add_argument("--pr-body-file", help="file holding the PR description")
    ap.add_argument("--skip-pr-reference", action="store_true",
                    help="skip the protected-path reference check (merge_group runs)")
    a = ap.parse_args(argv)

    ck = Checker(Path(a.repo).resolve(), Path(a.policy).resolve())
    org_doc = load_yaml(ck.policy / ORG_REGISTRY)
    local_doc = load_yaml(ck.repo / LOCAL_REGISTRY)
    org = org_doc.get("controls") or []
    local = local_doc.get("controls") or []
    protected = org_doc.get("protected_paths") or [".claude/**", "policy/**", "**/managed-settings*.json"]
    governing = ck.resolve(org_doc.get("traceability_adr"))

    changed = changed_files(ck.repo, a.base, a.head)
    registry_changed = LOCAL_REGISTRY in changed

    in_scope_local = [c for c in local if registry_changed or matches_any_changed(c, changed)]
    in_scope_org = {c.get("id") for c in org
                    if matches_any_changed(c, changed) or registry_changed}

    print(f"Changed files: {len(changed)}")
    print(f"Local controls in scope: {', '.join(c.get('id', '?') for c in in_scope_local) or 'none'}")
    print(f"Org controls in scope: {', '.join(sorted(i for i in in_scope_org if i)) or 'none'}")

    check_adrs(ck, in_scope_local, "local")
    check_adrs(ck, [c for c in org if c.get("id") in in_scope_org], "org")
    if not a.skip_pr_reference:
        body = Path(a.pr_body_file).read_text(encoding="utf-8") if a.pr_body_file else ""
        check_reference(ck, changed, protected, body, governing)
    check_loosening(ck, org, local_doc, in_scope_org)

    if ck.failures:
        print()
        print("\n".join(ck.failures))
        print(f"\n{len(ck.failures)} problem(s). Each line names the ADR that explains the rule.")
        return 1
    print("\nOK: every control in scope traces to an Accepted ADR and no org control is loosened.")
    return 0


def matches_any_changed(control: dict, changed: list[str]) -> bool:
    return any(matches_any(f, control.get("applies_to")) for f in changed)


if __name__ == "__main__":
    sys.exit(main())
