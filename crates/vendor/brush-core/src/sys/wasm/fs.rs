//! Filesystem utilities for WASM.

pub use crate::sys::stubs::fs::*;

impl crate::sys::fs::PathExt for std::path::Path {
	fn readable(&self) -> bool {
		true
	}

	fn writable(&self) -> bool {
		true
	}

	fn executable(&self) -> bool {
		true
	}

	fn exists_and_is_block_device(&self) -> bool {
		false
	}

	fn exists_and_is_char_device(&self) -> bool {
		false
	}

	fn exists_and_is_fifo(&self) -> bool {
		false
	}

	fn exists_and_is_socket(&self) -> bool {
		false
	}

	fn exists_and_is_setgid(&self) -> bool {
		false
	}

	fn exists_and_is_setuid(&self) -> bool {
		false
	}

	fn exists_and_is_sticky_bit(&self) -> bool {
		false
	}

	fn get_device_and_inode(&self) -> Result<(u64, u64), crate::error::Error> {
		Ok((0, 0))
	}
}

/// Splits a PATH-like value into individual paths.
///
/// On WASM, `std::env::split_paths` is not available, so this
/// implementation splits by the `:` separator.
pub fn split_paths<T: AsRef<std::ffi::OsStr> + ?Sized>(
	s: &T,
) -> impl Iterator<Item = std::path::PathBuf> {
	s.as_ref()
		.to_str()
		.unwrap_or_default()
		.split(':')
		.map(std::path::PathBuf::from)
		.collect::<Vec<_>>()
		.into_iter()
}
