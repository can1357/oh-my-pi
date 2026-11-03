//! Spawn-to-exit latency of one external (`/usr/bin/true`), the cost behind
//! the `exec` benchmark (target ≤ 1.05× bash).
//!
//! - `std_command`: `std::process::Command` spawn + wait, the baseline.
//! - `posix_spawn`: `NativeSpawner`, umask equal to the process's, nothing
//!   ignored: the `posix_spawn` path.
//! - `fork_exec`: the same with a different umask: the fork + `pre_exec` path.
//! - `posix_spawn_pumped`: `posix_spawn` with stdout pumped into an engine file
//!   (pump thread + completion on drain).
//!
//! Run: `cango bench -p pi-shell --bench sys_spawn`.

#[cfg(unix)]
mod unix {
	use std::{
		hint::black_box,
		io,
		sync::Arc,
		task::{Context, Poll, Wake, Waker},
		thread,
	};

	use bstr::{BString, ByteSlice};
	use criterion::Criterion;
	use pi_shell::{
		bash::{
			CmdTag, EnvView, ExitStatus, ExtProc, File, FileKind, JobId, OsHandle, PgroupSpec, RunId,
			SigSet, SpawnSpec, StdioSpec, Vpid,
		},
		sys::NativeSpawner,
	};

	struct Unpark(thread::Thread);

	impl Wake for Unpark {
		fn wake(self: Arc<Self>) {
			self.0.unpark();
		}
	}

	fn wait(mut p: Box<dyn ExtProc>) -> ExitStatus {
		let waker = Waker::from(Arc::new(Unpark(thread::current())));
		let mut cx = Context::from_waker(&waker);
		loop {
			if let Poll::Ready(s) = p.poll_wait(&mut cx) {
				return s;
			}
			thread::park();
		}
	}

	/// Discards writes; no OS handle, so the spawner pumps.
	struct Sink;

	impl File for Sink {
		fn poll_read(&mut self, _: &mut Context<'_>, _: &mut [u8]) -> Poll<io::Result<usize>> {
			Poll::Ready(Ok(0))
		}

		fn poll_write(&mut self, _: &mut Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
			Poll::Ready(Ok(buf.len()))
		}

		fn poll_flush(&mut self, _: &mut Context<'_>) -> Poll<io::Result<()>> {
			Poll::Ready(Ok(()))
		}

		fn seek(&mut self, _: io::SeekFrom) -> io::Result<u64> {
			Err(io::ErrorKind::Unsupported.into())
		}

		fn kind(&self) -> FileKind {
			FileKind::Pipe
		}

		fn os_handle(&self) -> Option<OsHandle> {
			None
		}

		fn dup(&self) -> io::Result<Box<dyn File>> {
			Ok(Box::new(Self))
		}
	}

	fn process_umask() -> u32 {
		pi_builtins::read_process_umask().expect("read process umask")
	}

	fn spec<'a>(argv: &'a [BString], env: &'a EnvView, umask: u32, out: StdioSpec) -> SpawnSpec<'a> {
		SpawnSpec {
			path: argv[0].as_bstr(),
			argv,
			env,
			cwd: b"/".as_bstr(),
			stdio: [StdioSpec::Null, out, StdioSpec::Null],
			extra_fds: Vec::new(),
			pgroup: PgroupSpec::New(JobId(1)),
			tag: CmdTag { run: RunId(1), vpid: Vpid(Vpid::BASE), seq: 1 },
			vpid: Vpid(Vpid::BASE),
			umask,
			sigmask_ign: SigSet::EMPTY,
			rlimits: &[],
			lineage: pi_shell::bash::Lineage::default(),
			redirs: None,
		}
	}

	pub fn spawn(c: &mut Criterion) {
		let argv = vec![BString::from("/usr/bin/true")];
		let env = EnvView::default();
		let host = process_umask();
		let s = NativeSpawner::default();
		c.bench_function("std_command", |b| {
			b.iter(|| {
				black_box(
					std::process::Command::new("/usr/bin/true")
						.status()
						.unwrap(),
				)
			});
		});
		c.bench_function("posix_spawn", |b| {
			b.iter(|| black_box(wait(s.spawn(spec(&argv, &env, host, StdioSpec::Null)).unwrap())));
		});
		c.bench_function("fork_exec", |b| {
			b.iter(|| {
				black_box(wait(
					s.spawn(spec(&argv, &env, host ^ 0o002, StdioSpec::Null))
						.unwrap(),
				))
			});
		});
		c.bench_function("posix_spawn_pumped", |b| {
			b.iter(|| {
				let out = StdioSpec::File(Box::new(Sink));
				black_box(wait(s.spawn(spec(&argv, &env, host, out)).unwrap()))
			});
		});
	}
}

#[cfg(unix)]
criterion::criterion_group!(benches, unix::spawn);
#[cfg(unix)]
criterion::criterion_main!(benches);

#[cfg(not(unix))]
fn main() {}
