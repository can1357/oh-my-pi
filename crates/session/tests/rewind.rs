//! Rewind lifecycle-diff law.

use omp_core::Str;
use omp_dom::{KnownTag, NodeSpec, Op, PropId, Tag, Txn, Value};
use omp_session::{ComponentRegistry, Session, diff};

fn child(session: &Session, parent: omp_dom::Handle, tag: KnownTag) -> omp_dom::Handle {
	session
		.dom()
		.children(parent)
		.iter()
		.copied()
		.find(|handle| {
			session
				.dom()
				.get(*handle)
				.is_some_and(|node| node.tag == Tag::Known(tag))
		})
		.expect("required structural child exists")
}

#[test]
fn subscription_survives_rewind_and_marks_branch_prior() {
	let directory = tempfile::tempdir().expect("temporary session directory");
	let mut session =
		Session::create(directory.path().join("subscription.oms"), ComponentRegistry::default())
			.expect("session creates");
	let target = session.begin_turn().expect("turn starts");
	let (snapshot, events) = session.subscribe();
	let mut replica = omp_dom::Dom::from_snapshot(&snapshot);
	session
		.user("abandoned", Vec::new())
		.expect("message appends");
	while let Ok(event) = events.try_recv() {
		replica.apply_event(&event).expect("ordinary event applies");
	}
	assert_eq!(replica.snapshot().as_bytes(), session.dom().snapshot().as_bytes());

	session.rewind(target).expect("rewind succeeds");
	let reset = events.recv().expect("rewind reset arrives");
	assert!(matches!(reset, omp_dom::Event::Reset { .. }));
	replica.apply_event(&reset).expect("reset applies");
	assert_eq!(replica.snapshot().as_bytes(), session.dom().snapshot().as_bytes());

	session.begin_turn().expect("branch append");
	session
		.user("selected", Vec::new())
		.expect("branch message appends");
	let mut saw_prior = false;
	while let Ok(event) = events.try_recv() {
		if let omp_dom::Event::Patch(patch) = &event {
			saw_prior |= patch.prior == Some(target);
		}
		replica.apply_event(&event).expect("branch event applies");
	}
	assert!(saw_prior);
	assert_eq!(replica.snapshot().as_bytes(), session.dom().snapshot().as_bytes());
}

#[test]
fn rewind_is_a_dom_diff_that_lists_lifecycle_work() {
	let directory = tempfile::tempdir().expect("temporary session directory");
	let path = directory.path().join("rewind.oms");
	let mut session = Session::create(path, ComponentRegistry::default()).expect("session creates");
	let target = session.begin_turn().expect("turn starts");
	let jobs = child(&session, session.dom().meta(), KnownTag::Jobs);
	let cause = session.head().expect("session has head");
	session
		.patch(Txn {
			cause,
			label: None,
			ops: vec![
				Op::Ins {
					parent: jobs,
					after:  None,
					node:   NodeSpec::new(KnownTag::Subagent)
						.with_prop(PropId::Id, Value::Str(Str::new_static("agent-1"))),
				},
				Op::Ins {
					parent: jobs,
					after:  None,
					node:   NodeSpec::new(KnownTag::Job)
						.with_prop(PropId::Id, Value::Str(Str::new_static("job-1"))),
				},
			],
		})
		.expect("lifecycle patch applies");

	let work = session.rewind(target).expect("rewind succeeds");
	assert_eq!(work.terminate.len(), 2);
	assert!(work.spawn.is_empty());

	let without_lifecycle = session.dom().snapshot();
	let jobs = child(&session, session.dom().meta(), KnownTag::Jobs);
	let cause = session.head().expect("rewound target is head");
	session
		.patch(Txn {
			cause,
			label: None,
			ops: vec![
				Op::Ins {
					parent: jobs,
					after:  None,
					node:   NodeSpec::new(KnownTag::Subagent)
						.with_prop(PropId::Id, Value::Str(Str::new_static("agent-1"))),
				},
				Op::Ins {
					parent: jobs,
					after:  None,
					node:   NodeSpec::new(KnownTag::Job)
						.with_prop(PropId::Id, Value::Str(Str::new_static("job-1"))),
				},
			],
		})
		.expect("replacement lifecycle patch applies");
	let with_lifecycle = session.dom().snapshot();
	let spawn = diff(&without_lifecycle, &with_lifecycle);
	assert_eq!(spawn.spawn.len(), 2);
	assert!(spawn.terminate.is_empty());
}

#[test]
fn running_tool_calls_are_distinct_actionable_lifecycle_nodes() {
	let directory = tempfile::tempdir().expect("temporary session directory");
	let mut session =
		Session::create(directory.path().join("tool-lifecycle.oms"), ComponentRegistry::default())
			.expect("session creates");
	let target = session.begin_turn().expect("turn starts");
	for _ in 0..2 {
		session
			.call(
				"read",
				1,
				"provider-reused-id",
				None,
				Some(
					serde_json::value::to_raw_value(&serde_json::json!({}))
						.expect("arguments serialize"),
				),
				None,
			)
			.expect("running call appends");
	}

	let work = session.rewind(target).expect("rewind succeeds");
	assert_eq!(
		work.terminate.len(),
		2,
		"journal causes keep duplicate provider call ids independently actionable"
	);
	assert!(work.spawn.is_empty());
	assert!(work.retained.is_empty());

	let without_calls = session.dom().snapshot();
	session
		.call(
			"read",
			1,
			"provider-reused-id",
			None,
			Some(
				serde_json::value::to_raw_value(&serde_json::json!({})).expect("arguments serialize"),
			),
			None,
		)
		.expect("replacement call appends");
	let with_call = session.dom().snapshot();
	let spawn = diff(&without_calls, &with_call);
	assert_eq!(spawn.spawn.len(), 1);
	assert!(spawn.terminate.is_empty());
}

#[test]
fn lifecycle_diff_matches_durable_identity_across_different_handles() {
	fn snapshot_with_job(floor: Option<u64>) -> omp_dom::Snapshot {
		let cause = omp_journal::EntryId::from(omp_core::Ulid::generate());
		let mut dom = omp_dom::Dom::new();
		dom.apply(&Txn {
			cause,
			label: None,
			ops: vec![Op::Ins {
				parent: dom.meta(),
				after:  None,
				node:   NodeSpec::new(KnownTag::Jobs),
			}],
		})
		.expect("jobs inserts");
		if let Some(floor) = floor {
			dom.raise_high_water(floor);
		}
		let jobs = dom.children(dom.meta())[0];
		dom.apply(&Txn {
			cause,
			label: None,
			ops: vec![Op::Ins {
				parent: jobs,
				after:  None,
				node:   NodeSpec::new(KnownTag::Job)
					.with_prop(PropId::Id, Value::Str(Str::new_static("stable-job"))),
			}],
		})
		.expect("job inserts");
		dom.snapshot()
	}

	let before = snapshot_with_job(None);
	let after = snapshot_with_job(Some(20));
	let work = diff(&before, &after);
	assert!(work.terminate.is_empty());
	assert!(work.spawn.is_empty());
	assert_eq!(work.retained.len(), 1);
	assert_ne!(work.retained[0].0, work.retained[0].1);
}

#[test]
fn lifecycle_identity_survives_allocator_floor_raise() {
	let directory = tempfile::tempdir().expect("temporary session directory");
	let mut session =
		Session::create(directory.path().join("retained.oms"), ComponentRegistry::default())
			.expect("session creates");
	let jobs = child(&session, session.dom().meta(), KnownTag::Jobs);
	let cause = session.head().expect("genesis");
	session
		.patch(Txn {
			cause,
			label: None,
			ops: vec![Op::Ins {
				parent: jobs,
				after:  None,
				node:   NodeSpec::new(KnownTag::Job)
					.with_prop(PropId::Id, Value::Str(Str::new_static("stable-job"))),
			}],
		})
		.expect("job inserts");
	let target = session.begin_turn().expect("target follows job");
	session
		.user("later", Vec::new())
		.expect("later entry appends");
	let work = session.rewind(target).expect("rewind retains job");
	assert!(work.terminate.is_empty());
	assert!(work.spawn.is_empty());
	assert_eq!(work.retained.len(), 1);
	assert_eq!(work.retained[0].0, work.retained[0].1);
}
