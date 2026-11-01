//! Filesystem interaction in the shell.

use std::path::{Path, PathBuf};

use normalize_path::NormalizePath as _;

use crate::{
	ExecutionParameters, ShellFd,
	env::{EnvironmentLookup, EnvironmentScope},
	error, openfiles, pathsearch,
	sys::users,
};

impl<SE: crate::extensions::ShellExtensions> crate::Shell<SE> {
	/// Sets the shell's current working directory to the given path, which
	/// must name a directory in the shell's filesystem. Virtual (`scheme://`)
	/// directories keep their URL spelling.
	///
	/// # Arguments
	///
	/// * `target_dir` - The path to set as the working directory.
	pub async fn set_working_dir(
		&mut self,
		target_dir: impl AsRef<Path>,
	) -> Result<(), error::Error> {
		// The parameters are the shell's own rather than the caller's, since
		// `set_working_dir` is a plain method with thirty-odd callers: that
		// bounds the holds below, which is the defect, but a `cd` inside a
		// cancelled run will not see that run's token.
		let params = self.default_exec_params();

		// Native directories are checked as spelled and then normalized (but
		// not canonicalized, so symlinks are not resolved, preserving logical
		// `cd`), with 8.3 short-name components (e.g. `ADMINI~1`) expanded so
		// the stored working_dir has one spelling. Virtual providers only ever
		// see the lexically normalized path: `..` in a URL is not theirs to
		// resolve.
		//
		// A path has no enforced bound: a virtual provider may accept one of
		// any length, and making a 64 MiB one absolute and normalizing it held
		// the worker 79.6 ms, 286.8 ms under load, in one step. **What is
		// resolved is the target joined to the working directory, not the
		// target**: `cd .` in an accepted 64 MiB virtual directory held it
		// 63–64 ms, 179–277 ms under load, while the gate measured one byte.
		// So the gate is the length of the text resolution reads
		// ([`resolution_len`]), and a resolution longer than a stride runs on
		// a blocking worker, from copies made in strides, unless this is one
		// already.
		let target = target_dir.as_ref();
		let (native, checked_path) = if resolution_len(self.working_dir(), target)
			> crate::interp::DIVIDE_COPY_ABOVE_BYTES
			&& !crate::commands::builtin_on_blocking_worker()
		{
			let target = copy_path_in_strides(&params, target).await?;
			let working_dir = copy_path_in_strides(&params, self.working_dir()).await?;
			let filesystem = self.filesystem.clone();
			match tokio::task::spawn_blocking(move || resolve_directory(&filesystem, &working_dir, &target))
				.await
			{
				Ok(resolved) => resolved,
				Err(join_error) if join_error.is_panic() => {
					std::panic::resume_unwind(join_error.into_panic())
				},
				Err(join_error) => return Err(error::ErrorKind::ThreadingError(join_error).into()),
			}
		} else {
			resolve_directory(&self.filesystem, self.working_dir(), target)
		};

		if !self.filesystem.metadata(&checked_path).await?.is_dir() {
			return Err(error::ErrorKind::NotADirectory(checked_path).into());
		}

		let cleaned_path = if native {
			crate::sys::fs::expand_to_long_path(&checked_path.normalize())
		} else {
			checked_path
		};

		// An accepted 64 MiB working directory also held the worker
		// **105.400 ms** through these two assignments, and 15 ms more in
		// `to_string_lossy`, whose check that the path is UTF-8 is one pass.
		// The check, the copy and the writes are divided.
		let pwd = path_text_in_strides(&params, &cleaned_path).await?;

		self
			.env
			.update_or_add(
				"PWD",
				crate::variables::ShellValueLiteral::Scalar(pwd),
				|_| Ok(()),
				EnvironmentLookup::Anywhere,
				EnvironmentScope::Global,
				&params,
			)
			.await?;
		let oldpwd = std::mem::replace(self.working_dir_mut(), cleaned_path);
		let oldpwd = path_text_in_strides(&params, &oldpwd).await?;

		self
			.env
			.update_or_add(
				"OLDPWD",
				crate::variables::ShellValueLiteral::Scalar(oldpwd),
				|_| Ok(()),
				EnvironmentLookup::Anywhere,
				EnvironmentScope::Global,
				&params,
			)
			.await?;

		Ok(())
	}

	/// Tilde-shortens the given string, replacing the user's home directory with
	/// a tilde.
	///
	/// # Arguments
	///
	/// * `s` - The string to shorten.
	pub fn tilde_shorten(&self, s: String) -> String {
		if let Some(home_dir) = self.home_dir()
			&& let Some(stripped) = s.strip_prefix(home_dir.to_string_lossy().as_ref())
		{
			return format!("~{stripped}");
		}
		s
	}

	/// Returns the shell's current home directory, if available.
	pub(crate) fn home_dir(&self) -> Option<PathBuf> {
		if let Some(home) = self.env.get_str("HOME", self) {
			Some(PathBuf::from(home.to_string()))
		} else {
			// HOME isn't set, so let's sort it out ourselves.
			users::get_current_user_home_dir()
		}
	}

	/// Finds every executable named `filename` in the shell's current PATH, in
	/// PATH order.
	///
	/// # Arguments
	///
	/// * `filename` - The name of the executable to look for.
	pub async fn find_executables_in_path(&self, filename: &str) -> Vec<PathBuf> {
		let path_var = self.env.get_str("PATH", self).unwrap_or_default();
		let paths = crate::sys::fs::split_paths(path_var.as_ref());

		pathsearch::find_executables(&self.filesystem, paths, Path::new(filename)).await
	}

	/// Finds executables in the shell's current default PATH, with filenames
	/// matching the given prefix.
	///
	/// # Arguments
	///
	/// * `filename_prefix` - The prefix to match against executable filenames.
	pub async fn find_executables_in_path_with_prefix(
		&self,
		filename_prefix: &str,
		case_insensitive: bool,
	) -> Vec<PathBuf> {
		let path_var = self.env.get_str("PATH", self).unwrap_or_default();
		let paths = crate::sys::fs::split_paths(path_var.as_ref());

		pathsearch::find_executables_with_prefix(
			&self.filesystem,
			paths,
			filename_prefix,
			case_insensitive,
		)
		.await
	}

	/// Determines whether the given filename is the name of an executable in one
	/// of the directories in the shell's current PATH. If found, returns the
	/// path.
	///
	/// # Arguments
	///
	/// * `candidate_name` - The name of the file to look for.
	pub async fn find_first_executable_in_path<S: AsRef<str>>(
		&self,
		candidate_name: S,
	) -> Option<PathBuf> {
		let path_var = self.env_str("PATH").unwrap_or_default();
		let paths = crate::sys::fs::split_paths(path_var.as_ref());
		pathsearch::find_executable(&self.filesystem, paths, Path::new(candidate_name.as_ref())).await
	}

	/// Uses the shell's hash-based path cache to check whether the given
	/// filename is the name of an executable in one of the directories in the
	/// shell's current PATH. If found, ensures the path is in the cache and
	/// returns it.
	///
	/// # Arguments
	///
	/// * `candidate_name` - The name of the file to look for.
	pub async fn find_first_executable_in_path_using_cache<S: AsRef<str>>(
		&mut self,
		candidate_name: S,
	) -> Option<PathBuf>
	where
		String: From<S>,
	{
		if let Some(cached_path) = self.program_location_cache.get(&candidate_name) {
			Some(cached_path)
		} else if let Some(found_path) = self.find_first_executable_in_path(&candidate_name).await {
			self
				.program_location_cache
				.set(candidate_name, found_path.clone());
			Some(found_path)
		} else {
			None
		}
	}

	/// Gets the absolute form of the given path. Virtual (`scheme://`) paths
	/// are already absolute; relative paths join the working directory, which
	/// may itself be virtual.
	///
	/// # Arguments
	///
	/// * `path` - The path to get the absolute form of.
	pub fn absolute_path(&self, path: impl AsRef<Path>) -> PathBuf {
		absolute_path_in(self.working_dir(), path.as_ref())
	}

	/// Opens the given file through the shell's filesystem, using the context
	/// of this shell and the provided execution parameters.
	///
	/// # Arguments
	///
	/// * `options` - The options to use opening the file.
	/// * `path` - The path to the file to open; may be relative to the shell's
	///   working directory.
	/// * `params` - Execution parameters.
	pub(crate) async fn open_file(
		&self,
		options: &pi_vfs::OpenOptions,
		path: impl AsRef<Path>,
		params: &ExecutionParameters,
	) -> Result<openfiles::OpenFile, std::io::Error> {
		// Give platform-specific code a chance to handle special files
		// (e.g. /dev/null on Windows, which needs to open NUL instead).
		// This is checked before absolute_path so that paths like /dev/null
		// are intercepted on platforms where they aren't valid native paths.
		if let Some(result) = crate::sys::fs::try_open_special_file(path.as_ref())
			&& self.filesystem.is_native_local(path.as_ref())
		{
			return result.map(openfiles::OpenFile::from);
		}

		let path_to_open = self.absolute_path(path.as_ref());

		// A path naming one of this process's descriptors resolves against the
		// shell's descriptors. The process's own table is not the shell's: when
		// the shell is embedded, fd 0 is the host's terminal, and a redirect that
		// opened it would block on the host's keystrokes.
		match openfiles::DescriptorPath::parse(&path_to_open) {
			Some(descriptor @ openfiles::DescriptorPath::Fd(fd_num)) => params
				.try_fd(self, fd_num)
				.ok_or_else(|| descriptor.unavailable_error()),
			// Mirrors `commands::child_session_action`: a command whose stdin is
			// not a terminal runs with no controlling terminal.
			Some(descriptor @ openfiles::DescriptorPath::Terminal)
				if !params
					.try_fd(self, openfiles::OpenFiles::STDIN_FD)
					.is_some_and(|stdin| stdin.is_terminal()) =>
			{
				Err(descriptor.unavailable_error())
			},
			_ => Ok(self.filesystem.open_with(&path_to_open, options).await?.into()),
		}
	}

	/// Replaces the shell's currently configured open files with the given set.
	/// Typically only used by exec-like builtins.
	///
	/// # Arguments
	///
	/// * `open_files` - The new set of open files to use.
	pub fn replace_open_files(
		&mut self,
		open_fds: impl Iterator<Item = (ShellFd, openfiles::OpenFile)>,
	) {
		self.open_files = openfiles::OpenFiles::from(open_fds);
	}

	pub(crate) const fn persistent_open_files(&self) -> &openfiles::OpenFiles {
		&self.open_files
	}
}

/// The absolute form of `path` for a shell whose working directory is
/// `working_dir`. Virtual (`scheme://`) paths are already absolute; relative
/// paths join the working directory, which may itself be virtual.
fn absolute_path_in(working_dir: &Path, path: &Path) -> PathBuf {
	if pi_vfs::is_virtual_path(path) {
		return path.to_owned();
	}
	let normalized_path = crate::sys::fs::normalize_shell_path(path);
	let path = normalized_path.as_ref();
	if path.as_os_str().is_empty() || path.is_absolute() {
		path.to_owned()
	} else {
		pi_vfs::join_path(working_dir, path)
	}
}

/// The path `cd` checks for `target`, and whether it is native: the absolute
/// path, normalized lexically when it is virtual. Each step is one pass over
/// the path.
fn resolve_directory(filesystem: &pi_vfs::Fs, working_dir: &Path, target: &Path) -> (bool, PathBuf) {
	let absolute = absolute_path_in(working_dir, target);
	let native = filesystem.is_native_local(&absolute);
	let checked = if native { absolute } else { pi_vfs::normalize_lexically(&absolute) };
	(native, checked)
}

/// How much text [`resolve_directory`] may read for `target`: the target, and
/// the working directory a relative target is joined to and normalized with.
/// Counted from the lengths alone, which is an upper bound for a target that
/// turns out to be absolute: telling that a long target is absolute or a URL
/// would itself read it.
fn resolution_len(working_dir: &Path, target: &Path) -> usize {
	working_dir.as_os_str().len().saturating_add(target.as_os_str().len())
}

/// A copy of `path` made a stride at a time.
async fn copy_path_in_strides(params: &ExecutionParameters, path: &Path) -> Result<PathBuf, error::Error> {
	let bytes = path.as_os_str().as_encoded_bytes();
	let mut copy = Vec::with_capacity(bytes.len());
	for stride in bytes.chunks(crate::interp::BYTE_CHECKPOINT_STRIDE) {
		crate::interp::stride_checkpoint(params).await?;
		copy.extend_from_slice(stride);
	}
	// SAFETY: `copy` holds exactly the bytes `as_encoded_bytes` gave for a
	// valid `OsStr`, in order.
	Ok(PathBuf::from(unsafe { std::ffi::OsString::from_encoded_bytes_unchecked(copy) }))
}

/// The text of `path`, as `to_string_lossy` gives it, checked and copied a
/// stride at a time. A path that is not UTF-8 is rendered lossily in one step:
/// no shell writes such a path, and a provider that hands one back gets the
/// one-step answer.
async fn path_text_in_strides(params: &ExecutionParameters, path: &Path) -> Result<String, error::Error> {
	let bytes = path.as_os_str().as_encoded_bytes();
	// How much of the path is known to be UTF-8: a stride can end inside a
	// character, which the next stride then completes.
	let mut valid = 0;
	for stride_end in (0..bytes.len()).step_by(crate::interp::BYTE_CHECKPOINT_STRIDE).skip(1).chain([bytes.len()]) {
		crate::interp::stride_checkpoint(params).await?;
		match std::str::from_utf8(&bytes[valid..stride_end]) {
			Ok(_) => valid = stride_end,
			Err(error) if error.error_len().is_none() => valid += error.valid_up_to(),
			Err(_) => return Ok(path.to_string_lossy().into_owned()),
		}
	}
	if valid != bytes.len() {
		return Ok(path.to_string_lossy().into_owned());
	}
	// SAFETY: every byte of `bytes` was just checked to be UTF-8.
	let text = unsafe { std::str::from_utf8_unchecked(bytes) };
	crate::interp::clone_in_strides(params, text).await
}
