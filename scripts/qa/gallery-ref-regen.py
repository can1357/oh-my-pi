#!/usr/bin/env python3
"""Regenerate QA gallery fixtures for tool rows from the TypeScript reference gallery.

The TypeScript reference checkout (`/work/pi`, or `$PI_ROOT`) is the behavior
oracle: `omp gallery` in its coding-agent package renders every tool renderer
through the real `ToolExecutionComponent`. Each tool row is captured three ways,
exactly as the existing references were: `tools/<tool>.txt` (`--plain`),
`tools-expanded/<tool>.txt` (`--plain --expanded`) and `tools-ansi/<tool>.txt`
(styled, no `--plain`). A capture is the tool's section — from its rule to the
trailing blank line — with its leading blank line dropped.

Usage: `uv run --no-project python scripts/qa/gallery-ref-regen.py resolve reject`
"""
from __future__ import annotations
import argparse, os, pathlib, re, subprocess, sys
ANSI = re.compile(r"\x1b\[[0-9;]*m")
REF = pathlib.Path(__file__).resolve().parent / "fixtures" / "gallery"
PI = pathlib.Path(os.environ.get("PI_ROOT", "/work/pi")) / "packages" / "coding-agent"

def capture(tool: str, expanded: bool, ansi: bool) -> str:
    cmd = ["bun", "run", "src/cli.ts", "gallery", "--surface", "tool", "--width", "100", "--tool", tool]
    if not ansi: cmd.append("--plain")
    if expanded: cmd.append("--expanded")
    out = subprocess.run(cmd, cwd=PI, check=True, capture_output=True, text=True).stdout
    lines = out.split("\n")
    while lines and lines[0] == "": lines.pop(0)
    return "\n".join(lines)

def main() -> int:
    p = argparse.ArgumentParser(); p.add_argument("tools", nargs="+"); a = p.parse_args()
    for tool in a.tools:
        for subdir, expanded, ansi in (("tools", False, False), ("tools-expanded", True, False), ("tools-ansi", False, True)):
            text = capture(tool, expanded, ansi)
            if not ANSI.sub("", text).startswith(f"── {tool}"):
                print(f"{tool}: reference rendered no section", file=sys.stderr); return 1
            (REF / subdir / f"{tool}.txt").write_text(text)
            print(f"{subdir}/{tool}.txt")
    return 0
if __name__ == "__main__": sys.exit(main())
