//! Canonical mono PCM16 RIFF/WAVE encoding.

use thiserror::Error;

/// Canonical PCM WAV header size.
pub const WAV_HEADER_BYTES: usize = 44;

/// WAV encoding failures.
#[derive(Clone, Copy, Debug, Error, Eq, PartialEq)]
pub enum WavError {
	/// The sample rate must be non-zero.
	#[error("WAV sample rate must be non-zero")]
	ZeroSampleRate,
	/// RIFF stores chunk lengths as unsigned 32-bit integers.
	#[error("PCM sample data exceeds RIFF size limits")]
	RiffSize,
}

/// Encodes normalized mono floating-point samples as canonical little-endian
/// PCM16 WAV.
pub fn encode_wav(samples: &[f32], sample_rate: u32) -> Result<Vec<u8>, WavError> {
	if sample_rate == 0 {
		return Err(WavError::ZeroSampleRate);
	}
	let data_bytes = samples
		.len()
		.checked_mul(2)
		.and_then(|bytes| u32::try_from(bytes).ok())
		.ok_or(WavError::RiffSize)?;
	let riff_size = data_bytes.checked_add(36).ok_or(WavError::RiffSize)?;
	let byte_rate = sample_rate.checked_mul(2).ok_or(WavError::RiffSize)?;
	let mut output = Vec::with_capacity(WAV_HEADER_BYTES + data_bytes as usize);
	output.extend_from_slice(b"RIFF");
	output.extend_from_slice(&riff_size.to_le_bytes());
	output.extend_from_slice(b"WAVE");
	output.extend_from_slice(b"fmt ");
	output.extend_from_slice(&16_u32.to_le_bytes());
	output.extend_from_slice(&1_u16.to_le_bytes());
	output.extend_from_slice(&1_u16.to_le_bytes());
	output.extend_from_slice(&sample_rate.to_le_bytes());
	output.extend_from_slice(&byte_rate.to_le_bytes());
	output.extend_from_slice(&2_u16.to_le_bytes());
	output.extend_from_slice(&16_u16.to_le_bytes());
	output.extend_from_slice(b"data");
	output.extend_from_slice(&data_bytes.to_le_bytes());
	for sample in samples {
		let clamped = sample.clamp(-1.0, 1.0);
		let quantized = if clamped < 0.0 {
			(clamped * 32_768.0).round().max(f32::from(i16::MIN)) as i16
		} else {
			(clamped * 32_767.0).round().min(f32::from(i16::MAX)) as i16
		};
		output.extend_from_slice(&quantized.to_le_bytes());
	}
	Ok(output)
}
