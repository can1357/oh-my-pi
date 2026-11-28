use std::{
	ffi::c_void,
	io,
	os::fd::{IntoRawFd, OwnedFd},
	ptr,
	time::{Duration, Instant},
};

use ashpd::{
	desktop::{
		CreateSessionOptions, PersistMode, Session,
		screencast::{
			CursorMode, OpenPipeWireRemoteOptions, Screencast, SelectSourcesOptions, SourceType,
			StartCastOptions,
		},
	},
	enumflags2::BitFlags,
};
use image::RgbaImage;

use super::{
	pipewire::{self, PipeWire, PixelFormat, SpaChunk, SpaHook, SpaPod, StreamEvents, VideoFormat},
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

struct ScreenCast {
	node:     u32,
	fd:       OwnedFd,
	position: Option<(i32, i32)>,
	size:     Option<(i32, i32)>,
	session:  Session<Screencast>,
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
			.create_session(CreateSessionOptions::default())
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
					SelectSourcesOptions::default()
						.set_cursor_mode(CursorMode::Embedded)
						.set_sources(BitFlags::from(SourceType::Monitor))
						.set_multiple(true)
						.set_restore_token(restore_token.as_deref())
						.set_persist_mode(PersistMode::ExplicitlyRevoked),
				)
				.await
				.map_err(|err| format!("ScreenCast SelectSources: {err}"))
		})
		.await?;
		let response = picker_request(async {
			portal
				.start(&session, None, StartCastOptions::default())
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
				.open_pipe_wire_remote(&session, OpenPipeWireRemoteOptions::default())
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

fn rgba_from_buffer(
	format: VideoFormat,
	chunk: SpaChunk,
	source: &[u8],
) -> Result<RgbaImage, String> {
	let VideoFormat { width, height, .. } = format;
	if width == 0 || height == 0 {
		return Err("PipeWire negotiated an empty frame".to_string());
	}
	let offset = chunk.offset as usize;
	let bytes = chunk.size as usize;
	let stride = chunk.stride;
	if stride <= 0 {
		return Err(format!("PipeWire returned unsupported frame stride {stride}"));
	}
	let stride = stride as usize;
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

/// What the stream callbacks share with the loop waiting for a frame.
struct Listener {
	pw:     &'static PipeWire,
	stream: *mut pipewire::Stream,
	pixels: bool,
	format: Option<VideoFormat>,
	frame:  Option<CoreResult<CapturedFrame>>,
}

static STREAM_EVENTS: StreamEvents = StreamEvents::new(on_param_changed, on_process);

unsafe extern "C" fn on_param_changed(data: *mut c_void, id: u32, param: *const SpaPod) {
	if id != pipewire::SPA_PARAM_FORMAT || param.is_null() {
		return;
	}
	// SAFETY: `data` is the stream's live `Listener`, and PipeWire calls back
	// only from inside `pipewire::iterate`, while nothing else borrows it.
	let listener = unsafe { &mut *data.cast::<Listener>() };
	// SAFETY: PipeWire passes a valid POD for the duration of the call.
	if let Some(format) = pipewire::parse_video_format(unsafe { pipewire::pod_bytes(param) }) {
		listener.format = Some(format);
	}
}

unsafe extern "C" fn on_process(data: *mut c_void) {
	// SAFETY: as in `on_param_changed`.
	let listener = unsafe { &mut *data.cast::<Listener>() };
	if listener.frame.is_some() {
		return;
	}
	let pw = listener.pw;
	// SAFETY: `stream` is live while its listener is registered.
	let buffer = unsafe { (pw.pw_stream_dequeue_buffer)(listener.stream) };
	if buffer.is_null() {
		return;
	}
	// SAFETY: `buffer` stays dequeued until it is queued back below.
	if let Some(plane) = unsafe { pipewire::first_plane(buffer) } {
		let format = listener
			.format
			.unwrap_or(VideoFormat { format: 0, width: 0, height: 0 });
		listener.frame = Some(if format.width == 0 || format.height == 0 {
			Err(DesktopError::capture_failed("PipeWire negotiated an empty frame"))
		} else if listener.pixels {
			plane
				.with_memory(|bytes| rgba_from_buffer(format, plane.chunk, bytes))
				.unwrap_or_else(|| {
					Err("PipeWire frame buffer is not memory-mapped readable".to_string())
				})
				.map(|image| CapturedFrame {
					image:  Some(image),
					width:  format.width,
					height: format.height,
				})
				.map_err(DesktopError::capture_failed)
		} else {
			// Validation needs the negotiated pixel extent, not a copy or
			// conversion of the compositor's image buffer.
			Ok(CapturedFrame { image: None, width: format.width, height: format.height })
		});
	}
	// SAFETY: `buffer` was dequeued from this stream and is no longer read.
	unsafe { (pw.pw_stream_queue_buffer)(listener.stream, buffer) };
}

/// The library objects of one capture, destroyed in reverse order of
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

fn grab_pipewire_frame(
	pw: &'static PipeWire,
	node: u32,
	fd: OwnedFd,
	pixels: bool,
) -> CoreResult<CapturedFrame> {
	control::check()?;
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
	// SAFETY: the context is live and takes the fd, closing it on disconnect or
	// failure.
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
	// SAFETY: `dict` and its strings outlive the call, which copies them. The
	// stream takes ownership of the properties.
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
		pixels,
		format: None,
		frame: None,
	}));
	let format = pipewire::enum_format();
	let mut params = [format.as_ptr().cast::<SpaPod>()];
	// SAFETY: the stream is live; the hook and listener stay allocated until
	// `Connection::drop` has destroyed the stream; the events table is static;
	// the stream copies `params` during the call.
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
			pipewire::PW_STREAM_FLAG_AUTOCONNECT | pipewire::PW_STREAM_FLAG_MAP_BUFFERS,
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
	let deadline = Instant::now() + FRAME_TIMEOUT;
	loop {
		control::check()?;
		// SAFETY: the callbacks run only inside `pipewire::iterate`, so nothing
		// else borrows the listener here.
		if let Some(result) = unsafe { (*connection.listener).frame.take() } {
			return result;
		}
		if Instant::now() >= deadline {
			return Err(DesktopError::capture_failed("PipeWire frame timed out"));
		}
		// SAFETY: `pw_loop` belongs to this thread's live main loop.
		if unsafe { pipewire::iterate(pw_loop, Duration::from_millis(10)) } < 0 {
			return Err(DesktopError::capture_failed("PipeWire loop failed before producing a frame"));
		}
	}
}

fn capture_stream(
	pw: pipewire::Loaded,
	pixels: bool,
) -> CoreResult<(CapturedFrame, super::PortalGeometry)> {
	control::check()?;
	let pw = pw.map_err(|reason| {
		DesktopError::capture_failed(format!(
			"Wayland capture needs PipeWire's client library: {reason}"
		))
	})?;
	let runtime = super::portal::portal_runtime()?;
	let ScreenCast { node, fd, position, size, session } = runtime.block_on(open_screencast())?;
	let captured = grab_pipewire_frame(pw, node, fd, pixels);
	let _ = runtime.block_on(async {
		tokio::time::timeout(crate::desktop::CLOSE_TIMEOUT, session.close()).await
	});
	control::check()?;
	let captured = captured?;
	let geometry = super::PortalGeometry::new(position, size, captured.width, captured.height);
	Ok((captured, geometry))
}

pub(super) fn capture(pw: pipewire::Loaded) -> CoreResult<(RgbaImage, super::PortalGeometry)> {
	let (frame, geometry) = capture_stream(pw, true)?;
	let image = frame
		.image
		.ok_or_else(|| DesktopError::internal("PipeWire capture omitted pixels"))?;
	Ok((image, geometry))
}

pub(super) fn geometry(pw: pipewire::Loaded) -> CoreResult<super::PortalGeometry> {
	capture_stream(pw, false).map(|(_, geometry)| geometry)
}

#[cfg(test)]
mod tests {
	use futures::FutureExt;

	use super::*;

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
		let result = control::with_token_for_test(&token, || geometry(Err("not loaded")));
		assert_eq!(result.unwrap_err().code, token.check().unwrap_err().code);
	}
}
