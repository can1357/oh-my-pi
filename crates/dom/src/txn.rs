use omp_core::{FastHashMap, FastHashSet, Str, StrMut};
use omp_journal::EntryId;
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::{
	Event, Handle, KnownTag, Node, Op, Patch, PropKey, Sid, Snapshot, StreamOp, Tag, Value,
	selector,
	snapshot::{slot, slot_mut},
	stream::{OpenStream, SnapshotStream},
};

const ROOT: Handle = Handle::new(1).expect("one is nonzero");
const META: Handle = Handle::new(2).expect("two is nonzero");
const BODY: Handle = Handle::new(3).expect("three is nonzero");
const QUEUES: Handle = Handle::new(4).expect("four is nonzero");

/// A group of operations committed atomically.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct Txn {
	/// Journal entry that caused the transaction.
	pub cause: EntryId,
	/// Optional semantic label.
	pub label: Option<Str>,
	/// Ordered operations.
	pub ops:   Vec<Op>,
}

/// Result of a successful transaction.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct Applied {
	/// Handles minted by insertion operations, in operation order.
	pub minted: Vec<Handle>,
}

/// A rejected DOM or stream mutation.
#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum DomError {
	/// An operation references a node that does not exist in its post-state.
	#[error("operation {op_index} references missing handle {handle}")]
	MissingHandle {
		/// Operation index.
		op_index: usize,
		/// Missing handle.
		handle:   Handle,
	},
	/// An operation would violate the fixed session/meta/body/queues topology.
	#[error(
		"operation {op_index} places or mutates {tag} handle {handle} outside the fixed topology"
	)]
	Topology {
		/// Operation index.
		op_index: usize,
		/// Node being placed or mutated.
		handle:   Handle,
		/// Node tag.
		tag:      Tag,
	},
	/// An insertion/move anchor is not a child of its declared parent.
	#[error("operation {op_index} uses handle {after} as an anchor outside parent {parent}")]
	BadAnchor {
		/// Operation index.
		op_index: usize,
		/// Declared parent.
		parent:   Handle,
		/// Invalid anchor.
		after:    Handle,
	},
	/// A move would make a node its own ancestor.
	#[error("operation {op_index} moving {handle} under {parent} would create a cycle")]
	Cycle {
		/// Operation index.
		op_index: usize,
		/// Moved handle.
		handle:   Handle,
		/// Proposed parent.
		parent:   Handle,
	},
	/// A stream event has fields inconsistent with its discriminator.
	#[error("stream {sid} has a malformed event payload")]
	MalformedStream {
		/// Stream identity.
		sid: Sid,
	},
	/// A stream identity is already open.
	#[error("stream {sid} is already open")]
	StreamAlreadyOpen {
		/// Stream identity.
		sid: Sid,
	},
	/// A closed stream identity cannot be reused.
	#[error("stream {sid} is below the allocation high-water mark and cannot be reused")]
	ReusedStream {
		/// Reused stream identity.
		sid: Sid,
	},
	/// A stream identity is not open.
	#[error("stream {sid} is not open")]
	MissingStream {
		/// Stream identity.
		sid: Sid,
	},
	/// An open stream can bind only an absent or textual property.
	#[error("stream target property {prop} on handle {handle} is not text")]
	NonTextStreamTarget {
		/// Target handle.
		handle: Handle,
		/// Target property.
		prop:   PropKey,
	},
}

/// The authoritative materialized session tree.
pub struct Dom {
	pub(crate) nodes:   Vec<Option<Node>>,
	pub(crate) parents: Vec<Option<Handle>>,
	high_water:         u64,
	streams:            FastHashMap<Sid, OpenStream>,
	next_sid:           Sid,
	subscribers:        Vec<flume::Sender<Event>>,
}

impl Default for Dom {
	fn default() -> Self {
		Self::new()
	}
}

impl Dom {
	/// Creates `<session><meta/><body/><queues/></session>` with handles 1–4.
	#[must_use]
	pub fn new() -> Self {
		Self::with_high_water(4)
	}

	/// Creates the canonical root while preserving an allocator high-water mark.
	#[must_use]
	pub fn with_high_water(high_water: u64) -> Self {
		let high_water = high_water.max(4);
		let mut nodes = vec![None; high_water as usize + 1];
		let mut parents = vec![None; high_water as usize + 1];
		nodes[ROOT.get() as usize] = Some(Node {
			tag:     KnownTag::Session.into(),
			props:   Default::default(),
			kids:    vec![META, BODY, QUEUES],
			content: None,
		});
		for (handle, tag) in
			[(META, KnownTag::Meta), (BODY, KnownTag::Body), (QUEUES, KnownTag::Queues)]
		{
			nodes[handle.get() as usize] = Some(Node {
				tag:     tag.into(),
				props:   Default::default(),
				kids:    Vec::new(),
				content: None,
			});
			parents[handle.get() as usize] = Some(ROOT);
		}
		Self {
			nodes,
			parents,
			high_water,
			streams: FastHashMap::default(),
			next_sid: 1,
			subscribers: Vec::new(),
		}
	}

	/// Reconstructs a DOM from a snapshot, including open stream bindings.
	#[must_use]
	pub fn from_snapshot(snapshot: &Snapshot) -> Self {
		let streams = snapshot
			.streams
			.iter()
			.cloned()
			.map(|stream| {
				let sid = stream.sid;
				(sid, OpenStream {
					node:           stream.node,
					prop:           stream.prop,
					text:           StrMut::new(stream.text.as_str()),
					appended_bytes: stream.appended_bytes,
				})
			})
			.collect::<FastHashMap<_, _>>();
		let next_sid = snapshot.next_sid;
		Self {
			nodes: snapshot.nodes.clone(),
			parents: snapshot.parents.clone(),
			high_water: snapshot.high_water,
			streams,
			next_sid,
			subscribers: Vec::new(),
		}
	}

	/// Returns the session root handle.
	#[must_use]
	pub const fn root(&self) -> Handle {
		ROOT
	}

	/// Returns the metadata subtree handle.
	#[must_use]
	pub const fn meta(&self) -> Handle {
		META
	}

	/// Returns the transcript body handle.
	#[must_use]
	pub const fn body(&self) -> Handle {
		BODY
	}

	/// Returns the controller queues handle.
	#[must_use]
	pub const fn queues(&self) -> Handle {
		QUEUES
	}

	/// Returns the largest handle ever minted.
	#[must_use]
	pub const fn high_water(&self) -> u64 {
		self.high_water
	}

	/// Raises the allocator floor without changing any live handle.
	///
	/// Re-derivation first replays from canonical root handles so recorded
	/// operations address their original nodes, then calls this method with
	/// the pre-rewind high-water mark to prevent later handle reuse.
	pub fn raise_high_water(&mut self, high_water: u64) {
		if high_water <= self.high_water {
			return;
		}
		let required = high_water as usize + 1;
		self.nodes.resize_with(required, || None);
		self.parents.resize(required, None);
		self.high_water = high_water;
	}

	/// Raises the stream allocator floor without changing open streams.
	pub fn raise_stream_high_water(&mut self, next_sid: Sid) {
		self.next_sid = self.next_sid.max(next_sid).max(1);
	}

	/// Looks up a node by handle.
	#[must_use]
	pub fn get(&self, handle: Handle) -> Option<&Node> {
		slot(&self.nodes, handle)
	}

	/// Returns a node's children, or an empty slice for an unknown handle.
	#[must_use]
	pub fn children(&self, handle: Handle) -> &[Handle] {
		self.get(handle).map_or(&[], |node| node.kids.as_slice())
	}

	/// Returns a node's parent.
	#[must_use]
	pub fn parent(&self, handle: Handle) -> Option<Handle> {
		self.parents.get(handle.get() as usize).copied().flatten()
	}

	/// Iterates live handles in numeric order.
	pub fn handles(&self) -> impl Iterator<Item = Handle> + '_ {
		self
			.nodes
			.iter()
			.enumerate()
			.skip(1)
			.filter_map(|(index, node)| node.as_ref().and_then(|_| Handle::new(index as u64)))
	}

	/// Selects nodes with tag/property predicates and descendant combinators.
	pub fn select(
		&self,
		selector_source: &str,
	) -> Result<impl Iterator<Item = Handle>, crate::SelectorError> {
		selector::select(self, selector_source).map(Vec::into_iter)
	}

	/// Counts nodes matching a selector.
	pub fn count(&self, selector_source: &str) -> Result<usize, crate::SelectorError> {
		Ok(self.select(selector_source)?.count())
	}

	/// Validates a transaction through the same scratch overlay used by
	/// [`Self::apply`].
	pub fn validate(&self, txn: &Txn) -> Result<(), DomError> {
		Validation::new(self).validate(&txn.ops).map(|_| ())
	}

	/// Validates opening the next allocated stream id without mutating the DOM.
	pub fn validate_stream_open(&self, handle: Handle, prop: &PropKey) -> Result<(), DomError> {
		self.validate_stream_open_with_id(self.next_sid, handle, prop)
	}

	/// Validates opening a journal-supplied stream id without mutating the DOM.
	pub fn validate_stream_open_with_id(
		&self,
		sid: Sid,
		handle: Handle,
		prop: &PropKey,
	) -> Result<(), DomError> {
		if self.streams.contains_key(&sid) {
			return Err(DomError::StreamAlreadyOpen { sid });
		}
		if sid < self.next_sid {
			return Err(DomError::ReusedStream { sid });
		}
		let node = self
			.get(handle)
			.ok_or(DomError::MissingHandle { op_index: 0, handle })?;
		if node
			.prop(prop)
			.is_some_and(|value| !matches!(value, Value::Str(_)))
		{
			return Err(DomError::NonTextStreamTarget { handle, prop: prop.clone() });
		}
		Ok(())
	}

	/// Validates appending to an open stream without mutating the DOM.
	pub fn validate_stream_append(&self, sid: Sid) -> Result<(), DomError> {
		if self.streams.contains_key(&sid) {
			Ok(())
		} else {
			Err(DomError::MissingStream { sid })
		}
	}

	/// Validates closing an open stream without mutating the DOM.
	pub fn validate_stream_close(&self, sid: Sid) -> Result<(), DomError> {
		self.validate_stream_append(sid)
	}

	/// Applies all operations atomically after validating their sequential
	/// post-states.
	pub fn apply(&mut self, txn: &Txn) -> Result<Applied, DomError> {
		self.apply_with_prior(txn, None)
	}

	/// Applies a transaction and publishes its explicit live-chain predecessor.
	///
	/// Session replay uses this form so the first patch after a rewind carries
	/// the journal entry's branch link to subscribed actors.
	pub fn apply_with_prior(
		&mut self,
		txn: &Txn,
		prior: Option<EntryId>,
	) -> Result<Applied, DomError> {
		let validation = Validation::new(self);
		let minted = validation.validate(&txn.ops)?;
		for op in &txn.ops {
			self.apply_validated(op);
		}
		self.publish(Event::Patch(Patch {
			cause: txn.cause,
			prior,
			label: txn.label.clone(),
			ops: txn.ops.clone(),
		}));
		Ok(Applied { minted })
	}

	/// Opens an append-only stream bound to `handle.prop`.
	pub fn stream_open(
		&mut self,
		cause: EntryId,
		handle: Handle,
		prop: PropKey,
	) -> Result<Sid, DomError> {
		let sid = self.next_sid;
		self.stream_open_with_id(cause, sid, handle, prop)?;
		Ok(sid)
	}

	/// Opens a stream with a journal-supplied identity during replay.
	pub fn stream_open_with_id(
		&mut self,
		cause: EntryId,
		sid: Sid,
		handle: Handle,
		prop: PropKey,
	) -> Result<(), DomError> {
		self.validate_stream_open_with_id(sid, handle, &prop)?;
		self.open_stream_id(cause, sid, handle, prop)?;
		self.next_sid = self.next_sid.max(sid.saturating_add(1)).max(1);
		Ok(())
	}

	/// Appends one delta in amortized O(delta) work.
	pub fn stream_append(&mut self, cause: EntryId, sid: Sid, text: &str) -> Result<(), DomError> {
		self.validate_stream_append(sid)?;
		let stream = self.streams.get_mut(&sid).expect("validated stream exists");
		stream.text.push_str(text);
		stream.appended_bytes += text.len();
		self.publish(Event::Stream {
			cause,
			sid,
			op: StreamOp::Append,
			node: None,
			prop: None,
			text: Some(Str::new(text)),
		});
		Ok(())
	}

	/// Closes a stream and materializes its accumulated string into the node
	/// property.
	pub fn stream_close(&mut self, cause: EntryId, sid: Sid) -> Result<(), DomError> {
		self.validate_stream_close(sid)?;
		let stream = self.streams.remove(&sid).expect("validated stream exists");
		let node = slot_mut(&mut self.nodes, stream.node)
			.ok_or(DomError::MissingHandle { op_index: 0, handle: stream.node })?;
		node.set_prop(stream.prop, Value::Str(stream.text.freeze()));
		self.publish(Event::Stream {
			cause,
			sid,
			op: StreamOp::Close,
			node: None,
			prop: None,
			text: None,
		});
		Ok(())
	}

	/// Returns the number of delta bytes copied into one open stream buffer.
	///
	/// This structural counter excludes snapshots and proves append work scales
	/// with incoming deltas rather than accumulated content.
	#[must_use]
	pub fn stream_appended_bytes(&self, sid: Sid) -> Option<usize> {
		self.streams.get(&sid).map(|stream| stream.appended_bytes)
	}

	/// Returns the accumulated text of the open stream bound to `handle.prop`,
	/// if one is open. Projections read this to show streaming content before
	/// [`Dom::stream_close`] materializes it into the property.
	#[must_use]
	pub fn stream_text(&self, handle: Handle, prop: &PropKey) -> Option<&str> {
		self
			.streams
			.values()
			.find(|stream| stream.node == handle && stream.prop == *prop)
			.map(|stream| stream.text.as_str())
	}

	/// Creates a canonical snapshot, materializing open stream buffers in the
	/// image.
	#[must_use]
	pub fn snapshot(&self) -> Snapshot {
		let mut streams = self
			.streams
			.iter()
			.map(|(&sid, stream)| SnapshotStream {
				sid,
				node: stream.node,
				prop: stream.prop.clone(),
				text: Str::new(stream.text.as_str()),
				appended_bytes: stream.appended_bytes,
			})
			.collect::<Vec<_>>();
		streams.sort_by_key(|stream| stream.sid);
		Snapshot::build(
			self.high_water,
			self.next_sid,
			self.nodes.clone(),
			self.parents.clone(),
			streams,
		)
	}

	/// Subscribes an actor to a snapshot followed by lossless ordered events.
	pub fn subscribe(&mut self) -> (Snapshot, flume::Receiver<Event>) {
		let snapshot = self.snapshot();
		let (sender, receiver) = flume::unbounded();
		self.subscribers.push(sender);
		(snapshot, receiver)
	}

	/// Replaces materialized state and tells existing replicas to reset
	/// atomically.
	pub fn reset(&mut self, snapshot: Snapshot) {
		let replacement = Self::from_snapshot(&snapshot);
		self.nodes = replacement.nodes;
		self.parents = replacement.parents;
		self.high_water = replacement.high_water;
		self.streams = replacement.streams;
		self.next_sid = replacement.next_sid;
		self.publish(Event::Reset { snapshot });
	}

	/// Applies one subscription event to a replica.
	pub fn apply_event(&mut self, event: &Event) -> Result<(), DomError> {
		match event {
			Event::Patch(patch) => {
				let txn =
					Txn { cause: patch.cause, label: patch.label.clone(), ops: patch.ops.clone() };
				self.apply_with_prior(&txn, patch.prior)?;
			},
			Event::Reset { snapshot } => self.reset(snapshot.clone()),
			Event::Stream { cause, sid, op, node, prop, text } => match op {
				StreamOp::Open => {
					let (Some(node), Some(prop), None) = (node, prop, text) else {
						return Err(DomError::MalformedStream { sid: *sid });
					};
					self.stream_open_with_id(*cause, *sid, *node, prop.clone())?;
				},
				StreamOp::Append => {
					if node.is_some() || prop.is_some() {
						return Err(DomError::MalformedStream { sid: *sid });
					}
					let Some(text) = text else {
						return Err(DomError::MalformedStream { sid: *sid });
					};
					self.stream_append(*cause, *sid, text.as_str())?;
				},
				StreamOp::Close => {
					if node.is_some() || prop.is_some() || text.is_some() {
						return Err(DomError::MalformedStream { sid: *sid });
					}
					self.stream_close(*cause, *sid)?;
				},
			},
		}
		Ok(())
	}

	fn open_stream_id(
		&mut self,
		cause: EntryId,
		sid: Sid,
		handle: Handle,
		prop: PropKey,
	) -> Result<(), DomError> {
		let node = self.get(handle).expect("stream target was validated");
		let initial = match node.prop(&prop) {
			Some(Value::Str(text)) => StrMut::new(text.as_str()),
			None => StrMut::default(),
			Some(_) => unreachable!("stream property type was validated"),
		};
		self.streams.insert(sid, OpenStream {
			node:           handle,
			prop:           prop.clone(),
			text:           initial,
			appended_bytes: 0,
		});
		self.publish(Event::Stream {
			cause,
			sid,
			op: StreamOp::Open,
			node: Some(handle),
			prop: Some(prop),
			text: None,
		});
		Ok(())
	}

	fn publish(&mut self, event: Event) {
		self
			.subscribers
			.retain(|subscriber| subscriber.send(event.clone()).is_ok());
	}

	fn apply_validated(&mut self, op: &Op) {
		match op {
			Op::Ins { parent, after, node } => {
				self.high_water += 1;
				let handle = Handle::new(self.high_water).expect("minted DOM handles are nonzero");
				self.ensure_capacity(handle);
				self.nodes[handle.get() as usize] = Some(Node::from_spec(node.clone()));
				self.parents[handle.get() as usize] = Some(*parent);
				insert_child(
					slot_mut(&mut self.nodes, *parent).expect("validated parent"),
					*after,
					handle,
				);
			},
			Op::Rm(handle) => self.remove_subtree(*handle),
			Op::Set { h, prop, value } => {
				slot_mut(&mut self.nodes, *h)
					.expect("validated set handle")
					.set_prop(prop.clone(), value.clone());
			},
			Op::Mv { h, parent, after } => self.move_node(*h, *parent, *after),
		}
	}

	fn ensure_capacity(&mut self, handle: Handle) {
		let required = handle.get() as usize + 1;
		if self.nodes.len() < required {
			self.nodes.resize_with(required, || None);
			self.parents.resize(required, None);
		}
	}

	fn remove_subtree(&mut self, handle: Handle) {
		let parent = self.parent(handle).expect("non-root handles have parents");
		if let Some(parent_node) = slot_mut(&mut self.nodes, parent) {
			parent_node.kids.retain(|child| *child != handle);
		}
		let mut pending = vec![handle];
		while let Some(current) = pending.pop() {
			if let Some(node) = self.nodes[current.get() as usize].take() {
				pending.extend(node.kids);
			}
			self.parents[current.get() as usize] = None;
			self.streams.retain(|_, stream| stream.node != current);
		}
	}

	fn move_node(&mut self, handle: Handle, parent: Handle, after: Option<Handle>) {
		let old_parent = self.parent(handle).expect("non-root handles have parents");
		slot_mut(&mut self.nodes, old_parent)
			.expect("validated old parent")
			.kids
			.retain(|child| *child != handle);
		insert_child(slot_mut(&mut self.nodes, parent).expect("validated parent"), after, handle);
		self.parents[handle.get() as usize] = Some(parent);
	}
}

fn insert_child(parent: &mut Node, after: Option<Handle>, handle: Handle) {
	let index = after
		.and_then(|anchor| {
			parent
				.kids
				.iter()
				.position(|child| *child == anchor)
				.map(|index| index + 1)
		})
		.unwrap_or(0);
	parent.kids.insert(index, handle);
}

struct ScratchNode {
	tag:    Tag,
	parent: Option<Handle>,
	kids:   Vec<Handle>,
}

struct Validation<'a> {
	dom:        &'a Dom,
	overlay:    FastHashMap<Handle, ScratchNode>,
	removed:    FastHashSet<Handle>,
	high_water: u64,
}

impl<'a> Validation<'a> {
	fn new(dom: &'a Dom) -> Self {
		Self {
			dom,
			overlay: FastHashMap::default(),
			removed: FastHashSet::default(),
			high_water: dom.high_water,
		}
	}

	fn validate(mut self, ops: &[Op]) -> Result<Vec<Handle>, DomError> {
		let mut minted = Vec::new();
		for (op_index, op) in ops.iter().enumerate() {
			match op {
				Op::Ins { parent, after, node } => {
					self.require(*parent, op_index)?;
					self.anchor(*parent, *after, op_index)?;
					self.high_water += 1;
					let handle = Handle::new(self.high_water).expect("minted handles are nonzero");
					self.topology(*parent, handle, &node.tag, op_index)?;
					self.overlay.insert(handle, ScratchNode {
						tag:    node.tag.clone(),
						parent: Some(*parent),
						kids:   Vec::new(),
					});
					self.insert_child(*parent, *after, handle);
					minted.push(handle);
				},
				Op::Rm(handle) => {
					self.require(*handle, op_index)?;
					if self.is_fixed_root(*handle) {
						return Err(DomError::Topology {
							op_index,
							handle: *handle,
							tag: self.tag(*handle).expect("required handle has a tag"),
						});
					}
					self.remove(*handle);
				},
				Op::Set { h, .. } => self.require(*h, op_index)?,
				Op::Mv { h, parent, after } => {
					self.require(*h, op_index)?;
					self.require(*parent, op_index)?;
					let tag = self.tag(*h).expect("required handle has a tag");
					if self.is_fixed_root(*h) {
						return Err(DomError::Topology { op_index, handle: *h, tag });
					}
					self.topology(*parent, *h, &tag, op_index)?;
					if self.is_ancestor(*h, *parent) {
						return Err(DomError::Cycle { op_index, handle: *h, parent: *parent });
					}
					self.anchor(*parent, *after, op_index)?;
					if *after == Some(*h) {
						return Err(DomError::BadAnchor { op_index, parent: *parent, after: *h });
					}
					let old_parent = self
						.parent(*h)
						.expect("required non-root handle has a parent");
					self.touch(old_parent).kids.retain(|child| *child != *h);
					self.insert_child(*parent, *after, *h);
					self.touch(*h).parent = Some(*parent);
				},
			}
		}
		Ok(minted)
	}

	fn require(&self, handle: Handle, op_index: usize) -> Result<(), DomError> {
		if self.exists(handle) {
			Ok(())
		} else {
			Err(DomError::MissingHandle { op_index, handle })
		}
	}

	fn exists(&self, handle: Handle) -> bool {
		!self.removed.contains(&handle)
			&& (self.overlay.contains_key(&handle) || self.dom.get(handle).is_some())
	}

	fn tag(&self, handle: Handle) -> Option<Tag> {
		if self.removed.contains(&handle) {
			return None;
		}
		self
			.overlay
			.get(&handle)
			.map(|node| node.tag.clone())
			.or_else(|| self.dom.get(handle).map(|node| node.tag.clone()))
	}

	fn parent(&self, handle: Handle) -> Option<Handle> {
		if self.removed.contains(&handle) {
			return None;
		}
		self
			.overlay
			.get(&handle)
			.map_or_else(|| self.dom.parent(handle), |node| node.parent)
	}

	fn anchor(
		&self,
		parent: Handle,
		after: Option<Handle>,
		op_index: usize,
	) -> Result<(), DomError> {
		if let Some(after) = after {
			let present = self.overlay.get(&parent).map_or_else(
				|| self.dom.children(parent).contains(&after),
				|node| node.kids.contains(&after),
			);
			if !present || self.removed.contains(&after) {
				return Err(DomError::BadAnchor { op_index, parent, after });
			}
		}
		Ok(())
	}

	fn is_fixed_root(&self, handle: Handle) -> bool {
		if handle.get() <= QUEUES.get() {
			return true;
		}
		match (self.parent(handle), self.tag(handle)) {
			(
				Some(parent),
				Some(Tag::Known(KnownTag::Todo | KnownTag::Jobs | KnownTag::Directors | KnownTag::Con)),
			) if parent == META => true,
			(Some(parent), Some(Tag::Known(KnownTag::Steering | KnownTag::Prompts)))
				if parent == QUEUES =>
			{
				true
			},
			_ => false,
		}
	}

	fn topology(
		&self,
		parent: Handle,
		handle: Handle,
		tag: &Tag,
		op_index: usize,
	) -> Result<(), DomError> {
		let valid = if parent == ROOT {
			false
		} else if parent == BODY {
			tag == &Tag::Known(KnownTag::Turn)
		} else if parent == META {
			matches!(
				tag,
				Tag::Known(
					KnownTag::Todo
						| KnownTag::Jobs
						| KnownTag::Directors
						| KnownTag::Con
						| KnownTag::Compaction
				) | Tag::Custom(_)
			)
		} else if parent == QUEUES {
			matches!(tag, Tag::Known(KnownTag::Steering | KnownTag::Prompts))
		} else {
			true
		};
		if valid {
			Ok(())
		} else {
			Err(DomError::Topology { op_index, handle, tag: tag.clone() })
		}
	}

	fn is_ancestor(&self, ancestor: Handle, mut node: Handle) -> bool {
		loop {
			if ancestor == node {
				return true;
			}
			let Some(parent) = self.parent(node) else {
				return false;
			};
			node = parent;
		}
	}

	fn touch(&mut self, handle: Handle) -> &mut ScratchNode {
		if !self.overlay.contains_key(&handle) {
			let node = self
				.dom
				.get(handle)
				.expect("only existing nodes are touched");
			self.overlay.insert(handle, ScratchNode {
				tag:    node.tag.clone(),
				parent: self.dom.parent(handle),
				kids:   node.kids.clone(),
			});
		}
		self
			.overlay
			.get_mut(&handle)
			.expect("scratch node was inserted")
	}

	fn insert_child(&mut self, parent: Handle, after: Option<Handle>, handle: Handle) {
		let siblings = &mut self.touch(parent).kids;
		let index = after
			.and_then(|anchor| {
				siblings
					.iter()
					.position(|child| *child == anchor)
					.map(|index| index + 1)
			})
			.unwrap_or(0);
		siblings.insert(index, handle);
	}

	fn children(&self, handle: Handle) -> Vec<Handle> {
		self
			.overlay
			.get(&handle)
			.map_or_else(|| self.dom.children(handle).to_vec(), |node| node.kids.clone())
	}

	fn remove(&mut self, handle: Handle) {
		let parent = self.parent(handle).expect("non-root handles have parents");
		self.touch(parent).kids.retain(|child| *child != handle);
		let mut pending = vec![handle];
		while let Some(current) = pending.pop() {
			pending.extend(self.children(current));
			self.removed.insert(current);
		}
	}
}
