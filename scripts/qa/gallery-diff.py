#!/usr/bin/env python3
"""Compare omp tool-gallery sections with captured TypeScript-reference output.

Spinner phase is normalized away on both sides before comparing. Live tool
cards animate the `status` spinner (twelve nerd glyphs, eight braille glyphs,
four ASCII spokes) on a shared 80 ms clock, so the glyph a capture holds is
whatever phase the reference gallery had when it froze (edit shows frame 2,
apply_patch frame 4, eval frame 3) while omp's gallery renders at t=0
(frame 0). Both are the same animation observed at different instants, so every
status-spinner glyph — and only those glyphs — maps to one token; everything
else compares byte for byte. The ASCII spokes (`| / - \\`) are deliberately not
normalized: the gallery renders the nerd tier, so they never appear as spinner
frames, while they do appear as ordinary text (paths, rules) whose differences
must stay visible.
"""
from __future__ import annotations
import argparse, difflib, os, pathlib, re, subprocess, sys
ROOT = pathlib.Path(__file__).resolve().parents[2]
REF = pathlib.Path(__file__).resolve().parent / "fixtures" / "gallery"
STATUS_SPINNER = "".join(chr(c) for c in range(0xF144B, 0xF1457)) + "⣾⣽⣻⢿⡿⣟⣯⣷"
SPINNER_GLYPH = re.compile("[" + re.escape(STATUS_SPINNER) + "]")
SGR = re.compile(r"\x1b\[([0-9;]*)m")
OSC8 = re.compile(r"\x1b\]8;[^;\x1b]*;([^\x1b]*)\x1b\\")
DEFAULT_STYLE = (None, None, False, False, False, False, False, False, False)

def normalize(line: str) -> str:
    """Collapse every status-spinner glyph to one token."""
    return SPINNER_GLYPH.sub("\u2400", line)

def ansi_cells(line: str) -> tuple[tuple[str, tuple[object, ...]], ...]:
    """Decode terminal styling into visible characters with effective semantics.

    Reset ordering, redundant resets, adjacent-span merging, and environment-
    specific OSC 8 targets are intentionally erased. The comparison remains
    strict about whether a cell is linked and about its foreground, background,
    bold/dim/italic/underline/strike/inverse attributes.
    """
    style = list(DEFAULT_STYLE)
    cells: list[tuple[str, tuple[object, ...]]] = []
    cursor = 0
    while cursor < len(line):
        if line.startswith("\x1b]8;", cursor):
            match = OSC8.match(line, cursor)
            if match is not None:
                style[8] = bool(match.group(1))
                cursor = match.end()
                continue
        match = SGR.match(line, cursor)
        if match is None:
            cells.append((normalize(line[cursor]), tuple(style)))
            cursor += 1
            continue
        codes = [int(value) if value else 0 for value in match.group(1).split(";")]
        index = 0
        while index < len(codes):
            code = codes[index]
            index += 1
            if code == 0:
                style[:] = DEFAULT_STYLE
            elif code == 1:
                style[2] = True
            elif code == 2:
                style[3] = True
            elif code == 3:
                style[4] = True
            elif code == 4:
                style[5] = True
            elif code == 7:
                style[7] = True
            elif code == 9:
                style[6] = True
            elif code == 22:
                style[2] = False
                style[3] = False
            elif code == 23:
                style[4] = False
            elif code == 24:
                style[5] = False
            elif code == 27:
                style[7] = False
            elif code == 29:
                style[6] = False
            elif code in (38, 48) and index < len(codes):
                channel = 0 if code == 38 else 1
                mode = codes[index]
                index += 1
                if mode == 2 and index + 2 < len(codes):
                    style[channel] = tuple(codes[index:index + 3])
                    index += 3
                elif mode == 5 and index < len(codes):
                    style[channel] = ("index", codes[index])
                    index += 1
            elif code == 39:
                style[0] = None
            elif code == 49:
                style[1] = None
            elif 30 <= code <= 37 or 90 <= code <= 97:
                style[0] = ("ansi", code)
            elif 40 <= code <= 47 or 100 <= code <= 107:
                style[1] = ("ansi", code)
        cursor = match.end()
    while cells and cells[-1] == (" ", DEFAULT_STYLE):
        cells.pop()
    return tuple(cells)

def split(text: str) -> dict[str, list[str]]:
    out: dict[str, list[str]] = {}
    key = None
    for line in text.splitlines():
        m = re.match(r"^── ([a-z0-9_]+)", SGR.sub("", line))
        if m:
            key = m.group(1); out[key] = [line.rstrip()]
        elif key:
            out[key].append(line.rstrip())
    return out

def render(expanded: bool, tools: list[str], ansi: bool = False) -> dict[str, list[str]]:
    binary = os.environ.get("OMP_GALLERY_BIN")
    cmd = (
        [binary, "gallery", "--surface", "tool", "--width", "100"]
        if binary
        else ["cargo","run","-q","-p","omp-app","--bin","omp","--","gallery","--surface","tool","--width","100"]
    )
    if not ansi:
        cmd.append("--plain")
    if len(tools) == 1:
        cmd.extend(["--tool", tools[0]])
    if expanded: cmd.append("--expanded")
    rendered = split(subprocess.check_output(cmd, cwd=ROOT, text=True))
    return rendered if not tools else {key: value for key, value in rendered.items() if key in tools}

def visible(lines: list[str], ansi: bool) -> list[object]:
    """Normalize animation and, for ANSI, compare semantic per-cell styles."""
    if ansi:
        return [ansi_cells(line) for line in lines]
    return [normalize(line) for line in lines]

def distance(a: list[str], b: list[str], ansi: bool) -> int:
    return sum(
        max(i2 - i1, j2 - j1)
        for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(
            None, visible(a, ansi), visible(b, ansi)
        ).get_opcodes()
        if tag != "equal"
    )

def compare(refdir: pathlib.Path, got: dict[str, list[str]], keys: list[str], label: str, show_diff: bool) -> int:
    expected_keys = set(keys)
    actual_keys = set(got)
    bad = len(expected_keys ^ actual_keys)
    if expected_keys != actual_keys:
        print(f"{label}: fixture-set mismatch missing={sorted(expected_keys-actual_keys)} extra={sorted(actual_keys-expected_keys)}")
    ansi = label == "ansi"
    for key in keys:
        exp=[x.rstrip() for x in (refdir/f"{key}.txt").read_text().splitlines()]
        actual=got.get(key,[]); d=distance(exp,actual,ansi)
        print(f"{label}/{key:20} visible-diff={d:3} ref={len(visible(exp,ansi)):3} omp={len(visible(actual,ansi)):3}")
        bad += d
        if show_diff and d:
            print("\n".join(difflib.unified_diff(exp,actual,fromfile=f"pi/{key}",tofile=f"omp/{key}",lineterm="")))
    return bad

def main() -> int:
    p=argparse.ArgumentParser(); p.add_argument("tools", nargs="*"); p.add_argument("--expanded", action="store_true"); p.add_argument("--diff", action="store_true"); a=p.parse_args()
    refdir=REF/("tools-expanded" if a.expanded else "tools")
    available=sorted(x.stem for x in refdir.glob("*.txt"))
    keys=a.tools or available
    unknown=set(keys)-set(available)
    if unknown:
        p.error(f"unknown fixture(s): {', '.join(sorted(unknown))}")
    got=render(a.expanded, keys)
    bad=compare(refdir, got, keys, "plain", a.diff)
    if not a.expanded:
        ansi_ref=REF/"tools-ansi"
        ansi_keys=sorted(x.stem for x in ansi_ref.glob("*.txt"))
        if set(ansi_keys) != set(available):
            print(f"ansi: reference-set mismatch plain-only={sorted(set(available)-set(ansi_keys))} ansi-only={sorted(set(ansi_keys)-set(available))}")
            bad += len(set(ansi_keys) ^ set(available))
        ansi_selected=[key for key in keys if key in set(ansi_keys)]
        bad += compare(ansi_ref, render(False, ansi_selected, ansi=True), ansi_selected, "ansi", a.diff)
    return 1 if bad else 0
if __name__ == "__main__": sys.exit(main())
