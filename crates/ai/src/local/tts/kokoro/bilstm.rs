//! Bidirectional LSTM implementation for candle.
//!
//! candle's built-in LSTM is unidirectional. For `BiLSTM`, we create two
//! LSTMs (forward and backward), run them on the input, and concatenate
//! their outputs along the feature dimension.

use candle_core::{IndexOp, Result, Tensor};
use candle_nn::{self as nn, LSTMConfig, RNN, VarBuilder, rnn::Direction};

/// Bidirectional LSTM that produces output of size `2 * hidden_dim` by
/// running a forward LSTM and a backward LSTM and concatenating.
pub struct BiLSTM {
	fwd:         nn::LSTM,
	bwd:         nn::LSTM,
	_hidden_dim: usize,
}

impl BiLSTM {
	/// Loads forward and backward LSTM weights from the supplied variable
	/// builder.
	pub fn load(in_dim: usize, hidden_dim: usize, vb: VarBuilder) -> Result<Self> {
		let fwd_cfg = LSTMConfig { direction: Direction::Forward, ..Default::default() };
		let bwd_cfg = LSTMConfig { direction: Direction::Backward, ..Default::default() };

		let fwd = nn::lstm(in_dim, hidden_dim, fwd_cfg, vb.clone())?;
		let bwd = nn::lstm(in_dim, hidden_dim, bwd_cfg, vb)?;

		Ok(Self { fwd, bwd, _hidden_dim: hidden_dim })
	}

	/// input: [B, T, features]
	/// output: [B, T, 2*`hidden_dim`]
	pub fn forward(&self, input: &Tensor) -> Result<Tensor> {
		let (_b, seq_len, _feat) = input.dims3()?;

		// Forward pass
		let fwd_states = self.fwd.seq(input)?;
		let fwd_h: Vec<Tensor> = fwd_states.iter().map(|s| s.h().clone()).collect();
		let fwd_out = Tensor::stack(&fwd_h, 1)?; // [B, T, hidden_dim]

		// Backward pass: reverse input along time axis
		let mut bwd_slices = Vec::with_capacity(seq_len);
		for i in (0..seq_len).rev() {
			bwd_slices.push(input.i((.., i..i + 1, ..))?.clone());
		}
		let reversed = Tensor::cat(&bwd_slices, 1)?;
		let bwd_states = self.bwd.seq(&reversed)?;
		let bwd_h: Vec<Tensor> = bwd_states.iter().map(|s| s.h().clone()).collect();
		let bwd_out_reversed = Tensor::stack(&bwd_h, 1)?; // [B, T, hidden_dim]

		// Reverse backward output to align with forward
		let mut bwd_slices_out = Vec::with_capacity(seq_len);
		for i in (0..seq_len).rev() {
			bwd_slices_out.push(bwd_out_reversed.i((.., i..i + 1, ..))?.clone());
		}
		let bwd_out = Tensor::cat(&bwd_slices_out, 1)?;

		// Concatenate along feature dimension
		Tensor::cat(&[&fwd_out, &bwd_out], 2)
	}
}
