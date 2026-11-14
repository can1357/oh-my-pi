//! zsh/cap (zsh 5.9 `Src/Modules/cap.c` without libcap, as macOS's
//! `/bin/zsh` is built): the builtins exist, check their argument counts
//! and are not available. Expected output comes from `/bin/zsh -f -c`
//! 5.9 on macOS.

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
fn zsh_mod_cap_builtins_are_not_available() {
	let (out, err, st) =
		zsh("zmodload zsh/cap; cap; echo $?; getcap /bin/ls; echo $?; setcap x y; echo $?");
	assert_eq!(out, "1\n1\n1\n");
	assert_eq!(
		err,
		"zsh:cap:1: not available on this system\nzsh:getcap:1: not available on this \
		 system\nzsh:setcap:1: not available on this system\n"
	);
	assert_eq!(st, 0);
}

#[test]
fn zsh_mod_cap_features_and_argument_counts() {
	let (out, err, st) = zsh("zmodload zsh/cap; zmodload -lF zsh/cap; getcap; setcap x; cap a b");
	assert_eq!(out, "+b:cap\n+b:getcap\n+b:setcap\n");
	assert_eq!(
		err,
		"zsh:getcap:1: not enough arguments\nzsh:setcap:1: not enough arguments\nzsh:cap:1: too \
		 many arguments\n"
	);
	assert_eq!(st, 1);
	// No autoload stubs: the builtins exist once the module is loaded.
	let (_, err, st) = zsh("cap");
	assert_eq!((err.as_str(), st), ("zsh:1: command not found: cap\n", 127));
}
