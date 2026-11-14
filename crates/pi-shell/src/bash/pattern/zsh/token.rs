//! Turning strings into zsh patterns and testing them for wildcards: zsh
//! 5.9 `glob.c` `tokenize`, `shtokenize`, `zshtokenize` and `remnulargs`,
//! and `pattern.c` `haswilds`.
//!
//! Ported from zsh 5.9 (MIT-style licence, Copyright (c) 1992-1997 Paul
//! Falstad and the zsh development group).

use super::{
	Opts, ZPC_BAR, ZPC_HASH, ZPC_HAT, ZPC_INANG, ZPC_INBRACK, ZPC_INPAR, ZPC_KSH_AT, ZPC_KSH_BANG,
	ZPC_KSH_BANG2, ZPC_KSH_PLUS, ZPC_KSH_QUEST, ZPC_KSH_STAR, ZPC_QUEST, ZPC_STAR,
};
use crate::bash::syntax::zsh::tok::{
	BANG, BAR, BNULL, BNULLKEEP, DASH, HAT, INANG, INBRACK, INPAR, META, NULARG, OUTANG, OUTBRACK,
	POUND, QUEST, STAR, ZTOKENS, at, is_null, set_at,
};

/// zsh `tokenize`: turn the pattern characters of the metafied `s` into
/// tokens in place, blindly (no lexing); a backslash quotes the next
/// character and becomes a `Bnull`. Builtins use it on pattern arguments.
pub fn tokenize(s: &mut [u8]) {
	zshtokenize(s, false, false);
}

/// zsh `shtokenize`: [`tokenize`] for `GLOB_SUBST` and `${~x}`: quoting
/// backslashes become `Bnullkeep`, so a word that fails to match keeps
/// them; under `SH_GLOB` (`sh_glob`) `(`, `|`, `)` and `<…>` stay
/// characters.
pub fn shtokenize(s: &mut [u8], sh_glob: bool) {
	zshtokenize(s, true, sh_glob);
}

/// zsh `zshtokenize` with `ZSHTOK_SUBST` (`subst`) and `ZSHTOK_SHGLOB`.
fn zshtokenize(s: &mut [u8], subst: bool, shglob: bool) {
	let null = if subst { BNULLKEEP } else { BNULL };
	let is_dash = |byte: u8| byte == b'-' || byte == DASH;
	let len = s.len();
	let mut bslash = false;
	let mut i = 0;
	while i < len {
		let ch = at(s, i);
		match ch {
			// Skip both Meta and the following character.
			META => i += 1,
			BNULL | BNULLKEEP | b'\\' => {
				if !bslash {
					bslash = true;
					i += 1;
					continue;
				}
				set_at(s, i - 1, null);
			},
			b'<' if !shglob => {
				if bslash {
					set_at(s, i - 1, null);
				} else {
					// <n-m>, either number optional.
					let open = i;
					let mut j = i + 1;
					while j < len && s[j].is_ascii_digit() {
						j += 1;
					}
					if !(j < len && is_dash(s[j])) {
						i = j;
						continue;
					}
					j += 1;
					while j < len && s[j].is_ascii_digit() {
						j += 1;
					}
					if !(j < len && s[j] == b'>') {
						i = j;
						continue;
					}
					set_at(s, open, INANG);
					set_at(s, j, OUTANG);
					i = j;
				}
			},
			b'(' | b'|' | b')' if shglob => {},
			b'(' | b'|' | b')' | b'>' | b'^' | b'#' | b'~' | b'[' | b']' | b'*' | b'?' | b'='
			| b'-' | b'!' => {
				if let Some(idx) = ZTOKENS.iter().position(|&tc| tc == ch) {
					if bslash {
						set_at(s, i - 1, null);
					} else {
						set_at(s, i, POUND + idx as u8);
					}
				}
			},
			_ => {},
		}
		bslash = false;
		i += 1;
	}
}

/// zsh `remnulargs`: remove the quote tokens of `s`.
///
/// `Snull`, `Dnull`, `Bnull` and `Nularg` go once one occurs, turning later
/// `Bnullkeep`s into
/// backslashes; an all-quotes string becomes a single `Nularg` (an empty
/// tokenized string).
pub fn remnulargs(s: &mut Vec<u8>) {
	let Some(first) = s.iter().position(|&c| c != BNULLKEEP && is_null(c)) else {
		return;
	};
	let mut t = first;
	for r in first + 1..s.len() {
		let c = at(s, r);
		if c == BNULLKEEP {
			set_at(s, t, b'\\');
			t += 1;
		} else if !is_null(c) {
			set_at(s, t, c);
			t += 1;
		}
	}
	s.truncate(t);
	if s.is_empty() {
		s.push(NULARG);
	}
}

/// zsh `haswilds`: whether the tokenized word `s` is subject to filename
/// generation under `opts`. A lone `[` or `]` is not; `%?` keeps its `?`
/// (a job reference), which this rewrites in `s` as zsh does.
pub fn haswilds(s: &mut [u8], opts: &Opts) -> bool {
	if s.len() == 1 && (s[0] == INBRACK || s[0] == OUTBRACK) {
		return false;
	}
	if s.len() >= 2 && s[0] == b'%' && s[1] == QUEST {
		set_at(s, 1, b'?');
	}
	let dis = |i: usize| opts.disables.has(i);
	for (i, &c) in s.iter().enumerate() {
		let wild = match c {
			INPAR => {
				(!opts.sh_glob && !dis(ZPC_INPAR))
					|| (i > 0
						&& opts.ksh_glob
						&& match at(s, i - 1) {
							QUEST => !dis(ZPC_KSH_QUEST),
							STAR => !dis(ZPC_KSH_STAR),
							b'+' => !dis(ZPC_KSH_PLUS),
							BANG => !dis(ZPC_KSH_BANG),
							b'!' => !dis(ZPC_KSH_BANG2),
							b'@' => !dis(ZPC_KSH_AT),
							_ => false,
						})
			},
			BAR => !dis(ZPC_BAR),
			STAR => !dis(ZPC_STAR),
			INBRACK => !dis(ZPC_INBRACK),
			INANG => !dis(ZPC_INANG),
			QUEST => !dis(ZPC_QUEST),
			POUND => opts.extended_glob && !dis(ZPC_HASH),
			HAT => opts.extended_glob && !dis(ZPC_HAT),
			_ => false,
		};
		if wild {
			return true;
		}
	}
	false
}
