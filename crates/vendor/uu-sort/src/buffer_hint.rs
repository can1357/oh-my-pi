// This file is part of the uutils coreutils package.
//
// For the full copyright and license information, please view the LICENSE
// file that was distributed with this source code.

//! Heuristics for determining buffer size for external sorting.
use std::ffi::OsString;

// Heuristics to size the external sort buffer without overcommit memory.
pub(crate) fn automatic_buffer_size(files: &[OsString]) -> usize {
	let file_hint = file_size_hint(files);
	let mem_hint = available_memory_hint();

	// Prefer the tighter bound when both hints exist, otherwise fall back to
	// whichever hint is available.
	match (file_hint, mem_hint) {
		(Some(file), Some(mem)) => file.min(mem),
		(Some(file), None) => file,
		(None, Some(mem)) => mem,
		(None, None) => crate::FALLBACK_AUTOMATIC_BUF_SIZE,
	}
}

fn file_size_hint(files: &[OsString]) -> Option<usize> {
	// Estimate total bytes across real files; non-regular inputs are skipped.
	let mut total_bytes: u128 = 0;

	for file in files {
		if file == crate::STDIN_FILE {
			continue;
		}

		let Ok(metadata) = std::fs::metadata(pi_uutils_ctx::resolve(file)) else {
			continue;
		};

		if !metadata.is_file() {
			continue;
		}

		total_bytes = total_bytes.saturating_add(metadata.len() as u128);

		if total_bytes >= (crate::MAX_AUTOMATIC_BUF_SIZE as u128) * 8 {
			break;
		}
	}

	if total_bytes == 0 {
		return None;
	}

	let desired_bytes = desired_file_buffer_bytes(total_bytes);
	Some(clamp_hint(desired_bytes))
}

fn available_memory_hint() -> Option<usize> {
	#[cfg(target_os = "linux")]
	if let Some(bytes) = uucore::parser::parse_size::available_memory_bytes() {
		return Some(clamp_hint(bytes / 4));
	}

	physical_memory_bytes().map(|bytes| clamp_hint(bytes / 4))
}

fn clamp_hint(bytes: u128) -> usize {
	let min = crate::MIN_AUTOMATIC_BUF_SIZE as u128;
	let max = crate::MAX_AUTOMATIC_BUF_SIZE as u128;
	let clamped = bytes.clamp(min, max);
	clamped.min(usize::MAX as u128) as usize
}

fn desired_file_buffer_bytes(total_bytes: u128) -> u128 {
	if total_bytes == 0 {
		return 0;
	}

	let max = crate::MAX_AUTOMATIC_BUF_SIZE as u128;

	if total_bytes <= max {
		return total_bytes.saturating_mul(12).clamp(total_bytes, max);
	}

	let quarter = total_bytes / 4;
	quarter.max(max)
}

fn physical_memory_bytes() -> Option<u128> {
	#[cfg(all(
		target_family = "unix",
		not(target_os = "redox"),
		any(target_os = "linux", target_os = "android")
	))]
	{
		physical_memory_bytes_unix()
	}

	#[cfg(any(
		not(target_family = "unix"),
		target_os = "redox",
		not(any(target_os = "linux", target_os = "android"))
	))]
	{
		// No portable or safe API is available here to detect total physical memory.
		None
	}
}

#[cfg(all(
	target_family = "unix",
	not(target_os = "redox"),
	any(target_os = "linux", target_os = "android")
))]
fn physical_memory_bytes_unix() -> Option<u128> {
	use nix::unistd::{SysconfVar, sysconf};

	let pages = match sysconf(SysconfVar::_PHYS_PAGES) {
		Ok(Some(pages)) if pages > 0 => u128::try_from(pages).ok()?,
		_ => return None,
	};

	let page_size = match sysconf(SysconfVar::PAGE_SIZE) {
		Ok(Some(page_size)) if page_size > 0 => u128::try_from(page_size).ok()?,
		_ => return None,
	};

	Some(pages.saturating_mul(page_size))
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn desired_buffer_matches_total_when_small() {
		let six_mebibytes = 6 * 1024 * 1024;
		let expected = ((six_mebibytes as u128) * 12)
			.clamp(six_mebibytes as u128, crate::MAX_AUTOMATIC_BUF_SIZE as u128);
		assert_eq!(desired_file_buffer_bytes(six_mebibytes as u128), expected);
	}

	#[test]
	fn desired_buffer_caps_at_max_for_large_inputs() {
		let large = 256 * 1024 * 1024; // 256 MiB
		assert_eq!(desired_file_buffer_bytes(large as u128), crate::MAX_AUTOMATIC_BUF_SIZE as u128);
	}
}
