use std::{
	collections::BTreeMap,
	fs::{self, File, OpenOptions},
	io::{Read, Write},
	path::{Path, PathBuf},
	process::{Command, Stdio},
	sync::atomic::{AtomicU64, Ordering},
	thread,
	time::Duration,
};

use anyhow::{Context as _, Result, anyhow, bail};

use crate::task::CancelToken;

const COMMAND_OUTPUT_LIMIT: u64 = 1024 * 1024;
const COMMAND_POLL_INTERVAL: Duration = Duration::from_millis(20);
static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(1);

/// Filesystem and process context for one callback registration transaction.
#[derive(Clone)]
pub(super) struct Context {
	pub(super) id:            String,
	pub(super) scheme:        String,
	pub(super) directory:     PathBuf,
	pub(super) callback_path: PathBuf,
	pub(super) helper_path:   PathBuf,
	pub(super) home:          PathBuf,
	pub(super) env:           BTreeMap<String, String>,
	pub(super) cancel:        CancelToken,
	#[cfg(test)]
	pub(super) runner:        Option<Runner>,
}

#[cfg(test)]
pub(super) type Runner =
	std::sync::Arc<dyn Fn(&Path, &[String]) -> anyhow::Result<String> + Send + Sync>;

impl Context {
	/// Construct a transaction context and its fixed callback/helper paths.
	pub(super) fn new(
		home: PathBuf,
		directory: PathBuf,
		scheme: String,
		id: String,
		env: BTreeMap<String, String>,
		cancel: CancelToken,
	) -> Self {
		let callback_path = directory.join("callback.url");
		let helper_name = if cfg!(target_os = "windows") {
			"callback-helper.exe"
		} else {
			"callback-helper"
		};
		let helper_path = directory.join(helper_name);
		Self {
			id,
			scheme,
			directory,
			callback_path,
			helper_path,
			home,
			env,
			cancel,
			#[cfg(test)]
			runner: None,
		}
	}

	/// Check this transaction's cooperative cancellation deadline.
	pub(super) fn check(&self) -> Result<()> {
		self
			.cancel
			.heartbeat()
			.map_err(|error| anyhow!(error.to_string()))
	}

	/// Return a copy using a fresh cancellation/deadline token.
	pub(super) fn with_cancel(&self, cancel: CancelToken) -> Self {
		let mut context = self.clone();
		context.cancel = cancel;
		context
	}

	/// Run one executable directly with bounded output and cooperative tree
	/// cleanup.
	pub(super) fn run(&self, program: &Path, args: &[String]) -> Result<String> {
		self.check()?;
		#[cfg(test)]
		if let Some(runner) = &self.runner {
			return runner(program, args);
		}

		ensure_private_dir(&self.directory)?;
		let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
		let stdout_path = self.directory.join(format!(".command-{sequence}.stdout"));
		let stderr_path = self.directory.join(format!(".command-{sequence}.stderr"));
		let stdout = private_output_file(&stdout_path)?;
		let stderr = private_output_file(&stderr_path)?;
		let mut command = Command::new(program);
		command
			.args(args)
			.current_dir(&self.directory)
			.env_clear()
			.envs(&self.env)
			.stdin(Stdio::null())
			.stdout(Stdio::from(stdout))
			.stderr(Stdio::from(stderr));
		let mut child = match command.spawn() {
			Ok(child) => child,
			Err(error) => {
				remove_command_outputs(&stdout_path, &stderr_path);
				return Err(error).with_context(|| format!("failed to start {}", program.display()));
			},
		};

		let wait_result = (|| -> Result<std::process::ExitStatus> {
			loop {
				self.check()?;
				let stdout_len = file_len(&stdout_path)?;
				let stderr_len = file_len(&stderr_path)?;
				if stdout_len > COMMAND_OUTPUT_LIMIT || stderr_len > COMMAND_OUTPUT_LIMIT {
					bail!("{} exceeded the native command output limit", program.display());
				}
				if let Some(status) = child
					.try_wait()
					.context("failed to wait for native command")?
				{
					return Ok(status);
				}
				thread::sleep(COMMAND_POLL_INTERVAL);
			}
		})();
		let status = match wait_result {
			Ok(status) => status,
			Err(error) => {
				terminate_child_tree(&mut child);
				let _ = child.wait();
				remove_command_outputs(&stdout_path, &stderr_path);
				return Err(error);
			},
		};

		let outputs = read_bounded(&stdout_path)
			.and_then(|stdout| read_bounded(&stderr_path).map(|stderr| (stdout, stderr)));
		remove_command_outputs(&stdout_path, &stderr_path);
		let (stdout, stderr) = outputs?;
		self.check()?;
		if !status.success() {
			let detail = String::from_utf8_lossy(&stderr);
			bail!(
				"{} exited with {}{}",
				program.display(),
				status,
				if detail.trim().is_empty() {
					String::new()
				} else {
					format!(": {}", detail.trim())
				}
			);
		}
		String::from_utf8(stdout)
			.context("native command stdout was not UTF-8")
			.map(|output| output.trim().to_owned())
	}
}

fn private_output_file(path: &Path) -> Result<File> {
	let mut options = OpenOptions::new();
	options.write(true).create_new(true);
	#[cfg(unix)]
	{
		use std::os::unix::fs::OpenOptionsExt;
		options.mode(0o600);
	}
	options
		.open(path)
		.with_context(|| format!("failed to create {}", path.display()))
}

fn file_len(path: &Path) -> Result<u64> {
	Ok(fs::metadata(path)
		.with_context(|| format!("failed to inspect {}", path.display()))?
		.len())
}

fn read_bounded(path: &Path) -> Result<Vec<u8>> {
	let file = File::open(path).with_context(|| format!("failed to open {}", path.display()))?;
	let mut bytes = Vec::new();
	file
		.take(COMMAND_OUTPUT_LIMIT + 1)
		.read_to_end(&mut bytes)
		.with_context(|| format!("failed to read {}", path.display()))?;
	if bytes.len() as u64 > COMMAND_OUTPUT_LIMIT {
		bail!("native command output exceeded limit");
	}
	Ok(bytes)
}

fn terminate_child_tree(child: &mut std::process::Child) {
	if let Ok(pid) = i32::try_from(child.id())
		&& let Some(process) = pi_shell::process::Process::from_pid(pid)
	{
		let _ = process.kill_tree(None);
	}
	let _ = child.kill();
}

fn remove_command_outputs(stdout: &Path, stderr: &Path) {
	let _ = fs::remove_file(stdout);
	let _ = fs::remove_file(stderr);
}

/// Create a directory and constrain it to the current user.
pub(super) fn ensure_private_dir(path: &Path) -> Result<()> {
	fs::create_dir_all(path).with_context(|| format!("failed to create {}", path.display()))?;
	#[cfg(unix)]
	{
		use std::os::unix::fs::PermissionsExt;
		fs::set_permissions(path, fs::Permissions::from_mode(0o700))
			.with_context(|| format!("failed to protect {}", path.display()))?;
	}
	Ok(())
}

/// Atomically replace a file from a same-directory temporary and durably flush
/// it.
pub(super) fn atomic_write(path: &Path, bytes: &[u8], mode: u32) -> Result<()> {
	let parent = path
		.parent()
		.ok_or_else(|| anyhow!("{} has no parent", path.display()))?;
	fs::create_dir_all(parent).with_context(|| format!("failed to create {}", parent.display()))?;
	let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
	let temp = parent.join(format!(".oauth-write-{}-{sequence}", std::process::id()));
	let mut options = OpenOptions::new();
	options.write(true).create_new(true);
	#[cfg(unix)]
	{
		use std::os::unix::fs::OpenOptionsExt;
		options.mode(mode);
	}
	// Windows has no per-file mode bits; the file inherits its parent's ACL.
	#[cfg(not(unix))]
	let _ = mode;
	let write_result = (|| -> Result<()> {
		let mut file = options
			.open(&temp)
			.with_context(|| format!("failed to create {}", temp.display()))?;
		file
			.write_all(bytes)
			.with_context(|| format!("failed to write {}", temp.display()))?;
		file
			.sync_all()
			.with_context(|| format!("failed to flush {}", temp.display()))?;
		#[cfg(unix)]
		{
			use std::os::unix::fs::PermissionsExt;
			file
				.set_permissions(fs::Permissions::from_mode(mode))
				.with_context(|| format!("failed to protect {}", temp.display()))?;
		}
		drop(file);
		fs::rename(&temp, path).with_context(|| format!("failed to publish {}", path.display()))?;
		#[cfg(unix)]
		File::open(parent)
			.and_then(|directory| directory.sync_all())
			.with_context(|| format!("failed to flush {}", parent.display()))?;
		Ok(())
	})();
	if write_result.is_err() {
		let _ = fs::remove_file(&temp);
	}
	write_result
}
