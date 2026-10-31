//! Buffered, multiplexed connection I/O.
//!
//! Once multiplexing starts, every write on a connection travels in frames: a
//! 4-byte little-endian header `((MPLEX_BASE + code) << 24) | len` followed by
//! `len` (at most 0xFFFFFF) payload bytes. Code `MSG_DATA` carries the data
//! stream; every other code is an out-of-band message (logging, file status,
//! error exit, …). Before that point the stream is raw bytes.
//!
//! The write half ([`MuxWriter`]) buffers data in a 64 KiB output buffer and
//! frames everything pending as one MSG_DATA frame whenever a write does not
//! fit or output is flushed, so frames end on write boundaries like
//! upstream's. Messages go out at once, ahead of buffered data (upstream
//! drains its message buffer before data).
//!
//! The read half ([`MuxReader`]) reads the connection only where upstream's
//! `perform_io` reads it: when a read needs more than its 32 KiB input ring holds,
//! or when an output pass on the reading thread finds input waiting. A
//! connection thread performs those reads so a blocked read can honor
//! `--timeout` and the cancellation flag. Frames are decoded on the reading
//! thread as reads need data: a message is passed to `on_msg` only once all data
//! before it has been consumed (upstream's read-driven `read_a_msg`).
//!
//! Determinism: every decision that depends on whether input is waiting asks the
//! connection itself (a [`ReadProbe`], upstream's zero-timeout poll), and bytes
//! only move at those decision points; with the in-process pipe sized like a
//! socketpair, what one side sees at a refill depends only on what the other side
//! wrote before it, as between upstream's processes.

use std::collections::VecDeque;
use std::io::{self, Read, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, LazyLock, Mutex, MutexGuard, PoisonError, TryLockError};
use std::thread;
use std::time::{Duration, Instant};

use crate::rsync::flists::lock;
use crate::rsync::consts::{
	BIGPATHBUFLEN, CF_INC_RECURSE, IO_BUFFER_SIZE, MAX_FRAME_LEN, MPLEX_BASE,
	MSG_BLOCK_STATS, MSG_CLIENT, MSG_DATA, MSG_DELETED, MSG_ERROR, MSG_ERROR_EXIT,
	MSG_ERROR_SOCKET, MSG_ERROR_UTF8, MSG_ERROR_XFER, MSG_INFO, MSG_IO_ERROR, MSG_IO_TIMEOUT,
	MSG_LOG, MSG_NO_SEND, MSG_NOOP, MSG_REDO, MSG_STATS, MSG_SUCCESS, MSG_WARNING,
	MSK_ALLOW_FLUSH, msg_code_is_known,
};
use crate::rsync::exit::{RERR_SOCKETIO, RERR_STREAMIO, RERR_TIMEOUT, RsyncError};
use crate::rsync::log::{Role, syserr_suffix};
use crate::rsync::wire::{Proto, clone_io_error, is_retryable, put, wire_error};

/// Upstream's longest poll interval between timeout checks, in seconds.
const SELECT_TIMEOUT: u64 = 60;
/// How often a blocked read looks at the cancellation flag.
const CANCEL_POLL: Duration = Duration::from_millis(100);
/// How long an idle pass watches pending output for progress before it counts
/// the connection as not writable (upstream's zero-timeout poll).
const IDLE_POLL: Duration = Duration::from_millis(1);
/// Frame header length.
const HDR: usize = 4;
/// Output buffer size (upstream `ROUND_UP_1024(IO_BUFFER_SIZE * 2)`), frame
/// header slot included while multiplexed.
const OUT_SIZE: usize = IO_BUFFER_SIZE * 2;
/// Longest pause between retries of a would-block descriptor.
const WOULD_BLOCK_MAX_WAIT: Duration = Duration::from_millis(20);

/// The pause before retrying an operation that hit a non-blocking descriptor
/// (upstream polls for readiness); `attempt` grows it up to 20 ms.
fn would_block_pause(attempt: &mut u32) -> Duration {
	let pause = Duration::from_micros(250u64 << (*attempt).min(7)).min(WOULD_BLOCK_MAX_WAIT);
	*attempt = attempt.saturating_add(1);
	pause
}

/// Milliseconds on a process-wide monotonic clock; never 0 (0 means "never").
fn clock_ms() -> u64 {
	static EPOCH: LazyLock<Instant> = LazyLock::new(Instant::now);
	u64::try_from(EPOCH.elapsed().as_millis()).unwrap_or(u64::MAX - 1) + 1
}

/// Whole seconds elapsed between two clock readings; a clock that never
/// ticked (0) counts as idle forever (upstream's epoch-0 `time_t`).
fn idle_secs(now: u64, since: u64) -> u64 {
	if since == 0 { u64::MAX } else { now.saturating_sub(since) / 1000 }
}

fn who(role: Option<Role>) -> &'static str {
	role.map_or("", Role::name)
}

fn timeout_error(role: Option<Role>, idle: u64) -> io::Error {
	wire_error(
		io::ErrorKind::TimedOut,
		RERR_TIMEOUT,
		format!("[{}] io timeout after {idle} seconds -- exiting", who(role)),
		Some(("io.c", 266)),
	)
}

/// Wraps an OS-level failure of the connection the way upstream reports it.
fn socket_error(err: &io::Error, role: Option<Role>, what: &str, line: u32) -> io::Error {
	if err.raw_os_error().is_none() {
		return clone_io_error(err);
	}
	wire_error(
		err.kind(),
		RERR_SOCKETIO,
		format!("rsync: [{}] {what} error: {}", who(role), syserr_suffix(err)),
		Some(("io.c", line)),
	)
}

fn frame_header(code: u8, len: usize) -> io::Result<[u8; HDR]> {
	let tag = MPLEX_BASE.checked_add(code).ok_or_else(|| {
		io::Error::new(io::ErrorKind::InvalidInput, format!("message code {code} out of range"))
	})?;
	if len > MAX_FRAME_LEN {
		return Err(io::Error::new(
			io::ErrorKind::InvalidInput,
			format!("message of {len} bytes exceeds the {MAX_FRAME_LEN}-byte frame limit"),
		));
	}
	Ok(((u32::from(tag) << 24) | len as u32).to_le_bytes())
}

/// `--timeout` derived intervals (upstream `set_io_timeout`).
#[derive(Clone, Copy, Debug)]
struct Timing {
	/// The timeout itself, in seconds.
	timeout: u64,
	/// Keepalive interval: half the timeout, rounded up.
	lull: u64,
	/// Interval between timeout checks while blocked.
	select: u64,
}

/// `--timeout` in whole seconds (0 = none).
fn timeout_secs(timeout: Option<Duration>) -> u64 {
	timeout.map_or(0, |d| d.as_secs())
}

impl Timing {
	fn new(secs: u64) -> Option<Self> {
		if secs == 0 {
			return None;
		}
		let lull = (secs.saturating_add(1) / 2).min(i32::MAX as u64 / 5);
		let select = if lull == 0 || lull > SELECT_TIMEOUT { SELECT_TIMEOUT } else { lull };
		Some(Self { timeout: secs, lull, select })
	}
}

/// Bytes read/written on one connection (for `--stats` and the summary line).
///
/// Counts are raw connection bytes, frame headers included (upstream
/// `stats.total_read` / `stats.total_written`). The two activity clocks are
/// shared by both halves of the connection for keepalive and timeout
/// decisions.
#[derive(Clone, Default)]
pub(crate) struct IoCounters {
	pub read: Arc<AtomicU64>,
	pub written: Arc<AtomicU64>,
	/// When bytes last arrived (internal monotonic milliseconds, 0 = never).
	pub last_in: Arc<AtomicU64>,
	/// When bytes were last written (internal monotonic milliseconds, 0 = never).
	pub last_out: Arc<AtomicU64>,
}

impl IoCounters {
	/// Bytes read so far.
	pub(crate) fn total_read(&self) -> u64 {
		self.read.load(Ordering::Relaxed)
	}

	/// Bytes written so far.
	pub(crate) fn total_written(&self) -> u64 {
		self.written.load(Ordering::Relaxed)
	}
}

/// An out-of-band message from the peer (anything but MSG_DATA).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Msg {
	pub code: u8,
	pub payload: Vec<u8>,
}

/// Writer settings.
#[derive(Clone, Default)]
pub(crate) struct WriteConfig {
	/// `--bwlimit` in KiB/s (0/None = unlimited).
	pub bwlimit: Option<u64>,
	/// `--timeout`; keepalives are sent when idle for half of it (upstream behavior).
	pub timeout: Option<Duration>,
	/// Cancellation flag observed while sleeping for `--bwlimit`.
	pub cancel: Option<Arc<AtomicBool>>,
}

/// Upstream `sleep_for_bwlimit`: writes are cut to `writemax` bytes and the
/// writer sleeps once the accumulated delay owed reaches a tenth of a second.
struct BwLimit {
	kib: i64,
	writemax: usize,
	owed: i64,
	prior: Option<Instant>,
}

impl BwLimit {
	const ONE_SEC: i64 = 1_000_000;
	/// Microseconds per KiB at 1 KiB/s, truncated like upstream.
	const PER_KIB: i64 = Self::ONE_SEC / 1024;

	fn new(kib: u64) -> Option<Self> {
		if kib == 0 {
			return None;
		}
		let kib = i64::try_from(kib).unwrap_or(i64::MAX).min(i64::from(i32::MAX));
		let writemax = usize::try_from(kib.saturating_mul(128)).unwrap_or(usize::MAX).max(512);
		Some(Self { kib, writemax, owed: 0, prior: None })
	}

	fn micros(d: Duration) -> i64 {
		i64::try_from(d.as_micros()).unwrap_or(i64::MAX)
	}

	/// Runs on the output thread; callers waiting on it observe cancellation.
	fn after_write(&mut self, n: usize) {
		self.owed = self.owed.saturating_add(i64::try_from(n).unwrap_or(i64::MAX));
		let start = Instant::now();
		if let Some(prior) = self.prior {
			let elapsed = Self::micros(start.duration_since(prior));
			self.owed = self.owed.saturating_sub(elapsed.saturating_mul(self.kib) / Self::PER_KIB).max(0);
		}
		let sleep_us = self.owed.saturating_mul(Self::PER_KIB) / self.kib;
		if sleep_us < Self::ONE_SEC / 10 {
			self.prior = Some(start);
			return;
		}
		thread::sleep(Duration::from_micros(sleep_us.unsigned_abs()));
		let end = Instant::now();
		self.prior = Some(end);
		let elapsed = Self::micros(end.duration_since(start));
		self.owed = sleep_us.saturating_sub(elapsed).saturating_mul(self.kib) / Self::PER_KIB;
	}
}

/// One unit of work for the output thread.
enum OutJob {
	/// `buf[start..]` goes to the connection; `count` adds it to `IoCounters::written`.
	Data { buf: Vec<u8>, start: usize, count: bool },
	/// Flush the underlying writer.
	Flush,
}

struct OutState {
	queue: VecDeque<OutJob>,
	/// Bytes queued or being written.
	queued: usize,
	/// The thread is working on a job.
	busy: bool,
	/// The connection failed (raw error); nothing more is written.
	failed: Option<io::Error>,
	/// Every writer handle is gone: finish the queue, then exit.
	closed: bool,
	/// A spent data buffer for reuse.
	spare: Option<Vec<u8>>,
	/// Live [`OutputGrant`]s: the role thread is inside an output pass.
	grants: usize,
	/// Write calls (and flush jobs) completed so far: an output pass waits for
	/// one more, as upstream's `perform_io` pass performs one `write()`.
	attempts: u64,
	/// During such a one-write pass: no write call starts once `attempts`
	/// reaches this value.
	pass_limit: Option<u64>,
	/// The output thread is inside a write call (one that does not return is
	/// a connection that is not writable).
	writing: bool,
	/// Write calls that wrote something.
	moved: u64,
}

/// What [`MuxWriter::settle`] waits for.
#[derive(Clone, Copy)]
enum Until {
	/// Everything queued is written.
	Drained,
	/// At most this many bytes are still queued.
	Room(usize),
	/// One write attempt after the given [`OutState::attempts`] value, or nothing
	/// left to write.
	Attempt(u64),
}

impl OutState {
	/// Whether the output thread may write now.
	fn may_write(&self) -> bool {
		(self.grants > 0 && self.pass_limit.is_none_or(|limit| self.attempts < limit)) || self.closed
	}
}

/// Queue between writer handles and the thread that performs the writes, so
/// a write blocked on the connection never blocks the caller beyond its own
/// wait (which keeps serving incoming messages, like upstream's
/// `perform_io`). The thread writes only while some role thread holds an
/// [`OutputGrant`] — upstream writes only inside `perform_io` — so a frame
/// the connection could take only partly waits for the writer's next pass.
struct OutPipe {
	state: Mutex<OutState>,
	cond: Condvar,
}

impl OutPipe {
	/// Blocks until writing is allowed again.
	fn wait_permission(&self) {
		let mut o = lock(&self.state);
		while !o.may_write() {
			o = self.cond.wait(o).unwrap_or_else(PoisonError::into_inner);
		}
	}
}

/// Permission for the output thread to write, held while a role thread is in
/// an output pass (a flush, a wait for output room, or a wait for input).
pub(crate) struct OutputGrant {
	out: Arc<OutPipe>,
	/// This grant set [`OutState::pass_limit`] (a one-write pass).
	limited: bool,
}

impl Drop for OutputGrant {
	fn drop(&mut self) {
		let mut o = lock(&self.out.state);
		o.grants = o.grants.saturating_sub(1);
		if self.limited {
			o.pass_limit = None;
		}
		drop(o);
		self.out.cond.notify_all();
	}
}

fn write_out(
	pipe: &OutPipe,
	inner: &mut dyn Write,
	mut bytes: &[u8],
	mut bw: Option<&mut BwLimit>,
	counters: &IoCounters,
	count: bool,
) -> io::Result<()> {
	let mut attempt = 0;
	while !bytes.is_empty() {
		// What the connection did not take waits for the writer's next pass.
		pipe.wait_permission();
		let max = bw.as_ref().map_or(bytes.len(), |b| b.writemax.min(bytes.len()));
		lock(&pipe.state).writing = true;
		let res = inner.write(&bytes[..max]);
		lock(&pipe.state).writing = false;
		let n = match res {
			Ok(0) => return Err(io::ErrorKind::WriteZero.into()),
			Ok(n) => n.min(max),
			Err(e) if is_retryable(&e) => continue,
			Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
				// Not writable: this pass is over without a write.
				lock(&pipe.state).attempts += 1;
				pipe.cond.notify_all();
				thread::sleep(would_block_pause(&mut attempt));
				continue;
			}
			Err(e) => return Err(e),
		};
		attempt = 0;
		if count {
			counters.written.fetch_add(n as u64, Ordering::Relaxed);
		}
		counters.last_out.store(clock_ms(), Ordering::Relaxed);
		bytes = &bytes[n..];
		{
			let mut o = lock(&pipe.state);
			o.attempts += 1;
			o.moved += 1;
		}
		pipe.cond.notify_all();
		if let Some(bw) = bw.as_mut() {
			bw.after_write(n);
		}
	}
	Ok(())
}

fn flush_out(inner: &mut dyn Write) -> io::Result<()> {
	let mut attempt = 0;
	loop {
		match inner.flush() {
			Ok(()) => return Ok(()),
			Err(e) if is_retryable(&e) => {}
			Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
				thread::sleep(would_block_pause(&mut attempt));
			}
			Err(e) => return Err(e),
		}
	}
}

/// The output thread: performs queued jobs in order until closed or failed.
fn out_loop(
	pipe: &OutPipe,
	mut inner: Box<dyn Write + Send>,
	mut bw: Option<BwLimit>,
	counters: &IoCounters,
) {
	loop {
		let job = {
			let mut o = lock(&pipe.state);
			loop {
				if o.may_write()
					&& let Some(job) = o.queue.pop_front()
				{
					o.busy = true;
					break job;
				}
				if o.closed && o.queue.is_empty() {
					return;
				}
				o = pipe.cond.wait(o).unwrap_or_else(PoisonError::into_inner);
			}
		};
		let (res, done, spent) = match job {
			OutJob::Data { buf, start, count } => {
				let res = write_out(pipe, &mut *inner, &buf[start..], bw.as_mut(), counters, count);
				(res, buf.len() - start, Some(buf))
			}
			OutJob::Flush => (flush_out(&mut *inner), 0, None),
		};
		let mut o = lock(&pipe.state);
		o.busy = false;
		o.attempts += 1;
		o.queued = o.queued.saturating_sub(done);
		if let Some(mut buf) = spent
			&& o.spare.is_none()
			&& buf.capacity() >= HDR + OUT_SIZE
		{
			buf.clear();
			o.spare = Some(buf);
		}
		let failed = res.is_err();
		if let Err(err) = res {
			o.failed = Some(err);
			o.queue.clear();
			o.queued = 0;
		}
		pipe.cond.notify_all();
		if failed {
			return;
		}
	}
}

struct WState {
	/// Frame header slot followed by pending data bytes.
	buf: Vec<u8>,
	multiplexed: bool,
	batch: Option<Box<dyn Write + Send>>,
	counting: bool,
	role: Option<Role>,
	/// The first connection failure; every later operation reports it again.
	failed: Option<io::Error>,
}

struct WShared {
	state: Mutex<WState>,
	counters: IoCounters,
	cancel: Option<Arc<AtomicBool>>,
	/// `--timeout` in seconds (0 = none); read lock-free by a linked reader.
	timeout: AtomicU64,
	out: Arc<OutPipe>,
	/// The linked reader, served while this writer waits on the connection.
	peer: Mutex<Option<Arc<RShared>>>,
	/// A message went out since the last output pass that wrote data (upstream: a
	/// non-empty `iobuf.msg`, which the next `perform_io` pass writes instead of data).
	msgs_written: AtomicBool,
}

impl Drop for WShared {
	fn drop(&mut self) {
		lock(&self.out.state).closed = true;
		self.out.cond.notify_all();
	}
}

impl WState {
	fn pending(&self) -> usize {
		self.buf.len() - HDR
	}

	/// Data bytes the output buffer holds (the frame header slot is reserved
	/// while multiplexed).
	fn room(&self) -> usize {
		if self.multiplexed { OUT_SIZE - HDR } else { OUT_SIZE }
	}

	/// Upstream `write_buf`: when `piece` does not fit beside the pending
	/// bytes, everything pending goes out first as one frame. Returns whether
	/// that happened (an output pass).
	fn buffer(&mut self, piece: &[u8], sh: &WShared) -> io::Result<bool> {
		let flushed = self.pending() + piece.len() > self.room() && self.pending() > 0;
		if flushed {
			self.flush_data(sh)?;
		}
		self.buf.extend_from_slice(piece);
		Ok(flushed)
	}

	/// The sticky connection failure, mapped to upstream's diagnostic once.
	fn check_failed(&mut self, sh: &WShared) -> io::Result<()> {
		if let Some(err) = &self.failed {
			return Err(clone_io_error(err));
		}
		let mapped = match &lock(&sh.out.state).failed {
			Some(raw) => socket_error(raw, self.role, "write", 967),
			None => return Ok(()),
		};
		self.failed = Some(clone_io_error(&mapped));
		Err(mapped)
	}

	/// Queues one job for the output thread (in order).
	fn push(&mut self, sh: &WShared, job: OutJob, bytes: usize) -> io::Result<()> {
		let mut o = lock(&sh.out.state);
		if o.failed.is_some() {
			drop(o);
			return self.check_failed(sh);
		}
		o.queued += bytes;
		o.queue.push_back(job);
		sh.out.cond.notify_all();
		Ok(())
	}

	/// Sends the pending data (one MSG_DATA frame when multiplexed).
	fn flush_data(&mut self, sh: &WShared) -> io::Result<()> {
		let len = self.pending();
		if len == 0 {
			return Ok(());
		}
		let header = frame_header(MSG_DATA, len)?;
		let mut fresh = lock(&sh.out.state)
			.spare
			.take()
			.unwrap_or_else(|| Vec::with_capacity(HDR + OUT_SIZE));
		fresh.resize(HDR, 0);
		let mut buf = std::mem::replace(&mut self.buf, fresh);
		let start = if self.multiplexed {
			buf[..HDR].copy_from_slice(&header);
			0
		} else {
			HDR
		};
		let bytes = buf.len() - start;
		// An output pass writes pending messages before data.
		sh.msgs_written.store(false, Ordering::Relaxed);
		self.push(sh, OutJob::Data { buf, start, count: self.counting }, bytes)
	}

	/// Asks the output thread to flush the underlying writer (the end of an output
	/// pass: pending messages are out).
	fn request_flush(&mut self, sh: &WShared) -> io::Result<()> {
		sh.msgs_written.store(false, Ordering::Relaxed);
		self.push(sh, OutJob::Flush, 0)
	}

	/// Queues one complete frame.
	fn send_frame(&mut self, code: u8, payload: &[u8], sh: &WShared) -> io::Result<()> {
		let header = frame_header(code, payload.len())?;
		let mut frame = Vec::with_capacity(HDR + payload.len());
		frame.extend_from_slice(&header);
		frame.extend_from_slice(payload);
		let bytes = frame.len();
		self.push(sh, OutJob::Data { buf: frame, start: 0, count: self.counting }, bytes)
	}
}

/// Write half of a connection. Cheap to clone; all clones share one buffer and stream,
/// so data and messages are ordered exactly as written. Raw until `start_multiplex`.
///
/// Byte counting is on from construction; upstream does not count the bytes of
/// the version exchange or daemon greeting, so the session turns counting off
/// for those (`set_counting`). Pending (unflushed) data is not sent on drop;
/// everything already flushed is written out by the output thread, which
/// exits once the last handle is gone and its queue is empty.
///
/// The connection is written by a dedicated output thread. A caller waiting
/// on it (a flush, or a write when more than a buffer's worth is queued)
/// meanwhile serves the linked reader's incoming messages as upstream's
/// `perform_io` does, and returns early on cancellation or when a message
/// handler fails (e.g. the peer's MSG_ERROR_EXIT).
#[derive(Clone)]
pub(crate) struct MuxWriter {
	shared: Arc<WShared>,
}

impl MuxWriter {
	/// A raw-mode writer over `inner`.
	pub(crate) fn new(
		inner: Box<dyn Write + Send>,
		counters: IoCounters,
		cfg: WriteConfig,
	) -> Self {
		let mut buf = Vec::with_capacity(HDR + OUT_SIZE);
		buf.resize(HDR, 0);
		let state = WState {
			buf,
			multiplexed: false,
			batch: None,
			counting: true,
			role: None,
			failed: None,
		};
		let out = Arc::new(OutPipe {
			state: Mutex::new(OutState {
				queue: VecDeque::new(),
				queued: 0,
				busy: false,
				failed: None,
				closed: false,
				spare: None,
				grants: 0,
				attempts: 0,
				pass_limit: None,
				writing: false,
				moved: 0,
			}),
			cond: Condvar::new(),
		});
		let worker = Arc::clone(&out);
		let worker_counters = counters.clone();
		let bw = cfg.bwlimit.and_then(BwLimit::new);
		let spawned = thread::Builder::new()
			.name("rsync-io-write".into())
			.spawn(move || out_loop(&worker, inner, bw, &worker_counters));
		if let Err(err) = spawned {
			lock(&out.state).failed = Some(err);
		}
		Self {
			shared: Arc::new(WShared {
				state: Mutex::new(state),
				counters,
				cancel: cfg.cancel,
				timeout: AtomicU64::new(timeout_secs(cfg.timeout)),
				out,
				peer: Mutex::new(None),
				msgs_written: AtomicBool::new(false),
			}),
		}
	}

	/// Whether data is buffered or still being written (upstream
	/// `iobuf.out.len > out_empty_len`).
	pub(crate) fn data_pending(&self) -> bool {
		self.state().pending() > 0 || lock(&self.shared.out.state).queued > 0
	}

	/// Whether an output pass has anything to write: buffered data, or messages
	/// sent since the last pass.
	pub(crate) fn output_pending(&self) -> bool {
		self.shared.msgs_written.load(Ordering::Relaxed) || self.data_pending()
	}

	/// Whether output is pending and the output thread completes a write call
	/// within `window` (upstream's poll reporting the connection writable).
	fn output_moving(&self, window: Duration) -> bool {
		let out = &self.shared.out;
		let mut o = lock(&out.state);
		if o.queue.is_empty() && !o.busy {
			return false;
		}
		let before = o.moved;
		let deadline = Instant::now() + window;
		while o.moved == before {
			let now = Instant::now();
			if now >= deadline {
				return false;
			}
			o = out.cond.wait_timeout(o, deadline - now).unwrap_or_else(PoisonError::into_inner).0;
		}
		true
	}

	/// Hands the buffered data to the output thread without waiting: the passes
	/// that follow write it.
	fn queue_pending(&self) -> io::Result<()> {
		let sh = &*self.shared;
		let mut st = lock(&sh.state);
		st.check_failed(sh)?;
		st.flush_data(sh)
	}

	/// Lets the output thread write until the grant is dropped: the caller is in
	/// an output pass (upstream's `perform_io`), e.g. waiting for input.
	pub(crate) fn grant(&self) -> OutputGrant {
		let out = Arc::clone(&self.shared.out);
		lock(&out.state).grants += 1;
		out.cond.notify_all();
		OutputGrant { out, limited: false }
	}

	/// The first output pass of a `perform_io` that needs input (see
	/// `refill_flush`); the caller then waits for its input holding a [`grant`].
	///
	/// [`grant`]: MuxWriter::grant
	pub(crate) fn output_pass(&self, input_ready: bool) -> io::Result<()> {
		self.refill_flush(input_ready)
	}

	/// The output side of upstream `perform_io` when the linked reader must read
	/// more input: the pass writes the messages sent since the last pass or, when
	/// there were none, the buffered data; with messages written and input already
	/// waiting, the data stays buffered. Like upstream's pass it performs one write
	/// call (whatever the connection takes of the frame in flight) before
	/// returning; the rest goes out in later passes.
	fn refill_flush(&self, input_ready: bool) -> io::Result<()> {
		let sh = &*self.shared;
		let before = {
			let mut st = lock(&sh.state);
			st.check_failed(sh)?;
			let had_msgs = sh.msgs_written.swap(false, Ordering::Relaxed);
			if had_msgs && input_ready {
				return Ok(());
			}
			let before = lock(&sh.out.state).attempts;
			st.flush_data(sh)?;
			st.request_flush(sh)?;
			before
		};
		self.settle(Until::Attempt(before))
	}

	/// The receiving side's receiver is busy on file data (upstream
	/// `maybe_send_keepalive` with `MSK_ACTIVE_RECEIVER` in the receiver): marks input
	/// activity for the generator's timeout check. Nothing is written: upstream's
	/// receiver sends that keepalive to the generator's pipe, never the socket.
	pub(crate) fn note_active_receiver(&self) {
		self.shared.counters.last_in.store(clock_ms(), Ordering::Relaxed);
	}

	/// Upstream `perform_io` reads the input that is waiting in every output pass,
	/// and dispatches queued messages once more than 512 bytes are buffered.
	fn after_output_pass(&self) -> io::Result<()> {
		self.serve_peer(512)
	}

	/// Waits for the output thread until `until` holds. While waiting it lets
	/// the output thread write, serves the linked reader's input and messages,
	/// and checks cancellation and `--timeout` (upstream `perform_io` for
	/// output). Returns at once, writing nothing, when no wait is needed.
	fn settle(&self, until: Until) -> io::Result<()> {
		let sh = &*self.shared;
		let mut grant: Option<OutputGrant> = None;
		let mut next_check: Option<Instant> = None;
		// Since when the output thread has been inside one write call.
		let mut stuck_since: Option<Instant> = None;
		loop {
			{
				// Short slices: input that arrives while output waits is read about
				// as soon as upstream's poll would report it.
				let deadline = Instant::now() + Duration::from_millis(1);
				let mut o = lock(&sh.out.state);
				loop {
					if o.failed.is_some() {
						drop(o);
						return self.state().check_failed(sh);
					}
					let drained = o.queue.is_empty() && !o.busy;
					if !o.writing {
						stuck_since = None;
					}
					let done = match until {
						Until::Drained => drained,
						Until::Room(max) => o.queued <= max,
						// A write call that does not return is a connection that is
						// not writable: the pass ends without writing.
						Until::Attempt(before) => {
							drained
								|| o.attempts > before
								|| (o.writing && stuck_since.get_or_insert_with(Instant::now).elapsed() >= IDLE_POLL)
						}
					};
					if done {
						return Ok(());
					}
					if grant.is_none() {
						o.grants += 1;
						let limited = match until {
							Until::Attempt(before) => {
								o.pass_limit = Some(before + 1);
								true
							}
							Until::Drained | Until::Room(_) => false,
						};
						grant = Some(OutputGrant { out: Arc::clone(&sh.out), limited });
						sh.out.cond.notify_all();
					}
					let now = Instant::now();
					if now >= deadline {
						break;
					}
					o = sh
						.out
						.cond
						.wait_timeout(o, deadline - now)
						.unwrap_or_else(PoisonError::into_inner)
						.0;
				}
			}
			if sh.cancel.as_ref().is_some_and(|c| c.load(Ordering::Relaxed)) {
				return Err(RsyncError::cancelled_io());
			}
			self.serve_peer(512)?;
			if let Some(timing) = self.timing() {
				let now = Instant::now();
				let due = *next_check.get_or_insert(now + Duration::from_secs(timing.select));
				if now >= due {
					let role = self.state().role;
					check_timeout(&sh.counters, Some(timing), role, None, 0, false)?;
					next_check = Some(now + Duration::from_secs(timing.select));
				}
			}
		}
	}

	/// Reads the linked reader's waiting input into its buffer and dispatches the
	/// complete messages at its head while more than `min_buffered` bytes are
	/// buffered (upstream `perform_io` reads input in every output pass and runs
	/// `read_a_msg` while flushing output). Only on the thread that reads that
	/// reader, and only when no unconsumed data precedes the message, so dispatch
	/// order stays the reading order; data frames wait for the next `read`. A peer's
	/// MSG_ERROR_EXIT at the head is dispatched regardless of the minimum, so a
	/// writer blocked on a dead peer learns of its exit at once.
	fn serve_peer(&self, min_buffered: usize) -> io::Result<()> {
		let Some(rs) = lock(&self.shared.peer).clone() else {
			return Ok(());
		};
		let me = thread::current().id();
		let mut st = rs.lock();
		if st.closed || st.in_read || st.serving || st.last_reader != Some(me) || st.mode != Mode::Mux {
			return Ok(());
		}
		st = rs.read_now(st);
		loop {
			if let Some(err) = &st.fatal {
				return Err(clone_io_error(err));
			}
			let buffered = st.raw.len();
			if st.frame_left > 0 || !st.data.is_empty() || buffered < HDR {
				return Ok(());
			}
			let error_exit = i32::from(st.raw[3] as i8) - i32::from(MPLEX_BASE) == i32::from(MSG_ERROR_EXIT);
			if buffered <= min_buffered && !error_exit {
				return Ok(());
			}
			let header = u32::from_le_bytes([st.raw[0], st.raw[1], st.raw[2], st.raw[3]]);
			let len = (header & 0x00FF_FFFF) as usize;
			let tag = i32::from(st.raw[3] as i8) - i32::from(MPLEX_BASE);
			if tag == i32::from(MSG_DATA) {
				return Ok(());
			}
			if let Err(err) = st.validate(tag, len) {
				st.fatal = Some(clone_io_error(&err));
				return Err(err);
			}
			if st.raw.len() < HDR + len {
				return Ok(());
			}
			st.raw.drain(..HDR);
			let payload: Vec<u8> = st.raw.drain(..len).collect();
			st.consume(HDR + len);
			rs.cond.notify_all();
			let Some(mut on_msg) = st.on_msg.take() else {
				continue;
			};
			st.serving = true;
			drop(st);
			let res = on_msg(Msg { code: tag as u8, payload });
			st = rs.lock();
			if st.on_msg.is_none() {
				st.on_msg = Some(on_msg);
			}
			st.serving = false;
			rs.cond.notify_all();
			if let Err(err) = res {
				st.fatal = Some(clone_io_error(&err));
				return Err(err);
			}
		}
	}

	fn state(&self) -> MutexGuard<'_, WState> {
		lock(&self.shared.state)
	}

	/// The local role (upstream `who_am_i`), for diagnostics and keepalive rules.
	pub(crate) fn set_role(&self, role: Role) {
		self.state().role = Some(role);
	}

	/// Replaces `--timeout` (e.g. after the daemon's MSG_IO_TIMEOUT); a linked
	/// reader follows it too.
	pub(crate) fn set_timeout(&self, timeout: Option<Duration>) {
		self.shared.timeout.store(timeout_secs(timeout), Ordering::Relaxed);
	}

	/// The current `--timeout` intervals (lock-free).
	fn timing(&self) -> Option<Timing> {
		Timing::new(self.shared.timeout.load(Ordering::Relaxed))
	}

	/// Whether written bytes count toward `IoCounters::written`.
	pub(crate) fn set_counting(&self, on: bool) {
		self.state().counting = on;
	}

	/// Whether output is framed.
	pub(crate) fn is_multiplexed(&self) -> bool {
		self.state().multiplexed
	}

	/// Flushes pending raw data and frames everything from now on.
	pub(crate) fn start_multiplex(&self) -> io::Result<()> {
		let sh = &*self.shared;
		{
			let mut st = lock(&sh.state);
			st.check_failed(sh)?;
			st.flush_data(sh)?;
			st.multiplexed = true;
			st.request_flush(sh)?;
		}
		self.settle(Until::Drained)
	}

	/// Flushes pending data as a frame and returns to raw output (upstream
	/// `io_end_multiplex_out(MPLX_TO_BUFFERED)`, used for protocol-30
	/// `--files-from` forwarding).
	pub(crate) fn end_multiplex(&self) -> io::Result<()> {
		let sh = &*self.shared;
		{
			let mut st = lock(&sh.state);
			st.check_failed(sh)?;
			st.flush_data(sh)?;
			st.multiplexed = false;
			st.request_flush(sh)?;
		}
		self.settle(Until::Drained)
	}

	/// Sends one out-of-band message at once, ahead of any buffered data
	/// (which stays buffered). Before multiplexing starts the message is
	/// dropped (upstream behavior).
	pub(crate) fn send_msg(&self, code: u8, payload: &[u8]) -> io::Result<()> {
		self.try_send_msg(code, payload).map(drop)
	}

	/// Like `send_msg`, reporting whether the message went out (false while raw).
	pub(crate) fn try_send_msg(&self, code: u8, payload: &[u8]) -> io::Result<bool> {
		let sh = &*self.shared;
		{
			let mut st = lock(&sh.state);
			st.check_failed(sh)?;
			if !st.multiplexed {
				return Ok(false);
			}
			st.send_frame(code, payload, sh)?;
			st.request_flush(sh)?;
			sh.msgs_written.store(true, Ordering::Relaxed);
		}
		self.settle(Until::Drained)?;
		Ok(true)
	}

	/// Upstream `maybe_send_keepalive(now, flags)` (`MSK_*` flags) with this
	/// writer's role. Every protocol 29–33 peer accepts the keepalive 3.5.1
	/// sends: an empty MSG_DATA frame. It goes out only when multiplexed, this
	/// side is the sender, generator, or (while receiving data) receiver, and
	/// nothing was written for half the timeout; pending data is flushed
	/// instead of sending an empty frame. There is no `--timeout` guard (a
	/// protocol-30 MSG_NOOP makes the sender answer even without a timeout).
	pub(crate) fn maybe_keepalive(&self, flags: u32) -> io::Result<()> {
		let role = self.state().role;
		self.keepalive_for(role, flags, clock_ms(), true)
	}

	/// Upstream `check_timeout(1, flags)` for a thread that waits on something
	/// other than the connection (e.g. the generator): keepalive per this
	/// writer's role, then the idle check. Call it at least once per second
	/// while idle.
	pub(crate) fn idle(&self, flags: u32) -> io::Result<()> {
		let role = self.state().role;
		check_timeout(&self.shared.counters, self.timing(), role, Some(self), flags, true)
	}

	/// Keepalive per upstream rules; `wait_for_lock` callers (not the read
	/// path) also wait until it is written.
	fn keepalive_for(
		&self,
		role: Option<Role>,
		flags: u32,
		now: u64,
		wait_for_lock: bool,
	) -> io::Result<()> {
		let sh = &*self.shared;
		if !matches!(role, Some(Role::Sender | Role::Receiver | Role::Generator)) {
			return Ok(());
		}
		let mut st = if wait_for_lock {
			lock(&sh.state)
		} else {
			match sh.state.try_lock() {
				Ok(guard) => guard,
				Err(TryLockError::Poisoned(p)) => p.into_inner(),
				// Another thread is writing: output is not idle.
				Err(TryLockError::WouldBlock) => return Ok(()),
			}
		};
		let (lull, timeout) = self.timing().map_or((0, 0), |t| (t.lull, t.timeout));
		if idle_secs(now, sh.counters.last_out.load(Ordering::Relaxed)) < lull {
			return Ok(());
		}
		if role == Some(Role::Receiver)
			&& idle_secs(now, sh.counters.last_in.load(Ordering::Relaxed)) >= timeout
		{
			return Ok(());
		}
		st.check_failed(sh)?;
		if st.pending() == 0 {
			if !st.multiplexed {
				return Ok(());
			}
			st.send_frame(MSG_DATA, &[], sh)?;
		} else if flags & MSK_ALLOW_FLUSH != 0 {
			st.flush_data(sh)?;
		} else {
			return Ok(());
		}
		st.request_flush(sh)?;
		drop(st);
		if wait_for_lock { self.settle(Until::Drained) } else { Ok(()) }
	}

	/// Tees every data byte written from now on into a batch file.
	pub(crate) fn set_batch(&self, batch: Option<Box<dyn Write + Send>>) {
		self.state().batch = batch;
	}
}

impl Write for MuxWriter {
	fn write(&mut self, data: &[u8]) -> io::Result<usize> {
		if data.is_empty() {
			return Ok(0);
		}
		let sh = &*self.shared;
		{
			let mut st = lock(&sh.state);
			st.check_failed(sh)?;
			if let Some(batch) = st.batch.as_mut() {
				put(batch, data)?;
			}
			let mut rest = data;
			let mut output_pass = false;
			if rest.len() > st.room() {
				// Upstream `write_bigbuf`: half-buffer pieces until the
				// remainder is at most half a buffer plus 1 KiB.
				let half = st.room() / 2;
				while rest.len() > half + 1024 {
					output_pass |= st.buffer(&rest[..half], sh)?;
					rest = &rest[half..];
				}
			}
			output_pass |= st.buffer(rest, sh)?;
			// Upstream's output ring holds the frame still being written plus the
			// new data: a write waits until the frame in flight leaves room.
			let room = OUT_SIZE.saturating_sub(st.pending());
			drop(st);
			if output_pass {
				self.after_output_pass()?;
			}
			self.settle(Until::Room(room))?;
		}
		Ok(data.len())
	}

	fn flush(&mut self) -> io::Result<()> {
		let sh = &*self.shared;
		{
			let mut st = lock(&sh.state);
			st.check_failed(sh)?;
			// io_flush with nothing buffered or in flight performs no I/O at all
			// (in particular it reads no input).
			let idle = {
				let o = lock(&sh.out.state);
				o.queue.is_empty() && !o.busy
			};
			if st.pending() == 0 && idle && !sh.msgs_written.load(Ordering::Relaxed) {
				return Ok(());
			}
			st.flush_data(sh)?;
			st.request_flush(sh)?;
		}
		self.after_output_pass()?;
		self.settle(Until::Drained)
	}
}

/// Upstream `check_timeout`: optional keepalive, then the idle check (the
/// receiver never times out by itself).
fn check_timeout(
	counters: &IoCounters,
	timing: Option<Timing>,
	role: Option<Role>,
	writer: Option<&MuxWriter>,
	flags: u32,
	wait_for_lock: bool,
) -> io::Result<()> {
	let Some(timing) = timing else {
		return Ok(());
	};
	let now = clock_ms();
	if let Some(writer) = writer {
		writer.keepalive_for(role, flags, now, wait_for_lock)?;
	}
	let _ = counters.last_in.compare_exchange(0, now, Ordering::Relaxed, Ordering::Relaxed);
	if role == Some(Role::Receiver) {
		return Ok(());
	}
	// Output through the linked writer counts even if it was built with its
	// own counters.
	let last_out = writer
		.map(|w| w.shared.counters.last_out.load(Ordering::Relaxed))
		.unwrap_or(0)
		.max(counters.last_out.load(Ordering::Relaxed));
	let chk = counters.last_in.load(Ordering::Relaxed).max(last_out);
	let idle = idle_secs(now, chk);
	if idle >= timing.timeout { Err(timeout_error(role, idle)) } else { Ok(()) }
}

/// Reader settings.
#[derive(Clone, Default)]
pub(crate) struct ReadConfig {
	pub timeout: Option<Duration>,
}

type OnMsg = Box<dyn FnMut(Msg) -> io::Result<()> + Send>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Mode {
	Raw,
	Mux,
}

struct RState {
	/// Bytes read from the connection, not yet consumed (raw) or decoded (mux).
	raw: VecDeque<u8>,
	/// Decoded MSG_DATA payload awaiting `read`.
	data: VecDeque<u8>,
	/// Ring position of the first unconsumed byte of upstream's input buffer
	/// (`iobuf.in.pos`); reads fill only up to the ring's end.
	in_pos: usize,
	/// An outstanding read for the connection thread: at most this many bytes.
	request: Option<usize>,
	/// Whether the connection would return at once (see [`ReadProbe`]).
	probe: Option<ReadProbe>,
	mode: Mode,
	/// Payload bytes of the current MSG_DATA frame still in `raw`.
	frame_left: usize,
	/// Size (header included) of the current MSG_DATA frame until its first
	/// byte is handed to `read`.
	frame_uncounted: u64,
	/// Messages dispatched so far: a read that dispatched some while waiting runs
	/// another output pass (what their handlers queued goes out, as in upstream's
	/// next `perform_io` iteration).
	msgs_seen: u64,
	on_msg: Option<OnMsg>,
	/// A `read` is in progress.
	in_read: bool,
	/// A waiting writer is running `on_msg` (see `MuxWriter::serve_peer`).
	serving: bool,
	/// The thread of the latest `read`; only it may serve messages while
	/// waiting to write.
	last_reader: Option<thread::ThreadId>,
	eof: bool,
	read_err: Option<io::Error>,
	/// Malformed input or a failed `on_msg`; sticky.
	fatal: Option<io::Error>,
	counting: bool,
	closed: bool,
	batch: Option<Box<dyn Write + Send>>,
	role: Option<Role>,
	proto: Option<Proto>,
	am_server: bool,
	local_server: bool,
	timing: Option<Timing>,
}

struct RShared {
	state: Mutex<RState>,
	cond: Condvar,
	counters: IoCounters,
	cancel: Arc<AtomicBool>,
	/// See [`MuxReader::consumed_frame_bytes`].
	consumed: AtomicU64,
}

impl RShared {
	fn lock(&self) -> MutexGuard<'_, RState> {
		lock(&self.state)
	}

	fn wait<'a>(&self, guard: MutexGuard<'a, RState>) -> MutexGuard<'a, RState> {
		self.cond.wait(guard).unwrap_or_else(PoisonError::into_inner)
	}

	/// Waits briefly for the reader to be closed (would-block retry pause).
	fn pause(&self, attempt: &mut u32) -> bool {
		let st = self.wait_for(self.lock(), would_block_pause(attempt));
		!st.closed
	}

	fn wait_for<'a>(&self, guard: MutexGuard<'a, RState>, d: Duration) -> MutexGuard<'a, RState> {
		self.cond.wait_timeout(guard, d).unwrap_or_else(PoisonError::into_inner).0
	}

	/// The read of a `perform_io` pass when input is waiting: one read of what the
	/// connection holds now, up to the input buffer's room. Nothing is read when no
	/// input is waiting (the pass's poll would not report it).
	fn read_now<'a>(&self, mut st: MutexGuard<'a, RState>) -> MutexGuard<'a, RState> {
		if !st.input_waiting() || !st.request_read() {
			return st;
		}
		self.cond.notify_all();
		while st.request.is_some() && !st.closed && !self.cancel.load(Ordering::Relaxed) {
			st = self.wait_for(st, CANCEL_POLL);
		}
		st
	}
}

impl RState {
	/// Bytes of upstream's input buffer in use: undecoded input plus decoded data
	/// not yet handed out.
	fn in_use(&self) -> usize {
		self.raw.len() + self.data.len()
	}

	/// The size of one read: the input ring's free space up to its end, exactly as
	/// upstream's `perform_io` reads into `iobuf.in`.
	fn read_room(&mut self) -> usize {
		let used = self.in_use();
		if used == 0 {
			self.in_pos = 0;
		}
		let end = self.in_pos + used;
		if end >= IO_BUFFER_SIZE { IO_BUFFER_SIZE.saturating_sub(used) } else { IO_BUFFER_SIZE - end }
	}

	/// `n` bytes of the input buffer were consumed.
	fn consume(&mut self, n: usize) {
		self.in_pos = (self.in_pos + n) % IO_BUFFER_SIZE;
	}

	/// Asks the connection thread for one read (no-op while one is outstanding);
	/// false when no read can happen.
	fn request_read(&mut self) -> bool {
		if self.request.is_some() {
			return true;
		}
		if self.inner_done() || self.closed {
			return false;
		}
		let room = self.read_room();
		if room == 0 {
			return false;
		}
		self.request = Some(room);
		true
	}

	/// Whether the connection holds input (or its end) right now.
	fn input_waiting(&self) -> bool {
		self.probe.as_ref().is_some_and(|probe| probe())
	}

	fn inc_suffix(&self) -> &'static str {
		match self.proto {
			Some(p) if p.version >= 30 && p.has(CF_INC_RECURSE) => "/inc",
			_ => "",
		}
	}

	/// Upstream `read_a_msg` acceptance rules for a frame header. Role-based
	/// rules apply only once the role is known.
	fn validate(&self, tag: i32, len: usize) -> io::Result<()> {
		let who = who(self.role);
		let inc = self.inc_suffix();
		let error = |text: &str, line: u32| {
			wire_error(
				io::ErrorKind::InvalidData,
				RERR_STREAMIO,
				format!("{text} {tag}:{len} [{who}{inc}]"),
				Some(("io.c", line)),
			)
		};
		let invalid = || error("invalid multi-message", 1837);
		let overflow = || error("multiplexing overflow", 1876);
		let code = match u8::try_from(tag) {
			Ok(code) if msg_code_is_known(code) => code,
			_ => {
				return Err(wire_error(
					io::ErrorKind::InvalidData,
					RERR_STREAMIO,
					format!("unexpected tag {tag} [{who}{inc}]"),
					Some(("io.c", 1934)),
				));
			}
		};
		let role_in = |roles: &[Role]| self.role.is_none_or(|r| roles.contains(&r));
		let generator = role_in(&[Role::Generator]);
		let bad = match code {
			MSG_DATA => false,
			MSG_STATS => len != 8 || !generator,
			MSG_BLOCK_STATS => {
				len != 8
					|| self.proto.is_some_and(|p| p.version < 33)
					|| !role_in(&[Role::Generator, Role::Sender])
			}
			MSG_REDO => len != 4 || !generator,
			MSG_IO_ERROR | MSG_NO_SEND => len != 4,
			MSG_IO_TIMEOUT => len != 4 || self.am_server || self.role == Some(Role::Generator),
			MSG_NOOP => len != 0,
			MSG_SUCCESS => len != if self.local_server { 4 + 8 + 8 } else { 4 },
			MSG_ERROR_EXIT => len != 0 && len != 4,
			MSG_DELETED | MSG_INFO | MSG_ERROR | MSG_ERROR_XFER | MSG_WARNING => {
				if len >= BIGPATHBUFLEN {
					return Err(overflow());
				}
				false
			}
			MSG_ERROR_SOCKET | MSG_ERROR_UTF8 | MSG_CLIENT | MSG_LOG => {
				if !generator {
					return Err(invalid());
				}
				if len >= BIGPATHBUFLEN {
					return Err(overflow());
				}
				false
			}
			_ => false,
		};
		if bad { Err(invalid()) } else { Ok(()) }
	}

	/// Whether the decoder can make progress right now.
	fn can_demux(&self) -> bool {
		if self.mode != Mode::Mux || self.fatal.is_some() {
			return false;
		}
		if self.frame_left > 0 {
			return !self.raw.is_empty();
		}
		// The next header is looked at only once the data before it has been
		// consumed, like upstream.
		if self.raw.len() < HDR || !self.data.is_empty() {
			return false;
		}
		let header = u32::from_le_bytes([self.raw[0], self.raw[1], self.raw[2], self.raw[3]]);
		let len = (header & 0x00FF_FFFF) as usize;
		// Data headers and malformed headers are handled at once; a message
		// waits for its whole payload.
		header >> 24 == u32::from(MPLEX_BASE + MSG_DATA) || self.raw.len() >= HDR + len || {
			let tag = i32::from(self.raw[3] as i8) - i32::from(MPLEX_BASE);
			self.validate(tag, len).is_err()
		}
	}

	fn inner_done(&self) -> bool {
		self.eof || self.read_err.is_some()
	}

	/// Whether `read` may still get bytes without new input.
	fn more_possible(&self) -> bool {
		match self.mode {
			Mode::Raw => !self.raw.is_empty(),
			Mode::Mux => !self.data.is_empty() || self.can_demux(),
		}
	}

	/// The error for a read that can never be satisfied.
	fn end_error(&self, counters: &IoCounters) -> io::Error {
		match &self.read_err {
			Some(err) => socket_error(err, self.role, "read", 925),
			None => wire_error(
				io::ErrorKind::UnexpectedEof,
				RERR_STREAMIO,
				format!(
					"rsync: connection unexpectedly closed ({} bytes received so far) [{}]",
					counters.total_read(),
					who(self.role)
				),
				Some(("io.c", 303)),
			),
		}
	}
}

/// Decodes frames until data is available (or nothing more can be decoded),
/// on the reading thread; releases the lock while `on_msg` runs.
fn demux<'a>(sh: &'a RShared, mut guard: MutexGuard<'a, RState>) -> MutexGuard<'a, RState> {
	while guard.can_demux() {
		let st = &mut *guard;
		if st.frame_left > 0 {
			let n = st.frame_left.min(st.raw.len());
			st.data.extend(st.raw.drain(..n));
			st.frame_left -= n;
			sh.cond.notify_all();
			continue;
		}
		let header = u32::from_le_bytes([st.raw[0], st.raw[1], st.raw[2], st.raw[3]]);
		let len = (header & 0x00FF_FFFF) as usize;
		// The tag byte is sign-extended like upstream's `int` shift.
		let tag = i32::from(st.raw[3] as i8) - i32::from(MPLEX_BASE);
		if let Err(err) = st.validate(tag, len) {
			st.fatal = Some(err);
			sh.cond.notify_all();
			break;
		}
		st.raw.drain(..HDR);
		st.consume(HDR);
		sh.cond.notify_all();
		if tag == i32::from(MSG_DATA) {
			st.frame_left = len;
			st.frame_uncounted = if len > 0 { (HDR + len) as u64 } else { 0 };
			continue;
		}
		let payload: Vec<u8> = st.raw.drain(..len).collect();
		st.consume(len);
		st.msgs_seen += 1;
		let Some(mut on_msg) = st.on_msg.take() else {
			continue;
		};
		drop(guard);
		let res = on_msg(Msg { code: tag as u8, payload });
		guard = sh.lock();
		if guard.on_msg.is_none() {
			guard.on_msg = Some(on_msg);
		}
		if let Err(err) = res {
			guard.fatal = Some(err);
		}
		sh.cond.notify_all();
	}
	guard
}

/// Performs the reads the reading thread requests (one `read()` of at most the
/// requested size each), so bytes move from the connection only when upstream's
/// `perform_io` would read them. Exits at EOF, an error, or close.
fn reader_loop(sh: &RShared, mut inner: Box<dyn Read + Send>) {
	let mut buf = vec![0u8; IO_BUFFER_SIZE];
	let mut attempt = 0;
	loop {
		let want = {
			let mut st = sh.lock();
			loop {
				if st.closed {
					return;
				}
				if let Some(want) = st.request {
					break want;
				}
				st = sh.wait(st);
			}
		};
		let want = want.clamp(1, buf.len());
		let res = inner.read(&mut buf[..want]);
		if res.as_ref().is_err_and(|e| e.kind() == io::ErrorKind::WouldBlock) {
			// A non-blocking descriptor: wait and retry (upstream polls).
			if !sh.pause(&mut attempt) {
				return;
			}
			continue;
		}
		attempt = 0;
		let mut st = sh.lock();
		match res {
			Ok(0) => {
				st.eof = true;
				st.request = None;
				sh.cond.notify_all();
				return;
			}
			Ok(n) => {
				let n = n.min(want);
				st.raw.extend(&buf[..n]);
				if st.counting {
					sh.counters.read.fetch_add(n as u64, Ordering::Relaxed);
				}
				sh.counters.last_in.store(clock_ms(), Ordering::Relaxed);
				st.request = None;
				sh.cond.notify_all();
			}
			Err(e) if is_retryable(&e) => {}
			Err(e) => {
				st.read_err = Some(e);
				st.request = None;
				sh.cond.notify_all();
				return;
			}
		}
	}
}

/// Read half. Raw (synchronous, buffered) until `start_multiplex`; from then on
/// `read` demultiplexes frames as it needs data: MSG_DATA payloads are returned,
/// every other message is passed to `on_msg` on the reading thread once all data
/// before it has been consumed.
///
/// Input follows upstream's `perform_io`: bytes move from the connection into a
/// 32 KiB input ring only when a read needs more than the ring holds (a refill) or
/// an output pass on the reading thread finds input waiting, one `read()` of up to
/// the ring's free space each. Each refill first runs an output pass — by default
/// the linked writer's (see [`MuxReader::set_refill_hook`]) — which holds data back
/// only when it wrote messages and input is already waiting (see
/// [`MuxReader::set_probe`]); before a read blocks, one more pass writes
/// everything. So what a refill sees depends only on what the peer wrote before it,
/// never on a background thread's progress.
/// `--timeout` with no incoming bytes surfaces as an io::Error carrying RERR_TIMEOUT
/// (see `exit::RsyncError::from_io`). Cancellation makes a blocked read fail promptly.
///
/// A connection thread performs the requested reads (so a blocked read stays
/// cancellable); it exits at EOF or, after the reader is dropped, when its pending
/// read returns. Cancellation is reported as [`RsyncError::cancelled_io`].
pub(crate) struct MuxReader {
	shared: Arc<RShared>,
	writer: Option<MuxWriter>,
	refill_hook: Option<RefillHook>,
}

/// Whether a connection's reader would return at once (data or end waiting)
/// without reading: upstream's zero-timeout poll.
pub(crate) type ReadProbe = Arc<dyn Fn() -> bool + Send + Sync>;

/// What a refill runs instead of the linked writer's output pass; the argument tells
/// whether input is already waiting.
pub(crate) type RefillHook = Box<dyn FnMut(bool) + Send>;

impl MuxReader {
	/// A raw-mode reader over `inner`.
	pub(crate) fn new(
		inner: Box<dyn Read + Send>,
		counters: IoCounters,
		cancel: Arc<AtomicBool>,
		cfg: ReadConfig,
	) -> Self {
		let state = RState {
			raw: VecDeque::new(),
			data: VecDeque::new(),
			in_pos: 0,
			request: None,
			probe: None,
			mode: Mode::Raw,
			frame_left: 0,
			frame_uncounted: 0,
			msgs_seen: 0,
			on_msg: None,
			in_read: false,
			serving: false,
			last_reader: None,
			eof: false,
			read_err: None,
			fatal: None,
			counting: true,
			closed: false,
			batch: None,
			role: None,
			proto: None,
			am_server: false,
			local_server: false,
			timing: Timing::new(timeout_secs(cfg.timeout)),
		};
		let shared = Arc::new(RShared {
			state: Mutex::new(state),
			cond: Condvar::new(),
			counters,
			cancel,
			consumed: AtomicU64::new(0),
		});
		let worker = Arc::clone(&shared);
		let spawned = thread::Builder::new()
			.name("rsync-io-read".into())
			.spawn(move || reader_loop(&worker, inner));
		if let Err(err) = spawned {
			shared.lock().read_err = Some(err);
		}
		Self { shared, writer: None, refill_hook: None }
	}

	/// Tells the reader how to see whether the connection holds input right now
	/// (see [`ReadProbe`]). Without one, input never counts as already waiting.
	pub(crate) fn set_probe(&self, probe: Option<ReadProbe>) {
		self.shared.lock().probe = probe;
	}

	/// Replaces the linked writer's output pass at each multiplexed refill (None
	/// restores it). The receiving side's receiver uses this: its output is the pipe
	/// to the generator, never the socket the generator writes (upstream's separate
	/// receiver process).
	pub(crate) fn set_refill_hook(&mut self, hook: Option<RefillHook>) {
		self.refill_hook = hook;
	}

	/// The output side of one refill pass.
	fn run_refill(&mut self, input_ready: bool) -> io::Result<()> {
		match (&mut self.refill_hook, &self.writer) {
			(Some(hook), _) => {
				hook(input_ready);
				Ok(())
			},
			(None, Some(writer)) => writer.refill_flush(input_ready),
			(None, None) => Ok(()),
		}
	}

	/// The writer flushed before a read blocks and used for keepalives. While
	/// that writer waits on the connection from the thread that reads this
	/// reader, it dispatches this reader's incoming messages.
	pub(crate) fn link_writer(&mut self, writer: MuxWriter) {
		*lock(&writer.shared.peer) = Some(Arc::clone(&self.shared));
		self.writer = Some(writer);
	}

	/// The local role (upstream `who_am_i`): names diagnostics and selects the
	/// message, keepalive, and timeout rules.
	pub(crate) fn set_role(&self, role: Role) {
		self.shared.lock().role = Some(role);
		self.shared.cond.notify_all();
	}

	/// The negotiated protocol (MSG_BLOCK_STATS needs 33; inc-recursion is
	/// named in diagnostics).
	pub(crate) fn set_proto(&self, proto: Proto) {
		self.shared.lock().proto = Some(proto);
		self.shared.cond.notify_all();
	}

	/// Upstream `am_server` and `local_server` (MSG_IO_TIMEOUT and
	/// MSG_SUCCESS acceptance).
	pub(crate) fn set_server(&self, am_server: bool, local_server: bool) {
		let mut st = self.shared.lock();
		st.am_server = am_server;
		st.local_server = local_server;
	}

	/// Whether bytes read count toward `IoCounters::read`. Turning counting on
	/// also counts bytes already read ahead but not yet consumed, as upstream
	/// would read them only once buffering starts.
	pub(crate) fn set_counting(&self, on: bool) {
		let mut st = self.shared.lock();
		if on && !st.counting {
			let unconsumed = (st.raw.len() + st.data.len()) as u64;
			self.shared.counters.read.fetch_add(unconsumed, Ordering::Relaxed);
		}
		st.counting = on;
	}

	/// Bytes of the input stream handed to `read` so far, counted the way
	/// upstream's whole-buffer reads count them: multiplexed, a MSG_DATA frame
	/// adds its 4-byte header plus its full payload when its first byte is
	/// handed out; raw, every byte handed out.
	pub(crate) fn consumed_frame_bytes(&self) -> u64 {
		self.shared.consumed.load(Ordering::Relaxed)
	}

	/// Non-blocking: whether a `read` would return (data, EOF, or an error)
	/// without waiting for new input from the peer (upstream `perform_io`'s
	/// zero-timeout poll). Undecoded buffered bytes count as ready, as the
	/// descriptor would poll readable. Never flushes or dispatches messages.
	pub(crate) fn data_ready(&mut self) -> io::Result<bool> {
		if self.shared.cancel.load(Ordering::Relaxed) {
			return Ok(true);
		}
		let st = self.shared.lock();
		Ok(st.fatal.is_some()
			|| st.inner_done()
			|| !st.raw.is_empty()
			|| (st.mode == Mode::Mux && !st.data.is_empty())
			|| st.input_waiting())
	}

	/// Starts demultiplexing at the current stream position.
	pub(crate) fn start_multiplex(
		&mut self,
		on_msg: Box<dyn FnMut(Msg) -> io::Result<()> + Send>,
	) -> io::Result<()> {
		let mut st = self.shared.lock();
		st.on_msg = Some(on_msg);
		if st.mode != Mode::Mux {
			st.mode = Mode::Mux;
			st.frame_left = 0;
			st.frame_uncounted = 0;
		}
		self.shared.cond.notify_all();
		Ok(())
	}

	/// Returns to raw input at the current position (upstream
	/// `io_end_multiplex_in(MPLX_TO_BUFFERED)`); fails inside a data frame.
	pub(crate) fn end_multiplex(&mut self) -> io::Result<()> {
		let sh = &*self.shared;
		let mut st = sh.lock();
		if st.mode != Mode::Mux {
			return Ok(());
		}
		if st.frame_left > 0 || !st.data.is_empty() {
			return Err(wire_error(
				io::ErrorKind::InvalidData,
				RERR_STREAMIO,
				format!(
					"multiplexed input ended inside a data frame [{}{}]",
					who(st.role),
					st.inc_suffix()
				),
				None,
			));
		}
		st.mode = Mode::Raw;
		sh.cond.notify_all();
		Ok(())
	}

	/// Tees every data byte read from now on into a batch file.
	pub(crate) fn set_batch(&mut self, batch: Option<Box<dyn Write + Send>>) {
		self.shared.lock().batch = batch;
	}
}

impl Read for MuxReader {
	fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
		self.read_with(buf, None)
	}
}

/// Called by [`MuxReader::read_idle`] whenever the read would otherwise wait:
/// does one unit of side work (sends one more file-list segment) and returns
/// whether it wants to be called again.
pub(crate) type IdleWork<'a> = &'a mut dyn FnMut() -> io::Result<bool>;

impl MuxReader {
	/// [`Read::read`] for the sender's request stream while upstream's
	/// `extra_flist_sending_enabled` is set: every pass of the wait that finds
	/// no input waiting and no output moving (io.c's zero-timeout poll
	/// returning nothing) runs `idle` once, and its output goes out in the
	/// following passes. Once `idle` returns false the read waits normally.
	pub(crate) fn read_idle(&mut self, buf: &mut [u8], idle: IdleWork<'_>) -> io::Result<usize> {
		self.read_with(buf, Some(idle))
	}

	fn read_with(&mut self, buf: &mut [u8], idle: Option<IdleWork<'_>>) -> io::Result<usize> {
		if buf.is_empty() {
			return Ok(0);
		}
		{
			let mut st = self.shared.lock();
			while st.serving {
				st = self.shared.wait_for(st, CANCEL_POLL);
			}
			st.in_read = true;
			st.last_reader = Some(thread::current().id());
		}
		let res = self.read_data(buf, idle);
		self.shared.lock().in_read = false;
		res
	}

	/// One idle pass (see [`Self::read_idle`]): output the connection is
	/// taking goes first, as upstream's poll reports the socket writable;
	/// otherwise `idle` runs and what it buffered is queued for the next
	/// passes. Returns whether `idle` wants to run again.
	fn idle_pass(&self, idle: &mut dyn FnMut() -> io::Result<bool>) -> io::Result<bool> {
		if let Some(w) = &self.writer
			&& w.output_moving(IDLE_POLL)
		{
			return Ok(true);
		}
		let more = idle()?;
		if let Some(w) = &self.writer {
			w.queue_pending()?;
		}
		Ok(more)
	}

	fn read_data(&mut self, buf: &mut [u8], mut idle: Option<IdleWork<'_>>) -> io::Result<usize> {
		let sh = Arc::clone(&self.shared);
		if sh.cancel.load(Ordering::Relaxed) {
			return Err(RsyncError::cancelled_io());
		}
		// Taken once this read must wait: our own output keeps going out while it
		// waits for input (upstream's later perform_io passes write too).
		let mut _grant: Option<OutputGrant> = None;
		let mut st = sh.lock();
		let mut refilled = false;
		// Whether this call already ran an output pass that held nothing back.
		let mut drained = false;
		// `msgs_seen` as of the last output pass.
		let mut passed_msgs = st.msgs_seen;
		let mut next_check: Option<Instant> = None;
		loop {
			if st.mode == Mode::Mux {
				st = demux(&sh, st);
			}
			let n = match st.mode {
				Mode::Raw => st.raw.read(buf)?,
				Mode::Mux => st.data.read(buf)?,
			};
			if n > 0 {
				st.consume(n);
				let counted = match st.mode {
					Mode::Raw => n as u64,
					Mode::Mux => std::mem::take(&mut st.frame_uncounted),
				};
				sh.consumed.fetch_add(counted, Ordering::Relaxed);
				if let Some(batch) = st.batch.as_mut() {
					put(batch, &buf[..n])?;
				}
				sh.cond.notify_all();
				return Ok(n);
			}
			if let Some(err) = &st.fatal {
				return Err(clone_io_error(err));
			}
			if !refilled {
				// perform_io: one output pass, then the input that is waiting.
				let ready = st.input_waiting() || st.inner_done();
				drop(st);
				self.run_refill(ready)?;
				st = sh.lock();
				refilled = true;
				drained = !ready;
				passed_msgs = st.msgs_seen;
				st = sh.read_now(st);
				continue;
			}
			if st.inner_done() && !st.more_possible() && st.request.is_none() {
				return Err(st.end_error(&sh.counters));
			}
			if sh.cancel.load(Ordering::Relaxed) {
				return Err(RsyncError::cancelled_io());
			}
			if !drained || st.msgs_seen != passed_msgs {
				// About to block: like upstream's later perform_io passes, write all
				// output still pending (data a message pass held back; raw mode's
				// buffered output; what the messages dispatched while waiting
				// queued, e.g. a MSG_NO_SEND the receiver forwards) so the peer —
				// or the generator, for a hooked receiver — is never left waiting
				// on us.
				passed_msgs = st.msgs_seen;
				drop(st);
				self.run_refill(false)?;
				st = sh.lock();
				drained = true;
				continue;
			}
			// Block for input: one read of whatever arrives first.
			if _grant.is_none() && self.refill_hook.is_none() {
				_grant = self.writer.as_ref().map(MuxWriter::grant);
			}
			// upstream's zero-timeout polls while extra file lists may be sent
			// (IN_MULTIPLEXED_AND_READY): side work instead of a blocking wait.
			if st.mode == Mode::Mux
				&& let Some(work) = idle.as_deref_mut()
			{
				drop(st);
				let more = self.idle_pass(work)?;
				st = sh.lock();
				if !more {
					idle = None;
				}
				st = sh.read_now(st);
				continue;
			}
			if st.request_read() {
				sh.cond.notify_all();
			}
			let mut wait = CANCEL_POLL;
			// A linked writer carries the connection's current --timeout
			// (MSG_IO_TIMEOUT updates it there).
			let timing = self.writer.as_ref().map_or(st.timing, MuxWriter::timing);
			if let Some(timing) = timing {
				let now = Instant::now();
				let select = Duration::from_secs(timing.select);
				let due = *next_check.get_or_insert(now + select);
				if now >= due {
					let role = st.role;
					drop(st);
					// A hooked reader (the receiving side's receiver) keeps its
					// keepalives off the socket: upstream's receiver writes them
					// to the generator's pipe, and the generator sees socket
					// activity through the shared counters.
					let writer = if self.refill_hook.is_some() { None } else { self.writer.as_ref() };
					check_timeout(&sh.counters, Some(timing), role, writer, 0, false)?;
					st = sh.lock();
					next_check = Some(Instant::now() + select);
					continue;
				}
				wait = wait.min(due - now);
			}
			st = sh.wait_for(st, wait);
		}
	}
}

impl Drop for MuxReader {
	fn drop(&mut self) {
		self.shared.lock().closed = true;
		self.shared.cond.notify_all();
	}
}

#[cfg(test)]
mod tests {
	use std::io::Cursor;

	use super::*;
	use crate::rsync::exit::RERR_SIGNAL;
	use crate::rsync::wire::wire_detail;

	const P33: Proto = Proto::new(33, 0);

	/// A Write whose bytes (and individual write sizes) can be inspected.
	#[derive(Clone, Default)]
	struct Sink {
		bytes: Arc<Mutex<Vec<u8>>>,
		writes: Arc<Mutex<Vec<usize>>>,
	}

	impl Sink {
		fn take(&self) -> Vec<u8> {
			std::mem::take(&mut *lock(&self.bytes))
		}
	}

	impl Write for Sink {
		fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
			lock(&self.bytes).extend_from_slice(buf);
			lock(&self.writes).push(buf.len());
			Ok(buf.len())
		}

		fn flush(&mut self) -> io::Result<()> {
			Ok(())
		}
	}

	/// A Read that blocks until bytes are sent (EOF once the sender is dropped).
	struct Blocking(flume::Receiver<Vec<u8>>, Vec<u8>);

	impl Read for Blocking {
		fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
			if self.1.is_empty() {
				match self.0.recv() {
					Ok(v) => self.1 = v,
					Err(_) => return Ok(0),
				}
			}
			let n = buf.len().min(self.1.len());
			buf[..n].copy_from_slice(&self.1[..n]);
			self.1.drain(..n);
			Ok(n)
		}
	}

	fn frame(code: u8, payload: &[u8]) -> Vec<u8> {
		let mut v = frame_header(code, payload.len()).unwrap().to_vec();
		v.extend_from_slice(payload);
		v
	}

	fn writer(sink: &Sink, cfg: WriteConfig) -> MuxWriter {
		MuxWriter::new(Box::new(sink.clone()), IoCounters::default(), cfg)
	}

	fn reader(bytes: Vec<u8>) -> MuxReader {
		MuxReader::new(
			Box::new(Cursor::new(bytes)),
			IoCounters::default(),
			Arc::new(AtomicBool::new(false)),
			ReadConfig::default(),
		)
	}

	fn recorder() -> (Arc<Mutex<Vec<Msg>>>, OnMsg) {
		let seen = Arc::new(Mutex::new(Vec::new()));
		let sink = Arc::clone(&seen);
		(seen, Box::new(move |m| {
			lock(&sink).push(m);
			Ok(())
		}))
	}

	fn detail(err: &io::Error) -> String {
		wire_detail(err).map_or_default(|d| d.message.clone())
	}

	#[test]
	fn header_layout_matches_captured_frames() {
		// MSG_DATA of 41 bytes and MSG_BLOCK_STATS of 8 as sent by rsync 3.5.1.
		assert_eq!(frame_header(MSG_DATA, 0x29).unwrap(), [0x29, 0, 0, 0x07]);
		assert_eq!(frame_header(MSG_BLOCK_STATS, 8).unwrap(), [0x08, 0, 0, 0x12]);
		assert_eq!(frame_header(MSG_INFO, 0xFF_FFFF).unwrap(), [0xff, 0xff, 0xff, 0x09]);
		assert!(frame_header(MSG_INFO, 0x100_0000).is_err());
		assert!(frame_header(249, 0).is_err());
	}

	#[test]
	fn raw_until_multiplexed_then_framed_in_order() {
		let sink = Sink::default();
		let mut w = writer(&sink, WriteConfig::default());
		w.write_all(&[0x21, 0, 0, 0]).unwrap();
		assert!(!w.try_send_msg(MSG_INFO, b"dropped").unwrap());
		w.start_multiplex().unwrap();
		assert_eq!(sink.take(), [0x21, 0, 0, 0]);

		w.write_all(b"hello").unwrap();
		assert!(sink.take().is_empty(), "data stays buffered");
		// A message overtakes buffered data (upstream drains iobuf.msg first).
		w.send_msg(MSG_INFO, b"hi\n").unwrap();
		assert_eq!(sink.take(), frame(MSG_INFO, b"hi\n"));
		w.write_all(b"world").unwrap();
		w.flush().unwrap();

		let expect = frame(MSG_DATA, b"helloworld");
		assert_eq!(sink.take(), expect);
		let msg_len = frame(MSG_INFO, b"hi\n").len();
		assert_eq!(w.shared.counters.total_written(), (4 + msg_len + expect.len()) as u64);
	}

	/// Splits framed output into (code, payload length) pairs and the joined
	/// data payload.
	fn frames_of(out: &[u8]) -> (Vec<(u8, usize)>, Vec<u8>) {
		let mut r = out;
		let mut frames = Vec::new();
		let mut joined = Vec::new();
		while !r.is_empty() {
			let (&header, rest) = r.split_first_chunk::<4>().expect("frame header");
			let header = u32::from_le_bytes(header);
			let len = (header & 0xFF_FFFF) as usize;
			let code = (header >> 24) as u8 - MPLEX_BASE;
			frames.push((code, len));
			if code == MSG_DATA {
				joined.extend_from_slice(&rest[..len]);
			}
			r = &rest[len..];
		}
		(frames, joined)
	}

	#[test]
	fn frames_end_on_write_boundaries_like_upstream_token_stream() {
		// simple_send_token: a 4-byte length, then a 32 KiB literal chunk. The
		// reference sender's frames are 32776, then 32772 (chunk + next length).
		let sink = Sink::default();
		let mut w = writer(&sink, WriteConfig::default());
		w.start_multiplex().unwrap();
		let chunk = vec![7u8; 32768];
		for _ in 0..4 {
			w.write_all(&32768i32.to_le_bytes()).unwrap();
			w.write_all(&chunk).unwrap();
		}
		w.flush().unwrap();
		let (frames, joined) = frames_of(&sink.take());
		assert_eq!(frames, [(0, 32776), (0, 32772), (0, 32772), (0, 32768)]);
		assert_eq!(joined.len(), 4 * (4 + 32768));
	}

	#[test]
	fn oversized_write_is_split_like_write_bigbuf() {
		let sink = Sink::default();
		let mut w = writer(&sink, WriteConfig::default());
		w.start_multiplex().unwrap();
		let data: Vec<u8> = (0..100_000u32).map(|i| i as u8).collect();
		w.write_all(&data).unwrap();
		w.flush().unwrap();
		let (frames, joined) = frames_of(&sink.take());
		// Pieces 32766 ×3 + 1702; the buffer holds 65532 data bytes.
		assert_eq!(frames, [(0, 65532), (0, 34468)]);
		assert_eq!(joined, data);

		// Raw output holds a full 64 KiB without splitting.
		let sink = Sink::default();
		let mut w = writer(&sink, WriteConfig::default());
		w.write_all(&[1u8; 65536]).unwrap();
		assert!(sink.take().is_empty());
		w.write_all(&[2u8]).unwrap();
		w.flush().unwrap();
		assert_eq!(*lock(&sink.writes), [65536, 1]);
	}

	#[test]
	fn blocked_write_serves_peer_messages_and_fails_with_peer_exit() {
		/// A connection whose peer never reads: writes block until released.
		struct Stuck(Arc<AtomicBool>);
		impl Write for Stuck {
			fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
				while !self.0.load(Ordering::Relaxed) {
					thread::sleep(Duration::from_millis(5));
				}
				Ok(buf.len())
			}
			fn flush(&mut self) -> io::Result<()> {
				Ok(())
			}
		}
		let release = Arc::new(AtomicBool::new(false));
		let mut w = MuxWriter::new(
			Box::new(Stuck(Arc::clone(&release))),
			IoCounters::default(),
			WriteConfig::default(),
		);
		// Nothing is queued yet, so this completes even though writes block.
		w.start_multiplex().unwrap();
		let (mut r, tx, _) = blocking_reader(None);
		r.link_writer(w.clone());
		r.start_multiplex(Box::new(|m| {
			if m.code == MSG_ERROR_EXIT {
				Err(wire_error(io::ErrorKind::Other, 12, "peer exit", None))
			} else {
				Ok(())
			}
		}))
		.unwrap();
		// This thread reads the reader (so it may serve it while writing).
		tx.send(frame(MSG_DATA, b"a")).unwrap();
		r.read_exact(&mut [0u8; 1]).unwrap();
		let sender = thread::spawn(move || {
			thread::sleep(Duration::from_millis(150));
			tx.send(frame(MSG_ERROR_EXIT, &12i32.to_le_bytes())).unwrap();
			tx
		});
		let start = Instant::now();
		let err = w.write_all(&vec![0u8; 200_000]).unwrap_err();
		assert_eq!(wire_detail(&err).unwrap().code, 12);
		assert!(start.elapsed() < Duration::from_secs(3), "{:?}", start.elapsed());
		release.store(true, Ordering::Relaxed);
		drop(sender.join().unwrap());
	}

	#[test]
	fn would_block_writes_and_reads_wait_instead_of_failing() {
		struct Flaky {
			fails: u32,
			out: Arc<Mutex<Vec<u8>>>,
		}
		impl Write for Flaky {
			fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
				if self.fails > 0 {
					self.fails -= 1;
					return Err(io::ErrorKind::WouldBlock.into());
				}
				lock(&self.out).extend_from_slice(buf);
				Ok(buf.len())
			}
			fn flush(&mut self) -> io::Result<()> {
				Ok(())
			}
		}
		let out = Arc::new(Mutex::new(Vec::new()));
		let flaky = Flaky { fails: 3, out: Arc::clone(&out) };
		let mut w = MuxWriter::new(Box::new(flaky), IoCounters::default(), WriteConfig::default());
		w.write_all(b"abc").unwrap();
		w.flush().unwrap();
		assert_eq!(*lock(&out), b"abc");

		struct SlowRead(u32, &'static [u8]);
		impl Read for SlowRead {
			fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
				if self.0 > 0 {
					self.0 -= 1;
					return Err(io::ErrorKind::WouldBlock.into());
				}
				let n = buf.len().min(self.1.len());
				buf[..n].copy_from_slice(&self.1[..n]);
				self.1 = &self.1[n..];
				Ok(n)
			}
		}
		let mut r = MuxReader::new(
			Box::new(SlowRead(3, b"xyz")),
			IoCounters::default(),
			Arc::new(AtomicBool::new(false)),
			ReadConfig::default(),
		);
		let mut got = [0u8; 3];
		r.read_exact(&mut got).unwrap();
		assert_eq!(&got, b"xyz");
	}

	#[test]
	fn oversized_message_is_refused() {
		let sink = Sink::default();
		let w = writer(&sink, WriteConfig::default());
		w.start_multiplex().unwrap();
		let err = w.send_msg(MSG_INFO, &vec![0u8; MAX_FRAME_LEN + 1]).unwrap_err();
		assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
		assert!(sink.take().is_empty());
	}

	#[test]
	fn batch_tee_gets_data_bytes_only() {
		let sink = Sink::default();
		let batch = Sink::default();
		let mut w = writer(&sink, WriteConfig::default());
		w.start_multiplex().unwrap();
		w.set_batch(Some(Box::new(batch.clone())));
		w.write_all(b"abc").unwrap();
		w.send_msg(MSG_INFO, b"note").unwrap();
		w.write_all(b"def").unwrap();
		w.flush().unwrap();
		assert_eq!(batch.take(), b"abcdef");
	}

	#[test]
	fn reader_demuxes_data_and_dispatches_messages_in_order() {
		let mut stream = vec![b'R', b'A', b'W', b'!'];
		stream.extend(frame(MSG_DATA, b"abc"));
		stream.extend(frame(MSG_INFO, b"first\n"));
		stream.extend(frame(MSG_DATA, b""));
		stream.extend(frame(MSG_DATA, b"def"));
		stream.extend(frame(MSG_ERROR_XFER, b"second\n"));
		stream.extend(frame(MSG_IO_ERROR, &1i32.to_le_bytes()));
		let total = stream.len();
		let mut r = reader(stream);
		let mut head = [0u8; 4];
		r.read_exact(&mut head).unwrap();
		assert_eq!(&head, b"RAW!");
		let (seen, on_msg) = recorder();
		r.start_multiplex(on_msg).unwrap();
		let mut data = [0u8; 6];
		r.read_exact(&mut data).unwrap();
		assert_eq!(&data, b"abcdef");
		let err = r.read(&mut [0u8; 1]).unwrap_err();
		assert_eq!(err.kind(), io::ErrorKind::UnexpectedEof);
		assert_eq!(
			detail(&err),
			format!("rsync: connection unexpectedly closed ({total} bytes received so far) []")
		);
		let seen = lock(&seen).clone();
		assert_eq!(
			seen,
			[
				Msg { code: MSG_INFO, payload: b"first\n".to_vec() },
				Msg { code: MSG_ERROR_XFER, payload: b"second\n".to_vec() },
				Msg { code: MSG_IO_ERROR, payload: vec![1, 0, 0, 0] },
			]
		);
	}

	#[test]
	fn messages_dispatch_when_reading_reaches_them_and_input_can_end() {
		let mut stream = frame(MSG_DATA, b"ab");
		stream.extend(frame(MSG_WARNING, b"w\n"));
		stream.extend(frame(MSG_DATA, b"cd"));
		stream.extend_from_slice(b"raw\n");
		let mut r = reader(stream);
		let events = Arc::new(Mutex::new(Vec::<String>::new()));
		let log = Arc::clone(&events);
		r.start_multiplex(Box::new(move |m| {
			lock(&log).push(format!("msg {}", m.code));
			Ok(())
		}))
		.unwrap();
		for _ in 0..4 {
			let mut b = [0u8; 1];
			r.read_exact(&mut b).unwrap();
			lock(&events).push(format!("data {}", b[0] as char));
		}
		assert_eq!(*lock(&events), ["data a", "data b", "msg 4", "data c", "data d"]);
		r.end_multiplex().unwrap();
		let mut tail = [0u8; 4];
		r.read_exact(&mut tail).unwrap();
		assert_eq!(&tail, b"raw\n");
	}

	#[test]
	fn message_after_unconsumed_data_waits_for_the_reader() {
		let mut stream = frame(MSG_DATA, b"xy");
		stream.extend(frame(MSG_INFO, b"later\n"));
		let mut r = reader(stream);
		let (seen, on_msg) = recorder();
		r.start_multiplex(on_msg).unwrap();
		r.read_exact(&mut [0u8; 1]).unwrap();
		// Give the read-ahead thread time to buffer the message frame too.
		thread::sleep(Duration::from_millis(50));
		assert!(lock(&seen).is_empty());
		assert_eq!(r.end_multiplex().unwrap_err().kind(), io::ErrorKind::InvalidData);
		r.read_exact(&mut [0u8; 1]).unwrap();
		assert!(lock(&seen).is_empty());
		assert_eq!(r.read(&mut [0u8; 1]).unwrap_err().kind(), io::ErrorKind::UnexpectedEof);
		assert_eq!(lock(&seen).len(), 1);
	}

	#[test]
	fn consumed_frame_bytes_count_whole_data_frames() {
		let mut stream = b"RAW!".to_vec();
		stream.extend(frame(MSG_DATA, b"abc"));
		stream.extend(frame(MSG_INFO, b"i\n"));
		stream.extend(frame(MSG_DATA, b""));
		stream.extend(frame(MSG_DATA, b"de"));
		let mut r = reader(stream);
		r.read_exact(&mut [0u8; 4]).unwrap();
		assert_eq!(r.consumed_frame_bytes(), 4);
		let (_, on_msg) = recorder();
		r.start_multiplex(on_msg).unwrap();
		r.read_exact(&mut [0u8; 1]).unwrap();
		assert_eq!(r.consumed_frame_bytes(), 4 + 7);
		r.read_exact(&mut [0u8; 2]).unwrap();
		assert_eq!(r.consumed_frame_bytes(), 4 + 7);
		r.read_exact(&mut [0u8; 2]).unwrap();
		// Message and empty frames are not counted; "de" adds 4 + 2.
		assert_eq!(r.consumed_frame_bytes(), 4 + 7 + 6);
	}

	#[test]
	fn data_ready_reports_buffered_input_without_dispatching() {
		let (mut r, tx, _) = blocking_reader(None);
		let (seen, on_msg) = recorder();
		r.start_multiplex(on_msg).unwrap();
		assert!(!r.data_ready().unwrap());
		tx.send(frame(MSG_INFO, b"m\n")).unwrap();
		let deadline = Instant::now() + Duration::from_secs(5);
		while !r.data_ready().unwrap() && Instant::now() < deadline {
			thread::sleep(Duration::from_millis(5));
		}
		assert!(r.data_ready().unwrap());
		assert!(lock(&seen).is_empty());
		drop(tx);
		assert!(r.read(&mut [0u8; 1]).is_err());
		assert_eq!(lock(&seen).len(), 1);
	}

	fn first_error(stream: Vec<u8>, role: Option<Role>) -> io::Error {
		let mut r = reader(stream);
		if let Some(role) = role {
			r.set_role(role);
		}
		let (_, on_msg) = recorder();
		r.start_multiplex(on_msg).unwrap();
		let mut sink = Vec::new();
		loop {
			let mut b = [0u8; 64];
			match r.read(&mut b) {
				Ok(n) => sink.extend_from_slice(&b[..n]),
				Err(e) => return e,
			}
		}
	}

	#[test]
	fn invalid_frames_use_upstream_diagnostics() {
		// Unknown tag 50.
		let err = first_error(vec![0, 0, 0, 7 + 50], None);
		assert_eq!(err.kind(), io::ErrorKind::InvalidData);
		assert_eq!(detail(&err), "unexpected tag 50 []");
		// Tag byte below MPLEX_BASE.
		assert_eq!(detail(&first_error(vec![0, 0, 0, 0], None)), "unexpected tag -7 []");
		// High tag byte is sign-extended.
		assert_eq!(detail(&first_error(vec![0, 0, 0, 0xff], None)), "unexpected tag -8 []");
		// MSG_NOOP must be empty.
		let mut s = frame(MSG_DATA, b"ok");
		s.extend(frame(MSG_NOOP, b"x"));
		assert_eq!(detail(&first_error(s, None)), "invalid multi-message 42:1 []");
		// A log message must fit upstream's buffer.
		let err = first_error(frame(MSG_INFO, &vec![b'a'; BIGPATHBUFLEN]), None);
		assert_eq!(detail(&err), format!("multiplexing overflow 2:{BIGPATHBUFLEN} []"));
		// Generator-only messages from a peer are rejected once the role is known.
		let err = first_error(frame(MSG_REDO, &[0; 4]), Some(Role::Receiver));
		assert!(detail(&err).starts_with("invalid multi-message 9:4 ["), "{}", detail(&err));
		let detail_site = wire_detail(&err).unwrap();
		assert_eq!(detail_site.code, RERR_STREAMIO);
		assert_eq!(detail_site.site, Some(("io.c", 1837)));
	}

	#[test]
	fn block_stats_need_protocol_33() {
		let mut r = reader(frame(MSG_BLOCK_STATS, &[0; 8]));
		r.set_proto(Proto::new(32, 0));
		let (_, on_msg) = recorder();
		r.start_multiplex(on_msg).unwrap();
		let err = r.read(&mut [0u8; 1]).unwrap_err();
		assert_eq!(detail(&err), "invalid multi-message 11:8 []");

		let mut r = reader(frame(MSG_BLOCK_STATS, &[3, 0, 0, 0, 0, 0, 0, 0]));
		r.set_proto(P33);
		let (seen, on_msg) = recorder();
		r.start_multiplex(on_msg).unwrap();
		assert_eq!(r.read(&mut [0u8; 1]).unwrap_err().kind(), io::ErrorKind::UnexpectedEof);
		assert_eq!(lock(&seen).len(), 1);
	}

	#[test]
	fn on_msg_failure_surfaces_on_read() {
		let mut r = reader(frame(MSG_ERROR_EXIT, &12i32.to_le_bytes()));
		r.start_multiplex(Box::new(|m| {
			Err(wire_error(io::ErrorKind::Other, 12, format!("exit {}", m.payload[0]), None))
		}))
		.unwrap();
		let err = r.read(&mut [0u8; 1]).unwrap_err();
		assert_eq!(detail(&err), "exit 12");
	}

	#[test]
	fn raw_eof_reports_bytes_received() {
		let mut r = reader(b"AB".to_vec());
		let mut b = [0u8; 2];
		r.read_exact(&mut b).unwrap();
		let err = r.read_exact(&mut b).unwrap_err();
		assert_eq!(err.kind(), io::ErrorKind::UnexpectedEof);
		assert_eq!(detail(&err), "rsync: connection unexpectedly closed (2 bytes received so far) []");
		assert_eq!(wire_detail(&err).unwrap().site, Some(("io.c", 303)));
	}

	#[test]
	fn uncounted_handshake_bytes_are_excluded() {
		let mut stream = vec![0x21, 0, 0, 0];
		stream.extend(frame(MSG_DATA, b"x"));
		let mut r = reader(stream);
		r.set_counting(false);
		let mut v = [0u8; 4];
		r.read_exact(&mut v).unwrap();
		r.set_counting(true);
		let (_, on_msg) = recorder();
		r.start_multiplex(on_msg).unwrap();
		r.read_exact(&mut [0u8; 1]).unwrap();
		assert_eq!(r.shared.counters.total_read(), 5);
	}

	#[test]
	fn reader_tees_consumed_data_to_batch() {
		let mut stream = frame(MSG_DATA, b"abc");
		stream.extend(frame(MSG_INFO, b"i\n"));
		stream.extend(frame(MSG_DATA, b"de"));
		let mut r = reader(stream);
		let batch = Sink::default();
		r.set_batch(Some(Box::new(batch.clone())));
		let (_, on_msg) = recorder();
		r.start_multiplex(on_msg).unwrap();
		r.read_exact(&mut [0u8; 5]).unwrap();
		assert_eq!(batch.take(), b"abcde");
	}

	/// A reader fed by the returned sender, with a probe that sees queued chunks
	/// (and the sender's end) like a zero-timeout poll.
	fn blocking_reader(timeout: Option<Duration>) -> (MuxReader, flume::Sender<Vec<u8>>, Arc<AtomicBool>) {
		let (tx, rx) = flume::unbounded();
		let cancel = Arc::new(AtomicBool::new(false));
		let probed = rx.clone();
		let r = MuxReader::new(
			Box::new(Blocking(rx, Vec::new())),
			IoCounters::default(),
			Arc::clone(&cancel),
			ReadConfig { timeout },
		);
		r.set_probe(Some(Arc::new(move || !probed.is_empty() || probed.is_disconnected())));
		(r, tx, cancel)
	}

	/// A probe for an in-memory input that is always there.
	fn always_ready() -> Option<ReadProbe> {
		Some(Arc::new(|| true))
	}

	#[test]
	fn idle_input_times_out() {
		let (mut r, _tx, _) = blocking_reader(Some(Duration::from_secs(1)));
		let start = Instant::now();
		let err = r.read(&mut [0u8; 1]).unwrap_err();
		assert_eq!(err.kind(), io::ErrorKind::TimedOut);
		assert_eq!(detail(&err), "[] io timeout after 1 seconds -- exiting");
		assert_eq!(wire_detail(&err).unwrap().code, RERR_TIMEOUT);
		assert!(start.elapsed() < Duration::from_secs(5));
	}

	#[test]
	fn cancellation_interrupts_a_blocked_read() {
		let (mut r, _tx, cancel) = blocking_reader(None);
		let flag = Arc::clone(&cancel);
		let t = thread::spawn(move || {
			thread::sleep(Duration::from_millis(150));
			flag.store(true, Ordering::Relaxed);
		});
		let start = Instant::now();
		let err = r.read_exact(&mut [0u8; 1]).unwrap_err();
		t.join().unwrap();
		assert_eq!(err.kind(), io::ErrorKind::Other);
		assert_eq!(RsyncError::from_io(&err, RERR_STREAMIO).code, RERR_SIGNAL);
		assert!(start.elapsed() < Duration::from_secs(2));
	}

	#[test]
	fn blocked_read_flushes_the_linked_writer() {
		let (mut r, tx, _) = blocking_reader(None);
		let sink = Sink::default();
		let mut w = writer(&sink, WriteConfig::default());
		w.write_all(b"request").unwrap();
		assert!(sink.take().is_empty());
		r.link_writer(w.clone());
		let probe = sink.clone();
		let t = thread::spawn(move || {
			// The answer is sent only once the request has been flushed out.
			let deadline = Instant::now() + Duration::from_secs(5);
			while lock(&probe.bytes).is_empty() && Instant::now() < deadline {
				thread::sleep(Duration::from_millis(5));
			}
			let got = probe.take();
			tx.send(b"answer".to_vec()).unwrap();
			got
		});
		let mut answer = [0u8; 6];
		r.read_exact(&mut answer).unwrap();
		assert_eq!(&answer, b"answer");
		assert_eq!(t.join().unwrap(), b"request");
	}

	#[test]
	fn keepalive_rules() {
		let sink = Sink::default();
		let cfg = WriteConfig { timeout: Some(Duration::from_secs(4)), ..WriteConfig::default() };
		let mut w = writer(&sink, cfg);
		w.set_role(Role::Sender);
		// Raw output never carries keepalives.
		w.maybe_keepalive(MSK_ALLOW_FLUSH).unwrap();
		assert!(sink.take().is_empty());
		w.start_multiplex().unwrap();
		w.maybe_keepalive(MSK_ALLOW_FLUSH).unwrap();
		assert_eq!(sink.take(), [0, 0, 0, 7]);
		// Output just happened: within the lull nothing is sent.
		w.maybe_keepalive(MSK_ALLOW_FLUSH).unwrap();
		assert!(sink.take().is_empty());
		// Pending data is flushed instead of sending an empty frame.
		w.shared.counters.last_out.store(0, Ordering::Relaxed);
		w.write_all(b"z").unwrap();
		w.maybe_keepalive(MSK_ALLOW_FLUSH).unwrap();
		assert_eq!(sink.take(), frame(MSG_DATA, b"z"));

		// An early (pre-role) process never sends keepalives.
		let sink = Sink::default();
		let w = writer(&sink, WriteConfig { timeout: Some(Duration::from_secs(4)), ..WriteConfig::default() });
		w.start_multiplex().unwrap();
		w.set_role(Role::Client);
		w.maybe_keepalive(MSK_ALLOW_FLUSH).unwrap();
		assert!(sink.take().is_empty());

		// Without --timeout (lull 0) a sender answers every call (MSG_NOOP).
		let sink = Sink::default();
		let w = writer(&sink, WriteConfig::default());
		w.start_multiplex().unwrap();
		w.set_role(Role::Sender);
		w.maybe_keepalive(MSK_ALLOW_FLUSH).unwrap();
		w.maybe_keepalive(MSK_ALLOW_FLUSH).unwrap();
		assert_eq!(sink.take(), [0, 0, 0, 7, 0, 0, 0, 7]);
	}

	#[test]
	fn reader_follows_timeout_set_on_linked_writer() {
		let (mut r, _tx, _) = blocking_reader(None);
		let sink = Sink::default();
		let w = writer(&sink, WriteConfig::default());
		w.set_timeout(Some(Duration::from_secs(1)));
		r.link_writer(w);
		let err = r.read(&mut [0u8; 1]).unwrap_err();
		assert_eq!(err.kind(), io::ErrorKind::TimedOut);
	}

	/// S / G2: a multiplexed refill is one `perform_io` output pass. Input already
	/// read ahead past the input buffer does not spare the flush (upstream flushes on
	/// every refill); input inside the buffer needs no refill and no flush; and a pass
	/// that writes messages while input is waiting keeps the data back.
	#[test]
	fn refills_write_output_like_perform_io() {
		let mut stream = frame(MSG_DATA, &vec![7u8; 40000]);
		stream.extend(frame(MSG_DATA, b"x"));
		stream.extend(frame(MSG_DATA, &vec![8u8; 40000]));
		let mut r = reader(stream);
		r.set_probe(always_ready());
		let sink = Sink::default();
		let mut w = writer(&sink, WriteConfig::default());
		w.start_multiplex().unwrap();
		r.link_writer(w.clone());
		let (_, on_msg) = recorder();
		r.start_multiplex(on_msg).unwrap();

		// Refill 1 writes "A" and buffers 32 KiB of input.
		w.write_all(b"A").unwrap();
		r.read_exact(&mut [0u8; 100]).unwrap();
		// The rest of the first frame lies past the buffer: refill 2 writes "B" even
		// though those bytes were already waiting.
		w.write_all(b"B").unwrap();
		r.read_exact(&mut vec![0u8; 39900]).unwrap();
		// "x" is inside the buffer: no refill, "C" stays buffered.
		w.write_all(b"C").unwrap();
		r.read_exact(&mut [0u8; 1]).unwrap();
		// A message and waiting input: refill 3 writes the message only.
		w.write_all(b"D").unwrap();
		w.send_msg(MSG_INFO, b"m").unwrap();
		r.read_exact(&mut vec![0u8; 40000]).unwrap();
		w.flush().unwrap();
		let (frames, _) = frames_of(&sink.take());
		assert_eq!(frames, [(MSG_DATA, 1), (MSG_DATA, 1), (MSG_INFO, 1), (MSG_DATA, 2)]);
	}

	/// A connection that takes at most `max` bytes per write call.
	struct Chunked {
		sink: Sink,
		max: usize,
	}

	impl Write for Chunked {
		fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
			let n = buf.len().min(self.max);
			self.sink.write(&buf[..n])
		}

		fn flush(&mut self) -> io::Result<()> {
			Ok(())
		}
	}

	/// An output pass performs exactly one write call before returning; outside
	/// passes the output thread writes nothing, so a frame the connection took
	/// only partly waits for the next pass.
	#[test]
	fn output_passes_write_once_and_partial_frames_wait() {
		let sink = Sink::default();
		let chunked = Chunked { sink: sink.clone(), max: 10 };
		let mut w = MuxWriter::new(Box::new(chunked), IoCounters::default(), WriteConfig::default());
		w.start_multiplex().unwrap();
		w.write_all(&[5u8; 26]).unwrap();
		thread::sleep(Duration::from_millis(30));
		assert!(sink.take().is_empty(), "buffered data is not written outside a pass");
		w.output_pass(true).unwrap();
		thread::sleep(Duration::from_millis(30));
		assert_eq!(sink.take().len(), 10);
		w.output_pass(true).unwrap();
		thread::sleep(Duration::from_millis(30));
		assert_eq!(sink.take().len(), 10);
		w.flush().unwrap();
		assert_eq!(sink.take().len(), 10);
	}

	/// upstream's extra_flist_sending_enabled waits: a sender whose output sits on a
	/// connection the peer does not read (never writable) and whose input is empty
	/// still runs the side work (one more file-list segment) once per pass until it
	/// says it is done, and each piece is queued for output; then the read waits
	/// for input as usual.
	#[test]
	fn idle_read_sends_segments_while_output_is_blocked() {
		/// A connection whose peer never reads: writes block until released.
		struct Stuck(Arc<AtomicBool>);
		impl Write for Stuck {
			fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
				while !self.0.load(Ordering::Relaxed) {
					thread::sleep(Duration::from_millis(5));
				}
				Ok(buf.len())
			}
			fn flush(&mut self) -> io::Result<()> {
				Ok(())
			}
		}
		let release = Arc::new(AtomicBool::new(false));
		let mut w = MuxWriter::new(
			Box::new(Stuck(Arc::clone(&release))),
			IoCounters::default(),
			WriteConfig::default(),
		);
		w.start_multiplex().unwrap();
		let (mut r, tx, _) = blocking_reader(None);
		r.link_writer(w.clone());
		let (_, on_msg) = recorder();
		r.start_multiplex(on_msg).unwrap();
		// Output the peer never takes: the read's first pass cannot write it.
		w.write_all(b"pending").unwrap();
		let feeder = thread::spawn(move || {
			thread::sleep(Duration::from_millis(300));
			tx.send(frame(MSG_DATA, b"z")).unwrap();
			tx
		});
		let mut segments = 0;
		let mut out = w.clone();
		let mut send_one = || -> io::Result<bool> {
			segments += 1;
			out.write_all(b"segment")?;
			Ok(segments < 3)
		};
		let mut byte = [0u8; 1];
		let start = Instant::now();
		assert_eq!(r.read_idle(&mut byte, &mut send_one).unwrap(), 1);
		assert_eq!(byte, *b"z");
		assert!(start.elapsed() < Duration::from_secs(5));
		assert_eq!(segments, 3, "one segment per idle pass until done");
		// The segments were handed to the output thread, behind the stuck frame.
		assert!(lock(&w.shared.out.state).queued >= 3 * (HDR + 7) + HDR + 7);
		release.store(true, Ordering::Relaxed);
		w.flush().unwrap();
		drop(feeder.join().unwrap());
	}

	/// G1: with a refill hook (the receiving side's receiver), refills never touch the
	/// linked writer; the hook learns whether input was already waiting.
	#[test]
	fn refill_hook_replaces_the_writer_flush() {
		let mut stream = frame(MSG_DATA, &vec![1u8; 40000]);
		stream.extend(frame(MSG_DATA, b"y"));
		let mut r = reader(stream);
		r.set_probe(always_ready());
		let sink = Sink::default();
		let mut w = writer(&sink, WriteConfig::default());
		w.start_multiplex().unwrap();
		r.link_writer(w.clone());
		let calls = Arc::new(Mutex::new(Vec::new()));
		let seen = Arc::clone(&calls);
		r.set_refill_hook(Some(Box::new(move |ready| lock(&seen).push(ready))));
		let (_, on_msg) = recorder();
		r.start_multiplex(on_msg).unwrap();
		w.write_all(b"generator output").unwrap();
		r.read_exact(&mut vec![0u8; 40001]).unwrap();
		assert!(w.data_pending(), "the receiver never flushes the generator's output");
		assert!(sink.take().is_empty());
		let calls = lock(&calls).clone();
		assert!(calls.len() >= 2, "{calls:?}");
		assert!(calls.iter().any(|&ready| ready), "a refill found input read ahead: {calls:?}");
	}

	/// A message dispatched while a hooked reader waits gets one more output pass
	/// before the reader blocks again, so what its handler queued for the
	/// generator (a forwarded MSG_NO_SEND) is delivered without further input.
	#[test]
	fn messages_while_waiting_rerun_the_refill_hook() {
		let (mut r, tx, _) = blocking_reader(None);
		let calls = Arc::new(Mutex::new(Vec::new()));
		let seen = Arc::clone(&calls);
		r.set_refill_hook(Some(Box::new(move |ready| lock(&seen).push(ready))));
		let (msgs, on_msg) = recorder();
		r.start_multiplex(on_msg).unwrap();
		let probe = Arc::clone(&calls);
		let feeder = thread::spawn(move || {
			let deadline = Instant::now() + Duration::from_secs(5);
			while lock(&probe).is_empty() && Instant::now() < deadline {
				thread::sleep(Duration::from_millis(5));
			}
			tx.send(frame(MSG_NO_SEND, &7i32.to_le_bytes())).unwrap();
			// The data arrives only once the message's pass has run.
			while lock(&probe).len() < 2 && Instant::now() < deadline {
				thread::sleep(Duration::from_millis(5));
			}
			tx.send(frame(MSG_DATA, b"q")).unwrap();
			tx
		});
		let mut byte = [0u8; 1];
		r.read_exact(&mut byte).unwrap();
		assert_eq!(byte, *b"q");
		assert_eq!(*lock(&calls), [false, false]);
		assert_eq!(lock(&msgs).len(), 1);
		drop(feeder.join().unwrap());
	}

	/// Deadlock rule: before a read blocks, every output pass it ran must have
	/// written everything (upstream's later perform_io passes). A hooked reader
	/// whose refill wrote only messages because input was waiting runs the hook once
	/// more with no input waiting; so does a raw-mode reader (protocol 29's
	/// unmultiplexed server input), whose reads never refill.
	#[test]
	fn reads_never_block_with_output_held_back() {
		// Multiplexed: the first refill finds input waiting (half a header), the
		// same read then has to block for the rest.
		let (mut r, tx, _) = blocking_reader(None);
		let calls = Arc::new(Mutex::new(Vec::new()));
		let seen = Arc::clone(&calls);
		r.set_refill_hook(Some(Box::new(move |ready| lock(&seen).push(ready))));
		let (_, on_msg) = recorder();
		r.start_multiplex(on_msg).unwrap();
		let mut whole = frame(MSG_DATA, b"abcdef");
		let rest = whole.split_off(2);
		tx.send(whole).unwrap();
		let deadline = Instant::now() + Duration::from_secs(5);
		while !r.data_ready().unwrap() && Instant::now() < deadline {
			thread::sleep(Duration::from_millis(5));
		}
		let probe = Arc::clone(&calls);
		let t = thread::spawn(move || {
			let deadline = Instant::now() + Duration::from_secs(5);
			while !lock(&probe).contains(&false) && Instant::now() < deadline {
				thread::sleep(Duration::from_millis(5));
			}
			tx.send(rest).unwrap();
			tx
		});
		let mut got = [0u8; 6];
		r.read_exact(&mut got).unwrap();
		drop(t.join().unwrap());
		assert_eq!(&got, b"abcdef");
		let calls = lock(&calls).clone();
		assert_eq!(calls[..2], [true, false], "{calls:?}");

		// Raw mode: the hook runs before the read blocks.
		let (mut r, tx, _) = blocking_reader(None);
		let calls = Arc::new(Mutex::new(Vec::new()));
		let seen = Arc::clone(&calls);
		r.set_refill_hook(Some(Box::new(move |ready| lock(&seen).push(ready))));
		let probe = Arc::clone(&calls);
		let t = thread::spawn(move || {
			let deadline = Instant::now() + Duration::from_secs(5);
			while lock(&probe).is_empty() && Instant::now() < deadline {
				thread::sleep(Duration::from_millis(5));
			}
			tx.send(b"z".to_vec()).unwrap();
			tx
		});
		let mut byte = [0u8; 1];
		r.read_exact(&mut byte).unwrap();
		drop(t.join().unwrap());
		assert_eq!(*lock(&calls), [false]);
	}

	/// `--timeout=2`: keepalives go out every second (lull 1), so the idle check at
	/// each second sees at most 1 s of silence. (At `--timeout=1` lull equals the
	/// timeout and upstream itself times out on the second check, because a queued
	/// keepalive stamps `last_io_out` only once it is written.)
	#[test]
	fn blocked_sender_sends_keepalives_instead_of_timing_out() {
		let (mut r, _tx, cancel) = blocking_reader(Some(Duration::from_secs(2)));
		let sink = Sink::default();
		let w = writer(&sink, WriteConfig { timeout: Some(Duration::from_secs(2)), ..WriteConfig::default() });
		w.start_multiplex().unwrap();
		r.set_role(Role::Sender);
		r.link_writer(w);
		let flag = Arc::clone(&cancel);
		let t = thread::spawn(move || {
			thread::sleep(Duration::from_millis(2300));
			flag.store(true, Ordering::Relaxed);
		});
		let err = r.read(&mut [0u8; 1]).unwrap_err();
		t.join().unwrap();
		assert_eq!(RsyncError::from_io(&err, RERR_STREAMIO).code, RERR_SIGNAL);
		let out = sink.take();
		assert!(out.len() >= 8 && out.chunks(4).all(|c| c == [0, 0, 0, 7]), "{out:?}");
	}

	#[test]
	fn bwlimit_caps_write_size_and_sleeps() {
		let sink = Sink::default();
		let mut w = writer(&sink, WriteConfig { bwlimit: Some(10), ..WriteConfig::default() });
		let start = Instant::now();
		w.write_all(&[1u8; 4096]).unwrap();
		w.flush().unwrap();
		// 10 KiB/s: writes of at most 1280 bytes, ~0.37 s of sleeping.
		assert!(start.elapsed() >= Duration::from_millis(300), "{:?}", start.elapsed());
		assert!(lock(&sink.writes).iter().all(|&n| n <= 1280));
		assert_eq!(sink.take().len(), 4096);
	}

	#[cfg(unix)]
	#[test]
	fn write_failure_is_sticky() {
		struct Broken;
		impl Write for Broken {
			fn write(&mut self, _: &[u8]) -> io::Result<usize> {
				Err(io::Error::from_raw_os_error(32))
			}
			fn flush(&mut self) -> io::Result<()> {
				Ok(())
			}
		}
		let mut w = MuxWriter::new(Box::new(Broken), IoCounters::default(), WriteConfig::default());
		w.set_role(Role::Sender);
		w.write_all(b"x").unwrap();
		let err = w.flush().unwrap_err();
		let d = wire_detail(&err).unwrap();
		assert_eq!(d.code, RERR_SOCKETIO);
		assert!(d.message.starts_with("rsync: ["), "{}", d.message);
		assert!(d.message.ends_with("] write error: Broken pipe (32)"), "{}", d.message);
		assert_eq!(w.write(b"y").unwrap_err().kind(), err.kind());
	}
}
