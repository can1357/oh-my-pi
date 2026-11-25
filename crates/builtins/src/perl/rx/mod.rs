//! Runtime regex quote-like operators (`perlop`), captures (`perlvar`), and regex builtins (`perlfunc`).

mod actions;
mod captures;
pub(in crate::perl) mod linebreak;
mod linebreak_data;
mod props;
mod split;
pub(in crate::perl) mod ucd;
mod ucd_data;

use std::{collections::HashMap, rc::{Rc, Weak}};

use rustc_hash::FxBuildHasher;

use super::{
	ast::{Binary, Builtin, Call, Expr, ExprKind, QuotePart, RegexExpr, RegexKind, Select, Sigil},
	interp::{Cx, Flow, Interp, InterpMode, Lvalue, PResult, Ret, new_lvalue},
	regex::{Captures, Charset, ExecOpts, PropSet, Regex, RxFlags},
	translit::{TrFlags, Translit},
	value::{PStr, Ref, ScalarBody, Sv, Value, new_rx, new_sv},
};

pub(in crate::perl) use captures::{MatchState, match_array, match_hash, match_hv, match_var, named_count};

/// Regex operator state belonging to a single interpreter, not the calling thread.
#[derive(Default)]
pub(in crate::perl) struct Runtime {
	patterns: HashMap<usize, Rc<Regex>, FxBuildHasher>,
	translations: HashMap<usize, Rc<Translit>, FxBuildHasher>,
	once: HashMap<usize, Rc<str>, FxBuildHasher>,
	action_depth: usize,
	/// This interpreter's cancellation flag, installed for regex checkpoints.
	cancel: CancelFlag,
	snapshot: Option<SubjectSnapshot>,
	match_cells: HashMap<String, Sv, FxBuildHasher>,
	empty_positions: HashMap<usize, Weak<ScalarBody>, FxBuildHasher>,
	position_sweep: usize,
	/// Recently validated large UTF-8 subjects. A `Weak` keeps the allocation's
	/// address unique without keeping the string alive.
	checked_utf8: Vec<(Weak<PStr>, bool)>,
	/// User-defined property definitions by (qualified sub name, caseless).
	user_properties: HashMap<(String, bool), Result<PropSet, String>, FxBuildHasher>,
	/// Patterns recompiled at first match because a user property was not yet
	/// defined when they were compiled, by the original's address.
	deferred: HashMap<usize, (Weak<Regex>, Rc<Regex>), FxBuildHasher>,
	/// Last byte/character offset pair computed for `pos` on a UTF-8 scalar,
	/// so `while (/./g) { pos }` walks the string once, not once per match.
	offsets: Option<OffsetMark>,
	/// `%+`/`%-` containers for the current last match (see `match_hv`).
	match_hashes: Vec<(String, Weak<MatchState>, crate::perl::value::Hv)>,
}

struct OffsetMark {
	cell: Weak<ScalarBody>,
	revision: u64,
	byte: usize,
	chars: usize,
}

/// The host cancellation flag regex checkpoints poll while this interpreter
/// runs (`regex::install_cancel_flag`); uninstalled when the interpreter goes.
#[derive(Default)]
struct CancelFlag(Option<std::sync::Arc<std::sync::atomic::AtomicBool>>);

impl Drop for CancelFlag {
	fn drop(&mut self) {
		if let Some(flag) = &self.0 { super::regex::remove_cancel_flag(flag); }
	}
}

/// Let regex checkpoints observe this interpreter's cancellation. Called
/// before every compile and search, so a nested interpreter on the same
/// thread cannot leave its own flag installed.
fn install_cancel(interp: &mut Interp<'_>) {
	if interp.rx.cancel.0.is_none() { interp.rx.cancel.0 = Some(interp.host().cancel_flag()); }
	if let Some(flag) = &interp.rx.cancel.0 { super::regex::install_cancel_flag(flag); }
}

/// A search error as a Perl failure: a cancelled search stops the program.
fn search_error(interp: &mut Interp<'_>, message: String) -> Flow {
	if message == super::regex::CANCELLED { Flow::Cancelled } else { interp.die_msg(message) }
}

struct SubjectSnapshot {
	cell: Weak<ScalarBody>,
	revision: u64,
	bytes: bool,
	source: Rc<PStr>,
}

#[derive(Clone, Copy, Default)]
struct Position {
	at: usize,
	empty: bool,
}

impl Runtime {
	fn position(&self, cell: &Sv) -> Position {
		let Some(at) = cell.pos.get() else { return Position::default(); };
		Position { at, empty: self.empty_positions.contains_key(&(Rc::as_ptr(cell) as usize)) }
	}

	fn set_position(&mut self, cell: &Sv, pos: Option<Position>) {
		cell.pos.set(pos.map(|p| p.at));
		let key = Rc::as_ptr(cell) as usize;
		if pos.is_some_and(|p| p.empty) {
			self.empty_positions.entry(key).or_insert_with(|| Rc::downgrade(cell));
			if self.empty_positions.len() >= self.position_sweep {
				self.empty_positions.retain(|_, weak| weak.upgrade().is_some_and(|sv| sv.pos.get().is_some()));
				self.position_sweep = self.empty_positions.len().saturating_mul(2).max(32);
			}
		} else if !self.empty_positions.is_empty() {
			self.empty_positions.remove(&key);
		}
	}

	/// Convert between byte and character offsets in a UTF-8 scalar's string,
	/// resuming from the last conversion on the same unchanged scalar.
	/// `to_bytes` selects character → byte; the result is (byte, chars).
	fn offset(&mut self, cell: &Sv, s: &PStr, target: usize, to_bytes: bool) -> (usize, usize) {
		let revision = cell.revision();
		let (mut byte, mut chars) = match &self.offsets {
			Some(mark) if mark.cell.as_ptr() == Rc::as_ptr(cell) && mark.revision == revision
				&& (if to_bytes { mark.chars } else { mark.byte }) <= target => (mark.byte, mark.chars),
			_ => (0, 0),
		};
		let bytes = &s.bytes;
		let walk = |byte: &mut usize, chars: &mut usize| {
			// Step over one character: its lead byte, then continuation bytes.
			*byte += 1;
			while bytes.get(*byte).is_some_and(|b| b & 0xC0 == 0x80) { *byte += 1; }
			*chars += 1;
		};
		if to_bytes {
			while chars < target && byte < bytes.len() { walk(&mut byte, &mut chars); }
		} else {
			let end = target.min(bytes.len());
			// Malformed text: fall back to the decoder's own definition.
			if std::str::from_utf8(&bytes[byte..end]).is_err() { return (end, s.byte_to_char(end)); }
			while byte < end { walk(&mut byte, &mut chars); }
		}
		self.offsets = Some(OffsetMark { cell: Rc::downgrade(cell), revision, byte, chars });
		(byte, chars)
	}

	/// Whether a UTF-8 subject is well-formed. Repeated searches of one large
	/// subject (`m//g`, `s///g`, `split`) validate it once instead of letting
	/// PCRE2 rescan the rest of the string on every call.
	fn utf8_valid(&mut self, source: &Rc<PStr>) -> bool {
		const CACHED: usize = 4096;
		if !source.utf8 { return false; }
		if source.bytes.len() < CACHED { return std::str::from_utf8(&source.bytes).is_ok(); }
		let ptr = Rc::as_ptr(source);
		if let Some(&(_, valid)) = self.checked_utf8.iter().find(|(seen, _)| seen.as_ptr() == ptr) { return valid; }
		let valid = std::str::from_utf8(&source.bytes).is_ok();
		if self.checked_utf8.len() >= 4 { self.checked_utf8.remove(0); }
		self.checked_utf8.push((Rc::downgrade(source), valid));
		valid
	}
}

#[derive(Clone, Copy)]
enum Operation { Match, Substitution, SubstitutionIterator, Transliteration, Position, Study, Split, Compile, PosAssign, Reset }

impl Operation {
	fn description(self) -> &'static str {
		match self {
			Self::Match => "pattern match (m//)",
			Self::Substitution => "substitution (s///)",
			Self::SubstitutionIterator => "substitution iterator",
			Self::Transliteration => "transliteration (tr///)",
			Self::Position => "match position",
			Self::Study => "study",
			Self::Split => "split",
			Self::Compile => "regexp compilation",
			Self::PosAssign => "scalar assignment",
			Self::Reset => "symbol reset",
		}
	}
}

// Keep a cell, rather than its value, across interpolation. The RHS is allowed
// to modify the very scalar that is about to be searched.
enum Subject {
	Cell(Sv),
	ReadOnly(Sv),
	Temporary(Value),
}

impl Subject {
	fn read(self, interp: &mut Interp<'_>) -> PResult<(Option<Sv>, Value)> {
		Ok(match self {
			Self::Cell(cell) => {
				let value = interp.read_sv(&cell)?;
				(Some(cell), value)
			}
			Self::ReadOnly(cell) => {
				let value = cell.get();
				(Some(cell), value)
			}
			Self::Temporary(value) => (None, value),
		})
	}

	fn snapshot(self, interp: &mut Interp<'_>, lhs: Option<&Expr>) -> PResult<(Option<Sv>, Rc<PStr>)> {
		let bytes = interp.hints().bytes;
		if let Self::Cell(cell) = &self && !interp.is_magical_sv(cell) && let Some(source) = snapshot(interp, cell, bytes) {
			return Ok((Some(cell.clone()), source));
		}
		let (cell, value) = self.read(interp)?;
		let mut source = text(interp, value, lhs, Operation::Match)?;
		source.utf8 &= !bytes;
		Ok((cell, Rc::new(source)))
	}

	fn cell(self) -> Option<Sv> {
		match self { Self::Cell(cell) | Self::ReadOnly(cell) => Some(cell), Self::Temporary(_) => None }
	}
}

fn snapshot(interp: &mut Interp<'_>, cell: &Sv, bytes: bool) -> Option<Rc<PStr>> {
	let revision = cell.revision();
	if let Some(cached) = &interp.rx.snapshot
		&& cached.revision == revision && cached.bytes == bytes && cached.cell.as_ptr() == Rc::as_ptr(cell)
	{
		return Some(cached.source.clone());
	}
	let raw = cell.try_value().ok()?;
	let Value::Str(string) = &*raw else { return None; };
	let mut string = string.clone();
	string.utf8 &= !bytes;
	let source = Rc::new(string);
	interp.rx.snapshot = Some(SubjectSnapshot { cell: Rc::downgrade(cell), revision, bytes, source: source.clone() });
	Some(source)
}

fn ungroup(mut expr: &Expr) -> &Expr {
	while let ExprKind::Group(inner) = &expr.kind { expr = inner; }
	expr
}

fn scalar_place(mut expr: &Expr) -> bool {
	let mut alternatives = Vec::new();
	loop {
		match &ungroup(expr).kind {
			ExprKind::Variable(Sigil::Scalar, _) | ExprKind::Deref(Sigil::Scalar, _) => {},
			ExprKind::Select(base, select, _) if matches!(select, Select::ArrayElement(_) | Select::HashElement(_)) => {
				if matches!(&ungroup(base).kind, ExprKind::Variable(_, name) if matches!(name.as_ref(),
					"+" | "-" | "^CAPTURE" | "^CAPTURE_ALL" | "{^CAPTURE}" | "{^CAPTURE_ALL}"))
				{
					return false;
				}
			}
			ExprKind::Call(Call { target: crate::perl::ast::CallTarget::Builtin(Builtin::Substr | Builtin::Vec | Builtin::Pos, _), .. }) => {},
			ExprKind::Binary(Binary::Assign | Binary::AssignOp(_), lhs, _) | ExprKind::Declare(_, _, lhs, _) => {
				expr = lhs;
				continue;
			}
			ExprKind::Conditional(_, yes, no) => {
				alternatives.push(no.as_ref());
				expr = yes;
				continue;
			}
			_ => return false,
		}
		let Some(alternate) = alternatives.pop() else { return true; };
		expr = alternate;
	}
}

fn constant(expr: &Expr) -> bool {
	matches!(ungroup(expr).kind, ExprKind::Int(_) | ExprKind::UInt(_) | ExprKind::Float(_)
		| ExprKind::String(_) | ExprKind::Version(_) | ExprKind::Special(_))
}

fn subject(interp: &mut Interp<'_>, expr: Option<&Expr>, write: Option<Operation>) -> PResult<Subject> {
	let Some(expr) = expr else {
		let cell = interp.topic();
		return subject_cell(interp, cell, write);
	};
	if let ExprKind::Variable(Sigil::Scalar, name) = &ungroup(expr).kind
		&& captures::is_match_var(name)
	{
		let value = interp.eval_scalar(expr)?;
		let cell = if let Some(cell) = interp.rx.match_cells.get(name.as_ref()) {
			cell.set(value);
			cell.clone()
		} else {
			let cell = new_sv(value);
			interp.rx.match_cells.insert(name.to_string(), cell.clone());
			cell
		};
		return Ok(Subject::ReadOnly(cell));
	}
	if scalar_place(expr) {
		if write.is_none() && matches!(&ungroup(expr).kind, ExprKind::Select(..)) {
			return Ok(interp.eval_match_cell(expr)?.map_or(Subject::Temporary(Value::Undef), Subject::Cell));
		}
		let cell = interp.eval_lvalue(expr)?;
		return subject_cell(interp, cell, write);
	}
	if let Some(op) = write {
		if constant(expr) {
			return Err(interp.die_msg(format!("Can't modify constant item in {}", op.description())));
		}
		match &ungroup(expr).kind {
			ExprKind::Variable(Sigil::Array, _) | ExprKind::Deref(Sigil::Array, _) if matches!(op, Operation::Position | Operation::Substitution | Operation::Transliteration) => {
				return Err(interp.die_msg(format!("Can't modify array dereference in {}", op.description())));
			}
			ExprKind::Variable(Sigil::Hash, _) | ExprKind::Deref(Sigil::Hash, _) if matches!(op, Operation::Position | Operation::Substitution | Operation::Transliteration) => {
				return Err(interp.die_msg(format!("Can't modify hash dereference in {}", op.description())));
			}
			ExprKind::Variable(Sigil::Glob, _) if matches!(op, Operation::Position) => {
				// A glob keeps its own match position, separate from its scalar slot.
				let value = interp.eval_scalar(expr)?;
				let key = format!("*{}", value.to_pstr().to_string_lossy());
				let cell = interp.rx.match_cells.entry(key).or_insert_with(|| new_sv(Value::Undef)).clone();
				cell.set(value);
				return Ok(Subject::Cell(cell));
			}
			_ => {}
		}
		let cell = interp.eval_lvalue(expr)?;
		return subject_cell(interp, cell, write);
	}
	interp.eval_scalar(expr).map(Subject::Temporary)
}

fn subject_cell(interp: &mut Interp<'_>, cell: Sv, write: Option<Operation>) -> PResult<Subject> {
	if matches!(write, Some(Operation::Substitution | Operation::Transliteration)) && interp.is_readonly_sv(&cell) {
		return Err(interp.die_msg("Modification of a read-only value attempted"));
	}
	Ok(Subject::Cell(cell))
}

fn warn_undef(interp: &mut Interp<'_>, expr: Option<&Expr>, operation: Operation) {
	if !interp.warn_on("uninitialized") { return; }
	let name = expr.and_then(|expr| match &ungroup(expr).kind {
		ExprKind::Variable(Sigil::Scalar, name) => Some(name.as_ref()),
		_ => None,
	});
	let topic = matches!(operation, Operation::Match | Operation::Substitution | Operation::Transliteration
		| Operation::PosAssign | Operation::Split | Operation::Study)
		&& expr.is_none();
	let name = name.or(topic.then_some("_"));
	let op = operation.description();
	interp.warn_category("uninitialized", name.map_or_else(|| format!("Use of uninitialized value in {op}"), |name| {
		format!("Use of uninitialized value ${name} in {op}")
	}));
}

fn text(interp: &mut Interp<'_>, value: Value, expr: Option<&Expr>, operation: Operation) -> PResult<PStr> {
	match value {
		Value::Str(s) => Ok(s),
		Value::Undef => { warn_undef(interp, expr, operation); Ok(PStr::default()) }
		value => interp.stringify(&value),
	}
}

fn effective_flags(interp: &mut Interp<'_>, mods: &[u8]) -> PResult<RxFlags> {
	let (explicit, _) = RxFlags::parse(mods).map_err(|msg| interp.die_msg(msg))?;
	let defaults = &interp.hints().re_mods;
	let mut flags = match RxFlags::parse(defaults) {
		Ok((flags, _)) => flags,
		Err(msg) => return Err(interp.die_msg(msg)),
	};
	flags.i |= explicit.i;
	flags.m |= explicit.m;
	flags.s |= explicit.s;
	flags.x |= explicit.x;
	flags.xx |= explicit.xx;
	flags.n |= explicit.n;
	flags.p |= explicit.p;
	let has_charset = |mods: &[u8]| mods.iter().any(|b| matches!(b, b'd' | b'u' | b'a' | b'l'));
	if has_charset(mods) {
		flags.charset = explicit.charset;
	} else if !has_charset(defaults) && !interp.hints().bytes && interp.hints().features.enabled("unicode_strings") {
		flags.charset = Charset::Unicode;
	}
	Ok(flags)
}

fn compile(interp: &mut Interp<'_>, site: usize, source: &PStr, flags: RxFlags) -> PResult<Rc<Regex>> {
	if let Some(regex) = interp.rx.patterns.get(&site) {
		let old = regex.source();
		if regex.actions().is_empty() && regex.flags() == flags && source.utf8 == old.utf8 && source.bytes == old.bytes {
			return Ok(regex.clone());
		}
	}
	let regex = Rc::new(actions::compile(interp, source, flags, Vec::new())?);
	if regex.actions().is_empty() { interp.rx.patterns.insert(site, regex.clone()); }
	Ok(regex)
}

fn regex_expr(interp: &mut Interp<'_>, re: &RegexExpr) -> PResult<Rc<Regex>> {
	let site = re as *const RegexExpr as usize;
	if let Some(compiled) = interp.rx.patterns.get(&site)
		&& (re.modifiers.contains(&b'o') || re.pattern.iter().all(|part| matches!(part, QuotePart::Literal(_) | QuotePart::Case(_))))
	{
		return Ok(compiled.clone());
	}
	// A pattern that is exactly one interpolated qr// object, with no
	// modifiers of its own, uses that compiled regex as is (perlop).
	if let [QuotePart::Expr(expr, false)] = re.pattern.as_slice()
		&& re.modifiers.iter().all(|m| matches!(m, b'g' | b'c' | b'o'))
	{
		let value = interp.eval_scalar(expr)?;
		let source = match coerce_regexp(interp, &value)? {
			Some(regex) if !regex.is_empty_pattern() => {
				if re.modifiers.contains(&b'o') { interp.rx.patterns.insert(site, regex.clone()); }
				return Ok(regex);
			}
			Some(regex) => regex.stringify(),
			None => text(interp, value, Some(expr), Operation::Compile)?,
		};
		let flags = effective_flags(interp, &re.modifiers)?;
		if !re.modifiers.contains(&b'o') { return compile(interp, site, &source, flags); }
		let regex = Rc::new(actions::compile(interp, &source, flags, Vec::new())?);
		interp.rx.patterns.insert(site, regex.clone());
		return Ok(regex);
	}
	let (source, embedded) = actions::interpolate(interp, &re.pattern)?;
	let flags = effective_flags(interp, &re.modifiers)?;
	if embedded.is_empty() && !re.modifiers.contains(&b'o') { return compile(interp, site, &source, flags); }
	let regex = Rc::new(actions::compile(interp, &source, flags, embedded)?);
	if re.modifiers.contains(&b'o') { interp.rx.patterns.insert(site, regex.clone()); }
	Ok(regex)
}

fn reuse_empty(interp: &Interp<'_>, regex: Rc<Regex>) -> Rc<Regex> {
	if regex.is_empty_pattern() {
		if let Some(previous) = interp.last_match() { return previous.regex.clone(); }
	}
	regex
}

/// Interpret a regex quote-like operator (`m//`, `qr//`, `s///`, `tr///`, or `y///`).
pub(in crate::perl) fn eval_regex(interp: &mut Interp<'_>, re: &RegexExpr, lhs: Option<&Expr>, negate: bool, cx: Cx) -> PResult<Ret> {
	let copy = re.modifiers.contains(&b'r');
	let global = re.modifiers.contains(&b'g');
	let keep_pos = re.modifiers.contains(&b'c');
	match &re.kind {
		RegexKind::Transliterate(spec) => {
			if copy && negate { return Err(interp.die_msg("Using !~ with tr///r doesn't make sense")); }
			let site = re as *const RegexExpr as usize;
			let tr = if let Some(tr) = interp.rx.translations.get(&site) { tr.clone() } else {
				let flags = TrFlags {
					c: keep_pos, d: re.modifiers.contains(&b'd'), s: re.modifiers.contains(&b's'),
					literal_search: spec.literal_search, literal_replace: spec.literal_replacement,
				};
				let tr = Rc::new(Translit::new(&spec.search, &spec.replacement, flags).map_err(|msg| interp.die_msg(msg))?);
				if let Some(warning) = tr.warning() { interp.warn_category("misc", warning); }
				if copy && cx == Cx::Void {
					interp.warn_category("void", "Useless use of non-destructive transliteration (tr///r) in void context");
				}
				interp.rx.translations.insert(site, tr.clone());
				tr
			};
			let op = Operation::Transliteration;
			let target = subject(interp, lhs, (!copy && !tr.is_count_only()).then_some(op))?;
			if !copy && !tr.is_count_only() && matches!(&target, Subject::ReadOnly(_)) {
				return Err(interp.die_msg("Modification of a read-only value attempted"));
			}
			let (cell, value) = target.read(interp)?;
			let source = text(interp, value, lhs, op)?;
			if tr.is_count_only() {
				return Ok(Ret::One(if copy { Value::Str(source) } else { count_or_negate(tr.count(&source), negate, true) }));
			}
			let (result, count) = tr.apply(&source);
			if copy { return Ok(Ret::One(Value::Str(result))); }
			if let Some(cell) = cell {
				interp.rx.set_position(&cell, None);
				if count != 0 || cell.tie().is_some() { interp.write_sv(&cell, Value::Str(result))?; }
			}
			Ok(Ret::One(count_or_negate(count, negate, true)))
		}
		RegexKind::Compile if lhs.is_none() => {
			Ok(Ret::One(Value::Ref(Ref::Regexp(new_rx(regex_expr(interp, re)?)))))
		}
		RegexKind::Match(once) => {
			let key = re as *const RegexExpr as usize;
			let target = subject(interp, lhs, None)?;
			if keep_pos && !global && !interp.rx.patterns.contains_key(&key) {
				interp.warn_category("regexp", "Use of /c modifier is meaningless without /g");
			}
			if *once && interp.rx.once.contains_key(&key) {
				if global && !keep_pos {
					if let Some(cell) = target.cell() { interp.rx.set_position(&cell, None); }
				}
				return Ok(no_match(negate, cx));
			}
			let compiled = regex_expr(interp, re)?;
			let regex = reuse_empty(interp, compiled);
			let once = (*once).then_some(key);
			match_subject(interp, regex, target, lhs, MatchMode { global, keep_pos, once, negate, cx })
		}
		RegexKind::Compile => {
			let target = subject(interp, lhs, None)?;
			let regex = regex_expr(interp, re)?;
			match_subject(interp, regex, target, lhs, MatchMode { global: false, keep_pos: false, once: None, negate, cx })
		}
		RegexKind::Substitute(_) | RegexKind::SubstituteEval(..) => {
			if copy && negate { return Err(interp.die_msg("Using !~ with s///r doesn't make sense")); }
			let target = subject(interp, lhs, (!copy).then_some(Operation::Substitution))?;
			let first = !interp.rx.patterns.contains_key(&(re as *const RegexExpr as usize));
			if keep_pos && first {
				interp.warn_category("regexp", "Use of /c modifier is meaningless in s///");
			}
			if copy && cx == Cx::Void && first {
				interp.warn_category("void", "Useless use of non-destructive substitution (s///r) in void context");
			}
			let compiled = regex_expr(interp, re)?;
			let regex = reuse_empty(interp, compiled);
			substitute(interp, regex, target, lhs, &re.kind, SubMode { global, copy, negate }).map(Ret::One)
		}
	}
}

/// Bind a subject to a computed regex or a string compiled as a regex.
pub(in crate::perl) fn bind_expr(interp: &mut Interp<'_>, lhs: &Expr, pattern: &Expr, negate: bool, cx: Cx) -> PResult<Ret> {
	if let ExprKind::Regex(re) = &ungroup(pattern).kind {
		return eval_regex(interp, re, Some(lhs), negate, cx);
	}
	let target = subject(interp, Some(lhs), None)?;
	let value = interp.eval_scalar(pattern)?;
	let regex = if let Some(regex) = coerce_regexp(interp, &value)? { regex } else {
		let source = text(interp, value, Some(pattern), Operation::Compile)?;
		let flags = effective_flags(interp, &[])?;
		let compiled = compile(interp, pattern as *const Expr as usize, &source, flags)?;
		reuse_empty(interp, compiled)
	};
	match_subject(interp, regex, target, Some(lhs), MatchMode { global: false, keep_pos: false, once: None, negate, cx })
}

fn coerce_regexp(interp: &mut Interp<'_>, value: &Value) -> PResult<Option<Rc<Regex>>> {
	let Value::Ref(reference) = value else { return Ok(None); };
	if let Ref::Regexp(r) = reference { return Ok(Some(r.regex.clone())); }
	let Some(class) = reference.blessed() else { return Ok(None); };
	// Unlike stringification, this conversion tries only an explicit `qr`
	// handler, not the general `nomethod` fallback.
	if interp.overload_handler(&class, "qr").is_none() { return Ok(None); }
	match interp.overload_builtin("qr", value, None, Cx::Scalar)?.map(Ret::scalar) {
		Some(Value::Ref(Ref::Regexp(r))) => Ok(Some(r.regex.clone())),
		Some(_) => Err(interp.die_msg("Overloaded qr did not return a REGEXP")),
		None => Ok(None),
	}
}

fn bool_value(value: bool) -> Value {
	if value { Value::Int(1) } else { Value::Str(PStr::default()) }
}

fn count_or_negate(count: usize, negate: bool, zero_is_number: bool) -> Value {
	if negate { bool_value(count == 0) }
	else if count == 0 && !zero_is_number { bool_value(false) }
	else { Value::Int(count as i64) }
}

fn no_match(negate: bool, cx: Cx) -> Ret {
	if !negate && cx == Cx::List { Ret::Many(Vec::new()) } else { Ret::One(bool_value(negate)) }
}

struct MatchMode { global: bool, keep_pos: bool, once: Option<usize>, negate: bool, cx: Cx }

fn match_subject(interp: &mut Interp<'_>, regex: Rc<Regex>, target: Subject, lhs: Option<&Expr>, mode: MatchMode) -> PResult<Ret> {
	let (cell, source) = target.snapshot(interp, lhs)?;
	let mut pos = cell.as_ref().map_or_else(Position::default, |cell| interp.rx.position(cell));
	let list = mode.cx == Cx::List && !mode.negate;
	let mut out = Vec::new();
	let mut last = None;
	loop {
		if interp.is_cancelled() { return Err(Flow::Cancelled); }
		let Some(caps) = search(interp, &regex, &source, cell.as_ref(), pos, mode.global, 0)? else {
			if mode.global && !mode.keep_pos {
				if let Some(cell) = &cell { interp.rx.set_position(cell, None); }
			}
			break;
		};
		let (start, end) = whole_span(&caps);
		pos = Position { at: end, empty: start == end || (regex.uses_g() && end == pos.at) };
		if mode.global && (!list || mode.keep_pos) {
			if let Some(cell) = &cell { interp.rx.set_position(cell, Some(pos)); }
		}
		if list {
			if regex.captures_len() != 0 {
				out.extend(caps.spans.iter().skip(1).map(|&span| captures::capture_value(&source, span)));
			} else if mode.global {
				out.push(captures::capture_value(&source, caps.spans.first().copied().flatten()));
			} else { out.push(Value::Int(1)); }
		}
		last = Some(caps);
		if !mode.global || !list { break; }
	}
	let Some(last) = last else { return Ok(no_match(mode.negate, mode.cx)); };
	install_match(interp, source, last, regex);
	if let Some(key) = mode.once {
		let pkg = interp.package();
		interp.rx.once.insert(key, pkg);
	}
	Ok(if list { Ret::Many(out) } else { Ret::One(bool_value(!mode.negate)) })
}

fn install_match(interp: &mut Interp<'_>, source: Rc<PStr>, captures: Captures, regex: Rc<Regex>) -> Rc<MatchState> {
	if let Some(mark) = &captures.mark {
		let package = interp.package();
		let mark_var = interp.sv(&format!("{package}::REGMARK"));
		let error_var = interp.sv(&format!("{package}::REGERROR"));
		mark_var.set(Value::Str(mark.clone()));
		error_var.set(bool_value(false));
	}
	let state = Rc::new(MatchState::new(source, captures, regex));
	interp.set_last_match(Some(state.clone()));
	state
}

fn whole_span(captures: &Captures) -> (usize, usize) {
	// A successful PCRE2 match always has group zero.
	captures.spans.first().copied().flatten().unwrap_or_default()
}

fn next_boundary(s: &PStr, at: usize) -> usize {
	let mut next = at.saturating_add(1);
	if s.utf8 && let Some(&head @ 0xc0..=0xff) = s.bytes.get(at) {
		let width = if head == 0xff { 13 } else { head.leading_ones() as usize };
		let limit = at.saturating_add(width);
		while next < limit && s.bytes.get(next).is_some_and(|b| b & 0xc0 == 0x80) { next += 1; }
	}
	next
}

fn search(interp: &mut Interp<'_>, regex: &Rc<Regex>, subject: &Rc<PStr>, cell: Option<&Sv>, pos: Position, global: bool, floor: usize) -> PResult<Option<Captures>> {
	let rewind = regex.g_rewind();
	let mut start = if global { pos.at.saturating_sub(rewind.unwrap_or(usize::MAX)).max(floor) } else { floor };
	if subject.utf8 {
		while subject.bytes.get(start).is_some_and(|b| b & 0xc0 == 0x80) { start += 1; }
	}
	let g_anchor = regex.uses_g().then_some(pos.at);
	loop {
		let opts = ExecOpts { not_empty_at_start: global && pos.empty && start == pos.at, g_anchor, ..ExecOpts::default() };
		let found = actions::exec(interp, regex, subject, cell, start, opts)?;
		let Some(caps) = found else { return Ok(None); };
		let (begin, end) = whole_span(&caps);
		if !global || rewind == Some(0) || end > pos.at || (end == pos.at && !pos.empty) { return Ok(Some(caps)); }
		// A floating `\G` can consume before pos, but a second match ending
		// at the same pos must still make forward progress.
		start = next_boundary(subject, start.max(begin));
	}
}

struct SubMode { global: bool, copy: bool, negate: bool }

fn substitute(interp: &mut Interp<'_>, regex: Rc<Regex>, target: Subject, lhs: Option<&Expr>, kind: &RegexKind, mode: SubMode) -> PResult<Value> {
	let readonly = matches!(&target, Subject::ReadOnly(_));
	let (cell, value) = target.read(interp)?;
	let original = if mode.copy && !matches!(value, Value::Str(_)) { Some(value.clone()) } else { None };
	let mut subject = text(interp, value, lhs, Operation::Substitution)?;
	let bytes = interp.hints().bytes;
	let original_utf8 = subject.utf8;
	subject.utf8 &= !bytes;
	let subject = Rc::new(subject);
	let empty = PStr::default();
	let literal = match kind {
		RegexKind::Substitute(parts) => match parts.as_slice() {
			[] => Some(&empty),
			[QuotePart::Literal(s)] => Some(s),
			_ => None,
		},
		_ => None,
	};
	let mut pos = Position { at: cell.as_ref().and_then(|sv| sv.pos.get()).unwrap_or(0), empty: false };
	let mut result = None::<PStr>;
	let mut cursor = 0;
	let mut count = 0;
	loop {
		if interp.is_cancelled() { return Err(Flow::Cancelled); }
		let Some(caps) = search(interp, &regex, &subject, cell.as_ref(), pos, count != 0, cursor)? else { break; };
		let (start, end) = whole_span(&caps);
		// Don't allow a floating \G or \K to overwrite already substituted text.
		if start < cursor || end < start { break; }
		let state = install_match(interp, subject.clone(), caps, regex.clone());
		if !mode.copy {
			if readonly { return Err(interp.die_msg("Modification of a read-only value attempted")); }
			if let Some(cell) = &cell { interp.rx.set_position(cell, Some(Position { at: start, empty: false })); }
		}
		let dst = result.get_or_insert_with(|| PStr::new(Vec::with_capacity(subject.bytes.len()), subject.utf8));
		append_span(dst, &subject, cursor, start);
		if let Some(s) = literal {
			if bytes { dst.push_bytes(&s.bytes); } else { dst.push(s); }
		} else {
			let mut replacement = replacement(interp, kind)?;
			replacement.utf8 &= !bytes;
			dst.push(&replacement);
		}
		interp.set_last_match(Some(state));
		cursor = end;
		pos = Position { at: end, empty: start == end || (regex.uses_g() && end == pos.at) };
		count += 1;
		if !mode.global { break; }
	}
	let Some(mut result) = result else {
		return Ok(if mode.copy {
			original.unwrap_or_else(|| {
				let mut source = Rc::unwrap_or_clone(subject);
				source.utf8 = original_utf8;
				Value::Str(source)
			})
		} else { count_or_negate(0, mode.negate, false) });
	};
	append_span(&mut result, &subject, cursor, subject.bytes.len());
	if mode.copy { return Ok(Value::Str(result)); }
	if let Some(cell) = cell {
		interp.rx.set_position(&cell, None);
		interp.write_sv(&cell, Value::Str(result))?;
	}
	Ok(count_or_negate(count, mode.negate, false))
}

fn replacement(interp: &mut Interp<'_>, kind: &RegexKind) -> PResult<PStr> {
	let RegexKind::SubstituteEval(block, count) = kind else {
		let RegexKind::Substitute(parts) = kind else { return Err(interp.die_msg("Invalid substitution replacement")); };
		return interp.interpolate(parts, InterpMode::Replacement);
	};
	let mut value = interp.run_block(block, Cx::Scalar)?.scalar();
	for _ in 1..*count {
		let source = text(interp, value, None, Operation::SubstitutionIterator)?;
		value = interp.eval_string(&source, Cx::Scalar)?.scalar();
	}
	text(interp, value, None, Operation::SubstitutionIterator)
}

fn append_span(dst: &mut PStr, source: &PStr, start: usize, end: usize) {
	let Some(bytes) = source.bytes.get(start..end) else { return; };
	if source.utf8 {
		dst.upgrade();
		dst.bytes.extend_from_slice(bytes);
	} else { dst.push_bytes(bytes); }
}

fn arguments(call: &Call) -> &[Expr] {
	match call.args.as_deref() {
		Some(Expr { kind: ExprKind::List(args), .. }) => args,
		Some(expr) => std::slice::from_ref(expr),
		None => &[],
	}
}

/// Dispatch the pattern-related `perlfunc` builtins owned by Rx.
pub(in crate::perl) fn call(interp: &mut Interp<'_>, b: Builtin, call: &Call, cx: Cx) -> Option<PResult<Ret>> {
	let max = match b {
		Builtin::Split => 3,
		Builtin::Pos | Builtin::Reset | Builtin::Study => 1,
		_ => return None,
	};
	let args = arguments(call);
	if args.len() > max {
		return Some(Err(interp.die_msg(format!("Too many arguments for {}", b.name()))));
	}
	Some(match b {
		Builtin::Split => split::split(interp, args, cx),
		Builtin::Pos => get_pos(interp, args.first()).map(Ret::One),
		Builtin::Reset => reset(interp, args.first()).map(Ret::One),
		Builtin::Study => study(interp, args.first()).map(Ret::One),
		_ => return None,
	})
}

/// Implement assignment to the lvalue built by `pos`.
pub(in crate::perl) fn assign(interp: &mut Interp<'_>, b: Builtin, call: &Call, value: Value) -> Option<PResult<Value>> {
	if b != Builtin::Pos { return None; }
	let args = arguments(call);
	Some(if args.len() > 1 { Err(interp.die_msg("Too many arguments for pos")) }
	else { set_pos(interp, args.first(), value) })
}

fn get_pos(interp: &mut Interp<'_>, arg: Option<&Expr>) -> PResult<Value> {
	let target = subject(interp, arg, Some(Operation::Position))?;
	let Some(cell) = target.cell() else { return Ok(Value::Undef); };
	lvalue_get(interp, &cell)
}

fn set_pos(interp: &mut Interp<'_>, arg: Option<&Expr>, value: Value) -> PResult<Value> {
	let target = subject(interp, arg, Some(Operation::Position))?;
	let Some(cell) = target.cell() else { return Ok(Value::Undef); };
	set_cell_pos(interp, &cell, arg, value)
}

/// Make an aliased reference to a scalar's regex position.
pub(in crate::perl) fn lvalue(interp: &mut Interp<'_>, b: Builtin, call: &Call) -> Option<PResult<Sv>> {
	if b != Builtin::Pos { return None; }
	let args = arguments(call);
	Some((|| {
		if args.len() > 1 { return Err(interp.die_msg("Too many arguments for pos")); }
		let Some(source) = subject(interp, args.first(), Some(Operation::Position))?.cell() else {
			return Err(interp.die_msg("Can't modify constant item in match position"));
		};
		Ok(new_lvalue(Lvalue::Pos { source }))
	})())
}

/// Read the position of the scalar underlying a `pos` alias.
pub(in crate::perl) fn lvalue_get(interp: &mut Interp<'_>, source: &Sv) -> PResult<Value> {
	let Some(at) = source.pos.get() else { return Ok(Value::Undef); };
	let at = if !interp.hints().bytes
		&& let Ok(value) = source.try_value()
		&& let Value::Str(s) = &*value
	{
		if s.utf8 { interp.rx.offset(source, s, at, false).1 } else { at.min(s.bytes.len()) }
	} else { at };
	Ok(Value::Int(at as i64))
}

/// Set the position of the scalar underlying a `pos` alias.
pub(in crate::perl) fn lvalue_set(interp: &mut Interp<'_>, source: &Sv, value: Value) -> PResult<Value> {
	set_cell_pos(interp, source, None, value)
}

fn set_cell_pos(interp: &mut Interp<'_>, cell: &Sv, arg: Option<&Expr>, value: Value) -> PResult<Value> {
	if value.is_undef() {
		interp.rx.set_position(cell, None);
		return Ok(Value::Undef);
	}
	let old = interp.read_sv(cell)?;
	let source = text(interp, old, arg, Operation::PosAssign)?;
	if let Value::Str(s) = &value && !value.is_numeric_string() && interp.warn_on("numeric") {
		interp.warn_category("numeric", format!("Argument \"{}\" isn't numeric in scalar assignment", s.to_string_lossy()));
	}
	let n = interp.numify(&value)?.wrapping_iv();
	let bytes = interp.hints().bytes;
	let len = if bytes { source.bytes.len() } else { source.char_len() };
	let n = if n < 0 { len.saturating_sub(n.unsigned_abs() as usize) } else { len.min(n as usize) };
	let at = if bytes || !source.utf8 { n } else { interp.rx.offset(cell, &source, n, true).0 };
	interp.rx.set_position(cell, Some(Position { at, empty: false }));
	Ok(Value::Int(n as i64))
}

fn study(interp: &mut Interp<'_>, expr: Option<&Expr>) -> PResult<Value> {
	let (_, value) = subject(interp, expr, None)?.read(interp)?;
	Ok(bool_value(!text(interp, value, expr, Operation::Study)?.is_empty()))
}

fn reset(interp: &mut Interp<'_>, expr: Option<&Expr>) -> PResult<Value> {
	let pkg = interp.package();
	if let Some(expr) = expr {
		let value = interp.eval_scalar(expr)?;
		let spec = text(interp, value, Some(expr), Operation::Reset)?;
		for glob in interp.package_globs(&pkg) {
			let Some(first) = glob.name.chars().next().map(u32::from) else { continue; };
			if !reset_name(&spec, first) { continue; }
			let cell = glob.scalar.borrow().clone();
			if !interp.is_readonly_sv(&cell) {
				interp.rx.set_position(&cell, None);
				cell.set(Value::Undef);
			}
			glob.array.borrow().elems_mut().clear();
			let hash = glob.hash.borrow();
			hash.entries_mut().clear();
			hash.iter.set(0);
		}
	} else {
		interp.rx.once.retain(|_, package| package != &pkg);
	}
	Ok(Value::Int(1))
}

fn reset_name(spec: &PStr, first: u32) -> bool {
	let mut chars = spec.chars().peekable();
	while let Some(start) = chars.next() {
		let end = if chars.next_if_eq(&u32::from(b'-')).is_some() { chars.next().unwrap_or(start) } else { start };
		if (start..=end).contains(&first) { return true; }
	}
	false
}

#[cfg(test)]
mod tests {
	use super::super::Perl;
	use crate::host::run_util;

	fn eval(source: &str) -> Vec<u8> {
		let cwd = tempfile::tempdir().unwrap();
		let (status, output) = run_util::<Perl>(&["-e", source], "", cwd.path());
		assert_eq!(status, 0, "{}", String::from_utf8_lossy(&output.stderr()));
		output.stdout()
	}

	#[test]
	fn regex_actions_get_partial_captures_and_backtrack_dynamic_subpatterns() {
		let output = eval(r#"
			$^R = "outer";
			"ab" =~ /(a)(?{ "failed" })x|(ab)(?{ "$^R:$^N" })/;
			print $^R, "\n";
			if ("bbc" =~ /\A(??{ "b+" })bc\z/) { print "retry\n"; }
			sub build { my $v = shift; return qr/a(?{ $v })b/; }
			my $rx = build("closure");
			"xab" =~ /x$rx/;
			print $^R, "\n";
		"#);
		assert_eq!(output, b"outer:ab\nretry\nclosure\n");
	}

	#[test]
	fn interpolated_actions_require_lexical_authorization() {
		let output = eval(r#"
			my $needle = q{a(?{ 'code' })b};
			eval { "ab" =~ /$needle/ };
			if ($@ =~ /Eval-group not allowed/) { print "blocked\n"; }
			{
				use re 'eval';
				"ab" =~ /$needle/;
				print $^R, "\n";
			}
		"#);
		assert_eq!(output, b"blocked\ncode\n");
	}
}
