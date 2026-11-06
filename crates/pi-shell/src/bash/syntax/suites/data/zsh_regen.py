#!/usr/bin/env python3
"""Generate the zsh-grammar goldens of tests/zsh_parser.rs from zsh 5.9.

Writes zsh_{corpus,text,errors}.txt next to this script (or into argv[1]):
- zsh_corpus.txt: every code chunk of the 15 Test/*.ztst files the zsh
  dialect targets (ztst's chunk rules), with whether `zsh -f -n -c CHUNK` accepts it.
- zsh_text.txt: `f () { ... }` sources and what `functions f` prints.
- zsh_errors.txt: malformed sources and zsh's first parse message.
Set ZSH_TEST_DIR to zsh 5.9's Test/ directory. Every zsh runs in its own
session under `timeout -s KILL 10`.
Records are separated by \x1e, fields by \x1f.
"""
import os, subprocess, sys

ZSH = os.environ.get("ZSH59", "/bin/zsh")
TEST = os.environ.get("ZSH_TEST_DIR", "/work/.cache/upstream/zsh-5.9/Test")
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.dirname(os.path.abspath(__file__))
FILES = ["A01grammar", "A02alias", "A03quoting", "A04redirect", "A05execution",
         "A06assign", "A07control", "B02typeset", "C01arith", "C02cond",
         "C03traps", "D02glob", "D04parameter", "D06subscript", "E01options"]

TEXT = [
    "f() { echo a; echo b | cat; a && b || c; ! d }",
    "f() { if a; then b; elif c; then d; else e; fi }",
    "f() { for i in 1 2; do echo $i; done; for i (a b) echo; for ((i=0;i<3;i++)) echo $i; for a b in 1 2 3 4; do :; done }",
    "f() { while a; do b; done; until a; do b; done; repeat 3 echo x; repeat $n; do x; done }",
    "f() { case $a in (a|b) x;; c) y;& d|e) z;| *) ;; esac; case x in esac }",
    "f() { { a; b } always { c }; (a; b); { x } }",
    "f() { [[ -n $a && ( $b == c* || ! -f d ) ]]; (( i++ )); [[ a ]]; [[ a < b ]] }",
    "f() { cat <<EOF\nhello $x\nEOF\ncat <<-'E' >f\n\ttab\n\tE\necho after; }",
    "f() { a=1 b=(x y) cmd >o 2>&1 <i >>a 2>>b >|c &>d &>|e >&2 3<&- <<<str {fd}>x; local x=1 y; typeset -A h=([a]=1 [b]=2) }",
    "f() { () { echo $1 } a b; function { echo anon }; g() { inner }; function h { x } }",
    "f() { time a | b; coproc c; a &; b &|; nocorrect ls; select x in a b; do :; done }",
    "f() { echo ${(f)\"$(cat x)\"} *(.N) =(ls) <1-5> (#i)a ${a[1]} $x[2] \"$(cmd)\" `bq` $((1+2)) $'a\\tb' }",
    "f() { a=1 >f; x=1; for x in; do :; done; {}; case a in (x) b; c;; (y) d & ;; esac }",
    "f() { time { a; b }; cat 3<<EOF; a >f |& b\nx\nEOF\necho ${a:-b} \"q $x\" 'sq' \\$x }",
    "f() { if a; then b & fi; while a; b; do c; done; until { a }; do b; done }",
    "f() { x=$(echo a; echo b) y=`x`; echo $(\n cmd\n) }",
    "f() { [[ $a = b && $c != d ]]; [[ a -ef b ]]; [[ -o opt ]]; [[ x == (#i)y* ]] }",
    "f() { a | b && c; ! a | b }",
    "f() { [[ -f ]]; [[ a -nt b ]]; [[ -x a b ]]; [[ a =~ b ]]; [[ ! ! a ]]; [[ (a || b) || c ]]; [[ a && b || c ]]; [[ a || b && c ]] }",
    "f() { echo a } >/dev/null",
    "f() {}",
    "f() (a)",
    "f() echo hi",
    "f() { a=(1 [k]=v); x[2]=3; y+=4 }",
    "f() { echo $(( 1 + 2 )) $[ 3 ] }",
    "f() { ( a ) && { b } || c; !; time; coproc; }",
    "f() { x() { y() { z } } }",
    "f() { for i; do echo; done; while true; do break; done }",
    "f() { if a; then; else b; fi; print -r -- \"${(j: :)@}\" }",
    "f() { echo a\\\nb 'c\nd' \"e\nf\" }",
]

ERRORS = [
    "echo 'abc", 'echo "abc', "echo `abc", "if true; then", "echo )", "fi",
    "echo ${a", "((1+", "case a in (b) ;; ", "echo $(echo a", "{ echo; ",
    "echo a;;", "[[ a", "[[ a b c ]]", "echo a |\n", "repeat", "echo $((1",
    "echo $(fi)", "a=(b c", "echo $((1+2)", "echo $'a", "f() {", "[[ ]]",
    "[[ a == ]]", "[[ ( a ]]", "echo >", "|| a", "while; do :; done",
    "for x in a b; echo $x", "a=1 &", "select x y in a; do :; done",
]


def zsh(*args, stdin=None):
    cmd = ["perl", "-MPOSIX", "-e", "POSIX::setsid(); exec @ARGV or die",
           "timeout", "-s", "KILL", "10", ZSH, "-f", *args]
    return subprocess.run(cmd, input=stdin, capture_output=True)


def chunks(text):
    """ztst's ZTST_getchunk over %prep, %test and %clean (ZTST_getline
    drops lines starting with `#`)."""
    numbered = [(n + 1, l) for n, l in enumerate(text.split("\n")) if not l.startswith("#")]
    lines = [l for _, l in numbered]
    out = []
    i = 0
    blank = lambda l: l.strip(" \t") == ""
    indented = lambda l: l[:1] in (" ", "\t") and not blank(l)
    while i < len(lines):
        if indented(lines[i]):
            start = i
            code = []
            while i < len(lines) and indented(lines[i]):
                code.append(lines[i])
                i += 1
            out.append((numbered[start][0], "\n".join(code)))
        else:
            i += 1
    return out


def parse_failure(msg):
    """Whether `zsh -n`'s message is a parse error (noexec still reports
    some expansion errors, which are not)."""
    return msg.startswith(("parse error", "unmatched", "closing brace expected",
                           "condition expected"))


def first_msg(err):
    for line in err.decode("utf-8", "replace").splitlines():
        if line.startswith("zsh:"):
            return line.split(":", 2)[2].strip()
    return ""


def main():
    recs = []
    for name in FILES:
        with open(os.path.join(TEST, name + ".ztst"), encoding="utf-8", errors="surrogateescape") as f:
            text = f.read()
        for line, code in chunks(text):
            r = zsh("-n", "-c", code)
            msg = first_msg(r.stderr)
            bad = r.returncode != 0 and parse_failure(msg)
            recs.append("\x1f".join([name, str(line), "1" if bad else "0", msg, code]))
    with open(os.path.join(OUT, "zsh_corpus.txt"), "w", encoding="utf-8", errors="surrogateescape") as f:
        f.write("\x1e".join(recs))
    recs = []
    for src in TEXT:
        r = zsh("-c", src + "\nfunctions f")
        recs.append(src + "\x1f" + r.stdout.decode().rstrip("\n"))
    with open(os.path.join(OUT, "zsh_text.txt"), "w") as f:
        f.write("\x1e".join(recs))
    recs = []
    for src in ERRORS:
        r = zsh("-n", "-c", src)
        recs.append(src + "\x1f" + first_msg(r.stderr))
    with open(os.path.join(OUT, "zsh_errors.txt"), "w") as f:
        f.write("\x1e".join(recs))


main()
