//! Acceptance through the `obash` binary: output, golden events, the
//! fault flag, `--ir` and `--print`.

mod obash_support;

use std::{fmt::Write as _, fs, path::PathBuf};

use pi_shell::testkit::golden;

use crate::obash_support::{obash, output};

const LOOP: &str = "for i in 1 2; do echo $i; done";

fn events_fixture(name: &str) -> PathBuf {
	PathBuf::from(env!("CARGO_MANIFEST_DIR"))
		.join("src/testkit/fixtures/events")
		.join(name)
}

#[test]
fn for_loop_prints_one_two() {
	let out = output(obash().args(["-c", LOOP]));
	assert_eq!(String::from_utf8_lossy(&out.stdout), "1\n2\n");
	assert!(out.stderr.is_empty(), "{}", String::from_utf8_lossy(&out.stderr));
	assert!(out.status.success());
}

/// The drive loop's parker waits for the externals (Linux: their pidfds): a
/// foreground external, a pipeline, a command substitution, and a background
/// external whose exit a busy foreground loop notices without parking; obash
/// exits cleanly with and without externals (a debug build aborts at exit
/// when an fd is closed twice).
#[cfg(unix)]
#[test]
fn externals_are_awaited_and_obash_exits_cleanly() {
	let script = r#"/bin/echo fg; /bin/echo pipe | /bin/cat; x=$(/bin/echo sub); echo "$x"
/bin/sleep 0.05 & i=0
while kill -0 $! 2>/dev/null && [ "$i" -lt 1000000 ]; do i=$((i+1)); done
[ "$i" -lt 1000000 ] && echo noticed
wait; echo "status $?""#;
	let cases = [(":", ""), (LOOP, "1\n2\n"), (script, "fg\npipe\nsub\nnoticed\nstatus 0\n")];
	for (src, expected) in cases {
		let out = output(obash().args(["-c", src]));
		assert_eq!(String::from_utf8_lossy(&out.stdout), expected, "{src}");
		assert!(out.stderr.is_empty(), "{src}: {}", String::from_utf8_lossy(&out.stderr));
		assert!(out.status.success(), "{src}: {:?}", out.status);
	}
}

/// `OBASH_BLESS=1` rewrites the golden from the actual stream (review the
/// diff).
#[test]
fn events_golden() {
	let dir = tempfile::tempdir().unwrap();
	let path = dir.path().join("events.jsonl");
	let out = output(obash().args([
		"--events=jsonl",
		&format!("--events-out={}", path.display()),
		"-c",
		LOOP,
	]));
	assert_eq!(out.stdout, b"1\n2\n");
	let actual =
		golden::normalize(&golden::parse_jsonl(&fs::read_to_string(&path).unwrap()).unwrap());
	let golden_path = events_fixture("for-loop.jsonl");
	if std::env::var_os("OBASH_BLESS").is_some() {
		let text = actual.iter().fold(String::new(), |mut text, e| {
			let _ = writeln!(text, "{e}");
			text
		});
		fs::write(&golden_path, text).unwrap();
	}
	let expected = golden::parse_jsonl(&fs::read_to_string(&golden_path).unwrap()).unwrap();
	if let Some(d) = golden::diff(&actual, &expected) {
		panic!("{d}");
	}
	let kinds: Vec<&str> = actual.iter().map(|e| e["kind"].as_str().unwrap()).collect();
	assert_eq!(kinds.first(), Some(&"RunStart"));
	assert_eq!(kinds.last(), Some(&"RunEnd"));
}

#[test]
fn events_go_to_stderr_without_events_out() {
	let out = output(obash().args(["--events=jsonl", "-c", ":"]));
	let events = golden::parse_jsonl(&String::from_utf8_lossy(&out.stderr)).unwrap();
	assert_eq!(events.first().map(|e| e["kind"].clone()), Some("RunStart".into()));
}

#[test]
fn fault_flag_keeps_output_and_status() {
	for k in ["1", "7", "97"] {
		let out = output(obash().args([
			&format!("--fault=42:{k}"),
			"-c",
			"for i in a b c; do echo $i; false; done; nosuch_cmd_x; echo s=$?",
		]));
		assert_eq!(String::from_utf8_lossy(&out.stdout), "a\nb\nc\ns=127\n", "k={k}");
		assert!(
			String::from_utf8_lossy(&out.stderr)
				.ends_with("line 1: nosuch_cmd_x: command not found\n")
		);
		assert!(out.status.success());
	}
}

#[test]
fn dollar_zero_and_positionals_follow_bash_c() {
	let out = output(obash().args(["-c", "echo $0 $1 $#", "name", "x", "y"]));
	assert_eq!(out.stdout, b"name x 2\n");
}

#[test]
fn scalar_words_keep_quoting_scope_and_replay() {
	let script = r#"
show() { printf '%s:' "$#"; printf '<%s>' "$@"; echo; }
f() {
	local x=$1
	local -n ref=x
	show "$x" "$ref" "$1" "${#1}"
	ref=changed
	show "$x"
}
x=global
f 'a b'
show "$x"
set -- '' 'a b'
a=$1; b=$2
show "$1" "$2" "$a" "$b"
IFS=ab
show "$2" $2
unset IFS missing
show "$missing" "${missing-default}"
set -- old
show "$1" "$(set -- changed; printf sub)" "$1"
set -u
show "$1"
"#;
	let expected = b"4:<a b><a b><a b><3>\n1:<changed>\n1:<global>\n4:<><a b><><a b>\n3:<a b><>< >\n2:<><default>\n3:<old><sub><old>\n1:<old>\n";
	for fault in [false, true] {
		let mut cmd = obash();
		if fault {
			cmd.arg("--fault=1:7");
		}
		let out = output(cmd.args(["-c", script]));
		assert_eq!(out.stdout, expected, "fault={fault}");
		assert!(out.stderr.is_empty(), "{}", String::from_utf8_lossy(&out.stderr));
		assert!(out.status.success());
	}
}

#[test]
fn script_file_errors_use_the_script_name() {
	let dir = tempfile::tempdir().unwrap();
	let script = dir.path().join("s.sh");
	fs::write(&script, "echo a\necho b; fi\necho c\n").unwrap();
	let out = output(obash().arg(&script));
	assert_eq!(out.stdout, b"a\n");
	let name = script.display().to_string();
	assert_eq!(
		String::from_utf8_lossy(&out.stderr),
		format!(
			"{name}: line 2: syntax error near unexpected token `fi'\n{name}: line 2: `echo b; fi'\n"
		)
	);
	assert_eq!(out.status.code(), Some(2));
}

#[test]
fn external_commands_run_through_path() {
	let out = output(
		obash()
			.args(["-c", "sh -c 'exit 3'; echo s=$?"])
			.env("PATH", "/usr/bin:/bin"),
	);
	assert_eq!(out.stdout, b"s=3\n");
}

/// A background external opens its FIFO redirect itself; the shell must not
/// also start the open and drop it. The dropped open's helper connected the
/// writer (`echo two > g`) and then left, so the write hit a FIFO without a
/// reader and SIGPIPE ended the shell. Repeated: the window is a race.
#[cfg(unix)]
#[test]
fn background_fifo_reader_is_the_writers_only_peer() {
	let dir = tempfile::tempdir().unwrap();
	for name in ["f", "g"] {
		let status = std::process::Command::new("mkfifo")
			.arg(dir.path().join(name))
			.status()
			.unwrap();
		assert!(status.success());
	}
	let out = output(obash().current_dir(dir.path()).args([
		"-c",
		"for i in 1 2 3 4 5 6 7 8 9 10; do echo one > f & cat < f; cat < g & echo two > g; wait; \
		 done; echo end",
	]));
	assert_eq!(
		out.stdout,
		"one\ntwo\n"
			.repeat(10)
			.into_bytes()
			.into_iter()
			.chain(*b"end\n")
			.collect::<Vec<_>>()
	);
}

#[test]
fn ir_flag_disassembles_without_running() {
	let out = output(obash().args(["--ir", "-c", LOOP]));
	let text = String::from_utf8(out.stdout).unwrap();
	assert!(
		text.contains(" ForIn ") && text.contains(" ForNext ") && text.contains(" Exec "),
		"{text}"
	);
	assert!(pi_shell::bash::ir::asm::asm(&text).is_ok(), "the disassembly assembles back");
}

#[test]
fn print_flag_prints_declare_f_layout() {
	let out = output(obash().args(["--print", "-c", LOOP]));
	assert_eq!(String::from_utf8_lossy(&out.stdout), "for i in 1 2;\ndo\n    echo $i;\ndone\n");
	let bad = output(obash().args(["--print", "-c", "echo a; fi"]));
	assert_eq!(bad.status.code(), Some(2));
	assert!(
		String::from_utf8_lossy(&bad.stderr)
			.contains("-c: line 1: syntax error near unexpected token `fi'")
	);
}
