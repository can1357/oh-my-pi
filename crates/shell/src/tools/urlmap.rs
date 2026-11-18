//! `urlmap`: the session's URL mounts ([`crate::mounts`]).
//!
//! ```text
//! urlmap [-r] [-e] URL PATH   mount PATH at URL; -r read-only, -e URL itself only
//! urlmap -d URL               remove the mounts at URL
//! urlmap                      list the mounts as `urlmap` commands
//! ```
//!
//! A mount takes effect for what the shell starts next: the paths its own
//! commands open and the files it hands to the programs it runs. It answers
//! at once; nothing is checked on the host, so a mount may name an entry that
//! appears later.

use std::path::{Path, PathBuf};

use bstr::{BString, ByteSlice};

use super::{Child, Out, ToolConfig};
use crate::{
	bash::{CallOutcome, ShellApi, ToolCall},
	mounts::MountError,
};

/// Status of a usage error, as the engine's builtins report one.
const EXIT_USAGE: i32 = 2;

const HELP: &str = "\
Usage: urlmap [-r] [-e] URL PATH
  or:  urlmap -d URL
  or:  urlmap
Map the URL path URL onto the host entry PATH, for this shell and the programs it runs.

  -r          read-only: refuse changes at and below URL
  -e          exact: map URL itself only, nothing below it
  -d          remove the mounts at URL
      --help  display this help and exit

With no operand, list the mounts as urlmap commands.
";

/// What an invocation asks for.
#[derive(Debug, PartialEq, Eq)]
enum Parsed {
	List,
	Mount {
		url:       BString,
		path:      BString,
		read_only: bool,
		exact:     bool,
	},
	Unmount(BString),
	Help,
	/// A usage error: the message after `urlmap: `.
	Usage(String),
}

/// Parse `argv` (with `urlmap` itself): single-letter options, which may be
/// combined (`-re`), up to the first operand or `--`.
fn parse(argv: &[BString]) -> Parsed {
	let (mut read_only, mut exact, mut delete) = (false, false, false);
	let mut operands = argv.get(1..).unwrap_or_default();
	while let Some(arg) = operands.first() {
		match arg.as_slice() {
			b"--help" => return Parsed::Help,
			b"--" => {
				operands = &operands[1..];
				break;
			},
			[b'-', flags @ ..] if !flags.is_empty() => {
				for &flag in flags {
					match flag {
						b'r' => read_only = true,
						b'e' => exact = true,
						b'd' => delete = true,
						_ => return Parsed::Usage(format!("-{}: invalid option", char::from(flag))),
					}
				}
				operands = &operands[1..];
			},
			_ => break,
		}
	}
	match (delete, operands) {
		(true, [url]) if !read_only && !exact => Parsed::Unmount(url.clone()),
		(false, []) if !read_only && !exact => Parsed::List,
		(false, [url, path]) => {
			Parsed::Mount { url: url.clone(), path: path.clone(), read_only, exact }
		},
		_ => Parsed::Usage("usage: urlmap [-r] [-e] URL PATH | -d URL".to_owned()),
	}
}

/// `text` as one shell word.
fn quote(text: &[u8], out: &mut Vec<u8>) {
	let plain = !text.is_empty()
		&& text
			.iter()
			.all(|&b| b.is_ascii_alphanumeric() || b"_./:@%+=,-".contains(&b));
	if plain {
		out.extend_from_slice(text);
		return;
	}
	out.push(b'\'');
	for &byte in text {
		if byte == b'\'' {
			out.extend_from_slice(b"'\\''");
		} else {
			out.push(byte);
		}
	}
	out.push(b'\'');
}

/// The absolute host path `operand` names from the directory `cwd`; `None`
/// when either is a URL path or cannot be a host path.
fn host_path(operand: &BString, cwd: &BString) -> Option<PathBuf> {
	let path = operand.to_path().ok()?;
	if operand.is_empty() || omp_vfs::is_virtual_path(path) {
		return None;
	}
	if path.is_absolute() {
		return Some(path.to_path_buf());
	}
	let cwd = cwd.to_path().ok()?;
	(!omp_vfs::is_virtual_path(cwd)).then(|| cwd.join(path))
}

const fn describe(err: &MountError) -> &'static str {
	match err {
		MountError::NotUrl => "not a URL path",
		MountError::Outside => "above its scheme's root",
	}
}

/// A `urlmap` call: answered when it is made, then only its output is left
/// to write.
pub(super) struct Urlmap {
	pub(super) child: Child,
	out:              Out,
	exit:             i32,
}

impl Urlmap {
	pub(super) fn new(call: &ToolCall, config: &ToolConfig) -> Self {
		let mut out = Out::default();
		let exit = match Self::run(call, config) {
			Ok(listing) => {
				out.push(1, listing);
				0
			},
			Err((status, message)) => {
				out.push(2, format!("urlmap: {message}\n"));
				status
			},
		};
		Self { child: Child::default(), out, exit }
	}

	/// What the call prints, or its status and the message after `urlmap: `.
	fn run(call: &ToolCall, config: &ToolConfig) -> Result<Vec<u8>, (i32, String)> {
		let parsed = parse(&call.argv);
		match &parsed {
			Parsed::Help => return Ok(HELP.into()),
			Parsed::Usage(message) => return Err((EXIT_USAGE, message.clone())),
			_ => {},
		}
		let Some(vfs) = &config.vfs else {
			return Err((1, "this shell has no URL paths".to_owned()));
		};
		let mounts = vfs.mounts();
		let failed = |url: &BString, err: &MountError| (1, format!("{url}: {}", describe(err)));
		match parsed {
			Parsed::Mount { url, path, read_only, exact } => {
				let host = host_path(&path, &call.cwd)
					.ok_or_else(|| (1, format!("{path}: not a host path")))?;
				let spelled = url
					.to_str()
					.map_err(|_| failed(&url, &MountError::NotUrl))?;
				mounts
					.add(spelled, host, read_only, exact)
					.map_err(|err| failed(&url, &err))?;
			},
			Parsed::Unmount(url) => {
				let spelled = url
					.to_str()
					.map_err(|_| failed(&url, &MountError::NotUrl))?;
				if !mounts.remove(spelled).map_err(|err| failed(&url, &err))? {
					return Err((1, format!("{url}: not mounted")));
				}
			},
			_ => {
				let mut listing = Vec::new();
				for mount in mounts.list() {
					listing.extend_from_slice(b"urlmap ");
					if mount.read_only {
						listing.extend_from_slice(b"-r ");
					}
					if mount.exact {
						listing.extend_from_slice(b"-e ");
					}
					quote(mount.url.as_bytes(), &mut listing);
					listing.push(b' ');
					quote(Path::as_os_str(&mount.host).as_encoded_bytes(), &mut listing);
					listing.push(b'\n');
				}
				return Ok(listing);
			},
		}
		vfs.remount();
		Ok(Vec::new())
	}

	pub(super) fn advance(&mut self, api: &mut ShellApi<'_, '_>) -> Option<CallOutcome> {
		self.out.flush(api).then_some(CallOutcome::Exit(self.exit))
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn parsed(argv: &[&str]) -> Parsed {
		let argv: Vec<BString> = std::iter::once("urlmap")
			.chain(argv.iter().copied())
			.map(BString::from)
			.collect();
		parse(&argv)
	}

	#[test]
	fn options_combine_and_end_at_the_first_operand() {
		let mount = |read_only, exact| Parsed::Mount {
			url: "skill://a".into(),
			path: "/s/a".into(),
			read_only,
			exact,
		};
		assert_eq!(parsed(&["skill://a", "/s/a"]), mount(false, false));
		assert_eq!(parsed(&["-r", "-e", "skill://a", "/s/a"]), mount(true, true));
		assert_eq!(parsed(&["-re", "--", "skill://a", "/s/a"]), mount(true, true));
		assert_eq!(parsed(&["-d", "skill://a"]), Parsed::Unmount("skill://a".into()));
		assert_eq!(parsed(&[]), Parsed::List);
		assert_eq!(parsed(&["--help"]), Parsed::Help);
		assert_eq!(parsed(&["-x", "a", "b"]), Parsed::Usage("-x: invalid option".to_owned()));
		for wrong in
			[&["skill://a"][..], &["-d"], &["-d", "a", "b"], &["-r"], &["-rd", "skill://a"], &[
				"a", "b", "c",
			]] {
			assert!(matches!(parsed(wrong), Parsed::Usage(_)), "{wrong:?}");
		}
	}

	#[test]
	fn a_listing_word_reads_back_as_the_text_it_was() {
		let quoted = |text: &str| {
			let mut out = Vec::new();
			quote(text.as_bytes(), &mut out);
			String::from_utf8(out).expect("utf-8")
		};
		assert_eq!(quoted("skill://a/b-c.md"), "skill://a/b-c.md");
		assert_eq!(quoted("/s/a b"), "'/s/a b'");
		assert_eq!(quoted("/s/it's"), "'/s/it'\\''s'");
		assert_eq!(quoted(""), "''");
	}
}
