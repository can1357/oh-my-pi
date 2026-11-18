//! zsh/compctl definitions (ports of zsh 5.9 `Src/Zle/compctl.c`):
//! `compctl` defining, removing and listing compctls, its errors, and the
//! global match specifications. Expected output comes from `/bin/zsh -f -c`
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

/// The special compctls as `setup_` makes them, plain and as commands.
#[test]
fn compctl_lists_the_defaults() {
	let (out, err, _) = zsh("compctl; compctl -L");
	assert_eq!(
		out,
		"COMMAND -c -tn\nDEFAULT -f -tn\nFIRST\ncompctl -C -c -tn\ncompctl -D -f -tn\ncompctl -T\n"
	);
	assert_eq!(err, "");
}

/// `-x` conditions, `+` alternatives, patterns first (latest first), then
/// names sorted, quoted as zsh quotes them; `-L names` lists only those.
#[test]
fn compctl_lists_extended_and_patterns() {
	let (out, err, _) = zsh(
		r#"compctl -f -x "s[-] p[1,2], c[-1,foo]" -k "(a b)" - "r[x,y]" -g "*.c" -- + -c foo bar; compctl -K f -x "R[-*,--] w[1,x\\,y]" -l "" -- "x*"; compctl -k "(a b)" -q "+" "a b" "\$x" "y\\*" -- -n; compctl; compctl -L; compctl -L foo "x*" nope "-n"; echo $?"#,
	);
	assert_eq!(
		out,
		r"'x*' -K f -x 'R[-*,--] w[1,x\,y]' -l ''
'\$x' -q -k '(a b)' +
-- -q -k '(a b)' +
-n -q -k '(a b)' +
'a\ b' -q -k '(a b)' +
bar -f -x 's[-] p[1,2] , c[-1,foo]' -k '(a b)' - 'r[x,y]' -g '*.c' + -c
foo -f -x 's[-] p[1,2] , c[-1,foo]' -k '(a b)' - 'r[x,y]' -g '*.c' + -c
'y\*' -q -k '(a b)' +
COMMAND -c -tn
DEFAULT -f -tn
FIRST
compctl -K f -x 'R[-*,--] w[1,x\,y]' -l '' -- 'x*'
compctl -q -k '(a b)' + '\$x'
compctl -q -k '(a b)' + - --
compctl -q -k '(a b)' + - -n
compctl -q -k '(a b)' + 'a\ b'
compctl -f -x 's[-] p[1,2] , c[-1,foo]' -k '(a b)' - 'r[x,y]' -g '*.c' -- + -c bar
compctl -f -x 's[-] p[1,2] , c[-1,foo]' -k '(a b)' - 'r[x,y]' -g '*.c' -- + -c foo
compctl -q -k '(a b)' + 'y\*'
compctl -C -c -tn
compctl -D -f -tn
compctl -T
compctl -f -x 's[-] p[1,2] , c[-1,foo]' -k '(a b)' - 'r[x,y]' -g '*.c' -- + -c foo
compctl -K f -x 'R[-*,--] w[1,x\,y]' -l '' -- 'x*'
compctl -q -k '(a b)' + - -n
1
"
	);
	assert_eq!(err, "zsh:compctl:1: no compctl defined for nope\n");
}

/// zsh's messages for bad arguments, and what a failed or special
/// definition leaves.
#[test]
fn compctl_errors() {
	let (out, err, _) = zsh(
		r#"compctl -t; compctl -tq; compctl -t+x; compctl -k; compctl -y x; compctl -H; compctl -H 3; compctl -x; compctl -x "z[a]" -f; compctl -x "s" -f; compctl -x "s[a" -f; compctl -x "s[a]" -f; compctl -x "p[a]" -f -- x; compctl -%; compctl -L -x; compctl -f -C -D; compctl -C -f a b; compctl -L -C -D -T; echo $?"#,
	);
	assert_eq!(
		out,
		"COMMAND -c -tn\nDEFAULT -f -tn\nFIRST\ncompctl -C -f\ncompctl -D -f -tn\ncompctl -T\n0\n"
	);
	assert_eq!(
		err,
		"zsh:compctl:1: retry specification expected after -t
zsh:compctl:1: invalid retry specification character `q'
zsh:compctl:1: too many retry specification characters: `x'
zsh:compctl:1: variable name expected after -k
zsh:compctl:1: number expected after -H
zsh:compctl:1: missing pattern after -3
zsh:compctl:1: condition expected after -x
zsh:compctl:1: unknown condition code: z
zsh:compctl:1: expected condition after condition code: s
zsh:compctl:1: error after condition code: [
zsh:compctl:1: missing command names
zsh:compctl:1: bad option: -%
zsh:compctl:1: condition expected after -x
zsh:compctl:1: can't set -D, -T, and -C simultaneously
zsh:compctl:1: extraneous commands ignored
"
	);
}

/// Every flag letter in zsh's order, flags with arguments, `-t`
/// retries; flags without names list only the compctls having them;
/// `compctl + names` removes.
#[test]
fn compctl_flags_listing_filter_and_removal() {
	let (out, err, st) = zsh(
		r#"compctl -f -g "*.txt" -X "files \$x" -Y "\$PWD" -P pre -S suf -W /tmp -J grp -2 a; compctl -V vg -1 -tx -U -Q -/ -m -w -o -v -b -A -I -F -p -E -j -r -z -B -a -u -d -e -N -O -Z -n -c -s "\$(ls)" -h foo b; compctl -R -tn c; compctl -G -t- d; compctl -L; compctl -f; compctl + b c; compctl -L; compctl + ; echo $?"#,
	);
	assert_eq!(
		out,
		"compctl -f2 -J grp -Y '$PWD' -P pre -S suf -g '*.txt' -W /tmp a
compctl -acovbAIFpEjrzBudeNOZUnQmw/ -tx -J vg -s '$(ls)' -h foo b
compctl -R -tn c
compctl -G -t- d
compctl -C -c -tn
compctl -D -f -tn
compctl -T
a -f2 -J grp -Y '$PWD' -P pre -S suf -g '*.txt' -W /tmp
DEFAULT -f -tn
compctl -f2 -J grp -Y '$PWD' -P pre -S suf -g '*.txt' -W /tmp a
compctl -G -t- d
compctl -C -c -tn
compctl -D -f -tn
compctl -T
a -f2 -J grp -Y '$PWD' -P pre -S suf -g '*.txt' -W /tmp
d -G -t-
COMMAND -c -tn
DEFAULT -f -tn
FIRST
0
"
	);
	assert_eq!(err, "");
	assert_eq!(st, 0);
}

/// `compctl -M specs` sets the global matchers (status 1, as zsh's
/// `set_gmatcher` returns); `-T`/`-D` with `-x` and `+`.
#[test]
fn compctl_global_matchers_and_specials() {
	let (out, err, _) = zsh(
		r#"compctl -M "m:{a-z}={A-Z}" "r:|.=*"; echo $?; compctl -L; compctl -M; compctl; compctl -L -M; compctl -T -K f -x "p[1]" -k "(a)"; compctl -L -T; compctl -T -x "p[1]" -k "(a)" + -f; compctl -L -T; compctl -D -k x + ; compctl -D -f + -k y; compctl -L -D; compctl -M x; compctl -M "m:"; compctl -M "x:"; compctl -L -M"#,
	);
	assert_eq!(
		out,
		"1
compctl -C -c -tn
compctl -D -f -tn
compctl -T
compctl -M 'm:{a-z}={A-Z}' 'r:|.=*'
COMMAND -c -tn
DEFAULT -f -tn
FIRST
compctl -T -K f -x 'p[1,1]' -k '(a)' --
compctl -T -x 'p[1,1]' -k '(a)' + -f --
compctl -D -f + -k y
compctl -M 'x:'
"
	);
	assert_eq!(
		err,
		"zsh:compctl:1: recursive xor'd default completions not allowed
zsh:compctl:1: missing `:'
zsh:compctl:1: missing patterns
"
	);
}
