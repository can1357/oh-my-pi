//! A diagnostic names the file the shell is reading, and prints a name's bytes as
//! they are, as Bash 5.3.0 does.
//!
//! Bash 5.3.0 is the target. A row's comment records any Bash 5.2.21 difference.
//! Bash 5.2.21 does not read a refused executable's `#!` line: it reports
//! `cannot execute: required file not found` (127), not `bad interpreter` (126).
//! It names a function defined in a `-c` string `environment`, not `$0`.
//! Its unexpected-end-of-file syntax error omits the opening command and line.

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
	/// `obash --norc --noprofile -i -c`: runtime errors name the shell;
	/// syntax errors in a `.` file name that file and its line. With no terminal,
	/// Bash first prints two job-control notices, so compare the last line.
	Interactive,
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
		Mode::Interactive => {
			let done = Command::new(env!("CARGO_BIN_EXE_obash"))
				.arg0("bash")
				.args(["--norc", "--noprofile", "-i", "-c", row.script])
				.current_dir(dir.path())
				.env_clear()
				.envs(&env)
				.output()
				.expect("run obash");
			let last = done
				.stderr
				.split_inclusive(|&c| c == b'\n')
				.filter(|l| l.len() > 1)
				.next_back()
				.map_or_else(Vec::new, <[u8]>::to_vec);
			(done.status.code().unwrap_or(-1), done.stdout, last, home)
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
	// src-badinterp (c)  // 5.2.21 differs: 127 './source.sh: line 1: ./victim: cannot execute: required file not found\n'
	Row {
		id: "src-badinterp",
		setup: r#"printf '#!/missing/review/interpreter\n' > victim; chmod 755 victim; printf './victim\n' > source.sh"#,
		mode: Mode::Dashc,
		script: ". ./source.sh",
		status: 126,
		stdout: b"",
		stderr: b"./source.sh: ./victim: /missing/review/interpreter: bad interpreter: No such file or directory\n",
	},
	// src-not-found (c)
	Row {
		id: "src-not-found",
		setup: r#"printf 'nosuchcmd_xyz\n' > source.sh"#,
		mode: Mode::Dashc,
		script: ". ./source.sh",
		status: 127,
		stdout: b"",
		stderr: b"./source.sh: line 1: nosuchcmd_xyz: command not found\n",
	},
	// src-permission (c)
	Row {
		id: "src-permission",
		setup: r#"printf 'x\n' > noexec; chmod 644 noexec; printf './noexec\n' > source.sh"#,
		mode: Mode::Dashc,
		script: ". ./source.sh",
		status: 126,
		stdout: b"",
		stderr: b"./source.sh: line 1: ./noexec: Permission denied\n",
	},
	// src-isdir (c)
	Row {
		id: "src-isdir",
		setup: r#"mkdir -p adir; printf './adir\n' > source.sh"#,
		mode: Mode::Dashc,
		script: ". ./source.sh",
		status: 126,
		stdout: b"",
		stderr: b"./source.sh: line 1: ./adir: Is a directory\n",
	},
	// src-unbound (c)
	Row {
		id: "src-unbound",
		setup: r#"printf 'set -u\necho $UNSET_XYZ\n' > source.sh"#,
		mode: Mode::Dashc,
		script: ". ./source.sh",
		status: 127,
		stdout: b"",
		stderr: b"./source.sh: line 2: UNSET_XYZ: unbound variable\n",
	},
	// src-readonly (c)
	Row {
		id: "src-readonly",
		setup: r#"printf 'readonly R=1\nR=2\n' > source.sh"#,
		mode: Mode::Dashc,
		script: ". ./source.sh",
		status: 1,
		stdout: b"",
		stderr: b"./source.sh: line 2: R: readonly variable\n",
	},
	// src-redirect-error (c)
	Row {
		id: "src-redirect-error",
		setup: r#"printf 'echo hi > /nonexistentdir/x\n' > source.sh"#,
		mode: Mode::Dashc,
		script: ". ./source.sh",
		status: 1,
		stdout: b"",
		stderr: b"./source.sh: line 1: /nonexistentdir/x: No such file or directory\n",
	},
	// src-syntax-error (c)  // 5.2.21 differs: 2 './source.sh: line 2: syntax error: unexpected end of file\n'
	Row {
		id: "src-syntax-error",
		setup: r#"printf 'if\n' > source.sh"#,
		mode: Mode::Dashc,
		script: ". ./source.sh",
		status: 2,
		stdout: b"",
		stderr: b"./source.sh: line 2: syntax error: unexpected end of file from `if' command on line 1\n",
	},
	// src-arith (c)
	Row {
		id: "src-arith",
		setup: r#"printf 'echo $((1/0))\n' > source.sh"#,
		mode: Mode::Dashc,
		script: ". ./source.sh",
		status: 1,
		stdout: b"",
		stderr: b"./source.sh: line 1: 1/0: division by 0 (error token is \"0\")\n",
	},
	// src-bad-subst (c)
	Row {
		id: "src-bad-subst",
		setup: r#"printf 'echo ${x!y}\n' > source.sh"#,
		mode: Mode::Dashc,
		script: ". ./source.sh",
		status: 1,
		stdout: b"",
		stderr: b"./source.sh: line 1: ${x!y}: bad substitution\n",
	},
	// src-builtin-error (c)
	Row {
		id: "src-builtin-error",
		setup: r#"printf 'cd /nonexistentdir\n' > source.sh"#,
		mode: Mode::Dashc,
		script: ". ./source.sh",
		status: 1,
		stdout: b"",
		stderr: b"./source.sh: line 1: cd: /nonexistentdir: No such file or directory\n",
	},
	// src-nested (c)  // 5.2.21 differs: 127 './inner.sh: line 1: ./victim: cannot execute: required file not found\n'
	Row {
		id: "src-nested",
		setup: r#"printf '#!/missing/review/interpreter\n' > victim; chmod 755 victim; printf './victim\n' > inner.sh; printf '. ./inner.sh\n' > outer.sh"#,
		mode: Mode::Dashc,
		script: ". ./outer.sh",
		status: 126,
		stdout: b"",
		stderr: b"./inner.sh: ./victim: /missing/review/interpreter: bad interpreter: No such file or directory\n",
	},
	// src-func-defined-in-file (c)  // 5.2.21 differs: 127 './deffile.sh: line 1: ./victim: cannot execute: required file not found\n'
	Row {
		id: "src-func-defined-in-file",
		setup: r#"printf '#!/missing/review/interpreter\n' > victim; chmod 755 victim; printf 'h(){ ./victim; }\n' > deffile.sh"#,
		mode: Mode::Dashc,
		script: ". ./deffile.sh; h",
		status: 126,
		stdout: b"",
		stderr: b"./deffile.sh: ./victim: /missing/review/interpreter: bad interpreter: No such file or directory\n",
	},
	// src-eval-inside (c)  // 5.2.21 differs: 127 './source.sh: line 1: ./victim: cannot execute: required file not found\n'
	Row {
		id: "src-eval-inside",
		setup: r#"printf '#!/missing/review/interpreter\n' > victim; chmod 755 victim; printf 'eval "./victim"\n' > source.sh"#,
		mode: Mode::Dashc,
		script: ". ./source.sh",
		status: 126,
		stdout: b"",
		stderr: b"./source.sh: ./victim: /missing/review/interpreter: bad interpreter: No such file or directory\n",
	},
	// src-subshell-inside (c)  // 5.2.21 differs: 127 './source.sh: line 1: ./victim: cannot execute: required file not found\n'
	Row {
		id: "src-subshell-inside",
		setup: r#"printf '#!/missing/review/interpreter\n' > victim; chmod 755 victim; printf '( ./victim )\n' > source.sh"#,
		mode: Mode::Dashc,
		script: ". ./source.sh",
		status: 126,
		stdout: b"",
		stderr: b"./source.sh: ./victim: /missing/review/interpreter: bad interpreter: No such file or directory\n",
	},
	// src-inside-function (c)  // 5.2.21 differs: 127 './inner.sh: line 1: ./victim: cannot execute: required file not found\n'
	Row {
		id: "src-inside-function",
		setup: r#"printf '#!/missing/review/interpreter\n' > victim; chmod 755 victim; printf './victim\n' > inner.sh"#,
		mode: Mode::Dashc,
		script: "f(){ . ./inner.sh; }; f",
		status: 126,
		stdout: b"",
		stderr: b"./inner.sh: ./victim: /missing/review/interpreter: bad interpreter: No such file or directory\n",
	},
	// src-after-return (c)  // 5.2.21 differs: 127 'bash: line 1: ./victim: cannot execute: required file not found\n'
	Row {
		id: "src-after-return",
		setup: r#"printf '#!/missing/review/interpreter\n' > victim; chmod 755 victim; printf 'true\n' > noop.sh"#,
		mode: Mode::Dashc,
		script: ". ./noop.sh; ./victim",
		status: 126,
		stdout: b"",
		stderr: b"bash: ./victim: /missing/review/interpreter: bad interpreter: No such file or directory\n",
	},
	// src-from-script-file (file)  // 5.2.21 differs: 127 './source.sh: line 1: ./victim: cannot execute: required file not found\n'
	Row {
		id: "src-from-script-file",
		setup: r#"printf '#!/missing/review/interpreter\n' > victim; chmod 755 victim; printf './victim\n' > source.sh"#,
		mode: Mode::ScriptFile,
		script: ". ./source.sh",
		status: 126,
		stdout: b"",
		stderr: b"./source.sh: ./victim: /missing/review/interpreter: bad interpreter: No such file or directory\n",
	},
	// src-dollar0-inside (c)
	Row {
		id: "src-dollar0-inside",
		setup: r#"printf 'echo "[$0]"\n' > source.sh"#,
		mode: Mode::Dashc,
		script: ". ./source.sh",
		status: 0,
		stdout: b"[bash]\n",
		stderr: b"",
	},
	// src-dollar0-inside-file (file)
	Row {
		id: "src-dollar0-inside-file",
		setup: r#"printf 'echo "[$0]"\n' > source.sh"#,
		mode: Mode::ScriptFile,
		script: ". ./source.sh",
		status: 0,
		stdout: b"[script.sh]\n",
		stderr: b"",
	},
	// src-bash-source-inside (c)
	Row {
		id: "src-bash-source-inside",
		setup: r#"printf 'echo "[${BASH_SOURCE[0]}]"\n' > source.sh"#,
		mode: Mode::Dashc,
		script: ". ./source.sh",
		status: 0,
		stdout: b"[./source.sh]\n",
		stderr: b"",
	},
	// src-by-relative-path (c)  // 5.2.21 differs: 127 './lib/named.sh: line 1: ./victim: cannot execute: required file not found\n'
	Row {
		id: "src-by-relative-path",
		setup: r#"printf '#!/missing/review/interpreter\n' > victim; chmod 755 victim; mkdir -p lib; printf './victim\n' > lib/named.sh"#,
		mode: Mode::Dashc,
		script: ". ./lib/named.sh",
		status: 126,
		stdout: b"",
		stderr: b"./lib/named.sh: ./victim: /missing/review/interpreter: bad interpreter: No such file or directory\n",
	},
	// ctl-top-badinterp (c)  // 5.2.21 differs: 127 'bash: line 1: ./victim: cannot execute: required file not found\n'
	Row {
		id: "ctl-top-badinterp",
		setup: r#"printf '#!/missing/review/interpreter\n' > victim; chmod 755 victim"#,
		mode: Mode::Dashc,
		script: "./victim",
		status: 126,
		stdout: b"",
		stderr: b"bash: ./victim: /missing/review/interpreter: bad interpreter: No such file or directory\n",
	},
	// ctl-top-badinterp-script (file)  // 5.2.21 differs: 127 'script.sh: line 1: ./victim: cannot execute: required file not found\n'
	Row {
		id: "ctl-top-badinterp-script",
		setup: r#"printf '#!/missing/review/interpreter\n' > victim; chmod 755 victim"#,
		mode: Mode::ScriptFile,
		script: "./victim",
		status: 126,
		stdout: b"",
		stderr: b"script.sh: ./victim: /missing/review/interpreter: bad interpreter: No such file or directory\n",
	},
	// ctl-func-badinterp (c)  // 5.2.21 differs: 127 'environment: line 1: ./victim: cannot execute: required file not found\n'
	Row {
		id: "ctl-func-badinterp",
		setup: r#"printf '#!/missing/review/interpreter\n' > victim; chmod 755 victim"#,
		mode: Mode::Dashc,
		script: "f(){ ./victim; }; f",
		status: 126,
		stdout: b"",
		stderr: b"bash: ./victim: /missing/review/interpreter: bad interpreter: No such file or directory\n",
	},
	// ctl-eval-badinterp (c)  // 5.2.21 differs: 127 'bash: line 1: ./victim: cannot execute: required file not found\n'
	Row {
		id: "ctl-eval-badinterp",
		setup: r#"printf '#!/missing/review/interpreter\n' > victim; chmod 755 victim"#,
		mode: Mode::Dashc,
		script: "eval './victim'",
		status: 126,
		stdout: b"",
		stderr: b"bash: ./victim: /missing/review/interpreter: bad interpreter: No such file or directory\n",
	},
	// int-sourced-builtin (i)
	Row {
		id: "int-sourced-builtin",
		setup: r#"printf 'cd ./missing\n' > source.sh"#,
		mode: Mode::Interactive,
		script: ". ./source.sh",
		status: 1,
		stdout: b"",
		stderr: b"bash: cd: ./missing: No such file or directory\n",
	},
	// int-sourced-badinterp (i)  // 5.2.21 differs: 127 'bash: ./victim: cannot execute: required file not found\n'
	Row {
		id: "int-sourced-badinterp",
		setup: r#"printf '#!/missing/review/interpreter\n' > victim; chmod 755 victim; printf './victim\n' > source.sh"#,
		mode: Mode::Interactive,
		script: ". ./source.sh",
		status: 126,
		stdout: b"",
		stderr: b"bash: ./victim: /missing/review/interpreter: bad interpreter: No such file or directory\n",
	},
	// int-sourced-syntax-if (i)  // 5.2.21 differs: 2 'bash: ./source.sh: line 2: syntax error: unexpected end of file\n'
	Row {
		id: "int-sourced-syntax-if",
		setup: r#"printf 'if\n' > source.sh"#,
		mode: Mode::Interactive,
		script: ". ./source.sh",
		status: 2,
		stdout: b"",
		stderr: b"bash: ./source.sh: line 2: syntax error: unexpected end of file from `if' command on line 1\n",
	},
	// int-sourced-syntax-late-if (i)  // 5.2.21 differs: 2 'bash: ./source.sh: line 4: syntax error: unexpected end of file\n'
	Row {
		id: "int-sourced-syntax-late-if",
		setup: r#"printf ':\n:\nif\n' > source.sh"#,
		mode: Mode::Interactive,
		script: ". ./source.sh",
		status: 2,
		stdout: b"",
		stderr: b"bash: ./source.sh: line 4: syntax error: unexpected end of file from `if' command on line 3\n",
	},
	// int-top-syntax-if (i)  // 5.2.21 differs: 2 'bash: syntax error: unexpected end of file\n'
	Row {
		id: "int-top-syntax-if",
		setup: "",
		mode: Mode::Interactive,
		script: "if",
		status: 2,
		stdout: b"",
		stderr: b"bash: syntax error: unexpected end of file from `if' command on line 1\n",
	},
	// int-top-builtin (i)
	Row {
		id: "int-top-builtin",
		setup: "",
		mode: Mode::Interactive,
		script: "cd ./missing",
		status: 1,
		stdout: b"",
		stderr: b"bash: cd: ./missing: No such file or directory\n",
	},
	// ctl-dollar0-c (c)
	Row {
		id: "ctl-dollar0-c",
		setup: "",
		mode: Mode::Dashc,
		script: r#"echo "[$0]""#,
		status: 0,
		stdout: b"[bash]\n",
		stderr: b"",
	},
	// ctl-dollar0-script (file)
	Row {
		id: "ctl-dollar0-script",
		setup: "",
		mode: Mode::ScriptFile,
		script: r#"echo "[$0]""#,
		status: 0,
		stdout: b"[script.sh]\n",
		stderr: b"",
	},
	// byt-badinterp-name (c)  // 5.2.21 differs: 127 'bash: line 1: ./victim\\xff: cannot execute: required file not found\n'
	Row {
		id: "byt-badinterp-name",
		setup: r#"printf '#!/missing/review/interpreter\n' > "$(printf 'victim\377')"; chmod 755 "$(printf 'victim\377')""#,
		mode: Mode::Dashc,
		script: r#"./"$(printf 'victim\377')""#,
		status: 126,
		stdout: b"",
		stderr: b"bash: ./victim\xff: /missing/review/interpreter: bad interpreter: No such file or directory\n",
	},
	// byt-permission-name (c)
	Row {
		id: "byt-permission-name",
		setup: r#"printf 'x\n' > "$(printf 'noexec\377')"; chmod 644 "$(printf 'noexec\377')""#,
		mode: Mode::Dashc,
		script: r#"./"$(printf 'noexec\377')""#,
		status: 126,
		stdout: b"",
		stderr: b"bash: line 1: ./noexec\xff: Permission denied\n",
	},
	// byt-not-found-name (c)
	Row {
		id: "byt-not-found-name",
		setup: "",
		mode: Mode::Dashc,
		script: r#"$(printf 'nosuch\377cmd')"#,
		status: 127,
		stdout: b"",
		stderr: b"bash: line 1: $'nosuch\\377cmd': command not found\n",
	},
	// byt-isdir-name (c)
	Row {
		id: "byt-isdir-name",
		setup: r#"mkdir -p "$(printf 'adir\377')""#,
		mode: Mode::Dashc,
		script: r#"./"$(printf 'adir\377')""#,
		status: 126,
		stdout: b"",
		stderr: b"bash: line 1: ./adir\xff: Is a directory\n",
	},
	// byt-binary-name (c)
	Row {
		id: "byt-binary-name",
		setup: r#"printf '\177ELF not really\n' > "$(printf 'bin\377')"; chmod 755 "$(printf 'bin\377')""#,
		mode: Mode::Dashc,
		script: r#"./"$(printf 'bin\377')""#,
		status: 126,
		stdout: b"",
		stderr: b"bash: line 1: ./bin\xff: cannot execute binary file: Exec format error\n",
	},
	// byt-elf-magic-name (c)
	Row {
		id: "byt-elf-magic-name",
		setup: r#"printf '\177ELF not really\n' > "$(printf 'elf\377')"; chmod 755 "$(printf 'elf\377')""#,
		mode: Mode::Dashc,
		script: r#"./"$(printf 'elf\377')""#,
		status: 126,
		stdout: b"",
		stderr: b"bash: line 1: ./elf\xff: cannot execute binary file: Exec format error\n",
	},
	// byt-interp-name (c)  // 5.2.21 differs: 127 'bash: line 1: ./victim: cannot execute: required file not found\n'
	Row {
		id: "byt-interp-name",
		setup: r#"printf '#!/missing/\377interp\n' > victim; chmod 755 victim"#,
		mode: Mode::Dashc,
		script: "./victim",
		status: 126,
		stdout: b"",
		stderr: b"bash: ./victim: /missing/\xffinterp: bad interpreter: No such file or directory\n",
	},
	// byt-source-prefix (c)  // 5.2.21 differs: 127 './src\\xff.sh: line 1: ./victim: cannot execute: required file not found\n'
	Row {
		id: "byt-source-prefix",
		setup: r#"printf '#!/missing/review/interpreter\n' > victim; chmod 755 victim; printf './victim\n' > "$(printf 'src\377.sh')""#,
		mode: Mode::Dashc,
		script: r#". ./"$(printf 'src\377.sh')""#,
		status: 126,
		stdout: b"",
		stderr: b"./src\xff.sh: ./victim: /missing/review/interpreter: bad interpreter: No such file or directory\n",
	},
	// byt-redirect-target (c)
	Row {
		id: "byt-redirect-target",
		setup: "",
		mode: Mode::Dashc,
		script: r#"echo hi > /nonexistentdir/"$(printf 'f\377')""#,
		status: 1,
		stdout: b"",
		stderr: b"bash: line 1: /nonexistentdir/f\xff: No such file or directory\n",
	},
	// byt-noent-name (c)
	Row {
		id: "byt-noent-name",
		setup: "",
		mode: Mode::Dashc,
		script: r#"./"$(printf 'missing\377')""#,
		status: 127,
		stdout: b"",
		stderr: b"bash: line 1: ./missing\xff: No such file or directory\n",
	},
	// byt-script-name (file)  // 5.2.21 differs: 127 'script.sh: line 1: ./victim\\xff: cannot execute: required file not found\n'
	Row {
		id: "byt-script-name",
		setup: r#"printf '#!/missing/review/interpreter\n' > "$(printf 'victim\377')"; chmod 755 "$(printf 'victim\377')""#,
		mode: Mode::ScriptFile,
		script: r#"./"$(printf 'victim\377')""#,
		status: 126,
		stdout: b"",
		stderr: b"script.sh: ./victim\xff: /missing/review/interpreter: bad interpreter: No such file or directory\n",
	},
];

/// Inside a sourced file bash names that file, not the shell: its
/// `BASH_SOURCE[0]`, which a function defined there keeps while it runs, and which
/// an `eval`, a subshell and a nested `.` inherit. Outside one the prefix is `$0`
/// again.
#[tokio::test(flavor = "multi_thread")]
async fn a_diagnostic_inside_a_sourced_file_names_that_file() {
	assert_rows(&["src-", "ctl-"]).await;
}

/// Runtime errors in an interactive shell name the shell without a line.
/// Syntax errors name a sourced file and its line, or the shell without a line
/// when the parser reads the top-level command string.
#[tokio::test(flavor = "multi_thread")]
async fn an_interactive_shell_names_runtime_and_syntax_errors_by_class() {
	assert_rows(&["int-"]).await;
}

/// A file name is bytes, and stderr is a byte stream: a name that is not UTF-8
/// reaches it unchanged. `command not found` is the one message bash quotes
/// (`printable_filename`); every other message writes the name as it is.
#[tokio::test(flavor = "multi_thread")]
async fn a_diagnostic_writes_a_names_bytes_unchanged() {
	assert_rows(&["byt-"]).await;
}
