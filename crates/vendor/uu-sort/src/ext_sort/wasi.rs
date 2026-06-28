// This file is part of the uutils coreutils package.
//
// For the full copyright and license information, please view the LICENSE
// file that was distributed with this source code.

//! WASI single-threaded sort: read all input into memory, sort, and output.
//! Threads are not available on WASI, so we bypass the chunked/threaded path.

use std::{cmp::Ordering, io::Read};

use itertools::Itertools;
use uucore::error::UResult;

use crate::{
	GlobalSettings, Output,
	chunks::{self, Chunk},
	compare_by, print_sorted, sort_by,
	tmp_dir::TmpDirWrapper,
};

/// Sort files by reading all input into memory, sorting in a single thread, and
/// outputting directly.
pub fn ext_sort(
	files: &mut impl Iterator<Item = UResult<Box<dyn Read + Send>>>,
	settings: &GlobalSettings,
	output: Output,
	_tmp_dir: &mut TmpDirWrapper,
) -> UResult<()> {
	let separator = settings.line_ending.into();
	// Read all input into memory at once. Unlike the threaded path which uses
	// chunked buffered reads, WASI has no threads so we accept the memory cost.
	// Note: there is no size limit here — WASI targets are expected to handle
	// moderately sized inputs; very large files may cause OOM.
	let mut input = Vec::new();
	for file in files {
		file?.read_to_end(&mut input)?;
	}
	if input.is_empty() {
		return Ok(());
	}
	let mut chunk = Chunk::try_new(input, |buffer| {
		Ok::<_, Box<dyn uucore::error::UError>>(chunks::parse_into_chunk(buffer, separator, settings))
	})?;
	chunk.with_dependent_mut(|_, contents| {
		sort_by(&mut contents.lines, settings, &contents.line_data);
	});
	if settings.unique {
		print_sorted(
			chunk.lines().iter().dedup_by(|a, b| {
				compare_by(a, b, settings, chunk.line_data(), chunk.line_data()) == Ordering::Equal
			}),
			settings,
			output,
		)?;
	} else {
		print_sorted(chunk.lines().iter(), settings, output)?;
	}
	Ok(())
}
