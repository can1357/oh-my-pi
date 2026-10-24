#!/usr/bin/env python3
"""Optional inline-image rendering for `paper_graph.py view --image`.

Pure stdlib: force-directed layout, software rasterizer, PNG encoder, and the
Kitty graphics protocol. Callers must treat any failure here as non-fatal and
fall back to the text view.
"""
import base64
import math
import os
import random
import struct
import sys
import zlib

WIDTH, HEIGHT = 880, 620
MARGIN = 40
BG = (255, 255, 255)
NODE = (30, 34, 48)
LABEL = (30, 34, 48)
EDGE_COLORS = {
    "cites": (68, 119, 221),
    "related": (68, 170, 102),
    "same-topic": (221, 136, 51),
}
# 3x5 digit glyphs for node index labels.
FONT = {
    "0": ("111", "101", "101", "101", "111"),
    "1": ("010", "110", "010", "010", "111"),
    "2": ("111", "001", "111", "100", "111"),
    "3": ("111", "001", "111", "001", "111"),
    "4": ("101", "101", "111", "001", "001"),
    "5": ("111", "100", "111", "001", "111"),
    "6": ("111", "100", "111", "101", "111"),
    "7": ("111", "001", "010", "010", "010"),
    "8": ("111", "101", "111", "101", "111"),
    "9": ("111", "101", "111", "001", "111"),
}


def kitty_available():
    """Heuristic: does this terminal advertise Kitty graphics support?"""
    if os.environ.get("KITTY_WINDOW_ID"):
        return True
    term = os.environ.get("TERM", "")
    if "kitty" in term or "ghostty" in term:
        return True
    return os.environ.get("TERM_PROGRAM", "") in ("WezTerm", "ghostty")


# ---------- layout ----------


def _layout(nodes, edges):
    """Fruchterman-Reingold-style spring layout, deterministic seed."""
    n = len(nodes)
    rng = random.Random(42)
    pos = {}
    for i, node in enumerate(nodes):
        angle = 2 * math.pi * i / max(n, 1)
        pos[node] = [
            math.cos(angle) + rng.uniform(-0.1, 0.1),
            math.sin(angle) + rng.uniform(-0.1, 0.1),
        ]
    if n <= 1:
        return pos
    k = 1.6 / math.sqrt(n)
    linked = [(e["src"], e["dst"]) for e in edges if e["src"] in pos and e["dst"] in pos]
    for it in range(80):
        disp = {node: [0.0, 0.0] for node in nodes}
        for i, a in enumerate(nodes):
            for b in nodes[i + 1 :]:
                dx = pos[a][0] - pos[b][0]
                dy = pos[a][1] - pos[b][1]
                d2 = dx * dx + dy * dy or 1e-6
                f = k * k / d2
                disp[a][0] += dx * f
                disp[a][1] += dy * f
                disp[b][0] -= dx * f
                disp[b][1] -= dy * f
        for a, b in linked:
            dx = pos[a][0] - pos[b][0]
            dy = pos[a][1] - pos[b][1]
            d = math.sqrt(dx * dx + dy * dy) or 1e-6
            f = d / k * 0.02
            disp[a][0] -= dx * f
            disp[a][1] -= dy * f
            disp[b][0] += dx * f
            disp[b][1] += dy * f
        temp = 0.1 * (1 - it / 80)
        for node in nodes:
            dx, dy = disp[node]
            d = math.sqrt(dx * dx + dy * dy) or 1e-6
            step = min(d, temp)
            pos[node][0] += dx / d * step
            pos[node][1] += dy / d * step
    return pos


def _to_screen(pos):
    xs = [p[0] for p in pos.values()]
    ys = [p[1] for p in pos.values()]
    span_x = (max(xs) - min(xs)) or 1.0
    span_y = (max(ys) - min(ys)) or 1.0
    out = {}
    for node, (x, y) in pos.items():
        sx = MARGIN + (x - min(xs)) / span_x * (WIDTH - 2 * MARGIN)
        sy = MARGIN + (y - min(ys)) / span_y * (HEIGHT - 2 * MARGIN)
        out[node] = (int(sx), int(sy))
    return out


# ---------- rasterizer ----------


def _put(buf, x, y, rgb):
    if 0 <= x < WIDTH and 0 <= y < HEIGHT:
        i = (y * WIDTH + x) * 3
        buf[i : i + 3] = bytes(rgb)


def _line(buf, x0, y0, x1, y1, rgb):
    dx, dy = abs(x1 - x0), -abs(y1 - y0)
    sx = 1 if x0 < x1 else -1
    sy = 1 if y0 < y1 else -1
    err = dx + dy
    while True:
        _put(buf, x0, y0, rgb)
        if x0 == x1 and y0 == y1:
            return
        e2 = 2 * err
        if e2 >= dy:
            err += dy
            x0 += sx
        if e2 <= dx:
            err += dx
            y0 += sy


def _circle(buf, cx, cy, r, rgb):
    for y in range(cy - r, cy + r + 1):
        for x in range(cx - r, cx + r + 1):
            if (x - cx) ** 2 + (y - cy) ** 2 <= r * r:
                _put(buf, x, y, rgb)


def _text(buf, x, y, s, rgb, scale=2):
    for ch in s:
        glyph = FONT.get(ch)
        if glyph:
            for gy, row in enumerate(glyph):
                for gx, bit in enumerate(row):
                    if bit == "1":
                        for oy in range(scale):
                            for ox in range(scale):
                                _put(buf, x + gx * scale + ox, y + gy * scale + oy, rgb)
        x += 4 * scale


def _png(buf):
    def chunk(tag, data):
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    stride = WIDTH * 3
    raw = b"".join(
        b"\x00" + bytes(buf[y * stride : (y + 1) * stride]) for y in range(HEIGHT)
    )
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", WIDTH, HEIGHT, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 6))
        + chunk(b"IEND", b"")
    )


# ---------- public API ----------


def render_png(papers, edges, adj):
    """Rasterize the (sub)graph. Returns (png_bytes, index) where index maps
    the small integer drawn next to each node back to its paper id."""
    nodes = sorted(papers, key=lambda pid: (-len(adj.get(pid, [])), pid))
    screen = _to_screen(_layout(nodes, edges))
    buf = bytearray(BG * (WIDTH * HEIGHT))
    for e in edges:
        a, b = screen.get(e["src"]), screen.get(e["dst"])
        if a and b:
            _line(buf, a[0], a[1], b[0], b[1], EDGE_COLORS.get(e["type"], NODE))
    index = []
    for i, pid in enumerate(nodes, start=1):
        x, y = screen[pid]
        r = min(5 + len(adj.get(pid, [])), 12)
        _circle(buf, x, y, r, NODE)
        _text(buf, x + r + 3, y - 5, str(i), LABEL)
        index.append((i, pid))
    return _png(buf), index


def emit_kitty(rendered):
    """Transmit a PNG inline via the Kitty graphics protocol; returns the node
    index legend so the caller can print id/title mappings below the image."""
    png, index = rendered
    payload = base64.standard_b64encode(png).decode("ascii")
    out = sys.stdout
    first = True
    while payload:
        head, payload = payload[:4096], payload[4096:]
        ctrl = "f=100,a=T," if first else ""
        m = 1 if payload else 0
        out.write(f"\x1b_G{ctrl}m={m};{head}\x1b\\")
        first = False
    out.write("\n")
    out.flush()
    return index
