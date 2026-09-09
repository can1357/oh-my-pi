//! Agent transcript feed behind the hub's transcript viewer (`Enter` on a
//! `/hub` row): a live child's snapshot plus its patch stream, or a parked
//! child's journal-derived snapshot (ADR 0005: the actor never reads a
//! journal; the app does it on the controller side).

use std::{path::PathBuf, time::Duration};

use omp_agent::Up;
use omp_chat::overlays::services::{AgentView, Pending, ServiceError, ServiceResult};
use omp_core::Str;
use omp_driver::sessions::SessionId;

use super::ServiceState;

/// A live kernel answers `Up::Subscribe` at its next mailbox drain; a
/// registered but silent one (its turn ended before the idle park) never
/// does, so the journal takes over after this budget.
const LIVE_SUBSCRIBE_BUDGET: Duration = Duration::from_millis(750);

/// Requests the transcript of agent `id`.
pub fn view(state: &ServiceState, id: &str) -> ServiceResult<Pending<AgentView>> {
	let (tx, rx) = flume::bounded(1);
	if state
		.collab
		.presence()
		.is_some_and(|facts| facts.role() == omp_collab::presence::CollabRole::Guest)
	{
		let collab = state.collab.clone();
		let id = Str::new(id);
		state.runtime.spawn(async move {
			let view = collab
				.observe_agent(id)
				.await
				.map(|view| AgentView { snapshot: view.snapshot, events: view.events })
				.map_err(ServiceError::failed);
			let _ = tx.send(view);
		});
		return Ok(rx);
	}
	let journal = journal_path(state, id);
	match state.sessions.lookup(SessionId::from_ref(id)) {
		Some(live) => {
			let (reply_tx, reply_rx) = flume::bounded(1);
			if live.up.send(Up::Subscribe(reply_tx)).is_err() {
				let _ = tx.send(parked(&journal));
				return Ok(rx);
			}
			state.runtime.spawn(async move {
				let view =
					match tokio::time::timeout(LIVE_SUBSCRIBE_BUDGET, reply_rx.recv_async()).await {
						Ok(Ok((snapshot, events))) => Ok(AgentView { snapshot, events: Some(events) }),
						_ => parked(&journal),
					};
				let _ = tx.send(view);
			});
		},
		None => {
			let _ = tx.send(parked(&journal));
		},
	}
	Ok(rx)
}

/// The child's `.oms` beside the parent's journals (the spawner names it
/// after the job id).
fn journal_path(state: &ServiceState, id: &str) -> PathBuf {
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
	state.sessions_dir.join(format!("{safe}.oms"))
}

/// Journal-derived snapshot of a parked child; no event stream follows it.
fn parked(journal: &std::path::Path) -> ServiceResult<AgentView> {
	if !journal.exists() {
		return Err(ServiceError::Failed(Str::new(format!(
			"agent journal {} does not exist",
			journal.display()
		))));
	}
	let session = omp_session::Session::open(journal, omp_session::ComponentRegistry::standard())
		.map_err(ServiceError::failed)?;
	Ok(AgentView { snapshot: session.dom().snapshot(), events: None })
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn parked_agent_view_is_derived_from_its_journal_without_a_stream() {
		let dir = tempfile::tempdir().expect("tempdir");
		let path = dir.path().join("AuthLoader.oms");
		let mut session =
			omp_session::Session::create(&path, omp_session::ComponentRegistry::standard())
				.expect("child journal");
		session.begin_turn().expect("turn");
		session
			.user(Str::new_static("fix the auth store"), Vec::new())
			.expect("user");
		drop(session);
		let view = parked(&path).expect("parked view");
		assert!(view.events.is_none());
		let dom = omp_dom::Dom::from_snapshot(&view.snapshot);
		assert_eq!(dom.children(dom.body()).len(), 1, "one turn projected from the journal");
	}

	#[test]
	fn missing_child_journal_is_a_typed_failure() {
		let dir = tempfile::tempdir().expect("tempdir");
		let error = parked(&dir.path().join("ghost.oms"))
			.err()
			.expect("failure");
		assert!(matches!(error, ServiceError::Failed(_)));
	}
}
