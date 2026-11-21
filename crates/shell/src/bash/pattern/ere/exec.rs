//! Matching: glibc's `re_search_internal` + `set_regs`, without its DFA.
//!
//! 1. A Pike-style simulation finds the leftmost start and, from it, the
//!    longest end (threads carry their start; the earliest start wins a node).
//!    O(n·m) for n units of text and m nodes.
//! 2. A backward pass over that span marks, per position, the nodes from which
//!    the end is still reachable (glibc's "sifted states"). O(n·m) time, n·m
//!    bits.
//! 3. A walk from the start node follows, at each fork, the first viable
//!    successor in glibc's node order and records group boundaries exactly as
//!    glibc's `update_regs` does. Without back-references it never backtracks.
//!
//! Back-references make matching NP-hard. Steps 1 and 2 then treat `\n` as
//! "any text", which over-approximates; candidate spans are tried leftmost
//! first, longest first, and step 3 backtracks with a fail stack (as glibc
//! does) to check the references. That search is capped at [`BUDGET`]
//! steps; beyond it the subject does not match.

use core::ops::Range;

use crate::bash::pattern::ere::{
	nfa::{Op, Prog},
	parse::Anchor,
	unit::Mode,
};

/// Work limit for patterns with back-references.
const BUDGET: usize = 1 << 22;

/// The context zero-width assertions test at one position.
#[derive(Clone, Copy, Debug)]
struct Ctx {
	first:     bool,
	last:      bool,
	prev_word: bool,
	next_word: bool,
}

impl Ctx {
	fn new(mode: Mode, first: bool, prev: Option<u32>, next: Option<u32>) -> Self {
		Self {
			first,
			last: next.is_none(),
			prev_word: prev.is_some_and(|u| mode.is_word(u)),
			next_word: next.is_some_and(|u| mode.is_word(u)),
		}
	}

	const fn holds(self, anchor: Anchor) -> bool {
		match anchor {
			Anchor::First => self.first,
			Anchor::Last => self.last,
			Anchor::WordFirst => !self.prev_word && self.next_word,
			Anchor::WordLast => self.prev_word && !self.next_word,
			Anchor::InsideWord => self.prev_word && self.next_word,
			Anchor::InsideNotWord => !self.prev_word && !self.next_word,
		}
	}
}

/// Find the match and its groups; `[0]` is the whole match.
pub fn captures(prog: &Prog, mode: Mode, text: &[u8]) -> Option<Vec<Option<Range<usize>>>> {
	let mut pike = Pike::new(prog, mode, text);
	if !prog.backrefs {
		let mut unlimited = usize::MAX;
		let (start, end) = pike.run(0, true, &mut unlimited)?.best?;
		let viable = Viable::new(prog, mode, text, start, end);
		let regs = Walk::new(prog, mode, text, &viable, false).run(&mut unlimited)?;
		return Some(output(&regs));
	}
	let mut budget = BUDGET;
	let (mut start, _) = pike.run(0, true, &mut budget)?.best?;
	loop {
		let hits = pike.run(start, false, &mut budget)?;
		for &end in hits.ends.iter().rev() {
			budget = budget.checked_sub((end - start + 1).saturating_mul(prog.nodes.len()))?;
			let viable = Viable::new(prog, mode, text, start, end);
			if let Some(regs) = Walk::new(prog, mode, text, &viable, true).run(&mut budget) {
				return Some(output(&regs));
			}
			if budget == 0 {
				return None;
			}
		}
		if start >= text.len() {
			return None;
		}
		start += mode.decode(text, start).1;
	}
}

fn output(regs: &[Reg]) -> Vec<Option<Range<usize>>> {
	regs
		.iter()
		.map(|reg| match (reg.so, reg.eo) {
			(Some(so), Some(eo)) if so <= eo => Some(so..eo),
			_ => None,
		})
		.collect()
}

/// What a forward run found.
struct Hits {
	/// Leftmost start and the longest end from it.
	best: Option<(usize, usize)>,
	/// Every end reachable from the start (single-start runs only).
	ends: Vec<usize>,
}

/// Forward NFA simulation without submatches.
struct Pike<'a> {
	prog:       &'a Prog,
	mode:       Mode,
	text:       &'a [u8],
	/// `mark[n] == generation`: node `n` is in the current closure.
	mark:       Vec<u32>,
	generation: u32,
	/// Start of the thread that holds node `n`.
	start:      Vec<usize>,
	stack:      Vec<usize>,
}

impl<'a> Pike<'a> {
	fn new(prog: &'a Prog, mode: Mode, text: &'a [u8]) -> Self {
		let count = prog.nodes.len();
		Self {
			prog,
			mode,
			text,
			mark: vec![0; count],
			generation: 0,
			start: vec![0; count],
			stack: Vec::new(),
		}
	}

	/// Run from `from`; with `all_starts`, threads also start at every later
	/// position until a match is found. `None` when the budget runs out.
	fn run(&mut self, from: usize, all_starts: bool, budget: &mut usize) -> Option<Hits> {
		let (prog, mode, text) = (self.prog, self.mode, self.text);
		let mut hits = Hits { best: None, ends: Vec::new() };
		let mut seeds: Vec<(usize, usize)> = Vec::new();
		let mut list = Vec::new();
		let mut prev = mode.decode_before(text, from);
		let mut pos = from;
		loop {
			let cur = (pos < text.len()).then(|| mode.decode(text, pos));
			let ctx = Ctx::new(mode, pos == 0, prev, cur.map(|(u, _)| u));
			if pos == from || (all_starts && hits.best.is_none()) {
				seeds.push((prog.init, pos));
			}
			self.closure(&seeds, ctx, &mut list);
			*budget = budget.checked_sub(list.len() + 1)?;
			seeds.clear();
			let folded = cur.map(|(u, _)| mode.fold(u));
			for &n in &list {
				let start = self.start[n];
				if hits.best.is_some_and(|(best, _)| start > best) {
					continue;
				}
				let node = prog.nodes[n];
				match node.op {
					Op::End => {
						if hits
							.best
							.is_none_or(|(best, end)| start < best || pos > end)
						{
							hits.best = Some((start, pos));
						}
						if !all_starts {
							hits.ends.push(pos);
						}
					},
					Op::BackRef(_) => {
						if cur.is_some() {
							seeds.push((n, start));
						}
					},
					op => {
						if folded.is_some_and(|u| prog.accepts(mode, op, u)) {
							seeds.push((node.next, start));
						}
					},
				}
			}
			let Some((unit, len)) = cur else { break };
			if seeds.is_empty() && !(all_starts && hits.best.is_none()) {
				break;
			}
			prev = Some(unit);
			pos += len;
		}
		Some(hits)
	}

	/// Epsilon closure of `seeds` (in non-decreasing start order) into the
	/// consuming nodes of `out`, each node owned by the earliest start.
	fn closure(&mut self, seeds: &[(usize, usize)], ctx: Ctx, out: &mut Vec<usize>) {
		let prog = self.prog;
		self.generation = self.generation.wrapping_add(1);
		if self.generation == 0 {
			self.mark.fill(0);
			self.generation = 1;
		}
		out.clear();
		for &(seed, start) in seeds {
			self.stack.push(seed);
			while let Some(n) = self.stack.pop() {
				if self.mark[n] == self.generation {
					continue;
				}
				self.mark[n] = self.generation;
				self.start[n] = start;
				let node = prog.nodes[n];
				match node.op {
					Op::Split => {
						self.stack.extend(node.alt);
						self.stack.push(node.next);
					},
					Op::Open { .. } | Op::Close { .. } => self.stack.push(node.next),
					Op::Anchor(anchor) => {
						if ctx.holds(anchor) {
							self.stack.push(node.next);
						}
					},
					Op::BackRef(_) => {
						out.push(n);
						self.stack.push(node.next);
					},
					_ => out.push(n),
				}
			}
		}
	}
}

/// Per position of a span, the nodes from which its end is reachable.
struct Viable {
	/// Byte offset of each unit boundary in the span (`len + 1` entries).
	pos:   Vec<usize>,
	/// Folded units of the span.
	units: Vec<u32>,
	words: usize,
	bits:  Vec<u64>,
}

impl Viable {
	fn new(prog: &Prog, mode: Mode, text: &[u8], start: usize, end: usize) -> Self {
		let mut pos = vec![start];
		let mut raw = Vec::new();
		let mut at = start;
		while at < end {
			let (u, len) = mode.decode(text, at);
			raw.push(u);
			at += len;
			pos.push(at);
		}
		let units: Vec<u32> = raw.iter().map(|&u| mode.fold(u)).collect();
		let count = prog.nodes.len();
		let words = count.div_ceil(64);
		let last = units.len();
		let mut this = Self { pos, units, words, bits: vec![0; (last + 1) * words] };
		let before = mode.decode_before(text, start);
		let after = (end < text.len()).then(|| mode.decode(text, end).0);
		let mut stack = Vec::new();
		for k in (0..=last).rev() {
			if k == last {
				this.set(k, prog.end);
				stack.push(prog.end);
			} else {
				for (n, node) in prog.nodes.iter().enumerate() {
					let ok = match node.op {
						Op::BackRef(_) => this.has(k + 1, n),
						op => prog.accepts(mode, op, this.units[k]) && this.has(k + 1, node.next),
					};
					if ok {
						this.set(k, n);
						stack.push(n);
					}
				}
			}
			let prev = if k == 0 { before } else { Some(raw[k - 1]) };
			let next = if k == last { after } else { Some(raw[k]) };
			let ctx = Ctx::new(mode, this.pos[k] == 0, prev, next);
			while let Some(n) = stack.pop() {
				for &p in prog.preds(n) {
					if this.has(k, p) {
						continue;
					}
					if let Op::Anchor(anchor) = prog.nodes[p].op
						&& !ctx.holds(anchor)
					{
						continue;
					}
					this.set(k, p);
					stack.push(p);
				}
			}
		}
		this
	}

	/// Number of units in the span.
	const fn len(&self) -> usize {
		self.units.len()
	}

	fn has(&self, k: usize, n: usize) -> bool {
		(self.bits[k * self.words + n / 64] >> (n % 64)) & 1 == 1
	}

	fn set(&mut self, k: usize, n: usize) {
		self.bits[k * self.words + n / 64] |= 1 << (n % 64);
	}
}

/// A group's boundaries; `None` is glibc's `-1`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Reg {
	so: Option<usize>,
	eo: Option<usize>,
}

/// glibc's `set_regs`: the preferred path through the viable nodes.
struct Walk<'a> {
	prog:     &'a Prog,
	mode:     Mode,
	text:     &'a [u8],
	viable:   &'a Viable,
	/// Backtrack (glibc's fail stack, used with back-references).
	fs:       bool,
	/// Current unit index in the span.
	k:        usize,
	regs:     Vec<Reg>,
	/// glibc's `prev_idx_match`.
	prev:     Vec<Reg>,
	/// Epsilon nodes left since the last consumed unit (`eps_via_nodes`).
	eps:      Vec<usize>,
	/// `eps_mark[n] == eps_gen`: `n` is in `eps`.
	eps_mark: Vec<u32>,
	eps_gen:  u32,
	stack:    Vec<Fail>,
}

/// A saved alternative.
struct Fail {
	k:    usize,
	node: usize,
	regs: Vec<Reg>,
	prev: Vec<Reg>,
	eps:  Vec<usize>,
}

impl<'a> Walk<'a> {
	fn new(prog: &'a Prog, mode: Mode, text: &'a [u8], viable: &'a Viable, fs: bool) -> Self {
		let unset = Reg { so: None, eo: None };
		let mut regs = vec![unset; prog.groups + 1];
		regs[0] = Reg { so: viable.pos.first().copied(), eo: viable.pos.last().copied() };
		let prev = regs.clone();
		Self {
			prog,
			mode,
			text,
			viable,
			fs,
			k: 0,
			regs,
			prev,
			eps: Vec::new(),
			eps_mark: vec![0; prog.nodes.len()],
			eps_gen: 1,
			stack: Vec::new(),
		}
	}

	fn eps_has(&self, n: usize) -> bool {
		self.eps_mark[n] == self.eps_gen
	}

	fn eps_add(&mut self, n: usize) {
		if !self.eps_has(n) {
			self.eps_mark[n] = self.eps_gen;
			self.eps.push(n);
		}
	}

	fn eps_clear(&mut self) {
		self.eps.clear();
		self.eps_gen = self.eps_gen.wrapping_add(1);
		if self.eps_gen == 0 {
			self.eps_mark.fill(0);
			self.eps_gen = 1;
		}
	}

	fn run(mut self, budget: &mut usize) -> Option<Vec<Reg>> {
		let mut cur = self.prog.init;
		loop {
			*budget = budget.checked_sub(1)?;
			self.update_regs(cur);
			if (self.k == self.viable.len() && cur == self.prog.end) || (self.fs && self.eps_has(cur))
			{
				let open = self.regs.iter().any(|r| r.so.is_some() && r.eo.is_none());
				if !(self.fs && open) {
					return Some(self.regs);
				}
				match self.pop() {
					Some(node) => cur = node,
					None => return Some(self.regs),
				}
				continue;
			}
			match self.proceed(cur) {
				Some(node) => cur = node,
				None => cur = self.pop()?,
			}
		}
	}

	fn update_regs(&mut self, node: usize) {
		let at = self.viable.pos[self.k];
		match self.prog.nodes[node].op {
			Op::Open { sub } => self.regs[sub] = Reg { so: Some(at), eo: None },
			Op::Close { sub, opt } => {
				if self.regs[sub].so.is_none_or(|so| so < at) {
					self.regs[sub].eo = Some(at);
					self.prev.clone_from(&self.regs);
				} else if opt && self.prev[sub].so.is_some() {
					// An empty pass through an optional group after a real
					// one: undo it, inner groups included.
					self.regs.clone_from(&self.prev);
				} else {
					self.regs[sub].eo = Some(at);
				}
			},
			_ => {},
		}
	}

	/// glibc's `proceed_next_node`.
	fn proceed(&mut self, cur: usize) -> Option<usize> {
		let node = self.prog.nodes[cur];
		let viable = self.viable;
		if node.op.is_epsilon() {
			self.eps_add(cur);
			let mut chosen = None;
			for dest in core::iter::once(node.next).chain(node.alt) {
				if !viable.has(self.k, dest) {
					continue;
				}
				let Some(first) = chosen else {
					chosen = Some(dest);
					continue;
				};
				// Already tried at this position: avoid looping (`(a*)*`).
				if self.eps_has(first) {
					return Some(dest);
				}
				if self.fs {
					self.stack.push(Fail {
						k:    self.k,
						node: dest,
						regs: self.regs.clone(),
						prev: self.prev.clone(),
						eps:  self.eps.clone(),
					});
				}
				break;
			}
			return chosen;
		}
		let k = match node.op {
			Op::BackRef(sub) => {
				let Reg { so: Some(so), eo: Some(eo) } = self.regs[sub] else {
					return None;
				};
				if so >= eo {
					self.eps_add(cur);
					return viable.has(self.k, node.next).then_some(node.next);
				}
				self.backref(so, eo)?
			},
			Op::End => return None,
			op => {
				let unit = *viable.units.get(self.k)?;
				if !self.prog.accepts(self.mode, op, unit) {
					return None;
				}
				self.k + 1
			},
		};
		if !viable.has(k, node.next) {
			return None;
		}
		self.k = k;
		self.eps_clear();
		Some(node.next)
	}

	/// The unit index after the text of `so..eo` repeated at the current
	/// position, if it is.
	fn backref(&self, so: usize, eo: usize) -> Option<usize> {
		let (mode, units) = (self.mode, &self.viable.units);
		let mut at = so;
		let mut k = self.k;
		while at < eo {
			let (u, len) = mode.decode(self.text, at);
			if *units.get(k)? != mode.fold(u) {
				return None;
			}
			at += len;
			k += 1;
		}
		(at == eo).then_some(k)
	}

	fn pop(&mut self) -> Option<usize> {
		let fail = self.stack.pop()?;
		self.k = fail.k;
		self.regs = fail.regs;
		self.prev = fail.prev;
		self.eps_clear();
		for n in fail.eps {
			self.eps_add(n);
		}
		Some(fail.node)
	}
}
