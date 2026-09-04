//! Codex quota-reset celebration: a
//! top-third fireworks animation over the transcript — 34 frames at 85 ms
//! of rockets, bursts, and a drifting star field above a banner naming the
//! event. The animation loops until Escape dismisses it; other keys are
//! consumed without disturbing the celebration.
//!
//! The canvas is one retained [`Frame`] plus a per-cell priority plane;
//! each animation frame repaints in place: a glyph lands when its priority
//! is at least the cell's current one.

use std::{f64::consts::PI, time::Duration};

use omp_core::{Str, sf};
use omp_tui::{Border, Color, Frame, Key, Size, Style, Theme, UiContext, cell_width};

use super::{Panel, PanelAnchor, PanelCx, PanelEvent};
use crate::celebrate::CodexResetEvent;

/// Delay between animation frames.
pub const FRAME_INTERVAL: Duration = Duration::from_millis(85);
/// Number of animation frames.
pub const FRAME_COUNT: u32 = 34;
/// The overlay takes the top third of the terminal.
const HEIGHT_PERCENT: u16 = 33;
/// The art is centered in at most 96 columns.
const ART_WIDTH: u16 = 96;
/// Maximum banner-panel width.
const BANNER_WIDTH: u16 = 62;
/// Glyphs by burst age.
const BURST_GLYPHS: [&str; 9] = ["@", "*", "*", "+", "o", "o", ".", ".", "."];

/// Theme colors by burst palette, resolved to the nearest [`Theme`] slot.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Tint {
	/// Informational-link color.
	Cyan,
	/// Muted color.
	Dim,
	/// Warning color.
	Gold,
	/// Success color.
	Green,
	/// Accent color.
	Pink,
	/// Secondary color.
	Violet,
	/// Foreground text color.
	White,
}

impl Tint {
	const fn color(self, theme: &Theme) -> Color {
		match self {
			Self::Cyan => theme.info,
			Self::Dim => theme.muted,
			Self::Gold => theme.warn,
			Self::Green => theme.ok,
			Self::Pink => theme.accent,
			Self::Violet => theme.secondary,
			Self::White => theme.fg,
		}
	}
}

/// One scheduled burst: sky-fraction position, the
/// frame it detonates on, and its particle tint.
struct Burst {
	x:     f64,
	y:     f64,
	start: i32,
	color: Tint,
}

/// Scheduled fireworks bursts.
const BURSTS: [Burst; 6] = [
	Burst { x: 0.17, y: 0.46, start: 5, color: Tint::Pink },
	Burst { x: 0.48, y: 0.2, start: 9, color: Tint::Cyan },
	Burst { x: 0.78, y: 0.42, start: 13, color: Tint::Gold },
	Burst { x: 0.31, y: 0.24, start: 17, color: Tint::Violet },
	Burst { x: 0.65, y: 0.28, start: 21, color: Tint::Green },
	Burst { x: 0.88, y: 0.18, start: 25, color: Tint::Pink },
];

/// JavaScript `Math.round`: halves round toward positive infinity, which
/// differs from Rust's away-from-zero on the negative offsets the burst
/// geometry produces.
fn js_round(value: f64) -> i64 {
	(value + 0.5).floor() as i64
}

/// Retained fireworks overlay.
pub struct Fireworks {
	event:    CodexResetEvent,
	ctx:      UiContext,
	viewport: Size,
	frame:    Frame,
	/// Per-cell compositing priority for the frame in flight.
	priority: Vec<u8>,
	started:  Option<Duration>,
	/// Animation frame index in `0..FRAME_COUNT`.
	index:    u32,
	/// Absolute animation step, used to schedule the next frame across loops.
	step:     u32,
	/// Frame index and canvas size last painted into `frame`.
	painted:  Option<(u32, Size)>,
}

impl Fireworks {
	/// Opens the celebration for `event`.
	#[must_use]
	pub fn open(event: CodexResetEvent, cx: &PanelCx<'_>) -> Self {
		let canvas = Self::canvas_size(cx.viewport);
		Self {
			event,
			ctx: cx.ui.clone(),
			viewport: cx.viewport,
			frame: Frame::new(canvas),
			priority: vec![0; cells(canvas)],
			started: None,
			index: 0,
			step: 0,
			painted: None,
		}
	}

	/// Current animation frame index.
	#[must_use]
	pub const fn frame_index(&self) -> u32 {
		self.index
	}

	/// Full width, `max(1, floor(rows * 0.33))` rows.
	fn canvas_size(viewport: Size) -> Size {
		Size::new(
			viewport.width.max(1),
			(u32::from(viewport.height) * u32::from(HEIGHT_PERCENT) / 100).max(1) as u16,
		)
	}

	/// Claims the cell when `priority` is at least the
	/// cell's current one; `glyph` is `None` for the continuation cells of
	/// a wide glyph, which keep whatever the head `put` painted.
	fn claim(&mut self, x: i64, y: i64, glyph: Option<&str>, tint: Tint, priority: u8) {
		let size = self.frame.size();
		if x < 0 || y < 0 || x >= i64::from(size.width) || y >= i64::from(size.height) {
			return;
		}
		let (x, y) = (x as u16, y as u16);
		let slot = usize::from(y) * usize::from(size.width) + usize::from(x);
		if priority < self.priority[slot] {
			return;
		}
		self.priority[slot] = priority;
		if let Some(glyph) = glyph {
			let style = Style::new().fg(tint.color(&self.ctx.theme));
			self.frame.put(x, y, glyph, style);
		}
	}

	fn set_cell(&mut self, x: i64, y: i64, glyph: &str, tint: Tint, priority: u8) {
		self.claim(x, y, Some(glyph), tint, priority);
	}

	fn draw_text(&mut self, x: i64, y: i64, text: &str, tint: Tint, priority: u8) {
		let mut column = x;
		let mut glyph = [0_u8; 4];
		for ch in text.chars() {
			let glyph = ch.encode_utf8(&mut glyph);
			let width = cell_width(glyph);
			if width == 0 {
				continue;
			}
			self.set_cell(column, y, glyph, tint, priority);
			for continuation in 1..i64::from(width) {
				self.claim(column + continuation, y, None, tint, priority);
			}
			column += i64::from(width);
		}
	}

	fn draw_banner(&mut self, left: i64, art_width: u16, height: u16) {
		if height < 3 || art_width < 8 {
			return;
		}
		let panel_width = BANNER_WIDTH.min(art_width);
		let panel_left = left + i64::from((art_width - panel_width) / 2);
		let top = i64::from(height - 3);
		let inner = panel_width - 2;
		let (title, subtitle) = self.caption();
		let title = truncate_to_width(&title, inner);
		let subtitle = truncate_to_width(&subtitle, inner);
		let title_offset = i64::from(inner.saturating_sub(cell_width(&title)) / 2);
		let subtitle_offset = i64::from(inner.saturating_sub(cell_width(&subtitle)) / 2);
		let (tl, tr, bl, br, horizontal, vertical) = self.ctx.charset.border(Border::Round);

		let mut line = String::with_capacity(usize::from(panel_width) * 3);
		line.push(tl);
		line.extend(std::iter::repeat_n(horizontal, usize::from(inner)));
		line.push(tr);
		self.draw_text(panel_left, top, &line, Tint::Violet, 20);
		self.draw_text(panel_left + 1 + title_offset, top, &title, Tint::Gold, 21);
		line.clear();
		line.push(vertical);
		line.extend(std::iter::repeat_n(' ', usize::from(inner)));
		line.push(vertical);
		self.draw_text(panel_left, top + 1, &line, Tint::Violet, 20);
		self.draw_text(panel_left + 1 + subtitle_offset, top + 1, &subtitle, Tint::Cyan, 21);
		line.clear();
		line.push(bl);
		line.extend(std::iter::repeat_n(horizontal, usize::from(inner)));
		line.push(br);
		self.draw_text(panel_left, top + 2, &line, Tint::Violet, 20);
	}

	/// Banner copy for the event kind.
	fn caption(&self) -> (Str, Str) {
		match self.event {
			CodexResetEvent::UnscheduledWeeklyReset => (
				Str::new_static(" O P E N A I   R E S E T "),
				Str::new_static("Weekly usage cleared early · ESC to return"),
			),
			CodexResetEvent::SavedResetBanked { added: 1, available } => (
				Str::new_static(" S A V E D   R E S E T "),
				sf!("New reset banked · {available} available · ESC to return"),
			),
			CodexResetEvent::SavedResetBanked { added, available } => (
				Str::new_static(" S A V E D   R E S E T "),
				sf!("{added} resets banked · {available} available · ESC to return"),
			),
		}
	}

	fn draw_stars(&mut self, left: i64, art_width: u16, sky_height: u16, frame: u32) {
		if sky_height == 0 {
			return;
		}
		let count = (art_width / 3).clamp(5, 26);
		for index in 0..i64::from(count) {
			let x = left + (index * 37 + 11) % i64::from(art_width);
			let y = (index * 7 + 2) % i64::from(sky_height);
			let bright = (index + i64::from(frame / 3)) % 5 == 0;
			if bright {
				self.set_cell(x, y, "+", Tint::White, 2);
			} else {
				self.set_cell(x, y, ".", Tint::Dim, 1);
			}
		}
	}

	fn draw_burst(&mut self, burst: &Burst, left: i64, art_width: u16, sky_height: u16, frame: u32) {
		if sky_height <= 1 {
			return;
		}
		let center_x = left + js_round(f64::from(art_width - 1) * burst.x);
		let center_y =
			js_round(f64::from(sky_height - 1) * burst.y).clamp(0, i64::from(sky_height - 2));
		let age = i32::try_from(frame).unwrap_or(i32::MAX) - burst.start;

		if (-6..0).contains(&age) {
			let progress = f64::from(age + 6) / 6.0;
			let y = i64::from(sky_height - 1)
				- js_round(progress * (f64::from(sky_height - 1) - center_y as f64));
			self.set_cell(center_x, y, "^", Tint::White, 8);
			self.set_cell(center_x, y + 1, "|", burst.color, 7);
			self.set_cell(center_x, y + 2, ".", Tint::Gold, 6);
			return;
		}
		if !(0..=8).contains(&age) {
			return;
		}
		let age = age as usize;
		let radius = if age == 0 {
			0.0
		} else {
			0.8 + age as f64 * 0.92
		};
		let gravity = (age * age / 22) as f64;
		let glyph = BURST_GLYPHS[age];
		let particle_color = match age {
			0..=5 => burst.color,
			6..=7 => Tint::Gold,
			_ => Tint::Dim,
		};

		for particle in 0..20 {
			let angle = f64::from(particle) / 20.0 * PI * 2.0 + f64::from(burst.start) * 0.17;
			let x = center_x + js_round(angle.cos() * radius * 1.75);
			let y = center_y + js_round(angle.sin() * radius * 0.58 + gravity);
			self.set_cell(x, y, glyph, particle_color, 10);
			if (2..=6).contains(&age) {
				let trail_radius = (radius - 1.4).max(0.0);
				let trail_x = center_x + js_round(angle.cos() * trail_radius * 1.75);
				let trail_y = center_y + js_round(angle.sin() * trail_radius * 0.58 + gravity);
				self.set_cell(trail_x, trail_y, ".", Tint::Dim, 5);
			}
		}
		if age <= 2 {
			let core = if age == 0 { "@" } else { "+" };
			self.set_cell(center_x, center_y, core, Tint::White, 12);
		}
	}

	/// Paints the retained canvas.
	fn paint(&mut self) {
		let size = self.frame.size();
		if self.painted == Some((self.index, size)) {
			return;
		}
		self.frame.clear(Style::default());
		self.priority.fill(0);
		let art_width = ART_WIDTH.min(size.width);
		let left = i64::from((size.width - art_width) / 2);
		let sky_height = size.height.saturating_sub(3);
		let frame = self.index;
		self.draw_stars(left, art_width, sky_height, frame);
		for burst in &BURSTS {
			self.draw_burst(burst, left, art_width, sky_height, frame);
		}
		self.draw_banner(left, art_width, size.height);
		self.painted = Some((self.index, size));
	}

	fn resize(&mut self, viewport: Size) {
		self.viewport = viewport;
		let canvas = Self::canvas_size(viewport);
		if canvas != self.frame.size() {
			self.frame = Frame::new(canvas);
			self.priority.clear();
			self.priority.resize(cells(canvas), 0);
			self.painted = None;
		}
	}
}

/// Cell count of a canvas.
fn cells(size: Size) -> usize {
	usize::from(size.width) * usize::from(size.height)
}

/// Clips to `width` cells without an ellipsis.
fn truncate_to_width(text: &str, width: u16) -> Str {
	if cell_width(text) <= width {
		return Str::new(text);
	}
	let mut used = 0;
	let mut end = 0;
	let mut glyph = [0_u8; 4];
	for (offset, ch) in text.char_indices() {
		let ch_width = cell_width(ch.encode_utf8(&mut glyph));
		if used + ch_width > width {
			break;
		}
		used += ch_width;
		end = offset + ch.len_utf8();
	}
	Str::new(&text[..end])
}

impl Panel for Fireworks {
	fn id(&self) -> &'static str {
		"fireworks"
	}

	fn anchor(&self) -> PanelAnchor {
		PanelAnchor::Full
	}

	fn key(&mut self, key: Key) -> PanelEvent {
		if key == Key::Esc {
			PanelEvent::Close
		} else {
			PanelEvent::Consumed
		}
	}

	fn frame(&mut self, viewport: Size) -> &Frame {
		if viewport != self.viewport {
			self.resize(viewport);
		}
		self.paint();
		&self.frame
	}

	fn tick(&mut self, now: Duration) -> bool {
		let started = *self.started.get_or_insert(now);
		let elapsed = now.saturating_sub(started);
		let step =
			u32::try_from(elapsed.as_millis() / FRAME_INTERVAL.as_millis()).unwrap_or(u32::MAX);
		if step == self.step {
			return false;
		}
		self.step = step;
		let index = step % FRAME_COUNT;
		if index == self.index {
			return false;
		}
		self.index = index;
		true
	}

	fn next_wake(&self) -> Option<Duration> {
		let started = self.started?;
		Some(started + FRAME_INTERVAL * self.step.saturating_add(1))
	}
}

#[cfg(test)]
mod tests {
	use std::sync::Arc;

	use omp_con::Ctx;
	use omp_dom::Dom;

	use super::*;
	use crate::overlays::{NoServices, Services};

	fn open(event: CodexResetEvent, width: u16, height: u16) -> Fireworks {
		let dom = Dom::new();
		let con = Ctx::new();
		let ui = UiContext::default();
		let services: Arc<dyn Services> = Arc::new(NoServices);
		let cx = PanelCx {
			dom:      &dom,
			con:      &con,
			ui:       &ui,
			viewport: Size { width, height },
			services: &services,
		};
		Fireworks::open(event, &cx)
	}

	fn text(panel: &mut Fireworks, width: u16, height: u16) -> String {
		omp_tui::frame_text(panel.frame(Size { width, height }))
	}

	#[test]
	fn fireworks_runs_34_frames_at_85ms_then_loops() {
		let mut panel = open(CodexResetEvent::UnscheduledWeeklyReset, 80, 24);
		assert_eq!(panel.frame(Size { width: 80, height: 24 }).size(), Size::new(80, 7), "top third");
		let start = Duration::from_secs(10);
		assert!(!panel.tick(start), "frame 0 is already shown");
		assert_eq!(panel.next_wake(), Some(start + Duration::from_millis(85)));
		assert!(!panel.tick(start + Duration::from_millis(84)));
		assert!(panel.tick(start + Duration::from_millis(85)));
		assert_eq!(panel.frame_index(), 1);
		assert_eq!(panel.next_wake(), Some(start + Duration::from_millis(170)));
		assert!(!panel.finished());
		// The frame after the last wraps to zero and schedules the next loop.
		assert!(panel.tick(start + Duration::from_millis(85 * 33)));
		assert_eq!(panel.frame_index(), 33);
		assert!(panel.tick(start + Duration::from_millis(85 * 34)));
		assert_eq!(panel.frame_index(), 0);
		assert!(!panel.finished());
		assert_eq!(panel.next_wake(), Some(start + Duration::from_millis(85 * 35)));
	}

	#[test]
	fn only_escape_dismisses_fireworks() {
		let mut panel = open(CodexResetEvent::SavedResetBanked { added: 1, available: 3 }, 80, 24);
		assert_eq!(panel.key(Key::Char('x')), PanelEvent::Consumed);
		assert_eq!(panel.key(Key::Esc), PanelEvent::Close);
		assert_eq!(panel.key(Key::Enter), PanelEvent::Consumed);
		assert_eq!(panel.id(), "fireworks");
		assert_eq!(panel.anchor(), PanelAnchor::Full);
	}

	#[test]
	fn captions_name_the_event_kind() {
		let mut usage = open(CodexResetEvent::UnscheduledWeeklyReset, 80, 24);
		let usage = text(&mut usage, 80, 24);
		assert!(usage.contains("O P E N A I   R E S E T"), "{usage}");
		assert!(usage.contains("Weekly usage cleared early · ESC to return"), "{usage}");

		let mut saved = open(CodexResetEvent::SavedResetBanked { added: 1, available: 3 }, 80, 24);
		let saved = text(&mut saved, 80, 24);
		assert!(saved.contains("S A V E D   R E S E T"), "{saved}");
		assert!(saved.contains("New reset banked · 3 available · ESC to return"), "{saved}");
		assert!(!saved.contains("Weekly usage cleared early"), "{saved}");

		let mut many = open(CodexResetEvent::SavedResetBanked { added: 2, available: 5 }, 80, 24);
		let many = text(&mut many, 80, 24);
		assert!(many.contains("2 resets banked · 5 available · ESC to return"), "{many}");
	}

	#[test]
	fn frame_20_at_80x24_matches_pi() {
		let mut panel = open(CodexResetEvent::UnscheduledWeeklyReset, 80, 24);
		let start = Duration::ZERO;
		panel.tick(start);
		assert!(panel.tick(start + FRAME_INTERVAL * 20));
		assert_eq!(panel.frame_index(), 20);
		let rendered = text(&mut panel, 80, 24);
		let expected = [
			"     .            ++ ....... ++      .           +  .  .     .        .  .",
			".           .     + .   +   . +     .           .  ^    .           .   .",
			"           .      ++ ....... ++.           .      .|   .           .      .    +",
			"      .           . + + + ++  .           .      . .          .       ^   +.",
			"         ╭───────────────── O P E N A I   R E S E T ──────────────────╮   .",
			"         │         Weekly usage cleared early · ESC to return         │",
			"         ╰────────────────────────────────────────────────────────────╯ .",
		]
		.join("\n");
		assert_eq!(rendered, expected);
	}

	#[test]
	fn canvas_is_retained_across_frames_and_resizes() {
		let mut panel = open(CodexResetEvent::UnscheduledWeeklyReset, 80, 24);
		let first = panel.frame(Size { width: 80, height: 24 }) as *const Frame;
		panel.tick(Duration::ZERO);
		panel.tick(FRAME_INTERVAL * 3);
		let again = panel.frame(Size { width: 80, height: 24 }) as *const Frame;
		assert_eq!(first, again, "the canvas frame is repainted, not reallocated");
		assert_eq!(panel.frame(Size { width: 40, height: 12 }).size(), Size::new(40, 3));
		assert_eq!(panel.frame(Size { width: 20, height: 2 }).size(), Size::new(20, 1));
	}
}
