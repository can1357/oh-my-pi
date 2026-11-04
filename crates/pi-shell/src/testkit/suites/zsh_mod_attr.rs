//! zsh/attr where the in-memory filesystem can test it: argument checks
//! and failures (`/bin/zsh -f -c` 5.9), and the refusal of a host without
//! extended attributes (`operation not supported`, zsh's `ENOTSUP` text).

use crate::{
	bash::{ModeId, Script, ShellInit},
	testkit::{FakeHost, Fault, MemFs, Rig, fault::skeleton_init},
};

fn zsh(src: &str) -> (String, String, i32) {
	let init = ShellInit { mode: ModeId::Zsh, argv0: "zsh".into(), ..skeleton_init(&[]) };
	let mut rig = Rig::new(FakeHost::new().with_fs(MemFs::new()), init);
	let status = rig.run(Script::command(src.as_bytes().to_vec()), Fault::None);
	(
		String::from_utf8_lossy(&rig.host.stdout.bytes()).into_owned(),
		String::from_utf8_lossy(&rig.host.stderr.bytes()).into_owned(),
		status,
	)
}

#[test]
fn zsh_mod_attr_checks_arguments() {
	let (out, err, _) = zsh(
		"cd /tmp; zmodload zsh/attr; zgetattr f; echo $?; zsetattr f a; echo $?; zlistattr; echo \
		 $?; zgetattr -x f a; echo $?",
	);
	assert_eq!(out, "1\n1\n1\n1\n");
	assert_eq!(
		err,
		"zsh:zgetattr:1: not enough arguments
zsh:zsetattr:1: not enough arguments
zsh:zlistattr:1: not enough arguments
zsh:zgetattr:1: bad option: -x
"
	);
}

#[test]
fn zsh_mod_attr_refused_without_extended_attributes() {
	let (out, err, _) = zsh(
		"cd /tmp; zmodload zsh/attr; print > f; zsetattr f user.k v; echo $?; zgetattr f user.k; \
		 echo $?; zdelattr f user.k; echo $?; zlistattr f; echo $?",
	);
	// zsh's `zlistattr` failure status is 2 (`1 + (list_len > val_len)`).
	assert_eq!(out, "1\n1\n1\n2\n");
	assert_eq!(
		err,
		"zsh:zsetattr:1: f: operation not supported
zsh:zgetattr:1: f: operation not supported
zsh:zdelattr:1: f: operation not supported
zsh:zlistattr:1: f: operation not supported
"
	);
}
