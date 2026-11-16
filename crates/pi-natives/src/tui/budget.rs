//! Inline-image budget: the terminal graphics-store bookkeeping behind
//! pi-tui's `Image` component.
//!
//! [`Budget`] bounds how many inline images render as live terminal graphics
//! at once and tracks what each screen's graphics store holds. Components
//! drive it through the napi [`ImageBudget`] class while the host composes a
//! frame (`beginPass` / `observe` / `endPass`, transmit queueing); the
//! [`TerminalEngine`](super::engine::TerminalEngine) shares the same state
//! (`attachImageBudget`) and drains it when it paints: purges, transmits,
//! placement heights, residency, destructive-reset deletions, and the
//! alternate-screen lifecycle.

use std::{
	cell::{RefCell, RefMut},
	collections::{HashMap, HashSet},
	hash::{BuildHasher, RandomState},
	mem,
	rc::Rc,
	sync::{
		LazyLock,
		atomic::{AtomicU32, Ordering},
	},
};

use napi_derive::napi;

/// Default count of inline images kept as live graphics before older ones
/// fall back to text.
pub const DEFAULT_MAX_INLINE_IMAGES: u32 = 8;

/// Graphics ids are 24-bit: the Unicode-placeholder path encodes them in a
/// truecolor foreground.
const ID_MASK: u32 = 0x00ff_ffff;

/// Starting-id seed shared by every budget in the process: each budget starts
/// `0x10000` past the previous one, from a random origin, so budgets (and
/// processes) sharing one terminal rarely hand out colliding ids.
static NEXT_ID_SEED: LazyLock<AtomicU32> =
	LazyLock::new(|| AtomicU32::new(RandomState::new().hash_one(0u8) as u32 & ID_MASK));

fn next_image_id_seed() -> u32 {
	let seed = NEXT_ID_SEED
		.fetch_add(0x10000, Ordering::Relaxed)
		.wrapping_add(0x10000)
		& ID_MASK;
	seed.max(1)
}

/// `cap` as the host passed it: non-finite disables budgeting, fractions
/// truncate, negatives clamp to zero.
const fn normalize_cap(cap: f64) -> u32 {
	if cap.is_finite() {
		cap.trunc().max(0.0) as u32
	} else {
		0
	}
}

/// A surface the renderer paints frames on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Surface {
	Screen,
	Alt,
}

impl Surface {
	const ALL: [Self; 2] = [Self::Screen, Self::Alt];

	const fn index(self) -> usize {
		self as usize
	}
}

/// The live/text split of one drawing surface. The normal screen and the
/// alternate buffer hold separate frames with separate display orders, so
/// each carries its own thresholds: a modal's split describes the modal, and
/// applying it to the transcript would demote — and purge — images the modal
/// never showed.
#[derive(Default)]
struct SurfaceSplit {
	/// Suppress threshold reflected in the frame currently on this surface:
	/// images at display indices `[0, on_terminal)` are shown as text there.
	on_terminal: usize,
	/// Suppress threshold the current/next render of this surface should
	/// apply.
	planned:     usize,
	/// Images the last full pass on this surface observed.
	last_total:  usize,
	/// Display slot of every image the last full pass on this surface
	/// observed, keyed by id. A pass that cannot derive display order from
	/// its own walk — a partial `stable` pass, or a measuring observation —
	/// replays its decisions from these slots instead.
	slots:       HashMap<u32, usize>,
}

impl SurfaceSplit {
	/// Return to "nothing has been painted on this surface yet", in place.
	fn reset(&mut self) {
		self.on_terminal = 0;
		self.planned = 0;
		self.last_total = 0;
		self.slots.clear();
	}

	/// Whether `image_id` held a display slot below `threshold` in the last
	/// full pass on this surface.
	fn last_slot_below(&self, image_id: u32, threshold: usize) -> bool {
		self
			.slots
			.get(&image_id)
			.is_some_and(|&slot| slot < threshold)
	}
}

/// An insertion-ordered id set: residency sweeps retire the oldest
/// transmitted graphic first.
#[derive(Default)]
struct OrderedIds {
	order:   Vec<u32>,
	members: HashSet<u32>,
}

impl OrderedIds {
	fn contains(&self, id: u32) -> bool {
		self.members.contains(&id)
	}

	fn insert(&mut self, id: u32) {
		if self.members.insert(id) {
			self.order.push(id);
		}
	}

	fn remove(&mut self, id: u32) -> bool {
		let removed = self.members.remove(&id);
		if removed {
			self.order.retain(|&member| member != id);
		}
		removed
	}

	const fn len(&self) -> usize {
		self.order.len()
	}

	const fn is_empty(&self) -> bool {
		self.order.is_empty()
	}

	fn clear(&mut self) {
		self.order.clear();
		self.members.clear();
	}
}

/// Transmit sequences queued for one surface, in enqueue order.
#[derive(Default)]
struct PendingTransmits(Vec<(u32, String)>);

impl PendingTransmits {
	fn contains(&self, id: u32) -> bool {
		self.0.iter().any(|entry| entry.0 == id)
	}

	/// Queue `sequence` for `id`, replacing an entry already queued in place.
	fn set(&mut self, id: u32, sequence: String) {
		match self.0.iter_mut().find(|entry| entry.0 == id) {
			Some(entry) => entry.1 = sequence,
			None => self.0.push((id, sequence)),
		}
	}

	fn remove(&mut self, id: u32) -> bool {
		let Some(at) = self.0.iter().position(|entry| entry.0 == id) else {
			return false;
		};
		self.0.remove(at);
		true
	}

	const fn is_empty(&self) -> bool {
		self.0.is_empty()
	}

	fn clear(&mut self) {
		self.0.clear();
	}

	fn take(&mut self) -> Vec<String> {
		self.0.drain(..).map(|entry| entry.1).collect()
	}
}

/// What one emitted frame drains from the budget.
#[derive(Debug, Default)]
pub struct FrameImages {
	/// Image-data transmits (`a=t`) to write before the rows.
	pub transmits:       Vec<String>,
	/// Kitty image ids to delete.
	pub purge_ids:       Vec<u32>,
	/// Ids a destructive reset forgot, deleted explicitly on that reset.
	pub reset_purge_ids: Vec<u32>,
}

/// Bounds how many inline images render as live terminal graphics at once.
///
/// Terminal graphics protocols — Kitty especially — keep every transmitted
/// image in a per-screen store and re-draw placements as content scrolls;
/// placements that left the viewport survive text-clear escapes (`CSI 2 J`).
/// Unbounded, a session that shows many images piles up placements plus
/// store memory and leaves ghosts in scrollback.
///
/// The budget keeps the most recent `cap` images live and demotes older ones
/// to their text fallback. Demotion needs a full redraw (so off-screen rows
/// are rewritten) plus an explicit graphics purge of the demoted ids. `Image`
/// reports display order via [`observe`](Self::observe); when that reveals a
/// stricter split, the host repeats the pass before emitting its terminal
/// frame. Retired frames no longer observe their images, so the resident
/// store is also bounded across passes. Evicting retired graphics removes
/// their scrollback placements; a later replay can render or demote those
/// images again.
///
/// `cap` bounds one surface's live images, not the terminal's whole store. A
/// fullscreen overlay's frame and the normal screen standing behind it are
/// both on the terminal, and neither may delete the other's graphics — see
/// [`limit_resident_images`](Self::limit_resident_images) — so while a modal
/// is up the store legitimately holds up to `cap` per surface. Read `cap` as
/// "how many images one frame shows as graphics", not as a hard residency
/// ceiling.
///
/// `cap == 0` disables budgeting: every image stays a live graphic.
pub struct Budget {
	cap:               u32,
	next_id:           u32,
	key_to_id:         HashMap<String, u32>,
	id_to_key:         HashMap<u32, String>,
	/// Display-order image ids observed during the in-flight pass.
	pass_ids:          Vec<u32>,
	/// Per-id suppression decision from the first observation in this pass.
	pass_suppression:  HashMap<u32, bool>,
	/// Display index each observation was decided at, so
	/// [`pass_shows_live`](Self::pass_shows_live) can re-check it against a
	/// reconciled threshold without scanning `pass_ids` once per image.
	pass_index:        HashMap<u32, usize>,
	/// Live/text split of each surface (normal screen; alternate buffer for
	/// a fullscreen overlay or the resize borrow).
	splits:            [SurfaceSplit; 2],
	/// True while the in-flight pass applies a stricter threshold than the
	/// terminal shows — the demotion frame that must purge graphics and
	/// fully repaint.
	applying_reset:    bool,
	purge_ids:         Vec<u32>,
	/// Deletions that belong to a pending destructive reset, kept out of
	/// `purge_ids` so only that reset's own repaint can emit them. See
	/// [`forget_transmitted`](Self::forget_transmitted).
	reset_purge_ids:   Vec<u32>,
	/// Image ids whose data is believed to be loaded in each screen's store.
	/// kitty and Ghostty keep the normal and alternate buffers' graphics
	/// apart and wipe the alternate store on every `?1049h`, so data sent
	/// while one buffer was active is unknown to the other: a placement there
	/// resolves only after its own transmit.
	transmitted:       [OrderedIds; 2],
	/// Transmit sequences (full base64) to write once per surface, before
	/// that frame's placements.
	pending_transmits: [PendingTransmits; 2],
	/// True while the in-flight pass is a partial/throwaway pass (the
	/// non-multiplexer resize viewport fast path) that walks only the
	/// visible tail, bottom-up. Such a pass cannot derive display order from
	/// `observe()` call order, so its suppression decisions replay the
	/// committed split.
	stable_pass:       bool,
	/// The surface the in-flight pass composes for; selected by
	/// [`begin_pass`](Self::begin_pass).
	surface:           Surface,
	/// Image ids rendered as live graphics by the frame standing on each
	/// surface. A pass walks one surface, so the other's entry is what stops
	/// [`retire`](Self::retire) from deleting a graphic that is merely out of
	/// view — the transcript behind a fullscreen overlay keeps its placements
	/// and is restored from cache on exit.
	live_ids:          [HashSet<u32>; 2],
	/// Source pixel height of each direct-placement image, for clipping its
	/// placement at the viewport edge.
	placement_heights: HashMap<u32, f64>,
	/// Ids whose owner replaced them for good ([`release`](Self::release));
	/// retired once no frame shows them.
	released:          OrderedIds,
	/// A redraw is needed (demotion, relaxed threshold, cap change, an
	/// image's off-thread encode landing); consumed by the attached engine.
	render_requested:  bool,
	/// Wakes the attached engine so it consumes `render_requested` outside a
	/// frame.
	wake:              Option<Box<dyn Fn()>>,
}

impl Budget {
	pub fn new(cap: u32) -> Self {
		Self {
			cap,
			next_id: next_image_id_seed(),
			key_to_id: HashMap::new(),
			id_to_key: HashMap::new(),
			pass_ids: Vec::new(),
			pass_suppression: HashMap::new(),
			pass_index: HashMap::new(),
			splits: Default::default(),
			applying_reset: false,
			purge_ids: Vec::new(),
			reset_purge_ids: Vec::new(),
			transmitted: Default::default(),
			pending_transmits: Default::default(),
			stable_pass: false,
			surface: Surface::Screen,
			live_ids: Default::default(),
			placement_heights: HashMap::new(),
			released: OrderedIds::default(),
			render_requested: false,
			wake: None,
		}
	}

	pub const fn cap(&self) -> u32 {
		self.cap
	}

	pub fn set_cap(&mut self, cap: u32) {
		if cap == self.cap {
			return;
		}
		self.cap = cap;
		let total = self.splits[self.surface.index()].last_total;
		self.reconcile(total);
		self.render_requested = true;
	}

	/// Install the callback that wakes the attached engine.
	pub fn set_wake(&mut self, wake: Box<dyn Fn()>) {
		self.wake = Some(wake);
	}

	/// Ask for a repaint, e.g. once an image's off-thread encode settles. An
	/// attached engine is woken to schedule it.
	pub fn request_render(&mut self) {
		self.render_requested = true;
		if let Some(wake) = &self.wake {
			wake();
		}
	}

	/// Whether a redraw was requested since the last call.
	pub const fn take_render_request(&mut self) -> bool {
		mem::replace(&mut self.render_requested, false)
	}

	/// Stable graphics id for a logical image. A non-empty `key` maps to the
	/// same id across re-creations (so repaints replace the placement); a
	/// missing key gets a fresh id every call.
	pub fn acquire_id(&mut self, key: Option<&str>) -> u32 {
		let Some(key) = key.filter(|key| !key.is_empty()) else {
			return self.mint_id();
		};
		if let Some(&id) = self.key_to_id.get(key) {
			return id;
		}
		let id = self.mint_id();
		self.key_to_id.insert(key.to_owned(), id);
		self.id_to_key.insert(id, key.to_owned());
		id
	}

	fn mint_id(&mut self) -> u32 {
		let id = self.next_id;
		self.next_id = ((self.next_id + 1) & ID_MASK).max(1);
		id
	}

	/// Retire the graphic held under `key` as soon as no frame shows it,
	/// instead of when the residency sweep reaches it. For an owner that
	/// replaced the image for good — a streaming SVG figure's earlier raster
	/// — so superseded revisions never push older images (scrollback
	/// included) out of the store.
	pub fn release(&mut self, key: &str) {
		if let Some(&id) = self.key_to_id.get(key) {
			self.release_id(id);
		}
	}

	/// [`release`](Self::release) by id, for an owner holding the component:
	/// an image retired by the residency sweep and transmitted again keeps
	/// its id but no longer maps from its key.
	pub fn release_id(&mut self, id: u32) {
		self.released.insert(id);
	}

	/// Start an alternate-buffer lifecycle. Called once per `?1049h`, before
	/// the first pass of the fullscreen overlay or resize borrow that owns
	/// the buffer.
	///
	/// The alt split is a claim about the frame standing on that surface,
	/// and `?1049h` hands over a cleared one: the previous occupant's
	/// threshold would suppress this buffer's leading images against a frame
	/// that no longer exists, painting them as text until a corrective
	/// render lands. Passes *within* one lifecycle must keep sharing the
	/// split — that is what lets an over-cap discovery pass converge before
	/// the frame is emitted.
	pub fn begin_alt_screen_lifecycle(&mut self) {
		let alt = Surface::Alt.index();
		self.splits[alt].reset();
		self.live_ids[alt].clear();
		// `?1049h` hands over an empty graphics store as well as a cleared
		// grid.
		self.transmitted[alt].clear();
	}

	/// Begin a render pass. Called by the host before composing the frame.
	/// Pass `stable` for a partial/throwaway pass that does not walk the
	/// whole tree in display order (the resize viewport fast path):
	/// [`observe`](Self::observe) then replays the last committed per-id
	/// decision instead of one derived from call order, and the pass must
	/// NOT be closed with [`end_pass`](Self::end_pass).
	///
	/// Pass `alt_screen` when the frame is painted on the alternate buffer
	/// (fullscreen overlay, resize borrow). The pass then reads and writes
	/// that surface's own split and its live set adds to the recorded
	/// normal-screen one instead of replacing it, so a modal's threshold
	/// never reaches the transcript standing behind it.
	pub fn begin_pass(&mut self, stable: bool, alt_screen: bool) {
		self.pass_ids.clear();
		self.pass_suppression.clear();
		self.pass_index.clear();
		self.stable_pass = stable;
		self.surface = if alt_screen {
			Surface::Alt
		} else {
			Surface::Screen
		};
		// Composing for the screen means the alternate buffer holds no frame
		// to protect: live renders reach the normal-screen paths only when
		// the host has ruled out both alt-buffer owners, and the one caller
		// outside that dispatch — the shutdown history flush — writes
		// `?1049l` first. Note that leaving alt mode is not the same as
		// unstacking a fullscreen overlay: the flush must exclude one that is
		// still stacked from the pass itself, which is that caller's job, not
		// this line's.
		if !alt_screen {
			self.live_ids[Surface::Alt.index()].clear();
		}
		let split = &self.splits[self.surface.index()];
		self.applying_reset = !stable && self.cap > 0 && split.planned > split.on_terminal;
	}

	/// Record an image in display order and report whether it must render
	/// its text fallback this frame. Called by every `Image` during render —
	/// including on a cache hit, so the image keeps its display-order slot.
	///
	/// During a `stable` pass ([`begin_pass`](Self::begin_pass)) the call
	/// order and visible subset are not authoritative, so the decision is
	/// the surface's committed on-terminal split, keyed by id — order- and
	/// partiality-independent.
	///
	/// A `measuring` observation (pi-tui's `measureRender`) claims no slot:
	/// it answers what the image's slot in the last full pass implies under
	/// the planned threshold, which is what the display-order render that
	/// follows will decide once the split has converged.
	pub fn observe(&mut self, image_id: u32, measuring: bool) -> bool {
		if let Some(&suppressed) = self.pass_suppression.get(&image_id) {
			return suppressed;
		}
		let enabled = self.cap > 0;
		let split = &self.splits[self.surface.index()];
		if self.stable_pass {
			let suppressed = enabled && split.last_slot_below(image_id, split.on_terminal);
			self.pass_suppression.insert(image_id, suppressed);
			if suppressed {
				self.forget_key_for_id(image_id);
			}
			return suppressed;
		}
		if measuring {
			return enabled && split.last_slot_below(image_id, split.planned);
		}
		let index = self.pass_ids.len();
		let suppressed = enabled && index < split.planned;
		self.pass_ids.push(image_id);
		self.pass_suppression.insert(image_id, suppressed);
		self.pass_index.insert(image_id, index);
		if suppressed {
			self.forget_key_for_id(image_id);
		}
		suppressed
	}

	/// End a render pass. Returns true when the pass discovered a stricter
	/// budget and must be repeated before its terminal frame is emitted.
	pub fn end_pass(&mut self) -> bool {
		let total = self.pass_ids.len();
		let surface = self.surface.index();
		self.splits[surface].last_total = total;
		if self.applying_reset {
			// This frame replaced these with their text fallback, so their
			// graphics are retired as far as this surface is concerned.
			let split = &self.splits[surface];
			for index in split.on_terminal..split.planned.min(total) {
				self.retire(self.pass_ids[index]);
			}
			let split = &mut self.splits[surface];
			split.on_terminal = split.planned;
			self.applying_reset = false;
		}
		let retry = self.reconcile(total);
		// Snapshot display order by id. Partial passes (see `stable_pass`)
		// and measuring observations replay their decisions from it instead
		// of re-deriving them from a reversed or tail-only walk.
		let slots = &mut self.splits[surface].slots;
		slots.clear();
		slots.extend(
			self
				.pass_ids
				.iter()
				.enumerate()
				.map(|(index, &id)| (id, index)),
		);
		retry
	}

	/// Bound the terminal's image store to `cap`. Demotion
	/// ([`end_pass`](Self::end_pass)) already retires the graphics this frame
	/// replaced with text; this sweeps the ones no frame shows any more —
	/// images the pass simply stopped observing.
	///
	/// Also records what this frame leaves standing on its surface, which is
	/// how the next pass on the *other* surface knows what it may not
	/// destroy.
	pub fn limit_resident_images(&mut self) {
		let surface = self.surface.index();
		let mut live_ids = mem::take(&mut self.live_ids[surface]);
		live_ids.clear();
		live_ids.extend(
			self
				.pass_ids
				.iter()
				.copied()
				.filter(|&id| self.pass_shows_live(id)),
		);
		self.live_ids[surface] = live_ids;
		let mut index = 0;
		while let Some(&id) = self.released.order.get(index) {
			// `retire` refuses while this pass or the other surface still
			// shows it.
			if self.transmitted[surface].contains(id) {
				self.retire(id);
			}
			if self.is_transmitted(id) {
				index += 1;
				continue;
			}
			self.forget_key_for_id(id);
			self.released.remove(id);
		}
		let cap = self.cap as usize;
		if cap == 0 {
			return;
		}
		let mut index = 0;
		while self.transmitted[surface].len() > cap {
			let Some(&id) = self.transmitted[surface].order.get(index) else {
				break;
			};
			// A retired id leaves the order, so the next candidate takes its
			// index.
			if !self.retire(id) {
				index += 1;
			}
		}
	}

	/// Whether this pass leaves `image_id` on its surface as a live graphic.
	///
	/// Not simply "was not suppressed". A pass decides suppression from the
	/// threshold standing at [`begin_pass`](Self::begin_pass), and
	/// [`end_pass`](Self::end_pass) may then reconcile that threshold
	/// *downwards* — the frame is emitted with a text fallback the very next
	/// frame will replace with the graphic again. Reading such a decision as
	/// retirement would delete an image the surface is about to show, and
	/// `d=I` takes placements no repaint can restore. So a suppression the
	/// reconcile has since undercut counts as live.
	fn pass_shows_live(&self, image_id: u32) -> bool {
		match self.pass_suppression.get(&image_id) {
			None => false,
			Some(false) => true,
			// Absent (a `stable` pass replays the committed split rather than
			// deriving an order) counts as live, so an unknown decision never
			// authorises a delete.
			Some(true) => self
				.pass_index
				.get(&image_id)
				.is_none_or(|&index| index >= self.splits[self.surface.index()].planned),
		}
	}

	/// Drop `image_id` from the painted surface's image store: queue its
	/// `d=I` (or cancel a transmit that never went out) and, once no surface
	/// holds its data, forget its placement ledger and key.
	///
	/// The single gate on every destruction path. `d=I` removes an image's
	/// placements everywhere on its screen, scrollback included, and a frame
	/// diff only rewrites rows whose text changed — so a graphic some
	/// standing frame still shows cannot be repaired once deleted, and must
	/// never be a candidate. Refuses when the in-flight pass renders the
	/// image live, or when the frame on any surface this pass is not
	/// repainting does. Returns whether it was retired.
	fn retire(&mut self, image_id: u32) -> bool {
		if self.pass_shows_live(image_id) {
			return false;
		}
		let shown_elsewhere = Surface::ALL.into_iter().any(|surface| {
			surface != self.surface && self.live_ids[surface.index()].contains(&image_id)
		});
		if shown_elsewhere {
			return false;
		}
		let surface = self.surface.index();
		// A transmit queued by a discarded discovery pass never reached the
		// terminal, so cancel it instead of transmitting then purging.
		if !self.pending_transmits[surface].remove(image_id) {
			self.purge_ids.push(image_id);
		}
		self.transmitted[surface].remove(image_id);
		if !self.is_transmitted(image_id) {
			self.placement_heights.remove(&image_id);
		}
		self.forget_key_for_id(image_id);
		true
	}

	/// Whether any screen's store is believed to hold `image_id`'s data.
	fn is_transmitted(&self, image_id: u32) -> bool {
		self.transmitted.iter().any(|ids| ids.contains(image_id))
	}

	/// Image ids a destructive reset must delete explicitly, alongside its
	/// `d=A`. Emit only from that reset's repaint; clears the queue.
	pub fn take_reset_purge_ids(&mut self) -> Vec<u32> {
		mem::take(&mut self.reset_purge_ids)
	}

	/// Image ids to delete from the terminal this frame; clears the pending
	/// set.
	pub fn take_purge_ids(&mut self) -> Vec<u32> {
		mem::take(&mut self.purge_ids)
	}

	/// All image ids believed to be loaded in any screen's store; clears
	/// tracking.
	pub fn take_all_transmitted_ids(&mut self) -> Vec<u32> {
		let mut ids = Vec::new();
		for surface in Surface::ALL {
			let surface = surface.index();
			for &id in &self.transmitted[surface].order {
				if !ids.contains(&id) {
					ids.push(id);
				}
			}
			self.transmitted[surface].clear();
			self.pending_transmits[surface].clear();
		}
		if ids.is_empty() {
			return ids;
		}
		self.purge_ids.clear();
		self.reset_purge_ids.clear();
		self.key_to_id.clear();
		self.id_to_key.clear();
		self.placement_heights.clear();
		self.released.clear();
		for live_ids in &mut self.live_ids {
			live_ids.clear();
		}
		ids
	}

	/// Whether `image_id`'s data still needs to be transmitted to the
	/// surface the in-flight pass paints.
	pub fn should_transmit(&self, image_id: u32) -> bool {
		!self.transmitted[self.surface.index()].contains(image_id)
	}

	/// Record a direct-placement image's source pixel height so the
	/// renderer can clip its placement to the visible slice at write time;
	/// cleared when the image is purged from the terminal store.
	pub fn register_placement_height(&mut self, image_id: u32, height_px: f64) {
		self.placement_heights.insert(image_id, height_px);
	}

	/// Source height of a direct placement, or 0 when none was registered.
	pub fn placement_height(&self, image_id: u32) -> f64 {
		self
			.placement_heights
			.get(&image_id)
			.copied()
			.unwrap_or(0.0)
	}

	/// Queue a one-time transmit for `image_id` on the surface the in-flight
	/// pass paints. No-op if that surface already holds the data, so a
	/// repeated call (e.g. a width-change re-render) never re-sends it.
	pub fn enqueue_transmit(&mut self, image_id: u32, sequence: String) {
		let surface = self.surface.index();
		if self.transmitted[surface].contains(image_id) {
			return;
		}
		self.transmitted[surface].insert(image_id);
		self.pending_transmits[surface].set(image_id, sequence);
	}

	/// Whether the in-flight pass's surface has image data queued but not
	/// yet written.
	pub const fn has_pending_transmits(&self) -> bool {
		!self.pending_transmits[self.surface.index()].is_empty()
	}

	/// Transmit sequences to write before this frame's placements on its
	/// surface; clears that queue.
	pub fn take_transmits(&mut self) -> Vec<String> {
		self.pending_transmits[self.surface.index()].take()
	}

	/// Drain what the frame about to be presented emits. The host composes
	/// its overlays inside the budget pass, so the composed rows are already
	/// the complete frame. The store is bounded here rather than at
	/// [`end_pass`](Self::end_pass): this is the last point before the purge
	/// and transmit bytes go out, and it runs once per emitted frame instead
	/// of once per retry.
	///
	/// `reset`: the frame is a destructive Kitty repaint, which also deletes
	/// the ids a reset forgot — their tracking is gone, so nothing downstream
	/// could find them again.
	pub fn drain_frame(&mut self, reset: bool) -> FrameImages {
		self.limit_resident_images();
		FrameImages {
			reset_purge_ids: if reset {
				self.take_reset_purge_ids()
			} else {
				Vec::new()
			},
			purge_ids:       self.take_purge_ids(),
			transmits:       self.take_transmits(),
		}
	}

	/// Drop the normal screen's transmit tracking so every still-live image
	/// re-enqueues its data (`a=t`) on the next render. A destructive reset
	/// opens with `d=A`, so its repaint must re-send every image's data
	/// alongside its placement; also recovers when the terminal dropped the
	/// original transmit — e.g. Ghostty discarding graphics sent during its
	/// post-startup window — where a placement-only replay can never bind a
	/// Unicode placeholder. Keeps no base64 in budget state (the
	/// transmit-once design).
	pub fn forget_transmitted(&mut self) {
		let screen = Surface::Screen.index();
		let transmitted = &mut self.transmitted[screen];
		let pending = &mut self.pending_transmits[screen];
		if transmitted.is_empty() && pending.is_empty() {
			return;
		}
		// The ids go to `reset_purge_ids`, drained only by the destructive
		// repaint itself — never to `purge_ids`, which any frame drains.
		// That is how a deletion used to ride out on an alternate-buffer
		// frame and leave the normal screen blank with no repaint left to
		// restore it.
		//
		// `d=A` alone is not enough to skip these: Kitty excludes *virtual*
		// placements from it, and erasing placeholder text does not remove
		// the prototype either. Forgetting drops the id from tracking, so
		// without an explicit `d=I` no later sweep can ever find that
		// placement again.
		self.reset_purge_ids.extend(
			transmitted
				.order
				.iter()
				.copied()
				.filter(|&id| !pending.contains(id)),
		);
		transmitted.clear();
		pending.clear();
	}

	/// Release `id`'s stable key so a component recreated under it gets a
	/// fresh id — but only once the terminal no longer holds `id`'s data,
	/// because a key must never resolve to an id whose graphic is gone.
	///
	/// Key lifetime follows residency, not the live/text split. The two
	/// usually agree: an image shown as text has had its graphic purged.
	/// They diverge when [`retire`](Self::retire) refuses, which leaves a
	/// suppressed image resident on another surface — and releasing a
	/// resident id's key orphans it. The recreation mints a new id, nothing
	/// observes the old one again, and the next pass retires it, deleting
	/// every placement it ever made including scrollback copies.
	fn forget_key_for_id(&mut self, id: u32) {
		if self.is_transmitted(id) {
			return;
		}
		let Some(key) = self.id_to_key.remove(&id) else {
			return;
		};
		if self.key_to_id.get(&key) == Some(&id) {
			self.key_to_id.remove(&key);
		}
	}

	fn reconcile(&mut self, total: usize) -> bool {
		let cap = self.cap as usize;
		let split = &mut self.splits[self.surface.index()];
		let desired = if cap > 0 {
			total.saturating_sub(cap)
		} else {
			0
		};
		if desired == split.planned {
			// Budget relaxed without a stricter frame (cap raised or images
			// removed): surviving graphics are untouched and re-exposed rows
			// repaint normally, so just track the looser threshold.
			split.on_terminal = split.on_terminal.min(split.planned);
			return false;
		}
		let retry = desired > split.on_terminal;
		split.planned = desired;
		// More images must be demoted than the terminal shows: schedule the
		// purge + full-redraw frame. Fewer: no ghosts to clear, so just catch
		// the tracking up — a normal repaint re-exposes the un-demoted
		// images. Either way a render is needed to apply the new threshold.
		split.on_terminal = split.on_terminal.min(desired);
		self.render_requested = true;
		retry
	}
}

/// Shared handle to one [`Budget`]: held by its napi [`ImageBudget`] and by
/// the engine it is attached to.
pub type SharedBudget = Rc<RefCell<Budget>>;

/// The inline-image budget pi-tui components render against
/// (`tui.imageBudget`).
///
/// Attach it to the terminal engine (`TerminalEngine.attachImageBudget`) and
/// the engine drains it on every paint and schedules the redraws it asks for.
#[napi]
pub struct ImageBudget {
	state: SharedBudget,
}

impl ImageBudget {
	/// The state the engine shares.
	pub fn shared(&self) -> SharedBudget {
		Rc::clone(&self.state)
	}

	fn state(&self) -> RefMut<'_, Budget> {
		self.state.borrow_mut()
	}
}

#[napi]
impl ImageBudget {
	/// `cap` live images per frame (default 8); `0` disables budgeting.
	#[napi(constructor)]
	pub fn new(cap: Option<f64>) -> Self {
		let cap = cap.map_or(DEFAULT_MAX_INLINE_IMAGES, normalize_cap);
		Self { state: Rc::new(RefCell::new(Budget::new(cap))) }
	}

	#[napi(getter)]
	pub fn cap(&self) -> u32 {
		self.state.borrow().cap()
	}

	#[napi(getter)]
	pub fn enabled(&self) -> bool {
		self.state.borrow().cap() > 0
	}

	/// Change the cap; the attached engine schedules the redraw that applies
	/// it.
	#[napi]
	pub fn set_cap(&self, cap: f64) {
		self.state().set_cap(normalize_cap(cap));
	}

	/// Stable graphics id for a logical image. A non-empty `key` maps to the
	/// same id across re-creations (so repaints replace the placement); a
	/// missing key gets a fresh id every call.
	#[napi]
	pub fn acquire_id(&self, key: Option<String>) -> u32 {
		self.state().acquire_id(key.as_deref())
	}

	/// Retire the graphic held under `key` as soon as no frame shows it.
	#[napi]
	pub fn release(&self, key: String) {
		self.state().release(&key);
	}

	/// Retire the graphic `id` as soon as no frame shows it.
	#[napi]
	pub fn release_id(&self, id: u32) {
		self.state().release_id(id);
	}

	/// Begin a render pass; `stable` for a partial pass that is never ended,
	/// `altScreen` for a frame painted on the alternate buffer.
	#[napi]
	pub fn begin_pass(&self, stable: Option<bool>, alt_screen: Option<bool>) {
		self
			.state()
			.begin_pass(stable.unwrap_or(false), alt_screen.unwrap_or(false));
	}

	/// Record an image in display order; true when it must render its text
	/// fallback this frame. `measuring`: an out-of-order measuring render
	/// (`measureRender`), which claims no display slot.
	#[napi]
	pub fn observe(&self, image_id: u32, measuring: Option<bool>) -> bool {
		self.state().observe(image_id, measuring.unwrap_or(false))
	}

	/// End a render pass; true when the pass must be repeated before its
	/// frame is emitted.
	#[napi]
	pub fn end_pass(&self) -> bool {
		self.state().end_pass()
	}

	/// Whether `imageId`'s data still needs to be transmitted to the surface
	/// the in-flight pass paints.
	#[napi]
	pub fn should_transmit(&self, image_id: u32) -> bool {
		self.state.borrow().should_transmit(image_id)
	}

	/// Ask the attached engine for a repaint (an off-thread encode landed).
	#[napi]
	pub fn request_render(&self) {
		self.state().request_render();
	}
}

#[cfg(test)]
mod tests {
	use std::cell::Cell;

	use super::*;

	struct Pass {
		suppressed: Vec<bool>,
		retry:      bool,
		purge:      Vec<u32>,
	}

	/// Drive one render pass with `count` images (ids `1..=count`, stable
	/// across passes).
	fn pass(budget: &mut Budget, count: u32) -> Pass {
		budget.begin_pass(false, false);
		let suppressed = (1..=count).map(|id| budget.observe(id, false)).collect();
		let retry = budget.end_pass();
		Pass { suppressed, retry, purge: budget.take_purge_ids() }
	}

	fn observe_pass(budget: &mut Budget, ids: &[u32], alt_screen: bool) -> bool {
		budget.begin_pass(false, alt_screen);
		for &id in ids {
			budget.observe(id, false);
		}
		budget.end_pass()
	}

	#[test]
	fn keeps_every_image_live_at_or_under_the_cap() {
		let mut budget = Budget::new(3);
		let first = pass(&mut budget, 2);
		assert_eq!(first.suppressed, [false, false]);
		assert!(!first.retry);
		let second = pass(&mut budget, 3);
		assert_eq!(second.suppressed, [false, false, false]);
		assert!(!second.retry);
		assert!(second.purge.is_empty());
	}

	#[test]
	fn repeats_an_over_cap_pass_and_purges_the_oldest_id() {
		let mut budget = Budget::new(2);
		// At cap: nothing demoted.
		assert_eq!(pass(&mut budget, 2).suppressed, [false, false]);
		assert!(!budget.take_render_request());

		// Discovery identifies the stricter split and requires a retry
		// before emit.
		let overflow = pass(&mut budget, 3);
		assert_eq!(overflow.suppressed, [false, false, false]);
		assert!(overflow.retry);
		assert!(budget.take_render_request());

		// The retry demotes the oldest image and purges its id (1).
		let demote = pass(&mut budget, 3);
		assert_eq!(demote.suppressed, [true, false, false]);
		assert!(!demote.retry);
		assert_eq!(demote.purge, [1]);

		// Steady state: no further retries while the count is unchanged.
		let steady = pass(&mut budget, 3);
		assert_eq!(steady.suppressed, [true, false, false]);
		assert!(!steady.retry);
		assert!(steady.purge.is_empty());
	}

	#[test]
	fn keeps_exactly_cap_images_live_as_more_arrive() {
		let mut budget = Budget::new(2);
		// Each addition settles in a pre-emission retry.
		for count in 3..=5 {
			pass(&mut budget, count);
			pass(&mut budget, count);
		}
		assert_eq!(pass(&mut budget, 5).suppressed, [true, true, true, false, false]);
	}

	#[test]
	fn cap_zero_never_demotes_or_schedules_a_redraw() {
		let mut budget = Budget::new(0);
		let result = pass(&mut budget, 6);
		assert_eq!(result.suppressed, [false; 6]);
		assert!(!result.retry);
		assert!(result.purge.is_empty());
		assert!(!budget.take_render_request());
	}

	#[test]
	fn restores_demoted_images_once_the_count_settles_back() {
		let mut budget = Budget::new(2);
		pass(&mut budget, 3);
		pass(&mut budget, 3);
		assert_eq!(pass(&mut budget, 3).suppressed, [true, false, false]);

		// Drop back to 2 images; after the threshold settles nothing is
		// demoted.
		pass(&mut budget, 2);
		let restored = pass(&mut budget, 2);
		assert_eq!(restored.suppressed, [false, false]);
		assert!(!restored.retry);
		assert!(restored.purge.is_empty());
	}

	#[test]
	fn hands_back_a_stable_id_per_key_and_fresh_ids_without_one() {
		let mut budget = Budget::new(3);
		let a1 = budget.acquire_id(Some("tool:0"));
		let a2 = budget.acquire_id(Some("tool:0"));
		let b = budget.acquire_id(Some("tool:1"));
		assert_eq!(a1, a2);
		assert_ne!(b, a1);
		assert_ne!(budget.acquire_id(None), budget.acquire_id(None));
		assert_ne!(budget.acquire_id(Some("")), budget.acquire_id(Some("")));
	}

	#[test]
	fn separate_budgets_start_at_different_ids() {
		let mut first = Budget::new(DEFAULT_MAX_INLINE_IMAGES);
		let mut second = Budget::new(DEFAULT_MAX_INLINE_IMAGES);
		assert_ne!(first.acquire_id(None), second.acquire_id(None));
	}

	#[test]
	fn evicts_demoted_ids_from_the_key_map() {
		let mut budget = Budget::new(2);
		let id1 = budget.acquire_id(Some("keyA"));
		let id2 = budget.acquire_id(Some("keyB"));
		let id3 = budget.acquire_id(Some("keyC"));

		// At cap: only 2 images.
		observe_pass(&mut budget, &[id1, id2], false);
		assert_eq!(budget.acquire_id(Some("keyA")), id1);
		assert_eq!(budget.acquire_id(Some("keyB")), id2);

		// Overflow schedules the demotion of id1; the key map still holds it
		// until the retry applies the demotion.
		observe_pass(&mut budget, &[id1, id2, id3], false);
		assert_eq!(budget.acquire_id(Some("keyA")), id1);

		// The retry applies the purge of id1 without requiring another pass.
		assert!(!observe_pass(&mut budget, &[id1, id2, id3], false));

		// id1 was purged: acquiring "keyA" now yields a fresh id.
		assert_ne!(budget.acquire_id(Some("keyA")), id1);
		assert_eq!(budget.acquire_id(Some("keyB")), id2);
		assert_eq!(budget.acquire_id(Some("keyC")), id3);
	}

	#[test]
	fn evicts_keys_reacquired_for_images_that_remain_suppressed() {
		let mut budget = Budget::new(2);
		let old_id = budget.acquire_id(Some("keyA"));
		let id2 = budget.acquire_id(Some("keyB"));
		let id3 = budget.acquire_id(Some("keyC"));

		observe_pass(&mut budget, &[old_id, id2, id3], false);
		assert!(!observe_pass(&mut budget, &[old_id, id2, id3], false));
		assert_eq!(budget.take_purge_ids(), [old_id]);

		let suppressed_id = budget.acquire_id(Some("keyA"));
		assert_ne!(suppressed_id, old_id);

		budget.begin_pass(false, false);
		assert!(budget.observe(suppressed_id, false));
		assert!(!budget.observe(id2, false));
		assert!(!budget.observe(id3, false));
		assert!(!budget.end_pass());
		assert!(budget.take_purge_ids().is_empty());

		assert_ne!(budget.acquire_id(Some("keyA")), suppressed_id);
	}

	#[test]
	fn take_all_transmitted_ids_clears_every_key() {
		let mut budget = Budget::new(3);
		let id1 = budget.acquire_id(Some("keyA"));
		let id2 = budget.acquire_id(Some("keyB"));
		budget.enqueue_transmit(id1, "TX1".into());
		budget.enqueue_transmit(id2, "TX2".into());

		budget.take_all_transmitted_ids();

		assert_ne!(budget.acquire_id(Some("keyA")), id1);
		assert_ne!(budget.acquire_id(Some("keyB")), id2);
	}

	#[test]
	fn cap_zero_clears_an_applied_demotion_threshold() {
		let mut budget = Budget::new(2);
		pass(&mut budget, 3);
		pass(&mut budget, 3);
		assert_eq!(pass(&mut budget, 3).suppressed, [true, false, false]);

		budget.set_cap(0);
		assert!(budget.take_render_request());
		assert_eq!(pass(&mut budget, 3).suppressed, [false, false, false]);
	}

	#[test]
	fn set_cap_requests_a_render_only_on_change() {
		let mut budget = Budget::new(2);
		budget.set_cap(2);
		assert!(!budget.take_render_request());
		budget.set_cap(4);
		assert!(budget.take_render_request());
	}

	#[test]
	fn replaces_suppression_snapshots_independently_across_surfaces() {
		let mut budget = Budget::new(1);
		assert!(observe_pass(&mut budget, &[1, 2, 3], false));
		assert!(!observe_pass(&mut budget, &[1, 2, 3], false));
		budget.begin_alt_screen_lifecycle();
		assert!(observe_pass(&mut budget, &[4, 5], true));
		assert!(!observe_pass(&mut budget, &[4, 5], true));

		// Replacing and shrinking the screen prefix must neither retain old
		// ids nor mutate the independently committed alternate-buffer
		// prefix.
		assert!(!observe_pass(&mut budget, &[6, 7], false));
		budget.begin_pass(true, false);
		assert_eq!([1, 2, 6, 7].map(|id| budget.observe(id, false)), [false, false, true, false]);
		budget.begin_pass(true, true);
		assert_eq!([4, 5, 6].map(|id| budget.observe(id, false)), [true, false, false]);

		budget.begin_alt_screen_lifecycle();
		budget.begin_pass(true, true);
		assert!(!budget.observe(4, false));
		budget.begin_pass(true, false);
		assert!(budget.observe(6, false));

		assert!(!observe_pass(&mut budget, &[], false));
		budget.begin_pass(true, false);
		assert!(!budget.observe(6, false));
	}

	#[test]
	fn keeps_the_other_surface_protected_across_live_snapshots() {
		fn observe_pass(budget: &mut Budget, ids: &[u32], alt_screen: bool) -> bool {
			budget.begin_pass(false, alt_screen);
			for &id in ids {
				if !budget.observe(id, false) {
					budget.enqueue_transmit(id, format!("TX{id}"));
				}
			}
			let retry = budget.end_pass();
			if !retry {
				budget.limit_resident_images();
			}
			retry
		}

		let mut budget = Budget::new(1);

		assert!(!observe_pass(&mut budget, &[1], false));
		assert_eq!(budget.take_transmits(), ["TX1"]);
		budget.begin_alt_screen_lifecycle();
		assert!(observe_pass(&mut budget, &[1, 2], true));
		assert!(!observe_pass(&mut budget, &[1, 2], true));
		assert!(budget.take_purge_ids().is_empty());
		assert_eq!(budget.take_transmits(), ["TX1", "TX2"]);

		// The first pass relaxes the old threshold; the next transmits id 3.
		assert!(!observe_pass(&mut budget, &[3], true));
		assert!(!observe_pass(&mut budget, &[3], true));
		assert_eq!(budget.take_purge_ids(), [2]);
		assert_eq!(budget.take_transmits(), ["TX3"]);
		assert!(!budget.should_transmit(1));

		// Removing the screen frame releases its protection. The next
		// alternate pass may retire id 1, but must keep its own current
		// graphic, id 3.
		assert!(!observe_pass(&mut budget, &[], false));
		assert!(!observe_pass(&mut budget, &[3], true));
		assert_eq!(budget.take_purge_ids(), [1]);
		assert!(budget.should_transmit(1));
		assert!(!budget.should_transmit(3));
	}

	#[test]
	fn stable_pass_replays_the_committed_split_by_id() {
		let mut budget = Budget::new(2);
		// Settle to the steady split for 4 images at cap 2: ids 1,2 text,
		// ids 3,4 live.
		pass(&mut budget, 4);
		pass(&mut budget, 4);
		assert_eq!(pass(&mut budget, 4).suppressed, [true, true, false, false]);

		// The resize fast path observes the visible tail bottom-up and only a
		// subset of images: a stable pass decides by the committed per-id
		// split, not by call order.
		budget.begin_pass(true, false);
		assert!(!budget.observe(4, false));
		assert!(!budget.observe(3, false));
		assert!(budget.observe(2, false));
		assert!(budget.observe(1, false));
		// An id with no committed state (a brand-new image) defaults to live.
		assert!(!budget.observe(99, false));

		// The stable pass left the ledger untouched.
		let after = pass(&mut budget, 4);
		assert_eq!(after.suppressed, [true, true, false, false]);
		assert!(!after.retry);
		assert!(after.purge.is_empty());
	}

	#[test]
	fn measuring_observations_claim_no_slot() {
		let mut budget = Budget::new(1);
		pass(&mut budget, 2);
		pass(&mut budget, 2);
		// Newest-first measurement replays the last full pass's slots.
		budget.begin_pass(false, false);
		assert!(!budget.observe(2, true));
		assert!(budget.observe(1, true));
		// The display-order walk that follows still owns the slots.
		assert!(budget.observe(1, false));
		assert!(!budget.observe(2, false));
		assert!(!budget.end_pass());
	}

	#[test]
	fn transmits_an_id_once_and_clears_the_queue_when_drained() {
		let mut budget = Budget::new(3);
		assert!(budget.should_transmit(1));
		budget.enqueue_transmit(1, "TX1".into());
		assert!(!budget.should_transmit(1));
		// Already transmitted: no-op.
		budget.enqueue_transmit(1, "TX1-dup".into());
		assert!(budget.has_pending_transmits());
		assert_eq!(budget.take_transmits(), ["TX1"]);
		assert!(budget.take_transmits().is_empty());
		assert!(!budget.has_pending_transmits());
	}

	#[test]
	fn purges_all_transmitted_ids_for_session_cleanup() {
		let mut budget = Budget::new(3);
		budget.enqueue_transmit(1, "TX1".into());
		budget.enqueue_transmit(2, "TX2".into());
		assert!(!budget.should_transmit(1));

		assert_eq!(budget.take_all_transmitted_ids(), [1, 2]);
		assert!(budget.take_transmits().is_empty());
		assert!(budget.should_transmit(1));
		assert!(budget.take_all_transmitted_ids().is_empty());
	}

	#[test]
	fn retransmits_an_image_after_a_purge_frees_its_data() {
		let mut budget = Budget::new(2);
		budget.enqueue_transmit(1, "TX1".into());
		assert_eq!(budget.take_transmits(), ["TX1"]);
		assert!(!budget.should_transmit(1));

		// Push past the cap so the oldest image (id 1) is demoted and purged.
		pass(&mut budget, 3);
		assert_eq!(pass(&mut budget, 3).purge, [1]);

		// d=I freed the data, so the image must transmit again if it returns.
		assert!(budget.should_transmit(1));
	}

	#[test]
	fn cancels_a_queued_transmit_instead_of_purging_it() {
		let mut budget = Budget::new(1);
		observe_pass(&mut budget, &[1], false);
		budget.enqueue_transmit(1, "TX1".into());
		budget.limit_resident_images();
		// A frame that stops showing id 1 before its transmit went out.
		observe_pass(&mut budget, &[], false);
		budget.enqueue_transmit(2, "TX2".into());
		budget.enqueue_transmit(3, "TX3".into());
		let frame = budget.drain_frame(false);
		assert!(frame.purge_ids.is_empty());
		assert_eq!(frame.transmits, ["TX3"]);
		assert!(budget.should_transmit(1));
	}

	#[test]
	fn releases_a_retired_owner_once_no_frame_shows_it() {
		let mut budget = Budget::new(4);
		let id = budget.acquire_id(Some("svg:1"));
		observe_pass(&mut budget, &[id], false);
		budget.enqueue_transmit(id, "TX".into());
		budget.release("svg:1");
		// Still shown by this pass: kept.
		assert!(budget.drain_frame(false).purge_ids.is_empty());
		observe_pass(&mut budget, &[], false);
		assert_eq!(budget.drain_frame(false).purge_ids, [id]);
		assert_ne!(budget.acquire_id(Some("svg:1")), id);
	}

	#[test]
	fn forget_transmitted_queues_reset_deletions_for_the_reset_only() {
		let mut budget = Budget::new(4);
		budget.enqueue_transmit(1, "TX1".into());
		budget.take_transmits();
		budget.enqueue_transmit(2, "TX2".into());
		budget.forget_transmitted();
		// Only the id whose data reached the terminal needs a delete.
		assert!(budget.drain_frame(false).reset_purge_ids.is_empty());
		assert_eq!(budget.drain_frame(true).reset_purge_ids, [1]);
		assert!(budget.should_transmit(1));
		assert!(budget.should_transmit(2));
	}

	#[test]
	fn request_render_wakes_the_attached_engine() {
		let woken = Rc::new(Cell::new(0));
		let mut budget = Budget::new(1);
		budget.request_render();
		assert!(budget.take_render_request());
		let counter = Rc::clone(&woken);
		budget.set_wake(Box::new(move || counter.set(counter.get() + 1)));
		budget.request_render();
		assert_eq!(woken.get(), 1);
		assert!(budget.take_render_request());
		assert!(!budget.take_render_request());
	}

	#[test]
	fn normalizes_caps() {
		assert_eq!(normalize_cap(f64::NAN), 0);
		assert_eq!(normalize_cap(f64::INFINITY), 0);
		assert_eq!(normalize_cap(-3.0), 0);
		assert_eq!(normalize_cap(2.9), 2);
	}
}
