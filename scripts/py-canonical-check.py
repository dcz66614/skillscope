#!/usr/bin/env python3
"""Independent canonical-JSON cross-check for T008b (P023 S2).

Re-implements the frozen canonical form with the standard library only
(json.dumps sort_keys + NFC + hashlib.sha256) and prints, for each
input, one tab-separated line: name, canonical string, sha256 hex.

Usage:
    python3 py-canonical-check.py <json-file>

If the file is a canonical-vectors document ({"vectors": [...]}), one
line per vector (name = vector name). Otherwise one line for the whole
document (name = "value").

This file is deliberately independent of the TypeScript implementation:
it is the second implementation the evidence script compares against.
It must NOT import or call any SkillScope code.
"""

import hashlib
import json
import sys
import unicodedata


def canon(value):
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, (int, float)):
        if value == 0:
            return "0"
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, str):
        return json.dumps(unicodedata.normalize("NFC", value), ensure_ascii=False)
    if isinstance(value, list):
        return "[" + ",".join(canon(item) for item in value) + "]"
    keys = sorted(value.keys(), key=lambda k: [ord(c) for c in k])
    return "{" + ",".join(
        json.dumps(unicodedata.normalize("NFC", k), ensure_ascii=False)
        + ":"
        + canon(value[k])
        for k in keys
    ) + "}"


def main():
    doc = json.load(open(sys.argv[1], encoding="utf-8"))
    if isinstance(doc, dict) and "vectors" in doc:
        items = [(vec["name"], vec["input"]) for vec in doc["vectors"]]
    else:
        items = [("value", doc)]
    for name, value in items:
        text = canon(value)
        print(name + "\t" + text + "\t" + hashlib.sha256(text.encode("utf-8")).hexdigest())


main()
