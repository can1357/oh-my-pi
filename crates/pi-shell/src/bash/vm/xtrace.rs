//! `set -x` (xtrace): bash's trace of each command after expansion, one
//! line per command on `BASH_XTRACEFD` (else stderr), after `PS4` with
//! its first character repeated once per nesting level.

use bstr::BString;

use super::{
	Cx, Kernel, TextKind,
	builtins::zsh_quote::{Charset, quotedzputs},
	expand::Expander,
	locale,
	proc::{AssignValue, FrameKind, PendingWrite, Saved, ScriptKind, Vproc},
	quote, state,
};
use crate::bash::{store::OptId, zshopt::ZshOpt};

/// bash's `indirection_level` in `vp`: 1 at the top, one more per `eval`,
/// `.` file and trap action running, plus the level the vproc started at
/// ([`Vproc::trace_base`]: its parent's, and one more in a command
/// substitution).
pub fn level(vp: &Vproc) -> u32 {
	let nested = vp
		.frames
		.iter()
		.filter(|f| {
			matches!(f.kind, FrameKind::Script {
				what: ScriptKind::Eval | ScriptKind::Source | ScriptKind::Trap { .. },
				..
			})
		})
		.count();
	1u32
		.saturating_add(vp.trace_base)
		.saturating_add(u32::try_from(nested).unwrap_or(u32::MAX))
}

/// Whether `set -x` is on.
#[inline]
pub fn on(k: &mut Kernel, cx: &mut Cx<'_>, vp: &Vproc) -> bool {
	// The call the line editor makes of a hook or widget function is not
	// a command line (zsh calls the function directly): never traced.
	if matches!(
		vp.frames.last().map(|f| &f.kind),
		Some(FrameKind::Script { what: ScriptKind::Hook, .. })
	) {
		return false;
	}
	state::option(&mut k.root, cx.store, vp, OptId::Xtrace).unwrap_or(false)
}

/// Whether words are quoted for a UTF-8 locale.
pub fn utf8(k: &mut Kernel, cx: &mut Cx<'_>, vp: &Vproc) -> bool {
	locale::is_utf8(k, cx.store, vp)
}

/// Append `w` as bash's `xtrace_print_word_list` shows a word: `''` when
/// empty, `$'…'` with control or unprintable characters, single quotes
/// with shell metacharacters, else as it is.
pub fn push_word(out: &mut Vec<u8>, w: &[u8], utf8: bool) {
	if w.is_empty() {
		out.extend_from_slice(b"''");
	} else {
		out.extend_from_slice(&quote::printable_filename(w, utf8, true));
	}
}

/// Append the words of a command, space-separated.
pub fn push_words<W: AsRef<[u8]>>(out: &mut Vec<u8>, words: &[W], utf8: bool) {
	for (i, w) in words.iter().enumerate() {
		if i > 0 {
			out.push(b' ');
		}
		push_word(out, w.as_ref(), utf8);
	}
}

/// Append an assignment as bash's `xtrace_print_assignment` shows it:
/// `name[index]+=value`, the value quoted like a word but empty as
/// nothing; a compound value as `(…)` of its elements.
pub fn push_assign(
	out: &mut Vec<u8>,
	name: &[u8],
	index: Option<&[u8]>,
	append: bool,
	value: &AssignValue,
	utf8: bool,
) {
	out.extend_from_slice(name);
	if let Some(index) = index {
		out.push(b'[');
		out.extend_from_slice(index);
		out.push(b']');
	}
	out.extend_from_slice(if append { b"+=" } else { b"=" });
	match value {
		AssignValue::Scalar(v) if v.is_empty() => {},
		AssignValue::Scalar(v) => out.extend_from_slice(&quote::printable_filename(v, utf8, true)),
		AssignValue::Array(items) => {
			out.push(b'(');
			for (i, (key, plus, v)) in items.iter().enumerate() {
				if i > 0 {
					out.push(b' ');
				}
				if let Some(key) = key {
					out.push(b'[');
					out.extend_from_slice(key);
					out.extend_from_slice(if *plus { b"]+=" } else { b"]=" });
					out.extend_from_slice(&quote::printable_filename(v, utf8, true));
				} else {
					push_word(out, v, utf8);
				}
			}
			out.push(b')');
		},
	}
}

/// Trace one `[[ … ]]` primary as bash's `xtrace_print_cond_term` does:
/// `[[ op arg ]]`, `[[ lhs op rhs ]]` (a lone word as `-n word`), each
/// expanded term as it is, an empty one as `''`.
pub fn cond(k: &mut Kernel, cx: &mut Cx<'_>, vp: &mut Vproc, line: u32, terms: &[&[u8]]) {
	let mut body = b"[[".to_vec();
	for t in terms {
		body.push(b' ');
		if t.is_empty() {
			body.extend_from_slice(b"''");
		} else {
			body.extend_from_slice(t);
		}
	}
	body.extend_from_slice(b" ]]");
	emit(k, cx, vp, line, &body);
}

/// Queue one trace line: the `PS4` prefix, `body`, a newline. It goes out
/// with the shell's other diagnostics, before the command's redirections.
pub fn emit(k: &mut Kernel, cx: &mut Cx<'_>, vp: &mut Vproc, line: u32, body: &[u8]) {
	let mut bytes = prefix(k, cx, vp, line);
	bytes.extend_from_slice(body);
	bytes.push(b'\n');
	write(k, cx, vp, bytes);
}

/// Queue `bytes` (a whole trace line, or zsh's pieces of one) for the
/// trace output.
pub fn write(k: &Kernel, cx: &mut Cx<'_>, vp: &mut Vproc, bytes: Vec<u8>) {
	let fd = trace_fd(k, cx, vp);
	vp.out
		.push_back(PendingWrite { fd, bytes: BString::from(bytes), off: 0 });
}

/// The trace prefix for a command on `line`: `PS4` expanded (zsh
/// `printprompt4`).
pub fn ps4(k: &mut Kernel, cx: &mut Cx<'_>, vp: &mut Vproc, line: u32) -> Vec<u8> {
	prefix(k, cx, vp, line)
}

/// zsh's quoting of traced words: `quotedzputs` under the shell's
/// `RC_QUOTES`, `MULTIBYTE` (in a UTF-8 locale) and `PRINT_EIGHT_BIT`.
#[derive(Clone, Copy)]
pub struct ZshQuote {
	rc: bool,
	cs: Charset,
}

impl ZshQuote {
	/// The settings in effect in `vp`.
	pub fn of(k: &mut Kernel, cx: &mut Cx<'_>, vp: &Vproc) -> Self {
		let mut opt = |o| state::zsh_option(&mut k.root, cx.store, vp, o).unwrap_or(false);
		let (rc, mb, eight) =
			(opt(ZshOpt::Rcquotes), opt(ZshOpt::Multibyte), opt(ZshOpt::Printeightbit));
		let utf8 = mb && locale::is_utf8(k, cx.store, vp);
		let (bang, bang_special) =
			crate::bash::vm::zsh::params::bang_quoting(&mut k.root, cx.store, vp);
		Self { rc, cs: Charset { utf8, print_eight: eight, bang, bang_special } }
	}

	/// Append `w` quoted.
	pub fn push(self, out: &mut Vec<u8>, w: &[u8]) {
		out.extend_from_slice(&quotedzputs(w, self.rc, self.cs));
	}
}

/// zsh `quote_tokenized_output`: a pattern operand of `[[ = ]]` as the
/// trace shows it, its active tokens as their characters, other pattern
/// characters (and a leading `=`) backslash-quoted, tab, newline and
/// carriage return as `$'…'`.
pub fn quote_tokenized(s: &[u8]) -> Vec<u8> {
	use crate::bash::syntax::zsh::tok::{META, NULARG, is_tok, tok_char};
	let mut out = Vec::with_capacity(s.len() + 4);
	let mut i = 0;
	while let Some(&c) = s.get(i) {
		i += 1;
		match c {
			META => {
				if let Some(&d) = s.get(i) {
					out.push(d ^ 32);
					i += 1;
				}
				continue;
			},
			NULARG => continue,
			b'\\' | b'<' | b'>' | b'(' | b'|' | b')' | b'^' | b'#' | b'~' | b'[' | b']' | b'*'
			| b'?' | b'$' | b' ' => out.push(b'\\'),
			b'\t' => {
				out.extend_from_slice(b"$'\\t'");
				continue;
			},
			b'\n' => {
				out.extend_from_slice(b"$'\\n'");
				continue;
			},
			b'\r' => {
				out.extend_from_slice(b"$'\\r'");
				continue;
			},
			b'=' if i == 1 => out.push(b'\\'),
			_ if is_tok(c) => {
				if let Some(t) = tok_char(c) {
					out.push(t);
				}
				continue;
			},
			_ => {},
		}
		out.push(c);
	}
	out
}

/// Where trace output goes. bash: `BASH_XTRACEFD` when it names an open
/// descriptor, else 2. zsh ([`zsh_trace_fd`]): the standard error the
/// command running a `.`/`eval` had before its redirections.
fn trace_fd(k: &Kernel, cx: &mut Cx<'_>, vp: &mut Vproc) -> i32 {
	if vp.mode.dialect() == crate::bash::ids::Dialect::Zsh {
		return zsh_trace_fd(vp);
	}
	state::lookup(&k.root, cx.store, vp, b"BASH_XTRACEFD")
		.ok()
		.flatten()
		.and_then(|v| v.as_scalar())
		.and_then(|s| std::str::from_utf8(s).ok()?.parse::<i32>().ok())
		.filter(|&fd| fd >= 0 && vp.fds.get(fd).is_some_and(|h| h.is_open()))
		.unwrap_or(2)
}

/// zsh's `xtrerr`: a simple command run with redirections keeps a copy of
/// the standard error it had before them for the trace of what it runs
/// (`.`, `eval`), the outermost such command since the innermost function
/// call (`execshfunc` resets it to the standard error). The copy is put at
/// a free descriptor ≥ 10 (zsh `movefd`, `FDT_XTRACE`), closed with the
/// command's own redirections.
fn zsh_trace_fd(vp: &mut Vproc) -> i32 {
	let mut found = None;
	for i in (0..vp.frames.len().saturating_sub(1)).rev() {
		if matches!(vp.frames[i + 1].kind, FrameKind::Function { .. }) {
			break;
		}
		let saves_stderr = vp.frames[i]
			.scratch
			.as_ref()
			.and_then(|sc| sc.io.as_ref())
			.is_some_and(|io| io.saved.iter().any(|s| s.fd == 2));
		if saves_stderr {
			found = Some(i);
		}
	}
	let Some(io) = found.and_then(|i| vp.frames[i].scratch.as_mut()?.io.as_mut()) else {
		return 2;
	};
	// Closed before the redirections: the trace goes nowhere.
	let Some(prev) = io
		.saved
		.iter()
		.find(|s| s.fd == 2)
		.and_then(|s| s.prev.clone())
	else {
		return -1;
	};
	if let Some(s) = io
		.saved
		.iter()
		.find(|s| s.fd >= 10 && s.prev.is_none() && vp.fds.get(s.fd).is_some_and(|h| h.same(&prev)))
	{
		return s.fd;
	}
	let fd = vp.fds.lowest_free(10);
	vp.fds.set(fd, Some(prev));
	io.saved.push(Saved { fd, prev: None });
	fd
}

/// `PS4` expanded as a prompt (`${PS4@P}`; as it is when the expansion
/// would need a command substitution), its first character repeated to
/// the nesting [`level`]. Unset or empty: no prefix.
fn prefix(k: &mut Kernel, cx: &mut Cx<'_>, vp: &mut Vproc, line: u32) -> Vec<u8> {
	let ps4 = state::lookup(&k.root, cx.store, vp, b"PS4")
		.ok()
		.flatten()
		.and_then(|v| v.as_scalar().map(BString::from))
		.unwrap_or_default();
	if ps4.is_empty() {
		return Vec::new();
	}
	if vp.mode.dialect() == crate::bash::ids::Dialect::Zsh {
		return zsh_prefix(k, cx, vp, line, &ps4).unwrap_or_else(|| ps4.to_vec());
	}
	let expanded = if ps4.iter().any(|c| matches!(c, b'$' | b'`' | b'\\')) {
		expand_ps4(k, cx, vp, line).unwrap_or(ps4)
	} else {
		ps4
	};
	let mut out = Vec::with_capacity(expanded.len() + 4);
	if let Some(&first) = expanded.first() {
		for _ in 1..level(vp) {
			out.push(first);
		}
	}
	out.extend_from_slice(&expanded);
	out
}

/// zsh's trace prefix: `PS4` through `promptexpand` (`%N`, `%i`, …; its
/// substitutions too with `PROMPT_SUBST`), not repeated per level. `None`
/// when the state cannot be read or a substitution would need to run a
/// command.
fn zsh_prefix(
	k: &mut Kernel,
	cx: &mut Cx<'_>,
	vp: &mut Vproc,
	line: u32,
	ps4: &[u8],
) -> Option<Vec<u8>> {
	use crate::bash::{vm::builtins::zsh_print, zshopt::ZshOpt};
	let mut opt = |o| state::zsh_option(&mut k.root, cx.store, vp, o).ok();
	let (percent, bang, subst) =
		(opt(ZshOpt::Promptpercent)?, opt(ZshOpt::Promptbang)?, opt(ZshOpt::Promptsubst)?);
	let stack = zsh_cmdstack(vp);
	let mut log = Vec::new();
	let mut ex = Expander::new(k, cx, vp, &mut log, false, line);
	zsh_print::expand_prompt_in(&mut ex, ps4, Some((percent, bang, subst)), false, stack).ok()
}

/// zsh's command stack while the top frame runs (`cmdpush` in `execif`,
/// `execwhile`, `execfor`, `execrepeat`, `execselect`, `execcase`,
/// `execcursh`, `exectry`), outermost first, for `%_` in `PS4`: from the
/// compound commands the frame is in ([`super::proc::Frame::enters`]); an `if`
/// is `if`/`elif` in a condition, `then`/`elif-then` in a branch, `else` after
/// them.
fn zsh_cmdstack(vp: &Vproc) -> Vec<&'static str> {
	use crate::bash::{
		event::{Construct, NodeKind},
		ir::Opcode,
		syntax::zsh::{
			CS_ALWAYS, CS_CASE, CS_CURSH, CS_ELIF, CS_ELIFTHEN, CS_ELSE, CS_FOR, CS_IF, CS_IFTHEN,
			CS_REPEAT, CS_SELECT, CS_UNTIL, CS_WHILE, cmdname,
		},
	};
	let Some(f) = vp.frames.last() else {
		return Vec::new();
	};
	let Some(unit) = f.unit.as_ref() else {
		return Vec::new();
	};
	let pc = f.pc;
	let ops_of = |node: u32| {
		unit
			.ops
			.iter()
			.enumerate()
			.filter(move |(_, op)| op.node == node)
	};
	let mut out = Vec::with_capacity(f.enters.len());
	for &(node, _) in &f.enters {
		let Some(kind) = unit.nodes.get(node as usize).map(|n| n.kind) else {
			continue;
		};
		let cs = match kind {
			NodeKind::If => {
				let mut cs = CS_ELSE;
				for (at, op) in ops_of(node) {
					let arm = match (op.code, Construct::from_u32(op.b)) {
						(Opcode::BrFail, Construct::If) => (CS_IF, CS_IFTHEN),
						(Opcode::BrFail, Construct::Elif) => (CS_ELIF, CS_ELIFTHEN),
						_ => continue,
					};
					if pc < at as u32 {
						cs = arm.0;
						break;
					}
					if pc < op.a {
						cs = arm.1;
						break;
					}
				}
				cs
			},
			NodeKind::While if ops_of(node).any(|(_, op)| op.code == Opcode::Repeat) => CS_REPEAT,
			NodeKind::While => CS_WHILE,
			NodeKind::Until => CS_UNTIL,
			NodeKind::For | NodeKind::ArithFor => CS_FOR,
			NodeKind::Select => CS_SELECT,
			NodeKind::Case => CS_CASE,
			NodeKind::Brace => match ops_of(node).find(|(_, op)| op.code == Opcode::AlwaysEnter) {
				Some((at, _)) if pc >= at as u32 => CS_ALWAYS,
				_ => CS_CURSH,
			},
			// `[[ ]]` and `(( ))` trace their line before they push `cond`
			// and `math`, and run nothing else traced in this frame.
			_ => continue,
		};
		out.push(cmdname(cs));
	}
	out
}

fn expand_ps4(k: &mut Kernel, cx: &mut Cx<'_>, vp: &mut Vproc, line: u32) -> Option<BString> {
	let mode = super::exec::mode_of(vp);
	let tunit = k
		.engine
		.text_unit(
			b"${PS4@P}",
			TextKind::HereDoc,
			mode,
			k.mask.contains(crate::bash::event::EventKind::UnitCompiled),
		)
		.ok()?;
	let w = tunit.words.last().cloned()?;
	let mut log = Vec::new();
	let mut ex = Expander::new(k, cx, vp, &mut log, false, line);
	ex.scalar(&tunit, &w).ok()
}
