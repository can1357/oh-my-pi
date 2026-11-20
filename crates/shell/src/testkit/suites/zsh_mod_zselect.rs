//! zsh/zselect on the fake host (ports of zsh 5.9
//! `Src/Modules/zselect.c`): argument errors, readiness of pipes, the
//! `reply` array and `-A` association, timeouts. Expected output comes
//! from `/bin/zsh -f -c` 5.9.

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
fn zsh_mod_zselect_argument_errors() {
	let (out, err, st) = zsh(
		"zmodload zsh/zselect; zselect -t 0; echo $?; zselect -t; zselect -t x; zselect -t 1x; \
		 zselect x; zselect 1x; zselect -a; zselect -a 1a; zselect -A 9; zselect -z; zselect -r 9; \
		 echo $?",
	);
	assert_eq!(out, "1\n1\n");
	assert_eq!(
		err,
		"zsh:zselect:1: argument expected after -t\nzsh:zselect:1: number expected after \
		 -t\nzsh:zselect:1: garbage after -t argument: x\nzsh:zselect:1: expecting file descriptor: \
		 x\nzsh:zselect:1: garbage after file descriptor: x\nzsh:zselect:1: argument expected after \
		 -a\nzsh:zselect:1: invalid array name: 1a\nzsh:zselect:1: invalid array name: \
		 9\nzsh:zselect:1: expecting file descriptor: z\nzsh:zselect:1: error on select: bad file \
		 descriptor\n"
	);
	assert_eq!(st, 0);
}

#[test]
fn zsh_mod_zselect_reports_readable_pipes() {
	let (out, err, st) = zsh(
		"zmodload zsh/zselect; echo hi | zselect -r 0; echo $? $reply; echo hi | zselect -a out -A \
		 h -r 0; echo $? ${(kv)h} ${#out}; echo hi | zselect -a out -r 0; echo $out",
	);
	assert_eq!(out, "0 -r 0\n0 0 r 0\n-r 0\n");
	assert_eq!(err, "");
	assert_eq!(st, 0);
}

#[test]
fn zsh_mod_zselect_end_of_file_is_readable() {
	let (out, _, st) = zsh("zmodload zsh/zselect; : | zselect -r 0; echo $? $reply");
	assert_eq!(out, "0 -r 0\n");
	assert_eq!(st, 0);
}

#[test]
fn zsh_mod_zselect_times_out_on_a_silent_pipe() {
	let (out, _, st) = zsh(
		"zmodload zsh/zselect; reply=(old); zselect -t 5 -r 0 < <(zselect -t 100); echo $? $reply",
	);
	assert_eq!(out, "1 old\n");
	assert_eq!(st, 0);
}

#[test]
fn zsh_mod_zselect_waits_for_a_writer() {
	let (out, _, st) =
		zsh("zmodload zsh/zselect; zselect -t 500 -r 0 < <(zselect -t 5; print x); echo $? $reply");
	assert_eq!(out, "0 -r 0\n");
	assert_eq!(st, 0);
}
