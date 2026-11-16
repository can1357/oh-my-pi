//! The normal-buffer paint transaction and the row writers every paint
//! shares.
//!
//! A plan frame is one physical write: optional history rows followed by
//! the complete mutable viewport, anchored directly below whatever history
//! remains on screen. Rows are diffed against the previous frame where the
//! geometry allows, moved with DL/IL where the terminal may present a
//! partial write, and rewritten top-down otherwise.

use std::{borrow::Cow, collections::HashMap, iter, mem, rc::Rc};

use super::{
	RenderRequest, Screen, emit,
	images::{self, KittyPlacementLine, SixelCropper},
	moves::{self, BLANK_ROW, UNKNOWN_ROW},
	prepare::{HYPERLINK_CLOSE, Prepared, PreparedLine, SEGMENT_RESET},
	text,
};
use crate::{
	term::{Batch, Device, mode},
	tui::{
		budget::{Budget, FrameImages},
		types::{ImageProtocol, Millis, Paint, PlanFrame, PresentResult, ResizeScrollback, Size},
	},
};

/// Smallest settled tmux replay that is preceded by a `Rebuilding…` notice.
/// The notice can only be published ahead of the replay (tmux holds the
/// pane's synchronized update until the replay ends), so it stays up for
/// exactly as long as tmux takes to ingest the replay. tmux next-3.9 on
/// Apple silicon ingests a real transcript replay at ~14 MiB/s, so this is
/// about half a second there. A smaller replay finishes before the notice
/// can be read, and showing it would only flash a status row.
const RESIZE_REBUILD_NOTICE_MIN_BYTES: usize = 7 * 1024 * 1024;
/// Band moves per unsynchronized frame: a streaming shift, the chrome a
/// history push displaced, and one spare.
const MAX_ROW_MOVES: usize = 3;
/// Framing bytes a rewritten row adds around its content (reset, CR, LF),
/// for the replay size estimate.
const ROW_FRAMING_BYTES: usize = 8;
/// Cell height assumed until the terminal reports one.
const DEFAULT_CELL_HEIGHT_PX: u32 = 18;

/// A cursor-positioned image owned by a mutable viewport, never by history.
pub(super) struct LivePlacement {
	image_id:     u32,
	placement_id: u32,
	line:         Rc<str>,
}

/// Live Kitty placements keyed by the row that carries them, in insertion
/// order (the order their deletes are written in).
#[derive(Default)]
pub(super) struct Placements(Vec<(u32, LivePlacement)>);

impl Placements {
	pub(super) fn clear(&mut self) {
		self.0.clear();
	}

	pub(super) const fn is_empty(&self) -> bool {
		self.0.is_empty()
	}

	fn get(&self, row: u32) -> Option<&LivePlacement> {
		self
			.0
			.iter()
			.find(|entry| entry.0 == row)
			.map(|entry| &entry.1)
	}

	fn set(&mut self, row: u32, placement: LivePlacement) {
		match self.0.iter_mut().find(|entry| entry.0 == row) {
			Some(entry) => entry.1 = placement,
			None => self.0.push((row, placement)),
		}
	}

	/// Whether [`emit_retired_image_placements`] would delete anything.
	pub(super) fn any_retired(&self, lines: &[Rc<str>], top: u32, repaint: bool) -> bool {
		self
			.0
			.iter()
			.any(|(row, placement)| !placement_survives(*row, placement, lines, top, repaint))
	}
}

fn placement_survives(
	row: u32,
	placement: &LivePlacement,
	lines: &[Rc<str>],
	top: u32,
	repaint: bool,
) -> bool {
	!repaint
		&& row
			.checked_sub(top)
			.and_then(|index| lines.get(index as usize))
			.is_some_and(|line| **line == *placement.line)
}

/// Remove placements before their viewport cells are replaced. History uses
/// separate placement ids, so deleting a live copy cannot erase scrollback.
pub(super) fn emit_retired_image_placements(
	b: &mut Batch<'_>,
	placements: &mut Placements,
	lines: &[Rc<str>],
	top: u32,
	repaint: bool,
	tmux: bool,
) {
	placements.0.retain(|(row, placement)| {
		if placement_survives(*row, placement, lines, top, repaint) {
			return true;
		}
		b.text(&images::encode_kitty_delete_placement(
			placement.image_id,
			placement.placement_id,
			tmux,
		));
		false
	});
}

/// Per-line terminator written after every non-image content row. It closes
/// both SGR state and any in-flight OSC 8 hyperlink so styles/links cannot
/// bleed across lines in scrollback. Kept out of the diff/width cache
/// because reset bytes are deterministic write framing, not content.
pub(super) fn emit_line_terminator(b: &mut Batch<'_>) {
	b.sgr(0).text(HYPERLINK_CLOSE);
}

/// Row content and its terminator. `content` is the row's terminal content,
/// or its REP-compacted form; the terminator holds no spaces, so compacting
/// the content alone is the same bytes as compacting the terminated row.
fn emit_terminal_line(b: &mut Batch<'_>, line: &PreparedLine, content: &str) {
	b.text(content);
	if line.has_osc8 {
		emit_line_terminator(b);
	} else if !line.terminal_content.ends_with(SEGMENT_RESET) {
		b.sgr(0);
	}
}

/// Erase `row` and everything below it, absolute-addressed, without ever
/// issuing a full-screen clear. tmux and Windows conhost (#9597) archive a
/// screen-wide erase into pane history instead of discarding it, so an
/// erase anchored on the first row would preserve the unfinished frame it
/// exists to remove (#9780). Below existing history a plain ED0 cannot span
/// the screen; on the first row, EL2 that row and ED0 from the second down
/// touch the same cells with no full-screen clear. `row` is clamped because
/// a caller's viewport top can predate a height shrink.
/// Every form leaves the cursor on the clamped row at column zero.
pub(super) fn emit_erase_below_row(b: &mut Batch<'_>, row: u32, height: u32) {
	let top = row.min(height.saturating_sub(1));
	if top > 0 {
		b.move_to(top + 1, 1).erase_below();
		return;
	}
	b.move_to(1, 1).erase_line();
	if height > 1 {
		b.move_to(2, 1).erase_below().move_to(1, 1);
	}
}

/// Erase the cursor's row and everything below it, cursor-relative, without
/// ever issuing a full-screen clear. Used where the resize path must stay
/// cursor-relative: the terminal reflowed the normal buffer, so absolute
/// rows are stale and only the parked cursor still tracks the viewport's
/// logical line. Every form leaves the cursor on column zero of that row,
/// exactly where a plain CR + ED0 left it.
///
/// The erase must never run from the first cell, which is what makes tmux
/// and Windows conhost (#9597) archive the screen instead of discarding it
/// (#9780), and a clamped CUU can put the cursor on the first row without
/// naming it. Stepping one column right is enough and needs no row
/// movement, but at one column CUF cannot leave the first cell, so step one
/// row down instead: from the first row that can only reach row 1, and
/// DECSC/DECRC restores the anchor even when CUD clamps at the last row. A
/// one-row screen has nothing below the cursor, so EL2 alone clears
/// everything.
pub(super) fn emit_erase_below_cursor_row(b: &mut Batch<'_>, width: u32, height: u32) {
	b.cr().erase_line();
	if height <= 1 {
		return;
	}
	if width > 1 {
		b.forward(1).erase_below().cr();
	} else {
		b.save_cursor().down(1).erase_below().restore_cursor();
	}
}

/// Bottom-row `Rebuilding…` notice, closed as its own synchronized update
/// so tmux forwards it before the replay that follows starts a new hold.
/// Cursor save/restore and no newline keep the row out of native
/// scrollback; the replay's ED2 erases it together with the rest of the
/// screen.
fn emit_rebuild_notice(b: &mut Batch<'_>, sync: bool, width: u32, height: u32) {
	let label = text::truncate_to_width("↻ Rebuilding…", width);
	b.frame_begin(sync, false)
		.save_cursor()
		.move_to(height, 1)
		.sgr(0)
		.erase_line()
		.text(&label);
	emit_line_terminator(b);
	b.restore_cursor().frame_end();
}

/// Whether screen row `index` must be rewritten to turn the previously
/// painted frame into this one: its line, or the preparation it was painted
/// with, changed.
pub(super) fn row_needs_rewrite(
	previous_lines: &[Rc<str>],
	previous_rows: &[Rc<PreparedLine>],
	lines: &[Rc<str>],
	rows: &[Rc<PreparedLine>],
	index: usize,
) -> bool {
	let (Some(previous_line), Some(previous)) =
		(previous_lines.get(index), previous_rows.get(index))
	else {
		return true;
	};
	let current = &rows[index];
	let line = &lines[index];
	(!Rc::ptr_eq(previous_line, line) && **previous_line != **line)
		|| previous.width != current.width
		|| previous.width_epoch != current.width_epoch
		|| previous.image_protocol != current.image_protocol
}

/// `/\S/`: whether `line` holds anything but ECMAScript whitespace.
fn has_non_whitespace(line: &str) -> bool {
	line.chars().any(|c| {
		!matches!(
			c,
			'\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
				..='\u{200a}'
					| '\u{2028}'
					| '\u{2029}'
					| '\u{202f}'
					| '\u{205f}'
					| '\u{3000}'
					| '\u{feff}'
		)
	})
}

pub(super) fn to_strings(lines: &[Rc<str>]) -> Vec<String> {
	lines.iter().map(|line| String::from(&**line)).collect()
}

/// How one row is rewritten (see [`RowPainter::line_rewrite`]).
#[derive(Default)]
pub(super) struct Rewrite<'a> {
	/// The row's index within the frame it belongs to (see
	/// [`RowPainter::image_line`]); `None` writes an image line verbatim.
	pub(super) frame_row:          Option<u32>,
	/// The row is a reserved lower half of a scaled OSC 66 heading whose
	/// glyph owns this many leading columns.
	pub(super) spacer_glyph_width: Option<u32>,
	/// The row is part of a destructive replay onto a cleared screen: its
	/// (REP-compacted) content, written without an erase.
	pub(super) replay_content:     Option<&'a str>,
	/// Live Kitty placements of the buffer being painted; `None` for rows
	/// bound for history.
	pub(super) placements:         Option<&'a mut Placements>,
	/// The physical row keying live Kitty placements; defaults to
	/// `frame_row`.
	pub(super) image_row:          Option<u32>,
	/// The image budget, for the source heights of kitty direct placements.
	pub(super) budget:             Option<&'a Budget>,
}

/// Row-writing state shared by every paint path.
pub(super) struct RowPainter {
	next_placement_id: u32,
	/// Last top-clipped SIXEL crop; only the block straddling row 0 is ever
	/// cropped.
	sixel:             SixelCropper,
	cell_height_px:    u32,
	/// Wrap Kitty graphics commands in tmux passthrough.
	tmux:              bool,
	/// Texts reported when a written row contains them, with the per-write
	/// hit flags.
	watches:           Vec<String>,
	hits:              Vec<bool>,
}

impl RowPainter {
	pub(super) fn new(tmux: bool) -> Self {
		Self {
			next_placement_id: 1,
			sixel: SixelCropper::default(),
			cell_height_px: DEFAULT_CELL_HEIGHT_PX,
			tmux,
			watches: Vec::new(),
			hits: Vec::new(),
		}
	}

	pub(super) const fn tmux(&self) -> bool {
		self.tmux
	}

	pub(super) const fn set_cell_height(&mut self, height_px: u32) {
		self.cell_height_px = height_px;
	}

	pub(super) fn set_watches(&mut self, texts: Vec<String>) {
		self.hits.clear();
		self.hits.resize(texts.len(), false);
		self.watches = texts;
	}

	/// Move the watched texts the rows written since the last call contained
	/// into `out`, once each.
	pub(super) fn take_hits(&mut self, out: &mut Vec<String>) {
		for (hit, text) in self.hits.iter_mut().zip(&self.watches) {
			if mem::take(hit) {
				out.push(text.clone());
			}
		}
	}

	#[inline]
	fn note_row(&mut self, line: &str) {
		if self.watches.is_empty() {
			return;
		}
		for (hit, text) in self.hits.iter_mut().zip(&self.watches) {
			if !*hit && line.contains(text.as_str()) {
				*hit = true;
			}
		}
	}

	/// Emit the ops that rewrite one row, starting at column 1 of it.
	pub(super) fn line_rewrite(
		&mut self,
		b: &mut Batch<'_>,
		line: &PreparedLine,
		width: u32,
		options: Rewrite<'_>,
	) {
		self.note_row(&line.line);
		// Reserved lower half of a scaled OSC 66 heading. The glyph
		// re-emitted on the row above owns columns `[0, glyph_width)` here,
		// so preserve them (any erase there clears the glyph — issue #8318)
		// but still clear stale cells to their right: a row can reflow from
		// wider text into this spacer, and the glyph write never covers
		// those columns. Leading reset keeps the erase on the default
		// background (BCE).
		if let Some(glyph_width) = options.spacer_glyph_width {
			if glyph_width < width {
				b.sgr(0).forward(glyph_width).erase_line_to_end();
			}
		} else if line.is_image {
			b.erase_line();
			self.image_line(
				b,
				&line.line,
				options.frame_row,
				options.placements,
				options.image_row.or(options.frame_row),
				options.budget,
			);
		} else if let Some(content) = options.replay_content {
			// A destructive replay starts on a cleared screen and advances
			// only into fresh rows. Each line resets its rendition before
			// scrolling, so those rows already have the default background.
			// Re-erasing every row only adds terminal parser work; images and
			// OSC 66 spacers keep their dedicated cleanup above.
			emit_terminal_line(b, line, content);
		} else if let Some(ascii_width) = line.ascii_width {
			// Exact width model: skip the erase only when the row truly fills
			// the line (an EL there would eat the last cell via pending-wrap).
			emit_terminal_line(b, line, &line.terminal_content);
			if ascii_width < width {
				b.erase_line_to_end();
			}
		} else {
			// Non-ASCII rows: the native measure can over-count
			// combining-heavy scripts, so a row it calls "full" may render
			// short and leave stale cells from the previous occupant — which
			// would then scroll into history baked into the committed row.
			// Erase the line first instead (rewrites always start at column
			// 1, so EL-to-end clears the whole row); the leading reset keeps
			// BCE on the default background.
			b.sgr(0).erase_line_to_end();
			emit_terminal_line(b, line, &line.terminal_content);
		}
		// End every rewrite at column zero. ConPTY can materialize a pending
		// wrap before a following cursor-addressing sequence even while
		// DECAWM is disabled; on the bottom row that becomes an untracked
		// scroll and leaks live chrome into native history (#9783). The row
		// loops append only LF because this CR supplies the other half of
		// their explicit CRLF.
		b.cr();
	}

	/// Clip direct placements to the visible source slice: Kitty tracks a
	/// live placement owner, while SIXEL crops the encoded raster. An iTerm2
	/// image or a Kitty transmit-and-display image cannot be cropped, so a
	/// block clipped at the top is omitted rather than painted over
	/// following text. SIXEL and iTerm2 have no delete command and composite
	/// over existing pixels, so erase the visible rows they paint above the
	/// line before repainting.
	///
	/// `frame_row` is the line's row within the frame it was rendered in, so
	/// at most that many rows above it belong to its image block. A viewport
	/// whose top clips a block sits below history rows on screen; bounding
	/// the lift by the physical row instead would erase and paint over those
	/// history rows just before they scroll into native scrollback.
	fn image_line(
		&mut self,
		b: &mut Batch<'_>,
		line: &Rc<str>,
		frame_row: Option<u32>,
		placements: Option<&mut Placements>,
		placement_row: Option<u32>,
		budget: Option<&Budget>,
	) {
		let Some(frame_row) = frame_row else {
			b.text(line);
			return;
		};
		let Some(parsed) = images::parse_kitty_direct_placement_line(line) else {
			let requested_lift = images::direct_placement_lift(line);
			let lift = requested_lift.min(frame_row);
			let content = if requested_lift > lift {
				let crop_pixels = (requested_lift - lift) * self.cell_height_px;
				let max_height_pixels = (frame_row + 1) * self.cell_height_px;
				// Re-anchoring an uncropped OSC/APC image would paint its
				// hidden rows below the reserved slice, over the following
				// text.
				let Some(clipped) = self.sixel.clip_line(line, crop_pixels, max_height_pixels) else {
					return;
				};
				Cow::Owned(images::with_direct_placement_lift(&clipped, lift).into_owned())
			} else {
				Cow::Borrowed(&**line)
			};
			b.up(lift);
			for _ in 0..lift {
				b.erase_line().down(1);
			}
			b.text(&content);
			return;
		};
		let placement_row = placement_row.unwrap_or(frame_row);
		let previous = placements
			.as_deref()
			.and_then(|placements| placements.get(placement_row))
			.map(|placement| (placement.image_id, placement.placement_id));
		let placement_id = if let Some((image_id, placement_id)) = previous {
			b.text(&images::encode_kitty_delete_placement(image_id, placement_id, self.tmux));
			placement_id
		} else {
			let id = self.next_placement_id;
			self.next_placement_id += 1;
			id
		};
		if let Some(placements) = placements {
			placements.set(placement_row, LivePlacement {
				image_id: parsed.image_id,
				placement_id,
				line: Rc::clone(line),
			});
		}
		let image_height_px = budget.map_or(0.0, |budget| budget.placement_height(parsed.image_id));
		b.text(&images::encode_kitty_placement_line(
			KittyPlacementLine {
				image_id: parsed.image_id,
				placement_id,
				columns: parsed.columns,
				rows: parsed.rows,
				screen_row: frame_row,
				image_height_px,
			},
			self.tmux,
		));
	}
}

impl Screen {
	/// Paint a normal-buffer frame: append the offered history batch (or
	/// bottom-split a complete replay into a history remainder and the final
	/// viewport), then the complete mutable viewport, serialized as one
	/// terminal write before the batch is acknowledged.
	///
	/// The host composes overlays and runs its image-budget passes first, so
	/// `frame.viewport` is the complete frame; the purges and transmits it
	/// queued are drained from the budget here.
	///
	/// Image data is only known to be queued once the frame is composed, so
	/// a frame carrying the session's first transmits on Ghostty is dropped
	/// here, unpainted and unacknowledged, while its startup window lasts:
	/// the budget keeps the transmits queued and the delay's expiry renders
	/// again.
	pub fn present_plan(
		&mut self,
		now: Millis,
		size: Size,
		frame: PlanFrame,
		device: &mut Device,
	) -> PresentResult {
		let mut result = PresentResult::default();
		if !self.stopped
			&& self.defer_ghostty_initial_image_paint(now, self.image_transmits_pending())
		{
			self.finish_frame(now);
			return result;
		}
		let images = self.drain_frame_images(self.clear_scrollback_on_next_render);
		if !self.stopped && size.columns > 0 && size.rows > 0 {
			self.emit_plan_frame(now, size, frame, &images, device, &mut result);
		}
		self.finish_frame(now);
		result
	}

	/// Physical write transaction: append an ordinary batch, or bottom-split
	/// one complete replay into a history remainder and final viewport, then
	/// serialize the whole result in one terminal write before
	/// acknowledgement.
	fn emit_plan_frame(
		&mut self,
		now: Millis,
		size: Size,
		frame: PlanFrame,
		images: &FrameImages,
		device: &mut Device,
		result: &mut PresentResult,
	) {
		let PlanFrame { history: offered, mut viewport, want_paint } = frame;
		let budget = self.budget.clone();
		let budget = budget.as_ref().map(|budget| budget.borrow());
		let budget = budget.as_deref();
		let Size { columns: width, rows: height } = size;
		let height_rows = height as usize;
		// The viewport contract is at most `height` rows; the host reports a
		// violation, the paint only has to survive it.
		viewport.truncate(height_rows);
		let history = match offered {
			Some(batch) if batch.id > self.accepted_history_batch_id => Some(batch),
			Some(batch) => {
				result.acknowledged.push(batch.id);
				None
			},
			None => None,
		};
		let history_id = history.as_ref().map(|batch| batch.id);
		let replay = history.as_ref().is_some_and(|batch| batch.replay);
		let mut history_rows = history.map_or_default(|batch| batch.rows);
		let mut replay_viewport_rows = 0;
		let mut replay_prepended_blanks = 0;
		if replay {
			// Providers may omit unused leading rows from a short viewport.
			// Make that logical space explicit before the bottom-first replay
			// split.
			replay_prepended_blanks = height_rows - viewport.len();
			viewport.splice(0..0, iter::repeat_n(String::new(), replay_prepended_blanks));
			let leading_blank_rows = viewport
				.iter()
				.take_while(|line| !has_non_whitespace(line))
				.count();
			let moved = history_rows.len().min(leading_blank_rows);
			if moved > 0 {
				let tail = history_rows.split_off(history_rows.len() - moved);
				viewport.splice(0..moved, tail);
				replay_viewport_rows = moved;
			}
		}
		// History first: it reuses the previous viewport's rows by content,
		// and the viewport pass replaces that memo with its own rows.
		let prepared_history =
			self
				.preparer
				.prepare_lines(&history_rows, width, &[], history_rows.len(), None);
		let mut markers = Vec::new();
		let prepared = self.preparer.prepare_lines(
			&viewport,
			width,
			&self.provider_rows,
			viewport.len(),
			Some(&mut markers),
		);
		let rows = prepared.lines.len();
		let history_len = prepared_history.lines.len();
		// Destructive reset (session replace, /tree, explicit clear, or a
		// settled resize in rebuild mode): erase native history and the
		// viewport, then repaint from row zero.
		let destructive_reset = self.clear_scrollback_on_next_render;
		let compact_replay = destructive_reset && self.facts.multiplexer.expands_rep_padding;
		if destructive_reset {
			self.provider_viewport_top = 0;
			self.provider_window.clear();
			self.provider_rows.clear();
			self.provider_history_written = false;
		}
		// The viewport stays anchored directly below whatever history remains
		// on screen. Appending K history rows moves the anchor down by K; the
		// write scrolls only when history + viewport overflow the physical
		// screen, and the rows that scroll off the top are exactly the oldest
		// history rows.
		let geometry_stable =
			self.has_ever_rendered && self.previous_width == width && self.previous_height == height;
		let start_top = if destructive_reset {
			0
		} else {
			self.provider_viewport_top.min(height - 1)
		};
		let new_top = (start_top + history_len as u32).min(height - rows as u32);
		let pending_alt_exit = self.pending_alt_exit;
		let sync = self.synchronized_output;
		// tmux expires synchronized output after one second, so large replays
		// renew it as the output queue drains (the device re-opens it between
		// ops, at complete sequence/row boundaries).
		let renew_sync = destructive_reset
			&& self.resize_scrollback == ResizeScrollback::Rebuild
			&& sync
			&& self.facts.multiplexer.expires_synchronized_output;
		let force = self.force_viewport_repaint_on_next_render;
		let diffable = geometry_stable
			&& history_len == 0
			&& start_top == new_top
			&& !force
			&& !destructive_reset
			&& !self.provider_window.is_empty();
		let kitty = self.image_protocol == Some(ImageProtocol::Kitty);
		let tmux = self.painter.tmux();
		// Padding encoded with REP, which tmux expands into identical styled
		// cells. Compacted up front so the replay's size is known before the
		// first byte is written.
		let replay_content: Vec<Cow<'_, str>> = if compact_replay {
			prepared_history
				.rows
				.iter()
				.chain(&prepared.rows)
				.map(|row| text::compact_replay_spaces(&row.terminal_content))
				.collect()
		} else {
			Vec::new()
		};
		if renew_sync && pending_alt_exit.is_none() && self.resize.replay_size.is_some() {
			// The device encodes straight into its queue, so the notice that
			// must precede the replay is decided on an estimate of the
			// replay's size: its row content and image transmits.
			let content: usize = if compact_replay {
				replay_content.iter().map(|content| content.len()).sum()
			} else {
				prepared_history
					.rows
					.iter()
					.chain(&prepared.rows)
					.map(|row| row.terminal_content.len())
					.sum()
			};
			let transmits: usize = images.transmits.iter().map(String::len).sum();
			let estimate = content + transmits + (history_len + rows) * ROW_FRAMING_BYTES;
			if estimate >= RESIZE_REBUILD_NOTICE_MIN_BYTES {
				emit(device, |b| emit_rebuild_notice(b, sync, width, height));
			}
		}
		let mutable_top = new_top + replay_viewport_rows as u32;
		let target = match markers.first() {
			Some(marker) if rows > 0 => self.target_hardware_cursor(
				new_top + marker.row.min(rows - 1) as u32,
				marker.col,
				height,
			),
			_ => None,
		};
		let had_live_window = !self.provider_window.is_empty();
		emit(device, |b| {
			b.frame_begin(sync, renew_sync);
			if let Some(exit) = pending_alt_exit {
				// A fused resize exit whose borrow never painted still owes
				// its entry.
				self.emit_pending_alt_enter(b);
				exit.emit(b);
			}
			if destructive_reset && kitty {
				// A reset is explicitly destructive, so remove every
				// placement—not only the ones this engine tracked—then resend
				// images composed for the clean replay. ED2 below reclaims the
				// rest, but only on terminals that treat an erase as a
				// graphics clear; the explicit delete covers the others.
				b.text(&images::encode_kitty_delete_all_images(tmux));
				// `d=A` spares virtual placements, and erasing the placeholder
				// text it leaves behind does not remove the prototype either.
				// The ids this reset forgot are named explicitly here — their
				// tracking is gone, so nothing downstream could find them
				// again.
				for &id in &images.reset_purge_ids {
					b.text(&images::encode_kitty_delete_image(id, tmux));
				}
				self.normal_placements.clear();
			}
			if kitty {
				for &id in &images.purge_ids {
					b.text(&images::encode_kitty_delete_image(id, tmux));
				}
			}
			// ED2 MUST precede ED3: tmux implements ED2 by scrolling the live
			// screen into pane history (so cleared content stays reachable),
			// so erasing history first would let ED2 refill it with a copy of
			// the old screen — which the replay then repaints, duplicating one
			// full frame per reset. ED2-then-ED3 clears the screen, then wipes
			// history including that push. On xterm-family terminals the two
			// erases are independent and the order is irrelevant.
			//
			// Both erases MUST precede the image transmits. kitty and Ghostty
			// treat ED2 as a graphics clear that also frees every image left
			// without a placement — which is exactly what freshly transmitted
			// data is until the row carrying its placement is written.
			// Transmitting first let the erase reclaim the data, so the
			// replay's placements then referenced an image the terminal no
			// longer had and every inline image vanished after a settled
			// width resize.
			if destructive_reset {
				emit_line_terminator(b);
				b.home().erase_screen().erase_scrollback();
			}
			emit_retired_image_placements(
				b,
				&mut self.normal_placements,
				&prepared.lines,
				new_top,
				!diffable,
				tmux,
			);
			for sequence in &images.transmits {
				b.text(sequence);
			}
			// Without synchronized output the terminal may show any prefix of
			// this write, so move surviving rows instead of repainting
			// through them.
			let moved = !sync
				&& geometry_stable
				&& !destructive_reset
				&& !replay
				&& !force
				&& had_live_window
				&& pending_alt_exit.is_none()
				&& self.normal_placements.is_empty()
				&& self.emit_moved_rows(
					b,
					width,
					height,
					start_top,
					new_top,
					&prepared_history,
					&prepared,
				);
			// When `moved`, `emit_moved_rows` already wrote the rows.
			if !moved && diffable {
				for index in 0..rows {
					if !row_needs_rewrite(
						&self.provider_window,
						&self.provider_rows,
						&prepared.lines,
						&prepared.rows,
						index,
					) {
						continue;
					}
					b.move_to(new_top + index as u32 + 1, 1);
					self
						.painter
						.line_rewrite(b, &prepared.rows[index], width, Rewrite {
							frame_row: Some(index as u32),
							spacer_glyph_width: text::osc66_spacer_glyph_width(&prepared.lines, index),
							placements: Some(&mut self.normal_placements),
							image_row: Some(new_top + index as u32),
							budget,
							..Rewrite::default()
						});
				}
				if self.provider_window.len() > rows && new_top + (rows as u32) < height {
					b.move_to(new_top + rows as u32 + 1, 1).erase_below();
				}
			} else if !moved {
				// This write scrolls when history + viewport overflow the
				// screen; the terminal pushes the physical top rows into
				// scrollback. Rows above the old viewport are committed
				// history (correct to push), but old live viewport rows are
				// not — erase them first so a scroll can only push committed
				// rows and blanks, never an unfinished frame.
				let pushed = (start_top + history_len as u32 + rows as u32).saturating_sub(height);
				if pushed > self.provider_viewport_top && had_live_window {
					emit_erase_below_row(b, self.provider_viewport_top, height);
				}
				b.move_to(start_top + 1, 1);
				let mut screen_row = start_top;
				for index in 0..history_len {
					if screen_row > start_top {
						b.lf(1);
					}
					self
						.painter
						.line_rewrite(b, &prepared_history.rows[index], width, Rewrite {
							frame_row: Some(screen_row.min(height - 1)),
							spacer_glyph_width: text::osc66_spacer_glyph_width(
								&prepared_history.lines,
								index,
							),
							replay_content: replay_content.get(index).map(|content| &**content),
							budget,
							..Rewrite::default()
						});
					screen_row += 1;
				}
				for index in 0..rows {
					if screen_row > start_top {
						b.lf(1);
					}
					// Replay-split rows continue the history ledger written
					// above them; the provider's own rows reach no higher than
					// its viewport top.
					let split = index < replay_viewport_rows;
					self
						.painter
						.line_rewrite(b, &prepared.rows[index], width, Rewrite {
							frame_row: Some(if split {
								screen_row.min(height - 1)
							} else {
								index as u32
							}),
							spacer_glyph_width: text::osc66_spacer_glyph_width(&prepared.lines, index),
							replay_content: replay_content
								.get(history_len + index)
								.map(|content| &**content),
							placements: if split {
								None
							} else {
								Some(&mut self.normal_placements)
							},
							image_row: Some(new_top + index as u32),
							budget,
						});
					screen_row += 1;
				}
				if new_top + (rows as u32) < height {
					b.move_to(new_top + rows as u32 + 1, 1).erase_below();
				}
			}
			match target {
				Some(target) => {
					b.move_to(target.row + 1, target.col + 1);
					if target.visible {
						b.set_mode(mode::CURSOR_VISIBLE, false);
					} else {
						b.reset_mode(mode::CURSOR_VISIBLE, false);
					}
				},
				// Park the hidden cursor on the viewport's top row: terminals
				// keep the cursor attached to its logical line through resize
				// reflow, so the post-resize anchor probe can recover where
				// the viewport landed.
				None => {
					b.reset_mode(mode::CURSOR_VISIBLE, false)
						.move_to(mutable_top + 1, 1);
				},
			}
			b.frame_end();
		});
		drop(replay_content);
		self.painter.take_hits(&mut self.host_requests.frame_texts);
		self.parked_viewport_offset =
			target.map_or(0, |target| target.row.saturating_sub(mutable_top));
		let window_top = mem::take(&mut self.debug_next_window_top);
		self.record_debug_paint(&prepared.lines, window_top, false, target);
		if pending_alt_exit.is_some() {
			self.note_alt_buffer_toggle(size);
			self.pending_alt_exit = None;
			self.resize.alt_exit_fused = false;
		}
		match target {
			Some(target) => self.record_hardware_cursor(target),
			None => self.record_hardware_cursor_hidden(),
		}
		// Replay-split rows in `prepared.lines` now occupy the physical
		// viewport; only `prepared_history.lines` crossed above it into
		// native scrollback.
		if want_paint {
			result.paint = Some(Paint {
				history: to_strings(&prepared_history.lines),
				viewport: to_strings(&prepared.lines),
				reset: destructive_reset || replay,
				alt: false,
				size,
			});
		}
		let Prepared { lines: mut mutable_lines, rows: mut mutable_rows } = prepared;
		if replay_viewport_rows > 0 {
			mutable_lines.drain(..replay_viewport_rows);
			mutable_rows.drain(..replay_viewport_rows);
		}
		self.previous_frame_length = mutable_lines.len() as u32;
		self.provider_window = mutable_lines;
		self.provider_rows = mutable_rows;
		self.provider_viewport_top = mutable_top;
		self.provider_viewport_pad_top = replay_viewport_rows as i32 - replay_prepended_blanks as i32;
		self.previous_width = width;
		self.previous_height = height;
		self.resize.reset_burst();
		if history_len > 0 || replay_viewport_rows > 0 {
			self.provider_history_written = true;
		}
		self.clear_scrollback_on_next_render = false;
		self.force_viewport_repaint_on_next_render = false;
		self.has_ever_rendered = true;
		self.resize.replay_size = None;
		if let Some(id) = history_id {
			self.accepted_history_batch_id = id;
			result.acknowledged.push(id);
			// Normal retirement may hold another ordered batch. Replay is
			// always complete, so pumping it would create a second visible
			// redraw/write.
			if !replay {
				self.request_render(now, RenderRequest::default());
			}
		}
	}

	/// Emit the rows of a frame for a terminal that may present any prefix
	/// of the write (no synchronized output). Returns false, having emitted
	/// nothing, when the frame needs the plain row-rewrite paths (images,
	/// OSC 66 text, stale row preparation, a viewport taller than the
	/// screen).
	///
	/// Rows bound for scrollback are first made to show their history line,
	/// then pushed with line feeds on the bottom row; surviving rows then
	/// shift into place with DL/IL, and only rows that still differ are
	/// rewritten. Every intermediate screen is the previous frame scrolled
	/// or shifted, never a rewritten row beside its stale copy (the
	/// duplicated band a top-down repaint shows) or an erased band awaiting
	/// repaint.
	#[allow(clippy::too_many_arguments, reason = "one paint's geometry and its two row sets")]
	fn emit_moved_rows(
		&mut self,
		b: &mut Batch<'_>,
		width: u32,
		height: u32,
		start_top: u32,
		new_top: u32,
		history: &Prepared,
		viewport: &Prepared,
	) -> bool {
		let window = &self.provider_window;
		let rows = viewport.lines.len();
		let screen_height = height as usize;
		let start_top = start_top as usize;
		let new_top = new_top as usize;
		if rows > screen_height || start_top + window.len() > screen_height {
			return false;
		}
		let width_epoch = crate::text::width_config_epoch();
		let image_protocol = self.image_protocol;
		if self.provider_rows.iter().any(|row| {
			row.is_image
				|| row.width != width
				|| row.width_epoch != width_epoch
				|| row.image_protocol != image_protocol
		}) {
			return false;
		}
		if viewport.rows.iter().any(|row| row.is_image) || history.rows.iter().any(|row| row.is_image)
		{
			return false;
		}
		if [window, &viewport.lines, &history.lines]
			.into_iter()
			.flatten()
			.any(|line| text::is_osc66_line(line))
		{
			return false;
		}

		/// One key per distinct line.
		fn key_of<'a>(keys: &mut HashMap<&'a str, i32>, line: &'a str) -> i32 {
			let next = keys.len() as i32;
			*keys.entry(line).or_insert(next)
		}
		let mut keys: HashMap<&str, i32> = HashMap::from([("", BLANK_ROW)]);
		let mut screen = vec![BLANK_ROW; screen_height];
		screen[..start_top].fill(UNKNOWN_ROW);
		for (index, line) in window.iter().enumerate() {
			screen[start_top + index] = key_of(&mut keys, line);
		}

		// Inserted, deleted, and scrolled-in lines take the current
		// background.
		let mut reset = false;
		// Push in screenfuls: physical row r holds combined row `done + r`
		// of the ledger (history above the old viewport, then the batch,
		// then the viewport), so each row about to scroll off must show its
		// batch row.
		let pushed = (start_top + history.lines.len() + rows).saturating_sub(screen_height);
		let mut done = 0;
		while done < pushed {
			let count = (pushed - done).min(screen_height);
			for (r, slot) in screen[..count].iter_mut().enumerate() {
				let Some(index) = (done + r).checked_sub(start_top) else {
					continue;
				};
				let key = key_of(&mut keys, &history.lines[index]);
				if *slot == key {
					continue;
				}
				b.move_to(r as u32 + 1, 1);
				self
					.painter
					.line_rewrite(b, &history.rows[index], width, Rewrite::default());
				*slot = key;
			}
			if !mem::replace(&mut reset, true) {
				b.sgr(0);
			}
			b.move_to(height, 1).lf(count as u32);
			screen.copy_within(count.., 0);
			screen[screen_height - count..].fill(BLANK_ROW);
			done += count;
		}

		let base = start_top.saturating_sub(pushed);
		let mut target = vec![BLANK_ROW; screen_height];
		target[..base].fill(UNKNOWN_ROW);
		for r in base..new_top {
			target[r] = key_of(&mut keys, &history.lines[r + pushed - start_top]);
		}
		for (index, line) in viewport.lines.iter().enumerate() {
			target[new_top + index] = key_of(&mut keys, line);
		}

		for _ in 0..MAX_ROW_MOVES {
			let Some(row_move) = moves::find_row_move(&screen, &target, base) else {
				break;
			};
			if !mem::replace(&mut reset, true) {
				b.sgr(0);
			}
			moves::emit_row_move(b, row_move, screen_height);
			moves::apply_row_move(&mut screen, row_move);
		}
		for r in base..new_top + rows {
			if screen[r] == target[r] {
				continue;
			}
			let row = if r < new_top {
				&history.rows[r + pushed - start_top]
			} else {
				&viewport.rows[r - new_top]
			};
			b.move_to(r as u32 + 1, 1);
			self.painter.line_rewrite(b, row, width, Rewrite::default());
		}
		for (r, &row) in screen[..screen_height]
			.iter()
			.enumerate()
			.skip(new_top + rows)
		{
			if row == BLANK_ROW {
				continue;
			}
			emit_erase_below_row(b, r as u32, height);
			break;
		}
		true
	}

	/// Claim the resize borrow's entry for the write that carries it. A
	/// borrow that ends before any frame painted (output backpressure
	/// deferred them) still owes its entry, so the exit write prepends it:
	/// one write, never a bare buffer switch the terminal could present.
	pub(super) fn emit_pending_alt_enter(&mut self, b: &mut Batch<'_>) {
		if let Some(enter) = self.resize.pending_alt_enter.take() {
			enter.emit(b);
		}
	}
}
