//! Retained transcript (ADR 0034) and the observer-local transcript facts
//! that never enter the session DOM.
//!
//! [`Projection`] pairs the elastic-slots history ledger with one live
//! retained tree per block. Every block ticks on the one presentation clock,
//! so glyph cycles across cards stay phase-locked and a streaming reveal
//! keeps its cursor across deltas: a block whose projection only extended
//! its streamed text is updated in place through [`Slots::STREAM_ID`]
//! instead of being rebuilt.
//!
//! [`Local`] holds observer-local facts: when each tool call was
//! first seen executing (the elapsed badge), the streaming speed gauge and
//! reasoning-token counter behind the hidden-thinking pulse, the transcript
//! row a session reset leaves behind, and validated startup advisories.

use std::{collections::BTreeMap, time::Duration};

use omp_agent::KernelEvent;
use omp_core::Str;
use omp_dom::{Dom, KnownTag, PropId, Tag, Value};
use omp_tui::{
	Frame, Size, Ui, UiContext,
	anim::FRAME,
	components::{Col, Spacer, SpeedGauge},
	slots::{BlockId, Mode, ResizePolicy, STREAM_ID, Slots},
};

use crate::{
	notices::update::UpdateAvailable,
	project::{BlockKind, BlockView, RenderedBlock},
	status_line::StatusLine,
};

/// Reveal catch-up horizon: a backlog drains over `CATCHUP_FRAMES` (8)
/// frames, so the exponential regime's e-folding time is eight frames.
pub const REVEAL_HORIZON: Duration = Duration::from_millis(FRAME.as_millis() as u64 * 8);

omp_con::var! {
	/// Reveal assistant text and streamed tool input smoothly while chunks
	/// arrive.
	pub static CL_SMOOTH_STREAMING = cl_smooth_streaming: bool {
		default: true,
		flags: archive | session,
		meta: {
			"ui.tab": "appearance",
			"ui.group": "Display",
			"ui.label": "Smooth Streaming",
			"legacy.path": "display.smoothStreaming",
		},
	};
	/// Omit code blocks from thinking summaries and replace them with an
	/// ellipsis.
	pub static CL_THINKING_PROSE_ONLY = cl_thinking_prose_only: bool {
		default: true,
		flags: archive | session,
		meta: {
			"ui.tab": "model",
			"ui.group": "Thinking",
			"ui.label": "Prose Only Thinking",
			"legacy.path": "proseOnlyThinking",
		},
	};
}

/// Observer-local transcript facts.
#[derive(Clone, Debug, Default)]
pub struct Local {
	/// Presentation-clock instant each executing tool block was first seen,
	/// by block key.
	started:         BTreeMap<u64, Duration>,
	/// Streaming speed gauge behind the thinking pulse's badge.
	gauge:           SpeedGauge,
	/// Cumulative provider tokens of the in-flight message.
	thinking_tokens: u64,
	/// Last cumulative token count and when it was observed.
	last_tokens:     Option<(u64, Duration)>,
	/// Which assistant content stream received the newest delta of the
	/// in-flight message.
	head:            Option<StreamHead>,
	/// Observer-local transcript row left behind by a session reset.
	banner:          Option<Banner>,
	/// Observer-local validated startup update availability.
	update:          Option<UpdateBanner>,
	/// Distinguishes successive observer rows so a new one mounts fresh.
	banner_serial:   u64,
}

/// The assistant content stream that received the newest delta: the DOM keeps
/// reasoning and answer
/// text as two properties, so which one the model is writing right now is
/// an observer-local fact read off the delta events.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum StreamHead {
	/// The newest delta was reasoning.
	Thinking,
	/// The newest delta was answer text.
	Text,
}

/// A transcript row that exists only in this observer after a session flow.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Banner {
	/// Stable block key.
	pub key:  u64,
	/// Row text without the leading success icon.
	pub text: Str,
}

/// Observer-local update card identity and typed payload.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct UpdateBanner {
	/// Stable observer-local block key.
	pub(crate) key:    u64,
	/// Validated presentation payload.
	pub(crate) notice: UpdateAvailable,
}

/// What a `Reset` snapshot meant for the transcript.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ResetKind {
	/// A different session with an empty body: `/new`, `/drop`.
	NewSession,
	/// The same session emptied in place: a context reset that dropped this
	/// many user messages.
	ContextReset {
		/// User messages dropped.
		dropped: usize,
	},
	/// A rewind or a resume into existing history: nothing to announce.
	Rewind,
}

impl Local {
	/// Block keys reserved for observer-local rows (above any DOM handle key).
	const BANNER_KEY_BASE: u64 = u64::MAX / 2;

	/// Instant a tool block was first seen executing, if it is running.
	#[must_use]
	pub fn started(&self, key: u64) -> Option<Duration> {
		self.started.get(&key).copied()
	}

	/// Snapshot of the speed gauge for the pulse badge.
	#[must_use]
	pub fn gauge(&self) -> &SpeedGauge {
		&self.gauge
	}

	/// Cumulative provider tokens of the in-flight message.
	#[must_use]
	pub const fn thinking_tokens(&self) -> u64 {
		self.thinking_tokens
	}

	/// The assistant stream the newest delta landed on, once one has been
	/// observed this message.
	#[must_use]
	pub const fn stream_head(&self) -> Option<StreamHead> {
		self.head
	}

	/// The observer-local banner row, if one is pending.
	#[must_use]
	pub const fn banner(&self) -> Option<&Banner> {
		self.banner.as_ref()
	}

	/// Observer-local validated update card, if one is pending.
	#[must_use]
	pub(crate) const fn update(&self) -> Option<&UpdateBanner> {
		self.update.as_ref()
	}

	/// Records a validated update notice. Repeated cache and network results
	/// for the same channel/version are coalesced in the observer.
	#[must_use]
	pub fn update_available(&mut self, update: UpdateAvailable) -> bool {
		if self
			.update
			.as_ref()
			.is_some_and(|banner| banner.notice.eq(&update))
		{
			return false;
		}
		self.banner_serial = self.banner_serial.wrapping_add(1);
		self.update =
			Some(UpdateBanner { key: Self::BANNER_KEY_BASE + self.banner_serial, notice: update });
		true
	}

	/// Records first-seen instants for executing tool elements in the newest
	/// turn and forgets settled ones. Call after every replica change.
	pub fn observe(&mut self, dom: &Dom, now: Duration) {
		let Some(turn) = dom.children(dom.body()).last() else {
			return;
		};
		for handle in dom.children(*turn) {
			let Some(node) = dom.get(*handle) else {
				continue;
			};
			if !matches!(node.tag, Tag::Custom(_)) {
				continue;
			}
			let kind = if crate::notices::local::is_local(node) {
				BlockKind::Local
			} else {
				BlockKind::Tool
			};
			let key = crate::project::block_key(*handle, kind);
			match node
				.prop(&PropId::Status.into())
				.and_then(Value::as_str)
				.unwrap_or("running")
			{
				"arguments" => {},
				"ok" | "error" | "cancelled" | "aborted" => {
					self.started.remove(&key);
				},
				_ => {
					self.started.entry(key).or_insert(now);
				},
			}
		}
	}

	/// Feeds one kernel event. Returns whether the transcript projection
	/// should re-run (the pulse badge reads a new gauge snapshot).
	pub fn on_kernel_event(&mut self, event: &KernelEvent, now: Duration) -> bool {
		match event {
			KernelEvent::InferenceStarted => {
				self.last_tokens = None;
				self.thinking_tokens = 0;
				self.gauge.reset();
				self.head = None;
				false
			},
			// The pulse follows the active tail
			// block, so the projection re-runs only when the head moves.
			KernelEvent::ThinkingDelta(_) => {
				self.head.replace(StreamHead::Thinking) != Some(StreamHead::Thinking)
			},
			KernelEvent::TextDelta(_) => self.head.replace(StreamHead::Text) != Some(StreamHead::Text),
			KernelEvent::Usage { output_tokens, reasoning_tokens } => {
				// `usage.reasoningTokens ?? usage.output`, fed as deltas so
				// a fresh turn restarting at zero never spikes the gauge.
				let tokens = if *reasoning_tokens > 0 {
					*reasoning_tokens
				} else {
					*output_tokens
				};
				if let Some((previous, at)) = self.last_tokens
					&& tokens > previous
					&& now > at
				{
					let delta = (tokens - previous) as f32;
					self.gauge.observe(delta / (now - at).as_secs_f32(), now);
				}
				self.last_tokens = Some((tokens, now));
				self.thinking_tokens = tokens;
				true
			},
			_ => false,
		}
	}

	/// Classifies a `Reset` snapshot against the replica it replaces and
	/// records the transcript row it leaves behind.
	pub fn on_reset(&mut self, previous: &Dom, next: &Dom) -> ResetKind {
		let kind = classify_reset(previous, next);
		let text = match kind {
			ResetKind::NewSession => Str::new_static("New session started"),
			ResetKind::ContextReset { dropped } => Str::new(format!(
				"Context reset — {dropped} {} dropped; session continues.",
				if dropped == 1 { "message" } else { "messages" }
			)),
			ResetKind::Rewind => {
				self.banner = None;
				return kind;
			},
		};
		self.banner_serial = self.banner_serial.wrapping_add(1);
		self.banner = Some(Banner { key: Self::BANNER_KEY_BASE + self.banner_serial, text });
		self.started.clear();
		kind
	}
}

/// An emptied body is a new session unless the snapshot still carries the
/// same session title: the DOM holds no journal identity, and the cwd fact
/// is shared by every session of a project, so the `<meta>` title is the
/// one durable fact that survives an in-place context reset and never a
/// `/new`.
fn classify_reset(previous: &Dom, next: &Dom) -> ResetKind {
	let turns = |dom: &Dom| dom.children(dom.body()).len();
	if turns(next) > 0 {
		return ResetKind::Rewind;
	}
	let title = |dom: &Dom| StatusLine::from_dom(dom).name;
	let same_session = matches!((title(previous), title(next)), (Some(a), Some(b)) if a == b);
	if !same_session || turns(previous) == 0 {
		return ResetKind::NewSession;
	}
	let dropped = previous
		.children(previous.body())
		.iter()
		.flat_map(|turn| previous.children(*turn))
		.filter_map(|handle| previous.get(*handle))
		.filter(|node| node.tag == Tag::Known(KnownTag::User))
		.count();
	ResetKind::ContextReset { dropped }
}

/// Retained transcript: the history ledger plus one live tree per block.
pub(crate) struct Projection {
	pub(crate) slots:  Slots,
	pub(crate) blocks: Vec<Mounted>,
	ctx:               UiContext,
	width:             u16,
}

pub(crate) struct Mounted {
	pub(crate) view:    BlockView,
	pub(crate) id:      BlockId,
	ui:                 Ui,
	pub(crate) retired: bool,
	/// Streamed text bound to the component's [`Slots::STREAM_ID`] child.
	stream:             Option<Str>,
}

impl Mounted {
	/// Rows the block still paints in the live document: an append-only head
	/// hides the stable prefix already streamed into native scrollback.
	fn live_rows(&self, slots: &Slots) -> u16 {
		let rows = self.ui.frame().size().height;
		let emitted = u16::try_from(slots.emitted(self.id)).unwrap_or(u16::MAX);
		rows.saturating_sub(emitted)
	}

	fn shape_matches(&self, next: &BlockView) -> bool {
		self.view.kind == next.kind
			&& self.view.mode == next.mode
			&& self.view.finalized == next.finalized
	}
}

/// Wraps a block for retention: the block plus one blank separator row,
/// so history rows carry the same spacing as the live document.
fn spaced(component: crate::cards::Component) -> Col {
	Col::new().child(component).child(Spacer::new())
}

impl Projection {
	pub(crate) fn new(
		size: Size,
		policy: ResizePolicy,
		ctx: &UiContext,
		blocks: Vec<RenderedBlock>,
		mirror: Vec<RenderedBlock>,
		now: Duration,
	) -> Self {
		let mut slots = Slots::new(size.width, size.height, policy);
		slots.set_context(ctx.clone());
		let mut projection = Self {
			slots,
			blocks: Vec::with_capacity(blocks.len()),
			ctx: ctx.clone(),
			width: size.width,
		};
		for (block, twin) in blocks.into_iter().zip(mirror) {
			let mounted = projection.open(block, twin, now);
			projection.blocks.push(mounted);
		}
		projection
	}

	fn open(&mut self, block: RenderedBlock, twin: RenderedBlock, now: Duration) -> Mounted {
		let id = match (block.view.mode, &block.stream) {
			(Mode::AppendOnly, Some(text)) => {
				let id = self
					.slots
					.open_with(Mode::AppendOnly, spaced(block.component));
				self.slots.append(id, text.as_str());
				id
			},
			_ => {
				let id = self.slots.open(Mode::Mutable);
				self.slots.set(id, spaced(block.component));
				id
			},
		};
		let mut ui = Ui::from_root(spaced(twin.component), self.width, self.ctx.clone());
		ui.tick(now);
		Mounted { view: block.view, id, ui, retired: false, stream: block.stream }
	}

	/// Atomically restyles every retained live surface with a new ambient
	/// context. Slot roots and their mirror trees keep their identities,
	/// committed prefixes, and reveal state while [`Ui::set_context`] advances
	/// cache revisions and invalidates context-derived geometry and paint.
	pub(crate) fn set_context(&mut self, ctx: &UiContext) -> bool {
		if self.ctx == *ctx {
			return false;
		}
		self.ctx = ctx.clone();
		self.slots.set_context(ctx.clone());
		for mounted in &mut self.blocks {
			mounted.ui.set_context(ctx.clone());
		}
		true
	}

	/// Applies a fresh projection. A block whose streamed text merely grew is
	/// extended in place so its reveal cursor and animation phase survive;
	/// a live block that vanished (a displaced card) is discarded from the
	/// ledger without touching history; blocks may materialize anywhere; a
	/// live block that moved behind a newer one reopens the live set in the
	/// new order (`false`). The slot ledger is never replaced: rows already
	/// retired into native scrollback stay retired (ADR 0034 exactly-once),
	/// so a new tail block — a journaled notice, a toggled projection — is
	/// admitted beside them, never re-emitted with them.
	pub(crate) fn reconcile(
		&mut self,
		blocks: Vec<RenderedBlock>,
		mirror: Vec<RenderedBlock>,
		now: Duration,
	) -> bool {
		let keys = blocks
			.iter()
			.map(|block| block.view.key)
			.collect::<Vec<_>>();
		let present = |key: u64| keys.contains(&key);
		let mut survivors = Vec::with_capacity(self.blocks.len());
		for mounted in std::mem::take(&mut self.blocks) {
			if present(mounted.view.key) || mounted.retired {
				survivors.push(mounted);
			} else {
				self.slots.discard(mounted.id);
			}
		}
		let mut next_keys = keys.iter().copied();
		let ordered = survivors
			.iter()
			.filter(|mounted| present(mounted.view.key))
			.all(|mounted| next_keys.any(|key| key == mounted.view.key));
		if !ordered {
			// Retired rows stay in scrollback; every live block reopens in
			// the new order, and a block already retired is refreshed in
			// place rather than mounted a second time.
			let mut kept = Vec::with_capacity(survivors.len() + blocks.len());
			for mounted in survivors {
				if mounted.retired {
					kept.push(mounted);
				} else {
					self.slots.discard(mounted.id);
				}
			}
			for (block, twin) in blocks.into_iter().zip(mirror) {
				if let Some(retired) = kept
					.iter_mut()
					.find(|mounted| mounted.view.key == block.view.key)
				{
					retired.view = block.view;
					continue;
				}
				let mounted = self.open(block, twin, now);
				kept.push(mounted);
			}
			self.blocks = kept;
			return false;
		}
		let mut old = survivors.into_iter().peekable();
		let mut merged = Vec::with_capacity(blocks.len());
		for (next, twin) in blocks.into_iter().zip(mirror) {
			while let Some(stale) =
				old.next_if(|mounted| mounted.retired && !present(mounted.view.key))
			{
				merged.push(stale);
			}
			let Some(mut mounted) = old.next_if(|mounted| mounted.view.key == next.view.key) else {
				merged.push(self.open(next, twin, now));
				continue;
			};
			self.update(&mut mounted, next, twin, now);
			merged.push(mounted);
		}
		merged.extend(old);
		self.blocks = merged;
		true
	}

	fn update(
		&mut self,
		mounted: &mut Mounted,
		next: RenderedBlock,
		twin: RenderedBlock,
		now: Duration,
	) {
		// Rows already in native scrollback are never rewritten (ADR 0034).
		if mounted.retired {
			mounted.view = next.view;
			return;
		}
		let extension = match (&mounted.stream, &next.stream) {
			(Some(previous), Some(text)) if mounted.shape_matches(&next.view) => {
				text.as_str().strip_prefix(previous.as_str()).map(str::len)
			},
			_ => None,
		};
		if let Some(grown) = extension {
			if grown > 0 {
				let text = next.stream.clone().expect("extension implies a stream");
				mounted.ui.set_text(STREAM_ID, text.clone());
				mounted.ui.tick(now);
				if mounted.view.mode == Mode::AppendOnly {
					let delta = &text.as_str()[text.len() - grown..];
					self.slots.append(mounted.id, delta);
				}
				mounted.stream = Some(text);
			}
			mounted.view = next.view;
			return;
		}
		if mounted.view == next.view && mounted.stream == next.stream {
			return;
		}
		match mounted.view.mode {
			Mode::Mutable => {
				self.slots.set(mounted.id, spaced(next.component));
			},
			Mode::AppendOnly => {
				// The head sealed or changed shape: flush the last delta into the
				// ledger; finalization settles its reveal when it retires.
				if let (Some(previous), Some(text)) = (&mounted.stream, &next.stream)
					&& let Some(delta) = text.as_str().strip_prefix(previous.as_str())
					&& !delta.is_empty()
				{
					self.slots.append(mounted.id, delta);
				}
			},
		}
		mounted.ui = Ui::from_root(spaced(twin.component), self.width, self.ctx.clone());
		mounted.ui.tick(now);
		mounted.stream = next.stream;
		mounted.view = next.view;
	}

	/// Replaces every live block (a session reset): discarded blocks leave
	/// no history rows; retired rows stay where they are in scrollback.
	pub(crate) fn reset_in_place(
		&mut self,
		blocks: Vec<RenderedBlock>,
		mirror: Vec<RenderedBlock>,
		now: Duration,
	) {
		let mut kept = Vec::with_capacity(self.blocks.len() + blocks.len());
		for mounted in std::mem::take(&mut self.blocks) {
			if mounted.retired {
				kept.push(mounted);
			} else {
				self.slots.discard(mounted.id);
			}
		}
		for (block, twin) in blocks.into_iter().zip(mirror) {
			let mounted = self.open(block, twin, now);
			kept.push(mounted);
		}
		self.blocks = kept;
	}

	pub(crate) fn resize(&mut self, size: Size) {
		self.width = size.width;
		self.slots.resize(size.width, size.height);
		for mounted in &mut self.blocks {
			mounted.ui.resize(size.width);
		}
	}

	pub(crate) fn live(&self) -> impl Iterator<Item = &Mounted> {
		self.blocks.iter().filter(|mounted| !mounted.retired)
	}

	fn live_rows(&self) -> u32 {
		self
			.live()
			.map(|mounted| u32::from(mounted.live_rows(&self.slots)))
			.sum()
	}

	/// Retires the oldest finished blocks into native scrollback until the
	/// live document fits the terminal (the row-pressure rule of ADR 0034).
	pub(crate) fn retire_under_pressure(&mut self, chrome_rows: u16, height: u16) {
		let budget = u32::from(height);
		let mut live_rows = self.live_rows().saturating_add(u32::from(chrome_rows));
		for index in 0..self.blocks.len() {
			if live_rows <= budget {
				break;
			}
			if self.blocks[index].retired {
				continue;
			}
			if !self.blocks[index].view.finalized {
				break;
			}
			let rows = self.blocks[index].live_rows(&self.slots);
			self.slots.finalize(self.blocks[index].id);
			self.blocks[index].retired = true;
			live_rows = live_rows.saturating_sub(u32::from(rows));
		}
	}

	/// First row of the composer inside the document [`Self::document`]
	/// composes: the end of the live content while it fits, else the tail
	/// anchor. Rows above it hold the status/notice row.
	pub(crate) fn composer_top(&self, chrome_rows: u16, size: Size) -> u16 {
		let chrome_rows = chrome_rows.min(size.height);
		let available = u32::from(size.height.saturating_sub(chrome_rows));
		u16::try_from(self.live_rows().min(available)).unwrap_or(u16::MAX)
	}

	/// Composes the on-screen document: live blocks then the composer,
	/// top-anchored while everything fits and tail-anchored otherwise.
	pub(crate) fn document(&self, composer: &Frame, size: Size) -> Frame {
		let mut document = Frame::new(size);
		let chrome_rows = composer.size().height.min(size.height);
		let content_rows = self.live_rows();
		let available = u32::from(size.height.saturating_sub(chrome_rows));
		if content_rows <= available {
			let mut y = 0_u16;
			for mounted in self.live() {
				let frame = mounted.ui.frame();
				let rows = mounted.live_rows(&self.slots);
				let skip = frame.size().height - rows;
				document.blit(frame, skip, rows, 0, y);
				y = y.saturating_add(rows);
			}
			document.blit(composer, 0, chrome_rows, 0, y);
			return document;
		}
		let mut bottom = u16::try_from(available).unwrap_or(u16::MAX);
		let live = self.live().collect::<Vec<_>>();
		for mounted in live.into_iter().rev() {
			if bottom == 0 {
				break;
			}
			let frame = mounted.ui.frame();
			let rows = mounted.live_rows(&self.slots);
			let skip = frame.size().height - rows;
			if rows <= bottom {
				bottom -= rows;
				document.blit(frame, skip, rows, 0, bottom);
			} else {
				document.blit(frame, skip + rows - bottom, bottom, 0, 0);
				bottom = 0;
			}
		}
		let chrome_top = u16::try_from(available).unwrap_or(u16::MAX);
		document.blit(composer, composer.size().height - chrome_rows, chrome_rows, 0, chrome_top);
		document
	}

	/// Earliest animation wake across live blocks, on the presentation clock.
	pub(crate) fn next_wake(&self) -> Option<Duration> {
		self
			.live()
			.filter_map(|mounted| mounted.ui.next_wake())
			.min()
	}

	/// Advances every live tree and the ledger's streaming heads to `now`.
	pub(crate) fn tick(&mut self, now: Duration) -> bool {
		let mut changed = false;
		for mounted in self.blocks.iter_mut().filter(|mounted| !mounted.retired) {
			changed |= mounted.ui.tick(now);
		}
		changed |= self.slots.tick(now);
		changed
	}
}

#[cfg(test)]
mod tests {
	use omp_dom::PropId;
	use omp_tui::{
		Color, IntoComponent as _, Prop, Style, UiContext, components::TextLeaf, slots::Delivered,
	};

	use super::*;
	use crate::{cards::CardRegistry, project::project};

	fn block(key: u64, kind: BlockKind, text: &'static str, finalized: bool) -> RenderedBlock {
		RenderedBlock {
			view:      BlockView {
				key,
				kind,
				text: Str::new_static(text),
				mode: Mode::Mutable,
				finalized,
			},
			component: text.into_component(),
			stream:    None,
		}
	}

	fn fixture(rows: u16, finalized: &[bool]) -> Projection {
		let build = || {
			finalized
				.iter()
				.enumerate()
				.map(|(index, done)| block(index as u64 + 1, BlockKind::User, "row", *done))
				.collect::<Vec<_>>()
		};
		Projection::new(
			Size::new(20, rows),
			ResizePolicy::Rebuild,
			&UiContext::default(),
			build(),
			build(),
			Duration::ZERO,
		)
	}

	#[test]
	fn blocks_stay_live_until_row_pressure_then_retire_oldest_done_first() {
		// Three two-row blocks (text + spacer) plus a three-row chrome fit in ten rows.
		let mut projection = fixture(10, &[true, true, false]);
		projection.retire_under_pressure(3, 10);
		assert_eq!(projection.live().count(), 3);
		assert!(projection.slots.plan().rows().is_empty(), "nothing retires without pressure");

		// Shrinking to seven rows retires exactly the oldest finished block.
		projection.retire_under_pressure(3, 7);
		assert!(projection.blocks[0].retired);
		assert!(!projection.blocks[1].retired);
		assert_eq!(projection.slots.plan().rows().len(), 2);

		// An unfinished frontier block stalls later retirement (ADR 0034).
		projection.retire_under_pressure(3, 1);
		assert!(projection.blocks[1].retired);
		assert!(!projection.blocks[2].retired);
	}

	#[test]
	fn retired_welcome_survives_height_and_width_resize_exactly_once() {
		let build = || {
			vec![
				block(1, BlockKind::Welcome, "Welcome back!", true),
				block(2, BlockKind::Assistant, "working", false),
			]
		};
		let mut projection = Projection::new(
			Size::new(20, 4),
			ResizePolicy::Rebuild,
			&UiContext::default(),
			build(),
			build(),
			Duration::ZERO,
		);
		projection.retire_under_pressure(3, 4);
		let plan = projection.slots.plan();
		projection.slots.commit(plan, Delivered::All);
		let welcome_rows = |projection: &Projection| {
			projection
				.slots
				.logical_history()
				.filter(|row| row.text().contains("Welcome back!"))
				.count()
		};
		assert_eq!(welcome_rows(&projection), 1);

		projection.resize(Size::new(20, 12));
		let height = projection.slots.plan();
		assert!(!height.rebuild(), "height-only resize preserves native history");
		projection.slots.commit(height, Delivered::All);
		assert_eq!(welcome_rows(&projection), 1);

		projection.resize(Size::new(32, 12));
		let width = projection.slots.plan();
		assert!(width.rebuild(), "configured rebuild starts a new physical width epoch");
		projection.slots.commit(width, Delivered::All);
		assert_eq!(
			welcome_rows(&projection),
			1,
			"physical replay does not duplicate logical welcome history"
		);
	}

	#[test]
	fn document_is_top_anchored_when_it_fits_and_tail_anchored_otherwise() {
		let projection = fixture(6, &[true, true]);
		let mut chrome = Frame::new(Size::new(20, 1));
		chrome.put(0, 0, "chrome", omp_tui::Style::default());
		chrome.set_cursor(6, 0);
		let fitting = projection.document(&chrome, Size::new(20, 6));
		let rows = omp_tui::frame_text(&fitting)
			.lines()
			.map(str::to_owned)
			.collect::<Vec<_>>();
		assert_eq!(rows[0].trim_end(), "row");
		assert_eq!(rows[4].trim_end(), "chrome");
		assert_eq!(fitting.cursor(), Some((6, 4)));

		let tail = projection.document(&chrome, Size::new(20, 3));
		let rows = omp_tui::frame_text(&tail)
			.lines()
			.map(str::to_owned)
			.collect::<Vec<_>>();
		assert_eq!(rows[0].trim_end(), "row", "the newest block's rows fill from the bottom");
		assert_eq!(rows[2].trim_end(), "chrome");
		assert_eq!(tail.cursor(), Some((6, 2)));
	}

	#[test]
	fn streaming_under_pressure_never_rebuilds_history() {
		let lines = |count: usize| -> String {
			(1..=count)
				.map(|index| index.to_string())
				.collect::<Vec<_>>()
				.join("\n")
		};
		let mut projection = fixture(12, &[true]);
		let mut retired_rows = 0;
		let mut step = |projection: &mut Projection, blocks: Vec<(u64, String, bool)>| {
			let build = || {
				let mut out = vec![block(1, BlockKind::User, "row", true)];
				out.extend(blocks.iter().map(|(key, text, done)| RenderedBlock {
					view:      BlockView {
						key:       *key,
						kind:      BlockKind::Assistant,
						text:      Str::new(text.as_str()),
						mode:      Mode::Mutable,
						finalized: *done,
					},
					component: Str::new(text.as_str()).into_component(),
					stream:    None,
				}));
				out
			};
			assert!(projection.reconcile(build(), build(), Duration::ZERO));
			projection.retire_under_pressure(3, 12);
			let plan = projection.slots.plan();
			assert!(!plan.rebuild(), "streaming must never reset native history");
			retired_rows += plan.rows().len();
			projection.slots.commit(plan, Delivered::All);
		};
		for count in 1..=20 {
			step(&mut projection, vec![(2, lines(count), false)]);
		}
		step(&mut projection, vec![(2, lines(20), true)]);
		step(&mut projection, vec![(2, lines(20), true), (3, lines(5), true)]);
		assert_eq!(retired_rows, projection.slots.logical_history().count());
		assert_eq!(retired_rows, 2 + 21, "the first block and the finished stream retired once each");
	}

	#[test]
	fn live_turn_reconciles_without_rebuilding() {
		use omp_session::{ComponentRegistry, Session};
		let directory = tempfile::tempdir().expect("temp directory");
		let path = directory.path().join("turn.oms");
		let mut session = Session::create(path, ComponentRegistry::standard()).expect("session");
		let cards = CardRegistry::standard();
		let ui = UiContext::default();
		let local = Local::default();
		let blocks = |session: &Session| {
			let mut out = vec![block(0, BlockKind::Welcome, "welcome", true)];
			out.extend(project(session.dom(), &cards, &ui, &crate::project::Options::new(&local)));
			out
		};
		let mut projection = Projection::new(
			Size::new(60, 12),
			ResizePolicy::Rebuild,
			&ui,
			blocks(&session),
			blocks(&session),
			Duration::ZERO,
		);
		let check = |session: &Session, projection: &mut Projection, step: &str| {
			assert!(
				projection.reconcile(blocks(session), blocks(session), Duration::ZERO),
				"reconcile rebuilt at {step}"
			);
		};
		session.begin_turn().expect("turn");
		check(&session, &mut projection, "turn");
		session.user("hello", Vec::new()).expect("user");
		check(&session, &mut projection, "user");
		session
			.assistant_start("test/model", "test", "test/model")
			.expect("assistant");
		check(&session, &mut projection, "assistant start");
		let turn = *session
			.dom()
			.children(session.dom().body())
			.last()
			.expect("turn");
		let assistant = *session.dom().children(turn).last().expect("assistant");
		let thinking = session
			.stream_open(assistant, PropId::Thinking.into())
			.expect("thinking");
		check(&session, &mut projection, "thinking open");
		for delta in ["think", "ing\nmore"] {
			session.stream_append(thinking, delta).expect("delta");
			check(&session, &mut projection, "thinking delta");
		}
		session.stream_close(thinking).expect("close");
		check(&session, &mut projection, "thinking close");
		let text = session
			.stream_open(assistant, PropId::Text.into())
			.expect("text");
		check(&session, &mut projection, "text open");
		for delta in ["1\n", "2\n", "3\n"] {
			session.stream_append(text, delta).expect("delta");
			check(&session, &mut projection, "text delta");
		}
		let live = crate::project::block_views(session.dom(), true);
		assert_eq!(live[1].kind, BlockKind::Thinking);
		assert_eq!(live[1].text, "thinking\nmore", "open thinking stream projects live");
		assert_eq!(live[2].kind, BlockKind::Assistant);
		assert_eq!(live[2].text, "1\n2\n3\n", "open text stream projects live");
		session.stream_close(text).expect("close");
		session.assistant_end("stop").expect("end");
		check(&session, &mut projection, "assistant end");
		session
			.receipt(omp_journal::data::TurnReceipt::tokens(10, 5, 0))
			.expect("receipt");
		check(&session, &mut projection, "receipt");
	}

	#[test]
	fn context_swap_restyles_retained_blocks_without_reopening_them() {
		let mut projection = fixture(20, &[true, false]);
		let identities = projection
			.blocks
			.iter()
			.map(|mounted| mounted.id)
			.collect::<Vec<_>>();
		let mut light = UiContext::default();
		assert!(light.apply_appearance(omp_tui::Appearance::Light));
		assert!(projection.set_context(&light));
		assert_eq!(
			projection
				.blocks
				.iter()
				.map(|mounted| mounted.id)
				.collect::<Vec<_>>(),
			identities,
			"restyling must preserve slot identity and history position",
		);
		assert!(
			projection
				.blocks
				.iter()
				.all(|mounted| mounted.ui.context().appearance == omp_tui::Appearance::Light),
			"every cached mirror observes the atomic context swap",
		);
		assert!(!projection.set_context(&light), "an identical context is a no-op");
	}

	#[test]
	fn committed_message_tool_and_update_rows_keep_their_styles_after_resize() {
		const CASES: [(BlockKind, &str, Color); 4] = [
			(BlockKind::User, "user-colored", Color::Rgb(0x11, 0x22, 0x33)),
			(BlockKind::Assistant, "assistant-colored", Color::Rgb(0x22, 0x44, 0x66)),
			(BlockKind::Tool, "tool-colored", Color::Rgb(0x33, 0x66, 0x99)),
			(BlockKind::Notice, "update-colored", Color::Rgb(0x44, 0x88, 0xcc)),
		];
		let blocks = || {
			CASES
				.iter()
				.enumerate()
				.map(|(index, &(kind, text, color))| RenderedBlock {
					view:      BlockView {
						key: index as u64 + 1,
						kind,
						text: Str::new_static(text),
						mode: Mode::Mutable,
						finalized: true,
					},
					component: TextLeaf::new()
						.text(text)
						.with(Prop::Fg, color)
						.with(Prop::Bold, true)
						.with(Prop::Href, "https://example.test/row")
						.into_component(),
					stream:    None,
				})
				.collect::<Vec<_>>()
		};
		let mut projection = Projection::new(
			Size::new(24, 1),
			ResizePolicy::Rebuild,
			&UiContext::default(),
			blocks(),
			blocks(),
			Duration::ZERO,
		);
		projection.retire_under_pressure(1, 1);
		let initial = projection.slots.plan();
		for &(_, text, color) in &CASES {
			let row = initial
				.rows()
				.iter()
				.find(|row| row.logical().text().contains(text))
				.expect("semantic transcript row staged");
			assert_eq!(
				row.frame().cell(0, 0).style(),
				Style::new()
					.fg(color)
					.bold()
					.link("https://example.test/row"),
			);
		}
		projection.slots.commit(initial, Delivered::All);

		projection.resize(Size::new(40, 1));
		let replay = projection.slots.plan();
		assert!(replay.rebuild());
		for &(_, text, color) in &CASES {
			let row = replay
				.rows()
				.iter()
				.find(|row| row.logical().text().contains(text))
				.expect("styled transcript row survives scrollback rebuild");
			assert_eq!(
				row.frame().cell(0, 0).style(),
				Style::new()
					.fg(color)
					.bold()
					.link("https://example.test/row"),
			);
		}
		projection.slots.commit(replay, Delivered::All);
		assert!(
			projection.slots.plan().rows().is_empty(),
			"repeated presentation never duplicates styled history",
		);
	}

	#[test]
	fn reconcile_keeps_retired_rows_and_replaces_changed_live_blocks() {
		let mut projection = fixture(4, &[true, true]);
		projection.retire_under_pressure(3, 4);
		assert!(projection.blocks[0].retired);
		let next = vec![
			block(1, BlockKind::User, "changed", true),
			block(2, BlockKind::User, "changed", true),
		];
		let mirror = vec![
			block(1, BlockKind::User, "changed", true),
			block(2, BlockKind::User, "changed", true),
		];
		assert!(projection.reconcile(next, mirror, Duration::ZERO));
		assert_eq!(projection.blocks[0].view.text, "changed");
		let mut live = fixture(20, &[true, true, true]);
		let swapped = || {
			vec![
				block(1, BlockKind::User, "row", true),
				block(3, BlockKind::User, "row", true),
				block(2, BlockKind::User, "row", true),
			]
		};
		assert!(
			!live.reconcile(swapped(), swapped(), Duration::ZERO),
			"a live block moving behind a newer one reopens the live set"
		);
		assert_eq!(
			live
				.blocks
				.iter()
				.map(|mounted| mounted.view.key)
				.collect::<Vec<_>>(),
			[1, 3, 2]
		);
		assert_eq!(live.slots.logical_history().count(), 0, "a reorder writes no history");
	}

	/// ADR 0034 exactly-once: admitting a new tail block (a journaled hook
	/// notice, a toggled projection) after rows have retired into native
	/// scrollback must never stage those rows again — the ledger is
	/// reconciled, not rebuilt.
	#[test]
	fn admitting_a_new_tail_never_re_emits_retired_rows() {
		// Two two-row blocks and a three-row chrome in six rows: exactly the
		// oldest block retires.
		let mut projection = fixture(6, &[true, true]);
		projection.retire_under_pressure(3, 6);
		assert!(projection.blocks[0].retired && !projection.blocks[1].retired);
		let first = projection.blocks[0].id;
		let plan = projection.slots.plan();
		assert_eq!(plan.rows().len(), 2, "the first block's text row and spacer");
		projection.slots.commit(plan, Delivered::All);
		assert_eq!(projection.slots.logical_history().count(), 2);

		let next = || {
			vec![
				block(1, BlockKind::User, "row", true),
				block(2, BlockKind::User, "row", true),
				block(9, BlockKind::Notice, "[pre-commit]\nlint ok", true),
			]
		};
		assert!(projection.reconcile(next(), next(), Duration::ZERO));
		assert_eq!(
			projection
				.blocks
				.iter()
				.map(|mounted| mounted.view.key)
				.collect::<Vec<_>>(),
			[1, 2, 9]
		);
		assert!(projection.blocks[0].retired, "the retired block stays retired");
		// The new tail pushes the second block out under the same pressure;
		// the staged rows are exactly that block's, never the first's again.
		projection.retire_under_pressure(3, 6);
		let plan = projection.slots.plan();
		assert!(!plan.rows().is_empty());
		assert!(
			plan.rows().iter().all(|row| row.logical().block() != first),
			"retired rows must not be staged twice"
		);
		projection.slots.commit(plan, Delivered::All);
		assert_eq!(projection.slots.logical_history().count(), 4);
		assert_eq!(
			projection
				.slots
				.logical_history()
				.filter(|row| row.block() == first)
				.count(),
			2
		);
		// A reorder of live blocks is admitted the same way.
		let reordered = || {
			vec![
				block(1, BlockKind::User, "row", true),
				block(2, BlockKind::User, "row", true),
				block(11, BlockKind::Thinking, "late", false),
				block(9, BlockKind::Notice, "[pre-commit]\nlint ok", true),
			]
		};
		projection.reconcile(reordered(), reordered(), Duration::ZERO);
		let swapped = || {
			vec![
				block(1, BlockKind::User, "row", true),
				block(2, BlockKind::User, "row", true),
				block(9, BlockKind::Notice, "[pre-commit]\nlint ok", true),
				block(11, BlockKind::Thinking, "late", false),
			]
		};
		assert!(!projection.reconcile(swapped(), swapped(), Duration::ZERO));
		assert_eq!(projection.slots.logical_history().count(), 4, "reopening writes no history");
		assert_eq!(
			projection
				.blocks
				.iter()
				.filter(|mounted| mounted.retired)
				.count(),
			2,
			"both retired blocks survive the reorder exactly once"
		);
	}

	#[test]
	fn reconcile_inserts_a_block_that_materializes_before_an_existing_one() {
		let mut projection = fixture(20, &[true, false]);
		let build = || {
			vec![
				block(1, BlockKind::User, "row", true),
				block(5, BlockKind::Thinking, "late thinking", false),
				block(2, BlockKind::Assistant, "row", false),
			]
		};
		assert!(projection.reconcile(build(), build(), Duration::ZERO));
		assert_eq!(
			projection
				.blocks
				.iter()
				.map(|mounted| mounted.view.key)
				.collect::<Vec<_>>(),
			[1, 5, 2]
		);
		assert_eq!(projection.slots.logical_history().count(), 0);
	}

	#[test]
	fn a_vanished_live_block_is_displaced_without_rebuilding_or_writing_history() {
		let mut projection = fixture(20, &[true, false, false]);
		let dropped =
			|| vec![block(1, BlockKind::User, "row", true), block(3, BlockKind::Tool, "row", false)];
		assert!(
			projection.reconcile(dropped(), dropped(), Duration::ZERO),
			"displacement reconciles"
		);
		assert_eq!(
			projection
				.blocks
				.iter()
				.map(|mounted| mounted.view.key)
				.collect::<Vec<_>>(),
			[1, 3]
		);
		// The discarded slot no longer stalls the frontier: block 1 retires and
		// commits.
		projection.retire_under_pressure(19, 20);
		let plan = projection.slots.plan();
		assert_eq!(plan.rows().len(), 2, "only the retired block's rows are staged");
		projection.slots.commit(plan, Delivered::All);
		assert_eq!(projection.slots.logical_history().count(), 2);
	}

	fn streamed(key: u64, text: &str, mode: Mode, finalized: bool) -> RenderedBlock {
		let component = if finalized {
			omp_tui::dom! { <text id={STREAM_ID}>{Str::new(text)}</text> }
		} else {
			omp_tui::dom! { <text id={STREAM_ID} reveal="264ms">{Str::new(text)}</text> }
		};
		RenderedBlock {
			view:      BlockView {
				key,
				kind: BlockKind::Assistant,
				text: Str::new(text),
				mode,
				finalized,
			},
			component: component.into_component(),
			stream:    Some(Str::new(text)),
		}
	}

	fn row_text(projection: &Projection, key: u64) -> String {
		let mounted = projection
			.blocks
			.iter()
			.find(|mounted| mounted.view.key == key)
			.expect("mounted");
		omp_tui::frame_text(mounted.ui.frame())
			.trim_end()
			.to_owned()
	}

	#[test]
	fn stream_extension_keeps_the_reveal_cursor_across_deltas() {
		let ui = UiContext::default();
		const HEAD: &str = "abcdefghijklmnopqrstuvwxyz0123";
		const FULL: &str = "abcdefghijklmnopqrstuvwxyz0123456789";
		let mut projection = Projection::new(
			Size::new(60, 10),
			ResizePolicy::Rebuild,
			&ui,
			vec![streamed(7, HEAD, Mode::Mutable, false)],
			vec![streamed(7, HEAD, Mode::Mutable, false)],
			Duration::ZERO,
		);
		let mut now = Duration::ZERO;
		for _ in 0..2 {
			now += FRAME;
			projection.tick(now);
		}
		let shown = row_text(&projection, 7);
		assert!(
			(3..HEAD.len()).contains(&shown.len()),
			"typing out at ≥3 clusters per frame: {shown:?}"
		);
		let grown = || vec![streamed(7, FULL, Mode::Mutable, false)];
		assert!(projection.reconcile(grown(), grown(), now));
		assert_eq!(row_text(&projection, 7), shown, "an extension does not reset the cursor");
		for _ in 0..60 {
			now += FRAME;
			projection.tick(now);
		}
		assert_eq!(row_text(&projection, 7), FULL);
		let sealed = || vec![streamed(7, FULL, Mode::Mutable, true)];
		assert!(projection.reconcile(sealed(), sealed(), now));
		assert_eq!(row_text(&projection, 7), FULL);
	}

	#[test]
	fn append_only_head_streams_stable_rows_and_hides_them_from_the_live_document() {
		let ui = UiContext::default();
		let lines = |count: usize| {
			(1..=count)
				.map(|n| format!("line {n}\n"))
				.collect::<String>()
		};
		let mut projection = Projection::new(
			Size::new(20, 6),
			ResizePolicy::Rebuild,
			&ui,
			vec![streamed(3, &lines(2), Mode::AppendOnly, false)],
			vec![streamed(3, &lines(2), Mode::AppendOnly, false)],
			Duration::ZERO,
		);
		let mut now = Duration::ZERO;
		for count in 3..=12 {
			let next = || vec![streamed(3, &lines(count), Mode::AppendOnly, false)];
			assert!(projection.reconcile(next(), next(), now));
			for _ in 0..4 {
				now += FRAME;
				projection.tick(now);
			}
			let plan = projection.slots.plan();
			assert!(!plan.rebuild());
			projection.slots.commit(plan, Delivered::All);
		}
		for _ in 0..60 {
			now += FRAME;
			projection.tick(now);
			let plan = projection.slots.plan();
			projection.slots.commit(plan, Delivered::All);
		}
		let emitted = projection.slots.emitted(projection.blocks[0].id);
		assert!(emitted > 0, "a long append-only head streams its stable prefix mid-stream");
		let chrome = Frame::new(Size::new(20, 1));
		// Tall enough to hold every live row, so the document is top-anchored
		// and its first row is the first row not yet in scrollback.
		let document = projection.document(&chrome, Size::new(20, 20));
		let first = omp_tui::frame_text(&document)
			.lines()
			.next()
			.unwrap_or_default()
			.to_owned();
		assert_eq!(
			first,
			format!("line {}", emitted + 1),
			"rows already in scrollback leave the live document ({emitted} emitted)"
		);
		let sealed = || vec![streamed(3, &lines(12), Mode::AppendOnly, true)];
		assert!(projection.reconcile(sealed(), sealed(), now));
		projection.retire_under_pressure(1, 6);
		let plan = projection.slots.plan();
		assert!(!plan.rebuild(), "sealing a streamed head never resets native history");
		projection.slots.commit(plan, Delivered::All);
		let history = projection
			.slots
			.logical_history()
			.map(|row| row.text().to_owned())
			.collect::<Vec<_>>();
		assert_eq!(
			history
				.iter()
				.filter(|row| row.starts_with("line "))
				.count(),
			12,
			"{history:?}"
		);
		assert_eq!(history[0], "line 1", "rows commit once, in order");
	}

	fn reset_dom(title: Option<&str>, users: usize) -> Dom {
		use omp_dom::{Op, Txn};
		use omp_session::{ComponentRegistry, Session};
		let directory = tempfile::tempdir().expect("temp directory");
		let path = directory.path().join("session.oms");
		let mut live = Session::create(path, ComponentRegistry::standard()).expect("session");
		if let Some(title) = title {
			let meta = live.dom().meta();
			live
				.patch(Txn {
					cause: live.head().expect("genesis"),
					label: Some(Str::new_static("test.title")),
					ops:   vec![Op::Set {
						h:     meta,
						prop:  PropId::Name.into(),
						value: Value::Str(Str::new(title)),
					}],
				})
				.expect("title");
		}
		for index in 0..users {
			live.begin_turn().expect("turn");
			live
				.user(format!("prompt {index}"), Vec::new())
				.expect("user");
		}
		Dom::from_snapshot(&live.dom().snapshot())
	}

	#[test]
	fn reset_classification_announces_new_sessions_and_context_resets_only() {
		let mut local = Local::default();
		let before = reset_dom(None, 2);
		assert_eq!(local.on_reset(&before, &reset_dom(None, 0)), ResetKind::NewSession);
		assert_eq!(local.banner().map(|banner| banner.text.as_str()), Some("New session started"));
		assert_eq!(local.on_reset(&before, &reset_dom(None, 1)), ResetKind::Rewind);
		assert!(local.banner().is_none(), "rewinds and resumes announce nothing");
		let titled = reset_dom(Some("refactor"), 3);
		assert_eq!(
			local.on_reset(&titled, &reset_dom(Some("refactor"), 0)),
			ResetKind::ContextReset { dropped: 3 }
		);
		assert_eq!(
			local.banner().map(|banner| banner.text.as_str()),
			Some("Context reset — 3 messages dropped; session continues.")
		);
		assert_eq!(
			local.on_reset(&titled, &reset_dom(Some("other"), 0)),
			ResetKind::NewSession,
			"a different title is a different session"
		);
	}

	#[test]
	fn update_availability_is_observer_local_and_deduplicated() {
		let mut local = Local::default();
		let notice = UpdateAvailable::new("19.0.0", "stable").expect("valid notice");
		assert!(local.update_available(notice.clone()));
		let first_key = local.update().expect("update").key;
		let dom = Dom::new();
		let blocks = project(
			&dom,
			&CardRegistry::standard(),
			&UiContext::default(),
			&crate::project::Options::new(&local),
		);
		assert_eq!(blocks.len(), 1);
		assert_eq!(blocks[0].view.kind, BlockKind::Notice);
		assert_eq!(blocks[0].view.text, notice.text());
		assert!(dom.children(dom.body()).is_empty(), "the card never enters session state");
		assert!(!local.update_available(notice));
		assert_eq!(local.update().expect("same update").key, first_key);
		assert!(
			local.update_available(UpdateAvailable::new("19.0.1", "stable").expect("valid notice"))
		);
		assert_ne!(local.update().expect("new update").key, first_key);
		assert_eq!(
			local.update().expect("text").notice.text(),
			"Update Available\nNew version 19.0.1 is available on the stable channel. Run: omp update"
		);
	}

	#[test]
	fn usage_events_feed_the_gauge_as_deltas_and_inference_start_resets_it() {
		let mut local = Local::default();
		let usage =
			|reasoning: u64| KernelEvent::Usage { output_tokens: 0, reasoning_tokens: reasoning };
		assert!(!local.on_kernel_event(&KernelEvent::InferenceStarted, Duration::ZERO));
		assert!(local.on_kernel_event(&usage(100), Duration::from_millis(1_000)));
		assert_eq!(
			local.gauge().speed(Duration::from_millis(1_000)),
			0.0,
			"the first sample only anchors"
		);
		assert!(local.on_kernel_event(&usage(150), Duration::from_millis(2_000)));
		assert_eq!(local.gauge().speed(Duration::from_millis(2_000)), 50.0);
		assert_eq!(local.thinking_tokens(), 150);
		assert!(!local.on_kernel_event(&KernelEvent::InferenceStarted, Duration::from_millis(2_500)));
		assert_eq!(local.thinking_tokens(), 0);
		assert!(!local.gauge().is_live(Duration::from_millis(2_500)));
		assert!(local.on_kernel_event(&usage(10), Duration::from_millis(3_000)));
		assert_eq!(
			local.gauge().speed(Duration::from_millis(3_000)),
			0.0,
			"a restart at zero never spikes"
		);
	}
}
