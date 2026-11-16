//! The terminal output device: a sink, the tracked state, and the write log.

use std::{io, path::Path};

use super::{batch::Batch, capture::Capture, log::WriteLog, pump::Pump, state::State};

/// Drain notification for a pump device. Runs on the pump's worker thread.
pub(crate) type DrainFn = Box<dyn Fn() + Send + Sync>;

enum Output {
	Pump(Pump),
	Capture(Capture),
	/// The destination is not a terminal (piped output, a log file): control
	/// sequences serve no purpose there and would surface as visible noise, so
	/// output is encoded (state stays tracked) into this scratch buffer and
	/// dropped.
	Discard(Vec<u8>),
}

/// Ordered terminal output with tracked state.
///
/// Callers describe output as ops inside [`emit`](Self::emit); the device
/// encodes them, remembers what they changed, and derives the exit
/// [`restore`](Self::restore) from that.
pub(crate) struct Device {
	state:  State,
	output: Output,
	log:    Option<WriteLog>,
}

impl Device {
	/// A device writing to this process's stdout from a dedicated thread: the
	/// TTY on unix, the console on Windows. When stdout is not a terminal, or
	/// its writer cannot start, output is dropped.
	///
	/// `on_drain` runs on the writer thread when [`pending`](Self::pending)
	/// crosses from above `drain_threshold` to at/below it, and on a fatal
	/// write even below the threshold.
	pub(crate) fn stdout(drain_threshold: u32, on_drain: Option<DrainFn>) -> Self {
		#[cfg(unix)]
		{
			Self::tty(libc::STDOUT_FILENO, drain_threshold, on_drain)
		}
		#[cfg(windows)]
		{
			Self::pump(Pump::console(drain_threshold, on_drain))
		}
	}

	/// A device writing to the TTY behind `fd` from a dedicated thread, or
	/// dropping its output when `fd` is not a TTY. `on_drain` as for
	/// [`stdout`](Self::stdout).
	#[cfg(unix)]
	pub(crate) fn tty(fd: i32, drain_threshold: u32, on_drain: Option<DrainFn>) -> Self {
		// SAFETY: isatty only inspects the descriptor.
		if unsafe { libc::isatty(fd) } == 0 {
			return Self::new(Output::Discard(Vec::new()));
		}
		Self::pump(Pump::start(fd, drain_threshold, on_drain))
	}

	fn pump(pump: napi::Result<Pump>) -> Self {
		match pump {
			Ok(pump) => Self::new(Output::Pump(pump)),
			Err(err) => {
				log::debug!("terminal output writer unavailable; dropping output: {err}");
				Self::new(Output::Discard(Vec::new()))
			},
		}
	}

	/// A device that holds its encoded output for
	/// [`take_output`](Self::take_output).
	pub(crate) fn capture() -> Self {
		Self::new(Output::Capture(Capture::default()))
	}

	fn new(output: Output) -> Self {
		Self { state: State::default(), output, log: None }
	}

	/// True when output is held for [`take_output`](Self::take_output)
	/// instead of written by the pump.
	pub(crate) const fn is_capture(&self) -> bool {
		matches!(self.output, Output::Capture(_))
	}

	/// Append every encoded byte to the file at `path` from now on. OSC 52
	/// clipboard payloads are logged as `<N bytes>`.
	///
	/// # Errors
	/// Fails when the file cannot be opened or created; logging stays off.
	pub(crate) fn log_writes(&mut self, path: &Path) -> io::Result<()> {
		self.log = Some(WriteLog::open(path)?);
		Ok(())
	}

	/// Encode the ops `fill` appends and enqueue them as one unit. Returns
	/// the bytes the pump has accepted and not yet written (capture: 0).
	///
	/// A dead or stopped pump accepts nothing: `fill` does not run.
	pub(crate) fn emit(&mut self, fill: impl FnOnce(&mut Batch<'_>)) -> usize {
		let Self { state, output, log } = self;
		match output {
			Output::Pump(pump) => {
				let pending = pump.enqueue(|bytes, marks| {
					let start = bytes.len();
					fill(&mut Batch::new(state, &mut *bytes, marks));
					// The worker may take the buffer once the queue lock is
					// released, so copy the batch now and write the file after.
					if let Some(log) = log.as_mut() {
						log.stage(&bytes[start..]);
					}
				});
				if let Some(log) = log {
					log.flush();
				}
				pending
			},
			Output::Capture(capture) => {
				let start = capture.len();
				fill(&mut Batch::new(state, capture.sink(), None));
				if let Some(log) = log {
					log.write(capture.since(start));
				}
				0
			},
			Output::Discard(scratch) => {
				fill(&mut Batch::new(state, &mut *scratch, None));
				if let Some(log) = log {
					log.write(scratch);
				}
				scratch.clear();
				0
			},
		}
	}

	/// Enqueue the exit restore: everything the device knows it changed and
	/// every mode the terminal layer may have left on, in a fixed order.
	/// Returns like [`emit`](Self::emit).
	pub(crate) fn restore(&mut self) -> usize {
		self.emit(|batch| batch.restore())
	}

	/// Bytes the pump has accepted and not yet written (otherwise 0).
	pub(crate) fn pending(&self) -> usize {
		match &self.output {
			Output::Pump(pump) => pump.pending(),
			Output::Capture(_) | Output::Discard(_) => 0,
		}
	}

	/// True after a pump write failed; all pending output was dropped.
	pub(crate) fn dead(&self) -> bool {
		match &self.output {
			Output::Pump(pump) => pump.dead(),
			Output::Capture(_) | Output::Discard(_) => false,
		}
	}

	/// The last value written for DEC private `mode`, or `None` while
	/// unknown.
	pub(crate) fn mode(&self, mode: u32) -> Option<bool> {
		self.state.mode(mode)
	}

	/// Whether the hardware cursor is showing, or `None` while unknown: never
	/// written, or not written since an alternate-screen switch or
	/// [`Batch::forget_cursor`].
	#[cfg(test)]
	pub(crate) fn cursor_visible(&self) -> Option<bool> {
		self.state.cursor_visible()
	}

	/// Whether the alternate screen was entered and not left.
	#[cfg(test)]
	pub(crate) fn alt_screen(&self) -> bool {
		self.state.alt_screen()
	}

	/// Flags of the kitty keyboard frame this device pushed, while pushed.
	#[cfg(test)]
	pub(crate) const fn kitty_flags(&self) -> Option<u32> {
		self.state.kitty
	}

	/// Whether the last xterm modifyOtherKeys level written was nonzero.
	#[cfg(test)]
	pub(crate) const fn modify_other_keys(&self) -> bool {
		self.state.modify_other_keys
	}

	/// Wait for the pump to write everything queued. False on timeout or a
	/// dead terminal (otherwise true).
	#[cfg(test)]
	pub(crate) fn flush_sync(&self, timeout_ms: u32) -> bool {
		match &self.output {
			Output::Pump(pump) => pump.flush_sync(timeout_ms),
			Output::Capture(_) | Output::Discard(_) => true,
		}
	}

	/// Capture: the output encoded since the last call, as one chunk.
	/// Otherwise always empty.
	pub(crate) fn take_output(&mut self) -> Vec<Vec<u8>> {
		match &mut self.output {
			Output::Capture(capture) => capture.take(),
			Output::Pump(_) | Output::Discard(_) => Vec::new(),
		}
	}

	/// Pump: drain until the deadline, then cancel and join; nothing is
	/// written after this returns and later output is dropped. Otherwise
	/// nothing to stop.
	pub(crate) fn stop(&mut self, flush_timeout_ms: u32) {
		if let Output::Pump(pump) = &mut self.output {
			pump.stop(flush_timeout_ms);
		}
	}
}

#[cfg(test)]
mod tests {
	use super::{super::mode, *};

	/// Run `fill` on a capture device and return what it encoded.
	fn emitted(device: &mut Device, fill: impl FnOnce(&mut Batch<'_>)) -> String {
		assert_eq!(device.emit(fill), 0);
		String::from_utf8(device.take_output().concat()).unwrap()
	}

	fn restored(device: &mut Device) -> String {
		assert_eq!(device.restore(), 0);
		String::from_utf8(device.take_output().concat()).unwrap()
	}

	const FRESH_RESTORE: &str = concat!(
		"\x1b[?2026l\x1b[?7h",
		"\x1b[?1l\x1b>",
		"\x1b[?2004l\x1b[?5522l",
		"\x1b[?1006l\x1b[?1003l\x1b[?1000l",
		"\x1b[?2031l",
		"\x1b[?25h",
	);

	#[test]
	fn cursor_and_erase_ops_encode_with_explicit_parameters() {
		let mut device = Device::capture();
		let output = emitted(&mut device, |batch| {
			batch
				.move_to(12, 1)
				.home()
				.up(1)
				.down(2)
				.forward(30)
				.column(7)
				.cr()
				.lf(1)
				.lf(3)
				.erase_line_to_end()
				.erase_line()
				.erase_below()
				.erase_screen()
				.erase_scrollback()
				.insert_lines(4)
				.delete_lines(1)
				.save_cursor()
				.restore_cursor();
		});
		assert_eq!(
			output,
			concat!(
				"\x1b[12;1H\x1b[H\x1b[1A\x1b[2B\x1b[30C\x1b[7G",
				"\r\n\n\n\n",
				"\x1b[K\x1b[2K\x1b[J\x1b[2J\x1b[3J",
				"\x1b[4L\x1b[1M\x1b7\x1b8",
			)
		);
	}

	#[test]
	fn zero_counts_and_empty_text_write_nothing() {
		let mut device = Device::capture();
		let output = emitted(&mut device, |batch| {
			batch
				.up(0)
				.down(0)
				.forward(0)
				.lf(0)
				.insert_lines(0)
				.delete_lines(0)
				.text("");
		});
		assert_eq!(output, "");
		assert!(device.take_output().is_empty());
	}

	#[test]
	fn text_attributes_queries_and_keyboard_ops_encode() {
		let mut device = Device::capture();
		let output = emitted(&mut device, |batch| {
			batch
				.text("row 界\x1b[31m")
				.sgr(0)
				.sgr(8)
				.title("omp — 界")
				.title("")
				.progress(3)
				.progress(0)
				.keypad_numeric()
				.query_device_attributes()
				.query_cursor_position()
				.query_private_mode(2026)
				.query_keyboard()
				.keyboard_push(7)
				.keyboard_pop()
				.modify_other_keys(2)
				.modify_other_keys(0);
		});
		assert_eq!(
			output,
			concat!(
				"row 界\x1b[31m\x1b[0m\x1b[8m",
				"\x1b]0;omp — 界\x07\x1b]0;\x07",
				"\x1b]9;4;3\x07\x1b]9;4;0;\x07",
				"\x1b>\x1b[c\x1b[6n\x1b[?2026$p\x1b[?u",
				"\x1b[>7u\x1b[<u\x1b[>4;2m\x1b[>4;0m",
			)
		);
		assert_eq!(device.kitty_flags(), None);
		assert!(!device.modify_other_keys());
	}

	#[test]
	fn modes_are_always_written_unless_deduped_against_the_last_write() {
		let mut device = Device::capture();
		assert_eq!(device.mode(mode::BRACKETED_PASTE), None);
		let output = emitted(&mut device, |batch| {
			batch
				// Unknown never matches.
				.reset_mode(mode::BRACKETED_PASTE, true)
				.reset_mode(mode::BRACKETED_PASTE, true)
				.reset_mode(mode::BRACKETED_PASTE, false)
				.set_mode(mode::BRACKETED_PASTE, true)
				.set_mode(mode::BRACKETED_PASTE, true)
				.set_mode(mode::MOUSE_SGR, false);
		});
		assert_eq!(output, "\x1b[?2004l\x1b[?2004l\x1b[?2004h\x1b[?1006h");
		assert_eq!(device.mode(mode::BRACKETED_PASTE), Some(true));
		assert_eq!(device.mode(mode::MOUSE_SGR), Some(true));
	}

	#[test]
	fn cursor_visibility_dedupes_until_it_becomes_unknown() {
		let mut device = Device::capture();
		assert_eq!(device.cursor_visible(), None);
		let hide = |batch: &mut Batch<'_>| {
			batch.reset_mode(mode::CURSOR_VISIBLE, true);
		};
		let show = |batch: &mut Batch<'_>| {
			batch.set_mode(mode::CURSOR_VISIBLE, true);
		};

		assert_eq!(emitted(&mut device, hide), "\x1b[?25l");
		assert_eq!(device.cursor_visible(), Some(false));
		assert_eq!(emitted(&mut device, hide), "");
		// A forced hide is written even when already hidden.
		assert_eq!(
			emitted(&mut device, |batch| {
				batch.reset_mode(mode::CURSOR_VISIBLE, false);
			}),
			"\x1b[?25l"
		);
		assert_eq!(emitted(&mut device, show), "\x1b[?25h");
		assert_eq!(emitted(&mut device, show), "");
		assert_eq!(device.cursor_visible(), Some(true));

		assert_eq!(
			emitted(&mut device, |batch| {
				batch.forget_cursor();
			}),
			""
		);
		assert_eq!(device.cursor_visible(), None);
		assert_eq!(emitted(&mut device, show), "\x1b[?25h");

		// Either direction of an alternate-screen switch forgets it too.
		assert_eq!(
			emitted(&mut device, |batch| {
				batch.set_mode(mode::ALT_SCREEN, false);
			}),
			"\x1b[?1049h"
		);
		assert_eq!(device.cursor_visible(), None);
		assert_eq!(emitted(&mut device, show), "\x1b[?25h");
		assert_eq!(
			emitted(&mut device, |batch| {
				batch.reset_mode(mode::ALT_SCREEN, false);
			}),
			"\x1b[?1049l"
		);
		assert_eq!(device.cursor_visible(), None);
		assert_eq!(emitted(&mut device, hide), "\x1b[?25l");

		// A frame hides the cursor and records it.
		device.emit(|batch| {
			batch.forget_cursor();
		});
		assert_eq!(
			emitted(&mut device, |batch| {
				batch.frame_begin(false, false).frame_end();
			}),
			"\x1b[?25l\x1b[?7l\x1b[?7h"
		);
		assert_eq!(device.cursor_visible(), Some(false));
		assert_eq!(emitted(&mut device, hide), "");
	}

	#[test]
	fn cursor_shape_is_written_only_when_it_changes() {
		let mut device = Device::capture();
		let output = emitted(&mut device, |batch| {
			batch
				.cursor_shape(0)
				.cursor_shape(2)
				.cursor_shape(2)
				.cursor_shape(6);
		});
		assert_eq!(output, "\x1b[0 q\x1b[2 q\x1b[6 q");
	}

	#[test]
	fn alternate_screen_carries_the_kitty_keyboard_frame() {
		let mut device = Device::capture();
		let output = emitted(&mut device, |batch| {
			batch.keyboard_push(15).set_mode(mode::ALT_SCREEN, false);
		});
		assert_eq!(output, "\x1b[>15u\x1b[?1049h\x1b[>15u");
		assert!(device.alt_screen());
		// Deduped like any mode: no second switch, no second push.
		assert_eq!(
			emitted(&mut device, |batch| {
				batch.set_mode(mode::ALT_SCREEN, true);
			}),
			""
		);

		let output = emitted(&mut device, |batch| {
			batch.reset_mode(mode::ALT_SCREEN, true);
		});
		assert_eq!(output, "\x1b[<u\x1b[?1049l\x1b[=15;1u");
		assert!(!device.alt_screen());
		assert_eq!(device.kitty_flags(), Some(15));

		// kitty wins when both enhancements are active.
		let output = emitted(&mut device, |batch| {
			batch.modify_other_keys(2).set_mode(mode::ALT_SCREEN, false);
		});
		assert_eq!(output, "\x1b[>4;2m\x1b[?1049h\x1b[>15u");
	}

	#[test]
	fn alternate_screen_reasserts_modify_other_keys_without_clearing_it_on_exit() {
		let mut device = Device::capture();
		let output = emitted(&mut device, |batch| {
			batch
				.modify_other_keys(2)
				.set_mode(mode::ALT_SCREEN, false)
				.reset_mode(mode::ALT_SCREEN, false);
		});
		assert_eq!(output, "\x1b[>4;2m\x1b[?1049h\x1b[>4;2m\x1b[?1049l");
		assert!(device.modify_other_keys());

		// With no enhancement active the switch is bare.
		let output = emitted(&mut device, |batch| {
			batch
				.modify_other_keys(0)
				.set_mode(mode::ALT_SCREEN, false)
				.reset_mode(mode::ALT_SCREEN, false);
		});
		assert_eq!(output, "\x1b[>4;0m\x1b[?1049h\x1b[?1049l");
	}

	#[test]
	fn frames_bracket_paints_and_close_only_the_sync_they_opened() {
		let mut device = Device::capture();
		let output = emitted(&mut device, |batch| {
			batch.frame_begin(true, false).text("row").frame_end();
		});
		assert_eq!(output, "\x1b[?25l\x1b[?2026h\x1b[?7lrow\x1b[?7h\x1b[?2026l");
		assert_eq!(device.mode(mode::AUTOWRAP), Some(true));
		assert_eq!(device.mode(mode::SYNCHRONIZED_OUTPUT), Some(false));

		let output = emitted(&mut device, |batch| {
			batch.frame_begin(false, true).text("row").frame_end();
		});
		assert_eq!(output, "\x1b[?25l\x1b[?7lrow\x1b[?7h");

		// A frame may stay open across batches; an unmatched end only restores
		// autowrap.
		assert_eq!(
			emitted(&mut device, |batch| {
				batch.frame_begin(true, false);
			}),
			"\x1b[?25l\x1b[?2026h\x1b[?7l"
		);
		assert_eq!(device.mode(mode::AUTOWRAP), Some(false));
		assert_eq!(
			emitted(&mut device, |batch| {
				batch.frame_end();
			}),
			"\x1b[?7h\x1b[?2026l"
		);
		assert_eq!(
			emitted(&mut device, |batch| {
				batch.frame_end();
			}),
			"\x1b[?7h"
		);
	}

	#[test]
	fn long_synchronized_frames_renew_between_ops() {
		const RENEW: &str = "\x1b[?2026h";
		let begin = "\x1b[?25l\x1b[?2026h\x1b[?7l";
		// One byte short of the renewal size, counting the frame's own opening.
		let first = "x".repeat(16 * 1024 - begin.len() - 1);
		let second = "y".repeat(20_000);

		let mut device = Device::capture();
		let output = emitted(&mut device, |batch| {
			batch
				.frame_begin(true, true)
				.text(&first)
				.cr()
				.text(&second)
				.text("z")
				.frame_end()
				.text(&second);
		});
		assert_eq!(
			output,
			format!("{begin}{first}\r{RENEW}{second}{RENEW}z\x1b[?7h\x1b[?2026l{second}")
		);

		// The count carries across batches of one frame.
		let half = "h".repeat(9_000);
		let mut output = emitted(&mut device, |batch| {
			batch.frame_begin(true, true).text(&half);
		});
		output += &emitted(&mut device, |batch| {
			batch.text(&half).frame_end();
		});
		assert_eq!(output, format!("{begin}{half}{half}{RENEW}\x1b[?7h\x1b[?2026l"));

		// Without renewal, or without sync to renew, nothing is inserted.
		for (sync, renew) in [(true, false), (false, true)] {
			let output = emitted(&mut device, |batch| {
				batch.frame_begin(sync, renew).text(&second).text(&second);
			});
			assert!(!output[begin.len()..].contains(RENEW));
			device.emit(|batch| {
				batch.frame_end();
			});
		}
	}

	#[test]
	fn restore_on_a_fresh_device_resets_only_the_unconditional_modes() {
		let mut device = Device::capture();
		assert_eq!(restored(&mut device), FRESH_RESTORE);
		assert_eq!(device.cursor_visible(), Some(true));
		assert!(!device.alt_screen());
	}

	#[test]
	fn restore_undoes_everything_the_device_changed_in_order() {
		let mut device = Device::capture();
		device.emit(|batch| {
			batch
				.progress(3)
				.keyboard_push(7)
				.modify_other_keys(2)
				.set_mode(mode::ALT_SCREEN, false)
				.cursor_shape(2)
				.reset_mode(mode::SCROLL_ON_OUTPUT, false)
				.reset_mode(mode::SCROLL_ON_KEY, false)
				.set_mode(mode::IN_BAND_RESIZE, false)
				.set_mode(mode::WIN32_INPUT, false)
				.frame_begin(true, true);
		});
		device.take_output();

		assert_eq!(
			restored(&mut device),
			concat!(
				"\x1b]9;4;0;\x07",
				"\x1b[<u\x1b[?1049l",
				"\x1b[?2026l\x1b[?7h",
				"\x1b[?1l\x1b>",
				"\x1b[?2004l\x1b[?5522l",
				"\x1b[0 q",
				"\x1b[?1006l\x1b[?1003l\x1b[?1000l",
				"\x1b[?2031l",
				"\x1b[?1010h\x1b[?1011h",
				"\x1b[?2048l",
				"\x1b[<u",
				"\x1b[>4;0m",
				"\x1b[?9001l",
				"\x1b[?25h",
			)
		);
		assert!(!device.alt_screen());
		assert_eq!(device.cursor_visible(), Some(true));
		assert_eq!(device.kitty_flags(), None);
		assert!(!device.modify_other_keys());

		// The restore updated the tracked state: nothing is undone twice, and
		// the closed frame no longer renews.
		assert_eq!(restored(&mut device), FRESH_RESTORE);
		let long = "x".repeat(40_000);
		assert_eq!(
			emitted(&mut device, |batch| {
				batch.text(&long).text("y");
			}),
			format!("{long}y")
		);
	}

	#[test]
	fn restore_leaves_modes_it_was_not_told_about_alone() {
		let mut device = Device::capture();
		device.emit(|batch| {
			batch
				// Already at their defaults: nothing to hand back.
				.cursor_shape(0)
				.set_mode(mode::SCROLL_ON_OUTPUT, false)
				.reset_mode(mode::IN_BAND_RESIZE, false)
				.reset_mode(mode::WIN32_INPUT, false)
				// Entered and left: DECRST 1049 is never written blindly.
				.set_mode(mode::ALT_SCREEN, false)
				.reset_mode(mode::ALT_SCREEN, false)
				.progress(3)
				.progress(0);
		});
		device.take_output();
		assert_eq!(restored(&mut device), FRESH_RESTORE);
	}

	/// Stdout that is not a terminal (piped output, a log file) gets no
	/// control output, but the device still tracks what it would have
	/// changed.
	#[cfg(unix)]
	#[test]
	fn a_non_terminal_destination_drops_output_but_tracks_state() {
		let (socket, mut peer) = std::os::unix::net::UnixStream::pair().unwrap();
		let mut device = Device::tty(std::os::fd::AsRawFd::as_raw_fd(&socket), 0, None);
		assert!(!device.is_capture());
		assert_eq!(
			device.emit(|batch| {
				batch.set_mode(mode::ALT_SCREEN, false).text("frame");
			}),
			0
		);
		assert!(device.alt_screen());
		assert!(device.take_output().is_empty());
		assert_eq!(device.pending(), 0);
		assert!(!device.dead());
		assert!(device.flush_sync(0));
		device.stop(0);
		peer.set_nonblocking(true).unwrap();
		let mut received = Vec::new();
		let read = std::io::Read::read_to_end(&mut peer, &mut received);
		assert!(received.is_empty(), "discarded output reached the destination: {read:?}");
	}

	#[test]
	fn write_log_records_encoded_output_with_clipboard_payloads_redacted() {
		let path = std::env::temp_dir().join(format!("pi-term-device-log-{}", std::process::id()));
		let _ = std::fs::remove_file(&path);
		let mut device = Device::capture();
		device.emit(|batch| {
			batch.text("unlogged");
		});
		device.log_writes(&path).unwrap();
		device.emit(|batch| {
			batch.erase_line().text("frame\x1b]52;c;c2VjcmV0\x07tail");
		});
		device.restore();
		let logged = std::fs::read_to_string(&path).unwrap();
		std::fs::remove_file(&path).unwrap();
		assert_eq!(logged, format!("\x1b[2Kframe\x1b]52;c;<8 bytes>\x07tail{FRESH_RESTORE}"));
		// The terminal still receives the payload.
		let output = String::from_utf8(device.take_output().concat()).unwrap();
		assert!(output.contains("\x1b]52;c;c2VjcmV0\x07"));
	}
}
