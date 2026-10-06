//! `ScreenCaptureKit` runs in a persistent native main-loop process: Bun does
//! not reliably deliver its image callbacks. Pixels travel over private pipes,
//! without per-shot process startup or temporary images. macOS 12/13 use
//! Quartz.

use std::{
	cell::RefCell,
	io::{self, BufRead, BufReader, BufWriter, Read, Write},
	os::fd::AsRawFd,
	process::{Child, ChildStdin, ChildStdout, Command, Stdio},
	sync::LazyLock,
	time::{Duration, Instant},
};

use image::RgbaImage;
use objc2_core_foundation::{CGPoint, CGRect, CGSize};
use objc2_core_graphics::{
	CGBitmapContextCreate, CGColorSpace, CGContext, CGImage, CGImageAlphaInfo, CGImageByteOrderInfo,
	kCGColorSpaceSRGB,
};
use objc2_foundation::NSProcessInfo;
use serde::{Deserialize, Serialize};

use crate::desktop::{
	control,
	error::{CoreResult, DesktopError},
	frame::MAX_COMPOSITE_PIXELS,
	native_helper::HelperDirectory,
};

const CAPTURE_TIMEOUT: Duration = Duration::from_secs(5);
const HELPER: &[u8] = include_bytes!(env!("OMP_CAPTURE_DARWIN_HELPER"));
static MODERN_CAPTURE: LazyLock<bool> = LazyLock::new(|| {
	NSProcessInfo::processInfo()
		.operatingSystemVersion()
		.majorVersion
		>= 14
});

thread_local! {
	// Each native DesktopSession owns its request thread, so its helper cannot
	// outlive that thread or contend with another session's pipe protocol.
	static CLIENT: RefCell<Option<CaptureClient>> = const { RefCell::new(None) };
}

pub(super) fn available() -> bool {
	!*MODERN_CAPTURE || !HELPER.is_empty()
}

#[derive(Clone, Copy, Serialize)]
#[serde(tag = "kind", content = "id", rename_all = "lowercase")]
pub(super) enum CaptureTarget {
	Window(u32),
	Display(u32),
}

#[derive(Clone, Copy, Serialize)]
pub(super) struct CaptureRequest {
	#[serde(flatten)]
	pub target: CaptureTarget,
	/// Quartz compatibility captures have no accompanying fresh geometry.
	#[serde(skip)]
	pub bounds: CGRect,
}

pub(super) struct Captured {
	pub image:  RgbaImage,
	pub bounds: CGRect,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Batch<'a> {
	requests:   &'a [CaptureRequest],
	max_pixels: u64,
}

#[derive(Deserialize)]
struct Bounds {
	x:      f64,
	y:      f64,
	width:  f64,
	height: f64,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum Reply {
	Frame {
		index:       usize,
		width:       u32,
		height:      u32,
		#[serde(rename = "byteLength")]
		byte_length: usize,
		bounds:      Bounds,
	},
	Error {
		code:  String,
		error: String,
	},
}

struct CaptureClient {
	child:      Child,
	input:      BufWriter<ChildStdin>,
	output:     BufReader<ChildStdout>,
	header:     Vec<u8>,
	_directory: HelperDirectory,
}

impl CaptureClient {
	fn start() -> CoreResult<Self> {
		control::check()?;
		let directory = HelperDirectory::create("omp-capture")?;
		let executable = directory.write("omp-capture-helper", HELPER, 0o700)?;
		let mut child = Command::new(executable)
			.stdin(Stdio::piped())
			.stdout(Stdio::piped())
			.stderr(Stdio::null())
			.spawn()
			.map_err(io_error)?;
		let (Some(input), Some(output)) = (child.stdin.take(), child.stdout.take()) else {
			let _ = child.kill();
			let _ = child.wait();
			return Err(DesktopError::internal("capture worker pipes are missing"));
		};
		let fd = output.as_raw_fd();
		// SAFETY: stdout owns this live descriptor; nonblocking reads let every
		// pipe wait honor the operation's cancellation token and deadline.
		let configured = unsafe {
			let flags = libc::fcntl(fd, libc::F_GETFL);
			flags >= 0 && libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) == 0
		};
		if !configured {
			let error = io_error(io::Error::last_os_error());
			let _ = child.kill();
			let _ = child.wait();
			return Err(error);
		}
		Ok(Self {
			child,
			input: BufWriter::new(input),
			output: BufReader::new(output),
			header: Vec::new(),
			_directory: directory,
		})
	}

	fn capture(&mut self, requests: &[CaptureRequest]) -> CoreResult<Vec<Captured>> {
		control::check()?;
		let deadline = Instant::now() + CAPTURE_TIMEOUT;
		serde_json::to_writer(&mut self.input, &Batch { requests, max_pixels: MAX_COMPOSITE_PIXELS })
			.map_err(|error| {
				DesktopError::internal(format!("cannot encode capture request: {error}"))
			})?;
		self.input.write_all(b"\n").map_err(io_error)?;
		self.input.flush().map_err(io_error)?;
		let mut captures = Vec::with_capacity(requests.len());
		for expected_index in 0..requests.len() {
			let reply = read_header(&mut self.output, &mut self.header, deadline)?;
			let Reply::Frame { index, width, height, byte_length, bounds } = reply else {
				let Reply::Error { code, error } = reply else {
					unreachable!()
				};
				return Err(match code.as_str() {
					"PermissionDenied" => DesktopError::permission_denied(error),
					"WindowNotFound" => DesktopError::window_not_found(error),
					"InvalidTarget" => DesktopError::invalid_target(error),
					"Unsupported" => DesktopError::unsupported(error),
					_ => DesktopError::capture_failed(error),
				});
			};
			let expected_bytes = frame_bytes(width, height)?;
			if index != expected_index
				|| byte_length != expected_bytes
				|| ![bounds.x, bounds.y, bounds.width, bounds.height]
					.iter()
					.all(|value| value.is_finite())
				|| bounds.width <= 0.0
				|| bounds.height <= 0.0
			{
				return Err(DesktopError::capture_failed(
					"capture worker returned inconsistent frame metadata",
				));
			}
			let mut pixels = read_pixels(&mut self.output, byte_length, deadline)?;
			unpremultiply(&mut pixels);
			let image = RgbaImage::from_raw(width, height, pixels).ok_or_else(|| {
				DesktopError::capture_failed("capture worker returned an invalid pixel buffer")
			})?;
			captures.push(Captured {
				image,
				bounds: CGRect::new(
					CGPoint::new(bounds.x, bounds.y),
					CGSize::new(bounds.width, bounds.height),
				),
			});
		}
		Ok(captures)
	}
}

impl Drop for CaptureClient {
	fn drop(&mut self) {
		let _ = self.child.kill();
		let _ = self.child.wait();
	}
}

fn check_capture_deadline(deadline: Instant) -> CoreResult<()> {
	control::check()?;
	if Instant::now() >= deadline {
		return Err(DesktopError::timeout(
			"ScreenCaptureKit worker exceeded its five-second deadline",
		));
	}
	Ok(())
}

fn wait_readable(output: &BufReader<ChildStdout>, deadline: Instant) -> CoreResult<()> {
	check_capture_deadline(deadline)?;
	let remaining = deadline.saturating_duration_since(Instant::now());
	let mut descriptor =
		libc::pollfd { fd: output.get_ref().as_raw_fd(), events: libc::POLLIN, revents: 0 };
	let milliseconds = i32::try_from(remaining.as_millis().min(20))
		.unwrap_or(20)
		.max(1);
	// SAFETY: One initialized pollfd points to the reader's live descriptor.
	let result = unsafe { libc::poll(&mut descriptor, 1, milliseconds) };
	if result < 0 {
		let error = io::Error::last_os_error();
		if error.kind() != io::ErrorKind::Interrupted {
			return Err(io_error(error));
		}
	}
	control::check()
}

fn read_header(
	output: &mut BufReader<ChildStdout>,
	header: &mut Vec<u8>,
	deadline: Instant,
) -> CoreResult<Reply> {
	header.clear();
	loop {
		check_capture_deadline(deadline)?;
		let remaining = 65_537usize.saturating_sub(header.len());
		let result = output
			.by_ref()
			.take(remaining as u64)
			.read_until(b'\n', header);
		if header.len() > 65_536 {
			return Err(DesktopError::capture_failed(
				"native capture header exceeds its safety limit",
			));
		}
		match result {
			Ok(0) => {
				return Err(DesktopError::capture_failed(
					"native capture worker exited before returning a frame",
				));
			},
			Ok(_) if header.last() == Some(&b'\n') => break,
			Ok(_) => {},
			Err(error) if error.kind() == io::ErrorKind::Interrupted => {},
			Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
				wait_readable(output, deadline)?;
			},
			Err(error) => return Err(io_error(error)),
		}
	}
	serde_json::from_slice(header).map_err(|error| {
		DesktopError::capture_failed(format!("invalid native capture response: {error}"))
	})
}

fn read_pixels(
	output: &mut BufReader<ChildStdout>,
	length: usize,
	deadline: Instant,
) -> CoreResult<Vec<u8>> {
	let mut pixels = Vec::with_capacity(length);
	while pixels.len() < length {
		check_capture_deadline(deadline)?;
		let remaining = (length - pixels.len()).min(256 * 1024);
		match output
			.by_ref()
			.take(remaining as u64)
			.read_to_end(&mut pixels)
		{
			Ok(0) => {
				return Err(DesktopError::capture_failed(
					"native capture worker returned a truncated image",
				));
			},
			Ok(_) => {},
			Err(error) if error.kind() == io::ErrorKind::Interrupted => {},
			Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
				wait_readable(output, deadline)?;
			},
			Err(error) => return Err(io_error(error)),
		}
	}
	Ok(pixels)
}

fn io_error(error: io::Error) -> DesktopError {
	DesktopError::capture_failed(format!("native capture transport failed: {error}"))
}

fn frame_bytes(width: u32, height: u32) -> CoreResult<usize> {
	if width == 0 || height == 0 || u64::from(width) * u64::from(height) > MAX_COMPOSITE_PIXELS {
		return Err(DesktopError::capture_failed(
			"native screenshot dimensions exceed the safety limit",
		));
	}
	usize::try_from(u64::from(width) * u64::from(height) * 4)
		.map_err(|_| DesktopError::capture_failed("native screenshot byte length overflow"))
}

pub(super) fn capture(requests: Vec<CaptureRequest>) -> CoreResult<Vec<Captured>> {
	control::check()?;
	if !super::capture_permission() {
		return Err(DesktopError::permission_denied(
			"macOS Screen Recording permission is not granted for this process",
		));
	}
	if !*MODERN_CAPTURE {
		return requests
			.into_iter()
			.map(|request| {
				control::check()?;
				legacy_capture(request).map(|image| Captured { image, bounds: request.bounds })
			})
			.collect();
	}
	if requests.is_empty() {
		return Err(DesktopError::capture_failed("no native capture targets"));
	}
	CLIENT.with_borrow_mut(|slot| {
		if slot.is_none() {
			*slot = Some(CaptureClient::start()?);
		}
		let result = slot
			.as_mut()
			.expect("capture client was initialized")
			.capture(&requests);
		if result.is_err() {
			*slot = None;
		}
		result
	})
}

#[allow(deprecated, reason = "native compatibility path only for macOS before 14")]
fn legacy_capture(request: CaptureRequest) -> CoreResult<RgbaImage> {
	use objc2_core_graphics::{
		CGDisplayCreateImage, CGRectNull, CGWindowImageOption, CGWindowListCreateImage,
		CGWindowListOption,
	};
	let image = match request.target {
		CaptureTarget::Display(id) => CGDisplayCreateImage(id),
		CaptureTarget::Window(id) => {
			// SAFETY: CGRectNull is process-lived; capture the named window's full bounds.
			CGWindowListCreateImage(
				unsafe { CGRectNull },
				CGWindowListOption::OptionIncludingWindow,
				id,
				CGWindowImageOption::BoundsIgnoreFraming | CGWindowImageOption::BestResolution,
			)
		},
	}
	.ok_or_else(|| {
		if super::capture_permission() {
			DesktopError::capture_failed("CoreGraphics returned no screenshot")
		} else {
			DesktopError::permission_denied("macOS Screen Recording permission was revoked")
		}
	})?;
	rgba_image(&image)
}

fn pixel_dimensions(width: f64, height: f64, scale: f64) -> CoreResult<(u32, u32)> {
	let width = (width * scale).ceil();
	let height = (height * scale).ceil();
	if !scale.is_finite()
		|| scale <= 0.0
		|| !width.is_finite()
		|| !height.is_finite()
		|| width < 1.0
		|| height < 1.0
		|| width > f64::from(u32::MAX)
		|| height > f64::from(u32::MAX)
		|| width * height > MAX_COMPOSITE_PIXELS as f64
	{
		return Err(DesktopError::capture_failed(
			"native screenshot dimensions exceed the safety limit",
		));
	}
	Ok((width as u32, height as u32))
}

fn rgba_image(image: &CGImage) -> CoreResult<RgbaImage> {
	let (width, height) = pixel_dimensions(
		CGImage::width(Some(image)) as f64,
		CGImage::height(Some(image)) as f64,
		1.0,
	)?;
	let stride = width as usize * 4;
	let mut pixels = vec![0u8; frame_bytes(width, height)?];
	// SAFETY: sRGB is a process-lived constant on every supported OS.
	let space = CGColorSpace::with_name(Some(unsafe { kCGColorSpaceSRGB }))
		.ok_or_else(|| DesktopError::capture_failed("could not create sRGB color space"))?;
	// SAFETY: The buffer covers stride*height bytes and stays exclusively owned
	// and fixed in memory until the context is dropped.
	let context = unsafe {
		CGBitmapContextCreate(
			pixels.as_mut_ptr().cast(),
			width as usize,
			height as usize,
			8,
			stride,
			Some(&space),
			CGImageAlphaInfo::PremultipliedLast.0 | CGImageByteOrderInfo::Order32Big.0,
		)
	}
	.ok_or_else(|| DesktopError::capture_failed("could not create screenshot bitmap context"))?;
	CGContext::draw_image(
		Some(&context),
		CGRect::new(CGPoint::new(0.0, 0.0), CGSize::new(f64::from(width), f64::from(height))),
		Some(image),
	);
	drop(context);
	unpremultiply(&mut pixels);
	RgbaImage::from_raw(width, height, pixels)
		.ok_or_else(|| DesktopError::capture_failed("invalid native screenshot buffer"))
}

fn unpremultiply(pixels: &mut [u8]) {
	for pixel in pixels.as_chunks_mut::<4>().0 {
		let alpha = u32::from(pixel[3]);
		match alpha {
			0 => pixel[..3].fill(0),
			255 => {},
			_ => {
				for channel in &mut pixel[..3] {
					*channel = ((u32::from(*channel) * 255 + alpha / 2) / alpha).min(255) as u8;
				}
			},
		}
	}
}

#[cfg(test)]
mod tests {
	use super::{frame_bytes, pixel_dimensions, unpremultiply};

	#[test]
	fn rgba_preserves_opacity_and_unpremultiplies_transparent_edges() {
		let mut pixels = [12, 34, 56, 255, 64, 32, 0, 128, 9, 8, 7, 0, 255, 0, 0, 1];
		unpremultiply(&mut pixels);
		assert_eq!(pixels, [12, 34, 56, 255, 128, 64, 0, 128, 0, 0, 0, 0, 255, 0, 0, 1]);
	}

	#[test]
	fn hidpi_dimensions_round_outward_and_reject_invalid_or_oversized_frames() {
		assert_eq!(pixel_dimensions(500.25, 336.0, 2.0).unwrap(), (1001, 672));
		for (width, height, scale) in
			[(0.0, 1.0, 1.0), (1.0, 1.0, f64::NAN), (1.0, 1.0, 0.0), (1e9, 1e9, 2.0)]
		{
			assert!(pixel_dimensions(width, height, scale).is_err());
		}
		assert!(frame_bytes(0, 10).is_err());
		assert!(frame_bytes(u32::MAX, u32::MAX).is_err());
	}
}
