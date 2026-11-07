//! Diagnostic segments are pinned to observations in diagnostic-naming-table.
//! All engine observations pass through the same Shell::run consumer as the
//! bash tool.

#![cfg(unix)]

use std::collections::HashMap;

use pi_shell::{Shell, ShellRunOptions, cancel::CancelToken};
use serde::Deserialize;

#[derive(Deserialize)]
struct Table {
	rows: HashMap<String, Row>,
}

#[derive(Deserialize)]
struct Row {
	command: String,
	files:   HashMap<String, String>,
	mode:    String,
	bash:    HashMap<String, Observation>,
}

#[derive(Deserialize)]
struct Observation {
	status:  i32,
	emitted: Bytes,
	#[serde(default)]
	stdout:  Option<Bytes>,
}

#[derive(Deserialize)]
struct Bytes {
	text: String,
}

fn quote(text: &str) -> String {
	format!("'{}'", text.replace('\'', "'\\''"))
}

async fn assert_rows(ids: &[String]) {
	let table: Table =
		serde_json::from_str(include_str!("diagnostic-naming-table/naming-table.json"))
			.expect("recorded Bash table");
	let mut differences = Vec::new();
	for id in ids {
		let row = table.rows.get(id).expect("measured row");
		let directory = tempfile::tempdir().expect("case directory");
		for (name, text) in &row.files {
			std::fs::write(directory.path().join(name), text).expect("case fixture");
		}
		let engine = quote(env!("CARGO_BIN_EXE_obash"));
		let command = if row.mode == "noninteractive" {
			format!("exec > stdout 2> stderr; {}", row.command)
		} else if row.mode == "interactive-read-pty" {
			std::fs::write(directory.path().join("input"), format!("{}\n", row.command))
				.expect("interactive input");
			format!(
				"PS1= PS2= exec -a bash {engine} --noprofile --norc --noediting -i < input > stdout \
				 2> stderr"
			)
		} else {
			format!(
				"exec -a bash {engine} --noprofile --norc --noediting -i -c {} > stdout 2> stderr",
				quote(&row.command)
			)
		};
		let env = HashMap::from([
			("PATH".to_owned(), "/usr/bin:/bin".to_owned()),
			("LC_ALL".to_owned(), "C".to_owned()),
			("HOME".to_owned(), directory.path().display().to_string()),
			("TERM".to_owned(), "dumb".to_owned()),
			("PS1".to_owned(), String::new()),
			("PS2".to_owned(), String::new()),
		]);
		let result = Shell::new(None)
			.run(
				ShellRunOptions {
					command,
					cwd: Some(directory.path().display().to_string()),
					env: Some(env),
					..Default::default()
				},
				None,
				CancelToken::new(Some(10_000)),
			)
			.await
			.expect("consumer run");
		let stdout = std::fs::read(directory.path().join("stdout")).expect("stdout");
		let stderr = std::fs::read(directory.path().join("stderr")).expect("stderr");
		let stderr: Vec<u8> = stderr
			.split_inclusive(|&byte| byte == b'\n')
			.filter(|line| {
				!line.starts_with(b"bash: cannot set terminal process group")
					&& *line != b"bash: no job control in this shell\n"
					&& !(row.mode != "noninteractive" && *line == b"exit\n")
			})
			.flatten()
			.copied()
			.collect();
		let expected = &row.bash["5.3.0"];
		let expected_stdout = expected
			.stdout
			.as_ref()
			.map_or("", |bytes| bytes.text.as_str());
		// A terminal shell's `exit` notice is not a diagnostic segment.
		// The corpus measurement retains it; this diagnostic assertion excludes
		// it on both sides.
		let expected_stderr: Vec<u8> = expected
			.emitted
			.text
			.as_bytes()
			.split_inclusive(|&byte| byte == b'\n')
			.filter(|line| !(row.mode != "noninteractive" && *line == b"exit\n"))
			.flatten()
			.copied()
			.collect();
		if result.exit_code != Some(expected.status)
			|| stdout != expected_stdout.as_bytes()
			|| stderr != expected_stderr
		{
			differences.push(format!(
				"{id}: Bash 5.3.0 status={} stdout={expected_stdout:?} stderr={:?}; Shell::run \
				 status={:?} stdout={:?} stderr={:?}",
				expected.status,
				expected.emitted.text,
				result.exit_code,
				String::from_utf8_lossy(&stdout),
				String::from_utf8_lossy(&stderr),
			));
		}
	}
	assert!(differences.is_empty(), "{}", differences.join("\n"));
}

fn in_all_modes(prefixes: &[&str]) -> Vec<String> {
	prefixes
		.iter()
		.flat_map(|prefix| {
			["noninteractive", "interactive-command-pty", "interactive-read-pty"]
				.map(|mode| format!("{prefix}.{mode}"))
		})
		.collect()
}

#[tokio::test]
async fn return_trap_after_source_return_keeps_the_shell_name() {
	assert_rows(&["round6-return-exact.noninteractive".to_owned()]).await;
}

#[tokio::test]
async fn heredoc_substitution_reports_its_inner_input_not_the_outer_document() {
	assert_rows(&in_all_modes(&[
		"round6-heredoc-exact",
		"heredoc-inner-prefix",
		"heredoc-inner-later-line",
		"source-heredoc-substitution.parser",
		"nested-source-heredoc-substitution.parser",
	]))
	.await;
}

#[tokio::test]
async fn sourced_parser_errors_name_the_source_in_interactive_shells() {
	assert_rows(&in_all_modes(&["source.parser", "nested-source.parser"])).await;
}

#[tokio::test]
async fn heredoc_inner_input_keeps_its_context_across_running_frames() {
	assert_rows(&in_all_modes(&[
		"heredoc-inner-multiline",
		"heredoc-inner-function",
		"heredoc-inner-eval",
		"heredoc-inner-subshell",
		"heredoc-inner-pipeline-left",
		"heredoc-inner-pipeline-right",
		"heredoc-inner-trap-exit",
		"heredoc-inner-trap-err",
		"heredoc-inner-trap-return",
		"heredoc-inner-trap-debug",
	]))
	.await;
}
