//! A port of zsh 5.9's `Test/comptest` (the harness of `Y01completion`,
//! `Y02compmatch`, `Y03arguments`) onto the PTY harness: the shell under
//! test runs as `zsh -f +Z` on a pty (where upstream uses `zpty`), every
//! `comptesteval` sources a file of shell code, every `comptest` types its
//! input followed by `^Z` and turns the markers the shell prints into the
//! report lines upstream compares (`line: {LBUFFER}{RBUFFER}`,
//! `DESCRIPTION:{...}`, `NO:{...}`, `COMPADD:{...}`, ...).
//!
//! A suite is the ordered steps of one `.ztst` file, recorded from running
//! it under `/bin/zsh` (`Eval`: a `comptesteval`, `Outer`: a file operation
//! of the test script itself, `Test`: a `comptest` with zsh's report).
//! Each case runs in a fresh shell and work directory after replaying the
//! preparation and the evaluations and file operations of every earlier
//! case, so cases are independent tests.

use std::{
	fmt::Write as _,
	fs, io,
	os::unix::fs::PermissionsExt,
	path::{Path, PathBuf},
	time::Duration,
};

use super::{compsys_fpath, fpath_words, shell};
use crate::pty_support::Pty;

/// Bound of the first prompt (obash's startup).
const STARTUP: Duration = Duration::from_secs(60);
/// Bound of one `comptesteval` (the first runs `compinit`).
const EVAL: Duration = Duration::from_secs(60);
/// Bound of one `comptest`.
const TEST: Duration = Duration::from_secs(20);

/// The placeholder for upstream's `$ZTST_srcdir:A` in recorded steps: a
/// directory holding one executable, `ztst.zsh`.
pub const SRCDIR: &str = "@SRCDIR@";

/// One recorded step of a `.ztst` file.
pub enum Step {
	/// `comptesteval`: shell code the shell under test sources.
	Eval(&'static str),
	/// A file operation of the test script in the work directory: `mkdir`,
	/// `touch`, `rmdir`, `rm -rf` and their operands.
	Outer(&'static [&'static str]),
	/// `comptest`: the keys typed, and zsh 5.9's report.
	Test(&'static str, &'static str),
}

/// One test chunk of a `.ztst` file.
pub struct Case {
	/// The test's message (after the status in the `.ztst` file).
	pub name:  &'static str,
	/// Its steps in order.
	pub steps: &'static [Step],
}

/// The cases of one `.ztst` file.
pub struct Suite {
	/// The `.ztst` file's name (for reports).
	pub file:  &'static str,
	/// `LANG` and `LC_ALL` of the shell under test (`ZSH_TEST_LANG`, or `C`).
	pub lang:  &'static str,
	/// The `%prep` section's steps.
	pub prep:  &'static [Step],
	/// The `%test` section.
	pub cases: &'static [Case],
}

/// The shell under test and its work directories.
struct Session {
	pty:   Pty,
	/// Holds `comp.tmp` (the work directory), `Test` ([`SRCDIR`]) and the
	/// files `comptesteval` sources.
	root:  PathBuf,
	evals: usize,
}

impl Session {
	/// `comptestinit`: start `zsh -f +Z` with `PS1=<PROMPT>`, wait for the
	/// first prompt and set up the completion system as upstream does.
	fn start(suite: &Suite, root: &Path, fpath: &str) -> io::Result<Self> {
		let mut pty = shell()
			.args(["-f", "+Z"])
			.env("PS1", "<PROMPT>")
			.env("LANG", suite.lang)
			.cwd(root.join("comp.tmp"))
			.size(24, 80)
			.spawn()?;
		pty.read_until("<PROMPT>", STARTUP)?;
		let mut session = Self { pty, root: root.to_owned(), evals: 0 };
		session.eval(&init_script(suite.lang, &root.display().to_string(), fpath))?;
		Ok(session)
	}

	/// `comptesteval`: source a file holding `text` and wait for the next
	/// prompt; the output up to it.
	fn eval(&mut self, text: &str) -> io::Result<String> {
		let file = self.root.join(format!("comptest.{}", self.evals));
		self.evals += 1;
		let srcdir = self.root.join("Test");
		fs::write(&file, format!("{}\n", text.replace(SRCDIR, &srcdir.display().to_string())))?;
		let path = file.display().to_string();
		assert!(
			path
				.bytes()
				.all(|b| b.is_ascii_alphanumeric() || b"/._-".contains(&b)),
			"temporary path needs quoting: {path}"
		);
		self.pty.write(format!(". {path}\n"))?;
		self.pty.read_until("<PROMPT>", EVAL)
	}

	/// `comptest`: type `input` and `^Z` (the finish widget); the raw log up
	/// to the prompt after `<WIDGET><finish>`.
	fn comptest(&mut self, input: &str) -> io::Result<String> {
		self.pty.write(format!("{input}\x1a"))?;
		let mut log = self.pty.read_until("<WIDGET><finish>", TEST)?;
		log.push_str(&self.pty.read_until("<PROMPT>", TEST)?);
		Ok(log)
	}
}

/// The code `comptestinit` evaluates in the shell under test (zsh 5.9
/// `Test/comptest`, with `fpath` the installed completion functions and no
/// `module_path` change).
fn init_script(lang: &str, root: &str, fpath: &str) -> String {
	format!(
		r#"export LC_ALL={lang}
emulate -R zsh
export ZDOTDIR={root}
fpath=( {fpath} )
bindkey -e
LISTMAX=10000000
stty 38400 columns 80 rows 24 tabs -icanon -iexten
TERM=vt100
KEYTIMEOUT=1
setopt zle
autoload -U compinit
compinit -u
zstyle ":completion:*" completer _expand _complete _ignored
zstyle ":completion:*:default" list-colors "no=<NO>" "fi=<FI>" "di=<DI>" "ln=<LN>" "pi=<PI>" "so=<SO>" "bd=<BD>" "cd=<CD>" "ex=<EX>" "mi=<MI>" "tc=<TC>" "sp=<SP>" "lc=<LC>" "ec=<EC>\n" "rc=<RC>"
zstyle ":completion:*" group-name ""
zstyle ":completion:*:messages" format "<MESSAGE>%d</MESSAGE>
"
zstyle ":completion:*:descriptions" format "<DESCRIPTION>%d</DESCRIPTION>
"
zstyle ":completion:*:options" verbose yes
zstyle ":completion:*:values" verbose yes
setopt noalwayslastprompt listrowsfirst completeinword
zmodload zsh/complist
complete-word-with-report () {{
  print -lr "<WIDGET><complete-word>"
  zle complete-word
  print -lr - "<LBUFFER>$LBUFFER</LBUFFER>" "<RBUFFER>$RBUFFER</RBUFFER>"
  zle clear-screen
  zle -R
}}
list-choices-with-report () {{
  print -lr "<WIDGET><list-choices>"
  zle list-choices
  zle clear-screen
  zle -R
}}
comp-finish () {{
  print "<WIDGET><finish>"
  zle kill-whole-line
  zle clear-screen
  zle -R
}}
zle-finish () {{
  local buffer="$BUFFER" cursor="$CURSOR" mark="$MARK"
  (( region_active)) || unset mark
  BUFFER=""
  zle -I
  zle clear-screen
  zle redisplay
  print -lr "<WIDGET><finish>" "BUFFER: $buffer" "CURSOR: $cursor"
  (( $+mark )) && print -lr "MARK: $mark"
  zle accept-line
}}
zle -N complete-word-with-report
zle -N list-choices-with-report
zle -N comp-finish
zle -N zle-finish
bindkey "^I" complete-word-with-report
bindkey "^D" list-choices-with-report
bindkey "^Z" comp-finish
bindkey "^X" zle-finish
bindkey -a "^X" zle-finish
"#
	)
}

/// The report lines `comptest` prints for the log of one call.
///
/// The log is split at `<WIDGET>` (empty pieces dropped, the first piece,
/// output before the first widget, too). For each piece: `line:
/// {LBUFFER}{RBUFFER}` when the report widget printed the buffer, then
/// every marker in order — list-colors codes `<LC><XX><RC>text<EC>` as
/// `XX:{text}` (without a trailing clear-to-end-of-line, and not for `TC`
/// or blank texts), `DESCRIPTION:{..}`, `MESSAGE:{..}`, and `COMPADD:{..}`
/// / `INSERT_POSITIONS:{..}` without line breaks.
#[must_use]
pub fn report(log: &str) -> Vec<String> {
	let mut lines = Vec::new();
	for piece in log.split("<WIDGET>").filter(|p| !p.is_empty()).skip(1) {
		if let Some((left, right)) = buffer_report(piece) {
			lines.push(format!("line: {{{left}}}{{{right}}}"));
		}
		let mut rest = piece;
		while let Some((marker, end)) = next_marker(rest) {
			match marker {
				Marker::Colour(code, text) => {
					if code != "TC" && !text.chars().all(|c| c == ' ') {
						let text = text.strip_suffix("\x1b[K").unwrap_or(text);
						lines.push(format!("{code}:{{{text}}}"));
					}
				},
				Marker::Description(text) => lines.push(format!("DESCRIPTION:{{{text}}}")),
				Marker::Message(text) => lines.push(format!("MESSAGE:{{{text}}}")),
				Marker::Compadd(text) => {
					lines.push(format!("COMPADD:{{{}}}", text.replace(['\r', '\n'], "")))
				},
				Marker::InsertPositions(text) => {
					lines.push(format!("INSERT_POSITIONS:{{{}}}", text.replace(['\r', '\n'], "")));
				},
			}
			rest = &rest[end..];
		}
	}
	lines
}

/// `(#b)*<LBUFFER>(*)</LBUFFER>\r\n<RBUFFER>(*)</RBUFFER>*` with zsh's
/// greedy stars: the last `<LBUFFER>` that has a match after it, the last
/// separator before the last `</RBUFFER>`.
fn buffer_report(log: &str) -> Option<(&str, &str)> {
	const OPEN: &str = "<LBUFFER>";
	const SEP: &str = "</LBUFFER>\r\n<RBUFFER>";
	const CLOSE: &str = "</RBUFFER>";
	for (at, _) in log.rmatch_indices(OPEN) {
		let after = &log[at + OPEN.len()..];
		let Some(close) = after.rfind(CLOSE) else {
			continue;
		};
		if let Some(sep) = after[..close].rfind(SEP) {
			return Some((&after[..sep], &after[sep + SEP.len()..close]));
		}
	}
	None
}

/// One marker `comptest` reports.
enum Marker<'a> {
	Colour(&'a str, &'a str),
	Description(&'a str),
	Message(&'a str),
	Compadd(&'a str),
	InsertPositions(&'a str),
}

/// The closing tags of the markers, and their opening tags.
const TAGS: [(&str, &str); 5] = [
	("<EC>", "<LC><"),
	("</DESCRIPTION>", "<DESCRIPTION>"),
	("</MESSAGE>", "<MESSAGE>"),
	("</COMPADD>", "<COMPADD>"),
	("</INSERT_POSITIONS>", "<INSERT_POSITIONS>"),
];

/// `${(N)log#*(#b)(<LC><(??)><RC>(*)<EC>|<DESCRIPTION>(*)</DESCRIPTION>|...)}`:
/// the shortest prefix ending in a marker (the earliest closing tag that
/// has an opening tag before it), the marker starting as late as possible
/// (the leading `*` is greedy); the marker and the prefix's length.
fn next_marker(log: &str) -> Option<(Marker<'_>, usize)> {
	let mut ends: Vec<(usize, usize)> = TAGS
		.iter()
		.enumerate()
		.flat_map(|(kind, (close, _))| {
			log.match_indices(close)
				.map(move |(at, _)| (at + close.len(), kind))
		})
		.collect();
	ends.sort_unstable();
	for (end, kind) in ends {
		let (close, open) = TAGS[kind];
		let body_end = end - close.len();
		for (at, _) in log[..body_end].rmatch_indices(open) {
			let after = &log[at + open.len()..body_end];
			if kind == 0 {
				// `<LC><` two characters `><RC>`.
				let mut chars = after.char_indices();
				let Some((..)) = chars.next() else { continue };
				let Some((second, c2)) = chars.next() else {
					continue;
				};
				let code_end = second + c2.len_utf8();
				let Some(text) = after[code_end..].strip_prefix("><RC>") else {
					continue;
				};
				return Some((Marker::Colour(&after[..code_end], text), end));
			}
			let marker = match kind {
				1 => Marker::Description(after),
				2 => Marker::Message(after),
				3 => Marker::Compadd(after),
				_ => Marker::InsertPositions(after),
			};
			return Some((marker, end));
		}
	}
	None
}

/// Apply a recorded file operation in the work directory.
fn outer(work: &Path, argv: &[&str]) -> io::Result<()> {
	match argv {
		["mkdir", dirs @ ..] => dirs.iter().try_for_each(|d| fs::create_dir(work.join(d))),
		["touch", files @ ..] => files.iter().try_for_each(|f| {
			fs::OpenOptions::new()
				.create(true)
				.append(true)
				.open(work.join(f))
				.map(drop)
		}),
		["rmdir", dirs @ ..] => dirs.iter().try_for_each(|d| fs::remove_dir(work.join(d))),
		["rm", "-rf", paths @ ..] => paths.iter().try_for_each(|p| {
			let p = work.join(p);
			if p.is_dir() {
				fs::remove_dir_all(p)
			} else if p.exists() {
				fs::remove_file(p)
			} else {
				Ok(())
			}
		}),
		_ => panic!("unsupported file operation {argv:?}"),
	}
}

/// A fresh root: `comp.tmp` and `Test/ztst.zsh` (executable).
fn make_root() -> io::Result<tempfile::TempDir> {
	let root = tempfile::tempdir()?;
	fs::create_dir(root.path().join("comp.tmp"))?;
	fs::create_dir(root.path().join("Test"))?;
	let ztst = root.path().join("Test/ztst.zsh");
	fs::write(&ztst, "#!/bin/sh\n")?;
	fs::set_permissions(&ztst, fs::Permissions::from_mode(0o755))?;
	Ok(root)
}

/// Run case `index` of `suite` (see the module docs) and assert every
/// `comptest` report equals zsh's. Skips (passing) when zsh's completion
/// functions are not installed.
///
/// # Panics
///
/// On a different report or a failed session, with the input, both
/// reports and the raw log.
pub fn run_case(suite: &Suite, index: usize) {
	let Some(fpath) = compsys_fpath() else {
		eprintln!("skipped: zsh 5.9 completion functions are not installed");
		return;
	};
	let root = make_root().expect("temporary work directory");
	let mut failures = String::new();
	if let Err(e) = drive(suite, index, root.path(), &fpath_words(&fpath), &mut failures) {
		let _ = writeln!(failures, "session failed: {e}");
	}
	assert!(failures.is_empty(), "{} {:?}:\n{failures}", suite.file, suite.cases[index].name);
}

/// Start the session, replay the preparation and the earlier cases'
/// evaluations and file operations (consecutive evaluations as one file),
/// then run the case, appending each differing report to `failures`.
fn drive(
	suite: &Suite,
	index: usize,
	root: &Path,
	fpath: &str,
	failures: &mut String,
) -> io::Result<()> {
	let work = root.join("comp.tmp");
	let mut session = Session::start(suite, root, fpath)?;
	let earlier = suite
		.prep
		.iter()
		.chain(suite.cases[..index].iter().flat_map(|c| c.steps));
	let mut batch = String::new();
	for step in earlier {
		match step {
			Step::Eval(text) => {
				batch.push_str(text);
				batch.push('\n');
			},
			Step::Outer(argv) => {
				if !batch.is_empty() {
					session.eval(&std::mem::take(&mut batch))?;
				}
				outer(&work, argv)?;
			},
			Step::Test(..) => {},
		}
	}
	if !batch.is_empty() {
		session.eval(&batch)?;
	}
	for step in suite.cases[index].steps {
		match step {
			Step::Eval(text) => {
				session.eval(text)?;
			},
			Step::Outer(argv) => outer(&work, argv)?,
			Step::Test(input, expected) => {
				let log = session.comptest(input)?;
				let got = report(&log).join("\n");
				if got != *expected {
					let _ = write!(
						failures,
						"comptest {input:?}\n--- zsh 5.9:\n{expected}\n--- got:\n{got}\n--- raw \
						 log:\n{log:?}\n\n"
					);
				}
			},
		}
	}
	Ok(())
}
