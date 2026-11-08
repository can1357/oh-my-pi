//! Restore refusals during the read-only prefix leave the saved image
//! retryable.
#![cfg(unix)]

use std::sync::Arc;

use bstr::BString;
use pi_shell::{
	bash::{
		Budget, CallId, CallOutcome, Cx, Engine, EngineConfig, MemStore, RestoreOpts, RestoreReport,
		RunId, Script, Shell, ShellApi, StateStore, Step,
		store::{BlobSlot, Change, Key, Record, StoreError, Table},
	},
	testkit::{FakeHost, fault::skeleton_init},
};

#[derive(Default)]
struct RefusingStore {
	inner:          MemStore,
	operations:     Vec<String>,
	refuse_at:      Option<usize>,
	refuse_forever: Option<String>,
	forever_from:   usize,
	refused:        Vec<String>,
	refuse_writes:  bool,
	refuse_all:     bool,
	refusals:       usize,
}

impl RefusingStore {
	fn operation(&mut self, operation: String, write: bool) -> Result<(), StoreError> {
		self.operations.push(operation);
		if self.refuse_all
			|| self.refuse_at == Some(self.operations.len())
			|| (self.operations.len() >= self.forever_from
				&& self.refuse_forever.as_ref() == self.operations.last())
			|| (write && self.refuse_writes)
		{
			self.refusals += 1;
			self.refused.push(self.operations.last().unwrap().clone());
			return Err(StoreError::Backend("injected restore refusal".into()));
		}
		Ok(())
	}
}

impl StateStore for RefusingStore {
	fn get(&mut self, key: Key<'_>) -> Result<Option<&Record>, StoreError> {
		self.operation(format!("get {key:?}"), false)?;
		self.inner.get(key)
	}

	fn scan(&mut self, table: Table, f: &mut dyn FnMut(Key<'_>, &Record)) -> Result<(), StoreError> {
		self.operation(format!("scan {table:?}"), false)?;
		self.inner.scan(table, f)
	}

	fn apply(&mut self, change: Change<'_>) -> Result<(), StoreError> {
		let operation = match &change {
			Change::Put(key, _) => format!("put {key:?}"),
			Change::Del(key) => format!("del {key:?}"),
			other => format!("apply {other:?}"),
		};
		self.operation(operation, true)?;
		self.inner.apply(change)
	}

	fn put_blob(&mut self, slot: BlobSlot, bytes: &[u8]) -> Result<(), StoreError> {
		self.operation(format!("put_blob {slot:?}"), true)?;
		self.inner.put_blob(slot, bytes)
	}

	fn get_blob(&mut self, slot: BlobSlot) -> Result<Option<Vec<u8>>, StoreError> {
		self.operation(format!("get_blob {slot:?}"), false)?;
		self.inner.get_blob(slot)
	}

	fn del_blob(&mut self, slot: BlobSlot) -> Result<(), StoreError> {
		self.operation(format!("del_blob {slot:?}"), true)?;
		self.inner.del_blob(slot)
	}

	fn epoch(&self) -> u64 {
		self.inner.epoch()
	}
}

struct Snapshot {
	bytes: Vec<u8>,
	run:   RunId,
	call:  CallId,
}

fn snapshot() -> Snapshot {
	let engine = Engine::new(EngineConfig::default());
	let mut host = FakeHost::new();
	host.tool("hold", Arc::new(|_: &mut ShellApi<'_, '_>, _: &[BString]| CallOutcome::Exit(0)));
	let mut store = MemStore::new();
	let mut shell =
		Shell::create(&engine, &mut Cx { host: &mut host, store: &mut store }, skeleton_init(&[]))
			.unwrap();
	// A root function scope makes the frameless/drop-frames cleanup observable;
	// a live virtual child and its parent's wait prove successful restoration.
	let run = shell.submit(Script::command(
		br#"trap ':' USR1; parent(){ local KEEP=preserved; f(){ g(){ return 7; }; g & q=$!; wait "$q"; jobs; hold; wait "$q"; echo kept=$?; return 23; }; f & p=$!; wait "$p"; echo child=$?; }; parent; echo resumed"#.as_slice(),
	));
	let mut call = None;
	let mut blocked = false;
	for _ in 0..10_000 {
		match shell.step(&mut Cx { host: &mut host, store: &mut store }, Budget::default()) {
			Step::Call { id, .. } => {
				assert!(call.replace(id).is_none(), "only one held call");
			},
			Step::Blocked => {
				blocked = true;
				break;
			},
			Step::Yield => {},
			other => panic!("unexpected snapshot preparation: {other:?}"),
		}
	}
	assert!(blocked, "the child and parent wait must be suspended");
	shell.control().request_suspend();
	assert!(matches!(
		shell.step(&mut Cx { host: &mut host, store: &mut store }, Budget::default()),
		Step::SuspendReady
	));
	shell
		.externalize(&mut Cx { host: &mut host, store: &mut store })
		.unwrap();
	Snapshot { bytes: store.to_bytes(), run, call: call.unwrap() }
}

fn resume(shell: &mut Shell, host: &mut FakeHost, store: &mut RefusingStore, image: &Snapshot) {
	shell.complete(image.call, CallOutcome::Exit(0));
	let mut done = false;
	for _ in 0..10_000 {
		match shell.step(&mut Cx { host, store }, Budget::default()) {
			Step::Done { run, status } if run == image.run => {
				assert_eq!(status, 0);
				done = true;
				break;
			},
			Step::Yield => {},
			other => panic!("restored execution must finish: {other:?}"),
		}
	}
	assert!(done, "the original run must complete");
	assert_eq!(host.stdout.bytes(), b"kept=7\nchild=23\nresumed\n");
}

fn image_for(frameless: bool) -> Snapshot {
	let mut image = snapshot();
	if frameless {
		let mut store = MemStore::from_bytes(&image.bytes).unwrap();
		store.del_blob(BlobSlot::Frames).unwrap();
		image.bytes = store.to_bytes();
	}
	image
}

fn expected_report(image: &Snapshot, drop_frames: bool, frameless: bool) -> RestoreReport {
	if drop_frames || frameless {
		RestoreReport {
			lost: vec![pi_shell::bash::Lost::Vproc { vpid: pi_shell::bash::Vpid(1_073_741_825) }],
			abandoned: if drop_frames {
				vec![image.run]
			} else {
				Vec::new()
			},
			..RestoreReport::default()
		}
	} else {
		RestoreReport { vprocs: 2, runs: 1, ..RestoreReport::default() }
	}
}

fn finish(
	shell: &mut Shell,
	host: &mut FakeHost,
	store: &mut RefusingStore,
	image: &Snapshot,
	frameless: bool,
) {
	if store
		.operations
		.iter()
		.any(|op| op == "get Misc(JobFrames)")
	{
		let mut saved = MemStore::from_bytes(&image.bytes).unwrap();
		let mut present = false;
		saved
			.scan(Table::Misc, &mut |key, record| {
				present |= format!("{key:?}") == "Misc(JobFrames)"
					&& matches!(record, Record::Misc(bytes) if !bytes.is_empty());
			})
			.unwrap();
		assert!(present, "the snapshot must exercise deletion of a nonempty optional job record");
	}
	// Cleanup may remain pending until this next sync. Suspending reaches
	// that sync without executing a command or consuming the lost-child status.
	shell.control().request_suspend();
	let mut synced = false;
	let mut abandoned = 0;
	for _ in 0..10_000 {
		match shell.step(&mut Cx { host, store }, Budget::default()) {
			Step::SuspendReady => {
				synced = true;
				break;
			},
			Step::Done { run, status: 255 } if frameless && run == image.run => {
				abandoned += 1;
				assert_eq!(abandoned, 1, "an abandoned run reports completion only once");
			},
			other => panic!("cleanup sync must preserve execution: {other:?}"),
		}
	}
	assert!(synced, "the cleanup must reach its next sync");
	if frameless {
		let mut scopes = Vec::new();
		store
			.inner
			.scan(Table::Scope, &mut |key, _| scopes.push(key.to_buf()))
			.unwrap();
		assert!(scopes.is_empty(), "abandoned function scopes must be removed: {scopes:?}");
		let mut children = Vec::new();
		store
			.inner
			.scan(Table::Proc, &mut |key, rec| children.push((key.to_buf(), rec.clone())))
			.unwrap();
		assert_eq!(children, vec![(
			Key::Proc(pi_shell::bash::Vpid(1_073_741_825)).to_buf(),
			Record::Proc { parent: Some(pi_shell::bash::Vpid(1_073_741_824)), status: Some(137) }
		)]);
		let run = shell.submit(Script::command(
			br#"wait "$p"; echo lost=$?; echo local=${KEEP-unset}"#.as_slice(),
		));
		let mut done = false;
		for _ in 0..10_000 {
			match shell.step(&mut Cx { host, store }, Budget::default()) {
				Step::Done { run: id, status } if id == run => {
					assert_eq!(status, 0);
					done = true;
					break;
				},
				Step::Yield | Step::Done { .. } => {},
				other => panic!("restored root must remain usable: {other:?}"),
			}
		}
		assert!(done);
		assert_eq!(host.stdout.bytes(), b"lost=137\nlocal=unset\n");
	} else {
		resume(shell, host, store, image);
	}
	assert!(
		store.inner.get_blob(BlobSlot::Frames).unwrap().is_none(),
		"successful restore must consume the frame image"
	);
	let mut sidecar = false;
	store
		.inner
		.scan(Table::Misc, &mut |key, _| sidecar |= format!("{key:?}") == "Misc(JobFrames)")
		.unwrap();
	assert!(!sidecar, "successful restore must consume the saved job state");
}

fn sweep(drop_frames: bool, frameless: bool, permanent: bool) {
	let image = image_for(frameless);
	let opts = RestoreOpts { drop_frames };
	let expected = expected_report(&image, drop_frames, frameless);
	let mut baseline = RefusingStore {
		inner: MemStore::from_bytes(&image.bytes).unwrap(),
		..RefusingStore::default()
	};
	let (_, report) = Shell::restore(
		&Engine::new(EngineConfig::default()),
		&mut Cx { host: &mut FakeHost::new(), store: &mut baseline },
		opts,
	)
	.unwrap();
	assert_eq!(report, expected, "unfaulted restore must satisfy the independent contract");
	let operations = baseline.operations;
	assert!(!operations.is_empty(), "the real restore must reach the store");
	let mut failures = Vec::new();
	// Keep the read-only-prefix rows; transactional cleanup is a separate
	// contract.
	let reads = operations
		.iter()
		.take_while(|operation| {
			!operation.starts_with("put ")
				&& !operation.starts_with("del ")
				&& !operation.starts_with("del_blob ")
		})
		.count();
	for (index, operation) in operations.iter().take(reads).enumerate() {
		let mut store = RefusingStore {
			inner: MemStore::from_bytes(&image.bytes).unwrap(),
			refuse_at: (!permanent).then_some(index + 1),
			refuse_forever: permanent.then(|| operation.clone()),
			forever_from: index + 1,
			..RefusingStore::default()
		};
		let before = store.inner.to_bytes();
		let mut host = FakeHost::new();
		let engine = Engine::new(EngineConfig::default());
		let mut restored = None;
		for attempt in 1..=if permanent { 3 } else { 1 } {
			let result = Shell::restore(&engine, &mut Cx { host: &mut host, store: &mut store }, opts);
			assert!(!store.refused.is_empty(), "injection {index}: {operation} was reached");
			assert!(
				store.refused.iter().all(|actual| actual == operation),
				"injection must refuse the selected operation, not a different ordinal: {:?}",
				store.refused
			);
			match result {
				Ok(value) => {
					println!("point={} {operation}: attempt={attempt} success {:?}", index + 1, value.1);
					restored = Some(value);
					break;
				},
				Err(error) => {
					let after = store.inner.to_bytes();
					let unchanged = after == before;
					println!(
						"point={} {operation}: attempt={attempt} error={error:?}; \
						 unchanged={unchanged}; before_bytes={}; after_bytes={}",
						index + 1,
						before.len(),
						after.len()
					);
					if !unchanged {
						failures.push(format!(
							"point={} {operation}: failed restore changed store bytes ({} -> {})",
							index + 1,
							before.len(),
							after.len()
						));
						break;
					}
				},
			}
		}
		store.refuse_at = None;
		store.refuse_forever = None;
		if restored.is_none() && store.inner.to_bytes() == before {
			restored = Some(
				Shell::restore(&engine, &mut Cx { host: &mut host, store: &mut store }, opts)
					.expect("a refused unchanged restore must be retryable"),
			);
		}
		if let Some((mut shell, report)) = restored {
			if report != expected {
				failures.push(format!(
					"{operation}: retry lost execution: {report:?}, expected {expected:?}"
				));
			} else {
				finish(&mut shell, &mut host, &mut store, &image, drop_frames || frameless);
			}
		}
	}
	println!("exercised {reads} read-only-prefix operations");
	assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn normal_restore_read_prefix_refusals_preserve_execution_and_store_bytes() {
	sweep(false, false, false);
}

#[test]
fn drop_frames_read_prefix_refusals_preserve_execution_and_store_bytes() {
	sweep(true, false, false);
}

#[test]
fn frameless_restore_read_prefix_refusals_preserve_execution_and_store_bytes() {
	sweep(false, true, false);
}

#[test]
fn permanently_refused_normal_read_prefix_preserves_execution_and_store_bytes() {
	sweep(false, false, true);
}

#[test]
fn permanently_refused_drop_frames_read_prefix_preserves_execution_and_store_bytes() {
	sweep(true, false, true);
}

#[test]
fn permanently_refused_frameless_read_prefix_preserves_execution_and_store_bytes() {
	sweep(false, true, true);
}

#[test]
fn permanently_unreadable_store_keeps_every_retry_byte_identical() {
	let image = snapshot();
	let mut store = RefusingStore {
		inner: MemStore::from_bytes(&image.bytes).unwrap(),
		refuse_all: true,
		..RefusingStore::default()
	};
	for _ in 0..3 {
		let before = store.inner.to_bytes();
		let error = Shell::restore(
			&Engine::new(EngineConfig::default()),
			&mut Cx { host: &mut FakeHost::new(), store: &mut store },
			RestoreOpts::default(),
		)
		.err()
		.expect("a store that refuses every operation must refuse restore");
		assert!(matches!(error, pi_shell::bash::RestoreError::Store(_)));
		assert_eq!(store.inner.to_bytes(), before, "permanent refusal consumed state");
	}
	assert_eq!(store.refusals, 3);
}
