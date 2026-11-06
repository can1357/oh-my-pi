//! zsh/net/socket and zsh/net/tcp on the fake host (ports of zsh 5.9
//! `Src/Modules/socket.c` and `tcp.c`): argument errors (expected output
//! from `/bin/zsh -f -c` 5.9), and the fake host's refusal of OS sockets,
//! reported through zsh's own messages.

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
fn zsh_mod_net_zsocket_argument_errors() {
	let (out, err, st) = zsh(
		"zmodload zsh/net/socket; zsocket; zsocket -l; zsocket -a; zsocket -a x; zsocket -d 0 x; \
		 zsocket -d x y; zsocket -d 1 y; echo $?",
	);
	assert_eq!(out, "1\n");
	assert_eq!(
		err,
		"zsh:zsocket:1: zsocket requires an argument\nzsh:zsocket:1: -l requires an \
		 argument\nzsh:zsocket:1: -a requires an argument\nzsh:zsocket:1: invalid numerical \
		 argument\nzsh:zsocket:1: 0 is an invalid argument to -d\nzsh:zsocket:1: x is an invalid \
		 argument to -d\nzsh:zsocket:1: file descriptor 1 is in use by the shell\n"
	);
	assert_eq!(st, 0);
}

#[test]
fn zsh_mod_net_ztcp_argument_errors() {
	let (out, err, st) = zsh(
		"zmodload zsh/net/tcp; ztcp; echo $?; ztcp -l; ztcp -a; ztcp -a x; ztcp -a 5; ztcp -c 5; \
		 ztcp -c x; ztcp -d x h; ztcp -l 0; ztcp -l bogusservice; echo $?",
	);
	assert_eq!(out, "0\n1\n");
	assert_eq!(
		err,
		"zsh:ztcp:1: -l requires an argument\nzsh:ztcp:1: -a requires an argument\nzsh:ztcp:1: \
		 invalid numerical argument\nzsh:ztcp:1: fd 5 is not registered as a tcp \
		 connection\nzsh:ztcp:1: fd 5 not found in tcp table\nzsh:ztcp:1: x is an invalid argument \
		 to -c\nzsh:ztcp:1: x is an invalid argument to -d\nzsh:ztcp:1: bad service name or port \
		 number\nzsh:ztcp:1: bad service name or port number\n"
	);
	assert_eq!(st, 0);
}

#[test]
fn zsh_mod_net_fake_host_refuses_sockets() {
	let (out, err, st) = zsh(
		"zmodload zsh/net/socket zsh/net/tcp; zsocket /tmp/s; echo $?; zsocket -l /tmp/s; echo $?; \
		 ztcp -l 5555; echo $?; ztcp -L; echo $?",
	);
	assert_eq!(out, "1\n1\n1\n0\n");
	assert_eq!(
		err,
		"zsh:zsocket:1: connection failed: operation not supported\nzsh:zsocket:1: socket error: \
		 operation not supported \nzsh:ztcp:1: could not bind to port 5555: operation not \
		 supported\n"
	);
	assert_eq!(st, 0);
}
