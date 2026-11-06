#!/usr/bin/env python3
"""Generate the fatal-jump site matrix.

The enumeration is derived from the engine's own source: the variant lists of
`Opcode` (bash/ir/mod.rs), `DeclareKind` (vm/builtins/vars.rs), `JumpCode`
(vm/exec.rs) and `LandingCatch` (vm/proc.rs) are parsed out of the Rust files,
never written here. What is written here is one sample per axis element: a
syntactic construct, an error raiser, a catch context. The generated fixture
records which variants each sample reaches, and the Rust test
(`crates/pi-shell/tests/fatal_site_matrix.rs` plus the in-crate coverage test)
fails when the code gains a variant no sample reaches.

usage: gen-sites.py <tree> <out.json>
"""

import argparse
import json
import re

# ---------------------------------------------------------------- enumeration


def variants(path: str, enum: str) -> list[str]:
    """The variant names of a Rust enum, read from its declaration."""
    src = open(path, encoding="utf-8").read()
    m = re.search(r"\benum\s+%s\s*\{" % re.escape(enum), src)
    if not m:
        raise SystemExit(f"gen-sites: no `enum {enum}` in {path}")
    i, depth, out = m.end(), 1, []
    body_start = i
    while depth:
        ch = src[i]
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
        i += 1
    body = src[body_start : i - 1]
    # Strip doc comments, attributes and nested variant payloads.
    depth = 0
    line_start = True
    name = ""
    for ch in body:
        if depth == 0 and ch in "{(":
            depth += 1
            continue
        if depth:
            if ch in "{(":
                depth += 1
            elif ch in "})":
                depth -= 1
            continue
        if ch == "\n":
            line_start = True
            continue
        if line_start and ch in " \t":
            continue
        line_start = False
    # Simpler: variant names start a line (after indentation) with an
    # upper-case letter and end at `,`, `(`, `{` or ` `.
    out = []
    depth = 0
    for raw in body.splitlines():
        line = raw.strip()
        opens = line.count("{") + line.count("(")
        closes = line.count("}") + line.count(")")
        if depth:
            depth += opens - closes
            continue
        if not line or line.startswith("//") or line.startswith("#["):
            continue
        m = re.match(r"([A-Z][A-Za-z0-9_]*)", line)
        if m:
            out.append(m.group(1))
        depth += opens - closes
    if not out:
        raise SystemExit(f"gen-sites: no variants parsed from `enum {enum}`")
    return out


# -------------------------------------------------------------------- samples

# One raiser per error class the model has to carry. `{n}` is a per-row
# unique suffix so rows in one batch never share a name or a file.
RAISERS = [
    # bash: a fatal error sets last_command_exit_value to 1 and raises
    # FORCE_EOF (ERREXIT with `set -e`).
    ("fatal_unset", "ForceEof", ': ${__miss?BOOM}'),
    ("fatal_nounset", "ForceEof", 'set -u; : $__miss'),
    # A readonly assignment: bash raises DISCARD.
    ("discard_readonly", "Discard", '__r=2'),
    # An arithmetic error in an assignment VALUE of an integer variable, and
    # in a SUBSCRIPT: bash raises DISCARD without touching the status.
    ("assign_int", "AssignDiscard", '__I=bad!'),
    ("assign_subscript", "AssignDiscard", '__A[bad!]=3'),
    # An arithmetic error in a WORD: the same code from a site that leaves
    # the status alone.
    ("arith_word", "AssignDiscard", ': $((1/0))'),
]

# Syntactic constructs the raiser is placed in. Their purpose is to cover
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

# Where the jump is caught. Each context runs `__body`, which the preamble
# defines as the construct; that keeps every row one level of quoting deep.
CONTEXTS = [
    ("top", "ShellCommand", '__body; echo "E:$?"'),
    ("top_errexit", "ShellCommand", 'set -e; __body; echo "E:$?"'),
    ("subshell", "Own", '( __body ); echo "E:$?"'),
    ("subshell_errexit", "Own", 'set -e; ( __body ); echo "E:$?"'),
    ("cmdsub", "Own", 'v=$( __body ); echo "E:$? $v"'),
    ("eval", "ShellCommand", 'eval \'__body\'; echo "E:$?"'),
    ("source", "ShellCommand", 'printf \'%s\\n\' \'__body\' > __c%N%.sh; . ./__c%N%.sh; echo "E:$?"'),
    ("nested_script", "ShellScript", 'printf \'%s\\n\' "$(declare -f __body)" \'__body\' > __b%N%.sh; bash ./__b%N%.sh; echo "E:$?"'),
    ("exit_trap", "ExitTrap", "trap '__body' EXIT; exit 7"),
    ("exit_trap_errexit", "ExitTrap", "set -e; trap '__body' EXIT; exit 7"),
    ("err_trap", "ShellCommand", 'trap \'__body\' ERR; false; echo "E:$?"'),
    ("debug_trap", "ShellCommand", 'trap \'__body\' DEBUG; :; echo "E:$?"'),
    ("return_trap", "ShellCommand", 'set -T; trap \'__body\' RETURN; __g() { return 9; }; __g; echo "E:$?"'),
    ("err_trap_in_exit", "Trap", "trap 'trap \"__body\" ERR; (exit 9)' EXIT; exit 7"),
    ("debug_trap_in_exit", "Trap", "trap 'trap \"__body\" DEBUG; :' EXIT; exit 7"),
    ("return_trap_in_exit", "Trap", "trap 'set -T; trap \"__body\" RETURN; __g() { return 9; }; __g' EXIT; exit 7"),
    ("fork_in_exit", "Trap", "trap '( __body ); echo \"T:$?\"' EXIT; exit 7"),
    ("top_posix", "ShellCommand", 'set -o posix; __body; echo "E:$?"'),
    ("top_posix_errexit", "ShellCommand", 'set -o posix; set -e; __body; echo "E:$?"'),
    ("exit_trap_posix", "ExitTrap", "set -o posix; trap '__body' EXIT; exit 7"),
]

PREAMBLE = "readonly __r=1\ndeclare -i __I\ndeclare -a __A\n"

# bash answers an `ERREXIT` jump with `last_command_exit_value` as it stands
# at the site. With a zero prior status that is indistinguishable from the
# constant 1, so every row is measured with both.
PRIORS = [("clean", ""), ("prior3", "(exit 3); ")]


def sq(text: str) -> str:
    """`text` as one single-quoted shell word."""
    return "'" + text.replace("'", "'\\''") + "'"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("tree", help="repository root whose enum declarations to read")
    parser.add_argument("output", help="generated site matrix JSON")
    args = parser.parse_args()
    src = f"{args.tree}/crates/pi-shell/src/bash"
    enums = {
        "Opcode": variants(f"{src}/ir/mod.rs", "Opcode"),
        "DeclareKind": variants(f"{src}/vm/builtins/vars.rs", "DeclareKind"),
        "JumpCode": variants(f"{src}/vm/exec.rs", "JumpCode"),
        "LandingCatch": variants(f"{src}/vm/proc.rs", "LandingCatch"),
    }

    # Every declaration builtin kind, crossed with the arithmetic errors a
    # declaration can raise: `DeclareKind` drives this list, so a new kind
    # has no sample until one is written.
    decl_forms = {
        "Declare": ["declare -i __D%N%=bad!", 'declare "__E%N%[bad!]=3"'],
        "Local": [
            "__h%N%() { local -i __L=bad!; }; __h%N%",
            '__k%N%() { local "__M[bad!]=3"; }; __k%N%',
        ],
        "Export": ["export __X%N%=$((1/0))", 'export "__Y%N%[bad!]=3"'],
        "Readonly": ["readonly __P%N%=$((1/0))", 'readonly "__Q%N%[bad!]=3"'],
    }
    missing = [k for k in enums["DeclareKind"] if k not in decl_forms]
    if missing:
        raise SystemExit(f"gen-sites: no sample for DeclareKind {missing}")

    rows = []
    n = 0

    def add(group: str, site: str, raiser: str, ctx_name: str, catch: str, body: str, tail: str) -> None:
        nonlocal n
        for prior, pre in PRIORS:
            n += 1
            script = PREAMBLE + f"__body() {{ {pre}{body}; }}\n" + tail.replace("%N%", str(n))
            rows.append(
                {
                    "id": f"{group}-{site}-{raiser}-{ctx_name}-{prior}",
                    "prior": prior,
                    "group": group,
                    "site": site,
                    "raiser": raiser,
                    "context": ctx_name,
                    "catch": catch,
                    "script": script,
                }
            )

    for cname, ctemplate in CONSTRUCTS:
        for rname, _code, rtext in RAISERS:
            body = ctemplate.format(r=rtext, q=sq(rtext), n=f"{cname}_{rname}")
            for ctx_name, catch, tail in CONTEXTS:
                add("construct", cname, rname, ctx_name, catch, body, tail)

    for kind in enums["DeclareKind"]:
        for i, form in enumerate(decl_forms[kind]):
            body = form.replace("%N%", f"{kind}{i}")
            for ctx_name, catch, tail in CONTEXTS:
                add("declare", f"{kind}{i}", "declaration", ctx_name, catch, body, tail)

    fixture = {
        "enums": enums,
        "raisers": [{"name": a, "class": b, "script": c} for a, b, c in RAISERS],
        "constructs": [{"name": a, "template": b} for a, b in CONSTRUCTS],
        "contexts": [{"name": a, "catch": b, "tail": c} for a, b, c in CONTEXTS],
        "priors": [{"name": a, "prefix": b} for a, b in PRIORS],
        "declarations": decl_forms,
        "rows": rows,
    }
    json.dump(fixture, open(args.output, "w", encoding="utf-8"), indent="\t")
    print(f"{len(rows)} rows; enums: " + ", ".join(f"{k}={len(v)}" for k, v in enums.items()))


if __name__ == "__main__":
    try:
        main()
    except OSError as error:
        raise SystemExit(f"gen-sites: {error}") from error
