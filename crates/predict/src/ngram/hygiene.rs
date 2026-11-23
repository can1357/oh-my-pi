//! Spelling-edit enumeration for vocabulary hygiene: which learned spellings
//! are typing slips of real words.

const ALPHABET: std::ops::RangeInclusive<char> = 'a'..='z';

/// Visit the Damerau edit-distance-1 neighbours of `word` that look like
/// typing slips: deletes, adjacent transposes, substitutions and inserts over
/// `a`–`z`, except
/// - edits of the final character (`subagents`/`subagent`,
///   `truncates`/`truncated` are inflections);
/// - edits of the first character other than a transposition (`gcloud`/`cloud`,
///   `oauth`/`auth` are distinct words);
/// - edits touching an apostrophe (`we're`/`were`, `don't`/`dont`).
///
/// `chars` is scratch space; candidates are built in `buf`.
pub fn for_each_neighbour(
	word: &str,
	chars: &mut Vec<char>,
	buf: &mut String,
	mut visit: impl FnMut(&str),
) {
	chars.clear();
	chars.extend(word.chars());
	let n = chars.len();
	let emit = |buf: &mut String, parts: &[&[char]], visit: &mut dyn FnMut(&str)| {
		buf.clear();
		for part in parts {
			buf.extend(part.iter());
		}
		visit(buf);
	};
	for i in 0..n.saturating_sub(1) {
		let (c, next) = (chars[i], chars[i + 1]);
		if i > 0 && c != '\'' {
			emit(buf, &[&chars[..i], &chars[i + 1..]], &mut visit);
		}
		if c != next && c != '\'' && next != '\'' {
			emit(buf, &[&chars[..i], &[next, c], &chars[i + 2..]], &mut visit);
		}
	}
	for i in 1..n.saturating_sub(1) {
		if chars[i] == '\'' {
			continue;
		}
		for letter in ALPHABET {
			if letter != chars[i] {
				emit(buf, &[&chars[..i], &[letter], &chars[i + 1..]], &mut visit);
			}
		}
	}
	for i in 1..n {
		for letter in ALPHABET {
			emit(buf, &[&chars[..i], &[letter], &chars[i..]], &mut visit);
		}
	}
}

/// Visit the unmistakable slips among [`for_each_neighbour`]'s edits:
/// adjacent transpositions (`isntead`, `proeprly`) and doubled/undoubled
/// inner letters (`cannonical`, `comit`). Unlike substitutions these rarely
/// turn one real word or jargon term into another (`serde`/`serve`), so they
/// are safe to act on even when the variant is typed often. The relation is
/// symmetric: `b` is a slip of `a` iff `a` is a slip of `b`.
pub fn for_each_slip(
	word: &str,
	chars: &mut Vec<char>,
	buf: &mut String,
	mut visit: impl FnMut(&str),
) {
	chars.clear();
	chars.extend(word.chars());
	let n = chars.len();
	let mut emit = |parts: &[&[char]]| {
		buf.clear();
		for part in parts {
			buf.extend(part.iter());
		}
		visit(buf);
	};
	for i in 0..n.saturating_sub(1) {
		let (c, next) = (chars[i], chars[i + 1]);
		if c != next && c != '\'' && next != '\'' {
			emit(&[&chars[..i], &[next, c], &chars[i + 2..]]);
		}
		// Undouble a pair touching neither end (`uutils`, `sshot` are names).
		if c == next && i > 0 && i + 2 < n {
			emit(&[&chars[..i], &chars[i + 1..]]);
		}
	}
	// Double a letter that is neither the first nor the last.
	for i in 1..n.saturating_sub(1) {
		if chars[i] != '\'' {
			emit(&[&chars[..=i], &chars[i..]]);
		}
	}
}
