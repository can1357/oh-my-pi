//! `errno` builtin: look up errno names, numbers, and descriptions.
//!
//! Ported from pi-shell's in-process implementation of the moreutils-inspired
//! `errno` utility. A name prints its `NAME NUMBER Description` line; numeric
//! arguments reverse-map to the first-listed canonical name. Lists include
//! aliases and are sorted by number, then name.

use std::io::Write;

use brush_core::{ShellExtensions, builtins::Registration};
use clap::{Arg, ArgAction, ArgMatches, Command};

use crate::host::{Host, Utility, format_usage, matches_parser, util};

const OPT_LIST: &str = "list";
const OPT_SEARCH: &str = "search";
const ARG_QUERY: &str = "query";

/// Errno name-to-number table. Duplicate numbers are aliases; the first name
/// listed for a number is canonical for reverse lookup.
const ERRNOS: &[(&str, i32)] = &[
	("EPERM", libc::EPERM),
	("ENOENT", libc::ENOENT),
	("ESRCH", libc::ESRCH),
	("EINTR", libc::EINTR),
	("EIO", libc::EIO),
	("ENXIO", libc::ENXIO),
	("E2BIG", libc::E2BIG),
	("ENOEXEC", libc::ENOEXEC),
	("EBADF", libc::EBADF),
	("ECHILD", libc::ECHILD),
	("EAGAIN", libc::EAGAIN),
	("ENOMEM", libc::ENOMEM),
	("EACCES", libc::EACCES),
	("EFAULT", libc::EFAULT),
	("ENOTBLK", libc::ENOTBLK),
	("EBUSY", libc::EBUSY),
	("EEXIST", libc::EEXIST),
	("EXDEV", libc::EXDEV),
	("ENODEV", libc::ENODEV),
	("ENOTDIR", libc::ENOTDIR),
	("EISDIR", libc::EISDIR),
	("EINVAL", libc::EINVAL),
	("ENFILE", libc::ENFILE),
	("EMFILE", libc::EMFILE),
	("ENOTTY", libc::ENOTTY),
	("ETXTBSY", libc::ETXTBSY),
	("EFBIG", libc::EFBIG),
	("ENOSPC", libc::ENOSPC),
	("ESPIPE", libc::ESPIPE),
	("EROFS", libc::EROFS),
	("EMLINK", libc::EMLINK),
	("EPIPE", libc::EPIPE),
	("EDOM", libc::EDOM),
	("ERANGE", libc::ERANGE),
	("EDEADLK", libc::EDEADLK),
	("ENAMETOOLONG", libc::ENAMETOOLONG),
	("ENOLCK", libc::ENOLCK),
	("ENOSYS", libc::ENOSYS),
	("ENOTEMPTY", libc::ENOTEMPTY),
	("ELOOP", libc::ELOOP),
	("ENOMSG", libc::ENOMSG),
	("EIDRM", libc::EIDRM),
	("EPROTO", libc::EPROTO),
	("EBADMSG", libc::EBADMSG),
	("EOVERFLOW", libc::EOVERFLOW),
	("EILSEQ", libc::EILSEQ),
	("ENOTSOCK", libc::ENOTSOCK),
	("EDESTADDRREQ", libc::EDESTADDRREQ),
	("EMSGSIZE", libc::EMSGSIZE),
	("EPROTOTYPE", libc::EPROTOTYPE),
	("ENOPROTOOPT", libc::ENOPROTOOPT),
	("EPROTONOSUPPORT", libc::EPROTONOSUPPORT),
	("ESOCKTNOSUPPORT", libc::ESOCKTNOSUPPORT),
	("ENOTSUP", libc::ENOTSUP),
	("EOPNOTSUPP", libc::EOPNOTSUPP),
	("EPFNOSUPPORT", libc::EPFNOSUPPORT),
	("EAFNOSUPPORT", libc::EAFNOSUPPORT),
	("EADDRINUSE", libc::EADDRINUSE),
	("EADDRNOTAVAIL", libc::EADDRNOTAVAIL),
	("ENETDOWN", libc::ENETDOWN),
	("ENETUNREACH", libc::ENETUNREACH),
	("ENETRESET", libc::ENETRESET),
	("ECONNABORTED", libc::ECONNABORTED),
	("ECONNRESET", libc::ECONNRESET),
	("ENOBUFS", libc::ENOBUFS),
	("EISCONN", libc::EISCONN),
	("ENOTCONN", libc::ENOTCONN),
	("ESHUTDOWN", libc::ESHUTDOWN),
	("ETOOMANYREFS", libc::ETOOMANYREFS),
	("ETIMEDOUT", libc::ETIMEDOUT),
	("ECONNREFUSED", libc::ECONNREFUSED),
	("EHOSTDOWN", libc::EHOSTDOWN),
	("EHOSTUNREACH", libc::EHOSTUNREACH),
	("EALREADY", libc::EALREADY),
	("EINPROGRESS", libc::EINPROGRESS),
	("ESTALE", libc::ESTALE),
	("EDQUOT", libc::EDQUOT),
	("ECANCELED", libc::ECANCELED),
	("EOWNERDEAD", libc::EOWNERDEAD),
	("ENOTRECOVERABLE", libc::ENOTRECOVERABLE),
	("EWOULDBLOCK", libc::EWOULDBLOCK),
];

/// Parsed `errno` invocation.
pub(crate) struct Errno {
	matches: ArgMatches,
}

matches_parser!(Errno, command);

impl Utility for Errno {
	const NAME: &'static str = "errno";

	fn run(self, host: &mut Host) -> i32 {
		let args: Vec<String> = self
			.matches
			.get_many::<String>(ARG_QUERY)
			.map(|values| values.cloned().collect())
			.unwrap_or_default();

		if self.matches.get_flag(OPT_LIST) {
			return list_all(host);
		}
		if self.matches.get_flag(OPT_SEARCH) {
			return search(host, &args);
		}
		if args.is_empty() {
			let _ = writeln!(host.stderr, "errno: no errno name or number given");
			return 1;
		}

		let mut failed = false;
		for arg in &args {
			if !lookup(host, arg) {
				failed = true;
			}
		}
		i32::from(failed)
	}
}

/// The `errno` argument model.
fn command() -> Command {
	Command::new(Errno::NAME)
		.version(concat!("errno (pi-shell) ", env!("CARGO_PKG_VERSION")))
		.about("Look up errno names and descriptions.")
		.override_usage(format_usage("errno [-ls] [--] [name-or-number...]"))
		.disable_help_flag(true)
		.disable_version_flag(true)
		.infer_long_args(true)
		.arg(
			Arg::new(OPT_LIST)
				.short('l')
				.long("list")
				.help("List all errno values")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_SEARCH)
				.short('s')
				.long("search")
				.help("Search errno descriptions for the given words")
				.action(ArgAction::SetTrue),
		)
		.arg(Arg::new("help").long("help").action(ArgAction::Help))
		.arg(
			Arg::new(ARG_QUERY)
				.value_name("NAME-OR-NUMBER")
				.num_args(0..)
				.allow_hyphen_values(true)
				.action(ArgAction::Append),
		)
}

/// Formats the OS description for an errno number without std's
/// ` (os error N)` suffix.
fn description(number: i32) -> String {
	let text = std::io::Error::from_raw_os_error(number).to_string();
	match text.rfind(" (os error ") {
		Some(index) => text[..index].to_string(),
		None => text,
	}
}

fn print_entry(host: &mut Host, name: &str, number: i32) {
	let _ = writeln!(host.stdout, "{name} {number} {}", description(number));
}

/// Looks up one name or number argument; returns false on failure.
fn lookup(host: &mut Host, arg: &str) -> bool {
	if let Ok(number) = arg.parse::<i32>() {
		// Kernel convention returns errors as negative errno values; resolve
		// `-2` the same as `2`. Reverse lookup: first-listed name for the
		// number is canonical.
		match number
			.checked_abs()
			.and_then(|number| ERRNOS.iter().find(|(_, value)| *value == number))
		{
			Some((name, value)) => {
				print_entry(host, name, *value);
				true
			},
			None => {
				let _ = writeln!(host.stderr, "errno: unknown errno {arg}");
				false
			},
		}
	} else if let Some((name, value)) = ERRNOS
		.iter()
		.find(|(name, _)| name.eq_ignore_ascii_case(arg))
	{
		print_entry(host, name, *value);
		true
	} else {
		let _ = writeln!(host.stderr, "errno: unknown errno {arg}");
		false
	}
}

/// Prints every table entry (aliases included) sorted by number, then name.
fn list_all(host: &mut Host) -> i32 {
	let mut entries: Vec<(&str, i32)> = ERRNOS.to_vec();
	entries.sort_unstable_by(|a, b| a.1.cmp(&b.1).then(a.0.cmp(b.0)));
	for (name, number) in entries {
		print_entry(host, name, number);
	}
	0
}

/// Prints entries whose descriptions contain all words, case-insensitively.
fn search(host: &mut Host, words: &[String]) -> i32 {
	let lowered: Vec<String> = words.iter().map(|word| word.to_lowercase()).collect();
	let mut entries: Vec<(&str, i32)> = ERRNOS.to_vec();
	entries.sort_unstable_by(|a, b| a.1.cmp(&b.1).then(a.0.cmp(b.0)));
	for (name, number) in entries {
		let text = description(number).to_lowercase();
		if lowered.iter().all(|word| text.contains(word.as_str())) {
			print_entry(host, name, number);
		}
	}
	0
}

/// Creates the `errno` builtin registration.
pub(crate) fn errno_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Errno, SE>()
}

#[cfg(test)]
mod tests {
	use super::Errno;
	use crate::host::run_util;

	fn run_errno(args: &[&str]) -> (i32, String, String) {
		let (code, capture) = run_util::<Errno>(args, "", "/");
		(code, capture.out(), capture.err())
	}

	#[test]
	fn looks_up_name() {
		let (code, stdout, stderr) = run_errno(&["ENOENT"]);
		assert_eq!(code, 0);
		assert!(stdout.starts_with(&format!("ENOENT {} ", libc::ENOENT)), "stdout: {stdout:?}");
		assert!(
			stdout.trim_end().len() > format!("ENOENT {} ", libc::ENOENT).len(),
			"missing description: {stdout:?}"
		);
		assert!(stderr.is_empty());
	}

	#[test]
	fn reverse_lookup_by_number() {
		let number = libc::ENOENT.to_string();
		let (code, stdout, _) = run_errno(&[&number]);
		assert_eq!(code, 0);
		assert!(stdout.starts_with(&format!("ENOENT {} ", libc::ENOENT)), "stdout: {stdout:?}");
	}

	#[test]
	fn unknown_name_fails_with_stderr() {
		let (code, stdout, stderr) = run_errno(&["ENOSUCHTHING"]);
		assert_eq!(code, 1);
		assert!(stdout.is_empty());
		assert!(stderr.contains("unknown errno ENOSUCHTHING"), "stderr: {stderr:?}");
	}

	#[test]
	fn unknown_number_fails_with_stderr() {
		// Failure mode: unknown numeric lookups exiting 1 with no diagnostic.
		let (code, stdout, stderr) = run_errno(&["99999"]);
		assert_eq!(code, 1);
		assert!(stdout.is_empty());
		assert!(stderr.contains("unknown errno 99999"), "stderr: {stderr:?}");
	}

	#[test]
	fn negative_number_resolves_by_absolute_value() {
		// Failure mode: clap rejecting `errno -2` as an unknown option instead
		// of resolving the kernel-style negative errno.
		let number = format!("-{}", libc::ENOENT);
		let (code, stdout, stderr) = run_errno(&[&number]);
		assert_eq!(code, 0);
		assert!(stdout.starts_with(&format!("ENOENT {} ", libc::ENOENT)), "stdout: {stdout:?}");
		assert!(stderr.is_empty(), "stderr: {stderr:?}");
	}

	#[test]
	fn unknown_negative_number_fails_with_stderr() {
		let (code, stdout, stderr) = run_errno(&["-99999"]);
		assert_eq!(code, 1);
		assert!(stdout.is_empty());
		assert!(stderr.contains("unknown errno -99999"), "stderr: {stderr:?}");
	}

	#[test]
	fn short_flags_still_win_over_hyphen_operands() {
		// Failure mode: allow_hyphen_values swallowing `-l` as a query.
		let (code, stdout, _) = run_errno(&["-l"]);
		assert_eq!(code, 0);
		assert!(
			stdout
				.lines()
				.any(|line| line.starts_with(&format!("ENOENT {} ", libc::ENOENT))),
			"-l no longer lists: {stdout:?}"
		);
	}

	#[test]
	fn list_is_sorted_by_number() {
		let (code, stdout, _) = run_errno(&["-l"]);
		assert_eq!(code, 0);
		let lines: Vec<&str> = stdout.lines().collect();
		let eperm = lines
			.iter()
			.position(|line| line.starts_with(&format!("EPERM {} ", libc::EPERM)));
		let enoent = lines
			.iter()
			.position(|line| line.starts_with(&format!("ENOENT {} ", libc::ENOENT)));
		assert!(eperm.is_some(), "EPERM missing from list");
		assert!(enoent.is_some(), "ENOENT missing from list");
		assert!(eperm.unwrap() < enoent.unwrap(), "list not number-sorted");
	}

	#[test]
	fn search_is_case_insensitive() {
		let (code, stdout, _) = run_errno(&["-s", "No", "SUCH"]);
		assert_eq!(code, 0);
		assert!(
			stdout
				.lines()
				.any(|line| line.starts_with(&format!("ENOENT {} ", libc::ENOENT))),
			"search missed ENOENT: {stdout:?}"
		);
	}

	#[test]
	fn multiple_args_aggregate_exit_code() {
		let (code, stdout, stderr) = run_errno(&["ENOENT", "ENOSUCHTHING", "EPERM"]);
		assert_eq!(code, 1);
		assert!(
			stdout
				.lines()
				.any(|line| line.starts_with(&format!("ENOENT {} ", libc::ENOENT)))
		);
		assert!(
			stdout
				.lines()
				.any(|line| line.starts_with(&format!("EPERM {} ", libc::EPERM)))
		);
		assert!(stderr.contains("unknown errno ENOSUCHTHING"));
	}

	#[test]
	fn no_args_is_an_error() {
		let (code, stdout, stderr) = run_errno(&[]);
		assert_eq!(code, 1);
		assert!(stdout.is_empty());
		assert!(!stderr.is_empty());
	}
}
