//! A refused frame deletion must not detach the saved job state from its image.
#![cfg(unix)]

use std::sync::Arc;

use bstr::BString;
use pi_shell::{
	bash::{
		Budget, CallOutcome, Cx, Engine, EngineConfig, MemStore, RestoreOpts, Script, Shell,
		ShellApi, StateStore, Step,
		store::{BlobSlot, Change, Key, Record, StoreError, Table},
	},
	testkit::{FakeHost, fault::skeleton_init},
};

struct RefuseFrames {
	inner:    MemStore,
	refuse:   bool,
	refusals: usize,
}

impl StateStore for RefuseFrames {
	fn get(&mut self, key: Key<'_>) -> Result<Option<&Record>, StoreError> {
		self.inner.get(key)
	}

	fn scan(&mut self, table: Table, f: &mut dyn FnMut(Key<'_>, &Record)) -> Result<(), StoreError> {
		self.inner.scan(table, f)
	}

	fn apply(&mut self, change: Change<'_>) -> Result<(), StoreError> {
		self.inner.apply(change)
	}

	fn put_blob(&mut self, slot: BlobSlot, bytes: &[u8]) -> Result<(), StoreError> {
		self.inner.put_blob(slot, bytes)
	}

	fn get_blob(&mut self, slot: BlobSlot) -> Result<Option<Vec<u8>>, StoreError> {
		self.inner.get_blob(slot)
	}

	fn del_blob(&mut self, slot: BlobSlot) -> Result<(), StoreError> {
		if self.refuse && slot == BlobSlot::Frames {
			self.refusals += 1;
			return Err(StoreError::Backend("refused Frames deletion".into()));
		}
		self.inner.del_blob(slot)
	}

	fn epoch(&self) -> u64 {
		self.inner.epoch()
	}
}

#[test]
fn refused_frames_deletion_cannot_silently_lose_kept_status_on_second_restore() {
	let engine = Engine::new(EngineConfig::default());
	let mut host = FakeHost::new();
	host.tool("hold", Arc::new(|_: &mut ShellApi<'_, '_>, _: &[BString]| CallOutcome::Exit(0)));
	let mut store = RefuseFrames { inner: MemStore::new(), refuse: false, refusals: 0 };
	let mut shell =
		Shell::create(&engine, &mut Cx { host: &mut host, store: &mut store }, skeleton_init(&[]))
			.unwrap();
	let run = shell.submit(Script::command(
		br#"f(){ g(){ return 7; }; g & q=$!; wait "$q"; jobs; hold; wait "$q"; echo kept=$?; }; f & wait"#.as_slice(),
	));
	let mut call = None;
	for _ in 0..10_000 {
		match shell.step(&mut Cx { host: &mut host, store: &mut store }, Budget::default()) {
			Step::Call { id, .. } => call = Some(id),
			Step::Blocked => break,
			Step::Yield => {},
			other => panic!("preparing snapshot: {other:?}"),
		}
	}
	let call = call.expect("the consumer must be held before its second wait");
	shell.control().request_suspend();
	assert!(matches!(
		shell.step(&mut Cx { host: &mut host, store: &mut store }, Budget::default()),
		Step::SuspendReady
	));
	shell
		.externalize(&mut Cx { host: &mut host, store: &mut store })
		.unwrap();
	drop(shell);
	let before = store.inner.to_bytes();
	store.refuse = true;
	let first = Shell::restore(
		&engine,
		&mut Cx { host: &mut host, store: &mut store },
		RestoreOpts::default(),
	);
	assert_eq!(store.refusals, 1);
	println!(
		"first_restore={:?}; unchanged={}",
		first.as_ref().map(|(_, report)| report),
		store.inner.to_bytes() == before
	);
	drop(first);
	store.refuse = false;
	let (mut shell, report) = Shell::restore(
		&engine,
		&mut Cx { host: &mut host, store: &mut store },
		RestoreOpts::default(),
	)
	.unwrap();
	println!("second_restore={report:?}");
	shell.complete(call, CallOutcome::Exit(0));
	let mut done = false;
	for _ in 0..10_000 {
		match shell.step(&mut Cx { host: &mut host, store: &mut store }, Budget::default()) {
			Step::Done { run: id, status } if id == run => {
				assert_eq!(status, 0);
				done = true;
				break;
			},
			Step::Yield => {},
			other => panic!("resuming consumer: {other:?}"),
		}
	}
	assert!(done);
	println!("consumer={}", String::from_utf8_lossy(&host.stdout.bytes()));
	assert_eq!(host.stdout.bytes(), b"kept=7\n");
}
