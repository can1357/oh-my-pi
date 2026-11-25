//! Perl's `tr///` and `y///` quote-like operators, specified in `perlop`.

use std::collections::BTreeMap;

use super::value::PStr;

/// Modifiers for a transliteration operator.
#[derive(Clone, Copy, Debug, Default)]
pub(super) struct TrFlags {
	/// Complement the search list before assigning replacements.
	pub c: bool,
	/// Delete characters past the end of the replacement list.
	pub d: bool,
	/// Squash adjacent equal transliterated characters.
	pub s: bool,
	/// Only process pairs of backslashes in the single-quoted search list.
	pub literal_search: bool,
	/// Only process pairs of backslashes in the single-quoted replacement list.
	pub literal_replace: bool,
}

#[derive(Clone, Copy)]
enum Action {
	Pass,
	Delete,
	Replace(u32),
}

/// Compiled search and replacement lists for a Perl transliteration.
pub(super) struct Translit {
	search: Vec<RankedRange>,
	replace: Vec<RankedRange>,
	latin1: Box<[Action; 256]>,
	byte_output: bool,
	identity: bool,
	count_only: bool,
	warning: Option<&'static str>,
	squash: bool,
	delete: bool,
}

impl Translit {
	/// Compile the raw lists, interpreting escapes and ranges before pairing characters.
	pub fn new(search: &PStr, replace: &PStr, flags: TrFlags) -> Result<Translit, String> {
		let search_ranges_raw = parse_list(search, flags.literal_search)?;
		let search_len = list_len(&search_ranges_raw);
		let search = search_ranges(&search_ranges_raw, flags.c);
		let replace = ranked(&parse_list(replace, flags.literal_replace)?).collect::<Vec<_>>();
		let replace_len = ranked_len(&replace);
		let warning = if !flags.c && replace_len > search_len {
			Some("Replacement list is longer than search list")
		} else if flags.d && !flags.c && replace_len == search_len && search_len != 0 {
			Some("Useless use of /d modifier in transliteration operator")
		} else {
			None
		};
		let identity = replace.is_empty() && !flags.d;
		let count_only = !flags.d && !flags.s && (identity || identity_mapping(&search, &replace));
		let latin1 = Box::new(std::array::from_fn(|cp| {
			action(&search, &replace, identity, flags.d, cp as u32)
		}));
		let byte_output = latin1.iter().all(|a| !matches!(a, Action::Replace(256..)));
		Ok(Self { search, replace, latin1, byte_output, identity, count_only, warning, squash: flags.s, delete: flags.d })
	}

	/// Whether the operator only counts matches, leaving the subject and its magic unchanged.
	pub fn is_count_only(&self) -> bool { self.count_only }

	/// Return a Perl diagnostic for redundant replacement characters or `/d`.
	pub fn warning(&self) -> Option<&'static str> { self.warning }

	/// Count matching input characters without producing a copy of the subject.
	pub fn count(&self, s: &PStr) -> usize {
		if s.utf8 {
			s.chars().filter(|&cp| self.latin1.get(cp as usize)
				.map_or_else(|| search_rank(&self.search, cp).is_some(), |a| !matches!(a, Action::Pass))).count()
		} else {
			s.bytes.iter().filter(|&&b| !matches!(self.latin1[b as usize], Action::Pass)).count()
		}
	}

	pub fn preserves_bytes(&self) -> bool { self.byte_output }

	/// Forward compaction: each input byte emits at most one output byte.
	pub fn apply_bytes(&self, bytes: &mut Vec<u8>) -> usize {
		let mut matched = 0;
		let mut written = 0;
		let mut previous = None;
		for i in 0..bytes.len() {
			let b = bytes[i];
			let out = match self.latin1[usize::from(b)] {
				Action::Pass => { previous = None; b }
				Action::Delete => { matched += 1; continue; }
				Action::Replace(cp) => {
					matched += 1;
					if self.squash && previous == Some(cp) { continue; }
					previous = Some(cp);
					cp as u8
				}
			};
			bytes[written] = out;
			written += 1;
		}
		bytes.truncate(written);
		matched
	}

	/// Return the transformed string and the count of matched input characters.
	pub fn apply(&self, s: &PStr) -> (PStr, usize) {
		if self.count_only {
			return (s.clone(), self.count(s));
		}

		let mut dst = PStr::new(Vec::with_capacity(s.bytes.len()), s.utf8);
		let mut matched = 0;
		let mut previous = None;
		let mut emit = |cp, action| match action {
			Action::Pass => {
				dst.push_char(cp);
				previous = None;
			}
			Action::Delete => matched += 1,
			Action::Replace(cp) => {
				matched += 1;
				if !self.squash || previous != Some(cp) {
					dst.push_char(cp);
					previous = Some(cp);
				}
			}
		};
		if s.utf8 {
			for cp in s.chars() {
				emit(cp, self.latin1.get(cp as usize).copied()
					.unwrap_or_else(|| action(&self.search, &self.replace, self.identity, self.delete, cp)));
			}
		} else {
			for &b in &s.bytes {
				emit(u32::from(b), self.latin1[b as usize]);
			}
		}
		(dst, matched)
	}
}

#[derive(Clone, Copy)]
struct Range {
	first: u32,
	last: u32,
}

#[derive(Clone, Copy)]
struct RankedRange {
	range: Range,
	rank: u64,
}

fn ranked(ranges: &[Range]) -> impl Iterator<Item = RankedRange> + '_ {
	let mut rank = 0;
	ranges.iter().map(move |&range| {
		let item = RankedRange { range, rank };
		rank += u64::from(range.last - range.first) + 1;
		item
	})
}

fn list_len(ranges: &[Range]) -> u64 {
	ranges.iter().map(|r| u64::from(r.last - r.first) + 1).sum()
}

fn ranked_len(ranges: &[RankedRange]) -> u64 {
	ranges.last().map_or(0, |r| r.rank + u64::from(r.range.last - r.range.first) + 1)
}

fn identity_mapping(search: &[RankedRange], replace: &[RankedRange]) -> bool {
	let Some(tail) = replace.last() else { return search.is_empty() };
	let replace_end = ranked_len(replace);
	for s in search {
		let end = s.rank + u64::from(s.range.last - s.range.first) + 1;
		let mut rank = s.rank;
		let mut ix = replace.partition_point(|r| r.rank <= rank).saturating_sub(1);
		while rank < end.min(replace_end) {
			let Some(r) = replace.get(ix) else { return false };
			let expected = u64::from(s.range.first) + rank - s.rank;
			let substituted = u64::from(r.range.first) + rank - r.rank;
			if expected != substituted { return false; }
			rank = r.rank + u64::from(r.range.last - r.range.first) + 1;
			ix += 1;
		}
		// Characters beyond the replacement list all map to its final character.
		if end > replace_end
			&& (end - s.rank.max(replace_end) != 1 || s.range.last != tail.range.last)
		{
			return false;
		}
	}
	true
}

/// Sweep the endpoints. Overlapping input ranges use the first range's
/// original rank; duplicates still occupy positions in the replacement list.
fn search_ranges(ranges: &[Range], complement: bool) -> Vec<RankedRange> {
	const END: u64 = u32::MAX as u64 + 1;
	let mut events = Vec::with_capacity(ranges.len() * 2 + 1);
	for item in ranked(ranges) {
		events.push((u64::from(item.range.first), item.rank, Some(item.range.first)));
		events.push((u64::from(item.range.last) + 1, item.rank, None));
	}
	events.push((END, u64::MAX, None));
	events.sort_unstable_by_key(|&(pos, _, _)| pos);
	let mut result = Vec::new();
	let mut open = BTreeMap::new();
	let mut prev = 0;
	let mut next_rank = 0;
	for (pos, rank, start) in events {
		if pos > prev {
			let interval = Range { first: prev as u32, last: (pos - 1) as u32 };
			if complement {
				if open.is_empty() {
					result.push(RankedRange { range: interval, rank: next_rank });
					next_rank += pos - prev;
				}
			} else if let Some((&rank, &first)) = open.first_key_value() {
				result.push(RankedRange { range: interval, rank: rank + prev - u64::from(first) });
			}
		}
		if let Some(start) = start {
			open.insert(rank, start);
		} else {
			open.remove(&rank);
		}
		prev = pos;
	}
	result
}

fn search_rank(search: &[RankedRange], cp: u32) -> Option<u64> {
	let ix = search.partition_point(|item| item.range.last < cp);
	let item = search.get(ix)?;
	Some(item.rank + u64::from(cp.checked_sub(item.range.first)?))
}

fn action(search: &[RankedRange], replace: &[RankedRange], identity: bool, delete: bool, cp: u32) -> Action {
	let Some(rank) = search_rank(search, cp) else { return Action::Pass };
	if identity {
		return Action::Replace(cp);
	}
	let ix = replace.partition_point(|item| item.rank <= rank);
	let Some(item) = ix.checked_sub(1).and_then(|ix| replace.get(ix)) else { return Action::Delete };
	let offset = rank - item.rank;
	if offset <= u64::from(item.range.last - item.range.first) {
		Action::Replace(item.range.first + offset as u32)
	} else if delete {
		Action::Delete
	} else {
		Action::Replace(item.range.last)
	}
}

#[derive(Clone, Copy)]
struct Character {
	cp: u32,
	hyphen: bool,
}

fn parse_list(list: &PStr, literal: bool) -> Result<Vec<Range>, String> {
	let mut input = list.chars().peekable();
	if literal {
		let mut ranges = Vec::new();
		while let Some(cp) = input.next() {
			if cp == u32::from(b'\\') { input.next_if_eq(&cp); }
			ranges.push(Range { first: cp, last: cp });
		}
		return Ok(ranges);
	}
	let mut chars = Vec::new();
	while let Some(cp) = input.next() {
		chars.push(if cp == u32::from(b'\\') {
			Character { cp: escape(&mut input)?, hyphen: false }
		} else {
			Character { cp, hyphen: cp == u32::from(b'-') }
		});
	}

	let mut ranges = Vec::new();
	let mut chars = chars.into_iter().peekable();
	while let Some(first) = chars.next() {
		let mut last = first.cp;
		if chars.next_if(|c| c.hyphen).is_some() {
			if let Some(end) = chars.next() {
				last = end.cp;
				if first.cp > last {
					// Printable ASCII ends are shown as typed, anything else in hex.
					let printable = (0x21..0x7F).contains(&first.cp) && (0x21..0x7F).contains(&last);
					let show = |cp: u32| if printable { char::from_u32(cp).map(String::from).unwrap_or_default() } else { format!("\\x{{{cp:04X}}}") };
					return Err(format!("Invalid range \"{}-{}\" in transliteration operator", show(first.cp), show(last)));
				}
				if let Some(dash) = chars.next_if(|c| c.hyphen) {
					if chars.peek().is_some() {
						return Err("Ambiguous range in transliteration operator".into());
					}
					ranges.push(Range { first: first.cp, last });
					ranges.push(Range { first: dash.cp, last: dash.cp });
					break;
				}
			} else {
				ranges.push(Range { first: first.cp, last });
				ranges.push(Range { first: u32::from(b'-'), last: u32::from(b'-') });
				break;
			}
		}
		ranges.push(Range { first: first.cp, last });
	}
	Ok(ranges)
}

fn digit(cp: u32, radix: u32) -> Option<u32> {
	char::from_u32(cp)?.to_digit(radix)
}

fn escape(input: &mut std::iter::Peekable<impl Iterator<Item = u32>>) -> Result<u32, String> {
	let Some(cp) = input.next() else { return Ok(u32::from(b'\\')) };
	let ascii = u8::try_from(cp).ok();
	Ok(match ascii {
		Some(b'n') => 10,
		Some(b'r') => 13,
		Some(b't') => 9,
		Some(b'f') => 12,
		Some(b'b') => 8,
		Some(b'a') => 7,
		Some(b'e') => 27,
		Some(b'c') => {
			let c = input.next().ok_or("Missing control char name in \\c")?;
			let c = u8::try_from(c).ok().filter(u8::is_ascii).ok_or("Character following \\c must be ASCII")?;
			if c == b'{' { return Err("Use \";\" instead of \"\\c{\"".into()); }
			u32::from(c.to_ascii_uppercase() ^ 64)
		}
		Some(b'0'..=b'7') => {
			let mut n = cp - u32::from(b'0');
			for _ in 0..2 {
				let Some(c) = input.next_if(|&c| digit(c, 8).is_some()) else { break };
				n = n * 8 + c - u32::from(b'0');
			}
			n
		}
		Some(b'x' | b'o' | b'N') => {
			let kind = cp as u8 as char;
			let radix = if kind == 'o' { 8 } else { 16 };
			if input.next_if_eq(&u32::from(b'{')).is_none() {
				if kind != 'x' {
					return Err(format!("Missing braces on \\{kind}{{}}"));
				}
				let mut n = 0;
				for _ in 0..2 {
					let Some(c) = input.next_if(|&c| digit(c, 16).is_some()) else { break };
					n = n * 16 + digit(c, 16).unwrap_or_default();
				}
				return Ok(n);
			}
			if kind == 'N' {
				let mut name = String::new();
				loop {
					let c = input.next().ok_or("Missing right brace on \\N{}")?;
					if c == u32::from(b'}') { break; }
					name.push(char::from_u32(c).unwrap_or(char::REPLACEMENT_CHARACTER));
				}
				let trimmed = name.trim();
				if let Some(hex) = trimmed.strip_prefix("U+") {
					let digits: String = hex.chars().filter(|&c| c != '_').collect();
					if digits.is_empty() || !digits.chars().all(|c| c.is_ascii_hexdigit()) {
						return Err("Invalid hexadecimal number in \\N{U+...}".into());
					}
					return u32::from_str_radix(&digits, 16).map_err(|_| "Use of code point too large".into());
				}
				return super::regex::char_by_name(trimmed.as_bytes()).ok_or_else(|| format!("Unknown charname '{name}'"));
			}
			let mut n = 0u32;
			let mut invalid = false;
			while input.next_if(|&c| u8::try_from(c).is_ok_and(|b| b.is_ascii_whitespace())).is_some() {}
			loop {
				let c = input.next().ok_or_else(|| format!("Missing right brace on \\{kind}{{}}"))?;
				if c == u32::from(b'}') { break; }
				if invalid { continue; }
				if c == u32::from(b'_') && input.peek().is_some_and(|&c| digit(c, radix).is_some()) {
					continue;
				}
				if let Some(d) = digit(c, radix) {
					n = n.checked_mul(radix).and_then(|n| n.checked_add(d)).ok_or("Use of code point too large")?;
				} else if u8::try_from(c).is_ok_and(|b| b.is_ascii_whitespace())
					&& input.peek().is_some_and(|&c| c == u32::from(b'}'))
				{
					continue;
				} else { invalid = true; }
			}
			n
		}
		_ => cp,
	})
}

#[cfg(test)]
mod tests {
	use super::*;

	fn tr(search: &str, replace: &str, flags: TrFlags, input: &str) -> (PStr, usize) {
		Translit::new(&PStr::from_str(search), &PStr::from_str(replace), flags)
			.unwrap().apply(&PStr::from_str(input))
	}

	#[test]
	fn ranges_duplicates_and_short_replacement() {
		assert_eq!(tr("a-cbc-d", "12345", TrFlags::default(), "dcba-"), (PStr::from_str("5321-"), 4));
		assert_eq!(tr(r"\x41-\o{103}\-\n\\", "123456", TrFlags::default(), "ABC-\n\\"), (PStr::from_str("123456"), 6));
		assert!(Translit::new(&PStr::from_str("a-b-c"), &PStr::default(), TrFlags::default()).is_err());
	}

	#[test]
	fn equivalent_compiled_maps_only_count() {
		let search = PStr::from_str("a-caa");
		let same = PStr::from_str(r"\x61bc");
		let tr = Translit::new(&search, &same, TrFlags::default()).unwrap();
		assert!(tr.is_count_only());
		assert_eq!(tr.count(&PStr::from_str("cabz")), 3);
		let tr = Translit::new(&search, &same, TrFlags { d: true, ..TrFlags::default() }).unwrap();
		assert!(!tr.is_count_only());
	}
	#[test]
	fn single_quoted_lists_keep_escapes_and_hyphens_literal() {
		let flags = TrFlags { literal_search: true, ..TrFlags::default() };
		let compiled = Translit::new(&PStr::from_str(r"\n-a"), &PStr::from_str("XY"), flags).unwrap();
		assert_eq!(compiled.apply(&PStr::from_str("\\n-a\n")), (PStr::from_str("XYYY\n"), 4));
	}

	#[test]
	fn complement_is_sorted_and_unbounded() {
		let flags = TrFlags { c: true, d: true, ..TrFlags::default() };
		assert_eq!(tr(r"\x02\x00", "ab", flags, "\0\x01\x02\x03𐀀"), (PStr::from_str("\0a\x02b"), 3));
		assert_eq!(tr(r"\x{0}-\x{FFFFFFFE}", "Z", flags, "xπ"), (PStr::from_str("xπ"), 0));
	}

	#[test]
	fn squash_across_deletions_but_not_unchanged_characters() {
		let flags = TrFlags { d: true, s: true, ..TrFlags::default() };
		assert_eq!(tr("ab", "x", flags, "abbaxaa"), (PStr::from_str("xxx"), 6));
		let squash = TrFlags { s: true, ..TrFlags::default() };
		assert_eq!(tr("oe", "", squash, "bookkeeper"), (PStr::from_str("bokkeper"), 5));
	}

	#[test]
	fn preserves_subject_flag_and_upgrades_on_wide_replacement() {
		let compiled = Translit::new(&PStr::from_str(r"\N{U+100}"), &PStr::from_str("a"), TrFlags::default()).unwrap();
		let (result, count) = compiled.apply(&PStr::from_str("Ā"));
		assert_eq!((result.bytes, result.utf8, count), (b"a".to_vec(), true, 1));
		let (result, count) = tr("a", r"\N{U+100}", TrFlags::default(), "a");
		assert_eq!((result.utf8, count), (true, 1));
		assert_eq!(result, PStr::from_str("Ā"));
	}
}
