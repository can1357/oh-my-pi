//! zsh builtins (ports of zsh 5.9 `builtin.c`): option
//! parsing and messages, `print`/`echo`/`printf`, the `typeset` family and
//! its listings, `set -A`, `shift`, `whence`, `functions`, `alias`,
//! `zmodload`, `disable -p`, `let`, `getopts` and `print -P`. Expected
//! output comes from `/bin/zsh -f -c` 5.9.

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

#[test]
fn print_options_and_escapes() {
	let (out, _, st) = zsh(r#"print -l a b; print -n x; print -r -- "a\tb"; print "a\tb""#);
	assert_eq!(out, "a\nb\nxa\\tb\na\tb\n");
	assert_eq!(st, 0);
}

#[test]
fn echo_interprets_escapes_by_default() {
	let (out, ..) = zsh(r#"echo -n x\\ny; echo; echo -E "a\\tb""#);
	assert_eq!(out, "x\ny\na\\tb\n");
}

#[test]
fn printf_reuses_format_and_formats_numbers() {
	let (out, ..) =
		zsh(r#"printf "%5.2f|%-3d|%x|%s\n" 3.14159 7 255 str; printf "%s-" a b c; echo"#);
	assert_eq!(out, " 3.14|7  |ff|str\na-b-c-\n");
}

#[test]
fn print_f_evaluates_integer_arguments_as_math() {
	let (out, ..) = zsh(r#"print -f "%s=%d\n" a 1+1 b 3"#);
	assert_eq!(out, "a=2\nb=3\n");
}

#[test]
fn print_columns_and_pattern_filter() {
	let (out, ..) = zsh(r#"print -C2 a b c d; print -m "a*" abc bcd ade"#);
	assert_eq!(out, "a  c\nb  d\nabc ade\n");
}

#[test]
fn bad_option_is_reported_under_the_builtin_name() {
	let (out, err, st) = zsh("print -bad");
	assert_eq!(out, "");
	assert_eq!(err, "zsh:print:1: bad option: -d\n");
	assert_eq!(st, 1);
}

#[test]
fn integer_and_float_listings() {
	let (out, ..) = zsh("integer i=3+4; typeset -p i; float f=1.5; typeset -p f");
	assert_eq!(out, "typeset -i i=7\ntypeset -E f=1.500000000e+00\n");
}

#[test]
fn association_listing_in_zsh_order() {
	let (out, ..) = zsh("typeset -A h=(b 2 a 1); typeset -p h");
	assert_eq!(out, "typeset -A h=( [a]=1 [b]=2 )\n");
}

#[test]
fn local_array_type_listing() {
	let (out, ..) = zsh("f(){ local -a arr=(1 2); typeset +m arr; typeset -p arr }; f");
	assert_eq!(out, "array local arr\ntypeset -a arr=( 1 2 )\n");
}

#[test]
fn tied_parameters_list_the_array_value() {
	let (out, ..) = zsh("typeset -T PTH=a:b pth; print -l $pth; typeset -p PTH pth");
	assert_eq!(out, "a\nb\ntypeset -T PTH pth=( a b )\ntypeset -aT PTH pth=( a b )\n");
}

#[test]
fn readonly_assignment_fails() {
	let (_, err, st) = zsh("readonly r=1; r=2");
	assert_eq!(err, "zsh:1: read-only variable: r\n");
	assert_eq!(st, 1);
}

#[test]
fn set_a_and_shift() {
	let (out, ..) = zsh("set -A arr x y z; print $arr[2]; set -- p q; shift; print $1");
	assert_eq!(out, "y\nq\n");
	let (_, err, st) = zsh("shift 5");
	assert_eq!(err, "zsh:shift:1: shift count must be <= $#\n");
	assert_eq!(st, 1);
}

#[test]
fn whence_word_forms() {
	let (out, ..) = zsh("whence -w print typeset nonexist; echo $?");
	assert_eq!(out, "print: builtin\ntypeset: reserved\nnonexist: none\n1\n");
}

#[test]
fn functions_prints_zsh_text() {
	// Split so the braces do not read as format strings.
	let (out, ..) = zsh(&["f(){", " :; }; functions f"].concat());
	assert_eq!(out, ["f () {", "\n\t:\n}\n"].concat());
}

#[test]
fn zmodload_accepts_built_in_modules_only() {
	let (out, err, _) = zsh("zmodload zsh/parameter && echo ok; zmodload zsh/regex; echo $?");
	assert_eq!(out, "ok\n1\n");
	assert_eq!(err, "zsh:zmodload:1: failed to load module: zsh/regex\n");
}

#[test]
fn disable_p_lists_disabled_pattern_characters() {
	let (out, ..) = zsh(r#"disable -p "*("; disable -p; enable -p "*("; disable -p"#);
	assert_eq!(out, "'*('\n");
}

#[test]
fn let_status_follows_the_last_value() {
	let (out, ..) = zsh(r#"let "x = 2 + 3" "x * 0"; echo $? $x"#);
	assert_eq!(out, "1 5\n");
}

#[test]
fn unset_m_without_match_fails() {
	let (out, ..) = zsh(r#"unset -m "zz*"; echo $?"#);
	assert_eq!(out, "1\n");
}

#[test]
fn getopts_keeps_position_in_optind() {
	let (out, ..) = zsh("getopts ab: o -a; echo $o $OPTIND; getopts ab: o -b; echo $o");
	assert_eq!(out, "a 1\na\n");
}

#[test]
fn print_p_expands_prompt_escapes() {
	let (out, ..) = zsh(r#"print -P "%% %?""#);
	assert_eq!(out, "% 0\n");
}
