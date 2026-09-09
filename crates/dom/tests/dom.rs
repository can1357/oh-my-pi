//! Laws for atomicity, handle identity, streaming cost, selectors, and the wire
//! codec.

use omp_core::Str;
use omp_dom::{Dom, Event, Handle, KnownTag, NodeSpec, Op, PropId, PropKey, Tag, Txn, Value};
use omp_journal::EntryId;
use pretty_assertions::assert_eq;
use proptest::prelude::*;

fn txn(ops: Vec<Op>) -> Txn {
	Txn { cause: EntryId::default(), label: None, ops }
}

fn ins(parent: Handle, tag: KnownTag) -> Op {
	Op::Ins { parent, after: None, node: NodeSpec::new(tag) }
}

#[test]
fn txn_is_atomic_and_rejects_cycles() {
	let mut dom = Dom::new();
	let parent = Handle::new(5).unwrap();
	let child = Handle::new(6).unwrap();
	let applied = dom
		.apply(&txn(vec![ins(dom.body(), KnownTag::Turn), ins(parent, KnownTag::Assistant)]))
		.unwrap();
	assert_eq!(applied.minted, vec![parent, child]);

	let before = dom.snapshot();
	let error = dom
		.apply(&txn(vec![
			Op::Set {
				h:     child,
				prop:  PropId::Status.into(),
				value: Value::Str(Str::new("changed")),
			},
			Op::Mv { h: parent, parent: child, after: None },
		]))
		.unwrap_err();
	assert!(matches!(error, omp_dom::DomError::Cycle { op_index: 1, .. }));
	assert_eq!(dom.snapshot(), before);
}

#[test]
fn fixed_topology_rejects_invalid_roots_and_body_children_atomically() {
	let mut dom = Dom::new();
	let before = dom.snapshot();
	let error = dom
		.apply(&txn(vec![ins(dom.body(), KnownTag::Assistant)]))
		.unwrap_err();
	assert!(matches!(
		error,
		omp_dom::DomError::Topology {
			op_index: 0,
			handle,
			tag: Tag::Known(KnownTag::Assistant),
		} if handle == Handle::new(5).unwrap()
	));
	assert_eq!(dom.snapshot(), before);

	for handle in [dom.root(), dom.meta(), dom.body(), dom.queues()] {
		for operation in [Op::Rm(handle), Op::Mv { h: handle, parent: dom.body(), after: None }] {
			let error = dom.apply(&txn(vec![operation])).unwrap_err();
			assert!(matches!(
				error,
				omp_dom::DomError::Topology {
					op_index: 0,
					handle: rejected,
					..
				} if rejected == handle
			));
			assert_eq!(dom.snapshot(), before);
		}
	}

	let todo = dom
		.apply(&txn(vec![ins(dom.meta(), KnownTag::Todo)]))
		.unwrap()
		.minted[0];
	let with_component = dom.snapshot();
	let error = dom.apply(&txn(vec![Op::Rm(todo)])).unwrap_err();
	assert!(matches!(
		error,
		omp_dom::DomError::Topology {
			op_index: 0,
			handle,
			tag: Tag::Known(KnownTag::Todo),
		} if handle == todo
	));
	assert_eq!(dom.snapshot(), with_component);
}

#[test]
fn handles_are_never_reused_after_rederive() {
	let mut dom = Dom::new();
	let first = dom
		.apply(&txn(vec![ins(dom.body(), KnownTag::Turn)]))
		.unwrap()
		.minted[0];
	dom.apply(&txn(vec![Op::Rm(first)])).unwrap();
	let snapshot = dom.snapshot();
	let mut restored = Dom::from_snapshot(&snapshot);
	let next = restored
		.apply(&txn(vec![ins(restored.body(), KnownTag::Turn)]))
		.unwrap()
		.minted[0];
	assert_eq!(first.get(), 5);
	assert_eq!(snapshot.high_water(), 5);
	assert_eq!(next.get(), 6);

	let mut replayed = Dom::new();
	let original = replayed
		.apply(&txn(vec![ins(replayed.body(), KnownTag::Turn)]))
		.unwrap()
		.minted[0];
	replayed.raise_high_water(20);
	assert!(replayed.get(original).is_some());
	let after_floor = replayed
		.apply(&txn(vec![ins(replayed.body(), KnownTag::Turn)]))
		.unwrap()
		.minted[0];
	assert_eq!(after_floor.get(), 21);
}

#[test]
fn stream_append_is_linear_in_delta() {
	let mut dom = Dom::new();
	let turn = Handle::new(5).unwrap();
	let assistant = dom
		.apply(&txn(vec![ins(dom.body(), KnownTag::Turn), ins(turn, KnownTag::Assistant)]))
		.unwrap()
		.minted[1];
	let cause = EntryId::default();
	let sid = dom
		.stream_open(cause, assistant, PropId::Text.into())
		.unwrap();
	for _ in 0..10_000 {
		dom.stream_append(cause, sid, "x").unwrap();
	}
	assert_eq!(dom.stream_appended_bytes(sid), Some(10_000));
	assert_eq!(
		dom.snapshot()
			.get(assistant)
			.unwrap()
			.prop(&PropKey::from(PropId::Text))
			.and_then(Value::as_str)
			.unwrap()
			.len(),
		10_000
	);
	dom.stream_close(cause, sid).unwrap();
	assert_eq!(
		dom.get(assistant)
			.unwrap()
			.prop(&PropId::Text.into())
			.and_then(Value::as_str)
			.unwrap()
			.len(),
		10_000
	);
	let snapshot = dom.snapshot();
	assert_eq!(snapshot.next_sid(), 2);
	let mut restored = Dom::from_snapshot(&snapshot);
	assert!(matches!(
		restored.stream_open_with_id(cause, 1, assistant, PropId::Thinking.into()),
		Err(omp_dom::DomError::ReusedStream { sid: 1 })
	));
	assert_eq!(
		restored
			.stream_open(cause, assistant, PropId::Thinking.into())
			.unwrap(),
		2
	);
}

#[test]
fn selector_table() {
	let mut dom = Dom::new();
	let todo = Handle::new(5).unwrap();
	let open = Handle::new(6).unwrap();
	let done = Handle::new(7).unwrap();
	let turn = Handle::new(8).unwrap();
	let assistant = Handle::new(9).unwrap();
	let status = PropKey::from(PropId::Status);
	dom.apply(&txn(vec![
		ins(dom.meta(), KnownTag::Todo),
		Op::Ins {
			parent: todo,
			after:  None,
			node:   NodeSpec::new(KnownTag::Item)
				.with_prop(status.clone(), Value::Str(Str::new("in-progress"))),
		},
		Op::Ins {
			parent: todo,
			after:  Some(open),
			node:   NodeSpec::new(KnownTag::Item).with_prop(status, Value::Str(Str::new("completed"))),
		},
		ins(dom.body(), KnownTag::Turn),
		ins(turn, KnownTag::Assistant),
	]))
	.unwrap();

	let cases = [
		("todo", vec![todo]),
		("item[status=completed]", vec![done]),
		("todo item[status!=completed]", vec![open]),
		("body assistant", vec![assistant]),
		("meta assistant", vec![]),
	];
	for (selector, expected) in cases {
		assert_eq!(dom.select(selector).unwrap().collect::<Vec<_>>(), expected, "{selector}");
		assert_eq!(dom.count(selector).unwrap(), expected.len(), "{selector}");
	}
}

#[test]
fn op_serde_matches_adr_arrays() {
	let one = Handle::new(1).unwrap();
	let two = Handle::new(2).unwrap();
	let spec = NodeSpec::new(KnownTag::Notice).with_content("hello");
	let cases = vec![
		(
			Op::Ins { parent: one, after: Some(two), node: spec },
			r#"["ins",1,2,{"tag":"notice","content":"hello"}]"#,
		),
		(Op::Rm(two), r#"["rm",2]"#),
		(
			Op::Set {
				h:     two,
				prop:  PropId::Status.into(),
				value: Value::Str(Str::new("completed")),
			},
			r#"["set",2,"status","completed"]"#,
		),
		(Op::Mv { h: two, parent: one, after: None }, r#"["mv",2,1,null]"#),
	];
	for (op, literal) in cases {
		assert_eq!(serde_json::to_string(&op).unwrap(), literal);
		assert_eq!(serde_json::from_str::<Op>(literal).unwrap(), op);
	}
	assert!(serde_json::from_str::<Op>(r#"["stream",1,"append",null,null,"x"]"#).is_err());
}

#[test]
fn every_value_variant_round_trips_including_nested_json() {
	let cases = vec![
		Value::Null,
		Value::Bool(true),
		Value::Int(-7),
		Value::Float(1.25),
		Value::Str(Str::new("text")),
		Value::Json(
			serde_json::value::RawValue::from_string(
				r#"{"nested":{"list":[1,true,null,{"key":"value"}]}}"#.to_owned(),
			)
			.unwrap(),
		),
		Value::Json(
			serde_json::value::RawValue::from_string(r#"[{"nested":[false,2.5]},"tail"]"#.to_owned())
				.unwrap(),
		),
	];
	for value in cases {
		let encoded = serde_json::to_string(&value).unwrap();
		let decoded: Value = serde_json::from_str(&encoded).unwrap();
		assert_eq!(decoded, value, "{encoded}");
	}
}

#[test]
fn subscription_starts_with_snapshot_then_publishes_patches() {
	let mut dom = Dom::new();
	let (snapshot, patches) = dom.subscribe();
	assert_eq!(snapshot.high_water(), 4);
	let prior = EntryId::default();
	let applied = dom
		.apply_with_prior(&txn(vec![ins(dom.body(), KnownTag::Turn)]), Some(prior))
		.unwrap();
	let Event::Patch(patch) = patches.recv().unwrap() else {
		panic!("transaction must publish a patch event");
	};
	assert_eq!(patch.prior, Some(prior));
	assert_eq!(patch.ops.len(), 1);
	assert_eq!(applied.minted, vec![Handle::new(5).unwrap()]);
}

#[test]
fn subscriber_replica_converges_over_patches_streams_and_reset() {
	let mut authority = Dom::new();
	let (snapshot, events) = authority.subscribe();
	let mut replica = Dom::from_snapshot(&snapshot);
	let turn = Handle::new(5).unwrap();
	let assistant = Handle::new(6).unwrap();
	let cause = EntryId::default();

	authority
		.apply(&txn(vec![ins(authority.body(), KnownTag::Turn), ins(turn, KnownTag::Assistant)]))
		.unwrap();
	replica.apply_event(&events.recv().unwrap()).unwrap();
	assert_eq!(replica.snapshot(), authority.snapshot());

	let sid = authority
		.stream_open(cause, assistant, PropId::Text.into())
		.unwrap();
	replica.apply_event(&events.recv().unwrap()).unwrap();
	authority.stream_append(cause, sid, "delta").unwrap();
	replica.apply_event(&events.recv().unwrap()).unwrap();
	authority.stream_close(cause, sid).unwrap();
	replica.apply_event(&events.recv().unwrap()).unwrap();
	assert_eq!(replica.snapshot(), authority.snapshot());

	let target = Dom::with_high_water(authority.high_water()).snapshot();
	authority.reset(target);
	let reset = events.recv().unwrap();
	assert!(matches!(reset, Event::Reset { .. }));
	replica.apply_event(&reset).unwrap();
	assert_eq!(replica.snapshot(), authority.snapshot());
}

proptest! {
	#[test]
	fn validate_acceptance_matches_apply_over_generated_transactions(
		raw_ops in prop::collection::vec((0_u8..5, 1_u64..14, 1_u64..14, any::<bool>()), 0..12),
	) {
		let mut operations = Vec::with_capacity(raw_ops.len());
		for (kind, left, right, flag) in raw_ops {
			let h = Handle::new(left).unwrap();
			let parent = Handle::new(right).unwrap();
			let op = match kind {
				0 => Op::Ins {
					parent,
					after: None,
					node: NodeSpec::new(if flag { KnownTag::Turn } else { KnownTag::Assistant }),
				},
				1 => Op::Rm(h),
				2 => Op::Set {
					h,
					prop: PropId::Status.into(),
					value: Value::Bool(flag),
				},
				3 => Op::Mv { h, parent, after: None },
				_ => Op::Mv { h, parent, after: Some(Handle::new(5).unwrap()) },
			};
			operations.push(op);
		}
		let mut dom = Dom::new();
		let turn = Handle::new(5).unwrap();
		dom.apply(&txn(vec![
			ins(dom.body(), KnownTag::Turn),
			ins(turn, KnownTag::Assistant),
		]))
		.unwrap();
		let candidate = txn(operations);
		let validation = dom.validate(&candidate);
		let mut applied_dom = Dom::from_snapshot(&dom.snapshot());
		let application = applied_dom.apply(&candidate).map(|_| ());
		prop_assert_eq!(validation, application);
	}
}

#[test]
fn custom_names_colliding_with_known_names_round_trip() {
	let tag = Tag::Custom(Str::new("todo"));
	let prop = PropKey::Custom(Str::new("status"));
	assert_eq!(serde_json::to_string(&tag).unwrap(), r#""tool:todo""#);
	assert_eq!(serde_json::from_str::<Tag>(r#""tool:todo""#).unwrap(), tag);
	assert_eq!(serde_json::to_string(&prop).unwrap(), r#""custom:status""#);
	assert_eq!(serde_json::from_str::<PropKey>(r#""custom:status""#).unwrap(), prop);
}
