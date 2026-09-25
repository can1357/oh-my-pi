//! The deliberately small git-CLI escape hatch.
//!
//! Three categories are allowed to spawn `git`, per the hybrid policy:
//! - **Credential-bound network transfers** — clone/fetch/push must reuse the
//!   user's ssh config and credential helpers, which are subprocess-based by
//!   design; no library reaches auth parity (and gitoxide has no send-pack).
//! - **Reftable ref access** — no in-process reftable implementation exists.
//! - **Whole-worktree status/untracked walks** — a subprocess contains gitoxide
//!   worker-thread spawn failures under host resource exhaustion.
//!
//! The runner ports the hardened subprocess contract of the TS wrapper:
//! non-interactive env (`GIT_TERMINAL_PROMPT=0`, askpass rejection, `LC_ALL`
//! handling), `--no-optional-locks` for reads, fsmonitor/untracked-cache
//! disabled, ambient `GIT_DIR`-family vars stripped, bounded output capture,
//! and deadline + SIGTERM→SIGKILL termination via tokio.

use std::{path::Path, process::Stdio, time::Duration};

use tokio::io::AsyncReadExt;
use tokio_util::sync::CancellationToken;

use super::GitRepo;
use crate::{
	error::{Error, Result},
	types::{CloneOptions, PushOptions},
};

/// Default deadline for local git plumbing via the fallback runner.
pub const COMMAND_TIMEOUT: Duration = Duration::from_mins(5);
/// Default deadline for network transfers (`clone`/`fetch`/`push`); large-repo
/// transfers legitimately outlive [`COMMAND_TIMEOUT`].
pub const NETWORK_TIMEOUT: Duration = Duration::from_mins(30);
/// Deadline for synchronous plumbing on render paths (reftable HEAD reads):
/// a stalled invocation degrades instead of freezing the UI.
pub const SYNC_TIMEOUT: Duration = Duration::from_secs(5);
/// Maximum captured bytes per stream before truncation.
pub const OUTPUT_LIMIT_BYTES: usize = 8 * 1024 * 1024;

const TERMINATE_GRACE: Duration = Duration::from_secs(5);
const TRUNCATION_MARKER: &str = "\n[git subprocess output truncated at the capture limit]\n";

/// Captured result of a completed git invocation.
#[derive(Debug, Clone)]
pub(crate) struct CliOutput {
	/// Process exit code (`124` designates a deadline kill).
	pub exit_code: i32,
	/// Captured stdout, possibly truncated.
	pub stdout:    String,
	/// Captured stderr, possibly truncated.
	pub stderr:    String,
}

impl CliOutput {
	/// Convert a non-zero exit into [`Error::Cli`].
	pub fn into_checked(self, args: &[String]) -> Result<Self> {
		if self.exit_code == 0 {
			return Ok(self);
		}
		Err(Error::Cli {
			command:   format!("git {}", args.join(" ")),
			exit_code: self.exit_code,
			stdout:    self.stdout,
			stderr:    self.stderr,
		})
	}
}

/// Options for one fallback invocation.
#[derive(Debug, Default)]
pub(crate) struct RunOptions {
	/// Prefix `--no-optional-locks` and pin lock-free config for reads.
	pub read_only: bool,
	/// Deadline; [`COMMAND_TIMEOUT`] when unset.
	pub timeout:   Option<Duration>,
	/// Bytes piped to stdin (commit messages, `update-ref --stdin` scripts).
	pub stdin:     Option<Vec<u8>>,
	/// Cooperative cancellation: the child is terminated when triggered.
	pub cancel:    Option<CancellationToken>,
}

/// Build the hardened argv prefix: short-lived config pins that stop a
/// transient subprocess from mutating fsmonitor/untracked-cache state.
fn hardened_args(args: &[String], read_only: bool) -> Vec<String> {
	let mut out = Vec::with_capacity(args.len() + 5);
	for pin in ["core.fsmonitor=false", "core.untrackedCache=false"] {
		out.push("-c".to_owned());
		out.push(pin.to_owned());
	}
	if read_only && !args.iter().any(|arg| arg == "--no-optional-locks") {
		out.push("--no-optional-locks".to_owned());
	}
	out.extend(args.iter().cloned());
	out
}

/// Environment sink for the two command builders. `std::process::Command` and
/// `tokio::process::Command` share no trait, and duplicating the contract per
/// builder is how the synchronous path silently lost the `LC_ALL` removal that
/// [`is_dubious_ownership`] depends on.
trait EnvSink {
	fn set(&mut self, key: &str, value: &str);
	fn unset(&mut self, key: &str);
}

impl EnvSink for std::process::Command {
	fn set(&mut self, key: &str, value: &str) {
		self.env(key, value);
	}

	fn unset(&mut self, key: &str) {
		self.env_remove(key);
	}
}

impl EnvSink for tokio::process::Command {
	fn set(&mut self, key: &str, value: &str) {
		self.env(key, value);
	}

	fn unset(&mut self, key: &str) {
		self.env_remove(key);
	}
}

/// Apply the non-interactive environment contract to a command builder:
/// prompts rejected, editors disabled, ambient repo-location and pathspec
/// overrides stripped, `LC_MESSAGES=C` for parseable errors while preserving a
/// UTF-8 character locale. `LC_ALL` must go: it outranks `LC_MESSAGES`, so
/// leaving it inherited would hand back localized diagnostics.
///
/// The `*_PATHSPECS` variables are global pathspec modes, so an inherited
/// `GIT_LITERAL_PATHSPECS=1` would make the `:(literal)` magic this crate
/// builds match a filename containing that prefix (i.e. nothing), and
/// `GIT_ICASE_PATHSPECS=1` would match case variants the caller did not ask
/// for. Explicit magic is only explicit once they are gone.
fn apply_env(cmd: &mut impl EnvSink) {
	for stripped in [
		"GIT_DIR",
		"GIT_COMMON_DIR",
		"GIT_WORK_TREE",
		"GIT_INDEX_FILE",
		"GIT_OBJECT_DIRECTORY",
		"GIT_ALTERNATE_OBJECT_DIRECTORIES",
		"GIT_LITERAL_PATHSPECS",
		"GIT_GLOB_PATHSPECS",
		"GIT_NOGLOB_PATHSPECS",
		"GIT_ICASE_PATHSPECS",
	] {
		cmd.unset(stripped);
	}
	if let Some(lc_all) = std::env::var_os("LC_ALL") {
		let lc_all = lc_all.to_string_lossy().into_owned();
		if is_utf8_locale(&lc_all) {
			cmd.set("LC_CTYPE", &lc_all);
		}
	}
	cmd.unset("LC_ALL");
	cmd.set("LC_MESSAGES", "C");
	cmd.set("GIT_OPTIONAL_LOCKS", "0");
	cmd.set("GIT_ASKPASS", "true");
	cmd.set("GIT_EDITOR", "true");
	cmd.set("GIT_TERMINAL_PROMPT", "0");
	cmd.set("SSH_ASKPASS", "false");
}

/// Loose match for a UTF-8 character locale (`en_US.UTF-8`, `C.utf8`, …).
fn is_utf8_locale(value: &str) -> bool {
	let lower = value.to_ascii_lowercase();
	["utf-8", "utf8"].iter().any(|needle| {
		lower
			.split(['.', '_', '-', '@'])
			.any(|part| part == *needle)
			|| lower.ends_with(needle)
			|| lower.contains(&format!(".{needle}"))
	})
}

/// Run `git` asynchronously with bounded capture and a deadline.
/// Non-zero exits are returned in [`CliOutput`], not raised.
pub(crate) async fn run(cwd: &Path, args: &[String], options: &RunOptions) -> Result<CliOutput> {
	let argv = hardened_args(args, options.read_only);
	let mut cmd = tokio::process::Command::new("git");
	cmd.args(&argv)
		.current_dir(cwd)
		.stdin(if options.stdin.is_some() {
			Stdio::piped()
		} else {
			Stdio::null()
		})
		.stdout(Stdio::piped())
		.stderr(Stdio::piped())
		.kill_on_drop(true);
	apply_env(&mut cmd);
	let mut child = cmd.spawn().map_err(|err| spawn_error(cwd, err))?;

	if let Some(stdin) = &options.stdin
		&& let Some(mut pipe) = child.stdin.take()
	{
		use tokio::io::AsyncWriteExt;
		// A child that exits early (e.g. usage error) closes the pipe;
		// that is its answer, not ours to fail on.
		let _ = pipe.write_all(stdin).await;
		let _ = pipe.shutdown().await;
	}

	let stdout = child.stdout.take().expect("stdout piped");
	let stderr = child.stderr.take().expect("stderr piped");
	let stdout_task = tokio::spawn(read_capped(stdout));
	let stderr_task = tokio::spawn(read_capped(stderr));

	let timeout = options.timeout.unwrap_or(COMMAND_TIMEOUT);
	let cancel = options.cancel.clone().unwrap_or_default();
	let exit = tokio::select! {
		status = tokio::time::timeout(timeout, child.wait()) => match status {
			Ok(status) => status.map_err(Error::Io)?,
			Err(_elapsed) => {
				terminate(&mut child).await;
				stdout_task.abort();
				stderr_task.abort();
				return Err(Error::CliTimeout { command: format!("git {}", argv.join(" ")) });
			},
		},
		() = cancel.cancelled() => {
			terminate(&mut child).await;
			stdout_task.abort();
			stderr_task.abort();
			return Err(Error::Canceled);
		},
	};

	let stdout = stdout_task
		.await
		.map_err(|err| Error::backend("git run", err))??;
	let stderr = stderr_task
		.await
		.map_err(|err| Error::backend("git run", err))??;
	Ok(CliOutput { exit_code: exit.code().unwrap_or(-1), stdout, stderr })
}

/// Run `git` asynchronously and map a non-zero exit to [`Error::Cli`].
pub(crate) async fn run_checked(
	cwd: &Path,
	args: &[String],
	options: &RunOptions,
) -> Result<CliOutput> {
	run(cwd, args, options).await?.into_checked(args)
}

/// Whether `err` means the git binary could not be launched at all (missing
/// binary or deleted cwd), as opposed to git running and failing. Callers with
/// an in-process fallback (e.g. porcelain status) branch on this.
pub(crate) fn is_spawn_failure(err: &Error) -> bool {
	matches!(err, Error::Backend { context: "git spawn", .. })
}

/// Whether captured output hit [`OUTPUT_LIMIT_BYTES`] and therefore lost
/// bytes. Callers whose output is a value rather than a diagnostic (path
/// lists) must retry in-process or fail, never return the short result.
pub(crate) fn is_truncated(text: &str) -> bool {
	text.ends_with(TRUNCATION_MARKER)
}

/// Whether git refused the checkout under its `safe.directory` ownership
/// check (`fatal: detected dubious ownership`, exit 128), which happens
/// whenever the process user differs from the checkout owner — a
/// host-mounted repository inside a container is the common case.
///
/// `open::open_options` opens user-chosen checkouts with `Trust::Full` on
/// purpose, so the in-process walk has no such objection: a caller with a
/// gitoxide fallback must take it rather than surface an error the
/// library-backed path would never have produced.
///
/// [`apply_env`] pins `LC_MESSAGES=C` and drops the `LC_ALL` that would
/// outrank it, so the English wording is what git emits. `safe.directory` is
/// matched as well: it is a config key, so it survives translation even if a
/// host manages to localize the diagnostic anyway.
pub(crate) fn is_dubious_ownership(err: &Error) -> bool {
	matches!(
		err,
		Error::Cli { exit_code: 128, stderr, .. }
			if stderr.contains("dubious ownership") || stderr.contains("safe.directory")
	)
}

/// Whether `err` describes a CLI that could not do the work at all while the
/// in-process gitoxide path still can.
pub(crate) fn prefers_in_process(err: &Error) -> bool {
	is_spawn_failure(err) || is_dubious_ownership(err)
}

/// Synchronous bounded runner with a caller-chosen deadline; render paths pass
/// [`SYNC_TIMEOUT`] so a stalled git cannot freeze the UI. Stdout/stderr are
/// drained concurrently with capped retention, so output larger than the OS
/// pipe buffer can never stall the child into a spurious timeout.
pub(crate) fn run_sync(cwd: &Path, args: &[String], timeout: Duration) -> Result<CliOutput> {
	run_sync_capped(cwd, args, timeout, OUTPUT_LIMIT_BYTES)
}

/// [`run_sync`] with an explicit retention cap. The cap is a parameter rather
/// than a constant read inside the reader threads so a test can exercise the
/// truncation contract on one call without lowering the limit for every other
/// invocation in the process.
pub(crate) fn run_sync_capped(
	cwd: &Path,
	args: &[String],
	timeout: Duration,
	limit: usize,
) -> Result<CliOutput> {
	let argv = hardened_args(args, true);
	let mut cmd = std::process::Command::new("git");
	cmd.args(&argv)
		.current_dir(cwd)
		.stdin(Stdio::null())
		.stdout(Stdio::piped())
		.stderr(Stdio::piped());
	apply_env(&mut cmd);
	let mut child = cmd.spawn().map_err(|err| spawn_error(cwd, err))?;
	let stdout = spawn_sync_reader("git-cli-stdout", child.stdout.take(), limit);
	let stderr = spawn_sync_reader("git-cli-stderr", child.stderr.take(), limit);

	let deadline = std::time::Instant::now() + timeout;
	let status = loop {
		match child.try_wait()? {
			Some(status) => break Some(status),
			None if std::time::Instant::now() >= deadline => {
				let _ = child.kill();
				let _ = child.wait();
				break None;
			},
			None => std::thread::sleep(Duration::from_millis(10)),
		}
	};
	// The child has exited (or been killed), so the pipes reach EOF and the
	// readers terminate; join can only block briefly on the final drain.
	let stdout = stdout.map_or_else(String::new, |h| h.join().unwrap_or_default());
	let stderr = stderr.map_or_else(String::new, |h| h.join().unwrap_or_default());
	let Some(status) = status else {
		return Err(Error::CliTimeout { command: format!("git {}", argv.join(" ")) });
	};
	Ok(CliOutput { exit_code: status.code().unwrap_or(-1), stdout, stderr })
}

/// Drain a child stream on a helper thread, mirroring [`read_capped`].
///
/// `None` when the stream is absent or the thread cannot be spawned (e.g.
/// under the same memory pressure that motivates the CLI path); dropping the
/// stream then closes the pipe, so a chatty child fails with EPIPE and
/// surfaces as a non-zero exit instead of a hang.
fn spawn_sync_reader(
	name: &'static str,
	stream: Option<impl std::io::Read + Send + 'static>,
	limit: usize,
) -> Option<std::thread::JoinHandle<String>> {
	let stream = stream?;
	std::thread::Builder::new()
		.name(name.into())
		.spawn(move || read_capped_sync(stream, limit))
		.ok()
}

/// Synchronous mirror of [`read_capped`]: cap retention at `limit` while
/// draining to EOF so the child never blocks.
fn read_capped_sync(mut stream: impl std::io::Read, limit: usize) -> String {
	let mut retained: Vec<u8> = Vec::new();
	let mut buf = [0u8; 8 * 1024];
	let mut truncated = false;
	loop {
		let n = match stream.read(&mut buf) {
			Ok(0) | Err(_) => break,
			Ok(n) => n,
		};
		if truncated {
			continue;
		}
		let remaining = limit - retained.len();
		if n <= remaining {
			retained.extend_from_slice(&buf[..n]);
		} else {
			retained.extend_from_slice(&buf[..remaining]);
			truncated = true;
		}
	}
	let mut text = String::from_utf8_lossy(&retained).into_owned();
	if truncated {
		text.push_str(TRUNCATION_MARKER);
	}
	text
}

fn spawn_error(cwd: &Path, err: std::io::Error) -> Error {
	if err.kind() == std::io::ErrorKind::NotFound {
		// A deleted cwd also surfaces as spawn ENOENT; only blame the binary
		// when the working directory actually exists.
		let message = if cwd.exists() {
			"git is not installed.".to_owned()
		} else {
			format!("working directory does not exist: {}", cwd.display())
		};
		return Error::backend("git spawn", message);
	}
	Error::Io(err)
}

/// Read a stream to completion, capping retention at [`OUTPUT_LIMIT_BYTES`]
/// while continuing to drain so the child never blocks on a full pipe.
async fn read_capped(mut stream: impl tokio::io::AsyncRead + Unpin) -> Result<String> {
	let mut retained: Vec<u8> = Vec::new();
	let mut buf = [0u8; 8 * 1024];
	let mut truncated = false;
	loop {
		let n = stream.read(&mut buf).await.map_err(Error::Io)?;
		if n == 0 {
			break;
		}
		if truncated {
			continue;
		}
		let remaining = OUTPUT_LIMIT_BYTES - retained.len();
		if n <= remaining {
			retained.extend_from_slice(&buf[..n]);
		} else {
			retained.extend_from_slice(&buf[..remaining]);
			truncated = true;
		}
	}
	let mut text = String::from_utf8_lossy(&retained).into_owned();
	if truncated {
		text.push_str(TRUNCATION_MARKER);
	}
	Ok(text)
}

/// SIGTERM, grace period, then SIGKILL.
async fn terminate(child: &mut tokio::process::Child) {
	#[cfg(unix)]
	if let Some(pid) = child.id() {
		// SAFETY: plain kill(2) on a pid we own; no memory is touched.
		unsafe {
			libc::kill(pid as i32, libc::SIGTERM);
		}
		if tokio::time::timeout(TERMINATE_GRACE, child.wait())
			.await
			.is_ok()
		{
			return;
		}
	}
	let _ = child.kill().await;
	let _ = tokio::time::timeout(TERMINATE_GRACE, child.wait()).await;
}

// ═══════════════════════════════════════════════════════════════════════════
// Network operations (public API)
// ═══════════════════════════════════════════════════════════════════════════

impl GitRepo {
	/// Push the current branch (branch-scoped: never follows tags).
	///
	/// `--no-follow-tags` overrides a user's `push.followTags = true`, which
	/// would otherwise ride every reachable annotated tag along with the
	/// branch — rejected refs on remotes the user cannot tag (e.g. PR-head
	/// forks) would fail the call after the branch itself already updated.
	pub async fn push(
		&self,
		options: &PushOptions,
		cancel: Option<CancellationToken>,
	) -> Result<()> {
		let mut args = vec!["push".to_owned(), "--no-follow-tags".to_owned()];
		if options.force_with_lease {
			args.push("--force-with-lease".to_owned());
		}
		if let Some(remote) = &options.remote {
			args.push(remote.clone());
		}
		if let Some(refspec) = &options.refspec {
			args.push(refspec.clone());
		}
		run_checked(self.root(), &args, &RunOptions {
			timeout: Some(NETWORK_TIMEOUT),
			cancel,
			..RunOptions::default()
		})
		.await?;
		Ok(())
	}

	/// Fetch `+source:target` from a remote.
	pub async fn fetch(
		&self,
		remote: &str,
		source: &str,
		target: &str,
		timeout: Option<Duration>,
		cancel: Option<CancellationToken>,
	) -> Result<()> {
		let args = vec!["fetch".to_owned(), remote.to_owned(), format!("+{source}:{target}")];
		run_checked(self.root(), &args, &RunOptions {
			timeout: Some(timeout.unwrap_or(NETWORK_TIMEOUT)),
			cancel,
			..RunOptions::default()
		})
		.await?;
		Ok(())
	}
}

/// Clone `url` in owned staging space and publish only a successful checkout.
///
/// Shallow (`--depth 1 --single-branch`) unless a specific SHA is pinned:
/// a shallow clone only fetches the tip, so checking out a non-tip commit
/// would fail with "reference is not a tree".
pub async fn clone(
	url: &str,
	target_dir: &Path,
	options: &CloneOptions,
	cancel: Option<CancellationToken>,
) -> Result<()> {
	let absolute = std::path::absolute(target_dir)?;
	let destination = absolute.clone();
	let destination_exists =
		tokio::task::spawn_blocking(move || check_clone_destination(&destination, None))
			.await
			.map_err(|err| Error::backend("git clone", err.to_string()))??;
	let parent = absolute
		.parent()
		.map_or_else(|| absolute.clone(), Path::to_owned);
	tokio::fs::create_dir_all(&parent).await?;
	let staging_parent = if destination_exists {
		absolute.clone()
	} else {
		parent.clone()
	};
	let staging = tokio::task::spawn_blocking(move || {
		tempfile::Builder::new()
			.prefix(".pi-clone-")
			.tempdir_in(staging_parent)
			.map(tempfile::TempDir::keep)
	})
	.await
	.map_err(|err| Error::backend("git clone", err.to_string()))??;
	let checkout_dir = staging.join("repo");

	let shallow = options.sha.is_none();
	let mut args = vec!["clone".to_owned()];
	if shallow {
		args.push("--depth".to_owned());
		args.push("1".to_owned());
	}
	if let Some(ref_name) = &options.ref_name {
		args.push("--branch".to_owned());
		args.push(ref_name.clone());
		args.push("--single-branch".to_owned());
	} else if shallow {
		args.push("--single-branch".to_owned());
	}
	args.push(url.to_owned());
	args.push(checkout_dir.to_string_lossy().into_owned());

	let run_options = RunOptions {
		timeout: Some(options.timeout.unwrap_or(NETWORK_TIMEOUT)),
		cancel: cancel.clone(),
		..RunOptions::default()
	};
	let outcome = async {
		run_checked(&parent, &args, &run_options).await?;
		if let Some(sha) = &options.sha {
			let checkout =
				run_checked(&checkout_dir, &["checkout".to_owned(), sha.clone()], &RunOptions {
					cancel,
					..RunOptions::default()
				})
				.await;
			if checkout.is_err() {
				return Err(Error::backend(
					"git clone",
					format!("failed to checkout SHA {sha} in cloned repository {url}"),
				));
			}
		}
		Ok(())
	}
	.await;
	if let Err(err) = outcome {
		let _ = tokio::fs::remove_dir_all(&staging).await;
		return Err(err);
	}
	tokio::task::spawn_blocking(move || publish_clone(&checkout_dir, &absolute))
		.await
		.map_err(|err| Error::backend("git clone", err.to_string()))?
		.map_err(|err| {
			Error::backend(
				"git clone",
				format!("failed to publish checkout: {err}; staging retained at {}", staging.display()),
			)
		})?;
	let _ = tokio::fs::remove_dir_all(&staging).await;
	Ok(())
}

fn check_clone_destination(destination: &Path, staging: Option<&Path>) -> std::io::Result<bool> {
	match std::fs::read_dir(destination) {
		Ok(entries) => {
			for entry in entries {
				if Some(entry?.path().as_path()) != staging {
					return Err(std::io::Error::new(
						std::io::ErrorKind::AlreadyExists,
						format!("destination is not empty: {}", destination.display()),
					));
				}
			}
			Ok(true)
		},
		Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(false),
		Err(err) => Err(err),
	}
}

fn publish_clone(checkout: &Path, destination: &Path) -> std::io::Result<()> {
	let staging = checkout.parent();
	if staging.and_then(Path::parent) != Some(destination) {
		match rename_clone_entry(checkout, destination) {
			Ok(()) => return Ok(()),
			Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => {},
			Err(err) => return Err(err),
		}
	}
	check_clone_destination(destination, staging)?;
	let entries = std::fs::read_dir(checkout)?
		.map(|entry| entry.map(|entry| entry.file_name()))
		.collect::<std::io::Result<Vec<_>>>()?;
	publish_clone_entries(checkout, destination, entries)
}

fn publish_clone_entries(
	checkout: &Path,
	destination: &Path,
	entries: Vec<std::ffi::OsString>,
) -> std::io::Result<()> {
	let mut published = Vec::new();
	for name in entries {
		if let Err(err) = rename_clone_entry(&checkout.join(&name), &destination.join(&name)) {
			for name in published.into_iter().rev() {
				rename_clone_entry(&destination.join(&name), &checkout.join(&name)).map_err(
					|rollback| {
						std::io::Error::other(format!(
							"publication failed: {err}; rollback failed for {}: {rollback}",
							destination.join(&name).display()
						))
					},
				)?;
			}
			return Err(err);
		}
		published.push(name);
	}
	Ok(())
}

#[cfg(any(target_os = "linux", target_os = "android", target_vendor = "apple"))]
fn rename_clone_entry(source: &Path, destination: &Path) -> std::io::Result<()> {
	use rustix::fs::{CWD, RenameFlags, renameat_with};
	renameat_with(CWD, source, CWD, destination, RenameFlags::NOREPLACE).map_err(Into::into)
}

#[cfg(windows)]
fn rename_clone_entry(source: &Path, destination: &Path) -> std::io::Result<()> {
	use std::os::windows::ffi::OsStrExt;

	let source: Vec<_> = source.as_os_str().encode_wide().chain(Some(0)).collect();
	let destination: Vec<_> = destination
		.as_os_str()
		.encode_wide()
		.chain(Some(0))
		.collect();
	if source[..source.len() - 1].contains(&0) || destination[..destination.len() - 1].contains(&0) {
		return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "path contains a NUL"));
	}
	// SAFETY: Both paths are NUL-terminated and remain valid for the duration of
	// the call.
	if unsafe {
		windows_sys::Win32::Storage::FileSystem::MoveFileW(source.as_ptr(), destination.as_ptr())
	} == 0
	{
		Err(std::io::Error::last_os_error())
	} else {
		Ok(())
	}
}

#[cfg(not(any(target_os = "linux", target_os = "android", target_vendor = "apple", windows)))]
fn rename_clone_entry(_source: &Path, _destination: &Path) -> std::io::Result<()> {
	Err(std::io::Error::new(std::io::ErrorKind::Unsupported, "exclusive rename is unavailable"))
}

#[cfg(test)]
mod tests {
	use super::*;

	fn clone_source(root: &Path) -> std::path::PathBuf {
		let source = root.join("source");
		std::fs::create_dir(&source).unwrap();
		std::fs::write(source.join("tracked.txt"), b"clone content").unwrap();
		for args in [vec!["init", "-q", "-b", "main"], vec!["add", "tracked.txt"], vec![
			"-c",
			"user.name=Test",
			"-c",
			"user.email=test@example.com",
			"commit",
			"--allow-empty",
			"-qm",
			"initial",
		]] {
			assert!(
				std::process::Command::new("git")
					.args(args)
					.current_dir(&source)
					.status()
					.unwrap()
					.success()
			);
		}
		source
	}

	#[tokio::test]
	async fn clone_rejects_occupied_destination_before_contacting_remote() {
		let root = tempfile::tempdir().unwrap();
		let target = root.path().join("target");
		std::fs::create_dir(&target).unwrap();
		std::fs::write(target.join("sentinel"), b"keep").unwrap();
		let missing = root.path().join("missing-remote");
		let error = clone(missing.to_str().unwrap(), &target, &CloneOptions::default(), None)
			.await
			.unwrap_err();
		assert!(error.to_string().contains("destination is not empty"), "{error}");
		assert_eq!(std::fs::read(target.join("sentinel")).unwrap(), b"keep");
	}

	#[tokio::test]
	async fn clone_preserves_existing_empty_directory_identity_and_permissions() {
		#[cfg(unix)]
		use std::os::unix::fs::{MetadataExt, PermissionsExt};

		let root = tempfile::tempdir().unwrap();
		let source = clone_source(root.path());
		let target = root.path().join("target");
		std::fs::create_dir(&target).unwrap();
		#[cfg(unix)]
		std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o700)).unwrap();
		#[cfg(unix)]
		let before = std::fs::metadata(&target).unwrap();
		clone(source.to_str().unwrap(), &target, &CloneOptions::default(), None)
			.await
			.unwrap();
		#[cfg(unix)]
		{
			let after = std::fs::metadata(&target).unwrap();
			assert_eq!(after.ino(), before.ino());
			assert_eq!(after.mode() & 0o7777, 0o700);
		}
		assert!(target.join(".git/HEAD").is_file());
		assert_eq!(std::fs::read(target.join("tracked.txt")).unwrap(), b"clone content");
	}

	#[test]
	fn clone_publication_collision_restores_moved_entries_and_preserves_destination() {
		let root = tempfile::tempdir().unwrap();
		let checkout = root.path().join("checkout");
		let target = root.path().join("target");
		std::fs::create_dir(&checkout).unwrap();
		std::fs::create_dir(&target).unwrap();
		std::fs::create_dir(checkout.join(".git")).unwrap();
		std::fs::write(checkout.join(".git/HEAD"), b"staged HEAD").unwrap();
		std::fs::write(checkout.join("tracked.txt"), b"staged content").unwrap();
		std::fs::write(target.join("tracked.txt"), b"concurrent caller content").unwrap();
		let error =
			publish_clone_entries(&checkout, &target, vec![".git".into(), "tracked.txt".into()])
				.unwrap_err();
		assert_eq!(error.kind(), std::io::ErrorKind::AlreadyExists);
		assert_eq!(std::fs::read(target.join("tracked.txt")).unwrap(), b"concurrent caller content");
		assert_eq!(std::fs::read(checkout.join("tracked.txt")).unwrap(), b"staged content");
		assert_eq!(std::fs::read(checkout.join(".git/HEAD")).unwrap(), b"staged HEAD");
		assert!(!target.join(".git").exists());
	}

	#[cfg(target_os = "linux")]
	#[tokio::test]
	async fn clone_supports_existing_destination_on_another_filesystem() {
		use std::os::unix::fs::{MetadataExt, symlink};

		let root = tempfile::tempdir_in("/tmp").unwrap();
		let source = clone_source(root.path());
		let mounted = match tempfile::tempdir_in("/dev/shm") {
			Ok(directory) => directory,
			Err(error)
				if matches!(
					error.kind(),
					std::io::ErrorKind::NotFound | std::io::ErrorKind::PermissionDenied
				) =>
			{
				eprintln!("cross-filesystem clone test requires writable /dev/shm: {error}");
				return;
			},
			Err(error) => panic!("create second-filesystem fixture: {error}"),
		};
		if std::fs::metadata(root.path()).unwrap().dev()
			== std::fs::metadata(mounted.path()).unwrap().dev()
		{
			eprintln!("cross-filesystem clone test requires /tmp and /dev/shm on different devices");
			return;
		}
		let target = root.path().join("target");
		symlink(mounted.path(), &target).unwrap();
		clone(source.to_str().unwrap(), &target, &CloneOptions::default(), None)
			.await
			.unwrap();
		assert!(std::fs::symlink_metadata(&target).unwrap().is_symlink());
		assert_eq!(std::fs::read(mounted.path().join("tracked.txt")).unwrap(), b"clone content");
		assert_eq!(std::fs::read_dir(mounted.path()).unwrap().count(), 2);
	}

	#[cfg(target_os = "linux")]
	#[tokio::test]
	async fn clone_inherits_existing_destination_group_and_default_acl() {
		use std::os::unix::fs::{MetadataExt, PermissionsExt};

		let root = tempfile::tempdir().unwrap();
		let source = clone_source(root.path());
		let target = root.path().join("target");
		let expected = root.path().join("expected");
		// Linux POSIX ACL v2: owner rwx, group rwx, other none.
		let mut acl = 2_u32.to_le_bytes().to_vec();
		for (tag, permissions) in [(1_u16, 7_u16), (4, 7), (32, 0)] {
			acl.extend_from_slice(&tag.to_le_bytes());
			acl.extend_from_slice(&permissions.to_le_bytes());
			acl.extend_from_slice(&u32::MAX.to_le_bytes());
		}
		for directory in [&target, &expected] {
			std::fs::create_dir(directory).unwrap();
			std::fs::set_permissions(directory, std::fs::Permissions::from_mode(0o2770)).unwrap();
			match rustix::fs::setxattr(
				directory,
				"system.posix_acl_default",
				&acl,
				rustix::fs::XattrFlags::empty(),
			) {
				Ok(()) => {},
				Err(rustix::io::Errno::OPNOTSUPP) => {
					eprintln!("clone inheritance test requires POSIX ACL support");
					return;
				},
				Err(error) => panic!("set fixture default ACL: {error}"),
			}
		}
		assert!(
			std::process::Command::new("git")
				.args(["clone", "-q"])
				.arg(&source)
				.arg(&expected)
				.status()
				.unwrap()
				.success()
		);
		clone(source.to_str().unwrap(), &target, &CloneOptions::default(), None)
			.await
			.unwrap();
		for relative in [".git", ".git/objects", "tracked.txt"] {
			let actual = std::fs::metadata(target.join(relative)).unwrap();
			let expected = std::fs::metadata(expected.join(relative)).unwrap();
			assert_eq!(actual.mode() & 0o7777, expected.mode() & 0o7777, "{relative}");
			assert_eq!(actual.gid(), expected.gid(), "{relative}");
		}
		assert_eq!(std::fs::read(target.join("tracked.txt")).unwrap(), b"clone content");
	}

	#[test]
	fn clone_publication_rechecks_destination_after_transfer() {
		for existing in [false, true] {
			let root = tempfile::tempdir().unwrap();
			let target = root.path().join("target");
			if existing {
				std::fs::create_dir(&target).unwrap();
			}
			check_clone_destination(&target, None).unwrap();
			let staging = tempfile::tempdir_in(if existing { &target } else { root.path() }).unwrap();
			let checkout = staging.path().join("repo");
			std::fs::create_dir(&checkout).unwrap();
			std::fs::write(checkout.join("tracked.txt"), b"staged content").unwrap();
			if !existing {
				std::fs::create_dir(&target).unwrap();
			}
			std::fs::write(target.join("sentinel"), b"caller content").unwrap();
			let error = publish_clone(&checkout, &target).unwrap_err();
			assert_eq!(error.kind(), std::io::ErrorKind::AlreadyExists);
			assert_eq!(std::fs::read(target.join("sentinel")).unwrap(), b"caller content");
			assert_eq!(std::fs::read(checkout.join("tracked.txt")).unwrap(), b"staged content");
			assert!(!target.join("tracked.txt").exists());
		}
	}

	#[tokio::test]
	async fn clone_preserves_existing_destination_on_failure() {
		let root = tempfile::tempdir().unwrap();
		let source = clone_source(root.path());
		let target = root.path().join("target");
		std::fs::create_dir(&target).unwrap();
		std::fs::write(target.join("sentinel"), b"owned by caller").unwrap();
		assert!(
			clone(source.to_str().unwrap(), &target, &CloneOptions::default(), None)
				.await
				.is_err()
		);
		assert_eq!(std::fs::read(target.join("sentinel")).unwrap(), b"owned by caller");
		assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 2);
	}

	#[tokio::test]
	async fn clone_missing_remote_preserves_destination_and_removes_staging() {
		let root = tempfile::tempdir().unwrap();
		let target = root.path().join("target");
		std::fs::create_dir(&target).unwrap();
		let missing = root.path().join("missing-remote");
		let error = clone(missing.to_str().unwrap(), &target, &CloneOptions::default(), None)
			.await
			.unwrap_err();
		assert!(matches!(error, Error::Cli { .. }), "{error}");
		assert_eq!(std::fs::read_dir(&target).unwrap().count(), 0);
		assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 1);
	}

	#[tokio::test]
	async fn clone_publishes_only_successful_checkouts() {
		let root = tempfile::tempdir().unwrap();
		let source = clone_source(root.path());
		let target = root.path().join("target");
		let options =
			CloneOptions { sha: Some("invalid-revision".to_owned()), ..CloneOptions::default() };
		assert!(
			clone(source.to_str().unwrap(), &target, &options, None)
				.await
				.is_err()
		);
		assert!(!target.exists());
		assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 1);
		clone(source.to_str().unwrap(), &target, &CloneOptions::default(), None)
			.await
			.unwrap();
		let output = std::process::Command::new("git")
			.args(["rev-parse", "HEAD"])
			.current_dir(&target)
			.output()
			.unwrap();
		assert!(output.status.success());
		let expected = std::process::Command::new("git")
			.args(["rev-parse", "HEAD"])
			.current_dir(&source)
			.output()
			.unwrap();
		assert_eq!(output.stdout, expected.stdout);
		assert_eq!(std::fs::read(target.join("tracked.txt")).unwrap(), b"clone content");
		assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 2);
	}

	#[tokio::test]
	async fn clone_cancelled_before_dispatch_leaves_destination_untouched() {
		let root = tempfile::tempdir().unwrap();
		let source = clone_source(root.path());
		let target = root.path().join("target");
		std::fs::create_dir(&target).unwrap();
		let cancel = CancellationToken::new();
		cancel.cancel();
		let error = clone(source.to_str().unwrap(), &target, &CloneOptions::default(), Some(cancel))
			.await
			.unwrap_err();
		assert!(matches!(error, Error::Canceled), "{error}");
		assert_eq!(std::fs::read_dir(&target).unwrap().count(), 0);
		assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 2);
	}

	/// Set on the re-executed child; carries the fixture repository it should
	/// probe. Its presence is what tells the test body which side it is on.
	const ENV_PROBE_REPO: &str = "PI_VCS_TEST_ENV_PROBE_REPO";

	/// Asks git to report the ambient variables it was started with. A `!`-alias
	/// is the only way to make git print its own environment.
	const ENV_PROBE_ALIAS: &str = r#"!printf 'LC_ALL=[%s] LC_CTYPE=[%s] LC_MESSAGES=[%s] LITERAL=[%s] ICASE=[%s]' "$LC_ALL" "$LC_CTYPE" "$LC_MESSAGES" "$GIT_LITERAL_PATHSPECS" "$GIT_ICASE_PATHSPECS""#;

	/// Two guarantees this crate builds on top of, both of which depend on what
	/// the child process actually receives:
	///
	/// - The ownership fallback reads git's diagnostic, and `LC_ALL` outranks
	///   `LC_MESSAGES`, so an inherited one hands back a translated message that
	///   [`is_dubious_ownership`] cannot match.
	/// - The `:(literal)` magic this crate builds is only explicit once the
	///   global pathspec modes are gone; `GIT_LITERAL_PATHSPECS=1` would turn
	///   the prefix into filename text and match nothing.
	///
	/// Asserted through [`run_sync`] rather than [`apply_env`] directly, because
	/// the regression this covers was the synchronous builder not calling the
	/// helper. The variables have to be present before the process starts, and
	/// `set_var` in a running test binary is observable by every other thread,
	/// so the probe runs in a re-executed copy of this test binary spawned with
	/// them already in its environment.
	#[test]
	fn sync_runner_pins_message_locale_and_scrubs_pathspec_modes() {
		if let Some(repo) = std::env::var_os(ENV_PROBE_REPO) {
			let out = run_sync(
				Path::new(&repo),
				&["-c".to_owned(), format!("alias.envprobe={ENV_PROBE_ALIAS}"), "envprobe".to_owned()],
				SYNC_TIMEOUT,
			)
			.expect("run alias");

			assert_eq!(out.exit_code, 0, "alias failed: {out:?}");
			assert!(out.stdout.contains("LC_ALL=[]"), "LC_ALL leaked: {out:?}");
			assert!(out.stdout.contains("LC_MESSAGES=[C]"), "messages not pinned: {out:?}");
			// The character locale is preserved so paths keep round-tripping as
			// UTF-8; only the message locale is forced.
			assert!(
				out.stdout.contains("LC_CTYPE=[fr_FR.UTF-8]"),
				"UTF-8 character locale dropped: {out:?}"
			);
			assert!(out.stdout.contains("LITERAL=[]"), "literal pathspec mode leaked: {out:?}");
			assert!(out.stdout.contains("ICASE=[]"), "icase pathspec mode leaked: {out:?}");
			return;
		}

		let dir = tempfile::tempdir().expect("tempdir");
		let init = std::process::Command::new("git")
			.args(["init", "-q", "-b", "main"])
			.current_dir(dir.path())
			.status()
			.expect("spawn git init");
		assert!(init.success(), "git init failed");

		let name = format!(
			"{}::sync_runner_pins_message_locale_and_scrubs_pathspec_modes",
			module_path!()
				.split_once("::")
				.expect("crate-qualified module path")
				.1
		);
		let child = std::process::Command::new(std::env::current_exe().expect("test binary"))
			.args(["--exact", &name, "--nocapture", "--test-threads=1"])
			.env(ENV_PROBE_REPO, dir.path())
			.env("LC_ALL", "fr_FR.UTF-8")
			.env("GIT_LITERAL_PATHSPECS", "1")
			.env("GIT_ICASE_PATHSPECS", "1")
			.output()
			.expect("re-exec test binary");
		assert!(
			child.status.success(),
			"environment probe failed:\n{}{}",
			String::from_utf8_lossy(&child.stdout),
			String::from_utf8_lossy(&child.stderr)
		);
	}
}
