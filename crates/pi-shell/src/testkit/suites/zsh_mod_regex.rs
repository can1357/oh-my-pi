//! zsh/regex (`[[ s =~ re ]]`, `-regex-match`) and the module-condition
//! dispatch of `cond.c` (`unknown condition`, autoloading zsh/regex for
//! `=~`). The pattern goes to the C library's `regcomp`, so group and
//! error expectations are the host's (macOS here); the cases that differ
//! from glibc are macOS-only. Expected output comes from `/bin/zsh -f -c`
//! 5.9.

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

#[test]
fn regex_match_sets_match_variables() {
	assert_eq!(
		zsh(r#"zmodload zsh/regex; [[ hello -regex-match "l+" ]]; echo $? $MATCH $MBEGIN $MEND"#),
		ok("0 ll 3 4\n")
	);
	assert_eq!(
		zsh(r#"[[ xyz =~ "(q)?y" ]]; echo $? $MATCH "[$match]" "[$mbegin]" "[$mend]""#),
		ok("0 y [] [-1] [-1]\n")
	);
	assert_eq!(zsh(r#"[[ abc =~ x ]]; echo $? ${+MATCH}"#), ok("1 0\n"));
	assert_eq!(zsh(r#"[[ abc =~ b ]] && echo yes; [[ abc =~ "^b" ]] || echo no"#), ok("yes\nno\n"));
	assert_eq!(zsh(r#"x='a.c'; [[ abc =~ $x ]]; echo $? $MATCH"#), ok("0 abc\n"));
}

#[test]
fn regex_match_counts_characters_in_the_locale() {
	assert_eq!(zsh(r#"[[ "héllo" =~ "l+" ]]; echo $? $MATCH $MBEGIN $MEND"#), ok("0 ll 4 5\n"));
	assert_eq!(
		zsh(r#"LANG=en_US.UTF-8; [[ "héllo" =~ "l+" ]]; echo $? $MATCH $MBEGIN $MEND"#),
		ok("0 ll 3 4\n")
	);
	assert_eq!(zsh(r#"LANG=en_US.UTF-8; [[ "héllo" =~ "h.l" ]]; echo $? $MATCH"#), ok("0 hél\n"));
}

#[test]
fn regex_match_options() {
	assert_eq!(
		zsh(
			r#"setopt bashrematch; [[ abc =~ "(b)(x)?" ]]; echo $? ${#BASH_REMATCH} "${(q)BASH_REMATCH[@]}""#
		),
		ok("0 3 b b ''\n")
	);
	assert_eq!(
		zsh(r#"[[ ABC =~ b ]]; echo $?; setopt nocasematch; [[ ABC =~ b ]]; echo $? $MATCH"#),
		ok("1\n0 B\n")
	);
	assert_eq!(
		zsh(r#"setopt ksharrays; [[ abc =~ "(b)" ]]; echo $? $MBEGIN $MEND ${mbegin[0]} ${mend[0]}"#),
		ok("0 1 1 1 1\n")
	);
}

#[cfg(target_vendor = "apple")]
#[test]
fn regex_groups_and_errors_are_the_c_librarys() {
	assert_eq!(
		zsh(
			r#"[[ abcd =~ "(a|ab)(c|bcd)(d*)" ]]; echo $? $MATCH $MBEGIN $MEND "[$match]" "[$mbegin]" "[$mend]""#
		),
		ok("0 abcd 1 4 [ab c d] [1 3 4] [2 3 4]\n")
	);
	assert_eq!(
		zsh(r#"[[ abc =~ "(" ]]; echo $?"#),
		("1\n".into(), "zsh:1: failed to compile regex: parentheses not balanced\n".into(), 0)
	);
	assert_eq!(
		zsh(r#"[[ abc =~ "a{2,1}" ]]; echo $?"#),
		("1\n".into(), "zsh:1: failed to compile regex: invalid repetition count(s)\n".into(), 0)
	);
}

#[test]
fn eq_tilde_autoloads_zsh_regex() {
	assert_eq!(zsh("zmodload; [[ a =~ a ]]; zmodload"), ok("zsh/main\nzsh/main\nzsh/regex\n"));
}

#[test]
fn module_conditions_need_their_module() {
	assert_eq!(
		zsh("[[ a -regex-match a ]]; echo notreached"),
		(String::new(), "zsh:1: unknown condition: -regex-match\n".into(), 2)
	);
	assert_eq!(
		zsh("zmodload zsh/regex; [[ -regex-match a b ]]; echo notreached"),
		(String::new(), "zsh:1: unknown condition: -regex-match\n".into(), 2)
	);
	assert_eq!(
		zsh(
			r#"zmodload zsh/regex; test hello -regex-match "^h"; echo $?; [ -regex-match a ]; echo $?"#
		),
		("0\n2\n".into(), "zsh:[:1: unknown condition: -regex-match\n".into(), 0)
	);
}

#[test]
fn unknown_conditions() {
	for (src, name) in [
		("[[ -foo a ]]; echo notreached", "-foo"),
		("[[ -f ]]; echo notreached", "-f"),
		("[[ a -foo b ]]; echo notreached", "-foo"),
		("[[ -foo a b c ]]; echo notreached", "-foo"),
	] {
		assert_eq!(
			zsh(src),
			(String::new(), format!("zsh:1: unknown condition: {name}\n"), 2),
			"{src}"
		);
	}
	assert_eq!(zsh("[[ -foo ]]; echo $?"), ok("0\n"));
	assert_eq!(
		zsh("test a -foo b; echo $?"),
		("2\n".into(), "zsh:test:1: unknown condition: -foo\n".into(), 0)
	);
}
