use std::ops::Range;

use omp_core::{IntoStr, Str, sf};
use smallvec::SmallVec;
use xutf::Text;

use super::{
	layout::{grid_measure, place_grid_row, solve_columns},
	table::TableCell,
};
use crate::{
	Icon,
	component::{
		Cached, Component, EventCtx, Flow, Hit, HitTag, IntoChildren, PaintCtx, Slot, next_slot,
	},
	context::{Theme, UiContext},
	frame::{Rect, Style},
	fuzzy::{Query, SearchIndex},
	input::{Key, Mouse, UiEvent, sanitize_paste, word_rubout_start},
	props::{Prop, PropValue, Props},
	rich::cell_width,
};

/// Declarative option data backing the `<option>` markup tag.
pub struct SelectOption {
	props:   Props,
	label:   Str,
	preview: Vec<Cached>,
	cells:   SmallVec<Cached, 8>,
}

impl SelectOption {
	/// Creates an empty option.
	pub fn new() -> Self {
		Self {
			props:   Props::new(),
			label:   Str::default(),
			preview: Vec::new(),
			cells:   SmallVec::new(),
		}
	}

	/// Sets one option property.
	pub fn with(mut self, prop: Prop, value: impl Into<PropValue>) -> Self {
		self.props.set(prop, value);
		self
	}

	/// Sets one option property from a string.
	pub fn with_str(mut self, prop: Prop, value: &str) -> Self {
		self.props.set(prop, value);
		self
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

	/// Appends one grid cell; cell options render as aligned columns
	/// (shared across every option) instead of a flat label.
	pub fn cell(mut self, cell: TableCell) -> Self {
		self.cells.push(Cached::new(Box::new(cell)));
		self
	}

	/// Appends preview content shown below this option.
	pub fn child(mut self, child: impl IntoChildren) -> Self {
		child.extend_children(&mut self.preview);
		self
	}

	/// Splits common option metadata for compact controls that do not own
	/// preview or table-cell subtrees.
	pub(super) fn into_control_parts(self) -> (Props, Str) {
		let label = if self.label.is_empty() {
			self.props.str_of(Prop::Label).cloned().unwrap_or_default()
		} else {
			self.label
		};
		(self.props, label)
	}
}

impl Default for SelectOption {
	fn default() -> Self {
		Self::new()
	}
}

struct OptionData {
	label:       Str,
	/// The label indexed once for every keystroke's filter pass.
	search:      SearchIndex,
	value:       Str,
	desc:        Option<Str>,
	recommended: bool,
	selected:    bool,
	active:      bool,
	preview:     Range<usize>,
	/// Grid cells rendered as this option's row; empty for label options.
	cells:       Range<usize>,
	custom:      bool,
}

impl OptionData {
	fn new(label: Str, value: Str, preview: Range<usize>, cells: Range<usize>) -> Self {
		Self {
			search: SearchIndex::new(&label),
			label,
			value,
			desc: None,
			recommended: false,
			selected: false,
			active: false,
			preview,
			cells,
			custom: false,
		}
	}
}

#[derive(Clone, Copy, Default)]
struct OptionLayout {
	top:    u16,
	height: u16,
}

#[derive(Default)]
struct SelectState {
	options:     Vec<OptionData>,
	layouts:     SmallVec<OptionLayout, 8>,
	multi:       bool,
	filter:      bool,
	cursor:      u16,
	chosen:      smol_bitmap::SmolBitmap,
	custom_text: String,
	editing:     bool,
	filter_q:    String,
	searching:   bool,
	scroll:      u16,
	header_rows: u16,
	/// Option rows that fit the last placed viewport; page-jump stride.
	page:        u16,
	/// Indices of options matching the query in display order, recomputed
	/// by [`Self::refilter`] whenever the query or the option set changes.
	visible:     Vec<u16>,
}

impl SelectState {
	/// Recomputes the visible rows: every option for an empty query,
	/// otherwise word-local ranking (contiguous literal matches ahead
	/// of fuzzy-only ones), the recommended option first within a relevance
	/// bucket, then declaration order.
	fn refilter(&mut self) {
		self.visible.clear();
		let Some(query) = Query::new(&self.filter_q) else {
			self.visible.extend(0..self.options.len() as u16);
			return;
		};
		let mut scored: Vec<(i32, bool, u16)> = self
			.options
			.iter()
			.enumerate()
			.filter_map(|(index, option)| {
				let score = option.search.score(&query)?;
				// Bucket scores by rounded tenths.
				Some(((score + 500).div_euclid(1000), !option.recommended, index as u16))
			})
			.collect();
		scored.sort_unstable();
		self
			.visible
			.extend(scored.into_iter().map(|(_, _, index)| index));
	}

	/// Whether typing edits the query directly: a filterable single select needs
	/// no `/` search mode, while multi
	/// selects keep Space for toggling.
	const fn types_to_filter(&self) -> bool {
		self.filter && !self.multi
	}
}

/// A filterable choice list backing the `<select>` markup tag.
pub struct Select {
	props:    Props,
	slot:     Slot,
	state:    SelectState,
	children: Vec<Cached>,
}

impl Select {
	/// Column gutter reserved for the cursor glyph ahead of cell rows.
	const GUTTER: u16 = 2;

	/// Creates an empty select.
	pub fn new() -> Self {
		Self {
			props:    Props::new(),
			slot:     next_slot(),
			state:    SelectState::default(),
			children: Vec::new(),
		}
	}

	#[allow(dead_code, reason = "acceptance-suite probe")]
	pub(crate) const fn visible_len(&self) -> usize {
		self.state.visible.len()
	}

	/// Option index under the cursor, in declaration order.
	#[allow(dead_code, reason = "acceptance-suite probe")]
	pub(crate) fn cursor_option(&self) -> Option<usize> {
		self
			.state
			.visible
			.get(usize::from(self.state.cursor))
			.map(|&index| usize::from(index))
	}

	/// Position of the first painted visible row.
	#[allow(dead_code, reason = "acceptance-suite probe")]
	pub(crate) fn scroll_offset(&self) -> usize {
		usize::from(self.state.scroll)
	}

	/// Sets one select property.
	pub fn with(mut self, prop: Prop, value: impl Into<PropValue>) -> Self {
		self.props.set(prop, value);
		self.sync_prop(prop);
		self
	}

	/// Sets one select property from a string.
	pub fn with_str(mut self, prop: Prop, value: &str) -> Self {
		self.props.set(prop, value);
		self.sync_prop(prop);
		self
	}

	/// Appends an option and adopts its cell and preview subtrees.
	pub fn option(mut self, option: SelectOption) -> Self {
		let cells_start = self.children.len();
		self.children.extend(option.cells);
		let cells = cells_start..self.children.len();
		let preview_start = self.children.len();
		self.children.extend(option.preview);
		let preview = preview_start..self.children.len();
		let label = if option.label.is_empty() {
			option
				.props
				.str_of(Prop::Label)
				.cloned()
				.unwrap_or_default()
		} else {
			option.label
		};
		let value = option
			.props
			.str_of(Prop::Value)
			.cloned()
			.unwrap_or_else(|| label.clone());
		let data = OptionData {
			desc: option.props.str_of(Prop::Desc).cloned(),
			recommended: option.props.flag(Prop::Recommended),
			selected: option.props.flag(Prop::Selected),
			active: option.props.flag(Prop::Active),
			..OptionData::new(label, value, preview, cells)
		};
		let at = self
			.state
			.options
			.iter()
			.position(|candidate| candidate.custom)
			.unwrap_or(self.state.options.len());
		self.insert_option(at, data);
		self
	}

	fn sync_prop(&mut self, prop: Prop) {
		match prop {
			Prop::Multi => {
				self.state.multi = self.props.flag(Prop::Multi);
				if self.state.multi {
					self.state.chosen = smol_bitmap::SmolBitmap::new();
					for (index, option) in self.state.options.iter().enumerate() {
						if option.selected {
							self.state.chosen.set(index, true);
						}
					}
				} else {
					self.choose_recommended();
				}
			},
			// A bare `filter` flag enables filtering; a string value also
			// seeds the initial query (rebuilding hosts keep continuity).
			Prop::Filter => match self.props.get(Prop::Filter) {
				Some(PropValue::Bool(enabled)) => self.state.filter = enabled,
				Some(PropValue::Str(seed)) => {
					self.state.filter = true;
					self.state.filter_q.clear();
					self.state.filter_q.push_str(seed.as_str());
					self.state.refilter();
				},
				_ => self.state.filter = false,
			},
			Prop::Custom => self.set_custom(self.props.flag(Prop::Custom)),
			_ => {},
		}
	}

	fn insert_option(&mut self, at: usize, option: OptionData) {
		let mut chosen = smol_bitmap::SmolBitmap::new();
		for index in &self.state.chosen {
			chosen.set(if index >= at { index + 1 } else { index }, true);
		}
		let recommended = option.recommended;
		let selected = option.selected;
		self.state.options.insert(at, option);
		self.state.layouts.insert(at, OptionLayout::default());
		self.state.chosen = chosen;
		if self.state.filter_q.is_empty() && at + 1 == self.state.options.len() {
			// The builder's append path: every option is visible in order.
			self.state.visible.push(at as u16);
		} else {
			self.state.refilter();
		}
		if recommended && !self.state.multi && self.state.chosen.iter().next().is_none() {
			self.state.chosen.set(at, true);
		}
		if selected {
			if !self.state.multi {
				self.state.chosen = smol_bitmap::SmolBitmap::new();
			}
			self.state.chosen.set(at, true);
		}
	}

	fn remove_option(&mut self, at: usize) {
		self.state.options.remove(at);
		self.state.layouts.remove(at);
		self.state.refilter();
		let mut chosen = smol_bitmap::SmolBitmap::new();
		for index in &self.state.chosen {
			if index < at {
				chosen.set(index, true);
			} else if index > at {
				chosen.set(index - 1, true);
			}
		}
		self.state.chosen = chosen;
		self.state.cursor = self
			.state
			.cursor
			.min(self.state.options.len().saturating_sub(1) as u16);
	}

	fn set_custom(&mut self, enabled: bool) {
		let current = self.state.options.iter().position(|option| option.custom);
		match (enabled, current) {
			(true, None) => {
				let end = self.children.len();
				self.insert_option(self.state.options.len(), OptionData {
					custom: true,
					..OptionData::new(sf!("Other (type your own)"), Str::default(), end..end, end..end)
				});
			},
			(false, Some(index)) => self.remove_option(index),
			_ => {},
		}
	}

	fn choose_recommended(&mut self) {
		if self.state.chosen.iter().next().is_some() {
			return;
		}
		if let Some(index) = self
			.state
			.options
			.iter()
			.position(|option| option.recommended)
		{
			self.state.chosen.set(index, true);
		}
	}

	fn header_rows(&self) -> u16 {
		u16::from(self.props.str_of(Prop::Label).is_some()) + u16::from(self.state.filter)
	}

	/// Spacing between cell columns: the `gap` prop, defaulting to two.
	fn cell_gap(&self) -> u16 {
		if self.props.contains(Prop::Gap) {
			self.props.gap()
		} else {
			2
		}
	}

	/// Cell ranges of every cell option, in declaration order. Columns are
	/// solved over the full catalog — not the filtered subset — so widths
	/// hold steady while the user types.
	fn cell_spans(&self) -> SmallVec<Range<usize>, 16> {
		self
			.state
			.options
			.iter()
			.filter(|option| !option.cells.is_empty())
			.map(|option| option.cells.clone())
			.collect()
	}

	/// Solves the shared cell columns for `width` content cells.
	fn solve_cells(&mut self, ctx: &UiContext, width: u16) -> SmallVec<u16, 8> {
		let spans = self.cell_spans();
		if spans.is_empty() {
			return SmallVec::new();
		}
		let gap = self.cell_gap();
		solve_columns(ctx, &mut self.children, &spans, width.saturating_sub(Self::GUTTER), gap)
	}

	fn option_height(&mut self, ctx: &UiContext, width: u16, index: usize, columns: &[u16]) -> u16 {
		option_height(
			ctx,
			&mut self.children,
			&self.state.options[index],
			self.state.multi,
			width,
			columns,
		)
	}

	/// Value of the option under the cursor, `None` when nothing matches.
	fn cursor_value(&self) -> Option<Str> {
		let &index = self.state.visible.get(usize::from(self.state.cursor))?;
		let option = &self.state.options[usize::from(index)];
		Some(if option.custom {
			Str::new(self.state.custom_text.as_str())
		} else {
			option.value.clone()
		})
	}

	/// Wraps a cursor move into an event for identified selects.
	fn highlight_flow(&self) -> Flow {
		match (self.props.id(), self.cursor_value()) {
			(Some(id), Some(value)) => Flow::Event(UiEvent::Highlighted { id: id.clone(), value }),
			_ => Flow::Consumed,
		}
	}

	/// Re-filters after a query edit and wraps it into an event for
	/// identified selects. The cursor stays on its row only while every
	/// visible row up to it survives unchanged; otherwise it returns to the
	/// best match.
	fn filter_flow(&mut self) -> Flow {
		let cursor = usize::from(self.state.cursor);
		let previous: SmallVec<u16, 16> = self
			.state
			.visible
			.iter()
			.take(cursor + 1)
			.copied()
			.collect();
		self.state.refilter();
		let stable = previous.len() == cursor + 1
			&& self.state.visible.len() > cursor
			&& self.state.visible[..=cursor] == previous[..];
		self.state.cursor = if stable { cursor as u16 } else { 0 };
		match self.props.id() {
			Some(id) => Flow::Event(UiEvent::Filtered {
				id:    id.clone(),
				query: Str::new(self.state.filter_q.as_str()),
				value: self.cursor_value(),
			}),
			None => Flow::Consumed,
		}
	}

	/// Moves the cursor by `delta`: wrapping single steps for filterable
	/// browsers, clamping jumps and form selects. `false` leaves the
	/// cursor untouched (the edge of a clamping select).
	fn move_cursor(&mut self, delta: i64, wrap: bool) -> bool {
		let count = self.state.visible.len() as i64;
		if count == 0 {
			return false;
		}
		let at = i64::from(self.state.cursor);
		let next = if wrap {
			(at + delta).rem_euclid(count)
		} else {
			(at + delta).clamp(0, count - 1)
		};
		if next == at {
			return false;
		}
		self.state.cursor = next as u16;
		true
	}

	/// Jumps to an explicitly numbered option while the filter query is empty.
	///
	/// Numbered rows may follow unnumbered context rows, so the digit matches
	/// the visible label prefix rather than its list position. Multi-selects
	/// only move the cursor; single-selects commit immediately.
	fn quick_select(&mut self, key: Key) -> Option<Flow> {
		if !self.state.filter_q.is_empty() {
			return None;
		}
		let Key::Char(digit @ '1'..='9') = key else {
			return None;
		};
		let mut encoded = [0_u8; 4];
		let digit = digit.encode_utf8(&mut encoded).as_bytes()[0];
		let target = self.state.options.iter().position(|option| {
			let label = option.label.as_bytes();
			label.len() >= 3 && label[0] == digit && label[1] == b'.' && label[2] == b' '
		})?;
		let target = u16::try_from(target).ok()?;
		self.state.cursor = target;
		if self.state.multi {
			Some(self.highlight_flow())
		} else {
			Some(self.commit(target))
		}
	}

	/// Routes one key: custom-option editing, then query editing (always-on
	/// for filterable single selects, `/`-armed otherwise), then list
	/// navigation. Identified selects surface cursor, query, and commit
	/// changes as [`UiEvent`]s.
	fn dispatch(&mut self, key: Key) -> Flow {
		let has_rows = !self.state.visible.is_empty();
		if self.state.editing {
			match key {
				// Enter commits the typed value: the custom row's `Changed`
				// waited for it (see `commit`).
				Key::Enter => {
					self.state.editing = false;
					if let Some(id) = self.props.id() {
						return Flow::Event(UiEvent::Changed {
							id:    id.clone(),
							value: Str::new(self.state.custom_text.as_str()),
						});
					}
				},
				Key::Esc => {
					self.state.editing = false;
					self.state.custom_text.clear();
				},
				Key::Backspace => {
					self.state.custom_text.pop();
				},
				Key::Space => self.state.custom_text.push(' '),
				Key::Char(character) => self.state.custom_text.push(character),
				Key::Ctrl('u') => self.state.custom_text.clear(),
				Key::Ctrl('w') => {
					let end = self.state.custom_text.len();
					self
						.state
						.custom_text
						.truncate(word_rubout_start(&self.state.custom_text, end));
				},
				_ => {},
			}
			return Flow::Consumed;
		}
		if let Some(flow) = self.quick_select(key) {
			return flow;
		}
		let typing = self.state.types_to_filter() || self.state.searching;
		if typing && !matches!(key, Key::Up | Key::Down) {
			match key {
				Key::Char(character) => {
					self.state.filter_q.push(character);
					return self.filter_flow();
				},
				Key::Space if self.state.types_to_filter() => {
					self.state.filter_q.push(' ');
					return self.filter_flow();
				},
				Key::Backspace => {
					if self.state.filter_q.pop().is_none() {
						self.state.searching = false;
						return Flow::Consumed;
					}
					return self.filter_flow();
				},
				Key::Ctrl('u') if !self.state.filter_q.is_empty() => {
					self.state.filter_q.clear();
					return self.filter_flow();
				},
				Key::Ctrl('w') if !self.state.filter_q.is_empty() => {
					let end = self.state.filter_q.len();
					self
						.state
						.filter_q
						.truncate(word_rubout_start(&self.state.filter_q, end));
					return self.filter_flow();
				},
				// The cancel ladder: a first Esc clears the query, a second
				// bubbles out of the component (dismissing an overlay host).
				Key::Esc if !self.state.filter_q.is_empty() => {
					self.state.filter_q.clear();
					self.state.searching = false;
					return self.filter_flow();
				},
				Key::Esc | Key::Enter if self.state.searching => {
					self.state.searching = false;
					return Flow::Consumed;
				},
				_ => {},
			}
		}
		match key {
			Key::Up if has_rows => {
				if self.move_cursor(-1, self.state.filter) {
					self.highlight_flow()
				} else {
					Flow::Skip
				}
			},
			Key::Down if has_rows => {
				if self.move_cursor(1, self.state.filter) {
					self.highlight_flow()
				} else {
					Flow::Skip
				}
			},
			Key::PageUp | Key::PageDown if has_rows => {
				let stride = i64::from(self.state.page.max(1));
				let delta = if key == Key::PageUp { -stride } else { stride };
				if self.move_cursor(delta, false) {
					self.highlight_flow()
				} else {
					Flow::Consumed
				}
			},
			Key::Home | Key::End if has_rows => {
				let delta = i64::from(u16::MAX);
				let delta = if key == Key::Home { -delta } else { delta };
				if self.move_cursor(delta, false) {
					self.highlight_flow()
				} else {
					Flow::Consumed
				}
			},
			// Space owns multi-select toggling. Enter confirms the current
			// aggregate (including an empty one), so a dialog host can submit
			// one question or advance to the next without mutating it.
			Key::Enter if self.state.multi => Flow::Event(UiEvent::Submit),
			Key::Enter if has_rows => {
				let position = usize::from(self.state.cursor).min(self.state.visible.len() - 1);
				self.commit(self.state.visible[position])
			},
			Key::Space if has_rows && !self.state.types_to_filter() => {
				let position = usize::from(self.state.cursor).min(self.state.visible.len() - 1);
				self.commit(self.state.visible[position])
			},
			Key::Char('/') if self.state.filter && !self.state.types_to_filter() => {
				self.state.searching = true;
				Flow::Consumed
			},
			Key::Esc if !self.state.filter_q.is_empty() => {
				self.state.filter_q.clear();
				self.filter_flow()
			},
			_ => Flow::Skip,
		}
	}

	fn activate(&mut self, index: u16) {
		let index = usize::from(index);
		if self.state.multi {
			let current = self.state.chosen.get(index);
			self.state.chosen.set(index, !current);
		} else {
			self.state.chosen = smol_bitmap::SmolBitmap::new();
			self.state.chosen.set(index, true);
		}
		if self.state.options[index].custom && self.state.chosen.get(index) {
			self.state.editing = true;
		}
	}

	/// Activates `index` and surfaces the commit for identified selects.
	fn commit(&mut self, index: u16) -> Flow {
		self.activate(index);
		if self.state.editing {
			// The custom option opened its inline editor; the commit event
			// waits for the typed value.
			return Flow::Consumed;
		}
		match self.props.id() {
			Some(id) => {
				let option = &self.state.options[usize::from(index)];
				let value = if option.custom {
					Str::new(self.state.custom_text.as_str())
				} else {
					option.value.clone()
				};
				Flow::Event(UiEvent::Changed { id: id.clone(), value })
			},
			None => Flow::Consumed,
		}
	}

	/// Paints the description lines and preview subtree under one option.
	fn paint_option_tail(
		&mut self,
		pc: &mut PaintCtx<'_>,
		rect: Rect,
		index: usize,
		layout: OptionLayout,
	) {
		let option = &self.state.options[index];
		if let Some(desc) = &option.desc {
			let preview_h: u16 = self.children[option.preview.clone()]
				.iter()
				.filter(|child| child.visible)
				.map(|child| child.rect.height)
				.sum();
			let base = layout
				.height
				.saturating_sub(preview_h)
				.saturating_sub(desc_lines(desc, rect.width.saturating_sub(6)).len() as u16)
				.max(1);
			for (line_index, line) in desc_lines(desc, rect.width.saturating_sub(6))
				.iter()
				.enumerate()
			{
				let line_y = layout.top.saturating_add(base + line_index as u16);
				if line_y < pc.clip {
					pc.frame
						.put(rect.x.saturating_add(6), line_y, line, dim(&pc.ctx.theme));
				}
			}
		}
		let preview = self.state.options[index].preview.clone();
		for child in &mut self.children[preview] {
			if !child.visible {
				continue;
			}
			let stem_x = rect.x.saturating_add(6);
			for line_y in child.rect.y..child.rect.y.saturating_add(child.rect.height) {
				if line_y < pc.clip {
					pc.frame.put(
						stem_x,
						line_y,
						pc.ctx.charset.icon(Icon::PreviewRail),
						dim(&pc.ctx.theme),
					);
				}
			}
			child.paint(pc);
		}
	}
}

impl Default for Select {
	fn default() -> Self {
		Self::new()
	}
}

impl Component for Select {
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
		&self.children
	}

	fn children_mut(&mut self) -> &mut [Cached] {
		&mut self.children
	}

	fn measure(&mut self, ctx: &UiContext) -> (u16, u16) {
		let mut natural = self
			.props
			.str_of(Prop::Label)
			.map_or(0, |label| cell_width(label));
		for option in &self.state.options {
			if option.cells.is_empty() {
				natural = natural.max(cell_width(&option.label).saturating_add(18));
			}
			if let Some(desc) = &option.desc {
				natural = natural.max(cell_width(desc).min(52).saturating_add(6));
			}
		}
		let spans = self.cell_spans();
		let gap = self.cell_gap();
		if !spans.is_empty() {
			let (_, grid) = grid_measure(ctx, &mut self.children, &spans, gap);
			natural = natural.max(grid.saturating_add(Self::GUTTER));
		}
		let preview: SmallVec<Range<usize>, 16> = self
			.state
			.options
			.iter()
			.map(|option| option.preview.clone())
			.collect();
		for range in preview {
			for child in &mut self.children[range] {
				if child.visible {
					natural = natural.max(child.measure(ctx).1.saturating_add(8));
				}
			}
		}
		(24, natural.max(30))
	}

	fn height(&mut self, ctx: &UiContext, width: u16) -> u16 {
		let header = self.header_rows();
		self.state.header_rows = header;
		let columns = self.solve_cells(ctx, width);
		self.state.cursor = self
			.state
			.cursor
			.min(self.state.visible.len().saturating_sub(1) as u16);
		let mut used = 0u16;
		for position in 0..self.state.visible.len() {
			let index = usize::from(self.state.visible[position]);
			used = used.saturating_add(self.option_height(ctx, width, index, &columns));
		}
		header.saturating_add(used)
	}

	fn place(&mut self, ctx: &UiContext, content: Rect) {
		self.state.layouts.fill(OptionLayout::default());
		let header = self.header_rows();
		self.state.header_rows = header;
		let columns = self.solve_cells(ctx, content.width);
		let gap = self.cell_gap();
		let count = self.state.visible.len();
		self.state.cursor = self.state.cursor.min(count.saturating_sub(1) as u16);
		let cursor_at = usize::from(self.state.cursor);
		let cap = content.height.saturating_sub(header).max(1);
		let mut scroll = usize::from(self.state.scroll).min(count.saturating_sub(1));
		if cursor_at < scroll {
			scroll = cursor_at;
		}
		// Pull the window forward until the cursor row fits, however far it
		// jumped (a preselected model deep in the catalog, Page Down, End):
		// the window moves in one pass, never one row per frame.
		let mut span = 0u16;
		for position in (scroll..=cursor_at).rev().take(count) {
			let index = usize::from(self.state.visible[position]);
			span = span.saturating_add(self.option_height(ctx, content.width, index, &columns));
			if span > cap {
				scroll = (position + 1).min(cursor_at);
				break;
			}
		}
		self.state.scroll = scroll as u16;
		let mut y = content.y.saturating_add(header);
		let mut used = 0u16;
		let mut shown = 0u16;
		for position in scroll..count {
			if used >= cap {
				break;
			}
			let index = usize::from(self.state.visible[position]);
			let desc_rows = self.state.options[index]
				.desc
				.as_ref()
				.map_or(0, |desc| desc_lines(desc, content.width.saturating_sub(6)).len() as u16);
			let cells = self.state.options[index].cells.clone();
			let row = if cells.is_empty() {
				label_lines(
					&self.state.options[index].label,
					option_label_width(ctx, self.state.multi, content.width),
				)
				.len() as u16
			} else {
				place_grid_row(
					ctx,
					&mut self.children,
					cells,
					&columns,
					content.x.saturating_add(Self::GUTTER),
					y,
					gap,
				)
			};
			let preview = self.state.options[index].preview.clone();
			let mut block = row.saturating_add(desc_rows);
			for child in &mut self.children[preview] {
				if !child.visible {
					continue;
				}
				let height = child.height(ctx, content.width.saturating_sub(8));
				child.place(
					ctx,
					Rect::new(
						content.x.saturating_add(8),
						y.saturating_add(block),
						content.width.saturating_sub(8),
						height,
					),
				);
				block = block.saturating_add(height);
			}
			self.state.layouts[index] = OptionLayout { top: y, height: block };
			y = y.saturating_add(block);
			used = used.saturating_add(block);
			shown = shown.saturating_add(1);
		}
		self.state.page = shown.max(1);
	}

	fn paint(&mut self, pc: &mut PaintCtx<'_>, rect: Rect) {
		let focused = pc.focus == Some(self.slot);
		let hover_row = match pc.hover {
			Some((slot, HitTag::Row(index))) if slot == self.slot => Some(index),
			_ => None,
		};
		let mut y = rect.y;
		if let Some(label) = self.props.str_of(Prop::Label) {
			if y < pc.clip {
				pc.frame.put(rect.x, y, label, base(&pc.ctx.theme).bold());
			}
			y = y.saturating_add(1);
		}
		if self.state.filter {
			let always_on = self.state.types_to_filter();
			if y < pc.clip && always_on {
				// Query line: search glyph, live query, and the real terminal cursor at
				// the insertion point.
				let mut x = pc.frame.put(
					rect.x,
					y,
					pc.ctx.charset.icon(Icon::Search),
					Style::new().fg(pc.ctx.theme.accent),
				);
				x = pc.frame.put(x, y, " ", base(&pc.ctx.theme));
				x = pc
					.frame
					.put(x, y, &self.state.filter_q, base(&pc.ctx.theme));
				if focused {
					pc.frame.set_cursor(x, y);
				}
				let count = format!("{}/{}", self.state.visible.len(), self.state.options.len());
				let count_x = rect
					.x
					.saturating_add(rect.width.saturating_sub(cell_width(&count)));
				if count_x > x {
					pc.frame.put(count_x, y, &count, dim(&pc.ctx.theme));
				}
			} else if y < pc.clip && (self.state.searching || !self.state.filter_q.is_empty()) {
				let mut x = pc
					.frame
					.put(rect.x, y, "/ ", Style::new().fg(pc.ctx.theme.accent).bold());
				x = pc
					.frame
					.put(x, y, &self.state.filter_q, base(&pc.ctx.theme));
				if self.state.searching {
					if focused {
						pc.frame.set_cursor(x, y);
					}
					x = pc
						.frame
						.put(x, y, pc.ctx.charset.beam(), Style::new().fg(pc.ctx.theme.accent));
				}
				let count = format!("{}/{}", self.state.visible.len(), self.state.options.len());
				let count_x = rect
					.x
					.saturating_add(rect.width.saturating_sub(cell_width(&count)));
				if count_x > x {
					pc.frame.put(count_x, y, &count, dim(&pc.ctx.theme));
				}
			} else if y < pc.clip && focused {
				pc.frame.put(rect.x, y, "/ to search", dim(&pc.ctx.theme));
			}
		}

		for position in 0..self.state.visible.len() {
			let raw_index = self.state.visible[position];
			let index = usize::from(raw_index);
			let layout = self.state.layouts[index];
			if layout.height == 0 {
				continue;
			}
			pc.hits.push(Hit {
				rect: Rect::new(rect.x, layout.top, rect.width, layout.height),
				slot: self.slot,
				tag:  HitTag::Row(raw_index),
			});
			if layout.top >= pc.clip {
				continue;
			}
			let option = &self.state.options[index];
			let here = position as u16 == self.state.cursor;
			let hovered = hover_row == Some(raw_index);
			if !option.cells.is_empty() {
				let cells = option.cells.clone();
				let glyph = if here && focused {
					pc.ctx.charset.cursor()
				} else {
					"  "
				};
				pc.frame
					.put(rect.x, layout.top, glyph, Style::new().fg(pc.ctx.theme.accent));
				for child in &mut self.children[cells] {
					if child.visible {
						child.paint(pc);
					}
				}
				if hovered {
					// Behind-the-glyphs tint: cells that named no
					// background keep it, so arbitrary row content
					// survives the hover highlight.
					pc.frame
						.underlay(Rect::new(rect.x, layout.top, rect.width, 1), pc.ctx.theme.hover);
				}
				self.paint_option_tail(pc, rect, index, layout);
				continue;
			}
			let label_width = option_label_width(pc.ctx, self.state.multi, rect.width);
			let label_lines = label_lines(&option.label, label_width);
			let label_rows = label_lines.len() as u16;
			let row_bg = hovered.then_some(pc.ctx.theme.hover);
			if let Some(background) = row_bg {
				pc.frame.fill(
					Rect::new(rect.x, layout.top, rect.width, label_rows),
					Style::new().bg(background),
				);
			}
			let tint = |style: Style| row_bg.map_or(style, |background| style.bg(background));
			let mut x = pc.frame.put(
				rect.x,
				layout.top,
				if here && focused {
					pc.ctx.charset.cursor()
				} else {
					"  "
				},
				tint(Style::new().fg(pc.ctx.theme.accent)),
			);
			let checked = self.state.chosen.get(index);
			let mark = if self.state.multi {
				pc.ctx.charset.checkbox(checked)
			} else {
				pc.ctx.charset.radio(checked)
			};
			x = pc.frame.put(
				x,
				layout.top,
				mark,
				tint(Style::new().fg(if checked {
					pc.ctx.theme.ok
				} else {
					pc.ctx.theme.muted
				})),
			);
			x = pc.frame.put(x, layout.top, " ", tint(base(&pc.ctx.theme)));
			let label_style = if here {
				tint(Style::new().fg(pc.ctx.theme.accent).bold())
			} else {
				tint(base(&pc.ctx.theme))
			};
			let indent = option_label_indent(pc.ctx, self.state.multi);
			for (line_index, line) in label_lines.iter().enumerate() {
				let y = layout.top.saturating_add(line_index as u16);
				let line_x = if line_index == 0 {
					x
				} else {
					rect.x.saturating_add(indent)
				};
				let end = pc.frame.put(line_x, y, line, label_style);
				if line_index == 0 {
					x = end;
				}
			}
			if option.recommended {
				x = pc
					.frame
					.put(x, layout.top, " (Recommended)", tint(dim(&pc.ctx.theme)));
			}
			if option.custom && (self.state.editing || !self.state.custom_text.is_empty()) {
				x = pc.frame.put(x, layout.top, ": ", tint(dim(&pc.ctx.theme)));
				x = pc.frame.put(
					x,
					layout.top,
					&self.state.custom_text,
					tint(Style::new().fg(pc.ctx.theme.info)),
				);
				if self.state.editing {
					pc.frame.put(
						x,
						layout.top,
						pc.ctx.charset.beam(),
						tint(Style::new().fg(pc.ctx.theme.accent)),
					);
				}
			}
			self.paint_option_tail(pc, rect, index, layout);
		}
	}

	fn focusable(&self) -> bool {
		true
	}

	/// Positions the cursor when focus enters: a single select rests on
	/// its chosen option (the active model), otherwise the
	/// entry edge.
	fn enter(&mut self, forward: bool) {
		let visible = &self.state.visible;
		if visible.is_empty() {
			return;
		}
		if let Some(active) = self.state.options.iter().position(|option| option.active)
			&& let Some(position) = visible
				.iter()
				.position(|&index| usize::from(index) == active)
		{
			self.state.cursor = position as u16;
			return;
		}
		if !self.state.multi
			&& let Some(chosen) = self.state.chosen.iter().next()
			&& let Some(position) = visible
				.iter()
				.position(|&index| usize::from(index) == chosen)
		{
			self.state.cursor = position as u16;
			return;
		}
		self.state.cursor = if forward { 0 } else { visible.len() as u16 - 1 };
	}

	fn key(&mut self, _ec: &mut EventCtx<'_>, key: Key) -> Flow {
		self.dispatch(key)
	}

	fn mouse(
		&mut self,
		_ec: &mut EventCtx<'_>,
		tag: HitTag,
		_at: (u16, u16),
		_rect: Rect,
		mouse: Mouse,
	) -> Flow {
		match (mouse, tag) {
			(Mouse::Click, HitTag::Row(index)) if usize::from(index) < self.state.options.len() => {
				if let Some(position) = self
					.state
					.visible
					.iter()
					.position(|&candidate| candidate == index)
				{
					self.state.cursor = position as u16;
				}
				self.commit(index)
			},
			(Mouse::WheelUp | Mouse::WheelDown, _) => {
				let delta = if mouse == Mouse::WheelUp { -1 } else { 1 };
				if self.move_cursor(delta, false) {
					self.highlight_flow()
				} else if self.state.visible.is_empty() {
					Flow::Skip
				} else {
					Flow::Consumed
				}
			},
			(
				Mouse::Click
				| Mouse::RightClick
				| Mouse::MiddleClick
				| Mouse::Move
				| Mouse::Drag
				| Mouse::Release
				| Mouse::WheelLeft
				| Mouse::WheelRight,
				_,
			) => Flow::Skip,
		}
	}

	fn paste(&mut self, _ec: &mut EventCtx<'_>, text: &str) -> Flow {
		let sanitized = sanitize_paste(text);
		if sanitized.is_empty() {
			return Flow::Skip;
		}
		let single_line = sanitized.replace(['\n', '\t'], " ");
		if self.state.editing {
			self.state.custom_text.push_str(&single_line);
			Flow::Consumed
		} else if self.state.types_to_filter() || self.state.searching {
			self.state.filter_q.push_str(&single_line);
			self.filter_flow()
		} else {
			Flow::Skip
		}
	}

	fn value(&self, out: &mut serde_json::Map<String, serde_json::Value>) {
		let Some(id) = self.props.id() else {
			return;
		};
		let value = if self.state.multi {
			serde_json::Value::Array(
				self
					.state
					.chosen
					.iter()
					.map(|index| option_value(&self.state, index))
					.collect(),
			)
		} else {
			self
				.state
				.chosen
				.iter()
				.next()
				.map_or(serde_json::Value::Null, |index| option_value(&self.state, index))
		};
		out.insert(id.to_string(), value);
	}
}

fn option_value(state: &SelectState, index: usize) -> serde_json::Value {
	let option = &state.options[index];
	if option.custom {
		serde_json::Value::String(state.custom_text.clone())
	} else {
		serde_json::Value::String(option.value.to_string())
	}
}

/// Rows one option occupies at `width`: its label or cell row, description
/// lines, and visible preview children.
fn option_height(
	ctx: &UiContext,
	children: &mut [Cached],
	option: &OptionData,
	multi: bool,
	width: u16,
	columns: &[u16],
) -> u16 {
	let desc_rows = option
		.desc
		.as_ref()
		.map_or(0, |desc| desc_lines(desc, width.saturating_sub(6)).len() as u16);
	let row = if option.cells.is_empty() {
		label_lines(&option.label, option_label_width(ctx, multi, width)).len() as u16
	} else {
		option
			.cells
			.clone()
			.enumerate()
			.map(|(column, cell)| {
				let cell_width = columns.get(column).copied().unwrap_or(1).max(1);
				children[cell].height(ctx, cell_width)
			})
			.max()
			.unwrap_or(1)
			.max(1)
	};
	let preview_h = children[option.preview.clone()]
		.iter_mut()
		.filter(|child| child.visible)
		.fold(0u16, |height, child| {
			height.saturating_add(child.height(ctx, width.saturating_sub(8)))
		});
	row.saturating_add(desc_rows).saturating_add(preview_h)
}

fn option_label_indent(ctx: &UiContext, multi: bool) -> u16 {
	let mark = if multi {
		ctx.charset.checkbox(false)
	} else {
		ctx.charset.radio(false)
	};
	cell_width(ctx.charset.cursor())
		.saturating_add(cell_width(mark))
		.saturating_add(1)
}

fn option_label_width(ctx: &UiContext, multi: bool, width: u16) -> u16 {
	width.saturating_sub(option_label_indent(ctx, multi)).max(1)
}

fn label_lines(label: &Str, width: u16) -> SmallVec<Str, 16> {
	let width = width.max(1);
	let text = label.as_str();
	let mut lines = SmallVec::new();
	let mut current: Option<(usize, usize, u16)> = None;
	for (offset, word) in text
		.split_whitespace()
		.map(|word| (word.as_ptr() as usize - text.as_ptr() as usize, word))
	{
		let end = offset + word.len();
		if let Some((start, previous_end, line_width)) = current {
			let gap = &text[previous_end..offset];
			let gap_width = cell_width(gap);
			if !gap.contains('\n')
				&& line_width
					.saturating_add(gap_width)
					.saturating_add(cell_width(word))
					<= width
			{
				current = Some((
					start,
					end,
					line_width
						.saturating_add(gap_width)
						.saturating_add(cell_width(word)),
				));
				continue;
			}
			lines.push(label.slice(start..previous_end));
		}

		let word_width = cell_width(word);
		if word_width <= width {
			current = Some((offset, end, word_width));
			continue;
		}

		let mut chunk_start = offset;
		let mut chunk_width = 0u16;
		for (relative, grapheme) in word.grapheme_indices() {
			let grapheme_width = cell_width(grapheme);
			if chunk_width > 0 && chunk_width.saturating_add(grapheme_width) > width {
				let chunk_end = offset + relative;
				lines.push(label.slice(chunk_start..chunk_end));
				chunk_start = chunk_end;
				chunk_width = 0;
			}
			chunk_width = chunk_width.saturating_add(grapheme_width);
		}
		current = Some((chunk_start, end, chunk_width));
	}
	if let Some((start, end, _)) = current {
		lines.push(label.slice(start..end));
	}
	if lines.is_empty() {
		lines.push(Str::default());
	}
	lines
}

fn desc_lines(desc: &Str, width: u16) -> SmallVec<Str, 2> {
	let width = width.max(8);
	let mut lines = SmallVec::new();
	let mut start = None;
	let mut end = 0usize;
	let mut line_width = 0u16;
	for (offset, word) in desc
		.split_whitespace()
		.map(|word| (word.as_ptr() as usize - desc.as_str().as_ptr() as usize, word))
	{
		let word_width = cell_width(word);
		match start {
			Some(previous) if line_width.saturating_add(1).saturating_add(word_width) > width => {
				lines.push(desc.slice(previous..end));
				start = Some(offset);
				end = offset + word.len();
				line_width = word_width;
			},
			Some(_) => {
				end = offset + word.len();
				line_width = line_width.saturating_add(1).saturating_add(word_width);
			},
			None => {
				start = Some(offset);
				end = offset + word.len();
				line_width = word_width;
			},
		}
		if lines.len() == 2 {
			break;
		}
	}
	if let Some(start) = start
		&& lines.len() < 2
	{
		lines.push(desc.slice(start..end));
	}
	lines
}

const fn base(theme: &Theme) -> Style {
	Style::new().fg(theme.fg)
}
const fn dim(theme: &Theme) -> Style {
	Style::new().fg(theme.muted)
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::{Frame, Size, test_support::frame_row_text};

	fn event_ctx(ctx: &UiContext) -> EventCtx<'_> {
		EventCtx::new(ctx, 40, 8)
	}

	#[test]
	fn navigate_and_activate_changes_value() {
		let mut select = Select::new()
			.with(Prop::Id, "pick")
			.option(SelectOption::new().label("one").with(Prop::Value, "1"))
			.option(SelectOption::new().label("two").with(Prop::Value, "2"));
		let ctx = UiContext::default();
		assert_eq!(
			select.key(&mut event_ctx(&ctx), Key::Down),
			Flow::Event(UiEvent::Highlighted { id: "pick".into(), value: "2".into() }),
			"cursor moves surface the highlighted option"
		);
		assert_eq!(
			select.key(&mut event_ctx(&ctx), Key::Enter),
			Flow::Event(UiEvent::Changed { id: "pick".into(), value: "2".into() }),
			"activation surfaces the committed option"
		);
		let mut values = serde_json::Map::new();
		select.value(&mut values);
		assert_eq!(values["pick"], serde_json::json!("2"));
		assert_eq!(select.key(&mut event_ctx(&ctx), Key::Down), Flow::Skip);
	}

	#[test]
	fn home_and_end_jump_between_filtered_options() {
		let mut select = Select::new()
			.with(Prop::Id, "pick")
			.with(Prop::Filter, true)
			.option(
				SelectOption::new()
					.label("one match")
					.with(Prop::Value, "one"),
			)
			.option(
				SelectOption::new()
					.label("two match")
					.with(Prop::Value, "two"),
			)
			.option(
				SelectOption::new()
					.label("red match")
					.with(Prop::Value, "red"),
			)
			.option(
				SelectOption::new()
					.label("unrelated")
					.with(Prop::Value, "unrelated"),
			);
		let ctx = UiContext::default();

		for character in "match".chars() {
			let _ = select.key(&mut event_ctx(&ctx), Key::Char(character));
		}
		assert_eq!(
			select.key(&mut event_ctx(&ctx), Key::End),
			Flow::Event(UiEvent::Highlighted { id: "pick".into(), value: "red".into() })
		);
		assert_eq!(
			select.key(&mut event_ctx(&ctx), Key::Home),
			Flow::Event(UiEvent::Highlighted { id: "pick".into(), value: "one".into() })
		);
	}

	#[test]
	fn paint_places_rows_and_registers_hits() {
		let mut select = Select::new().option(SelectOption::new().label("Alpha"));
		let ctx = UiContext::default();
		let height = select.height(&ctx, 32);
		let rect = Rect::new(0, 0, 32, height);
		select.place(&ctx, rect);
		let mut frame = Frame::new(Size::new(32, height));
		let mut hits = Vec::new();
		let mut wakes = Vec::new();
		let mut pc = PaintCtx::new(&mut frame, &ctx, &mut hits, &mut wakes);
		pc.focus = Some(select.slot());
		select.paint(&mut pc, rect);
		assert!(frame_row_text(&frame, 0).contains("Alpha"));
		assert_eq!(hits.len(), 1);
	}

	#[test]
	fn long_labels_wrap_onto_indented_continuation_rows() {
		let label = "This is a deliberately long option label with distinguishing tail";
		let mut select = Select::new().option(SelectOption::new().label(label));
		let ctx = UiContext::default();
		let width = 24;
		let height = select.height(&ctx, width);
		assert!(height > 1, "the complete label must occupy multiple visual rows");
		let rect = Rect::new(0, 0, width, height);
		select.place(&ctx, rect);
		let mut frame = Frame::new(Size::new(width, height));
		let mut hits = Vec::new();
		let mut wakes = Vec::new();
		let mut pc = PaintCtx::new(&mut frame, &ctx, &mut hits, &mut wakes);
		pc.focus = Some(select.slot());
		select.paint(&mut pc, rect);

		let rows: Vec<String> = (0..height).map(|row| frame_row_text(&frame, row)).collect();
		assert!(rows.iter().all(|row| !row.contains('…')), "labels must not be truncated");
		assert!(
			rows.iter().any(|row| row.contains("distinguishing tail")),
			"the disambiguating tail remains visible: {rows:?}"
		);
		let indent = cell_width(ctx.charset.cursor()) + cell_width(ctx.charset.radio(false)) + 1;
		let continuation = rows
			.iter()
			.find(|row| row.contains("distinguishing tail"))
			.expect("tail continuation row");
		assert_eq!(
			cell_width(&continuation[..continuation.len() - continuation.trim_start().len()]),
			indent,
			"continuations align under the label"
		);
	}

	#[test]
	fn multi_select_space_toggles_and_enter_submits_current_selection() {
		let mut select = Select::new()
			.with(Prop::Id, "checks")
			.with(Prop::Multi, true)
			.option(SelectOption::new().label("lint"))
			.option(SelectOption::new().label("unit"));
		let ctx = UiContext::default();
		let mut values = serde_json::Map::new();

		assert_eq!(
			select.key(&mut event_ctx(&ctx), Key::Enter),
			Flow::Event(UiEvent::Submit),
			"an empty multi-select is a valid submission"
		);
		select.value(&mut values);
		assert_eq!(values["checks"], serde_json::json!([]));

		assert_eq!(
			select.key(&mut event_ctx(&ctx), Key::Space),
			Flow::Event(UiEvent::Changed { id: "checks".into(), value: "lint".into() }),
			"Space alone toggles the focused option"
		);
		assert_eq!(
			select.key(&mut event_ctx(&ctx), Key::Enter),
			Flow::Event(UiEvent::Submit),
			"Enter submits without toggling the focused option"
		);
		values.clear();
		select.value(&mut values);
		assert_eq!(values["checks"], serde_json::json!(["lint"]));
	}
	#[test]
	fn multi_select_adopts_selected_rows_and_active_cursor() {
		let mut select = Select::new()
			.with(Prop::Id, "checks")
			.with(Prop::Multi, true)
			.option(
				SelectOption::new()
					.label("lint")
					.with(Prop::Value, "lint")
					.with(Prop::Selected, true),
			)
			.option(
				SelectOption::new()
					.label("unit")
					.with(Prop::Value, "unit")
					.with(Prop::Active, true),
			);
		select.enter(true);
		let mut values = serde_json::Map::new();
		select.value(&mut values);
		assert_eq!(values["checks"], serde_json::json!(["lint"]));
		assert_eq!(select.cursor_value().as_deref(), Some("unit"));
	}

	#[test]
	fn digit_selects_matching_numbered_label_after_unnumbered_row() {
		let mut select = Select::new()
			.with(Prop::Id, "pick")
			.with(Prop::Filter, true)
			.option(
				SelectOption::new()
					.label("Detected item")
					.with(Prop::Value, "detected"),
			)
			.option(
				SelectOption::new()
					.label("1. First")
					.with(Prop::Value, "first"),
			)
			.option(
				SelectOption::new()
					.label("2. Second")
					.with(Prop::Value, "second"),
			);
		let ctx = UiContext::default();

		assert_eq!(
			select.key(&mut event_ctx(&ctx), Key::Char('2')),
			Flow::Event(UiEvent::Changed { id: "pick".into(), value: "second".into() }),
			"the digit matches the numbered label rather than the row position"
		);
	}

	#[test]
	fn digit_moves_multi_select_cursor_without_toggling() {
		let mut select = Select::new()
			.with(Prop::Id, "checks")
			.with(Prop::Multi, true)
			.with(Prop::Filter, true)
			.option(SelectOption::new().label("Context"))
			.option(SelectOption::new().label("1. Lint"))
			.option(SelectOption::new().label("2. Unit"));
		let ctx = UiContext::default();

		assert_eq!(
			select.key(&mut event_ctx(&ctx), Key::Char('2')),
			Flow::Event(UiEvent::Highlighted { id: "checks".into(), value: "2. Unit".into() })
		);
		let mut values = serde_json::Map::new();
		select.value(&mut values);
		assert_eq!(values["checks"], serde_json::json!([]));
		assert_eq!(
			select.key(&mut event_ctx(&ctx), Key::Space),
			Flow::Event(UiEvent::Changed { id: "checks".into(), value: "2. Unit".into() })
		);
	}
}
