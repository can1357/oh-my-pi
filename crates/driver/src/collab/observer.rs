//! Controller-owned agent registry and transcript projections for
//! collaboration.
//!
//! Remote actors receive the same detached DOM snapshot plus ordered event
//! stream as local actors. Journal files are opened only here, on the
//! controller side, and are immediately folded through `omp-session`.

use std::{path::PathBuf, sync::Arc, time::Duration};

use omp_agent::Up;
use omp_core::Str;
use omp_dom::{Dom, Event, KnownTag, PropId, PropKey, Snapshot, Value};
use omp_proto::collab::v1::{AgentSummary, RegistrySnapshot, SessionStateUpdate, agent_summary};
use thiserror::Error;

use crate::sessions::{SessionId, SessionRegistry};

const LIVE_SUBSCRIBE_BUDGET: Duration = Duration::from_millis(750);
const REMOTE_AGENT_REGISTRY_CAP: usize = 1024;

/// A controller-derived child view suitable for any local or remote actor.
pub struct RemoteAgentView {
	/// Detached materialization at one journal point.
	pub snapshot: Snapshot,
	/// Ordered events after `snapshot`; absent for a parked child.
	pub events:   Option<flume::Receiver<Event>>,
}

/// Controller-side authority for child transcript subscriptions.
#[derive(Clone)]
pub struct HostAgentBridge {
	sessions:     Arc<SessionRegistry>,
	sessions_dir: PathBuf,
}

impl HostAgentBridge {
	/// Creates a bridge over the process routing cache and durable child
	/// journals.
	#[must_use]
	pub const fn new(sessions: Arc<SessionRegistry>, sessions_dir: PathBuf) -> Self {
		Self { sessions, sessions_dir }
	}

	/// Resolves one child to the ordinary snapshot-plus-events actor contract.
	pub async fn view(&self, id: &str) -> Result<RemoteAgentView, AgentViewError> {
		let journal = self.journal_path(id);
		if let Some(live) = self.sessions.lookup(SessionId::from_ref(id)) {
			let (reply, view) = flume::bounded(1);
			if live.up.send(Up::Subscribe(reply)).is_ok()
				&& let Ok(Ok((snapshot, events))) =
					tokio::time::timeout(LIVE_SUBSCRIBE_BUDGET, view.recv_async()).await
			{
				return Ok(RemoteAgentView { snapshot, events: Some(events) });
			}
		}
		self.parked(&journal)
	}

	fn journal_path(&self, id: &str) -> PathBuf {
		let safe = id
			.chars()
			.map(|ch| {
				if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_') {
					ch
				} else {
					'_'
				}
			})
			.collect::<String>();
		self.sessions_dir.join(format!("{safe}.oms"))
	}

	fn parked(&self, journal: &std::path::Path) -> Result<RemoteAgentView, AgentViewError> {
		if !journal.exists() {
			return Err(AgentViewError::UnknownAgent);
		}
		let session =
			omp_session::Session::open(journal, omp_session::ComponentRegistry::standard())?;
		Ok(RemoteAgentView { snapshot: session.dom().snapshot(), events: None })
	}
}

/// Stable wire refusal codes for a remote observer subscription.
#[derive(Clone, Copy, Debug, Eq, PartialEq, strum::Display, strum::EnumString)]
#[strum(serialize_all = "snake_case")]
pub enum AgentViewFailureCode {
	/// The id has no visible child.
	UnknownAgent,
	/// The controller could not materialize the child.
	Unavailable,
	/// The bounded host or guest request table is full.
	Capacity,
	/// The peer sent an invalid snapshot or event.
	InvalidProjection,
	/// The relay disconnected before a complete snapshot arrived.
	Disconnected,
}

/// Failure returned to an actor requesting a remote child view.
#[derive(Debug, Error)]
pub enum RemoteAgentViewError {
	/// Collaboration is not currently joined as a guest.
	#[error("remote agent transcripts require a guest collaboration connection")]
	NotGuest,
	/// Too many remote child views are already open.
	#[error("remote agent transcript request capacity is exhausted")]
	Capacity,
	/// The controller refused the request with a typed reason.
	#[error("remote agent transcript was refused: {code}")]
	Refused {
		/// Stable refusal classification.
		code: AgentViewFailureCode,
	},
	/// The relay disconnected before the initial snapshot completed.
	#[error("remote agent transcript disconnected before its snapshot completed")]
	Disconnected,
	/// The host projection was malformed.
	#[error("remote agent transcript projection was invalid")]
	InvalidProjection,
}

/// Failure to derive a remote observer view.
#[derive(Debug, Error)]
pub enum AgentViewError {
	/// Neither a live controller nor a durable child journal exists.
	#[error("collaboration agent does not exist")]
	UnknownAgent,
	/// A durable child journal could not be folded into its DOM.
	#[error("collaboration agent transcript could not be materialized")]
	Session(#[from] omp_session::SessionError),
}

/// Projects the host root's journal-derived jobs into the guest-visible roster.
///
/// This is a cache for presentation and routing only. Every field is rebuilt
/// from `dom` (or the root's journal-derived state projection) on each call.
#[must_use]
pub fn registry_snapshot(dom: &Dom, state: &SessionStateUpdate) -> RegistrySnapshot {
	let mut agents = vec![AgentSummary {
		id:               state.session_name.clone(),
		display_name:     "Main".to_owned(),
		kind:             agent_summary::Kind::Main as i32,
		parent_id:        None,
		status:           (if state.is_streaming {
			agent_summary::Status::Running
		} else {
			agent_summary::Status::Idle
		}) as i32,
		has_session_file: true,
		created_at_ms:    0,
		last_activity_ms: 0,
	}];
	let Some(jobs) = dom.children(dom.meta()).iter().copied().find(|handle| {
		dom.get(*handle)
			.is_some_and(|node| node.tag == omp_dom::Tag::Known(KnownTag::Jobs))
	}) else {
		return RegistrySnapshot { agents };
	};
	for node in dom
		.children(jobs)
		.iter()
		.filter_map(|handle| dom.get(*handle))
	{
		if node.tag != omp_dom::Tag::Known(KnownTag::Subagent) {
			continue;
		}
		let Some(id) = prop(node, PropId::Id) else {
			continue;
		};
		let started = custom(node, "started")
			.and_then(|value| value.parse().ok())
			.unwrap_or_default();
		let status = match prop(node, PropId::Status).as_deref() {
			Some("running") => agent_summary::Status::Running,
			Some("failed" | "aborted") => agent_summary::Status::Aborted,
			Some("completed") => agent_summary::Status::Parked,
			_ => agent_summary::Status::Idle,
		};
		if agents.len() >= REMOTE_AGENT_REGISTRY_CAP {
			break;
		}
		agents.push(AgentSummary {
			id:               id.to_string(),
			display_name:     custom(node, "agent")
				.unwrap_or_else(|| id.clone())
				.to_string(),
			kind:             agent_summary::Kind::Sub as i32,
			parent_id:        custom(node, "owner").map(|owner| owner.to_string()),
			status:           status as i32,
			has_session_file: true,
			created_at_ms:    started,
			last_activity_ms: started,
		});
	}
	agents.sort_by(|left, right| left.id.cmp(&right.id));
	RegistrySnapshot { agents }
}

fn prop(node: &omp_dom::Node, id: PropId) -> Option<Str> {
	node.prop(&id.into()).and_then(Value::as_str).map(Str::new)
}

fn custom(node: &omp_dom::Node, name: &'static str) -> Option<Str> {
	node
		.prop(&PropKey::Custom(Str::new_static(name)))
		.and_then(Value::as_str)
		.map(Str::new)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[tokio::test]
	async fn parked_transcript_is_folded_to_a_detached_observer_snapshot() {
		let directory = tempfile::tempdir().expect("tempdir");
		let path = directory.path().join("child.oms");
		let mut session =
			omp_session::Session::create(&path, omp_session::ComponentRegistry::standard())
				.expect("session");
		session.begin_turn().expect("turn");
		session
			.user(Str::new_static("inspect this"), Vec::new())
			.expect("user");
		drop(session);
		let bridge =
			HostAgentBridge::new(Arc::new(SessionRegistry::new()), directory.path().to_path_buf());
		let view = bridge.view("child").await.expect("view");
		assert!(view.events.is_none());
		let dom = Dom::from_snapshot(&view.snapshot);
		assert_eq!(dom.children(dom.body()).len(), 1);
	}

	#[test]
	fn registry_is_a_pure_projection_of_the_root_dom() {
		let dom = Dom::new();
		let state = SessionStateUpdate { session_name: "root".to_owned(), ..Default::default() };
		let first = registry_snapshot(&dom, &state);
		let second = registry_snapshot(&dom, &state);
		assert_eq!(first, second);
		assert_eq!(first.agents.len(), 1);
		assert_eq!(first.agents[0].id, "root");
	}
}
