//! Decoder for the native workspace capture manifest shared by execution hosts.

use std::{io, str};

use omp_core::Hash32;

/// One native manifest entry before resolving its CAS blob length.
#[derive(Debug)]
pub struct CaptureEntry {
	/// Workspace-relative UTF-8 source path (not yet validated for
	/// materialization).
	pub path:       String,
	/// Captured source content digest.
	pub hash:       Hash32,
	/// Whether any executable permission bit was captured.
	pub executable: bool,
	/// Raw captured mode, allowing hosts to apply stricter admission rules.
	pub mode:       u32,
}

/// Decode the native zero-prefix execution capture format.
///
/// This preserves the execution client's decoding contract: path safety and
/// accepted file modes are admission decisions for the consuming host.
///
/// # Errors
/// Returns an invalid-data error for an unsupported or truncated manifest.
pub fn capture_entries(bytes: &[u8]) -> io::Result<Vec<CaptureEntry>> {
	if !bytes.starts_with(b"OMPWS2\0\0\0\0\0") {
		return Err(io::Error::new(io::ErrorKind::InvalidData, "invalid capture manifest"));
	}
	let mut remaining = &bytes[11..];
	let mut entries = Vec::new();
	while !remaining.is_empty() {
		let length = u32::from_be_bytes(
			take(&mut remaining, 4)?
				.try_into()
				.map_err(|_| io::ErrorKind::InvalidData)?,
		) as usize;
		let path = str::from_utf8(take(&mut remaining, length)?)
			.map_err(|_| io::ErrorKind::InvalidData)?
			.to_owned();
		let mode = u32::from_be_bytes(
			take(&mut remaining, 4)?
				.try_into()
				.map_err(|_| io::ErrorKind::InvalidData)?,
		);
		let hash = Hash32::new(
			take(&mut remaining, 32)?
				.try_into()
				.map_err(|_| io::ErrorKind::InvalidData)?,
		);
		entries.push(CaptureEntry { path, hash, executable: mode & 0o111 != 0, mode });
	}
	Ok(entries)
}

fn take<'a>(bytes: &mut &'a [u8], length: usize) -> io::Result<&'a [u8]> {
	let (head, tail) = bytes
		.split_at_checked(length)
		.ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "truncated capture entry"))?;
	*bytes = tail;
	Ok(head)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn capture_decoder_preserves_modes_and_rejects_truncation() {
		let mut bytes = b"OMPWS2\0\0\0\0\0".to_vec();
		bytes.extend_from_slice(&1u32.to_be_bytes());
		bytes.extend_from_slice(b"x");
		bytes.extend_from_slice(&0o100755u32.to_be_bytes());
		bytes.extend_from_slice(&[7; 32]);
		let entries = capture_entries(&bytes).unwrap();
		assert_eq!(entries.len(), 1);
		assert_eq!(entries[0].path, "x");
		assert_eq!(entries[0].hash, Hash32::new([7; 32]));
		assert_eq!(entries[0].mode, 0o100755);
		assert!(entries[0].executable);
		for length in 0..bytes.len() {
			if length != 11 {
				assert!(capture_entries(&bytes[..length]).is_err(), "length {length}");
			}
		}
		bytes[10] = 1;
		assert!(capture_entries(&bytes).is_err());
	}
}
