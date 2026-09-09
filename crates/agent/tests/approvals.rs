//! Durable approval ticket, route, and replay contracts.

use std::sync::Arc;

use omp_agent::{
	ApprovalBook, ApprovalDecision, ApprovalRoute, ApprovalScope, ApprovalSource, ApprovalSpec,
	TicketState,
};
use omp_core::{Str, sf};
use omp_session::{ComponentRegistry, Session};

fn spec(timeout_ms: u64, default: Option<bool>) -> ApprovalSpec {
	ApprovalSpec {
		title: sf!("Run command"),
		body: sf!("The command mutates the environment"),
		subject: sf!("printf ok"),
		kind: sf!("exec"),
		scopes: vec![sf!("once"), sf!("session")],
		default,
		route: sf!("local"),
		approver: None,
		timeout_ms,
		unreachable: sf!("fail_closed"),
		require_human: false,
		pattern: None,
		evidence: vec![sf!("shell writes stdout")],
	}
}

fn decision() -> ApprovalDecision {
	ApprovalDecision {
		approved:   true,
		scope:      ApprovalScope::Once,
		source:     ApprovalSource::User,
		decided_by: Some(sf!("tester")),
		reason:     Some(sf!("expected mutation")),
		audited:    false,
	}
}

#[test]
fn approvals_open_decide_round_trip_through_session_replay() {
	let temp = tempfile::tempdir().expect("tempdir");
	let path = temp.path().join("approval.oms");
	let mut session = Session::create(&path, ComponentRegistry::standard()).expect("session");
	let book = ApprovalBook::new();
	let ticket = book.open(&mut session, spec(0, None)).expect("open prompt");
	assert_eq!(book.pending(&session), vec![ticket.clone()]);
	let decided = book
		.decide(&mut session, ticket.ticket_id.as_str(), decision())
		.expect("decide prompt");
	assert_eq!(decided.state, TicketState::Decided);
	drop(session);

	let restored = Session::open(&path, ComponentRegistry::standard()).expect("replay");
	assert_eq!(book.ticket(&restored, ticket.ticket_id.as_str()), Some(decided));
	assert!(book.pending(&restored).is_empty());
}

#[test]
fn approvals_merge_and_withdraw_round_trip_through_replay() {
	let temp = tempfile::tempdir().expect("tempdir");
	let path = temp.path().join("withdraw.oms");
	let mut session = Session::create(&path, ComponentRegistry::standard()).expect("session");
	let book = ApprovalBook::new();
	let first = book
		.open_for(&mut session, Some(sf!("call-1")), vec![spec(0, None)], 7)
		.expect("first prompt");
	let merged = book
		.open_for(&mut session, Some(sf!("call-1")), vec![spec(0, None)], 8)
		.expect("merge prompt");
	assert_eq!(merged.ticket_id, first.ticket_id);
	assert_eq!(merged.reasons.len(), 2);
	let withdrawn = book
		.withdraw(&mut session, first.ticket_id.as_str())
		.expect("withdraw prompt");
	drop(session);

	let restored = Session::open(&path, ComponentRegistry::standard()).expect("replay");
	assert_eq!(book.ticket(&restored, first.ticket_id.as_str()), Some(withdrawn));
}

#[tokio::test]
async fn cancelled_or_dropped_route_requests_remove_only_their_pending_entry() {
	let (route, inbox) = ApprovalRoute::new(Arc::new(ApprovalBook::new()), None);
	let cancellation = tokio_util::sync::CancellationToken::new();
	let waiting = {
		let route = route.clone();
		let cancellation = cancellation.clone();
		tokio::spawn(async move {
			route
				.request_cancellable(
					Some(Str::new_static("same-call")),
					vec![spec(0, None)],
					1,
					cancellation,
				)
				.await
		})
	};
	let first = inbox.recv().await.expect("first request dispatched");
	assert_eq!(route.pending().len(), 1);
	cancellation.cancel();
	let cancelled = waiting.await.expect("cancelled request joins");
	assert_eq!(cancelled.state, TicketState::Decided);
	assert!(!cancelled.decision.expect("cancel decision").approved);
	assert!(route.pending().is_empty());

	let dropped = {
		let route = route.clone();
		tokio::spawn(async move {
			route
				.request(Some(Str::new_static("same-call")), vec![spec(0, None)], 2)
				.await
		})
	};
	let second = inbox.recv().await.expect("second request dispatched");
	assert_ne!(first.ticket.ticket_id, second.ticket.ticket_id);
	assert_eq!(route.pending().len(), 1);
	dropped.abort();
	let _ = dropped.await;
	tokio::task::yield_now().await;
	assert!(route.pending().is_empty());
}

#[tokio::test]
async fn approvals_route_timeout_round_trips_through_session_replay() {
	let (route, inbox) = ApprovalRoute::new(Arc::new(ApprovalBook::new()), None);
	let waiting = tokio::spawn(async move {
		route
			.request(Some(Str::new_static("call")), vec![spec(1, Some(true))], 1)
			.await
	});
	let request = inbox.recv().await.expect("request dispatched");
	assert_eq!(request.ticket.state, TicketState::Pending);
	let ticket = waiting.await.expect("request task");
	assert_eq!(ticket.state, TicketState::Decided);
	assert_eq!(ticket.decision.as_ref().map(|value| value.source), Some(ApprovalSource::Timeout));
	assert!(ticket.decision.as_ref().is_some_and(|value| value.approved));

	let temp = tempfile::tempdir().expect("tempdir");
	let path = temp.path().join("timeout.oms");
	let mut session = Session::create(&path, ComponentRegistry::standard()).expect("session");
	let book = ApprovalBook::new();
	let opened = book
		.open_for(
			&mut session,
			ticket.invocation_id.clone(),
			ticket.reasons.clone(),
			ticket.created_at_ms,
		)
		.expect("open timeout prompt");
	let decided = book
		.decide(&mut session, opened.ticket_id.as_str(), ticket.decision.expect("timeout decision"))
		.expect("persist timeout decision");
	drop(session);
	let restored = Session::open(&path, ComponentRegistry::standard()).expect("replay");
	assert_eq!(book.ticket(&restored, opened.ticket_id.as_str()), Some(decided));
}
