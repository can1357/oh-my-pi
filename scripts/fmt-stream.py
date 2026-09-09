#!/usr/bin/env python3
"""Reindent `stream! { … }` macro bodies that rustfmt cannot parse.

rustfmt's `format_macro_bodies` silently skips macro invocations whose body is
not a valid Rust block — the `yield` expressions inside `async_stream::stream!`
make every tool `call` body one of those, so their indentation drifts and
nothing ever repairs it.

This formatter re-tabs each body line purely from delimiter depth:

- indent = tabs of the `stream! {` line + brace/bracket/paren depth inside it
- lines opening with closers (`}`, `)`, `]`) dedent first
- lines opening with `.`, `&&`, `||`, `?` get one continuation tab
- lines that begin inside a multi-line string or block comment are untouched

Only leading whitespace ever changes; a hard assert refuses to write anything
else. Usage: `scripts/fmt-stream.py [--check] [paths…]` (default: `crates`).
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

MACRO_OPEN = re.compile(r"\b(?:stream|try_stream)!\s*$")
RAW_STR = re.compile(r'(?:br|cr|b|c)?r(#*)"')
CHAR_LIT = re.compile(r"'(?:\\u\{[0-9a-fA-F_]+\}|\\.|[^'\\\n])'")
OPENERS = "([{"
CLOSERS = ")]}"
TERMINATORS = ";,{}(["


def indent_tabs(line: str) -> int:
	"""Leading indent of `line` in levels (tabs, or runs of 3 spaces)."""
	tabs = spaces = 0
	for ch in line:
		if ch == "\t":
			tabs += 1
		elif ch == " ":
			spaces += 1
		else:
			break
	return tabs + spaces // 3


def reindent(text: str) -> str:
	"""Return `text` with every `stream!`/`try_stream!` body re-tabbed."""
	comment = 0  # nested block-comment depth
	string: tuple[str, int] | None = None  # ("str", 0) | ("raw", hashes)
	stack: list[int] = []  # per open delimiter: indent of the line that opened it
	prev_term = True  # previous code line completed a statement/element
	prev_orig = prev_new = 0  # previous code line's indent before/after reindent
	out: list[str] = []

	for raw in text.split("\n"):
		stripped = raw.strip()
		in_code = comment == 0 and string is None

		if stack and in_code and stripped:
			closers = 0
			for ch in stripped:
				if ch in CLOSERS:
					closers += 1
				else:
					break
			closers = min(closers, len(stack))
			if closers:
				indent = stack[-closers]  # dedent to the matching opener's line
			elif prev_term:
				indent = stack[-1] + 1  # new statement: one level inside innermost open
			else:
				# Mid-expression continuation (chains, binops, wrapped conditions):
				# rustfmt has several irregular styles here, so keep the line's
				# original offset from its predecessor instead of guessing.
				indent = max(prev_new + indent_tabs(raw) - prev_orig, stack[-1] + 1)
			line = "\t" * indent + stripped
		elif stack and in_code:
			line = ""
		else:
			line = raw
		out.append(line)
		cur_indent = indent_tabs(line)
		last_code = ""  # final code character on this line, for statement boundaries

		# Lex the line to track depth, strings, comments, and macro opens.
		recent = ""  # trailing code chars on this line, for `stream!` detection
		i, n = 0, len(line)
		while i < n:
			ch = line[i]
			if string is not None:
				if string[0] == "raw":
					end = '"' + "#" * string[1]
					j = line.find(end, i)
					if j == -1:
						break
					i, string = j + len(end), None
				elif ch == "\\":
					i += 2
				else:
					if ch == '"':
						string = None
					i += 1
				continue
			if comment:
				if line.startswith("*/", i):
					comment -= 1
					i += 2
				elif line.startswith("/*", i):
					comment += 1
					i += 2
				else:
					i += 1
				continue
			if line.startswith("//", i):
				break
			if line.startswith("/*", i):
				comment += 1
				i += 2
				continue
			raw_match = RAW_STR.match(line, i) if ch in "bcr" else None
			if raw_match:
				string, recent, i = ("raw", len(raw_match.group(1))), "", raw_match.end()
				continue
			if ch == '"':
				string, recent = ("str", 0), ""
				i += 1
				continue
			if ch == "'":
				char = CHAR_LIT.match(line, i)
				i = char.end() if char else i + 1  # lifetime: skip the quote
				recent = ""
				last_code = "'"
				continue
			if ch in OPENERS:
				if stack or (ch == "{" and MACRO_OPEN.search(recent)):
					stack.append(cur_indent)
				recent = ""
			elif ch in CLOSERS:
				if stack:
					stack.pop()
				recent = ""
			else:
				recent += ch
			if not ch.isspace():
				last_code = ch
			i += 1
		if last_code:
			prev_term = last_code in TERMINATORS
			prev_orig, prev_new = indent_tabs(raw), cur_indent

	return "\n".join(out)


def main() -> int:
	parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
	parser.add_argument("paths", nargs="*", default=[Path("crates")], type=Path)
	parser.add_argument("--check", action="store_true", help="list drifted files, exit 1")
	args = parser.parse_args()

	changed: list[Path] = []
	for root in args.paths:
		files = [root] if root.is_file() else sorted(root.rglob("*.rs"))
		for path in files:
			if "target" in path.parts:
				continue
			text = path.read_text()
			if "stream!" not in text:
				continue
			new = reindent(text)
			if new == text:
				continue
			assert [l.strip() for l in new.split("\n")] == [l.strip() for l in text.split("\n")], (
				f"{path}: non-whitespace rewrite refused"
			)
			changed.append(path)
			if not args.check:
				path.write_text(new)

	verb = "would reindent" if args.check else "reindented"
	for path in changed:
		print(f"{verb} {path}")
	if not changed:
		print("all stream! bodies already tabbed")
	return 1 if args.check and changed else 0


if __name__ == "__main__":
	sys.exit(main())
