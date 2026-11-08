//! The shell on a Windows engine (`EngineConfig::platform`), run on any
//! host: what `omp zsh` and the bash tool show a Windows user.

use bstr::BString;

use crate::{
	bash::{EngineConfig, ModeId, Platform, Script, ShellInit},
	testkit::{FakeHost, Fault, Rig},
};

/// Run `src` as zsh on a Windows engine with `env`; stdout and stderr.
fn zsh_on_windows(env: &[(&str, &str)], src: &str) -> (String, String) {
	let init = ShellInit {
		mode: ModeId::Zsh,
		argv0: "zsh".into(),
		env: env
			.iter()
			.map(|(k, v)| (BString::from(*k), BString::from(*v)))
			.collect(),
		..ShellInit::default()
	};
	let cfg = EngineConfig { platform: Platform::Windows, ..EngineConfig::default() };
	let mut rig = Rig::with_config(FakeHost::new(), init, cfg);
	rig.run(Script::command(src.as_bytes().to_vec()), Fault::None);
	(
		String::from_utf8_lossy(&rig.host.stdout.bytes()).into_owned(),
		String::from_utf8_lossy(&rig.host.stderr.bytes()).into_owned(),
	)
}

/// Windows paths hold `:` (`C:\…`): `$path` splits `PATH` on `;`, and an
/// assignment to `path` joins with `;`, the separator child programs read.
/// Split on `:`, `${path[1]}` was `C`.
#[test]
fn path_tie_uses_the_windows_separator() {
	let (out, err) = zsh_on_windows(
		&[("PATH", "C:\\Windows;C:\\Program Files\\Git\\cmd")],
		"print -rl -- ${#path} ${path[1]}; path+=('D:\\tools'); print -r -- $PATH",
	);
	assert_eq!(out, "2\nC:\\Windows\nC:\\Windows;C:\\Program Files\\Git\\cmd;D:\\tools\n");
	assert_eq!(err, "");
}

/// Without an imported `PATH`, zsh's default list uses the Windows
/// separator too, so the tie sees its four directories.
#[test]
fn default_path_splits_into_its_directories() {
	let (out, _) = zsh_on_windows(&[], "print -r -- ${#path} ${path[1]}");
	assert_eq!(out, "4 /bin\n");
}

/// zsh on Windows reports MSYS2's `OSTYPE` (plugins branch on
/// `[[ $OSTYPE == msys* ]]`), not `linux-gnu`.
#[test]
fn ostype_is_msys() {
	let (out, _) = zsh_on_windows(&[], "print -r -- $OSTYPE");
	assert_eq!(out, "msys\n");
}

/// `PWD` and `HOME` start in the `/` spelling `cd` keeps, so `~`, `%~`
/// and `:t` agree with them from the first prompt.
#[test]
fn pwd_and_home_start_with_slashes() {
	let init = ShellInit {
		mode: ModeId::Zsh,
		argv0: "zsh".into(),
		env: vec![(BString::from("HOME"), BString::from(r"C:\Users\b"))],
		cwd: BString::from(r"C:\Users\b\src"),
		..ShellInit::default()
	};
	let cfg = EngineConfig { platform: Platform::Windows, ..EngineConfig::default() };
	let mut rig = Rig::with_config(FakeHost::new(), init, cfg);
	rig.run(Script::command(b"print -r -- $PWD $HOME ${PWD:t} ${(D)PWD}".to_vec()), Fault::None);
	assert_eq!(
		String::from_utf8_lossy(&rig.host.stdout.bytes()),
		"C:/Users/b/src C:/Users/b src ~/src\n"
	);
}

/// Windows always exports `USERNAME`; reading it in zsh printed a lossy
/// emulation-mode-boundary warning ("bash variable … shadowed by the zsh
/// special") on every run.
#[test]
fn an_imported_username_is_no_lossy_crossing() {
	let (out, err) = zsh_on_windows(&[("USERNAME", "b")], "print -r -- ${+USERNAME}");
	assert_eq!(out, "1\n");
	assert_eq!(err, "");
}

/// Run `src` in `mode` on a `platform` engine; stdout.
fn run_on(mode: ModeId, platform: Platform, src: &str) -> String {
	let argv0 = if mode == ModeId::Zsh { "zsh" } else { "bash" };
	let init = ShellInit { mode, argv0: argv0.into(), ..ShellInit::default() };
	let cfg = EngineConfig { platform, ..EngineConfig::default() };
	let mut rig = Rig::with_config(FakeHost::new(), init, cfg);
	rig.run(Script::command(src.as_bytes().to_vec()), Fault::None);
	String::from_utf8_lossy(&rig.host.stdout.bytes()).into_owned()
}

/// On Windows an asynchronous command without job control ignores `INT`
/// (and in zsh `QUIT`), as zsh and bash have it, so the console's Ctrl-C
/// passes it by: it lists the ignore, zsh's may trap it, bash's (ignored
/// on entry) may not, and the shell's own traps stay unset. Elsewhere it
/// keeps the shell's dispositions.
#[test]
fn async_commands_ignore_interrupts_on_windows_only() {
	let zsh =
		"( trap; trap 'print own' INT; trap ) & wait; print -r -- $(< <(trap)); trap; print done";
	let bash = "( trap; trap 'echo own' INT; trap -p INT ) & wait; trap -p INT; echo done";
	assert_eq!(
		run_on(ModeId::Zsh, Platform::Windows, zsh),
		"trap -- '' INT\ntrap -- '' QUIT\ntrap -- 'print own' INT\ntrap -- '' QUIT\ntrap -- '' INT \
		 trap -- '' QUIT\ndone\n"
	);
	assert_eq!(
		run_on(ModeId::Bash, Platform::Windows, bash),
		"trap -- '' SIGINT\ntrap -- '' SIGINT\ndone\n"
	);
	assert_eq!(run_on(ModeId::Zsh, Platform::Linux, zsh), "trap -- 'print own' INT\n\ndone\n");
	assert_eq!(run_on(ModeId::Bash, Platform::Linux, bash), "trap -- 'echo own' SIGINT\ndone\n");
}
