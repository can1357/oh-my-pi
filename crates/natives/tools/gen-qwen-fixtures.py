# Generate fixtures/qwen3.json from the reference HF tokenizer.
# Run: uv run --with tokenizers tools/gen-qwen-fixtures.py
import json
import os
import unicodedata

from tokenizers import Tokenizer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
tok = Tokenizer.from_file(os.path.join(ROOT, "tools/cache/qwen3.8.tokenizer.json"))

with open(os.path.join(ROOT, "fixtures/corpus.json")) as f:
    texts = json.load(f)

# Family-specific edge cases.
texts += [
    # Merge-unreachable vocab entries as exact whole pieces (dead-rank
    # regression: HF never emits these ids; a naive rank table would).
    "毛泽东",
    "俱乐部",
    "全心全意为人民",
    "承担一切因您的行为而直接或间接",
    "足球俱乐部",
    "材料",  # reachable counterpart control
    # ...embedded mid-text
    "他研究毛泽东思想，加入足球俱乐部，去过新加坡和加拿大。",
    "众所周知，勤勤恳恳、兢兢业业，跃跃欲试。",
    "матри материал експерт",
    " експерт",
    "สังหาริมทรัพย์ มิถุนายน",
    "بسبب الأسبوع سبب",
    "Selanjutnya masyarakat terdapat",
    # Chinese-heavy
    "深度学习模型的训练需要大量的计算资源和高质量的数据集。近年来，随着硬件技术的飞速发展，大规模预训练语言模型在自然语言处理领域取得了突破性进展。",
    "白日依山尽，黄河入海流。欲穷千里目，更上一层楼。",
    "中华人民共和国全国人民代表大会常务委员会",
    "你好，世界！这是一个测试。２０２４年（全角数字）",
    # Digit runs: \p{N} is single-digit for Qwen (unlike cl100k's {1,3})
    "1234567890",
    "3.14159265358979",
    "電話番号は0123456789です",
    "١٢٣٤٥ ௧௨௩ ৪৫৬",  # Arabic-Indic, Tamil, Bengali digits
    "Ⅻ Ⅷ ½ ⅓ ①②③",  # Nl / No categories also match \p{N}
    "42nd 100th x1 x22 x333",
    # NFC regression: NFD inputs must normalize before splitting
    unicodedata.normalize("NFD", "naïve café résumé"),
    unicodedata.normalize("NFD", "한국어 텍스트"),
    unicodedata.normalize("NFD", "Ångström ế ộ"),
    "e\u0301\u0301clair",  # double combining acute (not fully composable)
    "\u1e0b\u0323 \u0064\u0323\u0307",  # ḋ+dot-below vs d+dot-below+dot-above (NFC reorders)
    # Contractions with (?i:...)
    "DON'T I'LL HE'S WE'RE THEY'VE I'M YOU'D",
    "don't i'll he's we're they've i'm you'd",
    "Mixed'S cAsE'Ll",
    "it'\u017f IT'S don'T x'Ll they'RE we'VE i'M you'D",  # U+017F long s folds into (?i:'s)
    "can't've y'all'll've",
    # Whitespace lookahead \s+(?!\S) boundaries
    "a  b   c    d",
    "end   ",
    "tabs\t\t\tthen  spaces \n  newline",
    "\n\n\n",
    "   ",
    # Marks: [^\r\n\p{L}\p{N}]?[\p{L}\p{M}]+ takes leading non-letter
    "$var _under #tag @user",
    "«guillemets» “curly” ‘quotes’",
    "ab\u0301c \u0301x combining",  # marks ride letter runs; lone mark after space-prefix
    "。汉字，测试！Ｑｗｅｎ全角ﬁﬂ",
    # \s*[\r\n]+ eats through the LAST newline of a whitespace run
    "x \r\n \n y",
    "a\r\nb\rc\nd",
    "para.\n\n  Indented after blank.\r\n\r\nEnd",
]

# Dedup, preserve order.
seen = set()
ordered = []
for t in texts:
    if t not in seen:
        seen.add(t)
        ordered.append(t)

cases = []
for text in ordered:
    ids = tok.encode(text, add_special_tokens=False).ids
    cases.append({"text": text, "ids": ids, "count": len(ids)})

out = {
    "generator": "tools/gen-qwen-fixtures.py: HF tokenizers Tokenizer.from_file(tools/cache/qwen3.8.tokenizer.json).encode(text, add_special_tokens=False)",
    "cases": cases,
}
with open(os.path.join(ROOT, "fixtures/qwen3.json"), "w") as f:
    json.dump(out, f, ensure_ascii=False, indent=1)
    f.write("\n")
print(f"{len(cases)} cases, total {sum(c['count'] for c in cases)} tokens")
