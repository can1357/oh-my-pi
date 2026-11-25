//! Unicode::Normalize: UAX #15 normalization forms and the character properties behind them.
//!
//! Decomposition, composition-pair, and combining-class data come from ICU4X; the algorithms
//! (canonical ordering, composition with blocking, quick checks, the "fast" FCD/FCC forms) follow
//! UAX #15 as the module documents them. Code points outside Unicode scalar values (surrogates,
//! values above U+10FFFF) are starters without decompositions.

use std::sync::LazyLock;

use icu_normalizer::{
	DecomposingNormalizerBorrowed,
	properties::{CanonicalCombiningClassMapBorrowed, CanonicalCompositionBorrowed, CanonicalDecompositionBorrowed, Decomposed},
};

use crate::perl::{
	interp::{Cx, Interp, NativeFn, PResult, Ret},
	value::{PStr, Sv, Value},
};

use super::{arg, export, export_tag, version};

const EXPORT: &[&str] = &["NFC", "NFD", "NFKC", "NFKD"];
const EXPORT_OK: &[&str] = &[
	"normalize", "decompose", "reorder", "compose", "checkNFD", "checkNFKD", "checkNFC", "checkNFKC", "check",
	"getCanon", "getCompat", "getComposite", "getCombinClass", "isExclusion", "isSingleton", "isNonStDecomp",
	"isComp2nd", "isNFC_MAYBE", "isNFKC_MAYBE", "FCD", "checkFCD", "FCC", "checkFCC", "composeContiguous",
	"splitOnLastStarter", "normalize_partial", "NFC_partial", "NFD_partial", "NFKC_partial", "NFKD_partial",
	"isComp_Ex", "isNFD_NO", "isNFC_NO", "isNFKD_NO", "isNFKC_NO",
];

/// Install Unicode::Normalize.
pub(super) fn load(interp: &mut Interp<'_>, module: &str) -> PResult<()> {
	version(interp, module, "1.28");
	let subs: &[(&str, NativeFn, &str)] = &[
		("NFD", |i, a, _| form(i, &a, Form::D), "$"), ("NFC", |i, a, _| form(i, &a, Form::C), "$"),
		("NFKD", |i, a, _| form(i, &a, Form::KD), "$"), ("NFKC", |i, a, _| form(i, &a, Form::KC), "$"),
		("FCD", |i, a, _| form(i, &a, Form::Fcd), "$"), ("FCC", |i, a, _| form(i, &a, Form::Fcc), "$"),
		("normalize", normalize, "$$"), ("check", check, "$$"),
		("decompose", decompose_sub, "$;$"), ("reorder", |i, a, _| map_str(i, &a, reorder), "$"),
		("compose", |i, a, _| map_str(i, &a, |s| compose(s, false)), "$"),
		("composeContiguous", |i, a, _| map_str(i, &a, |s| compose(s, true)), "$"),
		("checkNFD", |i, a, _| check_form(i, &a, Form::D), "$"), ("checkNFKD", |i, a, _| check_form(i, &a, Form::KD), "$"),
		("checkNFC", |i, a, _| check_form(i, &a, Form::C), "$"), ("checkNFKC", |i, a, _| check_form(i, &a, Form::KC), "$"),
		("checkFCD", |i, a, _| check_form(i, &a, Form::Fcd), "$"), ("checkFCC", |i, a, _| check_form(i, &a, Form::Fcc), "$"),
		("getCanon", |i, a, _| full_decomposition(i, &a, false), "$"), ("getCompat", |i, a, _| full_decomposition(i, &a, true), "$"),
		("getComposite", get_composite, "$$"),
		("getCombinClass", |i, a, _| Ok(Ret::One(Value::Int(i64::from(ccc(code_point(i, &a, 0)?))))), "$"),
		("isExclusion", |i, a, _| property(i, &a, is_exclusion), "$"),
		("isSingleton", |i, a, _| property(i, &a, is_singleton), "$"),
		("isNonStDecomp", |i, a, _| property(i, &a, is_non_starter_decomposition), "$"),
		("isComp2nd", |i, a, _| property(i, &a, is_comp2nd), "$"),
		("isNFC_MAYBE", |i, a, _| property(i, &a, is_comp2nd), "$"),
		("isNFKC_MAYBE", |i, a, _| property(i, &a, is_comp2nd), "$"),
		("isComp_Ex", |i, a, _| property(i, &a, |cp| composition_excluded(cp, false)), "$"),
		("isNFC_NO", |i, a, _| property(i, &a, |cp| composition_excluded(cp, false)), "$"),
		("isNFKC_NO", |i, a, _| property(i, &a, |cp| composition_excluded(cp, true)), "$"),
		("isNFD_NO", |i, a, _| property(i, &a, |cp| decomposition(cp, false).is_some()), "$"),
		("isNFKD_NO", |i, a, _| property(i, &a, |cp| decomposition(cp, true).is_some()), "$"),
		("splitOnLastStarter", split_on_last_starter, ""),
		("normalize_partial", normalize_partial, "$$"),
		("NFD_partial", |i, a, _| form_partial(i, &a, Form::D), "$"), ("NFC_partial", |i, a, _| form_partial(i, &a, Form::C), "$"),
		("NFKD_partial", |i, a, _| form_partial(i, &a, Form::KD), "$"), ("NFKC_partial", |i, a, _| form_partial(i, &a, Form::KC), "$"),
	];
	for &(name, f, prototype) in subs {
		let qualified = format!("{module}::{name}");
		if prototype.is_empty() { interp.define_native(&qualified, f); } else { interp.define_native_proto(&qualified, f, prototype); }
	}
	export(interp, module, EXPORT, EXPORT_OK);
	let all: Vec<&str> = EXPORT.iter().chain(EXPORT_OK).copied().collect();
	export_tag(interp, module, "all", &all);
	export_tag(interp, module, "normalize", &["NFC", "NFD", "NFKC", "NFKD", "normalize", "decompose", "reorder", "compose"]);
	export_tag(interp, module, "check", &["checkNFD", "checkNFKD", "checkNFC", "checkNFKC", "check"]);
	export_tag(interp, module, "fast", &["FCD", "checkFCD", "FCC", "checkFCC", "composeContiguous"]);
	Ok(())
}

#[derive(Clone, Copy)]
enum Form { C, D, KC, KD, Fcd, Fcc }

impl Form {
	fn named(name: &[u8]) -> Option<Self> {
		Some(match name {
			b"C" | b"NFC" => Self::C, b"D" | b"NFD" => Self::D, b"KC" | b"NFKC" => Self::KC, b"KD" | b"NFKD" => Self::KD,
			b"FCD" => Self::Fcd, b"FCC" => Self::Fcc,
			_ => return None,
		})
	}

	fn apply(self, s: &[u32]) -> Vec<u32> {
		match self {
			Self::D => reorder(&decompose(s, false)),
			Self::KD => reorder(&decompose(s, true)),
			Self::C => compose(&reorder(&decompose(s, false)), false),
			Self::KC => compose(&reorder(&decompose(s, true)), false),
			Self::Fcd => if quick_check(s, self) == Check::Yes { s.to_vec() } else { reorder(&decompose(s, false)) },
			Self::Fcc => compose(&reorder(&decompose(s, false)), true),
		}
	}
}

fn ccc(cp: u32) -> u8 { CanonicalCombiningClassMapBorrowed::new().get32_u8(cp) }

fn scalar(cp: u32) -> Option<char> { char::from_u32(cp) }

/// Full (recursive) decomposition of one code point, None when it is its own decomposition.
fn decomposition(cp: u32, compat: bool) -> Option<Vec<u32>> {
	let c = scalar(cp)?;
	let normalizer = if compat { DecomposingNormalizerBorrowed::new_nfkd() } else { DecomposingNormalizerBorrowed::new_nfd() };
	let mut buf = [0u8; 4];
	let text: &str = c.encode_utf8(&mut buf);
	let decomposed = normalizer.normalize(text);
	(decomposed != text).then(|| decomposed.chars().map(u32::from).collect())
}

fn decompose(s: &[u32], compat: bool) -> Vec<u32> {
	let mut out = Vec::with_capacity(s.len());
	for &cp in s {
		match decomposition(cp, compat) { Some(parts) => out.extend(parts), None => out.push(cp) }
	}
	out
}

/// Canonical ordering: stable sort of each run of non-starters by combining class.
fn reorder(s: &[u32]) -> Vec<u32> {
	let mut out = s.to_vec();
	let mut start = 0;
	while start < out.len() {
		if ccc(out[start]) == 0 { start += 1; continue; }
		let end = out[start..].iter().position(|&cp| ccc(cp) == 0).map_or(out.len(), |n| start + n);
		out[start..end].sort_by_key(|&cp| ccc(cp));
		start = end;
	}
	out
}

fn compose_pair(starter: u32, second: u32) -> Option<u32> {
	CanonicalCompositionBorrowed::new().compose(scalar(starter)?, scalar(second)?).map(u32::from)
}

/// Canonical composition. `contiguous` composes only a character directly following the
/// (possibly already composed) starter, as Unicode::Normalize's composeContiguous does.
fn compose(s: &[u32], contiguous: bool) -> Vec<u32> {
	let mut out: Vec<u32> = Vec::with_capacity(s.len());
	let mut starter: Option<usize> = None;
	let mut last_cc = 0u8;
	for &cp in s {
		let cc = ccc(cp);
		if let Some(at) = starter {
			let adjacent = at + 1 == out.len();
			let unblocked = adjacent || (!contiguous && last_cc != 0 && last_cc < cc);
			if unblocked && let Some(composite) = compose_pair(out[at], cp) {
				out[at] = composite;
				continue;
			}
		}
		if cc == 0 { starter = Some(out.len()); }
		last_cc = cc;
		out.push(cp);
	}
	out
}

fn canonical_pair(cp: u32) -> Option<(u32, u32)> {
	match CanonicalDecompositionBorrowed::new().decompose(scalar(cp)?) {
		Decomposed::Expansion(first, second) => Some((u32::from(first), u32::from(second))),
		_ => None,
	}
}

fn is_singleton(cp: u32) -> bool {
	scalar(cp).is_some_and(|c| matches!(CanonicalDecompositionBorrowed::new().decompose(c), Decomposed::Singleton(_)))
}

fn is_non_starter_decomposition(cp: u32) -> bool {
	ccc(cp) == 0 && decomposition(cp, false).is_some_and(|parts| parts.first().is_some_and(|&first| ccc(first) != 0))
}

/// Listed in CompositionExclusions.txt: a starter's two-character canonical decomposition that
/// does not recompose (singletons and non-starter decompositions are separate properties).
fn is_exclusion(cp: u32) -> bool {
	canonical_pair(cp).is_some_and(|(first, second)| {
		!is_non_starter_decomposition(cp) && ccc(cp) == 0 && compose_pair(first, second) != Some(cp)
	})
}

/// Characters that can be the second of a primary composite pair, sorted.
static COMPOSITE_SECONDS: LazyLock<Vec<u32>> = LazyLock::new(|| {
	let mut seconds: Vec<u32> = (0..=0x10FFFF)
		.filter_map(|cp| canonical_pair(cp).filter(|&(first, second)| compose_pair(first, second) == Some(cp)).map(|(_, second)| second))
		.collect();
	seconds.sort_unstable();
	seconds.dedup();
	seconds
});

fn is_comp2nd(cp: u32) -> bool { COMPOSITE_SECONDS.binary_search(&cp).is_ok() }

fn composition_excluded(cp: u32, compat: bool) -> bool {
	if is_exclusion(cp) || is_singleton(cp) || is_non_starter_decomposition(cp) { return true; }
	compat && decomposition(cp, true).is_some_and(|compat| decomposition(cp, false).is_none_or(|canon| canon != compat))
}

#[derive(PartialEq, Eq)]
enum Check { Yes, No, Maybe }

fn quick_check(s: &[u32], form: Form) -> Check {
	let mut previous = 0u8;
	let mut maybe = false;
	for &cp in s {
		let decomposed = matches!(form, Form::Fcd | Form::Fcc).then(|| decomposition(cp, false)).flatten();
		let current = ccc(decomposed.as_ref().and_then(|d| d.first().copied()).unwrap_or(cp));
		if current != 0 && current < previous { return Check::No; }
		match form {
			Form::D | Form::KD => if decomposition(cp, matches!(form, Form::KD)).is_some() { return Check::No; },
			Form::C | Form::KC | Form::Fcc => {
				if composition_excluded(cp, matches!(form, Form::KC)) { return Check::No; }
				if is_comp2nd(cp) { maybe = true; }
			},
			Form::Fcd => {},
		}
		previous = decomposed.as_ref().and_then(|d| d.last().copied()).map_or(current, ccc);
	}
	if maybe { Check::Maybe } else { Check::Yes }
}

fn code_points(interp: &mut Interp<'_>, args: &[Sv], index: usize) -> PResult<Vec<u32>> {
	let value = arg(args, index);
	Ok(interp.stringify(&value)?.chars().collect())
}

fn code_point(interp: &mut Interp<'_>, args: &[Sv], index: usize) -> PResult<u32> {
	let value = arg(args, index);
	Ok(interp.numify(&value)?.to_u64().min(u64::from(u32::MAX)) as u32)
}

fn string(cps: &[u32]) -> Value {
	let mut s = PStr::from_codepoints(cps.iter().copied());
	s.upgrade();
	Value::Str(s)
}

fn form(interp: &mut Interp<'_>, args: &[Sv], form: Form) -> PResult<Ret> {
	let s = code_points(interp, args, 0)?;
	Ok(Ret::One(string(&form.apply(&s))))
}

fn map_str(interp: &mut Interp<'_>, args: &[Sv], f: impl FnOnce(&[u32]) -> Vec<u32>) -> PResult<Ret> {
	let s = code_points(interp, args, 0)?;
	Ok(Ret::One(string(&f(&s))))
}

fn decompose_sub(interp: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let s = code_points(interp, &args, 0)?;
	let compat = interp.truthy(&arg(&args, 1))?;
	Ok(Ret::One(string(&decompose(&s, compat))))
}

fn named_form(interp: &mut Interp<'_>, args: &[Sv], function: &str) -> PResult<Form> {
	let name = interp.stringify(&arg(args, 0))?;
	Form::named(&name.bytes).ok_or_else(|| interp.die_msg(format!("Unicode::Normalize::{function}: Invalid form name: {}", name.to_string_lossy())))
}

fn normalize(interp: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let form = named_form(interp, &args, "normalize")?;
	let s = code_points(interp, &args, 1)?;
	Ok(Ret::One(string(&form.apply(&s))))
}

fn check_result(result: Check) -> Ret {
	Ret::One(match result { Check::Yes => Value::Int(1), Check::No => Value::str(""), Check::Maybe => Value::Undef })
}

fn check(interp: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let form = named_form(interp, &args, "check")?;
	let s = code_points(interp, &args, 1)?;
	Ok(check_result(quick_check(&s, form)))
}

fn check_form(interp: &mut Interp<'_>, args: &[Sv], form: Form) -> PResult<Ret> {
	let s = code_points(interp, args, 0)?;
	Ok(check_result(quick_check(&s, form)))
}

fn full_decomposition(interp: &mut Interp<'_>, args: &[Sv], compat: bool) -> PResult<Ret> {
	let cp = code_point(interp, args, 0)?;
	Ok(Ret::One(decomposition(cp, compat).map_or(Value::Undef, |parts| string(&parts))))
}

fn get_composite(interp: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let first = code_point(interp, &args, 0)?;
	let second = code_point(interp, &args, 1)?;
	Ok(Ret::One(compose_pair(first, second).map_or(Value::Undef, |cp| Value::Int(i64::from(cp)))))
}

fn property(interp: &mut Interp<'_>, args: &[Sv], test: impl FnOnce(u32) -> bool) -> PResult<Ret> {
	let cp = code_point(interp, args, 0)?;
	Ok(Ret::One(if test(cp) { Value::Int(1) } else { Value::str("") }))
}

/// Split before the last starter: (processed, unprocessed).
fn split_last_starter(s: &[u32]) -> (&[u32], &[u32]) {
	let at = s.iter().rposition(|&cp| ccc(cp) == 0).unwrap_or(0);
	s.split_at(at)
}

fn split_on_last_starter(interp: &mut Interp<'_>, args: Vec<Sv>, cx: Cx) -> PResult<Ret> {
	let s = code_points(interp, &args, 0)?;
	let (head, tail) = split_last_starter(&s);
	let values = vec![string(head), string(tail)];
	Ok(if cx == Cx::List { Ret::Many(values) } else { Ret::One(string(tail)) })
}

/// Normalizes the string held in `target`, leaves the part after the last starter there for the
/// next chunk, and returns the finished part.
fn partial(interp: &mut Interp<'_>, target: Option<&Sv>, form: Form) -> PResult<Ret> {
	let value = target.map_or(Value::Undef, |sv| sv.get());
	let s: Vec<u32> = interp.stringify(&value)?.chars().collect();
	let normalized = form.apply(&s);
	let (head, tail) = split_last_starter(&normalized);
	if let Some(sv) = target { sv.set(string(tail)); }
	Ok(Ret::One(string(head)))
}

fn normalize_partial(interp: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let form = named_form(interp, &args, "normalize_partial")?;
	partial(interp, args.get(1), form)
}

fn form_partial(interp: &mut Interp<'_>, args: &[Sv], form: Form) -> PResult<Ret> { partial(interp, args.first(), form) }
