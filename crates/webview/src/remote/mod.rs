//! Shared plumbing for engines driven over an automation protocol.
//!
//! A remote engine (the user's installed Chromium or Firefox) is spawned as a
//! child process and driven from a dedicated thread running a current-thread
//! tokio runtime. The public [`WebView`](crate::WebView) handle talks to that
//! driver through a flume command channel; the driver pushes
//! [`WebViewEvent`]s back and keeps the shared [`ViewState`] current.
//!
//! Lifecycle: [`spawn`] blocks until the driver signals readiness (engine
//! launched, socket connected, page created) or fails. Dropping the returned
//! [`RemoteView`] closes the command channel; drivers treat channel
//! disconnect as a shutdown request, terminate the engine with a bounded
//! grace period, and exit, at which point the spawn thread emits a final
//! [`WebViewEvent::Closed`] (or `Crashed`).

pub mod chromium;
pub mod firefox;
pub mod ws;

use std::{
	fs,
	io::Cursor,
	path::{Path, PathBuf},
	sync::{
		Arc,
		atomic::{AtomicBool, Ordering},
	},
	thread::{self, JoinHandle},
	time::Duration,
};

use bytes::Bytes;
use flume::Receiver;
use omp_core::{IntoStr, Str, encoding::base64, sf};
use tokio::runtime;
use zune_jpeg::zune_core::{colorspace::ColorSpace, options::DecoderOptions};

use crate::{
	Error, Result,
	event::{Frame, SharedState, WebViewEvent},
	input::Input,
	options::{FrameFormat, PageOptions},
};

/// How long [`spawn`] waits for the driver to become operational.
const LAUNCH_TIMEOUT: Duration = Duration::from_secs(30);

/// A request from the public handle to the engine driver.
pub enum Command {
	/// Navigate the page to a URL.
	Navigate(Str),
	/// Replace the document with an HTML string.
	LoadHtml(Str),
	/// Evaluate JavaScript; `reply` (if any) receives the JSON-encoded result.
	Eval {
		/// Script source.
		js:    Str,
		/// Result callback, invoked on the driver thread.
		reply: Option<Box<dyn FnOnce(Str) + Send>>,
	},
	/// Return the engine's native accessibility tree.
	AccessibilityTree {
		/// Completion channel.
		reply: flume::Sender<Result<serde_json::Value>>,
	},
	/// Set local files on a file-input element.
	UploadFiles {
		/// JavaScript expression resolving to the input element.
		element: Str,
		/// Canonical local paths supplied by the host.
		paths:   Vec<PathBuf>,
		/// Completion channel.
		reply:   flume::Sender<Result<()>>,
	},
	/// Capture a PNG screenshot, optionally clipped or beyond the viewport.
	Screenshot {
		/// CSS-pixel clip `[x, y, width, height]`.
		clip:      Option<[f64; 4]>,
		/// Capture the full document.
		full_page: bool,
		/// Completion channel.
		reply:     flume::Sender<Result<Bytes>>,
	},
	/// History back.
	Back,
	/// History forward.
	Forward,
	/// Reload the current page.
	Reload,
	/// Bring the page/window to the foreground.
	Focus,
	/// Forward a synthetic input event (frames surfaces).
	Input(Input),
	/// Resize the viewport (frames surfaces).
	Resize {
		/// New width in CSS pixels.
		width:  u32,
		/// New height in CSS pixels.
		height: u32,
	},
	/// Shut down the engine.
	Close,
}

/// Everything a driver needs to run a session.
pub struct DriverCtx {
	/// Commands from the public handle; disconnect means shut down.
	pub commands:  Receiver<Command>,
	/// Out-of-band forced-close signal observed even while a protocol call is
	/// waiting for its reply.
	pub cancelled: Arc<AtomicBool>,
	/// Event sink towards the host.
	pub events:    flume::Sender<WebViewEvent>,
	/// Shared url/title cache to keep current.
	pub state:     SharedState,
	/// Page configuration from the builder.
	pub page:      PageOptions,
	/// Readiness signal; a driver MUST send exactly one result here once the
	/// session is operational (or failed to become so).
	pub ready:     flume::Sender<Result<()>>,
}

/// Handle side of a remote driver: command sender plus the driver thread.
pub struct RemoteView {
	commands:  flume::Sender<Command>,
	cancelled: Arc<AtomicBool>,
	thread:    Option<JoinHandle<()>>,
}

/// Cross-thread cancellation handle for a remote browser surface.
#[derive(Clone)]
pub struct CloseHandle {
	commands:  flume::Sender<Command>,
	cancelled: Arc<AtomicBool>,
}

impl CloseHandle {
	/// Request immediate bounded browser shutdown.
	pub fn close(&self) -> Result<()> {
		self.cancelled.store(true, Ordering::Release);
		self
			.commands
			.send(Command::Close)
			.map_err(|_| Error::Closed)
	}
}

impl RemoteView {
	/// Send a command to the driver; [`Error::Closed`] once it has exited.
	pub fn send(&self, cmd: Command) -> Result<()> {
		self.commands.send(cmd).map_err(|_| Error::Closed)
	}

	/// Clone a cancellation-only handle.
	pub fn close_handle(&self) -> CloseHandle {
		CloseHandle { commands: self.commands.clone(), cancelled: Arc::clone(&self.cancelled) }
	}
}

impl Drop for RemoteView {
	fn drop(&mut self) {
		let _ = self.commands.send(Command::Close);
		if let Some(thread) = self.thread.take() {
			let _ = thread.join();
		}
	}
}

/// Spawn a driver thread and block until it is operational.
///
/// `drive` runs on a fresh current-thread tokio runtime and owns the whole
/// session; see [`DriverCtx`] for its obligations. Returns the command handle
/// plus the event receiver and shared state for the public facade.
pub fn spawn<F, Fut>(
	page: PageOptions,
	drive: F,
) -> Result<(RemoteView, Receiver<WebViewEvent>, SharedState)>
where
	F: FnOnce(DriverCtx) -> Fut + Send + 'static,
	Fut: Future<Output = Result<()>>,
{
	let launch_timeout = page.connect_timeout.unwrap_or(LAUNCH_TIMEOUT);
	let (cmd_tx, cmd_rx) = flume::unbounded();
	let cancelled = Arc::new(AtomicBool::new(false));
	let (evt_tx, evt_rx) = flume::unbounded();
	let (ready_tx, ready_rx) = flume::bounded(1);
	let state = SharedState::default();

	let ctx = DriverCtx {
		commands: cmd_rx,
		cancelled: Arc::clone(&cancelled),
		events: evt_tx.clone(),
		state: Arc::clone(&state),
		page,
		ready: ready_tx,
	};

	let thread = thread::Builder::new()
		.name("omp-webview-driver".into())
		.spawn(move || {
			let rt = match runtime::Builder::new_current_thread().enable_all().build() {
				Ok(rt) => rt,
				Err(err) => {
					let _ = ctx.ready.send(Err(Error::Io(err)));
					return;
				},
			};
			match rt.block_on(drive(ctx)) {
				Ok(()) => {
					let _ = evt_tx.send(WebViewEvent::Closed);
				},
				Err(err) => {
					tracing::warn!(error = err.kind(), "webview driver stopped unexpectedly");
					let _ = evt_tx.send(WebViewEvent::Crashed(sf!("{err}")));
				},
			}
		})
		.map_err(Error::Io)?;

	match ready_rx.recv_timeout(launch_timeout) {
		Ok(Ok(())) => {
			Ok((RemoteView { commands: cmd_tx, cancelled, thread: Some(thread) }, evt_rx, state))
		},
		Ok(Err(err)) => {
			let _ = thread.join();
			Err(err)
		},
		Err(_) => {
			// Channel-drop shutdown: the driver observes command disconnect (or
			// its own bounded connect timeout) and terminates the engine.
			drop(cmd_tx);
			Err(Error::Timeout("launching browser engine"))
		},
	}
}

/// The browsing-profile directory backing a remote session.
///
/// Ephemeral profiles live in a temp dir removed when the driver exits.
pub enum ProfileDir {
	/// Caller-provided directory that persists across sessions.
	Persistent(PathBuf),
	/// RAII temp dir; deleted on drop.
	Ephemeral(tempfile::TempDir),
}

impl ProfileDir {
	/// Filesystem path of the profile.
	pub fn path(&self) -> &Path {
		match self {
			Self::Persistent(path) => path,
			Self::Ephemeral(dir) => dir.path(),
		}
	}
}

/// Resolve the profile directory for `page`.
///
/// `incognito` forces an ephemeral profile even when a persistent one was
/// configured; remote engines have no per-view private mode we can safely
/// automate, so private browsing means "leave nothing behind".
pub fn resolve_profile(page: &PageOptions) -> Result<ProfileDir> {
	if let (false, Some(path)) = (page.incognito, &page.profile) {
		fs::create_dir_all(path)?;
		return Ok(ProfileDir::Persistent(path.clone()));
	}
	let dir = tempfile::Builder::new().prefix("omp-webview-").tempdir()?;
	Ok(ProfileDir::Ephemeral(dir))
}

/// Encode an HTML document as a `data:` URL — the natural inline-load path
/// for a protocol-driven engine.
pub fn data_url(html: &str) -> Str {
	sf!("data:text/html;base64,{}", base64::encode(html))
}

/// Decode one captured frame (screencast or screenshot) into tightly packed
/// RGBA8 rows.
pub fn decode_frame(format: FrameFormat, data: &[u8]) -> Result<Frame> {
	match format {
		FrameFormat::Png => decode_png(data),
		FrameFormat::Jpeg { .. } => decode_jpeg(data),
	}
}

/// Tight bounding box `[x, y, w, h]` (pixels) of everything differing
/// between two same-sized RGBA8 frames; `None` when they are identical.
///
/// Row extent first (whole-row `memcmp`s), then columns trimmed within the
/// changed band only — for typical small damage (caret blink, hover) this
/// touches a few rows beyond the initial scan.
pub fn damage_rect(prev: &[u8], next: &[u8], width: u32) -> Option<[u32; 4]> {
	debug_assert_eq!(prev.len(), next.len());
	let stride = width as usize * 4;
	if stride == 0 || prev.len() != next.len() {
		return None;
	}
	let rows = next.len() / stride;
	fn row(buf: &[u8], r: usize, stride: usize) -> &[u8] {
		&buf[r * stride..(r + 1) * stride]
	}
	let top = (0..rows).find(|&r| row(prev, r, stride) != row(next, r, stride))?;
	// `top` differs, so the reverse scan always terminates there.
	let bottom = (top..rows)
		.rev()
		.find(|&r| row(prev, r, stride) != row(next, r, stride))
		.unwrap_or(top);
	let (mut left, mut right) = (usize::MAX, 0);
	for r in top..=bottom {
		let (p, n) = (row(prev, r, stride), row(next, r, stride));
		if p == n {
			continue;
		}
		// Positions exist: the rows compare unequal.
		if let Some(first) = p.iter().zip(n).position(|(a, b)| a != b) {
			left = left.min(first);
		}
		if let Some(last) = p.iter().zip(n).rposition(|(a, b)| a != b) {
			right = right.max(last);
		}
	}
	let x0 = (left / 4) as u32;
	let x1 = (right / 4) as u32;
	Some([x0, top as u32, x1 - x0 + 1, (bottom - top + 1) as u32])
}

/// Decode a JPEG straight to RGBA8 (single pass; no expansion copy).
fn decode_jpeg(data: &[u8]) -> Result<Frame> {
	let options = DecoderOptions::default().jpeg_set_out_colorspace(ColorSpace::RGBA);
	let mut decoder = zune_jpeg::JpegDecoder::new_with_options(Cursor::new(data), options);
	let pixels = decoder.decode().map_err(Error::Jpeg)?;
	let (width, height) = decoder
		.dimensions()
		.ok_or_else(|| Error::Protocol("jpeg: missing dimensions".to_str()))?;
	let (width, height) = (width as u32, height as u32);
	Ok(Frame { width, height, data: Bytes::from(pixels), damage: [0, 0, width, height] })
}

/// Decode a PNG into RGBA8, expanding RGB/grayscale and normalizing
/// palette/16-bit inputs.
fn decode_png(data: &[u8]) -> Result<Frame> {
	let mut decoder = png::Decoder::new(Cursor::new(data));
	// Expand palette/low-bit images and strip 16-bit samples down to 8.
	decoder.set_transformations(png::Transformations::normalize_to_color8());
	let mut reader = decoder.read_info().map_err(Error::Png)?;
	let size = reader
		.output_buffer_size()
		.ok_or_else(|| Error::Protocol("png: oversized image".to_str()))?;
	let mut buf = vec![0u8; size];
	let info = reader.next_frame(&mut buf).map_err(Error::Png)?;
	buf.truncate(info.buffer_size());
	let data = match info.color_type {
		png::ColorType::Rgba => buf,
		png::ColorType::Rgb => {
			let mut out = Vec::with_capacity(buf.len() / 3 * 4);
			for px in buf.as_chunks::<3>().0 {
				out.extend_from_slice(px);
				out.push(0xff);
			}
			out
		},
		png::ColorType::Grayscale => {
			let mut out = Vec::with_capacity(buf.len() * 4);
			for &g in &buf {
				out.extend_from_slice(&[g, g, g, 0xff]);
			}
			out
		},
		png::ColorType::GrayscaleAlpha => {
			let mut out = Vec::with_capacity(buf.len() * 2);
			for px in buf.as_chunks::<2>().0 {
				out.extend_from_slice(&[px[0], px[0], px[0], px[1]]);
			}
			out
		},
		other => return Err(Error::Protocol(sf!("png: unsupported color type {other:?}"))),
	};
	Ok(Frame {
		width:  info.width,
		height: info.height,
		data:   Bytes::from(data),
		damage: [0, 0, info.width, info.height],
	})
}

#[cfg(test)]
mod tests {
	use super::*;

	/// Encode `pixels` as a PNG of the given color type for decode testing.
	fn encode(width: u32, height: u32, color: png::ColorType, pixels: &[u8]) -> Vec<u8> {
		let mut out = Vec::new();
		let mut enc = png::Encoder::new(&mut out, width, height);
		enc.set_color(color);
		enc.set_depth(png::BitDepth::Eight);
		let mut writer = enc.write_header().unwrap();
		writer.write_image_data(pixels).unwrap();
		drop(writer);
		out
	}

	#[test]
	fn damage_rect_identical_frames_yield_none() {
		let frame = vec![7_u8; 4 * 3 * 4];
		assert_eq!(damage_rect(&frame, &frame.clone(), 4), None);
	}

	#[test]
	fn damage_rect_tightens_to_a_single_pixel() {
		let prev = vec![0_u8; 4 * 3 * 4];
		let mut next = prev.clone();
		// Pixel (2, 1).
		next[(4 + 2) * 4 + 1] = 0xff;
		assert_eq!(damage_rect(&prev, &next, 4), Some([2, 1, 1, 1]));
	}

	#[test]
	fn damage_rect_bounds_scattered_changes() {
		let prev = vec![0_u8; 4 * 3 * 4];
		let mut next = prev.clone();
		// Pixels (0, 0) and (3, 2): the box must span both.
		next[0] = 1;
		next[(2 * 4 + 3) * 4 + 3] = 1;
		assert_eq!(damage_rect(&prev, &next, 4), Some([0, 0, 4, 3]));
	}

	#[test]
	fn decode_png_expands_rgb_to_opaque_rgba() {
		let png = encode(2, 1, png::ColorType::Rgb, &[1, 2, 3, 4, 5, 6]);
		let frame = decode_png(&png).unwrap();
		assert_eq!((frame.width, frame.height), (2, 1));
		assert_eq!(&frame.data[..], &[1, 2, 3, 0xff, 4, 5, 6, 0xff]);
	}

	#[test]
	fn decode_png_expands_grayscale_variants() {
		let gray = decode_png(&encode(1, 1, png::ColorType::Grayscale, &[7])).unwrap();
		assert_eq!(&gray.data[..], &[7, 7, 7, 0xff]);
		let ga = decode_png(&encode(1, 1, png::ColorType::GrayscaleAlpha, &[9, 128])).unwrap();
		assert_eq!(&ga.data[..], &[9, 9, 9, 128]);
	}

	#[test]
	fn decode_png_passes_rgba_through() {
		let png = encode(1, 1, png::ColorType::Rgba, &[10, 20, 30, 40]);
		let frame = decode_png(&png).unwrap();
		assert_eq!(&frame.data[..], &[10, 20, 30, 40]);
	}

	#[test]
	fn decode_png_rejects_garbage() {
		assert!(decode_png(b"not a png").is_err());
	}

	#[test]
	fn decode_jpeg_yields_rgba_pixels() {
		// 8x8 solid red, quality 90 (sips-encoded fixture).
		let jpeg = include_bytes!("fixture-red-8x8.jpg");
		let frame = decode_frame(FrameFormat::Jpeg { quality: 90 }, jpeg).unwrap();
		assert_eq!((frame.width, frame.height), (8, 8));
		assert_eq!(frame.data.len(), 8 * 8 * 4);
		for px in frame.data.as_chunks::<4>().0 {
			// Lossy: red should dominate, alpha must be opaque.
			assert!(px[0] > 0xf0 && px[1] < 0x10 && px[2] < 0x10, "not red: {px:?}");
			assert_eq!(px[3], 0xff);
		}
	}

	#[test]
	fn decode_jpeg_rejects_garbage() {
		assert!(decode_frame(FrameFormat::Jpeg { quality: 90 }, b"not a jpeg").is_err());
	}
}
