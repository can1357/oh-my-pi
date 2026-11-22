//! The run journal chains its records, resumes only the same definition, and
//! stops at a terminal record.

use omp_core::Str;
use omp_journal::{
	Journal, JournalError,
	idempotency::IdempotencyKey,
	runlog::{
		EffectKey, InputVersion, PhaseDispatch, PhaseSettle, RunDone, RunHalt, RunLog, RunLogError,
		RunRecord, RunStart, SettleStatus, vocabulary,
	},
};
use tempfile::tempdir;

fn start(digest: &str) -> RunStart {
	RunStart {
		run:                 Str::new_static("01RUN"),
		workflow:            Str::new_static("ship"),
		workflow_digest:     Str::new(digest),
		input_digest:        Str::new_static("empty"),
		max_attempts:        3,
		model:               Str::new_static("default"),
		model_explicit:      false,
		exec_policy:         Str::new_static("local-only"),
		exec_fallback_local: false,
		workspace_trusted:   true,
		workspace_root:      Str::new_static("/work/app"),
		workspace_head:      Some(Str::new_static("abc123")),
		created:             Str::new_static("2026-11-12T00:00:00Z"),
	}
}

fn dispatch(attempt: u32) -> RunRecord {
	RunRecord::Dispatch(PhaseDispatch {
		phase: Str::new_static("build"),
		attempt,
		inputs: vec![InputVersion { phase: Str::new_static("plan"), version: 1 }],
		executor: Str::new_static("native"),
		posture: Str::new_static("write=workspace-write network=disabled approval=never"),
		effects: vec![EffectKey {
			effect: Str::new_static("pr.create"),
			key:    IdempotencyKey::parse(&"a".repeat(64)).expect("key"),
		}],
	})
}

fn settle(attempt: u32, status: SettleStatus) -> RunRecord {
	RunRecord::Settle(PhaseSettle {
		phase: Str::new_static("build"),
		attempt,
		status,
		feedback: Str::empty(),
		verdict: None,
		independent: None,
	})
}

#[test]
fn records_round_trip_in_order_and_chain_through_by() {
	let directory = tempdir().expect("tempdir");
	let path = directory.path().join("run.oms");
	{
		let mut log = RunLog::create(&path, start("d1")).expect("create");
		log.append(&dispatch(1)).expect("dispatch");
		log.append(&settle(1, SettleStatus::Accepted))
			.expect("settle");
	}
	let records = RunLog::read(&path).expect("read");
	assert_eq!(records.len(), 3);
	assert_eq!(records[1], dispatch(1));
	assert_eq!(records[2], settle(1, SettleStatus::Accepted));
	let entries = Journal::scan_with(&path, &vocabulary()).expect("scan");
	assert_eq!(entries.len(), 4);
	assert!(entries[0].by.is_none());
	for pair in entries.windows(2) {
		assert_eq!(pair[1].by, Some(pair[0].id), "entries must chain through by");
		assert!(!pair[1].data.contains('\n'));
	}
}

#[test]
fn resume_returns_the_records_and_appends_after_them() {
	let directory = tempdir().expect("tempdir");
	let path = directory.path().join("run.oms");
	RunLog::create(&path, start("d1"))
		.expect("create")
		.append(&dispatch(1))
		.expect("dispatch");
	let (mut log, records) = RunLog::open(&path, "d1").expect("open");
	assert_eq!(records.len(), 2);
	log.append(&settle(1, SettleStatus::Failed))
		.expect("append");
	drop(log);
	assert_eq!(RunLog::read(&path).expect("read").len(), 3);
}

#[test]
fn resume_refuses_a_different_workflow_definition() {
	let directory = tempdir().expect("tempdir");
	let path = directory.path().join("run.oms");
	RunLog::create(&path, start("d1")).expect("create");
	let refused = RunLog::open(&path, "d2");
	assert!(matches!(refused, Err(RunLogError::DigestMismatch { .. })), "{refused:?}");
}

#[test]
fn a_finished_run_accepts_no_more_records() {
	let directory = tempdir().expect("tempdir");
	let path = directory.path().join("run.oms");
	let mut log = RunLog::create(&path, start("d1")).expect("create");
	log.append(&RunRecord::Done(RunDone { accepted: true }))
		.expect("done");
	assert!(matches!(log.append(&dispatch(1)), Err(RunLogError::Finished)));
	drop(log);
	let (mut reopened, _) = RunLog::open(&path, "d1").expect("open");
	assert!(matches!(reopened.append(&dispatch(1)), Err(RunLogError::Finished)));
}

#[test]
fn a_halted_run_can_be_resumed() {
	let directory = tempdir().expect("tempdir");
	let path = directory.path().join("run.oms");
	let mut log = RunLog::create(&path, start("d1")).expect("create");
	log.append(&RunRecord::Halt(RunHalt { reason: Str::new_static("cancelled") }))
		.expect("halt");
	drop(log);
	let (mut reopened, records) = RunLog::open(&path, "d1").expect("open");
	assert!(matches!(records.last(), Some(RunRecord::Halt(_))));
	reopened
		.append(&dispatch(1))
		.expect("a halted run accepts the resumed dispatch");
}

#[test]
fn a_journal_that_does_not_begin_with_a_start_record_is_refused() {
	let directory = tempdir().expect("tempdir");
	let path = directory.path().join("run.oms");
	{
		let mut journal = Journal::create_with(&path, vocabulary()).expect("create");
		let genesis = journal
			.append(omp_journal::EntryDraft {
				kind:  omp_journal::Kind::new(omp_journal::kind::JOURNAL, 1).expect("kind"),
				by:    None,
				prior: None,
				label: None,
				data:  Str::new_static(r#"{"version":1,"cwd":"/tmp","created":"now"}"#),
			})
			.expect("genesis");
		let (kind, data) = dispatch(1).encode().expect("encode");
		journal
			.append(omp_journal::EntryDraft {
				kind,
				by: Some(genesis.id),
				prior: None,
				label: None,
				data,
			})
			.expect("dispatch");
	}
	assert!(matches!(RunLog::open(&path, "d1"), Err(RunLogError::MissingStart)));
}

#[test]
fn a_session_reader_refuses_a_run_journal() {
	let directory = tempdir().expect("tempdir");
	let path = directory.path().join("run.oms");
	RunLog::create(&path, start("d1")).expect("create");
	assert!(matches!(Journal::scan(&path), Err(JournalError::NewerRevision { .. })));
}
