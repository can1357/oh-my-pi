# Generate fixtures/kimi_k2.json with reference tiktoken.
# Usage: uv run --with tiktoken --with blobfile tools/gen-kimi-fixtures.py
import json
from pathlib import Path

import tiktoken
from tiktoken.load import load_tiktoken_bpe

ROOT = Path(__file__).resolve().parent.parent

pat_str = "|".join([
    r"""[\p{Han}]+""",
    r"""[^\r\n\p{L}\p{N}]?[\p{Lu}\p{Lt}\p{Lm}\p{Lo}\p{M}&&[^\p{Han}]]*[\p{Ll}\p{Lm}\p{Lo}\p{M}&&[^\p{Han}]]+(?i:'s|'t|'re|'ve|'m|'ll|'d)?""",
    r"""[^\r\n\p{L}\p{N}]?[\p{Lu}\p{Lt}\p{Lm}\p{Lo}\p{M}&&[^\p{Han}]]+[\p{Ll}\p{Lm}\p{Lo}\p{M}&&[^\p{Han}]]*(?i:'s|'t|'re|'ve|'m|'ll|'d)?""",
    r"""\p{N}{1,3}""",
    r""" ?[^\s\p{L}\p{N}]+[\r\n]*""",
    r"""\s*[\r\n]+""",
    r"""\s+(?!\S)""",
    r"""\s+""",
])

ranks = load_tiktoken_bpe(str(ROOT / "tools/cache/kimi.tiktoken.model"))
assert len(ranks) == 163_584, len(ranks)
enc = tiktoken.Encoding(name="kimi", pat_str=pat_str, mergeable_ranks=ranks, special_tokens={})

corpus = json.loads((ROOT / "fixtures/corpus.json").read_text())

extra = [
    # Han-heavy text.
    "中文分词是自然语言处理的基础任务之一。月之暗面发布了千亿参数模型。",
    "汉字漢字汉字漢字",
    # Mixed Han/Latin/digits with Han-adjacent case turns.
    "中文English中文",
    "中文english中文ENGLISH中文",
    "GPT4发布于2023年3月14日,共有1750亿个参数。",
    "深度学习deep learning模型model需要大量GPU资源,如A100或H100。",
    "价格是99.99元,折扣为8.5折。",
    # Han next to apostrophe contractions and case boundaries.
    "他说:'It's fine'然后离开了。",
    "中文Word中文WORD中文word",
    # Kana/Hangul (non-Han CJK) beside Han.
    "日本語テスト中文한국어",
    # Han with whitespace runs and newlines.
    "第一行\n第二行\r\n  第三行\t结束",
    "中文 English 中文  English   中文",
    # Long digit runs (\p{N}{1,3} chunking) and non-ASCII digits.
    "12345678901234567890",
    "١٢٣٤٥٦٧٨٩٠ ๑๒๓ 一二三",
    # Marks (\p{M}) adjacent to Han and Latin.
    "éé中文éé e\u0301\u0301中文",
    # Punctuation runs absorbing trailing newlines.
    "foo!!!\n\nbar???\r\n",
    # Leading-space letter runs and lookahead tail.
    "   trailing spaces   ",
    " 中文 a 中文 A1中文",
]

texts = corpus + extra
cases = []
for text in texts:
    ids = enc.encode_ordinary(text)
    cases.append({"text": text, "ids": ids, "count": len(ids)})

out = {
    "generator": f"tiktoken {tiktoken.__version__} Encoding(kimi, tokenization_kimi.py pat_str) encode_ordinary",
    "cases": cases,
}
(ROOT / "fixtures/kimi_k2.json").write_text(json.dumps(out, ensure_ascii=False, indent=1) + "\n")
print(f"{len(cases)} cases, total {sum(c['count'] for c in cases)} tokens")
