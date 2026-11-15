//! Laws for append, recovery, and branch selection.

use std::{
	env, fs,
	path::Path,
	process::{Command, abort},
	time::SystemTime,
};

use omp_core::Str;
use omp_journal::{
	Entry, EntryDraft, Journal, JournalError, Kind, abandoned,
	kind::{JOURNAL, PATCH, TURN_START},
	live_chain,
};
use proptest::prelude::*;
use tempfile::tempdir;

fn kind(name: &'static str) -> Kind {
	Kind { name: Str::new_static(name), rev: 1 }
}

fn genesis() -> EntryDraft {
	EntryDraft {
		kind:  kind(JOURNAL),
		by:    None,
		prior: None,
		label: None,
		data:  Str::new_static(r#"{"version":1,"cwd":"/tmp","created":"now"}"#),
	}
}

fn draft(name: &'static str, by: omp_journal::EntryId) -> EntryDraft {
	EntryDraft {
		kind:  kind(name),
		by:    Some(by),
		prior: None,
		label: None,
		data:  Str::new_static("{}"),
	}
}

proptest! {
	#![proptest_config(ProptestConfig::with_cases(8))]

	#[test]
	fn torn_tail_recovers_at_every_byte_offset_without_losing_a_complete_frame(
		labels in prop::collection::vec("[^\\r\\n]{0,24}", 0..4),
	) {
		let directory = tempdir().expect("tempdir");
		let source_path = directory.path().join("source.oms");
		let mut journal = Journal::create(&source_path).expect("create");
		let genesis = journal.append(genesis()).expect("genesis");
		let mut expected_entries = vec![genesis.clone()];
		for (index, label) in labels.into_iter().enumerate() {
			let mut next = draft(TURN_START, genesis.id);
			next.label = Some(Str::new(label));
			next.data = Str::new(serde_json::json!({"turn": index}).to_string());
			expected_entries.push(journal.append(next).expect("append"));
		}
		drop(journal);
		let complete = fs::read(&source_path).expect("read complete journal");
		let mut frame_ends = Vec::new();
		let mut scanner = omp_journal::sse::Scanner::new(&complete);
		while let Some(frame) = scanner.next() {
			frame.expect("valid source frame");
			frame_ends.push(scanner.offset());
		}

		for cut in 0..=complete.len() {
			let cut_path = directory.path().join("cut.oms");
			fs::write(&cut_path, &complete[..cut]).expect("write prefix");
			let (opened, recovered) = Journal::open(&cut_path).expect("recover prefix");
			let expected_len = frame_ends.iter().take_while(|&&end| end <= cut).count();
			prop_assert_eq!(&recovered, &expected_entries[..expected_len]);
			let clean_len = frame_ends.get(expected_len.wrapping_sub(1)).copied().unwrap_or(0);
			prop_assert_eq!(opened.recovered_tail_bytes(), (cut - clean_len) as u64);
			drop(opened);
			fs::remove_file(&cut_path).expect("remove prefix");
		}
	}
}

#[test]
fn every_non_genesis_entry_requires_by() {
	let directory = tempdir().expect("tempdir");
	let path = directory.path().join("cause.oms");
	let mut journal = Journal::create(path).expect("create");
	let first_error = journal
		.append(EntryDraft {
			kind:  kind(TURN_START),
			by:    None,
			prior: None,
			label: None,
			data:  Str::new_static("{}"),
		})
		.expect_err("non-genesis without cause must fail");
	assert!(matches!(first_error, JournalError::MissingCause { .. }));
	let genesis = journal.append(genesis()).expect("genesis");
	let error = journal
		.append(EntryDraft {
			kind:  kind(PATCH),
			by:    None,
			prior: None,
			label: None,
			data:  Str::new_static(r#"{"ops":[]}"#),
		})
		.expect_err("missing cause must fail");
	assert!(matches!(error, JournalError::MissingCause { kind } if kind.name == PATCH));
	journal
		.append(draft(TURN_START, genesis.id))
		.expect("caused entry");
}

#[test]
fn prior_walk_selects_live_chain_and_retains_abandoned() {
	let directory = tempdir().expect("tempdir");
	let path = directory.path().join("branch.oms");
	let mut journal = Journal::create(path).expect("create");
	let genesis = journal.append(genesis()).expect("genesis");
	let first = journal
		.append(draft(TURN_START, genesis.id))
		.expect("first");
	let second = journal.append(draft(TURN_START, first.id)).expect("second");
	let mut branch = draft(PATCH, genesis.id);
	branch.prior = Some(genesis.id);
	branch.data = Str::new_static(r#"{"ops":[]}"#);
	let branch = journal.append(branch).expect("branch");
	let entries: Vec<Entry> = vec![genesis.clone(), first.clone(), second.clone(), branch.clone()];

	assert_eq!(
		live_chain(&entries)
			.map(|entry| entry.id)
			.collect::<Vec<_>>(),
		[genesis.id, branch.id]
	);
	assert_eq!(
		abandoned(&entries)
			.map(|entry| entry.id)
			.collect::<Vec<_>>(),
		[first.id, second.id]
	);
}

/// Subprocess half of the cross-process writer exclusion test.
#[test]
#[ignore = "subprocess helper"]
fn writer_lock_subprocess_helper() {
	let path = env::var_os("OMP_JOURNAL_LOCK_TEST_PATH").expect("journal test path");
	let error = Journal::open(path).expect_err("parent process owns the writer lock");
	assert!(matches!(error, JournalError::Locked { .. }));
}

/// The writer lock is cross-process, not merely an in-process ownership
/// convention.
#[test]
fn second_process_is_refused_while_the_writer_is_open() {
	let directory = tempdir().expect("tempdir");
	let path = directory.path().join("process-locked.oms");
	let mut journal = Journal::create(&path).expect("create");
	journal.append(genesis()).expect("genesis");
	let status = Command::new(env::current_exe().expect("journal test executable"))
		.args(["--ignored", "--exact", "writer_lock_subprocess_helper"])
		.env("OMP_JOURNAL_LOCK_TEST_PATH", &path)
		.status()
		.expect("run lock contender");
	assert!(status.success(), "subprocess must observe the held writer lock");
}

/// One `.oms` has one writer: a second opener (another process, or a second
/// owner in this one) gets a typed refusal instead of a divergent
/// materialization, and the lock lifts with the writer.
#[test]
fn second_writer_is_refused_while_the_first_is_open() {
	let directory = tempdir().expect("tempdir");
	let path = directory.path().join("locked.oms");
	let mut journal = Journal::create(&path).expect("create");
	journal.append(genesis()).expect("genesis");
	let error = Journal::open(&path).expect_err("a live writer excludes a second one");
	assert!(matches!(error, JournalError::Locked { path: locked } if locked == path));
	drop(journal);
	let (_, entries) = Journal::open(&path).expect("the lock lifts with the writer");
	assert_eq!(entries.len(), 1);
}

/// `scan` is the read-only view of a possibly-live journal: no lock, no
/// truncation, and exactly the committed prefix a later `open` would keep.
#[test]
fn scan_reads_the_committed_prefix_without_locking_or_truncating() {
	let directory = tempdir().expect("tempdir");
	let path = directory.path().join("scan.oms");
	let mut journal = Journal::create(&path).expect("create");
	let genesis = journal.append(genesis()).expect("genesis");
	journal.append(draft(TURN_START, genesis.id)).expect("turn");
	let scanned = Journal::scan(&path).expect("scan while the writer is live");
	assert_eq!(scanned.len(), 2);
	drop(journal);
	let complete_len = fs::metadata(&path).expect("metadata").len();
	let mut torn = fs::read(&path).expect("read");
	torn.extend_from_slice(b"event: stream@1\nid: 01Torn");
	fs::write(&path, &torn).expect("write torn tail");
	let scanned = Journal::scan(&path).expect("scan tolerates a torn tail");
	assert_eq!(scanned.len(), 2);
	assert_eq!(
		fs::metadata(&path).expect("metadata").len(),
		torn.len() as u64,
		"scan never rewrites the file"
	);
	let (opened, entries) = Journal::open(&path).expect("open recovers");
	assert_eq!(entries.len(), 2);
	assert_eq!(fs::metadata(&path).expect("metadata").len(), complete_len);
	drop(opened);
}

/// `scan_prefix` reads only the committed entries inside its byte limit: a
/// frame the limit cuts is dropped like a torn tail, never an error.
#[test]
fn scan_prefix_returns_the_committed_entries_inside_the_limit() {
	let directory = tempdir().expect("tempdir");
	let path = directory.path().join("prefix.oms");
	let mut journal = Journal::create(&path).expect("create");
	let genesis = journal.append(genesis()).expect("genesis");
	let genesis_len = fs::metadata(&path).expect("metadata").len();
	journal.append(draft(TURN_START, genesis.id)).expect("turn");
	journal.append(draft(PATCH, genesis.id)).expect("patch");
	let complete_len = fs::metadata(&path).expect("metadata").len();

	let whole = Journal::scan(&path).expect("scan");
	assert_eq!(whole.len(), 3);
	let cut = Journal::scan_prefix(&path, genesis_len + 5).expect("a cut frame is a torn tail");
	assert_eq!(cut, whole[..1]);
	assert_eq!(Journal::scan_prefix(&path, genesis_len).expect("exact"), whole[..1]);
	assert!(
		Journal::scan_prefix(&path, 3)
			.expect("inside genesis")
			.is_empty()
	);
	assert_eq!(Journal::scan_prefix(&path, u64::MAX).expect("unbounded"), whole);
	assert_eq!(fs::metadata(&path).expect("metadata").len(), complete_len, "never rewrites");
	drop(journal);
}

const NEWER_GENESIS: &str = "event: journal@1\nid: 01ARZ3NDEKTSV4RRFFQ69G5FAV\ndata: \
                             {\"version\":1,\"cwd\":\"/tmp\",\"created\":\"now\"}\n\n";

/// A kind this build does not know is a journal from a newer omp, not a
/// corrupt file: both read paths report the typed fail-closed error naming the
/// kind, and neither truncates it.
#[test]
fn unknown_kind_or_revision_is_a_typed_newer_revision_error() {
	let directory = tempdir().expect("tempdir");
	for event in ["patch@2", "x.future@1"] {
		let path = directory.path().join("newer.oms");
		let text = format!(
			"{NEWER_GENESIS}event: {event}\nid: 01ARZ3NDEKTSV4RRFFQ69G5FAW\nby: \
			 01ARZ3NDEKTSV4RRFFQ69G5FAV\ndata: {{}}\n\n"
		);
		fs::write(&path, &text).expect("write newer journal");

		let scanned = Journal::scan(&path).expect_err("scan refuses a newer journal");
		let JournalError::NewerRevision { kind } = scanned else {
			panic!("scan must report NewerRevision for {event}, got {scanned:?}");
		};
		assert_eq!(kind.to_string(), event);
		assert!(matches!(
			Journal::open(&path).expect_err("open refuses a newer journal"),
			JournalError::NewerRevision { .. }
		));
		assert_eq!(fs::read_to_string(&path).expect("read"), text, "a refused journal is untouched");
		fs::remove_file(&path).expect("remove");
	}
}

/// `Genesis.version` is validated on open: a version above the supported one
/// is a typed error, the supported one opens.
#[test]
fn genesis_version_newer_than_supported_is_a_typed_error() {
	let directory = tempdir().expect("tempdir");
	let path = directory.path().join("genesis.oms");
	let newer = omp_journal::data::GENESIS_VERSION + 1;
	fs::write(
		&path,
		format!(
			"event: journal@1\nid: 01ARZ3NDEKTSV4RRFFQ69G5FAV\ndata: \
			 {{\"version\":{newer},\"cwd\":\"/\",\"created\":\"1\"}}\n\n"
		),
	)
	.expect("write");
	for error in
		[Journal::scan(&path).expect_err("scan"), Journal::open(&path).map(|_| ()).expect_err("open")]
	{
		let JournalError::NewerGenesisVersion { found, supported } = error else {
			panic!("expected NewerGenesisVersion, got {error:?}");
		};
		assert_eq!(found, newer);
		assert_eq!(supported, omp_journal::data::GENESIS_VERSION);
	}

	fs::write(&path, NEWER_GENESIS).expect("write supported");
	assert_eq!(Journal::scan(&path).expect("supported version opens").len(), 1);
}

/// A frame that reaches the cap without its committing blank line is rejected
/// by every read path, and `open` leaves the file as it found it.
#[test]
fn oversized_unterminated_frame_is_rejected_without_truncation() {
	let directory = tempdir().expect("tempdir");
	let path = directory.path().join("hostile.oms");
	let mut bytes = Vec::new();
	omp_journal::sse::encode(
		&Entry {
			id:    "01ARZ3NDEKTSV4RRFFQ69G5FAV".parse().expect("id"),
			kind:  kind(JOURNAL),
			by:    None,
			prior: None,
			label: None,
			data:  Str::new_static(r#"{"version":1,"cwd":"/","created":"1"}"#),
		},
		&mut bytes,
	)
	.expect("genesis");
	bytes.extend_from_slice(b"event: patch@1\ndata: ");
	// One byte past the frame cap, never terminated: nothing here may be
	// buffered whole.
	bytes.resize(bytes.len() + omp_journal::sse::FRAME_HARD_CAP, b'a');
	fs::write(&path, &bytes).expect("write hostile journal");

	for error in [
		Journal::scan(&path).expect_err("scan"),
		Journal::scan_prefix(&path, u64::MAX).expect_err("scan_prefix"),
		Journal::open(&path).map(|_| ()).expect_err("open"),
	] {
		assert!(
			matches!(error, JournalError::FrameTooLarge { limit } if limit == omp_journal::sse::FRAME_HARD_CAP),
			"unexpected error {error:?}"
		);
	}
	assert_eq!(fs::read(&path).expect("read"), bytes, "a rejected journal is never truncated");
}

/// The cap does not touch frames this build can write: a maximal payload
/// round-trips through `append` and `open`, and a torn tail still recovers.
#[test]
fn maximal_payload_round_trips_and_a_short_torn_tail_still_recovers() {
	let directory = tempdir().expect("tempdir");
	let path = directory.path().join("max.oms");
	let mut journal = Journal::create(&path).expect("create");
	let genesis = journal.append(genesis()).expect("genesis");
	let mut big = draft(PATCH, genesis.id);
	big.data = Str::new(format!("\"{}\"", "x".repeat(omp_journal::sse::DATA_HARD_CAP - 2)));
	assert_eq!(big.data.len(), omp_journal::sse::DATA_HARD_CAP);
	journal.append(big).expect("a maximal payload is accepted");
	drop(journal);
	let mut torn = fs::read(&path).expect("read");
	torn.extend_from_slice(b"event: stream@1\nid: 01Torn");
	fs::write(&path, &torn).expect("torn");
	let (opened, entries) = Journal::open(&path).expect("open recovers");
	assert_eq!(entries.len(), 2);
	assert_eq!(opened.recovered_tail_bytes(), b"event: stream@1\nid: 01Torn".len() as u64);
}

/// A label large enough to push a frame past the cap is refused on write, so
/// the writer cannot produce a frame the reader would reject.
#[test]
fn append_refuses_a_frame_the_reader_would_reject() {
	let directory = tempdir().expect("tempdir");
	let mut journal = Journal::create(directory.path().join("label.oms")).expect("create");
	let genesis = journal.append(genesis()).expect("genesis");
	let mut huge = draft(PATCH, genesis.id);
	huge.data = Str::new(format!("\"{}\"", "x".repeat(omp_journal::sse::DATA_HARD_CAP - 2)));
	huge.label = Some(Str::new("l".repeat(omp_journal::sse::FRAME_OVERHEAD_CAP)));
	assert!(matches!(journal.append(huge), Err(JournalError::FrameTooLarge { .. })));
}

/// Names, sizes and modification times of everything in `dir`: a probe that
/// created, touched or removed a file changes this.
fn listing(dir: &Path) -> Vec<(String, u64, SystemTime)> {
	let mut rows = fs::read_dir(dir)
		.expect("read directory")
		.map(|entry| {
			let entry = entry.expect("directory entry");
			let metadata = entry.metadata().expect("entry metadata");
			(
				entry.file_name().to_string_lossy().into_owned(),
				metadata.len(),
				metadata.modified().expect("modified time"),
			)
		})
		.collect::<Vec<_>>();
	rows.sort();
	rows
}

/// `is_live` is true exactly while a writer holds the journal, for both
/// entry points that take the writer lock, and the probe leaves nothing held.
#[test]
fn is_live_is_true_while_a_writer_holds_the_journal() {
	let directory = tempdir().expect("tempdir");
	let path = directory.path().join("live.oms");
	let mut created = Journal::create(&path).expect("create");
	created.append(genesis()).expect("genesis");
	assert!(Journal::is_live(&path).expect("probe a created journal"), "create holds the writer");
	drop(created);
	assert!(!Journal::is_live(&path).expect("probe after drop"), "the lock lifts with the writer");

	let (opened, entries) = Journal::open(&path).expect("open");
	assert_eq!(entries.len(), 1);
	assert!(Journal::is_live(&path).expect("probe an opened journal"), "open holds the writer");
	assert!(Journal::is_live(&path).expect("probe again"), "probing is repeatable");
	drop(opened);
	assert!(!Journal::is_live(&path).expect("probe after drop"));

	let (reopened, _) = Journal::open(&path).expect("a probe leaves no lock behind");
	drop(reopened);
}

/// With no lock sidecar the probe answers false and creates nothing, whether
/// the journal exists or not.
#[test]
fn is_live_without_a_lock_file_is_false_and_creates_nothing() {
	let directory = tempdir().expect("tempdir");
	let path = directory.path().join("never-opened.oms");
	fs::write(&path, b"").expect("journal file without a writer");
	let before = listing(directory.path());
	assert_eq!(before.len(), 1);

	assert!(!Journal::is_live(&path).expect("probe without a sidecar"));
	assert_eq!(listing(directory.path()), before, "the probe must not create or touch a file");

	let missing = directory.path().join("missing.oms");
	assert!(!Journal::is_live(&missing).expect("probe a path that does not exist"));
	assert_eq!(listing(directory.path()), before, "a missing journal creates nothing either");
}

/// A sidecar left by a writer that has finished is not live, and the probe
/// neither removes nor modifies it.
#[test]
fn is_live_ignores_a_stale_lock_file_and_leaves_it_untouched() {
	let directory = tempdir().expect("tempdir");
	let path = directory.path().join("stale.oms");
	let mut journal = Journal::create(&path).expect("create");
	journal.append(genesis()).expect("genesis");
	drop(journal);
	let before = listing(directory.path());
	assert!(
		before.iter().any(|(name, ..)| name == "stale.oms.lock"),
		"the finished writer leaves its sidecar"
	);

	assert!(!Journal::is_live(&path).expect("probe a stale sidecar"));
	assert_eq!(listing(directory.path()), before, "the probe must not alter the directory");
}

/// Subprocess half of the cross-process liveness test.
#[test]
#[ignore = "subprocess helper"]
fn is_live_subprocess_helper() {
	let path = env::var_os("OMP_JOURNAL_LIVE_TEST_PATH").expect("journal test path");
	assert!(Journal::is_live(path).expect("probe"), "the parent process holds the writer");
}

/// Subprocess that takes the writer lock and dies without running any
/// destructor.
#[test]
#[ignore = "subprocess helper"]
fn crashing_writer_subprocess_helper() {
	let path = env::var_os("OMP_JOURNAL_LIVE_TEST_PATH").expect("journal test path");
	let (_journal, _) = Journal::open(path).expect("child takes the writer lock");
	abort();
}

/// Liveness is observable across processes, and a writer that crashed while
/// holding the journal leaves a sidecar that is no longer live.
#[test]
fn is_live_sees_other_processes_and_ignores_a_crashed_writer() {
	let directory = tempdir().expect("tempdir");
	let path = directory.path().join("process-live.oms");
	let mut journal = Journal::create(&path).expect("create");
	journal.append(genesis()).expect("genesis");
	let exe = env::current_exe().expect("journal test executable");
	let status = Command::new(&exe)
		.args(["--ignored", "--exact", "is_live_subprocess_helper"])
		.env("OMP_JOURNAL_LIVE_TEST_PATH", &path)
		.status()
		.expect("run liveness probe");
	assert!(status.success(), "the subprocess must observe the live writer");
	drop(journal);

	let status = Command::new(&exe)
		.args(["--ignored", "--exact", "crashing_writer_subprocess_helper"])
		.env("OMP_JOURNAL_LIVE_TEST_PATH", &path)
		.status()
		.expect("run crashing writer");
	assert!(!status.success(), "the helper aborts while holding the lock");
	let before = listing(directory.path());
	assert!(
		before
			.iter()
			.any(|(name, ..)| name == "process-live.oms.lock")
	);
	assert!(!Journal::is_live(&path).expect("probe after the writer crashed"));
	assert_eq!(listing(directory.path()), before);
}
