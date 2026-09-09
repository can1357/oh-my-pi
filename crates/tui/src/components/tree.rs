use std::slice;

use omp_core::{IntoStr, Str, StrMut};
use smallvec::SmallVec;
use smol_bitmap::SmolBitmap;
use xutf::Text;

use super::{overflow_plan, paint_overflow_footer};
use crate::{
	component::{Component, EventCtx, Flow, Hit, HitTag, PaintCtx, Slot, next_slot},
	context::{Theme, UiContext},
	frame::{Color, Rect, Style},
	input::{Key, Mouse, UiEvent},
	props::{Prop, PropValue, Props},
	rich::cell_width,
};
/// One independently colored, right-aligned tree-row annotation.
#[derive(Clone, Debug)]
pub struct TreeAnnotation {
	text:  Str,
	color: Option<PropValue>,
}

impl TreeAnnotation {
	/// Creates a plain annotation.
	pub fn new(text: impl IntoStr) -> Self {
		Self { text: text.into_str(), color: None }
	}

	/// Sets the annotation's theme token or concrete color.
	pub fn color(mut self, color: impl Into<PropValue>) -> Self {
		let mut props = Props::new();
		props.set(Prop::Color, color);
		self.color = props.get(Prop::Color);
		self
	}
}

/// A labeled branch or leaf backing the `<node>` markup tag.
pub struct TreeNode {
	props:       Props,
	slot:        Slot,
	label:       Str,
	annotations: SmallVec<TreeAnnotation, 2>,
	children:    Vec<Self>,
}

impl TreeNode {
	/// Creates an empty tree node.
	pub fn new() -> Self {
		Self {
			props:       Props::new(),
			slot:        next_slot(),
			label:       Str::default(),
			annotations: SmallVec::new(),
			children:    Vec::new(),
		}
	}

	/// Sets one node property.
	pub fn with(mut self, prop: Prop, value: impl Into<PropValue>) -> Self {
		self.props.set(prop, value);
		self
	}

	/// Sets the stable application-facing node key.
	pub fn key(self, key: impl IntoStr) -> Self {
		self.with(Prop::Key, key.into_str())
	}

	/// Appends node label text.
	pub fn label(mut self, label: impl IntoStr) -> Self {
		append(&mut self.label, label.into_str());
		self
	}

	/// Sets a dim segment rendered before the main label.
	pub fn prefix(self, prefix: impl IntoStr) -> Self {
		self.with(Prop::Prefix, prefix.into_str())
	}

	/// Sets the right-aligned annotation.
	pub fn annotation(self, annotation: impl IntoStr) -> Self {
		self.with(Prop::Annotation, annotation.into_str())
	}

	/// Appends an independently colored right-aligned annotation.
	pub fn annotate(mut self, annotation: TreeAnnotation) -> Self {
		self.annotations.push(annotation);
		self
	}

	/// Sets the trailing action chip label and emitted action value.
	pub fn action(self, action: impl IntoStr) -> Self {
		self.with(Prop::Action, action.into_str())
	}

	/// Sets a semantic icon name for the leading glyph.
	pub fn icon(self, icon: impl IntoStr) -> Self {
		self.with(Prop::Icon, icon.into_str())
	}

	/// Sets a literal compact leading glyph when no icon is configured.
	pub fn badge(self, badge: impl IntoStr) -> Self {
		self.with(Prop::Badge, badge.into_str())
	}

	/// Appends a child node.
	pub fn node(mut self, node: Self) -> Self {
		self.children.push(node);
		self
	}

	fn effective_label(&self) -> &str {
		if self.label.is_empty() {
			self.props.str_of(Prop::Label).map_or("", Str::as_str)
		} else {
			&self.label
		}
	}
}

impl Default for TreeNode {
	fn default() -> Self {
		Self::new()
	}
}

#[derive(Clone, Debug, Default)]
struct TreeState {
	cursor:     usize,
	scroll_top: usize,
	selected:   Option<Str>,
	open:       SmallVec<Slot, 8>,
}

#[derive(Clone, Debug)]
struct TreeRow {
	node:         Slot,
	depth:        u16,
	key:          Str,
	label:        Str,
	prefix:       Str,
	annotations:  SmallVec<TreeAnnotation, 2>,
	action:       Str,
	icon:         Str,
	badge:        Str,
	lead_color:   Option<PropValue>,
	action_color: Option<PropValue>,
	bold:         bool,
	dim:          bool,
	has_children: bool,
	/// Continuation bits for ancestor levels below the root.
	gutters:      SmolBitmap,
	gutter_depth: usize,
	last:         bool,
}

/// A virtualized, selectable hierarchy backing the `<tree>` markup tag.
///
/// Identified trees expose the selected node key through [`crate::Ui::values`].
/// Node activation, expansion/application toggles, and trailing action chips
/// emit [`UiEvent::TreeActivated`], [`UiEvent::TreeToggled`], and
/// [`UiEvent::TreeAction`] respectively.
pub struct Tree {
	props:        Props,
	slot:         Slot,
	nodes:        Vec<TreeNode>,
	state:        TreeState,
	rows:         Vec<TreeRow>,
	rows_dirty:   bool,
	last_painted: usize,
}

impl Tree {
	/// Creates an empty tree.
	pub fn new() -> Self {
		Self {
			props:        Props::new(),
			slot:         next_slot(),
			nodes:        Vec::new(),
			state:        TreeState::default(),
			rows:         Vec::new(),
			rows_dirty:   true,
			last_painted: 0,
		}
	}

	/// Returns the selected node key after the tree has been laid out.
	pub fn selected_key(&self) -> Option<&str> {
		self.state.selected.as_deref()
	}

	/// Returns the first flattened row in the current viewport.
	pub const fn scroll_top(&self) -> usize {
		self.state.scroll_top
	}

	/// Selects the flattened row with `key`, returning whether it exists.
	///
	/// This restores application-owned selection after rebuilding a tree with
	/// fresh nodes; [`Self::set_scroll_top`] can restore its viewport
	/// separately.
	pub fn select_key(&mut self, key: &str) -> bool {
		self.rebuild_rows();
		let Some(cursor) = self.rows.iter().position(|row| row.key == key) else {
			return false;
		};
		self.state.cursor = cursor;
		self.sync_selected();
		true
	}

	/// Restores the first flattened row in the viewport.
	///
	/// Painting clamps the requested offset to the available viewport.
	pub fn set_scroll_top(&mut self, scroll_top: usize) {
		self.rebuild_rows();
		self.state.scroll_top = scroll_top.min(self.rows.len().saturating_sub(1));
	}

	#[cfg(test)]
	pub(crate) const fn visible_rows_len(&self) -> usize {
		self.rows.len()
	}

	#[cfg(test)]
	const fn painted_rows_len(&self) -> usize {
		self.last_painted
	}

	/// Sets one tree property.
	pub fn with(mut self, prop: Prop, value: impl Into<PropValue>) -> Self {
		self.props.set(prop, value);
		self
	}

	/// Sets one tree property from a string.
	pub fn with_str(mut self, prop: Prop, value: &str) -> Self {
		self.props.set(prop, value);
		self
	}

	/// Appends a root node.
	pub fn node(mut self, node: TreeNode) -> Self {
		collect_open(slice::from_ref(&node), &mut self.state.open);
		self.nodes.push(node);
		self.rows_dirty = true;
		self
	}

	fn rebuild_rows(&mut self) {
		if !self.rows_dirty {
			return;
		}
		self.rows.clear();
		let mut trail = SmolBitmap::new();
		walk_rows(&self.nodes, 0, "", &self.state.open, &mut trail, 0, &mut self.rows);
		if self.rows.is_empty() {
			self.state.cursor = 0;
			self.state.scroll_top = 0;
		} else {
			self.state.cursor = self.state.cursor.min(self.rows.len() - 1);
			self.state.scroll_top = self.state.scroll_top.min(self.rows.len() - 1);
		}
		self.sync_selected();
		self.rows_dirty = false;
	}

	fn sync_selected(&mut self) {
		self.state.selected = self.rows.get(self.state.cursor).map(|row| row.key.clone());
	}

	fn chase(&mut self, view_rows: u16) {
		let view_rows = usize::from(view_rows.max(1));
		if self.state.cursor < self.state.scroll_top {
			self.state.scroll_top = self.state.cursor;
		} else if self.state.cursor >= self.state.scroll_top.saturating_add(view_rows) {
			self.state.scroll_top = self.state.cursor + 1 - view_rows;
		}
		self.clamp_scroll(view_rows);
	}

	fn clamp_scroll(&mut self, view_rows: usize) {
		self.state.scroll_top = self
			.state
			.scroll_top
			.min(self.rows.len().saturating_sub(view_rows.max(1)));
	}

	fn move_to(&mut self, row: usize, view_rows: u16) {
		self.state.cursor = row.min(self.rows.len().saturating_sub(1));
		self.sync_selected();
		self.chase(view_rows);
	}

	fn toggle(&mut self, slot: Slot) -> bool {
		let expanded = if self.state.open.contains(&slot) {
			self.state.open.retain(|open| *open != slot);
			false
		} else {
			self.state.open.push(slot);
			true
		};
		self.rows_dirty = true;
		expanded
	}

	fn id(&self) -> Str {
		self.props.id().cloned().unwrap_or_default()
	}

	fn activated(&self, row: &TreeRow) -> Flow {
		Flow::Event(UiEvent::TreeActivated { id: self.id(), key: row.key.clone() })
	}

	fn toggled(&self, row: &TreeRow, expanded: Option<bool>) -> Flow {
		Flow::Event(UiEvent::TreeToggled { id: self.id(), key: row.key.clone(), expanded })
	}

	fn action(&self, row: &TreeRow) -> Flow {
		Flow::Event(UiEvent::TreeAction {
			id:     self.id(),
			key:    row.key.clone(),
			action: row.action.clone(),
		})
	}
}

impl Default for Tree {
	fn default() -> Self {
		Self::new()
	}
}

impl Component for Tree {
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
		self.rebuild_rows();
		let natural = self
			.rows
			.iter()
			.map(|row| row_width(row, ctx))
			.max()
			.unwrap_or(16);
		(8.min(natural), natural)
	}

	fn height(&mut self, _ctx: &UiContext, _width: u16) -> u16 {
		self.rebuild_rows();
		let natural = u16::try_from(self.rows.len()).unwrap_or(u16::MAX);
		self
			.props
			.max_rows()
			.map_or(natural, |cap| natural.min(cap))
	}

	fn paint(&mut self, pc: &mut PaintCtx<'_>, rect: Rect) {
		self.rebuild_rows();
		let natural = u16::try_from(self.rows.len()).unwrap_or(u16::MAX);
		let content_rows = overflow_plan(&self.props, natural, rect.height)
			.map_or(rect.height, |plan| plan.content_rows);
		let view_rows = usize::from(content_rows);
		self.clamp_scroll(view_rows);
		let focused = pc.focus == Some(self.slot);
		let hover_row = match pc.hover {
			Some((slot, HitTag::TreeRow(index) | HitTag::TreeAction(index))) if slot == self.slot => {
				Some(index as usize)
			},
			_ => None,
		};
		let bottom = rect.y.saturating_add(content_rows).min(pc.clip);
		let visible = usize::from(bottom.saturating_sub(rect.y));
		self.last_painted = 0;
		for (screen_row, index) in (self.state.scroll_top..self.rows.len())
			.take(visible)
			.enumerate()
		{
			let row = &self.rows[index];
			let y = rect.y.saturating_add(screen_row as u16);
			let selected = index == self.state.cursor;
			let hovered = hover_row == Some(index);
			let background = if selected {
				Some(pc.ctx.theme.selection_bg(!focused))
			} else if hovered {
				Some(pc.ctx.theme.hover)
			} else {
				None
			};
			if let Some(bg) = background {
				pc.frame
					.fill(Rect::new(rect.x, y, rect.width, 1), Style::new().bg(bg));
			}
			let tint = |style: Style| background.map_or(style, |bg| style.bg(bg));
			let mut x = pc.frame.put(
				rect.x,
				y,
				if selected {
					pc.ctx.charset.rail()
				} else {
					"  "
				},
				tint(Style::new().fg(pc.ctx.theme.accent)),
			);
			if let Some(family) = self.props.guides() {
				let (branch, last, cont) = pc.ctx.charset.guides(family);
				let guide = tint(Style::new().fg(pc.ctx.theme.muted));
				for gutter in 0..row.gutter_depth {
					x = pc
						.frame
						.put(x, y, if row.gutters.get(gutter) { cont } else { "  " }, guide);
				}
				if row.depth > 0 {
					x = pc
						.frame
						.put(x, y, if row.last { last } else { branch }, guide);
					x = pc.frame.put(x, y, " ", guide);
				}
			} else {
				x = x.saturating_add(row.depth);
			}
			let expander = if row.has_children {
				pc.ctx.charset.expander(self.state.open.contains(&row.node))
			} else if self.props.guides().is_some() {
				""
			} else {
				"  "
			};
			x = pc
				.frame
				.put(x, y, expander, tint(Style::new().fg(pc.ctx.theme.muted)));
			let lead = if row.icon.is_empty() {
				&row.badge
			} else {
				pc.ctx.charset.icon_named(&row.icon).unwrap_or(&row.icon)
			};
			if !lead.is_empty() {
				let color =
					resolve_color(row.lead_color.as_ref(), &pc.ctx.theme).unwrap_or(pc.ctx.theme.accent);
				x = pc.frame.put(x, y, lead, tint(Style::new().fg(color)));
				x = pc
					.frame
					.put(x, y, " ", tint(Style::new().fg(pc.ctx.theme.fg)));
			}

			let right = rect.x.saturating_add(rect.width);
			let action_width = if row.action.is_empty() {
				0
			} else {
				cell_width(&row.action).saturating_add(2)
			};
			let annotation_width = annotations_width(&row.annotations);
			let trailing = action_width.saturating_add(annotation_width);
			let trailing_x = right.saturating_sub(trailing);
			let available = trailing_x.saturating_sub(x);
			paint_label(pc, x, y, available, row, background);

			let mut tail_x = trailing_x;
			if annotation_width > 0 {
				for (annotation_index, annotation) in row.annotations.iter().enumerate() {
					if annotation_index > 0 {
						tail_x = tail_x.saturating_add(1);
					}
					let color = resolve_color(annotation.color.as_ref(), &pc.ctx.theme)
						.unwrap_or(pc.ctx.theme.muted);
					tail_x = pc
						.frame
						.put(tail_x, y, &annotation.text, tint(Style::new().fg(color)));
				}
			}
			pc.hits.push(Hit {
				rect: Rect::new(rect.x, y, rect.width, 1),
				slot: self.slot,
				tag:  HitTag::TreeRow(index as u32),
			});
			if action_width > 0 {
				let action_x = tail_x;
				let color = resolve_color(row.action_color.as_ref(), &pc.ctx.theme)
					.unwrap_or(pc.ctx.theme.accent);
				let chip = tint(
					Style::new().fg(color).bg(
						pc.ctx
							.theme
							.tint_bg(color, if hovered { 0.28 } else { 0.18 }),
					),
				);
				tail_x = pc.frame.put(tail_x, y, " ", chip);
				tail_x = pc.frame.put(tail_x, y, &row.action, chip.bold());
				pc.frame.put(tail_x, y, " ", chip);
				pc.hits.push(Hit {
					rect: Rect::new(action_x, y, action_width.min(right.saturating_sub(action_x)), 1),
					slot: self.slot,
					tag:  HitTag::TreeAction(index as u32),
				});
			}
			self.last_painted += 1;
		}
		if let Some(mut plan) = overflow_plan(&self.props, natural, rect.height) {
			plan.omitted =
				natural.saturating_sub(u16::try_from(self.last_painted).unwrap_or(u16::MAX));
			paint_overflow_footer(pc, rect, plan);
		}
	}

	fn focusable(&self) -> bool {
		true
	}

	fn enter(&mut self, forward: bool) {
		self.rebuild_rows();
		if self.rows.is_empty() {
			self.state.cursor = 0;
		} else {
			self.state.cursor = if forward { 0 } else { self.rows.len() - 1 };
		}
		self.sync_selected();
	}

	fn key(&mut self, ec: &mut EventCtx<'_>, key: Key) -> Flow {
		self.rebuild_rows();
		if self.rows.is_empty() {
			return Flow::Skip;
		}
		self.state.cursor = self.state.cursor.min(self.rows.len() - 1);
		let current = self.state.cursor;
		let row = self.rows[current].clone();
		let is_open = self.state.open.contains(&row.node);
		match key {
			Key::Up | Key::Char('k') => {
				if current == 0 {
					return Flow::Skip;
				}
				self.move_to(current - 1, ec.view_rows);
			},
			Key::Down | Key::Char('j') => {
				if current + 1 >= self.rows.len() {
					return Flow::Skip;
				}
				self.move_to(current + 1, ec.view_rows);
			},
			Key::Home | Key::Char('g') => self.move_to(0, ec.view_rows),
			Key::End | Key::Char('G') => self.move_to(self.rows.len() - 1, ec.view_rows),
			Key::PageUp => {
				self.move_to(current.saturating_sub(usize::from(ec.view_rows.max(1))), ec.view_rows);
			},
			Key::PageDown => self.move_to(
				current
					.saturating_add(usize::from(ec.view_rows.max(1)))
					.min(self.rows.len() - 1),
				ec.view_rows,
			),
			Key::Right | Key::Char('l') if row.has_children && !is_open => {
				let expanded = self.toggle(row.node);
				self.rebuild_rows();
				self.chase(ec.view_rows);
				return self.toggled(&row, Some(expanded));
			},
			Key::Right | Key::Char('l') if row.has_children => {
				if self
					.rows
					.get(current + 1)
					.is_some_and(|child| child.depth == row.depth + 1)
				{
					self.move_to(current + 1, ec.view_rows);
				} else {
					return Flow::Skip;
				}
			},
			Key::Right | Key::Char('l') => return self.activated(&row),
			Key::Left | Key::Char('h') if row.has_children && is_open => {
				let expanded = self.toggle(row.node);
				self.rebuild_rows();
				self.chase(ec.view_rows);
				return self.toggled(&row, Some(expanded));
			},
			Key::Left | Key::Char('h') => {
				if let Some(parent) = self.rows[..current]
					.iter()
					.rposition(|candidate| candidate.depth + 1 == row.depth)
				{
					self.move_to(parent, ec.view_rows);
				} else {
					return Flow::Skip;
				}
			},
			Key::Enter => return self.activated(&row),
			Key::Space if row.has_children => {
				let expanded = self.toggle(row.node);
				self.rebuild_rows();
				self.chase(ec.view_rows);
				return self.toggled(&row, Some(expanded));
			},
			Key::Space => return self.toggled(&row, None),
			_ => return Flow::Skip,
		}
		Flow::Consumed
	}

	fn mouse(
		&mut self,
		_ec: &mut EventCtx<'_>,
		tag: HitTag,
		_at: (u16, u16),
		rect: Rect,
		mouse: Mouse,
	) -> Flow {
		self.rebuild_rows();
		match mouse {
			Mouse::WheelUp | Mouse::WheelDown => {
				if self.rows.is_empty() {
					return Flow::Skip;
				}
				let view_rows = usize::from(rect.height.max(1));
				if mouse == Mouse::WheelUp {
					self.state.scroll_top = self.state.scroll_top.saturating_sub(3);
				} else {
					self.state.scroll_top = self.state.scroll_top.saturating_add(3);
				}
				self.clamp_scroll(view_rows);
				Flow::Consumed
			},
			Mouse::Click => {
				let (index, action) = match tag {
					HitTag::TreeRow(index) => (index as usize, false),
					HitTag::TreeAction(index) => (index as usize, true),
					_ => return Flow::Skip,
				};
				let Some(row) = self.rows.get(index).cloned() else {
					return Flow::Skip;
				};
				self.state.cursor = index;
				self.sync_selected();
				if action && !row.action.is_empty() {
					return self.action(&row);
				}
				if row.has_children {
					let expanded = self.toggle(row.node);
					self.rebuild_rows();
					self.toggled(&row, Some(expanded))
				} else {
					self.activated(&row)
				}
			},
			Mouse::RightClick
			| Mouse::MiddleClick
			| Mouse::Move
			| Mouse::Drag
			| Mouse::Release
			| Mouse::WheelLeft
			| Mouse::WheelRight => Flow::Skip,
		}
	}

	fn value(&self, out: &mut serde_json::Map<String, serde_json::Value>) {
		let Some(id) = self.props.id() else {
			return;
		};
		let value = self
			.state
			.selected
			.as_ref()
			.map_or(serde_json::Value::Null, |key| serde_json::Value::String(key.to_string()));
		out.insert(id.to_string(), value);
	}
}

fn collect_open(nodes: &[TreeNode], open: &mut SmallVec<Slot, 8>) {
	for node in nodes {
		if node.props.flag(Prop::Open) {
			open.push(node.slot);
		}
		collect_open(&node.children, open);
	}
}

fn walk_rows(
	nodes: &[TreeNode],
	depth: u16,
	path_prefix: &str,
	open: &[Slot],
	trail: &mut SmolBitmap,
	trail_depth: usize,
	rows: &mut Vec<TreeRow>,
) {
	let count = nodes.len();
	for (index, node) in nodes.iter().enumerate() {
		let label = node.effective_label();
		let path = join_path(path_prefix, label);
		let key = node
			.props
			.str_of(Prop::Key)
			.cloned()
			.unwrap_or_else(|| path.clone());
		let has_children = !node.children.is_empty();
		let last = index + 1 == count;
		let gutter_depth = trail_depth.saturating_sub(1);
		let mut gutters = SmolBitmap::with_capacity(gutter_depth);
		for gutter in 0..gutter_depth {
			gutters.set(gutter, trail.get(gutter + 1));
		}
		let mut annotations = node.annotations.clone();
		if let Some(text) = node.props.str_of(Prop::Annotation) {
			annotations.push(TreeAnnotation {
				text:  text.clone(),
				color: node.props.get(Prop::AnnotationColor),
			});
		}
		rows.push(TreeRow {
			node: node.slot,
			depth,
			key,
			label: Str::new(label),
			prefix: node.props.str_of(Prop::Prefix).cloned().unwrap_or_default(),
			annotations,
			action: node.props.str_of(Prop::Action).cloned().unwrap_or_default(),
			icon: node.props.str_of(Prop::Icon).cloned().unwrap_or_default(),
			badge: node.props.str_of(Prop::Badge).cloned().unwrap_or_default(),
			lead_color: node.props.get(Prop::Color),
			action_color: node.props.get(Prop::ActionColor),
			bold: node.props.flag(Prop::Bold),
			dim: node.props.flag(Prop::Dim),
			has_children,
			gutters,
			gutter_depth,
			last,
		});
		if open.contains(&node.slot) {
			trail.set(trail_depth, !last);
			walk_rows(
				&node.children,
				depth.saturating_add(1),
				&path,
				open,
				trail,
				trail_depth.saturating_add(1),
				rows,
			);
			trail.set(trail_depth, false);
		}
	}
}

fn join_path(prefix: &str, label: &str) -> Str {
	if prefix.is_empty() {
		return Str::new(label);
	}
	let mut path = StrMut::with_capacity(prefix.len().saturating_add(label.len()).saturating_add(1));
	path.push_str(prefix);
	path.push('/');
	path.push_str(label);
	path.freeze()
}

fn resolve_color(value: Option<&PropValue>, theme: &Theme) -> Option<Color> {
	match value? {
		PropValue::Color(color) => Some(*color),
		PropValue::Token(token) => theme.token(token),
		_ => None,
	}
}

fn row_width(row: &TreeRow, ctx: &UiContext) -> u16 {
	let lead = if row.icon.is_empty() {
		&row.badge
	} else {
		ctx.charset.icon_named(&row.icon).unwrap_or(&row.icon)
	};
	2_u16
		.saturating_add(row.depth)
		.saturating_add(2)
		.saturating_add(cell_width(lead))
		.saturating_add(u16::from(!lead.is_empty()))
		.saturating_add(cell_width(&row.prefix))
		.saturating_add(cell_width(&row.label))
		.saturating_add(annotations_width(&row.annotations))
		.saturating_add(if row.action.is_empty() {
			0
		} else {
			cell_width(&row.action).saturating_add(2)
		})
}

fn annotations_width(annotations: &[TreeAnnotation]) -> u16 {
	annotations
		.iter()
		.map(|annotation| cell_width(&annotation.text))
		.fold(0_u16, u16::saturating_add)
		.saturating_add(u16::try_from(annotations.len().saturating_sub(1)).unwrap_or(u16::MAX))
}

fn paint_label(
	pc: &mut PaintCtx<'_>,
	mut x: u16,
	y: u16,
	available: u16,
	row: &TreeRow,
	background: Option<Color>,
) {
	if available == 0 {
		return;
	}
	let start_x = x;
	let tint = |style: Style| background.map_or(style, |bg| style.bg(bg));
	let mut base = Style::new().fg(pc.ctx.theme.fg);
	if row.bold {
		base = base.bold();
	}
	if row.dim {
		base = base.dim();
	}
	let label_width = cell_width(&row.label);
	let prefix_width = cell_width(&row.prefix);
	if prefix_width > 0 && label_width < available {
		let prefix_budget = available.saturating_sub(label_width);
		let (prefix, ellipsis) = truncate_start(&row.prefix, prefix_budget);
		if ellipsis {
			x = pc.frame.put(x, y, "…", tint(base.dim()));
		}
		x = pc.frame.put(x, y, prefix, tint(base.dim()));
	}
	let label_budget = available.saturating_sub(x.saturating_sub(start_x));
	let truncated = crate::components::hr::truncate_to_width(&row.label, label_budget);
	pc.frame.put(x, y, truncated.text, tint(base));
	if truncated.ellipsis {
		let ellipsis_x = x.saturating_add(truncated.width.saturating_sub(1));
		pc.frame.put(ellipsis_x, y, "…", tint(base));
	}
}

fn truncate_start(text: &str, width: u16) -> (&str, bool) {
	let natural = cell_width(text);
	if natural <= width {
		return (text, false);
	}
	if width == 0 {
		return ("", false);
	}
	let budget = width - 1;
	let mut kept = 0_u16;
	let mut start = text.len();
	for (offset, grapheme) in text.grapheme_indices().rev() {
		let grapheme_width = cell_width(grapheme);
		if kept.saturating_add(grapheme_width) > budget {
			break;
		}
		kept = kept.saturating_add(grapheme_width);
		start = offset;
	}
	(&text[start..], true)
}

fn append(target: &mut Str, suffix: Str) {
	if target.is_empty() {
		*target = suffix;
		return;
	}
	let mut joined = StrMut::with_capacity(target.len().saturating_add(suffix.len()));
	joined.push_str(target);
	joined.push_str(&suffix);
	*target = joined.freeze();
}

#[cfg(test)]
mod tests {
	use omp_core::sf;

	use super::*;
	use crate::{
		Frame, Size,
		test_support::{frame_cell_style, frame_row_text},
	};

	fn event_ctx(ctx: &UiContext, rows: u16) -> EventCtx<'_> {
		EventCtx::new(ctx, 40, rows)
	}

	fn paint(tree: &mut Tree, ctx: &UiContext, width: u16, height: u16) -> (Frame, Vec<Hit>) {
		let mut frame = Frame::new(Size::new(width, height));
		let mut hits = Vec::new();
		let mut wakes = Vec::new();
		let slot = tree.slot();
		let mut pc = PaintCtx::new(&mut frame, ctx, &mut hits, &mut wakes);
		pc.focus = Some(slot);
		tree.paint(&mut pc, Rect::new(0, 0, width, height));
		(frame, hits)
	}

	#[test]
	fn selection_values_and_activation_use_explicit_keys() {
		let ctx = UiContext::default();
		let mut tree = Tree::new().with(Prop::Id, "tree-id").node(
			TreeNode::new()
				.key("root-key")
				.label("root")
				.node(TreeNode::new().key("leaf-key").label("leaf")),
		);
		let mut ec = event_ctx(&ctx, 4);
		assert_eq!(
			tree.key(&mut ec, Key::Right),
			Flow::Event(UiEvent::TreeToggled {
				id:       "tree-id".into(),
				key:      "root-key".into(),
				expanded: Some(true),
			})
		);
		assert_eq!(tree.key(&mut ec, Key::Right), Flow::Consumed);
		assert_eq!(
			tree.key(&mut ec, Key::Enter),
			Flow::Event(UiEvent::TreeActivated { id: "tree-id".into(), key: "leaf-key".into() })
		);
		let mut values = serde_json::Map::new();
		tree.value(&mut values);
		assert_eq!(values["tree-id"], serde_json::json!("leaf-key"));
	}

	#[test]
	fn keyboard_matrix_releases_edges_and_obeys_tree_navigation() {
		let ctx = UiContext::default();
		let mut tree = Tree::new().node(
			TreeNode::new()
				.label("root")
				.with(Prop::Open, true)
				.node(TreeNode::new().label("a"))
				.node(TreeNode::new().label("b")),
		);
		let mut ec = event_ctx(&ctx, 2);
		assert_eq!(tree.key(&mut ec, Key::Up), Flow::Skip);
		assert_eq!(tree.key(&mut ec, Key::Char('j')), Flow::Consumed);
		assert_eq!(tree.key(&mut ec, Key::Char('h')), Flow::Consumed);
		assert_eq!(tree.state.cursor, 0);
		assert!(matches!(
			tree.key(&mut ec, Key::Char('h')),
			Flow::Event(UiEvent::TreeToggled { expanded: Some(false), .. })
		));
		assert!(matches!(
			tree.key(&mut ec, Key::Char('l')),
			Flow::Event(UiEvent::TreeToggled { expanded: Some(true), .. })
		));
		assert_eq!(tree.key(&mut ec, Key::Char('l')), Flow::Consumed);
		assert_eq!(tree.state.cursor, 1);
		assert_eq!(tree.key(&mut ec, Key::End), Flow::Consumed);
		assert_eq!(tree.key(&mut ec, Key::Down), Flow::Skip);
		assert_eq!(tree.key(&mut ec, Key::Home), Flow::Consumed);
		assert_eq!(tree.key(&mut ec, Key::PageDown), Flow::Consumed);
		assert_eq!(tree.state.cursor, 2);
		assert_eq!(tree.key(&mut ec, Key::Char('g')), Flow::Consumed);
		assert_eq!(tree.key(&mut ec, Key::Char('G')), Flow::Consumed);
	}

	#[test]
	fn row_gutters_keep_logical_trailing_false_depth() {
		let mut tree = Tree::new().node(
			TreeNode::new()
				.label("root")
				.with(Prop::Open, true)
				.node(
					TreeNode::new().label("a").with(Prop::Open, true).node(
						TreeNode::new()
							.label("a1")
							.with(Prop::Open, true)
							.node(TreeNode::new().label("leaf")),
					),
				)
				.node(TreeNode::new().label("b")),
		);
		tree.rebuild_rows();

		let leaf = tree
			.rows
			.iter()
			.find(|row| row.label.as_str() == "leaf")
			.expect("leaf row");
		assert_eq!(leaf.gutter_depth, 2);
		assert!(leaf.gutters.get(0));
		assert!(!leaf.gutters.get(1));
	}

	#[test]
	fn virtualization_paints_only_window_and_scroll_chases_selection() {
		let ctx = UiContext::default();
		let mut tree = Tree::new();
		for index in 0..10_000 {
			tree = tree.node(
				TreeNode::new()
					.key(sf!("node-{index}"))
					.label(sf!("row {index}")),
			);
		}
		let (frame, hits) = paint(&mut tree, &ctx, 24, 4);
		assert_eq!(tree.painted_rows_len(), 4);
		assert_eq!(
			hits
				.iter()
				.filter(|hit| matches!(hit.tag, HitTag::TreeRow(_)))
				.count(),
			4
		);
		assert!(frame_row_text(&frame, 3).contains("row 3"));
		let mut ec = event_ctx(&ctx, 4);
		assert_eq!(tree.key(&mut ec, Key::End), Flow::Consumed);
		assert_eq!(tree.scroll_top(), 9_996);
		let (frame, _) = paint(&mut tree, &ctx, 24, 4);
		assert!(frame_row_text(&frame, 3).contains("row 9999"));
		assert_eq!(
			tree.mouse(
				&mut ec,
				HitTag::TreeRow(9_999),
				(0, 0),
				Rect::new(0, 0, 24, 4),
				Mouse::WheelUp
			),
			Flow::Consumed
		);
		assert_eq!(tree.scroll_top(), 9_993);
	}
	#[test]
	fn max_rows_reserves_shared_footer_and_counts_unpainted_items() {
		let ctx = UiContext::default();
		let mut tree = Tree::new()
			.with(Prop::MaxRows, 3_u16)
			.with(Prop::Overflow, "items")
			.node(TreeNode::new().label("a"))
			.node(TreeNode::new().label("b"))
			.node(TreeNode::new().label("c"))
			.node(TreeNode::new().label("d"));
		assert_eq!(tree.height(&ctx, 20), 3);
		let (frame, hits) = paint(&mut tree, &ctx, 20, 3);
		assert_eq!(tree.painted_rows_len(), 2);
		assert_eq!(
			hits
				.iter()
				.filter(|hit| matches!(hit.tag, HitTag::TreeRow(_)))
				.count(),
			2
		);
		assert_eq!(frame_row_text(&frame, 2), "… 2 more items");
	}

	#[test]
	fn selection_and_scroll_can_be_restored_by_key() {
		let ctx = UiContext::default();
		let mut tree = Tree::new()
			.node(TreeNode::new().key("a").label("a"))
			.node(TreeNode::new().key("b").label("b"))
			.node(TreeNode::new().key("c").label("c"));
		assert!(tree.select_key("c"));
		assert_eq!(tree.selected_key(), Some("c"));
		assert!(!tree.select_key("missing"));
		assert_eq!(tree.selected_key(), Some("c"));
		tree.set_scroll_top(2);
		assert_eq!(tree.scroll_top(), 2);
		let _ = paint(&mut tree, &ctx, 20, 2);
		assert_eq!(tree.scroll_top(), 1);
	}

	#[test]
	fn rich_cells_color_prefix_annotation_action_and_truncate() {
		let mut ctx = UiContext::default();
		ctx.theme.accent = Color::Rgb(1, 2, 3);
		ctx.theme.info = Color::Rgb(4, 5, 6);
		ctx.theme.ok = Color::Rgb(7, 8, 9);
		ctx.theme.err = Color::Rgb(10, 11, 12);
		let mut tree = Tree::new().with(Prop::Id, "files").node(
			TreeNode::new()
				.key("leaf")
				.icon("search")
				.with(Prop::Color, "accent")
				.prefix("a/very/long/prefix/")
				.label("name")
				.annotate(TreeAnnotation::new("+2").color("info"))
				.annotate(TreeAnnotation::new("-1").color("err"))
				.action("Run")
				.with(Prop::ActionColor, "ok")
				.with(Prop::Bold, true),
		);
		let (frame, hits) = paint(&mut tree, &ctx, 28, 1);
		let text = frame_row_text(&frame, 0);
		assert!(text.contains('…'), "{text}");
		assert!(text.ends_with("+2 -1 Run"), "{text}");
		let icon_x = text.find('⌕').or_else(|| text.find('?')).unwrap_or(4) as u16;
		assert_eq!(frame_cell_style(&frame, icon_x, 0).foreground_color(), Color::Rgb(1, 2, 3));
		assert!(frame_cell_style(&frame, 7, 0).spec().dim, "prefix is dim");
		assert_eq!(frame_cell_style(&frame, 18, 0).foreground_color(), Color::Rgb(4, 5, 6));
		assert_eq!(frame_cell_style(&frame, 21, 0).foreground_color(), Color::Rgb(10, 11, 12));
		assert_eq!(frame_cell_style(&frame, 24, 0).foreground_color(), Color::Rgb(7, 8, 9));
		let action = hits
			.iter()
			.find(|hit| matches!(hit.tag, HitTag::TreeAction(0)))
			.expect("action hit");
		let mut ec = event_ctx(&ctx, 1);
		assert_eq!(
			tree.mouse(&mut ec, action.tag, (action.rect.x, 0), Rect::new(0, 0, 28, 1), Mouse::Click),
			Flow::Event(UiEvent::TreeAction {
				id:     "files".into(),
				key:    "leaf".into(),
				action: "Run".into(),
			})
		);
		let mut long = Tree::new().node(TreeNode::new().label("label-that-does-not-fit"));
		let (frame, _) = paint(&mut long, &ctx, 12, 1);
		assert!(frame_row_text(&frame, 0).contains('…'), "long labels end-truncate");
	}
}
