//! Static web prior embedded in the binary: Norvig web unigram and bigram
//! counts plus `/usr/share/dict/words` membership.
//!
//! `data/web-prior.bin.zst` is produced by
//! `crates/pi-predict/scripts/build-web-prior.ts` (layout documented there):
//! the 150k most frequent lowercase word forms of Norvig's `count_1w` in UTF-8
//! byte order, their bigrams from `count_2w` (plus the `<S>` sentence-start
//! rows), and dictionary membership. Regenerate it with
//! `bun crates/pi-predict/scripts/build-web-prior.ts` after changing the
//! inputs or the vocabulary size. It is decoded once per process.

use std::sync::LazyLock;

use anyhow::{Context, bail, ensure};

/// The compressed artifact.
const ARTIFACT: &[u8] = include_bytes!("../../data/web-prior.bin.zst");
const MAGIC: &[u8; 4] = b"PIWP";
const VERSION: u32 = 1;
/// Share of real sentence starts that Norvig's `<S> w` rows cover (the
/// research tuning: 0.3 → no change).
const SENTENCE_COVERAGE: f64 = 0.6;
/// Web count from which a word is trusted as a real spelling even outside
/// the dictionary.
pub const TRUSTED_WEB_COUNT: f32 = 200_000.0;

/// Sorted word list as one string plus end offsets.
pub struct SortedWords {
	text: String,
	ends: Vec<u32>,
}

impl SortedWords {
	fn parse(blob: &[u8], count: usize) -> anyhow::Result<Self> {
		let text = std::str::from_utf8(blob).context("web prior: words are not UTF-8")?;
		let mut ends = Vec::with_capacity(count);
		let mut joined = String::with_capacity(text.len());
		for word in text.split_terminator('\n') {
			joined.push_str(word);
			ends.push(joined.len() as u32);
		}
		ensure!(ends.len() == count, "web prior: expected {count} words, found {}", ends.len());
		Ok(Self { text: joined, ends })
	}

	/// Number of words.
	pub const fn len(&self) -> usize {
		self.ends.len()
	}

	/// Word `i`.
	#[inline]
	pub fn get(&self, i: usize) -> &str {
		let start = if i == 0 { 0 } else { self.ends[i - 1] as usize };
		&self.text[start..self.ends[i] as usize]
	}

	/// Index range of the words starting with `prefix`.
	pub fn range(&self, prefix: &str) -> (usize, usize) {
		let lo = self.lower_bound(prefix);
		// Words starting with `prefix` are contiguous from `lo`.
		let (mut a, mut b) = (lo, self.len());
		while a < b {
			let mid = usize::midpoint(a, b);
			if self.get(mid).starts_with(prefix) {
				a = mid + 1;
			} else {
				b = mid;
			}
		}
		(lo, a)
	}

	/// First index whose word is `>= key`.
	#[inline]
	pub fn lower_bound(&self, key: &str) -> usize {
		let (mut lo, mut hi) = (0, self.len());
		while lo < hi {
			let mid = usize::midpoint(lo, hi);
			if self.get(mid) < key {
				lo = mid + 1;
			} else {
				hi = mid;
			}
		}
		lo
	}

	/// Index of `word`.
	pub fn find(&self, word: &str) -> Option<usize> {
		let at = self.lower_bound(word);
		(at < self.len() && self.get(at) == word).then_some(at)
	}

	/// Heap bytes held by the list.
	pub const fn heap_bytes(&self) -> usize {
		self.text.capacity() + self.ends.capacity() * 4
	}
}

/// Web unigram and bigram statistics indexed by web id (lexicographic rank).
pub struct WebPrior {
	/// Vocabulary in byte order.
	pub words:    SortedWords,
	/// Norvig count per word.
	pub count:    Vec<f32>,
	/// Unigram share `p0` per word.
	pub p0:       Vec<f32>,
	/// Cumulative `p0` (`p0_cum[i]` = sum over words `< i`).
	pub p0_cum:   Vec<f64>,
	in_dict:      Vec<u64>,
	/// Dictionary words outside the vocabulary.
	dict_only:    SortedWords,
	/// Bigram slot per context word (index `len()` = sentence start).
	slot:         Vec<u32>,
	/// Follower rows per slot: `start[slot]..start[slot + 1]`.
	start:        Vec<u32>,
	/// Follower web ids, ascending within a slot.
	pub follower: Vec<u32>,
	/// `P_web(w | v)` per row.
	pub prob:     Vec<f32>,
	/// Covered mass `S(v) = Σ_w P_web(w | v)` per slot (capped at 1).
	pub covered:  Vec<f32>,
}

/// No bigram slot.
pub const NO_SLOT: u32 = u32::MAX;

struct Reader<'a> {
	bytes: &'a [u8],
	at:    usize,
}

impl<'a> Reader<'a> {
	fn take(&mut self, len: usize) -> anyhow::Result<&'a [u8]> {
		let end = self
			.at
			.checked_add(len)
			.filter(|&end| end <= self.bytes.len());
		let Some(end) = end else {
			bail!("web prior: truncated")
		};
		let out = &self.bytes[self.at..end];
		self.at = end;
		Ok(out)
	}

	fn u32(&mut self) -> anyhow::Result<u32> {
		let mut raw = [0u8; 4];
		raw.copy_from_slice(self.take(4)?);
		Ok(u32::from_le_bytes(raw))
	}

	fn f64(&mut self) -> anyhow::Result<f64> {
		let mut raw = [0u8; 8];
		raw.copy_from_slice(self.take(8)?);
		Ok(f64::from_le_bytes(raw))
	}

	fn u32s(&mut self, n: usize) -> anyhow::Result<Vec<u32>> {
		Ok(self
			.take(n * 4)?
			.as_chunks::<4>()
			.0
			.iter()
			.map(|c| u32::from_le_bytes(*c))
			.collect())
	}

	fn f32s(&mut self, n: usize) -> anyhow::Result<Vec<f32>> {
		Ok(self
			.take(n * 4)?
			.as_chunks::<4>()
			.0
			.iter()
			.map(|c| f32::from_le_bytes(*c))
			.collect())
	}

	fn blob(&mut self, count: usize) -> anyhow::Result<&'a [u8]> {
		let rest = &self.bytes[self.at..];
		let mut seen = 0;
		let mut len = 0;
		for (i, &b) in rest.iter().enumerate() {
			if seen == count {
				break;
			}
			if b == b'\n' {
				seen += 1;
				len = i + 1;
			}
		}
		ensure!(seen == count, "web prior: word list truncated");
		self.take(len)
	}
}

impl WebPrior {
	fn decode(artifact: &[u8]) -> anyhow::Result<Self> {
		let raw = zstd::decode_all(artifact).context("web prior: zstd decode")?;
		let mut r = Reader { bytes: &raw, at: 0 };
		ensure!(r.take(4)? == MAGIC, "web prior: bad magic");
		let version = r.u32()?;
		ensure!(version == VERSION, "web prior: unsupported version {version}");
		let n = r.u32()? as usize;
		let n_dict = r.u32()? as usize;
		let n_ctx = r.u32()? as usize;
		let n_rows = r.u32()? as usize;
		let sentence_total = r.f64()?;
		let count = r.f32s(n)?;
		let dict_bits = r.take(n.div_ceil(8))?;
		let contexts = r.u32s(n_ctx)?;
		let lengths = r.u32s(n_ctx)?;
		let deltas = r.u32s(n_rows)?;
		let counts = r.f32s(n_rows)?;
		let words = SortedWords::parse(r.blob(n)?, n)?;
		let dict_only = SortedWords::parse(r.blob(n_dict)?, n_dict)?;

		let total: f64 = count.iter().map(|&c| f64::from(c)).sum();
		let p0: Vec<f32> = count
			.iter()
			.map(|&c| (f64::from(c) / total) as f32)
			.collect();
		let mut p0_cum = Vec::with_capacity(n + 1);
		let mut acc = 0.0f64;
		p0_cum.push(0.0);
		for &p in &p0 {
			acc += f64::from(p);
			p0_cum.push(acc);
		}
		let mut in_dict = vec![0u64; n.div_ceil(64)];
		for (i, word) in in_dict.iter_mut().enumerate() {
			for byte in 0..8 {
				if let Some(&b) = dict_bits.get(i * 8 + byte) {
					*word |= u64::from(b) << (byte * 8);
				}
			}
		}

		let mut slot = vec![NO_SLOT; n + 1];
		let mut start = Vec::with_capacity(n_ctx + 1);
		let mut follower = Vec::with_capacity(n_rows);
		let mut prob = Vec::with_capacity(n_rows);
		let mut covered = Vec::with_capacity(n_ctx);
		let mut row = 0usize;
		for (s, (&ctx, &len)) in contexts.iter().zip(&lengths).enumerate() {
			let ctx = ctx as usize;
			ensure!(ctx <= n, "web prior: context id out of range");
			slot[ctx] = s as u32;
			start.push(row as u32);
			let denominator = if ctx == n {
				sentence_total / SENTENCE_COVERAGE
			} else {
				f64::from(count[ctx])
			};
			let mut id = 0u32;
			let mut mass = 0.0f64;
			for i in 0..len as usize {
				let delta = *deltas
					.get(row + i)
					.context("web prior: bigram rows truncated")?;
				id = if i == 0 { delta } else { id + delta };
				ensure!((id as usize) < n, "web prior: follower id out of range");
				let p = f64::from(counts[row + i]) / denominator;
				follower.push(id);
				prob.push(p as f32);
				mass += p;
			}
			covered.push(mass.min(1.0) as f32);
			row += len as usize;
		}
		ensure!(row == n_rows, "web prior: bigram row count mismatch");
		start.push(row as u32);
		Ok(Self {
			words,
			count,
			p0,
			p0_cum,
			in_dict,
			dict_only,
			slot,
			start,
			follower,
			prob,
			covered,
		})
	}

	/// Number of vocabulary words.
	pub const fn len(&self) -> usize {
		self.words.len()
	}

	/// Whether web word `id` is a dictionary word.
	#[inline]
	pub fn in_dict(&self, id: usize) -> bool {
		self.in_dict[id / 64] >> (id % 64) & 1 == 1
	}

	/// Whether `word` (lowercase) is a real spelling: in the dictionary, or
	/// at least [`TRUSTED_WEB_COUNT`] on the web. `web_id` is its web id.
	pub fn trusted(&self, word: &str, web_id: Option<usize>) -> bool {
		match web_id {
			Some(id) => self.in_dict(id) || self.count[id] >= TRUSTED_WEB_COUNT,
			None => self.dict_only.find(word).is_some(),
		}
	}

	/// Bigram slot of context web id `id` (`len()` = sentence start).
	#[inline]
	pub fn slot(&self, id: usize) -> u32 {
		self.slot[id]
	}

	/// Row range of `slot`.
	#[inline]
	pub fn rows(&self, slot: u32) -> (usize, usize) {
		(self.start[slot as usize] as usize, self.start[slot as usize + 1] as usize)
	}

	/// First row of `slot` whose follower id is `>= id`.
	#[inline]
	pub fn lower_row(&self, slot: u32, id: u32) -> usize {
		let (lo, hi) = self.rows(slot);
		lo + self.follower[lo..hi].partition_point(|&x| x < id)
	}

	/// `P_web(id | slot)`, 0 when absent.
	#[inline]
	pub fn prob_of(&self, slot: u32, id: u32) -> f32 {
		let at = self.lower_row(slot, id);
		if at < self.rows(slot).1 && self.follower[at] == id {
			self.prob[at]
		} else {
			0.0
		}
	}

	/// Heap bytes held by the prior.
	pub const fn heap_bytes(&self) -> usize {
		self.words.heap_bytes()
			+ self.dict_only.heap_bytes()
			+ self.count.capacity() * 4
			+ self.p0.capacity() * 4
			+ self.p0_cum.capacity() * 8
			+ self.in_dict.capacity() * 8
			+ self.slot.capacity() * 4
			+ self.start.capacity() * 4
			+ self.follower.capacity() * 4
			+ self.prob.capacity() * 4
			+ self.covered.capacity() * 4
	}
}

/// The process-wide web prior, decoded on first use.
///
/// # Errors
/// Returns an error when the embedded artifact is corrupt (a build defect).
pub fn web_prior() -> anyhow::Result<&'static WebPrior> {
	static PRIOR: LazyLock<Result<WebPrior, String>> =
		LazyLock::new(|| WebPrior::decode(ARTIFACT).map_err(|error| format!("{error:#}")));
	PRIOR.as_ref().map_err(|error| anyhow::anyhow!("{error}"))
}
