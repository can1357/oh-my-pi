//! Versioned binary snapshot of the learned model.
//!
//! Layout: `b"PINGRAM\0"`, `u32` version (little endian), then one zstd frame
//! (with content checksum) holding the payload below. Words are stored as
//! strings, so a snapshot survives changes to the embedded web prior; the
//! prefix trees and hygiene flags are rebuilt on load.
//!
//! ```text
//! f64 total
//! u32 words     { u16 len, utf8, f32 count, u32 raw }
//! u32 contexts  { u32 word, u32 n, n × { u32 word, f32 count } }
//! u32 pairs     { u32 u, u32 v, f32 total, u32 types }        (pair index = position)
//! u32 trigrams  { u32 pair, u32 word, f32 count }
//! u32 tailed    { u32 word, u32 n, n × { u16 len, utf8, f32 count } }
//! u32 prompts   { u32 n, n × u32 word }                        (session cache, oldest first)
//! ```

use std::io::Write;

use anyhow::{Context, bail, ensure};

use super::{
	model::{Model, NONE, Params},
	structures::Followers,
	web::WebPrior,
};

const MAGIC: &[u8; 8] = b"PINGRAM\0";
/// Current snapshot format.
pub const VERSION: u32 = 1;

/// Payload writer streaming into the zstd encoder through a small buffer;
/// the first I/O error sticks and surfaces from [`Writer::finish`].
struct Writer {
	encoder: zstd::stream::Encoder<'static, Vec<u8>>,
	buf:     Vec<u8>,
	error:   Option<std::io::Error>,
}

impl Writer {
	fn put(&mut self, bytes: &[u8]) {
		self.buf.extend_from_slice(bytes);
		if self.buf.len() >= 1 << 16 {
			self.flush();
		}
	}

	fn flush(&mut self) {
		if self.error.is_none()
			&& let Err(error) = self.encoder.write_all(&self.buf)
		{
			self.error = Some(error);
		}
		self.buf.clear();
	}

	fn finish(mut self) -> anyhow::Result<Vec<u8>> {
		self.flush();
		if let Some(error) = self.error {
			return Err(error.into());
		}
		Ok(self.encoder.finish()?)
	}

	fn u16(&mut self, value: u16) {
		self.put(&value.to_le_bytes());
	}

	fn u32(&mut self, value: u32) {
		self.put(&value.to_le_bytes());
	}

	fn len(&mut self, value: usize) {
		self.u32(value as u32);
	}

	fn f32(&mut self, value: f32) {
		self.put(&value.to_le_bytes());
	}

	fn f64(&mut self, value: f64) {
		self.put(&value.to_le_bytes());
	}

	fn text(&mut self, text: &str) {
		// Words are capped far below this by the prose gates' line limit.
		let mut end = text.len().min(usize::from(u16::MAX));
		while !text.is_char_boundary(end) {
			end -= 1;
		}
		self.u16(end as u16);
		self.put(&text.as_bytes()[..end]);
	}
}

struct Reader<'a> {
	bytes: &'a [u8],
	at:    usize,
}

impl<'a> Reader<'a> {
	fn take(&mut self, len: usize) -> anyhow::Result<&'a [u8]> {
		let Some(end) = self
			.at
			.checked_add(len)
			.filter(|&end| end <= self.bytes.len())
		else {
			bail!("snapshot truncated");
		};
		let out = &self.bytes[self.at..end];
		self.at = end;
		Ok(out)
	}

	fn array<const N: usize>(&mut self) -> anyhow::Result<[u8; N]> {
		let mut out = [0u8; N];
		out.copy_from_slice(self.take(N)?);
		Ok(out)
	}

	fn u16(&mut self) -> anyhow::Result<u16> {
		Ok(u16::from_le_bytes(self.array()?))
	}

	fn u32(&mut self) -> anyhow::Result<u32> {
		Ok(u32::from_le_bytes(self.array()?))
	}

	/// A count of following records, bounded by the bytes left.
	fn len(&mut self, min_record: usize) -> anyhow::Result<usize> {
		let n = self.u32()? as usize;
		ensure!(
			n.saturating_mul(min_record) <= self.bytes.len() - self.at,
			"snapshot count out of range"
		);
		Ok(n)
	}

	fn f32(&mut self) -> anyhow::Result<f32> {
		Ok(f32::from_le_bytes(self.array()?))
	}

	fn f64(&mut self) -> anyhow::Result<f64> {
		Ok(f64::from_le_bytes(self.array()?))
	}

	fn text(&mut self) -> anyhow::Result<&'a str> {
		let len = usize::from(self.u16()?);
		std::str::from_utf8(self.take(len)?).context("snapshot word is not UTF-8")
	}

	fn word(&mut self, map: &[u32]) -> anyhow::Result<u32> {
		let at = self.u32()? as usize;
		map.get(at)
			.copied()
			.context("snapshot word index out of range")
	}
}

/// Serialize `model`'s learned state.
///
/// # Errors
/// Returns an error when compression fails.
pub fn encode(model: &Model) -> anyhow::Result<Vec<u8>> {
	let n = model.vocab.len();
	let mut keep = vec![false; n];
	for (id, kept) in keep.iter_mut().enumerate() {
		*kept = model.count[id] > 0.0 || model.raw[id] > 0 || model.ctx_slot[id] != NONE;
	}
	for list in &model.followers {
		for &id in &list.ids {
			keep[id as usize] = true;
		}
	}
	let mut pair_keys = vec![0u64; model.pair_total.len()];
	for (key, pair) in model.pairs.iter() {
		pair_keys[pair as usize] = key;
		keep[(key >> 32) as usize] = true;
		keep[(key & 0xffff_ffff) as usize] = true;
	}
	for (key, _) in model.tri.iter() {
		keep[(key & 0xffff_ffff) as usize] = true;
	}
	for &id in model.tails.keys() {
		keep[id as usize] = true;
	}
	for prompt in &model.session.prompts {
		for &id in prompt {
			keep[id as usize] = true;
		}
	}
	let mut index = vec![NONE; n];
	let mut out = MAGIC.to_vec();
	out.extend_from_slice(&VERSION.to_le_bytes());
	let mut encoder = zstd::stream::Encoder::new(out, 3)?;
	encoder.include_checksum(true)?;
	let mut w = Writer { encoder, buf: Vec::with_capacity(1 << 16), error: None };
	w.f64(model.total);
	w.len(keep.iter().filter(|&&k| k).count());
	let mut next = 0u32;
	for id in 0..n {
		if keep[id] {
			index[id] = next;
			next += 1;
			w.text(model.vocab.word(id as u32));
			w.f32(model.count[id]);
			w.u32(model.raw[id]);
		}
	}
	let contexts: Vec<(usize, &Followers)> = (0..n)
		.filter(|&id| model.ctx_slot[id] != NONE)
		.map(|id| (id, &model.followers[model.ctx_slot[id] as usize]))
		.collect();
	w.len(contexts.len());
	for (id, list) in contexts {
		w.u32(index[id]);
		w.len(list.ids.len());
		for (&follower, &count) in list.ids.iter().zip(&list.counts) {
			w.u32(index[follower as usize]);
			w.f32(count);
		}
	}
	w.len(pair_keys.len());
	for (pair, &key) in pair_keys.iter().enumerate() {
		w.u32(index[(key >> 32) as usize]);
		w.u32(index[(key & 0xffff_ffff) as usize]);
		w.f32(model.pair_total[pair]);
		w.u32(model.pair_types[pair]);
	}
	w.len(model.tri.len());
	for (key, count) in model.tri.iter() {
		w.u32((key >> 32) as u32);
		w.u32(index[(key & 0xffff_ffff) as usize]);
		w.f32(count);
	}
	w.len(model.tails.len());
	for (&id, forms) in &model.tails {
		w.u32(index[id as usize]);
		w.len(forms.len());
		for (form, count) in forms {
			w.text(form);
			w.f32(*count);
		}
	}
	w.len(model.session.prompts.len());
	for prompt in &model.session.prompts {
		w.len(prompt.len());
		for &id in prompt {
			w.u32(index[id as usize]);
		}
	}
	w.finish()
}

/// Restore a model from a snapshot.
///
/// # Errors
/// Returns an error for an unknown magic or version, or a corrupt payload.
pub fn decode(bytes: &[u8], params: Params, web: &'static WebPrior) -> anyhow::Result<Model> {
	ensure!(bytes.len() >= 12 && &bytes[..8] == MAGIC, "not an n-gram snapshot");
	let version = u32::from_le_bytes([bytes[8], bytes[9], bytes[10], bytes[11]]);
	ensure!(
		version == VERSION,
		"unsupported n-gram snapshot version {version} (expected {VERSION})"
	);
	let payload = zstd::decode_all(&bytes[12..]).context("corrupt n-gram snapshot")?;
	let mut r = Reader { bytes: &payload, at: 0 };
	let total = r.f64()?;
	let n_words = r.len(10)?;
	let mut words = Vec::with_capacity(n_words);
	for _ in 0..n_words {
		words.push((r.text()?, r.f32()?, r.u32()?));
	}
	let mut model = Model::with_words(params, web, words.iter().map(|&(word, ..)| word).collect());
	model.total = total;
	let mut map = Vec::with_capacity(n_words);
	for &(word, count, raw) in &words {
		let id = model
			.vocab
			.find(word)
			.context("snapshot word missing from the vocabulary")?;
		model.count[id as usize] = count;
		model.raw[id as usize] = raw;
		map.push(id);
	}
	let mut order = Vec::new();
	for _ in 0..r.len(8)? {
		let ctx = r.word(&map)?;
		order.clear();
		for _ in 0..r.len(8)? {
			order.push((r.word(&map)?, r.f32()?));
		}
		order.sort_unstable_by_key(|&(id, _)| id);
		let mut list = Followers::default();
		for &(id, count) in &order {
			ensure!(list.ids.last() != Some(&id), "duplicate snapshot follower");
			list.total += f64::from(count);
			list.ids.push(id);
			list.counts.push(count);
		}
		ensure!(model.ctx_slot[ctx as usize] == NONE, "duplicate snapshot context");
		model.ctx_slot[ctx as usize] = model.followers.len() as u32;
		model.followers.push(list);
	}
	let n_pairs = r.len(16)?;
	for pair in 0..n_pairs {
		let (u, v) = (r.word(&map)?, r.word(&map)?);
		let (slot, fresh) = model.pairs.entry(u64::from(u) << 32 | u64::from(v));
		ensure!(fresh, "duplicate snapshot pair");
		*slot = pair as u32;
		model.pair_total.push(r.f32()?);
		model.pair_types.push(r.u32()?);
	}
	for _ in 0..r.len(12)? {
		let pair = r.u32()?;
		ensure!((pair as usize) < n_pairs, "snapshot trigram pair out of range");
		let w = r.word(&map)?;
		*model.tri.entry(u64::from(pair) << 32 | u64::from(w)).0 = r.f32()?;
	}
	for _ in 0..r.len(8)? {
		let id = r.word(&map)?;
		let mut forms = Vec::new();
		for _ in 0..r.len(6)? {
			let form = r.text()?;
			forms.push((form.into(), r.f32()?));
		}
		model.tails.insert(id, forms);
	}
	let mut prompts = Vec::new();
	for _ in 0..r.len(4)? {
		let mut prompt = Vec::new();
		for _ in 0..r.len(4)? {
			prompt.push(r.word(&map)?);
		}
		prompts.push(prompt);
	}
	ensure!(r.at == payload.len(), "trailing bytes in n-gram snapshot");
	model.restore_session(prompts);
	model.rebuild_ranges();
	model.sweep_hygiene();
	Ok(model)
}
