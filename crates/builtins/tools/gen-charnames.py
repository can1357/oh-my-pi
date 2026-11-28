#!/usr/bin/env python3
"""Regenerates src/perl/charnames.zst: the Unicode 13.0 character names (the
UCD perl 5.34 ships) behind perl's \\N{NAME} and charnames.

Usage: python3 tools/gen-charnames.py UnicodeData.txt NameAliases.txt
(both from https://www.unicode.org/Public/13.0.0/ucd/; Python 3.14+).

Each line of the compressed text is one record:
  N<hex>;<name>              a UnicodeData.txt name
  A<hex>;<alias>             a NameAliases.txt alias
  R<first>;<last>;<prefix>   a range named <prefix><hex code point>
Hangul syllable names are algorithmic and computed by the reader.
"""

import pathlib
import sys
from compression import zstd

RANGE_PREFIXES = {
    "CJK Ideograph": "CJK UNIFIED IDEOGRAPH-",
    "Tangut Ideograph": "TANGUT IDEOGRAPH-",
}


def records(unicode_data: str, name_aliases: str):
    first = None
    with open(unicode_data, encoding="utf-8") as rows:
        for row in rows:
            code, name = row.split(";", 2)[:2]
            if name.endswith(", First>"):
                first = code
            elif name.endswith(", Last>"):
                label = name[1 : -len(", Last>")]
                prefix = next((p for k, p in RANGE_PREFIXES.items() if label.startswith(k)), None)
                if prefix:
                    yield f"R{first};{code};{prefix}"
            elif not name.startswith("<"):
                yield f"N{code};{name}"
    with open(name_aliases, encoding="utf-8") as rows:
        for row in rows:
            row = row.strip()
            if row and not row.startswith("#"):
                code, alias, _kind = row.split(";")
                yield f"A{code};{alias}"


def main() -> None:
    unicode_data, name_aliases = sys.argv[1:3]
    text = "".join(f"{record}\n" for record in records(unicode_data, name_aliases))
    out = pathlib.Path(__file__).resolve().parents[1] / "src/perl/charnames.zst"
    out.write_bytes(zstd.compress(text.encode(), level=19))


if __name__ == "__main__":
    main()
