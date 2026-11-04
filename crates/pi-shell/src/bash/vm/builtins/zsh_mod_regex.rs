//! zsh/regex: the `-regex-match` condition, which `[[ s =~ re ]]` is
//! unless `REMATCH_PCRE` is set.
//!
//! The pattern goes to the C library's `regcomp(REG_EXTENDED)` as in zsh
//! ([`crate::sys::regex`]), so groups, escapes and error texts are the
//! system's.
//!
//! Ported from zsh 5.9 `Src/Modules/regex.c` (MIT-style licence, Copyright
//! (c) 1992-1997 Paul Falstad and the zsh development group).

use core::ops::Range;

use bstr::BString;

use super::{Ctx, Need, zsh_args::zx};
use crate::{
	bash::{
		diag::Diag,
		vm::{
			locale::{self, Charset},
			zsh::{math::Number, params},
		},
		zshopt::ZshOpt,
	},
	sys::regex::{RegexFail, ere_match},
};

/// The number of characters in `s` as zsh's `MB_CHARLEN` loop counts them:
/// UTF-8 characters with `utf8` (a byte that starts none counts as one),
/// else bytes.
pub fn mb_count(s: &[u8], utf8: bool) -> i64 {
	let n = if utf8 {
		let mut n = 0usize;
		let mut i = 0;
		while i < s.len() {
			i += locale::char_len(Charset::Utf8, &s[i..], false).unwrap_or(1);
			n += 1;
		}
		n
	} else {
		s.len()
	};
	i64::try_from(n).unwrap_or(i64::MAX)
}

/// The characters of `s` before byte `start` and from there to `end`
/// (zsh counts the two stretches separately).
fn char_span(s: &[u8], g: &Range<usize>, utf8: bool) -> (i64, i64) {
	(
		mb_count(s.get(..g.start).unwrap_or_default(), utf8),
		mb_count(s.get(g.clone()).unwrap_or_default(), utf8),
	)
}

/// The text of group `g` of `s` (empty for an unset group).
fn group_text(s: &[u8], g: Option<&Range<usize>>) -> BString {
	BString::from(g.and_then(|g| s.get(g.clone())).unwrap_or_default())
}

/// zsh `zcond_regex_match` (`l -regex-match r`): an ERE match of `l`
/// against `r` (case ignored without `CASE_MATCH`) that sets `MATCH
/// MBEGIN MEND` and, when `r` has groups, `match mbegin mend`; or
/// `BASH_REMATCH` under `BASH_REMATCH`. A pattern that does not compile
/// warns and is false. `Ok(Err(d))` is a parameter error (`zerr`).
///
/// # Errors
/// A probe or store access to run first.
pub fn cond_regex_match(
	ctx: &mut Ctx<'_, '_>,
	l: &[u8],
	r: &[u8],
) -> Result<Result<bool, Diag>, Need> {
	let icase = !ctx.zsh_option(ZshOpt::Casematch)?;
	let utf8_locale = locale::is_utf8(ctx.k, ctx.cx.store, ctx.vp);
	let groups = match ere_match(r, l, icase, utf8_locale) {
		Ok(Some(groups)) => groups,
		Ok(None) => return Ok(Ok(false)),
		Err(RegexFail::Compile(msg)) => {
			ctx.diag(Diag::Usage { msg: format!("failed to compile regex: {msg}").into() });
			return Ok(Ok(false));
		},
		Err(RegexFail::Exec(msg)) => {
			ctx.diag(Diag::Usage { msg: format!("regex matching error: {msg}").into() });
			return Ok(Ok(false));
		},
	};
	// The subject as the C library saw it: up to its first NUL.
	let l = l.iter().position(|&c| c == 0).map_or(l, |n| &l[..n]);
	let bash = ctx.zsh_option(ZshOpt::Bashrematch)?;
	let ksh = i64::from(!ctx.zsh_option(ZshOpt::Ksharrays)?);
	let utf8 = super::zsh_print::charset(ctx)?.utf8;
	let r = zx(ctx, |ex| {
		if bash {
			let arr = groups.iter().map(|g| group_text(l, g.as_ref())).collect();
			return params::assignaparam(ex, b"BASH_REMATCH", arr, 0);
		}
		let whole = groups.first().cloned().flatten().unwrap_or(0..0);
		params::assignsparam(ex, b"MATCH", &group_text(l, Some(&whole)), 0)?;
		let (before, inside) = char_span(l, &whole, utf8);
		let mbegin = before + ksh;
		let mend = before + inside + ksh - 1;
		params::setnparam(ex, b"MBEGIN", Number::Int(mbegin), mbegin.to_string().as_bytes(), 10)?;
		params::setnparam(ex, b"MEND", Number::Int(mend), mend.to_string().as_bytes(), 10)?;
		let subs = groups.get(1..).unwrap_or_default();
		if !subs.is_empty() {
			let arr = subs.iter().map(|g| group_text(l, g.as_ref())).collect();
			let mut mbegin = Vec::with_capacity(subs.len());
			let mut mend = Vec::with_capacity(subs.len());
			for g in subs {
				if let Some(g) = g {
					let (before, inside) = char_span(l, g, utf8);
					mbegin.push(BString::from((before + ksh).to_string()));
					mend.push(BString::from((before + inside + ksh - 1).to_string()));
				} else {
					mbegin.push(BString::from("-1"));
					mend.push(BString::from("-1"));
				}
			}
			params::assignaparam(ex, b"match", arr, 0)?;
			params::assignaparam(ex, b"mbegin", mbegin, 0)?;
			params::assignaparam(ex, b"mend", mend, 0)?;
		}
		Ok(())
	})?;
	Ok(r.map(|()| true))
}
