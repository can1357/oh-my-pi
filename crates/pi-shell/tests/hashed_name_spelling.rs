//! Recorded against Bash 5.2.21 and 5.3.0, which agree on every row here.
//! Hash lookups show executable-relative spelling; table listings keep stored
//! bytes. Fresh descriptive `command -V` results are absolute, unlike ordinary
//! `type` and terse filename queries.

#![cfg(unix)]

use std::{collections::HashMap, io, path::Path, process::Command, sync::Arc};

use async_trait::async_trait;
use pi_shell::{Shell, ShellRunOptions, cancel::CancelToken};
use pi_vfs::{File, FileSystem, Fs, Metadata, OpenOptions, ReadDir};

const SETUP: &str = "mkdir bin; printf '#!/missing/review/interpreter\\n' > bin/x; chmod 755 bin/x";

struct Row {
	id:          String,
	setup:       String,
	script:      String,
	stdout:      String,
	stderr:      &'static str,
	status:      i32,
	record_only: bool,
}

fn rows() -> Vec<Row> {
	let mut rows = Vec::new();
	// The stored and looked-up names below are literal reference observations,
	// not computed with the engine's spelling predicate.
	for (id, extra, stored, shown, before_query) in [
		("executable", "", "bin/x", "./bin/x", ""),
		("nonexec", "; chmod 644 bin/x", "bin/x", "bin/x", ""),
		("missing", "", "bin/missing", "bin/missing", ""),
		("already-dot", "", "./bin/x", "./bin/x", ""),
		("absolute", "", "{D}/bin/x", "{D}/bin/x", ""),
		("directory", "", "bin/x", "bin/x", "/bin/rm bin/x; /bin/mkdir bin/x; "),
		("symlink", "; ln -s x bin/link", "bin/link", "./bin/link", ""),
		("dangling", "; ln -s missing bin/link", "bin/link", "bin/link", ""),
		("repeated-slash", "", "bin//x", "./bin//x", ""),
	] {
		for (flags, args, stdout) in [
			("-l", "", format!("builtin hash -p {stored} q\n")),
			("-t", " q", format!("{shown}\n")),
			("-lt", " q", format!("builtin hash -p {shown} q\n")),
		] {
			rows.push(Row {
				id: format!("hash-{id}-{}", &flags[1..]),
				setup: format!("{SETUP}{extra}"),
				script: format!("hash -p '{stored}' q; {before_query}hash {flags}{args}"),
				stdout,
				stderr: "",
				status: 0,
				record_only: false,
			});
		}
	}
	for (id, extra, script, stdout, stderr, status) in [
		(
			"multiple",
			"",
			"hash -p bin/x a; hash -p bin/x b; hash -l -t a b a; hash -l",
			"builtin hash -p ./bin/x a\nbuiltin hash -p ./bin/x b\nbuiltin hash -p ./bin/x \
			 a\nbuiltin hash -p bin/x b\nbuiltin hash -p bin/x a\n",
			"",
			0,
		),
		(
			"type",
			"",
			"hash -p bin/x q; type q; type -p q; type -P q; command -v q; command -V q",
			"q is hashed (./bin/x)\n./bin/x\n./bin/x\n./bin/x\nq is hashed (./bin/x)\n",
			"",
			0,
		),
		(
			"stored",
			"",
			"hash -p bin/x q; hash; hash -l; printf '%s\\n' \"${BASH_CMDS[q]}\"",
			"hits\tcommand\n   0\tbin/x\nbuiltin hash -p bin/x q\nbin/x\n",
			"",
			0,
		),
		(
			"lt-quoted",
			"; cp bin/x 'bin/a b'",
			"hash -p 'bin/a b' 'q r'; hash -lt 'q r'; hash -l",
			"builtin hash -p ./bin/a b q r\nbuiltin hash -p 'bin/a b' 'q r'\n",
			"",
			0,
		),
		(
			"permission-changes",
			"",
			"hash -p bin/x q; hash -lt q; /bin/chmod 644 bin/x; hash -lt q; /bin/chmod 755 bin/x; \
			 hash -lt q",
			"builtin hash -p ./bin/x q\nbuiltin hash -p bin/x q\nbuiltin hash -p ./bin/x q\n",
			"",
			0,
		),
		(
			"lt-missing-name",
			"",
			"hash -p bin/x q; hash -lt q absent q",
			"builtin hash -p ./bin/x q\nbuiltin hash -p ./bin/x q\n",
			"bash: line 1: hash: absent: not found\n",
			1,
		),
		(
			"t-multiple",
			"",
			"hash -p bin/x a; hash -p bin/x b; hash -t a b a",
			"a\t./bin/x\nb\t./bin/x\na\t./bin/x\n",
			"",
			0,
		),
		(
			"distinct-probes",
			"; cp bin/x bin/y",
			"hash -p bin/x a; hash -p bin/y b; hash -lt a b a",
			"builtin hash -p ./bin/x a\nbuiltin hash -p ./bin/y b\nbuiltin hash -p ./bin/x a\n",
			"",
			0,
		),
		(
			"declare-known-difference",
			"",
			"hash -p bin/x q; hash; hash -l; printf '%s\\n' \"${BASH_CMDS[q]}\"; declare -p BASH_CMDS",
			"hits\tcommand\n   0\tbin/x\nbuiltin hash -p bin/x q\nbin/x\ndeclare -A \
			 BASH_CMDS=([q]=\"bin/x\" )\n",
			"",
			0,
		),
	] {
		rows.push(Row {
			id: format!("hash-{id}"),
			setup: format!("{SETUP}{extra}"),
			script: script.into(),
			stdout: stdout.into(),
			stderr,
			status,
			// Named declaration's dynamic-variable existence is a recorded,
			// out-of-scope difference, not a filename-spelling assertion.
			record_only: id == "declare-known-difference",
		});
	}
	rows.extend(fresh_filename_rows());
	rows
}

/// Fresh descriptive `command -V` results are absolute; ordinary `type` and
/// terse filename queries retain the joined spelling. Slashed operands and
/// cached results must not acquire that fresh-result conversion.
fn fresh_filename_rows() -> Vec<Row> {
	let mut rows = Vec::new();
	for (id, path, joined, descriptive) in [
		("relative", "bin", "bin/x", "{D}/bin/x"),
		("dot", "./bin", "./bin/x", "{D}/bin/x"),
		("parent", "bin/../bin", "bin/../bin/x", "{D}/bin/../bin/x"),
		("symlink", "link", "link/x", "{D}/link/x"),
		("absolute", "{D}/bin", "{D}/bin/x", "{D}/bin/x"),
		("empty", "", "./x", "{D}/x"),
		("cwd-dot", ".", "./x", "{D}/x"),
		("double-dot", "././bin", "././bin/x", "{D}/./bin/x"),
		("repeated-slash", "bin//", "bin//x", "{D}/bin//x"),
		("absolute-dot", "{D}/./bin", "{D}/./bin/x", "{D}/./bin/x"),
	] {
		for (format, stdout) in [
			("type", format!("x is {joined}\n")),
			("type -a", format!("x is {joined}\n")),
			("type -f", format!("x is {joined}\n")),
			("type -p", format!("{joined}\n")),
			("type -P", format!("{joined}\n")),
			("type -ap", format!("{joined}\n")),
			("type -aP", format!("{joined}\n")),
			("type -t", "file\n".into()),
			("command -v", format!("{joined}\n")),
			("command -V", format!("x is {descriptive}\n")),
			("command -vV", format!("x is {descriptive}\n")),
		] {
			rows.push(Row {
				id:          format!("fresh-{id}-{format}"),
				setup:       format!("{SETUP}; cp bin/x x; ln -s bin link"),
				script:      format!("PATH={path}:/bin; {format} x; hash"),
				stdout:      format!("{stdout}hash: hash table empty\n"),
				stderr:      "",
				status:      0,
				record_only: false,
			});
		}
	}
	for word in ["bin/x", "./bin/x", "././bin/x", "bin/../bin/x", "link/x", "{D}/./bin/x"] {
		for (format, stdout) in [
			("type", format!("{word} is {word}\n")),
			("type -p", format!("{word}\n")),
			("command -v", format!("{word}\n")),
			("command -V", format!("{word} is {word}\n")),
		] {
			rows.push(Row {
				id: format!("slash-{word}-{format}"),
				setup: format!("{SETUP}; ln -s bin link"),
				script: format!("{format} {word}"),
				stdout,
				stderr: "",
				status: 0,
				record_only: false,
			});
		}
	}
	for (id, extra, stored, shown) in [
		("dot", "", "./bin/x", "./bin/x"),
		("parent", "", "bin/../bin/x", "./bin/../bin/x"),
		("symlink", "; ln -s bin link", "link/x", "./link/x"),
		("absolute-dot", "", "{D}/./bin/x", "{D}/./bin/x"),
		("nonexec", "; chmod 644 bin/x", "bin/x", "bin/x"),
		("missing", "", "bin/missing", "bin/missing"),
	] {
		for (format, stdout) in [
			("type", format!("q is hashed ({shown})\n")),
			("type -p", format!("{shown}\n")),
			("type -P", format!("{shown}\n")),
			("command -v", format!("{shown}\n")),
			("command -V", format!("q is hashed ({shown})\n")),
		] {
			rows.push(Row {
				id: format!("cached-{id}-{format}"),
				setup: format!("{SETUP}{extra}"),
				script: format!("hash -p {stored} q; {format} q"),
				stdout,
				stderr: "",
				status: 0,
				record_only: false,
			});
		}
	}
	rows.push(Row {
		id:          "fresh-multi-V".into(),
		setup:       format!("{SETUP}; cp bin/x bin/y"),
		script:      "PATH=bin:/bin; command -V x y x; hash".into(),
		stdout:      "x is {D}/bin/x\ny is {D}/bin/y\nx is {D}/bin/x\nhash: hash table empty\n"
			.into(),
		stderr:      "",
		status:      0,
		record_only: false,
	});
	rows
}

/// Real local files, but metadata and executable-access answers suspend. A
/// builtin that prints before settling all names would repeat its earlier
/// output.
#[derive(Debug)]
struct YieldingFilesystem;

#[async_trait]
impl FileSystem for YieldingFilesystem {
	async fn open(&self, path: &Path, options: &OpenOptions) -> io::Result<File> {
		Fs::native().open_with(path, options).await
	}

	async fn metadata(&self, path: &Path) -> io::Result<Metadata> {
		tokio::task::yield_now().await;
		Fs::native().metadata(path).await
	}

	async fn access(&self, path: &Path, read: bool, write: bool, execute: bool) -> io::Result<()> {
		tokio::task::yield_now().await;
		Fs::native().access(path, read, write, execute).await
	}

	async fn read_dir(&self, path: &Path) -> io::Result<ReadDir> {
		Fs::native().read_dir(path).await
	}
}

async fn assert_rows(yielding: bool) {
	let mut differing = Vec::new();
	let rows = rows();
	for row in &rows {
		let dir = tempfile::Builder::new()
			.prefix("hashed-name-")
			.tempdir()
			.expect("case directory");
		let home = dir.path().display().to_string();
		let env: HashMap<String, String> = [
			("PATH", "/usr/bin:/bin"),
			("LC_ALL", "C.UTF-8"),
			("TERM", "dumb"),
			("HOME", home.as_str()),
		]
		.into_iter()
		.map(|(key, value)| (key.to_owned(), value.to_owned()))
		.collect();
		assert!(
			Command::new("/bin/sh")
				.args(["-c", &row.setup])
				.current_dir(dir.path())
				.env_clear()
				.envs(&env)
				.status()
				.expect("fixture setup")
				.success(),
			"{}: setup failed",
			row.id,
		);
		let stdout = dir.path().join("stdout.bin");
		let stderr = dir.path().join("stderr.bin");
		let script = row.script.replace("{D}", &home);
		let result = Shell::new(None)
			.run(
				ShellRunOptions {
					command: format!("exec >'{}' 2>'{}'; {script}", stdout.display(), stderr.display()),
					cwd: Some(home.clone()),
					env: Some(env),
					filesystem: yielding.then(|| Fs::new(Arc::new(YieldingFilesystem))),
					..Default::default()
				},
				None,
				CancelToken::new(Some(30_000)),
			)
			.await
			.expect("Shell::run consumer");
		let out = std::fs::read(stdout).expect("captured stdout");
		let err = std::fs::read(stderr).expect("captured stderr");
		let want = row.stdout.replace("{D}", &home);
		println!(
			"{}: status={:?} stdout={:?} stderr={:?}",
			row.id,
			result.exit_code,
			String::from_utf8_lossy(&out).replace(&home, "{D}"),
			String::from_utf8_lossy(&err),
		);
		if row.record_only {
			println!(
				"{}: recorded only; Bash 5.2.21 and 5.3.0 expect status={} stdout={want:?} \
				 stderr={:?}; named dynamic-variable declaration is outside spelling coverage",
				row.id, row.status, row.stderr,
			);
			continue;
		}
		if result.exit_code != Some(row.status)
			|| out != want.as_bytes()
			|| err != row.stderr.as_bytes()
		{
			differing.push(format!(
				"{}: expected status={} stdout={want:?} stderr={:?}; got status={:?} stdout={:?} \
				 stderr={:?}",
				row.id,
				row.status,
				row.stderr,
				result.exit_code,
				String::from_utf8_lossy(&out),
				String::from_utf8_lossy(&err),
			));
		}
	}
	let asserted = rows.iter().filter(|row| !row.record_only).count();
	println!(
		"{} of {asserted} asserted rows differ (yielding={yielding}); {} recorded-only row",
		differing.len(),
		rows.len() - asserted
	);
	assert!(differing.is_empty(), "{}", differing.join("\n"));
}

#[tokio::test]
async fn hash_lookup_spelling_is_distinct_from_stored_spelling() {
	assert_rows(false).await;
}

#[tokio::test]
async fn hash_lookup_probes_settle_before_any_output() {
	assert_rows(true).await;
}
