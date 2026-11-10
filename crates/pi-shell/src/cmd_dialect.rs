//! Command lines written for the Windows programs pi's utilities shadow.
//!
//! On Windows the bash tool's `find`, `sort`, `timeout` and `whoami` are
//! pi's GNU-style utilities, found before `C:\Windows\System32`'s programs of
//! the same names, whose options are `/X` switches. A `/X` switch reads to a
//! GNU utility as an MSYS drive path (`find /c /v ""` walks all of `C:`), so a
//! command line in the program's own syntax goes to that program instead
//! ([`crate::bash::Host::defers_to_path`]).
//!
//! The syntax is decided from the arguments alone: the first is one of the
//! program's switches, and nothing after it is GNU syntax (an `-option`, or
//! `find`'s `(`, `)`, `!`). Values of switches that take one are skipped, so
//! `timeout /T -1` stays cmd's. `find /c -name x` names a GNU expression and
//! stays GNU. `hostname` has no switches; `fc` and `help` are bash's own
//! builtins, which shadow the programs in every bash on Windows.

/// A switch `/NAME`, accepted as any prefix of `NAME` at least `min` letters
/// long, case-insensitively (`/OFF` for `/OFFLINE`); `value` when the next
/// argument is its value.
struct Switch {
	name:  &'static str,
	min:   usize,
	value: bool,
}

const fn flag(name: &'static str, min: usize) -> Switch {
	Switch { name, min, value: false }
}

const fn valued(name: &'static str, min: usize) -> Switch {
	Switch { name, min, value: true }
}

/// The shadowed programs with `/` switches, as `PROGRAM /?` lists them.
/// Every program also takes `/?`.
const PROGRAMS: &[(&str, &[Switch])] = &[
	("find", &[flag("V", 1), flag("C", 1), flag("N", 1), flag("I", 1), flag("OFFLINE", 3)]),
	// `/+n` (the column to sort on) is matched apart.
	("sort", &[
		flag("REVERSE", 1),
		valued("LOCALE", 1),
		valued("MEMORY", 1),
		valued("RECORD_MAXIMUM", 3),
		valued("TEMPORARY", 1),
		valued("OUTPUT", 1),
	]),
	("timeout", &[valued("T", 1), flag("NOBREAK", 7)]),
	("whoami", &[
		flag("UPN", 3),
		flag("FQDN", 4),
		flag("USER", 4),
		flag("GROUPS", 6),
		flag("CLAIMS", 6),
		flag("PRIV", 4),
		flag("LOGONID", 7),
		flag("ALL", 3),
		valued("FO", 2),
		flag("NH", 2),
	]),
];

/// Whether `args` (the arguments after the command name) are written for the
/// Windows program `name` shadows: see the module documentation.
pub fn speaks_shadowed_program(name: &[u8], args: &[impl AsRef<[u8]>]) -> bool {
	let Some(switches) = PROGRAMS
		.iter()
		.find(|(program, _)| program.as_bytes() == name)
		.map(|(_, switches)| *switches)
	else {
		return false;
	};
	if args
		.first()
		.is_none_or(|first| switch(switches, first.as_ref()).is_none())
	{
		return false;
	}
	let mut rest = args.iter().map(AsRef::as_ref);
	while let Some(arg) = rest.next() {
		match switch(switches, arg) {
			Some(true) => {
				rest.next();
			},
			Some(false) => {},
			None if is_gnu_syntax(arg) => return false,
			None => {},
		}
	}
	true
}

/// `Some(takes a value)` when `arg` is one of `switches`, `/?`, or `sort`'s
/// `/+n`; `None` otherwise.
fn switch(switches: &[Switch], arg: &[u8]) -> Option<bool> {
	let body = arg.strip_prefix(b"/")?;
	if body == b"?" {
		return Some(false);
	}
	if let Some(column) = body.strip_prefix(b"+")
		&& switches.iter().any(|s| s.name == "REVERSE")
	{
		return (!column.is_empty() && column.iter().all(u8::is_ascii_digit)).then_some(false);
	}
	switches
		.iter()
		.find(|s| {
			body.len() >= s.min
				&& body.len() <= s.name.len()
				&& body.eq_ignore_ascii_case(&s.name.as_bytes()[..body.len()])
		})
		.map(|s| s.value)
}

/// GNU option or `find` expression syntax: `-x`, `--x`, `(`, `)`, `!`.
const fn is_gnu_syntax(arg: &[u8]) -> bool {
	(arg.len() > 1 && arg[0] == b'-') || matches!(arg, b"(" | b")" | b"!")
}

#[cfg(test)]
mod tests {
	use super::speaks_shadowed_program;

	fn speaks(line: &str) -> bool {
		let mut words = line.split(' ');
		let name = words.next().unwrap_or_default();
		let args: Vec<&str> = words.collect();
		speaks_shadowed_program(name.as_bytes(), &args)
	}

	#[test]
	fn cmd_syntax_goes_to_the_shadowed_program() {
		for line in [
			"find /c /v \"\"",
			"find /I node",
			"find /off x file.txt",
			"find /?",
			// The first argument decides: cmd's `FIND` rejects this at once,
			// where GNU `find` would list all of `C:`.
			"find /c",
			"sort /r",
			"sort /+3 in.txt",
			"sort /REC 4096 /o out.txt",
			"timeout /t 5",
			"timeout /T -1 /nobreak",
			"whoami /all",
			"whoami /fo csv /nh",
		] {
			assert!(speaks(line), "{line}");
		}
	}

	#[test]
	fn gnu_syntax_and_paths_stay_with_the_builtin() {
		for line in [
			// A GNU expression after a drive-root start point.
			"find /c -name x",
			"find /c ( -name x )",
			"find /c/Users -name x",
			"find . -name x",
			// Not one of the program's switches.
			"sort /x",
			"sort /tmp/data.txt",
			"sort /+ in.txt",
			"sort -r /r",
			"timeout 5 sleep 10",
			"whoami",
			"whoami /us",
			// No switches to shadow.
			"hostname /a",
			"ls /c",
		] {
			assert!(!speaks(line), "{line}");
		}
	}
}
