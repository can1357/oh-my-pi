//! zsh/computil: the builtins compsys' shell functions use to parse
//! specifications and keep state between calls (`comparguments`,
//! `compvalues`, `compdescribe`, `comptags`, `comptry`, `compfiles`,
//! `compgroups`, `compquote`).
//!
//! Ported from zsh 5.9 `Src/Zle/computil.c` (MIT-style licence, Copyright
//! (c) 1999 Sven Wischnowsky and the zsh development group).
//!
//! zsh keeps the parsed state of the last `comparguments -i`,
//! `compvalues -i`, `compdescribe -i` and the tag sets of `comptags` in C
//! statics between calls; here each lives in the store as a postcard
//! record ([`MiscKey::ZshCompArguments`], [`MiscKey::ZshCompValues`],
//! [`MiscKey::ZshCompDescribe`], [`MiscKey::ZshCompTags`]) so subshells
//! and re-runs of a builtin see it. A builtin writes its state only after
//! every probe it needs was answered, so a re-run from scratch repeats
//! the same writes.

use bstr::BString;
use serde::{Serialize, de::DeserializeOwned};

use crate::bash::{
	store::{Key, KeyBuf, MiscKey, Record},
	syntax::zsh::tok::{metafy, unmetafy},
	vm::{
		builtins::{Control, Ctx, Need, Outcome, R, done, zsh_args::zx},
		expand::{Expander, X},
		zsh::{params, text::QuoteOpts},
	},
	zshopt::ZshOpt,
};

mod args;
mod describe;
mod files;
mod quote;
mod tags;
mod values;

pub use args::comparguments;
pub use describe::compdescribe;
pub use files::{compfiles, compgroups};
pub use quote::compquote;
pub use tags::{comptags, comptry};
pub use values::compvalues;

// ---- shared helpers
// ------------------------------------------------------------------

/// The builtin's status, abandoning the rest of the command line after a
/// zsh error (`errflag`) it reported.
#[allow(clippy::unnecessary_wraps, reason = "a handler's result")]
pub(super) const fn fin(status: i32, failed: bool) -> R {
	Ok(Outcome {
		status,
		control: if failed {
			Control::DiscardAll
		} else {
			Control::None
		},
	})
}

/// zsh `zwarnnam(nam, msg)`: `NAME: msg` on stderr; the builtin's status
/// is 1.
#[allow(clippy::unnecessary_wraps, reason = "a handler's result: `return warn(ctx, …)` ends it")]
pub(super) fn warn(ctx: &mut Ctx<'_, '_>, msg: impl Into<std::borrow::Cow<'static, str>>) -> R {
	ctx.usage(msg);
	done(1)
}

/// Run parameter code; a zsh error is reported once (zsh's `zerr` is quiet
/// while `errflag` is set) and marks the builtin failed.
pub(super) fn px<T>(
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
pub(super) fn setsparam(
	ctx: &mut Ctx<'_, '_>,
	failed: &mut bool,
	name: &[u8],
	val: &[u8],
) -> Result<(), Need> {
	px(ctx, failed, |ex| params::assignsparam(ex, name, val, 0))?;
	Ok(())
}

/// zsh `setaparam`.
pub(super) fn setaparam(
	ctx: &mut Ctx<'_, '_>,
	failed: &mut bool,
	name: &[u8],
	val: Vec<BString>,
) -> Result<(), Need> {
	px(ctx, failed, |ex| params::assignaparam(ex, name, val, 0))?;
	Ok(())
}

/// zsh `sethparam`: `kv` alternates keys and values.
pub(super) fn sethparam(
	ctx: &mut Ctx<'_, '_>,
	failed: &mut bool,
	name: &[u8],
	kv: &[BString],
) -> Result<(), Need> {
	px(ctx, failed, |ex| params::sethparam(ex, name, kv))?;
	Ok(())
}

/// zsh `getaparam`: the array parameter `name` (`None` when unset or not
/// an array).
pub(super) fn getaparam(
	ctx: &mut Ctx<'_, '_>,
	failed: &mut bool,
	name: &[u8],
) -> Result<Option<Vec<BString>>, Need> {
	Ok(px(ctx, failed, |ex| params::getaparam(ex, name))?.flatten())
}

/// zsh's `incompfunc != 1` test every builtin of the module starts with:
/// `false` after `NAME: can only be called from completion function`.
pub(super) fn gate(ctx: &mut Ctx<'_, '_>) -> bool {
	if super::incompfunc(ctx.vp) == 1 {
		return true;
	}
	ctx.usage("can only be called from completion function");
	false
}

/// zsh `compwords`: the `words` special of the completion function.
pub(super) fn compwords(ctx: &mut Ctx<'_, '_>, failed: &mut bool) -> Result<Vec<BString>, Need> {
	Ok(getaparam(ctx, failed, b"words")?.unwrap_or_default())
}

/// zsh `compcurrent`: `$CURRENT`.
pub(super) fn compcurrent(ctx: &mut Ctx<'_, '_>, failed: &mut bool) -> Result<i64, Need> {
	Ok(getsparam(ctx, failed, b"CURRENT")?.map_or(0, |s| atoi(&s)))
}

/// A scalar completion special (`PREFIX`, `SUFFIX`, `IPREFIX`, …).
pub(super) fn compstr(
	ctx: &mut Ctx<'_, '_>,
	failed: &mut bool,
	name: &[u8],
) -> Result<BString, Need> {
	Ok(getsparam(ctx, failed, name)?.unwrap_or_default())
}

/// zsh `ignore_prefix(l)`: move the first `l` bytes of `PREFIX` to the
/// end of `IPREFIX`.
pub(super) fn ignore_prefix(
	ctx: &mut Ctx<'_, '_>,
	failed: &mut bool,
	l: usize,
) -> Result<(), Need> {
	if l == 0 {
		return Ok(());
	}
	let pre = compstr(ctx, failed, b"PREFIX")?;
	let l = l.min(pre.len());
	let mut ipre = compstr(ctx, failed, b"IPREFIX")?;
	ipre.extend_from_slice(&pre[..l]);
	setsparam(ctx, failed, b"IPREFIX", &ipre)?;
	setsparam(ctx, failed, b"PREFIX", &pre[l..])
}

/// zsh `ignore_suffix(l)`: move the last `l` bytes of `SUFFIX` to the
/// start of `ISUFFIX`.
pub(super) fn ignore_suffix(
	ctx: &mut Ctx<'_, '_>,
	failed: &mut bool,
	l: usize,
) -> Result<(), Need> {
	if l == 0 {
		return Ok(());
	}
	let suf = compstr(ctx, failed, b"SUFFIX")?;
	let l = suf.len().saturating_sub(l);
	let mut isuf = BString::from(&suf[l..]);
	isuf.extend_from_slice(&compstr(ctx, failed, b"ISUFFIX")?);
	setsparam(ctx, failed, b"ISUFFIX", &isuf)?;
	setsparam(ctx, failed, b"SUFFIX", &suf[..l])
}

/// zsh `getsparam`.
pub(super) fn getsparam(
	ctx: &mut Ctx<'_, '_>,
	failed: &mut bool,
	name: &[u8],
) -> Result<Option<BString>, Need> {
	Ok(px(ctx, failed, |ex| params::getsparam(ex, name))?.flatten())
}

/// zsh `get_user_var` ([`super::compcore::get_user_var`]) on unmetafied
/// names and words.
pub(super) fn get_user_var(
	ctx: &mut Ctx<'_, '_>,
	failed: &mut bool,
	nam: &[u8],
) -> Result<Option<Vec<BString>>, Need> {
	let meta = metafy(nam);
	let r = px(ctx, failed, |ex| super::compcore::get_user_var(ex, Some(&meta)))?.flatten();
	Ok(r.map(|v| v.into_iter().map(|w| BString::from(unmetafy(&w))).collect()))
}

/// The options zsh's `quotestring` reads.
pub(super) fn quote_opts(ctx: &mut Ctx<'_, '_>) -> Result<QuoteOpts, Need> {
	let (bang, bang_special) = params::bang_quoting(&mut ctx.k.root, ctx.cx.store, ctx.vp);
	Ok(QuoteOpts {
		rcquotes: ctx.zsh_option(ZshOpt::Rcquotes)?,
		magic_equal_subst: ctx.zsh_option(ZshOpt::Magicequalsubst)?,
		extended_glob: ctx.zsh_option(ZshOpt::Extendedglob)?,
		bang,
		bang_special,
		mb: params::mb_quiet(ctx.k, ctx.cx.store, ctx.vp),
	})
}

/// zsh's `atoi`: leading blanks, an optional sign, then decimal digits;
/// 0 when there are none.
pub(super) fn atoi(s: &[u8]) -> i64 {
	let mut i = 0;
	while i < s.len() && matches!(s[i], b' ' | b'\t' | b'\n' | b'\r' | 0x0b | 0x0c) {
		i += 1;
	}
	let neg = match s.get(i) {
		Some(b'-') => {
			i += 1;
			true
		},
		Some(b'+') => {
			i += 1;
			false
		},
		_ => false,
	};
	let mut n: i64 = 0;
	while let Some(d) = s.get(i).filter(|c| c.is_ascii_digit()) {
		n = n.wrapping_mul(10).wrapping_add(i64::from(d - b'0'));
		i += 1;
	}
	if neg { n.wrapping_neg() } else { n }
}

/// zsh `rembslash`: drop each backslash, keeping the character after it.
pub(super) fn rembslash(s: &[u8]) -> BString {
	let mut out = Vec::with_capacity(s.len());
	let mut i = 0;
	while i < s.len() {
		if s[i] == b'\\' && i + 1 < s.len() {
			i += 1;
		} else if s[i] == b'\\' {
			// A trailing backslash goes (zsh copies the terminating NUL).
			break;
		}
		out.push(s[i]);
		i += 1;
	}
	out.into()
}

// ---- state records
// ------------------------------------------------------------------

/// The state record `key` (`None` when absent or unreadable).
pub(super) fn load<T: DeserializeOwned>(
	ctx: &mut Ctx<'_, '_>,
	key: MiscKey,
) -> Result<Option<T>, Need> {
	Ok(match ctx.record(Key::Misc(key))? {
		Some(Record::Misc(b)) => postcard::from_bytes(&b).ok(),
		_ => None,
	})
}

/// Store (or with `None` drop) the state record `key`.
pub(super) fn save<T: Serialize>(ctx: &mut Ctx<'_, '_>, key: MiscKey, val: Option<&T>) {
	let rec = val
		.and_then(|v| postcard::to_allocvec(v).ok())
		.map(|b| Record::Misc(b.into()));
	ctx.store_record(KeyBuf::Misc(key), rec);
}

/// zsh/computil's `finish_`: unloading the module drops the parsed
/// definitions and the tag sets.
pub fn finish(ctx: &mut Ctx<'_, '_>) {
	for key in [
		MiscKey::ZshCompArguments,
		MiscKey::ZshCompValues,
		MiscKey::ZshCompDescribe,
		MiscKey::ZshCompTags,
	] {
		ctx.store_record(KeyBuf::Misc(key), None);
	}
}
