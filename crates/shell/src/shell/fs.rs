//! Filesystem interaction in the shell.

use std::{
	fs::{self, OpenOptions},
	io, mem,
	path::{Path, PathBuf},
};

use omp_core::NormalizePath as _;

use crate::{
	ExecutionParameters, OpenRequest, PathAccess, Shell, ShellFd,
	env::{EnvironmentLookup, EnvironmentScope},
	error,
	extensions::ShellExtensions,
	openfiles::{OpenFile, OpenFiles},
	pathsearch,
	sys::{
		fs::{normalize_shell_path, split_paths, try_open_special_file},
		users,
	},
	variables,
};

impl<SE: ShellExtensions> Shell<SE> {
	/// Sets the shell's current working directory to the given path.
	///
	/// # Arguments
	///
	/// * `target_dir` - The path to set as the working directory.
	pub fn set_working_dir(&mut self, target_dir: impl AsRef<Path>) -> Result<(), error::Error> {
		let abs_path = self.absolute_path(target_dir.as_ref());

		match fs::metadata(&abs_path) {
			Ok(m) => {
				if !m.is_dir() {
					return Err(error::ErrorKind::NotADirectory(abs_path).into());
				}
			},
			Err(e) => {
				return Err(e.into());
			},
		}

		// Normalize the path (but don't canonicalize it).
		let cleaned_path = abs_path.normalize();

		let pwd = cleaned_path.to_string_lossy().to_string();

		self.env.update_or_add(
			"PWD",
			variables::ShellValueLiteral::Scalar(pwd),
			|_| Ok(()),
			EnvironmentLookup::Anywhere,
			EnvironmentScope::Global,
		)?;
		let oldpwd = mem::replace(self.working_dir_mut(), cleaned_path);

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

	/// Finds executables in the shell's current default PATH, matching the given
	/// glob pattern.
	///
	/// # Arguments
	///
	/// * `required_glob_pattern` - The glob pattern to match against.
	pub fn find_executables_in_path<'a>(
		&'a self,
		filename: &'a str,
	) -> impl Iterator<Item = PathBuf> + 'a {
		let path_var = self.env.get_str("PATH", self).unwrap_or_default();
		let paths = split_paths(path_var.as_ref());

		pathsearch::search_for_executable(paths, filename)
	}

	/// Finds executables in the shell's current default PATH, with filenames
	/// matching the given prefix.
	///
	/// # Arguments
	///
	/// * `filename_prefix` - The prefix to match against executable filenames.
	pub fn find_executables_in_path_with_prefix(
		&self,
		filename_prefix: &str,
		case_insensitive: bool,
	) -> impl Iterator<Item = PathBuf> {
		let path_var = self.env.get_str("PATH", self).unwrap_or_default();
		let paths = split_paths(path_var.as_ref());

		pathsearch::search_for_executable_with_prefix(paths, filename_prefix, case_insensitive)
	}

	/// Determines whether the given filename is the name of an executable in one
	/// of the directories in the shell's current PATH. If found, returns the
	/// path.
	///
	/// # Arguments
	///
	/// * `candidate_name` - The name of the file to look for.
	pub fn find_first_executable_in_path<S: AsRef<str>>(
		&self,
		candidate_name: S,
	) -> Option<PathBuf> {
		let path_var = self.env_str("PATH").unwrap_or_default();
		let paths = split_paths(path_var.as_ref());
		pathsearch::search_for_executable(paths, candidate_name.as_ref()).next()
	}

	/// Uses the shell's hash-based path cache to check whether the given
	/// filename is the name of an executable in one of the directories in the
	/// shell's current PATH. If found, ensures the path is in the cache and
	/// returns it.
	///
	/// # Arguments
	///
	/// * `candidate_name` - The name of the file to look for.
	pub fn find_first_executable_in_path_using_cache<S: AsRef<str>>(
		&mut self,
		candidate_name: S,
	) -> Option<PathBuf>
	where
		String: From<S>,
	{
		if let Some(cached_path) = self.program_location_cache.get(&candidate_name) {
			Some(cached_path)
		} else if let Some(found_path) = self.find_first_executable_in_path(&candidate_name) {
			self
				.program_location_cache
				.set(candidate_name, found_path.clone());
			Some(found_path)
		} else {
			None
		}
	}

	/// Gets the absolute form of the given path.
	///
	/// # Arguments
	///
	/// * `path` - The path to get the absolute form of.
	pub fn absolute_path(&self, path: impl AsRef<Path>) -> PathBuf {
		let normalized_path = normalize_shell_path(path.as_ref());
		let path = normalized_path.as_ref();
		if path.as_os_str().is_empty() || path.is_absolute() {
			path.to_owned()
		} else {
			self.working_dir().join(path)
		}
	}

	/// Opens the given file, using the context of this shell and the provided
	/// execution parameters.
	///
	/// # Arguments
	///
	/// * `options` - The options to use opening the file.
	/// * `path` - The path to the file to open; may be relative to the shell's
	///   working directory.
	/// * `params` - Execution parameters.
	/// * `access` - The authority requested for this file operation.
	pub(crate) fn open_file(
		&self,
		options: &OpenOptions,
		path: impl AsRef<Path>,
		params: &ExecutionParameters,
		access: PathAccess,
	) -> Result<OpenFile, io::Error> {
		let path_to_open = self.absolute_path(path.as_ref());

		// `/dev/fd/N` is a shell descriptor reference, never authority to open
		// the embedding process's descriptor table. Resolve it before either a
		// policy or host filesystem access.
		if let Some(parent) = path_to_open.parent()
			&& parent == Path::new("/dev/fd")
			&& let Some(filename) = path_to_open.file_name()
			&& let Ok(fd_num) = filename.to_string_lossy().parse::<ShellFd>()
		{
			return params.try_fd(self, fd_num).map_or_else(
				|| Err(io::Error::new(io::ErrorKind::PermissionDenied, "shell descriptor not mapped")),
				|open_file| open_file.try_clone(),
			);
		}

		if let Some(policy) = params.path_policy() {
			return policy
				.open(&path_to_open, OpenRequest { access, create_mode: 0o666 & !self.virtual_umask() })
				.map(OpenFile::from)
				.map_err(io::Error::other);
		}

		// Give platform-specific code a chance to handle special files
		// (e.g. /dev/null on Windows, which needs to open NUL instead).
		if let Some(result) = try_open_special_file(path.as_ref()) {
			return result.map(OpenFile::from);
		}

		Ok(options.open(path_to_open)?.into())
	}

	/// Replaces the shell's currently configured open files with the given set.
	/// Typically only used by exec-like builtins.
	///
	/// # Arguments
	///
	/// * `open_files` - The new set of open files to use.
	pub fn replace_open_files(&mut self, open_fds: impl Iterator<Item = (ShellFd, OpenFile)>) {
		self.open_files = OpenFiles::from(open_fds);
	}

	pub(crate) const fn persistent_open_files(&self) -> &OpenFiles {
		&self.open_files
	}
}
