# Generate fixtures/deepseek3.json from the cached HF tokenizer.
#
# Usage: uv run --with tokenizers tools/gen-deepseek-fixtures.py
import json
import pathlib

from tokenizers import Tokenizer

ROOT = pathlib.Path(__file__).resolve().parent.parent
tok = Tokenizer.from_file(str(ROOT / "tools/cache/deepseek-v4.tokenizer.json"))
# encode_ordinary semantics: special added tokens present verbatim in the
# input must be split as plain text (pure BPE), never emitted as their ids.
# Required for the dead-entry probes below; a no-op for every other case.
tok.encode_special_tokens = True

corpus = json.loads((ROOT / "fixtures/corpus.json").read_text())

edge_cases = [
    # Split-chain interaction: digits then CJK then latin.
    "abc123def一二三ghi",
    # 4+ digit numbers straddle the \p{N}{1,3} boundary.
    "1234",
    "12345 678901 3.14159265358979",
    "2024-08-19T12:34:56.789Z",
    "10000000 tokens cost $0.00042",
    "一2三45六789零 第123章 第1234章",
    # CJK runs incl. hiragana/katakana block edges (぀-ゟ, ゠-ヿ).
    "深度求索发布了新一代基座模型，性能大幅提升。",
    "こんにちは世界！カタカナ・テストです。",
    "ゟ゠ヿ",
    "中文English日本語한국어mixed",
    # Punctuation-prefix-letters alternate ([!"#$%&'()*+,\-./...][A-Za-z]+).
    ".NET",
    ".NET Framework 4.8",
    "(foo)",
    "(int)x + (float)y",
    "#include <stdio.h>",
    "#pragma once",
    "[foo]bar {baz}qux",
    "@user mentioned ~home and $PATH",
    "a.b.c e.g. i.e. etc.",
    "'quoted' \"double\" `backtick`",
    "C++ -O2 --flag=value",
    "_underscore __dunder__",
    # Whitespace lookahead \s+(?!\S) edges.
    "word   \nnext  ",
    "  leading and trailing  ",
    # Dead-entry probes: the three merge-unreachable sentinels (ids 0..2)
    # written out verbatim must tokenize as plain text — never as their
    # ids (they are blanked in the packed table).
    "<｜begin▁of▁sentence｜>",
    "<｜end▁of▁sentence｜>hello<｜▁pad▁｜>",
]

texts = corpus + edge_cases
cases = []
for text in texts:
    ids = tok.encode(text, add_special_tokens=False).ids
    assert not any(i < 3 for i in ids), f"sentinel id leaked into reference: {text!r}"
    cases.append({"text": text, "ids": ids, "count": len(ids)})

# V3 parity: encode one sample with the actual DeepSeek-V3 tokenizer
# (downloaded once into tools/cache/) and assert it matches V4 — the base
# BPE is identical across V3..V4.
PARITY_TEXT = "DeepSeek V3参数量6710亿, released 2024-12-26. (fn)main一二三"
v3_path = ROOT / "tools/cache/deepseek-v3.tokenizer.json"
if not v3_path.exists():
    import urllib.request

    url = "https://huggingface.co/deepseek-ai/DeepSeek-V3/resolve/main/tokenizer.json"
    with urllib.request.urlopen(url) as resp:
        v3_path.write_bytes(resp.read())
v3 = Tokenizer.from_file(str(v3_path))
v3.encode_special_tokens = True
v3_ids = v3.encode(PARITY_TEXT, add_special_tokens=False).ids
v4_ids = tok.encode(PARITY_TEXT, add_special_tokens=False).ids
assert v3_ids == v4_ids, f"V3/V4 drift on parity sample: {v3_ids} != {v4_ids}"

out = {
    "generator": "uv run --with tokenizers tools/gen-deepseek-fixtures.py (tokenizers, cache/deepseek-v4.tokenizer.json, add_special_tokens=False, encode_special_tokens=True)",
    "cases": cases,
    "v3_parity": {"text": PARITY_TEXT, "ids": v3_ids, "count": len(v3_ids)},
}
(ROOT / "fixtures/deepseek3.json").write_text(
    json.dumps(out, ensure_ascii=False, indent=1) + "\n"
)
print(f"wrote {len(cases)} cases")
