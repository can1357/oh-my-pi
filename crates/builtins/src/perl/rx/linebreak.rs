//! The Unicode Line Breaking Algorithm (UAX #14, Unicode 13.0) behind perl's
//! `\b{lb}`: the default rules, with LB25 replaced by the numeric tailoring
//! of the standard's Example 7, as `perlrebackslash` documents.

use super::linebreak_data::RANGES;

/// Line_Break classes after rule LB1, with the distinctions later rules need.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Lb {
	BK, CR, LF, NL, SP, ZW, ZWJ, CM, WJ, GL, BA, HY, CL, CP, EX, IS, SY, OP, QU, NS, B2, CB, BB, HL,
	IN, AL, NU, PR, PO, ID, EB, EM, JL, JV, JT, H2, H3, RI,
	/// `OP` with East_Asian_Width F, W or H (excluded from LB30).
	OPEA,
	/// Unassigned Extended_Pictographic, otherwise `ID` (LB30b).
	IDEPCN,
}

use Lb::*;

impl Lb {
	fn of(c: char) -> Lb {
		let cp = u32::from(c);
		let i = RANGES.partition_point(|&(first, _, _)| first <= cp);
		match i.checked_sub(1).map(|i| RANGES[i]) {
			Some((_, last, class)) if cp <= last => class,
			_ => AL,
		}
	}

	/// The class as most rules see it.
	fn base(self) -> Lb {
		match self { OPEA => OP, IDEPCN => ID, other => other }
	}
}

/// Byte offsets in `text` where `\b{lb}` matches: every allowed break
/// opportunity, including the end of the text (LB3) but never its start (LB2).
pub(in crate::perl) fn boundaries(text: &str) -> Vec<usize> {
	let offsets: Vec<usize> = text.char_indices().map(|(i, _)| i).collect();
	let orig: Vec<Lb> = text.chars().map(Lb::of).collect();
	let n = orig.len();
	// LB9/LB10: combining marks join a preceding base, otherwise act as AL.
	let mut eff = orig.clone();
	let mut absorbed = vec![false; n];
	for k in 0..n {
		if matches!(orig[k], CM | ZWJ) {
			if k > 0 && !matches!(orig[k - 1].base(), BK | CR | LF | NL | SP | ZW) {
				eff[k] = eff[k - 1];
				absorbed[k] = true;
			} else {
				eff[k] = AL;
			}
		}
	}
	let mut out = Vec::new();
	for k in 1..n {
		if breaks(&orig, &eff, &absorbed, k) { out.push(offsets[k]); }
	}
	if n > 0 { out.push(text.len()); }
	out
}

/// The last character of the unit (base plus absorbed marks) before the one
/// ending at `index`.
fn previous_unit(absorbed: &[bool], index: usize) -> Option<usize> {
	let mut u = index;
	while absorbed[u] { u -= 1; }
	u.checked_sub(1)
}

/// Whether the algorithm allows a break before character `k`.
fn breaks(orig: &[Lb], eff: &[Lb], absorbed: &[bool], k: usize) -> bool {
	let before = orig[k - 1].base();
	let after = orig[k].base();
	// LB4, LB5: hard breaks.
	if before == BK { return true; }
	if before == CR && after == LF { return false; }
	if matches!(before, CR | LF | NL) { return true; }
	// LB6, LB7.
	if matches!(after, BK | CR | LF | NL | SP | ZW) { return false; }
	// LB8: ZW SP* ÷
	let mut j = k - 1;
	while orig[j] == SP && j > 0 { j -= 1; }
	if orig[j] == ZW { return true; }
	// LB8a, LB9.
	if before == ZWJ || absorbed[k] { return false; }

	let a = eff[k - 1].base();
	let b = eff[k].base();
	// The unit before any spaces preceding the break.
	let mut s = k - 1;
	while eff[s] == SP && s > 0 { s -= 1; }
	let p = if eff[s] == SP { SP } else { eff[s].base() };

	// LB11 .. LB13
	if a == WJ || b == WJ { return false; }
	if a == GL { return false; }
	if b == GL && !matches!(a, SP | BA | HY) { return false; }
	if matches!(b, CL | CP | EX | IS | SY) { return false; }
	// LB14 .. LB17: with intervening spaces.
	if p == OP { return false; }
	if p == QU && b == OP { return false; }
	if matches!(p, CL | CP) && b == NS { return false; }
	if p == B2 && b == B2 { return false; }
	// LB18 .. LB22
	if a == SP { return true; }
	if a == QU || b == QU { return false; }
	if a == CB || b == CB { return true; }
	if matches!(b, BA | HY | NS) || a == BB { return false; }
	if matches!(a, HY | BA) && previous_unit(absorbed, k - 1).is_some_and(|u| eff[u].base() == HL) { return false; }
	if a == SY && b == HL { return false; }
	if b == IN { return false; }
	// LB23 .. LB24
	if matches!(a, AL | HL) && b == NU || a == NU && matches!(b, AL | HL) { return false; }
	if a == PR && matches!(b, ID | EB | EM) || matches!(a, ID | EB | EM) && b == PO { return false; }
	if matches!(a, PR | PO) && matches!(b, AL | HL) || matches!(a, AL | HL) && matches!(b, PR | PO) { return false; }
	// LB25, tailored (UAX #14 Example 7) for numeric expressions.
	if numeric(eff, absorbed, k) { return false; }
	// LB26, LB27: Korean syllables.
	if a == JL && matches!(b, JL | JV | H2 | H3) { return false; }
	if matches!(a, JV | H2) && matches!(b, JV | JT) { return false; }
	if matches!(a, JT | H3) && b == JT { return false; }
	if matches!(a, JL | JV | JT | H2 | H3) && b == PO || a == PR && matches!(b, JL | JV | JT | H2 | H3) { return false; }
	// LB28, LB29
	if matches!(a, AL | HL) && matches!(b, AL | HL) { return false; }
	if a == IS && matches!(b, AL | HL) { return false; }
	// LB30: excluding East Asian brackets (no Unicode 13 `CP` is East Asian wide).
	if matches!(a, AL | HL | NU) && eff[k] == OP { return false; }
	if eff[k - 1] == CP && matches!(b, AL | HL | NU) { return false; }
	// LB30a: regional indicator pairs.
	if a == RI && b == RI {
		let mut count = 0;
		let mut u = Some(k - 1);
		while let Some(i) = u && eff[i] == RI {
			count += 1;
			u = previous_unit(absorbed, i);
		}
		return count % 2 == 0;
	}
	// LB30b
	if b == EM && (a == EB || eff[k - 1] == IDEPCN) { return false; }
	// LB31
	true
}

/// Example 7's replacement for LB25:
/// `(PR|PO) × (OP|HY)? NU`, `(OP|HY) × NU`, `NU × (NU|SY|IS)`,
/// `NU (NU|SY|IS)* × (NU|SY|IS|CL|CP)`, `NU (NU|SY|IS)* (CL|CP)? × (PR|PO)`.
fn numeric(eff: &[Lb], absorbed: &[bool], k: usize) -> bool {
	let a = eff[k - 1].base();
	let b = eff[k].base();
	let next = || {
		let mut j = k + 1;
		while j < eff.len() && absorbed[j] { j += 1; }
		eff.get(j).map(|c| c.base())
	};
	if matches!(a, PR | PO) && (b == NU || matches!(b, OP | HY) && next() == Some(NU)) { return true; }
	if matches!(a, OP | HY) && b == NU { return true; }
	// Whether the unit ending at `i` closes a run NU (NU|SY|IS)*.
	let number_run = |i: usize| {
		let mut u = Some(i);
		while let Some(j) = u && matches!(eff[j].base(), NU | SY | IS) {
			if eff[j].base() == NU { return true; }
			u = previous_unit(absorbed, j);
		}
		false
	};
	if matches!(b, NU | SY | IS | CL | CP) && matches!(a, NU | SY | IS) && number_run(k - 1) { return true; }
	if matches!(b, PR | PO) {
		let end = if matches!(a, CL | CP) { previous_unit(absorbed, k - 1) } else { Some(k - 1) };
		if end.is_some_and(number_run) { return true; }
	}
	false
}

#[cfg(test)]
mod tests {
	use super::boundaries;

	#[test]
	fn breaks_after_spaces_but_not_inside_numbers_or_before_closers() {
		assert_eq!(boundaries("a b"), [2, 3]);
		assert_eq!(boundaries("$3.14)."), [7]);
		assert_eq!(boundaries("a\u{300} b"), [4, 5]);
		assert_eq!(boundaries("x\r\ny"), [3, 4]);
		assert_eq!(boundaries("\u{1F1E6}\u{1F1E6}\u{1F1E6}"), [8, 12]);
		assert!(boundaries("").is_empty());
	}
}
