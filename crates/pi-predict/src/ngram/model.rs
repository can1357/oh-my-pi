//! Counts, the interpolated chain, hygiene state, and learning.
//!
//! Probability chain (interpolated absolute discounting; `mu` adds a
//! Dirichlet-style floor so tiny contexts don't trust one observation):
//!
//! ```text
//! p0(w)      = web unigram share                                  (static)
//! p1(w)      = (c(w) + mu1·p0(w)) / (N + mu1)                      personal unigram, web prior
//! q2(w|v)    = λw·pw(w|v) + (1 − λw·S(v))·p1(w)                    web bigram prior, S = covered mass
//! p2(w|v)    = (max(c(vw) − d2, 0) + (d2·T(v) + mu2)·q2) / (c(v) + mu2)
//! p3(w|u,v)  = (max(c(uvw) − d3, 0) + (d3·T(uv) + mu3)·p2) / (c(uv) + mu3)
//! ```
//!
//! Every level is linear in its lower level, so the mass of all words under a
//! prefix follows the same recursion from range sums, and the posterior of the
//! best candidate among every prefix match is exact up to the case channel.
#![allow(clippy::suboptimal_flops, reason = "`mul_add` is a slow libm call on x86-64 without FMA")]

use super::{
	hygiene::{for_each_neighbour, for_each_slip},
	structures::{FastMap, Fenwick, Followers, IdTable, MaxTree},
	text::{BOS, Slot, case_tail_into, context_before, lowercase_into},
	vocab::Vocab,
	web::{NO_SLOT, WebPrior},
};
use crate::prose;

/// Tuning knobs of the n-gram engine. [`Params::default`] is the operating
/// point tuned on the research `dev` split.
#[derive(Clone, Debug)]
pub struct Params {
	/// Weight of prompts that don't look typed (pastes, logs, long dumps).
	pub paste_weight: f32,
	/// Dirichlet strength of the web unigram prior (in history tokens).
	pub mu1: f64,
	/// Bigram discount.
	pub d2: f64,
	/// Bigram floor.
	pub mu2: f64,
	/// Trigram discount.
	pub d3: f64,
	/// Trigram floor.
	pub mu3: f64,
	/// Weight of the web bigram prior (0 disables it).
	pub web_bigram: f64,
	/// Unigram candidates pulled from the range top-k tree.
	pub top_k: usize,
	/// Occurrences in typed prompts before a word outside the web vocabulary
	/// and the dictionary is suggested.
	pub min_count: u32,
	/// Fold rare misspellings into a real edit-distance-1 neighbour.
	pub canonicalize: bool,
	/// Below this many occurrences a misspelling may fold into a web word.
	pub canon_max_count: u32,
	/// A personal neighbour must be typed this many times as often to absorb a
	/// spelling.
	pub canon_ratio: u32,
	/// Prior that a word is typed with plain (lowercase) casing.
	pub case_prior: f64,
	/// Pseudo-count of the case prior.
	pub case_strength: f64,
	/// Prompt-local cache weight λ (0 disables it).
	pub cache_weight: f64,
	/// Distance (bytes) at which a prompt-local occurrence weighs 1/e.
	pub cache_decay: f64,
	/// Extra cache weight (×(1 + boost)) after the same previous word.
	pub cache_context_boost: f64,
	/// Bytes of the text before the cursor the prompt-local cache scans.
	pub cache_window: usize,
	/// Session cache weight σ per occurrence (0 disables it).
	pub session_weight: f64,
	/// Recent prompts in the session cache.
	pub session_prompts: usize,
	/// Show threshold τ for prefixes of 2+ letters when the client asks from
	/// the second letter on. Gates suggestions and drives typed-past
	/// exclusion.
	pub show_threshold: f32,
	/// Show threshold τ1 for single-letter prefixes. Wrong ghosts after one
	/// letter are frequent, so it also floors a caller's gate override.
	pub show_threshold_k1: f32,
	/// Show threshold for prefixes of 2+ letters when the client also asks
	/// at one letter: single-letter ghosts spend part of the annoyance
	/// budget, so later ones must be surer.
	pub show_threshold_k2_after_k1: f32,
}

impl Params {
	/// Show threshold for a prefix of `k` characters when the client's
	/// first query for the word was at `first_asked` characters.
	pub const fn threshold_at(&self, k: usize, first_asked: usize) -> f32 {
		if k == 1 {
			self.show_threshold_k1
		} else if first_asked == 1 {
			self.show_threshold_k2_after_k1
		} else {
			self.show_threshold
		}
	}
}

impl Default for Params {
	fn default() -> Self {
		Self {
			paste_weight: 0.25,
			mu1: 10_000.0,
			d2: 0.9,
			mu2: 2.0,
			d3: 0.9,
			mu3: 2.0,
			web_bigram: 1.0,
			top_k: 6,
			min_count: 2,
			canonicalize: true,
			canon_max_count: 3,
			canon_ratio: 3,
			case_prior: 0.97,
			case_strength: 2.0,
			cache_weight: 0.5,
			cache_decay: 500.0,
			cache_context_boost: 4.0,
			cache_window: 4000,
			session_weight: 0.02,
			session_prompts: 20,
			show_threshold: 0.17,
			show_threshold_k1: 0.3,
			show_threshold_k2_after_k1: 0.27,
		}
	}
}

/// Flag: a real spelling (dictionary or frequent web word).
const TRUSTED: u8 = 1;
/// Flag: a habitual slip of a real word the user types; never suggested.
const SHADOWED: u8 = 2;
/// Flag: some misspelling in the vocabulary is one slip away from this word.
const WATCH: u8 = 4;

/// No id / no slot.
pub const NONE: u32 = u32::MAX;
/// Words shorter than this (in characters) are never folded or shadowed.
const HYGIENE_MIN_CHARS: usize = 5;
/// Overflow size that triggers folding new words into the sorted base.
const COMPACT_AT: usize = 4096;

/// Recent-prompt word counts (a topic cache).
#[derive(Clone, Default)]
pub struct Session {
	/// Word ids of each recent prompt, oldest first.
	pub prompts: std::collections::VecDeque<Vec<u32>>,
	counts:      FastMap<u32, u32>,
	/// `(id, count)` sorted by word.
	sorted:      Vec<(u32, u32)>,
}

impl Session {
	fn push(&mut self, words: Vec<u32>, capacity: usize, vocab: &Vocab) {
		if capacity == 0 {
			return;
		}
		for &id in &words {
			*self.counts.entry(id).or_default() += 1;
		}
		self.prompts.push_back(words);
		while self.prompts.len() > capacity {
			if let Some(old) = self.prompts.pop_front() {
				for id in old {
					if let Some(count) = self.counts.get_mut(&id) {
						*count -= 1;
						if *count == 0 {
							self.counts.remove(&id);
						}
					}
				}
			}
		}
		self.resort(vocab);
	}

	fn resort(&mut self, vocab: &Vocab) {
		self.sorted.clear();
		self
			.sorted
			.extend(self.counts.iter().map(|(&id, &count)| (id, count)));
		self
			.sorted
			.sort_unstable_by(|a, b| vocab.word(a.0).cmp(vocab.word(b.0)));
	}

	/// `(id, count)` of the session words starting with `prefix`.
	pub fn range<'a>(&'a self, prefix: &str, vocab: &Vocab) -> &'a [(u32, u32)] {
		let lo = self
			.sorted
			.partition_point(|&(id, _)| vocab.word(id) < prefix);
		let len = self.sorted[lo..].partition_point(|&(id, _)| vocab.word(id).starts_with(prefix));
		&self.sorted[lo..lo + len]
	}

	fn remap(&mut self, remap: &[u32], vocab: &Vocab) {
		for prompt in &mut self.prompts {
			for id in prompt.iter_mut() {
				*id = remap[*id as usize];
			}
		}
		self.counts = self
			.counts
			.iter()
			.map(|(&id, &count)| (remap[id as usize], count))
			.collect();
		self.resort(vocab);
	}
}

/// The learned model plus its static web prior.
pub struct Model {
	pub params:     Params,
	pub web:        &'static WebPrior,
	pub vocab:      Vocab,
	/// Weighted history count per id.
	pub count:      Vec<f32>,
	/// Occurrences of the spelling in typed prompts (hygiene).
	pub raw:        Vec<u32>,
	/// Web id per id (`NONE` outside the web vocabulary).
	pub web_id:     Vec<u32>,
	flags:          Vec<u8>,
	/// Follower-list index per context id (`NONE` = no followers).
	pub ctx_slot:   Vec<u32>,
	pub followers:  Vec<Followers>,
	/// Sum of weighted counts.
	pub total:      f64,
	/// Vocabulary id per web id.
	pub web_to_id:  Vec<u32>,
	fen:            Fenwick,
	tree:           MaxTree,
	/// Trigram contexts: `u << 32 | v` → pair index.
	pub pairs:      IdTable<u32>,
	pub pair_total: Vec<f32>,
	pub pair_types: Vec<u32>,
	/// Trigram counts keyed `pair << 32 | w`.
	pub tri:        IdTable<f32>,
	/// Non-plain case tails (`aPI`, `pRs`) per id with counts.
	pub tails:      FastMap<u32, Vec<(Box<str>, f32)>>,
	pub session:    Session,
	/// Id of the sentence-start pseudo-word.
	pub bos:        u32,
	/// Bumped by every learned-state change (invalidates query memos).
	pub version:    u64,
	scratch:        LearnScratch,
}

#[derive(Default)]
struct LearnScratch {
	chars: Vec<char>,
	buf:   String,
	found: Vec<u32>,
	u:     String,
	v:     String,
	word:  String,
	tail:  String,
	/// Spellings folded in the current prompt: original id → canonical id.
	folds: Vec<(u32, u32)>,
}

impl Model {
	/// Fresh model: the web vocabulary plus the sentence-start word.
	pub fn new(params: Params, web: &'static WebPrior) -> Self {
		Self::with_words(params, web, Vec::new())
	}

	/// Model with no learned state whose sorted base holds the web
	/// vocabulary, the sentence-start word, and `extra` (any order, repeats
	/// allowed).
	pub fn with_words(params: Params, web: &'static WebPrior, mut extra: Vec<&str>) -> Self {
		extra.push(BOS);
		extra.retain(|word| web.words.find(word).is_none());
		extra.sort_unstable();
		extra.dedup();
		let mut web_words = (0..web.len()).map(|i| web.words.get(i)).peekable();
		let mut extra_words = extra.into_iter().peekable();
		let merged = std::iter::from_fn(|| match (web_words.peek(), extra_words.peek()) {
			(Some(a), Some(b)) if b < a => extra_words.next(),
			(Some(_), _) => web_words.next(),
			(None, _) => extra_words.next(),
		});
		let vocab = Vocab::from_sorted(merged);
		let n = vocab.len();
		let mut web_id = vec![NONE; n];
		let mut web_to_id = vec![NONE; web.len()];
		let mut flags = vec![0u8; n];
		for (w, slot) in web_to_id.iter_mut().enumerate() {
			if let Some(id) = vocab.find(web.words.get(w)) {
				*slot = id;
				web_id[id as usize] = w as u32;
			}
		}
		for id in 0..n as u32 {
			let wid = web_id[id as usize];
			let web_ref = (wid != NONE).then_some(wid as usize);
			if web.trusted(vocab.word(id), web_ref) {
				flags[id as usize] = TRUSTED;
			}
		}
		let bos = vocab.find(BOS).unwrap_or(NONE);
		let mut model = Self {
			params,
			web,
			vocab,
			count: vec![0.0; n],
			raw: vec![0; n],
			web_id,
			flags,
			ctx_slot: vec![NONE; n],
			followers: Vec::new(),
			total: 0.0,
			web_to_id,
			fen: Fenwick::default(),
			tree: MaxTree::default(),
			pairs: IdTable::with_capacity(1024),
			pair_total: Vec::new(),
			pair_types: Vec::new(),
			tri: IdTable::with_capacity(1024),
			tails: FastMap::default(),
			session: Session::default(),
			bos,
			version: 0,
			scratch: LearnScratch::default(),
		};
		model.rebuild_ranges();
		model
	}

	/// Web unigram share of `id`.
	#[inline]
	pub fn p0(&self, id: u32) -> f64 {
		let wid = self.web_id[id as usize];
		if wid == NONE {
			0.0
		} else {
			f64::from(self.web.p0[wid as usize])
		}
	}

	/// Rebuild the Fenwick and max trees over the sorted base.
	pub fn rebuild_ranges(&mut self) {
		let base = self.vocab.base_len();
		self.fen = Fenwick::new((0..base).map(|i| f64::from(self.count[i])));
		let mu1 = self.params.mu1;
		let scores = (0..base)
			.map(|i| (f64::from(self.count[i]) + mu1 * self.p0(i as u32)) as f32)
			.collect();
		self.tree = MaxTree::new(scores);
	}

	/// Unigram prefix sum over base ids `[lo, hi)`.
	#[inline]
	pub fn count_sum(&self, lo: usize, hi: usize) -> f64 {
		self.fen.prefix(hi) - self.fen.prefix(lo)
	}

	/// Top-`k` base ids of `[lo, hi)` by `count + mu1·p0`.
	#[inline]
	pub fn top_k(&self, lo: usize, hi: usize, k: usize, heap: &mut Vec<u32>, out: &mut Vec<u32>) {
		self.tree.top_k(lo, hi, k, heap, out);
	}

	#[inline]
	pub fn trusted(&self, id: u32) -> bool {
		self.flags[id as usize] & TRUSTED != 0
	}

	/// May `id` be suggested? Real spellings always; habitual slips never;
	/// words unknown to the web need `min_count` typed occurrences.
	#[inline]
	pub fn eligible(&self, id: u32) -> bool {
		let flags = self.flags[id as usize];
		flags & TRUSTED != 0
			|| (flags & SHADOWED == 0
				&& (self.web_id[id as usize] != NONE || self.raw[id as usize] >= self.params.min_count))
	}

	/// Resolve a context slot to an id (words must already be known).
	pub fn resolve(&self, slot: Slot, word: &str) -> Option<u32> {
		match slot {
			Slot::None => None,
			Slot::Bos => Some(self.bos),
			Slot::Word => self.vocab.find(word),
		}
	}

	fn intern(&mut self, word: &str) -> u32 {
		let (id, fresh) = self.vocab.intern(word);
		if fresh {
			let trusted = self.web.trusted(word, None);
			self.count.push(0.0);
			self.raw.push(0);
			self.web_id.push(NONE);
			self.flags.push(if trusted { TRUSTED } else { 0 });
			self.ctx_slot.push(NONE);
			self.link_slips(id);
		}
		id
	}

	/// Refill the session cache from restored prompts (oldest first).
	pub fn restore_session(&mut self, prompts: Vec<Vec<u32>>) {
		let mut session = Session::default();
		for prompt in prompts {
			session.push(prompt, self.params.session_prompts, &self.vocab);
		}
		self.session = session;
	}

	/// Maintain [`WATCH`] for a new word: a misspelling marks the real words
	/// one slip away; a real word marks itself when a misspelling is.
	fn link_slips(&mut self, id: u32) {
		let word_chars = self.vocab.word(id).chars().count();
		if word_chars + 1 < HYGIENE_MIN_CHARS {
			return;
		}
		let trusted = self.trusted(id);
		if !trusted && word_chars < HYGIENE_MIN_CHARS {
			return;
		}
		let mut found = std::mem::take(&mut self.scratch.found);
		found.clear();
		self.collect_slips(id, &mut found);
		for &other in &found {
			if trusted {
				if !self.trusted(other) && self.vocab.word(other).chars().count() >= HYGIENE_MIN_CHARS {
					self.flags[id as usize] |= WATCH;
				}
			} else if self.trusted(other) {
				self.flags[other as usize] |= WATCH;
			}
		}
		self.scratch.found = found;
	}

	/// Ids of the vocabulary words one slip away from `id`.
	fn collect_slips(&mut self, id: u32, out: &mut Vec<u32>) {
		let LearnScratch { chars, buf, word, .. } = &mut self.scratch;
		word.clear();
		word.push_str(self.vocab.word(id));
		let vocab = &self.vocab;
		for_each_slip(word, chars, buf, |candidate| {
			if let Some(other) = vocab.find(candidate)
				&& !out.contains(&other)
			{
				out.push(other);
			}
		});
	}

	/// Recompute [`SHADOWED`] for the misspelling `id`: one slip away from a
	/// real word the user types at least 3 times and at least a third as often.
	fn refresh_shadow(&mut self, id: u32) {
		let mut found = std::mem::take(&mut self.scratch.found);
		found.clear();
		self.collect_slips(id, &mut found);
		let floor = (f64::from(self.raw[id as usize]) / 3.0).max(3.0);
		let hit = found
			.iter()
			.any(|&other| self.trusted(other) && f64::from(self.raw[other as usize]) >= floor);
		for &other in &found {
			if self.trusted(other) {
				self.flags[other as usize] |= WATCH;
			}
		}
		self.scratch.found = found;
		if hit {
			self.flags[id as usize] |= SHADOWED;
		} else {
			self.flags[id as usize] &= !SHADOWED;
		}
	}

	/// Hygiene upkeep after `id`'s typed count changed.
	fn touch_hygiene(&mut self, id: u32) {
		if !self.params.canonicalize {
			return;
		}
		let flags = self.flags[id as usize];
		if flags & TRUSTED == 0 {
			if self.vocab.word(id).chars().count() >= HYGIENE_MIN_CHARS {
				self.refresh_shadow(id);
			}
			return;
		}
		if flags & WATCH == 0 {
			return;
		}
		let mut found = std::mem::take(&mut self.scratch.found);
		found.clear();
		self.collect_slips(id, &mut found);
		let neighbours: Vec<u32> = found
			.iter()
			.copied()
			.filter(|&other| {
				!self.trusted(other)
					&& self.raw[other as usize] > 0
					&& self.vocab.word(other).chars().count() >= HYGIENE_MIN_CHARS
			})
			.collect();
		self.scratch.found = found;
		for other in neighbours {
			self.refresh_shadow(other);
		}
	}

	/// Recompute every hygiene flag (after a restore).
	pub fn sweep_hygiene(&mut self) {
		for id in 0..self.vocab.len() as u32 {
			self.flags[id as usize] &= TRUSTED;
		}
		if !self.params.canonicalize {
			return;
		}
		for id in 0..self.vocab.len() as u32 {
			if !self.trusted(id)
				&& self.raw[id as usize] > 0
				&& self.vocab.word(id).chars().count() >= HYGIENE_MIN_CHARS
			{
				self.refresh_shadow(id);
			}
		}
	}

	/// The real spelling a rare misspelling should count toward: a personal
	/// word typed `canon_ratio`× as often (and trusted or typed ≥ 10×), or,
	/// while the spelling is still rare, a trusted web word.
	fn canonical(&mut self, id: u32) -> u32 {
		if !self.params.canonicalize
			|| self.trusted(id)
			|| self.vocab.word(id).chars().count() < HYGIENE_MIN_CHARS
		{
			return id;
		}
		let raw = self.raw[id as usize] + 1;
		let allow_web = self.raw[id as usize] < self.params.canon_max_count;
		let ratio = self.params.canon_ratio;
		let LearnScratch { chars, buf, word, .. } = &mut self.scratch;
		word.clear();
		word.push_str(self.vocab.word(id));
		let mut best = id;
		let mut best_score = 0.0f64;
		let (vocab, raws, web_id, flags, web) =
			(&self.vocab, &self.raw, &self.web_id, &self.flags, self.web);
		for_each_neighbour(word, chars, buf, |candidate| {
			let Some(other) = vocab.find(candidate) else {
				return;
			};
			let other_raw = raws[other as usize];
			let trusted = flags[other as usize] & TRUSTED != 0;
			let wid = web_id[other as usize];
			let web_count = if wid == NONE {
				0.0
			} else {
				f64::from(web.count[wid as usize])
			};
			let score = if other_raw > 0 {
				if other_raw < ratio * raw || (!trusted && other_raw < 10) {
					return;
				}
				f64::from(other_raw) * 1e12 + web_count
			} else {
				if !allow_web || wid == NONE || !trusted {
					return;
				}
				web_count
			};
			if score > best_score {
				best_score = score;
				best = other;
			}
		});
		best
	}

	/// Learn one submitted prompt.
	pub fn learn(&mut self, prompt: &str) {
		self.version += 1;
		let words = prose::prose_words(prompt);
		if words.is_empty() {
			return;
		}
		let typed = prose::is_typed_like(prompt);
		let learnable = typed || prose::is_learnable(prompt);
		let weight = if typed { 1.0 } else { self.params.paste_weight };
		if weight <= 0.0 {
			return;
		}
		self.scratch.folds.clear();
		let mut session = Vec::new();
		for word in &words {
			let surface = &prompt[word.start..word.end];
			let mut u = std::mem::take(&mut self.scratch.u);
			let mut v = std::mem::take(&mut self.scratch.v);
			let context = context_before(prompt, word.start, &mut u, &mut v);
			let uid = self.event_context(context.u, &u);
			let vid = self.event_context(context.v, &v);
			self.scratch.u = u;
			self.scratch.v = v;

			let mut lower = std::mem::take(&mut self.scratch.word);
			lowercase_into(surface, &mut lower);
			let original = self.intern(&lower);
			self.scratch.word = lower;
			let target = if learnable {
				self.canonical(original)
			} else {
				original
			};
			if target != original {
				self.scratch.folds.push((original, target));
			}
			self.add(uid, vid, surface, target, weight);
			if learnable {
				self.raw[target as usize] += 1;
				self.touch_hygiene(target);
				if target != original {
					self.raw[original as usize] += 1;
					self.touch_hygiene(original);
				}
				session.push(target);
			}
		}
		if learnable {
			let capacity = self.params.session_prompts;
			let mut current = std::mem::take(&mut self.session);
			current.push(session, capacity, &self.vocab);
			self.session = current;
		}
		if self.vocab.overflow_len() >= COMPACT_AT {
			self.compact();
		}
	}

	/// Context id for a learning event; words folded earlier in this prompt
	/// map to their canonical spelling.
	fn event_context(&mut self, slot: Slot, word: &str) -> Option<u32> {
		match slot {
			Slot::None => None,
			Slot::Bos => Some(self.bos),
			Slot::Word => {
				let id = self.intern(word);
				Some(
					self
						.scratch
						.folds
						.iter()
						.find(|&&(from, _)| from == id)
						.map_or(id, |&(_, to)| to),
				)
			},
		}
	}

	/// Count one word with its left context.
	fn add(&mut self, u: Option<u32>, v: Option<u32>, surface: &str, w: u32, weight: f32) {
		self.count[w as usize] += weight;
		self.total += f64::from(weight);
		if (w as usize) < self.vocab.base_len() {
			self.fen.add(w as usize, f64::from(weight));
			let score = f64::from(self.count[w as usize]) + self.params.mu1 * self.p0(w);
			self.tree.set(w as usize, score as f32);
		}
		self.add_tail(w, surface, weight);
		let Some(v) = v else { return };
		let mut slot = self.ctx_slot[v as usize];
		if slot == NONE {
			slot = self.followers.len() as u32;
			self.followers.push(Followers::default());
			self.ctx_slot[v as usize] = slot;
		}
		self.followers[slot as usize].add(w, weight);
		let Some(u) = u else { return };
		let (pair_slot, fresh) = self.pairs.entry(u64::from(u) << 32 | u64::from(v));
		if fresh {
			*pair_slot = self.pair_total.len() as u32;
			self.pair_total.push(0.0);
			self.pair_types.push(0);
		}
		let pair = *pair_slot as usize;
		let (count, fresh) = self.tri.entry((pair as u64) << 32 | u64::from(w));
		*count += weight;
		if fresh {
			self.pair_types[pair] += 1;
		}
		self.pair_total[pair] += weight;
	}

	/// Record the casing of `surface` when it is a non-plain form of `w`.
	fn add_tail(&mut self, w: u32, surface: &str, weight: f32) {
		let mut tail = std::mem::take(&mut self.scratch.tail);
		case_tail_into(surface, &mut tail);
		let word = self.vocab.word(w);
		if tail != word && tail.chars().count() == word.chars().count() && tail.to_lowercase() == word
		{
			let tails = self.tails.entry(w).or_default();
			if let Some(entry) = tails.iter_mut().find(|(form, _)| **form == *tail) {
				entry.1 += weight;
			} else {
				tails.push((tail.as_str().into(), weight));
			}
		}
		self.scratch.tail = tail;
	}

	/// Fold overflow words into the sorted base and renumber every table.
	pub fn compact(&mut self) {
		let (vocab, remap) = self.vocab.compacted();
		let n = vocab.len();
		let permute = |values: &mut Vec<_>, fill| {
			let mut next = vec![fill; n];
			for (old, value) in values.iter().enumerate() {
				next[remap[old] as usize] = *value;
			}
			*values = next;
		};
		permute(&mut self.raw, 0);
		permute(&mut self.web_id, NONE);
		permute(&mut self.ctx_slot, NONE);
		let mut count = vec![0.0f32; n];
		let mut flags = vec![0u8; n];
		for old in 0..remap.len() {
			count[remap[old] as usize] = self.count[old];
			flags[remap[old] as usize] = self.flags[old];
		}
		self.count = count;
		self.flags = flags;
		for (w, id) in self.web_to_id.iter_mut().enumerate() {
			if *id != NONE {
				*id = remap[*id as usize];
			}
			debug_assert!(*id == NONE || self.web_id[*id as usize] == w as u32);
		}
		self.bos = remap[self.bos as usize];
		let mut order = Vec::new();
		for list in &mut self.followers {
			order.clear();
			order.extend(
				list
					.ids
					.iter()
					.zip(&list.counts)
					.map(|(&id, &count)| (remap[id as usize], count)),
			);
			order.sort_unstable_by_key(|&(id, _)| id);
			list.ids.clear();
			list.counts.clear();
			for &(id, count) in &order {
				list.ids.push(id);
				list.counts.push(count);
			}
		}
		let mut pairs = IdTable::with_capacity(self.pairs.len());
		for (key, pair) in self.pairs.iter() {
			let (u, v) = ((key >> 32) as usize, (key & 0xffff_ffff) as usize);
			*pairs
				.entry(u64::from(remap[u]) << 32 | u64::from(remap[v]))
				.0 = pair;
		}
		self.pairs = pairs;
		let mut tri = IdTable::with_capacity(self.tri.len());
		for (key, count) in self.tri.iter() {
			let w = (key & 0xffff_ffff) as usize;
			*tri.entry(key & !0xffff_ffff | u64::from(remap[w])).0 = count;
		}
		self.tri = tri;
		self.tails = std::mem::take(&mut self.tails)
			.into_iter()
			.map(|(id, forms)| (remap[id as usize], forms))
			.collect();
		self.vocab = vocab;
		let mut session = std::mem::take(&mut self.session);
		session.remap(&remap, &self.vocab);
		self.session = session;
		self.rebuild_ranges();
		self.version += 1;
	}

	/// Drop trigrams seen only in pastes (weighted count below 1) and the
	/// contexts left without trigrams; their `p3` is a constant multiple of
	/// `p2`, so posteriors keep their order. Surviving contexts keep their
	/// unpruned totals.
	pub fn prune_trigrams(&mut self) {
		let mut renumber = vec![NONE; self.pair_total.len()];
		let (mut totals, mut types) = (Vec::new(), Vec::new());
		let kept = self.tri.iter().filter(|&(_, count)| count >= 1.0).count();
		let mut tri = IdTable::with_capacity(kept);
		for (key, count) in self.tri.iter().filter(|&(_, count)| count >= 1.0) {
			let pair = (key >> 32) as usize;
			if renumber[pair] == NONE {
				renumber[pair] = totals.len() as u32;
				totals.push(self.pair_total[pair]);
				types.push(self.pair_types[pair]);
			}
			*tri
				.entry(u64::from(renumber[pair]) << 32 | (key & 0xffff_ffff))
				.0 = count;
		}
		self.tri = tri;
		self.pair_total = totals;
		self.pair_types = types;
		let mut pairs = IdTable::with_capacity(self.pair_total.len());
		for (key, pair) in self.pairs.iter() {
			if renumber[pair as usize] != NONE {
				*pairs.entry(key).0 = renumber[pair as usize];
			}
		}
		self.pairs = pairs;
		self.version += 1;
	}

	/// P(typed case tail | word): share of the word's occurrences whose tail
	/// is compatible with how the prefix was typed, smoothed toward `prior`.
	pub fn case_prob(&self, id: u32, tail_prefix: &str, plain: bool, prior: f64) -> f64 {
		let count = f64::from(self.count[id as usize]);
		let mut other = 0.0f64;
		let mut compatible = 0.0f64;
		if let Some(tails) = self.tails.get(&id) {
			for (tail, n) in tails {
				other += f64::from(*n);
				if tail.starts_with(tail_prefix) {
					compatible += f64::from(*n);
				}
			}
		}
		if plain {
			compatible += count - other;
		}
		let a = self.params.case_strength;
		(compatible + a * prior) / (count + a)
	}

	/// Surface suffix of `id` after `typed`: the most frequent seen form
	/// compatible with the typed case, else the lowercase rest (uppercased
	/// when the prefix is ALLCAPS).
	pub fn suffix(&self, id: u32, typed: &str, tail_prefix: &str) -> String {
		let word = self.vocab.word(id);
		let k = typed.chars().count();
		let word_head_end = word.char_indices().nth(k).map_or(word.len(), |(at, _)| at);
		let mut best: Option<&str> = (tail_prefix == &word[..word_head_end]).then_some(word);
		let mut best_count = if best.is_some() {
			f64::from(self.count[id as usize])
		} else {
			0.0
		};
		if let Some(tails) = self.tails.get(&id) {
			if best.is_some() {
				best_count -= tails.iter().map(|(_, n)| f64::from(*n)).sum::<f64>();
			}
			for (tail, n) in tails {
				if f64::from(*n) > best_count && tail.starts_with(tail_prefix) {
					best = Some(tail);
					best_count = f64::from(*n);
				}
			}
		}
		if let Some(form) = best {
			return form.chars().skip(k).collect();
		}
		plain_suffix(&word[word_head_end..], typed, k)
	}

	/// Heap bytes held by the model (static web prior excluded).
	pub fn heap_bytes(&self) -> usize {
		let per_id = self.count.capacity() * 4
			+ self.raw.capacity() * 4
			+ self.web_id.capacity() * 4
			+ self.flags.capacity()
			+ self.ctx_slot.capacity() * 4
			+ self.web_to_id.capacity() * 4;
		let followers: usize = self
			.followers
			.iter()
			.map(|f| f.heap_bytes() + size_of::<Followers>())
			.sum();
		let tails: usize = self
			.tails
			.values()
			.map(|forms| forms.iter().map(|(f, _)| f.len() + 24).sum::<usize>() + 48)
			.sum();
		per_id
			+ self.vocab.heap_bytes()
			+ followers
			+ self.fen.heap_bytes()
			+ self.tree.heap_bytes()
			+ self.pairs.heap_bytes()
			+ self.pair_total.capacity() * 4
			+ self.pair_types.capacity() * 4
			+ self.tri.heap_bytes()
			+ tails
	}
}

/// Lowercase remainder `rest` of a word after `typed` (`k` characters),
/// uppercased when the typed prefix is ALLCAPS.
pub fn plain_suffix(rest: &str, typed: &str, k: usize) -> String {
	if k >= 2 && typed.chars().any(char::is_alphabetic) && !typed.chars().any(char::is_lowercase) {
		rest.to_uppercase()
	} else {
		rest.to_owned()
	}
}

/// Resolve the static context stats of a context id for `rank`.
impl Model {
	/// Follower list of context `v`.
	#[inline]
	pub fn followers_of(&self, v: u32) -> Option<&Followers> {
		let slot = self.ctx_slot[v as usize];
		(slot != NONE).then(|| &self.followers[slot as usize])
	}

	/// Web bigram slot of context `v`.
	#[inline]
	pub fn web_slot_of(&self, v: u32) -> u32 {
		if v == self.bos {
			return self.web.slot(self.web.len());
		}
		let wid = self.web_id[v as usize];
		if wid == NONE {
			NO_SLOT
		} else {
			self.web.slot(wid as usize)
		}
	}
}
