//! `tail` builtin: print the last part of files and optionally follow growth.
//!
//! Ported from uutils coreutils 0.8.0.

mod args {
	//! Command-line parsing for `tail`.
	use std::{ffi::OsString, io::Write, time::Duration};
	
	use clap::{Arg, ArgAction, ArgMatches, Command, value_parser};
	use uucore::{
		display::Quotable,
		parser::{
			parse_signed_num::{SignPrefix, parse_signed_num_max},
			parse_size::ParseSizeError,
			parse_time,
			shortcut_value_parser::ShortcutValueParser,
		},
	};
	
	use crate::{
		host::{Host, format_usage},
		tail::{TailError, TailResult, paths::Input, platform},
	};
	#[cfg(test)]
	use crate::tail::parse;
	
	pub mod options {
		pub mod verbosity {
			pub const QUIET: &str = "quiet";
			pub const VERBOSE: &str = "verbose";
		}
		pub const BYTES: &str = "bytes";
		pub const FOLLOW: &str = "follow";
		pub const LINES: &str = "lines";
		pub const PID: &str = "pid";
		pub const SLEEP_INT: &str = "sleep-interval";
		pub const ZERO_TERM: &str = "zero-terminated";
		pub const DISABLE_INOTIFY_TERM: &str = "-disable-inotify"; // NOTE: three hyphens is correct
		pub const USE_POLLING: &str = "use-polling";
		pub const RETRY: &str = "retry";
		pub const FOLLOW_RETRY: &str = "F";
		pub const MAX_UNCHANGED_STATS: &str = "max-unchanged-stats";
		pub const ARG_FILES: &str = "files";
		pub const PRESUME_INPUT_PIPE: &str = "-presume-input-pipe"; // NOTE: three hyphens is correct
		pub const DEBUG: &str = "debug";
		pub const REVERSE: &str = "reverse";
		pub const BLOCKS: &str = "blocks";
	}
	
	#[derive(Clone, Copy, Debug, PartialEq, Eq)]
	pub enum Signum {
		Negative(u64),
		Positive(u64),
		PlusZero,
		MinusZero,
	}
	
	#[derive(Debug, PartialEq, Eq)]
	pub enum FilterMode {
		Bytes(Signum),
	
		/// Mode for lines delimited by delimiter as u8
		Lines(Signum, u8),
	}
	
	impl FilterMode {
		#[cfg(test)]
		fn from_obsolete_args(args: &parse::ObsoleteArgs) -> Self {
			let signum = if args.plus {
				Signum::Positive(args.num)
			} else {
				Signum::Negative(args.num)
			};
			if args.lines {
				Self::Lines(signum, b'\n')
			} else {
				Self::Bytes(signum)
			}
		}
	
		fn from(matches: &ArgMatches) -> TailResult<Self> {
			let zero_term = matches.get_flag(options::ZERO_TERM);
			let mode = if let Some(arg) = matches.get_one::<String>(options::BYTES) {
				match parse_num(arg) {
					Ok(signum) => Self::Bytes(signum),
					Err(e) => {
						return Err(TailError::message(format!("invalid number of bytes: {e}")));
					},
				}
			} else if let Some(arg) = matches.get_one::<String>(options::LINES) {
				match parse_num(arg) {
					Ok(signum) => {
						let delimiter = if zero_term { 0 } else { b'\n' };
						Self::Lines(signum, delimiter)
					},
					Err(_) => {
						return Err(TailError::message(format!(
							"invalid number of lines: {}",
							arg.quote()
						)));
					},
				}
			} else if zero_term {
				Self::default_zero()
			} else {
				Self::default()
			};
	
			Ok(mode)
		}
	
		fn default_zero() -> Self {
			Self::Lines(Signum::Negative(10), 0)
		}
	}
	
	impl Default for FilterMode {
		fn default() -> Self {
			Self::Lines(Signum::Negative(10), b'\n')
		}
	}
	
	#[derive(Debug, PartialEq, Eq, Clone, Copy)]
	pub enum FollowMode {
		Descriptor,
		Name,
	}
	
	#[derive(Debug)]
	pub enum VerificationResult {
		Ok,
		CannotFollowStdinByName,
		NoOutput,
	}
	
	#[derive(Debug)]
	pub struct Settings {
		pub follow:              Option<FollowMode>,
		pub max_unchanged_stats: u32,
		pub mode:                FilterMode,
		pub pid:                 platform::Pid,
		pub retry:               bool,
		pub sleep_sec:           Duration,
		pub use_polling:         bool,
		pub verbose:             bool,
		pub presume_input_pipe:  bool,
		pub debug:               bool,
		/// `FILE(s)` positional arguments
		pub inputs:              Vec<Input>,
	}
	
	impl Default for Settings {
		fn default() -> Self {
			Self {
				max_unchanged_stats: 5,
				sleep_sec:           Duration::from_secs_f32(1.0),
				follow:              Option::default(),
				mode:                FilterMode::default(),
				pid:                 Default::default(),
				retry:               Default::default(),
				use_polling:         Default::default(),
				verbose:             Default::default(),
				presume_input_pipe:  Default::default(),
				debug:               Default::default(),
				inputs:              Vec::default(),
			}
		}
	}
	
	impl Settings {
		#[cfg(test)]
		pub fn from_obsolete_args(args: &parse::ObsoleteArgs, name: Option<&OsString>) -> Self {
			let mut settings = Self::default();
			if args.follow {
				settings.follow = if name.is_some() {
					Some(FollowMode::Name)
				} else {
					Some(FollowMode::Descriptor)
				};
			}
			settings.mode = FilterMode::from_obsolete_args(args);
			let input = if let Some(name) = name {
				Input::from(name)
			} else {
				Input::default()
			};
			settings.inputs.push(input);
			settings
		}
	
		pub fn from(matches: &ArgMatches) -> TailResult<Self> {
			// We're parsing --follow, -F and --retry under the following conditions:
			// * -F sets --retry and --follow=name
			// * plain --follow or short -f is the same like specifying --follow=descriptor
			// * All these options and flags can occur multiple times as command line
			//   arguments
			let follow_retry = matches.get_flag(options::FOLLOW_RETRY);
			// We don't need to check for occurrences of --retry if -F was specified which
			// already sets retry
			let retry = follow_retry || matches.get_flag(options::RETRY);
			let follow = match (
	            follow_retry,
	            matches
	                .get_one::<String>(options::FOLLOW)
	                .map(String::as_str),
	        ) {
	            // -F and --follow if -F is specified after --follow. We don't need to care about the
	            // value of --follow.
	            (true, Some(_))
	                // It's ok to use `index_of` instead of `indices_of` since -F and  --follow
	                // overwrite themselves (not only the value but also the index).
	                if matches.index_of(options::FOLLOW_RETRY) > matches.index_of(options::FOLLOW) =>
	            {
	                Some(FollowMode::Name)
	            }
	            // * -F and --follow=name if --follow=name is specified after -F
	            // * No occurrences of -F but --follow=name
	            // * -F and no occurrences of --follow
	            (_, Some("name")) | (true, None) => Some(FollowMode::Name),
	            // * -F and --follow=descriptor (or plain --follow, -f) if --follow=descriptor is
	            // specified after -F
	            // * No occurrences of -F but --follow=descriptor, --follow, -f
	            (_, Some(_)) => Some(FollowMode::Descriptor),
	            // The default for no occurrences of -F or --follow
	            (false, None) => None,
	        };
	
			let mut settings: Self = Self {
				follow,
				retry,
				use_polling: matches.get_flag(options::USE_POLLING),
				mode: FilterMode::from(matches)?,
				verbose: matches.get_flag(options::verbosity::VERBOSE),
				presume_input_pipe: matches.get_flag(options::PRESUME_INPUT_PIPE),
				debug: matches.get_flag(options::DEBUG),
				..Default::default()
			};
	
			if let Some(source) = matches.get_one::<String>(options::SLEEP_INT) {
				settings.sleep_sec = parse_time::from_str(source, false)
					.map_err(|_| TailError::message(format!("invalid number of seconds: '{source}'")))?;
			}
	
			if let Some(s) = matches.get_one::<String>(options::MAX_UNCHANGED_STATS) {
				settings.max_unchanged_stats = match s.parse::<u32>() {
					Ok(s) => s,
					Err(_) => {
						return Err(TailError::message(format!(
							"invalid maximum number of unchanged stats between opens: {}",
							s.quote()
						)));
					},
				};
			}
			if let Some(pid_str) = matches.get_one::<String>(options::PID) {
				match pid_str.parse() {
					Ok(pid) => {
						// NOTE: on unix platform::Pid is i32, on windows platform::Pid is u32
						#[cfg(unix)]
						if pid < 0 {
							// NOTE: tail only accepts an unsigned pid
							return Err(TailError::message(format!("invalid PID: {}", pid_str.quote())));
						}
	
						settings.pid = pid;
					},
					Err(e) => {
						return Err(TailError::message(format!(
							"invalid PID: {}: {}",
							pid_str.quote(),
							e
						)));
					},
				}
			}
	
			settings.inputs = matches
				.get_many::<OsString>(options::ARG_FILES)
				.map_or_else(|| vec![Input::default()], |v| v.map(Input::from).collect());
	
			settings.verbose = (matches.get_flag(options::verbosity::VERBOSE)
				|| settings.inputs.len() > 1)
				&& !matches.get_flag(options::verbosity::QUIET);
	
			Ok(settings)
		}
	
		/// Resolves every file operand against the shell working directory.
		pub fn resolve_paths(&mut self, host: &Host) {
			for input in &mut self.inputs {
				input.resolve_path(host);
			}
		}
	
	
		/// Prints warnings for valid but ineffective option combinations.
		pub fn check_warnings(&self, stderr: &mut impl Write) {
			if self.retry {
				if self.follow.is_none() {
					let _ = writeln!(
						stderr,
						"tail: warning: --retry ignored; --retry is useful only when following"
					);
				} else if self.follow == Some(FollowMode::Descriptor) {
					let _ = writeln!(
						stderr,
						"tail: warning: --retry only effective for the initial open"
					);
				}
			}
	
			if self.pid != 0 {
				if self.follow.is_none() {
					let _ = writeln!(
						stderr,
						"tail: warning: PID ignored; --pid=PID is useful only when following"
					);
				} else if !platform::supports_pid_checks(self.pid) {
					let _ = writeln!(
						stderr,
						"tail: warning: --pid=PID is not supported on this system"
					);
				}
			}
		}
	
		/// Verify [`Settings`] and try to find unsolvable misconfigurations of tail
		/// originating from user provided command line arguments. In contrast to
		/// [`Settings::check_warnings`] these misconfigurations usually lead to the
		/// immediate exit or abortion of the running `tail` process.
		pub fn verify(&self) -> VerificationResult {
			// Mimic GNU's tail for `tail -F`
			if self.inputs.iter().any(Input::is_stdin) && self.follow == Some(FollowMode::Name) {
				return VerificationResult::CannotFollowStdinByName;
			}
	
			// Mimic GNU's tail for -[nc]0 without -f and exit immediately
			if self.follow.is_none()
				&& matches!(
					self.mode,
					FilterMode::Lines(Signum::MinusZero, _) | FilterMode::Bytes(Signum::MinusZero)
				) {
				return VerificationResult::NoOutput;
			}
	
			VerificationResult::Ok
		}
	}

	fn parse_num(src: &str) -> Result<Signum, ParseSizeError> {
		let result = parse_signed_num_max(src)?;
		let is_plus = result.sign == Some(SignPrefix::Plus);

		match (result.value, is_plus) {
			(0, true) => Ok(Signum::PlusZero),
			(0, false) => Ok(Signum::MinusZero),
			(n, true) => Ok(Signum::Positive(n)),
			(n, false) => Ok(Signum::Negative(n)),
		}
	}
	
	
	pub fn uu_app() -> Command {
		#[cfg(target_os = "linux")]
		let polling_help = "Disable 'inotify' support and use polling instead";
		#[cfg(all(unix, not(target_os = "linux")))]
		let polling_help = "Disable 'kqueue' support and use polling instead";
		#[cfg(target_os = "windows")]
		let polling_help = "Disable 'ReadDirectoryChanges' support and use polling instead";
		#[cfg(not(any(unix, target_os = "windows")))]
		let polling_help = "Disable 'kqueue' support and use polling instead";
	
		Command::new("tail")
			.version("0.8.0")
			.about(
				"Print the last 10 lines of each FILE to standard output.\nWith more than one FILE, \
				 precede each with a header giving the file name.\nWith no FILE, or when FILE is -, read \
				 standard input.\nMandatory arguments to long flags are mandatory for short flags too.",
			)
			.override_usage(format_usage("tail [FLAG]... [FILE]..."))
			.infer_long_args(true)
			.arg(
				Arg::new(options::BYTES)
					.short('c')
					.long(options::BYTES)
					.allow_hyphen_values(true)
					.overrides_with_all([options::BYTES, options::LINES])
					.help("Number of bytes to print"),
			)
			.arg(
				Arg::new(options::FOLLOW)
					.short('f')
					.long(options::FOLLOW)
					.default_missing_value("descriptor")
					.num_args(0..=1)
					.require_equals(true)
					.value_parser(ShortcutValueParser::new(["descriptor", "name"]))
					.overrides_with(options::FOLLOW)
					.help("Print the file as it grows"),
			)
			.arg(
				Arg::new(options::LINES)
					.short('n')
					.long(options::LINES)
					.allow_hyphen_values(true)
					.overrides_with_all([options::BYTES, options::LINES])
					.help("Number of lines to print"),
			)
			.arg(
				Arg::new(options::PID)
					.long(options::PID)
					.value_name("PID")
					.help("With -f, terminate after process ID, PID dies")
					.overrides_with(options::PID),
			)
			.arg(
				Arg::new(options::verbosity::QUIET)
					.short('q')
					.long(options::verbosity::QUIET)
					.visible_alias("silent")
					.overrides_with_all([options::verbosity::QUIET, options::verbosity::VERBOSE])
					.help("Never output headers giving file names")
					.action(ArgAction::SetTrue),
			)
			.arg(
				Arg::new(options::SLEEP_INT)
					.short('s')
					.value_name("N")
					.long(options::SLEEP_INT)
					.help("Number of seconds to sleep between polling the file when running with -f"),
			)
			.arg(
				Arg::new(options::MAX_UNCHANGED_STATS)
					.value_name("N")
					.long(options::MAX_UNCHANGED_STATS)
					.help(
						"Reopen a FILE which has not changed size after N (default 5) iterations to see if \
						 it has been unlinked or renamed (this is the usual case of rotated log files); \
						 This option is meaningful only when polling (i.e., with --use-polling) and when \
						 --follow=name",
					),
			)
			.arg(
				Arg::new(options::verbosity::VERBOSE)
					.short('v')
					.long(options::verbosity::VERBOSE)
					.overrides_with_all([options::verbosity::QUIET, options::verbosity::VERBOSE])
					.help("Always output headers giving file names")
					.action(ArgAction::SetTrue),
			)
			.arg(
				Arg::new(options::ZERO_TERM)
					.short('z')
					.long(options::ZERO_TERM)
					.help("Line delimiter is NUL, not newline")
					.action(ArgAction::SetTrue),
			)
			.arg(
				Arg::new(options::USE_POLLING)
					.alias(options::DISABLE_INOTIFY_TERM) // NOTE: Used by GNU's test suite
					.alias("dis") // NOTE: Used by GNU's test suite
					.long(options::USE_POLLING)
					.help(polling_help)
					.action(ArgAction::SetTrue),
			)
			.arg(
				Arg::new(options::RETRY)
					.long(options::RETRY)
					.help("Keep trying to open a file if it is inaccessible")
					.overrides_with(options::RETRY)
					.action(ArgAction::SetTrue),
			)
			.arg(
				Arg::new(options::FOLLOW_RETRY)
					.short('F')
					.help("Same as --follow=name --retry")
					.overrides_with(options::FOLLOW_RETRY)
					.action(ArgAction::SetTrue),
			)
			.arg(
				Arg::new(options::DEBUG)
					.long(options::DEBUG)
					.help("indicate which --follow implementation is used")
					.action(ArgAction::SetTrue),
			)
			.arg(
				Arg::new(options::PRESUME_INPUT_PIPE)
					.long("presume-input-pipe")
					.alias(options::PRESUME_INPUT_PIPE)
					.hide(true)
					.action(ArgAction::SetTrue),
			)
			.arg(
				Arg::new(options::REVERSE)
					.short('r')
					.long(options::REVERSE)
					.hide(true)
					.action(ArgAction::SetTrue),
			)
			.arg(
				Arg::new(options::BLOCKS)
					.short('b')
					.hide(true)
					.action(ArgAction::SetTrue),
			)
			.arg(
				Arg::new(options::ARG_FILES)
					.action(ArgAction::Append)
					.num_args(1..)
					.value_parser(value_parser!(OsString))
					.value_hint(clap::ValueHint::FilePath),
			)
	}
	
	#[cfg(test)]
	mod tests {
		use super::*;
		use crate::tail::parse::ObsoleteArgs;
	
		#[test]
		fn test_parse_num_when_sign_is_given() {
			let result = parse_num("+0");
			assert!(result.is_ok());
			assert_eq!(result.unwrap(), Signum::PlusZero);
	
			let result = parse_num("+1");
			assert!(result.is_ok());
			assert_eq!(result.unwrap(), Signum::Positive(1));
	
			let result = parse_num("-0");
			assert!(result.is_ok());
			assert_eq!(result.unwrap(), Signum::MinusZero);
	
			let result = parse_num("-1");
			assert!(result.is_ok());
			assert_eq!(result.unwrap(), Signum::Negative(1));
		}
	
		#[test]
		fn test_parse_num_when_no_sign_is_given() {
			let result = parse_num("0");
			assert!(result.is_ok());
			assert_eq!(result.unwrap(), Signum::MinusZero);
	
			let result = parse_num("1");
			assert!(result.is_ok());
			assert_eq!(result.unwrap(), Signum::Negative(1));
		}
	
		#[test]
		fn test_parse_obsolete_settings_f() {
			let args = ObsoleteArgs { follow: true, ..Default::default() };
			let result = Settings::from_obsolete_args(&args, None);
			assert_eq!(result.follow, Some(FollowMode::Descriptor));
	
			let result = Settings::from_obsolete_args(&args, Some(&"file".into()));
			assert_eq!(result.follow, Some(FollowMode::Name));
		}
	
		#[test]
		fn test_parse_settings_follow_mode_and_retry() {
			let cases: &[(&[&str], Option<FollowMode>, bool)] = &[
				(&[], None, false),
				(&["--retry"], None, true),
				(&["--retry", "--retry"], None, true),
				(&["--follow"], Some(FollowMode::Descriptor), false),
				(&["-f"], Some(FollowMode::Descriptor), false),
				(&["--follow", "--retry"], Some(FollowMode::Descriptor), true),
				(&["-f", "--retry"], Some(FollowMode::Descriptor), true),
				(
					&["--follow=name", "--follow=descriptor"],
					Some(FollowMode::Descriptor),
					false,
				),
				(
					&["--follow=descriptor", "--follow=name"],
					Some(FollowMode::Name),
					false,
				),
				(&["-F"], Some(FollowMode::Name), true),
				(&["-F", "-F"], Some(FollowMode::Name), true),
				(&["-F", "--retry"], Some(FollowMode::Name), true),
				(&["-F", "--follow=descriptor"], Some(FollowMode::Descriptor), true),
				(&["-F", "--follow=descriptor", "-F"], Some(FollowMode::Name), true),
				(&["-F", "-f"], Some(FollowMode::Descriptor), true),
				(&["--follow=descriptor", "-F"], Some(FollowMode::Name), true),
				(&["-f", "-F"], Some(FollowMode::Name), true),
				(&["-F", "--follow=name"], Some(FollowMode::Name), true),
				(&["--follow=name", "-F"], Some(FollowMode::Name), true),
				(
					&["--follow=name", "-F", "--follow=descriptor"],
					Some(FollowMode::Descriptor),
					true,
				),
				(
					&["--follow=name", "-F", "--follow=name"],
					Some(FollowMode::Name),
					true,
				),
				(&["-f", "-F", "-f"], Some(FollowMode::Descriptor), true),
				(&["-f", "-F", "-f", "-F"], Some(FollowMode::Name), true),
			];

			for &(args, expected_follow_mode, expected_retry) in cases {
				let settings =
					Settings::from(&uu_app().no_binary_name(true).get_matches_from(args)).unwrap();
				assert_eq!(settings.follow, expected_follow_mode, "args: {args:?}");
				assert_eq!(settings.retry, expected_retry, "args: {args:?}");
			}
		}
	}
}

mod chunks {
	// This file is part of the uutils coreutils package.
	//
	// For the full copyright and license information, please view the LICENSE
	// file that was distributed with this source code.
	
	//! Iterating over a file by chunks, either starting at the end of the file with
	//! [`ReverseChunks`] or at the end of piped stdin with [`LinesChunk`] or
	//! [`BytesChunk`].
	//!
	//! Use [`ReverseChunks::new`] to create a new iterator over chunks of bytes
	//! from the file.
	
	
	use std::{
		collections::VecDeque,
		fs::File,
		io::{self, BufRead, Read, Seek, SeekFrom, Write},
	};
	
	/// When reading files in reverse in `bounded_tail`, this is the size of each
	/// block read at a time.
	pub const BLOCK_SIZE: u64 = 1 << 16;
	
	/// The size of the backing buffer of a [`LinesChunk`] or [`BytesChunk`] in
	/// bytes. The value of `BUFFER_SIZE` originates from the BUFSIZ constant in
	/// stdio.h and the libc crate to make stream IO efficient. In the latter the
	/// value is constantly set to 8192 on all platforms, where the value in stdio.h
	/// is determined on each platform differently. Since libc chose 8192 as a
	/// reasonable default the value here is set to this value, too.
	pub const BUFFER_SIZE: usize = 8192;
	
	/// An iterator over a file in non-overlapping chunks from the end of the file.
	///
	/// Each chunk is a [`Vec`]<[`u8`]> of size [`BLOCK_SIZE`] (except
	/// possibly the last chunk, which might be smaller). Each call to
	/// [`ReverseChunks::next`] will seek backwards through the given file.
	pub struct ReverseChunks<'a> {
		/// The file to iterate over, by blocks, from the end to the beginning.
		file: &'a File,
	
		/// The total number of bytes in the file.
		size: u64,
	
		/// The total number of blocks to read.
		max_blocks_to_read: usize,
	
		/// The index of the next block to read.
		block_idx: usize,
	}
	
	impl<'a> ReverseChunks<'a> {
		pub fn new(file: &'a mut File) -> Self {
			let current = if cfg!(unix) {
				file.stream_position().unwrap()
			} else {
				0
			};
			let size = file.seek(SeekFrom::End(0)).unwrap() - current;
			let max_blocks_to_read = (size as f64 / BLOCK_SIZE as f64).ceil() as usize;
			let block_idx = 0;
			ReverseChunks { file, size, max_blocks_to_read, block_idx }
		}
	}
	
	impl Iterator for ReverseChunks<'_> {
		type Item = Vec<u8>;
	
		fn next(&mut self) -> Option<Self::Item> {
			// If there are no more chunks to read, terminate the iterator.
			if self.block_idx >= self.max_blocks_to_read {
				return None;
			}
	
			// The chunk size is `BLOCK_SIZE` for all but the last chunk
			// (that is, the chunk closest to the beginning of the file),
			// which contains the remainder of the bytes.
			let block_size = if self.block_idx == self.max_blocks_to_read - 1 {
				self.size % BLOCK_SIZE
			} else {
				BLOCK_SIZE
			};
	
			// Seek backwards by the next chunk, read the full chunk into
			// `buf`, and then seek back to the start of the chunk again.
			let mut buf = vec![0; BLOCK_SIZE as usize];
			let pos = self
				.file
				.seek(SeekFrom::Current(-(block_size as i64)))
				.unwrap();
			self
				.file
				.read_exact(&mut buf[0..(block_size as usize)])
				.unwrap();
			let pos2 = self
				.file
				.seek(SeekFrom::Current(-(block_size as i64)))
				.unwrap();
			assert_eq!(pos, pos2);
	
			self.block_idx += 1;
	
			Some(buf[0..(block_size as usize)].to_vec())
		}
	}
	
	/// The type of the backing buffer of [`BytesChunk`] and [`LinesChunk`] which
	/// can hold [`BUFFER_SIZE`] elements at max.
	type ChunkBuffer = [u8; BUFFER_SIZE];
	
	/// A [`BytesChunk`] storing a fixed size number of bytes in a buffer.
	#[derive(Clone, PartialEq, Eq, Debug)]
	pub struct BytesChunk {
		/// The [`ChunkBuffer`], an array storing the bytes, for example filled by
		/// [`BytesChunk::fill`]
		buffer: ChunkBuffer,
	
		/// Stores the number of bytes, this buffer holds. This is not equal to
		/// `buffer.len()`, since the [`BytesChunk`] may store less bytes than the
		/// internal buffer can hold. In addition, [`BytesChunk`] may be reused,
		/// what makes it necessary to track the number of stored bytes. The choice
		/// of usize is sufficient here, since the number of bytes max value is
		/// [`BUFFER_SIZE`], which is a usize.
		bytes: usize,
	}
	
	impl BytesChunk {
		#[allow(clippy::new_without_default, reason = "upstream chunk constructor is intentionally explicit")]
		pub fn new() -> Self {
			Self { buffer: [0; BUFFER_SIZE], bytes: 0 }
		}
	
		/// Create a new chunk from an existing chunk. The new chunk's buffer will be
		/// copied from the old chunk's buffer, copying the slice
		/// `[offset..old_chunk.bytes]` into the new chunk's buffer but starting at
		/// 0 instead of offset. If the offset is larger or equal to `chunk.lines`
		/// then a new empty `BytesChunk` is returned.
		///
		/// # Arguments
		///
		/// * `chunk`: The chunk to create a new `BytesChunk` chunk from
		/// * `offset`: Start to copy the old chunk's buffer from this position. May
		///   not be larger than `chunk.bytes`.
		///
		/// # Examples
		///
		/// ```rust,ignore
		/// let mut chunk = BytesChunk::new();
		/// chunk.buffer[1] = 1;
		/// chunk.bytes = 2;
		/// let new_chunk = BytesChunk::from_chunk(&chunk, 0);
		/// assert_eq!(2, new_chunk.get_buffer().len());
		/// assert_eq!(&[0, 1], new_chunk.get_buffer());
		///
		/// let new_chunk = BytesChunk::from_chunk(&chunk, 1);
		/// assert_eq!(1, new_chunk.get_buffer().len());
		/// assert_eq!(&[1], new_chunk.get_buffer());
		/// ```
		fn from_chunk(chunk: &Self, offset: usize) -> Self {
			if offset >= chunk.bytes {
				return Self::new();
			}
	
			let mut buffer: ChunkBuffer = [0; BUFFER_SIZE];
			let slice = chunk.get_buffer_with(offset);
			buffer[..slice.len()].copy_from_slice(slice);
			Self { buffer, bytes: chunk.bytes - offset }
		}
	
		/// Receive the internal buffer safely, so it returns a slice only containing
		/// as many bytes as large the `self.bytes` value is.
		///
		/// returns: a slice containing the bytes of the internal buffer from
		/// `[0..self.bytes]`
		///
		/// # Examples
		///
		/// ```rust,ignore
		/// let mut chunk = BytesChunk::new();
		/// chunk.bytes = 1;
		/// assert_eq!(&[0], chunk.get_buffer());
		/// ```
		pub fn get_buffer(&self) -> &[u8] {
			&self.buffer[..self.bytes]
		}
	
		/// Like [`BytesChunk::get_buffer`], but returning a slice from
		/// `[offset.self.bytes]`.
		///
		/// returns: a slice containing the bytes of the internal buffer from
		/// `[offset..self.bytes]`
		///
		/// # Examples
		///
		/// ```rust,ignore
		/// let mut chunk = BytesChunk::new();
		/// chunk.bytes = 2;
		/// assert_eq!(&[0], chunk.get_buffer_with(1));
		/// ```
		pub fn get_buffer_with(&self, offset: usize) -> &[u8] {
			&self.buffer[offset..self.bytes]
		}
	
		pub fn has_data(&self) -> bool {
			self.bytes > 0
		}
	
		/// Fills `self.buffer` with maximal [`BUFFER_SIZE`] number of bytes,
		/// draining the reader by that number of bytes. If EOF is reached (so 0
		/// bytes are read), it returns `Ok(None)`; otherwise, it returns
		/// `Ok(Some(bytes))`, where bytes is the number of bytes read from
		/// the source.
		pub fn fill(&mut self, filehandle: &mut impl BufRead) -> io::Result<Option<usize>> {
			let num_bytes = filehandle.read(&mut self.buffer)?;
			self.bytes = num_bytes;
			if num_bytes == 0 {
				return Ok(None);
			}
	
			Ok(Some(self.bytes))
		}
	}
	
	/// An abstraction layer on top of [`BytesChunk`] mainly to simplify filling
	/// only the needed amount of chunks. See also [`Self::fill`].
	pub struct BytesChunkBuffer {
		/// The number of bytes to print
		num_print: u64,
		/// The current number of bytes summed over all stored chunks in
		/// [`Self::chunks`]. Use u64 here to support files > 4GB on 32-bit systems.
		/// Note, this differs from `BytesChunk::bytes` which is a usize. The choice
		/// of u64 is based on `tail::FilterMode::Bytes`.
		bytes:     u64,
		/// The buffer to store [`BytesChunk`] in
		chunks:    VecDeque<Box<BytesChunk>>,
	}
	
	impl BytesChunkBuffer {
		/// Creates a new [`BytesChunkBuffer`].
		///
		/// # Arguments
		///
		/// * `num_print`: The number of bytes to print
		///
		/// # Examples
		///
		/// ```rust,ignore
		/// let mut chunk = BytesChunk::new();
		/// chunk.buffer[1] = 1;
		/// chunk.bytes = 2;
		/// let new_chunk = BytesChunk::from_chunk(&chunk, 0);
		/// assert_eq!(2, new_chunk.get_buffer().len());
		/// assert_eq!(&[0, 1], new_chunk.get_buffer());
		///
		/// let new_chunk = BytesChunk::from_chunk(&chunk, 1);
		/// assert_eq!(1, new_chunk.get_buffer().len());
		/// assert_eq!(&[1], new_chunk.get_buffer());
		/// ```
		pub fn new(num_print: u64) -> Self {
			Self { bytes: 0, num_print, chunks: VecDeque::new() }
		}
	
		/// Fills this buffer with chunks and consumes the reader completely. This
		/// method ensures that there are exactly as many chunks as needed to match
		/// `self.num_print` bytes, so there are in sum exactly `self.num_print`
		/// bytes stored in all chunks. The method returns an iterator over these
		/// chunks. If there are no chunks, for example because the piped stdin
		/// contained no bytes, or `num_print = 0` then `iterator.next` returns
		/// None.
		///
		/// # Examples
		///
		/// ```rust,ignore
		/// use crate::tail::chunks::BytesChunkBuffer;
		/// use std::io::{BufReader, Cursor};
		///
		/// let mut reader = BufReader::new(Cursor::new(""));
		/// let num_print = 0;
		/// let mut chunks = BytesChunkBuffer::new(num_print);
		/// chunks.fill(&mut reader).unwrap();
		///
		/// let mut reader = BufReader::new(Cursor::new("a"));
		/// let num_print = 1;
		/// let mut chunks = BytesChunkBuffer::new(num_print);
		/// chunks.fill(&mut reader).unwrap();
		/// ```
		pub fn fill(&mut self, reader: &mut impl BufRead) -> io::Result<()> {
			let mut chunk = Box::new(BytesChunk::new());
	
			// fill chunks with all bytes from reader and reuse already instantiated chunks
			// if possible
			while chunk.fill(reader)?.is_some() {
				self.bytes += chunk.bytes as u64;
				self.chunks.push_back(chunk.clone());
	
				let first = &self.chunks[0];
				if self.bytes - first.bytes as u64 > self.num_print {
					chunk = self.chunks.pop_front().unwrap();
					self.bytes -= chunk.bytes as u64;
				} else {
					*chunk = BytesChunk::new();
				}
			}
	
			// quit early if there are no chunks for example in case the pipe was empty
			if self.chunks.is_empty() {
				return Ok(());
			}
	
			let chunk = self.chunks.pop_front().unwrap();
	
			// calculate the offset in the first chunk and put the calculated chunk as first
			// element in the self.chunks collection. The calculated offset must be in the
			// range 0 to BUFFER_SIZE and is therefore safely convertible to a usize
			// without losses.
			let offset = self.bytes.saturating_sub(self.num_print) as usize;
			self
				.chunks
				.push_front(Box::new(BytesChunk::from_chunk(&chunk, offset)));
	
			Ok(())
		}
	
		pub fn print(&self, writer: &mut impl Write) -> io::Result<()> {
			for chunk in &self.chunks {
				writer.write_all(chunk.get_buffer())?;
			}
			Ok(())
		}
	
		pub fn has_data(&self) -> bool {
			!self.chunks.is_empty()
		}
	}
	
	/// Works similar to a [`BytesChunk`] but also stores the number of lines
	/// encountered in the current buffer. The size of the buffer is limited to a
	/// fixed size number of bytes.
	#[derive(Clone, Debug)]
	pub struct LinesChunk {
		/// Work on top of a [`BytesChunk`]
		chunk:     BytesChunk,
		/// The number of lines delimited by `delimiter`. The choice of usize is
		/// sufficient here, because lines max value is the number of bytes
		/// contained in this chunk's buffer, and the number of bytes max value is
		/// [`BUFFER_SIZE`], which is a usize.
		lines:     usize,
		/// The delimiter to use, to count the lines
		delimiter: u8,
	}
	
	impl LinesChunk {
		pub fn new(delimiter: u8) -> Self {
			Self { chunk: BytesChunk::new(), lines: 0, delimiter }
		}
	
		/// Count the number of lines delimited with [`Self::delimiter`] contained in
		/// the buffer. Currently [`memchr`] is used because performance is better
		/// than using an iterator or for loop.
		///
		/// # Examples
		///
		/// ```rust,ignore
		/// let mut chunk = LinesChunk::new(b'\n');
		/// chunk.buffer[0..12].copy_from_slice("hello\nworld\n".as_bytes());
		/// chunk.bytes = 12;
		/// assert_eq!(2, chunk.count_lines());
		///
		/// chunk.buffer[0..14].copy_from_slice("hello\r\nworld\r\n".as_bytes());
		/// chunk.bytes = 14;
		/// assert_eq!(2, chunk.count_lines());
		/// ```
		fn count_lines(&self) -> usize {
			memchr::memchr_iter(self.delimiter, self.get_buffer()).count()
		}
	
		/// Creates a new [`LinesChunk`] from an existing one with an offset in
		/// lines. The new chunk contains exactly `chunk.lines - offset` lines. The
		/// offset in bytes is calculated and applied to the new chunk, so the new
		/// chunk contains only the bytes encountered after the offset in
		/// number of lines and the `delimiter`. If the offset is larger than
		/// `chunk.lines` then a new empty `LinesChunk` is returned.
		///
		/// # Arguments
		///
		/// * `chunk`: The chunk to create the new chunk from
		/// * `offset`: The offset in number of lines (not bytes)
		///
		/// # Examples
		///
		/// ```rust,ignore
		/// let mut chunk = LinesChunk::new(b'\n');
		/// // manually filling the buffer and setting the correct values for bytes and lines
		/// chunk.buffer[0..12].copy_from_slice("hello\nworld\n".as_bytes());
		/// chunk.bytes = 12;
		/// chunk.lines = 2;
		///
		/// let offset = 1; // offset in number of lines
		/// let new_chunk = LinesChunk::from(&chunk, offset);
		/// assert_eq!("world\n".as_bytes(), new_chunk.get_buffer());
		/// assert_eq!(6, new_chunk.bytes);
		/// assert_eq!(1, new_chunk.lines);
		/// ```
		fn from_chunk(chunk: &Self, offset: usize) -> Self {
			if offset > chunk.lines {
				return Self::new(chunk.delimiter);
			}
	
			let bytes_offset = chunk.calculate_bytes_offset_from(offset);
			let new_chunk = BytesChunk::from_chunk(&chunk.chunk, bytes_offset);
	
			Self { chunk: new_chunk, lines: chunk.lines - offset, delimiter: chunk.delimiter }
		}
	
		/// Returns true if this buffer has stored any bytes.
		///
		/// # Examples
		///
		/// ```rust,ignore
		/// let mut chunk = LinesChunk::new(b'\n');
		/// assert!(!chunk.has_data());
		///
		/// chunk.buffer[0] = 1;
		/// assert!(!chunk.has_data());
		///
		/// chunk.bytes = 1;
		/// assert!(chunk.has_data());
		/// ```
		pub fn has_data(&self) -> bool {
			self.chunk.has_data()
		}
	
		/// Returns this buffer safely. See [`BytesChunk::get_buffer`]
		///
		/// returns: &[u8] with length `self.bytes`
		pub fn get_buffer(&self) -> &[u8] {
			self.chunk.get_buffer()
		}
	
		/// Returns this buffer safely with an offset applied. See
		/// [`BytesChunk::get_buffer_with`].
		///
		/// returns: &[u8] with length `self.bytes - offset`
		pub fn get_buffer_with(&self, offset: usize) -> &[u8] {
			self.chunk.get_buffer_with(offset)
		}
	
		/// Return the number of lines the buffer contains. `self.lines` needs to be
		/// set before the call to this function returns the correct value. If the
		/// calculation of lines is needed then use `self.count_lines`.
		pub fn get_lines(&self) -> usize {
			self.lines
		}
	
		/// Fills `self.buffer` with maximal [`BUFFER_SIZE`] number of bytes,
		/// draining the reader by that number of bytes. This function works like
		/// the [`BytesChunk::fill`] function besides that this function also counts
		/// and stores the number of lines encountered while reading from
		/// the `filehandle`.
		pub fn fill(&mut self, filehandle: &mut impl BufRead) -> io::Result<Option<usize>> {
			match self.chunk.fill(filehandle)? {
				None => {
					self.lines = 0;
					Ok(None)
				},
				Some(bytes) => {
					self.lines = self.count_lines();
					Ok(Some(bytes))
				},
			}
		}
	
		/// Calculates the offset in bytes within this buffer from the offset in
		/// number of lines. The resulting offset is 0-based and points to the byte
		/// after the delimiter.
		///
		/// # Arguments
		///
		/// * `offset`: the offset in number of lines. If offset is 0 then 0 is
		///   returned, if larger than the contained lines then self.bytes is
		///   returned.
		///
		/// # Examples
		///
		/// ```rust,ignore
		/// let mut chunk = LinesChunk::new(b'\n');
		/// chunk.buffer[0..12].copy_from_slice("hello\nworld\n".as_bytes());
		/// chunk.bytes = 12;
		/// chunk.lines = 2; // note that if not setting lines the result might not be what is expected
		/// let bytes_offset = chunk.calculate_bytes_offset_from(1);
		/// assert_eq!(6, bytes_offset);
		/// assert_eq!(
		///     "world\n",
		///     String::from_utf8_lossy(chunk.get_buffer_with(bytes_offset)));
		/// ```
		fn calculate_bytes_offset_from(&self, offset: usize) -> usize {
			let mut lines_offset = offset;
			let mut bytes_offset = 0;
			for byte in self.get_buffer() {
				if lines_offset == 0 {
					break;
				}
				if byte == &self.delimiter {
					lines_offset -= 1;
				}
				bytes_offset += 1;
			}
			bytes_offset
		}
	
		/// Write the bytes contained in this buffer calculated with the given offset
		/// in number of lines.
		///
		/// # Arguments
		///
		/// * `writer`: must implement [`Write`]
		/// * `offset`: An offset in number of lines.
		pub fn write_lines(&self, writer: &mut impl Write, offset: usize) -> io::Result<()> {
			self.write_bytes(writer, self.calculate_bytes_offset_from(offset))
		}
	
		/// Write the bytes contained in this buffer beginning from the given offset
		/// in number of bytes.
		///
		/// # Arguments
		///
		/// * `writer`: must implement [`Write`]
		/// * `offset`: An offset in number of bytes.
		pub fn write_bytes(&self, writer: &mut impl Write, offset: usize) -> io::Result<()> {
			writer.write_all(self.get_buffer_with(offset))?;
			Ok(())
		}
	}
	
	/// An abstraction layer on top of [`LinesChunk`] mainly to simplify filling
	/// only the needed amount of chunks. See also [`Self::fill`]. Works similar
	/// like [`BytesChunkBuffer`], but works on top of lines delimited by
	/// `self.delimiter` instead of bytes.
	pub struct LinesChunkBuffer {
		/// The delimiter to recognize a line. Any [`u8`] is allowed.
		delimiter: u8,
		/// The amount of lines occurring in all currently stored [`LinesChunk`]s.
		/// Use u64 here to support files > 4GB on 32-bit systems. Note, this
		/// differs from [`LinesChunk::lines`] which is a usize. The choice of u64
		/// is based on `tail::FilterMode::Lines`.
		lines:     u64,
		/// The amount of lines to print.
		num_print: u64,
		/// Stores the [`LinesChunk`]
		chunks:    VecDeque<Box<LinesChunk>>,
	}
	
	impl LinesChunkBuffer {
		/// Create a new [`LinesChunkBuffer`]
		pub fn new(delimiter: u8, num_print: u64) -> Self {
			Self { delimiter, num_print, lines: 0, chunks: VecDeque::new() }
		}
	
		/// Fills this buffer with chunks and consumes the reader completely. This
		/// method ensures that there are exactly as many chunks as needed to match
		/// `self.num_print` lines, so there are in sum exactly `self.num_print`
		/// lines stored in all chunks. The method returns an iterator over these
		/// chunks. If there are no chunks, for example because the piped stdin
		/// contained no lines, or `num_print = 0` then `iterator.next` will return
		/// None.
		pub fn fill(&mut self, reader: &mut impl BufRead) -> io::Result<()> {
			let mut chunk = Box::new(LinesChunk::new(self.delimiter));
	
			while chunk.fill(reader)?.is_some() {
				self.lines += chunk.lines as u64;
				self.chunks.push_back(chunk.clone());
	
				let first = &self.chunks[0];
				if self.lines - first.lines as u64 > self.num_print {
					chunk = self.chunks.pop_front().unwrap();
	
					self.lines -= chunk.lines as u64;
				} else {
					*chunk = LinesChunk::new(self.delimiter);
				}
			}
	
			if self.chunks.is_empty() {
				// chunks is empty when a file is empty so quitting early here
				return Ok(());
			}
	
			let length = &self.chunks.len();
			let last = &mut self.chunks[length - 1];
			if !last.get_buffer().ends_with(&[self.delimiter]) {
				last.lines += 1;
				self.lines += 1;
			}
	
			// skip unnecessary chunks and save the first chunk which may hold some lines we
			// have to print
			let chunk = loop {
				// it's safe to call unwrap here because there is at least one chunk and sorting
				// out more chunks than exist shouldn't be possible.
				let chunk = self.chunks.pop_front().unwrap();
	
				// skip is true as long there are enough lines left in the other stored chunks.
				let skip = self.lines - chunk.lines as u64 > self.num_print;
				if skip {
					self.lines -= chunk.lines as u64;
				} else {
					break chunk;
				}
			};
	
			// Calculate the number of lines to skip in the current chunk. The calculated
			// value must be in the range 0 to BUFFER_SIZE and is therefore safely
			// convertible to a usize without losses.
			let skip_lines = self.lines.saturating_sub(self.num_print) as usize;
			let chunk = LinesChunk::from_chunk(&chunk, skip_lines);
			self.chunks.push_front(Box::new(chunk));
	
			Ok(())
		}
	
		pub fn write(&self, mut writer: impl Write) -> io::Result<()> {
			for chunk in &self.chunks {
				chunk.write_bytes(&mut writer, 0)?;
			}
			Ok(())
		}
	}
	
	#[cfg(test)]
	mod tests {
		use crate::tail::chunks::{BUFFER_SIZE, BytesChunk};
	
		#[test]
		fn test_bytes_chunk_from_when_offset_is_zero() {
			let mut chunk = BytesChunk::new();
			chunk.bytes = BUFFER_SIZE;
			chunk.buffer[1] = 1;
			let other = BytesChunk::from_chunk(&chunk, 0);
			assert_eq!(other, chunk);
	
			chunk.bytes = 2;
			let other = BytesChunk::from_chunk(&chunk, 0);
			assert_eq!(other, chunk);
	
			chunk.bytes = 1;
			let other = BytesChunk::from_chunk(&chunk, 0);
			assert_eq!(other.buffer, [0; BUFFER_SIZE]);
			assert_eq!(other.bytes, chunk.bytes);
	
			chunk.bytes = BUFFER_SIZE;
			let other = BytesChunk::from_chunk(&chunk, 2);
			assert_eq!(other.buffer, [0; BUFFER_SIZE]);
			assert_eq!(other.bytes, BUFFER_SIZE - 2);
		}
	
		#[test]
		fn test_bytes_chunk_from_when_offset_is_not_zero() {
			let mut chunk = BytesChunk::new();
			chunk.bytes = BUFFER_SIZE;
			chunk.buffer[1] = 1;
	
			let other = BytesChunk::from_chunk(&chunk, 1);
			let mut expected_buffer = [0; BUFFER_SIZE];
			expected_buffer[0] = 1;
			assert_eq!(other.buffer, expected_buffer);
			assert_eq!(other.bytes, BUFFER_SIZE - 1);
	
			let other = BytesChunk::from_chunk(&chunk, 2);
			assert_eq!(other.buffer, [0; BUFFER_SIZE]);
			assert_eq!(other.bytes, BUFFER_SIZE - 2);
		}
	
		#[test]
		fn test_bytes_chunk_from_when_offset_is_larger_than_chunk_size_1() {
			let mut chunk = BytesChunk::new();
			chunk.bytes = BUFFER_SIZE;
			let new_chunk = BytesChunk::from_chunk(&chunk, BUFFER_SIZE + 1);
			assert_eq!(0, new_chunk.bytes);
		}
	
		#[test]
		fn test_bytes_chunk_from_when_offset_is_larger_than_chunk_size_2() {
			let mut chunk = BytesChunk::new();
			chunk.bytes = 0;
			let new_chunk = BytesChunk::from_chunk(&chunk, 1);
			assert_eq!(0, new_chunk.bytes);
		}
	
		#[test]
		fn test_bytes_chunk_from_when_offset_is_larger_than_chunk_size_3() {
			let mut chunk = BytesChunk::new();
			chunk.bytes = 1;
			let new_chunk = BytesChunk::from_chunk(&chunk, 2);
			assert_eq!(0, new_chunk.bytes);
		}
	
		#[test]
		fn test_bytes_chunk_from_when_offset_is_equal_to_chunk_size() {
			let mut chunk = BytesChunk::new();
			chunk.buffer[0] = 1;
			chunk.bytes = 1;
			let new_chunk = BytesChunk::from_chunk(&chunk, 1);
			assert_eq!(0, new_chunk.bytes);
		}
	}
}

mod follow {
	// This file is part of the uutils coreutils package.
	//
	// For the full copyright and license information, please view the LICENSE
	// file that was distributed with this source code.
	
	#[cfg(not(target_os = "wasi"))]
	mod files {
		//! File handle management for `tail --follow`.
		use std::{
			collections::{HashMap, hash_map::Keys},
			fs::{File, Metadata},
			io::{BufRead, BufReader, Write},
			path::{Path, PathBuf},
		};
		
		use crate::tail::{
			TailResult,
			args::Settings,
			chunks::BytesChunkBuffer,
			paths::{HeaderPrinter, PathExtTail},
			text,
		};
		
		/// Data structure to keep a handle on files to follow.
		/// `last` always holds the path/key of the last file that was printed from.
		/// The keys of the [`HashMap`] can point to an existing file path (normal
		/// case), or stdin ("-"), or to a non-existing path (--retry).
		/// For existing files, all keys in the [`HashMap`] are absolute Paths.
		pub struct FileHandling {
			map:            HashMap<PathBuf, PathData>,
			last:           Option<PathBuf>,
			header_printer: HeaderPrinter,
		}
		
		impl FileHandling {
			pub fn from(settings: &Settings) -> Self {
				Self {
					map:            HashMap::with_capacity(settings.inputs.len()),
					last:           None,
					header_printer: HeaderPrinter::new(settings.verbose, false),
				}
			}
		
			/// Wrapper for [`HashMap::insert`] using [`Path::canonicalize`]
			pub fn insert(&mut self, k: &Path, v: PathData, update_last: bool) {
				let k = Self::canonicalize_path(k);
				if update_last {
					self.last = Some(k.clone());
				}
				let _ = self.map.insert(k, v);
			}
		
			/// Wrapper for [`HashMap::remove`] using [`Path::canonicalize`]
			pub fn remove(&mut self, k: &Path) -> PathData {
				self.map.remove(&Self::canonicalize_path(k)).unwrap()
			}
		
			/// Wrapper for [`HashMap::get`] using [`Path::canonicalize`]
			pub fn get(&self, k: &Path) -> &PathData {
				self.map.get(&Self::canonicalize_path(k)).unwrap()
			}
		
			/// Wrapper for [`HashMap::get_mut`] using [`Path::canonicalize`]
			pub fn get_mut(&mut self, k: &Path) -> &mut PathData {
				self.map.get_mut(&Self::canonicalize_path(k)).unwrap()
			}
		
			/// Canonicalize `path` if it is not already an absolute path
			fn canonicalize_path(path: &Path) -> PathBuf {
				if path.is_relative()
					&& !path.is_stdin()
					&& let Ok(p) = path.canonicalize()
				{
					return p;
				}
				path.to_owned()
			}
		
			pub fn get_mut_metadata(&mut self, path: &Path) -> Option<&Metadata> {
				self.get_mut(path).metadata.as_ref()
			}
		
			pub fn keys(&self) -> Keys<'_, PathBuf, PathData> {
				self.map.keys()
			}
		
			pub fn contains_key(&self, k: &Path) -> bool {
				self.map.contains_key(k)
			}
		
			pub fn get_last(&self) -> Option<&PathBuf> {
				self.last.as_ref()
			}
		
			/// Return true if there is only stdin remaining
			pub fn only_stdin_remaining(&self) -> bool {
				self.map.len() == 1 && (self.map.contains_key(Path::new(text::DASH)))
			}
		
			/// Return true if there is at least one "tailable" path (or stdin) remaining
			pub fn files_remaining(&self) -> bool {
				for path in self.map.keys() {
					if path.is_tailable() || path.is_stdin() {
						return true;
					}
				}
				false
			}
		
			/// Returns true if there are no files remaining
			pub fn no_files_remaining(&self, settings: &Settings) -> bool {
				self.map.is_empty() || !self.files_remaining() && !settings.retry
			}
		
			/// Set `reader` to None to indicate that `path` is not an existing file
			/// anymore.
			pub fn reset_reader(&mut self, path: &Path) {
				self.get_mut(path).reader = None;
			}
		
			/// Reopen the file at the monitored `path`
			pub fn update_reader(&mut self, path: &Path) -> TailResult<()> {
				/*
				BUG: If it's not necessary to reopen a file, GNU's tail calls seek to offset 0.
				However, we can't call seek here because `BufRead` does not implement `Seek`.
				As a workaround, we always reopen the file even though this might not always
				be necessary.
				*/
				self
					.get_mut(path)
					.reader
					.replace(Box::new(BufReader::new(File::open(path)?)));
				Ok(())
			}
		
			/// Reload metadata from `path`, or `metadata`
			pub fn update_metadata(&mut self, path: &Path, metadata: Option<Metadata>) {
				self.get_mut(path).metadata = if metadata.is_some() {
					metadata
				} else {
					path.metadata().ok()
				};
			}
		
			/// Read new data from `path` and print it to stdout
			pub fn tail_file(
				&mut self,
				path: &Path,
				verbose: bool,
				writer: &mut impl Write,
			) -> TailResult<bool> {
				let mut chunks = BytesChunkBuffer::new(u64::MAX);
				if let Some(reader) = self.get_mut(path).reader.as_mut() {
					chunks.fill(reader)?;
				}
				if chunks.has_data() {
					if self.needs_header(path, verbose) {
						let display_name = self.get(path).display_name.clone();
						self.header_printer.print(display_name.as_str(), writer);
					}
		
					chunks.print(writer).map_err(crate::tail::map_output_error)?;
					writer.flush().map_err(crate::tail::map_output_error)?;
		
					self.last.replace(path.to_owned());
					self.update_metadata(path, None);
					Ok(true)
				} else {
					Ok(false)
				}
			}
		
			/// Decide if printing `path` needs a header based on when it was last
			/// printed
			pub fn needs_header(&self, path: &Path, verbose: bool) -> bool {
				if verbose {
					if let Some(ref last) = self.last {
						!last.eq(&path)
					} else {
						true
					}
				} else {
					false
				}
			}
		}
		
		/// Data structure to keep a handle on the [`BufReader`], [`Metadata`]
		/// and the `display_name` (`header_name`) of files that are being followed.
		pub struct PathData {
			pub reader:       Option<Box<dyn BufRead>>,
			pub metadata:     Option<Metadata>,
			pub display_name: String,
		}
		
		impl PathData {
			pub fn new(
				reader: Option<Box<dyn BufRead>>,
				metadata: Option<Metadata>,
				display_name: &str,
			) -> Self {
				Self { reader, metadata, display_name: display_name.to_owned() }
			}
		
			pub fn from_other_with_path(data: Self, path: &Path) -> Self {
				// Remove old reader
				let old_reader = data.reader;
				let reader = if old_reader.is_some() {
					// Use old reader with the same file descriptor if there is one
					old_reader
				} else if let Ok(file) = File::open(path) {
					// Open new file tail from start
					Some(Box::new(BufReader::new(file)) as Box<dyn BufRead>)
				} else {
					// Probably file was renamed/moved or removed again
					None
				};
		
				Self::new(reader, path.metadata().ok(), data.display_name.as_str())
			}
		}
	}
	
	#[cfg(not(target_os = "wasi"))]
	mod watch {
		//! Notification and polling follow loop.
		use std::{
			io::{BufRead, Write},
			path::{Path, PathBuf},
			sync::{
				Arc,
				atomic::{AtomicBool, Ordering},
				mpsc::{self, Receiver, channel},
			},
			time::Duration,
		};
		
		use notify::{RecommendedWatcher, RecursiveMode, Watcher, WatcherKind};
		#[cfg(target_os = "linux")]
		use uucore::signals::ensure_stdout_not_broken;
		use uucore::display::Quotable;
		
		use brush_core::openfiles::OpenFile;
		
		use crate::{
			host::{Host, StreamWriter},
			tail::{
				TailError,
				TailResult,
				args::{FollowMode, Settings},
				follow::files::{FileHandling, PathData},
				paths::{Input, InputKind, MetadataExtTail, PathExtTail},
				platform, text,
			},
		};
		
		pub struct WatcherRx {
			watcher:  Box<dyn Watcher>,
			receiver: Receiver<Result<notify::Event, notify::Error>>,
		}
		
		impl WatcherRx {
			fn new(
				watcher: Box<dyn Watcher>,
				receiver: Receiver<Result<notify::Event, notify::Error>>,
			) -> Self {
				Self { watcher, receiver }
			}
		
			/// Wrapper for `notify::Watcher::watch` to also add the parent directory of
			/// `path` if necessary.
			fn watch_with_parent(&mut self, path: &Path) -> TailResult<()> {
				let mut path = path.to_owned();
				#[cfg(target_os = "linux")]
				if path.is_file() {
					/*
					NOTE: Using the parent directory instead of the file is a workaround.
					This workaround follows the recommendation of the notify crate authors:
					> On some platforms, if the `path` is renamed or removed while being watched, behavior may
					> be unexpected. See discussions in [#165] and [#166]. If less surprising behavior is wanted
					> one may non-recursively watch the _parent_ directory as well and manage related events.
					NOTE: Adding both: file and parent results in duplicate/wrong events.
					Tested for notify::InotifyWatcher and for notify::PollWatcher.
					*/
					if let Some(parent) = path.parent() {
						if parent.is_dir() {
							path = parent.to_owned();
						} else {
							path = PathBuf::from(".");
						}
					} else {
						return Err(TailError::message(format!("cannot watch parent directory of {}", path.quote())));
					}
				}
				if path.is_relative() {
					path = path.canonicalize()?;
				}
		
				// for syscalls: 2x "inotify_add_watch" ("filename" and ".") and 1x
				// "inotify_rm_watch"
				self.watch(&path, RecursiveMode::NonRecursive)?;
				Ok(())
			}
		
			fn watch(&mut self, path: &Path, mode: RecursiveMode) -> TailResult<()> {
				self
					.watcher
					.watch(path, mode)
					.map_err(|err| TailError::message(err.to_string()))
			}
		
			fn unwatch(&mut self, path: &Path) -> TailResult<()> {
				self
					.watcher
					.unwatch(path)
					.map_err(|err| TailError::message(err.to_string()))
			}
		}
		
		pub struct Observer {
			/// Whether --retry was given on the command line
			pub retry: bool,
		
			/// The [`FollowMode`]
			pub follow: Option<FollowMode>,
		
			/// Indicates whether to use the fallback `polling` method instead of the
			/// platform specific event driven method. Since `use_polling` is subject to
			/// change during runtime it is moved out of [`Settings`].
			pub use_polling: bool,
		
			pub watcher_rx: Option<WatcherRx>,
			pub orphans:    Vec<PathBuf>,
			pub files:      FileHandling,
		
			pub pid: platform::Pid,
			pub stdout: StreamWriter,
			pub stderr: OpenFile,
			pub cancel: Arc<AtomicBool>,
		}
		
		impl Observer {
			pub fn new(
				retry: bool,
				follow: Option<FollowMode>,
				use_polling: bool,
				files: FileHandling,
				pid: platform::Pid,
				stdout: StreamWriter,
				stderr: OpenFile,
				cancel: Arc<AtomicBool>,
			) -> Self {
				let pid = if platform::supports_pid_checks(pid) {
					pid
				} else {
					0
				};
		
				Self {
					retry,
					follow,
					use_polling,
					watcher_rx: None,
					orphans: Vec::new(),
					files,
					pid,
					stdout,
					stderr,
					cancel,
				}
			}
		
			pub fn from(
				settings: &Settings,
				stdout: StreamWriter,
				stderr: OpenFile,
				cancel: Arc<AtomicBool>,
			) -> Self {
				Self::new(
					settings.retry,
					settings.follow,
					settings.use_polling,
					FileHandling::from(settings),
					settings.pid,
					stdout,
					stderr,
					cancel,
				)
			}
		
			pub fn add_path(
				&mut self,
				path: &Path,
				display_name: &str,
				reader: Option<Box<dyn BufRead>>,
				update_last: bool,
			) -> TailResult<()> {
				if self.follow.is_some() {
					let path = if path.is_relative() {
						std::env::current_dir()?.join(path)
					} else {
						path.to_owned()
					};
					let metadata = path.metadata().ok();
					self
						.files
						.insert(&path, PathData::new(reader, metadata, display_name), update_last);
				}
		
				Ok(())
			}
		
			pub fn add_bad_path(
				&mut self,
				path: &Path,
				display_name: &str,
				update_last: bool,
			) -> TailResult<()> {
				if self.retry && self.follow.is_some() {
					return self.add_path(path, display_name, None, update_last);
				}
		
				Ok(())
			}
		
			pub fn start(&mut self, settings: &Settings, host: &mut Host) -> TailResult<()> {
				if settings.follow.is_none() {
					return Ok(());
				}
		
				let (tx, rx) = channel();
		
				/*
				Watcher is implemented per platform using the best implementation available on that
				platform. In addition to such event driven implementations, a polling implementation
				is also provided that should work on any platform.
				Linux / Android: inotify
				macOS: FSEvents / kqueue
				Windows: ReadDirectoryChangesWatcher
				FreeBSD / NetBSD / OpenBSD / DragonflyBSD: kqueue
				Fallback: polling every n seconds
		
				NOTE:
				We force the use of kqueue with: features=["macos_kqueue"].
				On macOS only `kqueue` is suitable for our use case because `FSEvents`
				waits for file close util it delivers a modify event. See:
				https://github.com/notify-rs/notify/issues/240
				*/
		
				let watcher: Box<dyn Watcher>;
				let watcher_config = notify::Config::default()
					.with_poll_interval(settings.sleep_sec)
					/*
					NOTE: By enabling compare_contents, performance will be significantly impacted
					as all files will need to be read and hashed at each `poll_interval`.
					However, this is necessary to pass: "gnu/tests/tail-2/F-vs-rename.sh"
					*/
					.with_compare_contents(true);
				if self.use_polling || RecommendedWatcher::kind() == WatcherKind::PollWatcher {
					self.use_polling = true; // We have to use polling because there's no supported backend
					watcher = Box::new(notify::PollWatcher::new(tx, watcher_config).unwrap());
				} else {
					let tx_clone = tx.clone();
					match RecommendedWatcher::new(tx, notify::Config::default()) {
						Ok(w) => watcher = Box::new(w),
						Err(e) if e.to_string().starts_with("Too many open files") => {
							/*
							NOTE: This ErrorKind is `Uncategorized`, but it is not recommended
							to match an error against `Uncategorized`
							NOTE: Could be tested with decreasing `max_user_instances`, e.g.:
							`sudo sysctl fs.inotify.max_user_instances=64`
							*/
							let _ = writeln!(
								self.stderr,
								"tail: {} cannot be used, reverting to polling: Too many open files",
								text::BACKEND
							);
							host.fail(1);
							self.use_polling = true;
							watcher = Box::new(notify::PollWatcher::new(tx_clone, watcher_config).unwrap());
						},
						Err(e) => return Err(TailError::message(e.to_string())),
					}
				}
		
				self.watcher_rx = Some(WatcherRx::new(watcher, rx));
				self.init_files(&settings.inputs)?;
		
				Ok(())
			}
		
			pub fn follow_descriptor(&self) -> bool {
				self.follow == Some(FollowMode::Descriptor)
			}
		
			pub fn follow_name(&self) -> bool {
				self.follow == Some(FollowMode::Name)
			}
		
			pub fn follow_descriptor_retry(&self) -> bool {
				self.follow_descriptor() && self.retry
			}
		
			pub fn follow_name_retry(&self) -> bool {
				self.follow_name() && self.retry
			}
		
			fn init_files(&mut self, inputs: &Vec<Input>) -> TailResult<()> {
				if let Some(watcher_rx) = &mut self.watcher_rx {
					for input in inputs {
						match input.kind() {
							InputKind::Stdin => (),
							InputKind::File(path) => {
								#[cfg(all(unix, not(target_os = "linux")))]
								if !path.is_file() {
									continue;
								}
								let mut path = path.clone();
								if path.is_relative() {
									path = std::env::current_dir()?.join(path);
								}
		
								if path.is_tailable() {
									// Add existing regular files to `Watcher` (InotifyWatcher).
									watcher_rx.watch_with_parent(&path)?;
								} else if !path.is_orphan() {
									// If `path` is not a tailable file, add its parent to `Watcher`.
									watcher_rx.watch(path.parent().unwrap(), RecursiveMode::NonRecursive)?;
									// Add symlinks to orphans for retry polling (target may not exist)
									if path.is_symlink() {
										self.orphans.push(path);
									}
								} else {
									// If there is no parent, add `path` to `orphans`.
									self.orphans.push(path);
								}
							},
						}
					}
				}
				Ok(())
			}
		
			#[allow(clippy::cognitive_complexity, reason = "preserves upstream notify event state machine")]
			fn handle_event(&mut self, event: &notify::Event, settings: &Settings) -> TailResult<Vec<PathBuf>> {
				use notify::event::{
					CreateKind, DataChange, EventKind, MetadataKind, ModifyKind, RemoveKind, RenameMode,
				};
		
				let event_path = event.paths.first().unwrap();
				let mut paths: Vec<PathBuf> = vec![];
				let display_name = self.files.get(event_path).display_name.clone();
		
				match event.kind {
		            EventKind::Modify(ModifyKind::Metadata(MetadataKind::Any | MetadataKind::WriteTime) | ModifyKind::Data(DataChange::Any) | ModifyKind::Name(RenameMode::To)) |
		            EventKind::Create(CreateKind::File | CreateKind::Folder | CreateKind::Any) => {
		                if let Ok(new_md) = event_path.metadata() {
		                    let is_tailable = new_md.is_tailable();
		                    let pd = self.files.get(event_path);
		                    if let Some(old_md) = &pd.metadata {
		                        if is_tailable {
		                            // We resume tracking from the start of the file,
		                            // assuming it has been truncated to 0. This mimics GNU's `tail`
		                            // behavior and is the usual truncation operation for log files.
		                            if !old_md.is_tailable() {
		                                let _ = writeln!(
		                                    self.stderr,
		                                    "tail: {} has become accessible",
		                                    display_name.quote()
		                                );
		                                self.files.update_reader(event_path)?;
		                            } else if pd.reader.is_none() {
		                                let _ = writeln!(
		                                    self.stderr,
		                                    "tail: {} has appeared;  following new file",
		                                    display_name.quote()
		                                );
		                                self.files.update_reader(event_path)?;
		                            } else if event.kind == EventKind::Modify(ModifyKind::Name(RenameMode::To))
		                            || (self.use_polling && !old_md.file_id_eq(&new_md)) {
		                                let _ = writeln!(
		                                    self.stderr,
		                                    "tail: {} has been replaced;  following new file",
		                                    display_name.quote()
		                                );
		                                self.files.update_reader(event_path)?;
		                            } else if old_md.got_truncated(&new_md)? {
		                                let _ = writeln!(
		                                    self.stderr,
		                                    "tail: {}: file truncated",
		                                    display_name
		                                );
		                                self.files.update_reader(event_path)?;
		                            }
		                            paths.push(event_path.clone());
		                        } else if !is_tailable && old_md.is_tailable() {
		                            if pd.reader.is_some() {
		                                self.files.reset_reader(event_path);
		                            } else {
		                                let _ = writeln!(
		                                    self.stderr,
		                                    "tail: {} has been replaced with an untailable file",
		                                    display_name.quote()
		                                );
		                            }
		                        }
		                    } else if is_tailable {
		                        let _ = writeln!(
		                            self.stderr,
		                            "tail: {} has appeared;  following new file",
		                            display_name.quote()
		                        );
		                        self.files.update_reader(event_path)?;
		                        paths.push(event_path.clone());
		                    } else if settings.retry {
		                        if self.follow_descriptor() {
		                            let _ = writeln!(
		                                self.stderr,
		                                "tail: {} has been replaced with an untailable file; giving up on this name",
		                                display_name.quote()
		                            );
		                            let _ = self.watcher_rx.as_mut().unwrap().watcher.unwatch(event_path);
		                            self.files.remove(event_path);
		                            if self.files.no_files_remaining(settings) {
		                                return Err(TailError::message("no files remaining".to_string()));
		                            }
		                        } else {
		                            let _ = writeln!(
		                                self.stderr,
		                                "tail: {} has been replaced with an untailable file",
		                                display_name.quote()
		                            );
		                        }
		                    }
		                    self.files.update_metadata(event_path, Some(new_md));
		                } else if event_path.is_symlink() && settings.retry {
		                    self.files.reset_reader(event_path);
		                    self.orphans.push(event_path.clone());
		                }
		            }
		            EventKind::Remove(RemoveKind::File | RemoveKind::Any)
		
		                // | EventKind::Modify(ModifyKind::Name(RenameMode::Any))
		                | EventKind::Modify(ModifyKind::Name(RenameMode::From)) => {
		                if self.follow_name() {
		                    if settings.retry {
		                        if let Some(old_md) = self.files.get_mut_metadata(event_path)
		                            && old_md.is_tailable() && self.files.get(event_path).reader.is_some() {
		                                let _ = writeln!(
		                                    self.stderr,
		                                    "tail: {} has become inaccessible: No such file or directory",
		                                    display_name.quote()
		                                );
		                            }
		                        if event_path.is_orphan() && !self.orphans.contains(event_path) {
		                            let _ = writeln!(
		                                self.stderr,
		                                "tail: directory containing watched file was removed"
		                            );
		                            let _ = writeln!(
		                                self.stderr,
		                                "tail: {} cannot be used, reverting to polling",
		                                text::BACKEND
		                            );
		                            self.orphans.push(event_path.clone());
		                            let _ = self.watcher_rx.as_mut().unwrap().unwatch(event_path);
		                        }
		                    } else {
		                        let _ = writeln!(
		                            self.stderr,
		                            "tail: {}: No such file or directory",
		                            display_name
		                        );
		                        if !self.files.files_remaining() && self.use_polling {
		                            // NOTE: GNU's tail exits here for `---disable-inotify`
		                            return Err(TailError::message("no files remaining".to_string()));
		                        }
		                    }
		                    self.files.reset_reader(event_path);
		                } else if self.follow_descriptor_retry() {
		                    // --retry only effective for the initial open
		                    let _ = self.watcher_rx.as_mut().unwrap().unwatch(event_path);
		                    self.files.remove(event_path);
		                } else if self.use_polling && event.kind == EventKind::Remove(RemoveKind::Any) {
		                    /*
		                    BUG: The watched file was removed. Since we're using Polling, this
		                    could be a rename. We can't tell because `notify::PollWatcher` doesn't
		                    recognize renames properly.
		                    Ideally we want to call seek to offset 0 on the file handle.
		                    But because we only have access to `PathData::reader` as `BufRead`,
		                    we cannot seek to 0 with `BufReader::seek_relative`.
		                    Also because we don't have the new name, we cannot work around this
		                    by simply reopening the file.
		                    */
		                }
		            }
		            EventKind::Modify(ModifyKind::Name(RenameMode::Both))
		                /*
		                NOTE: For `tail -f a`, keep tracking additions to b after `mv a b`
		                (gnu/tests/tail-2/descriptor-vs-rename.sh)
		                NOTE: The File/BufReader doesn't need to be updated.
		                However, we need to update our `files.map`.
		                This can only be done for inotify, because this EventKind does not
		                trigger for the PollWatcher.
		                BUG: As a result, there's a bug if polling is used:
		                $ tail -f file_a ---disable-inotify
		                $ mv file_a file_b
		                $ echo A >> file_b
		                $ echo A >> file_a
		                The last append to file_a is printed, however this shouldn't be because
		                after the "mv" tail should only follow "file_b".
		                TODO: [2022-05; jhscheer] add test for this bug
		                */
		
		                if self.follow_descriptor() => {
		                    let new_path = event.paths.last().unwrap();
		                    paths.push(new_path.clone());
		
		                    let new_data = PathData::from_other_with_path(self.files.remove(event_path), new_path);
		                    self.files.insert(
		                        new_path,
		                        new_data,
		                        self.files.get_last().unwrap() == event_path
		                    );
		
		                    // Unwatch old path and watch new path
		                    let _ = self.watcher_rx.as_mut().unwrap().unwatch(event_path);
		                    self.watcher_rx.as_mut().unwrap().watch_with_parent(new_path)?;
		                }
		            _ => {}
		        }
				Ok(paths)
			}
		}
		
		#[allow(clippy::cognitive_complexity, reason = "preserves upstream follow loop")]
		pub fn follow(mut observer: Observer, settings: &Settings) -> TailResult<()> {
			if observer.files.no_files_remaining(settings) && !observer.files.only_stdin_remaining() {
				return Err(TailError::message("no files remaining".to_string()));
			}
		
			let process = platform::ProcessChecker::new(observer.pid);
		
			let mut timeout_counter = 0;
		
			// main follow loop
			loop {
				if observer.cancel.load(Ordering::Relaxed) {
					break;
				}
				let mut _read_some = false;
		
				// If `--pid=p`, tail checks whether process p
				// is alive at least every `--sleep-interval=N` seconds
				if settings.follow.is_some() && observer.pid != 0 && process.is_dead() {
					// p is dead, tail will also terminate
					break;
				}
		
				// For `-F` we need to poll if an orphan path becomes available during runtime.
				// If a path becomes an orphan during runtime, it will be added to orphans.
				// To be able to differentiate between the cases of test_retry8 and test_retry9,
				// here paths will not be removed from orphans if the path becomes available.
				if observer.follow_name_retry() {
					for new_path in &observer.orphans {
						if new_path.exists() {
							let pd = observer.files.get(new_path);
							let md = new_path.metadata().unwrap();
							if md.is_tailable() && pd.reader.is_none() {
								let _ = writeln!(
									observer.stderr,
									"tail: {} has appeared;  following new file",
									pd.display_name.quote()
								);
								observer.files.update_metadata(new_path, Some(md));
								observer.files.update_reader(new_path)?;
								_read_some =
									observer.files.tail_file(new_path, settings.verbose, &mut observer.stdout)?;
								observer
									.watcher_rx
									.as_mut()
									.unwrap()
									.watch_with_parent(new_path)?;
							}
						}
					}
				}
		
				// With  -f, sleep for approximately N seconds (default 1.0) between iterations;
				// We wake up if Notify sends an Event or if we wait more than `sleep_sec`.
				let rx_result = observer
					.watcher_rx
					.as_mut()
					.unwrap()
					.receiver
					.recv_timeout(settings.sleep_sec.min(Duration::from_millis(100)));
		
				if rx_result.is_ok() {
					timeout_counter = 0;
				}
		
				let mut paths = vec![]; // Paths worth checking for new content to print
		
				// Helper closure to process a single event
				let process_event = |observer: &mut Observer,
				                     event: notify::Event,
				                     settings: &Settings,
				                     paths: &mut Vec<PathBuf>|
				 -> TailResult<()> {
					if let Some(event_path) = event.paths.first()
						&& observer.files.contains_key(event_path)
					{
						// Handle Event if it is about a path that we are monitoring
						let new_paths = observer.handle_event(&event, settings)?;
						for p in new_paths {
							if !paths.contains(&p) {
								paths.push(p);
							}
						}
					}
					Ok(())
				};
		
				match rx_result {
					Ok(Ok(event)) => {
						process_event(&mut observer, event, settings, &mut paths)?;
		
						// Drain any additional pending events to batch them together.
						// This prevents redundant headers when multiple inotify events
						// are queued (e.g., after resuming from SIGSTOP).
						// Multiple iterations with spin_loop hints give the notify
						// background thread chances to deliver pending events.
						for _ in 0..100 {
							while let Ok(Ok(event)) = observer.watcher_rx.as_mut().unwrap().receiver.try_recv() {
								process_event(&mut observer, event, settings, &mut paths)?;
							}
							// Use both yield and spin hint for broader CPU support
							std::thread::yield_now();
							std::hint::spin_loop();
						}
					},
					Ok(Err(notify::Error { kind: notify::ErrorKind::Io(e), paths }))
						if e.kind() == std::io::ErrorKind::NotFound =>
					{
						if let Some(event_path) = paths.first()
							&& observer.files.contains_key(event_path)
						{
							let _ = observer
								.watcher_rx
								.as_mut()
								.unwrap()
								.watcher
								.unwatch(event_path);
						}
					},
					Ok(Err(notify::Error { kind: notify::ErrorKind::MaxFilesWatch, .. })) => {
						return Err(TailError::message(format!("{} resources exhausted", text::BACKEND)));
					},
					Ok(Err(e)) => {
						return Err(TailError::message(format!("NotifyError: {}", e)));
					},
					Err(mpsc::RecvTimeoutError::Timeout) => {
						timeout_counter += 1;
						// Check if stdout pipe is still open
						#[cfg(target_os = "linux")]
						if let Ok(false) = ensure_stdout_not_broken() {
							return Ok(());
						}
					},
					Err(e) => {
						return Err(TailError::message(format!("RecvTimeoutError: {}", e)));
					},
				}
		
				if observer.use_polling && settings.follow.is_some() {
					// Consider all files to potentially have new content.
					// This is a workaround because `Notify::PollWatcher`
					// does not recognize the "renaming" of files.
					paths = observer.files.keys().cloned().collect::<Vec<_>>();
				}
		
				// main print loop
				for path in &paths {
					_read_some = observer.files.tail_file(path, settings.verbose, &mut observer.stdout)?;
				}
		
				if timeout_counter == settings.max_unchanged_stats {
					/*
					TODO: [2021-10; jhscheer] implement timeout_counter for each file.
					'--max-unchanged-stats=n'
					When tailing a file by name, if there have been n (default n=5) consecutive iterations
					for which the file has not changed, then open/fstat the file to determine if that file
					name is still associated with the same device/inode-number pair as before. When
					following a log file that is rotated, this is approximately the number of seconds
					between when tail prints the last pre-rotation lines and when it prints the lines that
					have accumulated in the new log file. This option is meaningful only when polling
					(i.e., without inotify) and when following by name.
					*/
				}
			}
		
			Ok(())
		}
	}
	
	
	#[cfg(not(target_os = "wasi"))]
	pub use watch::{Observer, follow};
	
	// WASI: notify/inotify are unavailable, so `tail -f` cannot work.
	// Provide minimal stubs matching the real Observer API so tail compiles.
	#[cfg(target_os = "wasi")]
	mod wasi_stubs {
		use std::{io::BufRead, path::Path};
	
		use crate::tail::{TailError, TailResult, args::Settings};
	
		pub struct Observer {
			pub use_polling: bool,
		}
	
		impl Observer {
			pub fn from(_settings: &Settings) -> Self {
				Self { use_polling: false }
			}
	
			#[allow(clippy::unnecessary_wraps, reason = "matches the native observer API")]
			pub fn start(&mut self, _settings: &Settings) -> TailResult<()> {
				Ok(())
			}
	
			#[allow(clippy::unnecessary_wraps, reason = "matches the native observer API")]
			pub fn add_path(
				&mut self,
				_path: &Path,
				_display_name: &str,
				_reader: Option<Box<dyn BufRead>>,
				_update_last: bool,
			) -> TailResult<()> {
				Ok(())
			}
	
			#[allow(clippy::unnecessary_wraps, reason = "matches the native observer API")]
			pub fn add_bad_path(
				&mut self,
				_path: &Path,
				_display_name: &str,
				_update_last: bool,
			) -> TailResult<()> {
				Ok(())
			}
	
			pub fn follow_name_retry(&self) -> bool {
				false
			}
		}
	
		pub fn follow(_observer: Observer, _settings: &Settings) -> TailResult<()> {
			Err(TailError::message("follow mode is not supported on this platform"))
		}
	}
	
	#[cfg(target_os = "wasi")]
	pub use wasi_stubs::{Observer, follow};
}

mod parse {
	// This file is part of the uutils coreutils package.
	//
	// For the full copyright and license information, please view the LICENSE
	// file that was distributed with this source code.
	
	use std::ffi::OsString;
	
	#[derive(PartialEq, Eq, Debug, Copy, Clone)]
	pub struct ObsoleteArgs {
		pub num:    u64,
		pub plus:   bool,
		pub lines:  bool,
		pub follow: bool,
	}
	
	impl Default for ObsoleteArgs {
		fn default() -> Self {
			Self { num: 10, plus: false, lines: true, follow: false }
		}
	}
	
	#[derive(PartialEq, Eq, Debug)]
	pub enum ParseError {
		Context,
		InvalidEncoding,
	}
	/// Parses obsolete syntax
	/// tail -\[NUM\]\[bcl\]\[f\] and tail +\[NUM\]\[bcl\]\[f\]
	pub fn parse_obsolete(src: &OsString) -> Option<Result<ObsoleteArgs, ParseError>> {
		let Some(mut rest) = src.to_str() else {
			return Some(Err(ParseError::InvalidEncoding));
		};
		let sign = if let Some(r) = rest.strip_prefix('-') {
			rest = r;
			'-'
		} else {
			let r = rest.strip_prefix('+')?;
			rest = r;
			'+'
		};
	
		let end_num = rest
			.find(|c: char| !c.is_ascii_digit())
			.unwrap_or(rest.len());
		let has_num = !rest[..end_num].is_empty();
		let num: u64 = if has_num {
			rest[..end_num].parse().unwrap_or(u64::MAX)
		} else {
			10
		};
		rest = &rest[end_num..];
	
		let mode = if let Some(r) = rest.strip_prefix('l') {
			rest = r;
			'l'
		} else if let Some(r) = rest.strip_prefix('c') {
			rest = r;
			'c'
		} else if let Some(r) = rest.strip_prefix('b') {
			rest = r;
			'b'
		} else {
			'l'
		};
	
		let follow = rest.contains('f');
		if !rest.chars().all(|f| f == 'f') {
			// GNU allows an arbitrary amount of following fs, but nothing else
			if sign == '-' && has_num {
				return Some(Err(ParseError::Context));
			}
			return None;
		}
	
		let multiplier = if mode == 'b' { 512 } else { 1 };
		let num = num.saturating_mul(multiplier);
	
		Some(Ok(ObsoleteArgs { num, plus: sign == '+', lines: mode == 'l', follow }))
	}
	
	#[cfg(test)]
	mod tests {
		use super::*;
		#[test]
		fn test_parse_numbers_obsolete() {
			assert_eq!(
				parse_obsolete(&OsString::from("+2c")),
				Some(Ok(ObsoleteArgs { num: 2, plus: true, lines: false, follow: false }))
			);
			assert_eq!(
				parse_obsolete(&OsString::from("-5")),
				Some(Ok(ObsoleteArgs { num: 5, plus: false, lines: true, follow: false }))
			);
			assert_eq!(
				parse_obsolete(&OsString::from("+100f")),
				Some(Ok(ObsoleteArgs { num: 100, plus: true, lines: true, follow: true }))
			);
			assert_eq!(
				parse_obsolete(&OsString::from("-2b")),
				Some(Ok(ObsoleteArgs { num: 1024, plus: false, lines: false, follow: false }))
			);
		}
		#[test]
		fn test_parse_errors_obsolete() {
			assert_eq!(parse_obsolete(&OsString::from("-5n")), Some(Err(ParseError::Context)));
			assert_eq!(parse_obsolete(&OsString::from("-5c5")), Some(Err(ParseError::Context)));
			assert_eq!(parse_obsolete(&OsString::from("-1vzc")), Some(Err(ParseError::Context)));
			assert_eq!(parse_obsolete(&OsString::from("-5m")), Some(Err(ParseError::Context)));
			assert_eq!(parse_obsolete(&OsString::from("-1k")), Some(Err(ParseError::Context)));
			assert_eq!(parse_obsolete(&OsString::from("-1mmk")), Some(Err(ParseError::Context)));
			assert_eq!(parse_obsolete(&OsString::from("-105kzm")), Some(Err(ParseError::Context)));
			assert_eq!(parse_obsolete(&OsString::from("-1vz")), Some(Err(ParseError::Context)));
			assert_eq!(
				parse_obsolete(&OsString::from("-1vzqvq")),
				Some(Err(ParseError::Context))
			);
		}
		#[test]
		fn test_parse_obsolete_no_match() {
			assert_eq!(parse_obsolete(&OsString::from("-k")), None);
			assert_eq!(parse_obsolete(&OsString::from("asd")), None);
			assert_eq!(parse_obsolete(&OsString::from("-cc")), None);
		}
	}
}

mod paths {
	//! Path and metadata helpers for `tail`.
	#[cfg(unix)]
	use std::os::unix::fs::{FileTypeExt, MetadataExt};
	use std::{
		ffi::OsStr,
		fs::{File, Metadata},
		io::{Seek, SeekFrom, Write},
		path::{Path, PathBuf},
	};
	
	use crate::{host::Host, tail::{TailResult, text}};
	
	#[derive(Debug, Clone)]
	pub enum InputKind {
		File(PathBuf),
		Stdin,
	}
	
	#[cfg(unix)]
	impl From<&OsStr> for InputKind {
		fn from(value: &OsStr) -> Self {
			if value == OsStr::new("-") {
				Self::Stdin
			} else {
				Self::File(PathBuf::from(value))
			}
		}
	}
	
	#[cfg(not(unix))]
	impl From<&OsStr> for InputKind {
		fn from(value: &OsStr) -> Self {
			if value == OsStr::new(text::DASH) {
				Self::Stdin
			} else {
				Self::File(PathBuf::from(value))
			}
		}
	}
	
	#[derive(Debug, Clone)]
	pub struct Input {
		kind:             InputKind,
		pub display_name: String,
	}
	
	impl Input {
		pub fn from<T: AsRef<OsStr>>(string: T) -> Self {
			let string = string.as_ref();
	
			let kind = string.into();
			let display_name = match kind {
				InputKind::File(_) => string.to_string_lossy().to_string(),
				InputKind::Stdin => "standard input".to_string(),
			};
	
			Self { kind, display_name }
		}
	
		/// Resolves a file operand against the shell working directory.
		pub fn resolve_path(&mut self, host: &Host) {
			if let InputKind::File(path) = &mut self.kind {
				*path = host.resolve(&*path);
			}
		}
	
		pub fn kind(&self) -> &InputKind {
			&self.kind
		}
	
		pub fn is_stdin(&self) -> bool {
			match self.kind {
				InputKind::File(_) => false,
				InputKind::Stdin => true,
			}
		}
	
		pub fn resolve(&self) -> Option<PathBuf> {
			match &self.kind {
				InputKind::File(path) if path != &PathBuf::from(text::DEV_STDIN) => {
					path.canonicalize().ok()
				},
				InputKind::File(_) | InputKind::Stdin => {
					// on macOS, /dev/fd isn't backed by /proc and canonicalize()
					// on dev/fd/0 (or /dev/stdin) will fail (NotFound),
					// so we treat stdin as a pipe here
					// https://github.com/rust-lang/rust/issues/95239
					#[cfg(target_os = "macos")]
					{
						None
					}
					#[cfg(not(target_os = "macos"))]
					{
						PathBuf::from(text::FD0).canonicalize().ok()
					}
				},
			}
		}
	
		pub fn is_tailable(&self) -> bool {
			match &self.kind {
				InputKind::File(path) => path_is_tailable(path),
				InputKind::Stdin => self.resolve().is_some_and(|path| path_is_tailable(&path)),
			}
		}
	}
	
	impl Default for Input {
		fn default() -> Self {
			Self { kind: InputKind::Stdin, display_name: "standard input".to_string() }
		}
	}
	
	#[derive(Debug, Default, Clone, Copy)]
	pub struct HeaderPrinter {
		verbose:      bool,
		first_header: bool,
	}
	
	impl HeaderPrinter {
		pub fn new(verbose: bool, first_header: bool) -> Self {
			Self { verbose, first_header }
		}
	
		pub fn print_input(&mut self, input: &Input, writer: &mut impl Write) {
			self.print(input.display_name.as_str(), writer);
		}
	
		pub fn print(&mut self, string: &str, writer: &mut impl Write) {
			if self.verbose {
				let _ = writeln!(
					writer,
					"{}==> {string} <==",
					if self.first_header { "" } else { "\n" },
				);
				self.first_header = false;
			}
		}
	}
	pub trait FileExtTail {
		#[allow(clippy::wrong_self_convention, reason = "preserves upstream file extension trait API")]
		fn is_seekable(&mut self, current_offset: u64) -> bool;
	}
	
	impl FileExtTail for File {
		/// Test if File is seekable.
		/// Set the current position offset to `current_offset`.
		fn is_seekable(&mut self, current_offset: u64) -> bool {
			self.stream_position().is_ok()
				&& self.seek(SeekFrom::End(0)).is_ok()
				&& self.seek(SeekFrom::Start(current_offset)).is_ok()
		}
	}
	
	pub trait MetadataExtTail {
		fn is_tailable(&self) -> bool;
		#[cfg(not(target_os = "wasi"))]
		fn got_truncated(&self, other: &Metadata) -> TailResult<bool>;
		#[cfg(not(target_os = "wasi"))]
		fn file_id_eq(&self, other: &Metadata) -> bool;
	}
	
	impl MetadataExtTail for Metadata {
		fn is_tailable(&self) -> bool {
			let ft = self.file_type();
			#[cfg(unix)]
			{
				ft.is_file() || ft.is_char_device() || ft.is_fifo()
			}
			#[cfg(not(unix))]
			{
				ft.is_file()
			}
		}
	
		/// Return true if the file was modified and is now shorter
		#[cfg(not(target_os = "wasi"))]
		fn got_truncated(&self, other: &Metadata) -> TailResult<bool> {
			Ok(other.len() < self.len() && other.modified()? != self.modified()?)
		}
	
		#[cfg(not(target_os = "wasi"))]
		fn file_id_eq(&self, #[cfg(unix)] other: &Metadata, #[cfg(not(unix))] _: &Metadata) -> bool {
			#[cfg(unix)]
			{
				self.ino().eq(&other.ino())
			}
			#[cfg(windows)]
			{
				// TODO: `file_index` requires unstable library feature `windows_by_handle`
				// use std::os::windows::prelude::*;
				// if let Some(self_id) = self.file_index() {
				//     if let Some(other_id) = other.file_index() {
				//     // TODO: not sure this is the equivalent of comparing inode numbers
				//
				//         return self_id.eq(&other_id);
				//     }
				// }
				false
			}
		}
	}
	
	#[cfg(not(target_os = "wasi"))]
	pub trait PathExtTail {
		fn is_stdin(&self) -> bool;
		fn is_orphan(&self) -> bool;
		fn is_tailable(&self) -> bool;
	}
	
	#[cfg(not(target_os = "wasi"))]
	impl PathExtTail for Path {
		fn is_stdin(&self) -> bool {
			self.eq(Self::new(text::DASH))
				|| self.eq(Self::new(text::DEV_STDIN))
				|| self.eq(Self::new("standard input"))
		}
	
		/// Return true if `path` does not have an existing parent directory
		fn is_orphan(&self) -> bool {
			!matches!(self.parent(), Some(parent) if parent.is_dir())
		}
	
		/// Return true if `path` is is a file type that can be tailed
		fn is_tailable(&self) -> bool {
			path_is_tailable(self)
		}
	}
	
	pub fn path_is_tailable(path: &Path) -> bool {
		path.is_file() || path.exists() && path.metadata().is_ok_and(|meta| meta.is_tailable())
	}
}

mod platform {
	// This file is part of the uutils coreutils package.
	//
	// For the full copyright and license information, please view the LICENSE
	// file that was distributed with this source code.
	
	#[cfg(unix)]
	pub use self::unix::{
		Pid,
		ProcessChecker,
		//stdin_is_bad_fd, stdin_is_pipe_or_fifo, supports_pid_checks, Pid, ProcessChecker,
		supports_pid_checks,
	};
	#[cfg(windows)]
	pub use self::windows::{Pid, ProcessChecker, supports_pid_checks};
	
	// WASI has no process management; provide stubs so tail compiles.
	#[cfg(target_os = "wasi")]
	pub type Pid = u64;
	
	#[cfg(target_os = "wasi")]
	pub fn supports_pid_checks(_pid: Pid) -> bool {
		false
	}
	
	#[cfg(unix)]
	mod unix {
		// This file is part of the uutils coreutils package.
		//
		// For the full copyright and license information, please view the LICENSE
		// file that was distributed with this source code.
		
		
		use std::io::Error;
		
		pub type Pid = libc::pid_t;
		
		pub struct ProcessChecker {
			pid: Pid,
		}
		
		impl ProcessChecker {
			pub fn new(process_id: Pid) -> Self {
				Self { pid: process_id }
			}
		
			pub fn is_dead(&self) -> bool {
				unsafe { libc::kill(self.pid, 0) != 0 && get_errno() != libc::EPERM }
			}
		}
		
		impl Drop for ProcessChecker {
			fn drop(&mut self) {}
		}
		
		pub fn supports_pid_checks(pid: Pid) -> bool {
			unsafe { !(libc::kill(pid, 0) != 0 && get_errno() == libc::ENOSYS) }
		}
		
		#[inline]
		fn get_errno() -> i32 {
			Error::last_os_error().raw_os_error().unwrap()
		}
		
		//pub fn stdin_is_bad_fd() -> bool {
		// FIXME: Detect a closed file descriptor, e.g.: `tail <&-`
		// this is never `true`, even with `<&-` because Rust's stdlib is reopening fds
		// as /dev/null see also: https://github.com/uutils/coreutils/issues/2873
		// (gnu/tests/tail-2/follow-stdin.sh fails because of this)
		// unsafe { libc::fcntl(fd, libc::F_GETFD) == -1 && get_errno() == libc::EBADF }
		//false
		//}
	}
	
	#[cfg(windows)]
	mod windows {
		// This file is part of the uutils coreutils package.
		//
		// For the full copyright and license information, please view the LICENSE
		// file that was distributed with this source code.
		
		use std::cell::Cell;
		
		use windows_sys::{
			Win32::{
				Foundation::{CloseHandle, HANDLE, WAIT_FAILED, WAIT_OBJECT_0},
				System::Threading::{OpenProcess, PROCESS_SYNCHRONIZE, WaitForSingleObject},
			},
			core::BOOL,
		};
		
		pub type Pid = u32;
		
		pub struct ProcessChecker {
			dead:   Cell<bool>,
			handle: HANDLE,
		}
		
		impl ProcessChecker {
			pub fn new(process_id: Pid) -> Self {
				#[allow(non_snake_case, reason = "matches the Windows API constant name")]
				let FALSE: BOOL = 0;
				let h = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, FALSE, process_id) };
				Self { dead: Cell::new(h.is_null()), handle: h }
			}
		
			pub fn is_dead(&self) -> bool {
				if !self.dead.get() {
					self.dead.set(unsafe {
						let status = WaitForSingleObject(self.handle, 0);
						status == WAIT_OBJECT_0 || status == WAIT_FAILED
					});
				}
		
				self.dead.get()
			}
		}
		
		impl Drop for ProcessChecker {
			fn drop(&mut self) {
				unsafe {
					CloseHandle(self.handle);
				}
			}
		}
		
		pub fn supports_pid_checks(_pid: Pid) -> bool {
			true
		}
	}
}

mod text {
	// This file is part of the uutils coreutils package.
	//
	// For the full copyright and license information, please view the LICENSE
	// file that was distributed with this source code.
	
	
	// Non-localized constants (system paths and technical identifiers)
	pub const DASH: &str = "-";
	pub const DEV_STDIN: &str = "/dev/stdin";
	#[cfg(not(target_os = "macos"))]
	pub const FD0: &str = "/dev/fd/0";
	
	#[cfg(target_os = "linux")]
	pub const BACKEND: &str = "inotify";
	#[cfg(all(unix, not(target_os = "linux")))]
	pub const BACKEND: &str = "kqueue";
	#[cfg(target_os = "windows")]
	pub const BACKEND: &str = "ReadDirectoryChanges";
	#[cfg(not(any(unix, target_os = "windows")))]
	pub const BACKEND: &str = "polling";
}

use std::{
	cmp::Ordering,
	ffi::OsString,
	fs::File,
	io::{self, BufReader, ErrorKind, Read, Seek, SeekFrom, Write},
	path::{Path, PathBuf},
};

use brush_core::{ShellExtensions, builtins::Registration};
use clap::ArgMatches;
use memchr::{memchr_iter, memrchr_iter};
use uucore::display::Quotable;

use crate::host::{Host, Utility, matches_parser, util};

use args::{FilterMode, Settings, Signum};
use chunks::ReverseChunks;
use follow::Observer;
use paths::{FileExtTail, HeaderPrinter, Input, InputKind};


#[derive(Debug)]
pub(crate) enum TailError {
	Io(io::Error),
	Message(String),
}

impl TailError {
	pub(crate) fn message(message: impl Into<String>) -> Self {
		Self::Message(message.into())
	}
}

impl std::fmt::Display for TailError {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		match self {
			Self::Io(error) => error.fmt(f),
			Self::Message(message) => f.write_str(message),
		}
	}
}

impl std::error::Error for TailError {}

impl From<io::Error> for TailError {
	fn from(error: io::Error) -> Self {
		Self::Io(error)
	}
}

pub(crate) type TailResult<T> = Result<T, TailError>;

pub(crate) fn map_output_error(error: io::Error) -> TailError {
	error.into()
}

/// True when `token` is an option that takes its value from the *next* argv
/// token, so that value must never be mistaken for an obsolete `-N`/`+N` form
/// (e.g. the `+5` in `tail -n +5 file`).
fn consumes_separate_value(token: &str) -> bool {
	if let Some(long) = token.strip_prefix("--") {
		if long.is_empty() || long.contains('=') {
			return false;
		}
		// clap infers unambiguous long-option prefixes; `--follow` requires
		// `=` for its value and never consumes the next token.
		return ["lines", "bytes", "pid", "sleep-interval", "max-unchanged-stats"]
			.iter()
			.any(|name| name.starts_with(long));
	}
	let Some(cluster) = token.strip_prefix('-') else {
		return false;
	};
	let mut chars = cluster.chars();
	while let Some(c) = chars.next() {
		match c {
			// Value-taking shorts: a trailing `-n`/`-c`/`-s` consumes the next
			// token; anything after them in the cluster is an attached value.
			'n' | 'c' | 's' => return chars.next().is_none(),
			'q' | 'v' | 'z' | 'f' | 'F' | 'r' | 'b' => {},
			_ => return false,
		}
	}
	false
}

/// Rewrites every obsolete `-N[bcl][f]` / `+N[bcl][f]` token (before `--`)
/// into modern options, wherever it appears among flags and operands: GNU/BSD
/// accept `tail -20 f1 f2`, `tail -f -5 file`, and `tail -5 -q file`.
fn rewrite_tail_argv(argv: Vec<OsString>) -> Result<Vec<OsString>, String> {
	let mut rewritten = Vec::with_capacity(argv.len() + 2);
	let mut iter = argv.into_iter();
	rewritten.extend(iter.next());
	let mut follow = false;
	let mut has_operand = false;
	let mut skip_value = false;
	let mut seen_ddash = false;
	for arg in iter {
		if skip_value {
			skip_value = false;
			rewritten.push(arg);
			continue;
		}
		if seen_ddash {
			has_operand = true;
			rewritten.push(arg);
			continue;
		}
		let token = arg.to_string_lossy();
		if token == "--" {
			seen_ddash = true;
			rewritten.push(arg);
			continue;
		}
		let bytes = token.as_bytes();
		// `+…` is always a candidate (`+10`, `+f`); `-…` only with a leading
		// digit (`-5`, `-20f`) so options like `-n` stay untouched.
		let candidate =
			bytes.first() == Some(&b'+') || matches!(bytes, [b'-', b'0'..=b'9', ..]);
		if candidate {
			match parse::parse_obsolete(&arg) {
				Some(Ok(obsolete)) => {
					follow |= obsolete.follow;
					rewritten.push(OsString::from(if obsolete.lines { "-n" } else { "-c" }));
					rewritten.push(OsString::from(format!(
						"{}{}",
						if obsolete.plus { "+" } else { "" },
						obsolete.num
					)));
					continue;
				},
				Some(Err(parse::ParseError::Context)) => {
					return Err(format!(
						"option used in invalid context -- {}",
						token.chars().nth(1).unwrap_or_default()
					));
				},
				Some(Err(parse::ParseError::InvalidEncoding)) => {
					return Err(format!("bad argument encoding: {}", arg.quote()));
				},
				None => {},
			}
		}
		if bytes.len() > 1 && bytes[0] == b'-' {
			skip_value = consumes_separate_value(&token);
		} else {
			has_operand = true;
		}
		rewritten.push(arg);
	}
	if follow {
		// Obsolete `f` follows by name when a file operand is present,
		// matching GNU; insert up front so an explicit later -f/-F wins.
		rewritten.insert(
			1,
			OsString::from(if has_operand { "--follow=name" } else { "--follow=descriptor" }),
		);
	}
	Ok(rewritten)
}
/// Parsed `tail` invocation.
pub(crate) struct Tail {
	matches: ArgMatches,
}

matches_parser!(Tail, args::uu_app);

impl Utility for Tail {
	fn rewrite_argv(argv: Vec<OsString>) -> Result<Vec<OsString>, String> {
		rewrite_tail_argv(argv)
	}
	const NAME: &'static str = "tail";

	fn run(self, host: &mut Host) -> i32 {
		if self.matches.get_flag(args::options::REVERSE) {
			return run_reverse(&self.matches, host);
		}
		let mut settings = match Settings::from(&self.matches) {
			Ok(settings) => settings,
			Err(error) => {
				let _ = writeln!(host.stderr, "tail: {error}");
				return 1;
			},
		};
		settings.resolve_paths(host);

		match tail_main(&settings, host) {
			Ok(()) => host.exit_code(),
			Err(error) => {
				let _ = writeln!(host.stderr, "tail: {error}");
				1
			},
		}
	}
}

/// Creates the `tail` builtin registration.
pub(crate) fn tail_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Tail, SE>()
}

/// BSD `tail -r`: print lines in reverse order. With `-n N` the count selects
/// how many lines to show (last N, or from line N for `+N`) before reversing.
fn run_reverse(matches: &ArgMatches, host: &mut Host) -> i32 {
	if matches.contains_id(args::options::BYTES)
		|| matches.get_flag(args::options::BLOCKS)
		|| matches.contains_id(args::options::FOLLOW)
		|| matches.get_flag(args::options::FOLLOW_RETRY)
	{
		let _ = writeln!(
			host.stderr,
			"tail: -r with -c, -b, or -f is not supported by this builtin; pipe through tac"
		);
		return 1;
	}

	let mut settings = match Settings::from(matches) {
		Ok(settings) => settings,
		Err(error) => {
			let _ = writeln!(host.stderr, "tail: {error}");
			return 1;
		},
	};

	// Without `-n`, `-r` reverses whole inputs; when no headers are wanted
	// that is exactly `tac`, so keep delegating.
	let all_lines = !matches.contains_id(args::options::LINES);
	if all_lines && !settings.verbose {
		let mut argv = vec![OsString::from("tac"), OsString::from("--")];
		if let Some(files) = matches.get_many::<OsString>(args::options::ARG_FILES) {
			argv.extend(files.cloned());
		}
		return crate::tac::run_argv(argv, host);
	}
	settings.resolve_paths(host);

	match reverse_main(&settings, all_lines, host) {
		Ok(()) => host.exit_code(),
		Err(error) => {
			let _ = writeln!(host.stderr, "tail: {error}");
			1
		},
	}
}

fn reverse_main(settings: &Settings, all_lines: bool, host: &mut Host) -> TailResult<()> {
	let FilterMode::Lines(signum, sep) = &settings.mode else {
		unreachable!("-r with -c is rejected before dispatch");
	};
	let (signum, sep) = (*signum, *sep);
	let mut stdout = host.stdout_writer();
	let mut printer = HeaderPrinter::new(settings.verbose, true);
	for input in &settings.inputs {
		let path = match input.kind() {
			InputKind::File(path) if !(cfg!(unix) && path == &PathBuf::from(text::DEV_STDIN)) => {
				Some(path)
			},
			InputKind::File(_) | InputKind::Stdin => None,
		};
		let mut data = Vec::new();
		if let Some(path) = path {
			if path.is_dir() {
				host.fail(1);
				printer.print_input(input, &mut stdout);
				let _ = writeln!(
					host.stderr,
					"tail: error reading '{}': Is a directory",
					input.display_name
				);
				continue;
			}
			match File::open(path) {
				Ok(mut file) => {
					printer.print_input(input, &mut stdout);
					file.read_to_end(&mut data)?;
				},
				Err(error) if error.kind() == ErrorKind::NotFound => {
					host.fail(1);
					let _ = writeln!(
						host.stderr,
						"tail: cannot open '{}' for reading: No such file or directory",
						input.display_name
					);
					continue;
				},
				Err(error) => {
					host.fail(1);
					let _ = writeln!(
						host.stderr,
						"tail: cannot open '{}' for reading: {error}",
						input.display_name
					);
					continue;
				},
			}
		} else {
			printer.print_input(input, &mut stdout);
			host.stdin.read_to_end(&mut data)?;
		}
		write_reversed_lines(&data, signum, sep, all_lines, &mut stdout)?;
	}
	stdout.flush()?;
	Ok(())
}

/// Writes the selected lines of `data` in reverse order, BSD `tail -r` style:
/// each line keeps its trailing delimiter, so an unterminated final line leads
/// the output without one (matching `tac`).
fn write_reversed_lines(
	data: &[u8],
	signum: Signum,
	sep: u8,
	all_lines: bool,
	writer: &mut impl Write,
) -> io::Result<()> {
	let mut segments: Vec<&[u8]> = Vec::new();
	let mut start = 0;
	for end in memchr_iter(sep, data) {
		segments.push(&data[start..=end]);
		start = end + 1;
	}
	if start < data.len() {
		segments.push(&data[start..]);
	}
	let keep: &[&[u8]] = if all_lines {
		&segments[..]
	} else {
		match signum {
			Signum::Negative(count) => {
				let count = usize::try_from(count).unwrap_or(usize::MAX);
				&segments[segments.len().saturating_sub(count)..]
			},
			Signum::MinusZero => &[],
			Signum::PlusZero => &segments[..],
			Signum::Positive(count) => {
				// GNU-style 1-based origin: `+1` (like `+0`) selects everything.
				let skip = usize::try_from(count.saturating_sub(1)).unwrap_or(usize::MAX);
				&segments[skip.min(segments.len())..]
			},
		}
	};
	for segment in keep.iter().rev() {
		writer.write_all(segment)?;
	}
	writer.flush()
}

fn tail_main(settings: &Settings, host: &mut Host) -> TailResult<()> {
	settings.check_warnings(&mut host.stderr);

	match settings.verify() {
		args::VerificationResult::CannotFollowStdinByName => {
			return Err(TailError::message(format!(
				"cannot follow {} by name",
				text::DASH.quote()
			)));
		},
		args::VerificationResult::NoOutput => return Ok(()),
		args::VerificationResult::Ok => {},
	}

	uu_tail(settings, host)
}

fn uu_tail(settings: &Settings, host: &mut Host) -> TailResult<()> {
	let mut printer = HeaderPrinter::new(settings.verbose, true);
	let mut observer = Observer::from(
		settings,
		host.stdout_writer(),
		host.stderr_clone(),
		host.cancel_flag(),
	);

	observer.start(settings, host)?;

	if settings.debug && settings.follow.is_some() {
		let mode = if observer.use_polling { "polling" } else { "notification" };
		let _ = writeln!(observer.stderr, "tail: using {mode} mode");
	}

	// Do an initial tail print of each path's content.
	// Add `path` and `reader` to `files` map if `--follow` is selected.
	for input in &settings.inputs.clone() {
		match input.kind() {
			InputKind::Stdin => {
				tail_stdin(settings, &mut printer, input, &mut observer, &mut host.stdin)?;
			},
			InputKind::File(path) if cfg!(unix) && path == &PathBuf::from(text::DEV_STDIN) => {
				tail_stdin(settings, &mut printer, input, &mut observer, &mut host.stdin)?;
			},
			InputKind::File(path) => {
				tail_file(settings, &mut printer, input, path, &mut observer, 0, host)?;
			},
		}
	}
	observer.stdout.flush()?;

	if settings.follow.is_some() {
		/*
		POSIX specification regarding tail -f
		If the input file is a regular file or if the file operand specifies a FIFO, do not
		terminate after the last line of the input file has been copied, but read and copy
		further bytes from the input file when they become available. If no file operand is
		specified and standard input is a pipe or FIFO, the -f option shall be ignored. If
		the input file is not a FIFO, pipe, or regular file, it is unspecified whether or
		not the -f option shall be ignored.
		*/
		follow::follow(observer, settings)?;
	}

	Ok(())
}

fn tail_file(
	settings: &Settings,
	header_printer: &mut HeaderPrinter,
	input: &Input,
	path: &Path,
	observer: &mut Observer,
	offset: u64,
	host: &mut Host,
) -> TailResult<()> {
	let fs_path = path;
	let md = fs_path.metadata();
	if let Err(ref e) = md
		&& e.kind() == ErrorKind::NotFound
	{
		host.fail(1);
		let _ = writeln!(
			observer.stderr,
			"tail: cannot open '{}' for reading: No such file or directory",
			input.display_name
		);
		observer.add_bad_path(path, input.display_name.as_str(), false)?;
		return Ok(());
	}

	if fs_path.is_dir() {
		host.fail(1);

		header_printer.print_input(input, &mut observer.stdout);

		let _ = writeln!(
			observer.stderr,
			"tail: error reading '{}': Is a directory",
			input.display_name
		);
		if settings.follow.is_some() {
			let msg = if settings.retry {
				""
			} else {
				"; giving up on this name"
			};
			let _ = writeln!(
				observer.stderr,
				"tail: {}: cannot follow end of this type of file{}",
				input.display_name,
				msg
			);
		}
		if !observer.follow_name_retry() {
			return Ok(());
		}
		observer.add_bad_path(path, input.display_name.as_str(), false)?;
	} else {
		#[cfg(unix)]
		let open_result = open_file(&fs_path, settings.pid != 0);
		#[cfg(not(unix))]
		let open_result = File::open(&fs_path);

		match open_result {
			Ok(mut file) => {
				let st = file.metadata()?;
				let blksize_limit = uucore::fs::sane_blksize::sane_blksize_from_metadata(&st);
				header_printer.print_input(input, &mut observer.stdout);
				let mut reader;
				if !settings.presume_input_pipe
					&& file.is_seekable(if input.is_stdin() { offset } else { 0 })
					&& (!st.is_file() || st.len() > blksize_limit)
				{
					bounded_tail(&mut file, settings, &mut observer.stdout)?;
					reader = BufReader::new(file);
				} else {
					reader = BufReader::new(file);
					unbounded_tail(&mut reader, settings, &mut observer.stdout)?;
				}
				if input.is_tailable() {
					observer.add_path(
						path,
						input.display_name.as_str(),
						Some(Box::new(reader)),
						true,
					)?;
				} else {
					observer.add_bad_path(path, input.display_name.as_str(), false)?;
				}
			},
			Err(e) if e.kind() == ErrorKind::PermissionDenied => {
				observer.add_bad_path(path, input.display_name.as_str(), false)?;
				let message = format!("cannot open '{}' for reading: {e}", input.display_name);
				let _ = writeln!(observer.stderr, "tail: {message}");
				host.fail(1);
			},
			Err(e) => {
				observer.add_bad_path(path, input.display_name.as_str(), false)?;
				return Err(TailError::message(format!(
					"cannot open '{}' for reading: {e}",
					input.display_name
				)));
			},
		}
	}

	Ok(())
}

/// Opens a file, using non-blocking mode for FIFOs when `use_nonblock_for_fifo`
/// is true.
///
/// When opening a FIFO with `--pid`, we need to use O_NONBLOCK so that:
/// 1. The open() call doesn't block waiting for a writer
/// 2. We can periodically check if the monitored process is still alive
///
/// After opening, we clear O_NONBLOCK so subsequent reads block normally.
/// Without `--pid`, FIFOs block on open() until a writer connects (GNU
/// behavior).
#[cfg(unix)]
fn open_file(path: &Path, use_nonblock_for_fifo: bool) -> io::Result<File> {
	use std::{
		fs::OpenOptions,
		os::{
			fd::AsFd,
			unix::fs::{FileTypeExt, OpenOptionsExt},
		},
	};

	use rustix::fs::{OFlags, fcntl_getfl, fcntl_setfl};

	let is_fifo = path
		.metadata()
		.ok()
		.is_some_and(|m| m.file_type().is_fifo());

	if is_fifo && use_nonblock_for_fifo {
		let file = OpenOptions::new()
			.read(true)
			.custom_flags(libc::O_NONBLOCK)
			.open(path)?;

		// Clear O_NONBLOCK so reads block normally
		let flags = fcntl_getfl(file.as_fd())?;
		let new_flags = flags & !OFlags::NONBLOCK;
		fcntl_setfl(file.as_fd(), new_flags)?;

		Ok(file)
	} else {
		File::open(path)
	}
}

fn tail_stdin(
	settings: &Settings,
	header_printer: &mut HeaderPrinter,
	input: &Input,
	observer: &mut Observer,
	stdin: &mut impl Read,
) -> TailResult<()> {
	header_printer.print_input(input, &mut observer.stdout);
	let mut reader = BufReader::new(stdin);
	unbounded_tail(&mut reader, settings, &mut observer.stdout)?;
	Ok(())
}

/// Find the index after the given number of instances of a given byte.
///
/// This function reads through a given reader until `num_delimiters`
/// instances of `delimiter` have been seen, returning the index of
/// the byte immediately following that delimiter. If there are fewer
/// than `num_delimiters` instances of `delimiter`, this returns the
/// total number of bytes read from the `reader` until EOF.
///
/// # Errors
///
/// This function returns an error if there is an error during reading
/// from `reader`.
///
/// # Examples
///
/// Basic usage:
///
/// ```rust,ignore
/// use std::io::Cursor;
///
/// let mut reader = Cursor::new("a\nb\nc\nd\ne\n");
/// let i = forwards_thru_file(&mut reader, 2, b'\n').unwrap();
/// assert_eq!(i, 4);
/// ```
///
/// If `num_delimiters` is zero, then this function always returns
/// zero:
///
/// ```rust,ignore
/// use std::io::Cursor;
///
/// let mut reader = Cursor::new("a\n");
/// let i = forwards_thru_file(&mut reader, 0, b'\n').unwrap();
/// assert_eq!(i, 0);
/// ```
///
/// If there are fewer than `num_delimiters` instances of `delimiter`
/// in the reader, then this function returns the total number of
/// bytes read:
///
/// ```rust,ignore
/// use std::io::Cursor;
///
/// let mut reader = Cursor::new("a\n");
/// let i = forwards_thru_file(&mut reader, 2, b'\n').unwrap();
/// assert_eq!(i, 2);
/// ```
fn forwards_thru_file(
	reader: &mut impl Read,
	num_delimiters: u64,
	delimiter: u8,
) -> io::Result<usize> {
	// If num_delimiters == 0, always return 0.
	if num_delimiters == 0 {
		return Ok(0);
	}
	// Use a 32K buffer.
	let mut buf = [0; 32 * 1024];
	let mut total = 0;
	let mut count = 0;
	// Iterate through the input, using `count` to record the number of times
	// `delimiter` is seen. Once we find `num_delimiters` instances, return the
	// offset of the byte immediately following that delimiter.
	loop {
		match reader.read(&mut buf) {
			// Ok(0) => EoF before we found `num_delimiters` instance of `delimiter`.
			// Return the total number of bytes read in that case.
			Ok(0) => return Ok(total),
			Ok(n) => {
				// Use memchr_iter since it greatly improves search performance.
				for offset in memchr_iter(delimiter, &buf[..n]) {
					count += 1;
					if count == num_delimiters {
						// Return offset of the byte after the `delimiter` instance.
						return Ok(total + offset + 1);
					}
				}
				total += n;
			},
			Err(e) if e.kind() == ErrorKind::Interrupted => (),
			Err(e) => return Err(e),
		}
	}
}

/// Iterate over bytes in the file, in reverse, until we find the
/// `num_delimiters` instance of `delimiter`. The `file` is left seek'd to the
/// position just after that delimiter.
fn backwards_thru_file(file: &mut File, num_delimiters: u64, delimiter: u8) {
	if num_delimiters == 0 {
		file.seek(SeekFrom::End(0)).unwrap();
		return;
	}
	// This variable counts the number of delimiters found in the file
	// so far (reading from the end of the file toward the beginning).
	let mut counter = 0;
	let mut first_slice = true;
	for slice in ReverseChunks::new(file) {
		// Iterate over each byte in the slice in reverse order.
		let mut iter = memrchr_iter(delimiter, &slice);

		// Ignore a trailing newline in the last block, if there is one.
		if first_slice {
			if let Some(c) = slice.last()
				&& *c == delimiter
			{
				iter.next();
			}
			first_slice = false;
		}

		// For each byte, increment the count of the number of
		// delimiters found. If we have found more than the specified
		// number of delimiters, terminate the search and seek to the
		// appropriate location in the file.
		for i in iter {
			counter += 1;
			if counter >= num_delimiters {
				// We should never over-count - assert that.
				assert_eq!(counter, num_delimiters);
				// After each iteration of the outer loop, the
				// cursor in the file is at the *beginning* of the
				// block, so seeking forward by `i + 1` bytes puts
				// us right after the found delimiter.
				file.seek(SeekFrom::Current((i + 1) as i64)).unwrap();
				return;
			}
		}
	}
}

/// When tail'ing a file, we do not need to read the whole file from start to
/// finish just to find the last n lines or bytes. Instead, we can seek to the
/// end of the file, and then read the file "backwards" in blocks of size
/// `BLOCK_SIZE` until we find the location of the first line/byte. This ends up
/// being a nice performance win for very large files.
fn bounded_tail(file: &mut File, settings: &Settings, writer: &mut impl Write) -> io::Result<()> {
	debug_assert!(!settings.presume_input_pipe);
	let mut limit = None;

	// Find the position in the file to start printing from.
	match &settings.mode {
		FilterMode::Lines(Signum::Negative(count), delimiter) => {
			backwards_thru_file(file, *count, *delimiter);
		},
		FilterMode::Lines(Signum::Positive(count), delimiter) if count > &1 => {
			let i = forwards_thru_file(file, *count - 1, *delimiter).unwrap();
			file.seek(SeekFrom::Start(i as u64)).unwrap();
		},
		FilterMode::Lines(Signum::MinusZero, _) => {
			file.seek(SeekFrom::End(0)).unwrap();
		},
		FilterMode::Bytes(Signum::Negative(count)) => {
			if file.seek(SeekFrom::End(-(*count as i64))).is_err() {
				file.seek(SeekFrom::Start(0)).unwrap();
			}
			limit = Some(*count);
		},
		FilterMode::Bytes(Signum::Positive(count)) if count > &1 => {
			// GNU `tail` seems to index bytes and lines starting at 1, not
			// at 0. It seems to treat `+0` and `+1` as the same thing.
			file.seek(SeekFrom::Start(*count - 1)).unwrap();
		},
		FilterMode::Bytes(Signum::MinusZero) => {
			file.seek(SeekFrom::End(0)).unwrap();
		},
		_ => {},
	}

	print_target_section(file, limit, writer)?;
	Ok(())
}

fn unbounded_tail<T: Read>(
	reader: &mut BufReader<T>,
	settings: &Settings,
	writer: &mut impl Write,
) -> io::Result<()> {
	match &settings.mode {
		FilterMode::Lines(Signum::Negative(count), sep) => {
			let mut chunks = chunks::LinesChunkBuffer::new(*sep, *count);
			chunks.fill(reader)?;
			chunks.write(&mut *writer)?;
		},

		FilterMode::Lines(Signum::PlusZero | Signum::Positive(1), _) => {
			io::copy(reader, &mut *writer)?;
		},
		FilterMode::Lines(Signum::Positive(count), sep) => {
			let mut num_skip = *count - 1;
			let mut chunk = chunks::LinesChunk::new(*sep);
			while chunk.fill(reader)?.is_some() {
				let lines = chunk.get_lines() as u64;
				if lines < num_skip {
					num_skip -= lines;
				} else {
					break;
				}
			}
			if chunk.has_data() {
				chunk.write_lines(&mut *writer, num_skip as usize)?;
				io::copy(reader, &mut *writer)?;
			}
		},
		FilterMode::Bytes(Signum::Negative(count)) => {
			let mut chunks = chunks::BytesChunkBuffer::new(*count);
			chunks.fill(reader)?;
			chunks.print(&mut *writer)?;
		},
		FilterMode::Lines(Signum::MinusZero, sep) => {
			let mut chunks = chunks::LinesChunkBuffer::new(*sep, 0);
			chunks.fill(reader)?;
			chunks.write(&mut *writer)?;
		},
		FilterMode::Bytes(Signum::PlusZero | Signum::Positive(1)) => {
			io::copy(reader, &mut *writer)?;
		},
		FilterMode::Bytes(Signum::Positive(count)) => {
			let mut num_skip = *count - 1;
			let mut chunk = chunks::BytesChunk::new();
			loop {
				if let Some(bytes) = chunk.fill(reader)? {
					let bytes: u64 = bytes as u64;
					match bytes.cmp(&num_skip) {
						Ordering::Less => num_skip -= bytes,
						Ordering::Equal => {
							break;
						},
						Ordering::Greater => {
							writer.write_all(chunk.get_buffer_with(num_skip as usize))?;
							break;
						},
					}
				} else {
					return Ok(());
				}
			}

			io::copy(reader, &mut *writer)?;
		},
		_ => {},
	}
	// A broken downstream pipe surfaces as an ordinary I/O error and maps to
	// the silent SIGPIPE-compatible exit status at the builtin boundary.
	writer.flush()?;
	Ok(())
}

fn print_target_section<R>(
	file: &mut R,
	limit: Option<u64>,
	stdout: &mut impl Write,
) -> io::Result<()>
where
	R: Read + ?Sized,
{
	if let Some(limit) = limit {
		let mut reader = file.take(limit);
		io::copy(&mut reader, stdout)?;
	} else {
		io::copy(file, stdout)?;
	}
	Ok(())
}

#[cfg(test)]
mod tests {
	use std::{ffi::OsString, fs, io::Cursor};

	use clap::Parser;

	use super::{Tail, Utility, forwards_thru_file};
	use crate::host::{Host, run_util};

	fn rewritten(argv: &[&str]) -> Vec<String> {
		Tail::rewrite_argv(argv.iter().map(OsString::from).collect())
			.unwrap()
			.into_iter()
			.map(|arg| arg.to_str().unwrap().to_owned())
			.collect()
	}

	#[test]
	fn prints_last_line_from_stdin() {
		let (code, capture) = run_util::<Tail>(&["-n", "1"], "first\nlast\n", "/");
		assert_eq!(code, 0);
		assert_eq!(capture.out(), "last\n");
		assert_eq!(capture.err(), "");
	}

	#[test]
	fn resolves_relative_file_against_shell_cwd() {
		let dir = tempfile::tempdir().unwrap();
		fs::write(dir.path().join("log"), "first\nlast\n").unwrap();
		let (code, capture) = run_util::<Tail>(&["-n", "1", "log"], "", dir.path());
		assert_eq!(code, 0);
		assert_eq!(capture.out(), "last\n");
		assert_eq!(capture.err(), "");
	}

	#[test]
	fn bsd_reverse_delegates_to_tac() {
		let dir = tempfile::tempdir().unwrap();
		fs::write(dir.path().join("log"), "first\nsecond\nthird\n").unwrap();
		let (code, capture) = run_util::<Tail>(&["-r", "log"], "", dir.path());
		assert_eq!(code, 0);
		assert_eq!(capture.out(), "third\nsecond\nfirst\n");
		assert_eq!(capture.err(), "");
	}

	#[test]
	fn obsolete_count_syntax_is_rewritten_before_clap() {
		let (code, capture) = run_util::<Tail>(&["-2"], "one\ntwo\nthree\n", "/");
		assert_eq!(code, 0);
		assert_eq!(capture.out(), "two\nthree\n");
		assert_eq!(capture.err(), "");
	}

	#[test]
	fn cancelled_follow_returns_from_its_loop() {
		let dir = tempfile::tempdir().unwrap();
		let path = dir.path().join("log");
		fs::write(&path, "line\n").unwrap();
		let parsed = Tail::try_parse_from(["tail", "-f", path.to_str().unwrap()]).unwrap();
		let (mut host, _) = Host::for_test("tail", "", dir.path());
		host.cancel_for_test();
		assert_eq!(parsed.run(&mut host), 0);
	}

	// Failure mode: obsolete `-N`/`+N` was only rewritten for `argv.len()`
	// of 2 or 3 with the token at argv[1], so multi-file and flag-interleaved
	// invocations were clap parse errors.
	#[test]
	fn obsolete_count_rewritten_at_any_position() {
		assert_eq!(rewritten(&["tail", "-20", "f1", "f2"]), ["tail", "-n", "20", "f1", "f2"]);
		assert_eq!(rewritten(&["tail", "-f", "-5", "f"]), ["tail", "-f", "-n", "5", "f"]);
		assert_eq!(rewritten(&["tail", "-5", "-q", "f"]), ["tail", "-n", "5", "-q", "f"]);
		assert_eq!(rewritten(&["tail", "+10", "f"]), ["tail", "-n", "+10", "f"]);
		assert_eq!(rewritten(&["tail", "-5c", "f"]), ["tail", "-c", "5", "f"]);
		// Obsolete `f` still maps to --follow=name with a file operand.
		assert_eq!(
			rewritten(&["tail", "-20f", "f"]),
			["tail", "--follow=name", "-n", "20", "f"]
		);
		assert_eq!(rewritten(&["tail", "-20f"]), ["tail", "--follow=descriptor", "-n", "20"]);
	}

	// Failure mode: a `-N`/`+N` token that is really an option value or a
	// post-`--` operand must never be rewritten.
	#[test]
	fn option_values_and_post_ddash_operands_are_not_rewritten() {
		assert_eq!(rewritten(&["tail", "-n", "+5", "f"]), ["tail", "-n", "+5", "f"]);
		assert_eq!(rewritten(&["tail", "-c", "-5", "f"]), ["tail", "-c", "-5", "f"]);
		assert_eq!(rewritten(&["tail", "--lines", "-5", "f"]), ["tail", "--lines", "-5", "f"]);
		assert_eq!(rewritten(&["tail", "--", "-5"]), ["tail", "--", "-5"]);
	}

	// Failure mode: `tail -20 f1 f2` was rejected outright; it must print the
	// last lines of every operand with GNU headers.
	#[test]
	fn obsolete_count_with_multiple_files_prints_headers() {
		let dir = tempfile::tempdir().unwrap();
		fs::write(dir.path().join("f1"), "a\nb\n").unwrap();
		fs::write(dir.path().join("f2"), "c\nd\n").unwrap();
		let (code, capture) = run_util::<Tail>(&["-1", "f1", "f2"], "", dir.path());
		assert_eq!(code, 0);
		assert_eq!(capture.out(), "==> f1 <==\nb\n\n==> f2 <==\nd\n");
		assert_eq!(capture.err(), "");
	}

	// Failure mode: `-r` with `-n N` was rejected; BSD tail shows the last N
	// lines in reverse order.
	#[test]
	fn reverse_with_line_count_takes_last_lines_reversed() {
		let (code, capture) = run_util::<Tail>(&["-r", "-n", "2"], "a\nb\nc\n", "/");
		assert_eq!(code, 0);
		assert_eq!(capture.out(), "c\nb\n");
		assert_eq!(capture.err(), "");
	}

	// Failure mode: `-rq` was rejected; with `-q` headers stay suppressed
	// while each file's selection is reversed independently.
	#[test]
	fn reverse_quiet_suppresses_headers_across_files() {
		let dir = tempfile::tempdir().unwrap();
		fs::write(dir.path().join("f1"), "a\nb\n").unwrap();
		fs::write(dir.path().join("f2"), "c\nd\n").unwrap();
		let (code, capture) = run_util::<Tail>(&["-rq", "-n", "2", "f1", "f2"], "", dir.path());
		assert_eq!(code, 0);
		assert_eq!(capture.out(), "b\na\nd\nc\n");
		assert_eq!(capture.err(), "");
	}

	// Multi-file reverse keeps GNU-style headers.
	#[test]
	fn reverse_with_multiple_files_prints_headers() {
		let dir = tempfile::tempdir().unwrap();
		fs::write(dir.path().join("f1"), "a\nb\n").unwrap();
		fs::write(dir.path().join("f2"), "c\nd\n").unwrap();
		let (code, capture) = run_util::<Tail>(&["-r", "-n", "1", "f1", "f2"], "", dir.path());
		assert_eq!(code, 0);
		assert_eq!(capture.out(), "==> f1 <==\nb\n\n==> f2 <==\nd\n");
		assert_eq!(capture.err(), "");
	}

	// Failure mode: obsolete `-N` combined with `-r` (`tail -r -5`) must feed
	// the rewritten count into the reverse path.
	#[test]
	fn reverse_with_obsolete_count() {
		let (code, capture) = run_util::<Tail>(&["-r", "-2"], "a\nb\nc\n", "/");
		assert_eq!(code, 0);
		assert_eq!(capture.out(), "c\nb\n");
		assert_eq!(capture.err(), "");
	}

	// `-r` with byte/block counts stays an explicit error rather than
	// silently diverging from BSD semantics.
	#[test]
	fn reverse_with_byte_count_keeps_clear_error() {
		let (code, capture) = run_util::<Tail>(&["-r", "-c", "5"], "", "/");
		assert_eq!(code, 1);
		assert_eq!(capture.out(), "");
		assert_eq!(
			capture.err(),
			"tail: -r with -c, -b, or -f is not supported by this builtin; pipe through tac\n"
		);
	}

	#[test]
	fn test_forwards_thru_file_zero() {
		let mut reader = Cursor::new("a\n");
		assert_eq!(forwards_thru_file(&mut reader, 0, b'\n').unwrap(), 0);
	}

	#[test]
	fn test_forwards_thru_file_basic() {
		let mut reader = Cursor::new("a\nb\nc\nd\ne\n");
		assert_eq!(forwards_thru_file(&mut reader, 2, b'\n').unwrap(), 4);
	}

	#[test]
	fn test_forwards_thru_file_past_end() {
		let mut reader = Cursor::new("x\n");
		assert_eq!(forwards_thru_file(&mut reader, 2, b'\n').unwrap(), 2);
	}
}
