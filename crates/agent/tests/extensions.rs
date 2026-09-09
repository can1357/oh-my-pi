//! Live extension Component journal/replay contract.

use omp_agent::{
	DispatchPolicy, Kernel, LiveComponent, LiveComponentError, RunControl, StaticPrompt, TurnInput,
};
use omp_core::Str;
use omp_dom::{Dom, NodeSpec, Op, Tag};
use omp_journal::{Entry, Kind, blob::BlobStore, kind};
use omp_session::{ComponentRegistry, Session};

mod support;

use support::{ScriptedInference, fresh_session, journal_entries, registry, text_script};

struct ExtState;

impl LiveComponent for ExtState {
	fn id(&self) -> &str {
		"test-state"
	}

	fn interested(&self, kind: &Kind) -> bool {
		kind.name.as_str() == kind::MSG_USER
	}

	fn reduce(&self, _: &Entry, dom: &Dom) -> Result<Vec<Op>, LiveComponentError> {
		let meta = dom.meta();
		Ok(vec![Op::Ins {
			parent: meta,
			after:  dom.children(meta).last().copied(),
			node:   NodeSpec::new(Tag::Custom(Str::new_static("ext-state"))),
		}])
	}
}

#[tokio::test]
async fn extensions_live_component_patch_is_journaled_once_and_replays_without_callback() {
	let directory = tempfile::tempdir().expect("temporary directory");
	let journal_path = directory.path().join("extension.oms");
	let (inference, _) = ScriptedInference::new([text_script("pong")]);
	let mut kernel = Kernel::new(
		inference,
		registry(std::iter::empty()),
		DispatchPolicy::new(BlobStore::open(directory.path().join("blobs")).expect("blob store")),
		StaticPrompt(Str::new_static("test system")),
	);
	kernel.register_live_component(Box::new(ExtState));
	let mut session = fresh_session(&journal_path);
	kernel
		.run_turn(
			&mut session,
			TurnInput { text: Str::new_static("hello"), attachments: Vec::new() },
			RunControl::default(),
		)
		.await
		.expect("turn completes");

	assert_eq!(session.dom().select("ext-state").expect("selector").count(), 1);
	let live = session.dom().snapshot();
	let entries = journal_entries(&journal_path);
	let user = entries
		.iter()
		.find(|entry| entry.kind.name.as_str() == kind::MSG_USER)
		.expect("user entry");
	let patch = entries
		.iter()
		.find(|entry| entry.label.as_deref() == Some("ext:test-state"))
		.expect("component patch");
	assert_eq!(patch.kind.name.as_str(), kind::PATCH);
	assert_eq!(patch.by, Some(user.id));

	drop(session);
	let replayed = Session::open(&journal_path, ComponentRegistry::standard()).expect("replay");
	assert_eq!(replayed.dom().snapshot(), live);
}
