//! Core modules: `TextEncoder`, `ProsodyPredictor`, `DurationEncoder`,
//! `AdaLayerNorm`, etc.
//!
//! Ported from kokoro/models.py (`StyleTTS` 2).

use candle_core::{Module, Result, Tensor};
use candle_nn::{self as nn, VarBuilder};

use super::bilstm::BiLSTM;

// ---------------------------------------------------------------------------
// ChannelsFirstLayerNorm
// ---------------------------------------------------------------------------

/// `LayerNorm` on channels-first [B, C, T] tensors.
/// Python: gamma/beta stored as weight/bias in safetensors.
pub struct ChannelsFirstLayerNorm {
	weight: Tensor,
	bias:   Tensor,
	eps:    f32,
}

impl ChannelsFirstLayerNorm {
	/// Loads normalization parameters from the model checkpoint.
	pub fn load(channels: usize, eps: f64, vb: VarBuilder) -> Result<Self> {
		let weight = vb
			.get(channels, "weight")
			.or_else(|_| vb.get(channels, "gamma"))?;
		let bias = vb
			.get(channels, "bias")
			.or_else(|_| vb.get(channels, "beta"))?;
		Ok(Self { weight, bias, eps: eps as f32 })
	}

	/// Normalizes channels independently at every timestep.
	pub fn forward(&self, x: &Tensor) -> Result<Tensor> {
		// x: [B, C, T] -> [B, T, C]
		let x = x.transpose(1, 2)?.contiguous()?;
		let x = nn::ops::layer_norm(&x, &self.weight, &self.bias, self.eps)?;
		x.transpose(1, 2)
	}
}

// ---------------------------------------------------------------------------
// AdaLayerNorm — style-conditioned layer norm
// ---------------------------------------------------------------------------

/// Applies layer normalization whose scale and bias are conditioned on a style
/// embedding.
pub struct AdaLayerNorm {
	fc:       nn::Linear,
	channels: usize,
	eps:      f32,
}

impl AdaLayerNorm {
	/// Loads the style projection and normalization configuration.
	pub fn load(style_dim: usize, channels: usize, eps: f64, vb: VarBuilder) -> Result<Self> {
		let fc = nn::linear(style_dim, channels * 2, vb.pp("fc"))?;
		Ok(Self { fc, channels, eps: eps as f32 })
	}

	/// x: [B, C, T], s: [B, `style_dim`] -> [B, C, T]
	///
	/// Python does:
	///   x = x.transpose(-1, -2)    # [B, T, C]
	///   x = x.transpose(1, -1)     # For 3D same as [B, C, T] ... actually for
	/// 3D transpose(1,-1)=[B,T,C]->no Actually re-reading: input x is [B, C, T]
	///   x.transpose(-1,-2) => [B, T, C]
	///   x.transpose(1,-1)  => for 3D that's transpose(1,2) => [B, C, T] again?
	/// No... Wait, after first transpose x is [B, T, C]. Then transpose(1, -1)
	/// = transpose(1, 2) => [B, C, T]. That's a no-op from original. Let me
	/// re-read more carefully.
	///
	/// Actually: the Python AdaLayerNorm.forward receives x that is [B, T, C]
	/// (it's called as block(x.transpose(-1,-2), style).transpose(-1,-2) from
	/// `DurationEncoder`). Inside: x.transpose(-1,-2) => [B, C, T], then
	/// x.transpose(1,-1) => [B, T, C]. So the two transposes cancel out. Then
	/// `layer_norm` on last dim (C). Then return x.transpose(1,-1).transpose(-1,
	/// -2) = [B, C, T] then [B, T, C].
	///
	/// In our usage we'll treat this as: input [B, C, T], output [B, C, T].
	/// Internally we transpose to [B, T, C], do LN + affine, transpose back.
	pub fn forward(&self, x: &Tensor, s: &Tensor) -> Result<Tensor> {
		// x: [B, C, T] -> [B, T, C]
		let xt = x.transpose(1, 2)?;

		// h: [B, C*2]
		let h = self.fc.forward(s)?;
		// h: [B, C*2, 1] -> chunk into gamma, beta each [B, C, 1]
		let h = h.unsqueeze(2)?;
		let chunks = h.chunk(2, 1)?;
		let gamma = chunks[0].transpose(1, 2)?; // [B, 1, C]
		let beta = chunks[1].transpose(1, 2)?; // [B, 1, C]

		// Layer norm on [B, T, C] over last dim
		let x_normed = layer_norm_no_affine(&xt.contiguous()?, self.channels, self.eps)?;

		// (1 + gamma) * x + beta, broadcast over T
		let out = x_normed
			.broadcast_mul(&(&gamma.contiguous()? + &Tensor::ones_like(&gamma.contiguous()?)?)?)?
			.broadcast_add(&beta)?;

		// back to [B, C, T]
		out.transpose(1, 2)
	}
}

// ---------------------------------------------------------------------------
// AdaIN1d — adaptive instance normalization
// ---------------------------------------------------------------------------

/// Normalizes each channel over time, then applies style-conditioned affine
/// parameters.
pub struct AdaIN1d {
	fc:        nn::Linear,
	_channels: usize,
}

impl AdaIN1d {
	/// Loads the style projection used to produce affine parameters.
	pub fn load(style_dim: usize, channels: usize, vb: VarBuilder) -> Result<Self> {
		let fc = nn::linear(style_dim, channels * 2, vb.pp("fc"))?;
		Ok(Self { fc, _channels: channels })
	}

	/// x: [B, C, T], s: [B, `style_dim`]
	pub fn forward(&self, x: &Tensor, s: &Tensor) -> Result<Tensor> {
		let h = self.fc.forward(s)?; // [B, C*2]
		let h = h.unsqueeze(2)?; // [B, C*2, 1]
		let chunks = h.chunk(2, 1)?;
		let gamma = &chunks[0]; // [B, C, 1]
		let beta = &chunks[1]; // [B, C, 1]

		// Instance norm: normalize over T dimension (dim=2)
		let mean = x.mean_keepdim(2)?;
		let x_centered = x.broadcast_sub(&mean)?;
		let var = x_centered.sqr()?.mean_keepdim(2)?;
		let eps = (Tensor::ones_like(&var)? * 1e-5f64)?;
		let x_norm = x_centered.broadcast_div(&(var + eps)?.sqrt()?)?;

		let gamma_c = gamma.contiguous()?;
		let beta_c = beta.contiguous()?;
		let ones = Tensor::ones_like(&gamma_c)?;
		let gamma_p1 = (&gamma_c + &ones)?;
		x_norm.broadcast_mul(&gamma_p1)?.broadcast_add(&beta_c)
	}
}

// ---------------------------------------------------------------------------
// Weight-norm Conv1d helper
// ---------------------------------------------------------------------------

/// Load a `weight_norm` Conv1d. In the safetensors, `weight_norm` stores
/// `weight_v` (the direction) and `weight_g` (the magnitude). At inference:
///   weight = `weight_g` * `weight_v` / ||`weight_v`||
pub fn load_weight_norm_conv1d(
	in_ch: usize,
	out_ch: usize,
	kernel_size: usize,
	config: nn::Conv1dConfig,
	vb: VarBuilder,
) -> Result<nn::Conv1d> {
	let weight_v = vb.get((out_ch, in_ch / config.groups, kernel_size), "weight_v")?;
	let weight_g = vb.get((out_ch, 1, 1), "weight_g")?;

	// ||weight_v|| per output channel: norm over (in_ch, kernel_size) dims
	// weight_v shape: [out_ch, in_ch/groups, kernel_size]
	let v_norm = weight_v.sqr()?.sum_keepdim(&[1usize, 2][..])?.sqrt()?; // [out_ch, 1, 1]
	let weight = weight_v.broadcast_mul(&weight_g)?.broadcast_div(&v_norm)?;

	// Try to load bias (may or may not exist)
	let bias = vb.get(out_ch, "bias").ok();

	Ok(nn::Conv1d::new(weight, bias, config))
}

/// Load a `weight_norm` Conv1d with no bias.
pub fn load_weight_norm_conv1d_no_bias(
	in_ch: usize,
	out_ch: usize,
	kernel_size: usize,
	config: nn::Conv1dConfig,
	vb: VarBuilder,
) -> Result<nn::Conv1d> {
	let weight_v = vb.get((out_ch, in_ch / config.groups, kernel_size), "weight_v")?;
	let weight_g = vb.get((out_ch, 1, 1), "weight_g")?;

	let v_norm = weight_v.sqr()?.sum_keepdim(&[1usize, 2][..])?.sqrt()?;
	let weight = weight_v.broadcast_mul(&weight_g)?.broadcast_div(&v_norm)?;

	Ok(nn::Conv1d::new(weight, None, config))
}

/// Load a `weight_norm` `ConvTranspose1d`.
pub fn load_weight_norm_conv_transpose1d(
	in_ch: usize,
	out_ch: usize,
	kernel_size: usize,
	config: nn::ConvTranspose1dConfig,
	vb: VarBuilder,
) -> Result<nn::ConvTranspose1d> {
	// ConvTranspose1d weight shape: [in_ch, out_ch/groups, kernel_size]
	let weight_v = vb.get((in_ch, out_ch / config.groups, kernel_size), "weight_v")?;
	let weight_g = vb.get((in_ch, 1, 1), "weight_g")?;

	let v_norm = weight_v.sqr()?.sum_keepdim(&[1usize, 2][..])?.sqrt()?;
	let weight = weight_v.broadcast_mul(&weight_g)?.broadcast_div(&v_norm)?;

	let bias = vb.get(out_ch, "bias").ok();

	Ok(nn::ConvTranspose1d::new(weight, bias, config))
}

// ---------------------------------------------------------------------------
// AdainResBlk1d — residual block with AdaIN conditioning (from istftnet.py)
// ---------------------------------------------------------------------------

/// Residual convolutional block conditioned on a style embedding.
pub struct AdainResBlk1d {
	conv1:        nn::Conv1d,
	conv2:        nn::Conv1d,
	norm1:        AdaIN1d,
	norm2:        AdaIN1d,
	conv1x1:      Option<nn::Conv1d>,
	/// Whether this block doubles the temporal resolution.
	pub upsample: bool,
	pool:         Option<nn::ConvTranspose1d>,
}

impl AdainResBlk1d {
	/// Loads the residual, normalization, and optional upsampling layers.
	pub fn load(
		dim_in: usize,
		dim_out: usize,
		style_dim: usize,
		upsample: bool,
		vb: VarBuilder,
	) -> Result<Self> {
		let conv_cfg = nn::Conv1dConfig { padding: 1, ..Default::default() };
		let conv1 = load_weight_norm_conv1d(dim_in, dim_out, 3, conv_cfg, vb.pp("conv1"))?;
		let conv2 = load_weight_norm_conv1d(dim_out, dim_out, 3, conv_cfg, vb.pp("conv2"))?;
		let norm1 = AdaIN1d::load(style_dim, dim_in, vb.pp("norm1"))?;
		let norm2 = AdaIN1d::load(style_dim, dim_out, vb.pp("norm2"))?;

		let conv1x1 = if dim_in == dim_out {
			None
		} else {
			Some(load_weight_norm_conv1d_no_bias(
				dim_in,
				dim_out,
				1,
				Default::default(),
				vb.pp("conv1x1"),
			)?)
		};

		let pool = if upsample {
			let pool_cfg = nn::ConvTranspose1dConfig {
				stride: 2,
				padding: 1,
				output_padding: 1,
				groups: dim_in,
				..Default::default()
			};
			Some(load_weight_norm_conv_transpose1d(dim_in, dim_in, 3, pool_cfg, vb.pp("pool"))?)
		} else {
			None
		};

		Ok(Self { conv1, conv2, norm1, norm2, conv1x1, upsample, pool })
	}

	/// x: [B, C, T], s: [B, `style_dim`]
	pub fn forward(&self, x: &Tensor, s: &Tensor) -> Result<Tensor> {
		// Shortcut path
		let shortcut = if self.upsample {
			upsample_nearest_1d(x, 2)?
		} else {
			x.clone()
		};
		let shortcut = if let Some(ref c) = self.conv1x1 {
			c.forward(&shortcut)?
		} else {
			shortcut
		};

		// Residual path
		let mut h = self.norm1.forward(x, s)?;
		h = nn::Activation::LeakyRelu(0.2).forward(&h)?;
		if let Some(ref pool) = self.pool {
			h = pool.forward(&h)?;
		}
		h = self.conv1.forward(&h)?;

		h = self.norm2.forward(&h, s)?;
		h = nn::Activation::LeakyRelu(0.2).forward(&h)?;
		h = self.conv2.forward(&h)?;

		// (residual + shortcut) / sqrt(2)
		let out = (h + shortcut)?;
		out * (1.0 / 2.0_f64.sqrt())
	}
}

// ---------------------------------------------------------------------------
// TextEncoder — Embedding + weight_norm Conv1d layers + BiLSTM
// ---------------------------------------------------------------------------

/// Encodes phoneme identifiers into contextual channel-first features.
pub struct TextEncoder {
	embedding: nn::Embedding,
	cnn:       Vec<(nn::Conv1d, ChannelsFirstLayerNorm)>,
	lstm:      BiLSTM,
	_channels: usize,
}

impl TextEncoder {
	/// Loads the embedding, convolutional stack, and bidirectional LSTM.
	pub fn load(
		channels: usize,
		kernel_size: usize,
		depth: usize,
		n_symbols: usize,
		vb: VarBuilder,
	) -> Result<Self> {
		let embedding = nn::embedding(n_symbols, channels, vb.pp("embedding"))?;

		let padding = (kernel_size - 1) / 2;
		let conv_cfg = nn::Conv1dConfig { padding, ..Default::default() };
		let mut cnn = Vec::with_capacity(depth);
		for i in 0..depth {
			let vb_cnn = vb.pp(format!("cnn.{i}"));
			let conv =
				load_weight_norm_conv1d(channels, channels, kernel_size, conv_cfg, vb_cnn.pp("0"))?;
			let ln = ChannelsFirstLayerNorm::load(channels, 1e-5, vb_cnn.pp("1"))?;
			cnn.push((conv, ln));
		}

		let lstm = BiLSTM::load(channels, channels / 2, vb.pp("lstm"))?;

		Ok(Self { embedding, cnn, lstm, _channels: channels })
	}

	/// `input_ids`: [B, T] (u32), `input_lengths`: [B], mask: [B, T] (u8,
	/// true=masked)
	pub fn forward(
		&self,
		input_ids: &Tensor,
		_input_lengths: &Tensor,
		mask: &Tensor,
	) -> Result<Tensor> {
		let x = self.embedding.forward(input_ids)?; // [B, T, C]
		let mut x = x.transpose(1, 2)?; // [B, C, T]

		// Mask: [B, 1, T], 1.0 where valid, 0.0 where masked
		let m = mask.unsqueeze(1)?.to_dtype(x.dtype())?;
		let inv_mask = (1.0 - &m)?;

		x = x.broadcast_mul(&inv_mask)?;

		for (conv, ln) in &self.cnn {
			x = conv.forward(&x)?;
			x = ln.forward(&x)?;
			x = nn::Activation::LeakyRelu(0.2).forward(&x)?;
			// No dropout at inference
			x = x.broadcast_mul(&inv_mask)?;
		}

		// LSTM expects [B, T, C]
		let x = x.transpose(1, 2)?;
		let x = self.lstm.forward(&x)?; // [B, T, channels]
		let x = x.transpose(1, 2)?; // [B, C, T]

		// Pad to original mask length if LSTM output is shorter
		let t_out = x.dim(2)?;
		let t_mask = mask.dim(1)?;
		let x = if t_out < t_mask {
			let pad = Tensor::zeros(&[x.dim(0)?, x.dim(1)?, t_mask - t_out], x.dtype(), x.device())?;
			Tensor::cat(&[&x, &pad], 2)?
		} else {
			x
		};
		x.broadcast_mul(&inv_mask)
	}
}

// ---------------------------------------------------------------------------
// DurationEncoder — alternating BiLSTM + AdaLayerNorm
// ---------------------------------------------------------------------------

/// Refines text features with alternating bidirectional LSTMs and adaptive
/// normalization.
pub struct DurationEncoder {
	lstms:   Vec<BiLSTM>,
	norms:   Vec<AdaLayerNorm>,
	d_model: usize,
	sty_dim: usize,
}

impl DurationEncoder {
	/// Loads the recurrent and style-conditioned normalization layers.
	pub fn load(sty_dim: usize, d_model: usize, nlayers: usize, vb: VarBuilder) -> Result<Self> {
		let mut lstms = Vec::with_capacity(nlayers);
		let mut norms = Vec::with_capacity(nlayers);

		for i in 0..nlayers {
			let lstm =
				BiLSTM::load(d_model + sty_dim, d_model / 2, vb.pp(format!("lstms.{}", i * 2)))?;
			let norm =
				AdaLayerNorm::load(sty_dim, d_model, 1e-5, vb.pp(format!("lstms.{}", i * 2 + 1)))?;
			lstms.push(lstm);
			norms.push(norm);
		}

		Ok(Self { lstms, norms, d_model, sty_dim })
	}

	/// Refines channel-first text features using a style embedding and padding
	/// mask.
	pub fn forward(
		&self,
		input: &Tensor,
		style: &Tensor,
		_text_lengths: &Tensor,
		mask: &Tensor,
	) -> Result<Tensor> {
		let (batch_size, _channels, sequence_length) = input.dims3()?;

		// [B, C, T] -> [T, B, C]
		let mut features = input.permute((2, 0, 1))?;

		// Style expanded to [T, B, sty_dim].
		let style_frames =
			style
				.unsqueeze(0)?
				.expand(&[sequence_length, batch_size, self.sty_dim])?;

		// Concatenate [features, style] -> [T, B, C+sty_dim].
		features = Tensor::cat(&[&features, &style_frames], 2)?;

		// Mask: [B, T] -> [T, B, 1].
		let mask_tbc = mask
			.transpose(0, 1)?
			.unsqueeze(2)?
			.to_dtype(features.dtype())?;
		let inverse_mask_tbc = (1.0 - &mask_tbc)?;
		features = features.broadcast_mul(&inverse_mask_tbc)?;

		// -> [B, C+sty_dim, T].
		features = features.transpose(0, 1)?;
		features = features.transpose(1, 2)?;

		let expanded_mask = mask.unsqueeze(1)?.to_dtype(features.dtype())?;
		let inverse_mask = (1.0 - &expanded_mask)?;

		for (lstm, norm) in self.lstms.iter().zip(self.norms.iter()) {
			// LSTM path: [B, C+sty_dim, T] -> [B, T, C+sty_dim].
			let sequence = features.transpose(1, 2)?;
			// No dropout at inference.
			let layer_features = lstm.forward(&sequence)?; // [B, T, d_model]
			let mut layer_features = layer_features.transpose(1, 2)?; // [B, d_model, T]

			// Pad if needed.
			let output_length = layer_features.dim(2)?;
			if output_length < sequence_length {
				let padding = Tensor::zeros(
					&[batch_size, self.d_model, sequence_length - output_length],
					layer_features.dtype(),
					layer_features.device(),
				)?;
				layer_features = Tensor::cat(&[&layer_features, &padding], 2)?;
			}

			// AdaLayerNorm: input [B, d_model, T], output [B, d_model, T].
			features = norm.forward(&layer_features, style)?;

			// Re-concatenate style: [B, sty_dim, T].
			let style_channels =
				style
					.unsqueeze(2)?
					.expand(&[batch_size, self.sty_dim, sequence_length])?;
			features = Tensor::cat(&[&features, &style_channels], 1)?;

			// Mask.
			features = features.broadcast_mul(&{
				let full_inverse_mask = Tensor::ones(
					&[1, self.d_model + self.sty_dim, 1],
					features.dtype(),
					features.device(),
				)?;
				full_inverse_mask.broadcast_mul(&inverse_mask)?
			})?;
		}

		// Take first d_model channels: [B, d_model, T] -> [B, T, d_model].
		features.narrow(1, 0, self.d_model)?.transpose(1, 2)
	}
}

// ---------------------------------------------------------------------------
// LinearNorm — just a linear layer (weight_init is irrelevant at inference)
// ---------------------------------------------------------------------------

// In the Python code, LinearNorm wraps nn.Linear. At inference it's identical.
// We just use nn::Linear directly in ProsodyPredictor.

// ---------------------------------------------------------------------------
// ProsodyPredictor
// ---------------------------------------------------------------------------

/// Predicts phoneme durations, pitch, and noise from encoded text and style
/// features.
pub struct ProsodyPredictor {
	/// Style-conditioned encoder for duration prediction.
	pub text_encoder:  DurationEncoder,
	/// Recurrent layer used to predict durations.
	pub lstm:          BiLSTM,
	/// Projects recurrent duration features to duration logits.
	pub duration_proj: nn::Linear,
	/// Shared recurrent trunk for pitch and noise prediction.
	pub shared:        BiLSTM,
	/// Style-conditioned residual blocks for pitch prediction.
	pub f0_blocks:     Vec<AdainResBlk1d>,
	/// Style-conditioned residual blocks for noise prediction.
	pub n_blocks:      Vec<AdainResBlk1d>,
	/// Projects pitch features to a scalar contour.
	pub f0_proj:       nn::Conv1d,
	/// Projects noise features to a scalar contour.
	pub n_proj:        nn::Conv1d,
	style_dim:         usize,
}

impl ProsodyPredictor {
	/// Loads the duration, pitch, and noise prediction network.
	pub fn load(
		style_dim: usize,
		d_hid: usize,
		nlayers: usize,
		max_dur: usize,
		vb: VarBuilder,
	) -> Result<Self> {
		let text_encoder = DurationEncoder::load(style_dim, d_hid, nlayers, vb.pp("text_encoder"))?;

		let lstm = BiLSTM::load(d_hid + style_dim, d_hid / 2, vb.pp("lstm"))?;
		let duration_proj = nn::linear(d_hid, max_dur, vb.pp("duration_proj.linear_layer"))?;
		let shared = BiLSTM::load(d_hid + style_dim, d_hid / 2, vb.pp("shared"))?;

		let mut f0_blocks = Vec::new();
		f0_blocks.push(AdainResBlk1d::load(d_hid, d_hid, style_dim, false, vb.pp("F0.0"))?);
		f0_blocks.push(AdainResBlk1d::load(d_hid, d_hid / 2, style_dim, true, vb.pp("F0.1"))?);
		f0_blocks.push(AdainResBlk1d::load(d_hid / 2, d_hid / 2, style_dim, false, vb.pp("F0.2"))?);

		let mut n_blocks = Vec::new();
		n_blocks.push(AdainResBlk1d::load(d_hid, d_hid, style_dim, false, vb.pp("N.0"))?);
		n_blocks.push(AdainResBlk1d::load(d_hid, d_hid / 2, style_dim, true, vb.pp("N.1"))?);
		n_blocks.push(AdainResBlk1d::load(d_hid / 2, d_hid / 2, style_dim, false, vb.pp("N.2"))?);

		let f0_proj = nn::conv1d(d_hid / 2, 1, 1, Default::default(), vb.pp("F0_proj"))?;
		let n_proj = nn::conv1d(d_hid / 2, 1, 1, Default::default(), vb.pp("N_proj"))?;

		Ok(Self {
			text_encoder,
			lstm,
			duration_proj,
			shared,
			f0_blocks,
			n_blocks,
			f0_proj,
			n_proj,
			style_dim,
		})
	}

	/// Predicts pitch and noise contours from aligned encoder features.
	///
	/// The returned contours may be longer than the input because their residual
	/// blocks upsample.
	pub fn f0_n_train(&self, encoder_output: &Tensor, style: &Tensor) -> Result<(Tensor, Tensor)> {
		// Shared LSTM needs [B, T, C+style_dim].
		let sequence_features = encoder_output.transpose(1, 2)?; // [B, T, C]
		let (batch_size, sequence_length, _channels) = sequence_features.dims3()?;
		let expanded_style =
			style
				.unsqueeze(1)?
				.expand(&[batch_size, sequence_length, self.style_dim])?;
		let shared_input = Tensor::cat(&[&sequence_features, &expanded_style], 2)?;

		let shared_features = self.shared.forward(&shared_input)?; // [B, T, d_hid]

		// F0 path.
		let mut f0 = shared_features.transpose(1, 2)?; // [B, d_hid, T]
		for block in &self.f0_blocks {
			f0 = block.forward(&f0, style)?;
		}
		let f0 = self.f0_proj.forward(&f0)?; // [B, 1, T']
		let f0 = f0.squeeze(1)?; // [B, T']

		// N path.
		let mut noise = shared_features.transpose(1, 2)?;
		for block in &self.n_blocks {
			noise = block.forward(&noise, style)?;
		}
		let noise = self.n_proj.forward(&noise)?;
		let noise = noise.squeeze(1)?;

		Ok((f0, noise))
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Nearest-neighbor 1D upsampling by a given factor.
pub fn upsample_nearest_1d(x: &Tensor, factor: usize) -> Result<Tensor> {
	let (b, c, t) = x.dims3()?;
	let x = x.unsqueeze(3)?; // [B, C, T, 1]
	let x = x.expand(&[b, c, t, factor])?; // [B, C, T, factor]
	x.reshape(&[b, c, t * factor])
}

/// Layer norm without learnable affine parameters.
/// x: [..., channels], normalizes over last dimension.
pub fn layer_norm_no_affine(x: &Tensor, channels: usize, eps: f32) -> Result<Tensor> {
	let device = x.device();
	let dtype = x.dtype();
	let ones = Tensor::ones(channels, dtype, device)?;
	let zeros = Tensor::zeros(channels, dtype, device)?;
	nn::ops::layer_norm(x, &ones, &zeros, eps)
}
