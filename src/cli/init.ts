/**
 * `skillscope init` (P023 T009, S3).
 *
 * Writes a starter skillscope.profile/v1 file into the target
 * directory. The starter uses a synthetic home directory inside the
 * project (./.skillscope-home) so a first audit never reads the real
 * user home. `init` is the only CLI command that creates a project
 * file; it refuses to overwrite an existing profile.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface InitResult {
  exitCode: 0 | 3 | 4;
  profilePath: string | null;
  error?: string;
}

export function starterProfile(profileId: string): Record<string, unknown> {
  return {
    schema: "skillscope.profile/v1",
    profile_id: profileId,
    engine: "codex",
    cwd: ".",
    repo_root: ".",
    home_root: "./.skillscope-home",
    source_roots: [
      {
        sourceRootId: "repo",
        engine: "codex",
        scope: "REPO",
        path: "./.agents/skills",
        required: true,
        evidenceLevel: "STATIC_RULE",
      },
      {
        sourceRootId: "user",
        engine: "codex",
        scope: "USER",
        path: "./.skillscope-home/.agents/skills",
        required: true,
        evidenceLevel: "STATIC_RULE",
      },
      {
        sourceRootId: "admin",
        engine: "codex",
        scope: "ADMIN",
        path: "./admin/skills",
        required: false,
        evidenceLevel: "STATIC_RULE",
      },
    ],
    policy: {
      allowed_scopes: ["REPO", "USER", "ADMIN", "SYSTEM"],
      forbidden_names: [],
      forbidden_scopes: [],
    },
  };
}

/**
 * Write the starter profile. Returns exit 3 when the file already
 * exists (never overwrites) or the directory is unusable.
 */
export function runInit(
  dir: string,
  profileId = "codex-local",
): InitResult {
  const targetDir = path.resolve(dir);
  const profilePath = path.join(targetDir, "skillscope.json");
  if (fs.existsSync(profilePath)) {
    return {
      exitCode: 3,
      profilePath: null,
      error: `skillscope.json already exists: ${profilePath} (refusing to overwrite)`,
    };
  }
  try {
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(
      profilePath,
      `${JSON.stringify(starterProfile(profileId), null, 2)}\n`,
      "utf8",
    );
  } catch (err) {
    return {
      exitCode: 4,
      profilePath: null,
      error: `cannot write ${profilePath}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return { exitCode: 0, profilePath };
}
