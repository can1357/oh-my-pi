//! Line-level screen update (zsh `refreshline`, `moveto`,
//! `tc_rightcurs`, `tc_downcurs`, `tcmultout`, `singmoveto`) and the
//! single-line display (zsh `singlerefresh`).

use super::{
	Cap, Elem, Line, N_SPECIAL_HIGHLIGHTS, R, TXT_ATTR_ON_MASK, TXT_MULTIWORD_MASK, WEOF, ZR_CR,
	ZR_NL, ZR_SP, ZR_ZR, Zattr, at, ctrl_char, is_basechar, is_combining, iswcntrl, off_from_on,
	put, wcwidth, zr_strlen, ztrlen,
};
use crate::bash::syntax::zsh::tok::{INPAR, META, OUTPAR, is_meta};

/// zsh `mb_metacharlenconv` on metafied `s` at `i`: the bytes of the
/// character there and the character (`None`: no valid one, zsh's
/// `WEOF`).
fn mb_metacharlenconv(s: &[u8], i: usize) -> (usize, Option<char>) {
	let Some(&first) = s.get(i) else {
		return (0, None);
	};
	if first <= 0x7f {
		return (1, Some(char::from(first)));
	}
	let mut buf = [0u8; 4];
	let mut n = 0;
	let mut p = i;
	while p < s.len() {
		let c = if s[p] == META {
			p += 1;
			s.get(p).map_or(0, |&b| b ^ 32)
		} else if is_meta(s[p]) {
			// A token: not part of the string.
			break;
		} else {
			s[p]
		};
		p += 1;
		if n == buf.len() {
			break;
		}
		buf[n] = c;
		n += 1;
		match std::str::from_utf8(&buf[..n]) {
			Ok(st) => return (p - i, st.chars().next()),
			Err(e) if e.error_len().is_none() => {},
			Err(_) => break,
		}
	}
	if p > i {
		(1 + usize::from(first == META), None)
	} else {
		(0, None)
	}
}

impl R<'_, '_> {
	/// The cell at `i` of the line `refreshline` writes: `tmp` when it was
	/// padded into a scratch line, else new line `ln`.
	fn nlat(&self, tmp: Option<&Line>, ln: i32, i: i32) -> Elem {
		match tmp {
			Some(l) => at(l, i),
			None => self.nget(ln, i),
		}
	}

	/// The cell at `i` of old line `ol` (`None`: zsh's empty `nullchr`).
	fn olat(&self, ol: Option<usize>, i: i32) -> Elem {
		ol.and_then(|ln| self.d.obuf.get(ln)?.as_deref())
			.map_or(ZR_ZR, |l| at(l, i))
	}

	/// Store `e` at `i` of old line `ol`.
	fn olset(&mut self, ol: Option<usize>, i: i32, e: Elem) {
		if let Some(l) = ol.and_then(|ln| self.d.obuf.get_mut(ln)?.as_deref_mut()) {
			put(l, i, e);
		}
	}

	/// zsh `zwrite(nl, n)`: write `n` cells from `i` of the line
	/// `refreshline` writes, attributes tracked across them.
	fn zwrite_from(&mut self, tmp: Option<&Line>, ln: i32, i: i32, n: i32) {
		let mut cur: Zattr = 0;
		for k in 0..n {
			let e = self.nlat(tmp, ln, i + k);
			self.zwcputc(e, Some(&mut cur));
		}
	}

	/// zsh `wpfxlen(old, new)`: matching cells of old line `ol` from `oi`
	/// and the written line from `ni`.
	fn wpfxlen(&self, ol: Option<usize>, oi: i32, tmp: Option<&Line>, ln: i32, ni: i32) -> i32 {
		let mut k = 0;
		loop {
			let o = self.olat(ol, oi + k);
			if o.chr == 0 || !self.eq(o, self.nlat(tmp, ln, ni + k)) {
				return k;
			}
			k += 1;
		}
	}

	/// zsh `tcdelcost`.
	fn tcdelcost(&self, n: i32) -> i32 {
		let t = self.i.term;
		if t.tccan(Cap::MultDel) {
			t.tclen(Cap::MultDel) as i32
		} else {
			n * t.tclen(Cap::Del) as i32
		}
	}

	/// zsh `tcinscost`.
	fn tcinscost(&self, n: i32) -> i32 {
		let t = self.i.term;
		if t.tccan(Cap::MultIns) {
			t.tclen(Cap::MultIns) as i32
		} else {
			n * t.tclen(Cap::Ins) as i32
		}
	}

	/// zsh `refreshline`: update screen line `ln` from the old to the new
	/// buffer with whatever the terminal offers.
	#[expect(clippy::too_many_lines, reason = "a faithful port of one C function")]
	pub(super) fn refreshline(&mut self, ln: i32) {
		let term = self.i.term;
		let hasam = term.hasam;
		let winw = self.d.winw;
		let lu = usize::try_from(ln).unwrap_or(0);

		// 0: setup.
		let nhas = self.nhas(ln);
		let rnllen = if nhas { self.nbuf_strlen(ln) } else { 0 };
		let mut nllen = rnllen;
		let ol: Option<usize> = (ln < self.d.olnct && self.ohas(ln)).then_some(lu);
		let ollen = if ol.is_some() {
			self.obuf_strlen(ln)
		} else {
			0
		};

		// Clearing old lines: easy when the terminal can.
		if self.d.cleareol
			&& nllen == 0
			&& !(hasam && ln < self.d.nlnct - 1)
			&& term.tccan(Cap::ClearEol)
		{
			self.moveto(ln, 0);
			self.tcoutclear(Cap::ClearEol);
			return;
		}

		// 1: pad the new line with spaces to hold everything to write.
		let mut tmp: Option<Line> = None;
		if self.d.cleareol
			|| (nllen == 0 && (ln != 0 || !self.d.put_rpmpt))
			|| (ln == 0 && self.d.put_rpmpt != self.d.oput_rpmpt)
		{
			let w = usize::try_from(winw).unwrap_or(0);
			let mut p1 = vec![ZR_ZR; w + 2];
			for k in 0..nllen {
				put(&mut p1, k, self.nget(ln, k));
			}
			for k in nllen..winw {
				put(&mut p1, k, ZR_SP);
			}
			put(&mut p1, winw, ZR_ZR);
			put(
				&mut p1,
				winw + 1,
				if nllen < winw {
					ZR_ZR
				} else {
					self.nget(ln, winw + 1)
				},
			);
			if ln != 0 && nhas {
				// Next time obuf is up to date.
				if let Some(slot) = self.d.nbuf.get_mut(lu) {
					*slot = Some(p1);
				}
			} else {
				// Not for the prompt line.
				tmp = Some(p1);
			}
			nllen = winw;
		} else if ollen > nllen {
			// The new line at least as long as the old one.
			let mut p1 = vec![ZR_ZR; usize::try_from(ollen).unwrap_or(0) + 1];
			for k in 0..nllen {
				put(&mut p1, k, self.nget(ln, k));
			}
			for k in nllen..ollen {
				put(&mut p1, k, ZR_SP);
			}
			tmp = Some(p1);
			nllen = ollen;
		}
		let tmp = tmp.as_ref();

		// 2: can we clear to the end of the line, and from where? With
		// automatic margins, not when another line follows (cut and paste).
		let mut col_cleareol;
		if hasam && ln < self.d.nlnct - 1 && rnllen == winw {
			col_cleareol = -2;
		} else {
			col_cleareol = -1;
			if term.tccan(Cap::ClearEol) && (nllen == winw || self.d.put_rpmpt != self.d.oput_rpmpt) {
				let mut i = nllen;
				while i > 0 && self.eq(ZR_SP, self.nlat(tmp, ln, i - 1)) {
					i -= 1;
				}
				let mut j = ollen;
				while j > 0 && self.eq(self.olat(ol, j - 1), ZR_SP) {
					j -= 1;
				}
				if j > i + term.tclen(Cap::ClearEol) as i32
					|| (nllen == winw && self.eq(ZR_SP, self.nlat(tmp, ln, winw - 1)))
				{
					col_cleareol = i;
				}
			}
		}

		// 2b: automargin niceness, good for cut and paste.
		let (mut ni, mut oi, mut ccs) = (0i32, 0i32, 0i32);
		if hasam && self.d.vcs == winw {
			if self.nhas(self.d.vln) && self.nget(self.d.vln, self.d.vcs + 1).chr == u32::from(b'\n') {
				self.d.vln += 1;
				self.d.vcs = 1;
				let first = self.nget(self.d.vln, 0);
				if self.nhas(self.d.vln) && first.chr != 0 {
					self.zputc(first);
				} else {
					self.zputc(ZR_SP);
				}
				if ln == self.d.vln {
					ni += 1;
					if self.olat(ol, oi).chr != 0 {
						oi += 1;
					}
					ccs = 1;
				}
			} else {
				self.d.vln += 1;
				self.d.vcs = 0;
				self.zputc(ZR_NL);
			}
		}
		let mut ins_last = false;
		let mut char_ins = 0;

		// 2c: on the first line, start after the prompt.
		if ln == 0 && self.d.lpromptw != 0 {
			let i = self.d.lpromptw - ccs;
			let j = self.ol_strlen(ol, oi);
			ni += i;
			oi += i.min(j);
			ccs = self.d.lpromptw;
		}

		// Realign to a real character.
		while self.nlat(tmp, ln, ni).chr == WEOF {
			ni += 1;
			ccs += 1;
			self.d.vcs += 1;
			if self.olat(ol, oi).chr != 0 {
				oi += 1;
			}
		}

		// 3: the main display loop.
		loop {
			let (n0, o0) = (self.nlat(tmp, ln, ni), self.olat(ol, oi));
			if n0.chr != WEOF && o0.chr != WEOF {
				if n0.chr != 0
					&& o0.chr != 0
					&& self.eq(self.olat(ol, oi + 1), self.nlat(tmp, ln, ni + 1))
				{
					// Skip past all matching characters (only if the second
					// ones match).
					let ccs_was = ccs;
					while self.nlat(tmp, ln, ni).chr != 0
						&& self.eq(self.olat(ol, oi), self.nlat(tmp, ln, ni))
					{
						ni += 1;
						oi += 1;
						ccs += 1;
					}
					// Point at real characters.
					while (self.nlat(tmp, ln, ni).chr == WEOF || self.olat(ol, oi).chr == WEOF)
						&& ccs > ccs_was
					{
						ni -= 1;
						oi -= 1;
						ccs -= 1;
					}
				}

				if self.nlat(tmp, ln, ni).chr == 0 {
					if ccs == winw && hasam && char_ins > 0 && ins_last && self.d.vcs != winw {
						// Write the last character in the line.
						ni -= 1;
						self.moveto(ln, winw - 1);
						let e = self.nlat(tmp, ln, ni);
						self.zputc(e);
						self.d.vcs += 1;
						return;
					}
					if char_ins <= 0 || ccs >= winw {
						// Written everything.
						return;
					}
					if term.tccan(Cap::ClearEol)
						&& char_ins >= term.tclen(Cap::ClearEol) as i32
						&& col_cleareol != -2
					{
						// Junk on the right yet to clear.
						col_cleareol = 0;
					}
				}

				self.moveto(ln, ccs);

				// Finish quickly if we can.
				if col_cleareol >= 0 && ccs >= col_cleareol {
					self.tcoutclear(Cap::ClearEol);
					return;
				}

				// The new text is written; clear the rubbish inserts left.
				if self.nlat(tmp, ln, ni).chr == 0 {
					let mut i = (winw - ccs).min(char_ins);
					if term.tccan(Cap::Del) && self.tcdelcost(i) <= i + 1 {
						self.tcmultout(Cap::Del, Cap::MultDel, i);
					} else {
						self.d.vcs += i;
						while i > 0 {
							self.zputc(ZR_SP);
							i -= 1;
						}
					}
					return;
				}

				// At the end of the old line: dump what we must and clear
				// if we can.
				if self.olat(ol, oi).chr == 0 {
					let mut i = if col_cleareol >= 0 {
						col_cleareol
					} else {
						nllen
					};
					i -= self.d.vcs;
					// Only a bug elsewhere makes it negative.
					i = i.max(0);
					self.zwrite_from(tmp, ln, ni, i);
					self.d.vcs += i;
					if col_cleareol >= 0 {
						self.tcoutclear(Cap::ClearEol);
					}
					return;
				}

				// Inserting and deleting characters: not with a right
				// prompt.
				let (n0, o0) = (self.nlat(tmp, ln, ni), self.olat(ol, oi));
				let (n1, o1) = (self.nlat(tmp, ln, ni + 1), self.olat(ol, oi + 1));
				if (ln != 0 || !self.d.put_rpmpt || !self.d.oput_rpmpt)
					&& o0.chr != WEOF
					&& n0.chr != WEOF
					&& n1.chr != 0
					&& o1.chr != 0
					&& !self.eq(o1, n1)
				{
					// Deleting: a matching run further on in the old line
					// may make deleting the characters before it cheaper.
					if term.tccan(Cap::Del) {
						let mut done = false;
						let mut i = 1;
						while self.olat(ol, oi + i).chr != 0 {
							if self.tcdelcost(i) < self.wpfxlen(ol, oi + i, tmp, ln, ni) {
								// Some terminals fill the cells added at the end
								// with the current attributes.
								self.clearattributes();
								self.tcmultout(Cap::Del, Cap::MultDel, i);
								oi += i;
								char_ins -= i;
								while self.olat(ol, oi).chr == WEOF {
									oi += 1;
									char_ins -= 1;
								}
								done = true;
								break;
							}
							i += 1;
						}
						if done {
							continue;
						}
					}
					// Inserting: what is pushed off the right should go,
					// but not on the last line lest the terminal scroll.
					if term.tccan(Cap::Ins) && self.d.vln != self.i.lines - 1 {
						let mut done = false;
						let mut i = 1;
						while self.nlat(tmp, ln, ni + i).chr != 0 {
							if self.tcinscost(i) < self.wpfxlen(ol, oi, tmp, ln, ni + i) {
								self.tcmultout(Cap::Ins, Cap::MultIns, i);
								self.zwrite_from(tmp, ln, ni, i);
								ni += i;
								while self.nlat(tmp, ln, ni).chr == WEOF {
									ni += 1;
									i += 1;
								}
								char_ins += i;
								self.d.vcs += i;
								ccs = self.d.vcs;
								// Pushed off the right: truncate the old line.
								let mut k = 0;
								while self.olat(ol, oi + k).chr != 0 && k < winw - ccs {
									k += 1;
								}
								while self.olat(ol, oi + k).chr == WEOF {
									k += 1;
								}
								if k >= winw - ccs {
									// At a real character, not a WEOF filling
									// the width.
									while self.olat(ol, oi + k - 1).chr == WEOF {
										k -= 1;
									}
									self.olset(ol, oi + k, ZR_ZR);
									ins_last = true;
								}
								done = true;
								break;
							}
							i += 1;
						}
						if done {
							continue;
						}
					}
				}
			}
			// No tricks: dump one character and keep trying (tidying up a
			// funny-width character at the end of the new line).
			if self.nlat(tmp, ln, ni).chr == 0 {
				break;
			}
			loop {
				let (n, o) = (self.nlat(tmp, ln, ni), self.olat(ol, oi));
				// An attribute on here before but not now: turn it off.
				let now_off = o.atr & !n.atr & TXT_ATTR_ON_MASK;
				if now_off != 0 {
					self.settextattributes(off_from_on(now_off));
				}
				// Called for WEOF too, to keep the attributes right.
				self.zputc(n);
				ni += 1;
				if o.chr != 0 {
					oi += 1;
				}
				ccs += 1;
				self.d.vcs += 1;
				// Always overwrite the whole width of a character that was
				// there before.
				let (n, o) = (self.nlat(tmp, ln, ni), self.olat(ol, oi));
				if !((o.chr == WEOF && n.chr != 0) || (n.chr == WEOF && o.chr != 0)) {
					break;
				}
			}
		}
	}

	/// zsh `ZR_strlen(nbuf[ln])`.
	fn nbuf_strlen(&self, ln: i32) -> i32 {
		usize::try_from(ln)
			.ok()
			.and_then(|ln| self.d.nbuf.get(ln)?.as_deref())
			.map_or(0, |l| zr_strlen(l, 0))
	}

	/// zsh `ZR_strlen(obuf[ln])`.
	fn obuf_strlen(&self, ln: i32) -> i32 {
		self.ol_strlen(usize::try_from(ln).ok(), 0)
	}

	/// zsh `ZR_strlen(ol)` from `i` of old line `ol`.
	fn ol_strlen(&self, ol: Option<usize>, i: i32) -> i32 {
		ol.and_then(|ln| self.d.obuf.get(ln)?.as_deref())
			.map_or(0, |l| zr_strlen(l, i))
	}

	/// zsh `moveto`: move to line `ln` (relative to the prompt line),
	/// absolute column `cl`.
	pub(super) fn moveto(&mut self, ln: i32, cl: i32) {
		if self.d.vcs == self.d.winw {
			self.d.vln += 1;
			self.d.vcs = 0;
			if self.i.term.hasam {
				let vln = self.d.vln;
				let first = self.nget(vln, 0);
				let rep = if vln < self.d.nlnct && self.nhas(vln) && first.chr != 0 {
					first
				} else {
					ZR_SP
				};
				self.zputc(rep);
				self.zputc(ZR_CR);
				if vln < self.d.olnct
					&& let Some(l) = usize::try_from(vln)
						.ok()
						.and_then(|v| self.d.obuf.get_mut(v)?.as_deref_mut())
					&& at(l, 0).chr != 0
				{
					put(l, 0, rep);
				}
			} else {
				self.zputc(ZR_CR);
				self.zputc(ZR_NL);
			}
		}

		if ln == self.d.vln && cl == self.d.vcs {
			return;
		}

		// Up.
		if ln < self.d.vln {
			self.tcmultout(Cap::Up, Cap::MultUp, self.d.vln - ln);
			self.d.vln = ln;
		}
		// Down; newlines where we might go off the end of the screen.
		while ln > self.d.vln {
			if self.d.vln < self.d.vmaxln - 1 {
				if ln > self.d.vmaxln - 1 {
					if self.tc_downcurs(self.d.vmaxln - 1 - self.d.vln) != 0 {
						self.d.vcs = 0;
					}
					self.d.vln = self.d.vmaxln - 1;
				} else {
					if self.tc_downcurs(ln - self.d.vln) != 0 {
						self.d.vcs = 0;
					}
					self.d.vln = ln;
					continue;
				}
			}
			// Safety precaution.
			self.zputc(ZR_CR);
			self.d.vcs = 0;
			while ln > self.d.vln {
				self.zputc(ZR_NL);
				self.d.vln += 1;
			}
		}

		if cl != self.d.vcs {
			self.singmoveto(cl);
		}
	}

	/// zsh `tcmultout`: `ct` times `cap`, or `multcap` with argument `ct`
	/// when that is shorter; false when the terminal has neither.
	pub(super) fn tcmultout(&mut self, cap: Cap, multcap: Cap, ct: i32) -> bool {
		let t = self.i.term;
		if t.tccan(multcap)
			&& (!t.tccan(cap) || t.tclen(multcap) as i64 <= t.tclen(cap) as i64 * i64::from(ct))
		{
			self.tcoutarg(multcap, ct);
			true
		} else if t.tccan(cap) {
			for _ in 0..ct {
				self.tcout(cap);
			}
			true
		} else {
			false
		}
	}

	/// zsh `tc_rightcurs`: move `ct` columns right.
	fn tc_rightcurs(&mut self, mut ct: i32) {
		let t = self.i.term;
		let cl = ct + self.d.vcs;
		let mut i = self.d.vcs;

		// A multiple right if we can: the most reliable.
		if t.tccan(Cap::MultRight) {
			self.tcoutarg(Cap::MultRight, ct);
			return;
		}
		// An absolute horizontal position.
		if t.tccan(Cap::HorizPos) {
			self.tcoutarg(Cap::HorizPos, cl);
			return;
		}
		// Tabs (zsh's `oxtabs` is never set: tabs are not expanded).
		if t.tccan(Cap::NextTab) && (self.d.vcs | 7) < cl {
			i = (self.d.vcs | 7) + 1;
			self.tcout(Cap::NextTab);
			while i + 8 <= cl {
				self.tcout(Cap::NextTab);
				i += 8;
			}
			ct = cl - i;
			if ct == 0 {
				return;
			}
		}

		// Otherwise write the video buffer; within the prompt, from the
		// left column with the whole prompt.
		if self.d.vln == 0 && i < self.d.lpromptw && !self.d.term_short {
			let ed = self.i.ed;
			let lprompt = &ed.lprompt;
			if t.tccan(Cap::Right)
				&& t.tclen(Cap::Right) as i64 * i64::from(ct) <= i64::from(ztrlen(lprompt))
			{
				// Cheaper than reprinting the whole prompt.
				for _ in 0..(self.d.lpromptw - i) {
					self.tcout(Cap::Right);
				}
			} else {
				if i != 0 {
					self.zputc(ZR_CR);
				}
				self.tcmultout(Cap::Up, Cap::MultUp, self.d.lprompth - 1);
				self.zputs(lprompt);
				if self.d.lpromptwof == self.d.winw {
					// Works with both hasam and !hasam.
					self.out.push(b'\n');
				}
			}
			i = self.d.lpromptw;
			ct = cl - i;
		}

		if self.nhas(self.d.vln) {
			let vln = self.d.vln;
			let mut j = 0;
			while self.nget(vln, j).chr != 0 && j < i {
				j += 1;
			}
			if j == i {
				while ct > 0 {
					let e = self.nget(vln, j);
					if e.chr == 0 {
						break;
					}
					self.zputc(e);
					ct -= 1;
					j += 1;
				}
			}
		}
		// Not my fault your terminal can't go right.
		while ct > 0 {
			self.zputc(ZR_SP);
			ct -= 1;
		}
	}

	/// zsh `tc_downcurs`: -1 when newlines did it (the cursor is in
	/// column 0), else 0.
	pub(super) fn tc_downcurs(&mut self, ct: i32) -> i32 {
		if ct != 0 && !self.tcmultout(Cap::Down, Cap::MultDown, ct) {
			for _ in 0..ct {
				self.zputc(ZR_NL);
			}
			self.zputc(ZR_CR);
			return -1;
		}
		0
	}

	/// zsh `singmoveto`: move to column `pos` of the current line.
	fn singmoveto(&mut self, pos: i32) {
		if pos == self.d.vcs {
			return;
		}
		// The cheapest movements for terminals without multiple
		// movement capabilities.
		if (!self.i.term.tccan(Cap::MultLeft) || pos == 0) && pos <= self.d.vcs / 2 {
			self.zputc(ZR_CR);
			self.d.vcs = 0;
		}
		if pos < self.d.vcs {
			self.tcmultout(Cap::Left, Cap::MultLeft, self.d.vcs - pos);
		} else if pos > self.d.vcs {
			self.tc_rightcurs(pos - self.d.vcs);
		}
		self.d.vcs = pos;
	}

	/// zsh `singlerefresh`: show as much of the line as fits on one screen
	/// line (`singlelinezle`, or a terminal that cannot move up).
	#[expect(clippy::too_many_lines, reason = "a faithful port of one C function")]
	pub(super) fn singlerefresh(
		&mut self,
		tmpline: &[char],
		tmpcs: usize,
		specials: &[(i64, i64, Zattr); N_SPECIAL_HIGHLIGHTS],
	) {
		let tmpll = tmpline.len();
		let prelen = self.i.ed.predisplay.len() as i64;
		let hasam = i32::from(self.i.term.hasam);
		let winw = self.d.winw;
		let lpw = self.d.lpromptw;
		let owinpos = self.d.winpos;
		let owinprompt = self.d.winprompt;
		let mut nvcs = 0i32;

		self.d.nlnct = 1;
		// The size of the new line buffer.
		let mut vsiz = 1 + lpw;
		let mut t0 = 0;
		while t0 < tmpll {
			let c = tmpline[t0];
			if c == '\t' {
				vsiz = (vsiz | 7) + 2;
			} else if wcwidth(c) > 0 {
				vsiz += wcwidth(c);
				if self.i.combiningchars && is_basechar(c) {
					while t0 + 1 < tmpll && is_combining(tmpline[t0 + 1]) {
						t0 += 1;
					}
				}
			} else if iswcntrl(c) && u32::from(c) <= 0xff {
				vsiz += 2;
			} else {
				vsiz += 10;
			}
			t0 += 1;
		}
		let mut vbuf: Line = vec![ZR_ZR; usize::try_from(vsiz).unwrap_or(0) + 1];

		// The prompt is not copied into the video buffer.
		for k in 0..lpw {
			put(&mut vbuf, k, ZR_SP);
		}
		let mut vp = lpw;
		put(&mut vbuf, vp, ZR_ZR);

		let mut t0 = 0usize;
		while t0 < tmpll {
			let (base_on, base_off) =
				self.region_atr(specials, t0 as i64, tmpll as i64, prelen, 0, true);
			let (all_on, all_off) = self.all_atr(base_on);
			let c = tmpline[t0];
			if c == '\t' {
				put(&mut vbuf, vp, ZR_SP);
				vp += 1;
				while vp & 7 != 0 {
					put(&mut vbuf, vp, ZR_SP);
					vp += 1;
				}
				let e = at(&vbuf, vp - 1);
				put(&mut vbuf, vp - 1, Elem { chr: e.chr, atr: e.atr | base_off });
			} else if c == '\n' {
				put(&mut vbuf, vp, Elem { chr: u32::from(b'\\'), atr: all_on });
				put(&mut vbuf, vp + 1, Elem { chr: u32::from(b'n'), atr: all_on | all_off });
				vp += 2;
			} else if wcwidth(c) > 0 {
				let mut width = wcwidth(c);
				let mut ichars = 1;
				if self.i.combiningchars && is_basechar(c) {
					while t0 + ichars < tmpll && is_combining(tmpline[t0 + ichars]) {
						ichars += 1;
					}
				}
				let atr = base_on | base_off;
				let e = if ichars > 1 {
					let idx = self.addmultiword(&tmpline[t0..t0 + ichars]);
					Elem { chr: idx, atr: atr | TXT_MULTIWORD_MASK }
				} else {
					Elem { chr: u32::from(c), atr }
				};
				put(&mut vbuf, vp, e);
				vp += 1;
				width -= 1;
				while width > 0 {
					put(&mut vbuf, vp, Elem { chr: WEOF, atr });
					vp += 1;
					width -= 1;
				}
				t0 += ichars - 1;
			} else if iswcntrl(c) && u32::from(c) <= 0xff {
				// zsh shows the character after the control character.
				t0 += 1;
				let t = tmpline.get(t0).map_or(0, |&c| u32::from(c));
				put(&mut vbuf, vp, Elem { chr: u32::from(b'^'), atr: all_on });
				put(&mut vbuf, vp + 1, Elem { chr: ctrl_char(t), atr: all_on | all_off });
				vp += 2;
			} else {
				let n = u32::from(c);
				let disp = if n > 0xffff {
					format!("<{n:08x}>")
				} else {
					format!("<{n:04x}>")
				};
				let mut started = false;
				for b in disp.bytes() {
					put(&mut vbuf, vp, Elem { chr: u32::from(b), atr: all_on });
					started = true;
					vp += 1;
				}
				if started {
					let e = at(&vbuf, vp - 1);
					put(&mut vbuf, vp - 1, Elem { chr: e.chr, atr: e.atr | all_off });
				}
			}
			if t0 == tmpcs {
				nvcs = vp - 1;
			}
			t0 += 1;
		}
		if t0 == tmpcs {
			nvcs = vp;
		}
		put(&mut vbuf, vp, ZR_ZR);

		// The part of the line buffer to show.
		if self.d.winpos == -1 {
			self.d.winpos = 0;
		}
		let mut winpos = self.d.winpos;
		if (winpos != 0 && nvcs < winpos + 1) || nvcs > winpos + winw - 2 {
			winpos = (nvcs - (winw - hasam) / 2).max(0);
		}
		if winpos != 0 {
			// The line continues to the left.
			put(&mut vbuf, winpos, Elem::ch('<'));
		}
		if zr_strlen(&vbuf, winpos) > winw - hasam {
			// The line continues to the right.
			put(&mut vbuf, winpos + winw - hasam - 1, Elem::ch('>'));
			put(&mut vbuf, winpos + winw - hasam, ZR_ZR);
		}
		self.d.winpos = winpos;
		let mut k = 0;
		loop {
			let e = at(&vbuf, winpos + k);
			self.nset(0, k, e);
			if e.chr == 0 {
				break;
			}
			k += 1;
		}
		nvcs -= winpos;

		self.d.winprompt = if winpos < lpw {
			// Skip the start of the buffer standing for the prompt.
			lpw - winpos
		} else {
			0
		};
		if winpos != owinpos && self.d.winprompt != 0 {
			// The part of the left prompt that fits: skip the first winpos
			// characters, but write those in `%{…%}`.
			self.singmoveto(0);
			let ed = self.i.ed;
			let lp = &ed.lprompt;
			let (mut skipping, mut skipchars) = (false, winpos);
			let mut p = 0;
			while p < lp.len() {
				if lp[p] == INPAR {
					skipping = true;
					p += 1;
				} else if lp[p] == OUTPAR {
					skipping = false;
					p += 1;
				} else {
					let (len, cc) = mb_metacharlenconv(lp, p);
					// zsh loops forever on a lone token here; step over it.
					let mut len = len.max(1);
					if skipping || skipchars == 0 {
						while len > 0 {
							if cc.is_none() {
								self.out.push(b'?');
							} else if lp[p] == META {
								len -= 1;
								p += 1;
								self.out.push(lp.get(p).map_or(0, |&b| b ^ 32));
							} else {
								self.out.push(lp[p]);
							}
							p += 1;
							len = len.saturating_sub(1);
						}
					} else {
						skipchars -= 1;
						p += len;
					}
				}
			}
			self.d.vcs = self.d.winprompt;
		}

		// The visible part of the line buffer.
		let mut t0 = self.d.winprompt;
		let mut vp = self.d.winprompt;
		let mut rop = self.d.winprompt;
		loop {
			// Skip matching characters, carefully where a prompt was.
			if vp >= owinprompt {
				while self.nget(0, vp).chr != 0 && self.eq(self.olat(Some(0), rop), self.nget(0, vp)) {
					t0 += 1;
					vp += 1;
					rop += 1;
				}
			}
			if self.nget(0, vp).chr == 0 && self.olat(Some(0), rop).chr == 0 {
				break;
			}
			self.singmoveto(t0);
			if self.olat(Some(0), rop).chr == 0 {
				let n = self.nbuf_strlen_from(0, vp);
				if n != 0 {
					self.zwrite_from(None, 0, vp, n);
				}
				self.d.vcs += n;
				break;
			}
			if self.nget(0, vp).chr == 0 {
				if self.i.term.tccan(Cap::ClearEol) {
					self.tcoutclear(Cap::ClearEol);
				} else {
					while self.olat(Some(0), rop).chr != 0 {
						rop += 1;
						self.zputc(ZR_SP);
						self.d.vcs += 1;
					}
				}
				break;
			}
			let e = self.nget(0, vp);
			self.zputc(e);
			self.d.vcs += 1;
			t0 += 1;
			vp += 1;
			rop += 1;
		}
		// The new cursor position.
		self.singmoveto(nvcs);
		self.bufswap();
	}

	/// zsh `ZR_strlen(nbuf[ln] + i)`.
	fn nbuf_strlen_from(&self, ln: i32, i: i32) -> i32 {
		usize::try_from(ln)
			.ok()
			.and_then(|ln| self.d.nbuf.get(ln)?.as_deref())
			.map_or(0, |l| zr_strlen(l, i))
	}
}
