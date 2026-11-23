//! The auto-removable completion suffix of zsh 5.9 `Src/Zle/zle_misc.c`
//! (`addsuffix`, `addsuffixstring`, `makesuffix`, `makeparamsuffix`,
//! `makesuffixstr`, `iremovesuffix`, `fixsuffix`).
//!
//! zsh keeps this state in `zle_misc.c` globals; here it is [`Suffix`] in
//! [`super::State`], except `suffixlen`, which is
//! [`LineState::suffixlen`](crate::bash::vm::zle::utils::LineState) (the
//! display shows it).

use bstr::BString;

use crate::bash::{
	syntax::zsh::tok::metafy,
	vm::{
		zle::{
			Editor,
			comp::{Comp, K},
			exec::{self, Await, WResult, Zw, then},
			to_line,
		},
		zsh::text::{getkey, getkeystring},
	},
	zshopt::ZshOpt,
};

/// zsh `enum suffixtype`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Suftyp {
	/// `SUFTYP_POSSTR`: characters to match.
	PosStr,
	/// `SUFTYP_NEGSTR`: characters not to match.
	NegStr,
	/// `SUFTYP_POSRNG`: a range to match.
	PosRng,
	/// `SUFTYP_NEGRNG`: a range not to match.
	NegRng,
}

/// zsh `SUFFLAGS_SPACE`: add a space when removing the suffix.
pub const SUFFLAGS_SPACE: i32 = 1;

/// zsh `struct suffixset`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Suffixset {
	/// The `SUFTYP_*`.
	pub tp:     Suftyp,
	/// `SUFFLAGS_*`.
	pub flags:  i32,
	/// The characters (a range: its two ends).
	pub chars:  Vec<char>,
	/// Length of the suffix.
	pub lensuf: i32,
}

/// `zle_misc.c`'s suffix globals.
#[derive(Clone, Debug, Default)]
pub struct Suffix {
	/// zsh `suffixlist`, first element first (zsh prepends).
	pub suffixlist:     Vec<Suffixset>,
	/// zsh `suffixfunc`: shell function to call to remove the suffix.
	pub suffixfunc:     Option<BString>,
	/// zsh `suffixnoinsrem`: remove the suffix on uninsertable characters.
	pub suffixnoinsrem: bool,
}

/// zsh `addsuffix(tp, flags, chars, lenstr, lensuf)`.
pub fn addsuffix(c: &mut Comp, tp: Suftyp, flags: i32, chars: &[char], lensuf: i32) {
	c.result
		.suffix
		.suffixlist
		.insert(0, Suffixset { tp, flags, chars: chars.to_vec(), lensuf });
}

/// zsh `addsuffixstring(tp, flags, chars, lensuf)`: [`addsuffix`] from a
/// metafied string.
pub fn addsuffixstring(c: &mut Comp, tp: Suftyp, flags: i32, chars: &[u8], lensuf: i32) {
	let ws = to_line(&crate::bash::syntax::zsh::tok::unmetafy(chars));
	addsuffix(c, tp, flags, &ws, lensuf);
}

/// zsh `makesuffix(n)`: the last `n` characters are a suffix removed in
/// the usual word end conditions (`$ZLE_REMOVE_SUFFIX_CHARS`,
/// `$ZLE_SPACE_SUFFIX_CHARS`).
pub fn makesuffix(zw: &mut Zw<'_, '_>, n: i32) {
	let rem = zw.getsparam(b"ZLE_REMOVE_SUFFIX_CHARS");
	let space = zw.getsparam(b"ZLE_SPACE_SUFFIX_CHARS");
	let c = &mut zw.zle.comp;
	let chars = rem.map_or_else(|| b" \t\n;&|".to_vec(), |s| metafy(&s));
	addsuffixstring(c, Suftyp::PosStr, 0, &chars, n);
	// Do this second so it takes precedence.
	if let Some(s) = space.filter(|s| !s.is_empty()) {
		addsuffixstring(c, Suftyp::PosStr, SUFFLAGS_SPACE, &metafy(&s), n);
	}
	zw.ed.ls.suffixlen = usize::try_from(n).unwrap_or(0);
	zw.zle.comp.result.suffix.suffixnoinsrem = true;
}

/// zsh `makeparamsuffix(br, n)`: the last `n` characters are a parameter
/// name suffix, removed before characters that go right after a name
/// (`br`: in braces, so more of them).
pub fn makeparamsuffix(zw: &mut Zw<'_, '_>, br: bool, n: i32) {
	const CHARSTR: [char; 8] = [':', '[', '#', '%', '?', '-', '+', '='];
	let mut lenstr = 0;
	if br || !zw.isset(ZshOpt::Ksharrays) {
		lenstr = 2;
		if br {
			lenstr += 6;
		}
	}
	if lenstr != 0 {
		addsuffix(&mut zw.zle.comp, Suftyp::PosStr, 0, &CHARSTR[..lenstr], n);
	}
}

/// zsh `makesuffixstr(f, s, n)`: the suffix is removed by function `f`,
/// or on the characters `s` (`compadd -r`: `^`/`!` negates, `a-z`
/// ranges, `\-` also on uninsertable characters), else as [`makesuffix`].
pub fn makesuffixstr(zw: &mut Zw<'_, '_>, f: Option<&[u8]>, s: Option<&[u8]>, n: i32) {
	if let Some(f) = f {
		zw.zle.comp.result.suffix.suffixfunc = Some(BString::from(f));
		zw.ed.ls.suffixlen = usize::try_from(n).unwrap_or(0);
	} else if let Some(s) = s {
		let (inv, s) = match s.first() {
			Some(b'^' | b'!') => (true, &s[1..]),
			_ => (false, s),
		};
		// zsh `getkeystring(s, &i, GETKEYS_SUFFIX, &z)`: GETKEYS_SUFFIX is
		// octal, emacs and control escapes plus `\-` (GETKEY_BACKSLASH_MINUS),
		// which is dropped and noted in `z`.
		let mut z = false;
		let mut pre = Vec::with_capacity(s.len());
		let mut i = 0;
		while i < s.len() {
			if s[i] == b'\\' && i + 1 < s.len() {
				if s[i + 1] == b'-' {
					z = true;
				} else {
					pre.extend_from_slice(&s[i..i + 2]);
				}
				i += 2;
			} else {
				pre.push(s[i]);
				i += 1;
			}
		}
		let ks = getkeystring(&pre, getkey::OCTAL_ESC | getkey::EMACS | getkey::CTRL);
		let ws = to_line(&ks.text);
		let c = &mut zw.zle.comp;
		// Remove the suffix on uninsertable characters if `\-` was given
		// and the class was not negated, or vice versa.
		c.result.suffix.suffixnoinsrem = z ^ inv;
		zw.ed.ls.suffixlen = usize::try_from(n).unwrap_or(0);
		let (strt, rngt) = if inv {
			(Suftyp::NegStr, Suftyp::NegRng)
		} else {
			(Suftyp::PosStr, Suftyp::PosRng)
		};
		let mut lasts = 0;
		let mut w = 0;
		let mut left = ws.len();
		while left > 0 {
			if left >= 3 && ws[w + 1] == '-' {
				if w > lasts {
					addsuffix(c, strt, 0, &ws[lasts..w], n);
				}
				addsuffix(c, rngt, 0, &[ws[w], ws[w + 2]], n);
				w += 3;
				left -= 3;
				lasts = w;
			} else {
				w += 1;
				left -= 1;
			}
		}
		if w > lasts {
			addsuffix(c, strt, 0, &ws[lasts..w], n);
		}
	} else {
		makesuffix(zw, n);
	}
}

/// zsh `fixsuffix()`: the suffix stays; nothing is removable any more.
pub fn fixsuffix(c: &mut Comp, ed: &mut Editor) {
	c.result.suffix.suffixlist.clear();
	c.result.suffix.suffixnoinsrem = false;
	ed.ls.suffixlen = 0;
}

/// Delete `sl` characters before the cursor, in the metafied line when
/// completion has it metafied (zsh `backdel(sl, CUT_RAW)`, which counts
/// characters).
fn backdel_chars(c: &mut Comp, ed: &mut Editor, sl: usize) {
	if let Some(line) = c.line.s.as_deref() {
		let cs = c.line.cs.min(line.len());
		let chars = to_line(&crate::bash::syntax::zsh::tok::unmetafy(&line[..cs]));
		let keep = chars.len().saturating_sub(sl);
		let at = metafy(&crate::bash::vm::zle::from_line(&chars[..keep])).len();
		let n = cs - at;
		c.line.backdel(n);
	} else {
		let n = sl.min(ed.cs);
		ed.cs -= n;
		ed.line.drain(ed.cs..ed.cs + n);
		if ed.mark > ed.cs {
			ed.mark = ed.mark.saturating_sub(n).max(ed.cs);
		}
	}
}

/// zsh `iremovesuffix(c, keep)`: remove the suffix, if there is one, as
/// inserting character `ch` asks (`None`: zsh `NO_INSERT_CHAR`, an
/// uninsertable character); `keep` keeps the completion list. With a
/// suffix function (`compadd -R`) that function is called with the
/// suffix length instead. Then the suffix is fixed ([`fixsuffix`]).
pub fn iremovesuffix(zw: &mut Zw<'_, '_>, ch: Option<char>, keep: bool, k: K<()>) -> WResult {
	if let Some(func) = zw.zle.comp.result.suffix.suffixfunc.take() {
		if !exec::has_function(zw, &func) {
			return iremovesuffix_done(zw, k);
		}
		// The function runs as a normal ZLE function, with the line
		// unmetafied.
		let wasmeta = zw.zle.comp.line.s.is_some();
		if wasmeta {
			zw.zle.comp.line.unmetafy(zw.ed);
		}
		let args = vec![BString::from(zw.ed.ls.suffixlen.to_string())];
		return then(Await::Function { name: func, args }, move |zw, _| {
			if wasmeta {
				zw.zle.comp.line.metafy(zw.ed);
			}
			iremovesuffix_done(zw, k)
		});
	}
	let suffixlen = i32::try_from(zw.ed.ls.suffixlen).unwrap_or(i32::MAX);
	let mut sl = 0;
	let mut flags = 0;
	let s = &zw.zle.comp.result.suffix;
	match ch {
		None => sl = if s.suffixnoinsrem { suffixlen } else { 0 },
		Some(ch) => {
			// Stop at a match in a positive or negative list (its length or
			// zero); past a negative list without a match, its length.
			let mut negsuflen = 0;
			let mut found = false;
			for ss in &s.suffixlist {
				match ss.tp {
					Suftyp::PosStr => {
						if ss.chars.contains(&ch) {
							sl = ss.lensuf;
							found = true;
						}
					},
					Suftyp::NegStr => {
						if ss.chars.contains(&ch) {
							sl = 0;
							found = true;
						} else {
							negsuflen = ss.lensuf;
						}
					},
					Suftyp::PosRng => {
						if ss.chars[0] <= ch && ch <= ss.chars[1] {
							sl = ss.lensuf;
							found = true;
						}
					},
					Suftyp::NegRng => {
						if ss.chars[0] <= ch && ch <= ss.chars[1] {
							sl = 0;
							found = true;
						} else {
							negsuflen = ss.lensuf;
						}
					},
				}
				if found {
					flags = ss.flags;
					break;
				}
			}
			if !found {
				sl = negsuflen;
			}
		},
	}
	if sl > 0 {
		backdel_chars(&mut zw.zle.comp, zw.ed, usize::try_from(sl).unwrap_or(0));
		if flags & SUFFLAGS_SPACE != 0 {
			// Add a space and advance over it.
			let c = &mut zw.zle.comp;
			if c.line.s.is_some() {
				c.line.spaceinline(1);
				let cs = c.line.cs;
				if let Some(l) = c.line.s.as_mut() {
					l[cs] = b' ';
				}
				c.line.cs += 1;
			} else {
				zw.ed.line.insert(zw.ed.cs, ' ');
				if zw.ed.mark > zw.ed.cs {
					zw.ed.mark += 1;
				}
				zw.ed.cs += 1;
			}
		}
		if !keep {
			invalidatelist(zw);
		}
	}
	iremovesuffix_done(zw, k)
}

/// zsh `invalidatelist()`: the `invalidate_list` hook, which zsh/complete
/// adds when it is loaded.
pub fn invalidatelist(zw: &mut Zw<'_, '_>) {
	let loaded = crate::bash::vm::builtins::zsh_module::loaded(zw.cx.store, zw.vp, b"zsh/complete")
		.unwrap_or(false);
	if loaded {
		super::invalidate_list(zw);
	}
}

/// What zsh's `execzlefunc` does before an internal widget with flags
/// `wflags` runs: without `ZLE_KEEPSUFFIX` the suffix is removed
/// (`removesuffix()`), without `ZLE_MENUCMP` it is fixed and the list
/// invalidated; then `run` (the widget).
pub fn widget_prologue<F>(zw: &mut Zw<'_, '_>, wflags: u32, run: F) -> WResult
where
	F: FnOnce(&mut Zw<'_, '_>) -> WResult + Send + 'static,
{
	use crate::bash::vm::zle::wflags as wf;
	let rest = move |zw: &mut Zw<'_, '_>| {
		if wflags & wf::MENUCMP == 0 {
			fixsuffix(&mut zw.zle.comp, zw.ed);
			invalidatelist(zw);
		}
		run(zw)
	};
	if wflags & wf::KEEPSUFFIX == 0 {
		return iremovesuffix(zw, None, false, Box::new(move |zw, ()| rest(zw)));
	}
	rest(zw)
}

/// The end of [`iremovesuffix`].
fn iremovesuffix_done(zw: &mut Zw<'_, '_>, k: K<()>) -> WResult {
	fixsuffix(&mut zw.zle.comp, zw.ed);
	k(zw, ())
}
