//! Decoding relays for external commands' output on its way into shell text.
//!
//! Builtins write the shell's own text. An external program may write another
//! encoding: a native Windows program writes the ANSI code page to a pipe. One
//! program's output is one encoding, but a stream that several commands write
//! into is not, so the encoding is decided per program, here, rather than by
//! whoever reads the mixed stream.
//!
//! An embedder that can decode such output installs an [`OutputDecoding`]
//! hook. Every external command whose stdout or stderr is a *text sink* — a
//! pipe whose reader takes its bytes as shell text — then writes into a pipe of
//! its own, and a relay thread decodes it with a fresh [`ByteDecoder`] and
//! forwards the text into the sink. Text sinks are the pipes the embedder
//! registers (its capture) and command substitutions. Pipeline pipes and
//! files are not: they carry the program's bytes unchanged, so binary data
//! stays intact.
//!
//! A command's relays are drained before its exit is reported, so its output
//! reaches the sink ahead of whatever the next command writes there. The
//! drain waits until each relay has forwarded every byte the command left in
//! its pipe, however long that takes; it stops early only for a relay that
//! sits idle in a read, which a process the command left running holds open.

use std::{
	io::{self, PipeReader, Read, Write},
	sync::{Arc, Weak},
	time::Duration,
};

use tokio::sync::watch;

use crate::{error, ioutils, openfiles::OpenFile};

/// Hook decoding external commands' output into shell text.
pub trait OutputDecoding: Send + Sync {
	/// Returns a decoder for one external command's output stream.
	fn decoder(&self) -> Box<dyn ByteDecoder>;
}

/// Incremental decoder for one external command's output stream.
pub trait ByteDecoder: Send {
	/// Decodes the next chunk; bytes of an incomplete character stay held.
	fn push(&mut self, bytes: &[u8]) -> String;
	/// Whether bytes are held for more input or for [`Self::finish`].
	fn holds_bytes(&self) -> bool;
	/// Flushes held bytes at end of stream.
	fn finish(&mut self) -> String;
}

/// Bytes the relay moves per read.
const RELAY_CHUNK: usize = 64 * 1024;
/// How long a drain waits for a relay sitting in a read before taking its
/// pipe as empty: when the pipe size cannot be read, or while a process the
/// command left running holds the pipe open without writing.
const DRAIN_IDLE: Duration = Duration::from_millis(100);

/// What a relay thread has done, as a drain sees it.
#[derive(Clone, Copy)]
struct RelayProgress {
	/// Whether it waits for the command's next bytes, rather than decoding
	/// or writing bytes it read.
	reading:  bool,
	/// Bytes read from the command so far.
	consumed: u64,
	/// Whether its decoder holds read bytes back, which only more bytes or
	/// the end of the stream releases.
	holding:  bool,
}

/// One relay as its command's drain sees it.
pub(crate) struct RelayHandle {
	/// Closed once the relay finished.
	progress:   watch::Receiver<RelayProgress>,
	/// The relay's read end, to size what the command left in it; the relay
	/// thread owns it, so it closes when the relay ends.
	pipe:       Weak<PipeReader>,
	/// Bytes the relay has to read to have everything the exited command
	/// wrote, once sized.
	target:     Option<u64>,
	/// Since when the relay has sat in a read without progress.
	idle_since: Option<tokio::time::Instant>,
}

struct Relay {
	sink:   OpenFile,
	writer: OpenFile,
	handle: RelayHandle,
}

/// The relays started for one external command.
#[derive(Default)]
pub(crate) struct OutputRelays {
	relays: Vec<Relay>,
}

impl OutputRelays {
	/// Returns the file to hand the command in place of `target` when
	/// `target` is one of `sinks`: the write end of a relay into it. A target
	/// already relayed for this command (stdout and stderr into one capture)
	/// shares that relay, so the two streams stay in the order written.
	pub(crate) fn route(
		&mut self,
		decoding: &Arc<dyn OutputDecoding>,
		sinks: &[OpenFile],
		target: &OpenFile,
	) -> Result<Option<OpenFile>, error::Error> {
		if !sinks.iter().any(|sink| sink.is_same_file(target)) {
			return Ok(None);
		}
		if let Some(relay) = self.relays.iter().find(|relay| relay.sink.is_same_file(target)) {
			return Ok(Some(relay.writer.clone()));
		}
		let (reader, writer) = ioutils::pipe("output relay")?;
		let from = Arc::new(reader);
		let pipe = Arc::downgrade(&from);
		let (progress_tx, progress) =
			watch::channel(RelayProgress { reading: false, consumed: 0, holding: false });
		let decoder = decoding.decoder();
		let to = target.clone();
		std::thread::Builder::new()
			.name("brush-output-relay".into())
			.spawn(move || relay(&from, decoder, to, &progress_tx))?;
		let writer = OpenFile::from(writer);
		self.relays.push(Relay {
			sink: target.clone(),
			writer: writer.clone(),
			handle: RelayHandle::new(progress, pipe),
		});
		Ok(Some(writer))
	}

	/// Releases this side's write ends and returns what a drain waits on.
	pub(crate) fn into_handles(self) -> Vec<RelayHandle> {
		self.relays.into_iter().map(|relay| relay.handle).collect()
	}
}

/// Decodes `from` into `to` until every writer of `from` is closed or `to`
/// stops accepting text, reporting each read and forward on `progress`.
/// Dropping `progress` on return reports the relay finished.
fn relay(
	mut from: &PipeReader,
	mut decoder: Box<dyn ByteDecoder>,
	mut to: OpenFile,
	progress: &watch::Sender<RelayProgress>,
) {
	let mut buf = vec![0; RELAY_CHUNK];
	let mut consumed = 0u64;
	loop {
		progress.send_replace(RelayProgress { reading: true, consumed, holding: decoder.holds_bytes() });
		let read = match from.read(&mut buf) {
			Ok(0) => break,
			Ok(read) => read,
			Err(err) if err.kind() == io::ErrorKind::Interrupted => continue,
			Err(_) => break,
		};
		consumed += read as u64;
		progress.send_replace(RelayProgress { reading: false, consumed, holding: decoder.holds_bytes() });
		let text = decoder.push(&buf[..read]);
		if !text.is_empty() && to.write_all(text.as_bytes()).is_err() {
			return;
		}
	}
	// Flushing what the decoder held is forwarding too, not an idle read.
	progress.send_modify(|progress| progress.reading = false);
	let rest = decoder.finish();
	if !rest.is_empty() {
		let _ = to.write_all(rest.as_bytes());
	}
}

/// Waits until every relay has forwarded what its exited command wrote. A
/// relay still running afterwards forwards later output, from processes the
/// command left running, as it comes, as they would writing straight into the
/// sink.
pub(crate) async fn drain(relays: Vec<RelayHandle>) {
	for mut relay in relays {
		while !relay.drained_now() {
			match tokio::time::timeout(DRAIN_IDLE, relay.progress.changed()).await {
				Ok(Ok(())) | Err(_) => {},
				// The relay finished: every writer is gone and all is forwarded.
				Ok(Err(_)) => break,
			}
		}
	}
}

/// Drops the relays that have forwarded what their exited command wrote, as
/// far as can be told without waiting; true once none is left.
pub(crate) fn drained_now(relays: &mut Vec<RelayHandle>) -> bool {
	relays.retain_mut(|relay| !relay.drained_now());
	relays.is_empty()
}

impl RelayHandle {
	const fn new(progress: watch::Receiver<RelayProgress>, pipe: Weak<PipeReader>) -> Self {
		Self { progress, pipe, target: None, idle_since: None }
	}

	/// Whether the relay has forwarded what its exited command wrote: it
	/// finished, or it read all of it and its decoder holds none of it back,
	/// or it has sat in a read for [`DRAIN_IDLE`] (a process the command left
	/// running holds the pipe open). A relay still forwarding, however slowly,
	/// has not.
	fn drained_now(&mut self) -> bool {
		let changed = match self.progress.has_changed() {
			Ok(changed) => changed,
			Err(_) => return true,
		};
		// The command has exited: what it wrote is what the relay consumed
		// plus what is still in the pipe. Sizing the pipe first can only
		// overcount (by bytes the relay reads in between), which the idle
		// check settles.
		let target = *self.target.get_or_insert_with(|| {
			let pending = self.pipe.upgrade().and_then(|pipe| pipe_bytes_available(&pipe));
			pending.map_or(u64::MAX, |pending| self.progress.borrow().consumed.saturating_add(pending))
		});
		let progress = *self.progress.borrow_and_update();
		if changed || !progress.reading {
			self.idle_since = None;
		}
		if !progress.reading {
			return false;
		}
		if !progress.holding && progress.consumed >= target {
			return true;
		}
		let now = tokio::time::Instant::now();
		now.duration_since(*self.idle_since.get_or_insert(now)) >= DRAIN_IDLE
	}
}

/// A relay without a thread, for tests: it stays as created until it
/// finishes.
#[cfg(test)]
pub(crate) struct TestRelay {
	progress: watch::Sender<RelayProgress>,
	/// An empty pipe the drain sizes, kept open with both ends.
	_pipe:    Option<(Arc<PipeReader>, std::io::PipeWriter)>,
}

#[cfg(test)]
impl TestRelay {
	/// A relay idle in a read (`reading`) or forwarding bytes it read, on a
	/// pipe the drain cannot size.
	pub(crate) fn new(reading: bool) -> (Self, RelayHandle) {
		let (progress, handle) = watch::channel(RelayProgress { reading, consumed: 0, holding: false });
		(Self { progress, _pipe: None }, RelayHandle::new(handle, Weak::new()))
	}

	/// A relay that has read everything in its (empty) pipe and waits in a
	/// read while its decoder still holds bytes back for the end of the
	/// stream.
	fn holding() -> (Self, RelayHandle) {
		let (reader, writer) = std::io::pipe().expect("pipe");
		let reader = Arc::new(reader);
		let pipe = Arc::downgrade(&reader);
		let (progress, handle) =
			watch::channel(RelayProgress { reading: true, consumed: 0, holding: true });
		(Self { progress, _pipe: Some((reader, writer)) }, RelayHandle::new(handle, pipe))
	}

	/// Reports the relay finished.
	pub(crate) fn finish(self) {
		drop(self.progress);
	}
}

/// Bytes waiting in `pipe`, where the platform reports it.
fn pipe_bytes_available(pipe: &PipeReader) -> Option<u64> {
	#[cfg(windows)]
	{
		use std::os::windows::io::AsRawHandle;
		let mut available = 0u32;
		// SAFETY: `pipe` owns a valid pipe handle for the call; the null
		// buffer with size 0 only queries the byte count.
		let ok = unsafe {
			windows_sys::Win32::System::Pipes::PeekNamedPipe(
				pipe.as_raw_handle(),
				std::ptr::null_mut(),
				0,
				std::ptr::null_mut(),
				&raw mut available,
				std::ptr::null_mut(),
			)
		};
		(ok != 0).then_some(u64::from(available))
	}
	#[cfg(unix)]
	{
		use std::os::fd::AsRawFd;
		let mut available: libc::c_int = 0;
		// SAFETY: `pipe` owns a valid descriptor for the call and FIONREAD
		// writes one `c_int`.
		let ok = unsafe { libc::ioctl(pipe.as_raw_fd(), libc::FIONREAD, &raw mut available) };
		(ok == 0).then(|| u64::try_from(available).unwrap_or(0))
	}
	#[cfg(not(any(windows, unix)))]
	{
		let _ = pipe;
		None
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	/// An idle relay (held open by a process left running) neither ends the
	/// drain of the others nor lets it give up on one still forwarding, for
	/// longer than any deadline.
	#[tokio::test]
	async fn drain_waits_for_every_relay_that_still_forwards() {
		const FORWARDING: Duration = Duration::from_millis(2_200);
		let (_idle_feed, idle) = TestRelay::new(true);
		let (busy_feed, busy) = TestRelay::new(false);
		let finish = tokio::spawn(async move {
			tokio::time::sleep(FORWARDING).await;
			busy_feed.finish();
		});
		let started = tokio::time::Instant::now();
		drain(vec![idle, busy]).await;
		assert!(started.elapsed() >= FORWARDING, "drained after {:?}", started.elapsed());
		finish.await.expect("finish relay");
	}

	/// Bytes the decoder holds for the end of the stream are not forwarded
	/// yet, though the relay has read all there was.
	#[tokio::test]
	async fn drain_waits_for_bytes_the_decoder_holds() {
		const FLUSHING: Duration = Duration::from_millis(50);
		let (feed, relay) = TestRelay::holding();
		let finish = tokio::spawn(async move {
			tokio::time::sleep(FLUSHING).await;
			feed.finish();
		});
		let started = tokio::time::Instant::now();
		drain(vec![relay]).await;
		assert!(started.elapsed() >= FLUSHING, "drained after {:?}", started.elapsed());
		finish.await.expect("finish relay");
	}
}
