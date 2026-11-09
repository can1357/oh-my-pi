//! `noclobber` decides on the object, so every wrapper the engine puts
//! between the decision and the object must pass the object's own answers
//! through. The engine wraps a visible output in a trace-forwarding
//! descriptor when a run observes its output; that wrapper used to answer
//! the filesystem question for itself, and a real regular file behind
//! `/dev/stdout` was overwritten under `set -C`.

#![cfg(unix)]

use std::{
	io,
	sync::Arc,
	task::{Context, Poll},
};

use pi_shell::{
	bash::{
		EventSink, File, FileKind, OsHandle, RunStdio, Script, ShellInit, Stat, VprocSel,
		trace::RunTrace,
	},
	sys::StdFile,
	testkit::{FakeHost, Fault, Rig},
};

/// A host output sink that is also a real regular file: it forwards every
/// answer of the file behind it, and says that its output is observed.
struct ObservedFile(StdFile);

impl File for ObservedFile {
	fn poll_read(&mut self, cx: &mut Context<'_>, bytes: &mut [u8]) -> Poll<io::Result<usize>> {
		self.0.poll_read(cx, bytes)
	}

	fn poll_write(&mut self, cx: &mut Context<'_>, bytes: &[u8]) -> Poll<io::Result<usize>> {
		self.0.poll_write(cx, bytes)
	}

	fn poll_flush(&mut self, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
		self.0.poll_flush(cx)
	}

	fn seek(&mut self, pos: io::SeekFrom) -> io::Result<u64> {
		self.0.seek(pos)
	}

	fn kind(&self) -> FileKind {
		self.0.kind()
	}

	fn os_handle(&self) -> Option<OsHandle> {
		self.0.os_handle()
	}

	fn stat(&self) -> io::Result<Stat> {
		self.0.stat()
	}

	fn on_filesystem(&self) -> bool {
		self.0.on_filesystem()
	}

	fn observes_output(&self) -> bool {
		true
	}

	fn dup(&self) -> io::Result<Box<dyn File>> {
		self.0.dup()
	}
}

/// Observing a run's output must not turn off `noclobber`: the regular
/// file behind `/dev/stdout` is refused whether or not the run carries an
/// event sink.
#[test]
fn an_observed_output_keeps_the_identity_of_the_file_behind_it() {
	let mut written = Vec::new();
	for tracing in [false, true] {
		let directory = tempfile::tempdir().expect("temp dir");
		let path = directory.path().join("victim");
		std::fs::write(&path, b"ORIGINAL").expect("victim");
		let file = std::fs::OpenOptions::new()
			.read(true)
			.write(true)
			.open(&path)
			.expect("open the victim");
		let adapter = ObservedFile(StdFile::new(file));
		let text = "set -C; printf BAD &>/dev/stdout";
		let trace = Arc::new(RunTrace::new(text));
		let host = if tracing {
			let sink: Arc<dyn EventSink> = trace.clone();
			FakeHost::new().with_event_sink(sink)
		} else {
			FakeHost::new()
		};
		let mut rig = Rig::new(host, ShellInit::default());
		if tracing {
			rig.shell().set_event_mask(trace.mask());
		}
		let mut script = Script::command(Arc::<[u8]>::from(text.as_bytes()));
		script.vproc = VprocSel::NewSubshellWithStdio([
			RunStdio::Inherit,
			RunStdio::File(Box::new(adapter)),
			RunStdio::Inherit,
		]);
		let status = rig.run(script, Fault::None);
		let kept = std::fs::read_to_string(&path).expect("read the victim");
		let stderr = String::from_utf8(rig.host.stderr.bytes()).expect("utf-8");
		if status != 1 || kept != "ORIGINAL" || !stderr.contains("cannot overwrite existing file") {
			written.push(format!("tracing={tracing} status={status} contents={kept:?} {stderr:?}"));
		}
	}
	assert!(written.is_empty(), "observing output disabled noclobber:\n{}", written.join("\n"));
}
