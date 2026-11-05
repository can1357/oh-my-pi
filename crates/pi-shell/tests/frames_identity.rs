//! A foreign Frames identity must be refused before the engine consumes
//! records whose numeric keys may belong to a different store schema.

use pi_shell::{
	bash::{
		Cx, Engine, EngineConfig, Incompatibility, MemStore, RestoreError, RestoreOpts, Shell,
		store::{BlobSlot, Change, Key, Record, StateStore, StoreError, Table},
	},
	testkit::FakeHost,
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
	assert!(matches!(error, RestoreError::Incompatible {
		why: Incompatibility::IrVersion { found: 14, expected: 15 },
	}));
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
	refuses_foreign_records(RestoreOpts { drop_frames: true });
}
