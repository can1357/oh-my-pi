//! Current-identity images come from independent writers. Original generations
//! remain unchanged as old-IR and old-build refusal controls. Each generation
//! records its writer source and product tree in a provenance manifest.

use bstr::BStr;
use pi_shell::{
	bash::{
		Budget, CallId, CallOutcome, Cx, Engine, EngineConfig, Incompatibility, Lost, MemStore,
		RestoreError, RestoreOpts, RestoreReport, RunId, Shell, StateStore, Step,
		snapshot::vocabulary::Entry,
		store::{BlobSlot, Change, Key, Record, RestoreWrite, StoreError, Table},
	},
	testkit::FakeHost,
};
use serde::{Deserialize, Serialize};

const BASE: &[u8] =
	include_bytes!("fixtures/format-vocabulary/18.18.2-ir17/base-parent-wait.image");
const UNKNOWN: &[u8] =
	include_bytes!("fixtures/format-vocabulary/18.18.2-ir17/unknown-root-kept.image");
const UNKNOWN_RECORD: &[u8] =
	include_bytes!("fixtures/format-vocabulary/18.18.2-ir17/unknown-root-kept.record");
const UNKNOWN_CHILD: &[u8] =
	include_bytes!("fixtures/format-vocabulary/18.18.2-ir17/unknown-subshell-kept.image");
const UNKNOWN_CHILD_RECORD: &[u8] =
	include_bytes!("fixtures/format-vocabulary/18.18.2-ir17/unknown-subshell-kept.record");
const NEWER: &[u8] =
	include_bytes!("fixtures/format-vocabulary/18.18.2-ir17/newer-parent-wait.image");
const FOREIGN: &[u8] =
	include_bytes!("fixtures/format-vocabulary/18.18.2-ir17/foreign-parent-wait.image");

fn records(store: &mut MemStore) -> Vec<Vec<u8>> {
	let mut records = Vec::new();
	store
		.scan(Table::Misc, &mut |key, record| {
			records.push(postcard::to_stdvec(&(key.to_buf(), record)).unwrap());
		})
		.unwrap();
	records
}

/// A real backend that counts access and can refuse record reads. Compatibility
/// preflight must run before either readable records or a backend error.
struct UnreadableRecords {
	store:            MemStore,
	reads:            usize,
	writes:           usize,
	records_readable: bool,
}

impl UnreadableRecords {
	fn refused(&mut self) -> StoreError {
		self.reads += 1;
		StoreError::Backend("record access before compatibility preflight".into())
	}
}

impl StateStore for UnreadableRecords {
	fn get(&mut self, key: Key<'_>) -> Result<Option<&Record>, StoreError> {
		if !self.records_readable {
			return Err(self.refused());
		}
		self.reads += 1;
		self.store.get(key)
	}

	fn scan(
		&mut self,
		table: Table,
		visit: &mut dyn FnMut(Key<'_>, &Record),
	) -> Result<(), StoreError> {
		if !self.records_readable {
			return Err(self.refused());
		}
		self.reads += 1;
		self.store.scan(table, visit)
	}

	fn apply(&mut self, change: Change<'_>) -> Result<(), StoreError> {
		self.writes += 1;
		self.store.apply(change)
	}

	fn commit_restore(&mut self, writes: Vec<RestoreWrite>) -> Result<(), StoreError> {
		self.writes += writes.len();
		self.store.commit_restore(writes)
	}

	fn put_blob(&mut self, slot: BlobSlot, bytes: &[u8]) -> Result<(), StoreError> {
		self.writes += 1;
		self.store.put_blob(slot, bytes)
	}

	fn get_blob(&mut self, slot: BlobSlot) -> Result<Option<Vec<u8>>, StoreError> {
		self.store.get_blob(slot)
	}

	fn del_blob(&mut self, slot: BlobSlot) -> Result<(), StoreError> {
		self.writes += 1;
		self.store.del_blob(slot)
	}

	fn epoch(&self) -> u64 {
		self.store.epoch()
	}
}

fn refuse_before_records(bytes: &[u8], frames_version: bool) {
	let engine = Engine::new(EngineConfig::default());
	let mut host = FakeHost::new();
	let mut store = UnreadableRecords {
		store:            MemStore::from_bytes(bytes).unwrap(),
		reads:            0,
		writes:           0,
		records_readable: false,
	};
	let before = store.store.to_bytes();
	let epoch = store.epoch();
	let result = Shell::restore(
		&engine,
		&mut Cx { host: &mut host, store: &mut store },
		RestoreOpts::default(),
	);
	let shell_returned = result.is_ok();
	let error = result
		.err()
		.expect("an incompatible image must return no shell");
	println!(
		"error={error:?}; shell_returned={shell_returned}; record_reads={}; writes={}; unchanged={}",
		store.reads,
		store.writes,
		before == store.store.to_bytes()
	);
	assert_eq!(store.store.to_bytes(), before, "refusal consumed persisted execution");
	assert_eq!(store.epoch(), epoch, "refusal changed the store epoch");
	assert_eq!(store.writes, 0, "refusal attempted a store write");
	assert_eq!(store.reads, 0, "incompatibility must precede every record read: {error:?}");
	if frames_version {
		assert!(
			matches!(error, RestoreError::Incompatible {
				why: Incompatibility::FramesVersion { found: u32::MAX, expected: 30 },
			}),
			"name the unsupported frames version, not corrupt data or a different build: {error:?}"
		);
	} else {
		assert!(
			matches!(error, RestoreError::Incompatible { why: Incompatibility::Build }),
			"a foreign identity must be refused explicitly: {error:?}"
		);
	}
}

#[test]
fn foreign_identity_is_refused_before_any_record_is_read() {
	refuse_before_records(FOREIGN, false);
}

#[test]
fn newer_frames_are_refused_before_any_record_is_read() {
	refuse_before_records(NEWER, true);
}

#[test]
fn newer_frames_refusal_identifies_the_unsupported_wire_version() {
	let engine = Engine::new(EngineConfig::default());
	let mut host = FakeHost::new();
	let mut store = MemStore::from_bytes(NEWER).unwrap();
	let before = store.to_bytes();
	let result = Shell::restore(
		&engine,
		&mut Cx { host: &mut host, store: &mut store },
		RestoreOpts::default(),
	);
	let error = result.err().expect("newer frames must not return a shell");
	println!("error={error:?}; shell_returned=false; unchanged={}", before == store.to_bytes());
	assert_eq!(store.to_bytes(), before);
	assert!(
		matches!(error, RestoreError::Incompatible {
			why: Incompatibility::FramesVersion { found: u32::MAX, expected: 30 },
		}),
		"report which frames version is newer: {error:?}"
	);
}

fn preserves_unknown_record(image: &[u8], original: &[u8], vprocs: u32) {
	let mut store = MemStore::from_bytes(image)
		.expect("one unknown key must not make the entire table undecodable");
	assert!(
		records(&mut store).iter().any(|record| record == original),
		"the unknown record's original bytes must survive decoding"
	);
	let engine = Engine::new(EngineConfig::default());
	let mut host = FakeHost::new();
	let (mut shell, report) = Shell::restore(
		&engine,
		&mut Cx { host: &mut host, store: &mut store },
		RestoreOpts::default(),
	)
	.unwrap();
	println!("restore={report:?}");
	assert_eq!((report.vprocs, report.runs), (vprocs, 1));
	assert_eq!(report.lost.len(), 1, "the skipped record must be reported, not silently ignored");
	assert!(report.abandoned.is_empty());
	shell.complete(CallId(1), CallOutcome::Exit(0));
	let mut idle = false;
	for _ in 0..10_000 {
		match shell.step(&mut Cx { host: &mut host, store: &mut store }, Budget::default()) {
			Step::Idle => {
				idle = true;
				break;
			},
			Step::Yield | Step::Done { .. } => {},
			other => panic!("restored execution did not continue: {other:?}"),
		}
	}
	assert!(idle, "restored execution never completed");
	assert_eq!(
		host.stdout.bytes(),
		b"kept=127\n",
		"the rest of the table and execution must remain usable"
	);
	let mut written_back = MemStore::from_bytes(&store.to_bytes()).unwrap();
	assert!(
		records(&mut written_back)
			.iter()
			.any(|record| record == original),
		"a reader that cannot name the record deleted or rewrote it"
	);
}

#[test]
fn unknown_root_record_is_reported_as_loss_and_survives_write_back() {
	preserves_unknown_record(UNKNOWN, UNKNOWN_RECORD, 1);
}

#[test]
fn unknown_child_record_is_reported_as_loss_and_survives_write_back() {
	preserves_unknown_record(UNKNOWN_CHILD, UNKNOWN_CHILD_RECORD, 2);
}

#[test]
fn genuine_legacy_frames_keep_the_active_child_and_parent_wait() {
	let engine = Engine::new(EngineConfig::default());
	let mut host = FakeHost::new();
	let mut store = MemStore::from_bytes(BASE).unwrap();
	assert!(store.record(Key::Var(BStr::new("KEEP"))).is_some());
	let (_, report) = Shell::restore(
		&engine,
		&mut Cx { host: &mut host, store: &mut store },
		RestoreOpts::default(),
	)
	.unwrap();
	println!("restore={report:?}");
	assert_eq!(report, RestoreReport { vprocs: 2, runs: 1, ..RestoreReport::default() });
}

// These rows construct an envelope around a genuine legacy core. They never
// rewrite the independent upstream fixtures or change the core's wire bytes.
#[derive(Deserialize, Serialize)]
struct Header {
	magic:  [u8; 4],
	ir:     u32,
	frames: u32,
	build:  [u8; 32],
	runs:   Vec<RunId>,
}

#[derive(Deserialize, Serialize)]
struct Envelope<'a> {
	#[serde(borrow)]
	core:    &'a [u8],
	entries: Vec<Entry>,
}

fn vocabulary_store(id: u32, required: bool) -> MemStore {
	let mut store = MemStore::from_bytes(BASE).unwrap();
	let frames = store.get_blob(BlobSlot::Frames).unwrap().unwrap();
	let (mut header, core) = postcard::take_from_bytes::<Header>(&frames).unwrap();
	assert_eq!(header.magic, *b"OBF1");
	header.magic = *b"OBF2";
	let envelope = Envelope {
		core,
		entries: vec![Entry {
			id,
			revision: 8,
			required,
			vpid: None,
			payload: vec![0, 255, 128, 2, 0, 0, 9],
		}],
	};
	let mut blob = postcard::to_stdvec(&header).unwrap();
	blob.extend(postcard::to_stdvec(&envelope).unwrap());
	store.put_blob(BlobSlot::Frames, &blob).unwrap();
	store
}

fn assert_vocabulary_refusal(store: &mut UnreadableRecords, id: u32) {
	let engine = Engine::new(EngineConfig::default());
	let mut host = FakeHost::new();
	let before = store.store.to_bytes();
	let result = Shell::restore(&engine, &mut Cx { host: &mut host, store }, RestoreOpts::default());
	if let Ok((_, report)) = &result {
		println!("shell_returned=true; restore={report:?}");
	}
	let error = result
		.err()
		.expect("a required allocation must return no shell");
	println!(
		"id={id}; error={error:?}; shell_returned=false; record_reads={}; writes={}; unchanged={}",
		store.reads,
		store.writes,
		before == store.store.to_bytes()
	);
	assert_eq!(store.reads, 0, "requiredness must be checked before Root::load: {error:?}");
	assert_eq!(store.writes, 0, "preflight must not write or delete the Frames blob");
	assert_eq!(store.store.to_bytes(), before, "refusal must preserve the entire image");
	assert!(
		matches!(error, RestoreError::Incompatible {
		why: Incompatibility::Vocabulary { id: found, revision: 8, vpid: None }
	} if found == id),
		"name the required allocation, not a backend failure: {error:?}"
	);
}

#[test]
fn allocated_required_unknown_revision_cannot_resume_when_the_writer_marks_it_optional() {
	let mut store = UnreadableRecords {
		store:            vocabulary_store(65536, false),
		reads:            0,
		writes:           0,
		records_readable: true,
	};
	assert_vocabulary_refusal(&mut store, 65536);
}

#[test]
fn allocated_required_unknown_revision_is_refused_before_records_without_consuming_the_image() {
	let mut store = UnreadableRecords {
		store:            vocabulary_store(65536, false),
		reads:            0,
		writes:           0,
		records_readable: false,
	};
	assert_vocabulary_refusal(&mut store, 65536);
}

#[test]
fn allocated_pending_trap_requiredness_survives_an_unknown_revision_and_optional_writer_flag() {
	let mut store = UnreadableRecords {
		store:            vocabulary_store(1, false),
		reads:            0,
		writes:           0,
		records_readable: false,
	};
	assert_vocabulary_refusal(&mut store, 1);
}

fn preserves_optional_revision(id: u32) {
	let engine = Engine::new(EngineConfig::default());
	let mut host = FakeHost::new();
	let mut store = vocabulary_store(id, false);
	let original = store.get_blob(BlobSlot::Frames).unwrap().unwrap();
	let (_, body) = postcard::take_from_bytes::<Header>(&original).unwrap();
	let original_entries = postcard::from_bytes::<Envelope<'_>>(body).unwrap().entries;
	let (mut shell, report) = Shell::restore(
		&engine,
		&mut Cx { host: &mut host, store: &mut store },
		RestoreOpts::default(),
	)
	.unwrap();
	let loss = vec![Lost::Vocabulary { id, revision: 8, vpid: None }];
	assert_eq!(report.lost, loss);
	assert_eq!((report.vprocs, report.runs), (2, 1));
	for _ in 0..2 {
		shell.control().request_suspend();
		assert!(matches!(
			shell.step(&mut Cx { host: &mut host, store: &mut store }, Budget::default()),
			Step::SuspendReady
		));
		shell
			.externalize(&mut Cx { host: &mut host, store: &mut store })
			.unwrap();
		let frames = store.get_blob(BlobSlot::Frames).unwrap().unwrap();
		let (_, body) = postcard::take_from_bytes::<Header>(&frames).unwrap();
		let envelope = postcard::from_bytes::<Envelope<'_>>(body).unwrap();
		assert_eq!(
			envelope.entries, original_entries,
			"unknown payload and declaration must survive"
		);
		let (restored, report) = Shell::restore(
			&engine,
			&mut Cx { host: &mut host, store: &mut store },
			RestoreOpts::default(),
		)
		.unwrap();
		assert_eq!(report.lost, loss);
		shell = restored;
	}
	shell.complete(CallId(1), CallOutcome::Exit(0));
	let mut idle = false;
	for _ in 0..10_000 {
		match shell.step(&mut Cx { host: &mut host, store: &mut store }, Budget::default()) {
			Step::Idle => {
				idle = true;
				break;
			},
			Step::Done { .. } | Step::Yield => {},
			other => panic!("preserving optional vocabulary disrupted execution: {other:?}"),
		}
	}
	assert!(idle);
	assert_eq!(host.stdout.bytes(), b"child=23\n");
}

#[test]
fn allocated_optional_unknown_revision_is_reported_and_preserved_through_execution() {
	preserves_optional_revision(65538);
}

#[test]
fn unallocated_optional_identifier_keeps_its_payload_and_loss_report() {
	preserves_optional_revision(65537);
}

#[test]
fn unallocated_required_identifier_is_still_refused_before_records() {
	let mut store = UnreadableRecords {
		store:            vocabulary_store(65539, true),
		reads:            0,
		writes:           0,
		records_readable: false,
	};
	assert_vocabulary_refusal(&mut store, 65539);
}

fn refuses_old_ir_without_mutation(images: &[&[u8]]) {
	let engine = Engine::new(EngineConfig::default());
	for bytes in images {
		let mut store = UnreadableRecords {
			store:            MemStore::from_bytes(bytes).unwrap(),
			reads:            0,
			writes:           0,
			records_readable: false,
		};
		let before = store.store.to_bytes();
		let epoch = store.epoch();
		let mut host = FakeHost::new();
		let error = Shell::restore(
			&engine,
			&mut Cx { host: &mut host, store: &mut store },
			RestoreOpts::default(),
		)
		.err()
		.expect("an old IR must be refused, not decoded as the current core");
		assert!(
			matches!(error, RestoreError::Incompatible {
				why: Incompatibility::IrVersion { found: 15, expected: 17 },
			}),
			"{error:?}"
		);
		assert_eq!((store.reads, store.writes), (0, 0));
		assert_eq!(store.store.to_bytes(), before);
		assert_eq!(store.epoch(), epoch);
	}
}

#[test]
fn original_legacy_cores_are_refused_before_records_without_changing_the_store() {
	refuses_old_ir_without_mutation(&[
		include_bytes!("fixtures/frames/upstream-v29-parent-wait.image"),
		include_bytes!("fixtures/frames/upstream-v29-no-wait.image"),
		include_bytes!("fixtures/frames/upstream-v29-18.17-parent-wait.image"),
		include_bytes!("fixtures/frames/upstream-v29-18.17-no-wait.image"),
		include_bytes!("fixtures/frames/upstream-v29-18.18-parent-wait.image"),
		include_bytes!("fixtures/frames/upstream-v29-18.18-no-wait.image"),
		include_bytes!("fixtures/format-vocabulary/base-parent-wait.image"),
		include_bytes!("fixtures/format-vocabulary/18.18/base-parent-wait.image"),
		include_bytes!("fixtures/format-vocabulary/18.18/unknown-root-kept.image"),
		include_bytes!("fixtures/format-vocabulary/18.18/unknown-subshell-kept.image"),
	]);
}

#[test]
fn original_required_codec_cores_are_refused_before_records_without_changing_the_store() {
	refuses_old_ir_without_mutation(&[
		include_bytes!("fixtures/format-vocabulary/owned-required-vocabulary.image"),
		include_bytes!("fixtures/format-vocabulary/18.18/owned-required-vocabulary.image"),
	]);
}

#[test]
fn previous_build_cores_are_refused_before_records_without_changing_the_store() {
	for image in [
		include_bytes!("fixtures/frames/upstream-v30-18.18.1-parent-wait.image").as_slice(),
		include_bytes!("fixtures/frames/upstream-v30-18.18.1-no-wait.image").as_slice(),
		include_bytes!("fixtures/frames/foreign-v30-18.18.1-parent-wait.image").as_slice(),
		include_bytes!("fixtures/frames/foreign-v30-18.18.1-no-wait.image").as_slice(),
		include_bytes!("fixtures/format-vocabulary/18.18.1-ir17/base-parent-wait.image").as_slice(),
		include_bytes!("fixtures/format-vocabulary/18.18.1-ir17/foreign-parent-wait.image")
			.as_slice(),
		include_bytes!("fixtures/format-vocabulary/18.18.1-ir17/owned-required.image").as_slice(),
		include_bytes!("fixtures/format-vocabulary/18.18.1-ir17/owned-optional.image").as_slice(),
		include_bytes!("fixtures/format-vocabulary/18.18.1-ir17/reserved-required.image").as_slice(),
		include_bytes!("fixtures/format-vocabulary/18.18.1-ir17/unknown-root-kept.image").as_slice(),
		include_bytes!("fixtures/format-vocabulary/18.18.1-ir17/unknown-subshell-kept.image")
			.as_slice(),
	] {
		refuse_before_records(image, false);
	}
	refuse_before_records(
		include_bytes!("fixtures/format-vocabulary/18.18.1-ir17/newer-parent-wait.image"),
		true,
	);
}
