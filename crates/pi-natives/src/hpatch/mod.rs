//! Applies [HDiffPatch](https://github.com/sisong/HDiffPatch) single-stream
//! patches (`hdiffz -SD`, format `HDIFFSF20`), zstd-compressed or raw.
//!
//! The decoder reads the patch and writes the result in order, seeking in the
//! old data as covers require. Memory holds one step's cover and residual
//! codes, fixed-size I/O buffers, and the zstd decoding window.
//!
//! The patch carries no checksum of its own: callers check the patch, the old
//! data and the result against digests they trust.
//!
//! Ported from Stencil's `stencil-hpatch` crate (`crates/hpatch/src/lib.rs`),
//! whose format decoder derives from `HDiffPatch` v5.1.3 (MIT); its notice is
//! retained in `LICENSE.HDiffPatch` next to this module. Zstd decoding uses
//! the `zstd` crate.

// `deny`, not `forbid`: the `#[napi]` expansion allows `unsafe_code` locally.
#![deny(unsafe_code)]

use std::{
	fmt,
	fs::File,
	io::{self, BufReader, BufWriter, Read, Seek, SeekFrom, Write},
};

use napi_derive::napi;

use crate::task;

const CACHE_SIZE: usize = 64 * 1024;
const STEP_SLACK: u64 = 4 * 1024 * 1024;
/// Matches `HDiffPatch`'s `ZSTD_d_windowLogMax = 30`; covers the build
/// service's 16 MiB windows.
const ZSTD_WINDOW_LOG_MAX: u32 = 30;

/// Why patch application failed.
#[derive(Debug)]
pub enum Error {
	/// Reading or writing patch or file data failed.
	Io(io::Error),
	/// The patch is damaged, not a single-stream patch, or made for other old
	/// data.
	Corrupt,
	/// The patch is compressed with something other than zstd.
	Unsupported,
	/// A working buffer could not be allocated.
	NoMemory,
}

impl fmt::Display for Error {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		match self {
			Self::Io(error) => write!(f, "patch I/O failed: {error}"),
			Self::Corrupt => f.write_str("the patch is damaged or does not fit the old data"),
			Self::Unsupported => f.write_str("the patch is compressed with an unsupported method"),
			Self::NoMemory => f.write_str("not enough memory to process the patch"),
		}
	}
}

impl std::error::Error for Error {
	fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
		match self {
			Self::Io(error) => Some(error),
			_ => None,
		}
	}
}

impl From<io::Error> for Error {
	fn from(error: io::Error) -> Self {
		Self::Io(error)
	}
}

/// Applies an `HDiffPatch` single-stream patch (HDIFFSF20, zstd or
/// uncompressed) to `oldPath`, writing the result to `outPath` (created or
/// truncated). Resolves to the result's size in bytes. Rejects on I/O failure,
/// a damaged or unsupported patch, or a patch made for other old data.
#[napi(js_name = "applyBinaryPatch")]
pub fn apply_binary_patch(
	old_path: String,
	patch_path: String,
	out_path: String,
) -> task::Promise<i64> {
	task::blocking("hpatch.apply", (), move |_| {
		apply_files(&old_path, &patch_path, &out_path).map_err(|error| {
			napi::Error::from_reason(format!("Applying binary patch failed: {error}"))
		})
	})
}

fn apply_files(old_path: &str, patch_path: &str, out_path: &str) -> Result<i64, Error> {
	let mut old = File::open(old_path)?;
	let mut patch = File::open(patch_path)?;
	let mut out = File::create(out_path)?;
	let size = apply(&mut old, &mut patch, &mut out)?;
	out.sync_all()?;
	i64::try_from(size).map_err(|_| Error::Corrupt)
}

/// Applies a single-stream patch to `old`, writing `new` in order and returning
/// its size in bytes.
///
/// Both inputs are read from their start, regardless of their initial position.
/// On an error, `new` may contain a partial result.
///
/// # Errors
/// [`Error::Io`] preserves stream failures. Malformed patches or mismatched old
/// sizes return [`Error::Corrupt`]; other compression methods return
/// [`Error::Unsupported`]. Working-buffer allocation failures return
/// [`Error::NoMemory`].
pub fn apply<O, P, W>(old: &mut O, patch: &mut P, new: &mut W) -> Result<u64, Error>
where
	O: Read + Seek,
	P: Read + Seek,
	W: Write,
{
	let old_size = old.seek(SeekFrom::End(0))?;
	let patch_size = patch.seek(SeekFrom::End(0))?;
	old.rewind()?;
	patch.rewind()?;
	let mut error = None;
	let result = (|| {
		let source = PatchSource { inner: patch, error: &mut error };
		let mut patch = Reader::new(BufReader::with_capacity(CACHE_SIZE, source), patch_size);
		let header = Header::read(&mut patch)?;
		if header.old_size != old_size {
			return Err(Error::Corrupt);
		}
		let stored_size = if header.compressed_size == 0 {
			header.data_size
		} else {
			header.compressed_size
		};
		if stored_size > patch.remaining {
			return Err(Error::Corrupt);
		}
		let payload = patch.inner.take(stored_size);
		let mut old = BufReader::with_capacity(CACHE_SIZE, old);
		let mut new = BufWriter::with_capacity(CACHE_SIZE, new);
		if header.compressed_size == 0 {
			patch_data(Reader::new(payload, header.data_size), &header, &mut old, &mut new)?;
		} else {
			if !header.zstd {
				return Err(Error::Unsupported);
			}
			let mut decoder =
				zstd::stream::read::Decoder::with_buffer(payload).map_err(|_| Error::NoMemory)?;
			decoder
				.window_log_max(ZSTD_WINDOW_LOG_MAX)
				.map_err(|_| Error::NoMemory)?;
			let data = Reader { inner: decoder, remaining: header.data_size, compressed: true };
			patch_data(data, &header, &mut old, &mut new)?;
		}
		new.flush()?;
		Ok(header.new_size)
	})();
	match error {
		Some(error) => Err(Error::Io(error)),
		None => result,
	}
}

/// Retains the original I/O error before a decompressor wraps it.
struct PatchSource<'a, R> {
	inner: &'a mut R,
	error: &'a mut Option<io::Error>,
}

impl<R: Read> Read for PatchSource<'_, R> {
	fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
		match self.inner.read(buf) {
			Err(error) if error.kind() != io::ErrorKind::Interrupted => {
				let kind = error.kind();
				*self.error = Some(error);
				Err(kind.into())
			},
			result => result,
		}
	}
}

struct Header {
	new_size:        u64,
	old_size:        u64,
	covers:          u64,
	step_size:       u64,
	data_size:       u64,
	compressed_size: u64,
	zstd:            bool,
}

impl Header {
	fn read<R: Read>(patch: &mut Reader<R>) -> Result<Self, Error> {
		let mut magic = [0; 10];
		patch.read(&mut magic)?;
		if &magic != b"HDIFFSF20&" {
			return Err(Error::Corrupt);
		}
		let mut compression = [0; 263];
		let mut len = 0;
		loop {
			let byte = patch.byte()?;
			if byte == 0 {
				break;
			}
			let slot = compression.get_mut(len).ok_or(Error::Corrupt)?;
			*slot = byte;
			len += 1;
		}
		let header = Self {
			new_size:        patch.uint()?,
			old_size:        patch.uint()?,
			covers:          patch.uint()?,
			step_size:       patch.uint()?,
			data_size:       patch.uint()?,
			compressed_size: patch.uint()?,
			zstd:            &compression[..len] == b"zstd",
		};
		if header.compressed_size > header.data_size
			|| header.step_size > header.new_size.saturating_add(STEP_SLACK)
			|| header.step_size > header.data_size.saturating_add(STEP_SLACK)
		{
			return Err(Error::Corrupt);
		}
		Ok(header)
	}
}

/// A bounded patch section with `HDiffPatch`'s MSB-first variable integers.
struct Reader<R> {
	inner:      R,
	remaining:  u64,
	compressed: bool,
}

impl<R: Read> Reader<R> {
	const fn new(inner: R, remaining: u64) -> Self {
		Self { inner, remaining, compressed: false }
	}

	fn read_error(&self, error: io::Error) -> Error {
		if self.compressed || error.kind() == io::ErrorKind::UnexpectedEof {
			Error::Corrupt
		} else {
			Error::Io(error)
		}
	}

	fn read(&mut self, buf: &mut [u8]) -> Result<(), Error> {
		if buf.len() as u64 > self.remaining {
			return Err(Error::Corrupt);
		}
		self
			.inner
			.read_exact(buf)
			.map_err(|error| self.read_error(error))?;
		self.remaining -= buf.len() as u64;
		Ok(())
	}

	/// Reads the next `size` bytes into `step`, reusing its capacity and
	/// growing it only a chunk ahead of the bytes that arrived: a damaged
	/// patch that declares a huge step over a short compressed payload is
	/// corrupt before it can claim memory it never fills.
	fn step(&mut self, step: &mut Vec<u8>, size: usize) -> Result<(), Error> {
		step.clear();
		let mut len = size.min(step.capacity());
		step.resize(len, 0);
		self.read(step)?;
		while len < size {
			let chunk = (size - len).min(CACHE_SIZE);
			step.try_reserve(chunk).map_err(|_| Error::NoMemory)?;
			step.resize(len + chunk, 0);
			self.read(&mut step[len..])?;
			len += chunk;
		}
		Ok(())
	}

	fn byte(&mut self) -> Result<u8, Error> {
		let mut byte = [0];
		self.read(&mut byte)?;
		Ok(byte[0])
	}

	fn uint(&mut self) -> Result<u64, Error> {
		let first = self.byte()?;
		self.integer(first, 0)
	}

	fn integer(&mut self, first: u8, tag_bits: u8) -> Result<u64, Error> {
		let continuation = 0x80 >> tag_bits;
		let mut value = u64::from(first & (continuation - 1));
		let mut more = first & continuation != 0;
		while more {
			let byte = self.byte()?;
			value = value.checked_mul(128).ok_or(Error::Corrupt)? | u64::from(byte & 0x7f);
			more = byte & 0x80 != 0;
		}
		Ok(value)
	}

	fn finish(mut self) -> Result<(), Error> {
		if self.remaining != 0 {
			return Err(Error::Corrupt);
		}
		loop {
			match self.inner.read(&mut [0]) {
				Ok(0) => return Ok(()),
				Ok(_) => return Err(Error::Corrupt),
				Err(error) if error.kind() == io::ErrorKind::Interrupted => {},
				Err(error) => return Err(self.read_error(error)),
			}
		}
	}
}

fn buffer(size: usize) -> Result<Vec<u8>, Error> {
	let mut buffer = Vec::new();
	buffer
		.try_reserve_exact(size)
		.map_err(|_| Error::NoMemory)?;
	buffer.resize(size, 0);
	Ok(buffer)
}

fn patch_data<R: Read, O: Read + Seek, W: Write>(
	mut data: Reader<R>,
	header: &Header,
	old: &mut BufReader<O>,
	new: &mut W,
) -> Result<(), Error> {
	let mut step = Vec::new();
	let mut scratch = buffer(CACHE_SIZE)?;
	let mut covers_left = header.covers;
	let mut old_end = 0u64;
	let mut new_end = 0u64;
	while covers_left != 0 {
		let covers_size = data.uint()?;
		let rle_size = data.uint()?;
		let size = covers_size.checked_add(rle_size).ok_or(Error::Corrupt)?;
		if covers_size == 0 || size > header.step_size || size > data.remaining {
			return Err(Error::Corrupt);
		}
		let size = usize::try_from(size).map_err(|_| Error::NoMemory)?;
		data.step(&mut step, size)?;
		// Both sizes fit usize because their sum does.
		let (covers, residuals) = step.split_at(covers_size as usize);
		let mut covers = Reader::new(covers, covers_size);
		let mut rle =
			Rle { code: Reader::new(residuals, rle_size), remaining: 0, zeros: false };
		while covers.remaining != 0 {
			covers_left = covers_left.checked_sub(1).ok_or(Error::Corrupt)?;
			let first = covers.byte()?;
			let delta = covers.integer(first, 1)?;
			let old_pos = if first & 0x80 == 0 {
				old_end.checked_add(delta)
			} else {
				old_end.checked_sub(delta)
			}
			.ok_or(Error::Corrupt)?;
			let gap = covers.uint()?;
			let length = covers.uint()?;
			new_end = new_end
				.checked_add(gap)
				.and_then(|n| n.checked_add(length))
				.ok_or(Error::Corrupt)?;
			if new_end > header.new_size || (length == 0 && covers_left != 0) {
				return Err(Error::Corrupt);
			}
			copy_gap(&mut data, new, gap, &mut scratch)?;
			if length != 0 {
				let end = old_pos.checked_add(length).ok_or(Error::Corrupt)?;
				if end > header.old_size {
					return Err(Error::Corrupt);
				}
				let distance = i128::from(old_pos) - i128::from(old_end);
				if let Ok(distance) = i64::try_from(distance) {
					old.seek_relative(distance)?;
				} else {
					old.seek(SeekFrom::Start(old_pos))?;
				}
				let mut left = length;
				while left != 0 {
					let size = left.min(scratch.len() as u64) as usize;
					let chunk = &mut scratch[..size];
					old.read_exact(chunk)?;
					rle.add(chunk)?;
					new.write_all(chunk)?;
					left -= size as u64;
				}
				old_end = end;
			}
		}
	}
	if new_end != header.new_size {
		return Err(Error::Corrupt);
	}
	data.finish()
}

fn copy_gap<R: Read, W: Write>(
	data: &mut Reader<R>,
	new: &mut W,
	mut length: u64,
	scratch: &mut [u8],
) -> Result<(), Error> {
	while length != 0 {
		let size = length.min(scratch.len() as u64) as usize;
		data.read(&mut scratch[..size])?;
		new.write_all(&scratch[..size])?;
		length -= size as u64;
	}
	Ok(())
}

/// Alternating unchanged and wrapping-add runs, shared by a step's covers.
struct Rle<'a> {
	code:      Reader<&'a [u8]>,
	remaining: u64,
	zeros:     bool,
}

impl Rle<'_> {
	fn add(&mut self, mut output: &mut [u8]) -> Result<(), Error> {
		while !output.is_empty() {
			if self.remaining == 0 {
				self.remaining = self.code.uint()?;
				self.zeros = !self.zeros;
				if !self.zeros && self.remaining > self.code.remaining {
					return Err(Error::Corrupt);
				}
			}
			let size = self.remaining.min(output.len() as u64) as usize;
			let (chunk, rest) = output.split_at_mut(size);
			if !self.zeros {
				let (add, rest) = self.code.inner.split_at(size);
				for (byte, delta) in chunk.iter_mut().zip(add) {
					*byte = byte.wrapping_add(*delta);
				}
				self.code.inner = rest;
				self.code.remaining -= size as u64;
			}
			self.remaining -= size as u64;
			output = rest;
		}
		Ok(())
	}
}

#[cfg(test)]
mod tests {
	use std::io::Cursor;

	use super::*;

	/// Generated by `stencil_hpatch::diff` from the same `old.bin` → `new.bin`
	/// pair: one zstd-compressed patch, one stored raw.
	const OLD: &[u8] = include_bytes!("../../fixtures/hpatch/old.bin");
	const NEW: &[u8] = include_bytes!("../../fixtures/hpatch/new.bin");
	const ZSTD: &[u8] = include_bytes!("../../fixtures/hpatch/zstd.hdiff");
	const RAW: &[u8] = include_bytes!("../../fixtures/hpatch/raw.hdiff");

	fn run(old: &[u8], patch: &[u8]) -> Result<Vec<u8>, Error> {
		let mut new = Vec::new();
		let size = apply(&mut Cursor::new(old), &mut Cursor::new(patch), &mut new)?;
		assert_eq!(size, new.len() as u64);
		Ok(new)
	}

	#[test]
	fn applies_zstd_and_raw_patches() {
		assert!(ZSTD.starts_with(b"HDIFFSF20&zstd\0"));
		assert!(RAW.starts_with(b"HDIFFSF20&\0"));
		assert_eq!(run(OLD, ZSTD).expect("zstd patch"), NEW);
		assert_eq!(run(OLD, RAW).expect("raw patch"), NEW);
	}

	#[test]
	fn rejects_damaged_patches() {
		for patch in [ZSTD, RAW] {
			assert!(matches!(run(OLD, &patch[..patch.len() - 9]), Err(Error::Corrupt)));
			let mut magic = patch.to_vec();
			magic[0] ^= 0xff;
			assert!(matches!(run(OLD, &magic), Err(Error::Corrupt)));
		}
		// A raw payload has no integrity of its own; zstd frames do.
		let mut flipped = ZSTD.to_vec();
		let last = flipped.len() - 1;
		flipped[last] ^= 0xff;
		assert!(matches!(run(OLD, &flipped), Err(Error::Corrupt)));
		assert!(matches!(run(OLD, b"not a patch"), Err(Error::Corrupt)));
	}

	#[test]
	fn rejects_other_old_data() {
		let mut other = OLD.to_vec();
		other.pop();
		assert!(matches!(run(&other, ZSTD), Err(Error::Corrupt)));
		assert!(matches!(run(&other, RAW), Err(Error::Corrupt)));
	}

	#[test]
	fn applies_files_and_reports_io_errors() {
		let dir = std::env::temp_dir().join(format!("pi-natives-hpatch-{}", std::process::id()));
		std::fs::create_dir_all(&dir).expect("temp dir");
		let old = dir.join("old");
		let patch = dir.join("patch");
		let out = dir.join("out");
		std::fs::write(&old, OLD).expect("write old");
		std::fs::write(&patch, ZSTD).expect("write patch");
		std::fs::write(&out, b"stale contents longer than nothing").expect("write out");
		let path = |path: &std::path::Path| path.to_str().expect("utf-8 path").to_owned();
		let size = apply_files(&path(&old), &path(&patch), &path(&out)).expect("apply");
		assert_eq!(size, NEW.len() as i64);
		assert_eq!(std::fs::read(&out).expect("read out"), NEW);
		let missing = dir.join("missing");
		let result = apply_files(&path(&missing), &path(&patch), &path(&out));
		std::fs::remove_dir_all(&dir).expect("remove temp dir");
		assert!(matches!(result, Err(Error::Io(_))));
	}
}
