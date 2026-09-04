use core::fmt::{self, Write as _};

use omp_core::{IntoStr, Str};
use smallvec::SmallVec;

use super::{hr::truncate_to_width, number::write_compact_count};
use crate::{
	Icon, Style,
	component::{Component, PaintCtx, Slot, next_slot},
	context::{Charset, Theme, UiContext},
	frame::{Color, Rect},
	markup::Align,
	props::{Prop, PropValue, Props},
	rich::cell_width,
};

/// Placement of a composer's primary status line.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum StatusPlacement {
	/// The status occupies composer chrome, such as a box's top border.
	Embedded,
	/// The status occupies its own row outside the editable surface.
	Standalone,
}

/// Presentation of context-window usage in a status line.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ContextGaugeMode {
	/// Show context usage as a numeric segment.
	Numeric,
	/// Use the flexible boundary between status groups as a proportional bar.
	Bar,
}

/// Horizontal slots for two status groups separated by a flexible boundary.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct BoundaryLayout {
	/// First column of the left group.
	pub left_x:         u16,
	/// First column of the flexible boundary.
	pub boundary_x:     u16,
	/// Width of the flexible boundary.
	pub boundary_width: u16,
	/// First column of the right group.
	pub right_x:        u16,
}

/// Fits left and right status groups around a flexible boundary.
///
/// Returns `None` when both groups plus `minimum_boundary` do not fit.
pub const fn boundary_layout(
	x: u16,
	width: u16,
	left_width: u16,
	right_width: u16,
	minimum_boundary: u16,
) -> Option<BoundaryLayout> {
	let occupied = left_width.saturating_add(right_width);
	if occupied.saturating_add(minimum_boundary) > width {
		return None;
	}
	let boundary_width = width - occupied;
	let boundary_x = x.saturating_add(left_width);
	Some(BoundaryLayout {
		left_x: x,
		boundary_x,
		boundary_width,
		right_x: boundary_x.saturating_add(boundary_width),
	})
}

/// Percent positions of the auto-compaction boundaries on a context gauge.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CompactionBoundaries {
	/// Where auto-compaction fires, as a percent of the context window.
	pub threshold_percent:   f64,
	/// Where background speculation starts, absent when none will run (async
	/// compaction disabled, or the first summarizing method is local and
	/// therefore instant).
	pub speculation_percent: Option<f64>,
}

/// Paint class of one embedded context-gauge cell.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GaugeCell<'a> {
	/// Fill inside the used portion of the window.
	Used,
	/// Fill past the used portion.
	Unused,
	/// Auto-compaction threshold tick.
	Threshold,
	/// Background-speculation start tick.
	Speculation,
	/// One ASCII cell of the usage percent label.
	Percent(&'a str),
	/// One ASCII cell of the context-window label.
	Window(&'a str),
}

/// Fixed-capacity ASCII scratch for gauge annotations; a write that would
/// overflow or emit non-ASCII fails, and the caller drops the label.
#[derive(Clone, Copy, Debug, Default)]
struct GaugeLabel {
	buf: [u8; 12],
	len: u8,
}

impl GaugeLabel {
	fn as_str(&self) -> &str {
		// Writes reject non-ASCII bytes, so the buffer is always valid UTF-8.
		str::from_utf8(&self.buf[..usize::from(self.len)]).unwrap_or_default()
	}

	/// Single-character slice at `index` when this label starts at `start`.
	fn cell_at(&self, start: Option<u16>, index: u16) -> Option<&str> {
		let start = start?;
		(index >= start && index < start + self.width()).then(|| {
			let cell = usize::from(index - start);
			&self.as_str()[cell..=cell]
		})
	}

	fn width(&self) -> u16 {
		u16::from(self.len)
	}

	const fn is_empty(&self) -> bool {
		self.len == 0
	}
}

impl fmt::Write for GaugeLabel {
	fn write_str(&mut self, s: &str) -> fmt::Result {
		for &byte in s.as_bytes() {
			if usize::from(self.len) == self.buf.len() || !byte.is_ascii() {
				return Err(fmt::Error);
			}
			self.buf[usize::from(self.len)] = byte;
			self.len += 1;
		}
		Ok(())
	}
}

/// Cell plan for the embedded context gauge bridging the status groups.
///
/// The `statusLine.contextLine = "embedded"` top-border gauge uses a
/// proportional fill with the usage percent and context window absorbed as
/// in-line labels, plus ticks where background speculation starts and where
/// auto-compaction fires. An unknown window plans a solid used line (no
/// context feedback), and usage past the window moves the percent label past
/// the window label so it can paint in the error color.
#[derive(Clone, Copy, Debug)]
pub struct ContextGauge {
	width:         u16,
	solid:         bool,
	overflow:      bool,
	used:          u16,
	percent:       GaugeLabel,
	percent_start: Option<u16>,
	window:        GaugeLabel,
	window_start:  Option<u16>,
	threshold:     Option<u16>,
	speculation:   Option<u16>,
}

impl ContextGauge {
	/// Plans a gauge for `width` boundary cells.
	pub fn plan(
		width: u16,
		tokens: u64,
		window: Option<u64>,
		boundaries: Option<CompactionBoundaries>,
	) -> Self {
		Self::plan_with_labels(width, tokens, window, boundaries, true)
	}

	/// Plans a gauge while allowing status presets to suppress the embedded
	/// percent/window labels but retain proportional fill and boundary ticks.
	pub fn plan_with_labels(
		width: u16,
		tokens: u64,
		window: Option<u64>,
		boundaries: Option<CompactionBoundaries>,
		labels: bool,
	) -> Self {
		let mut gauge = Self {
			width,
			solid: true,
			overflow: false,
			used: 0,
			percent: GaugeLabel::default(),
			percent_start: None,
			window: GaugeLabel::default(),
			window_start: None,
			threshold: None,
			speculation: None,
		};
		let Some(window_tokens) = window.filter(|window| *window > 0) else {
			return gauge;
		};
		if width == 0 {
			return gauge;
		}
		gauge.solid = false;
		let percent = tokens as f64 / window_tokens as f64 * 100.0;
		let clamped = percent.clamp(0.0, 100.0);
		gauge.overflow = percent > 100.0;

		let display = if gauge.overflow { percent } else { clamped };
		let mut percent_label = GaugeLabel::default();
		let wrote = if display > 0.0 && display < 1.0 {
			write!(percent_label, "{display:.1}%")
		} else {
			write!(percent_label, "{display:.0}%")
		};
		if wrote.is_err() {
			percent_label = GaugeLabel::default();
		}
		let mut window_label = GaugeLabel::default();
		if write_compact_count(&mut window_label, window_tokens).is_err() {
			window_label = GaugeLabel::default();
		}

		// Absorb both labels only when the line leaves fill on their flanks.
		let mut scale = width;
		if labels
			&& !percent_label.is_empty()
			&& !window_label.is_empty()
			&& width >= percent_label.width() + window_label.width() + 4
		{
			gauge.percent = percent_label;
			gauge.window = window_label;
			let window_start = if gauge.overflow {
				let percent_start = width - gauge.percent.width();
				gauge.percent_start = Some(percent_start);
				percent_start - 1 - gauge.window.width()
			} else {
				width - gauge.window.width() - 1
			};
			gauge.window_start = Some(window_start);
			scale = window_start;
		}

		// At least one accent cell: a fresh session still shows the used line
		// starting at the left instead of a fully dim bar.
		gauge.used = (((clamped / 100.0) * f64::from(scale)).round() as u16)
			.max(1)
			.min(scale);

		// Boundary ticks are only meaningful when auto-compaction can fire and
		// the line is long enough for ticks to read as positions.
		if let Some(boundaries) = boundaries
			&& width >= 8
		{
			let cell_for = |percent: f64| -> u16 {
				let cell = ((percent / 100.0) * f64::from(scale)).round().max(0.0) as u16;
				cell.min(scale.saturating_sub(1))
			};
			let threshold = cell_for(boundaries.threshold_percent);
			gauge.threshold = Some(threshold);
			// Threshold wins a shared cell.
			gauge.speculation = boundaries
				.speculation_percent
				.map(cell_for)
				.filter(|&tick| tick != threshold);
		}

		// Anchor the percent label at the fill boundary, nudged off the ticks.
		if !gauge.percent.is_empty() && gauge.percent_start.is_none() {
			let max_start = scale.saturating_sub(gauge.percent.width() + 1);
			let preferred = gauge.used.max(1).min(max_start);
			let end_of = |start: u16| start + gauge.percent.width();
			let overlaps = |start: u16| {
				let hits =
					|tick: Option<u16>| tick.is_some_and(|tick| tick >= start && tick < end_of(start));
				hits(gauge.threshold) || hits(gauge.speculation)
			};
			for distance in 0..=max_start {
				if let Some(left) = preferred.checked_sub(distance)
					&& left >= 1
					&& !overlaps(left)
				{
					gauge.percent_start = Some(left);
					break;
				}
				if distance == 0 {
					continue;
				}
				let right = preferred + distance;
				if right <= max_start && !overlaps(right) {
					gauge.percent_start = Some(right);
					break;
				}
			}
		}
		gauge
	}

	/// Planned width in cells.
	pub const fn width(&self) -> u16 {
		self.width
	}

	/// Whether usage exceeds the window; the percent label paints as an error.
	pub const fn overflowed(&self) -> bool {
		self.overflow
	}

	/// Paint class of the cell at `index`.
	pub fn cell(&self, index: u16) -> GaugeCell<'_> {
		if self.solid {
			return GaugeCell::Used;
		}
		if let Some(cell) = self.percent.cell_at(self.percent_start, index) {
			return GaugeCell::Percent(cell);
		}
		if self.threshold == Some(index) {
			return GaugeCell::Threshold;
		}
		if self.speculation == Some(index) {
			return GaugeCell::Speculation;
		}
		if let Some(cell) = self.window.cell_at(self.window_start, index) {
			return GaugeCell::Window(cell);
		}
		if index < self.used {
			GaugeCell::Used
		} else {
			GaugeCell::Unused
		}
	}
}

/// Returns the themed accent shared by the compaction threshold marker and
/// context-window usage labels.
pub const fn compaction_threshold_color(theme: &Theme) -> Color {
	theme.status_rule
}
/// Returns the dimmed accent painting compaction boundary ticks and the
/// embedded window label: HSV saturation ×0.7 and value ×0.75. Non-RGB
/// colors pass through unchanged.
pub fn compaction_boundary_color(theme: &Theme) -> Color {
	scale_hsv(compaction_threshold_color(theme), 0.7, 0.75)
}

fn scale_hsv(color: Color, saturation_scale: f32, value_scale: f32) -> Color {
	let Color::Rgb(red, green, blue) = color else {
		return color;
	};
	let r = f32::from(red) / 255.0;
	let g = f32::from(green) / 255.0;
	let b = f32::from(blue) / 255.0;
	let max = r.max(g).max(b);
	let min = r.min(g).min(b);
	let delta = max - min;
	let hue = if delta <= f32::EPSILON {
		0.0
	} else if max == r {
		60.0 * (((g - b) / delta).rem_euclid(6.0))
	} else if max == g {
		60.0 * ((b - r) / delta + 2.0)
	} else {
		60.0 * ((r - g) / delta + 4.0)
	};
	let saturation = if max <= f32::EPSILON {
		0.0
	} else {
		delta / max
	};
	let saturation = (saturation * saturation_scale).clamp(0.0, 1.0);
	let value = (max * value_scale).clamp(0.0, 1.0);
	let chroma = value * saturation;
	let x = chroma * (1.0 - ((hue / 60.0).rem_euclid(2.0) - 1.0).abs());
	let (r, g, b) = match hue {
		hue if hue < 60.0 => (chroma, x, 0.0),
		hue if hue < 120.0 => (x, chroma, 0.0),
		hue if hue < 180.0 => (0.0, chroma, x),
		hue if hue < 240.0 => (0.0, x, chroma),
		hue if hue < 300.0 => (x, 0.0, chroma),
		_ => (chroma, 0.0, x),
	};
	let offset = value - chroma;
	let channel = |part: f32| ((part + offset) * 255.0).round() as u8;
	Color::Rgb(channel(r), channel(g), channel(b))
}

/// Formats primary-model spend for metered or subscription billing.
///
/// Subscription-backed spend uses the dedicated Nerd Font icon where
/// available and an `S` prefix elsewhere. A zero-cost subscription still
/// renders its semantic subscription marker.
pub fn spend_label(amount_nanos: u64, subscription: bool, charset: Charset) -> Str {
	if amount_nanos == 0 {
		return if subscription {
			Str::new(charset.icon(Icon::Subscription))
		} else {
			Str::default()
		};
	}
	let amount = amount_nanos as f64 / 1_000_000_000.0;
	if !subscription {
		return Str::from(format!("${amount:.2}"));
	}
	match charset {
		Charset::NerdFont => Str::from(format!("{} {amount:.2}", charset.icon(Icon::Subscription))),
		Charset::Unicode | Charset::Ascii => Str::from(format!("S{amount:.2}")),
	}
}

/// Formats advisor-model spend with the charset's advisor degradation.
pub fn advisor_spend_label(amount_nanos: u64, subscription: bool, charset: Charset) -> Str {
	let spend = spend_label(amount_nanos, subscription, charset);
	if spend.is_empty() {
		return spend;
	}
	match charset {
		Charset::Ascii => Str::from(format!("{spend} {}", charset.icon(Icon::Advisor))),
		Charset::Unicode | Charset::NerdFont => {
			Str::from(format!("{} {spend}", charset.icon(Icon::Advisor)))
		},
	}
}

/// Declarative segment data backing the `<segment>` markup tag.
pub struct Segment {
	props: Props,
	label: Str,
}

impl Segment {
	/// Creates an empty status segment.
	pub fn new() -> Self {
		Self { props: Props::new(), label: Str::default() }
	}

	/// Appends label text.
	pub fn label(mut self, label: impl IntoStr) -> Self {
		let label = label.into_str();
		if self.label.is_empty() {
			self.label = label;
		} else {
			self.label = Str::from(format!("{}{}", self.label, label));
		}
		self
	}

	/// Sets one segment property.
	pub fn with(mut self, prop: Prop, value: impl Into<PropValue>) -> Self {
		self.props.set(prop, value);
		self
	}

	/// Sets one custom segment property.
	pub fn with_custom(mut self, name: impl IntoStr, value: impl Into<PropValue>) -> Self {
		self.props.set_custom(name, value);
		self
	}
}

impl Default for Segment {
	fn default() -> Self {
		Self::new()
	}
}

/// A one-line powerline-style status group backing the `<status>` markup tag.
///
/// `align=end` (`right`) mirrors the caps for a band docked against the right
/// edge: the opening cap points into the background and the closing edge sits
/// solid on the margin.
pub struct Status {
	props:       Props,
	slot:        Slot,
	segments:    SmallVec<Segment, 8>,
	text_widths: SmallVec<u16, 8>,
}

impl Status {
	/// Creates an empty status group.
	pub fn new() -> Self {
		Self {
			props:       Props::new(),
			slot:        next_slot(),
			segments:    SmallVec::new(),
			text_widths: SmallVec::new(),
		}
	}

	/// Sets one status property.
	pub fn with(mut self, prop: Prop, value: impl Into<PropValue>) -> Self {
		self.props.set(prop, value);
		self
	}

	/// Sets one status property from a string.
	pub fn with_str(mut self, prop: Prop, value: &str) -> Self {
		self.props.set(prop, value);
		self
	}

	/// Appends a segment to the group.
	pub fn segment(mut self, segment: Segment) -> Self {
		self.push_segment(segment);
		self
	}

	/// Replaces the segments while preserving this component's slot identity.
	pub fn set_segments(&mut self, segments: impl IntoIterator<Item = Segment>) {
		self.segments.clear();
		self.text_widths.clear();
		for segment in segments {
			self.push_segment(segment);
		}
	}

	fn push_segment(&mut self, segment: Segment) {
		let width = self
			.text_widths
			.last()
			.copied()
			.unwrap_or(0)
			.saturating_add(cell_width(&segment.label));
		self.segments.push(segment);
		self.text_widths.push(width);
	}

	/// Band chrome for this group's dock side.
	fn chrome(&self, charset: Charset) -> (&'static str, &'static str, &'static str) {
		match self.props.align() {
			Align::End => charset.status_band_end(),
			Align::Start | Align::Center => charset.status_band(),
		}
	}

	fn group_width(&self, count: usize, charset: Charset) -> u16 {
		let (left_cap, separator, cap) = self.chrome(charset);
		let text = count
			.checked_sub(1)
			.and_then(|index| self.text_widths.get(index))
			.copied()
			.unwrap_or(0);
		let separators = u16::try_from(count.saturating_sub(1))
			.unwrap_or(u16::MAX)
			.saturating_mul(cell_width(separator).saturating_add(2));
		text
			.saturating_add(separators)
			.saturating_add(cell_width(left_cap))
			.saturating_add(2)
			.saturating_add(cell_width(cap))
	}
}

impl Default for Status {
	fn default() -> Self {
		Self::new()
	}
}

impl Component for Status {
	fn props(&self) -> &Props {
		&self.props
	}

	fn props_mut(&mut self) -> &mut Props {
		&mut self.props
	}

	fn slot(&self) -> Slot {
		self.slot
	}

	fn measure(&mut self, ctx: &UiContext) -> (u16, u16) {
		let min = self.group_width(self.segments.len().min(1), ctx.charset);
		let natural = self.group_width(self.segments.len(), ctx.charset);
		(min, natural)
	}

	fn height(&mut self, _ctx: &UiContext, _width: u16) -> u16 {
		1
	}

	fn paint(&mut self, pc: &mut PaintCtx<'_>, rect: Rect) {
		if rect.y >= pc.clip || rect.width == 0 {
			return;
		}
		let mut visible = self.segments.len();
		while visible > 1 && self.group_width(visible, pc.ctx.charset) > rect.width {
			visible -= 1;
		}
		let style = self.props.style(&pc.ctx.theme);
		let (left_cap, separator, cap) = self.chrome(pc.ctx.charset);
		let edge_style = Style::new().fg(style.background_color());
		let left_width = cell_width(left_cap);
		let cap_width = cell_width(cap);
		let truncate_first = visible == 1 && self.group_width(visible, pc.ctx.charset) > rect.width;
		let boundary_width = left_width.saturating_add(cap_width);
		if truncate_first && boundary_width <= rect.width {
			let interior = rect.width - boundary_width;
			let left_pad = interior >= 2;
			let right_pad = interior >= 3;
			let fit = interior
				.saturating_sub(u16::from(left_pad))
				.saturating_sub(u16::from(right_pad));
			let segment = &self.segments[0];
			let mut segment_style = segment.props.style(&pc.ctx.theme).inherit(style);
			if segment_style.background_color() == Color::Default {
				segment_style = segment_style.bg(style.background_color());
			}
			let label = truncate_to_width(&segment.label, fit);
			let mut column = pc.frame.put(rect.x, rect.y, left_cap, edge_style);
			if left_pad {
				column = pc.frame.put(column, rect.y, " ", style);
			}
			column = pc.frame.put(column, rect.y, label.text, segment_style);
			if label.ellipsis {
				column = pc.frame.put(column, rect.y, "…", segment_style);
			}
			if right_pad {
				column = pc.frame.put(column, rect.y, " ", style);
			}
			pc.frame.put(column, rect.y, cap, edge_style);
			return;
		}
		let chrome_width = boundary_width.saturating_add(2);
		if rect.width < chrome_width {
			if left_width <= rect.width {
				pc.frame.put(rect.x, rect.y, left_cap, edge_style);
			}
			if left_width.saturating_add(cap_width) <= rect.width {
				pc.frame
					.put(rect.x.saturating_add(rect.width - cap_width), rect.y, cap, edge_style);
			}
			return;
		}
		let mut column = pc.frame.put(rect.x, rect.y, left_cap, edge_style);
		column = pc.frame.put(column, rect.y, " ", style);
		for (index, segment) in self.segments[..visible].iter().enumerate() {
			if index > 0 {
				column = pc.frame.put(column, rect.y, " ", style.dim());
				column = pc.frame.put(column, rect.y, separator, style.dim());
				column = pc.frame.put(column, rect.y, " ", style.dim());
			}
			let mut segment_style = segment.props.style(&pc.ctx.theme).inherit(style);
			if segment_style.background_color() == Color::Default {
				segment_style = segment_style.bg(style.background_color());
			}
			column = pc.frame.put(column, rect.y, &segment.label, segment_style);
		}
		column = pc.frame.put(column, rect.y, " ", style);
		pc.frame.put(column, rect.y, cap, edge_style);
	}

	fn paints_background(&self) -> bool {
		false
	}
}

#[cfg(test)]
mod tests {
	use super::{
		CompactionBoundaries, ContextGauge, GaugeCell, Segment, Status, advisor_spend_label,
		boundary_layout, spend_label, write_compact_count,
	};
	use crate::{
		Charset, Color, Prop, Ui, UiContext,
		component::{Cached, Hit, PaintCtx},
		dom,
		frame::{Frame, Rect, Size},
		test_support::frame_row_text,
	};

	fn paint(status: Status, width: u16) -> (Frame, Vec<Hit>) {
		paint_with_charset(status, width, Charset::default())
	}

	fn paint_with_charset(status: Status, width: u16, charset: Charset) -> (Frame, Vec<Hit>) {
		let ctx = UiContext { charset, ..UiContext::default() };
		let mut status = Cached::new(Box::new(status));
		status.place(&ctx, Rect::new(0, 0, width, 1));
		let mut frame = Frame::new(Size::new(width, 1));
		let mut hits = Vec::new();
		status.paint(&mut PaintCtx::new(&mut frame, &ctx, &mut hits, &mut Vec::new()));
		(frame, hits)
	}

	#[test]
	fn status_paints_segments_and_styles() {
		let status = Status::new()
			.with(Prop::Bg, "yellow")
			.segment(Segment::new().label("alpha").with(Prop::Fg, "red"))
			.segment(
				Segment::new()
					.label("beta")
					.with(Prop::Fg, "green")
					.with(Prop::Bg, "blue"),
			)
			.segment(Segment::new().label("gamma").with(Prop::Fg, "blue"));
		let (frame, hits) = paint(status, 40);
		assert_eq!(frame_row_text(&frame, 0), " alpha > beta > gamma ▶");
		assert_eq!(frame.cell(1, 0).style.foreground_color(), Color::Rgb(255, 0, 0));
		assert_eq!(frame.cell(9, 0).style.foreground_color(), Color::Rgb(0, 128, 0));
		assert_eq!(frame.cell(16, 0).style.foreground_color(), Color::Rgb(0, 0, 255));
		assert_eq!(frame.cell(1, 0).style.background_color(), Color::Rgb(255, 255, 0),);
		assert_eq!(frame.cell(9, 0).style.background_color(), Color::Rgb(0, 0, 255));
		assert_eq!(
			frame.cell(22, 0).style.foreground_color(),
			Color::Rgb(255, 255, 0),
			"the cap uses the band's background as its foreground",
		);
		assert_eq!(
			frame.cell(22, 0).style.background_color(),
			Color::Default,
			"the cap transitions onto the surrounding background",
		);
		assert_eq!(
			frame.cell(23, 0).style.background_color(),
			Color::Default,
			"the band stops after the rendered group",
		);
		assert!(hits.is_empty());
	}

	#[test]
	fn nerd_font_edges_use_band_background_as_foreground() {
		let status = Status::new()
			.with(Prop::Bg, "yellow")
			.segment(Segment::new().label("chip"));
		let (frame, _) = paint_with_charset(status, 20, Charset::NerdFont);

		assert_eq!(frame_row_text(&frame, 0), "\u{e0b6} chip \u{e0b0}");
		for column in [0, 7] {
			assert_eq!(frame.cell(column, 0).style.foreground_color(), Color::Rgb(255, 255, 0),);
			assert_eq!(frame.cell(column, 0).style.background_color(), Color::Default);
		}
		assert_eq!(frame.cell(8, 0).style.background_color(), Color::Default);
	}

	#[test]
	fn align_end_mirrors_the_caps_for_a_right_docked_band() {
		let status = Status::new()
			.with_str(Prop::Align, "right")
			.with(Prop::Bg, "yellow")
			.segment(Segment::new().label("chip"));
		let (frame, _) = paint_with_charset(status, 20, Charset::NerdFont);
		assert_eq!(frame_row_text(&frame, 0), "\u{e0b2} chip");
		assert_eq!(
			frame.cell(6, 0).style.background_color(),
			Color::Rgb(255, 255, 0),
			"the flat closing edge keeps the band background through its pad cell",
		);
		let (frame, _) = paint(
			Status::new()
				.with_str(Prop::Align, "right")
				.segment(Segment::new().label("alpha"))
				.segment(Segment::new().label("beta")),
			20,
		);
		assert_eq!(frame_row_text(&frame, 0), "◀ alpha < beta");
	}

	#[test]
	fn status_narrow_width_drops_whole_trailing_segments() {
		let status = Status::new()
			.segment(Segment::new().label("alpha"))
			.segment(Segment::new().label("beta"))
			.segment(Segment::new().label("gamma"));
		let (frame, _) = paint(status, 10);
		let painted = frame_row_text(&frame, 0);
		assert_eq!(painted, " alpha ▶");
		assert!(!painted.contains("beta"));
	}

	#[test]
	fn status_truncates_its_last_chip_at_boundary_widths() {
		for (width, expected) in [(7, " alp… ▶"), (4, " … ▶"), (3, " …▶"), (2, "…▶")]
		{
			let status = Status::new().segment(Segment::new().label("alphabet"));
			let (frame, _) = paint(status, width);
			assert_eq!(frame_row_text(&frame, 0), expected);
		}
	}

	#[test]
	fn status_markup_paints_segment_labels() {
		let ui = Ui::from_markup(
			"<status><segment fg=green>alpha</segment><segment>beta</segment></status>",
			40,
			UiContext::default(),
		)
		.expect("status markup should parse");
		let painted = frame_row_text(ui.frame(), 0);
		assert!(painted.contains("alpha > beta"));
	}

	#[test]
	fn status_markup_rejects_orphan_segment() {
		let error = Ui::from_markup("<segment>alpha</segment>", 40, UiContext::default())
			.err()
			.expect("orphan segment must fail");
		assert!(
			error
				.message
				.contains("<segment> is not allowed directly inside")
		);
	}

	#[test]
	fn status_macro_paints_segment_label() {
		let ui = Ui::from_root(
			dom! { <status><segment fg=green>{"alpha"}</segment></status> },
			40,
			UiContext::default(),
		);
		assert!(frame_row_text(ui.frame(), 0).contains("alpha"));
	}
	#[test]
	fn boundary_layout_docks_groups_and_reserves_the_gap() {
		let layout = boundary_layout(3, 30, 8, 6, 2).expect("groups fit");
		assert_eq!(layout.left_x, 3);
		assert_eq!(layout.boundary_x, 11);
		assert_eq!(layout.boundary_width, 16);
		assert_eq!(layout.right_x, 27);
		assert_eq!(boundary_layout(0, 12, 6, 5, 2), None);
	}

	#[test]
	fn boundary_layout_runs_to_the_edge_when_the_right_group_is_empty() {
		let layout = boundary_layout(1, 38, 10, 0, 2).expect("left group and gauge fit");
		assert_eq!(layout.boundary_x, 11);
		assert_eq!(layout.boundary_width, 28);
		assert_eq!(layout.right_x, 39);
	}

	fn gauge_row(gauge: &ContextGauge) -> String {
		(0..gauge.width())
			.map(|index| match gauge.cell(index) {
				GaugeCell::Used => '=',
				GaugeCell::Unused => '-',
				GaugeCell::Threshold => 'T',
				GaugeCell::Speculation => 'S',
				GaugeCell::Percent(cell) | GaugeCell::Window(cell) => {
					cell.chars().next().unwrap_or('?')
				},
			})
			.collect()
	}

	#[test]
	fn context_gauge_embeds_percent_and_window_labels() {
		let gauge = ContextGauge::plan(30, 50_000, Some(200_000), None);
		assert!(!gauge.overflowed());
		assert_eq!(gauge_row(&gauge), "======25%----------------200K-");
	}

	#[test]
	fn context_gauge_marks_compaction_boundaries_and_dodges_them() {
		let boundaries =
			CompactionBoundaries { threshold_percent: 80.0, speculation_percent: Some(70.0) };
		let gauge = ContextGauge::plan(30, 160_000, Some(200_000), Some(boundaries));
		assert_eq!(gauge_row(&gauge), "==================S=T80%-200K-");
	}

	#[test]
	fn context_gauge_overflow_breaks_the_percent_past_the_window_label() {
		let gauge = ContextGauge::plan(30, 400_000, Some(200_000), None);
		assert!(gauge.overflowed());
		assert_eq!(gauge_row(&gauge), "=====================200K-200%");
	}

	#[test]
	fn context_gauge_without_a_window_plans_a_solid_line() {
		let gauge = ContextGauge::plan(6, 1_234, None, None);
		assert_eq!(gauge_row(&gauge), "======");
	}

	#[test]
	fn context_gauge_keeps_one_accent_cell_for_a_fresh_session() {
		let gauge = ContextGauge::plan(30, 0, Some(200_000), None);
		assert_eq!(gauge_row(&gauge), "=0%----------------------200K-");
	}

	#[test]
	fn narrow_gauges_drop_labels_but_keep_the_fill() {
		let gauge = ContextGauge::plan(
			7,
			100_000,
			Some(200_000),
			Some(CompactionBoundaries { threshold_percent: 80.0, speculation_percent: None }),
		);
		assert_eq!(gauge_row(&gauge), "====---", "width below 8 hides ticks and labels");
	}

	#[test]
	fn compact_counts_share_the_context_label_notation() {
		let mut label = String::new();
		let _ = write_compact_count(&mut label, 200_000);
		assert_eq!(label, "200K");
		label.clear();
		let _ = write_compact_count(&mut label, 1_500_000);
		assert_eq!(label, "1.5M");
		label.clear();
		let _ = write_compact_count(&mut label, 999);
		assert_eq!(label, "999");
	}

	#[test]
	fn billing_labels_degrade_by_charset() {
		assert_eq!(spend_label(250_000_000, false, Charset::Ascii), "$0.25");
		assert_eq!(spend_label(250_000_000, true, Charset::Ascii), "S0.25");
		assert_eq!(spend_label(0, true, Charset::Unicode), "(sub)");
		assert_eq!(spend_label(250_000_000, true, Charset::NerdFont), "\u{f067a} 0.25",);
	}

	#[test]
	fn advisor_billing_uses_semantic_glyphs() {
		assert_eq!(advisor_spend_label(250_000_000, false, Charset::Ascii), "$0.25 (adv)",);
		assert_eq!(advisor_spend_label(250_000_000, true, Charset::Unicode), "👁 S0.25",);
		assert_eq!(
			advisor_spend_label(250_000_000, true, Charset::NerdFont),
			"\u{ea70} \u{f067a} 0.25",
		);
	}
}
