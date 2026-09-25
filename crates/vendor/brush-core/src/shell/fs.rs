//! Filesystem interaction in the shell.

use std::path::{Path, PathBuf};

use normalize_path::NormalizePath as _;

use crate::{
	ExecutionParameters, ShellFd,
	env::{EnvironmentLookup, EnvironmentScope},
	error, openfiles, pathsearch,
	sys::users,
	variables,
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
		let abs_path = self.absolute_path(target_dir.as_ref());

		// Native directories are checked as spelled and then normalized (but
		// not canonicalized, so symlinks are not resolved, preserving logical
		// `cd`), with 8.3 short-name components (e.g. `ADMINI~1`) expanded so
		// the stored working_dir has one spelling. Virtual providers only ever
		// see the lexically normalized path: `..` in a URL is not theirs to
		// resolve.
		let native = self.filesystem.is_native_local(&abs_path);
		let checked_path = if native { abs_path } else { pi_vfs::normalize_lexically(&abs_path) };

		if !self.filesystem.metadata(&checked_path).await?.is_dir() {
			return Err(error::ErrorKind::NotADirectory(checked_path).into());
		}

		let cleaned_path = if native {
			crate::sys::fs::expand_to_long_path(&checked_path.normalize())
		} else {
			checked_path
		};

		let pwd = cleaned_path.to_string_lossy().to_string();

		self.env.update_or_add(
			"PWD",
			variables::ShellValueLiteral::Scalar(pwd),
			|_| Ok(()),
			EnvironmentLookup::Anywhere,
			EnvironmentScope::Global,
		)?;
		let oldpwd = std::mem::replace(self.working_dir_mut(), cleaned_path);

		self.env.update_or_add(
			"OLDPWD",
			variables::ShellValueLiteral::Scalar(oldpwd.to_string_lossy().to_string()),
			|_| Ok(()),
			EnvironmentLookup::Anywhere,
			EnvironmentScope::Global,
		)?;

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
		let path = path.as_ref();
		if pi_vfs::is_virtual_path(path) {
			return path.to_owned();
		}
		let normalized_path = crate::sys::fs::normalize_shell_path(path);
		let path = normalized_path.as_ref();
		if path.as_os_str().is_empty() || path.is_absolute() {
			path.to_owned()
		} else {
			pi_vfs::join_path(self.working_dir(), path)
		}
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
