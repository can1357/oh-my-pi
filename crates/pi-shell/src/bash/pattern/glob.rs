//! Pathname-expansion helpers on pattern text, from bash's `glob.c`.
//!
//! They answer which components need a directory scan, where the last `/`
//! outside extglob groups is, and which directory entries a component may
//! never match (leading dots).

use crate::bash::pattern::strmatch::patscan;

/// bash's `glob_pattern_p`: whether `pat` (backslash-quoted) has an
/// unquoted `*`, `?`, a `[` closed by a `]`, or `+(`, `@(`, `!(`. A
/// trailing backslash makes the whole pattern literal.
pub fn glob_pattern_p(pat: &[u8]) -> bool {
	let mut open = false;
	let mut i = 0;
	while let Some(&c) = pat.get(i) {
		i += 1;
		match c {
			b'?' | b'*' => return true,
			b'[' => open = true,
			b']' if open => return true,
			b'+' | b'@' | b'!' if pat.get(i) == Some(&b'(') => return true,
			b'\\' => {
				if i == pat.len() {
					return false;
				}
				i += 1;
			},
			_ => {},
		}
	}
	false
}

/// bash's `extglob_pattern_p`: `pat` starts with `*(`, `+(`, `!(`, `@(` or
/// `?(`.
pub const fn extglob_pattern_p(pat: &[u8]) -> bool {
	matches!(pat, [b'*' | b'+' | b'!' | b'@' | b'?', b'(', ..])
}

/// bash's `glob_dirscan`: the index of the last `/` in `pat` that is not
/// inside an extglob group.
pub fn dirscan(pat: &[u8]) -> Option<usize> {
	let mut dir = None;
	let mut p = 0;
	while p < pat.len() {
		if extglob_pattern_p(&pat[p..]) {
			if let Some(pe) = patscan(pat, p + 2, pat.len() - 1, false) {
				if pe >= pat.len() {
					break;
				}
				p = pe;
				continue;
			}
		} else if pat[p] == b'/' {
			dir = Some(p);
		}
		p += 1;
	}
	dir
}

/// Which directory entries a pattern component skips.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct SkipOpts {
	/// `shopt -s dotglob` (or a non-empty `GLOBIGNORE`).
	pub dotglob:  bool,
	/// `shopt -s globskipdots` (bash's default): `.` and `..` never match.
	pub skipdots: bool,
}

const fn dot_or_dotdot(name: &[u8]) -> bool {
	matches!(name, b"." | b"..")
}

/// Whether `pat` starts with a literal `.` (possibly backslash-quoted).
const fn explicit_dot(pat: &[u8]) -> bool {
	matches!(pat, [b'.', ..] | [b'\\', b'.', ..])
}

/// bash's `skipname`: whether directory entry `name` is skipped before
/// `pat` is even tried (leading-dot rules; extglob groups decide per
/// alternative).
pub fn skipname(pat: &[u8], name: &[u8], opts: SkipOpts) -> bool {
	if extglob_pattern_p(pat) {
		return extglob_skipname(pat, name, opts);
	}
	if opts.skipdots && dot_or_dotdot(name) {
		return true;
	}
	if opts.dotglob {
		!explicit_dot(pat) && dot_or_dotdot(name)
	} else {
		name.first() == Some(&b'.') && !explicit_dot(pat)
	}
}

/// bash's `extglob_skipname`: skip `name` only if every alternative of the
/// leading group would.
fn extglob_skipname(pat: &[u8], name: &[u8], opts: SkipOpts) -> bool {
	let wild = matches!(pat[0], b'*' | b'?');
	let se = pat.len();
	let Some(pe) = patscan(pat, 2, se, false) else {
		return false;
	};
	if pe == se && pat[pe - 1] == b')' && !pat[2..].contains(&b'|') {
		return skipname(&pat[2..pe - 1], name, opts);
	}
	let mut pp = 2;
	let mut skip = true;
	while let Some(t) = patscan(pat, pp, pe, true) {
		// A nested group keeps the rest of the pattern, as bash does.
		let sub = if extglob_pattern_p(&pat[pp..]) && pat[t - 1] == b')' {
			&pat[pp..]
		} else {
			&pat[pp..t - 1]
		};
		skip = skipname(sub, name, opts);
		if !skip {
			return false;
		}
		pp = t;
		if pp == pe {
			break;
		}
	}
	if pp == se {
		return skip;
	}
	if wild && pe < se {
		return skipname(&pat[pe..], name, opts);
	}
	true
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn pattern_detection_matches_glob_pattern_p() {
		assert!(glob_pattern_p(b"*.c"));
		assert!(!glob_pattern_p(b"\\*.c"));
		assert!(glob_pattern_p(b"a[bc]"));
		assert!(!glob_pattern_p(b"a["));
		assert!(glob_pattern_p(b"@(a|b)"));
		assert!(!glob_pattern_p(b"a\\"), "a trailing backslash makes it literal");
	}

	#[test]
	fn dirscan_skips_slashes_inside_extglob_groups() {
		assert_eq!(dirscan(b"a/b/c"), Some(3));
		assert_eq!(dirscan(b"a/@(b/c)"), Some(1));
		assert_eq!(dirscan(b"abc"), None);
	}

	#[test]
	fn leading_dots_need_an_explicit_dot() {
		let def = SkipOpts { dotglob: false, skipdots: true };
		assert!(skipname(b"*", b".a", def));
		assert!(!skipname(b".*", b".a", def));
		assert!(skipname(b".*", b"..", def), "globskipdots");
		let dot = SkipOpts { dotglob: true, skipdots: false };
		assert!(!skipname(b"*", b".a", dot));
		assert!(skipname(b"*", b"..", dot));
		assert!(!skipname(b"@(.foo|*)", b".foo", def));
		assert!(skipname(b"@(foo|*)", b".foo", def));
	}
}
