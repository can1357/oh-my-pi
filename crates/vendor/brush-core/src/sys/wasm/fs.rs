//! Filesystem utilities for WASM.

pub use crate::sys::stubs::fs::*;

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
