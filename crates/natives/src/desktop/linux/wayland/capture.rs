use std::{
	ffi::{CStr, c_char, c_int, c_void},
	io,
	os::fd::{IntoRawFd, OwnedFd},
	ptr,
	sync::Arc,
	thread,
	time::{Duration, Instant},
};

use ashpd::desktop::{
	PersistMode, Session,
	screencast::{CursorMode, Screencast, SourceType},
};
use image::RgbaImage;

use super::{
	PortalGeometry,
	pipewire::{self, PipeWire, PixelFormat, Plane, SpaHook, SpaPod, StreamEvents, VideoFormat},
	portal::{read_token, store_token, until_deadline},
};
use crate::desktop::{
	control,
	error::{CoreResult, DesktopError},
};

const SCREENCAST_TOKEN: &str = "screencast-token";
/// Bounds each `ScreenCast` portal step that does not wait on the user.
const PORTAL_TIMEOUT: Duration = Duration::from_secs(30);
const FRAME_TIMEOUT: Duration = Duration::from_secs(5);
/// The `Timeout` a `ScreenCast` step waiting on the share picker ends with.
/// The step may also have been waiting on the portal itself, so it does not
/// claim a picker was shown.
const PICKER_UNANSWERED: &str = "the screen-share portal did not answer before the call's \
                                 deadline, so nothing was captured; if it showed a screen-share \
                                 picker, which can open behind other windows, ask the user to \
                                 answer it, then retry";
/// How long the stream stays open after the last capture asked it for a
/// frame; GNOME and KDE show their screen-sharing indicator until it closes.
const STREAM_IDLE: Duration = Duration::from_secs(120);
/// How long a capture waits for a frame newer than the last one: a change on
/// screen reaches the stream within a frame or two, and a producer that
/// sends frames only on damage sends none while nothing changes.
const NEWER_FRAME_WAIT: Duration = Duration::from_millis(100);
/// How long one turn of the stream thread waits for `PipeWire` events.
const TURN: Duration = Duration::from_millis(10);

struct ScreenCast {
	node:     u32,
	fd:       OwnedFd,
	position: Option<(i32, i32)>,
	size:     Option<(i32, i32)>,
	session:  Session<'static, Screencast<'static>>,
}

struct CapturedFrame {
	image:  Option<RgbaImage>,
	width:  u32,
	height: u32,
}

async fn portal_request<T>(request: impl Future<Output = Result<T, String>>) -> CoreResult<T> {
	control::cancellable(tokio::time::timeout(PORTAL_TIMEOUT, request))
		.await?
		.map_err(|_| DesktopError::capture_failed("Wayland ScreenCast portal timed out"))?
		.map_err(DesktopError::capture_failed)
}

/// Runs a `ScreenCast` step that can wait on the share picker, until the
/// call's deadline as the `RemoteDesktop` dialog does, rather than failing
/// each call after `PORTAL_TIMEOUT` while the picker stays open. GNOME and
/// KDE open the picker in `Start`; xdg-desktop-portal-hyprland opens it in
/// `SelectSources` and serves one request at a time, so while its picker is
/// open a later `CreateSession` waits for it too. The step is boxed so the
/// futures awaiting it stay small.
fn picker_request<'a, T: 'a>(
	request: impl Future<Output = Result<T, String>> + 'a,
) -> impl Future<Output = CoreResult<T>> + 'a {
	let request = Box::pin(request);
	async move {
		control::cancellable(until_deadline(request, PICKER_UNANSWERED))
			.await??
			.map_err(DesktopError::capture_failed)
	}
}

async fn open_screencast() -> CoreResult<ScreenCast> {
	let portal = portal_request(async {
		Screencast::new()
			.await
			.map_err(|err| format!("ScreenCast portal: {err}"))
	})
	.await?;
	let session = picker_request(async {
		portal
			.create_session()
			.await
			.map_err(|err| format!("ScreenCast CreateSession: {err}"))
	})
	.await?;
	let opened = async {
		let restore_token = read_token(SCREENCAST_TOKEN);
		picker_request(async {
			portal
				.select_sources(
					&session,
					CursorMode::Embedded,
					SourceType::Monitor.into(),
					true,
					restore_token.as_deref(),
					PersistMode::ExplicitlyRevoked,
				)
				.await
				.map_err(|err| format!("ScreenCast SelectSources: {err}"))
		})
		.await?;
		let response = picker_request(async {
			portal
				.start(&session, None)
				.await
				.map_err(|err| format!("ScreenCast Start: {err}"))
		})
		.await?
		.response()
		.map_err(|err| DesktopError::capture_failed(format!("ScreenCast permission: {err}")))?;
		store_token(SCREENCAST_TOKEN, response.restore_token());
		let stream = response
			.streams()
			.first()
			.ok_or_else(|| DesktopError::capture_failed("ScreenCast returned no monitor stream"))?;
		let node = stream.pipe_wire_node_id();
		let position = stream.position();
		let size = stream.size();
		let fd = portal_request(async {
			portal
				.open_pipe_wire_remote(&session)
				.await
				.map_err(|err| format!("ScreenCast OpenPipeWireRemote: {err}"))
		})
		.await?;
		Ok::<_, DesktopError>((node, fd, position, size))
	}
	.await;
	match opened {
		Ok((node, fd, position, size)) => Ok(ScreenCast { node, fd, position, size, session }),
		Err(error) => {
			let _ = tokio::time::timeout(crate::desktop::CLOSE_TIMEOUT, session.close()).await;
			Err(error)
		},
	}
}

fn rgba_from_buffer(format: VideoFormat, plane: &Plane<'_>) -> Result<RgbaImage, String> {
	let VideoFormat { width, height, .. } = format;
	if width == 0 || height == 0 {
		return Err("PipeWire negotiated an empty frame".to_string());
	}
	let offset = plane.chunk.offset as usize;
	let bytes = plane.chunk.size as usize;
	let stride = plane.chunk.stride;
	if stride <= 0 {
		return Err(format!("PipeWire returned unsupported frame stride {stride}"));
	}
	let stride = stride as usize;
	let source = plane
		.memory
		.ok_or_else(|| "PipeWire frame buffer is not memory-mapped".to_string())?;
	let end = offset
		.checked_add(bytes)
		.ok_or_else(|| "PipeWire frame size overflow".to_string())?
		.min(source.len());
	let source = source
		.get(offset..end)
		.ok_or_else(|| "PipeWire frame offset is outside the mapped buffer".to_string())?;
	let pixel = PixelFormat::from_spa(format.format)
		.ok_or_else(|| format!("PipeWire negotiated unsupported pixel format {}", format.format))?;
	let pixel_size = match pixel {
		PixelFormat::Rgb | PixelFormat::Bgr => 3,
		PixelFormat::Rgba | PixelFormat::Rgbx | PixelFormat::Bgra | PixelFormat::Bgrx => 4,
	};
	let row_bytes = (width as usize)
		.checked_mul(pixel_size)
		.ok_or_else(|| "PipeWire row size overflow".to_string())?;
	if stride < row_bytes || source.len() < stride.saturating_mul(height as usize) {
		return Err(format!(
			"PipeWire frame buffer is short: {} bytes for {width}x{height} stride {stride}",
			source.len()
		));
	}
	let mut rgba = vec![
		0;
		(width as usize)
			.saturating_mul(height as usize)
			.saturating_mul(4)
	];
	for y in 0..height as usize {
		control::check().map_err(|error| error.to_string())?;
		let row = &source[y * stride..y * stride + row_bytes];
		for x in 0..width as usize {
			let input = &row[x * pixel_size..];
			let output = &mut rgba[(y * width as usize + x) * 4..];
			match pixel {
				PixelFormat::Rgb | PixelFormat::Rgba | PixelFormat::Rgbx => {
					output[..4].copy_from_slice(&[
						input[0],
						input[1],
						input[2],
						if pixel == PixelFormat::Rgba {
							input[3]
						} else {
							255
						},
					]);
				},
				PixelFormat::Bgr | PixelFormat::Bgra | PixelFormat::Bgrx => {
					output[..4].copy_from_slice(&[
						input[2],
						input[1],
						input[0],
						if pixel == PixelFormat::Bgra {
							input[3]
						} else {
							255
						},
					]);
				},
			}
		}
	}
	RgbaImage::from_raw(width, height, rgba)
		.ok_or_else(|| "failed to construct PipeWire RGBA frame".to_string())
}

/// What the stream callbacks share with the stream thread.
struct Listener {
	pw:     &'static PipeWire,
	stream: *mut pipewire::Stream,
	format: Option<VideoFormat>,
	/// The newest buffer the producer sent, kept dequeued until a newer one
	/// arrives or the stream removes it, so the frame is at hand on a still
	/// screen without copying each one. Null before the first frame.
	held:   *mut pipewire::Buffer,
	/// Frames received since the stream opened.
	frames: u64,
	/// Why the stream stopped, once it has.
	ended:  Option<String>,
}

static STREAM_EVENTS: StreamEvents =
	StreamEvents::new(on_state_changed, on_param_changed, on_remove_buffer, on_process);

unsafe extern "C" fn on_state_changed(
	data: *mut c_void,
	old: c_int,
	state: c_int,
	error: *const c_char,
) {
	// SAFETY: `data` is the stream's live `Listener`, and PipeWire calls back
	// only from inside `pipewire::iterate`, while nothing else borrows it.
	let listener = unsafe { &mut *data.cast::<Listener>() };
	let stopped = state == pipewire::PW_STREAM_STATE_ERROR
		|| (state == pipewire::PW_STREAM_STATE_UNCONNECTED
			&& old != pipewire::PW_STREAM_STATE_UNCONNECTED);
	if stopped && listener.ended.is_none() {
		listener.ended = Some(if error.is_null() {
			"the stream disconnected".to_owned()
		} else {
			// SAFETY: PipeWire passes a NUL-terminated message for the call.
			unsafe { CStr::from_ptr(error) }
				.to_string_lossy()
				.into_owned()
		});
	}
}

unsafe extern "C" fn on_param_changed(data: *mut c_void, id: u32, param: *const SpaPod) {
	if id != pipewire::SPA_PARAM_FORMAT || param.is_null() {
		return;
	}
	// SAFETY: as in `on_state_changed`.
	let listener = unsafe { &mut *data.cast::<Listener>() };
	// SAFETY: PipeWire passes a valid POD for the duration of the call.
	if let Some(format) = pipewire::parse_video_format(unsafe { pipewire::pod_bytes(param) }) {
		listener.format = Some(format);
	}
}

unsafe extern "C" fn on_remove_buffer(data: *mut c_void, buffer: *mut pipewire::Buffer) {
	// SAFETY: as in `on_state_changed`.
	let listener = unsafe { &mut *data.cast::<Listener>() };
	// A format change or disconnect frees the buffers, the held one included.
	if listener.held == buffer {
		listener.held = ptr::null_mut();
	}
}

unsafe extern "C" fn on_process(data: *mut c_void) {
	// SAFETY: as in `on_state_changed`.
	let listener = unsafe { &mut *data.cast::<Listener>() };
	let pw = listener.pw;
	// Only the newest of the buffers waiting is kept; the rest, and the one
	// held before, go back to the producer.
	loop {
		// SAFETY: `stream` is live while its listener is registered.
		let buffer = unsafe { (pw.pw_stream_dequeue_buffer)(listener.stream) };
		if buffer.is_null() {
			break;
		}
		if !listener.held.is_null() {
			// SAFETY: `held` was dequeued from this stream and is not read.
			unsafe { (pw.pw_stream_queue_buffer)(listener.stream, listener.held) };
		}
		listener.held = buffer;
		listener.frames += 1;
	}
}

/// The library objects of one stream, destroyed in reverse order of
/// creation.
struct Connection {
	pw:        &'static PipeWire,
	main_loop: *mut pipewire::MainLoop,
	context:   *mut pipewire::Context,
	core:      *mut pipewire::Core,
	stream:    *mut pipewire::Stream,
	hook:      *mut SpaHook,
	listener:  *mut Listener,
}

impl Drop for Connection {
	fn drop(&mut self) {
		let pw = self.pw;
		// SAFETY: each pointer is null or an object this connection created and
		// still owns. Destroying the stream unlinks the hook, after which no
		// callback can reach the listener.
		unsafe {
			if !self.stream.is_null() {
				(pw.pw_stream_destroy)(self.stream);
			}
			if !self.hook.is_null() {
				drop(Box::from_raw(self.hook));
			}
			if !self.listener.is_null() {
				drop(Box::from_raw(self.listener));
			}
			if !self.core.is_null() {
				(pw.pw_core_disconnect)(self.core);
			}
			if !self.context.is_null() {
				(pw.pw_context_destroy)(self.context);
			}
			(pw.pw_main_loop_destroy)(self.main_loop);
		}
	}
}

/// The frames a stream delivers, as the stream thread sees them.
trait Feed {
	/// Dispatches what the stream has ready, waiting up to `wait`; `Err`
	/// names why the stream ended.
	fn pump(&mut self, wait: Duration) -> Result<(), String>;
	/// Frames received since the stream opened.
	fn frames(&self) -> u64;
	/// The negotiated frame size, once known.
	fn extent(&self) -> Option<(u32, u32)>;
	/// The newest frame in RGBA, once one arrived.
	fn image(&self) -> Option<CoreResult<CapturedFrame>>;
}

/// A `PipeWire` stream connected to the portal's node, dispatched on the
/// thread that created it.
struct PipeWireFeed {
	connection: Connection,
	pw_loop:    *mut pipewire::Loop,
}

impl PipeWireFeed {
	fn connect(pw: &'static PipeWire, node: u32, fd: OwnedFd) -> CoreResult<Self> {
		let failed =
			|object: &str| DesktopError::capture_failed(format!("PipeWire {object}: creation failed"));
		// SAFETY: pw_main_loop_new accepts null properties.
		let main_loop = unsafe { (pw.pw_main_loop_new)(ptr::null()) };
		if main_loop.is_null() {
			return Err(failed("main loop"));
		}
		let mut connection = Connection {
			pw,
			main_loop,
			context: ptr::null_mut(),
			core: ptr::null_mut(),
			stream: ptr::null_mut(),
			hook: ptr::null_mut(),
			listener: ptr::null_mut(),
		};
		// SAFETY: `main_loop` is live.
		let pw_loop = unsafe { (pw.pw_main_loop_get_loop)(main_loop) };
		// SAFETY: `pw_loop` is live; null properties are accepted.
		connection.context = unsafe { (pw.pw_context_new)(pw_loop, ptr::null_mut(), 0) };
		if connection.context.is_null() {
			return Err(failed("context"));
		}
		// SAFETY: the context is live and takes the fd, closing it on disconnect
		// or failure.
		connection.core = unsafe {
			(pw.pw_context_connect_fd)(connection.context, fd.into_raw_fd(), ptr::null_mut(), 0)
		};
		if connection.core.is_null() {
			return Err(failed("remote"));
		}
		let items = [
			pipewire::SpaDictItem { key: c"media.type".as_ptr(), value: c"Video".as_ptr() },
			pipewire::SpaDictItem { key: c"media.category".as_ptr(), value: c"Capture".as_ptr() },
			pipewire::SpaDictItem { key: c"media.role".as_ptr(), value: c"Screen".as_ptr() },
		];
		let dict =
			pipewire::SpaDict { flags: 0, n_items: items.len() as u32, items: items.as_ptr() };
		// SAFETY: `dict` and its strings outlive the call, which copies them.
		// The stream takes ownership of the properties.
		connection.stream = unsafe {
			let properties = (pw.pw_properties_new_dict)(&raw const dict);
			(pw.pw_stream_new)(connection.core, c"omp-computer-capture".as_ptr(), properties)
		};
		if connection.stream.is_null() {
			return Err(failed("stream"));
		}
		connection.hook = Box::into_raw(Box::new(SpaHook::new()));
		connection.listener = Box::into_raw(Box::new(Listener {
			pw,
			stream: connection.stream,
			format: None,
			held: ptr::null_mut(),
			frames: 0,
			ended: None,
		}));
		let format = pipewire::enum_format();
		let mut params = [format.as_ptr().cast::<SpaPod>()];
		// SAFETY: the stream is live; the hook and listener stay allocated until
		// `Connection::drop` has destroyed the stream; the events table is
		// static; the stream copies `params` during the call. `DONT_RECONNECT`
		// ends the stream when the shared node goes away rather than linking it
		// to another video source.
		let connected = unsafe {
			(pw.pw_stream_add_listener)(
				connection.stream,
				connection.hook,
				&raw const STREAM_EVENTS,
				connection.listener.cast(),
			);
			(pw.pw_stream_connect)(
				connection.stream,
				pipewire::SPA_DIRECTION_INPUT,
				node,
				pipewire::PW_STREAM_FLAG_AUTOCONNECT
					| pipewire::PW_STREAM_FLAG_MAP_BUFFERS
					| pipewire::PW_STREAM_FLAG_DONT_RECONNECT,
				params.as_mut_ptr(),
				params.len() as u32,
			)
		};
		if connected < 0 {
			return Err(DesktopError::capture_failed(format!(
				"PipeWire connect: {}",
				io::Error::from_raw_os_error(-connected)
			)));
		}
		Ok(Self { connection, pw_loop })
	}

	fn listener(&self) -> &Listener {
		// SAFETY: the callbacks run only inside `pipewire::iterate`, so nothing
		// else borrows the listener here.
		unsafe { &*self.connection.listener }
	}
}

impl Feed for PipeWireFeed {
	fn pump(&mut self, wait: Duration) -> Result<(), String> {
		// SAFETY: `pw_loop` belongs to this thread's live main loop.
		if unsafe { pipewire::iterate(self.pw_loop, wait) } < 0 {
			return Err("its PipeWire loop failed".to_owned());
		}
		self.listener().ended.clone().map_or(Ok(()), Err)
	}

	fn frames(&self) -> u64 {
		self.listener().frames
	}

	fn extent(&self) -> Option<(u32, u32)> {
		self
			.listener()
			.format
			.map(|format| (format.width, format.height))
	}

	fn image(&self) -> Option<CoreResult<CapturedFrame>> {
		let listener = self.listener();
		if listener.held.is_null() {
			return None;
		}
		let format = listener
			.format
			.filter(|format| format.width > 0 && format.height > 0);
		// SAFETY: `held` stays dequeued until the callbacks run again, inside
		// `pump`, which cannot run while this borrow lives.
		let plane = unsafe { pipewire::first_plane(listener.held) };
		Some(match (format, plane) {
			(None, _) => Err(DesktopError::capture_failed("PipeWire negotiated an empty frame")),
			(Some(_), None) => Err(DesktopError::capture_failed("PipeWire frame has no data plane")),
			(Some(format), Some(plane)) => rgba_from_buffer(format, &plane)
				.map(|image| CapturedFrame {
					image:  Some(image),
					width:  format.width,
					height: format.height,
				})
				.map_err(DesktopError::capture_failed),
		})
	}
}

/// A capture's request to the stream thread: pixels, or for `pixels: false`
/// only the frame size, which validating coordinates needs.
struct FrameRequest {
	pixels: bool,
	reply:  flume::Sender<CoreResult<CapturedFrame>>,
}

struct Pending {
	request: FrameRequest,
	/// `Feed::frames` when the request arrived.
	seen:    u64,
	asked:   Instant,
}

/// The stream thread's loop. It keeps reading frames so the newest is at
/// hand, and answers each request with a frame newer than the request or,
/// when none comes within `NEWER_FRAME_WAIT`, with the newest one, which a
/// producer sending only on damage leaves current. It returns once the
/// stream ends, the capture side is gone, or `STREAM_IDLE` passes without a
/// request. When the stream ends, every capture waiting on it fails, so none
/// of them opens a new stream in its place.
fn serve(
	feed: &mut impl Feed,
	requests: &flume::Receiver<FrameRequest>,
	now: impl Fn() -> Instant,
) {
	let mut idle_since = now();
	let mut pending: Option<Pending> = None;
	loop {
		if let Err(why) = feed.pump(TURN) {
			for request in pending
				.map(|pending| pending.request)
				.into_iter()
				.chain(requests.drain())
			{
				let _ = request.reply.send(Err(ended(&why)));
			}
			return;
		}
		// A cancelled capture stops waiting for its frame.
		if pending
			.as_ref()
			.is_some_and(|pending| pending.request.reply.is_disconnected())
		{
			pending = None;
			idle_since = now();
		}
		if pending.is_none() {
			match requests.try_recv() {
				Ok(request) => pending = Some(Pending { request, seen: feed.frames(), asked: now() }),
				Err(flume::TryRecvError::Empty) => {
					if now().saturating_duration_since(idle_since) >= STREAM_IDLE {
						return;
					}
					continue;
				},
				Err(flume::TryRecvError::Disconnected) => return,
			}
		}
		if let Some(answer) = pending
			.as_ref()
			.and_then(|pending| answer(feed, pending, now()))
			&& let Some(pending) = pending.take()
		{
			let _ = pending.request.reply.send(answer);
			idle_since = now();
		}
	}
}

/// The answer to `pending` at `now`, or `None` while it should wait.
fn answer(feed: &impl Feed, pending: &Pending, now: Instant) -> Option<CoreResult<CapturedFrame>> {
	let waited = now.saturating_duration_since(pending.asked);
	if !pending.request.pixels {
		if let Some((width, height)) = feed.extent() {
			return Some(Ok(CapturedFrame { image: None, width, height }));
		}
	} else if (feed.frames() > pending.seen || (feed.frames() > 0 && waited >= NEWER_FRAME_WAIT))
		&& let Some(image) = feed.image()
	{
		return Some(image);
	}
	(waited >= FRAME_TIMEOUT).then(|| Err(DesktopError::capture_failed("PipeWire frame timed out")))
}

fn ended(why: &str) -> DesktopError {
	DesktopError::capture_failed(format!(
		"the screen share ended before a frame was captured ({why}); it may have been stopped from \
		 the desktop. The next capture asks the portal again, which may show the share picker"
	))
}

/// An open `ScreenCast` stream and the thread reading it.
struct Live {
	requests: flume::Sender<FrameRequest>,
	position: Option<(i32, i32)>,
	size:     Option<(i32, i32)>,
	thread:   Option<thread::JoinHandle<()>>,
}

impl Live {
	/// Opens a stream through the portal, as every capture did before
	/// streams were kept, and starts the thread that reads it and closes its
	/// portal session when it returns.
	fn open(pw: &'static PipeWire) -> CoreResult<Self> {
		let runtime = super::portal::portal_runtime()?;
		let ScreenCast { node, fd, position, size, session } = runtime.block_on(open_screencast())?;
		let session = Arc::new(session);
		let close = move |session: &Session<'static, Screencast<'static>>| {
			let _ = runtime.block_on(async {
				tokio::time::timeout(crate::desktop::CLOSE_TIMEOUT, session.close()).await
			});
		};
		let (requests, inbox) = flume::unbounded::<FrameRequest>();
		let spawned = thread::Builder::new()
			.name("omp-screencast".to_owned())
			.spawn({
				let session = Arc::clone(&session);
				move || {
					match PipeWireFeed::connect(pw, node, fd) {
						Ok(mut feed) => serve(&mut feed, &inbox, Instant::now),
						Err(error) => {
							if let Ok(request) = inbox.recv() {
								let _ = request.reply.send(Err(error));
							}
						},
					}
					// Requests sent from here on find the stream closed.
					drop(inbox);
					close(&session);
				}
			});
		match spawned {
			Ok(thread) => Ok(Self { requests, position, size, thread: Some(thread) }),
			Err(err) => {
				close(&session);
				Err(DesktopError::internal(format!("ScreenCast stream thread: {err}")))
			},
		}
	}

	fn closed(&self) -> bool {
		self.requests.is_disconnected()
	}

	/// The stream's answer, or `None` when it closed before answering.
	fn request(&self, pixels: bool) -> CoreResult<Option<CapturedFrame>> {
		let (reply, answer) = flume::bounded(1);
		if self.requests.send(FrameRequest { pixels, reply }).is_err() {
			return Ok(None);
		}
		loop {
			control::check()?;
			match answer.recv_timeout(TURN) {
				Ok(frame) => return frame.map(Some),
				Err(flume::RecvTimeoutError::Timeout) => {},
				Err(flume::RecvTimeoutError::Disconnected) => return Ok(None),
			}
		}
	}
}

impl Drop for Live {
	fn drop(&mut self) {
		// Disconnecting the requests ends the thread, which closes the stream
		// and its portal session.
		self.requests = flume::bounded(0).0;
		if let Some(thread) = self.thread.take() {
			let _ = thread.join();
		}
	}
}

/// The `ScreenCast` stream captures read, kept open between them: a producer
/// that sends frames only on damage (xdg-desktop-portal-hyprland, -wlr) sends
/// none to a new stream on a still screen. A stream that closed after
/// `STREAM_IDLE`, or that the user or the portal ended, is replaced only when
/// a capture asks, through the same portal request the first one made.
#[derive(Default)]
pub(super) struct Cast {
	live: Option<Live>,
}

impl Cast {
	pub(super) fn capture(
		&mut self,
		pw: pipewire::Loaded,
	) -> CoreResult<(RgbaImage, PortalGeometry)> {
		control::check()?;
		let pw = loaded(pw)?;
		let (frame, geometry) = self.capture_with(|| Live::open(pw))?;
		let image = frame
			.image
			.ok_or_else(|| DesktopError::internal("PipeWire capture omitted pixels"))?;
		Ok((image, geometry))
	}

	pub(super) fn geometry(&mut self, pw: pipewire::Loaded) -> CoreResult<PortalGeometry> {
		control::check()?;
		let pw = loaded(pw)?;
		self.geometry_with(|| Live::open(pw))
	}

	/// Captures from the kept stream, or a new one when there is none. A
	/// stream that fails a capture (no frame in time, the share ended) is
	/// closed, so the next capture asks the portal for a new one rather than
	/// waiting on it again.
	fn capture_with(
		&mut self,
		mut open: impl FnMut() -> CoreResult<Live>,
	) -> CoreResult<(CapturedFrame, PortalGeometry)> {
		// A stream can close between the check and the request; the second
		// turn opens a new one.
		for _ in 0..2 {
			let live = match self.live.take() {
				Some(live) if !live.closed() => live,
				_ => open()?,
			};
			if let Some(frame) = live.request(true)? {
				let geometry = PortalGeometry::new(live.position, live.size, frame.width, frame.height);
				if !live.closed() {
					self.live = Some(live);
				}
				return Ok((frame, geometry));
			}
		}
		Err(stream_closed())
	}

	/// Validating coordinates needs the layout as it is now, and the portal
	/// reports an output's position and size only when a stream starts, while
	/// an output can move under a kept stream. So validation opens a new stream
	/// and compares: on an unchanged layout the kept stream stays, with the
	/// frame it holds, since a new one gets no frame on a still screen until
	/// something changes; on a changed one the new stream replaces it.
	fn geometry_with(
		&mut self,
		open: impl FnOnce() -> CoreResult<Live>,
	) -> CoreResult<PortalGeometry> {
		let fresh = open()?;
		let frame = fresh.request(false)?.ok_or_else(stream_closed)?;
		let geometry = PortalGeometry::new(fresh.position, fresh.size, frame.width, frame.height);
		let unchanged = self.live.as_ref().is_some_and(|live| {
			live.position == fresh.position
				&& live.size == fresh.size
				&& matches!(
					live.request(false),
					Ok(Some(kept)) if (kept.width, kept.height) == (frame.width, frame.height)
				)
		});
		if !unchanged {
			self.live = (!fresh.closed()).then_some(fresh);
		}
		Ok(geometry)
	}
}

fn loaded(pw: pipewire::Loaded) -> CoreResult<&'static PipeWire> {
	pw.map_err(|reason| {
		DesktopError::capture_failed(format!(
			"Wayland capture needs PipeWire's client library: {reason}"
		))
	})
}

fn stream_closed() -> DesktopError {
	DesktopError::capture_failed("the ScreenCast stream closed before it answered")
}

#[cfg(test)]
mod tests {
	use futures::FutureExt;

	use std::{cell::Cell, collections::VecDeque, rc::Rc};

	use super::*;
	use crate::desktop::error::ErrorCode;

	/// A `ScreenCast` step that can show the picker waits until the call's
	/// deadline and then names the picker, and passes a portal error through
	/// as it is.
	#[test]
	fn a_picker_step_waits_until_the_deadline_and_passes_portal_errors_through() {
		let runtime = tokio::runtime::Builder::new_current_thread()
			.enable_time()
			.build()
			.unwrap();
		// The run leaves only the session-close budget, so the step gives up on
		// its first poll; one bounded by `PORTAL_TIMEOUT` would still be pending.
		let ending = control::CancellationSource::default();
		ending.set_deadline(Some(std::time::Instant::now() + crate::desktop::CLOSE_TIMEOUT));
		let (unanswered, failed) = control::with_token_for_test(&ending.token(), || {
			runtime.block_on(async {
				(
					picker_request(std::future::pending::<Result<(), String>>()).now_or_never(),
					picker_request(async { Err::<(), _>("x".to_owned()) }).now_or_never(),
				)
			})
		});
		let error = unanswered.expect("the wait must end at once").unwrap_err();
		assert_eq!(error.code.as_str(), "Timeout");
		assert_eq!(error.message, PICKER_UNANSWERED);
		let error = failed
			.expect("a portal error ends the step at once")
			.unwrap_err();
		assert_eq!(error.code.as_str(), "CaptureFailed");
		assert_eq!(error.message, "x");
	}

	#[test]
	fn cancelled_geometry_refresh_never_opens_a_portal_session() {
		let source = control::CancellationSource::default();
		let token = source.token();
		source.cancel();
		let result =
			control::with_token_for_test(&token, || Cast::default().geometry(Err("not loaded")));
		assert_eq!(result.unwrap_err().code, token.check().unwrap_err().code);
	}

	enum Step {
		Frame,
		/// The held frame goes away (a format change frees its buffer).
		Lost,
		Quiet,
		End(&'static str),
	}

	/// A stream that takes one step of `script` per turn, each turn taking the
	/// wait it is given on `clock`, and ends when the script does.
	struct Scripted {
		script: VecDeque<Step>,
		frames: u64,
		held:   bool,
		clock:  Rc<Cell<Instant>>,
	}

	impl Scripted {
		fn new(script: impl IntoIterator<Item = Step>) -> Self {
			Self {
				script: script.into_iter().collect(),
				frames: 0,
				held:   false,
				clock:  Rc::new(Cell::new(Instant::now())),
			}
		}

		fn serve(&mut self, requests: &flume::Receiver<FrameRequest>) {
			let clock = Rc::clone(&self.clock);
			serve(self, requests, move || clock.get());
		}
	}

	impl Feed for Scripted {
		fn pump(&mut self, wait: Duration) -> Result<(), String> {
			self.clock.set(self.clock.get() + wait);
			match self.script.pop_front() {
				Some(Step::Frame) => {
					self.frames += 1;
					self.held = true;
				},
				Some(Step::Lost) => self.held = false,
				Some(Step::Quiet) => {},
				Some(Step::End(why)) => return Err(why.to_owned()),
				None => return Err("the script ended".to_owned()),
			}
			Ok(())
		}

		fn frames(&self) -> u64 {
			self.frames
		}

		fn extent(&self) -> Option<(u32, u32)> {
			Some((1, 1))
		}

		fn image(&self) -> Option<CoreResult<CapturedFrame>> {
			self.held.then(|| Ok(frame()))
		}
	}

	fn frame() -> CapturedFrame {
		CapturedFrame { image: Some(RgbaImage::new(1, 1)), width: 1, height: 1 }
	}

	fn quiet(turns: Duration) -> impl Iterator<Item = Step> {
		std::iter::repeat_with(|| Step::Quiet).take((turns.as_millis() / TURN.as_millis()) as usize)
	}

	fn ask(requests: &flume::Sender<FrameRequest>) -> flume::Receiver<CoreResult<CapturedFrame>> {
		let (reply, answer) = flume::bounded(1);
		requests.send(FrameRequest { pixels: true, reply }).unwrap();
		answer
	}

	/// A stream whose thread answers every request with `reply(pixels)`.
	fn replying(position: (i32, i32), reply: fn(bool) -> CoreResult<CapturedFrame>) -> Live {
		let (requests, inbox) = flume::unbounded::<FrameRequest>();
		let thread = thread::spawn(move || {
			while let Ok(request) = inbox.recv() {
				let _ = request.reply.send(reply(request.pixels));
			}
		});
		Live { requests, position: Some(position), size: Some((1, 1)), thread: Some(thread) }
	}

	fn answering(position: (i32, i32)) -> Live {
		replying(position, |_| Ok(frame()))
	}

	/// A new stream on a still screen: it knows its size, but no frame comes.
	fn opened_on_a_still_screen(position: (i32, i32)) -> Live {
		replying(position, |pixels| {
			if pixels {
				Err(DesktopError::capture_failed("PipeWire frame timed out"))
			} else {
				Ok(CapturedFrame { image: None, width: 1, height: 1 })
			}
		})
	}

	/// On a still screen the producer sends one frame and then nothing; every
	/// later capture gets that frame instead of timing out.
	#[test]
	fn a_still_screen_is_captured_from_the_last_frame_the_stream_sent() {
		let (requests, inbox) = flume::unbounded();
		let answers = [ask(&requests), ask(&requests), ask(&requests)];
		Scripted::new(std::iter::once(Step::Frame).chain(quiet(NEWER_FRAME_WAIT * 4))).serve(&inbox);
		for answer in answers {
			let captured = answer.recv().unwrap().expect("the held frame");
			assert!(captured.image.is_some());
		}
	}

	/// The stream closes once `STREAM_IDLE` has passed since the last request
	/// was answered, and not a turn earlier.
	#[test]
	fn the_stream_closes_once_it_has_been_idle_for_the_idle_time() {
		let (requests, inbox) = flume::unbounded();
		let answer = ask(&requests);
		let mut feed = Scripted::new(
			std::iter::once(Step::Frame).chain(quiet(NEWER_FRAME_WAIT + STREAM_IDLE + TURN * 50)),
		);
		let opened = feed.clock.get();
		feed.serve(&inbox);
		answer.recv().unwrap().expect("the frame");
		let answered = opened + TURN + NEWER_FRAME_WAIT;
		assert_eq!(feed.clock.get() - answered, STREAM_IDLE);
		drop(requests);
	}

	/// A held frame that goes away with no new one still ends the capture
	/// at `FRAME_TIMEOUT` rather than leaving it waiting.
	#[test]
	fn a_capture_whose_held_frame_went_away_times_out() {
		let (requests, inbox) = flume::unbounded();
		let answer = ask(&requests);
		let mut feed =
			Scripted::new(std::iter::once(Step::Lost).chain(quiet(FRAME_TIMEOUT + TURN * 10)));
		feed.frames = 1;
		feed.serve(&inbox);
		let error = answer.recv().unwrap().err().expect("the capture times out");
		assert!(error.message.contains("timed out"), "{}", error.message);
	}

	/// Every capture waiting when the share stops (from the desktop's
	/// indicator, or the portal closing it) fails, queued ones included, and
	/// the closed stream is not opened again until the next capture asks,
	/// through the portal like the first.
	#[test]
	fn a_stopped_share_fails_its_waiting_captures_and_reopens_only_for_the_next() {
		let (requests, inbox) = flume::unbounded();
		let answers = [ask(&requests), ask(&requests)];
		Scripted::new([Step::End("the node was removed")]).serve(&inbox);
		for answer in answers {
			let error = answer.recv().unwrap().err().expect("the capture fails");
			assert_eq!(error.code, ErrorCode::CaptureFailed);
			assert!(error.message.contains("the node was removed"), "{}", error.message);
		}
		drop(inbox);

		let mut cast =
			Cast { live: Some(Live { requests, position: None, size: None, thread: None }) };
		let opened = Cell::new(0);
		let (captured, _) = cast
			.capture_with(|| {
				opened.set(opened.get() + 1);
				Ok(answering((0, 0)))
			})
			.expect("the next capture opens a new stream");
		assert!(captured.image.is_some());
		assert_eq!(opened.get(), 1);
	}

	/// A kept stream that fails a capture is closed rather than kept, so the
	/// next capture opens a new one instead of waiting on it again (a share
	/// left unlinked by an older `WirePlumber` sends no more frames).
	#[test]
	fn a_kept_stream_that_fails_a_capture_is_closed() {
		let mut cast = Cast {
			live: Some(replying((0, 0), |_| {
				Err(DesktopError::capture_failed("PipeWire frame timed out"))
			})),
		};
		let Err(error) = cast.capture_with(|| unreachable!("the kept stream answers")) else {
			panic!("the capture fails");
		};
		assert!(error.message.contains("timed out"), "{}", error.message);
		assert!(cast.live.is_none());
	}

	/// Coordinate validation on a moved output replaces the kept stream with
	/// the new one, which reports the layout as it is now.
	#[test]
	fn validation_replaces_the_kept_stream_when_the_layout_changed() {
		let mut cast = Cast { live: Some(answering((0, 0))) };
		let geometry = cast.geometry_with(|| Ok(answering((1920, 0)))).unwrap();
		let expected = PortalGeometry::new(Some((1920, 0)), Some((1, 1)), 1, 1);
		assert_eq!(format!("{geometry:?}"), format!("{expected:?}"));
		assert_eq!(cast.live.as_ref().and_then(|live| live.position), Some((1920, 0)));
	}

	/// Coordinate validation on an unchanged layout keeps the kept stream, so
	/// a screenshot after a click on a still screen still gets its frame.
	#[test]
	fn validation_keeps_the_kept_stream_when_the_layout_is_unchanged() {
		let mut cast = Cast { live: Some(answering((0, 0))) };
		cast
			.geometry_with(|| Ok(opened_on_a_still_screen((0, 0))))
			.unwrap();
		let (captured, _) = cast
			.capture_with(|| unreachable!("the kept stream answers"))
			.expect("the kept stream's frame");
		assert!(captured.image.is_some());
	}
}
