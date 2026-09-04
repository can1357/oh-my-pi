//! Journal-derived global runtime pause state.
//!
//! The `<meta><pause>` element is the sole authority. Controllers and the
//! kernel select it from the session DOM; mailbox messages are only transport
//! for mutations while the kernel owns the session.

use std::time::{SystemTime, UNIX_EPOCH};

use omp_core::Str;
use omp_dom::{Dom, Handle, NodeSpec, Op, PropId, PropKey, Tag, Txn, Value};
use omp_session::{Session, SessionError};

const PAUSE: &str = "pause";
const PAUSED: &str = "paused";
const RUNNING: &str = "running";
const STARTED_AT_MS: &str = "started-at-ms";

/// Materialized global pause facts.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct PauseState {
	/// Whether new runtime work is held at safe points.
	pub active:        bool,
	/// Epoch millisecond at which the active hold started.
	pub started_at_ms: Option<u64>,
	/// Duration of the active hold so far, or the most recently completed hold.
	pub duration_ms:   u64,
}

/// Result of applying one idempotent pause/resume command.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PauseTransition {
	/// Whether the authoritative element changed.
	pub changed: bool,
	/// Materialized state after the command.
	pub state:   PauseState,
}

/// Selects global pause facts from the authoritative session tree.
#[must_use]
pub fn pause_state(dom: &Dom) -> PauseState {
	let Some((_, node)) = pause_node(dom) else {
		return PauseState::default();
	};
	let active = node
		.prop(&PropKey::from(PropId::Status))
		.and_then(Value::as_str)
		== Some(PAUSED);
	let started_at_ms = node
		.prop(&PropKey::Custom(Str::new_static(STARTED_AT_MS)))
		.and_then(|value| match value {
			Value::Int(value) => u64::try_from(*value).ok(),
			_ => None,
		});
	let stored_duration = node
		.prop(&PropKey::from(PropId::DurationMs))
		.and_then(|value| match value {
			Value::Int(value) => u64::try_from(*value).ok(),
			_ => None,
		})
		.unwrap_or_default();
	PauseState {
		active,
		started_at_ms,
		duration_ms: if active {
			started_at_ms.map_or(stored_duration, |started| now_ms().saturating_sub(started))
		} else {
			stored_duration
		},
	}
}

/// Journals one idempotent global pause/resume transition.
///
/// A pause requested while work is active becomes visible immediately in the
/// tree; the kernel observes it at its next safe point. Resuming records the
/// exact completed hold duration on the same element.
pub fn set_paused(session: &mut Session, active: bool) -> Result<PauseTransition, SessionError> {
	let before = pause_state(session.dom());
	if before.active == active {
		return Ok(PauseTransition { changed: false, state: before });
	}
	let now = now_ms();
	let cause = session.head().ok_or(SessionError::NoActiveTurn)?;
	let mut ops = Vec::with_capacity(3);
	if let Some((handle, _)) = pause_node(session.dom()) {
		ops.push(Op::Set {
			h:     handle,
			prop:  PropId::Status.into(),
			value: Value::Str(Str::new_static(if active { PAUSED } else { RUNNING })),
		});
		if active {
			ops.push(Op::Set {
				h:     handle,
				prop:  PropKey::Custom(Str::new_static(STARTED_AT_MS)),
				value: Value::Int(i64::try_from(now).unwrap_or(i64::MAX)),
			});
			ops.push(Op::Set {
				h:     handle,
				prop:  PropId::DurationMs.into(),
				value: Value::Int(0),
			});
		} else {
			let duration = before
				.started_at_ms
				.map_or(before.duration_ms, |started| now.saturating_sub(started));
			ops.push(Op::Set {
				h:     handle,
				prop:  PropId::DurationMs.into(),
				value: Value::Int(i64::try_from(duration).unwrap_or(i64::MAX)),
			});
		}
	} else {
		let node = NodeSpec::new(Tag::Custom(Str::new_static(PAUSE)))
			.with_prop(PropId::Status, Value::Str(Str::new_static(PAUSED)))
			.with_prop(
				PropKey::Custom(Str::new_static(STARTED_AT_MS)),
				Value::Int(i64::try_from(now).unwrap_or(i64::MAX)),
			)
			.with_prop(PropId::DurationMs, Value::Int(0));
		ops.push(Op::Ins {
			parent: session.dom().meta(),
			after: session.dom().children(session.dom().meta()).last().copied(),
			node,
		});
	}
	session.patch(Txn {
		cause,
		label: Some(Str::new_static(if active {
			"runtime.pause"
		} else {
			"runtime.resume"
		})),
		ops,
	})?;
	Ok(PauseTransition { changed: true, state: pause_state(session.dom()) })
}

fn pause_node(dom: &Dom) -> Option<(Handle, &omp_dom::Node)> {
	dom.children(dom.meta()).iter().find_map(|handle| {
		let node = dom.get(*handle)?;
		matches!(&node.tag, Tag::Custom(name) if name.as_str() == PAUSE).then_some((*handle, node))
	})
}

fn now_ms() -> u64 {
	SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.map_or(0, |duration| u64::try_from(duration.as_millis()).unwrap_or(u64::MAX))
}

#[cfg(test)]
mod tests {
	use omp_session::ComponentRegistry;

	use super::*;

	#[test]
	fn pause_is_journal_derived_and_replays() {
		let directory = tempfile::tempdir().expect("temporary directory");
		let path = directory.path().join("pause.oms");
		let mut session = Session::create(&path, ComponentRegistry::standard()).expect("session");
		assert!(!pause_state(session.dom()).active);
		assert!(set_paused(&mut session, true).expect("pause").changed);
		assert!(pause_state(session.dom()).active);
		drop(session);
		let mut replayed = Session::open(&path, ComponentRegistry::standard()).expect("replay");
		assert!(pause_state(replayed.dom()).active);
		let resumed = set_paused(&mut replayed, false).expect("resume");
		assert!(resumed.changed);
		assert!(!resumed.state.active);
		assert!(
			!set_paused(&mut replayed, false)
				.expect("idempotent resume")
				.changed
		);
	}
}
