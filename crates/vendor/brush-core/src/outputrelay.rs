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
//! reaches the sink ahead of whatever the next command writes there.

use std::{
	io::{self, PipeReader, Read, Write},
	sync::Arc,
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
	/// Flushes held bytes at end of stream.
	fn finish(&mut self) -> String;
}

/// Bytes the relay moves per read.
const RELAY_CHUNK: usize = 64 * 1024;
/// How long a drain waits for a relay sitting in a read. The command has
/// exited, so its output is already in the pipe; a relay that still finds
/// nothing to read is held open by a process the command left running.
const DRAIN_IDLE: Duration = Duration::from_millis(100);
/// Upper bound on a drain, for a left-running process that keeps writing or
/// a sink that stopped taking text.
const DRAIN_MAX: Duration = Duration::from_secs(2);

/// What a relay thread is doing, as a drain sees it.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum RelayState {
	/// Waiting for the command's next bytes.
	Reading,
	/// Decoding or writing bytes it read.
	Forwarding,
}

/// Observes one relay; closed once the relay finished.
pub(crate) type RelayWatch = watch::Receiver<RelayState>;

struct Relay {
	sink:   OpenFile,
	writer: OpenFile,
	state:  RelayWatch,
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
		let (state_tx, state) = watch::channel(RelayState::Forwarding);
		let decoder = decoding.decoder();
		let to = target.clone();
		std::thread::Builder::new()
			.name("brush-output-relay".into())
			.spawn(move || relay(reader, decoder, to, &state_tx))?;
		let writer = OpenFile::from(writer);
		self.relays.push(Relay { sink: target.clone(), writer: writer.clone(), state });
		Ok(Some(writer))
	}

	/// Releases this side's handles to the relays and returns what a drain
	/// waits on, or `None` when nothing was relayed.
	pub(crate) fn into_drain(self) -> Option<Vec<RelayWatch>> {
		if self.relays.is_empty() {
			return None;
		}
		Some(self.relays.into_iter().map(|relay| relay.state).collect())
	}
}

/// Decodes `from` into `to` until every writer of `from` is closed or `to`
/// stops accepting text, reporting each read and forward on `state`.
/// Dropping `state` on return reports the relay finished.
fn relay(
	mut from: PipeReader,
	mut decoder: Box<dyn ByteDecoder>,
	mut to: OpenFile,
	state: &watch::Sender<RelayState>,
) {
	let mut buf = vec![0; RELAY_CHUNK];
	loop {
		state.send_replace(RelayState::Reading);
		let read = match from.read(&mut buf) {
			Ok(0) => break,
			Ok(read) => read,
			Err(err) if err.kind() == io::ErrorKind::Interrupted => continue,
			Err(_) => break,
		};
		state.send_replace(RelayState::Forwarding);
		let text = decoder.push(&buf[..read]);
		if !text.is_empty() && to.write_all(text.as_bytes()).is_err() {
			return;
		}
	}
	let rest = decoder.finish();
	if !rest.is_empty() {
		let _ = to.write_all(rest.as_bytes());
	}
}

/// Waits until every relay has forwarded its command's output: each one
/// finished, or sat in a read for [`DRAIN_IDLE`], or [`DRAIN_MAX`] passed. A
/// relay still running afterwards forwards later output as it comes, as a
/// process writing straight into the sink would.
pub(crate) async fn drain(mut relays: Vec<RelayWatch>) {
	let deadline = tokio::time::Instant::now() + DRAIN_MAX;
	for state in &mut relays {
		loop {
			let wake = deadline.min(tokio::time::Instant::now() + DRAIN_IDLE);
			match tokio::time::timeout_at(wake, state.changed()).await {
				Ok(Ok(())) => {},
				Ok(Err(_)) => break,
				Err(_) => {
					if *state.borrow() == RelayState::Reading
						|| tokio::time::Instant::now() >= deadline
					{
						return;
					}
				},
			}
		}
	}
}
