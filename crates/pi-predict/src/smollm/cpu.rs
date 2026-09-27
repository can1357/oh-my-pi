//! Portable CPU decoder: 8-bit block-quantized weights, f32 activations.
//!
//! Batch-1 decoding reads every weight once per token, so it is bound by
//! memory bandwidth: 8-bit blocks (one f32 scale per 32 weights) cut the
//! traffic 4× against f32 while activations and accumulation stay f32 (no
//! activation quantization).
//!
//! A forward pass is ~250 dependent steps of a few microseconds each, far
//! below what a work-stealing pool can hand out profitably (its idle workers
//! sleep between steps). So one pass runs SPMD:
//! [`rayon::ThreadPool::broadcast`] starts every worker of a private pool once,
//! each takes its share of every step (weight rows for mat-vecs, tokens or
//! heads elsewhere), and a spinning [`Barrier`] separates the steps. Workers
//! write disjoint ranges of shared buffers ([`Shared`]) between barriers.

use std::{
	marker::PhantomData,
	ops::Range,
	sync::atomic::{AtomicUsize, Ordering},
};

use super::config::{Decoder, KvRow, LlamaConfig, TensorSource};

/// Weights per quantization block.
const BLOCK: usize = 32;

/// Row-major matrix of 8-bit blocks with one f32 scale per block.
struct Q8 {
	rows:   usize,
	cols:   usize,
	quants: Vec<[i8; BLOCK]>,
	scales: Vec<f32>,
}

impl Q8 {
	fn quantize(values: &[f32], rows: usize, cols: usize) -> Self {
		debug_assert_eq!(values.len(), rows * cols);
		let (blocks, _) = values.as_chunks::<BLOCK>();
		let mut quants = Vec::with_capacity(blocks.len());
		let mut scales = Vec::with_capacity(blocks.len());
		for block in blocks {
			let amax = block.iter().fold(0f32, |m, v| m.max(v.abs()));
			let scale = amax / 127.0;
			let inv = if scale > 0.0 { 1.0 / scale } else { 0.0 };
			quants.push(block.map(|v| (v * inv).round().clamp(-127.0, 127.0) as i8));
			scales.push(scale);
		}
		Self { rows, cols, quants, scales }
	}

	const fn blocks_per_row(&self) -> usize {
		self.cols / BLOCK
	}

	/// `row_j · x`.
	#[inline]
	fn dot(&self, j: usize, x: &[f32]) -> f32 {
		let per = self.blocks_per_row();
		let quants = &self.quants[j * per..(j + 1) * per];
		let scales = &self.scales[j * per..(j + 1) * per];
		let (xs, _) = x.as_chunks::<BLOCK>();
		// Lane-wise accumulators keep the reduction order fixed per lane, so
		// the compiler vectorizes without reassociating float adds.
		let mut acc = [0f32; 8];
		for ((q, x), &scale) in quants.iter().zip(xs).zip(scales) {
			let mut block = [0f32; 8];
			for (qc, xc) in q.as_chunks::<8>().0.iter().zip(x.as_chunks::<8>().0) {
				for k in 0..8 {
					block[k] = f32::mul_add(f32::from(qc[k]), xc[k], block[k]);
				}
			}
			for k in 0..8 {
				acc[k] = f32::mul_add(scale, block[k], acc[k]);
			}
		}
		acc.iter().sum()
	}

	fn dequantize_row(&self, j: usize, out: &mut [f32]) {
		let per = self.blocks_per_row();
		for (b, chunk) in out.as_chunks_mut::<BLOCK>().0.iter_mut().enumerate() {
			let scale = self.scales[j * per + b];
			for (o, &q) in chunk.iter_mut().zip(&self.quants[j * per + b]) {
				*o = f32::from(q) * scale;
			}
		}
	}
}

/// `a · b` with lane-wise accumulators.
#[inline]
fn dot_f32(a: &[f32], b: &[f32]) -> f32 {
	let mut acc = [0f32; 8];
	for (x, y) in a.as_chunks::<8>().0.iter().zip(b.as_chunks::<8>().0) {
		for k in 0..8 {
			acc[k] = f32::mul_add(x[k], y[k], acc[k]);
		}
	}
	acc.iter().sum()
}

/// `a · b[t]` for four rows of `b` at once: independent accumulator chains
/// keep the FMA pipes busy (the multi-token path is compute-bound).
#[inline]
fn dot4(a: &[f32], b: [&[f32]; 4]) -> [f32; 4] {
	let (a, _) = a.as_chunks::<8>();
	let b = b.map(|row| row.as_chunks::<8>().0);
	assert!(b.iter().all(|row| row.len() == a.len()));
	let mut acc = [[0f32; 8]; 4];
	for (i, x) in a.iter().enumerate() {
		for (acc, row) in acc.iter_mut().zip(&b) {
			for k in 0..8 {
				acc[k] = f32::mul_add(x[k], row[i][k], acc[k]);
			}
		}
	}
	acc.map(|lanes| lanes.iter().sum())
}

/// `w_j · input[l]` for every token row `l < n` of `input`, reported through
/// `emit(l, value)`. One token uses the 8-bit dot directly; more tokens
/// dequantize the row once into `scratch` and reuse it.
fn row_times(
	w: &Q8,
	j: usize,
	input: &Shared<'_>,
	n: usize,
	scratch: &mut [f32],
	mut emit: impl FnMut(usize, f32),
) {
	let cols = w.cols;
	// SAFETY: every caller reads a step input written before the last barrier.
	let token = |l: usize| unsafe { input.get(l * cols..(l + 1) * cols) };
	if n == 1 {
		emit(0, w.dot(j, token(0)));
		return;
	}
	let weights = &mut scratch[..cols];
	w.dequantize_row(j, weights);
	let mut l = 0;
	while l + 4 <= n {
		let values = dot4(weights, [token(l), token(l + 1), token(l + 2), token(l + 3)]);
		for (t, value) in values.into_iter().enumerate() {
			emit(l + t, value);
		}
		l += 4;
	}
	for l in l..n {
		emit(l, dot_f32(weights, token(l)));
	}
}

/// Contiguous share `tid` of `0..total` split `threads` ways.
const fn share(total: usize, tid: usize, threads: usize) -> Range<usize> {
	let (base, extra) = (total / threads, total % threads);
	let start = tid * base + if tid < extra { tid } else { extra };
	start..start + base + if tid < extra { 1 } else { 0 }
}

/// Sense-free spinning barrier for the workers of one forward pass.
struct Barrier {
	arrived:    AtomicUsize,
	generation: AtomicUsize,
	threads:    usize,
}

impl Barrier {
	const fn new(threads: usize) -> Self {
		Self { arrived: AtomicUsize::new(0), generation: AtomicUsize::new(0), threads }
	}

	fn wait(&self) {
		if self.threads == 1 {
			return;
		}
		let generation = self.generation.load(Ordering::Acquire);
		if self.arrived.fetch_add(1, Ordering::AcqRel) + 1 == self.threads {
			self.arrived.store(0, Ordering::Relaxed);
			self.generation.store(generation + 1, Ordering::Release);
			return;
		}
		let mut spins = 0u32;
		while self.generation.load(Ordering::Acquire) == generation {
			if spins < 1 << 14 {
				spins += 1;
				std::hint::spin_loop();
			} else {
				// A preempted worker: stop burning its core.
				std::thread::yield_now();
			}
		}
	}
}

/// A buffer the workers of one pass share. Within a step each element is
/// written by at most one worker and not read by others; [`Barrier::wait`]
/// orders a step's writes before the next step's reads.
struct Shared<'a> {
	ptr:   *mut f32,
	len:   usize,
	_data: PhantomData<&'a mut [f32]>,
}

// SAFETY: `Shared` only hands out access through its unsafe methods, whose
// callers uphold the per-step disjointness rule above; the pointee is plain
// `f32` data borrowed for `'a`.
unsafe impl Send for Shared<'_> {}
// SAFETY: as above.
unsafe impl Sync for Shared<'_> {}

impl<'a> Shared<'a> {
	const fn new(data: &'a mut [f32]) -> Self {
		Self { ptr: data.as_mut_ptr(), len: data.len(), _data: PhantomData }
	}

	/// # Safety
	/// No worker writes `range` during the current step.
	unsafe fn get(&self, range: Range<usize>) -> &[f32] {
		assert!(range.end <= self.len, "range past the buffer");
		assert!(range.start <= range.end, "inverted range");
		// SAFETY: in bounds (checked); no concurrent writer per the contract.
		unsafe { std::slice::from_raw_parts(self.ptr.add(range.start), range.len()) }
	}

	/// # Safety
	/// Only this worker touches `range` during the current step.
	#[expect(clippy::mut_from_ref, reason = "disjoint per-worker ranges, see the type docs")]
	unsafe fn get_mut(&self, range: Range<usize>) -> &mut [f32] {
		assert!(range.end <= self.len, "range past the buffer");
		assert!(range.start <= range.end, "inverted range");
		// SAFETY: in bounds (checked); exclusive per the contract.
		unsafe { std::slice::from_raw_parts_mut(self.ptr.add(range.start), range.len()) }
	}

	/// # Safety
	/// Only this worker touches element `at` during the current step.
	unsafe fn set(&self, at: usize, value: f32) {
		assert!(at < self.len);
		// SAFETY: in bounds (checked); exclusive per the contract.
		unsafe { self.ptr.add(at).write(value) }
	}
}

struct Layer {
	attn_norm: Vec<f32>,
	/// `[q; k; v]` fused.
	qkv:       Q8,
	out:       Q8,
	mlp_norm:  Vec<f32>,
	gate:      Q8,
	up:        Q8,
	down:      Q8,
}

/// The immutable model: weights and tables.
struct Weights {
	config: LlamaConfig,
	/// Token embedding, also the tied LM head.
	embed:  Q8,
	layers: Vec<Layer>,
	norm:   Vec<f32>,
	cos:    Vec<f32>,
	sin:    Vec<f32>,
}

/// `SmolLM2` on the CPU.
pub struct CpuLlama {
	weights: Weights,
	pool:    rayon::ThreadPool,
	threads: usize,
	/// Per layer `[position][kv_head][head_dim]`.
	keys:    Vec<Vec<f32>>,
	values:  Vec<Vec<f32>>,
	len:     usize,
}

fn rms_norm(x: &[f32], weight: &[f32], eps: f32, out: &mut [f32]) {
	let mean = x.iter().map(|v| v * v).sum::<f32>() / x.len() as f32;
	let inv = 1.0 / (mean + eps).sqrt();
	for ((d, &v), &w) in out.iter_mut().zip(x).zip(weight) {
		*d = v * inv * w;
	}
}

/// Non-interleaved `RoPE` (`x·cos + rotate_half(x)·sin`) on every head of one
/// token.
fn rope(x: &mut [f32], head_dim: usize, cos: &[f32], sin: &[f32]) {
	let half = head_dim / 2;
	for head in x.chunks_mut(head_dim) {
		let (a, b) = head.split_at_mut(half);
		for i in 0..half {
			let (x1, x2) = (a[i], b[i]);
			a[i] = f32::mul_add(x2, -sin[i], x1 * cos[i]);
			b[i] = f32::mul_add(x1, sin[i], x2 * cos[i]);
		}
	}
}

/// Dimensions of one forward pass.
#[derive(Clone, Copy)]
struct Pass {
	pos:       usize,
	n:         usize,
	keep_from: usize,
	threads:   usize,
}

/// Buffers of one forward pass, shared by its workers.
struct Buffers<'a> {
	/// Residual stream `[n][hidden]`.
	x:        Shared<'a>,
	/// Normalized input of the current block `[n][hidden]`.
	h:        Shared<'a>,
	/// `[n][hidden + 2·kv]`.
	qkv:      Shared<'a>,
	/// Attention output `[n][hidden]`.
	attended: Shared<'a>,
	/// Projection output `[n][hidden]`.
	proj:     Shared<'a>,
	/// `SwiGLU` activations `[n][inter]`.
	act:      Shared<'a>,
	/// `[kept][vocab]`.
	logits:   Shared<'a>,
	/// Per worker and kept row: `(max, Σ exp(v - max))` of its logits share.
	partial:  Shared<'a>,
	keys:     Vec<Shared<'a>>,
	values:   Vec<Shared<'a>>,
}

impl CpuLlama {
	/// Quantize the weights from `source` and start the worker pool.
	///
	/// # Errors
	/// Fails for missing or mis-shaped tensors and when no worker thread can
	/// be spawned.
	pub fn load(config: LlamaConfig, source: &mut impl TensorSource) -> anyhow::Result<Self> {
		config.validate()?;
		let c = &config;
		let (h, inter) = (c.hidden_size, c.intermediate_size);
		let kv = c.num_key_value_heads * c.head_dim();
		let embed = Q8::quantize(
			&source.expect("model.embed_tokens.weight", &[c.vocab_size, h])?,
			c.vocab_size,
			h,
		);
		let mut layers = Vec::with_capacity(c.num_hidden_layers);
		for i in 0..c.num_hidden_layers {
			let p = format!("model.layers.{i}");
			let mut w =
				|name: &str, shape: &[usize]| source.expect(&format!("{p}.{name}.weight"), shape);
			let mut qkv = w("self_attn.q_proj", &[h, h])?;
			qkv.extend(w("self_attn.k_proj", &[kv, h])?);
			qkv.extend(w("self_attn.v_proj", &[kv, h])?);
			layers.push(Layer {
				attn_norm: w("input_layernorm", &[h])?,
				qkv:       Q8::quantize(&qkv, h + 2 * kv, h),
				out:       Q8::quantize(&w("self_attn.o_proj", &[h, h])?, h, h),
				mlp_norm:  w("post_attention_layernorm", &[h])?,
				gate:      Q8::quantize(&w("mlp.gate_proj", &[inter, h])?, inter, h),
				up:        Q8::quantize(&w("mlp.up_proj", &[inter, h])?, inter, h),
				down:      Q8::quantize(&w("mlp.down_proj", &[h, inter])?, h, inter),
			});
		}
		let norm = source.expect("model.norm.weight", &[h])?;
		let (cos, sin) = c.rope_tables();
		// Batch-1 mat-vecs saturate memory bandwidth well before all cores,
		// and every barrier waits for the slowest worker (efficiency cores).
		let threads = std::thread::available_parallelism()
			.map_or(4, usize::from)
			.clamp(1, 8);
		let pool = rayon::ThreadPoolBuilder::new()
			.num_threads(threads)
			.thread_name(|i| format!("pi-smollm-{i}"))
			.build()?;
		let count = c.num_hidden_layers;
		Ok(Self {
			weights: Weights { config, embed, layers, norm, cos, sin },
			pool,
			threads,
			keys: vec![Vec::new(); count],
			values: vec![Vec::new(); count],
			len: 0,
		})
	}

	fn forward_inner(&mut self, tokens: &[u32], keep_from: usize) -> anyhow::Result<Vec<f32>> {
		let c = &self.weights.config;
		let (pos, n) = (self.len, tokens.len());
		anyhow::ensure!(
			pos + n <= c.max_position_embeddings,
			"sequence exceeds {} positions",
			c.max_position_embeddings
		);
		let (hidden, inter, vocab) = (c.hidden_size, c.intermediate_size, c.vocab_size);
		let kv_width = c.num_key_value_heads * c.head_dim();
		let kept = n - keep_from;
		let threads = self.threads;

		let mut x = vec![0f32; n * hidden];
		for (row, &token) in x.chunks_mut(hidden).zip(tokens) {
			anyhow::ensure!((token as usize) < vocab, "token {token} out of range");
			self.weights.embed.dequantize_row(token as usize, row);
		}
		let mut h = vec![0f32; n * hidden];
		let mut qkv = vec![0f32; n * (hidden + 2 * kv_width)];
		let mut attended = vec![0f32; n * hidden];
		let mut proj = vec![0f32; n * hidden];
		let mut act = vec![0f32; n * inter];
		let mut logits = vec![0f32; kept * vocab];
		let mut partial = vec![0f32; threads * kept * 2];
		for cache in self.keys.iter_mut().chain(self.values.iter_mut()) {
			cache.resize((pos + n) * kv_width, 0.0);
		}
		let buffers = Buffers {
			x:        Shared::new(&mut x),
			h:        Shared::new(&mut h),
			qkv:      Shared::new(&mut qkv),
			attended: Shared::new(&mut attended),
			proj:     Shared::new(&mut proj),
			act:      Shared::new(&mut act),
			logits:   Shared::new(&mut logits),
			partial:  Shared::new(&mut partial),
			keys:     self.keys.iter_mut().map(|k| Shared::new(k)).collect(),
			values:   self.values.iter_mut().map(|v| Shared::new(v)).collect(),
		};
		let pass = Pass { pos, n, keep_from, threads };
		let barrier = Barrier::new(threads);
		let weights = &self.weights;
		self
			.pool
			.broadcast(|ctx| weights.work(ctx.index(), pass, &buffers, &barrier));
		drop(buffers);
		self.len = pos + n;
		Ok(logits)
	}
}

impl Weights {
	/// One worker's part of a forward pass.
	#[allow(clippy::many_single_char_names, reason = "q/k/v/n/c follow the transformer notation")]
	fn work(&self, tid: usize, pass: Pass, b: &Buffers<'_>, barrier: &Barrier) {
		let c = &self.config;
		let Pass { pos, n, keep_from, threads } = pass;
		let (hidden, inter, vocab) = (c.hidden_size, c.intermediate_size, c.vocab_size);
		let (heads, kv_heads, head_dim) =
			(c.num_attention_heads, c.num_key_value_heads, c.head_dim());
		let (kv_width, group, half) = (kv_heads * head_dim, heads / kv_heads, head_dim / 2);
		let qkv_width = hidden + 2 * kv_width;
		let eps = c.rms_norm_eps as f32;
		let scale = 1.0 / (head_dim as f32).sqrt();
		let my_tokens = share(n, tid, threads);
		// Dequantized weight rows (two for SwiGLU) and per-token gate values.
		let mut row = vec![0f32; 2 * hidden.max(inter)];
		let mut gates = vec![0f32; n];

		// `out[l][j] = w_j · input[l]` for this worker's rows of `w`.
		let matmul = |w: &Q8, input: &Shared<'_>, out: &Shared<'_>, row: &mut [f32]| {
			for j in share(w.rows, tid, threads) {
				row_times(w, j, input, n, row, |l, value| {
					// SAFETY: element (l, j) belongs to this worker's rows.
					unsafe { out.set(l * w.rows + j, value) }
				});
			}
		};

		for (index, layer) in self.layers.iter().enumerate() {
			for l in my_tokens.clone() {
				// SAFETY: token rows are this worker's in this step.
				unsafe {
					rms_norm(
						b.x.get(l * hidden..(l + 1) * hidden),
						&layer.attn_norm,
						eps,
						b.h.get_mut(l * hidden..(l + 1) * hidden),
					);
				};
			}
			barrier.wait();
			matmul(&layer.qkv, &b.h, &b.qkv, &mut row);
			barrier.wait();
			for l in my_tokens.clone() {
				let at = (pos + l) * half;
				// SAFETY: token rows are this worker's in this step, and so are
				// the KV positions they fill.
				let (q_row, keys, values) = unsafe {
					(
						b.qkv.get_mut(l * qkv_width..(l + 1) * qkv_width),
						b.keys[index].get_mut((pos + l) * kv_width..(pos + l + 1) * kv_width),
						b.values[index].get_mut((pos + l) * kv_width..(pos + l + 1) * kv_width),
					)
				};
				let (q, kv) = q_row.split_at_mut(hidden);
				let (k, v) = kv.split_at_mut(kv_width);
				rope(q, head_dim, &self.cos[at..at + half], &self.sin[at..at + half]);
				rope(k, head_dim, &self.cos[at..at + half], &self.sin[at..at + half]);
				keys.copy_from_slice(k);
				values.copy_from_slice(v);
			}
			barrier.wait();
			let mut scores = Vec::new();
			for slot in share(n * heads, tid, threads) {
				let (l, head) = (slot / heads, slot % heads);
				let visible = pos + l + 1;
				let offset = (head / group) * head_dim;
				// SAFETY: queries and KV rows were written before the barrier;
				// the output slot is this worker's.
				let (q, keys, values, out) = unsafe {
					(
						b.qkv
							.get(l * qkv_width + head * head_dim..l * qkv_width + (head + 1) * head_dim),
						b.keys[index].get(0..visible * kv_width),
						b.values[index].get(0..visible * kv_width),
						b.attended.get_mut(slot * head_dim..(slot + 1) * head_dim),
					)
				};
				scores.clear();
				scores.extend(
					keys
						.chunks_exact(kv_width)
						.map(|k| dot_f32(q, &k[offset..offset + head_dim]) * scale),
				);
				let max = scores.iter().copied().fold(f32::NEG_INFINITY, f32::max);
				let mut sum = 0f32;
				for s in &mut scores {
					*s = (*s - max).exp();
					sum += *s;
				}
				out.fill(0.0);
				for (&p, v) in scores.iter().zip(values.chunks_exact(kv_width)) {
					let w = p / sum;
					for (o, &vv) in out.iter_mut().zip(&v[offset..offset + head_dim]) {
						*o = w.mul_add(vv, *o);
					}
				}
			}
			barrier.wait();
			matmul(&layer.out, &b.attended, &b.proj, &mut row);
			barrier.wait();
			for l in my_tokens.clone() {
				let token = l * hidden..(l + 1) * hidden;
				// SAFETY: token rows are this worker's in this step.
				let (x, proj, h) = unsafe {
					(b.x.get_mut(token.clone()), b.proj.get(token.clone()), b.h.get_mut(token))
				};
				for (a, p) in x.iter_mut().zip(proj) {
					*a += p;
				}
				rms_norm(x, &layer.mlp_norm, eps, h);
			}
			barrier.wait();
			// SwiGLU with gate and up rows side by side, so each worker
			// finishes its activations without another step.
			let (gate_row, up_row) = row.split_at_mut(hidden);
			for i in share(inter, tid, threads) {
				row_times(&layer.gate, i, &b.h, n, gate_row, |l, value| gates[l] = value);
				row_times(&layer.up, i, &b.h, n, up_row, |l, u| {
					let g = gates[l];
					// SAFETY: activation (l, i) belongs to this worker's rows.
					unsafe { b.act.set(l * inter + i, g / (1.0 + (-g).exp()) * u) };
				});
			}
			barrier.wait();
			matmul(&layer.down, &b.act, &b.proj, &mut row);
			barrier.wait();
			for l in my_tokens.clone() {
				let token = l * hidden..(l + 1) * hidden;
				// SAFETY: token rows are this worker's in this step (and in the
				// next layer's first step, so no barrier is needed here).
				let (x, proj) = unsafe { (b.x.get_mut(token.clone()), b.proj.get(token)) };
				for (a, p) in x.iter_mut().zip(proj) {
					*a += p;
				}
			}
		}

		let kept = n - keep_from;
		for l in my_tokens.filter(|&l| l >= keep_from) {
			let (src, dst) =
				(l * hidden..(l + 1) * hidden, (l - keep_from) * hidden..(l - keep_from + 1) * hidden);
			// SAFETY: token rows are this worker's in this step; `h` rows of
			// kept tokens are rewritten by their own worker.
			unsafe { rms_norm(b.x.get(src), &self.norm, eps, b.h.get_mut(dst)) };
		}
		barrier.wait();
		// LM head over this worker's vocab rows, with a partial log-sum-exp.
		let rows = share(vocab, tid, threads);
		for l in 0..kept {
			// SAFETY: normalized rows were written before the barrier; the
			// logits slice and partial slot are this worker's.
			let (h, out, part) = unsafe {
				(
					b.h.get(l * hidden..(l + 1) * hidden),
					b.logits
						.get_mut(l * vocab + rows.start..l * vocab + rows.end),
					b.partial
						.get_mut((tid * kept + l) * 2..(tid * kept + l) * 2 + 2),
				)
			};
			for (o, j) in out.iter_mut().zip(rows.clone()) {
				*o = self.embed.dot(j, h);
			}
			let max = out.iter().copied().fold(f32::NEG_INFINITY, f32::max);
			part[0] = max;
			part[1] = out.iter().map(|&v| (v - max).exp()).sum();
		}
		barrier.wait();
		for l in 0..kept {
			// SAFETY: every worker's partials were written before the barrier.
			let parts = unsafe { b.partial.get(0..threads * kept * 2) };
			let slots =
				(0..threads).map(|t| (parts[(t * kept + l) * 2], parts[(t * kept + l) * 2 + 1]));
			let max = slots
				.clone()
				.map(|(m, _)| m)
				.fold(f32::NEG_INFINITY, f32::max);
			let sum: f64 = slots
				.map(|(m, s)| f64::from(s) * f64::from(m - max).exp())
				.sum();
			let log_z = max + sum.ln() as f32;
			// SAFETY: this worker's logits share.
			let out = unsafe {
				b.logits
					.get_mut(l * vocab + rows.start..l * vocab + rows.end)
			};
			for v in out {
				*v -= log_z;
			}
		}
	}
}

impl Decoder for CpuLlama {
	fn vocab_size(&self) -> usize {
		self.weights.config.vocab_size
	}

	fn truncate(&mut self, len: usize) {
		self.len = self.len.min(len);
	}

	fn last_kv(&self) -> anyhow::Result<KvRow> {
		anyhow::ensure!(self.len > 0, "empty KV cache");
		let c = &self.weights.config;
		let width = c.num_key_value_heads * c.head_dim();
		let at = (self.len - 1) * width..self.len * width;
		let mut row = Vec::with_capacity(2 * width * self.keys.len());
		for (keys, values) in self.keys.iter().zip(&self.values) {
			row.extend_from_slice(&keys[at.clone()]);
			row.extend_from_slice(&values[at.clone()]);
		}
		Ok(KvRow::Host(row.into()))
	}

	fn restore(&mut self, at: usize, row: &KvRow) -> anyhow::Result<()> {
		#[cfg_attr(
			not(target_os = "macos"),
			expect(irrefutable_let_patterns, reason = "one variant off macOS")
		)]
		let KvRow::Host(row) = row else {
			anyhow::bail!("KV row from another backend")
		};
		anyhow::ensure!(at <= self.len, "restore past the cached length");
		let c = &self.weights.config;
		let width = c.num_key_value_heads * c.head_dim();
		anyhow::ensure!(row.len() == 2 * width * self.keys.len(), "KV row of another model");
		for ((keys, values), layer) in self
			.keys
			.iter_mut()
			.zip(&mut self.values)
			.zip(row.chunks_exact(2 * width))
		{
			keys.resize((at + 1) * width, 0.0);
			values.resize((at + 1) * width, 0.0);
			keys[at * width..].copy_from_slice(&layer[..width]);
			values[at * width..].copy_from_slice(&layer[width..]);
		}
		self.len = at + 1;
		Ok(())
	}

	fn forward(&mut self, tokens: &[u32], keep_from: usize) -> anyhow::Result<Vec<f32>> {
		anyhow::ensure!(keep_from < tokens.len(), "nothing to score");
		let result = self.forward_inner(tokens, keep_from);
		if result.is_err() {
			self.len = 0;
		}
		result
	}
}

#[cfg(test)]
pub(super) mod tests {
	use super::{
		super::config::tests::{RandomWeights, tiny_config},
		*,
	};

	pub fn random(vocab: usize, seed: u64) -> CpuLlama {
		let config = tiny_config(vocab);
		CpuLlama::load(config.clone(), &mut RandomWeights::new(&config, seed)).expect("random llama")
	}

	fn close(a: &[f32], b: &[f32]) -> bool {
		a.len() == b.len() && a.iter().zip(b).all(|(x, y)| (x - y).abs() < 1e-4)
	}

	#[test]
	fn cached_and_truncated_forwards_match_a_full_pass() {
		let tokens = [1u32, 7, 3, 9, 4, 4, 2];
		let vocab = 12;
		let mut model = random(vocab, 7);
		let full = model.forward(&tokens, 0).expect("full");

		model.truncate(0);
		for (i, &t) in tokens.iter().enumerate() {
			let row = model.forward(&[t], 0).expect("step");
			assert!(close(&row, &full[i * vocab..(i + 1) * vocab]), "step {i}");
		}
		// Branch: cut back to 3 tokens, extend differently, then return.
		model.truncate(3);
		model.forward(&[11, 10], 0).expect("branch");
		model.truncate(3);
		let rest = model.forward(&tokens[3..], 1).expect("rest");
		assert!(close(&rest, &full[4 * vocab..]));
		let row_sum: f32 = rest[..vocab].iter().map(|lp| lp.exp()).sum();
		assert!((row_sum - 1.0).abs() < 1e-4, "log-probs are normalized");
	}

	#[test]
	fn worker_count_does_not_change_the_result() {
		let tokens = [1u32, 7, 3, 9, 4];
		let mut many = random(40, 9);
		let mut one = random(40, 9);
		one.threads = 1;
		one.pool = rayon::ThreadPoolBuilder::new()
			.num_threads(1)
			.build()
			.expect("pool");
		assert!(close(
			&many.forward(&tokens, 0).expect("many"),
			&one.forward(&tokens, 0).expect("one")
		));
		assert!(close(&many.forward(&[5], 0).expect("many"), &one.forward(&[5], 0).expect("one")));
	}

	#[test]
	fn overlong_sequences_fail_and_empty_the_cache() {
		let mut model = random(12, 1);
		let limit = model.weights.config.max_position_embeddings;
		model.forward(&vec![1; limit - 1], limit - 2).expect("fits");
		assert!(model.forward(&[1, 2], 1).is_err());
		assert_eq!(model.len, 0);
	}
}
