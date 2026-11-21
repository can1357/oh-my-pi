//! zsh/pcre: `pcre_compile`, `pcre_study`, `pcre_match` and the
//! `-pcre-match` condition (`[[ s =~ re ]]` under `REMATCH_PCRE`).
//!
//! The compiled pattern is per shell: its text and options live in the
//! store ([`MiscKey::ZshPcre`]), so subshells inherit it; compiled code is
//! kept in a process cache. Matching is PCRE2's with PCRE1's messages and
//! error codes ([`crate::sys::pcre`]).
//!
//! Ported from zsh 5.9 `Src/Modules/pcre.c` (MIT-style licence, Copyright
//! (c) 1992-1997 Paul Falstad and the zsh development group).

use core::ops::Range;
use std::{
	collections::HashMap,
	sync::{Arc, LazyLock},
};

use bstr::{BString, ByteSlice};
use parking_lot::Mutex;

use super::{
	Ctx, Need, R, done,
	zsh_args::{Ops, zerr, zx},
	zsh_mod_regex::mb_count,
};
use crate::{
	bash::{
		diag::Diag,
		store::{Key, KeyBuf, MiscKey, Record},
		vm::{
			expand::{Expander, X},
			zsh::{math::Number, params},
		},
		zshopt::ZshOpt,
	},
	sys::pcre::{self, CompileError, Pcre},
};

/// Compiled patterns by text and options.
type Cache = HashMap<(BString, u32), Arc<Pcre>>;

/// The process's compiled patterns.
static CACHE: LazyLock<Mutex<Cache>> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// How many compiled patterns the cache keeps before starting over.
const CACHE_MAX: usize = 64;

/// `pattern` compiled with `options`, from the cache when it was before.
fn compiled(pattern: &[u8], options: u32) -> Result<Arc<Pcre>, CompileError> {
	let key = (BString::from(pattern), options);
	let mut cache = CACHE.lock();
	if let Some(p) = cache.get(&key) {
		return Ok(Arc::clone(p));
	}
	let p = Arc::new(Pcre::compile(pattern, options)?);
	if cache.len() >= CACHE_MAX {
		cache.clear();
	}
	cache.insert(key, Arc::clone(&p));
	Ok(p)
}

/// zsh `zpcre_utf8_enabled`: `MULTIBYTE` in a UTF-8 locale.
fn utf8_enabled(ctx: &mut Ctx<'_, '_>) -> Result<bool, Need> {
	Ok(super::zsh_print::charset(ctx)?.utf8)
}

/// The shell's compiled pattern (`pcre_pattern`): options and text.
fn current(ctx: &mut Ctx<'_, '_>) -> Result<Option<(u32, BString)>, Need> {
	Ok(match ctx.record(Key::Misc(MiscKey::ZshPcre))? {
		Some(Record::Words(w)) => match w.as_slice() {
			[opts, pat] => opts
				.to_str()
				.ok()
				.and_then(|o| o.parse().ok())
				.map(|o| (o, pat.clone())),
			_ => None,
		},
		_ => None,
	})
}

/// zsh `bin_pcre_compile`: `pcre_compile [-aimxs] PATTERN`.
pub fn pcre_compile(ctx: &mut Ctx<'_, '_>, ops: &Ops, args: &[BString]) -> R {
	let mut opts = 0;
	for (c, bit) in [
		(b'a', pcre::ANCHORED),
		(b'i', pcre::CASELESS),
		(b'm', pcre::MULTILINE),
		(b'x', pcre::EXTENDED),
		(b's', pcre::DOTALL),
	] {
		if ops.isset(c) {
			opts |= bit;
		}
	}
	if utf8_enabled(ctx)? {
		opts |= pcre::UTF8;
	}
	let Some(target) = args.first() else {
		return done(1);
	};
	// The old pattern goes first, whatever becomes of the new one.
	ctx.store_record(KeyBuf::Misc(MiscKey::ZshPcre), None);
	let target = match target.find_byte(0) {
		Some(n) => {
			ctx.usage("embedded NULs in PCRE pattern terminate pattern");
			&target[..n]
		},
		None => target.as_slice(),
	};
	if let Err(e) = compiled(target, opts) {
		ctx.usage(format!("error in regex: {}", e.message()));
		return done(1);
	}
	let rec = Record::Words(vec![BString::from(opts.to_string()), BString::from(target)]);
	ctx.store_record(KeyBuf::Misc(MiscKey::ZshPcre), Some(rec));
	done(0)
}

/// zsh `bin_pcre_study`: PCRE2 studies every pattern as it compiles it,
/// so only the missing pattern is an error.
pub fn pcre_study(ctx: &mut Ctx<'_, '_>, _ops: &Ops, _args: &[BString]) -> R {
	if current(ctx)?.is_none() {
		ctx.usage("no pattern has been compiled for study");
		return done(1);
	}
	done(0)
}

/// zsh `getposint`: a non-negative decimal (`zstrtol`: leading blanks, a
/// sign), `None` otherwise.
fn getposint(s: &[u8]) -> Option<usize> {
	let t = s.trim_start_with(|c| c == ' ' || c == '\t');
	let (neg, d) = match t.first() {
		Some(b'-') => (true, &t[1..]),
		Some(b'+') => (false, &t[1..]),
		_ => (false, t),
	};
	if !d.iter().all(u8::is_ascii_digit) {
		return None;
	}
	let v = d
		.iter()
		.fold(0i64, |v, &c| v.wrapping_mul(10).wrapping_add(i64::from(c - b'0')));
	// zsh keeps an `int`.
	let v = (if neg { v.wrapping_neg() } else { v }) as i32;
	usize::try_from(v).ok()
}

/// What `zpcre_get_substrings` sets.
struct Substrings<'a> {
	/// The parameter for the whole match (`MATCH`, `pcre_match -v`).
	matchvar:       Option<&'a [u8]>,
	/// The array for the groups (`match`, `pcre_match -a`, `BASH_REMATCH`).
	substravar:     Option<&'a [u8]>,
	/// `pcre_match -b`: `ZPCRE_OP` gets the match's byte offsets.
	want_offset:    bool,
	/// `BASH_REMATCH`: the whole match is the array's first element.
	matched_in_arr: bool,
	/// The condition: `MBEGIN MEND mbegin mend` too.
	want_begin_end: bool,
}

/// zsh `zpcre_get_substrings` for match `groups` of `arg` (`pcre_exec`'s
/// pairs up to the highest group set; `ksh` is 1 without `KSH_ARRAYS`).
fn get_substrings(
	ex: &mut Expander<'_, '_>,
	arg: &[u8],
	groups: &[Option<Range<usize>>],
	s: &Substrings<'_>,
	ksh: i64,
	utf8: bool,
) -> X<()> {
	let text = |g: &Option<Range<usize>>| {
		BString::from(
			g.as_ref()
				.and_then(|g| arg.get(g.clone()))
				.unwrap_or_default(),
		)
	};
	let whole = groups.first().cloned().flatten().unwrap_or(0..0);
	let nelem = groups.len().saturating_sub(1);
	if s.want_offset {
		let op = format!("{} {}", whole.start, whole.end);
		params::assignsparam(ex, b"ZPCRE_OP", op.as_bytes(), params::ASSPM_WARN)?;
	}
	if let Some(var) = s.matchvar {
		params::assignsparam(ex, var, &text(&Some(whole.clone())), params::ASSPM_WARN)?;
	}
	if let Some(var) = s.substravar
		&& (!s.want_begin_end || nelem > 0)
	{
		let from = usize::from(!s.matched_in_arr);
		let arr = groups
			.get(from..)
			.unwrap_or_default()
			.iter()
			.map(text)
			.collect();
		params::assignaparam(ex, var, arr, params::ASSPM_WARN)?;
	}
	if s.want_begin_end {
		let count = |r: Range<usize>| mb_count(arg.get(r).unwrap_or_default(), utf8);
		let before = count(0..whole.start);
		let mbegin = before + ksh;
		let mend = before + count(whole) + ksh - 1;
		params::setnparam(ex, b"MBEGIN", Number::Int(mbegin), mbegin.to_string().as_bytes(), 10)?;
		params::setnparam(ex, b"MEND", Number::Int(mend), mend.to_string().as_bytes(), 10)?;
		if nelem > 0 {
			let mut mbegin = Vec::with_capacity(nelem);
			let mut mend = Vec::with_capacity(nelem);
			for g in groups.get(1..).unwrap_or_default() {
				// An unset group (offsets -1) counts no characters at all.
				let (before, inside) = g
					.as_ref()
					.map_or((0, 0), |g| (count(0..g.start), count(g.clone())));
				mbegin.push(BString::from((before + ksh).to_string()));
				mend.push(BString::from((before + inside + ksh - 1).to_string()));
			}
			params::assignaparam(ex, b"mbegin", mbegin, params::ASSPM_WARN)?;
			params::assignaparam(ex, b"mend", mend, params::ASSPM_WARN)?;
		}
	}
	Ok(())
}

/// zsh `bin_pcre_match`: `pcre_match [-a ARR] [-v VAR] [-n OFFSET] [-b]
/// STRING` against the compiled pattern.
pub fn pcre_match(ctx: &mut Ctx<'_, '_>, ops: &Ops, args: &[BString]) -> R {
	let Some((opts, pattern)) = current(ctx)? else {
		ctx.usage("no pattern has been compiled");
		return done(1);
	};
	let receptacle = BString::from(
		ops.arg(b'a')
			.filter(|_| ops.hasarg(b'a'))
			.unwrap_or(&b"match"[..]),
	);
	let matched = BString::from(
		ops.arg(b'v')
			.filter(|_| ops.hasarg(b'v'))
			.unwrap_or(&b"MATCH"[..]),
	);
	let start = if ops.hasarg(b'n') {
		let n = ops.arg(b'n').unwrap_or_default();
		let Some(n) = getposint(n) else {
			ctx.usage(format!("integer expected: {}", n.as_bstr()));
			return done(1);
		};
		n
	} else {
		0
	};
	let want_offset = ops.isset(b'b');
	let re = match compiled(&pattern, opts) {
		Ok(re) => re,
		Err(e) => {
			ctx.usage(format!("error in regex: {}", e.message()));
			return done(1);
		},
	};
	let Some(subject) = args.first() else {
		return done(1);
	};
	let res = if start > 0 && start >= subject.len() {
		Ok(None)
	} else {
		re.exec(subject, start)
	};
	let groups = match res {
		Ok(Some(groups)) => groups,
		Ok(None) => return done(1),
		Err(code) => {
			ctx.usage(format!("error in pcre_exec [{code}]"));
			return done(1);
		},
	};
	let ksh = i64::from(!ctx.zsh_option(ZshOpt::Ksharrays)?);
	let utf8 = utf8_enabled(ctx)?;
	let s = Substrings {
		matchvar: Some(matched.as_slice()),
		substravar: Some(receptacle.as_slice()),
		want_offset,
		matched_in_arr: false,
		want_begin_end: false,
	};
	match zx(ctx, |ex| get_substrings(ex, subject, &groups, &s, ksh, utf8))? {
		Ok(()) => done(0),
		Err(d) => zerr(ctx, d),
	}
}

/// zsh `cond_pcre_match` (`l -pcre-match r`): `r` compiled for this test
/// (case ignored under `REMATCH_PCRE` without `CASE_MATCH`) and matched
/// against `l`, setting `MATCH MBEGIN MEND match mbegin mend` or, under
/// `BASH_REMATCH`, `BASH_REMATCH`. A pattern that does not compile warns
/// and is false. `Ok(Err(d))` is a parameter error (`zerr`).
///
/// # Errors
/// A probe or store access to run first.
pub fn cond_pcre_match(
	ctx: &mut Ctx<'_, '_>,
	l: &[u8],
	r: &[u8],
) -> Result<Result<bool, Diag>, Need> {
	let utf8 = utf8_enabled(ctx)?;
	let mut opts = 0;
	if utf8 {
		opts |= pcre::UTF8;
	}
	if ctx.zsh_option(ZshOpt::Rematchpcre)? && !ctx.zsh_option(ZshOpt::Casematch)? {
		opts |= pcre::CASELESS;
	}
	let bash = ctx.zsh_option(ZshOpt::Bashrematch)?;
	let ksh = i64::from(!ctx.zsh_option(ZshOpt::Ksharrays)?);
	let pattern = match r.find_byte(0) {
		Some(n) => {
			ctx.diag(Diag::Usage { msg: "embedded NULs in PCRE pattern terminate pattern".into() });
			&r[..n]
		},
		None => r,
	};
	let re = match compiled(pattern, opts) {
		Ok(re) => re,
		Err(e) => {
			ctx.diag(Diag::Usage {
				msg: format!("failed to compile regexp /{}/: {}", r.as_bstr(), e.message()).into(),
			});
			return Ok(Ok(false));
		},
	};
	let groups = match re.exec(l, 0) {
		Ok(Some(groups)) => groups,
		Ok(None) => return Ok(Ok(false)),
		Err(code) => {
			ctx.diag(Diag::Usage { msg: format!("pcre_exec() error [{code}]").into() });
			return Ok(Ok(false));
		},
	};
	let s = Substrings {
		matchvar:       (!bash).then_some(&b"MATCH"[..]),
		substravar:     Some(if bash {
			&b"BASH_REMATCH"[..]
		} else {
			&b"match"[..]
		}),
		want_offset:    false,
		matched_in_arr: bash,
		want_begin_end: !bash,
	};
	Ok(zx(ctx, |ex| get_substrings(ex, l, &groups, &s, ksh, utf8))?.map(|()| true))
}
