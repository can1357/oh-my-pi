//! Minimal GGUF v3 reader (llama.cpp's weights format): header, metadata
//! (only `general.alignment` and `general.architecture` are kept), tensor
//! infos, and aligned tensor data, read one tensor at a time so loading never
//! holds more than one tensor's bytes. Only the element types the decoders
//! run on are decoded: F32 and 8-bit `Q8_0` blocks.

use std::{
	collections::HashMap,
	fs::File,
	io::{BufReader, Read, Seek, SeekFrom},
	path::Path,
};

use anyhow::{Context, bail, ensure};

const MAGIC: &[u8; 4] = b"GGUF";
const VERSION: u32 = 3;
/// Data alignment when the file has no `general.alignment`.
const DEFAULT_ALIGNMENT: u64 = 32;
/// Longest key, string value kept, or tensor name accepted.
const MAX_NAME: u64 = 1 << 16;
/// Deepest nesting of metadata arrays accepted.
const MAX_ARRAY_DEPTH: u32 = 8;
/// `GGML_MAX_DIMS`.
const MAX_DIMS: u32 = 4;

/// Metadata value types.
const TYPE_U32: u32 = 4;
const TYPE_STRING: u32 = 8;
const TYPE_ARRAY: u32 = 9;

/// ggml tensor types.
const GGML_F32: u32 = 0;
const GGML_Q8_0: u32 = 8;

/// Weights per `Q8_0` block.
pub const Q8_BLOCK: usize = 32;
/// Bytes per `Q8_0` block: an f16 scale then [`Q8_BLOCK`] `i8` quants.
pub const Q8_BLOCK_BYTES: usize = 2 + Q8_BLOCK;

/// Row-major matrix of GGUF `Q8_0` blocks: each run of [`Q8_BLOCK`] weights
/// along a row is an f16 scale (little-endian) then the `i8` quants, weight
/// `= scale · quant`.
pub struct Q8Blocks {
	pub rows:  usize,
	pub cols:  usize,
	pub bytes: Vec<u8>,
}

impl Q8Blocks {
	/// Bytes of one row.
	pub const fn row_bytes(cols: usize) -> usize {
		cols / Q8_BLOCK * Q8_BLOCK_BYTES
	}

	/// `(scale, quants)` of every block, row-major.
	pub fn blocks(&self) -> impl Iterator<Item = (f32, [i8; Q8_BLOCK])> + '_ {
		self
			.bytes
			.as_chunks::<Q8_BLOCK_BYTES>()
			.0
			.iter()
			.map(|block| {
				let scale = f16_to_f32(u16::from_le_bytes([block[0], block[1]]));
				(scale, std::array::from_fn(|i| block[2 + i].cast_signed()))
			})
	}
}

/// IEEE 754 half → f32 (exact).
pub fn f16_to_f32(bits: u16) -> f32 {
	let sign = if bits & 0x8000 == 0 { 1.0 } else { -1.0 };
	let exponent = u32::from(bits >> 10) & 0x1f;
	let mantissa = u32::from(bits & 0x3ff);
	sign
		* match exponent {
			// Zero and subnormals: mantissa · 2⁻²⁴.
			0 => mantissa as f32 / (1u32 << 24) as f32,
			0x1f => f32::from_bits(0x7f80_0000 | (mantissa << 13)),
			_ => f32::from_bits(((exponent + 112) << 23) | (mantissa << 13)),
		}
}

fn type_name(kind: u32) -> String {
	match kind {
		GGML_F32 => "F32".into(),
		1 => "F16".into(),
		GGML_Q8_0 => "Q8_0".into(),
		30 => "BF16".into(),
		other => format!("ggml type {other}"),
	}
}

struct TensorInfo {
	/// Dimensions, innermost (contiguous) first.
	dims:   Vec<u64>,
	kind:   u32,
	/// Offset from the start of the data section.
	offset: u64,
}

/// An open GGUF file.
pub struct Gguf<R> {
	reader:       BufReader<R>,
	data_start:   u64,
	data_len:     u64,
	tensors:      HashMap<String, TensorInfo>,
	architecture: Option<String>,
}

impl Gguf<File> {
	/// Open and index `path`.
	///
	/// # Errors
	/// Fails for unreadable or malformed files.
	pub fn open(path: &Path) -> anyhow::Result<Self> {
		let file = File::open(path).with_context(|| format!("open {}", path.display()))?;
		Self::new(file).with_context(|| format!("read {}", path.display()))
	}
}

impl<R: Read + Seek> Gguf<R> {
	/// Parse the header, metadata, and tensor infos of `reader`.
	///
	/// # Errors
	/// Fails for malformed or truncated files and versions other than 3.
	pub fn new(reader: R) -> anyhow::Result<Self> {
		let mut reader = BufReader::new(reader);
		let mut magic = [0u8; 4];
		reader.read_exact(&mut magic).context("GGUF magic")?;
		ensure!(&magic == MAGIC, "not a GGUF file");
		let version = read_u32(&mut reader)?;
		ensure!(version == VERSION, "unsupported GGUF version {version}");
		let tensor_count = read_u64(&mut reader)?;
		let kv_count = read_u64(&mut reader)?;
		ensure!(tensor_count < 1 << 20 && kv_count < 1 << 20, "implausible GGUF header counts");

		let mut alignment = DEFAULT_ALIGNMENT;
		let mut architecture = None;
		for _ in 0..kv_count {
			let key = read_string(&mut reader)?;
			let kind = read_u32(&mut reader)?;
			match (key.as_str(), kind) {
				("general.alignment", TYPE_U32) => {
					alignment = u64::from(read_u32(&mut reader)?);
					ensure!(alignment.is_power_of_two(), "invalid general.alignment {alignment}");
				},
				("general.alignment", _) => bail!("general.alignment must be a u32"),
				("general.architecture", TYPE_STRING) => {
					architecture = Some(read_string(&mut reader)?);
				},
				_ => skip_value(&mut reader, kind, 0).with_context(|| format!("metadata {key}"))?,
			}
		}

		let mut tensors = HashMap::with_capacity(tensor_count as usize);
		for _ in 0..tensor_count {
			let name = read_string(&mut reader)?;
			let rank = read_u32(&mut reader)?;
			ensure!(rank <= MAX_DIMS, "tensor {name}: {rank} dimensions");
			let dims = (0..rank)
				.map(|_| read_u64(&mut reader))
				.collect::<anyhow::Result<Vec<_>>>()?;
			let kind = read_u32(&mut reader)?;
			let offset = read_u64(&mut reader)?;
			ensure!(offset.is_multiple_of(alignment), "tensor {name}: misaligned data");
			ensure!(
				tensors
					.insert(name.clone(), TensorInfo { dims, kind, offset })
					.is_none(),
				"duplicate tensor {name}"
			);
		}
		let data_start = reader.stream_position()?.next_multiple_of(alignment);
		// Tensor reads check their extent against this.
		let data_len = reader.seek(SeekFrom::End(0))?.saturating_sub(data_start);
		Ok(Self { reader, data_start, data_len, tensors, architecture })
	}

	/// `general.architecture`, when present.
	pub fn architecture(&self) -> Option<&str> {
		self.architecture.as_deref()
	}

	/// Check that `name` is a `kind` tensor with `dims` (innermost first) and
	/// return its data offset and size.
	fn locate(&self, name: &str, kind: u32, dims: &[usize]) -> anyhow::Result<(u64, usize)> {
		let info = self
			.tensors
			.get(name)
			.with_context(|| format!("tensor {name} missing from weights"))?;
		ensure!(
			info.kind == kind,
			"tensor {name}: {}, expected {}",
			type_name(info.kind),
			type_name(kind)
		);
		ensure!(
			info.dims.len() == dims.len() && info.dims.iter().zip(dims).all(|(&a, &b)| a == b as u64),
			"tensor {name}: shape {:?}, expected {:?} (innermost first)",
			info.dims,
			dims
		);
		let count: usize = dims.iter().product();
		let bytes = match kind {
			GGML_F32 => count * 4,
			GGML_Q8_0 => count / Q8_BLOCK * Q8_BLOCK_BYTES,
			other => bail!("tensor {name}: unsupported {}", type_name(other)),
		};
		ensure!(
			info
				.offset
				.checked_add(bytes as u64)
				.is_some_and(|end| end <= self.data_len),
			"tensor {name}: data past the end of the file"
		);
		Ok((info.offset, bytes))
	}

	fn read_at(&mut self, name: &str, offset: u64, out: &mut [u8]) -> anyhow::Result<()> {
		self
			.reader
			.seek(SeekFrom::Start(self.data_start + offset))?;
		self
			.reader
			.read_exact(out)
			.with_context(|| format!("read tensor {name}"))
	}

	/// F32 vector `name` of `len` values.
	///
	/// # Errors
	/// Fails for missing tensors, other types or shapes, and I/O errors.
	pub fn f32(&mut self, name: &str, len: usize) -> anyhow::Result<Vec<f32>> {
		let (offset, bytes) = self.locate(name, GGML_F32, &[len])?;
		let mut raw = vec![0u8; bytes];
		self.read_at(name, offset, &mut raw)?;
		Ok(raw
			.as_chunks::<4>()
			.0
			.iter()
			.map(|b| f32::from_le_bytes(*b))
			.collect())
	}

	/// `Q8_0` matrix `name` of `rows × cols` (blocks along rows) into `out`,
	/// which must hold exactly its bytes.
	///
	/// # Errors
	/// Fails for missing tensors, other types or shapes, non-finite scales,
	/// and I/O errors.
	pub fn q8_0_into(
		&mut self,
		name: &str,
		rows: usize,
		cols: usize,
		out: &mut [u8],
	) -> anyhow::Result<()> {
		ensure!(cols.is_multiple_of(Q8_BLOCK), "tensor {name}: rows are not whole Q8_0 blocks");
		let (offset, bytes) = self.locate(name, GGML_Q8_0, &[cols, rows])?;
		ensure!(out.len() == bytes, "tensor {name}: destination of {} bytes", out.len());
		self.read_at(name, offset, out)?;
		ensure!(
			out.as_chunks::<Q8_BLOCK_BYTES>()
				.0
				.iter()
				.all(|block| f16_to_f32(u16::from_le_bytes([block[0], block[1]])).is_finite()),
			"tensor {name}: non-finite block scale"
		);
		Ok(())
	}
}

fn read_u32(reader: &mut impl Read) -> anyhow::Result<u32> {
	let mut bytes = [0u8; 4];
	reader.read_exact(&mut bytes).context("truncated GGUF")?;
	Ok(u32::from_le_bytes(bytes))
}

fn read_u64(reader: &mut impl Read) -> anyhow::Result<u64> {
	let mut bytes = [0u8; 8];
	reader.read_exact(&mut bytes).context("truncated GGUF")?;
	Ok(u64::from_le_bytes(bytes))
}

fn read_string(reader: &mut impl Read) -> anyhow::Result<String> {
	let len = read_u64(reader)?;
	ensure!(len <= MAX_NAME, "GGUF string of {len} bytes");
	let mut bytes = vec![0u8; len as usize];
	reader.read_exact(&mut bytes).context("truncated GGUF")?;
	String::from_utf8(bytes).context("GGUF string is not UTF-8")
}

fn skip<R: Read + Seek>(reader: &mut BufReader<R>, bytes: u64) -> anyhow::Result<()> {
	reader.seek_relative(i64::try_from(bytes).context("GGUF value too large")?)?;
	Ok(())
}

/// Skip one metadata value of `kind`.
fn skip_value<R: Read + Seek>(
	reader: &mut BufReader<R>,
	kind: u32,
	depth: u32,
) -> anyhow::Result<()> {
	let width = match kind {
		// u8, i8, bool
		0 | 1 | 7 => 1,
		// u16, i16
		2 | 3 => 2,
		// u32, i32, f32
		4..=6 => 4,
		// u64, i64, f64
		10..=12 => 8,
		TYPE_STRING => {
			let len = read_u64(reader)?;
			return skip(reader, len);
		},
		TYPE_ARRAY => {
			ensure!(depth < MAX_ARRAY_DEPTH, "GGUF arrays nested too deeply");
			let element = read_u32(reader)?;
			let count = read_u64(reader)?;
			if matches!(element, TYPE_STRING | TYPE_ARRAY) {
				for _ in 0..count {
					skip_value(reader, element, depth + 1)?;
				}
				return Ok(());
			}
			let width = match element {
				0 | 1 | 7 => 1,
				2 | 3 => 2,
				4..=6 => 4,
				10..=12 => 8,
				other => bail!("unknown GGUF value type {other}"),
			};
			return skip(reader, count.checked_mul(width).context("GGUF array too large")?);
		},
		other => bail!("unknown GGUF value type {other}"),
	};
	skip(reader, width)
}

#[cfg(test)]
pub(super) mod tests {
	use super::*;

	/// Assembles GGUF v3 files in memory.
	pub struct Writer {
		alignment: u64,
		kv_count:  u64,
		metadata:  Vec<u8>,
		tensors:   Vec<(String, Vec<u64>, u32, Vec<u8>)>,
	}

	fn put_string(out: &mut Vec<u8>, text: &str) {
		out.extend((text.len() as u64).to_le_bytes());
		out.extend(text.as_bytes());
	}

	impl Writer {
		/// `alignment` is written as `general.alignment` when set.
		pub fn new(alignment: Option<u32>) -> Self {
			let mut writer = Self {
				alignment: DEFAULT_ALIGNMENT,
				kv_count:  0,
				metadata:  Vec::new(),
				tensors:   Vec::new(),
			};
			if let Some(alignment) = alignment {
				writer.alignment = u64::from(alignment);
				writer.raw("general.alignment", TYPE_U32, &alignment.to_le_bytes());
			}
			writer
		}

		/// One metadata pair with a pre-encoded value.
		pub fn raw(&mut self, key: &str, kind: u32, value: &[u8]) {
			put_string(&mut self.metadata, key);
			self.metadata.extend(kind.to_le_bytes());
			self.metadata.extend(value);
			self.kv_count += 1;
		}

		pub fn string(&mut self, key: &str, value: &str) {
			let mut encoded = Vec::new();
			put_string(&mut encoded, value);
			self.raw(key, TYPE_STRING, &encoded);
		}

		/// Metadata of every value shape the reader must skip.
		pub fn noise(&mut self) {
			self.raw("test.u8", 0, &[7]);
			self.raw("test.f64", 12, &1.5f64.to_le_bytes());
			self.string("test.name", "tiny");
			let mut strings = Vec::new();
			strings.extend(TYPE_STRING.to_le_bytes());
			strings.extend(2u64.to_le_bytes());
			put_string(&mut strings, "a");
			put_string(&mut strings, "bc");
			self.raw("test.strings", TYPE_ARRAY, &strings);
			let mut nested = Vec::new();
			nested.extend(TYPE_ARRAY.to_le_bytes());
			nested.extend(1u64.to_le_bytes());
			nested.extend(5u32.to_le_bytes());
			nested.extend(3u64.to_le_bytes());
			for value in [1i32, -2, 3] {
				nested.extend(value.to_le_bytes());
			}
			self.raw("test.nested", TYPE_ARRAY, &nested);
		}

		pub fn f32(&mut self, name: &str, values: &[f32]) {
			let bytes = values.iter().flat_map(|v| v.to_le_bytes()).collect();
			self
				.tensors
				.push((name.into(), vec![values.len() as u64], GGML_F32, bytes));
		}

		/// `Q8_0` blocks of a row-major `rows × cols` matrix.
		pub fn q8_0(&mut self, name: &str, rows: usize, cols: usize, bytes: Vec<u8>) {
			assert_eq!(bytes.len(), rows * Q8Blocks::row_bytes(cols));
			self
				.tensors
				.push((name.into(), vec![cols as u64, rows as u64], GGML_Q8_0, bytes));
		}

		pub fn finish(self) -> Vec<u8> {
			let mut out = Vec::new();
			out.extend(MAGIC);
			out.extend(VERSION.to_le_bytes());
			out.extend((self.tensors.len() as u64).to_le_bytes());
			out.extend(self.kv_count.to_le_bytes());
			out.extend(self.metadata);
			let mut offset = 0u64;
			for (name, dims, kind, bytes) in &self.tensors {
				put_string(&mut out, name);
				out.extend((dims.len() as u32).to_le_bytes());
				for dim in dims {
					out.extend(dim.to_le_bytes());
				}
				out.extend(kind.to_le_bytes());
				out.extend(offset.to_le_bytes());
				offset = (offset + bytes.len() as u64).next_multiple_of(self.alignment);
			}
			for (_, _, _, bytes) in &self.tensors {
				out.resize((out.len() as u64).next_multiple_of(self.alignment) as usize, 0);
				out.extend(bytes);
			}
			out
		}
	}

	/// f16 bits of a positive normal `value` (mantissa truncated).
	pub fn f16_bits(value: f32) -> u16 {
		let bits = value.to_bits();
		let exponent = ((bits >> 23) & 0xff) as i32 - 127 + 15;
		assert!((1..31).contains(&exponent), "{value} is not a normal f16");
		((exponent as u16) << 10) | ((bits >> 13) & 0x3ff) as u16
	}

	#[test]
	fn f16_widening_is_exact() {
		for (bits, value) in [
			(0x3c00, 1.0),
			(0xc000, -2.0),
			(0x3555, 0.333_251_95),
			(0x0001, 5.960_464_5e-8),
			(0x03ff, 6.097_555e-5),
			(0x7bff, 65504.0),
			(0x8000, -0.0),
		] {
			assert_eq!(f16_to_f32(bits).to_bits(), f32::to_bits(value), "{bits:#06x}");
		}
		assert!(f16_to_f32(0x7c00).is_infinite() && f16_to_f32(0x7e00).is_nan());
	}
}
