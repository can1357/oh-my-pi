use omp_core::{IntoStr, Str};

use super::text::{append, put_clipped};
use crate::{
	UiContext,
	component::{Component, MemoKey, PaintCtx, Slot, next_slot},
	frame::{Rect, Style},
	props::{Prop, PropValue, Props},
	rich::{Pipeline, RichSink, RichText, cell_width},
};

/// A preformatted, wrapped quotation with a charset-aware leading gutter.
pub struct Quote {
	props:        Props,
	slot:         Slot,
	text:         Str,
	rich:         RichText,
	version:      u64,
	cached_width: u16,
	cached:       Option<MemoKey>,
}

impl Quote {
	/// Creates an empty normal quotation.
	pub fn new() -> Self {
		Self {
			props:        Props::new(),
			slot:         next_slot(),
			text:         Str::default(),
			rich:         RichText::default(),
			version:      1,
			cached_width: 0,
			cached:       None,
		}
	}

	/// Sets one quote property.
	pub fn with(mut self, prop: Prop, value: impl Into<PropValue>) -> Self {
		self.props.set(prop, value);
		self.version = self.version.wrapping_add(1);
		self
	}

	/// Appends preformatted quote text.
	pub fn text(mut self, text: impl IntoStr) -> Self {
		append(&mut self.text, text.into_str());
		self.version = self.version.wrapping_add(1);
		self
	}

	fn is_error(&self) -> bool {
		self
			.props
			.str_of(Prop::Kind)
			.is_some_and(|kind| kind == "error")
	}

	fn text_style(&self, ctx: &UiContext) -> Style {
		let style = self.props.style(&ctx.theme);
		if self.props.foreground(&ctx.theme).is_none() && self.is_error() {
			return style.fg(ctx.theme.err);
		}
		style
	}

	fn gutter_style(&self, ctx: &UiContext) -> Style {
		let style = self.props.style(&ctx.theme);
		match self.props.foreground(&ctx.theme) {
			Some(_) => style,
			None if self.is_error() => style.fg(ctx.theme.err),
			None => style.fg(ctx.theme.muted),
		}
	}

	fn render(&mut self, ctx: &UiContext, width: u16) {
		let gutter = cell_width(ctx.charset.quote_rail());
		let width = width.saturating_sub(gutter).max(1);
		let key = MemoKey::new(self.version, ctx);
		if self.cached_width == width && self.cached == Some(key) {
			return;
		}

		let style = self.text_style(ctx);
		self.rich.clear();
		for line in self.text.as_str().split('\n') {
			let mut wrap = (&mut self.rich).wrap_chars(width);
			if !line.is_empty() {
				wrap.run(style, line);
			}
			wrap.newline();
		}
		self.cached_width = width;
		self.cached = Some(key);
	}
}

impl Default for Quote {
	fn default() -> Self {
		Self::new()
	}
}

impl Component for Quote {
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
		let gutter = cell_width(ctx.charset.quote_rail());
		let body = self
			.text
			.as_str()
			.split('\n')
			.map(cell_width)
			.max()
			.unwrap_or(0);
		(gutter.saturating_add(1), gutter.saturating_add(body).max(gutter.saturating_add(1)))
	}

	fn height(&mut self, ctx: &UiContext, width: u16) -> u16 {
		self.render(ctx, width);
		RichText::rows(&self.rich)
	}

	fn place(&mut self, ctx: &UiContext, content: Rect) {
		self.render(ctx, content.width);
	}

	fn paint(&mut self, pc: &mut PaintCtx<'_>, rect: Rect) {
		self.render(pc.ctx, rect.width);
		let right = rect.x.saturating_add(rect.width);
		let clip = pc.clip.min(rect.y.saturating_add(rect.height));
		let gutter = pc.ctx.charset.quote_rail();
		let gutter_style = self.gutter_style(pc.ctx);
		for row in 0..RichText::rows(&self.rich) {
			let y = rect.y.saturating_add(row);
			if y >= clip {
				break;
			}
			let mut x = put_clipped(pc.frame, rect.x, y, right, gutter, gutter_style);
			for (style, text) in self.rich.row_runs(row) {
				x = put_clipped(pc.frame, x, y, right, text, style);
				if x >= right {
					break;
				}
			}
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

#[cfg(test)]
mod tests {
	use super::Quote;
	use crate::{
		Charset, Color, Ui, UiContext,
		component::{Component, PaintCtx},
		frame::{Frame, Rect, Size},
		props::Prop,
		test_support::frame_row_text,
	};

	fn paint(component: &mut dyn Component, ctx: &UiContext, width: u16, height: u16) -> Frame {
		let mut frame = Frame::new(Size::new(width, height));
		let mut hits = Vec::new();
		let mut wakes = Vec::new();
		component.paint(
			&mut PaintCtx::new(&mut frame, ctx, &mut hits, &mut wakes),
			Rect::new(0, 0, width, height),
		);
		frame
	}

	#[test]
	fn wraps_preformatted_lines_and_preserves_blank_and_trailing_rows() {
		let ctx = UiContext::default();
		let mut quote = Quote::new().text("abcd\n\nxy\n");
		assert_eq!(quote.height(&ctx, 5), 5);
		let frame = paint(&mut quote, &ctx, 5, 5);
		assert_eq!(
			(0..5)
				.map(|row| frame_row_text(&frame, row))
				.collect::<Vec<_>>(),
			["│ abc", "│ d", "│", "│ xy", "│"]
		);
	}

	#[test]
	fn empty_and_narrow_quotes_keep_the_gutter_deterministically() {
		for charset in [Charset::Unicode, Charset::NerdFont, Charset::Ascii] {
			let ctx = UiContext { charset, ..UiContext::default() };
			let expected = if charset == Charset::Ascii {
				"|"
			} else {
				"│"
			};
			for width in [1, 2] {
				let mut quote = Quote::new();
				assert_eq!(quote.height(&ctx, width), 1);
				assert_eq!(frame_row_text(&paint(&mut quote, &ctx, width, 1), 0), expected);
			}
		}
	}

	#[test]
	fn kinds_and_explicit_colors_use_semantic_tones_in_every_charset() {
		for charset in [Charset::Unicode, Charset::NerdFont, Charset::Ascii] {
			let ctx = UiContext { charset, ..UiContext::default() };
			let mut normal = Quote::new().text("ok");
			let frame = paint(&mut normal, &ctx, 8, 1);
			assert_eq!(frame.cell(0, 0).style.foreground_color(), ctx.theme.muted);

			let mut error = Quote::new().with(Prop::Kind, "error").text("bad");
			let frame = paint(&mut error, &ctx, 8, 1);
			assert_eq!(frame.cell(0, 0).style.foreground_color(), ctx.theme.err);
			assert_eq!(frame.cell(2, 0).style.foreground_color(), ctx.theme.err);

			let custom = Color::Rgb(1, 2, 3);
			let mut override_quote = Quote::new()
				.with(Prop::Kind, "error")
				.with(Prop::Fg, custom)
				.text("bad");
			let frame = paint(&mut override_quote, &ctx, 8, 1);
			assert_eq!(frame.cell(0, 0).style.foreground_color(), custom);
			assert_eq!(frame.cell(2, 0).style.foreground_color(), custom);
		}
	}

	#[test]
	fn raw_markup_decodes_entities_without_interpreting_escaped_tags() {
		let ui =
			Ui::from_markup("<quote>&lt;b&gt; &amp; &#x1f642;</quote>", 24, UiContext::default())
				.unwrap();
		assert_eq!(frame_row_text(ui.frame(), 0), "│ <b> & 🙂");
	}

	#[test]
	fn unchanged_layout_reuses_the_cached_parse_and_wrap_storage() {
		let ctx = UiContext::default();
		let mut quote = Quote::new().text("alpha beta gamma\nsecond");
		quote.render(&ctx, 9);
		let capacities = quote.rich.capacities();
		let cached = quote.cached;
		quote.render(&ctx, 9);
		assert_eq!(quote.rich.capacities(), capacities);
		assert!(quote.cached == cached);
	}
}
