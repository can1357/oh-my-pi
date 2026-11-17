//! zsh/zftp without a network (the testkit host has no sockets): loading,
//! the default parameters, argument checks, `not connected`, `zftp params`
//! and sessions. Expected output comes from `/bin/zsh -f -c` 5.9 (with
//! `zsh/net/tcp` loaded first: the macOS build cannot load `zsh/zftp`
//! alone). The network side is `tests/zsh_mod_zftp.rs`.

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
fn zftp_exists_only_once_loaded() {
	let (out, err, st) = zsh("zftp ls; echo $?");
	assert_eq!(out, "127\n");
	assert_eq!(err, "zsh:1: command not found: zftp\n");
	assert_eq!(st, 0);
}

#[test]
fn subcommands_without_a_connection() {
	let src = r"zmodload zsh/net/tcp zsh/zftp
typeset -p ZFTP_VERBOSE ZFTP_TMOUT ZFTP_PREFS ZFTP_SESSION
zmodload -lF zsh/zftp
zftp; echo $?
zftp foo; echo $?
zftp ls; echo $?
zftp test; echo $?
zftp session
zftp type; echo $?
zftp params; echo $?
zftp params host.example user secret; zftp params; echo $?
zftp params -; zftp params; echo $?
zftp session x; zftp session; typeset -p ZFTP_SESSION
zftp rmsession; zftp session; typeset -p ZFTP_SESSION
zftp rmsession zz; echo $?
zftp local /nonexistent/file; echo $?
zftp cd a b; echo $?
zftp getat f; echo $?
zftp close; echo $?
zftp open; echo $?
ZFTP_PREFS=xP; zftp session; echo $?; zftp test; echo $?
ZFTP_PREFS=PS
zftp open '[::1'; echo $?
zftp session a; zftp session b; zftp session; zftp rmsession b; zftp session; typeset -p ZFTP_SESSION; zftp rmsession; zftp session; zftp rmsession; zftp session; typeset -p ZFTP_SESSION";
	let (out, err, st) = zsh(src);
	assert_eq!(
		out,
		"typeset ZFTP_VERBOSE=450
typeset -i ZFTP_TMOUT=60
typeset ZFTP_PREFS=PS
typeset -r ZFTP_SESSION=default
+b:zftp
1
1
1
1
default
1
1
host.example
user
******
0
1
default
x
typeset -r ZFTP_SESSION=x
default
typeset -r ZFTP_SESSION=default
1
1
1
1
1
1
default
0
1
1
default
a
b
default
a
typeset -r ZFTP_SESSION=default
a
default
typeset -r ZFTP_SESSION=default
"
	);
	assert_eq!(
		err,
		"zsh:zftp:4: not enough arguments
zsh:zftp:5: no such subcommand: foo
zsh:zftp ls:6: not connected.
zsh:zftp type:9: not connected.
zsh:zftp:17: wrong no. of arguments for cd
zsh:zftp:18: wrong no. of arguments for getat
zsh:zftp close:19: not connected.
zsh:zftp open:20: no host specified
zsh:zftp:21: preference x not recognized
zsh:zftp:21: preference x not recognized
zsh:zftp open:23: Invalid host format: ::1
"
	);
	assert_eq!(st, 0);
}

#[test]
fn opening_without_sockets_fails_loudly() {
	let (out, err, st) = zsh("zmodload zsh/net/tcp zsh/zftp; zftp open localhost; echo $?");
	assert_eq!(out, "1\n");
	assert!(err.contains("zftp open"), "{err}");
	assert_eq!(st, 0);
}
