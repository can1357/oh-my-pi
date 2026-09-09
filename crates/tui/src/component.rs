//! Retained component model: identity, cached geometry, events, and element
//! factories.

use std::{
	any,
	any::Any,
	f32::consts::{PI, TAU},
	fmt, str,
	sync::{
		Arc,
		atomic::{AtomicU32, Ordering},
	},
	time::Duration,
};

use omp_core::{IntoStr, Str};
use smallvec::SmallVec;

use crate::{
	anim::{self, Easing, Lerp, Tween},
	components::{Markdown, hr::truncate_to_width},
	context::UiContext,
	frame::{Color, Decor, DecorFill, DecorKind, Frame, Gradient, Rect, RowMark, Style},
	input::{Key, Mods, Mouse, UiEvent},
	markup::{Align, Border, Dim},
	props::{Prop, PropValue, Props},
	rich,
};

/// Stable component identity. A slot is never an arena index.
pub type Slot = u32;

static NEXT_SLOT: AtomicU32 = AtomicU32::new(1);

/// Allocates a fresh [`Slot`] — every component constructor (including
/// external [`Component`] implementations) takes its identity from here.
pub fn next_slot() -> Slot {
	NEXT_SLOT.fetch_add(1, Ordering::Relaxed)
}

/// Result of routing an input event through a component.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Flow {
	/// The component did not consume the event.
	Skip,
	/// The component consumed the event without emitting an application event.
	Consumed,
	/// The component consumed the event and emitted an application event.
	Event(UiEvent),
}

/// A retained UI component.
pub trait Component: Any {
	/// Component properties.
	fn props(&self) -> &Props;
	/// Mutable component properties.
	fn props_mut(&mut self) -> &mut Props;
	/// Stable identity.
	fn slot(&self) -> Slot;
	/// Concrete implementation name for debug tooling; defaults to the
	/// type's full path via [`std::any::type_name`]. The `OMP_TUI_DEBUG`
	/// tree dump trims it to the trailing path segment.
	fn kind(&self) -> &'static str {
		any::type_name::<Self>()
	}
	/// Every owned child, including embedded inactive subtrees.
	fn children(&self) -> &[Cached] {
		&[]
	}
	/// Every owned child, including embedded inactive subtrees.
	fn children_mut(&mut self) -> &mut [Cached] {
		&mut []
	}
	/// Content width bounds, exclusive of this component's chrome.
	fn measure(&mut self, ctx: &UiContext) -> (u16, u16);
	/// Content height at the supplied content width.
	fn height(&mut self, ctx: &UiContext, width: u16) -> u16;
	/// Places children inside the supplied content rectangle.
	fn place(&mut self, ctx: &UiContext, content: Rect) {
		let _ = (ctx, content);
	}
	/// Paints content inside the supplied content rectangle.
	fn paint(&mut self, pc: &mut PaintCtx<'_>, rect: Rect);
	/// Whether [`Cached`] should paint this component's border property as
	/// chrome.
	fn paints_border(&self) -> bool {
		true
	}
	/// Whether [`Cached`] should paint this component's background property
	/// across its rectangle. Components that own a partial background fill opt
	/// out and paint it themselves.
	fn paints_background(&self) -> bool {
		true
	}
	/// A narrowed projection frame for two-stop `fg=`/`bg=` ramps, given the
	/// painted content rectangle. `None` projects across the full chrome;
	/// content-sized leaves ([`crate::components::Pre`]) return their authored
	/// extent so the ramp completes across the glyphs instead of the
	/// stretched layout width.
	fn gradient_bounds(&self, content: Rect) -> Option<Rect> {
		let _ = content;
		None
	}
	/// A validation error blocking submission — an unmet `required` or
	/// `match=` constraint owned by this component's internal records;
	/// `None` when valid. Component-level props are checked by the caller.
	fn validation_error(&self) -> Option<String> {
		None
	}
	/// Whether a row should stretch this component across its cross axis.
	fn stretch_in_row(&self) -> bool {
		false
	}
	/// Whether this component contributes its own slot to the focus ring.
	/// The default honors the `focus` flag, so any container can opt into
	/// keyboard navigation from markup.
	fn focusable(&self) -> bool {
		self.props().flag(Prop::Focus)
	}
	/// Positions internal selection when focus enters from either direction.
	fn enter(&mut self, forward: bool) {
		let _ = forward;
	}
	/// Appends focusable slots in document order.
	fn ring(&self, out: &mut Vec<Slot>) {
		if self.focusable() {
			out.push(self.slot());
		}
		for child in self.children().iter().filter(|child| child.visible) {
			child.comp.ring(out);
		}
	}
	/// Handles a keyboard event.
	fn key(&mut self, ec: &mut EventCtx<'_>, key: Key) -> Flow {
		let _ = (ec, key);
		Flow::Skip
	}
	/// Handles a mouse gesture over one of this component's hit regions.
	fn mouse(
		&mut self,
		ec: &mut EventCtx<'_>,
		tag: HitTag,
		at: (u16, u16),
		rect: Rect,
		mouse: Mouse,
	) -> Flow {
		let _ = (ec, tag, at, rect, mouse);
		Flow::Skip
	}
	/// Pastes text into this component: [`Flow::Consumed`] repaints,
	/// [`Flow::Event`] additionally surfaces a [`crate::UiEvent`], and
	/// [`Flow::Skip`] leaves the paste unhandled.
	fn paste(&mut self, ec: &mut EventCtx<'_>, text: &str) -> Flow {
		let _ = (ec, text);
		Flow::Skip
	}
	/// Pastes text verbatim, bypassing any smart-paste interpretation the
	/// component applies in [`Component::paste`] (drop classification,
	/// large-paste collapse). Defaults to [`Component::paste`] for
	/// components without such interpretation.
	fn paste_raw(&mut self, ec: &mut EventCtx<'_>, text: &str) -> Flow {
		self.paste(ec, text)
	}
	/// Adds this component's named value to an output object.
	fn value(&self, out: &mut serde_json::Map<String, serde_json::Value>) {
		let _ = out;
	}
	/// Replaces text content where supported.
	fn set_text(&mut self, ctx: &UiContext, text: Str) -> bool {
		let _ = (ctx, text);
		false
	}
}
impl dyn Component {
	pub(crate) fn is<T: Component>(&self) -> bool {
		(self as &dyn Any).is::<T>()
	}

	/// Borrows the concrete component type when it matches `T`.
	pub fn downcast_ref<T: Component>(&self) -> Option<&T> {
		(self as &dyn Any).downcast_ref()
	}

	pub(crate) fn downcast_mut<T: Component>(&mut self) -> Option<&mut T> {
		(self as &mut dyn Any).downcast_mut()
	}
}

/// Memo key for context-derived output: component version, process-wide
/// width-config epoch, and the owning [`UiContext`]'s cache revision.
///
/// Any memo holding output that depends on the context (theme, charset,
/// glyph widths) compares against a freshly captured key, so a revision
/// bump from [`crate::Ui::set_context`] or a width-policy change discards
/// it.
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct MemoKey {
	version:     u64,
	width_epoch: u64,
	revision:    u64,
}

impl MemoKey {
	/// Captures the key for a component at `version` under `ctx`.
	pub(crate) fn new(version: u64, ctx: &UiContext) -> Self {
		Self { version, width_epoch: rich::width_config_epoch(), revision: ctx.revision }
	}
}

/// A component with memoized geometry, its last placed rectangle, and any
/// in-flight property transitions.
pub struct Cached {
	comp:        Box<dyn Component>,
	/// Last outer rectangle assigned by layout.
	pub rect:    Rect,
	/// Whether the component participates in layout, paint, and focus.
	pub visible: bool,
	version:     u64,
	measured:    Option<(MemoKey, (u16, u16))>,
	laid:        Option<(MemoKey, u16, u16)>,
	anim:        Option<Box<AnimState>>,
}

impl Cached {
	/// Wraps a component with empty geometry caches.
	pub fn new(comp: Box<dyn Component>) -> Self {
		Self {
			comp,
			rect: Rect::new(0, 0, 0, 0),
			visible: true,
			version: 0,
			measured: None,
			laid: None,
			anim: None,
		}
	}

	/// Returns memoized outer width bounds, including padding and border.
	///
	/// The process-wide width epoch and the context revision are part of the
	/// memo key, so changing the terminal's Jamo policy or swapping the
	/// presentation context remeasures unchanged component trees.
	pub fn measure(&mut self, ctx: &UiContext) -> (u16, u16) {
		let key = MemoKey::new(self.version, ctx);
		if let Some((cached, measured)) = self.measured
			&& cached == key
		{
			return measured;
		}
		let (mut min, mut nat) = self.comp.measure(ctx);
		let extra = horizontal_inset(self.comp.props(), self.comp.paints_border()).saturating_mul(2);
		min = min.saturating_add(extra);
		nat = nat.saturating_add(extra).max(min);
		let measured = (min, nat);
		self.measured = Some((key, measured));
		measured
	}

	/// Returns memoized outer height at `width`, including padding and border.
	pub fn height(&mut self, ctx: &UiContext, width: u16) -> u16 {
		let key = MemoKey::new(self.version, ctx);
		if let Some((cached, laid_width, height)) = self.laid
			&& cached == key
			&& laid_width == width
		{
			return height;
		}
		let fixed = self.sampled_h(ctx);
		let paints_border = self.comp.paints_border();
		let x_inset = horizontal_inset(self.comp.props(), paints_border);
		let y_inset = vertical_inset(self.comp.props(), paints_border);
		let height = if let Some(fixed) = fixed {
			fixed
		} else {
			let content_width = width.saturating_sub(x_inset.saturating_mul(2));
			let minimum = self
				.measure(ctx)
				.0
				.saturating_sub(x_inset.saturating_mul(2));
			self
				.comp
				.height(ctx, content_width.max(minimum).max(1))
				.saturating_add(y_inset.saturating_mul(2))
		};
		// `lift` reserves headroom above the resting chrome.
		let height = height.saturating_add(self.comp.props().lift());
		if self.size_settled(ctx.now) {
			self.laid = Some((key, width, height));
		}
		height
	}

	/// Stores the outer rectangle and places children inside its content box.
	///
	/// A `lift` component rests at the bottom of its rectangle; the reserved
	/// headroom above is where the chrome rises while hovered.
	pub fn place(&mut self, ctx: &UiContext, rect: Rect) {
		self.rect = rect;
		let props = self.comp.props();
		let chrome = lifted_rect(rect, props.lift(), 0);
		let content = content_rect(chrome, props, self.comp.paints_border());
		self.comp.place(ctx, content);
	}

	/// Paints border and content, then restores this component's background.
	///
	/// When `anim`/`spin` properties are live, sampled solid colors are
	/// swapped into the props for the duration of this call and restored
	/// afterward, so content and chrome both paint the mid-flight value.
	/// Hover chrome follows the pointer or keyboard focus: a ramped `hover`
	/// under a live pointer renders as a tracking glow over the resting
	/// chrome, under keyboard focus it blooms from the chrome's center
	/// until it blankets the ring, every other hovered case swaps into the
	/// border slot, and `lift` raises the chrome into the headroom its
	/// rectangle reserves, leaving a shadow.
	pub fn paint(&mut self, pc: &mut PaintCtx<'_>) {
		let own = self.comp.slot();
		let decorated = self.comp.props().hover_decorated();
		let pointer_hovered = decorated && pc.hover.is_some_and(|(slot, _)| self.contains_slot(slot));
		let hovered = pointer_hovered || (decorated && pc.keyboard && pc.focus == Some(own));
		let mut glow = if pointer_hovered {
			self.border_glow(pc)
		} else if hovered {
			self.focus_glow(pc)
		} else {
			None
		};
		let hover_swap = if hovered && glow.is_none() {
			self.swap_hover_chrome()
		} else {
			None
		};
		let anim = self.begin_paint(pc.ctx, pc.now);
		let chrome_anim = anim
			.as_ref()
			.map_or_else(ChromeAnim::default, |paint| paint.chrome);
		let rect = self.rect;
		if decorated {
			// The zone spans the resting rectangle no matter the current
			// rise, so hover cannot oscillate at the lifted edge.
			pc.hits.push(Hit { rect, slot: own, tag: HitTag::Zone });
		}
		let lift = self.comp.props().lift();
		let (risen, rise) = if lift == 0 {
			(0, f32::from(u8::from(hovered)))
		} else {
			self.lift_rise(pc, hovered, lift)
		};
		let chrome = lifted_rect(rect, lift, risen);
		if let Some(glow) = glow.as_mut()
			&& glow.focus
		{
			// The keyboard bloom keeps the declared pace so the spread
			// stays legible even when the lift hops at keyboard speed,
			// radiating from the chrome as placed this frame.
			glow.strength = self.focus_bloom(pc);
			glow.pointer =
				(chrome.x.saturating_add(chrome.width / 2), chrome.y.saturating_add(chrome.height / 2));
		} else {
			if let Some(glow) = glow.as_mut() {
				// The pointer glow lands on the elevation's own ease.
				glow.strength = rise;
			}
			if let Some(state) = self.anim.as_deref_mut() {
				// Whenever the focus glow is not the active chrome the bloom
				// resets, so the next keyboard focus spreads from zero again.
				state.bloom = None;
			}
		}
		let paints_border = self.comp.paints_border();
		if lift > 0 {
			// The chrome moved off its resting placement: children follow.
			self
				.comp
				.place(pc.ctx, content_rect(chrome, self.comp.props(), paints_border));
		}
		let props = self.comp.props();
		if props.border().is_some() && paints_border {
			paint_border(pc, chrome, props, chrome_anim, glow);
		}
		let content = content_rect(chrome, props, paints_border);
		// A fixed height is a hard budget: content taller than the box —
		// including every mid-flight sample of an animated `h` — clips at
		// the content bottom instead of overpainting the border and the
		// rows below.
		let outer_clip = pc.clip;
		if props.h().is_some() {
			pc.clip = pc.clip.min(content.y.saturating_add(content.height));
		}
		self.comp.paint(pc, content);
		pc.clip = outer_clip;
		paint_gradients(
			pc,
			chrome,
			self.comp.gradient_bounds(content),
			self.comp.props(),
			paints_border,
			self.comp.paints_background(),
			chrome_anim,
		);
		if self.comp.props().noselect() {
			// The whole chrome opts out of host text selection.
			pc.frame.push_noselect(chrome);
		}
		if self
			.comp
			.props()
			.str_of(Prop::Zone)
			.is_some_and(|zone| zone.as_str() == "prompt")
			&& chrome.height > 0
		{
			// The chrome's first and last painted rows bracket an OSC 133
			// prompt zone; rows past the paint clip
			// are not on screen, so the zone closes on the last visible one.
			let bottom = chrome
				.y
				.saturating_add(chrome.height)
				.min(pc.clip)
				.min(pc.frame.size().height);
			if chrome.y < bottom {
				pc.frame.mark_row(chrome.y, RowMark::PromptStart);
				pc.frame.mark_row(bottom - 1, RowMark::PromptEnd);
			}
		}
		if risen > 0 {
			paint_lift_shadow(pc, chrome, rect);
		}
		if glow.is_some() && pointer_hovered {
			// The pointer glow shimmers and re-reads the cursor between
			// events; the keyboard bloom rides the finite lift tween and
			// settles silent, so focus never pins a repaint loop.
			pc.wake(own, pc.now.saturating_add(anim::FRAME));
		}
		if let Some(anim) = anim {
			self.end_paint(pc, anim);
		}
		if let Some((prop, displaced)) = hover_swap {
			match displaced {
				Some(value) => self.comp.props_mut().set(prop, value),
				None => self.comp.props_mut().unset(prop),
			}
		}
	}

	/// Invalidates both geometry memos.
	pub const fn invalidate(&mut self) {
		self.version = self.version.wrapping_add(1);
		self.measured = None;
		self.laid = None;
	}

	/// Mutates a component selected by slot and invalidates a dirty ancestor
	/// path.
	pub fn update<R>(&mut self, slot: Slot, f: impl FnOnce(&mut Self) -> (R, bool)) -> Option<R> {
		let mut f = Some(f);
		self
			.update_where(&|cached| cached.comp.slot() == slot, &mut f)
			.map(|(value, _)| value)
	}

	/// Mutates a component selected by `id` and invalidates a dirty ancestor
	/// path.
	pub fn update_id<R>(&mut self, id: &str, f: impl FnOnce(&mut Self) -> (R, bool)) -> Option<R> {
		let mut f = Some(f);
		self
			.update_where(
				&|cached| {
					cached
						.comp
						.props()
						.id()
						.is_some_and(|candidate| candidate == id)
				},
				&mut f,
			)
			.map(|(value, _)| value)
	}

	fn update_where<R, P, F>(&mut self, predicate: &P, f: &mut Option<F>) -> Option<(R, bool)>
	where
		P: Fn(&Self) -> bool,
		F: FnOnce(&mut Self) -> (R, bool),
	{
		if predicate(self) {
			let (value, dirty) = f.take().expect("update closure reused")(self);
			if dirty {
				self.invalidate();
			}
			return Some((value, dirty));
		}
		let result = self
			.comp
			.children_mut()
			.iter_mut()
			.find_map(|child| child.update_where(predicate, f));
		if result.as_ref().is_some_and(|(_, dirty)| *dirty) {
			self.invalidate();
		}
		result
	}

	/// Finds a component by slot without invalidating geometry.
	pub fn find_slot(&mut self, slot: Slot) -> Option<&mut Self> {
		if self.comp.slot() == slot {
			return Some(self);
		}
		for child in self.comp.children_mut() {
			if let Some(found) = child.find_slot(slot) {
				return Some(found);
			}
		}
		None
	}

	/// Borrows the wrapped component.
	pub fn comp(&self) -> &dyn Component {
		self.comp.as_ref()
	}

	/// Borrows the wrapped component mutably; callers must invalidate after
	/// mutation.
	pub fn comp_mut(&mut self) -> &mut dyn Component {
		self.comp.as_mut()
	}

	/// Consumes the cache and returns its wrapped component.
	pub(crate) fn into_comp(self) -> Box<dyn Component> {
		self.comp
	}

	/// The component's style with any mid-flight color transition applied —
	/// what [`crate::Ui`] clears a subtree rectangle with before repainting.
	pub(crate) fn fill_style(&mut self, ctx: &UiContext, now: Duration) -> Style {
		let paint = self.begin_paint(ctx, now);
		let style = self.comp.props().style(&ctx.theme);
		if let Some(paint) = paint {
			self.restore_props(paint.saved);
		}
		style
	}

	/// The width request row layout consumes, sampling an active size
	/// transition. Unit changes (cells ↔ percent) snap.
	pub(crate) fn w(&mut self, ctx: &UiContext) -> Option<Dim> {
		let target = self.comp.props().w();
		let Some((duration, easing)) = self.anim_spec() else {
			return target;
		};
		let state = self.anim.get_or_insert_default();
		let Some(target) = target else {
			state.w = None;
			return None;
		};
		let (pct, goal) = match target {
			Dim::Pct(percent) => (true, u16::from(percent)),
			Dim::Cells(cells) => (false, cells),
		};
		let tween = match &mut state.w {
			Some((unit, tween)) if *unit == pct => tween,
			slot => &mut slot.insert((pct, Tween::settled(goal))).1,
		};
		tween.retarget(ctx.now, goal, duration, easing);
		let sampled = tween.sample(ctx.now);
		Some(if pct {
			Dim::Pct(sampled.min(100) as u8)
		} else {
			Dim::Cells(sampled)
		})
	}

	/// Returns the fixed height request sampled at the context's current
	/// instant.
	pub fn sampled_h(&mut self, ctx: &UiContext) -> Option<u16> {
		let target = self.comp.props().h();
		let Some((duration, easing)) = self.anim_spec() else {
			return target;
		};
		let state = self.anim.get_or_insert_default();
		let Some(target) = target else {
			state.h = None;
			return None;
		};
		let tween = state.h.get_or_insert_with(|| Tween::settled(target));
		tween.retarget(ctx.now, target, duration, easing);
		Some(tween.sample(ctx.now))
	}

	/// Returns whether the sampled height has reached its current target.
	pub fn height_settled(&self, now: Duration) -> bool {
		self
			.anim
			.as_deref()
			.is_none_or(|state| state.h.is_none_or(|tween| tween.is_settled(now)))
	}

	/// Whether no size transition is mid-flight — geometry memos are only
	/// trustworthy while sizes hold still.
	fn size_settled(&self, now: Duration) -> bool {
		self.height_settled(now)
			&& self
				.anim
				.as_deref()
				.is_none_or(|state| state.w.is_none_or(|(_, tween)| tween.is_settled(now)))
	}

	/// The `anim` transition spec, when declared.
	fn anim_spec(&self) -> Option<(Duration, Easing)> {
		let props = self.comp.props();
		Some((props.anim()?, props.ease()))
	}

	/// Retargets every animatable channel at `now` and captures this paint's
	/// sampled overrides. `None` means fully settled: nothing swapped, no
	/// wake owed.
	fn begin_paint(&mut self, ctx: &UiContext, now: Duration) -> Option<PaintAnim> {
		let props = self.comp.props();
		let spec = props.anim().map(|duration| (duration, props.ease()));
		let spin = props.spin();
		if spec.is_none() && spin.is_none() && self.anim.is_none() {
			return None;
		}
		if spec.is_some() {
			// Sizes retarget here too: layout only consults them through
			// row solving and fixed heights, so paint is the change
			// detector that starts (and keeps) the layout-wake chain.
			let _ = self.sampled_h(ctx);
			let _ = self.w(ctx);
		}
		let props = self.comp.props();
		let mut paint = PaintAnim::default();

		// Spin is pure phase arithmetic on the shared clock: no retained
		// state, and stepping stays aligned no matter when it is sampled.
		if let Some(period) = spin
			&& (props.gradient_of(Prop::Fg).is_some()
				|| props.gradient_of(Prop::Bg).is_some()
				|| props.gradient_of(Prop::On).is_some()
				|| props.gradient_of(bc_slot(props)).is_some())
		{
			let nanos = period.as_nanos().max(1);
			paint.chrome.angle = ((now.as_nanos() % nanos) * 360 / nanos) as u16;
			let step = Duration::from_nanos((nanos / 360) as u64).max(anim::FRAME);
			paint.merge_wake(now.saturating_add(step));
		}

		if let Some((duration, easing)) = spec {
			let bg_prop = if props.contains(Prop::Bg) {
				Prop::Bg
			} else {
				Prop::On
			};
			let bc_prop = bc_slot(props);
			let fg_target = color_target(ctx, props, Prop::Fg);
			let bg_target = color_target(ctx, props, bg_prop);
			let bc_target = color_target(ctx, props, bc_prop);
			let state = self.anim.get_or_insert_default();
			state.fg.retarget(now, fg_target, duration, easing);
			state.bg.retarget(now, bg_target, duration, easing);
			state.bc.retarget(now, bc_target, duration, easing);
			paint.chrome.fg = paint.apply(self.comp.as_mut(), &state.fg, Prop::Fg, now);
			paint.chrome.bg = paint.apply(self.comp.as_mut(), &state.bg, bg_prop, now);
			paint.chrome.bc = paint.apply(self.comp.as_mut(), &state.bc, bc_prop, now);
			for settles in
				[state.h.map(|tween| tween.settles_at()), state.w.map(|(_, tween)| tween.settles_at())]
					.into_iter()
					.flatten()
					.filter(|&settles| settles > now)
			{
				paint.relayout = true;
				paint.merge_wake(settles.min(now.saturating_add(anim::FRAME)));
			}
		} else {
			// `anim` was removed mid-flight: drop transition state and snap.
			self.anim = None;
		}

		if paint.wake.is_none() {
			None
		} else {
			Some(paint)
		}
	}

	/// Restores swapped targets and requests the next animation frame.
	fn end_paint(&mut self, pc: &mut PaintCtx<'_>, paint: PaintAnim) {
		let PaintAnim { saved, wake, relayout, .. } = paint;
		self.restore_props(saved);
		if let Some(at) = wake {
			let slot = self.comp.slot();
			if relayout {
				pc.wake_layout(slot, at);
			} else {
				pc.wake(slot, at);
			}
		}
	}

	fn restore_props(&mut self, saved: SmallVec<(Prop, PropValue), 3>) {
		for (prop, value) in saved {
			self.comp.props_mut().set(prop, value);
		}
	}

	/// Whether this component or any descendant owns `slot`.
	pub(crate) fn contains_slot(&self, slot: Slot) -> bool {
		self.comp.slot() == slot
			|| self
				.comp
				.children()
				.iter()
				.any(|child| child.contains_slot(slot))
	}

	/// Swaps the `hover` chrome into the border-color slot for this paint:
	/// borders, `anim` transitions, and `spin` all read the hovered value
	/// through the ordinary property paths. Returns the displaced slot for
	/// restore once the paint completes.
	fn swap_hover_chrome(&mut self) -> Option<(Prop, Option<PropValue>)> {
		let props = self.comp.props();
		let hover = props.get(Prop::Hover)?;
		let slot = bc_slot(props);
		let displaced = props.get(slot);
		self.comp.props_mut().set(slot, hover);
		Some((slot, displaced))
	}

	/// The pointer-tracking border glow: a ramped `hover` under a live
	/// pointer, resolved to its endpoint colors.
	fn border_glow(&self, pc: &PaintCtx<'_>) -> Option<BorderGlow> {
		let pointer = pc.pointer?;
		let (start, end) = self.hover_ramp(pc)?;
		Some(BorderGlow { pointer, start, end, strength: 1.0, focus: false })
	}

	/// The keyboard-focus border glow: the same ramp anchored at the chrome
	/// center (filled in once this frame's rise is known), blooming outward
	/// with the eased rise instead of hugging a pointer.
	fn focus_glow(&self, pc: &PaintCtx<'_>) -> Option<BorderGlow> {
		let (start, end) = self.hover_ramp(pc)?;
		Some(BorderGlow { pointer: (0, 0), start, end, strength: 1.0, focus: true })
	}

	/// The `hover` ramp's resolved endpoint colors, when `hover` is a ramp.
	fn hover_ramp(&self, pc: &PaintCtx<'_>) -> Option<(Color, Color)> {
		let value = self.comp.props().gradient_of(Prop::Hover)?;
		let (start, end) = value.split_once("..")?;
		let resolve = |color: &str| pc.ctx.theme.token(color).or_else(|| Color::parse(color));
		Some((resolve(start)?, resolve(end)?))
	}

	/// The rows the chrome currently rises above its resting position and
	/// the eased rise fraction: driven by the `anim` clock when declared,
	/// snapped otherwise. Keyboard focus hops echo input — half the
	/// declared duration (capped at [`KEY_SNAP`]) leading with velocity —
	/// while pointer hovers keep the declared pace; the pace in force when
	/// the target flips wins, since a matching retarget is a no-op.
	fn lift_rise(&mut self, pc: &mut PaintCtx<'_>, hovered: bool, lift: u16) -> (u16, f32) {
		let target = if hovered { f32::from(lift) } else { 0.0 };
		let Some((duration, easing)) = self.anim_spec() else {
			return if hovered { (lift, 1.0) } else { (0, 0.0) };
		};
		let (duration, easing) = if pc.keyboard {
			((duration / 2).min(KEY_SNAP), Easing::EaseOut)
		} else {
			(duration, easing)
		};
		let state = self.anim.get_or_insert_default();
		let tween = state.lift.get_or_insert_with(|| Tween::settled(0.0));
		tween.retarget(pc.now, target, duration, easing);
		let sample = tween.sample(pc.now).clamp(0.0, f32::from(lift));
		if !tween.is_settled(pc.now) {
			let at = tween.settles_at().min(pc.now.saturating_add(anim::FRAME));
			pc.wake(self.comp.slot(), at);
		}
		(sample.round() as u16, sample / f32::from(lift))
	}

	/// The keyboard bloom's eased strength toward full coverage, on the
	/// declared `anim` pace — deliberately not the snappy keyboard lift
	/// pace, so the spread reads as motion rather than a swap. Snaps to
	/// full without `anim`.
	fn focus_bloom(&mut self, pc: &mut PaintCtx<'_>) -> f32 {
		let Some((duration, easing)) = self.anim_spec() else {
			return 1.0;
		};
		let state = self.anim.get_or_insert_default();
		let tween = state.bloom.get_or_insert_with(|| Tween::settled(0.0));
		tween.retarget(pc.now, 1.0, duration, easing);
		let sample = tween.sample(pc.now);
		if !tween.is_settled(pc.now) {
			let at = tween.settles_at().min(pc.now.saturating_add(anim::FRAME));
			pc.wake(self.comp.slot(), at);
		}
		sample
	}
}

/// Transition state for one component's animatable properties.
///
/// Owned by [`Cached`] and allocated lazily on the first animated pass, so
/// components without `anim` pay one null pointer. Solid color samples are
/// swapped into the component's props for the duration of a paint, ramp
/// samples and the spin offset feed [`paint_gradients`] directly, and sizes
/// are sampled during layout via [`UiContext::now`].
#[derive(Default)]
struct AnimState {
	fg:    Channel,
	bg:    Channel,
	bc:    Channel,
	/// Width tween in the current [`Dim`]'s own unit; the flag records
	/// whether that unit is percent.
	w:     Option<(bool, Tween<u16>)>,
	h:     Option<Tween<u16>>,
	/// Hover elevation tween in rows.
	lift:  Option<Tween<f32>>,
	/// Keyboard-focus glow strength tween toward full ring coverage.
	bloom: Option<Tween<f32>>,
}

/// One animatable color slot: a solid or a two-stop ramp on the shared
/// transition clock. Only like-for-like changes tween — changing kind
/// (solid ↔ gradient, set ↔ unset) snaps, mirroring [`Color`]'s own
/// unblendable-endpoint rule.
#[derive(Clone, Copy, Default)]
enum Channel {
	/// The property is unset; nothing to animate.
	#[default]
	Empty,
	Solid(Tween<Color>),
	Ramp(Tween<(Color, Color)>),
}

impl Channel {
	/// Steers the channel toward `target`, snapping on kind changes.
	fn retarget(
		&mut self,
		now: Duration,
		target: ChannelTarget,
		duration: Duration,
		easing: Easing,
	) {
		match (self, target) {
			(Self::Solid(tween), ChannelTarget::Solid(color)) => {
				tween.retarget(now, color, duration, easing);
			},
			(Self::Ramp(tween), ChannelTarget::Ramp(start, end)) => {
				tween.retarget(now, (start, end), duration, easing);
			},
			(slot, ChannelTarget::None) => *slot = Self::Empty,
			(slot, ChannelTarget::Solid(color)) => *slot = Self::Solid(Tween::settled(color)),
			(slot, ChannelTarget::Ramp(start, end)) => {
				*slot = Self::Ramp(Tween::settled((start, end)));
			},
		}
	}
}

/// A color property's resolved animation target at one paint.
#[derive(Clone, Copy)]
enum ChannelTarget {
	/// Unset or unresolvable — nothing to animate toward.
	None,
	Solid(Color),
	Ramp(Color, Color),
}

/// Resolves a color property into its animation target, mirroring how
/// [`Props::style`] and [`resolve_gradient`] will read it at paint time.
fn color_target(ctx: &UiContext, props: &Props, prop: Prop) -> ChannelTarget {
	match props.get(prop) {
		Some(PropValue::Color(color)) => ChannelTarget::Solid(color),
		Some(PropValue::Token(token)) => ctx
			.theme
			.token(&token)
			.map_or(ChannelTarget::None, ChannelTarget::Solid),
		Some(PropValue::Gradient(value)) => {
			let resolve = |color: &str| ctx.theme.token(color).or_else(|| Color::parse(color));
			value
				.split_once("..")
				.and_then(|(start, end)| Some((resolve(start)?, resolve(end)?)))
				.map_or(ChannelTarget::None, |(start, end)| ChannelTarget::Ramp(start, end))
		},
		_ => ChannelTarget::None,
	}
}

/// Per-frame gradient overrides supplied by an active animation.
#[derive(Clone, Copy, Default)]
pub struct ChromeAnim {
	/// Sampled foreground ramp mid-transition.
	fg:    Option<(Color, Color)>,
	/// Sampled background ramp mid-transition.
	bg:    Option<(Color, Color)>,
	/// Sampled border ramp mid-transition.
	bc:    Option<(Color, Color)>,
	/// Degrees `spin` adds to the authored gradient angle.
	angle: u16,
}

/// Sampled paint state for one animated frame: swapped-out prop targets to
/// restore, gradient overrides, and the earliest wake owed.
#[derive(Default)]
struct PaintAnim {
	saved:    SmallVec<(Prop, PropValue), 3>,
	chrome:   ChromeAnim,
	wake:     Option<Duration>,
	relayout: bool,
}

impl PaintAnim {
	/// Applies one channel's unsettled sample: solids swap into the props
	/// (saving the target for restore), ramps return a gradient override.
	fn apply(
		&mut self,
		comp: &mut dyn Component,
		channel: &Channel,
		prop: Prop,
		now: Duration,
	) -> Option<(Color, Color)> {
		match channel {
			Channel::Empty => None,
			Channel::Solid(tween) => {
				if !tween.is_settled(now)
					&& let Some(saved) = comp.props().get(prop)
				{
					self.merge_wake(tween.settles_at().min(now.saturating_add(anim::FRAME)));
					comp.props_mut().set(prop, tween.sample(now));
					self.saved.push((prop, saved));
				}
				None
			},
			Channel::Ramp(tween) => {
				if tween.is_settled(now) {
					return None;
				}
				self.merge_wake(tween.settles_at().min(now.saturating_add(anim::FRAME)));
				Some(tween.sample(now))
			},
		}
	}

	fn merge_wake(&mut self, at: Duration) {
		self.wake = Some(self.wake.map_or(at, |wake| wake.min(at)));
	}
}

pub fn horizontal_inset(props: &Props, paints_border: bool) -> u16 {
	let (_, pad_x) = props.pad();
	pad_x.saturating_add(u16::from(paints_border && props.border().is_some()))
}

pub fn vertical_inset(props: &Props, paints_border: bool) -> u16 {
	let (pad_y, _) = props.pad();
	pad_y.saturating_add(u16::from(paints_border && props.border().is_some()))
}

fn content_rect(rect: Rect, props: &Props, paints_border: bool) -> Rect {
	let x_inset = horizontal_inset(props, paints_border);
	let y_inset = vertical_inset(props, paints_border);
	Rect::new(
		rect.x.saturating_add(x_inset),
		rect.y.saturating_add(y_inset),
		rect.width.saturating_sub(x_inset.saturating_mul(2)),
		rect.height.saturating_sub(y_inset.saturating_mul(2)),
	)
}

/// The border-color slot every chrome path reads: `bc` when set, else `edge`.
const fn bc_slot(props: &Props) -> Prop {
	if props.contains(Prop::Bc) {
		Prop::Bc
	} else {
		Prop::Edge
	}
}

/// The chrome rectangle inside a lift-reserving outer rectangle: the
/// drawable box sits `lift` rows below the top at rest and rises by
/// `risen` rows while hovered.
fn lifted_rect(rect: Rect, lift: u16, risen: u16) -> Rect {
	let lift = lift.min(rect.height.saturating_sub(1));
	Rect::new(rect.x, rect.y.saturating_add(lift - risen.min(lift)), rect.width, rect.height - lift)
}

/// A soft shadow hugging the underside of risen chrome, in the theme's
/// shadow tint over whatever the parent painted beneath. Tiers without a
/// shadow glyph ([`Charset::shadow`]) skip it entirely.
fn paint_lift_shadow(pc: &mut PaintCtx<'_>, chrome: Rect, rect: Rect) {
	let y = chrome.y.saturating_add(chrome.height);
	let Some(glyph) = pc.ctx.charset.shadow() else {
		return;
	};
	if y >= rect.y.saturating_add(rect.height) || y >= pc.clip || rect.width < 3 {
		return;
	}
	let style = Style::new().fg(pc.ctx.theme.shadow);
	for x in rect.x.saturating_add(1)..rect.x.saturating_add(rect.width - 1) {
		pc.frame.put(x, y, glyph, style);
	}
}

/// Keyboard focus pace ceiling: hops read as input echo, so the lift ease
/// runs at half its declared duration capped near one reaction beat.
const KEY_SNAP: Duration = Duration::from_millis(120);

/// A border glow: the `hover` ramp sampled as a seamless color wheel
/// around the chrome, strongest near its anchor, scaled by the elevation's
/// eased rise. Anchored under the pointer while tracking it, or at the
/// chrome's center under keyboard focus.
#[derive(Clone, Copy)]
struct BorderGlow {
	pointer:  (u16, u16),
	start:    Color,
	end:      Color,
	strength: f32,
	/// Keyboard-focus bloom: the halo radiates from the center and grows
	/// until the ramp blankets the whole ring at full strength.
	focus:    bool,
}

impl BorderGlow {
	/// The blended color for one border cell, or `None` outside the
	/// pointer's halo. `phase` drifts the ramp for the resting shimmer.
	fn color_at(self, x: u16, y: u16, rect: Rect, base: Color, phase: f32) -> Option<Color> {
		// Columns are roughly half as wide as rows are tall.
		let dx = (f32::from(x) - f32::from(self.pointer.0)) * 0.5;
		let dy = f32::from(y) - f32::from(self.pointer.1);
		let radius = if self.focus {
			// The bloom spreads from the chrome's center with the eased
			// rise until it reaches well past the corners.
			let corner_x = f32::from(rect.width) * 0.25;
			let corner_y = f32::from(rect.height) * 0.5;
			corner_x.hypot(corner_y) * self.strength.mul_add(1.6, 0.4)
		} else {
			// The halo hugs small chrome and blooms out with the eased
			// rise, so the glow visibly grows from under the cursor.
			(f32::from(rect.width).mul_add(0.5, f32::from(rect.height)) * 0.3).clamp(2.5, 6.0)
				* self.strength.mul_add(0.65, 0.35)
		};
		let amount = self.strength * (-dx.mul_add(dx, dy * dy) / (radius * radius)).exp();
		if amount < 0.02 {
			return None;
		}
		let center_x = f32::from(rect.x) + f32::from(rect.width) / 2.0;
		let center_y = f32::from(rect.y) + f32::from(rect.height) / 2.0;
		let cell = (f32::from(y) - center_y).atan2((f32::from(x) - center_x) * 0.5);
		let cursor =
			(f32::from(self.pointer.1) - center_y).atan2((f32::from(self.pointer.0) - center_x) * 0.5);
		// Sample the ramp by angular distance from the pointer: the start
		// color sits under the cursor, the end color wraps the far side,
		// and the fold drifts on the shared clock.
		let mut delta = (cell - cursor).rem_euclid(TAU);
		if delta > PI {
			delta = TAU - delta;
		}
		let wave = phase.mul_add(0.15, delta / PI);
		let wheel = 1.0 - (1.0 - wave.rem_euclid(2.0)).abs();
		Some(base.lerp(self.start.lerp(self.end, wheel), amount.min(1.0)))
	}
}

/// Applies the glow to one already-painted border cell.
fn glow_cell(frame: &mut Frame, x: u16, y: u16, rect: Rect, glow: BorderGlow, phase: f32) {
	frame.recolor_fg(x, y, |base| glow.color_at(x, y, rect, base, phase).unwrap_or(base));
}
pub fn paint_gradients(
	pc: &mut PaintCtx<'_>,
	bounds: Rect,
	projection: Option<Rect>,
	props: &Props,
	paints_border: bool,
	paints_background: bool,
	chrome: ChromeAnim,
) {
	let angle = (props.angle() + chrome.angle) % 360;
	let bottom = bounds.y.saturating_add(bounds.height).min(pc.clip);
	let painted = Rect::new(bounds.x, bounds.y, bounds.width, bottom.saturating_sub(bounds.y));
	if paints_background {
		let background_bounds = if paints_border && props.border().is_some() && !props.bleed() {
			Rect::new(
				bounds.x.saturating_add(1),
				bounds.y.saturating_add(1),
				bounds.width.saturating_sub(2),
				bounds.height.saturating_sub(2),
			)
		} else {
			bounds
		};
		let background_bottom = background_bounds
			.y
			.saturating_add(background_bounds.height)
			.min(pc.clip);
		let background = Rect::new(
			background_bounds.x,
			background_bounds.y,
			background_bounds.width,
			background_bottom.saturating_sub(background_bounds.y),
		);
		let bg_prop = if props.contains(Prop::Bg) {
			Prop::Bg
		} else {
			Prop::On
		};
		let gradient = chrome
			.bg
			.map(|(start, end)| Gradient::new(start, end, angle))
			.or_else(|| resolve_gradient(pc.ctx, props, bg_prop, angle));
		if let Some(gradient) = gradient {
			if pc.ctx.native_decor {
				pc.frame.push_decor(Decor {
					rect: background,
					kind: DecorKind::Fill {
						fill:    DecorFill::Gradient(gradient),
						rounded: props.border() == Some(Border::Round),
					},
				});
			} else {
				pc.frame.underlay_gradient(
					background,
					gradient,
					projection.unwrap_or(background_bounds),
				);
			}
		} else {
			let bg = props.style(&pc.ctx.theme).background_color();
			if bg != Color::Default {
				if pc.ctx.native_decor {
					pc.frame.push_decor(Decor {
						rect: background,
						kind: DecorKind::Fill {
							fill:    DecorFill::Solid(bg),
							rounded: props.border() == Some(Border::Round),
						},
					});
				} else {
					pc.frame.underlay(background, bg);
				}
			}
		}
	}
	let gradient = chrome
		.fg
		.map(|(start, end)| Gradient::new(start, end, angle))
		.or_else(|| resolve_gradient(pc.ctx, props, Prop::Fg, angle));
	if let Some(gradient) = gradient {
		pc.frame
			.gradient_foreground(painted, gradient, projection.unwrap_or(bounds));
	}
}

fn resolve_gradient(ctx: &UiContext, props: &Props, prop: Prop, angle: u16) -> Option<Gradient> {
	let value = props.gradient_of(prop)?;
	let (start, end) = value.split_once("..")?;
	let resolve = |color: &str| ctx.theme.token(color).or_else(|| Color::parse(color));
	Some(Gradient::new(resolve(start)?, resolve(end)?, angle))
}

fn assemble_border_line(
	line: &mut SmallVec<u8, 256>,
	left: char,
	horizontal: char,
	right: char,
	inner: usize,
) {
	line.clear();
	let mut left_bytes = [0; 4];
	line.extend_from_slice(left.encode_utf8(&mut left_bytes).as_bytes());
	let mut horizontal_bytes = [0; 4];
	let horizontal = horizontal.encode_utf8(&mut horizontal_bytes).as_bytes();
	for _ in 0..inner {
		line.extend_from_slice(horizontal);
	}
	let mut right_bytes = [0; 4];
	line.extend_from_slice(right.encode_utf8(&mut right_bytes).as_bytes());
}

fn paint_border(
	pc: &mut PaintCtx<'_>,
	rect: Rect,
	props: &Props,
	chrome: ChromeAnim,
	glow: Option<BorderGlow>,
) {
	if rect.width < 2 || rect.height < 2 {
		return;
	}
	let border = props.border().unwrap_or_default();
	let style = props.style(&pc.ctx.theme);
	let base = if props.bleed() {
		style
	} else {
		style.bg(Color::Default)
	};
	let angle = (props.angle() + chrome.angle) % 360;
	let ramp = chrome
		.bc
		.map(|(start, end)| Gradient::new(start, end, angle))
		.or_else(|| resolve_gradient(pc.ctx, props, bc_slot(props), angle));
	// Ramped glyphs paint on the inherited foreground and are tinted after
	// the ring lands; solid edges resolve directly; with only `fg=` the
	// frame stays a dimmed echo of the node style; an unstyled border
	// falls back to the theme's border tone.
	let edge_color = props.edge(&pc.ctx.theme);
	let solid = edge_color.unwrap_or_else(|| {
		if props.has_foreground() {
			base.foreground_color()
		} else {
			pc.ctx.theme.border
		}
	});
	if pc.ctx.native_decor {
		let ink = ramp.map_or(DecorFill::Solid(solid), DecorFill::Gradient);
		let glow = glow.map(|glow| (glow.start, glow.strength.clamp(0.0, 1.0)));
		pc.frame
			.push_decor(Decor { rect, kind: DecorKind::Border { border, ink, glow } });
		return;
	}
	let (tl, tr, bl, br, horizontal, vertical) = pc.ctx.charset.border(border);
	let edge = if ramp.is_some() {
		base.fg(Color::Default)
	} else if edge_color.is_some() {
		base.fg(solid)
	} else if props.has_foreground() {
		base.dim()
	} else {
		base.fg(solid)
	};
	let inner = usize::from(rect.width) - 2;
	assemble_border_line(&mut pc.border_scratch, tl, horizontal, tr, inner);
	if rect.y < pc.clip {
		let top = str::from_utf8(&pc.border_scratch)
			.expect("border glyph assembly only appends valid UTF-8");
		pc.frame.put(rect.x, rect.y, top, edge);
	}
	let bottom_y = rect.y.saturating_add(rect.height - 1);
	if bottom_y < pc.clip {
		assemble_border_line(&mut pc.border_scratch, bl, horizontal, br, inner);
		let bottom = str::from_utf8(&pc.border_scratch)
			.expect("border glyph assembly only appends valid UTF-8");
		pc.frame.put(rect.x, bottom_y, bottom, edge);
	}
	let mut vertical_bytes = [0; 4];
	let vertical = vertical.encode_utf8(&mut vertical_bytes);
	for y in rect.y.saturating_add(1)..bottom_y.min(pc.clip) {
		pc.frame.put(rect.x, y, &*vertical, edge);
		pc.frame
			.put(rect.x.saturating_add(rect.width - 1), y, &*vertical, edge);
	}
	if let Some(gradient) = ramp {
		let side_top = rect.y.saturating_add(1);
		let side_rows = bottom_y.min(pc.clip).saturating_sub(side_top);
		let strips = [
			(rect.y < pc.clip).then(|| Rect::new(rect.x, rect.y, rect.width, 1)),
			(bottom_y < pc.clip).then(|| Rect::new(rect.x, bottom_y, rect.width, 1)),
			(side_rows > 0).then(|| Rect::new(rect.x, side_top, 1, side_rows)),
			(side_rows > 0)
				.then(|| Rect::new(rect.x.saturating_add(rect.width - 1), side_top, 1, side_rows)),
		];
		for strip in strips.into_iter().flatten() {
			pc.frame.gradient_foreground(strip, gradient, rect);
		}
	}
	if let Some(glow) = glow {
		// The wheel drifts slowly so the glow shimmers while the pointer
		// rests; the wake in [`Cached::paint`] keeps frames coming.
		let phase = pc.now.as_secs_f32() * 0.5;
		let right = rect.x.saturating_add(rect.width - 1);
		if rect.y < pc.clip {
			for x in rect.x..=right {
				glow_cell(pc.frame, x, rect.y, rect, glow, phase);
			}
		}
		if bottom_y < pc.clip {
			for x in rect.x..=right {
				glow_cell(pc.frame, x, bottom_y, rect, glow, phase);
			}
		}
		for y in rect.y.saturating_add(1)..bottom_y.min(pc.clip) {
			glow_cell(pc.frame, rect.x, y, rect, glow, phase);
			glow_cell(pc.frame, right, y, rect, glow, phase);
		}
	}
	if rect.y < pc.clip
		&& let Some(title) = props.title()
	{
		border_label(pc, rect, rect.y, title, props.title_align(), props.title_pad(), base, true);
	}
	if bottom_y < pc.clip
		&& let Some(footer) = props.footer()
	{
		border_label(pc, rect, bottom_y, footer, props.footer_align(), 1, base, false);
	}
}

/// Paints one border label — title or footer — normally padded by one space
/// per side so the frame line breaks around it. At extreme widths padding
/// collapses before the label, preserving both corner cells and a visible
/// ellipsis. `base` carries the node background only under `bleed`.
///
/// [`Frame::put`] clips at the frame edge, not the rect, so the label is
/// display-width-truncated before painting.
fn border_label(
	pc: &mut PaintCtx<'_>,
	rect: Rect,
	y: u16,
	text: &str,
	align: Align,
	title_pad: u16,
	base: Style,
	bold: bool,
) {
	if text.is_empty() || rect.width <= 2 {
		return;
	}
	let interior = rect.width - 2;
	let left_pad = interior >= 2;
	let mut right_pad = interior >= 3;
	let fit = if title_pad > 1 {
		interior
			.saturating_sub(u16::from(left_pad))
			.saturating_sub(u16::from(right_pad))
			.saturating_sub(title_pad)
	} else {
		interior
			.saturating_sub(u16::from(left_pad))
			.saturating_sub(u16::from(right_pad))
	};
	let authored = text;
	let mut text = truncate_to_width(authored, fit);
	if title_pad > 1 && text.ellipsis {
		right_pad = false;
		let fit = interior
			.saturating_sub(u16::from(left_pad))
			.saturating_sub(title_pad);
		text = truncate_to_width(authored, fit);
	}
	let total = text
		.width
		.saturating_add(u16::from(left_pad))
		.saturating_add(u16::from(right_pad));
	let x = match align {
		Align::Start => rect.x.saturating_add(1).saturating_add(title_pad),
		Align::Center => rect.x.saturating_add(rect.width.saturating_sub(total) / 2),
		Align::End => rect
			.x
			.saturating_add(rect.width.saturating_sub(2).saturating_sub(total)),
	}
	.clamp(
		rect.x.saturating_add(1),
		rect
			.x
			.saturating_add(rect.width.saturating_sub(1).saturating_sub(total)),
	);
	let mut end = x;
	if left_pad {
		end = pc.frame.put(end, y, " ", base);
	}
	let label = if bold { base.bold() } else { base };
	end = pc.frame.put(end, y, text.text, label);
	if text.ellipsis {
		end = pc.frame.put(end, y, "…", label);
	}
	if right_pad {
		pc.frame.put(end, y, " ", base);
	}
}

/// State shared by component painters for one frame.
pub struct PaintCtx<'a> {
	/// Destination frame.
	pub frame:        &'a mut Frame,
	/// First document row outside the paint region.
	pub clip:         u16,
	/// Immutable presentation context.
	pub ctx:          &'a UiContext,
	/// Mouse hit regions produced during paint.
	pub hits:         &'a mut Vec<Hit>,
	/// Focused component slot.
	pub focus:        Option<Slot>,
	/// Hovered component slot and hit tag.
	pub hover:        Option<(Slot, HitTag)>,
	/// Last pointer cell in this frame's coordinates, for chrome that
	/// tracks the mouse between hit changes.
	pub pointer:      Option<(u16, u16)>,
	/// Whether the keyboard was the most recent input modality. The chrome
	/// cursor is singular: focus renders hover/lift chrome only while the
	/// keyboard owns it, and pointer motion takes it back.
	pub keyboard:     bool,
	/// Presentation clock: time since the UI's epoch for this paint pass.
	pub now:          Duration,
	/// Animation wake requests collected during paint.
	pub(crate) wakes: &'a mut Vec<Wake>,
	/// Inline scratch for border rows, reused by every bordered component.
	border_scratch:   SmallVec<u8, 256>,
}

/// A pending animation wake collected during paint.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Wake {
	pub slot:   Slot,
	pub at:     Duration,
	/// Whether the wake must relayout — an animated size moved geometry,
	/// so repainting in place is not enough.
	pub layout: bool,
}

impl<'a> PaintCtx<'a> {
	/// A full-frame paint pass with idle interaction state: the clip covers
	/// the whole frame, nothing is focused, hovered, or pointed at, the
	/// modality is mouse-neutral, and the clock sits at zero. Callers layer
	/// their state onto the public fields.
	pub(crate) const fn new(
		frame: &'a mut Frame,
		ctx: &'a UiContext,
		hits: &'a mut Vec<Hit>,
		wakes: &'a mut Vec<Wake>,
	) -> Self {
		let clip = frame.size().height;
		Self {
			frame,
			clip,
			ctx,
			hits,
			focus: None,
			hover: None,
			pointer: None,
			keyboard: false,
			now: Duration::ZERO,
			border_scratch: SmallVec::new(),
			wakes,
		}
	}

	/// A nested pass into `frame` — a scratch or overlay surface — that
	/// inherits this pass's interaction state and clock under a new clip.
	/// The caller remaps coordinate-bound state (`pointer`) itself.
	pub(crate) const fn nested<'b>(&'b mut self, frame: &'b mut Frame, clip: u16) -> PaintCtx<'b> {
		PaintCtx {
			frame,
			clip,
			ctx: self.ctx,
			hits: self.hits,
			focus: self.focus,
			hover: self.hover,
			pointer: self.pointer,
			keyboard: self.keyboard,
			now: self.now,
			border_scratch: SmallVec::new(),
			wakes: self.wakes,
		}
	}

	/// Schedules a repaint of `slot` at time `at`; the earliest request per
	/// slot wins. Requests are consumed by [`crate::Ui::tick`] and rebuilt on
	/// every paint, so a component that stops asking stops animating.
	pub fn wake(&mut self, slot: Slot, at: Duration) {
		self.request(slot, at, false);
	}

	/// Schedules a relayout of `slot` at time `at` — for animations that
	/// move geometry, not just pixels.
	pub(crate) fn wake_layout(&mut self, slot: Slot, at: Duration) {
		self.request(slot, at, true);
	}

	fn request(&mut self, slot: Slot, at: Duration, layout: bool) {
		match self.wakes.iter_mut().find(|wake| wake.slot == slot) {
			Some(wake) => {
				wake.at = wake.at.min(at);
				wake.layout |= layout;
			},
			None => self.wakes.push(Wake { slot, at, layout }),
		}
	}
}

/// Context supplied while routing an input event.
pub struct EventCtx<'a> {
	/// Immutable presentation context.
	pub ctx:           &'a UiContext,
	/// Placed content width.
	pub width:         u16,
	/// Visible content rows.
	pub view_rows:     u16,
	/// Modifiers attached to the routed input event.
	pub mods:          Mods,
	/// Whether the handler requested a relayout; see
	/// [`EventCtx::request_layout`].
	pub(crate) layout: bool,
}

impl<'a> EventCtx<'a> {
	/// Creates an event context for one routed input event.
	pub fn new(ctx: &'a UiContext, width: u16, view_rows: u16) -> Self {
		Self { ctx, width, view_rows, mods: Mods::default(), layout: false }
	}

	/// Creates an event context carrying explicit input modifiers.
	pub const fn with_mods(ctx: &'a UiContext, width: u16, view_rows: u16, mods: Mods) -> Self {
		Self { ctx, width, view_rows, mods, layout: false }
	}

	/// Requests a full relayout after this event.
	///
	/// For handlers whose consumed event changed geometry outside their own
	/// subtree through shared state — e.g. [`crate::components::EditInput`]
	/// growing its pane's attachment band from a collapsed paste.
	pub const fn request_layout(&mut self) {
		self.layout = true;
	}
}

/// Converts a component-like value into a boxed component.
pub trait IntoComponent {
	/// Performs the conversion.
	fn into_component(self) -> Box<dyn Component>;
}

impl<T: Component + 'static> IntoComponent for T {
	fn into_component(self) -> Box<dyn Component> {
		Box::new(self)
	}
}
impl IntoComponent for Box<dyn Component> {
	fn into_component(self) -> Box<dyn Component> {
		self
	}
}
impl IntoComponent for &str {
	fn into_component(self) -> Box<dyn Component> {
		Box::new(Markdown::text_of(self))
	}
}
impl IntoComponent for String {
	fn into_component(self) -> Box<dyn Component> {
		Box::new(Markdown::text_of(self))
	}
}
impl IntoComponent for Str {
	fn into_component(self) -> Box<dyn Component> {
		Box::new(Markdown::text_of(self))
	}
}

/// Flattens child-builder inputs into cached children.
pub trait IntoChildren {
	/// Appends all represented children to `out`.
	fn extend_children(self, out: &mut Vec<Cached>);
}

impl<T: IntoComponent> IntoChildren for T {
	fn extend_children(self, out: &mut Vec<Cached>) {
		out.push(Cached::new(self.into_component()));
	}
}
impl IntoChildren for () {
	fn extend_children(self, _out: &mut Vec<Cached>) {}
}
impl<T: IntoChildren> IntoChildren for Option<T> {
	fn extend_children(self, out: &mut Vec<Cached>) {
		if let Some(children) = self {
			children.extend_children(out);
		}
	}
}
impl<T: IntoChildren> IntoChildren for Vec<T> {
	fn extend_children(self, out: &mut Vec<Cached>) {
		for children in self {
			children.extend_children(out);
		}
	}
}
impl<T: IntoChildren, const N: usize> IntoChildren for [T; N] {
	fn extend_children(self, out: &mut Vec<Cached>) {
		for children in self {
			children.extend_children(out);
		}
	}
}
impl<T: IntoChildren, const N: usize> IntoChildren for SmallVec<T, N> {
	fn extend_children(self, out: &mut Vec<Cached>) {
		for children in self {
			children.extend_children(out);
		}
	}
}
impl IntoChildren for Cached {
	fn extend_children(self, out: &mut Vec<Cached>) {
		out.push(self);
	}
}

/// Builds the component behind an unknown element tag.
pub trait ElementFactory: Send + Sync {
	/// Builds an element for `name`, parsed properties, and retained children.
	fn build(&self, name: &str, props: Props, children: Vec<Cached>) -> Box<dyn Component>;
}

impl<F> ElementFactory for F
where
	F: Fn(&str, Props, Vec<Cached>) -> Box<dyn Component> + Send + Sync,
{
	fn build(&self, name: &str, props: Props, children: Vec<Cached>) -> Box<dyn Component> {
		self(name, props, children)
	}
}

/// Immutable registry of custom element factories.
#[derive(Clone, Default)]
pub struct Elements(Arc<Vec<(Str, Box<dyn ElementFactory>)>>);

impl fmt::Debug for Elements {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter
			.debug_struct("Elements")
			.field("len", &self.0.len())
			.finish()
	}
}

impl Elements {
	/// Starts a registry builder.
	pub fn builder() -> ElementsBuilder {
		ElementsBuilder::default()
	}

	pub(crate) fn get(&self, name: &str) -> Option<&dyn ElementFactory> {
		self
			.0
			.iter()
			.find(|(candidate, _)| candidate == name)
			.map(|(_, factory)| factory.as_ref())
	}

	pub(crate) fn ptr_eq(&self, other: &Self) -> bool {
		Arc::ptr_eq(&self.0, &other.0)
	}
}

/// Mutable builder for an immutable [`Elements`] registry.
#[derive(Default)]
pub struct ElementsBuilder {
	factories: Vec<(Str, Box<dyn ElementFactory>)>,
}

impl ElementsBuilder {
	/// Registers or replaces the factory for `name`.
	pub fn with(mut self, name: impl IntoStr, factory: impl ElementFactory + 'static) -> Self {
		let name = name.into_str();
		if let Some((_, stored)) = self
			.factories
			.iter_mut()
			.find(|(candidate, _)| candidate == &name)
		{
			*stored = Box::new(factory);
		} else {
			self.factories.push((name, Box::new(factory)));
		}
		self
	}

	/// Freezes this registry for sharing through [`UiContext`].
	pub fn build(self) -> Elements {
		Elements(Arc::new(self.factories))
	}
}

/// Meaning attached to a mouse hit rectangle.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HitTag {
	/// Row `i` of a select, tree, or form.
	Row(u16),
	/// Absolute flattened row of a virtualized tree.
	TreeRow(u32),
	/// Trailing action chip on an absolute flattened tree row.
	TreeAction(u32),
	/// Dropdown row `i` of an open form submenu.
	Sub(u16),
	/// Chip `i` of a radio, segmented control, or tab bar.
	Chip(u16),
	/// Button face, checkbox mark, or input line.
	Press,
	/// Scroll viewport row.
	Wheel,
	/// The one-cell scrollbar column of a scroll viewport: click or drag
	/// jumps the offset.
	Scrollbar,
	/// Visual row of an interactive diff pane.
	DiffRow(u32),
	/// One-cell density minimap of an interactive diff pane.
	DiffMinimap,
	/// Primary action button for hunk `i`.
	DiffHunkPrimary(u32),
	/// Destructive discard button for hunk `i`.
	DiffHunkDiscard(u32),
	/// Pointer zone of a hover-decorated component; carries no press action.
	Zone,
}

/// A clickable region in document coordinates.
#[derive(Clone, Copy, Debug)]
pub struct Hit {
	/// Clickable rectangle.
	pub rect: Rect,
	/// Owning component slot.
	pub slot: Slot,
	/// Meaning of the region to its owner.
	pub tag:  HitTag,
}

#[cfg(test)]
mod tests {
	use std::{cell::Cell, rc::Rc};

	use parking_lot::{Mutex, MutexGuard};

	use super::*;
	use crate::{
		context::JamoWidth,
		rich::{jamo_width, set_jamo_width},
	};

	struct Probe {
		props:    Props,
		slot:     Slot,
		children: Vec<Cached>,
		measures: Rc<Cell<u32>>,
	}

	impl Probe {
		fn new(measures: Rc<Cell<u32>>, children: Vec<Cached>) -> Self {
			Self { props: Props::new(), slot: next_slot(), children, measures }
		}
	}

	/// `rich::set_jamo_width` bumps a process-global measurement epoch that
	/// invalidates every [`Cached`] measure memo, so tests observing memo
	/// hit counts and tests flipping the epoch must not overlap.
	static WIDTH_EPOCH: Mutex<()> = Mutex::new(());

	fn width_epoch_guard() -> MutexGuard<'static, ()> {
		WIDTH_EPOCH.lock()
	}

	impl Component for Probe {
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

		fn measure(&mut self, _ctx: &UiContext) -> (u16, u16) {
			self.measures.set(self.measures.get() + 1);
			(1, 2)
		}

		fn height(&mut self, _ctx: &UiContext, _width: u16) -> u16 {
			1
		}

		fn paint(&mut self, _pc: &mut PaintCtx<'_>, _rect: Rect) {}
	}

	#[test]
	fn dirty_update_invalidates_only_ancestor_path() {
		let _epoch = width_epoch_guard();
		let target_count = Rc::new(Cell::new(0));
		let sibling_count = Rc::new(Cell::new(0));
		let root_count = Rc::new(Cell::new(0));
		let target = Cached::new(Box::new(Probe::new(target_count.clone(), Vec::new())));
		let target_slot = target.comp().slot();
		let sibling = Cached::new(Box::new(Probe::new(sibling_count.clone(), Vec::new())));
		let mut root = Cached::new(Box::new(Probe::new(root_count.clone(), vec![target, sibling])));
		let ctx = UiContext::default();
		root.measure(&ctx);
		root.height(&ctx, 8);
		for child in root.comp.children_mut() {
			child.measure(&ctx);
			child.height(&ctx, 8);
		}
		root.update(target_slot, |_| ((), true)).unwrap();
		assert!(root.measured.is_none());
		assert!(root.laid.is_none());
		let children = root.comp.children();
		assert!(children[0].measured.is_none());
		assert!(children[0].laid.is_none());
		assert!(children[1].measured.is_some());
		assert!(children[1].laid.is_some());
		root.measure(&ctx);
		root.height(&ctx, 8);
		root.comp.children_mut()[0].measure(&ctx);
		root.comp.children_mut()[0].height(&ctx, 8);
		root.comp.children_mut()[1].measure(&ctx);
		root.comp.children_mut()[1].height(&ctx, 8);
		assert_eq!(root_count.get(), 2);
		assert_eq!(target_count.get(), 2);
		assert_eq!(sibling_count.get(), 1);

		root.update(target_slot, |_| ((), false)).unwrap();
		assert!(root.measured.is_some());
		assert!(root.laid.is_some());
		assert!(root.comp.children()[0].measured.is_some());
		assert!(root.comp.children()[0].laid.is_some());
		assert!(root.comp.children()[1].measured.is_some());
		assert!(root.comp.children()[1].laid.is_some());
	}

	#[test]
	fn into_children_flattens_supported_inputs() {
		let mut children = Vec::new();
		().extend_children(&mut children);
		Some("one").extend_children(&mut children);
		vec!["two", "three"].extend_children(&mut children);
		["four", "five"].extend_children(&mut children);
		assert_eq!(children.len(), 5);
	}

	#[test]
	fn elements_builder_resolves_registered_factory() {
		let elements = Elements::builder()
			.with("card", |_name: &str, _props: Props, _children: Vec<Cached>| {
				Box::new(Markdown::text_of("made")) as Box<dyn Component>
			})
			.build();
		let mut built = elements
			.get("card")
			.unwrap()
			.build("card", Props::new(), Vec::new());
		assert!(built.measure(&UiContext::default()).1 > 0);
		assert!(elements.get("missing").is_none());
	}
	#[test]
	fn width_epoch_invalidates_cached_measurement() {
		let _epoch = width_epoch_guard();
		let original = jamo_width();
		let next = if original == JamoWidth::Narrow {
			JamoWidth::Wide
		} else {
			JamoWidth::Narrow
		};
		let measures = Rc::new(Cell::new(0));
		let mut cached = Cached::new(Box::new(Probe::new(measures.clone(), Vec::new())));
		let ctx = UiContext::default();

		assert_eq!(cached.measure(&ctx), (1, 2));
		assert_eq!(cached.measure(&ctx), (1, 2));
		assert_eq!(measures.get(), 1);

		assert!(set_jamo_width(next));
		assert_eq!(cached.measure(&ctx), (1, 2));
		assert_eq!(measures.get(), 2);

		set_jamo_width(original);
	}
}
