//! Frame entry and alternate-buffer paints.
//!
//! `begin_frame` decides what the host composes: nothing (a resize is
//! settling, a probe is in flight, a native surface owns the display), the
//! transient resize buffer, a fullscreen overlay on the alternate buffer,
//! or the normal-buffer plan frame. It performs the alternate-screen and
//! mouse-tracking transitions that decision implies.
//!
//! While the alternate buffer is active the engine paints only the modal
//! there and leaves every normal-screen accounting field untouched, so
//! exiting reconciles cleanly against the terminal-restored normal screen.

use std::mem;

use super::{
	AltExit, FrameView, Screen, emit, emit_mouse_tracking_off, emit_mouse_tracking_on,
	frame::{Rewrite, emit_retired_image_placements, row_needs_rewrite, to_strings},
	images,
	prepare::Prepared,
	text,
};
use crate::{
	term::{Device, mode},
	tui::{
		budget::FrameImages,
		types::{
			AltFrame, FrameKind, ImageProtocol, Millis, MouseTracking, Paint, PresentResult, Size,
		},
	},
};

impl Screen {
	/// Start a frame: perform the alternate-screen and mouse-tracking
	/// transitions `view` asks for, latch a settled resize's history replay,
	/// and name what the host must compose and present. [`FrameKind::None`]
	/// means there is nothing to paint now (the host renders its native
	/// surface itself when one is live).
	///
	/// A history replay raised here must be applied before composing the
	/// frame. Entering the alternate buffer starts the image budget's
	/// alternate-screen lifecycle; a plan frame that will carry a
	/// destructive Kitty reset drops the budget's normal-screen transmit
	/// tracking, so the pass re-sends every image's data alongside its
	/// placement.
	pub fn begin_frame(
		&mut self,
		now: Millis,
		size: Size,
		view: FrameView,
		device: &mut Device,
	) -> FrameKind {
		self.open_frame(now);
		let kind = self.frame_kind(now, size, view, device);
		match kind {
			FrameKind::None => self.finish_frame(now),
			// That repaint opens with `d=A`, which is what removes the store —
			// queueing per-id deletes when the reset was merely *latched* lets
			// them ride out on an unrelated frame instead, and a frame painted
			// on the alternate buffer carries them off without the repaint
			// that restores them. A latch that never reaches a repaint —
			// `prepare_stop` drops it — then deletes nothing.
			FrameKind::Plan
				if self.clear_scrollback_on_next_render
					&& self.image_protocol == Some(ImageProtocol::Kitty) =>
			{
				if let Some(budget) = &self.budget {
					budget.borrow_mut().forget_transmitted();
				}
			},
			_ => {},
		}
		kind
	}

	fn frame_kind(
		&mut self,
		now: Millis,
		size: Size,
		view: FrameView,
		device: &mut Device,
	) -> FrameKind {
		if self.stopped || self.native_live {
			return FrameKind::None;
		}
		// Awaiting the TSP hello: its resolution (or the hold timeout)
		// repaints.
		if self.native_hold.is_some() {
			return FrameKind::None;
		}
		if self.resize.alt_active {
			return FrameKind::Resize;
		}
		if self.resize.probe.is_some() {
			// The settled repaint lands via `resolve_resize_anchor`; painting
			// now would use the stale pre-resize anchor.
			return FrameKind::None;
		}
		if self.resize.in_place_active && !self.alt_active {
			// The normal-buffer anchor is stale until the settled rebuild or
			// CPR recovery. Painting now would overwrite history and record
			// the new geometry over the pending recovery, so defer until the
			// settle.
			return FrameKind::None;
		}

		// Fullscreen alt-screen short-circuit. While the topmost visible
		// overlay requests it, borrow the terminal's alternate buffer and
		// paint only the modal there; the normal screen and all accounting
		// stay untouched.
		let want_alt = view.alt;
		let want_mouse = view.mouse;
		if want_alt && !self.alt_active {
			// Enhanced keyboard modes can be buffer-local: the device
			// re-pushes the active modified-key reporting sequence on the
			// freshly entered alternate screen, or Esc/modified keys revert
			// to legacy encoding inside fullscreen overlays
			// (Ghostty/kitty/iTerm2).
			let enter = !self.resize.alt_exit_fused;
			if enter {
				self.note_alt_buffer_toggle(size);
				self.begin_alt_image_lifecycle();
			} else {
				// An overlay opened while the settled resize rebuild was
				// still pending: the terminal never left the borrowed buffer,
				// which already carries the pushed keyboard mode and its image
				// store, so the overlay takes it over. The latched rebuild
				// then lands with the overlay's own fused exit when it closes.
				self.pending_alt_exit = None;
				self.resize.alt_exit_fused = false;
			}
			let mouse_on =
				self.mouse_tracking == MouseTracking::Off && want_mouse != MouseTracking::Off;
			let mouse_off =
				self.mouse_tracking != MouseTracking::Off && want_mouse == MouseTracking::Off;
			self.mouse_tracking = want_mouse;
			emit(device, |b| {
				if enter {
					b.set_mode(mode::ALT_SCREEN, false);
				}
				if mouse_on {
					emit_mouse_tracking_on(b);
				}
				if mouse_off {
					emit_mouse_tracking_off(b);
				}
				b.reset_mode(mode::CURSOR_VISIBLE, true);
			});
			self.forget_hardware_cursor();
			self.alt_active = true;
			self.alt_previous_lines.clear();
			self.alt_rows.clear();
			self.alt_enter_size = size;
		} else if !want_alt && self.alt_active {
			let exit = AltExit {
				// Leaving reporting on when the normal buffer wants it
				// restores inline capture the same frame the overlay closes:
				// no later paint is needed, so an idle session never sits
				// untrackable.
				mouse_off: want_mouse == MouseTracking::Off
					&& self.mouse_tracking != MouseTracking::Off,
				// A fullscreen overlay that disabled reporting leaves
				// tracking off: restore it in the fused exit or later frames
				// see matching states and inline click/hover stays dead until
				// the setting toggles.
				mouse_on:  want_mouse != MouseTracking::Off
					&& self.mouse_tracking == MouseTracking::Off,
			};
			// Session replacement finishes while its fullscreen selector
			// still covers the old normal buffer. Fuse the restore into the
			// destructive repaint so no stale frame can become visible
			// between writes.
			if self.clear_scrollback_on_next_render {
				self.pending_alt_exit = Some(exit);
			} else {
				self.note_alt_buffer_toggle(size);
				emit(device, |b| exit.emit(b));
			}
			self.forget_hardware_cursor();
			self.alt_active = false;
			self.mouse_tracking = want_mouse;
			self.alt_previous_lines.clear();
			self.alt_rows.clear();
			// The alt-buffer restore put the pre-overlay normal screen back.
			// If that buffer resized while covered, its cursor moved with
			// width rewrap or a height-grow scrollback pull, while our
			// viewport anchor stayed frozen. Recover the restored cursor
			// position before any provider repaint can overwrite history at
			// the stale row.
			if size != self.alt_enter_size {
				if self.provider.is_some() {
					self.begin_resize_anchor_probe(now, size, device, false);
					return FrameKind::None;
				}
				self.force_viewport_repaint_on_next_render = true;
			}
		} else if want_mouse != self.mouse_tracking {
			self.set_mouse_tracking(want_mouse, device);
		}
		if self.alt_active {
			return FrameKind::Alt;
		}
		// `prepare_resize_replay` can latch this frame's reset itself (a
		// settled rebuild-mode resize does), so it runs before the host
		// composes anything: `begin_frame` drops the image budget's transmit
		// tracking when a reset is latched, so the destructive repaint
		// re-sends every image's data alongside its placement.
		if self.provider.is_some() {
			self.prepare_resize_replay(size);
		}
		// Transmits a deferred frame left queued; `present_plan` checks again
		// once this frame is composed.
		if self.defer_ghostty_initial_image_paint(now, self.image_transmits_pending()) {
			return FrameKind::None;
		}
		FrameKind::Plan
	}

	/// Paint a fullscreen overlay frame on the alternate buffer. Cursor
	/// markers are stripped from the frame, but only a focused cursor-mode
	/// component owned by the fullscreen overlay may position the hardware
	/// cursor (`frame.cursor`). The normal transcript is never composited
	/// into the alternate buffer.
	pub fn present_alt(
		&mut self,
		now: Millis,
		size: Size,
		frame: AltFrame,
		device: &mut Device,
	) -> PresentResult {
		let images = self.drain_frame_images(false);
		let mut result = PresentResult::default();
		if !self.stopped {
			let mut markers = Vec::new();
			let prepared = self.preparer.prepare_lines(
				&frame.rows,
				size.columns,
				&self.alt_rows,
				size.rows as usize,
				Some(&mut markers),
			);
			let cursor = markers
				.first()
				.filter(|_| frame.cursor)
				.map(|marker| (marker.row as u32, marker.col));
			result.paint =
				self.emit_alt_frame(prepared, size, &images, cursor, frame.want_paint, device);
		}
		self.finish_frame(now);
		result
	}

	/// Paint the provider's full semantic tail on the borrowed resize
	/// buffer. The borrowed buffer is transient, not a streamable session
	/// paint, so nothing is reported back.
	pub fn present_resize(
		&mut self,
		now: Millis,
		size: Size,
		rows: Vec<String>,
		device: &mut Device,
	) {
		let images = self.drain_frame_images(false);
		if !self.stopped && self.resize.alt_active {
			let height = size.rows as usize;
			let tail = &rows[rows.len().saturating_sub(height)..];
			// Markers are stripped and ignored: the resize buffer never
			// shows the hardware cursor.
			let mut markers = Vec::new();
			let prepared = self.preparer.prepare_lines(
				tail,
				size.columns,
				&self.alt_rows,
				height,
				Some(&mut markers),
			);
			self.emit_alt_frame(prepared, size, &images, None, false, device);
		}
		self.finish_frame(now);
	}

	/// Paint a frame on the alt buffer: only the rows that changed since the
	/// previous frame, or every row when the height changed, a repaint is
	/// forced, or a changed frame holds OSC 66 text before or after. Emits
	/// only sync-output brackets, cursor moves, and per-row rewrites — never
	/// ED3 or any native-scrollback byte. With `want_paint`, returns the
	/// paint when rows were written.
	fn emit_alt_frame(
		&mut self,
		prepared: Prepared,
		size: Size,
		images: &FrameImages,
		cursor: Option<(u32, u32)>,
		want_paint: bool,
		device: &mut Device,
	) -> Option<Paint> {
		let Size { columns: width, rows: height } = size;
		let height_rows = height as usize;
		let kitty = self.image_protocol == Some(ImageProtocol::Kitty);
		let tmux = self.painter.tmux();
		let sync = self.synchronized_output;
		// A forced repaint (resetDisplay, a forced render request) rewrites
		// every row even when the cached frame is byte-identical: the redraw
		// gesture must repair a corrupted modal. So does a changed frame with
		// OSC 66 text in it, before or after: a scaled glyph spans the rows
		// below its own and the terminal drops it when any of them is
		// written, so those rows are not independent. Otherwise rewrite only
		// the rows that changed (a keystroke in a modal touches a row or
		// two), and skip an identical frame entirely.
		let force = mem::take(&mut self.force_viewport_repaint_on_next_render);
		let first_changed = (0..height_rows).position(|r| {
			row_needs_rewrite(
				&self.alt_previous_lines,
				&self.alt_rows,
				&prepared.lines,
				&prepared.rows,
				r,
			)
		});
		let full = force
			|| self.alt_previous_lines.len() != height_rows
			|| (first_changed.is_some()
				&& self
					.alt_previous_lines
					.iter()
					.chain(&prepared.lines)
					.any(|line| text::is_osc66_line(line)));
		let first_row = if full {
			(height_rows > 0).then_some(0)
		} else {
			first_changed
		};
		let target = cursor.and_then(|(row, col)| self.target_hardware_cursor(row, col, height));
		let previous_cursor = self.hardware_cursor;
		let previously_visible = previous_cursor.is_some_and(|cursor| cursor.visible);
		let cursor_changed = match target {
			Some(target) => previous_cursor != Some(target),
			None => previously_visible,
		};
		let place_cursor = target.filter(|_| first_row.is_some() || cursor_changed);
		let hide_cursor = target.is_none() && previously_visible;
		let framed = first_row.is_some() || place_cursor.is_some() || hide_cursor;
		// Queued image-data transmits (`a=t`, no visible output) go out before
		// the paint so id-keyed placements and placeholder cells composed
		// into this frame resolve against loaded data. The normal-screen path
		// flushes these ahead of its paint; without this, an image first
		// shown inside a fullscreen overlay (e.g. the settings shape preview)
		// would render as blank placeholder cells until the overlay closed. A
		// pending resize-borrow entry leads: the image commands address the
		// alternate buffer's store.
		let pending_enter = self.resize.pending_alt_enter.take();
		let budget = self.budget.clone();
		let budget = budget.as_ref().map(|budget| budget.borrow());
		let budget = budget.as_deref();
		let purge = kitty && !images.purge_ids.is_empty();
		let prelude = pending_enter.is_some()
			|| purge
			|| !images.transmits.is_empty()
			|| self.alt_placements.any_retired(&prepared.lines, 0, full);
		if framed || prelude {
			emit(device, |b| {
				// A prelude with nothing to paint is written bare, without the
				// paint bracket.
				if framed {
					b.frame_begin(sync, false);
				}
				if let Some(enter) = pending_enter {
					enter.emit(b);
				}
				if purge {
					for &id in &images.purge_ids {
						b.text(&images::encode_kitty_delete_image(id, tmux));
					}
				}
				for sequence in &images.transmits {
					b.text(sequence);
				}
				emit_retired_image_placements(
					b,
					&mut self.alt_placements,
					&prepared.lines,
					0,
					full,
					tmux,
				);
				if !framed {
					return;
				}
				if full {
					b.home();
				}
				for r in first_row.unwrap_or(height_rows)..height_rows {
					if full {
						if r > 0 {
							b.lf(1);
						}
					} else if Some(r) == first_row
						|| row_needs_rewrite(
							&self.alt_previous_lines,
							&self.alt_rows,
							&prepared.lines,
							&prepared.rows,
							r,
						) {
						b.move_to(r as u32 + 1, 1);
					} else {
						continue;
					}
					self
						.painter
						.line_rewrite(b, &prepared.rows[r], width, Rewrite {
							frame_row: Some(r as u32),
							spacer_glyph_width: text::osc66_spacer_glyph_width(&prepared.lines, r),
							placements: Some(&mut self.alt_placements),
							budget,
							..Rewrite::default()
						});
				}
				if let Some(target) = place_cursor {
					b.move_to(target.row + 1, target.col + 1);
					if target.visible {
						b.set_mode(mode::CURSOR_VISIBLE, false);
					} else {
						b.reset_mode(mode::CURSOR_VISIBLE, false);
					}
				} else if hide_cursor {
					b.reset_mode(mode::CURSOR_VISIBLE, false);
				}
				b.frame_end();
			});
			self.painter.take_hits(&mut self.host_requests.frame_texts);
		}
		let mut paint = None;
		if framed {
			self.record_debug_paint(&prepared.lines, 0, true, target);
			if first_row.is_some() {
				if want_paint {
					paint = Some(Paint {
						history: Vec::new(),
						viewport: to_strings(&prepared.lines),
						reset: false,
						alt: true,
						size,
					});
				}
				if full {
					self.full_redraws += 1;
				}
			}
			// DEC 1049 restores the normal-buffer cursor on exit. Track this
			// buffer's visibility and marker position without replacing that
			// saved normal row, which the stop handoff and a late
			// native-surface handshake use after the restore.
			match target {
				Some(target) => self.hardware_cursor = Some(target),
				None => self.record_hardware_cursor_hidden(),
			}
		}
		self.alt_previous_lines = prepared.lines;
		self.alt_rows = prepared.rows;
		paint
	}
}
