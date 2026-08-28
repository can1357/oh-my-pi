//! `sponge` builtin: soak up all of standard input before writing it to a file
//! or standard output.
//!
//! Ported from pi-shell's in-process implementation of the moreutils tool. The
//! delayed open makes `command < file | sponge file` safe: the destination is
//! not opened or truncated until its former contents have reached EOF.

use std::{
	ffi::{OsStr, OsString},
	fs::{self, File, OpenOptions},
	io::{self, Read, Write},
	path::{Path, PathBuf},
	sync::atomic::{AtomicU64, Ordering},
	time::{SystemTime, UNIX_EPOCH},
};

use brush_core::{ShellExtensions, builtins::Registration};
use clap::{Arg, ArgAction, ArgMatches, Command};

use crate::host::{Host, Utility, format_usage, matches_parser, util};

const OPT_APPEND: &str = "append";
const ARG_FILE: &str = "file";
const CHUNK_SIZE: usize = 64 * 1024;

/// Parsed `sponge` invocation.
pub(crate) struct Sponge {
	matches: ArgMatches,
}

matches_parser!(Sponge, command);

impl Utility for Sponge {
	const NAME: &'static str = "sponge";

	fn run(self, host: &mut Host) -> i32 {
		// Soak before resolving or opening the destination. In particular, do not
		// move this below the output-operand branch: stdin may be that same file.
		let buffer = match soak_stdin(host) {
			Ok(buffer) => buffer,
			Err(SoakError::Cancelled) => return 130,
			Err(SoakError::Io(err)) => {
				host.error(format_args!("stdin: {err}"), 1);
				return 1;
			},
		};

		let Some(file) = self.matches.get_one::<OsString>(ARG_FILE) else {
			if let Err(err) = host.stdout.write_all(&buffer).and_then(|()| host.stdout.flush()) {
				host.error(format_args!("stdout: {err}"), 1);
				return 1;
			}
			return 0;
		};

		let target = host.resolve(file);
		let result = if self.matches.get_flag(OPT_APPEND) {
			append_to(&target, &buffer)
		} else {
			replace_atomically(&target, &buffer)
		};
		match result {
			Ok(()) => 0,
			Err(err) => {
			host.error(format_args!("{}: {err}", file.to_string_lossy()), 1);
				1
			},
		}
	}
}

fn command() -> Command {
	Command::new("sponge")
		.version("sponge (pi-shell) 17.2.11")
		.about("Soak up all standard input, then write it to a file.")
		.override_usage(format_usage("sponge [-a] [FILE]"))
		.disable_help_flag(true)
		.disable_version_flag(true)
		.arg(
			Arg::new(OPT_APPEND)
				.short('a')
				.long(OPT_APPEND)
				.help("append the soaked input to the file instead of replacing it")
				.action(ArgAction::SetTrue),
		)
		.arg(Arg::new("help").long("help").action(ArgAction::Help))
		.arg(
			Arg::new("version")
				.long("version")
				.action(ArgAction::Version),
		)
		.arg(
			Arg::new(ARG_FILE)
				.value_name("FILE")
				.value_parser(clap::value_parser!(OsString)),
		)
}

enum SoakError {
	Cancelled,
	Io(io::Error),
}

/// Reads stdin to EOF into memory, polling for cancellation between chunks so
/// an aborted pipeline never touches the output file.
fn soak_stdin(host: &mut Host) -> Result<Vec<u8>, SoakError> {
	let mut buffer = Vec::new();
	let mut chunk = vec![0u8; CHUNK_SIZE].into_boxed_slice();
	loop {
		if host.is_cancelled() {
			return Err(SoakError::Cancelled);
		}
		match host.stdin.read(&mut chunk) {
			Ok(0) if host.is_cancelled() => return Err(SoakError::Cancelled),
			Ok(0) => return Ok(buffer),
			Ok(n) => buffer.extend_from_slice(&chunk[..n]),
			Err(err) if err.kind() == io::ErrorKind::Interrupted => {},
			Err(err) => return Err(SoakError::Io(err)),
		}
	}
}

fn append_to(target: &Path, buffer: &[u8]) -> io::Result<()> {
	let mut file = OpenOptions::new().append(true).create(true).open(target)?;
	file.write_all(buffer)?;
	file.flush()
}

/// Writes `buffer` to a fresh temporary file beside `target`, copies the
/// existing target's permissions onto it, then renames it over the target so
/// readers never observe a truncated file.
fn replace_atomically(target: &Path, buffer: &[u8]) -> io::Result<()> {
	let (temp_path, mut temp) = create_sibling_temp(target)?;
	let result = write_and_swap(target, &temp_path, &mut temp, buffer);
	if result.is_err() {
		let _ = fs::remove_file(&temp_path);
	}
	result
}

fn write_and_swap(
	target: &Path,
	temp_path: &Path,
	temp: &mut File,
	buffer: &[u8],
) -> io::Result<()> {
	temp.write_all(buffer)?;
	temp.flush()?;
	if let Ok(metadata) = fs::metadata(target) {
		fs::set_permissions(temp_path, metadata.permissions())?;
	}
	fs::rename(temp_path, target)
}

/// Creates a uniquely named `.<basename>.sponge.<random>` file next to
/// `target` with `create_new`, retrying on collision.
fn create_sibling_temp(target: &Path) -> io::Result<(PathBuf, File)> {
	static COUNTER: AtomicU64 = AtomicU64::new(0);
	let dir = target
		.parent()
		.filter(|p| !p.as_os_str().is_empty())
		.unwrap_or_else(|| Path::new("."));
	let base = target
		.file_name()
		.unwrap_or_else(|| OsStr::new("sponge"))
		.to_string_lossy();
	for _ in 0..32 {
		let nanos = SystemTime::now()
			.duration_since(UNIX_EPOCH)
			.map_or(0, |duration| duration.subsec_nanos() as u64);
		let tag = nanos
			.wrapping_mul(0x9e37_79b9_7f4a_7c15)
			.wrapping_add(COUNTER.fetch_add(1, Ordering::Relaxed))
			.wrapping_add(std::process::id() as u64);
		let path = dir.join(format!(".{base}.sponge.{tag:016x}"));
		match OpenOptions::new().write(true).create_new(true).open(&path) {
			Ok(file) => return Ok((path, file)),
			Err(err) if err.kind() == io::ErrorKind::AlreadyExists => {},
			Err(err) => return Err(err),
		}
	}
	Err(io::Error::new(
		io::ErrorKind::AlreadyExists,
		"could not create temporary file",
	))
}

/// Creates the `sponge` builtin registration.
pub(crate) fn sponge_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Sponge, SE>()
}

#[cfg(test)]
mod tests {
	use std::{ffi::OsString, fs};

	use super::Sponge;
	use crate::host::run_util;

	#[test]
	fn stdin_written_to_file_exactly() {
		let dir = tempfile::tempdir().unwrap();
		let (code, capture) = run_util::<Sponge>(&["out"], "hello\nsponge\n", dir.path());
		assert_eq!((code, capture.out(), capture.err()), (0, String::new(), String::new()));
		assert_eq!(fs::read(dir.path().join("out")).unwrap(), b"hello\nsponge\n");
	}

	#[test]
	fn append_flag_appends_to_existing_content() {
		let dir = tempfile::tempdir().unwrap();
		fs::write(dir.path().join("log"), b"first\n").unwrap();
		let (code, capture) = run_util::<Sponge>(&["-a", "log"], "second\n", dir.path());
		assert_eq!((code, capture.out(), capture.err()), (0, String::new(), String::new()));
		assert_eq!(fs::read(dir.path().join("log")).unwrap(), b"first\nsecond\n");
	}

	#[test]
	fn no_file_writes_stdin_to_stdout() {
		let dir = tempfile::tempdir().unwrap();
		let (code, capture) = run_util::<Sponge>(&[], "passthrough", dir.path());
		assert_eq!((code, capture.out(), capture.err()), (0, "passthrough".into(), String::new()));
	}

	#[test]
	fn replaces_existing_target_and_leaves_no_temp_files() {
		let dir = tempfile::tempdir().unwrap();
		fs::write(dir.path().join("data"), b"old contents that are longer").unwrap();
		let (code, capture) = run_util::<Sponge>(&["data"], "new", dir.path());
		assert_eq!((code, capture.out(), capture.err()), (0, String::new(), String::new()));
		assert_eq!(fs::read(dir.path().join("data")).unwrap(), b"new");
		let leftovers: Vec<_> = fs::read_dir(dir.path())
			.unwrap()
			.map(|entry| entry.unwrap().file_name())
			.filter(|name| name != "data")
			.collect();
		assert_eq!(leftovers, Vec::<OsString>::new());
	}

	#[cfg(unix)]
	#[test]
	fn permissions_preserved_on_replace() {
		use std::os::unix::fs::PermissionsExt;

		let dir = tempfile::tempdir().unwrap();
		let target = dir.path().join("secret");
		fs::write(&target, b"old").unwrap();
		fs::set_permissions(&target, fs::Permissions::from_mode(0o600)).unwrap();

		let (code, capture) = run_util::<Sponge>(&["secret"], "new", dir.path());
		assert_eq!((code, capture.err()), (0, String::new()));
		assert_eq!(fs::metadata(&target).unwrap().permissions().mode() & 0o7777, 0o600);
	}

	#[test]
	fn missing_target_directory_reports_error() {
		let dir = tempfile::tempdir().unwrap();
		let (code, capture) = run_util::<Sponge>(&["nodir/out"], "bytes", dir.path());
		assert_eq!(code, 1);
		assert_eq!(capture.out(), "");
		assert!(
			capture.err().starts_with("sponge: nodir/out: "),
			"stderr: {}",
			capture.err()
		);
	}

	#[test]
	fn soaks_existing_target_before_replacing_it() {
		let dir = tempfile::tempdir().unwrap();
		let target = dir.path().join("data");
		fs::write(&target, b"original file bytes").unwrap();
		let redirected_stdin = fs::read(&target).unwrap();
		let stdin = std::str::from_utf8(&redirected_stdin).unwrap();

		let (code, capture) = run_util::<Sponge>(&["data"], stdin, dir.path());

		assert_eq!((code, capture.out(), capture.err()), (0, String::new(), String::new()));
		assert_eq!(fs::read(target).unwrap(), b"original file bytes");
	}
}
