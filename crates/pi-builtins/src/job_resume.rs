//! What `fg` and `bg` share, after Bash's `fg_bg.def`.

use std::io::Write;

use brush_core::jobs::{Job, JobSpecMatch, JobState};

/// What `fg` and `bg` do before they look at a job, as Bash's `fg_builtin`
/// and `bg_builtin` do: without job control they refuse (`no job control`,
/// status 1); otherwise they take no option (`no_options`), so a first
/// operand that starts with `-`, other than `-` and the `--` that ends
/// options, is an invalid option reported with the usage line (status 2).
/// Returns the operands after any `--`, or the status to return.
pub(crate) fn operands(
	command_name: &str,
	usage: &str,
	job_control: bool,
	args: &[String],
	stderr: &mut impl Write,
) -> std::io::Result<Result<Vec<String>, u8>> {
	if !job_control {
		writeln!(stderr, "{command_name}: no job control")?;
		return Ok(Err(1));
	}
	match args.first().map(String::as_str) {
		Some("--") => Ok(Ok(args[1..].to_vec())),
		Some(first) if first.len() > 1 && first.starts_with('-') => {
			let option: String = first.chars().take(2).collect();
			writeln!(stderr, "{command_name}: {option}: invalid option")?;
			writeln!(stderr, "{command_name}: usage: {usage}")?;
			Ok(Err(2))
		},
		_ => Ok(Ok(args.to_vec())),
	}
}

/// The job an operand names, as Bash's `get_job_spec` reads it: no operand
/// is the current job, and the leading `%` is optional. Reports `no such
/// job` (naming `current` for a missing operand), or `ambiguous job spec`,
/// when it names no one job.
pub(crate) fn resolve<'a>(
	jobs: &'a mut brush_core::jobs::JobManager,
	operand: Option<&str>,
	command_name: &str,
	stderr: &mut impl Write,
) -> std::io::Result<Option<&'a mut Job>> {
	let found = match operand {
		None => jobs.current_job().map(|job| job.id).map_or(JobSpecMatch::NoSuchJob, JobSpecMatch::Job),
		Some(spec) => jobs.job_spec_match(spec),
	};
	let JobSpecMatch::Job(id) = found else {
		writeln!(stderr, "{command_name}: {}: {}", operand.unwrap_or("current"), found.error_message())?;
		return Ok(None);
	};
	Ok(jobs.jobs.iter_mut().find(|job| job.id == id))
}

/// Whether `job` may be resumed, as Bash's `fg_bg` and `start_job` check: a
/// job started without job control is refused, and so is one that ended.
pub(crate) fn check_resumable(
	job: &Job,
	command_name: &str,
	stderr: &mut impl Write,
) -> std::io::Result<bool> {
	if !job.started_with_job_control() {
		writeln!(stderr, "{command_name}: job {} started without job control", job.id)?;
		return Ok(false);
	}
	if job.is_done() {
		writeln!(stderr, "{command_name}: job has terminated")?;
		return Ok(false);
	}
	Ok(true)
}

/// What `bg` prints for a job it resumes (`start_job`): `[N]+ command &`,
/// with `-` for the previous job and no mark for another.
pub(crate) fn background_line(job: &Job) -> String {
	let mark = if job.is_current() {
		"+ "
	} else if job.is_prev() {
		"- "
	} else {
		" "
	};
	format!("[{}]{mark}{} &", job.id, job.command_line)
}

/// Resumes the job `operand` names in the background, as Bash's `fg_bg`
/// does for `bg`: `$!` becomes the job's process group, a job that runs
/// stays as it is (`already in background`, which succeeds), and a stopped
/// one is announced and continued (see [`Job::move_to_background`]), after
/// which the shell chooses the current job again (`start_job` calls
/// `reset_current`). Returns whether it succeeded.
pub(crate) fn resume_in_background<SE: brush_core::ShellExtensions>(
	shell: &mut brush_core::Shell<SE>,
	operand: Option<&str>,
	command_name: &str,
	stdout: &mut impl Write,
	stderr: &mut impl Write,
) -> Result<bool, brush_core::Error> {
	let Some(job) = resolve(shell.jobs_mut(), operand, command_name, stderr)? else {
		return Ok(false);
	};
	if !check_resumable(job, command_name, stderr)? {
		return Ok(false);
	}
	let group = job.process_group_id();
	let continued = if matches!(job.state, JobState::Running) {
		writeln!(stderr, "{command_name}: job {} already in background", job.id)?;
		false
	} else {
		writeln!(stdout, "{}", background_line(job))?;
		job.move_to_background()?;
		true
	};
	if continued {
		shell.jobs_mut().reset_current();
	}
	shell.set_last_background_pid(group);
	Ok(true)
}
