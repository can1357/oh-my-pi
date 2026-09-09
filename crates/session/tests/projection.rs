//! DOM-only message projection laws.

use omp_core::{Hash32, Str};
use omp_dom::{KnownTag, NodeSpec, Op, PropId, PropKey, Tag, Txn, Value};
use omp_journal::blob::{BlobRef, BlobStore};
use omp_proto::thread::v1::{item, part};
use omp_session::{
	ASSISTANT_CONTENT_TAG, ComponentRegistry, PROVIDER_BLOCK_INDEX_PROP, Session, project_thread,
};
use serde_json::value::RawValue;

fn raw(value: serde_json::Value) -> Box<RawValue> {
	serde_json::value::to_raw_value(&value).expect("test JSON serializes")
}

fn find_tag(session: &Session, tag: KnownTag) -> Vec<omp_dom::Handle> {
	session
		.dom()
		.handles()
		.filter(|handle| {
			session
				.dom()
				.get(*handle)
				.is_some_and(|node| node.tag == Tag::Known(tag))
		})
		.collect()
}

fn insert_assistant_part(
	session: &mut Session,
	assistant: omp_dom::Handle,
	index: i64,
	kind: &str,
) -> omp_dom::Handle {
	session
		.patch(Txn {
			cause: session.head().expect("head"),
			label: Some(Str::new_static("assistant.block")),
			ops:   vec![Op::Ins {
				parent: assistant,
				after:  session.dom().children(assistant).last().copied(),
				node:   NodeSpec::new(Tag::Custom(Str::new_static(ASSISTANT_CONTENT_TAG)))
					.with_prop(PropId::Kind, Value::Str(Str::new(kind)))
					.with_prop(
						PropKey::Custom(Str::new_static(PROVIDER_BLOCK_INDEX_PROP)),
						Value::Int(index),
					),
			}],
		})
		.expect("assistant part");
	*session
		.dom()
		.children(assistant)
		.last()
		.expect("inserted assistant part")
}

fn insert_artifact(
	session: &mut Session,
	assistant: omp_dom::Handle,
	index: i64,
	byte: u8,
) -> omp_dom::Handle {
	let uri = Str::new(format!("artifact://sha256/{}", format!("{byte:02x}").repeat(32)));
	session
		.patch(Txn {
			cause: session.head().expect("head"),
			label: Some(Str::new_static("assistant.artifact")),
			ops:   vec![Op::Ins {
				parent: assistant,
				after:  session.dom().children(assistant).last().copied(),
				node:   NodeSpec::new(Tag::Custom(Str::new_static("artifact")))
					.with_prop(PropId::Blob, Value::Str(uri))
					.with_prop(PropId::Mime, Value::Str(Str::new_static("image/png")))
					.with_prop(PropId::Kind, Value::Str(Str::new_static("image")))
					.with_prop(
						PropKey::Custom(Str::new_static(PROVIDER_BLOCK_INDEX_PROP)),
						Value::Int(index),
					),
			}],
		})
		.expect("artifact");
	*session
		.dom()
		.children(assistant)
		.last()
		.expect("inserted artifact")
}

fn stream_part(session: &mut Session, handle: omp_dom::Handle, text: &str, close: bool) -> u32 {
	let sid = session
		.stream_open(handle, PropId::Text.into())
		.expect("part stream");
	session.stream_append(sid, text).expect("part delta");
	if close {
		session.stream_close(sid).expect("part closes");
	}
	sid
}

#[test]
fn every_body_element_is_inside_an_explicit_turn() {
	let directory = tempfile::tempdir().expect("temporary session directory");
	let mut session =
		Session::create(directory.path().join("turns.oms"), ComponentRegistry::default())
			.expect("session creates");
	session.begin_turn().expect("turn starts");
	session.user("question", Vec::new()).expect("user appends");
	session
		.assistant_start("model", "provider", "route")
		.expect("assistant starts");
	let call = session
		.call(
			"read",
			1,
			"call-1",
			Some(Str::new_static("read a file")),
			Some(raw(serde_json::json!({"path":"README.md"}))),
			None,
		)
		.expect("tool call appends");
	session
		.settle(call, raw(serde_json::json!({"text":"contents"})))
		.expect("tool settles");
	let turn = *session
		.dom()
		.children(session.dom().body())
		.last()
		.expect("turn exists");
	let tool = session
		.dom()
		.children(turn)
		.iter()
		.copied()
		.find(|handle| {
			session
				.dom()
				.get(*handle)
				.is_some_and(|node| matches!(node.tag, Tag::Custom(_)))
		})
		.expect("tool exists");
	let child_tags: Vec<_> = session
		.dom()
		.children(tool)
		.iter()
		.map(|handle| {
			session
				.dom()
				.get(*handle)
				.expect("tool child exists")
				.tag
				.clone()
		})
		.collect();
	assert_eq!(child_tags, [
		Tag::Known(KnownTag::Input),
		Tag::Known(KnownTag::Result),
		Tag::Known(KnownTag::Usage),
	]);

	for child in session.dom().children(session.dom().body()) {
		assert_eq!(
			session.dom().get(*child).expect("body child exists").tag,
			Tag::Known(KnownTag::Turn)
		);
	}
}

#[test]
fn message_projection_is_a_pure_function_of_the_dom() {
	let directory = tempfile::tempdir().expect("temporary session directory");
	let mut session =
		Session::create(directory.path().join("projection.oms"), ComponentRegistry::default())
			.expect("session creates");
	session.begin_turn().expect("turn starts");
	session.user("question", Vec::new()).expect("user appends");
	session
		.assistant_start("model", "provider", "route")
		.expect("assistant starts");
	let assistant = session
		.dom()
		.children(
			*session
				.dom()
				.children(session.dom().body())
				.last()
				.expect("turn"),
		)
		.last()
		.copied()
		.expect("assistant");
	let sid = session
		.stream_open(assistant, omp_dom::PropId::Text.into())
		.expect("stream opens");
	session
		.stream_append(sid, "answer")
		.expect("stream appends");
	session.stream_close(sid).expect("stream closes");
	session.assistant_end("stop").expect("assistant ends");
	let call = session
		.call("read", 1, "call-1", None, Some(raw(serde_json::json!({"path":"README.md"}))), None)
		.expect("tool call appends");
	session
		.settle(call, raw(serde_json::json!({"text":"contents"})))
		.expect("tool settles");
	let before = session.dom().snapshot();
	let first = project_thread(session.dom());
	let second = project_thread(session.dom());
	assert_eq!(first, second);
	assert_eq!(session.dom().snapshot().as_bytes(), before.as_bytes());
	assert!(
		first
			.iter()
			.any(|item| matches!(item.kind, Some(item::Kind::ToolCall(_))))
	);
	assert!(
		first
			.iter()
			.any(|item| matches!(item.kind, Some(item::Kind::ToolResult(_))))
	);
}

#[test]
fn mixed_assistant_parts_project_in_provider_order_while_streaming() {
	let directory = tempfile::tempdir().expect("temporary session directory");
	let mut session =
		Session::create(directory.path().join("mixed.oms"), ComponentRegistry::default())
			.expect("session creates");
	session.begin_turn().expect("turn starts");
	session
		.user("mixed output", Vec::new())
		.expect("user appends");
	session
		.assistant_start("model", "provider", "route")
		.expect("assistant starts");
	let turn = *session
		.dom()
		.children(session.dom().body())
		.last()
		.expect("turn");
	let assistant = *session.dom().children(turn).last().expect("assistant");

	let after = insert_assistant_part(&mut session, assistant, 2, "text");
	stream_part(&mut session, after, "after", true);
	insert_artifact(&mut session, assistant, 1, 1);
	let before = insert_assistant_part(&mut session, assistant, 0, "text");
	stream_part(&mut session, before, "before", true);
	let second_thought = insert_assistant_part(&mut session, assistant, 5, "thinking");
	stream_part(&mut session, second_thought, "second", true);
	insert_artifact(&mut session, assistant, 4, 2);
	let first_thought = insert_assistant_part(&mut session, assistant, 3, "thinking");
	stream_part(&mut session, first_thought, "first", true);
	insert_artifact(&mut session, assistant, 6, 3);
	let live = insert_assistant_part(&mut session, assistant, 7, "text");
	let live_sid = stream_part(&mut session, live, "live", false);

	let projected = project_thread(session.dom());
	let parts = projected
		.iter()
		.find_map(|item| {
			let item::Kind::Message(message) = item.kind.as_ref()? else {
				return None;
			};
			(message.role == omp_proto::thread::v1::Role::Assistant as i32)
				.then_some(message.parts.as_slice())
		})
		.expect("assistant message");
	let shape = parts
		.iter()
		.map(|part| match part.kind.as_ref().expect("part kind") {
			part::Kind::Text(text) => format!("text:{text}"),
			part::Kind::Thinking(thinking) => format!("thinking:{}", thinking.text),
			part::Kind::Blob(blob) => format!("blob:{}", blob.hash[0]),
			other => panic!("unexpected assistant part: {other:?}"),
		})
		.collect::<Vec<_>>();
	assert_eq!(shape, [
		"text:before",
		"blob:1",
		"text:after",
		"thinking:first",
		"blob:2",
		"thinking:second",
		"blob:3",
		"text:live",
	]);

	session
		.stream_append(live_sid, " tail")
		.expect("live text suffix");
	let projected = project_thread(session.dom());
	let parts = projected
		.iter()
		.find_map(|item| {
			let item::Kind::Message(message) = item.kind.as_ref()? else {
				return None;
			};
			(message.role == omp_proto::thread::v1::Role::Assistant as i32)
				.then_some(message.parts.as_slice())
		})
		.expect("assistant message");
	assert!(
		matches!(
			parts[7].kind.as_ref(),
			Some(part::Kind::Text(text)) if text == "live tail"
		),
		"an open child stream projects its growing prefix in place"
	);
}

#[test]
fn todo_and_jobs_are_journal_derived_meta_components() {
	let directory = tempfile::tempdir().expect("temporary session directory");
	let path = directory.path().join("components.oms");
	let mut session = Session::create(&path, ComponentRegistry::default()).expect("session creates");
	session.begin_turn().expect("turn starts");
	let todo = session
		.call("todo", 3, "todo-1", None, Some(raw(serde_json::json!({}))), None)
		.expect("todo call appends");
	session
		.settle(
			todo,
			raw(serde_json::json!({
				"op": "block",
				"phases": [
					{"name": "Build", "tasks": [{
						"content": "land substrate",
						"status": "blocked",
						"blocker": "waiting on owner"
					}]},
					{"name": "Ship", "tasks": []}
				]
			})),
		)
		.expect("todo snapshot settles");
	let items = find_tag(&session, KnownTag::Item);
	assert_eq!(items.len(), 1);
	let item = session.dom().get(items[0]).expect("todo item exists");
	assert_eq!(
		item
			.prop(&omp_dom::PropKey::from(omp_dom::PropId::Status))
			.and_then(omp_dom::Value::as_str),
		Some("blocked")
	);
	assert_eq!(
		item
			.prop(&omp_dom::PropKey::from(omp_dom::PropId::Detail))
			.and_then(omp_dom::Value::as_str),
		Some("waiting on owner")
	);
	let todo_root = find_tag(&session, KnownTag::Todo)[0];
	let phase_order = session
		.dom()
		.get(todo_root)
		.and_then(|node| node.prop(&PropKey::Custom(Str::new_static("phase-order"))))
		.and_then(|value| match value {
			Value::Json(raw) => Some(raw.get()),
			_ => None,
		})
		.expect("phase order");
	assert_eq!(serde_json::from_str::<Vec<Str>>(phase_order).expect("phase order JSON"), vec![
		Str::new_static("Build"),
		Str::new_static("Ship")
	]);
	let malformed = session
		.call("todo", 3, "todo-bad", None, Some(raw(serde_json::json!({}))), None)
		.expect("malformed todo call appends");
	session
		.settle(
			malformed,
			raw(serde_json::json!({
				"op": "init",
				"phases": [{"name": "Broken", "tasks": [
					{"content": "duplicate", "status": "pending"},
					{"content": "duplicate", "status": "pending"}
				]}]
			})),
		)
		.expect("malformed historical result remains transcript data");
	let retained = find_tag(&session, KnownTag::Item);
	assert_eq!(retained.len(), 1, "malformed snapshots never erase valid state");
	assert_eq!(
		session
			.dom()
			.get(retained[0])
			.and_then(|node| node.prop(&PropId::Label.into()))
			.and_then(Value::as_str),
		Some("land substrate")
	);

	let call = session
		.call("bash", 1, "job-1", None, Some(raw(serde_json::json!({}))), None)
		.expect("detached call appends");
	session
		.settle(call, raw(serde_json::json!({"kind":"detached","id":"job-1"})))
		.expect("detached terminal settles");
	assert_eq!(find_tag(&session, KnownTag::Job).len(), 1);
	drop(session);

	let restored = Session::open(path, ComponentRegistry::default()).expect("session restores");
	let restored_items = find_tag(&restored, KnownTag::Item);
	assert_eq!(restored_items.len(), 1);
	assert_eq!(
		restored
			.dom()
			.get(restored_items[0])
			.and_then(|node| node.prop(&PropId::Detail.into()))
			.and_then(Value::as_str),
		Some("waiting on owner")
	);
	let restored_todo = find_tag(&restored, KnownTag::Todo)[0];
	let restored_order = restored
		.dom()
		.get(restored_todo)
		.and_then(|node| node.prop(&PropKey::Custom(Str::new_static("phase-order"))))
		.and_then(|value| match value {
			Value::Json(raw) => serde_json::from_str::<Vec<Str>>(raw.get()).ok(),
			_ => None,
		})
		.expect("replayed phase order");
	assert_eq!(restored_order, vec![Str::new_static("Build"), Str::new_static("Ship")]);
	assert_eq!(find_tag(&restored, KnownTag::Job).len(), 1);
}

#[test]
fn projection_excludes_pre_compaction_turns_and_prepends_summary() {
	let directory = tempfile::tempdir().expect("temporary session directory");
	let path = directory.path().join("compact.oms");
	let store = BlobStore::open(directory.path()).expect("blob store opens");
	let bytes = b"summary of earlier turns";
	let summary = store.put(bytes).expect("summary stores");
	assert_eq!(summary, BlobRef { hash: Hash32::sum(bytes), size: bytes.len() as u64 });
	let mut session = Session::create(&path, ComponentRegistry::default()).expect("session creates");
	session.begin_turn().expect("old turn starts");
	let boundary = session.user("old", Vec::new()).expect("old user appends");
	session
		.assistant_start("model", "provider", "route")
		.expect("post-boundary assistant starts");
	let turn = *session
		.dom()
		.children(session.dom().body())
		.last()
		.expect("turn");
	let assistant = *session.dom().children(turn).last().expect("assistant");
	let sid = session
		.stream_open(assistant, omp_dom::PropId::Text.into())
		.expect("assistant stream opens");
	session
		.stream_append(sid, "after-boundary")
		.expect("assistant delta appends");
	session.stream_close(sid).expect("assistant stream closes");
	session
		.compaction(omp_journal::data::Compaction::new(summary, boundary))
		.expect("compaction appends");
	session.begin_turn().expect("new turn starts");
	session.user("new", Vec::new()).expect("new user appends");

	let items = project_thread(session.dom());
	assert_eq!(items.len(), 3);
	let texts: Vec<_> = items
		.iter()
		.filter_map(|item| match item.kind.as_ref()? {
			item::Kind::Message(message) => match message.parts.first()?.kind.as_ref()? {
				part::Kind::Text(text) => Some(text.as_str()),
				_ => None,
			},
			_ => None,
		})
		.collect();
	assert_eq!(texts, ["summary of earlier turns", "after-boundary", "new"]);
}

#[test]
fn legacy_custom_handoff_normalizes_across_projection_replay_and_branching() {
	let directory = tempfile::tempdir().expect("temporary session directory");
	let path = directory.path().join("legacy-handoff.oms");
	let mut session = Session::create(&path, ComponentRegistry::default()).expect("session creates");
	session.begin_turn().expect("turn starts");
	let boundary = session
		.user("history replaced by handoff", Vec::new())
		.expect("user appends");
	let turn = *session
		.dom()
		.children(session.dom().body())
		.last()
		.expect("turn");
	let legacy = session
		.patch(Txn {
			cause: session.head().expect("head"),
			label: Some(Str::new_static("legacy.custom-message")),
			ops:   vec![Op::Ins {
				parent: turn,
				after:  session.dom().children(turn).last().copied(),
				node:   NodeSpec::new(KnownTag::Notice)
					.with_prop(PropId::Kind, Value::Str(Str::new_static("custom")))
					.with_prop(PropId::Name, Value::Str(Str::new_static("handoff")))
					.with_content(
						"preamble<handoff-context>\n# Goal\nContinue here.\n</handoff-context>trailer",
					),
			}],
		})
		.expect("legacy custom handoff appends");
	session.begin_turn().expect("tail turn starts");
	session.user("tail", Vec::new()).expect("tail appends");

	let compactions = find_tag(&session, KnownTag::Compaction);
	assert_eq!(compactions.len(), 1);
	let compaction = session.dom().get(compactions[0]).expect("compaction");
	assert_eq!(
		compaction
			.prop(&PropId::Method.into())
			.and_then(Value::as_str),
		Some("handoff")
	);
	assert_eq!(
		compaction
			.prop(&PropId::Summary.into())
			.and_then(Value::as_str),
		Some("# Goal\nContinue here.")
	);
	let boundary_text = boundary.to_string();
	assert_eq!(
		compaction
			.prop(&PropId::Boundary.into())
			.and_then(Value::as_str),
		Some(boundary_text.as_str())
	);
	assert!(find_tag(&session, KnownTag::Notice).is_empty());

	let model_text = |session: &Session| {
		project_thread(session.dom())
			.into_iter()
			.filter_map(|item| match item.kind? {
				item::Kind::Message(message) => match message.parts.first()?.kind.as_ref()? {
					part::Kind::Text(text) => Some(text.clone()),
					_ => None,
				},
				_ => None,
			})
			.collect::<Vec<_>>()
	};
	assert_eq!(model_text(&session), ["# Goal\nContinue here.", "tail"]);
	let live = session.dom().snapshot();
	drop(session);

	let mut restored =
		Session::open(&path, ComponentRegistry::default()).expect("legacy handoff replays");
	assert_eq!(restored.dom().snapshot(), live);
	assert_eq!(model_text(&restored), ["# Goal\nContinue here.", "tail"]);

	restored
		.rewind(boundary)
		.expect("branch selects pre-handoff history");
	restored.begin_turn().expect("branch turn starts");
	restored
		.user("alternate branch", Vec::new())
		.expect("branch user appends");
	assert!(find_tag(&restored, KnownTag::Compaction).is_empty());
	assert_eq!(model_text(&restored), ["history replaced by handoff", "alternate branch"]);
	let branched = restored.dom().snapshot();
	drop(restored);

	let reopened = Session::open(&path, ComponentRegistry::default()).expect("branch replays");
	assert_eq!(reopened.dom().snapshot(), branched);
	assert_eq!(model_text(&reopened), ["history replaced by handoff", "alternate branch"]);
	assert!(reopened.entry(legacy).is_some(), "abandoned handoff remains journaled");
}

#[test]
fn projection_through_keeps_only_entries_up_to_the_cut_and_no_summary() {
	use omp_session::project_thread_through;

	let directory = tempfile::tempdir().expect("temporary session directory");
	let path = directory.path().join("through.oms");
	let store = BlobStore::open(directory.path()).expect("blob store opens");
	let bytes = b"older summary";
	let summary = store.put(bytes).expect("summary stores");
	let mut session = Session::create(&path, ComponentRegistry::default()).expect("session creates");
	session.begin_turn().expect("old turn starts");
	let boundary = session.user("old", Vec::new()).expect("old user appends");
	session
		.compaction(omp_journal::data::Compaction::new(summary, boundary))
		.expect("compaction appends");
	session.begin_turn().expect("middle turn starts");
	let cut = session
		.user("middle", Vec::new())
		.expect("middle user appends");
	session.begin_turn().expect("new turn starts");
	session.user("new", Vec::new()).expect("new user appends");

	let items = project_thread_through(session.dom(), cut);
	let texts: Vec<_> = items
		.iter()
		.filter_map(|item| match item.kind.as_ref()? {
			item::Kind::Message(message) => match message.parts.first()?.kind.as_ref()? {
				part::Kind::Text(text) => Some(text.as_str()),
				_ => None,
			},
			_ => None,
		})
		.collect();
	assert_eq!(texts, ["middle"]);
}

#[test]
fn compaction_uses_the_composed_session_blob_store_across_reopen() {
	let directory = tempfile::tempdir().expect("temporary directory");
	let session_dir = directory.path().join("sessions");
	let blob_dir = directory.path().join("artifacts");
	std::fs::create_dir_all(&session_dir).expect("session directory");
	let path = session_dir.join("compact.oms");
	let blobs = BlobStore::open(&blob_dir).expect("blob store opens");
	let mut session = Session::create_with_blob_store(&path, ComponentRegistry::default(), blobs)
		.expect("session creates");
	session.begin_turn().expect("turn starts");
	let boundary = session
		.user("old context", Vec::new())
		.expect("user appends");
	let summary = session
		.blobs()
		.put(b"summary from the composed store")
		.expect("summary stores");
	session
		.compaction(omp_journal::data::Compaction::new(summary, boundary))
		.expect("compaction appends");
	drop(session);

	let blobs = BlobStore::open(&blob_dir).expect("blob store reopens");
	let restored = Session::open_with_blob_store(&path, ComponentRegistry::default(), blobs)
		.expect("session restores");
	let items = project_thread(restored.dom());
	let text = items
		.first()
		.and_then(|item| match item.kind.as_ref()? {
			item::Kind::Message(message) => match message.parts.first()?.kind.as_ref()? {
				part::Kind::Text(text) => Some(text.as_str()),
				_ => None,
			},
			_ => None,
		})
		.expect("summary projects");
	assert_eq!(text, "summary from the composed store");
}

#[test]
fn reopen_journals_abort_results_for_ready_and_partial_calls() {
	let directory = tempfile::tempdir().expect("temporary session directory");
	let path = directory.path().join("streamed-call.oms");
	let mut session = Session::create(&path, ComponentRegistry::default()).expect("session creates");
	session.begin_turn().expect("turn starts");
	session
		.assistant_start("test-model", "test-provider", "test-route")
		.expect("assistant starts tool turn");
	let (ready_call, ready_sid) = session
		.call_streaming("read", 1, "ready-call", None)
		.expect("streaming call starts");
	session
		.stream_append(ready_sid, r#"{"path":"#)
		.expect("first argument delta");
	session
		.stream_append(ready_sid, r#"README.md"}"#)
		.expect("second argument delta");
	session
		.call_ready(ready_call, raw(serde_json::json!({"path":"README.md"})))
		.expect("streaming call becomes executable");
	let (_abandoned_call, abandoned_sid) = session
		.call_streaming("grep", 1, "abandoned-call", None)
		.expect("second streaming call starts");
	session
		.stream_append(abandoned_sid, r#"{"pattern":"#)
		.expect("partial argument delta");
	drop(session);

	let mut restored = Session::open(&path, ComponentRegistry::default()).expect("session restores");
	assert_eq!(restored.unsettled_calls().len(), 2);
	restored
		.recover_process_disappearance()
		.expect("writable owner recovers calls");
	assert!(restored.unsettled_calls().is_empty());
	let statuses: std::collections::BTreeMap<_, _> = restored
		.dom()
		.handles()
		.filter_map(|handle| {
			let node = restored.dom().get(handle)?;
			let Tag::Custom(_) = node.tag else {
				return None;
			};
			let id = node
				.prop(&omp_dom::PropKey::from(omp_dom::PropId::Id))
				.and_then(omp_dom::Value::as_str)?;
			let status = node
				.prop(&omp_dom::PropKey::from(omp_dom::PropId::Status))
				.and_then(omp_dom::Value::as_str)?;
			Some((id.to_owned(), status.to_owned()))
		})
		.collect();
	assert_eq!(statuses.get("ready-call").map(String::as_str), Some("error"));
	assert_eq!(statuses.get("abandoned-call").map(String::as_str), Some("error"));
	let items = project_thread(restored.dom());
	let calls: Vec<_> = items
		.iter()
		.filter_map(|item| match &item.kind {
			Some(item::Kind::ToolCall(call)) => Some((
				call.id.as_str(),
				std::str::from_utf8(call.args_json.as_ref()).expect("canonical UTF-8 arguments"),
			)),
			_ => None,
		})
		.collect();
	let results: Vec<_> = items
		.iter()
		.filter_map(|item| match &item.kind {
			Some(item::Kind::ToolResult(result)) => Some((result.call_id.as_str(), result.is_error)),
			_ => None,
		})
		.collect();
	assert_eq!(calls, [("ready-call", r#"{"path":"README.md"}"#), ("abandoned-call", "{}"),]);
	assert_eq!(results, [("ready-call", true), ("abandoned-call", true)]);
	drop(restored);
	let recovered_journal = std::fs::read(&path).expect("recovered journal bytes");
	let mut reopened = Session::open(&path, ComponentRegistry::default()).expect("session reopens");
	assert!(reopened.unsettled_calls().is_empty(), "recovery is durable");
	assert!(
		!reopened
			.recover_process_disappearance()
			.expect("second owner recovery"),
		"recovery is idempotent"
	);
	drop(reopened);
	assert_eq!(
		std::fs::read(&path).expect("journal bytes"),
		recovered_journal,
		"second reopen appends no duplicate aborts"
	);
}

#[test]
fn streamed_call_carries_intent_on_ready() {
	let directory = tempfile::tempdir().expect("temporary session directory");
	let path = directory.path().join("streamed-intent.oms");
	let mut session = Session::create(&path, ComponentRegistry::default()).expect("session creates");
	session.begin_turn().expect("turn starts");
	let (call, sid) = session
		.call_streaming("read", 1, "intent-call", None)
		.expect("streaming call starts");
	session
		.stream_append(sid, r#"{"i":"Reading project manifest","path":"Cargo.toml"}"#)
		.expect("argument delta");
	session
		.call_ready(
			call,
			raw(serde_json::json!({
				"i": "Reading project manifest",
				"path": "Cargo.toml"
			})),
		)
		.expect("streaming call becomes executable");
	let tool = session
		.dom()
		.handles()
		.find(|handle| {
			session.dom().get(*handle).is_some_and(|node| {
				matches!(node.tag, Tag::Custom(_))
					&& node
						.prop(&omp_dom::PropKey::from(omp_dom::PropId::Id))
						.and_then(omp_dom::Value::as_str)
						== Some("intent-call")
			})
		})
		.expect("tool element exists");
	assert_eq!(
		session
			.dom()
			.get(tool)
			.and_then(|node| node.prop(&omp_dom::PropKey::from(omp_dom::PropId::I)))
			.and_then(omp_dom::Value::as_str),
		Some("Reading project manifest"),
	);
	session
		.settle(call, raw(serde_json::json!({"text":"done"})))
		.expect("call settles");
	let live = session.dom().snapshot();
	drop(session);

	let restored = Session::open(&path, ComponentRegistry::default()).expect("session restores");
	assert_eq!(restored.dom().snapshot().as_bytes(), live.as_bytes());
}

#[test]
fn projected_results_and_reserved_ready_updates_preflight_before_journaling() {
	let directory = tempfile::tempdir().expect("temporary session directory");
	let path = directory.path().join("projected-preflight.oms");
	let mut session = Session::create(&path, ComponentRegistry::default()).expect("session creates");
	session.begin_turn().expect("turn starts");
	let (call, sid) = session
		.call_streaming("read", 1, "call-1", None)
		.expect("streaming call starts");
	session.stream_append(sid, "{}").expect("argument delta");
	let before_file = std::fs::read(&path).expect("journal bytes");
	let before_dom = session.dom().snapshot();
	let malformed_ready = raw(serde_json::json!({"kernel":"ready"}));
	assert!(matches!(
		session.call_update(call, malformed_ready),
		Err(omp_session::SessionError::ReservedToolUpdate)
	));
	assert_eq!(std::fs::read(&path).expect("journal unchanged"), before_file);
	assert_eq!(session.dom().snapshot().as_bytes(), before_dom.as_bytes());
	session
		.call_ready(call, raw(serde_json::json!({})))
		.expect("typed ready succeeds");

	let invalid_parts = raw(serde_json::json!({}));
	let before_file = std::fs::read(&path).expect("journal bytes");
	let before_dom = session.dom().snapshot();
	assert!(
		session
			.settle_projected(call, raw(serde_json::json!({"text":"ok"})), invalid_parts)
			.is_err()
	);
	assert_eq!(std::fs::read(&path).expect("journal unchanged"), before_file);
	assert_eq!(session.dom().snapshot().as_bytes(), before_dom.as_bytes());

	let invalid_utf8_parts = raw(serde_json::json!([{"kind":"json","json":[255]}]));
	let before_file = std::fs::read(&path).expect("journal bytes");
	let before_dom = session.dom().snapshot();
	assert!(matches!(
		session.settle_projected(call, raw(serde_json::json!({"text":"ok"})), invalid_utf8_parts,),
		Err(omp_session::SessionError::ToolPartUtf8 { .. })
	));
	assert_eq!(std::fs::read(&path).expect("journal unchanged"), before_file);
	assert_eq!(session.dom().snapshot().as_bytes(), before_dom.as_bytes());

	let second = session
		.call("grep", 1, "call-2", None, Some(raw(serde_json::json!({}))), None)
		.expect("second call");
	let before_file = std::fs::read(&path).expect("journal bytes");
	let before_dom = session.dom().snapshot();
	assert!(
		session
			.fail_projected(second, raw(serde_json::json!({"code":"bad"})), raw(serde_json::json!({})),)
			.is_err()
	);
	assert_eq!(std::fs::read(&path).expect("journal unchanged"), before_file);
	assert_eq!(session.dom().snapshot().as_bytes(), before_dom.as_bytes());
}

/// ADR 0008: the settled element carries the tool's durable truth. The
/// journaled `CallOutcome` envelope lands on `<result outcome>` (or `<diag
/// fault>`), while `data` stays the model-facing prompt parts, and both
/// survive a reopen.
#[test]
fn settled_calls_carry_the_journaled_outcome_beside_the_prompt_parts() {
	use omp_dom::{KnownTag, PropId, PropKey, Tag, Value};
	let directory = tempfile::tempdir().expect("temporary session directory");
	let path = directory.path().join("outcome-truth.oms");
	let mut session = Session::create(&path, ComponentRegistry::default()).expect("session creates");
	session.begin_turn().expect("turn starts");
	let ok = session
		.call("bash", 1, "call-ok", None, Some(raw(serde_json::json!({"command":"true"}))), None)
		.expect("call");
	let outcome =
		serde_json::json!({"kind":"ok","value":{"transcript":[],"status":{"exit_code":0}}});
	session
		.settle_projected(ok, raw(outcome.clone()), raw(serde_json::json!([])))
		.expect("settles");
	let failed = session
		.call(
			"bash",
			1,
			"call-aborted",
			None,
			Some(raw(serde_json::json!({"command":"sleep 9"}))),
			None,
		)
		.expect("call");
	let fault = serde_json::json!({"kind":"aborted","value":{"abort":{"kind":"interrupted","reason":"cancelled"},"kind":"cancelled"}});
	session
		.fail_projected(
			failed,
			raw(fault.clone()),
			raw(serde_json::json!([{"kind":"text","text":"interrupted: cancelled"}])),
		)
		.expect("fails");

	let check = |session: &Session| {
		let dom = session.dom();
		let tool = |id: &str| -> omp_dom::Handle {
			dom.handles()
				.find(|handle| {
					dom.get(*handle).is_some_and(|node| {
						matches!(node.tag, Tag::Custom(_))
							&& node
								.prop(&PropKey::from(PropId::Id))
								.and_then(Value::as_str)
								== Some(id)
					})
				})
				.expect("tool element exists")
		};
		let child_json = |id: &str, tag: KnownTag, prop: PropId| -> serde_json::Value {
			let child = dom
				.children(tool(id))
				.iter()
				.copied()
				.find(|handle| {
					dom.get(*handle)
						.is_some_and(|node| node.tag == Tag::Known(tag))
				})
				.expect("child element");
			match dom
				.get(child)
				.and_then(|node| node.prop(&PropKey::from(prop)).cloned())
			{
				Some(Value::Json(json)) => serde_json::from_str(json.get()).expect("json prop"),
				other => panic!("{prop:?} missing: {other:?}"),
			}
		};
		assert_eq!(child_json("call-ok", KnownTag::Result, PropId::Outcome), outcome);
		assert_eq!(child_json("call-ok", KnownTag::Result, PropId::Data), serde_json::json!([]));
		assert_eq!(child_json("call-aborted", KnownTag::Diag, PropId::Fault), fault);
		let diag = dom
			.children(tool("call-aborted"))
			.iter()
			.copied()
			.find(|handle| {
				dom.get(*handle)
					.is_some_and(|node| node.tag == Tag::Known(KnownTag::Diag))
			})
			.expect("diag element");
		assert_eq!(
			dom.get(diag).and_then(|node| node
				.prop(&PropKey::from(PropId::Text))
				.and_then(Value::as_str)),
			Some("interrupted: cancelled"),
		);
	};
	check(&session);
	let live = session.dom().snapshot();
	drop(session);
	let restored = Session::open(&path, ComponentRegistry::default()).expect("session restores");
	assert_eq!(restored.dom().snapshot().as_bytes(), live.as_bytes());
	check(&restored);
}

#[test]
fn assistant_receipts_pair_in_turn_order() {
	let directory = tempfile::tempdir().expect("temporary session directory");
	let mut session =
		Session::create(directory.path().join("receipts.oms"), ComponentRegistry::default())
			.expect("session creates");
	session.begin_turn().expect("turn starts");
	session.user("question", Vec::new()).expect("user appends");
	session
		.assistant_start("model", "provider", "route")
		.expect("first assistant starts");
	session
		.assistant_end("tool_use")
		.expect("first assistant ends");
	session
		.receipt(omp_journal::data::TurnReceipt::tokens(1, 2, 3))
		.expect("first receipt");
	let call = session
		.call("read", 1, "call-1", None, Some(raw(serde_json::json!({}))), None)
		.expect("call");
	session
		.settle(call, raw(serde_json::json!({"text":"ok"})))
		.expect("call settles");
	session
		.assistant_start("model", "provider", "route")
		.expect("second assistant starts");
	let turn = *session
		.dom()
		.children(session.dom().body())
		.last()
		.expect("turn");
	let second = *session
		.dom()
		.children(turn)
		.last()
		.expect("second assistant");
	let sid = session
		.stream_open(second, omp_dom::PropId::Text.into())
		.expect("stream opens");
	session.stream_append(sid, "done").expect("stream appends");
	session.stream_close(sid).expect("stream closes");
	session
		.assistant_end("stop")
		.expect("second assistant ends");
	session
		.receipt(omp_journal::data::TurnReceipt::tokens(10, 20, 30))
		.expect("second receipt");

	let usage: Vec<_> = project_thread(session.dom())
		.into_iter()
		.filter_map(|item| match item.kind {
			Some(item::Kind::Message(message))
				if message.role == omp_proto::thread::v1::Role::Assistant as i32 =>
			{
				message
					.usage
					.map(|usage| (usage.input_tokens, usage.output_tokens))
			},
			_ => None,
		})
		.collect();
	assert_eq!(usage, [(1, 2), (10, 20)]);
}

#[test]
fn diagnostics_are_separate_ordered_children_and_fault_is_last() {
	use omp_dom::{PropId, PropKey, Value};

	let directory = tempfile::tempdir().expect("temporary session directory");
	let path = directory.path().join("diagnostics.oms");
	let mut session = Session::create(&path, ComponentRegistry::default()).expect("session creates");
	session.begin_turn().expect("turn starts");
	let call = session
		.call("read", 1, "call-1", None, Some(raw(serde_json::json!({}))), None)
		.expect("call");
	session
		.call_update(call, raw(serde_json::json!({"diag":{"severity":"warn","text":"first"}})))
		.expect("first diagnostic");
	session
		.call_update(call, raw(serde_json::json!({"diag":{"severity":"info","text":"second"}})))
		.expect("second diagnostic");
	session
		.fail_projected(
			call,
			raw(serde_json::json!({"kind":"faulted","value":{"code":"failed"}})),
			raw(serde_json::json!([{"kind":"text","text":"failed"}])),
		)
		.expect("fault settles");

	let inspect = |session: &Session| {
		let dom = session.dom();
		let call = dom
			.handles()
			.find(|handle| {
				dom.get(*handle).is_some_and(|node| {
					matches!(node.tag, Tag::Custom(_))
						&& node
							.prop(&PropKey::from(PropId::Id))
							.and_then(Value::as_str)
							== Some("call-1")
				})
			})
			.expect("call element");
		dom.children(call)
			.iter()
			.filter_map(|handle| {
				let node = dom.get(*handle)?;
				(node.tag == Tag::Known(KnownTag::Diag)).then(|| {
					(
						node
							.prop(&PropKey::from(PropId::Severity))
							.and_then(Value::as_str)
							.unwrap_or_default()
							.to_owned(),
						node.prop(&PropKey::from(PropId::Fault)).is_some(),
					)
				})
			})
			.collect::<Vec<_>>()
	};
	assert_eq!(inspect(&session), [
		("warn".to_owned(), false),
		("info".to_owned(), false),
		("error".to_owned(), true),
	]);
	let live = session.dom().snapshot();
	drop(session);
	let reopened = Session::open(&path, ComponentRegistry::default()).expect("session reopens");
	assert_eq!(reopened.dom().snapshot(), live);
	assert_eq!(inspect(&reopened), [
		("warn".to_owned(), false),
		("info".to_owned(), false),
		("error".to_owned(), true),
	]);
}

/// Even before the controller can journal crash recovery, projection remains
/// acceptable to strict providers by omitting all in-flight calls.
#[test]
fn live_projection_never_emits_an_unmatched_tool_call() {
	let directory = tempfile::tempdir().expect("temporary session directory");
	let path = directory.path().join("unfinished.oms");
	let mut session = Session::create(&path, ComponentRegistry::default()).expect("session creates");
	session.begin_turn().expect("turn starts");
	session.user("question", Vec::new()).expect("user appends");
	session
		.assistant_start("model", "provider", "route")
		.expect("assistant starts");
	session
		.call(
			"read",
			1,
			"call-running",
			None,
			Some(raw(serde_json::json!({"path":"README.md"}))),
			None,
		)
		.expect("committed call appends");
	session
		.call_streaming("grep", 1, "call-arguments", None)
		.expect("streaming call appends");
	let items = project_thread(session.dom());
	let mut calls = Vec::new();
	let mut results = Vec::new();
	for item in &items {
		match &item.kind {
			Some(item::Kind::ToolCall(call)) => calls.push(call.id.clone()),
			Some(item::Kind::ToolResult(result)) => {
				results.push((result.call_id.clone(), result.is_error))
			},
			_ => {},
		}
	}
	assert!(calls.is_empty(), "in-flight calls are not historical context");
	assert!(results.is_empty(), "omitted calls have no orphan results");
}

fn message_texts(items: &[omp_proto::thread::v1::Item]) -> Vec<(i32, Option<String>)> {
	items
		.iter()
		.filter_map(|item| match item.kind.as_ref()? {
			item::Kind::Message(message) => Some((
				message.role,
				message
					.parts
					.first()
					.and_then(|part| match part.kind.as_ref()? {
						part::Kind::Text(text) => Some(text.clone()),
						_ => None,
					}),
			)),
			_ => None,
		})
		.collect()
}

#[test]
fn steering_user_message_projects_with_interjection_envelope() {
	use omp_dom::{NodeSpec, Op, PropKey, Txn, Value};
	use omp_session::projection::{STEERING_ENVELOPE, STEERING_PROP};

	let directory = tempfile::tempdir().expect("temporary session directory");
	let mut session =
		Session::create(directory.path().join("steering.oms"), ComponentRegistry::default())
			.expect("session creates");
	session.begin_turn().expect("turn starts");
	session.user("question", Vec::new()).expect("user appends");
	let turn = *session
		.dom()
		.children(session.dom().body())
		.last()
		.expect("turn");
	let append_user = |session: &mut Session, text: &'static str, steering: bool| {
		let mut node = NodeSpec::new(KnownTag::User).with_content(Str::new_static(text));
		if steering {
			node = node.with_prop(PropKey::Custom(Str::new_static(STEERING_PROP)), Value::Bool(true));
		}
		session
			.patch(Txn {
				cause: session.head().expect("head"),
				label: Some(Str::new_static("steering.safe-point")),
				ops:   vec![Op::Ins {
					parent: turn,
					after: session.dom().children(turn).last().copied(),
					node,
				}],
			})
			.expect("user inserts");
	};
	append_user(&mut session, "actually use <xml> & tabs", true);
	append_user(&mut session, "", true);
	append_user(&mut session, "plain follow-up", false);

	let items = project_thread(session.dom());
	let user = omp_proto::thread::v1::Role::User as i32;
	assert_eq!(message_texts(&items), [
		(user, Some("question".to_owned())),
		(user, Some(format!("{STEERING_ENVELOPE}actually use <xml> & tabs"))),
		(user, Some(String::new())),
		(user, Some("plain follow-up".to_owned())),
	]);
	assert!(STEERING_ENVELOPE.starts_with("<system-notice>\nUser interjection during work"));
	let journaled = session
		.dom()
		.children(turn)
		.iter()
		.filter_map(|handle| session.dom().get(*handle)?.content.clone())
		.collect::<Vec<_>>();
	assert!(
		journaled
			.iter()
			.all(|text| !text.contains("<system-notice>")),
		"the envelope is a projection, never journaled"
	);
}

#[test]
fn empty_assistant_messages_are_omitted_from_projection() {
	let directory = tempfile::tempdir().expect("temporary session directory");
	let mut session =
		Session::create(directory.path().join("empty.oms"), ComponentRegistry::default())
			.expect("session creates");
	session.begin_turn().expect("turn starts");
	session.user("question", Vec::new()).expect("user appends");
	session
		.assistant_start("model", "provider", "route")
		.expect("empty assistant starts");
	session.assistant_end("stop").expect("empty assistant ends");
	session
		.receipt(omp_journal::data::TurnReceipt::tokens(1, 0, 0))
		.expect("empty receipt");
	session
		.assistant_start("model", "provider", "route")
		.expect("tool-only assistant starts");
	session
		.assistant_end("tool_use")
		.expect("tool-only assistant ends");
	session
		.receipt(omp_journal::data::TurnReceipt::tokens(5, 6, 0))
		.expect("tool-only receipt");
	let call = session
		.call("read", 1, "call-1", None, Some(raw(serde_json::json!({}))), None)
		.expect("call");
	session
		.settle(call, raw(serde_json::json!({"text":"ok"})))
		.expect("call settles");
	session
		.assistant_start("model", "provider", "route")
		.expect("final assistant starts");
	let turn = *session
		.dom()
		.children(session.dom().body())
		.last()
		.expect("turn");
	let assistant = *session.dom().children(turn).last().expect("assistant");
	let sid = session
		.stream_open(assistant, omp_dom::PropId::Text.into())
		.expect("stream opens");
	session
		.stream_append(sid, "answer")
		.expect("stream appends");
	session.stream_close(sid).expect("stream closes");
	session.assistant_end("stop").expect("final assistant ends");
	session
		.receipt(omp_journal::data::TurnReceipt::tokens(10, 20, 0))
		.expect("final receipt");

	let items = project_thread(session.dom());
	let assistants: Vec<_> = items
		.iter()
		.filter_map(|item| match item.kind.as_ref()? {
			item::Kind::Message(message)
				if message.role == omp_proto::thread::v1::Role::Assistant as i32 =>
			{
				Some((
					message.parts.len(),
					message
						.usage
						.as_ref()
						.map(|usage| (usage.input_tokens, usage.output_tokens)),
				))
			},
			_ => None,
		})
		.collect();
	assert_eq!(
		assistants,
		[(0, Some((5, 6))), (1, Some((10, 20)))],
		"the empty assistant vanishes with its receipt; the tool-issuing one and the final one stay"
	);
	assert_eq!(
		items
			.iter()
			.filter(|item| matches!(item.kind, Some(item::Kind::ToolCall(_))))
			.count(),
		1
	);
}

/// A journaled user prompt with a PNG attachment projects a typed media part:
/// the blob reference plus `image/png`, the MIME persisted with the reference
/// at journal time. Replay projects the same part, so the provider request
/// never depends on process memory.
#[test]
fn user_attachment_projects_a_media_part_with_its_mime() {
	let directory = tempfile::tempdir().expect("temporary session directory");
	let path = directory.path().join("media.oms");
	let png = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR\0\0\0\x04\0\0\0\x03";
	let mut session = Session::create(&path, ComponentRegistry::default()).expect("session creates");
	let attachment = session
		.store_attachment("image/png", png)
		.expect("attachment stores");
	assert_eq!(attachment.blob, BlobRef { hash: Hash32::sum(png), size: png.len() as u64 });
	assert_eq!(
		session
			.blobs()
			.get(&attachment.blob)
			.expect("bytes stored")
			.as_ref(),
		png
	);
	session.begin_turn().expect("turn starts");
	session
		.user("what is this? [Image #1, 4x3]", vec![attachment.clone()])
		.expect("user appends");

	let media = |session: &Session| {
		project_thread(session.dom())
			.into_iter()
			.filter_map(|item| match item.kind? {
				item::Kind::Message(message)
					if message.role == omp_proto::thread::v1::Role::User as i32 =>
				{
					Some(message.parts)
				},
				_ => None,
			})
			.flatten()
			.filter_map(|part| match part.kind? {
				part::Kind::Blob(blob) => Some(blob),
				_ => None,
			})
			.collect::<Vec<_>>()
	};
	let live = media(&session);
	assert_eq!(live.len(), 1);
	assert_eq!(live[0].mime, "image/png");
	assert_eq!(live[0].hash.as_ref(), attachment.blob.hash.as_bytes());
	assert_eq!(live[0].size, png.len() as u64);
	assert!(live[0].inline.is_empty(), "the projection never inlines bytes");

	drop(session);
	let restored = Session::open(&path, ComponentRegistry::default()).expect("session restores");
	assert_eq!(media(&restored), live);
}

#[test]
fn file_mentions_split_text_and_images_without_losing_order_on_replay() {
	use omp_journal::data::{FileMentions, MentionedFile, MentionedFileState};
	use omp_proto::thread::v1::Role;
	use omp_session::file_mentions;

	let directory = tempfile::tempdir().expect("temporary session directory");
	let path = directory.path().join("file-mentions.oms");
	let png = b"\x89PNG\r\n\x1a\nmention";
	let mut session = Session::create(&path, ComponentRegistry::default()).expect("session creates");
	let attachment = session
		.store_attachment("image/png", png)
		.expect("image stores");
	session.begin_turn().expect("turn starts");
	session
		.user("inspect @a.txt and @b.png", Vec::new())
		.expect("user appends");
	session
		.file_mentions(FileMentions {
			files: vec![
				MentionedFile {
					path:    Str::new_static("a.txt"),
					content: Str::new_static("alpha"),
					state:   MentionedFileState::Lines { line_count: Some(1) },
				},
				MentionedFile {
					path:    Str::new_static("b.png"),
					content: Str::default(),
					state:   MentionedFileState::Image { attachment: attachment.clone() },
				},
				MentionedFile {
					path:    Str::new_static("c.bin"),
					content: Str::default(),
					state:   MentionedFileState::SkippedBinary { byte_size: Some(64) },
				},
			],
		})
		.expect("mentions append");

	let mention_node = session
		.dom()
		.children(
			*session
				.dom()
				.children(session.dom().body())
				.last()
				.expect("turn"),
		)
		.iter()
		.filter_map(|handle| session.dom().get(*handle))
		.find(|node| file_mentions(node).is_some())
		.expect("typed mention node");
	assert_eq!(
		file_mentions(mention_node)
			.expect("payload decodes")
			.files
			.iter()
			.map(|file| file.path.as_str())
			.collect::<Vec<_>>(),
		["a.txt", "b.png", "c.bin"]
	);

	let live = project_thread(session.dom());
	assert_eq!(live.len(), 3, "authored user, text mentions, image mentions");
	let messages = live
		.iter()
		.map(|item| match item.kind.as_ref().expect("item kind") {
			item::Kind::Message(message) => message,
			other => panic!("expected message, got {other:?}"),
		})
		.collect::<Vec<_>>();
	assert_eq!(
		messages
			.iter()
			.map(|message| message.role)
			.collect::<Vec<_>>(),
		[Role::User as i32, Role::System as i32, Role::User as i32]
	);
	let system_text = messages[1].parts[0].kind.as_ref().expect("system text");
	assert_eq!(
		system_text,
		&part::Kind::Text(
			"<file path=\"a.txt\">\nalpha\n</file>\n<file path=\"c.bin\">\n\n</file>".to_owned()
		)
	);
	assert_eq!(
		messages[2].parts[0].kind.as_ref(),
		Some(&part::Kind::Text("<file path=\"b.png\">\n\n</file>".to_owned()))
	);
	let Some(part::Kind::Blob(blob)) = messages[2].parts[1].kind.as_ref() else {
		panic!("image mention blob");
	};
	assert_eq!(blob.mime, "image/png");
	assert_eq!(blob.hash.as_ref(), attachment.blob.hash.as_bytes());

	drop(session);
	let restored = Session::open(&path, ComponentRegistry::default()).expect("session restores");
	assert_eq!(project_thread(restored.dom()), live);
}
