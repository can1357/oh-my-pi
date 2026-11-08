#!/usr/bin/env python3
"""Generate the fatal-jump site matrix pi-shell's coverage gate is measured from.

The ENUMERATION is derived from the engine's own source.  The variant lists of
`Opcode` (bash/ir/mod.rs), `DeclareKind` (vm/builtins/vars.rs), `Stop`
(vm/expand.rs), `FrameKind` (vm/proc.rs) and of the three axes the gate itself
declares -- `Carrier`, `FatalContext`, `Raiser` (vm/fatal_sites.rs) -- are
parsed out of the Rust files, never written here.  What is written here is one
SAMPLE per axis element: a syntactic construct, a substitution carrier, an
error raiser, a catch context.  A variant with no sample ends this script
non-zero, and `vm/fatal_sites.rs` fails the build's test run when the fixture
was measured for a different variant list than the crate now has.

Two sub-matrices:

* `construct`/`declare` -- one error raiser placed in one syntactic construct,
  caught in one context, with and without a non-zero prior status.  This is the
  original matrix of #18131.
* `carrier` -- one error raiser inside one substitution CARRIER (`${ ;}`,
  `${| ;}`, their compositions with `eval`, `.`, a subshell, a fork and a
  nested no-fork, in both orders, and the substitution used as an `if`
  condition), under one shell-option context, each also replicated inside an
  EXIT trap.  The carrier frame is where a fatal error is caught by the
  no-fork machinery, and the original matrix reaches it from no row at all.

usage: gen-fatal-sites.py <tree> <out.json>
"""

import itertools
import json
import re
import shlex
import sys

# ---------------------------------------------------------------- enumeration


def _strip_noise(text: str) -> str:
	"""`text` without comments or attributes, so delimiters can be counted.

	A doc comment holding an unmatched `}` or `(`, and an attribute's own
	parentheses, both moved the delimiter counter this parse depends on; an
	`#[allow(dead_code)]` on the line above a variant hid that variant
	entirely. Comments and attributes carry no variant, so they go first.
	Conditional compilation is NOT evaluated: a `#[cfg(...)]` variant is
	read as present, which is the safe direction for a coverage gate.
	"""
	out, i, n = [], 0, len(text)

	def skip_string(j: int) -> int:
		"""Index just past the literal starting at `j`, or `j` if none starts."""
		m = re.match(r'(?:br|rb|b|r)?(#*)"', text[j : j + 16])
		if m and "r" in m.group(0):
			close = '"' + m.group(1)
			end = text.find(close, j + m.end())
			return n if end < 0 else end + len(close)
		if m:
			k = j + m.end()
			while k < n and text[k] != '"':
				k += 2 if text[k] == "\\" else 1
			return k + 1
		if text[j] == '"':
			k = j + 1
			while k < n and text[k] != '"':
				k += 2 if text[k] == "\\" else 1
			return k + 1
		# `'a` is a lifetime, `'x'` and `'\n'` are character literals.
		if text[j] == "'":
			if text[j + 1 : j + 2] == "\\":
				end = text.find("'", j + 2)
				return n if end < 0 else end + 1
			if text[j + 2 : j + 3] == "'":
				return j + 3
		return j

	while i < n:
		two = text[i : i + 2]
		if two == "//":
			j = text.find("\n", i)
			i = n if j < 0 else j
		elif two == "/*":
			j = text.find("*/", i + 2)
			i = n if j < 0 else j + 2
		elif text[i] == "#" and text[i + 1 : i + 2] in ("[", "!"):
			# Skip the whole attribute, matching its brackets but stepping over
			# any string literal inside, whose `]` is not a bracket.
			j = text.find("[", i)
			if j < 0:
				out.append(text[i])
				i += 1
				continue
			depth, j = 1, j + 1
			while j < n and depth:
				after = skip_string(j)
				if after != j:
					j = after
					continue
				if text[j] == "[":
					depth += 1
				elif text[j] == "]":
					depth -= 1
				j += 1
			i = j
		else:
			after = skip_string(i)
			if after != i:
				out.append(" ")
				i = after
			else:
				out.append(text[i])
				i += 1
	return "".join(out)


def variants(path: str, enum: str) -> list[str]:
	"""The variant names of a Rust enum, read from its declaration."""
	src = _strip_noise(open(path, encoding="utf-8").read())
	# Generic parameters and a `where` clause may stand between the name and
	# the body: `enum Test<'a, T> where T: Copy { … }`.
	m = re.search(
		r"\benum\s+%s\s*(?:<[^>{]*>)?\s*(?:where[^{]*)?\{" % re.escape(enum), src
	)
	if not m:
		raise SystemExit(f"gen-fatal-sites: no `enum {enum}` in {path}")
	i, depth = m.end(), 1
	body_start = i
	while depth:
		if src[i] == "{":
			depth += 1
		elif src[i] == "}":
			depth -= 1
		i += 1
	body = src[body_start : i - 1]
	# At nesting depth zero a variant is a name closed by `,`, `(`, `{`, `=`
	# or the end of the body; a variant's payload is skipped whole.
	out, depth, token = [], 0, ""

	def take() -> None:
		nonlocal token
		if re.fullmatch(r"[A-Z][A-Za-z0-9_]*", token):
			out.append(token)
		token = ""

	for ch in body:
		if depth:
			if ch in "{(":
				depth += 1
			elif ch in "})":
				depth -= 1
			continue
		if ch in "{(":
			take()
			depth += 1
		elif ch in ",=":
			take()
		elif ch.isalnum() or ch == "_":
			token += ch
		else:
			take()
	take()
	if not out:
		raise SystemExit(f"gen-fatal-sites: no variants parsed from `enum {enum}`")
	# A name may be seen twice only if the scan is wrong; fail loudly.
	if len(set(out)) != len(out):
		raise SystemExit(f"gen-fatal-sites: duplicate variant parsed from `enum {enum}`: {out}")
	return out


def snake(name: str) -> str:
	"""`name` as strum's `serialize_all = "snake_case"` spells it."""
	return re.sub(r"(?<!^)(?=[A-Z])", "_", name).lower()


# -------------------------------------------------- samples: original matrix

# One raiser per error class the model has to carry.  `{n}` is a per-row
# unique suffix so rows in one batch never share a name or a file.
RAISERS = [
	# bash: a fatal error sets last_command_exit_value to 1 and raises
	# FORCE_EOF (ERREXIT with `set -e`).
	("fatal_unset", ": ${__miss?BOOM}"),
	("fatal_nounset", "set -u; : $__miss"),
	# A readonly assignment: bash raises DISCARD.
	("discard_readonly", "__r=2"),
	# An arithmetic error in an assignment VALUE of an integer variable, and
	# in a SUBSCRIPT: bash raises DISCARD without touching the status.
	("assign_int", "__I=bad!"),
	("assign_subscript", "__A[bad!]=3"),
	# An arithmetic error in a WORD: the same code from a site that leaves
	# the status alone.
	("arith_word", ": $((1/0))"),
]

# Syntactic constructs the raiser is placed in.  Their purpose is to cover
# every `Opcode` the generated fixture must account for; which opcodes each
# one actually reaches is measured by lowering it, not claimed here.
CONSTRUCTS = [
	("simple", "{r}"),
	("and", "true && {r}"),
	("or", "false || {r}"),
	("not", "! {r}"),
	("pipe_head", "{r} | cat"),
	("pipe_tail", "echo x | {{ {r}; }}"),
	("group", "{{ {r}; }}"),
	("subshell", "( {r} )"),
	("background", "{r} & wait $!"),
	("cmdsub", 'x=$( {r} ); echo "C:$x"'),
	("if_cond", "if {r}; then echo T; else echo F; fi"),
	("if_body", "if true; then {r}; fi"),
	("while_cond", "while {r}; do break; done"),
	("until_cond", "until {r}; do break; done"),
	("for_in", "for __i in 1 2; do {r}; done"),
	("for_arith", "for ((__j = 0; __j < 1; __j++)); do {r}; done"),
	("case_word", "case $( {r} ) in *) echo W;; esac"),
	("case_arm", "case x in x) {r};; esac"),
	("function", "__f{n}() {{ {r}; }}; __f{n}"),
	("redirect", "{r} > /dev/null"),
	("time_pipeline", "time {{ {r}; }}"),
	("cond_test", '[[ -n "$( {r} )" ]]'),
	("arith_command", "(( $( {r}; echo 1 ) ))"),
	("eval_builtin", "eval {q}"),
	("source_builtin", "printf '%s\\n' {q} > __s{n}.sh; . ./__s{n}.sh"),
	("nested_c", "bash -c {q}"),
	("nested_script", "printf '%s\\n' {q} > __n{n}.sh; bash ./__n{n}.sh"),
	("loop_continue", "for __i in 1; do {r}; continue; done"),
]

# Where the jump is caught.  Each context runs `__body`, which the preamble
# defines as the construct; that keeps every row one level of quoting deep.
CONTEXTS = [
	("top", '__body; echo "E:$?"'),
	("top_errexit", 'set -e; __body; echo "E:$?"'),
	("subshell", '( __body ); echo "E:$?"'),
	("subshell_errexit", 'set -e; ( __body ); echo "E:$?"'),
	("cmdsub", 'v=$( __body ); echo "E:$? $v"'),
	("eval", "eval '__body'; echo \"E:$?\""),
	("source", "printf '%s\\n' '__body' > __c%N%.sh; . ./__c%N%.sh; echo \"E:$?\""),
	(
		"nested_script",
		'printf \'%s\\n\' "$(declare -f __body)" \'__body\' > __b%N%.sh; bash ./__b%N%.sh; echo "E:$?"',
	),
	("exit_trap", "trap '__body' EXIT; exit 7"),
	("exit_trap_errexit", "set -e; trap '__body' EXIT; exit 7"),
	("err_trap", "trap '__body' ERR; false; echo \"E:$?\""),
	("err_trap_from_debug", "trap 'trap \"__body\" ERR' DEBUG; false; echo \"E:$?\""),
	("debug_trap", "trap '__body' DEBUG; :; echo \"E:$?\""),
	("return_trap", "set -T; trap '__body' RETURN; __g() { return 9; }; __g; echo \"E:$?\""),
	("err_trap_in_exit", "trap 'trap \"__body\" ERR; (exit 9)' EXIT; exit 7"),
	("debug_trap_in_exit", "trap 'trap \"__body\" DEBUG; :' EXIT; exit 7"),
	(
		"return_trap_in_exit",
		"trap 'set -T; trap \"__body\" RETURN; __g() { return 9; }; __g' EXIT; exit 7",
	),
	("fork_in_exit", "trap '( __body ); echo \"T:$?\"' EXIT; exit 7"),
	("top_posix", 'set -o posix; __body; echo "E:$?"'),
	("top_posix_errexit", 'set -o posix; set -e; __body; echo "E:$?"'),
	("exit_trap_posix", "set -o posix; trap '__body' EXIT; exit 7"),
]

PREAMBLE = "readonly __r=1\ndeclare -i __I\ndeclare -a __A\n"

# bash answers an `ERREXIT` jump with `last_command_exit_value` as it stands
# at the site.  With a zero prior status that is indistinguishable from the
# constant 1, so every row is measured with both.
PRIORS = [("clean", ""), ("prior3", "(exit 3); ")]

# Every declaration builtin kind, crossed with the arithmetic errors a
# declaration can raise: `DeclareKind` drives this list, so a new kind has no
# sample until one is written.
DECL_FORMS = {
	"Declare": ["declare -i __D%N%=bad!", 'declare "__E%N%[bad!]=3"'],
	"Local": [
		"__h%N%() { local -i __L=bad!; }; __h%N%",
		'__k%N%() { local "__M[bad!]=3"; }; __k%N%',
	],
	"Export": ["export __X%N%=$((1/0))", 'export "__Y%N%[bad!]=3"'],
	"Readonly": ["readonly __P%N%=$((1/0))", 'readonly "__Q%N%[bad!]=3"'],
}

# ---------------------------------------------------- samples: carrier matrix

# One sample per `Raiser` variant: the failing command the carrier carries.
CARRIER_RAISERS = {
	"badsub": ": ${bad.name}",
	"wordarith": ": $((1/0))",
	"subarith": "((__A[1/0]=3))",
	"declsub": 'declare "__A[bad!]=3"',
	"declval": "declare -i __I='1/0'",
	"readonly": "readonly __r2=1; __r2=2",
	"nounset": "set -u; : $__never_set",
	"fatal": ": ${__never_set?boom}",
	"readsub": ": ${__A[1/0]}",
	"false": "false",
}

# One sample per `FatalContext` variant: the shell options in force.
CARRIER_CONTEXTS = {
	"normal": "",
	"errexit": "set -e;",
	"inherit": "set -e; shopt -s inherit_errexit;",
	"posix": "set -o posix;",
	"posix_e": "set -o posix; set -e;",
	"nounset": "set -u;",
}

# One sample per `Carrier` variant: how the failing command is carried.  Every
# shape reports the substitution's value and the status the carrier left, then
# the status at the end of the body, so a swallowed error is visible as a
# surviving `END:` line and a value where there should be none.
_REPORT = 'printf "X:<%s>:%s\\n" "$x" "$?"'


def _nofork(body: str) -> str:
	return f"x=${{ echo BEFORE; {body}; echo AFTER; }}; {_REPORT}"


CARRIERS = {
	"plain": lambda b: f"{b}; echo PLAIN:$?",
	"nofork": _nofork,
	"reply": lambda b: (
		f"REPLY=outer; x=${{| REPLY=inner; {b}; echo AFTER; }}; "
		'printf "X:<%s>:%s:R:<%s>\\n" "$x" "$?" "$REPLY"'
	),
	"eval_nofork": lambda b: "eval " + shlex.quote(_nofork(b)),
	"nofork_eval": lambda b: (
		"x=${ echo BEFORE; eval "
		+ shlex.quote(b + "; echo EVAL_AFTER")
		+ f"; echo AFTER; }}; {_REPORT}"
	),
	"nofork_subshell": lambda b: (
		f"x=${{ echo BEFORE; ( {b}; echo SUB_AFTER ); echo AFTER:$?; }}; {_REPORT}"
	),
	"subshell_nofork": lambda b: f"( {_nofork(b)} ); echo SUB:$?",
	"fork_nofork": lambda b: (
		f"y=$({_nofork(b)}); " + 'printf "Y:<%s>:%s\\n" "$y" "$?"'
	),
	"nested_nofork": lambda b: (
		f"x=${{ echo BEFORE; y=${{ {b}; echo INNER_AFTER; }}; "
		'printf "Y:<%s>:%s\\n" "$y" "$?"; '
		f"echo AFTER; }}; {_REPORT}"
	),
	"source_nofork": lambda b: (
		"printf %s "
		+ shlex.quote(_nofork(b))
		+ " > __src%N%.sh; . ./__src%N%.sh; echo SOURCE:$?"
	),
	"condition": lambda b: (
		f"if x=${{ echo BEFORE; {b}; echo AFTER; }}; then echo YES:$x; else echo NO:$?; fi"
	),
}

# Both replications of every carrier row: run directly, and run as the body of
# an EXIT trap (the frame the original matrix reaches only with a bare
# construct).
TRAPS = {
	"direct": lambda code: code,
	"exit": lambda code: "trap " + shlex.quote(code) + " EXIT; exit 7",
}


def sq(text: str) -> str:
	"""`text` as one single-quoted shell word."""
	return "'" + text.replace("'", "'\\''") + "'"


def main() -> None:
	tree, outp = sys.argv[1], sys.argv[2]
	src = f"{tree}/crates/pi-shell/src/bash"
	gate = f"{src}/vm/fatal_sites.rs"
	enums = {
		"Opcode": variants(f"{src}/ir/mod.rs", "Opcode"),
		"DeclareKind": variants(f"{src}/vm/builtins/vars.rs", "DeclareKind"),
		"Stop": variants(f"{src}/vm/expand.rs", "Stop"),
		"FrameKind": variants(f"{src}/vm/proc.rs", "FrameKind"),
		# The gate's own axes are spelled snake_case by strum, and that is
		# what the fixture and the row ids record.
		"Carrier": [snake(v) for v in variants(gate, "Carrier")],
		"FatalContext": [snake(v) for v in variants(gate, "FatalContext")],
		"Raiser": [snake(v) for v in variants(gate, "Raiser")],
		"TrapReplication": [snake(v) for v in variants(gate, "TrapReplication")],
	}

	for axis, samples in (
		("DeclareKind", DECL_FORMS),
		("Carrier", CARRIERS),
		("FatalContext", CARRIER_CONTEXTS),
		("Raiser", CARRIER_RAISERS),
		("TrapReplication", TRAPS),
	):
		missing = [v for v in enums[axis] if v not in samples]
		if missing:
			raise SystemExit(f"gen-fatal-sites: no sample for {axis} {missing}")

	rows = []
	n = 0

	def add(row_id: str, axes: list[str], script: str) -> None:
		rows.append({"id": row_id, "axes": axes, "script": script})

	# ---- the original matrix: one construct, one raiser, one catch context.
	def add_site(group: str, site: str, raiser: str, ctx: str, body: str, tail: str) -> None:
		nonlocal n
		for prior, pre in PRIORS:
			n += 1
			script = PREAMBLE + f"__body() {{ {pre}{body}; }}\n" + tail.replace("%N%", str(n))
			add(
				f"{group}-{site}-{raiser}-{ctx}-{prior}",
				[f"{group}:{site}", f"raiser:{raiser}", f"context:{ctx}", f"prior:{prior}"],
				script,
			)

	for cname, ctemplate in CONSTRUCTS:
		for rname, rtext in RAISERS:
			body = ctemplate.format(r=rtext, q=sq(rtext), n=f"{cname}_{rname}")
			for ctx_name, tail in CONTEXTS:
				add_site("construct", cname, rname, ctx_name, body, tail)

	for kind in enums["DeclareKind"]:
		for i, form in enumerate(DECL_FORMS[kind]):
			body = form.replace("%N%", f"{kind}{i}")
			for ctx_name, tail in CONTEXTS:
				add_site("declare", f"{kind}{i}", "declaration", ctx_name, body, tail)

	# ---- the carrier matrix: every context x carrier x raiser, each also
	# inside an EXIT trap.  The full cross product is kept: the no-fork frame
	# answers differently for each combination, so a cover would not see it.
	for ctx, carrier, raiser in itertools.product(
		enums["FatalContext"], enums["Carrier"], enums["Raiser"]
	):
		n += 1
		code = (
			CARRIER_CONTEXTS[ctx]
			+ " declare -a __A; declare -i __I; "
			+ CARRIERS[carrier](CARRIER_RAISERS[raiser]).replace("%N%", str(n))
			+ "; echo END:$?"
		)
		for trap in enums["TrapReplication"]:
			add(
				f"carrier-{trap}-{ctx}-{carrier}-{raiser}",
				[
					f"carrier:{carrier}",
					f"fatalContext:{ctx}",
					f"gateRaiser:{raiser}",
					f"trap:{trap}",
				],
				TRAPS[trap](code),
			)

	fixture = {
		"enums": enums,
		"raisers": [{"name": a, "script": b} for a, b in RAISERS],
		"constructs": [{"name": a, "template": b} for a, b in CONSTRUCTS],
		"contexts": [{"name": a, "tail": b} for a, b in CONTEXTS],
		"priors": [{"name": a, "prefix": b} for a, b in PRIORS],
		"declarations": DECL_FORMS,
		"rows": rows,
	}
	json.dump(fixture, open(outp, "w"), indent="\t")
	print(f"{len(rows)} rows; enums: " + ", ".join(f"{k}={len(v)}" for k, v in enums.items()))


main()
