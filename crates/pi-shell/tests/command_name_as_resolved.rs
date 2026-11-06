//! A diagnostic names a command the way the shell spelled it while resolving it:
//! the `$PATH` entry joined to the word, or the hashed path, as Bash 5.3.0 does.
//!
//! Bash 5.3.0 is the target. A row whose comment names Bash 5.2.21's output differs
//! only because 5.2.21 does not read a refused executable's `#!` line: it reports
//! `cannot execute: required file not found` (127) where 5.3.0 reports
//! `bad interpreter` (126). The name under test is the same in both.

#![cfg(unix)]

use std::{collections::HashMap, os::unix::process::CommandExt, path::Path, process::Command};

use bstr::ByteSlice;
use pi_shell::{Shell, ShellRunOptions, cancel::CancelToken};

/// How a row reaches the engine.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
	/// `pi_shell::Shell::run`: the command string omp's bash tool runs, whose `$0`
	/// is `bash`.
	Dashc,
	/// A script file the `obash` binary reads, whose `$0` and `BASH_SOURCE[0]` are
	/// the script: script mode is not reachable through `Shell::run`.
	ScriptFile,
}

/// One case: what Bash 5.3.0 writes for `script` after `setup`, byte for byte.
struct Row {
	id:     &'static str,
	/// Run by `/bin/sh` in the case directory before the shell under test.
	setup:  &'static str,
	mode:   Mode,
	script: &'static str,
	status: i32,
	stdout: &'static [u8],
	stderr: &'static [u8],
}

/// The environment both the engine and the recorded Bash runs saw.
fn case_env(home: &Path) -> HashMap<String, String> {
	[
		("PATH", "/usr/bin:/bin"),
		("LC_ALL", "C.UTF-8"),
		("TERM", "dumb"),
		("HOME", &home.display().to_string()),
	]
	.into_iter()
	.map(|(k, v)| (k.to_owned(), v.to_owned()))
	.collect()
}

/// `(status, stdout, stderr, directory)` of `row`, with both streams redirected to
/// files so the bytes are exact (`Shell::run` hands its caller a `String` channel,
/// which replaces every byte that is not UTF-8). The directory is what a row's
/// `{D}` stands for.
async fn observe(row: &Row) -> (i32, Vec<u8>, Vec<u8>, String) {
	let dir = tempfile::Builder::new()
		.prefix(row.id)
		.tempdir()
		.expect("case directory");
	let home = dir.path().display().to_string();
	let env = case_env(dir.path());
	if !row.setup.is_empty() {
		let status = Command::new("/bin/sh")
			.arg("-c")
			.arg(row.setup)
			.current_dir(dir.path())
			.env_clear()
			.envs(&env)
			.status()
			.expect("run the case setup");
		assert!(status.success(), "{}: setup failed", row.id);
	}
	let (out, err) = (dir.path().join("stdout.bin"), dir.path().join("stderr.bin"));
	match row.mode {
		Mode::Dashc => {
			let command =
				format!("exec >'{}' 2>'{}'; {}", out.display(), err.display(), row.script);
			let result = Shell::new(None)
				.run(
					ShellRunOptions {
						command,
						cwd: Some(home.clone()),
						env: Some(env),
						..Default::default()
					},
					None,
					CancelToken::new(Some(30_000)),
				)
				.await
				.expect("run the case");
			let read = |p: &Path| std::fs::read(p).unwrap_or_default();
			(result.exit_code.unwrap_or(-1), read(&out), read(&err), home)
		},
		Mode::ScriptFile => {
			std::fs::write(dir.path().join("script.sh"), format!("{}\n", row.script))
				.expect("write the case script");
			let done = Command::new(env!("CARGO_BIN_EXE_obash"))
				.arg0("bash")
				.arg("script.sh")
				.current_dir(dir.path())
				.env_clear()
				.envs(&env)
				.output()
				.expect("run obash");
			(done.status.code().unwrap_or(-1), done.stdout, done.stderr, home)
		},
	}
}

/// Every row whose id starts with one of `prefixes`, reported together so one run
/// shows the whole table.
async fn assert_rows(prefixes: &[&str]) {
	let mut differ = Vec::new();
	let mut ran = 0;
	for row in ROWS.iter().filter(|r| prefixes.iter().any(|p| r.id.starts_with(p))) {
		ran += 1;
		let (status, stdout, stderr, home) = observe(row).await;
		let want = row.stderr.replace("{D}", &home);
		if (status, stdout.as_slice(), stderr.as_slice()) != (row.status, row.stdout, want.as_slice()) {
			differ.push(format!(
				"{}\n  bash 5.3.0: {} out={:?} err={:?}\n  engine:     {status} out={:?} err={:?}",
				row.id,
				row.status,
				row.stdout.as_bstr(),
				want.as_bstr(),
				stdout.as_bstr(),
				stderr.as_bstr(),
			));
		}
	}
	assert!(ran > 0, "no row matched {prefixes:?}");
	assert!(
		differ.is_empty(),
		"{} of {ran} rows differ from Bash 5.3.0:\n{}",
		differ.len(),
		differ.join("\n")
	);
}

const ROWS: &[Row] = &[
	// res-dot-badinterp (c)  // 5.2.21 differs: 127 'bash: line 1: ./victim: cannot execute: required file not found\n'
	Row {
		id: "res-dot-badinterp",
		setup: r#"printf '#!/missing/review/interpreter\n' > victim; chmod 755 victim"#,
		mode: Mode::Dashc,
		script: "PATH=.:/usr/bin:/bin; victim",
		status: 126,
		stdout: b"",
		stderr: b"bash: ./victim: /missing/review/interpreter: bad interpreter: No such file or directory\n",
	},
	// res-empty-entry-badinterp (c)  // 5.2.21 differs: 127 'bash: line 1: ./victim: cannot execute: required file not found\n'
	Row {
		id: "res-empty-entry-badinterp",
		setup: r#"printf '#!/missing/review/interpreter\n' > victim; chmod 755 victim"#,
		mode: Mode::Dashc,
		script: "PATH=:/usr/bin:/bin; victim",
		status: 126,
		stdout: b"",
		stderr: b"bash: ./victim: /missing/review/interpreter: bad interpreter: No such file or directory\n",
	},
	// res-reldir-badinterp (c)  // 5.2.21 differs: 127 'bash: line 1: bin/victim: cannot execute: required file not found\n'
	Row {
		id: "res-reldir-badinterp",
		setup: r#"mkdir -p bin; printf '#!/missing/review/interpreter\n' > bin/victim; chmod 755 bin/victim"#,
		mode: Mode::Dashc,
		script: "PATH=bin:/usr/bin:/bin; victim",
		status: 126,
		stdout: b"",
		stderr: b"bash: bin/victim: /missing/review/interpreter: bad interpreter: No such file or directory\n",
	},
	// res-dot-permission (c)
	Row {
		id: "res-dot-permission",
		setup: r#"printf 'x\n' > noexec; chmod 644 noexec"#,
		mode: Mode::Dashc,
		script: "PATH=.:/usr/bin:/bin; noexec",
		status: 126,
		stdout: b"",
		stderr: b"bash: line 1: ./noexec: Permission denied\n",
	},
	// res-dot-binary (c)
	Row {
		id: "res-dot-binary",
		setup: r#"printf 'text\000\001 then a NUL\n' > binfile; chmod 755 binfile"#,
		mode: Mode::Dashc,
		script: "PATH=.:/usr/bin:/bin; binfile",
		status: 126,
		stdout: b"",
		stderr: b"bash: line 1: ./binfile: cannot execute binary file: Exec format error\n",
	},
	// res-source-path-bash-source (c)
	Row {
		id: "res-source-path-bash-source",
		setup: r#"mkdir -p lib; printf 'echo "BS=${BASH_SOURCE[0]}"\n' > lib/named.sh"#,
		mode: Mode::Dashc,
		script: "PATH=lib:$PATH; . named.sh",
		status: 0,
		stdout: b"BS=lib/named.sh\n",
		stderr: b"",
	},
	// res-dot-isdir (c)
	Row {
		id: "res-dot-isdir",
		setup: "mkdir -p adir",
		mode: Mode::Dashc,
		script: "PATH=.:/usr/bin:/bin; adir",
		status: 127,
		stdout: b"",
		stderr: b"bash: line 1: adir: command not found\n",
	},
	// res-hash-relative (c)  // 5.2.21 differs: 127 'bash: line 1: ./victim: cannot execute: required file not found\n'
	Row {
		id: "res-hash-relative",
		setup: r#"printf '#!/missing/review/interpreter\n' > victim; chmod 755 victim"#,
		mode: Mode::Dashc,
		script: "hash -p ./victim victim; victim",
		status: 126,
		stdout: b"",
		stderr: b"bash: ./victim: /missing/review/interpreter: bad interpreter: No such file or directory\n",
	},
	// res-hash-relative-bare (c)  // 5.2.21 differs: 127 'bash: line 1: ./victim: cannot execute: required file not found\n'
	Row {
		id: "res-hash-relative-bare",
		setup: r#"printf '#!/missing/review/interpreter\n' > victim; chmod 755 victim"#,
		mode: Mode::Dashc,
		script: "hash -p victim victim; victim",
		status: 126,
		stdout: b"",
		stderr: b"bash: ./victim: /missing/review/interpreter: bad interpreter: No such file or directory\n",
	},
	// res-hash-t-after-path-find (c)
	Row {
		id: "res-hash-t-after-path-find",
		setup: r#"printf '#!/missing/review/interpreter\n' > victim; chmod 755 victim"#,
		mode: Mode::Dashc,
		script: "PATH=.:/usr/bin:/bin; victim 2>/dev/null; hash -t victim",
		status: 0,
		stdout: b"./victim\n",
		stderr: b"",
	},
	// res-hash-list-after-path-find (c)
	Row {
		id: "res-hash-list-after-path-find",
		setup: r#"printf '#!/missing/review/interpreter\n' > victim; chmod 755 victim"#,
		mode: Mode::Dashc,
		script: "PATH=.:/usr/bin:/bin; victim 2>/dev/null; hash",
		status: 0,
		stdout: b"hits\tcommand\n   1\t./victim\n",
		stderr: b"",
	},
	// res-bash-cmds-after-path-find (c)
	Row {
		id: "res-bash-cmds-after-path-find",
		setup: r#"printf '#!/missing/review/interpreter\n' > victim; chmod 755 victim"#,
		mode: Mode::Dashc,
		script: r#"PATH=.:/usr/bin:/bin; victim 2>/dev/null; echo "${BASH_CMDS[victim]}""#,
		status: 0,
		stdout: b"./victim\n",
		stderr: b"",
	},
	// res-type-p-dot (c)
	Row {
		id: "res-type-p-dot",
		setup: r#"printf '#!/missing/review/interpreter\n' > victim; chmod 755 victim"#,
		mode: Mode::Dashc,
		script: "PATH=.:/usr/bin:/bin; type -p victim",
		status: 0,
		stdout: b"./victim\n",
		stderr: b"",
	},
	// res-command-v-dot (c)
	Row {
		id: "res-command-v-dot",
		setup: r#"printf '#!/missing/review/interpreter\n' > victim; chmod 755 victim"#,
		mode: Mode::Dashc,
		script: "PATH=.:/usr/bin:/bin; command -v victim",
		status: 0,
		stdout: b"./victim\n",
		stderr: b"",
	},
	// res-slash-word (c)  // 5.2.21 differs: 127 'bash: line 1: ././victim: cannot execute: required file not found\n'
	Row {
		id: "res-slash-word",
		setup: r#"printf '#!/missing/review/interpreter\n' > victim; chmod 755 victim"#,
		mode: Mode::Dashc,
		script: "././victim",
		status: 126,
		stdout: b"",
		stderr: b"bash: ././victim: /missing/review/interpreter: bad interpreter: No such file or directory\n",
	},
	// res-absolute-entry (c)  // 5.2.21 differs: 127 'bash: line 1: {D}/victim: cannot execute: required file not found\n'
	Row {
		id: "res-absolute-entry",
		setup: r#"printf '#!/missing/review/interpreter\n' > victim; chmod 755 victim"#,
		mode: Mode::Dashc,
		script: r#"PATH="$PWD":/usr/bin:/bin; victim"#,
		status: 126,
		stdout: b"",
		stderr: b"bash: {D}/victim: /missing/review/interpreter: bad interpreter: No such file or directory\n",
	},
	// res-hiddendir-badinterp (c)  // 5.2.21 differs: 127 'bash: line 1: .hid/victim: cannot execute: required file not found\n'
	Row {
		id: "res-hiddendir-badinterp",
		setup: r#"mkdir -p .hid; printf '#!/missing/review/interpreter\n' > .hid/victim; chmod 755 .hid/victim"#,
		mode: Mode::Dashc,
		script: "PATH=.hid:/usr/bin:/bin; victim",
		status: 126,
		stdout: b"",
		stderr: b"bash: .hid/victim: /missing/review/interpreter: bad interpreter: No such file or directory\n",
	},
	// res-nohash-dot (c)  // 5.2.21 differs: 127 'bash: line 1: ./victim: cannot execute: required file not found\n'
	Row {
		id: "res-nohash-dot",
		setup: r#"printf '#!/missing/review/interpreter\n' > victim; chmod 755 victim"#,
		mode: Mode::Dashc,
		script: "set +h; PATH=.:/usr/bin:/bin; victim",
		status: 126,
		stdout: b"",
		stderr: b"bash: ./victim: /missing/review/interpreter: bad interpreter: No such file or directory\n",
	},
	// res-temp-path (c)  // 5.2.21 differs: 127 'bash: line 1: ./victim: cannot execute: required file not found\n'
	Row {
		id: "res-temp-path",
		setup: r#"printf '#!/missing/review/interpreter\n' > victim; chmod 755 victim"#,
		mode: Mode::Dashc,
		script: "PATH=.:/usr/bin:/bin victim",
		status: 126,
		stdout: b"",
		stderr: b"bash: ./victim: /missing/review/interpreter: bad interpreter: No such file or directory\n",
	},
	// res-hash-t-after-reldir-find (c)
	Row {
		id: "res-hash-t-after-reldir-find",
		setup: r#"mkdir -p bin; printf '#!/missing/review/interpreter\n' > bin/victim; chmod 755 bin/victim"#,
		mode: Mode::Dashc,
		script: "PATH=bin:/usr/bin:/bin; victim 2>/dev/null; hash -t victim",
		status: 0,
		stdout: b"./bin/victim\n",
		stderr: b"",
	},
	// res-hash-p-reldir-run (c)  // 5.2.21 differs: 127 'bash: line 1: ./bin/victim: cannot execute: required file not found\n'
	Row {
		id: "res-hash-p-reldir-run",
		setup: r#"mkdir -p bin; printf '#!/missing/review/interpreter\n' > bin/victim; chmod 755 bin/victim"#,
		mode: Mode::Dashc,
		script: "hash -p bin/victim victim; victim",
		status: 126,
		stdout: b"",
		stderr: b"bash: ./bin/victim: /missing/review/interpreter: bad interpreter: No such file or directory\n",
	},
	// res-hash-p-reldir-type (c)
	Row {
		id: "res-hash-p-reldir-type",
		setup: r#"mkdir -p bin; printf '#!/missing/review/interpreter\n' > bin/victim; chmod 755 bin/victim"#,
		mode: Mode::Dashc,
		script: "hash -p bin/victim victim; type -p victim; command -v victim; hash -l",
		status: 0,
		stdout: b"./bin/victim\n./bin/victim\nbuiltin hash -p bin/victim victim\n",
		stderr: b"",
	},
	// res-hash-p-missing-t (c)
	Row {
		id: "res-hash-p-missing-t",
		setup: "",
		mode: Mode::Dashc,
		script: "hash -p nonexist/q victim; hash -t victim",
		status: 0,
		stdout: b"nonexist/q\n",
		stderr: b"",
	},
	// res-not-found (c)
	Row {
		id: "res-not-found",
		setup: "",
		mode: Mode::Dashc,
		script: "PATH=.:/usr/bin:/bin; nosuchcmd_xyz",
		status: 127,
		stdout: b"",
		stderr: b"bash: line 1: nosuchcmd_xyz: command not found\n",
	},
	// res-dot-badinterp-script (file)  // 5.2.21 differs: 127 'script.sh: line 1: ./victim: cannot execute: required file not found\n'
	Row {
		id: "res-dot-badinterp-script",
		setup: r#"printf '#!/missing/review/interpreter\n' > victim; chmod 755 victim"#,
		mode: Mode::ScriptFile,
		script: "PATH=.:/usr/bin:/bin; victim",
		status: 126,
		stdout: b"",
		stderr: b"script.sh: ./victim: /missing/review/interpreter: bad interpreter: No such file or directory\n",
	},
];

/// A relative `$PATH` entry (`.`, an empty entry read as `.`, `bin`) and a hashed
/// relative path keep their spelling in the diagnostic, in the hash table and in
/// `BASH_CMDS`. A word that already contains a slash, and an absolute entry, are
/// unchanged.
#[tokio::test(flavor = "multi_thread")]
async fn a_command_is_named_as_it_was_resolved() {
	assert_rows(&["res-"]).await;
}
