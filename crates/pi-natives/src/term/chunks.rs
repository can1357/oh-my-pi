//! Write-size caps that respect op boundaries.
//!
//! Windows `ConPTY` ties viewport tracking to per-`WriteFile` boundaries: when
//! a single write exceeds ~32-64 KB, the pseudo-console stops following the
//! cursor and the host UI's viewport stays parked at whatever scroll position
//! the write started from. A full paint of a long session (resume, history
//! rebuild, large permission dialog) then shows only the first ~30 lines
//! until a focus event forces the host to re-query the cursor (#2034).
//!
//! The cap is on encoded UTF-8 bytes, because those are what reaches
//! `WriteFile`. 16 KiB is half the smallest observed Windows Terminal
//! threshold (32 KiB): it keeps the parked-viewport bug fixed while halving
//! the `WriteFile` count of an 8 KiB cap on multi-megabyte paints, which
//! mitigates the residual mid-paint drift that cap left behind (#2095), and
//! stays clear of the threshold for the other `ConPTY` hosts (Tabby, Hyper, VS
//! Code) whose limit is undocumented.
//!
//! Every boundary between two writes is a point a foreign writer can inject
//! into, so a cut never lands inside an escape sequence or a row's text: the
//! encoder records the end offset of every op, and only those are cut points.

/// Largest single console write under `ConPTY`.
#[cfg(windows)]
pub(super) const MAX_CONSOLE_WRITE_BYTES: usize = 16 * 1024;

/// Feed `bytes` to `write` in chunks of at most `max` bytes, cut only at op
/// ends `marks` (ascending offsets into `bytes`). One op larger than the cap
/// is cut at UTF-8 character boundaries: a single oversized write is strictly
/// worse than a cut inside one op's text. Stops at the first error.
pub(super) fn write_chunked<E>(
	bytes: &[u8],
	marks: &[usize],
	max: usize,
	mut write: impl FnMut(&[u8]) -> Result<(), E>,
) -> Result<(), E> {
	let mut next_mark = 0;
	let mut start = 0;
	while start < bytes.len() {
		let limit = start + max;
		let mut end = if limit >= bytes.len() {
			bytes.len()
		} else {
			// The last op boundary that still fits.
			let mut end = start;
			while let Some(&mark) = marks.get(next_mark)
				&& mark <= limit
			{
				if mark > start {
					end = mark;
				}
				next_mark += 1;
			}
			end
		};
		if end == start {
			end = cut_inside_op(bytes, start, limit);
		}
		write(&bytes[start..end])?;
		start = end;
	}
	Ok(())
}

/// Where to cut `bytes[start..]` when one op alone exceeds the cap: the last
/// UTF-8 character boundary at or before `limit`. A character wider than the
/// whole cap is emitted whole.
fn cut_inside_op(bytes: &[u8], start: usize, limit: usize) -> usize {
	let is_boundary = |at: usize| bytes.get(at).is_none_or(|&byte| byte & 0xc0 != 0x80);
	let mut cut = limit;
	while cut > start && !is_boundary(cut) {
		cut -= 1;
	}
	if cut == start {
		cut = limit;
		while !is_boundary(cut) {
			cut += 1;
		}
	}
	cut
}

#[cfg(test)]
mod tests {
	use std::convert::Infallible;

	use super::*;

	/// Ops appended in order, with their end offsets.
	fn ops(texts: &[&str]) -> (Vec<u8>, Vec<usize>) {
		let mut bytes = Vec::new();
		let mut marks = Vec::new();
		for text in texts {
			bytes.extend_from_slice(text.as_bytes());
			marks.push(bytes.len());
		}
		(bytes, marks)
	}

	fn chunks(bytes: &[u8], marks: &[usize], max: usize) -> Vec<Vec<u8>> {
		let mut chunks = Vec::new();
		write_chunked(bytes, marks, max, |chunk| {
			chunks.push(chunk.to_vec());
			Ok::<_, Infallible>(())
		})
		.unwrap();
		chunks
	}

	#[test]
	fn output_under_the_cap_is_one_write() {
		let (bytes, marks) = ops(&["\x1b[2K", "\n\n\n", "row"]);
		assert_eq!(chunks(&bytes, &marks, 16), [b"\x1b[2K\n\n\nrow".to_vec()]);
		assert!(chunks(&[], &[], 16).is_empty());
	}

	#[test]
	fn capped_output_is_cut_only_between_ops() {
		let (bytes, marks) = ops(&["aaaa", "bbb", "cc", "dddddd", "e", "ffffffff", "g"]);
		let chunks = chunks(&bytes, &marks, 8);
		assert_eq!(chunks, [
			b"aaaabbb".to_vec(),
			b"ccdddddd".to_vec(),
			b"e".to_vec(),
			b"ffffffff".to_vec(),
			b"g".to_vec(),
		]);
		assert!(chunks.iter().all(|chunk| chunk.len() <= 8));
	}

	#[test]
	fn an_op_larger_than_the_cap_is_cut_at_character_boundaries() {
		// 3-byte characters: only two fit beside nothing else in 8 bytes.
		let (bytes, marks) = ops(&["ab", "界界界界界", "z"]);
		let chunks = chunks(&bytes, &marks, 8);
		assert_eq!(chunks, [
			b"ab".to_vec(),
			"界界".as_bytes().to_vec(),
			"界界".as_bytes().to_vec(),
			"界z".as_bytes().to_vec(),
		]);
		assert!(chunks.iter().all(|chunk| str::from_utf8(chunk).is_ok()));
	}

	#[test]
	fn a_character_wider_than_the_cap_is_emitted_whole() {
		let (bytes, marks) = ops(&["a🚀b"]);
		assert_eq!(chunks(&bytes, &marks, 2), [
			b"a".to_vec(),
			"🚀".as_bytes().to_vec(),
			b"b".to_vec(),
		]);
	}

	/// #2034: a full paint far past the `ConPTY` threshold reaches the console
	/// in writes within the cap, every one ending on an op boundary, and
	/// concatenates back to the paint.
	#[test]
	fn a_full_paint_is_split_within_the_console_cap_on_op_boundaries() {
		let mut texts = vec!["\x1b[2J\x1b[H\x1b[3J".to_owned()];
		for row in 0..2000 {
			texts.push(format!(
				"{}\x1b[38;5;{}mrow-{row:04}: {}\x1b[0m",
				if row > 0 { "\r\n" } else { "" },
				row % 256,
				"x".repeat(60),
			));
		}
		texts.push("\x1b[H\x1b[?25h".to_owned());
		let texts: Vec<&str> = texts.iter().map(String::as_str).collect();
		let (bytes, marks) = ops(&texts);
		let cap = 16 * 1024;
		let chunks = chunks(&bytes, &marks, cap);
		assert!(chunks.len() > 1);
		let mut offset = 0;
		for chunk in &chunks {
			assert!(chunk.len() <= cap);
			offset += chunk.len();
			assert!(marks.contains(&offset), "cut at {offset} is inside an op");
		}
		assert_eq!(chunks.concat(), bytes);
	}
}
