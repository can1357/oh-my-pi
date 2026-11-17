//! zsh/pcre: `pcre_compile`, `pcre_study`, `pcre_match`, the
//! `-pcre-match` condition and `=~` under `REMATCH_PCRE`. Expected output
//! comes from `/bin/zsh -f -c` 5.9 (PCRE1 messages and error codes).

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

/// `(out, "", 0)`.
fn ok(out: &str) -> (String, String, i32) {
	(out.into(), String::new(), 0)
}

/// `(out, err, 0)`.
fn warned(out: &str, err: &str) -> (String, String, i32) {
	(out.into(), err.into(), 0)
}

#[test]
fn pcre_builtins_need_the_module_and_a_pattern() {
	assert_eq!(
		zsh("pcre_compile a; echo $?"),
		warned("127\n", "zsh:1: command not found: pcre_compile\n")
	);
	assert_eq!(
		zsh("zmodload zsh/pcre; pcre_match a; echo $?"),
		warned("1\n", "zsh:pcre_match:1: no pattern has been compiled\n")
	);
	assert_eq!(
		zsh("zmodload zsh/pcre; pcre_study; echo $?"),
		warned("1\n", "zsh:pcre_study:1: no pattern has been compiled for study\n")
	);
	assert_eq!(
		zsh("zmodload zsh/pcre; pcre_compile; echo $?"),
		warned("1\n", "zsh:pcre_compile:1: not enough arguments\n")
	);
	assert_eq!(
		zsh("zmodload zsh/pcre; pcre_compile -q a; echo $?"),
		warned("1\n", "zsh:pcre_compile:1: bad option: -q\n")
	);
}

#[test]
fn pcre_compile_errors_are_pcre1s() {
	assert_eq!(
		zsh(r#"zmodload zsh/pcre; pcre_compile "(abc"; echo $?; pcre_match abc; echo $?"#),
		warned(
			"1\n1\n",
			"zsh:pcre_compile:1: error in regex: missing )\nzsh:pcre_match:1: no pattern has been \
			 compiled\n"
		)
	);
	for (re, msg) in [
		("*a", "nothing to repeat"),
		("a)", "unmatched parentheses"),
		("[a", "missing terminating ] for character class"),
		("(?<=a+)b", "lookbehind assertion is not fixed length"),
		("a{3,1}", "numbers out of order in {} quantifier"),
	] {
		assert_eq!(
			zsh(&format!("zmodload zsh/pcre; pcre_compile '{re}'; echo $?")),
			warned("1\n", &format!("zsh:pcre_compile:1: error in regex: {msg}\n")),
			"{re}"
		);
	}
}

#[test]
fn pcre_match_sets_match_and_captures() {
	assert_eq!(
		zsh(
			r#"zmodload zsh/pcre; pcre_compile '(\w+)@(\w+)?(x)?'; pcre_study; echo $?; pcre_match -- 'mail: joe@ here'; echo $? $MATCH ${#match} "${(q)match[@]}""#
		),
		ok("0\n0 joe@ 1 joe\n")
	);
	assert_eq!(
		zsh(
			r#"zmodload zsh/pcre; pcre_compile 'o(x)?'; pcre_match -v m -a arr foo; echo $? $m ${#arr} ${+MATCH} ${+match}"#
		),
		ok("0 o 0 0 0\n")
	);
}

#[test]
fn pcre_match_offsets() {
	assert_eq!(
		zsh(
			"zmodload zsh/pcre; pcre_compile 'b(c)'; pcre_match -b abcbc; echo $? $ZPCRE_OP $MATCH \
			 $match; pcre_match -b -n 2 abcbc; echo $? $ZPCRE_OP; pcre_match -n 5 abcbc; echo $?; \
			 pcre_match -n 4 abcbc; echo $?"
		),
		ok("0 1 3 bc c\n0 3 5\n1\n1\n")
	);
	assert_eq!(
		zsh(
			"zmodload zsh/pcre; pcre_compile a; pcre_match -n x a; echo $?; pcre_match -n -1 a; echo \
			 $?; pcre_match -n ' 0' a; echo $?"
		),
		warned(
			"1\n1\n0\n",
			"zsh:pcre_match:1: integer expected: x\nzsh:pcre_match:1: integer expected: -1\n"
		)
	);
}

#[test]
fn pcre_compile_options() {
	assert_eq!(
		zsh(
			"zmodload zsh/pcre; pcre_compile -i ABC; pcre_match xabcx; echo $? $MATCH; pcre_compile \
			 ABC; pcre_match xabcx; echo $?"
		),
		ok("0 abc\n1\n")
	);
	assert_eq!(
		zsh(
			"zmodload zsh/pcre; pcre_compile -a b; pcre_match ab; echo $?; pcre_match ba; echo $? \
			 $MATCH"
		),
		ok("1\n0 b\n")
	);
	assert_eq!(
		zsh(
			"zmodload zsh/pcre; pcre_compile -m '^b$'; pcre_match $'a\\nb'; echo $?; pcre_compile -s \
			 'a.b'; pcre_match $'a\\nb'; echo $?; pcre_compile 'a.b'; pcre_match $'a\\nb'; echo $?"
		),
		ok("0\n0\n1\n")
	);
	assert_eq!(
		zsh("zmodload zsh/pcre; pcre_compile -x 'a b # c'; pcre_match ab; echo $? $MATCH"),
		ok("0 ab\n")
	);
}

#[test]
fn compiled_pattern_is_inherited_by_subshells() {
	assert_eq!(
		zsh("zmodload zsh/pcre; pcre_compile x; (pcre_match x; echo sub $?); pcre_match x; echo $?"),
		ok("sub 0\n0\n")
	);
}

#[test]
fn utf8_subjects() {
	assert_eq!(
		zsh(
			"LANG=en_US.UTF-8; zmodload zsh/pcre; pcre_compile 'l'; pcre_match -b héllo; echo $? \
			 $ZPCRE_OP; pcre_match -n 2 héllo; echo $?"
		),
		warned("0 3 4\n1\n", "zsh:pcre_match:1: error in pcre_exec [-11]\n")
	);
	assert_eq!(
		zsh(r"LANG=en_US.UTF-8; zmodload zsh/pcre; pcre_compile 'l'; pcre_match $'\xff'; echo $?"),
		warned("1\n", "zsh:pcre_match:1: error in pcre_exec [-10]\n")
	);
}

#[test]
fn pcre_match_condition() {
	assert_eq!(
		zsh(
			r#"zmodload zsh/pcre; [[ "x123y" -pcre-match '(\d)(\d)(z)?(\d)' ]]; echo $? $MATCH $MBEGIN $MEND "[$match]" "[$mbegin]" "[$mend]""#
		),
		ok("0 123 2 4 [1 2  3] [2 3 1 4] [2 3 0 4]\n")
	);
	assert_eq!(
		zsh(
			r#"zmodload zsh/pcre; [[ "x12y" -pcre-match '(\d)(z)?' ]]; echo $? "[$match]" "[$mbegin]" "[$mend]""#
		),
		ok("0 [1] [2] [2]\n")
	);
	assert_eq!(
		zsh(r"zmodload zsh/pcre; [[ abc -pcre-match '\w' ]]; echo $? $MATCH ${+match} ${+mbegin}"),
		ok("0 a 0 0\n")
	);
	assert_eq!(
		zsh(r#"zmodload zsh/pcre; [[ abc -pcre-match "(" ]]; echo $?"#),
		warned("1\n", "zsh:1: failed to compile regexp /(/: missing )\n")
	);
	assert_eq!(
		zsh(r#"zmodload zsh/pcre; [[ abc -pcre-match "x" ]]; echo $? ${+MATCH}"#),
		ok("1 0\n")
	);
	assert_eq!(
		zsh("zmodload zsh/pcre; setopt nocasematch; [[ ABC -pcre-match 'b' ]]; echo $?"),
		ok("1\n")
	);
}

#[test]
fn pcre_match_condition_in_utf8() {
	assert_eq!(
		zsh(
			r#"LANG=en_US.UTF-8; zmodload zsh/pcre; [[ "héllo" -pcre-match 'l+' ]]; echo $? $MATCH $MBEGIN $MEND"#
		),
		ok("0 ll 3 4\n")
	);
	assert_eq!(
		zsh(
			r#"LANG=en_US.UTF-8; zmodload zsh/pcre; [[ "héllo" -pcre-match 'h.l' ]]; echo $? $MATCH"#
		),
		ok("0 hél\n")
	);
	assert_eq!(
		zsh(r#"zmodload zsh/pcre; [[ "héllo" -pcre-match 'h.l' ]]; echo $? $MATCH"#),
		ok("1\n")
	);
}

#[test]
fn rematchpcre_routes_eq_tilde_to_pcre() {
	assert_eq!(
		zsh("setopt rematchpcre; [[ abc =~ 'b(?=c)' ]]; echo $? $MATCH; zmodload"),
		ok("0 b\nzsh/main\nzsh/pcre\n")
	);
	assert_eq!(
		zsh(
			"setopt rematchpcre; [[ ABC =~ 'b' ]]; echo $?; setopt nocasematch; [[ ABC =~ 'b' ]]; \
			 echo $? $MATCH"
		),
		ok("1\n0 B\n")
	);
	assert_eq!(
		zsh(
			r#"setopt rematchpcre bashrematch; [[ "ab12" =~ '([a-z]+)(\d+)' ]]; echo $? ${#BASH_REMATCH} "$BASH_REMATCH[*]" ${+MATCH}"#
		),
		ok("0 3 ab12 ab 12 0\n")
	);
	assert_eq!(
		zsh(
			r"setopt rematchpcre ksharrays; [[ 'ab12' =~ '(\d)' ]]; echo $? $MBEGIN $MEND ${mbegin[0]} ${mend[0]}"
		),
		ok("0 2 2 2 2\n")
	);
}
