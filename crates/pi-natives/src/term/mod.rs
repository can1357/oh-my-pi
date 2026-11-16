//! Terminal I/O: the output device and the owned stdin.
//!
//! Terminal output is described as ops — cursor moves, erases, DEC modes,
//! opaque text — rather than written as opaque strings. A [`Device`] encodes
//! the ops of one [`Batch`] into escape sequences, tracks the terminal state
//! they change (cursor visibility, alternate screen, keyboard-enhancement
//! stack, every mode to restore on exit), derives the exit restore from that
//! state, and writes through one of three sinks:
//!
//! - the pump (`pump.rs`): an off-thread, cancellable writer on this process's
//!   stdout terminal (a TTY on unix, the console on Windows);
//! - the capture (`capture.rs`): an in-memory buffer the owner takes and
//!   delivers itself (virtual terminals, test harnesses);
//! - discard: stdout is not a terminal, so control output is dropped.
//!
//! The sinks hold UTF-8, so a batch encodes straight into any of them.
//!
//! [`Stdin`] owns the input side of a process terminal: raw mode with exact
//! restore, and a reader thread that queues reads and wakes the owner.
//!
//! ```ignore
//! let mut device = Device::stdout(256 * 1024, Some(Box::new(on_drain)));
//! device.emit(|batch| {
//! 	batch
//! 		.frame_begin(true, false)
//! 		.move_to(3, 1)
//! 		.text(row)
//! 		.erase_line_to_end()
//! 		.frame_end();
//! });
//! // On exit:
//! device.restore();
//! device.stop(500);
//! ```

mod batch;
mod capture;
#[cfg(any(windows, test))]
mod chunks;
#[cfg(windows)]
mod console;
mod device;
mod log;
pub(crate) mod mode;
mod pump;
mod state;
mod stdin;

pub(crate) use batch::Batch;
pub(crate) use device::Device;
pub(crate) use stdin::{End as StdinEnd, Reads as StdinReads, Stdin};
