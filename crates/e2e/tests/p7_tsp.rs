//! Executable P7 proof for native Tern surfaces (ADR 0041 phases 1 to 3).
//!
//! Every case runs the real `omp chat` on a real PTY whose master side is a
//! scripted fake Tern: it answers (or withholds) the `hello` query, applies
//! every frame with the reference applier in [`omp_tui::tsp::doc`], and
//! acknowledges frames on demand. The document that applier builds is the
//! oracle — a presenter is correct when the document its frames produce is
//! the one it meant.

#![cfg(unix)]

use std::{
	fs,
	io::Read as _,
	os::fd::{self, AsFd as _},
	path::{Path, PathBuf},
	process::{Child, Command, Stdio},
	thread,
	time::{Duration, Instant},
};

use nix::{
	errno::Errno,
	fcntl::{FcntlArg, OFlag, fcntl},
	poll::{PollFd, PollFlags, PollTimeout, poll},
	pty::{Winsize, openpty},
	sys::termios::{LocalFlags, Termios, tcgetattr},
	unistd::ttyname,
};
use omp_core::Str;
use omp_tui::tsp::{
	doc::{Document, Rejected},
	frame::{self, Incoming},
	wire::{Close, Event, Frame, Hello, Kind, Mode, Node, Open, Query, Reply},
};
use serde_json::Value;

/// How long a case waits for one expected observation.
const CHECKPOINT: Duration = Duration::from_secs(20);
/// How long a case waits before concluding nothing more will arrive. It must
/// outlast the host's one-second optimistic window plus process startup.
const QUIET: Duration = Duration::from_secs(6);
/// Surface id the chat presenter opens (`omp_chat::tsp::SURFACE_ID`).
const SURFACE: &str = "omp-chat";
/// Surface id the presenter opens for a full-screen panel
/// (`omp_chat::tsp::COVER_ID`).
const COVER: &str = "omp-screen";
/// The DA1 answer a terminal that does not speak TSP gives.
const DA1_REPLY: &[u8] = b"\x1b[?62;4c";
/// The DA1 request that fences the startup probe.
const DA1_QUERY: &[u8] = b"\x1b[c";
/// How long the chat waits for a `hello` before retiring an optimistic
/// surface (`omp_chat::host::OPTIMISTIC_WINDOW`).
const OPTIMISTIC_WINDOW: Duration = Duration::from_secs(1);
/// A reaction that happens this fast is the host handling an answer, not a
/// one-second timer expiring.
const PROMPT: Duration = Duration::from_millis(400);
/// User `config.cfg` every sandbox starts with. The startup update check
/// makes a network request and, when a newer release exists, posts an
/// "Update Available" notice into the transcript at a time the proof does
/// not control; that extra block changed frame counts and could delay quit.
/// It must be `config.cfg`, which loads before the check is scheduled.
const HERMETIC_CONFIG: &str = "cl_startup_check_update 0\n";

/// One decoded program → terminal TSP message.
#[derive(Clone, Debug)]
enum Outgoing {
	/// `o`: open or adopt.
	Open(Open),
	/// `f`: a frame of ops.
	Frame(Frame),
	/// `x`: close.
	Close(Close),
	/// A verb this proof does not model (`q`, `b`, ...).
	Other,
}

/// The scripted fake Tern driving one chat process.
struct FakeTern {
	child:            Child,
	master:           fd::OwnedFd,
	slave:            fd::OwnedFd,
	before:           Termios,
	raw:              Vec<u8>,
	scanned:          usize,
	doc:              Document,
	/// The `screen` surface covering the session, while one is open.
	screen:           Option<Document>,
	messages:         Vec<Outgoing>,
	rejected:         Vec<Rejected>,
	queries:          usize,
	/// The program features the `hello` query announced.
	program_features: Vec<String>,
	acked:            u64,
	screen_acked:     u64,
	/// When the `hello` reply goes out.
	hello:            HelloTiming,
	/// How many `hello` queries have been answered.
	hello_replies:    usize,
	/// Whether to answer DA1, and how late.
	da1:              Option<Duration>,
	/// Whether every applied frame is acknowledged.
	ack:              bool,
	/// When the DA1 request was first seen.
	fenced:           Option<Instant>,
	sent_da1:         bool,
	/// Whether the first frame arrived before this terminal answered
	/// anything: the optimistic start the ADR requires.
	optimistic_start: bool,
	/// When the first frame arrived.
	first_frame_at:   Option<Instant>,
	/// When the DA1 answer was sent.
	da1_at:           Option<Instant>,
	/// When the first close arrived.
	first_close_at:   Option<Instant>,
}

/// When the fake terminal answers the `hello` query.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum HelloTiming {
	/// Never: the chat has to time its optimistic window out.
	Never,
	/// As soon as the query is read, so the reply beats the DA1 fence and
	/// the startup probe negotiates it (`ProbeResults::tsp`).
	BeforeFence,
	/// Only once the optimistic first frame has arrived, which is what makes
	/// that frame optimistic.
	AfterFirstFrame,
}

/// What a case asks the fake terminal to pretend to be.
struct Script {
	/// Extra environment for the chat process.
	env:   Vec<(&'static str, String)>,
	/// When the `hello` reply is sent.
	hello: HelloTiming,
	/// Delay after the DA1 request before the DA1 answer; `None` never
	/// answers.
	da1:   Option<Duration>,
	/// Whether frames are acknowledged as they are applied.
	ack:   bool,
}

impl Script {
	/// A Tern that answers the handshake only after the optimistic first
	/// frame has arrived, and acknowledges every frame.
	///
	/// Answering before that would make the reply beat the DA1 fence, which
	/// is the negotiated path, not the optimistic one.
	fn tern() -> Self {
		Self {
			env:   vec![("TERM_PROGRAM", "tern".to_owned())],
			hello: HelloTiming::AfterFirstFrame,
			da1:   Some(Duration::from_millis(30)),
			ack:   true,
		}
	}

	/// A Tern whose `hello` beats the DA1 fence: the negotiated path.
	fn negotiated_tern() -> Self {
		Self { hello: HelloTiming::BeforeFence, ..Self::tern() }
	}

	/// A Tern that never answers anything: the optimistic window expires.
	fn silent_tern() -> Self {
		Self { hello: HelloTiming::Never, da1: None, ..Self::tern() }
	}

	/// A terminal that answers DA1 and does not speak TSP.
	const fn plain() -> Self {
		Self {
			env:   Vec::new(),
			hello: HelloTiming::Never,
			da1:   Some(Duration::ZERO),
			ack:   false,
		}
	}

	/// Tern reached through a multiplexer, which swallows APC strings.
	fn tern_in_tmux() -> Self {
		let mut script = Self::tern();
		script.env.push(("TMUX", "/tmp/fake-tmux,1,0".to_owned()));
		script
	}

	/// Tern with the single opt-out set.
	fn tern_opted_out() -> Self {
		let mut script = Self::tern();
		script.env.push(("OMP_TSP", "0".to_owned()));
		script
	}

	/// Adds one environment variable.
	fn with_env(mut self, key: &'static str, value: &str) -> Self {
		self.env.push((key, value.to_owned()));
		self
	}

	/// Withholds every acknowledgement, so flow control blocks frames.
	const fn without_acks(mut self) -> Self {
		self.ack = false;
		self
	}
}

/// Finds the Cargo-built `omp` binary and the scratch roots one case uses.
struct Sandbox {
	_scratch: tempfile::TempDir,
	project:  PathBuf,
	home:     PathBuf,
}

impl Sandbox {
	/// Creates an isolated project and omp root tree whose user config turns
	/// off the startup update check ([`HERMETIC_CONFIG`]).
	fn new() -> Self {
		let scratch = tempfile::tempdir().expect("scratch root");
		let project = scratch.path().join("project");
		fs::create_dir(&project).expect("project directory");
		let project = fs::canonicalize(&project).expect("canonical project root");
		let home = scratch.path().join("home");
		fs::create_dir(&home).expect("isolated home");
		let sandbox = Self { _scratch: scratch, project, home };
		let config = sandbox.config_dir();
		fs::create_dir_all(&config).expect("config directory");
		fs::write(config.join("config.cfg"), HERMETIC_CONFIG).expect("hermetic config");
		sandbox
	}

	/// `OMP_CONFIG_DIR` for the spawned chat.
	fn config_dir(&self) -> PathBuf {
		self.home.join(omp_core::dirs::CONFIG_DIR_NAME)
	}
}

impl FakeTern {
	/// Spawns `omp chat` on a fresh PTY driven by `script`.
	fn spawn(sandbox: &Sandbox, script: &Script) -> Self {
		omp_e2e::support::install_omp_binary_env().expect("install Cargo-built omp binary");
		let binary = omp_e2e::support::omp_binary().expect("locate omp binary");
		let window = Winsize { ws_row: 40, ws_col: 110, ws_xpixel: 0, ws_ypixel: 0 };
		let pty = openpty(Some(&window), None).expect("open PTY");
		let device = ttyname(&pty.slave).expect("PTY slave path");
		let before = tcgetattr(&pty.slave).expect("initial PTY termios");
		fcntl(&pty.master, FcntlArg::F_SETFL(OFlag::O_NONBLOCK)).expect("nonblocking PTY master");
		let mut command = Command::new(&binary);
		command
			.args(["chat", "--no-ext", "--no-tools", "--envd-idle-timeout", "2"])
			.arg("--project")
			.arg(&sandbox.project)
			.current_dir(&sandbox.project)
			.env("TERM", "xterm-256color")
			.env("NO_COLOR", "1")
			.env("HOME", &sandbox.home)
			.env("OMP_CONFIG_DIR", sandbox.config_dir())
			.env("OMP_DATA_DIR", sandbox.home.join("data"))
			.env("OMP_STATE_DIR", sandbox.home.join("state"))
			.env("OMP_CACHE_DIR", sandbox.home.join("cache"))
			.env("OMP_TTY", &device)
			.env("OMP_TUI_CHARSET", "unicode")
			.env_remove("OMP_LOG")
			.env_remove("TERM_PROGRAM")
			.env_remove("TMUX")
			.env_remove("OMP_TSP")
			.env_remove("OMP_TSP_RECORD")
			.stdout(Stdio::piped())
			.stderr(Stdio::piped());
		for (key, value) in &script.env {
			command.env(key, value);
		}
		let child = command.spawn().expect("spawn omp chat");
		Self {
			child,
			master: pty.master,
			slave: pty.slave,
			before,
			raw: Vec::new(),
			scanned: 0,
			doc: Document::new(SURFACE),
			screen: None,
			messages: Vec::new(),
			rejected: Vec::new(),
			queries: 0,
			program_features: Vec::new(),
			acked: 0,
			screen_acked: 0,
			hello: script.hello,
			hello_replies: 0,
			da1: script.da1,
			ack: script.ack,
			fenced: None,
			sent_da1: false,
			optimistic_start: false,
			first_frame_at: None,
			da1_at: None,
			first_close_at: None,
		}
	}

	/// Reads whatever the chat has written, decodes complete TSP messages,
	/// applies frames to the oracle document, and answers as the script says.
	fn pump(&mut self) {
		let mut buffer = [0_u8; 16 * 1024];
		let mut ready = [PollFd::new(self.master.as_fd(), PollFlags::POLLIN)];
		match poll(&mut ready, PollTimeout::from(20_u16)) {
			Ok(_) | Err(Errno::EINTR) => {},
			Err(error) => panic!("PTY poll failed: {error}"),
		}
		loop {
			match nix::unistd::read(&self.master, &mut buffer) {
				Ok(0) => break,
				Ok(count) => self.raw.extend_from_slice(&buffer[..count]),
				Err(Errno::EAGAIN | Errno::EIO) => break,
				Err(Errno::EINTR) => {},
				Err(error) => panic!("PTY read failed: {error}"),
			}
		}
		self.decode();
		self.answer();
	}

	/// Decodes every complete APC string added since the last call.
	fn decode(&mut self) {
		while let Some(start) = find(&self.raw, self.scanned, b"\x1b_") {
			let Some(end) = find(&self.raw, start + 2, b"\x1b\\") else {
				return;
			};
			self.scanned = end + 2;
			let payload = self.raw[start + 2..end].to_vec();
			let Some(raw) = frame::split(&payload) else {
				continue;
			};
			let message = match raw.verb {
				"q" => {
					self.queries += 1;
					if let Ok(Query::Hello { features, .. }) = serde_json::from_slice(raw.body) {
						self.program_features = features
							.iter()
							.map(|feature| feature.as_str().to_owned())
							.collect();
					}
					Outgoing::Other
				},
				"o" => {
					let open: Open = serde_json::from_slice(raw.body).expect("open body");
					if open.mode == Mode::Screen {
						self.screen = Some(Document::open(&open));
					}
					Outgoing::Open(open)
				},
				"f" => {
					let frame: Frame = serde_json::from_slice(raw.body).expect("frame body");
					if self.first_frame_at.is_none() {
						self.first_frame_at = Some(Instant::now());
						self.optimistic_start = self.hello_replies == 0 && !self.sent_da1;
					}
					let target = if frame.sf.as_str() == SURFACE {
						Some(&mut self.doc)
					} else {
						self
							.screen
							.as_mut()
							.filter(|screen| screen.surface() == &frame.sf)
					};
					let target =
						target.unwrap_or_else(|| panic!("a frame for {}, which is not open", frame.sf));
					self.rejected.extend(target.apply(&frame));
					Outgoing::Frame(frame)
				},
				"x" => {
					let close: Close = serde_json::from_slice(raw.body).expect("close body");
					if self.first_close_at.is_none() {
						self.first_close_at = Some(Instant::now());
					}
					if close.id.as_str() == SURFACE {
						self.doc.close(close.keep);
					} else if let Some(screen) = self.screen.as_mut() {
						screen.close(close.keep);
						self.screen = None;
					}
					Outgoing::Close(close)
				},
				_ => Outgoing::Other,
			};
			self.messages.push(message);
		}
		if self.fenced.is_none() && find(&self.raw, 0, DA1_QUERY).is_some() {
			self.fenced = Some(Instant::now());
		}
	}

	/// Sends the replies and acknowledgements the script owes.
	fn answer(&mut self) {
		if self.hello_replies < self.queries && self.hello_due() {
			let hello = serde_json::to_vec(&Reply::Hello(tern_hello())).expect("hello reply");
			self.write_apc(b"r", &hello);
			self.hello_replies = self.queries;
		}
		// A DA1 answer that reaches the probe without a `hello` in front of
		// it is what retires an optimistic surface, so a Tern that answers
		// late must answer DA1 later still.
		let da1_blocked = self.hello != HelloTiming::Never && self.hello_replies == 0;
		if let Some(fenced) = self.fenced
			&& let Some(delay) = self.da1
			&& !self.sent_da1
			&& !da1_blocked
			&& fenced.elapsed() >= delay
		{
			self.write(DA1_REPLY);
			self.sent_da1 = true;
			self.da1_at = Some(Instant::now());
		}
		if self.ack {
			let highest = self.highest_frame();
			if highest > self.acked {
				self.acked = highest;
				let event = format!(r#"{{"ev":"ack","sf":"{SURFACE}","s":{highest}}}"#);
				self.write_apc(b"e", event.as_bytes());
			}
			let screen = self.highest_screen_frame();
			if screen > self.screen_acked {
				self.screen_acked = screen;
				let event = format!(r#"{{"ev":"ack","sf":"{COVER}","s":{screen}}}"#);
				self.write_apc(b"e", event.as_bytes());
			}
		}
	}

	/// Whether the scripted moment to answer `hello` has arrived.
	fn hello_due(&self) -> bool {
		match self.hello {
			HelloTiming::Never => false,
			// Before the fence: the probe is still reading, so the reply
			// lands in `ProbeResults::tsp`.
			HelloTiming::BeforeFence => true,
			HelloTiming::AfterFirstFrame => !self.frames().is_empty(),
		}
	}

	/// Writes one APC-framed terminal → program message.
	fn write_apc(&self, verb: &[u8], body: &[u8]) {
		let mut out = Vec::with_capacity(body.len() + 16);
		out.extend_from_slice(b"\x1b_tsp;");
		out.extend_from_slice(verb);
		out.push(b';');
		out.extend_from_slice(body);
		out.extend_from_slice(b"\x1b\\");
		self.write(&out);
	}

	/// Writes raw bytes to the chat's input.
	fn write(&self, bytes: &[u8]) {
		let mut written = 0;
		while written < bytes.len() {
			match nix::unistd::write(self.master.as_fd(), &bytes[written..]) {
				Ok(count) => written += count,
				Err(Errno::EAGAIN | Errno::EINTR) => thread::sleep(Duration::from_millis(5)),
				Err(error) => panic!("PTY write failed: {error}"),
			}
		}
	}

	/// Writes one terminal → program event.
	fn event(&self, event: &Event) {
		self.write_apc(b"e", &serde_json::to_vec(event).expect("event body"));
	}

	/// Pumps until `ready` holds, or fails with the whole conversation.
	fn until(&mut self, label: &str, mut ready: impl FnMut(&Self) -> bool) {
		let deadline = Instant::now() + CHECKPOINT;
		while Instant::now() < deadline {
			self.pump();
			if ready(self) {
				return;
			}
			if let Some(status) = self.child.try_wait().expect("poll chat") {
				self.pump();
				if ready(self) {
					return;
				}
				panic!("chat exited ({status}) before {label:?}\n{}", self.report());
			}
		}
		panic!("timed out waiting for {label:?}\n{}", self.report());
	}

	/// Pumps for `duration` without expecting anything.
	fn settle(&mut self, duration: Duration) {
		let deadline = Instant::now() + duration;
		while Instant::now() < deadline {
			self.pump();
		}
	}

	/// Every `open` the chat sent.
	fn opens(&self) -> Vec<&Open> {
		self
			.messages
			.iter()
			.filter_map(|message| match message {
				Outgoing::Open(open) => Some(open),
				_ => None,
			})
			.collect()
	}

	/// Every `close` the chat sent.
	fn closes(&self) -> Vec<&Close> {
		self
			.messages
			.iter()
			.filter_map(|message| match message {
				Outgoing::Close(close) => Some(close),
				_ => None,
			})
			.collect()
	}

	/// Every frame the chat sent.
	fn frames(&self) -> Vec<&Frame> {
		self
			.messages
			.iter()
			.filter_map(|message| match message {
				Outgoing::Frame(frame) => Some(frame),
				_ => None,
			})
			.collect()
	}

	/// The highest frame sequence number seen.
	fn highest_frame(&self) -> u64 {
		self
			.frames()
			.iter()
			.filter(|frame| frame.sf.as_str() == SURFACE)
			.map(|frame| frame.s)
			.max()
			.unwrap_or_default()
	}

	/// The highest sequence number seen on the screen surface.
	fn highest_screen_frame(&self) -> u64 {
		self
			.frames()
			.iter()
			.filter(|frame| frame.sf.as_str() == COVER)
			.map(|frame| frame.s)
			.max()
			.unwrap_or_default()
	}

	/// Frames sent but not yet acknowledged.
	fn unacknowledged(&self) -> u64 {
		self.highest_frame().saturating_sub(self.acked)
	}

	/// When the first frame, the DA1 answer, and the first close happened.
	const fn timeline(&self) -> (Option<Instant>, Option<Instant>, Option<Instant>) {
		(self.first_frame_at, self.da1_at, self.first_close_at)
	}

	/// A readable dump of the whole conversation for a failure message.
	fn report(&self) -> String {
		use std::fmt::Write as _;

		let mut out = String::new();
		for message in &self.messages {
			match message {
				Outgoing::Open(open) => {
					let _ = writeln!(out, "open   {open:?}");
				},
				Outgoing::Frame(frame) => {
					let _ = writeln!(out, "frame  s={} {:?}", frame.s, frame.ops);
				},
				Outgoing::Close(close) => {
					let _ = writeln!(out, "close  {close:?}");
				},
				Outgoing::Other => {},
			}
		}
		let _ = writeln!(out, "queries={} acked={}", self.queries, self.acked);
		let _ = writeln!(out, "rejected={:?}", self.rejected);
		let _ = writeln!(out, "raw={}", visible(&self.raw));
		out
	}

	/// Quits the chat with the two-press `C-c` and returns the exit evidence.
	fn quit(self) -> Quit {
		self.write(b"\x03\x03");
		self.exit()
	}

	/// Waits for the chat to exit and returns the exit evidence: a clean
	/// status and a restored terminal.
	fn exit(mut self) -> Quit {
		let deadline = Instant::now() + CHECKPOINT;
		let status = loop {
			self.pump();
			if let Some(status) = self.child.try_wait().expect("poll chat") {
				break status;
			}
			assert!(Instant::now() < deadline, "chat did not quit\n{}", self.report());
		};
		self.settle(Duration::from_millis(300));
		let mut stdout = String::new();
		let mut stderr = String::new();
		if let Some(mut pipe) = self.child.stdout.take() {
			pipe.read_to_string(&mut stdout).expect("read chat stdout");
		}
		if let Some(mut pipe) = self.child.stderr.take() {
			pipe.read_to_string(&mut stderr).expect("read chat stderr");
		}
		let after = tcgetattr(&self.slave).expect("final PTY termios");
		assert!(
			status.success(),
			"chat exited {status}\nstdout={stdout}\nstderr={stderr}\n{}",
			self.report()
		);
		assert_restored(&self.before, &after, &self.raw);
		Quit { closes: self.closes().into_iter().cloned().collect(), doc: self.doc.clone() }
	}
}

/// What a clean quit left behind.
struct Quit {
	/// Every `close` the chat sent, in order.
	closes: Vec<Close>,
	/// The oracle document after the close was applied.
	doc:    Document,
}

impl Drop for FakeTern {
	fn drop(&mut self) {
		if matches!(self.child.try_wait(), Ok(None)) {
			let _ = self.child.kill();
			let _ = self.child.wait();
		}
	}
}

/// The capability reply a Tern that draws every v1 kind sends.
fn tern_hello() -> Hello {
	Hello {
		v:             1,
		term:          Str::new_static("tern"),
		ver:           Some(Str::new_static("1.0-fake")),
		kinds:         [
			"col", "row", "card", "section", "md", "text", "rows", "editor", "tool", "el",
		]
		.into_iter()
		.map(Str::new_static)
		.collect(),
		features:      ["settle", "adopt", "dock", "flow"]
			.into_iter()
			.map(Str::new_static)
			.collect(),
		apc:           Some(65_536),
		credits:       Some(2),
		cols:          Some(110),
		cell:          None,
		dark:          Some(true),
		reduce_motion: Some(false),
		hour12:        Some(false),
	}
}

/// The first index at or after `from` where `needle` occurs.
fn find(haystack: &[u8], from: usize, needle: &[u8]) -> Option<usize> {
	if from >= haystack.len() {
		return None;
	}
	haystack[from..]
		.windows(needle.len())
		.position(|window| window == needle)
		.map(|at| at + from)
}

/// A printable rendering of the byte stream, bounded for failure messages.
fn visible(bytes: &[u8]) -> String {
	use std::fmt::Write as _;

	let mut out = String::new();
	for &byte in &bytes[bytes.len().saturating_sub(16 * 1024)..] {
		match byte {
			b'\n' => out.push('\n'),
			0x20..=0x7e => out.push(char::from(byte)),
			_ => {
				let _ = write!(out, "\\x{byte:02x}");
			},
		}
	}
	out
}

/// The terminal modes and termios a clean quit must restore.
fn assert_restored(before: &Termios, after: &Termios, raw: &[u8]) {
	let hide = raw.windows(6).rposition(|window| window == b"\x1b[?25l");
	let show = raw.windows(6).rposition(|window| window == b"\x1b[?25h");
	assert!(
		show.is_some() && hide.is_none_or(|hidden| show > Some(hidden)),
		"cursor was not restored; hide={hide:?} show={show:?}"
	);
	for mode in [1000, 1002, 1003, 1006] {
		let enable = format!("\x1b[?{mode}h");
		let disable = format!("\x1b[?{mode}l");
		let enabled = raw
			.windows(enable.len())
			.rposition(|window| window == enable.as_bytes());
		let disabled = raw
			.windows(disable.len())
			.rposition(|window| window == disable.as_bytes());
		assert!(
			enabled.is_none() || disabled.is_some_and(|exit| Some(exit) > enabled),
			"mouse mode {mode} not restored; enable={enabled:?} disable={disabled:?}"
		);
	}
	assert_eq!(after.input_flags, before.input_flags, "input flags not restored");
	assert_eq!(after.output_flags, before.output_flags, "output flags not restored");
	assert_eq!(after.control_flags, before.control_flags, "control flags not restored");
	// PENDIN is tty state, not a mode: XNU sets it whenever tcsetattr turns
	// ICANON back on and clears it only on the next read.
	assert_eq!(
		after.local_flags - LocalFlags::PENDIN,
		before.local_flags - LocalFlags::PENDIN,
		"local flags not restored"
	);
}

/// The `k` of one node in the oracle document.
fn kind_of(doc: &Document, id: &str) -> Kind {
	doc.get(id).unwrap_or_else(|| panic!("{id} is absent")).k
}

/// One prop of one node in the oracle document.
fn prop(doc: &Document, id: &str, key: &str) -> Option<Value> {
	doc.get(id)?.p.get(key).cloned()
}

/// The composer's text and UTF-16 caret in the oracle document.
fn composer(tern: &FakeTern) -> (String, u64) {
	let text = prop(&tern.doc, "composer", "text").and_then(|text| text.as_str().map(str::to_owned));
	let cursor = prop(&tern.doc, "composer", "cursor").and_then(|cursor| cursor.as_u64());
	(text.unwrap_or_default(), cursor.unwrap_or(u64::MAX))
}

/// An `edit` event over the composer, in UTF-16 offsets.
fn edit(from: u32, to: u32, text: &str, cursor: u32, len: u32) -> Event {
	Event::Edit {
		sf: Str::new_static(SURFACE),
		id: Str::new_static("composer"),
		from,
		to,
		text: Str::new(text),
		cursor,
		len,
	}
}

/// A `send` event addressed to surface `sf` and node `id`.
fn send_to(sf: &str, id: &str, text: &str) -> Event {
	Event::Send { sf: Str::new(sf), id: Str::new(id), text: Str::new(text) }
}

/// A `send` event over the live composer.
fn send(text: &str) -> Event {
	send_to(SURFACE, "composer", text)
}

/// Every `text` prop under `id` in the oracle document, in document order.
fn texts_under(doc: &Document, id: &str) -> Vec<String> {
	fn walk(node: &Node, out: &mut Vec<String>) {
		if let Some(text) = node.p.get("text").and_then(Value::as_str) {
			out.push(text.to_owned());
		}
		node.c.iter().for_each(|child| walk(child, out));
	}
	let mut out = Vec::new();
	if let Some(node) = doc.get(id) {
		walk(&node, &mut out);
	}
	out
}

/// Whether the transcript region holds `text` in some node.
fn transcript_has(tern: &FakeTern, text: &str) -> bool {
	texts_under(&tern.doc, "main")
		.iter()
		.any(|held| held.contains(text))
}

/// The composer's `sendable` prop in the oracle document.
fn sendable(tern: &FakeTern) -> Option<bool> {
	prop(&tern.doc, "composer", "sendable").and_then(|value| value.as_bool())
}

/// The handshake, regions, composer, status band, acks and clean close of a
/// live surface, asserted against the reference document.
#[test]
fn tsp_surface_opens_optimistically_and_builds_the_chat_document() {
	let sandbox = Sandbox::new();
	let mut tern = FakeTern::spawn(&sandbox, &Script::tern());
	// The surface opens and sends its first frame before any reply: that is
	// the optimistic start (ADR 0041 phase 1, decision 1).
	tern.until("optimistic first frame", |tern| !tern.frames().is_empty());
	assert!(
		tern.optimistic_start,
		"the first frame must precede the hello reply:\n{}",
		tern.report()
	);
	assert_eq!(tern.frames()[0].s, 1, "frames are numbered from one:\n{}", tern.report());
	let opens = tern.opens();
	let [open] = opens.as_slice() else {
		panic!("exactly one open in a fresh epoch:\n{}", tern.report());
	};
	assert_eq!(open.id.as_str(), SURFACE);
	assert_eq!(open.mode, omp_tui::tsp::wire::Mode::Inline);
	assert_eq!(open.adopt, None, "a fresh surface is never adopted");
	assert_eq!(open.listen, Some(true));

	tern.until("composer and status mounted", |tern| {
		tern.doc.contains("composer") && tern.doc.contains("status")
	});
	assert!(tern.rejected.is_empty(), "Tern rejected ops: {:?}\n{}", tern.rejected, tern.report());
	for region in ["main", "dock", "layer"] {
		assert_eq!(kind_of(&tern.doc, region), Kind::Col, "{region} is a region column");
	}
	assert_eq!(kind_of(&tern.doc, "composer"), Kind::Editor, "the composer is a native editor");
	assert_eq!(kind_of(&tern.doc, "status"), Kind::Status, "the status band is native status");
	assert!(
		tern
			.doc
			.get("status")
			.is_some_and(|node| node.c.iter().all(|child| child.k == Kind::Seg)),
		"status children are seg nodes"
	);
	assert_eq!(tern.doc.focus(), Some("composer"), "the composer owns focus");
	assert!(
		prop(&tern.doc, "composer", "placeholder").is_some(),
		"the composer carries its placeholder"
	);
	assert!(
		tern
			.doc
			.snapshot()
			.c
			.iter()
			.all(|node| node.p.get("t").is_none()),
		"no node carries a program palette (decision 8)"
	);

	// Typing is still omp's: the keys route through the host, and the host
	// republishes the composer's text and its UTF-16 cursor.
	tern.write("héllo".as_bytes());
	tern.until("composer text mirrored", |tern| {
		prop(&tern.doc, "composer", "text").and_then(|text| text.as_str().map(str::to_owned))
			== Some("héllo".to_owned())
	});
	assert_eq!(
		prop(&tern.doc, "composer", "cursor"),
		Some(Value::from(5_u32)),
		"the cursor is five UTF-16 units after five characters"
	);
	assert!(tern.acked > 0, "the fake Tern acknowledged frames:\n{}", tern.report());

	let quit = tern.quit();
	let [close] = quit.closes.as_slice() else {
		panic!("exactly one close: {:?}", quit.closes);
	};
	assert!(close.keep, "the epoch closes with keep:true so Tern retains `main`");
	assert!(quit.doc.contains("main"), "`main` survives a keep:true close");
	assert!(!quit.doc.contains("dock"), "the live-only dock is dropped");
	assert!(!quit.doc.contains("layer"), "the live-only layer is dropped");
}

/// Flow control: the presenter never has more than `credits` frames in
/// flight, and an `ack` releases the frame it was holding.
#[test]
fn tsp_credits_block_frames_until_an_ack_arrives() {
	let sandbox = Sandbox::new();
	let mut tern = FakeTern::spawn(&sandbox, &Script::tern().without_acks());
	tern.until("surface open", |tern| !tern.opens().is_empty());
	// Keystrokes would each produce a frame; without acks the presenter must
	// stop at the negotiated two.
	tern.write(b"blocked input");
	tern.settle(QUIET);
	let blocked = tern.highest_frame();
	assert!(
		tern.unacknowledged() <= 2,
		"more than two frames were in flight ({blocked} sent, {} acked)\n{}",
		tern.acked,
		tern.report()
	);
	assert!(
		prop(&tern.doc, "composer", "text").and_then(|text| text.as_str().map(str::to_owned))
			!= Some("blocked input".to_owned()),
		"the blocked frames must not have reached the document\n{}",
		tern.report()
	);

	// One ack releases the held frame, and the composer catches up.
	tern.acked = blocked;
	let event = format!(r#"{{"ev":"ack","sf":"{SURFACE}","s":{blocked}}}"#);
	tern.write_apc(b"e", event.as_bytes());
	tern.ack = true;
	tern.until("held frame flushed after the ack", |tern| {
		prop(&tern.doc, "composer", "text").and_then(|text| text.as_str().map(str::to_owned))
			== Some("blocked input".to_owned())
	});
	assert!(tern.highest_frame() > blocked, "the ack released at least one frame");
}

/// The model picker (Alt+M) now has a native TSP picker node (phase 3), so the
/// surface stays live while it is open. A cell-only overlay (e.g. a future
/// overlay without a TSP node) would still suspend — tested separately.
#[test]
fn tsp_overlays_suspend_and_resume_the_surface() {
	let sandbox = Sandbox::new();
	let mut tern = FakeTern::spawn(&sandbox, &Script::tern());
	tern.until("composer mounted", |tern| tern.doc.contains("composer"));
	assert!(!tern.doc.suspended(), "a live surface starts drawing");

	// Alt+M opens the model selector — phase 3 sends a picker node so the
	// surface stays live (not suspended) while the picker is open.
	tern.write(b"\x1bm");
	tern.until("picker node sent to surface", |tern| tern.doc.contains("model-picker"));
	assert!(!tern.doc.suspended(), "surface stays live with native picker");

	tern.write(b"\x1b");
	tern
		.until("surface resumed after the overlay closed", |tern| !tern.doc.contains("model-picker"));
	let quit = tern.quit();
	assert!(quit.closes.iter().all(|close| close.keep), "{:?}", quit.closes);
}

/// A full-screen panel that describes itself natively (the settings form, ADR
/// 0041 phase 3) covers the pane with a `screen` surface while the inline
/// session stays live underneath, and the cover closes with the panel.
#[test]
fn tsp_a_full_screen_panel_covers_the_pane_with_a_screen_surface() {
	let sandbox = Sandbox::new();
	let mut tern = FakeTern::spawn(&sandbox, &Script::tern());
	tern.until("composer mounted", |tern| tern.doc.contains("composer"));

	// `/settings` opens the settings panel. Its native form fills the pane as a
	// screen surface instead of floating in the session layer. A completion popup
	// may take the first Enter, so Enter is repeated until the cover opens.
	tern.write(b"/settings");
	tern.until("command typed", |tern| {
		prop(&tern.doc, "composer", "text")
			.and_then(|text| text.as_str().map(str::to_owned))
			.is_some_and(|text| text.trim_end() == "/settings")
	});
	for _ in 0..4 {
		tern.write(b"\r");
		tern.settle(Duration::from_millis(700));
		if tern.screen.is_some() {
			break;
		}
	}
	tern.until("settings form on a screen surface", |tern| {
		tern
			.screen
			.as_ref()
			.is_some_and(|screen| screen.contains("settings"))
	});
	assert!(!tern.doc.suspended(), "the session stays live under the cover");
	assert!(!tern.doc.contains("settings"), "the form is not in the session layer");
	let covers: Vec<_> = tern
		.opens()
		.into_iter()
		.filter(|open| open.mode == Mode::Screen)
		.collect();
	let [cover] = covers.as_slice() else {
		panic!("one cover opens: {covers:?}\n{}", tern.report());
	};
	assert_eq!(cover.id.as_str(), COVER);
	assert_eq!(cover.listen, Some(true));

	tern.write(b"\x1b");
	tern.until("cover closed with the panel", |tern| tern.screen.is_none());
	let closed: Vec<_> = tern
		.closes()
		.into_iter()
		.filter(|close| close.id.as_str() == COVER)
		.collect();
	let [close] = closed.as_slice() else {
		panic!("one cover closes: {closed:?}\n{}", tern.report());
	};
	assert!(!close.keep, "a screen surface is discarded whatever keep says");
	assert!(!tern.doc.suspended() && tern.doc.contains("composer"), "the session shows again");
	assert!(tern.rejected.is_empty(), "Tern rejected ops: {:?}\n{}", tern.rejected, tern.report());
	tern.quit();
}

/// Native editing (ADR 0041 phase 3): the `hello` query announces `edit` and
/// `undo`, an edit Tern made over its own selection round-trips through UTF-16
/// offsets into the composer, whose text and caret come back in the next
/// frame, and `undo` reverts that edit as one unit.
#[test]
fn tsp_native_edits_round_trip_through_utf16_offsets() {
	let sandbox = Sandbox::new();
	let mut tern = FakeTern::spawn(&sandbox, &Script::tern());
	tern.until("composer mounted", |tern| tern.doc.contains("composer"));
	assert_eq!(
		tern.program_features,
		["edit", "undo", "send"],
		"the hello query announces native editing and sends:\n{}",
		tern.report()
	);

	let typed = "a\u{1f600}b w\u{f6}rld";
	tern.write(typed.as_bytes());
	tern.until("typed text mirrored", |tern| composer(tern) == (typed.to_owned(), 10));

	let edited = "a\u{1f642}\u{1f642}b w\u{f6}rld";
	tern.event(&edit(3, 1, "\u{1f642}\u{1f642}", 1, 10));
	tern.until("two emoji replace units 1..3, sent reversed, with the caret before them", |tern| {
		composer(tern) == (edited.to_owned(), 1)
	});
	tern.event(&edit(12, 12, "", 12, 12));
	tern.until("an empty edit only moves the caret", |tern| {
		composer(tern) == (edited.to_owned(), 12)
	});
	tern.event(&edit(0, 3, "", 0, 3));
	tern.event(&Event::Undo { sf: Str::new_static(SURFACE), id: Str::new_static("composer") });
	tern.until("the stale edit is dropped and one undo restores the typed text and caret", |tern| {
		composer(tern) == (typed.to_owned(), 10)
	});
	assert!(tern.rejected.is_empty(), "Tern rejected ops: {:?}\n{}", tern.rejected, tern.report());
	tern.quit();
}

/// Native sends (ADR 0041 phase 3): a live composer advertises `sendable`; a
/// `send` for it takes the path Enter takes, so a prompt lands in the
/// transcript like a typed one, and a slash command runs. The draft it
/// displaces leaves the editor and comes back through Up. A `send` for a stale
/// surface, an invented node or blank text is ignored, and a modal overlay
/// withdraws `sendable` and swallows the send.
#[test]
fn tsp_native_sends_take_the_path_enter_takes() {
	let sandbox = Sandbox::new();
	let mut tern = FakeTern::spawn(&sandbox, &Script::tern());
	tern.until("composer mounted and ready for a send", |tern| sendable(tern) == Some(true));

	// The reference: a prompt typed and submitted with Enter.
	tern.write(b"typed prompt\r");
	tern.until("the typed prompt reaches the transcript", |tern| {
		transcript_has(tern, "typed prompt")
	});
	tern.until("the submitted draft left the composer", |tern| composer(tern).0.is_empty());

	// Sends that must be ignored, ahead of the one that is not: each is
	// processed in order, so the last send's effect proves the others had
	// their chance.
	tern.write(b"draft in progress");
	tern.until("draft typed", |tern| composer(tern).0 == "draft in progress");
	tern.event(&send_to("omp-elsewhere", "composer", "stale surface"));
	tern.event(&send_to(SURFACE, "status", "wrong node"));
	tern.event(&send_to(SURFACE, "composer-2", "invented node"));
	tern.event(&send("  \r\n\t "));
	tern.event(&send("sent prompt"));
	tern.until("the sent prompt reaches the transcript like the typed one", |tern| {
		transcript_has(tern, "sent prompt")
	});
	tern.until("the displaced draft left the composer", |tern| composer(tern).0.is_empty());
	for ignored in ["stale surface", "wrong node", "invented node"] {
		assert!(
			!transcript_has(&tern, ignored),
			"a send for {ignored:?} was submitted:\n{}",
			tern.report()
		);
	}
	let main = texts_under(&tern.doc, "main");
	let typed = main.iter().position(|text| text.contains("typed prompt"));
	let sent = main.iter().position(|text| text.contains("sent prompt"));
	assert!(typed < sent, "the sent prompt follows the typed one: {main:?}");

	// Up recalls what was sent, then the draft the send displaced.
	tern.write(b"\x1b[A");
	tern.until("the sent prompt is the newest recall", |tern| composer(tern).0 == "sent prompt");
	tern.write(b"\x1b[A");
	tern.until("the displaced draft is recalled next", |tern| {
		composer(tern).0 == "draft in progress"
	});

	// A slash command runs through the same classification as Enter: the
	// settings panel covers the pane. While it is open the composer is no
	// longer sendable, and a send is swallowed.
	tern.event(&send("/settings"));
	tern.until("the sent command opened the settings cover", |tern| {
		tern
			.screen
			.as_ref()
			.is_some_and(|screen| screen.contains("settings"))
	});
	tern.until("the composer withdraws `sendable` under a modal overlay", |tern| {
		sendable(tern) == Some(false)
	});
	tern.event(&send("typed under a modal"));
	tern.settle(Duration::from_millis(700));
	tern.write(b"\x1b");
	tern.until("the cover closed with the panel", |tern| tern.screen.is_none());
	tern.until("the composer is sendable again", |tern| sendable(tern) == Some(true));
	assert!(
		!transcript_has(&tern, "typed under a modal"),
		"a modal overlay took the send:\n{}",
		tern.report()
	);

	// A sent `/exit` quits like a typed one.
	tern.event(&send("/exit"));
	let quit = tern.exit();
	let session: Vec<_> = quit
		.closes
		.iter()
		.filter(|close| close.id.as_str() == SURFACE)
		.collect();
	assert!(
		matches!(session.as_slice(), [close] if close.keep),
		"the session surface closes once, kept: {:?}",
		quit.closes
	);
}

/// Re-entering a terminal epoch adopts the kept surface; a `gone` event makes
/// the next entry open a fresh one.
#[test]
fn tsp_reentry_adopts_and_a_gone_event_reopens() {
	let sandbox = Sandbox::new();
	let mut tern = FakeTern::spawn(&sandbox, &Script::tern());
	tern.until("first surface open", |tern| tern.doc.contains("composer"));

	// Alt+L is `cl_display_reset`: the host leaves the terminal, re-probes,
	// and re-enters — the same lifecycle a suspend or an external editor runs.
	tern.write(b"\x1bl");
	tern.until("surface adopted on re-entry", |tern| {
		tern.opens().len() == 2 && tern.closes().len() == 1
	});
	let opens = tern.opens();
	assert_eq!(opens[1].adopt, Some(true), "the second entry adopts: {:?}", opens[1]);
	assert!(tern.closes()[0].keep, "the first epoch closed with keep:true");

	// Tern dropped the surface: the presenter must mount a fresh one.
	tern.write_apc(
		b"e",
		format!(r#"{{"ev":"gone","sf":"{SURFACE}","ids":["{SURFACE}"]}}"#).as_bytes(),
	);
	tern.until("fresh surface after gone", |tern| tern.opens().len() == 3);
	let opens = tern.opens();
	assert_eq!(opens[2].adopt, None, "a surface Tern dropped is reopened, not adopted");
	tern.until("regions remounted", |tern| {
		tern.doc.contains("main") && tern.doc.contains("dock") && tern.doc.contains("composer")
	});
}

/// The optimistic surface is retired when nothing answers within the
/// one-second window, and the epoch falls back to cells.
#[test]
fn tsp_optimistic_surface_falls_back_when_nothing_answers() {
	let sandbox = Sandbox::new();
	let mut tern = FakeTern::spawn(&sandbox, &Script::silent_tern());
	tern.until("optimistic open", |tern| !tern.opens().is_empty());
	tern.until("optimistic window expires", |tern| !tern.closes().is_empty());
	let closes = tern.closes();
	let [close] = closes.as_slice() else {
		panic!("exactly one close: {}", tern.report());
	};
	assert!(!close.keep, "a terminal that never answered keeps nothing");
	tern.settle(QUIET);
	assert_eq!(tern.opens().len(), 1, "the surface is not reopened:\n{}", tern.report());
	let frames_after_close = tern.frames().len();
	tern.settle(Duration::from_secs(2));
	assert_eq!(
		tern.frames().len(),
		frames_after_close,
		"no frame is sent after the fallback:\n{}",
		tern.report()
	);
	tern.quit();
}

/// Every fallback the ADR names: DA1 answering ahead of a `hello`, a
/// multiplexer, the `OMP_TSP=0` opt-out, and a terminal that is not Tern.
#[test]
fn tsp_fallback_paths_never_open_a_surface() {
	for (label, script, probes) in [
		("plain terminal", Script::plain(), true),
		("tern inside tmux", Script::tern_in_tmux(), false),
		("tern with OMP_TSP=0", Script::tern_opted_out(), false),
	] {
		let sandbox = Sandbox::new();
		let mut tern = FakeTern::spawn(&sandbox, &script);
		// The DA1 request closes the startup probe burst, so every case has
		// reached the point where a `hello` query would already have been
		// written. Waiting for it keeps process startup out of the `QUIET`
		// budget, which a host with slow file operations overruns, and it
		// stops the two suppression cases from passing on a chat that never
		// started.
		tern.until("startup probe reached the terminal", |tern| tern.fenced.is_some());
		tern.settle(QUIET);
		assert!(tern.opens().is_empty(), "{label} opened a surface:\n{}", tern.report());
		assert!(tern.frames().is_empty(), "{label} sent frames:\n{}", tern.report());
		assert_eq!(
			tern.queries > 0,
			probes,
			"{label}: a multiplexer or the opt-out must suppress the probe itself:\n{}",
			tern.report()
		);
		tern.quit();
	}
}

/// A `hello` that beats the DA1 fence negotiates through the startup probe:
/// the surface opens on the announced capabilities, not the optimistic
/// assumption, and is never retired by the one-second window.
#[test]
fn tsp_hello_before_the_fence_negotiates_the_surface() {
	let sandbox = Sandbox::new();
	let mut tern = FakeTern::spawn(&sandbox, &Script::negotiated_tern());
	tern.until("negotiated surface open", |tern| tern.doc.contains("composer"));
	assert!(
		!tern.optimistic_start,
		"a negotiated surface is not an optimistic one:\n{}",
		tern.report()
	);
	assert!(tern.rejected.is_empty(), "rejected ops: {:?}", tern.rejected);
	tern.settle(QUIET);
	assert!(tern.closes().is_empty(), "a negotiated surface is never retired:\n{}", tern.report());
	let quit = tern.quit();
	assert!(quit.closes.iter().all(|close| close.keep), "{:?}", quit.closes);
}

/// A DA1 answer that reaches the host before any `hello` means the terminal
/// does not speak TSP: no surface is opened at all.
#[test]
fn tsp_da1_before_hello_keeps_cell_rendering() {
	let sandbox = Sandbox::new();
	let script = Script { hello: HelloTiming::Never, da1: Some(Duration::ZERO), ..Script::tern() };
	let mut tern = FakeTern::spawn(&sandbox, &script);
	tern.until("startup probe sent", |tern| tern.queries > 0);
	tern.settle(QUIET);
	assert!(
		tern.opens().is_empty(),
		"DA1 answered first, so no surface may open:\n{}",
		tern.report()
	);
	tern.quit();
}

/// A DA1 answer that arrives *after* the optimistic surface already opened
/// retires it promptly: the live reply is the signal, not the timer.
///
/// The timer would also close the surface, so the assertion is on latency —
/// the answer is released as soon as the first frame lands, and the close
/// must follow it far sooner than the remaining window.
#[test]
fn tsp_late_da1_retires_the_optimistic_surface_before_the_window() {
	let sandbox = Sandbox::new();
	// Nothing is answered automatically: the DA1 reply is released by hand
	// once the optimistic frame has arrived.
	let script = Script { hello: HelloTiming::Never, da1: None, ..Script::tern() };
	let mut tern = FakeTern::spawn(&sandbox, &script);
	tern.until("optimistic first frame", |tern| !tern.frames().is_empty());
	assert!(tern.optimistic_start, "the surface opened optimistically:\n{}", tern.report());
	tern.write(DA1_REPLY);
	tern.da1_at = Some(Instant::now());
	tern.sent_da1 = true;
	tern.until("surface retired by the DA1 answer", |tern| !tern.closes().is_empty());
	let (_, da1, close) = tern.timeline();
	let (da1, close) = (da1.expect("the DA1 answer"), close.expect("the close"));
	let latency = close.saturating_duration_since(da1);
	assert!(
		latency < PROMPT,
		"the close came {latency:?} after the DA1 answer, which is the {OPTIMISTIC_WINDOW:?} timer \
		 firing rather than the answer being handled:\n{}",
		tern.report()
	);
	let closes = tern.closes();
	assert!(!closes[0].keep, "a terminal that is not Tern keeps nothing");
	tern.quit();
}

/// The recorder writes both directions of the conversation as the JSONL
/// `surface-play` replays, under either pacing mode and either handshake.
///
/// The negotiated handshake is the interesting half: that `hello` reaches
/// the host through the startup probe, not through the live reader, so a
/// presenter that only records what the reader hands it loses it.
#[test]
fn tsp_recording_captures_both_directions() {
	for (pacing, script) in
		[("raw", Script::tern()), ("paced", Script::tern()), ("raw", Script::negotiated_tern())]
	{
		let negotiated = script.hello == HelloTiming::BeforeFence;
		let label = format!(
			"{pacing}/{}",
			if negotiated {
				"negotiated"
			} else {
				"optimistic"
			}
		);
		let sandbox = Sandbox::new();
		fs::write(
			sandbox.config_dir().join("config.cfg"),
			format!("{HERMETIC_CONFIG}tsp_stream_pacing {pacing}\n"),
		)
		.expect("write pacing convar");
		let recording = sandbox.home.join(format!("{pacing}-{negotiated}.jsonl"));
		let script = script.with_env("OMP_TSP_RECORD", &recording.display().to_string());
		let mut tern = FakeTern::spawn(&sandbox, &script);
		tern.until("composer mounted", |tern| tern.doc.contains("composer"));
		tern.write(b"recorded prompt");
		tern.until("typed text mirrored", |tern| {
			prop(&tern.doc, "composer", "text").and_then(|text| text.as_str().map(str::to_owned))
				== Some("recorded prompt".to_owned())
		});
		tern.quit();

		let text = fs::read_to_string(&recording)
			.unwrap_or_else(|error| panic!("read {label} recording: {error}"));
		let lines: Vec<Value> = text
			.lines()
			.map(|line| serde_json::from_str(line).expect("recorded JSONL line"))
			.collect();
		assert!(!lines.is_empty(), "the {label} recording is empty");
		let verb = |dir: &str, verb: &str| {
			lines.iter().any(|line| {
				line.get("dir").and_then(Value::as_str) == Some(dir)
					&& line.get("verb").and_then(Value::as_str) == Some(verb)
			})
		};
		assert!(verb("out", "o"), "{label}: the open is recorded");
		assert!(verb("out", "f"), "{label}: frames are recorded");
		assert!(verb("out", "x"), "{label}: the close is recorded");
		assert!(verb("in", "r"), "{label}: the hello reply is recorded");
		assert!(verb("in", "e"), "{label}: acknowledgements are recorded");
	}
}

/// The reference applier is the oracle, so a frame it rejects is a defect:
/// this walks the whole live document to prove the ids the presenter uses
/// are the ones Tern holds.
#[test]
fn tsp_document_ids_match_the_transcript_blocks() {
	let sandbox = Sandbox::new();
	let mut tern = FakeTern::spawn(&sandbox, &Script::tern());
	tern.until("a finalized transcript block settles", |tern| {
		tern.doc.get("main").is_some_and(|main| {
			main
				.c
				.iter()
				.any(|child| tern.doc.is_settled(child.id.as_str()))
		})
	});
	let main = tern.doc.get("main").expect("the main region");
	for child in &main.c {
		assert!(
			child.id.as_str().starts_with("b-"),
			"transcript node ids derive from BlockView::key: {}",
			child.id
		);
	}
	assert!(tern.rejected.is_empty(), "rejected ops: {:?}", tern.rejected);
	tern.quit();
}

/// A chunked body would be reassembled by Tern; nothing this proof sends is
/// large enough, so the presenter must not chunk a normal frame.
#[test]
fn tsp_normal_frames_are_single_messages() {
	let sandbox = Sandbox::new();
	let mut tern = FakeTern::spawn(&sandbox, &Script::tern());
	tern.until("composer mounted", |tern| tern.doc.contains("composer"));
	let chunked = tern
		.raw
		.windows(3)
		.any(|window| window == b";c=".as_slice());
	assert!(!chunked, "a normal frame was chunked:\n{}", tern.report());
	tern.quit();
	// The config loads leniently, so prove the hermetic line took effect: a
	// startup update check would have created its cache directory.
	assert!(!sandbox.home.join("cache/updates").exists(), "a P7 chat ran the startup update check");
}

/// A live reader proves the chat consumed every APC string: none of them may
/// reach the key path and land in the composer.
#[test]
fn tsp_replies_never_reach_the_composer() {
	let sandbox = Sandbox::new();
	let mut tern = FakeTern::spawn(&sandbox, &Script::tern());
	tern.until("composer mounted", |tern| tern.doc.contains("composer"));
	tern.write_apc(b"e", br#"{"ev":"theme","dark":false}"#);
	tern.write_apc(b"e", format!(r#"{{"ev":"resize","sf":"{SURFACE}","cols":110}}"#).as_bytes());
	tern.settle(Duration::from_secs(2));
	assert_eq!(
		prop(&tern.doc, "composer", "text"),
		Some(Value::from("")),
		"a TSP event leaked into the composer:\n{}",
		tern.report()
	);
	tern.quit();
}

/// Unused import guard: the harness references `Incoming` only through the
/// reader in debug builds of this file.
const _: fn() = || {
	let _ = |incoming: Incoming| match incoming {
		Incoming::Reply(_) | Incoming::Event(_) => {},
	};
	let _: fn(&Path) -> bool = Path::exists;
};
