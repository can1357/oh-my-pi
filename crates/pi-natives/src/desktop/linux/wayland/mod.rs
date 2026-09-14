#[cfg(feature = "wayland-pipewire")]
mod capture;
mod libei;
mod portal;

use image::RgbaImage;

use crate::desktop::{
	backend::{AxBackend, Backend, DeliveryMode, PointerEvent},
	error::{CoreResult, DesktopError},
	frame::FrameGeometry,
	keys::KeyName,
	linux::ax::AtSpiAx,
	types::{
		CaptureCaps, DesktopCapabilities, DesktopDisplay, DesktopWindow, DisplaySelector, Target,
	},
};

/// Logical monitor geometry from the portal ScreenCast stream, paired with the
/// physical PipeWire buffer size.
///
/// The captured buffer is in physical pixels, while libei and AT-SPI address
/// the monitor in the compositor's logical coordinate space. On a scaled
/// monitor the two differ (e.g. a 2560×2880 buffer for a 1280×1440 logical
/// region at scale 2), so clicks must be mapped through the logical geometry
/// instead of treating buffer pixels as logical coordinates.
#[cfg(any(feature = "wayland-pipewire", test))]
#[derive(Debug, Clone, Copy)]
struct PortalGeometry {
	logical_x:      i32,
	logical_y:      i32,
	logical_width:  u32,
	logical_height: u32,
	pixel_width:    u32,
	pixel_height:   u32,
}

#[cfg(any(feature = "wayland-pipewire", test))]
impl PortalGeometry {
	/// Build from the portal stream's `position`/`size` and the captured buffer
	/// dimensions. A missing or degenerate logical size falls back to the buffer
	/// size (scale 1), preserving behaviour on compositors that omit the
	/// mapping.
	fn new(
		position: Option<(i32, i32)>,
		size: Option<(i32, i32)>,
		pixel_width: u32,
		pixel_height: u32,
	) -> Self {
		let (logical_x, logical_y) = position.unwrap_or((0, 0));
		let (logical_width, logical_height) = match size {
			Some((w, h)) if w > 0 && h > 0 => (w as u32, h as u32),
			_ => (pixel_width, pixel_height),
		};
		Self { logical_x, logical_y, logical_width, logical_height, pixel_width, pixel_height }
	}

	/// Synthetic single-monitor display describing the captured buffer, with
	/// logical bounds and scale derived from the portal geometry.
	fn display(&self) -> DesktopDisplay {
		let scale = f64::from(self.pixel_width) / f64::from(self.logical_width.max(1));
		DesktopDisplay {
			id: "wayland-portal-0".to_string(),
			name: "Wayland portal monitor".to_string(),
			x: self.logical_x,
			y: self.logical_y,
			width: self.logical_width.max(1),
			height: self.logical_height.max(1),
			scale,
			pixel_x: 0,
			pixel_y: 0,
			pixel_width: self.pixel_width,
			pixel_height: self.pixel_height,
			is_primary: true,
		}
	}

	/// Convert a window's logical bounds (global compositor coordinates) into a
	/// pixel crop rectangle within the captured buffer. Returns `None` when the
	/// window lies outside the captured monitor.
	fn window_crop(&self, window: &DesktopWindow) -> Option<(u32, u32, u32, u32)> {
		let scale_x = f64::from(self.pixel_width) / f64::from(self.logical_width.max(1));
		let scale_y = f64::from(self.pixel_height) / f64::from(self.logical_height.max(1));
		let rel_x = window.x - self.logical_x;
		let rel_y = window.y - self.logical_y;
		if rel_x < 0 || rel_y < 0 {
			return None;
		}
		let px_x = (f64::from(rel_x) * scale_x).round() as u32;
		let px_y = (f64::from(rel_y) * scale_y).round() as u32;
		if px_x >= self.pixel_width || px_y >= self.pixel_height {
			return None;
		}
		let px_width = (f64::from(window.width) * scale_x).round().max(1.0) as u32;
		let px_height = (f64::from(window.height) * scale_y).round().max(1.0) as u32;
		let width = px_width.min(self.pixel_width - px_x);
		let height = px_height.min(self.pixel_height - px_y);
		if width == 0 || height == 0 {
			return None;
		}
		Some((px_x, px_y, width, height))
	}
}

pub struct WaylandBackend {
	#[cfg_attr(
		not(feature = "wayland-pipewire"),
		expect(dead_code, reason = "only read by the pipewire capture path")
	)]
	display:     DisplaySelector,
	ax:          Option<AtSpiAx>,
	ax_error:    Option<DesktopError>,
	input:       Option<libei::Libei>,
	input_error: Option<DesktopError>,
	displays:    Vec<DesktopDisplay>,
}

impl WaylandBackend {
	pub fn new(display: DisplaySelector) -> Self {
		// Remove the world-readable RemoteDesktop restore token that pre-#7884
		// builds wrote during read-only calls; nothing reads it anymore (#7884).
		portal::remove_orphaned_remote_desktop_token();
		let (ax, ax_error) = match AtSpiAx::new() {
			Ok(ax) => (Some(ax), None),
			Err(err) => (None, Some(err)),
		};
		Self { display, ax, ax_error, input: None, input_error: None, displays: Vec::new() }
	}

	fn window_input_error(target: &Target, kind: &str) -> CoreResult<()> {
		if let Target::Window(id) = target {
			return Err(DesktopError::background_unavailable(format!(
				"window {id} wayland-compositor-focus-only: Wayland cannot programmatically activate \
				 a non-focused window for {kind}; only the currently focused surface is reachable; \
				 use ax actions or desktop input"
			)));
		}
		Ok(())
	}

	fn prepare_input(&mut self, target: &Target, kind: &str) -> CoreResult<&mut libei::Libei> {
		Self::window_input_error(target, kind)?;
		if self.input.is_none() && self.input_error.is_none() {
			match libei::Libei::new() {
				Ok(input) => self.input = Some(input),
				Err(err) => self.input_error = Some(err),
			}
		}
		if let Some(input) = self.input.as_mut() {
			return Ok(input);
		}
		Err(self.input_error.clone().unwrap_or_else(|| {
			DesktopError::permission_denied(
				"RemoteDesktop portal or LIBEI_SOCKET is required for Wayland input",
			)
		}))
	}

	#[cfg(feature = "wayland-pipewire")]
	fn selected_display_allowed(&self) -> CoreResult<()> {
		match &self.display {
			DisplaySelector::All => Ok(()),
			DisplaySelector::Id(id) if id == "wayland-portal-0" => Ok(()),
			DisplaySelector::Id(id) => Err(DesktopError::invalid_target(format!(
				"Wayland portal display '{id}' is unavailable; use 'all' or 'wayland-portal-0'"
			))),
		}
	}
}

impl Backend for WaylandBackend {
	fn capabilities(&mut self) -> DesktopCapabilities {
		let input_permission = if self.input.is_some() {
			"granted"
		} else if self.input_error.is_some() {
			"unavailable"
		} else {
			"prompt-or-granted"
		};
		DesktopCapabilities {
			backend: "wayland".to_string(),
			display_server: Some("wayland".to_string()),
			// The PipeWire screencast path is compiled in only under the
			// wayland-pipewire feature; without it capture() hard-errors, so the
			// capability report must not advertise a capture the binary cannot do.
			capture: cfg!(feature = "wayland-pipewire"),
			input: self.input_error.is_none(),
			ax: self.ax.is_some(),
			background_window_input: false,
			delivery_modes: vec!["background".to_string()],
			capture_permission: if cfg!(feature = "wayland-pipewire") {
				"prompt-or-granted".to_string()
			} else {
				"unavailable".to_string()
			},
			input_permission: input_permission.to_string(),
			ax_permission: if self.ax.is_some() {
				"granted".to_string()
			} else {
				"unavailable".to_string()
			},
			display_count: self.displays.len() as u32,
		}
	}

	fn displays(&mut self) -> CoreResult<Vec<DesktopDisplay>> {
		Ok(self.displays.clone())
	}

	fn windows(&mut self) -> CoreResult<Vec<DesktopWindow>> {
		self
			.ax
			.as_mut()
			.ok_or_else(|| {
				self
					.ax_error
					.clone()
					.unwrap_or_else(DesktopError::ax_unsupported)
			})?
			.windows()
	}

	fn capture(
		&mut self,
		target: &Target,
		_caps: &CaptureCaps,
	) -> CoreResult<(RgbaImage, FrameGeometry)> {
		#[cfg(not(feature = "wayland-pipewire"))]
		{
			let _ = target;
			Err(DesktopError::capture_failed("Wayland capture requires the wayland-pipewire feature"))
		}
		#[cfg(feature = "wayland-pipewire")]
		{
			self.selected_display_allowed()?;
			let (image, geometry) = capture::capture()?;
			self.displays = vec![geometry.display()];
			match target {
				Target::Desktop => Ok((image, FrameGeometry::for_displays(&self.displays))),
				Target::Window(id) => {
					let window = self
						.windows()?
						.into_iter()
						.find(|window| &window.id == id)
						.ok_or_else(|| {
							DesktopError::window_not_found(format!("Wayland window {id} not found"))
						})?;
					let (x, y, width, height) = geometry.window_crop(&window).ok_or_else(|| {
						DesktopError::capture_failed(format!(
							"Wayland window {id} is outside the selected portal monitor"
						))
					})?;
					let cropped = image::imageops::crop_imm(&image, x, y, width, height).to_image();
					let frame = FrameGeometry::for_window(&window, cropped.width(), cropped.height());
					Ok((cropped, frame))
				},
			}
		}
	}

	fn pointer(
		&mut self,
		target: &Target,
		ev: PointerEvent,
		_frame: &FrameGeometry,
		_mode: DeliveryMode,
	) -> CoreResult<()> {
		self.prepare_input(target, "pointer input")?.pointer(ev)
	}

	fn type_text(&mut self, target: &Target, text: &str, _mode: DeliveryMode) -> CoreResult<()> {
		self
			.prepare_input(target, "keyboard input")?
			.type_text(text)
	}

	fn key_chord(
		&mut self,
		target: &Target,
		keys: &[KeyName],
		_mode: DeliveryMode,
	) -> CoreResult<()> {
		self
			.prepare_input(target, "keyboard input")?
			.key_chord(keys)
	}

	fn raise_window(&mut self, id: &str) -> CoreResult<()> {
		Err(DesktopError::background_unavailable(format!(
			"window {id} wayland-compositor-focus-only: Wayland cannot programmatically activate a \
			 non-focused window; only the currently focused surface is reachable"
		)))
	}

	fn ax(&mut self) -> Option<&mut dyn AxBackend> {
		self.ax.as_mut().map(|ax| ax as &mut dyn AxBackend)
	}
}

#[cfg(test)]
mod tests {
	use std::{
		io::ErrorKind,
		os::unix::net::UnixListener,
		sync::{Mutex, mpsc},
		thread,
	};

	use super::*;

	static LIBEI_ENV_LOCK: Mutex<()> = Mutex::new(());

	fn backend_without_services() -> WaylandBackend {
		WaylandBackend {
			display:     DisplaySelector::All,
			ax:          None,
			ax_error:    None,
			input:       None,
			input_error: None,
			displays:    Vec::new(),
		}
	}
	fn with_fake_libei(action: impl FnOnce(&mut WaylandBackend)) -> bool {
		let _guard = LIBEI_ENV_LOCK.lock().expect("lock LIBEI_SOCKET test");
		let socket = std::env::temp_dir().join(format!("omp-libei-test-{}", std::process::id()));
		let _ = std::fs::remove_file(&socket);
		let listener = UnixListener::bind(&socket).expect("bind fake libei socket");
		listener
			.set_nonblocking(true)
			.expect("make fake libei socket nonblocking");
		let (stop_tx, stop_rx) = mpsc::channel();
		let accepted = thread::spawn(move || {
			loop {
				match listener.accept() {
					Ok(_) => return true,
					Err(err) if err.kind() == ErrorKind::WouldBlock => {
						if !matches!(
							stop_rx.recv_timeout(std::time::Duration::from_millis(10)),
							Err(mpsc::RecvTimeoutError::Timeout)
						) {
							return false;
						}
					},
					Err(err) => panic!("fake libei listener: {err}"),
				}
			}
		});
		let previous = std::env::var_os("LIBEI_SOCKET");
		unsafe { std::env::set_var("LIBEI_SOCKET", &socket) };
		let mut backend = WaylandBackend::new(DisplaySelector::All);
		action(&mut backend);
		let _ = stop_tx.send(());
		if let Some(previous) = previous {
			unsafe { std::env::set_var("LIBEI_SOCKET", previous) };
		} else {
			unsafe { std::env::remove_var("LIBEI_SOCKET") };
		}
		let connected = accepted.join().expect("fake libei listener");
		let _ = std::fs::remove_file(socket);
		connected
	}

	#[test]
	fn readonly_backend_creation_does_not_connect_to_libei() {
		let mut capabilities = None;
		let connected = with_fake_libei(|backend| capabilities = Some(backend.capabilities()));
		assert!(!connected, "read-only backend construction connected to libei");
		let capabilities = capabilities.expect("Wayland capabilities");
		assert!(capabilities.input);
		assert_eq!(capabilities.input_permission, "prompt-or-granted");
	}

	#[test]
	fn desktop_input_connects_to_libei_lazily() {
		let connected = with_fake_libei(|backend| {
			let _ = backend.type_text(&Target::Desktop, "hello", DeliveryMode::Foreground);
		});
		assert!(connected, "desktop input did not connect to libei");
	}

	#[test]
	fn window_foreground_delivery_reports_compositor_constraint() {
		let mut backend = backend_without_services();
		let target = Target::Window("w1".to_string());
		let err = backend
			.type_text(&target, "hello", DeliveryMode::Foreground)
			.expect_err("window foreground input must fail");
		assert_eq!(err.code.as_str(), "BackgroundUnavailable");
		assert_eq!(
			err.message,
			"window w1 wayland-compositor-focus-only: Wayland cannot programmatically activate a \
			 non-focused window for keyboard input; only the currently focused surface is reachable; \
			 use ax actions or desktop input"
		);
	}

	#[test]
	fn window_raise_reports_compositor_constraint() {
		let mut backend = backend_without_services();
		let err = backend
			.raise_window("w1")
			.expect_err("Wayland window raise must fail");
		assert_eq!(err.code.as_str(), "BackgroundUnavailable");
		assert_eq!(
			err.message,
			"window w1 wayland-compositor-focus-only: Wayland cannot programmatically activate a \
			 non-focused window; only the currently focused surface is reachable"
		);
	}

	#[test]
	fn capabilities_do_not_advertise_foreground_delivery() {
		let mut backend = backend_without_services();
		assert_eq!(backend.capabilities().delivery_modes, ["background"]);
	}

	#[test]
	#[cfg(not(feature = "wayland-pipewire"))]
	fn capabilities_report_no_capture_without_pipewire_feature() {
		let mut backend = WaylandBackend {
			display:     DisplaySelector::All,
			ax:          None,
			ax_error:    None,
			input:       None,
			input_error: None,
			displays:    Vec::new(),
		};
		let caps = backend.capabilities();
		// Shipped builds compile without wayland-pipewire, so the capture path is
		// absent; capabilities() must not advertise capture the binary cannot do.
		assert!(!caps.capture, "capture must be false when the pipewire feature is off");
		assert_eq!(caps.capture_permission, "unavailable");
		let err = backend
			.capture(&Target::Desktop, &CaptureCaps::default())
			.expect_err("capture must fail without the pipewire feature");
		assert_eq!(err.code.as_str(), "CaptureFailed");
	}

	fn portal_window(id: &str, x: i32, y: i32, width: u32, height: u32) -> DesktopWindow {
		DesktopWindow {
			id: id.into(),
			title: "T".into(),
			app: "A".into(),
			pid: None,
			x,
			y,
			width,
			height,
			focused: false,
		}
	}

	#[test]
	fn scaled_monitor_maps_screenshot_pixel_to_logical_point() {
		// 2560x2880 buffer for a 1280x1440 logical region at scale 2 (issue #11540).
		let geometry = PortalGeometry::new(Some((0, 0)), Some((1280, 1440)), 2560, 2880);
		let display = geometry.display();
		assert_eq!((display.width, display.height), (1280, 1440));
		assert!((display.scale - 2.0).abs() < f64::EPSILON);
		let frame = FrameGeometry::for_displays(&[display]);
		// A lower-half click that the old identity mapping pushed outside the
		// 1280x1440 input region now lands inside it.
		let (lx, ly) = frame.map_point(1066.0, 1867.0, None).unwrap();
		assert!((lx - 533.0).abs() < 1e-6, "logical x {lx}");
		assert!((ly - 933.5).abs() < 1e-6, "logical y {ly}");
		assert!(lx < 1280.0 && ly < 1440.0, "mapped point must stay inside the logical region");
	}

	#[test]
	fn monitor_offset_is_added_to_logical_point() {
		let geometry = PortalGeometry::new(Some((100, 50)), Some((1280, 1440)), 2560, 2880);
		let frame = FrameGeometry::for_displays(&[geometry.display()]);
		assert_eq!(frame.map_point(1280.0, 1440.0, None).unwrap(), (740.0, 770.0));
	}

	#[test]
	fn missing_portal_size_falls_back_to_buffer_scale_one() {
		let geometry = PortalGeometry::new(None, None, 1920, 1080);
		let display = geometry.display();
		assert_eq!((display.x, display.y), (0, 0));
		assert_eq!((display.width, display.height), (1920, 1080));
		assert!((display.scale - 1.0).abs() < f64::EPSILON);
		// Degenerate (zero) portal dimensions take the same fallback.
		let degenerate = PortalGeometry::new(Some((0, 0)), Some((0, 0)), 1920, 1080);
		assert_eq!(degenerate.display().width, 1920);
	}

	#[test]
	fn window_crop_scales_logical_bounds_to_buffer_pixels() {
		let geometry = PortalGeometry::new(Some((0, 0)), Some((1280, 1440)), 2560, 2880);
		let crop = geometry
			.window_crop(&portal_window("w", 100, 200, 300, 400))
			.expect("window inside monitor");
		assert_eq!(crop, (200, 400, 600, 800));
	}

	#[test]
	fn window_crop_rejects_window_outside_monitor() {
		let geometry = PortalGeometry::new(Some((0, 0)), Some((1280, 1440)), 2560, 2880);
		assert!(
			geometry
				.window_crop(&portal_window("w", 2000, 0, 100, 100))
				.is_none()
		);
		assert!(
			geometry
				.window_crop(&portal_window("w", -10, 0, 100, 100))
				.is_none()
		);
	}
}
