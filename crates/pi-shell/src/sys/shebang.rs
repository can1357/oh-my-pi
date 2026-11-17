//! `#!` lines: parse them and decide how a script runs.
//!
//! Windows has no kernel `#!` support, so the host parses the line itself; on
//! every platform a script whose interpreter is a shell the engine
//! implements (`sh`, `bash`, `zsh`, directly or through `/usr/bin/env`) runs
//! in-engine as [`Resolved::SelfShell`](crate::bash::Resolved::SelfShell)
//!, which keeps nested shells visible and on the VFS.
//!
//! Parsing follows Linux `binfmt_script`: at most [`HEAD_LEN`] bytes are
//! read, the interpreter is the first word after `#!`, and the rest of the
//! line (trimmed) is one optional argument. `/usr/bin/env` arguments are
//! split on blanks (`env -S` semantics), since that is what scripts using
//! `#!/usr/bin/env bash -e` expect on macOS and with `-S` on Linux.

use std::{fs, io, io::Read, path::Path};

use bstr::{BStr, BString, ByteSlice};

/// Bytes of a file the kernel looks at for `#!` (Linux `BINPRM_BUF_SIZE`).
pub const HEAD_LEN: usize = 256;

/// Shells run in-engine.
const SELF_SHELLS: [&[u8]; 3] = [b"sh", b"bash", b"zsh"];

/// A parsed `#!` line, borrowing the file head.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Shebang<'a> {
	/// Interpreter path as written (`/usr/bin/env`, `/bin/bash`).
	pub interpreter: &'a BStr,
	/// The rest of the line, trimmed; `None` when empty.
	pub arg:         Option<&'a BStr>,
}

/// How to run a script with a `#!` line.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Launch<'a> {
	/// In-engine ([`Resolved::SelfShell`](crate::bash::Resolved::SelfShell)):
	/// `name` is the shell's `argv[0]` (`sh`, `bash`, `zsh`), `args` the
	/// options before the script path.
	SelfShell {
		/// Shell name.
		name: &'a BStr,
		/// Options from the `#!` line.
		args: Vec<&'a BStr>,
	},
	/// Search `name` on `PATH` (`#!/usr/bin/env name …`, or any interpreter
	/// on Windows, see [`Launch::for_windows`]).
	Search {
		/// Program name.
		name: &'a BStr,
		/// Arguments from the `#!` line.
		args: Vec<&'a BStr>,
	},
	/// Run the interpreter at `path`.
	Path {
		/// Interpreter path.
		path: &'a BStr,
		/// The single argument from the `#!` line, if any.
		args: Vec<&'a BStr>,
	},
}

/// Parse the `#!` line at the start of `head` (the first bytes of a file;
/// only [`HEAD_LEN`] of them count). `None` without `#!` or interpreter.
pub fn parse(head: &[u8]) -> Option<Shebang<'_>> {
	let head = &head[..head.len().min(HEAD_LEN)];
	let line = head.strip_prefix(b"#!")?;
	let line = line.find_byte(b'\n').map_or(line, |n| &line[..n]);
	let line = line.strip_suffix(b"\r").unwrap_or(line);
	let line = line.trim_start_with(|c| c == ' ' || c == '\t');
	let end = line.find_byteset(b" \t").unwrap_or(line.len());
	let (interp, rest) = line.split_at(end);
	if interp.is_empty() {
		return None;
	}
	let rest = rest.trim_with(|c| c == ' ' || c == '\t');
	Some(Shebang {
		interpreter: interp.as_bstr(),
		arg:         (!rest.is_empty()).then(|| rest.as_bstr()),
	})
}

/// Last path component (either separator, so Windows paths work too).
fn basename(path: &[u8]) -> &[u8] {
	path.rfind_byteset(b"/\\").map_or(path, |i| &path[i + 1..])
}

fn is_self_shell(name: &[u8]) -> bool {
	SELF_SHELLS.contains(&name)
}

impl<'a> Shebang<'a> {
	/// How to run the script.
	pub fn launch(&self) -> Launch<'a> {
		let base = basename(self.interpreter);
		if base == b"env" {
			let mut words: Vec<&'a BStr> = self.arg.map_or_else(Vec::new, |a| {
				// ASCII blanks (bstr's Unicode `fields` would link its
				// whitespace DFA into every shell).
				a.split(u8::is_ascii_whitespace)
					.filter(|w| !w.is_empty())
					.map(BStr::new)
					.collect()
			});
			if words.first().is_some_and(|w| *w == "-S") {
				words.remove(0);
			}
			if !words.is_empty() && !words[0].starts_with(b"-") && !words[0].contains(&b'=') {
				let name = words.remove(0);
				return if is_self_shell(name) {
					Launch::SelfShell { name, args: words }
				} else {
					Launch::Search { name, args: words }
				};
			}
		} else if is_self_shell(base) {
			return Launch::SelfShell { name: base.as_bstr(), args: self.arg.into_iter().collect() };
		}
		Launch::Path { path: self.interpreter, args: self.arg.into_iter().collect() }
	}
}

impl Launch<'_> {
	/// Windows has no `/usr/bin/python3`: an absolute POSIX interpreter path
	/// becomes a `PATH` search for its basename (`python3`, resolved with
	/// `PATHEXT`). Other launches are unchanged.
	pub fn for_windows(self) -> Self {
		match self {
			Self::Path { path, args } if path.starts_with(b"/") => {
				Self::Search { name: basename(path).as_bstr(), args }
			},
			other => other,
		}
	}

	/// The argument vector that runs `script` with `script_args`: the
	/// interpreter (or shell, or program name), the `#!` arguments, the script
	/// path, then the script's own arguments.
	pub fn argv(&self, script: &BStr, script_args: &[BString]) -> Vec<BString> {
		let (head, args) = match self {
			Self::SelfShell { name, args } | Self::Search { name, args } => (*name, args),
			Self::Path { path, args } => (*path, args),
		};
		let mut argv = Vec::with_capacity(2 + args.len() + script_args.len());
		argv.push(BString::from(head.as_bytes()));
		argv.extend(args.iter().map(|a| BString::from(a.as_bytes())));
		argv.push(BString::from(script.as_bytes()));
		argv.extend(script_args.iter().cloned());
		argv
	}
}

/// The `#!` line of the file at `path`, owned. `Ok(None)` when the file has
/// none.
pub fn read(path: &Path) -> io::Result<Option<OwnedShebang>> {
	let mut head = [0u8; HEAD_LEN];
	let n = read_head(path, &mut head)?;
	Ok(parse(&head[..n]).map(|s| OwnedShebang {
		interpreter: BString::from(s.interpreter.as_bytes()),
		arg:         s.arg.map(|a| BString::from(a.as_bytes())),
	}))
}

/// Whether the file at `path` starts with `#!` (Windows `test -x`).
pub fn has_shebang(path: &Path) -> bool {
	let mut head = [0u8; 2];
	read_head(path, &mut head).is_ok_and(|n| n == 2 && head == *b"#!")
}

fn read_head(path: &Path, buf: &mut [u8]) -> io::Result<usize> {
	let mut f = fs::File::open(path)?;
	let mut n = 0;
	while n < buf.len() {
		match f.read(&mut buf[n..]) {
			Ok(0) => break,
			Ok(m) => n += m,
			Err(e) if e.kind() == io::ErrorKind::Interrupted => {},
			Err(e) => return Err(e),
		}
	}
	Ok(n)
}

/// An owned [`Shebang`] (from [`read`]).
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct OwnedShebang {
	/// Interpreter path as written.
	pub interpreter: BString,
	/// The rest of the line, trimmed.
	pub arg:         Option<BString>,
}

impl OwnedShebang {
	/// Borrow as a [`Shebang`].
	pub fn as_shebang(&self) -> Shebang<'_> {
		Shebang {
			interpreter: self.interpreter.as_bstr(),
			arg:         self.arg.as_ref().map(|a| a.as_bstr()),
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn launch(head: &str) -> Option<Launch<'_>> {
		parse(head.as_bytes()).map(|s| s.launch())
	}

	fn b(s: &str) -> &BStr {
		s.as_bytes().as_bstr()
	}

	#[test]
	fn lines_parse_like_binfmt_script() {
		assert_eq!(
			parse(b"#! /usr/bin/python3  -u -x \r\nprint()"),
			Some(Shebang { interpreter: b("/usr/bin/python3"), arg: Some(b("-u -x")) }),
			"blanks skipped, the rest is one argument, CR stripped"
		);
		assert_eq!(parse(b"#!/bin/sh"), Some(Shebang { interpreter: b("/bin/sh"), arg: None }));
		assert_eq!(parse(b"#!\n"), None);
		assert_eq!(parse(b"#!   \t\n"), None);
		assert_eq!(parse(b"# !/bin/sh\n"), None);
		assert_eq!(parse(b"echo hi\n"), None);
		let mut long = b"#!/bin/".to_vec();
		long.extend(std::iter::repeat_n(b'x', 400));
		assert_eq!(parse(&long).unwrap().interpreter.len(), HEAD_LEN - 2, "truncated at HEAD_LEN");
	}

	#[test]
	fn shells_run_in_engine_directly_or_through_env() {
		assert_eq!(launch("#!/bin/sh\n"), Some(Launch::SelfShell { name: b("sh"), args: vec![] }));
		assert_eq!(
			launch("#!/usr/local/bin/bash -e\n"),
			Some(Launch::SelfShell { name: b("bash"), args: vec![b("-e")] })
		);
		assert_eq!(
			launch("#!/usr/bin/env bash\n"),
			Some(Launch::SelfShell { name: b("bash"), args: vec![] })
		);
		assert_eq!(
			launch("#!/usr/bin/env -S zsh -f\n"),
			Some(Launch::SelfShell { name: b("zsh"), args: vec![b("-f")] })
		);
		assert_eq!(
			launch("#!/usr/bin/env bash -eu\n"),
			Some(Launch::SelfShell { name: b("bash"), args: vec![b("-eu")] })
		);
	}

	#[test]
	fn other_interpreters_are_searched_or_run_by_path() {
		assert_eq!(
			launch("#!/usr/bin/env python3\n"),
			Some(Launch::Search { name: b("python3"), args: vec![] })
		);
		assert_eq!(
			launch("#!/usr/bin/python3 -u\n"),
			Some(Launch::Path { path: b("/usr/bin/python3"), args: vec![b("-u")] })
		);
		assert_eq!(
			launch("#!/usr/bin/env FOO=1 node\n"),
			Some(Launch::Path { path: b("/usr/bin/env"), args: vec![b("FOO=1 node")] }),
			"env with assignments runs env itself"
		);
		assert_eq!(
			launch("#!/bin/bashful\n"),
			Some(Launch::Path { path: b("/bin/bashful"), args: vec![] })
		);
	}

	#[test]
	fn windows_searches_posix_interpreter_paths_by_basename() {
		let l = launch("#!/usr/bin/python3 -u\n").unwrap().for_windows();
		assert_eq!(l, Launch::Search { name: b("python3"), args: vec![b("-u")] });
		let l = launch("#!C:\\Python\\python.exe\n").unwrap().for_windows();
		assert_eq!(l, Launch::Path { path: b("C:\\Python\\python.exe"), args: vec![] });
		assert_eq!(l.argv(b("s.py"), &[BString::from("a")]), vec![
			BString::from("C:\\Python\\python.exe"),
			BString::from("s.py"),
			BString::from("a")
		]);
	}

	#[test]
	fn reading_a_file_head() {
		let dir = std::env::temp_dir().join(format!("obash-shebang-{}", std::process::id()));
		fs::create_dir_all(&dir).unwrap();
		let script = dir.join("s");
		fs::write(&script, b"#!/usr/bin/env bash\necho hi\n").unwrap();
		let owned = read(&script).unwrap().unwrap();
		assert_eq!(owned.as_shebang().launch(), Launch::SelfShell { name: b("bash"), args: vec![] });
		assert!(has_shebang(&script));
		fs::write(&script, b"#").unwrap();
		assert!(!has_shebang(&script));
		assert_eq!(read(&script).unwrap(), None);
		fs::remove_dir_all(&dir).unwrap();
	}
}
