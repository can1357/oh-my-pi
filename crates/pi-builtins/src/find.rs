// Copyright 2017 Google Inc.
//
// Use of this source code is governed by a MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.

//! `find` builtin ported from uutils findutils.

pub mod matchers {
	// Copyright 2017 Google Inc.
	//
	// Use of this source code is governed by a MIT-style
	// license that can be found in the LICENSE file or at
	// https://opensource.org/licenses/MIT.

	mod access {
		// Copyright 2022 Tavian Barnes
		//
		// Use of this source code is governed by a MIT-style
		// license that can be found in the LICENSE file or at
		// https://opensource.org/licenses/MIT.

		use faccess::PathExt;

		use super::{Matcher, MatcherIO, WalkEntry};

		/// Matcher for -{read,writ,execut}able.
		pub enum AccessMatcher {
			Readable,
			Writable,
			Executable,
		}

		impl Matcher for AccessMatcher {
			fn matches(&self, file_info: &WalkEntry, _: &mut MatcherIO) -> bool {
				let path = file_info.path();

				match self {
					Self::Readable => path.readable(),
					Self::Writable => path.writable(),
					Self::Executable => path.executable(),
				}
			}
		}
	}
	mod delete {
		/*
		 * This file is part of the uutils findutils package.
		 *
		 * (c) Arcterus <arcterus@mail.com>
		 *
		 * For the full copyright and license information, please view the LICENSE
		 * file that was distributed with this source code.
		 */

		use std::{
			fs,
			io::{self, Write},
		};


		use super::{Matcher, MatcherIO, WalkEntry};

		pub struct DeleteMatcher;

		impl DeleteMatcher {
			pub fn new() -> Self {
				Self
			}

			fn delete(&self, entry: &WalkEntry) -> io::Result<()> {
				if entry.file_type().is_dir() && !entry.path_is_symlink() {
					fs::remove_dir(entry.path())
				} else {
					fs::remove_file(entry.path())
				}
			}
		}

		impl Matcher for DeleteMatcher {
			fn matches(&self, file_info: &WalkEntry, matcher_io: &mut MatcherIO) -> bool {
				let path = file_info.path();
				let path_str = path.to_string_lossy();

				// This is a quirk in find's traditional semantics probably due to
				// POSIX rmdir() not accepting "." (EINVAL). std::fs::remove_dir()
				// inherits the same behavior, so no reason to buck tradition.
				if path_str == "." {
					return true;
				}

				match self.delete(file_info) {
					Ok(()) => true,
					Err(e) => {
						matcher_io.set_exit_code(1);
						writeln!(&mut matcher_io.host().stderr, "Failed to delete {path_str}: {e}").unwrap();
						false
					},
				}
			}

			fn has_side_effects(&self) -> bool {
				true
			}
		}
	}
	mod empty {
		// Copyright 2021 Collabora, Ltd.
		//
		// Use of this source code is governed by a MIT-style
		// license that can be found in the LICENSE file or at
		// https://opensource.org/licenses/MIT.

		use std::{fs::read_dir, io::Write};


		use super::{Matcher, MatcherIO, WalkEntry};

		pub struct EmptyMatcher;

		impl EmptyMatcher {
			pub fn new() -> Self {
				Self
			}
		}

		impl Matcher for EmptyMatcher {
			fn matches(&self, file_info: &WalkEntry, matcher_io: &mut MatcherIO) -> bool {
				if file_info.file_type().is_file() {
					match file_info.metadata() {
						Ok(meta) => meta.len() == 0,
						Err(err) => {
							writeln!(
								&mut matcher_io.host().stderr,
								"Error getting size for {}: {}",
								file_info.path().display(),
								err
							)
							.unwrap();
							false
						},
					}
				} else if file_info.file_type().is_dir() {
					match read_dir(file_info.path()) {
						Ok(mut it) => it.next().is_none(),
						Err(err) => {
							writeln!(
								&mut matcher_io.host().stderr,
								"Error getting contents of {}: {}",
								file_info.path().display(),
								err
							)
							.unwrap();
							false
						},
					}
				} else {
					false
				}
			}
		}
	}
	mod entry {
		//! Paths encountered during a walk.

		#[cfg(unix)]
		use std::os::unix::fs::FileTypeExt;
		use std::{
			cell::OnceCell,
			error::Error,
			ffi::OsStr,
			fmt::{self, Display, Formatter},
			fs::{self, Metadata},
			io::{self, ErrorKind},
			path::{Path, PathBuf},
		};

		use super::Follow;

		/// File types.
		#[derive(Clone, Copy, Debug, Eq, PartialEq)]
		pub enum FileType {
			Unknown,
			Fifo,
			CharDevice,
			Directory,
			BlockDevice,
			Regular,
			Symlink,
			Socket,
		}

		impl FileType {
			pub fn is_dir(self) -> bool {
				self == Self::Directory
			}

			pub fn is_file(self) -> bool {
				self == Self::Regular
			}

			pub fn is_symlink(self) -> bool {
				self == Self::Symlink
			}
		}

		impl From<fs::FileType> for FileType {
			fn from(t: fs::FileType) -> Self {
				if t.is_dir() {
					return Self::Directory;
				}
				if t.is_file() {
					return Self::Regular;
				}
				if t.is_symlink() {
					return Self::Symlink;
				}

				#[cfg(unix)]
				{
					if t.is_fifo() {
						return Self::Fifo;
					}
					if t.is_char_device() {
						return Self::CharDevice;
					}
					if t.is_block_device() {
						return Self::BlockDevice;
					}
					if t.is_socket() {
						return Self::Socket;
					}
				}

				Self::Unknown
			}
		}

		/// An error encountered while walking a file system.
		#[derive(Clone, Debug)]
		pub struct WalkError {
			/// The path that caused the error, if known.
			path:  Option<PathBuf>,
			/// The depth below the root path, if known.
			depth: Option<usize>,
			/// The io::Error::raw_os_error(), if known.
			raw:   Option<i32>,
		}

		impl WalkError {
			/// Get the path this error occurred on, if known.
			pub fn path(&self) -> Option<&Path> {
				self.path.as_deref()
			}

			/// Get the traversal depth when this error occurred, if known.
			pub fn depth(&self) -> Option<usize> {
				self.depth
			}

			/// Get the kind of I/O error.
			pub fn kind(&self) -> ErrorKind {
				io::Error::from(self).kind()
			}

			/// Check for ErrorKind::{NotFound,NotADirectory}.
			pub fn is_not_found(&self) -> bool {
				if self.kind() == ErrorKind::NotFound {
					return true;
				}

				// NotADirectory is nightly-only
				#[cfg(unix)]
				{
					if self.raw == Some(uucore::libc::ENOTDIR) {
						return true;
					}
				}

				false
			}

			/// Check for ErrorKind::FilesystemLoop.
			pub fn is_loop(&self) -> bool {
				#[cfg(unix)]
				return self.raw == Some(uucore::libc::ELOOP);

				#[cfg(not(unix))]
				return false;
			}
		}

		impl Display for WalkError {
			fn fmt(&self, f: &mut Formatter<'_>) -> Result<(), fmt::Error> {
				let ioe = io::Error::from(self);
				if let Some(path) = &self.path {
					write!(f, "{}: {}", path.display(), ioe)
				} else {
					write!(f, "{}", ioe)
				}
			}
		}

		impl Error for WalkError {}

		impl From<io::Error> for WalkError {
			fn from(e: io::Error) -> Self {
				Self::from(&e)
			}
		}

		impl From<&io::Error> for WalkError {
			fn from(e: &io::Error) -> Self {
				Self { path: None, depth: None, raw: e.raw_os_error() }
			}
		}

		impl From<WalkError> for io::Error {
			fn from(e: WalkError) -> Self {
				Self::from(&e)
			}
		}

		impl From<&WalkError> for io::Error {
			fn from(e: &WalkError) -> Self {
				e.raw
					.map(Self::from_raw_os_error)
					.unwrap_or_else(|| ErrorKind::Other.into())
			}
		}

		/// A path encountered while walking a file system.
		#[derive(Debug)]
		pub struct WalkEntry {
			/// Filesystem path for this entry.
			path:    PathBuf,
			/// Depth below the traversal root.
			depth:   usize,
			/// Whether to follow symlinks.
			follow:  Follow,
			/// Cached metadata.
			meta:    OnceCell<Result<Metadata, WalkError>>,
			/// Operand-relative path used for display and path-based matching, when it
			/// differs from the real filesystem path. The shell host roots the walk at
			/// a working-directory-resolved (often absolute) path so stat/exec/delete
			/// target the correct files even though the process cwd differs from the
			/// shell cwd; this preserves the operand-prefixed path GNU find prints and
			/// matches against (e.g. `find .` -> `./a`). `None` falls back to `path()`.
			display: Option<PathBuf>,
		}

		impl WalkEntry {
			/// Create a new WalkEntry for a specific file.
			pub fn new(path: impl Into<PathBuf>, depth: usize, follow: Follow) -> Self {
				Self { path: path.into(), depth, follow, meta: OnceCell::new(), display: None }
			}

			/// Get the path to this entry.
			pub fn path(&self) -> &Path {
				self.path.as_path()
			}


			/// Path used for display (`-print`, `-ls`) and path-based matching
			/// (`-path`, `-regex`, `-printf %p/%h/%P/%H`). Falls back to [`Self::path`]
			/// when no display override was installed (explicit entries, unit tests).
			pub fn display_path(&self) -> &Path {
				self.display.as_deref().unwrap_or_else(|| self.path())
			}

			/// Install an operand-relative display path derived from the original
			/// starting-point `operand` and the `resolved_root` the walk was rooted at.
			/// The real filesystem path is left untouched. When this entry's path is
			/// not under `resolved_root` (e.g. a followed symlink escaping the root)
			/// the override is left unset and display falls back to the real path.
			pub fn set_display_root(&mut self, operand: &Path, resolved_root: &Path) {
				let display = match self.path().strip_prefix(resolved_root) {
					Ok(rel) if rel.as_os_str().is_empty() => operand.to_path_buf(),
					Ok(rel) => operand.join(rel),
					Err(_) => return,
				};
				self.display = Some(display);
			}

			/// Get the name of this entry.
			pub fn file_name(&self) -> &OsStr {
				// Path::file_name() only works if the last component is normal.
				self
					.path
					.components()
					.next_back()
					.map(|c| c.as_os_str())
					.unwrap_or_else(|| self.path.as_os_str())
			}

			/// Get the depth of this entry below the root.
			pub fn depth(&self) -> usize {
				self.depth
			}

			/// Get whether symbolic links are followed for this entry.
			pub fn follow(&self) -> bool {
				self.follow.follow_at_depth(self.depth())
			}

			/// Get the metadata on a cache miss.
			fn get_metadata(&self) -> Result<Metadata, WalkError> {
				self.follow.metadata_at_depth(&self.path, self.depth)
			}

			/// Get the [Metadata] for this entry, following symbolic links if
			/// appropriate. Multiple calls to this function will cache and re-use the
			/// same [Metadata].
			pub fn metadata(&self) -> Result<&Metadata, WalkError> {
				let result = self.meta.get_or_init(|| self.get_metadata());
				result.as_ref().map_err(|e| e.clone())
			}

			/// Get the file type of this entry.
			pub fn file_type(&self) -> FileType {
				self
					.metadata()
					.map(|m| m.file_type().into())
					.unwrap_or(FileType::Unknown)
			}

			/// Check whether this entry is a symbolic link, regardless of whether links
			/// are being followed.
			pub fn path_is_symlink(&self) -> bool {
				if self.follow() {
					self
						.path
						.symlink_metadata()
						.is_ok_and(|m| m.file_type().is_symlink())
				} else {
					self.file_type().is_symlink()
				}
			}
		}
	}
	pub mod exec {
		// Copyright 2017 Google Inc.
		//
		// Use of this source code is governed by a MIT-style
		// license that can be found in the LICENSE file or at
		// https://opensource.org/licenses/MIT.

		use std::{cell::RefCell, error::Error, ffi::OsString, io::Write, path::Path, process::Command};


		use super::{Matcher, MatcherIO, WalkEntry};

		enum Arg {
			FileArg(Vec<OsString>),
			LiteralArg(OsString),
		}

		pub struct SingleExecMatcher {
			executable:         String,
			args:               Vec<Arg>,
			exec_in_parent_dir: bool,
		}

		impl SingleExecMatcher {
			pub fn new(
				executable: &str,
				args: &[&str],
				exec_in_parent_dir: bool,
			) -> Result<Self, Box<dyn Error>> {
				let transformed_args = args
					.iter()
					.map(|&a| {
						let parts = a.split("{}").collect::<Vec<_>>();
						if parts.len() == 1 {
							// No {} present
							Arg::LiteralArg(OsString::from(a))
						} else {
							Arg::FileArg(parts.iter().map(OsString::from).collect())
						}
					})
					.collect();

				Ok(Self { executable: executable.to_string(), args: transformed_args, exec_in_parent_dir })
			}
		}

		impl Matcher for SingleExecMatcher {
			fn matches(&self, file_info: &WalkEntry, matcher_io: &mut MatcherIO) -> bool {
				let mut command = Command::new(&self.executable);
				let path_to_file = if self.exec_in_parent_dir {
					if let Some(f) = file_info.path().file_name() {
						Path::new(".").join(f)
					} else {
						Path::new(".").join(file_info.path())
					}
				} else {
					file_info.display_path().to_path_buf()
				};

				for arg in &self.args {
					match *arg {
						Arg::LiteralArg(ref a) => command.arg(a.as_os_str()),
						Arg::FileArg(ref parts) => command.arg(parts.join(path_to_file.as_os_str())),
					};
				}
				if self.exec_in_parent_dir {
					match file_info.path().parent() {
						None => {
							// Root paths like "/" have no parent.  Run them from the root to match GNU
							// find.
							command.current_dir(file_info.path());
						},
						Some(parent) if parent == Path::new("") => {
							// Paths like "foo" have a parent of "".  Avoid chdir("").
						},
						Some(parent) => {
							command.current_dir(parent);
						},
					}
				} else {
					// GNU runs `-exec` in find's working directory; resolve the
					// operand-relative `{}` against the shell cwd, not the host cwd.
					command.current_dir(matcher_io.host().cwd());
				}
				command.env_clear().envs(matcher_io.host().env());
				// The host process's stdio belongs to the embedding TUI; route the
				// child's output through the scope streams instead of inheriting.
				match matcher_io.host().run_captured(&mut command) {
					Ok(status) => status.success(),
					Err(e) => {
						writeln!(&mut matcher_io.host().stderr, "Failed to run {}: {}", self.executable, e).unwrap();
						false
					},
				}
			}

			fn has_side_effects(&self) -> bool {
				true
			}
		}

		pub struct MultiExecMatcher {
			executable:         String,
			args:               Vec<OsString>,
			exec_in_parent_dir: bool,
			/// Command to build while matching.
			command:            RefCell<Option<argmax::Command>>,
		}

		impl MultiExecMatcher {
			pub fn new(
				executable: &str,
				args: &[&str],
				exec_in_parent_dir: bool,
			) -> Result<Self, Box<dyn Error>> {
				let transformed_args = args.iter().map(OsString::from).collect();

				Ok(Self {
					executable: executable.to_string(),
					args: transformed_args,
					exec_in_parent_dir,
					command: RefCell::new(None),
				})
			}

			fn new_command(&self, matcher_io: &mut MatcherIO) -> argmax::Command {
				let mut command = argmax::Command::new(&self.executable);
				command.try_args(&self.args).unwrap();
				if !self.exec_in_parent_dir {
					// `-exec ... +` (non-execdir) dispatches in find's working dir;
					// resolve the operand-relative paths against the shell cwd.
					command.current_dir(matcher_io.host().cwd());
				}
				command
			}

			fn run_command(&self, command: &mut argmax::Command, matcher_io: &mut MatcherIO) {
				// `argmax::Command` only Derefs immutably into `std::process::Command`,
				// so rebuild a std command from its accumulated state to attach the
				// scope environment and context-captured stdio — the host process's
				// stdio belongs to the embedding TUI and must never be inherited.
				let mut std_command = Command::new(command.get_program());
				std_command.args(command.get_args());
				if let Some(dir) = command.get_current_dir() {
					std_command.current_dir(dir);
				}
				std_command.env_clear().envs(matcher_io.host().env());
				match matcher_io.host().run_captured(&mut std_command) {
					Ok(status) => {
						if !status.success() {
							matcher_io.set_exit_code(1);
						}
					},
					Err(e) => {
						writeln!(&mut matcher_io.host().stderr, "Failed to run {}: {}", self.executable, e).unwrap();
						matcher_io.set_exit_code(1);
					},
				}
			}
		}

		impl Matcher for MultiExecMatcher {
			fn matches(&self, file_info: &WalkEntry, matcher_io: &mut MatcherIO) -> bool {
				let path_to_file = if self.exec_in_parent_dir {
					if let Some(f) = file_info.path().file_name() {
						Path::new(".").join(f)
					} else {
						Path::new(".").join(file_info.path())
					}
				} else {
					file_info.display_path().to_path_buf()
				};
				let mut command = self.command.borrow_mut();
				let command = command.get_or_insert_with(|| self.new_command(matcher_io));

				// Build command, or dispatch it before when it is long enough.
				if command.try_arg(&path_to_file).is_err() {
					if self.exec_in_parent_dir {
						match file_info.path().parent() {
							None => {
								// Root paths like "/" have no parent.  Run them from the root to match GNU
								// find.
								command.current_dir(file_info.path());
							},
							Some(parent) if parent == Path::new("") => {
								// Paths like "foo" have a parent of "".  Avoid chdir("").
							},
							Some(parent) => {
								command.current_dir(parent);
							},
						}
					}
					self.run_command(command, matcher_io);

					// Reset command status.
					*command = self.new_command(matcher_io);
					if let Err(e) = command.try_arg(&path_to_file) {
						writeln!(
							&mut matcher_io.host().stderr,
							"Cannot fit a single argument {}: {}",
							path_to_file.to_string_lossy(),
							e
						)
						.unwrap();
						matcher_io.set_exit_code(1);
					}
				}
				true
			}

			fn finished_dir(&self, dir: &Path, matcher_io: &mut MatcherIO) {
				// Dispatch command for -execdir.
				if self.exec_in_parent_dir {
					let mut command = self.command.borrow_mut();
					if let Some(mut command) = command.take() {
						command.current_dir(Path::new(".").join(dir));
						self.run_command(&mut command, matcher_io);
					}
				}
			}

			fn finished(&self, matcher_io: &mut MatcherIO) {
				// Dispatch command for -exec.
				if !self.exec_in_parent_dir {
					let mut command = self.command.borrow_mut();
					if let Some(mut command) = command.take() {
						self.run_command(&mut command, matcher_io);
					}
				}
			}

			fn has_side_effects(&self) -> bool {
				true
			}
		}
	}
	pub mod fs {
		// This file is part of the uutils findutils package.
		//
		// For the full copyright and license information, please view the LICENSE
		// file that was distributed with this source code.
		#[cfg(unix)]
		use std::{cell::RefCell, io, io::Write, path::Path};

		use super::{Matcher, MatcherIO, WalkEntry};

		/// The latest mapping from dev_id to fs_type, used for saving mount info reads
		#[cfg(unix)]
		pub struct Cache {
			dev_id:  String,
			fs_type: String,
		}

		/// Get the filesystem type of a file.
		/// 1. get the metadata of the file
		/// 2. get the device ID of the metadata
		/// 3. search the cache, then the filesystem list
		///
		/// Returns an empty string when no file system list matches.
		///
		/// # Errors
		/// Returns an error if the metadata or the mount table could not be read.
		///
		/// This is only supported on Unix.
		#[cfg(unix)]
		pub fn get_file_system_type(
			path: &Path,
			cache: &RefCell<Option<Cache>>,
		) -> io::Result<String> {
			use std::os::unix::fs::MetadataExt;

			// use symlink_metadata (lstat under the hood) instead of metadata (stat) to
			// make sure that it does not return an error when there is a (broken) symlink;
			// this is aligned with GNU find.
			let dev_id = path.symlink_metadata()?.dev().to_string();

			if let Some(cache) = cache.borrow().as_ref()
				&& cache.dev_id == dev_id
			{
				return Ok(cache.fs_type.clone());
			}

			// `read_fs_list` reports failures through uucore's error type; the mount
			// table is either readable or it is not, so flatten it to an io error.
			let fs_list = uucore::fsext::read_fs_list().map_err(|err| io::Error::other(err.to_string()))?;
			let result = fs_list
				.into_iter()
				.find(|fs| fs.dev_id == dev_id)
				.map_or_else(String::new, |fs| fs.fs_type);

			// cache the latest query if not a match before
			cache.replace(Some(Cache { dev_id, fs_type: result.clone() }));

			Ok(result)
		}

		/// This matcher handles the -fstype argument.
		/// It matches the filesystem type of the file.
		///
		/// This is only supported on Unix.
		pub struct FileSystemMatcher {
			#[cfg(unix)]
			fs_text: String,
			#[cfg(unix)]
			cache:   RefCell<Option<Cache>>,
		}

		impl FileSystemMatcher {
			#[cfg(unix)]
			pub fn new(fs_text: String) -> Self {
				Self { fs_text, cache: RefCell::new(None) }
			}

			#[cfg(not(unix))]
			pub fn new(_fs_text: String) -> Self {
				Self {}
			}
		}

		impl Matcher for FileSystemMatcher {
			#[cfg(unix)]
			fn matches(&self, file_info: &WalkEntry, matcher_io: &mut MatcherIO) -> bool {
				match get_file_system_type(file_info.path(), &self.cache) {
					Ok(result) => result == self.fs_text,
					Err(_) => {
						writeln!(
							&mut matcher_io.host().stderr,
							"Error getting filesystem type for {}",
							file_info.path().to_string_lossy()
						)
						.unwrap();

						false
					},
				}
			}

			#[cfg(not(unix))]
			fn matches(&self, _file_info: &WalkEntry, _matcher_io: &mut MatcherIO) -> bool {
				false
			}
		}
	}
	mod glob {
		// Copyright 2022 Tavian Barnes
		//
		// Use of this source code is governed by a MIT-style
		// license that can be found in the LICENSE file or at
		// https://opensource.org/licenses/MIT.

		use onig::{Regex, RegexOptions, Syntax};

		/// Parse a string as a POSIX Basic Regular Expression.
		fn parse_bre(expr: &str, options: RegexOptions) -> Result<Regex, onig::Error> {
			let bre = Syntax::posix_basic();
			Regex::with_options(expr, bre.options() | options, bre)
		}

		/// Push a literal character onto a regex, escaping it if necessary.
		fn regex_push_literal(regex: &mut String, ch: char) {
			// https://pubs.opengroup.org/onlinepubs/9699919799/basedefs/V1_chap09.html#tag_09_03_03
			if matches!(ch, '.' | '[' | '\\' | '*' | '^' | '$') {
				regex.push('\\');
			}
			regex.push(ch);
		}

		/// Extracts a bracket expression from a glob.
		fn extract_bracket_expr(pattern: &str) -> Option<(String, &str)> {
			// https://pubs.opengroup.org/onlinepubs/9699919799/utilities/V3_chap02.html#tag_18_13_01
			//
			//     If an open bracket introduces a bracket expression as in XBD RE Bracket
			// Expression,     except that the <exclamation-mark> character ( '!' ) shall
			// replace the <circumflex>     character ( '^' ) in its role in a non-matching
			// list in the regular expression notation,     it shall introduce a pattern
			// bracket expression. A bracket expression starting with an     unquoted
			// <circumflex> character produces unspecified results. Otherwise, '[' shall
			// match     the character itself.
			//
			// To check for valid bracket expressions, we scan for the closing bracket and
			// attempt to parse that segment as a regex.  If that fails, we treat the '['
			// literally.

			let mut expr = "[".to_string();

			let mut chars = pattern.chars();
			let mut next = chars.next();

			// https://pubs.opengroup.org/onlinepubs/9699919799/basedefs/V1_chap09.html#tag_09_03_05
			//
			//     3. A non-matching list expression begins with a <circumflex> ( '^' ) ...
			//
			// (but in a glob, '!' is used instead of '^')
			if next == Some('!') {
				expr.push('^');
				next = chars.next();
			}

			// https://pubs.opengroup.org/onlinepubs/9699919799/basedefs/V1_chap09.html#tag_09_03_05
			//
			//     1. ... The <right-square-bracket> ( ']' ) shall lose its special meaning
			//        and represent itself in a bracket expression if it occurs first in the
			//        list (after an initial <circumflex> ( '^' ), if any).
			if next == Some(']') {
				expr.push(']');
				next = chars.next();
			}

			while let Some(ch) = next {
				expr.push(ch);

				match ch {
					'[' => {
						// https://pubs.opengroup.org/onlinepubs/9699919799/basedefs/V1_chap09.html#tag_09_03_05
						//
						//     4. A collating symbol is a collating element enclosed within
						//        bracket-period ( "[." and ".]" ) delimiters. ...
						//
						//     5. An equivalence class expression shall ... be expressed by enclosing
						//        any one of the collating elements in the equivalence class within
						//        bracket- equal ( "[=" and "=]" ) delimiters.
						//
						//     6. ...  A character class expression is expressed as a character class
						//        name enclosed within bracket- <colon> ( "[:" and ":]" ) delimiters.
						next = chars.next();
						if let Some(delim) = next {
							expr.push(delim);

							if matches!(delim, '.' | '=' | ':') {
								let rest = chars.as_str();
								let end = rest.find([delim, ']'])? + 2;
								expr.push_str(&rest[..end]);
								chars = rest[end..].chars();
							}
						}
					},
					']' => {
						// https://pubs.opengroup.org/onlinepubs/9699919799/basedefs/V1_chap09.html#tag_09_03_05
						//
						//     1. ... The <right-square-bracket> ( ']' ) shall ... terminate the bracket
						//        expression, unless it appears in a collating symbol (such as "[.].]" )
						//        or is the ending <right-square-bracket> for a collating symbol,
						//        equivalence class, or character class.
						break;
					},
					_ => {},
				}

				next = chars.next();
			}

			if parse_bre(&expr, RegexOptions::REGEX_OPTION_NONE).is_ok() {
				Some((expr, chars.as_str()))
			} else {
				None
			}
		}

		/// Converts a POSIX glob into a POSIX Basic Regular Expression
		fn glob_to_regex(pattern: &str) -> Option<String> {
			let mut regex = String::new();

			let mut chars = pattern.chars();
			while let Some(ch) = chars.next() {
				// https://pubs.opengroup.org/onlinepubs/9699919799/utilities/V3_chap02.html#tag_18_13
				match ch {
					'?' => regex.push('.'),
					'*' => regex.push_str(".*"),
					'\\' => {
						let ch = chars.next()?;
						regex_push_literal(&mut regex, ch);
					},
					'[' => {
						if let Some((expr, rest)) = extract_bracket_expr(chars.as_str()) {
							regex.push_str(&expr);
							chars = rest.chars();
						} else {
							regex_push_literal(&mut regex, ch);
						}
					},
					_ => regex_push_literal(&mut regex, ch),
				}
			}

			Some(regex)
		}

		/// An fnmatch()-style glob matcher.
		pub struct Pattern {
			regex: Option<Regex>,
		}

		impl Pattern {
			/// Parse an fnmatch()-style glob.
			pub fn new(pattern: &str, caseless: bool) -> Self {
				let options = if caseless {
					RegexOptions::REGEX_OPTION_IGNORECASE
				} else {
					RegexOptions::REGEX_OPTION_NONE
				};

				// As long as glob_to_regex() is correct, this should never fail
				let regex = glob_to_regex(pattern).map(|r| parse_bre(&r, options).unwrap());
				Self { regex }
			}

			/// Test if this pattern matches a string.
			pub fn matches(&self, string: &str) -> bool {
				self.regex.as_ref().is_some_and(|r| r.is_match(string))
			}
		}
	}
	mod group {
		// This file is part of the uutils findutils package.
		//
		// For the full copyright and license information, please view the LICENSE
		// file that was distributed with this source code.

		#[cfg(unix)]
		use std::os::unix::fs::MetadataExt;

		#[cfg(unix)]
		use nix::unistd::Group;

		use super::{ComparableValue, Matcher, MatcherIO, WalkEntry};

		pub struct GroupMatcher {
			#[cfg_attr(not(unix), allow(dead_code))]
			gid: ComparableValue,
		}

		impl GroupMatcher {
			#[cfg(unix)]
			pub fn from_group_name(group: &str) -> Option<Self> {
				// get gid from group name
				let group = Group::from_name(group).ok()??;
				let gid = group.gid.as_raw();
				Some(Self::from_gid(gid))
			}

			pub fn from_gid(gid: u32) -> Self {
				Self::from_comparable(ComparableValue::EqualTo(gid as u64))
			}

			pub fn from_comparable(gid: ComparableValue) -> Self {
				Self { gid }
			}

			#[cfg(windows)]
			pub fn from_group_name(_group: &str) -> Option<Self> {
				None
			}
		}

		impl Matcher for GroupMatcher {
			#[cfg(unix)]
			fn matches(&self, file_info: &WalkEntry, _: &mut MatcherIO) -> bool {
				match file_info.metadata() {
					Ok(metadata) => self.gid.matches(metadata.gid().into()),
					Err(_) => false,
				}
			}

			#[cfg(windows)]
			fn matches(&self, _file_info: &WalkEntry, _: &mut MatcherIO) -> bool {
				// The user group acquisition function for Windows systems is not implemented in
				// MetadataExt, so it is somewhat difficult to implement it. :(
				false
			}
		}

		pub struct NoGroupMatcher {}

		impl Matcher for NoGroupMatcher {
			#[cfg(unix)]
			fn matches(&self, file_info: &WalkEntry, _: &mut MatcherIO) -> bool {
				use nix::unistd::Gid;

				if file_info.path().is_symlink() {
					return false;
				}

				let Ok(metadata) = file_info.metadata() else {
					return true;
				};

				let Ok(gid) = Group::from_gid(Gid::from_raw(metadata.gid())) else {
					return true;
				};

				let Some(_group) = gid else {
					return true;
				};

				false
			}

			#[cfg(windows)]
			fn matches(&self, _file_info: &WalkEntry, _: &mut MatcherIO) -> bool {
				false
			}
		}
	}
	mod lname {
		// Copyright 2017 Google Inc.
		//
		// Use of this source code is governed by a MIT-style
		// license that can be found in the LICENSE file or at
		// https://opensource.org/licenses/MIT.

		use std::{io::Write, path::PathBuf};


		use super::{Matcher, MatcherIO, WalkEntry, glob::Pattern};

		fn read_link_target(file_info: &WalkEntry, matcher_io: &mut MatcherIO) -> Option<PathBuf> {
			match file_info.path().read_link() {
				Ok(target) => Some(target),
				Err(err) => {
					// If it's not a symlink, then it's not an error that should be
					// shown.
					if err.kind() != std::io::ErrorKind::InvalidInput {
						writeln!(
							&mut matcher_io.host().stderr,
							"Error reading target of {}: {}",
							file_info.path().display(),
							err
						)
						.unwrap();
					}

					None
				},
			}
		}

		/// This matcher makes a comparison of the link target against a shell wildcard
		/// pattern. See `glob::Pattern` for details on the exact syntax.
		pub struct LinkNameMatcher {
			pattern: Pattern,
		}

		impl LinkNameMatcher {
			pub fn new(pattern_string: &str, caseless: bool) -> Self {
				let pattern = Pattern::new(pattern_string, caseless);
				Self { pattern }
			}
		}

		impl Matcher for LinkNameMatcher {
			fn matches(&self, file_info: &WalkEntry, matcher_io: &mut MatcherIO) -> bool {
				if let Some(target) = read_link_target(file_info, matcher_io) {
					self.pattern.matches(&target.to_string_lossy())
				} else {
					false
				}
			}
		}
	}
	mod logical_matchers {
		// Copyright 2017 Google Inc.
		//
		// Use of this source code is governed by a MIT-style
		// license that can be found in the LICENSE file or at
		// https://opensource.org/licenses/MIT.

		//! This modules contains the matchers used for combining other matchers and
		//! performing boolean logic on them (and a couple of trivial always-true and
		//! always-false matchers). The design is strongly tied to the precedence rules
		//! when parsing command-line options (e.g. "-foo -o -bar -baz" is equivalent
		//! to "-foo -o ( -bar -baz )", not "( -foo -o -bar ) -baz").
		use std::{error::Error, path::Path};

		use super::{Matcher, MatcherIO, WalkEntry};

		/// This matcher contains a collection of other matchers. A file only matches
		/// if it matches ALL the contained sub-matchers. For sub-matchers that have
		/// side effects, the side effects occur in the same order as the sub-matchers
		/// were pushed into the collection.
		pub struct AndMatcher {
			submatchers: Vec<Box<dyn Matcher>>,
		}

		impl AndMatcher {
			pub fn new(submatchers: Vec<Box<dyn Matcher>>) -> Self {
				Self { submatchers }
			}
		}

		impl Matcher for AndMatcher {
			/// Returns true if all sub-matchers return true. Short-circuiting does take
			/// place. If the nth sub-matcher returns false, then we immediately return
			/// and don't make any further calls.
			fn matches(&self, dir_entry: &WalkEntry, matcher_io: &mut MatcherIO) -> bool {
				for matcher in &self.submatchers {
					if !matcher.matches(dir_entry, matcher_io) {
						return false;
					}
					if matcher_io.should_quit() {
						break;
					}
				}

				true
			}

			fn has_side_effects(&self) -> bool {
				self
					.submatchers
					.iter()
					.any(super::Matcher::has_side_effects)
			}

			fn finished_dir(&self, dir: &Path, matcher_io: &mut MatcherIO) {
				for m in &self.submatchers {
					m.finished_dir(dir, matcher_io);
				}
			}

			fn finished(&self, matcher_io: &mut MatcherIO) {
				for m in &self.submatchers {
					m.finished(matcher_io);
				}
			}
		}

		pub struct AndMatcherBuilder {
			submatchers: Vec<Box<dyn Matcher>>,
		}

		impl AndMatcherBuilder {
			pub fn new() -> Self {
				Self { submatchers: Vec::new() }
			}

			pub fn new_and_condition(&mut self, matcher: impl Matcher) {
				self.submatchers.push(matcher.into_box());
			}

			/// Builds a Matcher: consuming the builder in the process.
			pub fn build(mut self) -> Box<dyn Matcher> {
				// special case. If there's only one submatcher, just return that directly
				if self.submatchers.len() == 1 {
					// safe to unwrap: we've just checked the size
					return self.submatchers.pop().unwrap();
				}
				AndMatcher::new(self.submatchers).into_box()
			}
		}

		/// This matcher contains a collection of other matchers. A file matches
		/// if it matches any of the contained sub-matchers. For sub-matchers that have
		/// side effects, the side effects occur in the same order as the sub-matchers
		/// were pushed into the collection.
		pub struct OrMatcher {
			submatchers: Vec<Box<dyn Matcher>>,
		}

		impl OrMatcher {
			pub fn new(submatchers: Vec<Box<dyn Matcher>>) -> Self {
				Self { submatchers }
			}
		}

		impl Matcher for OrMatcher {
			/// Returns true if any sub-matcher returns true. Short-circuiting does take
			/// place. If the nth sub-matcher returns true, then we immediately return
			/// and don't make any further calls.
			fn matches(&self, dir_entry: &WalkEntry, matcher_io: &mut MatcherIO) -> bool {
				for matcher in &self.submatchers {
					if matcher.matches(dir_entry, matcher_io) {
						return true;
					}
					if matcher_io.should_quit() {
						break;
					}
				}

				false
			}

			fn has_side_effects(&self) -> bool {
				self
					.submatchers
					.iter()
					.any(super::Matcher::has_side_effects)
			}

			fn finished_dir(&self, dir: &Path, matcher_io: &mut MatcherIO) {
				for m in &self.submatchers {
					m.finished_dir(dir, matcher_io);
				}
			}

			fn finished(&self, matcher_io: &mut MatcherIO) {
				for m in &self.submatchers {
					m.finished(matcher_io);
				}
			}
		}

		pub struct OrMatcherBuilder {
			submatchers: Vec<AndMatcherBuilder>,
		}

		impl OrMatcherBuilder {
			pub fn new_and_condition(&mut self, matcher: impl Matcher) {
				// safe to unwrap. submatchers always has at least one member
				self
					.submatchers
					.last_mut()
					.unwrap()
					.new_and_condition(matcher);
			}

			pub fn new_or_condition(&mut self, arg: &str) -> Result<(), Box<dyn Error>> {
				if self.submatchers.last().unwrap().submatchers.is_empty() {
					return Err(From::from(format!(
						"invalid expression; you have used a binary operator '{arg}' with nothing before it."
					)));
				}
				self.submatchers.push(AndMatcherBuilder::new());
				Ok(())
			}

			pub fn new() -> Self {
				let mut o = Self { submatchers: Vec::new() };
				o.submatchers.push(AndMatcherBuilder::new());
				o
			}

			/// Builds a Matcher: consuming the builder in the process.
			pub fn build(mut self) -> Box<dyn Matcher> {
				// Special case: if there's only one submatcher, just return that directly
				if self.submatchers.len() == 1 {
					// safe to unwrap: we've just checked the size
					return self.submatchers.pop().unwrap().build();
				}
				let mut submatchers = vec![];
				for x in self.submatchers {
					submatchers.push(x.build());
				}
				OrMatcher::new(submatchers).into_box()
			}
		}

		/// This matcher contains a collection of other matchers. In contrast to
		/// `OrMatcher` and `AndMatcher`, all the submatcher objects are called
		/// regardless of the results of previous submatchers. This is primarily used
		/// for submatchers with side-effects. For such sub-matchers the side effects
		/// occur in the same order as the sub-matchers were pushed into the collection.
		pub struct ListMatcher {
			submatchers: Vec<Box<dyn Matcher>>,
		}

		impl ListMatcher {
			pub fn new(submatchers: Vec<Box<dyn Matcher>>) -> Self {
				Self { submatchers }
			}
		}

		impl Matcher for ListMatcher {
			/// Calls matches on all submatcher objects, with no short-circuiting.
			/// Returns the result of the call to the final submatcher
			fn matches(&self, dir_entry: &WalkEntry, matcher_io: &mut MatcherIO) -> bool {
				let mut rc = false;
				for matcher in &self.submatchers {
					rc = matcher.matches(dir_entry, matcher_io);
					if matcher_io.should_quit() {
						break;
					}
				}
				rc
			}

			fn has_side_effects(&self) -> bool {
				self
					.submatchers
					.iter()
					.any(super::Matcher::has_side_effects)
			}

			fn finished_dir(&self, dir: &Path, matcher_io: &mut MatcherIO) {
				for m in &self.submatchers {
					m.finished_dir(dir, matcher_io);
				}
			}

			fn finished(&self, matcher_io: &mut MatcherIO) {
				for m in &self.submatchers {
					m.finished(matcher_io);
				}
			}
		}

		pub struct ListMatcherBuilder {
			submatchers: Vec<OrMatcherBuilder>,
		}

		impl ListMatcherBuilder {
			pub fn new_and_condition(&mut self, matcher: impl Matcher) {
				// safe to unwrap. submatchers always has at least one member
				self
					.submatchers
					.last_mut()
					.unwrap()
					.new_and_condition(matcher);
			}

			pub fn new_or_condition(&mut self, arg: &str) -> Result<(), Box<dyn Error>> {
				self.submatchers.last_mut().unwrap().new_or_condition(arg)
			}

			pub fn check_new_and_condition(&mut self) -> Result<(), Box<dyn Error>> {
				{
					let child_or_matcher = &self.submatchers.last().unwrap();
					let grandchild_and_matcher = &child_or_matcher.submatchers.last().unwrap();

					if grandchild_and_matcher.submatchers.is_empty() {
						return Err(From::from(
							"invalid expression; you have used a binary operator '-a' with nothing before it.",
						));
					}
				}
				Ok(())
			}

			pub fn new_list_condition(&mut self) -> Result<(), Box<dyn Error>> {
				{
					let child_or_matcher = &self.submatchers.last().unwrap();
					let grandchild_and_matcher = &child_or_matcher.submatchers.last().unwrap();

					if grandchild_and_matcher.submatchers.is_empty() {
						return Err(From::from(
							"invalid expression; you have used a binary operator ',' with nothing before it.",
						));
					}
				}
				self.submatchers.push(OrMatcherBuilder::new());
				Ok(())
			}

			pub fn new() -> Self {
				let mut o = Self { submatchers: Vec::new() };
				o.submatchers.push(OrMatcherBuilder::new());
				o
			}

			/// Builds a Matcher: consuming the builder in the process.
			pub fn build(mut self) -> Box<dyn Matcher> {
				// Special case: if there's only one submatcher, just return that directly
				if self.submatchers.len() == 1 {
					// safe to unwrap: we've just checked the size
					return self.submatchers.pop().unwrap().build();
				}
				let mut submatchers = vec![];
				for x in self.submatchers {
					submatchers.push(x.build());
				}
				Box::new(ListMatcher::new(submatchers))
			}
		}

		/// A simple matcher that always matches.
		pub struct TrueMatcher;

		impl Matcher for TrueMatcher {
			fn matches(&self, _dir_entry: &WalkEntry, _: &mut MatcherIO) -> bool {
				true
			}
		}

		/// A simple matcher that never matches.
		pub struct FalseMatcher;

		impl Matcher for FalseMatcher {
			fn matches(&self, _dir_entry: &WalkEntry, _: &mut MatcherIO) -> bool {
				false
			}
		}

		/// Matcher that wraps another matcher and inverts matching criteria.
		pub struct NotMatcher {
			submatcher: Box<dyn Matcher>,
		}

		impl NotMatcher {
			pub fn new(submatcher: impl Matcher) -> Self {
				Self { submatcher: submatcher.into_box() }
			}
		}

		impl Matcher for NotMatcher {
			fn matches(&self, dir_entry: &WalkEntry, matcher_io: &mut MatcherIO) -> bool {
				!self.submatcher.matches(dir_entry, matcher_io)
			}

			fn has_side_effects(&self) -> bool {
				self.submatcher.has_side_effects()
			}

			fn finished_dir(&self, dir: &Path, matcher_io: &mut MatcherIO) {
				self.submatcher.finished_dir(dir, matcher_io);
			}

			fn finished(&self, matcher_io: &mut MatcherIO) {
				self.submatcher.finished(matcher_io);
			}
		}
	}
	mod ls {
		// This file is part of the uutils findutils package.
		//
		// For the full copyright and license information, please view the LICENSE
		// file that was distributed with this source code.

		use std::{fs::File, io::Write};

		use chrono::DateTime;

		use super::{Matcher, MatcherIO, WalkEntry};

		#[cfg(unix)]
		fn format_permissions(mode: uucore::libc::mode_t) -> String {
			let file_type = match mode & (uucore::libc::S_IFMT as uucore::libc::mode_t) {
				uucore::libc::S_IFDIR => "d",
				uucore::libc::S_IFREG => "-",
				_ => "?",
			};

			// S_$$USR means "user permissions"
			let user_perms = format!(
				"{}{}{}",
				if mode & uucore::libc::S_IRUSR != 0 {
					"r"
				} else {
					"-"
				},
				if mode & uucore::libc::S_IWUSR != 0 {
					"w"
				} else {
					"-"
				},
				if mode & uucore::libc::S_IXUSR != 0 {
					"x"
				} else {
					"-"
				}
			);

			// S_$$GRP means "group permissions"
			let group_perms = format!(
				"{}{}{}",
				if mode & uucore::libc::S_IRGRP != 0 {
					"r"
				} else {
					"-"
				},
				if mode & uucore::libc::S_IWGRP != 0 {
					"w"
				} else {
					"-"
				},
				if mode & uucore::libc::S_IXGRP != 0 {
					"x"
				} else {
					"-"
				}
			);

			// S_$$OTH means "other permissions"
			let other_perms = format!(
				"{}{}{}",
				if mode & uucore::libc::S_IROTH != 0 {
					"r"
				} else {
					"-"
				},
				if mode & uucore::libc::S_IWOTH != 0 {
					"w"
				} else {
					"-"
				},
				if mode & uucore::libc::S_IXOTH != 0 {
					"x"
				} else {
					"-"
				}
			);

			format!("{}{}{}{}", file_type, user_perms, group_perms, other_perms)
		}

		#[cfg(windows)]
		fn format_permissions(file_attributes: u32) -> String {
			let mut attributes = Vec::new();

			// https://learn.microsoft.com/en-us/windows/win32/fileio/file-attribute-constants
			if file_attributes & 0x0001 != 0 {
				attributes.push("read-only");
			}
			if file_attributes & 0x0002 != 0 {
				attributes.push("hidden");
			}
			if file_attributes & 0x0004 != 0 {
				attributes.push("system");
			}
			if file_attributes & 0x0020 != 0 {
				attributes.push("archive");
			}
			if file_attributes & 0x0040 != 0 {
				attributes.push("compressed");
			}
			if file_attributes & 0x0080 != 0 {
				attributes.push("offline");
			}

			attributes.join(", ")
		}

		pub struct Ls {
			output_file: Option<File>,
		}

		impl Ls {
			pub fn new(output_file: Option<File>) -> Self {
				Self { output_file }
			}

			#[cfg(unix)]
			fn print(
				&self,
				file_info: &WalkEntry,
				matcher_io: &mut MatcherIO,
				mut out: impl Write,
				print_error_message: bool,
			) {
				use std::os::unix::fs::{MetadataExt, PermissionsExt};

				use nix::unistd::{Gid, Group, Uid, User};

				let metadata = file_info.metadata().unwrap();

				let inode_number = metadata.ino();
				let number_of_blocks = {
					let size = metadata.size();
					let number_of_blocks = size / 1024;
					let remainder = number_of_blocks % 4;

					if remainder == 0 {
						if number_of_blocks == 0 {
							4
						} else {
							number_of_blocks
						}
					} else {
						number_of_blocks + (4 - (remainder))
					}
				};
				let permission =
					{ format_permissions(metadata.permissions().mode() as uucore::libc::mode_t) };
				let hard_links = metadata.nlink();
				let user = {
					let uid = metadata.uid();
					User::from_uid(Uid::from_raw(uid)).unwrap().unwrap().name
				};
				let group = {
					let gid = metadata.gid();
					Group::from_gid(Gid::from_raw(gid)).unwrap().unwrap().name
				};
				let size = metadata.size();
				let last_modified = {
					let system_time = metadata.modified().unwrap();
					let now_utc: DateTime<chrono::Utc> = system_time.into();
					now_utc.format("%b %e %H:%M")
				};
				let path = file_info.display_path().to_string_lossy();

				match writeln!(
					out,
					" {:<4} {:>6} {:<10} {:>3} {:<8} {:<8} {:>8} {} {}",
					inode_number,
					number_of_blocks,
					permission,
					hard_links,
					user,
					group,
					size,
					last_modified,
					path,
				) {
					Ok(_) => {},
					Err(e) => {
						if print_error_message {
							writeln!(
								&mut matcher_io.host().stderr,
								"Error writing {:?} for {}",
								file_info.display_path().to_string_lossy(),
								e
							)
							.unwrap();
							matcher_io.set_exit_code(1);
						}
					},
				}
			}

			#[cfg(windows)]
			fn print(
				&self,
				file_info: &WalkEntry,
				matcher_io: &mut MatcherIO,
				mut out: impl Write,
				print_error_message: bool,
			) {
				use std::os::windows::fs::MetadataExt;

				let metadata = file_info.metadata().unwrap();

				let inode_number = 0;
				let number_of_blocks = {
					let size = metadata.file_size();
					let number_of_blocks = size / 1024;
					let remainder = number_of_blocks % 4;

					if remainder == 0 {
						if number_of_blocks == 0 {
							4
						} else {
							number_of_blocks
						}
					} else {
						number_of_blocks + (4 - (remainder))
					}
				};
				let permission = { format_permissions(metadata.file_attributes()) };
				let hard_links = 0;
				let user = 0;
				let group = 0;
				let size = metadata.file_size();
				let last_modified = {
					let system_time = metadata.modified().unwrap();
					let now_utc: DateTime<chrono::Utc> = system_time.into();
					now_utc.format("%b %e %H:%M")
				};
				let path = file_info.display_path().to_string_lossy();

				match write!(
					out,
					" {:<4} {:>6} {:<10} {:>3} {:<8} {:<8} {:>8} {} {}\n",
					inode_number,
					number_of_blocks,
					permission,
					hard_links,
					user,
					group,
					size,
					last_modified,
					path,
				) {
					Ok(_) => {},
					Err(e) => {
						if print_error_message {
							writeln!(
								&mut matcher_io.host().stderr,
								"Error writing {:?} for {}",
								file_info.display_path().to_string_lossy(),
								e
							)
							.unwrap();
							matcher_io.set_exit_code(1);
						}
					},
				}
			}
		}

		impl Matcher for Ls {
			fn matches(&self, file_info: &WalkEntry, matcher_io: &mut MatcherIO) -> bool {
				if let Some(file) = &self.output_file {
					self.print(file_info, matcher_io, file, true);
				} else {
					self.print(file_info, matcher_io, &mut *matcher_io.deps.get_output().borrow_mut(), false);
				}
				true
			}

			fn has_side_effects(&self) -> bool {
				true
			}
		}
	}
	mod name {
		// Copyright 2017 Google Inc.
		//
		// Use of this source code is governed by a MIT-style
		// license that can be found in the LICENSE file or at
		// https://opensource.org/licenses/MIT.

		use super::{Matcher, MatcherIO, WalkEntry, glob::Pattern};

		/// This matcher makes a comparison of the name against a shell wildcard
		/// pattern. See `glob::Pattern` for details on the exact syntax.
		pub struct NameMatcher {
			pattern: Pattern,
		}

		impl NameMatcher {
			pub fn new(pattern_string: &str, caseless: bool) -> Self {
				let pattern = Pattern::new(pattern_string, caseless);
				Self { pattern }
			}
		}

		impl Matcher for NameMatcher {
			fn matches(&self, file_info: &WalkEntry, _: &mut MatcherIO) -> bool {
				let name = file_info.file_name().to_string_lossy();

				#[cfg(unix)]
				if name.len() > 1 && name.chars().all(|x| x == '/') {
					self.pattern.matches("/")
				} else {
					self.pattern.matches(&name)
				}

				#[cfg(windows)]
				self.pattern.matches(&name)
			}
		}
	}
	mod path {
		// Copyright 2017 Google Inc.
		//
		// Use of this source code is governed by a MIT-style
		// license that can be found in the LICENSE file or at
		// https://opensource.org/licenses/MIT.

		use super::{Matcher, MatcherIO, WalkEntry, glob::Pattern};

		/// This matcher makes a comparison of the path against a shell wildcard
		/// pattern. See `glob::Pattern` for details on the exact syntax.
		pub struct PathMatcher {
			pattern: Pattern,
		}

		impl PathMatcher {
			pub fn new(pattern_string: &str, caseless: bool) -> Self {
				let pattern = Pattern::new(pattern_string, caseless);
				Self { pattern }
			}
		}

		impl Matcher for PathMatcher {
			fn matches(&self, file_info: &WalkEntry, _: &mut MatcherIO) -> bool {
				let path = file_info.display_path().to_string_lossy();
				self.pattern.matches(&path)
			}
		}
	}
	mod perm {
		// Copyright 2017 Google Inc.
		//
		// Use of this source code is governed by a MIT-style
		// license that can be found in the LICENSE file or at
		// https://opensource.org/licenses/MIT.

		//! find's permission matching uses a very unix-centric approach, that would
		//! be tricky to both implement and use on a windows platform. So we don't
		//! even try.

		use std::{error::Error, io::Write};

		#[cfg(unix)]
		use uucore::mode::{parse_numeric, parse_symbolic};

		use super::{Matcher, MatcherIO, WalkEntry};

		#[derive(Clone, Copy, Debug, Eq, PartialEq)]
		#[cfg(unix)]
		pub enum ComparisonType {
			/// mode bits have to match exactly
			Exact,
			/// all specified mode bits must be set. Others can be as well
			AtLeast,
			/// at least one of the specified bits must be set (or if no bits are
			/// specified then any mode will match)
			AnyOf,
		}

		#[cfg(unix)]
		impl ComparisonType {
			fn mode_bits_match(self, pattern: u32, value: u32) -> bool {
				match self {
					Self::Exact => (0o7777 & value) == pattern,
					Self::AtLeast => (value & pattern) == pattern,
					Self::AnyOf => pattern == 0 || (value & pattern) > 0,
				}
			}
		}

		#[cfg(unix)]
		mod parsing {
			use super::{ComparisonType, Error, parse_numeric, parse_symbolic};

			pub fn split_comparison_type(pattern: &str) -> (ComparisonType, &str) {
				let mut chars = pattern.chars();

				match chars.next() {
					Some('-') => (ComparisonType::AtLeast, chars.as_str()),
					// GNU spells "any of these bits" as /mode; BSD find spells
					// it +mode. Accept both.
					Some('/') | Some('+') => (ComparisonType::AnyOf, chars.as_str()),
					_ => (ComparisonType::Exact, pattern),
				}
			}

			pub fn parse_mode(pattern: &str, for_dir: bool) -> Result<u32, Box<dyn Error>> {
				let mode = if pattern.contains(|c: char| c.is_ascii_digit()) {
					parse_numeric(0, pattern, for_dir)?
				} else {
					let mut mode = 0;
					for chunk in pattern.split(',') {
						mode = parse_symbolic(mode, chunk, 0, for_dir)?;
					}
					mode
				};
				Ok(mode)
			}
		}

		#[cfg(unix)]
		#[derive(Debug)]
		pub struct PermMatcher {
			comparison_type: ComparisonType,
			file_pattern:    u32,
			dir_pattern:     u32,
		}

		#[cfg(not(unix))]
		pub struct PermMatcher {}

		impl PermMatcher {
			#[cfg(unix)]
			pub fn new(pattern: &str) -> Result<Self, Box<dyn Error>> {
				let (comparison_type, pattern) = parsing::split_comparison_type(pattern);
				let file_pattern = parsing::parse_mode(pattern, false)?;
				let dir_pattern = parsing::parse_mode(pattern, true)?;
				Ok(Self { comparison_type, file_pattern, dir_pattern })
			}

			#[cfg(not(unix))]
			pub fn new(_dummy_pattern: &str) -> Result<PermMatcher, Box<dyn Error>> {
				Err(From::from("Permission matching is not available on this platform"))
			}
		}

		impl Matcher for PermMatcher {
			#[cfg(unix)]
			fn matches(&self, file_info: &WalkEntry, matcher_io: &mut MatcherIO) -> bool {
				use std::os::unix::fs::PermissionsExt;
				match file_info.metadata() {
					Ok(metadata) => {
						let pattern = if metadata.is_dir() {
							self.dir_pattern
						} else {
							self.file_pattern
						};
						self
							.comparison_type
							.mode_bits_match(pattern, metadata.permissions().mode())
					},
					Err(e) => {
						writeln!(
							&mut matcher_io.host().stderr,
							"Error getting permissions for {}: {}",
							file_info.path().to_string_lossy(),
							e
						)
						.unwrap();
						false
					},
				}
			}

			#[cfg(not(unix))]
			fn matches(&self, _dummy_file_info: &WalkEntry, matcher_io: &mut MatcherIO) -> bool {
				writeln!(&mut matcher_io.host().stderr, "Permission matching not available on this platform!").unwrap();
				return false;
			}
		}
	}
	mod printer {
		// Copyright 2017 Google Inc.
		//
		// Use of this source code is governed by a MIT-style
		// license that can be found in the LICENSE file or at
		// https://opensource.org/licenses/MIT.

		use std::{fs::File, io::Write};


		use super::{Matcher, MatcherIO, WalkEntry};

		pub enum PrintDelimiter {
			Newline,
			Null,
		}

		impl std::fmt::Display for PrintDelimiter {
			fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
				match self {
					Self::Newline => writeln!(f),
					Self::Null => write!(f, "\0"),
				}
			}
		}

		/// This matcher just prints the name of the file to stdout.
		pub struct Printer {
			delimiter:   PrintDelimiter,
			output_file: Option<File>,
		}

		impl Printer {
			pub fn new(delimiter: PrintDelimiter, output_file: Option<File>) -> Self {
				Self { delimiter, output_file }
			}

			fn print(
				&self,
				file_info: &WalkEntry,
				matcher_io: &mut MatcherIO,
				mut out: impl Write,
				print_error_message: bool,
			) {
				match write!(out, "{}{}", file_info.display_path().to_string_lossy(), self.delimiter) {
					Ok(_) => {},
					Err(e) => {
						if print_error_message {
							writeln!(
								&mut matcher_io.host().stderr,
								"Error writing {:?} for {}",
								file_info.display_path().to_string_lossy(),
								e
							)
							.unwrap();
							matcher_io.set_exit_code(1);
						}
					},
				}
				out.flush().unwrap();
			}
		}

		impl Matcher for Printer {
			fn matches(&self, file_info: &WalkEntry, matcher_io: &mut MatcherIO) -> bool {
				if let Some(file) = &self.output_file {
					self.print(file_info, matcher_io, file, true);
				} else {
					self.print(file_info, matcher_io, &mut *matcher_io.deps.get_output().borrow_mut(), false);
				}
				true
			}

			fn has_side_effects(&self) -> bool {
				true
			}
		}
	}
	mod printf {
		// Copyright 2021 Collabora, Ltd.
		//
		// Use of this source code is governed by a MIT-style
		// license that can be found in the LICENSE file or at
		// https://opensource.org/licenses/MIT.

		#[cfg(unix)]
		use std::os::unix::prelude::MetadataExt;
		use std::{
			borrow::Cow,
			error::Error,
			fs::{self, File},
			io::Write,
			path::Path,
			time::SystemTime,
		};

		use chrono::{DateTime, Local, format::StrftimeItems};

		use super::{FileType, Matcher, MatcherIO, WalkEntry, WalkError};

		const STANDARD_BLOCK_SIZE: u64 = 512;

		#[derive(Debug, PartialEq, Eq)]
		enum Justify {
			Left,
			Right,
		}

		#[derive(Debug, PartialEq, Eq)]
		enum TimeFormat {
			/// Follow ctime(3).
			Ctime,
			/// Seconds since the epoch, as a float w/ nanosecond part.
			SinceEpoch,
			/// Follow strftime-compatible syntax
			Strftime(String),
		}

		impl TimeFormat {
			fn apply(&self, time: SystemTime) -> Result<Cow<'static, str>, Box<dyn Error>> {
				let formatted = match self {
					Self::SinceEpoch => {
						let duration = time.duration_since(SystemTime::UNIX_EPOCH)?;
						format!("{}.{:09}0", duration.as_secs(), duration.subsec_nanos())
					},
					Self::Ctime => {
						const CTIME_FORMAT: &str = "%a %b %d %H:%M:%S.%f0 %Y";

						DateTime::<Local>::from(time)
							.format(CTIME_FORMAT)
							.to_string()
					},
					Self::Strftime(format) => {
						// Handle a special case
						let custom_format = format.replace("%+", "%Y-%m-%d+%H:%M:%S%.f0");
						DateTime::<Local>::from(time)
							.format(&custom_format)
							.to_string()
					},
				};

				Ok(formatted.into())
			}
		}

		#[derive(Debug, PartialEq, Eq)]
		enum PermissionsFormat {
			Octal,
			// trwxrwxrwx
			Symbolic,
		}

		/// A single % directive in a format string.
		#[derive(Debug, PartialEq, Eq)]
		enum FormatDirective {
			// %a, %Ak
			AccessTime(TimeFormat),
			// %b, %k
			Blocks { large_blocks: bool },
			// %c, %Ck
			ChangeTime(TimeFormat),
			// %d
			Depth,
			// %D
			Device,
			// %f
			Basename,
			// %F
			Filesystem,
			// %g, %G
			Group { as_name: bool },
			// %h
			Dirname,
			// %H
			StartingPoint,
			// %i
			Inode,
			// %l
			SymlinkTarget,
			// %m
			Permissions(PermissionsFormat),
			// %n
			HardlinkCount,
			// %p, %P
			Path { strip_starting_point: bool },
			// %s
			Size,
			// %S
			Sparseness,
			// %t, %Tk
			ModificationTime(TimeFormat),
			// %u, %U
			User { as_name: bool },
			// %y, %Y
			Type { follow_links: bool },
		}

		/// A component in a full format string.
		#[derive(Debug, PartialEq, Eq)]
		enum FormatComponent {
			Literal(String),
			Flush,
			Directive { directive: FormatDirective, width: Option<usize>, justify: Justify },
		}

		struct FormatStringParser<'a> {
			string: &'a str,
		}

		impl FormatStringParser<'_> {
			fn front(&self) -> Result<char, Box<dyn Error>> {
				self
					.string
					.chars()
					.next()
					.ok_or_else(|| "Unexpected EOF".into())
			}

			fn peek(&self, count: usize) -> Result<&str, Box<dyn Error>> {
				if self.string.len() < count {
					return Err("Unexpected EOF".into());
				}

				Ok(&self.string[0..count])
			}

			fn advance_one(&mut self) -> Result<char, Box<dyn Error>> {
				let c = self.front()?;
				self.string = &self.string[1..];
				Ok(c)
			}

			fn advance_by(&mut self, count: usize) -> Result<&str, Box<dyn Error>> {
				self.peek(count)?;

				let skipped = &self.string[0..count];
				self.string = &self.string[count..];
				Ok(skipped)
			}

			fn parse_escape_sequence(&mut self) -> Result<FormatComponent, Box<dyn Error>> {
				const OCTAL_LEN: usize = 3;
				const OCTAL_RADIX: u32 = 8;

				// Try parsing an octal sequence first.
				let first = self.front()?;
				if first.is_digit(OCTAL_RADIX)
					&& let Ok(code) = self.peek(OCTAL_LEN).and_then(|octal| {
						u32::from_str_radix(octal, OCTAL_RADIX).map_err(std::convert::Into::into)
					}) {
					// safe to unwrap: .peek() already succeeded above.
					let octal = self.advance_by(OCTAL_LEN).unwrap();
					return match char::from_u32(code) {
						Some(c) => Ok(FormatComponent::Literal(c.to_string())),
						None => Err(format!("Invalid character value: \\{octal}").into()),
					};
				}

				self.advance_one()?;

				if first == 'c' {
					Ok(FormatComponent::Flush)
				} else {
					let c = match first {
						'a' => "\x07",
						'b' => "\x08",
						'f' => "\x0C",
						'n' => "\n",
						'r' => "\r",
						't' => "\t",
						'v' => "\x0B",
						'0' => "\0",
						'\\' => "\\",
						c => return Err(format!("Invalid escape sequence: \\{c}").into()),
					};

					Ok(FormatComponent::Literal(c.to_string()))
				}
			}

			fn parse_format_width(&mut self) -> Option<usize> {
				let start = self.string;
				let mut digits = 0;

				while self.front().map(|c| c.is_ascii_digit()).unwrap_or(false) {
					digits += 1;
					// safe to unwrap: the front() check already succeeded above.
					self.advance_one().unwrap();
				}

				if digits > 0 {
					// safe to unwrap: we already know all the digits are valid due to
					// the above checks.
					Some((start[0..digits]).parse().unwrap())
				} else {
					None
				}
			}

			fn parse_time_specifier(&mut self, first: char) -> Result<TimeFormat, Box<dyn Error>> {
				match self.advance_one()? {
					'@' => Ok(TimeFormat::SinceEpoch),
					'S' => Ok(TimeFormat::Strftime("%S.%f0".to_string())),
					c => {
						// We can't store the parsed items inside TimeFormat, because the items
						// take a reference to the full format string, but we still try to parse
						// it here so that errors get caught early.
						let format = format!("%{c}");
						match StrftimeItems::new(&format).next() {
							None | Some(chrono::format::Item::Error) => {
								Err(format!("Invalid time specifier: %{first}{c}").into())
							},
							Some(_item) => Ok(TimeFormat::Strftime(format)),
						}
					},
				}
			}

			fn parse_format_specifier(&mut self) -> Result<FormatComponent, Box<dyn Error>> {
				let mut justify = Justify::Right;
				loop {
					match self.front()? {
						' ' => (),
						'-' => justify = Justify::Left,
						_ => break,
					}

					// safe to unwrap: .front() already succeeded above.
					self.advance_one().unwrap();
				}

				let width = self.parse_format_width();

				let first = self.advance_one()?;
				if first == '%' {
					return Ok(FormatComponent::Literal("%".to_owned()));
				}

				let directive = match first {
					'a' => FormatDirective::AccessTime(TimeFormat::Ctime),
					'A' => FormatDirective::AccessTime(self.parse_time_specifier(first)?),
					'b' => FormatDirective::Blocks { large_blocks: false },
					'c' => FormatDirective::ChangeTime(TimeFormat::Ctime),
					'C' => FormatDirective::ChangeTime(self.parse_time_specifier(first)?),
					'd' => FormatDirective::Depth,
					'D' => FormatDirective::Device,
					'f' => FormatDirective::Basename,
					'F' => FormatDirective::Filesystem,
					'g' => FormatDirective::Group { as_name: true },
					'G' => FormatDirective::Group { as_name: false },
					'h' => FormatDirective::Dirname,
					'H' => FormatDirective::StartingPoint,
					'k' => FormatDirective::Blocks { large_blocks: true },
					'i' => FormatDirective::Inode,
					'l' => FormatDirective::SymlinkTarget,
					'm' => FormatDirective::Permissions(PermissionsFormat::Octal),
					'M' => FormatDirective::Permissions(PermissionsFormat::Symbolic),
					'n' => FormatDirective::HardlinkCount,
					'p' => FormatDirective::Path { strip_starting_point: false },
					'P' => FormatDirective::Path { strip_starting_point: true },
					's' => FormatDirective::Size,
					'S' => FormatDirective::Sparseness,
					't' => FormatDirective::ModificationTime(TimeFormat::Ctime),
					'T' => FormatDirective::ModificationTime(self.parse_time_specifier(first)?),
					'u' => FormatDirective::User { as_name: true },
					'U' => FormatDirective::User { as_name: false },
					'y' => FormatDirective::Type { follow_links: false },
					'Y' => FormatDirective::Type { follow_links: true },
					// TODO: %Z
					_ => return Ok(FormatComponent::Literal(first.to_string())),
				};

				Ok(FormatComponent::Directive { directive, width, justify })
			}

			pub fn parse(&mut self) -> Result<FormatString, Box<dyn Error>> {
				let mut components = vec![];

				while let Some(i) = self.string.find(['%', '\\']) {
					if i > 0 {
						// safe to unwrap: i is an index into the string, so it cannot
						// be any shorter.
						let literal = self.advance_by(i).unwrap();
						if !literal.is_empty() {
							components.push(FormatComponent::Literal(literal.to_owned()));
						}
					}

					// safe to unwrap: we've only advanced as far as 'i', which is right
					// before the character it identified.
					let component = match self.advance_one().unwrap() {
						'\\' => self.parse_escape_sequence()?,
						'%' => self.parse_format_specifier()?,
						_ => panic!("{}", "Stopped at unexpected character: {self.string}"),
					};
					components.push(component);
				}

				if !self.string.is_empty() {
					components.push(FormatComponent::Literal(self.string.to_owned()));
				}

				Ok(FormatString { components })
			}
		}

		struct FormatString {
			components: Vec<FormatComponent>,
		}

		impl FormatString {
			fn parse(string: &str) -> Result<Self, Box<dyn Error>> {
				FormatStringParser { string }.parse()
			}
		}

		fn get_starting_point(file_info: &WalkEntry) -> &Path {
			file_info
				.display_path()
				.ancestors()
				.nth(file_info.depth())
				// safe to unwrap: the file's depth should never be longer than its path
				// (...right?).
				.unwrap()
		}

		fn format_non_link_file_type(file_type: FileType) -> char {
			match file_type {
				FileType::Regular => 'f',
				FileType::Directory => 'd',
				FileType::BlockDevice => 'b',
				FileType::CharDevice => 'c',
				FileType::Fifo => 'p',
				FileType::Socket => 's',
				_ => 'U',
			}
		}

		fn format_directive<'entry>(
			file_info: &'entry WalkEntry,
			directive: &FormatDirective,
		) -> Result<Cow<'entry, str>, Box<dyn Error>> {
			let meta = || file_info.metadata();

			// NOTE ON QUOTING:
			// GNU find's man page claims that several directives that print names (like
			// %f) are quoted like ls; however, I could not reproduce this at all in
			// practice, thus the set of rules is undoubtedly very different (if this is
			// still done at all).

			let res: Cow<'entry, str> = match directive {
				FormatDirective::AccessTime(tf) => tf.apply(meta()?.accessed()?)?,

				FormatDirective::Basename => file_info.file_name().to_string_lossy(),

				FormatDirective::Blocks { large_blocks } => {
					#[cfg(unix)]
					let blocks = meta()?.blocks();
					#[cfg(not(unix))]
					// Estimate using a ceiling division by the block size.
					let blocks = (meta()?.len() + STANDARD_BLOCK_SIZE - 1) / STANDARD_BLOCK_SIZE;

					// GNU find says it returns the number of 512-byte blocks for %b,
					// but in reality it just returns the number of blocks, *regardless
					// of their size on the filesystem*. That behavior is copied here,
					// even though it's arguably not 100% correct.
					if *large_blocks {
						// Ceiling divide in half.
						blocks.div_ceil(2)
					} else {
						blocks
					}
					.to_string()
					.into()
				},

				#[cfg(not(unix))]
				FormatDirective::ChangeTime(tf) => tf.apply(meta()?.modified()?)?,
				#[cfg(unix)]
				FormatDirective::ChangeTime(tf) => {
					use std::time::Duration;

					let meta = meta()?;
					let ctime = SystemTime::UNIX_EPOCH
						+ Duration::from_secs(meta.ctime() as u64)
						+ Duration::from_nanos(meta.ctime_nsec() as u64);
					tf.apply(ctime)?
				},

				FormatDirective::Depth => file_info.depth().to_string().into(),

				#[cfg(not(unix))]
				FormatDirective::Device => "0".into(),
				#[cfg(unix)]
				FormatDirective::Device => meta()?.dev().to_string().into(),

				// GNU find's behavior for this is a bit...odd:
				// - Both the root directory and the paths immediately underneath return an empty string
				// - Any path without any slashes (i.e. relative to cwd) returns "."
				// - "." also returns "."
				// - ".." returns "." (???)
				// These are all (thankfully) documented on the find(1) man page.
				FormatDirective::Dirname => match file_info.display_path().parent() {
					None => "".into(),
					Some(p) if p == Path::new("/") => "".into(),
					Some(p) if p == Path::new("") => ".".into(),
					Some(parent) => parent.to_string_lossy(),
				},

				#[cfg(not(unix))]
				FormatDirective::Filesystem => "".into(),
				#[cfg(unix)]
				FormatDirective::Filesystem => {
					let dev_id = meta()?.dev().to_string();
					let fs_list = uucore::fsext::read_fs_list().expect("Could not find the filesystem info");
					fs_list
						.into_iter()
						.find(|fs| fs.dev_id == dev_id)
						.map_or_else(String::new, |fs| fs.fs_type)
						.into()
				},

				#[cfg(not(unix))]
				FormatDirective::Group { .. } => "0".into(),
				#[cfg(unix)]
				FormatDirective::Group { as_name } => {
					let gid = meta()?.gid();
					if *as_name {
						uucore::entries::gid2grp(gid).unwrap_or_else(|_| gid.to_string())
					} else {
						gid.to_string()
					}
					.into()
				},

				#[cfg(not(unix))]
				FormatDirective::HardlinkCount => "0".into(),
				#[cfg(unix)]
				FormatDirective::HardlinkCount => meta()?.nlink().to_string().into(),

				#[cfg(not(unix))]
				FormatDirective::Inode => "0".into(),
				#[cfg(unix)]
				FormatDirective::Inode => meta()?.ino().to_string().into(),

				FormatDirective::ModificationTime(tf) => tf.apply(meta()?.modified()?)?,

				FormatDirective::Path { strip_starting_point } => file_info
					.display_path()
					.strip_prefix(if *strip_starting_point {
						get_starting_point(file_info)
					} else {
						Path::new("")
					})
					// safe to unwrap: the prefix is derived *from* the path to begin
					// with, so it cannot be invalid.
					.unwrap()
					.to_string_lossy(),

				FormatDirective::Permissions(PermissionsFormat::Symbolic) => {
					uucore::fs::display_permissions(meta()?, true).into()
				},
				#[cfg(not(unix))]
				FormatDirective::Permissions(PermissionsFormat::Octal) => "777".into(),
				#[cfg(unix)]
				FormatDirective::Permissions(PermissionsFormat::Octal) => {
					format!("{:>03o}", meta()?.mode() & 0o777).into()
				},

				FormatDirective::Size => meta()?.len().to_string().into(),

				#[cfg(not(unix))]
				FormatDirective::Sparseness => "1.0".into(),
				#[cfg(unix)]
				FormatDirective::Sparseness => {
					let meta = meta()?;

					if meta.len() > 0 {
						format!(
							"{:.1}",
							// GNU find hardcodes a block size of 512 bytes, regardless
							// of the true filesystem block size.
							(meta.blocks() * STANDARD_BLOCK_SIZE) as f64 / (meta.len() as f64)
						)
						.into()
					} else {
						"1.0".into()
					}
				},

				FormatDirective::StartingPoint => get_starting_point(file_info).to_string_lossy(),

				FormatDirective::SymlinkTarget => {
					if file_info.path_is_symlink() {
						fs::read_link(file_info.path())?
							.to_string_lossy()
							.into_owned()
							.into()
					} else {
						"".into()
					}
				},

				FormatDirective::Type { follow_links } => if file_info.path_is_symlink() {
					if *follow_links {
						match file_info.path().metadata().map_err(WalkError::from) {
							Ok(meta) => format_non_link_file_type(meta.file_type().into()),
							Err(e) if e.is_not_found() => 'N',
							Err(e) if e.is_loop() => 'L',
							Err(_) => '?',
						}
					} else {
						'l'
					}
				} else {
					format_non_link_file_type(file_info.file_type())
				}
				.to_string()
				.into(),

				#[cfg(not(unix))]
				FormatDirective::User { .. } => "0".into(),
				#[cfg(unix)]
				FormatDirective::User { as_name } => {
					let uid = meta()?.uid();
					if *as_name {
						uucore::entries::uid2usr(uid).unwrap_or_else(|_| uid.to_string())
					} else {
						uid.to_string()
					}
					.into()
				},
			};

			Ok(res)
		}

		/// This matcher prints information about its files to stdout, following GNU
		/// find's printf syntax.
		pub struct Printf {
			format:      FormatString,
			output_file: Option<File>,
		}

		impl Printf {
			pub fn new(format: &str, output_file: Option<File>) -> Result<Self, Box<dyn Error>> {
				Ok(Self { format: FormatString::parse(format)?, output_file })
			}

			fn print(&self, file_info: &WalkEntry, mut out: impl Write, mut err: impl Write) {
				for component in &self.format.components {
					match component {
						FormatComponent::Literal(literal) => write!(out, "{literal}").unwrap(),
						FormatComponent::Flush => out.flush().unwrap(),
						FormatComponent::Directive { directive, width, justify } => {
							match format_directive(file_info, directive) {
								Ok(content) => {
									if let Some(width) = width {
										match justify {
											Justify::Left => {
												write!(out, "{content:<width$}").unwrap();
											},
											Justify::Right => {
												write!(out, "{content:>width$}").unwrap();
											},
										}
									} else {
										write!(out, "{content}").unwrap();
									}
								},
								Err(e) => {
									let _ = writeln!(
										err,
										"Error processing '{}': {}",
										file_info.path().to_string_lossy(),
										e
									);
									break;
								},
							}
						},
					}
				}
			}
		}

		impl Matcher for Printf {
			fn matches(&self, file_info: &WalkEntry, matcher_io: &mut MatcherIO) -> bool {
				let err = matcher_io.host().stderr_clone();
				if let Some(file) = &self.output_file {
					self.print(file_info, file, err);
				} else {
					self.print(file_info, &mut *matcher_io.deps.get_output().borrow_mut(), err);
				}

				true
			}

			fn has_side_effects(&self) -> bool {
				true
			}
		}
	}
	mod prune {
		// Copyright 2017 Google Inc.
		//
		// Use of this source code is governed by a MIT-style
		// license that can be found in the LICENSE file or at
		// https://opensource.org/licenses/MIT.

		use super::{Matcher, MatcherIO, WalkEntry};

		/// This matcher checks the type of the file.
		pub struct PruneMatcher;

		impl PruneMatcher {
			pub fn new() -> Self {
				Self {}
			}
		}

		impl Matcher for PruneMatcher {
			fn matches(&self, file_info: &WalkEntry, matcher_io: &mut MatcherIO) -> bool {
				if file_info.file_type().is_dir() {
					matcher_io.mark_current_dir_to_be_skipped();
				}

				true
			}
		}
	}
	mod quit {
		// Copyright 2017 Tavian Barnes
		//
		// Use of this source code is governed by a MIT-style
		// license that can be found in the LICENSE file or at
		// https://opensource.org/licenses/MIT.

		use super::{Matcher, MatcherIO, WalkEntry};

		/// This matcher quits the search immediately.
		pub struct QuitMatcher;

		impl Matcher for QuitMatcher {
			fn matches(&self, _: &WalkEntry, matcher_io: &mut MatcherIO) -> bool {
				matcher_io.quit();
				true
			}
		}
	}
	mod regex {
		// Copyright 2022 Collabora, Ltd.
		//
		// Use of this source code is governed by a MIT-style
		// license that can be found in the LICENSE file or at
		// https://opensource.org/licenses/MIT.

		use std::{error::Error, fmt, str::FromStr};

		use onig::{Regex, RegexOptions, SearchOptions, Syntax};

		use super::{Matcher, MatcherIO, WalkEntry};

		#[derive(Debug)]
		pub struct ParseRegexTypeError(String);

		impl Error for ParseRegexTypeError {}

		impl fmt::Display for ParseRegexTypeError {
			fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
				write!(
					f,
					"Invalid regex type: {} (must be one of {})",
					self.0,
					RegexType::VALUES
						.iter()
						.map(|t| format!("'{t}'"))
						.collect::<Vec<_>>()
						.join(", ")
				)
			}
		}

		#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
		pub enum RegexType {
			#[default]
			Emacs,
			Grep,
			PosixBasic,
			PosixExtended,
		}

		impl RegexType {
			pub const VALUES: &'static [Self] =
				&[Self::Emacs, Self::Grep, Self::PosixBasic, Self::PosixExtended];
		}

		impl fmt::Display for RegexType {
			fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
				match self {
					Self::Emacs => write!(f, "emacs"),
					Self::Grep => write!(f, "grep"),
					Self::PosixBasic => write!(f, "posix-basic"),
					Self::PosixExtended => write!(f, "posix-extended"),
				}
			}
		}

		impl FromStr for RegexType {
			type Err = ParseRegexTypeError;

			fn from_str(s: &str) -> Result<Self, Self::Err> {
				match s {
					"emacs" => Ok(Self::Emacs),
					"grep" => Ok(Self::Grep),
					"posix-basic" => Ok(Self::PosixBasic),
					"posix-extended" => Ok(Self::PosixExtended),
					// ed and sed are the same as posix-basic
					"ed" | "sed" => Ok(Self::PosixBasic),
					_ => Err(ParseRegexTypeError(s.to_owned())),
				}
			}
		}

		pub struct RegexMatcher {
			regex: Regex,
		}

		impl RegexMatcher {
			pub fn new(
				regex_type: RegexType,
				pattern: &str,
				ignore_case: bool,
			) -> Result<Self, Box<dyn Error>> {
				let syntax = match regex_type {
					RegexType::Emacs => Syntax::emacs(),
					RegexType::Grep => Syntax::grep(),
					RegexType::PosixBasic => Syntax::posix_basic(),
					RegexType::PosixExtended => Syntax::posix_extended(),
				};

				let regex = Regex::with_options(
					pattern,
					if ignore_case {
						RegexOptions::REGEX_OPTION_IGNORECASE
					} else {
						RegexOptions::REGEX_OPTION_NONE
					},
					syntax,
				)?;
				Ok(Self { regex })
			}
		}

		impl Matcher for RegexMatcher {
			fn matches(&self, file_info: &WalkEntry, _: &mut MatcherIO) -> bool {
				let path = file_info.display_path().to_string_lossy();
				// `-regex` must match the WHOLE path (POSIX/GNU/BSD), not a
				// substring: anchor the match at the start of the path and
				// require it to end at the end of the path (backtracking
				// retries alternatives that stop short).
				self
					.regex
					.match_with_options(path.as_ref(), 0, SearchOptions::SEARCH_OPTION_WHOLE_STRING, None)
					.is_some()
			}
		}
	}
	mod samefile {
		// This file is part of the uutils findutils package.
		//
		// For the full copyright and license information, please view the LICENSE
		// file that was distributed with this source code.

		use std::{error::Error, path::Path};

		use uucore::fs::FileInformation;

		use super::{Follow, Matcher, MatcherIO, WalkEntry, WalkError};
		use crate::host::Host;

		pub struct SameFileMatcher {
			info: FileInformation,
		}

		/// Gets FileInformation, possibly following symlinks, but falling back on
		/// broken links.
		fn get_file_info(path: &Path, follow: bool) -> Result<FileInformation, WalkError> {
			if follow {
				let result = FileInformation::from_path(path, true).map_err(WalkError::from);

				match result {
					Ok(info) => return Ok(info),
					Err(e) if !e.is_not_found() => return Err(e),
					_ => {},
				}
			}

			Ok(FileInformation::from_path(path, false)?)
		}

		impl SameFileMatcher {
			pub fn new(path: impl AsRef<Path>, follow: Follow, host: &Host) -> Result<Self, Box<dyn Error>> {
				let info = get_file_info(&host.resolve(path.as_ref()), follow != Follow::Never)?;
				Ok(Self { info })
			}
		}

		impl Matcher for SameFileMatcher {
			fn matches(&self, file_info: &WalkEntry, _matcher_io: &mut MatcherIO) -> bool {
				if let Ok(info) = get_file_info(file_info.path(), file_info.follow()) {
					info == self.info
				} else {
					false
				}
			}
		}
	}
	mod size {
		// Copyright 2017 Google Inc.
		//
		// Use of this source code is governed by a MIT-style
		// license that can be found in the LICENSE file or at
		// https://opensource.org/licenses/MIT.

		use std::{error::Error, io::Write, str::FromStr};


		use super::{ComparableValue, Matcher, MatcherIO, WalkEntry};

		#[derive(Clone, Copy, Debug)]
		enum Unit {
			Byte,
			TwoByteWord,
			Block,
			KibiByte,
			MebiByte,
			GibiByte,
			TebiByte,
			PebiByte,
		}

		impl FromStr for Unit {
			type Err = Box<dyn Error>;

			fn from_str(s: &str) -> Result<Self, Box<dyn Error>> {
				Ok(match s {
					"c" => Self::Byte,
					"w" => Self::TwoByteWord,
					"" | "b" => Self::Block,
					"k" => Self::KibiByte,
					"M" => Self::MebiByte,
					"G" => Self::GibiByte,
					"T" => Self::TebiByte,
					"P" => Self::PebiByte,
					_ => {
						return Err(From::from(format!(
							"Invalid suffix {s} for -size. Only allowed values are <nothing>, b, c, w, k, M, G, \
							 T or P"
						)));
					},
				})
			}
		}

		fn byte_size_to_unit_size(unit: Unit, byte_size: u64) -> u64 {
			// Short circuit (to avoid a overflow error when subtracting 1 later on)
			if byte_size == 0 {
				return 0;
			}
			let bits_to_shift = match unit {
				Unit::Byte => 0,
				Unit::TwoByteWord => 1,
				Unit::Block => 9,
				Unit::KibiByte => 10,
				Unit::MebiByte => 20,
				Unit::GibiByte => 30,
				Unit::TebiByte => 40,
				Unit::PebiByte => 50,
			};
			// Skip pointless arithmetic.
			if bits_to_shift == 0 {
				return byte_size;
			}
			// We want to round up (e.g. 1 byte - 1024 bytes = 1k.
			// 1025 bytes to 2048 bytes = 2k etc.
			((byte_size - 1) >> bits_to_shift) + 1
		}

		/// Matcher that checks whether a file's size if {less than | equal to | more
		/// than} N units in size.
		pub struct SizeMatcher {
			value_to_match: ComparableValue,
			unit:           Unit,
		}

		impl SizeMatcher {
			pub fn new(
				value_to_match: ComparableValue,
				suffix_string: &str,
			) -> Result<Self, Box<dyn Error>> {
				Ok(Self { unit: suffix_string.parse()?, value_to_match })
			}
		}

		impl Matcher for SizeMatcher {
			fn matches(&self, file_info: &WalkEntry, matcher_io: &mut MatcherIO) -> bool {
				match file_info.metadata() {
					Ok(metadata) => self
						.value_to_match
						.matches(byte_size_to_unit_size(self.unit, metadata.len())),
					Err(e) => {
						writeln!(
							&mut matcher_io.host().stderr,
							"Error getting file size for {}: {}",
							file_info.path().to_string_lossy(),
							e
						)
						.unwrap();
						false
					},
				}
			}
		}
	}
	#[cfg(unix)]
	mod stat {
		// Copyright 2022 Tavian Barnes
		//
		// Use of this source code is governed by a MIT-style
		// license that can be found in the LICENSE file or at
		// https://opensource.org/licenses/MIT.

		use std::os::unix::fs::MetadataExt;

		use super::{ComparableValue, Matcher, MatcherIO, WalkEntry};

		/// Inode number matcher.
		pub struct InodeMatcher {
			ino: ComparableValue,
		}

		impl InodeMatcher {
			pub fn new(ino: ComparableValue) -> Self {
				Self { ino }
			}
		}

		impl Matcher for InodeMatcher {
			fn matches(&self, file_info: &WalkEntry, _: &mut MatcherIO) -> bool {
				match file_info.metadata() {
					Ok(metadata) => self.ino.matches(metadata.ino()),
					Err(_) => false,
				}
			}
		}

		/// Link count matcher.
		pub struct LinksMatcher {
			nlink: ComparableValue,
		}

		impl LinksMatcher {
			pub fn new(nlink: ComparableValue) -> Self {
				Self { nlink }
			}
		}

		impl Matcher for LinksMatcher {
			fn matches(&self, file_info: &WalkEntry, _: &mut MatcherIO) -> bool {
				match file_info.metadata() {
					Ok(metadata) => self.nlink.matches(metadata.nlink()),
					Err(_) => false,
				}
			}
		}
	}
	pub mod time {
		// Copyright 2017 Google Inc.
		//
		// Use of this source code is governed by a MIT-style
		// license that can be found in the LICENSE file or at
		// https://opensource.org/licenses/MIT.

		#[cfg(unix)]
		use std::os::unix::fs::MetadataExt;
		use std::{
			error::Error,
			fs::{self, Metadata},
			io::Write,
			time::{Duration, SystemTime, UNIX_EPOCH},
		};

		use chrono::{DateTime, Local, Timelike};

		use super::{ComparableValue, Follow, Matcher, MatcherIO, WalkEntry};
		use crate::host::Host;

		const SECONDS_PER_DAY: i64 = 60 * 60 * 24;

		fn get_time(matcher_io: &mut MatcherIO, today_start: bool) -> SystemTime {
			if today_start {
				// the time at 00:00:00 of today
				let duration_since_unix_epoch = matcher_io.now().duration_since(UNIX_EPOCH).unwrap();
				let seconds_since_unix_epoch = duration_since_unix_epoch.as_secs();
				let utc_time = DateTime::from_timestamp(seconds_since_unix_epoch as i64, 0).unwrap();
				let local_time = utc_time.with_timezone(&Local);
				let seconds_since_last_midnight = local_time.num_seconds_from_midnight();
				let local_midnight_seconds = local_time.timestamp() - seconds_since_last_midnight as i64;

				UNIX_EPOCH + Duration::from_secs(local_midnight_seconds as u64)
			} else {
				matcher_io.now()
			}
		}

		/// This matcher checks whether a file is newer than the file the matcher is
		/// initialized with.
		pub struct NewerMatcher {
			given_modification_time: SystemTime,
		}

		impl NewerMatcher {
			pub fn new(path_to_file: &str, follow: Follow, host: &Host) -> Result<Self, Box<dyn Error>> {
				let metadata = follow.root_metadata(host.resolve(path_to_file))?;
				Ok(Self { given_modification_time: metadata.modified()? })
			}

			/// Implementation of matches that returns a result, allowing use to use try!
			/// to deal with the errors.
			fn matches_impl(&self, file_info: &WalkEntry) -> Result<bool, Box<dyn Error>> {
				let this_time = file_info.metadata()?.modified()?;
				// duration_since returns an Ok duration if this_time <= given_modification_time
				// and returns an Err (with a duration) otherwise. So if this_time >
				// given_modification_time (in which case we want to return true) then
				// duration_since will return an error.
				Ok(self
					.given_modification_time
					.duration_since(this_time)
					.is_err())
			}
		}

		impl Matcher for NewerMatcher {
			fn matches(&self, file_info: &WalkEntry, matcher_io: &mut MatcherIO) -> bool {
				match self.matches_impl(file_info) {
					Err(e) => {
						writeln!(
							&mut matcher_io.host().stderr,
							"Error getting modification time for {}: {}",
							file_info.path().to_string_lossy(),
							e
						)
						.unwrap();
						false
					},
					Ok(t) => t,
				}
			}
		}

		/// `-newerXY` option.
		/// a is meaning Accessed time
		/// B is meaning Birthed time
		/// c is meaning Changed time
		/// m is meaning Modified time
		/// It should be noted that not every file system supports birthed time.
		#[derive(Clone, Copy, Debug)]
		pub enum NewerOptionType {
			Accessed,
			Birthed,
			Changed,
			Modified,
		}

		impl NewerOptionType {
			#[allow(clippy::should_implement_trait)]
			pub fn from_str(option: &str) -> Self {
				match option {
					"a" => Self::Accessed,
					"B" => Self::Birthed,
					"c" => Self::Changed,
					_ => Self::Modified,
				}
			}

			fn get_file_time(self, metadata: &Metadata) -> std::io::Result<SystemTime> {
				match self {
					Self::Accessed => metadata.accessed(),
					Self::Birthed => metadata.created(),
					Self::Changed => metadata.changed(),
					Self::Modified => metadata.modified(),
				}
			}
		}

		/// This matcher checks whether the X timestamp of the file being
		/// considered is newer than the Y timestamp of the reference file,
		/// captured once when the matcher is built (`-newerXY reference`).
		pub struct NewerOptionMatcher {
			x_option:       NewerOptionType,
			reference_time: SystemTime,
		}

		impl NewerOptionMatcher {
			pub fn new(x_option: &str, y_option: &str, path_to_file: &str, host: &Host) -> Result<Self, Box<dyn Error>> {
				let metadata = fs::metadata(host.resolve(path_to_file))?;
				let x_option = NewerOptionType::from_str(x_option);
				let y_option = NewerOptionType::from_str(y_option);
				let reference_time = y_option.get_file_time(&metadata)?;
				Ok(Self { x_option, reference_time })
			}

			fn matches_impl(&self, file_info: &WalkEntry) -> Result<bool, Box<dyn Error>> {
				let x_option_time = self.x_option.get_file_time(file_info.metadata()?)?;

				// duration_since returns Err when x_option_time is strictly
				// newer than the reference time.
				Ok(self
					.reference_time
					.duration_since(x_option_time)
					.is_err())
			}
		}

		impl Matcher for NewerOptionMatcher {
			fn matches(&self, file_info: &WalkEntry, matcher_io: &mut MatcherIO) -> bool {
				match self.matches_impl(file_info) {
					Err(e) => {
						writeln!(
							&mut matcher_io.host().stderr,
							"Error getting {:?} time for {}: {}",
							self.x_option,
							file_info.path().to_string_lossy(),
							e
						)
						.unwrap();
						false
					},
					Ok(t) => t,
				}
			}
		}

		/// This matcher checks whether files's accessed|creation|modification time is
		/// newer than the given times.
		pub struct NewerTimeMatcher {
			time:            i64,
			newer_time_type: NewerOptionType,
		}

		impl NewerTimeMatcher {
			pub fn new(newer_time_type: NewerOptionType, time: i64) -> Self {
				Self { time, newer_time_type }
			}

			fn matches_impl(&self, file_info: &WalkEntry) -> Result<bool, Box<dyn Error>> {
				let this_time = self.newer_time_type.get_file_time(file_info.metadata()?)?;
				let timestamp = this_time
					.duration_since(UNIX_EPOCH)
					.unwrap_or_else(|e| e.duration());

				// timestamp.as_millis() return u128 but time is i64
				// This may leave memory implications. :(
				Ok(self.time
					<= timestamp
						.as_millis()
						.try_into()
						.expect("timestamp memory implications"))
			}
		}

		impl Matcher for NewerTimeMatcher {
			fn matches(&self, file_info: &WalkEntry, matcher_io: &mut MatcherIO) -> bool {
				match self.matches_impl(file_info) {
					Err(e) => {
						writeln!(
							&mut matcher_io.host().stderr,
							"Error getting {:?} time for {}: {}",
							self.newer_time_type,
							file_info.path().to_string_lossy(),
							e
						)
						.unwrap();
						false
					},
					Ok(t) => t,
				}
			}
		}

		/// Provide access to the *change* timestamp, since std::fs::Metadata doesn't
		/// expose it.
		pub trait ChangeTime {
			/// Returns the time of the last change to the metadata.
			fn changed(&self) -> std::io::Result<SystemTime>;
		}

		#[cfg(unix)]
		impl ChangeTime for Metadata {
			fn changed(&self) -> std::io::Result<SystemTime> {
				let ctime_sec = self.ctime();
				let ctime_nsec = self.ctime_nsec() as u32;
				let ctime = if ctime_sec >= 0 {
					UNIX_EPOCH + std::time::Duration::new(ctime_sec as u64, ctime_nsec)
				} else {
					UNIX_EPOCH - std::time::Duration::new(-ctime_sec as u64, ctime_nsec)
				};
				Ok(ctime)
			}
		}

		#[cfg(not(unix))]
		impl ChangeTime for Metadata {
			fn changed(&self) -> std::io::Result<SystemTime> {
				// Rust's stdlib doesn't (yet) expose ChangeTime on Windows
				// https://github.com/rust-lang/rust/issues/121478
				Err(std::io::Error::from(std::io::ErrorKind::Unsupported))
			}
		}

		#[derive(Clone, Copy, Debug)]
		pub enum FileTimeType {
			Accessed,
			Changed,
			Modified,
		}

		impl FileTimeType {
			fn get_file_time(self, metadata: &Metadata) -> std::io::Result<SystemTime> {
				match self {
					Self::Accessed => metadata.accessed(),
					Self::Changed => metadata.changed(),
					Self::Modified => metadata.modified(),
				}
			}
		}

		/// This matcher checks whether a file's accessed|creation|modification time is
		/// {less than | exactly | more than} N days old.
		pub struct FileTimeMatcher {
			days:           ComparableValue,
			file_time_type: FileTimeType,
			today_start:    bool,
		}

		impl Matcher for FileTimeMatcher {
			fn matches(&self, file_info: &WalkEntry, matcher_io: &mut MatcherIO) -> bool {
				let start_time = get_time(matcher_io, self.today_start);
				match self.matches_impl(file_info, start_time) {
					Err(e) => {
						writeln!(
							&mut matcher_io.host().stderr,
							"Error getting {:?} time for {}: {}",
							self.file_time_type,
							file_info.path().to_string_lossy(),
							e
						)
						.unwrap();
						false
					},
					Ok(t) => t,
				}
			}
		}

		impl FileTimeMatcher {
			/// Implementation of matches that returns a result, allowing use to use try!
			/// to deal with the errors.
			fn matches_impl(
				&self,
				file_info: &WalkEntry,
				start_time: SystemTime,
			) -> Result<bool, Box<dyn Error>> {
				let this_time = self.file_time_type.get_file_time(file_info.metadata()?)?;
				let mut is_negative = false;
				// durations can't be negative. So duration_since returns a duration
				// wrapped in an error if now < this_time.
				let age = match start_time.duration_since(this_time) {
					Ok(duration) => duration,
					Err(e) => {
						is_negative = true;
						e.duration()
					},
				};
				let age_in_seconds: i64 = age.as_secs() as i64 * if is_negative { -1 } else { 1 };

				// rust division truncates towards zero (see
				// https://github.com/rust-lang/rust/blob/master/src/libcore/ops.rs#L580 )
				// so a simple age_in_seconds / SECONDS_PER_DAY gives the wrong answer
				// for negative ages: a file whose age is 1 second in the future needs to
				// count as -1 day old, not 0.
				// If today_start is true, we should count it as 0 days old.
				// because today is 00:00:00, so we need to subtract 1 day.
				let negative_offset = if is_negative && !self.today_start {
					-1
				} else {
					0
				};

				let age_in_days = age_in_seconds / SECONDS_PER_DAY + negative_offset;
				Ok(self.days.imatches(age_in_days))
			}

			pub fn new(file_time_type: FileTimeType, days: ComparableValue, today_start: bool) -> Self {
				Self { days, file_time_type, today_start }
			}
		}

		pub struct FileAgeRangeMatcher {
			minutes:        ComparableValue,
			file_time_type: FileTimeType,
			today_start:    bool,
		}

		impl Matcher for FileAgeRangeMatcher {
			fn matches(&self, file_info: &WalkEntry, matcher_io: &mut MatcherIO) -> bool {
				let start_time = get_time(matcher_io, self.today_start);
				match self.matches_impl(file_info, start_time) {
					Err(e) => {
						writeln!(
							&mut matcher_io.host().stderr,
							"Error getting {:?} time for {}: {}",
							self.file_time_type,
							file_info.path().to_string_lossy(),
							e
						)
						.unwrap();
						false
					},
					Ok(t) => t,
				}
			}
		}

		impl FileAgeRangeMatcher {
			fn matches_impl(
				&self,
				file_info: &WalkEntry,
				start_time: SystemTime,
			) -> Result<bool, Box<dyn Error>> {
				let this_time = self.file_time_type.get_file_time(file_info.metadata()?)?;
				let mut is_negative = false;
				let age = match start_time.duration_since(this_time) {
					Ok(duration) => duration,
					Err(e) => {
						is_negative = true;
						e.duration()
					},
				};
				let age_in_seconds: i64 = age.as_secs() as i64 * if is_negative { -1 } else { 1 };
				let age_in_minutes = age_in_seconds / 60 + if is_negative { -1 } else { 0 };
				Ok(self.minutes.imatches(age_in_minutes))
			}

			pub fn new(file_time_type: FileTimeType, minutes: ComparableValue, today_start: bool) -> Self {
				Self { minutes, file_time_type, today_start }
			}
		}
	}
	mod type_matcher {
		// Copyright 2017 Google Inc.
		//
		// Use of this source code is governed by a MIT-style
		// license that can be found in the LICENSE file or at
		// https://opensource.org/licenses/MIT.

		use std::error::Error;

		use super::{FileType, Follow, Matcher, MatcherIO, WalkEntry};

		/// This matcher checks the type of the file against a list of accepted
		/// types (GNU findutils 4.9+ accepts comma-separated lists, e.g. `f,d`).
		pub struct TypeMatcher {
			file_types: Vec<FileType>,
		}

		/// Parses one type letter. `Ok(None)` means the letter is accepted but
		/// can never match here (BSD `w` — whiteouts don't exist on this
		/// platform's walk results).
		fn parse_one(type_string: &str) -> Result<Option<FileType>, Box<dyn Error>> {
			let file_type = match type_string {
				"f" => FileType::Regular,
				"d" => FileType::Directory,
				"l" => FileType::Symlink,
				"b" => FileType::BlockDevice,
				"c" => FileType::CharDevice,
				"p" => FileType::Fifo, // named pipe (FIFO)
				"s" => FileType::Socket,
				// w: whiteout (BSD); accepted but never produced by the walker
				"w" => return Ok(None),
				// D: door (Solaris)
				"D" => return Err(From::from(format!("Type argument {type_string} not supported yet"))),
				_ => return Err(From::from(format!("Unrecognised type argument {type_string}"))),
			};
			Ok(Some(file_type))
		}

		fn parse(type_string: &str) -> Result<Vec<FileType>, Box<dyn Error>> {
			let mut file_types = Vec::new();
			for part in type_string.split(',') {
				if part.is_empty() {
					return Err(From::from(format!("Unrecognised type argument {type_string}")));
				}
				if let Some(file_type) = parse_one(part)? {
					file_types.push(file_type);
				}
			}
			Ok(file_types)
		}

		impl TypeMatcher {
			pub fn new(type_string: &str) -> Result<Self, Box<dyn Error>> {
				let file_types = parse(type_string)?;
				Ok(Self { file_types })
			}
		}

		impl Matcher for TypeMatcher {
			fn matches(&self, file_info: &WalkEntry, _: &mut MatcherIO) -> bool {
				self.file_types.contains(&file_info.file_type())
			}
		}

		/// Like [TypeMatcher], but toggles whether symlinks are followed.
		pub struct XtypeMatcher {
			file_types: Vec<FileType>,
		}

		impl XtypeMatcher {
			pub fn new(type_string: &str) -> Result<Self, Box<dyn Error>> {
				let file_types = parse(type_string)?;
				Ok(Self { file_types })
			}
		}

		impl Matcher for XtypeMatcher {
			fn matches(&self, file_info: &WalkEntry, _: &mut MatcherIO) -> bool {
				let follow = if file_info.follow() {
					Follow::Never
				} else {
					Follow::Always
				};

				let file_type = follow
					.metadata(file_info)
					.map(|m| m.file_type())
					.map(FileType::from);

				match file_type {
					Ok(file_type) if self.file_types.contains(&file_type) => true,
					// Since GNU find 4.10, ELOOP will match -xtype l
					Err(e) if self.file_types.iter().any(|t| t.is_symlink()) && e.is_loop() => true,
					_ => false,
				}
			}
		}
	}
	mod user {
		// This file is part of the uutils findutils package.
		//
		// For the full copyright and license information, please view the LICENSE
		// file that was distributed with this source code.

		#[cfg(unix)]
		use std::os::unix::fs::MetadataExt;

		#[cfg(unix)]
		use nix::unistd::User;

		use super::{ComparableValue, Matcher, MatcherIO, WalkEntry};

		pub struct UserMatcher {
			#[cfg_attr(not(unix), allow(dead_code))]
			uid: ComparableValue,
		}

		impl UserMatcher {
			#[cfg(unix)]
			pub fn from_user_name(user: &str) -> Option<Self> {
				// get uid from user name
				let user = User::from_name(user).ok()??;
				let uid = user.uid.as_raw();
				Some(Self::from_uid(uid))
			}

			pub fn from_uid(uid: u32) -> Self {
				Self::from_comparable(ComparableValue::EqualTo(uid as u64))
			}

			pub fn from_comparable(uid: ComparableValue) -> Self {
				Self { uid }
			}

			#[cfg(windows)]
			pub fn from_user_name(_user: &str) -> Option<Self> {
				None
			}
		}

		impl Matcher for UserMatcher {
			#[cfg(unix)]
			fn matches(&self, file_info: &WalkEntry, _: &mut MatcherIO) -> bool {
				match file_info.metadata() {
					Ok(metadata) => self.uid.matches(metadata.uid().into()),
					Err(_) => false,
				}
			}

			#[cfg(windows)]
			fn matches(&self, _file_info: &WalkEntry, _: &mut MatcherIO) -> bool {
				false
			}
		}

		pub struct NoUserMatcher {}

		impl Matcher for NoUserMatcher {
			#[cfg(unix)]
			fn matches(&self, file_info: &WalkEntry, _: &mut MatcherIO) -> bool {
				use nix::unistd::Uid;

				if file_info.path().is_symlink() {
					return false;
				}

				let Ok(metadata) = file_info.metadata() else {
					return true;
				};

				let Ok(uid) = User::from_uid(Uid::from_raw(metadata.uid())) else {
					return true;
				};

				let Some(_user) = uid else {
					return true;
				};

				false
			}

			#[cfg(windows)]
			fn matches(&self, _file_info: &WalkEntry, _: &mut MatcherIO) -> bool {
				false
			}
		}
	}

	use std::{
		error::Error,
		fs::{File, Metadata},
		io::{Read, Write},
		path::Path,
		str::FromStr,
		time::SystemTime,
	};

	use ::regex::Regex;
	use chrono::{DateTime, Datelike, Local, NaiveDate, NaiveDateTime, TimeZone, Utc};
	pub use entry::{FileType, WalkEntry, WalkError};
	use fs::FileSystemMatcher;
	use ls::Ls;

	#[cfg(unix)]
	use self::stat::{InodeMatcher, LinksMatcher};
	use self::{
		access::AccessMatcher,
		delete::DeleteMatcher,
		empty::EmptyMatcher,
		exec::{MultiExecMatcher, SingleExecMatcher},
		group::{GroupMatcher, NoGroupMatcher},
		lname::LinkNameMatcher,
		logical_matchers::{
			AndMatcherBuilder, FalseMatcher, ListMatcherBuilder, NotMatcher, TrueMatcher,
		},
		name::NameMatcher,
		path::PathMatcher,
		perm::PermMatcher,
		printer::{PrintDelimiter, Printer},
		printf::Printf,
		prune::PruneMatcher,
		quit::QuitMatcher,
		regex::RegexMatcher,
		samefile::SameFileMatcher,
		size::SizeMatcher,
		time::{
			FileAgeRangeMatcher, FileTimeMatcher, FileTimeType, NewerMatcher, NewerOptionMatcher,
			NewerOptionType, NewerTimeMatcher,
		},
		type_matcher::{TypeMatcher, XtypeMatcher},
		user::{NoUserMatcher, UserMatcher},
	};
	use super::{Config, Dependencies};
	use crate::host::Host;

	/// Symlink following mode.
	#[derive(Clone, Copy, Debug, Eq, PartialEq)]
	pub enum Follow {
		/// Never follow symlinks (-P; default).
		Never,
		/// Follow symlinks on root paths only (-H).
		Roots,
		/// Always follow symlinks (-L).
		Always,
	}

	impl Follow {
		/// Check whether to follow a path of the given depth.
		pub fn follow_at_depth(self, depth: usize) -> bool {
			match self {
				Self::Never => false,
				Self::Roots => depth == 0,
				Self::Always => true,
			}
		}

		/// Get metadata for a [WalkEntry].
		pub fn metadata(self, entry: &WalkEntry) -> Result<Metadata, WalkError> {
			if self.follow_at_depth(entry.depth()) == entry.follow() {
				// Same follow flag, re-use cached metadata
				entry.metadata().cloned()
			} else if !entry.follow() && !entry.file_type().is_symlink() {
				// Not a symlink, re-use cached metadata
				entry.metadata().cloned()
			} else if entry.follow() && entry.file_type().is_symlink() {
				// Broken symlink, re-use cached metadata
				entry.metadata().cloned()
			} else {
				self.metadata_at_depth(entry.path(), entry.depth())
			}
		}

		/// Get metadata for a path from the command line.
		pub fn root_metadata(self, path: impl AsRef<Path>) -> Result<Metadata, WalkError> {
			self.metadata_at_depth(path, 0)
		}

		/// Get metadata for a path, following symlinks as necessary.
		pub fn metadata_at_depth(
			self,
			path: impl AsRef<Path>,
			depth: usize,
		) -> Result<Metadata, WalkError> {
			let path = path.as_ref();

			if self.follow_at_depth(depth) {
				match path.metadata().map_err(WalkError::from) {
					Ok(meta) => return Ok(meta),
					Err(e) if !e.is_not_found() => return Err(e),
					_ => {},
				}
			}

			Ok(path.symlink_metadata()?)
		}
	}

	/// Struct holding references to outputs and any inputs that can't be derived
	/// from the file/directory info.
	pub struct MatcherIO<'a> {
		should_skip_dir: bool,
		exit_code:       i32,
		quit:            bool,
		deps:            &'a dyn Dependencies,
		host:            &'a mut Host,
	}

	impl MatcherIO<'_> {
		pub fn new<'a>(deps: &'a dyn Dependencies, host: &'a mut Host) -> MatcherIO<'a> {
			MatcherIO { should_skip_dir: false, exit_code: 0, quit: false, deps, host }
		}

		pub fn host(&mut self) -> &mut Host {
			self.host
		}

		pub fn mark_current_dir_to_be_skipped(&mut self) {
			self.should_skip_dir = true;
		}

		#[must_use]
		pub fn should_skip_current_dir(&self) -> bool {
			self.should_skip_dir
		}

		pub fn set_exit_code(&mut self, code: i32) {
			self.exit_code = code;
		}

		#[must_use]
		pub fn exit_code(&self) -> i32 {
			self.exit_code
		}

		pub fn quit(&mut self) {
			self.quit = true;
		}

		#[must_use]
		pub fn should_quit(&self) -> bool {
			self.quit
		}

		#[must_use]
		pub fn now(&self) -> SystemTime {
			self.deps.now()
		}
	}

	/// A basic interface that can be used to determine whether a directory entry
	/// is what's being searched for. To a first order approximation, find consists
	/// of building a chain of Matcher objects, and then walking a directory tree,
	/// passing each entry to the chain of Matchers.
	pub trait Matcher: 'static {
		/// Boxes this matcher as a trait object.
		fn into_box(self) -> Box<dyn Matcher>
		where
			Self: Sized,
		{
			Box::new(self)
		}

		/// Returns whether the given file matches the object's predicate.
		fn matches(&self, entry: &WalkEntry, matcher_io: &mut MatcherIO) -> bool;

		/// Returns whether the matcher has any side-effects (e.g. executing a
		/// command, deleting a file). Iff no such matcher exists in the chain, then
		/// the filename will be printed to stdout. While this is a compile-time
		/// fact for most matchers, it's run-time for matchers that contain a
		/// collection of sub-Matchers.
		fn has_side_effects(&self) -> bool {
			// most matchers don't have side-effects, so supply a default implementation.
			false
		}

		/// Notification that find is leaving a given directory.
		fn finished_dir(&self, _finished_directory: &Path, _matcher_io: &mut MatcherIO) {}

		/// Notification that find has finished processing all directories -
		/// allowing for any cleanup that isn't suitable for destructors (e.g.
		/// blocking calls, I/O etc.)
		fn finished(&self, _matcher_io: &mut MatcherIO) {}
	}

	impl Matcher for Box<dyn Matcher> {
		fn into_box(self) -> Box<dyn Matcher> {
			self
		}

		fn matches(&self, entry: &WalkEntry, matcher_io: &mut MatcherIO) -> bool {
			(**self).matches(entry, matcher_io)
		}

		fn has_side_effects(&self) -> bool {
			(**self).has_side_effects()
		}

		fn finished_dir(&self, finished_directory: &Path, matcher_io: &mut MatcherIO) {
			(**self).finished_dir(finished_directory, matcher_io);
		}

		fn finished(&self, matcher_io: &mut MatcherIO) {
			(**self).finished(matcher_io);
		}
	}

	#[derive(Debug, Eq, PartialEq)]
	pub enum ComparableValue {
		MoreThan(u64),
		EqualTo(u64),
		LessThan(u64),
	}

	impl ComparableValue {
		fn matches(&self, value: u64) -> bool {
			match *self {
				Self::MoreThan(limit) => value > limit,
				Self::EqualTo(limit) => value == limit,
				Self::LessThan(limit) => value < limit,
			}
		}

		/// same as matches, but takes a signed value
		fn imatches(&self, value: i64) -> bool {
			match *self {
				Self::MoreThan(limit) => value >= 0 && (value as u64) > limit,
				Self::EqualTo(limit) => value >= 0 && (value as u64) == limit,
				Self::LessThan(limit) => value < 0 || (value as u64) < limit,
			}
		}
	}

	/// Builds a single `AndMatcher` containing the Matcher objects corresponding
	/// to the passed in predicate arguments.
	pub fn build_top_level_matcher(
		args: &[&str],
		config: &mut Config,
		host: &mut Host,
	) -> Result<Box<dyn Matcher>, Box<dyn Error>> {
		let (_, top_level_matcher) = (build_matcher_tree(args, config, 0, false, host))?;

		// if the matcher doesn't have any side-effects, then we default to printing
		if !top_level_matcher.has_side_effects() {
			let mut new_and_matcher = AndMatcherBuilder::new();
			new_and_matcher.new_and_condition(top_level_matcher);
			new_and_matcher.new_and_condition(Printer::new(PrintDelimiter::Newline, None));
			return Ok(new_and_matcher.build());
		}
		Ok(top_level_matcher)
	}

	/// Helper function for `build_matcher_tree`.
	fn are_more_expressions(args: &[&str], index: usize) -> bool {
		(index < args.len() - 1) && args[index + 1] != ")"
	}

	fn convert_arg_to_number(
		option_name: &str,
		value_as_string: &str,
	) -> Result<usize, Box<dyn Error>> {
		match value_as_string.parse::<usize>() {
			Ok(val) => Ok(val),
			_ => Err(From::from(format!(
				"Expected a positive decimal integer argument to {option_name}, but got \
				 `{value_as_string}'"
			))),
		}
	}

	fn convert_arg_to_comparable_value(
		option_name: &str,
		value_as_string: &str,
	) -> Result<ComparableValue, Box<dyn Error>> {
		let re = Regex::new(r"^([-+]?)[-+]?(\d+)$")?;
		if let Some(groups) = re.captures(value_as_string)
			&& let Ok(val) = groups[2].parse::<u64>()
		{
			return Ok(match &groups[1] {
				"+" => ComparableValue::MoreThan(val),
				"-" => ComparableValue::LessThan(val),
				_ => ComparableValue::EqualTo(val),
			});
		}
		Err(From::from(format!(
			"Expected a decimal integer (with optional + or - prefix) argument to {option_name}, but \
			 got `{value_as_string}'"
		)))
	}

	fn convert_arg_to_comparable_value_and_suffix(
		option_name: &str,
		value_as_string: &str,
	) -> Result<(ComparableValue, String), Box<dyn Error>> {
		let re = Regex::new(r"([-+]?)[-+]?(\d+)(.*)$")?;
		if let Some(groups) = re.captures(value_as_string)
			&& let Ok(val) = groups[2].parse::<u64>()
		{
			return Ok((
				match &groups[1] {
					"+" => ComparableValue::MoreThan(val),
					"-" => ComparableValue::LessThan(val),
					_ => ComparableValue::EqualTo(val),
				},
				groups[3].to_string(),
			));
		}
		Err(From::from(format!(
			"Expected a decimal integer (with optional + or - prefix) and (optional suffix) argument to \
			 {option_name}, but got `{value_as_string}'"
		)))
	}

	/// Converts a `-newerXt`-style reference time string into a Unix timestamp
	/// (milliseconds).
	///
	/// Accepts, in order:
	/// - `@N[.N]` seconds since the epoch (GNU extension)
	/// - RFC 3339 datetimes with an explicit offset, e.g.
	///   "2026-01-01T00:00:00Z"
	/// - ISO-style naive dates/datetimes ("2026-01-01",
	///   "2026-01-01 12:30[:45]", with ` ` or `T` separators), interpreted in
	///   local time like GNU find
	/// - "(month abbreviation) (date), (year) (time)" strings, e.g.
	///   "jan 01, 2025 00:00:01" (time defaults to 00:00:00)
	fn parse_date_str_to_timestamps(date_str: &str) -> Option<i64> {
		if let Some(epoch) = date_str.strip_prefix('@')
			&& let Ok(seconds) = epoch.parse::<f64>()
		{
			return Some((seconds * 1000.0) as i64);
		}

		if let Ok(datetime) = DateTime::parse_from_rfc3339(date_str) {
			return Some(datetime.timestamp_millis());
		}

		let naive = NaiveDate::parse_from_str(date_str, "%Y-%m-%d")
			.ok()
			.and_then(|date| date.and_hms_opt(0, 0, 0))
			.or_else(|| NaiveDateTime::parse_from_str(date_str, "%Y-%m-%d %H:%M:%S").ok())
			.or_else(|| NaiveDateTime::parse_from_str(date_str, "%Y-%m-%dT%H:%M:%S").ok())
			.or_else(|| NaiveDateTime::parse_from_str(date_str, "%Y-%m-%d %H:%M").ok())
			.or_else(|| NaiveDateTime::parse_from_str(date_str, "%Y-%m-%dT%H:%M").ok());
		if let Some(naive) = naive {
			return Some(Local.from_local_datetime(&naive).earliest()?.timestamp_millis());
		}

		let regex_pattern =
			r"^(?P<month_day>\w{3} \d{2})?(?:, (?P<year>\d{4}))?(?: (?P<time>\d{2}:\d{2}:\d{2}))?$";
		let re = Regex::new(regex_pattern);

		if let Some(captures) = re.ok()?.captures(date_str) {
			let now = Utc::now();
			let month_day = captures
				.get(1)
				.map_or(format!("{} {}", now.format("%b"), now.format("%d")), |m| m.as_str().to_string());
			// If no year input.
			let year = captures
				.get(2)
				.map_or(now.year(), |m| m.as_str().parse().unwrap());
			// If the user does not enter a specific time, it will be filled with 0
			let time_str = captures.get(3).map_or("00:00:00", |m| m.as_str());
			let date_time_str = format!("{month_day}, {year} {time_str}");
			let datetime = NaiveDateTime::parse_from_str(&date_time_str, "%b %d, %Y %H:%M:%S").ok()?;
			let utc_datetime = DateTime::<Utc>::from_naive_utc_and_offset(datetime, Utc);
			Some(utc_datetime.timestamp_millis())
		} else {
			None
		}
	}

	/// This function implements the function of matching substrings of
	/// X and Y from the -newerXY string.
	/// X and Y are constrained to a/B/c/m and t.
	/// such as: "-neweraB" -> Some(a, B) "-neweraD" -> None
	///
	/// Additionally, there is support for the -anewer and -cnewer short arguments.
	/// as follows:
	/// 1. -anewer is equivalent to -neweram
	/// 2. -cnewer is equivalent to - newercm
	///
	/// If -newer is used it will be resolved to -newermm.
	fn parse_str_to_newer_args(input: &str) -> Option<(String, String)> {
		if input.is_empty() {
			return None;
		}

		if input == "-newer" {
			return Some(("m".to_string(), "m".to_string()));
		}

		if input == "-anewer" {
			return Some(("a".to_string(), "m".to_string()));
		}

		if input == "-cnewer" {
			return Some(("c".to_string(), "m".to_string()));
		}

		let re = Regex::new(r"-newer([aBcm])([aBcmt])").unwrap();
		if let Some(captures) = re.captures(input) {
			let x = captures.get(1)?.as_str().to_string();
			let y = captures.get(2)?.as_str().to_string();
			Some((x, y))
		} else {
			None
		}
	}

	/// Creates a file if it doesn't exist.
	/// If it does exist, it will be overwritten.
	fn get_or_create_file(path: &str, host: &Host) -> Result<File, Box<dyn Error>> {
		let file = File::create(host.resolve(path))?;
		Ok(file)
	}

	/// The main "translate command-line args into a matcher" function. Will call
	/// itself recursively if it encounters an opening bracket. A successful return
	/// consists of a tuple containing the new index into the args array to use (if
	/// called recursively) and the resulting matcher.
	fn build_matcher_tree(
		args: &[&str],
		config: &mut Config,
		arg_index: usize,
		mut expecting_bracket: bool,
		host: &mut Host,
	) -> Result<(usize, Box<dyn Matcher>), Box<dyn Error>> {
		let mut top_level_matcher = ListMatcherBuilder::new();

		let mut regex_type = regex::RegexType::default();

		// can't use getopts for a variety or reasons:
		// order of arguments is important
		// arguments can start with + as well as -
		// multiple-character flags don't start with a double dash
		let mut i = arg_index;
		let mut invert_next_matcher = false;
		while i < args.len() {
			let possible_submatcher = match args[i] {
				"-print" => Some(Printer::new(PrintDelimiter::Newline, None).into_box()),
				"-print0" => Some(Printer::new(PrintDelimiter::Null, None).into_box()),
				"-printf" => {
					if i >= args.len() - 1 {
						return Err(From::from(format!("missing argument to {}", args[i])));
					}
					i += 1;
					Some(Printf::new(args[i], None)?.into_box())
				},
				"-fprint" => {
					if i >= args.len() - 1 {
						return Err(From::from(format!("missing argument to {}", args[i])));
					}
					i += 1;

					let file = get_or_create_file(args[i], host)?;
					Some(Printer::new(PrintDelimiter::Newline, Some(file)).into_box())
				},
				"-fprintf" => {
					if i >= args.len() - 2 {
						return Err(From::from(format!("missing argument to {}", args[i])));
					}

					// Action: -fprintf file format
					// Args + 1: output file path
					// Args + 2: format string
					i += 1;
					let file = get_or_create_file(args[i], host)?;
					i += 1;
					Some(Printf::new(args[i], Some(file))?.into_box())
				},
				"-fprint0" => {
					if i >= args.len() - 1 {
						return Err(From::from(format!("missing argument to {}", args[i])));
					}
					i += 1;

					let file = get_or_create_file(args[i], host)?;
					Some(Printer::new(PrintDelimiter::Null, Some(file)).into_box())
				},
				"-ls" => Some(Ls::new(None).into_box()),
				"-fls" => {
					if i >= args.len() - 1 {
						return Err(From::from(format!("missing argument to {}", args[i])));
					}
					i += 1;

					let file = get_or_create_file(args[i], host)?;
					Some(Ls::new(Some(file)).into_box())
				},
				"-true" => Some(TrueMatcher.into_box()),
				"-false" => Some(FalseMatcher.into_box()),
				"-lname" | "-ilname" => {
					if i >= args.len() - 1 {
						return Err(From::from(format!("missing argument to {}", args[i])));
					}
					i += 1;
					Some(LinkNameMatcher::new(args[i], args[i - 1].starts_with("-i")).into_box())
				},
				"-name" | "-iname" => {
					if i >= args.len() - 1 {
						return Err(From::from(format!("missing argument to {}", args[i])));
					}
					i += 1;
					Some(NameMatcher::new(args[i], args[i - 1].starts_with("-i")).into_box())
				},
				"-path" | "-ipath" | "-wholename" | "-iwholename" => {
					if i >= args.len() - 1 {
						return Err(From::from(format!("missing argument to {}", args[i])));
					}
					i += 1;
					Some(PathMatcher::new(args[i], args[i - 1].starts_with("-i")).into_box())
				},
				"-readable" => Some(AccessMatcher::Readable.into_box()),
				"-regextype" => {
					if i >= args.len() - 1 {
						return Err(From::from(format!("missing argument to {}", args[i])));
					}
					i += 1;
					regex_type = regex::RegexType::from_str(args[i])?;
					Some(TrueMatcher.into_box())
				},
				"-regex" => {
					if i >= args.len() - 1 {
						return Err(From::from(format!("missing argument to {}", args[i])));
					}
					i += 1;
					Some(RegexMatcher::new(regex_type, args[i], false)?.into_box())
				},
				"-iregex" => {
					if i >= args.len() - 1 {
						return Err(From::from(format!("missing argument to {}", args[i])));
					}
					i += 1;
					Some(RegexMatcher::new(regex_type, args[i], true)?.into_box())
				},
				"-type" => {
					if i >= args.len() - 1 {
						return Err(From::from(format!("missing argument to {}", args[i])));
					}
					i += 1;
					Some(TypeMatcher::new(args[i])?.into_box())
				},
				"-xtype" => {
					if i >= args.len() - 1 {
						return Err(From::from(format!("missing argument to {}", args[i])));
					}
					i += 1;
					Some(XtypeMatcher::new(args[i])?.into_box())
				},
				"-fstype" => {
					if i >= args.len() - 1 {
						return Err(From::from(format!("missing argument to {}", args[i])));
					}
					i += 1;
					Some(FileSystemMatcher::new(args[i].to_string()).into_box())
				},
				"-delete" => {
					// -delete implicitly requires -depth
					config.depth_first = true;
					Some(DeleteMatcher::new().into_box())
				},
				"-newer" => {
					if i >= args.len() - 1 {
						return Err(From::from(format!("missing argument to {}", args[i])));
					}
					i += 1;
					Some(NewerMatcher::new(args[i], config.follow, host)?.into_box())
				},
				"-mtime" | "-atime" | "-ctime" => {
					if i >= args.len() - 1 {
						return Err(From::from(format!("missing argument to {}", args[i])));
					}
					let file_time_type = match args[i] {
						"-atime" => FileTimeType::Accessed,
						"-ctime" => FileTimeType::Changed,
						"-mtime" => FileTimeType::Modified,
						// This shouldn't be possible. We've already checked the value
						// is one of those three values.
						_ => unreachable!("Encountered unexpected value {}", args[i]),
					};
					let days = convert_arg_to_comparable_value(args[i], args[i + 1])?;
					i += 1;
					Some(FileTimeMatcher::new(file_time_type, days, config.today_start).into_box())
				},
				"-amin" | "-cmin" | "-mmin" => {
					if i >= args.len() - 1 {
						return Err(From::from(format!("missing argument to {}", args[i])));
					}
					let file_time_type = match args[i] {
						"-amin" => FileTimeType::Accessed,
						"-cmin" => FileTimeType::Changed,
						"-mmin" => FileTimeType::Modified,
						_ => unreachable!("Encountered unexpected value {}", args[i]),
					};
					let minutes = convert_arg_to_comparable_value(args[i], args[i + 1])?;
					i += 1;
					Some(FileAgeRangeMatcher::new(file_time_type, minutes, config.today_start).into_box())
				},
				"-size" => {
					if i >= args.len() - 1 {
						return Err(From::from(format!("missing argument to {}", args[i])));
					}
					let (size, unit) = convert_arg_to_comparable_value_and_suffix(args[i], args[i + 1])?;
					i += 1;
					Some(SizeMatcher::new(size, &unit)?.into_box())
				},
				"-empty" => Some(EmptyMatcher::new().into_box()),
				"-exec" | "-execdir" => {
					let mut arg_index = i + 1;
					while arg_index < args.len()
						&& args[arg_index] != ";"
						&& (args[arg_index - 1] != "{}" || args[arg_index] != "+")
					{
						arg_index += 1;
					}
					let required_arg = if arg_index < args.len() && args[arg_index] == "+" {
						3
					} else {
						2
					};
					if arg_index < i + required_arg || arg_index == args.len() {
						// at the minimum we need the executable and the ';'
						// or the executable and the '{} +'
						return Err(From::from(format!("missing argument to {}", args[i])));
					}
					let expression = args[i];
					let executable = args[i + 1];
					let exec_args = &args[i + 2..arg_index];
					i = arg_index;
					match args[arg_index] {
						";" => Some(
							SingleExecMatcher::new(executable, exec_args, expression == "-execdir")?
								.into_box(),
						),
						"+" => {
							if exec_args.iter().filter(|x| matches!(**x, "{}")).count() == 1 {
								Some(
									MultiExecMatcher::new(
										executable,
										&exec_args[0..exec_args.len() - 1],
										expression == "-execdir",
									)?
									.into_box(),
								)
							} else {
								return Err(From::from(
									"Only one instance of {} is supported with -execdir ... +",
								));
							}
						},
						_ => unreachable!("Encountered unexpected value {}", args[arg_index]),
					}
				},
				#[cfg(unix)]
				"-inum" => {
					if i >= args.len() - 1 {
						return Err(From::from(format!("missing argument to {}", args[i])));
					}
					let inum = convert_arg_to_comparable_value(args[i], args[i + 1])?;
					i += 1;
					Some(InodeMatcher::new(inum).into_box())
				},
				#[cfg(not(unix))]
				"-inum" => {
					return Err(From::from("Inode numbers are not available on this platform"));
				},
				#[cfg(unix)]
				"-links" => {
					if i >= args.len() - 1 {
						return Err(From::from(format!("missing argument to {}", args[i])));
					}
					let inum = convert_arg_to_comparable_value(args[i], args[i + 1])?;
					i += 1;
					Some(LinksMatcher::new(inum).into_box())
				},
				#[cfg(not(unix))]
				"-links" => {
					return Err(From::from("Link counts are not available on this platform"));
				},
				"-samefile" => {
					if i >= args.len() - 1 {
						return Err(From::from(format!("missing argument to {}", args[i])));
					}
					i += 1;
					let path = args[i];
					let matcher = SameFileMatcher::new(path, config.follow, host)
						.map_err(|e| format!("{path}: {e}"))?;
					Some(matcher.into_box())
				},
				"-user" => {
					if i >= args.len() - 1 {
						return Err(From::from(format!("missing argument to {}", args[i])));
					}

					let user = args[i + 1];

					if user.is_empty() {
						return Err(From::from("The argument to -user should not be empty"));
					}

					i += 1;
					let matcher = UserMatcher::from_user_name(user)
						.or_else(|| Some(UserMatcher::from_uid(user.parse::<u32>().ok()?)))
						.ok_or_else(|| format!("{user} is not the name of a known user"))?;
					Some(matcher.into_box())
				},
				"-nouser" => Some(NoUserMatcher {}.into_box()),
				"-uid" => {
					if i >= args.len() - 1 {
						return Err(From::from(format!("missing argument to {}", args[i])));
					}
					// check if the argument is a number
					let uid = convert_arg_to_comparable_value(args[i], args[i + 1])?;
					i += 1;
					Some(UserMatcher::from_comparable(uid).into_box())
				},
				"-group" => {
					if i >= args.len() - 1 {
						return Err(From::from(format!("missing argument to {}", args[i])));
					}

					let group = args[i + 1];

					if group.is_empty() {
						return Err(From::from("Argument to -group is empty, but should be a group name"));
					}

					i += 1;
					let matcher = GroupMatcher::from_group_name(group)
						.or_else(|| Some(GroupMatcher::from_gid(group.parse::<u32>().ok()?)))
						.ok_or_else(|| format!("{group} is not the name of an existing group"))?;
					Some(matcher.into_box())
				},
				"-nogroup" => Some(NoGroupMatcher {}.into_box()),
				"-gid" => {
					if i >= args.len() - 1 {
						return Err(From::from(format!("missing argument to {}", args[i])));
					}
					// check if the argument is a number
					let gid = convert_arg_to_comparable_value(args[i], args[i + 1])?;
					i += 1;
					Some(GroupMatcher::from_comparable(gid).into_box())
				},
				"-executable" => Some(AccessMatcher::Executable.into_box()),
				"-perm" => {
					if i >= args.len() - 1 {
						return Err(From::from(format!("missing argument to {}", args[i])));
					}
					i += 1;
					Some(PermMatcher::new(args[i])?.into_box())
				},
				"-prune" => Some(PruneMatcher::new().into_box()),
				"-quit" => Some(QuitMatcher.into_box()),
				"-writable" => Some(AccessMatcher::Writable.into_box()),
				"-not" | "!" => {
					if !are_more_expressions(args, i) {
						return Err(From::from(format!("expected an expression after {}", args[i])));
					}
					invert_next_matcher = !invert_next_matcher;
					None
				},
				"-and" | "-a" => {
					if !are_more_expressions(args, i) {
						return Err(From::from(format!("expected an expression after {}", args[i])));
					}
					top_level_matcher.check_new_and_condition()?;
					None
				},
				"-or" | "-o" => {
					if !are_more_expressions(args, i) {
						return Err(From::from(format!("expected an expression after {}", args[i])));
					}
					top_level_matcher.new_or_condition(args[i])?;
					None
				},
				"," => {
					if !are_more_expressions(args, i) {
						return Err(From::from(format!("expected an expression after {}", args[i])));
					}
					top_level_matcher.new_list_condition()?;
					None
				},
				"(" => {
					let (new_arg_index, sub_matcher) = build_matcher_tree(args, config, i + 1, true, host)?;
					i = new_arg_index;
					Some(sub_matcher)
				},
				")" => {
					if !expecting_bracket {
						return Err(From::from(
							"invalid expression: expected expression before closing parentheses ')'.",
						));
					}

					let bracket = args[i - 1];
					if bracket == "(" {
						return Err(From::from("invalid expression; empty parentheses are not allowed."));
					}

					return Ok((i, top_level_matcher.build()));
				},
				"-follow" => {
					// This option affects multiple matchers.
					// 1. It will use noleaf by default. (but -noleaf No change of behavior)
					// Unless -L or -H is specified:
					// 2. changes the behaviour of the -newer predicate.
					// 3. consideration applies to -newerXY, -anewer and -cnewer
					// 4. -type predicate will always match against the type of the file that a
					//    symbolic link points to rather than the link itself.
					//
					// 5. causes the -lname and -ilname predicates always to return false. (unless
					//    they happen to match broken symbolic links)
					config.follow = Follow::Always;
					config.no_leaf_dirs = true;
					Some(TrueMatcher.into_box())
				},
				"-daystart" => {
					config.today_start = true;
					Some(TrueMatcher.into_box())
				},
				"-noleaf" => {
					// No change of behavior
					config.no_leaf_dirs = true;
					Some(TrueMatcher.into_box())
				},
				"-d" | "-depth" => {
					// TODO add warning if it appears after actual testing criterion
					config.depth_first = true;
					Some(TrueMatcher.into_box())
				},
				"-mount" | "-xdev" => {
					// TODO add warning if it appears after actual testing criterion
					config.same_file_system = true;
					Some(TrueMatcher.into_box())
				},
				"-sorted" => {
					// TODO add warning if it appears after actual testing criterion
					config.sorted_output = true;
					Some(TrueMatcher.into_box())
				},
				"-maxdepth" => {
					if i >= args.len() - 1 {
						return Err(From::from(format!("missing argument to {}", args[i])));
					}
					config.max_depth = convert_arg_to_number(args[i], args[i + 1])?;
					i += 1;
					Some(TrueMatcher.into_box())
				},
				"-mindepth" => {
					if i >= args.len() - 1 {
						return Err(From::from(format!("missing argument to {}", args[i])));
					}
					config.min_depth = convert_arg_to_number(args[i], args[i + 1])?;
					i += 1;
					Some(TrueMatcher.into_box())
				},
				"-help" | "--help" => {
					config.help_requested = true;
					None
				},
				"-version" | "--version" => {
					config.version_requested = true;
					None
				},
				"-files0-from" => {
					if i >= args.len() - 1 {
						return Err(From::from(format!("missing argument to {}", args[i])));
					}
					let _ = config.files0_argument.insert(args[i + 1].to_string());
					i += 1;
					Some(TrueMatcher.into_box())
				},

				_ => {
					match parse_str_to_newer_args(args[i]) {
						Some((x_option, y_option)) => {
							if i >= args.len() - 1 {
								return Err(From::from(format!("missing argument to {}", args[i])));
							}
							#[cfg(target_os = "linux")]
							if x_option == "B" {
								return Err(From::from(
									"find: This system does not provide a way to find the birth time of a \
									 file.",
								));
							}
							if y_option == "t" {
								let time = args[i + 1];
								let newer_time_type = NewerOptionType::from_str(x_option.as_str());
								// Convert args to unix timestamps. (expressed in numeric types)
								let Some(comparable_time) = parse_date_str_to_timestamps(time) else {
									return Err(From::from(format!(
										"find: I cannot figure out how to interpret ‘{}’ as a date or time",
										args[i + 1]
									)));
								};
								i += 1;
								Some(NewerTimeMatcher::new(newer_time_type, comparable_time).into_box())
							} else {
								let file_path = args[i + 1];
								i += 1;
								Some(NewerOptionMatcher::new(&x_option, &y_option, file_path, host)?.into_box())
							}
						},
						None => return Err(From::from(format!("Unrecognized flag: '{}'", args[i]))),
					}
				},
			};
			i += 1;
			if config.help_requested || config.version_requested {
				// Ignore anything, even invalid expressions, after -help/-version
				expecting_bracket = false;
				break;
			}
			if let Some(submatcher) = possible_submatcher {
				if invert_next_matcher {
					top_level_matcher.new_and_condition(NotMatcher::new(submatcher));
					invert_next_matcher = false;
				} else {
					top_level_matcher.new_and_condition(submatcher);
				}
			}
		}
		if expecting_bracket {
			return Err(From::from(
				"invalid expression; I was expecting to find a ')' somewhere but did not see one.",
			));
		}
		if config.files0_argument.is_some() {
			parse_files0_args(config, host)?;
		}
		Ok((i, top_level_matcher.build()))
	}

	// https://www.gnu.org/software/findutils/manual/html_node/find_html/Starting-points.html
	// This allows users to take the entry point for find from stdin (eg. pipe) or
	// from a text file. eg. dummy | find -files0-from -
	// eg. find -files0-from rust.txt -name "cargo"
	fn parse_files0_args(config: &mut Config, host: &mut Host) -> Result<(), Box<dyn Error>> {
		let mode = config.files0_argument.as_ref().unwrap();
		let mut buffer = Vec::new();
		let new_paths = config.new_paths.insert(Vec::new());

		if mode == "-" {
			host.stdin.read_to_end(&mut buffer)?;
		} else {
			let mut file = File::open(host.resolve(mode))
				.map_err(|e| format!("cannot open '{}' for reading: {}", mode, e))?;
			file.read_to_end(&mut buffer)?;
		}

		let mut buffer_split: Vec<&[u8]> = buffer.split(|&b| b == 0).collect();
		// if the pipe/file ends with ASCII NULL
		if buffer_split.last().is_some_and(|s| s.is_empty()) {
			buffer_split.remove(buffer_split.len() - 1);
		}

		let mut string_segments: Vec<String> = buffer_split
			.iter()
			.filter_map(|s| std::str::from_utf8(s).ok())
			.map(|s| s.to_string())
			.collect();
		// empty starting point checker
		if string_segments.iter().any(|s| s.is_empty()) {
			let _ = writeln!(host.stderr, "find: invalid zero-length file name");
			// remove the empty ones so as to avoid file not found error
			string_segments.retain(|s| !s.is_empty());
		}

		new_paths.extend(string_segments);
		Ok(())
	}
}

use std::{
	cell::{Cell, RefCell},
	error::Error,
	io::{self, Write},
	path::{Path, PathBuf},
	rc::Rc,
	time::SystemTime,
};

use brush_core::{ShellExtensions, builtins::Registration};
use clap::{Arg, ArgAction, ArgMatches, Command, builder::OsStringValueParser};

use crate::host::{Host, Utility, matches_parser, util};
use matchers::{Follow, WalkEntry};

pub struct Config {
	same_file_system:  bool,
	depth_first:       bool,
	min_depth:         usize,
	max_depth:         usize,
	sorted_output:     bool,
	help_requested:    bool,
	version_requested: bool,
	today_start:       bool,
	no_leaf_dirs:      bool,
	follow:            Follow,
	new_paths:         Option<Vec<String>>,
	files0_argument:   Option<String>,
}

impl Default for Config {
	fn default() -> Self {
		Self {
			same_file_system:  false,
			depth_first:       false,
			min_depth:         0,
			max_depth:         usize::MAX,
			sorted_output:     false,
			help_requested:    false,
			version_requested: false,
			today_start:       false,
			// Directory information and traversal are handled by pi_walker,
			// and this configuration field exists as a compatibility item for
			// GNU findutils.
			no_leaf_dirs:      false,
			follow:            Follow::Never,
			new_paths:         None, // This option exclusively for -files0-from argument.
			files0_argument:   None, //This option also is used for file0-from
		}
	}
}

/// Trait that encapsulates various dependencies (output, clocks, etc.) that we
/// might want to fake out for unit tests.
pub trait Dependencies {
	fn get_output(&self) -> &RefCell<dyn Write>;
	fn now(&self) -> SystemTime;
}

/// Struct that holds the dependencies we use when run as the real executable.
struct StandardDependencies {
	output: Rc<RefCell<dyn Write>>,
	now:    SystemTime,
}

impl StandardDependencies {
	#[must_use]
	fn new(host: &Host) -> Self {
		Self { output: Rc::new(RefCell::new(host.stdout_clone())), now: SystemTime::now() }
	}
}


impl Dependencies for StandardDependencies {
	fn get_output(&self) -> &RefCell<dyn Write> {
		self.output.as_ref()
	}

	fn now(&self) -> SystemTime {
		self.now
	}
}

/// The result of parsing the command-line arguments into useful forms.
struct ParsedInfo {
	matcher: Box<dyn self::matchers::Matcher>,
	paths:   Vec<String>,
	config:  Config,
}

/// Function to generate a `ParsedInfo` from the strings supplied on the
/// command-line.
fn parse_args(args: &[&str], host: &mut Host) -> Result<ParsedInfo, Box<dyn Error>> {
	let mut paths = vec![];
	let mut i = 0;
	let mut config = Config::default();
	let mut extended_regex = false;

	while i < args.len() {
		match args[i] {
			"-O0" | "-O1" | "-O2" | "-O3" => {
				// GNU find optimization level flag (ignored)
			},
			"-H" => config.follow = Follow::Roots,
			"-L" => config.follow = Follow::Always,
			"-P" => config.follow = Follow::Never,
			// BSD find leading flags (macOS muscle memory).
			"-E" => extended_regex = true,
			// -x is the BSD spelling of -xdev.
			"-x" => config.same_file_system = true,
			// -s sorts output lexicographically.
			"-s" => config.sorted_output = true,
			"--" => {
				// End of flags
				i += 1;
				break;
			},
			_ => break,
		}

		i += 1;
	}

	let paths_start = i;
	while i < args.len()
		&& (args[i] == "-" || !args[i].starts_with('-'))
		&& args[i] != "!"
		&& args[i] != "("
	{
		paths.push(args[i].to_string());
		i += 1;
	}
	if i == paths_start {
		paths.push(".".to_string());
	}
	let matcher = if extended_regex {
		// BSD -E selects POSIX extended regular expressions; GNU spells that
		// -regextype posix-extended, which must precede any -regex/-iregex.
		let mut expression = Vec::with_capacity(args.len() - i + 2);
		expression.extend(["-regextype", "posix-extended"]);
		expression.extend_from_slice(&args[i..]);
		matchers::build_top_level_matcher(&expression, &mut config, host)?
	} else {
		matchers::build_top_level_matcher(&args[i..], &mut config, host)?
	};
	if let Some(new_paths) = &config.new_paths {
		if paths.len() == 1 && paths[0] == "." {
			paths = new_paths.to_vec();
		} else {
			return Err(From::from(format!(
				"extra operand '{}'\nfile operands cannot be combined with -files0-from",
				paths[0]
			)));
		}
	}
	Ok(ParsedInfo { matcher, paths, config })
}

fn apply_find_entry(
	mut entry: WalkEntry,
	operand: &Path,
	resolved_root: &Path,
	deps: &dyn Dependencies,
	host: &mut Host,
	matcher: &dyn matchers::Matcher,
	current_dir: &mut Option<PathBuf>,
	ret: &mut i32,
) -> (bool, bool) {
	entry.set_display_root(operand, resolved_root);
	let mut matcher_io = matchers::MatcherIO::new(deps, host);

	let new_dir = entry.path().parent().map(|x| x.to_path_buf());
	if new_dir != *current_dir {
		if let Some(dir) = current_dir.take() {
			matcher.finished_dir(dir.as_path(), &mut matcher_io);
		}
		*current_dir = new_dir;
	}

	matcher.matches(&entry, &mut matcher_io);
	match matcher_io.exit_code() {
		0 => {},
		code => *ret = code,
	}
	(matcher_io.should_quit(), matcher_io.should_skip_current_dir())
}

fn finish_find_walk(
	deps: &dyn Dependencies,
	host: &mut Host,
	matcher: &dyn matchers::Matcher,
	current_dir: &mut Option<PathBuf>,
	ret: &mut i32,
) {
	let mut matcher_io = matchers::MatcherIO::new(deps, host);
	if let Some(dir) = current_dir.take() {
		matcher.finished_dir(dir.as_path(), &mut matcher_io);
	}
	matcher.finished(&mut matcher_io);
	// This is implemented for exec +.
	match matcher_io.exit_code() {
		0 => {},
		code => *ret = code,
	}
}

fn walker_follow_links(follow: Follow) -> pi_walker::FollowLinks {
	match follow {
		Follow::Never => pi_walker::FollowLinks::Never,
		Follow::Roots => pi_walker::FollowLinks::Roots,
		Follow::Always => pi_walker::FollowLinks::Always,
	}
}

fn build_find_walk_request(config: &Config, root: &Path) -> pi_walker::WalkRequest {
	pi_walker::WalkRequest::new(root)
		.hidden(true)
		.gitignore(false)
		.skip_git(false)
		.skip_node_modules(false)
		.follow_links(walker_follow_links(config.follow))
		.detail(pi_walker::WalkDetail::Minimal)
		.order(if config.sorted_output {
			pi_walker::WalkOrder::Path
		} else {
			pi_walker::WalkOrder::Unordered
		})
		.emit_root(true)
		.depth(config.min_depth, config.max_depth)
		.visit_order(if config.depth_first {
			pi_walker::VisitOrder::ContentsFirst
		} else {
			pi_walker::VisitOrder::PreOrder
		})
		.directory_errors(pi_walker::DirectoryErrorMode::Visit)
		.same_file_system(config.same_file_system)
		.cache(false)
}
fn process_dir_walk_request(
	config: &Config,
	deps: &dyn Dependencies,
	host: &mut Host,
	matcher: &dyn matchers::Matcher,
	quit: &mut bool,
	resolved_root: &Path,
	operand: &Path,
) -> i32 {
	let request = build_find_walk_request(config, resolved_root);
	let current_dir = RefCell::new(None);
	let ret = Cell::new(0);
	let local_quit = Cell::new(false);
	let cancel = host.cancel_flag();
	let mut walk_stderr = host.stderr_clone();
	let status = request.for_each_entry_with_heartbeat(
		move || {
			if cancel.load(std::sync::atomic::Ordering::Relaxed) {
				Err(io::Error::new(io::ErrorKind::Interrupted, "cancelled"))
			} else {
				Ok(())
			}
		},
		|entry: pi_walker::EntryMeta<'_>| {
			let walk_entry =
				WalkEntry::new(entry.absolute_path.as_ref().to_path_buf(), entry.depth, config.follow);
			let mut current_dir = current_dir.borrow_mut();
			let mut ret_value = ret.get();
			let (should_quit, should_skip_current_dir) = apply_find_entry(
				walk_entry,
				operand,
				resolved_root,
				deps,
				host,
				matcher,
				&mut current_dir,
				&mut ret_value,
			);
			ret.set(ret_value);
			if should_quit {
				local_quit.set(true);
				Ok(pi_walker::WalkDecision::Stop)
			} else if should_skip_current_dir {
				Ok(pi_walker::WalkDecision::SkipDescend)
			} else {
				Ok(pi_walker::WalkDecision::Include)
			}
		},
		|error| {
			ret.set(1);
			let _ = writeln!(walk_stderr, "Error: {}: {}", error.path.display(), error.error);
			Ok(pi_walker::WalkDecision::Include)
		},
	);
	let mut current_dir = current_dir.into_inner();
	let mut ret_value = ret.get();
	match status {
		Ok(pi_walker::WalkStatus::Complete | pi_walker::WalkStatus::Stopped) => {
			finish_find_walk(deps, host, matcher, &mut current_dir, &mut ret_value);
			if local_quit.get() {
				*quit = true;
			}
			ret_value
		},
		Err(pi_walker::WalkError::Interrupted(err)) => {
			ret_value = 1;
			let _ = writeln!(host.stderr, "Error: {err}");
			finish_find_walk(deps, host, matcher, &mut current_dir, &mut ret_value);
			ret_value
		},
		Err(pi_walker::WalkError::InvalidData { path, message }) => {
			ret_value = 1;
			let _ = writeln!(host.stderr, "Error: {}: {message}", path.display());
			finish_find_walk(deps, host, matcher, &mut current_dir, &mut ret_value);
			ret_value
		},
	}
}

fn process_dir(
	dir: &str,
	config: &Config,
	deps: &dyn Dependencies,
	host: &mut Host,
	matcher: &dyn matchers::Matcher,
	quit: &mut bool,
) -> i32 {
	let resolved_root = host.resolve(dir);
	let operand = Path::new(dir);
	if config.min_depth > config.max_depth {
		let mut current_dir = None;
		let mut ret = 0;
		finish_find_walk(deps, host, matcher, &mut current_dir, &mut ret);
		return ret;
	}
	process_dir_walk_request(config, deps, host, matcher, quit, &resolved_root, operand)
}

fn do_find(args: &[&str], deps: &dyn Dependencies, host: &mut Host) -> Result<i32, Box<dyn Error>> {
	let paths_and_matcher = parse_args(args, host)?;
	if paths_and_matcher.config.help_requested {
		print_help(host);
		return Ok(0);
	}
	if paths_and_matcher.config.version_requested {
		print_version(host);
		return Ok(0);
	}

	let mut ret = 0;
	let mut quit = false;
	for path in paths_and_matcher.paths {
		let dir_ret = process_dir(
			&path,
			&paths_and_matcher.config,
			deps,
			host,
			&*paths_and_matcher.matcher,
			&mut quit,
		);
		if dir_ret != 0 {
			ret = dir_ret;
		}
		if quit {
			break;
		}
	}

	Ok(ret)
}

fn print_help(host: &mut Host) {
	let _ = writeln!(
		&mut host.stdout,
		r"Usage: find [path...] [expression]

If no path is supplied then the current working directory is used by default.

Early alpha implementation. Currently the only expressions supported are
 -print
 -print0
 -printf
 -name case-sensitive_filename_pattern
 -lname case-sensitive_filename_pattern
 -iname case-insensitive_filename_pattern
 -ilname case-insensitive_filename_pattern
 -regextype type
 -files0-from
 -regex pattern
 -iregex pattern
 -type type_char[,type_char...]
    type_char is one of f d l b c p s w
 -size [+-]N[bcwkMGTP]
 -delete
 -prune
 -not
 -a
 -o[r]
 ,
 ()
 -true
 -false
 -maxdepth N
 -mindepth N
 -d[epth]
 -xdev
 -ctime [+-]N
 -atime [+-]N
 -mtime [+-]N
 -perm [-/+]{{octal|u=rwx,go=w}}
 -newer path_to_file
 -exec[dir] executable [args] [{{}}] [more args] ;
 -sorted
    a non-standard extension that sorts directory contents by name before
    processing them. Less efficient, but allows for deterministic output.
"
	);
}

fn print_version(host: &mut Host) {
	let _ = writeln!(host.stdout, "find (Rust) 0.8.0");
}

/// pi-uutils: BSD `find -E` compatibility (macOS muscle memory).
///
/// BSD `-E` selects POSIX extended regular expressions before the path list;
/// GNU find rejects it, but supports the equivalent `-regextype
/// posix-extended`. Rewriting is limited to otherwise-unparseable invocations:
/// a valid GNU expression may use `-E` as an operand, so it must retain its
/// existing meaning. The inserted setting starts the expression, before every
/// `-regex`/`-iregex`, because matcher construction applies the current regex
/// type as it encounters those predicates.
fn rewrite_bsd_invocation(args: &[&str], host: &mut Host) -> Option<Vec<String>> {
	if !args.contains(&"-E") {
		return None;
	}
	let Err(error) = parse_args(args, host) else {
		return None;
	};
	if !error.to_string().contains("Unrecognized flag: '-E'") {
		return None;
	}

	let mut rewritten: Vec<String> = args
		.iter()
		.filter(|arg| **arg != "-E")
		.map(|arg| (*arg).to_string())
		.collect();

	let mut i = 0;
	while i < rewritten.len() {
		match rewritten[i].as_str() {
			"-O0" | "-O1" | "-O2" | "-O3" | "-H" | "-L" | "-P" | "-x" | "-s" => i += 1,
			"--" => {
				i += 1;
				break;
			},
			_ => break,
		}
	}
	while i < rewritten.len()
		&& (rewritten[i] == "-" || !rewritten[i].starts_with('-'))
		&& rewritten[i] != "!"
		&& rewritten[i] != "("
	{
		i += 1;
	}
	rewritten.splice(i..i, ["-regextype".to_string(), "posix-extended".to_string()]);
	Some(rewritten)
}

/// Parsed `find` invocation.
pub(crate) struct Find {
	matches: ArgMatches,
}

matches_parser!(Find, app);

fn app() -> Command {
	Command::new("find").version("0.8.0").arg(
		Arg::new("args")
			.action(ArgAction::Append)
			.num_args(0..)
			.allow_hyphen_values(true)
			.trailing_var_arg(true)
			.value_parser(OsStringValueParser::new()),
	)
}

impl Utility for Find {
	const NAME: &'static str = "find";

	fn run(self, host: &mut Host) -> i32 {
		let owned: Vec<String> = self
			.matches
			.get_many::<std::ffi::OsString>("args")
			.into_iter()
			.flatten()
			.map(|arg| arg.to_string_lossy().into_owned())
			.collect();
		let raw: Vec<&str> = owned.iter().map(String::as_str).collect();
		let rewritten = rewrite_bsd_invocation(&raw, host);
		let args: Vec<&str> = match &rewritten {
			Some(args) => args.iter().map(String::as_str).collect(),
			None => raw,
		};
		let deps = StandardDependencies::new(host);
		match do_find(&args, &deps, host) {
			Ok(code) => code,
			Err(error) => {
				let _ = writeln!(host.stderr, "Error: {error}");
				1
			},
		}
	}
}

/// Creates the `find` builtin registration.
pub(crate) fn find_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Find, SE>()
}

#[cfg(test)]
mod tests {
	use std::{fs, path::PathBuf};

	use super::Find;
	use crate::host::run_util;

	fn fixture() -> (tempfile::TempDir, PathBuf) {
		let dir = tempfile::tempdir().unwrap();
		let root = fs::canonicalize(dir.path()).unwrap();
		for file in ["a.txt", "b.md", "c.rs"] {
			fs::write(root.join(file), b"x").unwrap();
		}
		(dir, root)
	}

	fn run(root: &PathBuf, args: &[String]) -> (i32, crate::host::Capture) {
		let args: Vec<&str> = args.iter().map(String::as_str).collect();
		run_util::<Find>(&args, "", root)
	}

	#[test]
	fn bsd_dash_e_selects_posix_extended_regexes() {
		let (_dir, root) = fixture();
		let (code, capture) = run(
			&root,
			&[
				"-E".into(),
				root.display().to_string(),
				"-regex".into(),
				r".*\.(txt|md)".into(),
			],
		);
		assert_eq!(code, 0, "stderr: {}", capture.err());
		assert_eq!(capture.err(), "");
		let mut matches: Vec<PathBuf> = capture.out().lines().map(PathBuf::from).collect();
		matches.sort();
		assert_eq!(matches, vec![root.join("a.txt"), root.join("b.md")]);
	}

	#[test]
	fn default_regex_syntax_does_not_treat_groups_as_extended() {
		let (_dir, root) = fixture();
		let (code, capture) = run(
			&root,
			&[
				root.display().to_string(),
				"-regex".into(),
				r".*\.(txt|md)".into(),
			],
		);
		assert_eq!(code, 0, "stderr: {}", capture.err());
		assert_eq!(capture.err(), "");
		assert_eq!(capture.out(), "");
	}

	#[test]
	fn valid_gnu_expression_can_use_dash_e_as_an_operand() {
		let (_dir, root) = fixture();
		fs::write(root.join("-E"), b"x").unwrap();
		let (code, capture) = run(
			&root,
			&[root.display().to_string(), "-name".into(), "-E".into()],
		);
		assert_eq!(code, 0, "stderr: {}", capture.err());
		assert_eq!(capture.err(), "");
		assert_eq!(capture.out(), format!("{}\n", root.join("-E").display()));
	}

	#[test]
	fn resolves_relative_walk_roots_against_shell_cwd() {
		let (_dir, root) = fixture();
		let (code, capture) = run(&root, &[".".into(), "-name".into(), "a.txt".into()]);
		assert_eq!(code, 0, "stderr: {}", capture.err());
		assert_eq!(capture.err(), "");
		assert_eq!(capture.out(), "./a.txt\n");
	}

	#[cfg(unix)]
	#[test]
	fn exec_uses_shell_cwd_and_captures_child_stdout() {
		let (_dir, root) = fixture();
		let (code, capture) = run(
			&root,
			&[
				".".into(),
				"-maxdepth".into(),
				"0".into(),
				"-exec".into(),
				"pwd".into(),
				";".into(),
			],
		);
		assert_eq!(code, 0, "stderr: {}", capture.err());
		assert_eq!(capture.err(), "");
		assert_eq!(capture.out(), format!("{}\n", root.display()));
	}

	#[test]
	fn files0_from_stdin_resolves_roots_against_shell_cwd() {
		let (_dir, root) = fixture();
		fs::create_dir(root.join("sub")).unwrap();
		let (code, capture) =
			run_util::<Find>(&["-files0-from", "-", "-maxdepth", "0"], "sub\0", &root);
		assert_eq!(code, 0, "stderr: {}", capture.err());
		assert_eq!(capture.err(), "");
		assert_eq!(capture.out(), "sub\n");
	}

	/// Failure mode: `-newerXY ref` compared both X and Y timestamps of the
	/// CANDIDATE against the reference's mtime, instead of comparing the
	/// candidate's X timestamp against the reference's Y timestamp.
	#[cfg(unix)]
	#[test]
	fn newer_xy_compares_candidate_x_against_reference_y() {
		use std::{
			fs::FileTimes,
			time::{Duration, SystemTime},
		};

		let dir = tempfile::tempdir().unwrap();
		let root = fs::canonicalize(dir.path()).unwrap();
		let now = SystemTime::now();
		let old = now - Duration::from_secs(2000);
		let mid = now - Duration::from_secs(1000);

		let write_with_times = |name: &str, accessed: SystemTime, modified: SystemTime| {
			let path = root.join(name);
			fs::write(&path, b"x").unwrap();
			let file = fs::File::options().write(true).open(&path).unwrap();
			file
				.set_times(FileTimes::new().set_accessed(accessed).set_modified(modified))
				.unwrap();
		};

		write_with_times("ref", mid, mid);
		// atime newer than ref's mtime, but mtime older: -neweram must match.
		// (The old code also demanded a newer mtime and rejected this file.)
		write_with_times("hit", now, old);
		// atime older than ref's mtime: -neweram must not match.
		write_with_times("miss", old, now);

		let (code, capture) = run(
			&root,
			&[
				root.display().to_string(),
				"-type".into(),
				"f".into(),
				"-neweram".into(),
				"ref".into(),
			],
		);
		assert_eq!(code, 0, "stderr: {}", capture.err());
		assert_eq!(capture.err(), "");
		assert_eq!(capture.out(), format!("{}\n", root.join("hit").display()));
	}

	/// Failure mode: `-newermt` rejected ISO dates like `2026-01-01` with
	/// "cannot figure out how to interpret ... as a date or time".
	#[test]
	fn newermt_accepts_iso_dates() {
		let (_dir, root) = fixture();
		let (code, capture) = run(
			&root,
			&[
				root.display().to_string(),
				"-name".into(),
				"a.txt".into(),
				"-newermt".into(),
				"2000-01-01".into(),
			],
		);
		assert_eq!(code, 0, "stderr: {}", capture.err());
		assert_eq!(capture.err(), "");
		assert_eq!(capture.out(), format!("{}\n", root.join("a.txt").display()));

		let (code, capture) = run(
			&root,
			&[
				root.display().to_string(),
				"-newermt".into(),
				"3000-01-01".into(),
			],
		);
		assert_eq!(code, 0, "stderr: {}", capture.err());
		assert_eq!(capture.err(), "");
		assert_eq!(capture.out(), "");
	}

	/// Failure mode: BSD `-perm +mode` (any of the bits set) was parsed as an
	/// exact-mode pattern and failed with a parse error.
	#[cfg(unix)]
	#[test]
	fn perm_plus_mode_matches_any_set_bits() {
		use std::os::unix::fs::PermissionsExt;

		let (_dir, root) = fixture();
		fs::set_permissions(root.join("a.txt"), fs::Permissions::from_mode(0o755)).unwrap();
		fs::set_permissions(root.join("b.md"), fs::Permissions::from_mode(0o644)).unwrap();
		fs::set_permissions(root.join("c.rs"), fs::Permissions::from_mode(0o600)).unwrap();
		let (code, capture) = run(
			&root,
			&[
				root.display().to_string(),
				"-type".into(),
				"f".into(),
				"-perm".into(),
				"+111".into(),
			],
		);
		assert_eq!(code, 0, "stderr: {}", capture.err());
		assert_eq!(capture.err(), "");
		assert_eq!(capture.out(), format!("{}\n", root.join("a.txt").display()));
	}

	/// Failure mode: GNU `-type f,d` lists were rejected with "Unrecognised
	/// type argument f,d".
	#[test]
	fn type_accepts_comma_separated_list() {
		let (_dir, root) = fixture();
		fs::create_dir(root.join("sub")).unwrap();
		let (code, capture) = run(&root, &[root.display().to_string(), "-type".into(), "f,d".into()]);
		assert_eq!(code, 0, "stderr: {}", capture.err());
		assert_eq!(capture.err(), "");
		let mut matches: Vec<PathBuf> = capture.out().lines().map(PathBuf::from).collect();
		matches.sort();
		assert_eq!(matches, vec![
			root.clone(),
			root.join("a.txt"),
			root.join("b.md"),
			root.join("c.rs"),
			root.join("sub"),
		]);
	}

	/// Failure mode: BSD `-type w` (whiteout) errored instead of parsing and
	/// matching nothing.
	#[test]
	fn type_w_parses_and_matches_nothing() {
		let (_dir, root) = fixture();
		let (code, capture) = run(&root, &[root.display().to_string(), "-type".into(), "w".into()]);
		assert_eq!(code, 0, "stderr: {}", capture.err());
		assert_eq!(capture.err(), "");
		assert_eq!(capture.out(), "");
	}

	/// Failure mode: `-regex` matched substrings of the path instead of
	/// requiring the pattern to span the whole path.
	#[test]
	fn regex_matches_whole_path_only() {
		let (_dir, root) = fixture();
		let (code, capture) =
			run(&root, &[root.display().to_string(), "-regex".into(), r".*\.rs".into()]);
		assert_eq!(code, 0, "stderr: {}", capture.err());
		assert_eq!(capture.out(), format!("{}\n", root.join("c.rs").display()));

		let (code, capture) =
			run(&root, &[root.display().to_string(), "-regex".into(), r"c\.rs".into()]);
		assert_eq!(code, 0, "stderr: {}", capture.err());
		assert_eq!(capture.out(), "");
	}

	/// Failure mode: an alternation whose shorter branch matches a path prefix
	/// would win and the full-path match was missed (no backtracking retry).
	#[test]
	fn regex_full_match_prefers_longest_alternative() {
		let (_dir, root) = fixture();
		let (code, capture) = run(
			&root,
			&[
				root.display().to_string(),
				"-regextype".into(),
				"posix-extended".into(),
				"-regex".into(),
				r".*/c|.*/c\.rs".into(),
			],
		);
		assert_eq!(code, 0, "stderr: {}", capture.err());
		assert_eq!(capture.err(), "");
		assert_eq!(capture.out(), format!("{}\n", root.join("c.rs").display()));
	}

	/// Failure mode: `-size` rejected the `T` and `P` suffixes accepted by
	/// modern GNU and BSD find.
	#[test]
	fn size_accepts_t_and_p_suffixes() {
		let (_dir, root) = fixture();
		let (code, capture) = run(
			&root,
			&[
				root.display().to_string(),
				"-type".into(),
				"f".into(),
				"-size".into(),
				"-2T".into(),
			],
		);
		assert_eq!(code, 0, "stderr: {}", capture.err());
		assert_eq!(capture.err(), "");
		let mut matches: Vec<PathBuf> = capture.out().lines().map(PathBuf::from).collect();
		matches.sort();
		assert_eq!(matches, vec![root.join("a.txt"), root.join("b.md"), root.join("c.rs")]);

		let (code, capture) =
			run(&root, &[root.display().to_string(), "-size".into(), "+1P".into()]);
		assert_eq!(code, 0, "stderr: {}", capture.err());
		assert_eq!(capture.err(), "");
		assert_eq!(capture.out(), "");
	}

	/// Failure mode: BSD leading flags `-x` and `-s` were treated as unknown
	/// predicates and the invocation failed to parse.
	#[test]
	fn bsd_leading_flags_x_and_s_parse() {
		let (_dir, root) = fixture();
		let (code, capture) = run(
			&root,
			&[
				"-s".into(),
				"-x".into(),
				root.display().to_string(),
				"-type".into(),
				"f".into(),
			],
		);
		assert_eq!(code, 0, "stderr: {}", capture.err());
		assert_eq!(capture.err(), "");
		// -s guarantees lexicographically sorted output.
		let matches: Vec<PathBuf> = capture.out().lines().map(PathBuf::from).collect();
		assert_eq!(matches, vec![root.join("a.txt"), root.join("b.md"), root.join("c.rs")]);
	}
}
