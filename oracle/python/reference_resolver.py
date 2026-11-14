"""Independent Python Reference Oracle resolver (P023 T004, S0).

Implements the host rules from PROJECT_BOOK.md §4 (Codex §4.3, Claude Code
§4.4, OpenMausBot §4.5) and the finding taxonomy §5.2, independently of the
TypeScript production adapters. It reads the same read-only JSON fixtures
(the manifest + input.json / profile.json under tests/fixtures/s0) and
returns the canonical S0 gate result for every fixture.

Independence (IMPLEMENTATION_PLAN §4.4, §7.2): this module imports no
TypeScript build output, no production rule tables, and no resolver output.
The only shared artefacts are the fixture files themselves and the
canonical-output definition, which is also implemented independently on the
TypeScript side (scripts/s0-canonical.mjs); the gate compares the two
field-by-field with no ignored fields.

Canonical result (one per fixture):
  {
    "fixture_id": "codex/c01-repo-discovery",
    "engine": "codex",
    "kind": "control" | "planted",
    "defect": null | "<category>",
    "status": "PASS" | "FAIL" | "INCOMPLETE",
    "instances": [ {sourceRootId, sourceScope, relativePath, canonicalPath,
                    logicalName, folderName, manifestName?, contentSha256,
                    status, evidenceLevel, aliases} ... ],
    "findings": [ {id, severity, sourceScope, status, detail,
                   affectedCount?, instanceIds} ... ],
    "coverage": {enumeratedSources, requiredSources, unknownScopes},
    "extra": { ... engine-specific ... }
  }

Canonicalisation rules (shared with the TypeScript gate, documented so a
reviewer can check either side without reading the other):
  - canonicalPath is relative to the fixture directory (POSIX separators),
    derived from the symlink-resolved real path; for virtual / snapshot-only
    skills it is the synthetic descriptor the adapter itself uses
    (codex "bundled/<name>/SKILL.md", "plugins/<id>/<name>/SKILL.md";
    claude account-sync "snapshot/<name>/SKILL.md").
  - Native instanceId / canonicalPathHash (which hash absolute paths in the
    Claude / OpenMausBot adapters) are NOT part of the canonical output:
    the canonical identity is (sourceRootId, canonicalPath) + contentSha256.
  - Finding detail strings have the absolute fixture directory replaced by
    the placeholder "<FIXTURE_DIR>", so results are machine-independent.
  - Finding status is the adapter's native status for Codex; for Claude /
    OpenMausBot it is "UNKNOWN" iff the finding is SOURCE_NOT_ENUMERATED,
    else "CONFIRMED" (matching the Codex convention for the same ids).
  - Finding instanceIds are canonical instance keys
    "<sourceRootId>:<relativePath>", sorted.
  - Instances sort by (sourceRootId, relativePath, logicalName); findings
    sort by (id, sourceScope, detail); unknownScopes sort alphabetically.
  - manifestName is present only when the adapter reports one;
    affectedCount only when the adapter reports one (Codex blast radius).

Stdlib only. Read-only: never writes, never contacts the network.
"""

from __future__ import annotations

import argparse
import errno
import hashlib
import json
import os
import re
import stat
import sys
import tomllib
from typing import Any

__all__ = ["resolve_all", "resolve_fixture", "main"]

SEED = "P023-SKILLSCOPE-S0-2026-11-13"
FIXTURE_DIR_PLACEHOLDER = "<FIXTURE_DIR>"
OMB_SNAPSHOT_VERSION = "openmausbot-snapshot/v1"

SKILL_NAME_PATTERN = re.compile(r"^[a-z0-9][a-z0-9-]*$")
MAX_SKILL_NAME_LENGTH = 64


# ---------------------------------------------------------------- helpers ---
def sha256_hex_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def errno_code(error: OSError) -> str:
    """Errno string for a caught OSError ("ENOENT", "EACCES", ...)."""
    if error.errno is not None:
        return errno.errorcode.get(error.errno, "UNKNOWN")
    return "UNKNOWN"


def classify_error(error: OSError) -> str:
    """Port of src/fsutil classifyError: only ENOENT / ENOTDIR mean
    "missing"; everything else (EACCES, EPERM, ...) is "unreadable"
    (fail closed)."""
    if error.errno in (errno.ENOENT, errno.ENOTDIR):
        return "missing"
    return "unreadable"


def classify_path(path: str) -> str:
    """Port of src/fsutil classifyPath: "present" / "missing" /
    "unreadable" for one stat call."""
    try:
        os.stat(path)
        return "present"
    except OSError as e:
        return classify_error(e)


def is_content_unknown_skip(reason: str, code: str | None = None) -> bool:
    """Port of src/fsutil isContentUnknownSkip: a skip means unknown
    content when it is SKILL_MD_TOO_LARGE, or SKILL_MD_UNREADABLE /
    DIR_UNREADABLE with a real errno other than ENOENT. ENOENT means
    the subdirectory simply has no SKILL.md (not a skill); a skip
    with no errno is structural (e.g. a directory literally named
    SKILL.md) and is recorded only."""
    if reason == "SKILL_MD_TOO_LARGE":
        return True
    if reason not in ("SKILL_MD_UNREADABLE", "DIR_UNREADABLE"):
        return False
    return code is not None and code != "ENOENT"


def to_posix(path: str) -> str:
    return path.replace(os.sep, "/")


def relative_posix(base: str, target: str) -> str | None:
    """Path of target relative to base, forward slashes; None if it escapes."""
    rel = os.path.relpath(target, base)
    if rel == "" or rel == ".." or rel.startswith(".." + os.sep):
        return None
    return to_posix(rel)


def read_text(path: str) -> str:
    """Read a text file the way Node readFileSync(..., 'utf8') does: invalid
    UTF-8 sequences are replaced, never an exception."""
    with open(path, "rb") as fh:
        return fh.read().decode("utf-8", errors="replace")


def read_json_file(path: str) -> dict[str, Any]:
    """Port of the OpenMausBot adapter's readJsonFile helper."""
    try:
        raw = read_text(path)
    except OSError:
        return {"ok": False, "reason": "unreadable"}
    try:
        value = json.loads(raw, parse_constant=_reject_constant)
    except (ValueError, TypeError):
        return {"ok": False, "reason": "invalid-json"}
    return {"ok": True, "value": value}


def _reject_constant(name: str):
    raise ValueError(f"non-JSON constant {name}")


def is_record(value: Any) -> bool:
    return isinstance(value, dict)


# ------------------------------------------------------------ frontmatter ---
def read_manifest_name_codex(text: str) -> str | None:
    """Minimal frontmatter name reader (port of Codex readManifestName):
    only the top-level `name:` scalar from a leading `---` block; no
    validation; quote stripping; folder-name fallback is the caller's job."""
    lines = text.split("\n")
    if not lines or lines[0] != "---":
        return None
    for i in range(1, len(lines)):
        line = lines[i]
        if line == "---":
            return None
        m = re.match(r"^name:\s*(.+?)\s*$", line)
        if m is not None:
            raw = m.group(1)
            if (raw.startswith('"') and raw.endswith('"')) or (
                raw.startswith("'") and raw.endswith("'")
            ):
                return raw[1:-1]
            return raw
    return None


def parse_frontmatter(content: str) -> dict[str, Any]:
    """PoC-grade frontmatter parser (port of shared skill-scan.ts).
    Requires `name` + `description` and a well-formed `---` fence."""
    errors: list[str] = []
    lines = content.split("\n")
    first = lines[0] if lines else None
    if first is None or first.strip() != "---":
        return {"valid": False, "errors": ["missing-frontmatter-fence"]}
    fields: dict[str, str] = {}
    closed = False
    for i in range(1, len(lines)):
        line = lines[i]
        if line.strip() == "---":
            closed = True
            break
        if line.strip() == "" or line.strip().startswith("#"):
            continue
        colon = line.find(":")
        if colon < 0:
            errors.append("malformed-frontmatter-line")
            continue
        key = line[:colon].strip()
        value = line[colon + 1:].strip()
        if (value.startswith('"') and value.endswith('"')) or (
            value.startswith("'") and value.endswith("'")
        ):
            value = value[1:-1]
        if key:
            fields[key] = value
    if not closed:
        errors.append("unterminated-frontmatter-fence")
    name = fields.get("name")
    description = fields.get("description")
    if name is None or len(name) == 0:
        errors.append("missing-name")
    elif len(name) > MAX_SKILL_NAME_LENGTH or not SKILL_NAME_PATTERN.match(name):
        errors.append("invalid-name")
    if description is None or len(description) == 0:
        errors.append("missing-description")
    result: dict[str, Any] = {"valid": len(errors) == 0, "errors": errors}
    if name is not None:
        result["name"] = name
    if description is not None:
        result["description"] = description
    return result


# ------------------------------------------------------- shared skill scan --
def _is_dir_or_symlink(entry: os.DirEntry) -> bool:
    try:
        return entry.is_dir(follow_symlinks=False) or entry.is_symlink()
    except OSError:
        return False


def scan_skill_root(root_abs: str) -> dict[str, Any]:
    """Port of shared scanSkillRoot: one level of subdirectories, merge by
    canonical (real) path, unreadable entries reported in `skipped`."""
    skills: list[dict[str, Any]] = []
    skipped: list[dict[str, str]] = []
    by_canonical: dict[str, dict[str, Any]] = {}
    try:
        entries = list(os.scandir(root_abs))
    except OSError as e:
        # FIX-R1: record the errno with the root skip, same as the
        # SKILL.md read below (callers must tell a missing root
        # from an unreadable one).
        skipped.append(
            {"path": root_abs, "reason": "ROOT_MISSING_OR_UNREADABLE", "code": errno_code(e)}
        )
        return {"skills": skills, "skipped": skipped}
    folders = sorted(e.name for e in entries if _is_dir_or_symlink(e))
    for folder_name in folders:
        skill_file = os.path.join(root_abs, folder_name, "SKILL.md")
        try:
            content = read_text(skill_file)
        except OSError as e:
            # FIX-R1: record the errno. ENOENT on the SKILL.md read
            # means the subdirectory is not a skill (e.g. Claude's
            # synced/ container dir); any other errno means the file
            # exists but cannot be read, so its content is unknown.
            skipped.append(
                {"path": skill_file, "reason": "SKILL_MD_UNREADABLE", "code": errno_code(e)}
            )
            continue
        canonical = os.path.realpath(skill_file)
        relative_path = f"{folder_name}/SKILL.md"
        frontmatter = parse_frontmatter(content)
        existing = by_canonical.get(canonical)
        if existing is not None:
            existing["aliases"].append(relative_path)
            continue
        scanned = {
            "folderName": folder_name,
            "relativePath": relative_path,
            "absolutePath": skill_file,
            "canonicalPath": canonical,
            "contentSha256": sha256_hex_text(content),
            "manifestName": frontmatter.get("name"),
            "manifestValid": frontmatter["valid"],
            "manifestErrors": frontmatter["errors"],
            "aliases": [],
        }
        by_canonical[canonical] = scanned
        skills.append(scanned)
    return {"skills": skills, "skipped": skipped}


def scan_single_skill_dir(skill_dir: str, folder_name: str) -> dict[str, Any]:
    """Port of the OpenMausBot adapter's scanSingleSkillDir: one skill
    folder (containing SKILL.md), not a root of skill folders. FIX-R1:
    returns {"scanned", "unreadable"} — a missing or unreadable
    SKILL.md is unknown content, not "no skill here" (a missing file
    and an unreadable file are indistinguishable to the caller: in
    both cases the skill cannot be enumerated)."""
    skill_file = os.path.join(skill_dir, "SKILL.md")
    try:
        content = read_text(skill_file)
    except OSError:
        return {"scanned": [], "unreadable": True}
    canonical = os.path.realpath(skill_file)
    frontmatter = parse_frontmatter(content)
    return {"scanned": [{
        "folderName": folder_name,
        "relativePath": f"{folder_name}/SKILL.md",
        "absolutePath": skill_file,
        "canonicalPath": canonical,
        "contentSha256": sha256_hex_text(content),
        "manifestName": frontmatter.get("name"),
        "manifestValid": frontmatter["valid"],
        "manifestErrors": frontmatter["errors"],
        "aliases": [],
    }], "unreadable": False}


# ------------------------------------------------------------------ codex ---
CODEX_SCOPE_ORDER = ["REPO", "USER", "ADMIN", "SYSTEM", "PLUGIN"]
CODEX_REQUIRED_SOURCES = CODEX_SCOPE_ORDER


def _parse_codex_config(text: str) -> dict[str, Any]:
    """Port of Codex parseConfigText (smol-toml semantics for the fixture
    subset: [[skills.config]] tables with exactly one of path/name, and
    [skills.bundled].enabled). Raises on any malformed input."""
    parsed = tomllib.loads(text)
    entries: list[dict[str, Any]] = []
    bundled_enabled = True
    skills = parsed.get("skills")
    if isinstance(skills, dict):
        raw_entries = skills.get("config")
        if raw_entries is not None:
            if not isinstance(raw_entries, list):
                raise ValueError("skills.config must be an array of tables")
            for raw in raw_entries:
                if not isinstance(raw, dict):
                    raise ValueError("each skills.config entry must be a table")
                has_path = isinstance(raw.get("path"), str)
                has_name = isinstance(raw.get("name"), str)
                if has_path == has_name:
                    raise ValueError(
                        "each skills.config entry needs exactly one of path / name"
                    )
                enabled = raw.get("enabled")
                if enabled is not None and not isinstance(enabled, bool):
                    raise ValueError("skills.config enabled must be a boolean")
                entry: dict[str, Any] = {
                    "enabled": True if enabled is None else enabled
                }
                if has_path:
                    entry["path"] = raw["path"]
                if has_name:
                    entry["name"] = raw["name"]
                entries.append(entry)
        raw_bundled = skills.get("bundled")
        if raw_bundled is not None:
            if not isinstance(raw_bundled, dict):
                raise ValueError("skills.bundled must be a table")
            enabled = raw_bundled.get("enabled")
            if enabled is not None and not isinstance(enabled, bool):
                raise ValueError("skills.bundled.enabled must be a boolean")
            bundled_enabled = True if enabled is None else enabled
    return {"entries": entries, "bundledEnabled": bundled_enabled}


def _codex_list_skill_dirs(skills_dir: str) -> dict[str, Any]:
    """Port of Codex listSkillDirs (FIX-R1): a listing failure is an
    unreadable root, never an empty directory. A child whose stat
    fails with ENOENT is a dangling symlink (skipped); any other stat
    failure makes the whole root unreadable."""
    try:
        entries = list(os.scandir(skills_dir))
    except OSError:
        return {"error": "unreadable"}
    dirs: list[str] = []
    for entry in entries:
        if not _is_dir_or_symlink(entry):
            continue
        child = os.path.join(skills_dir, entry.name)
        try:
            is_dir = stat.S_ISDIR(os.stat(child).st_mode)
        except OSError as e:
            if e.errno == errno.ENOENT:
                continue
            return {"error": "unreadable"}
        if is_dir:
            dirs.append(entry.name)
    dirs.sort()
    return {"dirs": dirs}


def resolve_codex_native(fixture_dir: str, raw_input: dict[str, Any]) -> dict[str, Any]:
    """Port of resolveCodexSkills (T002). Returns the native result shape."""
    layout_root = os.path.join(fixture_dir, "layout")
    cwd = os.path.join(fixture_dir, raw_input["cwd"])
    repo_root = os.path.join(fixture_dir, raw_input["repo_root"])
    home_root = os.path.join(fixture_dir, raw_input["home_root"])
    admin_root = os.path.join(fixture_dir, raw_input["admin_root"])
    config_file = raw_input.get("config_file")
    bundled_file = raw_input.get("bundled_file")
    plugins_file = raw_input.get("plugins_file")
    config_path = os.path.join(fixture_dir, config_file) if config_file else None
    bundled_path = os.path.join(fixture_dir, bundled_file) if bundled_file else None
    plugins_path = os.path.join(fixture_dir, plugins_file) if plugins_file else None

    findings: list[dict[str, Any]] = []
    unknown_sources: list[str] = []
    by_real_path: dict[str, dict[str, Any]] = {}
    # FIX-R2 (P1-R2-02): physical identity and source attribution are
    # separate. `by_real_path` is only the merge anchor for same-scope
    # access paths (several paths to one physical file within one
    # scope merge into one instance, c06). `by_real_path_and_scope`
    # tracks the instance created for each (physical file, scope)
    # pair, so a file reachable from two scopes becomes two
    # instances — never one instance whose scope is decided by
    # whichever scan ran first.
    by_real_path_and_scope: dict[tuple[str, str], dict[str, Any]] = {}
    ordered_skills: list[dict[str, Any]] = []

    def note_unknown(scope: str) -> None:
        # FIX-R1: the REPO walk can hit the same unreadable root
        # from the loop and again from the repoRoot check; dedupe.
        if scope in unknown_sources:
            return
        unknown_sources.append(scope)
        findings.append({
            "id": "SOURCE_NOT_ENUMERATED",
            "severity": "P1",
            "sourceScope": scope,
            "status": "UNKNOWN",
            "detail": f"{scope} source could not be enumerated; absence is not evidence of absence",
        })

    def add_skill_dir(source_root_id, source_scope, root_dir, skill_dir_abs, folder_name):
        """Port of Codex addSkillDir (FIX-R1): a read failure (realpath
        or file read) drops the skill and reports False instead of
        crashing the resolver. FIX-T013R (P1-T013R-01): the escape
        guard tests the RESOLVED path, and the target content is only
        read after the guard passes — an escaping symlink is recorded
        as SYMLINK_OUTSIDE_ROOT (P1/UNKNOWN) and never attributed to
        the containing scope, never read, never silently dropped."""
        skill_md_abs = os.path.join(skill_dir_abs, "SKILL.md")
        try:
            real_skill_path = os.path.realpath(skill_md_abs)
        except OSError:
            return False
        existing = by_real_path.get(real_skill_path)
        # FIX-T013R: the guard tests the RESOLVED path; the discovered
        # path still feeds relativePath and the alias list. Either
        # being None is fail-closed as an escape.
        rel_from_root = relative_posix(root_dir, skill_md_abs)
        rel_real_from_root = relative_posix(root_dir, real_skill_path)
        if rel_from_root is None or rel_real_from_root is None:
            findings.append({
                "id": "SYMLINK_OUTSIDE_ROOT",
                "severity": "P1",
                "sourceScope": source_scope,
                "status": "UNKNOWN",
                "detail": (
                    f"symlink '{relative_posix(layout_root, skill_md_abs) or to_posix(skill_md_abs)}' "
                    f"resolves outside its source root ({source_scope}); "
                    "its target content was never enumerated as this scope"
                ),
            })
            return True
        # FIX-R2 (P1-R2-02): same physical file, same scope -> merge as
        # an alias (c06 behaviour, unchanged). The scoped lookup runs
        # before the cross-scope branch below.
        scoped_key = (real_skill_path, source_scope)
        scoped = by_real_path_and_scope.get(scoped_key)
        if scoped is not None:
            if rel_from_root not in scoped["aliases"]:
                scoped["aliases"].append(rel_from_root)
                scoped["aliases"].sort()
            return True
        if existing is not None:
            # FIX-R2 (P1-R2-02): the same physical file is reachable
            # from a second, DIFFERENT scope (e.g. repo_root ==
            # home_root, or two source roots pointing at one
            # directory). Do NOT merge into `existing` and do NOT let
            # the first-scanned scope decide the policy outcome: a
            # forbidden scope must not be swallowed by an earlier
            # allowed one, and the first instance's aliases must not
            # absorb a path that belongs to another scope. Fall
            # through and create a second instance for this scope
            # below; the shared read re-reads the same real path
            # (identical content by construction).
            pass
        try:
            text = read_text(real_skill_path)
        except OSError:
            return False
        manifest_name = read_manifest_name_codex(text)
        canonical_path = relative_posix(layout_root, real_skill_path)
        canonical = canonical_path if canonical_path is not None else to_posix(real_skill_path)
        skill: dict[str, Any] = {
            "instanceId": f"codex:{source_root_id}:{canonical}",
            "sourceRootId": source_root_id,
            "sourceScope": source_scope,
            "relativePath": rel_from_root,
            "canonicalPath": canonical,
            "logicalName": manifest_name if manifest_name is not None else folder_name,
            "folderName": folder_name,
            "contentSha256": sha256_hex_text(text),
            "canonicalPathHash": sha256_hex_text(canonical),
            "status": "ELIGIBLE",
            "aliases": [],
            "evidenceLevel": "STATIC_RULE",
            "realPath": real_skill_path,
        }
        if manifest_name is not None:
            skill["manifestName"] = manifest_name
        by_real_path_and_scope[scoped_key] = skill
        if existing is None:
            by_real_path[real_skill_path] = skill
        ordered_skills.append(skill)
        return True

    def scan_skills_dir(source_root_id, source_scope, root_dir, skills_dir) -> str:
        """Port of Codex scanSkillsDir (FIX-R1): returns "ok",
        "missing" (known absence), or "unreadable" (the directory or a
        skill inside it could not be read). Skills readable before a
        failure are still collected; the failure marks the source
        unknown."""
        access = classify_path(skills_dir)
        if access == "missing":
            return "missing"
        if access == "unreadable":
            return "unreadable"
        try:
            is_dir = stat.S_ISDIR(os.stat(skills_dir).st_mode)
        except OSError:
            return "unreadable"
        if not is_dir:
            return "missing"
        listed = _codex_list_skill_dirs(skills_dir)
        if "error" in listed:
            return "unreadable"
        failed = False
        for folder_name in listed["dirs"]:
            skill_dir_abs = os.path.join(skills_dir, folder_name)
            try:
                has_state = (
                    "yes"
                    if stat.S_ISREG(os.stat(os.path.join(skill_dir_abs, "SKILL.md")).st_mode)
                    else "no"
                )
            except OSError as e:
                has_state = "no" if e.errno == errno.ENOENT else "unreadable"
            if has_state == "unreadable":
                failed = True
                continue
            if has_state == "yes" and not add_skill_dir(
                source_root_id, source_scope, root_dir, skill_dir_abs, folder_name
            ):
                failed = True
        return "unreadable" if failed else "ok"

    # 1. Project sources: cwd up to (and including) repoRoot, never above.
    repo_root_abs = os.path.normpath(repo_root)
    cwd_abs = os.path.normpath(cwd)
    cwd_rel_to_repo = os.path.relpath(cwd_abs, repo_root_abs)
    cwd_inside_repo = cwd_rel_to_repo == "" or not (
        cwd_rel_to_repo == ".." or cwd_rel_to_repo.startswith(".." + os.sep)
    )
    if not cwd_inside_repo:
        unknown_sources.append("REPO")
        findings.append({
            "id": "SOURCE_NOT_ENUMERATED",
            "severity": "P1",
            "sourceScope": "REPO",
            "status": "UNKNOWN",
            "detail": "cwd is outside the repository root; project sources cannot be resolved",
        })
    else:
        directory = cwd_abs
        repo_failed = False
        while True:
            if (
                scan_skills_dir("repo", "REPO", repo_root_abs,
                                os.path.join(directory, ".agents", "skills"))
                == "unreadable"
            ):
                repo_failed = True
            if directory == repo_root_abs:
                break
            parent = os.path.normpath(os.path.join(directory, ".."))
            if parent == directory:
                break
            directory = parent
        if repo_failed or classify_path(repo_root_abs) != "present":
            note_unknown("REPO")

    # 2. User source.
    if scan_skills_dir("user", "USER", os.path.normpath(home_root),
                       os.path.join(home_root, ".agents", "skills")) != "ok":
        note_unknown("USER")

    # 3. Admin source.
    if scan_skills_dir("admin", "ADMIN", os.path.normpath(admin_root),
                       os.path.join(admin_root, "skills")) != "ok":
        note_unknown("ADMIN")

    # 4. System source: bundled inventory.
    system_known = False
    if bundled_path is not None:
        try:
            raw = json.loads(read_text(bundled_path), parse_constant=_reject_constant)
            if isinstance(raw, dict) and isinstance(raw.get("skills"), list):
                system_known = True
                for entry in raw["skills"]:
                    if not isinstance(entry, dict):
                        continue
                    name = entry.get("name")
                    content = entry.get("content")
                    if not isinstance(name, str) or not isinstance(content, str):
                        continue
                    relative_path = f"bundled/{name}/SKILL.md"
                    ordered_skills.append({
                        "instanceId": f"codex:system:{relative_path}",
                        "sourceRootId": "system",
                        "sourceScope": "SYSTEM",
                        "relativePath": relative_path,
                        "canonicalPath": relative_path,
                        "logicalName": name,
                        "folderName": name,
                        "contentSha256": sha256_hex_text(content),
                        "canonicalPathHash": sha256_hex_text(relative_path),
                        "status": "ELIGIBLE",
                        "aliases": [],
                        "evidenceLevel": "STATIC_RULE",
                        "realPath": relative_path,
                    })
        except (OSError, ValueError):
            system_known = False
    if not system_known:
        note_unknown("SYSTEM")

    # 5. Plugin source.
    plugin_known = False
    if plugins_path is not None:
        try:
            raw = json.loads(read_text(plugins_path), parse_constant=_reject_constant)
            if isinstance(raw, dict) and isinstance(raw.get("plugins"), list):
                plugin_known = True
                for plugin in raw["plugins"]:
                    if not isinstance(plugin, dict):
                        continue
                    plugin_id = plugin.get("id")
                    skill_names = plugin.get("skills")
                    if not isinstance(plugin_id, str) or not isinstance(skill_names, list):
                        continue
                    for skill_name in skill_names:
                        if not isinstance(skill_name, str):
                            continue
                        relative_path = f"plugins/{plugin_id}/{skill_name}/SKILL.md"
                        ordered_skills.append({
                            "instanceId": f"codex:plugin:{relative_path}",
                            "sourceRootId": "plugin",
                            "sourceScope": "PLUGIN",
                            "relativePath": relative_path,
                            "canonicalPath": relative_path,
                            "logicalName": skill_name,
                            "folderName": skill_name,
                            "contentSha256": sha256_hex_text(f"plugin:{plugin_id}:{skill_name}"),
                            "canonicalPathHash": sha256_hex_text(relative_path),
                            "status": "ELIGIBLE",
                            "aliases": [],
                            "evidenceLevel": "STATIC_RULE",
                            "realPath": relative_path,
                        })
        except (OSError, ValueError):
            plugin_known = False
    if not plugin_known:
        note_unknown("PLUGIN")

    # 6. Config: skills.config selectors + [skills.bundled].
    config_readable = True
    config: dict[str, Any] = {"entries": [], "bundledEnabled": True}
    if config_path is not None:
        try:
            text = read_text(config_path)
            # The test harness resolves the __CASE_DIR__ placeholder to the
            # absolute layout path before the adapter reads the file.
            text = text.replace("__CASE_DIR__", layout_root)
            config = _parse_codex_config(text)
        except (OSError, ValueError, tomllib.TOMLDecodeError):
            config_readable = False

    if not config_readable:
        for skill in ordered_skills:
            skill["status"] = "UNKNOWN"
        findings.append({
            "id": "FAIL_OPEN_CONFIG",
            "severity": "P1",
            "sourceScope": "GLOBAL",
            "status": "CONFIRMED",
            "detail": "skills.config could not be read or parsed; effective set is unknown (fail closed)",
        })
    else:
        blast_seen: set[str] = set()
        for entry in config["entries"]:
            if "path" in entry:
                try:
                    target_real = os.path.realpath(os.path.normpath(entry["path"]))
                except OSError:
                    target_real = os.path.normpath(entry["path"])
                matched = [s for s in ordered_skills if s["realPath"] == target_real]
            else:
                matched = [s for s in ordered_skills if s["logicalName"] == entry["name"]]
                if len(matched) > 1 and entry["name"] not in blast_seen:
                    blast_seen.add(entry["name"])
                    findings.append({
                        "id": "NAME_SELECTOR_BLAST_RADIUS",
                        "severity": "P1",
                        "sourceScope": "GLOBAL",
                        "status": "CONFIRMED",
                        "affectedCount": len(matched),
                        "detail": f'name selector "{entry["name"]}" affects {len(matched)} distinct instances',
                    })
            for skill in matched:
                skill["status"] = "ELIGIBLE" if entry["enabled"] else "DISABLED"
        if not config["bundledEnabled"]:
            for skill in ordered_skills:
                if skill["sourceScope"] == "SYSTEM":
                    skill["status"] = "DISABLED"

    # 7. Deterministic ordering + status derivation.
    def scope_rank(scope: str) -> int:
        return CODEX_SCOPE_ORDER.index(scope)

    ordered_skills.sort(key=lambda s: (scope_rank(s["sourceScope"]), s["relativePath"]))
    findings.sort(key=lambda f: (f["id"], f["sourceScope"]))
    unknown_sources.sort(key=scope_rank)
    skills = [{k: v for k, v in s.items() if k != "realPath"} for s in ordered_skills]

    # FIX-T013R: mirror the TS PoC — an UNKNOWN finding
    # (SYMLINK_OUTSIDE_ROOT) means INCOMPLETE even when every source
    # was enumerated.
    if (
        not config_readable
        or unknown_sources
        or any(f.get("status") == "UNKNOWN" for f in findings)
    ):
        status = "INCOMPLETE"
    elif any(f["severity"] == "P1" for f in findings):
        status = "FAIL"
    else:
        status = "PASS"

    return {
        "schema": "skillscope.codex-poc-result/v1",
        "caseId": raw_input["case_id"],
        "status": status,
        "skills": skills,
        "findings": findings,
        "coverage": {
            "enumeratedSources": len(CODEX_REQUIRED_SOURCES) - len(unknown_sources),
            "requiredSources": len(CODEX_REQUIRED_SOURCES),
        },
        "unknownSources": unknown_sources,
        "configReadable": config_readable,
    }

# ----------------------------------------------------------------- claude ---
def _claude_instance_id(root_id: str, relative_path: str) -> str:
    return f"{root_id}:{relative_path}"


def _claude_instance_from_scan(scanned, root, logical_name, status):
    inst: dict[str, Any] = {
        "instanceId": _claude_instance_id(root["sourceRootId"], scanned["relativePath"]),
        "engine": "claude-code",
        "sourceRootId": root["sourceRootId"],
        "sourceScope": root["scope"],
        "relativePath": scanned["relativePath"],
        "canonicalPathHash": sha256_hex_text(scanned["canonicalPath"]),
        "logicalName": logical_name,
        "folderName": scanned["folderName"],
        "contentSha256": scanned["contentSha256"],
        "status": status,
        "evidenceLevel": "STATIC_RULE",
    }
    if scanned["manifestName"] is not None:
        inst["manifestName"] = scanned["manifestName"]
    return inst


def resolve_claude_native(profile: dict[str, Any]) -> dict[str, Any]:
    """Port of resolveClaudePoc (T003). `profile` has absolute root paths
    (already resolved against the fixture dir by resolve_claude_fixture)."""
    instances: list[dict[str, Any]] = []
    findings: list[dict[str, Any]] = []
    unknown_scopes: list[str] = []
    enumerated_sources = 0
    required_sources = 0

    for root in profile["sourceRoots"]:
        if root.get("required"):
            required_sources += 1
        if root["scope"] == "NESTED" and root.get("visited") is False:
            if root.get("required"):
                enumerated_sources += 1
            continue
        if root["scope"] == "ACCOUNT_SYNC":
            if root.get("snapshotSkills") is None:
                unknown_scopes.append(root["scope"])
                findings.append({
                    "id": "SOURCE_NOT_ENUMERATED",
                    "severity": "P1",
                    "sourceScope": root["scope"],
                    "detail": f"account-sync source {root['sourceRootId']} has no host snapshot; synced skills cannot be enumerated",
                    "instanceIds": [],
                })
                continue
            enumerated_sources += 1
            for snap in root["snapshotSkills"]:
                inst: dict[str, Any] = {
                    "instanceId": _claude_instance_id(
                        root["sourceRootId"], f"snapshot/{snap['name']}"),
                    "engine": "claude-code",
                    "sourceRootId": root["sourceRootId"],
                    "sourceScope": "ACCOUNT_SYNC",
                    "relativePath": f"snapshot/{snap['name']}/SKILL.md",
                    "canonicalPathHash": sha256_hex_text(f"account-sync:{snap['name']}"),
                    "logicalName": snap["name"],
                    "folderName": snap["name"],
                    "contentSha256": sha256_hex_text(f"account-sync-record:{snap['name']}"),
                    "status": "ELIGIBLE",
                    "evidenceLevel": "HOST_SNAPSHOT",
                }
                if snap.get("description") is not None:
                    inst["manifestName"] = snap["name"]
                instances.append(inst)
            continue

        scanned_result = scan_skill_root(root["path"])
        if any(e["reason"] == "ROOT_MISSING_OR_UNREADABLE" for e in scanned_result["skipped"]):
            if root.get("required"):
                unknown_scopes.append(root["scope"])
                findings.append({
                    "id": "SOURCE_NOT_ENUMERATED",
                    "severity": "P1",
                    "sourceScope": root["scope"],
                    "detail": f"required source root {root['sourceRootId']} ({root['path']}) is missing or unreadable",
                    "instanceIds": [],
                })
            continue
        # FIX-R1 (P0-R1-02): a skill inside the root whose SKILL.md
        # exists but cannot be read is unknown content. The root
        # still counts as enumerated, the readable skills are still
        # reported, but the scope is unknown. Applies whether or not
        # the root is `required`: a present-but-unreadable skill may
        # still be loaded by the host.
        unverifiable = [
            e for e in scanned_result["skipped"]
            if is_content_unknown_skip(e["reason"], e.get("code"))
        ]
        if unverifiable:
            unknown_scopes.append(root["scope"])
            paths = ", ".join(e["path"] for e in unverifiable)
            findings.append({
                "id": "SOURCE_NOT_ENUMERATED",
                "severity": "P1",
                "sourceScope": root["scope"],
                "detail": (
                    f"required source root {root['sourceRootId']} ({root['path']}) could not be "
                    f"fully enumerated: {len(unverifiable)} "
                    f"{'entry' if len(unverifiable) == 1 else 'entries'} unreadable ({paths}); "
                    "content may be present but is unverified"
                ),
                "instanceIds": [],
            })
        enumerated_sources += 1
        for scanned in scanned_result["skills"]:
            base_name = scanned["manifestName"] if scanned["manifestName"] is not None else scanned["folderName"]
            if root["scope"] == "PLUGIN" and root.get("pluginName") is not None:
                logical_name = f"{root['pluginName']}:{base_name}"
            else:
                logical_name = base_name
            if not scanned["manifestValid"]:
                findings.append({
                    "id": "INVALID_MANIFEST",
                    "severity": "P2",
                    "sourceScope": root["scope"],
                    "detail": f"SKILL.md at {scanned['relativePath']} has invalid frontmatter: {', '.join(scanned['manifestErrors'])}",
                    "instanceIds": [_claude_instance_id(root["sourceRootId"], scanned["relativePath"])],
                })
                instances.append(_claude_instance_from_scan(scanned, root, logical_name, "INVALID"))
                continue
            instances.append(_claude_instance_from_scan(scanned, root, logical_name, "ELIGIBLE"))

    # FIX-R1 (P0-R1-03): the on-disk account-sync directory
    # <home>/.claude/skills/synced. Only when no ACCOUNT_SYNC root
    # is declared does the PoC consult it; a declared root is
    # authoritative. A missing synced/ directory is known absence.
    # Skills on disk, or an unreadable directory, make ACCOUNT_SYNC
    # unknown (the host may load them; there is no snapshot here).
    account_sync_declared = any(r["scope"] == "ACCOUNT_SYNC" for r in profile["sourceRoots"])
    account_sync_dir = profile.get("accountSyncDir")
    if not account_sync_declared and account_sync_dir:
        access = classify_path(account_sync_dir)
        if access == "unreadable":
            unknown_scopes.append("ACCOUNT_SYNC")
            findings.append({
                "id": "SOURCE_NOT_ENUMERATED",
                "severity": "P1",
                "sourceScope": "ACCOUNT_SYNC",
                "detail": f"account-synced skills directory {account_sync_dir} cannot be read; synced skills cannot be enumerated without a host snapshot",
                "instanceIds": [],
            })
        elif access == "present":
            listed = _codex_list_skill_dirs(account_sync_dir)
            has_skill = False
            # FIX-T013R (P2-T013R-02): mirror the TS hasUnverifiable
            # check. A listing error, or a SKILL.md stat that fails
            # for any reason other than absence, means the directory
            # may hold skills whose content cannot be proven — the
            # scope is UNKNOWN, not an empty absence.
            has_unverifiable = "error" in listed
            if "dirs" in listed:
                for name in listed["dirs"]:
                    try:
                        if stat.S_ISREG(
                            os.stat(os.path.join(account_sync_dir, name, "SKILL.md")).st_mode
                        ):
                            has_skill = True
                            break
                    except OSError as e:
                        if e.errno != errno.ENOENT:
                            has_unverifiable = True
                        continue
            if has_skill or has_unverifiable:
                required_sources += 1
                unknown_scopes.append("ACCOUNT_SYNC")
                findings.append({
                    "id": "SOURCE_NOT_ENUMERATED",
                    "severity": "P1",
                    "sourceScope": "ACCOUNT_SYNC",
                    "detail": f"account-synced skills exist on disk under {account_sync_dir} but no ACCOUNT_SYNC source root is declared; synced skills cannot be enumerated without a host snapshot",
                    "instanceIds": [],
                })

    _claude_shared_findings(instances, findings, profile.get("skillOverrides") or {},
                            profile.get("policy"))

    has_p1 = any(f["severity"] == "P1" for f in findings)
    status = "INCOMPLETE" if unknown_scopes else ("FAIL" if has_p1 else "PASS")
    return {
        "profileId": profile["profileId"],
        "engine": "claude-code",
        "instances": instances,
        "findings": findings,
        "coverage": {
            "enumeratedSources": enumerated_sources,
            "requiredSources": required_sources,
            "unknownScopes": unknown_scopes,
        },
        "status": status,
    }


def _claude_shared_findings(instances, findings, overrides, policy):
    """Same-name collision, duplicate content, name-based overrides and
    policy comparison — shared by the Claude and OpenMausBot adapters."""
    # Same logical name at different paths: distinct instances, P2 note.
    by_name: dict[str, list[dict[str, Any]]] = {}
    for inst in instances:
        if inst["status"] == "INVALID":
            continue
        by_name.setdefault(inst["logicalName"], []).append(inst)
    for name in sorted(by_name):
        group = by_name[name]
        distinct_paths = {inst["canonicalPathHash"] for inst in group}
        if len(distinct_paths) > 1:
            findings.append({
                "id": "SAME_NAME_COLLISION",
                "severity": "P2",
                "sourceScope": group[0]["sourceScope"],
                "detail": f'logical name "{name}" resolves to {len(distinct_paths)} distinct instances at different paths',
                "instanceIds": [inst["instanceId"] for inst in group],
            })
    # Duplicate content at different paths: still two instances, plus a note.
    by_content: dict[str, list[dict[str, Any]]] = {}
    for inst in instances:
        by_content.setdefault(inst["contentSha256"], []).append(inst)
    for content_hash in sorted(by_content):
        group = by_content[content_hash]
        distinct_paths = {inst["canonicalPathHash"] for inst in group}
        if len(group) > 1 and len(distinct_paths) > 1:
            findings.append({
                "id": "DUPLICATE_CONTENT",
                "severity": "P2",
                "sourceScope": group[0]["sourceScope"],
                "detail": f"content hash {content_hash[:12]}… appears at {len(distinct_paths)} distinct paths",
                "instanceIds": [inst["instanceId"] for inst in group],
            })
    # Name-based overrides (Claude) — the OpenMausBot adapter calls the
    # same helper with overrides={} and handles its own name switches.
    for name in sorted(overrides):
        matched = [inst for inst in instances
                   if inst["logicalName"] == name and inst["status"] != "INVALID"]
        if len(matched) > 1:
            findings.append({
                "id": "NAME_SELECTOR_BLAST_RADIUS",
                "severity": "P1",
                "sourceScope": matched[0]["sourceScope"],
                "detail": f'name-based override "{name}" disables {len(matched)} distinct instances',
                "instanceIds": [inst["instanceId"] for inst in matched],
            })
        for inst in matched:
            inst["status"] = "DISABLED"
    # Policy comparison on the effective set. FIX-R1 (ADR-006
    # clarification): the effective set is ELIGIBLE only. A
    # DISCOVERED instance in a forbidden scope is not effective —
    # the kernel drops it — so it must not produce a SCOPE_LEAK
    # here; the adapter reports it separately as a discovery
    # finding. (Previously ELIGIBLE-or-DISCOVERED, which disagreed
    # with the resolver.)
    effective = [inst for inst in instances if inst["status"] == "ELIGIBLE"]
    policy = policy or {}
    forbidden = set(policy.get("forbiddenScopes") or [])
    allowed = None if policy.get("allowedScopes") is None else set(policy["allowedScopes"])
    for inst in effective:
        if inst["sourceScope"] in forbidden:
            findings.append({
                "id": "SCOPE_LEAK",
                "severity": "P1",
                "sourceScope": inst["sourceScope"],
                "detail": f"skill \"{inst['logicalName']}\" from forbidden scope {inst['sourceScope']} is in the effective set",
                "instanceIds": [inst["instanceId"]],
            })
        elif allowed is not None and inst["sourceScope"] not in allowed:
            findings.append({
                "id": "SCOPE_LEAK",
                "severity": "P1",
                "sourceScope": inst["sourceScope"],
                "detail": f"skill \"{inst['logicalName']}\" from scope {inst['sourceScope']} is outside the allowed scopes",
                "instanceIds": [inst["instanceId"]],
            })
    findings.sort(key=lambda f: (f["id"], f["detail"]))


def resolve_claude_fixture(fixture_dir: str, profile: dict[str, Any]) -> dict[str, Any]:
    """Port of resolveClaudeFixture: resolve relative root paths against the
    fixture directory (ACCOUNT_SYNC roots and empty paths stay as-is)."""
    resolved = dict(profile)
    if profile.get("accountSyncDir"):
        resolved["accountSyncDir"] = os.path.normpath(
            os.path.join(fixture_dir, profile["accountSyncDir"]))
    resolved["sourceRoots"] = []
    for root in profile["sourceRoots"]:
        r = dict(root)
        if root["scope"] != "ACCOUNT_SYNC" and root["path"] != "":
            r["path"] = os.path.normpath(os.path.join(fixture_dir, root["path"]))
        resolved["sourceRoots"].append(r)
    return resolve_claude_native(resolved)


# ------------------------------------------------------------- openmausbot ---
OMB_KIND_SCOPE = {
    "assigned": "BOT_ASSIGNED",
    "imported": "IMPORTED",
    "native": "SYSTEM",
    "plugin": "PLUGIN",
    "repo": "REPO",
    "library": "SHARED_LIBRARY",
    "user-claude": "USER",
}


def _omb_instance_id(root_id: str, scanned) -> str:
    return f"{root_id}:{sha256_hex_text(scanned['canonicalPath'])}"


def _omb_instance_from_scan(scanned, root_id, scope, logical_name, status, bot_id):
    inst: dict[str, Any] = {
        "instanceId": _omb_instance_id(root_id, scanned),
        "engine": "openmausbot",
        "botId": bot_id,
        "sourceRootId": root_id,
        "sourceScope": scope,
        "relativePath": scanned["relativePath"],
        "canonicalPathHash": sha256_hex_text(scanned["canonicalPath"]),
        "logicalName": logical_name,
        "folderName": scanned["folderName"],
        "contentSha256": scanned["contentSha256"],
        "status": status,
        "evidenceLevel": "STATIC_RULE",
    }
    if scanned["manifestName"] is not None:
        inst["manifestName"] = scanned["manifestName"]
    return inst


def _is_path_under(child_path: str, parent_path: str) -> bool:
    relative = os.path.relpath(child_path, parent_path)
    return relative == "" or (not relative.startswith("..") and not os.path.isabs(relative))


def resolve_omb_native(profile: dict[str, Any]) -> dict[str, Any]:
    """Port of resolveOpenMausBotPoc (T003). `profile` has absolute paths
    (already resolved against the fixture dir by resolve_omb_fixture)."""
    instances: list[dict[str, Any]] = []
    findings: list[dict[str, Any]] = []
    unknown_scopes: list[str] = []
    enumerated_sources = 0
    required_sources = 2  # config + snapshot

    # 1. Server config: flags, or defaults when the file is absent.
    # FIX-R1 (P0-R1-04): the flags live under "features" only
    # (docs/feature-flags.md: "The server stores these options under
    # `features` in its `config.json`"). A top-level-only config
    # reads as defaults. FIX-R1 (P1-R1-02): existence is checked
    # with classify_path, so an unreadable config is distinguished
    # from a missing one.
    claude_user_skills = False
    skills_library = False
    config_source = "defaults"
    config_path = os.path.join(profile["dataDir"], "config.json")
    access = classify_path(config_path)
    if access == "missing":
        config_source = "defaults"
        enumerated_sources += 1
    elif access == "unreadable":
        config_source = "invalid"
        unknown_scopes.append("CONFIG")
        findings.append({
            "id": "FAIL_OPEN_CONFIG", "severity": "P1", "sourceScope": "SYSTEM",
            "detail": f"config.json at {config_path} exists but cannot be read; flag state unknown, host may fall back to defaults",
            "instanceIds": [],
        })
    else:
        parsed = read_json_file(config_path)
        if not parsed["ok"] or not is_record(parsed["value"]):
            config_source = "invalid"
            unknown_scopes.append("CONFIG")
            detail = (
                f"config.json at {config_path} is "
                f"{'not an object' if parsed['ok'] else parsed['reason']}"
                "; flag state unknown, host may fall back to defaults"
            )
            findings.append({
                "id": "FAIL_OPEN_CONFIG", "severity": "P1", "sourceScope": "SYSTEM",
                "detail": detail, "instanceIds": [],
            })
        else:
            flags = parsed["value"]
            features = flags.get("features")
            if features is None:
                config_source = "file"
                enumerated_sources += 1
                claude_user_skills = False
                skills_library = False
            elif not is_record(features):
                config_source = "invalid"
                unknown_scopes.append("CONFIG")
                findings.append({
                    "id": "FAIL_OPEN_CONFIG", "severity": "P1", "sourceScope": "SYSTEM",
                    "detail": 'config.json has a non-object "features" value; flag state unknown',
                    "instanceIds": [],
                })
            else:
                user_skills = features.get("claudeUserSkills")
                library = features.get("skillsLibrary")
                if ((user_skills is not None and not isinstance(user_skills, bool))
                        or (library is not None and not isinstance(library, bool))):
                    config_source = "invalid"
                    unknown_scopes.append("CONFIG")
                    findings.append({
                        "id": "FAIL_OPEN_CONFIG", "severity": "P1", "sourceScope": "SYSTEM",
                        "detail": "config.json has non-boolean features.claudeUserSkills/skillsLibrary flags; flag state unknown",
                        "instanceIds": [],
                    })
                else:
                    config_source = "file"
                    enumerated_sources += 1
                    claude_user_skills = user_skills is True
                    skills_library = library is True

    # 2. Snapshot version gate.
    snapshot_trusted = True
    if profile["snapshot"]["version"] != OMB_SNAPSHOT_VERSION:
        snapshot_trusted = False
        unknown_scopes.append("SNAPSHOT")
        findings.append({
            "id": "SOURCE_NOT_ENUMERATED", "severity": "P1", "sourceScope": "SYSTEM",
            "detail": f"snapshot version \"{profile['snapshot']['version']}\" is unknown; per-bot inventory cannot be trusted",
            "instanceIds": [],
        })
    else:
        enumerated_sources += 1

    # 3. Every-bot opt-out state (only meaningful when the library is on).
    # FIX-R1 (P1-R1-02): an unreadable opt-out file is distinguished
    # from a missing one. Per the public docs an unreadable opt-out
    # means the bot keeps every-bot skills (the instance stays
    # ELIGIBLE), but the audit must be INCOMPLETE, not silent PASS.
    opted_out: set[str] = set()
    opt_out_unknown = False
    if skills_library and config_source != "invalid":
        opt_out_path = os.path.join(
            profile["dataDir"], "skill-state", profile["botId"], "library-opt-out.json")
        opt_out_access = classify_path(opt_out_path)
        if opt_out_access == "unreadable":
            opt_out_unknown = True
            unknown_scopes.append("SHARED_LIBRARY")
            findings.append({
                "id": "FAIL_OPEN_CONFIG", "severity": "P1",
                "sourceScope": "SHARED_LIBRARY",
                "detail": f"library opt-out file at {opt_out_path} exists but cannot be read; per public docs the bot may regain every-bot skills",
                "instanceIds": [],
            })
        elif opt_out_access == "present":
            parsed = read_json_file(opt_out_path)
            if not parsed["ok"] or not isinstance(parsed["value"], list):
                opt_out_unknown = True
                unknown_scopes.append("SHARED_LIBRARY")
                detail = (
                    f"library opt-out file at {opt_out_path} is "
                    f"{'not an array' if parsed['ok'] else parsed['reason']}"
                    "; per public docs the bot may regain every-bot skills"
                )
                findings.append({
                    "id": "FAIL_OPEN_CONFIG", "severity": "P1",
                    "sourceScope": "SHARED_LIBRARY", "detail": detail, "instanceIds": [],
                })
            else:
                for entry in parsed["value"]:
                    if isinstance(entry, str):
                        opted_out.add(entry)

    # 4. Resolve snapshot skills into instances.
    if snapshot_trusted:
        for skill in profile["snapshot"]["skills"]:
            scope = OMB_KIND_SCOPE[skill["kind"]]
            root_id = f"snapshot:{skill['kind']}"
            if skill["kind"] == "plugin" and skill.get("pluginId") is not None:
                logical_name = f"{skill['pluginId']}:{skill['name']}"
            else:
                logical_name = skill["name"]
            gated_off = False
            if skill["kind"] == "library" and not skills_library:
                gated_off = True
            if skill["kind"] == "user-claude" and not claude_user_skills:
                gated_off = True
            if skill["kind"] == "library" and skill["name"] in opted_out:
                gated_off = True
            # FIX-R1 (P1-R1-02 / P0-R1-02): the snapshot skill path is
            # classified, and an unreadable SKILL.md is unknown
            # content, not "no skill". Both cases carry the same
            # detail string as the TypeScript adapter (parity
            # compares it verbatim).
            if classify_path(skill["path"]) != "present":
                unknown_scopes.append(scope)
                findings.append({
                    "id": "SOURCE_NOT_ENUMERATED", "severity": "P1",
                    "sourceScope": scope,
                    "detail": f"snapshot skill \"{skill['name']}\" ({skill['kind']}) points at missing or unreadable directory {skill['path']}",
                    "instanceIds": [],
                })
                continue
            resolved = scan_single_skill_dir(skill["path"], skill["name"])
            if resolved["unreadable"]:
                if scope not in unknown_scopes:
                    unknown_scopes.append(scope)
                findings.append({
                    "id": "SOURCE_NOT_ENUMERATED", "severity": "P1",
                    "sourceScope": scope,
                    "detail": f"snapshot skill \"{skill['name']}\" ({skill['kind']}) points at a directory with no readable SKILL.md; the skill cannot be enumerated",
                    "instanceIds": [],
                })
                continue
            for scanned in resolved["scanned"]:
                if not scanned["manifestValid"]:
                    findings.append({
                        "id": "INVALID_MANIFEST", "severity": "P2",
                        "sourceScope": scope,
                        "detail": f"SKILL.md for \"{skill['name']}\" has invalid frontmatter: {', '.join(scanned['manifestErrors'])}",
                        "instanceIds": [_omb_instance_id(root_id, scanned)],
                    })
                    instances.append(_omb_instance_from_scan(
                        scanned, root_id, scope, logical_name, "INVALID", profile["botId"]))
                    continue
                status = "DISCOVERED" if gated_off else "ELIGIBLE"
                if (skill["kind"] == "plugin" and skill.get("pluginId") is not None
                        and skill["pluginId"] in (profile["snapshot"].get("disabledPluginIds") or [])):
                    status = "DISABLED"
                if skill["kind"] == "imported" and skill.get("importState") == "closed":
                    status = "DISABLED"
                instances.append(_omb_instance_from_scan(
                    scanned, root_id, scope, logical_name, status, profile["botId"]))
                # #5449 item 7: a closed imported copy does not unload the
                # original folder.
                if (skill["kind"] == "imported" and skill.get("importState") == "closed"
                        and skill.get("originalPath") is not None):
                    original_under_root = any(
                        _is_path_under(skill["originalPath"], root)
                        for root in profile["snapshot"].get("loadableRoots") or []
                    )
                    if original_under_root:
                        findings.append({
                            "id": "IMPORT_ORIGINAL_PATH_STILL_ACTIVE", "severity": "P1",
                            "sourceScope": "IMPORTED",
                            "detail": f"imported skill \"{skill['name']}\" was closed but its original folder {skill['originalPath']} is still under a loadable root",
                            "instanceIds": [_omb_instance_id(root_id, scanned)],
                        })
                        # FIX-R1: an unreadable original is unknown
                        # content (same SOURCE_NOT_ENUMERATED rule as
                        # the snapshot scan above).
                        original_resolved = scan_single_skill_dir(
                            skill["originalPath"], skill["name"])
                        if original_resolved["unreadable"]:
                            if "IMPORTED" not in unknown_scopes:
                                unknown_scopes.append("IMPORTED")
                            findings.append({
                                "id": "SOURCE_NOT_ENUMERATED", "severity": "P1",
                                "sourceScope": "IMPORTED",
                                "detail": f"imported skill \"{skill['name']}\" original folder {skill['originalPath']} has no readable SKILL.md; the original cannot be enumerated",
                                "instanceIds": [],
                            })
                        else:
                            for orig in original_resolved["scanned"]:
                                instances.append(_omb_instance_from_scan(
                                    orig, "imported-original", "IMPORTED", skill["name"],
                                    "ELIGIBLE" if orig["manifestValid"] else "INVALID",
                                    profile["botId"]))

        # Native name switches are name-based: a switch hits every
        # instance with that logical name, not just the native one.
        for name in profile["snapshot"].get("nativeDisabledNames") or []:
            matched = [inst for inst in instances
                       if inst["logicalName"] == name and inst["status"] != "INVALID"]
            if len(matched) > 1:
                findings.append({
                    "id": "NAME_SELECTOR_BLAST_RADIUS", "severity": "P1",
                    "sourceScope": matched[0]["sourceScope"],
                    "detail": f'per-bot native name switch "{name}" disables {len(matched)} distinct instances',
                    "instanceIds": [inst["instanceId"] for inst in matched],
                })
            for inst in matched:
                inst["status"] = "DISABLED"

    # Same-name collision, duplicate content and policy: same rules as Claude.
    _claude_shared_findings(instances, findings, {}, profile.get("policy"))

    has_p1 = any(f["severity"] == "P1" for f in findings)
    if unknown_scopes or opt_out_unknown:
        status = "INCOMPLETE"
    elif has_p1:
        status = "FAIL"
    else:
        status = "PASS"
    return {
        "profileId": profile["profileId"],
        "botId": profile["botId"],
        "engine": "openmausbot",
        "instances": instances,
        "findings": findings,
        "coverage": {
            "enumeratedSources": enumerated_sources,
            "requiredSources": required_sources,
            "unknownScopes": unknown_scopes,
        },
        "status": status,
        "flags": {
            "claudeUserSkills": claude_user_skills,
            "skillsLibrary": skills_library,
            "configSource": config_source,
        },
    }


def resolve_omb_fixture(fixture_dir: str, profile: dict[str, Any]) -> dict[str, Any]:
    """Port of resolveOpenMausBotFixture: resolve relative paths against the
    fixture directory."""
    def resolve_abs(p: str) -> str:
        return p if p == "" else os.path.normpath(os.path.join(fixture_dir, p))

    resolved = dict(profile)
    resolved["dataDir"] = resolve_abs(profile["dataDir"])
    snapshot = dict(profile["snapshot"])
    snapshot["skills"] = []
    for skill in profile["snapshot"]["skills"]:
        s = dict(skill)
        s["path"] = resolve_abs(skill["path"])
        if skill.get("originalPath") is not None:
            s["originalPath"] = resolve_abs(skill["originalPath"])
        snapshot["skills"].append(s)
    snapshot["loadableRoots"] = [resolve_abs(r) for r in profile["snapshot"].get("loadableRoots") or []]
    resolved["snapshot"] = snapshot
    return resolve_omb_native(resolved)


# --------------------------------------------------------- canonicalisation --
def _scrub_detail(detail: str, fixture_dir: str) -> str:
    return detail.replace(fixture_dir, FIXTURE_DIR_PLACEHOLDER)


def _canonical_finding(finding, fixture_dir, instance_id_map, native_status_known):
    """Map one native finding to its canonical form. `instance_id_map`
    translates native instanceIds to canonical instance keys; None means
    the native finding carries no instance references (Codex)."""
    canonical: dict[str, Any] = {
        "id": finding["id"],
        "severity": finding["severity"],
        "sourceScope": finding["sourceScope"],
        "status": finding["status"] if native_status_known else (
            "UNKNOWN" if finding["id"] == "SOURCE_NOT_ENUMERATED" else "CONFIRMED"),
        "detail": _scrub_detail(finding["detail"], fixture_dir),
    }
    if "affectedCount" in finding:
        canonical["affectedCount"] = finding["affectedCount"]
    if instance_id_map is None:
        canonical["instanceIds"] = []
    else:
        canonical["instanceIds"] = sorted(
            instance_id_map[i] for i in finding.get("instanceIds", []))
    return canonical


def _sort_canonical(result: dict[str, Any]) -> dict[str, Any]:
    result["instances"].sort(
        key=lambda i: (i["sourceRootId"], i["relativePath"], i["logicalName"]))
    result["findings"].sort(
        key=lambda f: (f["id"], f["sourceScope"], f["detail"]))
    result["coverage"]["unknownScopes"] = sorted(result["coverage"]["unknownScopes"])
    return result


def canonicalize_codex(fixture_id, kind, defect, fixture_dir, native):
    instances = []
    for skill in native["skills"]:
        if skill["sourceScope"] in ("REPO", "USER", "ADMIN"):
            canonical_path = "layout/" + skill["canonicalPath"]
        else:
            canonical_path = skill["canonicalPath"]
        inst: dict[str, Any] = {
            "sourceRootId": skill["sourceRootId"],
            "sourceScope": skill["sourceScope"],
            "relativePath": skill["relativePath"],
            "canonicalPath": canonical_path,
            "logicalName": skill["logicalName"],
            "folderName": skill["folderName"],
            "contentSha256": skill["contentSha256"],
            "status": skill["status"],
            "evidenceLevel": skill["evidenceLevel"],
            "aliases": list(skill["aliases"]),
        }
        if "manifestName" in skill:
            inst["manifestName"] = skill["manifestName"]
        instances.append(inst)
    findings = [_canonical_finding(f, fixture_dir, None, True) for f in native["findings"]]
    return _sort_canonical({
        "fixture_id": fixture_id,
        "engine": "codex",
        "kind": kind,
        "defect": defect,
        "status": native["status"],
        "instances": instances,
        "findings": findings,
        "coverage": {
            "enumeratedSources": native["coverage"]["enumeratedSources"],
            "requiredSources": native["coverage"]["requiredSources"],
            "unknownScopes": list(native["unknownSources"]),
        },
        "extra": {"configReadable": native["configReadable"]},
    })


def canonicalize_claude(fixture_id, kind, defect, fixture_dir, profile, native):
    root_path = {r["sourceRootId"]: r["path"] for r in profile["sourceRoots"]}
    instances = []
    for inst in native["instances"]:
        if inst["sourceScope"] == "ACCOUNT_SYNC":
            canonical_path = inst["relativePath"]
        else:
            absolute = os.path.realpath(
                os.path.join(root_path[inst["sourceRootId"]], inst["relativePath"]))
            canonical_path = to_posix(os.path.relpath(absolute, fixture_dir))
        entry: dict[str, Any] = {
            "sourceRootId": inst["sourceRootId"],
            "sourceScope": inst["sourceScope"],
            "relativePath": inst["relativePath"],
            "canonicalPath": canonical_path,
            "logicalName": inst["logicalName"],
            "folderName": inst["folderName"],
            "contentSha256": inst["contentSha256"],
            "status": inst["status"],
            "evidenceLevel": inst["evidenceLevel"],
            "aliases": [],
        }
        if "manifestName" in inst:
            entry["manifestName"] = inst["manifestName"]
        instances.append(entry)
    # Claude native instanceIds already are canonical keys
    # ("<sourceRootId>:<relativePath>").
    id_map = {inst["instanceId"]: inst["instanceId"] for inst in native["instances"]}
    findings = [_canonical_finding(f, fixture_dir, id_map, False) for f in native["findings"]]
    return _sort_canonical({
        "fixture_id": fixture_id,
        "engine": "claude-code",
        "kind": kind,
        "defect": defect,
        "status": native["status"],
        "instances": instances,
        "findings": findings,
        "coverage": {
            "enumeratedSources": native["coverage"]["enumeratedSources"],
            "requiredSources": native["coverage"]["requiredSources"],
            "unknownScopes": list(native["coverage"]["unknownScopes"]),
        },
        "extra": {},
    })


def canonicalize_omb(fixture_id, kind, defect, fixture_dir, profile, native):
    # Map each instance to its snapshot entry to recover the canonical path.
    entries: dict[tuple[str, str], dict[str, Any]] = {}
    for skill in profile["snapshot"]["skills"]:
        key = (OMB_KIND_SCOPE[skill["kind"]], skill["name"])
        if key in entries:
            raise ValueError(f"ambiguous snapshot entry for {key} in {fixture_id}")
        entries[key] = skill
    id_map: dict[str, str] = {}
    instances = []
    for inst in native["instances"]:
        if inst["sourceRootId"] == "imported-original":
            entry = entries.get(("IMPORTED", inst["logicalName"]))
            if entry is None or entry.get("importState") != "closed":
                raise ValueError(f"no closed imported entry for {inst['logicalName']} in {fixture_id}")
            skill_dir = entry["originalPath"]
        else:
            name = inst["logicalName"]
            if inst["sourceScope"] == "PLUGIN" and ":" in name:
                name = name.split(":", 1)[1]
            entry = entries.get((inst["sourceScope"], name))
            if entry is None:
                raise ValueError(f"no snapshot entry for {inst['sourceScope']}/{name} in {fixture_id}")
            skill_dir = entry["path"]
        canonical_path = to_posix(os.path.relpath(
            os.path.realpath(os.path.join(skill_dir, "SKILL.md")), fixture_dir))
        key = f"{inst['sourceRootId']}:{inst['relativePath']}"
        if inst["instanceId"] in id_map and id_map[inst["instanceId"]] != key:
            raise ValueError(f"ambiguous canonical key for {inst['instanceId']} in {fixture_id}")
        id_map[inst["instanceId"]] = key
        entry_inst: dict[str, Any] = {
            "sourceRootId": inst["sourceRootId"],
            "sourceScope": inst["sourceScope"],
            "relativePath": inst["relativePath"],
            "canonicalPath": canonical_path,
            "logicalName": inst["logicalName"],
            "folderName": inst["folderName"],
            "contentSha256": inst["contentSha256"],
            "status": inst["status"],
            "evidenceLevel": inst["evidenceLevel"],
            "aliases": [],
        }
        if "manifestName" in inst:
            entry_inst["manifestName"] = inst["manifestName"]
        instances.append(entry_inst)
    findings = [_canonical_finding(f, fixture_dir, id_map, False) for f in native["findings"]]
    return _sort_canonical({
        "fixture_id": fixture_id,
        "engine": "openmausbot",
        "kind": kind,
        "defect": defect,
        "status": native["status"],
        "instances": instances,
        "findings": findings,
        "coverage": {
            "enumeratedSources": native["coverage"]["enumeratedSources"],
            "requiredSources": native["coverage"]["requiredSources"],
            "unknownScopes": list(native["coverage"]["unknownScopes"]),
        },
        "extra": {"botId": native["botId"], "flags": dict(native["flags"])},
    })


# ------------------------------------------------------------------- driver --
def resolve_fixture(entry: dict[str, Any], fixtures_root: str) -> dict[str, Any]:
    """Resolve one manifest entry to its canonical S0 result."""
    fixture_dir = os.path.normpath(os.path.join(fixtures_root, entry["dir"]))
    engine = entry["engine"]
    if engine == "codex":
        with open(os.path.join(fixture_dir, "input.json"), encoding="utf-8") as fh:
            raw_input = json.load(fh)
        native = resolve_codex_native(fixture_dir, raw_input)
        return canonicalize_codex(
            entry["fixture_id"], entry["kind"], entry.get("defect"),
            fixture_dir, native)
    if engine == "claude-code":
        with open(os.path.join(fixture_dir, "profile.json"), encoding="utf-8") as fh:
            profile = json.load(fh)
        resolved = dict(profile)
        resolved["sourceRoots"] = []
        for root in profile["sourceRoots"]:
            r = dict(root)
            if root["scope"] != "ACCOUNT_SYNC" and root["path"] != "":
                r["path"] = os.path.normpath(os.path.join(fixture_dir, root["path"]))
            resolved["sourceRoots"].append(r)
        native = resolve_claude_native(resolved)
        return canonicalize_claude(
            entry["fixture_id"], entry["kind"], entry.get("defect"),
            fixture_dir, resolved, native)
    if engine == "openmausbot":
        with open(os.path.join(fixture_dir, "profile.json"), encoding="utf-8") as fh:
            profile = json.load(fh)
        resolved = dict(profile)
        resolved["dataDir"] = os.path.normpath(os.path.join(fixture_dir, profile["dataDir"]))

        def resolve_abs(p: str) -> str:
            return p if p == "" else os.path.normpath(os.path.join(fixture_dir, p))

        snapshot = dict(profile["snapshot"])
        snapshot["skills"] = []
        for skill in profile["snapshot"]["skills"]:
            s = dict(skill)
            s["path"] = resolve_abs(skill["path"])
            if skill.get("originalPath") is not None:
                s["originalPath"] = resolve_abs(skill["originalPath"])
            snapshot["skills"].append(s)
        snapshot["loadableRoots"] = [
            resolve_abs(r) for r in profile["snapshot"].get("loadableRoots") or []]
        resolved["snapshot"] = snapshot
        native = resolve_omb_native(resolved)
        return canonicalize_omb(
            entry["fixture_id"], entry["kind"], entry.get("defect"),
            fixture_dir, resolved, native)
    raise ValueError(f"unknown engine {engine!r} in manifest entry {entry['fixture_id']}")


def resolve_all(manifest_path: str, fixtures_root: str) -> list[dict[str, Any]]:
    """Resolve every manifest fixture, in manifest order."""
    with open(manifest_path, encoding="utf-8") as fh:
        manifest = json.load(fh)
    if manifest.get("seed") != SEED:
        raise ValueError(f"manifest seed {manifest.get('seed')!r} != {SEED!r}")
    return [resolve_fixture(entry, fixtures_root) for entry in manifest["fixtures"]]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="P023 S0 Reference Oracle")
    parser.add_argument("--manifest", required=True, help="path to s0 manifest.json")
    parser.add_argument("--fixtures", required=True, help="fixtures root directory")
    args = parser.parse_args(argv)
    results = resolve_all(args.manifest, args.fixtures)
    sys.stdout.write(json.dumps(results, ensure_ascii=False) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
