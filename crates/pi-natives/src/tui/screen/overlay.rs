//! Overlay compositing: splices the host's rendered overlay rows into the
//! frame about to be painted (`compositeOverlays` / `compositeLineAt` in
//! pi-tui).
//!
//! The host resolves each visible overlay's layout (it needs the rendered
//! height first), renders it at its resolved width, and hands the rows plus
//! placement over with the frame. Overlays never touch the provider's frame:
//! composited rows exist only in the painted window, and commits are frozen
//! while an overlay is visible, so overlay pixels can never enter native
//! scrollback.

use std::borrow::Cow;

use super::{Screen, images::is_image_line};
use crate::{
	text::{self, DEFAULT_TAB_WIDTH},
	tui::types::{ImageProtocol, Size},
};

const SEGMENT_RESET: &str = "\x1b[0m";

/// One visible overlay, in stack order (later = on top).
#[derive(Clone, Debug, Default)]
pub struct Overlay {
	/// Screen row of the first line; lines outside the frame are skipped.
	pub row:   i32,
	/// Screen column the overlay starts at.
	pub col:   u32,
	/// Resolved overlay width; wider lines are cut to it.
	pub width: u32,
	/// The rendered lines, already cut to the overlay's maximum height.
	pub lines: Vec<String>,
}

impl Screen {
	/// Composite `overlays` onto `rows`, padded to the full screen height
	/// first. Without overlays the rows are left untouched (not padded).
	pub fn composite_overlays(&self, rows: &mut Vec<String>, overlays: &[Overlay], size: Size) {
		composite_padded(self.image_protocol, rows, overlays, size);
	}
}

/// [`Screen::composite_overlays`] for an image protocol.
fn composite_padded(
	protocol: Option<ImageProtocol>,
	rows: &mut Vec<String>,
	overlays: &[Overlay],
	size: Size,
) {
	if overlays.is_empty() {
		return;
	}
	let height = size.rows as usize;
	if rows.len() < height {
		rows.resize(height, String::new());
	}
	composite(protocol, rows, overlays, size.columns);
}

/// Composite every overlay onto `rows` (screen coordinates), in order.
fn composite(
	protocol: Option<ImageProtocol>,
	rows: &mut [String],
	overlays: &[Overlay],
	total_width: u32,
) {
	for overlay in overlays {
		let width = overlay.width;
		for (offset, line) in overlay.lines.iter().enumerate() {
			let Some(index) = i64::from(overlay.row)
				.checked_add(offset as i64)
				.and_then(|index| usize::try_from(index).ok())
				.filter(|&index| index < rows.len())
			else {
				continue;
			};
			let line = if text::visible_width_str(line, DEFAULT_TAB_WIDTH) > width as usize {
				Cow::Owned(slice_by_column(line, width))
			} else {
				Cow::Borrowed(line.as_str())
			};
			rows[index] =
				composite_line_at(protocol, &rows[index], &line, overlay.col, width, total_width);
		}
	}
}

/// The first `width` columns of `line`, never splitting a wide character at
/// the boundary.
fn slice_by_column(line: &str, width: u32) -> String {
	text::slice_with_width_str(line, 0, width as usize, true, DEFAULT_TAB_WIDTH).0
}

/// Splice `overlay` into `base` at `start_col`, `overlay_width` columns wide,
/// in a `total_width`-column row.
pub(crate) fn composite_line_at(
	protocol: Option<ImageProtocol>,
	base: &str,
	overlay: &str,
	start_col: u32,
	overlay_width: u32,
	total_width: u32,
) -> String {
	// A full-width image row owns its terminal row; the writer must see its
	// exact placement shape.
	if start_col == 0 && overlay_width >= total_width && is_image_line(protocol, overlay) {
		return overlay.to_owned();
	}
	if is_image_line(protocol, base) {
		// Full-width overlays such as /switch are opaque: replace the Unicode
		// placeholder cells so the image cannot cover the modal. Partial
		// overlays cannot safely splice placement control sequences.
		if start_col != 0 || overlay_width < total_width {
			return base.to_owned();
		}
		let (text, width) =
			text::slice_with_width_str(overlay, 0, total_width as usize, true, DEFAULT_TAB_WIDTH);
		let mut row = String::with_capacity(SEGMENT_RESET.len() + text.len() + total_width as usize);
		row.push_str(SEGMENT_RESET);
		row.push_str(&text);
		push_spaces(&mut row, (total_width as usize).saturating_sub(width));
		return row;
	}

	// One pass through the base extracts both the before and after segments.
	let start = start_col as usize;
	let overlay_cols = overlay_width as usize;
	let total = total_width as usize;
	let after_start = start + overlay_cols;
	let (before, before_width, after, after_width) = text::extract_segments_str(
		base,
		start,
		after_start,
		total.saturating_sub(after_start),
		true,
		DEFAULT_TAB_WIDTH,
	);
	// Strict: a wide character at the boundary is dropped, not split.
	let (overlay_text, overlay_text_width) =
		text::slice_with_width_str(overlay, 0, overlay_cols, true, DEFAULT_TAB_WIDTH);

	// Pad the segments to their target widths.
	let before_pad = start.saturating_sub(before_width);
	let overlay_pad = overlay_cols.saturating_sub(overlay_text_width);
	let actual_before_width = start.max(before_width);
	let actual_overlay_width = overlay_cols.max(overlay_text_width);
	let after_target = total.saturating_sub(actual_before_width + actual_overlay_width);
	let after_pad = after_target.saturating_sub(after_width);

	let mut row = String::with_capacity(
		before.len() + overlay_text.len() + after.len() + 2 * SEGMENT_RESET.len() + total,
	);
	row.push_str(&before);
	push_spaces(&mut row, before_pad);
	row.push_str(SEGMENT_RESET);
	row.push_str(&overlay_text);
	push_spaces(&mut row, overlay_pad);
	row.push_str(SEGMENT_RESET);
	row.push_str(&after);
	push_spaces(&mut row, after_pad);

	// Always verify and truncate to the terminal width: the final safeguard
	// against width overflow, since width tracking can drift from the actual
	// visible width (complex ANSI/OSC sequences, wide characters at segment
	// boundaries, segment-extraction edge cases).
	if text::visible_width_str(&row, DEFAULT_TAB_WIDTH) <= total {
		return row;
	}
	slice_by_column(&row, total_width)
}

fn push_spaces(row: &mut String, count: usize) {
	row.extend(std::iter::repeat_n(' ', count));
}

#[cfg(test)]
mod tests {
	use super::*;

	const R: &str = SEGMENT_RESET;

	fn overlay(row: i32, col: u32, width: u32, lines: &[&str]) -> Overlay {
		Overlay { row, col, width, lines: lines.iter().map(|&line| line.to_owned()).collect() }
	}

	#[test]
	fn splices_an_overlay_between_base_segments() {
		let row = composite_line_at(None, "abcdefghij", "XY", 3, 2, 10);
		assert_eq!(row, format!("abc{R}XY{R}fghij"));
	}

	#[test]
	fn pads_a_short_base_and_a_short_overlay() {
		let row = composite_line_at(None, "ab", "X", 4, 3, 10);
		assert_eq!(row, format!("ab  {R}X  {R}   "));
	}

	#[test]
	fn drops_a_wide_character_straddling_the_overlay_edge() {
		// "日" is two cells: it does not fit the one remaining overlay column.
		let row = composite_line_at(None, "..........", "a日", 0, 2, 10);
		assert_eq!(row, format!("{R}a {R}........"));
		assert_eq!(text::visible_width_str(&row, DEFAULT_TAB_WIDTH), 10);
	}

	#[test]
	fn restores_base_styling_after_the_overlay() {
		let row = composite_line_at(None, "\x1b[31mredredred\x1b[0m", "X", 2, 1, 9);
		let (before, after) = row.split_once(&format!("{R}X{R}")).unwrap();
		assert_eq!(before, "\x1b[31mre");
		assert!(after.contains("31") && after.ends_with("redred"), "{row:?}");
	}

	#[test]
	fn image_rows_are_opaque_to_partial_overlays_and_replaced_by_full_width_ones() {
		let kitty = Some(ImageProtocol::Kitty);
		let image = "\x1b7\x1b[3A\x1b_Ga=p,q=2,C=1,i=5,p=5,c=4,r=4\x1b\\\x1b8";
		assert_eq!(composite_line_at(kitty, image, "modal", 2, 5, 10), image);
		assert_eq!(composite_line_at(kitty, image, "modal", 0, 10, 10), format!("{R}modal     "));
		// A full-width image overlay keeps its exact placement shape.
		assert_eq!(composite_line_at(kitty, "base", image, 0, 10, 10), image);
		// Without an image protocol the markers are plain text.
		assert_ne!(composite_line_at(None, image, "modal", 2, 5, 10), image);
	}

	#[test]
	fn composites_in_stack_order_and_clips_rows_and_width() {
		let mut rows = vec!["0000000000".to_owned(), "1111111111".to_owned()];
		let overlays =
			[overlay(-1, 0, 4, &["hidden", "AAAAAA", "BBBB"]), overlay(1, 2, 2, &["C", "offscreen"])];
		composite(None, &mut rows, &overlays, 10);
		assert_eq!(rows[0], format!("{R}AAAA{R}000000"));
		assert_eq!(rows[1], format!("{R}BB{R}C {R}111111"));
	}

	#[test]
	fn pads_to_the_screen_height_only_when_overlays_are_present() {
		let size = Size { columns: 4, rows: 3 };
		let mut rows = vec!["ab".to_owned()];
		composite_padded(None, &mut rows, &[], size);
		assert_eq!(rows, ["ab"]);
		composite_padded(None, &mut rows, &[overlay(2, 0, 4, &["zz"])], size);
		assert_eq!(rows, ["ab".to_owned(), String::new(), format!("{R}zz  {R}")]);
	}
}
