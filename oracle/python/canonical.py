"""Canonical JSON + SHA-256 helpers for the Python Reference Oracle.

Canonical form (frozen by T001; the TypeScript side in T008 must match it
exactly):
  - UTF-8 encoding
  - LF line endings (one trailing LF on the byte form)
  - Unicode NFC normalisation
  - object keys sorted (stable, byte-wise on the NFC form)
  - compact separators (",", ":")
  - array order preserved (arrays are ordered data, never sorted)

Stdlib only. No production TypeScript code is imported or consulted here.
"""

from __future__ import annotations

import hashlib
import json
import unicodedata

__all__ = ["canonical_json", "canonical_bytes", "sha256_hex"]


def _normalise(value):
    """Recursively NFC-normalise every string in a JSON value."""
    if isinstance(value, str):
        return unicodedata.normalize("NFC", value)
    if isinstance(value, list):
        return [_normalise(item) for item in value]
    if isinstance(value, dict):
        return {unicodedata.normalize("NFC", str(k)): _normalise(v) for k, v in value.items()}
    return value


def canonical_json(value) -> str:
    """Return the canonical JSON string for a JSON value (no trailing LF)."""
    return json.dumps(
        _normalise(value),
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    )


def canonical_bytes(value) -> bytes:
    """Return the canonical byte form: canonical JSON + one trailing LF, UTF-8."""
    return (canonical_json(value) + "\n").encode("utf-8")


def sha256_hex(value) -> str:
    """Return the lowercase hex SHA-256 of the canonical byte form."""
    return hashlib.sha256(canonical_bytes(value)).hexdigest()
