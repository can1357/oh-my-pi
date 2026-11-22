#!/usr/bin/env python3
"""Generate syntax-crate goldens from /opt/homebrew/bin/bash 5.3.

Writes {declare_f,errors,aliases}.txt next to this script (or into argv[1]).
Run with bash 5.3 as $BASH53. The shfmt fixtures (shfmt/case*.json) come from
`shfmt --ln=bash --to-json < caseN.sh` (shfmt v3.14.1).
Records are separated by \x1e, fields by \x1f.
"""
import subprocess, sys, os

BASH = os.environ.get("BASH53", "/opt/homebrew/bin/bash")
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.dirname(os.path.abspath(__file__))

DECL = [
    "echo <(a|b;  c) >(d)",
    "echo $(a|b;  c) `x|  y` ${ a;  } ${|b;}",
    "echo $[1+2] $((  1 + 2 ))",
    "((  1+2  ))",
    "a=(1   2  [k]=v  # c\n 3) b+=x c[1+2]=y",
    "for i in 1; { echo; }",
    "echo \"a\\\nb\" a\\\nb 'a\\\nb'",
    "time -p ! a",
    "! time a | b",
    "echo ${x[ 1 ]} ${x:  -1:2} ${foo bar}",
    "declare -a x=(1  2) y=(3)",
    "echo $\"a  $x\"",
    "case x in (a) ;; b|c) d;& e) ;;& esac",
    "[[ -n x && ( a == b* || ! c =~ ^(x|y)$ ) ]]",
    "cat <<EOF; cat <<-\"X\"\na $x\nEOF\n\tb\n\tX",
    "echo >&2 <&- >&- 2>&1 <&3 >&$x 2>&- {fd}>f {fd}>&- &>f &>>g 3<>f >|h <<<\"x\" 2<<< y",
    "time; ! ; time -p; ! ! a; ! time a | b",
    "[[ x ]]; [[ ! ! x ]]; [[ ! ( a && b ) || -f x ]]; [[ a < b ]]",
    "coproc a b; coproc { a; }; coproc N { a; }; coproc N (a)",
    "g() { a; } >f; function h { b; }; k() ( c ); function m () if a; then b; fi",
    "select x in a b; do :; done; select y; do :; done",
    "case x in esac; case x in (esac) a;; esac; case x in a) b; esac; case $x in *) ;; esac",
    "for ((;;)); do :; done; for ((i=0;i<3;i++)) { a; }",
    "echo $( (a) ) ${ a; } ${ a;} ${|a;} ${ a\n} ${ a& }",
    "a & b; c &",
    "a |& b | c |& d",
    "a && b || ! c &",
    "cat <<A && cat <<B\na\nA\nb\nB\necho x",
    "cat <<A | cat <<B; echo\na\nA\nb\nB",
    "if cat <<A\na\nA\nthen b; fi\nwhile cat <<A; do c; done\na\nA",
    "( cat <<A )\na\nA\n{ cat <<A; }\na\nA",
    "case x in a) cat <<A;;\na\nA\nesac",
    "cat <<A >f 2>&1 <<-B\na\nA\n\tb\n\tB",
    "a <<A & b\nx\nA",
    "x=$(cat <<A\na\nA\n) y",
    "echo $'a\\tb\\'c' $'x'y \"$'q'\"",
    "echo ${x:-$(a;b)} \"$(c\nd)\" `e\nf` $(case x in a) b;; esac)",
    "echo $( # c ( x\na )",
    "a=( $(x) \"y  z\" ) declare b=( 1  2 )",
    "echo ${x/a/b} ${x// /_} ${#x} ${!x*} ${x@Q} $(( $(a) + 1 ))",
    "echo \\$x\\\ny \\\\ \"a\\$b\\\\\" ${x:-\"a b\"}",
    "echo $(cat <<EOF\nx $(y)\nEOF\n)",
    "x=$(a) y=`b`",
    "echo $(if a\nthen b\nc\nfi)",
    "for ((i = 0 ; i < 5; i++ )); do :; done",
    "echo ${x:-$'\\t'} \"${x:-$'\\t'}\" \"${x#$'a'}\"",
    "echo $\"x\" \"$\"x\"\"",
    "echo `echo \\`a\\` \"\\$x\"`",
    "if a; then b; elif c; then d; elif e; then f; else g; fi",
    "while a\ndo\nb\ndone; until c; do d; done >x",
    "{ a; b; } > f 2>&1; ( c; d ) | e",
    "f2() { :; }; function f3() { :; }",
    "echo a\\ b \\' \\\" \\$ \\` \"\\a\"",
    "echo ${!a[@]} ${a[@]:1:2} ${#a[*]} ${a[$i]} ${!x} ${!x:-y}",
    "echo ${x%%.*} ${x##*/} ${x%/*} ${x#*/} ${x^^} ${x,} ${x/#a/b} ${x/%a/b}",
    "echo ${x:=1} ${x=1} ${x:?msg} ${x?} ${x:+alt} ${x+alt}",
    "a[i]=1 b[$j]+=2 c+=(3 4) d=([0]=a [1]+=b)",
    "local -a x=(1 2); export y=$z; readonly r",
    "echo ~ ~/x {a,b} *.c a?b [ab]",
    "echo \"${a[@]}\" \"$@\" $* $# $? $$ $! $- $0 $9 ${10}",
    "trap 'echo x' EXIT; eval \"a b\"",
    "echo $((a+b)) $((a ? b : c)) $(( (a) + (b) ))",
    "echo $(echo $(echo a))",
    "echo \"$(echo \"$(echo a)\")\"",
    "a=$((1+2)); b=${c:-$((3))}",
    "echo foo#bar # comment",
    "[[ $a == \"$b\" ]] && [[ $c =~ ^[0-9]+$ ]] || [[ -z $d ]]",
    "[[ a > b && c != d* ]]",
    "x=1 y=2 cmd arg >out 2>&1 <in",
    "cmd 2>/dev/null || :",
    "cd /tmp && ls -la | grep foo 2>/dev/null | head -5 > out.txt",
    "for f in *.txt; do\n  echo \"$f\"\ndone",
    "while read -r line; do echo \"$line\"; done < file",
    "case \"$1\" in\n  start|stop) echo ok ;;\n  *) echo no ;;\nesac",
    "if [ -f x ]; then\n  cat x\nelse\n  echo none\nfi",
    "function f { :; }; g () { :; }",
    "a=b f() { :; }",
    "echo $(( 2#101 )) $[ 3 * 4 ]",
    "time { a; b; }",
    "! { a; }",
    "{ a; } &",
    "a; b; c &",
    "a & b & c",
    "a && b & c || d",
    "echo a >f; echo b >>f; echo c >|f",
    "exec 3>&1 4<&0 5<>f",
    "echo $(<file)",
    "x=( a\nb\n# c\nc )",
    "echo 'it'\\''s'",
    "echo \"a\nb\"",
    "cat <<'E'\n$x\nE",
    "cat <<\\E\n$x\nE",
    "cat <<\"E\"\n$x\nE",
    "cat << E\n\\$x \\\\ \\`\nE",
    "cat <<-E\n\t\ta\n\tE",
    "cat <<E1 <<E2\na\nE1\nb\nE2",
    "cat <<E | wc -l\na\nE",
    "f(){ :;}",
    "echo ${x:-a b} ${x:-'a b'} ${x:-\"a\"b}",
    "echo $(( $# > 0 ))",
    "arr=(\"${arr[@]}\" new)",
    "read -ra parts <<< \"$line\"",
    "printf '%s\\n' \"${@:2}\"",
    "echo ${var//[^a-z]/}",
    "[[ -v x ]] && echo ${x@Q}",
    "coproc cat",
    "echo a | { read x; echo $x; }",
    "(( i++ )); (( i = j + 1 ))",
    "let i++ j=2",
    "select x; do break; done",
    "for x do echo; done",
    "case a in a) ;& b) echo;;& *) esac",
    "{ echo; } 2>/dev/null >&2",
    "f() { local x=$1; shift; echo \"$x\"; }",
    "echo $'\\x41\\u00e9\\n'",
    "echo \"${x:-$'a\\tb'}\"",
    "echo $\"hello $USER\"",
    "echo ${x:0:1}${x:1}",
    "echo ${#}  ${##} ${#@}",
    "echo ${@} ${*} ${!}",
]

def bash(script):
    r = subprocess.run([BASH, "-c", script], capture_output=True)
    return r.returncode, r.stdout.decode("utf-8", "surrogateescape"), r.stderr.decode("utf-8", "surrogateescape")

recs = []
for snip in DECL:
    rc, out, err = bash("f(){ " + snip + "\n}\ndeclare -f f")
    if rc != 0 or err:
        print("skip", repr(snip), err.strip(), file=sys.stderr)
        continue
    recs.append(snip + "\x1f" + out.rstrip("\n"))
os.makedirs(OUT, exist_ok=True)
open(os.path.join(OUT, "declare_f.txt"), "w", encoding="utf-8", errors="surrogateescape").write("\x1e".join(recs))

ERRS = [
    "echo a; fi", "if true; then", "echo x\nfoo\nif\n", "while; do :; done", "echo a;;",
    "&& echo", "echo a &&", "echo \"abc", "echo 'abc", "echo $(a", "[[ a b ]]", "[[ -q x ]]",
    "[[ ( a ]]", "[[ a", "[[ a == ]]", "[[ ! ]]", "echo ${a", "$(case x in a) ;;", "a=(1 2",
    "echo `a", "f() ", "for ((a;b", "for ((a;b)) do :; done", "((a", "case x in a) ;; b",
    "echo $((1+2)", "(a", "a; }", "echo $(( ", "echo $'a", "if a; then b; else",
    "x=$(echo) )", "a | ;", "a |", "coproc", "function", "echo ${ a;", "echo ${| a",
    "for x in a b", "select", "case", "case x", "case x in", "while :; do", "{ a",
    "echo $(echo ))", "[[ a == b c ]]", "[[ a && ]]", "[[ ( a ) b ]]", "[[ -f ]]",
    "[[ a =~ ]]", "[[ ]]", "[[ a ; ]]", "[[ a == b", "[[ a ==", "a | ! b", "echo a (b)",
    "foo(x)", "f() echo", "function f echo", "a=1 (b)", "case x in a) b;; esac c",
    "if a; then b; fi c", "{ a; } b", "$(fi)", "echo $(echo ;;)", "case x in esac) echo done; esac",
    "case in do do) echo in; esac", "for()", "a=(b ; c)", "echo >", "echo <<", "cat <&",
    "f() { a; } }", "((", "for", "for ((a;b;c;d)); do :; done", "x=`", "echo \"$(", "echo $(\n",
    "echo )", "( )", "{ }", "if then fi", "! !", "time |", "a &&& b", "a || || b",
    "echo ${x", "echo \"${x\"", "case x in (a|) ;; esac",
]
recs = []
for src in ERRS:
    rc, out, err = bash(src)
    lines = [l for l in err.split("\n") if l.startswith(BASH + ": -c: line ")]
    if rc == 0 or not lines:
        print("noerr", repr(src), rc, err.strip(), file=sys.stderr)
        continue
    recs.append(src + "\x1f" + "\n".join(l[len(BASH) + 2:] for l in lines))
open(os.path.join(OUT, "errors.txt"), "w", encoding="utf-8", errors="surrogateescape").write("\x1e".join(recs))

ALIASES = [
    ("ll=ls -l", "ll x"),
    ("e=echo ", "e e e"),
    ("e=echo |a=b ", "e a x"),
    ("q=echo 'Err:", "q bar'"),
    ("m=a=1 b=2", "m c"),
    ("sp= |f=foo", "sp f x"),
    ("p=printf '%s\\n' |w=world", "p w"),
    ("l=ls|g=grep", "l | g x"),
    ("r=echo a; echo b", "r c"),
    ("i=if true; then echo", "i x; fi"),
    ("c=#", "c foo bar"),
    ("x=xtra", "echo x"),
    ("echo=echo a", "echo b"),
    ("hd=cat <<EOF", "hd\nbody\nEOF"),
]
recs = []
for defs, body in ALIASES:
    script = "shopt -s expand_aliases\n"
    for d in defs.split("|"):
        name, val = d.split("=", 1)
        script += "alias " + name + "=" + "'" + val.replace("'", "'\\''") + "'\n"
    script += "f(){ " + body + "\n}\ndeclare -f f"
    rc, out, err = bash(script)
    if rc != 0 or err:
        print("aliasskip", defs, body, err.strip(), file=sys.stderr)
        continue
    recs.append(defs + "\x1f" + body + "\x1f" + out.rstrip("\n"))
open(os.path.join(OUT, "aliases.txt"), "w", encoding="utf-8", errors="surrogateescape").write("\x1e".join(recs))
print("ok", file=sys.stderr)
