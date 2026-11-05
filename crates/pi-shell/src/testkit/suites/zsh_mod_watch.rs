//! zsh/watch (port of zsh 5.9 `Src/Modules/watch.c`): `log`, `$watch` and
//! `$WATCH`, the `$watch` entry patterns and every `$WATCHFMT` escape, over
//! a fake login database. The formats follow `/bin/zsh -f -c` 5.9 on
//! macOS (`TZ=UTC`; `log` there prints `can has logged on console from
//! .` for a local console session); the fake host's clock reads
//! 1700000000 (Tue Nov 14 22:13:20 UTC 2023).

use crate::{
	bash::{Login, Logins, ModeId, Script, ShellInit},
	testkit::{FakeHost, Fault, Rig, fault::skeleton_init},
};

/// Run `src` as `zsh -c src` on `host`: stdout, stderr, status.
fn zsh_on(host: FakeHost, src: &str) -> (String, String, i32) {
	let init = ShellInit { mode: ModeId::Zsh, argv0: "zsh".into(), ..skeleton_init(&[]) };
	let mut rig = Rig::new(host, init);
	let status = rig.run(Script::command(src.as_bytes().to_vec()), Fault::None);
	(
		String::from_utf8_lossy(&rig.host.stdout.bytes()).into_owned(),
		String::from_utf8_lossy(&rig.host.stderr.bytes()).into_owned(),
		status,
	)
}

fn login(user: &str, line: &str, host: &str, time: i64) -> Login {
	Login { user: user.into(), line: line.into(), host: host.into(), time }
}

/// A host whose login database holds `entries`.
fn host(entries: Vec<Login>) -> FakeHost {
	let mut h = FakeHost::new();
	h.logins = Some(Logins { mtime: 1_699_999_000, entries });
	h
}

fn sessions() -> Vec<Login> {
	vec![
		login("alice", "ttys001", "box.example.com", 1_700_000_000),
		login("can", "console", "", 1_699_990_000),
		login("bob", "pts/3", "10.0.0.7", 1_699_995_000),
	]
}

#[test]
fn zsh_mod_watch_defaults_and_tied_parameters() {
	let (out, err, st) = zsh_on(
		FakeHost::new(),
		"zmodload zsh/watch; echo $WATCHFMT $LOGCHECK ${(t)watch} ${(t)WATCH} ${(t)WATCHFMT} \
		 ${(t)LOGCHECK}; watch=(a b); echo $WATCH; WATCH=x:y; echo $watch; zmodload -lF zsh/watch",
	);
	assert_eq!(err, "");
	assert_eq!(
		out,
		"%n has %a %l from %m. 60 array-special scalar-special scalar integer\na:b\nx \
		 y\n+b:log\n+p:WATCH\n+p:watch\n"
	);
	assert_eq!(st, 0);
}

#[test]
fn zsh_mod_watch_log_reports_every_session_in_login_order() {
	let (out, err, st) =
		zsh_on(host(sessions()), "zmodload zsh/watch; watch=(all); log; echo $?; log");
	assert_eq!(err, "");
	let once = "can has logged on console from .\nbob has logged on pts/3 from 10.0.0.7.\nalice \
	            has logged on s001 from box.\n";
	assert_eq!(out, format!("{once}0\n{once}"));
	assert_eq!(st, 0);
}

#[test]
fn zsh_mod_watch_entries_select_users_lines_and_hosts() {
	for (watch, want) in [
		("notme", "alice bob can "),
		("alice", "alice "),
		("'b*'", "bob "),
		("%console", "can "),
		("'@box*'", "alice "),
		("'*%pts/*@10.*'", "bob "),
		("nobody", ""),
		("nobody can", "can "),
	] {
		let src = format!("zmodload zsh/watch; WATCHFMT='%n '; watch=({watch}); log");
		let (out, err, _) = zsh_on(host(sessions()), &src);
		assert_eq!(err, "", "{watch}");
		let mut users: Vec<&str> = out.lines().map(str::trim_end).collect();
		users.sort_unstable();
		let got: String = users.iter().map(|u| format!("{u} ")).collect();
		assert_eq!(got, want, "{watch}");
	}
}

#[test]
fn zsh_mod_watch_format_escapes() {
	let fmt = r"%n|%a|%l|%m|%M|%%|%x|%(a.on.off)|%(n.N.n)|%(l.L.l)|%(m.M.m)|%(z.Z.z)|\%|%T|%t|%W|%D|%w|%D{%H:%M}|%B%b%S%s%U%u|%F{red}%f%K{blue}%k|x";
	let src = format!("zmodload zsh/watch; watch=(alice can); WATCHFMT='{fmt}'; log");
	let (out, err, st) = zsh_on(host(sessions()), &src);
	assert_eq!(err, "");
	assert_eq!(
		out,
		"can|logged on|console|||%|%x|on|N|L|m||%|19:26|7:26PM|11/14/23|23-11-14|Tue \
		 14|19:26||\x1b[31m\x1b[39m\x1b[44m\x1b[49m|x\nalice|logged \
		 on|s001|box|box.example.com|%|%x|on|N|L|M||%|22:13|10:13PM|11/14/23|23-11-14|Tue \
		 14|22:13||\x1b[31m\x1b[39m\x1b[44m\x1b[49m|x\n"
	);
	assert_eq!(st, 0);
}

#[test]
fn zsh_mod_watch_without_a_login_database_reports_nothing() {
	let (out, err, st) = zsh_on(FakeHost::new(), "zmodload zsh/watch; watch=(all); log; echo $?");
	assert_eq!((out.as_str(), err.as_str(), st), ("0\n", "", 0));
}
