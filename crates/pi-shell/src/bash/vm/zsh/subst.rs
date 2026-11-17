//! zsh word expansion: a port of zsh 5.9's `subst.c`
//! (`prefork`, `stringsubst`, `paramsubst` with every flag, `multsub`,
//! `singsub`, `filesub`, `equalsubstr`, `arithsubst`, `dopadding`,
//! `strcatsub`), the `globlist` split between substitution and filename
//! generation, `strmetasort` (`sort.c`) and quote removal.
//!
//! Words are zsh strings (metafied, tokenized;
//! [`crate::bash::syntax::zsh::tok`]). A command substitution parks the op: it
//! returns [`Stop::ZshSub`] with the body's text, the executor runs it in a
//! child vproc and logs its output, and the expansion re-runs, replaying side
//! effects from the log (see [`crate::bash::vm::expand`]).
//!
//! Ported from zsh 5.9 (MIT-style licence, Copyright (c) 1992-1997 Paul
//! Falstad and the zsh development group).

use bstr::{BStr, BString};

use super::{
	arith, brace,
	math::Number,
	modify::{self, HistSubst},
	params::{
		self, PValue, PmFlags, SCANPM_ASSIGNING, SCANPM_CHECKING, SCANPM_DQUOTED, SCANPM_WANTINDEX,
		VALFLAG_EMPTY, VALFLAG_INV, VALFLAG_SUBST, Value, opt,
	},
	subscript, text, zpattern,
};
use crate::bash::{
	diag::Diag,
	ir::WordKind,
	pattern::zsh::{Captures, SubFlags},
	syntax::zsh::tok::{
		BNULL, BNULLKEEP, DASH, DNULL, EQUALS, HAT, INANG, INBRACE, INBRACK, INPAR, INPARMATH,
		MARKER, META, NULARG, OUTANGPROC, OUTBRACE, OUTBRACK, OUTPAR, OUTPARMATH, POUND, QSTRING,
		QTICK, QUEST, SNULL, STAR, STRING, TICK, TILDE, at, head, is_null, is_tok, metafy, span,
		tail, tok_char, unmetafy, untokenize,
	},
	vm::{
		builtins::zsh_quote,
		expand::{Expander, Stop, X},
		proc::Atom,
		state,
	},
	zshopt::ZshOpt,
};

// ---- flags -------------------------------------------------------------

/// `PREFORK_TYPESET`: `~`/`=` after `=` and `:` (typeset, magic equals).
pub const PREFORK_TYPESET: u32 = 0x01;
/// `PREFORK_ASSIGN`: an assignment value.
pub const PREFORK_ASSIGN: u32 = 0x02;
/// `PREFORK_SINGLE`: one word, no splitting.
pub const PREFORK_SINGLE: u32 = 0x04;
/// `PREFORK_SPLIT`: force splitting.
pub const PREFORK_SPLIT: u32 = 0x08;
/// `PREFORK_SHWORDSPLIT`: `sh_word_split` splitting.
pub const PREFORK_SHWORDSPLIT: u32 = 0x10;
/// `PREFORK_NOSHWORDSPLIT`: ignore `sh_word_split`.
pub const PREFORK_NOSHWORDSPLIT: u32 = 0x20;
/// `PREFORK_SUBEXP`: a nested substitution.
pub const PREFORK_SUBEXP: u32 = 0x40;
/// `PREFORK_KEY_VALUE`: the list holds `[key]=value` triples.
pub const PREFORK_KEY_VALUE: u32 = 0x80;

/// `MULTSUB_WS_AT_START`.
const MULTSUB_WS_AT_START: u32 = 1;
/// `MULTSUB_WS_AT_END`.
const MULTSUB_WS_AT_END: u32 = 2;
/// `MULTSUB_PARAM_NAME`.
const MULTSUB_PARAM_NAME: u32 = 4;

/// `SORTIT_IGNORING_CASE`.
const SORTIT_IGNORING_CASE: u32 = 1;
/// `SORTIT_NUMERICALLY`.
const SORTIT_NUMERICALLY: u32 = 2;
/// `SORTIT_NUMERICALLY_SIGNED`.
const SORTIT_NUMERICALLY_SIGNED: u32 = 4;
/// `SORTIT_BACKWARDS`.
const SORTIT_BACKWARDS: u32 = 8;
/// `SORTIT_IGNORING_BACKSLASHES`.
const SORTIT_IGNORING_BACKSLASHES: u32 = 16;
/// `SORTIT_SOMEHOW`.
const SORTIT_SOMEHOW: u32 = 32;

/// zsh's quote types, numbered as `QT_*` so `(qq…)` can count up.
mod qt {
	pub const NONE: i32 = 0;
	pub const BACKSLASH: i32 = 1;
	pub const SINGLE: i32 = 2;
	pub const DOUBLE: i32 = 3;
	pub const DOLLARS: i32 = 4;
	pub const SINGLE_OPTIONAL: i32 = 6;
	pub const BACKSLASH_PATTERN: i32 = 7;
	pub const QUOTEDZPUTS: i32 = 9;
}

/// zsh `IS_DASH`.
const fn is_dash(c: u8) -> bool {
	c == b'-' || c == DASH
}

/// zsh `isstring`.
const fn isstring(c: u8) -> bool {
	c == b'$' || c == STRING || c == QSTRING
}

/// zsh `isbrack`.
const fn isbrack(c: u8) -> bool {
	c == b'[' || c == INBRACK
}

/// A substitution error with zsh's text.
fn zerr(msg: impl Into<BString>) -> Stop {
	Stop::Fail(Diag::ZshSubst { msg: msg.into() })
}

/// `bad substitution`.
fn bad_subst() -> Stop {
	Stop::Fail(Diag::BadSubst { text: BString::default() })
}

// ---- the word list -------------------------------------------------

/// zsh's `LinkList` of words in expansion, with its `LF_ARRAY` flag.
#[derive(Clone, Debug, Default)]
pub struct List {
	/// The words (metafied, tokenized).
	pub nodes: Vec<Vec<u8>>,
	/// `LF_ARRAY`: the words come from an array (a one-word array stays
	/// an array).
	pub array: bool,
}

impl List {
	/// A list of one word.
	pub fn one(s: Vec<u8>) -> Self {
		Self { nodes: vec![s], array: false }
	}

	/// Word `n` (empty past the end, like [`at`]).
	fn node(&self, n: usize) -> &[u8] {
		self.nodes.get(n).map_or(&[], Vec::as_slice)
	}

	/// Take word `n` out, leaving it empty.
	fn take(&mut self, n: usize) -> Vec<u8> {
		self.nodes.get_mut(n).map_or_default(std::mem::take)
	}

	/// Insert word `w` at `n` (at the end when `n` is past it).
	fn insert(&mut self, n: usize, w: Vec<u8>) {
		let n = n.min(self.nodes.len());
		self.nodes.insert(n, w);
	}

	/// Remove word `n` (nothing past the end).
	fn remove(&mut self, n: usize) {
		if n < self.nodes.len() {
			self.nodes.remove(n);
		}
	}

	/// Replace word `n` (nothing past the end).
	fn set(&mut self, n: usize, w: Vec<u8>) {
		if let Some(node) = self.nodes.get_mut(n) {
			*node = w;
		}
	}
}

// ---- replay ------------------------------------------------------------

/// The next logged atom when replaying.
fn replay(ex: &mut Expander<'_, '_>) -> Option<Atom> {
	if !ex.record || ex.cursor >= ex.log.len() {
		return None;
	}
	let a = ex.log.get(ex.cursor).cloned();
	ex.cursor += 1;
	a
}

/// Log the atom `a` makes when the expansion is recorded.
fn note(ex: &mut Expander<'_, '_>, a: impl FnOnce() -> Atom) {
	if ex.record {
		ex.log.push(a());
		ex.cursor += 1;
	}
}

/// Run a side effect once across replays. When the effect itself logged
/// atoms (a filesystem probe of zsh/mapfile, a substitution in a
/// subscript), it runs again on the replay, reading them, up to its `Done`.
fn effect(ex: &mut Expander<'_, '_>, f: impl FnOnce(&mut Expander<'_, '_>) -> X<()>) -> X<()> {
	match replay(ex) {
		Some(Atom::Done) => return Ok(()),
		Some(_) => ex.cursor -= 1,
		None => {},
	}
	f(ex)?;
	if ex.record && matches!(ex.log.get(ex.cursor), Some(Atom::Done)) {
		ex.cursor += 1;
	} else {
		note(ex, || Atom::Done);
	}
	Ok(())
}

/// Run `${name::=word}`'s assignment `f` on every pass: [`begin_pass`] has
/// put back what it replaced, so each pass sees the state the first pass
/// saw at every point (`${x::=a}${x:-…}`, p10k's `${COLUMNS::=1024}` …
/// `${COLUMNS::=$saved}`). The first pass logs the replaced value
/// ([`Atom::Wrote`]); an assignment that cannot be put back (an
/// association, a subscripted name) logs `Done`.
fn redo(
	ex: &mut Expander<'_, '_>,
	name: &[u8],
	f: impl FnOnce(&mut Expander<'_, '_>) -> X<()>,
) -> X<()> {
	let fresh = ex.record && ex.cursor >= ex.log.len();
	let name = unmetafy(name);
	let old = if fresh && !name.contains(&b'[') {
		saved(ex, &name)?
	} else {
		None
	};
	f(ex)?;
	if !fresh {
		match replay(ex) {
			Some(Atom::Done | Atom::Wrote { .. }) => {},
			Some(_) => ex.cursor -= 1,
			None => {},
		}
		return Ok(());
	}
	let Some(old) = old else {
		note(ex, || Atom::Done);
		return Ok(());
	};
	let new = match params::getparam(ex, &name)? {
		Some(p) => match p.value {
			PValue::Scalar(s) => Some(s),
			_ => None,
		},
		None => None,
	};
	note(ex, || Atom::Wrote { name: BString::from(name), old: Box::new(old), new });
	Ok(())
}

/// What `${name::=…}` replaces, as [`Atom::Wrote`] keeps it; `None` for an
/// association (not put back).
fn saved(ex: &mut Expander<'_, '_>, name: &[u8]) -> X<Option<Atom>> {
	Ok(match params::getparam(ex, name)? {
		Some(p) if !p.flags.contains(PmFlags::UNSET) => match p.value {
			PValue::Scalar(s) => Some(Atom::Str(Some(s))),
			PValue::Array(a) => Some(Atom::List(a)),
			PValue::Hash(_) => None,
		},
		_ => Some(Atom::Str(None)),
	})
}

/// Start a pass of a recorded expansion over the log of earlier passes:
/// put back what their `${name::=…}` assignments replaced ([`Atom::Wrote`]),
/// newest first, so this pass sees the state the first one saw; a name
/// something else assigned since (the substitution that ran) keeps its
/// value.
///
/// # Errors
/// A store failure, a read-only parameter.
pub fn begin_pass(ex: &mut Expander<'_, '_>) -> X<()> {
	if !ex.record || ex.cursor != 0 || !ex.log.iter().any(|a| matches!(a, Atom::Wrote { .. })) {
		return Ok(());
	}
	let undo: Vec<(BString, Atom, Option<BString>)> = ex
		.log
		.iter()
		.rev()
		.filter_map(|a| match a {
			Atom::Wrote { name, old, new } => Some((name.clone(), (**old).clone(), new.clone())),
			_ => None,
		})
		.collect();
	for (name, old, new) in undo {
		if let Some(new) = new
			&& params::getsparam(ex, &name)?.is_none_or(|now| now != new)
		{
			continue;
		}
		match old {
			Atom::Str(None) => params::unsetparam(ex, &name)?,
			Atom::Str(Some(v)) => params::assignsparam(ex, &name, &v, 0)?,
			Atom::List(items) => params::assignaparam(ex, &name, items, 0)?,
			_ => {},
		}
	}
	Ok(())
}

/// Branch `now` decided once across replays: the first pass's answer is
/// logged and the replay follows it. `${name:=word}` needs this: its
/// assignment sets `name`, so the replay would skip the branch and leave
/// the assignment's atoms to misalign every later atom of the log.
fn decided(ex: &mut Expander<'_, '_>, now: bool) -> bool {
	match replay(ex) {
		Some(Atom::Branch(taken)) => taken,
		Some(_) => {
			ex.cursor -= 1;
			now
		},
		None => {
			note(ex, || Atom::Branch(now));
			now
		},
	}
}

/// A value computed once across replays (`$((…))`).
fn once(
	ex: &mut Expander<'_, '_>,
	f: impl FnOnce(&mut Expander<'_, '_>) -> X<Vec<u8>>,
) -> X<Vec<u8>> {
	match replay(ex) {
		Some(Atom::Str(Some(s))) => return Ok(s.to_vec()),
		// What the computation itself logged (a math function's call):
		// it runs again, reading it.
		Some(_) => ex.cursor -= 1,
		None => {},
	}
	let v = f(ex)?;
	if ex.record && matches!(ex.log.get(ex.cursor), Some(Atom::Str(Some(_)))) {
		ex.cursor += 1;
	} else {
		note(ex, || Atom::Str(Some(BString::from(v.clone()))));
	}
	Ok(v)
}

/// zsh `getoutput`: the output of the command substitution `body` (raw
/// zsh source, metafied). On the first pass it parks the op
/// ([`Stop::ZshSub`]); on the replay it is the logged output.
pub(super) fn getoutput(ex: &mut Expander<'_, '_>, body: &[u8]) -> X<Vec<u8>> {
	let atom = if ex.record {
		replay(ex)
	} else {
		let a = ex.log.get(ex.cursor).cloned();
		ex.cursor += usize::from(a.is_some());
		a
	};
	match atom {
		Some(Atom::Sub { out, status }) => {
			ex.sub_status = Some(status);
			ex.vp.status = status;
			Ok(out.to_vec())
		},
		_ => Err(Stop::ZshSub { text: BString::from(unmetafy(body)), here: false }),
	}
}

/// zsh `subst_string_by_func`'s call of hook function code `call` (raw zsh
/// source, metafied) in the current shell: its status, once it has run (the
/// first pass parks the op, [`Stop::ZshSub`] with `here`; the replay reads
/// the logged status). The caller's `$?` is kept.
pub(super) fn call_here(ex: &mut Expander<'_, '_>, call: &[u8]) -> X<i32> {
	let atom = if ex.record {
		replay(ex)
	} else {
		let a = ex.log.get(ex.cursor).cloned();
		ex.cursor += usize::from(a.is_some());
		a
	};
	match atom {
		Some(Atom::Sub { status, .. }) => Ok(status),
		_ => Err(Stop::ZshSub { text: BString::from(unmetafy(call)), here: true }),
	}
}

/// zsh `callmathfunc`'s call of a user math function's shell function
/// ([`MathCall`](crate::bash::vm::expand::MathCall)) in the current
/// shell: what it logged (its value's text and status) once it has run;
/// the first pass parks the op ([`Stop::MathCall`]).
pub(super) fn call_math(
	ex: &mut Expander<'_, '_>,
	call: crate::bash::vm::expand::MathCall,
) -> X<(BString, i32)> {
	let atom = if ex.record {
		replay(ex)
	} else {
		let a = ex.log.get(ex.cursor).cloned();
		ex.cursor += usize::from(a.is_some());
		a
	};
	match atom {
		Some(Atom::Sub { out, status }) => Ok((out, status)),
		_ => Err(Stop::MathCall(Box::new(call))),
	}
}

/// zsh `readoutput`'s processing of a substitution's output: trailing
/// newlines removed, metafied; quoted one word (a `Nularg` when empty),
/// else split at `IFS`.
fn readoutput(ex: &mut Expander<'_, '_>, out: &[u8], qt: bool) -> X<Vec<Vec<u8>>> {
	let mut end = out.len();
	while end > 0 && at(out, end - 1) == b'\n' {
		end -= 1;
	}
	let buf = metafy(head(out, end));
	if qt {
		return Ok(vec![if buf.is_empty() { vec![NULARG] } else { buf }]);
	}
	let seps = params::seps(ex)?;
	Ok(text::spacesplit(&seps, &buf, false))
}

/// The options [`text::quotestring`] reads.
pub(super) fn quote_opts(ex: &mut Expander<'_, '_>) -> X<text::QuoteOpts> {
	let (bang, bang_special) = params::bang_quoting(&mut ex.k.root, ex.cx.store, ex.vp);
	Ok(text::QuoteOpts {
		rcquotes: opt(ex, ZshOpt::Rcquotes)?,
		magic_equal_subst: opt(ex, ZshOpt::Magicequalsubst)?,
		extended_glob: opt(ex, ZshOpt::Extendedglob)?,
		bang,
		bang_special,
		mb: params::mb(ex)?,
	})
}

/// zsh `parse_subst_string`: `s` tokenized as an unquoted word
/// ([`crate::bash::syntax::zsh::parse_subst_string`]), its `$'…'` quotes
/// decoded in place; `Err` with the lexer's first message, if any, when
/// it does not lex. The `(Q)` flag, the `:s` modifier and pattern
/// operators read their text through it.
pub(super) fn parse_subst_string(s: &[u8]) -> Result<Vec<u8>, Option<Vec<u8>>> {
	let v = crate::bash::syntax::zsh::parse_subst_string(s)?;
	if !v.windows(2).any(|w| w == [STRING, SNULL]) {
		return Ok(v);
	}
	let mut out = Vec::with_capacity(v.len());
	let mut i = 0;
	while i < v.len() {
		if at(&v, i) == STRING && v.get(i + 1) == Some(&SNULL) {
			let k = text::getkeystring(tail(&v, i + 2), text::getkey::DOLLARS_QUOTE);
			out.extend_from_slice(&k.text);
			i += 2 + k.consumed;
		} else {
			out.push(at(&v, i));
			i += 1;
		}
	}
	Ok(out)
}

// ---- prefork -------------------------------------------------------------

/// zsh `keyvalpairelement`: `[key]=value` (or `[key]+=value`) at node
/// `n` becomes three nodes, `Marker` (`Marker+`), key, value, each
/// substituted; the index of the value node.
fn keyvalpairelement(ex: &mut Expander<'_, '_>, list: &mut List, n: usize) -> X<Option<usize>> {
	let start = list.node(n);
	if start.first() != Some(&INBRACK) {
		return Ok(None);
	}
	let Some(end) = tail(start, 1)
		.iter()
		.position(|&c| c == OUTBRACK)
		.map(|e| e + 1)
	else {
		return Ok(None);
	};
	let plus = at(start, end + 1) == b'+' && at(start, end + 2) == EQUALS;
	if at(start, end + 1) != EQUALS && !plus {
		return Ok(None);
	}
	let key = span(start, 1, end).to_vec();
	let value = tail(start, end + if plus { 3 } else { 2 }).to_vec();
	let mut key = singsub(ex, key)?;
	untokenize(&mut key);
	let mut value = singsub(ex, value)?;
	untokenize(&mut value);
	list.set(
		n,
		if plus {
			vec![MARKER, b'+']
		} else {
			vec![MARKER]
		},
	);
	list.insert(n + 1, key);
	list.insert(n + 2, value);
	Ok(Some(n + 2))
}

/// zsh `prefork`: substitutions before filename generation, on every word
/// of `list`: process substitution, parameters, commands, arithmetic,
/// then quote-null removal, brace expansion, and `~`/`=` expansion; empty
/// words removed unless `PREFORK_SINGLE`.
///
/// # Errors
/// Any substitution error; [`Stop::ZshSub`] parks for a command
/// substitution.
pub fn prefork(
	ex: &mut Expander<'_, '_>,
	list: &mut List,
	flags: u32,
	ret_flags: &mut u32,
) -> X<()> {
	let asssub = flags & PREFORK_TYPESET != 0 && opt(ex, ZshOpt::Kshtypeset)?;
	let shfileexp = opt(ex, ZshOpt::Shfileexpansion)?;
	let mut node = 0;
	while node < list.nodes.len() {
		if flags & (PREFORK_SINGLE | PREFORK_ASSIGN) == PREFORK_ASSIGN
			&& let Some(v) = keyvalpairelement(ex, list, node)?
		{
			node = v + 1;
			*ret_flags |= PREFORK_KEY_VALUE;
			continue;
		}
		if shfileexp {
			let mut w = list.take(node);
			filesub(ex, &mut w, flags & (PREFORK_TYPESET | PREFORK_ASSIGN))?;
			list.set(node, w);
			node += 1;
		} else if let Some(last) = stringsubst(
			ex,
			list,
			node,
			flags & !(PREFORK_TYPESET | PREFORK_ASSIGN),
			ret_flags,
			asssub,
		)? {
			node = last + 1;
		}
	}
	if shfileexp {
		let mut node = 0;
		while node < list.nodes.len() {
			if let Some(last) = stringsubst(
				ex,
				list,
				node,
				flags & !(PREFORK_TYPESET | PREFORK_ASSIGN),
				ret_flags,
				asssub,
			)? {
				node = last + 1;
			}
		}
	}
	let ignorebraces = opt(ex, ZshOpt::Ignorebraces)?;
	let braceccl = opt(ex, ZshOpt::Braceccl)?;
	let mut node = 0;
	let mut keep = false;
	let mut stop: Option<usize> = None;
	while node < list.nodes.len() {
		if Some(node) == stop {
			keep = false;
		}
		if list.node(node).is_empty() {
			if flags & PREFORK_SINGLE == 0 && *ret_flags & PREFORK_KEY_VALUE == 0 && !keep {
				list.remove(node);
				if let Some(s) = stop.as_mut()
					&& *s > node
				{
					*s -= 1;
				}
				continue;
			}
			node += 1;
			continue;
		}
		if let Some(w) = list.nodes.get_mut(node) {
			crate::bash::pattern::zsh::remnulargs(w);
		}
		if !ignorebraces && flags & PREFORK_SINGLE == 0 {
			if !keep {
				stop = Some(node + 1);
			}
			while list
				.nodes
				.get_mut(node)
				.is_some_and(|w| brace::hasbraces(w, braceccl))
			{
				keep = true;
				let words = brace::xpandbraces(list.node(node), braceccl);
				let added = words.len();
				list.nodes.splice(node..=node, words);
				if let Some(s) = stop.as_mut() {
					*s = *s + added - 1;
				}
				if added == 0 {
					break;
				}
			}
		}
		if node < list.nodes.len() && !shfileexp {
			let mut w = list.take(node);
			filesub(ex, &mut w, flags & (PREFORK_TYPESET | PREFORK_ASSIGN))?;
			list.set(node, w);
		}
		node += 1;
	}
	Ok(())
}

/// zsh `stringsubstquote`: `$'…'` at `pos` (the `String Snull`) of `w`
/// decoded in place; the position after the decoded text. `posix`
/// (`POSIX_STRINGS`): an embedded NUL ends the decoded text. `narrow`: the
/// locale is `C`, `\u` above 127 is zsh's `character not in range`.
fn stringsubstquote(w: &mut Vec<u8>, pos: usize, posix: bool, narrow: bool) -> X<usize> {
	let mut how = if posix {
		text::getkey::DOLLARS_QUOTE | text::getkey::POSIX_STRINGS
	} else {
		text::getkey::DOLLARS_QUOTE
	};
	if narrow {
		how |= text::getkey::NARROW;
	}
	let k = text::getkeystring(tail(w, pos + 2), how);
	if k.range_err {
		return Err(zerr("character not in range"));
	}
	let len = k.consumed + 2;
	let rest = tail(w, pos + len).to_vec();
	let mut sub = k.text;
	if pos == 0 && rest.is_empty() && sub.is_empty() {
		// A `$''` is not elided.
		sub = vec![NULARG];
	}
	let after = pos + sub.len();
	w.truncate(pos);
	w.extend_from_slice(&sub);
	w.extend_from_slice(&rest);
	Ok(after)
}

/// zsh `stringsubst`: the substitutions in node `n` of `list` (which may
/// become several nodes). The index of the last node it produced, `None`
/// when the node was removed.
#[allow(clippy::many_single_char_names, reason = "a direct port of zsh's stringsubst")]
fn stringsubst(
	ex: &mut Expander<'_, '_>,
	list: &mut List,
	n: usize,
	pf_flags: u32,
	ret_flags: &mut u32,
	asssub: bool,
) -> X<Option<usize>> {
	let mut pf_flags = pf_flags;
	let mut n = n;
	// Process substitutions first.
	let mut i = 0;
	while i < list.node(n).len() {
		let w = list.node(n);
		let c = at(w, i);
		if (c == INANG || c == OUTANGPROC || (i == 0 && c == EQUALS)) && at(w, i + 1) == INPAR {
			let mut j = i + 1;
			if !text::skipparens(INPAR, OUTPAR, w, &mut j) {
				// zsh `parsecmd`: no closing parenthesis.
				let op = match c {
					INANG => '<',
					OUTANGPROC => '>',
					_ => '=',
				};
				return Err(zerr(format!("unterminated `{op}(...)'")));
			}
			let body = span(w, i + 2, j - 1).to_vec();
			let path = procsubst(ex, c, &body)?;
			let mut nw = head(w, i).to_vec();
			nw.extend_from_slice(&path);
			let after = nw.len();
			nw.extend_from_slice(tail(w, j));
			list.set(n, nw);
			i = after;
		} else {
			i += 1;
		}
	}
	let mut i = 0;
	while i < list.node(n).len() {
		let c = at(list.node(n), i);
		let qt = c == QSTRING;
		if qt || c == STRING {
			let c1 = at(list.node(n), i + 1);
			if c1 == INPAR || c1 == INPARMATH {
				if !qt {
					list.array = true;
				}
				let (nn, pos) = comsubst(ex, list, n, i, qt, pf_flags)?;
				n = nn;
				i = pos;
				continue;
			} else if c1 == INBRACK {
				let w = list.node(n);
				let mut j = i + 1;
				if !text::skipparens(INBRACK, OUTBRACK, w, &mut j) {
					return Err(zerr("closing bracket missing"));
				}
				let expr = span(w, i + 2, j - 1).to_vec();
				let rest = tail(w, j).to_vec();
				let prefix = head(w, i).to_vec();
				let val = arithsubst(ex, expr)?;
				let mut nw = prefix;
				nw.extend_from_slice(&val);
				let after = nw.len();
				nw.extend_from_slice(&rest);
				list.set(n, nw);
				i = after;
				continue;
			} else if c1 == SNULL {
				let posix = opt(ex, ZshOpt::Posixstrings)?;
				let narrow = crate::bash::vm::locale::charset(ex.k, ex.cx.store, ex.vp)
					== crate::bash::vm::locale::Charset::Bytes;
				let mut w = list.take(n);
				let r = stringsubstquote(&mut w, i, posix, narrow);
				list.set(n, w);
				i = r?;
				continue;
			}
			if (opt(ex, ZshOpt::Shwordsplit)? && pf_flags & PREFORK_NOSHWORDSPLIT == 0)
				|| pf_flags & PREFORK_SPLIT != 0
			{
				pf_flags |= PREFORK_SHWORDSPLIT;
			}
			let r = paramsubst(
				ex,
				list,
				n,
				i,
				qt,
				pf_flags & (PREFORK_SINGLE | PREFORK_SHWORDSPLIT | PREFORK_SUBEXP),
				ret_flags,
			)?;
			match r {
				Some((nn, pos)) => {
					n = nn;
					i = pos;
				},
				None => return Ok(None),
			}
			continue;
		} else if c == QTICK || c == TICK {
			if c == TICK {
				list.array = true;
			}
			let (nn, pos) = comsubst(ex, list, n, i, c == QTICK, pf_flags)?;
			n = nn;
			i = pos;
			continue;
		} else if asssub && (c == b'=' || c == EQUALS) && i != 0 {
			pf_flags |= PREFORK_SINGLE;
		}
		i += 1;
	}
	Ok(Some(n))
}

/// The command (or math) substitution starting at `list.nodes[n][i]`
/// (`$(`, `$((`, or a backquote): the node with the output spliced in
/// (several nodes when unquoted output splits) and where scanning goes on.
#[allow(clippy::many_single_char_names, reason = "a direct port of zsh's comsubst")]
fn comsubst(
	ex: &mut Expander<'_, '_>,
	list: &mut List,
	n: usize,
	i: usize,
	qt: bool,
	pf_flags: u32,
) -> X<(usize, usize)> {
	let w = list.node(n).to_vec();
	let c = at(&w, i);
	let mut j = i + 1;
	let (body, end, paren) = if c == STRING || c == QSTRING {
		if at(&w, i + 1) == INPARMATH {
			let mut depth = 1;
			while depth > 0 && j < w.len() {
				j += 1;
				match at(&w, j) {
					OUTPARMATH => depth -= 1,
					INPARMATH => depth += 1,
					_ => {},
				}
			}
			if at(&w, j) != OUTPARMATH {
				return Err(zerr("failed to find end of math substitution"));
			}
			// `$((e))` is `String Inparmath ( e ) Outparmath`.
			let inner = span(&w, i + 2, j);
			let inner = inner
				.strip_prefix(b"(")
				.and_then(|x| x.strip_suffix(b")"))
				.unwrap_or(inner)
				.to_vec();
			let val = if opt(ex, ZshOpt::Exec)? {
				arithsubst(ex, inner)?
			} else {
				Vec::new()
			};
			let mut nw = head(&w, i).to_vec();
			nw.extend_from_slice(&val);
			let after = nw.len();
			nw.extend_from_slice(tail(&w, j + 1));
			list.set(n, nw);
			return Ok((n, after));
		}
		text::skipparens(INPAR, OUTPAR, &w, &mut j);
		(span(&w, i + 2, j.saturating_sub(1).max(i + 2)).to_vec(), j, true)
	} else {
		while j < w.len() && at(&w, j) != c {
			j += 1;
		}
		if j >= w.len() {
			return Err(zerr("failed to find end of command substitution"));
		}
		(span(&w, i + 1, j).to_vec(), j + 1, false)
	};
	// The body is re-parsed: untokenize it, except the `Bnull`s a
	// backquoted body keeps before `$ \ `` (and `"` when quoted). zsh's
	// input reader (`ingetc`) skips the token bytes left (those and
	// `Nularg`s), so they are dropped here.
	let mut b = Vec::with_capacity(body.len());
	let mut k = 0;
	while k < body.len() {
		let ch = at(&body, k);
		if is_tok(ch)
			&& ch != NULARG
			&& !(!paren
				&& ch == BNULL
				&& (matches!(at(&body, k + 1), b'$' | b'\\' | b'`')
					|| (qt && at(&body, k + 1) == b'"')))
		{
			b.push(tok_char(ch).unwrap_or(ch));
		} else if !is_tok(ch) && ch != NULARG {
			b.push(ch);
		}
		k += 1;
	}
	let out = getoutput(ex, &b)?;
	let mut words = readoutput(ex, &out, qt || pf_flags & PREFORK_SINGLE != 0)?;
	let prefix = head(&w, i).to_vec();
	let rest = tail(&w, end).to_vec();
	if words.is_empty() {
		let mut nw = prefix;
		let after = nw.len();
		nw.extend_from_slice(&rest);
		list.set(n, nw);
		return Ok((n, after));
	}
	let globsubst = !qt && pf_flags & PREFORK_SINGLE != 0 && opt(ex, ZshOpt::Globsubst)?;
	let shglob = opt(ex, ZshOpt::Shglob)?;
	if globsubst && let Some(w) = words.first_mut() {
		crate::bash::pattern::zsh::shtokenize(w, shglob);
	}
	let first = words.remove(0);
	if words.is_empty() {
		let mut nw = prefix;
		nw.extend_from_slice(&first);
		let after = nw.len();
		nw.extend_from_slice(&rest);
		list.set(n, nw);
		return Ok((n, after));
	}
	let mut nw = prefix;
	nw.extend_from_slice(&first);
	list.set(n, nw);
	let mut last = words.pop().unwrap_or_default();
	let count = words.len();
	for (k, mid) in words.into_iter().enumerate() {
		list.insert(n + 1 + k, mid);
	}
	let ln = n + 1 + count;
	let after = last.len();
	last.extend_from_slice(&rest);
	list.insert(ln, last);
	Ok((ln, after))
}

/// `<(…)`, `>(…)`, `=(…)`: the path the substitution's body is reachable
/// at.
fn procsubst(ex: &mut Expander<'_, '_>, c: u8, body: &[u8]) -> X<Vec<u8>> {
	let mut b = body.to_vec();
	untokenize(&mut b);
	let kind = match c {
		INANG => crate::bash::vm::exec::ZshProcSub::Input,
		OUTANGPROC => crate::bash::vm::exec::ZshProcSub::Output,
		_ => return getoutputfile(ex, &b),
	};
	if let Some(Atom::Str(Some(p))) = replay(ex) {
		return Ok(metafy(&p));
	}
	let p = crate::bash::vm::exec::start_zsh_procsub(ex.k, ex.vp, ex.cx, &unmetafy(&b), kind);
	note(ex, || Atom::Str(Some(p.clone())));
	Ok(metafy(&p))
}

/// The logged answer of the file system request `req` (the first pass
/// parks the op, [`Stop::Probe`]): `Some` on success. `seq` is the log
/// position, so the same request made again later is asked again.
fn fs_request(
	ex: &mut Expander<'_, '_>,
	req: crate::bash::vm::fsprobe::FsReq,
) -> X<Option<BString>> {
	let seq = u32::try_from(ex.cursor).unwrap_or(u32::MAX);
	match ex.log.get(ex.cursor).cloned() {
		Some(Atom::Str(s)) => {
			ex.cursor += 1;
			Ok(s)
		},
		Some(_) => {
			ex.cursor += 1;
			Ok(None)
		},
		None => Err(Stop::Probe(crate::bash::vm::proc::Probe::Fs { seq, req: Box::new(req) })),
	}
}

/// zsh `getoutputfile`: `=(…)`, the output of `body` (raw zsh source,
/// metafied) in a new file `$TMPPREFIX` plus six letters (zsh
/// `gettempname`, a name nothing has), linked to the name plus
/// `$TMPSUFFIX` when that is set, mode 0600; its name. A body that is a
/// lone `<<<word` writes the word and a newline without running anything.
/// The files go when the command is over (zsh's job `filelist`). `$?`
/// stays (zsh's `cmdoutval` is 0).
fn getoutputfile(ex: &mut Expander<'_, '_>, body: &[u8]) -> X<Vec<u8>> {
	use crate::bash::vm::fsprobe::FsReq;
	/// mktemp's letters.
	const LETTERS: &[u8; 62] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
	let raw = unmetafy(body);
	let data = if let Some(word) = crate::bash::syntax::zsh::herestring_word(&raw) {
		let tokenized = parse_subst_string(&metafy(&word)).unwrap_or_else(|_| metafy(&word));
		let mut s = singsub(ex, tokenized)?;
		untokenize(&mut s);
		let mut s = unmetafy(&s);
		s.push(b'\n');
		s
	} else {
		let (status, sub_status) = (ex.vp.status, ex.sub_status);
		let out = getoutput(ex, body)?;
		ex.vp.status = status;
		ex.sub_status = sub_status.map(|_| 0);
		out
	};
	let prefix = params::getsparam(ex, b"TMPPREFIX")?.unwrap_or_else(|| BString::from("/tmp/zsh"));
	let pid = u64::from(ex.k.shell_pid);
	let mut name = None;
	for n in 0..64u64 {
		let mut h = ((pid << 32) | n).wrapping_mul(0x9e37_79b9_7f4a_7c15);
		let mut path = prefix.clone();
		for _ in 0..6 {
			path.push(LETTERS[(h % 62) as usize]);
			h /= 62;
		}
		if fs_request(ex, FsReq::Stat { path: path.clone(), follow: false })?.is_none() {
			name = Some(path);
			break;
		}
	}
	let Some(path) = name else {
		return Err(Stop::Fail(Diag::Usage {
			msg: "process substitution failed: file exists".into(),
		}));
	};
	if fs_request(ex, FsReq::MapWrite { path: path.clone(), data: data.into(), mode: 0o600 })?
		.is_none()
	{
		// The request's answer has no `errno`: the usual causes, from the
		// directory.
		let dir = match path.iter().rposition(|&c| c == b'/') {
			Some(0) => BString::from("/"),
			Some(i) => BString::from(&path[..i]),
			None => BString::from("."),
		};
		let why = match fs_request(ex, FsReq::Stat { path: dir, follow: true })? {
			None => "no such file or directory",
			Some(_) => "permission denied",
		};
		return Err(Stop::Fail(Diag::Usage {
			msg: format!("process substitution failed: {why}").into(),
		}));
	}
	let depth = u32::try_from(ex.vp.frames.len()).unwrap_or(u32::MAX);
	let keep = |ex: &mut Expander<'_, '_>, p: &BString| {
		let files = &mut ex.vp.zsh.get_or_insert_with(Box::default).tempfiles;
		if !files.iter().any(|(_, q)| q == p) {
			files.push((depth, p.clone()));
		}
	};
	keep(ex, &path);
	let mut nam = path;
	if let Some(suffix) = params::getsparam(ex, b"TMPSUFFIX")?
		&& !suffix.is_empty()
		&& !suffix.contains(&b'/')
	{
		let mut linked = nam.clone();
		linked.extend_from_slice(&suffix);
		if fs_request(ex, FsReq::Link { from: nam.clone(), to: linked.clone() })?.is_some() {
			keep(ex, &linked);
			nam = linked;
		}
	}
	Ok(metafy(&nam))
}

/// zsh `arithsubst`: `$((e))` / `$[e]`: `e` substituted, evaluated, and
/// printed in the expression's output base (logged: evaluated once
/// across replays).
fn arithsubst(ex: &mut Expander<'_, '_>, e: Vec<u8>) -> X<Vec<u8>> {
	let e = singsub(ex, e)?;
	once(ex, |ex| Ok(arith::matheval_text(ex, &e)?.to_vec()))
}

/// zsh `singsub`: substitute one word that stays one word (the result
/// keeps its tokens).
///
/// # Errors
/// As [`prefork`].
pub fn singsub(ex: &mut Expander<'_, '_>, s: Vec<u8>) -> X<Vec<u8>> {
	let mut l = List::one(s);
	let mut rf = 0;
	prefork(ex, &mut l, PREFORK_SINGLE, &mut rf)?;
	Ok(l.nodes.into_iter().next().unwrap_or_default())
}

/// What [`multsub`] produced.
struct MultSub {
	/// The expansion was empty (no words).
	empty: bool,
	/// Scalar value (joined when an array was not wanted).
	val:   Vec<u8>,
	/// Array value when one was wanted and produced.
	arr:   Option<Vec<Vec<u8>>>,
	/// zsh's `isarr` result.
	isarr: i32,
}

/// zsh `multsub`: substitute `s`, which may produce several words; with
/// `want_arr` an array result comes back as one, otherwise words are
/// joined with `sep` (`IFS` when `None`).
#[allow(clippy::many_single_char_names, reason = "a direct port of zsh's multsub")]
fn multsub(
	ex: &mut Expander<'_, '_>,
	s: Vec<u8>,
	pf_flags: u32,
	want_arr: bool,
	sep: Option<&[u8]>,
	ms_flags: &mut u32,
) -> X<MultSub> {
	let mut x = s;
	let mut list = List::default();
	if pf_flags & PREFORK_SPLIT != 0 {
		let seps = params::seps(ex)?;
		let mut i = 0;
		while i < x.len() {
			let c = text::char_at(&x, i);
			if !seps.iwsep(c) {
				break;
			}
			*ms_flags |= MULTSUB_WS_AT_START;
			i += text::charlen(&x, i, false);
		}
		x.drain(..i);
		let (mut inq, mut inp) = (false, 0i32);
		let mut start = 0;
		let mut i = 0;
		while i < x.len() {
			let ch = match x.get_mut(i) {
				Some(c) if *c == DASH => {
					*c = b'-';
					b'-'
				},
				Some(c) => *c,
				None => 0,
			};
			let mut l = 1;
			if is_tok(ch) {
				match ch {
					DNULL | SNULL | TICK => inq = !inq,
					INPAR => inp += 1,
					OUTPAR => inp -= 1,
					BNULL | BNULLKEEP => {
						l += seps.charlen(&x, i + 1);
					},
					_ => {},
				}
				i += l;
				continue;
			}
			l = seps.charlen(&x, i);
			if !inq && inp == 0 && seps.sep_at(&x, i) {
				list.nodes.push(span(&x, start, i).to_vec());
				let mut j = i + l;
				while j < x.len() && seps.sep_at(&x, j) {
					j += seps.charlen(&x, j);
				}
				if j >= x.len() {
					*ms_flags |= MULTSUB_WS_AT_END;
					start = x.len();
					break;
				}
				start = j;
				i = j;
				continue;
			}
			i += l;
		}
		if start < x.len() || list.nodes.is_empty() {
			list.nodes.push(tail(&x, start).to_vec());
		}
	} else {
		list.nodes.push(x);
	}
	prefork(ex, &mut list, pf_flags, ms_flags)?;
	let l = list.nodes.len();
	if l > 1 || (list.array && want_arr) {
		if want_arr {
			return Ok(MultSub { empty: false, val: Vec::new(), arr: Some(list.nodes), isarr: 1 });
		}
		let ifs = params::ifs(ex)?;
		let val = text::sepjoin(&list.nodes, sep, ifs.as_deref(), params::mb(ex)?);
		return Ok(MultSub { empty: false, val, arr: None, isarr: 0 });
	}
	let val = list.nodes.into_iter().next().unwrap_or_default();
	Ok(MultSub { empty: l == 0, val, arr: None, isarr: 0 })
}

// ---- ~ and = -----------------------------------------------------------

/// zsh `filesub`: `~`/`=` at the start of `s`, and with `assign` after
/// `:` (and the first `=` for `PREFORK_TYPESET`).
///
/// # Errors
/// `no such user or named directory`, `X not found` under `nomatch`.
pub fn filesub(ex: &mut Expander<'_, '_>, s: &mut Vec<u8>, assign: u32) -> X<()> {
	filesubstr(ex, s, assign)?;
	if assign == 0 {
		return Ok(());
	}
	let mut eql = None;
	if assign & PREFORK_TYPESET != 0 {
		match s
			.get(1..)
			.and_then(|t| t.iter().position(|&c| c == EQUALS))
			.map(|p| p + 1)
		{
			Some(e) => {
				eql = Some(e);
				if matches!(at(s, e + 1), TILDE | EQUALS) {
					let mut rest = tail(s, e + 1).to_vec();
					if filesubstr(ex, &mut rest, assign)? {
						s.truncate(e + 1);
						s.extend_from_slice(&rest);
					}
				}
			},
			None => return Ok(()),
		}
	}
	let mut from = 0;
	while let Some(p) = tail(s, from)
		.iter()
		.position(|&c| c == b':')
		.map(|p| p + from)
	{
		if eql.is_none_or(|e| p > e) && matches!(at(s, p + 1), TILDE | EQUALS) {
			let mut rest = tail(s, p + 1).to_vec();
			if filesubstr(ex, &mut rest, assign)? {
				s.truncate(p + 1);
				s.extend_from_slice(&rest);
			}
		}
		from = p + 1;
	}
	Ok(())
}

/// zsh `filesubstr`: `~…` or `=cmd` at the start of `s`; whether it was
/// replaced.
pub fn filesubstr(ex: &mut Expander<'_, '_>, s: &mut Vec<u8>, assign: u32) -> X<bool> {
	let isend = |c: u8| c == 0 || c == b'/' || c == INPAR || (assign != 0 && c == b':');
	let isend2 = |c: u8| c == 0 || c == INPAR || (assign != 0 && c == b':');
	if at(s, 0) == TILDE && at(s, 1) != b'=' && at(s, 1) != EQUALS {
		if let Some(c) = s.get_mut(1).filter(|c| **c == DASH) {
			*c = b'-';
		}
		let c1 = at(s, 1);
		if isend(c1) {
			let home = state::lookup(&ex.k.root, ex.cx.store, ex.vp, b"HOME")?
				.and_then(|v| v.as_scalar().map(<[u8]>::to_vec))
				.unwrap_or_default();
			let mut r = metafy(&home);
			r.extend_from_slice(tail(s, 1));
			*s = r;
			return Ok(true);
		}
		if c1 == b'+' && isend(at(s, 2)) {
			let mut r = metafy(&ex.vp.cwd);
			r.extend_from_slice(tail(s, 2));
			*s = r;
			return Ok(true);
		}
		if c1 == b'-' && isend(at(s, 2)) {
			let old = state::lookup(&ex.k.root, ex.cx.store, ex.vp, b"OLDPWD")?
				.and_then(|v| v.as_scalar().map(<[u8]>::to_vec))
				.unwrap_or_else(|| ex.vp.cwd.to_vec());
			let mut r = metafy(&old);
			r.extend_from_slice(tail(s, 2));
			*s = r;
			return Ok(true);
		}
		// `~[arg]`: the `zsh_directory_name` hook names the directory.
		if c1 == INBRACK
			&& let Some(close) = tail(s, 2)
				.iter()
				.position(|&c| c == OUTBRACK)
				.map(|p| p + 2)
		{
			let mut arg = span(s, 2, close).to_vec();
			untokenize(&mut arg);
			crate::bash::pattern::zsh::remnulargs(&mut arg);
			let arg = unmetafy(&arg);
			let res =
				super::nameddir::dirname_hook(ex, b"n", &arg)?.and_then(|a| a.into_iter().next());
			if let Some(res) = res {
				let mut r = metafy(&res);
				r.extend_from_slice(tail(s, close + 1));
				*s = r;
				return Ok(true);
			}
			if opt(ex, ZshOpt::Nomatch)? && opt(ex, ZshOpt::Exec)? {
				return Err(Stop::Fail(Diag::ZshFileExp {
					msg: BString::from(format!("no directory expansion: ~[{}]", BStr::new(&arg))),
				}));
			}
			return Ok(false);
		}
		// `~N`, `~+N`, `~-N`: directory stack entries.
		let (sign, ds) = if matches!(c1, b'+' | b'-') {
			(Some(c1), 2)
		} else {
			(None, 1)
		};
		let de = ds
			+ tail(s, ds)
				.iter()
				.take_while(|c| c.is_ascii_digit())
				.count();
		if de > ds && isend(at(s, de)) && (sign.is_some() || de - ds < 4 || ds == 2) {
			let val: usize = std::str::from_utf8(span(s, ds, de))
				.ok()
				.and_then(|d| d.parse().ok())
				.unwrap_or(0);
			let Some(dir) = dstackent(ex, sign.unwrap_or(b'+'), val)? else {
				return Ok(false);
			};
			let mut r = metafy(&dir);
			r.extend_from_slice(tail(s, de));
			*s = r;
			return Ok(true);
		}
		let ue = text::user_end(s, 1);
		if ue != 1 {
			if !isend(at(s, ue)) {
				return Ok(false);
			}
			let mut user = span(s, 1, ue).to_vec();
			untokenize(&mut user);
			if let Some(dir) = super::nameddir::getnameddir(ex, &unmetafy(&user))? {
				let mut r = metafy(&dir);
				r.extend_from_slice(tail(s, ue));
				*s = r;
				return Ok(true);
			}
			if opt(ex, ZshOpt::Nomatch)? && opt(ex, ZshOpt::Exec)? {
				return Err(Stop::Fail(Diag::ZshFileExp {
					msg: BString::from(format!(
						"no such user or named directory: {}",
						BStr::new(&unmetafy(&user))
					)),
				}));
			}
			return Ok(false);
		}
	} else if at(s, 0) == EQUALS && opt(ex, ZshOpt::Equals)? && s.len() > 1 && at(s, 1) != INPAR {
		let mut pp = 1;
		while !isend2(at(s, pp)) {
			pp += 1;
		}
		let nomatch = opt(ex, ZshOpt::Nomatch)?;
		if let Some(exp) = equalsubstr(ex, span(s, 1, pp), assign != 0, nomatch)? {
			let mut r = exp;
			r.extend_from_slice(tail(s, pp));
			*s = r;
			return Ok(true);
		}
	}
	Ok(false)
}

/// zsh `dstackent`: directory stack entry `val` counted from the top
/// (`+`) or the bottom (`-`), swapped under `pushdminus`; entry 0 from
/// the top is the current directory.
fn dstackent(ex: &mut Expander<'_, '_>, ch: u8, val: usize) -> X<Option<Vec<u8>>> {
	let backwards = ch
		== if opt(ex, ZshOpt::Pushdminus)? {
			b'+'
		} else {
			b'-'
		};
	let mut stack = crate::bash::vm::builtins::dirstack::dirstack_value(ex.cx.store, ex.vp)?;
	let pwd = stack.remove(0);
	let r = if backwards {
		match val.cmp(&stack.len()) {
			std::cmp::Ordering::Less => stack.get(stack.len() - 1 - val).map(|d| d.to_vec()),
			std::cmp::Ordering::Equal => Some(pwd.to_vec()),
			std::cmp::Ordering::Greater => None,
		}
	} else if val == 0 {
		Some(pwd.to_vec())
	} else {
		stack.get(val - 1).map(|d| d.to_vec())
	};
	if r.is_none() && opt(ex, ZshOpt::Nomatch)? {
		return Err(Stop::Fail(Diag::ZshFileExp {
			msg: BString::from("not enough directory stack entries."),
		}));
	}
	Ok(r)
}

/// zsh `findcmd`'s search for `=cmd`: the external `name` over `$PATH` =
/// `path` (a name with a `/` is itself when executable), through the
/// pollable file system. The first pass parks the op ([`Stop::Probe`]);
/// the replay reads the logged answer. Raw bytes.
pub fn findcmd(ex: &mut Expander<'_, '_>, name: &[u8], path: &[u8]) -> X<Option<Vec<u8>>> {
	use crate::bash::vm::proc::Probe;
	let atom = if ex.record {
		replay(ex)
	} else {
		let a = ex.log.get(ex.cursor).cloned();
		ex.cursor += usize::from(a.is_some());
		a
	};
	let slash = name.contains(&b'/');
	if let Some(Atom::Str(found)) = atom {
		return Ok(found.map(|p| if slash { name.to_vec() } else { p.to_vec() }));
	}
	Err(Stop::Probe(if slash {
		Probe::Access { path: crate::bash::vm::probe::absolute(&ex.vp.cwd, name), mode: 4 }
	} else {
		Probe::Path { name: BString::from(name), path: BString::from(path) }
	}))
}

/// zsh `equalsubstr`: `=cmd` (`s` is `cmd`, possibly followed by text
/// from a `(` or `:`): the command's path, from the command hash table or
/// the host's resolution.
///
/// # Errors
/// `CMD not found` when `nomatch`.
pub fn equalsubstr(
	ex: &mut Expander<'_, '_>,
	s: &[u8],
	assign: bool,
	nomatch: bool,
) -> X<Option<Vec<u8>>> {
	let end = s
		.iter()
		.position(|&c| c == INPAR || (assign && c == b':'))
		.unwrap_or(s.len());
	let mut cmd = head(s, end).to_vec();
	untokenize(&mut cmd);
	crate::bash::pattern::zsh::remnulargs(&mut cmd);
	let name = unmetafy(&cmd);
	let found = if let Some(crate::bash::store::Record::CmdHash { path, .. }) =
		state::record(ex.cx.store, ex.vp, crate::bash::store::Key::CmdHash(BStr::new(&name)))?
	{
		Some(path.to_vec())
	} else {
		let path_var = state::lookup(&ex.k.root, ex.cx.store, ex.vp, b"PATH")?
			.and_then(|v| v.as_scalar().map(BString::from))
			.unwrap_or_default();
		let why = crate::bash::host::ResolveCtx {
			has_slash: name.contains(&b'/'),
			via:       crate::bash::host::Via::Type,
		};
		match ex.cx.host.resolve(BStr::new(&name), ex.vp.mode, why) {
			crate::bash::host::Resolved::External(p) => Some(p.to_vec()),
			_ => findcmd(ex, &name, &path_var)?,
		}
	};
	match found {
		Some(p) => {
			let mut r = metafy(&p);
			r.extend_from_slice(tail(s, end));
			Ok(Some(r))
		},
		None if nomatch => Err(Stop::Fail(Diag::ZshFileExp {
			msg: BString::from(format!("{} not found", BStr::new(&name))),
		})),
		None => Ok(None),
	}
}

// ---- helpers of paramsubst ---------------------------------------------

/// zsh `get_intarg`: the delimited math argument at `s[*pos]`, evaluated
/// (its absolute value); `*pos` moves past the closing delimiter. Returns
/// `(value, delimiter length)`; `(-1, 0)` when malformed.
pub(super) fn get_intarg(ex: &mut Expander<'_, '_>, s: &[u8], pos: &mut usize) -> X<(i64, usize)> {
	let mb = params::mb(ex)?;
	let (t, arglen) = subscript::get_strarg(s, *pos, mb);
	if t >= s.len() {
		return Ok((-1, 0));
	}
	let start = (*pos + text::charlen(s, *pos, mb)).min(t);
	let p = span(s, start, t).to_vec();
	*pos = t + arglen;
	let Ok(p) = crate::bash::syntax::zsh::parsestr(&p) else {
		return Ok((-1, 0));
	};
	let p = singsub(ex, p)?;
	let r = arith::mathevali(ex, &p)?;
	Ok((r.abs(), arglen))
}

/// zsh `untok_and_escape`: a flag argument, `(p)` escapes and `$name`
/// references handled, re-tokenized under `(~)`.
fn untok_and_escape(
	ex: &mut Expander<'_, '_>,
	s: &[u8],
	escapes: bool,
	tok_arg: bool,
) -> X<Vec<u8>> {
	let mut dst = if escapes
		&& s.len() > 1
		&& matches!(at(s, 0), STRING | QSTRING)
		&& tail(s, 1).iter().all(|&c| text::iident(c))
	{
		params::getsparam(ex, &unmetafy(tail(s, 1)))?.map_or_default(|v| metafy(&v))
	} else {
		let mut d = s.to_vec();
		untokenize(&mut d);
		if escapes {
			d = metafy(&text::getkeystring(&d, text::getkey::SEP).text);
		}
		d
	};
	if tok_arg {
		let sh = opt(ex, ZshOpt::Shglob)?;
		crate::bash::pattern::zsh::shtokenize(&mut dst, sh);
	}
	Ok(dst)
}

/// What [`check_colon_subscript`] found after `${x:`.
enum ColonSub {
	/// The substituted offset text and the index after it (at a `:` or
	/// the end).
	Offset(Vec<u8>, usize),
	/// The text starts a modifier, or does not parse as an expression.
	Modifier,
	/// The text does not lex as a subscript: zsh's `parse_subscript` has
	/// untokenized it in place, so modifiers read it as plain text.
	Unlexed,
}

/// zsh `check_colon_subscript`: `${x:OFFSET…}` at the start of `s`.
fn check_colon_subscript(ex: &mut Expander<'_, '_>, s: &[u8]) -> X<ColonSub> {
	let c = at(s, 0);
	if c == 0 || c.is_ascii_alphabetic() || c == b'&' {
		return Ok(ColonSub::Modifier);
	}
	if c == b':' {
		return Ok(ColonSub::Offset(b"0".to_vec(), 0));
	}
	let Some(end) = subscript::parse_subscript_end(s, false, b':')
		.or_else(|| subscript::parse_subscript_end(s, false, 0))
	else {
		return Ok(ColonSub::Unlexed);
	};
	let end = end.min(s.len());
	let Ok(p) = crate::bash::syntax::zsh::parsestr(head(s, end)) else {
		return Ok(ColonSub::Modifier);
	};
	let mut p = singsub(ex, p)?;
	crate::bash::pattern::zsh::remnulargs(&mut p);
	untokenize(&mut p);
	Ok(ColonSub::Offset(p, end))
}

/// zsh `subst_parse_str` (`(e)`): re-tokenize a value for another round
/// of substitution; inside double quotes (`single`) `Qstring`/`Qtick`
/// stay quoted.
fn subst_parse_str(s: &[u8], single: bool) -> Option<Vec<u8>> {
	let mut p = crate::bash::syntax::zsh::parsestr(s).ok()?;
	if !single {
		let mut q = false;
		for c in &mut p {
			if !q {
				if *c == QSTRING {
					*c = STRING;
				} else if *c == QTICK {
					*c = TICK;
				}
			}
			if *c == DNULL {
				q = !q;
			}
		}
	}
	Some(p)
}

/// zsh `substevalchar` (`(#)`): the character with the value of `s`.
fn substevalchar(ex: &mut Expander<'_, '_>, s: &[u8]) -> X<Vec<u8>> {
	let v = arith::mathevali(ex, s)?;
	let mb =
		opt(ex, ZshOpt::Multibyte)? && crate::bash::vm::locale::is_utf8(ex.k, ex.cx.store, ex.vp);
	if mb
		&& v > 127
		&& let Some(c) = u32::try_from(v).ok().and_then(char::from_u32)
	{
		let mut buf = [0; 4];
		return Ok(metafy(c.encode_utf8(&mut buf).as_bytes()));
	}
	#[expect(
		clippy::cast_possible_truncation,
		clippy::cast_sign_loss,
		reason = "zsh prints (int)ires with %c"
	)]
	let b = v as u8;
	Ok(metafy(&[b]))
}

/// zsh `strcatsub`: `prefix` + `src` (shell-tokenized under `glbsub`) +
/// `rest`; the index `stringsubst` goes on scanning at: after `src`, but
/// 0 when `src` is the whole word, so tokens a value gained (`$a:s/x/$y/`)
/// are expanded as zsh does.
fn strcatsub(
	prefix: &[u8],
	src: &[u8],
	rest: &[u8],
	glbsub: bool,
	shglob: bool,
) -> (Vec<u8>, usize) {
	let mut d = Vec::with_capacity(prefix.len() + src.len() + rest.len());
	d.extend_from_slice(prefix);
	let s0 = d.len();
	d.extend_from_slice(src);
	if glbsub && let Some(added) = d.get_mut(s0..) {
		crate::bash::pattern::zsh::shtokenize(added, shglob);
	}
	let after = if prefix.is_empty() && rest.is_empty() {
		0
	} else {
		d.len()
	};
	d.extend_from_slice(rest);
	(d, after)
}

/// zsh `dopadding` (characters per `mb`, `(m)` widths equal counts).
#[expect(clippy::too_many_arguments, reason = "a faithful port of one C function")]
fn dopadding(
	s: &[u8],
	prenum: usize,
	postnum: usize,
	preone: Option<&[u8]>,
	postone: Option<&[u8]>,
	premul: &[u8],
	postmul: &[u8],
	ifs: Option<&[u8]>,
	mb: bool,
) -> Vec<u8> {
	let def: Vec<u8> = match ifs {
		None => b" ".to_vec(),
		Some(i) if !i.is_empty() => head(i, text::charlen(i, 0, mb)).to_vec(),
		Some(_) => Vec::new(),
	};
	let preone = preone.map(|p| if p.is_empty() { def.as_slice() } else { p });
	let postone = postone.map(|p| if p.is_empty() { def.as_slice() } else { p });
	let premul = if premul.is_empty() {
		def.as_slice()
	} else {
		premul
	};
	let postmul = if postmul.is_empty() {
		def.as_slice()
	} else {
		postmul
	};
	/// The characters of `x`.
	fn chars(x: &[u8], mb: bool) -> Vec<&[u8]> {
		let mut v = Vec::new();
		let mut i = 0;
		while i < x.len() {
			let l = text::charlen(x, i, mb);
			v.push(span(x, i, i + l));
			i += l;
		}
		v
	}
	/// Append the characters `cs`.
	fn put(out: &mut Vec<u8>, cs: &[&[u8]]) {
		for c in cs {
			out.extend_from_slice(c);
		}
	}
	let sc = chars(s, mb);
	let ls = sc.len();
	let pre1 = preone.map_or_default(|p| chars(p, mb));
	let post1 = postone.map_or_default(|p| chars(p, mb));
	let pm = chars(premul, mb);
	let qm = chars(postmul, mb);
	if prenum + postnum == ls {
		return s.to_vec();
	}
	let mut out: Vec<u8> = Vec::with_capacity(s.len());
	// The left padding of width `f` before the original characters.
	let left_pad = |f: usize, out: &mut Vec<u8>| {
		if f <= pre1.len() {
			if preone.is_some() {
				put(out, tail(&pre1, pre1.len() - f));
			}
		} else {
			let f = f - pre1.len();
			if !pm.is_empty() {
				let m = f % pm.len();
				if m > 0 {
					put(out, tail(&pm, pm.len() - m));
				}
				for _ in 0..f / pm.len() {
					put(out, &pm);
				}
			}
			put(out, &pre1);
		}
	};
	let right_pad = |f: usize, out: &mut Vec<u8>| {
		if f <= post1.len() {
			if postone.is_some() {
				put(out, head(&post1, f));
			}
		} else {
			let f = f - post1.len();
			put(out, &post1);
			if !qm.is_empty() {
				for _ in 0..f / qm.len() {
					put(out, &qm);
				}
				put(out, head(&qm, f % qm.len()));
			}
		}
	};
	if prenum > 0 {
		if postnum > 0 {
			let ls2 = ls / 2;
			if prenum <= ls2 {
				let skip = ls2 - prenum;
				put(&mut out, span(&sc, skip, ls2));
			} else {
				left_pad(prenum - ls2, &mut out);
				put(&mut out, head(&sc, ls2));
			}
			let rest = ls - ls2;
			if postnum <= rest {
				put(&mut out, span(&sc, ls2, ls2 + postnum));
			} else {
				put(&mut out, tail(&sc, ls2));
				right_pad(postnum - rest, &mut out);
			}
		} else if prenum <= ls {
			put(&mut out, tail(&sc, ls - prenum));
		} else {
			left_pad(prenum - ls, &mut out);
			put(&mut out, &sc);
		}
	} else if postnum > 0 {
		if postnum <= ls {
			put(&mut out, head(&sc, postnum));
		} else {
			put(&mut out, &sc);
			right_pad(postnum - ls, &mut out);
		}
	}
	out
}

/// zsh `eltpcmp`: `cmp0` is the strings' `strcoll` order (their
/// [`Collator`](crate::sys::langinfo::Collator) keys compared), which the
/// numeric rules may override.
#[allow(clippy::many_single_char_names, reason = "a direct port of zsh's eltpcmp")]
pub fn eltpcmp_coll(
	a: &[u8],
	b: &[u8],
	numeric: i32,
	cmp0: std::cmp::Ordering,
) -> std::cmp::Ordering {
	use std::cmp::Ordering;
	if numeric == 0 {
		return cmp0;
	}
	let mut i = 0;
	while i < a.len() && i < b.len() && at(a, i) == at(b, i) {
		i += 1;
	}
	let (mut ai, mut bi) = (i, i);
	let ca = |k: usize| a.get(k).copied().unwrap_or(0);
	let cb = |k: usize| b.get(k).copied().unwrap_or(0);
	let mut cmp = cmp0;
	let mut mul: i32 = 0;
	if numeric < 0 {
		if ca(ai) == b'-' && ca(ai + 1).is_ascii_digit() && cb(bi).is_ascii_digit() {
			cmp = Ordering::Less;
			mul = 1;
		} else if cb(bi) == b'-' && cb(bi + 1).is_ascii_digit() && ca(ai).is_ascii_digit() {
			cmp = Ordering::Greater;
			mul = 1;
		}
	}
	if mul == 0 && (ca(ai).is_ascii_digit() || cb(bi).is_ascii_digit()) {
		while ai > 0 && ca(ai - 1).is_ascii_digit() {
			ai -= 1;
			bi -= 1;
		}
		mul = if numeric < 0 && ai > 0 && ca(ai - 1) == b'-' {
			-1
		} else {
			1
		};
		if ca(ai).is_ascii_digit() && cb(bi).is_ascii_digit() {
			while ca(ai) == b'0' {
				ai += 1;
			}
			while cb(bi) == b'0' {
				bi += 1;
			}
			while ca(ai).is_ascii_digit() && ca(ai) == cb(bi) {
				ai += 1;
				bi += 1;
			}
			if ca(ai).is_ascii_digit() || cb(bi).is_ascii_digit() {
				let d = i32::from(ca(ai)) - i32::from(cb(bi));
				let c = (mul * d).cmp(&0);
				while ca(ai).is_ascii_digit() && cb(bi).is_ascii_digit() {
					ai += 1;
					bi += 1;
				}
				if ca(ai).is_ascii_digit() && !cb(bi).is_ascii_digit() {
					return if mul > 0 {
						Ordering::Greater
					} else {
						Ordering::Less
					};
				}
				if cb(bi).is_ascii_digit() && !ca(ai).is_ascii_digit() {
					return if mul > 0 {
						Ordering::Less
					} else {
						Ordering::Greater
					};
				}
				return c;
			}
		}
	}
	cmp
}

/// zsh `strmetasort`: sort metafied strings as `sortit` says (`(o) (O)
/// (i) (n) (-)`), in `coll`'s order (`strcoll`; bytes without one).
pub fn strmetasort(
	items: &mut [Vec<u8>],
	sortit: u32,
	coll: Option<&crate::sys::langinfo::Collator>,
) {
	let numeric = if sortit & SORTIT_NUMERICALLY_SIGNED != 0 {
		-1
	} else {
		i32::from(sortit & SORTIT_NUMERICALLY != 0)
	};
	let key = |s: &[u8]| -> Vec<u8> {
		let mut k = unmetafy(s);
		if sortit & SORTIT_IGNORING_CASE != 0 {
			k.make_ascii_lowercase();
		}
		if sortit & SORTIT_IGNORING_BACKSLASHES != 0 {
			k.retain(|&c| c != b'\\');
		}
		k
	};
	// (sort key, collation key, the string)
	let mut keyed: Vec<(Vec<u8>, Vec<u8>, Vec<u8>)> = items
		.iter()
		.map(|s| {
			let k = key(s);
			let c = coll.map_or_default(|c| c.key(&k));
			(k, c, s.clone())
		})
		.collect();
	keyed.sort_by(|x, y| {
		// Equal collation keys (`strcoll` 0) fall back to the bytes.
		let base = if coll.is_some() {
			x.1.cmp(&y.1).then_with(|| x.0.cmp(&y.0))
		} else {
			x.0.cmp(&y.0)
		};
		let o = eltpcmp_coll(&x.0, &y.0, numeric, base);
		if sortit & SORTIT_BACKWARDS != 0 {
			o.reverse()
		} else {
			o
		}
	});
	for (slot, (_, _, v)) in items.iter_mut().zip(keyed) {
		*slot = v;
	}
}

/// zsh `zhuniqarray`: drop repeated elements, keeping the first.
fn uniq(a: &mut Vec<Vec<u8>>) {
	let mut seen = hashbrown::HashSet::with_capacity(a.len());
	a.retain(|e| seen.insert(e.clone()));
}

/// zsh `wordcount` and character counts for `${#x}` with `(c) (w) (W)`.
fn count_len(seps: &text::Seps, v: &[u8], spsep: Option<&[u8]>, getlen: i32) -> usize {
	if getlen < 3 {
		text::strlen_chars(v, seps.mb)
	} else {
		text::wordcount(seps, v, spsep, i32::from(getlen > 3))
	}
}

/// zsh `substnamedir` (`(D)`): the longest named directory prefix as
/// `~name`, the rest backslash-quoted.
fn substnamedir(ex: &mut Expander<'_, '_>, s: &[u8]) -> X<Vec<u8>> {
	let raw = unmetafy(s);
	let o = quote_opts(ex)?;
	Ok(match super::nameddir::finddir(ex, &raw)? {
		Some(f) => {
			let mut r = vec![b'~'];
			r.extend_from_slice(&metafy(&f.name));
			let rest = metafy(tail(&raw, f.dir_len));
			r.extend_from_slice(&text::quotestring(&rest, text::Qt::Backslash, o));
			r
		},
		None => text::quotestring(s, text::Qt::Backslash, o),
	})
}

/// The match replacement of `${x/p/r}`: `r` substituted (after the
/// capture variables of a match are set, when `r` refers to them) and
/// untokenized.
fn replacement(ex: &mut Expander<'_, '_>, r: &[u8], subject: &[u8], caps: &Captures) -> X<Vec<u8>> {
	if caps.whole.is_some() || caps.groups.is_some() {
		zpattern::set_match_vars(ex, subject, caps)?;
	}
	let mut v = singsub(ex, r.to_vec())?;
	untokenize(&mut v);
	Ok(v)
}

/// zsh `getmatch`/`getmatcharr` with the shell's options, the replacement
/// substituted per match, and the capture variables set.
pub(super) fn do_getmatch(
	ex: &mut Expander<'_, '_>,
	vals: &mut Vec<Vec<u8>>,
	scalar: bool,
	pat: &[u8],
	flags: SubFlags,
	flnum: i64,
	replstr: Option<&[u8]>,
) -> X<bool> {
	let o = zpattern::opts(ex)?;
	let env = zpattern::char_env(ex)?;
	let mut keep = true;
	let mut out = Vec::with_capacity(vals.len());
	for v in vals.iter() {
		let mut caps = Captures::default();
		let mut err: Option<Stop> = None;
		let subject = v.clone();
		let r = {
			let mut repl = |c: &Captures, buf: &mut Vec<u8>| {
				if err.is_some() {
					return;
				}
				match replacement(ex, replstr.unwrap_or_default(), &subject, c) {
					Ok(t) => buf.extend_from_slice(&t),
					Err(e) => err = Some(e),
				}
			};
			let repl: Option<&mut crate::bash::pattern::zsh::Replace<'_>> = if replstr.is_some() {
				Some(&mut repl)
			} else {
				None
			};
			crate::bash::pattern::zsh::getmatch(v, pat, flags, flnum, repl, &o, &env.env(), &mut caps)
		};
		if let Some(e) = err {
			return Err(e);
		}
		let r = r.map_err(|_| zpattern::bad_pattern(pat))?;
		if caps.whole.is_some() || caps.groups.is_some() {
			zpattern::set_match_vars(ex, &subject, &caps)?;
		}
		if r.keep || scalar {
			out.push(r.value);
		}
		keep &= r.keep;
	}
	*vals = out;
	Ok(keep)
}

// ---- paramsubst --------------------------------------------------------

/// The state of one `paramsubst`.
#[derive(Default)]
struct Ps {
	isarr:  i32,
	val:    Vec<u8>,
	aval:   Option<Vec<Vec<u8>>>,
	vunset: i32,
}

/// zsh `paramsubst`: the parameter substitution whose `$` (or `Qstring`)
/// is at `list.nodes[n][aptr]`. Returns the node and position where
/// scanning continues, or `None` when the node was removed (an empty
/// `rc_expand_param` array).
#[expect(
	clippy::too_many_lines,
	clippy::cognitive_complexity,
	reason = "a faithful port of one C function"
)]
#[allow(clippy::many_single_char_names, reason = "a direct port of zsh's paramsubst")]
fn paramsubst(
	ex: &mut Expander<'_, '_>,
	l: &mut List,
	n: usize,
	aptr: usize,
	qt: bool,
	pf_flags: u32,
	ret_flags: &mut u32,
) -> X<Option<(usize, usize)>> {
	let ostr = l.node(n).to_vec();
	let d = &ostr;
	let mut s = aptr + 1;
	let ifs = params::ifs(ex)?;
	let mb = params::mb(ex)?;
	let wide = mb && !opt(ex, ZshOpt::Posixidentifiers)?;
	let mut plan9 = opt(ex, ZshOpt::Rcexpandparam)?;
	let mut globsubst: i32 = i32::from(opt(ex, ZshOpt::Globsubst)?);
	let shglob = opt(ex, ZshOpt::Shglob)?;
	let ksh = opt(ex, ZshOpt::Ksharrays)?;
	let mut evalchar = false;
	let mut getlen: i32 = 0;
	let mut whichlen: i32 = 0;
	let mut chkset = false;
	let mut wantt = false;
	let mut spbreak: i32 =
		i32::from(pf_flags & PREFORK_SHWORDSPLIT != 0 && pf_flags & PREFORK_SINGLE == 0 && !qt);
	let mut ps = Ps::default();
	let mut v: Option<Value> = None;
	let mut flags = SubFlags::NONE;
	let mut flnum: i64 = 0;
	let mut sortit: u32 = 0;
	let mut indord = false;
	let mut unique = false;
	let mut casmod: Option<text::CaseMod> = None;
	let mut quotemod: i32 = 0;
	let mut quotetype: i32 = qt::NONE;
	let mut quoteerr = false;
	let mut mods = 0u8;
	let mut shsplit: u32 = 0;
	let ssub = pf_flags & PREFORK_SINGLE != 0;
	let mut sep: Option<Vec<u8>> = None;
	let mut spsep: Option<Vec<u8>> = None;
	let mut premul: Option<Vec<u8>> = None;
	let mut postmul: Option<Vec<u8>> = None;
	let mut preone: Option<Vec<u8>> = None;
	let mut postone: Option<Vec<u8>> = None;
	let mut replstr: Option<Vec<u8>> = None;
	let mut prenum: i64 = 0;
	let mut postnum: i64 = 0;
	let mut arrasg: i32 = 0;
	let mut eval = false;
	let mut aspar = false;
	let mut presc = 0;
	let mut getkeys: i32 = -1;
	let mut nojoin: i32 = if pf_flags & PREFORK_SHWORDSPLIT != 0 {
		i32::from(ifs.as_ref().is_none_or(|i| i.is_empty()) && !qt)
	} else {
		0
	};
	let mut inbrace = false;
	let mut hkeys = 0u32;
	let mut hvals = 0u32;
	let mut horrible_offset_hack = false;
	let mut ms_flags = 0u32;
	let quoted_array_with_offset = false;
	let hist = HistSubst::default();

	let c = at(d, s);
	if text::ident_end(d, s, wide) == s
		&& !matches!(
			c,
			b'#'
				| POUND
				| b'-'
				| DASH
				| b'!'
				| b'$'
				| STRING
				| QSTRING
				| b'?'
				| QUEST
				| b'*'
				| STAR
				| b'@'
				| b'{'
				| INBRACE
				| b'='
				| EQUALS
				| HAT
				| b'^'
				| b'~'
				| TILDE
				| b'+'
		) {
		if let Some(c) = l.nodes.get_mut(n).and_then(|w| w.get_mut(aptr)) {
			*c = b'$';
		}
		return Ok(Some((n, aptr + 1)));
	}
	if c == INBRACE {
		inbrace = true;
		s += 1;
		let c = at(d, s);
		if c == b'!' && at(d, s + 1) != OUTBRACE && ex.vp.mode == crate::bash::ids::ModeId::Ksh {
			hkeys = params::SCANPM_WANTKEYS;
			s += 1;
		} else if c == b'(' || c == INPAR {
			let mut escapes = false;
			let mut tok_arg = false;
			s += 1;
			loop {
				let c = at(d, s);
				if c == b')' || c == OUTPAR || c == 0 {
					if c == 0 {
						return Err(flagerr(d, aptr, s));
					}
					break;
				}
				match c {
					b'~' | TILDE => tok_arg = !tok_arg,
					b'A' => arrasg += 1,
					b'@' => nojoin = 2,
					b'*' | STAR => flags |= SubFlags::EGLOB,
					b'M' => flags |= SubFlags::MATCH,
					b'R' => flags |= SubFlags::REST,
					b'B' => flags |= SubFlags::BIND,
					b'E' => flags |= SubFlags::EIND,
					b'N' => flags |= SubFlags::LEN,
					b'S' => flags |= SubFlags::SUBSTR,
					b'I' => {
						s += 1;
						let (num, _) = get_intarg(ex, d, &mut s)?;
						if num < 0 {
							return Err(flagerr(d, aptr, s));
						}
						flnum = num;
						s -= 1;
					},
					b'L' => casmod = Some(text::CaseMod::Lower),
					b'U' => casmod = Some(text::CaseMod::Upper),
					b'C' => casmod = Some(text::CaseMod::Caps),
					b'o' => {
						if sortit == 0 {
							sortit |= SORTIT_SOMEHOW;
						}
					},
					b'O' => sortit |= SORTIT_BACKWARDS,
					b'i' => sortit |= SORTIT_IGNORING_CASE,
					b'n' => sortit |= SORTIT_NUMERICALLY,
					b'-' | DASH => sortit |= SORTIT_NUMERICALLY_SIGNED,
					b'a' => {
						sortit |= SORTIT_SOMEHOW;
						indord = true;
					},
					b'D' => mods |= 1,
					b'V' => mods |= 2,
					b'q' => {
						if quotetype == qt::DOLLARS || quotetype == qt::BACKSLASH_PATTERN {
							return Err(flagerr(d, aptr, s));
						}
						if is_dash(at(d, s + 1)) || at(d, s + 1) == b'+' {
							if quotemod != 0 {
								return Err(flagerr(d, aptr, s));
							}
							s += 1;
							quotemod = 1;
							quotetype = if at(d, s) == b'+' {
								qt::QUOTEDZPUTS
							} else {
								qt::SINGLE_OPTIONAL
							};
						} else {
							if quotetype == qt::SINGLE_OPTIONAL {
								return Err(flagerr(d, aptr, s));
							}
							quotemod += 1;
							quotetype += 1;
						}
					},
					b'b' => {
						if quotemod != 0 || quotetype != qt::NONE {
							return Err(flagerr(d, aptr, s));
						}
						quotemod = 1;
						quotetype = qt::BACKSLASH_PATTERN;
					},
					b'Q' => quotemod -= 1,
					b'X' => quoteerr = true,
					b'e' => eval = true,
					b'P' => aspar = true,
					b'c' => whichlen = 1,
					b'w' => whichlen = 2,
					b'W' => whichlen = 3,
					b'f' => spsep = Some(b"\n".to_vec()),
					b'F' => sep = Some(b"\n".to_vec()),
					b'0' => spsep = Some(vec![META, b' ']),
					b's' | b'j' => {
						let tt = c == b's';
						s += 1;
						let (t, arglen) = subscript::get_strarg(d, s, mb);
						if t >= d.len() {
							return Err(flagerr(d, aptr, s));
						}
						let start = (s + text::charlen(d, s, mb)).min(t);
						let arg = untok_and_escape(ex, span(d, start, t), escapes, tok_arg)?;
						if tt {
							spsep = Some(arg);
						} else {
							sep = Some(arg);
						}
						s = t + arglen - 1;
					},
					b'l' | b'r' => {
						let tt = c == b'l';
						s += 1;
						let del0 = s;
						let (num, dellen) = get_intarg(ex, d, &mut s)?;
						if num < 0 {
							return Err(flagerr(d, aptr, s));
						}
						if tt {
							prenum = num;
						} else {
							postnum = num;
						}
						if dellen == 0 || tail(d, s).get(..dellen) != d.get(del0..del0 + dellen) {
							s -= 1;
						} else {
							let (t, arglen) = subscript::get_strarg(d, s, mb);
							if t >= d.len() {
								return Err(flagerr(d, aptr, s));
							}
							let start = (s + text::charlen(d, s, mb)).min(t);
							let arg = untok_and_escape(ex, span(d, start, t), escapes, tok_arg)?;
							if tt {
								premul = Some(arg);
							} else {
								postmul = Some(arg);
							}
							s = t + arglen;
							if tail(d, s).get(..dellen) == d.get(del0..del0 + dellen) {
								let (t, arglen) = subscript::get_strarg(d, s, mb);
								if t >= d.len() {
									return Err(flagerr(d, aptr, s));
								}
								let start = (s + text::charlen(d, s, mb)).min(t);
								let arg = untok_and_escape(ex, span(d, start, t), escapes, tok_arg)?;
								if tt {
									preone = Some(arg);
								} else {
									postone = Some(arg);
								}
								s = t + arglen - 1;
							} else {
								s -= 1;
							}
						}
					},
					b'm' => {},
					b'p' => escapes = true,
					b'k' => hkeys = params::SCANPM_WANTKEYS,
					b'v' => hvals = params::SCANPM_WANTVALS,
					b't' => wantt = true,
					b'%' => presc += 1,
					b'g' => {
						s += 1;
						let (t, arglen) = subscript::get_strarg(d, s, mb);
						if getkeys < 0 {
							getkeys = 0;
						}
						if t >= d.len() {
							return Err(flagerr(d, aptr, s));
						}
						let mut k = s + text::charlen(d, s, mb);
						while k < t {
							match at(d, k) {
								b'e' => getkeys |= 2,
								b'o' => getkeys |= 1,
								b'c' => getkeys |= 4,
								_ => return Err(flagerr(d, aptr, k)),
							}
							k += 1;
						}
						s = t + arglen - 1;
					},
					b'z' => shsplit = crate::bash::syntax::zsh::LEXFLAGS_ACTIVE,
					b'Z' => {
						s += 1;
						let (t, arglen) = subscript::get_strarg(d, s, mb);
						if t >= d.len() {
							return Err(flagerr(d, aptr, s));
						}
						let mut k = s + text::charlen(d, s, mb);
						while k < t {
							match at(d, k) {
								b'c' => shsplit |= crate::bash::syntax::zsh::LEXFLAGS_COMMENTS_KEEP,
								b'C' => shsplit |= crate::bash::syntax::zsh::LEXFLAGS_COMMENTS_STRIP,
								b'n' => shsplit |= crate::bash::syntax::zsh::LEXFLAGS_NEWLINE,
								_ => return Err(flagerr(d, aptr, k)),
							}
							k += 1;
						}
						s = t + arglen - 1;
					},
					b'u' => unique = true,
					b'#' | POUND => evalchar = true,
					b'_' => {
						s += 1;
						let (t, arglen) = subscript::get_strarg(d, s, mb);
						if t >= d.len() || t > s + text::charlen(d, s, mb) {
							return Err(flagerr(d, aptr, s));
						}
						s = t + arglen - 1;
					},
					_ => return Err(flagerr(d, aptr, s)),
				}
				s += 1;
			}
			s += 1;
		}
	}
	let premul = premul.unwrap_or_else(|| b" ".to_vec());
	let postmul = postmul.unwrap_or_else(|| b" ".to_vec());

	loop {
		let c = at(d, s);
		if c == b'^' || c == HAT {
			s += 1;
			if matches!(at(d, s), b'^' | HAT) {
				plan9 = false;
				s += 1;
			} else {
				plan9 = true;
			}
		} else if c == b'=' || c == EQUALS {
			s += 1;
			if matches!(at(d, s), b'=' | EQUALS) {
				spbreak = 0;
				if nojoin < 2 {
					nojoin = 0;
				}
				s += 1;
			} else {
				spbreak = 2;
				if nojoin < 2 {
					nojoin = i32::from(ifs.as_ref().is_none_or(|i| i.is_empty()));
				}
			}
		} else if (c == b'#' || c == POUND) && (inbrace || !opt(ex, ZshOpt::Posixidentifiers)?) && {
			let cc = at(d, s + 1);
			text::ident_end(d, s + 1, wide) != s + 1
				|| matches!(cc, b'*' | STAR | b'@' | b'?' | QUEST | b'$' | STRING | QSTRING)
				|| ((cc == b'#' || cc == POUND) && at(d, s + 2) == OUTBRACE)
				|| is_dash(cc)
				|| (cc == b':' && is_dash(at(d, s + 2)))
				|| (isstring(cc) && matches!(at(d, s + 2), INBRACE | INPAR))
		} {
			getlen = 1 + whichlen;
			s += 1;
		} else if c == b'~' || c == TILDE {
			s += 1;
			if matches!(at(d, s), b'~' | TILDE) {
				globsubst = 0;
				s += 1;
			} else {
				globsubst = 2;
			}
		} else if c == b'+' {
			if text::ident_end(d, s + 1, wide) != s + 1
				|| (aspar && isstring(at(d, s + 1)) && matches!(at(d, s + 2), INBRACE | INPAR))
			{
				chkset = true;
				s += 1;
			} else if !inbrace {
				if let Some(c) = l.nodes.get_mut(n).and_then(|w| w.get_mut(aptr)) {
					*c = b'$';
				}
				return Ok(Some((n, aptr + 1)));
			} else {
				return Err(bad_subst());
			}
		} else if inbrace && is_null(c) && c != BNULL {
			s += 1;
		} else {
			break;
		}
	}
	if qt {
		globsubst = 0;
	}

	let mut idbeg: Vec<u8> = Vec::new();
	let idbeg_pos = s;
	let subexp_val: Option<Vec<u8>>;
	let mut subexp = inbrace
		&& at(d, s.wrapping_sub(1)) != 0
		&& isstring(at(d, s))
		&& matches!(at(d, s + 1), INBRACE | INPAR | INPARMATH);
	let fetch_needed;
	let mut name_buf: Option<Vec<u8>> = None;
	if subexp {
		let quoted = at(d, s) == QSTRING;
		let vstart = s;
		s += 1;
		let outtok = match at(d, s) {
			INBRACE => OUTBRACE,
			INPAR => OUTPAR,
			_ => OUTPARMATH,
		};
		let open = at(d, s);
		text::skipparens(open, outtok, d, &mut s);
		let inner = span(d, vstart, s).to_vec();
		let r = multsub(ex, inner, PREFORK_SUBEXP, !aspar, None, &mut ms_flags)?;
		if r.empty && quoted {
			ps.isarr = -1;
			ps.aval = Some(Vec::new());
			ps.val = Vec::new();
			aspar = false;
		} else {
			ps.isarr = r.isarr;
			ps.aval = r.arr;
			ps.val = r.val;
			if aspar {
				idbeg.clone_from(&ps.val);
			}
		}
		if ps.val.first() == Some(&NULARG) {
			ps.val.remove(0);
		}
		while is_null(at(d, s)) {
			s += 1;
		}
		if ms_flags & MULTSUB_PARAM_NAME != 0 {
			if ps.isarr != 0 {
				let a = ps.aval.take().unwrap_or_default();
				if a.len() > 1 {
					return Err(zerr("parameter name reference used with array"));
				}
				ps.val = a.into_iter().next().unwrap_or_default();
				ps.isarr = 0;
			}
			let mut nb = ps.val.clone();
			nb.extend_from_slice(tail(d, s));
			name_buf = Some(nb);
			subexp = false;
			fetch_needed = aspar && pf_flags & PREFORK_SUBEXP == 0;
		} else {
			fetch_needed = false;
		}
		v = None;
		subexp_val = Some(ps.val.clone());
	} else {
		fetch_needed = aspar;
		subexp_val = None;
	}
	// When a (P) name came from below, the rest of the expression is
	// parsed from that buffer.
	let owned;
	let (src, mut sp): (&[u8], usize) = match &name_buf {
		Some(nb) => {
			owned = nb.clone();
			(&owned, 0)
		},
		None => (d.as_slice(), s),
	};
	if fetch_needed {
		let mut pos = sp;
		if let Some(mut fv) =
			params::fetchvalue(ex, src, &mut pos, 1, if qt { SCANPM_DQUOTED } else { 0 })?
		{
			ps.val = fv.getstrvalue(ex)?;
			idbeg.clone_from(&ps.val);
			subexp = true;
			// zsh keeps `v`: unless (P) fetches again below, its value
			// (an array stays one) is what the substitution yields.
			v = Some(fv);
		} else {
			ps.vunset = 1;
		}
		sp = pos;
	}
	if aspar && pf_flags & PREFORK_SUBEXP != 0 {
		aspar = false;
		*ret_flags |= MULTSUB_PARAM_NAME;
	}
	if !subexp || aspar {
		let mut scanflags = hkeys | hvals;
		if arrasg != 0 {
			scanflags |= SCANPM_ASSIGNING;
		}
		if qt {
			scanflags |= SCANPM_DQUOTED;
		}
		if chkset {
			scanflags |= SCANPM_CHECKING;
		}
		let bracks = if wantt {
			-1
		} else if !ksh || inbrace {
			1
		} else {
			-1
		};
		// Only the text of a subscripted element is read here: a stored
		// array need not be read whole for it.
		let fv = if subexp {
			let ov = metafy(&unmetafy(&ps.val));
			let mut pos = 0;
			params::fetchvalue(ex, &ov, &mut pos, bracks, scanflags | params::SCANPM_WINDOW)?
		} else {
			let mut pos = sp;
			let r = params::fetchvalue(ex, src, &mut pos, bracks, scanflags | params::SCANPM_WINDOW)?;
			if idbeg.is_empty() {
				idbeg = span(src, sp, pos).to_vec();
			}
			sp = pos;
			r
		};
		v = fv;
		if v.as_ref().is_none_or(|v| {
			v.pm_flags().contains(params::PmFlags::UNSET) || v.flags & VALFLAG_EMPTY != 0
		}) {
			ps.vunset = 1;
		}
		if wantt {
			ps.val = match &v {
				Some(fv)
					if fv.pm.flags.contains(params::PmFlags::DECLARED)
						|| !fv.pm.flags.contains(params::PmFlags::UNSET) =>
				{
					ps.vunset = 0;
					fv.pm.type_name().to_vec()
				},
				_ => Vec::new(),
			};
			v = None;
			ps.isarr = 0;
		}
	}
	let _ = idbeg_pos;
	// The parameter's value into val/aval, through further subscripts.
	loop {
		if v.is_none() {
			if !((inbrace || (!ksh && ps.vunset != 0)) && isbrack(at(src, sp))) {
				break;
			}
			if ps.vunset != 0 {
				ps.val = Vec::new();
				ps.isarr = 0;
			}
			let mut tv = if ps.isarr != 0 {
				Value::temp_array(ps.aval.as_deref().unwrap_or_default())
			} else {
				Value::temp_scalar(&ps.val)
			};
			tv.isarr = u32::try_from(ps.isarr.max(0)).unwrap_or(0);
			let os = sp;
			subscript::getindex(ex, src, &mut sp, &mut tv, if qt { SCANPM_DQUOTED } else { 0 })?;
			if sp == os {
				break;
			}
			v = Some(tv);
		}
		let Some(mut fv) = v.take() else { break };
		ps.isarr = i32::try_from(fv.isarr).unwrap_or(-1);
		if fv.isarr != 0 {
			if fv.isarr == SCANPM_WANTINDEX {
				ps.isarr = 0;
				ps.val = match &fv.elem {
					Some(e) => metafy(&e.key),
					None => metafy(&fv.pm.name),
				};
			} else {
				ps.aval = Some(fv.getarrvalue(ex)?);
			}
		} else {
			if fv.pm.flags.contains(params::PmFlags::ARRAY) && fv.elem.is_none() {
				let len = match &fv.pm.value {
					params::PValue::Array(a) => i64::try_from(a.len()).unwrap_or(0),
					_ => 0,
				};
				if fv.start < 0 {
					fv.start += len + i64::from(fv.flags & VALFLAG_INV != 0);
				}
				if fv.flags & VALFLAG_INV == 0 && (fv.start < 0 || fv.start >= len) {
					ps.vunset = 1;
				}
			}
			if ps.vunset == 0 {
				fv.flags |= VALFLAG_SUBST;
				ps.val = fv.getstrvalue(ex)?;
			}
		}
		horrible_offset_hack = matches!(
			fv.pm.special,
			Some(super::specials::Special::Argv | super::specials::Special::Star)
		);
		if !inbrace {
			break;
		}
	}
	if inbrace {
		let c = at(src, sp);
		if !is_dash(c)
			&& !matches!(
				c,
				b'+'
					| b':'
					| b'%'
					| b'/'
					| b'='
					| EQUALS
					| b'#'
					| POUND
					| b'?'
					| QUEST
					| b'}'
					| OUTBRACE
			) {
			return Err(bad_subst());
		}
	}
	if ps.isarr != 0 {
		if nojoin != 0 {
			ps.isarr = -1;
		}
		if qt && getlen == 0 && ps.isarr > 0 {
			ps.val = text::sepjoin(
				ps.aval.as_deref().unwrap_or_default(),
				sep.as_deref(),
				ifs.as_deref(),
				mb,
			);
			ps.isarr = 0;
		}
	}
	let idend = sp;
	if idbeg.is_empty() && subexp_val.is_none() {
		idbeg = span(src, idbeg_pos.min(idend), idend).to_vec();
	}
	if inbrace {
		while is_null(at(src, sp)) {
			sp += 1;
		}
	}
	let mut colf = at(src, sp) == b':';
	if colf {
		sp += 1;
	}
	// The text after the substitution.
	let mut fstr_at = sp;
	if inbrace {
		let mut bct = 1;
		while fstr_at < src.len() {
			let c = at(src, fstr_at);
			if c == INBRACE {
				bct += 1;
			} else if c == OUTBRACE {
				bct -= 1;
				if bct == 0 {
					break;
				}
			}
			fstr_at += 1;
		}
		if bct != 0 {
			return Err(zerr("closing brace expected"));
		}
	}
	// `expr` is the operator text (inside the braces).
	let expr_end = fstr_at;
	let mut fstr: Vec<u8> = if inbrace {
		tail(src, fstr_at + 1).to_vec()
	} else {
		Vec::new()
	};
	let idname = {
		let mut x = idbeg.clone();
		untokenize(&mut x);
		BString::from(unmetafy(&x))
	};
	let c = at(src, sp);
	if inbrace
		&& (c == b'+'
			|| is_dash(c)
			|| c == b':'
			|| c == b'='
			|| c == EQUALS
			|| c == b'%'
			|| c == b'#'
			|| c == POUND
			|| c == b'?'
			|| c == QUEST
			|| c == b'/')
	{
		if flnum == 0 {
			flnum = 1;
		}
		if c == b'%' {
			flags |= SubFlags::END;
		}
		if (c == b'%' || c == b'#' || c == POUND) && at(src, sp + 1) == c {
			sp += 1;
			flags |= SubFlags::LONG;
		}
		sp += 1;
		let op = at(src, sp.wrapping_sub(1));
		let mut sbody: Vec<u8> = span(src, sp.min(expr_end), expr_end).to_vec();
		if op == b'/' {
			flags = (if flags.contains(SubFlags::SUBSTR) {
				SubFlags::NONE
			} else {
				SubFlags::LONG
			}) | if flags.contains(SubFlags::EGLOB) {
				SubFlags::EGLOB
			} else {
				SubFlags::NONE
			};
			let mut k = if at(&sbody, 0) == b'/' {
				flags |= SubFlags::GLOBAL;
				1
			} else {
				0
			};
			if matches!(at(&sbody, k), b'#' | POUND) {
				flags |= SubFlags::START;
				k += 1;
			}
			if at(&sbody, k) == b'%' {
				flags |= SubFlags::END;
				k += 1;
			}
			if !flags.contains(SubFlags::START) && !flags.contains(SubFlags::END) {
				flags |= SubFlags::SUBSTR;
			}
			let mut body = tail(&sbody, k).to_vec();
			let mut ptr = 0;
			while ptr < body.len() && at(&body, ptr) != b'/' {
				if matches!(at(&body, ptr), BNULL | BNULLKEEP | b'\\') && ptr + 1 < body.len() {
					if at(&body, ptr + 1) == b'/' {
						body.remove(ptr);
					} else {
						ptr += 1;
					}
				}
				ptr += 1;
			}
			replstr = Some(if ptr + 1 < body.len() {
				tail(&body, ptr + 1).to_vec()
			} else {
				Vec::new()
			});
			body.truncate(ptr);
			sbody = body;
		}
		if colf {
			flags |= SubFlags::ALL;
		}
		if !(flags.contains(SubFlags::MATCH)
			|| flags.contains(SubFlags::REST)
			|| flags.contains(SubFlags::BIND)
			|| flags.contains(SubFlags::EIND)
			|| flags.contains(SubFlags::LEN))
		{
			flags |= SubFlags::REST;
		}
		if colf && ps.vunset == 0 {
			let empty = if ps.isarr != 0 {
				ps.aval.as_ref().is_none_or(Vec::is_empty)
			} else {
				ps.val.is_empty() || ps.val == [NULARG]
			};
			ps.vunset = -i32::from(empty);
		}
		let mut op = op;
		if op == b'+' {
			if ps.vunset != 0 {
				ps.val = Vec::new();
				ps.isarr = 0;
				op = 0;
			} else {
				ps.vunset = 1;
				op = b'-';
			}
		}
		match op {
			0 => {},
			b'-' | DASH => {
				if ps.vunset != 0 {
					let split_flags = if spbreak != 0 {
						PREFORK_SHWORDSPLIT | if aspar { 0 } else { PREFORK_SPLIT }
					} else {
						PREFORK_NOSHWORDSPLIT
					};
					let r = multsub(ex, sbody, split_flags, !aspar, None, &mut ms_flags)?;
					ps.val = r.val;
					ps.aval = r.arr;
					ps.isarr = r.isarr;
					spbreak = 0;
					if globsubst != 2 {
						globsubst = 0;
					}
				}
			},
			b':' | b'=' | EQUALS => {
				let mut body = sbody;
				if op == b':' {
					if !matches!(at(&body, 0), b'=' | EQUALS) {
						// `${x:off:len}` with an empty offset.
						sp -= 1;
						return finish_colon(
							ex,
							l,
							n,
							aptr,
							qt,
							&ostr,
							src,
							sp,
							expr_end,
							fstr,
							ps,
							State { chkset, colf: true, inbrace, idname, horrible_offset_hack },
							Post {
								plan9,
								globsubst,
								evalchar,
								getlen,
								spbreak,
								nojoin,
								ssub,
								sep,
								spsep,
								casmod,
								getkeys,
								presc,
								quotemod,
								quotetype,
								quoteerr,
								mods,
								shsplit,
								arrasg,
								unique,
								sortit,
								indord,
								eval,
								prenum,
								postnum,
								premul,
								postmul,
								preone,
								postone,
								ms_flags,
								quoted_array_with_offset,
								ifs,
								shglob,
								mb,
								hist,
							},
						);
					}
					ps.vunset = 1;
					body.remove(0);
				} else {
					// `${name=word}`, `${name:=word}`: whether to assign.
					let now = ps.vunset != 0;
					if decided(ex, now) != now {
						ps.vunset = i32::from(!now);
					}
				}
				if ps.vunset != 0 {
					if spsep.is_some() || arrasg == 0 {
						let r = multsub(
							ex,
							body,
							if spbreak != 0 {
								PREFORK_SINGLE
							} else {
								PREFORK_NOSHWORDSPLIT
							},
							false,
							None,
							&mut ms_flags,
						)?;
						ps.val = r.val;
						ps.isarr = r.isarr;
					} else {
						let split_flags = if spbreak != 0 {
							PREFORK_SPLIT | PREFORK_SHWORDSPLIT
						} else {
							PREFORK_NOSHWORDSPLIT
						};
						let r = multsub(ex, body, split_flags, true, None, &mut ms_flags)?;
						ps.val = r.val;
						ps.aval = r.arr;
						ps.isarr = r.isarr;
						spbreak = 0;
					}
					if arrasg != 0 {
						let mut items: Vec<Vec<u8>>;
						if spsep.is_some() || spbreak != 0 {
							let seps = params::seps(ex)?;
							items = text::sepsplit(&seps, &ps.val, spsep.as_deref(), false);
							ps.isarr = if nojoin != 0 { 1 } else { 2 };
							if items.last().is_some_and(Vec::is_empty) {
								items.pop();
							}
							if items.first().is_some_and(Vec::is_empty) {
								items.remove(0);
							}
						} else if ps.isarr == 0 {
							items = if ps.val.is_empty() && arrasg > 1 {
								Vec::new()
							} else {
								vec![ps.val.clone()]
							};
						} else {
							items = ps.aval.clone().unwrap_or_default();
						}
						for it in &mut items {
							untokenize(it);
						}
						let mut name = idbeg.clone();
						untokenize(&mut name);
						let assigned = items.clone();
						redo(ex, &name, |ex| {
							if arrasg > 1 {
								params::sethparam_meta(ex, &name, assigned)
							} else {
								params::assignaparam_meta(ex, &name, assigned, params::ASSPM_WARN)
							}
						})?;
						ps.aval = Some(if arrasg > 1 {
							let mut nm = idbeg;
							untokenize(&mut nm);
							let mut fv = params::fetchvalue(ex, &nm, &mut 0, 1, hkeys | hvals)?;
							match fv.as_mut() {
								Some(fv) => fv.getarrvalue(ex)?,
								None => Vec::new(),
							}
						} else {
							items
						});
						ps.isarr = 1;
						arrasg = 0;
					} else {
						// zsh untokenizes the word in place: the expansion is
						// the assigned text, not a pattern (`${x=*}` is `*`).
						untokenize(&mut ps.val);
						let val = ps.val.clone();
						let mut name = idbeg;
						untokenize(&mut name);
						redo(ex, &name, |ex| {
							params::assignsparam_meta(ex, &name, val, params::ASSPM_WARN)
						})?;
					}
					if ps.isarr != 0 {
						if nojoin != 0 {
							ps.isarr = -1;
						}
						if qt && getlen == 0 && ps.isarr > 0 && spsep.is_none() && spbreak < 2 {
							ps.val = text::sepjoin(
								ps.aval.as_deref().unwrap_or_default(),
								sep.as_deref(),
								ifs.as_deref(),
								mb,
							);
							ps.isarr = 0;
						}
						sep = None;
						spsep = None;
						spbreak = 0;
					}
				}
			},
			b'?' | QUEST => {
				if ps.vunset != 0 && opt(ex, ZshOpt::Exec)? {
					let msg = if sbody.is_empty() {
						BString::from("parameter not set")
					} else {
						let mut m = singsub(ex, sbody)?;
						untokenize(&mut m);
						BString::from(unmetafy(&m))
					};
					// zsh: an interactive shell goes back to its prompt;
					// any other shell exits.
					if opt(ex, ZshOpt::Interactive)? {
						return Err(Stop::Fail(Diag::ParamUnset { name: idname, msg }));
					}
					return Err(Stop::Fatal(Diag::ParamUnset { name: idname, msg }));
				}
				// `NO_EXEC`: zsh's `paramsubst` gives up on the word
				// without an error; nothing runs it, so the (empty)
				// value goes on unreported.
			},
			_ => {
				// `%`, `#`, `/`: pattern operations.
				let pat = match parse_subst_string(&sbody) {
					Ok(p) => p,
					Err(_) if !quoteerr => {
						let mut t = sbody.clone();
						crate::bash::pattern::zsh::shtokenize(&mut t, shglob);
						t
					},
					// The lexer's own message comes first (zsh `zerr`
					// prints only the first error).
					Err(Some(msg)) => return Err(zerr(BString::from(msg))),
					Err(None) => {
						return Err(zerr(format!(
							"parse error in ${{...{}...}} substitution",
							char::from(op)
						)));
					},
				};
				let pat = singsub(ex, pat)?;
				let eg = flags.contains(SubFlags::EGLOB);
				let saved = if eg {
					Some(opt(ex, ZshOpt::Extendedglob)?)
				} else {
					None
				};
				if eg {
					state::set_zsh_option(
						&mut ex.k.root,
						ex.cx.store,
						ex.vp,
						ZshOpt::Extendedglob,
						true,
					)?;
				}
				let r = if ps.vunset == 0 && ps.isarr != 0 {
					let mut a = ps.aval.take().unwrap_or_default();
					for e in &mut a {
						untokenize(e);
					}
					let r = do_getmatch(ex, &mut a, false, &pat, flags, flnum, replstr.as_deref());
					ps.aval = Some(a);
					r.map(|_| ())
				} else {
					if ps.vunset != 0 {
						if ps.vunset > 0 && !opt(ex, ZshOpt::Unset)? {
							return Err(Stop::Fail(Diag::Unbound { name: idname }));
						}
						ps.val = Vec::new();
					}
					untokenize(&mut ps.val);
					let mut a = vec![std::mem::take(&mut ps.val)];
					let r = do_getmatch(ex, &mut a, true, &pat, flags, flnum, replstr.as_deref());
					ps.val = a.into_iter().next().unwrap_or_default();
					r.map(|_| ())
				};
				if let Some(was) = saved {
					state::set_zsh_option(
						&mut ex.k.root,
						ex.cx.store,
						ex.vp,
						ZshOpt::Extendedglob,
						was,
					)?;
				}
				r?;
			},
		}
		fstr.shrink_to_fit();
		return finish(ex, l, n, aptr, qt, &ostr, fstr, ps, Post {
			plan9,
			globsubst,
			evalchar,
			getlen,
			spbreak,
			nojoin,
			ssub,
			sep,
			spsep,
			casmod,
			getkeys,
			presc,
			quotemod,
			quotetype,
			quoteerr,
			mods,
			shsplit,
			arrasg,
			unique,
			sortit,
			indord,
			eval,
			prenum,
			postnum,
			premul,
			postmul,
			preone,
			postone,
			ms_flags,
			quoted_array_with_offset,
			ifs,
			shglob,
			mb,
			hist,
		});
	} else if inbrace && matches!(c, b'^' | HAT) {
		sp += 1;
		let mut shortest = true;
		if matches!(at(src, sp), b'^' | HAT) {
			shortest = false;
			sp += 1;
		}
		let name = span(src, sp, expr_end).to_vec();
		if text::ident_end(&name, 0, wide) != name.len() {
			let mut nm = name;
			untokenize(&mut nm);
			return Err(Stop::Fail(Diag::InvalidIdent { name: BString::from(unmetafy(&nm)) }));
		}
		if ps.vunset != 0 {
			if ps.vunset > 0 && !opt(ex, ZshOpt::Unset)? {
				return Err(Stop::Fail(Diag::Unbound { name: idname }));
			}
			ps.val = Vec::new();
		} else {
			let zip = match params::getaparam(ex, &unmetafy(&name))? {
				Some(a) => Some(a.iter().map(|e| metafy(e)).collect::<Vec<_>>()),
				None => params::getsparam(ex, &unmetafy(&name))?.map(|v| vec![metafy(&v)]),
			};
			if ps.isarr == 0 {
				ps.aval = Some(vec![ps.val.clone()]);
				ps.isarr = 1;
			}
			if let Some(zip) = zip {
				let a = ps.aval.clone().unwrap_or_default();
				let (alen, ziplen) = (a.len(), zip.len());
				let outlen = if shortest ^ (alen > ziplen) {
					alen
				} else {
					ziplen
				};
				if !shortest && (alen == 0 || ziplen == 0) {
					if ziplen > 0 {
						ps.aval = Some(zip);
					}
				} else {
					let mut out = Vec::with_capacity(2 * outlen);
					for i in 0..outlen {
						out.extend(a.get(i.checked_rem(alen).unwrap_or(0)).cloned());
						out.extend(zip.get(i.checked_rem(ziplen).unwrap_or(0)).cloned());
					}
					ps.aval = Some(out);
				}
			} else {
				if !opt(ex, ZshOpt::Unset)? {
					return Err(Stop::Fail(Diag::Unbound { name: BString::from(unmetafy(&name)) }));
				}
				ps.val = Vec::new();
			}
		}
	} else if inbrace && matches!(c, b'|' | crate::bash::syntax::zsh::tok::BAR | b'*' | STAR) {
		let intersect = matches!(c, b'*' | STAR);
		sp += 1;
		let name = span(src, sp, expr_end).to_vec();
		if text::ident_end(&name, 0, wide) != name.len() {
			let mut nm = name;
			untokenize(&mut nm);
			return Err(Stop::Fail(Diag::InvalidIdent { name: BString::from(unmetafy(&nm)) }));
		}
		let compare = params::getaparam(ex, &unmetafy(&name))?;
		if let Some(compare) = compare {
			let set: hashbrown::HashSet<Vec<u8>> = compare.iter().map(|e| metafy(e)).collect();
			if ps.vunset == 0 && ps.isarr != 0 {
				let mut a = ps.aval.take().unwrap_or_default();
				for e in &mut a {
					untokenize(e);
				}
				a.retain(|e| set.contains(e) == intersect);
				ps.aval = Some(a);
			} else if ps.vunset != 0 {
				if ps.vunset > 0 && !opt(ex, ZshOpt::Unset)? {
					return Err(Stop::Fail(Diag::Unbound { name: idname }));
				}
				ps.val = Vec::new();
			} else if set.contains(&ps.val) != intersect {
				ps.val = Vec::new();
			}
		} else if intersect && ps.vunset == 0 {
			if ps.isarr != 0 {
				ps.aval = Some(Vec::new());
			} else {
				ps.val = Vec::new();
			}
		}
		if ps.vunset != 0 {
			if ps.vunset > 0 && !opt(ex, ZshOpt::Unset)? {
				return Err(Stop::Fail(Diag::Unbound { name: idname }));
			}
			ps.val = Vec::new();
		}
	} else {
		return finish_colon(
			ex,
			l,
			n,
			aptr,
			qt,
			&ostr,
			src,
			sp,
			expr_end,
			fstr,
			ps,
			State { chkset, colf, inbrace, idname, horrible_offset_hack },
			Post {
				plan9,
				globsubst,
				evalchar,
				getlen,
				spbreak,
				nojoin,
				ssub,
				sep,
				spsep,
				casmod,
				getkeys,
				presc,
				quotemod,
				quotetype,
				quoteerr,
				mods,
				shsplit,
				arrasg,
				unique,
				sortit,
				indord,
				eval,
				prenum,
				postnum,
				premul,
				postmul,
				preone,
				postone,
				ms_flags,
				quoted_array_with_offset,
				ifs,
				shglob,
				mb,
				hist,
			},
		);
	}
	let _ = &mut colf;
	finish(ex, l, n, aptr, qt, &ostr, fstr, ps, Post {
		plan9,
		globsubst,
		evalchar,
		getlen,
		spbreak,
		nojoin,
		ssub,
		sep,
		spsep,
		casmod,
		getkeys,
		presc,
		quotemod,
		quotetype,
		quoteerr,
		mods,
		shsplit,
		arrasg,
		unique,
		sortit,
		indord,
		eval,
		prenum,
		postnum,
		premul,
		postmul,
		preone,
		postone,
		ms_flags,
		quoted_array_with_offset,
		ifs,
		shglob,
		mb,
		hist,
	})
}

/// `error in flags near position N in '$TEXT'`.
fn flagerr(d: &[u8], aptr: usize, s: usize) -> Stop {
	let mut copy = tail(d, aptr + 1).to_vec();
	untokenize(&mut copy);
	let offset = s - aptr + 1;
	zerr(format!("error in flags near position {offset} in '${}'", BStr::new(&unmetafy(&copy))))
}

/// What the no-operator branch of `paramsubst` needs.
struct State {
	chkset:               bool,
	colf:                 bool,
	inbrace:              bool,
	idname:               BString,
	horrible_offset_hack: bool,
}

/// The flags the tail of `paramsubst` applies.
struct Post {
	plan9: bool,
	globsubst: i32,
	evalchar: bool,
	getlen: i32,
	spbreak: i32,
	nojoin: i32,
	ssub: bool,
	sep: Option<Vec<u8>>,
	spsep: Option<Vec<u8>>,
	casmod: Option<text::CaseMod>,
	getkeys: i32,
	presc: i32,
	quotemod: i32,
	quotetype: i32,
	quoteerr: bool,
	mods: u8,
	shsplit: u32,
	arrasg: i32,
	unique: bool,
	sortit: u32,
	indord: bool,
	eval: bool,
	prenum: i64,
	postnum: i64,
	premul: Vec<u8>,
	postmul: Vec<u8>,
	preone: Option<Vec<u8>>,
	postone: Option<Vec<u8>>,
	ms_flags: u32,
	quoted_array_with_offset: bool,
	ifs: Option<Vec<u8>>,
	shglob: bool,
	/// [`params::mb`].
	mb: bool,
	hist: HistSubst,
}

/// The `colonsubscript:` branch of `paramsubst`: `${+x}`, unset checks,
/// `${x:off:len}`, and history modifiers; then [`finish`].
#[expect(
	clippy::too_many_arguments,
	clippy::too_many_lines,
	reason = "a faithful port of one C function"
)]
#[allow(clippy::many_single_char_names, reason = "a direct port of zsh's finish_colon")]
fn finish_colon(
	ex: &mut Expander<'_, '_>,
	l: &mut List,
	n: usize,
	aptr: usize,
	qt: bool,
	ostr: &[u8],
	src: &[u8],
	sp: usize,
	expr_end: usize,
	fstr: Vec<u8>,
	mut ps: Ps,
	st: State,
	mut post: Post,
) -> X<Option<(usize, usize)>> {
	let mut sp = sp;
	let mut fstr = fstr;
	let mut colf = st.colf;
	if st.chkset {
		ps.val = if ps.vunset != 0 {
			b"0".to_vec()
		} else {
			b"1".to_vec()
		};
		ps.isarr = 0;
	} else if ps.vunset != 0 {
		if ps.vunset > 0 && !opt(ex, ZshOpt::Unset)? {
			return Err(Stop::Fail(Diag::Unbound { name: st.idname }));
		}
		ps.val = Vec::new();
	}
	let expr: &[u8] = if st.inbrace { head(src, expr_end) } else { src };
	// `expr` with its tail from this index untokenized: what zsh's failed
	// `parse_subscript` leaves for the modifiers to read.
	let mut unlexed_from: Option<usize> = None;
	let offset_sub = if colf && st.inbrace {
		check_colon_subscript(ex, tail(expr, sp))?
	} else {
		ColonSub::Modifier
	};
	if matches!(offset_sub, ColonSub::Unlexed) {
		unlexed_from = Some(sp);
	}
	if let ColonSub::Offset(off_text, end1) = offset_sub {
		let mut offset = arith::mathevali(ex, &off_text)?;
		let mut length: i64 = 0;
		let mut length_set = false;
		let mut offset_hack_argzero = false;
		let mut next = sp + end1;
		if next < expr.len() && at(expr, next) != b':' {
			return Err(params::bad_subscript(format!(
				"invalid subscript: {}",
				BStr::new(&unmetafy(&off_text))
			)));
		}
		let length_sub = if next < expr.len() {
			check_colon_subscript(ex, tail(expr, next + 1))?
		} else {
			ColonSub::Modifier
		};
		if matches!(length_sub, ColonSub::Unlexed) {
			unlexed_from = Some(next + 1);
		}
		if let ColonSub::Offset(len_text, end2) = length_sub {
			let e2 = next + 1 + end2;
			if e2 < expr.len() && at(expr, e2) != b':' {
				return Err(params::bad_subscript(format!(
					"invalid length: {}",
					BStr::new(&unmetafy(&len_text))
				)));
			}
			length = arith::mathevali(ex, &len_text)?;
			length_set = true;
			next = e2;
		}
		if ps.aval.is_some() && ps.isarr == 0 {
			post.quoted_array_with_offset = true;
		}
		if ps.isarr != 0 || post.quoted_array_with_offset {
			if st.horrible_offset_hack {
				if offset == 0 {
					offset_hack_argzero = true;
				} else if offset > 0 {
					offset -= 1;
				}
			}
			let a = ps.aval.take().unwrap_or_default();
			let mut alen = i64::try_from(a.len()).unwrap_or(0);
			if offset < 0 {
				offset = (offset + alen).max(0);
			}
			if offset_hack_argzero {
				alen += 1;
			}
			if length_set {
				if length < 0 {
					length += alen - offset;
				}
				if length < 0 {
					return Err(params::bad_subscript(format!(
						"substring expression: {} < {}",
						length + offset,
						offset
					)));
				}
			} else {
				length = alen;
			}
			offset = offset.min(alen);
			if offset + length > alen {
				length = alen - offset;
			}
			let mut out = Vec::new();
			let mut count = length;
			let mut src_i = usize::try_from(offset).unwrap_or(0);
			if count > 0 && offset_hack_argzero {
				let z = super::specials::get(ex, super::specials::Special::Zero)?;
				if let Some(params::PValue::Scalar(z)) = z {
					out.push(metafy(&z));
				}
				count -= 1;
			}
			while count > 0 {
				out.push(a.get(src_i).cloned().unwrap_or_default());
				src_i += 1;
				count -= 1;
			}
			ps.aval = Some(out);
		} else {
			let v = &ps.val;
			let mb = post.mb;
			let nchars = i64::try_from(text::strlen_chars(v, mb)).unwrap_or(0);
			if offset < 0 {
				offset = (offset + nchars).max(0);
			}
			let given = offset;
			if length_set && length < 0 {
				length -= offset;
			}
			let mut b = 0;
			let mut left = offset;
			while b < v.len() && left > 0 {
				b += text::charlen(v, b, mb);
				left -= 1;
			}
			if length_set {
				if length < 0 {
					length += nchars;
					if length < 0 {
						return Err(params::bad_subscript(format!(
							"substring expression: {} < {}",
							length + given,
							given
						)));
					}
				}
				let mut e = b;
				while e < v.len() && length > 0 {
					e += text::charlen(v, e, mb);
					length -= 1;
				}
				ps.val = span(v, b, e).to_vec();
			} else {
				ps.val = tail(v, b).to_vec();
			}
		}
		if next >= expr.len() {
			colf = false;
		} else {
			sp = next + 1;
		}
	}
	let mut rest_at = sp;
	if colf {
		sp -= 1;
		rest_at = sp;
		if !opt(ex, ZshOpt::Ksharrays)? || st.inbrace {
			let unlexed = unlexed_from.map(|at| {
				let mut t = tail(expr, at).to_vec();
				untokenize(&mut t);
				let mut v = head(expr, at).to_vec();
				v.extend_from_slice(&t);
				v
			});
			let mods: &[u8] = unlexed.as_deref().unwrap_or(expr);
			let mut pos = sp;
			if ps.isarr == 0 {
				modify::modify(ex, &mut ps.val, mods, &mut pos, st.inbrace, &mut post.hist)?;
			} else {
				let a = ps.aval.take().unwrap_or_default();
				let mut out = Vec::with_capacity(a.len());
				let mut end = sp;
				for mut e in a {
					let mut p = sp;
					modify::modify(ex, &mut e, mods, &mut p, st.inbrace, &mut post.hist)?;
					end = p;
					out.push(e);
				}
				if out.is_empty() {
					let mut t = Vec::new();
					let mut p = sp;
					modify::modify(ex, &mut t, mods, &mut p, st.inbrace, &mut post.hist)?;
					end = p;
				}
				pos = end;
				ps.aval = Some(out);
			}
			if st.inbrace && pos < mods.len() {
				return Err(
					if at(mods, pos) == b':'
						&& pos + 1 < mods.len()
						&& !crate::bash::syntax::zsh::tok::is_meta(at(mods, pos + 1))
					{
						zerr(format!("unrecognized modifier `{}'", char::from(at(mods, pos + 1))))
					} else {
						zerr("unrecognized modifier")
					},
				);
			}
			rest_at = pos;
		}
	}
	if !st.inbrace {
		// `$x:t…`: the word goes on after the modifiers.
		fstr = tail(src, rest_at).to_vec();
	}
	finish(ex, l, n, aptr, qt, ostr, fstr, ps, post)
}

/// The tail of `paramsubst` from `(#)` on: lengths, joining and
/// splitting, case, escapes, quoting, sorting, padding, `(e)`, and the
/// result spliced into the word list.
#[expect(
	clippy::too_many_arguments,
	clippy::too_many_lines,
	reason = "a faithful port of one C function"
)]
#[allow(clippy::many_single_char_names, reason = "a direct port of zsh's finish")]
fn finish(
	ex: &mut Expander<'_, '_>,
	l: &mut List,
	n: usize,
	aptr: usize,
	qt: bool,
	ostr: &[u8],
	fstr: Vec<u8>,
	mut ps: Ps,
	mut p: Post,
) -> X<Option<(usize, usize)>> {
	let mut fstr = fstr;
	let mut aptr = aptr;
	let mut n = n;
	if p.evalchar {
		if ps.isarr != 0 {
			let a = ps.aval.take().unwrap_or_default();
			let mut out = Vec::with_capacity(a.len());
			for e in a {
				out.push(substevalchar(ex, &e)?);
			}
			ps.aval = Some(out);
		} else {
			ps.val = substevalchar(ex, &ps.val)?;
		}
		p.ms_flags = 0;
	}
	if p.getlen != 0 {
		let seps = params::seps(ex)?;
		let len = if ps.isarr != 0 {
			let a = ps.aval.as_deref().unwrap_or_default();
			if p.getlen == 1 {
				a.len()
			} else if p.getlen == 2 {
				let sl = p.sep.as_deref().map_or(1, |s| text::strlen_chars(s, p.mb));
				if a.is_empty() {
					0
				} else {
					a.iter().map(|e| text::strlen_chars(e, p.mb)).sum::<usize>() + sl * (a.len() - 1)
				}
			} else {
				a.iter()
					.map(|e| text::wordcount(&seps, e, p.spsep.as_deref(), i32::from(p.getlen > 3)))
					.sum()
			}
		} else {
			count_len(&seps, &ps.val, p.spsep.as_deref(), p.getlen)
		};
		ps.val = len.to_string().into_bytes();
		ps.isarr = 0;
		p.ms_flags = 0;
	}
	// The YUK chunk.
	l.array = ps.isarr != 0;
	if ps.isarr > 0 && !p.plan9 && ps.aval.as_ref().is_none_or(Vec::is_empty) {
		ps.val = Vec::new();
		ps.isarr = 0;
	} else if ps.isarr != 0 && ps.aval.as_ref().is_some_and(|a| a.len() == 1) {
		ps.val = ps
			.aval
			.as_ref()
			.and_then(|a| a.first())
			.cloned()
			.unwrap_or_default();
		ps.isarr = 0;
	}
	if p.ssub || p.spbreak != 0 || p.spsep.is_some() || p.sep.is_some() || p.quoted_array_with_offset
	{
		let force_split = !p.ssub && (p.spbreak != 0 || p.spsep.is_some());
		if ps.isarr != 0 || p.quoted_array_with_offset {
			let a = ps.aval.clone().unwrap_or_default();
			if p.nojoin == 0 || p.sep.is_some() {
				ps.val = text::sepjoin(&a, p.sep.as_deref(), p.ifs.as_deref(), p.mb);
				ps.isarr = 0;
			} else if force_split
				&& (p.spsep.is_some() || p.nojoin == 2 || (p.ifs.is_none() && ps.isarr < 0))
			{
				let j = if p.nojoin == 1 {
					None
				} else {
					p.spsep.as_deref()
				};
				ps.val = text::sepjoin(&a, j, p.ifs.as_deref(), p.mb);
				ps.isarr = 0;
			}
			if ps.isarr == 0 {
				p.ms_flags = 0;
			}
		}
		if force_split && ps.isarr == 0 {
			let seps = params::seps(ex)?;
			let a = text::sepsplit(&seps, &ps.val, p.spsep.as_deref(), true);
			if a.is_empty() {
				ps.val = Vec::new();
			} else if a.len() == 1 {
				ps.val = a.into_iter().next().unwrap_or_default();
			} else {
				ps.aval = Some(a);
				ps.isarr = if p.nojoin != 0 { 1 } else { 2 };
			}
		}
		l.array = ps.isarr != 0;
	}
	if let Some(cm) = p.casmod {
		if ps.isarr != 0 {
			ps.aval = Some(
				ps.aval
					.take()
					.unwrap_or_default()
					.iter()
					.map(|e| text::casemodify(e, cm, p.mb))
					.collect(),
			);
		} else {
			ps.val = text::casemodify(&ps.val, cm, p.mb);
		}
	}
	if p.getkeys >= 0 {
		let mut how = 0;
		if p.getkeys & 2 != 0 {
			how |= text::getkey::EMACS;
		}
		if p.getkeys & 1 != 0 {
			how |= text::getkey::OCTAL_ESC;
		}
		if p.getkeys & 4 != 0 {
			how |= text::getkey::CTRL;
		}
		let conv = |s: &[u8]| metafy(&text::getkeystring(s, how).text);
		if ps.isarr != 0 {
			ps.aval = Some(
				ps.aval
					.take()
					.unwrap_or_default()
					.iter()
					.map(|e| conv(e))
					.collect(),
			);
		} else {
			ps.val = conv(&ps.val);
		}
	}
	if p.presc > 0 {
		// `(%)`: escapes only (`PROMPT_PERCENT` alone); `(%%)`: as the
		// shell's prompt options say.
		let opts = (p.presc < 2).then_some((true, false, false));
		let expand = |ex: &mut Expander<'_, '_>, s: &[u8]| -> X<Vec<u8>> {
			let mut s = s.to_vec();
			untokenize(&mut s);
			let out =
				crate::bash::vm::builtins::zsh_print::expand_prompt(ex, &unmetafy(&s), opts, false)?;
			Ok(metafy(&out))
		};
		if ps.isarr != 0 {
			let a = ps.aval.take().unwrap_or_default();
			let mut out = Vec::with_capacity(a.len());
			for e in a {
				out.push(expand(ex, &e)?);
			}
			ps.aval = Some(out);
		} else {
			let v = std::mem::take(&mut ps.val);
			ps.val = expand(ex, &v)?;
		}
	}
	if p.quotemod != 0 {
		let o = quote_opts(ex)?;
		let (pre, post): (&[u8], &[u8]) = if p.quotemod > 0 {
			match p.quotetype {
				qt::DOLLARS => (b"$'", b"'"),
				qt::SINGLE => (b"'", b"'"),
				qt::DOUBLE => (b"\"", b"\""),
				_ => (b"", b""),
			}
		} else {
			(b"", b"")
		};
		let quote = |ex: &mut Expander<'_, '_>, s: &[u8]| -> X<Vec<u8>> {
			if p.quotemod > 0 {
				Ok(match p.quotetype {
					qt::QUOTEDZPUTS => {
						// zsh `quotedzputs` reads the untokenized text
						// (`is_mb_niceformat`, `hasspecial`).
						let mut raw = s.to_vec();
						untokenize(&mut raw);
						let (bang, bang_special) =
							params::bang_quoting(&mut ex.k.root, ex.cx.store, ex.vp);
						let cs = zsh_quote::Charset {
							utf8: opt(ex, ZshOpt::Multibyte)?
								&& crate::bash::vm::locale::is_utf8(ex.k, ex.cx.store, ex.vp),
							print_eight: opt(ex, ZshOpt::Printeightbit)?,
							bang,
							bang_special,
						};
						metafy(&zsh_quote::quotedzputs(&unmetafy(&raw), o.rcquotes, cs))
					},
					t if t > qt::BACKSLASH => {
						let style = match t {
							qt::SINGLE => text::Qt::Single,
							qt::DOUBLE => text::Qt::Double,
							qt::DOLLARS => text::Qt::Dollars,
							qt::SINGLE_OPTIONAL => text::Qt::SingleOptional,
							_ => text::Qt::BackslashPattern,
						};
						let mut v = pre.to_vec();
						v.extend_from_slice(&text::quotestring(s, style, o));
						v.extend_from_slice(post);
						v
					},
					_ => text::quotestring(s, text::Qt::BackslashShownull, o),
				})
			} else {
				let mut v = match parse_subst_string(s) {
					Ok(v) => v,
					Err(_) if !p.quoteerr => s.to_vec(),
					// The lexer's own message comes first (zsh `zerr`
					// prints only the first error).
					Err(Some(msg)) => return Err(zerr(BString::from(msg))),
					Err(None) => return Err(zerr("parse error in parameter value")),
				};
				let _ = ex;
				crate::bash::pattern::zsh::remnulargs(&mut v);
				untokenize(&mut v);
				Ok(v)
			}
		};
		if ps.isarr != 0 {
			let a = ps.aval.take().unwrap_or_default();
			let mut out = Vec::with_capacity(a.len());
			for e in a {
				out.push(quote(ex, &e)?);
			}
			ps.aval = Some(out);
		} else {
			let v = std::mem::take(&mut ps.val);
			ps.val = quote(ex, &v)?;
		}
	}
	if p.mods != 0 {
		let one = |ex: &mut Expander<'_, '_>, s: &[u8]| -> X<Vec<u8>> {
			let mut s = s.to_vec();
			if p.mods & 1 != 0 {
				s = substnamedir(ex, &s)?;
			}
			if p.mods & 2 != 0 {
				s = text::nicedupstring(&s, p.mb);
			}
			Ok(s)
		};
		if ps.isarr != 0 {
			let a = ps.aval.take().unwrap_or_default();
			let mut out = Vec::with_capacity(a.len());
			for e in a {
				out.push(one(ex, &e)?);
			}
			ps.aval = Some(out);
		} else {
			let v = std::mem::take(&mut ps.val);
			ps.val = one(ex, &v)?;
		}
	}
	if p.shsplit != 0 {
		// zsh `bufferwords` lexes under the shell's options.
		let feat = crate::bash::vm::mode::features(
			&mut ex.k.root,
			ex.cx.store,
			ex.vp,
			crate::bash::syntax::Features::NONE,
		)?;
		let mut words: Vec<Vec<u8>> = Vec::new();
		if ps.isarr != 0 {
			for mut e in ps.aval.take().unwrap_or_default() {
				untokenize(&mut e);
				words.extend(crate::bash::syntax::zsh::bufferwords(&e, p.shsplit, feat));
			}
			ps.isarr = 0;
		} else {
			untokenize(&mut ps.val);
			words = crate::bash::syntax::zsh::bufferwords(&ps.val, p.shsplit, feat);
		}
		if words.is_empty() {
			ps.val = Vec::new();
		} else if words.len() == 1 {
			ps.val = words.into_iter().next().unwrap_or_default();
		} else {
			ps.aval = Some(words);
			ps.isarr = if p.nojoin != 0 { 1 } else { 2 };
			l.array = true;
		}
	}
	if ps.isarr != 0 && p.ssub {
		ps.val = text::sepjoin(ps.aval.as_deref().unwrap_or_default(), None, p.ifs.as_deref(), p.mb);
		ps.isarr = 0;
		l.array = false;
	}
	// Whitespace at the start or end of a splitting `${x:- …}`.
	let ostart = if p.ms_flags & MULTSUB_WS_AT_START != 0 && aptr > 0 {
		l.insert(n, head(ostr, aptr).to_vec());
		n += 1;
		aptr
	} else {
		0
	};
	if p.ms_flags & MULTSUB_WS_AT_END != 0 && !fstr.is_empty() {
		l.insert(n + 1, std::mem::take(&mut fstr));
	}
	let ostr = tail(ostr, ostart);
	aptr -= ostart;
	if p.arrasg != 0 && ps.isarr == 0 {
		l.array = true;
		ps.aval = Some(vec![ps.val.clone()]);
		ps.isarr = 1;
	}
	let globsubst = p.globsubst != 0;
	let nul = || vec![NULARG];
	if ps.isarr != 0 {
		let mut aval = ps.aval.take().unwrap_or_default();
		if p.unique && aval.len() > 1 {
			uniq(&mut aval);
		}
		if aval.len() <= 1 && !p.plan9 {
			let mut prefix = head(ostr, aptr).to_vec();
			let mut rest = fstr;
			if prefix.last() == Some(&DNULL) && rest.first() == Some(&DNULL) {
				prefix.pop();
				rest.remove(0);
			}
			let v = aval.into_iter().next().unwrap_or_default();
			let mut y = prefix;
			y.extend_from_slice(&v);
			let after = y.len();
			y.extend_from_slice(&rest);
			l.set(n, y);
			return Ok(Some((n, after)));
		}
		if p.sortit != 0 {
			if p.indord {
				if p.sortit & SORTIT_BACKWARDS != 0 {
					aval.reverse();
				}
			} else {
				let coll = params::collator(ex);
				strmetasort(&mut aval, p.sortit, coll.as_ref());
			}
		}
		let pad = |x: &[u8]| -> Vec<u8> {
			if p.prenum != 0 || p.postnum != 0 {
				dopadding(
					x,
					usize::try_from(p.prenum).unwrap_or(0),
					usize::try_from(p.postnum).unwrap_or(0),
					p.preone.as_deref(),
					p.postone.as_deref(),
					&p.premul,
					&p.postmul,
					p.ifs.as_deref(),
					p.mb,
				)
			} else {
				x.to_vec()
			}
		};
		let evalx = |x: Vec<u8>| -> X<Vec<u8>> {
			if p.eval {
				subst_parse_str(&x, qt && p.nojoin == 0)
					.ok_or_else(|| zerr("parse error in parameter value"))
			} else {
				Ok(x)
			}
		};
		let on = n;
		if p.plan9 {
			let mut tl = List::one({
				let mut t = vec![MARKER];
				t.extend_from_slice(&fstr);
				t
			});
			if !p.eval {
				let mut rf = 0;
				stringsubst(ex, &mut tl, 0, if p.ssub { PREFORK_SINGLE } else { 0 }, &mut rf, false)?;
			}
			let mut replaced = false;
			let mut cur = n;
			for x in aval {
				let x = evalx(pad(&x))?;
				for node in tl.nodes.iter().filter(|t| t.first() == Some(&MARKER)) {
					let (mut y, _) = strcatsub(head(ostr, aptr), &x, tail(node, 1), globsubst, p.shglob);
					if qt && y.is_empty() && ps.isarr != 2 {
						y = nul();
					}
					if replaced {
						l.insert(cur + 1, y);
						cur += 1;
					} else {
						l.set(cur, y);
						replaced = true;
					}
				}
			}
			for node in tl.nodes.iter().filter(|t| t.first() != Some(&MARKER)) {
				let mut y = node.clone();
				if qt && y.is_empty() && ps.isarr != 2 {
					y = nul();
				}
				if replaced {
					l.insert(cur + 1, y);
					cur += 1;
				} else {
					l.set(cur, y);
					replaced = true;
				}
			}
			if !replaced {
				l.remove(n);
				return Ok(None);
			}
			return Ok(Some((on, 0)));
		}
		let count = aval.len();
		let mut it = aval.into_iter();
		let x = evalx(pad(&it.next().unwrap_or_default()))?;
		let (mut y, _) = strcatsub(head(ostr, aptr), &x, &[], globsubst, p.shglob);
		if qt && y.is_empty() && ps.isarr != 2 {
			y = nul();
		}
		l.set(n, y);
		for _ in 1..count - 1 {
			let x = evalx(pad(&it.next().unwrap_or_default()))?;
			let y = if qt && x.is_empty() && ps.isarr != 2 {
				nul()
			} else {
				let mut y = x;
				if globsubst {
					crate::bash::pattern::zsh::shtokenize(&mut y, p.shglob);
				}
				y
			};
			l.insert(n + 1, y);
			n += 1;
		}
		let x = evalx(pad(&it.next().unwrap_or_default()))?;
		let (mut y, _) = strcatsub(&[], &x, &fstr, globsubst, p.shglob);
		if qt && y.is_empty() && ps.isarr != 2 {
			y = nul();
		}
		l.insert(n + 1, y);
		return Ok(Some((on, 0)));
	}
	let mut x = ps.val;
	if p.prenum != 0 || p.postnum != 0 {
		x = dopadding(
			&x,
			usize::try_from(p.prenum).unwrap_or(0),
			usize::try_from(p.postnum).unwrap_or(0),
			p.preone.as_deref(),
			p.postone.as_deref(),
			&p.premul,
			&p.postmul,
			p.ifs.as_deref(),
			p.mb,
		);
	}
	if p.eval {
		x = subst_parse_str(&x, qt && p.nojoin == 0)
			.ok_or_else(|| zerr("parse error in parameter value"))?;
	}
	let (mut y, after) = strcatsub(head(ostr, aptr), &x, &fstr, globsubst, p.shglob);
	if qt && y.is_empty() {
		y = nul();
	}
	l.set(n, y);
	Ok(Some((n, if p.eval { aptr } else { after })))
}

// ---- entry points --------------------------------------------------------

/// zsh's `globlist` split: the words of `list` after substitution, quote
/// nulls removed, unmetafied, into `out`; with `globs`, every word with
/// active wildcards is also recorded (`(index, tokenized word)`) for the
/// filename-generation stage.
fn finish_words(
	ex: &mut Expander<'_, '_>,
	list: List,
	out: &mut Vec<BString>,
	globs: Option<&mut Vec<(u32, BString)>>,
	key_value: bool,
) -> X<()> {
	let glob_on = globs.is_some() && opt(ex, ZshOpt::Glob)?;
	let popts = if glob_on {
		Some(zpattern::opts(ex)?)
	} else {
		None
	};
	let mut globs = globs;
	let mut skip = 0;
	for mut w in list.nodes {
		if skip > 0 {
			skip -= 1;
			let mut u = w;
			untokenize(&mut u);
			out.push(BString::from(unmetafy(&u)));
			continue;
		}
		if key_value && w.first() == Some(&MARKER) {
			skip = 2;
			out.push(BString::from(w));
			continue;
		}
		if let (Some(g), Some(o)) = (globs.as_deref_mut(), popts.as_ref()) {
			let mut probe = w.clone();
			if crate::bash::pattern::zsh::haswilds(&mut probe, o) {
				let idx = u32::try_from(out.len()).unwrap_or(u32::MAX);
				g.push((idx, BString::from(probe)));
				let mut u = w;
				untokenize(&mut u);
				out.push(BString::from(unmetafy(&u)));
				continue;
			}
		}
		untokenize(&mut w);
		out.push(BString::from(unmetafy(&w)));
	}
	Ok(())
}

/// Expand the zsh word `word` (tokstr) into fields: `prefork`, then the
/// `globlist` split ([`finish_words`]). `kind` selects the `prefork`
/// flags of command arguments (magic `=`), typeset arguments and
/// assignment values.
///
/// # Errors
/// Any substitution error; [`Stop::ZshSub`] parks.
pub fn fields(
	ex: &mut Expander<'_, '_>,
	word: &[u8],
	kind: WordKind,
	out: &mut Vec<BString>,
	globs: Option<&mut Vec<(u32, BString)>>,
) -> X<()> {
	let flags = match kind {
		WordKind::DeclArg => PREFORK_TYPESET | PREFORK_SINGLE,
		WordKind::Assign => PREFORK_ASSIGN,
		_ if opt(ex, ZshOpt::Magicequalsubst)? => PREFORK_TYPESET,
		_ => 0,
	};
	let mut list = List::one(word.to_vec());
	let mut rf = 0;
	prefork(ex, &mut list, flags, &mut rf)?;
	finish_words(ex, list, out, globs, rf & PREFORK_KEY_VALUE != 0)
}

/// The zsh text of IR word `w` of `unit` (a word of one
/// [`Part::Zsh`](crate::bash::ir::Part::Zsh)); `None` for any other word.
fn zsh_word(unit: &crate::bash::ir::Unit, w: u32) -> Option<&[u8]> {
	match unit.words.get(w as usize)?.parts.as_slice() {
		[crate::bash::ir::Part::Zsh(t)] => Some(t.as_slice()),
		_ => None,
	}
}

/// The target of a zsh assignment: `name`, or `name[subscript]` with the
/// subscript word's text untokenized (zsh `addvars` untokenizes the name;
/// `getindex` tokenizes the subscript again).
fn assign_target(unit: &crate::bash::ir::Unit, a: &crate::bash::ir::AssignOp) -> Vec<u8> {
	let mut name = metafy(&a.name);
	if let Some(w) = a.index {
		name.push(b'[');
		if let Some(t) = zsh_word(unit, w) {
			let mut t = t.to_vec();
			untokenize(&mut t);
			name.extend_from_slice(&t);
		}
		name.push(b']');
	}
	name
}

/// A `GLOB_ASSIGN` value waiting for filename generation: the value and
/// its glob (see [`assign_scalar`]).
pub type GlobAssign = (Vec<BString>, Vec<(u32, BString)>);

/// A zsh scalar assignment statement `name=word` / `name[sub]=word` /
/// `name+=word` (zsh `addvars` with `PREFORK_SINGLE|PREFORK_ASSIGN`, then
/// `assignsparam`). Under `GLOB_ASSIGN` a value with wildcards goes
/// through filename generation instead: `Some` holds the value and its
/// glob for that stage, then [`assign_globbed`] assigns the result.
/// `shown` (for `xtrace`) gets the value assigned, unmetafied.
///
/// # Errors
/// Substitution and assignment errors; [`Stop::ZshSub`] parks.
pub fn assign_scalar(
	ex: &mut Expander<'_, '_>,
	unit: &crate::bash::ir::Unit,
	a: &crate::bash::ir::AssignOp,
	shown: Option<&mut BString>,
) -> X<Option<GlobAssign>> {
	let crate::bash::ir::AssignVal::Scalar(w) = a.value else {
		return Ok(None);
	};
	let word = zsh_word(unit, w).map_or_default(<[u8]>::to_vec);
	let list = if let Some(val) = simple_value(ex, &word)? {
		List::one(val)
	} else {
		let mut list = List::one(word);
		let mut rf = 0;
		prefork(ex, &mut list, PREFORK_SINGLE | PREFORK_ASSIGN, &mut rf)?;
		list
	};
	if opt(ex, ZshOpt::Globassign)? {
		let popts = zpattern::opts(ex)?;
		let mut probe = list.nodes.first().cloned().unwrap_or_default();
		if crate::bash::pattern::zsh::haswilds(&mut probe, &popts) {
			let mut out = Vec::new();
			let mut globs = Vec::new();
			finish_words(ex, list, &mut out, Some(&mut globs), false)?;
			return Ok(Some((out, globs)));
		}
	}
	let mut val = list.nodes.into_iter().next().unwrap_or_default();
	untokenize(&mut val);
	if let Some(shown) = shown {
		*shown = BString::from(unmetafy(&val));
	}
	let target = assign_target(unit, a);
	let flags = params::ASSPM_WARN | if a.append { params::ASSPM_AUGMENT } else { 0 };
	effect(ex, |ex| params::assignsparam_meta(ex, &target, val, flags)).map(|()| None)
}

/// The value of assignment word `word` (tokenized, metafied) when it is
/// only literal text and plain `$name` references to direct scalars or
/// integers ([`params::direct_text`]), as `prefork` would leave it; `None`
/// for any other word (quoting, braces, subscripts, `$name:mods`, tilde
/// and `=` expansion, other substitutions), or when `GLOB_SUBST` or
/// `GLOB_ASSIGN` could make the substituted text a pattern.
///
/// # Errors
/// A store failure.
fn simple_value(ex: &mut Expander<'_, '_>, word: &[u8]) -> X<Option<Vec<u8>>> {
	if !word.contains(&STRING) {
		return Ok(None);
	}
	let mut out = Vec::with_capacity(word.len() + 16);
	let mut i = 0;
	while i < word.len() {
		match word[i] {
			META => {
				out.extend_from_slice(span(word, i, i + 2));
				i += 2;
			},
			STRING => {
				let start = i + 1;
				let mut end = start;
				while word
					.get(end)
					.is_some_and(|c| c.is_ascii_alphanumeric() || *c == b'_')
				{
					end += 1;
				}
				// A subscript, modifiers or a multibyte name continue it.
				if end == start
					|| word[start].is_ascii_digit()
					|| word
						.get(end)
						.is_some_and(|&c| matches!(c, b'[' | b':') || c >= 0x80)
				{
					return Ok(None);
				}
				let Some(text) = params::direct_text(ex, &word[start..end])? else {
					return Ok(None);
				};
				out.extend_from_slice(&text);
				i = end;
			},
			c if c >= META => return Ok(None),
			c => {
				out.push(c);
				i += 1;
			},
		}
	}
	if opt(ex, ZshOpt::Globsubst)? || opt(ex, ZshOpt::Globassign)? {
		return Ok(None);
	}
	Ok(Some(out))
}

/// A `GLOB_ASSIGN` scalar assignment after filename generation (zsh
/// `addvars`): the parameter is unset so it is created again, a scalar
/// for one word (or none), an array for more.
///
/// # Errors
/// Assignment errors.
pub fn assign_globbed(
	ex: &mut Expander<'_, '_>,
	unit: &crate::bash::ir::Unit,
	a: &crate::bash::ir::AssignOp,
	words: Vec<BString>,
) -> X<()> {
	let target = assign_target(unit, a);
	// zsh's `unsetparam` finds no parameter called `name[sub]`.
	if a.index.is_none() {
		params::unsetparam(ex, &target)?;
	}
	let flags = params::ASSPM_WARN | if a.append { params::ASSPM_AUGMENT } else { 0 };
	if words.len() <= 1 {
		let val = words.first().map_or_else(Vec::new, |w| metafy(w));
		return params::assignsparam_meta(ex, &target, val, flags);
	}
	let val: Vec<Vec<u8>> = words.iter().map(|w| metafy(w)).collect();
	params::assignaparam_meta(ex, &target, val, flags)
}

/// The elements of a zsh array assignment `name=(…)`, expanded (zsh
/// `prefork` with `PREFORK_ASSIGN`): `[key]=value` elements become
/// `Marker`, key, value triples. Elements with active wildcards are
/// recorded in `globs` for the filename-generation stage. Returns whether
/// triples were found.
///
/// # Errors
/// Substitution errors; [`Stop::ZshSub`] parks.
pub fn assign_elems(
	ex: &mut Expander<'_, '_>,
	unit: &crate::bash::ir::Unit,
	a: &crate::bash::ir::AssignOp,
	out: &mut Vec<BString>,
	globs: &mut Vec<(u32, BString)>,
) -> X<bool> {
	let crate::bash::ir::AssignVal::Array(elems) = &a.value else {
		return Ok(false);
	};
	let text = |w: u32| zsh_word(unit, w).map_or_default(<[u8]>::to_vec);
	let mut list = List::default();
	for e in elems {
		match e.key {
			Some(k) => {
				// `[key]=value` already split by the parser: rebuild the
				// word zsh's `keyvalpairelement` reads.
				let mut w = vec![INBRACK];
				w.extend_from_slice(&text(k));
				w.push(OUTBRACK);
				if e.append {
					w.push(b'+');
				}
				w.push(EQUALS);
				w.extend_from_slice(&text(e.value));
				list.nodes.push(w);
			},
			None => list.nodes.push(text(e.value)),
		}
	}
	let mut rf = 0;
	prefork(ex, &mut list, PREFORK_ASSIGN, &mut rf)?;
	let kv = rf & PREFORK_KEY_VALUE != 0;
	finish_words(ex, list, out, Some(globs), kv)?;
	Ok(kv)
}

/// Assign the expanded elements of a zsh array assignment (zsh
/// `assignaparam`, or `sethparam` semantics through it for an
/// association): `kv` says they hold `Marker`/key/value triples.
///
/// # Errors
/// Assignment errors.
pub fn assign_array(
	ex: &mut Expander<'_, '_>,
	unit: &crate::bash::ir::Unit,
	a: &crate::bash::ir::AssignOp,
	elems: Vec<BString>,
	kv: bool,
) -> X<()> {
	let target = assign_target(unit, a);
	let mut flags = params::ASSPM_WARN;
	if a.append {
		flags |= params::ASSPM_AUGMENT;
	}
	if kv {
		flags |= params::ASSPM_KEY_VALUE;
	}
	let val: Vec<Vec<u8>> = elems
		.iter()
		.map(|e| {
			if e.first() == Some(&MARKER) {
				e.to_vec()
			} else {
				metafy(e)
			}
		})
		.collect();
	params::assignaparam_meta(ex, &target, val, flags)
}

/// Expand the zsh word `word` to one string (zsh `singsub` + quote
/// removal): assignment values (`PREFORK_SINGLE|PREFORK_ASSIGN` with
/// `~`/`=` after `:`), here-strings, `case` subjects, redirection
/// targets. Raw bytes.
///
/// # Errors
/// As [`fields`].
pub fn scalar(ex: &mut Expander<'_, '_>, word: &[u8], kind: WordKind) -> X<BString> {
	let flags = match kind {
		WordKind::Assign | WordKind::AssignArg => PREFORK_SINGLE | PREFORK_ASSIGN,
		WordKind::DeclArg => PREFORK_SINGLE | PREFORK_TYPESET,
		_ => PREFORK_SINGLE,
	};
	let mut list = List::one(word.to_vec());
	let mut rf = 0;
	prefork(ex, &mut list, flags, &mut rf)?;
	let mut w = list.nodes.into_iter().next().unwrap_or_default();
	untokenize(&mut w);
	Ok(BString::from(unmetafy(&w)))
}

/// Expand the zsh word `word` as a pattern (`case`, `[[ = ]]`): `singsub`
/// keeping tokens, quote nulls removed; metafied, tokenized.
///
/// # Errors
/// As [`fields`].
pub fn pattern(ex: &mut Expander<'_, '_>, word: &[u8]) -> X<BString> {
	let mut w = singsub(ex, word.to_vec())?;
	crate::bash::pattern::zsh::remnulargs(&mut w);
	Ok(BString::from(w))
}

/// A here-document body (raw text, unquoted delimiter): tokenized as zsh
/// does (`parsestr`), substituted, quote nulls removed. Raw bytes.
///
/// # Errors
/// A parse error, any substitution error.
pub fn heredoc(ex: &mut Expander<'_, '_>, raw: &[u8]) -> X<BString> {
	let toks = crate::bash::syntax::zsh::parsestr(&metafy(raw)).map_err(|c| {
		if (33..=126).contains(&c) {
			zerr(format!("parse error near `{}'", char::from(c)))
		} else {
			zerr("parse error")
		}
	})?;
	let mut w = singsub(ex, toks)?;
	untokenize(&mut w);
	Ok(BString::from(unmetafy(&w)))
}

/// The value of arithmetic text `src` (a tokstr: `(( ))`, `for ((;;))`,
/// `repeat`): substituted (zsh `singsub`), then evaluated.
///
/// # Errors
/// A substitution or math error.
pub fn arith_value(ex: &mut Expander<'_, '_>, src: &[u8]) -> X<Number> {
	let e = if crate::bash::syntax::zsh::tok::has_token(src) {
		singsub(ex, src.to_vec())?
	} else {
		src.to_vec()
	};
	if let Some(Atom::Str(Some(s))) = replay(ex) {
		let t = std::str::from_utf8(&s).unwrap_or("0");
		return Ok(t
			.parse::<i64>()
			.map_or_else(|_| Number::Float(t.parse().unwrap_or(0.0)), Number::Int));
	}
	let v = arith::matheval(ex, &e)?;
	note(ex, || {
		Atom::Str(Some(BString::from(match v {
			Number::Int(i) => i.to_string(),
			Number::Float(f) => format!("{f:?}"),
		})))
	});
	Ok(v)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn numeric_sort_compares_digit_runs() {
		let mut v: Vec<Vec<u8>> = ["a10", "a9", "a100", "b1"]
			.iter()
			.map(|s| s.as_bytes().to_vec())
			.collect();
		strmetasort(&mut v, SORTIT_SOMEHOW | SORTIT_NUMERICALLY, None);
		let got: Vec<&[u8]> = v.iter().map(Vec::as_slice).collect();
		assert_eq!(got, [&b"a9"[..], b"a10", b"a100", b"b1"]);
		strmetasort(&mut v, SORTIT_SOMEHOW | SORTIT_BACKWARDS, None);
		let got: Vec<&[u8]> = v.iter().map(Vec::as_slice).collect();
		assert_eq!(got, [&b"b1"[..], b"a9", b"a100", b"a10"]);
	}

	#[test]
	fn padding_matches_zsh() {
		// zsh: x=abc; print -r
		// "${(l:5:)x}|${(r:5::-:)x}|${(l:2:)x}|${(l:7::12:)x}"
		assert_eq!(dopadding(b"abc", 5, 0, None, None, b" ", b" ", None, false), b"  abc");
		assert_eq!(dopadding(b"abc", 0, 5, None, None, b" ", b"-", None, false), b"abc--");
		assert_eq!(dopadding(b"abc", 2, 0, None, None, b" ", b" ", None, false), b"bc");
		assert_eq!(dopadding(b"abc", 7, 0, None, None, b"12", b" ", None, false), b"1212abc");
		// zsh: print -r "${(l:7::1::X:)x}" → 111Xabc
		assert_eq!(dopadding(b"abc", 7, 0, Some(b"X"), None, b"1", b" ", None, false), b"111Xabc");
		// zsh: x=été; print -r "${(l:4::¥:)x}" → ¥été
		assert_eq!(
			dopadding("été".as_bytes(), 4, 0, None, None, "¥".as_bytes(), b" ", None, true),
			"¥été".as_bytes()
		);
	}

	#[test]
	fn strcatsub_splices() {
		let (w, after) = strcatsub(b"pre", b"mid", b"post", false, false);
		assert_eq!(w, b"premidpost");
		assert_eq!(after, 6);
	}
}
