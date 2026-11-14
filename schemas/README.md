# schemas/ — frozen JSON Schema documents (P023 T008b, S2)

One file per contract id. These are the single source of truth for file
validation in `src/io` (`loadSchema` / `validateAgainstSchema`); the
TypeScript interfaces in `src/contracts` and `src/resolver` mirror them
for in-memory values, and the tests cross-check both.

| File | Schema id | Mirrors |
|---|---|---|
| `skillscope-profile-v1.json` | `skillscope.profile/v1` | PROJECT_BOOK §6.1 `ProfileV1` |
| `skillscope-report-v1.json` | `skillscope.report/v1` | PROJECT_BOOK §6.3 `ReportV1` |
| `skillscope-audit-result-v1.json` | `skillscope.audit-result/v1` | `src/resolver` `AuditResult` (T006) |

The OpenMausBot per-bot snapshot schema is NOT copied here: it lives
with its adapter at
`src/adapters/openmausbot/openmausbot-snapshot-v1.json` (T007-owned) and
`src/io` loads it by reference through `SCHEMA_FILES`. A copy would
drift; a reference cannot.

Validator scope: `src/io` implements the JSON Schema subset these files
use (type — including `["string", "null"]` unions — enum, const,
required, properties, additionalProperties, items, minLength,
maxLength, pattern, minimum, maximum, minItems, maxItems). Schemas
must stay self-contained (no `$ref`); unknown keywords (`$id`,
`$schema`, `title`, `description`) are documentation only.
