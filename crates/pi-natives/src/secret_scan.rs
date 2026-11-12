//! Prefilter for the coding agent's outbound secret redaction.
//!
//! The agent redacts configured literal secrets and regex rules from every
//! text it sends to a model. Running each JavaScript rule over each text costs
//! one regex pass per rule; this module answers, in about one pass, which
//! texts need any redaction work at all and which rules can match them.
//!
//! Each rule arrives as a Rust pattern matching a superset of the JavaScript
//! rule (see `regex-prefilter.ts`). From it a set of *necessary factors* is
//! extracted: literals at least one of which every match contains. One
//! Aho-Corasick automaton holds every rule's factors together with the
//! configured literals and `$$`; a scan runs it once over the text, and only a
//! rule whose factor occurred (or that has none) runs its regex to confirm.
//! Answers are therefore supersets: a rule not reported cannot match the text.

use aho_corasick::{AhoCorasick, AhoCorasickKind, MatchKind};
use napi::{Error, Status};
use napi_derive::napi;
use rayon::prelude::*;
use regex::{Regex, RegexBuilder};
use regex_syntax::hir::{Class, Hir, HirKind};

/// Compiled-program size cap per rule; a rule over it is left to JavaScript.
const SIZE_LIMIT: usize = 32 << 20;
/// Largest literal set kept for one node while extracting factors.
const MAX_SEQ: usize = 64;
/// Largest class expanded into literal alternatives.
const MAX_CLASS: usize = 16;
/// Shortest factor worth a prefilter hit; shorter sets leave the rule
/// unfiltered.
const MIN_FACTOR: usize = 2;

/// Finite set of byte strings, ASCII-lower-cased: matched
/// ASCII-case-insensitively.
type Seq = Vec<Vec<u8>>;

fn dedup(mut seq: Seq) -> Option<Seq> {
	seq.sort();
	seq.dedup();
	(seq.len() <= MAX_SEQ).then_some(seq)
}

fn cross(a: &Seq, b: &Seq) -> Option<Seq> {
	if a.len().saturating_mul(b.len()) > MAX_SEQ {
		return None;
	}
	let mut out = Vec::with_capacity(a.len() * b.len());
	for x in a {
		for y in b {
			let mut v = x.clone();
			v.extend_from_slice(y);
			out.push(v);
		}
	}
	dedup(out)
}

/// The ASCII chars a class stands for, lower-cased, when it is small. Unicode
/// case folding adds KELVIN SIGN, LONG S and ANGSTROM SIGN to `k`, `s` and
/// `å`; without `unicode_case` the JavaScript rule cannot match them, so they
/// are ignored, and any other non-ASCII member makes the class unusable.
fn class_chars(class: &Class, unicode_case: bool) -> Option<Vec<u8>> {
	let mut chars: Vec<u32> = Vec::new();
	match class {
		Class::Unicode(u) => {
			for r in u.iter() {
				let (lo, hi) = (u32::from(r.start()), u32::from(r.end()));
				if hi - lo > MAX_CLASS as u32 {
					return None;
				}
				chars.extend(lo..=hi);
			}
		},
		Class::Bytes(b) => {
			for r in b.iter() {
				if usize::from(r.end() - r.start()) > MAX_CLASS {
					return None;
				}
				chars.extend(u32::from(r.start())..=u32::from(r.end()));
			}
		},
	}
	let fold_variant = |c: u32| !unicode_case && matches!(c, 0x212a | 0x017f | 0x212b);
	if chars.iter().any(|&c| c >= 0x80 && !fold_variant(c)) {
		return None;
	}
	#[allow(clippy::cast_possible_truncation, reason = "filtered to ASCII")]
	let mut lowered: Vec<u8> = chars
		.iter()
		.filter(|&&c| c < 0x80)
		.map(|&c| (c as u8).to_ascii_lowercase())
		.collect();
	lowered.sort_unstable();
	lowered.dedup();
	(!lowered.is_empty() && lowered.len() <= MAX_CLASS).then_some(lowered)
}

/// Every string `h` matches, when that set is small and finite.
fn exact(h: &Hir, unicode_case: bool) -> Option<Seq> {
	match h.kind() {
		HirKind::Empty | HirKind::Look(_) => Some(vec![Vec::new()]),
		HirKind::Literal(lit) => Some(vec![lit.0.to_ascii_lowercase()]),
		HirKind::Class(class) => {
			class_chars(class, unicode_case).map(|chars| chars.into_iter().map(|c| vec![c]).collect())
		},
		HirKind::Capture(cap) => exact(&cap.sub, unicode_case),
		HirKind::Concat(subs) => {
			let mut acc: Seq = vec![Vec::new()];
			for sub in subs {
				acc = cross(&acc, &exact(sub, unicode_case)?)?;
			}
			Some(acc)
		},
		HirKind::Alternation(subs) => {
			let mut out = Vec::new();
			for sub in subs {
				out.extend(exact(sub, unicode_case)?);
				if out.len() > MAX_SEQ {
					return None;
				}
			}
			dedup(out)
		},
		HirKind::Repetition(rep) => {
			let max = rep.max?;
			if max != rep.min || max > 8 {
				return None;
			}
			let one = exact(&rep.sub, unicode_case)?;
			let mut acc: Seq = vec![Vec::new()];
			for _ in 0..max {
				acc = cross(&acc, &one)?;
			}
			Some(acc)
		},
	}
}

fn usable(seq: Seq) -> Option<Seq> {
	(!seq.is_empty() && seq.iter().all(|s| s.len() >= MIN_FACTOR)).then_some(seq)
}

/// Ranks factor sets: longer shortest member first, then fewer members.
fn score(seq: &Seq) -> (usize, usize) {
	(seq.iter().map(Vec::len).min().unwrap_or(0), usize::MAX - seq.len())
}

/// Literals at least one of which every match of `h` contains, or `None`.
fn necessary_factors(h: &Hir, unicode_case: bool) -> Option<Seq> {
	if let Some(seq) = exact(h, unicode_case) {
		return usable(seq);
	}
	match h.kind() {
		HirKind::Capture(cap) => necessary_factors(&cap.sub, unicode_case),
		HirKind::Repetition(rep) if rep.min >= 1 => necessary_factors(&rep.sub, unicode_case),
		HirKind::Alternation(subs) => {
			let mut out = Vec::new();
			for sub in subs {
				out.extend(necessary_factors(sub, unicode_case)?);
			}
			dedup(out).and_then(usable)
		},
		HirKind::Concat(subs) => {
			let mut best: Option<Seq> = None;
			let mut consider = |candidate: Option<Seq>| {
				if let Some(c) = candidate.and_then(usable)
					&& best.as_ref().is_none_or(|b| score(&c) > score(b))
				{
					best = Some(c);
				}
			};
			for sub in subs {
				consider(necessary_factors(sub, unicode_case));
			}
			// Runs of consecutive finite children spell longer literals.
			for start in 0..subs.len() {
				let mut run: Option<Seq> = None;
				for sub in &subs[start..] {
					let Some(next) = exact(sub, unicode_case) else {
						break;
					};
					let joined = match &run {
						None => Some(next),
						Some(prefix) => cross(prefix, &next),
					};
					let Some(joined) = joined else { break };
					consider(Some(joined.clone()));
					run = Some(joined);
				}
			}
			best
		},
		_ => None,
	}
}

/// One rule as the scanner holds it.
struct Rule {
	regex:  Regex,
	/// Whether no factor gates the rule: it is confirmed on every text.
	always: bool,
}

/// Pure-Rust scanner core wrapped by [`SecretScanner`].
pub struct SecretScannerCore {
	/// Indexed like the caller's rules; `None` cannot be filtered natively.
	rules:     Vec<Option<Rule>>,
	/// Factor literals and their rule, in automaton pattern order after the
	/// literals.
	factors:   Vec<(Vec<u8>, u32)>,
	/// Configured literals, matched exactly; automaton patterns
	/// `0..literals.len()`.
	literals:  Vec<Vec<u8>>,
	automaton: AhoCorasick,
}

/// What one scan found; `None` from a scan means nothing at all.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct ScanHits {
	pub literal: bool,
	pub rules:   Vec<u32>,
}

impl SecretScannerCore {
	/// `rules[i]` is rule `i`'s Rust superset pattern (`None`: not
	/// translatable); `unicode_case[i]` whether the JavaScript rule folds case
	/// with Unicode rules.
	pub fn new(
		rules: &[Option<String>],
		unicode_case: &[bool],
		literals: &[String],
	) -> Result<Self, String> {
		let mut compiled = Vec::with_capacity(rules.len());
		let mut factors = Vec::new();
		for (index, source) in rules.iter().enumerate() {
			let rule = source.as_deref().and_then(|source| {
				let regex = RegexBuilder::new(source)
					.size_limit(SIZE_LIMIT)
					.build()
					.ok()?;
				let hir = regex_syntax::ParserBuilder::new()
					.build()
					.parse(source)
					.ok()?;
				let found = necessary_factors(&hir, unicode_case.get(index).copied().unwrap_or(true));
				let always = found.is_none();
				#[allow(clippy::cast_possible_truncation, reason = "rule counts are tiny")]
				for literal in found.unwrap_or_default() {
					factors.push((literal, index as u32));
				}
				Some(Rule { regex, always })
			});
			compiled.push(rule);
		}
		let literals: Vec<Vec<u8>> = literals
			.iter()
			.filter(|l| !l.is_empty())
			.map(|l| l.as_bytes().to_vec())
			.collect();
		let automaton = build_automaton(&literals, &factors)?;
		Ok(Self { rules: compiled, factors, literals, automaton })
	}

	/// Replaces the configured literals; rules and their factors stay.
	pub fn set_literals(&mut self, literals: &[String]) -> Result<(), String> {
		let literals: Vec<Vec<u8>> = literals
			.iter()
			.filter(|l| !l.is_empty())
			.map(|l| l.as_bytes().to_vec())
			.collect();
		self.automaton = build_automaton(&literals, &self.factors)?;
		self.literals = literals;
		Ok(())
	}

	/// Rules the native side cannot filter: the caller must always run them.
	#[must_use]
	pub fn unfiltered(&self) -> Vec<u32> {
		#[allow(clippy::cast_possible_truncation, reason = "rule counts are tiny")]
		self
			.rules
			.iter()
			.enumerate()
			.filter(|(_, r)| r.is_none())
			.map(|(i, _)| i as u32)
			.collect()
	}

	/// Whether `text` holds a configured literal, and the rules that may match
	/// it; `None` when neither.
	#[must_use]
	pub fn scan(&self, text: &str) -> Option<ScanHits> {
		let bytes = text.as_bytes();
		let mut literal = false;
		let mut marked = vec![false; self.rules.len()];
		for m in self.automaton.find_overlapping_iter(text) {
			let id = m.pattern().as_usize();
			if let Some(expected) = self.literals.get(id) {
				// The automaton folds ASCII case for the factors; literals are
				// exact.
				literal = literal || &bytes[m.range()] == expected.as_slice();
			} else {
				marked[self.factors[id - self.literals.len()].1 as usize] = true;
			}
		}
		#[allow(clippy::cast_possible_truncation, reason = "rule counts are tiny")]
		let rules: Vec<u32> = self
			.rules
			.iter()
			.enumerate()
			.filter_map(|(index, rule)| {
				let rule = rule.as_ref()?;
				((rule.always || marked[index]) && rule.regex.is_match(text)).then_some(index as u32)
			})
			.collect();
		(literal || !rules.is_empty()).then_some(ScanHits { literal, rules })
	}
}

fn build_automaton(
	literals: &[Vec<u8>],
	factors: &[(Vec<u8>, u32)],
) -> Result<AhoCorasick, String> {
	AhoCorasick::builder()
		.kind(Some(AhoCorasickKind::DFA))
		.match_kind(MatchKind::Standard)
		.ascii_case_insensitive(true)
		.build(
			literals
				.iter()
				.map(Vec::as_slice)
				.chain(factors.iter().map(|(f, _)| f.as_slice())),
		)
		.or_else(|_| {
			// A literal set too large for a DFA still works as an NFA.
			AhoCorasick::builder()
				.match_kind(MatchKind::Standard)
				.ascii_case_insensitive(true)
				.build(
					literals
						.iter()
						.map(Vec::as_slice)
						.chain(factors.iter().map(|(f, _)| f.as_slice())),
				)
		})
		.map_err(|error| error.to_string())
}

/// One rule for [`SecretScanner`].
#[napi(object)]
pub struct SecretScanRule {
	/// Rust pattern matching a superset of the JavaScript rule; absent when the
	/// rule cannot be translated, which leaves it to JavaScript.
	pub source:       Option<String>,
	/// Whether the JavaScript rule folds case with Unicode rules (`iu`).
	pub unicode_case: bool,
}

/// What [`SecretScanner::scan`] found in a text.
#[napi(object)]
pub struct SecretScanHits {
	/// A configured literal (or `$$`) occurs.
	pub literal: bool,
	/// Indices of the rules that may match.
	pub rules:   Vec<u32>,
}

impl From<ScanHits> for SecretScanHits {
	fn from(hits: ScanHits) -> Self {
		Self { literal: hits.literal, rules: hits.rules }
	}
}

/// Native prefilter for outbound secret redaction; see the module docs.
#[napi]
pub struct SecretScanner {
	core: SecretScannerCore,
}

#[napi]
impl SecretScanner {
	/// # Errors
	/// Returns an error when the literal automaton cannot be built.
	#[napi(constructor)]
	pub fn new(rules: Vec<SecretScanRule>, literals: Vec<String>) -> napi::Result<Self> {
		let unicode_case: Vec<bool> = rules.iter().map(|r| r.unicode_case).collect();
		let sources: Vec<Option<String>> = rules.into_iter().map(|r| r.source).collect();
		SecretScannerCore::new(&sources, &unicode_case, &literals)
			.map(|core| Self { core })
			.map_err(|error| Error::new(Status::InvalidArg, error))
	}

	/// Replaces the configured literals (plain secrets, the placeholder key,
	/// `$$`).
	///
	/// # Errors
	/// Returns an error when the literal automaton cannot be built.
	#[napi]
	pub fn set_literals(&mut self, literals: Vec<String>) -> napi::Result<()> {
		self
			.core
			.set_literals(&literals)
			.map_err(|error| Error::new(Status::InvalidArg, error))
	}

	/// Rule indices the scanner cannot filter; the caller runs them on every
	/// text.
	#[napi]
	#[must_use]
	pub fn unfiltered(&self) -> Vec<u32> {
		self.core.unfiltered()
	}

	/// Literal hit and possibly-matching rules of one text; `null` when the
	/// text needs no redaction work beyond the unfiltered rules.
	#[napi]
	#[must_use]
	pub fn scan(&self, text: String) -> Option<SecretScanHits> {
		self.core.scan(&text).map(Into::into)
	}

	/// [`Self::scan`] over many texts in parallel, in input order.
	#[napi]
	#[must_use]
	pub fn scan_many(&self, texts: Vec<String>) -> Vec<Option<SecretScanHits>> {
		texts
			.par_iter()
			.map(|text| self.core.scan(text).map(Into::into))
			.collect()
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn core(rules: &[&str], literals: &[&str]) -> SecretScannerCore {
		let rules: Vec<Option<String>> = rules.iter().map(|r| Some((*r).to_owned())).collect();
		let unicode_case = vec![false; rules.len()];
		let literals: Vec<String> = literals.iter().map(|l| (*l).to_owned()).collect();
		SecretScannerCore::new(&rules, &unicode_case, &literals).unwrap()
	}

	#[test]
	fn reports_only_rules_that_match_and_exact_literals() {
		let scanner =
			core(&["(?i:bearer )[A-Za-z0-9]{8,}", "AKIA[A-Z0-9]{16}"], &["$$", "hunter2-secret"]);
		assert_eq!(scanner.scan("plain prose with bearer but no token"), None);
		assert_eq!(
			scanner.scan("Authorization: BEARER abcdefghij"),
			Some(ScanHits { literal: false, rules: vec![0] })
		);
		assert_eq!(
			scanner.scan("key AKIAABCDEFGHIJKLMNOP and $$X$$"),
			Some(ScanHits { literal: true, rules: vec![1] })
		);
		// Literals are exact even though the automaton folds case for factors.
		assert_eq!(scanner.scan("HUNTER2-SECRET"), None);
		assert_eq!(scanner.scan("hunter2-secret"), Some(ScanHits { literal: true, rules: vec![] }));
	}

	#[test]
	fn rules_without_factors_are_confirmed_on_every_text() {
		let scanner = core(&[r"[0-9]{8,10}:[A-Za-z0-9_-]{35}"], &[]);
		let token = "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789";
		assert_eq!(
			scanner.scan(&format!("bot {token}")),
			Some(ScanHits { literal: false, rules: vec![0] })
		);
		assert_eq!(scanner.scan("no token here: 12:34"), None);
	}

	#[test]
	fn untranslatable_and_invalid_rules_are_left_unfiltered() {
		let rules = vec![None, Some("(".to_owned()), Some("abc".to_owned())];
		let scanner = SecretScannerCore::new(&rules, &[false; 3], &[]).unwrap();
		assert_eq!(scanner.unfiltered(), vec![0, 1]);
		assert_eq!(scanner.scan("xxabcxx"), Some(ScanHits { literal: false, rules: vec![2] }));
	}

	#[test]
	fn case_insensitive_factor_finds_mixed_case_matches() {
		let scanner = core(&["(?i:password)=[^ ]{6,}"], &[]);
		assert_eq!(
			scanner.scan("PaSsWoRd=correcthorse"),
			Some(ScanHits { literal: false, rules: vec![0] })
		);
	}

	#[test]
	fn set_literals_replaces_the_literal_set() {
		let mut scanner = core(&[], &["first-secret"]);
		assert!(scanner.scan("first-secret").is_some());
		scanner.set_literals(&["second-secret".to_owned()]).unwrap();
		assert_eq!(scanner.scan("first-secret"), None);
		assert!(scanner.scan("second-secret").is_some());
	}
}
