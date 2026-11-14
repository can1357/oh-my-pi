//! Modes: `emulate` in the bash dialect, sticky emulation of
//! functions defined under `emulate … -c`, the dialects' builtin tables,
//! the mode of events, and sticky functions across externalize/restore;
//! calls across the bash/zsh dialect boundary in both directions (word
//! splitting, array indexing, which options cross, `emulate -L` scope,
//! lossy writes, restore inside the call). zsh-grammar cases live with the
//! zsh slices.

use crate::{
	bash::{ModeId, Script, ShellInit},
	testkit::{FakeHost, Fault, Rig, fault::skeleton_init, run_script},
};

fn run(src: &str) -> (String, String, i32) {
	let out = run_script(FakeHost::new(), src.as_bytes(), &[], Fault::None);
	(
		String::from_utf8_lossy(&out.stdout).into_owned(),
		String::from_utf8_lossy(&out.stderr).into_owned(),
		out.status,
	)
}

/// `emulate` prints the emulation; `emulate sh` from bash is posix mode,
/// `emulate bash` leaves it.
#[test]
fn emulate_switches_between_bash_and_its_posix_mode() {
	let (out, err, _) = run(
		"emulate; emulate sh\nemulate; [[ -o posix ]] && echo posix-on\nemulate bash\nemulate; [[ \
		 -o posix ]] || echo posix-off\n",
	);
	assert_eq!(out, "bash\nsh\nposix-on\nbash\nposix-off\n");
	assert_eq!(err, "");
}

/// A function defined under `emulate sh -c` runs in sh emulation whoever
/// calls it, and its caller's mode comes back; the `-c` text itself runs
/// in sh emulation and the mode is restored after it.
#[test]
fn sticky_functions_run_in_their_emulation() {
	let (out, err, _) = run(
		"emulate sh -c 'f() { [[ -o posix ]] && echo f-posix; emulate; }; emulate'\n[[ -o posix ]] \
		 || echo caller-not-posix\nf\nemulate; [[ -o posix ]] || echo back\n",
	);
	assert_eq!(out, "sh\ncaller-not-posix\nf-posix\nsh\nbash\nback\n");
	assert_eq!(err, "");
}

/// `emulate -c` keeps nothing of the emulation once the text has run, even
/// when it switched options.
#[test]
fn emulate_c_restores_options_and_mode() {
	let (out, ..) =
		run("emulate -R sh -c 'set -o noglob; emulate'\nemulate; [[ -o posix ]] || echo ok\n");
	assert_eq!(out, "sh\nbash\nok\n");
}

/// `setopt` and `unsetopt` are zsh builtins: bash code does not have them;
/// `shopt` is bash's.
#[test]
fn each_dialect_has_its_own_builtins() {
	let (_, err, status) = run("setopt extendedglob");
	assert_eq!(status, 127);
	assert_eq!(err, "bash: line 1: setopt: command not found\n");
	assert!(crate::bash::IntrinsicId::lookup(b"setopt", ModeId::Zsh).is_some());
	assert!(crate::bash::IntrinsicId::lookup(b"shopt", ModeId::Zsh).is_none());
	assert!(crate::bash::IntrinsicId::lookup(b"emulate", ModeId::Bash).is_some());
}

/// `emulate` usage errors, as zsh reports them.
#[test]
fn emulate_rejects_bad_usage() {
	let (_, err, status) = run("emulate -L");
	assert_eq!(status, 1);
	assert_eq!(err, "bash: line 1: emulate: not enough arguments\n");
	let (_, err, status) = run("emulate -l sh extra");
	assert_eq!(status, 1);
	assert_eq!(err, "bash: line 1: emulate: too many arguments for -l\n");
	let (_, err, status) = run("emulate -L sh -c ':'");
	assert_eq!(status, 1);
	assert_eq!(err, "bash: line 1: emulate: option -L incompatible with -c\n");
}

/// Events carry the emitting code's mode: `sh` after `emulate sh`, and
/// inside a sticky call (its `FuncEnter` included) the callee's.
#[test]
fn events_report_the_current_mode() {
	let mut rig = Rig::new(FakeHost::new(), skeleton_init(&[]));
	let src = b"emulate sh -c 'g() { :; }'\ng\nemulate sh\n:\n".to_vec();
	assert_eq!(rig.run(Script::command(src), Fault::None), 0);
	let modes: Vec<(String, String)> = rig
		.host
		.events
		.iter()
		.filter(|e| matches!(e["kind"].as_str(), Some("FuncEnter" | "CmdStart")))
		.map(|e| {
			(e["kind"].as_str().unwrap_or("").to_owned(), e["mode"].as_str().unwrap_or("").to_owned())
		})
		.collect();
	let enter = modes
		.iter()
		.find(|(k, _)| k == "FuncEnter")
		.expect("FuncEnter");
	assert_eq!(enter.1, "sh", "the sticky callee's mode");
	assert_eq!(modes.first().map(|(_, m)| m.as_str()), Some("bash"));
	assert_eq!(modes.last().map(|(_, m)| m.as_str()), Some("sh"));
}

/// A sticky function survives externalize → restore in a fresh engine,
/// also when the snapshot is taken inside the call: the restored shell
/// finishes it in sh emulation and returns to bash.
#[test]
fn sticky_functions_survive_restore() {
	let src = "emulate sh -c 'f() { [[ -o posix ]] && echo in; for i in 1 2 3; do :; done; \
	           }'\nf\nf\n[[ -o posix ]] || echo out\n";
	let plain = run_script(FakeHost::new(), src.as_bytes(), &[], Fault::None);
	assert_eq!(String::from_utf8_lossy(&plain.stdout), "in\nin\nout\n");
	for k in [1, 3, 7] {
		let faulted = run_script(FakeHost::new(), src.as_bytes(), &[], Fault::Snapshot { every: k });
		assert_eq!(faulted.stdout, plain.stdout, "restore every {k} ops");
		assert_eq!(faulted.status, plain.status);
	}
}

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

/// bash → zsh: a function defined under `emulate zsh -c` splits, indexes
/// and reads options as zsh whoever calls it; the bash caller keeps bash's
/// splitting, 0-based indexing and mode.
#[test]
fn bash_calls_a_zsh_function() {
	let (out, err, status) = run(
		"emulate zsh -c 'zf() { x=\"a b\"; for w in $x; do print -r -- \"<$w>\"; done; arr=(p q r); \
		 print $arr[1]; [[ -o shwordsplit ]] && print split || print nosplit; emulate; \
		 }'\nzf\nx=\"a b\"; for w in $x; do echo \"[$w]\"; done; arr=(p q r); echo ${arr[1]}; \
		 emulate\n",
	);
	assert_eq!(out, "<a b>\np\nnosplit\nzsh\n[a]\n[b]\nq\nbash\n");
	assert_eq!(err, "");
	assert_eq!(status, 0);
}

/// zsh → bash: a function defined under `emulate bash -c` splits and
/// indexes as bash; the zsh caller keeps zsh's.
#[test]
fn zsh_calls_a_bash_function() {
	let (out, err, status) = zsh(
		"emulate bash -c 'bf() { x=\"a b\"; for w in $x; do echo \"[$w]\"; done; arr=(p q r); echo \
		 ${arr[1]}; emulate; }'\nbf; x=\"a b\"; for w in $x; do print -r -- \"<$w>\"; done; arr=(p \
		 q r); print $arr[1]; emulate\n",
	);
	assert_eq!(out, "[a]\n[b]\nq\nbash\n<a b>\np\nzsh\n");
	assert_eq!(err, "");
	assert_eq!(status, 0);
}

/// Env options (`noglob`) are shared across the dialect boundary; mode
/// options are not: zsh's `ksharrays` does not reach bash code, and bash's
/// `shopt -s extglob` does not turn on zsh's `kshglob`.
#[test]
fn only_env_options_cross_dialects() {
	let (out, err, _) = zsh(
		"setopt noglob ksharrays\nemulate bash -c 'bf() { [[ -o noglob ]] && echo noglob-shared; \
		 arr=(p q); echo ${arr[0]}; shopt -s extglob; }'\nbf; arr=(p q); print $arr[0]; [[ -o \
		 kshglob ]] && print kshglob-leaked || print separate\n",
	);
	assert_eq!(out, "noglob-shared\np\np[0]\nseparate\n");
	assert_eq!(err, "");
}

/// `emulate -L` lasts until the function returns, also inside a sticky
/// function whose own emulation it overrides.
#[test]
fn emulate_local_ends_with_the_function() {
	let (out, err, _) = zsh(
		"f() { emulate -L sh; [[ -o shwordsplit ]] && echo in-sh; emulate; }\nf; emulate; [[ -o \
		 shwordsplit ]] && echo leaked || echo restored\nemulate sh -c 'g() { emulate -L zsh; \
		 emulate; }'\ng; emulate\n",
	);
	assert_eq!(out, "in-sh\nsh\nzsh\nrestored\nzsh\nzsh\n");
	assert_eq!(err, "");
}

/// bash code writing a variable with zsh-only attributes stores the value
/// as bash writes it (bash reads it back so) and reports the lossy
/// crossing once per crossing (`Diag::ModeLossy`), however often it
/// writes; zsh shows the stored value in the variable's float style.
#[test]
fn bash_writes_to_zsh_attributes_are_lossy_once() {
	let init = ShellInit { mode: ModeId::Zsh, argv0: "zsh".into(), ..skeleton_init(&[]) };
	let mut rig = Rig::new(FakeHost::new(), init);
	let src =
		"typeset -F 3 fl=1.5\nemulate bash -c 'b() { fl=2; fl=3; echo \"$fl\"; }'\nb; print $fl\n";
	assert_eq!(rig.run(Script::command(src.as_bytes().to_vec()), Fault::None), 0);
	assert_eq!(
		String::from_utf8_lossy(&rig.host.stdout.bytes()),
		"3\n3.000\n",
		"bash reads the value as it wrote it, zsh as a float"
	);
	let lossy = rig
		.host
		.events
		.iter()
		.filter(|e| e["kind"] == "Diag" && e["data"]["code"] == "ModeLossy")
		.count();
	assert_eq!(lossy, 1, "one ModeLossy per crossing");
	let err = String::from_utf8_lossy(&rig.host.stderr.bytes()).into_owned();
	assert_eq!(err.matches("zsh attributes of `fl' lost crossing").count(), 1, "{err}");
}

/// A zsh function called from bash survives externalize → restore taken
/// inside the call: the restored shell finishes it in zsh mode (zsh
/// splitting, `emulate` says zsh) and returns to bash mode.
#[test]
fn cross_dialect_calls_survive_restore() {
	let src = "emulate zsh -c 'zf() { x=\"a b\"; for w in $x; do print -r -- \"<$w>\"; done; \
	           repeat 3 :; emulate; }'\nzf\nzf\nx=\"a b\"; for w in $x; do echo \"[$w]\"; done; \
	           emulate\n";
	let plain = run_script(FakeHost::new(), src.as_bytes(), &[], Fault::None);
	assert_eq!(String::from_utf8_lossy(&plain.stdout), "<a b>\nzsh\n<a b>\nzsh\n[a]\n[b]\nbash\n");
	for k in [1, 3, 7] {
		let faulted = run_script(FakeHost::new(), src.as_bytes(), &[], Fault::Snapshot { every: k });
		assert_eq!(faulted.stdout, plain.stdout, "restore every {k} ops");
		assert_eq!(faulted.status, plain.status);
	}
}
