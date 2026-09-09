use std::collections::HashMap;

use serde::Deserialize;

/// Architecture and inference settings deserialized from Kokoro's
/// `config.json`.
#[derive(Debug, Clone, Deserialize)]
pub struct ModelConfig {
	/// iSTFTNet vocoder architecture.
	pub istftnet:                 IstftNetConfig,
	/// Dropout probability for the text encoder.
	#[serde(default = "default_dropout")]
	pub dropout:                  f64,
	/// Width of the model's shared hidden representation.
	pub hidden_dim:               usize,
	/// Maximum predicted phoneme duration.
	#[serde(default = "default_max_dur")]
	pub max_dur:                  usize,
	/// Number of layers in the text encoder and duration predictor.
	pub n_layer:                  usize,
	/// Number of mel-frequency bins produced by the decoder.
	#[serde(default = "default_n_mels")]
	pub n_mels:                   usize,
	/// Number of phoneme tokens accepted by the text encoder.
	pub n_token:                  usize,
	/// Width of the acoustic and prosodic style embeddings.
	pub style_dim:                usize,
	/// Convolution kernel width in the text encoder.
	#[serde(default = "default_text_encoder_kernel_size")]
	pub text_encoder_kernel_size: usize,
	/// ALBERT text encoder architecture.
	pub plbert:                   PlbertConfig,
	/// Mapping from phoneme strings to token IDs.
	#[serde(default)]
	pub vocab:                    HashMap<String, i64>,
	/// Output waveform sample rate in hertz.
	#[serde(default = "default_sample_rate")]
	pub sample_rate:              u32,
}

/// Architecture settings for the iSTFTNet waveform decoder.
#[derive(Debug, Clone, Deserialize)]
pub struct IstftNetConfig {
	/// Kernel width for each upsampling stage.
	pub upsample_kernel_sizes:    Vec<usize>,
	/// Upsampling factor for each decoder stage.
	pub upsample_rates:           Vec<usize>,
	/// Hop length used for inverse short-time Fourier transforms.
	pub gen_istft_hop_size:       usize,
	/// FFT size used for inverse short-time Fourier transforms.
	pub gen_istft_n_fft:          usize,
	/// Dilation patterns for the residual blocks at each upsampling stage.
	pub resblock_dilation_sizes:  Vec<Vec<usize>>,
	/// Kernel widths for the residual blocks.
	pub resblock_kernel_sizes:    Vec<usize>,
	/// Channel width entering the first upsampling stage.
	pub upsample_initial_channel: usize,
}

/// Architecture settings for Kokoro's ALBERT phoneme encoder.
#[derive(Debug, Clone, Deserialize)]
pub struct PlbertConfig {
	/// Width of ALBERT's hidden states.
	pub hidden_size:             usize,
	/// Width of token and position embeddings before projection.
	#[serde(default = "default_embedding_size")]
	pub embedding_size:          usize,
	/// Number of attention heads per transformer layer.
	pub num_attention_heads:     usize,
	/// Width of each transformer's feed-forward layer.
	pub intermediate_size:       usize,
	/// Maximum sequence length supported by position embeddings.
	pub max_position_embeddings: usize,
	/// Number of ALBERT transformer layers.
	pub num_hidden_layers:       usize,
	/// Dropout probability used by the ALBERT encoder.
	#[serde(default = "default_plbert_dropout")]
	pub dropout:                 f64,
}

const fn default_dropout() -> f64 {
	0.2
}
const fn default_max_dur() -> usize {
	50
}
const fn default_n_mels() -> usize {
	80
}
const fn default_text_encoder_kernel_size() -> usize {
	5
}
const fn default_embedding_size() -> usize {
	128
}
const fn default_plbert_dropout() -> f64 {
	0.1
}
const fn default_sample_rate() -> u32 {
	24000
}
