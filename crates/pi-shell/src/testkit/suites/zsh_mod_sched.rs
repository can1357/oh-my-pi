//! zsh/sched (port of zsh 5.9 `Src/Builtins/sched.c`): the `sched`
//! builtin's list, deletion and messages and `$zsh_scheduled_events`.
//! Expected output comes from `TZ=UTC /bin/zsh -f -c` 5.9; the fake host's
//! clock reads 1700000000 (Tue Nov 14 22:13:20 UTC 2023).

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
fn zsh_mod_sched_lists_in_time_order_and_deletes() {
	let (out, err, st) = zsh(
		"zmodload zsh/sched; sched 1700000100 echo one; sched 1700000050 -o echo two; sched -o \
		 1700000200 -- -x y; sched; print -l $zsh_scheduled_events; sched -2; sched",
	);
	assert_eq!(err, "");
	assert_eq!(
		out,
		"  1 Tue Nov 14 22:14:10 -- -o echo two\n  2 Tue Nov 14 22:15:00 echo one\n  3 Tue Nov 14 \
		 22:16:40 -o -- -- -x y\n1700000050::-o echo two\n1700000100::echo one\n1700000200:-o:-- -x \
		 y\n  1 Tue Nov 14 22:14:10 -- -o echo two\n  2 Tue Nov 14 22:16:40 -o -- -- -x y\n"
	);
	assert_eq!(st, 0);
}

#[test]
fn zsh_mod_sched_relative_times_count_from_now() {
	let (out, err, st) =
		zsh("zmodload zsh/sched; sched +1:00:30 a; sched +5 b; print -l $zsh_scheduled_events");
	assert_eq!(err, "");
	assert_eq!(out, "1700000005::b\n1700003630::a\n");
	assert_eq!(st, 0);
}

#[test]
fn zsh_mod_sched_autoloads_and_its_parameter_is_read_only() {
	let (out, err, st) = zsh(
		"sched 1700000100 echo a; print -r -- ${(t)zsh_scheduled_events}; zmodload -lF zsh/sched",
	);
	assert_eq!(err, "");
	assert_eq!(out, "array-readonly-hide-hideval-special\n+b:sched\n+p:zsh_scheduled_events\n");
	assert_eq!(st, 0);
	let (_, err, st) = zsh("zmodload zsh/sched; zsh_scheduled_events=(); echo $?");
	assert_eq!(err, "zsh:1: read-only variable: zsh_scheduled_events\n");
	assert_eq!(st, 1);
}

#[test]
fn zsh_mod_sched_messages() {
	for (src, want) in [
		("sched -3", "zsh:sched:1: not that many entries\n"),
		("sched -0", "zsh:sched:1: usage for delete: sched -<item#>.\n"),
		("sched -q", "zsh:sched:1: bad option: -q\n"),
		("sched -", "zsh:sched:1: option expected\n"),
		("sched +1", "zsh:sched:1: not enough arguments\n"),
		("sched 1:2:3x echo", "zsh:sched:1: bad time specifier\n"),
		("sched +1x echo", "zsh:sched:1: bad time specifier\n"),
		("sched x echo", "zsh:sched:1: bad time specifier\n"),
	] {
		let (out, err, st) = zsh(&format!("zmodload zsh/sched; {src}"));
		assert_eq!((out.as_str(), err.as_str(), st), ("", want, 1), "{src}");
	}
	// `sched -o` alone lists; `--` before the time ends the options.
	let (out, err, st) = zsh("zmodload zsh/sched; sched -o; sched -- -1 x; sched");
	assert_eq!((out.as_str(), err.as_str(), st), ("", "zsh:sched:1: not that many entries\n", 0));
}
