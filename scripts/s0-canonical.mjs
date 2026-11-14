/**
 * S0 canonicalisation (P023 T004).
 *
 * Maps each production adapter's native result to the canonical S0 gate
 * result and provides the canonical JSON / SHA-256 helpers. This is an
 * INDEPENDENT implementation of the same canonical-output definition the
 * Python Reference Oracle implements (oracle/python/reference_resolver.py);
 * the gate compares the two field-by-field with no ignored fields.
 *
 * Canonical rules (see the Oracle module header for the full definition):
 *  - canonicalPath is relative to the fixture directory (POSIX); for
 *    virtual / snapshot-only skills it is the synthetic descriptor the
 *    adapter itself uses (codex "bundled/<name>/SKILL.md",
 *    "plugins/<id>/<name>/SKILL.md"; claude account-sync
 *    "snapshot/<name>/SKILL.md").
 *  - Native instanceId / canonicalPathHash (which hash absolute paths in
 *    the Claude / OpenMausBot adapters) are NOT part of the canonical
 *    output: the canonical identity is (sourceRootId, canonicalPath) +
 *    contentSha256.
 *  - Finding detail strings have the absolute fixture directory replaced
 *    by "<FIXTURE_DIR>".
 *  - Finding status is the adapter's native status for Codex; for Claude /
 *    OpenMausBot it is "UNKNOWN" iff the finding is SOURCE_NOT_ENUMERATED,
 *    else "CONFIRMED".
 *  - Finding instanceIds are canonical instance keys
 *    "<sourceRootId>:<relativePath>", sorted.
 *  - Instances sort by (sourceRootId, relativePath, logicalName); findings
 *    sort by (id, sourceScope, detail); unknownScopes sort alphabetically.
 *  - manifestName is present only when the adapter reports one;
 *    affectedCount only when the adapter reports one (Codex blast radius).
 *
 * Canonical JSON (must match oracle/python/canonical.py exactly):
 * UTF-8, LF termination on the byte form, NFC normalisation, object keys
 * sorted, compact separators, array order preserved.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export const FIXTURE_DIR_PLACEHOLDER = "<FIXTURE_DIR>";

const OMB_KIND_SCOPE = {
  assigned: "BOT_ASSIGNED",
  imported: "IMPORTED",
  native: "SYSTEM",
  plugin: "PLUGIN",
  repo: "REPO",
  library: "SHARED_LIBRARY",
  "user-claude": "USER",
};

function toPosix(p) {
  return p.split(path.sep).join("/");
}

function compareStr(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function scrubDetail(detail, fixtureDir) {
  if (fixtureDir === "") {
    return detail;
  }
  return detail.split(fixtureDir).join(FIXTURE_DIR_PLACEHOLDER);
}

function sortCanonical(result) {
  result.instances.sort((a, b) =>
    compareStr(a.sourceRootId, b.sourceRootId) ||
    compareStr(a.relativePath, b.relativePath) ||
    compareStr(a.logicalName, b.logicalName));
  result.findings.sort((a, b) =>
    compareStr(a.id, b.id) ||
    compareStr(a.sourceScope, b.sourceScope) ||
    compareStr(a.detail, b.detail));
  result.coverage.unknownScopes = [...result.coverage.unknownScopes].sort();
  return result;
}

function canonicalFinding(finding, fixtureDir, idMap, nativeStatusKnown) {
  const out = {
    id: finding.id,
    severity: finding.severity,
    sourceScope: finding.sourceScope,
    status: nativeStatusKnown
      ? finding.status
      : finding.id === "SOURCE_NOT_ENUMERATED"
        ? "UNKNOWN"
        : "CONFIRMED",
    detail: scrubDetail(finding.detail, fixtureDir),
  };
  if (finding.affectedCount !== undefined) {
    out.affectedCount = finding.affectedCount;
  }
  if (idMap === null) {
    out.instanceIds = [];
  } else {
    out.instanceIds = [...finding.instanceIds.map((id) => {
      const mapped = idMap.get(id);
      if (mapped === undefined) {
        throw new Error(`finding references unknown instance ${id}`);
      }
      return mapped;
    })].sort();
  }
  return out;
}

export function canonicalizeCodex(fixtureId, kind, defect, fixtureDir, native) {
  const instances = native.skills.map((skill) => {
    const canonicalPath = ["REPO", "USER", "ADMIN"].includes(skill.sourceScope)
      ? `layout/${skill.canonicalPath}`
      : skill.canonicalPath;
    const inst = {
      sourceRootId: skill.sourceRootId,
      sourceScope: skill.sourceScope,
      relativePath: skill.relativePath,
      canonicalPath,
      logicalName: skill.logicalName,
      folderName: skill.folderName,
      ...(skill.manifestName !== undefined ? { manifestName: skill.manifestName } : {}),
      contentSha256: skill.contentSha256,
      status: skill.status,
      evidenceLevel: skill.evidenceLevel,
      aliases: [...skill.aliases],
    };
    return inst;
  });
  const findings = native.findings.map((f) =>
    canonicalFinding(f, fixtureDir, null, true));
  return sortCanonical({
    fixture_id: fixtureId,
    engine: "codex",
    kind,
    defect,
    status: native.status,
    instances,
    findings,
    coverage: {
      enumeratedSources: native.coverage.enumeratedSources,
      requiredSources: native.coverage.requiredSources,
      unknownScopes: [...native.unknownSources],
    },
    extra: { configReadable: native.configReadable },
  });
}

export function canonicalizeClaude(fixtureId, kind, defect, fixtureDir, profile, native) {
  const rootPath = new Map(
    profile.sourceRoots.map((r) => [r.sourceRootId, r.path]),
  );
  const instances = native.instances.map((inst) => {
    let canonicalPath;
    if (inst.sourceScope === "ACCOUNT_SYNC") {
      canonicalPath = inst.relativePath;
    } else {
      const absolute = fs.realpathSync(
        path.join(rootPath.get(inst.sourceRootId), inst.relativePath),
      );
      canonicalPath = toPosix(path.relative(fixtureDir, absolute));
    }
    return {
      sourceRootId: inst.sourceRootId,
      sourceScope: inst.sourceScope,
      relativePath: inst.relativePath,
      canonicalPath,
      logicalName: inst.logicalName,
      folderName: inst.folderName,
      ...(inst.manifestName !== undefined ? { manifestName: inst.manifestName } : {}),
      contentSha256: inst.contentSha256,
      status: inst.status,
      evidenceLevel: inst.evidenceLevel,
      aliases: [],
    };
  });
  // Claude native instanceIds already are canonical keys
  // ("<sourceRootId>:<relativePath>").
  const idMap = new Map(
    native.instances.map((inst) => [inst.instanceId, inst.instanceId]),
  );
  const findings = native.findings.map((f) =>
    canonicalFinding(f, fixtureDir, idMap, false));
  return sortCanonical({
    fixture_id: fixtureId,
    engine: "claude-code",
    kind,
    defect,
    status: native.status,
    instances,
    findings,
    coverage: {
      enumeratedSources: native.coverage.enumeratedSources,
      requiredSources: native.coverage.requiredSources,
      unknownScopes: [...native.coverage.unknownScopes],
    },
    extra: {},
  });
}

export function canonicalizeOmb(fixtureId, kind, defect, fixtureDir, profile, native) {
  // Map each instance to its snapshot entry to recover the canonical path.
  const entries = new Map();
  for (const skill of profile.snapshot.skills) {
    const key = `${OMB_KIND_SCOPE[skill.kind]}\0${skill.name}`;
    if (entries.has(key)) {
      throw new Error(`ambiguous snapshot entry for ${key} in ${fixtureId}`);
    }
    entries.set(key, skill);
  }
  const idMap = new Map();
  const instances = native.instances.map((inst) => {
    let skillDir;
    if (inst.sourceRootId === "imported-original") {
      const entry = entries.get(`IMPORTED\0${inst.logicalName}`);
      if (entry === undefined || entry.importState !== "closed") {
        throw new Error(
          `no closed imported entry for ${inst.logicalName} in ${fixtureId}`,
        );
      }
      skillDir = entry.originalPath;
    } else {
      let name = inst.logicalName;
      if (inst.sourceScope === "PLUGIN" && name.includes(":")) {
        name = name.split(":").slice(1).join(":");
      }
      const entry = entries.get(`${inst.sourceScope}\0${name}`);
      if (entry === undefined) {
        throw new Error(
          `no snapshot entry for ${inst.sourceScope}/${name} in ${fixtureId}`,
        );
      }
      skillDir = entry.path;
    }
    const canonicalPath = toPosix(path.relative(
      fixtureDir,
      fs.realpathSync(path.join(skillDir, "SKILL.md")),
    ));
    const key = `${inst.sourceRootId}:${inst.relativePath}`;
    if (idMap.has(inst.instanceId) && idMap.get(inst.instanceId) !== key) {
      throw new Error(`ambiguous canonical key for ${inst.instanceId} in ${fixtureId}`);
    }
    idMap.set(inst.instanceId, key);
    return {
      sourceRootId: inst.sourceRootId,
      sourceScope: inst.sourceScope,
      relativePath: inst.relativePath,
      canonicalPath,
      logicalName: inst.logicalName,
      folderName: inst.folderName,
      ...(inst.manifestName !== undefined ? { manifestName: inst.manifestName } : {}),
      contentSha256: inst.contentSha256,
      status: inst.status,
      evidenceLevel: inst.evidenceLevel,
      aliases: [],
    };
  });
  const findings = native.findings.map((f) =>
    canonicalFinding(f, fixtureDir, idMap, false));
  return sortCanonical({
    fixture_id: fixtureId,
    engine: "openmausbot",
    kind,
    defect,
    status: native.status,
    instances,
    findings,
    coverage: {
      enumeratedSources: native.coverage.enumeratedSources,
      requiredSources: native.coverage.requiredSources,
      unknownScopes: [...native.coverage.unknownScopes],
    },
    extra: { botId: native.botId, flags: { ...native.flags } },
  });
}

// ------------------------------------------------------- canonical JSON -----
function normalise(value) {
  if (typeof value === "string") {
    return value.normalize("NFC");
  }
  if (Array.isArray(value)) {
    return value.map(normalise);
  }
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      out[key.normalize("NFC")] = normalise(value[key]);
    }
    return out;
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(normalise(value));
}

export function canonicalBytes(value) {
  return Buffer.from(`${canonicalJson(value)}\n`, "utf8");
}

export function sha256Hex(value) {
  return createHash("sha256").update(canonicalBytes(value)).digest("hex");
}

/** Deep equality for JSON values via canonical serialisation. */
export function canonicalEquals(a, b) {
  return canonicalJson(a) === canonicalJson(b);
}
