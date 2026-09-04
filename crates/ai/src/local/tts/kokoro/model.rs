//! `KModel` — the top-level Kokoro TTS model.
//!
//! Ported from kokoro/model.py

use candle_core::{DType, Device, Error, Module, Result, Tensor};
use candle_nn::{self as nn, VarBuilder};

use super::{
	albert::CustomAlbert,
	catalog::{ModelRegistration, REGISTRATION},
	config::ModelConfig,
	istftnet::{Decoder, SynthesisMode},
	modules::{ProsodyPredictor, TextEncoder},
};

/// The top-level Kokoro-82M model.
pub struct KModel {
	bert:           CustomAlbert,
	bert_encoder:   nn::Linear,
	predictor:      ProsodyPredictor,
	text_encoder:   TextEncoder,
	decoder:        Decoder,
	context_length: usize,
}

impl KModel {
	/// Returns the stable model/voice registration implemented by this engine.
	pub const fn registration() -> &'static ModelRegistration {
		&REGISTRATION
	}

	/// Load model weights from a `VarBuilder` (typically backed by safetensors).
	#[tracing::instrument(
		level = "debug",
		name = "model_weight_load",
		skip_all,
		fields(gen_ai.request.model = REGISTRATION.id)
	)]
	pub fn load(config: &ModelConfig, vb: VarBuilder) -> Result<Self> {
		let result = (|| {
			let bert = CustomAlbert::load(&config.plbert, config.n_token, vb.pp("bert"))?;

			let bert_encoder =
				nn::linear(config.plbert.hidden_size, config.hidden_dim, vb.pp("bert_encoder"))?;

			let predictor = ProsodyPredictor::load(
				config.style_dim,
				config.hidden_dim,
				config.n_layer,
				config.max_dur,
				vb.pp("predictor"),
			)?;

			let text_encoder = TextEncoder::load(
				config.hidden_dim,
				config.text_encoder_kernel_size,
				config.n_layer,
				config.n_token,
				vb.pp("text_encoder"),
			)?;

			let istft = &config.istftnet;
			let decoder = Decoder::load(
				config.hidden_dim,
				config.style_dim,
				config.n_mels,
				&istft.resblock_kernel_sizes,
				&istft.upsample_rates,
				istft.upsample_initial_channel,
				&istft.resblock_dilation_sizes,
				&istft.upsample_kernel_sizes,
				istft.gen_istft_n_fft,
				istft.gen_istft_hop_size,
				vb.pp("decoder"),
			)?;

			Ok(Self {
				bert,
				bert_encoder,
				predictor,
				text_encoder,
				decoder,
				context_length: config.plbert.max_position_embeddings,
			})
		})();

		match result {
			Ok(model) => {
				tracing::info!(gen_ai.request.model = REGISTRATION.id, "voice model loaded");
				Ok(model)
			},
			Err(error) => {
				tracing::warn!(
					gen_ai.request.model = REGISTRATION.id,
					error = %error,
					"voice model load failed"
				);
				Err(error)
			},
		}
	}

	/// Run inference.
	///
	/// * `input_ids` - phoneme token IDs (without BOS/EOS padding; the model
	///   adds [0, ..., 0])
	/// * `ref_s` - reference style tensor [1, 256] (first 128 = acoustic style,
	///   last 128 = prosody style)
	/// * `speed` - finite, positive speed factor (1.0 = normal)
	///
	/// Returns: audio waveform tensor [samples]
	pub fn forward(
		&self,
		input_ids: &[i64],
		ref_s: &Tensor,
		speed: f32,
		device: &Device,
	) -> Result<Tensor> {
		self.forward_with_mode(input_ids, ref_s, speed, device, SynthesisMode::Stochastic)
	}

	/// Run inference with explicit synthesis-mode control.
	///
	/// Deterministic mode removes the decoder's random harmonic phase and noise
	/// sources, making output reproducible on CPU and GPU backends. `speed` must
	/// be finite and greater than zero.
	#[tracing::instrument(
		level = "debug",
		name = "voice_synthesis",
		skip_all,
		fields(
			gen_ai.request.model = REGISTRATION.id,
			input_tokens = input_ids.len(),
			synthesis.mode = ?mode
		)
	)]
	pub fn forward_with_mode(
		&self,
		input_ids: &[i64],
		ref_s: &Tensor,
		speed: f32,
		device: &Device,
		mode: SynthesisMode,
	) -> Result<Tensor> {
		validate_speed(speed)?;

		// Pad with BOS=0 and EOS=0
		let mut padded = Vec::with_capacity(input_ids.len() + 2);
		padded.push(0i64);
		padded.extend_from_slice(input_ids);
		padded.push(0i64);

		let seq_len = padded.len();
		validate_context_length(seq_len, self.context_length)?;

		let input_ids_t = Tensor::new(&padded[..], device)?.unsqueeze(0)?; // [1, T]
		let input_lengths = Tensor::new(&[seq_len as i64][..], device)?; // [1]

		// Text mask: [1, T], true where position >= length (i.e., padding)
		// Python: mask = torch.gt(mask+1, lengths.unsqueeze(1))
		// For single-sequence inference with no padding, this is all false (0).
		// For single-sequence inference with no padding, mask is all false
		let mask_data: Vec<f32> = (0..seq_len)
			.map(|i| if i + 1 > seq_len { 1.0 } else { 0.0 })
			.collect();
		let text_mask = Tensor::new(&mask_data[..], device)?.unsqueeze(0)?; // [1, T]
		let text_mask = text_mask.gt(0.5)?; // [1, T] u8
		let text_mask_f = text_mask.to_dtype(DType::F32)?;

		// BERT: attention_mask is 1=attend, 0=pad (inverse of text_mask)
		let attention_mask = (1.0 - &text_mask_f)?;

		// ALBERT forward
		let bert_dur = self
			.bert
			.forward(&input_ids_t.to_dtype(DType::U32)?, &attention_mask.to_dtype(DType::F32)?)?; // [1, T, hidden_size]

		// bert_encoder: project hidden_size -> hidden_dim
		let d_en = self.bert_encoder.forward(&bert_dur)?; // [1, T, hidden_dim]
		let d_en = d_en.transpose(1, 2)?; // [1, hidden_dim, T]

		// Style split: ref_s[:, 128:] = prosody style, ref_s[:, :128] = acoustic style
		let s = ref_s.narrow(1, 128, 128)?; // [1, 128] prosody style

		// Duration encoder
		let d = self
			.predictor
			.text_encoder
			.forward(&d_en, &s, &input_lengths, &text_mask)?; // [1, T, hidden_dim]

		// Duration LSTM: needs [1, T, hidden_dim + style_dim]
		let (b, t_dur, _) = d.dims3()?;
		let s_exp = s.unsqueeze(1)?.expand(&[b, t_dur, 128])?;
		let d_cat = Tensor::cat(&[&d, &s_exp], 2)?; // [1, T, hidden_dim + 128]
		let x = self.predictor.lstm.forward(&d_cat)?; // [1, T, hidden_dim]

		// Duration projection
		let duration = self.predictor.duration_proj.forward(&x)?; // [1, T, max_dur]
		let duration = candle_nn::ops::sigmoid(&duration)?;
		let duration = duration.sum(2)?; // [1, T]
		let speed_t = Tensor::new(speed, device)?.to_dtype(duration.dtype())?;
		let duration = duration.broadcast_div(&speed_t)?;
		let pred_dur = duration.round()?.clamp(1.0f32, f32::MAX)?;

		// Build alignment matrix on GPU via repeat_interleave-style expansion.
		//
		// The alignment matrix is a [T, total_frames] binary matrix where each
		// token row has 1s in the frame columns it occupies. Instead of building
		// this with a CPU loop (which requires GPU→CPU→GPU round-trip), we:
		//   1. Download durations once (small: ~100 i64 values)
		//   2. Build per-row one-hot slices and concatenate on GPU
		//
		// For typical phoneme counts (50-150 tokens), the duration download is
		// ~400 bytes — negligible vs the old approach which also downloaded them.
		let pred_dur_vec: Vec<i64> = pred_dur
			.squeeze(0)?
			.to_dtype(DType::F32)?
			.to_vec1::<f32>()?
			.iter()
			.map(|&v| v.max(1.0) as i64)
			.collect();
		let pred_dur_vec = normalize_boundary_token_durations(pred_dur_vec);
		let total_frames = total_duration_frames(&pred_dur_vec)?;

		// Build alignment rows on GPU: each row is [0..0, 1..1, 0..0]
		let mut rows: Vec<Tensor> = Vec::with_capacity(seq_len);
		let mut frame_offset = 0usize;
		for (token_idx, &dur) in pred_dur_vec.iter().enumerate() {
			let dur = dur as usize;
			if token_idx < seq_len && dur > 0 && frame_offset + dur <= total_frames {
				// Build row: zeros(frame_offset) | ones(dur) | zeros(remaining)
				let remaining = total_frames - frame_offset - dur;
				let row = if frame_offset == 0 && remaining == 0 {
					Tensor::ones((1, total_frames), DType::F32, device)?
				} else {
					let mut parts: Vec<Tensor> = Vec::new();
					if frame_offset > 0 {
						parts.push(Tensor::zeros((1, frame_offset), DType::F32, device)?);
					}
					parts.push(Tensor::ones((1, dur), DType::F32, device)?);
					if remaining > 0 {
						parts.push(Tensor::zeros((1, remaining), DType::F32, device)?);
					}
					Tensor::cat(&parts, 1)?
				};
				rows.push(row);
			} else {
				rows.push(Tensor::zeros((1, total_frames), DType::F32, device)?);
			}
			frame_offset += dur;
		}
		let pred_aln_trg = Tensor::cat(&rows, 0)?.unsqueeze(0)?; // [1, T, total_frames]

		// en = d.transpose(-1,-2) @ pred_aln_trg
		// d is [1, T, hidden_dim] -> transpose to [1, hidden_dim, T]
		let d_t = d.transpose(1, 2)?;
		let en = d_t.matmul(&pred_aln_trg)?; // [1, hidden_dim, total_frames]

		// F0 and N prediction
		let (f0_pred, n_pred) = self.predictor.f0_n_train(&en, &s)?;

		// Text encoder
		let t_en = self.text_encoder.forward(
			&input_ids_t.to_dtype(DType::U32)?,
			&input_lengths,
			&text_mask,
		)?; // [1, hidden_dim, T]

		// asr = t_en @ pred_aln_trg
		let asr = t_en.matmul(&pred_aln_trg)?; // [1, hidden_dim, total_frames]

		// Decoder
		let s_acoustic = ref_s.narrow(1, 0, 128)?; // [1, 128]
		let audio = self
			.decoder
			.forward_with_mode(&asr, &f0_pred, &n_pred, &s_acoustic, mode)?;

		// audio: [1, 1, samples] -> [samples]
		audio.squeeze(0)?.squeeze(0)
	}
}

fn validate_context_length(seq_len: usize, context_length: usize) -> Result<()> {
	if seq_len > context_length {
		return Err(Error::Msg(format!("Input too long: {seq_len} > {context_length}")));
	}
	Ok(())
}
fn validate_speed(speed: f32) -> Result<()> {
	if !speed.is_finite() || speed <= 0.0 {
		return Err(Error::Msg(format!("speed must be finite and greater than zero, got {speed}")));
	}
	Ok(())
}

const MAX_TOTAL_DURATION_FRAMES: usize = 65_536;

fn total_duration_frames(durations: &[i64]) -> Result<usize> {
	let mut total = 0_usize;
	for &duration in durations {
		let duration = usize::try_from(duration)
			.map_err(|_| Error::Msg(format!("predicted a negative duration: {duration}")))?;
		total = total
			.checked_add(duration)
			.ok_or_else(|| Error::Msg("predicted duration frame sum overflowed".to_owned()))?;
		if total > MAX_TOTAL_DURATION_FRAMES {
			return Err(Error::Msg(format!(
				"predicted duration exceeds {MAX_TOTAL_DURATION_FRAMES} frames"
			)));
		}
	}
	Ok(total)
}

const MAX_BOS_DURATION_FRAMES: i64 = 16;

fn normalize_boundary_token_durations(mut durations: Vec<i64>) -> Vec<i64> {
	// The Python reference keeps BOS/EOS durations in the alignment. Keeping a
	// bounded BOS duration gives the first real token enough onset context,
	// while suppressing EOS avoids long synthesized tails for short utterances.
	if let Some(first) = durations.first_mut() {
		*first = (*first).min(MAX_BOS_DURATION_FRAMES);
	}
	if durations.len() > 1 {
		let last_idx = durations.len() - 1;
		durations[last_idx] = 0;
	}
	durations
}

#[cfg(test)]
mod tests {
	use super::{
		MAX_BOS_DURATION_FRAMES, MAX_TOTAL_DURATION_FRAMES, normalize_boundary_token_durations,
		total_duration_frames, validate_context_length, validate_speed,
	};

	#[test]
	fn context_length_allows_equal_length() {
		assert!(validate_context_length(510, 510).is_ok());
	}

	#[test]
	fn context_length_rejects_overlong_input() {
		let err = validate_context_length(511, 510).unwrap_err();
		assert!(err.to_string().contains("Input too long: 511 > 510"));
	}
	#[test]
	fn speed_must_be_finite_and_positive() {
		assert!(validate_speed(1.0).is_ok());
		for speed in [0.0, -1.0, f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
			assert!(validate_speed(speed).is_err(), "accepted speed {speed}");
		}
	}

	#[test]
	fn duration_frame_sum_checks_sign_overflow_and_capacity_boundary() {
		assert_eq!(
			total_duration_frames(&[MAX_TOTAL_DURATION_FRAMES as i64]).unwrap(),
			MAX_TOTAL_DURATION_FRAMES
		);
		assert!(total_duration_frames(&[-1]).is_err());
		assert!(total_duration_frames(&[MAX_TOTAL_DURATION_FRAMES as i64, 1]).is_err());
		assert!(total_duration_frames(&[i64::MAX, i64::MAX]).is_err());
	}

	#[test]
	fn boundary_duration_normalization_preserves_capped_bos_and_suppresses_eos() {
		let durations = normalize_boundary_token_durations(vec![4, 7, 9, 3]);
		assert_eq!(durations, vec![4, 7, 9, 0]);

		let capped = normalize_boundary_token_durations(vec![40, 7, 9, 3]);
		assert_eq!(capped, vec![MAX_BOS_DURATION_FRAMES, 7, 9, 0]);
	}

	#[test]
	fn boundary_duration_normalization_caps_single_boundary_duration() {
		assert_eq!(normalize_boundary_token_durations(vec![2]), vec![2]);
		assert_eq!(normalize_boundary_token_durations(vec![40]), vec![MAX_BOS_DURATION_FRAMES]);
		assert_eq!(normalize_boundary_token_durations(Vec::new()), Vec::<i64>::new());
	}
}
