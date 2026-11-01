//! Integer, string, and file-index codecs of the rsync wire protocol.
//!
//! Every multi-byte integer is little-endian. Besides the fixed-width forms
//! (`shortint`, `int`, `longint`) protocol 30 introduced variable-length
//! integers whose first byte announces, through its count of leading one bits,
//! how many further bytes follow; the remaining low bits of that first byte
//! carry the most significant part of the value.

use std::fmt;
use std::io::{self, Read, Write};

use crate::rsync::consts::NDX_DONE;
use crate::rsync::exit::{RERR_PROTOCOL, RERR_STREAMIO};
use crate::rsync::log::Role;

/// Negotiated protocol facts every codec consults.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Proto {
	pub version: u32,
	pub compat: u32,
}

impl Proto {
	/// A protocol description from its version and `CF_*` compatibility flags.
	#[cfg(test)]
	pub(crate) const fn new(version: u32, compat: u32) -> Self {
		Self { version, compat }
	}

	/// Whether the negotiated compatibility flags include `cf`.
	pub(crate) const fn has(self, cf: u32) -> bool {
		self.compat & cf != 0
	}
}

/// The diagnostic attached (as the inner error) to every io::Error raised by
/// the wire layers: upstream's exact message (no trailing newline), the exit
/// code it ends the run with, and the upstream exit site for the trailer.
#[derive(Debug)]
pub(crate) struct WireError {
	pub code: i32,
	pub message: String,
	pub site: Option<(&'static str, u32)>,
}

impl fmt::Display for WireError {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		f.write_str(&self.message)
	}
}

impl std::error::Error for WireError {}

/// Builds an io::Error of `kind` carrying a [`WireError`].
pub(crate) fn wire_error(
	kind: io::ErrorKind,
	code: i32,
	message: impl Into<String>,
	site: Option<(&'static str, u32)>,
) -> io::Error {
	io::Error::new(kind, WireError { code, message: message.into(), site })
}

/// The [`WireError`] inside `err`, if the wire layers produced it.
pub(crate) fn wire_detail(err: &io::Error) -> Option<&WireError> {
	err.get_ref().and_then(|inner| inner.downcast_ref::<WireError>())
}

/// Recreates an equivalent io::Error (io::Error is not Clone).
pub(crate) fn clone_io_error(err: &io::Error) -> io::Error {
	match wire_detail(err) {
		Some(w) => wire_error(err.kind(), w.code, w.message.clone(), w.site),
		None => match err.raw_os_error() {
			Some(errno) => io::Error::from_raw_os_error(errno),
			None => match err.get_ref() {
				Some(inner) => io::Error::new(err.kind(), inner.to_string()),
				None => io::Error::from(err.kind()),
			},
		},
	}
}

/// `Interrupted` only ever means a raw `EINTR` (cancellation is reported with
/// another kind), so it is retried.
pub(crate) fn is_retryable(err: &io::Error) -> bool {
	err.kind() == io::ErrorKind::Interrupted
}

/// Reads exactly `buf.len()` bytes; EOF first is `UnexpectedEof`.
pub(crate) fn fill<R: Read + ?Sized>(r: &mut R, mut buf: &mut [u8]) -> io::Result<()> {
	while !buf.is_empty() {
		match r.read(buf) {
			Ok(0) => return Err(io::ErrorKind::UnexpectedEof.into()),
			Ok(n) => {
				let n = n.min(buf.len());
				buf = &mut buf[n..];
			}
			Err(e) if is_retryable(&e) => {}
			Err(e) => return Err(e),
		}
	}
	Ok(())
}

/// Writes all of `buf`.
pub(crate) fn put<W: Write + ?Sized>(w: &mut W, mut buf: &[u8]) -> io::Result<()> {
	while !buf.is_empty() {
		match w.write(buf) {
			Ok(0) => return Err(io::ErrorKind::WriteZero.into()),
			Ok(n) => buf = &buf[n.min(buf.len())..],
			Err(e) if is_retryable(&e) => {}
			Err(e) => return Err(e),
		}
	}
	Ok(())
}

/// Number of bytes following a variable-length integer's lead byte.
fn extra_bytes(lead: u8) -> usize {
	(lead.leading_ones() as usize).min(6)
}

/// Mask selecting the value bits left in a lead byte announcing `extra` bytes.
fn lead_mask(extra: usize) -> u8 {
	((1u16 << (8 - extra)) - 1) as u8
}

/// Encodes the little-endian value bytes `le` with at least `min_bytes` bytes
/// of payload (lead byte included); returns the encoded length in `out`.
fn encode_var(le: &[u8], min_bytes: usize, out: &mut [u8; 9]) -> usize {
	let mut cnt = le.len();
	while cnt > min_bytes && le[cnt - 1] == 0 {
		cnt -= 1;
	}
	let top = le[cnt - 1];
	let bit = 1u32 << (7 - (cnt - min_bytes));
	if u32::from(top) >= bit {
		// The top byte does not fit beside the length marker: emit it whole.
		out[0] = !(bit - 1) as u8;
		out[1..=cnt].copy_from_slice(&le[..cnt]);
		cnt + 1
	} else {
		out[0] = if cnt > min_bytes { top | !(bit * 2 - 1) as u8 } else { top };
		out[1..cnt].copy_from_slice(&le[..cnt - 1]);
		cnt
	}
}

fn check_min_bytes(min_bytes: u8) -> io::Result<usize> {
	match min_bytes {
		1..=8 => Ok(usize::from(min_bytes)),
		_ => Err(io::Error::new(
			io::ErrorKind::InvalidInput,
			format!("varlong min_bytes {min_bytes} outside 1..=8"),
		)),
	}
}

fn overflow(what: &str, line: u32) -> io::Error {
	wire_error(
		io::ErrorKind::InvalidData,
		RERR_STREAMIO,
		format!("Overflow in {what}()"),
		Some(("io.c", line)),
	)
}

/// Little-endian rsync integer/string codecs over any reader.
pub(crate) trait ReadExt: Read {
	/// One byte.
	fn read_u8(&mut self) -> io::Result<u8> {
		let mut b = [0u8; 1];
		fill(self, &mut b)?;
		Ok(b[0])
	}

	/// Unsigned 16-bit integer.
	fn read_shortint(&mut self) -> io::Result<u16> {
		let mut b = [0u8; 2];
		fill(self, &mut b)?;
		Ok(u16::from_le_bytes(b))
	}

	/// Signed 32-bit integer.
	fn read_int(&mut self) -> io::Result<i32> {
		let mut b = [0u8; 4];
		fill(self, &mut b)?;
		Ok(i32::from_le_bytes(b))
	}

	/// Unsigned 32-bit integer.
	fn read_uint(&mut self) -> io::Result<u32> {
		let mut b = [0u8; 4];
		fill(self, &mut b)?;
		Ok(u32::from_le_bytes(b))
	}

	/// An `int`, or the marker -1 followed by a full 64-bit value.
	fn read_longint(&mut self) -> io::Result<i64> {
		let v = self.read_int()?;
		if v != -1 {
			return Ok(i64::from(v));
		}
		let mut b = [0u8; 8];
		fill(self, &mut b)?;
		Ok(i64::from_le_bytes(b))
	}

	/// Variable-length 32-bit integer.
	fn read_varint(&mut self) -> io::Result<i32> {
		let lead = self.read_u8()?;
		let extra = extra_bytes(lead);
		if extra == 0 {
			return Ok(i32::from(lead));
		}
		if extra > 4 {
			return Err(overflow("read_varint", 2040));
		}
		let mut b = [0u8; 5];
		fill(self, &mut b[..extra])?;
		b[extra] = lead & lead_mask(extra);
		let [le @ .., _] = b;
		Ok(i32::from_le_bytes(le))
	}

	/// Variable-length 64-bit integer with at least `min_bytes` bytes.
	fn read_varlong(&mut self, min_bytes: u8) -> io::Result<i64> {
		let min = check_min_bytes(min_bytes)?;
		let mut head = [0u8; 8];
		fill(self, &mut head[..min])?;
		let lead = head[0];
		let mut v = [0u8; 9];
		v[..min - 1].copy_from_slice(&head[1..min]);
		let extra = extra_bytes(lead);
		if extra == 0 {
			v[min - 1] = lead;
		} else {
			if min + extra > v.len() {
				return Err(overflow("read_varlong", 2077));
			}
			fill(self, &mut v[min - 1..min - 1 + extra])?;
			v[min + extra - 1] = lead & lead_mask(extra);
		}
		let [le @ .., _] = v;
		Ok(i64::from_le_bytes(le))
	}

	/// `read_varint` from protocol 30, `read_int` before.
	fn read_varint30(&mut self, proto: Proto) -> io::Result<i32> {
		if proto.version < 30 { self.read_int() } else { self.read_varint() }
	}

	/// `read_varlong` from protocol 30, `read_longint` before.
	fn read_varlong30(&mut self, proto: Proto, min_bytes: u8) -> io::Result<i64> {
		if proto.version < 30 { self.read_longint() } else { self.read_varlong(min_bytes) }
	}

	/// Exactly `len` bytes; fails with InvalidData when `len > limit`.
	fn read_bytes(&mut self, len: usize, limit: usize) -> io::Result<Vec<u8>> {
		if len > limit {
			return Err(wire_error(
				io::ErrorKind::InvalidData,
				RERR_PROTOCOL,
				format!("wire size out of range: {len} > {limit}"),
				None,
			));
		}
		// Grow as the bytes actually arrive so a lying length cannot force a
		// large allocation before the stream ends.
		const STEP: usize = 64 * 1024;
		let mut out = Vec::with_capacity(len.min(STEP));
		while out.len() < len {
			let start = out.len();
			let step = (len - start).min(STEP);
			out.resize(start + step, 0);
			fill(self, &mut out[start..])?;
		}
		Ok(out)
	}

	/// A string with a 1-byte length (< 0x80) or a 2-byte big-endian length
	/// with the high bit set (up to 0x7FFF), read into upstream's `bufsize`
	/// buffer: a length of `bufsize` or more fails with upstream's
	/// `over-long vstring received` text and the exit `code` at `site` the
	/// caller ends with.
	fn read_vstring(
		&mut self,
		bufsize: usize,
		code: i32,
		site: (&'static str, u32),
	) -> io::Result<Vec<u8>> {
		let first = self.read_u8()?;
		let len = if first & 0x80 != 0 {
			usize::from(first & 0x7F) * 0x100 + usize::from(self.read_u8()?)
		} else {
			usize::from(first)
		};
		if len >= bufsize {
			return Err(wire_error(
				io::ErrorKind::InvalidData,
				code,
				format!("over-long vstring received ({len} > {})", bufsize - 1),
				Some(site),
			));
		}
		self.read_bytes(len, bufsize)
	}
}

impl<R: Read + ?Sized> ReadExt for R {}

/// Little-endian rsync integer/string codecs over any writer. Each value is
/// handed to the writer in a single `write` sequence.
pub(crate) trait WriteExt: Write {
	/// One byte.
	fn write_u8(&mut self, v: u8) -> io::Result<()> {
		put(self, &[v])
	}

	/// Unsigned 16-bit integer.
	fn write_shortint(&mut self, v: u16) -> io::Result<()> {
		put(self, &v.to_le_bytes())
	}

	/// Signed 32-bit integer.
	fn write_int(&mut self, v: i32) -> io::Result<()> {
		put(self, &v.to_le_bytes())
	}

	/// An `int` for 0..=i32::MAX, else -1 followed by the full 64-bit value.
	fn write_longint(&mut self, v: i64) -> io::Result<()> {
		if (0..=i64::from(i32::MAX)).contains(&v) {
			return put(self, &(v as i32).to_le_bytes());
		}
		let mut b = [0xFFu8; 12];
		b[4..].copy_from_slice(&v.to_le_bytes());
		put(self, &b)
	}

	/// Variable-length 32-bit integer.
	fn write_varint(&mut self, v: i32) -> io::Result<()> {
		let mut out = [0u8; 9];
		let n = encode_var(&v.to_le_bytes(), 1, &mut out);
		put(self, &out[..n])
	}

	/// Variable-length 64-bit integer with at least `min_bytes` bytes.
	fn write_varlong(&mut self, v: i64, min_bytes: u8) -> io::Result<()> {
		let min = check_min_bytes(min_bytes)?;
		let mut out = [0u8; 9];
		let n = encode_var(&v.to_le_bytes(), min, &mut out);
		put(self, &out[..n])
	}

	/// `write_varint` from protocol 30, `write_int` before.
	fn write_varint30(&mut self, proto: Proto, v: i32) -> io::Result<()> {
		if proto.version < 30 { self.write_int(v) } else { self.write_varint(v) }
	}

	/// `write_varlong` from protocol 30, `write_longint` before.
	fn write_varlong30(&mut self, proto: Proto, v: i64, min_bytes: u8) -> io::Result<()> {
		if proto.version < 30 { self.write_longint(v) } else { self.write_varlong(v, min_bytes) }
	}

	/// A vstring (see [`ReadExt::read_vstring`]); longer than 0x7FFF is refused.
	fn write_vstring(&mut self, s: &[u8]) -> io::Result<()> {
		let len = s.len();
		if len > 0x7FFF {
			return Err(wire_error(
				io::ErrorKind::InvalidInput,
				RERR_PROTOCOL,
				format!("attempting to send over-long vstring ({len} > {})", 0x7FFF),
				Some(("io.c", 2529)),
			));
		}
		let mut buf = Vec::with_capacity(len + 2);
		if len > 0x7F {
			buf.push((len / 0x100) as u8 | 0x80);
		}
		buf.push(len as u8);
		buf.extend_from_slice(s);
		put(self, &buf)
	}
}

impl<W: Write + ?Sized> WriteExt for W {}

/// File-list index codec for ONE direction (`read_ndx`/`write_ndx`): delta-encoded from
/// protocol 30, plain `int` before. Use one instance per direction per connection.
///
/// From protocol 30 an index is sent relative to the previous index of the
/// same sign: a delta of 1..=253 is one byte; a delta of 0 or 254..=32767 is
/// 0xFE plus two big-endian bytes; anything else is 0xFE plus the absolute
/// value in four bytes with the top byte first and flagged by 0x80. Negative
/// indices are prefixed by 0xFF and tracked separately; NDX_DONE is a lone 0.
pub(crate) struct NdxCodec {
	delta: bool,
	plain_writes: bool,
	prev_positive: i32,
	prev_negative: i32,
	role: Option<Role>,
}

impl NdxCodec {
	/// A codec in its initial state for `proto`.
	pub(crate) fn new(proto: Proto) -> Self {
		Self {
			delta: proto.version >= 30,
			plain_writes: false,
			prev_positive: -1,
			prev_negative: 1,
			role: None,
		}
	}

	/// Names the local role in diagnostics (upstream `who_am_i`).
	pub(crate) fn set_role(&mut self, role: Role) {
		self.role = Some(role);
	}

	/// Writes plain `int`s regardless of protocol (upstream does this for the
	/// generator's output while reading a batch).
	pub(crate) fn set_plain_writes(&mut self, plain: bool) {
		self.plain_writes = plain;
	}

	/// Reads one index.
	pub(crate) fn read(&mut self, r: &mut dyn Read) -> io::Result<i32> {
		if !self.delta {
			return r.read_int();
		}
		let first = r.read_u8()?;
		let negative = first == 0xFF;
		let b = if negative {
			r.read_u8()?
		} else if first == 0 {
			return Ok(NDX_DONE);
		} else {
			first
		};
		let prev = (if negative { self.prev_negative } else { self.prev_positive }) as u32;
		let unum = if b == 0xFE {
			let mut two = [0u8; 2];
			fill(r, &mut two)?;
			if two[0] & 0x80 != 0 {
				let mut rest = [0u8; 2];
				fill(r, &mut rest)?;
				u32::from_le_bytes([two[1], rest[0], rest[1], two[0] & 0x7F])
			} else {
				(u32::from(two[0]) << 8 | u32::from(two[1])).wrapping_add(prev)
			}
		} else {
			u32::from(b).wrapping_add(prev)
		};
		let Ok(num) = i32::try_from(unum) else {
			let who = self.role.map_or("", Role::name);
			return Err(wire_error(
				io::ErrorKind::InvalidData,
				RERR_PROTOCOL,
				format!("Invalid file index: {unum} [{who}]"),
				Some(("io.c", 2623)),
			));
		};
		if negative {
			self.prev_negative = num;
			Ok(-num)
		} else {
			self.prev_positive = num;
			Ok(num)
		}
	}

	/// Writes one index.
	pub(crate) fn write(&mut self, w: &mut dyn Write, ndx: i32) -> io::Result<()> {
		if !self.delta || self.plain_writes {
			return w.write_int(ndx);
		}
		let mut b = [0u8; 6];
		let mut n = 0;
		let (diff, mag) = if ndx >= 0 {
			let diff = ndx.wrapping_sub(self.prev_positive);
			self.prev_positive = ndx;
			(diff, ndx)
		} else if ndx == NDX_DONE {
			return w.write_u8(0);
		} else {
			b[0] = 0xFF;
			n = 1;
			let mag = ndx.wrapping_neg();
			let diff = mag.wrapping_sub(self.prev_negative);
			self.prev_negative = mag;
			(diff, mag)
		};
		if diff > 0 && diff < 0xFE {
			b[n] = diff as u8;
			n += 1;
		} else if !(0..=0x7FFF).contains(&diff) {
			let m = mag.to_le_bytes();
			b[n..n + 5].copy_from_slice(&[0xFE, m[3] | 0x80, m[0], m[1], m[2]]);
			n += 5;
		} else {
			b[n..n + 3].copy_from_slice(&[0xFE, (diff >> 8) as u8, diff as u8]);
			n += 3;
		}
		put(w, &b[..n])
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	const P29: Proto = Proto::new(29, 0);
	const P30: Proto = Proto::new(30, 0);
	const P33: Proto = Proto::new(33, 0x1ff);

	fn hex(s: &str) -> Vec<u8> {
		s.split_whitespace().map(|b| u8::from_str_radix(b, 16).unwrap()).collect()
	}

	fn enc(f: impl FnOnce(&mut Vec<u8>) -> io::Result<()>) -> Vec<u8> {
		let mut v = Vec::new();
		f(&mut v).unwrap();
		v
	}

	// Golden encodings produced by upstream's own write_varint/write_varlong/
	// write_longint (3.5.1) in a scratch harness.
	const VARINTS: &[(i32, &str)] = &[
		(0, "00"),
		(1, "01"),
		(0x7f, "7f"),
		(0x80, "80 80"),
		(0xff, "80 ff"),
		(0x100, "81 00"),
		(0x3fff, "bf ff"),
		(0x4000, "c0 00 40"),
		(0x1f_ffff, "df ff ff"),
		(0x20_0000, "e0 00 00 20"),
		(0x0fff_ffff, "ef ff ff ff"),
		(0x1000_0000, "f0 00 00 00 10"),
		(i32::MAX, "f0 ff ff ff 7f"),
		(-1, "f0 ff ff ff ff"),
		(-2, "f0 fe ff ff ff"),
		(-128, "f0 80 ff ff ff"),
		(i32::MIN, "f0 00 00 00 80"),
		(511, "81 ff"),
		(1_000_000, "cf 40 42"),
	];

	const VARLONGS: &[(u8, i64, &str)] = &[
		(1, 0, "00"),
		(1, 0x80, "80 80"),
		(1, 0xffff, "c0 ff ff"),
		(1, 0x80_0000, "e0 00 00 80"),
		(1, 0x1_0000_0000, "f1 00 00 00 00"),
		(1, 0x123_4567_89ab, "f9 ab 89 67 45 23"),
		(2, 0, "00 00"),
		(2, 0xff, "00 ff"),
		(2, 0xffff, "80 ff ff"),
		(2, 0x7fff_ffff, "e0 ff ff ff 7f"),
		(3, 0, "00 00 00"),
		(3, 0x7f, "00 7f 00"),
		(3, 0x1_0000, "01 00 00"),
		(3, 0x7f_ffff, "7f ff ff"),
		(3, 0x80_0000, "80 00 00 80"),
		(3, 0xff_ffff, "80 ff ff ff"),
		(3, 0x100_0000, "81 00 00 00"),
		(3, 0x7fff_ffff, "c0 ff ff ff 7f"),
		(3, 0xffff_ffff, "c0 ff ff ff ff"),
		(3, 0x1_0000_0000, "c1 00 00 00 00"),
		(3, 0x123_4567_89ab, "e1 ab 89 67 45 23"),
		(3, i64::MAX, "fc ff ff ff ff ff ff ff 7f"),
		(3, -1, "fc ff ff ff ff ff ff ff ff"),
		(3, 1_700_000_000, "c0 00 f1 53 65"),
		(4, 0, "00 00 00 00"),
		(4, 0x1_0000, "00 00 00 01"),
		(4, 0x100_0000, "01 00 00 00"),
		(4, 0x7fff_ffff, "7f ff ff ff"),
		(4, 0x8000_0000, "80 00 00 00 80"),
		(4, 0x1_0000_0000, "81 00 00 00 00"),
		(4, 1_700_000_000, "65 00 f1 53"),
		(4, i64::MAX, "f8 ff ff ff ff ff ff ff 7f"),
		(4, -1, "f8 ff ff ff ff ff ff ff ff"),
	];

	#[test]
	fn varint_golden_and_round_trip() {
		for &(v, bytes) in VARINTS {
			assert_eq!(enc(|w| w.write_varint(v)), hex(bytes), "write_varint({v})");
			let data = hex(bytes);
			let mut r = &data[..];
			assert_eq!(r.read_varint().unwrap(), v, "read_varint({bytes})");
			assert!(r.is_empty());
		}
	}

	#[test]
	fn varlong_golden_and_round_trip() {
		for &(min, v, bytes) in VARLONGS {
			assert_eq!(enc(|w| w.write_varlong(v, min)), hex(bytes), "write_varlong({v}, {min})");
			let data = hex(bytes);
			let mut r = &data[..];
			assert_eq!(r.read_varlong(min).unwrap(), v, "read_varlong({bytes}, {min})");
			assert!(r.is_empty());
		}
	}

	#[test]
	fn varlong_matches_upstream_for_values_its_reader_cannot_round_trip() {
		// Upstream writes nine bytes here but its reader consumes seven: the
		// writer must still emit upstream's bytes.
		assert_eq!(enc(|w| w.write_varlong(i64::MAX, 1)), hex("ff ff ff ff ff ff ff ff 7f"));
		assert_eq!(enc(|w| w.write_varlong(-1, 2)), hex("fe ff ff ff ff ff ff ff ff"));
	}

	#[test]
	fn longint_golden_and_round_trip() {
		let cases: &[(i64, &str)] = &[
			(0, "00 00 00 00"),
			(0x7fff_ffff, "ff ff ff 7f"),
			(0x8000_0000, "ff ff ff ff 00 00 00 80 00 00 00 00"),
			(-1, "ff ff ff ff ff ff ff ff ff ff ff ff"),
			(0x123_4567_89ab, "ff ff ff ff ab 89 67 45 23 01 00 00"),
		];
		for &(v, bytes) in cases {
			assert_eq!(enc(|w| w.write_longint(v)), hex(bytes), "write_longint({v})");
			let data = hex(bytes);
			let mut r = &data[..];
			assert_eq!(r.read_longint().unwrap(), v);
			assert!(r.is_empty());
		}
		// A negative int other than the -1 marker is returned as-is.
		let data = hex("fe ff ff ff");
		assert_eq!((&data[..]).read_longint().unwrap(), -2);
	}

	#[test]
	fn fixed_width_integers_are_little_endian() {
		assert_eq!(enc(|w| w.write_shortint(0x1234)), [0x34, 0x12]);
		assert_eq!(enc(|w| w.write_int(-102)), hex("9a ff ff ff"));
		assert_eq!(enc(|w| w.write_int(0xdead_beef_u32 as i32)), hex("ef be ad de"));
		// Protocol 33 version announcement as captured from rsync 3.5.1.
		assert_eq!(enc(|w| w.write_int(33)), hex("21 00 00 00"));
		let data = hex("34 12 9a ff ff ff ef be ad de");
		let mut r = &data[..];
		assert_eq!(r.read_shortint().unwrap(), 0x1234);
		assert_eq!(r.read_int().unwrap(), -102);
		assert_eq!(r.read_uint().unwrap(), 0xdead_beef);
	}

	#[test]
	fn varint30_and_varlong30_switch_at_protocol_30() {
		assert_eq!(enc(|w| w.write_varint30(P29, 5)), hex("05 00 00 00"));
		assert_eq!(enc(|w| w.write_varint30(P30, 5)), hex("05"));
		assert_eq!(enc(|w| w.write_varlong30(P29, 5, 3)), hex("05 00 00 00"));
		assert_eq!(enc(|w| w.write_varlong30(P33, 5, 3)), hex("00 05 00"));
		assert_eq!(
			enc(|w| w.write_varlong30(P29, 0x1_0000_0000, 3)),
			hex("ff ff ff ff 00 00 00 00 01 00 00 00")
		);
		let data = hex("05 00 00 00 05");
		let mut r = &data[..];
		assert_eq!(r.read_varint30(P29).unwrap(), 5);
		assert_eq!(r.read_varint30(P30).unwrap(), 5);
		assert!(r.is_empty());
	}

	#[test]
	fn compat_flags_varint_as_captured() {
		// rsync 3.5.1 announces CF bits 0..=8 as varint 511.
		assert_eq!(enc(|w| w.write_varint(0x1ff)), hex("81 ff"));
	}

	#[test]
	fn varint_overflow_is_invalid_data() {
		for lead in [0xf8u8, 0xfc, 0xff] {
			let data = [lead, 0, 0, 0, 0, 0, 0, 0, 0];
			let err = (&data[..]).read_varint().unwrap_err();
			assert_eq!(err.kind(), io::ErrorKind::InvalidData);
			let detail = wire_detail(&err).unwrap();
			assert_eq!(detail.message, "Overflow in read_varint()");
			assert_eq!(detail.code, RERR_STREAMIO);
		}
		// 4 extra bytes is the maximum a varint may announce.
		assert_eq!((&hex("f7 01 02 03 04")[..]).read_varint().unwrap(), 0x0403_0201);
	}

	#[test]
	fn varlong_overflow_is_invalid_data() {
		// min_bytes 4 + 6 extra bytes exceeds the 9-byte maximum.
		let data = [0xfcu8; 12];
		let err = (&data[..]).read_varlong(4).unwrap_err();
		assert_eq!(err.kind(), io::ErrorKind::InvalidData);
		assert_eq!(wire_detail(&err).unwrap().message, "Overflow in read_varlong()");
		// min_bytes 3 + 6 is exactly nine: accepted.
		assert!((&data[..]).read_varlong(3).is_ok());
		assert_eq!(
			(&data[..]).read_varlong(0).unwrap_err().kind(),
			io::ErrorKind::InvalidInput
		);
	}

	/// The upstream exit site the vstring tests report an over-long string at.
	const SITE: (&str, u32) = ("rsync.c", 410);

	#[test]
	fn short_reads_are_unexpected_eof() {
		fn kind<T: fmt::Debug>(res: io::Result<T>) -> io::ErrorKind {
			res.unwrap_err().kind()
		}
		let eof = io::ErrorKind::UnexpectedEof;
		assert_eq!(kind((&hex("01 02 03")[..]).read_int()), eof);
		assert_eq!(kind((&hex("80")[..]).read_varint()), eof);
		assert_eq!(kind((&hex("ff ff ff ff 01")[..]).read_longint()), eof);
		assert_eq!(kind((&hex("00 00")[..]).read_varlong(3)), eof);
		assert_eq!(kind((&hex("05 61 62")[..]).read_vstring(0x8000, RERR_PROTOCOL, SITE)), eof);
		assert_eq!(kind((&hex("")[..]).read_u8()), eof);
		let mut codec = NdxCodec::new(P33);
		assert_eq!(kind(codec.read(&mut &hex("fe 80 01")[..])), eof);
	}

	#[test]
	fn vstring_lengths() {
		let list = b"xxh128 xxh3 xxh64 md5 md4 sha1 none";
		let mut golden = vec![0x23];
		golden.extend_from_slice(list);
		assert_eq!(enc(|w| w.write_vstring(list)), golden);

		for len in [0usize, 1, 0x7f, 0x80, 0xff, 0x100, 0x7fff] {
			let s = vec![b'a'; len];
			let bytes = enc(|w| w.write_vstring(&s));
			let header = if len > 0x7f { 2 } else { 1 };
			assert_eq!(bytes.len(), len + header);
			if len > 0x7f {
				assert_eq!(bytes[0], (len >> 8) as u8 | 0x80);
				assert_eq!(bytes[1], len as u8);
			}
			let mut r = &bytes[..];
			assert_eq!(r.read_vstring(0x8000, RERR_PROTOCOL, SITE).unwrap(), s);
			assert!(r.is_empty());
		}
		// A length that does not fit the reader's buffer is refused before any byte is read.
		let err = (&hex("81 00")[..]).read_vstring(0x100, RERR_PROTOCOL, SITE).unwrap_err();
		assert_eq!(err.kind(), io::ErrorKind::InvalidData);
		let detail = wire_detail(&err).unwrap();
		assert_eq!(detail.message, "over-long vstring received (256 > 255)");
		assert_eq!((detail.code, detail.site), (RERR_PROTOCOL, Some(SITE)));
		assert_eq!(enc(|w| w.write_vstring(&[b'x'; 0x80]))[..2], [0x80, 0x80]);
		let err = Vec::<u8>::new().write_vstring(&vec![0u8; 0x8000]).unwrap_err();
		assert_eq!(
			wire_detail(&err).unwrap().message,
			"attempting to send over-long vstring (32768 > 32767)"
		);
	}

	#[test]
	fn read_bytes_enforces_limit() {
		let data = [7u8; 10];
		assert_eq!((&data[..]).read_bytes(10, 10).unwrap(), data);
		let err = (&data[..]).read_bytes(11, 10).unwrap_err();
		assert_eq!(err.kind(), io::ErrorKind::InvalidData);
		// A huge claimed length on a short stream fails with EOF, not an allocation.
		let err = (&data[..]).read_bytes(1 << 40, usize::MAX).unwrap_err();
		assert_eq!(err.kind(), io::ErrorKind::UnexpectedEof);
	}

	fn ndx_bytes(proto: Proto, seq: &[i32]) -> Vec<u8> {
		let mut codec = NdxCodec::new(proto);
		let mut out = Vec::new();
		for &n in seq {
			codec.write(&mut out, n).unwrap();
		}
		out
	}

	fn ndx_decode(proto: Proto, bytes: &[u8], count: usize) -> Vec<i32> {
		let mut codec = NdxCodec::new(proto);
		let mut r = bytes;
		let v = (0..count).map(|_| codec.read(&mut r).unwrap()).collect();
		assert!(r.is_empty(), "trailing bytes");
		v
	}

	#[test]
	fn ndx_golden_from_captured_exchange() {
		// Generator → sender requests captured from rsync 3.5.1 (protocol 33).
		let seq = [0, 2, 3, 5, 6, NDX_DONE];
		let bytes = hex("01 02 01 02 01 00");
		assert_eq!(ndx_bytes(P33, &seq), bytes);
		assert_eq!(ndx_decode(P33, &bytes, seq.len()), seq);

		// Sender's inc-recurse flist for dir 1, then NDX_FLIST_EOF.
		let seq = [-102, -2];
		let bytes = hex("ff 65 ff fe 80 02 00 00");
		assert_eq!(ndx_bytes(P33, &seq), bytes);
		assert_eq!(ndx_decode(P33, &bytes, seq.len()), seq);
	}

	#[test]
	fn ndx_delta_forms() {
		// diff 254 and repeat (diff 0) use the 2-byte form; a big jump or a
		// backwards step uses the 4-byte absolute form.
		let seq = [253, 253, 300, 0x1234_5678, 7, i32::MAX, -3, -3, -40000];
		let bytes = ndx_bytes(P30, &seq);
		assert_eq!(
			bytes,
			hex(
				"fe 00 fe fe 00 00 2f fe 92 78 56 34 fe 80 07 00 00 \
				 fe ff ff ff ff ff 02 ff fe 00 00 ff fe 80 40 9c 00"
			)
		);
		assert_eq!(ndx_decode(P30, &bytes, seq.len()), seq);
	}

	#[test]
	fn ndx_plain_int_before_protocol_30() {
		let seq = [0, 5, NDX_DONE, -102];
		let bytes = ndx_bytes(P29, &seq);
		assert_eq!(bytes, hex("00 00 00 00 05 00 00 00 ff ff ff ff 9a ff ff ff"));
		assert_eq!(ndx_decode(P29, &bytes, seq.len()), seq);

		let mut codec = NdxCodec::new(P33);
		codec.set_plain_writes(true);
		let mut out = Vec::new();
		codec.write(&mut out, 1).unwrap();
		assert_eq!(out, hex("01 00 00 00"));
	}

	#[test]
	fn ndx_rejects_index_beyond_i32() {
		let bytes = hex("fe ff ff ff ff 01");
		let mut codec = NdxCodec::new(P33);
		let mut r = &bytes[..];
		assert_eq!(codec.read(&mut r).unwrap(), i32::MAX);
		let err = codec.read(&mut r).unwrap_err();
		assert_eq!(err.kind(), io::ErrorKind::InvalidData);
		let detail = wire_detail(&err).unwrap();
		assert!(detail.message.starts_with("Invalid file index: 2147483648 ["), "{}", detail.message);
		assert_eq!(detail.code, RERR_PROTOCOL);
		assert_eq!(detail.site, Some(("io.c", 2623)));
	}

	#[test]
	fn ndx_sign_states_are_independent() {
		let seq = [10, -105, 11, -106, NDX_DONE, 12];
		let bytes = ndx_bytes(P33, &seq);
		assert_eq!(bytes, hex("0b ff 68 01 ff 01 00 01"));
		assert_eq!(ndx_decode(P33, &bytes, seq.len()), seq);
	}

	#[test]
	fn eintr_is_retried_and_other_errors_surface() {
		struct Cancelled;
		impl Read for Cancelled {
			fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
				Err(wire_error(io::ErrorKind::Other, 20, "", None))
			}
		}
		let err = Cancelled.read_int().unwrap_err();
		assert_eq!(wire_detail(&err).unwrap().code, 20);

		struct Eintr(u8);
		impl Read for Eintr {
			fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
				if self.0 == 0 {
					self.0 = 1;
					return Err(io::ErrorKind::Interrupted.into());
				}
				buf[0] = 9;
				Ok(1)
			}
		}
		assert_eq!(Eintr(0).read_u8().unwrap(), 9);
	}
}
