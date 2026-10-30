//! The bytes crossing one run's pipeline pipes, kept readable while the run
//! goes on and after it ends.
//!
//! `cargo build 2>&1 | tail -5` shows nothing until `cargo` exits: `tail`
//! holds its input back. With [`PipeTaps`] on a run (see
//! [`ShellRunOptions::pipe_taps`](crate::ShellRunOptions)), every `|` the run
//! spawns is relayed through brush's pipe tap, and the bytes `cargo` has
//! written so far stay readable here as stream 1.

use std::{collections::VecDeque, sync::Arc};

use brush_core::{PipeMirror, PipeTap};
use parking_lot::Mutex;

/// Bytes kept per stream: its most recent output.
const RETAINED_BYTES: usize = 1 << 20;
/// Streams one run keeps, open and finished together; pipes past this many
/// open ones stay untapped.
const MAX_STREAMS: usize = 16;
/// Finished streams one run keeps, newest first, so a loop of short
/// pipelines (`for f in *; do cat "$f" | wc -l; done`) holds a few, not all.
const MAX_FINISHED_STREAMS: usize = 4;

/// The tapped pipes of one shell run, numbered from 1 in the order the run
/// opened them.
#[derive(Default)]
pub struct PipeTaps {
	inner: Mutex<TapsInner>,
}

#[derive(Default)]
struct TapsInner {
	/// Ids handed out so far; the next stream is `opened + 1`.
	opened:  u32,
	streams: Vec<Arc<PipeStream>>,
}

/// One tapped pipe: the producing and consuming stages and the tail of what
/// crossed it.
pub struct PipeStream {
	id:       u32,
	producer: String,
	consumer: String,
	state:    Mutex<StreamState>,
}

struct StreamState {
	/// The last [`RETAINED_BYTES`] bytes written.
	tail:  VecDeque<u8>,
	/// Every byte ever written, retained or not.
	total: u64,
	open:  bool,
}

/// A tapped pipe as [`PipeTaps::list`] reports it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PipeStreamInfo {
	pub id:       u32,
	/// Source text of the stage writing into the pipe.
	pub producer: String,
	/// Source text of the stage reading from it.
	pub consumer: String,
	/// Bytes written so far, including those no longer retained.
	pub total:    u64,
	/// Whether bytes may still arrive.
	pub open:     bool,
}

/// Retained bytes of one stream, as stream offsets `start..end`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PipeStreamRead {
	pub start: u64,
	pub end:   u64,
	pub data:  Vec<u8>,
	pub open:  bool,
}

impl PipeTaps {
	#[must_use]
	pub fn new() -> Self {
		Self::default()
	}

	/// Every retained stream, oldest first.
	#[must_use]
	pub fn list(&self) -> Vec<PipeStreamInfo> {
		let streams = self.inner.lock().streams.clone();
		streams
			.iter()
			.map(|stream| {
				let state = stream.state.lock();
				PipeStreamInfo {
					id:       stream.id,
					producer: stream.producer.clone(),
					consumer: stream.consumer.clone(),
					total:    state.total,
					open:     state.open,
				}
			})
			.collect()
	}

	/// Retained bytes of stream `id` from stream offset `from` on (clamped to
	/// what is still retained), or all of them without `from`. `None` for an
	/// id this run never opened or no longer keeps.
	#[must_use]
	pub fn read(&self, id: u32, from: Option<u64>) -> Option<PipeStreamRead> {
		let stream = self
			.inner
			.lock()
			.streams
			.iter()
			.find(|stream| stream.id == id)
			.cloned()?;
		let state = stream.state.lock();
		let retained_from = state.total - state.tail.len() as u64;
		let start = from.map_or(retained_from, |from| from.clamp(retained_from, state.total));
		let skip = usize::try_from(start - retained_from).unwrap_or(usize::MAX);
		Some(PipeStreamRead {
			start,
			end: state.total,
			data: state.tail.iter().skip(skip).copied().collect(),
			open: state.open,
		})
	}
}

impl PipeTap for PipeTaps {
	fn open(&self, producer: &str, consumer: &str) -> Option<Arc<dyn PipeMirror>> {
		let mut inner = self.inner.lock();
		let mut finished = inner
			.streams
			.iter()
			.filter(|stream| !stream.state.lock().open)
			.count();
		// Make room by dropping the oldest finished streams: a slot for the new
		// stream, and room for it to finish without exceeding
		// MAX_FINISHED_STREAMS.
		while finished > 0 && (inner.streams.len() >= MAX_STREAMS || finished >= MAX_FINISHED_STREAMS)
		{
			let oldest = inner
				.streams
				.iter()
				.position(|stream| !stream.state.lock().open)?;
			inner.streams.remove(oldest);
			finished -= 1;
		}
		if inner.streams.len() >= MAX_STREAMS {
			return None;
		}
		inner.opened += 1;
		let stream = Arc::new(PipeStream {
			id:       inner.opened,
			producer: producer.to_owned(),
			consumer: consumer.to_owned(),
			state:    Mutex::new(StreamState { tail: VecDeque::new(), total: 0, open: true }),
		});
		inner.streams.push(Arc::clone(&stream));
		Some(stream)
	}
}

impl PipeMirror for PipeStream {
	fn write(&self, bytes: &[u8]) {
		let mut state = self.state.lock();
		state.total += bytes.len() as u64;
		let kept = &bytes[bytes.len().saturating_sub(RETAINED_BYTES)..];
		let overflow = (state.tail.len() + kept.len()).saturating_sub(RETAINED_BYTES);
		state.tail.drain(..overflow);
		state.tail.extend(kept);
	}

	fn close(&self) {
		self.state.lock().open = false;
	}
}

impl std::fmt::Debug for PipeTaps {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		f.debug_struct("PipeTaps")
			.field("streams", &self.inner.lock().streams.len())
			.finish()
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn finish(taps: &PipeTaps, bytes: &[u8]) -> u32 {
		let mirror = taps.open("producer", "consumer").expect("a free slot");
		mirror.write(bytes);
		mirror.close();
		taps.list().last().expect("the stream just opened").id
	}

	// Failure mode: a long-running producer grows the retained copy without
	// bound, or a reader resuming from its last offset gets bytes twice.
	#[test]
	fn keeps_the_newest_bytes_and_resumes_from_an_offset() {
		let taps = PipeTaps::new();
		let mirror = taps.open("yes", "head").expect("a free slot");
		mirror.write(&vec![b'a'; RETAINED_BYTES]);
		mirror.write(b"tail");

		let all = taps.read(1, None).expect("stream 1");
		assert_eq!(all.start, 4);
		assert_eq!(all.end, RETAINED_BYTES as u64 + 4);
		assert_eq!(all.data.len(), RETAINED_BYTES);
		assert!(all.data.ends_with(b"tail"));
		assert!(all.open);

		let since = taps.read(1, Some(all.end - 2)).expect("stream 1");
		assert_eq!(since.data, b"il");
		// An offset older than the retained bytes starts at the oldest kept.
		assert_eq!(taps.read(1, Some(0)).expect("stream 1").start, 4);
	}

	// Failure mode: a loop of short pipelines either exhausts memory or, once
	// full, stops tapping the pipeline that is running now.
	#[test]
	fn drops_old_finished_streams_but_keeps_tapping_new_ones() {
		let taps = PipeTaps::new();
		let ids: Vec<u32> = (0..10).map(|_| finish(&taps, b"x")).collect();
		let kept: Vec<u32> = taps.list().iter().map(|stream| stream.id).collect();
		assert_eq!(kept, ids[ids.len() - MAX_FINISHED_STREAMS..]);
		assert!(taps.read(ids[0], None).is_none());
	}

	// Failure mode: open streams get evicted while still being read, or the
	// run spawns relays without limit.
	#[test]
	fn leaves_pipes_untapped_once_every_slot_is_open() {
		let taps = PipeTaps::new();
		let open: Vec<_> = (0..MAX_STREAMS)
			.map(|_| taps.open("a", "b").expect("a free slot"))
			.collect();
		assert!(taps.open("a", "b").is_none());
		open[0].close();
		assert!(taps.open("a", "b").is_some());
		assert_eq!(taps.list().len(), MAX_STREAMS);
	}
}
