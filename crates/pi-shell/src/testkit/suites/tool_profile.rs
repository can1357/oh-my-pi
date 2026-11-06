//! [`Profile::Tool`]: a shell a program drives (an agent's `bash` tool)
//! touches none of its user's interactive state. Each case runs the same
//! input as a user's shell and as a tool's: the user's shell shows the
//! state is there to touch.

use crate::{
	bash::{ModeId, Origin, Profile, Script, ShellInit},
	testkit::{
		FakeHost, Fault, MemFs,
		fault::{Rig, skeleton_init},
	},
};

/// What a run left: stdout, stderr, status.
struct Ran {
	out:    String,
	err:    String,
	status: i32,
}

/// Run `src` in a shell of `mode` and `profile` over `fs` (`HOME=/h`):
/// read from standard input by an interactive shell when `interactive`,
/// else as `-c`.
fn run(mode: ModeId, profile: Profile, fs: &MemFs, interactive: bool, src: &str) -> Ran {
	let zsh = mode == ModeId::Zsh;
	let init = ShellInit {
		mode,
		argv0: if zsh { "zsh" } else { "bash" }.into(),
		interactive,
		profile,
		env: vec![
			("PATH".into(), "/usr/bin:/bin".into()),
			("HOME".into(), "/h".into()),
			("PS1".into(), "".into()),
		],
		options: if zsh {
			vec![("promptsp".into(), false)]
		} else {
			Vec::new()
		},
		..skeleton_init(&[])
	};
	let mut host = FakeHost::new().with_fs(fs.clone());
	if interactive {
		host = host.with_stdin(src.as_bytes());
	}
	let mut rig = Rig::new(host, init);
	let script = if interactive {
		Script { origin: Origin::Stdin, ..Script::command(Vec::new()) }
	} else {
		Script::command(src.as_bytes().to_vec())
	};
	let status = rig.run(script, Fault::None);
	Ran {
		out: String::from_utf8_lossy(&rig.host.stdout.bytes()).into_owned(),
		err: String::from_utf8_lossy(&rig.host.stderr.bytes()).into_owned(),
		status,
	}
}

/// A history file and a home directory.
fn home() -> MemFs {
	let fs = MemFs::new();
	fs.add_file("/h/hist", b": 1600000000:5;echo old\n", 0o600);
	fs
}

/// An interactive zsh with `HISTFILE` set: the user's shell reads the file,
/// records events, writes `fc -W` files and saves at exit; the tool's
/// records nothing, reads nothing, fails `fc -W` without creating anything
/// (no file, no `.LOCK`) and does not save at exit.
#[test]
fn zsh_history_files_and_recording() {
	let src = "HISTFILE=/h/hist; SAVEHIST=10; unsetopt histsavebycopy\nfc -R\necho one\nprint -r \
	           -- ${#history}\nprint -s pushed\nfc -W /h/out\n";
	let user = home();
	let ran = run(ModeId::Zsh, Profile::User, &user, true, src);
	assert_ne!(ran.out.lines().last(), Some("0"), "user shell keeps history: {}", ran.out);
	assert!(user.read("/h/out").is_some());
	assert_ne!(user.read("/h/hist").unwrap(), b": 1600000000:5;echo old\n");

	let tool = home();
	let ran = run(ModeId::Zsh, Profile::Tool, &tool, true, src);
	assert_eq!(ran.out, "one\n0\n");
	// Only `fc -W` complains: the exit save does not run.
	assert_eq!(
		ran.err
			.matches("history files are not available in this shell")
			.count(),
		1,
		"{}",
		ran.err
	);
	assert!(tool.read("/h/out").is_none());
	assert!(tool.read("/h/out.LOCK").is_none());
	assert_eq!(tool.read("/h/hist").unwrap(), b": 1600000000:5;echo old\n");
}

/// An interactive bash: the tool's records nothing, `history -r/-w` fail,
/// and it has no programmable completion (`compgen`, `complete`) or
/// readline bindings (`bind`), as a bash built without readline.
#[test]
fn bash_history_and_completion() {
	let src = "set -o history\necho a\nhistory -w /h/b; echo st=$?\nhistory -r /h/hist; echo \
	           st=$?\nhistory\ncompgen -W xy x; complete -F f g; bind -l >/dev/null; echo st=$?\n";
	let user = home();
	let ran = run(ModeId::Bash, Profile::User, &user, true, src);
	assert!(ran.out.contains("st=0\nst=0\n"), "{}", ran.out);
	assert!(ran.out.contains("echo a") && ran.out.contains("\nxy\nst=0\n"), "{}", ran.out);
	assert!(user.read("/h/b").is_some());

	let tool = home();
	let ran = run(ModeId::Bash, Profile::Tool, &tool, true, src);
	assert_eq!(ran.out, "a\nst=1\nst=1\nst=127\n");
	assert!(tool.read("/h/b").is_none());
	for cmd in ["compgen", "complete", "bind"] {
		assert!(ran.err.contains(&format!("{cmd}: command not found")), "{}", ran.err);
	}
}

/// The line editor's and the completion system's modules do not load in a
/// tool shell (so neither do their builtins); other modules do.
#[test]
fn no_line_editor_or_completion_modules() {
	let src = "for m in zsh/zle zsh/complete zsh/complist zsh/computil zsh/datetime; do zmodload \
	           $m 2>/dev/null; print -n $?; done; echo; (bindkey -l) >/dev/null 2>&1; echo $?; \
	           (compadd x)";
	// `compadd` fails outside a completion widget either way; only the
	// tool's cannot load it.
	let ran = run(ModeId::Zsh, Profile::User, &MemFs::new(), false, src);
	assert_eq!(ran.out, "00000\n0\n");
	assert!(!ran.err.contains("zsh/complete"), "{}", ran.err);
	let ran = run(ModeId::Zsh, Profile::Tool, &MemFs::new(), false, src);
	assert_eq!(ran.out, "11110\n1\n");
	assert!(ran.err.contains("zsh/complete"), "{}", ran.err);
}

/// A nested interactive `zsh -i`/`bash -i` started by a tool shell reads
/// the non-interactive startup files only: no `.zshrc` or `.bashrc`, where
/// completion and history are set up.
#[test]
fn nested_interactive_shells_skip_rc_files() {
	let fs = MemFs::new();
	fs.add_file("/h/.zshenv", b"echo zshenv\n", 0o644);
	fs.add_file("/h/.zshrc", b"echo zshrc\n", 0o644);
	fs.add_file("/h/.bashrc", b"echo bashrc\n", 0o644);
	let src = "zsh -i -c 'echo zcmd'; bash -i -c 'echo bcmd'";
	let ran = run(ModeId::Bash, Profile::User, &fs, false, src);
	for line in ["zshenv", "zshrc", "zcmd", "bashrc", "bcmd"] {
		assert!(ran.out.lines().any(|l| l == line), "user shell missed {line}: {}", ran.out);
	}
	let ran = run(ModeId::Bash, Profile::Tool, &fs, false, src);
	for line in ["zshenv", "zcmd", "bcmd"] {
		assert!(ran.out.lines().any(|l| l == line), "tool shell missed {line}: {}", ran.out);
	}
	assert!(!ran.out.contains("zshrc") && !ran.out.contains("bashrc"), "{}", ran.out);
	assert_eq!(ran.status, 0);
}
