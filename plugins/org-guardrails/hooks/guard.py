#!/usr/bin/env python3
"""org-guardrails: Claude Code hooks that enforce the org ADRs on the developer's machine.

    guard.py session-start    SessionStart   show the active change, its stage and the next skill
    guard.py pre-tool-use     PreToolUse     ORG-0002 merge/force-push/.env guard,
                                             ORG-0006 hook tamper guard, spec gate (opt-in)
    guard.py post-tool-use    PostToolUse    ORG-0005 reminder after editing a protected path
    guard.py stop             Stop           stop gate (opt-in): tests must pass before done

The spec gate and stop gate turn on when the repo's policy/controls.yaml lists a control with
id `spec-gate` or `stop-gate` (see templates/controls.yaml in policy-bank). The rest is always on.

Reads the hook input as JSON on stdin. Python 3.9+ stdlib; uses PyYAML when it's installed.
A crash exits 1, which Claude Code treats as a non-blocking error: the guard fails open and the
permission denies and the required CI check stay the backstop (ORG-0006).
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import sys
from pathlib import Path

REGISTRY = "policy/controls.yaml"
CHANGES = "docs/changes"
PLUGIN = "org-guardrails@policy-bank"
PROTECTED = [".claude/**", "policy/**", "**/managed-settings*.json"]  # org-controls.yaml
ENV_EXEMPT = ("example", "sample", "template", "dist")
FILE_TOOLS = {"Read", "Edit", "Write", "MultiEdit", "NotebookEdit", "Grep"}
WRITE_TOOLS = {"Edit", "Write", "MultiEdit", "NotebookEdit"}


# ---------------------------------------------------------------- helpers

def glob_to_regex(pattern: str) -> re.Pattern:
    """Same globs as scripts/check_controls.py: ** spans directories, * and ? stay in one segment."""
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


def as_list(value) -> list:
    if value is None:
        return []
    return value if isinstance(value, list) else [value]


def git(root: Path, *args: str) -> str | None:
    try:
        r = subprocess.run(["git", "-C", str(root), *args], capture_output=True, text=True, timeout=20)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return r.stdout if r.returncode == 0 else None


def project_root(data: dict) -> Path:
    cwd = data.get("cwd") or os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd()
    top = git(Path(cwd), "rev-parse", "--show-toplevel")
    return Path(top.strip()) if top else Path(cwd)


def rel_to(root: Path, file_path: str | None) -> str | None:
    if not file_path:
        return None
    p = Path(file_path)
    p = p if p.is_absolute() else root / p
    try:
        return p.resolve().relative_to(root.resolve()).as_posix()
    except ValueError:
        return None


def default_ref(root: Path) -> str | None:
    for ref in ("origin/HEAD", "origin/main", "origin/master", "main", "master"):
        if git(root, "rev-parse", "--verify", "-q", f"{ref}^{{commit}}"):
            return ref
    return None


def file_at(root: Path, ref: str | None, rel: str) -> str | None:
    """File text at a git ref, or in the working tree when ref is None."""
    if ref is None:
        p = root / rel
        return p.read_text(encoding="utf-8") if p.exists() else None
    return git(root, "show", f"{ref}:{rel}")


def unquote(v: str):
    v = v.strip()
    if len(v) >= 2 and v[0] == v[-1] and v[0] in "'\"":
        return v[1:-1]
    if v.lower() in ("true", "false"):
        return v.lower() == "true"
    if re.fullmatch(r"-?\d+", v):
        return int(v)
    return v or None


def strip_comment(line: str) -> str:
    quote = None
    for i, ch in enumerate(line):
        if quote:
            quote = None if ch == quote else quote
        elif ch in "'\"":
            quote = ch
        elif ch == "#" and (i == 0 or line[i - 1].isspace()):
            return line[:i]
    return line


def scalar(v: str):
    v = v.strip()
    if v.startswith("[") and v.endswith("]"):
        items, cur, quote = [], "", None
        for ch in v[1:-1]:
            if quote:
                quote = None if ch == quote else quote
                cur += ch
            elif ch in "'\"":
                quote = ch
                cur += ch
            elif ch == ",":
                items.append(cur)
                cur = ""
            else:
                cur += ch
        items.append(cur)
        return [unquote(i) for i in items if i.strip()]
    return unquote(v)


def parse_controls(text: str) -> list[dict]:
    """controls: list from policy/controls.yaml. Without PyYAML, reads flat keys and inline lists."""
    try:
        import yaml  # type: ignore
        doc = yaml.safe_load(text) or {}
        return [c for c in (doc.get("controls") or []) if isinstance(c, dict)]
    except ImportError:
        pass
    controls, cur, inside = [], None, False
    for raw in text.splitlines():
        line = strip_comment(raw).rstrip()
        if not line.strip():
            continue
        if not line.startswith((" ", "-")):
            inside, cur = line.startswith("controls:"), None
            continue
        if not inside:
            continue
        m = re.match(r"^\s*-\s+([\w-]+)\s*:(.*)$", line)
        if m:
            cur = {m.group(1): scalar(m.group(2))}
            controls.append(cur)
            continue
        m = re.match(r"^\s+([\w-]+)\s*:(.*)$", line)
        if m and cur is not None:
            cur[m.group(1)] = scalar(m.group(2))
    return controls


def load_controls(root: Path) -> dict[str, dict]:
    p = root / REGISTRY
    if not p.exists():
        return {}
    return {str(c["id"]): c for c in parse_controls(p.read_text(encoding="utf-8")) if c.get("id")}


def front_matter(text: str | None) -> dict:
    if not text or not text.startswith("---"):
        return {}
    end = text.find("\n---", 3)
    if end == -1:
        return {}
    out = {}
    for line in text[3:end].splitlines():
        m = re.match(r"^([\w-]+)\s*:(.*)$", strip_comment(line))
        if m:
            out[m.group(1)] = scalar(m.group(2))
    return out


def change_ids(root: Path, ref: str | None) -> set[str]:
    ids = {p.name for p in (root / CHANGES).glob("*") if p.is_dir()}
    if ref:
        listing = git(root, "ls-tree", "-d", "--name-only", f"{ref}:{CHANGES}") or ""
        ids |= {line.strip() for line in listing.splitlines() if line.strip()}
    return ids


def change_id(root: Path, ref: str | None) -> str | None:
    """SDLC_CHANGE, else a docs/changes/<id> named in the branch, else a <yyyy>-<nn>-<slug> in it."""
    env = os.environ.get("SDLC_CHANGE", "").strip()
    if env:
        return env
    branch = (git(root, "rev-parse", "--abbrev-ref", "HEAD") or "").strip()
    if not branch or branch == "HEAD":
        return None
    hits = [i for i in change_ids(root, ref) if i in branch]
    if hits:
        return max(hits, key=len)
    m = re.search(r"\d{4}-\d{2}-[a-z0-9][a-z0-9-]*", branch)
    return m.group(0) if m else None


def state_path(root: Path, name: str) -> Path:
    gp = git(root, "rev-parse", "--git-path", "org-guardrails")
    base = (root / gp.strip()) if gp else Path(os.environ.get("TMPDIR", "/tmp")) / "org-guardrails"
    base.mkdir(parents=True, exist_ok=True)
    return base / name


def read_state(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def write_state(path: Path, state: dict) -> None:
    path.write_text(json.dumps(state), encoding="utf-8")


def emit(obj: dict) -> None:
    print(json.dumps(obj))


def deny(reason: str) -> None:
    emit({"hookSpecificOutput": {"hookEventName": "PreToolUse",
                                 "permissionDecision": "deny",
                                 "permissionDecisionReason": reason}})


def context(event: str, text: str) -> None:
    emit({"hookSpecificOutput": {"hookEventName": event, "additionalContext": text}})


# ---------------------------------------------------------------- ORG-0002: merge, force-push, .env

MERGE_RES = [
    re.compile(r"\bgh\s+pr\s+merge\b"),
    re.compile(r"\bgh\s+api\b[^;&|\n]*\bpulls/[^/\s]+/merge\b"),
]
PUSH_RE = re.compile(r"\bgit\b[^;&|\n]*?\bpush\b([^;&|\n]*)")
FORCE_RES = [
    re.compile(r"(?:^|\s)--(?:force|force-with-lease|force-if-includes|mirror)\b"),
    re.compile(r"(?:^|\s)-[a-zA-Z]*f[a-zA-Z]*(?=\s|$)"),
    re.compile(r"(?:^|\s)\+\S"),
]
ENV_RE = re.compile(
    r"(?:^|[\s/=<'\"`(])\.env(?:\.(?!(?:%s)\b)[\w.-]+)?(?=$|[\s'\"`;|&)<>])" % "|".join(ENV_EXEMPT))


def is_env_file(path: str | None) -> bool:
    if not path:
        return False
    name = Path(path).name
    if name == ".env":
        return True
    return name.startswith(".env.") and name.split(".")[2] not in ENV_EXEMPT


def check_bash(cmd: str) -> str | None:
    for rx in MERGE_RES:
        if rx.search(cmd):
            return ("ORG-0002: agents don't merge PRs. The merge is the human approval gate. "
                    "Ask the owner to review and merge it.")
    for m in PUSH_RE.finditer(cmd):
        if any(rx.search(m.group(1)) for rx in FORCE_RES):
            return ("ORG-0002: agents don't force-push. Push a new commit instead, "
                    "or ask a human to rewrite the branch.")
    if ENV_RE.search(cmd):
        return ("ORG-0002: agents don't read .env files. Ask for the variable names you need, "
                "or use .env.example.")
    return None


# ---------------------------------------------------------------- ORG-0006: hook tamper guard

TAMPER_RES = [
    (re.compile(r'"disableAllHooks"\s*:\s*true'), "turn off all hooks (disableAllHooks)"),
    (re.compile(r'"%s"\s*:\s*false' % re.escape(PLUGIN)), f"disable {PLUGIN}"),
    (re.compile(r'"defaultMode"\s*:\s*"bypassPermissions"'), "default to bypassPermissions (ORG-0003)"),
]


def new_text(tool: str, ti: dict) -> str:
    if tool == "Write":
        return ti.get("content") or ""
    if tool == "NotebookEdit":
        return ti.get("new_source") or ""
    parts = [ti.get("new_string") or ""]
    parts += [e.get("new_string") or "" for e in ti.get("edits") or [] if isinstance(e, dict)]
    return "\n".join(parts)


def check_tamper(rel: str | None, tool: str, ti: dict) -> str | None:
    if not rel:
        return None
    name = Path(rel).name
    is_settings = (re.fullmatch(r"settings(\.local)?\.json", name) and "/.claude/" in f"/{rel}") \
        or re.fullmatch(r"managed-settings.*\.json", name)
    if not is_settings:
        return None
    text = new_text(tool, ti)
    for rx, what in TAMPER_RES:
        if rx.search(text):
            return (f"ORG-0006: this edit would {what} in {rel}. Guardrail hooks can't be turned "
                    "off from a repo; that takes a superseding org ADR in policy-bank.")
    return None


# ---------------------------------------------------------------- spec gate (ORG-0001, opt-in)

def check_spec_gate(root: Path, rel: str | None, ctl: dict | None) -> str | None:
    if not ctl or not rel or not matches_any(rel, as_list(ctl.get("paths")) or ["src/**"]):
        return None
    adr = ctl.get("adr") or "ORG-0001"
    ref = default_ref(root)
    cid = change_id(root, ref)
    if not cid:
        return (f"spec-gate ({adr}): {rel} needs an accepted spec, but this branch names no change. "
                f"Use a branch named after the change id (for example feat/2026-14-guest-checkout) "
                f"or set SDLC_CHANGE=<id>.")
    spec = f"{CHANGES}/{cid}/spec.md"
    text = file_at(root, ref, spec)
    where = ref or "the working tree"
    if text is None:
        return (f"spec-gate ({adr}): no {spec} on {where}. No code before an accepted spec: "
                f"run spec-from-intent, get it accepted and merged (git fetch if it just merged).")
    status = str(front_matter(text).get("status") or "missing")
    if status.lower() != "accepted":
        return (f"spec-gate ({adr}): {spec} on {where} has status '{status}'. No code before the "
                f"spec is accepted and merged: see review-spec-against-intent and accept-spec.")
    return None


# ---------------------------------------------------------------- events

def pre_tool_use(data: dict) -> None:
    tool = data.get("tool_name") or ""
    ti = data.get("tool_input") or {}
    root = project_root(data)

    if tool == "Bash":
        reason = check_bash(ti.get("command") or "")
        if reason:
            deny(reason)
        return
    if tool not in FILE_TOOLS:
        return

    path = ti.get("file_path") or ti.get("notebook_path") or ti.get("path")
    if is_env_file(path) or (tool == "Grep" and is_env_file(ti.get("glob"))):
        deny("ORG-0002: agents don't read .env files. Ask for the variable names you need, "
             "or use .env.example.")
        return
    if tool not in WRITE_TOOLS:
        return

    rel = rel_to(root, path)
    reason = check_tamper(rel, tool, ti) \
        or check_spec_gate(root, rel, load_controls(root).get("spec-gate"))
    if reason:
        deny(reason)


def post_tool_use(data: dict) -> None:
    ti = data.get("tool_input") or {}
    root = project_root(data)
    rel = rel_to(root, ti.get("file_path") or ti.get("notebook_path"))
    if not rel or not matches_any(rel, PROTECTED):
        return
    sp = state_path(root, "reminded.json")
    state = read_state(sp)
    seen = state.setdefault(data.get("session_id") or "-", [])
    if rel in seen:
        return
    seen.append(rel)
    write_state(sp, state)
    context("PostToolUse",
            f"ORG-0005: {rel} is a protected path. The PR that carries it must cite an Accepted "
            f"ADR (ORG-NNNN or ADR-NNNN) in its body or add one under docs/adr/, or the required "
            f"control-traceability check fails. Repos may tighten org controls, never loosen them.")


def stage(root: Path, ref: str | None, cid: str) -> tuple[str, str]:
    """(where the change is, what to run next). Without a default branch, the tree counts as merged."""
    base = f"{CHANGES}/{cid}"
    here = lambda name: (root / base / name).exists()  # noqa: E731
    merged = lambda name: file_at(root, ref, f"{base}/{name}") is not None if ref else here(name)  # noqa: E731

    if not here("intent.md") and not merged("intent.md"):
        return "no intent yet", "write-intent (product owner)"
    if not merged("intent.md"):
        return "intent in review", "merge the intent PR; then spec-from-intent"
    if not here("spec.md") and not merged("spec.md"):
        return "intent accepted", "spec-from-intent (spec writer)"
    spec = file_at(root, None, f"{base}/spec.md") or file_at(root, ref, f"{base}/spec.md")
    if str(front_matter(spec).get("status") or "").lower() != "accepted":
        open_ = len(re.findall(r"^\s*status:\s*open\b", spec or "", re.MULTILINE))
        nxt = f"resolve-concerns ({open_} open)" if open_ else "review-spec-against-intent, then accept-spec"
        return "spec in review", nxt
    main_spec = file_at(root, ref, f"{base}/spec.md") if ref else spec
    if str(front_matter(main_spec).get("status") or "").lower() != "accepted":
        return "spec accepted, not merged", "the owner merges the spec PR; then plan-from-spec"
    if not here("plan.md") and not merged("plan.md"):
        return "spec accepted", "plan-from-spec (engineer, plan mode)"
    if not merged("plan.md"):
        return "plan in review", "engineering leads merge the plan PR; then build"
    return "build", "implement the plan steps; keep each one a reviewable PR"


def session_start(data: dict) -> None:
    root = project_root(data)
    controls = load_controls(root)
    if not controls and not (root / CHANGES).exists():
        return
    ref = default_ref(root)
    cid = change_id(root, ref)
    lines = ["Org guardrails (policy-bank org-guardrails): agents don't merge PRs, force-push or "
             "read .env files (ORG-0002)."]
    if cid:
        where, nxt = stage(root, ref, cid)
        lines.append(f"Active change: {cid} ({CHANGES}/{cid}/). Stage: {where}. Next: {nxt}.")
    elif (root / CHANGES).exists():
        lines.append("No active change: this branch names no change id and SDLC_CHANGE is unset.")
    sg, st = controls.get("spec-gate"), controls.get("stop-gate")
    if sg:
        lines.append(f"Spec gate on ({sg.get('adr')}): edits to "
                     f"{', '.join(as_list(sg.get('paths')) or ['src/**'])} need the change's "
                     f"spec.md accepted and merged.")
    if st and st.get("command"):
        lines.append(f"Stop gate on ({st.get('adr')}): `{st['command']}` must pass before you "
                     f"finish when code has changed.")
    context("SessionStart", "\n".join(lines))


def changed_files(root: Path, ref: str | None) -> set[str]:
    out = set()
    for args in (("diff", "--name-only", "HEAD"),
                 ("ls-files", "--others", "--exclude-standard"),
                 *((("diff", "--name-only", f"{ref}...HEAD"),) if ref else ())):
        out |= {line.strip() for line in (git(root, *args) or "").splitlines() if line.strip()}
    return out


def fingerprint(root: Path) -> str:
    h = hashlib.sha256()
    h.update((git(root, "rev-parse", "HEAD") or "").encode())
    h.update((git(root, "diff", "HEAD", "--binary") or "").encode())
    for rel in sorted((git(root, "ls-files", "--others", "--exclude-standard") or "").splitlines()):
        p = root / rel
        h.update(rel.encode())
        if p.is_file():
            h.update(p.read_bytes())
    return h.hexdigest()


def stop(data: dict) -> None:
    root = project_root(data)
    ctl = load_controls(root).get("stop-gate")
    cmd = ctl and ctl.get("command")
    if not cmd:
        return
    ref = default_ref(root)
    paths = as_list(ctl.get("paths")) or ["src/**"]
    if not any(matches_any(f, paths) for f in changed_files(root, ref)):
        return

    sp = state_path(root, "stop-gate.json")
    state = read_state(sp)
    fp = fingerprint(root)
    if state.get("green") == fp:
        return
    try:
        r = subprocess.run(cmd, shell=True, cwd=root, capture_output=True, text=True,
                           timeout=int(ctl.get("timeout") or 300))
        rc, output = r.returncode, (r.stdout or "") + (r.stderr or "")
    except subprocess.TimeoutExpired as e:
        rc, output = "timeout", f"timed out after {e.timeout}s"

    blocks = state.setdefault("blocks", {})
    session = data.get("session_id") or "-"
    adr = ctl.get("adr") or "stop-gate"
    if rc == 0:
        state["green"] = fp
        blocks.pop(session, None)
        write_state(sp, state)
        return
    if blocks.get(session, 0) >= int(ctl.get("max_blocks") or 3):
        write_state(sp, state)
        emit({"systemMessage": f"stop-gate ({adr}): `{cmd}` still fails after "
                               f"{blocks[session]} attempts. Not blocking again; don't merge this red."})
        return
    blocks[session] = blocks.get(session, 0) + 1
    write_state(sp, state)
    tail = "\n".join(output.strip().splitlines()[-40:])
    emit({"decision": "block",
          "reason": f"stop-gate ({adr}): `{cmd}` failed (exit {rc}). Green before done: fix it, "
                    f"or tell the user why you can't. Last output:\n{tail}"})


EVENTS = {"session-start": session_start, "pre-tool-use": pre_tool_use,
          "post-tool-use": post_tool_use, "stop": stop}


def main(argv: list[str]) -> int:
    if len(argv) != 2 or argv[1] not in EVENTS:
        print(f"usage: guard.py {{{'|'.join(EVENTS)}}}", file=sys.stderr)
        return 1
    raw = sys.stdin.read()
    data = json.loads(raw) if raw.strip() else {}
    EVENTS[argv[1]](data)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv))
    except Exception as e:  # fail open, visibly: see the module docstring
        print(f"org-guardrails: {type(e).__name__}: {e}", file=sys.stderr)
        sys.exit(1)
