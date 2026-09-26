//! Completion: prefix-constrained ranking with the prompt-local and session
//! caches, the finished-word-aware posterior, and typed-past exclusion.
//!
//! For prefix `p` after context `(u, v)`, with `s(w) = p3(w|u,v)·P(case|w)`
//! and `M = Σ_{x ⊒ p} s(x)` (every word under the prefix, **including the
//! prefix itself** when it is a word):
//!
//! ```text
//! post(w)  = s(w) / M
//! final(w) = (post(w) + λ·cache(w) + σ·session(w)) / (1 + λ·C + σ·S)
//! ```
//!
//! `cache(w)` sums `exp(−distance/D)` over occurrences of `w` earlier in the
//! prompt (×(1 + b) after the same previous word) and `session(w)` counts
//! `w` in the last prompts; `C`/`S` are their totals under the prefix. The
//! confidence of the best word is `final(best) / (1 − Σ final(excluded))`,
//! where the excluded words are those shown at a shorter prefix of this word
//! (confidence ≥ that length's show threshold, from the shortest prefix the
//! client asked about) and typed past.

#![allow(clippy::suboptimal_flops, reason = "`mul_add` is a slow libm call on x86-64 without FMA")]

use super::{
	model::{Model, NONE, plain_suffix},
	structures::Followers,
	text::{Context, Slot, case_tail_into, context_before, lowercase_into},
	web::NO_SLOT,
};
use crate::prose::is_letter;

/// Context statistics of one query.
struct Ctx<'a> {
	followers: Option<&'a Followers>,
	cv:        f64,
	tv:        f64,
	pair:      u32,
	cuv:       f64,
	tuv:       f64,
	web_slot:  u32,
	web_s:     f64,
}

/// One scored candidate.
#[derive(Clone, Copy, Default)]
struct Candidate {
	/// Vocabulary id, or `NONE` for a word seen only earlier in this prompt.
	id:      u32,
	/// Window byte span of a cache-only word.
	span:    (u32, u32),
	c2:      f32,
	pw:      f32,
	c3:      f32,
	cache:   f64,
	session: f64,
	/// Case-weighted chain score `s(w)`.
	score:   f64,
}

/// The word a ranking picked.
#[derive(Clone, Copy)]
pub enum Pick {
	/// A vocabulary word.
	Word(u32),
	/// A word seen only earlier in this prompt: byte span of the cache window.
	Local(u32, u32),
}

/// Query-local state reused across the prefixes of one word.
pub struct QueryState {
	/// `before` the memo was built for.
	before:      String,
	version:     u64,
	/// Lowercase prefix the `shown` chain belongs to.
	key:         String,
	/// Word shown at each shorter prefix length (index = characters), lowercase.
	shown:       Vec<Option<String>>,
	/// Shortest prefix length asked about for this `before`: the client
	/// never saw a ghost at shorter prefixes (its gate starts there).
	first_asked: usize,
	/// Lowercased tail of `before` scanned by the prompt-local cache;
	/// byte offsets match `before[window_at..]`.
	window:      String,
	window_at:   usize,
	u:           String,
	v:           String,
	context:     Context,
	// Scratch.
	cands:       Vec<Candidate>,
	stamp:       Vec<u32>,
	slot:        Vec<u32>,
	epoch:       u32,
	heap:        Vec<u32>,
	top:         Vec<u32>,
	tail:        String,
	key_buf:     String,
	cu:          String,
	cv:          String,
}

impl Default for QueryState {
	fn default() -> Self {
		Self {
			before:      String::new(),
			version:     u64::MAX,
			key:         String::new(),
			shown:       Vec::new(),
			first_asked: usize::MAX,
			window:      String::new(),
			window_at:   0,
			u:           String::new(),
			v:           String::new(),
			context:     Context { u: Slot::None, v: Slot::None },
			cands:       Vec::new(),
			stamp:       Vec::new(),
			slot:        Vec::new(),
			epoch:       0,
			heap:        Vec::new(),
			top:         Vec::new(),
			tail:        String::new(),
			key_buf:     String::new(),
			cu:          String::new(),
			cv:          String::new(),
		}
	}
}

/// Lowercase `text` into `out` keeping byte offsets: characters whose
/// lowercase form has a different UTF-8 length are kept as typed.
fn lowercase_aligned(text: &str, out: &mut String) {
	out.clear();
	for c in text.chars() {
		let mut lower = c.to_lowercase();
		match (lower.next(), lower.next()) {
			(Some(l), None) if l.len_utf8() == c.len_utf8() => out.push(l),
			_ => out.push(c),
		}
	}
}

#[inline]
fn is_word_code(c: char) -> bool {
	c == '\'' || is_letter(c)
}

/// Byte offset of the `k`-th character of `text` (its length when shorter).
#[inline]
fn char_offset(text: &str, k: usize) -> usize {
	text.char_indices().nth(k).map_or(text.len(), |(at, _)| at)
}

impl QueryState {
	/// Heap bytes held by the query scratch.
	pub const fn heap_bytes(&self) -> usize {
		self.before.capacity()
			+ self.window.capacity()
			+ self.cands.capacity() * size_of::<Candidate>()
			+ self.stamp.capacity() * 4
			+ self.slot.capacity() * 4
	}

	/// Prepare the per-`before` state (context, cache window) unless the memo
	/// already holds it.
	fn load(&mut self, model: &Model, before: &str) {
		if self.version == model.version && self.before == before {
			return;
		}
		self.before.clear();
		self.before.push_str(before);
		self.version = model.version;
		self.key.clear();
		self.shown.clear();
		self.first_asked = usize::MAX;
		self.context = context_before(before, before.len(), &mut self.u, &mut self.v);
		let mut at = before.len().saturating_sub(model.params.cache_window);
		while !before.is_char_boundary(at) {
			at += 1;
		}
		self.window_at = at;
		if model.params.cache_weight > 0.0 {
			lowercase_aligned(&before[at..], &mut self.window);
		} else {
			self.window.clear();
		}
		if self.stamp.len() < model.vocab.len() {
			self.stamp.resize(model.vocab.len(), 0);
			self.slot.resize(model.vocab.len(), 0);
		}
	}

	/// Best completion of `prefix` after `before`, with its confidence and
	/// the show threshold that applies to it.
	pub fn complete(
		&mut self,
		model: &Model,
		before: &str,
		prefix: &str,
	) -> Option<(String, f64, f32)> {
		lowercase_into(prefix, &mut self.key_buf);
		let k_total = prefix.chars().count();
		if k_total == 0 || self.key_buf.chars().count() != k_total {
			return None;
		}
		self.load(model, before);
		let key = std::mem::take(&mut self.key_buf);
		// Typed-past exclusion: replay the shorter prefixes of this word that
		// the client asked about. A word shown there (confidence ≥ its show
		// threshold) that still matches was typed past.
		self.first_asked = self.first_asked.min(k_total);
		let common = self
			.key
			.chars()
			.zip(key.chars())
			.take_while(|(a, b)| a == b)
			.count();
		self.shown.truncate((common + 1).min(k_total));
		if self.shown.is_empty() {
			// Index 0 (the empty prefix) is never shown.
			self.shown.push(None);
		}
		for k in self.shown.len()..k_total {
			if k < self.first_asked {
				self.shown.push(None);
				continue;
			}
			let (key_end, typed_end) = (char_offset(&key, k), char_offset(prefix, k));
			let tau = f64::from(model.params.threshold_at(k, self.first_asked));
			let shown = self
				.rank(model, &key[..key_end], &prefix[..typed_end], k)
				.filter(|&(_, confidence)| confidence >= tau)
				.map(|(pick, _)| self.pick_word(model, pick).to_owned());
			self.shown.push(shown);
		}
		self.key.clear();
		self.key.push_str(&key);
		let ranked = self.rank(model, &key, prefix, k_total);
		let threshold = model.params.threshold_at(k_total, self.first_asked);
		let out = ranked.and_then(|(pick, confidence)| {
			let suffix = self.suffix(model, pick, prefix, &key);
			(!suffix.is_empty()).then_some((suffix, confidence, threshold))
		});
		self.key_buf = key;
		out
	}

	fn pick_word<'a>(&'a self, model: &'a Model, pick: Pick) -> &'a str {
		match pick {
			Pick::Word(id) => model.vocab.word(id),
			Pick::Local(start, end) => &self.window[start as usize..end as usize],
		}
	}

	fn suffix(&mut self, model: &Model, pick: Pick, typed: &str, key: &str) -> String {
		case_tail_into(typed, &mut self.tail);
		let k = typed.chars().count();
		match pick {
			Pick::Word(id) => model.suffix(id, typed, &self.tail),
			Pick::Local(start, end) => {
				// Prefer the casing the word had where it was typed.
				let (start, end) = (start as usize + self.window_at, end as usize + self.window_at);
				let surface = &self.before[start..end];
				let mut form = String::new();
				case_tail_into(surface, &mut form);
				if form.starts_with(self.tail.as_str()) {
					return form.chars().skip(k).collect();
				}
				let word = &self.window[start - self.window_at..end - self.window_at];
				plain_suffix(&word[key.len().min(word.len())..], typed, k)
			},
		}
	}

	fn context_stats<'m>(&self, model: &'m Model) -> Ctx<'m> {
		let vid = model.resolve(self.context.v, &self.v);
		let followers = vid.and_then(|v| model.followers_of(v));
		let pair = match (vid, model.resolve(self.context.u, &self.u)) {
			(Some(v), Some(u)) => model
				.pairs
				.get(u64::from(u) << 32 | u64::from(v))
				.unwrap_or(NONE),
			_ => NONE,
		};
		let web_slot = match vid {
			Some(v) if model.params.web_bigram > 0.0 => model.web_slot_of(v),
			_ => NO_SLOT,
		};
		Ctx {
			followers,
			cv: followers.map_or(0.0, |f| f.total),
			tv: followers.map_or(0.0, |f| f.types() as f64),
			pair,
			cuv: if pair == NONE {
				0.0
			} else {
				f64::from(model.pair_total[pair as usize])
			},
			tuv: if pair == NONE {
				0.0
			} else {
				f64::from(model.pair_types[pair as usize])
			},
			web_slot,
			web_s: if web_slot == NO_SLOT {
				0.0
			} else {
				f64::from(model.web.covered[web_slot as usize]) * model.params.web_bigram
			},
		}
	}

	/// Push (or find) the candidate for vocabulary word `id`.
	fn candidate(
		&mut self,
		model: &Model,
		ctx: &Ctx<'_>,
		id: u32,
		c2: Option<f32>,
		pw: Option<f32>,
	) -> usize {
		let i = id as usize;
		if self.stamp[i] == self.epoch {
			return self.slot[i] as usize;
		}
		let c2 = c2.unwrap_or_else(|| ctx.followers.map_or(0.0, |f| f.count(id)));
		let pw = pw.unwrap_or_else(|| {
			if ctx.web_slot == NO_SLOT {
				0.0
			} else {
				web_prob(model, ctx.web_slot, id)
			}
		});
		let c3 = if ctx.pair != NONE && c2 > 0.0 {
			model
				.tri
				.get(u64::from(ctx.pair) << 32 | u64::from(id))
				.unwrap_or(0.0)
		} else {
			0.0
		};
		self.stamp[i] = self.epoch;
		self.slot[i] = self.cands.len() as u32;
		self
			.cands
			.push(Candidate { id, c2, pw, c3, ..Candidate::default() });
		self.cands.len() - 1
	}

	fn next_epoch(&mut self) {
		self.epoch = self.epoch.wrapping_add(1);
		if self.epoch == 0 {
			self.stamp.fill(0);
			self.epoch = 1;
		}
		self.cands.clear();
	}

	/// Rank the completions of lowercase `key` (typed as `typed`), excluding
	/// the words in `self.shown[..k]`. Returns the pick and its confidence.
	fn rank(&mut self, model: &Model, key: &str, typed: &str, k: usize) -> Option<(Pick, f64)> {
		let p = &model.params;
		self.next_epoch();
		let ctx = self.context_stats(model);
		let (lo, hi) = model.vocab.base_range(key);
		let (wlo, whi) = model.web.words.range(key);

		// Merge-join the history and web followers of `v` inside the prefix range.
		let (mut disc2, mut sum_pw, mut disc3) = (0.0f64, 0.0f64, 0.0f64);
		let (mut a, a_end) = ctx
			.followers
			.map_or((0, 0), |f| (f.lower_bound(lo as u32), f.lower_bound(hi as u32)));
		let (mut b, b_end) = if ctx.web_slot == NO_SLOT {
			(0, 0)
		} else {
			(
				model.web.lower_row(ctx.web_slot, wlo as u32),
				model.web.lower_row(ctx.web_slot, whi as u32),
			)
		};
		while a < a_end || b < b_end {
			let ida = if a < a_end {
				ctx.followers.map_or(u32::MAX, |f| f.ids[a])
			} else {
				u32::MAX
			};
			let idb = if b < b_end {
				model.web_to_id[model.web.follower[b] as usize]
			} else {
				u32::MAX
			};
			let id = ida.min(idb);
			let c2 = if ida == id {
				a += 1;
				ctx.followers.map_or(0.0, |f| f.counts[a - 1])
			} else {
				0.0
			};
			let pw = if idb == id {
				b += 1;
				model.web.prob[b - 1]
			} else {
				0.0
			};
			let at = self.candidate(model, &ctx, id, Some(c2), Some(pw));
			let cand = self.cands[at];
			disc2 += (f64::from(c2) - p.d2).max(0.0);
			sum_pw += f64::from(pw);
			disc3 += (f64::from(cand.c3) - p.d3).max(0.0);
		}
		// Overflow followers are not in lexicographic id order: filter by text.
		if let Some(f) = ctx.followers {
			let base = model.vocab.base_len() as u32;
			for at in f.lower_bound(base)..f.ids.len() {
				let id = f.ids[at];
				if !model.vocab.word(id).starts_with(key) {
					continue;
				}
				let c2 = f.counts[at];
				let slot = self.candidate(model, &ctx, id, Some(c2), Some(0.0));
				disc2 += (f64::from(c2) - p.d2).max(0.0);
				disc3 += (f64::from(self.cands[slot].c3) - p.d3).max(0.0);
			}
		}
		// Unigram candidates: range top-k over base ids plus every overflow match.
		self.top.clear();
		model.top_k(lo, hi, p.top_k, &mut self.heap, &mut self.top);
		for at in 0..self.top.len() {
			let id = self.top[at];
			self.candidate(model, &ctx, id, None, None);
		}
		let mut sum_c1 = model.count_sum(lo, hi);
		for &id in model.vocab.overflow_range(key) {
			sum_c1 += f64::from(model.count[id as usize]);
			self.candidate(model, &ctx, id, None, None);
		}
		let sum_p0 = model.web.p0_cum[whi] - model.web.p0_cum[wlo];
		let mass = interp(model, &ctx, sum_c1, sum_p0, sum_pw, disc2, disc3);

		// Prompt-local cache and session cache.
		let cache_mass = if p.cache_weight > 0.0 {
			self.scan_cache(model, &ctx, key)
		} else {
			0.0
		};
		let mut session_mass = 0.0f64;
		if p.session_weight > 0.0 {
			for &(id, count) in model.session.range(key, &model.vocab) {
				session_mass += f64::from(count);
				let known = self.stamp[id as usize] == self.epoch;
				if known || (model.eligible(id) && model.vocab.word(id) != key) {
					let at = self.candidate(model, &ctx, id, None, None);
					self.cands[at].session = f64::from(count);
				}
			}
		}

		// Score with the case channel; adjust the mass for it.
		case_tail_into(typed, &mut self.tail);
		let plain = self.tail == key;
		let prior = if plain {
			p.case_prior
		} else {
			1.0 - p.case_prior
		};
		let mut case_mass = prior * mass;
		let mut score_sum = 0.0f64;
		for cand in &mut self.cands {
			if cand.id == NONE {
				continue;
			}
			let raw = chain_score(model, &ctx, cand);
			let case_p = model.case_prob(cand.id, &self.tail, plain, prior);
			case_mass += raw * (case_p - prior);
			cand.score = raw * case_p;
			score_sum += cand.score;
		}
		let case_mass = case_mass.max(score_sum);
		let norm = 1.0 + p.cache_weight * cache_mass + p.session_weight * session_mass;
		let mut best: Option<(&Candidate, f64)> = None;
		let mut excluded = 0.0f64;
		for cand in &self.cands {
			let post = if case_mass > 0.0 {
				cand.score / case_mass
			} else {
				0.0
			};
			let value = (post + p.cache_weight * cand.cache + p.session_weight * cand.session) / norm;
			let word = match cand.id {
				NONE => &self.window[cand.span.0 as usize..cand.span.1 as usize],
				id => model.vocab.word(id),
			};
			if word.len() == key.len() {
				continue;
			}
			if self.shown[..k.min(self.shown.len())]
				.iter()
				.flatten()
				.any(|shown| shown == word)
			{
				excluded += value;
				continue;
			}
			// Hygiene: misspellings and one-off junk are never offered unless
			// they were typed earlier in this prompt.
			if cand.id != NONE && cand.cache == 0.0 && !model.eligible(cand.id) {
				continue;
			}
			if value > best.map_or(0.0, |(_, v)| v) {
				best = Some((cand, value));
			}
		}
		let (cand, value) = best?;
		let pick = if cand.id == NONE {
			Pick::Local(cand.span.0, cand.span.1)
		} else {
			Pick::Word(cand.id)
		};
		Some((pick, value / (1.0 - excluded).max(0.05)))
	}

	/// Prompt-local cache: words in the window that extend `key` (or equal
	/// it), weighted `exp(−distance / D)`, ×(1 + boost) after the same
	/// previous word as the query. Returns the total weight.
	fn scan_cache(&mut self, model: &Model, ctx: &Ctx<'_>, key: &str) -> f64 {
		let p = &model.params;
		let window = std::mem::take(&mut self.window);
		let n = window.len();
		let mut mass = 0.0f64;
		let mut limit = n;
		while let Some(idx) = window[..limit].rfind(key) {
			let boundary = window[..idx]
				.chars()
				.next_back()
				.is_none_or(|c| !is_word_code(c));
			if boundary {
				let rest = &window[idx + key.len()..];
				let (mut end, next) = rest
					.char_indices()
					.find(|&(_, c)| !is_word_code(c))
					.map_or((n, ' '), |(at, c)| (idx + key.len() + at, c));
				// Skip identifiers (`foo_bar`, `v2`).
				let identifier = next == '_' || next.is_ascii_digit();
				while end > idx + key.len() && window.as_bytes()[end - 1] == b'\'' {
					end -= 1;
				}
				if !identifier {
					let mut weight = (-((n - idx) as f64) / p.cache_decay).exp();
					if p.cache_context_boost > 0.0 && self.context.v != Slot::None {
						let seen = context_before(&window, idx, &mut self.cu, &mut self.cv);
						let same =
							seen.v == self.context.v && (seen.v != Slot::Word || self.cv == self.v);
						if same {
							weight *= 1.0 + p.cache_context_boost;
						}
					}
					mass += weight;
					let word = &window[idx..end];
					if word.len() > key.len() {
						if let Some(id) = model.vocab.find(word) {
							let at = self.candidate(model, ctx, id, None, None);
							self.cands[at].cache += weight;
						} else if let Some(cand) = self.cands.iter_mut().find(|c| {
							c.id == NONE && &window[c.span.0 as usize..c.span.1 as usize] == word
						}) {
							cand.cache += weight;
						} else {
							let span = (idx as u32, end as u32);
							self.cands.push(Candidate {
								id: NONE,
								span,
								cache: weight,
								..Candidate::default()
							});
						}
					}
				}
			}
			if idx == 0 {
				break;
			}
			limit = idx + key.len() - 1;
			while !window.is_char_boundary(limit) {
				limit -= 1;
			}
		}
		self.window = window;
		mass
	}
}

/// `P_web(id | slot)` for vocabulary id `id`.
fn web_prob(model: &Model, slot: u32, id: u32) -> f32 {
	let wid = model.web_id[id as usize];
	if wid == NONE {
		0.0
	} else {
		model.web.prob_of(slot, wid)
	}
}

/// The chain, fed either one word's counts or prefix sums of them.
fn interp(model: &Model, ctx: &Ctx<'_>, c1: f64, p0: f64, pw: f64, disc2: f64, disc3: f64) -> f64 {
	let p = &model.params;
	let p1 = (c1 + p.mu1 * p0) / (model.total + p.mu1);
	let q2 = if ctx.web_slot == NO_SLOT {
		p1
	} else {
		p.web_bigram * pw + (1.0 - ctx.web_s) * p1
	};
	let p2 = if ctx.cv > 0.0 {
		(disc2 + (p.d2 * ctx.tv + p.mu2) * q2) / (ctx.cv + p.mu2)
	} else {
		q2
	};
	if ctx.cuv > 0.0 {
		(disc3 + (p.d3 * ctx.tuv + p.mu3) * p2) / (ctx.cuv + p.mu3)
	} else {
		p2
	}
}

fn chain_score(model: &Model, ctx: &Ctx<'_>, cand: &Candidate) -> f64 {
	let p = &model.params;
	interp(
		model,
		ctx,
		f64::from(model.count[cand.id as usize]),
		model.p0(cand.id),
		f64::from(cand.pw),
		(f64::from(cand.c2) - p.d2).max(0.0),
		(f64::from(cand.c3) - p.d3).max(0.0),
	)
}
