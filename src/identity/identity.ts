/**
 * Unified skill-instance identity (P023 T005, S1).
 *
 * Implements PROJECT_BOOK.md §4.2 (identity & hashing) as the single
 * identity authority for the production resolver (T006 integrates it):
 *
 *  1. A skill instance is NEVER identified by its logical name alone.
 *  2. Two files with the same logical name at different canonical paths
 *     are two instances.
 *  3. Several access paths resolving to the same physical file merge into
 *     ONE instance; the extra paths are kept as `aliases`.
 *  4. Two files with the same content SHA-256 at different paths are
 *     still TWO instances; the pair is reported as DUPLICATE_CONTENT.
 *  5. Exported reports use source_root_id + relative path; the instance
 *     id itself is a hash, so it leaks no absolute path or username.
 *  6. Path case and Unicode normalisation are platform semantics: the
 *     identity key uses the OS realpath verbatim (POSIX separators).
 *     Two on-disk directories that differ only by Unicode normal form
 *     are two distinct physical files on a case-sensitive filesystem
 *     and MUST stay two instances. NFC normalisation belongs to the
 *     canonical JSON text layer (T001/T008), never to the identity key.
 *
 * Identity key: (sourceRootId, canonicalPath) where canonicalPath is the
 * symlink-resolved real path. `instanceId` is SHA-256 over
 * `engine + NUL + sourceRootId + NUL + canonicalPath` — deterministic
 * and machine-local. Cross-machine comparison (T004 S0 gate) does not
 * use instanceId; it compares (sourceRootId, fixture-relative
 * canonicalPath) + contentSha256 instead.
 */

import { createHash } from "node:crypto";
import type {
  EngineId,
  EvidenceLevel,
  SkillInstanceV1,
  SkillStatus,
} from "../contracts/index.js";

export const IDENTITY_VERSION = "skillscope.identity/v1";

/** POSIX separators only; the path text itself is left byte-identical. */
export function toPosixPath(p: string): string {
  return p.split("\\").join("/");
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** SHA-256 of the canonical (real) path, POSIX form. */
export function canonicalPathHash(canonicalPath: string): string {
  return sha256Hex(toPosixPath(canonicalPath));
}

/**
 * Machine-local instance id. Stable for a given (engine, source root,
 * physical file); never derived from the logical name.
 */
export function computeInstanceId(
  engine: EngineId,
  sourceRootId: string,
  canonicalPath: string,
): string {
  return sha256Hex(
    [engine, sourceRootId, toPosixPath(canonicalPath)].join("\0"),
  );
}

/** Registry key: source root + canonical path. */
export function identityKey(sourceRootId: string, canonicalPath: string): string {
  return `${sourceRootId}\0${toPosixPath(canonicalPath)}`;
}

export interface RegistryInput {
  engine: EngineId;
  sourceRootId: string;
  sourceScope: string;
  /** Access path relative to the source root, POSIX, e.g. "release/SKILL.md". */
  relativePath: string;
  /** Symlink-resolved real path of the SKILL.md file (absolute). */
  canonicalPath: string;
  logicalName: string;
  folderName: string;
  manifestName?: string;
  contentSha256: string;
  status: SkillStatus;
  evidenceLevel: EvidenceLevel;
  botId?: string;
}

/** A SkillInstanceV1 plus the alias access paths merged into it. */
export interface RegisteredInstance extends SkillInstanceV1 {
  /** Other source-root-relative paths resolving to this same file. */
  aliases: string[];
}

export interface SameNameGroup {
  logicalName: string;
  instanceIds: string[];
}

export interface DuplicateContentGroup {
  contentSha256: string;
  instanceIds: string[];
}

/**
 * Identity registry: the single place where discovered files become
 * instances. Registration is order-independent for the final set (inputs
 * are merged by identity key; the first-registered access path wins as
 * the primary `relativePath` and the rest become sorted `aliases`, so
 * callers must feed inputs in sorted traversal order for determinism).
 */
export class IdentityRegistry {
  private readonly byKey = new Map<string, RegisteredInstance>();
  private readonly byId = new Map<string, RegisteredInstance>();
  private readonly byContent = new Map<string, Set<string>>();
  private readonly byLogicalName = new Map<string, Set<string>>();

  register(input: RegistryInput): RegisteredInstance {
    const key = identityKey(input.sourceRootId, input.canonicalPath);
    const existing = this.byKey.get(key);
    if (existing !== undefined) {
      // Same physical file via another access path: merge as an alias.
      // Primary relativePath / folderName / logicalName stay as first seen.
      if (
        existing.relativePath !== input.relativePath &&
        !existing.aliases.includes(input.relativePath)
      ) {
        existing.aliases.push(input.relativePath);
        existing.aliases.sort();
      }
      return existing;
    }
    const instance: RegisteredInstance = {
      instanceId: computeInstanceId(
        input.engine,
        input.sourceRootId,
        input.canonicalPath,
      ),
      engine: input.engine,
      ...(input.botId !== undefined ? { botId: input.botId } : {}),
      sourceRootId: input.sourceRootId,
      sourceScope: input.sourceScope,
      relativePath: input.relativePath,
      canonicalPathHash: canonicalPathHash(input.canonicalPath),
      logicalName: input.logicalName,
      folderName: input.folderName,
      ...(input.manifestName !== undefined
        ? { manifestName: input.manifestName }
        : {}),
      contentSha256: input.contentSha256,
      status: input.status,
      evidenceLevel: input.evidenceLevel,
      aliases: [],
    };
    this.byKey.set(key, instance);
    this.byId.set(instance.instanceId, instance);
    let contentSet = this.byContent.get(input.contentSha256);
    if (contentSet === undefined) {
      contentSet = new Set<string>();
      this.byContent.set(input.contentSha256, contentSet);
    }
    contentSet.add(instance.instanceId);
    let nameSet = this.byLogicalName.get(input.logicalName);
    if (nameSet === undefined) {
      nameSet = new Set<string>();
      this.byLogicalName.set(input.logicalName, nameSet);
    }
    nameSet.add(instance.instanceId);
    return instance;
  }

  get(instanceId: string): RegisteredInstance | undefined {
    return this.byId.get(instanceId);
  }

  get size(): number {
    return this.byKey.size;
  }

  /** Instances sorted by (sourceRootId, relativePath, logicalName). */
  instances(): RegisteredInstance[] {
    return [...this.byKey.values()].sort(
      (a, b) =>
        (a.sourceRootId < b.sourceRootId
          ? -1
          : a.sourceRootId > b.sourceRootId
            ? 1
            : 0) ||
        (a.relativePath < b.relativePath
          ? -1
          : a.relativePath > b.relativePath
            ? 1
            : 0) ||
        (a.logicalName < b.logicalName
          ? -1
          : a.logicalName > b.logicalName
            ? 1
            : 0),
    );
  }

  /**
   * Logical names claimed by more than one distinct instance
   * (PROJECT_BOOK §4.2 rule 2; finding SAME_NAME_COLLISION in T006).
   */
  sameNameCollisions(): SameNameGroup[] {
    const groups: SameNameGroup[] = [];
    for (const [logicalName, ids] of [...this.byLogicalName.entries()].sort(
      (a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
    )) {
      if (ids.size > 1) {
        groups.push({ logicalName, instanceIds: [...ids].sort() });
      }
    }
    return groups;
  }

  /**
   * Content hashes shared by more than one distinct instance
   * (PROJECT_BOOK §4.2 rule 4; finding DUPLICATE_CONTENT in T006).
   * Same content is NEVER merged into one instance.
   */
  duplicateContentGroups(): DuplicateContentGroup[] {
    const groups: DuplicateContentGroup[] = [];
    for (const [contentSha256, ids] of [...this.byContent.entries()].sort(
      (a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
    )) {
      if (ids.size > 1) {
        groups.push({ contentSha256, instanceIds: [...ids].sort() });
      }
    }
    return groups;
  }
}
