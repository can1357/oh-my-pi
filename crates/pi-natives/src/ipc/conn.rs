//! Per-connection state shared by the JavaScript handle and its actor task.
//!
//! Writes stay on the JS thread: frames sent during one JS task gather in a
//! cork buffer that a microtask writes with one syscall at the end of the task
//! (large frames skip the cork and are written immediately). Only bytes the
//! socket refuses are queued; the actor flushes them once the socket turns
//! writable, and later writes queue behind them to keep order. No send ever
//! waits on a thread hop.
//!
//! Reads: the actor drains what is readable now into one buffer and hands
//! JavaScript a single batch per burst through a threadsafe function. Frames
//! and the close notification share that function, so they arrive in order and
//! the close comes last. Lines become JS strings on the JS thread straight
//! from the batch buffer (Latin-1 for ASCII, so most lines are one memcpy).

use std::{
	collections::VecDeque,
	io::{self, IoSlice},
	mem,
	pin::pin,
	ptr,
	sync::{
		Arc,
		atomic::{AtomicBool, AtomicUsize, Ordering},
	},
};

use napi::{
	Env, Error, JsValue, Result, Status,
	bindgen_prelude::{Function, FunctionRef, ToNapiValue, Uint8Array, Unknown},
	check_status, sys,
	threadsafe_function::{
		ThreadsafeCallContext, ThreadsafeFunction, ThreadsafeFunctionCallMode, UnknownReturnValue,
	},
};
use parking_lot::Mutex;
use tokio::sync::{
	Notify,
	mpsc::{UnboundedReceiver, UnboundedSender},
};

use super::{
	IpcError,
	lines::{FrameTooLarge, LineBatch, LineReader, READ_CHUNK, Text},
	platform::{self, Stream, WriteFinish},
};

/// Queued-but-unwritten bytes above which `send` reports backpressure.
pub const HIGH_WATER_BYTES: usize = 1024 * 1024;
/// Frames gathered into one vectored write.
const MAX_IOV: usize = 64;
/// Bytes read per wakeup before JavaScript gets the batch.
const READ_BUDGET: usize = 1024 * 1024;
/// Raw chunks up to this size are copied into a JS-owned buffer; larger ones
/// hand the receive buffer itself to JavaScript.
const RAW_COPY_BYTES: usize = 16 * 1024;
/// Frames at least this large skip the cork when nothing is pending: there is
/// nothing to coalesce and the copy would cost.
const DIRECT_WRITE_BYTES: usize = 64 * 1024;
/// A drained cork buffer keeps its allocation for the next task up to this
/// size.
const CORK_KEEP_BYTES: usize = 1024 * 1024;

/// How received bytes are delivered to JavaScript.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Framing {
	/// UTF-8 lines delimited by `\n`.
	Lines,
	/// Byte chunks as received.
	Raw,
}

/// Instruction from JavaScript to the connection actor.
pub enum Command {
	/// Begin reading and delivering frames.
	Start,
	/// Close immediately, dropping queued writes.
	Destroy,
}

/// Item delivered to JavaScript through the connection's event sink.
pub enum Event {
	Lines(LineBatch),
	Chunk(Vec<u8>),
	Close(Option<String>),
}

/// Ordered event channel into JavaScript; holds the loop unless unref'd.
type EventSink = ThreadsafeFunction<Event, (), (), Status, false>;

/// JavaScript frame callback for the connection's framing.
pub enum FrameCallback {
	Lines(FunctionRef<String, UnknownReturnValue>),
	Raw(FunctionRef<Uint8Array, UnknownReturnValue>),
}

enum Delivery {
	/// `start()` not called yet.
	Pending,
	/// Closed before `start()`; holds the close reason to deliver on start.
	ClosedUnstarted(Option<String>),
	/// Frames flow to JavaScript.
	Started(EventSink),
	/// `onClose` queued; nothing more is delivered.
	Done,
}

struct JsSide {
	delivery: Delivery,
	refed:    bool,
}

/// Write side, shared by the JS thread (cork, direct writes) and the actor
/// (flushing what the socket refused).
struct WriteState {
	/// `None` once the actor finished; dropping the last clone closes it.
	stream:        Option<Arc<Stream>>,
	/// Bytes sent during the current JS task, written by [`Shared::flush_cork`].
	corked:        Vec<u8>,
	/// Bytes the socket refused, oldest first; the actor writes them.
	frames:        VecDeque<Vec<u8>>,
	/// Bytes of the front frame already written.
	offset:        usize,
	/// Write side shut by `end()` or failed: further bytes are dropped.
	shut:          bool,
	/// `end()` was called: shut once `frames` drains.
	end_requested: bool,
}

impl WriteState {
	/// Try writing `parts` now. `None` when the write side failed (it is shut
	/// from then on: the peer is gone, but the actor keeps reading what it
	/// sent first).
	fn write_now(&mut self, parts: &[&[u8]]) -> Option<usize> {
		let Some(stream) = self.stream.as_deref() else {
			return Some(0);
		};
		let mut slices = [IoSlice::new(&[]); 2];
		for (slot, part) in slices.iter_mut().zip(parts) {
			*slot = IoSlice::new(part);
		}
		match stream.try_write_vectored(&slices[..parts.len().min(2)]) {
			Ok(written) => Some(written),
			Err(error)
				if matches!(error.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted) =>
			{
				Some(0)
			},
			Err(_) => {
				self.shut = true;
				None
			},
		}
	}

	/// Queue `bytes` for the actor; returns whether it must be woken.
	fn enqueue(&mut self, bytes: Vec<u8>) -> bool {
		let wake = self.frames.is_empty();
		self.frames.push_back(bytes);
		wake
	}

	/// Write queued frames until empty or the stream would block.
	fn flush(&mut self, stream: &Stream, shared: &Shared) -> io::Result<()> {
		while !self.frames.is_empty() {
			let mut slices = [IoSlice::new(&[]); MAX_IOV];
			let mut count = 0;
			for (slot, frame) in slices.iter_mut().zip(&self.frames) {
				*slot = IoSlice::new(if count == 0 {
					&frame[self.offset..]
				} else {
					frame
				});
				count += 1;
			}
			let mut written = match stream.try_write_vectored(&slices[..count]) {
				Ok(0) => return Err(io::ErrorKind::WriteZero.into()),
				Ok(written) => written,
				Err(error) if error.kind() == io::ErrorKind::WouldBlock => return Ok(()),
				Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
				Err(error) => return Err(error),
			};
			shared.consume(written);
			while written > 0 {
				let remaining = self.frames[0].len() - self.offset;
				if written < remaining {
					self.offset += written;
					break;
				}
				written -= remaining;
				self.offset = 0;
				self.frames.pop_front();
			}
		}
		Ok(())
	}

	/// Drop everything queued (write side is gone).
	fn discard(&mut self, shared: &Shared) {
		let mut bytes = 0;
		for (index, frame) in self.frames.drain(..).enumerate() {
			bytes += if index == 0 {
				frame.len() - self.offset
			} else {
				frame.len()
			};
		}
		self.offset = 0;
		if bytes > 0 {
			shared.consume(bytes);
		}
	}
}

/// State shared between the JavaScript handle and the connection actor.
pub struct Shared {
	pub framing: Framing,
	commands:    UnboundedSender<Command>,
	write:       Mutex<WriteState>,
	/// Wakes the actor when JavaScript queued bytes or called `end()`.
	write_wake:  Notify,
	queued:      AtomicUsize,
	/// Set by `destroy()` or when the actor finished.
	closed:      AtomicBool,
	/// Set by `end()`: further sends are dropped.
	ending:      AtomicBool,
	drained:     Notify,
	js:          Mutex<JsSide>,
}

impl Shared {
	pub fn new(framing: Framing, commands: UnboundedSender<Command>, stream: Arc<Stream>) -> Self {
		Self {
			framing,
			commands,
			write: Mutex::new(WriteState {
				stream:        Some(stream),
				corked:        Vec::new(),
				frames:        VecDeque::new(),
				offset:        0,
				shut:          false,
				end_requested: false,
			}),
			write_wake: Notify::new(),
			queued: AtomicUsize::new(0),
			closed: AtomicBool::new(false),
			ending: AtomicBool::new(false),
			drained: Notify::new(),
			js: Mutex::new(JsSide { delivery: Delivery::Pending, refed: true }),
		}
	}

	pub fn is_closed(&self) -> bool {
		self.closed.load(Ordering::Acquire)
	}

	pub fn is_started(&self) -> bool {
		!matches!(self.js.lock().delivery, Delivery::Pending | Delivery::ClosedUnstarted(_))
	}

	/// Send the concatenation of `parts` (JS thread). Dropped after
	/// `end()`/close.
	pub fn send(&self, parts: &[&[u8]]) -> SendOutcome {
		const DROPPED: SendOutcome = SendOutcome { below_high_water: false, uncorked: false };
		if self.closed.load(Ordering::Acquire) || self.ending.load(Ordering::Acquire) {
			return DROPPED;
		}
		let len: usize = parts.iter().map(|part| part.len()).sum();
		let mut write = self.write.lock();
		// `finish()` clears the stream and sets `shut` together.
		if write.shut {
			return DROPPED;
		}
		if len >= DIRECT_WRITE_BYTES && write.corked.is_empty() && write.frames.is_empty() {
			let Some(written) = write.write_now(parts) else {
				return DROPPED;
			};
			if written == len {
				return SendOutcome { below_high_water: true, uncorked: false };
			}
			let wake = write.enqueue(concat_from(parts, written));
			let unwritten = len - written;
			let total = self.queued.fetch_add(unwritten, Ordering::AcqRel) + unwritten;
			drop(write);
			if wake {
				self.write_wake.notify_one();
			}
			return SendOutcome {
				below_high_water: total <= HIGH_WATER_BYTES,
				uncorked:         false,
			};
		}
		let uncorked = write.corked.is_empty();
		for part in parts {
			write.corked.extend_from_slice(part);
		}
		let total = self.queued.fetch_add(len, Ordering::AcqRel) + len;
		SendOutcome { below_high_water: total <= HIGH_WATER_BYTES, uncorked }
	}

	/// Write what the finished JS task sent (JS thread): straight to the
	/// socket when nothing is queued ahead of it, the remainder to the actor.
	pub fn flush_cork(&self) {
		let mut write = self.write.lock();
		if write.corked.is_empty() {
			return;
		}
		let mut bytes = mem::take(&mut write.corked);
		let written = if write.shut {
			None
		} else if write.frames.is_empty() {
			write.write_now(&[&bytes])
		} else {
			Some(0)
		};
		let Some(written) = written else {
			// Write side gone: these bytes will never be written.
			self.consume(bytes.len());
			return;
		};
		if written > 0 {
			self.consume(written);
		}
		if written == bytes.len() {
			if bytes.capacity() <= CORK_KEEP_BYTES {
				bytes.clear();
				write.corked = bytes;
			}
			return;
		}
		bytes.drain(..written);
		let wake = write.enqueue(bytes);
		drop(write);
		if wake {
			self.write_wake.notify_one();
		}
	}

	pub fn end(&self) {
		if !self.ending.swap(true, Ordering::AcqRel) {
			// Queue the cork ahead of the shutdown.
			self.flush_cork();
			self.write.lock().end_requested = true;
			self.write_wake.notify_one();
		}
	}

	pub fn destroy(&self) {
		if !self.closed.swap(true, Ordering::AcqRel) {
			self.drained.notify_waiters();
			let _ = self.commands.send(Command::Destroy);
		}
	}

	/// Resolve once nothing is queued or the connection closed.
	pub async fn wait_drained(&self) {
		loop {
			let mut notified = pin!(self.drained.notified());
			notified.as_mut().enable();
			if self.queued.load(Ordering::Acquire) == 0 || self.closed.load(Ordering::Acquire) {
				return;
			}
			notified.await;
		}
	}

	/// Begin delivery to `on_frame`/`on_close`. The caller checked
	/// [`Self::is_started`] on the JS thread, the only thread that starts.
	pub fn start(
		&self,
		env: &Env,
		on_frame: FrameCallback,
		on_close: &Function<'_, Option<String>, UnknownReturnValue>,
	) -> Result<()> {
		let mut sink = build_sink(env, on_frame, on_close.create_ref()?)?;
		let mut js = self.js.lock();
		if !js.refed {
			#[allow(deprecated, reason = "explicit loop ref toggling is the documented intent")]
			sink.unref(env)?;
		}
		if let Delivery::ClosedUnstarted(reason) = mem::replace(&mut js.delivery, Delivery::Done) {
			sink.call(Event::Close(reason), ThreadsafeFunctionCallMode::NonBlocking);
			return Ok(());
		}
		js.delivery = Delivery::Started(sink);
		let _ = self.commands.send(Command::Start);
		Ok(())
	}

	/// Toggle whether this connection keeps the event loop alive.
	#[allow(deprecated, reason = "explicit loop ref toggling is the documented intent")]
	pub fn set_ref(&self, env: &Env, refed: bool) -> Result<()> {
		let mut js = self.js.lock();
		js.refed = refed;
		if let Delivery::Started(sink) = &mut js.delivery {
			if refed {
				sink.refer(env)?;
			} else {
				sink.unref(env)?;
			}
		}
		Ok(())
	}

	fn emit(&self, event: Event) {
		if let Delivery::Started(sink) = &self.js.lock().delivery {
			sink.call(event, ThreadsafeFunctionCallMode::NonBlocking);
		}
	}

	fn consume(&self, written: usize) {
		if self.queued.fetch_sub(written, Ordering::AcqRel) == written {
			self.drained.notify_waiters();
		}
	}

	fn finish(&self, reason: Option<String>) {
		{
			let mut write = self.write.lock();
			write.stream = None;
			write.corked = Vec::new();
			write.frames.clear();
			write.offset = 0;
			write.shut = true;
		}
		self.closed.store(true, Ordering::Release);
		self.queued.store(0, Ordering::Release);
		self.drained.notify_waiters();
		let mut js = self.js.lock();
		match mem::replace(&mut js.delivery, Delivery::Done) {
			// Dropping the sink releases it after the queued close is delivered.
			Delivery::Started(sink) => {
				sink.call(Event::Close(reason), ThreadsafeFunctionCallMode::NonBlocking);
			},
			Delivery::Pending => js.delivery = Delivery::ClosedUnstarted(reason),
			Delivery::ClosedUnstarted(earlier) => js.delivery = Delivery::ClosedUnstarted(earlier),
			Delivery::Done => {},
		}
	}
}

/// What [`Shared::send`] did with a frame.
pub struct SendOutcome {
	/// Queued-but-unwritten bytes stay under the high-water mark.
	pub below_high_water: bool,
	/// The frame opened a cork: schedule [`Shared::flush_cork`] for the end of
	/// the current JS task.
	pub uncorked:         bool,
}

/// `parts` concatenated, minus the first `skip` bytes.
fn concat_from(parts: &[&[u8]], mut skip: usize) -> Vec<u8> {
	let total: usize = parts.iter().map(|part| part.len()).sum();
	let mut bytes = Vec::with_capacity(total - skip);
	for part in parts {
		if skip >= part.len() {
			skip -= part.len();
			continue;
		}
		bytes.extend_from_slice(&part[skip..]);
		skip = 0;
	}
	bytes
}

/// Build the ordered event sink. The threadsafe function wraps a native no-op
/// so its call-JS callback can dispatch each event to the right JS callback.
fn build_sink(
	env: &Env,
	on_frame: FrameCallback,
	on_close: FunctionRef<Option<String>, UnknownReturnValue>,
) -> Result<EventSink> {
	let dispatcher = env.create_function_from_closure::<(), (), _>("ipcDispatch", |_| Ok(()))?;
	dispatcher
		.build_threadsafe_function::<Event>()
		.build_callback(move |ctx: ThreadsafeCallContext<Event>| {
			dispatch(&ctx.env, &on_frame, &on_close, ctx.value)
		})
}

fn dispatch(
	env: &Env,
	on_frame: &FrameCallback,
	on_close: &FunctionRef<Option<String>, UnknownReturnValue>,
	event: Event,
) -> Result<()> {
	match (event, on_frame) {
		(Event::Lines(batch), FrameCallback::Lines(callback)) => {
			let callback = callback.borrow_back(env)?;
			deliver_lines(env.raw(), callback.value().value, &batch)
		},
		(Event::Chunk(chunk), FrameCallback::Raw(callback)) => {
			let callback = callback.borrow_back(env)?;
			deliver_chunk(env.raw(), callback.value().value, chunk)
		},
		(Event::Close(reason), _) => on_close.borrow_back(env)?.call(reason).map(drop),
		_ => Ok(()),
	}
}

/// Call `callback(line)` for every line of `batch`, creating each string
/// directly from the batch buffer. A throwing callback must not swallow the
/// rest of the batch; the first exception is rethrown once every line was
/// delivered.
fn deliver_lines(env: sys::napi_env, callback: sys::napi_value, batch: &LineBatch) -> Result<()> {
	let receiver = undefined(env)?;
	let mut first_error = None;
	for &span in &batch.spans {
		let delivered = js_string(env, batch.line(span), span.text)
			.and_then(|line| call(env, receiver, callback, line));
		if let Err(error) = delivered {
			first_error.get_or_insert(error);
		}
	}
	first_error.map_or(Ok(()), Err)
}

/// Call `callback(chunk)`: small chunks are copied into a JS-owned buffer,
/// large ones hand over their allocation as an external `ArrayBuffer`.
fn deliver_chunk(env: sys::napi_env, callback: sys::napi_value, chunk: Vec<u8>) -> Result<()> {
	let receiver = undefined(env)?;
	let value = if chunk.len() <= RAW_COPY_BYTES {
		let mut data = ptr::null_mut();
		let mut buffer = ptr::null_mut();
		// SAFETY: `env` is the live env of this JS-thread callback; Node-API
		// copies `chunk.len()` bytes from the valid `chunk` allocation.
		let status = unsafe {
			sys::napi_create_buffer_copy(
				env,
				chunk.len(),
				chunk.as_ptr().cast(),
				&mut data,
				&mut buffer,
			)
		};
		check_status!(status, "create chunk buffer")?;
		buffer
	} else {
		// SAFETY: `env` is the live env of this JS-thread callback.
		unsafe { Uint8Array::to_napi_value(env, Uint8Array::from(chunk)) }?
	};
	call(env, receiver, callback, value)
}

fn undefined(env: sys::napi_env) -> Result<sys::napi_value> {
	let mut value = ptr::null_mut();
	// SAFETY: `env` is the live env of the current JS-thread callback.
	let status = unsafe { sys::napi_get_undefined(env, &mut value) };
	check_status!(status, "get undefined")?;
	Ok(value)
}

/// JS string for one line: ASCII copies verbatim as Latin-1, valid UTF-8
/// transcodes, invalid UTF-8 is replaced lossily first.
fn js_string(env: sys::napi_env, bytes: &[u8], text: Text) -> Result<sys::napi_value> {
	let lossy;
	let (bytes, latin1) = match text {
		Text::Ascii => (bytes, true),
		Text::Utf8 => (bytes, false),
		Text::Invalid => {
			lossy = String::from_utf8_lossy(bytes);
			(lossy.as_bytes(), false)
		},
	};
	let len = isize::try_from(bytes.len())
		.map_err(|_| Error::new(Status::InvalidArg, "line longer than isize::MAX"))?;
	let mut value = ptr::null_mut();
	// SAFETY: `env` is the live env of this JS-thread callback; Node-API
	// copies `len` bytes from `bytes`, which outlives the call.
	let status = unsafe {
		if latin1 {
			sys::napi_create_string_latin1(env, bytes.as_ptr().cast(), len, &mut value)
		} else {
			sys::napi_create_string_utf8(env, bytes.as_ptr().cast(), len, &mut value)
		}
	};
	check_status!(status, "create line string")?;
	Ok(value)
}

/// `callback(argument)` with `this === undefined`; a thrown exception is
/// cleared and returned so the caller decides when to rethrow it.
fn call(
	env: sys::napi_env,
	receiver: sys::napi_value,
	callback: sys::napi_value,
	argument: sys::napi_value,
) -> Result<()> {
	let mut ignored = ptr::null_mut();
	// SAFETY: every handle belongs to the live env of this JS-thread callback;
	// `argument` is one valid value, matching `argc = 1`.
	let status =
		unsafe { sys::napi_call_function(env, receiver, callback, 1, &argument, &mut ignored) };
	if status == sys::Status::napi_pending_exception {
		let mut exception = ptr::null_mut();
		// SAFETY: an exception is pending on `env`; this clears and returns it.
		let cleared = unsafe { sys::napi_get_and_clear_last_exception(env, &mut exception) };
		check_status!(cleared, "clear callback exception")?;
		// SAFETY: `exception` is the live value just returned by Node-API.
		return Err(Error::from(unsafe { Unknown::from_raw_unchecked(env, exception) }));
	}
	check_status!(status, "call frame callback")
}

/// Receive-side framing state of one connection.
enum Reader {
	Lines(LineReader),
	Raw(Vec<u8>),
}

/// Whether the connection keeps running after a read burst.
enum Flow {
	Open,
	/// Close with this reason (`None` = orderly).
	Closed(Option<String>),
}

/// Drive `stream` until it closes, then publish the close outcome.
pub async fn run(
	stream: Arc<Stream>,
	shared: Arc<Shared>,
	mut commands: UnboundedReceiver<Command>,
	max_frame_bytes: usize,
) {
	let reason = drive(&stream, &shared, &mut commands, max_frame_bytes).await;
	drop(commands);
	// Clears the JS side's stream handle; dropping ours then closes it.
	shared.finish(reason);
	drop(stream);
}

/// Event loop of one connection; returns the close reason (`None` = orderly).
async fn drive(
	stream: &Stream,
	shared: &Shared,
	commands: &mut UnboundedReceiver<Command>,
	max_frame_bytes: usize,
) -> Option<String> {
	let mut reader = match shared.framing {
		Framing::Lines => Reader::Lines(LineReader::new(max_frame_bytes)),
		Framing::Raw => Reader::Raw(Vec::new()),
	};
	let mut reading = false;
	loop {
		let write_pending = {
			let mut write = shared.write.lock();
			if write.end_requested && !write.shut && write.frames.is_empty() {
				write.shut = true;
				if matches!(stream.finish_write(), Ok(WriteFinish::Closed)) {
					return None;
				}
			}
			!write.shut && !write.frames.is_empty()
		};
		tokio::select! {
			biased;
			command = commands.recv() => match command {
				None | Some(Command::Destroy) => return None,
				Some(Command::Start) => reading = true,
			},
			() = shared.write_wake.notified() => {},
			ready = stream.writable(), if write_pending => {
				// A failed write side (peer gone) is not a close by itself: keep
				// reading so frames the peer sent before leaving still arrive.
				let mut write = shared.write.lock();
				if ready.and_then(|()| write.flush(stream, shared)).is_err() {
					write.shut = true;
					write.discard(shared);
				}
			},
			ready = stream.readable(), if reading => {
				let flow = match ready {
					Ok(()) => read_burst(stream, shared, &mut reader, max_frame_bytes),
					Err(error) => Flow::Closed(Some(IpcError::io(&error, "read failed").reason())),
				};
				if let Flow::Closed(reason) = flow {
					return reason;
				}
			},
		}
	}
}

/// Read what is available now (up to [`READ_BUDGET`]) and hand JavaScript one
/// batch.
fn read_burst(
	stream: &Stream,
	shared: &Shared,
	reader: &mut Reader,
	max_frame_bytes: usize,
) -> Flow {
	match reader {
		Reader::Lines(lines) => {
			let mut total = 0;
			let ended = loop {
				let buf = lines.spare();
				let spare = buf.capacity() - buf.len();
				match stream.try_read_buf(buf) {
					Ok(0) => break Ok(true),
					// A short read drained the socket; skip the WouldBlock probe.
					Ok(read) if read < spare => break Ok(false),
					Ok(read) => {
						total += read;
						if total >= READ_BUDGET {
							break Ok(false);
						}
					},
					Err(error) if error.kind() == io::ErrorKind::WouldBlock => break Ok(false),
					Err(error) if error.kind() == io::ErrorKind::Interrupted => {},
					Err(error) if platform::is_orderly_eof(&error) => break Ok(true),
					Err(error) => break Err(IpcError::io(&error, "read failed").reason()),
				}
			};
			if emit_lines(shared, lines.take()).is_err() {
				return Flow::Closed(Some(oversize_reason(max_frame_bytes)));
			}
			match ended {
				Ok(false) => Flow::Open,
				Ok(true) => match emit_lines(shared, lines.finish()) {
					Ok(()) => Flow::Closed(None),
					Err(FrameTooLarge) => Flow::Closed(Some(oversize_reason(max_frame_bytes))),
				},
				Err(reason) => Flow::Closed(Some(reason)),
			}
		},
		Reader::Raw(buf) => {
			buf.reserve(READ_CHUNK);
			match stream.try_read_buf(buf) {
				Ok(0) => Flow::Closed(None),
				Ok(_) => {
					let chunk = if buf.len() <= RAW_COPY_BYTES {
						let chunk = buf.clone();
						buf.clear();
						chunk
					} else {
						mem::take(buf)
					};
					shared.emit(Event::Chunk(chunk));
					Flow::Open
				},
				Err(error)
					if matches!(
						error.kind(),
						io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
					) =>
				{
					Flow::Open
				},
				Err(error) if platform::is_orderly_eof(&error) => Flow::Closed(None),
				Err(error) => Flow::Closed(Some(IpcError::io(&error, "read failed").reason())),
			}
		},
	}
}

/// Emit a batch (if any), passing the framing outcome through.
fn emit_lines(
	shared: &Shared,
	(batch, outcome): (Option<LineBatch>, std::result::Result<(), FrameTooLarge>),
) -> std::result::Result<(), FrameTooLarge> {
	if let Some(batch) = batch {
		shared.emit(Event::Lines(batch));
	}
	outcome
}

fn oversize_reason(max_frame_bytes: usize) -> String {
	format!("EMSGSIZE: line exceeds maxFrameBytes ({max_frame_bytes} bytes)")
}
