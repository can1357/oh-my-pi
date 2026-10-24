#!/usr/bin/env python3
"""Scan a local PDF corpus into JSON-lines records, or extract full text from one PDF.

Stdlib only. Text extraction prefers `pdftotext` (poppler) when on PATH, then
PyMuPDF (`fitz`) when importable, then a built-in metadata-only fallback that
reads the PDF /Title. A scan never crashes on a bad PDF: the record is emitted
with whatever fields resolved plus an "extract_error" field.
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from refs_io import norm_authors

SUBPROCESS_TIMEOUT = 60  # seconds per file; one bad PDF must not hang a scan
ABSTRACT_CAP = 4000
DOI_RE = re.compile(r"10\.\d{4,9}/\S+")
YEAR_RE = re.compile(r"\b(19|20)\d{2}\b")
# Letters of "abstract"/"keywords" may be letter-spaced (Elsevier: "a b s t r a c t").
ABSTRACT_RE = re.compile(r"(?i)^\s*a\s*b\s*s\s*t\s*r\s*a\s*c\s*t\b[\s:.\u2013\u2014-]*")
STOP_RE = re.compile(
    r"(?i)^\s*(k\s*e\s*y\s*w\s*o\s*r\s*d\s*s?\b|index terms\b|ccs concepts\b"
    r"|acm reference|[1i]\s*[.)]?\s*introduction\b|introduction\s*$|1\s*[.)]\s)"
)
KEYWORDS_RE = re.compile(r"(?i)^\s*k\s*e\s*y\s*w\s*o\s*r\s*d\s*s?\b")
# Front-matter noise that must not be mistaken for a title line.
TITLE_SKIP_RE = re.compile(
    r"(?i)^(arxiv[:.]|doi[:\s]|10\.\d{4,9}/|https?://|www\.|received\b|accepted\b"
    r"|published\b|available online|contents lists|sciencedirect|elsevier|springer"
    r"|proceedings of\b|journal of\b|vol\.?\s*\d|volume\s*\d|issn|isbn|\u00a9|copyright"
    r"|licens|open access|preprint|research article|original article|citation:)"
    r"|.*\d+\s*\(\d{4}\)\s*\d+"
)
# Conference/journal banner lines stamped above the real title (IEEE/ACM/Springer
# front matter, running heads). Searched anywhere in the line, unlike TITLE_SKIP_RE.
BANNER_RE = re.compile(
    r"(?i)(?:^\s*(?:19|20)\d{2}\b"
    r"|international conference|conference on|conference \(|proceedings of"
    r"|\bieee\b|\bacm\b|workshop on|symposium|international journal|journal of"
    r"|journal homepage|contents lists|sciencedirect|authorized licensed use"
    r"|isbn|issn|\bdoi\s*:|\u00a9|978-\d|peer[\s-]*review)"
)
# Affiliation vocabulary; a title candidate containing these is author front matter.
AFFIL_RE = re.compile(
    r"(?i)\b(university|institute|department|college|school of|laboratory"
    r"|faculty|academy|hospital of|centers?|centres?|co\.,?\s*ltd)\b"
)
# A title ending in one of these (or trailing punctuation) is mid-sentence: the
# next line is a wrapped continuation even if it looks like a name list.
TITLE_CONNECTORS = frozenset(
    "a an the and or of for with via to in on by from based using through toward towards".split()
)


def norm_ws(s):
    return re.sub(r"\s+", " ", s or "").strip()


def slugify(s):
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


# ---------- text extraction chain ----------


def text_pdftotext(path, first=None, last=None):
    cmd = ["pdftotext"]
    if first:
        cmd += ["-f", str(first)]
    if last:
        cmd += ["-l", str(last)]
    cmd += ["-enc", "UTF-8", path, "-"]
    r = subprocess.run(cmd, capture_output=True, timeout=SUBPROCESS_TIMEOUT)
    if r.returncode != 0:
        raise RuntimeError(
            f"pdftotext exit {r.returncode}: {r.stderr.decode('utf-8', 'replace')[:200]}"
        )
    return r.stdout.decode("utf-8", "replace")


def text_fitz(path, first=None, last=None):
    import fitz  # PyMuPDF; optional

    doc = fitz.open(path)
    try:
        lo = (first or 1) - 1
        hi = min(last or doc.page_count, doc.page_count)
        return "\n".join(doc[i].get_text() for i in range(lo, hi))
    finally:
        doc.close()


def extract_text(path, first=None, last=None):
    """Return (text, error). error is None on success; text is "" on total failure."""
    errors = []
    if shutil.which("pdftotext"):
        try:
            return text_pdftotext(path, first, last), None
        except subprocess.TimeoutExpired:
            errors.append(f"pdftotext timeout after {SUBPROCESS_TIMEOUT}s")
        except Exception as e:  # noqa: BLE001 - any failure falls through the chain
            errors.append(str(e)[:200])
    try:
        return text_fitz(path, first, last), None
    except ImportError:
        errors.append("fitz not importable")
    except Exception as e:  # noqa: BLE001
        errors.append(f"fitz: {str(e)[:200]}")
    return "", "; ".join(errors) or "no extractor available"


# ---------- built-in PDF metadata fallback (stdlib only) ----------


def _decode_pdf_string(b):
    if b[:2] == b"\xfe\xff":
        return b[2:].decode("utf-16-be", "replace")
    out = bytearray()
    i = 0
    escapes = {0x6E: 0x0A, 0x72: 0x0D, 0x74: 0x09, 0x62: 0x08, 0x66: 0x0C}
    while i < len(b):
        c = b[i]
        if c == 0x5C and i + 1 < len(b):  # backslash escape
            nxt = b[i + 1]
            if nxt in escapes:
                out.append(escapes[nxt])
                i += 2
            elif nxt in (0x28, 0x29, 0x5C):  # ( ) \
                out.append(nxt)
                i += 2
            elif 0x30 <= nxt <= 0x37:  # octal, up to 3 digits
                j = i + 1
                while j < len(b) and j < i + 4 and 0x30 <= b[j] <= 0x37:
                    j += 1
                out.append(int(b[i + 1 : j], 8) & 0xFF)
                i = j
            else:
                i += 1  # unknown escape / line continuation: drop backslash
        else:
            out.append(c)
            i += 1
    return out.decode("latin-1", "replace")


def _pdf_string_values(raw, key):
    """All decoded string values following /<key> in the raw bytes."""
    values = []
    start = 0
    needle = b"/" + key
    while True:
        idx = raw.find(needle, start)
        if idx < 0:
            break
        i = idx + len(needle)
        while i < len(raw) and raw[i] in b" \r\n\t":
            i += 1
        if i >= len(raw):
            break
        if raw[i] == 0x28:  # literal string (...)
            depth = 1
            j = i + 1
            buf = bytearray()
            while j < len(raw) and depth > 0:
                c = raw[j]
                if c == 0x5C and j + 1 < len(raw):
                    buf += raw[j : j + 2]
                    j += 2
                    continue
                if c == 0x28:
                    depth += 1
                elif c == 0x29:
                    depth -= 1
                    if depth == 0:
                        break
                buf.append(c)
                j += 1
            values.append(_decode_pdf_string(bytes(buf)))
        elif raw[i] == 0x3C:  # hex string <...>
            end = raw.find(b">", i)
            if end > i:
                hexed = re.sub(rb"\s", b"", raw[i + 1 : end])
                try:
                    values.append(_decode_pdf_string(bytes.fromhex(hexed.decode("ascii"))))
                except ValueError:
                    pass
        start = idx + len(needle)
    return [norm_ws(v) for v in values if norm_ws(v)]


def _info_author(raw):
    """/Author from the trailer-referenced Info dict only.

    Raw-byte scans see every /Author in the file — annotation authors and
    embedded documents included — so the first match is often garbage from a
    figure or attachment. The trailer's /Info reference names the one dict
    that describes the document itself; later trailers win (incremental
    updates append).
    """
    for num, gen in reversed(re.findall(rb"/Info\s+(\d+)\s+(\d+)\s+R", raw)):
        m = re.search(
            rb"(?:^|[\r\n>])" + num + rb"\s+" + gen + rb"\s+obj\b", raw
        )
        if not m:
            continue
        end = raw.find(b"endobj", m.end())
        obj = raw[m.end() : end if end > 0 else m.end() + 4096]
        authors = _pdf_string_values(obj, b"Author")
        if authors:
            return authors[0]
    return None


def pdf_meta(raw):
    """{title, author, year} from raw PDF bytes; any value may be None.

    Regex-level scan, not a real PDF parser: misses Info dicts inside compressed
    object streams, which is acceptable for a last-resort fallback.
    """
    titles = _pdf_string_values(raw, b"Title")
    # Multiple /Title keys occur (outlines etc.); the longest is usually the doc title.
    title = max(titles, key=len) if titles else None
    author = _info_author(raw)
    if not plausible_meta_author(author):
        author = next(
            (a for a in _pdf_string_values(raw, b"Author") if plausible_meta_author(a)),
            None,
        )
    year = None
    for key in (b"CreationDate", b"ModDate"):
        for v in _pdf_string_values(raw, key):
            m = re.search(r"(19|20)\d{2}", v)
            if m:
                year = int(m.group(0))
                break
        if year:
            break
    return {"title": title, "author": author, "year": year}


def page_count(path, raw):
    if shutil.which("pdfinfo"):
        try:
            r = subprocess.run(
                ["pdfinfo", path], capture_output=True, timeout=SUBPROCESS_TIMEOUT
            )
            m = re.search(rb"^Pages:\s+(\d+)", r.stdout, re.M)
            if m:
                return int(m.group(1))
        except Exception:  # noqa: BLE001
            pass
    try:
        import fitz

        doc = fitz.open(path)
        try:
            return doc.page_count
        finally:
            doc.close()
    except Exception:  # noqa: BLE001
        pass
    n = len(re.findall(rb"/Type\s*/Page[^s]", raw))
    return n or None


# ---------- field heuristics ----------


def plausible_meta_title(title, stem):
    t = norm_ws(title or "")
    if len(t) <= 15:
        return False
    if BANNER_RE.search(t):
        return False
    if re.search(r"(?i)\.(pdf|dvi|docx?|tex|indd|eps|ps)\b", t):
        return False
    if re.match(r"(?i)^(microsoft (word|powerpoint)|untitled|type of the paper|doi[:\s]|https?://|10\.\d{4,9}/)", t):
        return False
    if slugify(t) == slugify(stem):
        return False  # metadata just echoes the filename
    letters = sum(ch.isalpha() for ch in t)
    return letters >= len(t) * 0.5


PUBLISHER_RE = re.compile(
    r"(?i)^(elsevier|ieee|springer|acm|wiley|mdpi|taylor\s*&\s*francis|sage"
    r"|nature|frontiers|admin(istrator)?|user|owner|author|unknown)$"
)
# Venue or role strings that masquerade as capitalized name lists.
VENUE_ROLE_RE = re.compile(r"(?i)\b(society|annual meeting|editor(ial)?s?)\b")



def plausible_meta_author(author):
    """Metadata /Author worth trusting: same banner discipline as titles."""
    a = norm_ws(author or "")
    if len(a) < 4:
        return False
    if "@" in a or re.search(r"(?i)https?://|www\.|10\.\d{4,9}/", a):
        return False
    if re.search(r"(?i)\.(pdf|dvi|docx?|tex|indd|eps|ps)\b", a):
        return False
    if BANNER_RE.search(a) or PUBLISHER_RE.match(a):
        return False
    if ":" in a or VENUE_ROLE_RE.search(a):
        return False  # venue or role string ("Associate Editor: ..."), not a person
    if re.fullmatch(r"[A-Z][A-Z\d]+", a):
        return False  # journal/venue acronym ("IJLTEMAS")
    if not re.search(r"[A-Z]", a):
        return False  # tooling usernames: "negul.d", "rajesh"
    letters = sum(ch.isalpha() for ch in a)
    return letters >= len(a) * 0.5


def _authorish(line):
    """Author/affiliation front matter: emails, superscript markers, name lists."""
    if "@" in line or re.search(r"[*\u2020\u2021\u2217]|\(B\)", line):
        return True
    if AFFIL_RE.search(line):
        return True
    # Superscript-annotated names: "Kai Chen1 , Ji Qi2", "Chendan Liang1,3,4".
    if re.search(r"[A-Za-z]\d", line) and re.search(r"\d\s*[,*\u2020\u2021\u2217]|\d$", line):
        return True
    return bool(re.search(r"\d\s*,\s*[\d*]|\d,\s+[A-Z]", line))


def _name_word(w):
    if re.fullmatch(r"[A-Z]\.", w):
        return True  # middle initial, as in "Duy H. Ho"
    return len(w) >= 2 and w[0].isupper() and w[1:].islower()


def _looks_name_list(line):
    words = line.replace(",", " ").split()
    return 2 <= len(words) <= 4 and all(_name_word(w) for w in words)


NAME_PARTICLES = frozenset("van von der den de la le del bin ibn ter da di".split())


def _is_person_name(n):
    words = n.split()
    if not 2 <= len(words) <= 5 or len(n) < 4:
        return False
    return all(_name_word(w) or w in NAME_PARTICLES for w in words)


def authors_from_text(text, title):
    """Author names from page-1 front matter; [] when nothing is trustworthy.

    Only runs below a located title line: the author block sits between the
    title and the abstract/affiliation block. An honest empty list beats a
    fabricated string, so every rejection here falls through to [].
    """
    ts = slugify(title or "")
    if len(ts) < 10:
        return []
    lines = [norm_ws(line) for line in text.splitlines() if norm_ws(line)]
    start = None
    for i, line in enumerate(lines[:40]):
        ls = slugify(line)
        if len(ls) >= 10 and ls in ts:
            start = i + 1  # keep advancing past wrapped title lines
        elif start is not None:
            break
    if start is None:
        return []
    for line in lines[start : start + 8]:
        if ABSTRACT_RE.match(line) or STOP_RE.match(line):
            break
        if len(line) < 4 or "@" in line:
            continue
        if re.search(r"(?i)https?://|www\.|contents lists available", line):
            continue
        if BANNER_RE.search(line) or AFFIL_RE.search(line) or "journal" in line.lower():
            continue
        if ":" in line or VENUE_ROLE_RE.search(line):
            continue  # "Associate Editor: ...", "... Society Annual Meeting"
        if sum(c.isdigit() for c in line) > len(line) * 0.2:
            continue  # digits-heavy affiliation/citation text
        # Strip superscript markers: "Jia Li a,*, Tong Zhou b" / "Kai Chen1".
        cand = re.sub(r"[\d*\u2020\u2021\u2217]+", " ", line)
        cand = re.sub(r"(?<=[\s,])[a-z](?=[\s,]|$)", " ", cand)
        names = [
            norm_ws(p)
            for chunk in cand.split(",")
            for p in re.split(r"\s+and\s+", chunk)
            if norm_ws(p)
        ]
        if names and all(_is_person_name(n) for n in names):
            return names
    return []


def _dangling(title):
    """Title ends mid-phrase, so the next line must be a wrapped continuation."""
    t = title.rstrip()
    if t.endswith((":", ";", ",", "-", "\u2013", "\u2014")):
        return True
    last = re.sub(r"[^\w'-]+$", "", t.rsplit(None, 1)[-1]).lower() if t else ""
    return last in TITLE_CONNECTORS


def _join_wrapped_title(title, following):
    """Append wrapped title lines until author/abstract front matter starts."""
    if title.endswith((".", "?", "!")):
        return title
    for line in following:
        if len(title) > 300:
            break
        forced = _dangling(title)
        if ABSTRACT_RE.match(line) or STOP_RE.match(line):
            break
        if TITLE_SKIP_RE.match(line) or BANNER_RE.search(line):
            break
        if _authorish(line) or line.count(",") >= 2:
            break
        if not forced and _looks_name_list(line):
            break  # "Daze Lu" — an author name, not a continuation
        letters = sum(c.isalpha() for c in line)
        if not (3 <= len(line) <= 200 and letters >= len(line) * 0.55):
            break
        title = f"{title} {line}"
        if line.endswith((".", "?", "!")):
            break
    return title


def title_from_text(text):
    lines = [norm_ws(line) for line in text.splitlines()]
    lines = [line for line in lines if line]
    for i, line in enumerate(lines[:40]):
        if ABSTRACT_RE.match(line):
            break  # ran past the title zone
        if TITLE_SKIP_RE.match(line) or BANNER_RE.search(line):
            continue
        if "journal" in line.lower() and len(line.split()) <= 6:
            continue  # journal name banner, not a title
        if _authorish(line) or line.isupper():
            continue  # authors, or an all-caps running head
        letters = sum(c.isalpha() for c in line)
        if (
            20 <= len(line) <= 250
            and len(line.split()) >= 3
            and letters >= len(line) * 0.55
        ):
            return _join_wrapped_title(line, lines[i + 1 : i + 4])
    return None


def _titleish(t):
    return (
        len(t) >= 25
        and len(t.split()) >= 4
        and sum(c.isalpha() for c in t) >= len(t) * 0.5
        and not BANNER_RE.search(t)
    )


def _prefer_filename_title(title, fname_title):
    """These corpora often have descriptive filenames; use them over weak extractions."""
    if not _titleish(fname_title):
        return False
    if BANNER_RE.search(title):
        return True
    if len(title) < 25 and len(fname_title) > len(title):
        return True
    # Extracted title is a truncated prefix/fragment of the descriptive filename.
    ts, fs = slugify(title), slugify(fname_title)
    return bool(ts) and len(fs) > len(ts) and ts in fs


def title_from_filename(stem):
    t = re.sub(r"\s*\(\d+\)\s*$", "", stem)  # trailing " (1)" copy marker
    if "_" in t:
        # Underscores are the word separator; hyphens are real ("Multi-Agent").
        return norm_ws(t.replace("_", " "))
    return norm_ws(re.sub(r"[\s\-]+", " ", t))


STRUCTURED_START_RE = re.compile(
    r"(?i)^\s*(background|objectives?|purpose|aims?)( and objectives?)?\s*:"
)


def abstract_from_text(text):
    lines = text.splitlines()
    start = None
    remainder = ""
    for i, line in enumerate(lines):
        m = ABSTRACT_RE.match(line)
        if m:
            start = i + 1
            remainder = line[m.end() :]
            break
    if start is None:
        # Structured abstract without an "Abstract" heading (Background: ... Key words:).
        for i, line in enumerate(lines[:80]):
            if STRUCTURED_START_RE.match(line):
                start = i
                break
    if start is None:
        return ""
    parts = [remainder] if norm_ws(remainder) else []
    i = start
    while i < len(lines):
        line = lines[i]
        if STOP_RE.match(line):
            # Two-column front matter interleaves the Keywords block between the
            # abstract heading and its body; skip past it (to its blank line) when
            # no real abstract text has been collected yet.
            if KEYWORDS_RE.match(line) and sum(len(p) for p in parts) < 200:
                i += 1
                while i < len(lines) and norm_ws(lines[i]):
                    i += 1
                continue
            break
        parts.append(line)
        if sum(len(p) for p in parts) > ABSTRACT_CAP * 2:
            break
        i += 1
    return norm_ws(" ".join(parts))[:ABSTRACT_CAP]


def doi_from_text(text):
    m = DOI_RE.search(text)
    if not m:
        return None
    return m.group(0).rstrip(".,;:)]}\"'")


def year_from(meta, text):
    if meta.get("year"):
        return meta["year"]
    first_page = text.split("\f", 1)[0] if text else ""
    for m in YEAR_RE.finditer(first_page):
        y = int(m.group(0))
        if 1900 <= y <= 2035:
            return y
    return None


# ---------- subcommands ----------


def scan_one(path):
    stem = os.path.splitext(os.path.basename(path))[0]
    rec = {
        "source": "local",
        "id": slugify(stem),
        "path": os.path.abspath(path),
        "title": None,
        "authors": [],
        "year": None,
        "doi": None,
        "abstract": "",
        "pages": None,
    }
    try:
        with open(path, "rb") as f:
            raw = f.read()
    except OSError as e:
        rec["title"] = title_from_filename(stem)
        rec["extract_error"] = f"read failed: {e}"
        return rec

    meta = {}
    try:
        meta = pdf_meta(raw)
    except Exception as e:  # noqa: BLE001
        rec["extract_error"] = f"metadata parse failed: {str(e)[:200]}"

    text, err = extract_text(path, first=1, last=3)
    if err:
        rec["extract_error"] = err

    try:
        if plausible_meta_title(meta.get("title"), stem):
            rec["title"] = meta["title"]
        else:
            rec["title"] = title_from_text(text) or title_from_filename(stem)
        fname_title = title_from_filename(stem)
        if _prefer_filename_title(rec["title"], fname_title):
            rec["title"] = fname_title
        if plausible_meta_author(meta.get("author")):
            rec["authors"] = norm_authors(meta.get("author"))
        else:
            rec["authors"] = norm_authors(authors_from_text(text, rec["title"]))
        if not rec["authors"]:
            rec["authors_note"] = "no plausible author extracted"
        rec["year"] = year_from(meta, text)
        rec["doi"] = doi_from_text(text)
        rec["abstract"] = abstract_from_text(text)
        rec["pages"] = page_count(path, raw)
    except Exception as e:  # noqa: BLE001 - never crash a scan on one bad PDF
        rec.setdefault("extract_error", f"field extraction failed: {str(e)[:200]}")
        if not rec["title"]:
            rec["title"] = title_from_filename(stem)
    return rec


def cmd_scan(args):
    if not os.path.isdir(args.dir):
        print(f"local_library: not a directory: {args.dir}", file=sys.stderr)
        sys.exit(1)
    names = sorted(
        n for n in os.listdir(args.dir) if n.lower().endswith(".pdf")
    )
    if args.max:
        names = names[: args.max]
    for name in names:
        rec = scan_one(os.path.join(args.dir, name))
        print(json.dumps(rec, ensure_ascii=False))
        sys.stdout.flush()


def cmd_extract(args):
    if not os.path.isfile(args.path):
        print(f"local_library: no such file: {args.path}", file=sys.stderr)
        sys.exit(1)
    text, err = extract_text(args.path)
    if err and not text:
        print(f"local_library: extraction failed: {err}", file=sys.stderr)
        sys.exit(1)
    out = {
        "source": "local",
        "path": os.path.abspath(args.path),
        "chars": len(text),
        "truncated": len(text) > args.max_chars,
        "text": text[: args.max_chars],
    }
    print(json.dumps(out, ensure_ascii=False))


def main():
    ap = argparse.ArgumentParser(
        description="Local PDF corpus scanner. One JSON object per line."
    )
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("scan", help="scan a directory of PDFs into candidate records")
    p.add_argument("--dir", required=True)
    p.add_argument("--max", type=int, help="scan at most N PDFs (sorted by filename)")
    p.set_defaults(fn=cmd_scan)

    p = sub.add_parser("extract", help="full text of one PDF for full-text screening")
    p.add_argument("--path", required=True)
    p.add_argument("--max-chars", type=int, default=200000)
    p.set_defaults(fn=cmd_extract)

    args = ap.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
