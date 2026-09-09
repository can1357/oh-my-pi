use omp_core::{IntoStr, Str};

use super::text::{RevealState, alignment_slack, append, paint_rich, truncate_rich};
use crate::{
	UiContext, anim,
	component::{Cached, Component, IntoChildren, MemoKey, PaintCtx, Slot, next_slot},
	frame::{Decor, DecorKind, Rect},
	markdown,
	markdown::MdTheme,
	markup,
	props::{Prop, PropValue, Props},
	rich::{Measure, RichText, cell_width},
};

/// Rendered Markdown content backing the `<markdown>` markup tag.
pub struct Markdown {
	props:          Props,
	slot:           Slot,
	text:           Str,
	source:         Str,
	rich:           RichText,
	embedded:       Vec<Cached>,
	version:        u64,
	/// Like `version`, but held steady across a `set_text` that merely
	/// extends the source: under `reveal` the shown prefix does not depend
	/// on appended text, so it keys the memo instead.
	shape:          u64,
	cached_width:   u16,
	cached_partial: bool,
	cached:         Option<MemoKey>,
	/// Byte end of the rendered slice of `text` — the whole text without
	/// `reveal`, the shown prefix under it. Part of the memo key so a
	/// moving reveal cursor re-renders the rows.
	cached_end:     usize,
	/// Reveal cursor and grapheme memos; allocated on first paced render.
	reveal:         Option<Box<RevealState>>,
	fast_tail:      Option<markdown::FastTail>,
	measured:       Option<(MemoKey, (u16, u16), u16)>,
}

impl Markdown {
	/// Creates an empty Markdown block.
	pub fn new() -> Self {
		Self {
			props:          Props::new(),
			slot:           next_slot(),
			text:           Str::default(),
			source:         Str::default(),
			rich:           RichText::default(),
			embedded:       Vec::new(),
			version:        1,
			shape:          1,
			cached_width:   0,
			cached_partial: false,
			cached:         None,
			cached_end:     0,
			reveal:         None,
			fast_tail:      None,
			measured:       None,
		}
	}

	/// Creates a Markdown block containing the supplied source.
	pub fn text_of(text: impl IntoStr) -> Self {
		Self::new().text(text)
	}

	/// Sets one Markdown property.
	pub fn with(mut self, prop: Prop, value: impl Into<PropValue>) -> Self {
		self.props.set(prop, value);
		self.bump();
		self
	}

	/// Sets one Markdown property from a string.
	pub fn with_str(self, prop: Prop, value: &str) -> Self {
		self.with(prop, value)
	}

	/// Appends Markdown source text.
	pub fn text(mut self, text: impl IntoStr) -> Self {
		let text = text.into_str();
		append(&mut self.source, text.clone());
		append(&mut self.text, text);
		self.bump();
		self
	}

	/// Whether the block shows all of its source: no `reveal`, or a cursor
	/// that has caught up with the current text.
	pub fn reveal_settled(&self) -> bool {
		self.props.reveal().is_none()
			|| self
				.reveal
				.as_deref()
				.is_some_and(|reveal| reveal.covers(&self.text))
	}

	const fn bump(&mut self) {
		self.version = self.version.wrapping_add(1);
		self.shape = self.shape.wrapping_add(1);
	}

	/// Appends embedded components referenced by the Markdown source.
	pub fn child(mut self, child: impl IntoChildren) -> Self {
		child.extend_children(&mut self.embedded);
		self
	}

	fn theme(&self, ctx: &UiContext) -> MdTheme {
		MdTheme::from_context(ctx).cascade(self.props.style(&ctx.theme))
	}

	fn render(&mut self, ctx: &UiContext, width: u16) {
		let width = width.max(1);
		let (key, end) = if let Some(horizon) = self.props.reveal() {
			let reveal = self.reveal.get_or_insert_default();
			reveal.sync(&self.text);
			(MemoKey::new(self.shape, ctx), reveal.advance(ctx.now, horizon))
		} else {
			// Dropping the prop drops the cursor, so re-enabling
			// reveals from the start again.
			self.reveal = None;
			(MemoKey::new(self.version, ctx), self.text.len())
		};
		// An unsettled prefix is an incomplete stream whatever the
		// document's own mode says.
		let partial = self.props.partial() || end < self.text.len();
		if self.cached_width == width
			&& self.cached_partial == partial
			&& self.cached == Some(key)
			&& self.cached_end == end
		{
			return;
		}
		let theme = self.theme(ctx);
		let style = self.props.style(&ctx.theme);
		let visible = if end == self.text.len() {
			self.text.clone()
		} else {
			self.text.slice(..end)
		};
		if partial
			&& self.props.truncate().is_none()
			&& self
				.fast_tail
				.as_mut()
				.is_some_and(|tail| tail.splice(&visible, width, &theme, &mut self.rich))
		{
			self.cached_width = width;
			self.cached_partial = true;
			self.cached = Some(key);
			self.cached_end = end;
			return;
		}
		self.rich.clear();
		if partial {
			self.fast_tail =
				markdown::render_partial_capturing(&visible, width, &theme, &mut self.rich);
		} else {
			markdown::render(&visible, width, &theme, &mut self.rich);
			self.fast_tail = None;
		}
		truncate_rich(&mut self.rich, width, style, self.props.truncate());
		if self.props.truncate().is_some() {
			self.fast_tail = None;
		}
		self.cached_width = width;
		self.cached_partial = partial;
		self.cached = Some(key);
		self.cached_end = end;
	}
}

impl Default for Markdown {
	fn default() -> Self {
		Self::new()
	}
}

impl Component for Markdown {
	fn props(&self) -> &Props {
		&self.props
	}

	fn props_mut(&mut self) -> &mut Props {
		&mut self.props
	}

	fn slot(&self) -> Slot {
		self.slot
	}

	fn children(&self) -> &[Cached] {
		&self.embedded
	}

	fn children_mut(&mut self) -> &mut [Cached] {
		&mut self.embedded
	}

	fn measure(&mut self, ctx: &UiContext) -> (u16, u16) {
		let key = MemoKey::new(self.version, ctx);
		if self.props.partial()
			&& self.embedded.is_empty()
			&& let Some((cached, measured, _)) = self.measured
			&& cached == key
		{
			return measured;
		}
		let theme = self.theme(ctx);
		let mut natural = Measure::default();
		if self.props.partial() {
			markdown::render_partial(&self.text, u16::MAX, &theme, &mut natural);
		} else {
			markdown::render(&self.text, u16::MAX, &theme, &mut natural);
		}
		let mut min = natural.widest.clamp(1, 12);
		let mut nat = natural.widest.max(min);
		for child in &mut self.embedded {
			if child.visible {
				let (child_min, child_nat) = child.measure(ctx);
				min = min.max(child_min);
				nat = nat.max(child_nat);
			}
		}
		let measured = (min, nat);
		self.measured = (self.props.partial() && self.embedded.is_empty()).then_some((
			key,
			measured,
			natural.final_width(),
		));
		measured
	}

	fn height(&mut self, ctx: &UiContext, width: u16) -> u16 {
		self.render(ctx, width);
		let mut height = if self.text.is_empty() {
			0
		} else {
			RichText::rows(&self.rich)
		};
		let mut placed = !self.text.is_empty();
		for child in &mut self.embedded {
			if !child.visible {
				continue;
			}
			if placed {
				height = height.saturating_add(1);
			}
			height = height.saturating_add(child.height(ctx, width));
			placed = true;
		}
		height
	}

	fn place(&mut self, ctx: &UiContext, content: Rect) {
		self.render(ctx, content.width);
		let mut cursor = content.y;
		let mut placed = if self.text.is_empty() {
			false
		} else {
			cursor = cursor.saturating_add(RichText::rows(&self.rich));
			true
		};
		for child in &mut self.embedded {
			if !child.visible {
				continue;
			}
			if placed {
				cursor = cursor.saturating_add(1);
			}
			let height = child.height(ctx, content.width);
			child.place(ctx, Rect::new(content.x, cursor, content.width, height));
			cursor = cursor.saturating_add(height);
			placed = true;
		}
	}

	fn paint(&mut self, pc: &mut PaintCtx<'_>, rect: Rect) {
		if !self.text.is_empty() {
			self.render(pc.ctx, rect.width);
			let own = Rect::new(rect.x, rect.y, rect.width, RichText::rows(&self.rich));
			paint_rich(pc, own, &self.rich, self.props.align());
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
		for child in &mut self.embedded {
			if child.visible {
				child.paint(pc);
			}
		}
	}

	fn set_text(&mut self, ctx: &UiContext, text: Str) -> bool {
		if self.source == text {
			return false;
		}
		let embeds_markup = markup::md_embeds_markup(&text);
		let old_key = MemoKey::new(self.version, ctx);
		let delta_width = text
			.as_str()
			.strip_prefix(self.source.as_str())
			.filter(|delta| !delta.contains('\t'))
			.filter(|delta| {
				delta
					.chars()
					.last()
					.is_none_or(|character| !character.is_whitespace())
			})
			.map(cell_width);
		let theme = self.theme(ctx);
		// A plain extension leaves every revealed prefix intact: the memo
		// shape holds, and the cursor keeps typing from where it was.
		let extends = !embeds_markup
			&& self.embedded.is_empty()
			&& text.as_str().starts_with(self.source.as_str());
		let revealing = self.props.reveal().is_some();
		let fast = !revealing
			&& extends
			&& self.props.partial()
			&& self.props.truncate().is_none()
			&& self.cached == Some(old_key)
			&& self.fast_tail.as_mut().is_some_and(|tail| {
				tail.splice(&text, self.cached_width.max(1), &theme, &mut self.rich)
			});
		self.source = text.clone();
		if embeds_markup {
			if let Ok(children) = markup::parse_md_fragment_inheriting(&text, ctx, &self.props) {
				self.text = Str::default();
				self.embedded = children;
			} else {
				self.text = text;
				self.embedded.clear();
			}
		} else {
			self.text = text;
			self.embedded.clear();
		}
		self.version = self.version.wrapping_add(1);
		if !extends {
			self.shape = self.shape.wrapping_add(1);
		}
		if fast {
			let key = MemoKey::new(self.version, ctx);
			self.cached = Some(key);
			if let (Some(delta_width), Some((measured_key, measured, tail_width))) =
				(delta_width, self.measured)
				&& measured_key == old_key
			{
				let tail_width = tail_width.saturating_add(delta_width);
				let widest = measured.1.max(tail_width);
				let min = widest.clamp(1, 12);
				self.measured = Some((key, (min, widest.max(min)), tail_width));
			} else {
				self.measured = None;
			}
		} else if revealing && extends {
			// The captured tail still describes the shown prefix; the next
			// paced render splices the cursor's advance onto it.
			self.measured = None;
		} else {
			self.fast_tail = None;
			self.measured = None;
		}
		true
	}
}

#[cfg(test)]
mod tests {
	use std::time::Duration;

	use super::*;
	use crate::{context::UiContext, test_support::frame_row_text, ui::Ui};

	fn shown(ui: &Ui) -> String {
		let frame = ui.frame();
		(0..frame.size().height)
			.map(|row| frame_row_text(frame, row))
			.collect::<Vec<_>>()
			.join("\n")
	}

	fn settled(ui: &Ui, id: &str) -> bool {
		ui.with_component(id, Markdown::reveal_settled)
			.expect("markdown block present")
	}

	#[test]
	fn reveal_types_out_streamed_markdown_and_settles() {
		let mut ui = Ui::from_root(
			Markdown::new()
				.with(Prop::Id, "stream")
				.with(Prop::Reveal, "264ms")
				.text("abcdef"),
			40,
			UiContext::default(),
		);
		// The construction paint arms the cursor without revealing anything
		// and schedules the first frame.
		assert_eq!(shown(&ui), "");
		assert!(!settled(&ui, "stream"));
		assert_eq!(ui.next_wake(), Some(anim::FRAME));

		// Each tick earns one 33ms frame at the 90 clusters/s floor.
		assert!(ui.tick(Duration::from_millis(34)));
		assert_eq!(shown(&ui), "ab");
		ui.tick(Duration::from_millis(68));
		assert_eq!(shown(&ui), "abcde");
		ui.tick(Duration::from_millis(102));
		assert_eq!(shown(&ui), "abcdef");
		assert!(settled(&ui, "stream"));
		assert_eq!(ui.next_wake(), None, "a settled reveal stops waking");

		// A large backlog catches up exponentially instead of queueing
		// behind the floor: one frame reveals far more than three clusters.
		let long = "abcdef".to_owned() + &"x".repeat(600);
		assert!(ui.set_text("stream", long.as_str()));
		assert_eq!(shown(&ui), "abcdef", "an append never jumps the cursor");
		assert!(!settled(&ui, "stream"));
		assert!(ui.next_wake().is_some(), "new backlog re-arms the frame cadence");
		ui.tick(Duration::from_millis(136));
		let revealed = shown(&ui).replace('\n', "").len();
		assert!(revealed > 6 + 3, "exponential catch-up revealed {revealed}");
		assert!(revealed < long.len());

		// Rows fill as the cursor crosses the wrap width.
		assert!(ui.height() > 1);

		while !settled(&ui, "stream") {
			let now = ui.next_wake().expect("unsettled reveal keeps waking");
			ui.tick(now);
		}
		assert_eq!(ui.next_wake(), None);
		let plain = Ui::from_root(Markdown::text_of(long.as_str()), 40, UiContext::default());
		assert_eq!(shown(&ui), shown(&plain), "a settled reveal renders the full document");
	}

	#[test]
	fn reveal_survives_set_text_extension() {
		let mut ui = Ui::from_root(
			Markdown::new()
				.with(Prop::Id, "stream")
				.with(Prop::Reveal, true)
				.text("abcdef"),
			40,
			UiContext::default(),
		);
		ui.tick(Duration::from_millis(34));
		assert_eq!(shown(&ui), "ab");
		// Appending mid-reveal keeps the cursor typing from where it was.
		assert!(ui.set_text("stream", "abcdefghijkl"));
		assert_eq!(shown(&ui), "ab");
		ui.tick(Duration::from_millis(68));
		assert_eq!(shown(&ui), "abcde");
		ui.tick(Duration::from_millis(102));
		assert_eq!(shown(&ui), "abcdefgh");
	}

	#[test]
	fn reveal_resets_when_text_is_replaced() {
		let mut ui = Ui::from_root(
			Markdown::new()
				.with(Prop::Id, "stream")
				.with(Prop::Reveal, true)
				.text("abcdef"),
			40,
			UiContext::default(),
		);
		ui.tick(Duration::from_millis(34));
		ui.tick(Duration::from_millis(68));
		assert_eq!(shown(&ui), "abcde");
		// A replacement restarts the typewriter from nothing.
		assert!(ui.set_text("stream", "xyz"));
		assert_eq!(shown(&ui), "");
		ui.tick(Duration::from_millis(102));
		assert_eq!(shown(&ui), "xy");
		ui.tick(Duration::from_millis(136));
		assert_eq!(shown(&ui), "xyz");
		assert!(settled(&ui, "stream"));
		assert_eq!(ui.next_wake(), None);
		// Dropping the prop renders the whole document without a cursor.
		assert!(ui.set_text("stream", "**bold** later"));
		assert_eq!(shown(&ui), "");
		assert!(ui.set_prop("stream", Prop::Reveal, false));
		assert_eq!(shown(&ui), "bold later");
		assert!(settled(&ui, "stream"));
	}

	#[test]
	fn set_text_regrafts_static_markup_in_document_order() {
		let ctx = UiContext::default();
		let mut markdown = Markdown::text_of("old");
		assert!(markdown.set_text(&ctx, Str::new("before\n<box><text>inside</text></box>\nafter"),));
		assert!(markdown.text.is_empty());
		assert_eq!(markdown.embedded.len(), 3);
	}

	#[test]
	fn set_text_degrades_rejected_dynamic_markup_to_literal_text() {
		let ctx = UiContext::default();
		for source in ["<input/>", "<box id=duplicate/>", "<box when=\"x == y\"/>", "</md>"] {
			let mut markdown = Markdown::text_of("old");
			assert!(markdown.set_text(&ctx, Str::new(source)));
			assert_eq!(markdown.text, source);
			assert!(markdown.embedded.is_empty());
		}
	}

	#[test]
	fn retained_partial_text_splices_plain_streaming_delta() {
		let ctx = UiContext::default();
		let mut markdown = Markdown::new()
			.with(Prop::Partial, true)
			.text("A plain paragraph tail");
		let _ = markdown.measure(&ctx);
		markdown.render(&ctx, 12);
		assert!(markdown.set_text(&ctx, Str::new("A plain paragraph tail grows")));
		assert_eq!(
			markdown
				.fast_tail
				.as_ref()
				.expect("plain paragraph remains captured")
				.splice_count(),
			1,
		);
		let theme = markdown.theme(&ctx);
		let mut cold = RichText::default();
		markdown::render_partial(&markdown.text, 12, &theme, &mut cold);
		assert_eq!(markdown.rich.rows(), cold.rows());
		for row in 0..cold.rows() {
			assert_eq!(markdown.rich.row_text(row), cold.row_text(row));
			assert_eq!(
				markdown.rich.row_runs(row).collect::<Vec<_>>(),
				cold.row_runs(row).collect::<Vec<_>>(),
			);
		}
	}
}
