# Generate golden fixtures for o200k_base / cl100k_base with Python tiktoken.
#
#   uv run --with tiktoken python tools/gen-openai-fixtures.py
#
# Emits fixtures/{o200k_base,cl100k_base}.json:
#   { "generator": str, "cases": [{ "text", "ids", "count" }] }

import json
import pathlib

import tiktoken

root = pathlib.Path(__file__).resolve().parent.parent
corpus = json.loads((root / "fixtures" / "corpus.json").read_text())

edge_cases = [
    # very long single piece (one letter run stresses the merge loop)
    "a" * 20000,
    "z" + "a" * 8191,
    # all 256 byte-ish codepoints U+0000..U+00FF (valid UTF-8 both sides)
    "".join(chr(i) for i in range(256)),
    # contraction casing (cl100k has case-insensitive suffix group up front)
    "It'S ODD THAT'S y'ALL'VE dOn'T CAN'T won'T",
    "'s 't 're 've 'm 'll 'd 'S 'T 'RE 'VE 'M 'LL 'D",
    # digit grouping \p{N}{1,3}
    "1 12 123 1234 12345 123456 1234567890123456789",
    "٠١٢٣٤٥٦٧٨٩ ०१२३४५६७८९",  # non-ASCII decimal digits
    # o200k punctuation rule swallows trailing slashes: [\r\n/]*
    "http:// a//b ///// -/\n\r\n//",
    "path/to/file.txt // comment /* block */",
    # whitespace boundary torture for \s+(?!\S) vs \s+
    "x   y",
    "x \t y  ",
    " \t\u000b\u000c\u00a0\u2028\u2029\u3000tail",
    "end   ",
    "\n\n\n",
    "\r\r\r\n\n \n\t\r\n x",
    # leading-symbol letter runs: [^\r\n\p{L}\p{N}]?\p{L}+
    "@word #tag $var %pct &amp *star",
    "_underscore __dunder__ mixed_Case_Words",
    # marks and titlecase (o200k [\p{Lu}\p{Lt}\p{Lm}\p{Lo}\p{M}] classes)
    "ǅungla Ǆ ǅ ǆ İstanbul ﬀ ﬁ",
    "e\u0301le\u0300ve a\u0308\u0301 x\u0e48\u0e49",
    # CJK / mixed scripts
    "中文English混排テスト한글1234",
    # emoji + ZWJ + variation selectors
    "👍🏽👨‍👩‍👧‍👦🇹🇷\ufe0f\u200d",
    # single chars
    "a",
    " ",
    "\t",
    "'",
    "\u00e9",
    "𝕏",
    # repeated punctuation runs
    "!!!???...,,,;;;:::" * 40,
    "=" * 3000,
    # long whitespace run (merge loop over space tokens)
    " " * 5000 + "x",
    " " * 4097,
]

texts = corpus + edge_cases

for name in ("o200k_base", "cl100k_base"):
    enc = tiktoken.get_encoding(name)
    cases = []
    for text in texts:
        ids = enc.encode_ordinary(text)
        cases.append({"text": text, "ids": ids, "count": len(ids)})
    out = {
        "generator": f"python tiktoken {tiktoken.__version__} {name} encode_ordinary",
        "cases": cases,
    }
    path = root / "fixtures" / f"{name}.json"
    path.write_text(json.dumps(out, ensure_ascii=False, indent=1) + "\n")
    print(f"{name}: {len(cases)} cases -> {path}")
