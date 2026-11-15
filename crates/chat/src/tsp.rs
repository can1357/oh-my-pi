//! Native Tern Surface Protocol presentation for the terminal chat host.
//!
//! This is deliberately a presenter, not a second chat tree. It derives TSP
//! nodes from the existing chat projection and leaves all input ownership with
//! the ordinary terminal host.

use std::{collections::VecDeque, io, time::Duration};

use bytes::BytesMut;
use omp_core::{FastHashMap, Str};
use omp_tui::tsp::{
	DEFAULT_APC_LIMIT, DEFAULT_CREDITS,
	frame::{Encoder, Incoming},
	record::{Direction, Recorder},
	wire::{Close, Event, Frame, Hello, Kind, Mode, Node, Op, Open, Reply, TextMode, Verb},
};
use serde::Serialize;
use serde_json::{Map, Value};
use strum::{IntoStaticStr, VariantArray as _};

use crate::{
	chrome::PLACEHOLDER,
	project::{BlockKind, RenderedBlock},
	settings::TspStreamPacing,
	transcript::REVEAL_HORIZON,
};

const SURFACE_ID: &str = "omp-chat";
const COVER_ID: &str = "omp-screen";
const MAIN_ID: &str = "main";
const DOCK_ID: &str = "dock";
const LAYER_ID: &str = "layer";
const COMPOSER_ID: &str = "composer";
const STATUS_ID: &str = "status";

#[derive(Clone, Debug)]
struct BlockState {
	id:        Str,
	text_id:   Str,
	text:      Str,
	finalized: bool,
}

#[derive(Serialize)]
struct Stylesheet {
	sf:   Str,
	name: Str,
	css:  Str,
}

/// The `screen` surface that covers the pane while a full-screen overlay draws
/// natively.
///
/// Tern keeps the session surface live underneath: its document, focus and
/// frame numbering stay as they were, frames addressed to it still apply, and
/// it shows again exactly as it was once the cover closes.
struct Cover {
	opened:   bool,
	/// Next frame number. It never restarts, so a late `ack` for an earlier
	/// cover cannot be taken for one of the next.
	next_seq: u64,
	acked:    u64,
	/// Id of the mounted view root; empty when none is.
	view:     Str,
}

impl Cover {
	fn new() -> Self {
		Self { opened: false, next_seq: 1, acked: 0, view: Str::default() }
	}

	fn credit_available(&self, credits: u32) -> bool {
		(self.next_seq.saturating_sub(1)).saturating_sub(self.acked) < u64::from(credits)
	}

	/// Drops the cover, whether Tern removed it or the presenter closed it.
	/// Frames still in flight will never be acknowledged, so the credit window
	/// starts over.
	fn forget(&mut self) {
		self.opened = false;
		self.acked = self.next_seq.saturating_sub(1);
		self.view = Str::default();
	}
}

/// One terminal-epoch TSP surface presenter.
///
/// The surface sits in the pane as the [`Mode`] it was built for. The chat
/// session is inline; a screen surface is discarded when it closes; a flow
/// surface is command output that stays in the scrollback, never listens and
/// mounts none of the session chrome. While an inline session is live it can
/// cover the pane with a second, screen, surface ([`Surface::present_cover`]).
pub struct Surface {
	id:               Str,
	mode:             Mode,
	hello:            Hello,
	encoder:          Encoder,
	recorder:         Option<Recorder>,
	next_seq:         u64,
	acked:            u64,
	blocks:           FastHashMap<u64, BlockState>,
	opened:           bool,
	adopting:         bool,
	suspended:        bool,
	dirty:            bool,
	last_paced:       Option<Duration>,
	composer_mounted: bool,
	composer:         Str,
	composer_cursor:  u32,
	/// Whether the host wants the composer to accept a `send`
	/// ([`Surface::set_sendable`]).
	sendable:         bool,
	/// Whether Tern was last told the composer is `sendable`.
	sendable_sent:    bool,
	status_mounted:   bool,
	status_text:      Str,
	approval_id:      Str,
	form_id:          Str,
	cover:            Cover,
	events:           VecDeque<Event>,
}
/// HTML-like element tags supported by Tern's `el` vocabulary.
#[derive(Clone, Copy, Debug, Eq, IntoStaticStr, PartialEq)]
#[strum(serialize_all = "lowercase")]
pub enum ElementTag {
	/// Form root.
	Form,
	/// Generic block.
	Div,
	/// Form label.
	Label,
	/// Generic input.
	Input,
	/// Action button.
	Button,
	/// Inline text.
	Span,
	/// Select control.
	Select,
	/// Select option.
	Option,
}

/// Builds a typed TSP `el` node.
#[must_use]
pub fn element_node(
	id: Str,
	tag: ElementTag,
	props: Map<String, Value>,
	children: Vec<Node>,
) -> Node {
	let tag: &'static str = tag.into();
	let mut props = props;
	props.insert("tag".into(), Value::String(tag.into()));
	Node { id, k: Kind::El, p: props, c: children }
}

fn approval_node(id: &str, reason: &str) -> Node {
	let mut form = Map::new();
	form.insert("class".into(), Value::String("omp-approval".into()));
	let mut message = Map::new();
	message.insert("text".into(), Value::String(reason.into()));
	let button = |suffix: &str, label: &str, action: &str| {
		let mut props = Map::new();
		props.insert("text".into(), Value::String(label.into()));
		props.insert(
			"actions".into(),
			Value::Object(Map::from_iter([(String::from("click"), Value::String(action.into()))])),
		);
		element_node(Str::from(format!("{id}-{suffix}")), ElementTag::Button, props, Vec::new())
	};
	element_node(Str::new_static("approval"), ElementTag::Form, form, vec![
		element_node(Str::from(format!("{id}-reason")), ElementTag::Div, message, Vec::new()),
		button("approve", "Approve", "approve"),
		button("deny", "Deny", "deny"),
	])
}
impl Surface {
	/// Starts a surface for a terminal whose `hello` beat the DA1 fence.
	///
	/// `mode` is where the surface sits. Only an inline surface adopts one Tern
	/// still holds (`adopt`). A flow surface needs the terminal `flow` feature;
	/// without it [`Surface::present`] refuses with
	/// [`io::ErrorKind::Unsupported`] and the caller prints plainly instead.
	///
	/// That reply reached the host through the startup probe rather than
	/// through [`Surface::incoming`], so it is recorded here: a recording
	/// `surface-play` replays must hold both directions of the handshake.
	pub fn new(hello: Hello, mode: Mode, adopt: bool) -> Self {
		let mut surface = Self::with_hello(hello, mode, adopt);
		surface.record_reply(&Reply::Hello(surface.hello.clone()));
		surface
	}

	/// Starts an optimistic v1 surface before a `hello` reply arrives.
	///
	/// The assumed capabilities (every kind, the default `apc` limit and
	/// credits) are the ADR's phase-1 contract; a later reply narrows them
	/// through [`Surface::replace_hello`].
	pub fn optimistic(adopt: bool) -> Self {
		Self::with_hello(
			Hello {
				v:             1,
				term:          Str::new_static("tern"),
				ver:           None,
				kinds:         Kind::VARIANTS
					.iter()
					.map(|kind| Str::new_static((*kind).into()))
					.collect(),
				features:      Vec::new(),
				apc:           Some(DEFAULT_APC_LIMIT as u32),
				credits:       Some(DEFAULT_CREDITS),
				cols:          None,
				cell:          None,
				dark:          None,
				reduce_motion: None,
				hour12:        None,
			},
			Mode::Inline,
			adopt,
		)
	}

	fn with_hello(hello: Hello, mode: Mode, adopt: bool) -> Self {
		let encoder = Encoder::new(hello.apc_limit());
		Self {
			id: Str::new_static(SURFACE_ID),
			mode,
			hello,
			encoder,
			recorder: Recorder::from_env(),
			next_seq: 1,
			acked: 0,
			blocks: FastHashMap::default(),
			opened: false,
			adopting: adopt && mode == Mode::Inline,
			suspended: false,
			dirty: true,
			last_paced: None,
			composer_mounted: false,
			composer: Str::default(),
			composer_cursor: u32::MAX,
			sendable: false,
			sendable_sent: false,
			status_mounted: false,
			status_text: Str::default(),
			approval_id: Str::default(),
			form_id: Str::default(),
			cover: Cover::new(),
			events: VecDeque::new(),
		}
	}

	/// Adopts the capabilities a `hello` reply announced.
	pub fn replace_hello(&mut self, hello: Hello) {
		self.encoder.set_limit(hello.apc_limit());
		self.hello = hello;
	}

	/// Installs or replaces a stylesheet scoped to this surface.
	///
	/// Styles are sent only when Tern advertises `styles`; otherwise the
	/// caller keeps the semantic `el` nodes and Tern's own theme/layout.
	///
	/// # Errors
	///
	/// Returns invalid input for an illegal sheet name or a CSS payload over
	/// Tern's 256 KiB per-surface budget, or the writer error.
	pub fn set_stylesheet(
		&mut self,
		writer: &mut impl io::Write,
		name: &str,
		css: &str,
	) -> io::Result<()> {
		if !self.hello.has_feature("styles") {
			return Ok(());
		}
		if name.is_empty()
			|| name.len() > 64
			|| !name
				.bytes()
				.all(|byte| byte.is_ascii_alphanumeric() || b"_-".contains(&byte))
		{
			return Err(io::Error::new(io::ErrorKind::InvalidInput, "invalid TSP stylesheet name"));
		}
		if css.len() > 256 * 1024 {
			return Err(io::Error::new(io::ErrorKind::InvalidInput, "TSP stylesheet exceeds 256 KiB"));
		}
		self.send(writer, Verb::Stylesheet, &Stylesheet {
			sf:   self.id.clone(),
			name: Str::new(name),
			css:  Str::new(css),
		})
	}

	/// Re-enters the surface for a new terminal epoch.
	pub fn reenter(&mut self, adopt: bool) {
		self.opened = false;
		self.adopting = adopt && self.mode == Mode::Inline;
		if !self.adopting {
			self.blocks.clear();
		}
		self.composer_mounted = false;
		self.composer = Str::default();
		self.composer_cursor = u32::MAX;
		self.sendable_sent = false;
		self.status_mounted = false;
		self.status_text = Str::default();
		self.approval_id = Str::default();
		self.form_id = Str::default();
		self.cover.forget();
		self.dirty = true;
	}

	/// Earliest time a paced stream should be retried.
	pub fn next_wake(&self, pacing: TspStreamPacing) -> Option<Duration> {
		if pacing == TspStreamPacing::Paced {
			self
				.last_paced
				.map(|last| last.saturating_add(REVEAL_HORIZON))
		} else {
			None
		}
	}

	/// Emits pending native presentation updates if surface flow control allows.
	///
	/// A flow surface carries the blocks alone: the composer and the status band
	/// are the chat session chrome. One the terminal cannot show (no `flow`
	/// feature) is refused with [`io::ErrorKind::Unsupported`] before anything
	/// is written.
	pub fn present(
		&mut self,
		writer: &mut impl io::Write,
		blocks: &[RenderedBlock],
		composer: &str,
		cursor_utf16: u32,
		status: &str,
		now: Duration,
		pacing: TspStreamPacing,
	) -> io::Result<()> {
		if !self.supported() {
			return Err(io::ErrorKind::Unsupported.into());
		}
		if self.suspended || !self.credit_available() {
			self.dirty = true;
			return Ok(());
		}
		let mut ops = Vec::new();
		if !self.opened {
			let was_adopting = self.adopting;
			self.send_open(writer)?;
			if was_adopting {
				ops.extend([
					add(DOCK_ID, self.id.as_str(), Kind::Col, Map::new()),
					add(LAYER_ID, self.id.as_str(), Kind::Col, Map::new()),
				]);
			} else {
				ops.extend([
					add(MAIN_ID, self.id.as_str(), Kind::Col, Map::new()),
					add(DOCK_ID, self.id.as_str(), Kind::Col, Map::new()),
					add(LAYER_ID, self.id.as_str(), Kind::Col, Map::new()),
				]);
			}
			self.opened = true;
		}
		self.blocks(blocks, &mut ops, now, pacing);
		if self.mode != Mode::Flow {
			self.composer(composer, cursor_utf16, &mut ops);
			self.status(status, &mut ops);
		}
		if ops.is_empty() {
			self.dirty = false;
			return Ok(());
		}
		self.send_frame(writer, ops)?;
		self.dirty = false;
		Ok(())
	}

	/// Presents or removes the native approval form in the layer region.
	pub fn present_approval(
		&mut self,
		writer: &mut impl io::Write,
		id: Option<&str>,
		reason: Option<&str>,
	) -> io::Result<()> {
		let next = id.map_or_else(Str::default, Str::new);
		if self.approval_id == next {
			return Ok(());
		}
		if self.suspended || !self.credit_available() {
			self.dirty = true;
			return Ok(());
		}
		let mut ops = Vec::new();
		if !self.approval_id.is_empty() {
			ops.push(Op::Del(Str::new_static("approval")));
		}
		if let (Some(id), Some(reason)) = (id, reason) {
			ops.push(add_node(approval_node(id, reason), LAYER_ID));
		}
		if !ops.is_empty() {
			self.send_frame(writer, ops)?;
		}
		self.approval_id = next;
		Ok(())
	}

	/// Presents or removes one surface-scoped settings form.
	pub fn present_form(
		&mut self,
		writer: &mut impl io::Write,
		node: Option<Node>,
	) -> io::Result<()> {
		let next = node
			.as_ref()
			.map_or_else(Str::default, |node| node.id.clone());
		if self.form_id == next {
			return Ok(());
		}
		if self.suspended || !self.credit_available() {
			self.dirty = true;
			return Ok(());
		}
		let mut ops = Vec::new();
		if !self.form_id.is_empty() {
			ops.push(Op::Del(self.form_id.clone()));
		}
		if let Some(node) = node {
			ops.push(add_node(node, LAYER_ID));
		}
		if !ops.is_empty() {
			self.send_frame(writer, ops)?;
		}
		self.form_id = next;
		Ok(())
	}

	/// Covers the pane with a `screen` surface that draws `view`, or removes the
	/// cover when `view` is `None`.
	///
	/// The session surface stays live underneath: frames for it keep applying
	/// and nothing is resent when the cover closes. Like
	/// [`Self::present_form`], a view is identified by the id of its root:
	/// while that stays the same nothing is sent, and a new id replaces the old
	/// view in one frame. A cover is mounted only over an opened, unsuspended
	/// session.
	///
	/// # Errors
	/// Returns the error writing to the terminal.
	pub fn present_cover(
		&mut self,
		writer: &mut impl io::Write,
		view: Option<&Node>,
	) -> io::Result<()> {
		let Some(view) = view else {
			return self.drop_cover(writer);
		};
		if self.cover.opened && self.cover.view == view.id {
			return Ok(());
		}
		if !self.opened || self.suspended || !self.cover.credit_available(self.hello.credit_limit()) {
			self.dirty = true;
			return Ok(());
		}
		let mut ops = Vec::with_capacity(2);
		if self.cover.opened {
			if !self.cover.view.is_empty() {
				ops.push(Op::Del(self.cover.view.clone()));
			}
		} else {
			let open = Open {
				id:     Str::new_static(COVER_ID),
				mode:   Mode::Screen,
				title:  None,
				role:   None,
				adopt:  None,
				listen: Some(true),
			};
			self.send(writer, Verb::Open, &open)?;
			self.cover.opened = true;
			ops.push(add(MAIN_ID, COVER_ID, Kind::Col, Map::new()));
		}
		ops.push(add_node(view.clone(), MAIN_ID));
		self.send_cover_frame(writer, ops)?;
		self.cover.view = view.id.clone();
		Ok(())
	}

	/// Whether the terminal draws `node` and everything below it, kind by kind.
	/// A view it cannot draw is not sent, so its overlay stays in cells.
	#[must_use]
	pub fn draws(&self, node: &Node) -> bool {
		self.hello.draws(node.k) && node.c.iter().all(|child| self.draws(child))
	}

	/// Handles a terminal reply or event.
	pub fn incoming(&mut self, incoming: Incoming) {
		self.record_incoming(&incoming);
		match incoming {
			Incoming::Reply(Reply::Hello(hello)) => self.replace_hello(hello),
			Incoming::Reply(Reply::Blobs { .. }) => {},
			Incoming::Event(Event::Ack { sf, s }) if sf == self.id => {
				self.acked = self.acked.max(s);
			},
			Incoming::Event(Event::Ack { sf, s }) if sf.as_str() == COVER_ID => {
				self.cover.acked = self.cover.acked.max(s);
			},
			Incoming::Event(Event::Gone { sf: Some(sf), .. }) if sf.as_str() == COVER_ID => {
				self.cover.forget();
				self.dirty = true;
			},
			Incoming::Event(Event::Gone { sf, .. })
				if sf.as_ref().is_none_or(|surface| surface == &self.id) =>
			{
				self.opened = false;
				self.adopting = false;
				self.blocks.clear();
				self.events.clear();
				self.composer_mounted = false;
				self.composer = Str::default();
				self.composer_cursor = u32::MAX;
				self.sendable_sent = false;
				self.status_mounted = false;
				self.status_text = Str::default();
				self.approval_id = Str::default();
				self.form_id = Str::default();
				self.dirty = true;
			},
			Incoming::Event(event) => self.events.push_back(event),
		}
	}

	/// Removes the next terminal interaction event for the host actor.
	pub fn take_event(&mut self) -> Option<Event> {
		self.events.pop_front()
	}

	/// Sets whether the composer is ready to accept a `send`: the host's
	/// verdict on whether Enter would reach it. The next frame carries the
	/// composer's `sendable` prop.
	pub const fn set_sendable(&mut self, sendable: bool) {
		self.sendable = sendable;
	}

	/// Whether `sf` and `id` name this surface's live composer: the inline
	/// surface is open and not suspended behind a cell overlay, and the
	/// editor node is mounted in it. A `send` for anything else is stale.
	#[must_use]
	pub fn addresses_composer(&self, sf: &str, id: &str) -> bool {
		self.opened
			&& !self.suspended
			&& self.composer_mounted
			&& sf == self.id.as_str()
			&& id == COMPOSER_ID
	}

	/// Suspends native composition so the regular renderer can paint overlays.
	///
	/// The cover goes first: it would hide what the renderer paints.
	pub fn suspend(&mut self, writer: &mut impl io::Write) -> io::Result<()> {
		self.drop_cover(writer)?;
		if !self.suspended {
			self.send_frame(writer, vec![Op::Suspend])?;
			self.suspended = true;
		}
		Ok(())
	}

	/// Resumes native composition after the cell overlay closes.
	pub fn resume(&mut self, writer: &mut impl io::Write) -> io::Result<()> {
		if self.suspended {
			self.send_frame(writer, vec![Op::Resume])?;
			self.suspended = false;
			self.dirty = true;
		}
		Ok(())
	}

	/// Closes the live epoch: the cover first, then the surface. An inline
	/// surface closed with `keep` stays in the scrollback for adoption and a
	/// flow surface stays there as command output; a screen surface is
	/// discarded whatever `keep` says.
	pub fn close(&mut self, writer: &mut impl io::Write, keep: bool) -> io::Result<()> {
		self.drop_cover(writer)?;
		if self.opened {
			let keep = keep && self.mode != Mode::Screen;
			self.send(writer, Verb::Close, &Close { id: self.id.clone(), keep })?;
			self.opened = false;
		}
		Ok(())
	}

	fn drop_cover(&mut self, writer: &mut impl io::Write) -> io::Result<()> {
		if self.cover.opened {
			let close = Close { id: Str::new_static(COVER_ID), keep: false };
			self.send(writer, Verb::Close, &close)?;
			self.cover.forget();
		}
		Ok(())
	}

	/// Whether a blocked frame still needs replaying after an `ack`.
	pub const fn dirty(&self) -> bool {
		self.dirty
	}

	fn credit_available(&self) -> bool {
		let unacknowledged = (self.next_seq.saturating_sub(1)).saturating_sub(self.acked);
		!self.listening() || unacknowledged < u64::from(self.hello.credit_limit())
	}

	/// Whether Tern hears this surface. A flow surface never reads its input, so
	/// Tern sends it no acks and its frames never wait for credits.
	const fn listening(&self) -> bool {
		!matches!(self.mode, Mode::Flow)
	}

	/// Whether the terminal can show this surface: an older Tern rejects the
	/// flow mode.
	fn supported(&self) -> bool {
		!matches!(self.mode, Mode::Flow) || self.hello.has_feature("flow")
	}

	fn send_open(&mut self, writer: &mut impl io::Write) -> io::Result<()> {
		let open = Open {
			id:     self.id.clone(),
			mode:   self.mode,
			title:  Some(Str::new_static("omp")),
			role:   (self.mode == Mode::Inline).then_some(Str::new_static("omp.session")),
			adopt:  self.adopting.then_some(true),
			listen: Some(self.listening()),
		};
		self.send(writer, Verb::Open, &open)?;
		self.adopting = false;
		// A new inline or screen surface replaces any screen surface Tern holds,
		// so a cover is mounted again from scratch.
		self.cover.forget();
		Ok(())
	}

	fn send_frame(&mut self, writer: &mut impl io::Write, ops: Vec<Op>) -> io::Result<()> {
		let frame = Frame { sf: self.id.clone(), s: self.next_seq, ops };
		self.next_seq = self.next_seq.saturating_add(1);
		log_frame(&frame);
		self.send(writer, Verb::Frame, &frame)
	}

	fn send_cover_frame(&mut self, writer: &mut impl io::Write, ops: Vec<Op>) -> io::Result<()> {
		let frame = Frame { sf: Str::new_static(COVER_ID), s: self.cover.next_seq, ops };
		self.cover.next_seq = self.cover.next_seq.saturating_add(1);
		log_frame(&frame);
		self.send(writer, Verb::Frame, &frame)
	}

	fn send<T: Serialize>(
		&mut self,
		writer: &mut impl io::Write,
		verb: Verb,
		value: &T,
	) -> io::Result<()> {
		let body = serde_json::to_vec(value).map_err(io::Error::other)?;
		if let Some(recorder) = &mut self.recorder {
			let _ = recorder.log(Direction::Out, verb.into(), &[], &body);
		}
		let mut out = BytesMut::new();
		self.encoder.message(verb, &[], &body, &mut out);
		writer.write_all(&out)?;
		writer.flush()
	}

	fn record_incoming(&mut self, incoming: &Incoming) {
		match incoming {
			Incoming::Reply(reply) => self.record_reply(reply),
			Incoming::Event(event) => self.record(Direction::In, "e", event),
		}
	}

	fn record_reply(&mut self, reply: &Reply) {
		self.record(Direction::In, "r", reply);
	}

	fn record<T: Serialize>(&mut self, direction: Direction, verb: &str, value: &T) {
		let Some(recorder) = &mut self.recorder else {
			return;
		};
		if let Ok(body) = serde_json::to_vec(value) {
			let _ = recorder.log(direction, verb, &[], &body);
		}
	}

	fn blocks(
		&mut self,
		blocks: &[RenderedBlock],
		ops: &mut Vec<Op>,
		now: Duration,
		pacing: TspStreamPacing,
	) {
		let mut retained = VecDeque::new();
		for block in blocks {
			retained.push_back(block.view.key);
			let id = block_id(block.view.key);
			let (node, text_id) = node_for(block, &self.hello);
			let prior = self.blocks.get(&block.view.key).cloned();
			match prior {
				None => {
					if is_stream(block) && pacing == TspStreamPacing::Paced && self.last_paced.is_none()
					{
						self.last_paced = Some(now);
					}
					ops.push(add_node(node, MAIN_ID));
					self.blocks.insert(block.view.key, BlockState {
						id: id.clone(),
						text_id,
						text: block.view.text.clone(),
						finalized: block.view.finalized,
					});
					if block.view.finalized {
						ops.push(Op::Settle(id));
					}
				},
				Some(mut prior) => {
					let stream = is_stream(block);
					let grew = stream && block.view.text.starts_with(prior.text.as_str());
					let pacing_due = pacing != TspStreamPacing::Paced
						|| block.view.finalized
						|| self
							.last_paced
							.is_none_or(|last| now >= last.saturating_add(REVEAL_HORIZON));
					if grew && block.view.text.len() > prior.text.len() && pacing_due {
						ops.push(Op::Text {
							id:   prior.text_id.clone(),
							mode: TextMode::Append,
							text: Str::new(&block.view.text.as_str()[prior.text.len()..]),
						});
						prior.text.clone_from(&block.view.text);
						if pacing == TspStreamPacing::Paced {
							self.last_paced = Some(now);
						}
					} else if !grew && prior.text != block.view.text {
						ops.push(Op::Set {
							id:    prior.text_id.clone(),
							props: text_props(block.view.text.clone()),
						});
						prior.text.clone_from(&block.view.text);
					}
					if block.view.finalized && !prior.finalized {
						if prior.text != block.view.text {
							ops.push(Op::Text {
								id:   prior.text_id.clone(),
								mode: TextMode::Append,
								text: Str::new(&block.view.text.as_str()[prior.text.len()..]),
							});
							prior.text.clone_from(&block.view.text);
						}
						ops.push(Op::Settle(prior.id.clone()));
						prior.finalized = true;
					}
					self.blocks.insert(block.view.key, prior);
				},
			}
		}
		let stale = self
			.blocks
			.keys()
			.filter(|key| !retained.contains(key))
			.copied()
			.collect::<Vec<_>>();
		for key in stale {
			if let Some(block) = self.blocks.remove(&key) {
				ops.push(Op::Del(block.id));
			}
		}
	}

	fn composer(&mut self, text: &str, cursor_utf16: u32, ops: &mut Vec<Op>) {
		let id = Str::new_static(COMPOSER_ID);
		if !self.composer_mounted {
			let mut props = text_props(Str::new(text));
			props.insert("placeholder".into(), Value::String(PLACEHOLDER.into()));
			props.insert("cursor".into(), Value::from(cursor_utf16));
			if self.sendable {
				props.insert("sendable".into(), Value::Bool(true));
			}
			ops.push(add(COMPOSER_ID, DOCK_ID, Kind::Editor, props));
			ops.push(Op::Focus(Some(id)));
			self.composer_mounted = true;
			self.composer = Str::new(text);
			self.composer_cursor = cursor_utf16;
			self.sendable_sent = self.sendable;
			return;
		}
		if self.sendable_sent != self.sendable {
			let mut sendable = Map::new();
			sendable.insert("sendable".into(), Value::Bool(self.sendable));
			ops.push(Op::Set { id: id.clone(), props: sendable });
			self.sendable_sent = self.sendable;
		}
		if self.composer.as_str() != text {
			ops.push(Op::Text { id: id.clone(), mode: TextMode::Replace, text: Str::new(text) });
			self.composer = Str::new(text);
		}
		if self.composer_cursor != cursor_utf16 {
			let mut cursor = Map::new();
			cursor.insert("cursor".into(), Value::from(cursor_utf16));
			ops.push(Op::Set { id, props: cursor });
			self.composer_cursor = cursor_utf16;
		}
	}

	fn status(&mut self, status: &str, ops: &mut Vec<Op>) {
		let text = Str::new(status);
		if !self.status_mounted {
			ops.push(add_node(status_node(text.as_str()), DOCK_ID));
			self.status_mounted = true;
			self.status_text = text;
		} else if self.status_text != text {
			ops.extend([
				Op::Del(Str::new_static(STATUS_ID)),
				add_node(status_node(text.as_str()), DOCK_ID),
			]);
			self.status_text = text;
		}
	}
}

/// Logs one frame at debug level with how many of its added nodes fell back to
/// `rows` (ADR 0041 phase 2): the count is a field computed only when the
/// event is enabled, so a build that does not log pays nothing per frame.
fn log_frame(frame: &Frame) {
	tracing::debug!(
		surface = frame.sf.as_str(),
		seq = frame.s,
		ops = frame.ops.len(),
		rows = rows_added(&frame.ops),
		"tsp frame"
	);
}

/// How many nodes `ops` add as `rows`, the pre-rendered ANSI fallback, anywhere
/// in the added subtrees.
fn rows_added(ops: &[Op]) -> usize {
	fn rows_in(node: &Node) -> usize {
		usize::from(node.k == Kind::Rows) + node.c.iter().map(rows_in).sum::<usize>()
	}
	ops.iter()
		.map(|op| match op {
			Op::Add { node, .. } => rows_in(node),
			_ => 0,
		})
		.sum()
}

/// Whether a block's text grows by append, so deltas ride `text append`.
const fn is_stream(block: &RenderedBlock) -> bool {
	matches!(block.view.kind, BlockKind::Assistant | BlockKind::Thinking)
}

fn status_node(text: &str) -> Node {
	let children = text
		.split('·')
		.enumerate()
		.map(|(index, segment)| Node {
			id: Str::from(format!("{STATUS_ID}-{index}")),
			k:  Kind::Seg,
			p:  text_props(Str::new(segment.trim())),
			c:  Vec::new(),
		})
		.collect();
	Node {
		id: Str::new_static(STATUS_ID),
		k:  Kind::Status,
		p:  text_props(Str::new(text)),
		c:  children,
	}
}

fn block_id(key: u64) -> Str {
	Str::from(format!("b-{key:x}"))
}

fn text_props(text: Str) -> Map<String, Value> {
	let mut props = Map::new();
	props.insert("text".into(), Value::String(text.into()));
	props
}

fn add(id: &str, parent: &str, kind: Kind, props: Map<String, Value>) -> Op {
	Op::Add {
		parent: Str::new(parent),
		before: None,
		node:   Node { id: Str::new(id), k: kind, p: props, c: Vec::new() },
	}
}

fn add_node(node: Node, parent: &str) -> Op {
	Op::Add { parent: Str::new(parent), before: None, node }
}

fn node_for(block: &RenderedBlock, hello: &Hello) -> (Node, Str) {
	let id = block_id(block.view.key);
	if let Some(node) = block
		.description
		.as_ref()
		.filter(|node| hello.draws(node.k))
	{
		return (node.clone(), node.id.clone());
	}
	let kind = match block.view.kind {
		BlockKind::User => Kind::Card,
		BlockKind::Assistant if hello.draws(Kind::Md) => Kind::Md,
		BlockKind::Thinking if hello.draws(Kind::Section) => Kind::Section,
		BlockKind::Notice if hello.draws(Kind::Toast) => Kind::Toast,
		BlockKind::Tool if hello.draws(Kind::Tool) => Kind::Tool,
		BlockKind::Tool if hello.draws(Kind::Card) => Kind::Card,
		_ => Kind::Rows,
	};
	match kind {
		Kind::Md | Kind::Toast => (
			Node { id: id.clone(), k: kind, p: text_props(block.view.text.clone()), c: Vec::new() },
			id,
		),
		Kind::Rows => {
			let mut props = text_props(block.view.text.clone());
			props.insert(
				"lines".into(),
				Value::Array(
					block
						.view
						.text
						.lines()
						.map(|l| Value::String(l.to_string()))
						.collect(),
				),
			);
			(Node { id: id.clone(), k: kind, p: props, c: Vec::new() }, id)
		},
		Kind::Card | Kind::Section | Kind::Tool => {
			let child_id = Str::from(format!("{id}-text"));
			(
				Node {
					id,
					k: kind,
					p: Map::new(),
					c: vec![Node {
						id: child_id.clone(),
						k:  if matches!(block.view.kind, BlockKind::Assistant | BlockKind::Thinking) {
							Kind::Md
						} else {
							Kind::Text
						},
						p:  text_props(block.view.text.clone()),
						c:  Vec::new(),
					}],
				},
				child_id,
			)
		},
		_ => unreachable!("phase-one node mapping is closed"),
	}
}

#[cfg(test)]
mod tests {
	use std::{fmt, sync::Arc};

	use omp_tui::{
		IntoComponent as _,
		components::TextLeaf,
		slots::Mode,
		tsp::{
			doc::{Closed, Document},
			frame::split,
			wire::Mode as SurfaceMode,
		},
	};
	use parking_lot::Mutex;
	use tracing::{
		Subscriber,
		field::{Field, Visit},
	};
	use tracing_subscriber::{
		layer::{Context, Layer, SubscriberExt as _},
		registry,
	};

	use super::*;
	use crate::project::BlockView;

	fn make_block(key: u64, kind: BlockKind, text: &str, finalized: bool) -> RenderedBlock {
		RenderedBlock {
			view:        BlockView {
				key,
				kind,
				text: Str::new(text),
				mode: Mode::AppendOnly,
				finalized,
			},
			component:   TextLeaf::new().text(text).into_component(),
			description: None,
			stream:      Some(Str::new(text)),
		}
	}

	fn apply_output_to_doc(doc: &mut Document, output: &[u8]) {
		let mut rest = output;
		while let Some(start) = rest.windows(2).position(|w| w == b"\x1b_") {
			let after = &rest[start + 2..];
			let end = after
				.windows(2)
				.position(|w| w == b"\x1b\\")
				.expect("terminated message");
			let payload = &after[..end];
			if let Some(raw) = split(payload)
				&& raw.verb == "f"
			{
				let frame: Frame = serde_json::from_slice(raw.body).expect("valid frame JSON");
				let rejected = doc.apply(&frame);
				assert!(rejected.is_empty(), "frame had rejected ops: {rejected:?}");
			}
			rest = &after[end + 2..];
		}
	}

	#[test]
	fn optimistic_surface_emits_valid_regions_and_document_applies() {
		let mut surface = Surface::optimistic(false);
		let mut out = Vec::new();
		let mut doc = Document::new(SURFACE_ID);

		let blocks = [make_block(1, BlockKind::User, "Hello assistant", true)];
		surface
			.present(
				&mut out,
				&blocks,
				"my draft",
				8,
				"model-v1",
				Duration::ZERO,
				TspStreamPacing::Raw,
			)
			.expect("present succeeds");

		apply_output_to_doc(&mut doc, &out);
		assert!(doc.contains(MAIN_ID));
		assert!(doc.contains(DOCK_ID));
		assert!(doc.contains(LAYER_ID));
		assert!(doc.contains(COMPOSER_ID));
		assert_eq!(doc.focus(), Some(COMPOSER_ID));
		assert!(doc.contains(&block_id(1)));
		assert!(doc.is_settled(&block_id(1)));
	}

	#[test]
	fn streaming_assistant_uses_text_append_and_settles() {
		let mut surface = Surface::optimistic(false);
		let mut doc = Document::new(SURFACE_ID);

		// Frame 1: streaming delta 1
		let mut out1 = Vec::new();
		let blocks1 = [make_block(2, BlockKind::Assistant, "The answer is", false)];
		surface
			.present(&mut out1, &blocks1, "", 0, "status", Duration::ZERO, TspStreamPacing::Raw)
			.unwrap();
		apply_output_to_doc(&mut doc, &out1);
		assert!(!doc.is_settled(&block_id(2)));

		// Frame 2: streaming delta 2
		let mut out2 = Vec::new();
		let blocks2 = [make_block(2, BlockKind::Assistant, "The answer is 42.", false)];
		surface
			.present(
				&mut out2,
				&blocks2,
				"",
				0,
				"status",
				Duration::from_millis(50),
				TspStreamPacing::Raw,
			)
			.unwrap();
		apply_output_to_doc(&mut doc, &out2);
		assert!(!doc.is_settled(&block_id(2)));
		// Acknowledge frame 1 to grant credit for frame 3
		surface.incoming(Incoming::Event(Event::Ack { sf: Str::new(SURFACE_ID), s: 1 }));

		// Frame 3: finalized
		let mut out3 = Vec::new();
		let blocks3 = [make_block(2, BlockKind::Assistant, "The answer is 42.", true)];
		surface
			.present(
				&mut out3,
				&blocks3,
				"",
				0,
				"status",
				Duration::from_millis(100),
				TspStreamPacing::Raw,
			)
			.unwrap();
		apply_output_to_doc(&mut doc, &out3);
		assert!(doc.is_settled(&block_id(2)));
	}

	#[test]
	fn flow_control_credit_limit_and_ack_unblocking() {
		let mut surface = Surface::optimistic(false);
		let mut out = Vec::new();

		// Frame 1
		let blocks = [make_block(1, BlockKind::Assistant, "chunk 1", false)];
		surface
			.present(&mut out, &blocks, "", 0, "", Duration::ZERO, TspStreamPacing::Raw)
			.unwrap();
		assert!(!out.is_empty());
		out.clear();

		// Frame 2
		let blocks = [make_block(1, BlockKind::Assistant, "chunk 1 and 2", false)];
		surface
			.present(&mut out, &blocks, "", 0, "", Duration::from_millis(10), TspStreamPacing::Raw)
			.unwrap();
		assert!(!out.is_empty());
		out.clear();

		// Frame 3 should be blocked because credits = 2 and unacknowledged = 2
		let blocks = [make_block(1, BlockKind::Assistant, "chunk 1 and 2 and 3", false)];
		surface
			.present(&mut out, &blocks, "", 0, "", Duration::from_millis(20), TspStreamPacing::Raw)
			.unwrap();
		assert!(out.is_empty(), "frame 3 must be blocked by credit limit");
		assert!(surface.dirty());

		// Acknowledge frame 1
		surface.incoming(Incoming::Event(Event::Ack { sf: Str::new(SURFACE_ID), s: 1 }));

		// Now frame 3 can be sent
		surface
			.present(&mut out, &blocks, "", 0, "", Duration::from_millis(30), TspStreamPacing::Raw)
			.unwrap();
		assert!(!out.is_empty(), "frame 3 must be sent after ack 1");
	}

	#[test]
	fn overlay_suspends_and_resumes() {
		let mut surface = Surface::optimistic(false);
		let mut out = Vec::new();
		let mut doc = Document::new(SURFACE_ID);

		let blocks = [make_block(1, BlockKind::User, "hi", true)];
		surface
			.present(&mut out, &blocks, "", 0, "", Duration::ZERO, TspStreamPacing::Raw)
			.unwrap();
		apply_output_to_doc(&mut doc, &out);
		assert!(!doc.suspended());

		out.clear();
		surface.suspend(&mut out).unwrap();
		apply_output_to_doc(&mut doc, &out);
		assert!(doc.suspended());

		out.clear();
		surface.resume(&mut out).unwrap();
		apply_output_to_doc(&mut doc, &out);
		assert!(!doc.suspended());
	}

	#[test]
	fn close_with_keep_and_adopt() {
		let mut surface = Surface::optimistic(false);
		let mut out = Vec::new();
		let mut doc = Document::new(SURFACE_ID);

		let blocks = [make_block(1, BlockKind::User, "historical user", true)];
		surface
			.present(&mut out, &blocks, "draft", 5, "ok", Duration::ZERO, TspStreamPacing::Raw)
			.unwrap();
		apply_output_to_doc(&mut doc, &out);

		// Close with keep: true
		out.clear();
		surface.close(&mut out, true).unwrap();
		doc.close(true);
		assert!(doc.contains(MAIN_ID));
		assert!(!doc.contains(DOCK_ID));

		// Adopt in next epoch
		surface.reenter(true);
		out.clear();
		let new_blocks = [
			make_block(1, BlockKind::User, "historical user", true),
			make_block(2, BlockKind::Assistant, "new reply", true),
		];
		surface
			.present(&mut out, &new_blocks, "draft 2", 7, "ok", Duration::ZERO, TspStreamPacing::Raw)
			.unwrap();
		apply_output_to_doc(&mut doc, &out);
		assert!(doc.contains(MAIN_ID));
		assert!(doc.contains(DOCK_ID));
		assert!(doc.contains(&block_id(1)));
		assert!(doc.contains(&block_id(2)));
	}

	#[test]
	fn stream_pacing_holds_deltas_until_horizon() {
		let mut surface = Surface::optimistic(false);
		let mut out = Vec::new();

		let blocks1 = [make_block(1, BlockKind::Assistant, "A", false)];
		surface
			.present(&mut out, &blocks1, "", 0, "", Duration::from_millis(100), TspStreamPacing::Paced)
			.unwrap();
		assert!(!out.is_empty(), "initial block must be added");
		out.clear();

		// Delta arrived too quickly before REVEAL_HORIZON
		let blocks2 = [make_block(1, BlockKind::Assistant, "AB", false)];
		surface
			.present(&mut out, &blocks2, "", 0, "", Duration::from_millis(150), TspStreamPacing::Paced)
			.unwrap();
		assert!(out.is_empty(), "delta must be held under paced mode before horizon");

		// Delta released once REVEAL_HORIZON passes
		surface
			.present(
				&mut out,
				&blocks2,
				"",
				0,
				"",
				Duration::from_millis(100) + REVEAL_HORIZON,
				TspStreamPacing::Paced,
			)
			.unwrap();
		assert!(!out.is_empty(), "delta must be emitted after horizon");
	}

	#[test]
	fn tool_kind_fallback_to_card_when_tool_absent() {
		let hello_without_tool = Hello {
			v:             1,
			term:          Str::new_static("tern"),
			ver:           None,
			kinds:         vec![
				Str::new_static("col"),
				Str::new_static("card"),
				Str::new_static("md"),
			],
			features:      Vec::new(),
			apc:           None,
			credits:       None,
			cols:          None,
			cell:          None,
			dark:          None,
			reduce_motion: None,
			hour12:        None,
		};
		assert!(!hello_without_tool.draws(Kind::Tool));

		let block = make_block(5, BlockKind::Tool, "bash exit 0", true);
		let (node, _) = node_for(&block, &hello_without_tool);
		assert_eq!(node.k, Kind::Card, "tool must fall back to card when tool kind is missing");
	}

	#[test]
	fn mutation_detects_unsettled_blocks() {
		let mut doc = Document::new(SURFACE_ID);
		let frame = Frame {
			sf:  Str::new_static(SURFACE_ID),
			s:   1,
			ops: vec![
				add(MAIN_ID, SURFACE_ID, Kind::Col, Map::new()),
				add_node(
					Node { id: Str::new_static("b-1"), k: Kind::Card, p: Map::new(), c: vec![] },
					MAIN_ID,
				),
				// Intentionally omitted Op::Settle("b-1")
			],
		};
		doc.apply(&frame);
		assert!(!doc.is_settled("b-1"), "omitted settle must leave block unsettled");
	}
	#[test]
	fn element_builder_is_typed_and_surface_scoped() {
		let mut props = Map::new();
		props.insert("text".into(), Value::String(Str::new_static("Approve").into()));
		let node = element_node(Str::new_static("approve"), ElementTag::Button, props, Vec::new());
		assert_eq!(node.k, Kind::El);
		assert_eq!(node.p.get("tag"), Some(&Value::String("button".into())));
	}

	#[test]
	fn stylesheet_requires_feature_and_rejects_invalid_names() {
		let hello = Hello {
			v:             1,
			term:          Str::new_static("tern"),
			ver:           None,
			kinds:         vec![Str::new_static("col")],
			features:      vec![Str::new_static("styles")],
			apc:           None,
			credits:       None,
			cols:          None,
			cell:          None,
			dark:          None,
			reduce_motion: None,
			hour12:        None,
		};
		let mut surface = Surface::new(hello, SurfaceMode::Inline, false);
		let mut out = Vec::new();
		surface
			.set_stylesheet(&mut out, "forms", ".ask { display: flex }")
			.unwrap();
		assert!(out.windows(6).any(|window| window == b"tsp;s;"));
		assert!(surface.set_stylesheet(&mut out, "bad/name", "").is_err());
		assert!(
			surface
				.set_stylesheet(&mut out, "too-large", &"x".repeat(256 * 1024 + 1))
				.is_err()
		);
		let mut no_styles = Surface::optimistic(false);
		let mut untouched = Vec::new();
		no_styles
			.set_stylesheet(&mut untouched, "forms", "body {}")
			.unwrap();
		assert!(untouched.is_empty(), "optimistic hello does not assume styles");
	}

	#[test]
	fn approval_form_and_native_actions_are_protocol_nodes() {
		let form = approval_node("ticket-1", "Approve network access?");
		assert_eq!(form.k, Kind::El);
		assert_eq!(form.p.get("tag"), Some(&Value::String("form".into())));
		assert_eq!(form.c.len(), 3);
		assert_eq!(form.c[1].p.get("text"), Some(&Value::String("Approve".into())));

		let mut surface = Surface::optimistic(false);
		surface.incoming(Incoming::Event(Event::Action {
			sf:     Str::new_static(SURFACE_ID),
			id:     Str::new_static("approval"),
			act:    Str::new_static("approve"),
			value:  None,
			mods:   Vec::new(),
			values: None,
		}));
		assert!(matches!(surface.take_event(), Some(Event::Action { .. })));
	}

	/// A terminal reading one presenter output: each `o` opens a document, each
	/// `f` applies to the live surface it names and each `x` closes one.
	#[derive(Default)]
	struct Tern {
		opens:  Vec<Open>,
		closes: Vec<(Close, Closed)>,
		frames: usize,
		live:   Vec<Document>,
		kept:   Vec<Document>,
	}

	impl Tern {
		fn read(&mut self, output: &[u8]) {
			let mut rest = output;
			while let Some(start) = rest.windows(2).position(|w| w == b"\x1b_") {
				let after = &rest[start + 2..];
				let end = after
					.windows(2)
					.position(|w| w == b"\x1b\\")
					.expect("terminated message");
				let raw = split(&after[..end]).expect("a TSP message");
				match raw.verb {
					"o" => {
						let open: Open = serde_json::from_slice(raw.body).expect("valid open JSON");
						self.open(open);
					},
					"f" => {
						let frame: Frame = serde_json::from_slice(raw.body).expect("valid frame JSON");
						self.apply(&frame);
					},
					"x" => {
						let close: Close = serde_json::from_slice(raw.body).expect("valid close JSON");
						self.close(&close);
					},
					verb => panic!("the presenter sent a {verb:?} message this terminal does not model"),
				}
				rest = &after[end + 2..];
			}
		}

		fn open(&mut self, open: Open) {
			// A new surface replaces the live one of its mode, and a new inline
			// surface also discards a screen cover.
			self.live.retain(|doc| {
				doc.mode() != open.mode
					&& !(open.mode == SurfaceMode::Inline && doc.mode() == SurfaceMode::Screen)
			});
			self.live.push(Document::open(&open));
			self.opens.push(open);
		}

		fn apply(&mut self, frame: &Frame) {
			let doc = self
				.live
				.iter_mut()
				.find(|doc| doc.surface() == &frame.sf)
				.unwrap_or_else(|| panic!("a frame for {}, which is not open", frame.sf));
			let rejected = doc.apply(frame);
			assert!(rejected.is_empty(), "frame had rejected ops: {rejected:?}");
			self.frames += 1;
		}

		fn close(&mut self, close: &Close) {
			let index = self
				.live
				.iter()
				.position(|doc| doc.surface() == &close.id)
				.unwrap_or_else(|| panic!("a close for {}, which is not open", close.id));
			let mut doc = self.live.remove(index);
			let closed = doc.close(close.keep);
			if closed == Closed::Kept {
				self.kept.push(doc);
			}
			self.closes.push((close.clone(), closed));
		}

		/// The live document of surface `id`.
		fn doc(&self, id: &str) -> &Document {
			self
				.live
				.iter()
				.find(|doc| doc.surface().as_str() == id)
				.unwrap_or_else(|| panic!("surface {id} is not open"))
		}

		/// The ids under the cover `main` region.
		fn cover_main(&self) -> Vec<String> {
			self
				.doc(COVER_ID)
				.get("main")
				.expect("main region")
				.c
				.iter()
				.map(|node| node.id.as_str().to_owned())
				.collect()
		}
	}

	/// The optimistic v1 `hello` (every kind) advertising `features`.
	fn hello(features: &[&'static str]) -> Hello {
		let mut hello = Surface::optimistic(false).hello;
		hello.features = features.iter().copied().map(Str::new_static).collect();
		hello
	}

	/// The view a full-screen panel hands the presenter.
	fn view(id: &'static str) -> Node {
		element_node(Str::new_static(id), ElementTag::Form, Map::new(), Vec::new())
	}

	fn session_present(surface: &mut Surface, out: &mut Vec<u8>, blocks: &[RenderedBlock]) {
		surface
			.present(out, blocks, "draft", 5, "ok", Duration::ZERO, TspStreamPacing::Raw)
			.unwrap();
	}

	#[test]
	fn the_session_surface_opens_inline_with_its_role_and_listens() {
		let mut surface = Surface::optimistic(false);
		let mut tern = Tern::default();
		let mut out = Vec::new();
		session_present(&mut surface, &mut out, &[make_block(1, BlockKind::User, "hi", true)]);
		tern.read(&out);
		let [open] = tern.opens.as_slice() else {
			panic!("one surface opens: {:?}", tern.opens);
		};
		assert_eq!(open.id.as_str(), SURFACE_ID);
		assert_eq!(open.mode, SurfaceMode::Inline);
		assert_eq!(open.role.as_deref(), Some("omp.session"));
		assert_eq!(open.listen, Some(true));
		assert_eq!(open.adopt, None);
	}

	#[test]
	fn a_screen_cover_opens_over_the_live_session_and_leaves_it_untouched() {
		let mut surface = Surface::optimistic(false);
		let mut tern = Tern::default();
		let mut out = Vec::new();
		session_present(&mut surface, &mut out, &[make_block(
			1,
			BlockKind::Assistant,
			"Hello",
			true,
		)]);
		tern.read(&out);
		let before = tern.doc(SURFACE_ID).snapshot();

		out.clear();
		surface
			.present_cover(&mut out, Some(&view("settings")))
			.unwrap();
		tern.read(&out);
		let screen = &tern.opens[1];
		assert_eq!(screen.id.as_str(), COVER_ID);
		assert_eq!(screen.mode, SurfaceMode::Screen);
		assert_eq!(screen.listen, Some(true));
		assert_eq!(tern.cover_main(), ["settings"]);
		assert_eq!(tern.doc(SURFACE_ID).snapshot(), before, "the cover leaves the session as it was");

		// The session keeps drawing underneath: frames for it still apply.
		out.clear();
		let blocks = [
			make_block(1, BlockKind::Assistant, "Hello", true),
			make_block(2, BlockKind::Assistant, "More", true),
		];
		session_present(&mut surface, &mut out, &blocks);
		tern.read(&out);
		assert!(tern.doc(SURFACE_ID).contains(&block_id(2)));
		assert!(!tern.doc(COVER_ID).contains(&block_id(2)));

		out.clear();
		surface.present_cover(&mut out, None).unwrap();
		tern.read(&out);
		let (close, closed) = &tern.closes[0];
		assert_eq!(close.id.as_str(), COVER_ID);
		assert!(!close.keep, "a screen surface is discarded whatever keep says");
		assert_eq!(*closed, Closed::Discarded);
		assert!(tern.doc(SURFACE_ID).contains(&block_id(2)), "the session shows again as it was");
	}

	#[test]
	fn a_cover_is_identified_by_its_root_and_mounts_again_after_it_closes() {
		let mut surface = Surface::optimistic(false);
		let mut tern = Tern::default();
		let mut out = Vec::new();
		session_present(&mut surface, &mut out, &[]);
		surface
			.present_cover(&mut out, Some(&view("settings")))
			.unwrap();
		tern.read(&out);

		out.clear();
		surface
			.present_cover(&mut out, Some(&view("settings")))
			.unwrap();
		assert!(out.is_empty(), "the same view is not sent twice");

		surface
			.present_cover(&mut out, Some(&view("models")))
			.unwrap();
		tern.read(&out);
		assert_eq!(tern.cover_main(), ["models"], "a new root replaces the old view");
		assert_eq!(
			tern.opens.len(),
			2,
			"the cover stays open: one surface for the session, one for it"
		);

		out.clear();
		surface.present_cover(&mut out, None).unwrap();
		surface
			.present_cover(&mut out, Some(&view("settings")))
			.unwrap();
		tern.read(&out);
		assert_eq!(tern.opens.len(), 3, "a closed cover opens again");
		assert_eq!(tern.cover_main(), ["settings"]);
	}

	#[test]
	fn the_cover_has_credits_of_its_own_and_starts_over_when_it_closes() {
		let mut surface = Surface::optimistic(false);
		let mut tern = Tern::default();
		let mut out = Vec::new();
		session_present(&mut surface, &mut out, &[]);
		surface.present_cover(&mut out, Some(&view("a"))).unwrap();
		surface.present_cover(&mut out, Some(&view("b"))).unwrap();
		tern.read(&out);

		out.clear();
		surface.present_cover(&mut out, Some(&view("c"))).unwrap();
		assert!(out.is_empty(), "two cover frames are unacknowledged, so the third waits");
		assert!(surface.dirty());

		surface.incoming(Incoming::Event(Event::Ack { sf: Str::new_static(COVER_ID), s: 1 }));
		surface.present_cover(&mut out, Some(&view("c"))).unwrap();
		tern.read(&out);
		assert_eq!(tern.cover_main(), ["c"]);

		// Frames still in flight when a cover closes are never acknowledged.
		out.clear();
		surface.present_cover(&mut out, None).unwrap();
		surface.present_cover(&mut out, Some(&view("d"))).unwrap();
		tern.read(&out);
		assert_eq!(tern.opens.len(), 3);
		assert_eq!(tern.cover_main(), ["d"]);
	}

	#[test]
	fn a_cover_mounts_again_after_tern_drops_it_or_the_session_opens_anew() {
		let mut surface = Surface::optimistic(false);
		let mut tern = Tern::default();
		let mut out = Vec::new();
		session_present(&mut surface, &mut out, &[]);
		surface
			.present_cover(&mut out, Some(&view("settings")))
			.unwrap();
		tern.read(&out);
		let covers = |tern: &Tern| {
			tern
				.opens
				.iter()
				.filter(|open| open.mode == SurfaceMode::Screen)
				.count()
		};
		assert_eq!(covers(&tern), 1);

		// Tern dropped the cover and said so.
		tern.live.retain(|doc| doc.surface().as_str() != COVER_ID);
		surface.incoming(Incoming::Event(Event::Gone {
			sf:  Some(Str::new_static(COVER_ID)),
			ids: vec![Str::new_static(COVER_ID)],
		}));
		out.clear();
		surface
			.present_cover(&mut out, Some(&view("settings")))
			.unwrap();
		tern.read(&out);
		assert_eq!(covers(&tern), 2);

		// A session that opens anew discards any cover, silently.
		surface.incoming(Incoming::Event(Event::Gone {
			sf:  None,
			ids: vec![Str::new_static(SURFACE_ID)],
		}));
		out.clear();
		session_present(&mut surface, &mut out, &[]);
		surface
			.present_cover(&mut out, Some(&view("settings")))
			.unwrap();
		tern.read(&out);
		assert_eq!(covers(&tern), 3);
		assert_eq!(tern.cover_main(), ["settings"]);
	}

	#[test]
	fn suspending_or_closing_the_session_closes_the_cover_first() {
		let mut surface = Surface::optimistic(false);
		let mut tern = Tern::default();
		let mut out = Vec::new();
		session_present(&mut surface, &mut out, &[]);
		surface
			.present_cover(&mut out, Some(&view("settings")))
			.unwrap();
		tern.read(&out);

		out.clear();
		surface.suspend(&mut out).unwrap();
		tern.read(&out);
		assert_eq!(tern.closes.len(), 1, "the cover would hide what the cell renderer paints");
		assert_eq!(tern.closes[0].1, Closed::Discarded);
		assert!(tern.doc(SURFACE_ID).suspended());

		out.clear();
		surface.resume(&mut out).unwrap();
		surface
			.present_cover(&mut out, Some(&view("settings")))
			.unwrap();
		surface.close(&mut out, true).unwrap();
		tern.read(&out);
		let closed: Vec<_> = tern
			.closes
			.iter()
			.map(|(close, _)| close.id.as_str())
			.collect();
		assert_eq!(closed, [COVER_ID, COVER_ID, SURFACE_ID]);
		assert_eq!(tern.closes[2].1, Closed::Kept);
	}

	#[test]
	fn a_flow_surface_needs_the_terminal_flow_feature() {
		let mut surface = Surface::new(hello(&[]), SurfaceMode::Flow, false);
		let mut out = Vec::new();
		let blocks = [make_block(1, BlockKind::Assistant, "Done", true)];
		let error = surface
			.present(&mut out, &blocks, "", 0, "", Duration::ZERO, TspStreamPacing::Raw)
			.unwrap_err();
		assert_eq!(error.kind(), io::ErrorKind::Unsupported);
		assert!(out.is_empty(), "nothing is written for a mode the terminal lacks");
	}

	#[test]
	fn a_flow_surface_prints_its_blocks_without_chrome_and_never_waits_for_credits() {
		let mut surface = Surface::new(hello(&["flow"]), SurfaceMode::Flow, true);
		let mut tern = Tern::default();
		let mut out = Vec::new();
		for count in 1..=4_u64 {
			let blocks: Vec<_> = (1..=count)
				.map(|key| make_block(key, BlockKind::Assistant, "line", true))
				.collect();
			session_present(&mut surface, &mut out, &blocks);
		}
		tern.read(&out);
		let [open] = tern.opens.as_slice() else {
			panic!("one surface opens: {:?}", tern.opens);
		};
		assert_eq!(open.mode, SurfaceMode::Flow);
		assert_eq!(open.listen, Some(false));
		assert_eq!(open.adopt, None, "only an inline surface adopts");
		assert_eq!(open.role, None);
		assert_eq!(tern.frames, 4, "no acknowledgement is owed, so frames never wait for credits");
		let doc = tern.doc(SURFACE_ID);
		assert!((1..=4).all(|key| doc.contains(&block_id(key)) && doc.is_settled(&block_id(key))));
		assert!(
			!doc.contains(COMPOSER_ID) && !doc.contains(STATUS_ID),
			"a flow surface has no session chrome"
		);

		out.clear();
		surface.close(&mut out, true).unwrap();
		tern.read(&out);
		assert_eq!(tern.closes[0].1, Closed::Kept);
		let kept = &tern.kept[0];
		assert!(
			kept.contains(MAIN_ID) && kept.contains(&block_id(4)),
			"command output stays in the scrollback"
		);
		assert!(!kept.contains(DOCK_ID));
	}

	#[test]
	fn a_screen_surface_never_adopts_and_is_discarded_on_close() {
		let mut surface = Surface::new(hello(&[]), SurfaceMode::Screen, true);
		let mut tern = Tern::default();
		let mut out = Vec::new();
		let blocks = [make_block(1, BlockKind::User, "hi", true)];
		session_present(&mut surface, &mut out, &blocks);
		tern.read(&out);
		let [open] = tern.opens.as_slice() else {
			panic!("one surface opens: {:?}", tern.opens);
		};
		assert_eq!(open.mode, SurfaceMode::Screen);
		assert_eq!(open.adopt, None);
		assert_eq!(open.listen, Some(true));
		assert!(tern.doc(SURFACE_ID).contains(MAIN_ID) && tern.doc(SURFACE_ID).contains(COMPOSER_ID));

		out.clear();
		surface.close(&mut out, true).unwrap();
		tern.read(&out);
		let (close, closed) = &tern.closes[0];
		assert!(!close.keep, "a screen surface is discarded whatever keep says");
		assert_eq!(*closed, Closed::Discarded);

		surface.reenter(true);
		out.clear();
		session_present(&mut surface, &mut out, &blocks);
		tern.read(&out);
		assert_eq!(tern.opens[1].adopt, None, "re-entry does not adopt a screen surface");
		assert!(
			tern.doc(SURFACE_ID).contains(&block_id(1)),
			"the blocks mount again in the new surface"
		);
	}

	#[test]
	fn a_view_is_drawn_only_when_every_kind_in_it_is() {
		let mut narrow = hello(&[]);
		narrow.kinds = ["col", "el"].map(Str::new_static).into_iter().collect();
		let surface = Surface::new(narrow, SurfaceMode::Inline, false);
		assert!(surface.draws(&view("settings")));
		let picker =
			Node { id: Str::new_static("p"), k: Kind::Picker, p: Map::new(), c: Vec::new() };
		assert!(!surface.draws(&picker));
		let nested =
			Node { id: Str::new_static("f"), k: Kind::El, p: Map::new(), c: vec![picker] };
		assert!(!surface.draws(&nested), "one kind the terminal lacks keeps the whole view in cells");
	}

	fn ack(surface: &mut Surface, s: u64) {
		surface.incoming(Incoming::Event(Event::Ack { sf: Str::new_static(SURFACE_ID), s }));
	}

	/// The composer's `sendable` prop as Tern holds it.
	fn sendable_in(tern: &Tern) -> Option<Value> {
		tern
			.doc(SURFACE_ID)
			.get(COMPOSER_ID)
			.and_then(|composer| composer.p.get("sendable").cloned())
	}

	#[test]
	fn the_composer_is_sendable_exactly_while_the_host_says_so() {
		let mut surface = Surface::optimistic(false);
		let mut tern = Tern::default();
		let mut out = Vec::new();
		session_present(&mut surface, &mut out, &[]);
		tern.read(&out);
		assert_eq!(sendable_in(&tern), None, "a composer that is not ready omits the prop");

		surface.set_sendable(true);
		ack(&mut surface, 1);
		out.clear();
		session_present(&mut surface, &mut out, &[]);
		tern.read(&out);
		assert_eq!(sendable_in(&tern), Some(Value::Bool(true)), "ready: one `set` away");

		ack(&mut surface, 2);
		out.clear();
		session_present(&mut surface, &mut out, &[]);
		assert!(out.is_empty(), "an unchanged verdict is not resent");

		surface.set_sendable(false);
		session_present(&mut surface, &mut out, &[]);
		tern.read(&out);
		assert_eq!(sendable_in(&tern), Some(Value::Bool(false)), "an approval or modal withdraws it");

		// A composer that mounts, or mounts again, carries the current verdict.
		surface.set_sendable(true);
		surface.incoming(Incoming::Event(Event::Gone {
			sf:  None,
			ids: vec![Str::new_static(SURFACE_ID)],
		}));
		let mut remounted = Tern::default();
		out.clear();
		session_present(&mut surface, &mut out, &[]);
		remounted.read(&out);
		assert_eq!(sendable_in(&remounted), Some(Value::Bool(true)));
	}

	#[test]
	fn a_send_addresses_only_the_live_session_composer() {
		let mut surface = Surface::optimistic(false);
		assert!(
			!surface.addresses_composer(SURFACE_ID, COMPOSER_ID),
			"nothing is mounted before the first frame"
		);
		let mut out = Vec::new();
		session_present(&mut surface, &mut out, &[]);
		assert!(surface.addresses_composer(SURFACE_ID, COMPOSER_ID));
		assert!(!surface.addresses_composer(COVER_ID, COMPOSER_ID), "another surface's id is stale");
		assert!(!surface.addresses_composer(SURFACE_ID, STATUS_ID), "only the editor takes a send");
		assert!(!surface.addresses_composer(SURFACE_ID, "composer-2"), "an invented id is stale");

		surface.suspend(&mut out).unwrap();
		assert!(
			!surface.addresses_composer(SURFACE_ID, COMPOSER_ID),
			"the cell overlay owns the keys while the surface is suspended"
		);
		ack(&mut surface, 1);
		surface.resume(&mut out).unwrap();
		assert!(surface.addresses_composer(SURFACE_ID, COMPOSER_ID));

		surface.incoming(Incoming::Event(Event::Gone {
			sf:  Some(Str::new_static(SURFACE_ID)),
			ids: vec![Str::new_static(COMPOSER_ID)],
		}));
		assert!(
			!surface.addresses_composer(SURFACE_ID, COMPOSER_ID),
			"a composer Tern dropped is gone until it mounts again"
		);

		let mut flow = Surface::new(hello(&["flow"]), SurfaceMode::Flow, false);
		session_present(&mut flow, &mut out, &[make_block(1, BlockKind::Assistant, "x", true)]);
		assert!(
			!flow.addresses_composer(SURFACE_ID, COMPOSER_ID),
			"a flow surface mounts no composer"
		);
	}

	#[test]
	fn rows_are_counted_where_they_are_added_at_any_depth() {
		let rows = |id: &'static str| Node {
			id: Str::new_static(id),
			k:  Kind::Rows,
			p:  Map::new(),
			c:  Vec::new(),
		};
		let card = Node {
			id: Str::new_static("card"),
			k:  Kind::Card,
			p:  Map::new(),
			c:  vec![rows("inner"), rows("inner-2")],
		};
		let ops = [
			add_node(rows("top"), MAIN_ID),
			add_node(card, MAIN_ID),
			Op::Set { id: Str::new_static("top"), props: Map::new() },
			Op::Del(Str::new_static("gone")),
		];
		assert_eq!(rows_added(&ops), 3, "a set or a delete adds nothing; children count");
		assert_eq!(rows_added(&[]), 0);
	}

	/// What the frame log said: surface, sequence number and `rows` per event.
	#[derive(Clone, Default)]
	struct FrameLog(Arc<Mutex<Vec<(String, u64, u64)>>>);

	#[derive(Default)]
	struct FrameFields {
		surface: String,
		seq:     u64,
		rows:    Option<u64>,
	}

	impl Visit for FrameFields {
		fn record_str(&mut self, field: &Field, value: &str) {
			if field.name() == "surface" {
				self.surface = value.to_owned();
			}
		}

		fn record_u64(&mut self, field: &Field, value: u64) {
			match field.name() {
				"seq" => self.seq = value,
				"rows" => self.rows = Some(value),
				_ => {},
			}
		}

		fn record_debug(&mut self, _: &Field, _: &dyn fmt::Debug) {}
	}

	impl<S: Subscriber> Layer<S> for FrameLog {
		fn on_event(&self, event: &tracing::Event<'_>, _: Context<'_, S>) {
			let mut fields = FrameFields::default();
			event.record(&mut fields);
			if let Some(rows) = fields.rows {
				self.0.lock().push((fields.surface, fields.seq, rows));
			}
		}
	}

	#[test]
	fn every_frame_logs_how_many_of_its_nodes_fell_back_to_rows() {
		// A Tern that draws no `md`: assistant text can only be `rows`.
		let mut narrow = hello(&[]);
		narrow.kinds.retain(|kind| kind.as_str() != "md");
		let mut surface = Surface::new(narrow, SurfaceMode::Inline, false);
		let log = FrameLog::default();
		let subscriber = registry().with(log.clone());
		tracing::subscriber::with_default(subscriber, || {
			let mut out = Vec::new();
			let blocks = [
				make_block(1, BlockKind::Assistant, "one", true),
				make_block(2, BlockKind::User, "two", true),
				make_block(3, BlockKind::Assistant, "three", true),
			];
			session_present(&mut surface, &mut out, &blocks);
			ack(&mut surface, 1);
			let more = [
				make_block(1, BlockKind::Assistant, "one", true),
				make_block(2, BlockKind::User, "two", true),
				make_block(3, BlockKind::Assistant, "three", true),
				make_block(4, BlockKind::Assistant, "four", true),
			];
			session_present(&mut surface, &mut out, &more);
			ack(&mut surface, 2);
			surface
				.present(&mut out, &more, "typing", 6, "ok", Duration::ZERO, TspStreamPacing::Raw)
				.unwrap();
		});
		let frames = log.0.lock().clone();
		assert_eq!(
			frames,
			[
				(SURFACE_ID.to_owned(), 1, 2),
				(SURFACE_ID.to_owned(), 2, 1),
				(SURFACE_ID.to_owned(), 3, 0),
			],
			"two assistant blocks fell back in the first frame, one in the second, none in the third"
		);
	}
}
