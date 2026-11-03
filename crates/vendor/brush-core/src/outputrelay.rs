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
//! reaches the sink ahead of whatever the next command writes there. The relay
//! reads only bytes it knows are waiting, and only under its state lock, so a
//! drain holding that lock sees the pipe and what the relay read at one moment:
//! everything the exited command wrote is what the relay had read plus what
//! the pipe held then. The drain waits until the relay has forwarded that much.

use std::{
	io::{self, PipeReader, Read, Write},
	sync::{Arc, Mutex, MutexGuard, PoisonError, Weak},
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

/// What a relay has read and forwarded.
#[derive(Default)]
struct RelayState {
	/// Bytes read from the command so far.
	consumed:  u64,
	/// Whether bytes it read are still being decoded or written.
	in_flight: bool,
	/// Whether its decoder holds read bytes back, which only more bytes or
	/// the end of the stream releases.
	holding:   bool,
	/// Whether the relay ended.
	finished:  bool,
}

type SharedState = Arc<Mutex<RelayState>>;

fn lock(state: &SharedState) -> MutexGuard<'_, RelayState> {
	state.lock().unwrap_or_else(PoisonError::into_inner)
}

/// The relay thread's side of its state: updates it and tells the drain.
/// Dropping it, however the relay ends, reports the relay finished.
struct RelayFeed {
	state:   SharedState,
	changed: watch::Sender<()>,
}

impl RelayFeed {
	fn update(&self, change: impl FnOnce(&mut RelayState)) {
		change(&mut lock(&self.state));
		self.changed.send_replace(());
	}
}

impl Drop for RelayFeed {
	fn drop(&mut self) {
		self.update(|state| state.finished = true);
	}
}

/// One relay as its command's drain sees it.
pub(crate) struct RelayHandle {
	state:   SharedState,
	/// Signalled on every change of `state`.
	changed: watch::Receiver<()>,
	/// The relay's read end, to size what the command left in it; the relay
	/// thread owns it, so it closes when the relay ends.
	pipe:    Weak<PipeReader>,
	/// Bytes the relay has to read to have everything the exited command
	/// wrote, once sized.
	target:  Option<u64>,
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
		let (feed, handle) = RelayHandle::pair(Arc::downgrade(&from), RelayState::default());
		let decoder = decoding.decoder();
		let to = target.clone();
		std::thread::Builder::new()
			.name("brush-output-relay".into())
			.spawn(move || relay(&from, decoder, to, &feed))?;
		let writer = OpenFile::from(writer);
		self.relays.push(Relay { sink: target.clone(), writer: writer.clone(), handle });
		Ok(Some(writer))
	}

	/// Releases this side's write ends and returns what a drain waits on.
	pub(crate) fn into_handles(self) -> Vec<RelayHandle> {
		self.relays.into_iter().map(|relay| relay.handle).collect()
	}
}

/// Decodes `from` into `to` until every writer of `from` is closed or `to`
/// stops accepting text, reporting each read and forward on `feed`.
fn relay(mut from: &PipeReader, mut decoder: Box<dyn ByteDecoder>, mut to: OpenFile, feed: &RelayFeed) {
	let mut buf = vec![0; RELAY_CHUNK];
	loop {
		let Some(waiting) = wait_for_input(from) else {
			break;
		};
		let read = {
			let mut state = lock(&feed.state);
			// Only bytes already waiting are read, so this does not block
			// with the lock held.
			match from.read(&mut buf[..waiting.min(RELAY_CHUNK)]) {
				Ok(0) => break,
				Ok(read) => {
					state.consumed += read as u64;
					state.in_flight = true;
					read
				},
				Err(err) if err.kind() == io::ErrorKind::Interrupted => continue,
				Err(_) => break,
			}
		};
		let text = decoder.push(&buf[..read]);
		if !text.is_empty() && to.write_all(text.as_bytes()).is_err() {
			return;
		}
		feed.update(|state| {
			state.in_flight = false;
			state.holding = decoder.holds_bytes();
		});
	}
	feed.update(|state| state.in_flight = true);
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
			if relay.changed.changed().await.is_err() {
				break;
			}
		}
	}
}

/// Drops the relays that have forwarded what their exited command wrote;
/// true once none is left.
pub(crate) fn drained_now(relays: &mut Vec<RelayHandle>) -> bool {
	relays.retain_mut(|relay| !relay.drained_now());
	relays.is_empty()
}

impl RelayHandle {
	fn pair(pipe: Weak<PipeReader>, state: RelayState) -> (RelayFeed, Self) {
		let state = Arc::new(Mutex::new(state));
		let (changed_tx, changed) = watch::channel(());
		let feed = RelayFeed { state: Arc::clone(&state), changed: changed_tx };
		(feed, Self { state, changed, pipe, target: None })
	}

	/// Whether the relay has forwarded what its exited command wrote: it
	/// finished, or it read and forwarded all of it and its decoder holds
	/// none of it back. Bytes held while a process the command left running
	/// keeps the pipe open belong to a character the command ended inside;
	/// they follow that process's output and do not hold the drain.
	fn drained_now(&mut self) -> bool {
		// Changes from here on wake the drain's next wait.
		self.changed.borrow_and_update();
		let Some(pipe) = self.pipe.upgrade() else {
			return true;
		};
		let state = lock(&self.state);
		if state.finished {
			return true;
		}
		let target = *self.target.get_or_insert_with(|| {
			let waiting = pipe_bytes_waiting(&pipe).unwrap_or(0);
			state.consumed.saturating_add(u64::try_from(waiting).unwrap_or(u64::MAX))
		});
		if state.in_flight || state.consumed < target {
			return false;
		}
		!state.holding || pipe_has_writers(&pipe)
	}
}

/// Blocks until `pipe` holds bytes, returning how many, or `None` once it is
/// empty with no writer left.
fn wait_for_input(pipe: &PipeReader) -> Option<usize> {
	#[cfg(windows)]
	{
		// An anonymous pipe cannot be waited on without reading it.
		let mut delay = std::time::Duration::from_millis(1);
		loop {
			match pipe_bytes_waiting(pipe)? {
				0 => {
					std::thread::sleep(delay);
					delay = (delay * 2).min(std::time::Duration::from_millis(10));
				},
				waiting => return Some(waiting),
			}
		}
	}
	#[cfg(unix)]
	{
		use std::os::fd::AsFd;

		use nix::{
			errno::Errno,
			poll::{PollFd, PollFlags, PollTimeout, poll},
		};

		loop {
			let mut fds = [PollFd::new(pipe.as_fd(), PollFlags::POLLIN)];
			match poll(&mut fds, PollTimeout::NONE) {
				Ok(_) | Err(Errno::EINTR) => {},
				Err(_) => return None,
			}
			match pipe_bytes_waiting(pipe)? {
				// Readable with nothing to read: every writer closed.
				0 if fds[0]
					.revents()
					.is_some_and(|revents| revents.intersects(PollFlags::POLLHUP)) =>
				{
					return None;
				},
				0 => {},
				waiting => return Some(waiting),
			}
		}
	}
	#[cfg(not(any(windows, unix)))]
	{
		let _ = pipe;
		None
	}
}

/// Bytes waiting in `pipe`, or `None` where that cannot be read — on Windows
/// also once the pipe is empty with no writer left.
fn pipe_bytes_waiting(pipe: &PipeReader) -> Option<usize> {
	#[cfg(windows)]
	{
		use std::os::windows::io::AsRawHandle;
		let mut waiting = 0u32;
		// SAFETY: `pipe` owns a valid pipe handle for the call; the null
		// buffer with size 0 only queries the byte count.
		let ok = unsafe {
			windows_sys::Win32::System::Pipes::PeekNamedPipe(
				pipe.as_raw_handle(),
				std::ptr::null_mut(),
				0,
				std::ptr::null_mut(),
				&raw mut waiting,
				std::ptr::null_mut(),
			)
		};
		(ok != 0).then(|| usize::try_from(waiting).unwrap_or(usize::MAX))
	}
	#[cfg(unix)]
	{
		use std::os::fd::AsRawFd;
		let mut waiting: libc::c_int = 0;
		// SAFETY: `pipe` owns a valid descriptor for the call and FIONREAD
		// writes one `c_int`.
		let ok = unsafe { libc::ioctl(pipe.as_raw_fd(), libc::FIONREAD, &raw mut waiting) };
		(ok == 0).then(|| usize::try_from(waiting).unwrap_or(0))
	}
	#[cfg(not(any(windows, unix)))]
	{
		let _ = pipe;
		None
	}
}

/// Whether a process still holds `pipe`'s write end open.
fn pipe_has_writers(pipe: &PipeReader) -> bool {
	#[cfg(windows)]
	{
		// Peeking an empty pipe fails once no writer is left.
		pipe_bytes_waiting(pipe).is_some()
	}
	#[cfg(unix)]
	{
		use std::os::fd::AsFd;

		use nix::poll::{PollFd, PollFlags, PollTimeout, poll};

		let mut fds = [PollFd::new(pipe.as_fd(), PollFlags::POLLIN)];
		match poll(&mut fds, PollTimeout::ZERO) {
			Ok(_) => !fds[0]
				.revents()
				.is_some_and(|revents| revents.intersects(PollFlags::POLLHUP)),
			Err(_) => true,
		}
	}
	#[cfg(not(any(windows, unix)))]
	{
		let _ = pipe;
		true
	}
}

/// A relay without a thread, for tests, on an empty pipe with no writer: it
/// stays as created until it finishes.
#[cfg(test)]
pub(crate) struct TestRelay {
	feed:  RelayFeed,
	_pipe: Arc<PipeReader>,
}

#[cfg(test)]
impl TestRelay {
	/// A relay still `forwarding` bytes it read, or idle with all forwarded.
	pub(crate) fn new(forwarding: bool) -> (Self, RelayHandle) {
		Self::with_state(RelayState { in_flight: forwarding, ..RelayState::default() })
	}

	/// A relay that read and forwarded everything but whose decoder still
	/// holds bytes back for the end of the stream.
	fn holding() -> (Self, RelayHandle) {
		Self::with_state(RelayState { holding: true, ..RelayState::default() })
	}

	fn with_state(state: RelayState) -> (Self, RelayHandle) {
		let (reader, _writer) = std::io::pipe().expect("pipe");
		let pipe = Arc::new(reader);
		let (feed, handle) = RelayHandle::pair(Arc::downgrade(&pipe), state);
		(Self { feed, _pipe: pipe }, handle)
	}

	/// Reports the relay finished.
	pub(crate) fn finish(self) {
		drop(self.feed);
	}
}

#[cfg(test)]
mod tests {
	use std::time::Duration;

	use super::*;

	/// An idle relay neither ends the drain of the others nor lets it give up
	/// on one still forwarding, for longer than any deadline.
	#[tokio::test]
	async fn drain_waits_for_every_relay_that_still_forwards() {
		const FORWARDING: Duration = Duration::from_millis(2_200);
		let (_idle_feed, idle) = TestRelay::new(false);
		let (busy_feed, busy) = TestRelay::new(true);
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

	/// The drain sizes the command's output from the pipe and the relay's
	/// count at one moment: bytes still waiting are waited for even when the
	/// relay reports nothing in flight.
	#[tokio::test]
	async fn drain_waits_for_bytes_still_in_the_pipe() {
		let (reader, mut writer) = std::io::pipe().expect("pipe");
		writer.write_all(b"left behind").expect("write");
		drop(writer);
		let pipe = Arc::new(reader);
		let (feed, mut relay) = RelayHandle::pair(Arc::downgrade(&pipe), RelayState::default());
		assert!(!relay.drained_now(), "drained with bytes still in the pipe");
		let mut left = Vec::new();
		(&*pipe).read_to_end(&mut left).expect("read");
		feed.update(|state| state.consumed += left.len() as u64);
		assert!(relay.drained_now());
	}
}
