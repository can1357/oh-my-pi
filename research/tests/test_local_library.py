"""local_library: title/author/DOI heuristics and non-PDF safety."""
import os
import shutil
import sys
import unittest
from unittest import mock

import helpers
import local_library

# Handcrafted minimal PDF: a decoy /Author (annotation-style, appears FIRST in
# the raw bytes) plus the real trailer-referenced Info dict. Mirrors the
# corpus bug: Distiller-produced embedded objects carried /Author (negul.d)
# 13 times before the document's own /Author (Jia Li).
FIXTURE_PDF = b"""%PDF-1.4
1 0 obj
<< /Type /Annot /Author (negul.d) >>
endobj
2 0 obj
<< /Author (Jia Li) /Title (Experience-guided multi-agent interpretable framework for radiology report summarization) /CreationDate (D:20251107122410Z) >>
endobj
3 0 obj
<< /Type /Page >>
endobj
trailer
<< /Info 2 0 R >>
%%EOF
"""

# No trailer /Info, only garbage /Author values: nothing trustworthy.
FIXTURE_PDF_GARBAGE = b"""%PDF-1.4
1 0 obj
<< /Type /Annot /Author (negul.d) >>
endobj
2 0 obj
<< /Type /Page >>
endobj
trailer
<< /Size 3 >>
%%EOF
"""

# Page-1 front matter with banner/affiliation noise around the author block.
PAGE1_NOISE = """Computer Methods and Programs in Biomedicine 273 (2026) 109078
Contents lists available at ScienceDirect
journal homepage: www.elsevier.com/locate/cmpb
Experience-guided multi-agent interpretable framework for
radiology report summarization
negul.d
Department of Radiology, Example University, Somewhere 12345
corresponding@example.org
Abstract
We summarize radiology reports.
"""


class AuthorMetadataTest(helpers.ResearchCase):
    def scan(self, pdf_bytes, page_text):
        path = os.path.join(self.dir, "fixture.pdf")
        with open(path, "wb") as f:
            f.write(pdf_bytes)
        with mock.patch.object(
            local_library, "extract_text", return_value=(page_text, None)
        ), mock.patch.object(local_library, "page_count", return_value=1):
            return local_library.scan_one(path)

    def test_regression_pdf_author_metadata_preferred(self):
        # The trailer-referenced Info dict names the document author; decoy
        # /Author bytes earlier in the file and page-1 noise must not win.
        rec = self.scan(FIXTURE_PDF, PAGE1_NOISE)
        self.assertEqual(rec["authors"], ["Jia Li"])
        # Unextractable case: garbage-only metadata plus noise text yields an
        # honest empty list, never a fabricated string like "negul.d".
        rec = self.scan(FIXTURE_PDF_GARBAGE, PAGE1_NOISE)
        self.assertEqual(rec["authors"], [])
        self.assertIn("authors_note", rec)

    def test_implausible_metadata_falls_back_to_text_author_line(self):
        # Publisher-stamped metadata is rejected; the name list between the
        # title block and the affiliation block is recovered instead.
        pdf = FIXTURE_PDF.replace(b"(Jia Li)", b"(Elsevier)")
        text = (
            "Experience-guided multi-agent interpretable framework for\n"
            "radiology report summarization\n"
            "Jia Li a,*, Tong Zhou b\n"
            "Department of Radiology, Example University\n"
            "Abstract\n"
        )
        rec = self.scan(pdf, text)
        self.assertEqual(rec["authors"], ["Jia Li", "Tong Zhou"])



IEEE_FRONT_MATTER = """2023 IEEE International Conference on Software Engineering (ICSE)
979-8-3503-0000-0/23 (c) 2023 IEEE
Proceedings of the 45th International Conference
Robustness Testing of Autonomous Driving Perception Modules
Wei Chen, Ana Souza
Abstract
We test perception modules.
"""


class TitleHeuristicsTest(helpers.ResearchCase):
    def test_banner_and_year_leading_lines_rejected(self):
        # IEEE/ACM banners and year-leading lines are stamped above the real
        # title; the first plausible non-banner line must win.
        title = local_library.title_from_text(IEEE_FRONT_MATTER)
        self.assertEqual(
            title, "Robustness Testing of Autonomous Driving Perception Modules"
        )

    def test_wrapped_title_joined_across_lines(self):
        # A title ending in a connector ("for") is mid-phrase: the next line is
        # a continuation even though it looks like a capitalized name list.
        text = (
            "Deep Learning Methods for\n"
            "Medical Image Segmentation\n"
            "John Smith, Jane Doe\n"
            "Abstract\n"
        )
        self.assertEqual(
            local_library.title_from_text(text),
            "Deep Learning Methods for Medical Image Segmentation",
        )

    def test_author_name_line_not_joined_to_complete_title(self):
        text = (
            "Experience Guided Frameworks in Radiology Reporting\n"
            "Daze Lu\n"
            "Abstract\n"
        )
        self.assertEqual(
            local_library.title_from_text(text),
            "Experience Guided Frameworks in Radiology Reporting",
        )

    def test_descriptive_filename_preferred_over_truncated_extraction(self):
        # The extracted title is a truncated prefix of the descriptive
        # filename: the de-slugified filename wins.
        stem = "Attention_Is_All_You_Need_Transformer_Architectures_For_Sequences"
        fname_title = local_library.title_from_filename(stem)
        self.assertEqual(
            fname_title,
            "Attention Is All You Need Transformer Architectures For Sequences",
        )
        self.assertTrue(local_library._prefer_filename_title(
            "Attention Is All You Need", fname_title))
        # A full extracted title is kept; the filename adds nothing.
        self.assertFalse(local_library._prefer_filename_title(
            "Attention Is All You Need Transformer Architectures For Sequences Model",
            fname_title))


class DoiTest(helpers.ResearchCase):
    def test_doi_extracted_and_trailing_punctuation_stripped(self):
        text = "As shown in prior work (https://doi.org/10.1016/j.cmpb.2025.109078)."
        self.assertEqual(local_library.doi_from_text(text),
                         "10.1016/j.cmpb.2025.109078")
        self.assertIsNone(local_library.doi_from_text("no identifier here"))


HTML_404 = b"""<!DOCTYPE html>
<html><head><title>404 Not Found</title></head>
<body><center><h1>404 Not Found</h1></center><hr><center>nginx</center></body>
</html>
"""


class NonPdfTest(helpers.ResearchCase):
    def test_html_saved_as_pdf_yields_extract_error_not_exception(self):
        # The corpus contains saved error pages named *.pdf; scanning one must
        # record extract_error and fall back to the filename, never raise.
        path = os.path.join(self.dir, "saved-landing-page.pdf")
        with open(path, "wb") as f:
            f.write(HTML_404)
        # Deterministic offline extraction: no pdftotext binary, no fitz.
        with mock.patch.object(shutil, "which", return_value=None), \
             mock.patch.dict(sys.modules, {"fitz": None}):
            rec = local_library.scan_one(path)
        self.assertIn("extract_error", rec)
        self.assertEqual(rec["title"], "saved landing page")
        self.assertEqual(rec["authors"], [])


class CorpusSmokeTest(helpers.ResearchCase):
    @unittest.skipUnless(helpers.CORPUS_PDFS, "no local corpus configured")
    def test_first_corpus_pdf_scans_without_crashing(self):
        rec = local_library.scan_one(helpers.CORPUS_PDFS[0])
        self.assertTrue(rec["title"])
        self.assertIsInstance(rec["authors"], list)

if __name__ == "__main__":
    unittest.main()
