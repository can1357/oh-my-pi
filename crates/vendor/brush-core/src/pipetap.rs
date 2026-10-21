//! Mirrored pipeline pipes: a copy of every byte one stage writes to the next,
//! for embedders that show a running pipeline's intermediate output — the
//! input a later `tail` or `grep` stage is still holding back.
//!
//! A tapped `|` is two pipes joined by a relay thread. The relay forwards each
//! chunk unchanged and hands the [`PipeMirror`] a copy, so both stages still
//! see an ordinary pipe: a slow consumer blocks the producer, the producer's
//! EOF reaches the consumer, and a consumer that exits early (`| head`)
//! widows the producer's pipe at once, because the relay watches for it and
//! lets go of the producer's end (`tail -f log | head -n1` ends with `head`).

use std::{
	io::{self, PipeReader, PipeWriter, Read, Write},
	sync::Arc,
};

use brush_parser::ast;

use crate::{error, openfiles::OpenFile};

/// Optional hook mirroring the bytes that cross a pipeline's pipes.
pub trait PipeTap: Send + Sync {
	/// Opens a mirror for the pipe from `producer` into `consumer` (each
	/// stage's source text), or `None` to leave that pipe untapped.
	fn open(&self, producer: &str, consumer: &str) -> Option<Arc<dyn PipeMirror>>;
}

/// Receives a copy of a tapped pipe's bytes from its relay thread.
pub trait PipeMirror: Send + Sync {
	/// Records one chunk, called on the relay thread before the chunk is
	/// forwarded; it must not block.
	fn write(&self, bytes: &[u8]);
	/// Marks the pipe finished — the producer closed it, the consumer went
	/// away, or forwarding failed. Called exactly once per opened mirror,
	/// also when the relay could not start.
	fn close(&self);
}

/// Bytes the relay moves per read: a full pipe buffer on Linux.
const RELAY_CHUNK: usize = 64 * 1024;

/// Creates the pipe carrying `producer`'s output into `consumer` as
/// `(reader, writer)`: a plain pipe, or a relayed one when `tap` opens a
/// mirror for it.
pub(crate) fn pipe(
	tap: Option<&Arc<dyn PipeTap>>,
	producer: &ast::Command,
	consumer: &ast::Command,
) -> Result<(OpenFile, OpenFile), error::Error> {
	let (reader, writer) = io::pipe()?;
	let Some(mirror) =
		tap.and_then(|tap| tap.open(&producer.to_string(), &consumer.to_string()))
	else {
		return Ok((reader.into(), writer.into()));
	};
	let guard = MirrorGuard(mirror);
	let (relayed_reader, relayed_writer) = io::pipe()?;
	std::thread::Builder::new()
		.name("brush-pipe-tap".into())
		.spawn(move || relay(reader, relayed_writer, &guard))?;
	Ok((relayed_reader.into(), writer.into()))
}

/// Closes its mirror when dropped, so every way a relay ends — or fails to
/// start — reports the pipe finished exactly once.
struct MirrorGuard(Arc<dyn PipeMirror>);

impl Drop for MirrorGuard {
	fn drop(&mut self) {
		self.0.close();
	}
}

/// Forwards `from` into `to`, copying each chunk to the mirror, until the
/// producer closes `from` or the consumer stops reading `to`. Dropping both
/// ends on return passes EOF on to the consumer and widows the producer.
fn relay(mut from: PipeReader, mut to: PipeWriter, guard: &MirrorGuard) {
	let mut buf = vec![0; RELAY_CHUNK];
	loop {
		#[cfg(unix)]
		if !wait_for_input(&from, &to) {
			return;
		}
		let read = match from.read(&mut buf) {
			Ok(0) => return,
			Ok(read) => read,
			Err(err) if err.kind() == io::ErrorKind::Interrupted => continue,
			Err(_) => return,
		};
		guard.0.write(&buf[..read]);
		if to.write_all(&buf[..read]).is_err() {
			return;
		}
	}
}

/// Blocks until `from` has bytes or EOF to read, or `to` lost its reader.
/// Returns `false` for the latter, so the relay stops without waiting for the
/// producer's next write and releases `from` at once, as the consumer's exit
/// would have done to an untapped pipe.
#[cfg(unix)]
fn wait_for_input(from: &PipeReader, to: &PipeWriter) -> bool {
	use std::os::fd::AsFd;

	use nix::{
		errno::Errno,
		poll::{PollFd, PollFlags, PollTimeout, poll},
	};

	loop {
		// POLLRDBAND like GNU tee: never ready on a pipe's write end, so only a
		// missing reader wakes that entry.
		let mut fds = [
			PollFd::new(from.as_fd(), PollFlags::POLLIN),
			PollFd::new(to.as_fd(), PollFlags::POLLRDBAND),
		];
		match poll(&mut fds, PollTimeout::NONE) {
			Ok(_) => {
				// Linux reports a widowed write end as POLLERR, Darwin as POLLHUP.
				let widowed = fds[1].revents().is_none_or(|revents| {
					revents.intersects(PollFlags::POLLERR | PollFlags::POLLHUP | PollFlags::POLLNVAL)
				});
				if widowed {
					return false;
				}
				if fds[0].revents().is_none_or(|revents| !revents.is_empty()) {
					return true;
				}
			},
			Err(Errno::EINTR) => {},
			// Let the read surface whatever went wrong.
			Err(_) => return true,
		}
	}
}
