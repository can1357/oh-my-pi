//! iSTFTNet decoder: Generator with harmonic source, `AdaINResBlock1` with
//! snake activation.
//!
//! Ported from kokoro/istftnet.py

use std::{f32::consts, f64};

use candle_core::{DType, Device, Module, Result, Shape, Tensor};
use candle_nn::{self as nn, VarBuilder};

use super::modules::{
	AdaIN1d, AdainResBlk1d, load_weight_norm_conv_transpose1d, load_weight_norm_conv1d,
};

/// Controls the small stochastic sources used by the iSTFT decoder.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum SynthesisMode {
	/// Match the original Kokoro decoder with random harmonic phase and noise.
	#[default]
	Stochastic,
	/// Replace decoder random phase and noise with zeros for reproducible
	/// output.
	Deterministic,
}

fn rand_or_zero<S: Into<Shape>>(
	mode: SynthesisMode,
	lo: f32,
	up: f32,
	shape: S,
	device: &Device,
	dtype: DType,
) -> Result<Tensor> {
	match mode {
		SynthesisMode::Stochastic => Tensor::rand(lo, up, shape, device)?.to_dtype(dtype),
		SynthesisMode::Deterministic => Tensor::zeros(shape, dtype, device),
	}
}

fn randn_or_zero<S: Into<Shape>>(
	mode: SynthesisMode,
	mean: f32,
	std: f32,
	shape: S,
	device: &Device,
	dtype: DType,
) -> Result<Tensor> {
	match mode {
		SynthesisMode::Stochastic => Tensor::randn(mean, std, shape, device)?.to_dtype(dtype),
		SynthesisMode::Deterministic => Tensor::zeros(shape, dtype, device),
	}
}

// ---------------------------------------------------------------------------
// Snake activation: x + (1/alpha) * sin(alpha * x)^2
// ---------------------------------------------------------------------------

fn snake_activation(x: &Tensor, alpha: &Tensor) -> Result<Tensor> {
	let sin_val = (x.broadcast_mul(alpha))?.sin()?;
	let sin_sq = sin_val.sqr()?;
	let recip_alpha = alpha.recip()?;
	x + sin_sq.broadcast_mul(&recip_alpha)?
}

// ---------------------------------------------------------------------------
// AdaINResBlock1 — Generator residual block with snake activation
// ---------------------------------------------------------------------------

/// Style-conditioned residual block used by the iSTFT vocoder generator.
pub struct AdaINResBlock1 {
	convs1: Vec<nn::Conv1d>,
	convs2: Vec<nn::Conv1d>,
	adain1: Vec<AdaIN1d>,
	adain2: Vec<AdaIN1d>,
	alpha1: Vec<Tensor>,
	alpha2: Vec<Tensor>,
}

impl AdaINResBlock1 {
	/// Loads the block's convolutions, adaptive normalizations, and Snake
	/// parameters.
	pub fn load(
		channels: usize,
		kernel_size: usize,
		dilations: &[usize],
		style_dim: usize,
		vb: VarBuilder,
	) -> Result<Self> {
		let num = dilations.len();
		let mut convs1 = Vec::with_capacity(num);
		let mut convs2 = Vec::with_capacity(num);
		let mut adain1 = Vec::with_capacity(num);
		let mut adain2 = Vec::with_capacity(num);
		let mut alpha1 = Vec::with_capacity(num);
		let mut alpha2 = Vec::with_capacity(num);

		for (i, &d) in dilations.iter().enumerate() {
			let padding = (kernel_size * d - d) / 2;
			let cfg1 = nn::Conv1dConfig { padding, dilation: d, ..Default::default() };
			convs1.push(load_weight_norm_conv1d(
				channels,
				channels,
				kernel_size,
				cfg1,
				vb.pp(format!("convs1.{i}")),
			)?);

			let cfg2 =
				nn::Conv1dConfig { padding: (kernel_size - 1) / 2, dilation: 1, ..Default::default() };
			convs2.push(load_weight_norm_conv1d(
				channels,
				channels,
				kernel_size,
				cfg2,
				vb.pp(format!("convs2.{i}")),
			)?);

			adain1.push(AdaIN1d::load(style_dim, channels, vb.pp(format!("adain1.{i}")))?);
			adain2.push(AdaIN1d::load(style_dim, channels, vb.pp(format!("adain2.{i}")))?);

			alpha1.push(vb.get((1, channels, 1), &format!("alpha1.{i}"))?);
			alpha2.push(vb.get((1, channels, 1), &format!("alpha2.{i}"))?);
		}

		Ok(Self { convs1, convs2, adain1, adain2, alpha1, alpha2 })
	}

	/// x: [B, C, T], s: [B, `style_dim`]
	pub fn forward(&self, x: &Tensor, s: &Tensor) -> Result<Tensor> {
		let mut x = x.clone();
		for i in 0..self.convs1.len() {
			let mut xt = self.adain1[i].forward(&x, s)?;
			xt = snake_activation(&xt, &self.alpha1[i])?;
			xt = self.convs1[i].forward(&xt)?;
			xt = self.adain2[i].forward(&xt, s)?;
			xt = snake_activation(&xt, &self.alpha2[i])?;
			xt = self.convs2[i].forward(&xt)?;
			x = (&xt + &x)?;
		}
		Ok(x)
	}
}

// ---------------------------------------------------------------------------
// SineGen — sine waveform generator for F0
// ---------------------------------------------------------------------------

struct SineGen {
	sine_amp:         f64,
	noise_std:        f64,
	harmonic_num:     usize,
	sampling_rate:    f64,
	voiced_threshold: f64,
	upsample_scale:   usize,
}

impl SineGen {
	const fn new(
		sampling_rate: usize,
		upsample_scale: usize,
		harmonic_num: usize,
		sine_amp: f64,
		noise_std: f64,
		voiced_threshold: f64,
	) -> Self {
		Self {
			sine_amp,
			noise_std,
			harmonic_num,
			sampling_rate: sampling_rate as f64,
			voiced_threshold,
			upsample_scale,
		}
	}

	/// f0: [B, T, 1]
	/// Returns: (`sine_waves`: [B, T, dim], uv: [B, T, 1])
	fn forward_with_mode(
		&self,
		f0: &Tensor,
		device: &Device,
		mode: SynthesisMode,
	) -> Result<(Tensor, Tensor)> {
		let (b, t, _) = f0.dims3()?;
		let dim = self.harmonic_num + 1;

		// Create harmonic multipliers [1, 2, ..., harmonic_num+1]
		let harmonics: Vec<f32> = (1..=(self.harmonic_num + 1)).map(|i| i as f32).collect();
		let harmonics = Tensor::new(&harmonics[..], device)?
			.reshape((1, 1, dim))?
			.to_dtype(f0.dtype())?;

		// fn = f0 * [1, 2, ..., harmonic_num+1]  -> [B, T, dim]
		let fn_vals = f0.broadcast_mul(&harmonics)?;

		// rad_values = (fn / sampling_rate) % 1
		let sr = Tensor::new(self.sampling_rate as f32, device)?.to_dtype(f0.dtype())?;
		let mut rad_values = fn_vals.broadcast_div(&sr)?;
		// Modulo 1: fract
		rad_values = (&rad_values - &rad_values.floor()?)?;

		// Fix 2: Add initial random phase for non-fundamental harmonics
		// Python: rand_ini = torch.rand(B, dim); rand_ini[:, 0] = 0
		//         rad_values[:, 0, :] += rand_ini
		let rand_ini = rand_or_zero(mode, 0f32, 1f32, &[b, dim], device, f0.dtype())?;
		// Zero out fundamental (column 0)
		let mask_data: Vec<f32> = (0..dim).map(|i| if i == 0 { 0.0 } else { 1.0 }).collect();
		let mask = Tensor::new(&mask_data[..], device)?
			.reshape((1, dim))?
			.to_dtype(f0.dtype())?;
		let rand_ini = rand_ini.broadcast_mul(&mask)?; // [B, dim]
		let rand_ini = rand_ini.unsqueeze(1)?; // [B, 1, dim]

		// Add random phase to first timestep only
		// rad_values[:, 0:1, :] += rand_ini
		let first_step = rad_values.narrow(1, 0, 1)?; // [B, 1, dim]
		let first_step_updated = (first_step + rand_ini)?;
		let rest = rad_values.narrow(1, 1, t - 1)?; // [B, T-1, dim]
		rad_values = Tensor::cat(&[&first_step_updated, &rest], 1)?; // [B, T, dim]

		// Fix 1: Downsample → cumsum → upsample (Python's interpolation trick)
		// This prevents phase drift on long sequences.
		// Python: rad_values = F.interpolate(rad_values.T,
		// scale_factor=1/upsample_scale, mode="linear").T         phase =
		// cumsum(rad_values, dim=1) * 2*pi         phase = F.interpolate(phase.T *
		// upsample_scale, scale_factor=upsample_scale, mode="linear").T

		// Transpose to [B, dim, T] for interpolation along T axis
		let rv_bdt = rad_values.transpose(1, 2)?.contiguous()?; // [B, dim, T]

		// GPU-native linear downsample by 1/upsample_scale
		let us = self.upsample_scale;
		let rv_down = gpu_linear_downsample(&rv_bdt, us, device, f0.dtype())?;

		// Cumsum at reduced resolution — GPU matmul-based
		let rv_down_btd = rv_down.transpose(1, 2)?; // [B, T_down, dim]
		let phase_down = rv_down_btd.cumsum(1)?;

		// GPU-native linear upsample by upsample_scale + scale
		let phase_bdt = phase_down.transpose(1, 2)?.contiguous()?; // [B, dim, T_down]
		let scale_t = Tensor::new(us as f32, device)?.to_dtype(f0.dtype())?;
		let phase_scaled = phase_bdt.broadcast_mul(&scale_t)?;
		let phase_up = gpu_linear_upsample(&phase_scaled.contiguous()?, us, t, device, f0.dtype())?;

		// Transpose back to [B, T, dim]
		let phase = phase_up.transpose(1, 2)?; // [B, T, dim]
		let two_pi = Tensor::new(2.0f32 * consts::PI, device)?.to_dtype(f0.dtype())?;
		let phase = phase.broadcast_mul(&two_pi)?;

		let sine_amp_t = Tensor::new(self.sine_amp as f32, device)?.to_dtype(f0.dtype())?;
		let sines = phase.sin()?.broadcast_mul(&sine_amp_t)?;

		// UV (unvoiced) detection
		let uv_f64 = f0.to_dtype(DType::F32)?;
		let threshold =
			Tensor::new(self.voiced_threshold as f32, device)?.broadcast_as(uv_f64.shape())?;
		let uv = uv_f64.gt(&threshold)?.to_dtype(f0.dtype())?;

		// Noise for unvoiced regions
		let noise_amp = ((&uv * self.noise_std)? + ((1.0 - &uv)? * (self.sine_amp / 3.0))?)?;
		let noise = randn_or_zero(mode, 0f32, 1f32, sines.shape(), device, sines.dtype())?;
		let noise = noise.broadcast_mul(&noise_amp)?;

		// Final: sine * uv + noise
		let sine_waves = (sines.broadcast_mul(&uv)? + noise)?;

		Ok((sine_waves, uv))
	}
}

// ---------------------------------------------------------------------------
// SourceModuleHnNSF
// ---------------------------------------------------------------------------

/// Harmonic-plus-noise excitation source for the generator.
pub struct SourceModuleHnNSF {
	sine_gen: SineGen,
	l_linear: nn::Linear,
	sine_amp: f64,
}

impl SourceModuleHnNSF {
	/// Loads an excitation source configured for the model's sampling and
	/// upsampling rates.
	pub fn load(
		sampling_rate: usize,
		upsample_scale: usize,
		harmonic_num: usize,
		vb: VarBuilder,
	) -> Result<Self> {
		let sine_gen = SineGen::new(sampling_rate, upsample_scale, harmonic_num, 0.1, 0.003, 10.0);
		let l_linear = nn::linear(harmonic_num + 1, 1, vb.pp("l_linear"))?;

		Ok(Self { sine_gen, l_linear, sine_amp: 0.1 })
	}

	/// x: [B, T, 1] (F0 values)
	/// Returns: (`sine_merge`: [B, T, 1], noise: [B, T, 1], uv: [B, T, 1])
	pub fn forward(&self, x: &Tensor) -> Result<(Tensor, Tensor, Tensor)> {
		self.forward_with_mode(x, SynthesisMode::Stochastic)
	}

	/// x: [B, T, 1] (F0 values)
	/// Returns: (`sine_merge`: [B, T, 1], noise: [B, T, 1], uv: [B, T, 1])
	pub fn forward_with_mode(
		&self,
		x: &Tensor,
		mode: SynthesisMode,
	) -> Result<(Tensor, Tensor, Tensor)> {
		let device = x.device();
		let (sine_wavs, uv) = self.sine_gen.forward_with_mode(x, device, mode)?;

		// Linear merge of harmonics -> single channel
		let sine_merge = self.l_linear.forward(&sine_wavs)?;
		let sine_merge = sine_merge.tanh()?;

		// Noise source
		let noise = randn_or_zero(mode, 0f32, 1f32, uv.shape(), device, x.dtype())?;
		let noise = (noise * (self.sine_amp / 3.0))?;

		Ok((sine_merge, noise, uv))
	}
}

// ---------------------------------------------------------------------------
// TorchSTFT — STFT/iSTFT using candle operations
// ---------------------------------------------------------------------------

/// Short-time Fourier transform kernels used to synthesize waveform frames.
pub struct TorchSTFT {
	filter_length:  usize,
	hop_length:     usize,
	win_length:     usize,
	/// Hann window coefficients
	window:         Vec<f32>,
	/// Pre-computed forward DFT kernels (for transform)
	fwd_cos_kernel: Tensor,
	fwd_sin_kernel: Tensor,
	/// Pre-computed inverse DFT kernels (for inverse)
	inv_cos_kernel: Tensor,
	inv_sin_kernel: Tensor,
}

impl TorchSTFT {
	/// Builds transform kernels and a Hann window for the requested FFT
	/// configuration.
	pub fn new(
		filter_length: usize,
		hop_length: usize,
		win_length: usize,
		device: &Device,
		dtype: DType,
	) -> Result<Self> {
		let n_fft = filter_length;
		let n_bins = n_fft / 2 + 1;

		// Generate Hann window
		let window: Vec<f32> = (0..win_length)
			.map(|i| 0.5 * (1.0 - (2.0 * f64::consts::PI * i as f64 / win_length as f64).cos()) as f32)
			.collect();

		// Forward DFT kernels (windowed)
		let mut fwd_cos = Vec::with_capacity(n_bins * n_fft);
		let mut fwd_sin = Vec::with_capacity(n_bins * n_fft);
		for k in 0..n_bins {
			for n in 0..n_fft {
				let angle = 2.0 * f64::consts::PI * k as f64 * n as f64 / n_fft as f64;
				let w = window.get(n).copied().unwrap_or(0.0) as f64;
				fwd_cos.push((angle.cos() * w) as f32);
				fwd_sin.push((-angle.sin() * w) as f32);
			}
		}

		let fwd_cos_kernel = Tensor::new(&fwd_cos[..], device)?
			.reshape((n_bins, 1, n_fft))?
			.to_dtype(dtype)?;
		let fwd_sin_kernel = Tensor::new(&fwd_sin[..], device)?
			.reshape((n_bins, 1, n_fft))?
			.to_dtype(dtype)?;

		// Inverse DFT kernels (windowed, scaled)
		let mut inv_cos = Vec::with_capacity(n_bins * n_fft);
		let mut inv_sin = Vec::with_capacity(n_bins * n_fft);
		for k in 0..n_bins {
			let scale = if k == 0 || k == n_fft / 2 {
				1.0 / n_fft as f64
			} else {
				2.0 / n_fft as f64
			};
			for n in 0..n_fft {
				let w = window.get(n).copied().unwrap_or(0.0) as f64;
				let angle = 2.0 * f64::consts::PI * k as f64 * n as f64 / n_fft as f64;
				inv_cos.push((scale * w * angle.cos()) as f32);
				inv_sin.push((scale * w * angle.sin()) as f32);
			}
		}

		let inv_cos_kernel = Tensor::new(&inv_cos[..], device)?
			.reshape((n_bins, 1, n_fft))?
			.to_dtype(dtype)?;
		let inv_sin_kernel = Tensor::new(&inv_sin[..], device)?
			.reshape((n_bins, 1, n_fft))?
			.to_dtype(dtype)?;

		Ok(Self {
			filter_length,
			hop_length,
			win_length,
			window,
			fwd_cos_kernel,
			fwd_sin_kernel,
			inv_cos_kernel,
			inv_sin_kernel,
		})
	}

	/// Compute STFT magnitude and phase via DFT convolution.
	///
	/// `input_data`: [B, L] (time-domain signal)
	/// Returns: (magnitude: [B, `n_fft/2+1`, T], phase: [B, `n_fft/2+1`, T])
	pub fn transform(&self, input_data: &Tensor) -> Result<(Tensor, Tensor)> {
		let device = input_data.device();
		let dtype = input_data.dtype();
		let n_fft = self.filter_length;

		// Pad input for STFT framing
		let pad_amount = n_fft / 2;
		let input_padded = reflection_pad_1d(input_data, pad_amount)?;

		// [B, L] -> [B, 1, L] for conv1d
		let x = input_padded.unsqueeze(1)?;

		// Apply DFT via conv1d with pre-computed kernels
		let real = x.conv1d(&self.fwd_cos_kernel, 0, self.hop_length, 1, 1)?;
		let imag = x.conv1d(&self.fwd_sin_kernel, 0, self.hop_length, 1, 1)?;

		// Magnitude and phase
		let magnitude = (real.sqr()? + imag.sqr()?)?.sqrt()?;
		// atan2(imag, real) = atan(imag/real) with quadrant correction
		// We'll compute this element-wise via atan(imag/real) and handle signs
		// For simplicity, use the identity: phase = atan2(y, x) via:
		// Compute atan2(imag, real) on CPU since candle doesn't have atan
		let real_data = real.flatten_all()?.to_vec1::<f32>()?;
		let imag_data = imag.flatten_all()?.to_vec1::<f32>()?;
		let phase_data: Vec<f32> = imag_data
			.iter()
			.zip(real_data.iter())
			.map(|(y, x)| y.atan2(*x))
			.collect();
		let phase = Tensor::from_vec(phase_data, real.shape(), device)?.to_dtype(dtype)?;

		Ok((magnitude, phase))
	}

	/// Inverse STFT via GPU `conv_transpose1d` (iDFT + overlap-add in one
	/// operation).
	///
	/// magnitude: [B, `n_fft/2+1`, T], phase: [B, `n_fft/2+1`, T]
	/// Returns: [B, 1, L] (time-domain signal with channel dim)
	pub fn inverse(&self, magnitude: &Tensor, phase: &Tensor) -> Result<Tensor> {
		let device = magnitude.device();
		let dtype = magnitude.dtype();
		let n_fft = self.filter_length;
		let win_len = self.win_length;
		let (_b, _freq, num_frames) = magnitude.dims3()?;

		// Reconstruct complex spectrum: real = mag*cos(phase), imag = mag*sin(phase)
		// No phase unwrapping needed — cos/sin are 2π-periodic.
		let real: Tensor = (magnitude * phase.cos()?)?;
		let imag: Tensor = (magnitude * phase.sin()?)?;

		// iDFT + window + overlap-add via conv_transpose1d on GPU with pre-computed
		// kernels.
		let output = (real.conv_transpose1d(&self.inv_cos_kernel, 0, 0, self.hop_length, 1, 1)?
			- imag.conv_transpose1d(&self.inv_sin_kernel, 0, 0, self.hop_length, 1, 1)?)?;
		// output: [B, 1, output_len] where output_len = (T-1)*hop_length + n_fft

		// COLA normalization: compute window squared sum on CPU (small, depends only on
		// window params and frame count, not on the audio data).
		let output_len = output.dim(2)?;
		let mut window_sum = vec![0f32; output_len];
		for frame_idx in 0..num_frames {
			let start = frame_idx * self.hop_length;
			for n in 0..win_len.min(n_fft) {
				if start + n < output_len {
					let w = self.window[n];
					window_sum[start + n] = w.mul_add(w, window_sum[start + n]);
				}
			}
		}

		// Clamp to avoid division by zero (leaves near-zero samples unchanged)
		for v in &mut window_sum {
			if *v < 1e-8 {
				*v = 1.0;
			}
		}
		let window_sum_tensor = Tensor::new(&window_sum[..], device)?
			.to_dtype(dtype)?
			.reshape((1, 1, output_len))?;
		let output = output.broadcast_div(&window_sum_tensor)?;

		// Strip padding: the forward STFT added n_fft/2 reflection padding on each
		// side.
		let pad = n_fft / 2;
		let trimmed_len = output_len.saturating_sub(2 * pad);
		let output = output.narrow(2, pad, trimmed_len)?;

		Ok(output)
	}
}

// ---------------------------------------------------------------------------
// Generator — the main vocoder generator
// ---------------------------------------------------------------------------

/// iSTFT vocoder generator that converts encoded speech features into
/// waveforms.
pub struct Generator {
	m_source:       SourceModuleHnNSF,
	ups:            Vec<nn::ConvTranspose1d>,
	noise_convs:    Vec<nn::Conv1d>,
	noise_res:      Vec<AdaINResBlock1>,
	resblocks:      Vec<AdaINResBlock1>,
	conv_post:      nn::Conv1d,
	num_kernels:    usize,
	num_upsamples:  usize,
	post_n_fft:     usize,
	stft:           TorchSTFT,
	upsample_scale: usize,
}

impl Generator {
	/// Loads the generator layers and its waveform reconstruction transform.
	pub fn load(
		style_dim: usize,
		resblock_kernel_sizes: &[usize],
		upsample_rates: &[usize],
		upsample_initial_channel: usize,
		resblock_dilation_sizes: &[Vec<usize>],
		upsample_kernel_sizes: &[usize],
		gen_istft_n_fft: usize,
		gen_istft_hop_size: usize,
		vb: VarBuilder,
	) -> Result<Self> {
		let num_kernels = resblock_kernel_sizes.len();
		let num_upsamples = upsample_rates.len();
		let total_upsample: usize = upsample_rates.iter().product();
		let upsample_scale = total_upsample * gen_istft_hop_size;

		let m_source = SourceModuleHnNSF::load(24000, upsample_scale, 8, vb.pp("m_source"))?;

		// Upsample layers (ConvTranspose1d with weight_norm)
		let mut ups = Vec::with_capacity(num_upsamples);
		for (i, (&u, &k)) in upsample_rates
			.iter()
			.zip(upsample_kernel_sizes.iter())
			.enumerate()
		{
			let in_ch = upsample_initial_channel / (1 << i);
			let out_ch = upsample_initial_channel / (1 << (i + 1));
			let cfg =
				nn::ConvTranspose1dConfig { stride: u, padding: (k - u) / 2, ..Default::default() };
			ups.push(load_weight_norm_conv_transpose1d(
				in_ch,
				out_ch,
				k,
				cfg,
				vb.pp(format!("ups.{i}")),
			)?);
		}

		// Residual blocks
		let mut resblocks = Vec::new();
		for i in 0..num_upsamples {
			let ch = upsample_initial_channel / (1 << (i + 1));
			for (j, (k, d)) in resblock_kernel_sizes
				.iter()
				.zip(resblock_dilation_sizes.iter())
				.enumerate()
			{
				resblocks.push(AdaINResBlock1::load(
					ch,
					*k,
					d,
					style_dim,
					vb.pp(format!("resblocks.{}", i * num_kernels + j)),
				)?);
			}
		}

		// Noise convolutions and residual blocks
		let mut noise_convs = Vec::new();
		let mut noise_res = Vec::new();
		for i in 0..num_upsamples {
			let c_cur = upsample_initial_channel / (1 << (i + 1));
			if i + 1 < num_upsamples {
				let stride_f0: usize = upsample_rates[i + 1..].iter().product();
				let kernel_size = stride_f0 * 2;
				let padding = stride_f0.div_ceil(2);
				let cfg = nn::Conv1dConfig { stride: stride_f0, padding, ..Default::default() };
				noise_convs.push(nn::conv1d(
					gen_istft_n_fft + 2,
					c_cur,
					kernel_size,
					cfg,
					vb.pp(format!("noise_convs.{i}")),
				)?);
				noise_res.push(AdaINResBlock1::load(
					c_cur,
					7,
					&[1, 3, 5],
					style_dim,
					vb.pp(format!("noise_res.{i}")),
				)?);
			} else {
				let cfg = nn::Conv1dConfig::default();
				noise_convs.push(nn::conv1d(
					gen_istft_n_fft + 2,
					c_cur,
					1,
					cfg,
					vb.pp(format!("noise_convs.{i}")),
				)?);
				noise_res.push(AdaINResBlock1::load(
					c_cur,
					11,
					&[1, 3, 5],
					style_dim,
					vb.pp(format!("noise_res.{i}")),
				)?);
			}
		}

		// Post convolution
		let ch = upsample_initial_channel / (1 << num_upsamples);
		let conv_post = load_weight_norm_conv1d(
			ch,
			gen_istft_n_fft + 2,
			7,
			nn::Conv1dConfig { padding: 3, ..Default::default() },
			vb.pp("conv_post"),
		)?;

		let stft = TorchSTFT::new(
			gen_istft_n_fft,
			gen_istft_hop_size,
			gen_istft_n_fft,
			vb.device(),
			vb.dtype(),
		)?;

		Ok(Self {
			m_source,
			ups,
			noise_convs,
			noise_res,
			resblocks,
			conv_post,
			num_kernels,
			num_upsamples,
			post_n_fft: gen_istft_n_fft,
			stft,
			upsample_scale,
		})
	}

	/// x: [B, C, T], s: [B, `style_dim`], f0: [B, `T_f0`]
	pub fn forward(&self, x: &Tensor, s: &Tensor, f0: &Tensor) -> Result<Tensor> {
		self.forward_with_mode(x, s, f0, SynthesisMode::Stochastic)
	}

	/// x: [B, C, T], s: [B, `style_dim`], f0: [B, `T_f0`]
	pub fn forward_with_mode(
		&self,
		x: &Tensor,
		s: &Tensor,
		f0: &Tensor,
		mode: SynthesisMode,
	) -> Result<Tensor> {
		// Upsample F0 to full resolution
		let f0_up = upsample_nearest_1d_single(f0, self.upsample_scale)?; // [B, T_full]
		let f0_3d = f0_up.unsqueeze(2)?; // [B, T_full, 1]

		// Generate harmonic source
		let (har_source, _noise_source, _uv) = self.m_source.forward_with_mode(&f0_3d, mode)?;

		// har_source: [B, T_full, 1] -> [B, 1, T_full] -> [B, T_full]
		let har_source = har_source.transpose(1, 2)?.contiguous()?;
		let har_source = har_source.squeeze(1)?;

		// STFT of harmonic source
		let (har_spec, har_phase) = self.stft.transform(&har_source)?;
		// har: [B, n_fft/2+1 + n_fft/2+1, T_stft] = [B, n_fft+2, T_stft]
		let har = Tensor::cat(&[&har_spec, &har_phase], 1)?;

		let mut x = x.clone();
		for i in 0..self.num_upsamples {
			x = nn::Activation::LeakyRelu(0.1).forward(&x)?;

			// Noise conditioning
			let mut x_source = self.noise_convs[i].forward(&har)?;
			x_source = self.noise_res[i].forward(&x_source, s)?;

			x = self.ups[i].forward(&x)?;

			// Reflection pad on last upsample
			if i == self.num_upsamples - 1 {
				x = reflection_pad_1d_channels(&x, 1, 0)?;
			}

			// Check length match — Python adds directly without trimming
			let x_len = x.dim(2)?;
			let xs_len = x_source.dim(2)?;
			if x_len != xs_len {
				// Pad the shorter one with zeros instead of truncating the longer one
				if x_len < xs_len {
					let pad =
						Tensor::zeros(&[x.dim(0)?, x.dim(1)?, xs_len - x_len], x.dtype(), x.device())?;
					x = Tensor::cat(&[&x, &pad], 2)?;
				} else {
					let pad = Tensor::zeros(
						&[x_source.dim(0)?, x_source.dim(1)?, x_len - xs_len],
						x_source.dtype(),
						x_source.device(),
					)?;
					x_source = Tensor::cat(&[&x_source, &pad], 2)?;
				}
			}
			x = (x + x_source)?;

			// Sum residual blocks
			let mut xs: Option<Tensor> = None;
			for j in 0..self.num_kernels {
				let rb_out = self.resblocks[i * self.num_kernels + j].forward(&x, s)?;
				xs = Some(match xs {
					Some(prev) => (prev + rb_out)?,
					None => rb_out,
				});
			}
			let nk = Tensor::new(self.num_kernels as f32, x.device())?.to_dtype(x.dtype())?;
			x = xs.unwrap().broadcast_div(&nk)?;
		}

		x = nn::Activation::LeakyRelu(0.01).forward(&x)?;
		x = self.conv_post.forward(&x)?;

		// Split into spec and phase
		let spec = x.narrow(1, 0, self.post_n_fft / 2 + 1)?.exp()?;
		let phase = x
			.narrow(1, self.post_n_fft / 2 + 1, self.post_n_fft / 2 + 1)?
			.sin()?;

		self.stft.inverse(&spec, &phase)
	}
}

// ---------------------------------------------------------------------------
// Decoder — top-level decoder wrapping Generator
// ---------------------------------------------------------------------------

/// Top-level speech decoder that prepares conditioning features for the
/// generator.
pub struct Decoder {
	encode:        AdainResBlk1d,
	decode:        Vec<AdainResBlk1d>,
	f0_conv:       nn::Conv1d,
	n_conv:        nn::Conv1d,
	asr_res:       nn::Conv1d,
	/// Waveform generator used after the decoder's feature preparation layers.
	pub generator: Generator,
}

impl Decoder {
	/// Loads the decoder's conditioning, residual, and generator layers.
	pub fn load(
		dim_in: usize,
		style_dim: usize,
		_dim_out: usize,
		resblock_kernel_sizes: &[usize],
		upsample_rates: &[usize],
		upsample_initial_channel: usize,
		resblock_dilation_sizes: &[Vec<usize>],
		upsample_kernel_sizes: &[usize],
		gen_istft_n_fft: usize,
		gen_istft_hop_size: usize,
		vb: VarBuilder,
	) -> Result<Self> {
		// encode: AdainResBlk1d(dim_in + 2, 1024, style_dim)
		let encode = AdainResBlk1d::load(dim_in + 2, 1024, style_dim, false, vb.pp("encode"))?;

		// decode blocks
		let mut decode = Vec::new();
		decode.push(AdainResBlk1d::load(1024 + 2 + 64, 1024, style_dim, false, vb.pp("decode.0"))?);
		decode.push(AdainResBlk1d::load(1024 + 2 + 64, 1024, style_dim, false, vb.pp("decode.1"))?);
		decode.push(AdainResBlk1d::load(1024 + 2 + 64, 1024, style_dim, false, vb.pp("decode.2"))?);
		decode.push(AdainResBlk1d::load(1024 + 2 + 64, 512, style_dim, true, vb.pp("decode.3"))?);

		// F0_conv and N_conv: weight_norm Conv1d(1, 1, 3, stride=2, padding=1)
		let conv_cfg = nn::Conv1dConfig { stride: 2, padding: 1, ..Default::default() };
		let f0_conv = load_weight_norm_conv1d(1, 1, 3, conv_cfg, vb.pp("F0_conv"))?;
		let n_conv = load_weight_norm_conv1d(1, 1, 3, conv_cfg, vb.pp("N_conv"))?;

		// asr_res: Sequential(weight_norm(Conv1d(512, 64, 1)))
		let asr_res = load_weight_norm_conv1d(512, 64, 1, Default::default(), vb.pp("asr_res.0"))?;

		let generator = Generator::load(
			style_dim,
			resblock_kernel_sizes,
			upsample_rates,
			upsample_initial_channel,
			resblock_dilation_sizes,
			upsample_kernel_sizes,
			gen_istft_n_fft,
			gen_istft_hop_size,
			vb.pp("generator"),
		)?;

		Ok(Self { encode, decode, f0_conv, n_conv, asr_res, generator })
	}

	/// asr: [B, C, T], `f0_curve`: [B, T], n: [B, T], s: [B, `style_dim`]
	pub fn forward(
		&self,
		asr: &Tensor,
		f0_curve: &Tensor,
		n: &Tensor,
		s: &Tensor,
	) -> Result<Tensor> {
		self.forward_with_mode(asr, f0_curve, n, s, SynthesisMode::Stochastic)
	}

	/// asr: [B, C, T], `f0_curve`: [B, T], n: [B, T], s: [B, `style_dim`]
	pub fn forward_with_mode(
		&self,
		asr: &Tensor,
		f0_curve: &Tensor,
		n: &Tensor,
		s: &Tensor,
		mode: SynthesisMode,
	) -> Result<Tensor> {
		// F0 and N convolutions: [B, T] -> [B, 1, T] -> conv -> [B, 1, T/2]
		let f0 = self.f0_conv.forward(&f0_curve.unsqueeze(1)?)?;
		let n_out = self.n_conv.forward(&n.unsqueeze(1)?)?;

		// Concatenate [asr, F0, N] along channel dim
		let x = Tensor::cat(&[asr, &f0, &n_out], 1)?;

		let mut x = self.encode.forward(&x, s)?;

		let asr_res = self.asr_res.forward(asr)?;

		let mut res = true;
		for block in &self.decode {
			if res {
				x = Tensor::cat(&[&x, &asr_res, &f0, &n_out], 1)?;
			}
			x = block.forward(&x, s)?;
			if block.upsample {
				res = false;
			}
		}

		self.generator.forward_with_mode(&x, s, f0_curve, mode)
	}
}

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

/// Nearest-neighbor 1D upsampling for a 2D tensor [B, T] -> [B, T*factor]
fn upsample_nearest_1d_single(x: &Tensor, factor: usize) -> Result<Tensor> {
	let (b, t) = x.dims2()?;
	let x = x.unsqueeze(2)?; // [B, T, 1]
	let x = x.expand(&[b, t, factor])?; // [B, T, factor]
	x.reshape(&[b, t * factor])
}

/// Reflection padding for 1D signal [B, L]
fn reflection_pad_1d(x: &Tensor, pad: usize) -> Result<Tensor> {
	let (_b, l) = x.dims2()?;
	if pad == 0 {
		return Ok(x.clone());
	}
	// Left pad: reflect indices [pad, pad-1, ..., 1]
	let mut parts = Vec::new();
	if pad > 0 {
		let left = x.narrow(1, 1, pad)?.contiguous()?.flip(&[1])?;
		parts.push(left);
	}
	parts.push(x.clone());
	if pad > 0 {
		let right = x.narrow(1, l - pad - 1, pad)?.contiguous()?.flip(&[1])?;
		parts.push(right);
	}
	Tensor::cat(&parts, 1)
}

/// Reflection padding for 3D channels-first [B, C, T] with asymmetric padding
fn reflection_pad_1d_channels(x: &Tensor, pad_left: usize, pad_right: usize) -> Result<Tensor> {
	let (_b, _c, t) = x.dims3()?;
	let mut parts = Vec::new();

	if pad_left > 0 {
		let left = x.narrow(2, 1, pad_left)?.contiguous()?.flip(&[2])?;
		parts.push(left);
	}
	parts.push(x.clone());
	if pad_right > 0 {
		let right = x
			.narrow(2, t - pad_right - 1, pad_right)?
			.contiguous()?
			.flip(&[2])?;
		parts.push(right);
	}
	Tensor::cat(&parts, 2)
}

/// GPU-native linear downsample of [B, C, T] by factor N.
/// Equivalent to F.interpolate(x, `scale_factor=1/N`, mode='linear').
/// Uses gather + lerp pattern: for each output position, blend two input
/// positions.
fn gpu_linear_downsample(
	x: &Tensor,
	factor: usize,
	device: &Device,
	dtype: DType,
) -> Result<Tensor> {
	let (b, c, t_in) = x.dims3()?;
	let t_out = (t_in as f64 / factor as f64).floor() as usize;
	if t_out == 0 {
		return Tensor::zeros(&[b, c, 1], dtype, device);
	}

	// Compute source positions: src = (i + 0.5) * factor - 0.5
	// and split into integer index + fractional blend weight
	let mut lo_indices = Vec::with_capacity(t_out);
	let mut fracs = Vec::with_capacity(t_out);
	for i in 0..t_out {
		let src = (i as f64 + 0.5).mul_add(factor as f64, -0.5);
		let src = src.max(0.0).min((t_in - 1) as f64);
		let lo = src.floor() as u32;
		let _hi_idx = ((lo + 1) as usize).min(t_in - 1) as u32;
		let frac = (src - lo as f64) as f32;
		lo_indices.push(lo);
		fracs.push(frac);
	}

	// Build index tensors and blend weights on GPU
	let lo_t = Tensor::new(&lo_indices[..], device)?; // [t_out]
	let frac_t = Tensor::new(&fracs[..], device)?
		.to_dtype(dtype)?
		.reshape(&[1, 1, t_out])?; // [1, 1, t_out] for broadcast

	// Gather: x[:, :, lo] and x[:, :, lo+1]
	let hi_indices: Vec<u32> = lo_indices
		.iter()
		.map(|&lo| (lo + 1).min(t_in as u32 - 1))
		.collect();
	let hi_t = Tensor::new(&hi_indices[..], device)?;

	let x_lo = x.index_select(&lo_t, 2)?; // [B, C, t_out]
	let x_hi = x.index_select(&hi_t, 2)?; // [B, C, t_out]

	// Linear blend: (1 - frac) * lo + frac * hi
	let one_minus_frac = (1.0f64 - &frac_t)?;
	let result = (x_lo.broadcast_mul(&one_minus_frac)? + x_hi.broadcast_mul(&frac_t)?)?;
	Ok(result)
}

/// GPU-native linear upsample of [B, C, `T_in`] to `T_out`.
/// Equivalent to F.interpolate(x, `size=t_out`, mode='linear') with
/// `scale_factor` semantics.
fn gpu_linear_upsample(
	x: &Tensor,
	factor: usize,
	t_out: usize,
	device: &Device,
	dtype: DType,
) -> Result<Tensor> {
	let (b, c, t_in) = x.dims3()?;
	if t_in == 0 || t_out == 0 {
		return Tensor::zeros(&[b, c, t_out], dtype, device);
	}

	// Source positions: src = (i + 0.5) / factor - 0.5
	let scale = factor as f64;
	let mut lo_indices = Vec::with_capacity(t_out);
	let mut fracs = Vec::with_capacity(t_out);
	for i in 0..t_out {
		let src = (i as f64 + 0.5) / scale - 0.5;
		let src = src.max(0.0).min((t_in - 1) as f64);
		let lo = src.floor() as u32;
		let frac = (src - lo as f64) as f32;
		lo_indices.push(lo);
		fracs.push(frac);
	}

	let lo_t = Tensor::new(&lo_indices[..], device)?;
	let frac_t = Tensor::new(&fracs[..], device)?
		.to_dtype(dtype)?
		.reshape(&[1, 1, t_out])?;

	let hi_indices: Vec<u32> = lo_indices
		.iter()
		.map(|&lo| (lo + 1).min(t_in as u32 - 1))
		.collect();
	let hi_t = Tensor::new(&hi_indices[..], device)?;

	let x_lo = x.index_select(&lo_t, 2)?;
	let x_hi = x.index_select(&hi_t, 2)?;

	let one_minus_frac = (1.0f64 - &frac_t)?;
	let result = (x_lo.broadcast_mul(&one_minus_frac)? + x_hi.broadcast_mul(&frac_t)?)?;
	Ok(result)
}

#[cfg(test)]
mod tests {
	use candle_core::{DType, Device, Result};

	use super::{SynthesisMode, rand_or_zero, randn_or_zero};

	#[test]
	fn deterministic_uniform_source_returns_zeros() -> Result<()> {
		let tensor =
			rand_or_zero(SynthesisMode::Deterministic, 0.0, 1.0, (2, 3), &Device::Cpu, DType::F32)?;

		assert_eq!(tensor.dims(), &[2, 3]);
		assert_eq!(tensor.to_vec2::<f32>()?, vec![vec![0.0; 3], vec![0.0; 3]]);
		Ok(())
	}

	#[test]
	fn deterministic_normal_source_returns_zeros() -> Result<()> {
		let tensor =
			randn_or_zero(SynthesisMode::Deterministic, 0.0, 1.0, (2, 3), &Device::Cpu, DType::F32)?;

		assert_eq!(tensor.dims(), &[2, 3]);
		assert_eq!(tensor.to_vec2::<f32>()?, vec![vec![0.0; 3], vec![0.0; 3]]);
		Ok(())
	}

	#[test]
	fn stochastic_sources_keep_requested_shape() -> Result<()> {
		let uniform =
			rand_or_zero(SynthesisMode::Stochastic, 0.0, 1.0, (2, 3), &Device::Cpu, DType::F32)?;
		let normal =
			randn_or_zero(SynthesisMode::Stochastic, 0.0, 1.0, (2, 3), &Device::Cpu, DType::F32)?;

		assert_eq!(uniform.dims(), &[2, 3]);
		assert_eq!(normal.dims(), &[2, 3]);
		Ok(())
	}
}
