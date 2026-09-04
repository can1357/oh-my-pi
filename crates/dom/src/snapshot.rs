use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::{Handle, KnownTag, Node, Sid, Tag, Value, stream::SnapshotStream};

/// Largest allocator high-water mark accepted from an untrusted replica
/// snapshot. A canonical snapshot cannot describe more live nodes than its
/// encoded bytes, but removed handles make the allocator intentionally sparse.
pub const SNAPSHOT_HIGH_WATER_LIMIT: u64 = 1_048_576;

#[derive(Serialize)]
struct Canonical<'a> {
	high_water: u64,
	next_sid:   Sid,
	nodes:      &'a [CanonicalNode],
	streams:    &'a [SnapshotStream],
}

#[derive(Deserialize, Serialize)]
struct CanonicalNode {
	handle: Handle,
	parent: Option<Handle>,
	node:   Node,
}

#[derive(Deserialize)]
struct EncodedSnapshot {
	high_water: u64,
	next_sid:   Sid,
	nodes:      Vec<CanonicalNode>,
	streams:    Vec<SnapshotStream>,
}

/// Failure to decode an untrusted canonical session snapshot.
#[derive(Debug, Error)]
pub enum SnapshotDecodeError {
	/// The canonical JSON encoding was malformed.
	#[error("session snapshot JSON was malformed")]
	Json(#[from] serde_json::Error),
	/// The snapshot requested an allocator range too large to materialize.
	#[error("session snapshot high-water mark {actual} exceeds limit {limit}")]
	HighWater {
		/// Encoded high-water mark.
		actual: u64,
		/// Maximum accepted high-water mark.
		limit:  u64,
	},
	/// A node or parent handle fell outside the declared allocator range.
	#[error("session snapshot handle {handle} exceeds high-water mark {high_water}")]
	HandleOutOfRange {
		/// Invalid handle.
		handle:     u64,
		/// Declared high-water mark.
		high_water: u64,
	},
	/// Two encoded nodes claimed the same stable handle.
	#[error("session snapshot repeats handle {handle}")]
	DuplicateHandle {
		/// Repeated handle.
		handle: u64,
	},
	/// Node children, parents, or open streams were internally inconsistent.
	#[error("session snapshot tree structure was inconsistent")]
	InconsistentStructure,
}

/// Deterministic, self-contained image of a materialized session tree.
///
/// Equality compares canonical bytes, including the handle high-water mark.
#[derive(Clone, Debug)]
pub struct Snapshot {
	pub(crate) high_water: u64,
	pub(crate) next_sid:   Sid,
	pub(crate) nodes:      Vec<Option<Node>>,
	pub(crate) parents:    Vec<Option<Handle>>,
	pub(crate) streams:    Vec<SnapshotStream>,
	bytes:                 Vec<u8>,
}

impl Snapshot {
	/// Decodes and validates canonical bytes received by a session-tree
	/// replica.
	pub fn from_bytes(bytes: &[u8]) -> Result<Self, SnapshotDecodeError> {
		let encoded: EncodedSnapshot = serde_json::from_slice(bytes)?;
		if encoded.high_water > SNAPSHOT_HIGH_WATER_LIMIT {
			return Err(SnapshotDecodeError::HighWater {
				actual: encoded.high_water,
				limit:  SNAPSHOT_HIGH_WATER_LIMIT,
			});
		}
		let high_water = encoded.high_water.max(4);
		let slots =
			usize::try_from(high_water.saturating_add(1)).expect("bounded high-water fits usize");
		let mut nodes = vec![None; slots];
		let mut parents = vec![None; slots];
		for encoded_node in encoded.nodes {
			let raw = encoded_node.handle.get();
			if raw > high_water {
				return Err(SnapshotDecodeError::HandleOutOfRange { handle: raw, high_water });
			}
			let index = raw as usize;
			if nodes[index].is_some() {
				return Err(SnapshotDecodeError::DuplicateHandle { handle: raw });
			}
			if let Some(parent) = encoded_node.parent {
				if parent.get() > high_water {
					return Err(SnapshotDecodeError::HandleOutOfRange {
						handle: parent.get(),
						high_water,
					});
				}
				parents[index] = Some(parent);
			}
			nodes[index] = Some(encoded_node.node);
		}
		let canonical_roots = [
			(1, KnownTag::Session, None),
			(2, KnownTag::Meta, Handle::new(1)),
			(3, KnownTag::Body, Handle::new(1)),
			(4, KnownTag::Queues, Handle::new(1)),
		];
		for (index, tag, parent) in canonical_roots {
			let Some(node) = nodes.get(index).and_then(Option::as_ref) else {
				return Err(SnapshotDecodeError::InconsistentStructure);
			};
			if node.tag != Tag::Known(tag) || parents[index] != parent {
				return Err(SnapshotDecodeError::InconsistentStructure);
			}
		}
		let expected_root_children = [
			Handle::new(2).expect("canonical handle"),
			Handle::new(3).expect("canonical handle"),
			Handle::new(4).expect("canonical handle"),
		];
		if nodes[1]
			.as_ref()
			.is_none_or(|root| root.kids.as_slice() != expected_root_children)
		{
			return Err(SnapshotDecodeError::InconsistentStructure);
		}
		for (index, node) in nodes.iter().enumerate().skip(1) {
			let Some(node) = node else {
				continue;
			};
			let handle = Handle::new(index as u64).expect("nonzero enumerated handle");
			for child in &node.kids {
				let child_index = child.get() as usize;
				if nodes.get(child_index).and_then(Option::as_ref).is_none()
					|| parents.get(child_index).copied().flatten() != Some(handle)
				{
					return Err(SnapshotDecodeError::InconsistentStructure);
				}
			}
			if let Some(parent) = parents[index]
				&& nodes
					.get(parent.get() as usize)
					.and_then(Option::as_ref)
					.is_none()
			{
				return Err(SnapshotDecodeError::InconsistentStructure);
			}
		}
		for stream in &encoded.streams {
			if nodes
				.get(stream.node.get() as usize)
				.and_then(Option::as_ref)
				.is_none()
			{
				return Err(SnapshotDecodeError::InconsistentStructure);
			}
		}
		Ok(Self::build(high_water, encoded.next_sid, nodes, parents, encoded.streams))
	}

	pub(crate) fn build(
		high_water: u64,
		next_sid: Sid,
		mut nodes: Vec<Option<Node>>,
		parents: Vec<Option<Handle>>,
		streams: Vec<SnapshotStream>,
	) -> Self {
		for stream in &streams {
			if let Some(node) = slot_mut(&mut nodes, stream.node) {
				node.set_prop(stream.prop.clone(), Value::Str(stream.text.clone()));
			}
		}
		let mut canonical_nodes = Vec::new();
		for raw in 1..=high_water {
			let Some(handle) = Handle::new(raw) else {
				continue;
			};
			let Some(mut node) = slot(&nodes, handle).cloned() else {
				continue;
			};
			node.props.sort_by(|left, right| left.0.cmp(&right.0));
			canonical_nodes.push(CanonicalNode {
				handle,
				parent: parents.get(raw as usize).copied().flatten(),
				node,
			});
		}
		let bytes = serde_json::to_vec(&Canonical {
			high_water,
			next_sid,
			nodes: &canonical_nodes,
			streams: &streams,
		})
		.expect("DOM snapshot values are always JSON serializable");
		Self { high_water, next_sid, nodes, parents, streams, bytes }
	}

	/// Returns the canonical serialized bytes.
	#[must_use]
	pub fn as_bytes(&self) -> &[u8] {
		&self.bytes
	}

	/// Consumes the snapshot and returns its canonical bytes.
	#[must_use]
	pub fn into_bytes(self) -> Vec<u8> {
		self.bytes
	}

	/// Returns the largest handle ever minted.
	#[must_use]
	pub const fn high_water(&self) -> u64 {
		self.high_water
	}

	/// Returns the next stream id that will be allocated.
	#[must_use]
	pub const fn next_sid(&self) -> Sid {
		self.next_sid
	}

	/// Looks up a materialized node.
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
}

impl PartialEq for Snapshot {
	fn eq(&self, other: &Self) -> bool {
		self.bytes == other.bytes
	}
}

impl Eq for Snapshot {}

pub fn slot(nodes: &[Option<Node>], handle: Handle) -> Option<&Node> {
	nodes.get(handle.get() as usize)?.as_ref()
}

pub fn slot_mut(nodes: &mut [Option<Node>], handle: Handle) -> Option<&mut Node> {
	nodes.get_mut(handle.get() as usize)?.as_mut()
}
