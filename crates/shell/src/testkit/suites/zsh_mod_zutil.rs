//! zsh/zutil (ports of zsh 5.9 `Src/Modules/zutil.c`): `zstyle`,
//! `zparseopts`, `zformat`, `zregexparse`. Expected output comes from
//! `/bin/zsh -f -c` 5.9.

use crate::{
	bash::{ModeId, Script, ShellInit},
	testkit::{FakeHost, Fault, Rig, fault::skeleton_init},
};

/// Run `src` as `zsh -c src`: stdout, stderr, status.
fn zsh(src: &str) -> (String, String, i32) {
	let init = ShellInit { mode: ModeId::Zsh, argv0: "zsh".into(), ..skeleton_init(&[]) };
	let mut rig = Rig::new(FakeHost::new(), init);
	let status = rig.run(Script::command(src.as_bytes().to_vec()), Fault::None);
	(
		String::from_utf8_lossy(&rig.host.stdout.bytes()).into_owned(),
		String::from_utf8_lossy(&rig.host.stderr.bytes()).into_owned(),
		status,
	)
}

/// Patterns list by weight (components, then specificity), styles by name; `-L`
/// filters by context pattern and style.
#[test]
fn zstyle_lists_in_zsh_order() {
	let (out, err, st) = zsh(
		r##"zstyle ":completion:*" menu select; zstyle "*" menu no; zstyle ":completion:*:*:*" menu a b; zstyle ":completion:*:default" menu "x y" "it's"; zstyle -e ":completion:*:foo" menu "reply=(1)"; zstyle ":completion:*" format "%d"; zstyle ":a:(b|c):d" menu q
zstyle; echo ---; zstyle -L; echo ---; zstyle -L ":completion:*"; echo ---; zstyle -L "*" format; echo $?; zstyle -L "*" nostyle; echo $?; zstyle -L a b c; echo $?; zstyle -L "("; echo $?"##,
	);
	assert_eq!(
		out,
		r##"format
        :completion:* %d
menu
        :completion:*:*:* a b
        :a:(b|c):d q
        :completion:*:default 'x y' 'it'\''s'
(eval)  :completion:*:foo 'reply=(1)'
        :completion:* select
        * no
---
zstyle ':completion:*' format %d
zstyle ':completion:*:*:*' menu a b
zstyle ':a:(b|c):d' menu q
zstyle ':completion:*:default' menu 'x y' 'it'\''s'
zstyle -e ':completion:*:foo' menu 'reply=(1)'
zstyle ':completion:*' menu select
zstyle '*' menu no
---
zstyle ':completion:*' format %d
zstyle ':completion:*:*:*' menu a b
zstyle ':completion:*:default' menu 'x y' 'it'\''s'
zstyle -e ':completion:*:foo' menu 'reply=(1)'
zstyle ':completion:*' menu select
---
zstyle ':completion:*' format %d
0
1
1
1
"##
	);
	assert_eq!(
		err,
		r##"zsh:zstyle:2: too many arguments
"##
	);
	assert_eq!(st, 0);
}

/// `-g`, `-s`, `-b`, `-a`, `-t`, `-T`, `-m` values and statuses.
#[test]
fn zstyle_lookup_forms() {
	let (out, err, st) = zsh(
		r##"zstyle ":c:*" s a b; zstyle ":c:x" s c; zstyle ":d" t yes; zstyle ":d" q; zstyle "*" s z
zstyle -g out; echo $? ${(qq)out}; zstyle -g out ":c:*"; echo $? ${(qq)out}; zstyle -g out ":c:*" s; echo $? ${(qq)out}; zstyle -g out ":nope" s; echo $? ${(t)out} ${(qq)out}
zstyle -s :c:y s v; echo $? "[$v]"; zstyle -s :c:y s v ,; echo $? "[$v]"; zstyle -s :zz nos v; echo $? "[$v]"; zstyle -s :d q v; echo $? "[$v]"
zstyle -b :d t v; echo $? $v; zstyle -b :c:y s v; echo $? $v; zstyle -a :c:x s v; echo $? ${(t)v} $v; zstyle -a :c:x nn v; echo $? ${(t)v} ${#v}
zstyle -t :d t; echo $?; zstyle -t :d nn; echo $?; zstyle -T :d nn; echo $?; zstyle -t :c:y s q b; echo $?; zstyle -t :c:y s q; echo $?; zstyle -t :d q; echo $?; zstyle -T :d q; echo $?
zstyle -m :c:y s "[ab]"; echo $?; zstyle -m :c:y s "x"; echo $?; zstyle -m :c:y s "(" ; echo $?"##,
	);
	assert_eq!(
		out,
		r##"0 ':d' ':c:x' ':c:*' '*'
0 's'
0 'a' 'b'
1 array ''
0 [a b]
0 [a,b]
1 []
1 []
0 yes
1 no
0 array c
1 array 0
0
2
0
0
1
1
0
0
1
1
"##
	);
	assert_eq!(err, r##""##);
	assert_eq!(st, 0);
}

/// Option and argument errors; a bad parameter name abandons the line.
#[test]
fn zstyle_errors() {
	let (out, err, st) = zsh(
		r##"zstyle -x; echo $?; zstyle -sx; echo $?; zstyle -s a; echo $?; zstyle -s a b c d e; echo $?; zstyle -Lx; echo $?; zstyle a; echo $?; zstyle "(" s v; echo $?; zstyle -s :x s 1bad; echo $?; echo notreached"##,
	);
	assert_eq!(
		out,
		r##"1
1
1
1
1
1
1
"##
	);
	assert_eq!(
		err,
		r##"zsh:zstyle:1: invalid option: -x
zsh:zstyle:1: invalid argument: -sx
zsh:zstyle:1: not enough arguments
zsh:zstyle:1: too many arguments
zsh:zstyle:1: invalid argument: -Lx
zsh:zstyle:1: not enough arguments
zsh:zstyle:1: invalid pattern: (
zsh:1: not an identifier: 1bad
"##
	);
	assert_eq!(st, 1);
}

/// `-d` by pattern, by pattern and styles, and everything.
#[test]
fn zstyle_delete() {
	let (out, err, st) = zsh(
		r##"zstyle ":c:*" s a b; zstyle ":c:x" s c; zstyle ":d" t yes; zstyle ":d" q; zstyle "*" s z
zstyle -d ":c:*" s; zstyle -L; echo; zstyle -d ":d"; zstyle -L; echo; zstyle -d; zstyle -L; echo $?
zstyle :a x 1; zstyle :a y 2; zstyle :b x 3; zstyle -d :a x y z; zstyle -L"##,
	);
	assert_eq!(
		out,
		r##"zstyle :d q
zstyle :c:x s c
zstyle '*' s z
zstyle :d t yes

zstyle :c:x s c
zstyle '*' s z

0
zstyle :b x 3
"##
	);
	assert_eq!(err, r##""##);
	assert_eq!(st, 0);
}

/// More specific patterns win; redefining a pattern keeps its place.
#[test]
fn zstyle_weights_and_replace() {
	let (out, err, st) = zsh(
		r##"zstyle "*" s 1; zstyle ":a:*" s 2; zstyle ":a:b" s 3; zstyle ":a:b*" s 4; zstyle ":*:b" s 5; zstyle ":a:b" s 6
zstyle -L; for c in :a:b :a:bc :a:x :q:b :z; do zstyle -s $c s v; echo $c $v; done"##,
	);
	assert_eq!(
		out,
		r##"zstyle :a:b s 6
zstyle ':a:b*' s 4
zstyle ':a:*' s 2
zstyle ':*:b' s 5
zstyle '*' s 1
:a:b 6
:a:bc 4
:a:x 2
:q:b 5
:z 1
"##
	);
	assert_eq!(err, r##""##);
	assert_eq!(st, 0);
}

/// `-e` values run as code setting `reply`, in the `style` eval context, with
/// `match` restored.
#[test]
fn zstyle_eval_values() {
	let (out, err, st) = zsh(
		r##"zstyle -e ":x" s "echo \${zsh_eval_context[-1]}; echo \$LINENO; reply=a"; zstyle -s ":x" s v; echo $v
zstyle -e ":y" s "reply=(\$match); [[ abc = (#b)(a)* ]]"; setopt extendedglob; [[ zz = (#b)(z)* ]]; zstyle -a :y s v; echo "$v / $match"
zstyle -e :w s ""; zstyle -a :w s v; echo $? ${#v}; reply=(keep); zstyle -a :w s v; echo $? ${#v} ${+reply}
zstyle -e ":m" s "reply=(one two)"; zstyle -s :m s v -; echo $v; zstyle -t :m s two; echo $?; zstyle -L :m"##,
	);
	assert_eq!(
		out,
		r##"style
1
a
z / z
1 0
1 0 0
one-two
0
zstyle -e :m s 'reply=(one two)'
"##
	);
	assert_eq!(err, r##""##);
	assert_eq!(st, 0);
}

/// An error in `-e` code yields no value; a parse error at definition keeps the
/// style name.
#[test]
fn zstyle_eval_errors() {
	let (out, err, st) = zsh(
		r##"zstyle -e ":x" s "reply=(a b); echo \$(( 1 + )); echo after"; zstyle -s ":x" s v; echo "st=$? v=$v"; zstyle -t :x s; echo $?; zstyle -e :p s "a=("; echo $?; zstyle; zstyle -L; echo end"##,
	);
	assert_eq!(
		out,
		r##"st=1 v=
2
1
s
(eval)  :x 'reply=(a b); echo $(( 1 + )); echo after'
zstyle -e :x s 'reply=(a b); echo $(( 1 + )); echo after'
end
"##
	);
	assert_eq!(
		err,
		r##"zsh:1: bad math expression: operand expected at end of string
zsh:1: bad math expression: operand expected at end of string
zsh:1: parse error near `a'
"##
	);
	assert_eq!(st, 0);
}

/// `-e` code reports errors at the lines it was defined at.
#[test]
fn zstyle_eval_error_lines() {
	let (out, err, st) = zsh(
		r##"zstyle -e :x s $'\n\necho $((1+))'
f() {

 zstyle -s :x s v
}
f
zstyle -e :y s $'\n\n(('
echo $?"##,
	);
	assert_eq!(
		out,
		r##"1
"##
	);
	assert_eq!(
		err,
		r##"f:3: bad math expression: operand expected at end of string
zsh:9: parse error
"##
	);
	assert_eq!(st, 0);
}

/// Unloading zsh/zutil drops the style table.
#[test]
fn zstyle_table_dropped_by_unload() {
	let (out, err, st) =
		zsh(r##"zstyle :x s v; zmodload -u zsh/zutil; zmodload zsh/zutil; zstyle -L; echo $?"##);
	assert_eq!(
		out,
		r##"0
"##
	);
	assert_eq!(err, r##""##);
	assert_eq!(st, 0);
}

/// Subshells see the styles; their changes stay theirs.
#[test]
fn zstyle_seen_by_subshells() {
	let (out, err, st) = zsh(
		r##"zstyle :x s v; (zstyle -s :x s r; echo $r; zstyle :y s w); zstyle -L; echo $(zstyle -L)"##,
	);
	assert_eq!(
		out,
		r##"v
zstyle :x s v
zstyle :x s v
"##
	);
	assert_eq!(err, r##""##);
	assert_eq!(st, 0);
}

/// Spec forms, `-D`, `-E`, `-a`, escaped names, `-` and `--`.
#[test]
fn zparseopts_arrays_and_removal() {
	let (out, err, st) = zsh(
		r##"t() { print -r -- "$*"; }
set -- -a -b x -cfoo -d -e1 rest -a
zparseopts a=A b:=B c::=C d=D e:-=E; t $? "A=${(qq)A}" "B=${(qq)B}" "C=${(qq)C}" "D=${(qq)D}" "E=${(qq)E}" "@=$*"
set -- -a -b x -cfoo -d -e1 rest -a
zparseopts -D a=A b:=B c::=C d=D e:-=E; t $? "A=${(qq)A}" "B=${(qq)B}" "C=${(qq)C}" "D=${(qq)D}" "E=${(qq)E}" "@=$*"
set -- x -a -q -b y -- -a z
zparseopts -D -E a+=A b:=B; t $? "A=${(qq)A}" "B=${(qq)B}" "@=$*"
set -- -a -a -b1 -b2
zparseopts a+=A b+:=B; t $? "A=${(qq)A}" "B=${(qq)B}"
set -- -a -c 3 -bxyz
zparseopts -a ALL a b: c:; t $? "ALL=${(qq)ALL}"
set -- -foo bar -foobar -verbose
zparseopts foo:=F verbose=V; t $? "F=${(qq)F}" "V=${(qq)V}"
set -- -c -x
zparseopts c::=C x=X; t $? "C=${(qq)C}" "X=${(qq)X}"
set -- -a\\b -x
zparseopts 'a\\b=A' x=X; t $? "A=${(qq)A}" "X=${(qq)X}"
set -- -+ -a
zparseopts '+=P' a=A; t $? "P=${(qq)P}" "A=${(qq)A}"
set -- - -a
zparseopts a=A; t $? "A=${(qq)A}" "@=$*"
set -- -a - -a
zparseopts -D -E a=A; t $? "A=${(qq)A}" "@=$*"
set -- -a -- -a
zparseopts -D a=A; t $? "A=${(qq)A}" "@=$*""##,
	);
	assert_eq!(
		out,
		r##"0 A='-a' B='-b x' C='-cfoo' D='-d' E='-e1' @=-a -b x -cfoo -d -e1 rest -a
0 A='-a' B='-b x' C='-cfoo' D='-d' E='-e1' @=rest -a
0 A='-a' B='-b y' @=x -q -- -a z
0 A='-a -a' B='-b 1 -b 2'
0 ALL='-a -c 3 -b xyz'
0 F='-foo bar' V='-verbose'
0 C='-c' X='-x'
0 A='-a\b' X='-x'
0 P='-+' A='-a'
0 A='' @=- -a
0 A='-a' @=- -a
0 A='-a' @=-a
"##
	);
	assert_eq!(err, r##""##);
	assert_eq!(st, 0);
}

/// `-A`, `-K` and `-M`.
#[test]
fn zparseopts_assoc_keep_map() {
	let (out, err, st) = zsh(
		r##"t() { print -r -- "$*"; }
set -- -a -c 3 -c 4 -bxyz
zparseopts -A H a b: c+:; t $? "${(qq@)${(kv)H[-c]}}" "${(qq)H[-a]}" "${(qq)H[-b]}" ${(o)${(k)H}}
A=(keep); set -- -z
zparseopts -K a=A; t $? "A=${(qq)A}"
A=(keep); set -- -a
zparseopts -K a=A; t $? "A=${(qq)A}"
typeset -A H2; H2=(-x def); set -- -a
zparseopts -K -A H2 a x:; t $? "${(qq)H2[-x]}" "${(qq)H2[-a]}" ${(o)${(k)H2}}
set -- -a -b -c
zparseopts -M a=A b=a c=b; t $? "A=${(qq)A}""##,
	);
	assert_eq!(
		out,
		r##"0 '34' '' 'xyz' -a -b -c
0 A='keep'
0 A='-a'
0 'def' '' -a -x
0 A='-a'
"##
	);
	assert_eq!(err, r##""##);
	assert_eq!(st, 0);
}

/// `-F` failures and description errors.
#[test]
fn zparseopts_errors() {
	let (out, err, st) = zsh(
		r##"t() { print -r -- "$*"; }
set -- -q
zparseopts -F a=A; t $? "A=${(qq)A}"
set -- --q
zparseopts -F a=A; t $?
set -- -aq
zparseopts -F a=A; t $?
set -- -b
zparseopts b:=B; t $? "B=${(qq)B}"
zparseopts; t $?
zparseopts -a; t $?
zparseopts -a x -a y; t $?
zparseopts -A x -A y; t $?
zparseopts a; t $?
zparseopts a=A a=B; t $?
zparseopts "a?"; t $?
zparseopts ""; t $?
zparseopts -M a=b b=a; t $?
zparseopts "a+x"; t $?
set -- -a -b
zparseopts -D -F -- a=A; t $? "@=$*"
zparseopts a=1x; t $?; t notreached"##,
	);
	assert_eq!(
		out,
		r##"1 A=''
1
1
1 B=''
1
1
1
1
1
1
1
1
1
1
1 @=-a -b
"##
	);
	assert_eq!(
		err,
		r##"zsh:zparseopts:3: bad option: -q
zsh:zparseopts:5: bad option: --q
zsh:zparseopts:7: bad option: -q
zsh:zparseopts:9: missing argument for option: -b
zsh:zparseopts:10: not enough arguments
zsh:zparseopts:11: missing array name
zsh:zparseopts:12: default array given more than once
zsh:zparseopts:13: associative array given more than once
zsh:zparseopts:14: no default array defined: a
zsh:zparseopts:15: option defined more than once: a
zsh:zparseopts:16: no default array defined: a?
zsh:zparseopts:17: invalid option description: 
zsh:zparseopts:18: cyclic option mapping: b=a
zsh:zparseopts:19: invalid option description: a+x
zsh:zparseopts:21: bad option: -b
zsh:22: not an identifier: 1x
"##
	);
	assert_eq!(st, 0);
}

/// `-f` widths, precision, ternaries with numeric tests, `-F` presence tests.
#[test]
fn zformat_f_and_ternaries() {
	let (out, err, st) = zsh(
		r##"t() { print -r -- "$*"; }
zformat -f o "a%xb%-5yc%5yd%.2ze%%f%)g%qh" x:XX y:Y z:zzzz; t "[$o]"
zformat -f o "%(x.yes.no) %(y.yes.no) %(n.yes.no)" x:1 y:0; t "[$o]"
zformat -f o "%3(x.ge3.lt3) %(-2x.a.b) %-2(x.a.b)" x:3; t "[$o]"
zformat -f o "%(x.%(y.A.B).C)|%(x:t:f)|%(x" x:0 y:0; t "[$o]"
zformat -F o "%(x.set.unset) %(y.set.unset) %2(x.ge.lt) %-2(x.l.g)" x:abc y:; t "[$o]"
zformat -f o "%(x.a.b" x:0; t $? "[$o]"
zformat -f o "%5.2x|%-5.2x|" x:abcdef; t "[$o]"
zformat -f o "%(x.a.b)" x:1+1-2; t "[$o]"
zformat -f o "abc%" x:3; t "[$o]"; zformat -f o "a%(" x:3; t "[$o]"; zformat -f o "%10(x.a.b)" x:3; t "[$o]""##,
	);
	assert_eq!(
		out,
		r##"[aXXb    YcY    dzze%f)g%qh]
[no yes yes]
[ge3 b b]
[A|t|]
[set unset ge g]
0 [a]
[ab   |   ab|]
[a]
[abc%]
[a%(]
[b]
"##
	);
	assert_eq!(err, r##""##);
	assert_eq!(st, 0);
}

/// Argument errors; a math error abandons the line after the result is set.
#[test]
fn zformat_errors() {
	let (out, err, _) = zsh(
		r##"t() { print -r -- "$*"; }
zformat -f o "abc" ab:c; t $?
zformat -f o "abc" 1:c; t $?
zformat -f o "abc" -:c; t $?
zformat -f o "abc" :c; t $?
zformat -x o a; t $?
zformat -ff o a; t $?
zformat f o a; t $?
zformat -a o; t $?
{ zformat -f o "%(x.a.b)z" x:"1+"; } always { t st=$? $o }"##,
	);
	assert_eq!(
		out,
		r##"1
1
1
1
1
1
1
1
st=0 az
"##
	);
	assert_eq!(
		err,
		r##"zsh:zformat:2: invalid argument: ab:c
zsh:zformat:3: invalid argument: 1:c
zsh:zformat:4: invalid argument: -:c
zsh:zformat:5: invalid argument: :c
zsh:zformat:6: invalid option: -x
zsh:zformat:7: invalid argument: -ff
zsh:zformat:8: invalid argument: f
zsh:zformat:9: not enough arguments
zsh:10: bad math expression: operand expected at end of string
"##
	);
}

/// `-a` aligns the separators, honouring backslash escapes.
#[test]
fn zformat_a_columns() {
	let (out, err, st) = zsh(
		r##"t() { print -r -- "$*"; }
zformat -a o : a:b ccc:d "e\:f:g" noval "h:" ; t $? ${(qq)o}
zformat -a o " -- " 'a\\b:x' c:y; t ${(qq)o}"##,
	);
	assert_eq!(
		out,
		r##"0 'a  :b' 'ccc:d' 'e:f:g' 'noval' 'h'
'a\b -- x' 'c   -- y'
"##
	);
	assert_eq!(err, r##""##);
	assert_eq!(st, 0);
}

/// Matching, cutoffs, `[]`, lookahead, statuses and parse errors.
#[test]
fn zregexparse_basics() {
	let (out, err, st) = zsh(
		r##"t() { print -r -- "$*"; }
zregexparse p1 p2 "abc" /a/ /b/ /c/; t $? $p1 $p2
zregexparse p1 p2 "ab" /a/ /b/ /c/; t $? $p1 $p2
zregexparse p1 p2 "abd" /a/ /b/ /c/; t $? $p1 $p2
zregexparse p1 p2 "ab" '/a/-' /b/; t $? $p1 $p2
zregexparse p1 p2 "ab" '/a/+' /b/; t $? $p1 $p2
zregexparse p1 p2 "ab" '/[]/' '/a/' /b/; t $? $p1 $p2
zregexparse p1 p2 "abc" /a/ '%b%' /b/ /c/; t $? $p1 $p2
zregexparse p1 p2 "abc" /a/ '%c%' /b/ /c/; t $? $p1 $p2
zregexparse p1 p2 "abc" ; t $? $p1 $p2
zregexparse p1 p2 "a b" '/a/' '/ /' '/b/'; t $? $p1 $p2
zregexparse p1 p2 "abc" /a/ ')' ; t $?
zregexparse p1 p2 "abc" '(' /a/ ; t $?
zregexparse p1 p2 "abc" /a; t $?
typeset -p p1 p2"##,
	);
	assert_eq!(
		out,
		r##"0 3 3
1 2 2
1 2 2
0 2 2
0 2 2
1 0 0
0 3 3
1 0 0
2 0 0
0 3 3
3
3
3
typeset -i p1=3
typeset -i p2=3
"##
	);
	assert_eq!(
		err,
		r##"zsh:zregexparse:12: invalid regex : )
zsh:zregexparse:13: not enough regex arguments
zsh:zregexparse:14: invalid regex : /a
"##
	);
	assert_eq!(st, 0);
}

/// Actions, guards, `#`, `|`, null actions, `-c`, and `match` as actions see
/// it.
#[test]
fn zregexparse_actions_and_guards() {
	let (out, err, _) = zsh(
		r##"t() { print -r -- "$*"; }
zregexparse p1 p2 "abc" /a/ ':t act-a' /b/ ':t act-b' /c/ ':t act-c'; t $? $p1 $p2
zregexparse p1 p2 "ab" /a/ ':t act-a' /b/ ':t act-b' /c/ ':t act-c'; t $? $p1 $p2
zregexparse -c p1 p2 "ab" /a/ ':t act-a' /b/ ':t act-b' /c/ ':t act-c'; t $? $p1 $p2
zregexparse p1 p2 "aaab" '(' /a/ '{t A $match}' ')' '#' /b/ '{t B}'; t $? $p1 $p2
zregexparse p1 p2 "xyz" '(' /x/ '{t X}' '|' /y/ '{t Y}' ')' '#' /z/ '{t Z}'; t $? $p1 $p2
zregexparse p1 p2 "" '{t null}' /a/; t $? $p1 $p2
zregexparse p1 p2 "" /a/ '#' '{t null2}'; t $? $p1 $p2
zregexparse p1 p2 "abc" '/(a)/' '-[[ $match[1] = a ]]' '{t g $match}' /bc/; t $? $p1 $p2
zregexparse p1 p2 "abc" '/(a)/' '-false' /bc/; t $? $p1 $p2
match=(pre) mbegin=(9) mend=(9)
zregexparse p1 p2 "xyz" '/(x)/' '{t A $match / $mbegin / $mend}' '/y/' '-t G $match / $mend' '{t B $match}' /z/
t $? $match / $mend
zregexparse p1 p2 "a" '/a/' '{t ${zsh_eval_context[-1]}; [[ -o extendedglob ]] && t eg}'; [[ -o extendedglob ]] || t noeg
false; zregexparse p q "x" /x/ "-" ; t $?
{ zregexparse p1 p2 "xyz" /x/ '{echo $((1+)); echo A}' /y/ '{echo B}' /z/ '{echo C}'; } always { t st=$? $p1 $p2 }"##,
	);
	assert_eq!(
		out,
		r##"0 3 3
act-c
1 2 2
act-c
1 2 2
A a
A a
A a
B
0 4 4
X
Y
Z
0 3 3
1 0 0
null2
0 0 0
g a
0 3 3
1 0 0
G y / 1
A x / 1 / 1
B y
0 z / 1
zregexparse-action
eg
noeg
0
st=1 2 2
"##
	);
	assert_eq!(
		err,
		r##"zsh:16: bad math expression: operand expected at end of string
"##
	);
}
