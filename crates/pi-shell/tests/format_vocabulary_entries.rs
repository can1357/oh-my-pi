//! Independently built producers supply these images; tests never rewrite them.

use pi_shell::{
	bash::{
		Budget, CallId, CallOutcome, Cx, Engine, EngineConfig, Incompatibility, Lost, MemStore,
		RestoreError, RestoreOpts, RunId, Script, Shell, StateStore, Step, Vpid,
		snapshot::vocabulary::Entry,
		store::{BlobSlot, Change, Key, Record, RestoreWrite, StoreError, Table},
	},
	testkit::FakeHost,
};
use serde::Deserialize;

const REQUIRED: &[u8] =
	include_bytes!("fixtures/format-vocabulary/18.18/owned-required-vocabulary.image");
const OPTIONAL: &[u8] =
	include_bytes!("fixtures/format-vocabulary/18.18/owned-optional-vocabulary.image");
const RESERVED: &[u8] =
	include_bytes!("fixtures/format-vocabulary/18.18/owned-reserved-required.image");
const FRAMELESS: &[u8] =
	include_bytes!("fixtures/format-vocabulary/future-unknown/frameless-unknown-root.image");
const FRAMELESS_MARKS: &[u8] =
	include_bytes!("fixtures/format-vocabulary/future-unknown/frameless-two-unknown-roots.image");
const READABLE: &[u8] = include_bytes!("fixtures/format-vocabulary/18.18/base-parent-wait.image");
const FOREIGN: &[u8] = include_bytes!("fixtures/format-vocabulary/foreign-parent-wait.image");

struct RecordsUnavailable {
	store:  MemStore,
	reads:  usize,
	writes: usize,
}

impl StateStore for RecordsUnavailable {
	fn get(&mut self, _: Key<'_>) -> Result<Option<&Record>, StoreError> {
		self.reads += 1;
		Err(StoreError::Backend("record access before required-entry preflight".into()))
	}

	fn scan(&mut self, _: Table, _: &mut dyn FnMut(Key<'_>, &Record)) -> Result<(), StoreError> {
		self.reads += 1;
		Err(StoreError::Backend("record scan before required-entry preflight".into()))
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

fn refuses_required(image: &[u8], id: u32) {
	let engine = Engine::new(EngineConfig::default());
	let mut host = FakeHost::new();
	let mut store =
		RecordsUnavailable { store: MemStore::from_bytes(image).unwrap(), reads: 0, writes: 0 };
	let before = store.store.to_bytes();
	let frames = store.store.get_blob(BlobSlot::Frames).unwrap();
	let result = Shell::restore(
		&engine,
		&mut Cx { host: &mut host, store: &mut store },
		RestoreOpts::default(),
	);
	let error = result
		.err()
		.expect("an unsupported required entry must return no shell");
	println!(
		"error={error:?}; shell_returned=false; reads={}; writes={}; unchanged={}",
		store.reads,
		store.writes,
		before == store.store.to_bytes()
	);
	assert_eq!((store.reads, store.writes), (0, 0));
	assert_eq!(store.store.to_bytes(), before);
	assert_eq!(store.store.get_blob(BlobSlot::Frames).unwrap(), frames);
	assert!(
		matches!(error, RestoreError::Incompatible {
		why: Incompatibility::Vocabulary { id: found, revision: 7, vpid: Some(Vpid(1)) }
	} if found == id),
		"name the unsupported entry and revision: {error:?}"
	);
}

#[test]
fn unknown_required_entry_is_refused_before_records_without_consuming_the_image() {
	refuses_required(REQUIRED, 65537);
}

#[test]
fn a_required_allocation_cannot_be_downgraded_by_an_optional_flag() {
	refuses_required(RESERVED, 1);
}

// Independent consumer view of the persisted protocol, not private VM state.
#[derive(Deserialize)]
struct Header {
	magic:  [u8; 4],
	_ir:    u32,
	frames: u32,
	_build: [u8; 32],
	_runs:  Vec<RunId>,
}

#[derive(Deserialize)]
struct Envelope<'a> {
	#[serde(borrow)]
	_core:   &'a [u8],
	entries: Vec<Entry>,
}

fn check_preserved_payload(store: &mut MemStore) {
	let blob = store.get_blob(BlobSlot::Frames).unwrap().unwrap();
	let (header, body) = postcard::take_from_bytes::<Header>(&blob).unwrap();
	assert_eq!(header.magic, *b"OBF2");
	assert_eq!(header.frames, 29, "an optional entry must not move the core version");
	let (envelope, rest) = postcard::take_from_bytes::<Envelope<'_>>(body).unwrap();
	assert!(rest.is_empty(), "vocabulary data must be inside the image, not a trailer");
	assert_eq!(envelope.entries, vec![Entry {
		id:       65537,
		revision: 7,
		required: false,
		vpid:     Some(Vpid(1)),
		payload:  vec![0, 255, 128, 2, 0, 0, 9],
	}]);
}

#[test]
fn unknown_optional_per_vproc_state_survives_two_snapshots_and_execution_continues() {
	let engine = Engine::new(EngineConfig::default());
	let mut host = FakeHost::new();
	let mut store = MemStore::from_bytes(OPTIONAL).unwrap();
	let (mut shell, report) = Shell::restore(
		&engine,
		&mut Cx { host: &mut host, store: &mut store },
		RestoreOpts::default(),
	)
	.unwrap();
	assert_eq!(report.lost, vec![Lost::Vocabulary {
		id:       65537,
		revision: 7,
		vpid:     Some(Vpid(1)),
	}]);
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
		check_preserved_payload(&mut store);
		let (restored, report) = Shell::restore(
			&engine,
			&mut Cx { host: &mut host, store: &mut store },
			RestoreOpts::default(),
		)
		.unwrap();
		assert_eq!(report.lost, vec![Lost::Vocabulary {
			id:       65537,
			revision: 7,
			vpid:     Some(Vpid(1)),
		}]);
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
			other => panic!("the preserved extension broke normal execution: {other:?}"),
		}
	}
	assert!(idle);
	assert_eq!(host.stdout.bytes(), b"child=23\n");
}

#[test]
fn frameless_unknown_root_state_is_preserved_and_its_loss_is_reported() {
	for (image, ids) in [(FRAMELESS, &[127][..]), (FRAMELESS_MARKS, &[127, 126][..])] {
		let engine = Engine::new(EngineConfig::default());
		let mut host = FakeHost::new();
		let mut store = MemStore::from_bytes(image).unwrap();
		assert!(store.get_blob(BlobSlot::Frames).unwrap().is_none());
		let original: Vec<_> = ids
			.iter()
			.map(|&id| {
				(
					id,
					store
						.record(Key::UnknownMisc(id))
						.cloned()
						.expect("the independent fixture must really contain the unknown root record"),
				)
			})
			.collect();
		let (mut shell, report) = Shell::restore(
			&engine,
			&mut Cx { host: &mut host, store: &mut store },
			RestoreOpts::default(),
		)
		.unwrap();
		println!("frameless_restore={report:?}");
		let run = shell.submit(Script::command(b"printf 'format-root-restored\\n'".as_slice()));
		let mut done = false;
		for _ in 0..10_000 {
			match shell.step(&mut Cx { host: &mut host, store: &mut store }, Budget::default()) {
				Step::Done { run: completed, status } if completed == run => {
					assert_eq!(status, 0);
					done = true;
					break;
				},
				Step::Yield => {},
				other => panic!("the restored frameless root cannot execute: {other:?}"),
			}
		}
		assert!(done, "the restored frameless root must complete its new command");
		assert_eq!(host.stdout.bytes(), b"format-root-restored\n");
		let restored_bytes = store.to_bytes();
		let mut written_back = MemStore::from_bytes(&restored_bytes).unwrap();
		assert!(written_back.get_blob(BlobSlot::Frames).unwrap().is_none());
		for (id, record) in original {
			assert!(report.lost.contains(&Lost::Record { id }));
			assert_eq!(written_back.record(Key::UnknownMisc(id)), Some(&record));
		}
	}
}

fn assert_abandoned_root_runs(image: &[u8], reason: serde_json::Value) {
	let engine = Engine::new(EngineConfig::default());
	let mut host = FakeHost::new();
	let mut store = MemStore::from_bytes(image).unwrap();
	let before = store.to_bytes();
	let (mut shell, report) =
		Shell::restore(&engine, &mut Cx { host: &mut host, store: &mut store }, RestoreOpts {
			drop_frames: true,
		})
		.unwrap();
	println!("explicit_abandonment={report:?}");
	assert_eq!(serde_json::to_value(&report).unwrap()["frames_abandoned"], reason);
	assert_eq!(report.abandoned, [RunId(1)]);
	assert_eq!((report.runs, report.tasks_resumed, report.reissued_fs), (0, 0, 0));
	assert!(
		shell
			.api(&mut Cx { host: &mut host, store: &mut store }, CallId(1))
			.is_none(),
		"no abandoned call may become resumable"
	);
	assert!(store.get_blob(BlobSlot::Frames).unwrap().is_none());
	assert_ne!(
		store.to_bytes(),
		before,
		"explicit abandonment consumes execution instead of claiming unchanged restore"
	);
	assert!(host.stdout.bytes().is_empty());
	let run = shell.submit(Script::command(b"printf 'format-root-recovered\\n'".as_slice()));
	let mut abandoned_done = false;
	let mut fresh_done = false;
	for _ in 0..10_000 {
		match shell.step(&mut Cx { host: &mut host, store: &mut store }, Budget::default()) {
			Step::Done { run: completed, status } if report.abandoned.contains(&completed) => {
				assert_eq!(status, 255);
				abandoned_done = true;
			},
			Step::Done { run: completed, status } if completed == run => {
				assert_eq!(status, 0);
				fresh_done = true;
				break;
			},
			Step::Yield => {},
			other => panic!("explicit abandonment must return only a fresh usable root: {other:?}"),
		}
	}
	assert!(abandoned_done && fresh_done);
	assert_eq!(host.stdout.bytes(), b"format-root-recovered\n");
}

#[test]
fn explicit_abandonment_names_a_foreign_build_without_resuming_it() {
	assert_abandoned_root_runs(FOREIGN, serde_json::json!({"Incompatible": {"why": "Build"}}));
}

#[test]
fn explicit_abandonment_names_an_unsupported_required_entry_without_resuming_it() {
	assert_abandoned_root_runs(
		REQUIRED,
		serde_json::json!({"Incompatible": {"why": {"Vocabulary": {"id": 65537, "revision": 7, "vpid": 1}}}}),
	);
}

#[test]
fn explicit_abandonment_distinguishes_a_readable_image_from_an_incompatible_one() {
	assert_abandoned_root_runs(READABLE, serde_json::json!("Requested"));
}

#[test]
fn explicit_abandonment_does_not_bypass_root_store_integrity() {
	let engine = Engine::new(EngineConfig::default());
	let mut host = FakeHost::new();
	let mut store =
		RecordsUnavailable { store: MemStore::from_bytes(FOREIGN).unwrap(), reads: 0, writes: 0 };
	let before = store.store.to_bytes();
	let error =
		Shell::restore(&engine, &mut Cx { host: &mut host, store: &mut store }, RestoreOpts {
			drop_frames: true,
		})
		.err()
		.expect("abandoning execution must not suppress a root-store failure");
	println!(
		"explicit_abandonment_store_error={error:?}; reads={}; writes={}",
		store.reads, store.writes
	);
	assert!(matches!(error, RestoreError::Store(StoreError::Backend(_))));
	assert!(store.reads > 0);
	assert_eq!(store.writes, 0);
	assert_eq!(store.store.to_bytes(), before);
}
