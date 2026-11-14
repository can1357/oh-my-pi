//! Decoding relays for external programs' output on its way into shell text.
//!
//! Builtins write the shell's own text (UTF-8). A native Windows program may
//! write the ANSI code page to a pipe, and one program's output is one
//! encoding, but a stream several commands write into is not. So the encoding
//! is decided per program, here, rather than by whoever reads the mixed
//! stream.
//!
//! A host that can decode such output installs an [`OutputDecoding`]. Every
//! external whose stdout or stderr is a *text sink* — the run's capture pipe
//! and a command substitution's capture — then writes into a pipe of its own;
//! a relay decodes it with a fresh [`ByteDecoder`] and forwards the text into
//! the sink. Pipeline pipes and files are not text sinks: they carry the
//! program's bytes unchanged, so binary data stays intact.
//!
//! A relay is not a thread: the external's `ExtProc` ([`Relayed`]) polls it
//! with the polling task's waker. It reads what the program wrote from our
//! end of the pipe (non-blocking or overlapped, [`os::OsPipe`]), decodes it
//! and writes the text into the sink, returning `Pending` wherever it would
//! wait.
//!
//! A command's relays drain before its exit is reported, so its output
//! reaches the sink ahead of whatever the next command writes there. Only the
//! relay reads the pipe, and the task polling it is the one sizing the
//! drain, so at the exit what the relay has read and what the pipe holds are
//! one snapshot: everything the exited program wrote. The exit is reported
//! once the relay has forwarded that much. A process the program left
//! running may keep the pipe open forever; the drain never waits for the end
//! of the stream beyond a short grace for a character the program ended
//! inside. The relay itself goes on to the end of the stream, as a plain pipe
//! would carry that process's output: once the `ExtProc` is dropped it runs
//! as adopted work (`pump::orphan`), and releases what the decoder holds at
//! the end.

use std::{
	fs,
	future::Future,
	io,
	pin::Pin,
	task::{Context, Poll, Waker},
	time::Duration,
};

use crate::{
	bash::{ExitStatus, ExtProc, OsHandle, ProcEvent, Signal},
	sys::pump::{
		BUF, BURST, End, PollIo, orphan,
		os::{self, OsPipe, Timer},
	},
};

/// Hook decoding external programs' output into shell text.
pub trait OutputDecoding: Send + Sync {
	/// A decoder for the output stream of one external program.
	fn decoder(&self) -> Box<dyn ByteDecoder>;
}

/// Incremental decoder for one external program's output stream.
pub trait ByteDecoder: Send {
	/// Decode the next chunk; bytes of an incomplete character stay held.
	fn push(&mut self, bytes: &[u8]) -> String;
	/// Whether bytes are held back for more input or for [`Self::finish`].
	fn holds_bytes(&self) -> bool;
	/// Flush held bytes at the end of the stream.
	fn finish(&mut self) -> String;
}

/// How long the drain waits for the end of the stream when the decoder holds
/// the start of a character the program ended inside.
const HOLD_GRACE: Duration = Duration::from_millis(50);

/// The OS handle a spawned child's stdio can inherit for `writer`.
fn writer_handle(writer: &fs::File) -> OsHandle {
	#[cfg(unix)]
	{
		use std::os::fd::AsRawFd;
		OsHandle(writer.as_raw_fd() as u64)
	}
	#[cfg(windows)]
	{
		use std::os::windows::io::AsRawHandle;
		OsHandle(writer.as_raw_handle().addr() as u64)
	}
}

/// Where a relay is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Phase {
	/// Forwarding what the program writes.
	Reading,
	/// The stream ended (or the relay was ended): release what the decoder
	/// holds.
	Finish,
	/// Flush the sink.
	Flush,
	/// Nothing more to do.
	Done,
}

/// One relay: our end of a program's pipe, its decoder and the text sink.
struct Relay {
	/// `None` once the stream ended, the sink refused text or the relay was
	/// ended at its program's exit.
	pipe:     Option<OsPipe>,
	decoder:  Option<Box<dyn ByteDecoder>>,
	sink:     End,
	buf:      Box<[u8]>,
	/// Decoded text, written into the sink up to `sent`.
	text:     Vec<u8>,
	sent:     usize,
	/// Raw bytes pending in `buf`, without a copy through `text`.
	raw_len:  usize,
	/// Bytes read from the program so far.
	consumed: u64,
	phase:    Phase,
	/// Bytes the program wrote, once its exit sized them.
	target:   Option<u64>,
	/// The hold grace, once the drain waits on a held character.
	grace:    Option<Timer>,
}

impl Relay {
	fn new(pipe: OsPipe, decoder: Option<Box<dyn ByteDecoder>>, sink: End) -> Self {
		Self {
			pipe: Some(pipe),
			decoder,
			sink,
			buf: vec![0; BUF].into_boxed_slice(),
			text: Vec::new(),
			sent: 0,
			raw_len: 0,
			consumed: 0,
			phase: Phase::Reading,
			target: None,
			grace: None,
		}
	}

	/// Forward what can move now; ready once done. Yields after a burst.
	fn poll(&mut self, cx: &mut Context<'_>) -> Poll<()> {
		for _ in 0..BURST {
			let pending = if self.decoder.is_some() {
				self.text.len()
			} else {
				self.raw_len
			};
			while self.sent < pending {
				let bytes = if self.decoder.is_some() {
					&self.text[..]
				} else {
					&self.buf[..self.raw_len]
				};
				match std::task::ready!(self.sink.poll_write(cx, &bytes[self.sent..])) {
					Ok(n) if n > 0 => self.sent += n,
					Err(e) if e.kind() == io::ErrorKind::Interrupted => {},
					_ => {
						// Refused (the sink's reader is gone) or failed: closing
						// our end makes that visible to the program, whose next
						// write fails as on a pipe whose reader is gone. Nothing
						// more reaches the sink.
						self.pipe = None;
						self.text.clear();
						self.sent = 0;
						self.phase = Phase::Done;
						return Poll::Ready(());
					},
				}
			}
			self.text.clear();
			self.raw_len = 0;
			self.sent = 0;
			match self.phase {
				Phase::Reading => {
					let read = match &mut self.pipe {
						Some(pipe) => std::task::ready!(pipe.poll_read(cx, &mut self.buf)),
						None => Ok(0),
					};
					match read {
						Ok(n) if n > 0 => {
							self.consumed += n as u64;
							if let Some(decoder) = &mut self.decoder {
								self.text = decoder.push(&self.buf[..n]).into_bytes();
							} else {
								self.raw_len = n;
							}
						},
						// End of file, or a failed pipe.
						_ => self.end(),
					}
				},
				Phase::Finish => {
					if let Some(decoder) = &mut self.decoder {
						self.text = decoder.finish().into_bytes();
					}
					self.phase = Phase::Flush;
				},
				Phase::Flush => {
					let _ = std::task::ready!(self.sink.poll_flush(cx));
					self.phase = Phase::Done;
				},
				Phase::Done => return Poll::Ready(()),
			}
		}
		// A burst moved: let the engine run, then go on.
		cx.waker().wake_by_ref();
		Poll::Pending
	}

	/// The stream ended: our end of the pipe closes first, then the decoder
	/// releases what it holds and the sink is flushed.
	fn end(&mut self) {
		self.pipe = None;
		if self.phase == Phase::Reading {
			self.phase = Phase::Finish;
		}
	}

	/// After the program's exit: whether everything it wrote has been
	/// forwarded. The relay itself goes on to the end of the stream, which a
	/// process the program left running may hold open.
	fn drained(&mut self, cx: &Context<'_>) -> bool {
		match self.phase {
			Phase::Done => return true,
			// The stream ended: drained once its rest is out and flushed.
			Phase::Finish | Phase::Flush => return false,
			Phase::Reading => {},
		}
		if self.target.is_none() {
			// Nothing but this relay reads the pipe, and this task polls it:
			// what it read and what the pipe holds now are one snapshot. A
			// pipe that cannot say is forwarded to its end.
			let waiting = self.pipe.as_mut().map_or(Ok(0), OsPipe::available);
			self.target = waiting.ok().map(|n| self.consumed + n as u64);
		}
		let Some(target) = self.target else {
			return false;
		};
		self.consumed >= target
			&& self.sent >= self.text.len().max(self.raw_len)
			&& (!self
				.decoder
				.as_ref()
				.is_some_and(|decoder| decoder.holds_bytes())
				|| self
					.grace
					.get_or_insert_with(|| Timer::after(HOLD_GRACE))
					.poll(cx)
					.is_ready())
	}
}

/// Relays that outlived their `Relayed`, forwarding to the ends of their
/// streams as one piece of adopted work.
struct Forward(Vec<Relay>);

impl Future for Forward {
	type Output = ();

	fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<()> {
		self.0.retain_mut(|r| r.poll(cx).is_pending());
		if self.0.is_empty() {
			Poll::Ready(())
		} else {
			Poll::Pending
		}
	}
}

/// The relays being set up for one spawn.
///
/// Each [`Relays::attach`] sets up a relay and returns the handle the
/// child's stdout or stderr inherits. The parent's copies of those handles
/// close when the set is wrapped around the spawned child ([`Relays::wrap`]),
/// which then polls the relays, or dropped with the relays (the spawn
/// failed).
pub(crate) struct Relays<'a> {
	decoding: Option<&'a dyn OutputDecoding>,
	writers:  Vec<fs::File>,
	set:      Vec<Relay>,
}

impl<'a> Relays<'a> {
	pub(crate) fn new(decoding: Option<&'a dyn OutputDecoding>) -> Self {
		Self { decoding, writers: Vec::new(), set: Vec::new() }
	}

	/// Set up a relay into `sink`, decoding only explicitly designated text
	/// sinks. Returns the OS handle the program writes to.
	pub(crate) fn attach(&mut self, sink: End, text: bool) -> io::Result<OsHandle> {
		let (pipe, writer) = os::pipe(false)?;
		self.set.push(Relay::new(
			pipe,
			self
				.decoding
				.filter(|_| text)
				.map(|decoding| decoding.decoder()),
			sink,
		));
		let os = writer_handle(&writer);
		self.writers.push(writer);
		Ok(os)
	}

	/// The spawned `child`, reporting its exit once the relays drained.
	pub(crate) fn wrap(self, child: Box<dyn ExtProc>) -> Box<dyn ExtProc> {
		if self.set.is_empty() {
			return child;
		}
		Box::new(Relayed { child, relays: self.set, status: None })
	}
}

/// An external whose output runs through relays, which its `poll_wait`
/// drives: its exit is reported once they have forwarded everything it
/// wrote.
struct Relayed {
	child:  Box<dyn ExtProc>,
	relays: Vec<Relay>,
	status: Option<ExitStatus>,
}

impl ExtProc for Relayed {
	fn pid(&self) -> u32 {
		self.child.pid()
	}

	fn poll_wait(&mut self, cx: &mut Context<'_>) -> Poll<ExitStatus> {
		loop {
			match std::task::ready!(self.poll_event(cx)) {
				ProcEvent::Exited(status) => return Poll::Ready(status),
				ProcEvent::Stopped(_) | ProcEvent::Continued => {},
			}
		}
	}

	fn poll_event(&mut self, cx: &mut Context<'_>) -> Poll<ProcEvent> {
		for relay in &mut self.relays {
			let _ = relay.poll(cx);
		}
		let status = if let Some(status) = self.status {
			status
		} else {
			match std::task::ready!(self.child.poll_event(cx)) {
				ProcEvent::Exited(status) => {
					self.status = Some(status);
					status
				},
				change => return Poll::Ready(change),
			}
		};
		let mut drained = true;
		for relay in &mut self.relays {
			drained &= relay.drained(cx);
		}
		orphan::poll(cx);
		if drained {
			Poll::Ready(ProcEvent::Exited(status))
		} else {
			Poll::Pending
		}
	}

	fn pgid(&self) -> Option<u32> {
		self.child.pgid()
	}

	fn signal(&mut self, sig: Signal) -> io::Result<()> {
		self.child.signal(sig)
	}

	fn stop(&mut self) -> io::Result<()> {
		self.child.stop()
	}

	fn cont(&mut self) -> io::Result<()> {
		self.child.cont()
	}
}

impl Drop for Relayed {
	/// Relays still forwarding (the program runs on, or a process it left
	/// running holds the pipe) go on to the ends of their streams as adopted
	/// work, as the program's output would through a plain pipe.
	fn drop(&mut self) {
		// Usually the stream has ended with the program: its end of file is
		// already readable and the relay finishes here.
		let mut now = Context::from_waker(Waker::noop());
		let open: Vec<Relay> = self
			.relays
			.drain(..)
			.filter_map(|mut r| r.poll(&mut now).is_pending().then_some(r))
			.collect();
		if !open.is_empty() {
			orphan::adopt(Forward(open));
		}
	}
}

#[cfg(all(test, unix))]
mod tests {
	use std::{
		os::{fd::OwnedFd, unix::ffi::OsStrExt},
		path::Path,
		sync::Arc,
		time::Instant,
	};

	use bstr::BString;
	use tokio::{io::AsyncReadExt, net::unix::pipe::Receiver};
	use tokio_util::sync::CancellationToken;

	use super::*;
	use crate::{
		session::{RunOptions, RunStdio, Session, SessionConfig},
		sys::StdFs,
	};

	/// Decodes each byte as Latin-1; `hold` keeps the last byte of every read
	/// back, as a decoder does for a character cut by the read.
	struct Latin1 {
		hold: bool,
	}

	impl OutputDecoding for Latin1 {
		fn decoder(&self) -> Box<dyn ByteDecoder> {
			Box::new(Latin1Decoder { hold: self.hold, held: None })
		}
	}

	struct Latin1Decoder {
		hold: bool,
		held: Option<u8>,
	}

	impl ByteDecoder for Latin1Decoder {
		fn push(&mut self, bytes: &[u8]) -> String {
			let mut text: String = self.held.take().into_iter().map(char::from).collect();
			let body = match bytes.split_last() {
				Some((&last, rest)) if self.hold => {
					self.held = Some(last);
					rest
				},
				_ => bytes,
			};
			text.extend(body.iter().copied().map(char::from));
			text
		}

		fn holds_bytes(&self) -> bool {
			self.held.is_some()
		}

		fn finish(&mut self) -> String {
			self.held.take().map(char::from).into_iter().collect()
		}
	}

	/// An observation-only relay forwards the original read buffer, even
	/// when its host has a decoder configured for other text sinks.
	#[tokio::test]
	async fn raw_relay_preserves_non_utf8_bytes() {
		use std::io::{Read, Seek, Write};

		let mut output = tempfile::tempfile().unwrap();
		let decoding = Latin1 { hold: true };
		let mut relays = Relays::new(Some(&decoding));
		relays
			.attach(
				End::File(Box::new(super::super::StdFile::new(output.try_clone().unwrap()))),
				false,
			)
			.unwrap();
		relays.writers[0].write_all(b"\xff\xc3\0").unwrap();
		relays.writers.clear();
		std::future::poll_fn(|cx| relays.set[0].poll(cx)).await;
		output.rewind().unwrap();
		let mut bytes = Vec::new();
		output.read_to_end(&mut bytes).unwrap();
		assert_eq!(bytes, b"\xff\xc3\0");
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn extra_output_alias_shares_the_text_relay() {
		let out =
			run(&mut session(false), "exec 3>&1; /bin/sh -c 'printf a; printf b >&3; printf c'", true)
				.await;
		assert_eq!(out, b"abc");
	}

	/// Latin-1 `café\n`, as a program writing a legacy code page emits it.
	const LEGACY: &[u8] = b"caf\xe9\n";

	fn session(hold: bool) -> Session {
		session_with(Some(Arc::new(Latin1 { hold })))
	}

	fn session_with(output_decoding: Option<Arc<dyn OutputDecoding>>) -> Session {
		let env = std::env::vars_os()
			.map(|(k, v)| (BString::from(k.as_bytes()), BString::from(v.as_bytes())))
			.collect();
		let cwd = std::env::current_dir().unwrap();
		Session::new(SessionConfig {
			env,
			cwd: BString::from(cwd.as_os_str().as_bytes()),
			fs: Box::new(StdFs::default()),
			vfs: None,
			runtime: tokio::runtime::Handle::current(),
			output_decoding,
		})
		.unwrap()
	}

	/// The bytes `command` writes to stdout and stderr, which share one pipe
	/// read concurrently on the test's own task; `text` makes that pipe a
	/// text capture.
	async fn run(session: &mut Session, command: &str, text: bool) -> Vec<u8> {
		run_timed(session, command, text).await.0
	}

	/// [`run`], and how long the run took (the reader may see the end of the
	/// pipe later, once leftovers holding it are gone).
	async fn run_timed(session: &mut Session, command: &str, text: bool) -> (Vec<u8>, Duration) {
		let (reader, writer) = io::pipe().unwrap();
		let mut reader = Receiver::from_owned_fd(OwnedFd::from(reader)).unwrap();
		let stdio = RunStdio {
			stdin:  Some(std::fs::File::open("/dev/null").unwrap()),
			stderr: Some(std::fs::File::from(OwnedFd::from(writer.try_clone().unwrap()))),
			stdout: Some(std::fs::File::from(OwnedFd::from(writer))),
		};
		let mut options = RunOptions::new(command);
		options.text_capture = text;
		let read = async {
			let mut bytes = Vec::new();
			reader.read_to_end(&mut bytes).await.unwrap();
			bytes
		};
		let run = async {
			let started = Instant::now();
			session
				.run_with(options, stdio, CancellationToken::new())
				.await
				.unwrap();
			started.elapsed()
		};
		tokio::join!(read, run)
	}

	fn legacy_file(dir: &Path) -> String {
		let path = dir.join("legacy.txt");
		std::fs::write(&path, LEGACY).unwrap();
		path.display().to_string()
	}

	/// A program's output lands decoded, between what the builtins wrote
	/// before and after it. Fails as mojibake (raw `E9`), or as `b` ahead of
	/// the program's text when its exit is reported before its relay drained.
	#[tokio::test(flavor = "multi_thread")]
	async fn program_output_is_decoded_in_order() {
		let dir = tempfile::tempdir().unwrap();
		let file = legacy_file(dir.path());
		let out =
			run(&mut session(false), &format!("printf 'a\\n'; /bin/cat {file}; printf 'b\\n'"), true)
				.await;
		assert_eq!(out, "a\ncafé\nb\n".as_bytes());
	}

	/// Output into a pipe that is not a text capture keeps its bytes.
	#[tokio::test(flavor = "multi_thread")]
	async fn output_outside_a_text_capture_stays_raw() {
		let dir = tempfile::tempdir().unwrap();
		let file = legacy_file(dir.path());
		let out = run(&mut session(false), &format!("/bin/cat {file}"), false).await;
		assert_eq!(out, LEGACY);
	}

	/// Pipeline pipes and files carry a program's bytes: `wc` counts the one
	/// raw byte of `é`, and the redirected file holds it.
	#[tokio::test(flavor = "multi_thread")]
	async fn pipes_and_files_keep_program_bytes() {
		let dir = tempfile::tempdir().unwrap();
		let file = legacy_file(dir.path());
		let copy = dir.path().join("copy.txt");
		let out = run(
			&mut session(false),
			&format!(
				"/bin/cat {file} | /usr/bin/wc -c | /usr/bin/tr -d ' \\n'; /bin/cat {file} > {}",
				copy.display()
			),
			true,
		)
		.await;
		assert_eq!(out, b"5");
		assert_eq!(std::fs::read(copy).unwrap(), LEGACY);
	}

	/// A command substitution takes a program's output as shell text, whatever
	/// reads the run's output: `é` is two bytes there, one in the raw file.
	#[tokio::test(flavor = "multi_thread")]
	async fn command_substitution_takes_decoded_text() {
		let dir = tempfile::tempdir().unwrap();
		let file = legacy_file(dir.path());
		let out = run(
			&mut session(false),
			&format!("printf %s \"$(/bin/cat {file})\" | /usr/bin/wc -c | /usr/bin/tr -d ' \\n'"),
			false,
		)
		.await;
		assert_eq!(out, b"5");
	}

	/// A program's stdout and stderr share one relay, so their interleaving
	/// is the order it wrote them in.
	#[tokio::test(flavor = "multi_thread")]
	async fn stdout_and_stderr_keep_their_order() {
		let script = "echo a; echo b >&2; echo c; echo d >&2; echo e";
		let out = run(&mut session(false), &format!("/bin/sh -c '{script}'"), true).await;
		assert_eq!(out, b"a\nb\nc\nd\ne\n");
	}

	/// A character the program ended inside is released at the end of its
	/// stream, ahead of the next command's output.
	#[tokio::test(flavor = "multi_thread")]
	async fn held_bytes_are_flushed_before_the_next_command() {
		let out = run(&mut session(true), "/bin/sh -c 'printf abc'; printf X", true).await;
		assert_eq!(out, b"abcX");
	}

	/// A leftover keeps the pipe open while the decoder holds the character
	/// the program ended inside: the exit is reported after the short hold
	/// grace (a timer wakes the drain, nothing else would), and the held byte
	/// is released at the end of the stream, when the leftover is gone, by the
	/// relay that outlived the program's `ExtProc`.
	#[tokio::test(flavor = "current_thread")]
	async fn held_bytes_wait_for_the_end_of_a_stream_a_leftover_holds() {
		let (out, took) =
			run_timed(&mut session(true), "/bin/sh -c 'printf abc; /bin/sleep 1 &'; printf X", true)
				.await;
		assert_eq!(out, b"abXc");
		assert!(took < Duration::from_millis(800), "waited for the leftover: {took:?}");
	}

	/// What a process the program left running writes after the program's
	/// exit was reported (and its `ExtProc` dropped) still reaches the
	/// capture, through the relay adopted on the session's runtime, as it
	/// would through a plain pipe.
	#[tokio::test(flavor = "current_thread")]
	async fn late_output_of_a_leftover_reaches_the_capture() {
		let (out, took) = run_timed(
			&mut session(false),
			"/bin/sh -c 'echo early; (/bin/sleep 0.5; echo late) &'; echo done",
			true,
		)
		.await;
		assert_eq!(out, b"early\ndone\nlate\n");
		assert!(took < Duration::from_millis(400), "waited for the leftover: {took:?}");
	}

	/// Relays, input feeds and output pumps are polled by their externals'
	/// `ExtProc`s on the session's task. On a current-thread runtime, which
	/// also runs the reader of the capture, a command substitution's output
	/// (relayed) goes back through an engine pipe into a program whose output
	/// is relayed into the capture: every byte arrives in order, the full
	/// pipes on the way never blocking the one thread.
	#[tokio::test(flavor = "current_thread")]
	async fn relays_and_pumps_run_on_a_current_thread_runtime() {
		let script = "big=$(/usr/bin/yes 0123456789 | /usr/bin/head -n 20000); printf '%s\\n' \
		              \"$big\" | /bin/cat";
		let (out, _) = tokio::time::timeout(
			Duration::from_secs(20),
			run_timed(&mut session(false), script, true),
		)
		.await
		.expect("nothing blocks the runtime's only thread");
		assert_eq!(out, "0123456789\n".repeat(20_000).into_bytes());
	}

	/// A procsub handed to externals that exit without reading it, also as
	/// fd 0 and fd 4 at once: each external's feed moves bytes from the
	/// engine pipe into its OS pipe (more than the OS pipe holds, so some wait
	/// in the feed), and its drop gives them back, OS pipe first, ahead of the
	/// rest. The last reader gets every byte once, in order, while the
	/// substitution still writes.
	#[tokio::test(flavor = "current_thread")]
	async fn procsub_bytes_a_feed_took_go_back_once_in_order() {
		let script = "exec 4< <(/usr/bin/yes 0123456789 | /usr/bin/head -n 30000)\n/bin/sh -c : \
		              <&4\n/bin/sh -c 'exit 0'\nx=$(/bin/cat <&4)\ny=$(/usr/bin/yes 0123456789 | \
		              /usr/bin/head -n 30000)\n[ \"$x\" = \"$y\" ] && echo same || echo \"differ \
		              ${#x} ${#y}\"";
		let (out, _) = tokio::time::timeout(
			Duration::from_secs(20),
			run_timed(&mut session_with(None), script, false),
		)
		.await
		.expect("the feeds never block the runtime's only thread");
		assert_eq!(String::from_utf8_lossy(&out), "same\n");
	}

	/// A process the program left running keeps the relay's pipe open: the
	/// program's exit is still reported at once, with its output.
	#[tokio::test(flavor = "multi_thread")]
	async fn exit_is_reported_while_a_leftover_holds_the_pipe() {
		let (out, took) =
			run_timed(&mut session(false), "/bin/sh -c 'echo hi; /bin/sleep 2 &'; echo done", true)
				.await;
		assert_eq!(out, b"hi\ndone\n");
		assert!(took < Duration::from_secs(1), "waited for the leftover: {took:?}");
	}
}
