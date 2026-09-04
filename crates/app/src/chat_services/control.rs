//! `/dump` and `/restart` behind the chat host.
//!
//! `/dump` writes an LLM-request sidecar: the projected provider thread
//! of the live journal (post-compaction items, tool results included) as
//! JSON in the temp directory. `/restart` records the intent; once the
//! host hands the terminal back, [`exec_restart`] replaces the process
//! image with the launch argv, session-source flags stripped and this
//! session resumed.

use std::{
	ffi::OsString,
	fs, io,
	path::{Path, PathBuf},
	sync::atomic::{AtomicBool, Ordering},
};

use omp_chat::overlays::services::{ServiceError, ServiceResult};

use super::ServiceState;

/// Set by `/restart`; read by the chat launcher after the host exits.
static RESTART_REQUESTED: AtomicBool = AtomicBool::new(false);

/// Writes the projected request to `<tmp>/omp-request-<stem>.json`.
pub(super) fn dump_request(state: &ServiceState, dom: &omp_dom::Dom) -> ServiceResult<PathBuf> {
	let journal = state.live_journal.read().clone();
	let items = omp_session::project_thread(dom);
	let stem = journal
		.file_stem()
		.and_then(|stem| stem.to_str())
		.unwrap_or("session");
	let path = std::env::temp_dir().join(format!("omp-request-{stem}.json"));
	let document = serde_json::json!({
		"session": journal.display().to_string(),
		"model": state.model.as_str(),
		"messages": items,
	});
	let bytes = serde_json::to_vec_pretty(&document).map_err(ServiceError::failed)?;
	fs::write(&path, bytes).map_err(ServiceError::failed)?;
	Ok(path)
}

/// `/restart`: the launcher re-execs after the host returns.
pub(super) fn request_restart() {
	RESTART_REQUESTED.store(true, Ordering::Release);
}

/// Whether `/restart` was requested during this host run; clears the flag.
pub(crate) fn take_restart_request() -> bool {
	RESTART_REQUESTED.swap(false, Ordering::AcqRel)
}

/// Flags that name where the session comes from; `restartArgv` strips them
/// (and their values) so the relaunch can name this session instead.
const SESSION_SOURCE_FLAGS_WITH_VALUE: &[&str] = &["--resume", "-r", "--session", "--fork"];
const SESSION_SOURCE_FLAGS: &[&str] =
	&["--continue", "-c", "--no-session", "--from-claude", "--from-codex"];

/// The launch argv minus session-source flags and the
/// positional prompt messages and `@file` arguments clap parsed (`prompts`,
/// removed once each from the end), plus `--resume <path>` when the journal
/// exists.
pub(crate) fn restart_argv(
	argv: &[OsString],
	prompts: &[&str],
	journal: Option<&Path>,
) -> Vec<OsString> {
	let mut keep = vec![true; argv.len()];
	for prompt in prompts {
		if let Some(at) = argv
			.iter()
			.enumerate()
			.rev()
			.find(|(index, arg)| keep[*index] && arg.to_string_lossy() == *prompt)
			.map(|(index, _)| index)
		{
			keep[at] = false;
		}
	}
	let mut out = Vec::with_capacity(argv.len() + 2);
	let mut skip_value = false;
	for (index, arg) in argv.iter().enumerate() {
		if skip_value {
			skip_value = false;
			continue;
		}
		if !keep[index] {
			continue;
		}
		let text = arg.to_string_lossy();
		if text == "--" {
			continue;
		}
		if SESSION_SOURCE_FLAGS.contains(&text.as_ref()) {
			continue;
		}
		if SESSION_SOURCE_FLAGS_WITH_VALUE.contains(&text.as_ref()) {
			skip_value = true;
			continue;
		}
		if SESSION_SOURCE_FLAGS_WITH_VALUE
			.iter()
			.any(|flag| text.starts_with(&format!("{flag}=")))
		{
			continue;
		}
		out.push(arg.clone());
	}
	if let Some(journal) = journal.filter(|journal| journal.exists()) {
		out.push(OsString::from("--resume"));
		out.push(journal.as_os_str().to_owned());
	}
	out
}

/// Replaces the process with the relaunch command (never returns on
/// success). On platforms without `exec`, spawns it and exits with its
/// status.
pub(crate) fn exec_restart(prompts: &[&str], journal: Option<&Path>) -> io::Error {
	let mut argv = std::env::args_os();
	let Some(program) = argv.next() else {
		return io::Error::new(io::ErrorKind::NotFound, "argv[0] is missing");
	};
	let rest = argv.collect::<Vec<_>>();
	let args = restart_argv(&rest, prompts, journal);
	let exe = std::env::current_exe().unwrap_or(PathBuf::from(program));
	let mut command = std::process::Command::new(exe);
	command.args(&args);
	#[cfg(unix)]
	{
		use std::os::unix::process::CommandExt as _;
		command.exec()
	}
	#[cfg(not(unix))]
	{
		match command.status() {
			Ok(status) => std::process::exit(status.code().unwrap_or(0)),
			Err(error) => error,
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn args(words: &[&str]) -> Vec<OsString> {
		words.iter().map(OsString::from).collect()
	}

	#[test]
	fn restart_argv_strips_session_sources_and_prompts_then_resumes() {
		let temp = tempfile::tempdir().expect("tempdir");
		let journal = temp.path().join("s.oms");
		fs::write(&journal, "").unwrap();
		let argv =
			args(&["chat", "--model", "m", "-c", "--resume", "abc", "--fork=x", "--", "hello", "m"]);
		let out = restart_argv(&argv, &["hello", "m"], Some(&journal));
		assert_eq!(out, args(&["chat", "--model", "m", "--resume", journal.to_str().unwrap()]));
	}

	#[test]
	fn restart_argv_skips_resume_for_a_journal_that_never_materialized() {
		let out =
			restart_argv(&args(&["chat", "--no-session"]), &[], Some(Path::new("/nonexistent/x.oms")));
		assert_eq!(out, args(&["chat"]));
	}
}
