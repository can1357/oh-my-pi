//! zsh/rlimits (port of zsh 5.9 `Src/Builtins/rlimits.c`): argument
//! parsing and messages of `limit`, `unlimit` and `ulimit` that come
//! before any limit is read. The fake host has no resource limits (it
//! refuses them, as `PiHost` does); the listings and limits on a real host
//! are in `tests/zsh_mod_rlimits.rs`. Expected output comes from
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

#[test]
fn zsh_mod_rlimits_parse_errors() {
	for (src, want) in [
		("limit foo", "zsh:limit:1: no such resource: foo\n"),
		("limit d", "zsh:limit:1: ambiguous resource specification: d\n"),
		("limit cputime 5x", "zsh:limit:1: unknown scaling factor: x\n"),
		("limit stacksize 3q", "zsh:limit:1: unknown scaling factor: q\n"),
		("limit descriptors abc", "zsh:limit:1: limit must be a number\n"),
		("unlimit foo", "zsh:unlimit:1: no such resource: foo\n"),
		("ulimit -", "zsh:ulimit:1: missing option letter\n"),
		("ulimit -z", "zsh:ulimit:1: bad option: -z\n"),
		("ulimit -N", "zsh:ulimit:1: number required after -N\n"),
		("ulimit -N x", "zsh:ulimit:1: invalid number: x\n"),
		("ulimit -a -n", "zsh:ulimit:1: no limits allowed with -a\n"),
		("ulimit -n -a", "zsh:ulimit:1: no limits allowed with -a\n"),
		("ulimit -a 5", "zsh:ulimit:1: no arguments allowed after -a\n"),
		("ulimit -n12", "zsh:ulimit:1: bad option: -1\n"),
		("ulimit abc", "zsh:ulimit:1: invalid number: abc\n"),
	] {
		let (out, err, st) = zsh(src);
		assert_eq!((out.as_str(), err.as_str(), st), ("", want, 1), "{src}");
	}
}

#[test]
fn zsh_mod_rlimits_resource_numbers_past_the_table() {
	// `getrlimit` of a resource the platform does not have: `EINVAL`.
	let (out, err, st) = zsh("limit 99; echo $?; ulimit -N 20");
	assert_eq!(out, "1\n");
	assert_eq!(
		err,
		"zsh:limit:1: can't read limit: invalid argument\nzsh:ulimit:1: can't read limit: invalid \
		 argument\n"
	);
	assert_eq!(st, 1);
}

#[test]
fn zsh_mod_rlimits_builtins_autoload() {
	let (out, err, st) = zsh("limit foo; zmodload -lF zsh/rlimits");
	assert_eq!(err, "zsh:limit:1: no such resource: foo\n");
	assert_eq!(out, "+b:limit\n-b:ulimit\n-b:unlimit\n");
	assert_eq!(st, 0);
}
