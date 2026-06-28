// This file is part of the uutils coreutils package.
//
// For the full copyright and license information, please view the LICENSE
// file that was distributed with this source code.

//! Check if a file is ordered

use std::{
	cmp::Ordering,
	ffi::OsStr,
	io::Read,
	iter,
	sync::mpsc::{Receiver, SyncSender, sync_channel},
	thread,
};

use itertools::Itertools;
use uucore::error::UResult;

use crate::{
	GlobalSettings, SortError,
	chunks::{self, Chunk, RecycledChunk},
	compare_by, open,
};

/// Check if the file at `path` is ordered.
///
/// # Returns
///
/// The code we should exit with.
pub fn check(path: &OsStr, settings: &GlobalSettings) -> UResult<()> {
	let max_allowed_cmp = if settings.unique {
		// If `unique` is enabled, the previous line must compare _less_ to the next
		// one.
		Ordering::Less
	} else {
		// Otherwise, the line previous line must compare _less or equal_ to the next
		// one.
		Ordering::Equal
	};
	let file = open(path)?;
	let (recycled_sender, recycled_receiver) = sync_channel(2);
	let (loaded_sender, loaded_receiver) = sync_channel(2);
	thread::spawn({
		let settings = settings.clone();
		move || reader(file, &recycled_receiver, &loaded_sender, &settings)
	});
	for _ in 0..2 {
		let _ = recycled_sender.send(RecycledChunk::new(if settings.buffer_size < 100 * 1024 {
			// when the buffer size is smaller than 100KiB we choose it instead of the
			// default. this improves testability.
			settings.buffer_size
		} else {
			100 * 1024
		}));
	}

	let mut prev_chunk: Option<Chunk> = None;
	let mut line_idx = 0;
	for chunk in loaded_receiver {
		line_idx += 1;
		if let Some(prev_chunk) = prev_chunk.take() {
			// Check if the first element of the new chunk is greater than the last
			// element from the previous chunk
			let prev_last = prev_chunk.lines().last().unwrap();
			let new_first = chunk.lines().first().unwrap();

			if compare_by(prev_last, new_first, settings, prev_chunk.line_data(), chunk.line_data())
				> max_allowed_cmp
			{
				return Err(
					SortError::Disorder {
						file:        path.to_owned(),
						line_number: line_idx,
						line:        String::from_utf8_lossy(new_first.line).into_owned(),
						silent:      settings.check_silent,
					}
					.into(),
				);
			}
			let _ = recycled_sender.send(prev_chunk.recycle());
		}

		for (a, b) in chunk.lines().iter().tuple_windows() {
			line_idx += 1;
			if compare_by(a, b, settings, chunk.line_data(), chunk.line_data()) > max_allowed_cmp {
				return Err(
					SortError::Disorder {
						file:        path.to_owned(),
						line_number: line_idx,
						line:        String::from_utf8_lossy(b.line).into_owned(),
						silent:      settings.check_silent,
					}
					.into(),
				);
			}
		}

		prev_chunk = Some(chunk);
	}
	Ok(())
}

/// The function running on the reader thread.
fn reader(
	mut file: Box<dyn Read + Send>,
	receiver: &Receiver<RecycledChunk>,
	sender: &SyncSender<Chunk>,
	settings: &GlobalSettings,
) -> UResult<()> {
	let mut carry_over = vec![];
	for recycled_chunk in receiver {
		let should_continue = chunks::read(
			sender,
			recycled_chunk,
			None,
			&mut carry_over,
			&mut file,
			&mut iter::empty(),
			settings.line_ending.into(),
			settings,
		)?;
		if !should_continue {
			break;
		}
	}
	Ok(())
}
