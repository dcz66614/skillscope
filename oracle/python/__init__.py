"""SkillScope Python Reference Oracle package (stdlib only).

The Oracle independently re-implements the host skill-scope rules in Python
and must never import TypeScript build output or production rule tables
(IMPLEMENTATION_PLAN §4.4, §7.2). T001 freezes only the canonical JSON /
SHA-256 helpers used by every later Oracle output; the resolver itself is
implemented by T004.
"""

__all__ = ["canonical"]
