"""Tests for plugins/org-guardrails/hooks/guard.py. Run: python3 -m unittest discover -s tests"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

GUARD = Path(__file__).resolve().parents[1] / "plugins/org-guardrails/hooks/guard.py"

CONTROLS = """controls:
  - id: spec-gate
    kind: hook
    adr: ADR-0012   # comment
    applies_to: ["src/**"]
    paths: ["src/**"]
  - id: stop-gate
    kind: hook
    adr: ADR-0014
    applies_to: ["src/**"]
    command: "test ! -e src/red"
    paths: ["src/**"]
    max_blocks: 2
"""


def spec(status: str) -> str:
    return f"---\nintent: 2026-14-guest-checkout\ntitle: Guest checkout\nstatus: {status}\n---\n# Spec\n"


class Repo:
    def __init__(self, tmp: str):
        self.root = Path(tmp) / "repo"
        (self.root / "policy").mkdir(parents=True)
        (self.root / "src").mkdir()
        (self.root / "docs/changes/2026-14-guest-checkout").mkdir(parents=True)
        self.git("init", "-q", "-b", "main")
        self.write("policy/controls.yaml", CONTROLS)
        self.write("docs/changes/2026-14-guest-checkout/intent.md", "---\nstatus: proposed\n---\n")
        self.write("src/app.py", "print('hi')\n")
        self.commit("base")
        self.git("checkout", "-q", "-b", "feat/2026-14-guest-checkout")

    def git(self, *args: str) -> str:
        return subprocess.run(["git", "-C", str(self.root), "-c", "user.name=t",
                               "-c", "user.email=t@example.com", *args],
                              check=True, capture_output=True, text=True).stdout

    def write(self, rel: str, text: str) -> None:
        p = self.root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text)

    def commit(self, msg: str) -> None:
        self.git("add", "-A")
        self.git("commit", "-qm", msg)

    def merge_to_main(self) -> None:
        self.git("checkout", "-q", "main")
        self.git("merge", "-q", "--ff-only", "feat/2026-14-guest-checkout")
        self.git("checkout", "-q", "feat/2026-14-guest-checkout")

    def hook(self, event: str, **data) -> dict:
        data.setdefault("cwd", str(self.root))
        data.setdefault("session_id", "s1")
        env = {k: v for k, v in os.environ.items() if k != "SDLC_CHANGE"}
        r = subprocess.run([sys.executable, str(GUARD), event], input=json.dumps(data),
                           capture_output=True, text=True, env=env)
        assert r.returncode == 0, r.stderr
        return json.loads(r.stdout) if r.stdout.strip() else {}

    def pre(self, tool: str, **tool_input) -> dict:
        out = self.hook("pre-tool-use", tool_name=tool, tool_input=tool_input)
        return out.get("hookSpecificOutput") or {}

    def edit(self, rel: str, new: str = "x") -> dict:
        return self.pre("Edit", file_path=str(self.root / rel), old_string="a", new_string=new)


def denied(out: dict) -> bool:
    return out.get("permissionDecision") == "deny"


class BashGuard(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = Repo(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_denies_merge_force_push_and_env(self):
        for cmd in ["gh pr merge 12 --squash", "gh pr merge", "cd x && gh  pr merge",
                    "gh api -X PUT repos/o/r/pulls/7/merge",
                    "git push --force origin main", "git push -f", "git push origin main -uf",
                    "git push --force-with-lease", "git push origin +main", "git -C x push --mirror",
                    "cat .env", "grep KEY ./.env.local", "source .env && npm start",
                    "docker run --env-file=.env img"]:
            with self.subTest(cmd=cmd):
                self.assertTrue(denied(self.repo.pre("Bash", command=cmd)), cmd)

    def test_allows_ordinary_commands(self):
        for cmd in ["gh pr create --fill", "gh pr view 12", "git push -u origin feat/x",
                    "git push origin feature-fix", "git push --follow-tags", "cat .env.example",
                    "cp .env.sample .env.example", "direnv allow .envrc", "npm test"]:
            with self.subTest(cmd=cmd):
                self.assertFalse(denied(self.repo.pre("Bash", command=cmd)), cmd)

    def test_env_file_tools(self):
        self.assertTrue(denied(self.repo.pre("Read", file_path=str(self.repo.root / ".env"))))
        self.assertTrue(denied(self.repo.pre("Read", file_path="/x/.env.production")))
        self.assertTrue(denied(self.repo.pre("Grep", pattern="KEY", glob=".env")))
        self.assertFalse(denied(self.repo.pre("Read", file_path="/x/.env.example")))


class TamperGuard(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = Repo(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_denies_turning_hooks_off(self):
        for text in ['{"disableAllHooks": true}',
                     '{"enabledPlugins": {"org-guardrails@policy-bank": false}}',
                     '{"permissions": {"defaultMode": "bypassPermissions"}}']:
            with self.subTest(text=text):
                out = self.repo.pre("Write", file_path=str(self.repo.root / ".claude/settings.json"),
                                    content=text)
                self.assertTrue(denied(out))
        self.assertFalse(denied(self.repo.pre(
            "Write", file_path=str(self.repo.root / ".claude/settings.json"),
            content='{"permissions": {"allow": ["Bash(npm test *)"]}}')))

    def test_protected_path_reminder_once_per_session(self):
        p = str(self.repo.root / ".claude/settings.json")
        first = self.repo.hook("post-tool-use", tool_name="Edit", tool_input={"file_path": p})
        self.assertIn("ORG-0005", first["hookSpecificOutput"]["additionalContext"])
        self.assertEqual(self.repo.hook("post-tool-use", tool_name="Edit",
                                        tool_input={"file_path": p}), {})
        self.assertEqual(self.repo.hook("post-tool-use", tool_name="Edit",
                                        tool_input={"file_path": str(self.repo.root / "src/a.py")}), {})


class SpecGate(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = Repo(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_blocks_code_until_spec_accepted_and_merged(self):
        r = self.repo
        self.assertIn("no docs/changes", r.edit("src/app.py")["permissionDecisionReason"])
        r.write("docs/changes/2026-14-guest-checkout/spec.md", spec("draft"))
        r.commit("spec")
        r.merge_to_main()
        self.assertIn("'draft'", r.edit("src/app.py")["permissionDecisionReason"])
        r.write("docs/changes/2026-14-guest-checkout/spec.md", spec("accepted"))
        self.assertTrue(denied(r.edit("src/app.py")), "accepted only on the branch isn't enough")
        r.commit("accept")
        r.merge_to_main()
        self.assertFalse(denied(r.edit("src/app.py")))

    def test_ungated_paths_and_missing_change_id(self):
        r = self.repo
        self.assertFalse(denied(r.edit("docs/changes/2026-14-guest-checkout/spec.md")))
        self.assertFalse(denied(r.edit("README.md")))
        r.git("checkout", "-q", "-b", "hotfix")
        self.assertIn("names no change", r.edit("src/app.py")["permissionDecisionReason"])

    def test_session_start_reports_stage(self):
        ctx = self.repo.hook("session-start")["hookSpecificOutput"]["additionalContext"]
        self.assertIn("Active change: 2026-14-guest-checkout", ctx)
        self.assertIn("Stage: intent accepted", ctx)
        self.assertIn("spec-from-intent", ctx)
        self.assertIn("Stop gate on (ADR-0014)", ctx)


class StopGate(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = Repo(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_quiet_without_code_changes(self):
        self.assertEqual(self.repo.hook("stop"), {})

    def test_blocks_red_then_gives_up_then_passes_green(self):
        r = self.repo
        r.write("src/red", "")
        self.assertEqual(r.hook("stop")["decision"], "block")
        self.assertEqual(r.hook("stop", stop_hook_active=True)["decision"], "block")
        self.assertIn("Not blocking again", r.hook("stop", stop_hook_active=True)["systemMessage"])
        (r.root / "src/red").unlink()
        r.write("src/new.py", "")
        self.assertEqual(r.hook("stop"), {})


class ControlsParser(unittest.TestCase):
    def test_parser_without_yaml(self):
        sys.path.insert(0, str(GUARD.parent))
        import guard  # noqa: E402
        real = sys.modules.get("yaml")
        sys.modules["yaml"] = None  # force ImportError
        try:
            ctl = {c["id"]: c for c in guard.parse_controls(CONTROLS)}
        finally:
            if real is None:
                sys.modules.pop("yaml", None)
            else:
                sys.modules["yaml"] = real
        self.assertEqual(ctl["spec-gate"]["paths"], ["src/**"])
        self.assertEqual(ctl["spec-gate"]["adr"], "ADR-0012")
        self.assertEqual(ctl["stop-gate"]["command"], "test ! -e src/red")
        self.assertEqual(ctl["stop-gate"]["max_blocks"], 2)


if __name__ == "__main__":
    unittest.main()
