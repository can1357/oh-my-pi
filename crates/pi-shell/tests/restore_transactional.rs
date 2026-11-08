//! A refused restore must not consume the only resumable image.
#![cfg(unix)]

use std::sync::Arc;

use bstr::BString;
use pi_shell::{
	bash::{
		Budget, CallId, CallOutcome, Cx, Engine, EngineConfig, MemStore, RestoreOpts, RestoreReport,
		RunId, Script, Shell, ShellApi, StateStore, Step,
		store::{BlobSlot, Change, Key, Record, RestoreWrite, StoreError, Table},
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

	fn commit_restore(&mut self, writes: Vec<RestoreWrite>) -> Result<(), StoreError> {
		// Exercise every backend write's admission without publishing any of
		// them.
		for write in &writes {
			let operation = match write {
				RestoreWrite::Put(key, _) => format!("put {:?}", key.as_key()),
				RestoreWrite::Delete(key) => format!("del {:?}", key.as_key()),
				RestoreWrite::DeleteBlob(slot) => format!("del_blob {slot:?}"),
			};
			self.operation(operation, true)?;
		}
		self.operation("commit restore".into(), true)?;
		self.inner.commit_restore(writes)
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
	// A record without a surviving parent must be removed only at commit.
	store
		.apply(Change::Put(Key::Proc(pi_shell::bash::Vpid(9)), Record::Proc {
			parent: None,
			status: Some(5),
		}))
		.unwrap();
	store
		.apply(Change::Put(
			Key::UnknownMisc(200),
			Record::Misc(BString::from(b"opaque\0\xffexecution state".as_slice())),
		))
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
	assert_eq!(host.stdout.bytes(), b"kept=127\nchild=23\nresumed\n");
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
			lost: vec![pi_shell::bash::Lost::Record { id: 200 }, pi_shell::bash::Lost::Vproc {
				vpid: pi_shell::bash::Vpid(1_073_741_825),
			}],
			abandoned: if drop_frames {
				vec![image.run]
			} else {
				Vec::new()
			},
			frames_abandoned: drop_frames.then_some(pi_shell::bash::FrameAbandonment::Requested),
			..RestoreReport::default()
		}
	} else {
		RestoreReport {
			vprocs: 2,
			runs: 1,
			lost: vec![pi_shell::bash::Lost::Record { id: 200 }],
			..RestoreReport::default()
		}
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
		"successful atomic commit must consume the frame image"
	);
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
	assert_eq!(report, expected);
	let operations = baseline.operations;
	let mut failures = Vec::new();
	for (index, operation) in operations.iter().enumerate() {
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
		for attempt in 1..=if permanent { 3 } else { 1 } {
			let result = Shell::restore(&engine, &mut Cx { host: &mut host, store: &mut store }, opts);
			assert!(!store.refused.is_empty(), "injection {index}: {operation} was reached");
			let unchanged = store.inner.to_bytes() == before;
			let reported = matches!(result, Err(pi_shell::bash::RestoreError::Store(_)));
			println!(
				"point={} {operation}: attempt={attempt} reported={reported} unchanged={unchanged}",
				index + 1
			);
			if !unchanged || !reported {
				failures.push(format!(
					"point={} {operation}: reported={reported} unchanged={unchanged}",
					index + 1
				));
				break;
			}
		}
		if store.inner.to_bytes() == before {
			store.refuse_at = None;
			store.refuse_forever = None;
			let (mut shell, report) =
				Shell::restore(&engine, &mut Cx { host: &mut host, store: &mut store }, opts).unwrap();
			assert_eq!(report, expected);
			finish(&mut shell, &mut host, &mut store, &image, drop_frames || frameless);
		}
	}
	println!("exercised {} observed fallible operations", operations.len());
	assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn every_normal_restore_refusal_preserves_execution_or_all_store_bytes() {
	sweep(false, false, false);
}

#[test]
fn every_drop_frames_refusal_preserves_cleanup_or_all_store_bytes() {
	sweep(true, false, false);
}

#[test]
fn every_frameless_restore_refusal_preserves_cleanup_or_all_store_bytes() {
	sweep(false, true, false);
}

#[test]
fn permanently_refused_normal_restore_step_preserves_execution_or_all_store_bytes() {
	sweep(false, false, true);
}

#[test]
fn permanently_refused_drop_frames_step_preserves_cleanup_or_all_store_bytes() {
	sweep(true, false, true);
}

#[test]
fn permanently_refused_frameless_step_preserves_cleanup_or_all_store_bytes() {
	sweep(false, true, true);
}

#[test]
fn permanently_refused_writes_leave_the_image_retryable() {
	let image = snapshot();
	let mut store = RefusingStore {
		inner: MemStore::from_bytes(&image.bytes).unwrap(),
		refuse_writes: true,
		..RefusingStore::default()
	};
	let before = store.inner.to_bytes();
	let mut host = FakeHost::new();
	let engine = Engine::new(EngineConfig::default());
	for _ in 0..3 {
		let result = Shell::restore(
			&engine,
			&mut Cx { host: &mut host, store: &mut store },
			RestoreOpts::default(),
		);
		assert!(matches!(result, Err(pi_shell::bash::RestoreError::Store(_))));
		assert_eq!(store.inner.to_bytes(), before);
	}
	assert!(store.refusals >= 3);
	store.refuse_writes = false;
	let (mut shell, _) = Shell::restore(
		&engine,
		&mut Cx { host: &mut host, store: &mut store },
		RestoreOpts::default(),
	)
	.unwrap();
	resume(&mut shell, &mut host, &mut store, &image);
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

struct SignalHost {
	inner:    FakeHost,
	refuse:   bool,
	refusals: usize,
}

// Refuse only the real host boundary; all execution and store behavior stays
// the same as FakeHost, including output, callouts, and virtual processes.
impl pi_shell::bash::Host for SignalHost {
	fn resolve(
		&mut self,
		name: &bstr::BStr,
		mode: pi_shell::bash::ModeId,
		why: pi_shell::bash::ResolveCtx,
	) -> pi_shell::bash::Resolved {
		self.inner.resolve(name, mode, why)
	}

	fn start(
		&mut self,
		cmd: &pi_shell::bash::NativeRef,
		inv: pi_shell::bash::Invocation<'_>,
	) -> std::io::Result<Box<dyn pi_shell::bash::Task>> {
		self.inner.start(cmd, inv)
	}

	fn restore_task(
		&mut self,
		cmd: &pi_shell::bash::NativeRef,
		state: &[u8],
	) -> std::io::Result<Box<dyn pi_shell::bash::Task>> {
		self.inner.restore_task(cmd, state)
	}

	fn spawn(&mut self, spec: pi_shell::bash::SpawnSpec<'_>) -> pi_shell::bash::SpawnFuture {
		self.inner.spawn(spec)
	}

	fn set_signal_trap(
		&mut self,
		_: pi_shell::bash::Signal,
		_: Option<&bstr::BStr>,
	) -> std::io::Result<bool> {
		if self.refuse {
			self.refusals += 1;
			Err(std::io::Error::other("injected signal setup refusal"))
		} else {
			Ok(true)
		}
	}

	fn fs(&mut self) -> &mut dyn pi_shell::bash::Fs {
		self.inner.fs()
	}

	fn stdio(&mut self, fd: pi_shell::bash::StdFd) -> Option<Box<dyn pi_shell::bash::fs::File>> {
		self.inner.stdio(fd)
	}

	fn now_ns(&self) -> u64 {
		self.inner.now_ns()
	}

	fn timer(&mut self, at: pi_shell::bash::Deadline) -> Box<dyn pi_shell::bash::Timer> {
		self.inner.timer(at)
	}

	fn wall(&self) -> pi_shell::bash::SystemTimeLike {
		self.inner.wall()
	}

	fn random(&mut self) -> u64 {
		self.inner.random()
	}

	fn shell_pid(&self) -> u32 {
		self.inner.shell_pid()
	}

	fn ppid(&self) -> u32 {
		self.inner.ppid()
	}

	fn user(&self) -> pi_shell::bash::UserInfo {
		self.inner.user()
	}

	fn hostname(&self) -> BString {
		self.inner.hostname()
	}

	fn tty(&mut self, fd: i32) -> Option<pi_shell::bash::TtyInfo> {
		self.inner.tty(fd)
	}

	fn tz_offset(&self, tz: Option<&bstr::BStr>, unix_s: i64) -> (i32, BString) {
		self.inner.tz_offset(tz, unix_s)
	}

	fn event(&mut self, ev: &pi_shell::bash::Event<'_>) -> pi_shell::bash::Verdict {
		self.inner.event(ev)
	}
}

fn signal_refusal(drop_frames: bool, frameless: bool) {
	let image = image_for(frameless);
	let opts = RestoreOpts { drop_frames };
	let mut store = RefusingStore {
		inner: MemStore::from_bytes(&image.bytes).unwrap(),
		..RefusingStore::default()
	};
	let mut host = SignalHost { inner: FakeHost::new(), refuse: true, refusals: 0 };
	let engine = Engine::new(EngineConfig::default());
	let before = store.inner.to_bytes();
	let error = Shell::restore(&engine, &mut Cx { host: &mut host, store: &mut store }, opts)
		.err()
		.expect("host signal setup must be fallible");
	assert!(matches!(error, pi_shell::bash::RestoreError::SignalSetup { .. }));
	assert_eq!(host.refusals, 1);
	assert!(
		store.inner.to_bytes() == before,
		"signal refusal consumed the resumable image: {error:?}; before_bytes={}; after_bytes={}",
		before.len(),
		store.inner.to_bytes().len()
	);
	host.refuse = false;
	let (mut shell, report) =
		Shell::restore(&engine, &mut Cx { host: &mut host, store: &mut store }, opts).unwrap();
	assert_eq!(report, expected_report(&image, drop_frames, frameless));
	finish(&mut shell, &mut host.inner, &mut store, &image, drop_frames || frameless);
}

#[test]
fn refused_signal_setup_preserves_resumable_image() {
	signal_refusal(false, false);
}

#[test]
fn drop_frames_refused_signal_setup_preserves_store() {
	signal_refusal(true, false);
}

#[test]
fn frameless_refused_signal_setup_preserves_store() {
	signal_refusal(false, true);
}

#[test]
fn frameless_refused_scope_cleanup_cannot_leak_locals_into_the_next_function() {
	let image = image_for(true);
	let mut store = RefusingStore {
		inner: MemStore::from_bytes(&image.bytes).unwrap(),
		refuse_forever: Some("del Scope(0)".into()),
		..RefusingStore::default()
	};
	let engine = Engine::new(EngineConfig::default());
	let mut host = FakeHost::new();
	let before = store.inner.to_bytes();
	let result = Shell::restore(
		&engine,
		&mut Cx { host: &mut host, store: &mut store },
		RestoreOpts::default(),
	);
	assert!(matches!(result, Err(pi_shell::bash::RestoreError::Store(_))));
	assert_eq!(store.inner.to_bytes(), before);
	assert!(store.refusals > 0);
	store.refuse_forever = None;
	let (mut shell, report) = Shell::restore(
		&engine,
		&mut Cx { host: &mut host, store: &mut store },
		RestoreOpts::default(),
	)
	.unwrap();
	assert_eq!(report, expected_report(&image, false, true));
	// No suspension or intervening step: the first command reuses the
	// abandoned function's depth and materializes another local there.
	let run = shell.submit(Script::command(
		br#"fresh_scope(){ local fresh=1; echo local=${KEEP-unset}; }; fresh_scope"#.as_slice(),
	));
	let mut done = false;
	for _ in 0..10_000 {
		match shell.step(&mut Cx { host: &mut host, store: &mut store }, Budget::default()) {
			Step::Done { run: id, status } if id == run => {
				assert_eq!(status, 0);
				done = true;
				break;
			},
			Step::Yield => {},
			other => panic!("the new function must complete: {other:?}"),
		}
	}
	assert!(done);
	assert_eq!(host.stdout.bytes(), b"local=unset\n");
}

#[test]
fn refused_frames_commit_preserves_opaque_records_and_reports_the_second_restore_loss() {
	let image = snapshot();
	let mut store = RefusingStore {
		inner: MemStore::from_bytes(&image.bytes).unwrap(),
		refuse_forever: Some("del_blob Frames".into()),
		..RefusingStore::default()
	};
	let key = Key::UnknownMisc(200);
	let record = Record::Misc(b"opaque retained execution state".as_slice().into());
	store.inner.apply(Change::Put(key, record.clone())).unwrap();
	let before = store.inner.to_bytes();
	let engine = Engine::new(EngineConfig::default());
	let mut host = FakeHost::new();
	let result = Shell::restore(
		&engine,
		&mut Cx { host: &mut host, store: &mut store },
		RestoreOpts::default(),
	);
	assert!(matches!(result, Err(pi_shell::bash::RestoreError::Store(_))));
	assert_eq!(store.inner.to_bytes(), before);
	store.refuse_forever = None;
	let (mut shell, report) = Shell::restore(
		&engine,
		&mut Cx { host: &mut host, store: &mut store },
		RestoreOpts::default(),
	)
	.unwrap();
	assert_eq!(report.lost, [pi_shell::bash::Lost::Record { id: 200 }]);
	assert_eq!(store.inner.get(key).unwrap(), Some(&record));
	resume(&mut shell, &mut host, &mut store, &image);
}
