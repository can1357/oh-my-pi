//! zsh/langinfo: the `langinfo` association (`nl_langinfo` items of the
//! shell's locale).
//!
//! Ported from zsh 5.9 `Src/Modules/langinfo.c` (MIT-style licence,
//! Copyright (c) 1992-1997 Paul Falstad and the zsh development group).
//!
//! The values are the C library's ([`crate::sys::langinfo`]); each item
//! follows its own category (`LC_ALL` > `LC_<category>` > `LANG`).

use bstr::BString;

use crate::{
	bash::{
		diag::Diag,
		vm::{
			expand::{Expander, Stop, X},
			zsh::params::{self, PValue},
		},
	},
	sys::langinfo::{self as sys, Category as Cat},
};

/// zsh's `nl_names` in order, with their category.
const ITEMS: &[(&str, Cat)] = &[
	("CODESET", Cat::Ctype),
	("D_T_FMT", Cat::Time),
	("D_FMT", Cat::Time),
	("T_FMT", Cat::Time),
	("RADIXCHAR", Cat::Numeric),
	("THOUSEP", Cat::Numeric),
	("YESEXPR", Cat::Messages),
	("NOEXPR", Cat::Messages),
	("CRNCYSTR", Cat::Monetary),
	("ABDAY_1", Cat::Time),
	("ABDAY_2", Cat::Time),
	("ABDAY_3", Cat::Time),
	("ABDAY_4", Cat::Time),
	("ABDAY_5", Cat::Time),
	("ABDAY_6", Cat::Time),
	("ABDAY_7", Cat::Time),
	("DAY_1", Cat::Time),
	("DAY_2", Cat::Time),
	("DAY_3", Cat::Time),
	("DAY_4", Cat::Time),
	("DAY_5", Cat::Time),
	("DAY_6", Cat::Time),
	("DAY_7", Cat::Time),
	("ABMON_1", Cat::Time),
	("ABMON_2", Cat::Time),
	("ABMON_3", Cat::Time),
	("ABMON_4", Cat::Time),
	("ABMON_5", Cat::Time),
	("ABMON_6", Cat::Time),
	("ABMON_7", Cat::Time),
	("ABMON_8", Cat::Time),
	("ABMON_9", Cat::Time),
	("ABMON_10", Cat::Time),
	("ABMON_11", Cat::Time),
	("ABMON_12", Cat::Time),
	("MON_1", Cat::Time),
	("MON_2", Cat::Time),
	("MON_3", Cat::Time),
	("MON_4", Cat::Time),
	("MON_5", Cat::Time),
	("MON_6", Cat::Time),
	("MON_7", Cat::Time),
	("MON_8", Cat::Time),
	("MON_9", Cat::Time),
	("MON_10", Cat::Time),
	("MON_11", Cat::Time),
	("MON_12", Cat::Time),
	("T_FMT_AMPM", Cat::Time),
	("AM_STR", Cat::Time),
	("PM_STR", Cat::Time),
	("ERA", Cat::Time),
	("ERA_D_FMT", Cat::Time),
	("ERA_D_T_FMT", Cat::Time),
	("ERA_T_FMT", Cat::Time),
	("ALT_DIGITS", Cat::Time),
];

/// The locale name of category `cat`: the first of `LC_ALL`, `LC_<cat>`
/// and `LANG` that is set and non-empty (empty: none, the `C` locale).
///
/// # Errors
/// A store failure.
pub fn locale_name(ex: &mut Expander<'_, '_>, cat: Cat) -> X<BString> {
	let var: &[u8] = match cat {
		Cat::Ctype => b"LC_CTYPE",
		Cat::Time => b"LC_TIME",
		Cat::Numeric => b"LC_NUMERIC",
		Cat::Messages => b"LC_MESSAGES",
		Cat::Monetary => b"LC_MONETARY",
	};
	for v in [&b"LC_ALL"[..], var, b"LANG"] {
		if let Some(s) = params::getsparam(ex, v)?
			&& !s.is_empty()
		{
			return Ok(s);
		}
	}
	Ok(BString::default())
}

/// zsh `scanlanginfo`: the association, in zsh's order.
///
/// # Errors
/// A target without the C library's locale data, a store failure.
pub fn scan(ex: &mut Expander<'_, '_>) -> X<Option<PValue>> {
	let mut out = Vec::with_capacity(ITEMS.len());
	for &(name, cat) in ITEMS {
		let loc = locale_name(ex, cat)?;
		let Some(value) = sys::langinfo(&loc, cat, name) else {
			return Err(Stop::Fail(Diag::Unsupported {
				what: format!("$langinfo[{name}] on this platform").into(),
			}));
		};
		out.push((BString::from(name), BString::from(value)));
	}
	Ok(Some(PValue::Hash(out)))
}
