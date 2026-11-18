//! The audio files `say -o` writes itself: linear PCM in AIFF, AIFF-C, WAVE
//! and CAF containers, in the sample formats `--data-format` spells
//! (`LEI16`, `BEF32@22050`, …). Also reads the WAVE files system
//! synthesizers write, so their audio lands in any of those containers.

use std::io;

use crate::speech::SpeechAudio;

/// An audio container this module writes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Container {
	Aiff,
	Aifc,
	Wave,
	Caf,
}

impl Container {
	/// The container `--file-format` names by its four-character code.
	pub fn from_code(code: &str) -> Option<Self> {
		match code {
			"AIFF" => Some(Self::Aiff),
			"AIFC" => Some(Self::Aifc),
			"WAVE" => Some(Self::Wave),
			"caff" => Some(Self::Caf),
			_ => None,
		}
	}

	/// The container a file extension implies; `.aiff` is AIFF-C, as the
	/// system `say` writes it.
	pub fn from_extension(extension: &str) -> Option<Self> {
		match extension.to_ascii_lowercase().as_str() {
			"aiff" | "aif" | "aifc" => Some(Self::Aifc),
			"wav" | "wave" => Some(Self::Wave),
			"caf" => Some(Self::Caf),
			_ => None,
		}
	}
}

/// How the samples of a linear PCM format are stored.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Sample {
	Int,
	UnsignedInt,
	Float,
}

/// A linear PCM `--data-format`: `[BE|LE](F|I|UI)<bits>[@rate][/flags]`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct DataFormat {
	/// `None` leaves the byte order to the container.
	big_endian:  Option<bool>,
	sample:      Sample,
	bits:        u8,
	/// `@rate`: the sample rate to convert to.
	sample_rate: Option<u32>,
}

impl DataFormat {
	/// Parses a linear PCM specification; `None` for anything else (`aac`,
	/// `alac`, a malformed specification).
	pub fn parse(spec: &str) -> Option<Self> {
		let spec = spec.split_once('/').map_or(spec, |(format, _flags)| format);
		let (layout, sample_rate) = match spec.split_once('@') {
			Some((layout, rate)) => {
				let rate = rate.parse::<f64>().ok().filter(|rate| *rate >= 1.0 && *rate <= 768_000.0)?;
				(layout, Some(rate.round() as u32))
			},
			None => (spec, None),
		};
		if layout.is_empty() || layout == "lpcm" {
			return Some(Self { big_endian: None, sample: Sample::Int, bits: 16, sample_rate });
		}
		let (big_endian, layout) = if let Some(rest) = layout.strip_prefix("BE") {
			(Some(true), rest)
		} else if let Some(rest) = layout.strip_prefix("LE") {
			(Some(false), rest)
		} else {
			(None, layout)
		};
		let (sample, bits) = if let Some(bits) = layout.strip_prefix("UI") {
			(Sample::UnsignedInt, bits)
		} else if let Some(bits) = layout.strip_prefix('I') {
			(Sample::Int, bits)
		} else if let Some(bits) = layout.strip_prefix('F') {
			(Sample::Float, bits)
		} else {
			return None;
		};
		let bits = bits.parse::<u8>().ok().filter(|bits| matches!(bits, 8 | 16 | 24 | 32 | 64))?;
		Some(Self { big_endian, sample, bits, sample_rate })
	}
}

/// The stored form of one sample, checked against its container.
#[derive(Clone, Copy)]
struct Layout {
	big_endian: bool,
	sample:     Sample,
	bits:       u8,
}

impl Layout {
	/// The layout `format` (or the container's default, 16-bit integers)
	/// takes in `container`; `None` when the container cannot hold it.
	fn resolve(container: Container, format: Option<DataFormat>) -> Option<Self> {
		let native_big = container != Container::Wave;
		let layout = match format {
			Some(format) => Self {
				big_endian: format.big_endian.unwrap_or(native_big),
				sample:     format.sample,
				bits:       format.bits,
			},
			None => Self { big_endian: native_big, sample: Sample::Int, bits: 16 },
		};
		let Self { big_endian, sample, bits } = layout;
		let valid = match (container, sample) {
			(Container::Aiff, Sample::Int) => big_endian && bits <= 32,
			(Container::Aifc, Sample::Int) => bits <= 32 && (big_endian || bits == 16),
			(Container::Aifc, Sample::Float) => big_endian && bits >= 32,
			(Container::Wave, Sample::Int) => !big_endian && (16..=32).contains(&bits),
			(Container::Wave, Sample::UnsignedInt) => bits == 8,
			(Container::Wave | Container::Caf, Sample::Float) => {
				(container == Container::Caf || !big_endian) && bits >= 32
			},
			(Container::Caf, Sample::Int) => bits <= 32,
			_ => false,
		};
		valid.then_some(layout)
	}

	const fn bytes(self) -> usize {
		self.bits as usize / 8
	}

	/// Appends `value` (`-1.0..=1.0`) in this layout.
	fn put(self, out: &mut Vec<u8>, value: f32) {
		let value = f64::from(value.clamp(-1.0, 1.0));
		let mut bytes = [0u8; 8];
		let width = self.bytes();
		match self.sample {
			Sample::Float if self.bits == 32 => bytes[..4].copy_from_slice(&(value as f32).to_le_bytes()),
			Sample::Float => bytes.copy_from_slice(&value.to_le_bytes()),
			Sample::Int | Sample::UnsignedInt => {
				let peak = ((1i64 << (self.bits - 1)) - 1) as f64;
				let mut scaled = (value * peak).round() as i64;
				if self.sample == Sample::UnsignedInt {
					scaled += 1i64 << (self.bits - 1);
				}
				bytes.copy_from_slice(&scaled.to_le_bytes());
			},
		}
		if self.big_endian {
			out.extend(bytes[..width].iter().rev());
		} else {
			out.extend_from_slice(&bytes[..width]);
		}
	}
}

/// Encodes mono `audio` as a `container` file with `channels` identical
/// channels in `format` (the container's 16-bit default when `None`).
/// `None` when the container cannot hold that format.
pub(super) fn encode(
	audio: &SpeechAudio,
	container: Container,
	format: Option<DataFormat>,
	channels: u16,
) -> Option<Vec<u8>> {
	let layout = Layout::resolve(container, format)?;
	let channels = channels.max(1);
	let resampled;
	let (samples, sample_rate) = match format.and_then(|format| format.sample_rate) {
		Some(rate) if rate != audio.sample_rate && audio.sample_rate > 0 => {
			resampled = resample(&audio.samples, audio.sample_rate, rate);
			(resampled.as_slice(), rate)
		},
		_ => (audio.samples.as_slice(), audio.sample_rate),
	};
	let mut data = Vec::with_capacity(samples.len() * layout.bytes() * usize::from(channels));
	for &sample in samples {
		for _ in 0..channels {
			layout.put(&mut data, sample);
		}
	}
	let frames = u32::try_from(samples.len()).ok()?;
	Some(match container {
		Container::Aiff | Container::Aifc => aiff(container == Container::Aifc, layout, channels, sample_rate, frames, &data),
		Container::Wave => wave(layout, channels, sample_rate, &data),
		Container::Caf => caf(layout, channels, sample_rate, &data),
	})
}

/// Linear-interpolation sample rate conversion.
fn resample(samples: &[f32], from: u32, to: u32) -> Vec<f32> {
	let Some(last) = samples.len().checked_sub(1) else {
		return Vec::new();
	};
	let length = (samples.len() as u64 * u64::from(to)).div_ceil(u64::from(from)) as usize;
	let step = f64::from(from) / f64::from(to);
	(0..length)
		.map(|index| {
			let position = index as f64 * step;
			let before = (position as usize).min(last);
			let after = (before + 1).min(last);
			let fraction = (position - before as f64) as f32;
			samples[before] + (samples[after] - samples[before]) * fraction
		})
		.collect()
}

/// An IFF chunk: id, big-endian size, body, pad byte to an even length.
fn iff_chunk(out: &mut Vec<u8>, id: &[u8; 4], body: &[&[u8]]) {
	let size: usize = body.iter().map(|part| part.len()).sum();
	out.extend_from_slice(id);
	out.extend_from_slice(&(size as u32).to_be_bytes());
	for part in body {
		out.extend_from_slice(part);
	}
	if size % 2 == 1 {
		out.push(0);
	}
}

/// `rate` as the 80-bit IEEE 754 extended number of an AIFF `COMM` chunk.
fn extended(rate: u32) -> [u8; 10] {
	let mut bytes = [0u8; 10];
	if rate != 0 {
		let shift = rate.leading_zeros();
		let exponent = (16383 + 31 - shift) as u16;
		bytes[..2].copy_from_slice(&exponent.to_be_bytes());
		bytes[2..].copy_from_slice(&(u64::from(rate) << (32 + shift)).to_be_bytes());
	}
	bytes
}

fn aiff(compressed: bool, layout: Layout, channels: u16, sample_rate: u32, frames: u32, data: &[u8]) -> Vec<u8> {
	let mut chunks = Vec::with_capacity(data.len() + 72);
	chunks.extend_from_slice(if compressed { b"AIFC" } else { b"AIFF" });
	if compressed {
		// AIFF-C version 1.
		iff_chunk(&mut chunks, b"FVER", &[&0xA280_5140u32.to_be_bytes()]);
	}
	let compression: &[u8; 4] = match (layout.sample, layout.bits, layout.big_endian) {
		(Sample::Float, 32, _) => b"fl32",
		(Sample::Float, ..) => b"fl64",
		(_, _, false) => b"sowt",
		_ => b"NONE",
	};
	let (channels, frames, bits, rate) =
		(channels.to_be_bytes(), frames.to_be_bytes(), u16::from(layout.bits).to_be_bytes(), extended(sample_rate));
	// AIFF-C appends the compression type and its name, an empty Pascal
	// string padded to two bytes.
	let common: [&[u8]; 6] = [&channels, &frames, &bits, &rate, compression, &[0, 0]];
	iff_chunk(&mut chunks, b"COMM", &common[..if compressed { 6 } else { 4 }]);
	// Offset and block size of the sound data: unaligned.
	iff_chunk(&mut chunks, b"SSND", &[&[0; 8], data]);
	let mut file = Vec::with_capacity(chunks.len() + 8);
	file.extend_from_slice(b"FORM");
	file.extend_from_slice(&(chunks.len() as u32).to_be_bytes());
	file.extend_from_slice(&chunks);
	file
}

fn wave(layout: Layout, channels: u16, sample_rate: u32, data: &[u8]) -> Vec<u8> {
	let block = channels * u16::from(layout.bits) / 8;
	let tag: u16 = if layout.sample == Sample::Float { 3 } else { 1 };
	let padding = data.len() % 2;
	let mut file = Vec::with_capacity(data.len() + 44 + padding);
	file.extend_from_slice(b"RIFF");
	file.extend_from_slice(&((36 + data.len() + padding) as u32).to_le_bytes());
	file.extend_from_slice(b"WAVEfmt ");
	file.extend_from_slice(&16u32.to_le_bytes());
	file.extend_from_slice(&tag.to_le_bytes());
	file.extend_from_slice(&channels.to_le_bytes());
	file.extend_from_slice(&sample_rate.to_le_bytes());
	file.extend_from_slice(&(sample_rate * u32::from(block)).to_le_bytes());
	file.extend_from_slice(&block.to_le_bytes());
	file.extend_from_slice(&u16::from(layout.bits).to_le_bytes());
	file.extend_from_slice(b"data");
	file.extend_from_slice(&(data.len() as u32).to_le_bytes());
	file.extend_from_slice(data);
	file.resize(file.len() + padding, 0);
	file
}

fn caf(layout: Layout, channels: u16, sample_rate: u32, data: &[u8]) -> Vec<u8> {
	// kCAFLinearPCMFormatFlagIsFloat | kCAFLinearPCMFormatFlagIsLittleEndian.
	let flags = u32::from(layout.sample == Sample::Float) | (u32::from(!layout.big_endian) << 1);
	let frame = u32::from(channels) * u32::from(layout.bits) / 8;
	let mut file = Vec::with_capacity(data.len() + 68);
	file.extend_from_slice(b"caff");
	file.extend_from_slice(&[0, 1, 0, 0]);
	file.extend_from_slice(b"desc");
	file.extend_from_slice(&32i64.to_be_bytes());
	file.extend_from_slice(&f64::from(sample_rate).to_be_bytes());
	file.extend_from_slice(b"lpcm");
	for field in [flags, frame, 1, u32::from(channels), u32::from(layout.bits)] {
		file.extend_from_slice(&field.to_be_bytes());
	}
	file.extend_from_slice(b"data");
	file.extend_from_slice(&(data.len() as i64 + 4).to_be_bytes());
	// Edit count.
	file.extend_from_slice(&[0; 4]);
	file.extend_from_slice(data);
	file
}

fn malformed(what: &str) -> io::Error {
	io::Error::new(io::ErrorKind::InvalidData, format!("synthesizer wrote no usable audio: {what}"))
}

fn le_u16(bytes: &[u8], at: usize) -> Option<u16> {
	Some(u16::from_le_bytes(bytes.get(at..at + 2)?.try_into().ok()?))
}

fn le_u32(bytes: &[u8], at: usize) -> Option<u32> {
	Some(u32::from_le_bytes(bytes.get(at..at + 4)?.try_into().ok()?))
}

/// Decodes a PCM or float WAVE file to mono, averaging its channels.
///
/// # Errors
///
/// [`io::ErrorKind::InvalidData`] for anything that is not such a file.
pub(super) fn decode_wave(file: &[u8]) -> io::Result<SpeechAudio> {
	if file.get(..4) != Some(b"RIFF") || file.get(8..12) != Some(b"WAVE") {
		return Err(malformed("not a WAVE file"));
	}
	let mut format = None;
	let mut at = 12;
	while let (Some(id), Some(size)) = (file.get(at..at + 4), le_u32(file, at + 4)) {
		let body = at + 8;
		// A streamed file may declare more data than it holds.
		let end = body.saturating_add(size as usize).min(file.len());
		match id {
			b"fmt " => {
				let field = |offset| le_u16(file, body + offset).ok_or_else(|| malformed("short fmt chunk"));
				let mut tag = field(0)?;
				if tag == 0xFFFE {
					// WAVE_FORMAT_EXTENSIBLE: the sub-format GUID starts with the tag.
					tag = field(24)?;
				}
				let rate = le_u32(file, body + 4).ok_or_else(|| malformed("short fmt chunk"))?;
				format = Some((tag, field(2)?, rate, field(14)?));
			},
			b"data" => {
				let (tag, channels, sample_rate, bits) = format.ok_or_else(|| malformed("data before fmt"))?;
				let width = usize::from(bits / 8);
				let frame = width * usize::from(channels);
				if frame == 0 || !matches!((tag, bits), (1, 8 | 16 | 24 | 32) | (3, 32 | 64)) {
					return Err(malformed("unsupported sample format"));
				}
				let samples = file[body..end]
					.chunks_exact(frame)
					.map(|frame| {
						let sum: f64 = frame.chunks_exact(width).map(|sample| wave_sample(tag, sample)).sum();
						(sum / f64::from(channels)) as f32
					})
					.collect();
				return Ok(SpeechAudio { samples, sample_rate });
			},
			_ => {},
		}
		at = end + (size as usize % 2);
	}
	Err(malformed("no data chunk"))
}

/// One little-endian WAVE sample (`tag` 1: PCM, 3: float) as `-1.0..=1.0`.
fn wave_sample(tag: u16, sample: &[u8]) -> f64 {
	match (tag, sample) {
		(3, &[a, b, c, d]) => f64::from(f32::from_le_bytes([a, b, c, d])),
		(3, &[a, b, c, d, e, f, g, h]) => f64::from_le_bytes([a, b, c, d, e, f, g, h]),
		// 8-bit PCM is unsigned.
		(_, &[a]) => (f64::from(a) - 128.0) / 128.0,
		(_, &[a, b]) => f64::from(i16::from_le_bytes([a, b])) / 32_768.0,
		(_, &[a, b, c]) => f64::from(i32::from_le_bytes([0, a, b, c]) >> 8) / 8_388_608.0,
		(_, &[a, b, c, d]) => f64::from(i32::from_le_bytes([a, b, c, d])) / 2_147_483_648.0,
		_ => 0.0,
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn tone() -> SpeechAudio {
		SpeechAudio { samples: vec![0.0, 0.5, -0.5, 1.0], sample_rate: 24_000 }
	}

	/// Contract: `-o out.wav` is a file other programs read back as the same
	/// audio, at the requested width, rate and channel count.
	#[test]
	fn wave_files_read_back_as_the_audio_written() {
		let format = DataFormat::parse("LEI16");
		let file = encode(&tone(), Container::Wave, format, 2).expect("LEI16 fits WAVE");
		assert_eq!(le_u16(&file, 22), Some(2), "channel count");
		assert_eq!(le_u32(&file, 4), Some(file.len() as u32 - 8), "RIFF size covers the file");
		let decoded = decode_wave(&file).expect("decodes");
		assert_eq!(decoded.sample_rate, 24_000);
		let expected = [0.0, 0.5, -0.5, 1.0];
		assert_eq!(decoded.samples.len(), expected.len());
		for (got, want) in decoded.samples.iter().zip(expected) {
			assert!((got - want).abs() < 1e-3, "{got} != {want}");
		}

		let float = encode(&tone(), Container::Wave, DataFormat::parse("F32@12000"), 1).expect("float WAVE");
		let decoded = decode_wave(&float).expect("decodes");
		assert_eq!((decoded.sample_rate, decoded.samples.len()), (12_000, 2));
		assert!((decoded.samples[1] - -0.5).abs() < 1e-6);
	}

	/// Contract: the default `.aiff` is AIFF-C with big-endian 16-bit samples
	/// and an 80-bit sample rate, byte for byte what AIFF readers parse.
	#[test]
	fn aiff_files_carry_big_endian_samples_and_the_extended_rate() {
		let file = encode(&tone(), Container::Aifc, None, 1).expect("default AIFF-C");
		assert_eq!(&file[..4], b"FORM");
		assert_eq!(u32::from_be_bytes(file[4..8].try_into().unwrap()) as usize, file.len() - 8);
		assert_eq!(&file[8..12], b"AIFC");
		let comm = file.windows(4).position(|id| id == b"COMM").expect("COMM chunk") + 8;
		assert_eq!(&file[comm..comm + 2], &[0, 1], "one channel");
		assert_eq!(&file[comm + 2..comm + 6], &[0, 0, 0, 4], "four frames");
		assert_eq!(&file[comm + 6..comm + 8], &[0, 16]);
		// 24000 = 0x5DC0 << 49 with exponent 16383 + 14.
		assert_eq!(&file[comm + 8..comm + 18], &[0x40, 0x0D, 0xBB, 0x80, 0, 0, 0, 0, 0, 0]);
		assert_eq!(&file[comm + 18..comm + 22], b"NONE");
		let data = file.windows(4).position(|id| id == b"SSND").expect("SSND chunk") + 16;
		assert_eq!(&file[data..data + 8], &[0, 0, 0x40, 0, 0xC0, 0, 0x7F, 0xFF]);

		let plain = encode(&tone(), Container::Aiff, None, 1).expect("plain AIFF");
		assert_eq!(&plain[8..12], b"AIFF");
		assert!(!plain.windows(4).any(|id| id == b"FVER"), "plain AIFF has no version chunk");
	}

	/// Contract: CAF describes its samples (float flag, byte order, frame
	/// size) so little-endian floats are not read as big-endian integers.
	#[test]
	fn caf_files_describe_their_sample_layout() {
		let file = encode(&tone(), Container::Caf, DataFormat::parse("LEF32"), 1).expect("LEF32 fits CAF");
		assert_eq!(&file[..8], b"caff\x00\x01\x00\x00");
		assert_eq!(&file[20..28], &24_000f64.to_be_bytes());
		assert_eq!(&file[28..32], b"lpcm");
		assert_eq!(&file[32..36], &3u32.to_be_bytes(), "float, little-endian");
		assert_eq!(&file[36..40], &4u32.to_be_bytes(), "bytes per frame");
		assert_eq!(&file[file.len() - 4..], &1.0f32.to_le_bytes());
	}

	/// Contract: a format its container cannot hold is refused, so `say`
	/// hands it to the system converter instead of writing a corrupt file.
	#[test]
	fn formats_a_container_cannot_hold_are_refused() {
		assert!(encode(&tone(), Container::Wave, DataFormat::parse("BEI16"), 1).is_none());
		assert!(encode(&tone(), Container::Aiff, DataFormat::parse("LEF32"), 1).is_none());
		assert!(encode(&tone(), Container::Aifc, DataFormat::parse("LEI16"), 1).is_some(), "sowt");
		assert_eq!(DataFormat::parse("aac"), None);
		assert_eq!(DataFormat::parse("I12"), None);
	}

	/// Contract: the 8-bit stereo PCM some synthesizers write decodes to
	/// centered mono, and a truncated file is an error rather than silence.
	#[test]
	fn decodes_unsigned_8_bit_stereo_and_rejects_non_wave() {
		let mut file = b"RIFF\x26\0\0\0WAVEfmt \x10\0\0\0\x01\0\x02\0".to_vec();
		file.extend_from_slice(&8000u32.to_le_bytes());
		file.extend_from_slice(&16000u32.to_le_bytes());
		file.extend_from_slice(&[2, 0, 8, 0]);
		file.extend_from_slice(b"data\x02\0\0\0\xFF\x80");
		let decoded = decode_wave(&file).expect("decodes");
		assert_eq!(decoded.sample_rate, 8000);
		assert!((decoded.samples[0] - 0.496).abs() < 1e-3, "average of 0.992 and 0");
		assert!(decode_wave(b"FORM....AIFF").is_err());
	}
}
