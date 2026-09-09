//! Retained component tree layout, painting, updates, and input routing.

use std::{io, time::Duration};

use omp_core::{IntoStr, Str};
use serde_json::Value;
use smallvec::SmallVec;

use crate::{
	PaintStats, Renderer,
	component::{
		Cached, Component, EventCtx, Flow, Hit, HitTag, IntoComponent, PaintCtx, Slot, Wake,
	},
	components::{EditorPane, Img, ImgState, Row, Scroll, Tabs, Wizard},
	context::UiContext,
	frame::{Color, Frame, Rect, Size, Style},
	input::{Key, Mods, Mouse, UiEvent},
	markup::{self, ParseError},
	overlay::{self, OverlayBand, OverlayId, OverlayOptions},
	props::{Prop, PropValue},
	renderer::ResolvedLayer,
	rich,
};

#[derive(Clone, Debug)]
enum Predicate {
	Equal(Str),
	NotEqual(Str),
}

#[derive(Clone, Debug)]
struct CompiledCond {
	target:    Slot,
	source_id: Str,
	predicate: Predicate,
}

#[derive(Clone, Copy)]
struct PathEntry {
	slot:        Slot,
	rect:        Rect,
	visible:     bool,
	fixed:       bool,
	row:         bool,
	paint_owner: bool,
}

type ComponentPath = SmallVec<PathEntry, 16>;

/// One stacked overlay layer: a nested retained tree plus its placement.
struct OverlayEntry {
	id:      OverlayId,
	/// Boxed: the entry keeps hot placement fields inline while breaking the
	/// `Ui` -> `OverlayEntry` -> `Ui` size cycle `SmallVec` inline storage
	/// would otherwise create.
	ui:      Box<Ui>,
	options: OverlayOptions,
	/// Placement resolved by the most recent present; `rows == 0` means the
	/// layer is not composited (hidden, gated, or never presented).
	band:    OverlayBand,
	hidden:  bool,
}

impl OverlayEntry {
	/// Whether the layer composites and captures input for `viewport`.
	fn visible(&self, viewport: Option<Size>) -> bool {
		!self.hidden && viewport.is_none_or(|vp| overlay::visible_at(&self.options, vp))
	}
}

/// A parsed, laid-out, retained component tree painting into a [`Frame`].
pub struct Ui {
	#[allow(dead_code, reason = "keeps parsed source storage alive")]
	pub(crate) source:   Str,
	pub(crate) root:     Cached,
	pub(crate) frame:    Frame,
	/// Cached fixed-height frame passed to the renderer.
	viewport_frame:      Frame,
	pub(crate) width:    u16,
	/// Row ranges repainted since the last successful present.
	pub(crate) damage:   SmallVec<(u16, u16), 8>,
	pub(crate) focus:    Option<Slot>,
	pub(crate) hover:    Option<(Slot, HitTag)>,
	/// Last pointer cell in document coordinates, feeding pointer-tracking
	/// chrome such as the `hover` glow.
	pub(crate) pointer:  Option<(u16, u16)>,
	/// Modifiers attached to the mouse event currently being routed.
	mouse_mods:          Mods,
	/// Whether the keyboard was the most recent input modality; gates the
	/// focus-side hover chrome so only one chrome cursor exists.
	pub(crate) keyboard: bool,
	pub(crate) hits:     Vec<Hit>,
	drag:                Option<Hit>,
	conds:               Vec<CompiledCond>,
	/// Presentation clock: the `now` of the most recent [`Ui::tick`].
	now:                 Duration,
	/// Pending animation wake requests, rebuilt by every paint.
	wakes:               Vec<Wake>,
	pub(crate) ctx:      UiContext,
	/// Stacked overlay layers, bottom to top: ascending (`options.z`, creation
	/// order).
	overlays:            SmallVec<OverlayEntry, 4>,
	/// Monotonic id source for overlay handles.
	next_overlay:        u32,
	/// Non-modal layer currently holding the keyboard, if any.
	key_overlay:         Option<OverlayId>,
	/// Viewport recorded by the most recent [`Ui::present`].
	viewport:            Option<Size>,
	/// The overlay stack changed shape since the last present.
	overlays_dirty:      bool,
	/// Marks an overlay-owned tree, which cannot stack overlays of its own.
	nested:              bool,
}

impl Ui {
	/// Parses runtime markup and produces the first fully painted frame.
	///
	/// Prefer [`Ui::from_root`] with [`crate::dom!`] when the structure is
	/// known at compile time; this path is for markup that only exists at
	/// runtime (configuration, generated text, editable source).
	///
	/// # Errors
	/// Returns [`ParseError`] for malformed markup.
	pub fn from_markup(
		source: impl IntoStr,
		width: u16,
		ctx: UiContext,
	) -> Result<Self, ParseError> {
		let source = source.into_str();
		let root = markup::parse(&source, &ctx)?;
		Ok(Self::from_cached(source, root, width, ctx))
	}

	/// Parses extension-authored runtime markup, degrading core-reserved
	/// chrome tags into inert custom elements.
	///
	/// # Errors
	/// Returns [`ParseError`] for malformed markup.
	pub fn from_extension_markup(
		source: impl IntoStr,
		width: u16,
		ctx: UiContext,
	) -> Result<Self, ParseError> {
		let source = source.into_str();
		let root = markup::parse_with_origin(&source, &ctx, markup::MarkupOrigin::Extension)?;
		Ok(Self::from_cached(source, root, width, ctx))
	}

	/// Builds a retained UI directly from a component tree.
	pub fn from_root(root: impl IntoComponent, width: u16, ctx: UiContext) -> Self {
		Self::from_cached(Str::new(""), Cached::new(root.into_component()), width, ctx)
	}

	fn from_cached(source: Str, root: Cached, width: u16, ctx: UiContext) -> Self {
		let mut ui = Self {
			source,
			root,
			frame: Frame::new(Size::new(width, 0)),
			viewport_frame: Frame::new(Size::new(width, 0)),
			width,
			damage: SmallVec::new(),
			focus: None,
			hover: None,
			pointer: None,
			mouse_mods: Mods::default(),
			keyboard: false,
			hits: Vec::new(),
			drag: None,
			conds: Vec::new(),
			now: Duration::ZERO,
			wakes: Vec::new(),
			ctx,
			overlays: SmallVec::new(),
			next_overlay: 0,
			key_overlay: None,
			viewport: None,
			overlays_dirty: false,
			nested: false,
		};
		ui.compile_conds();
		ui.apply_conds(false);
		ui.focus = ui.focus_ring().first().copied();
		if let Some(slot) = ui.focus
			&& let Some(cached) = ui.root.find_slot(slot)
		{
			// Entering focus positions internal selection (a single select
			// rests on its chosen option) even before the first key.
			cached.comp_mut().enter(true);
		}
		ui.layout_all();
		ui
	}

	/// The retained component frame before fixed-viewport clipping.
	pub const fn frame(&self) -> &Frame {
		&self.frame
	}

	/// The presentation context this tree renders with.
	pub const fn context(&self) -> &UiContext {
		&self.ctx
	}

	/// A custom (non-well-known) attribute declared on the first root-level
	/// parsed element, e.g. a tool view's `chrome` presentation hint.
	///
	/// Markup parses into a synthetic root column; this probes its first
	/// child, which is the document's authored root element. Returns `None`
	/// for empty documents and trees built from [`Ui::from_root`].
	pub fn root_custom(&self, name: &str) -> Option<&PropValue> {
		self
			.root
			.comp()
			.children()
			.first()?
			.comp()
			.props()
			.custom(name)
	}

	/// Swaps the presentation context and refreshes the whole document.
	///
	/// Applies `ctx` to this tree and every stacked overlay, advances the
	/// cache revision so geometry and render memos discard context-derived
	/// output, then relays out and repaints. A context that compares equal
	/// (appearance, charset, graphics, Jamo policy, theme, elements) is a
	/// no-op returning `false`. The presentation clock is retained, and a
	/// context without an image loader keeps the installed one. Structure
	/// parsed from markup is retained: swapping `elements` affects future
	/// parses only.
	pub fn set_context(&mut self, ctx: UiContext) -> bool {
		if self.ctx == ctx {
			return false;
		}
		// Keep the process-wide width policy in sync; a Jamo change also
		// advances the width epoch geometry memos key on.
		rich::set_jamo_width(ctx.jamo_width);
		self.apply_context(&ctx);
		true
	}

	/// Installs `ctx`, preserving this tree's clock and loader, then relays
	/// out and recurses into overlay layers.
	///
	/// Every tree advances from its own revision: an overlay swapped
	/// directly through [`Ui::overlay_mut`] may already sit at the parent's
	/// next revision, and reusing the parent's number would let memos keyed
	/// on it survive the swap.
	fn apply_context(&mut self, ctx: &UiContext) {
		let revision = self.ctx.revision.wrapping_add(1);
		let now = self.ctx.now;
		let loader = self.ctx.loader.take();
		self.ctx = ctx.clone();
		self.ctx.revision = revision;
		self.ctx.now = now;
		if self.ctx.loader.is_none() {
			self.ctx.loader = loader;
		}
		self.layout_all();
		for entry in &mut self.overlays {
			entry.ui.apply_context(ctx);
		}
	}

	/// Document height in rows after the last layout.
	pub const fn height(&self) -> u16 {
		self.root.rect.height
	}

	/// Whether a present is needed after the most recent mutation.
	pub fn has_damage(&self) -> bool {
		!self.damage.is_empty()
			|| self.overlays_dirty
			|| self.overlays.iter().any(|entry| entry.ui.has_damage())
	}

	/// Consumes raw-frame damage after an embedder copies [`Ui::frame`].
	pub fn take_frame_damage(&mut self) -> bool {
		let changed = !self.damage.is_empty();
		self.damage.clear();
		changed
	}

	/// Marks the whole component frame damaged so the next present repaints it.
	pub(crate) fn damage_all(&mut self) {
		self.damage.clear();
		self.damage.push((0, self.frame.size().height));
		self.overlays_dirty |= !self.overlays.is_empty();
	}

	/// Replaces a named component's text and refreshes the smallest safe region.
	pub fn set_text(&mut self, id: &str, text: impl IntoStr) -> bool {
		let Some((slot, old_measure, old_rect, presented)) = self.snapshot_id(id) else {
			return false;
		};
		let text = text.into_str();
		let ctx = &self.ctx;
		let Some(changed) = self.root.update_id(id, |cached| {
			let changed = cached.comp_mut().set_text(ctx, text);
			(changed, true)
		}) else {
			return false;
		};
		if !changed {
			return false;
		}
		if presented {
			self.refresh_slot(slot, old_measure, old_rect);
		}
		self.apply_conds(true);
		true
	}

	/// Locates a named component, downcasts it to `T`, and reads through
	/// `probe` without invalidating anything; an unknown id or mismatched
	/// concrete type returns `None`.
	pub fn with_component<T: Component, R>(
		&self,
		id: &str,
		probe: impl FnOnce(&T) -> R,
	) -> Option<R> {
		fn find<'a>(cached: &'a Cached, id: &str) -> Option<&'a Cached> {
			if cached
				.comp()
				.props()
				.id()
				.is_some_and(|candidate| candidate == id)
			{
				return Some(cached);
			}
			cached
				.comp()
				.children()
				.iter()
				.find_map(|child| find(child, id))
		}
		find(&self.root, id)?.comp().downcast_ref::<T>().map(probe)
	}

	/// Locates a named component, downcasts it to `T`, and applies `update`.
	/// A successful typed mutation invalidates the component and returns the
	/// closure's value; an unknown id or mismatched concrete type returns
	/// `None`.
	pub fn with_component_mut<T: Component, R>(
		&mut self,
		id: &str,
		update: impl FnOnce(&mut T) -> R,
	) -> Option<R> {
		let (slot, old_measure, old_rect, presented) = self.snapshot_id(id)?;
		let result = self.root.update_id(id, |cached| {
			let result = cached.comp_mut().downcast_mut::<T>().map(update);
			let changed = result.is_some();
			(result, changed)
		})??;
		if presented {
			self.refresh_slot(slot, old_measure, old_rect);
		}
		self.apply_conds(true);
		Some(result)
	}

	/// Locates a named component, downcasts it to `T`, and applies `update`.
	/// If the component exists, matches `T`, and the closure returns `true`,
	/// this invalidates cached geometry and schedules a relayout/repaint.
	pub fn update_component<T: Component>(
		&mut self,
		id: &str,
		update: impl FnOnce(&mut T) -> bool,
	) -> bool {
		let Some((slot, old_measure, old_rect, presented)) = self.snapshot_id(id) else {
			return false;
		};
		let Some(changed) = self.root.update_id(id, |cached| {
			let changed = if let Some(comp) = cached.comp_mut().downcast_mut::<T>() {
				update(comp)
			} else {
				false
			};
			(changed, changed)
		}) else {
			return false;
		};
		if !changed {
			return false;
		}
		if presented {
			self.refresh_slot(slot, old_measure, old_rect);
		}
		self.apply_conds(true);
		true
	}

	/// Sets a named component's property and refreshes the smallest safe
	/// region. Size properties relayout the document; components with an
	/// `anim` property tween toward the new value from whatever is on
	/// screen. A matching value is a no-op. Returns `false` for an unknown
	/// id.
	///
	/// # Panics
	/// Panics when a textual value is invalid for `prop`, matching
	/// [`Props::set`].
	pub fn set_prop(&mut self, id: &str, prop: Prop, value: impl Into<PropValue>) -> bool {
		let Some((slot, old_measure, old_rect, presented)) = self.snapshot_id(id) else {
			return false;
		};
		let value = value.into();
		let changed = self
			.root
			.update(slot, |cached| {
				let before = cached.comp().props().get(prop);
				cached.comp_mut().props_mut().set(prop, value);
				let changed = cached.comp().props().get(prop) != before;
				(changed, changed)
			})
			.unwrap_or(false);
		if !changed {
			return true;
		}
		match prop {
			// A size target can move every following sibling.
			Prop::W | Prop::H => self.layout_all(),
			_ if presented => self.refresh_slot(slot, old_measure, old_rect),
			_ => {},
		}
		self.apply_conds(true);
		true
	}

	/// Shows or hides a named component and relayouts the document; a
	/// hidden component skips layout, paint, focus, and hit-testing.
	/// Prefer `when=` conditions for value-driven visibility — this is the
	/// imperative counterpart for hosts driving visibility from app state
	/// (a detail pane following a list cursor). Returns `false` for an
	/// unknown id.
	pub fn set_visible(&mut self, id: &str, visible: bool) -> bool {
		let Some(changed) = self.root.update_id(id, |cached| {
			let changed = cached.visible != visible;
			cached.visible = visible;
			(changed, changed)
		}) else {
			return false;
		};
		if changed {
			self.layout_all();
		}
		true
	}

	/// Advances the deterministic presentation clock and repaints every
	/// component whose wake deadline has passed.
	///
	/// [`crate::App`] drives this clock in production; tests and custom hosts
	/// can supply their own monotonic [`Duration`]. Returns whether anything
	/// repainted.
	pub fn tick(&mut self, now: Duration) -> bool {
		self.now = now;
		self.ctx.now = now;
		let mut due: SmallVec<Wake, 4> = SmallVec::new();
		self.wakes.retain(|&wake| {
			if wake.at <= now {
				due.push(wake);
				false
			} else {
				true
			}
		});
		for wake in &due {
			if wake.layout {
				self.relayout_slot(wake.slot);
			} else {
				self.repaint_slot(wake.slot);
			}
		}
		let mut repainted = !due.is_empty();
		for entry in &mut self.overlays {
			repainted |= entry.ui.tick(now);
		}
		repainted
	}

	/// Earliest pending animation deadline, if any component is animating.
	/// [`crate::App`] schedules it; custom hosts may do the same.
	pub fn next_wake(&self) -> Option<Duration> {
		let own = self.wakes.iter().map(|wake| wake.at).min();
		self
			.overlays
			.iter()
			.filter_map(|entry| entry.ui.next_wake())
			.chain(own)
			.min()
	}

	/// Refreshes a named component whose externally shared state changed.
	///
	/// The out-of-band companion to event routing: components that read
	/// application state through interior mutability cannot be reached by a
	/// key or mouse path, so the owner mutates the state and invalidates the
	/// component by id. Returns `false` for an unknown id.
	pub fn invalidate(&mut self, id: &str) -> bool {
		let Some((slot, old_measure, old_rect, presented)) = self.snapshot_id(id) else {
			return false;
		};
		if presented {
			self.refresh_slot(slot, old_measure, old_rect);
		}
		self.apply_conds(true);
		true
	}

	/// Installs a decoded image into the [`Img`] at `slot` and refreshes the
	/// smallest safe region.
	///
	/// Returns `false` when the slot is gone or does not contain an image.
	pub(crate) fn deliver_image(&mut self, slot: Slot, state: ImgState) -> bool {
		if self.root.find_slot(slot).is_none() {
			// The decoder pump is tree-agnostic: the slot may live in an overlay.
			for entry in &mut self.overlays {
				if entry.ui.root.find_slot(slot).is_some() {
					return entry.ui.deliver_image(slot, state);
				}
			}
			return false;
		}
		let Some((old_measure, old_rect)) = self
			.root
			.find_slot(slot)
			.map(|cached| (cached.measure(&self.ctx), cached.rect))
		else {
			return false;
		};
		let Some(delivered) = self.root.update(slot, |cached| {
			let Some(img) = cached.comp_mut().downcast_mut::<Img>() else {
				return (false, false);
			};
			img.apply_decoded(state);
			(true, true)
		}) else {
			return false;
		};
		if !delivered {
			return false;
		}
		self.refresh_slot(slot, old_measure, old_rect);
		self.apply_conds(true);
		true
	}

	/// Relayouts and repaints everything at a new width.
	pub fn resize(&mut self, width: u16) {
		self.width = width;
		self.root.invalidate();
		self.layout_all();
	}

	/// Forces this tree's root to a fixed height, relayouting when it
	/// changes.
	///
	/// Fill-height overlays are sized to their viewport band on every present.
	fn set_root_height(&mut self, rows: u16) {
		if self.root.comp().props().h() == Some(rows) {
			return;
		}
		self.root.comp_mut().props_mut().set(Prop::H, rows);
		self.root.invalidate();
		self.layout_all();
	}

	/// Sets a named component's fixed height.
	pub fn set_height(&mut self, id: &str, height: u16) -> bool {
		let Some(changed) = self.root.update_id(id, |cached| {
			if cached.comp().props().h() == Some(height) {
				return (false, false);
			}
			cached.comp_mut().props_mut().set(Prop::H, height);
			(true, true)
		}) else {
			return false;
		};
		if changed {
			// Changing the boundary itself can move following siblings.
			self.layout_all();
		}
		true
	}

	/// Resolves every overlay's viewport band for this present, sizing
	/// fill-height layers to the full available height.
	fn resolve_overlay_bands(&mut self, viewport: Size) {
		for entry in &mut self.overlays {
			if entry.hidden || !overlay::visible_at(&entry.options, viewport) {
				entry.band = OverlayBand { x: 0, y: 0, src_top: 0, rows: 0 };
				continue;
			}
			let extent = overlay::resolve_extent(&entry.options, viewport);
			if entry.ui.width != extent.width {
				entry.ui.resize(extent.width);
			}
			if entry.options.fill_height {
				entry.ui.set_root_height(extent.max_height);
			}
			entry.band =
				overlay::resolve_band(&entry.options, viewport, extent.width, entry.ui.height());
		}
	}

	/// Composes the retained component frame into one exactly-sized viewport.
	fn compose_viewport(&mut self, height: u16) -> u16 {
		let target = Size::new(self.width, height);
		if self.viewport_frame.size() == target {
			self.viewport_frame.clear(Style::default());
		} else {
			self.viewport_frame = Frame::new(target);
		}
		let source_top = self.frame.size().height.saturating_sub(height);
		let rows = self
			.frame
			.size()
			.height
			.saturating_sub(source_top)
			.min(height);
		self
			.viewport_frame
			.blit(&self.frame, source_top, rows, 0, 0);
		source_top
	}

	/// The composited layer stack in z order, one entry per placed band.
	/// The layer receiving keys carries the hardware cursor; passive panes
	/// let the base document's caret show through.
	fn resolved_layers(&self) -> SmallVec<ResolvedLayer<'_>, 4> {
		let active = self.top_overlay();
		self
			.overlays
			.iter()
			.filter(|entry| entry.band.rows > 0 && entry.visible(self.viewport))
			.map(|entry| ResolvedLayer {
				frame:   entry.ui.frame(),
				x:       entry.band.x,
				y:       entry.band.y,
				src_top: entry.band.src_top,
				rows:    entry.band.rows,
				active:  Some(entry.id) == active,
			})
			.collect()
	}

	/// Composes and presents exactly one fixed-height viewport, compositing
	/// every visible overlay above the retained component frame.
	///
	/// # Errors
	/// Propagates the renderer's contract and writer errors.
	pub fn present<W: io::Write>(
		&mut self,
		renderer: &mut Renderer<W>,
		viewport_height: u16,
	) -> io::Result<PaintStats> {
		renderer.set_graphics(self.ctx.graphics);
		let viewport = Size::new(self.width, viewport_height);
		self.viewport = Some(viewport);
		self.resolve_overlay_bands(viewport);
		let source_top = self.compose_viewport(viewport_height);
		let source_bottom = source_top.saturating_add(viewport_height);
		self.damage.sort_unstable();
		let mut merged: SmallVec<(u16, u16), 8> = SmallVec::new();
		for &(start, end) in &self.damage {
			let start = start.max(source_top);
			let end = end.min(source_bottom);
			if start >= end {
				continue;
			}
			let start = start - source_top;
			let end = end - source_top;
			match merged.last_mut() {
				Some(last) if start <= last.1 => last.1 = last.1.max(end),
				_ => merged.push((start, end)),
			}
		}
		let layers = self.resolved_layers();
		let stats =
			renderer.present_resolved(&self.viewport_frame, &merged, viewport_height, &layers)?;
		drop(layers);
		self.overlays_dirty = false;
		self.damage.clear();
		for entry in &mut self.overlays {
			entry.ui.damage.clear();
		}
		Ok(stats)
	}

	/// Fully repaints the composited viewport, emitting `prefix` first.
	///
	/// Alternate-screen transitions use this path so the mode switch and
	/// viewport paint share one synchronized terminal update.
	///
	/// # Errors
	/// Propagates the renderer's contract and writer errors.
	pub(crate) fn repaint<W: io::Write>(
		&mut self,
		renderer: &mut Renderer<W>,
		viewport_height: u16,
		prefix: &str,
	) -> io::Result<PaintStats> {
		renderer.set_graphics(self.ctx.graphics);
		let viewport = Size::new(self.width, viewport_height);
		self.viewport = Some(viewport);
		self.resolve_overlay_bands(viewport);
		self.compose_viewport(viewport_height);
		let frame = self.viewport_frame.clone();
		let layers = self.resolved_layers();
		let stats = renderer.repaint_resolved(prefix, frame, viewport_height, &layers)?;
		drop(layers);
		self.overlays_dirty = false;
		self.damage.clear();
		for entry in &mut self.overlays {
			entry.ui.damage.clear();
		}
		Ok(stats)
	}

	/// Routes a key to the layer holding the keyboard — the topmost visible
	/// modal overlay, else the non-modal layer focused through
	/// [`Ui::focus_overlay`] or a click — falling back to the base tree's
	/// focused component with focus-ring fallback.
	pub fn handle_key(&mut self, key: Key) -> UiEvent {
		self.handle_key_claimed(key).0
	}

	/// [`Ui::handle_key`] plus whether the key was claimed: consumed by a
	/// component, or spent moving focus. An unclaimed key routed through
	/// the tree untouched — pending damage from animations or unrelated
	/// components never counts as a claim.
	pub fn handle_key_claimed(&mut self, key: Key) -> (UiEvent, bool) {
		if let Some(index) = self.key_target() {
			let modal = self.overlays[index].options.modal;
			let had_focus = self.overlays[index].ui.focus.is_some();
			let (event, claimed) = self.overlays[index].ui.handle_key_claimed(key);
			if modal && event == UiEvent::None && !had_focus && matches!(key, Key::Esc) {
				// A focus-free overlay must still be dismissible.
				return (UiEvent::Cancel, true);
			}
			if !modal
				&& (event == UiEvent::Cancel
					|| (event == UiEvent::None && !had_focus && matches!(key, Key::Esc)))
			{
				// A non-modal layer hands the keyboard back instead of
				// dismissing: an unconsumed Esc (or a cancel surfacing from
				// inside it) blurs the layer and the base tree resumes.
				self.blur_overlay();
				return (UiEvent::None, true);
			}
			return (event, claimed);
		}
		self.set_keyboard(true);
		if let Some((slot, _)) = self.hover.take() {
			self.hover_repaint(slot);
		}
		let Some(focus) = self.focus else {
			self.move_focus(true);
			// Seeding the ring is a side effect: only navigation keys are
			// spent on it, anything else stays the host's to observe.
			return (UiEvent::None, Self::is_focus_nav(key));
		};
		let Some((flow, layout, old_measure, old_rect)) = self.key_component(focus, key) else {
			self.focus = None;
			self.move_focus(true);
			return (UiEvent::None, Self::is_focus_nav(key));
		};
		match flow {
			Flow::Consumed => {
				self.refresh_routed(focus, layout, old_measure, old_rect);
				(UiEvent::None, true)
			},
			// An event usually follows a state change (a select committing
			// or re-filtering), so the emitter repaints before surfacing it.
			Flow::Event(event) => {
				self.refresh_routed(focus, layout, old_measure, old_rect);
				(event, true)
			},
			Flow::Skip => {
				match key {
					Key::Tab | Key::Enter | Key::Right => self.move_focus(true),
					Key::BackTab | Key::Left => self.move_focus(false),
					Key::Down => self.move_focus_vertical(true),
					Key::Up => self.move_focus_vertical(false),
					Key::Esc => return (UiEvent::Cancel, false),
					_ => return (UiEvent::None, false),
				}
				(UiEvent::None, true)
			},
		}
	}

	/// Whether `key` drives focus-ring navigation when no component takes it.
	const fn is_focus_nav(key: Key) -> bool {
		matches!(
			key,
			Key::Tab | Key::BackTab | Key::Enter | Key::Left | Key::Right | Key::Up | Key::Down
		)
	}

	/// Routes sanitized paste text to the focused component; the returned
	/// event mirrors [`Ui::handle_key`].
	pub fn handle_paste(&mut self, text: &str) -> UiEvent {
		self.route_paste(text, false)
	}

	/// Routes paste text for verbatim insertion ([`Component::paste_raw`]):
	/// no drop classification, no large-paste collapse. Backs the
	/// Ctrl+Shift+V clipboard fallback.
	pub fn handle_paste_raw(&mut self, text: &str) -> UiEvent {
		self.route_paste(text, true)
	}

	fn route_paste(&mut self, text: &str, raw: bool) -> UiEvent {
		if let Some(index) = self.key_target() {
			return self.overlays[index].ui.route_paste(text, raw);
		}
		self.set_keyboard(true);
		let Some(focus) = self.focus else {
			return UiEvent::None;
		};
		let ctx = &self.ctx;
		let Some((flow, layout, old_measure, old_rect)) = self.root.update(focus, |cached| {
			let old_measure = cached.measure(ctx);
			let old_rect = cached.rect;
			let (width, view_rows) = event_size(cached);
			let mut ec = EventCtx::new(ctx, width, view_rows);
			let component = cached.comp_mut();
			let flow = if raw {
				component.paste_raw(&mut ec, text)
			} else {
				component.paste(&mut ec, text)
			};
			let dirty = !matches!(flow, Flow::Skip);
			((flow, ec.layout, old_measure, old_rect), dirty)
		}) else {
			return UiEvent::None;
		};
		match flow {
			Flow::Skip => UiEvent::None,
			Flow::Consumed => {
				self.refresh_routed(focus, layout, old_measure, old_rect);
				UiEvent::None
			},
			Flow::Event(event) => {
				self.refresh_routed(focus, layout, old_measure, old_rect);
				event
			},
		}
	}

	/// Refreshes after one routed, consumed event: an explicit layout
	/// request from the handler relayouts everything (its geometry changed
	/// outside its own subtree through shared state), otherwise the smallest
	/// safe region around the target refreshes.
	fn refresh_routed(&mut self, slot: Slot, layout: bool, old_measure: (u16, u16), old_rect: Rect) {
		if layout {
			self.layout_all();
		} else {
			self.refresh_slot(slot, old_measure, old_rect);
		}
		self.apply_conds(true);
	}

	/// Moves focus to the first focusable component when nothing is focused
	/// yet, activating keyboard chrome.
	///
	/// The entry half of a raw-frame layer host's keyboard hand-off;
	/// [`Ui::blur`] is the exit half. Retained stacks get both through
	/// [`Ui::focus_overlay`] and [`Ui::blur_overlay`].
	pub fn focus_first(&mut self) {
		self.set_keyboard(true);
		if self.focus.is_none() {
			self.move_focus(true);
		}
	}

	/// Stable id of the component that currently owns keyboard focus.
	#[must_use]
	pub fn focused_id(&self) -> Option<Str> {
		let slot = self.focus?;
		find_slot_ref(&self.root, slot)
			.and_then(|cached| cached.comp().props().id())
			.map(Str::new)
	}

	/// Stable id of the topmost press target at one painted coordinate.
	///
	/// Drag owners use this to inspect the current drop target while the
	/// keyboard focus and routed mouse capture correctly remain on the
	/// component where the press began.
	#[must_use]
	pub fn id_at(&self, x: u16, y: u16) -> Option<Str> {
		let source_y = y.saturating_add(
			self
				.viewport
				.map_or(0, |viewport| self.frame.size().height.saturating_sub(viewport.height)),
		);
		let hit = self.hit_at(x, source_y, false)?;
		find_slot_ref(&self.root, hit.slot)
			.and_then(|cached| cached.comp().props().id())
			.map(Str::new)
	}

	/// Returns the laid-out document rectangle of a named component.
	///
	/// Pointer-driven hosts use this to map coordinates onto semantic rows
	/// whose focus container intentionally emits no press event.
	pub fn rect(&mut self, id: &str) -> Option<Rect> {
		self.snapshot_id(id).map(|(_, _, rect, _)| rect)
	}

	/// Moves keyboard focus to the named component when it is visible and
	/// focusable, activating keyboard chrome. Returns whether focus moved.
	pub fn focus_id(&mut self, id: &str) -> bool {
		let Some((slot, ..)) = self.snapshot_id(id) else {
			return false;
		};
		if !self.focus_ring().contains(&slot) {
			return false;
		}
		self.set_keyboard(true);
		self.assign_focus(Some(slot), true);
		true
	}

	/// Clears this tree's focus, removing focus chrome and the caret.
	///
	/// Raw-frame layer hosts call this when the keyboard returns to the
	/// document, so no stale chrome suggests typing still lands here.
	pub fn blur(&mut self) {
		self.clear_hover();
		self.assign_focus(None, true);
	}

	/// Routes a mouse gesture in viewport cell coordinates; visible overlays
	/// occlude the base tree within their bounds.
	pub fn handle_mouse(&mut self, x: u16, y: u16, mouse: Mouse) -> UiEvent {
		self.handle_mouse_with_mods(x, y, mouse, Mods::default())
	}

	/// Routes a mouse gesture with its terminal modifier bits.
	pub fn handle_mouse_with_mods(&mut self, x: u16, y: u16, mouse: Mouse, mods: Mods) -> UiEvent {
		self.mouse_mods = mods;
		for entry in &mut self.overlays {
			entry.ui.mouse_mods = mods;
		}
		if let Some(event) = self.route_overlay_mouse(x, y, mouse) {
			return event;
		}
		let source_y = y.saturating_add(
			self
				.viewport
				.map_or(0, |viewport| self.frame.size().height.saturating_sub(viewport.height)),
		);
		self.handle_mouse_document(x, source_y, mouse)
	}

	/// Routes a mouse gesture whose coordinates are already in frame space.
	fn handle_mouse_document(&mut self, x: u16, y: u16, mouse: Mouse) -> UiEvent {
		self.pointer = Some((x, y));
		self.set_keyboard(false);
		match mouse {
			Mouse::Move => {
				self.update_hover(x, y);
				UiEvent::None
			},
			Mouse::Drag => {
				self.update_hover(x, y);
				let hit = self
					.drag_hit()
					.or_else(|| self.hit_at(x, y, false).or_else(|| self.hit_at(x, y, true)));
				let Some(hit) = hit else {
					return UiEvent::None;
				};
				self.drag = Some(hit);
				self.mouse_component(hit, (x, y), mouse).0
			},
			Mouse::Release => {
				self.update_hover(x, y);
				let hit = self
					.drag_hit()
					.or_else(|| self.hit_at(x, y, false).or_else(|| self.hit_at(x, y, true)));
				self.drag = None;
				hit.map_or(UiEvent::None, |hit| self.mouse_component(hit, (x, y), mouse).0)
			},
			Mouse::Click => {
				// A click is proof of the pointer's position even without a
				// preceding motion report: the chrome cursor follows it.
				self.update_hover(x, y);
				let Some(hit) = self.hit_at(x, y, false) else {
					self.drag = None;
					return UiEvent::None;
				};
				self.drag = Some(hit);
				if self.focus_ring().contains(&hit.slot) {
					self.assign_focus(Some(hit.slot), true);
				}
				self.mouse_component(hit, (x, y), mouse).0
			},
			Mouse::RightClick | Mouse::MiddleClick => {
				self.update_hover(x, y);
				let Some(hit) = self.hit_at(x, y, false).or_else(|| self.hit_at(x, y, true)) else {
					self.drag = None;
					return UiEvent::None;
				};
				self.drag = Some(hit);
				self.mouse_component(hit, (x, y), mouse).0
			},
			Mouse::WheelUp | Mouse::WheelDown | Mouse::WheelLeft | Mouse::WheelRight => {
				for wheel_zone in [true, false] {
					let Some(hit) = self.hit_at(x, y, wheel_zone) else {
						continue;
					};
					let (event, consumed) = self.mouse_component(hit, (x, y), mouse);
					if event != UiEvent::None {
						return event;
					}
					if consumed {
						return UiEvent::None;
					}
				}
				UiEvent::None
			},
		}
	}

	/// Routes a viewport-coordinate mouse gesture into this tree when it is
	/// composited as a raw [`crate::Layer`] under `options` — the raw-frame
	/// host counterpart of the overlay stack's own routing with raw layers
	/// instead of [`Ui::show_overlay`]. The band is resolved exactly as the
	/// compositor resolves it, coordinates are translated into this tree's
	/// local cells, and a drag that started inside stays captured. `None`
	/// means the gesture fell outside the layer (a `Move` outside also
	/// clears hover chrome).
	pub fn handle_mouse_as_layer(
		&mut self,
		options: &OverlayOptions,
		viewport: Size,
		x: u16,
		y: u16,
		mouse: Mouse,
	) -> Option<UiEvent> {
		if !overlay::visible_at(options, viewport) {
			if matches!(mouse, Mouse::Move) {
				self.clear_hover();
			}
			return None;
		}
		let extent = overlay::resolve_extent(options, viewport);
		if self.width != extent.width {
			self.resize(extent.width);
		}
		let band = overlay::resolve_band(options, viewport, extent.width, self.height());
		let captured = self.drag.is_some() && matches!(mouse, Mouse::Drag | Mouse::Release);
		let inside = band.rows > 0
			&& x >= band.x
			&& x < band.x.saturating_add(self.width)
			&& y >= band.y
			&& y < band.y.saturating_add(band.rows);
		if !inside && !captured {
			if matches!(mouse, Mouse::Move) {
				self.clear_hover();
			}
			return None;
		}
		let local_x = x.saturating_sub(band.x);
		let local_y = y.saturating_sub(band.y).saturating_add(band.src_top);
		Some(self.handle_mouse_document(local_x, local_y, mouse))
	}

	/// Records which modality drove the last input, repainting the focused
	/// component's decorated scope when ownership of the chrome flips.
	fn set_keyboard(&mut self, keyboard: bool) {
		if self.keyboard == keyboard {
			return;
		}
		self.keyboard = keyboard;
		if let Some(focus) = self.focus {
			self.hover_repaint(focus);
		}
	}

	/// Collects values from every visible component of the base tree and
	/// every visible overlay layer; higher layers win on id collisions.
	/// Scope to a single layer through [`Ui::overlay`].
	pub fn values(&self) -> Value {
		let mut values = serde_json::Map::new();
		collect_values(&self.root, &mut values);
		for entry in &self.overlays {
			if !entry.hidden {
				collect_values(&entry.ui.root, &mut values);
			}
		}
		Value::Object(values)
	}

	/// Component-tree snapshot for the `OMP_TUI_DEBUG` protocol: per node the
	/// component kind, optional `id`, outer rectangle, visibility, and focus,
	/// plus every overlay layer with its resolved band.
	pub(crate) fn debug_tree(&self) -> Value {
		let mut root = serde_json::Map::new();
		root.insert("root".into(), debug_node(&self.root, self.focus));
		let overlays: Vec<Value> = self
			.overlays
			.iter()
			.map(|entry| {
				let mut layer = serde_json::Map::new();
				layer.insert("overlay".into(), Value::from(entry.id.0));
				layer.insert("hidden".into(), Value::from(entry.hidden));
				layer.insert(
					"band".into(),
					Value::from(vec![
						i64::from(entry.band.x),
						i64::from(entry.band.y),
						i64::from(entry.band.rows),
					]),
				);
				layer.insert("root".into(), debug_node(&entry.ui.root, entry.ui.focus));
				Value::Object(layer)
			})
			.collect();
		if !overlays.is_empty() {
			root.insert("overlays".into(), Value::from(overlays));
		}
		Value::Object(root)
	}

	/// Stacks an overlay tree above the document.
	///
	/// The overlay is its own retained [`Ui`]: address it through
	/// [`Ui::overlay`] / [`Ui::overlay_mut`] for `set_text`, `values`, and
	/// friends. Placement follows `options` against the viewport of each
	/// [`Ui::present`]; the layer composites above the document and never
	/// enters native terminal scrollback. Explicit z orders layers regardless
	/// of creation order; later overlays stack on top among equal z. The
	/// topmost visible modal overlay receives every key and paste until
	/// closed or hidden; a non-modal layer ([`OverlayOptions::non_modal`])
	/// leaves the keyboard with the base tree until focused through
	/// [`Ui::focus_overlay`] or a click inside its band.
	///
	/// # Panics
	/// Panics when called on an overlay's own tree: overlays stack on the
	/// presenting `Ui`.
	pub fn show_overlay(&mut self, root: impl IntoComponent, options: OverlayOptions) -> OverlayId {
		assert!(!self.nested, "overlays stack on the presenting Ui, not on an overlay tree");
		let provisional = self.viewport.unwrap_or_else(|| Size::new(self.width, 1));
		let width = overlay::resolve_extent(&options, provisional).width;
		let mut ui = Self::from_root(root, width, self.ctx.clone());
		ui.nested = true;
		if !options.modal {
			// A pane starts without the keyboard: no focus chrome or frame
			// cursor until it takes it through focus or a click.
			ui.blur();
		}
		let id = OverlayId(self.next_overlay);
		self.next_overlay += 1;
		let z = options.z;
		let at = self
			.overlays
			.iter()
			.rposition(|entry| entry.options.z <= z)
			.map_or(0, |index| index + 1);
		self.overlays.insert(at, OverlayEntry {
			id,
			ui: Box::new(ui),
			options,
			band: OverlayBand { x: 0, y: 0, src_top: 0, rows: 0 },
			hidden: false,
		});
		self.overlays_dirty = true;
		id
	}

	/// Removes an overlay; the next present repaints the document beneath it.
	///
	/// Returns `false` for an unknown id.
	pub fn close_overlay(&mut self, id: OverlayId) -> bool {
		let before = self.overlays.len();
		self.overlays.retain(|entry| entry.id != id);
		let closed = self.overlays.len() != before;
		if closed && self.key_overlay == Some(id) {
			self.key_overlay = None;
		}
		self.overlays_dirty |= closed;
		closed
	}

	/// Removes the topmost layer (highest z, most recent among ties), if any.
	///
	/// This pops the stack regardless of modality; for dismissing the layer
	/// that emitted a [`UiEvent::Cancel`], use [`Ui::close_active_overlay`] —
	/// the stack top may be a non-modal pane sitting above the modal that
	/// routed the key.
	pub fn close_top_overlay(&mut self) -> Option<OverlayId> {
		let entry = self.overlays.pop()?;
		if self.key_overlay == Some(entry.id) {
			self.key_overlay = None;
		}
		self.overlays_dirty = true;
		Some(entry.id)
	}

	/// Closes the layer currently receiving keys — the topmost visible
	/// modal overlay, else the focused non-modal pane — returning its id.
	///
	/// The manual-host counterpart of the [`crate::App`] cancel policy:
	/// after a [`UiEvent::Cancel`] surfaces from the overlay stack, this
	/// dismisses the layer that emitted it, even when a higher-z non-modal
	/// pane stacks above it.
	pub fn close_active_overlay(&mut self) -> Option<OverlayId> {
		let id = self.top_overlay()?;
		self.close_overlay(id);
		Some(id)
	}

	/// Temporarily hides or reshows an overlay without discarding its state.
	///
	/// Hiding the layer holding the keyboard returns keys to the base tree.
	/// Returns `false` for an unknown id.
	pub fn set_overlay_hidden(&mut self, id: OverlayId, hidden: bool) -> bool {
		let Some(entry) = self.overlays.iter_mut().find(|entry| entry.id == id) else {
			return false;
		};
		if entry.hidden != hidden {
			entry.hidden = hidden;
			self.overlays_dirty = true;
		}
		if hidden && self.key_overlay == Some(id) {
			self.blur_overlay();
		}
		true
	}

	/// Whether an overlay is temporarily hidden; `None` for an unknown id.
	pub fn overlay_hidden(&self, id: OverlayId) -> Option<bool> {
		self
			.overlays
			.iter()
			.find(|entry| entry.id == id)
			.map(|entry| entry.hidden)
	}

	/// Borrows an overlay's retained tree.
	pub fn overlay(&self, id: OverlayId) -> Option<&Self> {
		self
			.overlays
			.iter()
			.find(|entry| entry.id == id)
			.map(|entry| &*entry.ui)
	}

	/// Mutably borrows an overlay's retained tree for `set_text` and friends.
	pub fn overlay_mut(&mut self, id: OverlayId) -> Option<&mut Self> {
		self
			.overlays
			.iter_mut()
			.find(|entry| entry.id == id)
			.map(|entry| &mut *entry.ui)
	}

	/// Whether any modal overlay is currently visible (not hidden or gated).
	///
	/// While one is, [`crate::App`] holds the terminal's alternate screen
	/// (vim/less idiom): the whole composited viewport paints there with
	/// mouse tracking active, and the main screen is fully repainted when
	/// the last visible modal overlay closes. Non-modal layers composite
	/// directly into the live viewport.
	pub fn has_overlay(&self) -> bool {
		self
			.overlays
			.iter()
			.any(|entry| entry.options.modal && entry.visible(self.viewport))
	}

	/// Identity of the layer receiving keys — the topmost visible modal
	/// overlay, else the focused non-modal layer.
	pub fn top_overlay(&self) -> Option<OverlayId> {
		self.key_target().map(|index| self.overlays[index].id)
	}

	/// Directs keys and paste to a layer until it is blurred, closed, or
	/// hidden, or a modal overlay opens above it.
	///
	/// The layer's focus ring activates so its chrome shows where typing
	/// lands. Intended for non-modal layers — a modal overlay already
	/// captures the keyboard while topmost. Returns `false` for an unknown
	/// id.
	pub fn focus_overlay(&mut self, id: OverlayId) -> bool {
		let Some(entry) = self.overlays.iter_mut().find(|entry| entry.id == id) else {
			return false;
		};
		entry.ui.focus_first();
		self.key_overlay = Some(id);
		true
	}

	/// Returns the keyboard to the base tree, clearing the previously
	/// focused layer's own focus so no stale chrome (or hardware caret)
	/// suggests typing still lands there. Returns the layer that had key
	/// focus.
	pub fn blur_overlay(&mut self) -> Option<OverlayId> {
		let id = self.key_overlay.take()?;
		if let Some(entry) = self.overlays.iter_mut().find(|entry| entry.id == id) {
			entry.ui.blur();
		}
		Some(id)
	}

	/// The non-modal layer holding the keyboard through
	/// [`Ui::focus_overlay`] or a click, if any.
	pub const fn focused_overlay(&self) -> Option<OverlayId> {
		self.key_overlay
	}

	/// The layer receiving keys: the topmost visible modal overlay wins,
	/// else the explicitly focused layer while visible.
	fn key_target(&self) -> Option<usize> {
		self
			.overlays
			.iter()
			.rposition(|entry| entry.options.modal && entry.visible(self.viewport))
			.or_else(|| {
				let id = self.key_overlay?;
				self
					.overlays
					.iter()
					.position(|entry| entry.id == id && entry.visible(self.viewport))
			})
	}

	fn overlay_contains(&self, index: usize, x: u16, y: u16) -> bool {
		let entry = &self.overlays[index];
		entry.band.rows > 0
			&& x >= entry.band.x
			&& x < entry.band.x.saturating_add(entry.ui.width)
			&& y >= entry.band.y
			&& y < entry.band.y.saturating_add(entry.band.rows)
	}

	/// Maps document coordinates into an overlay's local cell space.
	fn overlay_local(&self, index: usize, x: u16, y: u16) -> (u16, u16) {
		let band = self.overlays[index].band;
		(x.saturating_sub(band.x), y.saturating_sub(band.y).saturating_add(band.src_top))
	}

	/// Routes a mouse gesture to the overlay stack; `None` falls through to
	/// the base tree (the pointer is outside every visible layer).
	fn route_overlay_mouse(&mut self, x: u16, y: u16, mouse: Mouse) -> Option<UiEvent> {
		if self.overlays.is_empty() {
			return None;
		}
		if matches!(mouse, Mouse::Drag | Mouse::Release)
			&& let Some(index) = self
				.overlays
				.iter()
				.position(|entry| entry.ui.drag.is_some())
		{
			// A drag that started inside an overlay stays captured by it.
			let (local_x, local_y) = self.overlay_local(index, x, y);
			return Some(
				self.overlays[index]
					.ui
					.handle_mouse_document(local_x, local_y, mouse),
			);
		}
		let target = (0..self.overlays.len())
			.rev()
			.filter(|&index| self.overlays[index].visible(self.viewport))
			.find(|&index| self.overlay_contains(index, x, y));
		if matches!(mouse, Mouse::Move) {
			// The pointer rests on one layer at most; stale highlights clear.
			if target.is_some() {
				self.clear_hover();
			}
			for index in 0..self.overlays.len() {
				if Some(index) != target {
					self.overlays[index].ui.clear_hover();
				}
			}
		}
		if matches!(mouse, Mouse::Click | Mouse::RightClick | Mouse::MiddleClick) {
			// Clicks move the keyboard between panes: into a non-modal
			// layer, back to the base tree when landing outside every layer.
			match target {
				Some(index) if !self.overlays[index].options.modal => {
					self.key_overlay = Some(self.overlays[index].id);
				},
				None => {
					self.blur_overlay();
				},
				Some(_) => {},
			}
		}
		let index = target?;
		let (local_x, local_y) = self.overlay_local(index, x, y);
		Some(
			self.overlays[index]
				.ui
				.handle_mouse_document(local_x, local_y, mouse),
		)
	}

	/// Current focus slot, exposed for the in-crate acceptance suite.
	#[cfg(test)]
	pub(crate) const fn focus_slot(&self) -> Option<Slot> {
		self.focus
	}

	/// Assigns focus with the same enter and repaint bookkeeping as ring
	/// navigation.
	#[cfg(test)]
	pub(crate) fn set_focus_slot(&mut self, focus: Option<Slot>) {
		self.clear_hover();
		self.assign_focus(focus, true);
	}

	/// Current hover slot, exposed for the in-crate acceptance suite.
	#[cfg(test)]
	pub(crate) fn hover_slot(&self) -> Option<Slot> {
		self.hover.map(|(slot, _)| slot)
	}

	/// Paint-collected hit regions, exposed for the in-crate acceptance suite.
	#[cfg(test)]
	pub(crate) fn hits(&self) -> &[Hit] {
		&self.hits
	}

	/// Computed visible focus ring.
	pub(crate) fn focus_ring(&self) -> Vec<Slot> {
		let mut ring = Vec::new();
		if self.root.visible {
			self.root.comp().ring(&mut ring);
		}
		ring
	}

	/// Read-only view of the retained root component cache.
	///
	/// Hosts and test harnesses use this to inspect the mounted component
	/// tree; mutation stays inside the retained update path.
	pub const fn root(&self) -> &Cached {
		&self.root
	}

	/// Mutable root component cache, exposed for the in-crate acceptance suite.
	#[cfg(test)]
	pub(crate) const fn root_mut(&mut self) -> &mut Cached {
		&mut self.root
	}

	fn key_component(&mut self, slot: Slot, key: Key) -> Option<(Flow, bool, (u16, u16), Rect)> {
		let ctx = &self.ctx;
		self.root.update(slot, |cached| {
			let old_measure = cached.measure(ctx);
			let old_rect = cached.rect;
			let (width, view_rows) = event_size(cached);
			let mut ec = EventCtx::new(ctx, width, view_rows);
			let flow = cached.comp_mut().key(&mut ec, key);
			let dirty = matches!(flow, Flow::Consumed);
			((flow, ec.layout, old_measure, old_rect), dirty)
		})
	}

	fn drag_hit(&self) -> Option<Hit> {
		let target = self.drag?;
		self
			.hits
			.iter()
			.rev()
			.find(|hit| hit.slot == target.slot && hit.tag == target.tag)
			.copied()
			.or(Some(target))
	}

	fn update_hover(&mut self, x: u16, y: u16) {
		let target = self.hit_at(x, y, false).map(|hit| (hit.slot, hit.tag));
		let previous = self.hover;
		if previous == target {
			return;
		}
		self.hover = target;
		let left = previous.map(|(slot, _)| self.hover_scope(slot));
		let entered = target.map(|(slot, _)| self.hover_scope(slot));
		if let Some(slot) = left {
			self.repaint_slot(slot);
		}
		if let Some(slot) = entered.filter(|slot| left != Some(*slot)) {
			self.repaint_slot(slot);
		}
	}

	/// Repaints the component that visually owns a hover change: the
	/// outermost hover-decorated ancestor when one exists (its chrome and
	/// elevation react to descendants), else the component itself.
	fn hover_repaint(&mut self, slot: Slot) {
		let scope = self.hover_scope(slot);
		self.repaint_slot(scope);
	}

	fn hover_scope(&self, slot: Slot) -> Slot {
		path_to_slot(&self.root, slot).map_or(slot, |path| {
			path
				.iter()
				.find(|entry| {
					find_slot_ref(&self.root, entry.slot)
						.is_some_and(|cached| cached.comp().props().hover_decorated())
				})
				.map_or(slot, |entry| entry.slot)
		})
	}

	fn mouse_component(&mut self, hit: Hit, at: (u16, u16), mouse: Mouse) -> (UiEvent, bool) {
		let ctx = &self.ctx;
		let Some((flow, layout, old_measure, old_rect)) = self.root.update(hit.slot, |cached| {
			let old_measure = cached.measure(ctx);
			let old_rect = cached.rect;
			let (width, view_rows) = event_size(cached);
			let mut ec = EventCtx::with_mods(ctx, width, view_rows, self.mouse_mods);
			let flow = cached
				.comp_mut()
				.mouse(&mut ec, hit.tag, at, hit.rect, mouse);
			let dirty = matches!(flow, Flow::Consumed);
			((flow, ec.layout, old_measure, old_rect), dirty)
		}) else {
			return (UiEvent::None, false);
		};
		match flow {
			Flow::Skip => (UiEvent::None, false),
			Flow::Event(event) => {
				// Mirror the key path: the emitter repaints its state
				// change before the event surfaces.
				self.refresh_routed(hit.slot, layout, old_measure, old_rect);
				(event, true)
			},
			Flow::Consumed => {
				self.refresh_routed(hit.slot, layout, old_measure, old_rect);
				(UiEvent::None, true)
			},
		}
	}

	fn move_focus(&mut self, forward: bool) {
		let ring = self.focus_ring();
		if ring.is_empty() {
			self.assign_focus(None, forward);
			return;
		}
		let next = match self
			.focus
			.and_then(|slot| ring.iter().position(|item| *item == slot))
		{
			Some(index) if forward => ring[(index + 1) % ring.len()],
			Some(index) => ring[(index + ring.len() - 1) % ring.len()],
			None if forward => ring[0],
			None => ring[ring.len() - 1],
		};
		self.assign_focus(Some(next), forward);
	}

	/// Moves focus to the nearest focusable strictly below (or above) the
	/// current one — the row-aware complement to ring order that makes
	/// Up/Down walk wrapped grids column-wise. Candidates are compared in
	/// their paint owner's coordinate space, so only siblings placed by the
	/// same scroll (or the root) are spatially comparable; without a
	/// vertical neighbor the move falls back to ring order, preserving
	/// plain stacked navigation and cross-owner hops.
	fn move_focus_vertical(&mut self, down: bool) {
		let Some((focus, (anchor_owner, anchor))) = self
			.focus
			.and_then(|slot| Some((slot, self.spatial_anchor(slot)?)))
		else {
			self.move_focus(down);
			return;
		};
		// Center coordinates ×2 keep the comparison in exact integers.
		let center = |rect: Rect| {
			(
				i32::from(rect.x) * 2 + i32::from(rect.width),
				i32::from(rect.y) * 2 + i32::from(rect.height),
			)
		};
		let (anchor_x, anchor_y) = center(anchor);
		let mut best: Option<(Slot, u32, u32)> = None;
		for slot in self.focus_ring() {
			if slot == focus {
				continue;
			}
			let Some((owner, rect)) = self.spatial_anchor(slot) else {
				continue;
			};
			if owner != anchor_owner {
				continue;
			}
			let (x, y) = center(rect);
			let dy = y - anchor_y;
			if if down { dy <= 0 } else { dy >= 0 } {
				continue;
			}
			let key = (dy.unsigned_abs(), (x - anchor_x).unsigned_abs());
			if best.is_none_or(|(_, dy, dx)| key < (dy, dx)) {
				best = Some((slot, key.0, key.1));
			}
		}
		match best {
			Some((slot, ..)) => self.assign_focus(Some(slot), down),
			None => self.move_focus(down),
		}
	}

	/// A slot's placed rectangle plus the paint owner whose coordinate
	/// space it lives in; rectangles are only comparable within one owner.
	fn spatial_anchor(&self, slot: Slot) -> Option<(Option<Slot>, Rect)> {
		let path = path_to_slot(&self.root, slot)?;
		let (target, ancestors) = path.split_last()?;
		let owner = ancestors
			.iter()
			.rev()
			.find(|entry| entry.paint_owner)
			.map(|entry| entry.slot);
		Some((owner, target.rect))
	}

	fn assign_focus(&mut self, next: Option<Slot>, forward: bool) {
		if self.focus == next {
			return;
		}
		let previous = self.focus;
		self.focus = next;
		if let Some(slot) = next {
			let _ = self.root.update(slot, |cached| {
				cached.comp_mut().enter(forward);
				((), false)
			});
		}
		if let Some(slot) = next {
			self.chase_scrolls(slot);
		}
		if let Some(slot) = previous {
			self.repaint_slot(slot);
		}
		if let Some(slot) = next {
			self.repaint_slot(slot);
		}
	}

	fn chase_scrolls(&mut self, slot: Slot) {
		let Some(path) = path_to_slot(&self.root, slot) else {
			return;
		};
		for (index, entry) in path.iter().enumerate() {
			if !entry.paint_owner
				|| find_slot_ref(&self.root, entry.slot)
					.is_none_or(|cached| !cached.comp().is::<Scroll>())
			{
				continue;
			}
			// Chase the deepest path entry still placed in this scroll's
			// coordinate space: descendants of a nested paint owner live in
			// that owner's own scratch frame, but the owner itself is ours.
			let scope = &path[index + 1..];
			let end = scope
				.iter()
				.position(|entry| entry.paint_owner)
				.map_or(scope.len(), |position| position + 1);
			let Some(descendant) = scope[..end].last().map(|entry| entry.rect) else {
				continue;
			};
			let scroll_slot = entry.slot;
			let _ = self.root.update(scroll_slot, |cached| {
				let view_rows = event_size(cached).1;
				let changed = cached
					.comp_mut()
					.downcast_mut::<Scroll>()
					.expect("scroll path entry changed type")
					.chase(descendant, view_rows);
				(changed, changed)
			});
		}
	}

	fn clear_hover(&mut self) {
		if let Some((slot, _)) = self.hover.take() {
			self.hover_repaint(slot);
		}
	}

	fn hit_at(&self, x: u16, y: u16, wheel_zone: bool) -> Option<Hit> {
		self
			.hits
			.iter()
			.rev()
			.find(|hit| {
				(hit.tag == HitTag::Wheel) == wheel_zone
					&& x >= hit.rect.x
					&& x < hit.rect.x.saturating_add(hit.rect.width)
					&& y >= hit.rect.y
					&& y < hit.rect.y.saturating_add(hit.rect.height)
			})
			.copied()
	}

	fn snapshot_id(&mut self, id: &str) -> Option<(Slot, (u16, u16), Rect, bool)> {
		let path = path_to_id(&self.root, id)?;
		let slot = path.last()?.slot;
		let presented = path.iter().all(|entry| entry.visible);
		let cached = self.root.find_slot(slot)?;
		let measure = cached.measure(&self.ctx);
		Some((slot, measure, cached.rect, presented))
	}

	/// Handles a due layout wake: an animated size moved, so the smallest
	/// safe region must re-measure and re-place, not just repaint.
	fn relayout_slot(&mut self, slot: Slot) {
		let Some(path) = path_to_slot(&self.root, slot) else {
			return;
		};
		if path.iter().any(|entry| !entry.visible) {
			return;
		}
		let Some(cached) = self.root.find_slot(slot) else {
			return;
		};
		let old_measure = cached.measure(&self.ctx);
		let old_rect = cached.rect;
		// Geometry memos along the ancestor path cached the previous sample.
		let _ = self.root.update(slot, |_| ((), true));

		// An animated width moves siblings without moving this component's
		// measure, so the nearest row must re-solve unconditionally — row
		// layout consumes `w` directly.
		if let Some(row) = path.iter().rev().skip(1).find(|entry| entry.row).copied() {
			if let Some(row_cached) = self.root.find_slot(row.slot) {
				let height = row_cached.height(&self.ctx, row.rect.width);
				if height == row.rect.height {
					row_cached
						.place(&self.ctx, Rect::new(row.rect.x, row.rect.y, row.rect.width, height));
					self.repaint_slot(row.slot);
					return;
				}
			}
			self.relayout_above(&path, row.slot);
			return;
		}
		self.refresh_slot(slot, old_measure, old_rect);
	}

	fn refresh_slot(&mut self, slot: Slot, old_measure: (u16, u16), old_rect: Rect) {
		let Some(path) = path_to_slot(&self.root, slot) else {
			return;
		};
		if path.iter().any(|entry| !entry.visible) {
			return;
		}
		let Some(cached) = self.root.find_slot(slot) else {
			return;
		};
		let new_measure = cached.measure(&self.ctx);
		let new_height = cached.height(&self.ctx, old_rect.width);
		let x_dirty = new_measure != old_measure;

		if x_dirty && let Some(row) = path.iter().rev().skip(1).find(|entry| entry.row).copied() {
			let Some(cached) = self.root.find_slot(row.slot) else {
				return;
			};
			let height = cached.height(&self.ctx, row.rect.width);
			if height == row.rect.height {
				cached.place(&self.ctx, Rect::new(row.rect.x, row.rect.y, row.rect.width, height));
				self.repaint_slot(row.slot);
			} else {
				self.relayout_above(&path, row.slot);
			}
			return;
		}

		if new_height == old_rect.height {
			let Some(cached) = self.root.find_slot(slot) else {
				return;
			};
			cached.place(&self.ctx, Rect::new(old_rect.x, old_rect.y, old_rect.width, new_height));
			self.repaint_slot(slot);
		} else {
			self.relayout_above(&path, slot);
		}
	}

	fn relayout_above(&mut self, path: &[PathEntry], changed: Slot) {
		let changed_at = path
			.iter()
			.position(|entry| entry.slot == changed)
			.unwrap_or(path.len());
		let boundary = path[..changed_at]
			.iter()
			.rev()
			.find(|entry| entry.fixed)
			.copied();
		match boundary {
			Some(boundary) => self.relayout_fixed(boundary),
			None => self.layout_all(),
		}
	}

	fn relayout_fixed(&mut self, boundary: PathEntry) {
		let height = {
			let Some(cached) = self.root.find_slot(boundary.slot) else {
				return;
			};
			cached.height(&self.ctx, boundary.rect.width)
		};
		if height != boundary.rect.height {
			self.layout_all();
			return;
		}
		if let Some(cached) = self.root.find_slot(boundary.slot) {
			cached.place(&self.ctx, boundary.rect);
		}
		self.repaint_slot(boundary.slot);
	}

	pub(crate) fn repaint_slot(&mut self, slot: Slot) {
		let Some(original_path) = path_to_slot(&self.root, slot) else {
			return;
		};
		let slot = original_path
			.iter()
			.find(|entry| {
				entry.paint_owner
					|| find_slot_ref(&self.root, entry.slot).is_some_and(|cached| {
						let props = cached.comp().props();
						props.gradient_of(Prop::Fg).is_some()
							|| props.gradient_of(Prop::Bg).is_some()
							|| props.gradient_of(Prop::On).is_some()
					})
			})
			.map_or(slot, |entry| entry.slot);
		let path = if original_path.last().is_some_and(|entry| entry.slot == slot) {
			original_path
		} else {
			path_to_slot(&self.root, slot).expect("scroll owner is on the component path")
		};
		if path.iter().any(|entry| !entry.visible) {
			return;
		}
		if let Some(cached) = find_slot_ref(&self.root, slot) {
			self.hits.retain(|hit| !cached.contains_slot(hit.slot));
			// The subtree's wake requests are stale the moment it repaints;
			// the paint below re-requests whatever is still animating.
			self.wakes.retain(|wake| !cached.contains_slot(wake.slot));
		}
		let parent_background = path
			.iter()
			.rev()
			.skip(1)
			.filter_map(|entry| find_slot_ref(&self.root, entry.slot))
			.map(|cached| {
				cached
					.comp()
					.props()
					.style(&self.ctx.theme)
					.background_color()
			})
			.find(|color| *color != Color::Default);

		let focus = self.focus;
		let hover = self.hover;
		let pointer = self.pointer;
		let keyboard = self.keyboard;
		let now = self.now;
		let ctx = &self.ctx;
		let Some(cached) = self.root.find_slot(slot) else {
			return;
		};
		let rect = cached.rect;
		let style = cached.fill_style(ctx, self.now);
		self.frame.fill(rect, style);
		{
			let mut pc = PaintCtx::new(&mut self.frame, ctx, &mut self.hits, &mut self.wakes);
			pc.clip = rect.y.saturating_add(rect.height);
			pc.focus = focus;
			pc.hover = hover;
			pc.pointer = pointer;
			pc.keyboard = keyboard;
			pc.now = now;
			cached.paint(&mut pc);
		}
		if let Some(background) = parent_background {
			self.frame.underlay(rect, background);
		}
		self.mark_damage(rect.y, rect.height);
	}

	fn layout_all(&mut self) {
		let previous_height = self.frame.size().height;
		let _ = self.root.measure(&self.ctx);
		let height = self.root.height(&self.ctx, self.width);
		self
			.root
			.place(&self.ctx, Rect::new(0, 0, self.width, height));
		let target = Size::new(self.width, height);
		if self.frame.size() == target {
			self.frame.clear(Style::default());
		} else {
			self.frame = Frame::new(target);
		}
		self.hits.clear();
		self.wakes.clear();
		let mut pc = PaintCtx::new(&mut self.frame, &self.ctx, &mut self.hits, &mut self.wakes);
		pc.clip = height;
		pc.focus = self.focus;
		pc.hover = self.hover;
		pc.pointer = self.pointer;
		pc.keyboard = self.keyboard;
		pc.now = self.now;
		if self.root.visible {
			self.root.paint(&mut pc);
		}
		self.mark_damage(0, height.max(previous_height));
	}

	fn mark_damage(&mut self, y: u16, height: u16) {
		if height == 0 {
			return;
		}
		if self.damage.len() >= 32 {
			self.damage.clear();
			self.damage.push((0, self.frame.size().height));
			return;
		}
		self.damage.push((y, y.saturating_add(height)));
	}

	fn compile_conds(&mut self) {
		self.conds.clear();
		compile_cached_conds(&self.root, &mut self.conds);
	}

	fn apply_conds(&mut self, relayout: bool) {
		if self.conds.is_empty() {
			return;
		}
		let Value::Object(values) = self.values() else {
			return;
		};
		let decisions: SmallVec<(Slot, bool), 8> = self
			.conds
			.iter()
			.map(|cond| {
				let visible = find_named_value(&values, &cond.source_id)
					.is_none_or(|value| predicate_matches(&cond.predicate, value));
				(cond.target, visible)
			})
			.collect();
		let mut flipped: SmallVec<Slot, 4> = SmallVec::new();
		for (target, visible) in decisions {
			if self
				.root
				.update(target, |cached| {
					let changed = cached.visible != visible;
					cached.visible = visible;
					(changed, changed)
				})
				.unwrap_or(false)
			{
				flipped.push(target);
			}
		}
		if !flipped.is_empty() && relayout {
			self.normalize_focus();
			self.relayout_visibility(&flipped);
		}
	}

	fn relayout_visibility(&mut self, flipped: &[Slot]) {
		let mut boundaries: SmallVec<Slot, 4> = SmallVec::new();
		for &slot in flipped {
			let Some(path) = path_to_slot(&self.root, slot) else {
				continue;
			};
			let Some(boundary) = path[..path.len().saturating_sub(1)]
				.iter()
				.rev()
				.find(|entry| entry.fixed)
			else {
				self.layout_all();
				return;
			};
			if !boundaries.contains(&boundary.slot) {
				boundaries.push(boundary.slot);
			}
		}
		for boundary in boundaries {
			if let Some(entry) =
				path_to_slot(&self.root, boundary).and_then(|path| path.last().copied())
			{
				self.relayout_fixed(entry);
			}
		}
	}

	fn normalize_focus(&mut self) {
		let ring = self.focus_ring();
		if self.focus.is_some_and(|slot| !ring.contains(&slot)) {
			self.focus = ring.first().copied();
		}
		if self.hover.is_some_and(|(slot, _)| {
			path_to_slot(&self.root, slot).is_none_or(|path| path.iter().any(|entry| !entry.visible))
		}) {
			self.hover = None;
		}
	}
}

fn event_size(cached: &Cached) -> (u16, u16) {
	let (pad_y, pad_x) = cached.comp().props().pad();
	let border = u16::from(cached.comp().props().border().is_some());
	let width = cached
		.rect
		.width
		.saturating_sub(pad_x.saturating_add(border).saturating_mul(2));
	let height = cached
		.rect
		.height
		.saturating_sub(pad_y.saturating_add(border).saturating_mul(2));
	(width, height)
}

fn path_to_slot(root: &Cached, slot: Slot) -> Option<ComponentPath> {
	let mut path = SmallVec::new();
	if collect_path(root, &|cached| cached.comp().slot() == slot, &mut path) {
		Some(path)
	} else {
		None
	}
}

fn path_to_id(root: &Cached, id: &str) -> Option<ComponentPath> {
	let mut path = SmallVec::new();
	if collect_path(
		root,
		&|cached| {
			cached
				.comp()
				.props()
				.id()
				.is_some_and(|candidate| candidate == id)
		},
		&mut path,
	) {
		Some(path)
	} else {
		None
	}
}

fn collect_path(
	cached: &Cached,
	predicate: &impl Fn(&Cached) -> bool,
	path: &mut ComponentPath,
) -> bool {
	path.push(PathEntry {
		slot:        cached.comp().slot(),
		rect:        cached.rect,
		visible:     cached.visible,
		fixed:       cached.comp().props().h().is_some(),
		paint_owner: cached.comp().is::<Scroll>()
			|| cached.comp().is::<Tabs>()
			|| cached.comp().is::<EditorPane>()
			|| cached.comp().is::<Wizard>(),
		row:         cached.comp().is::<Row>(),
	});
	if predicate(cached) {
		return true;
	}
	for child in cached.comp().children() {
		if collect_path(child, predicate, path) {
			return true;
		}
	}
	path.pop();
	false
}

fn find_slot_ref(cached: &Cached, slot: Slot) -> Option<&Cached> {
	if cached.comp().slot() == slot {
		return Some(cached);
	}
	cached
		.comp()
		.children()
		.iter()
		.find_map(|child| find_slot_ref(child, slot))
}

fn collect_values(cached: &Cached, out: &mut serde_json::Map<String, Value>) {
	if !cached.visible {
		return;
	}
	cached.comp().value(out);
	for child in cached.comp().children() {
		collect_values(child, out);
	}
}

/// Serializes one cached component for [`Ui::debug_tree`].
fn debug_node(cached: &Cached, focus: Option<Slot>) -> Value {
	let comp = cached.comp();
	let mut node = serde_json::Map::new();
	let kind = comp.kind();
	node.insert("kind".into(), Value::from(kind.rsplit("::").next().unwrap_or(kind)));
	if let Some(id) = comp.props().id() {
		node.insert("id".into(), Value::from(id.as_str()));
	}
	node.insert(
		"rect".into(),
		Value::from(vec![
			i64::from(cached.rect.x),
			i64::from(cached.rect.y),
			i64::from(cached.rect.width),
			i64::from(cached.rect.height),
		]),
	);
	if !cached.visible {
		node.insert("hidden".into(), Value::from(true));
	}
	if comp.focusable() {
		node.insert("focusable".into(), Value::from(true));
	}
	if focus == Some(comp.slot()) {
		node.insert("focused".into(), Value::from(true));
	}
	let children: Vec<Value> = comp
		.children()
		.iter()
		.map(|child| debug_node(child, focus))
		.collect();
	if !children.is_empty() {
		node.insert("children".into(), Value::from(children));
	}
	Value::Object(node)
}

fn compile_cached_conds(cached: &Cached, out: &mut Vec<CompiledCond>) {
	if let Some(condition) = cached.comp().props().str_of(Prop::When)
		&& let Some((source_id, predicate)) = compile_predicate(condition)
	{
		out.push(CompiledCond { target: cached.comp().slot(), source_id, predicate });
	}
	for child in cached.comp().children() {
		compile_cached_conds(child, out);
	}
}

fn compile_predicate(condition: &Str) -> Option<(Str, Predicate)> {
	if let Some((id, expected)) = condition.split_once("!=") {
		let id = id.trim();
		if id.is_empty() {
			return None;
		}
		return Some((Str::new(id), Predicate::NotEqual(Str::new(expected.trim()))));
	}
	let (id, expected) = condition.split_once('=')?;
	let id = id.trim();
	if id.is_empty() {
		return None;
	}
	Some((Str::new(id), Predicate::Equal(Str::new(expected.trim()))))
}

fn find_named_value<'a>(values: &'a serde_json::Map<String, Value>, id: &str) -> Option<&'a Value> {
	if let Some(value) = values.get(id) {
		return Some(value);
	}
	values.values().find_map(|value| match value {
		Value::Object(nested) => find_named_value(nested, id),
		_ => None,
	})
}

fn predicate_matches(predicate: &Predicate, value: &Value) -> bool {
	let expected = match predicate {
		Predicate::Equal(expected) | Predicate::NotEqual(expected) => expected,
	};
	let equal = match value {
		Value::String(value) => value == expected,
		Value::Bool(value) => (*value && expected == "true") || (!*value && expected == "false"),
		Value::Number(value) => value.to_string() == expected.as_str(),
		Value::Array(values) => values
			.iter()
			.any(|value| predicate_value_equal(value, expected)),
		Value::Null => expected == "null",
		Value::Object(_) => false,
	};
	match predicate {
		Predicate::Equal(_) => equal,
		Predicate::NotEqual(_) => !equal,
	}
}

fn predicate_value_equal(value: &Value, expected: &str) -> bool {
	match value {
		Value::String(value) => value == expected,
		Value::Bool(value) => (*value && expected == "true") || (!*value && expected == "false"),
		Value::Number(value) => value.to_string() == expected,
		Value::Null => expected == "null",
		Value::Array(values) => values
			.iter()
			.any(|value| predicate_value_equal(value, expected)),
		Value::Object(_) => false,
	}
}

#[cfg(test)]
mod tests {

	use std::{cell, io, mem, rc};

	use omp_core::sf;

	use super::*;
	use crate::{
		OverlayAnchor,
		component::next_slot,
		components::{Col, EditInput},
		dom,
		frame::CellContent,
		markup::Dim,
		props::{Prop, PropValue, Props},
		test_support::frame_row_text,
	};

	/// A consumed key without an explicit layout request must not relayout
	/// the tree, even when an ancestor's placed height exceeds its
	/// intrinsic height because a row stretched it cross-axis.
	#[test]
	fn consumed_keys_under_stretched_ancestors_do_not_relayout() {
		struct PlaceProbe {
			props:  Props,
			slot:   Slot,
			places: rc::Rc<cell::Cell<usize>>,
		}
		impl Component for PlaceProbe {
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
				(4, 4)
			}

			fn height(&mut self, _ctx: &UiContext, _width: u16) -> u16 {
				8
			}

			fn place(&mut self, _ctx: &UiContext, _rect: Rect) {
				self.places.set(self.places.get() + 1);
			}

			fn paint(&mut self, _pc: &mut PaintCtx<'_>, _rect: Rect) {}
		}

		let places = rc::Rc::new(cell::Cell::new(0_usize));
		// The column's intrinsic height (the 4-row input) is stretched to
		// the probe's 8 rows, so its placed rect exceeds its own height().
		let mut ui = Ui::from_root(
			Row::new()
				.child(PlaceProbe {
					props:  Props::new(),
					slot:   next_slot(),
					places: rc::Rc::clone(&places),
				})
				.child(Col::new().child(EditInput::new())),
			40,
			UiContext::default(),
		);
		ui.focus_first();
		let baseline = places.get();
		assert_eq!(ui.handle_key(Key::Char('x')), UiEvent::None);
		assert_eq!(
			places.get(),
			baseline,
			"a consumed key must refresh the focused leaf only, never re-place stretched siblings"
		);
		assert!(
			(0..ui.height()).any(|row| frame_row_text(ui.frame(), row).contains('x')),
			"the key still edits the input"
		);
	}

	macro_rules! assert_tag_types {
		($($tag:ident => $type:ident;)+) => {
			/// Every vocabulary tag lowers to its typed constructor.
			#[test]
			fn dom_macro_tags_construct_typed_components() {
				$(let _: crate::components::$type = dom!(<$tag/>);)+
				let _: crate::components::Icon = dom!(<icon name="check"/>);
				let _: crate::components::CustomElement = dom!(<mystery/>);
			}
		};
	}
	omp_vocab::for_each_component! { assert_tag_types }

	fn frame_text(ui: &Ui) -> Vec<String> {
		let size = ui.frame().size();
		(0..size.height)
			.map(|y| {
				let mut row = String::new();
				for x in 0..size.width {
					match &ui.frame().cell(x, y).content {
						CellContent::Blank => row.push(' '),
						CellContent::Grapheme { text, .. } => row.push_str(text),
						CellContent::Image { .. } | CellContent::Continuation => {},
					}
				}
				row.trim_end().to_string()
			})
			.collect()
	}

	#[test]
	fn base_changes_during_alt_repaint_reach_main_repaint() {
		// An alternate-screen repaint consumes composited viewport damage.
		// A full main-screen repaint must still include base changes.
		let mut ui = Ui::from_markup("<text id=msg>before</text>", 20, UiContext::default()).unwrap();
		let mut renderer = Renderer::new(Vec::new());
		ui.present(&mut renderer, 4)
			.expect("baseline main-buffer present");

		let overlay = ui.show_overlay(dom! { <text>{"modal"}</text> }, OverlayOptions::default());
		ui.set_text("msg", "supplanted");
		ui.repaint(&mut renderer, 4, "\x1b[?1049h")
			.expect("held repaint consumes the damage");
		assert!(!ui.has_damage(), "repaints consume damage like presents");

		ui.close_overlay(overlay);
		renderer.writer_mut().clear();
		let stats = ui
			.repaint(&mut renderer, 4, "\x1b[?1049l")
			.expect("release repaint succeeds");
		let output = String::from_utf8(renderer.writer_mut().clone()).expect("ANSI is UTF-8");
		assert!(
			output.contains("supplanted"),
			"held base change reaches the main buffer: {output:?}"
		);
		assert!(
			!output.contains("\x1b[3J"),
			"a clean release never clears native scrollback: {output:?}"
		);
		assert!(stats.changed_cells > 0);
	}

	fn find_id<'a>(cached: &'a Cached, id: &str) -> Option<&'a Cached> {
		if cached
			.comp()
			.props()
			.id()
			.is_some_and(|candidate| candidate == id)
		{
			return Some(cached);
		}
		cached
			.comp()
			.children()
			.iter()
			.find_map(|child| find_id(child, id))
	}

	fn count_cached(cached: &Cached) -> usize {
		1 + cached
			.comp()
			.children()
			.iter()
			.map(count_cached)
			.sum::<usize>()
	}

	fn contains_component<T: Component>(cached: &Cached) -> bool {
		cached.comp().is::<T>() || cached.comp().children().iter().any(contains_component::<T>)
	}

	#[test]
	fn rich_lines_honor_horizontal_alignment() {
		fn painted_column(source: &str) -> usize {
			frame_text(&Ui::from_markup(source, 11, UiContext::default()).unwrap())[0]
				.find("hi")
				.expect("rich text painted")
		}

		assert_eq!(painted_column("<md>hi</md>"), 0);
		assert_eq!(painted_column("<md align=center>hi</md>"), 4);
		assert_eq!(painted_column("<md align=end>hi</md>"), 9);
	}

	#[test]
	fn parses_and_paints_box_with_text() {
		let ui = Ui::from_markup(
			r#"<box title="t"><text>hello world</text></box>"#,
			20,
			UiContext::default(),
		)
		.unwrap();
		let rows = frame_text(&ui);
		assert_eq!(rows.len(), 3);
		assert!(rows[0].starts_with("┌─ t "));
		assert!(rows[1].starts_with("│ hello world") && rows[1].ends_with('│'));
		assert!(rows[2].starts_with('└'));
	}

	#[test]
	fn row_border_frames_and_insets_children() {
		let src = r#"<row border=round title="r" gap=1><text>ab</text><text>cd</text></row>"#;
		let ui = Ui::from_markup(src, 10, UiContext::default()).unwrap();
		let rows = frame_text(&ui);
		assert_eq!(rows.len(), 3, "one content row plus the frame: {rows:?}");
		assert!(rows[0].starts_with("╭─ r ") && rows[0].ends_with('╮'), "{rows:?}");
		assert!(rows[1].starts_with("│ab cd") && rows[1].ends_with('│'), "{rows:?}");
		assert!(rows[2].starts_with('╰') && rows[2].ends_with('╯'), "{rows:?}");
	}

	#[test]
	fn truncate_clips_text_to_one_line_with_ellipsis() {
		let ui = Ui::from_markup("<text truncate>alpha beta gamma</text>", 8, UiContext::default())
			.unwrap();
		assert_eq!(frame_text(&ui), ["alpha b…"]);
		assert_eq!(ui.height(), 1);
	}

	#[test]
	fn dash_border_and_hr_use_dashed_strokes() {
		let boxed =
			Ui::from_markup("<box border=dash><text>x</text></box>", 6, UiContext::default()).unwrap();
		assert_eq!(frame_text(&boxed), ["┌╌╌╌╌┐", "┆ x  ┆", "└╌╌╌╌┘"]);
		let hr = Ui::from_markup("<hr border=dash/>", 4, UiContext::default()).unwrap();
		assert_eq!(frame_text(&hr), ["╌╌╌╌"]);
	}

	#[test]
	fn spacer_defaults_to_filling_row_slack() {
		let ui = Ui::from_markup(
			"<row><text>L</text><spacer/><text>R</text></row>",
			8,
			UiContext::default(),
		)
		.unwrap();
		assert_eq!(frame_text(&ui), ["L      R"]);
	}

	#[test]
	fn row_justify_between_spreads_children_to_both_edges() {
		let ui = Ui::from_markup(
			"<row justify=between><text>left</text><text>right</text></row>",
			16,
			UiContext::default(),
		)
		.unwrap();
		assert_eq!(frame_text(&ui), ["left       right"]);
	}

	#[test]
	fn wrapping_row_stacks_only_below_its_minimum_width() {
		let source = "<row wrap gap=1><text id=a>alpha</text><text>bravo</text></row>";
		let narrow = Ui::from_markup(source, 8, UiContext::default()).unwrap();
		assert_eq!(frame_text(&narrow), ["alpha", "bravo"]);
		assert_eq!(narrow.height(), 2);

		let mut wide = Ui::from_markup(source, 12, UiContext::default()).unwrap();
		assert_eq!(frame_text(&wide), ["alpha bravo"]);
		assert_eq!(wide.height(), 1);

		assert!(wide.set_text("a", "alphabet"));
		let fresh =
			Ui::from_markup(source.replace("alpha", "alphabet"), 12, UiContext::default()).unwrap();
		assert_eq!(frame_text(&wide), frame_text(&fresh));
		assert_eq!(frame_text(&wide), ["alphabet", "bravo"]);
	}

	#[test]
	fn wrapping_row_flows_children_into_justified_lines() {
		let source =
			"<row wrap gap=1 justify=center><text>aa</text><text>bb</text><text>cc</text></row>";
		let ui = Ui::from_markup(source, 7, UiContext::default()).unwrap();
		assert_eq!(frame_text(&ui), [" aa bb", "  cc"]);
		assert_eq!(ui.height(), 2);
	}

	#[test]
	fn col_border_frames_and_insets_children() {
		let ui = Ui::from_markup(
			"<col border=double><text>hi</text><text>yo</text></col>",
			8,
			UiContext::default(),
		)
		.unwrap();
		let rows = frame_text(&ui);
		assert_eq!(rows.len(), 4, "{rows:?}");
		assert!(rows[0].starts_with('╔') && rows[0].ends_with('╗'), "{rows:?}");
		assert!(rows[1].starts_with("║hi") && rows[1].ends_with('║'), "{rows:?}");
		assert!(rows[2].starts_with("║yo") && rows[2].ends_with('║'), "{rows:?}");
		assert!(rows[3].starts_with('╚') && rows[3].ends_with('╝'), "{rows:?}");
	}

	#[test]
	fn bordered_containers_shrink_content_at_constrained_widths() {
		// bare col: "aa bb" (5 cells) fits a 6-cell line
		let bare = Ui::from_markup("<col><text>aa bb</text></col>", 6, UiContext::default()).unwrap();
		assert_eq!(frame_text(&bare).len(), 1);
		// the frame eats two columns, so measurement must force a wrap
		let framed =
			Ui::from_markup("<col border=square><text>aa bb</text></col>", 6, UiContext::default())
				.unwrap();
		let rows = frame_text(&framed);
		assert_eq!(rows.len(), 4, "two wrapped lines plus the frame: {rows:?}");
		assert!(rows[1].starts_with("│aa") && rows[1].ends_with('│'), "{rows:?}");
		assert!(rows[2].starts_with("│bb") && rows[2].ends_with('│'), "{rows:?}");
		// row: the child is placed inside the frame and clipped to it
		let row =
			Ui::from_markup("<row border=square><text>aaaa</text></row>", 6, UiContext::default())
				.unwrap();
		let rows = frame_text(&row);
		assert_eq!(rows.len(), 3, "{rows:?}");
		assert_eq!(rows[1], "│aaaa│", "child fills exactly the inner width");
	}

	#[test]
	fn bc_colors_the_border_and_defaults_use_the_border_token() {
		use crate::Color;
		let red = Color::Rgb(0xff, 0, 0);
		let corner = |ui: &Ui| ui.frame().cell(0, 0).style;
		let colored =
			Ui::from_markup("<row border=round bc=red><text>x</text></row>", 8, UiContext::default())
				.unwrap();
		assert_eq!(corner(&colored).foreground_color(), red);
		// without bc= the frame takes the theme's border tone, not fg
		let plain =
			Ui::from_markup("<row border=round><text>x</text></row>", 8, UiContext::default())
				.unwrap();
		assert_eq!(corner(&plain).foreground_color(), crate::Theme::default().border);
		// fg= alone still tints the frame as a dimmed echo of the node style
		let inked =
			Ui::from_markup("<row border=round fg=red><text>x</text></row>", 8, UiContext::default())
				.unwrap();
		assert_eq!(corner(&inked).foreground_color(), red);
		// bc= works on <box> too
		let boxed =
			Ui::from_markup("<box bc=red><text>x</text></box>", 8, UiContext::default()).unwrap();
		assert_eq!(corner(&boxed).foreground_color(), red);
	}

	#[test]
	fn content_dirty_update_keeps_layout_identical_to_rebuild() {
		let src = r"<col><box><text id=a>alpha beta</text></box><text id=b>steady</text></col>";
		let mut ui = Ui::from_markup(src, 30, UiContext::default()).unwrap();
		ui.set_text("a", "gamma delta");
		// ground truth: fresh build with the same content
		let fresh =
			Ui::from_markup(src.replace("alpha beta", "gamma delta"), 30, UiContext::default())
				.unwrap();
		assert_eq!(frame_text(&ui), frame_text(&fresh));
	}

	#[test]
	fn size_dirty_update_matches_rebuild() {
		let src = r"<col><text id=a>short</text><text id=b>after</text></col>";
		let mut ui = Ui::from_markup(src, 12, UiContext::default()).unwrap();
		let long = "one two three four five six seven eight";
		ui.set_text("a", long);
		let fresh = Ui::from_markup(src.replace("short", long), 12, UiContext::default()).unwrap();
		assert_eq!(frame_text(&ui), frame_text(&fresh));
		assert!(ui.height() > 2);
	}

	#[test]
	fn x_measure_change_resolves_row_and_matches_rebuild() {
		// growing `a` must re-solve the row's widths, not overwrite `b`
		let src = r"<row><text id=a>a</text><text id=b>bbbb</text></row>";
		let mut ui = Ui::from_markup(src, 20, UiContext::default()).unwrap();
		ui.set_text("a", "longlong");
		let fresh =
			Ui::from_markup(src.replace(">a<", ">longlong<"), 20, UiContext::default()).unwrap();
		assert_eq!(frame_text(&ui), frame_text(&fresh));
		assert!(frame_text(&ui)[0].contains("bbbb"), "sibling intact: {:?}", frame_text(&ui));

		// shrink back: also X-dirty, must again match a rebuild
		ui.set_text("a", "x");
		let fresh = Ui::from_markup(src.replace(">a<", ">x<"), 20, UiContext::default()).unwrap();
		assert_eq!(frame_text(&ui), frame_text(&fresh));
	}

	#[test]
	fn x_measure_change_that_grows_row_height_matches_rebuild() {
		// the row itself gets taller: escalates past the row to a full
		// relayout and still matches ground truth
		let src = r"<col><row><text id=a>a</text><text>bbbb</text></row><text>tail</text></col>";
		let mut ui = Ui::from_markup(src, 14, UiContext::default()).unwrap();
		let long = "aaaaaaa aaaaaaa aaaaaaa";
		ui.set_text("a", long);
		let fresh =
			Ui::from_markup(src.replace(">a<", &format!(">{long}<")), 14, UiContext::default())
				.unwrap();
		assert_eq!(frame_text(&ui), frame_text(&fresh));
	}

	#[test]
	fn fixed_height_bounds_relayout() {
		let src = r"<col><box id=bx h=4><text id=a>x</text></box><text id=b>below</text></col>";
		let mut ui = Ui::from_markup(src, 20, UiContext::default()).unwrap();
		let below_before = frame_text(&ui);
		// grow the text inside the fixed box: document height must not move
		ui.set_text("a", "a much longer text that wraps to many lines now");
		assert_eq!(ui.height(), below_before.len() as u16);
		let after = frame_text(&ui);
		assert_eq!(below_before.last(), after.last(), "content below boundary untouched");
	}

	#[test]
	fn row_flex_grows_and_caps() {
		let src = r"<row gap=1><text grow>a</text><text grow max=10 id=c>b</text></row>";
		let ui = Ui::from_markup(src, 40, UiContext::default()).unwrap();
		let c = find_id(ui.root(), "c").expect("id=c");
		assert_eq!(c.rect.x.saturating_add(c.rect.width), 40);
		assert!(c.rect.width <= 10);
	}

	#[test]
	fn unknown_id_is_rejected() {
		let mut ui = Ui::from_markup("<text id=x>y</text>", 10, UiContext::default()).unwrap();
		assert!(!ui.set_text("nope", "z"));
		assert!(ui.set_text("x", "z"));
	}

	#[test]
	fn markdown_node_renders_and_updates() {
		let src =
			"<box><md id=doc># Title\n\nbody text here\n\n| a | b |\n|---|---|\n| 1 | 2 |</md></box>";
		let mut ui = Ui::from_markup(src, 30, UiContext::default()).unwrap();
		let rows = frame_text(&ui);
		assert!(rows.iter().any(|r| r.contains("Title")));
		assert!(rows.iter().any(|r| r.contains('1') && r.contains('2')));
		// update reflows through the same two-tier path
		assert!(ui.set_text("doc", "# Other\n\nnew body"));
		let rows = frame_text(&ui);
		assert!(rows.iter().any(|r| r.contains("Other")));
		assert!(!rows.iter().any(|r| r.contains("Title")));
	}

	#[test]
	fn markdown_embedded_box_preserves_document_order() {
		let src = concat!(
			"<md>before paragraph\n\n",
			"<box border=round title=\"T\"><text>inner</text></box>\n",
			"after paragraph</md>",
		);
		let rows = frame_text(&Ui::from_markup(src, 32, UiContext::default()).unwrap());
		let before = rows
			.iter()
			.position(|row| row.contains("before paragraph"))
			.unwrap();
		let top = rows
			.iter()
			.position(|row| row.contains('╭') && row.contains('T'))
			.unwrap();
		let inner = rows.iter().position(|row| row.contains("inner")).unwrap();
		let after = rows
			.iter()
			.position(|row| row.contains("after paragraph"))
			.unwrap();
		assert!(before < top && top < inner && inner < after, "document order: {rows:?}");
		assert!(top > before + 1 && after > inner + 1, "markdown block gaps: {rows:?}");
	}

	#[test]
	fn markdown_embedded_latex_flows_between_paragraphs() {
		let src = "<md>before\n<latex>\\frac{a}{b}</latex>\nafter</md>";
		let rows = frame_text(&Ui::from_markup(src, 24, UiContext::default()).unwrap());
		let before = rows.iter().position(|row| row.contains("before")).unwrap();
		let numerator = rows.iter().position(|row| row.trim() == "a").unwrap();
		let denominator = rows.iter().position(|row| row.trim() == "b").unwrap();
		let after = rows.iter().position(|row| row.contains("after")).unwrap();
		assert!(before < numerator && numerator < denominator && denominator < after, "{rows:?}");
	}

	#[test]
	fn plain_markdown_keeps_single_verbatim_leaf() {
		let source = "# Title\n\nbody  with  spacing";
		let ui = Ui::from_markup(format!("<md>{source}</md>"), 30, UiContext::default()).unwrap();
		assert_eq!(frame_text(&ui)[0], "Title");
		assert_eq!(contains_component::<crate::components::Markdown>(ui.root()) as usize, 1);
		assert!(ui.root().comp().children()[0].comp().children().is_empty());
	}

	#[test]
	fn widget_markup_inside_markdown_is_rejected() {
		let Err(error) = Ui::from_markup(
			"<md>body\n<select id=x><option>a</option></select>\n</md>",
			30,
			UiContext::default(),
		) else {
			panic!("widget markup entered the markdown focus ring");
		};
		assert!(error.message.contains("<select>"), "{error}");
	}

	#[test]
	fn nested_markdown_inside_embedded_box_renders() {
		let src = "<md>outside\n<box border=round><md>**nested body**</md></box>\ntail</md>";
		let rows = frame_text(&Ui::from_markup(src, 30, UiContext::default()).unwrap());
		let outside = rows.iter().position(|row| row.contains("outside")).unwrap();
		let nested = rows
			.iter()
			.position(|row| row.contains("nested body"))
			.unwrap();
		let tail = rows.iter().position(|row| row.contains("tail")).unwrap();
		assert!(outside < nested && nested < tail, "{rows:?}");
		assert!(rows.iter().any(|row| row.contains('╭')), "{rows:?}");
	}

	#[test]
	fn markup_openers_inside_markdown_fences_stay_literal() {
		let src = "<md>```text\n<box border=round><text>literal</text></box>\n```\n</md>";
		let rows = frame_text(&Ui::from_markup(src, 48, UiContext::default()).unwrap());
		let all = rows.join("\n");
		assert!(all.contains("<box") && all.contains("literal"), "{all}");
		assert!(!all.contains('╭') && !all.contains('╰'), "parsed as a box: {all}");
	}

	#[test]
	fn markup_openers_inside_indented_markdown_code_stay_literal() {
		let src = "<md>    <box border=round><text>literal</text></box>\n</md>";
		let ui = Ui::from_markup(src, 48, UiContext::default()).unwrap();
		assert!(
			!contains_component::<crate::components::Boxed>(ui.root()),
			"indented code built a box component"
		);
		let all = frame_text(&ui).join("\n");
		assert!(all.contains("<box") && all.contains("literal"), "{all}");
		assert!(!all.contains('╭') && !all.contains('╰'), "parsed as a box: {all}");
	}

	#[test]
	fn markdown_node_renders_mermaid_diagram() {
		let ui = Ui::from_markup(
			"<md>```mermaid\nflowchart LR\n  A[Collect] --> B[Render]\n```</md>",
			40,
			UiContext::default(),
		)
		.unwrap();
		let rows = frame_text(&ui);
		assert!(rows.iter().any(|row| row.contains("Collect")));
		assert!(rows.iter().any(|row| row.contains("Render")));
		assert!(
			!rows
				.iter()
				.any(|row| row.contains("flowchart") || row.contains("```"))
		);
	}

	#[test]
	fn markdown_node_paints_highlighted_code() {
		let ui = Ui::from_markup(
			"<md>```rust\npub fn main() {\n  let message = \"hi\";\n}\n```</md>",
			40,
			UiContext::default(),
		)
		.unwrap();
		let rows = frame_text(&ui);
		let (keyword_row, keyword_text) = rows
			.iter()
			.enumerate()
			.find(|(_, row)| row.contains("pub fn"))
			.expect("rendered keyword row");
		let keyword_column = keyword_text.find("pub").expect("keyword column") as u16;
		assert_eq!(
			ui.frame()
				.cell(keyword_column, keyword_row as u16)
				.style
				.foreground_color(),
			ui.ctx.theme.accent,
		);

		let (string_row, string_text) = rows
			.iter()
			.enumerate()
			.find(|(_, row)| row.contains("\"hi\""))
			.expect("rendered string row");
		let string_column = string_text.find("hi").expect("string column") as u16;
		assert_eq!(
			ui.frame()
				.cell(string_column, string_row as u16)
				.style
				.foreground_color(),
			ui.ctx.theme.code_border,
		);
	}
	/// A theme swap through [`Ui::set_context`] must reach output cached
	/// under the old context: markdown's render memo, and every stacked
	/// overlay's tree.
	#[test]
	fn set_context_restyles_cached_markdown_and_overlays() {
		use crate::{Appearance, OverlayOptions, Theme, dom};

		let mut ui =
			Ui::from_markup("<md>```rust\npub fn main() {}\n```</md>", 40, UiContext::default())
				.unwrap();
		let overlay =
			ui.show_overlay(dom! { <text fg=accent>{"layer"}</text> }, OverlayOptions::default());
		let rows = frame_text(&ui);
		let (keyword_row, keyword_text) = rows
			.iter()
			.enumerate()
			.find(|(_, row)| row.contains("pub fn"))
			.expect("rendered keyword row");
		let (column, row) =
			(keyword_text.find("pub").expect("keyword column") as u16, keyword_row as u16);
		let dark_accent = ui.ctx.theme.accent;
		assert_eq!(ui.frame().cell(column, row).style.foreground_color(), dark_accent);

		let light = UiContext {
			appearance: Appearance::Light,
			theme: Theme::for_appearance(Appearance::Light),
			..UiContext::default()
		};
		assert!(ui.set_context(light.clone()), "a differing context applies");
		let light_accent = ui.ctx.theme.accent;
		assert_ne!(light_accent, dark_accent);
		// Same text, same width: only the revision bump can discard the
		// markdown render memo.
		assert_eq!(ui.frame().cell(column, row).style.foreground_color(), light_accent);
		let layer = ui.overlay(overlay).expect("overlay retained");
		assert_eq!(layer.frame().cell(0, 0).style.foreground_color(), light_accent);
		assert!(ui.has_damage(), "the swap repaints");
		assert!(!ui.set_context(light), "an equal context is a no-op");
	}
	/// An overlay swapped directly through [`Ui::overlay_mut`] sits one
	/// revision ahead of its parent; a later parent swap must still discard
	/// the overlay's render memos instead of reusing that number.
	#[test]
	fn parent_swap_restyles_an_independently_swapped_overlay() {
		use crate::{Appearance, Color, Dim, OverlayOptions, Theme, dom};

		let mut ui = Ui::from_markup("<text>base</text>", 40, UiContext::default()).unwrap();
		let overlay = ui.show_overlay(
			dom! { <md>{"```rust\npub fn main() {}\n```"}</md> },
			OverlayOptions::default().width(Dim::Cells(40)),
		);
		let find_keyword = |layer: &Ui| {
			let rows = frame_text(layer);
			let (row, text) = rows
				.iter()
				.enumerate()
				.find(|(_, row)| row.contains("pub fn"))
				.expect("rendered keyword row");
			(text.find("pub").expect("keyword column") as u16, row as u16)
		};

		let light = UiContext {
			appearance: Appearance::Light,
			theme: Theme::for_appearance(Appearance::Light),
			..UiContext::default()
		};
		assert!(
			ui.overlay_mut(overlay)
				.expect("overlay retained")
				.set_context(light)
		);
		let layer = ui.overlay(overlay).expect("overlay retained");
		let (column, row) = find_keyword(layer);
		assert_eq!(
			layer.frame().cell(column, row).style.foreground_color(),
			Theme::for_appearance(Appearance::Light).accent,
		);

		let custom = UiContext {
			theme: Theme { accent: Color::Rgb(1, 2, 3), ..Theme::default() },
			..UiContext::default()
		};
		assert!(ui.set_context(custom));
		let layer = ui.overlay(overlay).expect("overlay retained");
		let (column, row) = find_keyword(layer);
		assert_eq!(
			layer.frame().cell(column, row).style.foreground_color(),
			Color::Rgb(1, 2, 3),
			"the parent swap reaches the overlay's markdown memo",
		);
	}
	/// End-to-end mix: markup chrome around a Markdown document exercising
	/// inline/display LaTeX, a mermaid diagram, a bordered table, links,
	/// swatches, and tree guides, plus a standalone `<latex>` node.
	#[test]
	fn kitchen_sink_mixes_markup_markdown_latex_and_mermaid() {
		let src = concat!(
			"<col gap=1>",
			"<box border=round title=\"Report\">",
			"<md id=doc>",
			"# Pipeline ~~v1~~ **v2**\n\n",
			"Solved $x^2 + 1 = 0$ over $\\mathbb{C}$ — see [the docs](https://example.com/math) ",
			"or https://ci.example.com; accent is #C5FFD6 today.\n\n",
			"| Stage | ms |\n|---|---|\n| lex | 12 |\n| render | 3 |\n\n",
			"$$\nx = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}\n$$\n\n",
			"```mermaid\nflowchart LR\n  A[Parse] --> B[Layout] --> C[Paint]\n```\n\n",
			"├── src\n│   └── markdown\n└── tests\n",
			"</md>",
			"</box>",
			"<callout info title=\"Advisor\" badge=\"1 note\">math path is **hot**</callout>",
			"<latex>\\begin{pmatrix}1 & 0 \\\\ 0 & 1\\end{pmatrix}</latex>",
			"<hr/>",
			"</col>",
		);
		let ui = Ui::from_markup(src, 64, UiContext::default()).unwrap();
		let rows = frame_text(&ui);
		let all = rows.join("\n");

		// markup chrome: box title, callout header + badge, callout body prose
		assert!(all.contains("Report"), "box title: {all}");
		assert!(all.contains("Advisor") && all.contains("1 note"), "callout header: {all}");
		assert!(all.contains("math path is hot"), "callout markdown body: {all}");

		// markdown inline: strike/bold text, math to unicode, blackboard font,
		// explicit link with URL parenthetical, bare autolink, swatch chip
		assert!(all.contains("Pipeline v1 v2"), "heading inline styles: {all}");
		assert!(all.contains("x² + 1 = 0"), "inline math: {all}");
		assert!(all.contains('ℂ'), "math font: {all}");
		// the parenthetical may wrap to the next row at this width
		assert!(
			all.contains("the docs") && all.contains("(https://example.com/math)"),
			"link: {all}"
		);
		assert!(all.contains("https://ci.example.com"), "autolink: {all}");
		assert!(all.contains("■ #C5FFD6"), "hex swatch chip: {all}");

		// table: box-drawn grid with header separator cross and both rows
		assert!(all.contains('┼'), "table header separator: {all}");
		assert!(all.contains("Stage") && all.contains("render"), "table cells: {all}");

		// display math: radical with roof, fraction over "2a", plus-minus
		assert!(all.contains('±'), "plus-minus: {all}");
		assert!(all.contains("4ac"), "radicand: {all}");
		assert!(all.contains("2a"), "denominator: {all}");
		assert!(
			rows
				.iter()
				.any(|row| row.contains('√') || row.contains("┌─")),
			"radical stem or roof: {all}"
		);

		// mermaid: node labels rendered, source fence consumed
		for label in ["Parse", "Layout", "Paint"] {
			assert!(all.contains(label), "mermaid node {label}: {all}");
		}
		assert!(!all.contains("flowchart") && !all.contains("```"), "no raw fence: {all}");

		// tree guides survive verbatim with their rails
		assert!(all.contains("├── src"), "tree branch: {all}");
		assert!(all.contains("│   └── markdown"), "tree rail spacing: {all}");

		// standalone <latex> node: stretched matrix delimiters
		assert!(all.contains('⎛') && all.contains('⎝'), "pmatrix pieces: {all}");

		// <hr/>: a full-width horizontal divider row outside the box
		assert!(
			rows
				.iter()
				.any(|row| row.chars().filter(|c| *c == '─').count() > 40 && !row.contains('│')),
			"hr row: {all}"
		);
	}

	#[test]
	fn latex_node_lays_out_display_math() {
		let ui = Ui::from_markup(r"<latex>\frac{a+b}{c}</latex>", 20, UiContext::default()).unwrap();
		let rows = frame_text(&ui);
		assert!(rows.len() >= 3, "fraction needs 3 rows, got {rows:?}");
		assert!(rows.iter().any(|r| r.contains('─')), "fraction bar present: {rows:?}");
	}

	#[test]
	fn latex_falls_back_to_total_inline() {
		let ui = Ui::from_markup(r"<latex>\unknowncmd{x}</latex>", 30, UiContext::default()).unwrap();
		let rows = frame_text(&ui);
		// graceful degradation: unknown commands keep their bare name, group
		// content is preserved — the source is never dropped
		assert!(
			rows
				.iter()
				.any(|row| row.contains("unknowncmd") && row.contains('x')),
			"unsupported source degrades to inline text: {rows:?}"
		);
	}
	#[test]
	fn dynamic_md_regrafts_embedded_markup_and_stays_bounded() {
		let mut ui = Ui::from_markup("<md id=doc>plain</md>", 44, UiContext::default()).unwrap();
		let baseline = count_cached(ui.root());
		assert!(ui.set_text(
			"doc",
			"before\n\n<box border=round title=\"B\"><text>hi</text></box>\n\nafter"
		));
		let rows = frame_text(&ui);
		assert!(rows.iter().any(|row| row.contains('╭')), "box renders: {rows:?}");
		assert!(rows.iter().any(|row| row.contains("hi")));
		assert!(rows.iter().any(|row| row.contains("before")));
		assert!(rows.iter().any(|row| row.contains("after")));
		let grown = count_cached(ui.root());
		assert!(grown > baseline, "graft adds cached components");
		// live editing recycles slots instead of growing the arena
		for tick in 0..20 {
			ui.set_text("doc", format!("tick {tick}\n\n<box><text>n{tick}</text></box>"));
		}
		assert_eq!(count_cached(ui.root()), grown, "replacement graft stays bounded");
		// dropping the embed releases the graft and renders plain markdown
		ui.set_text("doc", "plain again");
		let rows = frame_text(&ui);
		assert!(!rows.iter().any(|row| row.contains('╭')), "{rows:?}");
		assert!(rows.iter().any(|row| row.contains("plain again")));
		assert!(count_cached(ui.root()) <= grown, "dropping the embed drops its subtree");
		// a literal `</md>` in dynamic text degrades to plain markdown
		ui.set_text("doc", "<box>\nx\n</md>");
		assert!(count_cached(ui.root()) <= grown, "degraded text adds no subtree");
	}
	#[test]
	fn pretty_printed_markup_renders_like_its_one_line_form() {
		// indentation between tags is structure, not content: Markdown's
		// four-space code rule is measured from the enclosing tag's column,
		// so nesting past column 4 must not turn children into code
		let dense = "<box bg=\"black\"><row gap=\"1\"><col \
		             bg=\"blue\">$$\\frac{1}{2}$$</col><hr/><col grow=\"1\" bg=\"red\" \
		             align=\"center\" valign=\"center\">Hi!!</col></row></box>";
		let spaces = "<box bg=\"black\">\n  <row gap=\"1\">\n    <col \
		              bg=\"blue\">$$\\frac{1}{2}$$</col>\n    <hr/>\n    <col grow=\"1\" bg=\"red\" \
		              align=\"center\" valign=\"center\">Hi!!</col>\n  </row>\n</box>";
		let tabs = spaces.replace("    ", "\t\t").replace("  <row", "\t<row");
		let reference = frame_text(&Ui::from_markup(dense, 40, UiContext::default()).unwrap());
		assert_eq!(
			frame_text(&Ui::from_markup(spaces, 40, UiContext::default()).unwrap()),
			reference,
			"space indented"
		);
		assert_eq!(
			frame_text(&Ui::from_markup(tabs, 40, UiContext::default()).unwrap()),
			reference,
			"tab indented"
		);
		assert!(!reference.iter().any(|row| row.contains("```")), "no code fence: {reference:?}");

		// prose nested past column 4 is prose, not an indented code block
		let prose =
			Ui::from_markup("<box>\n  <col>\n    hello\n  </col>\n</box>", 20, UiContext::default())
				.unwrap();
		let rows = frame_text(&prose);
		assert!(rows.iter().any(|row| row.contains("hello")), "{rows:?}");
		assert!(!rows.iter().any(|row| row.contains("```")), "prose stayed prose: {rows:?}");

		// but a genuine indented code block, four columns past its own
		// container, still renders as code
		let code =
			Ui::from_markup("<box>text\n\n    <hr/>\n</box>", 20, UiContext::default()).unwrap();
		assert!(
			frame_text(&code).iter().any(|row| row.contains("<hr/>")),
			"indented code stays literal"
		);
	}
	#[test]
	fn markdown_context_carries_into_embedded_elements() {
		let src = "<md>intro\n\n<box border=round><text id=lit>**raw**</text></box>\n\n<box \
		           border=round>**bold** and $$\\frac{1}{2}$$</box></md>";
		let ui = Ui::from_markup(src, 40, UiContext::default()).unwrap();
		let rows = frame_text(&ui);
		let all = rows.join("\n");
		// bare body of an md-embedded element stays markdown: emphasis is
		// styled away and display math lays out
		assert!(all.contains("bold and"), "inline markdown applied: {all}");
		assert!(!all.contains("**bold**"), "markers consumed: {all}");
		assert!(rows.iter().any(|row| row.contains('─')), "fraction bar: {all}");
		// an explicit <text> child stays verbatim
		assert!(all.contains("**raw**"), "explicit text is literal: {all}");
	}
	#[test]
	fn implicit_text_is_markdown_anywhere() {
		// no <md> wrapper: a plain container body still gets every feature
		let src = "<box border=round>**bold** · $x^2$ · #C5FFD6</box>";
		let ui = Ui::from_markup(src, 44, UiContext::default()).unwrap();
		let all = frame_text(&ui).join("\n");
		assert!(all.contains("x²"), "inline math: {all}");
		assert!(!all.contains("**bold**"), "emphasis markers consumed: {all}");
		assert!(all.contains("■"), "hex swatch chip: {all}");
	}

	#[test]
	fn markup_only_owns_its_own_tags_in_implicit_text() {
		// markdown autolinks and markdown-owned HTML stay text
		let ui = Ui::from_markup(
			"<col>see <https://example.com> now<br>next</col>",
			60,
			UiContext::default(),
		)
		.unwrap();
		let all = frame_text(&ui).join("\n");
		assert!(all.contains("https://example.com"), "autolink survives: {all}");
		assert!(all.contains("next"), "<br> is markdown, not markup: {all}");
		// a fenced literal markup tag is code, not an element
		let fenced =
			Ui::from_markup("<col>\n```\n<box>x</box>\n```\n</col>", 40, UiContext::default())
				.unwrap();
		let rows = frame_text(&fenced);
		let all = rows.join("\n");
		assert!(all.contains("<box>x</box>"), "fenced markup stays literal: {all}");
		assert!(
			!rows
				.iter()
				.any(|row| row.contains('╭') || row.contains('┌')),
			"{all}"
		);
		// every non-OMP tag is Markdown, so implicit text renders exactly
		// like the same source inside <md>
		let corpus = [
			"<em>x</em>",
			"<a href='u'>x</a>",
			"<bxo>x</bxo>",
			"<https://example.com>",
			"a<br>b",
			"<!-- c -->after",
			"`<hr/>`",
			"\\<hr/>",
			"$x <y> z$",
			"see <span>s</span> done",
		];
		for case in corpus {
			let implicit =
				Ui::from_markup(format!("<col>{case}</col>"), 44, UiContext::default()).unwrap();
			let explicit =
				Ui::from_markup(format!("<md>{case}</md>"), 44, UiContext::default()).unwrap();
			assert_eq!(frame_text(&implicit), frame_text(&explicit), "differs for {case:?}");
		}
	}
	#[test]
	fn row_children_stretch_and_valign_places_their_content() {
		use crate::Color;

		let red = Color::Rgb(0xff, 0, 0);
		let bg_column = |ui: &Ui, x: u16| {
			(0..ui.frame().size().height)
				.filter(|y| ui.frame().cell(x, *y).style.background_color() == red)
				.count()
		};

		// unset `valign` fills the line like flex `align-items: stretch`, so
		// a `bg=` panel covers its whole share of a three-row row
		let src = "<row gap=1><md>one\n\ntwo</md><col bg=red><text>hi</text></col></row>";
		let stretched = Ui::from_markup(src, 24, UiContext::default()).unwrap();
		let rows = frame_text(&stretched);
		let x = u16::try_from(rows[0].find("hi").expect("painted")).expect("small");
		assert_eq!(rows.len(), 3, "tallest child sets the height: {rows:?}");
		assert_eq!(bg_column(&stretched, x), 3, "panel fills every row: {rows:?}");

		// the panel's own `valign` then positions what is inside it
		let centered = Ui::from_markup(
			src.replace("<col bg=red>", "<col bg=red valign=center>"),
			24,
			UiContext::default(),
		)
		.unwrap();
		let rows = frame_text(&centered);
		assert!(rows[1].contains("hi"), "content centered in the panel: {rows:?}");
		assert_eq!(bg_column(&centered, x), 3, "still filled: {rows:?}");

		// `valign=start` on the row opts back out of stretching
		let top =
			Ui::from_markup(src.replace("<row ", "<row valign=start "), 24, UiContext::default())
				.unwrap();
		assert_eq!(bg_column(&top, x), 1, "panel hugs its content");
	}

	#[test]
	fn row_honors_pad_align_and_column_grow_absorbs_fixed_height() {
		use crate::Color;
		// `pad` and `align` are not box-only: a row indents and can push its
		// children to the far edge
		let padded =
			Ui::from_markup("<row pad=\"1 2\"><text>ab</text></row>", 12, UiContext::default())
				.unwrap();
		let rows = frame_text(&padded);
		assert_eq!(rows.len(), 3, "vertical padding is real: {rows:?}");
		assert_eq!(rows[1].find("ab"), Some(2), "horizontal padding indents: {rows:?}");

		let right =
			Ui::from_markup("<row align=end><text>ab</text></row>", 12, UiContext::default()).unwrap();
		assert_eq!(frame_text(&right)[0].trim_end().len(), 12, "flushed right");

		// `grow` fills leftover height in a fixed-height column, the way it
		// already filled leftover width in a row
		let column = Ui::from_markup(
			"<col h=5><text>a</text><text grow bg=red>b</text></col>",
			8,
			UiContext::default(),
		)
		.unwrap();
		let filled = (0..column.frame().size().height)
			.filter(|y| column.frame().cell(0, *y).style.background_color() == Color::Rgb(0xff, 0, 0))
			.count();
		assert_eq!(filled, 4, "grow child absorbs the four leftover rows");
	}

	#[test]
	fn leaf_padding_insets_content_and_reserves_height() {
		let ui = Ui::from_markup(r#"<text pad="1 2">ab</text>"#, 8, UiContext::default()).unwrap();
		let rows = frame_text(&ui);
		assert_eq!(ui.height(), 3, "content row plus vertical padding: {rows:?}");
		assert_eq!(rows[0], "", "top padding stays empty: {rows:?}");
		assert_eq!(rows[1].find("ab"), Some(2), "horizontal padding indents: {rows:?}");

		let narrow =
			Ui::from_markup(r#"<text pad="0 9">ab</text>"#, 4, UiContext::default()).unwrap();
		assert_eq!(narrow.height(), 1, "oversized padding still lays out safely");
	}

	#[test]
	fn text_zone_prompt_marks_its_first_and_last_rows() {
		use crate::RowMark;

		let ui = Ui::from_markup(
			r#"<col><text>above</text><text zone=prompt pad="1 1">hello world again</text><text>below</text></col>"#,
			8,
			UiContext::default(),
		)
		.unwrap();
		let frame = ui.frame();
		let rows = frame_text(&ui);
		assert_eq!(ui.height(), 7, "{rows:?}");
		assert!(frame.row_mark(1, RowMark::PromptStart), "top padding row opens: {rows:?}");
		assert!(frame.row_mark(5, RowMark::PromptEnd), "bottom padding row closes: {rows:?}");
		for row in [0, 2, 3, 4, 6] {
			assert!(!frame.row_mark(row, RowMark::PromptStart), "row {row}: {rows:?}");
		}
		for row in [0, 1, 2, 3, 4, 6] {
			assert!(!frame.row_mark(row, RowMark::PromptEnd), "row {row}: {rows:?}");
		}

		let plain = Ui::from_markup(r#"<text zone=none>hi</text>"#, 8, UiContext::default()).unwrap();
		assert!(!plain.frame().row_mark(0, RowMark::PromptStart));
		assert!(!plain.frame().row_mark(0, RowMark::PromptEnd));
	}

	#[test]
	fn boxes_are_transparent_until_bg_is_named() {
		use crate::Color;

		/// Background of the cell under `needle`'s first glyph, and of the
		/// cell just past it.
		fn bg_at(ui: &Ui, needle: &str) -> (Color, Color) {
			let rows = frame_text(ui);
			let (row, text) = rows
				.iter()
				.enumerate()
				.find(|(_, row)| row.contains(needle))
				.expect("needle painted");
			let column = text[..text.find(needle).expect("needle")].chars().count();
			let cell = |x: usize| {
				ui.frame()
					.cell(u16::try_from(x).expect("small"), u16::try_from(row).expect("small"))
					.style
					.background_color()
			};
			(cell(column), cell(column + needle.chars().count()))
		}

		let bare =
			Ui::from_markup("<box border=round><text>hi</text></box>", 20, UiContext::default())
				.unwrap();
		assert_eq!(bg_at(&bare, "hi").0, Color::Default, "no fill without bg=");

		// an explicit bg reaches every default-bg cell of the subtree, glyphs
		// included, while a nested box keeps the one it names
		let red = Color::Rgb(0xff, 0, 0);
		let blue = Color::Rgb(0, 0, 0xff);
		let nested = Ui::from_markup(
			"<box bg=red><text>outer</text><box bg=blue><text>inner</text></box></box>",
			24,
			UiContext::default(),
		)
		.unwrap();
		let (glyph, after) = bg_at(&nested, "outer");
		assert_eq!(glyph, red, "glyph cell keeps the fill");
		assert_eq!(after, red, "blank cell too");
		assert_eq!(bg_at(&nested, "inner").0, blue, "nested bg wins");

		// a plain nested box inherits instead of punching a hole
		let inherit = Ui::from_markup(
			"<box bg=red><text>a</text><box><text>bee</text></box></box>",
			24,
			UiContext::default(),
		)
		.unwrap();
		assert_eq!(bg_at(&inherit, "bee").0, red);
	}
	#[test]
	fn framed_fill_stops_at_the_border_unless_bleed() {
		use crate::Color;

		let red = Color::Rgb(0xff, 0, 0);
		let bg = |ui: &Ui, x: u16, y: u16| ui.frame().cell(x, y).style.background_color();

		// default: the fill stops inside the frame; border cells stay ambient
		let inset = Ui::from_markup(
			"<box border=round bg=red><text>hi</text></box>",
			12,
			UiContext::default(),
		)
		.unwrap();
		assert_eq!(bg(&inset, 0, 0), Color::Default, "corner stays ambient");
		assert_eq!(bg(&inset, 0, 1), Color::Default, "left rail stays ambient");
		assert_eq!(bg(&inset, 1, 1), red, "interior glyph cell filled");
		assert_eq!(bg(&inset, 10, 1), red, "interior blank cell filled");

		// `bleed` extends the fill behind the frame
		let bled = Ui::from_markup(
			"<box border=round bg=red bleed><text>hi</text></box>",
			12,
			UiContext::default(),
		)
		.unwrap();
		assert_eq!(bg(&bled, 0, 0), red, "corner adopts the fill");
		assert_eq!(bg(&bled, 0, 1), red, "left rail adopts the fill");
		assert_eq!(bg(&bled, 1, 1), red);

		// bordered rows inset the same way
		let row = Ui::from_markup(
			"<row border=square bg=red><text>x</text></row>",
			12,
			UiContext::default(),
		)
		.unwrap();
		assert_eq!(bg(&row, 0, 0), Color::Default);
		assert_eq!(bg(&row, 1, 1), red);
	}
	#[test]
	fn border_titles_and_footers_align_without_bg_leak() {
		use crate::Color;

		let red = Color::Rgb(0xff, 0, 0);
		let bg = |ui: &Ui, x: u16, y: u16| ui.frame().cell(x, y).style.background_color();

		// the fill never reaches the title or footer without `bleed`
		let inset = Ui::from_markup(
			"<box border=round bg=red title=T footer=F><text>hi</text></box>",
			12,
			UiContext::default(),
		)
		.unwrap();
		assert_eq!(bg(&inset, 3, 0), Color::Default, "title glyph stays ambient");
		assert_eq!(bg(&inset, 3, 2), Color::Default, "footer glyph stays ambient");

		// `bleed` carries it through, labels included
		let bled = Ui::from_markup(
			"<box border=round bg=red bleed title=T footer=F><text>hi</text></box>",
			12,
			UiContext::default(),
		)
		.unwrap();
		assert_eq!(bg(&bled, 3, 0), red, "title adopts the fill");
		assert_eq!(bg(&bled, 3, 2), red, "footer adopts the fill");

		// alignment places the padded label along the frame line
		let aligned = Ui::from_markup(
			"<box border=round title=T title-align=center footer=F \
			 footer-align=right><text>hi</text></box>",
			12,
			UiContext::default(),
		)
		.unwrap();
		let top = frame_row_text(aligned.frame(), 0);
		let bottom = frame_row_text(aligned.frame(), 2);
		assert_eq!(top.chars().position(|c| c == 'T'), Some(5), "centered title: {top}");
		assert_eq!(bottom.chars().position(|c| c == 'F'), Some(8), "right footer: {bottom}");

		// an overlong label truncates to the border interior instead of
		// running over the right corner into a sibling
		let tight = Ui::from_markup(
			"<row><box border=round w=8 title=abcdefghij><text>x</text></box><text>NEXT</text></row>",
			16,
			UiContext::default(),
		)
		.unwrap();
		let top = frame_row_text(tight.frame(), 0);
		assert!(
			top.contains("abc…") || (top.contains("abcd") && !top.contains("abcde")),
			"truncated: {top}"
		);
		assert_eq!(top.chars().nth(7), Some('╮'), "right corner survives: {top}");
		assert!(top.contains("NEXT"), "sibling untouched: {top}");

		// no interior cell for a glyph: the label is skipped entirely
		let narrow = Ui::from_markup(
			"<row><box border=round w=0 pad-x=0 title=Z footer=Q><text></text></box></row>",
			16,
			UiContext::default(),
		)
		.unwrap();
		let text: String = (0..3)
			.map(|row| frame_row_text(narrow.frame(), row))
			.collect();
		assert!(!text.contains('Z') && !text.contains('Q'), "labels skipped: {text}");
	}
	#[test]
	fn hr_is_a_vertical_separator_inside_a_row() {
		// a row lays children side by side; `<hr/>` between them spans the
		// row's height as a one-column divider
		let ui = Ui::from_markup(
			"<row gap=1><md>one\n\ntwo</md><hr/><text>b</text></row>",
			24,
			UiContext::default(),
		)
		.unwrap();
		let rows = frame_text(&ui);
		assert!(rows.len() >= 3, "tallest child sets the height: {rows:?}");
		let column = rows[0]
			.chars()
			.position(|glyph| glyph == '│')
			.expect("separator");
		for row in &rows {
			assert_eq!(row.chars().nth(column), Some('│'), "spans every row: {rows:?}");
		}
		assert!(rows[0].contains("one") && rows[0].contains('b'), "side by side: {rows:?}");
		// outside a row it stays the usual horizontal divider
		let stacked =
			Ui::from_markup("<col><text>x</text><hr/></col>", 12, UiContext::default()).unwrap();
		assert!(frame_text(&stacked).iter().any(|row| row.contains("────")));
		// <pre> keeps whitespace verbatim next to the divider
		let mixed =
			Ui::from_markup("<col><pre>a  b</pre><hr/></col>", 12, UiContext::default()).unwrap();
		let rows = frame_text(&mixed);
		assert!(rows.iter().any(|row| row.contains("a  b")), "verbatim run: {rows:?}");
		assert!(rows.iter().any(|row| row.contains("────")), "divider row: {rows:?}");
	}
	#[test]
	fn markdown_code_keeps_markup_literal_in_implicit_text() {
		// a fence opening immediately after the tag is still a fence
		let fenced = Ui::from_markup("<box>```\n<hr/>\n```</box>", 40, UiContext::default()).unwrap();
		let rows = frame_text(&fenced);
		let all = rows.join("\n");
		assert!(all.contains("<hr/>"), "fenced markup stays literal: {all}");
		assert!(all.contains("```"), "rendered as a code block, not a rule: {all}");
		// inline code spans too, including across a blank line (our
		// code_span scans the whole text for an equal backtick run)
		let inline = Ui::from_markup("<box>`<hr/>`</box>", 40, UiContext::default()).unwrap();
		assert!(frame_text(&inline).join("\n").contains("<hr/>"));
		let across = Ui::from_markup("<box>`a\n\n<hr/>`</box>", 40, UiContext::default()).unwrap();
		assert!(frame_text(&across).join("\n").contains("<hr/>"));
		// an UNMATCHED backtick must not swallow the rest of the body
		let unmatched =
			Ui::from_markup("<box>note ` here<text>tail</text></box>", 40, UiContext::default())
				.unwrap();
		let all = frame_text(&unmatched).join("\n");
		assert!(all.contains("tail"), "element still parsed: {all}");
		assert!(!all.contains("<text>"), "not literal: {all}");
		// a run with trailing text does not close the fence (renderer's
		// is_closing_fence requires a whitespace-only remainder)
		let sticky =
			Ui::from_markup("<box>```\n```oops\n<hr/>\n```</box>", 44, UiContext::default()).unwrap();
		let all = frame_text(&sticky).join("\n");
		assert!(all.contains("<hr/>"), "still inside the fence: {all}");
		assert!(all.contains("```oops"), "the false closer is code text: {all}");
		// indented (4-space) code is markdown-owned too, and the segment
		// keeps its indentation so the code-block path renders it
		let indented =
			Ui::from_markup("<box>text\n\n    <hr/>\n</box>", 44, UiContext::default()).unwrap();
		let rows = frame_text(&indented);
		let all = rows.join("\n");
		assert!(all.contains("<hr/>"), "indented markup stays literal: {all}");
		assert!(all.contains("```"), "rendered through the code-block path: {all}");
		// a backslash escapes the angle bracket (markdown escape); an even
		// run is a literal backslash and the tag is real markup again
		let escaped = Ui::from_markup("<box>\\<hr/></box>", 44, UiContext::default()).unwrap();
		assert!(
			!contains_component::<crate::components::Hr>(escaped.root()),
			"escaped tag builds no element"
		);
		assert!(frame_text(&escaped).join("\n").contains("<hr/>"));
		let unescaped = Ui::from_markup("<box>\\\\<hr/></box>", 44, UiContext::default()).unwrap();
		assert!(
			contains_component::<crate::components::Hr>(unescaped.root()),
			"even backslashes leave the tag as markup"
		);
		// math spans own their angle brackets; currency is not math, so the
		// tag after it is still markup
		let math = Ui::from_markup("<box>$x <y> z$</box>", 44, UiContext::default()).unwrap();
		assert!(
			!contains_component::<crate::components::Hr>(math.root()),
			"no element built inside math"
		);
		assert!(frame_text(&math).join("\n").contains('<'), "math renders literally");
		let currency =
			Ui::from_markup("<box>costs $5 and <hr/></box>", 44, UiContext::default()).unwrap();
		assert!(
			contains_component::<crate::components::Hr>(currency.root()),
			"`$5` is not a math span"
		);
		// HTML comments are stripped by Markdown, so tags inside are inert
		for src in ["<box><!-- <hr/> --></box>", "<box><!--\n<hr/>\n--></box>"] {
			let commented = Ui::from_markup(src, 44, UiContext::default()).unwrap();
			assert!(
				!contains_component::<crate::components::Hr>(commented.root()),
				"comment contents build nothing: {src}"
			);
			assert!(!frame_text(&commented).join("\n").contains("hr"), "{src}");
		}
	}

	#[test]
	fn dynamic_md_rejects_ids_and_conditions_and_scrubs_static_ones() {
		// dynamic fragments with id= or when= degrade to literal text
		let mut ui = Ui::from_markup("<md id=doc>plain</md>", 44, UiContext::default()).unwrap();
		ui.set_text("doc", "<box id=ghost><text>x</text></box>");
		assert!(!ui.set_text("ghost", "y"), "dynamic ids never register");
		assert!(
			frame_text(&ui)
				.iter()
				.any(|row| row.contains("<box id=ghost>"))
		);
		ui.set_text("doc", "<box when=\"other=on\"><text>x</text></box>");
		assert!(frame_text(&ui).iter().any(|row| row.contains("when")));

		// statically embedded ids are scrubbed when their graft is released
		let src = "<md id=doc>intro\n\n<box><text id=inner>t</text></box></md>";
		let mut ui = Ui::from_markup(src, 44, UiContext::default()).unwrap();
		assert!(ui.set_text("inner", "still live"));
		ui.set_text("doc", "plain again");
		assert!(!ui.set_text("inner", "gone"), "released slot id is unregistered");
		assert!(
			frame_text(&ui)
				.iter()
				.any(|row| row.contains("plain again"))
		);
	}
	#[test]
	fn container_fg_reaches_implicit_markdown() {
		use crate::{Color, Theme};

		let ui =
			Ui::from_markup("<col fg=#0000ff>plain `code`</col>", 32, UiContext::default()).unwrap();
		let fg_at = |needle: &str| {
			let rows = frame_text(&ui);
			let (row, text) = rows
				.iter()
				.enumerate()
				.find(|(_, row)| row.contains(needle))
				.expect("needle painted");
			let column = text[..text.find(needle).expect("needle")].chars().count();
			ui.frame()
				.cell(u16::try_from(column).expect("small"), u16::try_from(row).expect("small"))
				.style
				.foreground_color()
		};

		assert_eq!(fg_at("plain"), Color::Rgb(0, 0, 0xff), "prose adopts container fg");
		assert_eq!(fg_at("code"), Theme::default().warn, "semantic hue is preserved");
	}

	#[test]
	fn grafted_markdown_inherits_the_host_cascade() {
		use crate::Color;

		let mut ui =
			Ui::from_markup("<col fg=#0000ff><md id=m>x</md></col>", 32, UiContext::default())
				.unwrap();
		ui.set_text("m", "before\n\n<box><text>inner</text></box>");
		let fg_at = |needle: &str| {
			let rows = frame_text(&ui);
			let (row, text) = rows
				.iter()
				.enumerate()
				.find(|(_, row)| row.contains(needle))
				.expect("needle painted");
			let column = text[..text.find(needle).expect("needle")].chars().count();
			ui.frame()
				.cell(u16::try_from(column).expect("small"), u16::try_from(row).expect("small"))
				.style
				.foreground_color()
		};

		assert_eq!(fg_at("before"), Color::Rgb(0, 0, 0xff));
		assert_eq!(fg_at("inner"), Color::Rgb(0, 0, 0xff));
	}

	#[test]
	fn callout_accent_survives_flag_only_ancestors() {
		use crate::{Color, Theme};

		let ui = Ui::from_markup(
			"<col bold><callout id=e title=T>x</callout></col>",
			32,
			UiContext::default(),
		)
		.unwrap();
		let rect = find_id(ui.root(), "e").expect("id=e").rect;
		assert_eq!(
			ui.frame().cell(rect.x, rect.y).style.foreground_color(),
			Theme::default().info,
			"flag-only ancestor keeps default info accent"
		);

		let colored = Ui::from_markup(
			"<col fg=#0000ff><callout id=e title=T>x</callout></col>",
			32,
			UiContext::default(),
		)
		.unwrap();
		let rect = find_id(colored.root(), "e").expect("id=e").rect;
		assert_eq!(
			colored
				.frame()
				.cell(rect.x, rect.y)
				.style
				.foreground_color(),
			Color::Rgb(0, 0, 0xff),
			"inherited fg colors the rail"
		);
	}

	/// Architecture proof, mirrors /tmp/ui-bench scenarios: steady-state
	/// updates must be orders of magnitude cheaper than rebuilds. Run:
	/// `cargo nextest run -p omp-tui --release --run-ignored ignored-only
	/// --no-capture -E 'test(perf)'`
	#[test]
	#[ignore = "release-mode perf smoke, run explicitly"]
	fn perf_two_tier_updates() {
		use std::{fmt::Write as _, time::Instant};

		let mut src = String::from("<col>");
		for i in 0..1000 {
			let _ = write!(
				src,
				"<box><row gap=1><text>service unit {i} nominal</text><text id=c{i} min=16>counter \
				 0</text></row></box>"
			);
		}
		src.push_str("</col>");

		let t0 = Instant::now();
		let mut ui = Ui::from_markup(src.clone(), 120, UiContext::default()).unwrap();
		let build = t0.elapsed();

		let t0 = Instant::now();
		const FRAMES: u32 = 2000;
		for i in 0..FRAMES {
			ui.set_text(&format!("c{}", i % 1000), format!("counter {i}"));
		}
		let steady = t0.elapsed() / FRAMES;

		let t0 = Instant::now();
		let rebuilt = Ui::from_markup(src, 120, UiContext::default()).unwrap();
		let rebuild = t0.elapsed();
		assert_eq!(rebuilt.height(), ui.height());

		println!(
			"build {build:?}  steady {steady:?}/update  rebuild {rebuild:?}  rows {}",
			ui.height()
		);
		// the architectural claim: steady-state is at least 100x cheaper
		// than rebuilding the document
		assert!(steady.as_nanos() * 100 < rebuild.as_nanos());
	}

	/// Presentation must scale with damage, not component-frame size: one
	/// counter tick on a four-times-taller, bottom-clipped frame presents in
	/// comparable time. Run with the perf smoke:
	/// `cargo nextest run -p omp-tui --release --run-ignored ignored-only
	/// --no-capture -E 'test(perf)'`
	#[test]
	#[ignore = "release-mode perf smoke, run explicitly"]
	fn perf_present_scales_with_damage() {
		use std::{fmt::Write as _, time::Instant};

		use crate::Renderer;

		let steady_present = |sections: usize| {
			let mut src = String::from("<col>");
			for i in 0..sections {
				let _ = write!(
					src,
					"<box><row gap=1><text>service unit {i} nominal</text><text id=c{i} min=16>counter \
					 0</text></row></box>"
				);
			}
			src.push_str("</col>");
			let mut ui = Ui::from_markup(src, 120, UiContext::default()).unwrap();
			let mut renderer = Renderer::new(io::sink());
			ui.present(&mut renderer, 40).unwrap();
			const FRAMES: u32 = 2000;
			let t0 = Instant::now();
			for i in 0..FRAMES {
				ui.set_text(&format!("c{}", i % sections as u32), format!("counter {i}"));
				ui.present(&mut renderer, 40).unwrap();
			}
			(t0.elapsed() / FRAMES, ui.frame().size().height)
		};

		let (small, small_rows) = steady_present(1000);
		let (large, large_rows) = steady_present(4000);
		println!(
			"present steady: {small:?}/event @ {small_rows} rows vs {large:?}/event @ {large_rows} \
			 rows"
		);
		// 4x the document must NOT cost 4x the event: allow 2x jitter
		assert!(
			large.as_nanos() < small.as_nanos() * 2,
			"presentation is not damage-proportional: {small:?} -> {large:?}"
		);
	}
	#[test]
	fn fg_and_bg_gradients_paint_boxes_at_the_requested_angle() {
		let plain = Ui::from_markup("<pre>  AB\n C</pre>", 4, UiContext::default()).unwrap();
		assert_eq!(frame_text(&plain), ["  AB", " C"]);

		let mut ui = Ui::from_markup(r##"<box bg="#000000..#ffffff" fg="#ff0000..#0000ff" angle=90 pad="0 0"><text id=copy>ab</text><text>cd</text></box>"##, 4, UiContext::default())
		.unwrap();
		let colors = |ui: &Ui, x: u16, y: u16| {
			let style = &ui.frame().cell(x, y).style;
			(style.foreground_color(), style.background_color())
		};
		let (top_fg, top_bg) = colors(&ui, 1, 1);
		let (bottom_fg, bottom_bg) = colors(&ui, 1, 2);
		assert_ne!(top_bg, bottom_bg, "angle=90 makes the box background vertical");
		assert_eq!(top_bg, colors(&ui, 2, 1).1);
		assert_ne!(top_fg, bottom_fg, "box fg= cascades a vertical text gradient");
		assert_eq!(top_fg, colors(&ui, 2, 1).0);

		assert!(ui.set_text("copy", "xy"));
		assert_eq!(colors(&ui, 1, 1).1, top_bg, "incremental text paint restores the gradient");

		let horizontal =
			Ui::from_markup(r##"<text fg="#000000..#ffffff">ab</text>"##, 2, UiContext::default())
				.unwrap();
		assert_ne!(
			horizontal.frame().cell(0, 0).style.foreground_color(),
			horizontal.frame().cell(1, 0).style.foreground_color(),
			"the default angle is horizontal",
		);

		let diagonal = Ui::from_markup(
			r##"<pre fg="#000000..#ffffff" angle=45>ab
cd</pre>"##,
			2,
			UiContext::default(),
		)
		.unwrap();
		let diagonal_colors = |x, y| diagonal.frame().cell(x, y).style.foreground_color();
		assert_ne!(diagonal_colors(0, 0), diagonal_colors(1, 1));
		assert_eq!(diagonal_colors(1, 0), diagonal_colors(0, 1));

		let explicit = Ui::from_markup(
			r##"<box fg="#000000..#ffffff" pad="0 0"><text fg=red>x</text></box>"##,
			3,
			UiContext::default(),
		)
		.unwrap();
		assert_eq!(explicit.frame().cell(1, 1).style.foreground_color(), Color::Rgb(255, 0, 0));
	}
	#[test]
	fn layout_macro_builds_ui_and_preserves_text_props() {
		let ui = Ui::from_root(
			dom! { <box bg=yellow><text italic>{"hi"}</text></box> },
			20,
			UiContext::default(),
		);
		let rows = (0..ui.frame().size().height)
			.map(|row| frame_row_text(ui.frame(), row))
			.collect::<Vec<_>>();
		assert!(rows.iter().any(|row| row.contains("hi")));
		let painted = rows.join("\n");
		for glyph in ['┌', '┐', '└', '┘', '─', '│'] {
			assert!(painted.contains(glyph), "missing box border glyph {glyph:?}");
		}

		let text = &ui.root.comp().children()[0];
		assert_eq!(text.comp().props().get(Prop::Italic), Some(PropValue::Bool(true)),);
	}

	#[test]
	fn layout_macro_builds_and_paints_representative_tree() {
		let x = "hey";
		let ui = Ui::from_root(
			omp_tui::dom! {
				<box bg=yellow><row><col fg=blue><i:new/><text italic> {x} </text></col></row></box>
			},
			20,
			UiContext::default(),
		);
		let painted = (0..ui.frame().size().height)
			.map(|row| frame_row_text(ui.frame(), row))
			.collect::<Vec<_>>()
			.join("\n");
		assert!(painted.contains("hey"));
		assert!(painted.contains('┌') && painted.contains('┘'));
	}

	#[test]
	fn layout_macro_control_flow_builds_selected_children() {
		let mode = 2;
		let labels = ["loop-a", "loop-b"];
		let ui = Ui::from_root(
			dom! {
				<col>
					for label in labels {
						<text>{label}</text>
					}
					if mode == 0 {
						<text>"if-zero"</text>
					} else if mode == 1 {
						<text>"if-one"</text>
					} else {
						<text>"if-many"</text>
					}
					match mode {
						0 => <text>"match-zero"</text>,
						1 => <text>"match-one"</text>,
						value if value > 1 => {
							<text>"match-many"</text>
							<text>"match-tail"</text>
						},
						_ => {},
					}
				</col>
			},
			20,
			UiContext::default(),
		);
		let painted = (0..ui.frame().size().height)
			.map(|row| frame_row_text(ui.frame(), row))
			.collect::<Vec<_>>()
			.join("\n");
		for expected in ["loop-a", "loop-b", "if-many", "match-many", "match-tail"] {
			assert!(painted.contains(expected), "missing selected child {expected:?}");
		}
		for skipped in ["if-zero", "if-one", "match-zero", "match-one"] {
			assert!(!painted.contains(skipped), "rendered skipped child {skipped:?}");
		}
	}

	/// Paints the 10ms-step counter digit and re-requests wakes until `stop`.
	struct Blinker {
		props: Props,
		slot:  Slot,
		stop:  Duration,
	}

	impl Blinker {
		fn until(stop: Duration) -> Self {
			Self { props: Props::new(), slot: next_slot(), stop }
		}
	}

	impl Component for Blinker {
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
			(1, 1)
		}

		fn height(&mut self, _ctx: &UiContext, _width: u16) -> u16 {
			1
		}

		fn paint(&mut self, pc: &mut PaintCtx<'_>, rect: Rect) {
			let step = (pc.now.as_millis() / 10) % 10;
			pc.frame
				.put(rect.x, rect.y, &step.to_string(), Style::default());
			if pc.now < self.stop {
				pc.wake(self.slot, pc.now + Duration::from_millis(10));
			}
		}
	}

	#[test]
	fn tick_repaints_due_animations_until_the_component_stops_asking() {
		let mut ui =
			Ui::from_root(Blinker::until(Duration::from_millis(20)), 3, UiContext::default());
		assert_eq!(frame_text(&ui)[0], "0");
		assert_eq!(ui.next_wake(), Some(Duration::from_millis(10)));

		assert!(!ui.tick(Duration::from_millis(5)), "nothing is due before the deadline");
		assert!(ui.tick(Duration::from_millis(10)));
		assert_eq!(frame_text(&ui)[0], "1");

		assert!(ui.tick(Duration::from_millis(20)));
		assert_eq!(frame_text(&ui)[0], "2");
		assert_eq!(ui.next_wake(), None, "the final paint stopped requesting wakes");
		assert!(!ui.tick(Duration::from_millis(30)));
	}

	#[test]
	fn resize_rebuilds_the_wake_schedule_without_duplicates() {
		let mut ui = Ui::from_root(Blinker::until(Duration::from_secs(1)), 3, UiContext::default());
		ui.tick(Duration::from_millis(10));
		ui.resize(5);
		assert_eq!(ui.next_wake(), Some(Duration::from_millis(20)));
		assert_eq!(ui.wakes.len(), 1, "a full relayout replaces the schedule");
	}

	#[test]
	fn wake_requests_keep_the_earliest_deadline_per_slot() {
		let mut frame = Frame::new(Size::new(1, 1));
		let mut hits = Vec::new();
		let mut wakes = Vec::new();
		let ctx = UiContext::default();
		let mut pc = PaintCtx::new(&mut frame, &ctx, &mut hits, &mut wakes);
		pc.wake(7, Duration::from_millis(20));
		pc.wake(7, Duration::from_millis(10));
		pc.wake(7, Duration::from_millis(30));
		pc.wake(9, Duration::from_millis(5));
		assert_eq!(wakes, vec![
			Wake { slot: 7, at: Duration::from_millis(10), layout: false },
			Wake { slot: 9, at: Duration::from_millis(5), layout: false },
		]);
	}

	struct MouseRecorder {
		props: Props,
		slot:  Slot,
		seen:  rc::Rc<cell::RefCell<Vec<Mouse>>>,
	}

	impl Component for MouseRecorder {
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
			(4, 4)
		}

		fn height(&mut self, _ctx: &UiContext, _width: u16) -> u16 {
			1
		}

		fn paint(&mut self, pc: &mut PaintCtx<'_>, rect: Rect) {
			pc.hits
				.push(Hit { rect, slot: self.slot, tag: HitTag::Press });
		}

		fn mouse(
			&mut self,
			_ec: &mut EventCtx<'_>,
			_tag: HitTag,
			_at: (u16, u16),
			_rect: Rect,
			mouse: Mouse,
		) -> Flow {
			self.seen.borrow_mut().push(mouse);
			Flow::Consumed
		}
	}

	#[test]
	fn right_click_reaches_the_hit_component() {
		let seen = rc::Rc::new(cell::RefCell::new(Vec::new()));
		let root =
			MouseRecorder { props: Props::new(), slot: next_slot(), seen: rc::Rc::clone(&seen) };
		let mut ui = Ui::from_root(root, 4, UiContext::default());
		let hit = ui.hits()[0];
		assert_eq!(ui.handle_mouse(hit.rect.x, hit.rect.y, Mouse::RightClick), UiEvent::None);
		ui.handle_mouse(u16::MAX, u16::MAX, Mouse::Release);
		ui.handle_mouse(u16::MAX, u16::MAX, Mouse::Release);
		assert_eq!(&*seen.borrow(), &[Mouse::RightClick, Mouse::Release]);
	}

	/// Paints a label read through shared interior mutability.
	struct SharedLabel {
		props: Props,
		slot:  Slot,
		text:  rc::Rc<cell::RefCell<&'static str>>,
	}

	impl Component for SharedLabel {
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
			(8, 8)
		}

		fn height(&mut self, _ctx: &UiContext, _width: u16) -> u16 {
			1
		}

		fn paint(&mut self, pc: &mut PaintCtx<'_>, rect: Rect) {
			pc.frame
				.put(rect.x, rect.y, &self.text.borrow(), Style::default());
		}
	}

	#[test]
	fn invalidate_refreshes_a_component_reading_shared_state() {
		let text = rc::Rc::new(cell::RefCell::new("before"));
		let mut props = Props::new();
		props.set(Prop::Id, "label");
		let root = SharedLabel { props, slot: next_slot(), text: rc::Rc::clone(&text) };
		let mut ui = Ui::from_root(root, 8, UiContext::default());
		assert_eq!(frame_text(&ui)[0], "before");

		*text.borrow_mut() = "after";
		assert!(ui.invalidate("label"));
		assert_eq!(frame_text(&ui)[0], "after");
		assert!(!ui.invalidate("missing"));
	}

	fn set_prop(ui: &mut Ui, id: &str, prop: Prop, value: PropValue) {
		assert!(ui.set_prop(id, prop, value), "component exists");
	}

	#[test]
	fn fixed_height_clips_overflowing_content_to_the_content_box() {
		let source = "<col><box h=4><text>l1\nl2\nl3\nl4\nl5</text></box><text>after</text></col>";
		let ui = Ui::from_markup(source, 10, UiContext::default()).unwrap();
		let rows = frame_text(&ui);
		assert_eq!(ui.height(), 5, "the box holds its fixed height");
		assert!(rows[1].contains("l1") && rows[2].contains("l2"));
		assert!(
			rows[3].starts_with('└') || rows[3].starts_with('+'),
			"overflow must not eat the bottom border: {rows:?}"
		);
		assert_eq!(rows[4], "after", "overflow must not spill into siblings: {rows:?}");
		assert!(!rows.join("\n").contains("l3"), "rows past the budget clip: {rows:?}");

		// Mid-flight height samples clip the same way: shrink with anim on.
		let mut ui = Ui::from_markup(
			"<col><box id=d h=6 anim=100ms \
			 ease=linear><text>l1\nl2\nl3\nl4</text></box><text>after</text></col>",
			10,
			UiContext::default(),
		)
		.unwrap();
		assert!(ui.set_height("d", 4));
		ui.tick(Duration::from_millis(50));
		let rows = frame_text(&ui);
		// Sampled height 5: top border + 3 content rows + bottom border.
		assert!(rows[4].starts_with('└'), "animated border stays on top of content: {rows:?}");
		assert_eq!(rows[5], "after");
	}

	#[test]
	fn anim_tweens_a_solid_background_change_through_ticks() {
		let mut ui = Ui::from_markup(
			"<col id=b bg=#000000 anim=100ms ease=linear><text>x</text></col>",
			3,
			UiContext::default(),
		)
		.unwrap();
		assert_eq!(ui.frame().cell(0, 0).style.background_color(), Color::Rgb(0, 0, 0));
		assert_eq!(ui.next_wake(), None, "a settled transition owes no frames");

		set_prop(&mut ui, "b", Prop::Bg, PropValue::Color(Color::Rgb(200, 200, 200)));
		// The refresh painted at t=0: still black, but a frame is now owed.
		assert_eq!(ui.frame().cell(0, 0).style.background_color(), Color::Rgb(0, 0, 0));
		assert!(ui.next_wake().is_some());

		assert!(ui.tick(Duration::from_millis(50)));
		assert_eq!(ui.frame().cell(0, 0).style.background_color(), Color::Rgb(100, 100, 100));
		// The target prop itself is untouched by the mid-flight swap.
		let target = ui
			.root
			.update_id("b", |cached| (cached.comp().props().get(Prop::Bg), false))
			.unwrap();
		assert_eq!(target, Some(PropValue::Color(Color::Rgb(200, 200, 200))));

		ui.tick(Duration::from_millis(100));
		assert_eq!(ui.frame().cell(0, 0).style.background_color(), Color::Rgb(200, 200, 200));
		assert_eq!(ui.next_wake(), None, "settling stops the wake schedule");
	}

	#[test]
	fn anim_tweens_text_foreground_through_the_content_paint() {
		let mut ui = Ui::from_markup(
			"<text id=t fg=#000000 anim=100ms ease=linear>x</text>",
			3,
			UiContext::default(),
		)
		.unwrap();
		set_prop(&mut ui, "t", Prop::Fg, PropValue::Color(Color::Rgb(0, 0, 200)));
		ui.tick(Duration::from_millis(50));
		assert_eq!(ui.frame().cell(0, 0).style.foreground_color(), Color::Rgb(0, 0, 100));
		ui.tick(Duration::from_millis(100));
		assert_eq!(ui.frame().cell(0, 0).style.foreground_color(), Color::Rgb(0, 0, 200));
	}

	#[test]
	fn anim_tweens_gradient_endpoints_as_a_ramp() {
		let mut ui = Ui::from_markup(
			"<col id=b bg=#000000..#000000 anim=100ms ease=linear><text>x</text></col>",
			3,
			UiContext::default(),
		)
		.unwrap();
		set_prop(&mut ui, "b", Prop::Bg, PropValue::from("#646464..#646464"));
		ui.tick(Duration::from_millis(50));
		assert_eq!(ui.frame().cell(0, 0).style.background_color(), Color::Rgb(50, 50, 50));
		ui.tick(Duration::from_millis(100));
		assert_eq!(ui.frame().cell(0, 0).style.background_color(), Color::Rgb(100, 100, 100));
		assert_eq!(ui.next_wake(), None);
	}

	#[test]
	fn spin_rotates_a_gradient_on_the_shared_clock() {
		let mut ui = Ui::from_markup(
			"<col bg=#000000..#ffffff spin=360ms><text>ab</text></col>",
			2,
			UiContext::default(),
		)
		.unwrap();
		assert_eq!(ui.frame().cell(0, 0).style.background_color(), Color::Rgb(0, 0, 0));
		assert_eq!(ui.frame().cell(1, 0).style.background_color(), Color::Rgb(255, 255, 255));
		assert!(ui.next_wake().is_some(), "a spinning gradient always owes a frame");

		// Half a revolution reverses the ramp.
		assert!(ui.tick(Duration::from_millis(180)));
		assert_eq!(ui.frame().cell(0, 0).style.background_color(), Color::Rgb(255, 255, 255));
		assert_eq!(ui.frame().cell(1, 0).style.background_color(), Color::Rgb(0, 0, 0));
		assert!(ui.next_wake().is_some(), "spin never settles");
	}

	#[test]
	fn shimmer_sweeps_a_bold_crest_across_text() {
		let mut ui = Ui::from_markup(
			"<text shimmer=1s fg=#606060>abcdefghijklmnopqrstuvwxyz</text>",
			26,
			UiContext::default(),
		)
		.unwrap();
		// The crest starts on the runway left of the text: shimmer is
		// additive, so every cell rests at the authored color.
		let style = |ui: &Ui, x: u16| ui.frame().cell(x, 0).style;
		let rest = Color::Rgb(0x60, 0x60, 0x60);
		assert_eq!(style(&ui, 0).foreground_color(), rest);
		assert!(!style(&ui, 13).bold);
		assert!(ui.next_wake().is_some(), "a shimmering text always owes a frame");

		// Half a period in, the crest peaks at cell 13 (track = 26 + 2×10
		// runway cells): two-fifths toward white and bold at the peak,
		// one-fifth on the shoulders, the authored color beyond.
		assert!(ui.tick(Duration::from_millis(500)));
		assert_eq!(style(&ui, 13).foreground_color(), Color::Rgb(159, 159, 159));
		assert!(style(&ui, 13).bold);
		assert_eq!(style(&ui, 16).foreground_color(), Color::Rgb(127, 127, 127));
		assert!(!style(&ui, 16).bold);
		assert_eq!(style(&ui, 0).foreground_color(), rest);
		assert_eq!(style(&ui, 25).foreground_color(), rest);
		assert!(ui.next_wake().is_some(), "shimmer never settles");
	}

	#[test]
	fn layout_macro_lowers_shimmer_onto_text() {
		let mut ui = Ui::from_root(
			dom! { <text shimmer="1s">{"abcdefghijklmnopqrstuvwxyz"}</text> },
			26,
			UiContext::default(),
		);
		let style = |ui: &Ui, x: u16| ui.frame().cell(x, 0).style;
		// Colorless text has no channels to lift: rest stays untouched.
		assert!(!style(&ui, 0).dim && !style(&ui, 0).bold);
		assert!(ui.next_wake().is_some(), "macro-built shimmer owes a frame");
		assert!(ui.tick(Duration::from_millis(500)));
		assert!(style(&ui, 13).bold, "only the crest peak bolds");
		assert!(!style(&ui, 0).bold && !style(&ui, 0).dim);
	}

	#[test]
	fn anim_tweens_a_fixed_height_through_layout_wakes() {
		let mut ui = Ui::from_markup(
			"<col id=b h=2 anim=100ms ease=linear><text>x</text></col>",
			3,
			UiContext::default(),
		)
		.unwrap();
		assert_eq!(ui.height(), 2);
		let slot = find_id(ui.root(), "b")
			.expect("animated column exists")
			.comp()
			.slot();

		assert!(ui.set_height("b", 6));
		assert_eq!(ui.height(), 2, "the transition starts from the on-screen size");
		assert!(
			!ui.root
				.find_slot(slot)
				.unwrap()
				.height_settled(Duration::ZERO)
		);
		assert!(ui.next_wake().is_some());

		ui.tick(Duration::from_millis(50));
		assert_eq!(ui.height(), 4);
		let ctx = ui.ctx.clone();
		assert_eq!(ui.root.find_slot(slot).unwrap().sampled_h(&ctx), Some(4));
		assert!(
			!ui.root
				.find_slot(slot)
				.unwrap()
				.height_settled(Duration::from_millis(50))
		);
		ui.tick(Duration::from_millis(100));
		assert_eq!(ui.height(), 6);
		assert!(
			ui.root
				.find_slot(slot)
				.unwrap()
				.height_settled(Duration::from_millis(100))
		);
		assert_eq!(ui.next_wake(), None);
		assert!(!ui.tick(Duration::from_millis(200)));
	}

	#[test]
	fn anim_tweens_a_row_width_by_resolving_the_row() {
		let mut ui = Ui::from_markup(
			"<row><col id=a w=2 h=1 anim=100ms ease=linear bg=#ff0000></col><col h=1 grow \
			 bg=#0000ff></col></row>",
			6,
			UiContext::default(),
		)
		.unwrap();
		let red_cells = |ui: &Ui| {
			(0..6u16)
				.filter(|&x| ui.frame().cell(x, 0).style.background_color() == Color::Rgb(255, 0, 0))
				.count()
		};
		assert_eq!(red_cells(&ui), 2);

		set_prop(&mut ui, "a", Prop::W, PropValue::U16(4));
		assert_eq!(red_cells(&ui), 2, "the transition starts from the on-screen width");
		ui.tick(Duration::from_millis(50));
		assert_eq!(red_cells(&ui), 3);
		ui.tick(Duration::from_millis(100));
		assert_eq!(red_cells(&ui), 4);
		assert_eq!(ui.next_wake(), None);
	}

	fn overlay_paint(renderer: &mut Renderer<Vec<u8>>) -> String {
		let bytes = mem::take(renderer.writer_mut());
		String::from_utf8(bytes).expect("renderer output is UTF-8")
	}

	#[test]
	fn overlay_composites_centered_and_close_restores_document() {
		use crate::test_support::TerminalModel;

		let mut ui = Ui::from_markup(
			"<col><text>alpha</text><text>beta</text><text>gamma</text></col>",
			11,
			UiContext::default(),
		)
		.unwrap();
		let mut renderer = Renderer::new(Vec::new());
		let mut terminal = TerminalModel::new(11, 3);
		let id = ui.show_overlay(
			dom! { <text>{"OV"}</text> },
			OverlayOptions::default().width(Dim::Cells(2)),
		);
		assert!(ui.has_damage(), "showing an overlay schedules a present");
		ui.present(&mut renderer, 3).unwrap();
		terminal.apply(&overlay_paint(&mut renderer));
		assert_eq!(terminal.visible_rows()[1], "betaOV", "centered layer over the middle row");
		assert!(ui.has_overlay());

		assert!(ui.close_overlay(id));
		assert!(ui.has_damage(), "closing an overlay schedules a present");
		ui.present(&mut renderer, 3).unwrap();
		terminal.apply(&overlay_paint(&mut renderer));
		assert_eq!(terminal.visible_rows(), ["alpha", "beta", "gamma"]);
		assert!(!ui.has_overlay());
	}

	#[test]
	fn z_orders_layers_regardless_of_creation_order() {
		use crate::test_support::TerminalModel;

		let mut ui = Ui::from_markup(
			"<col><text>alpha</text><text>beta</text><text>gamma</text></col>",
			11,
			UiContext::default(),
		)
		.unwrap();
		let mut renderer = Renderer::new(Vec::new());
		let mut terminal = TerminalModel::new(11, 3);
		let a_id = ui.show_overlay(
			dom! { <text>{"AA"}</text> },
			OverlayOptions::default().width(Dim::Cells(2)),
		);
		ui.show_overlay(
			dom! { <text>{"BB"}</text> },
			OverlayOptions::default().width(Dim::Cells(2)).z(-1),
		);

		ui.present(&mut renderer, 3).unwrap();
		terminal.apply(&overlay_paint(&mut renderer));
		assert_eq!(terminal.visible_rows()[1], "betaAA");
		assert_eq!(ui.top_overlay(), Some(a_id));

		// input follows z too: a typed key lands in the top-z tree, not the
		// newest one
		let mut ui = Ui::from_markup("<input id=base/>", 20, UiContext::default()).unwrap();
		let high = ui.show_overlay(dom! { <input id=high/> }, OverlayOptions::default());
		let low = ui.show_overlay(dom! { <input id=low/> }, OverlayOptions::default().z(-1));
		ui.handle_key(Key::Char('x'));
		assert_eq!(
			ui.overlay(high).expect("high tree").values()["high"],
			"x",
			"keys land in the top-z layer"
		);
		assert_eq!(ui.overlay(low).expect("low tree").values()["low"], "");
		assert_eq!(ui.values()["base"], "", "base never saw the key");
	}

	#[test]
	fn values_include_visible_overlay_layers() {
		let mut ui = Ui::from_markup("<input id=base/>", 20, UiContext::default()).unwrap();
		let dialog = ui.show_overlay(dom! { <input id=secret/> }, OverlayOptions::default());
		ui.handle_key(Key::Char('k'));
		assert_eq!(ui.values()["secret"], "k", "overlay inputs report through merged values");
		assert_eq!(ui.values()["base"], "", "base entries stay present beside overlay entries");

		ui.set_overlay_hidden(dialog, true);
		assert_eq!(ui.values().get("secret"), None, "hidden layers drop out of the merged map");
	}

	#[test]
	fn overlay_captures_keys_and_base_keeps_focus() {
		let mut ui = Ui::from_markup("<input id=base/>", 20, UiContext::default()).unwrap();
		ui.handle_key(Key::Char('a'));
		let id = ui.show_overlay(dom! { <input id=modal/> }, OverlayOptions::default());
		ui.handle_key(Key::Char('b'));
		assert_eq!(ui.values()["base"], "a", "overlay keys never reach the base tree");
		assert_eq!(ui.overlay(id).expect("overlay tree").values()["modal"], "b");

		ui.close_overlay(id);
		ui.handle_key(Key::Char('c'));
		assert_eq!(ui.values()["base"], "ac", "base focus survives the overlay untouched");
	}

	#[test]
	fn focusless_overlay_escape_surfaces_cancel() {
		let mut ui = Ui::from_markup("<input id=base/>", 20, UiContext::default()).unwrap();
		ui.show_overlay(dom! { <text>{"note"}</text> }, OverlayOptions::default());
		assert_eq!(ui.handle_key(Key::Esc), UiEvent::Cancel);
		assert!(ui.close_top_overlay().is_some());
		assert_eq!(ui.handle_key(Key::Esc), UiEvent::Cancel, "base fallback still cancels");
	}

	#[test]
	fn bottom_clipped_base_hit_uses_viewport_coordinates() {
		let mut ui = Ui::from_markup(
			"<col><button id=top>aa</button><button id=bottom>bb</button></col>",
			12,
			UiContext::default(),
		)
		.unwrap();
		let bottom_hit = ui
			.hits()
			.iter()
			.find(|hit| {
				find_id(ui.root(), "bottom").is_some_and(|cached| cached.comp().slot() == hit.slot)
			})
			.copied()
			.expect("bottom button paints a hit region");
		let mut renderer = Renderer::new(Vec::new());
		ui.present(&mut renderer, 1).unwrap();
		assert_eq!(ui.viewport_frame.size(), Size::new(12, 1));
		assert_eq!(
			frame_row_text(&ui.viewport_frame, 0),
			frame_row_text(&ui.frame, bottom_hit.rect.y)
		);

		assert_eq!(
			ui.handle_mouse(bottom_hit.rect.x, 0, Mouse::Click),
			UiEvent::Pressed(sf!("bottom"))
		);
	}

	#[test]
	fn overlay_occludes_mouse_within_bounds_and_falls_through_outside() {
		let mut ui = Ui::from_markup(
			"<row><button id=left>aa</button><button id=right>bb</button></row>",
			24,
			UiContext::default(),
		)
		.unwrap();
		let right_hit = ui
			.hits()
			.iter()
			.find(|hit| {
				find_id(ui.root(), "right").is_some_and(|cached| cached.comp().slot() == hit.slot)
			})
			.copied()
			.expect("right button paints a hit region");
		let id = ui.show_overlay(
			dom! { <text>{"overlay"}</text> },
			OverlayOptions::default()
				.width(Dim::Cells(right_hit.rect.x))
				.col(Dim::Cells(0))
				.row(Dim::Cells(0)),
		);
		let mut renderer = Renderer::new(Vec::new());
		ui.present(&mut renderer, 1).unwrap();

		assert_eq!(
			ui.handle_mouse(1, 0, Mouse::Click),
			UiEvent::None,
			"click under the layer is occluded"
		);
		assert_eq!(
			ui.handle_mouse(right_hit.rect.x, right_hit.rect.y, Mouse::Click),
			UiEvent::Pressed(sf!("right")),
			"click outside the layer falls through to the base tree"
		);
		ui.close_overlay(id);
	}

	#[test]
	fn hidden_overlay_releases_input_and_compositing() {
		use crate::test_support::TerminalModel;

		let mut ui = Ui::from_markup("<input id=base/>", 12, UiContext::default()).unwrap();
		let mut renderer = Renderer::new(Vec::new());
		let mut terminal = TerminalModel::new(12, 1);
		let id = ui.show_overlay(
			dom! { <text>{"OV"}</text> },
			OverlayOptions::default().width(Dim::Cells(2)),
		);
		ui.present(&mut renderer, 1).unwrap();
		terminal.apply(&overlay_paint(&mut renderer));
		assert!(terminal.visible_rows()[0].contains("OV"));

		assert!(ui.set_overlay_hidden(id, true));
		ui.handle_key(Key::Char('x'));
		assert_eq!(ui.values()["base"], "x", "hidden overlays release the keyboard");
		ui.present(&mut renderer, 1).unwrap();
		terminal.apply(&overlay_paint(&mut renderer));
		assert!(!terminal.visible_rows()[0].contains("OV"), "hidden overlays stop compositing");

		assert!(ui.set_overlay_hidden(id, false));
		ui.handle_key(Key::Char('y'));
		assert_eq!(ui.values()["base"], "x", "reshown overlays capture the keyboard again");
	}

	#[test]
	#[should_panic(expected = "overlays stack on the presenting Ui")]
	fn overlay_tree_rejects_nested_overlays() {
		let mut ui = Ui::from_markup("<text>base</text>", 20, UiContext::default()).unwrap();
		let id = ui.show_overlay(dom! { <text>{"layer"}</text> }, OverlayOptions::default());
		ui.overlay_mut(id)
			.expect("overlay tree")
			.show_overlay(dom! { <text>{"nested"}</text> }, OverlayOptions::default());
	}

	#[test]
	fn non_modal_layer_leaves_keyboard_with_base_tree() {
		let mut ui = Ui::from_markup("<input id=base/>", 20, UiContext::default()).unwrap();
		let rail = ui.show_overlay(dom! { <input id=side/> }, OverlayOptions::default().non_modal());
		ui.handle_key(Key::Char('x'));
		assert_eq!(ui.values()["base"], "x", "keys stay with the base tree");
		assert_eq!(ui.overlay(rail).expect("rail tree").values()["side"], "");
		assert!(!ui.has_overlay(), "a non-modal layer never holds the alternate screen");
		assert_eq!(ui.top_overlay(), None, "no layer receives keys");
	}

	#[test]
	fn focus_overlay_hands_keys_to_layer_and_blur_returns_them() {
		let mut ui = Ui::from_markup("<input id=base/>", 20, UiContext::default()).unwrap();
		let rail = ui.show_overlay(dom! { <input id=side/> }, OverlayOptions::default().non_modal());
		assert!(ui.focus_overlay(rail));
		assert_eq!(ui.top_overlay(), Some(rail));
		ui.handle_key(Key::Char('x'));
		assert_eq!(ui.overlay(rail).expect("rail tree").values()["side"], "x");
		assert_eq!(ui.values()["base"], "");

		assert_eq!(ui.blur_overlay(), Some(rail));
		assert_eq!(ui.focused_overlay(), None);
		ui.handle_key(Key::Char('y'));
		assert_eq!(ui.values()["base"], "y", "the base tree resumes typing");
	}

	#[test]
	fn unconsumed_escape_blurs_a_focused_non_modal_layer() {
		let mut ui = Ui::from_markup("<input id=base/>", 20, UiContext::default()).unwrap();
		let rail = ui.show_overlay(
			dom! { <button id=side>{"ok"}</button> },
			OverlayOptions::default().non_modal(),
		);
		ui.focus_overlay(rail);
		assert_eq!(ui.handle_key(Key::Esc), UiEvent::None, "the blur consumes the escape");
		assert_eq!(ui.focused_overlay(), None);
		assert!(ui.overlay(rail).is_some(), "nothing is dismissed");
		ui.handle_key(Key::Char('z'));
		assert_eq!(ui.values()["base"], "z");
	}

	#[test]
	fn modal_overlay_outranks_a_focused_non_modal_layer() {
		let mut ui = Ui::from_markup("<input id=base/>", 20, UiContext::default()).unwrap();
		let rail = ui.show_overlay(dom! { <input id=side/> }, OverlayOptions::default().non_modal());
		ui.focus_overlay(rail);
		let dialog = ui.show_overlay(dom! { <input id=modal/> }, OverlayOptions::default());
		assert!(ui.has_overlay());
		ui.handle_key(Key::Char('m'));
		assert_eq!(ui.overlay(dialog).expect("dialog tree").values()["modal"], "m");
		assert_eq!(ui.overlay(rail).expect("rail tree").values()["side"], "");

		ui.close_overlay(dialog);
		ui.handle_key(Key::Char('r'));
		assert_eq!(
			ui.overlay(rail).expect("rail tree").values()["side"],
			"r",
			"the focused pane resumes when the modal closes"
		);
	}

	#[test]
	fn click_moves_keyboard_between_pane_and_document() {
		let mut ui = Ui::from_markup("<input id=base/>", 20, UiContext::default()).unwrap();
		let rail = ui.show_overlay(
			dom! { <input id=side/> },
			OverlayOptions::default()
				.non_modal()
				.width(Dim::Cells(6))
				.col(Dim::Cells(14))
				.row(Dim::Cells(0)),
		);
		let mut renderer = Renderer::new(Vec::new());
		ui.present(&mut renderer, 1).unwrap();

		ui.handle_mouse(15, 0, Mouse::Click);
		assert_eq!(ui.focused_overlay(), Some(rail), "a click inside the band focuses the pane");
		ui.handle_key(Key::Char('x'));
		assert_eq!(ui.overlay(rail).expect("rail tree").values()["side"], "x");

		ui.handle_mouse(2, 0, Mouse::Click);
		assert_eq!(ui.focused_overlay(), None, "a click outside returns the keyboard");
		ui.handle_key(Key::Char('y'));
		assert_eq!(ui.values()["base"], "y");
	}

	#[test]
	fn hiding_or_closing_the_focused_layer_returns_the_keyboard() {
		let mut ui = Ui::from_markup("<input id=base/>", 20, UiContext::default()).unwrap();
		let rail = ui.show_overlay(dom! { <input id=side/> }, OverlayOptions::default().non_modal());
		ui.focus_overlay(rail);
		assert!(ui.set_overlay_hidden(rail, true));
		assert_eq!(ui.focused_overlay(), None);
		ui.handle_key(Key::Char('x'));
		assert_eq!(ui.values()["base"], "x");

		assert!(ui.set_overlay_hidden(rail, false));
		ui.focus_overlay(rail);
		assert!(ui.close_overlay(rail));
		assert_eq!(ui.focused_overlay(), None);
		ui.handle_key(Key::Char('y'));
		assert_eq!(ui.values()["base"], "xy");
	}

	#[test]
	fn fill_height_stretches_layer_to_the_viewport_band() {
		use crate::test_support::TerminalModel;

		let mut ui = Ui::from_markup(
			"<col><text>aaaa</text><text>bbbb</text><text>cccc</text><text>dddd</text></col>",
			11,
			UiContext::default(),
		)
		.unwrap();
		let mut renderer = Renderer::new(Vec::new());
		let mut terminal = TerminalModel::new(11, 4);
		ui.show_overlay(
			dom! {
				<col>
					<text>{"A"}</text>
					<spacer grow/>
					<text>{"Z"}</text>
				</col>
			},
			OverlayOptions::default()
				.non_modal()
				.fill_height()
				.anchor(OverlayAnchor::Right)
				.width(Dim::Cells(1)),
		);
		ui.present(&mut renderer, 4).unwrap();
		terminal.apply(&overlay_paint(&mut renderer));
		let rows = terminal.visible_rows();
		assert_eq!(rows[0], "aaaa      A", "the band spans the full viewport height");
		assert_eq!(rows[3], "dddd      Z", "grow pins the tail to the band bottom");
	}

	#[test]
	fn close_active_overlay_targets_the_modal_beneath_a_higher_z_pane() {
		let mut ui = Ui::from_markup("<input id=base/>", 20, UiContext::default()).unwrap();
		let rail =
			ui.show_overlay(dom! { <input id=side/> }, OverlayOptions::default().non_modal().z(10));
		let dialog = ui.show_overlay(dom! { <text>{"confirm"}</text> }, OverlayOptions::default());
		assert_eq!(ui.top_overlay(), Some(dialog), "keys target the modal, not the stack top");

		assert_eq!(ui.handle_key(Key::Esc), UiEvent::Cancel);
		assert_eq!(ui.close_active_overlay(), Some(dialog));
		assert!(ui.overlay(dialog).is_none());
		assert!(ui.overlay(rail).is_some(), "the higher-z pane survives the dismissal");

		ui.focus_overlay(rail);
		assert_eq!(
			ui.close_active_overlay(),
			Some(rail),
			"with no modal left, the focused pane is the active layer"
		);
		assert_eq!(ui.close_active_overlay(), None, "an empty stack has no active layer");
	}

	#[test]
	fn hardware_cursor_follows_the_keyboard_between_base_and_pane() {
		let mut ui = Ui::from_markup("<input id=base/>", 20, UiContext::default()).unwrap();
		let rail = ui.show_overlay(
			dom! { <input id=side/> },
			OverlayOptions::default()
				.non_modal()
				.width(Dim::Cells(6))
				.col(Dim::Cells(14))
				.row(Dim::Cells(0)),
		);
		let mut renderer = Renderer::new(Vec::new());

		ui.present(&mut renderer, 1).unwrap();
		assert_eq!(ui.viewport_frame.cursor(), ui.frame.cursor(), "viewport carries base cursor");
		let col = renderer
			.screen_cursor()
			.map(|(_, col)| col)
			.expect("the base caret shows through a passive pane");
		assert!(col < 14, "caret sits in the composer, got column {col}");

		ui.focus_overlay(rail);
		ui.present(&mut renderer, 1).unwrap();
		let col = renderer
			.screen_cursor()
			.map(|(_, col)| col)
			.expect("the focused pane owns the caret");
		assert!(col >= 14, "caret sits in the pane band, got column {col}");

		ui.blur_overlay();
		ui.present(&mut renderer, 1).unwrap();
		let col = renderer
			.screen_cursor()
			.map(|(_, col)| col)
			.expect("blurring returns the caret to the composer");
		assert!(col < 14, "caret back in the composer, got column {col}");
	}
}
