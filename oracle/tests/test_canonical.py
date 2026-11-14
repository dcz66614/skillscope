"""Tests for the Oracle canonical JSON / SHA-256 helpers (T001).

These tests pin the canonical form the TypeScript side (T008) must match
exactly: sorted keys, compact separators, NFC normalisation, LF termination,
stable array order, deterministic hashing.
"""

import hashlib
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "python"))

from canonical import canonical_bytes, canonical_json, sha256_hex


class TestCanonicalJson(unittest.TestCase):
    def test_keys_sorted_and_compact(self):
        self.assertEqual(canonical_json({"b": 1, "a": {"d": 4, "c": 3}}), '{"a":{"c":3,"d":4},"b":1}')

    def test_no_trailing_newline_in_string_form(self):
        self.assertFalse(canonical_json({"a": 1}).endswith("\n"))

    def test_byte_form_is_utf8_with_one_trailing_lf(self):
        self.assertEqual(canonical_bytes({"a": 1}), b'{"a":1}\n')

    def test_array_order_is_preserved_not_sorted(self):
        self.assertEqual(canonical_json({"items": [3, 1, 2]}), '{"items":[3,1,2]}')

    def test_nfc_normalisation_makes_equivalent_strings_identical(self):
        decomposed = "e\u0301"  # "e" + U+0301 combining acute
        composed = "\u00e9"  # U+00E9 LATIN SMALL LETTER E WITH ACUTE
        self.assertNotEqual(decomposed, composed)
        self.assertEqual(canonical_json({"name": decomposed}), canonical_json({"name": composed}))

    def test_nested_normalisation(self):
        value = {"skills": [{"name": "e\u0301"}, {"name": "\u00e9"}]}
        self.assertEqual(
            canonical_json(value),
            '{"skills":[{"name":"\u00e9"},{"name":"\u00e9"}]}',
        )

    def test_non_ascii_kept_as_utf8_not_escaped(self):
        self.assertEqual(canonical_json({"name": "技能"}), '{"name":"技能"}')

    def test_deterministic_across_calls(self):
        value = {"z": [1, {"b": 2, "a": 3}], "a": None, "m": True}
        self.assertEqual(canonical_json(value), canonical_json(value))
        self.assertEqual(sha256_hex(value), sha256_hex(value))

    def test_sha256_matches_independent_hashlib_computation(self):
        value = {"a": 1}
        expected = hashlib.sha256(b'{"a":1}\n').hexdigest()
        self.assertEqual(sha256_hex(value), expected)
        self.assertRegex(sha256_hex(value), r"^[0-9a-f]{64}$")

    def test_different_content_gives_different_hash(self):
        self.assertNotEqual(sha256_hex({"a": 1}), sha256_hex({"a": 2}))
        self.assertNotEqual(sha256_hex({"a": 1}), sha256_hex({"b": 1}))

    def test_scalars_pass_through(self):
        self.assertEqual(canonical_json(None), "null")
        self.assertEqual(canonical_json(True), "true")
        self.assertEqual(canonical_json(42), "42")
        self.assertEqual(canonical_json("x"), '"x"')


if __name__ == "__main__":
    unittest.main()
