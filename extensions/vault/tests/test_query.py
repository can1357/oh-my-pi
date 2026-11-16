"""Pure vault URL builder (no live omp host)."""

from __future__ import annotations

import unittest
from urllib.parse import parse_qs, urlsplit

from omp_vault.query import VaultQuery, build_vault_url


class QueryTests(unittest.TestCase):
	def test_info_url_encodes_the_note(self) -> None:
		url = build_vault_url(VaultQuery("My Notes", "info", "folder/a b.md"))
		parts = urlsplit(url)
		self.assertEqual(parts.scheme, "vault")
		self.assertEqual(parts.netloc, "My%20Notes")
		self.assertEqual(parts.path, "/folder/a%20b.md")
		self.assertEqual(parse_qs(parts.query)["op"], ["info"])

	def test_section_and_tag_require_their_fields(self) -> None:
		section = build_vault_url(VaultQuery("Notes", "section", "a.md", heading="Setup"))
		self.assertIn("heading=Setup", section)
		tagged = build_vault_url(VaultQuery("Notes", "tag", tag="omp"))
		self.assertTrue(tagged.startswith("vault://Notes?"))
		self.assertIn("tag=omp", tagged)
		with self.assertRaises(ValueError):
			build_vault_url(VaultQuery("Notes", "section", "a.md"))
		with self.assertRaises(ValueError):
			build_vault_url(VaultQuery("Notes", "map", "folder"))

	def test_unknown_operation_is_refused(self) -> None:
		with self.assertRaises(ValueError):
			build_vault_url(VaultQuery("Notes", "search", "a.md"))


if __name__ == "__main__":
	unittest.main()
