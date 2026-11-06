//! complist.c's colour specifications: `ZLS_COLORS`/`ZLS_COLOURS` parsed
//! into [`Listcols`] (zsh `getcols`, `getcoldef`, `getcolval`,
//! `filecol`).
//!
//! The parameter value is raw (unmetafied) text, as zsh's
//! `getsparam_u` returns it; colour strings stay raw bytes (they are
//! written to the terminal), patterns are metafied and tokenized before
//! they are compiled.

use std::sync::Arc;

use crate::bash::{
	pattern::zsh::{Opts, PatFlags, Pattern, tokenize},
	syntax::zsh::tok::{at, metafy},
};

/// `COL_NO`: normal text.
pub const COL_NO: usize = 0;
/// `COL_FI`: regular file.
pub const COL_FI: usize = 1;
/// `COL_DI`: directory.
pub const COL_DI: usize = 2;
/// `COL_LN`: symbolic link.
pub const COL_LN: usize = 3;
/// `COL_PI`: named pipe.
pub const COL_PI: usize = 4;
/// `COL_SO`: socket.
pub const COL_SO: usize = 5;
/// `COL_BD`: block device.
pub const COL_BD: usize = 6;
/// `COL_CD`: character device.
pub const COL_CD: usize = 7;
/// `COL_OR`: orphaned symbolic link.
pub const COL_OR: usize = 8;
/// `COL_MI`: missing file.
pub const COL_MI: usize = 9;
/// `COL_SU`: setuid file.
pub const COL_SU: usize = 10;
/// `COL_SG`: setgid file.
pub const COL_SG: usize = 11;
/// `COL_TW`: sticky other-writable directory.
pub const COL_TW: usize = 12;
/// `COL_OW`: other-writable directory.
pub const COL_OW: usize = 13;
/// `COL_ST`: sticky directory.
pub const COL_ST: usize = 14;
/// `COL_EX`: executable file.
pub const COL_EX: usize = 15;
/// `COL_LC`: left code.
pub const COL_LC: usize = 16;
/// `COL_RC`: right code.
pub const COL_RC: usize = 17;
/// `COL_EC`: end code.
pub const COL_EC: usize = 18;
/// `COL_TC`: the `LIST_TYPES` character.
pub const COL_TC: usize = 19;
/// `COL_SP`: column padding.
pub const COL_SP: usize = 20;
/// `COL_MA`: the selected match in menu selection.
pub const COL_MA: usize = 21;
/// `COL_HI`: hidden matches.
pub const COL_HI: usize = 22;
/// `COL_DU`: duplicate matches.
pub const COL_DU: usize = 23;
/// `COL_SA`: files with a suffix alias.
pub const COL_SA: usize = 24;
/// `NUM_COLS`.
pub const NUM_COLS: usize = 25;

/// `MAX_POS`: in-string colours a pattern specification may give.
pub const MAX_POS: usize = 11;

/// zsh `LC_FOLLOW_SYMLINKS` (`ln=target`): colour links as their
/// targets.
pub const LC_FOLLOW_SYMLINKS: i32 = 0x0001;

/// zsh `colnames`.
pub const COLNAMES: [&str; NUM_COLS] = [
	"no", "fi", "di", "ln", "pi", "so", "bd", "cd", "or", "mi", "su", "sg", "tw", "ow", "st", "ex",
	"lc", "rc", "ec", "tc", "sp", "ma", "hi", "du", "sa",
];

/// zsh `defcols`.
const DEFCOLS: [Option<&str>; NUM_COLS] = [
	Some("0"),
	Some("0"),
	Some("1;31"),
	Some("1;36"),
	Some("33"),
	Some("1;35"),
	Some("1;33"),
	Some("1;33"),
	None,
	None,
	Some("37;41"),
	Some("30;43"),
	Some("30;42"),
	Some("34;42"),
	Some("37;44"),
	Some("1;32"),
	Some("\x1b["),
	Some("m"),
	None,
	Some("0"),
	Some("0"),
	Some("7"),
	None,
	None,
	Some("0"),
];

/// zsh `struct filecol`: the colour of a file type, for groups matching
/// `prog` (all groups without one).
#[derive(Clone, Debug)]
pub struct Filecol {
	/// Group pattern.
	pub prog: Option<Arc<Pattern>>,
	/// The colour string (`NULL`: none given).
	pub col:  Option<Vec<u8>>,
}

/// zsh `struct patcol`: colours for matches matching a pattern.
#[derive(Clone, Debug)]
pub struct Patcol {
	/// Group pattern.
	pub prog: Option<Arc<Pattern>>,
	/// The pattern for the match.
	pub pat:  Arc<Pattern>,
	/// The colour, then one per `(#b)` group (at most [`MAX_POS`]).
	pub cols: Vec<Vec<u8>>,
}

/// zsh `struct extcol`: the colour of a file name extension.
#[derive(Clone, Debug)]
pub struct Extcol {
	/// Group pattern.
	pub prog: Option<Arc<Pattern>>,
	/// The extension (raw bytes).
	pub ext:  Vec<u8>,
	/// The colour string.
	pub col:  Vec<u8>,
}

/// zsh `struct listcols` (`mcolors`): every colour specification.
#[derive(Clone, Debug, Default)]
pub struct Listcols {
	/// Strings for file types, by `COL_*` (zsh's lists; empty for `NULL`).
	pub files: [Vec<Filecol>; NUM_COLS],
	/// Strings for patterns.
	pub pats:  Vec<Patcol>,
	/// Strings for extensions.
	pub exts:  Vec<Extcol>,
	/// [`LC_FOLLOW_SYMLINKS`].
	pub flags: i32,
}

impl Listcols {
	/// zsh `mcolors.files[i] && mcolors.files[i]->col`: the first colour
	/// string of type `i`.
	pub fn col(&self, i: usize) -> Option<&[u8]> {
		self.files[i].first().and_then(|f| f.col.as_deref())
	}
}

/// zsh `filecol(col)`: a one-element list.
fn filecol(col: Option<&[u8]>) -> Vec<Filecol> {
	vec![Filecol { prog: None, col: col.map(<[u8]>::to_vec) }]
}

/// zsh `getcolval(s, multi)`: the value starting at `s[i]` (escapes
/// decoded, as zsh decodes them, octal and `^` quirks included) and the
/// index of the byte that ended it (`:`, `=` with `multi`, or the end).
fn getcolval(s: &[u8], mut i: usize, multi: bool) -> (Vec<u8>, usize) {
	let mut p = Vec::new();
	while i < s.len() && s[i] != b':' && (!multi || s[i] != b'=') {
		if s[i] == b'\\' && at(s, i + 1) != 0 {
			i += 1;
			match s[i] {
				b'a' => p.push(0x07),
				b'n' => p.push(b'\n'),
				b'b' => p.push(0x08),
				b't' => p.push(b'\t'),
				b'v' => p.push(0x0b),
				b'f' => p.push(0x0c),
				b'r' => p.push(b'\r'),
				b'e' => p.push(0x1b),
				b'_' => p.push(b' '),
				b'?' => p.push(0x7f),
				c @ b'0'..=b'7' => {
					// zsh starts from the digit's character code, and steps
					// onto the byte after the digits (which the loop then
					// skips).
					let mut v = u32::from(c);
					i += 1;
					if (b'0'..=b'7').contains(&at(s, i)) {
						v = v * 8 + u32::from(s[i]);
						i += 1;
						if (b'0'..=b'7').contains(&at(s, i)) {
							v = v * 8 + u32::from(s[i]);
						}
					}
					p.push(v.to_le_bytes()[0]);
				},
				c => p.push(c),
			}
		} else if s[i] == b'^' {
			let n = at(s, i + 1);
			if (b'@'..=b'_').contains(&n) || n.is_ascii_lowercase() {
				// zsh masks the `^` itself, not the character after it.
				p.push(b'^' & !0x60);
			} else if n == b'?' {
				p.push(0x7f);
			} else {
				p.push(b'^');
				if n == 0 {
					i += 1;
					break;
				}
				p.push(n);
			}
			i += 1;
		} else {
			p.push(s[i]);
		}
		i += 1;
	}
	(p, i.min(s.len()))
}

/// zsh `patcompile` of raw pattern text (metafied and tokenized first);
/// `None` when it does not compile.
fn patcompile(raw: &[u8], opts: &Opts) -> Option<Arc<Pattern>> {
	let mut t = metafy(raw);
	tokenize(&mut t);
	Pattern::compile(&t, PatFlags::NONE, opts)
		.ok()
		.map(Arc::new)
}

/// zsh `getcoldef(s)`: parse the definition at `s[i]` into `mc`; the
/// index after it.
fn getcoldef(mc: &mut Listcols, s: &[u8], mut i: usize, opts: &Opts) -> usize {
	let mut gprog = None;
	if at(s, i) == b'(' {
		let mut p = i + 1;
		let mut l = 0i32;
		while p < s.len() && (s[p] != b')' || l != 0) {
			if s[p] == b'\\' && at(s, p + 1) != 0 {
				p += 1;
			} else if s[p] == b'(' {
				l += 1;
			} else if s[p] == b')' {
				l -= 1;
			}
			p += 1;
		}
		if at(s, p) == b')' {
			gprog = patcompile(&s[i..=p], opts);
			i = p + 1;
		}
	}
	match at(s, i) {
		b'*' => {
			// An extension.
			i += 1;
			let n = i;
			while i < s.len() && s[i] != b'=' {
				i += 1;
			}
			if i >= s.len() {
				return i;
			}
			let ext = s[n..i].to_vec();
			i += 1;
			let (col, mut p) = getcolval(s, i, false);
			mc.exts.push(Extcol { prog: gprog, ext, col });
			if p < s.len() {
				p += 1;
			}
			p
		},
		b'=' => {
			// A pattern.
			i += 1;
			let p = i;
			let mut nesting = 0i32;
			while i < s.len() && (nesting != 0 || s[i] != b'=') {
				let c = s[i];
				i += 1;
				match c {
					b'\\' => {
						if i < s.len() {
							i += 1;
						}
					},
					b'(' => nesting += 1,
					b')' => nesting -= 1,
					_ => {},
				}
			}
			if i >= s.len() {
				return i;
			}
			let pat = &s[p..i];
			i += 1;
			let mut cols = Vec::new();
			let mut t;
			loop {
				let (v, e) = getcolval(s, i, true);
				t = e;
				if cols.len() < MAX_POS {
					cols.push(v);
				}
				i = t;
				if at(s, i) != b'=' {
					break;
				}
				i += 1;
			}
			if let Some(prog) = patcompile(pat, opts) {
				mc.pats.push(Patcol { prog: gprog, pat: prog, cols });
			}
			if t < s.len() {
				t += 1;
			}
			t
		},
		_ => {
			// A file type.
			let n = i;
			while i < s.len() && s[i] != b'=' {
				i += 1;
			}
			if i >= s.len() {
				return i;
			}
			let name = &s[n..i];
			i += 1;
			let idx = COLNAMES.iter().position(|c| c.as_bytes() == name);
			if idx == Some(COL_LN) && s[i..].starts_with(b"target") && matches!(at(s, i + 6), b':' | 0)
			{
				mc.flags |= LC_FOLLOW_SYMLINKS;
				return i + 6;
			}
			let (col, mut p) = getcolval(s, i, false);
			if let Some(idx) = idx {
				let prog = if matches!(idx, COL_EC | COL_LC | COL_RC) {
					None
				} else {
					gprog
				};
				mc.files[idx].push(Filecol { prog, col: Some(col) });
			}
			if p < s.len() {
				p += 1;
			}
			p
		},
	}
}

/// zsh `getcols()` without `ZLS_COLORS`/`ZLS_COLOURS`: no colours but
/// the selected match in standout (`so`/`se` of the terminal, else
/// `ma=7`).
pub fn getcols_unset(standout: Option<&[u8]>, standout_end: Option<&[u8]>) -> Listcols {
	let mut mc = Listcols::default();
	for f in &mut mc.files {
		*f = filecol(Some(b""));
	}
	match standout {
		Some(so) if !so.is_empty() => {
			mc.files[COL_MA] = filecol(Some(so));
			mc.files[COL_EC] = filecol(standout_end);
		},
		_ => mc.files[COL_MA] = filecol(DEFCOLS[COL_MA].map(str::as_bytes)),
	}
	mc
}

/// zsh `getcols()` for the value `s` of `ZLS_COLORS` (raw text);
/// patterns compile under `opts` (zsh forces `EXTENDED_GLOB`).
pub fn getcols_from(s: &[u8], opts: &Opts) -> Listcols {
	// The value is a C string to zsh.
	let s = &s[..s.iter().position(|&c| c == 0).unwrap_or(s.len())];
	let mut mc = Listcols::default();
	let mut i = 0;
	while i < s.len() {
		if s[i] == b':' {
			i += 1;
		} else {
			i = getcoldef(&mut mc, s, i, opts);
		}
	}
	// Defaults for those not set explicitly.
	for (i, f) in mc.files.iter_mut().enumerate() {
		if f.first().is_none_or(|f| f.col.is_none()) {
			*f = filecol(DEFCOLS[i].map(str::as_bytes));
		}
	}
	// Orphans default to links, missing files to files.
	if mc.col(COL_OR).is_none() {
		let (lo, hi) = mc.files.split_at_mut(COL_OR);
		hi[0].clone_from(&lo[COL_LN]);
	}
	if mc.col(COL_MI).is_none() {
		let (lo, hi) = mc.files.split_at_mut(COL_MI);
		hi[0].clone_from(&lo[COL_FI]);
	}
	mc
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::bash::pattern::zsh::CharEnv;

	fn opts() -> Opts {
		Opts { extended_glob: true, ..Opts::default() }
	}

	fn col(mc: &Listcols, i: usize) -> &[u8] {
		mc.col(i).unwrap_or_default()
	}

	#[test]
	fn defaults_when_empty() {
		let mc = getcols_from(b"", &opts());
		assert_eq!(col(&mc, COL_DI), b"1;31");
		assert_eq!(col(&mc, COL_LC), b"\x1b[");
		assert_eq!(col(&mc, COL_RC), b"m");
		assert_eq!(mc.col(COL_EC), None);
		assert_eq!(mc.col(COL_HI), None);
		assert_eq!(col(&mc, COL_OR), b"1;36");
		assert_eq!(col(&mc, COL_MI), b"0");
		assert_eq!(col(&mc, COL_MA), b"7");
	}

	#[test]
	fn unset_uses_standout() {
		let mc = getcols_unset(Some(b"\x1b[7m"), Some(b"\x1b[27m"));
		assert_eq!(col(&mc, COL_MA), b"\x1b[7m");
		assert_eq!(col(&mc, COL_EC), b"\x1b[27m");
		assert_eq!(col(&mc, COL_DI), b"");
		let mc = getcols_unset(None, None);
		assert_eq!(col(&mc, COL_MA), b"7");
		assert_eq!(col(&mc, COL_EC), b"");
	}

	#[test]
	fn file_types_and_extensions() {
		let mc = getcols_from(b"di=01;34:ln=target:*.c=33:ex=1;32:xx=9:ma=4", &opts());
		assert_eq!(col(&mc, COL_DI), b"01;34");
		assert_eq!(mc.flags, LC_FOLLOW_SYMLINKS);
		assert_eq!(col(&mc, COL_LN), b"1;36");
		assert_eq!(col(&mc, COL_EX), b"1;32");
		assert_eq!(col(&mc, COL_MA), b"4");
		assert_eq!(mc.exts.len(), 1);
		assert_eq!(mc.exts[0].ext, b".c");
		assert_eq!(mc.exts[0].col, b"33");
	}

	#[test]
	fn escapes() {
		let mc = getcols_from(b"lc=\\e[:rc=\\_m:ec=a\\:b:no=^?x", &opts());
		assert_eq!(col(&mc, COL_LC), b"\x1b[");
		assert_eq!(col(&mc, COL_RC), b" m");
		assert_eq!(col(&mc, COL_EC), b"a:b");
		assert_eq!(col(&mc, COL_NO), b"\x7fx");
		// zsh's `^X` masks the caret itself.
		let mc = getcols_from(b"no=^A", &opts());
		assert_eq!(col(&mc, COL_NO), b"\x1e");
		// …and its octal escapes start from the digit's code.
		let mc = getcols_from(b"no=\\101", &opts());
		assert_eq!(col(&mc, COL_NO), &[((49u32 * 8 + 48) * 8 + 49).to_le_bytes()[0]]);
	}

	#[test]
	fn patterns_and_groups() {
		let mc = getcols_from(b"=(#b)(f*)(o)=0=31=32:(grp)di=35", &opts());
		assert_eq!(mc.pats.len(), 1);
		let pc = &mc.pats[0];
		assert!(pc.prog.is_none());
		assert_eq!(pc.cols, vec![b"0".to_vec(), b"31".to_vec(), b"32".to_vec()]);
		assert!(pc.pat.matches(b"foo", &CharEnv::DEFAULT));
		assert!(!pc.pat.matches(b"bar", &CharEnv::DEFAULT));
		assert_eq!(mc.files[COL_DI].len(), 1);
		let di = &mc.files[COL_DI][0];
		assert_eq!(di.col.as_deref(), Some(&b"35"[..]));
		let g = di.prog.as_ref().expect("group pattern");
		assert!(g.matches(b"grp", &CharEnv::DEFAULT));
		assert_eq!(mc.exts.len(), 0);
		// A group pattern before `=`: the pattern `*.z`.
		let mc = getcols_from(b"(x|y)=*.z=36", &opts());
		assert_eq!(mc.pats.len(), 1);
		assert!(
			mc.pats[0]
				.prog
				.as_ref()
				.expect("group")
				.matches(b"y", &CharEnv::DEFAULT)
		);
		assert!(mc.pats[0].pat.matches(b"a.z", &CharEnv::DEFAULT));
		assert_eq!(mc.pats[0].cols, vec![b"36".to_vec()]);
	}

	#[test]
	fn unterminated_definitions() {
		let mc = getcols_from(b"di", &opts());
		assert_eq!(col(&mc, COL_DI), b"1;31");
		let mc = getcols_from(b"*.c", &opts());
		assert!(mc.exts.is_empty());
		let mc = getcols_from(b"=foo", &opts());
		assert!(mc.pats.is_empty());
	}
}
