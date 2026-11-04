//! `set -x` (xtrace): bash's trace of each command after expansion, one
//! line per command on `BASH_XTRACEFD` (else stderr), after `PS4` with
//! its first character repeated once per nesting level.

use bstr::BString;

use super::{
	Cx, Kernel, TextKind,
	expand::Expander,
	locale,
	proc::{AssignValue, FrameKind, PendingWrite, ScriptKind, Vproc},
	quote, state,
};
use crate::bash::store::OptId;

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
pub fn on(k: &mut Kernel, cx: &mut Cx<'_>, vp: &Vproc) -> bool {
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
	let fd = trace_fd(k, cx, vp);
	vp.out
		.push_back(PendingWrite { fd, bytes: BString::from(bytes), off: 0 });
}

/// `BASH_XTRACEFD` when it names an open descriptor, else 2.
fn trace_fd(k: &Kernel, cx: &mut Cx<'_>, vp: &Vproc) -> i32 {
	state::lookup(&k.root, cx.store, vp, b"BASH_XTRACEFD")
		.ok()
		.flatten()
		.and_then(|v| v.as_scalar())
		.and_then(|s| std::str::from_utf8(s).ok()?.parse::<i32>().ok())
		.filter(|&fd| fd >= 0 && vp.fds.get(fd).is_some_and(|h| h.is_open()))
		.unwrap_or(2)
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
	let site = k.zsh_site(cx, vp, line);
	let mut log = Vec::new();
	let mut ex = Expander::new(k, cx, vp, &mut log, false, line);
	let text = if subst {
		zsh_print::prompt_subst(&mut ex, ps4).ok()?
	} else {
		ps4.to_vec()
	};
	let env = zsh_print::prompt_env_ex(&mut ex, site, percent, bang).ok()?;
	Some(crate::bash::vm::builtins::zsh_prompt::promptexpand(&text, &env))
}

fn expand_ps4(k: &mut Kernel, cx: &mut Cx<'_>, vp: &mut Vproc, line: u32) -> Option<BString> {
	let mode = super::exec::mode_of(vp);
	let tunit = k
		.engine
		.text_unit(b"${PS4@P}", TextKind::HereDoc, mode)
		.ok()?;
	let w = tunit.words.last().cloned()?;
	let mut log = Vec::new();
	let mut ex = Expander::new(k, cx, vp, &mut log, false, line);
	ex.scalar(&tunit, &w).ok()
}
