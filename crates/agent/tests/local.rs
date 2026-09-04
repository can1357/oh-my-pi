//! `Kernel::run_local`: the `!`/`$` prefix modes journal an explicitly local
//! turn and never call inference.

use omp_agent::{
	DispatchPolicy, Kernel, KernelEvent, LocalRunKind, RunControl, StaticPrompt, TurnStop,
};
use omp_core::Str;
use omp_dom::{KnownTag, PropId, PropKey, Tag, Value};
use omp_journal::{blob::BlobStore, kind};
use omp_session::project_thread;

mod support;

use support::{
	ScriptedInference, assert_all_entries_caused, fresh_session, journal_entries, registry, spec,
};

#[tokio::test]
async fn local_run_journals_one_tool_turn_without_inference() {
	let directory = tempfile::tempdir().expect("temporary directory");
	let journal_path = directory.path().join("local.oms");
	let (inference, requests) = ScriptedInference::new(Vec::<Vec<omp_ai::ChatEvent>>::new());
	let mut kernel = Kernel::new(
		inference,
		registry([spec("bash", 1, "hi")]),
		DispatchPolicy::new(BlobStore::open(directory.path().join("blobs")).expect("blob store")),
		StaticPrompt(Str::new_static("test system")),
	);
	let events = kernel.subscribe();
	let mut session = fresh_session(&journal_path);

	let outcome = kernel
		.run_local(
			&mut session,
			omp_agent::LocalRun {
				kind:    LocalRunKind::Bash,
				input:   Str::new_static("echo hi"),
				exclude: false,
			},
			RunControl::default(),
		)
		.await
		.expect("local run completes");

	assert_eq!(outcome.stop, TurnStop::Completed);
	assert!(requests.lock().is_empty(), "no inference request left the kernel");
	let events = events.try_iter().collect::<Vec<_>>();
	assert!(matches!(events[0], KernelEvent::ToolReady { ref name, .. } if name == "bash"));
	assert!(matches!(events.last(), Some(KernelEvent::TurnEnded { stop: TurnStop::Completed })));

	let dom = session.dom();
	let turn = *dom.children(dom.body()).last().expect("one turn");
	let children = dom
		.children(turn)
		.iter()
		.map(|handle| dom.get(*handle).expect("node").tag.clone())
		.collect::<Vec<_>>();
	assert_eq!(children, [Tag::Custom(Str::new_static("bash"))], "only the local element");
	let element = dom.get(dom.children(turn)[0]).expect("tool element");
	assert_eq!(
		element
			.prop(&PropKey::from(PropId::Status))
			.and_then(Value::as_str),
		Some("ok")
	);
	assert!(
		element
			.prop(&PropKey::from(PropId::Id))
			.and_then(Value::as_str)
			.is_some_and(|id| id.starts_with("local-"))
	);
	assert_eq!(
		element
			.prop(&PropKey::Custom(Str::new_static(omp_agent::LOCAL_PRESENTATION_PROP)))
			.and_then(Value::as_str),
		Some(omp_agent::LOCAL_PRESENTATION_VALUE)
	);
	assert_eq!(
		element
			.prop(&PropKey::Custom(Str::new_static(omp_agent::LOCAL_INPUT_PROP)))
			.and_then(Value::as_str),
		Some("echo hi")
	);

	let entries = journal_entries(&journal_path);
	assert_all_entries_caused(&entries);
	let kinds = entries
		.iter()
		.map(|entry| entry.kind.name.as_str().to_owned())
		.collect::<Vec<_>>();
	assert!(kinds.contains(&kind::TURN_START.to_owned()));
	assert!(kinds.contains(&kind::TOOL_CALL.to_owned()));
	assert!(kinds.contains(&kind::TOOL_RESULT.to_owned()));
	assert!(!kinds.contains(&kind::MSG_ASSISTANT_START.to_owned()));
	assert!(!kinds.contains(&kind::MSG_USER.to_owned()));

	// The model sees what ran as a user message.
	let items = project_thread(dom);
	let texts = items
		.iter()
		.filter_map(|item| match item.kind.as_ref()? {
			omp_proto::thread::v1::item::Kind::Message(message) => Some(message),
			_ => None,
		})
		.filter(|message| message.role == omp_proto::thread::v1::Role::User as i32)
		.flat_map(|message| message.parts.iter())
		.filter_map(|part| match part.kind.as_ref()? {
			omp_proto::thread::v1::part::Kind::Text(text) => Some(text.clone()),
			_ => None,
		})
		.collect::<Vec<_>>();
	assert_eq!(texts.len(), 1, "one user message for the run: {items:?}");
	assert!(texts[0].starts_with("Ran `echo hi`\n"), "{}", texts[0]);
	assert!(texts[0].contains("```\nhi"), "{}", texts[0]);
	assert!(
		dom.get(turn)
			.is_some_and(|node| node.tag == Tag::Known(KnownTag::Turn))
	);
}

#[tokio::test]
async fn excluded_local_run_is_hidden_from_the_thread() {
	let directory = tempfile::tempdir().expect("temporary directory");
	let journal_path = directory.path().join("hidden.oms");
	let (inference, _) = ScriptedInference::new(Vec::<Vec<omp_ai::ChatEvent>>::new());
	let mut kernel = Kernel::new(
		inference,
		registry([spec("bash", 1, "hi")]),
		DispatchPolicy::new(BlobStore::open(directory.path().join("blobs")).expect("blob store")),
		StaticPrompt(Str::new_static("test system")),
	);
	let mut session = fresh_session(&journal_path);
	kernel
		.run_local(
			&mut session,
			omp_agent::LocalRun {
				kind:    LocalRunKind::Bash,
				input:   Str::new_static("echo hi"),
				exclude: true,
			},
			RunControl::default(),
		)
		.await
		.expect("local run completes");
	assert!(project_thread(session.dom()).is_empty(), "an excluded run projects nothing");
}
