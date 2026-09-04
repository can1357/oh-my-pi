//! QR code (ISO/IEC 18004) symbol encoding.
//!
//! Self-contained encoder: the best single segment mode is selected
//! automatically (numeric, alphanumeric, or byte), the smallest fitting
//! version 1–40 is chosen, Reed-Solomon error-correction codewords are
//! computed over GF(256), and the final mask is picked by the four spec
//! penalty rules. The output is the bare module bitmap; presentation —
//! half-block glyphs, ANSI, the four-module quiet zone — belongs to the
//! caller.

use thiserror::Error;

/// Error-correction level of a QR symbol, ordered by recovery strength.
///
/// Higher levels survive more symbol damage at the cost of a denser, larger
/// code: `L` recovers ~7% of codewords, `M` ~15%, `Q` ~25%, `H` ~30%.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum QrEc {
	/// Low: ~7% recovery, largest data capacity.
	L,
	/// Medium: ~15% recovery; the common default for URLs.
	M,
	/// Quartile: ~25% recovery.
	Q,
	/// High: ~30% recovery, densest symbol.
	H,
}

impl QrEc {
	/// Index into the per-version block tables.
	const fn index(self) -> usize {
		match self {
			Self::L => 0,
			Self::M => 1,
			Self::Q => 2,
			Self::H => 3,
		}
	}

	/// Two-bit level indicator carried by the format information.
	const fn format_bits(self) -> u32 {
		match self {
			Self::L => 0b01,
			Self::M => 0b00,
			Self::Q => 0b11,
			Self::H => 0b10,
		}
	}
}

/// Payload exceeds the capacity of the largest (version 40) symbol at the
/// requested error-correction level.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Error)]
#[error("{len}-byte payload exceeds QR version 40 capacity at level {level:?}")]
pub struct QrOverflow {
	/// Rejected payload length in bytes.
	pub len:   usize,
	/// Requested error-correction level.
	pub level: QrEc,
}

/// An encoded QR symbol: a square dark-module bitmap without the quiet zone.
///
/// [`QrCode::dark`] reads light for out-of-range coordinates, so renderers
/// may iterate a quiet-zone-inclusive grid directly.
pub struct QrCode {
	version: u8,
	dark:    Vec<bool>,
}

impl QrCode {
	/// Encodes `payload` at `level`, picking the best mode and the smallest
	/// fitting version.
	///
	/// # Errors
	/// [`QrOverflow`] when the payload exceeds version 40 capacity at
	/// `level` (2953 bytes in byte mode at [`QrEc::L`]).
	pub fn encode(payload: &[u8], level: QrEc) -> Result<Self, QrOverflow> {
		let mode = Mode::of(payload);
		let version = (1..=VERSION_MAX)
			.find(|&version| mode.encoded_bits(payload.len(), version) <= data_bits(version, level))
			.ok_or(QrOverflow { len: payload.len(), level })?;
		let codewords = codewords(payload, mode, version, level);
		Ok(Self { version, dark: Matrix::new(version).fill(&codewords, level) })
	}

	/// Symbol version (1–40).
	pub const fn version(&self) -> u8 {
		self.version
	}

	/// Modules per side, quiet zone excluded (`17 + 4 × version`).
	pub const fn side(&self) -> u16 {
		17 + 4 * self.version as u16
	}

	/// Whether the module at `(x, y)` is dark; out-of-range reads light.
	pub fn dark(&self, x: u16, y: u16) -> bool {
		let side = self.side();
		x < side && y < side && self.dark[usize::from(y) * usize::from(side) + usize::from(x)]
	}
}

const VERSION_MAX: u8 = 40;

/// Segment encoding mode; the whole payload uses one segment.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Mode {
	Numeric,
	Alphanumeric,
	Byte,
}

impl Mode {
	/// The densest mode able to carry every payload byte.
	fn of(payload: &[u8]) -> Self {
		if !payload.is_empty() && payload.iter().all(u8::is_ascii_digit) {
			Self::Numeric
		} else if !payload.is_empty() && payload.iter().all(|&byte| alnum_value(byte).is_some()) {
			Self::Alphanumeric
		} else {
			Self::Byte
		}
	}

	/// Four-bit mode indicator.
	const fn indicator(self) -> u32 {
		match self {
			Self::Numeric => 0b0001,
			Self::Alphanumeric => 0b0010,
			Self::Byte => 0b0100,
		}
	}

	/// Character-count field width for `version`.
	const fn count_bits(self, version: u8) -> usize {
		match self {
			Self::Numeric => match version {
				1..=9 => 10,
				10..=26 => 12,
				_ => 14,
			},
			Self::Alphanumeric => match version {
				1..=9 => 9,
				10..=26 => 11,
				_ => 13,
			},
			Self::Byte => match version {
				1..=9 => 8,
				_ => 16,
			},
		}
	}

	/// Bits the payload body occupies in this mode.
	const fn payload_bits(self, len: usize) -> usize {
		match self {
			Self::Numeric => 10 * (len / 3) + [0, 4, 7][len % 3],
			Self::Alphanumeric => 11 * (len / 2) + 6 * (len % 2),
			Self::Byte => 8 * len,
		}
	}

	/// Total stream bits: indicator, count field, and payload body.
	const fn encoded_bits(self, len: usize, version: u8) -> usize {
		4 + self.count_bits(version) + self.payload_bits(len)
	}
}

/// Alphanumeric-mode value of `byte`, `None` when outside the 45-character
/// set.
const fn alnum_value(byte: u8) -> Option<u16> {
	Some(match byte {
		b'0'..=b'9' => (byte - b'0') as u16,
		b'A'..=b'Z' => (byte - b'A') as u16 + 10,
		b' ' => 36,
		b'$' => 37,
		b'%' => 38,
		b'*' => 39,
		b'+' => 40,
		b'-' => 41,
		b'.' => 42,
		b'/' => 43,
		b':' => 44,
		_ => return None,
	})
}

/// Error-correction block structure for one `(version, level)` cell:
/// `(ec codewords per block, group-1 blocks, group-1 data codewords,
/// group-2 blocks, group-2 data codewords)`. ISO/IEC 18004 table 9.
type Blocks = (u8, u8, u8, u8, u8);

#[rustfmt::skip]
const BLOCKS: [[Blocks; 4]; VERSION_MAX as usize] = [
	[(7, 1, 19, 0, 0), (10, 1, 16, 0, 0), (13, 1, 13, 0, 0), (17, 1, 9, 0, 0)],
	[(10, 1, 34, 0, 0), (16, 1, 28, 0, 0), (22, 1, 22, 0, 0), (28, 1, 16, 0, 0)],
	[(15, 1, 55, 0, 0), (26, 1, 44, 0, 0), (18, 2, 17, 0, 0), (22, 2, 13, 0, 0)],
	[(20, 1, 80, 0, 0), (18, 2, 32, 0, 0), (26, 2, 24, 0, 0), (16, 4, 9, 0, 0)],
	[(26, 1, 108, 0, 0), (24, 2, 43, 0, 0), (18, 2, 15, 2, 16), (22, 2, 11, 2, 12)],
	[(18, 2, 68, 0, 0), (16, 4, 27, 0, 0), (24, 4, 19, 0, 0), (28, 4, 15, 0, 0)],
	[(20, 2, 78, 0, 0), (18, 4, 31, 0, 0), (18, 2, 14, 4, 15), (26, 4, 13, 1, 14)],
	[(24, 2, 97, 0, 0), (22, 2, 38, 2, 39), (22, 4, 18, 2, 19), (26, 4, 14, 2, 15)],
	[(30, 2, 116, 0, 0), (22, 3, 36, 2, 37), (20, 4, 16, 4, 17), (24, 4, 12, 4, 13)],
	[(18, 2, 68, 2, 69), (26, 4, 43, 1, 44), (24, 6, 19, 2, 20), (28, 6, 15, 2, 16)],
	[(20, 4, 81, 0, 0), (30, 1, 50, 4, 51), (28, 4, 22, 4, 23), (24, 3, 12, 8, 13)],
	[(24, 2, 92, 2, 93), (22, 6, 36, 2, 37), (26, 4, 20, 6, 21), (28, 7, 14, 4, 15)],
	[(26, 4, 107, 0, 0), (22, 8, 37, 1, 38), (24, 8, 20, 4, 21), (22, 12, 11, 4, 12)],
	[(30, 3, 115, 1, 116), (24, 4, 40, 5, 41), (20, 11, 16, 5, 17), (24, 11, 12, 5, 13)],
	[(22, 5, 87, 1, 88), (24, 5, 41, 5, 42), (30, 5, 24, 7, 25), (24, 11, 12, 7, 13)],
	[(24, 5, 98, 1, 99), (28, 7, 45, 3, 46), (24, 15, 19, 2, 20), (30, 3, 15, 13, 16)],
	[(28, 1, 107, 5, 108), (28, 10, 46, 1, 47), (28, 1, 22, 15, 23), (28, 2, 14, 17, 15)],
	[(30, 5, 120, 1, 121), (26, 9, 43, 4, 44), (28, 17, 22, 1, 23), (28, 2, 14, 19, 15)],
	[(28, 3, 113, 4, 114), (26, 3, 44, 11, 45), (26, 17, 21, 4, 22), (26, 9, 13, 16, 14)],
	[(28, 3, 107, 5, 108), (26, 3, 41, 13, 42), (30, 15, 24, 5, 25), (28, 15, 15, 10, 16)],
	[(28, 4, 116, 4, 117), (26, 17, 42, 0, 0), (28, 17, 22, 6, 23), (30, 19, 16, 6, 17)],
	[(28, 2, 111, 7, 112), (28, 17, 46, 0, 0), (30, 7, 24, 16, 25), (24, 34, 13, 0, 0)],
	[(30, 4, 121, 5, 122), (28, 4, 47, 14, 48), (30, 11, 24, 14, 25), (30, 16, 15, 14, 16)],
	[(30, 6, 117, 4, 118), (28, 6, 45, 14, 46), (30, 11, 24, 16, 25), (30, 30, 16, 2, 17)],
	[(26, 8, 106, 4, 107), (28, 8, 47, 13, 48), (30, 7, 24, 22, 25), (30, 22, 15, 13, 16)],
	[(28, 10, 114, 2, 115), (28, 19, 46, 4, 47), (28, 28, 22, 6, 23), (30, 33, 16, 4, 17)],
	[(30, 8, 122, 4, 123), (28, 22, 45, 3, 46), (30, 8, 23, 26, 24), (30, 12, 15, 28, 16)],
	[(30, 3, 117, 10, 118), (28, 3, 45, 23, 46), (30, 4, 24, 31, 25), (30, 11, 15, 31, 16)],
	[(30, 7, 116, 7, 117), (28, 21, 45, 7, 46), (30, 1, 23, 37, 24), (30, 19, 15, 26, 16)],
	[(30, 5, 115, 10, 116), (28, 19, 47, 10, 48), (30, 15, 24, 25, 25), (30, 23, 15, 25, 16)],
	[(30, 13, 115, 3, 116), (28, 2, 46, 29, 47), (30, 42, 24, 1, 25), (30, 23, 15, 28, 16)],
	[(30, 17, 115, 0, 0), (28, 10, 46, 23, 47), (30, 10, 24, 35, 25), (30, 19, 15, 35, 16)],
	[(30, 17, 115, 1, 116), (28, 14, 46, 21, 47), (30, 29, 24, 19, 25), (30, 11, 15, 46, 16)],
	[(30, 13, 115, 6, 116), (28, 14, 46, 23, 47), (30, 44, 24, 7, 25), (30, 59, 16, 1, 17)],
	[(30, 12, 121, 7, 122), (28, 12, 47, 26, 48), (30, 39, 24, 14, 25), (30, 22, 15, 41, 16)],
	[(30, 6, 121, 14, 122), (28, 6, 47, 34, 48), (30, 46, 24, 10, 25), (30, 2, 15, 64, 16)],
	[(30, 17, 122, 4, 123), (28, 29, 46, 14, 47), (30, 49, 24, 10, 25), (30, 24, 15, 46, 16)],
	[(30, 4, 122, 18, 123), (28, 13, 46, 32, 47), (30, 48, 24, 14, 25), (30, 42, 15, 32, 16)],
	[(30, 20, 117, 4, 118), (28, 40, 47, 7, 48), (30, 43, 24, 22, 25), (30, 10, 15, 67, 16)],
	[(30, 19, 118, 6, 119), (28, 18, 47, 31, 48), (30, 34, 24, 34, 25), (30, 20, 15, 61, 16)],
];

/// Alignment-pattern center coordinates per version (both axes).
#[rustfmt::skip]
const ALIGNMENT: [&[u8]; VERSION_MAX as usize] = [
	&[], &[6, 18], &[6, 22], &[6, 26], &[6, 30], &[6, 34],
	&[6, 22, 38], &[6, 24, 42], &[6, 26, 46], &[6, 28, 50], &[6, 30, 54],
	&[6, 32, 58], &[6, 34, 62], &[6, 26, 46, 66], &[6, 26, 48, 70],
	&[6, 26, 50, 74], &[6, 30, 54, 78], &[6, 30, 56, 82], &[6, 30, 58, 86],
	&[6, 34, 62, 90], &[6, 28, 50, 72, 94], &[6, 26, 50, 74, 98],
	&[6, 30, 54, 78, 102], &[6, 28, 54, 80, 106], &[6, 32, 58, 84, 110],
	&[6, 30, 58, 86, 114], &[6, 34, 62, 90, 118], &[6, 26, 50, 74, 98, 122],
	&[6, 30, 54, 78, 102, 126], &[6, 26, 52, 78, 104, 130],
	&[6, 30, 56, 82, 108, 134], &[6, 34, 60, 86, 112, 138],
	&[6, 30, 58, 86, 114, 142], &[6, 34, 62, 90, 118, 146],
	&[6, 30, 54, 78, 102, 126, 150], &[6, 24, 50, 76, 102, 128, 154],
	&[6, 28, 54, 80, 106, 132, 158], &[6, 32, 58, 84, 110, 136, 162],
	&[6, 26, 54, 82, 110, 138, 166], &[6, 30, 58, 86, 114, 142, 170],
];

/// Block structure for `(version, level)`.
const fn blocks(version: u8, level: QrEc) -> Blocks {
	BLOCKS[version as usize - 1][level.index()]
}

/// Data codewords available at `(version, level)`.
const fn data_codewords(version: u8, level: QrEc) -> usize {
	let (_, g1, g1_data, g2, g2_data) = blocks(version, level);
	g1 as usize * g1_data as usize + g2 as usize * g2_data as usize
}

/// Data capacity in bits at `(version, level)`.
const fn data_bits(version: u8, level: QrEc) -> usize {
	data_codewords(version, level) * 8
}

/// MSB-first bit accumulator for the data stream.
struct Bits {
	bytes: Vec<u8>,
	len:   usize,
}

impl Bits {
	fn with_capacity(codewords: usize) -> Self {
		Self { bytes: Vec::with_capacity(codewords), len: 0 }
	}

	fn push(&mut self, value: u32, count: usize) {
		for shift in (0..count).rev() {
			if self.len.is_multiple_of(8) {
				self.bytes.push(0);
			}
			let bit = (value >> shift) & 1;
			let last = self.bytes.len() - 1;
			self.bytes[last] |= u8::try_from(bit).expect("single bit") << (7 - self.len % 8);
			self.len += 1;
		}
	}
}

/// Builds the final interleaved data + error-correction codeword sequence.
fn codewords(payload: &[u8], mode: Mode, version: u8, level: QrEc) -> Vec<u8> {
	let capacity = data_codewords(version, level);
	let mut bits = Bits::with_capacity(capacity);
	bits.push(mode.indicator(), 4);
	bits.push(
		u32::try_from(payload.len()).expect("payload fits count field"),
		mode.count_bits(version),
	);
	match mode {
		Mode::Numeric => {
			for chunk in payload.chunks(3) {
				let mut value = 0u32;
				for &digit in chunk {
					value = value * 10 + u32::from(digit - b'0');
				}
				bits.push(value, [0, 4, 7, 10][chunk.len()]);
			}
		},
		Mode::Alphanumeric => {
			for pair in payload.chunks(2) {
				match pair {
					[first, second] => {
						let value = u32::from(alnum_value(*first).expect("alnum payload")) * 45
							+ u32::from(alnum_value(*second).expect("alnum payload"));
						bits.push(value, 11);
					},
					[single] => {
						bits.push(u32::from(alnum_value(*single).expect("alnum payload")), 6);
					},
					_ => unreachable!("chunks(2) yields one or two bytes"),
				}
			}
		},
		Mode::Byte => {
			for &byte in payload {
				bits.push(u32::from(byte), 8);
			}
		},
	}
	// Terminator, byte alignment, then alternating pad codewords.
	let remaining = capacity * 8 - bits.len;
	bits.push(0, remaining.min(4));
	if !bits.len.is_multiple_of(8) {
		bits.push(0, 8 - bits.len % 8);
	}
	let mut pad = [0xec_u8, 0x11].iter().copied().cycle();
	while bits.bytes.len() < capacity {
		let byte = pad.next().expect("cycle never ends");
		bits.bytes.push(byte);
	}

	interleave(&bits.bytes, version, level)
}

/// Splits data codewords into spec blocks, appends per-block Reed-Solomon
/// codewords, and interleaves both column-wise.
fn interleave(data: &[u8], version: u8, level: QrEc) -> Vec<u8> {
	let (ec_len, g1, g1_data, g2, g2_data) = blocks(version, level);
	let (ec_len, g1, g1_data, g2, g2_data) = (
		usize::from(ec_len),
		usize::from(g1),
		usize::from(g1_data),
		usize::from(g2),
		usize::from(g2_data),
	);
	let gf = Gf::new();
	let generator = gf.generator(ec_len);

	let mut data_blocks = Vec::with_capacity(g1 + g2);
	let mut offset = 0;
	for len in std::iter::repeat_n(g1_data, g1).chain(std::iter::repeat_n(g2_data, g2)) {
		data_blocks.push(&data[offset..offset + len]);
		offset += len;
	}
	debug_assert_eq!(offset, data.len(), "block table must cover every data codeword");
	let ec_blocks: Vec<Vec<u8>> = data_blocks
		.iter()
		.map(|block| gf.remainder(block, &generator))
		.collect();

	let total = data.len() + ec_len * (g1 + g2);
	let mut out = Vec::with_capacity(total);
	for index in 0..g1_data.max(g2_data) {
		for block in &data_blocks {
			if let Some(&codeword) = block.get(index) {
				out.push(codeword);
			}
		}
	}
	for index in 0..ec_len {
		for block in &ec_blocks {
			out.push(block[index]);
		}
	}
	out
}

/// GF(256) arithmetic tables for the QR polynomial `x^8+x^4+x^3+x^2+1`.
struct Gf {
	exp: [u8; 512],
	log: [u8; 256],
}

impl Gf {
	fn new() -> Self {
		let mut exp = [0u8; 512];
		let mut log = [0u8; 256];
		let mut value = 1usize;
		for power in 0..255 {
			exp[power] = u8::try_from(value).expect("GF(256) element");
			log[value] = u8::try_from(power).expect("GF(256) power");
			value <<= 1;
			if value >= 256 {
				value ^= 0x11d;
			}
		}
		for power in 255..512 {
			exp[power] = exp[power - 255];
		}
		Self { exp, log }
	}

	const fn mul(&self, a: u8, b: u8) -> u8 {
		if a == 0 || b == 0 {
			0
		} else {
			self.exp[self.log[a as usize] as usize + self.log[b as usize] as usize]
		}
	}

	/// Monic generator polynomial `(x-α^0)(x-α^1)…` of degree `ec_len`,
	/// coefficients highest-degree first.
	fn generator(&self, ec_len: usize) -> Vec<u8> {
		let mut poly = vec![1u8];
		for power in 0..ec_len {
			let root = self.exp[power];
			let mut next = vec![0u8; poly.len() + 1];
			for (index, &coefficient) in poly.iter().enumerate() {
				next[index] ^= coefficient;
				next[index + 1] ^= self.mul(coefficient, root);
			}
			poly = next;
		}
		poly
	}

	/// Remainder of `block · x^(deg g)` divided by generator `g`: the
	/// block's error-correction codewords.
	fn remainder(&self, block: &[u8], generator: &[u8]) -> Vec<u8> {
		let ec_len = generator.len() - 1;
		let mut remainder = vec![0u8; ec_len];
		for &byte in block {
			let factor = byte ^ remainder[0];
			remainder.rotate_left(1);
			remainder[ec_len - 1] = 0;
			if factor != 0 {
				for (cell, &coefficient) in remainder.iter_mut().zip(&generator[1..]) {
					*cell ^= self.mul(coefficient, factor);
				}
			}
		}
		remainder
	}
}

/// Module matrix under construction: dark bits plus a function-module map
/// protecting patterns from data placement and masking.
struct Matrix {
	size:     usize,
	dark:     Vec<bool>,
	function: Vec<bool>,
}

impl Matrix {
	/// Places every function pattern for `version`: finders, separators,
	/// timing, alignment, the dark module, version information, and the
	/// reserved format areas.
	fn new(version: u8) -> Self {
		let size = usize::from(17 + 4 * u16::from(version));
		let mut matrix =
			Self { size, dark: vec![false; size * size], function: vec![false; size * size] };
		matrix.place_finders();
		matrix.place_alignment(version);
		matrix.place_timing();
		matrix.set(8, size - 8, true); // dark module
		matrix.reserve_format();
		matrix.place_version_info(version);
		matrix
	}

	const fn index(&self, x: usize, y: usize) -> usize {
		y * self.size + x
	}

	fn set(&mut self, x: usize, y: usize, dark: bool) {
		let index = self.index(x, y);
		self.dark[index] = dark;
		self.function[index] = true;
	}

	/// Finder patterns with their light separators at three corners.
	fn place_finders(&mut self) {
		let size = self.size;
		for &(corner_x, corner_y) in &[(0usize, 0usize), (size - 7, 0), (0, size - 7)] {
			for dy in -1i32..8 {
				for dx in -1i32..8 {
					let (Ok(x), Ok(y)) =
						(usize::try_from(corner_x as i32 + dx), usize::try_from(corner_y as i32 + dy))
					else {
						continue;
					};
					if x >= size || y >= size {
						continue;
					}
					let ring = (dx - 3).abs().max((dy - 3).abs());
					self.set(x, y, ring <= 1 || ring == 3);
				}
			}
		}
	}

	/// Alignment patterns at every center pair not overlapping a finder.
	fn place_alignment(&mut self, version: u8) {
		let centers = ALIGNMENT[usize::from(version) - 1];
		let last = self.size - 7;
		for &cy in centers {
			for &cx in centers {
				let (cx, cy) = (usize::from(cx), usize::from(cy));
				let in_finder = |x: usize, y: usize| {
					(x < 9 && y < 9) || (x >= last && y < 9) || (x < 9 && y >= last)
				};
				if in_finder(cx, cy) {
					continue;
				}
				for dy in -2i32..=2 {
					for dx in -2i32..=2 {
						let x = usize::try_from(cx as i32 + dx).expect("alignment inside symbol");
						let y = usize::try_from(cy as i32 + dy).expect("alignment inside symbol");
						self.set(x, y, dx.abs().max(dy.abs()) != 1);
					}
				}
			}
		}
	}

	/// Alternating timing lines on row 6 and column 6.
	fn place_timing(&mut self) {
		for at in 0..self.size {
			for (x, y) in [(at, 6), (6, at)] {
				if !self.function[self.index(x, y)] {
					self.set(x, y, at % 2 == 0);
				}
			}
		}
	}

	/// Marks both format-information copies as function modules; their bits
	/// are written per candidate mask.
	fn reserve_format(&mut self) {
		for (a, b) in format_positions(self.size) {
			self.set(a.0, a.1, false);
			self.set(b.0, b.1, false);
		}
	}

	/// Version information blocks for symbols of version 7 and above.
	fn place_version_info(&mut self, version: u8) {
		if version < 7 {
			return;
		}
		let bits = version_bits(version);
		let anchor = self.size - 11;
		for index in 0..18 {
			let dark = (bits >> index) & 1 == 1;
			let (short, long) = (index % 3, index / 3);
			self.set(long, anchor + short, dark);
			self.set(anchor + short, long, dark);
		}
	}

	/// Zigzag data placement, then mask selection by minimum penalty.
	fn fill(mut self, codewords: &[u8], level: QrEc) -> Vec<bool> {
		self.place_data(codewords);
		let mut best: Option<(u32, Vec<bool>)> = None;
		for mask in 0..8u8 {
			let mut candidate = self.dark.clone();
			for y in 0..self.size {
				for x in 0..self.size {
					let index = self.index(x, y);
					if !self.function[index] && mask_hit(mask, x, y) {
						candidate[index] = !candidate[index];
					}
				}
			}
			write_format(&mut candidate, self.size, level, mask);
			let score = penalty(&candidate, self.size);
			if best.as_ref().is_none_or(|(least, _)| score < *least) {
				best = Some((score, candidate));
			}
		}
		best.expect("eight masks always evaluated").1
	}

	/// Places codeword bits (MSB first) through the two-column zigzag,
	/// leaving surplus remainder modules light.
	fn place_data(&mut self, codewords: &[u8]) {
		let total_bits = codewords.len() * 8;
		let mut bit = 0usize;
		let mut x = self.size - 1;
		let mut upward = true;
		loop {
			for step in 0..self.size {
				let y = if upward { self.size - 1 - step } else { step };
				for column in [x, x - 1] {
					let index = self.index(column, y);
					if self.function[index] {
						continue;
					}
					if bit < total_bits {
						self.dark[index] = (codewords[bit / 8] >> (7 - bit % 8)) & 1 == 1;
					}
					bit += 1;
				}
			}
			upward = !upward;
			if x == 1 {
				break;
			}
			x -= 2;
			if x == 6 {
				x -= 1; // the vertical timing column is skipped entirely
			}
		}
		debug_assert!(
			bit >= total_bits && bit - total_bits < 8,
			"free modules must equal codeword bits plus 0..8 remainder bits"
		);
	}
}

/// Whether spec mask `mask` inverts the data module at `(x, y)`.
const fn mask_hit(mask: u8, x: usize, y: usize) -> bool {
	let (r, c) = (y, x);
	match mask {
		0 => (r + c) % 2 == 0,
		1 => r % 2 == 0,
		2 => c % 3 == 0,
		3 => (r + c) % 3 == 0,
		4 => (r / 2 + c / 3) % 2 == 0,
		5 => (r * c) % 2 + (r * c) % 3 == 0,
		6 => ((r * c) % 2 + (r * c) % 3) % 2 == 0,
		7 => ((r + c) % 2 + (r * c) % 3) % 2 == 0,
		_ => unreachable!(),
	}
}

/// Both placements of format bit `i` (0 = most significant of 15), as
/// `((x, y) near the top-left finder, (x, y) split across the other two)`.
fn format_positions(size: usize) -> [((usize, usize), (usize, usize)); 15] {
	std::array::from_fn(|i| {
		let near = match i {
			0..=5 => (i, 8),
			6 => (7, 8),
			7 => (8, 8),
			8 => (8, 7),
			_ => (8, 14 - i),
		};
		let far = if i < 7 {
			(8, size - 1 - i)
		} else {
			(size - 15 + i, 8)
		};
		(near, far)
	})
}

/// The 15-bit format sequence for `(level, mask)`: BCH(15,5) protected and
/// XOR-masked per spec.
const fn format_value(level: QrEc, mask: u8) -> u32 {
	let data = (level.format_bits() << 3) | mask as u32;
	let mut remainder = data << 10;
	let mut shift = 5usize;
	while shift > 0 {
		shift -= 1;
		if (remainder >> (10 + shift)) & 1 == 1 {
			remainder ^= 0x537 << shift;
		}
	}
	((data << 10) | remainder) ^ 0x5412
}

/// Writes both format-information copies into a finished candidate bitmap.
fn write_format(dark: &mut [bool], size: usize, level: QrEc, mask: u8) {
	let value = format_value(level, mask);
	for (i, (near, far)) in format_positions(size).into_iter().enumerate() {
		let bit = (value >> (14 - i)) & 1 == 1;
		dark[near.1 * size + near.0] = bit;
		dark[far.1 * size + far.0] = bit;
	}
}

/// The 18-bit version-information sequence: 6 version bits plus a 12-bit
/// Golay remainder.
const fn version_bits(version: u8) -> u32 {
	let mut remainder = (version as u32) << 12;
	let mut shift = 6usize;
	while shift > 0 {
		shift -= 1;
		if (remainder >> (12 + shift)) & 1 == 1 {
			remainder ^= 0x1f25 << shift;
		}
	}
	((version as u32) << 12) | remainder
}

/// Spec penalty score of a candidate bitmap (rules N1–N4, lower is better).
fn penalty(dark: &[bool], size: usize) -> u32 {
	let at = |x: usize, y: usize| dark[y * size + x];
	let mut score = 0u32;

	// N1: runs of five or more same-colored modules per row and column.
	for line in 0..size {
		let mut run_row = 1u32;
		let mut run_col = 1u32;
		for step in 1..size {
			for (run, same) in [
				(&mut run_row, at(step, line) == at(step - 1, line)),
				(&mut run_col, at(line, step) == at(line, step - 1)),
			] {
				if same {
					*run += 1;
					score += match *run {
						5 => 3,
						6.. => 1,
						_ => 0,
					};
				} else {
					*run = 1;
				}
			}
		}
	}

	// N2: every 2×2 block of one color.
	for y in 0..size - 1 {
		for x in 0..size - 1 {
			let color = at(x, y);
			if at(x + 1, y) == color && at(x, y + 1) == color && at(x + 1, y + 1) == color {
				score += 3;
			}
		}
	}

	// N3: finder-like 1:1:3:1:1 runs with a four-module light margin.
	const NEEDLE: [bool; 7] = [true, false, true, true, true, false, true];
	let light4 = |cells: [bool; 4]| cells.iter().all(|&cell| !cell);
	for line in 0..size {
		for start in 0..size.saturating_sub(10) {
			for horizontal in [true, false] {
				let cell = |offset: usize| {
					if horizontal {
						at(start + offset, line)
					} else {
						at(line, start + offset)
					}
				};
				let window: [bool; 11] = std::array::from_fn(cell);
				let leading: [bool; 4] = std::array::from_fn(|i| window[i]);
				let trailing: [bool; 4] = std::array::from_fn(|i| window[7 + i]);
				let head = window[..7] == NEEDLE && light4(trailing);
				let tail = window[4..] == NEEDLE && light4(leading);
				if head || tail {
					score += 40;
				}
			}
		}
	}

	// N4: deviation of the dark-module proportion from 50%.
	let dark_count = dark.iter().filter(|&&cell| cell).count();
	let percent = dark_count * 100 / dark.len();
	let deviation = percent.abs_diff(50);
	score + u32::try_from(deviation / 5).expect("small deviation") * 10
}

#[cfg(test)]
mod tests {
	use super::*;

	/// Free (non-function) modules of a bare function-pattern matrix.
	fn free_modules(version: u8) -> usize {
		let matrix = Matrix::new(version);
		matrix
			.function
			.iter()
			.filter(|&&function| !function)
			.count()
	}

	#[test]
	fn block_table_is_consistent_across_levels_and_matrix_capacity() {
		for version in 1..=VERSION_MAX {
			let totals: Vec<usize> = [QrEc::L, QrEc::M, QrEc::Q, QrEc::H]
				.into_iter()
				.map(|level| {
					let (ec, g1, _, g2, _) = blocks(version, level);
					data_codewords(version, level)
						+ usize::from(ec) * (usize::from(g1) + usize::from(g2))
				})
				.collect();
			assert!(
				totals.iter().all(|&total| total == totals[0]),
				"v{version}: level totals disagree: {totals:?}"
			);
			let free = free_modules(version);
			assert_eq!(totals[0], free / 8, "v{version}: table total vs matrix capacity");
			assert!(free % 8 < 8, "v{version}: remainder bits out of range");
		}
	}

	#[test]
	fn known_capacities_hold() {
		assert_eq!(data_codewords(1, QrEc::L), 19);
		assert_eq!(data_codewords(1, QrEc::M), 16);
		assert_eq!(data_codewords(1, QrEc::Q), 13);
		assert_eq!(data_codewords(1, QrEc::H), 9);
		// Version 40-L byte capacity is the canonical 2953 bytes.
		let max = vec![b'x'; 2953];
		assert_eq!(QrCode::encode(&max, QrEc::L).expect("fits v40").version(), 40);
		let over = vec![b'x'; 2954];
		let Err(err) = QrCode::encode(&over, QrEc::L) else {
			panic!("one byte past capacity must overflow");
		};
		assert_eq!(err, QrOverflow { len: 2954, level: QrEc::L });
	}

	#[test]
	fn dense_modes_pick_smaller_versions() {
		let digits = "8675309867530986753098675309867530986753".as_bytes();
		let numeric = QrCode::encode(digits, QrEc::M).expect("numeric");
		let byte = QrCode::encode(&digits.iter().map(|&d| d | 0x60).collect::<Vec<_>>(), QrEc::M)
			.expect("byte");
		assert!(numeric.version() < byte.version(), "numeric mode must beat byte mode");
	}

	#[test]
	fn version1_symbol_has_spec_structure() {
		let code = QrCode::encode(b"HELLO WORLD", QrEc::Q).expect("v1 alnum");
		assert_eq!(code.version(), 1);
		assert_eq!(code.side(), 21);
		// Finder centers dark, separator light, timing alternates.
		for (x, y) in [(3, 3), (17, 3), (3, 17)] {
			assert!(code.dark(x, y), "finder center ({x},{y})");
		}
		assert!(!code.dark(7, 7), "separator corner");
		for x in 8..13u16 {
			assert_eq!(code.dark(x, 6), x % 2 == 0, "timing row at {x}");
		}
		assert!(code.dark(8, 21 - 8), "dark module");
	}

	#[test]
	fn format_information_survives_bch_check() {
		for level in [QrEc::L, QrEc::M, QrEc::Q, QrEc::H] {
			let code = QrCode::encode(b"format check", level).expect("encode");
			let size = usize::from(code.side());
			// Read the top-left copy back, unmask, and verify the BCH residue.
			let mut value = 0u32;
			for (i, (near, _)) in format_positions(size).into_iter().enumerate() {
				let x = u16::try_from(near.0).expect("in range");
				let y = u16::try_from(near.1).expect("in range");
				value |= u32::from(code.dark(x, y)) << (14 - i);
			}
			let unmasked = value ^ 0x5412;
			let mut residue = unmasked;
			for shift in (0..5).rev() {
				if (residue >> (10 + shift)) & 1 == 1 {
					residue ^= 0x537 << shift;
				}
			}
			assert_eq!(residue & 0x3ff, 0, "format BCH residue for {level:?}");
			assert_eq!((unmasked >> 13) & 0b11, level.format_bits(), "level bits for {level:?}");
		}
	}

	#[test]
	fn version_information_matches_known_value() {
		// ISO/IEC 18004 annex example: version 7 encodes as 0x07C94.
		assert_eq!(version_bits(7), 0x07c94);
	}

	/// `1`/`0` module rows joined by `\n`, the serialization hashed by the
	/// external conformance sweep.
	fn matrix_text(code: &QrCode) -> String {
		let side = code.side();
		let mut text = String::with_capacity(usize::from(side) * (usize::from(side) + 1));
		for y in 0..side {
			if y > 0 {
				text.push('\n');
			}
			for x in 0..side {
				text.push(if code.dark(x, y) { '1' } else { '0' });
			}
		}
		text
	}

	/// Digests pinned by an external sweep that decoded these exact symbols
	/// (and 88 sibling cases across versions 1–40, all levels and modes)
	/// with the zxing scanner stack. A mismatch means the encoder no longer
	/// produces the externally verified matrix — not a formatting nit.
	#[test]
	fn symbols_match_scanner_verified_goldens() {
		let cases: [(&[u8], QrEc, u8, &str); 3] = [
			(
				b"https://omp.sh",
				QrEc::M,
				1,
				"aca4834323ccefa0e90783d505b73ebe95ce26b6e443648cd01cc8db375122b3",
			),
			(
				b"HELLO WORLD",
				QrEc::Q,
				1,
				"453d0cc77a27d60d29801fcff544b4230f4e83183ac83d8ea4836c75c67f2ae5",
			),
			(
				b"omp-qr-conformance-vector: !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~!\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~!\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~",
				QrEc::H,
				18,
				"0eb448860e83230b84297c83b8bf303accfaf72cf64afb708bd6e5fe7b4d4fdb",
			),
		];
		for (payload, level, version, digest) in cases {
			let code = QrCode::encode(payload, level).expect("golden payload encodes");
			assert_eq!(code.version(), version, "golden version for {level:?}");
			assert_eq!(
				crate::Hash32::sum(matrix_text(&code)).to_hex().as_str(),
				digest,
				"scanner-verified golden for {level:?} v{version}"
			);
		}
	}
}
