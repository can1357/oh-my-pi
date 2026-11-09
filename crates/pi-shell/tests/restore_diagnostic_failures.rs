//! Diagnostic metadata reads after the restore commit must not abandon
//! execution.
use pi_shell::{
	bash::{
		Budget, Cx, Engine, EngineConfig, MemStore, RestoreOpts, Script, Shell, StateStore, Step,
		Vpid,
		store::{BlobSlot, Change, Key, Record, RestoreWrite, StoreError, Table},
		zshopt::ZshOpt,
	},
	testkit::{FakeHost, fault::skeleton_init},
};

#[test]
fn post_commit_bash_locale_read_failures_do_not_abandon_restored_execution() {
	assert_post_commit_diagnostics(false);
}

#[test]
fn post_commit_zsh_locale_read_failures_do_not_abandon_restored_execution() {
	assert_post_commit_diagnostics(true);
}

fn assert_post_commit_diagnostics(zsh: bool) {
	let mut healthy_stderr = None;
	for refused in [None, Some(b"LC_ALL".as_slice()), Some(b"LC_CTYPE"), Some(b"LANG")] {
		let engine = Engine::new(EngineConfig::default());
		let mut host = FakeHost::new();
		let mut inner = MemStore::new();
		drop(
			Shell::create(&engine, &mut Cx { host: &mut host, store: &mut inner }, skeleton_init(&[]))
				.unwrap(),
		);
		inner
			.apply(Change::Put(Key::Proc(Vpid(9)), Record::Proc {
				parent: Some(Vpid(9)),
				status: None,
			}))
			.unwrap();
		if zsh {
			inner
				.apply(Change::Put(
					Key::Misc(pi_shell::bash::store::MiscKey::Mode),
					Record::Misc(b"zsh".as_slice().into()),
				))
				.unwrap();
			inner
				.apply(Change::Put(Key::ZshOpt(ZshOpt::Multibyte), Record::Opt(true)))
				.unwrap();
		}
		let mut store = PostCommitReadFailure { inner, refused, commits: 0, failures: 0 };
		let (mut shell, _) = Shell::restore(
			&engine,
			&mut Cx { host: &mut host, store: &mut store },
			RestoreOpts::default(),
		)
		.expect("diagnostic metadata must not turn a committed restore into an error");
		assert_eq!(store.commits, 1);
		assert_eq!(store.failures, usize::from(refused.is_some()), "zsh={zsh}, refused={refused:?}");
		let diagnostic = host
			.events
			.iter()
			.find(|event| event.to_string().contains("restoring as owned"))
			.expect("the diagnostic event must survive the metadata failure");
		assert_eq!(
			diagnostic["mode"],
			if zsh { "zsh" } else { "bash" },
			"the restored diagnostic must exercise the requested dialect"
		);
		assert!(
			!matches!(store.get(Key::Proc(Vpid(9))).unwrap(), Some(Record::Proc { .. })),
			"the ownership normalization or cleanup must remain committed"
		);
		let run = shell.submit(Script::command(b"echo after_restore".as_slice()));
		let mut done = false;
		let mut idle = false;
		for _ in 0..1_000 {
			match shell.step(&mut Cx { host: &mut host, store: &mut store }, Budget::default()) {
				Step::Done { run: finished, status } if finished == run => {
					assert_eq!(
						status, 0,
						"zsh={zsh}, refused={refused:?}: diagnostic failure must not abandon the run"
					);
					done = true;
				},
				Step::Idle => {
					idle = true;
					break;
				},
				Step::Done { .. } | Step::Yield => {},
				step => panic!("zsh={zsh}, refused={refused:?}: unexpected execution state {step:?}"),
			}
		}
		assert!(done && idle, "the restored shell must finish and become idle");
		assert_eq!(host.stdout.bytes(), b"after_restore\n");
		let stderr = host.stderr.bytes();
		assert!(
			String::from_utf8_lossy(stderr.as_ref()).contains("restoring as owned"),
			"the queued stderr warning must still be delivered"
		);
		if let Some(expected) = &healthy_stderr {
			assert_eq!(
				&stderr, expected,
				"zsh={zsh}, refused={refused:?}: failed metadata must not lose or replace the warning"
			);
		} else {
			healthy_stderr = Some(stderr);
		}
	}
}

struct PostCommitReadFailure {
	inner:    MemStore,
	refused:  Option<&'static [u8]>,
	commits:  usize,
	failures: usize,
}

impl StateStore for PostCommitReadFailure {
	fn get(&mut self, key: Key<'_>) -> Result<Option<&Record>, StoreError> {
		if self.commits > 0
			&& self.failures == 0
			&& matches!(key, Key::Var(name) if self.refused == Some(name))
		{
			self.failures += 1;
			return Err(StoreError::Backend("post-commit diagnostic locale read refusal".into()));
		}
		self.inner.get(key)
	}

	fn scan(&mut self, table: Table, f: &mut dyn FnMut(Key<'_>, &Record)) -> Result<(), StoreError> {
		self.inner.scan(table, f)
	}

	fn apply(&mut self, change: Change<'_>) -> Result<(), StoreError> {
		self.inner.apply(change)
	}

	fn commit_restore(&mut self, writes: Vec<RestoreWrite>) -> Result<(), StoreError> {
		self.inner.commit_restore(writes)?;
		self.commits += 1;
		Ok(())
	}

	fn put_blob(&mut self, slot: BlobSlot, bytes: &[u8]) -> Result<(), StoreError> {
		self.inner.put_blob(slot, bytes)
	}

	fn get_blob(&mut self, slot: BlobSlot) -> Result<Option<Vec<u8>>, StoreError> {
		self.inner.get_blob(slot)
	}

	fn del_blob(&mut self, slot: BlobSlot) -> Result<(), StoreError> {
		self.inner.del_blob(slot)
	}

	fn epoch(&self) -> u64 {
		self.inner.epoch()
	}
}
