//! Word expansion: tilde, parameters (every `${…}` operator), command
//! substitution, arithmetic, field splitting and quote removal.
//!
//! # Replay log
//!
//! Expansion has side effects (`${x:=v}`, `$((i++))`) and may need to run a
//! command substitution, which parks the op. When a word can park
//! ([`Word::parks`]), every leaf step (a parameter read, a side effect, an
//! arithmetic evaluation, a substitution's output) is recorded as an
//! [`Atom`]. After the substitution finishes, the op re-runs the expansion:
//! recorded steps return their logged result instead of running again, so
//! nothing happens twice and every value is the one the first pass saw.
//!
//! Pathname expansion (pollable `read_dir`) is a separate stage of `Exec`.

use std::{borrow::Cow, fmt::NumBuffer, sync::Arc};

use bstr::{BStr, BString, ByteSlice};

use super::{
	Cx, Kernel, arith,
	proc::{Atom, Vproc},
	quote,
	state::{self, Level, Var, VarEdit},
};
use crate::bash::{
	diag::Diag,
	event::WaitKey,
	ir::{
		CaseIr, ComsubForm, OpIr, ParamIr, ParamRef, Part, ReplaceIr, SubIr, Unit, Word, WordKind,
	},
	pattern::{PatOpts, Pattern},
	store::{Attrs, Elem, OptId, StoreError, VarValue},
};

/// Default `IFS`.
pub const DEFAULT_IFS: &[u8] = b" \t\n";

/// `$-` letters in bash's order.
const FLAG_OPTS: [OptId; 19] = [
	OptId::Allexport,
	OptId::Notify,
	OptId::Errexit,
	OptId::Noglob,
	OptId::Hashall,
	OptId::Keyword,
	OptId::Monitor,
	OptId::Noexec,
	OptId::Privileged,
	OptId::Onecmd,
	OptId::Nounset,
	OptId::Verbose,
	OptId::Xtrace,
	OptId::Braceexpand,
	OptId::Noclobber,
	OptId::Errtrace,
	OptId::Histexpand,
	OptId::Physical,
	OptId::Functrace,
];

/// Why an expansion stopped.
pub enum Stop {
	/// A command substitution must run first (the op parks, then replays).
	Sub {
		/// Unit holding the body.
		unit:  Arc<Unit>,
		/// Entry pc of the body.
		entry: u32,
		/// Syntax form.
		form:  ComsubForm,
		/// `strs` index of a `$( )` body's source text.
		text:  Option<u32>,
	},
	/// A zsh command substitution must run first: `text` is its body (zsh
	/// source, parsed in the vproc's mode when it starts); the op parks,
	/// then replays.
	ZshSub {
		/// The body.
		text: BString,
	},
	/// A zsh expansion needs a file-system answer first (the PATH search of
	/// `=cmd`): the op performs the probe, logs its answer
	/// ([`super::exec::probe_atom`]) and replays.
	Probe(super::proc::Probe),
	/// `$!` names a background job whose pid is still to be settled
	/// ([`super::proc::Bang`]): the op blocks on that key, then replays.
	Wait(WaitKey),
	/// An expansion error: print it, abandon the current command.
	Fail(Diag),
	/// A fatal expansion error (`${x?}`, `set -u`): a non-interactive shell
	/// exits.
	Fatal(Diag),
	/// The state store failed.
	Store(StoreError),
}

impl From<StoreError> for Stop {
	fn from(e: StoreError) -> Self {
		Self::Store(e)
	}
}

pub type X<T> = Result<T, Stop>;

/// A parameter's value before an operator applies.
#[derive(Clone, Debug)]
enum Val {
	Unset,
	Str(BString),
	/// `$@`, `$*`, `${a[@]}`, `${a[*]}`.
	List {
		items: Vec<BString>,
		star:  bool,
	},
}

/// Where tilde-prefixes expand in a word.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Tilde {
	/// Nowhere (quoted, or run-time parsed text).
	Off,
	/// At the start of the word.
	Start,
	/// Also after each unquoted `:` (assignment values).
	Colon,
	/// Also after the first `=` and each unquoted `:` (assignment-like
	/// arguments).
	EqColon,
}

/// Position of a literal part, for tilde expansion.
#[derive(Clone, Copy)]
struct TildeAt {
	/// The part starts the word.
	first: bool,
	/// The part ends the word.
	last:  bool,
	mode:  Tilde,
}

/// Expansion context of one op in one vproc.
pub struct Expander<'e, 'c> {
	pub k:          &'e mut Kernel,
	pub cx:         &'e mut Cx<'c>,
	pub vp:         &'e mut Vproc,
	pub log:        &'e mut Vec<Atom>,
	pub cursor:     usize,
	/// Record atoms (the expansion may park).
	pub record:     bool,
	/// Script line, for `$LINENO` and diagnostics.
	pub line:       u32,
	/// Status of the last command substitution (`$?` of `x=$(…)`).
	pub sub_status: Option<i32>,
	/// The command evaluating arithmetic here (`((` for `(( ))` and the
	/// arith-`for` header): it prefixes non-fatal arithmetic warnings.
	pub arith_cmd:  Option<&'static str>,
	ifs:            IfsCache,
	/// `set -f` and `shopt extglob`, looked up once per expansion.
	glob_opts:      Option<GlobOpts>,
	/// Spare field buffers (the previous command's words): a field takes
	/// one, cleared, before it allocates, and an unused one goes back.
	pub pool:       Vec<BString>,
}

/// The cached value of `IFS` for one expansion (shared with the field
/// sinks, so a word does not copy it).
enum IfsCache {
	/// Not looked up yet.
	Unknown,
	/// Unset (default splitting).
	Unset,
	/// Set to this value.
	Set(Ifs),
}

/// Bytes of an `IFS` value kept inline.
const IFS_INLINE: usize = 22;

/// An `IFS` value as the expander keeps it: inline when short (the default
/// is 3 bytes), so reading it for every command allocates nothing; cheap
/// to clone into the field sinks.
#[derive(Clone)]
enum Ifs {
	Short { len: u8, bytes: [u8; IFS_INLINE] },
	Long(Arc<[u8]>),
}

impl Ifs {
	fn new(v: &[u8]) -> Self {
		if v.len() <= IFS_INLINE {
			let mut bytes = [0; IFS_INLINE];
			bytes[..v.len()].copy_from_slice(v);
			Self::Short { len: v.len() as u8, bytes }
		} else {
			Self::Long(Arc::from(v))
		}
	}
}

impl std::ops::Deref for Ifs {
	type Target = [u8];

	fn deref(&self) -> &[u8] {
		match self {
			Self::Short { len, bytes } => &bytes[..usize::from(*len)],
			Self::Long(v) => v,
		}
	}
}

/// The options pathname expansion depends on.
#[derive(Clone, Copy)]
struct GlobOpts {
	noglob:  bool,
	extglob: bool,
}

/// Output of an expansion.
enum Sink<'o> {
	Fields(Fields<'o>),
	Scalar(Vec<u8>),
	Pattern(Vec<u8>),
	/// The right side of `=~`: quoted bytes (and unquoted `CTLESC`/`CTLNUL`
	/// bytes) are prefixed with `CTLESC`, as bash marks them.
	Regex(Vec<u8>),
}

impl<'e, 'c> Expander<'e, 'c> {
	pub const fn new(
		k: &'e mut Kernel,
		cx: &'e mut Cx<'c>,
		vp: &'e mut Vproc,
		log: &'e mut Vec<Atom>,
		record: bool,
		line: u32,
	) -> Self {
		Self {
			k,
			cx,
			vp,
			log,
			cursor: 0,
			record,
			line,
			sub_status: None,
			arith_cmd: None,
			ifs: IfsCache::Unknown,
			glob_opts: None,
			pool: Vec::new(),
		}
	}

	fn glob_opts(&mut self) -> X<GlobOpts> {
		if let Some(o) = self.glob_opts {
			return Ok(o);
		}
		let o = GlobOpts {
			noglob:  state::option(&mut self.k.root, self.cx.store, self.vp, OptId::Noglob)?,
			extglob: state::option(&mut self.k.root, self.cx.store, self.vp, OptId::Extglob)?,
		};
		self.glob_opts = Some(o);
		Ok(o)
	}

	// ---- atoms -------------------------------------------------------------

	/// The next logged atom, when replaying.
	fn replay(&mut self) -> Option<Atom> {
		if !self.record || self.cursor >= self.log.len() {
			return None;
		}
		let a = self.log[self.cursor].clone();
		self.cursor += 1;
		Some(a)
	}

	/// Log the atom `a` makes when this expansion is recorded; otherwise
	/// `a` does not run (no copy of the value).
	fn note(&mut self, a: impl FnOnce() -> Atom) {
		if self.record {
			self.log.push(a());
			self.cursor += 1;
		}
	}

	/// Run a side effect once.
	fn effect(&mut self, f: impl FnOnce(&mut Self) -> X<()>) -> X<()> {
		if self.replay().is_some() {
			return Ok(());
		}
		f(self)?;
		self.note(|| Atom::Done);
		Ok(())
	}

	fn read_atom(&mut self, f: impl FnOnce(&mut Self) -> X<Val>) -> X<Val> {
		match self.replay() {
			Some(Atom::Str(None)) => return Ok(Val::Unset),
			Some(Atom::Str(Some(s))) => return Ok(Val::Str(s)),
			Some(Atom::List(items)) => return Ok(Val::List { items, star: false }),
			Some(_) | None => {},
		}
		let v = f(self)?;
		self.note(|| match &v {
			Val::Unset => Atom::Str(None),
			Val::Str(s) => Atom::Str(Some(s.clone())),
			Val::List { items, .. } => Atom::List(items.clone()),
		});
		Ok(v)
	}

	// ---- entry points ------------------------------------------------------

	/// Expand `w` to fields (splitting, quote removal).
	pub fn fields(&mut self, unit: &Arc<Unit>, w: &Word, out: &mut Vec<BString>) -> X<()> {
		self.fields_into(unit, w, out, None)
	}

	/// Expand `w` to fields like [`Self::fields`] and record the fields that
	/// need pathname expansion in `globs` (`(index in out, pattern)`), unless
	/// `set -f` is on.
	pub fn fields_glob(
		&mut self,
		unit: &Arc<Unit>,
		w: &Word,
		out: &mut Vec<BString>,
		globs: &mut Vec<(u32, BString)>,
	) -> X<()> {
		// A word whose glob characters are all quoted never needs the
		// pattern side (nor the `noglob` lookup).
		if w.noglob || self.glob_opts()?.noglob {
			return self.fields_into(unit, w, out, None);
		}
		self.fields_into(unit, w, out, Some(globs))
	}

	fn fields_into(
		&mut self,
		unit: &Arc<Unit>,
		w: &Word,
		out: &mut Vec<BString>,
		mut globs: Option<&mut Vec<(u32, BString)>>,
	) -> X<()> {
		if w.fixed && (w.noglob || globs.is_none()) {
			// Literal text is never split; with no active glob character
			// (or no pathname expansion) the field is the text itself.
			let mut field = spare(&mut self.pool);
			let mut quoted = false;
			for p in &w.parts {
				if let Part::Lit(b) | Part::Quoted(b) = p {
					quoted |= matches!(p, Part::Quoted(_));
					field.extend_from_slice(b);
				}
			}
			if quoted || !field.is_empty() || w.kind == WordKind::DeclArg {
				out.push(BString::from(field));
			} else if field.capacity() > 0 {
				self.pool.push(BString::from(field));
			}
			return Ok(());
		}
		// A quoted scalar parameter already is one complete field. Read it
		// into a recycled buffer without building a splitting/globbing sink.
		if w.braces.is_none()
			&& let [Part::Param(p)] = w.parts.as_slice()
			&& p.quoted
			&& matches!(p.op, OpIr::None)
		{
			let mut field = spare(&mut self.pool);
			if self
				.with_scalar(p, |s| field.extend_from_slice(s))?
				.is_some()
			{
				out.push(BString::from(field));
				return Ok(());
			}
			if field.capacity() > 0 {
				self.pool.push(BString::from(field));
			}
		}
		if let Some(alts) = &w.braces
			&& state::option(&mut self.k.root, self.cx.store, self.vp, OptId::Braceexpand)?
		{
			for &alt in &**alts {
				self.fields_into(unit, &unit.words[alt as usize], out, globs.as_deref_mut())?;
			}
			return Ok(());
		}
		if w.kind == WordKind::DeclArg {
			// `declare a=$x`: one field, neither split nor globbed.
			let v = self.scalar(unit, w)?;
			out.push(v);
			return Ok(());
		}
		// A word of only literal text is never split: skip the `IFS` lookup.
		let expands = w
			.parts
			.iter()
			.any(|p| !matches!(p, Part::Lit(_) | Part::Quoted(_)));
		let ifs = if expands { self.ifs()? } else { None };
		let extglob = match globs {
			Some(_) => self.glob_opts()?.extglob,
			None => false,
		};
		let cap = lit_len(w);
		// Splitting is per character in a UTF-8 locale; that differs from
		// per byte only when IFS has a non-ASCII byte.
		let utf8 = ifs.as_ref().is_some_and(|s| !s.is_ascii())
			&& super::locale::is_utf8(self.k, self.cx.store, self.vp);
		let globs = globs.map(|out| GlobSink { pat: Vec::with_capacity(cap), extglob, out });
		let mut pool = std::mem::take(&mut self.pool);
		let mut cur = spare(&mut pool);
		cur.reserve(cap);
		let mut sink =
			Sink::Fields(Fields { cur, have: false, out, ifs, globs, whole_at: false, utf8, pool });
		let res = self.word(unit, w, &mut sink, false, false);
		if let Sink::Fields(f) = &mut sink {
			if res.is_ok() && f.have {
				f.end();
			}
			if f.cur.capacity() > 0 {
				f.pool.push(BString::from(std::mem::take(&mut f.cur)));
			}
			self.pool = std::mem::take(&mut f.pool);
		}
		res
	}

	/// Expand `w` without splitting (assignments, here-strings, `case`).
	pub fn scalar(&mut self, unit: &Arc<Unit>, w: &Word) -> X<BString> {
		if w.fixed {
			return Ok(BString::from(fixed_text(w).into_owned()));
		}
		if let [Part::Param(p)] = w.parts.as_slice()
			&& matches!(p.op, OpIr::None)
			&& let Some(value) = self.with_scalar(p, |s| BString::from(s))?
		{
			return Ok(value);
		}
		let mut sink = Sink::Scalar(Vec::with_capacity(lit_len(w)));
		self.word(unit, w, &mut sink, false, false)?;
		match sink {
			Sink::Scalar(b) => Ok(BString::from(b)),
			_ => unreachable!(),
		}
	}

	/// Expand `w` as a pattern: quoted characters come back
	/// backslash-escaped.
	pub fn pattern(&mut self, unit: &Arc<Unit>, w: &Word) -> X<BString> {
		Ok(BString::from(self.pattern_text(unit, w)?.into_owned()))
	}

	/// [`Self::pattern`], borrowed from the IR for a [`Word::fixed`] word
	/// of one unquoted part (`${s##*/}`, `[[ $x == *7 ]]`).
	fn pattern_text<'w>(&mut self, unit: &Arc<Unit>, w: &'w Word) -> X<Cow<'w, [u8]>> {
		if w.fixed {
			return Ok(fixed_pattern(w));
		}
		let mut sink = Sink::Pattern(Vec::with_capacity(lit_len(w)));
		self.word(unit, w, &mut sink, false, false)?;
		match sink {
			Sink::Pattern(b) => Ok(Cow::Owned(b)),
			_ => unreachable!(),
		}
	}

	/// Expand `w` as the right side of `=~`: quoted characters special in
	/// an ERE come back backslash-escaped (bash's `cond_expand_word` with
	/// `QGLOB_REGEXP`).
	pub fn regex(&mut self, unit: &Arc<Unit>, w: &Word) -> X<BString> {
		let mut sink = Sink::Regex(Vec::new());
		self.word(unit, w, &mut sink, false, false)?;
		match sink {
			Sink::Regex(b) => Ok(BString::from(ere_quote(&b))),
			_ => unreachable!(),
		}
	}

	/// A zsh word ([`Part::Zsh`], its tokenized text) into `sink` through
	/// zsh's expander: fields (with the words needing filename generation
	/// recorded for the glob stage), a scalar (also the `=~` side), or a
	/// pattern (zsh pattern tokens kept). Out of line: the bash word loop
	/// does not carry it.
	#[inline(never)]
	fn zsh_word(&mut self, text: &[u8], kind: WordKind, sink: &mut Sink<'_>) -> X<()> {
		match sink {
			Sink::Fields(f) => super::zsh::subst::fields(
				self,
				text,
				kind,
				f.out,
				f.globs.as_mut().map(|g| &mut *g.out),
			),
			Sink::Scalar(b) | Sink::Regex(b) => {
				let v = super::zsh::subst::scalar(self, text, kind)?;
				b.extend_from_slice(&v);
				Ok(())
			},
			Sink::Pattern(b) => {
				let v = super::zsh::subst::pattern(self, text)?;
				b.extend_from_slice(&v);
				Ok(())
			},
		}
	}

	/// A zsh here-document body (raw text, unquoted delimiter) expanded as
	/// zsh does; the redirection stage of zsh units calls it.
	pub fn zsh_heredoc(&mut self, raw: &[u8]) -> X<BString> {
		super::zsh::subst::heredoc(self, raw)
	}

	/// Evaluate zsh arithmetic text (substituted first): `$(( ))`,
	/// `(( ))`, `repeat` counts and arithmetic `for` in zsh units.
	pub fn zsh_arith(&mut self, text: &[u8]) -> X<super::zsh::math::Number> {
		super::zsh::subst::arith_value(self, text)
	}

	/// Evaluate arithmetic text (expanded first) once.
	pub fn arith(&mut self, text: &[u8]) -> X<i64> {
		let expanded = self.expand_text(text)?;
		self.arith_eval(&expanded)
	}

	/// Evaluate already-expanded arithmetic text once (array subscripts:
	/// bash does not expand `${a[$i]}`'s subscript a second time, so a
	/// value holding `$(…)` is an arithmetic error, not a command).
	pub fn arith_eval(&mut self, expanded: &[u8]) -> X<i64> {
		if let Some(a) = self.replay() {
			if let Atom::Str(Some(v)) = a {
				return Ok(std::str::from_utf8(&v)
					.ok()
					.and_then(|v| v.parse().ok())
					.unwrap_or(0));
			}
			return Ok(0);
		}
		let v = {
			let mut env = Vars {
				k:        &mut *self.k,
				cx:       &mut *self.cx,
				vp:       &mut *self.vp,
				prefix:   self.arith_cmd,
				expanded: false,
			};
			arith::eval(expanded, &mut env)
		};
		match v {
			Ok(v) => {
				self.note(|| Atom::Str(Some(BString::from(v.format_into(&mut NumBuffer::new())))));
				Ok(v)
			},
			Err(e) => {
				let d = Diag::from(e);
				// `set -u`: an unset variable is fatal, as elsewhere.
				Err(if matches!(d, Diag::Unbound { .. }) {
					Stop::Fatal(d)
				} else {
					Stop::Fail(d)
				})
			},
		}
	}

	/// Expand the parameters and substitutions in arithmetic text (bash
	/// `expand_arith_string`): without a `$` or `` ` `` only quotes are
	/// removed, so subscripts are re-quoted only when something expands.
	/// Text without any of these comes back borrowed.
	pub fn expand_text<'t>(&mut self, text: &'t [u8]) -> X<Cow<'t, [u8]>> {
		if !text
			.iter()
			.any(|c| matches!(c, b'$' | b'`' | b'\\' | b'"' | b'\''))
		{
			return Ok(Cow::Borrowed(text));
		}
		let quoted = if text.contains(&b'[') && text.iter().any(|c| matches!(c, b'$' | b'`')) {
			self.quote_subscripts(text)?
		} else {
			None
		};
		let expanded = self.expand_arith_text(quoted.as_deref().unwrap_or(text))?;
		Ok(Cow::Owned(expanded.into()))
	}

	/// An arithmetic operand of `[[ ]]` (`-eq` … `-ge`) or the `-v`
	/// operand (bash `cond_expand_word` with `Q_ARITH`): one unquoted word,
	/// neither split nor globbed, except that each unquoted subscript
	/// (`name[…]`) is expanded on its own (no process substitution) and
	/// comes back backslash-quoted for the evaluator (bash
	/// `expand_array_subscript`): `assoc[$key]` with `key='x]'` is
	/// `assoc[x\]]`. Without `quote` (`[[ -v ]]` under `assoc_expand_once`,
	/// whose key is used as it is) the expansion comes back unquoted.
	pub fn arith_operand(&mut self, unit: &Arc<Unit>, w: &Word, quote: bool) -> X<BString> {
		let src = unit
			.nodes
			.get(w.node as usize)
			.and_then(|n| unit.source.get(n.lo as usize..n.hi as usize))
			.unwrap_or_default();
		if !src.contains(&b'[') {
			return self.scalar(unit, w);
		}
		let mut out = Vec::with_capacity(src.len() + 8);
		let mut last = 0;
		let mut i = 0;
		while i < src.len() {
			match src[i] {
				b'\\' => i += 2,
				b'\'' => {
					i = src[i + 1..]
						.iter()
						.position(|&c| c == b'\'')
						.map_or(src.len(), |n| i + n + 2);
				},
				b'"' => i = skip_dquoted(src, i + 1).map_or(src.len(), |e| e + 1),
				b'`' => i = skip_backquote(src, i + 1).map_or(src.len(), |e| e + 1),
				b'$' if matches!(src.get(i + 1), Some(b'(' | b'{' | b'[')) => {
					let (open, close) = pair_of(src[i + 1]);
					i = skip_pair(src, i + 2, open, close).map_or(src.len(), |e| e + 1);
				},
				b'[' if i > 0 && (src[i - 1].is_ascii_alphanumeric() || src[i - 1] == b'_') => {
					match skip_pair(src, i + 1, b'[', b']') {
						Some(end) if end > i + 1 => {
							let sub = &src[i + 1..end];
							let value = if sub
								.iter()
								.any(|c| matches!(c, b'$' | b'`' | b'\\' | b'"' | b'\''))
							{
								self.expand_arith_text(&subscript_as_arith_text(sub))?
							} else {
								BString::from(sub)
							};
							out.extend_from_slice(&subscript_as_arith_text(&src[last..=i]));
							if quote {
								push_quoted_subscript(&mut out, &value);
							} else {
								for &c in value.iter() {
									// Escaped only for the arithmetic-text parse.
									if matches!(c, b'$' | b'`' | b'"' | b'\\') {
										out.push(b'\\');
									}
									out.push(c);
								}
							}
							last = end;
							i = end + 1;
						},
						_ => i += 1,
					}
				},
				_ => i += 1,
			}
		}
		out.extend_from_slice(&subscript_as_arith_text(&src[last.min(src.len())..]));
		self.expand_arith_text(&out)
	}

	/// Expand `text` parsed as arithmetic text.
	fn expand_arith_text(&mut self, text: &[u8]) -> X<BString> {
		let unit = self
			.k
			.engine
			.text_unit(text, super::TextKind::Arith, self.vp_mode())
			.map_err(|e| Stop::Fail(Diag::Syntax { msg: e.msg }))?;
		let word = unit.words.last().cloned().unwrap_or_default();
		self.scalar(&unit, &word)
	}

	/// bash `expand_array_subscript` (arithmetic expansion, `Q_ARITH`): each
	/// array subscript in `text` (an unquoted `[` with a matching `]` and
	/// something between) is expanded on its own like an unquoted word, and
	/// its value goes back backslash-quoted (`[`, `]`, `$`, `` ` ``, `~`,
	/// `\`, `'` and `"`), so the
	/// evaluator reads it as written and never expands it again:
	/// `key='x],b[$(cmd)'; (( a[$key]++ ))` evaluates `a[x\],b\[\$(cmd)]++`.
	/// The result is arithmetic text again (the quoting is escaped for that
	/// parse); `None` when `text` has no subscript.
	fn quote_subscripts(&mut self, text: &[u8]) -> X<Option<Vec<u8>>> {
		let mut out = Vec::new();
		let mut last = 0;
		let mut i = 0;
		while i < text.len() {
			match text[i] {
				b'\\' => i += 2,
				b'`' => i = skip_backquote(text, i + 1).map_or(text.len(), |e| e + 1),
				b'$' if matches!(text.get(i + 1), Some(b'(' | b'{' | b'[')) => {
					let (open, close) = pair_of(text[i + 1]);
					i = skip_pair(text, i + 2, open, close).map_or(text.len(), |e| e + 1);
				},
				b'[' => match skip_pair(text, i + 1, b'[', b']') {
					Some(end) if end > i + 1 => {
						let sub = &text[i + 1..end];
						let value = if sub
							.iter()
							.any(|c| matches!(c, b'$' | b'`' | b'\\' | b'"' | b'\''))
						{
							self.expand_arith_text(&subscript_as_arith_text(sub))?
						} else {
							BString::from(sub)
						};
						out.extend_from_slice(&text[last..=i]);
						push_quoted_subscript(&mut out, &value);
						last = end;
						i = end + 1;
					},
					_ => i += 1,
				},
				_ => i += 1,
			}
		}
		if last == 0 {
			return Ok(None);
		}
		out.extend_from_slice(&text[last..]);
		Ok(Some(out))
	}

	const fn vp_mode(&self) -> crate::bash::ids::ModeId {
		self.vp.mode
	}

	/// `IFS`; `None` when unset (default splitting).
	fn ifs(&mut self) -> X<Option<Ifs>> {
		match &self.ifs {
			IfsCache::Unset => return Ok(None),
			IfsCache::Set(ifs) => return Ok(Some(ifs.clone())),
			IfsCache::Unknown => {},
		}
		let v = state::lookup(&self.k.root, self.cx.store, self.vp, b"IFS")?
			.map(|v| Ifs::new(v.as_scalar().unwrap_or_default()));
		self.ifs = v.clone().map_or(IfsCache::Unset, IfsCache::Set);
		Ok(v)
	}

	// ---- words -------------------------------------------------------------

	/// Expand the parts of `w` into `sink`. `quoted`: the word is inside
	/// double quotes (the operator word of a quoted `${…}`); `rhs`: the
	/// word of an unquoted `${p-w}` / `${p+w}`, whose unquoted text is split
	/// like an expansion result.
	fn word(
		&mut self,
		unit: &Arc<Unit>,
		w: &Word,
		sink: &mut Sink<'_>,
		quoted: bool,
		rhs: bool,
	) -> X<()> {
		let mode = if quoted {
			Tilde::Off
		} else {
			self.tilde_mode(w.kind)?
		};
		self.word_tilde(unit, w, sink, quoted, rhs, mode)
	}

	/// [`Self::word`] with tilde-prefixes expanded per `mode`.
	fn word_tilde(
		&mut self,
		unit: &Arc<Unit>,
		w: &Word,
		sink: &mut Sink<'_>,
		quoted: bool,
		rhs: bool,
		mode: Tilde,
	) -> X<()> {
		let mut eq_seen = false;
		for (i, part) in w.parts.iter().enumerate() {
			match part {
				Part::Lit(b) if mode != Tilde::Off => {
					let at = TildeAt { first: i == 0, last: i + 1 == w.parts.len(), mode };
					self.lit_tilde(b, at, &mut eq_seen, sink, rhs)?;
				},
				// `name=(…)` as an argument of an ordinary command (`eval`):
				// bash expands it as plain text, `(`, the elements' words with
				// their `[key]=`, spaces between, `)`.
				Part::Compound(elems) if w.kind != WordKind::DeclArg => {
					sink.lit(b"(", false);
					for (j, e) in elems.iter().enumerate() {
						if j > 0 {
							sink.lit(b" ", false);
						}
						if let Some(key) = e.key {
							sink.lit(b"[", false);
							self.word(unit, &unit.words[key as usize], sink, quoted, rhs)?;
							sink.lit(if e.append { b"]+=" } else { b"]=" }, false);
						}
						self.word(unit, &unit.words[e.value as usize], sink, quoted, rhs)?;
					}
					sink.lit(b")", false);
				},
				Part::Zsh(t) => self.zsh_word(t, w.kind, sink)?,
				_ => self.part(unit, part, sink, quoted, rhs)?,
			}
		}
		Ok(())
	}

	/// Where a `kind` word expands tilde-prefixes (bash expands them after
	/// `=` and `:` in assignment-like arguments only outside posix mode).
	fn tilde_mode(&mut self, kind: WordKind) -> X<Tilde> {
		Ok(match kind {
			WordKind::Text => Tilde::Off,
			WordKind::Plain => Tilde::Start,
			WordKind::Assign => Tilde::Colon,
			WordKind::DeclArg => Tilde::EqColon,
			WordKind::AssignArg => {
				if state::option(&mut self.k.root, self.cx.store, self.vp, OptId::Posix)? {
					Tilde::Start
				} else {
					Tilde::EqColon
				}
			},
		})
	}

	/// An unquoted literal part with its tilde-prefixes expanded. A prefix
	/// runs to the first `/` (or `:` in assignment contexts); one that does
	/// not end inside this part (a quoted or expanded part follows) or names
	/// no known directory stays literal. `eq_seen`: the word's first `=` has
	/// passed.
	fn lit_tilde(
		&mut self,
		b: &[u8],
		at: TildeAt,
		eq_seen: &mut bool,
		sink: &mut Sink<'_>,
		rhs: bool,
	) -> X<()> {
		if !b.contains(&b'~') || (at.mode == Tilde::Start && !(at.first && b[0] == b'~')) {
			*eq_seen |= b.contains(&b'=');
			Self::lit_text(sink, b, rhs);
			return Ok(());
		}
		let assign = at.mode != Tilde::Start;
		let mut done = 0;
		let mut cand = at.first;
		let mut j = 0;
		while j < b.len() {
			let c = b[j];
			if cand && c == b'~' {
				let end = b[j + 1..]
					.iter()
					.position(|&d| d == b'/' || (assign && d == b':'))
					.map(|k| j + 1 + k)
					.or_else(|| at.last.then_some(b.len()));
				if let Some(end) = end
					&& let Some(dir) = self.tilde(&b[j + 1..end])?
				{
					Self::lit_text(sink, &b[done..j], rhs);
					sink.lit(&dir, true);
					done = end;
					j = end;
					cand = false;
					continue;
				}
			}
			cand = match c {
				b':' => assign,
				b'=' if !*eq_seen => {
					*eq_seen = true;
					at.mode == Tilde::EqColon
				},
				_ => false,
			};
			j += 1;
		}
		Self::lit_text(sink, &b[done..], rhs);
		Ok(())
	}

	/// Unquoted literal text (split like an expansion inside `rhs` words).
	fn lit_text(sink: &mut Sink<'_>, b: &[u8], rhs: bool) {
		if rhs {
			sink.value(b, false);
		} else {
			sink.lit(b, false);
		}
	}

	/// The directory of tilde-prefix `~user`: `$HOME` (the user database
	/// when unset), `$PWD`, `$OLDPWD` or the current user's home; `None`
	/// leaves the prefix literal.
	fn tilde(&mut self, user: &[u8]) -> X<Option<BString>> {
		let var: &[u8] = match user {
			b"" => b"HOME",
			b"+" => b"PWD",
			b"-" => b"OLDPWD",
			// `~N`, `~+N`, `~-N`: directory stack entries.
			_ if {
				let digits = user
					.strip_prefix(b"+")
					.or_else(|| user.strip_prefix(b"-"))
					.unwrap_or(user);
				!digits.is_empty() && digits.iter().all(u8::is_ascii_digit)
			} =>
			{
				return Ok(super::builtins::dirstack::tilde(self.k, self.cx.store, self.vp, user)?);
			},
			_ => {
				let me = self.cx.host.user();
				return Ok((user == me.name.as_slice()).then_some(me.home));
			},
		};
		let v = state::lookup(&self.k.root, self.cx.store, self.vp, var)?
			.and_then(|v| v.as_scalar().map(BString::from));
		Ok(match (v, user) {
			(Some(v), _) => Some(v),
			(None, b"") => Some(self.cx.host.user().home),
			(None, _) => None,
		})
	}

	fn part(
		&mut self,
		unit: &Arc<Unit>,
		part: &Part,
		sink: &mut Sink<'_>,
		inq: bool,
		rhs: bool,
	) -> X<()> {
		match part {
			Part::Lit(b) if inq => sink.lit(b, true),
			Part::Lit(b) => Self::lit_text(sink, b, rhs),
			Part::Quoted(b) => sink.lit(b, true),
			Part::Param(p) => self.param(unit, p, sink, inq || p.quoted, rhs)?,
			Part::Comsub { entry, kind, quoted, text } => {
				let out = self.comsub(unit, *entry, *kind, *text)?;
				sink.value(&out, inq || *quoted);
			},
			Part::Arith { text, quoted } => {
				let v = match self.arith(text) {
					// posix mode: an arithmetic expansion error exits a
					// non-interactive shell (subst.c `expand_word_error` path).
					Err(Stop::Fail(d @ (Diag::Arith { .. } | Diag::ArithSubscript { .. })))
						if state::option(&mut self.k.root, self.cx.store, self.vp, OptId::Posix)? =>
					{
						return Err(Stop::Fatal(d));
					},
					v => v?,
				};
				sink.value(v.format_into(&mut NumBuffer::new()).as_bytes(), inq || *quoted);
			},
			Part::ProcSub { entry, output } => {
				// Logged, so a replay after a command substitution parks does
				// not start it twice.
				let path = if let Some(Atom::Str(Some(p))) = self.replay() {
					p
				} else {
					let p = super::exec::start_procsub(self.k, self.vp, self.cx, unit, *entry, *output);
					self.note(|| Atom::Str(Some(p.clone())));
					p
				};
				sink.lit(&path, true);
			},
			Part::Compound(elems) => {
				// Declaration builtins re-read `name=(…)` from this text
				// (pathname expansion of its words goes through
				// [`Self::decl_compound`] instead).
				let mut out = Vec::with_capacity(elems.len());
				self.compound(unit, elems, &mut out, None)?;
				sink.lit(&compound_text(&out), true);
			},
			Part::BadSubst(text) => return Err(Stop::Fail(Diag::BadSubst { text: text.clone() })),
			Part::Zsh(t) => self.zsh_word(t, WordKind::Plain, sink)?,
			Part::AnsiC(raw) => {
				let cs = super::locale::charset(self.k, self.cx.store, self.vp);
				let s = crate::bash::ir::ansi_c_with(raw, &mut |code, out| {
					super::locale::push_code_point(cs, code, out);
				});
				sink.lit(&s, true);
			},
			Part::ComsubSyntax { line, msg } => {
				return Err(Stop::Fail(Diag::ComsubSyntax {
					line: self.line + line,
					msg:  msg.clone(),
				}));
			},
		}
		Ok(())
	}

	fn comsub(
		&mut self,
		unit: &Arc<Unit>,
		entry: u32,
		form: ComsubForm,
		text: Option<u32>,
	) -> X<BString> {
		// A word compiled as unable to park (no replay log) can still meet
		// a command substitution in run-time text (a nameref's subscript,
		// `declare -n r='a[$(cmd)]'`). The executor logs every finished
		// substitution and nothing else is logged, so the outputs come back
		// in order; the expansion before it runs again.
		let atom = if self.record {
			self.replay()
		} else {
			let atom = self.log.get(self.cursor).cloned();
			self.cursor += usize::from(atom.is_some());
			atom
		};
		match atom {
			Some(Atom::Sub { out, status }) => {
				self.sub_status = Some(status);
				self.vp.status = status;
				Ok(out)
			},
			_ => Err(Stop::Sub { unit: Arc::clone(unit), entry, form, text }),
		}
	}

	// ---- parameters --------------------------------------------------------

	fn param(
		&mut self,
		unit: &Arc<Unit>,
		p: &ParamIr,
		sink: &mut Sink<'_>,
		quoted: bool,
		rhs: bool,
	) -> X<()> {
		match &p.op {
			OpIr::Length => {
				if let Some(n) = self.with_scalar(p, |s| s.chars().count())? {
					sink.value(n.format_into(&mut NumBuffer::new()).as_bytes(), quoted);
					return Ok(());
				}
				// bash `array_length_reference`: with `set -u`, `${#a[i]}` and
				// `${#a[@]}` need `a` to be a set array (`a: unbound variable`
				// for `[@]`, `a[i]: …` otherwise, even for a set scalar); an
				// unset element of a set array has length 0.
				if let (ParamRef::Var(name), Some(index), false) = (&p.param, &p.index, p.indirect)
					&& !is_dynamic(name)
					&& self.nounset()?
					&& state::lookup(&self.k.root, self.cx.store, self.vp, name)?
						.is_none_or(|v| matches!(v.value, VarValue::Str(_)))
				{
					let name = match index {
						SubIr::At | SubIr::Star => name.clone(),
						SubIr::Expr(_) => Self::unbound_name(unit, p, false),
					};
					return Err(Stop::Fatal(Diag::Unbound { name }));
				}
				let n = match self.value(unit, p)? {
					Val::Unset if matches!(p.index, Some(SubIr::Expr(_))) => 0,
					Val::Unset => {
						self.check_unset(unit, p)?;
						0
					},
					Val::Str(s) => s.chars().count(),
					Val::List { items, .. } => items.len(),
				};
				sink.value(n.format_into(&mut NumBuffer::new()).as_bytes(), quoted);
			},
			OpIr::Indirect
				if matches!(p.param, ParamRef::Status | ParamRef::Count)
					&& state::option(&mut self.k.root, self.cx.store, self.vp, OptId::Posix)? =>
			{
				// posix mode: `${!?}` is `$!` with `?`, `${!#}` is `$!` with
				// an empty `#` pattern.
				let v = self.read_atom(|ex| ex.special(&ParamRef::LastBg))?;
				if matches!(v, Val::Unset) && matches!(p.param, ParamRef::Status) {
					return Err(Stop::Fatal(Diag::ParamUnset {
						name: BString::from("!"),
						msg:  BString::from("parameter not set"),
					}));
				}
				self.push(sink, v, quoted, rhs)?;
			},
			OpIr::Indirect => {
				let v = self.indirect(unit, p)?;
				// `set -u`: `!x: unbound variable` when the name `x` holds
				// (or the element `${!a[7]}`) is unset.
				if matches!(v, Val::Unset) && matches!(p.param, ParamRef::Var(_)) && self.nounset()? {
					return Err(Stop::Fatal(Diag::Unbound { name: Self::unbound_name(unit, p, true) }));
				}
				self.push(sink, v, quoted, rhs)?;
			},
			OpIr::PrefixNames { star } => {
				let ParamRef::Var(prefix) = &p.param else {
					return Err(Stop::Fail(Diag::BadSubst { text: BString::from("${!}") }));
				};
				let prefix = prefix.clone();
				let names = self.read_atom(|ex| {
					let vars =
						state::scan(&ex.k.root, ex.cx.store, ex.vp, crate::bash::store::Table::Var)?;
					let items = vars
						.into_iter()
						.filter_map(|(k, _)| match k {
							crate::bash::store::KeyBuf::Var(n) if n.starts_with(prefix.as_slice()) => {
								Some(n)
							},
							_ => None,
						})
						.collect();
					Ok(Val::List { items, star: false })
				})?;
				let items = match names {
					Val::List { items, .. } => items,
					_ => Vec::new(),
				};
				self.push(sink, Val::List { items, star: *star }, quoted, rhs)?;
			},
			OpIr::Default { colon, word } | OpIr::Alt { colon, word } => {
				let v = self.value(unit, p)?;
				let unset = self.unset_or_null(&v, *colon)?;
				let alt = matches!(p.op, OpIr::Alt { .. });
				if unset == alt {
					// The value itself; for a `+` not taken that is the unset
					// or null value (a quoted null inside "…", nothing for an
					// empty `"$@"`).
					self.push(sink, v, quoted, rhs)?;
				} else {
					self.op_word(unit, &unit.words[*word as usize], sink, quoted)?;
				}
			},
			OpIr::Assign { colon, word } => {
				// `${a[k]:=v}` assigns that element; the subscript is
				// evaluated once.
				// `${A[@]:=v}` on an associative array assigns the key `@`
				// when the whole value is unset or null; on an indexed one
				// it is a bad subscript (bash `parameter_brace_expand_rhs`).
				let mut whole = false;
				let key = match (&p.param, &p.index) {
					(ParamRef::Var(n), Some(SubIr::Expr(w))) if !p.indirect => {
						let assoc = self.is_assoc(n)?;
						Some(self.subscript(unit, *w, assoc)?)
					},
					(ParamRef::Var(_), Some(sub @ (SubIr::At | SubIr::Star))) if !p.indirect => {
						let at: &[u8] = if matches!(sub, SubIr::At) { b"@" } else { b"*" };
						whole = true;
						Some(BString::from(at))
					},
					_ => None,
				};
				let v = match (&key, &p.param) {
					(Some(_), ParamRef::Var(_)) if whole => self.value(unit, p)?,
					(Some(k), ParamRef::Var(n)) => {
						let (n, k) = (n.clone(), k.clone());
						self.read_atom(|ex| ex.var_value(&n, Some(k.as_slice()), false))?
					},
					_ => self.value(unit, p)?,
				};
				if self.unset_or_null(&v, *colon)? {
					let ParamRef::Var(name) = &p.param else {
						let shown = Self::param_text(p);
						return Err(Stop::Fail(Diag::CannotAssign { text: shown }));
					};
					if whole && !self.is_assoc(name)? {
						let mut shown = name.clone();
						shown.push(b'[');
						if let Some(k) = key.as_deref() {
							shown.extend_from_slice(k);
						}
						shown.push(b']');
						return Err(Stop::Fail(Diag::Usage {
							msg: format!("{}: bad array subscript", shown.as_bstr()).into(),
						}));
					}
					let value = self.scalar(unit, &unit.words[*word as usize])?;
					let name = name.clone();
					let stored = value.clone();
					let sub = key.as_ref().map(|k| k.as_slice());
					self.effect(|ex| ex.assign_scalar(&name, sub, stored))?;
					// The value as stored: attributes may have changed it
					// (`declare -i a; ${a:=4+3}` is 7).
					let value = match self.read_atom(|ex| ex.var_value(&name, sub, false))? {
						Val::Str(s) => s,
						_ => value,
					};
					let new_ifs = (name.as_slice() == b"IFS").then(|| Ifs::new(&value));
					self.push(sink, Val::Str(value), quoted, rhs)?;
					if let Some(ifs) = new_ifs {
						// This result splits with the old value; later
						// expansions in the word split and join with the new
						// one (`${*}${IFS=}${*}${IFS:=-}"${*}"`).
						self.ifs = IfsCache::Set(ifs.clone());
						if let Sink::Fields(f) = &mut *sink {
							f.ifs = Some(ifs);
						}
					}
				} else {
					self.push(sink, v, quoted, rhs)?;
				}
			},
			OpIr::Error { colon, word } => {
				let v = self.value(unit, p)?;
				if self.unset_or_null(&v, *colon)? {
					let msg = match word {
						Some(w) => self.scalar(unit, &unit.words[*w as usize])?,
						None if *colon => BString::from("parameter null or not set"),
						None => BString::from("parameter not set"),
					};
					return Err(Stop::Fatal(Diag::ParamUnset { name: Self::param_name(p), msg }));
				}
				self.push(sink, v, quoted, rhs)?;
			},
			OpIr::None => {
				if self.with_scalar(p, |s| sink.value(s, quoted))?.is_some() {
					return Ok(());
				}
				let v = self.value(unit, p)?;
				if matches!(v, Val::Unset) {
					self.check_unset(unit, p)?;
				}
				self.push(sink, v, quoted, rhs)?;
			},
			OpIr::Substr { offset, len } => {
				let v = self.value(unit, p)?;
				if matches!(v, Val::Unset) {
					// bash evaluates neither expression of an unset parameter.
					self.check_unset(unit, p)?;
					return self.push(sink, v, quoted, rhs);
				}
				let indices = self.slice_indices(p)?;
				// bash names the parameter in arithmetic errors here:
				// `x: %: arithmetic syntax error…`.
				let named = |e: Stop| match e {
					Stop::Fail(Diag::Arith { expr, msg, token }) => {
						let mut shown = Self::substr_name(p);
						shown.extend_from_slice(b": ");
						shown.extend_from_slice(&expr);
						Stop::Fail(Diag::Arith { expr: shown, msg, token })
					},
					other => other,
				};
				let off = self.arith(offset).map_err(named)?;
				// bash quotes the length expression as written.
				let negative =
					|| Stop::Fail(Diag::SubstrNegative { expr: len.clone().unwrap_or_default() });
				let len = match len {
					Some(expr) => Some(self.arith(expr).map_err(named)?),
					None => None,
				};
				let at_list = matches!(p.param, ParamRef::At | ParamRef::Star) && p.index.is_none();
				// `${s[@]:o:l}` of a scalar `s` is a substring of its value.
				let scalar = self.scalar_element_list(p)?;
				let v = match v {
					Val::List { mut items, .. } if scalar && items.len() == 1 => {
						Val::Str(items.swap_remove(0))
					},
					v => v,
				};
				let out = match v {
					Val::Unset => Val::Unset,
					Val::Str(text) => {
						let chars: Vec<char> = text.chars().collect();
						if let Some((start, end)) = slice_bounds(chars.len(), off, len) {
							Val::Str(BString::from(chars[start..end].iter().collect::<String>()))
						} else {
							if len.is_some_and(|count| count < 0) {
								return Err(negative());
							}
							Val::Str(BString::default())
						}
					},
					// A list takes no negative length (`${@:1:-1}` is an error).
					Val::List { .. } if len.is_some_and(|count| count < 0) => return Err(negative()),
					Val::List { items, star } => {
						// `${@:0}` starts at `$0`.
						let mut all = items;
						if at_list {
							all.insert(0, state::dollar0(self.cx.store, self.vp, &self.k.argv0)?);
						}
						// bash `array_subrange`: the offset into an indexed array
						// is an index (a negative one counts from one past the
						// largest index); the slice starts at the first set
						// element at or after it.
						let off = match indices {
							Some(idx) if idx.len() == all.len() => {
								let end = idx.last().map_or(0, |&max| max + 1);
								let at = if off < 0 { off + end } else { off };
								(0..=end)
									.contains(&at)
									.then(|| idx.partition_point(|&i| i < at) as i64)
							},
							_ => Some(off),
						};
						match off.and_then(|off| slice_bounds(all.len(), off, len)) {
							Some((start, end)) => Val::List { items: all[start..end].to_vec(), star },
							None => Val::List { items: Vec::new(), star },
						}
					},
				};
				// bash quirk: unquoted `${*:o}` / `${a[*]:o}` assigned with a
				// null IFS goes through `parameter_brace_substring` →
				// `pos_params`/`array_subrange` + `string_list_dollar_star`
				// (subst.c), whose result later meets `remove_quoted_nulls`,
				// which drops 0x7f (bash's CTLNUL marker) as a quoted null:
				// `IFS=; set -- $'\177'; v=${*:1}` leaves `v` empty.
				let out = match out {
					Val::List { items, star: true }
						if !quoted
							&& !matches!(sink, Sink::Fields(_))
							&& self.ifs()?.is_some_and(|s| s.is_empty()) =>
					{
						let items = items
							.into_iter()
							.map(|s| BString::from(s.replace(b"\x7f", b"")))
							.collect();
						Val::List { items, star: true }
					},
					other => other,
				};
				self.push(sink, out, quoted, rhs)?;
			},
			OpIr::Trim { suffix, longest, pat } => {
				let pat_word = &unit.words[*pat as usize];
				// A literal pattern has no side effects, so it may expand
				// before the value is read in place.
				if pat_word
					.parts
					.iter()
					.all(|p| matches!(p, Part::Lit(_) | Part::Quoted(_)))
				{
					let pat = self.pattern_text(unit, pat_word)?;
					let pattern = self.compile(&pat)?;
					if let Some(out) = self.with_scalar(p, |s| trim(s, &pattern, *suffix, *longest))? {
						sink.value(&out, quoted);
						return Ok(());
					}
				}
				let v = self.value(unit, p)?;
				if matches!(v, Val::Unset) {
					self.check_unset(unit, p)?;
				}
				let pat = self.pattern_text(unit, &unit.words[*pat as usize])?;
				let pattern = self.compile(&pat)?;
				let out = map_val(v, |s| trim(s, &pattern, *suffix, *longest));
				self.push(sink, out, quoted, rhs)?;
			},
			OpIr::Replace { mode, pat, rep } => {
				let v = self.value(unit, p)?;
				if matches!(v, Val::Unset) {
					self.check_unset(unit, p)?;
				}
				let pat = self.pattern_text(unit, &unit.words[*pat as usize])?;
				let rep = match rep {
					Some(r) => Some(self.replacement_text(unit, &unit.words[*r as usize])?),
					None => None,
				};
				// bash 4.4+: pattern replacement honours `nocasematch`.
				let nocase =
					state::option(&mut self.k.root, self.cx.store, self.vp, OptId::Nocasematch)?;
				let pattern = self.compile_with(&pat, nocase)?;
				let out = map_val(v, |s| {
					replace(s, &pattern, pat.is_empty(), *mode, rep.as_ref().map(|r| r.as_slice()))
				});
				self.push(sink, out, quoted, rhs)?;
			},
			OpIr::Case { mode, all, pat } => {
				let v = self.value(unit, p)?;
				if matches!(v, Val::Unset) {
					self.check_unset(unit, p)?;
				}
				let pattern = match pat {
					Some(w) => {
						let pat = self.pattern_text(unit, &unit.words[*w as usize])?;
						Some(self.compile(&pat)?)
					},
					None => None,
				};
				let out = map_val(v, |s| case_convert(s, *mode, *all, pattern.as_deref()));
				self.push(sink, out, quoted, rhs)?;
			},
			OpIr::Transform(op) => {
				// `${!v@op}` applies the operator to the variable `v` names,
				// attributes included.
				let target = if p.indirect {
					self.indirect_target(p)?
				} else {
					None
				};
				let q = target.as_ref().unwrap_or(p);
				let v = self.value(unit, q)?;
				// `set -u`: an unset value is an error, except that `@a` and
				// `@A` of a whole variable need only some element
				// (`declare -a a=([1]=x); ${a@a}` is fine, `${a@Q}`,
				// `${a[7]@a}` and `declare -a a=(); ${a@a}` are not).
				let attrs_only = matches!(*op, b'a' | b'A') && q.index.is_none();
				if matches!(v, Val::Unset) && !(attrs_only && self.has_elements(q)?) {
					self.check_unset(unit, p)?;
				}
				let out = self.transform(q, v, *op)?;
				self.push(sink, out, quoted, rhs)?;
			},
		}
		Ok(())
	}

	/// `${p-…}` and friends: `p` is unset (an empty list counts), or null
	/// with `:` (a list is null when it joins to nothing).
	fn unset_or_null(&mut self, v: &Val, colon: bool) -> X<bool> {
		Ok(match v {
			Val::Unset => true,
			Val::Str(s) => colon && s.is_empty(),
			Val::List { items, .. } if items.is_empty() => true,
			Val::List { items, star } => {
				colon
					&& items.iter().all(|s| s.is_empty())
					&& (items.len() == 1 || (*star && self.ifs()?.is_some_and(|s| s.is_empty())))
			},
		})
	}

	/// The word of a `${p-w}` / `${p+w}` that applies.
	///
	/// Unquoted, the word is split like an expansion. bash expands it
	/// without splitting first, and when it holds an unquoted `$@` and the
	/// first `IFS` byte is not whitespace, splits that intermediate result
	/// on `IFS` and rejoins it with spaces before the final splitting
	/// (`IFS=:; set -- 'a b' c; ${v-$@}` is one field `a b c`).
	fn op_word(&mut self, unit: &Arc<Unit>, w: &Word, sink: &mut Sink<'_>, quoted: bool) -> X<()> {
		if !quoted
			&& let Sink::Fields(f) = &mut *sink
			&& rejoins(f.ifs.as_deref())
			&& w
				.parts
				.iter()
				.any(|p| matches!(p, Part::Param(p) if !p.quoted && p.is_at_list()))
		{
			return self.rejoin(unit, w, f);
		}
		self.word(unit, w, sink, quoted, !quoted)
	}

	/// [`Self::op_word`]'s split-and-rejoin: the word's fields, each kept
	/// whole, separated by unquoted spaces in `outer`.
	fn rejoin(&mut self, unit: &Arc<Unit>, w: &Word, outer: &mut Fields<'_>) -> X<()> {
		let mut fields = Vec::new();
		let mut inner = Sink::Fields(Fields {
			cur:      Vec::new(),
			have:     false,
			out:      &mut fields,
			ifs:      outer.ifs.clone(),
			globs:    None,
			whole_at: true,
			utf8:     outer.utf8,
			pool:     Vec::new(),
		});
		self.word(unit, w, &mut inner, false, true)?;
		if let Sink::Fields(f) = &mut inner
			&& f.have
		{
			f.end();
		}
		for (i, field) in fields.iter().enumerate() {
			if i > 0 {
				outer.split(b" ");
			}
			outer.push_quoted(field);
			outer.have = true;
		}
		Ok(())
	}

	/// The parameter as written in `${…}`, for substring errors.
	fn substr_name(p: &ParamIr) -> BString {
		let mut s = Self::param_name(p);
		match p.index {
			Some(SubIr::At) => s.extend_from_slice(b"[@]"),
			Some(SubIr::Star) => s.extend_from_slice(b"[*]"),
			Some(SubIr::Expr(_)) | None => {},
		}
		s
	}

	fn compile(&mut self, pat: &[u8]) -> X<Arc<Pattern>> {
		self.compile_with(pat, false)
	}

	/// `pat` compiled for `${…}` matching (no pathname rules), through the
	/// engine's pattern cache.
	fn compile_with(&mut self, pat: &[u8], nocase: bool) -> X<Arc<Pattern>> {
		let extglob = state::option(&mut self.k.root, self.cx.store, self.vp, OptId::Extglob)?;
		let utf8 = super::locale::is_utf8(self.k, self.cx.store, self.vp);
		Ok(self
			.k
			.engine
			.patterns()
			.get(pat, PatOpts::shell(extglob, nocase, utf8)))
	}

	/// Emit a parameter's value. Lists become fields in field context
	/// ([`Fields::list`]); elsewhere they join: `$@` with spaces, `$*` with
	/// the first `IFS` character (nothing when `IFS` is null, except in an
	/// unquoted `rhs` word, where bash joins with spaces).
	fn push(&mut self, sink: &mut Sink<'_>, v: Val, quoted: bool, rhs: bool) -> X<()> {
		match v {
			Val::Unset => sink.value(b"", quoted),
			Val::Str(s) => sink.value(&s, quoted),
			Val::List { items, star } => {
				if let Sink::Fields(f) = &mut *sink {
					f.list(&items, quoted, star);
				} else {
					let ifs = self.ifs()?;
					let ifs = ifs.as_deref();
					let sep: &[u8] = match ifs {
						Some(b"") if star && rhs && !quoted => b" ",
						_ if star => ifs_sep(ifs),
						_ => b" ",
					};
					sink.lit(&join(&items, sep), quoted);
				}
			},
		}
		Ok(())
	}

	fn param_name(p: &ParamIr) -> BString {
		match &p.param {
			ParamRef::Var(n) => n.clone(),
			ParamRef::Positional(n) => BString::from(n.to_string()),
			ParamRef::At => BString::from("@"),
			ParamRef::Star => BString::from("*"),
			ParamRef::Count => BString::from("#"),
			ParamRef::Status => BString::from("?"),
			ParamRef::Flags => BString::from("-"),
			ParamRef::ShellPid => BString::from("$"),
			ParamRef::LastBg => BString::from("!"),
		}
	}

	fn param_text(p: &ParamIr) -> BString {
		let mut s = BString::from("$");
		s.extend_from_slice(&Self::param_name(p));
		s
	}

	/// `set -u`: the `unbound variable` error for the unset value of `p`.
	fn check_unset(&mut self, unit: &Unit, p: &ParamIr) -> X<()> {
		if matches!(p.param, ParamRef::At | ParamRef::Star) {
			return Ok(());
		}
		if self.nounset()? {
			return Err(Stop::Fatal(Diag::Unbound { name: Self::unbound_name(unit, p, p.indirect) }));
		}
		Ok(())
	}

	fn nounset(&mut self) -> X<bool> {
		Ok(state::option(&mut self.k.root, self.cx.store, self.vp, OptId::Nounset)?)
	}

	/// `p` as bash names it in `unbound variable` errors: `$9` for an
	/// unbraced positional but `9` for `${9}`, `x` for both `$x` and `${x}`,
	/// an element with its subscript as written (`a[i+4]`), and with `bang`
	/// a `!` before a reference followed through an indirection
	/// (`${!bar@a}`, `${!x}`).
	fn unbound_name(unit: &Unit, p: &ParamIr, bang: bool) -> BString {
		let mut name = BString::default();
		if bang {
			name.push(b'!');
		}
		if !p.braced && matches!(p.param, ParamRef::Positional(_)) {
			name.push(b'$');
		}
		name.extend_from_slice(&Self::param_name(p));
		if let Some(SubIr::Expr(w)) = p.index {
			name.push(b'[');
			name.extend_from_slice(word_source(unit, w));
			name.push(b']');
		}
		name
	}

	/// `${name=value}`: an ordinary assignment (readonly check, `-i`
	/// evaluation, case attributes).
	fn assign_scalar(&mut self, name: &[u8], index: Option<&[u8]>, value: BString) -> X<()> {
		let Some(index) = index else {
			return super::builtins::assign(self.k, self.vp, self.cx, name, value, Level::Dynamic)
				.map_err(Stop::Fail);
		};
		super::builtins::set_value(
			self.k,
			self.cx,
			self.vp,
			super::builtins::Lhs { name, index: Some(index), append: false },
			super::proc::AssignValue::Scalar(value),
			Level::Dynamic,
		)
		.map_err(Stop::Fail)
	}

	/// The subscript text of `p` (arithmetic for indexed arrays).
	fn subscript(&mut self, unit: &Arc<Unit>, wi: u32, assoc: bool) -> X<BString> {
		let w = &unit.words[wi as usize];
		if assoc {
			return self.scalar(unit, w);
		}
		// bash expands an indexed subscript as arithmetic text, with
		// double-quote rules (`array_expand_index`): `'…'` stays literal and
		// `\c` keeps its backslash unless `c` is special (`${a['1']}` is an
		// arithmetic syntax error). Only such text differs from the word.
		let src = word_source(unit, wi);
		if src.iter().any(|c| matches!(c, b'\'' | b'\\')) {
			let n = self.arith(src)?;
			return Ok(BString::from(n.format_into(&mut NumBuffer::new())));
		}
		// bash expands no tilde-prefix in an arithmetic subscript (`${b[~]}`
		// is an arithmetic syntax error).
		let mut sink = Sink::Scalar(Vec::with_capacity(lit_len(w)));
		self.word_tilde(unit, w, &mut sink, false, false, Tilde::Off)?;
		let Sink::Scalar(text) = sink else {
			return Ok(BString::default());
		};
		let n = self.arith_eval(&text)?;
		Ok(BString::from(n.format_into(&mut NumBuffer::new())))
	}

	/// The key of element `sub` of `target` named by a reference (a nameref
	/// `r='a[$i]'`, `${!v}` with `v='a[$i]'`): bash expands the subscript
	/// text when the reference is used, as arithmetic for an indexed array
	/// and as a word for an associative one (`array_expand_index`,
	/// `expand_subscript_string`).
	fn element_key(&mut self, target: &[u8], sub: &[u8]) -> X<BString> {
		if self.is_assoc(target)? {
			if !sub
				.iter()
				.any(|c| matches!(c, b'$' | b'`' | b'\\' | b'"' | b'\''))
			{
				return Ok(BString::from(sub));
			}
			return self.expand_arith_text(&subscript_as_arith_text(sub));
		}
		let n = self.arith(sub)?;
		Ok(BString::from(n.format_into(&mut NumBuffer::new())))
	}

	/// A parameter's value (one atom).
	fn value(&mut self, unit: &Arc<Unit>, p: &ParamIr) -> X<Val> {
		if p.indirect {
			return self.indirect(unit, p);
		}
		match &p.param {
			ParamRef::At | ParamRef::Star => {
				let star = matches!(p.param, ParamRef::Star);
				let v = self.read_atom(|ex| {
					Ok(Val::List { items: state::positional(&ex.k.root, ex.cx.store, ex.vp)?, star })
				})?;
				Ok(match v {
					Val::List { items, .. } => Val::List { items, star },
					other => other,
				})
			},
			ParamRef::Var(name) => {
				let name = name.clone();
				// A nameref to an element (`declare -n r='a[$i]'`, `r='a[@]'`):
				// bash expands the subscript each time the reference is used.
				if p.index.is_none()
					&& !is_dynamic(&name)
					&& let state::Deref::To { name: target, index: Some(sub) } =
						state::deref(&self.k.root, self.cx.store, self.vp, &name)?
				{
					if let b"@" | b"*" = sub.as_slice() {
						let star = sub.as_slice() == b"*";
						let v = self.read_atom(|ex| ex.var_value(&target, None, true))?;
						return Ok(match v {
							Val::List { items, .. } => Val::List { items, star },
							_ => Val::List { items: Vec::new(), star },
						});
					}
					let key = self.element_key(&target, &sub)?;
					return self.read_atom(|ex| ex.var_value(&target, Some(key.as_slice()), false));
				}
				let is_assoc = self.is_assoc(&name)?;
				let index = match &p.index {
					Some(SubIr::Expr(w)) => Some(self.subscript(unit, *w, is_assoc)?),
					_ => None,
				};
				// An empty key of an associative array: bash warns and reads
				// unset (`w: bad array subscript`); `${#w[$k]}` fails, naming
				// the subscript as written (`[$k]: bad array subscript`).
				if is_assoc
					&& let (Some(SubIr::Expr(w)), Some(key)) = (&p.index, &index)
					&& key.is_empty()
				{
					if matches!(p.op, OpIr::Length) {
						let msg = format!("[{}]: bad array subscript", word_source(unit, *w).as_bstr());
						return Err(Stop::Fail(Diag::Usage { msg: msg.into() }));
					}
					return self.read_atom(|ex| {
						let msg = format!("{}: bad array subscript", name.as_bstr()).into();
						ex.k.diag(ex.cx, ex.vp, ex.line, Diag::Usage { msg });
						Ok(Val::Unset)
					});
				}
				// `${#a[-10]}` before the start of a set array fails the same
				// way (bash `array_length_reference`); `${a[-10]}` only warns.
				if !is_assoc
					&& matches!(p.op, OpIr::Length)
					&& let (Some(SubIr::Expr(w)), Some(i)) = (&p.index, &index)
					&& i.starts_with(b"-")
				{
					let n: i64 = std::str::from_utf8(i)
						.ok()
						.and_then(|s| s.parse().ok())
						.unwrap_or(0);
					// A scalar has only `[0]`; an unset or empty array reads as
					// 0 without the warning `${e[-1]}` gives.
					let (before, empty) =
						match state::lookup(&self.k.root, self.cx.store, self.vp, &name)? {
							None => (false, !is_dynamic(&name)),
							Some(v) => match &v.value {
								VarValue::Str(_) => (true, false),
								_ => (v.next_index() > 0 && v.next_index() + n < 0, v.next_index() == 0),
							},
						};
					if empty {
						return Ok(Val::Unset);
					}
					if before {
						let msg = format!("[{}]: bad array subscript", word_source(unit, *w).as_bstr());
						return Err(Stop::Fail(Diag::Usage { msg: msg.into() }));
					}
				}
				let list = match &p.index {
					Some(SubIr::At) => Some(false),
					Some(SubIr::Star) => Some(true),
					_ => None,
				};
				let v = self.read_atom(|ex| {
					ex.var_value(&name, index.as_ref().map(|i| i.as_slice()), list.is_some())
				})?;
				Ok(match (v, list) {
					(Val::List { items, .. }, Some(star)) => Val::List { items, star },
					(Val::Unset, Some(star)) => Val::List { items: Vec::new(), star },
					(v, _) => v,
				})
			},
			other => {
				let other = other.clone();
				self.read_atom(|ex| ex.special(&other))
			},
		}
	}

	/// Run `f` on the value of `p` in place when `p` is a plain set scalar
	/// reference (`$name` or `$1`, no subscript, not indirect, not a dynamic
	/// variable) and no replay log is recorded; `None` otherwise (the
	/// general path copies the value).
	fn with_scalar<R>(&mut self, p: &ParamIr, f: impl FnOnce(&[u8]) -> R) -> X<Option<R>> {
		if self.record || p.indirect || p.index.is_some() {
			return Ok(None);
		}
		match &p.param {
			ParamRef::Var(name) if !is_dynamic(name) => {
				Ok(state::lookup(&self.k.root, self.cx.store, self.vp, name)?
					.and_then(Var::as_scalar)
					.map(f))
			},
			ParamRef::Positional(n) if *n > 0 => {
				Ok(state::positional_ref(&self.k.root, self.cx.store, self.vp)?
					.get(*n as usize - 1)
					.map(|s| f(s)))
			},
			_ => Ok(None),
		}
	}

	/// The compound assignment `name=(…)` (or `name+=(…)`): to an
	/// associative array (through a name reference) whose first element has
	/// no `[key]=`, the elements are key-value pairs (bash
	/// `assign_assoc_from_kvlist`); otherwise as [`Self::compound`].
	pub fn assign_compound(
		&mut self,
		unit: &Arc<Unit>,
		name: &[u8],
		elems: &[crate::bash::ir::ElemIr],
		out: &mut Vec<CompoundElem>,
		globs: Option<&mut Vec<(u32, BString)>>,
	) -> X<()> {
		if elems.first().is_some_and(|e| e.key.is_none()) {
			let assoc = match state::deref(&self.k.root, self.cx.store, self.vp, name)? {
				state::Deref::Plain => self.is_assoc(name)?,
				state::Deref::To { name: target, index: None } => self.is_assoc(&target)?,
				_ => false,
			};
			if assoc {
				return self.kvpair(unit, elems, false, out);
			}
		}
		self.compound(unit, elems, out, globs)
	}

	/// Key-value pair elements of an associative compound assignment, each
	/// word expanded once, neither split nor globbed (bash
	/// `expand_subscript_string`; a value as an assignment, `~` after `:`
	/// too). `decl` (`declare -A a=(k v)`): the words stay unkeyed, for the
	/// builtin to pair (bash `expand_and_quote_kvpair_word`); otherwise each
	/// pair becomes a keyed element, and an empty key is reported with the
	/// word as written (`"": bad array subscript`) and skipped.
	fn kvpair(
		&mut self,
		unit: &Arc<Unit>,
		elems: &[crate::bash::ir::ElemIr],
		decl: bool,
		out: &mut Vec<CompoundElem>,
	) -> X<()> {
		let mut i = 0;
		while i < elems.len() {
			let key = self.kv_word(unit, &elems[i], Tilde::Start)?;
			if decl {
				out.push(CompoundElem { key: None, append: false, value: key });
				i += 1;
				continue;
			}
			let value_elem = elems.get(i + 1);
			i += 2;
			if key.is_empty() {
				let src = word_source(unit, elems[i - 2].value);
				self.read_atom(|ex| {
					let msg = format!("{}: bad array subscript", src.as_bstr()).into();
					ex.k.diag(ex.cx, ex.vp, ex.line, Diag::Usage { msg });
					Ok(Val::Unset)
				})?;
				continue;
			}
			let value = match value_elem {
				Some(e) => self.kv_word(unit, e, Tilde::Colon)?,
				None => BString::default(),
			};
			out.push(CompoundElem { key: Some(key), append: false, value });
		}
		Ok(())
	}

	/// One word of a key-value pair list: an unkeyed element with
	/// tilde-prefixes per `mode`; a keyed one (`[k]=v`) is the plain word
	/// `[k]=v` there.
	fn kv_word(&mut self, unit: &Arc<Unit>, e: &crate::bash::ir::ElemIr, mode: Tilde) -> X<BString> {
		let mut sink = Sink::Scalar(Vec::new());
		if let Some(key) = e.key {
			sink.lit(b"[", false);
			self.word_tilde(unit, &unit.words[key as usize], &mut sink, false, false, Tilde::Off)?;
			sink.lit(if e.append { b"]+=" } else { b"]=" }, false);
			self.word_tilde(
				unit,
				&unit.words[e.value as usize],
				&mut sink,
				false,
				false,
				Tilde::Off,
			)?;
		} else {
			self.word_tilde(unit, &unit.words[e.value as usize], &mut sink, false, false, mode)?;
		}
		match sink {
			Sink::Scalar(b) => Ok(BString::from(b)),
			_ => unreachable!(),
		}
	}

	/// Expand the elements of a compound assignment `(…)`: a keyed element
	/// to one value, an unkeyed one split into words like a command word
	/// (`readonly a=($1)` with `$1` = `a b c` makes 3 elements). With
	/// `globs`, the words needing pathname expansion are recorded as
	/// `(index in out, pattern)` (unless `set -f`); run
	/// [`super::glob::expand_compound_globs`] on them.
	#[expect(
		clippy::iter_with_drain,
		reason = "the per-word buffers are drained to be reused for the next element"
	)]
	pub fn compound(
		&mut self,
		unit: &Arc<Unit>,
		elems: &[crate::bash::ir::ElemIr],
		out: &mut Vec<CompoundElem>,
		mut globs: Option<&mut Vec<(u32, BString)>>,
	) -> X<()> {
		// One word's fields and glob entries, reused across elements.
		let mut words = Vec::new();
		let mut word_globs = Vec::new();
		for e in elems {
			if let Some(key) = e.key {
				let key = self.scalar(unit, &unit.words[key as usize])?;
				let value = self.scalar(unit, &unit.words[e.value as usize])?;
				out.push(CompoundElem { key: Some(key), append: e.append, value });
				continue;
			}
			let w = &unit.words[e.value as usize];
			match globs.as_deref_mut() {
				Some(globs) => {
					self.fields_glob(unit, w, &mut words, &mut word_globs)?;
					let base = out.len() as u32;
					globs.extend(word_globs.drain(..).map(|(i, p)| (base + i, p)));
				},
				None => self.fields(unit, w, &mut words)?,
			}
			out.extend(words.drain(..).map(|value| CompoundElem {
				key: None,
				append: e.append,
				value,
			}));
		}
		Ok(())
	}

	/// A declaration-builtin argument ending in a compound value
	/// (`local -a f=(*)`): `prefix` gets the text before it (`f=`), `out`
	/// and `globs` its elements as [`Self::compound`] makes them. `false`
	/// (nothing written) for any other word. After pathname expansion,
	/// [`compound_text`] builds the argument (`prefix` + text). `args`: the
	/// command's words before it; after an option word holding `A`
	/// (`declare -A a=(k v)`) a list starting without `[key]=` is key-value
	/// pairs, expanded as [`Self::kvpair`] does (bash `fix_assignment_words`
	/// marks the word `W_ASSIGNASSOC`).
	pub fn decl_compound(
		&mut self,
		unit: &Arc<Unit>,
		w: &Word,
		args: &[BString],
		prefix: &mut Vec<u8>,
		out: &mut Vec<CompoundElem>,
		globs: &mut Vec<(u32, BString)>,
	) -> X<bool> {
		let (Some(Part::Compound(elems)), WordKind::DeclArg) = (w.parts.last(), w.kind) else {
			return Ok(false);
		};
		let mut sink = Sink::Scalar(Vec::new());
		for part in &w.parts[..w.parts.len() - 1] {
			self.part(unit, part, &mut sink, false, false)?;
		}
		if let Sink::Scalar(text) = sink {
			prefix.extend_from_slice(&text);
		}
		let assoc = args
			.iter()
			.skip(1)
			.any(|a| a.first() == Some(&b'-') && a[1..].contains(&b'A'));
		// zsh's typeset takes a plain list as key/value pairs itself (and
		// rejects a mixed one).
		if assoc
			&& elems.first().is_some_and(|e| e.key.is_none())
			&& unit.mode.dialect() != crate::bash::ids::Dialect::Zsh
		{
			self.kvpair(unit, elems, true, out)?;
		} else {
			self.compound(unit, elems, out, Some(globs))?;
		}
		Ok(true)
	}

	/// The expanded replacement word of `${x/p/r}`, ready for
	/// [`replacement`]: with `patsub_replacement`, a quoted `&` or `\` is
	/// backslash-escaped and unquoted text is kept as it is (bash
	/// `quote_string_for_repl`); without it every `&` and `\` is escaped, so
	/// the text is used verbatim.
	fn replacement_text(&mut self, unit: &Arc<Unit>, w: &Word) -> X<BString> {
		let mut sink = Sink::Regex(Vec::with_capacity(lit_len(w)));
		self.word(unit, w, &mut sink, false, false)?;
		let Sink::Regex(marked) = sink else {
			return Ok(BString::default());
		};
		let amp = state::option(&mut self.k.root, self.cx.store, self.vp, OptId::PatsubReplacement)?;
		let mut out = Vec::with_capacity(marked.len());
		let mut i = 0;
		while i < marked.len() {
			let (byte, quoted) = if marked[i] == CTLESC && i + 1 < marked.len() {
				i += 2;
				(marked[i - 1], true)
			} else {
				i += 1;
				(marked[i - 1], false)
			};
			if matches!(byte, b'&' | b'\\') && (quoted || !amp) {
				out.push(b'\\');
			}
			out.push(byte);
		}
		Ok(BString::from(out))
	}

	/// `${x@P}`: bash `decode_prompt_string`, then (with `promptvars`)
	/// parameter, command and arithmetic expansion of the result like a
	/// here-document body (`expand_prompt_string`). Text an escape produces
	/// is backslash-protected from that pass. The date, time, tty and
	/// command-number escapes are not supported and fail loudly.
	fn prompt(&mut self, text: &[u8]) -> X<BString> {
		let opt = |ex: &mut Self, id| state::option(&mut ex.k.root, ex.cx.store, ex.vp, id);
		let posix = opt(self, OptId::Posix)?;
		let editing = opt(self, OptId::Emacs)? || opt(self, OptId::Vi)?;
		let promptvars = opt(self, OptId::Promptvars)?;
		let mut out = Vec::with_capacity(text.len());
		let lit = |out: &mut Vec<u8>, bytes: &[u8]| {
			for &byte in bytes {
				if promptvars && matches!(byte, b'\\' | b'$' | b'`') {
					out.push(b'\\');
				}
				out.push(byte);
			}
		};
		let mut i = 0;
		while i < text.len() {
			let ch = text[i];
			if posix && ch == b'!' {
				// posix mode: `!` is the history number, `!!` a `!`.
				if text.get(i + 1) == Some(&b'!') {
					lit(&mut out, b"!");
					i += 2;
				} else {
					lit(&mut out, b"1");
					i += 1;
				}
				continue;
			}
			if ch != b'\\' || i + 1 == text.len() {
				out.push(ch);
				i += 1;
				continue;
			}
			let esc = text[i + 1];
			i += 2;
			match esc {
				b'a' => lit(&mut out, &[0x07]),
				b'e' => lit(&mut out, &[0x1b]),
				b'n' => lit(&mut out, b"\n"),
				b'r' => lit(&mut out, b"\r"),
				b'\\' => lit(&mut out, b"\\"),
				b'$' => {
					let root = self.cx.host.user().euid == 0;
					lit(&mut out, if root { b"#" } else { b"$" });
				},
				b'[' if editing => lit(&mut out, &[0x01]),
				b']' if editing => lit(&mut out, &[0x02]),
				b'[' | b']' => {},
				b'0'..=b'7' => {
					let mut code = u32::from(esc - b'0');
					let mut count = 1;
					while count < 3
						&& let Some(&digit @ b'0'..=b'7') = text.get(i)
					{
						code = code * 8 + u32::from(digit - b'0');
						i += 1;
						count += 1;
					}
					lit(&mut out, &[(code & 0xff) as u8]);
				},
				b's' => lit(&mut out, b"bash"),
				b'v' | b'V' => {
					let release = super::BASH_VERSION.split('(').next().unwrap_or_default();
					let shown = if esc == b'v' {
						release
							.rsplit_once('.')
							.map_or(release, |(major_minor, _)| major_minor)
					} else {
						release
					};
					lit(&mut out, shown.as_bytes());
				},
				b'u' => {
					let name = self.cx.host.user().name;
					lit(&mut out, &name);
				},
				b'h' | b'H' => {
					let host = self.cx.host.hostname();
					let shown: &[u8] = if esc == b'h' {
						host.split_str(".").next().unwrap_or_default()
					} else {
						host.as_slice()
					};
					lit(&mut out, shown);
				},
				b'w' | b'W' => {
					let dir = self.prompt_dir(esc == b'W')?;
					lit(&mut out, &dir);
				},
				b'j' => {
					let jobs = self.vp.jobs.len();
					lit(&mut out, jobs.format_into(&mut NumBuffer::new()).as_bytes());
				},
				// No history list: the next history number is 1.
				b'!' => lit(&mut out, b"1"),
				b'd' | b't' | b'T' | b'@' | b'A' | b'D' | b'#' | b'l' => {
					return Err(Stop::Fail(Diag::Unsupported {
						what: format!("prompt escape \\{}", char::from(esc)).into(),
					}));
				},
				_ => {
					out.push(b'\\');
					out.push(esc);
				},
			}
		}
		if !promptvars {
			return Ok(BString::from(out));
		}
		let unit = self
			.k
			.engine
			.text_unit(&out, super::TextKind::HereDoc, self.vp_mode())
			.map_err(|err| Stop::Fail(Diag::Syntax { msg: err.msg }))?;
		let word = unit.words.last().cloned().unwrap_or_default();
		self.scalar(&unit, &word)
	}

	/// `\w` (`$PWD` with `$HOME` shown as `~`) or `\W` (its last component,
	/// `~` for `$HOME` itself).
	fn prompt_dir(&mut self, base: bool) -> X<BString> {
		let get = |ex: &mut Self, n: &[u8]| -> X<BString> {
			Ok(state::lookup(&ex.k.root, ex.cx.store, ex.vp, n)?
				.and_then(Var::as_scalar)
				.map_or_default(BString::from))
		};
		let pwd = get(self, b"PWD")?;
		let home = get(self, b"HOME")?;
		let at_home = |p: &[u8]| {
			!home.is_empty() && p.starts_with(&home) && matches!(p.get(home.len()), None | Some(b'/'))
		};
		if base {
			if !home.is_empty() && pwd == home {
				return Ok(BString::from("~"));
			}
			if pwd.as_slice() == b"/" {
				return Ok(pwd);
			}
			let last = pwd
				.rsplit_str("/")
				.find(|s| !s.is_empty())
				.unwrap_or_default();
			return Ok(BString::from(last));
		}
		if at_home(&pwd) {
			let mut s = BString::from("~");
			s.extend_from_slice(&pwd[home.len()..]);
			return Ok(s);
		}
		Ok(pwd)
	}

	/// The plain reference `${!v@op}` turns into: `name` taken from `v`'s
	/// value; `None` when `v` is no plain variable or names no variable
	/// name (the general indirection path handles those).
	fn indirect_target(&mut self, p: &ParamIr) -> X<Option<ParamIr>> {
		let (ParamRef::Var(n), None) = (&p.param, &p.index) else {
			return Ok(None);
		};
		let n = n.clone();
		let Val::Str(target) = self.read_atom(|ex| ex.var_value(&n, None, false))? else {
			return Ok(None);
		};
		if !super::is_ident(&target) {
			return Ok(None);
		}
		Ok(Some(ParamIr {
			param:    ParamRef::Var(target),
			index:    None,
			op:       p.op.clone(),
			indirect: false,
			quoted:   p.quoted,
			braced:   p.braced,
		}))
	}

	/// Whether variable `p` has any element (for `set -u` on transforms).
	fn has_elements(&mut self, p: &ParamIr) -> X<bool> {
		let ParamRef::Var(n) = &p.param else {
			return Ok(false);
		};
		Ok(state::lookup(&self.k.root, self.cx.store, self.vp, n)?
			.is_some_and(|v| !v.values().is_empty()))
	}

	/// The indices of the indexed array `${a[@]:o:l}` slices (bash slices
	/// those by index, not position); `None` for any other parameter.
	fn slice_indices(&mut self, p: &ParamIr) -> X<Option<Vec<i64>>> {
		let (ParamRef::Var(name), Some(SubIr::At | SubIr::Star), false) =
			(&p.param, &p.index, p.indirect)
		else {
			return Ok(None);
		};
		if is_dynamic(name) {
			return Ok(None);
		}
		let name = name.clone();
		// Through the replay log as decimal text, like any other read.
		let v = self.read_atom(|ex| {
			Ok(match state::lookup(&ex.k.root, ex.cx.store, ex.vp, &name)?.map(|v| &v.value) {
				Some(VarValue::Indexed(items)) => Val::List {
					items: items
						.iter()
						.map(|(i, _)| BString::from(i.format_into(&mut NumBuffer::new())))
						.collect(),
					star:  false,
				},
				_ => Val::Unset,
			})
		})?;
		Ok(match v {
			Val::List { items, .. } => Some(
				items
					.iter()
					.filter_map(|i| std::str::from_utf8(i).ok()?.parse().ok())
					.collect(),
			),
			_ => None,
		})
	}

	/// `${s[@]}` / `${s[*]}` of a set scalar (not array) variable `s`.
	fn scalar_element_list(&mut self, p: &ParamIr) -> X<bool> {
		let (ParamRef::Var(name), Some(SubIr::At | SubIr::Star), false) =
			(&p.param, &p.index, p.indirect)
		else {
			return Ok(false);
		};
		Ok(state::lookup(&self.k.root, self.cx.store, self.vp, name)?
			.is_some_and(|v| matches!(v.value, VarValue::Str(_))))
	}

	fn is_assoc(&mut self, name: &[u8]) -> X<bool> {
		if dynamic_table(name).is_some() {
			return Ok(true);
		}
		// A declared but empty `declare -A a` counts.
		Ok(state::lookup_declared(&self.k.root, self.cx.store, self.vp, name)?
			.is_some_and(|v| matches!(v.value, VarValue::Assoc(_)) || v.attrs.contains(Attrs::ASSOC)))
	}

	/// The entries of a dynamic associative array (`BASH_CMDS`,
	/// `BASH_ALIASES`) in bash's order.
	fn hash_table(&mut self, table: crate::bash::store::Table) -> X<Vec<(BString, BString)>> {
		Ok(hash_table(self.k, self.cx, self.vp, table)?)
	}

	/// `$!`: the pid of the last asynchronous child, its program's OS pid
	/// for a job known by it ([`super::proc::Bang`]). While that job is
	/// still deciding, a recording expansion waits for it
	/// ([`Stop::Wait`]); one that cannot park sees the virtual pid.
	pub fn last_bg(&self) -> X<Option<u32>> {
		let bg = self.vp.last_bg;
		match bg.vpid() {
			Some(v) if bg.os().is_none() && self.record && self.k.bang_pending(v) => {
				Err(Stop::Wait(WaitKey::Proc(v)))
			},
			_ => Ok(bg.pid()),
		}
	}

	fn special(&mut self, p: &ParamRef) -> X<Val> {
		Ok(match p {
			// `$0`, or the last value assigned to `BASH_ARGV0`.
			ParamRef::Positional(0) => {
				Val::Str(state::dollar0(self.cx.store, self.vp, &self.k.argv0)?)
			},
			ParamRef::Positional(n) => {
				let pos = state::positional_ref(&self.k.root, self.cx.store, self.vp)?;
				pos.get(*n as usize - 1)
					.cloned()
					.map_or(Val::Unset, Val::Str)
			},
			ParamRef::Count => {
				let n = state::positional_ref(&self.k.root, self.cx.store, self.vp)?.len();
				Val::Str(BString::from(n.format_into(&mut NumBuffer::new())))
			},
			ParamRef::Status => {
				Val::Str(BString::from(self.vp.status.format_into(&mut NumBuffer::new())))
			},
			// The recorded `$$`: a nested shell (`bash -c` run in-engine)
			// keeps its own in its overlay.
			ParamRef::ShellPid => match state::record(
				self.cx.store,
				self.vp,
				crate::bash::store::Key::Misc(crate::bash::store::MiscKey::ShellPid),
			)? {
				Some(crate::bash::store::Record::Misc(v)) => Val::Str(v.clone()),
				_ => Val::Str(BString::from(self.k.shell_pid.format_into(&mut NumBuffer::new()))),
			},
			ParamRef::LastBg => match self.last_bg()? {
				Some(pid) => Val::Str(BString::from(pid.format_into(&mut NumBuffer::new()))),
				None => Val::Unset,
			},
			ParamRef::Flags => {
				let interactive = matches!(
					state::record(
						self.cx.store,
						self.vp,
						crate::bash::store::Key::Misc(crate::bash::store::MiscKey::Interactive)
					)?,
					Some(crate::bash::store::Record::Misc(v)) if v.as_slice() == b"1"
				);
				let mut s = BString::default();
				for opt in FLAG_OPTS {
					if state::option(&mut self.k.root, self.cx.store, self.vp, opt)?
						&& let Some(c) = opt.flag()
					{
						s.push(c);
					}
					// bash's flag table puts `i` right after `h`.
					if opt == OptId::Hashall && interactive {
						s.push(b'i');
					}
				}
				// `s`: the script is read from standard input; `c`: a `-c`
				// string (bash appends it last). Recorded when the top-level
				// run starts, so subshells inherit it.
				if let Some(crate::bash::store::Record::Misc(origin)) = state::record(
					self.cx.store,
					self.vp,
					crate::bash::store::Key::Misc(crate::bash::store::MiscKey::RunOrigin),
				)? {
					s.extend_from_slice(origin);
				}
				Val::Str(s)
			},
			ParamRef::At | ParamRef::Star | ParamRef::Var(_) => Val::Unset,
		})
	}

	/// Value of variable `name` (element `index`, or every element when
	/// `list`), including bash's dynamic variables.
	fn var_value(&mut self, name: &[u8], index: Option<&[u8]>, list: bool) -> X<Val> {
		if let Some(v) = self.dynamic(name)? {
			return Ok(match (v, list) {
				(DynVal::Str(s), true) => Val::List { items: vec![s], star: false },
				(DynVal::Str(s), false) if index.is_none_or(|i| i == b"0") => Val::Str(s),
				(DynVal::Str(_), false) => Val::Unset,
				(DynVal::List(items), true) => Val::List { items, star: false },
				(DynVal::List(items), false) => {
					let i: i64 = index
						.and_then(|i| std::str::from_utf8(i).ok()?.parse().ok())
						.unwrap_or(0);
					let i = if i < 0 { items.len() as i64 + i } else { i };
					usize::try_from(i)
						.ok()
						.and_then(|i| items.get(i).cloned())
						.map_or(Val::Unset, Val::Str)
				},
				(DynVal::Assoc(pairs), true) => {
					Val::List { items: pairs.into_iter().map(|(_, v)| v).collect(), star: false }
				},
				(DynVal::Assoc(pairs), false) => {
					let key = index.unwrap_or(b"0");
					pairs
						.into_iter()
						.find(|(k, _)| k.as_slice() == key)
						.map_or(Val::Unset, |(_, v)| Val::Str(v))
				},
			});
		}
		// Namerefs: `lookup` follows whole-variable references itself; an
		// element reference (`declare -n e=a[1]`) reads that element, a
		// circular one warns and reads unset.
		match state::deref(&self.k.root, self.cx.store, self.vp, name)? {
			state::Deref::Circular => {
				let msg =
					BString::from(format!("warning: {}: circular name reference", name.as_bstr()));
				self
					.k
					.diag(self.cx, self.vp, self.line, Diag::Warning { msg });
				// A function's reference to its own name (`typeset -n v=v`)
				// reads the global variable of that name, as its assignment
				// writes it.
				let self_ref = state::lookup_declared(&self.k.root, self.cx.store, self.vp, name)?
					.and_then(Var::as_scalar)
					.is_some_and(|t| t == name)
					&& func_binds(&self.k.root, self.cx.store, self.vp, name)?;
				if !self_ref {
					return Ok(Val::Unset);
				}
				let global = match self.vp.overlay.as_ref().and_then(|ov| ov.vars.get(name)) {
					Some(entry) => entry.clone(),
					None => state::global(self.cx.store, name)?.cloned(),
				};
				return Ok(global
					.filter(|v| !v.attrs.contains(Attrs::INVISIBLE) && !v.attrs.contains(Attrs::NAMEREF))
					.map_or(Val::Unset, |v| plain_element(&v, index, list)));
			},
			state::Deref::To { name: target, index: Some(sub) } if index.is_none() && !list => {
				let key = if self.is_assoc(&target)? {
					sub
				} else {
					let n = arith_value(self.k, self.cx, self.vp, &sub).map_err(Stop::Fail)?;
					BString::from(n.format_into(&mut NumBuffer::new()))
				};
				return self.var_value(&target, Some(key.as_slice()), false);
			},
			state::Deref::To { .. } | state::Deref::Plain => {},
		}
		let Some(var) = state::lookup(&self.k.root, self.cx.store, self.vp, name)? else {
			// A negative subscript of an unset (or declared, unset) array
			// has no element to count back from: bash warns as for one
			// past the start (`declare -ar c; ${c[-4]}`).
			if !list
				&& let Some(i) = index
				&& i.starts_with(b"-")
				&& !self.is_assoc(name)?
			{
				let msg = format!("{}: bad array subscript", name.as_bstr()).into();
				self
					.k
					.diag(self.cx, self.vp, self.line, Diag::Usage { msg });
			}
			return Ok(Val::Unset);
		};
		if list {
			return Ok(Val::List { items: var.values(), star: false });
		}
		Ok(match index {
			None => var
				.as_scalar()
				.map_or(Val::Unset, |s| Val::Str(BString::from(s))),
			Some(i) => {
				if let VarValue::Assoc(_) = &var.value {
					var.key(i)
						.map_or(Val::Unset, |s| Val::Str(BString::from(s)))
				} else {
					let n: i64 = std::str::from_utf8(i)
						.ok()
						.and_then(|i| i.parse().ok())
						.unwrap_or(0);
					let n = if n < 0 { var.next_index() + n } else { n };
					if n < 0 {
						// bash warns and expands to nothing (`${c[-4]}` of a
						// 2-element array).
						let msg = format!("{}: bad array subscript", name.as_bstr()).into();
						self
							.k
							.diag(self.cx, self.vp, self.line, Diag::Usage { msg });
						return Ok(Val::Unset);
					}
					var.index(n)
						.map_or(Val::Unset, |s| Val::Str(BString::from(s)))
				}
			},
		})
	}

	/// bash's dynamic variables (computed on every read).
	fn dynamic(&mut self, name: &[u8]) -> X<Option<DynVal>> {
		if matches!(name, b"BASH_ARGC" | b"BASH_ARGV") {
			super::callstack::read_base(self.k, self.cx.store, self.vp)?;
		}
		Ok(dynamic_value(self.k, self.cx, self.vp, self.line, name)?)
	}

	/// `${!name}` / `${!a[@]}`.
	fn indirect(&mut self, unit: &Arc<Unit>, p: &ParamIr) -> X<Val> {
		// `${!ref}` of a nameref is the name it refers to.
		if let (ParamRef::Var(name), None) = (&p.param, &p.index)
			&& state::lookup_declared(&self.k.root, self.cx.store, self.vp, name)?
				.is_some_and(|v| v.attrs.contains(Attrs::NAMEREF))
		{
			let name = name.clone();
			return self.read_atom(|ex| {
				Ok(state::lookup_declared(&ex.k.root, ex.cx.store, ex.vp, &name)?
					.and_then(Var::as_scalar)
					.map_or(Val::Unset, |s| Val::Str(BString::from(s))))
			});
		}
		// `${!a[@]}` lists the keys; with an operator (`${!v[@]@Q}`) it is an
		// indirection through the value of `v[@]`.
		if let (ParamRef::Var(name), Some(SubIr::At | SubIr::Star), false) =
			(&p.param, &p.index, p.indirect)
		{
			let name = name.clone();
			let star = matches!(p.index, Some(SubIr::Star));
			let v = self.read_atom(|ex| {
				if let Some(table) = dynamic_table(&name) {
					let items = ex.hash_table(table)?.into_iter().map(|(k, _)| k).collect();
					return Ok(Val::List { items, star });
				}
				Ok(match state::lookup(&ex.k.root, ex.cx.store, ex.vp, &name)? {
					Some(var) => Val::List { items: var.keys(), star },
					None => Val::List { items: Vec::new(), star },
				})
			})?;
			return Ok(match v {
				Val::List { items, .. } => Val::List { items, star },
				other => other,
			});
		}
		let direct = ParamIr {
			param:    p.param.clone(),
			index:    p.index.clone(),
			op:       OpIr::None,
			indirect: false,
			quoted:   p.quoted,
			braced:   p.braced,
		};
		let target = match self.value(unit, &direct)? {
			Val::Str(s) => s,
			Val::List { items, .. } => BString::from(items.join(&b' ')),
			// bash: an unset variable cannot be followed (`a[7]: invalid
			// indirect expansion` for an element of an unset array), but an
			// unset element of a set variable reads as unset; so does an
			// unset positional or special parameter.
			Val::Unset => {
				if let ParamRef::Var(n) = &p.param {
					let set = p.index.is_some()
						&& state::lookup(&self.k.root, self.cx.store, self.vp, n)?.is_some();
					if !set {
						return Err(Stop::Fail(Diag::InvalidIndirect {
							name: Self::unbound_name(unit, p, false),
						}));
					}
				}
				return Ok(Val::Unset);
			},
		};
		let (name, index) = match target.find_byte(b'[') {
			Some(i) if target.ends_with(b"]") => {
				(BString::from(&target[..i]), Some(BString::from(&target[i + 1..target.len() - 1])))
			},
			_ => (target, None),
		};
		// `${!@}` / `${!*}` with no parameters name nothing: unset, no error.
		if name.is_empty() && matches!(p.param, ParamRef::At | ParamRef::Star) {
			return Ok(Val::Unset);
		}
		if name.is_empty()
			|| (!super::is_ident(&name)
				&& !name.iter().all(u8::is_ascii_digit)
				&& !matches!(name.as_slice(), b"@" | b"*" | b"#" | b"?"))
		{
			return Err(Stop::Fail(Diag::InvalidVarName { name }));
		}
		let list = matches!(index.as_ref().map(|i| i.as_slice()), Some(b"@" | b"*"));
		let star = matches!(index.as_ref().map(|i| i.as_slice()), Some(b"*"));
		if name.iter().all(u8::is_ascii_digit) {
			let n: u32 = std::str::from_utf8(&name)
				.ok()
				.and_then(|n| n.parse().ok())
				.unwrap_or(0);
			return self.read_atom(|ex| ex.special(&ParamRef::Positional(n)));
		}
		match name.as_slice() {
			b"@" | b"*" => {
				let items = self.read_atom(|ex| {
					Ok(Val::List {
						items: state::positional(&ex.k.root, ex.cx.store, ex.vp)?,
						star:  false,
					})
				})?;
				return Ok(match items {
					Val::List { items, .. } => Val::List { items, star: name.as_slice() == b"*" },
					other => other,
				});
			},
			_ => {},
		}
		let idx = match index {
			Some(sub) if !list => Some(self.element_key(&name, &sub)?),
			_ => None,
		};
		let v = self.read_atom(|ex| ex.var_value(&name, idx.as_ref().map(|i| i.as_slice()), list))?;
		Ok(match v {
			Val::List { items, .. } => Val::List { items, star },
			other => other,
		})
	}

	fn transform(&mut self, p: &ParamIr, v: Val, op: u8) -> X<Val> {
		Ok(match op {
			b'Q' => map_val(v, quote::single),
			b'E' => map_val(v, crate::bash::ir::ansi_c),
			b'U' => map_val(v, |s| BString::from(s.to_uppercase())),
			b'L' => map_val(v, |s| BString::from(s.to_lowercase())),
			b'u' => map_val(v, |s| case_convert(s, CaseIr::Upper, false, None)),
			// Declared-but-unset variables keep their attributes here.
			b'a' => {
				let attrs = match &p.param {
					ParamRef::Var(n) => {
						state::lookup_declared(&self.k.root, self.cx.store, self.vp, n)?.map(attr_letters)
					},
					_ => None,
				};
				let attrs = attrs.unwrap_or_default();
				// One copy per element of `${a[@]@a}`.
				match v {
					Val::List { items, star } if !items.is_empty() => {
						Val::List { items: vec![attrs; items.len()], star }
					},
					_ => Val::Str(attrs),
				}
			},
			// bash `string_var_assignment` / `array_var_assignment`.
			b'A' => match (&p.param, &p.index) {
				(ParamRef::At | ParamRef::Star, _) => {
					let Val::List { items, .. } = v else {
						return Ok(Val::Unset);
					};
					let mut out = BString::from("set --");
					for it in &items {
						out.push(b' ');
						out.extend_from_slice(&quote::single(it));
					}
					Val::Str(out)
				},
				(ParamRef::Var(name), Some(SubIr::At | SubIr::Star)) => {
					let Some(var) =
						state::lookup_declared(&self.k.root, self.cx.store, self.vp, name)?.cloned()
					else {
						return Ok(Val::Unset);
					};
					let mut out = Vec::new();
					super::builtins::declare_line(name, Some(&var), &mut out);
					Val::Str(BString::from(out))
				},
				(ParamRef::Var(name), _) => {
					let Some(var) =
						state::lookup_declared(&self.k.root, self.cx.store, self.vp, name)?.cloned()
					else {
						return Ok(Val::Unset);
					};
					let letters = attr_letters(&var);
					let mut out = BString::default();
					if !letters.is_empty() {
						out.extend_from_slice(b"declare -");
						out.extend_from_slice(&letters);
						out.push(b' ');
					}
					match v {
						Val::Str(s) => {
							out.extend_from_slice(name);
							out.push(b'=');
							out.extend_from_slice(&quote::single(&s));
						},
						_ if !letters.is_empty() => out.extend_from_slice(name),
						_ => return Ok(Val::Unset),
					}
					Val::Str(out)
				},
				_ => map_val(v, |s| BString::from(s)),
			},
			b'P' => match v {
				Val::Unset => Val::Unset,
				Val::Str(s) => Val::Str(self.prompt(&s)?),
				Val::List { items, star } => {
					let mut out = Vec::with_capacity(items.len());
					for it in &items {
						out.push(self.prompt(it)?);
					}
					Val::List { items: out, star }
				},
			},
			b'K' | b'k' => {
				// Without `[@]`/`[*]` these quote the value like `@Q`.
				let (ParamRef::Var(name), Some(SubIr::At | SubIr::Star)) = (&p.param, &p.index) else {
					return Ok(map_val(v, quote::single));
				};
				let Some(var) = state::lookup(&self.k.root, self.cx.store, self.vp, name)?.cloned()
				else {
					return Ok(Val::Unset);
				};
				let assoc = matches!(var.value, VarValue::Assoc(_));
				let pairs: Vec<(BString, BString)> = var.keys().into_iter().zip(var.values()).collect();
				if op == b'K' {
					// bash `print_assoc_assignment`-style: keys as `declare -p`
					// shows them (bare when plain), values double-quoted; an
					// associative array ends with a space.
					let mut s = BString::default();
					for (i, (k, val)) in pairs.iter().enumerate() {
						if i > 0 {
							s.push(b' ');
						}
						if assoc {
							s.extend_from_slice(&quote::assoc_key(k));
						} else {
							s.extend_from_slice(k);
						}
						s.push(b' ');
						s.extend_from_slice(&quote::declare(val));
					}
					if assoc && !pairs.is_empty() {
						s.push(b' ');
					}
					Val::Str(s)
				} else {
					// `"${a[*]@k}"` joins like `"${a[*]}"`.
					Val::List {
						items: pairs.into_iter().flat_map(|(k, v)| [k, v]).collect(),
						star:  matches!(p.index, Some(SubIr::Star)),
					}
				}
			},
			_ => {
				return Err(Stop::Fail(Diag::BadSubst { text: Self::param_text(p) }));
			},
		})
	}
}

/// The variable (and element) a nameref chain ends at, for arithmetic.
fn deref_target<'a>(
	target: &'a state::Deref,
	name: &'a [u8],
	index: Option<&'a [u8]>,
) -> (&'a [u8], Option<&'a [u8]>) {
	match target {
		state::Deref::To { name: t, index: Some(i) } if index.is_none() => {
			(t.as_slice(), Some(i.as_slice()))
		},
		state::Deref::To { name: t, .. } => (t.as_slice(), index),
		state::Deref::Plain | state::Deref::Circular => (name, index),
	}
}

/// The value of `var` as `${v}` / `${v[index]}` / `${v[@]}` (`list`) read
/// it, without warnings (an index before the start reads unset).
fn plain_element(var: &Var, index: Option<&[u8]>, list: bool) -> Val {
	if list {
		return Val::List { items: var.values(), star: false };
	}
	let value = match index {
		None => var.as_scalar(),
		Some(i) if matches!(var.value, VarValue::Assoc(_)) => var.key(i),
		Some(i) => {
			let n: i64 = std::str::from_utf8(i)
				.ok()
				.and_then(|i| i.parse().ok())
				.unwrap_or(0);
			var.index(if n < 0 { var.next_index() + n } else { n })
		},
	};
	value.map_or(Val::Unset, |s| Val::Str(BString::from(s)))
}

/// The entries of `table` (`BASH_CMDS`, `BASH_ALIASES`) in bash's order.
fn hash_table(
	k: &Kernel,
	cx: &mut Cx<'_>,
	vp: &Vproc,
	table: crate::bash::store::Table,
) -> Result<Vec<(BString, BString)>, StoreError> {
	let items: Vec<(BString, BString)> = state::scan(&k.root, cx.store, vp, table)?
		.into_iter()
		.filter_map(|(key, r)| match (key, r) {
			(
				crate::bash::store::KeyBuf::CmdHash(n),
				crate::bash::store::Record::CmdHash { path, .. },
			) => Some((n, path)),
			(crate::bash::store::KeyBuf::Alias(n), crate::bash::store::Record::Alias(p)) => {
				Some((n, p))
			},
			_ => None,
		})
		.collect();
	// bash's hash tables: 256 buckets for commands, 64 for aliases.
	let buckets = if table == crate::bash::store::Table::CmdHash {
		state::CMD_HASH_BUCKETS
	} else {
		state::ALIAS_HASH_BUCKETS
	};
	let order = state::hash_order(&items, buckets);
	Ok(order.into_iter().cloned().collect())
}

/// bash's dynamic variables, computed on every read (`line` is `$LINENO`);
/// `None` for any other name.
fn dynamic_value(
	k: &mut Kernel,
	cx: &mut Cx<'_>,
	vp: &Vproc,
	line: u32,
	name: &[u8],
) -> Result<Option<DynVal>, StoreError> {
	Ok(Some(match name {
		b"RANDOM" => {
			DynVal::Str(BString::from(k.next_random(cx.store).format_into(&mut NumBuffer::new())))
		},
		b"SRANDOM" => DynVal::Str(BString::from(
			((cx.host.random() & 0xffff_ffff) as u32).format_into(&mut NumBuffer::new()),
		)),
		b"SECONDS" => {
			let s = cx.host.now_ns().saturating_sub(k.start_ns) / 1_000_000_000;
			DynVal::Str(BString::from(s.format_into(&mut NumBuffer::new())))
		},
		b"EPOCHSECONDS" => {
			DynVal::Str(BString::from(cx.host.wall().secs.format_into(&mut NumBuffer::new())))
		},
		b"EPOCHREALTIME" => {
			let w = cx.host.wall();
			DynVal::Str(BString::from(format!("{}.{:06}", w.secs, w.nanos / 1000)))
		},
		b"LINENO" => DynVal::Str(BString::from(line.format_into(&mut NumBuffer::new()))),
		b"BASH_COMMAND" => DynVal::Str(BString::from(vp.command_text())),
		b"BASH_CMDS" => DynVal::Assoc(hash_table(k, cx, vp, crate::bash::store::Table::CmdHash)?),
		b"BASH_ALIASES" => DynVal::Assoc(hash_table(k, cx, vp, crate::bash::store::Table::Alias)?),
		b"DIRSTACK" => DynVal::List(super::builtins::dirstack::dirstack_value(cx.store, vp)?),
		b"BASHPID" => DynVal::Str(BString::from(vp.vpid.0.format_into(&mut NumBuffer::new()))),
		b"BASH_SUBSHELL" => {
			DynVal::Str(BString::from(super::subshell_depth(vp).format_into(&mut NumBuffer::new())))
		},
		b"PIPESTATUS" => DynVal::List(
			vp.pipestatus
				.iter()
				.map(|s| BString::from(s.format_into(&mut NumBuffer::new())))
				.collect(),
		),
		// bash's call-stack arrays (`FUNCNAME` is invisible outside functions).
		b"FUNCNAME" | b"BASH_SOURCE" | b"BASH_LINENO" | b"BASH_ARGC" | b"BASH_ARGV" => {
			match super::callstack::array(k, cx.store, vp, name)? {
				Some(list) => DynVal::List(list),
				None => return Ok(None),
			}
		},
		_ => return Ok(None),
	}))
}

/// Whether [`Expander::dynamic`] computes `name` (keep in sync).
const fn is_dynamic(name: &[u8]) -> bool {
	matches!(
		name,
		b"RANDOM"
			| b"SRANDOM"
			| b"SECONDS"
			| b"EPOCHSECONDS"
			| b"EPOCHREALTIME"
			| b"LINENO"
			| b"BASH_COMMAND"
			| b"BASH_CMDS"
			| b"BASH_ALIASES"
			| b"DIRSTACK"
			| b"BASHPID"
			| b"BASH_SUBSHELL"
			| b"PIPESTATUS"
			| b"FUNCNAME"
			| b"BASH_SOURCE"
			| b"BASH_LINENO"
			| b"BASH_ARGC"
			| b"BASH_ARGV"
	)
}

/// Value of a dynamic variable.
enum DynVal {
	Str(BString),
	List(Vec<BString>),
	/// `(key, value)` pairs in bash's hash-table order.
	Assoc(Vec<(BString, BString)>),
}

/// The dynamic associative arrays: the table each one shows.
const fn dynamic_table(name: &[u8]) -> Option<crate::bash::store::Table> {
	match name {
		b"BASH_CMDS" => Some(crate::bash::store::Table::CmdHash),
		b"BASH_ALIASES" => Some(crate::bash::store::Table::Alias),
		_ => None,
	}
}

/// Attribute letters of `${x@a}` / `declare -p`, in bash's order.
pub fn attr_letters(v: &Var) -> BString {
	let mut s = BString::default();
	// bash `var_attribute_string`: a A i n r t x c l u.
	for (a, c) in [
		(Attrs::INDEXED, b'a'),
		(Attrs::ASSOC, b'A'),
		(Attrs::INTEGER, b'i'),
		(Attrs::NAMEREF, b'n'),
		(Attrs::READONLY, b'r'),
		(Attrs::TRACE, b't'),
		(Attrs::EXPORT, b'x'),
		(Attrs::CAPITALIZE, b'c'),
		(Attrs::LOWER, b'l'),
		(Attrs::UPPER, b'u'),
	] {
		let present = v.attrs.contains(a)
			|| (a == Attrs::INDEXED && matches!(v.value, VarValue::Indexed(_)))
			|| (a == Attrs::ASSOC && matches!(v.value, VarValue::Assoc(_)));
		if present {
			s.push(c);
		}
	}
	s
}

/// The brackets `$(`, `${` and `$[` open and close.
const fn pair_of(open: u8) -> (u8, u8) {
	match open {
		b'(' => (b'(', b')'),
		b'{' => (b'{', b'}'),
		_ => (b'[', b']'),
	}
}

/// Append an expanded subscript `value` backslash-quoted for the evaluator
/// (bash `sh_backslash_quote` with `expand_array_subscript`'s table: `[`,
/// `]`, `$`, `` ` ``, `~`, `\`, `'`, `"`), escaped once more for the
/// arithmetic-text parse that reads `out`.
fn push_quoted_subscript(out: &mut Vec<u8>, value: &[u8]) {
	for &c in value {
		match c {
			// `\c` that the arithmetic-text parse keeps as is.
			b'$' | b'`' | b'"' | b'\\' => out.extend_from_slice(&[b'\\', b'\\', b'\\', c]),
			b'[' | b']' | b'~' | b'\'' => out.extend_from_slice(&[b'\\', c]),
			_ => out.push(c),
		}
	}
}

/// The index of the `` ` `` closing a command substitution whose text
/// starts at `i`.
const fn skip_backquote(s: &[u8], mut i: usize) -> Option<usize> {
	while i < s.len() {
		match s[i] {
			b'\\' => i += 2,
			b'`' => return Some(i),
			_ => i += 1,
		}
	}
	None
}

/// The index of the `"` closing a double-quoted string whose text starts
/// at `i` (bash `skip_double_quoted`).
fn skip_dquoted(s: &[u8], mut i: usize) -> Option<usize> {
	while i < s.len() {
		match s[i] {
			b'\\' => i += 2,
			b'"' => return Some(i),
			b'`' => i = skip_backquote(s, i + 1)? + 1,
			b'$' if matches!(s.get(i + 1), Some(b'(' | b'{' | b'[')) => {
				let (open, close) = pair_of(s[i + 1]);
				i = skip_pair(s, i + 2, open, close)? + 1;
			},
			_ => i += 1,
		}
	}
	None
}

/// bash `skip_matched_pair`: the index of the `close` matching an `open`
/// just before `i` (nested pairs counted; quoted strings, escapes and
/// substitutions skipped); `None` when unterminated.
fn skip_pair(s: &[u8], mut i: usize, open: u8, close: u8) -> Option<usize> {
	let mut depth = 1usize;
	while i < s.len() {
		let c = s[i];
		if c == b'\\' {
			i += 2;
		} else if c == b'`' {
			i = skip_backquote(s, i + 1)? + 1;
		} else if c == open {
			depth += 1;
			i += 1;
		} else if c == close {
			depth -= 1;
			if depth == 0 {
				return Some(i);
			}
			i += 1;
		} else if c == b'\'' {
			i += s[i + 1..].iter().position(|&q| q == b'\'')? + 2;
		} else if c == b'"' {
			i = skip_dquoted(s, i + 1)? + 1;
		} else if c == b'$' && matches!(s.get(i + 1), Some(b'(' | b'{')) {
			let (o, cl) = pair_of(s[i + 1]);
			i = skip_pair(s, i + 2, o, cl)? + 1;
		} else {
			i += 1;
		}
	}
	None
}

/// Subscript text rewritten so that the arithmetic-text parse (double-quote
/// rules) expands it like an unquoted word, as bash's
/// `expand_subscript_string` does: `'…'` and `\c` quote, `"…"` and
/// substitutions are kept.
fn subscript_as_arith_text(sub: &[u8]) -> Vec<u8> {
	let special = |c: u8| matches!(c, b'$' | b'`' | b'"' | b'\\');
	let mut out = Vec::with_capacity(sub.len() + 8);
	let mut i = 0;
	while i < sub.len() {
		let c = sub[i];
		let end = match c {
			b'\\' => {
				match sub.get(i + 1) {
					Some(b'\n') => {},
					Some(&d) if special(d) => out.extend_from_slice(&[b'\\', d]),
					Some(&d) => out.push(d),
					None => out.push(b'\\'),
				}
				i += 2;
				continue;
			},
			b'\'' => {
				let Some(n) = sub[i + 1..].iter().position(|&q| q == b'\'') else {
					out.extend_from_slice(&sub[i..]);
					break;
				};
				for &d in &sub[i + 1..i + 1 + n] {
					if special(d) {
						out.push(b'\\');
					}
					out.push(d);
				}
				i += n + 2;
				continue;
			},
			b'"' => skip_dquoted(sub, i + 1),
			b'`' => skip_backquote(sub, i + 1),
			b'$' if matches!(sub.get(i + 1), Some(b'(' | b'{' | b'[')) => {
				let (open, close) = pair_of(sub[i + 1]);
				skip_pair(sub, i + 2, open, close)
			},
			_ => {
				out.push(c);
				i += 1;
				continue;
			},
		};
		let end = end.map_or(sub.len(), |e| e + 1);
		out.extend_from_slice(&sub[i..end]);
		i = end;
	}
	out
}

/// Source text of word `w` as written (a subscript in `set -u` errors).
fn word_source(unit: &Unit, w: u32) -> &[u8] {
	unit
		.words
		.get(w as usize)
		.and_then(|w| unit.nodes.get(w.node as usize))
		.and_then(|n| unit.source.get(n.lo as usize..n.hi as usize))
		.unwrap_or_default()
}

/// `[a, b)` of a substring with bash's negative-offset rules; `None` when
/// out of range.
fn slice_bounds(n: usize, off: i64, len: Option<i64>) -> Option<(usize, usize)> {
	let n = n as i64;
	let start = if off < 0 { n + off } else { off };
	if start < 0 || start > n {
		return None;
	}
	let end = match len {
		None => n,
		Some(l) if l < 0 => n + l,
		Some(l) => (start + l).min(n),
	};
	if end < start {
		return None;
	}
	Some((start as usize, end as usize))
}

fn map_val(v: Val, f: impl Fn(&[u8]) -> BString) -> Val {
	match v {
		Val::Unset => Val::Unset,
		Val::Str(s) => Val::Str(f(&s)),
		Val::List { items, star } => Val::List { items: items.iter().map(|s| f(s)).collect(), star },
	}
}

fn trim(text: &[u8], pat: &Pattern, suffix: bool, longest: bool) -> BString {
	let kept = if suffix {
		pat.suffix(text, longest).map(|start| &text[..start])
	} else {
		pat.prefix(text, longest).map(|end| &text[end..])
	};
	BString::from(kept.unwrap_or(text))
}

/// The replacement text, as bash's `strcreplace`: `&` is the match, `\&`
/// a literal `&`, `\\` a backslash, any other `\x` stays `\x`.
fn replacement(rep: &[u8], matched: &[u8], out: &mut Vec<u8>) {
	let mut i = 0;
	while i < rep.len() {
		match rep[i] {
			b'\\' if matches!(rep.get(i + 1), Some(b'&' | b'\\')) => {
				out.push(rep[i + 1]);
				i += 2;
			},
			b'&' => {
				out.extend_from_slice(matched);
				i += 1;
			},
			c => {
				out.push(c);
				i += 1;
			},
		}
	}
}

fn replace(
	text: &[u8],
	pat: &Pattern,
	empty: bool,
	mode: ReplaceIr,
	rep: Option<&[u8]>,
) -> BString {
	let rep = rep.unwrap_or_default();
	let len = text.len();
	let mut out = Vec::with_capacity(len);
	match mode {
		ReplaceIr::Prefix => {
			if let Some(end) = pat.prefix(text, true) {
				replacement(rep, &text[..end], &mut out);
				out.extend_from_slice(&text[end..]);
				return BString::from(out);
			}
			return BString::from(text);
		},
		ReplaceIr::Suffix => {
			if let Some(start) = pat.suffix(text, true) {
				out.extend_from_slice(&text[..start]);
				replacement(rep, &text[start..], &mut out);
				return BString::from(out);
			}
			return BString::from(text);
		},
		ReplaceIr::First | ReplaceIr::All => {},
	}
	if empty {
		return BString::from(text);
	}
	// An empty value: a pattern matching the empty string is replaced
	// (`var=; ${var//*/x}` is `x`).
	if len == 0 {
		if pat.find(text, 0).is_some() {
			replacement(rep, text, &mut out);
			return BString::from(out);
		}
		return BString::from(text);
	}
	// bash `match_pattern` with `MATCH_ANY`: leftmost-longest matches; an
	// empty one is skipped by one character.
	let mut i = 0;
	while i < len {
		let Some(m) = pat.find(text, i) else {
			break;
		};
		out.extend_from_slice(&text[i..m.start]);
		if m.end > m.start {
			replacement(rep, &text[m.clone()], &mut out);
			i = m.end;
			if mode == ReplaceIr::First {
				break;
			}
		} else {
			if m.start >= len {
				i = len;
				break;
			}
			let step = bstr::decode_utf8(&text[m.start..]).1.max(1);
			out.extend_from_slice(&text[m.start..m.start + step]);
			i = m.start + step;
		}
	}
	out.extend_from_slice(&text[i..]);
	BString::from(out)
}

fn case_convert(s: &[u8], mode: CaseIr, all: bool, pat: Option<&Pattern>) -> BString {
	let text = s.to_str_lossy();
	let mut out = String::with_capacity(text.len());
	for (i, c) in text.chars().enumerate() {
		let mut tmp = [0; char::MAX_LEN_UTF8];
		let hit =
			(all || i == 0) && pat.is_none_or(|p| p.matches(c.encode_utf8(&mut tmp).as_bytes()));
		if hit {
			match mode {
				CaseIr::Upper => out.extend(c.to_uppercase()),
				CaseIr::Lower => out.extend(c.to_lowercase()),
				CaseIr::Toggle => {
					if c.is_uppercase() {
						out.extend(c.to_lowercase());
					} else {
						out.extend(c.to_uppercase());
					}
				},
			}
		} else {
			out.push(c);
		}
	}
	BString::from(out)
}

impl Sink<'_> {
	/// Literal text (quoted: not split, escaped in patterns).
	fn lit(&mut self, b: &[u8], quoted: bool) {
		match self {
			Self::Fields(f) => {
				if quoted {
					f.push_quoted(b);
				} else {
					f.push_raw(b);
				}
				f.have |= quoted || !b.is_empty();
			},
			Self::Scalar(s) => s.extend_from_slice(b),
			Self::Pattern(s) => {
				if quoted {
					quote::glob_escape(b, s);
				} else {
					s.extend_from_slice(b);
				}
			},
			Self::Regex(s) => {
				for &c in b {
					if quoted || matches!(c, CTLESC | CTLNUL) {
						s.push(CTLESC);
					}
					s.push(c);
				}
			},
		}
	}

	/// An expansion result (unquoted: split in field context). A quoted
	/// empty result does not make a field by itself: the compiler ends
	/// each double-quoted group with an explicit quoted null unless the
	/// group holds a `"$@"`-style list (`"$xxx$@"` with no parameters is no
	/// word at all).
	fn value(&mut self, v: &[u8], quoted: bool) {
		match self {
			Self::Fields(f) => {
				if quoted {
					f.push_quoted(v);
					f.have |= !v.is_empty();
				} else {
					f.split(v);
				}
			},
			_ => self.lit(v, quoted),
		}
	}
}

/// One element of an expanded compound assignment `(…)`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CompoundElem {
	/// `[key]=` (expanded, not split); `None` for an unkeyed word.
	pub key:    Option<BString>,
	/// `[key]+=`.
	pub append: bool,
	/// The value (one word of an unkeyed element).
	pub value:  BString,
}

/// The `(…)` text a declaration builtin re-reads: each value (and key)
/// single-quoted, `[k]=v` / `[k]+=v` for keyed elements.
pub fn compound_text(elems: &[CompoundElem]) -> BString {
	let mut text = BString::from("(");
	for (i, e) in elems.iter().enumerate() {
		if i > 0 {
			text.push(b' ');
		}
		if let Some(key) = &e.key {
			text.push(b'[');
			text.extend_from_slice(&quote::single(key));
			text.extend_from_slice(if e.append { b"]+=" } else { b"]=" });
		}
		text.extend_from_slice(&quote::single(&e.value));
	}
	text.push(b')');
	text
}

/// Whether `IFS` holds character `c` (one byte, or with `wide` one UTF-8
/// character, an invalid byte counting as its own character).
fn ifs_has(ifs: &[u8], c: &[u8], wide: bool) -> bool {
	if !wide {
		return ifs.contains(&c[0]);
	}
	let mut j = 0;
	while j < ifs.len() {
		let m = bstr::decode_utf8(&ifs[j..]).1.max(1);
		if &ifs[j..j + m] == c {
			return true;
		}
		j += m;
	}
	false
}

/// The bytes of `w`'s literal parts (a capacity hint).
fn lit_len(w: &Word) -> usize {
	w.parts
		.iter()
		.map(|p| match p {
			Part::Lit(b) | Part::Quoted(b) => b.len(),
			_ => 0,
		})
		.sum()
}

/// A cleared buffer from `pool`, or a new one.
fn spare(pool: &mut Vec<BString>) -> Vec<u8> {
	pool.pop().map_or_else(Vec::new, |b| {
		let mut v = Vec::from(b);
		v.clear();
		v
	})
}

/// The text of a [`Word::fixed`] word (quotes removed), borrowed from the
/// IR when it has one part.
fn fixed_text(w: &Word) -> Cow<'_, [u8]> {
	match w.parts.as_slice() {
		[Part::Lit(b) | Part::Quoted(b)] => Cow::Borrowed(b.as_slice()),
		parts => {
			let mut out = Vec::with_capacity(lit_len(w));
			for p in parts {
				if let Part::Lit(b) | Part::Quoted(b) = p {
					out.extend_from_slice(b);
				}
			}
			Cow::Owned(out)
		},
	}
}

/// The pattern form of a [`Word::fixed`] word (quoted characters
/// backslash-escaped, as [`Expander::pattern`] makes it), borrowed from the
/// IR when it is one unquoted part.
fn fixed_pattern(w: &Word) -> Cow<'_, [u8]> {
	match w.parts.as_slice() {
		[Part::Lit(b)] => Cow::Borrowed(b.as_slice()),
		parts => {
			let mut out = Vec::with_capacity(lit_len(w));
			for p in parts {
				match p {
					Part::Lit(b) => out.extend_from_slice(b),
					Part::Quoted(b) => quote::glob_escape(b, &mut out),
					_ => {},
				}
			}
			Cow::Owned(out)
		},
	}
}

/// Whether an unquoted `rhs` word holding `$@` is split and rejoined
/// ([`Expander::op_word`]): `IFS` is set and starts with a non-whitespace
/// byte.
fn rejoins(ifs: Option<&[u8]>) -> bool {
	ifs.and_then(<[u8]>::first)
		.is_some_and(|&c| !matches!(c, b' ' | b'\t' | b'\n'))
}

/// The separator of `"$*"`: the first character of `IFS`, a space when
/// unset, nothing when null.
fn ifs_sep(ifs: Option<&[u8]>) -> &[u8] {
	match ifs {
		None => b" ",
		Some(s) => {
			let (_, n) = bstr::decode_utf8(s);
			&s[..n.max(1).min(s.len())]
		},
	}
}

/// bash's quoting marker for the next byte (`CTLESC`).
const CTLESC: u8 = 0x01;
/// bash's quoted-null marker (`CTLNUL`).
const CTLNUL: u8 = 0x7f;

/// Whether `c` is special in a POSIX ERE (bash's `ere_char`).
const fn is_ere_char(c: u8) -> bool {
	matches!(c, b'.' | b'[' | b'\\' | b'(' | b')' | b'*' | b'+' | b'?' | b'{' | b'|' | b'^' | b'$')
}

/// The regex text of a `CTLESC`-marked `=~` operand: a port of bash's
/// `quote_string_for_globbing` with `QGLOB_REGEXP | QGLOB_CTLESC`. Marked
/// ERE specials get a backslash, other marked bytes pass through, and
/// inside an unquoted bracket expression marked bytes lose their marker.
fn ere_quote(marked: &[u8]) -> Vec<u8> {
	let at = |idx: usize| marked.get(idx).copied();
	let mut out = Vec::with_capacity(marked.len() * 2);
	let (mut cclass, mut equiv, mut collsym) = (false, false, false);
	let mut i = 0;
	while i < marked.len() {
		let c = marked[i];
		if c == CTLESC {
			let Some(next) = at(i + 1) else {
				out.push(c);
				break;
			};
			if is_ere_char(next) {
				out.push(b'\\');
			}
			out.push(next);
			i += 2;
			continue;
		}
		if c != b'[' || (i > 0 && marked[i - 1] == CTLESC) {
			out.push(c);
			i += 1;
			continue;
		}
		// A bracket expression: copied with its markers dropped, or, when
		// it does not close, the `[` is literal text and scanning resumes
		// after it.
		out.push(b'[');
		let saved = out.len();
		let mut j = i + 1;
		let mut ch = at(j);
		j += 1;
		if ch == Some(b'^') {
			out.push(b'^');
			ch = at(j);
			j += 1;
		}
		if ch == Some(b']') {
			out.push(b']');
			ch = at(j);
			j += 1;
		}
		let closed = loop {
			let Some(c) = ch else {
				return out;
			};
			let next = at(j);
			match c {
				CTLESC => {
					let Some(byte) = next else {
						return out;
					};
					out.push(byte);
					j += 1;
				},
				b'[' if next == Some(b':') => {
					out.extend_from_slice(b"[:");
					j += 1;
					cclass = true;
				},
				b':' if cclass && next == Some(b']') => {
					out.extend_from_slice(b":]");
					j += 1;
					cclass = false;
				},
				b'[' if matches!(next, Some(b'=' | b'.')) => {
					out.push(b'[');
					out.push(marked[j]);
					j += 1;
					if at(j) == Some(b']') {
						out.push(b']');
						j += 1;
					}
					if next == Some(b'=') {
						equiv = true;
					} else {
						collsym = true;
					}
				},
				b'=' if equiv && next == Some(b']') => {
					out.extend_from_slice(b"=]");
					j += 1;
					equiv = false;
				},
				b'.' if collsym && next == Some(b']') => {
					out.extend_from_slice(b".]");
					j += 1;
					collsym = false;
				},
				_ => out.push(c),
			}
			ch = at(j);
			j += 1;
			match ch {
				Some(b']') => break true,
				None => break false,
				Some(_) => {},
			}
		};
		if closed {
			out.push(b']');
			i = j;
		} else {
			out.truncate(saved);
			i += 1;
		}
	}
	out
}

fn join(items: &[BString], sep: &[u8]) -> Vec<u8> {
	let mut out = Vec::new();
	for (i, it) in items.iter().enumerate() {
		if i > 0 {
			out.extend_from_slice(sep);
		}
		out.extend_from_slice(it);
	}
	out
}

/// Field accumulator.
struct Fields<'o> {
	cur:      Vec<u8>,
	/// The current field exists (has content or a quoted part).
	have:     bool,
	out:      &'o mut Vec<BString>,
	/// `IFS`; `None` = unset (default).
	ifs:      Option<Ifs>,
	/// Pathname expansion: where fields with active glob characters are
	/// recorded as `(index in out, escaped pattern)`; `None` = no globbing.
	globs:    Option<GlobSink<'o>>,
	/// Split per UTF-8 character (a UTF-8 locale and a non-ASCII `IFS`).
	utf8:     bool,
	/// Unquoted `$@` keeps one field per element, like `"$@"` (the inner
	/// pass of [`Expander::rejoin`]).
	whole_at: bool,
	/// Spare buffers for the next field ([`Expander::pool`]).
	pool:     Vec<BString>,
}

/// The pattern side of a field while pathname expansion is on.
struct GlobSink<'o> {
	/// The field as a pattern (quoted bytes escaped).
	pat:     Vec<u8>,
	extglob: bool,
	out:     &'o mut Vec<(u32, BString)>,
}

impl Fields<'_> {
	/// Unquoted bytes: glob characters stay active.
	fn push_raw(&mut self, b: &[u8]) {
		self.cur.extend_from_slice(b);
		if let Some(g) = &mut self.globs {
			g.pat.extend_from_slice(b);
		}
	}

	/// Quoted bytes: literal in the pattern.
	fn push_quoted(&mut self, b: &[u8]) {
		self.cur.extend_from_slice(b);
		if let Some(g) = &mut self.globs {
			quote::glob_escape(b, &mut g.pat);
		}
	}

	fn end(&mut self) {
		let next = spare(&mut self.pool);
		self
			.out
			.push(BString::from(std::mem::replace(&mut self.cur, next)));
		self.have = false;
		if let Some(g) = &mut self.globs {
			// Quoted bytes are escaped in the pattern, so only active glob
			// characters count.
			let pat = std::mem::take(&mut g.pat);
			if super::glob::has_meta(&pat, g.extglob) {
				g.out.push((self.out.len() as u32 - 1, BString::from(pat)));
			}
		}
	}

	/// A list value (`$@`, `$*`, `${a[@]}`, `${a[*]}`): `"$@"` keeps one
	/// field per element, `"$*"` joins with the `IFS` separator. Unquoted,
	/// the elements join with the separator and the result is split; with
	/// a null `IFS` every non-empty element is a field.
	fn list(&mut self, items: &[BString], quoted: bool, star: bool) {
		if quoted && star {
			let joined = join(items, ifs_sep(self.ifs.as_deref()));
			self.push_quoted(&joined);
			self.have = true;
		} else if quoted || (self.whole_at && !star) {
			for (i, it) in items.iter().enumerate() {
				if i > 0 {
					self.end();
				}
				self.push_quoted(it);
				self.have = true;
			}
		} else if self.ifs.as_ref().is_some_and(|s| s.is_empty()) {
			for (i, it) in items.iter().enumerate() {
				if i > 0 && self.have {
					self.end();
				}
				if !it.is_empty() {
					self.push_raw(it);
					self.have = true;
				}
			}
		} else {
			let joined = join(items, ifs_sep(self.ifs.as_deref()));
			self.split(&joined);
		}
	}

	/// bash word splitting of an unquoted expansion: runs of IFS whitespace
	/// delimit (and vanish at the ends), every other IFS byte ends a field,
	/// absorbing adjacent IFS whitespace.
	fn split(&mut self, value: &[u8]) {
		let ifs = self.ifs.take();
		self.split_with(ifs.as_deref().unwrap_or(DEFAULT_IFS), value);
		self.ifs = ifs;
	}

	fn split_with(&mut self, ifs: &[u8], value: &[u8]) {
		if ifs.is_empty() {
			self.push_raw(value);
			self.have |= !value.is_empty();
			return;
		}
		let is_ws = |c: &[u8]| matches!(c, b" " | b"\t" | b"\n") && ifs.contains(&c[0]);
		let wide = self.utf8;
		// Whitespace ended the current field; the next text starts a new one.
		let mut pending = false;
		let mut i = 0;
		while i < value.len() {
			let n = if wide {
				bstr::decode_utf8(&value[i..]).1.max(1)
			} else {
				1
			};
			let c = &value[i..i + n];
			i += n;
			if is_ws(c) {
				if self.have {
					pending = true;
				}
			} else if ifs_has(ifs, c, wide) {
				self.end();
				pending = false;
			} else {
				if pending {
					self.end();
					pending = false;
				}
				self.push_raw(c);
				self.have = true;
			}
		}
		if pending {
			self.end();
		}
	}
}

/// Evaluate already-expanded arithmetic text (`let`, `declare -i`
/// values, array subscripts set by builtins).
pub fn arith_value(
	k: &mut Kernel,
	cx: &mut Cx<'_>,
	vp: &mut Vproc,
	text: &[u8],
) -> Result<i64, Diag> {
	let mut env = Vars { k, cx, vp, prefix: None, expanded: false };
	arith::eval(text, &mut env).map_err(Diag::from)
}

/// Expand the subscript text a builtin was given (`unset 'a[$k]'` with
/// `assoc_expand_once` off) the way bash's `expand_subscript_string` does:
/// one unquoted word, no splitting, globbing or tilde expansion, quotes
/// removed — the key of an associative array (`assoc`). An indexed
/// subscript is arithmetic text instead (bash `array_expand_index`:
/// double-quote rules, `unset "b['1']"` is a syntax error); evaluate the
/// result with [`arith_value`].
///
/// `log` is the builtin's replay log and `cursor` the position in it for
/// this call (several calls in one builtin run share the log; start each
/// run at 0). A command substitution returns [`Stop::Sub`]: the caller
/// starts it, parks, and re-runs the builtin, whose calls then replay the
/// logged atoms and the finished output in order.
pub fn expand_subscript(
	k: &mut Kernel,
	cx: &mut Cx<'_>,
	vp: &mut Vproc,
	line: u32,
	log: &mut Vec<Atom>,
	cursor: &mut usize,
	text: &[u8],
	assoc: bool,
) -> Result<BString, Stop> {
	if !text
		.iter()
		.any(|c| matches!(c, b'$' | b'`' | b'\\' | b'"' | b'\''))
	{
		return Ok(BString::from(text));
	}
	let mut ex = Expander::new(k, cx, vp, log, true, line);
	ex.cursor = *cursor;
	let res = if assoc {
		ex.expand_arith_text(&subscript_as_arith_text(text))
	} else {
		ex.expand_text(text).map(|t| BString::from(t.into_owned()))
	};
	*cursor = ex.cursor;
	res
}

/// The elements of a compound array value a declaration builtin got as a
/// string (`declare -a d='($a)'`; `text` is the inside of the
/// parentheses), parsed as a written list and expanded the way bash's
/// `expand_compound_array_assignment` does: a keyed element to one key
/// and value, an unkeyed word split into fields; for an associative
/// array (`assoc`) whose list starts without `[key]=`, each word expanded
/// once and left unkeyed for the builtin to pair (bash defers to
/// `assign_assoc_from_kvlist`).
///
/// `log`/`cursor` replay command substitutions as in
/// [`expand_subscript`]: [`Stop::Sub`] parks the builtin, which re-runs.
/// Pathname expansion of the words is not supported (the builtin cannot
/// wait for the file system): a word that would need it fails loudly.
pub fn compound_string(
	k: &mut Kernel,
	cx: &mut Cx<'_>,
	vp: &mut Vproc,
	line: u32,
	log: &mut Vec<Atom>,
	cursor: &mut usize,
	text: &[u8],
	assoc: bool,
) -> Result<Vec<CompoundElem>, Stop> {
	let mode = super::exec::mode_of(vp);
	let unit = k
		.engine
		.text_unit(text, super::TextKind::Compound, mode)
		.map_err(|e| Stop::Fail(Diag::Syntax { msg: e.msg }))?;
	let Some(Part::Compound(elems)) = unit.words.last().and_then(|w| w.parts.first()) else {
		return Ok(Vec::new());
	};
	let mut out = Vec::with_capacity(elems.len());
	let mut globs = Vec::new();
	let mut ex = Expander::new(k, cx, vp, log, true, line);
	ex.cursor = *cursor;
	let res = if assoc && elems.first().is_some_and(|e| e.key.is_none()) {
		ex.kvpair(&unit, elems, true, &mut out)
	} else {
		ex.compound(&unit, elems, &mut out, Some(&mut globs))
	};
	*cursor = ex.cursor;
	res?;
	if !globs.is_empty() {
		return Err(Stop::Fail(Diag::Unsupported {
			what: "pathname expansion in a compound array value given as a string".into(),
		}));
	}
	Ok(out)
}

/// `let`'s evaluation: with `assoc_expand_once` (`expanded`) bash treats
/// the words as expanded already and keeps subscript quotes (`let
/// 'a[""]=1'` is a syntax error).
pub fn arith_let(
	k: &mut Kernel,
	cx: &mut Cx<'_>,
	vp: &mut Vproc,
	text: &[u8],
	expanded: bool,
) -> Result<i64, Diag> {
	let mut env = Vars { k, cx, vp, prefix: None, expanded };
	arith::eval(text, &mut env).map_err(Diag::from)
}

/// Variable access for arithmetic.
struct Vars<'v, 'c> {
	k:        &'v mut Kernel,
	cx:       &'v mut Cx<'c>,
	vp:       &'v mut Vproc,
	/// Prefix of warnings (`((`), see [`Expander::arith_cmd`].
	prefix:   Option<&'static str>,
	/// The text is expanded already (`let` with `assoc_expand_once`).
	expanded: bool,
}

impl arith::Env for Vars<'_, '_> {
	fn expanded(&self) -> bool {
		self.expanded
	}

	/// bash `array_expand_index`: an indexed subscript met while evaluating
	/// (`e='a[$k]'; (( $e ))`) is expanded once as arithmetic text. The
	/// evaluator cannot park, so a command substitution there is
	/// unsupported.
	fn expand_index(&mut self, text: &[u8]) -> Result<BString, arith::Error> {
		let line = super::exec::current_line(self.vp);
		let mut log = Vec::new();
		let mut ex = Expander::new(self.k, self.cx, self.vp, &mut log, false, line);
		ex.arith_cmd = self.prefix;
		let diag = match ex.expand_text(text) {
			Ok(v) => return Ok(BString::from(v.into_owned())),
			Err(Stop::Fail(Diag::Unbound { name }) | Stop::Fatal(Diag::Unbound { name })) => {
				return Err(arith::Error::Unbound { name });
			},
			Err(Stop::Fail(d) | Stop::Fatal(d)) => d,
			Err(Stop::Store(_)) => Diag::StoreFailed,
			Err(Stop::Sub { .. } | Stop::ZshSub { .. }) => Diag::Unsupported {
				what: "command substitution in a subscript met during arithmetic evaluation".into(),
			},
			Err(Stop::Probe(_)) => Diag::Unsupported {
				what: "`=cmd` in a subscript met during arithmetic evaluation".into(),
			},
			Err(Stop::Wait(_)) => unreachable!("an expansion without a replay log never waits"),
		};
		Err(arith::Error::Expand { diag: Box::new(diag) })
	}

	/// bash `expand_subscript_string` of an associative key met while
	/// evaluating; a command substitution in it is unsupported (the
	/// evaluator cannot park).
	fn expand_key(&mut self, key: &[u8]) -> Result<BString, arith::Error> {
		if !key
			.iter()
			.any(|c| matches!(c, b'$' | b'`' | b'\\' | b'"' | b'\''))
		{
			return Ok(BString::from(key));
		}
		let line = super::exec::current_line(self.vp);
		let mut log = Vec::new();
		let mut ex = Expander::new(self.k, self.cx, self.vp, &mut log, false, line);
		let diag = match ex.expand_arith_text(&subscript_as_arith_text(key)) {
			Ok(v) => return Ok(v),
			Err(Stop::Fail(Diag::Unbound { name }) | Stop::Fatal(Diag::Unbound { name })) => {
				return Err(arith::Error::Unbound { name });
			},
			Err(Stop::Fail(d) | Stop::Fatal(d)) => d,
			Err(Stop::Store(_)) => Diag::StoreFailed,
			Err(Stop::Sub { .. } | Stop::ZshSub { .. }) => Diag::Unsupported {
				what: "command substitution in a subscript met during arithmetic evaluation".into(),
			},
			Err(Stop::Probe(_)) => Diag::Unsupported {
				what: "`=cmd` in a subscript met during arithmetic evaluation".into(),
			},
			Err(Stop::Wait(_)) => unreachable!("an expansion without a replay log never waits"),
		};
		Err(arith::Error::Expand { diag: Box::new(diag) })
	}

	fn warn(&mut self, diag: Diag) {
		let diag = match self.prefix {
			Some(cmd) => diag.by(cmd),
			None => diag,
		};
		let line = super::exec::current_line(self.vp);
		self.k.diag(self.cx, self.vp, line, diag);
	}

	fn get(
		&mut self,
		name: &[u8],
		index: Option<&[u8]>,
	) -> Result<Option<arith::Value>, arith::Error> {
		// `$((RANDOM))`, `$((LINENO))`: dynamic variables are computed here
		// too.
		if is_dynamic(name) {
			let line = super::exec::current_line(self.vp);
			if let Ok(Some(v)) = dynamic_value(self.k, self.cx, self.vp, line, name) {
				let text = match v {
					DynVal::Str(s) => index.is_none_or(|i| i == b"0").then_some(s),
					DynVal::List(items) => {
						let i: usize = index
							.and_then(|i| std::str::from_utf8(i).ok()?.parse().ok())
							.unwrap_or(0);
						items.into_iter().nth(i)
					},
					DynVal::Assoc(pairs) => {
						let key = index.unwrap_or(b"0");
						pairs
							.into_iter()
							.find(|(k, _)| k.as_slice() == key)
							.map(|(_, v)| v)
					},
				};
				return Ok(text.map(|t| arith::Value::of(&t)));
			}
		}
		// One walk for a variable that is no name reference (the common
		// case); a reference is followed, also to an array element.
		let declared = state::lookup_declared(&self.k.root, self.cx.store, self.vp, name)
			.ok()
			.flatten();
		let target = if declared.is_some_and(|v| v.attrs.contains(Attrs::NAMEREF)) {
			state::deref(&self.k.root, self.cx.store, self.vp, name).unwrap_or(state::Deref::Plain)
		} else {
			let value = declared
				.filter(|v| !v.attrs.contains(Attrs::INVISIBLE))
				.and_then(|v| arith_element(v, index))
				.map(arith::Value::of);
			return self.unbound_checked(name, value);
		};
		let (name, index) = deref_target(&target, name, index);
		let var = state::lookup(&self.k.root, self.cx.store, self.vp, name)
			.ok()
			.flatten();
		let value = var
			.and_then(|v| arith_element(v, index))
			.map(arith::Value::of);
		self.unbound_checked(name, value)
	}

	fn set(&mut self, name: &[u8], index: Option<&[u8]>, value: i64) -> Result<(), arith::Error> {
		let target =
			state::deref(&self.k.root, self.cx.store, self.vp, name).unwrap_or(state::Deref::Plain);
		let (name, index) = deref_target(&target, name, index);
		let mut buf = NumBuffer::new();
		let text = value.format_into(&mut buf).as_bytes();
		let cur = state::lookup_declared(&self.k.root, self.cx.store, self.vp, name)
			.ok()
			.flatten();
		if cur.is_some_and(|v| v.attrs.contains(Attrs::READONLY)) {
			return Err(arith::Error::Readonly { name: BString::from(name) });
		}
		// An unset name reference would take the number as its target
		// name, which is no identifier: bash reports it and assigns
		// nothing (`declare -n r; ((r=0))`).
		if index.is_none()
			&& cur
				.is_some_and(|v| v.attrs.contains(Attrs::NAMEREF) && v.attrs.contains(Attrs::INVISIBLE))
		{
			arith::Env::warn(self, Diag::InvalidIdent { name: BString::from(text) });
			return Ok(());
		}
		// In place where the variable is bound (`edit_var` at the dynamic
		// level is where `lookup_declared` found it): the store gets the
		// element or value, not a copy of the variable (an array element
		// assignment copied the whole array), and no new name key. Nothing
		// ran since the read, so the edit relies on what it showed.
		let seen = cur.and_then(state::Seen::of);
		if let Some(assoc) = cur.map(|v| matches!(v.value, VarValue::Assoc(_))) {
			let elem = index.map(|i| {
				if assoc {
					Elem::Key(BStr::new(i))
				} else {
					Elem::Index(
						std::str::from_utf8(i)
							.ok()
							.and_then(|s| s.parse().ok())
							.unwrap_or(0),
					)
				}
			});
			let edit = VarEdit::Number { elem, value: text };
			if matches!(
				state::edit_seen(
					&mut self.k.root,
					self.cx.store,
					self.vp,
					name,
					Level::Dynamic,
					edit,
					seen
				),
				Ok(true)
			) {
				return Ok(());
			}
		}
		let mut var = Var::scalar("", Attrs::NONE);
		assign_number(&mut var, index, text);
		state::store_var(&mut self.k.root, self.cx.store, self.vp, name, Some(var), Level::Dynamic);
		Ok(())
	}

	fn cache(&self) -> &arith::Cache {
		self.k.engine.arith()
	}

	fn is_assoc(&mut self, name: &[u8]) -> bool {
		state::lookup_declared(&self.k.root, self.cx.store, self.vp, name)
			.ok()
			.flatten()
			.is_some_and(|v| matches!(v.value, VarValue::Assoc(_)) || v.attrs.contains(Attrs::ASSOC))
	}
}

/// Whether a function scope of `vp` binds `name` (a local of some
/// function on the call stack).
fn func_binds(
	root: &state::Root,
	store: &mut dyn crate::bash::store::StateStore,
	vp: &Vproc,
	name: &[u8],
) -> Result<bool, StoreError> {
	for i in 0..state::scope_count(root, vp) {
		if state::scope_func(store, vp, i)?.is_some() && state::scope_binds(store, vp, i, name)? {
			return Ok(true);
		}
	}
	Ok(false)
}

/// The text of `v` (element `index`) arithmetic evaluates.
fn arith_element<'v>(v: &'v Var, index: Option<&[u8]>) -> Option<&'v [u8]> {
	match index {
		None => v.as_scalar(),
		Some(i) => {
			if let VarValue::Assoc(_) = &v.value {
				v.key(i)
			} else {
				let n: i64 = std::str::from_utf8(i)
					.ok()
					.and_then(|s| s.parse().ok())
					.unwrap_or(0);
				v.index(n)
			}
		},
	}
}

/// Store the number `text` arithmetic assigned in `var` (element `index`),
/// reusing a scalar's buffer.
fn assign_number(var: &mut Var, index: Option<&[u8]>, text: &[u8]) {
	match index {
		None => match &mut var.value {
			VarValue::Str(s) => {
				s.clear();
				s.extend_from_slice(text);
			},
			_ => var.set_index(0, BString::from(text)),
		},
		Some(i) => {
			if let VarValue::Assoc(_) = &var.value {
				var.set_key(BString::from(i), BString::from(text));
			} else {
				let n: i64 = std::str::from_utf8(i)
					.ok()
					.and_then(|s| s.parse().ok())
					.unwrap_or(0);
				var.set_index(n, BString::from(text));
			}
		},
	}
	var.attrs = var.attrs.without(Attrs::INVISIBLE);
}

impl Vars<'_, '_> {
	/// `value` as [`arith::Env::get`] returns it: an unset one is an error
	/// under `set -u`, naming `name` (bash names the array for an unset
	/// element).
	fn unbound_checked(
		&mut self,
		name: &[u8],
		value: Option<arith::Value>,
	) -> Result<Option<arith::Value>, arith::Error> {
		if value.is_none()
			&& state::option(&mut self.k.root, self.cx.store, self.vp, OptId::Nounset).unwrap_or(false)
		{
			// bash names the array for an unset element.
			return Err(arith::Error::Unbound { name: BString::from(name) });
		}
		Ok(value)
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn split(value: &str, ifs: &str, prefix: &str) -> Vec<String> {
		let mut out = Vec::new();
		let mut f = Fields {
			cur:      prefix.as_bytes().to_vec(),
			have:     !prefix.is_empty(),
			out:      &mut out,
			ifs:      Some(Ifs::new(ifs.as_bytes())),
			globs:    None,
			whole_at: false,
			utf8:     false,
			pool:     Vec::new(),
		};
		f.split(value.as_bytes());
		if f.have {
			f.end();
		}
		out.into_iter().map(|b| b.to_string()).collect()
	}

	// Expected values: bash 5.3 `set -- $x; printf '<%s>' "$@"`.
	#[test]
	fn whitespace_runs_delimit_and_vanish_at_the_ends() {
		assert_eq!(split("  a  b ", " \t\n", ""), ["a", "b"]);
		assert_eq!(split("", " \t\n", ""), Vec::<String>::new());
	}

	#[test]
	fn non_whitespace_ifs_bytes_delimit_empty_fields() {
		assert_eq!(split("a::b", ":", ""), ["a", "", "b"]);
		assert_eq!(split(":a", ":", ""), ["", "a"]);
		assert_eq!(split("a:", ":", ""), ["a"]);
		assert_eq!(split("a : b", " :", ""), ["a", "b"]);
	}

	#[test]
	fn leading_whitespace_ends_a_prefix_field() {
		assert_eq!(split(" a", " ", "pre"), ["pre", "a"]);
		assert_eq!(split("a", " ", "pre"), ["prea"]);
	}

	#[test]
	fn empty_ifs_disables_splitting() {
		assert_eq!(split("a b", "", ""), ["a b"]);
	}

	// Golden: upstream intl3.sub (`IFS=$'\254'; t=+$'\342\202\254'+; set --
	// $t; echo $#` is 1 in a UTF-8 locale).
	#[test]
	fn utf8_splitting_compares_whole_characters() {
		let mut out = Vec::new();
		let mut f = Fields {
			cur:      Vec::new(),
			have:     false,
			out:      &mut out,
			ifs:      Some(Ifs::new(b"\xac")),
			globs:    None,
			whole_at: false,
			utf8:     true,
			pool:     Vec::new(),
		};
		f.split("+\u{20ac}+".as_bytes());
		if f.have {
			f.end();
		}
		assert_eq!(out, [BString::from("+\u{20ac}+")]);
		assert!(ifs_has(b"\xac", b"\xac", true));
	}

	fn pat(s: &str) -> Pattern {
		Pattern::compile(s.as_bytes(), PatOpts::default())
	}

	// Goldens: bash 5.3.20.
	#[test]
	fn trim_shortest_and_longest() {
		assert_eq!(trim(b"./a/b.tests", &pat("*/"), false, true), "b.tests");
		assert_eq!(trim(b"a.b.c", &pat("*."), false, false), "b.c");
		assert_eq!(trim(b"a.b.c", &pat(".*"), true, false), "a.b");
		assert_eq!(trim(b"a.b.c", &pat(".*"), true, true), "a");
		assert_eq!(trim(b"no\tOK", &pat("no\t"), false, false), "OK");
	}

	#[test]
	fn replace_first_all_and_anchors_with_ampersand() {
		assert_eq!(replace(b"aXbXc", &pat("X"), false, ReplaceIr::First, Some(b"-")), "a-bXc");
		assert_eq!(replace(b"aXbXc", &pat("X"), false, ReplaceIr::All, Some(b"<&>")), "a<X>b<X>c");
		assert_eq!(replace(b"abc", &pat("a"), false, ReplaceIr::Prefix, Some(b"z")), "zbc");
		assert_eq!(replace(b"abc", &pat("c"), false, ReplaceIr::Suffix, None), "ab");
		assert_eq!(replace(b"abc", &pat("x"), false, ReplaceIr::All, Some(b"y")), "abc");
		// bash `strcreplace`: `\&` and `\\` are literal, other `\x` stay.
		assert_eq!(
			replace(b"abc", &pat("b"), false, ReplaceIr::All, Some(b"\\&\\\\&\\x")),
			"a&\\b\\xc"
		);
		// `var=; ${var//*/x}` is `x`.
		assert_eq!(replace(b"", &pat("*"), false, ReplaceIr::All, Some(b"x")), "x");
		assert_eq!(replace(b"", &pat("?"), false, ReplaceIr::All, Some(b"x")), "");
	}

	#[test]
	fn substring_bounds() {
		assert_eq!(slice_bounds(5, 1, Some(2)), Some((1, 3)));
		assert_eq!(slice_bounds(5, -2, None), Some((3, 5)));
		assert_eq!(slice_bounds(5, 1, Some(-1)), Some((1, 4)));
		assert_eq!(slice_bounds(5, 9, None), None);
	}

	/// The regex text of an `=~` operand made of `(text, quoted)` pieces.
	fn regex_of(pieces: &[(&[u8], bool)]) -> BString {
		let mut sink = Sink::Regex(Vec::new());
		for &(text, quoted) in pieces {
			sink.lit(text, quoted);
		}
		match sink {
			Sink::Regex(marked) => BString::from(ere_quote(&marked)),
			_ => unreachable!(),
		}
	}

	// Expected texts: what bash 5.3's `quote_string_for_globbing` hands
	// regcomp (cond-regexp2/3.sub results follow from them).
	#[test]
	fn regex_operand_quoting() {
		// `$'\\\001'`: a quoted backslash stays literal.
		assert_eq!(regex_of(&[(b"\\\x01", true)]), "\\\\\x01");
		// `r="\\$c"; $r`: an unquoted backslash escapes the next byte.
		assert_eq!(regex_of(&[(b"\\\x01", false)]), "\\\x01");
		// `'[[:alpha:]]'`: quoted brackets are literal; `]` is not special.
		assert_eq!(regex_of(&[(b"[[:alpha:]]", true)]), "\\[\\[:alpha:]]");
		// `[^]"."]`: quoting inside a bracket expression is dropped.
		assert_eq!(regex_of(&[(b"[^]", false), (b".", true), (b"]", false)]), "[^].]");
		// `${bs}[`: an unclosed bracket ends the text.
		assert_eq!(regex_of(&[(b"\\[", false)]), "\\[");
		// `"a\-b"`: non-special quoted bytes pass through.
		assert_eq!(regex_of(&[(b"a\\-b", true)]), "a\\\\-b");
		// `[a` then more: an unclosed bracket is rescanned as text.
		assert_eq!(regex_of(&[(b"[a", false), (b".", true)]), "[a\\.");
	}
}
