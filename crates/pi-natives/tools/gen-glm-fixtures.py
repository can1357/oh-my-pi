# Generate fixtures/glm5.json from the reference HF tokenizers runtime.
# Also hunts ignore_merges divergence probes: vocab tokens whose plain
# merge-loop encode (ignore_merges=False) differs from the whole-piece
# vocab hit (ignore_merges=True), proving the short-circuit is load-bearing.
#
# Usage: uv run --with tokenizers tools/gen-glm-fixtures.py

import json
from pathlib import Path

from tokenizers import Tokenizer

ROOT = Path(__file__).resolve().parent.parent
TOK_JSON = ROOT / "tools/cache/glm-5.tokenizer.json"

tok = Tokenizer.from_file(str(TOK_JSON))

# Variant with ignore_merges disabled, for probe hunting only.
tj = json.loads(TOK_JSON.read_text())
assert tj["model"]["ignore_merges"] is True
tj["model"]["ignore_merges"] = False
noim_path = ROOT / "tools/cache/glm-5.no-ignore-merges.json"
noim_path.write_text(json.dumps(tj))
tok_noim = Tokenizer.from_file(str(noim_path))

# GPT-2 byte-level alphabet, inverted (unicode char -> byte).
def unicode_to_bytes():
    bs = list(range(ord("!"), ord("~") + 1)) + list(range(0xA1, 0xAD)) + list(range(0xAE, 0x100))
    cs = bs[:]
    n = 0
    for b in range(256):
        if b not in bs:
            bs.append(b)
            cs.append(256 + n)
            n += 1
    return {chr(c): b for c, b in zip(cs, bs)}

INV = unicode_to_bytes()
vocab = tj["model"]["vocab"]

# Hunt probes: multi-char vocab tokens that decode to valid UTF-8 text,
# survive pretokenization as a single piece (encode length 1 under
# ignore_merges), but merge to something else without the flag.
probes = []
for key, rank in vocab.items():
    if len(key) < 2:
        continue
    try:
        text = bytes(INV[c] for c in key).decode("utf-8")
    except (KeyError, UnicodeDecodeError):
        continue
    ids = tok.encode(text, add_special_tokens=False).ids
    if ids != [rank]:
        continue  # pretokenizer splits it; not a whole-piece case
    ids_noim = tok_noim.encode(text, add_special_tokens=False).ids
    if ids_noim != ids:
        probes.append((text, rank, ids_noim))
        if len(probes) >= 5:
            break

print(f"ignore_merges probes found: {len(probes)}")
for text, rank, noim in probes:
    print(f"  {text!r}: with={rank} without={noim}")
assert probes, "no ignore_merges divergence found — short-circuit unproven"

corpus = json.loads((ROOT / "fixtures/corpus.json").read_text())
extra = [
    # Chinese samples
    "智谱清言是由北京智谱华章科技有限公司开发的大语言模型。",
    "你好，世界！这是一个测试。",
    "人工智能正在改变世界，深度学习模型的参数规模不断增长。",
    "中英文混排 mixed CJK and English 123 数字。",
    "　全角空格和标点符号：《引号》、【括号】——破折号……省略号",
]
# Probes verbatim, plus OOV extensions: the piece is no longer a whole-vocab
# hit, so the merge loop must run and still match the reference around the
# unreachable substrings.
probe_texts = [t for t, _, _ in probes]
probe_texts += [t + "龘" for t, _, _ in probes]
probe_texts += ["龘" + t for t, _, _ in probes]

cases = []
for text in corpus + extra + probe_texts:
    enc = tok.encode(text, add_special_tokens=False)
    cases.append({"text": text, "ids": enc.ids, "count": len(enc.ids)})

out = {
    "generator": "uv run --with tokenizers tools/gen-glm-fixtures.py (tokenizers reference, add_special_tokens=False)",
    "cases": cases,
}
(ROOT / "fixtures/glm5.json").write_text(json.dumps(out, ensure_ascii=False, indent=1) + "\n")
noim_path.unlink()
print(f"wrote {len(cases)} cases to fixtures/glm5.json")
