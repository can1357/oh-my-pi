//! zsh history (ports of zsh 5.9 `hist.c` and `bin_fc`): bang history,
//! quick substitution, `fc`/`r`/`history`, `print -s`, the history stack,
//! `$history`/`HISTCMD`, and the history file. Expected output comes from
//! `PS1= /bin/zsh -f -i +o promptsp < input` (or `/bin/zsh -f -c`) 5.9.

use crate::{
	bash::{ModeId, Origin, Script, ShellInit},
	testkit::{
		FakeHost, Fault, MemFs,
		fault::{Rig, skeleton_init},
	},
};

/// A zsh history file written by zsh 5.9 (`fc -W` with `extendedhistory`):
/// multi-line events, metafied non-ASCII text, trailing backslashes, a
/// leading colon.
const ZSH_FILE: &[u8] = include_bytes!("../fixtures/history/zsh_extended.hist");

/// A zsh shell: interactive when `interactive`, `rcs` as given (`-f` is
/// off).
fn init(interactive: bool, rcs: bool) -> ShellInit {
	ShellInit {
		mode: ModeId::Zsh,
		argv0: "zsh".into(),
		interactive,
		env: vec![("PATH".into(), "/usr/bin:/bin".into()), ("PS1".into(), "".into())],
		options: vec![("promptsp".into(), false), ("rcs".into(), rcs)],
		..skeleton_init(&[])
	}
}

/// `zsh -f -i < input`: stdout, stderr, status.
fn interactive(input: &str) -> (String, String, i32) {
	run_stdin(input, MemFs::new(), false)
}

fn run_stdin(input: &str, fs: MemFs, rcs: bool) -> (String, String, i32) {
	let host = FakeHost::new().with_fs(fs).with_stdin(input.as_bytes());
	let mut rig = Rig::new(host, init(true, rcs));
	let status =
		rig.run(Script { origin: Origin::Stdin, ..Script::command(Vec::new()) }, Fault::None);
	(
		String::from_utf8_lossy(&rig.host.stdout.bytes()).into_owned(),
		String::from_utf8_lossy(&rig.host.stderr.bytes()).into_owned(),
		status,
	)
}

/// `zsh -f [-i] -c src` over `fs`.
fn command(src: &str, fs: MemFs, interactive: bool) -> (String, String, i32) {
	let host = FakeHost::new().with_fs(fs);
	let mut rig = Rig::new(host, init(interactive, false));
	let status = rig.run(Script::command(src.as_bytes().to_vec()), Fault::None);
	(
		String::from_utf8_lossy(&rig.host.stdout.bytes()).into_owned(),
		String::from_utf8_lossy(&rig.host.stderr.bytes()).into_owned(),
		status,
	)
}

#[test]
fn bang_events_words_and_modifiers() {
	let (out, err, st) =
		interactive("echo a b c\n!!\necho !$ !^\n!-2:s/a/X/\necho !#\n^b^Q\n!e:p\n!!\n");
	assert_eq!(out, "a b c\na b c\nc a\nX b c\necho\necho\n");
	assert_eq!(
		err,
		"echo a b c\necho c a\necho X b c\necho echo \nzsh: substitution failed\necho echo \necho \
		 echo \n"
	);
	assert_eq!(st, 0);
}

#[test]
fn bang_quoting_and_escapes() {
	let (out, err, _) = interactive("echo 'a!!'\necho \"b!!\" \\!! c!\nfc -l\n");
	assert_eq!(
		out,
		"a!!\nbecho 'a!!' !! c!\n    1  echo 'a!!'\n    2  echo \"becho 'a!!'\" \\!! c!\n"
	);
	assert_eq!(err, "echo \"becho 'a!!'\" \\!! c!\n");
}

#[test]
fn bang_errors_abandon_the_event() {
	let (out, err, _) = interactive("echo a b\n!foo\necho $?\n!!:3\n!!:z\n!?zz?\nfc -l\n");
	assert_eq!(out, "a b\n1\n    1  echo a b\n    2  echo $?\n");
	assert_eq!(
		err,
		"zsh: event not found: foo\nzsh: no such word in event\nzsh: illegal modifier: z\nzsh: no \
		 such event: zz\n"
	);
}

#[test]
fn fc_r_print_s_and_the_history_stack() {
	let (out, err, _) = interactive(
		"echo a\necho b; echo c\nr echo\nfc -l\nr -2\nfc -e - b=Q 2\nprint -s x  y\nhistory \
		 -1\necho $HISTCMD ${#history} $history[1]\nfc -p\nfc -l\necho $HISTCMD\nfc -P\nfc -ln -2\n",
	);
	assert_eq!(
		out,
		"a\nb\nc\nb\nc\n    1  echo a\n    2  echo b; echo c\n    3  r echo\n    4  echo b; echo \
		 c\nb\nc\nQ\nc\n   11  x y\n13 12 echo a\n    1  fc -l\n2\necho $HISTCMD ${#history} \
		 $history[1]\nfc -p\n"
	);
	assert_eq!(err, "echo b; echo c\necho b; echo c\necho Q; echo c\n");
}

#[test]
fn fc_in_a_command_string() {
	let (out, err, st) =
		command("print -s a b; print -S \"x  y|z\"; fc -l; history; fc -ln -1", MemFs::new(), false);
	assert_eq!(out, "    1  a b\n    2  x  y|z\n    1  a b\n    2  x  y|z\na b\nx  y|z\n");
	assert_eq!(err, "");
	assert_eq!(st, 0);
	let (_, err, st) = command("fc -l", MemFs::new(), false);
	assert_eq!(err, "zsh:fc:1: no such event: 1\n");
	assert_eq!(st, 1);
}

#[test]
fn history_parameters() {
	let (out, err, _) = command(
		"print -s a; print -s b; print -s c; echo ${(k)history}; echo ${history[3]} ${history[1]} \
		 x${history[9]}x; echo $historywords; echo $HISTCMD; HISTSIZE=2; echo ${(k)history} \
		 $HISTCMD; unset HISTSIZE; echo ${+HISTSIZE}; HISTSIZE=0; echo $HISTSIZE; echo \
		 ${(t)HISTSIZE} ${(t)history} $histchars",
		MemFs::new(),
		false,
	);
	assert_eq!(
		out,
		"2 1\nc a xx\nb a\n3\n2 3\n0\n1\ninteger-special association-readonly-hide-hideval-special \
		 !^#\n"
	);
	assert_eq!(err, "");
}

/// A file zsh wrote is read and written back byte for byte.
#[test]
fn history_file_round_trips() {
	let fs = MemFs::new();
	fs.add_file("/home/in", ZSH_FILE, 0o600);
	let (_, err, st) = command(
		"SAVEHIST=100; setopt extendedhistory; fc -R /home/in; fc -W /home/out",
		fs.clone(),
		true,
	);
	assert_eq!(err, "");
	assert_eq!(st, 0);
	assert_eq!(fs.read("/home/out").as_deref(), Some(ZSH_FILE));
}

/// An interactive shell reads `HISTFILE` once its startup files ran and
/// saves it as its input ends (appended, then rewritten to `SAVEHIST`
/// events), taking and dropping the `.LOCK` link.
#[test]
fn startup_read_and_exit_save() {
	let fs = MemFs::new();
	fs.add_file("/home/hist", b": 1600000000:5;echo old\n", 0o600);
	let input = "fc -l\necho new\n";
	let (out, err, _) = run_stdin(input, fs.clone(), true);
	assert_eq!(err, "");
	// No HISTFILE yet at startup: nothing read.
	assert_eq!(out, "    1  fc -l\nnew\n");
	// `histsavebycopy` would refuse: the in-memory file belongs to root.
	let input =
		"HISTFILE=/home/hist; SAVEHIST=10; setopt extendedhistory; unsetopt histsavebycopy\n";
	let (_, err, _) = run_stdin(input, fs.clone(), true);
	assert_eq!(err, "");
	assert_eq!(
		fs.read("/home/hist").unwrap(),
		b": 1600000000:5;echo old\n: 1700000000:0;HISTFILE=/home/hist; SAVEHIST=10; setopt \
		  extendedhistory; unsetopt histsavebycopy\n"
	);
	assert!(fs.read("/home/hist.LOCK").is_none());
}

/// `zshaddhistory` sees each event (with its newline); a nonzero status
/// keeps the event out once the next one is read.
#[test]
fn zshaddhistory_gates_events() {
	let (out, err, _) = interactive(
		"zshaddhistory() { print -r -- \"hook:[${1}]\"; [[ $1 != secret* ]] }\necho one\nsecret=1; \
		 echo two\nfc -l\n",
	);
	assert_eq!(
		out,
		"hook:[echo one\n]\none\nhook:[secret=1; echo two\n]\ntwo\nhook:[fc -l\n]\n    1  \
		 zshaddhistory() { print -r -- \"hook:[${1}]\"; [[ $1 != secret* ]] }\n    2  echo one\n"
	);
	assert_eq!(err, "");
}
