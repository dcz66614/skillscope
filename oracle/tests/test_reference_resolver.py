"""Tests for the Python Reference Oracle resolver (P023 T004).

These tests pin the Oracle's rule semantics independently of the TypeScript
production adapters: frontmatter parsing (both variants), TOML config
parsing, selector semantics, scope handling, fail-closed behaviour, the
canonicalisation rules, and the full 48-fixture run summary. The gate
(scripts/s0-gate.mjs) separately proves production == Oracle field-by-field.
"""

import json
import os
import shutil
import sys
import tempfile
import unittest
import unittest.mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "python"))

import reference_resolver as oracle  # noqa: E402

REPO_ROOT = os.path.join(os.path.dirname(__file__), "..", "..")
FIXTURES_ROOT = os.path.join(REPO_ROOT, "tests", "fixtures", "s0")
MANIFEST = os.path.join(FIXTURES_ROOT, "manifest.json")

SKILL = "---\nname: {name}\ndescription: {desc}\n---\n\n# {name}\n\nBody.\n"


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(text)


class TestCodexFrontmatter(unittest.TestCase):
    def test_name_extracted(self):
        self.assertEqual(
            oracle.read_manifest_name_codex(SKILL.format(name="deploy", desc="D.")),
            "deploy",
        )

    def test_quoted_name_unquoted(self):
        text = '---\nname: "deploy"\ndescription: D.\n---\n\nBody.\n'
        self.assertEqual(oracle.read_manifest_name_codex(text), "deploy")

    def test_no_frontmatter_returns_none(self):
        self.assertIsNone(oracle.read_manifest_name_codex("# plain\n\nNo fence.\n"))

    def test_no_name_returns_none(self):
        text = "---\ndescription: Only a description.\n---\n\nBody.\n"
        self.assertIsNone(oracle.read_manifest_name_codex(text))


class TestSharedFrontmatter(unittest.TestCase):
    def test_valid(self):
        result = oracle.parse_frontmatter(SKILL.format(name="deploy", desc="D."))
        self.assertTrue(result["valid"])
        self.assertEqual(result["name"], "deploy")
        self.assertEqual(result["errors"], [])

    def test_missing_name(self):
        result = oracle.parse_frontmatter("---\ndescription: D.\n---\n\nBody.\n")
        self.assertFalse(result["valid"])
        self.assertIn("missing-name", result["errors"])

    def test_missing_description(self):
        result = oracle.parse_frontmatter("---\nname: deploy\n---\n\nBody.\n")
        self.assertFalse(result["valid"])
        self.assertIn("missing-description", result["errors"])

    def test_invalid_name_pattern(self):
        result = oracle.parse_frontmatter(SKILL.format(name="Deploy!", desc="D."))
        self.assertFalse(result["valid"])
        self.assertIn("invalid-name", result["errors"])

    def test_unterminated_fence(self):
        result = oracle.parse_frontmatter("---\nname: deploy\ndescription: D.\n")
        self.assertFalse(result["valid"])
        self.assertIn("unterminated-frontmatter-fence", result["errors"])

    def test_malformed_line(self):
        text = "---\nname: deploy\ndescription: D.\nno colon here\n---\n\nBody.\n"
        result = oracle.parse_frontmatter(text)
        self.assertFalse(result["valid"])
        self.assertIn("malformed-frontmatter-line", result["errors"])


class TestCodexConfig(unittest.TestCase):
    def test_entries_and_bundled(self):
        config = oracle._parse_codex_config(
            '[[skills.config]]\nname = "deploy"\nenabled = false\n\n'
            "[skills.bundled]\nenabled = false\n"
        )
        self.assertEqual(config["entries"], [{"name": "deploy", "enabled": False}])
        self.assertFalse(config["bundledEnabled"])

    def test_missing_enabled_defaults_true(self):
        config = oracle._parse_codex_config('[[skills.config]]\nname = "x"\n')
        self.assertEqual(config["entries"], [{"name": "x", "enabled": True}])

    def test_invalid_toml_raises(self):
        with self.assertRaises(Exception):
            oracle._parse_codex_config("this is not [valid toml [[[")

    def test_entry_with_both_path_and_name_raises(self):
        with self.assertRaises(ValueError):
            oracle._parse_codex_config(
                '[[skills.config]]\npath = "/a"\nname = "x"\nenabled = true\n'
            )

    def test_entry_with_neither_raises(self):
        with self.assertRaises(ValueError):
            oracle._parse_codex_config("[[skills.config]]\nenabled = true\n")

    def test_non_boolean_enabled_raises(self):
        with self.assertRaises(ValueError):
            oracle._parse_codex_config('[[skills.config]]\nname = "x"\nenabled = "yes"\n')


def make_codex_layout(tmp, skills, config=None):
    """skills: list of (rel_dir_under_layout, name). Returns the raw input."""
    for rel_dir, name in skills:
        write(os.path.join(tmp, "layout", rel_dir, "SKILL.md"),
              SKILL.format(name=name, desc=f"{name} skill."))
    for d in ("repo/.agents/skills", "home/.agents/skills", "etc-codex/skills"):
        os.makedirs(os.path.join(tmp, "layout", d), exist_ok=True)
    write(os.path.join(tmp, "layout", "bundled.json"), '{"skills": []}\n')
    write(os.path.join(tmp, "layout", "plugins.json"), '{"plugins": []}\n')
    if config is not None:
        write(os.path.join(tmp, "layout", "config.toml"), config)
    return {
        "case_id": "unit",
        "cwd": "layout/repo",
        "repo_root": "layout/repo",
        "home_root": "layout/home",
        "admin_root": "layout/etc-codex",
        "config_file": "layout/config.toml" if config is not None else None,
        "bundled_file": "layout/bundled.json",
        "plugins_file": "layout/plugins.json",
    }


class TestCodexResolver(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="skillscope-oracle-")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_name_selector_blast(self):
        raw = make_codex_layout(self.tmp, [
            ("repo/.agents/skills/deploy", "deploy"),
            ("home/.agents/skills/deploy", "deploy"),
        ], config='[[skills.config]]\nname = "deploy"\nenabled = false\n')
        result = oracle.resolve_codex_native(self.tmp, raw)
        self.assertEqual(result["status"], "FAIL")
        self.assertEqual(len(result["skills"]), 2)
        self.assertTrue(all(s["status"] == "DISABLED" for s in result["skills"]))
        blast = [f for f in result["findings"] if f["id"] == "NAME_SELECTOR_BLAST_RADIUS"]
        self.assertEqual(len(blast), 1)
        self.assertEqual(blast[0]["affectedCount"], 2)

    def test_last_match_wins(self):
        raw = make_codex_layout(self.tmp, [
            ("repo/.agents/skills/deploy", "deploy"),
        ], config=(
            '[[skills.config]]\nname = "deploy"\nenabled = false\n\n'
            '[[skills.config]]\nname = "deploy"\nenabled = true\n'))
        result = oracle.resolve_codex_native(self.tmp, raw)
        self.assertEqual(result["status"], "PASS")
        self.assertEqual(result["skills"][0]["status"], "ELIGIBLE")
        self.assertEqual(result["findings"], [])

    def test_unreadable_config_fail_closed(self):
        raw = make_codex_layout(self.tmp, [
            ("repo/.agents/skills/release", "release"),
        ], config="not [valid toml [[[\n")
        result = oracle.resolve_codex_native(self.tmp, raw)
        self.assertEqual(result["status"], "INCOMPLETE")
        self.assertFalse(result["configReadable"])
        self.assertEqual(result["skills"][0]["status"], "UNKNOWN")
        self.assertIn("FAIL_OPEN_CONFIG", [f["id"] for f in result["findings"]])

    def test_missing_user_source_is_unknown(self):
        raw = make_codex_layout(self.tmp, [
            ("repo/.agents/skills/release", "release"),
        ])
        raw["home_root"] = "layout/no-such-home"
        result = oracle.resolve_codex_native(self.tmp, raw)
        self.assertEqual(result["status"], "INCOMPLETE")
        self.assertIn("USER", result["unknownSources"])
        self.assertEqual(result["coverage"], {"enumeratedSources": 4, "requiredSources": 5})


class TestClaudeResolver(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="skillscope-oracle-")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _profile(self, roots, **kw):
        profile = {"profileId": "unit", "cwd": ".", "sourceRoots": roots}
        profile.update(kw)
        return profile

    def _root(self, root_id, scope, path, **kw):
        r = {"sourceRootId": root_id, "scope": scope, "path": path, "required": True}
        r.update(kw)
        return r

    def test_bare_override_never_touches_namespaced_instance(self):
        write(os.path.join(self.tmp, "project/deploy/SKILL.md"),
              SKILL.format(name="deploy", desc="D."))
        write(os.path.join(self.tmp, "plugin-acme/deploy/SKILL.md"),
              SKILL.format(name="deploy", desc="D."))
        profile = self._profile([
            self._root("project", "PROJECT", os.path.join(self.tmp, "project")),
            self._root("plugin-acme", "PLUGIN", os.path.join(self.tmp, "plugin-acme"),
                       pluginName="acme"),
        ], skillOverrides={"deploy": "off"})
        result = oracle.resolve_claude_native(profile)
        by_name = {i["logicalName"]: i["status"] for i in result["instances"]}
        self.assertEqual(by_name["deploy"], "DISABLED")
        self.assertEqual(by_name["acme:deploy"], "ELIGIBLE")
        self.assertEqual(result["status"], "PASS")

    def test_account_sync_without_snapshot_is_incomplete(self):
        write(os.path.join(self.tmp, "project/release/SKILL.md"),
              SKILL.format(name="release", desc="R."))
        profile = self._profile([
            self._root("project", "PROJECT", os.path.join(self.tmp, "project")),
            self._root("sync", "ACCOUNT_SYNC", ""),
        ])
        result = oracle.resolve_claude_native(profile)
        self.assertEqual(result["status"], "INCOMPLETE")
        self.assertIn("ACCOUNT_SYNC", result["coverage"]["unknownScopes"])

    def test_forbidden_scope_leaks(self):
        write(os.path.join(self.tmp, "nested/deploy/SKILL.md"),
              SKILL.format(name="deploy", desc="D."))
        profile = self._profile([
            self._root("nested", "NESTED", os.path.join(self.tmp, "nested"), visited=True),
        ], policy={"forbiddenScopes": ["NESTED"]})
        result = oracle.resolve_claude_native(profile)
        self.assertEqual(result["status"], "FAIL")
        self.assertEqual([f["id"] for f in result["findings"]], ["SCOPE_LEAK"])


class TestOmbResolver(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="skillscope-oracle-")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _profile(self, skills, config=None, version="openmausbot-snapshot/v1", **kw):
        if config is not None:
            write(os.path.join(self.tmp, "data", "config.json"),
                  json.dumps(config) + "\n")
        profile = {
            "profileId": "unit",
            "botId": "bot-1",
            "dataDir": os.path.join(self.tmp, "data"),
            "snapshot": {"version": version, "skills": skills, "loadableRoots": []},
        }
        profile.update(kw)
        return profile

    def test_missing_config_uses_defaults(self):
        write(os.path.join(self.tmp, "assigned/release/SKILL.md"),
              SKILL.format(name="release", desc="R."))
        profile = self._profile([
            {"kind": "assigned", "name": "release", "path": os.path.join(self.tmp, "assigned/release")},
        ])
        result = oracle.resolve_omb_native(profile)
        self.assertEqual(result["status"], "PASS")
        self.assertEqual(result["flags"]["configSource"], "defaults")
        self.assertFalse(result["flags"]["skillsLibrary"])

    def test_unknown_snapshot_version_is_incomplete(self):
        profile = self._profile([], version="openmausbot-snapshot/v99")
        result = oracle.resolve_omb_native(profile)
        self.assertEqual(result["status"], "INCOMPLETE")
        self.assertEqual(result["instances"], [])
        self.assertIn("SNAPSHOT", result["coverage"]["unknownScopes"])

    def test_corrupt_optout_is_incomplete(self):
        write(os.path.join(self.tmp, "library/every-docs/SKILL.md"),
              SKILL.format(name="every-docs", desc="E."))
        write(os.path.join(self.tmp, "data", "skill-state", "bot-1", "library-opt-out.json"),
              "{invalid json\n")
        profile = self._profile([
            {"kind": "library", "name": "every-docs",
             "path": os.path.join(self.tmp, "library/every-docs")},
        ], config={"features": {"claudeUserSkills": False, "skillsLibrary": True}})
        result = oracle.resolve_omb_native(profile)
        self.assertEqual(result["status"], "INCOMPLETE")
        self.assertIn("FAIL_OPEN_CONFIG", [f["id"] for f in result["findings"]])
        self.assertIn("SHARED_LIBRARY", result["coverage"]["unknownScopes"])


class TestFixR1Oracle(unittest.TestCase):
    """FIX-R1 Oracle mirrors: features parsing, fail-closed reads
    (mocked PermissionError — the suite runs as root, which cannot
    produce a real EACCES), synced/ recognition, and the ELIGIBLE-only
    effective set (ADR-023). The real end-to-end EACCES behaviour is
    proven by the TypeScript regression suite, which runs the built
    product as the unprivileged user `nobody`."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="skillscope-oracle-r1-")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _omb_profile(self, skills, config=None,
                     version="openmausbot-snapshot/v1", **kw):
        if config is not None:
            write(os.path.join(self.tmp, "data", "config.json"),
                  json.dumps(config) + "\n")
        profile = {
            "profileId": "unit",
            "botId": "bot-1",
            "dataDir": os.path.join(self.tmp, "data"),
            "snapshot": {"version": version, "skills": skills,
                         "loadableRoots": []},
        }
        profile.update(kw)
        return profile

    def _library_skill(self):
        write(os.path.join(self.tmp, "library/every-docs/SKILL.md"),
              SKILL.format(name="every-docs", desc="E."))
        return {"kind": "library", "name": "every-docs",
                "path": os.path.join(self.tmp, "library/every-docs")}

    @staticmethod
    def _deny_stat(suffix):
        """Patch os.stat so only paths ending with `suffix` raise
        PermissionError; everything else stats normally."""
        real_stat = os.stat

        def fake_stat(p, *args, **kwargs):
            if str(p).endswith(suffix):
                raise PermissionError(13, "Permission denied", p)
            return real_stat(p, *args, **kwargs)

        return unittest.mock.patch("os.stat", side_effect=fake_stat)

    # -- P0-R1-04 features -------------------------------------------
    def test_omb_nested_features_honoured(self):
        profile = self._omb_profile(
            [self._library_skill()],
            config={"features": {"claudeUserSkills": True,
                                 "skillsLibrary": True}})
        result = oracle.resolve_omb_native(profile)
        self.assertEqual(result["flags"], {
            "claudeUserSkills": True, "skillsLibrary": True,
            "configSource": "file"})
        self.assertEqual(result["instances"][0]["status"], "ELIGIBLE")

    def test_omb_top_level_flags_ignored(self):
        profile = self._omb_profile(
            [self._library_skill()],
            config={"claudeUserSkills": True, "skillsLibrary": True})
        result = oracle.resolve_omb_native(profile)
        self.assertEqual(result["flags"], {
            "claudeUserSkills": False, "skillsLibrary": False,
            "configSource": "file"})
        self.assertEqual(result["instances"][0]["status"], "DISCOVERED")

    def test_omb_non_boolean_features_is_incomplete(self):
        profile = self._omb_profile(
            [self._library_skill()],
            config={"features": {"skillsLibrary": "yes",
                                 "claudeUserSkills": False}})
        result = oracle.resolve_omb_native(profile)
        self.assertEqual(result["status"], "INCOMPLETE")
        self.assertIn("CONFIG", result["coverage"]["unknownScopes"])
        self.assertIn("FAIL_OPEN_CONFIG",
                      [f["id"] for f in result["findings"]])
        self.assertTrue(any(
            "non-boolean features.claudeUserSkills/skillsLibrary flags"
            in f["detail"] for f in result["findings"]))

    def test_omb_non_object_features_is_incomplete(self):
        profile = self._omb_profile(
            [self._library_skill()], config={"features": "yes"})
        result = oracle.resolve_omb_native(profile)
        self.assertEqual(result["status"], "INCOMPLETE")
        self.assertIn("CONFIG", result["coverage"]["unknownScopes"])
        self.assertTrue(any('non-object "features" value' in f["detail"]
                            for f in result["findings"]))

    # -- P1-R1-02 mocked EACCES ---------------------------------------
    def test_omb_unreadable_config_is_incomplete(self):
        profile = self._omb_profile(
            [self._library_skill()],
            config={"features": {"skillsLibrary": True,
                                 "claudeUserSkills": False}})
        with self._deny_stat("config.json"):
            result = oracle.resolve_omb_native(profile)
        self.assertEqual(result["status"], "INCOMPLETE")
        self.assertIn("CONFIG", result["coverage"]["unknownScopes"])
        self.assertEqual(result["flags"]["configSource"], "invalid")
        self.assertTrue(any("exists but cannot be read" in f["detail"]
                            for f in result["findings"]
                            if f["id"] == "FAIL_OPEN_CONFIG"))

    def test_omb_unreadable_optout_is_incomplete_but_skill_stays_eligible(self):
        write(os.path.join(self.tmp, "data", "skill-state", "bot-1",
                           "library-opt-out.json"),
              '["every-docs"]\n')
        profile = self._omb_profile(
            [self._library_skill()],
            config={"features": {"skillsLibrary": True,
                                 "claudeUserSkills": False}})
        with self._deny_stat("library-opt-out.json"):
            result = oracle.resolve_omb_native(profile)
        self.assertEqual(result["status"], "INCOMPLETE")
        self.assertIn("SHARED_LIBRARY",
                      result["coverage"]["unknownScopes"])
        self.assertEqual(result["instances"][0]["status"], "ELIGIBLE")

    # -- P0-R1-02 / P0-R1-01 mocked EACCES ----------------------------
    def test_claude_unreadable_skill_md_is_incomplete(self):
        write(os.path.join(self.tmp, "project/release/SKILL.md"),
              SKILL.format(name="release", desc="R."))
        profile = {
            "profileId": "unit",
            "cwd": ".",
            "sourceRoots": [{
                "sourceRootId": "project", "scope": "PROJECT",
                "path": os.path.join(self.tmp, "project"),
                "required": True,
            }],
        }
        real_read = oracle.read_text

        def fake_read(p, *args, **kwargs):
            if str(p).endswith("release/SKILL.md"):
                raise PermissionError(13, "Permission denied", p)
            return real_read(p, *args, **kwargs)

        with unittest.mock.patch.object(oracle, "read_text",
                                        side_effect=fake_read):
            result = oracle.resolve_claude_native(profile)
        self.assertEqual(result["status"], "INCOMPLETE")
        self.assertIn("PROJECT", result["coverage"]["unknownScopes"])
        self.assertTrue(any("could not be fully enumerated" in f["detail"]
                            for f in result["findings"]))
        self.assertEqual(result["instances"], [])

    def test_codex_unreadable_skills_dir_is_incomplete(self):
        raw = make_codex_layout(self.tmp, [
            ("repo/.agents/skills/release", "release"),
        ])
        real_scandir = os.scandir

        def fake_scandir(p, *args, **kwargs):
            if str(p).endswith("repo/.agents/skills"):
                raise PermissionError(13, "Permission denied", p)
            return real_scandir(p, *args, **kwargs)

        with unittest.mock.patch("os.scandir", side_effect=fake_scandir):
            result = oracle.resolve_codex_native(self.tmp, raw)
        self.assertEqual(result["status"], "INCOMPLETE")
        self.assertIn("REPO", result["unknownSources"])
        self.assertEqual(result["skills"], [])

    # -- P0-R1-03 synced/ ----------------------------------------------
    def test_claude_synced_undeclared_is_incomplete(self):
        write(os.path.join(
            self.tmp, "home/.claude/skills/synced/anthropic-skill/SKILL.md"),
            SKILL.format(name="anthropic-skill", desc="A."))
        write(os.path.join(
            self.tmp, "repo/.claude/skills/project-skill/SKILL.md"),
            SKILL.format(name="project-skill", desc="P."))
        profile = {
            "profileId": "unit",
            "cwd": ".",
            "sourceRoots": [{
                "sourceRootId": "project", "scope": "PROJECT",
                "path": os.path.join(self.tmp, "repo/.claude/skills"),
                "required": True,
            }],
            "accountSyncDir": os.path.join(
                self.tmp, "home/.claude/skills/synced"),
            "policy": {"allowedScopes": ["PERSONAL", "PROJECT",
                                         "ACCOUNT_SYNC"]},
        }
        result = oracle.resolve_claude_native(profile)
        self.assertEqual(result["status"], "INCOMPLETE")
        self.assertIn("ACCOUNT_SYNC",
                      result["coverage"]["unknownScopes"])
        self.assertEqual(result["coverage"]["requiredSources"], 2)

    def test_claude_synced_absent_is_pass(self):
        write(os.path.join(
            self.tmp, "repo/.claude/skills/project-skill/SKILL.md"),
            SKILL.format(name="project-skill", desc="P."))
        profile = {
            "profileId": "unit",
            "cwd": ".",
            "sourceRoots": [{
                "sourceRootId": "project", "scope": "PROJECT",
                "path": os.path.join(self.tmp, "repo/.claude/skills"),
                "required": True,
            }],
            "accountSyncDir": os.path.join(
                self.tmp, "home/.claude/skills/synced"),
            "policy": {"allowedScopes": ["PERSONAL", "PROJECT",
                                         "ACCOUNT_SYNC"]},
        }
        result = oracle.resolve_claude_native(profile)
        self.assertEqual(result["status"], "PASS")
        self.assertEqual(result["coverage"]["unknownScopes"], [])

    # -- ADR-023 alignment ----------------------------------------------
    def test_discovered_instance_in_forbidden_scope_does_not_leak(self):
        profile = self._omb_profile(
            [self._library_skill()],
            config={"claudeUserSkills": True, "skillsLibrary": True},
            policy={"forbiddenScopes": ["SHARED_LIBRARY"]})
        result = oracle.resolve_omb_native(profile)
        self.assertEqual(result["instances"][0]["status"], "DISCOVERED")
        self.assertNotIn("SCOPE_LEAK",
                         [f["id"] for f in result["findings"]])
        self.assertEqual(result["status"], "PASS")


class TestFixT013ROracle(unittest.TestCase):
    """FIX-T013R Oracle mirrors: the Codex symlink escape guard tests
    the resolved path (P1-T013R-01), and the Claude accountSyncDir
    check treats an unreadable skill subdirectory as unknown
    (P2-T013R-02). The TS side is pinned by tests/regression/
    r2-fix.test.ts (in-process for the escape, `nobody` for the
    synced subdir); these tests pin the Oracle half of the parity."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="skillscope-oracle-r2-")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _escape_finding(self, result):
        found = [f for f in result["findings"]
                 if f["id"] == "SYMLINK_OUTSIDE_ROOT"]
        self.assertEqual(len(found), 1)
        return found[0]

    # -- P1-T013R-01 escape ---------------------------------------------
    def test_codex_symlink_escape_is_incomplete(self):
        raw = make_codex_layout(self.tmp, [
            ("repo/.agents/skills/real", "real"),
        ])
        write(os.path.join(self.tmp, "layout/outside/real-skill/SKILL.md"),
              SKILL.format(name="secret", desc="S."))
        os.symlink("../../../outside/real-skill",
                   os.path.join(self.tmp, "layout/repo/.agents/skills/evil"))
        result = oracle.resolve_codex_native(self.tmp, raw)
        self.assertEqual(result["status"], "INCOMPLETE")
        self.assertEqual(result["unknownSources"], [])
        self.assertEqual([s["logicalName"] for s in result["skills"]],
                         ["real"])
        finding = self._escape_finding(result)
        self.assertEqual(finding["severity"], "P1")
        self.assertEqual(finding["sourceScope"], "REPO")
        self.assertEqual(finding["status"], "UNKNOWN")
        self.assertIn("repo/.agents/skills/evil/SKILL.md",
                      finding["detail"])
        self.assertIn("resolves outside its source root (REPO)",
                      finding["detail"])
        self.assertEqual(result["coverage"],
                         {"enumeratedSources": 5, "requiredSources": 5})

    def test_codex_symlink_launder_is_incomplete_and_user_scoped(self):
        raw = make_codex_layout(self.tmp, [
            ("home/.agents/skills/evil-skill", "evil-skill"),
        ])
        os.symlink("../../../home/.agents/skills/evil-skill",
                   os.path.join(self.tmp, "layout/repo/.agents/skills/link"))
        result = oracle.resolve_codex_native(self.tmp, raw)
        self.assertEqual(result["status"], "INCOMPLETE")
        self.assertEqual(len(result["skills"]), 1)
        self.assertEqual(result["skills"][0]["sourceScope"], "USER")
        self.assertEqual(result["skills"][0]["logicalName"], "evil-skill")
        self.assertEqual(result["skills"][0]["status"], "ELIGIBLE")
        self.assertEqual(result["skills"][0]["aliases"], [])
        self._escape_finding(result)

    def test_codex_symlink_launder_control_is_pass(self):
        raw = make_codex_layout(self.tmp, [
            ("home/.agents/skills/evil-skill", "evil-skill"),
        ])
        result = oracle.resolve_codex_native(self.tmp, raw)
        self.assertEqual(result["status"], "PASS")
        self.assertEqual(result["findings"], [])
        self.assertEqual(len(result["skills"]), 1)
        self.assertEqual(result["skills"][0]["sourceScope"], "USER")

    def test_codex_symlink_alias_in_root_merges(self):
        raw = make_codex_layout(self.tmp, [
            ("repo/.agents/skills/real", "real"),
        ])
        os.symlink("real",
                   os.path.join(self.tmp, "layout/repo/.agents/skills/alias"))
        result = oracle.resolve_codex_native(self.tmp, raw)
        self.assertEqual(result["status"], "PASS")
        self.assertEqual(result["findings"], [])
        self.assertEqual(len(result["skills"]), 1)
        self.assertEqual(result["skills"][0]["logicalName"], "real")
        self.assertEqual(result["skills"][0]["aliases"],
                         [".agents/skills/real/SKILL.md"])

    # -- P2-T013R-02 synced subdir ---------------------------------------
    def test_claude_synced_unreadable_skill_subdir_is_incomplete(self):
        write(os.path.join(
            self.tmp, "home/.claude/skills/synced/anthropic-skill/SKILL.md"),
            SKILL.format(name="anthropic-skill", desc="A."))
        write(os.path.join(
            self.tmp, "repo/.claude/skills/project-skill/SKILL.md"),
            SKILL.format(name="project-skill", desc="P."))
        profile = {
            "profileId": "unit",
            "cwd": ".",
            "sourceRoots": [{
                "sourceRootId": "project", "scope": "PROJECT",
                "path": os.path.join(self.tmp, "repo/.claude/skills"),
                "required": True,
            }],
            "accountSyncDir": os.path.join(
                self.tmp, "home/.claude/skills/synced"),
            "policy": {"allowedScopes": ["PERSONAL", "PROJECT",
                                         "ACCOUNT_SYNC"]},
        }
        # Only the synced skill's SKILL.md denies: the synced/
        # directory itself stays readable, so the TS hasUnverifiable
        # branch (not the rootSkip branch) must fire.
        real_stat = os.stat

        def fake_stat(p, *args, **kwargs):
            if str(p).endswith("anthropic-skill/SKILL.md"):
                raise PermissionError(13, "Permission denied", p)
            return real_stat(p, *args, **kwargs)

        with unittest.mock.patch("os.stat", side_effect=fake_stat):
            result = oracle.resolve_claude_native(profile)
        self.assertEqual(result["status"], "INCOMPLETE")
        self.assertIn("ACCOUNT_SYNC",
                      result["coverage"]["unknownScopes"])
        self.assertTrue(any(
            "account-synced skills exist on disk under" in f["detail"]
            for f in result["findings"]
            if f["id"] == "SOURCE_NOT_ENUMERATED"))
        self.assertEqual(
            [i["logicalName"] for i in result["instances"]],
            ["project-skill"])


class TestFixR2Oracle(unittest.TestCase):
    """FIX-R2 Oracle mirrors: the same physical SKILL.md reachable from
    two Codex scopes is two instances (P1-R2-02). The TS side is pinned
    by tests/regression/r3-fix.test.ts; these tests pin the Oracle half
    of the parity, derived independently from the same requirement."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="skillscope-oracle-r3-")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _base_files(self):
        for d in ("layout/etc-codex/skills",):
            os.makedirs(os.path.join(self.tmp, d), exist_ok=True)
        write(os.path.join(self.tmp, "layout/bundled.json"),
              '{"skills": []}\n')
        write(os.path.join(self.tmp, "layout/plugins.json"),
              '{"plugins": []}\n')

    def _shared_layout(self):
        """One physical skills dir, used as both repo_root and home_root."""
        write(os.path.join(
            self.tmp, "layout/shared/.agents/skills/shared/SKILL.md"),
            SKILL.format(name="shared", desc="Shared skill."))
        self._base_files()
        return {
            "case_id": "unit",
            "cwd": "layout/shared",
            "repo_root": "layout/shared",
            "home_root": "layout/shared",
            "admin_root": "layout/etc-codex",
            "config_file": None,
            "bundled_file": "layout/bundled.json",
            "plugins_file": "layout/plugins.json",
        }

    def _overlapping_layout(self):
        """home_root nested inside repo_root; the USER skills dir IS the
        physical dir the REPO walk finds first."""
        write(os.path.join(
            self.tmp, "layout/repo/.agents/skills/shared/SKILL.md"),
            SKILL.format(name="shared", desc="Shared skill."))
        self._base_files()
        return {
            "case_id": "unit",
            "cwd": "layout/repo",
            "repo_root": "layout",
            "home_root": "layout/repo",
            "admin_root": "layout/etc-codex",
            "config_file": None,
            "bundled_file": "layout/bundled.json",
            "plugins_file": "layout/plugins.json",
        }

    def _two_instances(self, result):
        self.assertEqual(result["status"], "PASS")
        self.assertEqual(result["findings"], [])
        self.assertEqual(len(result["skills"]), 2)
        by_scope = {s["sourceScope"]: s for s in result["skills"]}
        self.assertEqual(sorted(by_scope), ["REPO", "USER"])
        repo, user = by_scope["REPO"], by_scope["USER"]
        self.assertEqual(repo["logicalName"], "shared")
        self.assertEqual(user["logicalName"], "shared")
        self.assertEqual(repo["contentSha256"], user["contentSha256"])
        self.assertEqual(repo["canonicalPath"], user["canonicalPath"])
        self.assertNotEqual(repo["instanceId"], user["instanceId"])
        self.assertEqual(repo["aliases"], [])
        self.assertEqual(user["aliases"], [])
        self.assertEqual(result["coverage"],
                         {"enumeratedSources": 5, "requiredSources": 5})
        return by_scope

    def test_codex_cross_scope_same_dir_is_two_instances(self):
        result = oracle.resolve_codex_native(self.tmp, self._shared_layout())
        self._two_instances(result)

    def test_codex_cross_scope_overlapping_roots_is_two_instances(self):
        result = oracle.resolve_codex_native(self.tmp,
                                             self._overlapping_layout())
        self._two_instances(result)

    def test_codex_cross_scope_disjoint_control(self):
        raw = make_codex_layout(self.tmp, [
            ("repo/.agents/skills/repo-skill", "repo-skill"),
            ("home/.agents/skills/user-skill", "user-skill"),
        ])
        result = oracle.resolve_codex_native(self.tmp, raw)
        self.assertEqual(result["status"], "PASS")
        self.assertEqual(result["findings"], [])
        self.assertEqual(len(result["skills"]), 2)
        by_scope = {s["sourceScope"]: s for s in result["skills"]}
        self.assertEqual(by_scope["REPO"]["logicalName"], "repo-skill")
        self.assertEqual(by_scope["USER"]["logicalName"], "user-skill")

    def test_codex_cross_scope_name_selector_hits_both_instances(self):
        raw = self._shared_layout()
        write(os.path.join(self.tmp, "layout/config.toml"),
              '[[skills.config]]\nname = "shared"\nenabled = false\n')
        raw["config_file"] = "layout/config.toml"
        result = oracle.resolve_codex_native(self.tmp, raw)
        self.assertEqual(len(result["skills"]), 2)
        self.assertTrue(all(s["status"] == "DISABLED"
                            for s in result["skills"]))
        blast = [f for f in result["findings"]
                 if f["id"] == "NAME_SELECTOR_BLAST_RADIUS"]
        self.assertEqual(len(blast), 1)
        self.assertEqual(blast[0]["affectedCount"], 2)
        self.assertEqual(result["status"], "FAIL")


class TestCanonicalisation(unittest.TestCase):
    def test_detail_scrubbing(self):
        finding = {
            "id": "SOURCE_NOT_ENUMERATED", "severity": "P1", "sourceScope": "ADD_DIR",
            "detail": "required source root adddir (/abs/fixture/adddir) is missing",
            "instanceIds": [],
        }
        out = oracle._canonical_finding(finding, "/abs/fixture", {}, False)
        self.assertEqual(out["detail"],
                         "required source root adddir (<FIXTURE_DIR>/adddir) is missing")
        self.assertEqual(out["status"], "UNKNOWN")

    def test_p1_finding_status_is_confirmed(self):
        finding = {
            "id": "SCOPE_LEAK", "severity": "P1", "sourceScope": "NESTED",
            "detail": "leak", "instanceIds": [],
        }
        out = oracle._canonical_finding(finding, "/abs/fixture", {}, False)
        self.assertEqual(out["status"], "CONFIRMED")

    def test_codex_blast_keeps_affected_count(self):
        finding = {
            "id": "NAME_SELECTOR_BLAST_RADIUS", "severity": "P1",
            "sourceScope": "GLOBAL", "status": "CONFIRMED",
            "detail": 'name selector "deploy" affects 2 distinct instances',
            "affectedCount": 2,
        }
        out = oracle._canonical_finding(finding, "/abs/fixture", None, True)
        self.assertEqual(out["affectedCount"], 2)
        self.assertEqual(out["instanceIds"], [])
        self.assertEqual(out["status"], "CONFIRMED")


class TestFullRun(unittest.TestCase):
    def test_48_fixtures_summary(self):
        results = oracle.resolve_all(MANIFEST, FIXTURES_ROOT)
        self.assertEqual(len(results), 48)
        controls = [r for r in results if r["kind"] == "control"]
        planted = [r for r in results if r["kind"] == "planted"]
        self.assertEqual(len(controls), 24)
        self.assertEqual(len(planted), 24)
        for r in controls:
            self.assertEqual(r["status"], "PASS", r["fixture_id"])
            self.assertFalse(any(f["severity"] == "P1" for f in r["findings"]),
                             r["fixture_id"])
        for r in planted:
            marker = (
                len(r["findings"]) > 0
                or len(r["coverage"]["unknownScopes"]) > 0
                or any(i["status"] != "ELIGIBLE" for i in r["instances"])
            )
            self.assertTrue(marker, r["fixture_id"])
        incomplete_sources = sum(
            len(r["coverage"]["unknownScopes"]) for r in results)
        self.assertEqual(incomplete_sources, 11)

    def test_no_absolute_paths_in_canonical_output(self):
        results = oracle.resolve_all(MANIFEST, FIXTURES_ROOT)
        blob = json.dumps(results)
        self.assertNotIn(FIXTURES_ROOT, blob)
        self.assertNotIn("/home/hatch", blob)
        self.assertNotIn(os.path.expanduser("~"), blob)


if __name__ == "__main__":
    unittest.main()
