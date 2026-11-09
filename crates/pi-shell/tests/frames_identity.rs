//! A foreign Frames identity must be refused before the engine consumes
//! records whose numeric keys may belong to a different store schema.

use pi_shell::{
	bash::{
		Budget, Cx, Engine, EngineConfig, Incompatibility, MemStore, RestoreError, RestoreOpts,
		Script, Shell, Step,
		ir::IR_VERSION,
		store::{BlobSlot, Change, Key, Record, StateStore, StoreError, Table},
	},
	testkit::{
		FakeHost, Rig,
		fault::{Fault, skeleton_init},
	},
};

struct ObservedStore {
	inner:       MemStore,
	reads:       usize,
	writes:      usize,
	blob_reads:  usize,
	blob_writes: usize,
}

impl StateStore for ObservedStore {
	fn get(&mut self, key: Key<'_>) -> Result<Option<&Record>, StoreError> {
		self.reads += 1;
		self.inner.get(key)
	}

	fn may_have_local(&mut self, name: &[u8]) -> bool {
		self.reads += 1;
		self.inner.may_have_local(name)
	}

	fn scan(&mut self, table: Table, f: &mut dyn FnMut(Key<'_>, &Record)) -> Result<(), StoreError> {
		self.reads += 1;
		self.inner.scan(table, f)
	}

	fn apply(&mut self, change: Change<'_>) -> Result<(), StoreError> {
		self.writes += 1;
		self.inner.apply(change)
	}

	fn put_blob(&mut self, slot: BlobSlot, bytes: &[u8]) -> Result<(), StoreError> {
		self.blob_writes += 1;
		self.inner.put_blob(slot, bytes)
	}

	fn get_blob(&mut self, slot: BlobSlot) -> Result<Option<Vec<u8>>, StoreError> {
		self.blob_reads += 1;
		self.inner.get_blob(slot)
	}

	fn del_blob(&mut self, slot: BlobSlot) -> Result<(), StoreError> {
		self.blob_writes += 1;
		self.inner.del_blob(slot)
	}

	fn epoch(&self) -> u64 {
		self.inner.epoch()
	}
}

fn refuses_foreign_records(opts: RestoreOpts) {
	let inner = MemStore::from_bytes(include_bytes!("fixtures/frames-ir14.store")).unwrap();
	let before = inner.to_bytes();
	let mut store = ObservedStore { inner, reads: 0, writes: 0, blob_reads: 0, blob_writes: 0 };
	let engine = Engine::new(EngineConfig::default());
	let mut host = FakeHost::new();
	let error = Shell::restore(&engine, &mut Cx { host: &mut host, store: &mut store }, opts)
		.err()
		.expect("a foreign engine image must not restore");
	println!(
		"restore={error:?}; display={error}; record_reads={} record_writes={} blob_reads={} \
		 blob_writes={}",
		store.reads, store.writes, store.blob_reads, store.blob_writes
	);
	let RestoreError::Incompatible { why: Incompatibility::IrVersion { found, expected } } = error
	else {
		panic!("a foreign IR record schema must be refused as such");
	};
	assert_eq!((found, expected), (14, IR_VERSION), "the fixture was written at IR 14");
	assert_eq!(store.reads, 0, "no foreign record can reach an engine consumer");
	assert_eq!(store.writes, 0, "refusal does not recover or modify root state");
	assert_eq!(store.blob_reads, 1, "the identity check reads only the Frames blob");
	assert_eq!(store.blob_writes, 0, "refusal does not consume the Frames blob");
	assert_eq!(store.inner.to_bytes(), before);
}

#[test]
fn foreign_engine_identity_is_refused_before_any_record_access() {
	refuses_foreign_records(RestoreOpts::default());
}

#[test]
fn dropping_frames_cannot_read_a_foreign_ir_record_schema() {
	refuses_foreign_records(RestoreOpts { drop_frames: true, ..Default::default() });
}

/// A store this engine wrote, holding `saved=kept` and one suspended run.
fn suspended_image() -> MemStore {
	let mut rig = Rig::new(FakeHost::new(), skeleton_init(&[]));
	assert_eq!(rig.run(Script::command(&b"saved=kept"[..]), Fault::None), 0);
	rig.shell().submit(Script::command(&b"while :; do :; done"[..]));
	let (shell, host, store) = rig.parts();
	let mut cx = Cx { host, store };
	assert!(matches!(shell.step(&mut cx, Budget { max_ops: 32, max_ns: u64::MAX }), Step::Yield));
	shell.control().request_suspend();
	assert!(matches!(shell.step(&mut cx, Budget::default()), Step::SuspendReady));
	shell.externalize(&mut cx).unwrap();
	MemStore::from_bytes(&rig.store.to_bytes()).unwrap()
}

fn refuses_foreign_magic(opts: RestoreOpts) {
	let mut inner = suspended_image();
	let mut frames = inner.get_blob(BlobSlot::Frames).unwrap().unwrap();
	assert_eq!(&frames[..4], b"OBF1", "the header starts with the magic");
	assert_eq!(
		u32::from(frames[4]),
		IR_VERSION,
		"this image is written by this engine, and the IR version is a one-byte varint"
	);
	frames[..4].copy_from_slice(b"BAD!");
	inner.put_blob(BlobSlot::Frames, &frames).unwrap();
	let before = inner.to_bytes();
	let mut store = ObservedStore { inner, reads: 0, writes: 0, blob_reads: 0, blob_writes: 0 };
	let engine = Engine::new(EngineConfig::default());
	let mut host = FakeHost::new();
	let result = Shell::restore(&engine, &mut Cx { host: &mut host, store: &mut store }, opts);
	match &result {
		Ok((_, report)) => println!(
			"restore=Ok({report:?}); record_reads={} record_writes={} blob_reads={} blob_writes={}",
			store.reads, store.writes, store.blob_reads, store.blob_writes
		),
		Err(error) => println!(
			"restore={error:?}; display={error}; record_reads={} record_writes={} blob_reads={} \
			 blob_writes={}",
			store.reads, store.writes, store.blob_reads, store.blob_writes
		),
	}
	assert!(matches!(result, Err(RestoreError::Incompatible { why: Incompatibility::Magic })));
	assert_eq!(store.reads, 0, "no foreign record can reach an engine consumer");
	assert_eq!(store.writes, 0, "refusal does not recover or modify root state");
	assert_eq!(store.blob_reads, 1, "the identity check reads only the Frames blob");
	assert_eq!(store.blob_writes, 0, "refusal does not consume the Frames blob");
	assert_eq!(store.inner.to_bytes(), before);
}

#[test]
fn foreign_magic_is_refused_before_any_record_access() {
	refuses_foreign_magic(RestoreOpts::default());
}

#[test]
fn dropping_frames_cannot_bypass_foreign_magic() {
	refuses_foreign_magic(RestoreOpts { drop_frames: true, ..Default::default() });
}
