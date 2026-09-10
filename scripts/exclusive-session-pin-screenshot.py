#!/usr/bin/env python3
"""Render exclusive session pin demo PNG via tmux layout + Pillow."""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

REPO = Path(__file__).resolve().parents[1]
OUT = REPO / "docs" / "screenshots" / "exclusive-session-pin-demo.png"
BUN = os.environ.get("BUN", "/Users/ultra/.bun/bin/bun.zig-1.3.14.bak")
TS_DEMO = REPO / "scripts" / "exclusive-session-pin-demo.ts"

# Dark terminal palette (Catppuccin Mocha-ish)
BG = (30, 30, 46)
PANEL_BG = (24, 24, 37)
BORDER = (69, 71, 90)
TITLE = (166, 173, 200)
TEXT = (205, 214, 244)
DIM = (108, 112, 134)
PROMPT = (137, 180, 250)
COMMAND = (166, 227, 161)
ACCENT = (250, 179, 135)
HIGHLIGHT = (243, 139, 168)
SUCCESS = (166, 227, 161)
FONT_PATH = "/System/Library/Fonts/SFNSMono.ttf"
FONT_SIZE = 16
LINE_HEIGHT = 22
PAD = 16
PANEL_GAP = 12


def run_demo_outputs() -> dict:
    proc = subprocess.run(
        [BUN, "run", str(TS_DEMO)],
        cwd=REPO,
        capture_output=True,
        text=True,
        stdin=subprocess.DEVNULL,
        timeout=120,
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr[-4000:] or proc.stdout)
    return json.loads(proc.stdout)


def pane_lines(session_label: str, commands: list[tuple[str, str]]) -> list[tuple[str, str | None]]:
    """Return (text, style) rows for one pane."""
    rows: list[tuple[str, str | None]] = [
        (session_label, "title"),
        ("", None),
        ("omp · anthropic/claude-sonnet-4", "dim"),
        ("", None),
    ]
    for cmd, output in commands:
        rows.append((f"> {cmd}", "prompt"))
        rows.append(("", None))
        for line in output.splitlines():
            style = None
            if "(active, exclusive)" in line:
                style = "success"
            elif "(exclusive to another session)" in line:
                style = "highlight"
            elif "Pinned" in line and "exclusively" in line:
                style = "success"
            elif "exclusively pinned by another session" in line:
                style = "highlight"
            rows.append((line, style))
        rows.append(("", None))
    return rows


def load_font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    try:
        return ImageFont.truetype(FONT_PATH, size)
    except OSError:
        return ImageFont.load_default()


def color_for(style: str | None) -> tuple[int, int, int]:
    return {
        "title": TITLE,
        "dim": DIM,
        "prompt": PROMPT,
        "command": COMMAND,
        "accent": ACCENT,
        "highlight": HIGHLIGHT,
        "success": SUCCESS,
    }.get(style or "", TEXT)


def measure_panel(rows: list[tuple[str, str | None]], font: ImageFont.ImageFont, width: int) -> int:
    return PAD * 2 + len(rows) * LINE_HEIGHT


def draw_panel(
    base: Image.Image,
    origin: tuple[int, int],
    size: tuple[int, int],
    title: str,
    rows: list[tuple[str, str | None]],
    font: ImageFont.ImageFont,
) -> None:
    x, y = origin
    w, h = size
    draw = ImageDraw.Draw(base)
    draw.rounded_rectangle((x, y, x + w, y + h), radius=10, fill=PANEL_BG, outline=BORDER, width=1)
    draw.text((x + PAD, y + PAD - 2), title, font=font, fill=TITLE)
    cy = y + PAD + LINE_HEIGHT
    for text, style in rows[1:]:
        if not text:
            cy += LINE_HEIGHT // 2
            continue
        fill = color_for(style)
        draw.text((x + PAD, cy), text, font=font, fill=fill)
        cy += LINE_HEIGHT


def setup_tmux(session: str, left: str, right: str) -> None:
    subprocess.run(["tmux", "kill-session", "-t", session], stderr=subprocess.DEVNULL)
    subprocess.run(["tmux", "new-session", "-d", "-s", session, "-x", "120", "-y", "40"], check=True)
    subprocess.run(["tmux", "split-window", "-h", "-t", session], check=True)
    subprocess.run(["tmux", "send-keys", "-t", f"{session}:1.2", left, "Enter"], check=True)
    subprocess.run(["tmux", "send-keys", "-t", f"{session}:1.2", right, "Enter"], check=True)
    time.sleep(0.2)


def render_png(data: dict, out_path: Path) -> None:
    font = load_font(FONT_SIZE)
    left_rows = pane_lines(
        "Session 1 — project-a",
        [
            ("/session pin 2 --exclusive", data["session1_pin"]),
            ("/session pin", data["session1_list"]),
        ],
    )
    right_rows = pane_lines(
        "Session 2 — project-b",
        [
            ("/session pin", data["session2_list"]),
            ("/session pin 2 --exclusive", data["session2_try"]),
        ],
    )
    panel_w = 620
    left_h = measure_panel(left_rows, font, panel_w)
    right_h = measure_panel(right_rows, font, panel_w)
    panel_h = max(left_h, right_h) + 8
    img_w = PAD * 2 + panel_w * 2 + PANEL_GAP
    img_h = PAD * 2 + panel_h + 36
    img = Image.new("RGB", (img_w, img_h), BG)
    draw = ImageDraw.Draw(img)
    draw.text((PAD, PAD), "Exclusive session pin — two concurrent OMP sessions, shared auth store", font=font, fill=TITLE)
    draw_panel(img, (PAD, PAD + 30), (panel_w, panel_h), left_rows[0][0], left_rows, font)
    draw_panel(img, (PAD + panel_w + PANEL_GAP, PAD + 30), (panel_w, panel_h), right_rows[0][0], right_rows, font)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    img.save(out_path, optimize=True)
    print(out_path)


def main() -> int:
    data = run_demo_outputs()
    session = "omp-exclusive-pin-demo"
    try:
        setup_tmux(session, "/session pin 2 --exclusive", "/session pin")
    except subprocess.CalledProcessError as error:
        print(f"tmux demo skipped: {error}", file=sys.stderr)
    try:
        render_png(data, OUT)
    finally:
        subprocess.run(["tmux", "kill-session", "-t", session], stderr=subprocess.DEVNULL)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
