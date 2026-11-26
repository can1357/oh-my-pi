//! Launcher-prefix walking for command lines (`env`, `sudo`, `nice`,
//! `timeout`, `xargs`, `npx`, `bunx`, `uv run`, `ssh host`, …).
//!
//! Shared policy imported by:
//! - spawn-time URL rewriting (`crate::host::urls`),
//! - client-terminal URL rewriting (via `omp-natives`'s `shell_launch`),
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
	/// Byte offset in the word at `at` where the program's name starts: past
	/// an option carrying it (`env -S=omp`, `env --split-string=omp`).
	pub offset: usize,
	/// The word at `at`, from `offset`, is an `env -S`/`--split-string`
	/// command line: only its first word is the program. An ordinary path
	/// keeps its spaces.
	pub packed: bool,
}

impl Launch {
	/// The program the command line runs: the word at `at` past `offset`.
	/// A packed `env -S` command line (`env -S "omp read x"`) yields its
	/// first word; an ordinary path keeps its spaces (`/opt/My Tools/omp`).
	pub fn program<'a, W: AsRef<[u8]>>(&self, words: &'a [W]) -> Option<&'a str> {
		let word = words.get(self.at)?.as_ref();
		let word = word.get(self.offset..).unwrap_or(word);
		let end = if self.packed {
			word
				.iter()
				.position(|b| b.is_ascii_whitespace())
				.unwrap_or(word.len())
		} else {
			word.len()
		};
		std::str::from_utf8(&word[..end]).ok()
	}
}

/// Walk past launchers at the start of `words` using host path conventions.
pub fn launch<W: AsRef<[u8]>>(words: &[W]) -> Launch {
	launch_with(words, cfg!(windows))
}

/// Walk past launchers at the start of `words`, stripping `\` path prefixes and
/// `.exe` suffixes when `windows` is `true`.
pub fn launch_with<W: AsRef<[u8]>>(words: &[W], windows: bool) -> Launch {
	let mut launch = Launch { at: 0, remote: false, offset: 0, packed: false };
	while let Some((skip, remote, offset, packed)) = launcher(&words[launch.at..], windows) {
		launch.at = (launch.at + skip).min(words.len());
		launch.remote |= remote;
		launch.offset = offset;
		launch.packed = packed;
		// The rest of a packed command line is inside this word, not later words.
		if packed {
			break;
		}
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
/// (`timeout 5 cmd` → 2), whether that command runs on an `ssh` host, the
/// byte offset where the program's name starts, and whether that word is an
/// `env -S` command line to split on whitespace.
fn launcher<W: AsRef<[u8]>>(words: &[W], windows: bool) -> Option<(usize, bool, usize, bool)> {
	let skip = match command_name(words.first()?.as_ref(), windows)? {
		"env" => {
			// `-S`/`--split-string` is the command line `env` runs. The walk
			// is `env`'s own, so a value before `-S` (`--chdir /tmp`) is not
			// taken as that command line.
			if let Some((at, offset)) = omp_builtins::env_split_string(words) {
				let packed = words.get(at).is_some_and(|word| {
					let bytes = word.as_ref();
					bytes
						.get(offset..)
						.unwrap_or(bytes)
						.iter()
						.any(u8::is_ascii_whitespace)
				});
				return Some((at, false, offset, packed));
			}

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
		// Value-taking options from `uv run --help`. A missing one hides the
		// command behind its value (`uv run --color never omp`). `-s` is
		// `--script`: no positional command runs.
		"uv" if words.get(1).is_some_and(|w| w.as_ref() == b"run") => skip_options(
			words,
			2,
			b"CPwpifm",
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
				"--no-extra",
				"--no-editable-package",
				"--python-platform",
				"--index-strategy",
				"--keyring-provider",
				"--upgrade-package",
				"--upgrade-group",
				"--resolution",
				"--prerelease",
				"--prerelease-package",
				"--fork-strategy",
				"--exclude-newer",
				"--exclude-newer-package",
				"--no-sources-package",
				"--reinstall-package",
				"--link-mode",
				"--config-setting",
				"--config-settings-package",
				"--no-build-isolation-package",
				"--no-build-package",
				"--no-binary-package",
				"--refresh-package",
				"--color",
				"--allow-insecure-host",
			],
			b"ms",
			&["--module", "--script", "--gui-script"],
		)?,
		"ssh" => {
			let host = skip_options(words, 1, b"BbcDEeFIiJLlmOopQRSWw", &[], b"", &[])?;
			return (host < words.len()).then_some((host + 1, true, 0, false));
		},
		_ => return None,
	};
	Some((skip, false, 0, false))
}

#[cfg(test)]
mod tests {
	use super::launch;

	#[test]
	fn env_long_option_value_does_not_hide_the_split_command() {
		let words = ["/usr/bin/env", "--chdir", "/tmp", "-S", "omp", "read", "x"];
		let found = launch(&words);
		assert_eq!(found.at, 4);
		assert_eq!(found.program(&words), Some("omp"));
		assert!(!found.packed);

		// Unambiguous prefix of `--chdir`, as `env` itself accepts.
		let prefixed = ["env", "--ch", "/tmp", "-S", "omp", "read", "x"];
		assert_eq!(launch(&prefixed).program(&prefixed), Some("omp"));

		let unset = ["env", "--unset", "FOO", "-S", "omp"];
		assert_eq!(launch(&unset).program(&unset), Some("omp"));

		let short = ["env", "-u", "FOO", "-S", "omp"];
		assert_eq!(launch(&short).program(&short), Some("omp"));

		let packed = ["env", "--chdir", "/tmp", "-S", "omp read x"];
		let packed_launch = launch(&packed);
		assert_eq!(packed_launch.at, 4);
		assert!(packed_launch.packed);
		assert_eq!(packed_launch.program(&packed), Some("omp"));

		let other = ["/usr/bin/env", "--chdir", "/tmp", "-S", "grep", "omp", "x"];
		assert_eq!(launch(&other).program(&other), Some("grep"));
	}

	#[test]
	fn uv_run_value_options_do_not_hide_the_command() {
		let color = ["uv", "run", "--no-project", "--color", "never", "omp", "read", "x"];
		assert_eq!(launch(&color).at, 5);
		assert_eq!(launch(&color).program(&color), Some("omp"));

		let link = ["uv", "run", "--link-mode", "copy", "omp"];
		assert_eq!(launch(&link).program(&link), Some("omp"));

		let resolution = ["uv", "run", "--resolution", "lowest", "omp"];
		assert_eq!(launch(&resolution).program(&resolution), Some("omp"));

		let other = ["uv", "run", "--color", "never", "grep", "omp"];
		assert_eq!(launch(&other).program(&other), Some("grep"));
	}
}
