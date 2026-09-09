//! Client-side primitives for document protocol streams.

use std::sync::atomic::{AtomicBool, Ordering};

use flume::Receiver;

/// Creates a producer and terminal receiver for an ordered protocol event
/// stream.
///
/// The first error is terminal at the receiver even if a transport task still
/// has buffered frames. This prevents consumers from treating events after a
/// continuity gap as contiguous.
pub fn terminal_event_channel<T, E>() -> (flume::Sender<Result<T, E>>, TerminalEventReceiver<T, E>)
{
	let (sender, receiver) = flume::unbounded();
	(sender, TerminalEventReceiver { receiver, terminal: AtomicBool::new(false) })
}

/// Ordered client-side event receiver which permanently stops at its first
/// error.
#[derive(Debug)]
pub struct TerminalEventReceiver<T, E> {
	receiver: Receiver<Result<T, E>>,
	terminal: AtomicBool,
}

impl<T, E> TerminalEventReceiver<T, E> {
	/// Waits for the next contiguous event.
	///
	/// Returns `None` after the producer closes or after an error has already
	/// been returned. An error item is returned exactly once.
	pub async fn next_event(&self) -> Option<Result<T, E>> {
		if self.terminal.load(Ordering::Acquire) {
			return None;
		}
		match self.receiver.recv_async().await {
			Ok(Ok(event)) => Some(Ok(event)),
			Ok(Err(error)) => {
				self.terminal.store(true, Ordering::Release);
				Some(Err(error))
			},
			Err(_) => {
				self.terminal.store(true, Ordering::Release);
				None
			},
		}
	}

	/// Returns whether this receiver has observed a terminal error or closure.
	pub fn is_terminal(&self) -> bool {
		self.terminal.load(Ordering::Acquire)
	}
}
