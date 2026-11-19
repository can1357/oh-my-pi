# /// script
# requires-python = ">=3.10"
# dependencies = ["pillow"]
# ///
"""Parity check: production Rust renderer vs the research PIL renderer.

For each newly renderable winner shape, renders the same normalized text with
both implementations and compares pixel classes (background / highlight band /
dim ink / colored ink) cell-exactly. Grid shapes go through `bdf.render`
verbatim; doc shapes use research `wrap()` (exp14) plus the contract's column
flow, so any drift in the production wrap/pagination/glyph placement shows up
as a pixel diff.

Usage:
  uv run parity_check.py            # all shapes, first frame, report
  uv run parity_check.py --keep     # also keep PNG pairs in ./.cache/parity
"""

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from bdf import FontCfg, _stopword_mask, capacity, load_font, render  # noqa: E402
from exp14_bestgpt import wrap  # noqa: E402

CACHE = HERE / ".cache"
PARITY = CACHE / "parity"
SIZE = 1568
GUTTER = 3

# (name, FontCfg, variant, columns, production Shape json)
SHAPES = [
    (
        "6x12-dim",
        FontCfg("6x12", "6x12", 6, 12),
        "dim",
        1,
        {
            "font": "6x12",
            "cellWidth": 6,
            "cellHeight": 12,
            "variant": "bw",
            "stopwordDim": True,
            "lineRepeat": 1,
            "frameSize": SIZE,
            "frameTokenEstimate": 3300,
        },
    ),
    (
        "8x13-bw",
        FontCfg("8x13", "8x13", 8, 13),
        "bw",
        1,
        {
            "font": "8x13",
            "cellWidth": 8,
            "cellHeight": 13,
            "variant": "bw",
            "lineRepeat": 1,
            "frameSize": SIZE,
            "frameTokenEstimate": 3300,
        },
    ),
    (
        "8on16-bw",
        FontCfg("8on16", "8x13", 8, 16),
        "bw",
        1,
        {
            "font": "8x13",
            "cellWidth": 8,
            "cellHeight": 16,
            "stretch": False,
            "variant": "bw",
            "lineRepeat": 1,
            "frameSize": SIZE,
            "frameTokenEstimate": 3300,
        },
    ),
    (
        "doc-8on16-bw",
        FontCfg("8on16", "8x13", 8, 16),
        "bw",
        2,
        {
            "font": "8x13",
            "cellWidth": 8,
            "cellHeight": 16,
            "stretch": False,
            "variant": "bw",
            "columns": 2,
            "lineRepeat": 1,
            "frameSize": SIZE,
            "frameTokenEstimate": 3300,
        },
    ),
    (
        "doc-8on16-sent-dim",
        FontCfg("8on16", "8x13", 8, 16),
        "sent-dim",
        2,
        {
            "font": "8x13",
            "cellWidth": 8,
            "cellHeight": 16,
            "stretch": False,
            "variant": "sent",
            "columns": 2,
            "stopwordDim": True,
            "lineRepeat": 1,
            "frameSize": SIZE,
            "frameTokenEstimate": 3300,
        },
    ),
]

# Pixel classes: both renderers must agree on the CLASS of every pixel.
# Exact dim grays differ by design (research 176 vs production 128); hues and
# black must match exactly, so they classify by exact value.
_DIM_GRAYS = {(176, 176, 176), (128, 128, 128), (104, 104, 104)}
_BG = {(255, 255, 255)}
_BAND = {(255, 247, 194)}


def classify(px: tuple[int, int, int]) -> tuple:
    if px in _BG:
        return ("bg",)
    if px in _BAND:
        return ("band",)
    if px in _DIM_GRAYS:
        return ("dim",)
    return ("ink", px)


def sentence_text_for_doc(flow: str, cfg: FontCfg) -> str:
    """First production page: research wrap + contract pagination."""
    cols, rows, _ = capacity(cfg, SIZE)
    col_w = (cols - GUTTER) // 2
    lines = wrap(flow, col_w)
    return "\n".join(lines[: 2 * rows])


def render_research(flow: str, cfg: FontCfg, variant: str, columns: int) -> Image.Image:
    if columns == 1:
        _, _, cap = capacity(cfg, SIZE)
        return render(flow[:cap], cfg, CACHE, SIZE, variant)
    # Doc: draw research-wrapped lines with bdf glyphs per the contract flow.
    glyphs, font_ascent = load_font(cfg, CACHE)
    ascent = cfg.ascent if cfg.ascent is not None else font_ascent
    cols, rows, _ = capacity(cfg, SIZE)
    col_w = (cols - GUTTER) // 2
    lines = wrap(flow, col_w)[: 2 * rows]
    joined = "\n".join(lines)
    # Sentence indices across the joined page (terminator + space|newline).
    sent_idx, idx = [], 0
    for i, ch in enumerate(joined):
        sent_idx.append(idx)
        if ch in ".!?" and i + 1 < len(joined) and joined[i + 1] in " \n":
            idx += 1
    dim_mask = _stopword_mask(joined) if "dim" in variant else None
    from bdf import _BLACK, _DARK, _DIMMED, _WHITE  # noqa: E402

    img = Image.new("RGB", (SIZE, SIZE), _WHITE)
    px = img.load()
    pos = 0
    for li, line in enumerate(lines):
        column, row = divmod(li, rows)
        x_origin = column * (col_w + GUTTER) * cfg.adv
        y0 = row * cfg.pitch
        for ci, ch in enumerate(line):
            i = pos + ci
            glyph = glyphs.get(ord(ch))
            if glyph is None:
                continue
            if dim_mask is not None and dim_mask[i]:
                fg = _DIMMED
            elif variant.startswith("sent"):
                fg = _DARK[sent_idx[i] % 6]
            else:
                fg = _BLACK
            w, h, xoff, yoff = glyph["bbx"]
            top = y0 + ascent - h - yoff
            shift = 0x80 if w <= 8 else 0x8000
            for r, bits in enumerate(glyph["rows"]):
                y = top + r
                if not 0 <= y < SIZE:
                    continue
                for b in range(w):
                    if bits & (shift >> b):
                        x = x_origin + ci * cfg.adv + xoff + b
                        if 0 <= x < SIZE:
                            px[x, y] = fg
        pos += len(line) + 1
    return img


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--keep", action="store_true", help="keep PNG pairs in .cache/parity"
    )
    args = ap.parse_args()
    PARITY.mkdir(parents=True, exist_ok=True)

    # Deterministic ASCII corpus with punctuation: this repo's own prose,
    # normalized the way production normalizes (whitespace runs -> one space).
    corpus = (HERE / "bdf.py").read_text() + " " + (HERE / "run.py").read_text()
    flow = re.sub(r"\s+", " ", corpus).strip()

    text_file = PARITY / "flow.txt"
    text_file.write_text(flow)

    failures = 0
    for name, cfg, variant, columns, shape in SHAPES:
        ref = render_research(flow, cfg, variant, columns)
        out_png = PARITY / f"{name}.prod.png"
        proc = subprocess.run(
            [
                "bun",
                str(HERE / "parity_render.ts"),
                str(text_file),
                json.dumps(shape),
                str(out_png),
            ],
            capture_output=True,
            text=True,
        )
        if proc.returncode != 0:
            print(f"FAIL {name}: production render errored:\n{proc.stderr.strip()}")
            failures += 1
            continue
        got = Image.open(out_png).convert("RGB")
        # Production clips frame height to the rows actually printed; the
        # reference renders the full square. Compare the printed region
        # pixel-exact and require everything below it to be blank.
        if got.width != ref.width or got.height > ref.height:
            print(
                f"FAIL {name}: size {got.size} incompatible with reference {ref.size}"
            )
            failures += 1
            continue
        rpx, gpx = ref.load(), got.load()
        diffs, first = 0, None
        for y in range(ref.height):
            for x in range(ref.width):
                if y < got.height:
                    if classify(rpx[x, y]) != classify(gpx[x, y]):
                        diffs += 1
                        if first is None:
                            first = (x, y, rpx[x, y], gpx[x, y])
                elif classify(rpx[x, y]) != ("bg",):
                    diffs += 1
                    if first is None:
                        first = (x, y, rpx[x, y], "clipped")
        if diffs:
            print(f"FAIL {name}: {diffs} differing pixels; first at {first}")
            ref.save(PARITY / f"{name}.ref.png")
            failures += 1
        else:
            print(f"OK   {name}")
            if args.keep:
                ref.save(PARITY / f"{name}.ref.png")
            else:
                out_png.unlink(missing_ok=True)
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
