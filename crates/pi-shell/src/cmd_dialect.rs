//! Command lines written for the Windows programs pi's utilities shadow.
//!
//! On Windows the bash tool's `find`, `sort`, `timeout` and `whoami` are
//! pi's GNU-style utilities, found before `C:\Windows\System32`'s programs of
//! the same names, whose options are `/X` switches. A `/X` switch reads to a
//! GNU utility as an MSYS drive path (`find /c /v ""` walks all of `C:`), so a
//! command line written in the program's own syntax goes to that program
//! instead ([`crate::bash::Host::defers_to_path`]).
//!
//! The syntax is decided by markers, tokens only one side writes:
//!
//! - a cmd marker is one of the program's switches (`/c`, `/NOBREAK`), anywhere
//!   on the line, as the programs accept them anywhere;
//! - a GNU marker is GNU option or expression syntax: `-x`, `--x`, `(`, `)`,
//!   `!`.
//!
//! Any GNU marker makes the line GNU. Otherwise a cmd marker makes it cmd,
//! unless the line has more operands than the program takes (`timeout 5 sort
//! /t x` is GNU `timeout` running `sort`). With neither marker it stays GNU:
//! the shell is bash.
//!
//! Whether the GNU reading is valid is never consulted: `find /c` is valid
//! GNU, a walk of all of `C:`, and still cmd. A cmd line missing a required
//! operand (`find /c` has no search string) still goes to the program, which
//! reports its own usage error.
//!
//! `hostname` has no switches; `fc` and `help` are bash's own builtins, which
//! shadow the programs in every bash on Windows.

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

/// A shadowed program's cmd grammar, as `PROGRAM /?` gives it. Every
/// program also takes `/?`.
struct Program {
	name:          &'static str,
	switches:      &'static [Switch],
	/// `sort`'s `/+n`, the column to sort on.
	column:        bool,
	/// Most operands the program takes; `None`: any number (`find`'s files).
	most_operands: Option<usize>,
}

const PROGRAMS: &[Program] = &[
	// `FIND [/V] [/C] [/N] [/I] [/OFF[LINE]] "string" [files…]`
	Program {
		name:          "find",
		switches:      &[flag("V", 1), flag("C", 1), flag("N", 1), flag("I", 1), flag("OFFLINE", 3)],
		column:        false,
		most_operands: None,
	},
	// `SORT [/R] [/+n] [/M kilobytes] [/L locale] [/REC recordbytes] [file]
	// [/T dir] [/O file]`
	Program {
		name:          "sort",
		switches:      &[
			flag("REVERSE", 1),
			valued("LOCALE", 1),
			valued("MEMORY", 1),
			valued("RECORD_MAXIMUM", 3),
			valued("TEMPORARY", 1),
			valued("OUTPUT", 1),
		],
		column:        true,
		most_operands: Some(1),
	},
	// `TIMEOUT [/T] timeout [/NOBREAK]`
	Program {
		name:          "timeout",
		switches:      &[valued("T", 1), flag("NOBREAK", 7)],
		column:        false,
		most_operands: Some(1),
	},
	// `WHOAMI [/UPN | /FQDN | /LOGONID | /USER | /GROUPS | /CLAIMS | /PRIV |
	// /ALL] [/FO format] [/NH]`
	Program {
		name:          "whoami",
		switches:      &[
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
		],
		column:        false,
		most_operands: Some(0),
	},
];

impl Program {
	/// `Some(takes a value)` when `arg` is one of the program's switches,
	/// `/?`, or `sort`'s `/+n`; `None` otherwise.
	fn switch(&self, arg: &[u8]) -> Option<bool> {
		let body = arg.strip_prefix(b"/")?;
		if body == b"?" {
			return Some(false);
		}
		if let Some(column) = body.strip_prefix(b"+") {
			return (self.column && !column.is_empty() && column.iter().all(u8::is_ascii_digit))
				.then_some(false);
		}
		self
			.switches
			.iter()
			.find(|s| {
				body.len() >= s.min
					&& body.len() <= s.name.len()
					&& body.eq_ignore_ascii_case(&s.name.as_bytes()[..body.len()])
			})
			.map(|s| s.value)
	}
}

/// Whether `args` (the arguments after the command name) are written for the
/// Windows program `name` shadows: see the module documentation.
pub fn speaks_shadowed_program(name: &[u8], args: &[impl AsRef<[u8]>]) -> bool {
	let Some(program) = PROGRAMS.iter().find(|p| p.name.as_bytes() == name) else {
		return false;
	};
	let (mut switches, mut operands) = (0usize, 0usize);
	let mut rest = args.iter().map(AsRef::as_ref);
	while let Some(arg) = rest.next() {
		match program.switch(arg) {
			Some(takes_value) => {
				switches += 1;
				if takes_value {
					rest.next();
				}
			},
			None if is_gnu_syntax(arg) => return false,
			None => operands += 1,
		}
	}
	switches > 0 && program.most_operands.is_none_or(|most| operands <= most)
}

/// Whether `arg` is one of the switches of the Windows program `name`
/// shadows (`/C` for `find`): what that program reads as a switch, not as
/// its search string or a file ([`crate::sys::cmdline::find_command_line`]).
pub fn is_switch(name: &[u8], arg: &[u8]) -> bool {
	PROGRAMS
		.iter()
		.find(|p| p.name.as_bytes() == name)
		.is_some_and(|p| p.switch(arg).is_some())
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
	fn cmd_markers_without_gnu_markers_go_to_the_shadowed_program() {
		for line in [
			// The common shapes in agent sessions.
			"find /c /v \"\"",
			"find /c chrome",
			"whoami /groups",
			// Valid GNU, and still cmd: GNU would list all of `C:`.
			"find /c",
			// Switches anywhere, as the programs take them.
			"find BANANA /i f.txt",
			"find a f.txt /c",
			"sort data.txt /r",
			"timeout 5 /nobreak",
			// Values of valued switches are not markers.
			"timeout /T -1 /nobreak",
			"sort /REC 4096 /o out.txt",
			"whoami /fo csv /nh",
			"sort /+3 in.txt",
			"find /off x f.txt g.txt",
			"find /?",
		] {
			assert!(speaks(line), "{line}");
		}
	}

	#[test]
	fn gnu_markers_extra_operands_and_unmarked_lines_stay_with_the_builtin() {
		for line in [
			// A GNU marker anywhere.
			"find /c -name x",
			"find /c ( -name x )",
			"find /c -x",
			"sort -r /r",
			// More operands than the program takes.
			"timeout 5 sort /t x",
			"sort a.txt b.txt /r",
			"whoami /all extra",
			// No cmd marker: paths and unknown switches are operands.
			"find /c/Users -name x",
			"find . -name x",
			"find test",
			"sort /tmp/data.txt",
			"sort /x",
			"sort /+ in.txt",
			"timeout 5 sleep 10",
			"whoami",
			"whoami /us",
			"hostname /a",
			"ls /c",
		] {
			assert!(!speaks(line), "{line}");
		}
	}
}
