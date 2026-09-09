//! Terminal event actor: one async task owns the input decoder and turns
//! raw terminal bytes, debug injections, and decoder deadlines into a
//! single mailbox of fully decoded [`TerminalEvent`]s.
//!
//! The actor `select!`s over three async sources — the byte source, the
//! control channel, and the partial-escape deadline — plus, on Unix, the
//! SIGWINCH self-pipe. Nothing here or in any host polls with a timeout:
//!
//! - [`crate::Terminal::next`] awaits the mailbox; resize rides a
//!   `tokio::sync::watch` side channel so its biased `select!` observes a
//!   resize before any backlog of queued input.
//! - The `OMP_TUI_DEBUG` server has ONE ingress: it queues every debug action
//!   on the control channel ([`send_event`], [`inject_bytes`]), and the actor
//!   emits them into the mailbox in send order — injected raw bytes decode
//!   before any later action, so acknowledged actions are ordering barriers.
//! - Keymap edits arrive as actor commands ([`Pump::set_keymap`]) and apply
//!   before the next decoded chord.
//!
//! The byte source is an [`AsyncFd`] wherever the platform can poll the
//! terminal handle (Linux and other non-macOS Unix, plus every pipe or pty
//! in tests); macOS `/dev/tty` and Windows `CONIN$` are not readiness-
//! pollable, so those bridge through a minimal reader thread whose only job
//! is `read` → flume. The actor is per-[`crate::Terminal`]: entry spawns it
//! seeded with bytes preserved by capability negotiation, and
//! [`crate::Terminal::leave`] stops it before the teardown drain reclaims
//! the descriptor.

#[cfg(unix)]
use std::os::fd;
use std::{fs::File, future, io, sync, sync::atomic, thread, time::Instant};

use flume::Receiver;
use parking_lot::Mutex;
#[cfg(unix)]
use tokio::io::unix::AsyncFd;
use tokio::sync::watch;

use crate::input::{Chord, InputDecoder, InputEvent, Keymap};

/// One decoded terminal event.
///
/// Real input, debug-injected input, and debug queries share a single mailbox
/// in arrival order. Pure data — the `OMP_TUI_DEBUG` protocol serializes it
/// directly.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum TerminalEvent {
	/// A decoded input event — key, mouse, paste, focus, or a terminal
	/// response the host forwards to [`crate::Terminal::handle_input_event`].
	Input(InputEvent),
	/// A decoded input event carrying physical-read context needed by hosts.
	InputWithMeta {
		/// Decoded key, mouse, paste, focus, or terminal response.
		event:              InputEvent,
		/// A submit key follows this paste in the same terminal read.
		submit_after_paste: bool,
	},
	/// Terminal geometry may have changed; resolve it with
	/// [`crate::Terminal::take_resize`]. Delivered ahead of queued input
	/// through the resize watch in [`crate::Terminal::next`].
	Resize,
	/// A debug-protocol query routed through the event loop, in order with
	/// injected and real input. [`crate::Terminal::next`] answers the
	/// terminal-owned ops itself; retained-tree ops reach the host, which
	/// answers via [`crate::respond_debug_query`] (hosts without a retained
	/// tree ignore them and the server times the request out).
	Debug(DebugQuery),
	/// A serialized extension UI effect injected by the headless debug socket.
	Effect(serde_json::Value),
	/// The terminal input closed or failed; no more input will arrive.
	/// [`crate::Terminal::next`] surfaces it as an error.
	Closed,
}

/// One correlated debug query routed through the event loop.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct DebugQuery {
	/// Server-side correlation id for [`crate::App`]'s reply.
	pub id: u64,
	/// The queried state.
	pub op: DebugOp,
}

/// Debug-protocol ops carried by [`TerminalEvent::Debug`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum DebugOp {
	/// Viewport, document, and overlay summary; answered by the terminal
	/// from the renderer's published snapshot.
	Info,
	/// Visible viewport as text; answered by the terminal from the
	/// renderer's published snapshot.
	Text,
	/// Re-read tty geometry; the terminal emulates a SIGWINCH so the
	/// normal resize flow runs.
	Resize,
	/// Quit request; the terminal acknowledges and emits `C-c`, the
	/// conventional quit chord.
	Quit,
	/// Full document frame as text rows (retained hosts).
	Frame,
	/// Component tree with kinds, ids, rectangles, and focus (retained
	/// hosts).
	Tree,
	/// [`crate::Ui::values`] of the base tree (retained hosts).
	Values,
	/// Lists extension mounts with their resolved rectangles.
	Slots,
}
/// One command for the event actor.
enum Ctl {
	/// A terminal event to emit in ingress order — debug-injected input and
	/// correlated debug queries. The actor flushes decoded input queued
	/// ahead of it first, so a query can never overtake earlier injected
	/// bytes.
	Event(TerminalEvent),
	/// Raw bytes to run through the live decoder.
	Bytes(Vec<u8>),
	/// Physical chords to emit through the live keymap, exactly like
	/// decoded bytes.
	Chords(Vec<Chord>),
	/// Replace the chord keymap.
	Keymap(Keymap),
}

/// The single debug ingress: every `OMP_TUI_DEBUG` action enters the actor
/// through this control channel and is emitted into the mailbox in send
/// order, so acknowledged actions are ordering barriers for later ones.
static SHARED_CTL: Mutex<Option<flume::Sender<Ctl>>> = Mutex::new(None);

/// Queues one event on the active actor's ingress. `false` when no
/// terminal is live, in which case nothing would consume it.
pub fn send_event(event: TerminalEvent) -> bool {
	send_ctl(Ctl::Event(event))
}

/// Feeds debug-injected raw bytes through the active actor's decoder; the
/// decode happens before any later ingress action is emitted.
pub fn inject_bytes(bytes: Vec<u8>) -> bool {
	send_ctl(Ctl::Bytes(bytes))
}

/// Emits debug-injected physical chords through the active actor's live
/// keymap, so a bound chord reaches the host as the same
/// [`crate::InputEvent::Chord`] edge the terminal would have produced.
pub fn inject_chords(chords: Vec<Chord>) -> bool {
	send_ctl(Ctl::Chords(chords))
}

fn send_ctl(ctl: Ctl) -> bool {
	let sender = SHARED_CTL.lock().clone();
	sender.is_some_and(|sender| sender.send(ctl).is_ok())
}

/// Installs a bare ingress so debug-server tests can exercise the query
/// path without a live terminal; the returned receiver yields the events
/// the actor would emit.
#[cfg(test)]
pub fn publish_ingress_for_test() -> Receiver<TerminalEvent> {
	let (ctl_tx, ctl_rx) = flume::unbounded();
	let (event_tx, event_rx) = flume::unbounded();
	*SHARED_CTL.lock() = Some(ctl_tx);
	thread::spawn(move || {
		while let Ok(ctl) = ctl_rx.recv() {
			if let Ctl::Event(event) = ctl
				&& event_tx.send(event).is_err()
			{
				return;
			}
		}
	});
	event_rx
}

/// Handle to a running event actor; stopping is idempotent and dropping
/// stops it.
pub struct Pump {
	task:   tokio::task::JoinHandle<()>,
	bridge: Option<Bridge>,
	ctl:    flume::Sender<Ctl>,
}

/// A reader thread bridging a non-pollable input handle into the actor.
struct Bridge {
	stop:   sync::Arc<atomic::AtomicBool>,
	worker: Option<thread::JoinHandle<()>>,
}

impl Pump {
	/// Publishes this actor's ingress for the `OMP_TUI_DEBUG` server;
	/// entry-only, so test terminals stay private.
	pub(crate) fn publish(&self) {
		*SHARED_CTL.lock() = Some(self.ctl.clone());
	}

	/// Replaces the decoder's chord keymap; applies before the next decoded
	/// chord.
	pub(crate) fn set_keymap(&self, keymap: Keymap) {
		let _ = self.ctl.send(Ctl::Keymap(keymap));
	}

	/// Stops the actor (and any bridge thread) and releases the input
	/// handle.
	///
	/// Called by [`crate::Terminal::leave`] before the teardown drain reads
	/// the descriptor directly.
	pub(crate) fn stop(&mut self) {
		self.task.abort();
		if let Some(bridge) = self.bridge.as_mut() {
			bridge.stop.store(true, atomic::Ordering::Release);
			if let Some(worker) = bridge.worker.take() {
				let _ = worker.join();
			}
		}
	}
}

impl Drop for Pump {
	fn drop(&mut self) {
		self.stop();
	}
}

/// Everything the spawned actor hands back to its owning terminal.
pub struct PumpChannels {
	/// The running actor.
	pub pump:   Pump,
	/// Sole receiver of decoded terminal events.
	pub events: Receiver<TerminalEvent>,
	/// Resize side channel; the value is a monotonically increasing wake
	/// count. Never fires on Windows, where hosts poll geometry instead.
	pub resize: watch::Receiver<u64>,
}

/// Raw bytes flowing into the actor.
enum ByteSource {
	/// Readiness-pollable handle (non-macOS Unix terminals; test pipes and
	/// ptys everywhere on Unix).
	#[cfg(unix)]
	Fd(AsyncFd<fd::OwnedFd>),
	/// Reader-thread bridge for handles the OS cannot poll.
	Thread(Receiver<Vec<u8>>),
}

impl ByteSource {
	/// Waits for the next chunk; `Ok(None)` means the handle closed.
	///
	/// Cancel-safe: no chunk is lost when the surrounding `select!` takes
	/// another branch first.
	async fn next(&mut self) -> io::Result<Option<Vec<u8>>> {
		match self {
			#[cfg(unix)]
			Self::Fd(fd) => loop {
				let mut guard = fd.readable().await?;
				let mut bytes = [0_u8; 4096];
				match guard.try_io(|fd| read_fd(fd.get_ref(), &mut bytes)) {
					Ok(Ok(0)) => return Ok(None),
					Ok(Ok(read)) => return Ok(Some(bytes[..read].to_vec())),
					Ok(Err(error)) => return Err(error),
					Err(_) => {},
				}
			},
			Self::Thread(rx) => Ok(rx.recv_async().await.ok()),
		}
	}
}

/// Reads once from a raw descriptor, retrying `EINTR`.
#[cfg(unix)]
fn read_fd(fd: &fd::OwnedFd, bytes: &mut [u8]) -> io::Result<usize> {
	use std::os::fd::AsRawFd as _;
	loop {
		// SAFETY: `fd` is open for reading and `bytes` is a writable slice.
		let read = unsafe { nix::libc::read(fd.as_raw_fd(), bytes.as_mut_ptr().cast(), bytes.len()) };
		if read >= 0 {
			return Ok(read as usize);
		}
		let error = io::Error::last_os_error();
		if error.kind() != io::ErrorKind::Interrupted {
			return Err(error);
		}
	}
}

/// Spawns the event actor over `input` with `decoder`, seeded with
/// `preserved` bytes from capability negotiation. On Unix, the actor owns
/// the process SIGWINCH stream.
///
/// # Panics
///
/// Panics outside a tokio runtime.
pub fn spawn(
	input: Input,
	mut decoder: InputDecoder,
	preserved: &[u8],
	#[cfg_attr(windows, expect(unused_variables, reason = "Windows polls geometry instead"))]
	watch_resize: bool,
) -> io::Result<PumpChannels> {
	let (events_tx, events_rx) = flume::unbounded();
	let (resize_tx, resize_rx) = watch::channel(0_u64);
	let (ctl_tx, ctl_rx) = flume::unbounded();

	let (source, bridge) = input.into_source()?;
	#[cfg(unix)]
	let resize = watch_resize
		.then(|| tokio::signal::unix::signal(tokio::signal::unix::SignalKind::window_change()))
		.transpose()?;
	#[cfg(windows)]
	let resize = ();

	let mut events = Vec::new();
	decoder.feed(preserved, Instant::now(), &mut events);

	let task = tokio::spawn(actor(source, decoder, events, events_tx, ctl_rx, resize, resize_tx));
	Ok(PumpChannels {
		pump:   Pump { task, bridge, ctl: ctl_tx },
		events: events_rx,
		resize: resize_rx,
	})
}

/// The input handle the actor reads, chosen by the terminal per platform.
pub enum Input {
	/// A readiness-pollable Unix handle (terminal, pipe, or pty).
	#[cfg(unix)]
	#[cfg_attr(
		target_os = "macos",
		allow(dead_code, reason = "macOS terminals bridge; tests spawn pollable pipe sources")
	)]
	Pollable(File),
	/// A handle that needs a reader-thread bridge (macOS `/dev/tty`,
	/// Windows `CONIN$`).
	Bridged(File),
}

impl Input {
	fn into_source(self) -> io::Result<(ByteSource, Option<Bridge>)> {
		match self {
			#[cfg(unix)]
			Self::Pollable(file) => {
				use std::os::fd::AsRawFd as _;
				// SAFETY: fcntl F_SETFL with O_NONBLOCK on an owned handle.
				if unsafe {
					nix::libc::fcntl(file.as_raw_fd(), nix::libc::F_SETFL, nix::libc::O_NONBLOCK)
				} < 0
				{
					return Err(io::Error::last_os_error());
				}
				let fd = AsyncFd::new(fd::OwnedFd::from(file))?;
				Ok((ByteSource::Fd(fd), None))
			},
			Self::Bridged(file) => {
				let (tx, rx) = flume::unbounded();
				let stop = sync::Arc::new(atomic::AtomicBool::new(false));
				let bridge_stop = sync::Arc::clone(&stop);
				let worker = thread::Builder::new()
					.name("omp-tui-input".into())
					.spawn(move || bridge_loop(file, &tx, &bridge_stop))?;
				Ok((ByteSource::Thread(rx), Some(Bridge { stop, worker: Some(worker) })))
			},
		}
	}
}

/// Blocking bridge for non-pollable handles: `read` → flume until EOF,
/// error, or stop. The 50ms cadence exists only to observe `stop`; it never
/// delays delivery of ready bytes.
fn bridge_loop(input: File, tx: &flume::Sender<Vec<u8>>, stop: &atomic::AtomicBool) {
	let mut bytes = [0_u8; 4096];
	#[cfg(unix)]
	{
		use std::{io::Read as _, os::fd::AsRawFd as _};
		let mut input = input;
		let mut descriptor =
			nix::libc::pollfd { fd: input.as_raw_fd(), events: nix::libc::POLLIN, revents: 0 };
		while !stop.load(atomic::Ordering::Acquire) {
			descriptor.revents = 0;
			// SAFETY: single pollfd, valid for the call.
			let ready = unsafe { nix::libc::poll(&mut descriptor, 1, 50) };
			if ready < 0 {
				if io::Error::last_os_error().kind() == io::ErrorKind::Interrupted {
					continue;
				}
				return;
			}
			if ready == 0 {
				continue;
			}
			if descriptor.revents & (nix::libc::POLLERR | nix::libc::POLLNVAL) != 0 {
				return;
			}
			match input.read(&mut bytes) {
				Ok(0) => return,
				Ok(read) => {
					if tx.send(bytes[..read].to_vec()).is_err() {
						return;
					}
				},
				Err(error)
					if matches!(
						error.kind(),
						std::io::ErrorKind::Interrupted | std::io::ErrorKind::WouldBlock
					) => {},
				Err(_) => return,
			}
		}
	}
	#[cfg(windows)]
	{
		use std::{io::Read as _, os::windows::io::AsRawHandle as _};

		use windows_sys::Win32::{Foundation, System::Threading};
		let mut input = input;
		let handle = input.as_raw_handle();
		while !stop.load(atomic::Ordering::Acquire) {
			let ready = unsafe { Threading::WaitForSingleObject(handle, 50) };
			if ready == Foundation::WAIT_TIMEOUT {
				continue;
			}
			if ready != Foundation::WAIT_OBJECT_0 {
				return;
			}
			match input.read(&mut bytes) {
				Ok(0) => return,
				Ok(read) => {
					if tx.send(bytes[..read].to_vec()).is_err() {
						return;
					}
				},
				Err(_) => return,
			}
		}
	}
}

fn send_inputs(events: &mut Vec<InputEvent>, events_tx: &flume::Sender<TerminalEvent>) -> bool {
	let events = std::mem::take(events);
	let last_submit = events.iter().rposition(|event| match event {
		InputEvent::Key(crate::Key::Enter) => true,
		InputEvent::Chord(event) => event.pressed && event.key == Some(crate::Key::Enter),
		_ => false,
	});
	for (index, event) in events.into_iter().enumerate() {
		let submit_after_paste =
			matches!(&event, InputEvent::Paste(_)) && last_submit.is_some_and(|submit| submit > index);
		let event = if submit_after_paste {
			TerminalEvent::InputWithMeta { event, submit_after_paste }
		} else {
			TerminalEvent::Input(event)
		};
		if events_tx.send(event).is_err() {
			return false;
		}
	}
	true
}

/// The decode loop: byte source, control channel, decoder deadline, and
/// resize pipe merged into one ordered stream of [`TerminalEvent`]s.
async fn actor(
	mut source: ByteSource,
	mut decoder: InputDecoder,
	mut events: Vec<InputEvent>,
	events_tx: flume::Sender<TerminalEvent>,
	ctl_rx: Receiver<Ctl>,
	#[cfg(unix)] mut resize: Option<tokio::signal::unix::Signal>,
	#[cfg(windows)] resize: (),
	resize_tx: watch::Sender<u64>,
) {
	// The resize sender lives for the actor's lifetime so
	// `watch::Receiver::changed` pends instead of erroring where resize
	// wakes never fire.
	let mut resize_wakes = 0_u64;
	loop {
		if !send_inputs(&mut events, &events_tx) {
			return;
		}
		let wake = decoder.deadline();
		tokio::select! {
			// Resize outranks everything: a replenished debug or input
			// backlog must never keep the watch from firing.
			biased;
			() = resize_readable(#[cfg(unix)] &mut resize) => {
				crate::terminal::record_resize_signal();
				resize_wakes += 1;
				if resize_tx.send(resize_wakes).is_err() {
					return;
				}
			},
			chunk = source.next() => if let Ok(Some(bytes)) = chunk {
						decoder.feed(&bytes, Instant::now(), &mut events);
					} else {
						let _ = events_tx.send(TerminalEvent::Closed);
						return;
					},
			// One ingress action per iteration: flume preserves send order
			// and the loop-top flush keeps decoded input ahead of later
			// actions, while resize stays reachable between actions.
			ctl = ctl_rx.recv_async() => {
				let Ok(ctl) = ctl else {
					// The owning terminal is gone; nothing to serve.
					return;
				};
				if !apply_ctl(ctl, &mut decoder, &mut events, &events_tx) {
					return;
				}
			},
			() = deadline(wake) => {
				decoder.tick(Instant::now(), &mut events);
			},
		}
	}
}

/// Applies one ingress action in order: raw bytes advance the decoder,
/// events flush decoded input queued ahead of them and then emit, keymap
/// swaps apply immediately. `false` once the mailbox is gone.
fn apply_ctl(
	ctl: Ctl,
	decoder: &mut InputDecoder,
	events: &mut Vec<InputEvent>,
	events_tx: &flume::Sender<TerminalEvent>,
) -> bool {
	match ctl {
		Ctl::Bytes(bytes) => {
			decoder.feed(&bytes, Instant::now(), events);
			true
		},
		Ctl::Chords(chords) => {
			for chord in chords {
				decoder.inject(chord, events);
			}
			true
		},
		Ctl::Event(event) => {
			if !send_inputs(events, events_tx) {
				return false;
			}
			events_tx.send(event).is_ok()
		},
		Ctl::Keymap(keymap) => {
			*decoder.keymap_mut() = keymap;
			true
		},
	}
}

/// Resolves once the next SIGWINCH arrives.
#[cfg(unix)]
async fn resize_readable(resize: &mut Option<tokio::signal::unix::Signal>) {
	match resize {
		Some(signal) => {
			if signal.recv().await.is_none() {
				future::pending::<()>().await;
			}
		},
		None => future::pending::<()>().await,
	}
}

#[cfg(windows)]
async fn resize_readable(_resize: ()) {
	future::pending::<()>().await
}

/// Sleeps until `at`; `None` disables the branch.
async fn deadline(at: Option<Instant>) {
	match at {
		Some(at) => {
			tokio::time::sleep_until(at.into()).await;
		},
		None => future::pending::<()>().await,
	}
}
