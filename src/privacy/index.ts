/**
 * Privacy redaction + secret scanning (P023 T008b, S2).
 *
 * SkillScope reports must be shareable without leaking the machine they
 * were produced on (PROJECT_BOOK §9, §7.4): absolute paths are redacted
 * by default, and token / API key / username values never enter a report
 * or a log. T009 (CLI + HTML report) runs every report through
 * `redactReport` before writing it; the evidence script proves the
 * redaction with a PII scan over synthetic secrets.
 *
 * Rules (frozen, see ADR-012):
 *   - Sensitive KEYS: a value is replaced by "[REDACTED]" when its key
 *     names a credential. Matching is case-insensitive and separator-
 *     insensitive ("accessToken", "access_token", "x-api-key" all hit):
 *     the flattened key (lowercased, "-" / "_" / " " removed) either
 *     equals one of KEY / AUTH / PWD / PASS / TOKEN / SECRET, contains
 *     one of TOKEN / SECRET / PASSWORD / PASSWD / CREDENTIAL / COOKIE /
 *     AUTHORIZATION / PRIVATEKEY / APIKEY / SESSIONID / BEARER, or ends
 *     with one of ACCESSKEY / AUTHKEY / APIKEY / PRIVATEKEY / SECRETKEY /
 *     PUBLICKEY. A key like "author" is NOT sensitive ("auth" is only
 *     an exact match, never a substring).
 *   - Sensitive VALUES: a string value matching a known secret pattern
 *     (sk-…, GitHub PAT, AKIA…, Google API key, Slack token, JWT,
 *     PEM private key, `Bearer …`, `password=…` assignment) is replaced
 *     even under an innocent key — defence in depth for values pasted
 *     into free-text fields.
 *   - Absolute PATHS: known base directories (home, cwd, caller-supplied
 *     scan roots) are replaced by <HOME> / <CWD> / <ROOT> (longest base
 *     first); any other absolute path under a known filesystem root
 *     (/home, /Users, /tmp, /var, /etc, /opt, /usr, /root, /workspace,
 *     /data, /private, /mnt, /srv, /Volumes) or a Windows drive / UNC
 *     path becomes <ABS_PATH>. Relative paths and URLs are untouched.
 *   - USERNAMES: caller-supplied usernames are replaced by <USER>.
 *     (The home directory's last segment is a username too, but it is
 *     already covered by the <HOME> base replacement.)
 *
 * Redaction never mutates its input: every function returns a new value.
 * `scanForSecrets` never returns a secret value — a finding carries the
 * pattern name, the JSON path and the matched length only.
 *
 * Pure module: no file access, no clock, no network.
 */

/** Placeholder written in place of a redacted credential value. */
export const REDACTED = "[REDACTED]";

/** Placeholder for the user's home directory. */
export const HOME_PLACEHOLDER = "<HOME>";
/** Placeholder for the working directory. */
export const CWD_PLACEHOLDER = "<CWD>";
/** Placeholder for a caller-supplied scan root. */
export const ROOT_PLACEHOLDER = "<ROOT>";
/** Placeholder for any other absolute path. */
export const ABS_PATH_PLACEHOLDER = "<ABS_PATH>";
/** Placeholder for a username. */
export const USER_PLACEHOLDER = "<USER>";

/** Filesystem roots whose absolute paths are redacted even when unknown. */
export const KNOWN_FS_ROOTS: readonly string[] = [
  "/home",
  "/Users",
  "/tmp",
  "/var",
  "/etc",
  "/opt",
  "/usr",
  "/root",
  "/workspace",
  "/data",
  "/private",
  "/mnt",
  "/srv",
  "/Volumes",
];

/** Secret value patterns: name → regex. All are global-free (no /g). */
export const SECRET_PATTERNS: Readonly<Record<string, RegExp>> = {
  "openai-key": /\bsk-[A-Za-z0-9_-]{16,}/,
  "github-pat": /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{10,}/,
  "aws-access-key": /\bAKIA[0-9A-Z]{16}\b/,
  "google-api-key": /\bAIza[0-9A-Za-z_-]{35}\b/,
  "slack-token": /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  "jwt": /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  "private-key": /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/,
  "bearer-token": /\bBearer\s+[A-Za-z0-9._~+/-]{10,}/i,
  "credential-assignment":
    /\b(?:password|passwd|api[_-]?key|secret|token)\s*[:=]\s*[^\s"']{4,}/i,
};

const SENSITIVE_EXACT_KEYS: ReadonlySet<string> = new Set([
  "key",
  "auth",
  "pwd",
  "pass",
  "token",
  "secret",
]);

const SENSITIVE_SUBSTRINGS: readonly string[] = [
  "token",
  "secret",
  "password",
  "passwd",
  "credential",
  "cookie",
  "authorization",
  "privatekey",
  "apikey",
  "sessionid",
  "bearer",
];

const SENSITIVE_SUFFIXES: readonly string[] = [
  "accesskey",
  "authkey",
  "apikey",
  "privatekey",
  "secretkey",
  "publickey",
];

function flattenKey(key: string): string {
  return key.toLowerCase().replace(/[-_ ]/g, "");
}

/** True when a field name denotes a credential (ADR-012). */
export function isSensitiveKey(key: string): boolean {
  const flat = flattenKey(key);
  if (SENSITIVE_EXACT_KEYS.has(flat)) {
    return true;
  }
  if (SENSITIVE_SUBSTRINGS.some((sub) => flat.includes(sub))) {
    return true;
  }
  return SENSITIVE_SUFFIXES.some((suffix) => flat.endsWith(suffix));
}

/** True when a string value itself looks like a secret. */
export function looksLikeSecret(value: string): boolean {
  return Object.values(SECRET_PATTERNS).some((re) => re.test(value));
}

export interface SecretFinding {
  /** Pattern name, e.g. "github-pat". Never the secret itself. */
  pattern: string;
  /** JSON path of the string that matched, e.g. "$.policy.token". */
  path: string;
  /** Length of the matched secret (evidence only, no value). */
  length: number;
  /** First 4 characters of the match + "…" (prefix only, never the secret). */
  prefix: string;
}

function jsonPath(parent: string, key: string): string {
  return parent === "$" ? `$.${key}` : `${parent}.${key}`;
}

function scanString(
  value: string,
  path: string,
  findings: SecretFinding[],
): void {
  for (const [name, re] of Object.entries(SECRET_PATTERNS)) {
    const match = re.exec(value);
    if (match !== null) {
      findings.push({
        pattern: name,
        path,
        length: match[0].length,
        prefix: `${match[0].slice(0, 4)}…`,
      });
    }
  }
}

function walkStrings(
  value: unknown,
  path: string,
  visit: (text: string, at: string) => void,
): void {
  if (typeof value === "string") {
    visit(value, path);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => walkStrings(item, `${path}[${i}]`, visit));
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      walkStrings(child, jsonPath(path, key), visit);
    }
  }
}

/**
 * Scan a value for secret-looking strings. Returns one finding per
 * (pattern, JSON path) pair; the findings never contain a secret value.
 * An empty list means no known secret pattern was found — it is not a
 * proof that the value holds no secret, only that no known pattern hit.
 */
export function scanForSecrets(value: unknown): SecretFinding[] {
  const findings: SecretFinding[] = [];
  walkStrings(value, "$", (text, at) => scanString(text, at, findings));
  return findings;
}

export interface RedactPathsOptions {
  /** Absolute home directory, replaced by <HOME>. */
  home?: string;
  /** Absolute working directory, replaced by <CWD>. */
  cwd?: string;
  /** Other absolute scan roots, replaced by <ROOT>. */
  roots?: readonly string[];
  /** Usernames to replace by <USER> (in addition to path bases). */
  usernames?: readonly string[];
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normaliseBase(base: string): string {
  // Trailing slashes are not part of the base: "/home/sam/" ≡ "/home/sam".
  return base.replace(/[\\/]+$/, "");
}

/**
 * Redact absolute paths inside a string. Known bases are replaced by
 * their placeholders (longest base first, so a nested root wins over
 * its parent); any other absolute path under a known filesystem root
 * or a Windows drive / UNC path becomes <ABS_PATH>. Relative paths and
 * URLs are left alone.
 */
export function redactPathsInText(text: string, options: RedactPathsOptions = {}): string {
  let out = text;
  const bases: Array<[string, string]> = [];
  if (options.home !== undefined && options.home !== "") {
    bases.push([normaliseBase(options.home), HOME_PLACEHOLDER]);
  }
  if (options.cwd !== undefined && options.cwd !== "") {
    bases.push([normaliseBase(options.cwd), CWD_PLACEHOLDER]);
  }
  for (const root of options.roots ?? []) {
    if (root !== "") {
      bases.push([normaliseBase(root), ROOT_PLACEHOLDER]);
    }
  }
  // Longest base first so "/home/sam/work" beats "/home/sam".
  bases.sort((a, b) => b[0].length - a[0].length);
  for (const [base, placeholder] of bases) {
    const pattern = new RegExp(escapeRegExp(base) + "(?=[\\\\/]|$)", "g");
    out = out.replace(pattern, placeholder);
  }
  const rootsAlternation = KNOWN_FS_ROOTS.map(escapeRegExp).join("|");
  // The (?![A-Za-z0-9._~-]) guard keeps "/home2/…" from matching the
  // "/home" root: a root only matches when it ends at a path boundary.
  const genericUnix = new RegExp(
    `(?<![\\w:/])(?:${rootsAlternation})(?![A-Za-z0-9._~-])(?:/[^\\s"'\\\\)\\]]*)?`,
    "g",
  );
  out = out.replace(genericUnix, ABS_PATH_PLACEHOLDER);
  const genericWindows = /(?<![\w:])(?:[A-Za-z]:[\\/]|\\\\[^\s"'\\]+\\[^\s"'\\]+)(?:[^\s"'\)\]]*)?/g;
  out = out.replace(genericWindows, ABS_PATH_PLACEHOLDER);
  for (const username of options.usernames ?? []) {
    if (username === "") {
      continue;
    }
    out = out.split(username).join(USER_PLACEHOLDER);
  }
  return out;
}

export interface RedactValueOptions extends RedactPathsOptions {
  /** When false, skip path redaction (key/value redaction still runs). */
  redactPaths?: boolean;
}

function redactStringValue(value: string, options: RedactValueOptions): string {
  let out = looksLikeSecret(value) ? REDACTED : value;
  if (options.redactPaths !== false) {
    out = redactPathsInText(out, options);
  }
  return out;
}

/**
 * Deep-redact a JSON value: sensitive keys and secret-looking values
 * become "[REDACTED]", absolute paths become placeholders. Returns a
 * new value; the input is never mutated. Non-JSON values (undefined,
 * functions, symbols) are dropped the way JSON.stringify drops them,
 * except at the top level where they are returned unchanged.
 */
export function redactValue(value: unknown, options: RedactValueOptions = {}): unknown {
  if (typeof value === "string") {
    return redactStringValue(value, options);
  }
  if (Array.isArray(value)) {
    return value
      .filter((item) => item !== undefined && typeof item !== "function" && typeof item !== "symbol")
      .map((item) => redactValue(item, options));
  }
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (child === undefined || typeof child === "function" || typeof child === "symbol") {
        continue;
      }
      out[key] = isSensitiveKey(key) ? REDACTED : redactValue(child, options);
    }
    return out;
  }
  return value;
}

/**
 * Redact a whole audit report (ReportV1 / AuditResult shape or any JSON
 * value) for sharing: credential fields, secret-looking values,
 * absolute paths and usernames are all removed. The input is untouched.
 */
export function redactReport(value: unknown, options: RedactValueOptions = {}): unknown {
  return redactValue(value, options);
}
