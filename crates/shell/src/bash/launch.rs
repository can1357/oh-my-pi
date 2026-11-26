//! Launcher-prefix walking for command lines (`env`, `sudo`, `nice`,
//! `timeout`, `xargs`, `npx`, `bunx`, `uv run`, `ssh host`, …).
//!
//! Shared policy imported by:
//! - spawn-time URL rewriting (`crate::host::urls`),
//! - client-terminal URL rewriting (via `omp-natives`'s `shell_launch_index`),
//! - embedded-language preview highlighting
//!   (`crate::bash::trace::viz::embedded`).
//!
//! Additions or option changes here affect all three callers.

/// A command line past its launchers (`env`, `timeout`, `sudo`, `uv run`,
/// `ssh host`, …).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Launch {
	/// Index of the word naming the program; for `ssh`, of its first remote
	/// word, if any (none: the remote login shell runs stdin).
	pub at:     usize,
	/// The program runs on an `ssh` host.
	pub remote: bool,
}

/// Walk past launchers at the start of `words` using host path conventions.
pub fn launch<W: AsRef<[u8]>>(words: &[W]) -> Launch {
	launch_with(words, cfg!(windows))
}

/// Walk past launchers at the start of `words`, stripping `\` path prefixes and
/// `.exe` suffixes when `windows` is `true`.
pub fn launch_with<W: AsRef<[u8]>>(words: &[W], windows: bool) -> Launch {
	let mut launch = Launch { at: 0, remote: false };
	while let Some((skip, remote)) = launcher(&words[launch.at..], windows) {
		launch.at = (launch.at + skip).min(words.len());
		launch.remote |= remote;
	}
	launch
}

/// `NAME=VALUE` (or `NAME+=VALUE`), as `sudo`, `doas`, `time`, and `env`
/// shebangs take before the command they run.
pub fn is_assignment(word: &[u8]) -> bool {
	let Some(eq) = word.iter().position(|&b| b == b'=') else {
		return false;
	};
	let name = word[..eq].strip_suffix(b"+").unwrap_or(&word[..eq]);
	!name.is_empty()
		&& (name[0].is_ascii_alphabetic() || name[0] == b'_')
		&& name[1..]
			.iter()
			.all(|b| b.is_ascii_alphanumeric() || *b == b'_')
}

fn command_name(word: &[u8], windows: bool) -> Option<&str> {
	let mut name = word
		.rsplit(|&b| b == b'/' || (windows && b == b'\\'))
		.next()
		.unwrap_or(word);
	if windows && name.len() > 4 && name[name.len() - 4..].eq_ignore_ascii_case(b".exe") {
		name = &name[..name.len() - 4];
	}
	std::str::from_utf8(name).ok()
}

/// Index of the first operand from `from` on, past the options.
/// `short_vals`/`long_vals` name options whose value is the next word (or
/// attached to the short cluster); `stop_shorts`/`stop_longs` name options
/// that prevent executing a positional command (`command -v`, `npx -c`,
/// `uv run -m`).
fn skip_options<W: AsRef<[u8]>>(
	words: &[W],
	from: usize,
	short_vals: &[u8],
	long_vals: &[&str],
	stop_shorts: &[u8],
	stop_longs: &[&str],
) -> Option<usize> {
	let mut i = from;
	while let Some(word) = words.get(i) {
		let w = word.as_ref();
		if w == b"--" {
			return Some((i + 1).min(words.len()));
		}
		if !w.starts_with(b"-") || w == b"-" {
			break;
		}
		if w.starts_with(b"--") {
			let opt_name = w.iter().position(|&b| b == b'=').map_or(w, |eq| &w[..eq]);
			if stop_longs.iter().any(|&opt| opt_name == opt.as_bytes()) {
				return None;
			}
			if w.contains(&b'=') {
				i += 1;
			} else if long_vals.iter().any(|&opt| w == opt.as_bytes()) {
				i += 2;
			} else {
				i += 1;
			}
			continue;
		}
		let mut consumed = false;
		for k in 1..w.len() {
			if stop_shorts.contains(&w[k]) {
				return None;
			}
			if short_vals.contains(&w[k]) {
				i += if k + 1 < w.len() { 1 } else { 2 };
				consumed = true;
				break;
			}
		}
		if !consumed {
			i += 1;
		}
	}
	Some(i.min(words.len()))
}

/// Words a launcher at the start of `words` takes before the command it runs
/// (`timeout 5 cmd` → 2), and whether that command runs on an `ssh` host.
fn launcher<W: AsRef<[u8]>>(words: &[W], windows: bool) -> Option<(usize, bool)> {
	let skip = match command_name(words.first()?.as_ref(), windows)? {
		"env" => {
			let mut at = skip_options(
				words,
				1,
				b"uCSaP",
				&["--unset", "--chdir", "--split-string", "--argv0", "--env0-from"],
				b"",
				&[],
			)?;
			if words.get(at).is_some_and(|w| w.as_ref() == b"-") {
				at += 1;
			}
			at + words[at..]
				.iter()
				.take_while(|w| w.as_ref().contains(&b'='))
				.count()
		},
		"sudo" | "doas" => {
			let at = skip_options(
				words,
				1,
				b"ugCDhpRrTtUac",
				&[
					"--user",
					"--group",
					"--close-from",
					"--chdir",
					"--host",
					"--prompt",
					"--chroot",
					"--role",
					"--command-timeout",
					"--type",
					"--other-user",
				],
				b"",
				&[],
			)?;
			at + words[at..]
				.iter()
				.take_while(|w| is_assignment(w.as_ref()))
				.count()
		},
		// The first operand is the duration.
		"timeout" | "gtimeout" => {
			skip_options(words, 1, b"sk", &["--signal", "--kill-after"], b"", &[])? + 1
		},
		"nice" => skip_options(words, 1, b"n", &["--adjustment"], b"", &[])?,
		"nohup" | "setsid" | "ifne" => skip_options(words, 1, b"", &[], b"", &[])?,
		"time" => {
			let at = skip_options(words, 1, b"of", &["--output", "--format"], b"", &[])?;
			at + words[at..]
				.iter()
				.take_while(|w| is_assignment(w.as_ref()))
				.count()
		},
		"stdbuf" => skip_options(words, 1, b"ioe", &["--input", "--output", "--error"], b"", &[])?,
		"command" => skip_options(words, 1, b"", &[], b"vV", &[])?,
		"exec" => skip_options(words, 1, b"a", &[], b"", &[])?,
		"xargs" => skip_options(
			words,
			1,
			b"adEILnPs",
			&[
				"--arg-file",
				"--delimiter",
				"--max-args",
				"--max-procs",
				"--max-chars",
				"--process-slot-var",
			],
			b"",
			&[],
		)?,
		"npx" => skip_options(
			words,
			1,
			b"pcw",
			&[
				"--package",
				"--call",
				"--cache",
				"--userconfig",
				"--prefix",
				"--loglevel",
				"--workspace",
				"--shell",
				"--registry",
				"--node-options",
			],
			b"c",
			&["--call"],
		)?,
		"bunx" => skip_options(
			words,
			1,
			b"pc",
			&["--package", "--shell", "--registry", "--minimum-release-age", "--cwd", "--config"],
			b"c",
			&[],
		)?,
		"uv" if words.get(1).is_some_and(|w| w.as_ref() == b"run") => skip_options(
			words,
			2,
			b"wpifm",
			&[
				"--with",
				"--with-editable",
				"--with-requirements",
				"--python",
				"--package",
				"--project",
				"--directory",
				"--env-file",
				"--extra",
				"--group",
				"--only-group",
				"--no-group",
				"--index",
				"--default-index",
				"--index-url",
				"--extra-index-url",
				"--find-links",
				"--config-file",
				"--cache-dir",
				"--module",
				"--script",
				"--gui-script",
			],
			b"m",
			&["--module", "--script", "--gui-script"],
		)?,
		"ssh" => {
			let host = skip_options(words, 1, b"BbcDEeFIiJLlmOopQRSWw", &[], b"", &[])?;
			return (host < words.len()).then_some((host + 1, true));
		},
		_ => return None,
	};
	Some((skip, false))
}
