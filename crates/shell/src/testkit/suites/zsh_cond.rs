//! zsh conditions (a port of zsh 5.9 `cond.c` and the test
//! grammar of `parse.c`): `[[ ]]` primaries in zsh code, `=~` with zsh's
//! match variables, `-o` statuses, and the `test`/`[` builtin's grammar
//! and messages. Expected output comes from `/bin/zsh -f -c` 5.9.

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
fn unknown_condition_abandons_the_line() {
	let (out, err, st) = zsh("[[ -fail badly ]]; echo $?");
	assert_eq!(out, "");
	assert_eq!(err, "zsh:1: unknown condition: -fail\n");
	assert_eq!(st, 2);
}

#[test]
fn patterns_and_arithmetic_operands() {
	let (out, ..) = zsh("[[ a = a* && b != c ]]; echo $?; [[ 3 -lt 04 && 1+1 -eq 2 ]]; echo $?");
	assert_eq!(out, "0\n0\n");
}

#[test]
fn unknown_option_is_status_3_even_negated() {
	let (out, err, _) = zsh("[[ -o invalidoption ]]; echo $?; [[ ! -o invalidoption ]]; echo $?");
	assert_eq!(out, "3\n3\n");
	assert_eq!(err, "zsh:1: no such option: invalidoption\nzsh:1: no such option: invalidoption\n");
}

#[test]
fn test_builtin_messages() {
	let (out, err, _) = zsh("test -n foo scramble; echo $?; [ a; echo $?; test 1 -eq a; echo $?");
	assert_eq!(out, "2\n2\n2\n");
	assert_eq!(
		err,
		"zsh:test:1: too many arguments\nzsh:[:1: ']' expected\nzsh:test:1: integer expression \
		 expected: a\n"
	);
}

#[test]
fn test_treats_bang_as_a_string_sometimes() {
	let (out, ..) =
		zsh(r#"for w in "! -a !" "! = !" "! !" "= -a o"; do eval test $w; print -n $?; done; echo"#);
	assert_eq!(out, "0010\n");
}

#[test]
fn regex_match_sets_zsh_match_variables() {
	let (out, ..) = zsh(
		r#"[[ "this has stuff in it" =~ "h([a-z]*) s([a-z]*) " ]] && print -r "$MATCH|$MBEGIN|$MEND|$match|$mbegin|$mend""#,
	);
	assert_eq!(out, "has stuff |6|15|as tuff|7 11|8 14\n");
}

#[test]
fn v_tests_array_elements() {
	let (out, ..) = zsh("arr=(1 2 3); [[ -v arr[2] && ! -v arr[5] && -v arr ]]; echo $?");
	assert_eq!(out, "0\n");
}
