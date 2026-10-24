"""refs_io: RIS/BibTeX round-trips, author edge cases, malformed input, CSV."""
import os
import unittest

import helpers
import refs_io

RIS_SAMPLE = """TY  - JOUR
TI  - Multi-Agent Systems in Clinical Decision Support
AU  - Kim, Y.
AU  - O'Brien, Conan
AU  - Garcia-Lopez, Maria
PY  - 2024
JO  - Journal of Medical AI
DO  - 10.1234/jmai.2024.001
AB  - We study things.
UR  - https://example.org/paper
ER  - 

TY  - CONF
TI  - Aristotle Was Right About Logic
AU  - Aristotle
PY  - 2023
T2  - Proceedings of Ancient Computing
ER  - 
"""

BIB_SAMPLE = """@article{kim2024,
  title = {Multi-Agent Systems in Clinical Decision Support},
  author = {Kim, Y. and O'Brien, Conan and Garc\u00eda-L\u00f3pez, Jos\u00e9},
  year = {2024},
  journal = {Journal of Medical AI},
  doi = {10.1234/jmai.2024.001},
}

@inproceedings{aristotle2023,
  title = {Aristotle Was Right About Logic},
  author = {Aristotle},
  year = {2023},
  booktitle = {Proceedings of Ancient Computing},
}
"""


class RefsCase(helpers.ResearchCase):
    def write(self, name, text):
        path = os.path.join(self.dir, name)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(text)
        return path

    def import_ok(self, path):
        recs, errors = [], []
        for rec, err, label in refs_io.iter_import(path):
            if err:
                errors.append((label, err))
            else:
                recs.append(rec)
        return recs, errors


class AuthorTest(RefsCase):
    def test_regression_single_author_not_split_on_comma(self):
        # "Kim, Y." is Surname, Initial — ONE author, never two.
        self.assertEqual(refs_io.norm_authors("Kim, Y."), ["Kim, Y."])
        recs, _ = self.import_ok(self.write("one.ris", RIS_SAMPLE))
        self.assertEqual(recs[0]["authors"][0], "Kim, Y.")

    def test_regression_string_authors_not_iterated_as_chars(self):
        # A STRING authors field must stay one author, not explode into chars.
        self.assertEqual(refs_io.norm_authors("Nguyen, L. D."), ["Nguyen, L. D."])
        out = os.path.join(self.dir, "str-authors.ris")
        refs_io.export_ris(
            [{"title": "T", "authors": "Nguyen, L. D.", "year": 2024}], out
        )
        with open(out, encoding="utf-8") as fh:
            text = fh.read()
        self.assertIn("AU  - Nguyen, L. D.\n", text)
        self.assertNotIn("AU  - n\n", text)
        self.assertEqual(text.count("AU  - "), 1)

    def test_mononym_author(self):
        self.assertEqual(refs_io.norm_authors("Aristotle"), ["Aristotle"])

    def test_semicolon_list_splits(self):
        self.assertEqual(
            refs_io.norm_authors("Kim, Y.; O'Brien, Conan;  Garcia-Lopez, Maria "),
            ["Kim, Y.", "O'Brien, Conan", "Garcia-Lopez, Maria"],
        )

    def test_apostrophe_hyphen_unicode_names_survive(self):
        names = ["O'Brien, Conan", "Garcia-Lopez, Maria", "Garc\u00eda-L\u00f3pez, Jos\u00e9"]
        self.assertEqual(refs_io.norm_authors(names), names)

    def test_none_and_blank_authors(self):
        self.assertEqual(refs_io.norm_authors(None), [])
        self.assertEqual(refs_io.norm_authors(" ; ;"), [])


class RisTest(RefsCase):
    def test_ris_round_trip_preserves_fields(self):
        src = self.write("in.ris", RIS_SAMPLE)
        originals, errors = self.import_ok(src)
        self.assertEqual(errors, [])
        self.assertEqual(len(originals), 2)
        out = os.path.join(self.dir, "out.ris")
        refs_io.export_ris(originals, out)
        reimported, errors = self.import_ok(out)
        self.assertEqual(errors, [])
        for orig, back in zip(originals, reimported):
            self.assertEqual(back["title"], orig["title"])
            self.assertEqual(back["year"], orig["year"])
            self.assertEqual(back["doi"], orig["doi"])
            self.assertEqual(back["authors"], orig["authors"])

    def test_ris_missing_er_reported_not_crashed(self):
        broken = "TY  - JOUR\nTI  - Broken One\nTY  - JOUR\nTI  - Good One\nER  - \n"
        recs, errors = self.import_ok(self.write("broken.ris", broken))
        self.assertEqual(len(recs), 1)
        self.assertEqual(recs[0]["title"], "Good One")
        self.assertEqual(len(errors), 1)
        self.assertIn("missing ER", errors[0][1])

    def test_ris_entry_without_title_skipped(self):
        broken = "TY  - JOUR\nAU  - Kim, Y.\nER  - \n"
        recs, errors = self.import_ok(self.write("notitle.ris", broken))
        self.assertEqual(recs, [])
        self.assertEqual(errors[0][1], "no title")


class BibTest(RefsCase):
    def test_bib_round_trip_preserves_fields(self):
        src = self.write("in.bib", BIB_SAMPLE)
        originals, errors = self.import_ok(src)
        self.assertEqual(errors, [])
        self.assertEqual(len(originals), 2)
        self.assertEqual(
            originals[0]["authors"],
            ["Kim, Y.", "O'Brien, Conan", "Garc\u00eda-L\u00f3pez, Jos\u00e9"],
        )
        out = os.path.join(self.dir, "out.bib")
        refs_io.export_bib(originals, out)
        reimported, errors = self.import_ok(out)
        self.assertEqual(errors, [])
        for orig, back in zip(originals, reimported):
            self.assertEqual(back["title"], orig["title"])
            self.assertEqual(back["year"], orig["year"])
            self.assertEqual(back["doi"], orig["doi"])
            self.assertEqual(back["authors"], orig["authors"])

    def test_bib_unbalanced_braces_reported_not_crashed(self):
        broken = "@article{x,\n  title = {Unclosed\n"
        recs, errors = self.import_ok(self.write("broken.bib", broken))
        self.assertEqual(recs, [])
        self.assertEqual(errors[0][1], "unbalanced braces")

    def test_bib_entry_without_title_skipped(self):
        recs, errors = self.import_ok(
            self.write("notitle.bib", "@article{x,\n  year = {2024},\n}\n")
        )
        self.assertEqual(recs, [])
        self.assertEqual(errors[0][1], "no title")


class CsvTest(RefsCase):
    def test_csv_import_with_aliases_and_semicolon_authors(self):
        csv_text = (
            "Article Title,Author Full Names,Publication Year,Source Title,DOI\n"
            '"CSV Systems Study","Kim, Y.; Aristotle",2022,Journal of CSV,10.5/csv.1\n'
        )
        recs, errors = self.import_ok(self.write("in.csv", csv_text))
        self.assertEqual(errors, [])
        rec = recs[0]
        self.assertEqual(rec["title"], "CSV Systems Study")
        self.assertEqual(rec["authors"], ["Kim, Y.", "Aristotle"])
        self.assertEqual(rec["year"], 2022)
        self.assertEqual(rec["doi"], "10.5/csv.1")

    def test_csv_row_without_title_skipped_others_survive(self):
        csv_text = "title,year\n,2001\nStill Good,2002\n"
        recs, errors = self.import_ok(self.write("bad.csv", csv_text))
        self.assertEqual([r["title"] for r in recs], ["Still Good"])
        self.assertEqual(errors[0][1], "no title")


class NormTest(RefsCase):
    def test_doi_normalized(self):
        for raw in (
            "https://doi.org/10.1234/ABC.5",
            "http://dx.doi.org/10.1234/abc.5",
            "doi: 10.1234/Abc.5",
        ):
            self.assertEqual(refs_io.norm_doi(raw), "10.1234/abc.5")
        self.assertIsNone(refs_io.norm_doi(""))
        self.assertIsNone(refs_io.norm_doi(None))


if __name__ == "__main__":
    unittest.main()
