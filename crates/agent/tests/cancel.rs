//! Cancellation-tree propagation and foreground-commit atomicity contracts.

use std::{fs, sync::Arc};

use omp_agent::CancelTree;
use tokio::sync::{Notify, oneshot};

#[tokio::test]
async fn turn_interrupt_cannot_half_apply_foreground_mutation() {
	let dir = tempfile::tempdir().expect("temporary directory");
	let path = dir.path().join("document.txt");
	fs::write(&path, "before").expect("seed document");
	let tree = CancelTree::new();
	let turn = tree.begin_turn();
	let cancellation = turn.foreground_mutation();
	let started = Arc::new(Notify::new());
	let finish = Arc::new(Notify::new());
	let (outcome_tx, outcome_rx) = oneshot::channel();
	let task_path = path.clone();
	let task_started = Arc::clone(&started);
	let task_finish = Arc::clone(&finish);
	let task = tokio::spawn(async move {
		fs::write(&task_path, "partial").expect("write first stage");
		task_started.notify_one();
		let completed = tokio::select! {
			() = cancellation.token().cancelled_owned() => false,
			() = task_finish.notified() => {
				fs::write(&task_path, "after").expect("commit complete mutation");
				true
			}
		};
		let _ = outcome_tx.send(completed);
	});
	started.notified().await;
	turn.cancel_turn();
	finish.notify_one();
	task.await.expect("mutation task joins");
	assert!(outcome_rx.await.expect("mutation reports outcome"));
	assert_eq!(fs::read_to_string(path).expect("read result"), "after");
}

#[tokio::test]
async fn turn_interrupt_cancels_read_only_and_background_tools() {
	let tree = CancelTree::new();
	let turn = tree.begin_turn();
	let read = turn.read_only_tool();
	let background = turn.background_tool();
	let read_wait = tokio::spawn(async move { read.token().cancelled_owned().await });
	let background_wait = tokio::spawn(async move { background.token().cancelled_owned().await });
	turn.cancel_turn();
	read_wait.await.expect("read cancellation");
	background_wait.await.expect("background cancellation");
}

#[tokio::test]
async fn session_cancel_aborts_every_scope() {
	let tree = CancelTree::new();
	let first_turn = tree.begin_turn();
	let second_turn = tree.begin_turn();
	let mutating = first_turn.foreground_mutation();
	let read = first_turn.read_only_tool();
	let background = second_turn.background_tool();
	let mutating_wait = tokio::spawn(async move { mutating.token().cancelled_owned().await });
	let read_wait = tokio::spawn(async move { read.token().cancelled_owned().await });
	let background_wait = tokio::spawn(async move { background.token().cancelled_owned().await });
	tree.cancel_session();
	mutating_wait.await.expect("foreground cancellation");
	read_wait.await.expect("read cancellation");
	background_wait.await.expect("background cancellation");
	assert!(tree.is_session_cancelled());
	assert!(first_turn.is_turn_cancelled());
	assert!(second_turn.is_turn_cancelled());
	let future_turn = tree.begin_turn();
	assert!(future_turn.is_turn_cancelled());
	assert!(future_turn.foreground_mutation().is_cancelled());
	assert!(future_turn.read_only_tool().is_cancelled());
	assert!(future_turn.background_tool().is_cancelled());
}
