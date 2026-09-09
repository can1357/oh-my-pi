"""BDF/HEX pixel-font parsing and dense text-to-image rendering."""

import colorsys
import urllib.request
from dataclasses import dataclass
from pathlib import Path

from PIL import Image

XORG_RAW = "https://gitlab.freedesktop.org/xorg/font/misc-misc/-/raw/master/{name}.bdf"
TOM_THUMB = "https://robey.lag.net/downloads/tom-thumb.bdf"
UNSCII_HEX = (
    "https://raw.githubusercontent.com/viznut/unscii/master/fontfiles/{name}.hex"
)


@dataclass(frozen=True)
class FontCfg:
    """One density configuration: a BDF font drawn on an adv x pitch cell grid."""

    name: str  # condition label, e.g. "6x10"
    source: str  # bdf file stem or "tom-thumb"
    adv: int  # x advance per character cell, px
    pitch: int  # y advance per row, px
    ascent: int | None = None  # override; default from FONT_ASCENT
    native: tuple[int, int] | None = (
        None  # rasterize at this cell size, then resize (stretch) to adv x pitch
    )
    repeat: int = 1  # render each text line this many times (copy 0 plain, later copies bg-highlighted)


def ensure_font(cfg: FontCfg, cache: Path) -> Path:
    hexfont = cfg.source.startswith("unscii")
    path = cache / f"{cfg.source}.{'hex' if hexfont else 'bdf'}"
    if not path.exists():
        if hexfont:
            url = UNSCII_HEX.format(name=cfg.source)
        else:
            url = (
                TOM_THUMB
                if cfg.source == "tom-thumb"
                else XORG_RAW.format(name=cfg.source)
            )
        urllib.request.urlretrieve(url, path)
    return path


def parse_bdf(path: Path) -> tuple[dict[int, dict], int]:
    """Returns ({codepoint: {bbx, rows}}, font_ascent)."""
    glyphs: dict[int, dict] = {}
    ascent = 0
    cur: dict = {}
    lines = path.read_text().splitlines()
    i = 0
    while i < len(lines):
        ln = lines[i]
        if ln.startswith("FONT_ASCENT"):
            ascent = int(ln.split()[1])
        elif ln.startswith("STARTCHAR"):
            cur = {"rows": []}
        elif ln.startswith("ENCODING"):
            cur["enc"] = int(ln.split()[1])
        elif ln.startswith("BBX"):
            cur["bbx"] = tuple(map(int, ln.split()[1:5]))
        elif ln.startswith("BITMAP"):
            i += 1
            while not lines[i].startswith("ENDCHAR"):
                cur["rows"].append(int(lines[i], 16))
                i += 1
            glyphs[cur["enc"]] = cur
        i += 1
    return glyphs, ascent


def parse_hex(path: Path) -> tuple[dict[int, dict], int]:
    """Unifont-style .hex (unscii-8: 8x8, one byte per row). Baseline at row 7."""
    glyphs: dict[int, dict] = {}
    for line in path.read_text().splitlines():
        cp, _, bits = line.partition(":")
        data = bytes.fromhex(bits.strip())
        if len(data) == 8:
            glyphs[int(cp, 16)] = {"bbx": (8, 8, 0, -1), "rows": list(data)}
    return glyphs, 7


def load_font(cfg: FontCfg, cache: Path) -> tuple[dict[int, dict], int]:
    path = ensure_font(cfg, cache)
    return parse_hex(path) if path.suffix == ".hex" else parse_bdf(path)


# 6 hues; dark variant for glyphs, pale variant for the row's background band.
_HUES = [0.0, 0.08, 0.3, 0.5, 0.62, 0.78]
_DARK = [tuple(int(c * 255) for c in colorsys.hls_to_rgb(h, 0.22, 0.95)) for h in _HUES]
_PALE = [tuple(int(c * 255) for c in colorsys.hls_to_rgb(h, 0.94, 0.6)) for h in _HUES]
_BRIGHT = [
    tuple(int(c * 255) for c in colorsys.hls_to_rgb(h, 0.70, 0.95)) for h in _HUES
]

VARIANTS = (
    "color",
    "zebra",
    "bw",
    "sent",
    "dark",
    "dark-sent",
    "dim",
    "sent-dim",
    "dark-sent-dim",
)
_BLACK = (0, 0, 0)
_WHITE = (255, 255, 255)
_GRAY = (232, 232, 232)
_DIMMED = (176, 176, 176)
_DIMMED_DARK = (104, 104, 104)
_REP_LIGHT = (255, 247, 194)  # pale yellow highlight for repeated-line copies
_REP_DARK = (44, 44, 24)

# High-frequency function words a reader can reconstruct from context; the dim
# variants render them in light gray so content words carry the contrast.
_STOPWORDS = frozenset(
    "the a an and or of to in on at as is are was were be been by for with that this it its from had has have not but "
    "he she his her they their them which also who whom when where while will would could should there then than "
    "into over under about after before between during each such these those some most more other only same so".split()
)


def _row_palette(
    variant: str, row: int
) -> tuple[tuple[int, int, int], tuple[int, int, int]]:
    """(background, default glyph) colors for a row under the given render variant."""
    if variant == "color":
        return _PALE[row % 6], _DARK[row % 6]
    if variant == "zebra":
        return (_WHITE if row % 2 == 0 else _GRAY), _BLACK
    if variant in ("bw", "sent", "dim", "sent-dim"):
        return _WHITE, _BLACK
    if variant in ("dark", "dark-sent", "dark-sent-dim"):
        return _BLACK, _WHITE
    raise ValueError(f"unknown variant: {variant}")


def _sentence_indices(text: str) -> list[int]:
    """Running sentence index per character (boundary: terminator + space)."""
    out = [0] * len(text)
    idx = 0
    for i, ch in enumerate(text):
        out[i] = idx
        if ch in ".!?" and i + 1 < len(text) and text[i + 1] == " ":
            idx += 1
    return out


def _stopword_mask(text: str) -> list[bool]:
    """True for every character of a word in _STOPWORDS."""
    mask = [False] * len(text)
    i = 0
    while i < len(text):
        if text[i].isalpha():
            j = i
            while j < len(text) and text[j].isalpha():
                j += 1
            if text[i:j].lower() in _STOPWORDS:
                for k in range(i, j):
                    mask[k] = True
            i = j
        else:
            i += 1
    return mask


def capacity(cfg: FontCfg, size: int = 1568, columns: int = 1) -> tuple[int, int, int]:
    """(cols per line, rows, chars) that fit a size x size image with `columns` newspaper columns."""
    rows = size // cfg.pitch // cfg.repeat
    gutter = 2 * cfg.adv if columns > 1 else 0
    cols = (size - (columns - 1) * gutter) // columns // cfg.adv
    return cols, rows, columns * cols * rows


def render(
    text: str,
    cfg: FontCfg,
    cache: Path,
    size: int = 1568,
    variant: str = "color",
    columns: int = 1,
) -> Image.Image:
    """Fill a size x size grid with `text`; styling per `variant`.

    Layout: full-width row-major when columns == 1; otherwise newspaper flow
    (fill the leftmost column top-to-bottom, then the next), columns separated
    by a 2-cell gutter with a hairline rule.

    When cfg.native is set, glyphs are rasterized at the native cell size and
    the whole canvas is Lanczos-resized to the adv x pitch target (anisotropic
    stretch: anti-aliased, no cropping or ink fusion).

    Variants:
      color      per-row hue cycle on pale row bands
      zebra      black text, alternating white/gray bands
      bw         black on white
      sent       white background, glyph hue cycles per sentence
      dark       white text on black
      dark-sent  bright sentence hues on black
      dim        black on white, stopwords dimmed gray
      sent-dim   sentence hues, stopwords dimmed gray
      dark-sent-dim  bright sentence hues on black, stopwords dimmed
    """
    glyphs, font_ascent = load_font(cfg, cache)
    ascent = cfg.ascent if cfg.ascent is not None else font_ascent
    cols, rows, cap = capacity(cfg, size, columns)
    text = text[:cap]
    sent_idx = (
        _sentence_indices(text)
        if variant in ("sent", "dark-sent", "sent-dim", "dark-sent-dim")
        else None
    )
    dim_mask = (
        _stopword_mask(text)
        if variant in ("dim", "sent-dim", "dark-sent-dim")
        else None
    )
    sent_palette = _BRIGHT if variant in ("dark-sent", "dark-sent-dim") else _DARK
    dark_bg = variant in ("dark", "dark-sent", "dark-sent-dim")
    base_color = _BLACK if dark_bg else _WHITE
    if cfg.native is not None:
        aw, ph = cfg.native
        gutter = 2 * aw if columns > 1 else 0
        span = cols * aw + gutter
        canvas_w, canvas_h = columns * span - gutter, rows * cfg.repeat * ph
    else:
        aw, ph = cfg.adv, cfg.pitch
        gutter = 2 * aw if columns > 1 else 0
        span = cols * aw + gutter
        canvas_w = canvas_h = size
    img = Image.new("RGB", (canvas_w, canvas_h), base_color)
    px = img.load()
    for row in range(rows):
        bg, row_fg = _row_palette(variant, row)
        for copy in range(cfg.repeat):
            y0 = (row * cfg.repeat + copy) * ph
            cbg = bg if copy == 0 else (_REP_DARK if dark_bg else _REP_LIGHT)
            for y in range(y0, min(y0 + ph, canvas_h)):
                for x in range(canvas_w):
                    px[x, y] = cbg
            for blk in range(columns):
                for col in range(cols):
                    i = (blk * rows + row) * cols + col
                    if i >= len(text):
                        break
                    glyph = glyphs.get(ord(text[i]))
                    if glyph is None:
                        continue
                    fg = row_fg
                    if sent_idx is not None:
                        fg = sent_palette[sent_idx[i] % 6]
                    if dim_mask is not None and dim_mask[i]:
                        fg = _DIMMED_DARK if dark_bg else _DIMMED
                    w, h, xoff, yoff = glyph["bbx"]
                    top = y0 + ascent - h - yoff
                    shift = 0x80 if w <= 8 else 0x8000
                    for r, bits in enumerate(glyph["rows"]):
                        y = top + r
                        if not 0 <= y < canvas_h:
                            continue
                        for b in range(w):
                            if bits & (shift >> b):
                                x = blk * span + col * aw + xoff + b
                                if 0 <= x < canvas_w:
                                    px[x, y] = fg
    rule = (96, 96, 96) if dark_bg else (204, 204, 204)
    for blk in range(1, columns):
        x = blk * span - gutter // 2
        if 0 <= x < canvas_w:
            for y in range(canvas_h):
                px[x, y] = rule
    if cfg.native is not None:
        img = img.resize(
            (canvas_w * cfg.adv // aw, canvas_h * cfg.pitch // ph), Image.LANCZOS
        )
    if img.size != (size, size):
        out = Image.new("RGB", (size, size), base_color)
        out.paste(img, (0, 0))
        img = out
    return img
