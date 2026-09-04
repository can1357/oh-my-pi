use std::{borrow::Cow, time::Duration};

use omp_core::{IntoStr, Str, StrMut, sf};
use smallvec::SmallVec;
use xutf::Text;

use super::{overflow_plan, paint_overflow_footer, text_limit::limit_utf16};
use crate::{
	Frame, UiContext,
	anim::{self},
	component::{Component, MemoKey, PaintCtx, Slot, next_slot},
	frame::{Decor, DecorKind, Rect, Style},
	markdown::highlight::{self, HighlightStyles},
	markup::{Align, TextWrap, Truncate},
	props::{Prop, PropValue, Props},
	rich::{Pipeline, RichSink, RichText, cell_width, decompose},
};

/// Wrapped or truncated text backing the `<text>` markup tag.
pub struct TextLeaf {
	props:        Props,
	slot:         Slot,
	text:         Str,
	rich:         RichText,
	version:      u64,
	cached_width: u16,
	cached:       Option<MemoKey>,
	/// Resolved style baked into `rich` — part of the memo key so prop or
	/// theme changes (including animated swaps) re-render the runs.
	cached_style: Style,
	/// Byte end of the rendered slice of `text` — the whole text without
	/// `reveal`, the shown prefix under it. Part of the memo key so a
	/// moving reveal cursor re-renders the runs.
	cached_end:   usize,
	/// Reveal cursor and grapheme memos; allocated on first paced render.
	reveal:       Option<Box<RevealState>>,
}

impl TextLeaf {
	/// Creates an empty text leaf.
	pub fn new() -> Self {
		Self {
			props:        Props::new(),
			slot:         next_slot(),
			text:         Str::default(),
			rich:         RichText::default(),
			version:      1,
			cached_width: 0,
			cached:       None,
			cached_style: Style::new(),
			cached_end:   0,
			reveal:       None,
		}
	}

	/// Sets one text property.
	pub fn with(mut self, prop: Prop, value: impl Into<PropValue>) -> Self {
		self.props.set(prop, value);
		self.version = self.version.wrapping_add(1);
		self
	}

	/// Sets one text property from a string.
	pub fn with_str(self, prop: Prop, value: &str) -> Self {
		self.with(prop, value)
	}

	/// Sets one arbitrary custom property beside the typed ones.
	pub fn with_custom(mut self, name: impl IntoStr, value: impl Into<PropValue>) -> Self {
		self.props = self.props.with_custom(name, value);
		self.version = self.version.wrapping_add(1);
		self
	}

	/// Appends plain text content.
	pub fn text(mut self, text: impl IntoStr) -> Self {
		append(&mut self.text, text.into_str());
		self.version = self.version.wrapping_add(1);
		self
	}

	fn limited_text<'a>(&self, text: &'a str) -> Cow<'a, str> {
		let truncate_from = self.props.truncate_from();
		self.props.max_chars().map_or_else(
			|| Cow::Borrowed(text),
			|max_chars| limit_utf16(text, usize::from(max_chars), truncate_from),
		)
	}

	fn render(&mut self, ctx: &UiContext, width: u16) {
		let width = width.max(1);
		let style = self.props.style(&ctx.theme);
		let key = MemoKey::new(self.version, ctx);
		let end = if let Some(horizon) = self.props.reveal() {
			let reveal = self.reveal.get_or_insert_default();
			reveal.sync(&self.text);
			reveal.advance(ctx.now, horizon)
		} else {
			// Dropping the prop drops the cursor, so re-enabling
			// reveals from the start again.
			self.reveal = None;
			self.text.len()
		};
		if self.cached_width == width
			&& self.cached == Some(key)
			&& self.cached_style == style
			&& self.cached_end == end
		{
			return;
		}
		let visible = self.limited_text(&self.text[..end]);
		let limited_owned = matches!(&visible, std::borrow::Cow::Owned(_));
		let visible = visible.as_ref();
		self.rich.clear();
		match self.props.truncate() {
			Some(Truncate::End) => {
				let mut clip = (&mut self.rich).clip(width, Some('…'));
				for (index, line) in visible.split('\n').enumerate() {
					if index > 0 {
						clip.run(style, " ");
					}
					clip.run(style, line);
				}
			},
			Some(Truncate::Start) => {
				let mut runs: SmallVec<(Style, Str), 8> = SmallVec::new();
				for (index, line) in visible.split('\n').enumerate() {
					if index > 0 {
						runs.push((style, sf!(" ")));
					}
					if !line.is_empty() {
						runs.push((
							style,
							if limited_owned {
								Str::new(line)
							} else {
								self.text.slice_ref(line)
							},
						));
					}
				}
				clip_start_runs(&mut self.rich, width, &runs);
			},
			None if self.props.text_wrap() == TextWrap::Char => {
				// Terminal-exact flow: rows break grapheme-exact at the
				// width and every boundary stays byte-joinable for copy.
				let mut wrap = (&mut self.rich).wrap_chars(width);
				for (index, line) in visible.split('\n').enumerate() {
					if index > 0 {
						wrap.newline();
					}
					if !line.is_empty() {
						wrap.run(style, line);
					}
				}
			},
			None if self.props.text_wrap() == TextWrap::Pre => {
				for (index, line) in visible.split('\n').enumerate() {
					if index > 0 {
						self.rich.newline();
					}
					if !line.is_empty() {
						self.rich.run(style, line);
					}
				}
			},
			None => {
				let mut wrap = (&mut self.rich).wrap(width);
				// text is escape-free by contract: ANSI is parsed only at the
				// external ingress (rich::decompose), never inside components
				for (index, line) in visible.split('\n').enumerate() {
					if index > 0 {
						wrap.newline();
					}
					if !line.is_empty() {
						wrap.run(style, line);
					}
				}
				wrap.finish();
			},
		}
		self.cached_width = width;
		self.cached = Some(key);
		self.cached_style = style;
		self.cached_end = end;
	}
}

impl Default for TextLeaf {
	fn default() -> Self {
		Self::new()
	}
}

impl Component for TextLeaf {
	fn props(&self) -> &Props {
		&self.props
	}

	fn props_mut(&mut self) -> &mut Props {
		&mut self.props
	}

	fn slot(&self) -> Slot {
		self.slot
	}

	fn measure(&mut self, _ctx: &UiContext) -> (u16, u16) {
		let text = self.limited_text(&self.text);
		if self.props.text_wrap() == TextWrap::Pre {
			let natural = text.as_ref().split('\n').map(cell_width).max().unwrap_or(0);
			return (natural, natural);
		}
		let mut widest_word = 0;
		let mut total = 0u16;
		for word in text.split_whitespace() {
			let width = cell_width(word);
			widest_word = widest_word.max(width);
			total = total.saturating_add(width).saturating_add(1);
		}
		let natural = total.saturating_sub(1);
		// Truncation can always collapse to a lone ellipsis, and char-wrap
		// flows at any width, so neither blocks a column from shrinking.
		if self.props.truncate().is_some() || self.props.text_wrap() == TextWrap::Char {
			return (natural.min(1), natural);
		}
		(widest_word, natural)
	}

	fn height(&mut self, ctx: &UiContext, width: u16) -> u16 {
		self.render(ctx, width);
		RichText::rows(&self.rich)
	}

	fn paint(&mut self, pc: &mut PaintCtx<'_>, rect: Rect) {
		self.render(pc.ctx, rect.width);
		match self.props.shimmer() {
			Some(period) => {
				paint_rich_shimmer(pc, rect, &self.rich, self.props.align(), period);
				if !pc.ctx.native_decor {
					pc.wake(self.slot, pc.now.saturating_add(anim::FRAME));
				}
			},
			None => paint_rich(pc, rect, &self.rich, self.props.align()),
		}
		// An unsettled reveal moves geometry as rows fill, so its frame
		// cadence must relayout, not just repaint.
		if let Some(reveal) = self.reveal.as_deref()
			&& !reveal.is_settled()
		{
			if pc.ctx.native_decor {
				let row = RichText::rows(&self.rich).saturating_sub(1);
				let width = self.rich.row_width(row);
				let slack = rect.width.saturating_sub(width);
				let x = rect
					.x
					.saturating_add(alignment_slack(self.props.align(), slack));
				pc.frame.push_decor(Decor {
					rect: Rect { x, y: rect.y.saturating_add(row), width, height: 1 },
					kind: DecorKind::Reveal { front: f32::from(x.saturating_add(width)) },
				});
			}
			pc.wake_layout(self.slot, pc.now.saturating_add(anim::FRAME));
		}
	}

	fn set_text(&mut self, _ctx: &UiContext, text: Str) -> bool {
		if self.text == text {
			return false;
		}
		self.text = text;
		self.version = self.version.wrapping_add(1);
		true
	}
}

impl TextLeaf {
	/// Verbatim content for single-line flattening by grid cells.
	pub(crate) const fn content(&self) -> &Str {
		&self.text
	}

	/// Whether the leaf shows all of its text: no `reveal`, or a cursor
	/// that has caught up with the current text.
	pub fn reveal_settled(&self) -> bool {
		self.props.reveal().is_none()
			|| self
				.reveal
				.as_deref()
				.is_some_and(|reveal| reveal.covers(&self.text))
	}
}

/// Reveal bookkeeping for one leaf: the pacing cursor plus grapheme-cluster
/// memos over its append-only text. Counting resumes from the final counted
/// cluster and slicing from the last shown cluster — an append can extend
/// those clusters but never earlier ones — so each streamed chunk and each
/// cursor step re-segments only the suffix it touched.
#[derive(Default)]
pub struct RevealState {
	pace:        anim::Reveal,
	/// The text the memos below describe (O(1) clone of the leaf's text).
	seen:        Str,
	/// Grapheme clusters in `seen`.
	total:       usize,
	/// Byte start of the final cluster of `seen`.
	tail:        usize,
	/// Clusters currently shown.
	shown_units: usize,
	/// Byte end of the shown prefix.
	shown_end:   usize,
	/// Byte start of the final shown cluster.
	shown_from:  usize,
}

impl RevealState {
	/// Reconciles the memos with the leaf's current text: an extension
	/// recounts from the final counted cluster, anything else recounts in
	/// full and restarts the cursor.
	pub(crate) fn sync(&mut self, text: &Str) {
		if self.seen == *text {
			return;
		}
		if text.len() > self.seen.len() && text.starts_with(self.seen.as_str()) {
			let (count, tail) = count_clusters(text, self.tail);
			self.total = if self.total == 0 {
				count
			} else {
				self.total - 1 + count
			};
			self.tail = tail;
		} else {
			let (count, tail) = count_clusters(text, 0);
			self.total = count;
			self.tail = tail;
			self.pace.reset();
			self.shown_units = 0;
			self.shown_end = 0;
			self.shown_from = 0;
		}
		self.seen = text.clone();
	}

	/// Advances the cursor at `now` and returns the byte end of the shown
	/// prefix. Always re-walks from the final shown cluster, so an append
	/// that extended it is picked up even when the cursor held still.
	pub(crate) fn advance(&mut self, now: Duration, horizon: Duration) -> usize {
		let units = self.pace.advance(now, self.total, horizon);
		if units >= self.total {
			self.shown_units = self.total;
			self.shown_end = self.seen.len();
			self.shown_from = self.tail;
			return self.shown_end;
		}
		if units == 0 {
			self.shown_units = 0;
			self.shown_end = 0;
			self.shown_from = 0;
			return 0;
		}
		let (start, need, base) = if self.shown_units > 0 && units >= self.shown_units {
			(self.shown_from, units - self.shown_units + 1, self.shown_units - 1)
		} else {
			(0, units, 0)
		};
		let mut offset = start;
		let mut last = start;
		let mut walked = 0;
		for cluster in xutf::graphemes_str(&self.seen[start..]) {
			last = offset;
			offset += cluster.len();
			walked += 1;
			if walked == need {
				break;
			}
		}
		self.shown_units = base + walked;
		self.shown_from = last;
		self.shown_end = offset;
		self.shown_end
	}

	/// Whether the shown prefix covers the whole synced text.
	pub(crate) const fn is_settled(&self) -> bool {
		self.shown_units >= self.total
	}

	/// Whether the shown prefix covers all of `text` — settled, and no
	/// unsynced append is waiting for the next render.
	pub(crate) fn covers(&self, text: &Str) -> bool {
		self.is_settled() && self.seen == *text
	}
}

/// Counts grapheme clusters of `text` from byte offset `start`, also
/// reporting the byte start of the final cluster (where an append could
/// extend it). Empty input reports `(0, start)`.
fn count_clusters(text: &str, start: usize) -> (usize, usize) {
	let mut count = 0;
	let mut tail = start;
	let mut offset = start;
	for cluster in xutf::graphemes_str(&text[start..]) {
		count += 1;
		tail = offset;
		offset += cluster.len();
	}
	(count, tail)
}
const fn decimal_width(mut value: u64) -> u16 {
	let mut width = 1;
	while value >= 10 {
		value /= 10;
		width += 1;
	}
	width
}
fn line_number_prefix<'a>(
	number: u64,
	digits: usize,
	rail: &str,
	buffer: &'a mut [u8; 32],
) -> &'a str {
	let number_width = usize::from(decimal_width(number));
	let pad = digits.saturating_sub(number_width);
	buffer[..pad].fill(b' ');
	let mut cursor = digits;
	let mut remaining = number;
	loop {
		cursor -= 1;
		buffer[cursor] = b'0' + u8::try_from(remaining % 10).unwrap_or(0);
		remaining /= 10;
		if remaining == 0 {
			break;
		}
	}
	buffer[digits] = b' ';
	let end = digits + 1 + rail.len();
	buffer[digits + 1..end].copy_from_slice(rail.as_bytes());
	std::str::from_utf8(&buffer[..end]).expect("line-number chrome is valid UTF-8")
}

/// Preformatted text backing the `<pre>` markup tag.
pub struct Pre {
	props:           Props,
	slot:            Slot,
	text:            Str,
	line_count:      u16,
	max_width:       u16,
	highlighted:     RichText,
	highlighted_for: Option<(crate::Theme, Str)>,
	authored:        RichText,
	authored_ansi:   bool,
}

impl Pre {
	/// Creates an empty preformatted block.
	pub fn new() -> Self {
		Self {
			props:           Props::new(),
			slot:            next_slot(),
			text:            Str::default(),
			line_count:      0,
			max_width:       0,
			highlighted:     RichText::default(),
			highlighted_for: None,
			authored:        RichText::default(),
			authored_ansi:   false,
		}
	}

	/// Sets one property.
	pub fn with(mut self, prop: Prop, value: impl Into<PropValue>) -> Self {
		self.props.set(prop, value);
		self
	}

	/// Sets one property from a string.
	pub fn with_str(self, prop: Prop, value: &str) -> Self {
		self.with(prop, value)
	}

	/// Appends preformatted text content.
	pub fn text(mut self, text: impl IntoStr) -> Self {
		append(&mut self.text, text.into_str());
		self.refresh_metrics();
		self
	}

	/// Verbatim content for single-line flattening by grid cells.
	pub(crate) const fn content(&self) -> &Str {
		&self.text
	}

	fn refresh_metrics(&mut self) {
		self.authored.clear();
		self.authored_ansi = self.text.as_bytes().contains(&b'\x1b');
		if self.authored_ansi {
			decompose(&self.text, &mut self.authored);
			self.line_count = RichText::rows(&self.authored);
			self.max_width = (0..self.line_count)
				.map(|row| self.authored.row_width(row))
				.max()
				.unwrap_or(0);
		} else {
			let mut line_count = 0_u16;
			let mut max_width = 0_u16;
			for line in self.text.lines() {
				line_count = line_count.saturating_add(1);
				max_width = max_width.max(cell_width(line));
			}
			self.line_count = line_count;
			self.max_width = max_width;
		}
		self.highlighted_for = None;
	}

	fn syntax_token(&self) -> Option<&str> {
		if self.authored_ansi {
			return None;
		}
		let path = self.props.str_of(Prop::Path)?.as_str();
		let name = path.rsplit(['/', '\\']).next().unwrap_or(path);
		let token = name
			.rsplit_once('.')
			.map_or(name, |(_, extension)| extension)
			.split(':')
			.next()
			.unwrap_or_default();
		highlight::supports_language(token).then_some(token)
	}

	fn refresh_highlight(&mut self, ctx: &UiContext) {
		let Some(token) = self.syntax_token().map(str::to_owned) else {
			self.highlighted_for = None;
			self.highlighted.clear();
			return;
		};
		if self
			.highlighted_for
			.as_ref()
			.is_some_and(|(theme, cached)| *theme == ctx.theme && cached.as_str() == token)
		{
			return;
		}
		self.highlighted.clear();
		highlight::render(
			&self.text,
			&token,
			usize::from(self.line_count),
			&HighlightStyles::from_theme(&ctx.theme),
			&mut self.highlighted,
		);
		self.highlighted_for = Some((ctx.theme, Str::new(token)));
	}
}

impl Default for Pre {
	fn default() -> Self {
		Self::new()
	}
}

impl Pre {
	fn numbered(&self) -> bool {
		self.props.numbers()
	}

	fn start(&self) -> u64 {
		self.props.start()
	}

	const fn line_count(&self) -> u16 {
		self.line_count
	}

	fn visible_rows(&self, available: u16) -> u16 {
		self.line_count().min(available)
	}

	fn gutter_width(&self, rows: u16) -> u16 {
		if !self.numbered() || rows == 0 {
			return 0;
		}
		let last = self
			.start()
			.saturating_add(u64::from(rows.saturating_sub(1)));
		decimal_width(last).saturating_add(3)
	}
}

impl Component for Pre {
	fn props(&self) -> &Props {
		&self.props
	}

	fn props_mut(&mut self) -> &mut Props {
		&mut self.props
	}

	fn slot(&self) -> Slot {
		self.slot
	}

	fn measure(&mut self, _ctx: &UiContext) -> (u16, u16) {
		let width = self.max_width;
		let rows = overflow_plan(&self.props, self.line_count(), u16::MAX)
			.map_or_else(|| self.line_count(), |plan| plan.content_rows);
		let width = width.saturating_add(self.gutter_width(rows));
		(width, width)
	}

	fn height(&mut self, _ctx: &UiContext, _width: u16) -> u16 {
		overflow_plan(&self.props, self.line_count(), u16::MAX).map_or_else(
			|| self.line_count(),
			|plan| {
				plan
					.content_rows
					.saturating_add(u16::from(!plan.noun.is_empty()))
			},
		)
	}

	fn paint(&mut self, pc: &mut PaintCtx<'_>, rect: Rect) {
		self.refresh_highlight(pc.ctx);
		let plan = overflow_plan(&self.props, self.line_count(), rect.height);
		let content_rows = plan.map_or(rect.height, |plan| plan.content_rows);
		let clip = pc.clip.min(rect.y.saturating_add(content_rows));
		let rows = self.visible_rows(clip.saturating_sub(rect.y));
		let gutter = self.gutter_width(rows);
		let text_width = self.max_width;
		let block_width = gutter.saturating_add(text_width).min(rect.width);
		let slack = rect.width.saturating_sub(block_width);
		let x = rect
			.x
			.saturating_add(alignment_slack(self.props.align(), slack));
		let right = rect.x.saturating_add(rect.width);
		let content_x = x.saturating_add(gutter).min(right);
		let style = self.props.style(&pc.ctx.theme);
		let gutter_style = Style::new().fg(pc.ctx.theme.muted);
		let digits = gutter.saturating_sub(3) as usize;
		let mut prefix_buffer = [0_u8; 32];
		if self.authored_ansi {
			for row in 0..self.line_count {
				let y = rect.y.saturating_add(row);
				if y >= clip {
					break;
				}
				if gutter > 0 {
					let number = self.start().saturating_add(u64::from(row));
					let prefix = line_number_prefix(
						number,
						digits,
						pc.ctx.charset.quote_rail(),
						&mut prefix_buffer,
					);
					put_clipped(pc.frame, x, y, content_x, prefix, gutter_style);
				}
				let mut run_x = content_x;
				for (authored, text) in self.authored.row_runs(row) {
					run_x = put_clipped(pc.frame, run_x, y, right, text, authored.inherit(style));
				}
			}
		} else {
			for (row, line) in self.text.lines().enumerate() {
				let y = rect
					.y
					.saturating_add(u16::try_from(row).unwrap_or(u16::MAX));
				if y >= clip {
					break;
				}
				if gutter > 0 {
					let number = self
						.start()
						.saturating_add(u64::try_from(row).unwrap_or(u64::MAX));
					let prefix = line_number_prefix(
						number,
						digits,
						pc.ctx.charset.quote_rail(),
						&mut prefix_buffer,
					);
					put_clipped(pc.frame, x, y, content_x, prefix, gutter_style);
				}
				if self.highlighted_for.is_some() {
					let inline_number = line
						.bytes()
						.position(|byte| !byte.is_ascii_whitespace() && !byte.is_ascii_digit())
						.and_then(|first| {
							let prefix = &line[..first];
							(prefix.bytes().any(|byte| byte.is_ascii_digit())).then_some(first)
						})
						.unwrap_or(0);
					let mut run_x = content_x;
					if inline_number > 0 {
						run_x = put_clipped(
							pc.frame,
							run_x,
							y,
							right,
							&line[..inline_number],
							style.fg(pc.ctx.theme.muted),
						);
					}
					let mut skip = inline_number;
					for (run_style, text) in self.highlighted.row_runs(row as u16) {
						let text = if skip >= text.len() {
							skip -= text.len();
							continue;
						} else {
							let text = &text[skip..];
							skip = 0;
							text
						};
						run_x = put_clipped(pc.frame, run_x, y, right, text, style.inherit(run_style));
					}
				} else {
					put_clipped(pc.frame, content_x, y, right, line, style);
				}
			}
		}
		if let Some(plan) = plan {
			paint_overflow_footer(pc, rect, plan);
		}
	}

	fn gradient_bounds(&self, content: Rect) -> Option<Rect> {
		let height = self.visible_rows(
			overflow_plan(&self.props, self.line_count(), content.height)
				.map_or(content.height, |plan| plan.content_rows),
		);
		let gutter = self.gutter_width(height);
		let text_width = self.max_width;
		let block_width = gutter.saturating_add(text_width).min(content.width);
		let slack = content.width.saturating_sub(block_width);
		let x = content
			.x
			.saturating_add(alignment_slack(self.props.align(), slack))
			.saturating_add(gutter.min(content.width));
		let width = text_width.min(content.x.saturating_add(content.width).saturating_sub(x));
		Some(Rect::new(x, content.y, width, height))
	}

	fn set_text(&mut self, _ctx: &UiContext, text: Str) -> bool {
		if self.text == text {
			return false;
		}
		self.text = text;
		self.refresh_metrics();
		true
	}
}

pub(super) fn append(target: &mut Str, suffix: Str) {
	if target.is_empty() {
		*target = suffix;
		return;
	}
	let mut joined = StrMut::with_capacity(target.len().saturating_add(suffix.len()));
	joined.push_str(target);
	joined.push_str(&suffix);
	*target = joined.freeze();
}

/// Emits `runs` as one line clipped to `width` cells keeping the tail: a
/// leading ellipsis replaces however much of the head does not fit.
pub(super) fn clip_start_runs(rich: &mut RichText, width: u16, runs: &[(Style, Str)]) {
	let width = width.max(1);
	let total = runs
		.iter()
		.fold(0_u16, |sum, (_, text)| sum.saturating_add(cell_width(text)));
	if total <= width {
		for (style, text) in runs {
			rich.run(*style, text);
		}
		return;
	}
	// Reserve one cell for the ellipsis, then walk graphemes forward until
	// the dropped prefix frees enough room for the remaining tail.
	let budget = width - 1;
	let mut drop = total.saturating_add(1).saturating_sub(width);
	let marker = runs.first().map_or(Style::new(), |(style, _)| *style);
	rich.run(marker, "…");
	// The clip pipeline guards the exact edge (a wide grapheme straddling
	// the boundary), so the tail can never overrun the cell budget.
	let mut clip = (&mut *rich).clip(budget.saturating_add(1), None);
	for (style, text) in runs {
		if drop == 0 {
			clip.run(*style, text);
			continue;
		}
		let run_width = cell_width(text);
		if run_width <= drop {
			drop -= run_width;
			continue;
		}
		let mut cut = text.len();
		let mut walked = 0_u16;
		for (offset, grapheme) in text.as_str().grapheme_indices() {
			if walked >= drop {
				cut = offset;
				break;
			}
			walked = walked.saturating_add(cell_width(grapheme));
		}
		drop = 0;
		clip.run(*style, &text.as_str()[cut..]);
	}
}

pub(super) fn truncate_rich(
	rich: &mut RichText,
	width: u16,
	fallback: Style,
	truncate: Option<Truncate>,
) {
	let Some(mode) = truncate else { return };
	if RichText::rows(rich) <= 1 {
		return;
	}
	match mode {
		Truncate::End => {
			let row: SmallVec<(Style, Str), 4> = rich
				.row_runs(0)
				.map(|(style, text)| (style, Str::new(text)))
				.collect();
			rich.clear();
			{
				let mut clip = (&mut *rich).clip(width.saturating_sub(1), None);
				for (style, text) in &row {
					clip.run(*style, text);
				}
			}
			let style = rich.row_runs(0).last().map_or(fallback, |(style, _)| style);
			rich.run(style, "…");
		},
		Truncate::Start => {
			// Rejoin the wrapped rows with single spaces and keep the tail.
			let mut joined: SmallVec<(Style, Str), 8> = SmallVec::new();
			for row in 0..RichText::rows(rich) {
				if row > 0 {
					let style = joined.last().map_or(fallback, |(style, _)| *style);
					joined.push((style, sf!(" ")));
				}
				for (style, text) in rich.row_runs(row) {
					joined.push((style, Str::new(text)));
				}
			}
			rich.clear();
			clip_start_runs(rich, width, &joined);
		},
	}
}

pub(super) const fn alignment_slack(align: Align, slack: u16) -> u16 {
	match align {
		Align::Start => 0,
		Align::Center => slack / 2,
		Align::End => slack,
	}
}

pub(super) fn put_clipped(
	frame: &mut Frame,
	x: u16,
	y: u16,
	right: u16,
	text: &str,
	style: Style,
) -> u16 {
	let room = right.saturating_sub(x);
	if room == 0 {
		return x;
	}
	let visible = text.truncate_width(usize::from(room));
	frame.put(x, y, visible, style)
}

pub(super) fn paint_rich(pc: &mut PaintCtx<'_>, rect: Rect, rich: &RichText, align: Align) {
	let right = rect.x.saturating_add(rect.width);
	let clip = pc.clip.min(rect.y.saturating_add(rect.height));
	// Only rows spanning the whole physical line can byte-join through
	// terminal autowrap; narrower or offset rects keep hard boundaries.
	let full_row = rect.x == 0 && rect.width == pc.frame.size().width;
	for row in 0..RichText::rows(rich) {
		let y = rect.y.saturating_add(row);
		if y >= clip {
			break;
		}
		if full_row && row > 0 && rich.row_soft_wrap(row - 1) && rich.row_width(row - 1) == rect.width
		{
			pc.frame.set_soft_wrap(y - 1);
		}
		let slack = rect.width.saturating_sub(rich.row_width(row));
		let mut x = rect.x.saturating_add(alignment_slack(align, slack));
		for (style, text) in rich.row_runs(row) {
			x = put_clipped(pc.frame, x, y, right, text, style);
			if x >= right {
				break;
			}
		}
	}
}

/// [`paint_rich`] under a `shimmer` crest: every cell restyles by its
/// distance from the sweep, and each row rides the same phase.
fn paint_rich_shimmer(
	pc: &mut PaintCtx<'_>,
	text_rect: Rect,
	rich: &RichText,
	align: Align,
	period: Duration,
) {
	if pc.ctx.native_decor {
		paint_rich(pc, text_rect, rich, align);
		pc.frame
			.push_decor(Decor { rect: text_rect, kind: DecorKind::Shimmer { period } });
		return;
	}
	let right = text_rect.x.saturating_add(text_rect.width);
	let clip = pc.clip.min(text_rect.y.saturating_add(text_rect.height));
	let full_row = text_rect.x == 0 && text_rect.width == pc.frame.size().width;
	for row in 0..RichText::rows(rich) {
		let y = text_rect.y.saturating_add(row);
		if y >= clip {
			break;
		}
		if full_row
			&& row > 0
			&& rich.row_soft_wrap(row - 1)
			&& rich.row_width(row - 1) == text_rect.width
		{
			pc.frame.set_soft_wrap(y - 1);
		}
		let slack = text_rect.width.saturating_sub(rich.row_width(row));
		let start = text_rect.x.saturating_add(alignment_slack(align, slack));
		let shimmer = anim::Shimmer::new(pc.now, period, rich.row_width(row));
		let mut x = start;
		'runs: for (style, text) in rich.row_runs(row) {
			for grapheme in xutf::graphemes_str(text) {
				if x >= right {
					break 'runs;
				}
				let next = pc
					.frame
					.put(x, y, grapheme, shimmer.style_at(x - start, style));
				if next == x {
					break 'runs;
				}
				x = next;
			}
		}
	}
}
#[cfg(test)]
mod tests {
	use super::*;
	use crate::{
		UiContext,
		component::{Component, PaintCtx},
		components::{Callout, Icon, Latex, Markdown},
		context::Charset,
		frame::{Color, Frame, Rect, Size},
		test_support::frame_row_text,
		ui::Ui,
	};

	fn paint(component: &mut dyn Component, width: u16, height: u16) -> Frame {
		let ctx = UiContext::default();
		let mut frame = Frame::new(Size::new(width, height));
		let mut hits = Vec::new();
		let mut wakes = Vec::new();
		let mut pc = PaintCtx::new(&mut frame, &ctx, &mut hits, &mut wakes);
		component.paint(&mut pc, Rect::new(0, 0, width, height));
		frame
	}

	#[test]
	fn full_width_overflow_marks_soft_wrap_boundaries() {
		let mut text = TextLeaf::new().text("abcdefghij");
		let frame = paint(&mut text, 8, 2);
		assert!(frame.soft_wrap(0), "a mid-word wrap at full width is joinable");
	}

	#[test]
	fn char_wrap_prop_flows_terminal_exact() {
		let mut text = TextLeaf::new().with(Prop::Wrap, "char").text("ab cdefgh x");
		let frame = paint(&mut text, 8, 2);
		assert_eq!(frame_row_text(&frame, 0), "ab cdefg");
		assert_eq!(frame_row_text(&frame, 1), "h x");
		assert!(frame.soft_wrap(0));
	}
	#[test]
	fn pre_wrap_preserves_spaces_and_never_soft_wraps() {
		let ctx = UiContext::default();
		let mut text = TextLeaf::new().with(Prop::Wrap, "pre").text("a  b\n  x");
		assert_eq!(text.measure(&ctx), (4, 4));
		assert_eq!(text.height(&ctx, 2), 2, "narrow widths do not add rows");
		let frame = paint(&mut text, 8, 2);
		assert_eq!(frame_row_text(&frame, 0), "a  b");
		assert_eq!(frame_row_text(&frame, 1), "  x");
		assert!(!frame.soft_wrap(0));
	}

	#[test]
	fn offset_rects_keep_hard_boundaries() {
		let ctx = UiContext::default();
		let mut frame = Frame::new(Size::new(9, 2));
		let mut hits = Vec::new();
		let mut wakes = Vec::new();
		let mut pc = PaintCtx::new(&mut frame, &ctx, &mut hits, &mut wakes);
		let mut text = TextLeaf::new().text("abcdefghij");
		text.paint(&mut pc, Rect::new(1, 0, 8, 2));
		drop(pc);
		assert!(!frame.soft_wrap(0), "offset text cannot byte-join through autowrap");
	}
	#[test]
	fn short_rows_are_never_certified_joinable() {
		// The wide glyph cannot straddle the boundary, so the first row
		// ends one column short of the width: the break is soft in the
		// layout but not byte-joinable, and the painter must not flag it.
		let mut text = TextLeaf::new().with(Prop::Wrap, "char").text("abc界de");
		let frame = paint(&mut text, 4, 2);
		assert_eq!(frame_row_text(&frame, 0), "abc");
		assert_eq!(frame_row_text(&frame, 1), "界de");
		assert!(!frame.soft_wrap(0), "a row short of the margin cannot arm autowrap");
	}
	#[test]
	fn text_wraps_and_aligns_rows() {
		let mut text = TextLeaf::new()
			.with(Prop::Align, "center")
			.text("one two three");
		let frame = paint(&mut text, 7, 2);
		assert_eq!(frame_row_text(&frame, 0), "one two");
		assert_eq!(frame_row_text(&frame, 1), " three");
	}

	#[test]
	fn pre_paints_verbatim_rows() {
		let mut pre = Pre::new().text("A\n B");
		let frame = paint(&mut pre, 4, 2);
		assert_eq!(frame_row_text(&frame, 0), "A");
		assert_eq!(frame_row_text(&frame, 1), " B");
	}

	#[test]
	fn pre_decomposes_authored_ansi_without_flattening_attributes() {
		let ctx = UiContext::default();
		let mut pre = Pre::new().text("\x1b[31;1;3mhot\x1b[0m plain");
		assert_eq!(pre.measure(&ctx), (9, 9));
		let frame = paint(&mut pre, 12, 1);
		assert_eq!(frame_row_text(&frame, 0), "hot plain");
		let authored = frame.cell(0, 0).style().spec();
		assert_eq!(authored.foreground, Color::Indexed(1));
		assert!(authored.bold);
		assert!(authored.italic);
		let plain = frame.cell(4, 0).style().spec();
		assert!(!plain.bold);
		assert!(!plain.italic);
	}

	#[test]
	fn numbered_pre_aligns_multi_digit_starts_and_keeps_height() {
		let ctx = UiContext::default();
		let mut pre = Pre::new()
			.with(Prop::Numbers, true)
			.with(Prop::Start, 9_u64)
			.text("A\nB\nC");
		assert_eq!(pre.height(&ctx, 1), 3, "gutters never introduce wrapped rows");
		let frame = paint(&mut pre, 8, 2);
		assert_eq!(frame_row_text(&frame, 0), " 9 │ A");
		assert_eq!(frame_row_text(&frame, 1), "10 │ B");
	}

	#[test]
	fn numbered_pre_uses_physically_visible_range_and_survives_narrow_widths() {
		let ctx = UiContext::default();
		let mut pre = Pre::new()
			.with(Prop::Numbers, true)
			.with(Prop::Start, 8_u64)
			.with(Prop::MaxRows, 2_u16)
			.text("A\nB\nC");
		assert_eq!(pre.measure(&ctx), (5, 5), "clipped line 10 does not widen the gutter");
		let frame = paint(&mut pre, 6, 2);
		assert_eq!(frame_row_text(&frame, 0), "8 │ A");
		assert_eq!(frame_row_text(&frame, 1), "9 │ B");

		let frame = paint(&mut pre, 2, 2);
		assert_eq!(frame_row_text(&frame, 0), "8");
		assert_eq!(frame_row_text(&frame, 1), "9");
	}

	#[test]
	fn numbered_pre_reserves_shared_overflow_footer_after_content_rows() {
		let ctx = UiContext::default();
		let mut pre = Pre::new()
			.with(Prop::Numbers, true)
			.with(Prop::Start, 9_u64)
			.with(Prop::MaxRows, 3_u16)
			.with(Prop::Overflow, "lines")
			.text("A\nB\nC\nD");
		assert_eq!(pre.height(&ctx, 20), 3);
		let frame = paint(&mut pre, 20, 3);
		assert_eq!(frame_row_text(&frame, 0), " 9 │ A");
		assert_eq!(frame_row_text(&frame, 1), "10 │ B");
		assert_eq!(frame_row_text(&frame, 2), "… 2 more lines");
	}

	#[test]
	fn numbered_pre_preserves_offset_and_gradient_content_bounds() {
		let ctx = UiContext { charset: Charset::Ascii, ..UiContext::default() };
		let mut frame = Frame::new(Size::new(12, 2));
		let mut hits = Vec::new();
		let mut wakes = Vec::new();
		let mut pc = PaintCtx::new(&mut frame, &ctx, &mut hits, &mut wakes);
		let mut pre = Pre::new()
			.with(Prop::Numbers, true)
			.with(Prop::Start, 99_u64)
			.text("A\nB");
		pre.paint(&mut pc, Rect::new(2, 0, 10, 2));
		assert_eq!(frame_row_text(&frame, 0), "   99 | A");
		assert_eq!(pre.gradient_bounds(Rect::new(2, 0, 10, 2)), Some(Rect::new(8, 0, 1, 2)),);
	}

	#[test]
	fn text_max_chars_uses_directional_utf16_limits() {
		let mut end = TextLeaf::new()
			.with(Prop::MaxChars, 3_u16)
			.with(Prop::TruncateFrom, "end")
			.text("A😀BC");
		let frame = paint(&mut end, 20, 1);
		assert_eq!(frame_row_text(&frame, 0), "A😀…");

		let mut start = TextLeaf::new()
			.with(Prop::MaxChars, 3_u16)
			.with(Prop::TruncateFrom, "start")
			.text("A😀BC");
		let frame = paint(&mut start, 20, 1);
		assert_eq!(frame_row_text(&frame, 0), "…�BC");
	}

	#[test]
	fn markdown_paints_paragraph_and_fenced_code() {
		let mut markdown = Markdown::new().text("paragraph\n\n```rust\nlet x = 1;\n```");
		let frame = paint(&mut markdown, 24, 8);
		let rows = (0..8)
			.map(|row| frame_row_text(&frame, row))
			.collect::<Vec<_>>();
		assert!(rows.iter().any(|row| row.contains("paragraph")));
		assert!(rows.iter().any(|row| row.contains("let x = 1;")));
	}

	#[test]
	fn latex_paints_inline_when_block_layout_is_unavailable() {
		let mut latex = Latex::new().text(r"\unknown{x}");
		let frame = paint(&mut latex, 20, 3);
		assert!((0..3).any(|row| !frame_row_text(&frame, row).is_empty()));
	}

	#[test]
	fn callout_paints_header_and_body_rail() {
		let mut callout = Callout::new()
			.with(Prop::Title, "Advisor")
			.with(Prop::Badge, "1")
			.text("body");
		let frame = paint(&mut callout, 20, 3);
		assert!(frame_row_text(&frame, 0).contains("Advisor"));
		assert!(frame_row_text(&frame, 1).contains("body"));
		assert!(frame_row_text(&frame, 1).starts_with('▎'));
	}

	#[test]
	fn icon_measure_matches_painted_glyph_width() {
		let ctx = UiContext::default();
		let mut icon = Icon::named("folder");
		let (min, natural) = icon.measure(&ctx);
		assert_eq!(min, natural);
		let frame = paint(&mut icon, min.max(1), 1);
		assert_eq!(cell_width(&frame_row_text(&frame, 0)), min);
	}

	#[test]
	fn reveal_types_out_streamed_appends_and_settles() {
		let mut ui = Ui::from_root(
			TextLeaf::new()
				.with(Prop::Reveal, true)
				.with(Prop::Id, "stream")
				.text("abcdef"),
			20,
			UiContext::default(),
		);
		// The construction paint arms the cursor without revealing anything
		// and schedules the first frame.
		assert_eq!(frame_row_text(ui.frame(), 0), "");
		assert_eq!(ui.next_wake(), Some(Duration::from_millis(33)));

		// Each tick earns one 33ms frame at the 90 clusters/s floor: 2.97.
		assert!(ui.tick(Duration::from_millis(34)));
		assert_eq!(frame_row_text(ui.frame(), 0), "ab");
		ui.tick(Duration::from_millis(68));
		assert_eq!(frame_row_text(ui.frame(), 0), "abcde");
		ui.tick(Duration::from_millis(102));
		assert_eq!(frame_row_text(ui.frame(), 0), "abcdef");
		assert_eq!(ui.next_wake(), None, "a settled reveal stops waking");

		// An append resumes from the cursor instead of jumping or resetting.
		assert!(ui.set_text("stream", "abcdefghijkl"));
		assert_eq!(frame_row_text(ui.frame(), 0), "abcdef");
		assert!(ui.next_wake().is_some(), "new backlog re-arms the frame cadence");
		ui.tick(Duration::from_millis(136));
		assert_eq!(frame_row_text(ui.frame(), 0), "abcdefgh");
		ui.tick(Duration::from_millis(170));
		assert_eq!(frame_row_text(ui.frame(), 0), "abcdefghijk");
		ui.tick(Duration::from_millis(204));
		assert_eq!(frame_row_text(ui.frame(), 0), "abcdefghijkl");

		// A replacement restarts the typewriter from nothing.
		assert!(ui.set_text("stream", "xyz"));
		assert_eq!(frame_row_text(ui.frame(), 0), "");
		ui.tick(Duration::from_millis(238));
		assert_eq!(frame_row_text(ui.frame(), 0), "xy");
		ui.tick(Duration::from_millis(272));
		assert_eq!(frame_row_text(ui.frame(), 0), "xyz");
		assert_eq!(ui.next_wake(), None);
	}

	#[test]
	fn reveal_grows_height_as_rows_fill() {
		let mut ui = Ui::from_root(
			TextLeaf::new().with(Prop::Reveal, true).text("aaa bbb"),
			3,
			UiContext::default(),
		);
		assert_eq!(ui.height(), 1, "an empty reveal holds the blank row a bare leaf has");
		ui.tick(Duration::from_millis(34));
		assert_eq!(ui.height(), 1, "two clusters still fit the first row");
		ui.tick(Duration::from_millis(67));
		assert_eq!(ui.height(), 2, "the fifth cluster wraps onto a second row");
		ui.tick(Duration::from_millis(100));
		assert_eq!(frame_row_text(ui.frame(), 0), "aaa");
		assert_eq!(frame_row_text(ui.frame(), 1), "bbb");
	}

	#[test]
	fn native_reveal_tracks_the_painted_front_row() {
		let ctx = UiContext { native_decor: true, ..UiContext::default() };
		let mut ui = Ui::from_root(TextLeaf::new().with(Prop::Reveal, true).text("aaa bbb"), 3, ctx);
		assert_eq!(ui.frame().decors(), &[Decor {
			rect: Rect::new(0, 0, 0, 1),
			kind: DecorKind::Reveal { front: 0.0 },
		}]);

		assert!(ui.tick(Duration::from_millis(34)));
		assert!(ui.tick(Duration::from_millis(67)));
		assert_eq!(ui.frame().decors(), &[Decor {
			rect: Rect::new(0, 1, 1, 1),
			kind: DecorKind::Reveal { front: 1.0 },
		}]);

		assert!(ui.tick(Duration::from_millis(100)));
		assert_eq!(ui.frame().decors(), &[]);
	}

	#[test]
	fn reveal_state_extends_counts_across_cluster_boundaries() {
		let mut state = RevealState::default();
		state.sync(&Str::new("e"));
		assert_eq!(state.total, 1);
		// The appended combining mark extends the final cluster in place.
		state.sync(&Str::new("e\u{301}"));
		assert_eq!(state.total, 1);
		state.sync(&Str::new("e\u{301}f"));
		assert_eq!(state.total, 2);
		// Replacement restarts the cursor from nothing.
		state.sync(&Str::new("zz"));
		assert_eq!(state.total, 2);
		assert_eq!(state.advance(Duration::ZERO, Duration::from_millis(250)), 0);
	}

	#[test]
	fn reveal_state_reslices_the_boundary_cluster_after_an_append() {
		let mut state = RevealState::default();
		state.sync(&Str::new("ab"));
		// A zero horizon snaps the cursor to everything counted so far.
		assert_eq!(state.advance(Duration::ZERO, Duration::ZERO), 2);
		state.sync(&Str::new("ab\u{301}c"));
		// The shown boundary cluster grew; the slice re-walks it before
		// advancing rather than splitting the combining mark off.
		let end = state.advance(Duration::from_millis(1), Duration::from_millis(250));
		assert_eq!(&state.seen[..end], "ab\u{301}");
		assert!(!state.is_settled());
	}
}
