//! Hidden same-binary entry that runs a detached process script through the
//! in-process shell interpreter.
//!
//! Detached named processes (`hub start`, background jobs that outlive the
//! session) cannot share the session shell, but ADR 0028 forbids handing their
//! script to `/bin/sh`.  The environment host re-enters `omp` with
//! [`SHELL_CHILD_ARG`] and the script text; this entry builds the same
//! interpreter production sessions use (default, utility, and process
//! builtins) and runs the script in the inherited working directory and
//! environment.

use std::{env, ffi::OsString, io, process::ExitCode};

use omp_shell::{ProfileLoadBehavior, RcLoadBehavior, Shell, SourceInfo};

/// Private argv selector used to re-enter `omp` as a detached shell child.
pub const SHELL_CHILD_ARG: &str = "__omp-shell-child";

/// Shell child startup failure.
#[derive(Debug, thiserror::Error)]
pub enum ShellChildError {
	/// The script argument was missing from `argv`.
	#[error("shell child requires the script text as its second argument")]
	MissingScript,
	/// The interpreter failed to start.
	#[error("shell child interpreter failed to start")]
	Shell(#[source] omp_shell::Error),
	/// The working directory could not be resolved.
	#[error("shell child working directory is unavailable")]
	WorkingDir(#[source] io::Error),
}

/// Runs the hidden shell child entry and returns the script's exit status.
///
/// The script is `argv[2]`; stdio, cwd, and environment are inherited from the
/// launching host, which already applied the sandbox launcher and environment
/// policy to this process.
pub async fn run_shell_child_entry() -> Result<ExitCode, ShellChildError> {
	let script = env::args_os()
		.nth(2)
		.ok_or(ShellChildError::MissingScript)?;
	let cwd = env::current_dir().map_err(ShellChildError::WorkingDir)?;
	// The same interpreter production sessions use: every default, utility,
	// and process builtin; no profile or rc files; inherited environment.
	let mut shell = Shell::builder()
		.profile(ProfileLoadBehavior::Skip)
		.rc(RcLoadBehavior::Skip)
		.working_dir(cwd)
		.builtins(omp_shell::builtins::default_builtins())
		.builtins(
			omp_shell_builtins::utility_builtins()
				.into_iter()
				.map(|(name, registration)| (name.to_owned(), registration)),
		)
		.builtins(
			omp_shell_builtins::process_builtins()
				.into_iter()
				.map(|(name, registration)| (name.to_owned(), registration)),
		)
		.build()
		.await
		.map_err(ShellChildError::Shell)?;
	let params = shell.default_exec_params();
	let result = shell
		.run_string(script.to_string_lossy().into_owned(), &SourceInfo::from("<detached>"), &params)
		.await;
	let _ = shell.on_exit().await;
	let code: u8 = match result {
		Ok(result) => result.exit_code.into(),
		Err(error) => {
			let _ = shell.display_error(&mut io::stderr().lock(), &error);
			error.into_result(&shell).exit_code.into()
		},
	};
	Ok(ExitCode::from(code))
}

/// Argument vector that re-enters the current executable as a shell child.
pub(crate) fn child_args(script: &str) -> [OsString; 2] {
	[OsString::from(SHELL_CHILD_ARG), OsString::from(script)]
}
