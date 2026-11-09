//! The central diagnostic catalog, with bash 5.3's message formats.
//!
//! Every message the engine prints to a script's stderr is a [`Diag`]. Its
//! `Display` is the message body exactly as bash prints it (checked by the
//! error-message differential); [`render`] adds bash's
//! `name: line N: ` prefix. The variant name is the stable code carried by
//! `Diag` events.

use std::{borrow::Cow, fmt, io};

use bstr::BString;

use crate::bash::{event::Origin, fd::BadFd};

/// A diagnostic, by catalog entry.
#[derive(Debug, thiserror::Error, strum::EnumDiscriminants)]
#[strum_discriminants(
	name(DiagCode),
	vis(pub(crate)),
	derive(strum::VariantNames, strum::EnumIter)
)]
pub enum Diag {
	/// Command lookup failed (status 127).
	#[error("{name}: command not found")]
	CommandNotFound {
		/// Command name.
		name: BString,
	},
	/// A path does not exist (127 for commands).
	#[error("{name}: No such file or directory")]
	NoSuchFile {
		/// Path or command.
		name: BString,
	},
	/// Execution or open refused (126 for commands).
	#[error("{name}: Permission denied")]
	PermissionDenied {
		/// Path or command.
		name: BString,
	},
	/// A directory was executed or opened for writing.
	#[error("{name}: Is a directory")]
	IsADirectory {
		/// Path.
		name: BString,
	},
	/// Spawning failed for another reason (126).
	#[error("{name}: cannot execute: {}", strerror(.err))]
	CannotExecute {
		/// Command.
		name: BString,
		/// OS error.
		err:  io::Error,
	},
	/// The host could not change a signal's disposition (`trap`).
	#[error("{sig}: {}", strerror(.err))]
	SignalSetup {
		/// The signal.
		sig: crate::bash::signal::Signal,
		/// Host error.
		err: io::Error,
	},
	/// `ENOEXEC` on a file that looks binary (126).
	#[error("{name}: cannot execute binary file: Exec format error")]
	BinaryFile {
		/// Command.
		name: BString,
	},
	/// A native task could not be started (126).
	#[error("{name}: {}", strerror(.err))]
	StartFailed {
		/// Command.
		name: BString,
		/// Host error.
		err:  io::Error,
	},
	/// Syntax error body from the parser (status 2).
	#[error("{msg}")]
	Syntax {
		/// e.g. ``syntax error near unexpected token `fi'``.
		msg: BString,
	},
	/// Second line of a token syntax error: the offending source line.
	#[error("`{text}'")]
	SyntaxContext {
		/// The line, without its newline.
		text: BString,
	},
	/// Valid bash this engine does not implement yet.
	#[error("{what}: not supported by this engine yet")]
	Unsupported {
		/// What.
		what: Cow<'static, str>,
	},
	/// `for 1 in …`, `declare 1=x`.
	#[error("`{name}': not a valid identifier")]
	InvalidIdent {
		/// The word.
		name: BString,
	},
	/// Assignment to a readonly variable.
	#[error("{name}: readonly variable")]
	Readonly {
		/// Variable.
		name: BString,
	},
	/// `set -u` and an unset variable.
	#[error("{name}: unbound variable")]
	Unbound {
		/// Variable.
		name: BString,
	},
	/// `failglob` and a pattern that matched no file (the command is
	/// discarded, status 1).
	#[error("no match: {pattern}")]
	NoMatch {
		/// The word as written, quotes removed.
		pattern: BString,
	},
	/// Malformed `${…}`.
	#[error("{text}: bad substitution")]
	BadSubst {
		/// The expansion text.
		text: BString,
	},
	/// `${x?msg}` / `${x:?msg}`.
	#[error("{name}: {msg}")]
	ParamUnset {
		/// Parameter.
		name: BString,
		/// Message (default "parameter null or not set").
		msg:  BString,
	},
	/// Arithmetic error with bash's error-token suffix.
	#[error("{expr}: {msg} (error token is \"{token}\")")]
	Arith {
		/// Expression.
		expr:  BString,
		/// What went wrong ("division by 0", …).
		msg:   Cow<'static, str>,
		/// Remaining text at the error.
		token: BString,
	},
	/// A name reference chain that leads back to itself.
	#[error("warning: {name}: circular name reference")]
	CircularNameref {
		/// The reference.
		name: BString,
	},
	/// A name reference resolved past bash's depth limit (it then acts on
	/// the global variable of that name).
	#[error("warning: {name}: maximum nameref depth (8) exceeded")]
	NamerefDepth {
		/// The reference.
		name: BString,
	},
	/// Several messages from one operation (a compound array assignment
	/// reports each bad element); each is printed as its own line.
	#[error("{}", .diags.iter().map(ToString::to_string).collect::<Vec<_>>().join("\n"))]
	Several {
		/// The messages, in order.
		diags: Vec<Self>,
	},
	/// `[[ s =~ re ]]` with a regex that does not compile (status 2).
	#[error("invalid regular expression `{pattern}': {err}")]
	InvalidRegex {
		/// The regex as expanded.
		pattern: BString,
		/// Why it does not compile (the system's `regerror` text).
		err:     crate::bash::pattern::RegexError,
	},
	/// A builtin needed a number.
	#[error("{cmd}: {arg}: numeric argument required")]
	NumericArg {
		/// Builtin.
		cmd: Cow<'static, str>,
		/// Argument.
		arg: BString,
	},
	/// A builtin got too many arguments.
	#[error("{cmd}: too many arguments")]
	TooManyArgs {
		/// Builtin.
		cmd: Cow<'static, str>,
	},
	/// Unknown builtin option.
	#[error("{cmd}: {opt}: invalid option")]
	InvalidOption {
		/// Builtin.
		cmd: Cow<'static, str>,
		/// Option.
		opt: BString,
	},
	/// Unknown signal name or number.
	#[error("{cmd}: {spec}: invalid signal specification")]
	InvalidSignal {
		/// Builtin.
		cmd:  Cow<'static, str>,
		/// Specification.
		spec: BString,
	},
	/// Unknown job.
	#[error("{cmd}: {spec}: no such job")]
	NoSuchJob {
		/// Builtin.
		cmd:  Cow<'static, str>,
		/// Job spec.
		spec: BString,
	},
	/// Writing a builtin's output failed (status 1).
	#[error("{cmd}: write error: {}", strerror(.err))]
	WriteError {
		/// Builtin.
		cmd: Cow<'static, str>,
		/// OS error.
		err: io::Error,
	},
	/// A redirection target failed to open.
	#[error("{path}: {}", strerror(.err))]
	Io {
		/// Path.
		path: BString,
		/// OS error.
		err:  io::Error,
	},
	/// A redirection word expanded to zero or several fields.
	#[error("{word}: ambiguous redirect")]
	AmbiguousRedirect {
		/// The word.
		word: BString,
	},
	/// `set -C` and an existing file.
	#[error("{path}: cannot overwrite existing file")]
	NoClobber {
		/// Path.
		path: BString,
	},
	/// Redirection from a closed fd.
	#[error("{fd}: Bad file descriptor")]
	BadFd {
		/// fd number.
		fd: i32,
	},
	/// `FUNCNEST` exceeded.
	#[error("{name}: maximum function nesting level exceeded ({max})")]
	FuncNest {
		/// Function.
		name: BString,
		/// Limit.
		max:  u32,
	},
	/// `builtin x` with a non-builtin.
	#[error("{name}: not a shell builtin")]
	NotABuiltin {
		/// Name.
		name: BString,
	},
	/// A host callout failed
	/// ([`CallOutcome::Error`](crate::bash::CallOutcome::Error),
	/// `ShellApi::diag`).
	#[error("{tool}: {msg}")]
	Tool {
		/// Callout name (`argv[0]`).
		tool: BString,
		/// Message.
		msg:  BString,
	},
	/// A locale other than C/POSIX/UTF-8 is treated as UTF-8 (once).
	#[error("warning: locale {name} is treated as UTF-8")]
	LocaleApprox {
		/// The `LC_*` value.
		name: BString,
	},
	/// A value crossed a mode boundary lossily (once per kind per crossing,
	/// [`crate::bash::store::LossyKind`]).
	#[error("warning: {what} lost crossing an emulation-mode boundary")]
	ModeLossy {
		/// What was lost.
		what: Cow<'static, str>,
	},
	/// zsh: a malformed pattern (`bad pattern: X`).
	#[error("bad pattern: {pattern}")]
	BadPattern {
		/// The pattern as written.
		pattern: BString,
	},
	/// zsh `setopt`/`unsetopt`/`emulate -o`/`[[ -o ]]` with an unknown
	/// option name.
	#[error("no such option: {name}")]
	NoSuchOption {
		/// The name given.
		name: BString,
	},
	/// zsh `zmodload` of a module the engine does not provide (only the
	/// built-in `zsh/parameter` views exist); skipped test cases cite it.
	#[error("failed to load module: {name}")]
	ModuleUnavailable {
		/// The module.
		name: BString,
	},
	/// zsh arithmetic error (`bad math expression: …`, `division by zero`).
	#[error("{msg}")]
	BadMathExpr {
		/// zsh's message.
		msg: BString,
	},
	/// zsh: an assignment its parameter cannot take (`params.c`:
	/// `h: attempt to set slice of associative array`, `x: attempt to
	/// assign array value to non-array`, …).
	#[error("{name}: {what}")]
	BadAssign {
		/// The parameter.
		name: BString,
		/// zsh's text after the name.
		what: Cow<'static, str>,
	},
	/// zsh: a malformed subscript or `${x:off:len}` (`invalid subscript`,
	/// `invalid length: x`, `substring expression: -1 < 0`, `bad subscript
	/// for direct array assignment: x`, …), zsh's text.
	#[error("{msg}")]
	ZshSubscript {
		/// zsh's message.
		msg: BString,
	},
	/// zsh: a malformed or failing substitution (`subst.c`: `closing brace
	/// expected`, `error in flags near position 3 in '$x'`, `unrecognized
	/// modifier`, `parse error in command substitution`, …), zsh's text.
	#[error("{msg}")]
	ZshSubst {
		/// zsh's message.
		msg: BString,
	},
	/// zsh: filename expansion failed (`=cmd` not found, `~user`, a
	/// directory stack entry, `no match` under `cshnullglob`, a bad glob
	/// qualifier), zsh's text.
	#[error("{msg}")]
	ZshFileExp {
		/// zsh's message.
		msg: BString,
	},
	/// A process or task could not be restored (its waiter sees 137).
	#[error("{name}: lost across a snapshot restore")]
	Lost {
		/// Command.
		name: BString,
	},
	/// The state store failed; running scripts are abandoned with status 1.
	#[error("shell state store failed")]
	StoreFailed,
	/// `${1:=x}`, `${@:=x}`.
	#[error("{text}: cannot assign in this way")]
	CannotAssign {
		/// The parameter as written.
		text: BString,
	},
	/// `${x:1:-9}` past the start.
	#[error("{expr}: substring expression < 0")]
	SubstrNegative {
		/// The length expression's value.
		expr: BString,
	},
	/// `${!x}` where `x` is unset.
	#[error("{name}: invalid indirect expansion")]
	InvalidIndirect {
		/// The parameter `x`.
		name: BString,
	},
	/// `${!x}` where `$x` is set but is not a variable name
	/// (`x=bad-var; ${!x}` → `bad-var: invalid variable name`).
	#[error("{name}: invalid variable name")]
	InvalidVarName {
		/// The value of `x`.
		name: BString,
	},
	/// A name a builtin looked for does not exist (`unalias x`, `type x`).
	#[error("{name}: not found")]
	NotFound {
		/// The name.
		name: BString,
	},
	/// `alias '\$'=x`, `BASH_ALIASES['\$']=x`.
	#[error("`{name}': invalid alias name")]
	InvalidAlias {
		/// The name.
		name: BString,
	},
	/// A builtin's own usage or state message.
	#[error("{msg}")]
	Usage {
		/// The message, as bash prints it.
		msg: Cow<'static, str>,
	},
	/// A diagnostic reported by a builtin: `NAME: <diag>`.
	#[error("{cmd}: {diag}")]
	Prefixed {
		/// The builtin.
		cmd:  Cow<'static, str>,
		/// What it reports.
		diag: Box<Self>,
	},
	/// A zsh message printed with a line of its own instead of the
	/// command's: zsh's parser messages while `zcompile` reads a file
	/// carry the line in that file.
	#[error("{msg}")]
	ZshAtLine {
		/// The line zsh prints.
		line: u32,
		/// Message.
		msg:  BString,
	},
	/// A non-fatal parser warning (``warning: here-document at line 2 …``).
	#[error("{msg}")]
	Warning {
		/// Message as bash prints it.
		msg: BString,
	},
	/// A syntax error in `eval`'d text: rendered as `NAME: eval: line N: …`.
	#[error("{diag}")]
	Eval {
		/// The parser's diagnostic.
		diag: Box<Self>,
	},
	/// A syntax error in text parsed while expanding (a here-document body):
	/// rendered as `NAME: command substitution: line N: MSG`.
	#[error("{msg}")]
	ComsubSyntax {
		/// Script line bash reports (the line after the document).
		line: u32,
		/// Message.
		msg:  BString,
	},
	/// An arithmetic error inside an array subscript: bash reports it
	/// without the command's name (`let 'a[1+]=1'` → `1+: arithmetic
	/// syntax error…`), so [`Diag::by`] leaves it as it is.
	#[error("{expr}: {msg} (error token is \"{token}\")")]
	ArithSubscript {
		/// Subscript expression.
		expr:  BString,
		/// What went wrong.
		msg:   Cow<'static, str>,
		/// Remaining text at the error.
		token: BString,
	},
	/// An array element assignment's bad subscript (`a[-9]=x`, `printf -v
	/// 'a[@]'`): bash's `err_badarraysub` prints it without the command's
	/// name, so [`Diag::by`] leaves it as it is.
	#[error("{shown}: bad array subscript")]
	BadSubscript {
		/// The element as bash shows it (`a[-9]`, `[-9]=x`).
		shown: BString,
	},
	/// The OS refused to run a file (bash's `file_error` in
	/// `shell_execve`): `name: strerror` (126, 127 for `ENOENT`).
	#[error("{name}: {}", strerror(.err))]
	Refused {
		/// Command.
		name: BString,
		/// OS error.
		err:  io::Error,
	},
	/// An executable with a `#!` line whose interpreter the OS could not
	/// run (126). bash prints it with `sys_error`, without a line number.
	#[error("{name}: {interp}: bad interpreter: {}", strerror(.err))]
	BadInterpreter {
		/// Command.
		name:   BString,
		/// The `#!` interpreter (a trailing CR shown as `^M`).
		interp: BString,
		/// OS error.
		err:    io::Error,
	},
	/// An executable the OS reports missing although it exists (a missing
	/// dynamic loader; 127).
	#[error("{name}: cannot execute: required file not found")]
	RequiredFileMissing {
		/// Command.
		name: BString,
	},
}

impl Diag {
	/// `self` reported by builtin `cmd`.
	pub fn by(self, cmd: impl Into<Cow<'static, str>>) -> Self {
		if matches!(self, Self::ArithSubscript { .. } | Self::BadSubscript { .. }) {
			return self;
		}
		Self::Prefixed { cmd: cmd.into(), diag: Box::new(self) }
	}
}

crate::bash::packed_names::packed_names!(DiagCode);

impl Diag {
	/// Catalog code (the variant name), as carried by `Diag` events.
	pub fn code(&self) -> &'static str {
		DiagCode::from(self).into()
	}
}

/// bash's `strerror` text for an I/O error.
pub fn strerror(err: &io::Error) -> Cow<'static, str> {
	if let Some(inner) = err.get_ref() {
		if inner.is::<BadFd>() {
			return Cow::Borrowed("Bad file descriptor");
		}
		return Cow::Owned(inner.to_string());
	}
	// An OS error: the platform's own `strerror` text, as bash prints it
	// (Rust's message is that text plus " (os error N)"). Windows' texts
	// ("The system cannot find the file specified.") are no shell's: an
	// error with a POSIX counterpart takes its text, as MSYS2's shells do.
	if let Some(code) = err.raw_os_error() {
		if cfg!(windows)
			&& let Some(text) = posix_text(err.kind())
		{
			return Cow::Borrowed(text);
		}
		let text = err.to_string();
		let suffix = format!(" (os error {code})");
		return Cow::Owned(text.strip_suffix(&suffix).unwrap_or(&text).to_owned());
	}
	Cow::Borrowed(posix_text(err.kind()).unwrap_or("Input/output error"))
}

/// The POSIX `strerror` text of an error kind that has one errno.
const fn posix_text(kind: io::ErrorKind) -> Option<&'static str> {
	Some(match kind {
		io::ErrorKind::NotFound => "No such file or directory",
		io::ErrorKind::PermissionDenied => "Permission denied",
		io::ErrorKind::BrokenPipe => "Broken pipe",
		io::ErrorKind::AlreadyExists => "File exists",
		io::ErrorKind::WouldBlock => "Resource temporarily unavailable",
		io::ErrorKind::InvalidInput => "Invalid argument",
		io::ErrorKind::IsADirectory => "Is a directory",
		io::ErrorKind::NotADirectory => "Not a directory",
		io::ErrorKind::StorageFull => "No space left on device",
		io::ErrorKind::Interrupted => "Interrupted system call",
		io::ErrorKind::Unsupported => "Operation not supported",
		io::ErrorKind::OutOfMemory => "Cannot allocate memory",
		io::ErrorKind::DirectoryNotEmpty => "Directory not empty",
		io::ErrorKind::ReadOnlyFilesystem => "Read-only file system",
		io::ErrorKind::ExecutableFileBusy => "Text file busy",
		io::ErrorKind::ArgumentListTooLong => "Argument list too long",
		io::ErrorKind::FileTooLarge => "File too large",
		io::ErrorKind::TooManyLinks => "Too many links",
		io::ErrorKind::CrossesDevices => "Invalid cross-device link",
		_ => return None,
	})
}

/// Where a diagnostic is printed from, for its prefix.
#[derive(Clone, Copy, Debug)]
pub struct DiagSite<'a> {
	/// `$0` (bash uses it as the message prefix).
	pub shell_name: &'a [u8],
	/// Origin of the running script.
	pub origin:     &'a Origin,
	/// Current line.
	pub line:       u32,
	/// The locale is UTF-8 (which bytes print as they are in names).
	pub utf8:       bool,
}

/// The full stderr line for `diag` printed at `site`, newline included.
///
/// Runtime errors print as `name: line N: msg`; syntax errors in a `-c`
/// string print as `name: -c: line N: msg`, as bash 5.3 does.
pub fn render(diag: &Diag, site: DiagSite<'_>) -> Vec<u8> {
	use std::io::Write;

	if let Diag::Several { diags } = diag {
		return diags.iter().flat_map(|d| render(d, site)).collect();
	}
	let syntax = matches!(diag, Diag::Syntax { .. } | Diag::SyntaxContext { .. });
	let mut out = Vec::with_capacity(64);
	out.extend_from_slice(site.shell_name);
	if let Diag::ComsubSyntax { line, msg } = diag {
		out.extend_from_slice(b": command substitution: line ");
		out.extend_from_slice(line.format_into(&mut fmt::NumBuffer::new()).as_bytes());
		out.extend_from_slice(b": ");
		out.extend_from_slice(msg);
		out.push(b'\n');
		return out;
	}
	if let Diag::Eval { diag } = diag {
		out.extend_from_slice(b": eval: line ");
		out.extend_from_slice(site.line.format_into(&mut fmt::NumBuffer::new()).as_bytes());
		out.extend_from_slice(b": ");
		write!(out, "{diag}").expect("writing to a Vec cannot fail");
		out.push(b'\n');
		return out;
	}
	if let Diag::BadInterpreter { .. } = diag {
		// bash's `sys_error`: no line number.
		out.extend_from_slice(b": ");
		write!(out, "{diag}").expect("writing to a Vec cannot fail");
		out.push(b'\n');
		return out;
	}
	if syntax && matches!(site.origin, Origin::Command) {
		out.extend_from_slice(b": -c");
	}
	out.extend_from_slice(b": line ");
	out.extend_from_slice(site.line.format_into(&mut fmt::NumBuffer::new()).as_bytes());
	out.extend_from_slice(b": ");
	message(diag, site.utf8, &mut out);
	out.push(b'\n');
	out
}

/// Where a zsh-dialect diagnostic is printed (zsh `zwarning`/`zerrmsg`).
#[derive(Clone, Copy, Debug)]
pub struct ZshSite<'a> {
	/// zsh's `scriptname`: the function name inside a function, `(eval)`,
	/// `(anon)`, the script or sourced file, `zsh` for `-c`; empty under
	/// `shinstdin` outside functions (`zsh: msg`, a builtin's `CMD: msg`).
	pub prefix: &'a [u8],
	/// zsh's `lineno` (relative to the function, the eval'd string, the
	/// file); 0 prints no line.
	pub line:   u32,
	/// `MULTIBYTE` in a UTF-8 locale: names print UTF-8 characters as they
	/// are (zsh `nicezputs`); otherwise every non-ASCII byte is `\M-x`.
	pub utf8:   bool,
}

/// The full stderr line for `diag` printed by zsh-dialect code (zsh
/// `zwarning`): `PREFIX:LINE: msg`, or `PREFIX:CMD:LINE: msg` for a
/// builtin's ([`Diag::Prefixed`]); without a line, `PREFIX: msg`.
pub fn render_zsh(diag: &Diag, site: ZshSite<'_>) -> Vec<u8> {
	if let Diag::Several { diags } = diag {
		return diags.iter().flat_map(|d| render_zsh(d, site)).collect();
	}
	let mut out = Vec::with_capacity(64);
	let prefixed = matches!(diag, Diag::Prefixed { .. });
	if !site.prefix.is_empty() {
		out.extend_from_slice(site.prefix);
		out.push(b':');
	} else if !prefixed {
		out.extend_from_slice(b"zsh:");
	}
	let body = match diag {
		Diag::Prefixed { cmd, diag } => {
			out.extend_from_slice(cmd.as_bytes());
			out.push(b':');
			diag.as_ref()
		},
		_ => diag,
	};
	// Without a script name (`shinstdin`) zsh prints no line at all.
	let line = match body {
		Diag::ZshAtLine { line, .. } if !site.prefix.is_empty() => *line,
		_ => site.line,
	};
	if line > 0 {
		out.extend_from_slice(line.format_into(&mut fmt::NumBuffer::new()).as_bytes());
		out.extend_from_slice(b": ");
	} else {
		out.push(b' ');
	}
	zsh_message(body, site.utf8, &mut out);
	out.push(b'\n');
	out
}

/// zsh `nicechar` of byte `c`: `\M-` for a byte with the top bit, `^X`
/// for a control character, `^?`, `\n`, `\t`.
fn zsh_nicechar(c: u8, out: &mut Vec<u8>) {
	let mut c = c;
	if c & 0x80 != 0 {
		out.extend_from_slice(b"\\M-");
		c &= 0x7f;
		if (0x20..0x7f).contains(&c) {
			out.push(c);
			return;
		}
	}
	match c {
		0x7f => out.extend_from_slice(b"^?"),
		b'\n' => out.extend_from_slice(b"\\n"),
		b'\t' => out.extend_from_slice(b"\\t"),
		0..0x20 => {
			out.push(b'^');
			out.push(c + 0x40);
		},
		_ => out.push(c),
	}
}

/// zsh `nicezputs` of the raw text `s` (the `%s` of `zerr`): printable
/// characters as they are (UTF-8 ones with `utf8`), the rest by
/// [`zsh_nicechar`], an undecodable byte at a time.
fn zsh_nicezputs(s: &[u8], utf8: bool, out: &mut Vec<u8>) {
	let mut i = 0;
	while i < s.len() {
		if utf8 && s[i] > 0x7f {
			let (ch, len) = bstr::decode_utf8(&s[i..]);
			if let Some(ch) = ch
				&& !ch.is_control()
			{
				out.extend_from_slice(&s[i..i + len]);
				i += len;
				continue;
			}
		}
		zsh_nicechar(s[i], out);
		i += 1;
	}
}

/// zsh's text for the condition `diag` reports, where it differs from
/// bash's (zsh 5.9 `exec.c`, `params.c`, `glob.c`, `subst.c` messages).
fn zsh_message(diag: &Diag, utf8: bool, out: &mut Vec<u8>) {
	use std::io::Write;

	let text = |out: &mut Vec<u8>, a: &[u8], b: &[u8]| {
		out.extend_from_slice(a);
		zsh_nicezputs(b, utf8, out);
	};
	match diag {
		Diag::CommandNotFound { name } => text(out, b"command not found: ", name),
		Diag::NoSuchFile { name } => text(out, b"no such file or directory: ", name),
		Diag::PermissionDenied { name } => text(out, b"permission denied: ", name),
		Diag::IsADirectory { name } => text(out, b"is a directory: ", name),
		Diag::Readonly { name } => text(out, b"read-only variable: ", name),
		Diag::InvalidIdent { name } => text(out, b"not an identifier: ", name),
		Diag::NoMatch { pattern } => text(out, b"no matches found: ", pattern),
		Diag::Unbound { name } => {
			zsh_nicezputs(name, utf8, out);
			out.extend_from_slice(b": parameter not set");
		},
		Diag::BadSubst { .. } => out.extend_from_slice(b"bad substitution"),
		_ => write!(out, "{diag}").expect("writing to a Vec cannot fail"),
	}
}

/// The text of `diag`. A command name prints as bash's `printable_filename`
/// shows it (`$'…'` when it has bytes the locale cannot print), byte for
/// byte otherwise.
fn message(diag: &Diag, utf8: bool, out: &mut Vec<u8>) {
	use std::io::Write;

	if let Diag::CommandNotFound { name } = diag {
		out.extend_from_slice(&crate::bash::vm::quote::printable_filename(name, utf8, false));
		out.extend_from_slice(b": command not found");
		return;
	}
	write!(out, "{diag}").expect("writing to a Vec cannot fail");
}
