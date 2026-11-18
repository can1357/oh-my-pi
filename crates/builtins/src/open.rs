//! `open` and `xdg-open` builtins (and `start` on Windows): hand files,
//! folders and URLs to the desktop, as a double click would.
//!
//! The command line is macOS `open`'s on every platform; [`Open::request`]
//! turns it into a [`Request`] and the platform module carries it out:
//!
//! - macOS ([`macos`]): `NSWorkspace`. The options only Launch Services'
//!   private interface offers (`-F`, `-h`/`-H`/`-s`, `--stdin`, `--stdout`,
//!   `--stderr`, `--arch`) go to `/usr/bin/open`, with the resolved operands.
//! - Linux ([`linux`]): the default handler from `mimeapps.list` and the
//!   desktop entries ([`xdg`]), else the desktop portal.
//! - Windows ([`windows`]): `ShellExecuteExW`.
//!
//! Operands are the shell's: an internal URL aliasing a host file
//! (`local://report.html`) opens that file, a rendered one (`agent://…`) opens
//! a copy written to the temp directory, and any other URL opens as a URL.

use std::{
	ffi::OsString,
	io::{self, Write as _},
	path::{Path, PathBuf},
};

use clap::{ArgAction, Parser};
use omp_vfs::BlockingFs;

use crate::host::{Host, Utility};

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(windows)]
pub(crate) mod windows;
#[cfg(any(target_os = "linux", all(test, unix)))]
#[cfg_attr(
	not(target_os = "linux"),
	allow(dead_code, reason = "only the Linux desktop calls all of it; its tests run on any unix")
)]
mod xdg;

#[cfg(target_os = "linux")]
use linux as desktop;
#[cfg(target_os = "macos")]
use macos as desktop;
#[cfg(windows)]
use windows as desktop;

/// Exit status for an operand that names no file: `xdg-open`'s 2 on Linux,
/// `open`'s 1 elsewhere.
const MISSING_STATUS: i32 = if cfg!(target_os = "linux") { 2 } else { 1 };

/// Exit status once the shell cancelled the command.
const CANCELLED_STATUS: i32 = 130;

/// Parsed `open` invocation.
#[derive(Parser, Debug)]
#[command(
	name = "open",
	about = "Open files, directories and URLs with the desktop's applications.",
	disable_help_flag = true,
	disable_version_flag = true
)]
pub(crate) struct Open {
	/// Open with the named application (a name, or a path to it).
	#[arg(short = 'a', value_name = "application")]
	application: Option<String>,

	/// Open with the application that has this bundle identifier.
	#[arg(short = 'b', value_name = "bundle_identifier")]
	bundle: Option<String>,

	/// Open with TextEdit.
	#[arg(short = 'e', action = ArgAction::SetTrue)]
	text_edit: bool,

	/// Open with the default text editor.
	#[arg(short = 't', action = ArgAction::SetTrue)]
	text_editor: bool,

	/// Read standard input and open the result in a text editor.
	#[arg(short = 'f', action = ArgAction::SetTrue)]
	from_stdin: bool,

	/// Launch the application fresh, without restoring its windows.
	#[arg(short = 'F', long = "fresh", action = ArgAction::SetTrue)]
	fresh: bool,

	/// Wait until the applications used have exited.
	#[arg(short = 'W', long = "wait-apps", action = ArgAction::SetTrue)]
	wait: bool,

	/// Reveal the files in the file manager instead of opening them.
	#[arg(short = 'R', long = "reveal", action = ArgAction::SetTrue)]
	reveal: bool,

	/// Open a new instance of the application even if one is running.
	#[arg(short = 'n', long = "new", action = ArgAction::SetTrue)]
	new_instance: bool,

	/// Do not bring the application to the foreground.
	#[arg(short = 'g', long = "background", action = ArgAction::SetTrue)]
	background: bool,

	/// Launch the application hidden.
	#[arg(short = 'j', long = "hide", action = ArgAction::SetTrue)]
	hide: bool,

	/// Search the SDK header locations for the named headers and open them.
	#[arg(short = 'h', long = "header", action = ArgAction::SetTrue)]
	header: bool,

	/// As -h, searching every header location.
	#[arg(short = 'H', action = ArgAction::SetTrue)]
	header_all: bool,

	/// For -h, search only the SDKs whose names contain this.
	#[arg(short = 's', value_name = "sdk")]
	sdk: Option<String>,

	/// Open this URL, even if it also names a file.
	#[arg(short = 'u', long = "url", value_name = "URL", action = ArgAction::Append)]
	urls: Vec<String>,

	/// Launch the application with standard input connected to PATH.
	#[arg(short = 'i', long = "stdin", value_name = "PATH")]
	stdin: Option<String>,

	/// Launch the application with standard output connected to PATH.
	#[arg(short = 'o', long = "stdout", value_name = "PATH")]
	stdout: Option<String>,

	/// Launch the application with standard error connected to PATH.
	#[arg(short = 'E', long = "stderr", value_name = "PATH")]
	stderr: Option<String>,

	/// Add NAME=VALUE (or NAME) to the application's environment.
	#[arg(long = "env", value_name = "VAR", action = ArgAction::Append)]
	env: Vec<String>,

	/// Launch with the given CPU architecture.
	#[arg(long = "arch", value_name = "ARCH")]
	arch: Option<String>,

	/// Pass every remaining argument to the application.
	#[arg(
		long = "args",
		value_name = "arg",
		action = ArgAction::Append,
		allow_hyphen_values = true
	)]
	args: Vec<String>,

	/// Print help.
	#[allow(dead_code, reason = "clap consumes help before options are inspected")]
	#[arg(long = "help", action = ArgAction::Help)]
	help: Option<bool>,

	/// Files, directories and URLs to open.
	#[arg(value_name = "file")]
	operands: Vec<String>,
}

/// One thing to open.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Target {
	/// A host file or directory, absolute.
	File(PathBuf),
	/// A URL, as written.
	Url(String),
}

impl Target {
	/// The target as its `file://` or original URL.
	#[cfg(any(target_os = "linux", all(test, unix)))]
	fn to_url(&self) -> String {
		match self {
			Self::File(path) => xdg::file_url(path),
			Self::Url(url) => url.clone(),
		}
	}
}

impl std::fmt::Display for Target {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		match self {
			Self::File(path) => path.display().fmt(f),
			Self::Url(url) => f.write_str(url),
		}
	}
}

/// Which application opens the targets.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Opener {
	/// Each target's default application.
	Default,
	/// `-a`: an application by name or path.
	Named(String),
	/// `-b`: an application by bundle identifier (a desktop-entry ID on
	/// Linux, an application user model ID on Windows).
	Bundle(String),
	/// `-e`, `-f`: the platform's plain text editor.
	TextEdit,
	/// `-t`: the default application for plain text.
	TextEditor,
}

/// `-h`/`-H`: a search of the SDK header locations.
#[derive(Clone, Debug, PartialEq, Eq)]
#[cfg_attr(
	not(target_os = "macos"),
	allow(dead_code, reason = "only macOS has SDK headers to search")
)]
pub(crate) struct HeaderSearch {
	/// `-H` rather than `-h`.
	all:   bool,
	/// `-s`: only SDKs whose names contain this.
	sdk:   Option<String>,
	/// The header names, as written.
	names: Vec<String>,
}

/// What an `open` command line asks of the desktop, every operand resolved.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
#[cfg_attr(
	not(target_os = "macos"),
	allow(dead_code, reason = "some launch options have a meaning on macOS only")
)]
pub(crate) struct Request {
	targets:      Vec<Target>,
	opener:       Opener,
	header:       Option<HeaderSearch>,
	reveal:       bool,
	wait:         bool,
	new_instance: bool,
	background:   bool,
	hide:         bool,
	fresh:        bool,
	/// `--args`: the application's own arguments.
	args:         Vec<String>,
	/// `--env`: additions to the application's environment.
	env:          Vec<(String, String)>,
	/// `--stdin`, `--stdout`, `--stderr`: host files for the application's
	/// standard streams.
	stdio:        [Option<PathBuf>; 3],
	arch:         Option<String>,
}

impl Default for Opener {
	fn default() -> Self {
		Self::Default
	}
}

impl Utility for Open {
	const NAME: &'static str = "open";

	/// `--args` ends the options: every word after it is the application's,
	/// whatever it looks like. Each becomes an attached `--args=<word>`, which
	/// clap takes verbatim.
	fn rewrite_argv(argv: Vec<OsString>) -> Result<Vec<OsString>, String> {
		let mut rewritten = Vec::with_capacity(argv.len());
		let mut words = argv.into_iter();
		rewritten.extend(words.next());
		while let Some(word) = words.next() {
			if word == "--args" {
				rewritten.extend(words.by_ref().map(|argument| {
					let mut attached = OsString::from("--args=");
					attached.push(argument);
					attached
				}));
			} else if word == "--" {
				rewritten.push(word);
				rewritten.extend(words.by_ref());
			} else {
				rewritten.push(word);
			}
		}
		Ok(rewritten)
	}

	fn run(self, host: &mut Host) -> i32 {
		match self.request(host) {
			Ok(request) => desktop::run(&request, host),
			Err(code) => code,
		}
	}
}

impl Open {
	/// The request this command line makes, with its operands resolved against
	/// the shell's working directory and filesystem and `-f`'s input saved.
	/// `Err` is the exit status of a command line already reported on stderr.
	fn request(self, host: &mut Host) -> Result<Request, i32> {
		let opener = match (self.application, self.bundle) {
			(Some(name), _) => Opener::Named(name),
			(None, Some(id)) => Opener::Bundle(id),
			(None, None) if self.text_editor => Opener::TextEditor,
			(None, None) if self.text_edit || self.from_stdin => Opener::TextEdit,
			(None, None) => Opener::Default,
		};
		let mut request = Request {
			opener,
			reveal: self.reveal,
			wait: self.wait,
			new_instance: self.new_instance,
			background: self.background,
			hide: self.hide,
			fresh: self.fresh,
			args: self.args,
			env: self.env.iter().map(|var| env_pair(var)).collect(),
			arch: self.arch,
			..Request::default()
		};
		for (slot, path) in [self.stdin, self.stdout, self.stderr].into_iter().enumerate() {
			let Some(path) = path else { continue };
			match host_file(host.fs(), &path, host.resolve(&path)) {
				Ok(file) => request.stdio[slot] = Some(file),
				Err(message) => return Err(fail(host, message, 1)),
			}
		}
		if self.header || self.header_all {
			request.header =
				Some(HeaderSearch { all: self.header_all, sdk: self.sdk, names: self.operands });
			return Ok(request);
		}
		request.targets.reserve(self.urls.len() + self.operands.len() + 1);
		request.targets.extend(self.urls.into_iter().map(Target::Url));
		for operand in &self.operands {
			match target(host.fs(), operand, host.resolve(operand)) {
				Ok(target) => request.targets.push(target),
				Err(Unopenable::Missing(path)) => {
					let message = format!("The file {} does not exist.", path.display());
					return Err(fail(host, message, MISSING_STATUS));
				},
				Err(Unopenable::Other(message)) => return Err(fail(host, message, 1)),
			}
		}
		if self.from_stdin {
			match save_stdin(host) {
				Ok(file) => request.targets.push(Target::File(file)),
				Err(_) if host.is_cancelled() => return Err(CANCELLED_STATUS),
				Err(err) => return Err(fail(host, format!("standard input: {err}"), 1)),
			}
		}
		if request.reveal
			&& let Some(url) = request.targets.iter().find(|target| matches!(target, Target::Url(_)))
		{
			return Err(fail(host, format!("Unable to reveal {url}: not a file."), 1));
		}
		let opens_application = matches!(request.opener, Opener::Named(_) | Opener::Bundle(_));
		if request.targets.is_empty() && (request.reveal || !opens_application) {
			return Err(host.usage_error("no file, directory, URL or application to open", 1));
		}
		Ok(request)
	}
}

/// Reports `message` and returns `code`.
fn fail(host: &mut Host, message: impl std::fmt::Display, code: i32) -> i32 {
	host.error(message, code);
	code
}

/// `--env`'s `NAME=VALUE`, or `NAME` for an empty value.
fn env_pair(var: &str) -> (String, String) {
	let (name, value) = var.split_once('=').unwrap_or((var, ""));
	(name.to_owned(), value.to_owned())
}

/// Why an operand cannot be opened.
#[derive(Debug, PartialEq, Eq)]
enum Unopenable {
	/// It names a host path where nothing exists.
	Missing(PathBuf),
	/// Anything else, as the message to report.
	Other(String),
}

/// What `operand` opens: `path` is the operand as the shell resolves it
/// ([`Host::resolve`]), absolute unless it is a URL.
///
/// - A host path, or an internal URL aliasing one, is that file; it must exist,
///   unless the operand reads as a URL (`mailto:someone`), which then opens as
///   one.
/// - An internal URL the filesystem serves without a backing file is saved to
///   the temp directory and that copy opened.
/// - A URL the filesystem does not serve (`https://…`) opens as written.
fn target(fs: &BlockingFs, operand: &str, path: PathBuf) -> Result<Target, Unopenable> {
	let other = |err: io::Error| Unopenable::Other(format!("{operand}: {err}"));
	if !omp_vfs::is_virtual_path(&path) {
		let file = fs.backing_path(&path).map_err(other)?.unwrap_or(path);
		return if file.symlink_metadata().is_ok() {
			Ok(Target::File(file))
		} else if reads_as_url(operand) {
			Ok(Target::Url(operand.to_owned()))
		} else {
			Err(Unopenable::Missing(file))
		};
	}
	if fs.is_native() {
		return Ok(Target::Url(operand.to_owned()));
	}
	if let Some(file) = fs.backing_path(&path).map_err(other)? {
		return if file.symlink_metadata().is_ok() {
			Ok(Target::File(file))
		} else {
			Err(Unopenable::Other(format!("{operand}: No such file or directory")))
		};
	}
	match fs.metadata(&path) {
		Ok(metadata) if metadata.is_dir() => {
			Err(Unopenable::Other(format!("{operand}: is a directory with no folder on disk")))
		},
		Ok(_) => fs
			.read(&path)
			.and_then(|contents| save_copy(&path, &contents))
			.map(Target::File)
			.map_err(other),
		Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(Target::Url(operand.to_owned())),
		Err(err) => Err(other(err)),
	}
}

/// The host file `operand` names, for an application's standard stream: the
/// resolved `path` itself, or the file an internal URL aliases.
fn host_file(fs: &BlockingFs, operand: &str, path: PathBuf) -> Result<PathBuf, String> {
	let virtual_path = omp_vfs::is_virtual_path(&path);
	if virtual_path && fs.is_native() {
		return Err(format!("{operand}: not a file"));
	}
	match fs.backing_path(&path) {
		Ok(Some(file)) => Ok(file),
		Ok(None) if virtual_path => Err(format!("{operand}: not a file")),
		Ok(None) => Ok(path),
		Err(err) => Err(format!("{operand}: {err}")),
	}
}

/// Whether `operand` starts with a URL scheme (`mailto:`, `https:`). A single
/// letter is a Windows drive, not a scheme.
fn reads_as_url(operand: &str) -> bool {
	let Some((scheme, _)) = operand.split_once(':') else {
		return false;
	};
	scheme.len() >= 2
		&& scheme.starts_with(|first: char| first.is_ascii_alphabetic())
		&& scheme
			.chars()
			.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
}

/// Writes `contents`, the resource a rendered internal URL names, to a file of
/// its own directory under the temp directory and returns it. The file takes
/// the URL's last segment as its name, with `.md` when that has no extension:
/// rendered resources are Markdown.
fn save_copy(url: &Path, contents: &[u8]) -> io::Result<PathBuf> {
	let spelled = url.to_string_lossy();
	let scheme = omp_vfs::url_scheme(url).unwrap_or("resource");
	let below = spelled.get(scheme.len() + 3..).unwrap_or_default();
	let segment = below
		.split(['?', '#'])
		.next()
		.unwrap_or_default()
		.trim_end_matches('/')
		.rsplit('/')
		.next()
		.unwrap_or_default();
	let mut name: String = segment
		.chars()
		.map(|c| if c.is_control() || matches!(c, '/' | '\\' | ':') { '_' } else { c })
		.collect();
	if name.is_empty() || name.starts_with('.') {
		name.insert_str(0, scheme);
	}
	if Path::new(&name).extension().is_none() {
		name.push_str(".md");
	}
	let directory = tempfile::Builder::new().prefix("open-").tempdir()?.keep();
	let file = directory.join(name);
	std::fs::write(&file, contents)?;
	Ok(file)
}

/// `-f`: saves standard input to `open_XXXXXXXX.txt` in the temp directory, as
/// `open` does, and returns the file.
fn save_stdin(host: &mut Host) -> io::Result<PathBuf> {
	let (mut file, path) = tempfile::Builder::new()
		.prefix("open_")
		.suffix(".txt")
		.tempfile()?
		.keep()
		.map_err(|err| err.error)?;
	io::copy(&mut host.stdin, &mut file)?;
	file.flush()?;
	Ok(path)
}

/// Runs `open args` in `cwd` with the exported variables `vars`, against the
/// real desktop; returns the exit status and what was written to stderr.
#[cfg(all(test, any(target_os = "macos", target_os = "linux")))]
fn run_open(args: &[&str], vars: &[(&str, &str)], cwd: &Path) -> (i32, String) {
	let argv = std::iter::once("open")
		.chain(args.iter().copied())
		.map(OsString::from)
		.collect();
	let open = Open::try_parse_from(Open::rewrite_argv(argv).expect("rewrite")).expect("parse");
	let (mut host, capture) = Host::for_test("open", "", cwd);
	for (name, value) in vars {
		host.set_test_var(name, value);
	}
	let code = open.run(&mut host);
	drop(host);
	(code, capture.err())
}

#[cfg(test)]
mod tests {
	use std::sync::Arc;

	use async_trait::async_trait;
	use omp_vfs::{FileHandle, FileKind, FileSystem, FileType, Metadata, OpenOptions, Permissions, ReadDir};

	use super::*;

	/// The request `args` make in `cwd`, with `stdin` on standard input; `Err`
	/// carries the exit status and what was reported on stderr.
	fn request_in(args: &[&str], stdin: &str, cwd: &Path) -> Result<Request, (i32, String)> {
		let argv = std::iter::once("open")
			.chain(args.iter().copied())
			.map(OsString::from)
			.collect();
		let argv = Open::rewrite_argv(argv).expect("rewrite");
		let open = Open::try_parse_from(argv).map_err(|err| (1, err.to_string()))?;
		let (mut host, capture) = Host::for_test("open", stdin, cwd);
		let made = open.request(&mut host);
		drop(host);
		made.map_err(|code| (code, capture.err()))
	}

	fn request(args: &[&str]) -> Result<Request, (i32, String)> {
		request_in(args, "", Path::new("/"))
	}

	/// Failure mode: a flag lands on the wrong field (or swallows the operand
	/// after it), and the desktop is asked for something else.
	#[test]
	fn every_flag_reaches_the_request() {
		let dir = tempfile::tempdir().expect("tempdir");
		let dir_path = dir.path().canonicalize().expect("canonical tempdir");
		std::fs::write(dir_path.join("a.txt"), "a").expect("write");
		let made = request_in(
			&[
				"-n", "-g", "-j", "-F", "-W", "--env", "A=1=2", "--env", "B", "--stdin", "in.txt",
				"-o", "out.txt", "--stderr", "err.txt", "--arch", "arm64", "-b",
				"com.apple.TextEdit", "a.txt", "-u", "https://example.com/x",
			],
			"",
			&dir_path,
		)
		.expect("request");
		assert_eq!(made, Request {
			targets:      vec![
				Target::Url("https://example.com/x".into()),
				Target::File(dir_path.join("a.txt")),
			],
			opener:       Opener::Bundle("com.apple.TextEdit".into()),
			header:       None,
			reveal:       false,
			wait:         true,
			new_instance: true,
			background:   true,
			hide:         true,
			fresh:        true,
			args:         vec![],
			env:          vec![("A".into(), "1=2".into()), ("B".into(), String::new())],
			stdio:        [
				Some(dir_path.join("in.txt")),
				Some(dir_path.join("out.txt")),
				Some(dir_path.join("err.txt")),
			],
			arch:         Some("arm64".into()),
		});
	}

	/// Failure mode: `open -a App --args -n --flag file` treats the
	/// application's own arguments as `open` options or as files to open.
	#[test]
	fn args_takes_every_remaining_word_verbatim() {
		let made = request(&["-a", "Safari", "--args", "-n", "--new-window", "/no/such/file", "--args"])
			.expect("request");
		assert_eq!(made.opener, Opener::Named("Safari".into()));
		assert_eq!(made.args, ["-n", "--new-window", "/no/such/file", "--args"]);
		assert!(made.targets.is_empty());
		assert!(!made.new_instance);
	}

	/// Failure mode: the wrong application is picked when several selectors are
	/// given.
	#[test]
	fn opener_precedence() {
		let opener = |args: &[&str]| request(args).expect("request").opener;
		assert_eq!(opener(&["-e", "-t", "/"]), Opener::TextEditor);
		assert_eq!(opener(&["-e", "/"]), Opener::TextEdit);
		assert_eq!(opener(&["-e", "-b", "org.x", "/"]), Opener::Bundle("org.x".into()));
		assert_eq!(opener(&["-t", "-b", "org.x", "-a", "Preview", "/"]), Opener::Named("Preview".into()));
		assert_eq!(opener(&["/"]), Opener::Default);
	}

	/// Failure mode: `cmd | open -f` opens nothing, a file without the piped
	/// text, or the text in whatever handles `.txt` instead of a text editor.
	#[test]
	fn f_saves_standard_input_for_a_text_editor() {
		for (args, opener) in [(&["-f"][..], Opener::TextEdit), (&["-f", "-t"][..], Opener::TextEditor)] {
			let made = request_in(args, "piped text\n", Path::new("/")).expect("request");
			assert_eq!(made.opener, opener);
			let [Target::File(saved)] = made.targets.as_slice() else {
				panic!("one saved file expected: {:?}", made.targets);
			};
			assert_eq!(std::fs::read_to_string(saved).expect("saved input"), "piped text\n");
			assert_eq!(saved.extension().and_then(|ext| ext.to_str()), Some("txt"));
			std::fs::remove_file(saved).expect("remove saved input");
		}
	}

	/// Failure mode: `-h NSView.h` is looked up as a file in the working
	/// directory and reported missing.
	#[test]
	fn header_search_keeps_its_names_unresolved() {
		let made = request(&["-h", "NSView.h", "-s", "MacOSX"]).expect("request");
		assert_eq!(
			made.header,
			Some(HeaderSearch {
				all:   false,
				sdk:   Some("MacOSX".into()),
				names: vec!["NSView.h".into()],
			})
		);
		assert!(made.targets.is_empty());
		assert!(request(&["-H", "NSView.h"]).expect("request").header.expect("header").all);
	}

	/// Failure mode: a mistyped path is handed to the desktop (an error dialog,
	/// or silence), or a bare `open`/`open -R` launches nothing and succeeds.
	#[test]
	fn missing_files_and_empty_command_lines_are_refused() {
		let (code, err) = request(&["/no/such/open-target.html"]).expect_err("missing file");
		assert_eq!(code, MISSING_STATUS);
		#[cfg(unix)]
		assert_eq!(err, "open: The file /no/such/open-target.html does not exist.\n");
		#[cfg(not(unix))]
		assert!(err.ends_with("does not exist.\n"), "{err:?}");
		let (code, err) = request(&[]).expect_err("nothing to open");
		assert_eq!(code, 1);
		assert!(err.starts_with("open: no file, directory, URL or application to open\n"), "{err:?}");
		assert_eq!(request(&["-R"]).expect_err("nothing to reveal").0, 1);
		let (code, err) = request(&["-R", "https://example.com"]).expect_err("URL reveal");
		assert_eq!((code, err.as_str()), (1, "open: Unable to reveal https://example.com: not a file.\n"));
		// An application alone is a launch.
		assert!(request(&["-a", "TextEdit"]).expect("launch").targets.is_empty());
	}

	/// Failure mode: `mailto:` and other scheme-only URLs are reported as
	/// missing files, or `C:\x` on Windows is taken for a URL.
	#[test]
	fn schemes_without_a_file_open_as_urls() {
		let made = request(&["mailto:someone@example.com", "x-apple.systempreferences:com.apple.Displays"])
			.expect("request");
		assert_eq!(made.targets, [
			Target::Url("mailto:someone@example.com".into()),
			Target::Url("x-apple.systempreferences:com.apple.Displays".into()),
		]);
		assert!(!reads_as_url("C:\\Users\\x.txt"));
		assert!(!reads_as_url("notes/a:b.txt"));
	}

	// -------------------------------------------------------------------------
	// Internal URLs.

	const PAGE: &[u8] = b"# rendered\n";

	/// A provider serving `local://` from the host directory `root`,
	/// `agent://` as rendered resources, and refusing `skill://unknown`.
	#[derive(Debug)]
	struct Urls {
		root: PathBuf,
	}

	impl Urls {
		fn rendered(path: &Path) -> bool {
			path == Path::new("agent://Worker") || path == Path::new("agent://Worker/notes.txt")
		}
	}

	#[async_trait]
	impl FileSystem for Urls {
		fn is_native_local(&self, path: &Path) -> bool {
			!omp_vfs::is_virtual_path(path)
		}

		async fn backing_path(&self, path: &Path) -> io::Result<Option<PathBuf>> {
			let text = path.to_string_lossy();
			if let Some(below) = text.strip_prefix("local://") {
				return Ok(Some(self.root.join(below)));
			}
			if text.starts_with("skill://unknown") {
				return Err(io::Error::other("Unknown skill: unknown"));
			}
			Ok(None)
		}

		async fn open(&self, path: &Path, _options: &OpenOptions) -> io::Result<omp_vfs::File> {
			if !Self::rendered(path) {
				return Err(io::ErrorKind::NotFound.into());
			}
			Ok(omp_vfs::File::from_handle(Page { pos: parking_lot::Mutex::new(0) }))
		}

		async fn metadata(&self, path: &Path) -> io::Result<Metadata> {
			if path == Path::new("agent://") {
				return Ok(Metadata::new(FileType::from_kind(FileKind::Dir), 0, Permissions::from_mode(0o755)));
			}
			if !Self::rendered(path) {
				return Err(io::ErrorKind::NotFound.into());
			}
			Ok(page_meta())
		}

		async fn read_dir(&self, _path: &Path) -> io::Result<ReadDir> {
			Err(io::ErrorKind::NotFound.into())
		}
	}

	fn page_meta() -> Metadata {
		Metadata::new(FileType::from_kind(FileKind::File), PAGE.len() as u64, Permissions::from_mode(0o644))
	}

	#[derive(Debug)]
	struct Page {
		pos: parking_lot::Mutex<usize>,
	}

	#[async_trait]
	impl FileHandle for Page {
		async fn read(&self, buf: &mut [u8]) -> io::Result<usize> {
			let mut pos = self.pos.lock();
			let n = (PAGE.len() - *pos).min(buf.len());
			buf[..n].copy_from_slice(&PAGE[*pos..*pos + n]);
			*pos += n;
			Ok(n)
		}

		async fn write(&self, _buf: &[u8]) -> io::Result<usize> {
			Err(io::ErrorKind::PermissionDenied.into())
		}

		async fn seek(&self, _pos: io::SeekFrom) -> io::Result<u64> {
			Err(io::ErrorKind::Unsupported.into())
		}

		async fn metadata(&self) -> io::Result<Metadata> {
			Ok(page_meta())
		}
	}

	fn resolve(fs: &BlockingFs, operand: &str) -> Result<Target, Unopenable> {
		target(fs, operand, PathBuf::from(operand))
	}

	/// Failure mode: `open local://report.html` hands the desktop a URL no
	/// application knows, instead of the file behind it.
	#[test]
	fn file_backed_urls_open_their_host_file() {
		let dir = tempfile::tempdir().expect("tempdir");
		std::fs::write(dir.path().join("report.html"), "<p>hi</p>").expect("write");
		let fs = omp_vfs::Fs::new(Arc::new(Urls { root: dir.path().to_path_buf() })).blocking();
		assert_eq!(
			resolve(&fs, "local://report.html"),
			Ok(Target::File(dir.path().join("report.html")))
		);
		assert_eq!(
			resolve(&fs, "local://absent.html"),
			Err(Unopenable::Other("local://absent.html: No such file or directory".into()))
		);
		assert_eq!(
			resolve(&fs, "skill://unknown/SKILL.md"),
			Err(Unopenable::Other("skill://unknown/SKILL.md: Unknown skill: unknown".into()))
		);
		assert_eq!(
			host_file(&fs, "local://out.log", PathBuf::from("local://out.log")),
			Ok(dir.path().join("out.log"))
		);
		assert_eq!(
			host_file(&fs, "agent://Worker", PathBuf::from("agent://Worker")),
			Err("agent://Worker: not a file".into())
		);
	}

	/// Failure mode: a rendered resource (`agent://Worker`) has no file to
	/// open, so the desktop gets a URL it cannot handle; and web URLs must not
	/// be mistaken for one.
	#[test]
	fn rendered_urls_open_a_saved_copy_and_foreign_urls_stay_urls() {
		let fs = omp_vfs::Fs::new(Arc::new(Urls { root: PathBuf::from("/nonexistent") })).blocking();
		for (url, name) in [("agent://Worker", "Worker.md"), ("agent://Worker/notes.txt", "notes.txt")] {
			let Ok(Target::File(copy)) = resolve(&fs, url) else {
				panic!("{url} should open a saved copy");
			};
			assert_eq!(copy.file_name().and_then(|name| name.to_str()), Some(name));
			assert_eq!(std::fs::read(&copy).expect("saved copy"), PAGE);
			std::fs::remove_dir_all(copy.parent().expect("copy directory")).expect("remove copy");
		}
		assert_eq!(
			resolve(&fs, "https://example.com/a?b=c"),
			Ok(Target::Url("https://example.com/a?b=c".into()))
		);
		assert_eq!(
			resolve(&fs, "agent://"),
			Err(Unopenable::Other("agent://: is a directory with no folder on disk".into()))
		);
		// A shell with no provider has no internal URLs: everything is the desktop's.
		assert_eq!(
			resolve(&omp_vfs::Fs::native().blocking(), "local://report.html"),
			Ok(Target::Url("local://report.html".into()))
		);
	}
}
