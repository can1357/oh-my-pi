//! Host filesystem through direct syscalls, one implementation per platform:
//!
//! - `unix.rs`: descriptors, relative `openat` opens, file reads, and stamp
//!   bookkeeping shared by every Unix; the listing and stat syscalls come from
//!   `sys`, which is `darwin.rs` on macOS, `linux.rs` on Linux, and the
//!   portable `other.rs` elsewhere.
//! - `windows.rs`: NT handles, relative `NtCreateFile` opens, and
//!   `NtQueryDirectoryFile` listings.

#[cfg(target_os = "macos")]
#[path = "darwin.rs"]
mod sys;
#[cfg(target_os = "linux")]
#[path = "linux.rs"]
mod sys;
#[cfg(all(unix, not(any(target_os = "macos", target_os = "linux"))))]
#[path = "other.rs"]
mod sys;
#[cfg(unix)]
mod unix;
#[cfg(windows)]
mod windows;

#[cfg(unix)]
pub(super) use unix::*;
#[cfg(windows)]
pub(super) use windows::*;

/// Views `buf` as at least `bytes` bytes of 8-aligned scratch, growing it on
/// first use. Bulk listing syscalls need aligned buffers on some platforms.
#[allow(dead_code, reason = "the portable Unix fallback lists through readdir")]
fn aligned_buf(buf: &mut Vec<u64>, bytes: usize) -> &mut [u8] {
	let words = bytes.div_ceil(8);
	if buf.len() < words {
		buf.resize(words, 0);
	}
	// SAFETY: the `u64` storage is initialized, `u8` has no alignment
	// requirement, and the byte length covers exactly the vector's elements.
	unsafe { std::slice::from_raw_parts_mut(buf.as_mut_ptr().cast::<u8>(), buf.len() * 8) }
}

/// Little-endian `u16` at `off` of `b`.
#[inline]
#[allow(dead_code, reason = "not every platform parses every width")]
fn le16(b: &[u8], off: usize) -> u16 {
	u16::from_le_bytes(*b[off..].first_chunk().expect("record field in bounds"))
}

/// Little-endian `u32` at `off` of `b`.
#[inline]
#[allow(dead_code, reason = "not every platform parses every width")]
fn le32(b: &[u8], off: usize) -> u32 {
	u32::from_le_bytes(*b[off..].first_chunk().expect("record field in bounds"))
}

/// Little-endian `u64` at `off` of `b`.
#[inline]
#[allow(dead_code, reason = "not every platform parses every width")]
fn le64(b: &[u8], off: usize) -> u64 {
	u64::from_le_bytes(*b[off..].first_chunk().expect("record field in bounds"))
}

/// `.` or `..`.
#[cfg(unix)]
#[inline]
const fn is_dot_or_dot_dot(name: &[u8]) -> bool {
	matches!(name, b"." | b"..")
}
