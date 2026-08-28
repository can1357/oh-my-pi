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
	fn synthetic_display(image: &RgbaImage) -> DesktopDisplay {
		DesktopDisplay {
			id:           "wayland-portal-0".to_string(),
			name:         "Wayland portal monitor".to_string(),
			x:            0,
			y:            0,
			width:        image.width(),
			height:       image.height(),
			scale:        1.0,
			pixel_x:      0,
			pixel_y:      0,
			pixel_width:  image.width(),
			pixel_height: image.height(),
			is_primary:   true,
		}
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
			let image = capture::capture()?;
			let display = Self::synthetic_display(&image);
			self.displays = vec![display.clone()];
			match target {
				Target::Desktop => {
					let geometry = FrameGeometry::for_displays(&self.displays);
					Ok((image, geometry))
				},
				Target::Window(id) => {
					let window = self
						.windows()?
						.into_iter()
						.find(|window| &window.id == id)
						.ok_or_else(|| {
							DesktopError::window_not_found(format!("Wayland window {id} not found"))
						})?;
					if window.x < 0 || window.y < 0 {
						return Err(DesktopError::capture_failed(
							"Wayland portal monitor stream cannot crop a window outside the selected \
							 monitor",
						));
					}
					let x = window.x as u32;
					let y = window.y as u32;
					let width = window.width.min(image.width().saturating_sub(x));
					let height = window.height.min(image.height().saturating_sub(y));
					if width == 0 || height == 0 {
						return Err(DesktopError::capture_failed(format!(
							"Wayland window {id} is outside the selected portal monitor"
						)));
					}
					let cropped = image::imageops::crop_imm(&image, x, y, width, height).to_image();
					let geometry = FrameGeometry::for_window(&window, cropped.width(), cropped.height());
					Ok((cropped, geometry))
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
}
