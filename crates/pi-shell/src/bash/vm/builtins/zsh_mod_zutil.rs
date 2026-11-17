//! zsh/zutil: `zstyle`, `zformat`, `zparseopts`, `zregexparse`.
//!
//! Ported from zsh 5.9 `Src/Modules/zutil.c` (MIT-style licence, Copyright
//! (c) 1999 Sven Wischnowsky and the zsh development group).
//!
//! The style table lives in the store ([`MiscKey::ZshStyles`]), so
//! subshells and restored shells see it. `zstyle -e` values and
//! `zregexparse` guards and actions are shell code: the builtin pushes a
//! [`ScriptKind::Code`] frame, keeps its progress in the store
//! ([`MiscKey::ZshCodePending`], by frame depth) and runs again when the
//! frame returns ([`Control::Resume`]); an error in the code is reported to
//! it through [`MiscKey::ZshCodeError`] (zsh's `errflag`).

use std::cmp::Ordering;

use bstr::{BStr, BString};
use serde::{Deserialize, Serialize};

use super::{
	Control, Ctx, Need, Outcome, R, alias_table, done,
	zsh_args::{Ops, isset, zx},
	zsh_print, zsh_quote,
};
use crate::bash::{
	diag::Diag,
	event::EventData,
	pattern::zsh::{Disables, Opts as PatOpts, PatFlags, tokenize},
	store::{Key, KeyBuf, MiscKey, Record},
	syntax::{Features, NO_ALIASES, Parser, zsh::tok},
	vm::{
		exec::{features, push_script},
		expand::{Expander, X},
		proc::{CodeKind, ScriptKind},
		state,
		zsh::{
			arith,
			math::Number,
			params::{self, PValue, PmFlags},
			wcwidth::wcwidth,
			zpattern,
		},
	},
	zshopt::ZshOpt,
};

// ---- shared helpers
// ------------------------------------------------------------------

/// The builtin's status, abandoning the rest of the command line after a
/// zsh error (`errflag`) it reported.
#[allow(clippy::unnecessary_wraps, reason = "a handler's result")]
const fn fin(status: i32, failed: bool) -> R {
	Ok(Outcome {
		status,
		control: if failed {
			Control::DiscardAll
		} else {
			Control::None
		},
	})
}

/// Run parameter code; a zsh error is reported once (zsh's `zerr` is quiet
/// while `errflag` is set) and marks the builtin failed.
fn px<T>(
	ctx: &mut Ctx<'_, '_>,
	failed: &mut bool,
	f: impl FnOnce(&mut Expander<'_, '_>) -> X<T>,
) -> Result<Option<T>, Need> {
	match zx(ctx, f)? {
		Ok(v) => Ok(Some(v)),
		Err(d) => {
			if !*failed {
				ctx.diag(d);
				*failed = true;
			}
			Ok(None)
		},
	}
}

/// zsh `setsparam`.
fn setsparam(
	ctx: &mut Ctx<'_, '_>,
	failed: &mut bool,
	name: &[u8],
	val: &[u8],
) -> Result<(), Need> {
	px(ctx, failed, |ex| params::assignsparam(ex, name, val, 0))?;
	Ok(())
}

/// zsh `setaparam`.
fn setaparam(
	ctx: &mut Ctx<'_, '_>,
	failed: &mut bool,
	name: &[u8],
	val: Vec<BString>,
) -> Result<(), Need> {
	px(ctx, failed, |ex| params::assignaparam(ex, name, val, 0))?;
	Ok(())
}

/// zsh `setiparam`: an integer parameter when new.
fn setiparam(ex: &mut Expander<'_, '_>, name: &[u8], val: i64) -> X<()> {
	params::setnparam(ex, name, Number::Int(val), val.to_string().as_bytes(), 0)?;
	Ok(())
}

/// `match`, `mbegin`, `mend` as zsh's `savematch` keeps them.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct Saved {
	vals: [Option<Vec<BString>>; 3],
}

/// The parameters [`Saved`] holds.
const MATCH_NAMES: [&[u8]; 3] = [b"match", b"mbegin", b"mend"];

/// zsh `savematch`.
fn savematch(ex: &mut Expander<'_, '_>) -> X<Saved> {
	let mut s = Saved::default();
	for (slot, name) in s.vals.iter_mut().zip(MATCH_NAMES) {
		*slot = params::getaparam(ex, name)?;
	}
	Ok(s)
}

/// zsh `restorematch`.
fn restorematch(ex: &mut Expander<'_, '_>, s: &Saved) -> X<()> {
	for (slot, name) in s.vals.iter().zip(MATCH_NAMES) {
		match slot {
			Some(v) => params::assignaparam(ex, name, v.clone(), 0)?,
			None => params::unsetparam(ex, name)?,
		}
	}
	Ok(())
}

/// What a builtin waiting for its shell code keeps.
#[derive(Debug, Serialize, Deserialize)]
enum Wait {
	/// `zstyle` evaluating a `-e` value: the match parameters to restore.
	Style(Saved),
	/// `zregexparse` between guards and actions.
	Regex(Box<Machine>),
}

/// One waiting builtin: the depth of its frame stack.
#[derive(Debug, Serialize, Deserialize)]
struct Pending {
	depth: u32,
	wait:  Wait,
}

/// The depth of the builtin's frame stack (the same when it runs again).
fn depth(ctx: &Ctx<'_, '_>) -> u32 {
	u32::try_from(ctx.vp.frames.len()).unwrap_or(u32::MAX)
}

/// The waiting builtins.
fn pending_load(ctx: &mut Ctx<'_, '_>) -> Result<Vec<Pending>, Need> {
	Ok(match ctx.record(Key::Misc(MiscKey::ZshCodePending))? {
		Some(Record::Misc(b)) => postcard::from_bytes(&b).unwrap_or_default(),
		_ => Vec::new(),
	})
}

/// Store the waiting builtins.
fn pending_store(ctx: &mut Ctx<'_, '_>, list: &[Pending]) {
	let rec = if list.is_empty() {
		None
	} else {
		postcard::to_allocvec(list)
			.ok()
			.map(|b| Record::Misc(b.into()))
	};
	ctx.store_record(KeyBuf::Misc(MiscKey::ZshCodePending), rec);
}

/// Take what this builtin kept before its frame ran (and forget entries
/// of deeper frames that never came back).
fn pending_take(ctx: &mut Ctx<'_, '_>) -> Result<Option<Wait>, Need> {
	let d = depth(ctx);
	let mut list = pending_load(ctx)?;
	if list.is_empty() {
		return Ok(None);
	}
	let w = list
		.iter()
		.position(|p| p.depth == d)
		.map(|i| list.remove(i).wait);
	list.retain(|p| p.depth < d);
	pending_store(ctx, &list);
	Ok(w)
}

/// Keep `wait` while this builtin's frame runs.
fn pending_put(ctx: &mut Ctx<'_, '_>, wait: Wait) -> Result<(), Need> {
	let d = depth(ctx);
	let mut list = pending_load(ctx)?;
	list.retain(|p| p.depth < d);
	list.push(Pending { depth: d, wait });
	pending_store(ctx, &list);
	Ok(())
}

/// Whether an error ended the code this builtin ran (taking the mark).
fn code_error(ctx: &mut Ctx<'_, '_>) -> Result<bool, Need> {
	let e = ctx.record(Key::Misc(MiscKey::ZshCodeError))?.is_some();
	if e {
		ctx.store_record(KeyBuf::Misc(MiscKey::ZshCodeError), None);
	}
	Ok(e)
}

/// Push `code` to run as zsh's `execode`/`execstring` with context `kind`,
/// its lines numbered from `line`; the builtin runs again after it.
fn push_code(ctx: &mut Ctx<'_, '_>, code: &[u8], line: u32, kind: CodeKind) -> R {
	code_error(ctx)?;
	push_script(ctx.vp, code, line, ScriptKind::Code(kind));
	ctx.k.emit_op(ctx.cx, ctx.vp, 0, EventData::EvalEnter);
	Ok(Outcome { status: 0, control: Control::Resume })
}

/// zsh's `lineno` at the builtin.
fn zsh_line(ctx: &mut Ctx<'_, '_>) -> u32 {
	ctx.k.zsh_site(ctx.cx, ctx.vp, ctx.line).1
}

/// zsh `MB_METASTRWIDTH` (`mb_metastrlenend` with widths): ASCII counts
/// one column, a character its `wcwidth` (none when unprintable), an
/// invalid byte one, an incomplete character at the end one per byte;
/// outside a multibyte locale the length.
fn mb_width(s: &[u8], utf8: bool) -> usize {
	if !utf8 {
		return s.len();
	}
	let mut w = 0;
	let mut i = 0;
	while i < s.len() {
		if s[i] < 0x80 {
			w += 1;
			i += 1;
			continue;
		}
		let (ch, n) = bstr::decode_utf8(&s[i..]);
		if let Some(c) = ch {
			w += usize::try_from(wcwidth(c)).unwrap_or(0);
			i += n;
		} else if is_utf8_prefix(&s[i..]) {
			// An incomplete character at the end: one per byte.
			w += s.len() - i;
			break;
		} else {
			w += 1;
			i += 1;
		}
	}
	w
}

/// Whether `s` (non-empty, starting with a non-ASCII byte) is the start of
/// a UTF-8 sequence that more bytes could complete.
fn is_utf8_prefix(s: &[u8]) -> bool {
	let need = match s[0] {
		0xc2..=0xdf => 2,
		0xe0..=0xef => 3,
		0xf0..=0xf4 => 4,
		_ => return false,
	};
	s.len() < need && s[1..].iter().all(|&c| c & 0xc0 == 0x80)
}

// ---- zstyle
// ------------------------------------------------------------------

/// Pattern options a style pattern was compiled with (zsh keeps the
/// compiled pattern), serializable.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct SavedOpts {
	bits:     u8,
	disables: Vec<String>,
}

impl SavedOpts {
	fn of(o: &PatOpts) -> Self {
		let bits = u8::from(o.extended_glob)
			| u8::from(o.ksh_glob) << 1
			| u8::from(o.sh_glob) << 2
			| u8::from(o.case_glob) << 3
			| u8::from(o.case_paths) << 4
			| u8::from(o.multibyte) << 5;
		Self { bits, disables: o.disables.names(true).map(str::to_owned).collect() }
	}

	fn opts(&self) -> PatOpts {
		let mut disables = Disables::NONE;
		for n in &self.disables {
			if let Some(d) = Disables::from_name(n.as_bytes()) {
				disables = disables | d;
			}
		}
		PatOpts {
			extended_glob: self.bits & 1 != 0,
			ksh_glob: self.bits & 2 != 0,
			sh_glob: self.bits & 4 != 0,
			case_glob: self.bits & 8 != 0,
			case_paths: self.bits & 16 != 0,
			multibyte: self.bits & 32 != 0,
			disables,
		}
	}
}

/// A pattern and its values for one style (zsh `struct stypat`).
#[derive(Clone, Debug, Serialize, Deserialize)]
struct Stypat {
	/// The pattern as given.
	pat:    BString,
	/// How specific it is ([`weight`]).
	weight: u64,
	/// The values (for `-e`, the words of the code).
	vals:   Vec<BString>,
	/// `-e`: the zsh line the code was parsed at.
	eval:   Option<u32>,
	/// The options the pattern was compiled with.
	opts:   SavedOpts,
}

/// A style and its patterns, by weight descending then definition order
/// (zsh `struct style`).
#[derive(Clone, Debug, Serialize, Deserialize)]
struct Style {
	name: BString,
	pats: Vec<Stypat>,
}

/// zsh `zstyletab`, sorted by name as zsh's sorted scans list it.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct StyleTab {
	styles: Vec<Style>,
}

impl StyleTab {
	fn find(&self, name: &[u8]) -> Option<usize> {
		self.styles.iter().position(|s| s.name.as_slice() == name)
	}

	/// The style `name`, added when new (zsh `addstyle`).
	fn get_or_add(&mut self, name: &[u8]) -> usize {
		if let Some(i) = self.find(name) {
			return i;
		}
		let at = self
			.styles
			.iter()
			.position(|s| ztrcmp(&s.name, name) == Ordering::Greater)
			.unwrap_or(self.styles.len());
		self
			.styles
			.insert(at, Style { name: name.into(), pats: Vec::new() });
		at
	}

	/// zsh `freestypat`: drop pattern `p` of style `s`, and the style
	/// with its last pattern.
	fn remove(&mut self, s: usize, p: usize) {
		self.styles[s].pats.remove(p);
		if self.styles[s].pats.is_empty() {
			self.styles.remove(s);
		}
	}
}

/// zsh `ztrcmp` (the sort of hash-table scans) on raw bytes: C `char`s
/// (signed), the end before everything.
fn ztrcmp(a: &[u8], b: &[u8]) -> Ordering {
	let i = a.iter().zip(b).take_while(|(x, y)| x == y).count();
	let c = |s: &[u8]| s.get(i).map_or(-1, |&c| i32::from(i8::from_ne_bytes([c])));
	c(a).cmp(&c(b))
}

/// zsh `setstypat`'s weight: the number of `:`-separated components in
/// the high half, the sum of their scores (`*` alone 0, a pattern 1, a
/// literal 2) in the low half.
fn weight(pat: &[u8]) -> u64 {
	let (mut weight, mut tmp, mut first) = (0u64, 2u64, true);
	for (i, &c) in pat.iter().enumerate() {
		if first && c == b'*' && pat.get(i + 1).is_none_or(|&n| n == b':') {
			tmp = 0;
			continue;
		}
		first = false;
		if matches!(c, b'(' | b'|' | b'*' | b'[' | b'<' | b'?' | b'#' | b'^') {
			tmp = 1;
		}
		if c == b':' {
			weight += 1 << 32;
			first = true;
			weight += tmp;
			tmp = 2;
		}
	}
	weight + tmp
}

/// The style table.
fn styles_load(ctx: &mut Ctx<'_, '_>) -> Result<StyleTab, Need> {
	Ok(match ctx.record(Key::Misc(MiscKey::ZshStyles))? {
		Some(Record::Misc(b)) => postcard::from_bytes(&b).unwrap_or_default(),
		_ => StyleTab::default(),
	})
}

/// Store the style table.
fn styles_save(ctx: &mut Ctx<'_, '_>, t: &StyleTab) {
	let rec = if t.styles.is_empty() {
		None
	} else {
		postcard::to_allocvec(t)
			.ok()
			.map(|b| Record::Misc(b.into()))
	};
	ctx.store_record(KeyBuf::Misc(MiscKey::ZshStyles), rec);
}

/// zsh/zutil's `finish_`: unloading the module drops the style table.
pub fn finish(ctx: &mut Ctx<'_, '_>) {
	ctx.store_record(KeyBuf::Misc(MiscKey::ZshStyles), None);
}

/// `metafy` + `tokenize`: a pattern argument as `patcompile` takes it.
fn pat_text(s: &[u8]) -> Vec<u8> {
	let mut t = tok::metafy(s);
	tokenize(&mut t);
	t
}

/// A `zstyle` listing form (zsh `ZSLIST_*`).
#[derive(Clone, Copy, PartialEq, Eq)]
enum List {
	None,
	Basic,
	Syntax,
}

/// What a style lookup found.
enum Found {
	/// The values (`None`: no pattern matched, or `-e` code set no
	/// `reply`).
	Vals(Option<Vec<BString>>),
	/// The `-e` code is pushed: the builtin's outcome.
	Wait(R),
}

/// zsh `lookupstyle`: the values of `style` for context `ctxt`. A `-e`
/// value pushes its code and waits (the builtin runs again, finding the
/// result in `reply`).
fn lookupstyle(
	ctx: &mut Ctx<'_, '_>,
	failed: &mut bool,
	ctxt: &[u8],
	style: &[u8],
) -> Result<Found, Need> {
	if ctx.resumed > 0 {
		let Some(Wait::Style(saved)) = pending_take(ctx)? else {
			return Ok(Found::Vals(None));
		};
		// zsh `evalstyle`: an error yields nothing (and leaves `reply`).
		let err = code_error(ctx)?;
		let r = px(ctx, failed, |ex| {
			let mut ret = None;
			if !err {
				ret = match params::getaparam(ex, b"reply")? {
					Some(a) => Some(a),
					None => params::getsparam(ex, b"reply")?.map(|s| vec![s]),
				};
				params::unsetparam(ex, b"reply")?;
			}
			restorematch(ex, &saved)?;
			Ok(ret)
		})?;
		return Ok(Found::Vals(r.flatten()));
	}
	let tab = styles_load(ctx)?;
	let Some(si) = tab.find(style) else {
		return Ok(Found::Vals(None));
	};
	let s = &tab.styles[si];
	let hit = px(ctx, failed, |ex| {
		let env = zpattern::char_env(ex)?;
		let subj = tok::metafy(ctxt);
		for (i, p) in s.pats.iter().enumerate() {
			let Some(prog) =
				zpattern::compile_with(ex, &pat_text(&p.pat), PatFlags::NONE, &p.opts.opts())
			else {
				continue;
			};
			if !prog.matches(&subj, &env.env()) {
				continue;
			}
			if p.eval.is_none() {
				return Ok(Some((i, None)));
			}
			// The code sees the pattern's `(#b)` captures; `match` & co.
			// are restored afterwards.
			let saved = savematch(ex)?;
			zpattern::matches(ex, &prog, ctxt)?;
			params::unsetparam(ex, b"reply")?;
			return Ok(Some((i, Some(saved))));
		}
		Ok(None)
	})?;
	match hit.flatten() {
		None => Ok(Found::Vals(None)),
		Some((i, None)) => Ok(Found::Vals(Some(s.pats[i].vals.clone()))),
		Some((i, Some(saved))) => {
			let p = &s.pats[i];
			let code = bstr::join(b" ", &p.vals);
			let line = p.eval.unwrap_or(0);
			pending_put(ctx, Wait::Style(saved))?;
			Ok(Found::Wait(push_code(ctx, &code, line, CodeKind::Style)))
		},
	}
}

/// Whether `v` is one of zsh's true words.
const fn truthy(v: &[u8]) -> bool {
	matches!(v, b"yes" | b"true" | b"on" | b"1")
}

/// zsh `parse_string` of `code` at set time (`zstyle -e`): the parse error,
/// if any.
fn parse_error(
	ctx: &mut Ctx<'_, '_>,
	code: &[u8],
) -> Result<Option<crate::bash::syntax::ParseError>, Need> {
	let feat = features(ctx.k, ctx.cx.store, ctx.vp)? | Features::ZSH_INTERACTIVE_COMMENTS;
	let aliases = alias_table(ctx.k, ctx.cx, ctx.vp)?;
	let mut p = match &aliases {
		Some(a) => Parser::new(code, feat, a),
		None => Parser::new(code, feat, NO_ALIASES),
	};
	while let Some(r) = p.next_command() {
		if let Err(e) = r {
			return Ok(Some(e));
		}
	}
	Ok(None)
}

/// A pattern test of style values (`zstyle -L -e`'s filter).
type ValueFilter<'a> = Option<&'a dyn Fn(&[u8]) -> bool>;

/// zsh `printstylenode`.
fn print_style(
	out: &mut Vec<u8>,
	s: &Style,
	list: List,
	filter: ValueFilter<'_>,
	rc: bool,
	cs: zsh_quote::Charset,
) {
	let q = |s: &[u8]| zsh_quote::quotedzputs(s, rc, cs);
	if list == List::Basic {
		out.extend_from_slice(&q(s.name.as_slice()));
		out.push(b'\n');
	}
	for p in &s.pats {
		if filter.is_some_and(|f| !f(p.pat.as_slice())) {
			continue;
		}
		if list == List::Basic {
			out.extend_from_slice(if p.eval.is_some() {
				b"(eval)  "
			} else {
				b"        "
			});
			out.extend_from_slice(&p.pat);
		} else {
			out.extend_from_slice(if p.eval.is_some() {
				&b"zstyle -e "[..]
			} else {
				b"zstyle "
			});
			out.extend_from_slice(&q(p.pat.as_slice()));
			out.push(b' ');
			out.extend_from_slice(&q(s.name.as_slice()));
		}
		for v in &p.vals {
			out.push(b' ');
			out.extend_from_slice(&q(v.as_slice()));
		}
		out.push(b'\n');
	}
}

/// zsh `bin_zstyle`.
pub fn zstyle(ctx: &mut Ctx<'_, '_>, _ops: &Ops, args: &[BString]) -> R {
	let mut args = args;
	let (mut list, mut add, mut eval) = (List::None, false, false);
	match args.first() {
		None => list = List::Basic,
		Some(a) if a.first() == Some(&b'-') => match a.get(1) {
			Some(&oc) if oc != b'-' => {
				if a.len() > 2 {
					ctx.usage(format!("invalid argument: {}", BStr::new(a)));
					return done(1);
				}
				if oc == b'L' {
					list = List::Syntax;
					args = &args[1..];
				} else if oc == b'e' {
					eval = true;
					add = true;
					args = &args[1..];
				}
			},
			_ => {
				add = true;
				args = &args[1..];
			},
		},
		Some(_) => add = true,
	}
	if add {
		return zstyle_set(ctx, args, eval);
	}
	if list != List::None {
		return zstyle_list(ctx, args, list);
	}
	let opt = args[0].get(1).copied().unwrap_or(0);
	let (min, max): (usize, Option<usize>) = match opt {
		b'd' => (0, None),
		b's' => (3, Some(4)),
		b'b' | b'a' | b'm' => (3, Some(3)),
		b't' | b'T' => (2, None),
		b'g' => (1, Some(3)),
		_ => {
			ctx.usage(format!("invalid option: {}", BStr::new(&args[0])));
			return done(1);
		},
	};
	let n = args.len() - 1;
	if n < min {
		ctx.usage("not enough arguments");
		return done(1);
	}
	if max.is_some_and(|m| n > m) {
		ctx.usage("too many arguments");
		return done(1);
	}
	let mut failed = false;
	match opt {
		b'd' => {
			let mut tab = styles_load(ctx)?;
			match args.get(1) {
				Some(pat) if args.len() > 2 => {
					for name in &args[2..] {
						if let Some(si) = tab.find(name)
							&& let Some(pi) = tab.styles[si].pats.iter().position(|p| p.pat == *pat)
						{
							tab.remove(si, pi);
						}
					}
				},
				Some(pat) => {
					let mut si = 0;
					while si < tab.styles.len() {
						let before = tab.styles.len();
						if let Some(pi) = tab.styles[si].pats.iter().position(|p| p.pat == *pat) {
							tab.remove(si, pi);
						}
						if tab.styles.len() == before {
							si += 1;
						}
					}
				},
				None => tab.styles.clear(),
			}
			styles_save(ctx, &tab);
			done(0)
		},
		b's' | b'b' | b'a' | b't' | b'T' | b'm' => {
			let vals = match lookupstyle(ctx, &mut failed, &args[1], &args[2])? {
				Found::Vals(v) => v,
				Found::Wait(r) => return r,
			};
			let ret = match opt {
				b's' => {
					let (ret, val) = match &vals {
						Some(v) if !v.is_empty() => {
							let sep: &[u8] = args.get(4).map_or(&b" "[..], |s| s.as_slice());
							(bstr::join(sep, v), 0)
						},
						_ => (Vec::new(), 1),
					};
					setsparam(ctx, &mut failed, &args[3], &ret)?;
					val
				},
				b'b' => {
					let yes = matches!(&vals, Some(v) if v.len() == 1 && truthy(&v[0]));
					let word: &[u8] = if yes { b"yes" } else { b"no" };
					setsparam(ctx, &mut failed, &args[3], word)?;
					i32::from(!yes)
				},
				b'a' => {
					let val = i32::from(vals.is_none());
					setaparam(ctx, &mut failed, &args[3], vals.unwrap_or_default())?;
					val
				},
				b't' | b'T' => match &vals {
					Some(v) if !v.is_empty() => {
						if args.len() > 3 {
							i32::from(!args[3..].iter().any(|a| v.contains(a)))
						} else {
							i32::from(!truthy(&v[0]))
						}
					},
					_ if opt == b't' => {
						if vals.is_some() {
							1
						} else {
							2
						}
					},
					_ => 0,
				},
				_ => {
					let mut ret = 1;
					if let Some(v) = &vals {
						let text = pat_text(&args[3]);
						let hit = px(ctx, &mut failed, |ex| {
							let Some(prog) = zpattern::try_compile(ex, &text, PatFlags::NONE)? else {
								return Ok(false);
							};
							let env = zpattern::char_env(ex)?;
							Ok(v.iter().any(|s| prog.matches(&tok::metafy(s), &env.env())))
						})?;
						if hit == Some(true) {
							ret = 0;
						}
					}
					ret
				},
			};
			fin(ret, failed)
		},
		_ => {
			// `-g`.
			let tab = styles_load(ctx)?;
			let mut out: Vec<BString> = Vec::new();
			let mut ret = 1;
			match (args.get(2), args.get(3)) {
				(Some(pat), Some(style)) => {
					if let Some(si) = tab.find(style)
						&& let Some(p) = tab.styles[si].pats.iter().find(|p| p.pat == *pat)
					{
						out.extend(p.vals.iter().cloned());
						ret = 0;
					}
				},
				(Some(pat), None) => {
					for s in &tab.styles {
						if s.pats.iter().any(|p| p.pat == *pat) {
							out.push(s.name.clone());
						}
					}
					ret = 0;
				},
				_ => {
					for s in &tab.styles {
						for p in &s.pats {
							if !out.contains(&p.pat) {
								out.push(p.pat.clone());
							}
						}
					}
					ret = 0;
				},
			}
			setaparam(ctx, &mut failed, &args[1], out)?;
			fin(ret, failed)
		},
	}
}

/// `zstyle [-e] pattern style values…`.
fn zstyle_set(ctx: &mut Ctx<'_, '_>, args: &[BString], eval: bool) -> R {
	let [pat, name, vals @ ..] = args else {
		ctx.usage("not enough arguments");
		return done(1);
	};
	let text = pat_text(pat);
	let compiled = zx(ctx, |ex| {
		let ok = zpattern::try_compile(ex, &text, PatFlags::NONE)?.is_some();
		Ok((ok, zpattern::opts(ex)?))
	})?;
	let opts = match compiled {
		Ok((true, o)) => o,
		Ok((false, _)) => {
			ctx.usage(format!("invalid pattern: {}", BStr::new(pat)));
			return done(1);
		},
		Err(d) => {
			ctx.diag(d);
			return fin(1, true);
		},
	};
	let mut tab = styles_load(ctx)?;
	let si = tab.get_or_add(name);
	let line = if eval {
		let code = bstr::join(b" ", vals);
		let at = zsh_line(ctx);
		if let Some(e) = parse_error(ctx, &code)? {
			// zsh has added the style already.
			styles_save(ctx, &tab);
			ctx.diag(Diag::ZshAtLine {
				line: at + e.line.saturating_sub(1),
				msg:  BString::from(e.bash_msg()),
			});
			return done(1);
		}
		Some(at)
	} else {
		None
	};
	let pats = &mut tab.styles[si].pats;
	if let Some(p) = pats.iter_mut().find(|p| p.pat == *pat) {
		// zsh keeps the pattern compiled first.
		p.vals = vals.to_vec();
		p.eval = line;
	} else {
		let w = weight(pat);
		let at = pats.iter().position(|q| q.weight < w).unwrap_or(pats.len());
		pats.insert(at, Stypat {
			pat:    pat.clone(),
			weight: w,
			vals:   vals.to_vec(),
			eval:   line,
			opts:   SavedOpts::of(&opts),
		});
	}
	styles_save(ctx, &tab);
	done(0)
}

/// `zstyle` / `zstyle -L [context [style]]`.
fn zstyle_list(ctx: &mut Ctx<'_, '_>, args: &[BString], list: List) -> R {
	let (context, stylename) = match args {
		[] => (None, None),
		[c] => (Some(c), None),
		[c, s] => (Some(c), Some(s)),
		_ => {
			ctx.usage("too many arguments");
			return done(1);
		},
	};
	let filter = match context {
		Some(c) => {
			let text = pat_text(c);
			let r = zx(ctx, |ex| {
				let p = zpattern::try_compile(ex, &text, PatFlags::NONE)?;
				Ok((p, zpattern::char_env(ex)?))
			})?;
			match r {
				Ok((Some(p), env)) => Some((p, env)),
				Ok((None, _)) => return done(1),
				Err(d) => {
					ctx.diag(d);
					return fin(1, true);
				},
			}
		},
		None => None,
	};
	let tab = styles_load(ctx)?;
	let rc = isset(ctx, ZshOpt::Rcquotes)?;
	let cs = zsh_print::charset(ctx)?;
	let test = filter
		.as_ref()
		.map(|(p, env)| move |s: &[u8]| p.matches(&tok::metafy(s), &env.env()));
	let test_dyn: ValueFilter<'_> = test.as_ref().map(|f| f as &dyn Fn(&[u8]) -> bool);
	let mut out = Vec::new();
	if let Some(name) = stylename {
		let Some(si) = tab.find(name) else {
			return done(1);
		};
		print_style(&mut out, &tab.styles[si], list, test_dyn, rc, cs);
	} else {
		for s in &tab.styles {
			print_style(&mut out, s, list, test_dyn, rc, cs);
		}
	}
	ctx.out(&out);
	done(0)
}

// ---- zformat
// ------------------------------------------------------------------

/// zsh `zformat_substring`'s state.
struct Fmt<'s> {
	/// `specs[c]`: the text of `c:text`.
	specs:    [Option<&'s [u8]>; 256],
	/// `-F`: ternaries test presence (and width) instead of value.
	presence: bool,
	/// Widths are multibyte widths.
	utf8:     bool,
	out:      Vec<u8>,
	/// A math error was reported (zsh `errflag`).
	failed:   bool,
}

/// C's `(int)` of a `zlong`.
#[allow(clippy::cast_possible_truncation, reason = "C's (int) cast")]
const fn c_int(v: i64) -> i32 {
	v as i32
}

impl<'s> Fmt<'s> {
	/// The text of `c:text`.
	fn spec(&self, c: u8) -> Option<&'s [u8]> {
		self.specs[usize::from(c)]
	}

	/// zsh `mathevali` of a spec value (0 after an error).
	fn math(&mut self, ctx: &mut Ctx<'_, '_>, spec: &[u8]) -> Result<i64, Need> {
		if self.failed {
			return Ok(0);
		}
		let text = tok::metafy(spec);
		match zx(ctx, |ex| arith::mathevali(ex, &text))? {
			Ok(v) => Ok(v),
			Err(d) => {
				ctx.diag(d);
				self.failed = true;
				Ok(0)
			},
		}
	}

	/// zsh `zformat_substring` of `s` from `i` up to `endchar` (0: the
	/// end), output unless `skip`: where it stopped, `None` when the text
	/// ended inside a ternary.
	fn sub(
		&mut self,
		ctx: &mut Ctx<'_, '_>,
		s: &'s [u8],
		mut i: usize,
		endchar: u8,
		skip: bool,
	) -> Result<Option<usize>, Need> {
		let at = |i: usize| s.get(i).copied().unwrap_or(0);
		while at(i) != 0 && at(i) != endchar {
			if s[i] != b'%' {
				if !skip {
					self.out.push(s[i]);
				}
				i += 1;
				continue;
			}
			let start = i;
			i += 1;
			let mut right = at(i) == b'-';
			if right {
				i += 1;
			}
			let (mut min, mut max) = (-1i32, -1i32);
			if at(i).is_ascii_digit() {
				min = 0;
				while at(i).is_ascii_digit() {
					min = min.wrapping_mul(10).wrapping_add(i32::from(at(i) - b'0'));
					i += 1;
				}
			}
			let testit = at(i) == b'(';
			if testit && at(i + 1) == b'-' {
				right = true;
				i += 1;
			}
			if (at(i) == b'.' || testit) && at(i + 1).is_ascii_digit() {
				max = 0;
				i += 1;
				while at(i).is_ascii_digit() {
					max = max.wrapping_mul(10).wrapping_add(i32::from(at(i) - b'0'));
					i += 1;
				}
			} else if at(i) == b'.' || testit {
				i += 1;
			}
			if testit && at(i) != 0 {
				let testval = if min >= 0 {
					min
				} else if max >= 0 {
					max
				} else {
					0
				};
				let actval = match self.spec(at(i)) {
					Some(spec) if !spec.is_empty() => {
						if self.presence {
							let len = if testval == 0 {
								1
							} else {
								i32::try_from(mb_width(spec, self.utf8)).unwrap_or(i32::MAX)
							};
							i32::from(if right { testval < len } else { testval >= len })
						} else {
							let tv = if right {
								testval.wrapping_neg()
							} else {
								testval
							};
							c_int(self.math(ctx, spec)?).wrapping_sub(tv)
						}
					},
					_ if self.presence => i32::from(!right),
					_ => testval,
				};
				i += 1;
				let endcharl = at(i);
				if endcharl == 0 {
					return Ok(None);
				}
				// Past the end of the text C reads beyond the string; the
				// text ends here.
				let Some(j) = self.sub(ctx, s, i + 1, endcharl, skip || actval != 0)? else {
					return Ok(None);
				};
				if at(j) == 0 {
					return Ok(None);
				}
				let Some(j) = self.sub(ctx, s, j + 1, b')', skip || actval == 0)? else {
					return Ok(None);
				};
				if at(j) == 0 {
					return Ok(None);
				}
				i = j;
			} else if skip {
				if at(i) == 0 {
					return Ok(Some(s.len()));
				}
			} else if let Some(spec) = self.spec(at(i)) {
				let mut len = spec.len();
				if let Ok(m) = usize::try_from(max)
					&& len > m
				{
					len = m;
				}
				let outl = usize::try_from(min).map_or(len, |m| m.max(len));
				if len >= outl {
					self.out.extend_from_slice(&spec[..outl]);
				} else {
					let pad = outl - len;
					if right {
						self.out.resize(self.out.len() + pad, b' ');
						self.out.extend_from_slice(&spec[..len]);
					} else {
						self.out.extend_from_slice(&spec[..len]);
						self.out.resize(self.out.len() + pad, b' ');
					}
				}
			} else {
				// An unknown or unfinished directive is copied as is.
				if i >= s.len() || at(i) == 0 {
					self.out.extend_from_slice(&s[start..i.min(s.len())]);
					return Ok(Some(s.len()));
				}
				self.out.extend_from_slice(&s[start..=i]);
			}
			i += 1;
		}
		Ok(Some(i.min(s.len())))
	}
}

/// zsh `bin_zformat`.
pub fn zformat(ctx: &mut Ctx<'_, '_>, _ops: &Ops, args: &[BString]) -> R {
	let Some(a0) = args.first() else {
		ctx.usage("not enough arguments");
		return done(1);
	};
	if a0.first() != Some(&b'-') || a0.len() != 2 || a0[1] == 0 {
		ctx.usage(format!("invalid argument: {}", BStr::new(a0)));
		return done(1);
	}
	let opt = a0[1];
	let args = &args[1..];
	let [name, fmt, rest @ ..] = args else {
		ctx.usage("not enough arguments");
		return done(1);
	};
	match opt {
		b'f' | b'F' => {
			let mut specs: [Option<&[u8]>; 256] = [None; 256];
			specs[usize::from(b'%')] = Some(&b"%"[..]);
			specs[usize::from(b')')] = Some(&b")"[..]);
			for ap in rest {
				if ap.is_empty()
					|| ap[0] == b'-'
					|| ap[0] == b'.'
					|| ap[0].is_ascii_digit()
					|| ap.get(1) != Some(&b':')
				{
					ctx.usage(format!("invalid argument: {}", BStr::new(ap)));
					return done(1);
				}
				specs[usize::from(ap[0])] = Some(&ap[2..]);
			}
			let presence = opt == b'F';
			let utf8 = presence && zsh_print::charset(ctx)?.utf8;
			let mut f = Fmt { specs, presence, utf8, out: Vec::new(), failed: false };
			f.sub(ctx, fmt, 0, 0, false)?;
			let mut failed = f.failed;
			let out = f.out;
			setsparam(ctx, &mut failed, name, &out)?;
			fin(0, failed)
		},
		b'a' => {
			let utf8 = zsh_print::charset(ctx)?.utf8;
			let mut prechars: isize = 0;
			for ap in rest {
				let (mut cp, mut nbc) = (0usize, 0usize);
				while cp < ap.len() && ap[cp] != b':' {
					if ap[cp] == b'\\' && cp + 1 < ap.len() {
						cp += 1;
						nbc += 1;
					}
					cp += 1;
				}
				if cp + 1 < ap.len() {
					let w = isize::try_from(mb_width(&ap[..cp], utf8)).unwrap_or(isize::MAX);
					let dchars = w - isize::try_from(nbc).unwrap_or(0);
					prechars = prechars.max(dchars);
				}
			}
			let mut ret = Vec::with_capacity(rest.len());
			for ap in rest {
				let mut cp = 0;
				let mut item = Vec::with_capacity(ap.len());
				while cp < ap.len() && ap[cp] != b':' {
					if ap[cp] == b'\\' && cp + 1 < ap.len() {
						cp += 1;
					}
					item.push(ap[cp]);
					cp += 1;
				}
				if cp + 1 < ap.len() {
					let w = isize::try_from(mb_width(&item, utf8)).unwrap_or(isize::MAX);
					let rempad = usize::try_from(prechars - w).unwrap_or(0);
					item.resize(item.len() + rempad, b' ');
					item.extend_from_slice(fmt);
					item.extend_from_slice(&ap[cp + 1..]);
				}
				ret.push(BString::from(item));
			}
			let mut failed = false;
			setaparam(ctx, &mut failed, name, ret)?;
			fin(0, failed)
		},
		_ => {
			ctx.usage(format!("invalid option: -{}", char::from(opt)));
			done(1)
		},
	}
}

// ---- zregexparse
// ------------------------------------------------------------------

/// zsh `RParseState`.
struct RState {
	/// The last byte of the element: `/`, `+` or `-`.
	cutoff:   u8,
	/// The pattern `(#b)((#B)PAT)(#B)LOOKAHEAD*` (raw), `None` for `[]`.
	pattern:  Option<Vec<u8>>,
	guard:    Option<BString>,
	action:   Option<BString>,
	branches: Vec<usize>,
}

/// zsh `RParseBranch`.
struct RBranch {
	state:   usize,
	actions: Vec<BString>,
}

/// zsh `RParseResult` (branch ids; `None` nullacts: not nullable).
#[derive(Default)]
struct RResult {
	nullacts: Option<Vec<BString>>,
	inl:      Vec<usize>,
	out:      Vec<usize>,
}

/// zsh's `longjmp` out of the regex parser.
struct Jump;

/// The regex parser over the arguments (zsh `rparseargs`), owning the
/// states and branches (zsh shares them by pointer).
struct RParser<'a> {
	args:     &'a [BString],
	pos:      usize,
	states:   Vec<RState>,
	branches: Vec<RBranch>,
}

impl<'a> RParser<'a> {
	fn cur(&self) -> Option<&'a BString> {
		self.args.get(self.pos)
	}

	fn branch(&mut self, state: usize, actions: Vec<BString>) -> usize {
		self.branches.push(RBranch { state, actions });
		self.branches.len() - 1
	}

	/// zsh `connectstates`.
	fn connect(&mut self, out: &[usize], inl: &[usize]) {
		for &ob in out {
			for &ib in inl {
				let mut acts = self.branches[ob].actions.clone();
				acts.extend(self.branches[ib].actions.iter().cloned());
				let st = self.branches[ib].state;
				let nb = self.branch(st, acts);
				let os = self.branches[ob].state;
				self.states[os].branches.push(nb);
			}
		}
	}

	/// zsh `rparseelt`: `Ok(true)` when the argument is no element.
	fn elt(&mut self, res: &mut RResult) -> Result<bool, Jump> {
		let Some(s) = self.cur() else {
			return Ok(true);
		};
		match s.first().copied() {
			Some(b'/') => {
				let l = s.len();
				let ok = (l >= 2 && s[l - 1] == b'/')
					|| (l >= 3 && s[l - 2] == b'/' && matches!(s[l - 1], b'+' | b'-'));
				if !ok {
					return Ok(true);
				}
				let cutoff = s[l - 1];
				let pattern = if cutoff == b'/' {
					&s[1..l - 1]
				} else {
					&s[1..l - 2]
				};
				self.pos += 1;
				let lookahead = match self.cur() {
					Some(t) if t.first() == Some(&b'%') && t.len() >= 2 && t[t.len() - 1] == b'%' => {
						self.pos += 1;
						Some(&t[1..t.len() - 1])
					},
					_ => None,
				};
				let pattern = (pattern != b"[]").then(|| {
					let mut p = b"(#b)((#B)".to_vec();
					p.extend_from_slice(pattern);
					p.push(b')');
					if let Some(la) = lookahead {
						p.extend_from_slice(b"(#B)");
						p.extend_from_slice(la);
					}
					p.push(b'*');
					p
				});
				let guard = match self.cur() {
					Some(t) if t.first() == Some(&b'-') => {
						self.pos += 1;
						Some(BString::from(&t[1..]))
					},
					_ => None,
				};
				let action = match self.cur() {
					Some(t) if t.first() == Some(&b':') => {
						self.pos += 1;
						Some(BString::from(&t[1..]))
					},
					_ => None,
				};
				self
					.states
					.push(RState { cutoff, pattern, guard, action, branches: Vec::new() });
				let st = self.states.len() - 1;
				res.nullacts = None;
				res.inl = vec![self.branch(st, Vec::new())];
				res.out = vec![self.branch(st, Vec::new())];
				Ok(false)
			},
			Some(b'(') => {
				if s.len() > 1 {
					return Ok(true);
				}
				self.pos += 1;
				self.alt(res)?;
				match self.cur() {
					Some(t) if t.as_slice() == b")" => {},
					_ => return Err(Jump),
				}
				self.pos += 1;
				Ok(false)
			},
			_ => Ok(true),
		}
	}

	/// zsh `rparseclo`.
	fn clo(&mut self, res: &mut RResult) -> Result<bool, Jump> {
		if self.elt(res)? {
			return Ok(true);
		}
		if self.cur().is_some_and(|t| t.as_slice() == b"#") {
			while self.cur().is_some_and(|t| t.as_slice() == b"#") {
				self.pos += 1;
			}
			let (out, inl) = (res.out.clone(), res.inl.clone());
			self.connect(&out, &inl);
			res.nullacts = Some(Vec::new());
		}
		Ok(false)
	}

	/// zsh `rparseseq`.
	fn seq(&mut self, res: &mut RResult) -> Result<(), Jump> {
		res.nullacts = Some(Vec::new());
		res.inl = Vec::new();
		res.out = Vec::new();
		loop {
			if let Some(s) = self.cur()
				&& s.first() == Some(&b'{')
				&& s.last() == Some(&b'}')
				&& s.len() >= 2
			{
				let action = BString::from(&s[1..s.len() - 1]);
				self.pos += 1;
				if let Some(n) = &mut res.nullacts {
					n.push(action.clone());
				}
				for &b in &res.out {
					self.branches[b].actions.push(action.clone());
				}
				continue;
			}
			let mut sub = RResult::default();
			if self.clo(&mut sub)? {
				break;
			}
			let out = res.out.clone();
			self.connect(&out, &sub.inl);
			if let Some(na) = &res.nullacts {
				for &b in &sub.inl {
					let mut acts = na.clone();
					acts.append(&mut self.branches[b].actions);
					self.branches[b].actions = acts;
				}
				res.inl.extend_from_slice(&sub.inl);
			}
			if let Some(sna) = &sub.nullacts {
				for &b in &res.out {
					self.branches[b].actions.extend(sna.iter().cloned());
				}
				res.out.extend_from_slice(&sub.out);
			} else {
				res.out = std::mem::take(&mut sub.out);
			}
			match sub.nullacts.take() {
				Some(s) if res.nullacts.is_some() => {
					if let Some(n) = &mut res.nullacts {
						n.extend(s);
					}
				},
				_ => res.nullacts = None,
			}
		}
		Ok(())
	}

	/// zsh `rparsealt`.
	fn alt(&mut self, res: &mut RResult) -> Result<(), Jump> {
		self.seq(res)?;
		while self.cur().is_some_and(|t| t.as_slice() == b"|") {
			self.pos += 1;
			let mut sub = RResult::default();
			self.seq(&mut sub)?;
			if res.nullacts.is_none() && sub.nullacts.is_some() {
				res.nullacts = sub.nullacts.take();
			}
			res.inl.extend_from_slice(&sub.inl);
			res.out.extend_from_slice(&sub.out);
		}
		Ok(())
	}
}

/// The branch list `rmatch` tries next: the start, or a state's.
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
enum Nexts {
	In,
	State(u32),
}

/// Where `rmatch` is.
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
enum Phase {
	/// Running the empty subject's actions, the next one.
	Null(u32),
	/// A new round: save `match`, try the branches.
	Round,
	/// Trying branch `ln` of the current list.
	Try(u32),
	/// Branch `ln`'s guard ran.
	Guard(u32),
	/// Branch `ln` matched: running its actions, the next one.
	Act(u32, u32),
	/// No branch matched.
	Stuck,
	/// The subject is consumed: the final branch's actions, the next one.
	Out(u32, u32),
	/// Failing: the state actions of the candidates (list, branch).
	Fail(u32, u32),
}

/// zsh `rmatch`'s progress, kept in the store across the code it runs.
#[derive(Debug, Serialize, Deserialize)]
struct Machine {
	point1:    i64,
	point2:    i64,
	/// Offset of the rest of the subject (raw bytes).
	subj:      u64,
	/// Length of the current branch's match.
	len:       i64,
	nexts:     Nexts,
	nextslist: Vec<Nexts>,
	st:        Option<u32>,
	phase:     Phase,
	match1:    Saved,
	match2:    Saved,
	/// `EXTENDED_GLOB` before the builtin forced it on.
	extglob:   bool,
	/// zsh `errflag`: a parameter or code error.
	failed:    bool,
	/// The zsh line code runs at.
	line:      u32,
}

/// What `rmatch` needs next.
enum Step {
	Done(i32),
	Run(BString, CodeKind),
}

/// C `atoi`.
fn atoi(s: &[u8]) -> i64 {
	let s = s.trim_ascii_start();
	let (neg, d) = match s.first() {
		Some(b'-') => (true, &s[1..]),
		Some(b'+') => (false, &s[1..]),
		_ => (false, s),
	};
	let v = d
		.iter()
		.take_while(|c| c.is_ascii_digit())
		.fold(0i64, |v, &c| v.wrapping_mul(10).wrapping_add(i64::from(c - b'0')));
	if neg { v.wrapping_neg() } else { v }
}

/// `rmatch` over the parsed regex.
struct Rmatch<'p, 'a> {
	p:    &'p RParser<'a>,
	top:  &'p RResult,
	subj: &'p [u8],
	var1: &'p [u8],
	var2: &'p [u8],
	comp: bool,
}

impl Rmatch<'_, '_> {
	fn list(&self, n: Nexts) -> &[usize] {
		match n {
			Nexts::In => &self.top.inl,
			Nexts::State(s) => self
				.p
				.states
				.get(s as usize)
				.map_or(&[][..], |st| st.branches.as_slice()),
		}
	}

	fn idx(i: usize) -> u32 {
		u32::try_from(i).unwrap_or(u32::MAX)
	}

	/// Run `rmatch` from `m.phase` until code must run or it is done.
	#[allow(clippy::too_many_lines, reason = "one state machine")]
	fn step(&self, ctx: &mut Ctx<'_, '_>, m: &mut Machine) -> Result<Step, Need> {
		loop {
			match m.phase {
				Phase::Null(i) => {
					let acts = self.top.nullacts.as_deref().unwrap_or_default();
					let Some(a) = acts.get(i as usize) else {
						return Ok(Step::Done(0));
					};
					m.phase = Phase::Null(i + 1);
					if !m.failed {
						return Ok(Step::Run(a.clone(), CodeKind::RegexAction));
					}
				},
				Phase::Round => {
					let saved = px(ctx, &mut m.failed, savematch)?;
					m.match1 = saved.unwrap_or_default();
					m.phase = Phase::Try(0);
				},
				Phase::Try(ln) => {
					let list = self.list(m.nexts);
					let Some(&br) = list.get(ln as usize) else {
						m.phase = Phase::Stuck;
						continue;
					};
					let next = &self.p.states[self.p.branches[br].state];
					m.phase = Phase::Try(ln + 1);
					let Some(pattern) = &next.pattern else {
						continue;
					};
					if m.failed {
						continue;
					}
					let text = pat_text(pattern);
					let rest = self
						.subj
						.get(usize::try_from(m.subj).unwrap_or(usize::MAX)..)
						.unwrap_or_default();
					let r = px(ctx, &mut m.failed, |ex| {
						let Some(prog) = zpattern::try_compile(ex, &text, PatFlags::NONE)? else {
							return Ok(None);
						};
						Ok(Some(zpattern::matches(ex, &prog, rest)?))
					})?;
					match r {
						None => {},
						Some(None) => return Ok(Step::Done(3)),
						Some(Some(false)) => {},
						Some(Some(true)) => {
							if let Some(g) = &next.guard {
								m.phase = Phase::Guard(ln);
								return Ok(Step::Run(g.clone(), CodeKind::RegexGuard));
							}
							self.matched(ctx, m, ln)?;
						},
					}
				},
				Phase::Guard(ln) => {
					// Settled by the caller from the guard's status.
					self.matched(ctx, m, ln)?;
				},
				Phase::Act(ln, i) => {
					let br = self.list(m.nexts)[ln as usize];
					let acts = &self.p.branches[br].actions;
					if let Some(a) = acts.get(i as usize) {
						m.phase = Phase::Act(ln, i + 1);
						if !m.failed {
							return Ok(Step::Run(a.clone(), CodeKind::RegexAction));
						}
						continue;
					}
					let match2 = std::mem::take(&mut m.match2);
					px(ctx, &mut m.failed, |ex| restorematch(ex, &match2))?;
					let state = self.p.branches[br].state;
					let cutoff = self.p.states[state].cutoff;
					m.point2 = m.point2.wrapping_add(m.len);
					let (var1, var2, p2) = (self.var1, self.var2, m.point2);
					px(ctx, &mut m.failed, |ex| setiparam(ex, var2, p2))?;
					m.st = Some(Self::idx(state));
					m.nexts = Nexts::State(Self::idx(state));
					if cutoff == b'-' || (cutoff == b'/' && m.len != 0) {
						m.nextslist.clear();
						m.point1 = m.point2;
						px(ctx, &mut m.failed, |ex| setiparam(ex, var1, p2))?;
					}
					m.nextslist.push(m.nexts);
					m.phase = Phase::Round;
				},
				Phase::Stuck => {
					let at_end = usize::try_from(m.subj).unwrap_or(usize::MAX) >= self.subj.len();
					m.phase = Phase::Fail(0, 0);
					if !self.comp && at_end {
						let st = m.st.map(|s| s as usize);
						if let Some(k) = self
							.top
							.out
							.iter()
							.position(|&b| Some(self.p.branches[b].state) == st)
						{
							m.phase = Phase::Out(Self::idx(k), 0);
						}
					}
				},
				Phase::Out(k, i) => {
					let br = self.top.out[k as usize];
					let Some(a) = self.p.branches[br].actions.get(i as usize) else {
						return Ok(Step::Done(0));
					};
					m.phase = Phase::Out(k, i + 1);
					if !m.failed {
						return Ok(Step::Run(a.clone(), CodeKind::RegexAction));
					}
				},
				Phase::Fail(l, b) => {
					let Some(&n) = m.nextslist.get(l as usize) else {
						let last = m.nextslist.last().copied().unwrap_or(Nexts::In);
						return Ok(Step::Done(if self.list(last).is_empty() { 2 } else { 1 }));
					};
					let list = self.list(n);
					let Some(&br) = list.get(b as usize) else {
						m.phase = Phase::Fail(l + 1, 0);
						continue;
					};
					m.phase = Phase::Fail(l, b + 1);
					let state = &self.p.states[self.p.branches[br].state];
					if let Some(a) = &state.action
						&& !m.failed
					{
						return Ok(Step::Run(a.clone(), CodeKind::RegexAction));
					}
				},
			}
		}
	}

	/// Branch `ln` matched (and passed its guard): consume its match, run
	/// its actions with the round's `match`.
	fn matched(&self, ctx: &mut Ctx<'_, '_>, m: &mut Machine, ln: u32) -> Result<(), Need> {
		let mend = px(ctx, &mut m.failed, |ex| params::getaparam(ex, b"mend"))?.flatten();
		let len = mend.and_then(|v| v.first().map(|e| atoi(e))).unwrap_or(0);
		let rest = self.subj.len() as u64 - m.subj.min(self.subj.len() as u64);
		m.subj += u64::try_from(len).unwrap_or(0).min(rest);
		m.len = len;
		let match1 = m.match1.clone();
		let saved = px(ctx, &mut m.failed, |ex| {
			let s = savematch(ex)?;
			restorematch(ex, &match1)?;
			Ok(s)
		})?;
		m.match2 = saved.unwrap_or_default();
		m.phase = Phase::Act(ln, 0);
		Ok(())
	}
}

/// zsh `bin_zregexparse`: `zregexparse [-c] var1 var2 string regex…`;
/// status 0 matched, 1 no candidate matched, 2 no candidates, 3 a regex
/// error.
pub fn zregexparse(ctx: &mut Ctx<'_, '_>, ops: &Ops, args: &[BString]) -> R {
	let [var1, var2, subj, regex @ ..] = args else {
		ctx.usage("not enough arguments");
		return done(1);
	};
	let comp = ops.isset(b'c');
	let mut p = RParser { args: regex, pos: 0, states: Vec::new(), branches: Vec::new() };
	let mut top = RResult::default();
	let parsed = p.alt(&mut top).is_ok() && p.pos >= regex.len();
	let mut m = if ctx.resumed > 0 {
		let Some(Wait::Regex(mut m)) = pending_take(ctx)? else {
			ctx.diag(Diag::Unsupported {
				what: "`zregexparse' lost its place after shell code".into(),
			});
			return done(3);
		};
		if code_error(ctx)? {
			m.failed = true;
		}
		if let Phase::Guard(ln) = m.phase
			&& (m.failed || ctx.vp.status != 0)
		{
			m.phase = Phase::Try(ln + 1);
		}
		*m
	} else {
		let extglob = ctx.zsh_option(ZshOpt::Extendedglob)?;
		if !parsed {
			match p.cur() {
				Some(a) => ctx.usage(format!("invalid regex : {}", BStr::new(a))),
				None => ctx.usage("not enough regex arguments"),
			}
			return done(3);
		}
		ctx.set_zsh_option(ZshOpt::Extendedglob, true)?;
		let mut m = Machine {
			point1: 0,
			point2: 0,
			subj: 0,
			len: 0,
			nexts: Nexts::In,
			nextslist: Vec::new(),
			st: None,
			phase: Phase::Round,
			match1: Saved::default(),
			match2: Saved::default(),
			extglob,
			failed: false,
			line: zsh_line(ctx),
		};
		let (v1, v2) = (var1.as_slice(), var2.as_slice());
		px(ctx, &mut m.failed, |ex| {
			setiparam(ex, v1, 0)?;
			setiparam(ex, v2, 0)
		})?;
		if !comp && subj.is_empty() && top.nullacts.is_some() {
			m.phase = Phase::Null(0);
		} else {
			m.nextslist.push(Nexts::In);
		}
		m
	};
	let rm = Rmatch { p: &p, top: &top, subj, var1, var2, comp };
	match rm.step(ctx, &mut m)? {
		Step::Run(code, kind) => {
			let line = m.line;
			pending_put(ctx, Wait::Regex(Box::new(m)))?;
			push_code(ctx, &code, line, kind)
		},
		Step::Done(ret) => {
			ctx.set_zsh_option(ZshOpt::Extendedglob, m.extglob)?;
			fin(ret, m.failed)
		},
	}
}

// ---- zparseopts
// ------------------------------------------------------------------

/// `name:`: takes an argument.
const ZOF_ARG: u8 = 1;
/// `name::`: an optional argument.
const ZOF_OPT: u8 = 2;
/// `name+`: may repeat.
const ZOF_MULT: u8 = 4;
/// `name:-`: the argument in the same word.
const ZOF_SAME: u8 = 8;
/// `-M`: the array names another option.
const ZOF_MAP: u8 = 16;
/// Being followed in a mapping (cycle check).
const ZOF_CYC: u8 = 32;

/// zsh `struct zoptdesc`.
struct ZDesc {
	name:  Vec<u8>,
	flags: u8,
	arr:   Option<usize>,
	/// Values in `onext` order.
	vals:  Vec<usize>,
}

/// zsh `struct zoptarr`.
struct ZArr {
	name: Vec<u8>,
	vals: Vec<usize>,
	num:  i64,
}

/// zsh `struct zoptval`.
struct ZVal {
	name: Vec<u8>,
	arg:  Option<Vec<u8>>,
	str:  Option<Vec<u8>>,
}

/// The descriptions, arrays and values of one `zparseopts` (zsh's
/// `opt_descs`/`opt_arrs` lists: newest first, so iterated in reverse).
#[derive(Default)]
struct ZOpts {
	descs: Vec<ZDesc>,
	arrs:  Vec<ZArr>,
	vals:  Vec<ZVal>,
}

impl ZOpts {
	/// zsh `get_opt_desc`.
	fn get_desc(&self, name: &[u8]) -> Option<usize> {
		self.descs.iter().rposition(|d| d.name == name)
	}

	/// zsh `lookup_opt`.
	fn lookup(&self, s: &[u8]) -> Option<usize> {
		self.descs.iter().rposition(|d| {
			if d.flags & ZOF_ARG != 0 {
				s.starts_with(&d.name)
			} else {
				d.name == s
			}
		})
	}

	/// zsh `get_opt_arr`.
	fn get_arr(&self, name: &[u8]) -> Option<usize> {
		self.arrs.iter().rposition(|a| a.name == name)
	}

	/// zsh `map_opt_desc`: the option `start` maps to, `None` in a cycle.
	fn map_desc(&mut self, start: usize) -> Option<usize> {
		if self.descs[start].flags & ZOF_MAP == 0 {
			return Some(start);
		}
		let Some(a) = self.descs[start].arr else {
			return Some(start);
		};
		let Some(map) = self.get_desc(&self.arrs[a].name) else {
			return Some(start);
		};
		if map == start {
			self.descs[start].flags &= !ZOF_MAP;
			return Some(start);
		}
		if self.descs[map].flags & ZOF_CYC != 0 {
			return None;
		}
		self.descs[start].flags |= ZOF_CYC;
		let r = self.map_desc(map);
		self.descs[start].flags &= !ZOF_CYC;
		r
	}

	/// zsh `add_opt_val`.
	fn add_val(&mut self, d0: usize, arg: Option<&[u8]>) {
		let mut n = b"-".to_vec();
		n.extend_from_slice(&self.descs[d0].name);
		let d = self.map_desc(d0).unwrap_or(d0);
		let flags = self.descs[d].flags;
		let reuse = if flags & ZOF_MULT == 0 {
			self.descs[d].vals.first().copied()
		} else {
			None
		};
		let (v, new) = if let Some(v) = reuse {
			(v, false)
		} else {
			self.vals.push(ZVal { name: n, arg: None, str: None });
			(self.vals.len() - 1, true)
		};
		self.vals[v].arg = arg.map(<[u8]>::to_vec);
		let inc = if flags & ZOF_ARG != 0 && flags & (ZOF_OPT | ZOF_SAME) == 0 {
			self.vals[v].str = None;
			if arg.is_some() { 2 } else { 1 }
		} else if let Some(a) = arg {
			let mut s = b"-".to_vec();
			s.extend_from_slice(&self.descs[d].name);
			s.extend_from_slice(a);
			self.vals[v].str = Some(s);
			1
		} else {
			self.vals[v].str = None;
			1
		};
		let arr = self.descs[d].arr;
		if let Some(a) = arr {
			self.arrs[a].num += inc;
		}
		if new {
			if let Some(a) = arr {
				self.arrs[a].vals.push(v);
			}
			self.descs[d].vals.push(v);
		}
	}
}

/// zsh `bin_zparseopts`.
#[allow(clippy::too_many_lines, reason = "a faithful port of one C function")]
pub fn zparseopts(ctx: &mut Ctx<'_, '_>, _ops: &Ops, args: &[BString]) -> R {
	let (mut del, mut extract, mut fail, mut keep, mut flags) = (false, false, false, false, 0u8);
	let mut z = ZOpts::default();
	let mut defarr = None;
	let mut assoc: Option<BString> = None;
	let mut i = 0;
	let mut described = false;
	while let Some(o) = args.get(i) {
		i += 1;
		if o.first() != Some(&b'-') {
			i -= 1;
			described = true;
			break;
		}
		let mut stop = false;
		match o.get(1).copied() {
			None => stop = true,
			Some(b'-') => {
				if o.len() > 2 {
					i -= 1;
				}
				stop = true;
			},
			Some(c @ (b'D' | b'E' | b'F' | b'K' | b'M')) => {
				if o.len() > 2 {
					i -= 1;
					stop = true;
				} else {
					match c {
						b'D' => del = true,
						b'E' => extract = true,
						b'F' => fail = true,
						b'K' => keep = true,
						_ => flags |= ZOF_MAP,
					}
				}
			},
			Some(b'a') => {
				if defarr.is_some() {
					ctx.usage("default array given more than once");
					return done(1);
				}
				let n = if o.len() > 2 {
					o[2..].to_vec()
				} else if let Some(n) = args.get(i) {
					i += 1;
					n.to_vec()
				} else {
					ctx.usage("missing array name");
					return done(1);
				};
				z.arrs.push(ZArr { name: n, vals: Vec::new(), num: 0 });
				defarr = Some(z.arrs.len() - 1);
			},
			Some(b'A') => {
				if assoc.is_some() {
					ctx.usage("associative array given more than once");
					return done(1);
				}
				assoc = Some(if o.len() > 2 {
					BString::from(&o[2..])
				} else if let Some(n) = args.get(i) {
					i += 1;
					n.clone()
				} else {
					ctx.usage("missing array name");
					return done(1);
				});
			},
			Some(_) => {
				i -= 1;
				stop = true;
			},
		}
		if stop {
			described = true;
			break;
		}
	}
	if !described {
		ctx.usage("missing option descriptions");
		return done(1);
	}
	let mut sopts: [Option<usize>; 256] = [None; 256];
	for orig in &args[i..] {
		let o: &[u8] = orig;
		if o.is_empty() {
			ctx.usage("invalid option description: ");
			return done(1);
		}
		let mut f = 0u8;
		let mut p = 0;
		let mut end = None;
		while p < o.len() {
			if o[p] == b'\\' && p + 1 < o.len() {
				p += 1;
			} else if p > 0 {
				if o[p] == b'+' {
					f |= ZOF_MULT;
					end = Some(p);
					p += 1;
					break;
				} else if o[p] == b':' || o[p] == b'=' {
					break;
				}
			}
			p += 1;
		}
		let at = |p: usize| o.get(p).copied().unwrap_or(0);
		if at(p) == b':' {
			f |= ZOF_ARG;
			if end.is_none() {
				end = Some(p);
			}
			p += 1;
			if at(p) == b':' {
				p += 1;
				f |= ZOF_OPT;
			}
			if at(p) == b'-' {
				p += 1;
				f |= ZOF_SAME;
			}
		}

		let a = if at(p) == b'=' {
			if end.is_none() {
				end = Some(p);
			}
			f |= flags;
			let an = &o[p + 1..];
			Some(z.get_arr(an).unwrap_or_else(|| {
				z.arrs
					.push(ZArr { name: an.to_vec(), vals: Vec::new(), num: 0 });
				z.arrs.len() - 1
			}))
		} else if p < o.len() {
			ctx.usage(format!("invalid option description: {}", BStr::new(orig)));
			return done(1);
		} else if defarr.is_none() && assoc.is_none() {
			ctx.usage(format!("no default array defined: {}", BStr::new(orig)));
			return done(1);
		} else {
			defarr
		};
		let raw = &o[..end.unwrap_or(o.len())];
		let mut name = Vec::with_capacity(raw.len());
		let mut q = 0;
		while q < raw.len() {
			if raw[q] == b'\\' && q + 1 < raw.len() {
				q += 1;
			}
			name.push(raw[q]);
			q += 1;
		}
		if z.get_desc(&name).is_some() {
			ctx.usage(format!("option defined more than once: {}", BStr::new(&name)));
			return done(1);
		}
		let single = (name.len() == 1).then(|| name[0]);
		z.descs
			.push(ZDesc { name, flags: f, arr: a, vals: Vec::new() });
		let d = z.descs.len() - 1;
		if let Some(c) = single {
			sopts[usize::from(c)] = Some(d);
		}
		if flags & ZOF_MAP != 0 && z.map_desc(d).is_none() {
			ctx.usage(format!("cyclic option mapping: {}", BStr::new(orig)));
			return done(1);
		}
	}
	let pp = ctx.positional()?;
	let mut cp: Vec<BString> = Vec::new();
	let mut k = 0;
	while let Some(o) = pp.get(k) {
		if o.first() != Some(&b'-') {
			if extract {
				if del {
					cp.push(o.clone());
				}
				k += 1;
				continue;
			}
			break;
		}
		if o.len() == 1 || o.as_slice() == b"--" {
			if del && extract {
				cp.push(o.clone());
			}
			k += 1;
			break;
		}
		if let Some(d) = z.lookup(&o[1..]) {
			if z.descs[d].flags & ZOF_ARG != 0 {
				let e = &o[1 + z.descs[d].name.len()..];
				if !e.is_empty() {
					z.add_val(d, Some(e));
				} else if z.descs[d].flags & ZOF_OPT == 0
					|| pp.get(k + 1).is_some_and(|n| n.first() != Some(&b'-'))
				{
					let Some(n) = pp.get(k + 1) else {
						ctx.usage(format!(
							"missing argument for option: -{}",
							BStr::new(&z.descs[d].name)
						));
						return done(1);
					};
					k += 1;
					z.add_val(d, Some(n.as_slice()));
				} else {
					z.add_val(d, None);
				}
			} else {
				z.add_val(d, None);
			}
			k += 1;
			continue;
		}
		let mut unknown = false;
		let mut j = 1;
		while j < o.len() {
			let c = o[j];
			let Some(d) = sopts[usize::from(c)] else {
				if fail {
					if c == b'-' {
						ctx.usage(format!("bad option: -{}", BStr::new(&o[j..])));
					} else {
						ctx.usage(format!("bad option: -{}", char::from(c)));
					}
					return done(1);
				}
				unknown = true;
				break;
			};
			if z.descs[d].flags & ZOF_ARG != 0 {
				if j + 1 < o.len() {
					z.add_val(d, Some(&o[j + 1..]));
					break;
				} else if z.descs[d].flags & ZOF_OPT == 0
					|| pp.get(k + 1).is_some_and(|n| n.first() != Some(&b'-'))
				{
					let Some(n) = pp.get(k + 1) else {
						ctx.usage(format!(
							"missing argument for option: -{}",
							BStr::new(&z.descs[d].name)
						));
						return done(1);
					};
					k += 1;
					z.add_val(d, Some(n.as_slice()));
				} else {
					z.add_val(d, None);
				}
			} else {
				z.add_val(d, None);
			}
			j += 1;
		}
		if unknown {
			if extract {
				if del {
					cp.push(pp[k].clone());
				}
				k += 1;
				continue;
			}
			break;
		}
		k += 1;
	}
	if flags & ZOF_MAP != 0 {
		for d in 0..z.descs.len() {
			if let Some(a) = z.descs[d].arr
				&& z.descs[d].vals.is_empty()
				&& z.descs[d].flags & ZOF_MAP != 0
				&& z.arrs[a].num == 0
				&& z.get_desc(&z.arrs[a].name).is_some()
			{
				z.arrs[a].num = -1;
			}
		}
	}
	let rest = pp.get(k..).unwrap_or_default();
	if extract && del {
		cp.extend_from_slice(rest);
	}
	let mut failed = false;
	for a in z.arrs.iter().rev() {
		if a.num >= 0 && (!keep || a.num != 0) {
			let mut aval = Vec::new();
			for &v in &a.vals {
				let v = &z.vals[v];
				if let Some(s) = &v.str {
					aval.push(BString::from(s.as_slice()));
				} else {
					aval.push(BString::from(v.name.as_slice()));
					if let Some(arg) = &v.arg {
						aval.push(BString::from(arg.as_slice()));
					}
				}
			}
			setaparam(ctx, &mut failed, &a.name, aval)?;
		}
	}
	if let Some(assoc) = &assoc {
		let num = z.descs.iter().filter(|d| !d.vals.is_empty()).count();
		if !keep || num > 0 {
			let mut aval: Vec<BString> = Vec::new();
			if keep {
				let cur = px(ctx, &mut failed, |ex| params::getparam(ex, assoc))?.flatten();
				if let Some(pm) = cur
					&& !pm.flags.contains(PmFlags::UNSET)
				{
					match pm.value {
						PValue::Hash(h) => aval.extend(h.into_iter().flat_map(|(k, v)| [k, v])),
						PValue::Array(a) => aval.extend(a),
						PValue::Scalar(_) => {},
					}
				}
			}
			for d in z.descs.iter().rev() {
				if d.vals.is_empty() {
					continue;
				}
				let mut key = b"-".to_vec();
				key.extend_from_slice(&d.name);
				aval.push(key.into());
				// zsh joins the arguments without separators.
				let mut val = Vec::new();
				for &v in &d.vals {
					if let Some(arg) = &z.vals[v].arg {
						val.extend_from_slice(arg);
					}
				}
				aval.push(val.into());
			}
			px(ctx, &mut failed, |ex| params::sethparam(ex, assoc, &aval))?;
		}
	}
	if del {
		let params = if extract { cp } else { rest.to_vec() };
		state::set_positional(&mut ctx.k.root, ctx.cx.store, ctx.vp, params);
	}
	fin(0, failed)
}
