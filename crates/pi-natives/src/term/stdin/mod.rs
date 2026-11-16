//! Process stdin for an owned terminal.
//!
//! [`Stdin::attach`] puts a terminal stdin in raw mode — saving the exact mode
//! it found — and starts a reader thread. The thread queues every read whole
//! (the input parser treats one read as one burst: the cooked-typeahead
//! Enter, a paste and the Enter that shared its read, stall-batched lines) and
//! wakes the owner once per batch, which then [`take`](Stdin::take)s what
//! queued. Stdin ending or failing is queued too, behind the reads before it.
//!
//! [`Stdin::stop_reading`] cancels and joins the reader: nothing is consumed
//! from the terminal after it returns, so a handed-back terminal (external
//! editor, suspend, exit) keeps every later byte for its next reader.
//! [`Stdin::detach`] then puts the saved mode back.
//!
//! - unix: termios raw mode exactly as libuv's (and Bun's) `setRawMode`; the
//!   reader polls stdin and a cancellation socket, like the output pump.
//! - Windows: console raw mode plus `ENABLE_VIRTUAL_TERMINAL_INPUT`; the reader
//!   waits on the console and a cancellation event, and translates key records
//!   to UTF-8 as libuv's raw console reader did.

#[cfg(all(test, unix))]
mod tests;
#[cfg(unix)]
mod unix;
#[cfg(windows)]
mod win;

use std::{
	io, mem,
	sync::{
		Arc,
		atomic::{AtomicBool, Ordering},
	},
};

use parking_lot::Mutex;

#[cfg(unix)]
use self::unix as sys;
#[cfg(windows)]
use self::win as sys;

/// Wake-up for the owner: runs on the reader thread once reads (or the end)
/// are queued and the owner has not taken the previous batch yet.
pub(crate) type WakeFn = Box<dyn Fn() + Send + Sync>;

/// Largest single read; what one stdin read of the JS runtime took.
const READ_BYTES: usize = 64 * 1024;

/// A queue larger than this is not kept for reuse once taken.
const MAX_RETAINED_BYTES: usize = 256 * 1024;

/// Why stdin stopped delivering bytes.
#[derive(Debug)]
pub(crate) enum End {
	/// End of input: the terminal hung up, or the pipe or file ended.
	Eof,
	/// A read failed (a revoked pty answers EIO).
	Failed(io::Error),
}

/// Reads in arrival order, each kept whole.
#[derive(Default)]
pub(crate) struct Reads {
	bytes: Vec<u8>,
	/// End offset in `bytes` of every read.
	ends:  Vec<usize>,
}

impl Reads {
	/// Every read, in order.
	pub(crate) fn iter(&self) -> impl Iterator<Item = &[u8]> {
		let mut start = 0;
		self.ends.iter().map(move |&end| {
			let read = &self.bytes[start..end];
			start = end;
			read
		})
	}

	/// Forget every read, keeping a normal-sized allocation for reuse.
	pub(crate) fn clear(&mut self) {
		self.bytes.clear();
		self.ends.clear();
		if self.bytes.capacity() > MAX_RETAINED_BYTES {
			self.bytes.shrink_to(0);
		}
	}

	fn push(&mut self, read: &[u8]) {
		self.bytes.extend_from_slice(read);
		self.ends.push(self.bytes.len());
	}
}

#[derive(Default)]
struct Queue {
	reads: Reads,
	end:   Option<End>,
}

/// What the reader thread shares with its owner.
struct Shared {
	queue: Mutex<Queue>,
	/// A wake-up is outstanding: the owner has not taken the queue since.
	woken: AtomicBool,
	wake:  WakeFn,
}

impl Shared {
	/// Queue one read and wake the owner.
	fn deliver(&self, read: &[u8]) {
		self.queue.lock().reads.push(read);
		self.wake_owner();
	}

	/// Queue the end of input and wake the owner. The reader stops after it.
	fn finish(&self, end: End) {
		self.queue.lock().end.get_or_insert(end);
		self.wake_owner();
	}

	fn wake_owner(&self) {
		if !self.woken.swap(true, Ordering::AcqRel) {
			(self.wake)();
		}
	}
}

/// Owned stdin: the saved terminal mode and the reader thread.
pub(crate) struct Stdin {
	/// `None` when stdin is not a terminal: it is read as is.
	mode:   Option<sys::RawMode>,
	reader: Option<sys::Reader>,
	shared: Arc<Shared>,
}

impl Stdin {
	/// Take this process's stdin: raw mode when it is a terminal, and a reader
	/// thread that calls `wake` whenever reads are queued.
	///
	/// # Errors
	/// Fails when the terminal mode cannot be read or set (a revoked pty that
	/// still claims to be a TTY), or the reader cannot start; nothing is left
	/// changed then.
	pub(crate) fn attach(wake: WakeFn) -> io::Result<Self> {
		Self::open(sys::stdin()?, wake)
	}

	fn open(input: sys::Input, wake: WakeFn) -> io::Result<Self> {
		let mode = sys::RawMode::enter(input)?;
		let shared = Arc::new(Shared {
			queue: Mutex::new(Queue::default()),
			woken: AtomicBool::new(false),
			wake,
		});
		let reader = match sys::Reader::start(input, Arc::clone(&shared)) {
			Ok(reader) => reader,
			Err(err) => {
				if let Some(mode) = &mode {
					let _ = mode.restore();
				}
				return Err(err);
			},
		};
		Ok(Self { mode, reader: Some(reader), shared })
	}

	/// Raw input attached over a cooked terminal whose line discipline turned
	/// Enter into a line feed: the first read starts with what it buffered.
	pub(crate) fn cooked_typeahead(&self) -> bool {
		self.mode.as_ref().is_some_and(sys::RawMode::cooked)
	}

	/// Move every queued read into `into` (which must be empty) and return
	/// the end of input once it is reached, after the reads before it.
	pub(crate) fn take(&self, into: &mut Reads) -> Option<End> {
		// Re-arm before taking: a read queued after the swap wakes again.
		self.shared.woken.store(false, Ordering::Release);
		let mut queue = self.shared.queue.lock();
		mem::swap(&mut queue.reads, into);
		queue.end.take()
	}

	/// Cancel and join the reader. Nothing is read after this returns; reads
	/// it already queued stay for [`take`](Self::take).
	pub(crate) fn stop_reading(&mut self) {
		if let Some(mut reader) = self.reader.take() {
			reader.stop();
		}
	}

	/// Stop reading and put back the terminal mode found at attach.
	///
	/// # Errors
	/// Fails when the mode cannot be restored: on a live terminal that leaves
	/// it raw, on a hung-up one there is nothing left to restore.
	pub(crate) fn detach(mut self) -> io::Result<()> {
		self.stop_reading();
		self.mode.take().map_or(Ok(()), |mode| mode.restore())
	}
}

impl Drop for Stdin {
	fn drop(&mut self) {
		self.stop_reading();
		if let Some(mode) = self.mode.take() {
			let _ = mode.restore();
		}
	}
}
