//! Lifecycle work derived from two authoritative DOM snapshots.

use omp_core::{FastHashMap, Str};
use omp_dom::{Handle, KnownTag, PropId, PropKey, Snapshot, Tag, Value};

/// Spawn and termination work implied by a session-tree transition.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct LifecycleWork {
	/// Removed `<subagent>`, `<job>`, and running tool-call handles to
	/// terminate.
	pub terminate: Vec<Handle>,
	/// Added `<subagent>`, `<job>`, and running tool-call handles to spawn or
	/// resume.
	pub spawn:     Vec<Handle>,
	/// Durable identities retained across re-derivation as `(old, new)` handles.
	pub retained:  Vec<(Handle, Handle)>,
}

/// Diffs lifecycle-bearing elements between two snapshots by durable identity.
///
/// Lifecycle-bearing elements are `<subagent>` and `<job>` members of the job
/// primitive plus every tool-call element still in `arguments` or `running`
/// status (ADR 0004: a disappeared tool call is termination work too).
///
/// Reminting a handle during re-derivation does not terminate and respawn the
/// underlying job or subagent. Such nodes appear in [`LifecycleWork::retained`]
/// instead. Nodes without `id` or `cause` use their handle as a last-resort
/// identity and therefore cannot be recognized across reminting.
#[must_use]
pub fn diff(before: &Snapshot, after: &Snapshot) -> LifecycleWork {
	let before_live = lifecycle_nodes(before);
	let mut after_live = lifecycle_nodes(after);
	let mut terminate = Vec::new();
	let mut retained = Vec::new();
	for (identity, old_handle) in before_live {
		if let Some(new_handle) = after_live.remove(&identity) {
			retained.push((old_handle, new_handle));
		} else {
			terminate.push(old_handle);
		}
	}
	let mut spawn: Vec<_> = after_live.into_values().collect();
	terminate.sort_unstable();
	spawn.sort_unstable();
	retained.sort_unstable();
	LifecycleWork { terminate, spawn, retained }
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct LifecycleId {
	tag: Tag,
	id:  Str,
}

fn lifecycle_nodes(snapshot: &Snapshot) -> FastHashMap<LifecycleId, Handle> {
	snapshot
		.handles()
		.filter_map(|handle| {
			let node = snapshot.get(handle)?;
			let identity = match &node.tag {
				Tag::Known(KnownTag::Subagent | KnownTag::Job) => node
					.prop(&PropKey::from(PropId::Id))
					.or_else(|| node.prop(&PropKey::from(PropId::Cause))),
				Tag::Custom(_) => {
					let running = node
						.prop(&PropKey::from(PropId::Status))
						.and_then(Value::as_str)
						.is_some_and(|status| matches!(status, "arguments" | "running"));
					// A tool call's journal cause, unlike its provider-supplied
					// call id, is unique and is the handle execution registries
					// use to make lifecycle work actionable.
					if !running {
						return None;
					}
					let cause = node.prop(&PropKey::from(PropId::Cause))?;
					Some(cause)
				},
				Tag::Known(_) => return None,
			};
			let id = identity
				.and_then(Value::as_str)
				.map_or_else(|| Str::new(handle.to_string()), Str::new);
			Some((LifecycleId { tag: node.tag.clone(), id }, handle))
		})
		.collect()
}
