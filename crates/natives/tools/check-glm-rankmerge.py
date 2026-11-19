# One-off: does tiktoken rank-based byte_pair_merge match HF merges-list
# BPE for GLM-5 on non-whole-piece inputs? Compares a simulated rank
# merge against the reference on adversarial and random pieces.
# Usage: uv run --with tokenizers tools/check-glm-rankmerge.py

import json
import random
from pathlib import Path

from tokenizers import Tokenizer

ROOT = Path(__file__).resolve().parent.parent
tok = Tokenizer.from_file(str(ROOT / "tools/cache/glm-5.tokenizer.json"))
tj = json.loads((ROOT / "tools/cache/glm-5.tokenizer.json").read_text())


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
ranks = {}
for key, rank in tj["model"]["vocab"].items():
    ranks[bytes(INV[c] for c in key)] = rank


def rank_encode_piece(piece: bytes) -> list[int]:
    if piece in ranks:
        return [ranks[piece]]
    parts = list(range(len(piece) + 1))
    def pr(i):
        if i + 2 >= len(parts):
            return 1 << 60
        return ranks.get(piece[parts[i]:parts[i + 2]], 1 << 60)
    while len(parts) > 2:
        best, bi = 1 << 60, -1
        for i in range(len(parts) - 2):
            r = ranks.get(piece[parts[i]:parts[i + 2]], 1 << 60)
            if r < best:
                best, bi = r, i
        if bi < 0:
            break
        del parts[bi + 1]
    return [ranks[piece[parts[i]:parts[i + 1]]] for i in range(len(parts) - 1)]


# Adversarial: probe tokens extended so the whole piece is OOV.
rare = "龘"
adversarial = [" 参考" + rare, " 参考资料" + rare, " 而" + rare, " 者" + rare, " 王" + rare,
               "参考文献列表", " 参考文献综述汇编", rare + " 参考"]
random.seed(42)
cjk = [chr(c) for c in range(0x4E00, 0x9FFF, 7)]
rand = ["".join(random.choices(cjk, k=random.randint(2, 8))) for _ in range(3000)]
words = ["Übermensch", "naïveté", "переосмысление", "🎉🎊", "ﬃﬄ", "supercalifragilistic"]

bad = 0
for text in adversarial + rand + words:
    ref = tok.encode(text, add_special_tokens=False).ids
    # simulate: pretokenize via the real tokenizer's offsets? use single-piece
    # texts only (pure CJK/letter runs stay one piece under the GLM regex).
    sim = rank_encode_piece(text.encode("utf-8"))
    if sim != ref:
        bad += 1
        if bad <= 10:
            print(f"MISMATCH {text!r}\n  ref={ref}\n  sim={sim}")
print(f"checked {len(adversarial) + len(rand) + len(words)}, mismatches: {bad}")
