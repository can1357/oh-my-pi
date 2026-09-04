//! P2: cancellation reaches every runtime scope without corrupting durable
//! truth.

use std::sync::Arc;

use omp_agent::{
	CancelTree, DispatchPolicy, Kernel, RunControl, StaticPrompt, TurnInput, TurnStop, Up,
};
use omp_ai::{ChatEvent, Completion, ExecutionReceipt, FinishReason, Usage};
use omp_core::Str;
use omp_e2e::support::{
	ScriptedInference, assert_all_entries_caused, create_session, journal_entries,
};
use omp_journal::{blob::BlobStore, kind};
use omp_tool::Registry;

fn completion() -> Vec<ChatEvent> {
	vec![ChatEvent::Completed(Completion {
		reason:  FinishReason::Stop,
		blocks:  0,
		usage:   Usage::default(),
		receipt: ExecutionReceipt::default().into(),
	})]
}

fn input() -> TurnInput {
	TurnInput { text: Str::new_static("cancel me"), attachments: Vec::new() }
}

#[tokio::test]
async fn p2_cancel_tree_interrupts_read_and_background_but_not_foreground_mutation() {
	let tree = CancelTree::new();
	let turn = tree.begin_turn();
	let foreground = turn.foreground_mutation();
	let read = turn.read_only_tool();
	let background = turn.background_tool();
	turn.cancel_turn();
	assert!(!foreground.is_cancelled(), "authorized mutation remains session-scoped");
	assert!(read.is_cancelled());
	assert!(background.is_cancelled());
	tree.cancel_session();
	assert!(foreground.is_cancelled());
}

#[tokio::test]
async fn p2_kernel_interrupt_records_no_false_completion_and_replays() {
	let temp = tempfile::tempdir().expect("P2 scratch");
	let path = temp.path().join("interrupt.oms");
	let (inference, _) = ScriptedInference::new([completion()]);
	let mut kernel = Kernel::new(
		inference,
		Arc::new(Registry::new()),
		DispatchPolicy::new(BlobStore::open(temp.path().join("blobs")).expect("blob store")),
		StaticPrompt(Str::new_static("P2")),
	);
	kernel
		.mailbox()
		.send(Up::Interrupt)
		.expect("queue interrupt");
	let mut session = create_session(&path).expect("session");
	let outcome = kernel
		.run_turn(&mut session, input(), RunControl::default())
		.await
		.expect("turn");
	assert_eq!(outcome.stop, TurnStop::Cancelled);
	drop(session);
	let entries = journal_entries(&path);
	assert_all_entries_caused(&entries);
	assert!(
		!entries
			.iter()
			.any(|entry| entry.kind.name.as_str() == kind::MSG_ASSISTANT_END)
	);
	assert!(
		!entries
			.iter()
			.any(|entry| entry.kind.name.as_str() == kind::TURN_RECEIPT)
	);
	let replay = omp_session::Session::open(&path, omp_session::ComponentRegistry::standard())
		.expect("cancelled journal replays");
	assert_eq!(replay.dom().select("body turn").expect("selector").count(), 1);
	assert_eq!(
		replay
			.dom()
			.select("body turn assistant")
			.expect("selector")
			.count(),
		0
	);
}

#[tokio::test]
async fn p2_kernel_cancel_ends_session_and_future_turns() {
	let temp = tempfile::tempdir().expect("P2 scratch");
	let path = temp.path().join("cancel.oms");
	let (inference, _) = ScriptedInference::new([completion(), completion()]);
	let mut kernel = Kernel::new(
		inference,
		Arc::new(Registry::new()),
		DispatchPolicy::new(BlobStore::open(temp.path().join("blobs")).expect("blob store")),
		StaticPrompt(Str::new_static("P2")),
	);
	kernel.mailbox().send(Up::Cancel).expect("queue cancel");
	let mut session = create_session(&path).expect("session");
	let first = kernel
		.run_turn(&mut session, input(), RunControl::default())
		.await
		.expect("first");
	assert_eq!(first.stop, TurnStop::Cancelled);
	let second = kernel
		.run_turn(&mut session, input(), RunControl::default())
		.await
		.expect("second");
	assert_eq!(second.stop, TurnStop::Cancelled);
	drop(session);
	assert_all_entries_caused(&journal_entries(&path));
}
