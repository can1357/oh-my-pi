#[cfg(feature = "wayland-pipewire")]
mod capture;
mod libei;
mod portal;
mod xkb;

use std::{
	cell::OnceCell,
	os::{fd::AsRawFd, unix::net::UnixStream},
	path::PathBuf,
};

use image::RgbaImage;

use crate::desktop::{
	ax::AxHandle,
	backend::{AxBackend, Backend, DeliveryMode, ElementDelivery, ElementInput, PointerEvent},
	control::{self, OperationToken},
	error::{CoreResult, DesktopError},
	frame::FrameGeometry,
	keys::KeyName,
	linux::ax::{AtSpiAx, AtSpiWindow, resolve_focus},
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
	/// pixel crop rectangle within the captured buffer.
	///
	/// # Errors
	/// `CaptureFailed` when the toolkit could not report the window's global
	/// position (native Wayland clients answer with window-relative `0,0`, which
	/// would crop whatever sits at the monitor's top-left), or when the window
	/// lies outside the captured monitor.
	fn window_crop(&self, window: &AtSpiWindow) -> CoreResult<(u32, u32, u32, u32)> {
		let AtSpiWindow { window, position_known } = window;
		if !position_known {
			return Err(DesktopError::capture_failed(format!(
				"Wayland window {} has no known screen position: its toolkit reports window-relative \
				 AT-SPI coordinates, so it cannot be located in the portal capture; capture the \
				 desktop instead",
				window.id
			)));
		}
		let outside = || {
			DesktopError::capture_failed(format!(
				"Wayland window {} is outside the selected portal monitor",
				window.id
			))
		};
		let scale_x = f64::from(self.pixel_width) / f64::from(self.logical_width.max(1));
		let scale_y = f64::from(self.pixel_height) / f64::from(self.logical_height.max(1));
		let rel_x = window.x - self.logical_x;
		let rel_y = window.y - self.logical_y;
		if rel_x < 0 || rel_y < 0 {
			return Err(outside());
		}
		let px_x = (f64::from(rel_x) * scale_x).round() as u32;
		let px_y = (f64::from(rel_y) * scale_y).round() as u32;
		if px_x >= self.pixel_width || px_y >= self.pixel_height {
			return Err(outside());
		}
		let px_width = (f64::from(window.width) * scale_x).round().max(1.0) as u32;
		let px_height = (f64::from(window.height) * scale_y).round().max(1.0) as u32;
		let width = px_width.min(self.pixel_width - px_x);
		let height = px_height.min(self.pixel_height - px_y);
		if width == 0 || height == 0 {
			return Err(outside());
		}
		Ok((px_x, px_y, width, height))
	}
}

pub struct WaylandBackend {
	#[cfg_attr(
		not(feature = "wayland-pipewire"),
		expect(dead_code, reason = "only read by the pipewire capture path")
	)]
	display:           DisplaySelector,
	ax:                Option<AtSpiAx>,
	ax_error:          Option<DesktopError>,
	input:             Option<libei::Libei>,
	/// Why native input can never work here, probed once without a prompt;
	/// `None` when it may.
	input_unavailable: OnceCell<Option<String>>,
	displays:          Vec<DesktopDisplay>,
	/// The PID that listens on the Wayland socket: gnome-shell on GNOME, whose
	/// own AT-SPI frames never count as the focused application window. On
	/// Plasma it is `kwin_wayland_wrapper`, which owns no frames.
	compositor_pid:    Option<u32>,
}

/// Reads the compositor's PID from the peer credentials of its Wayland socket.
fn compositor_pid() -> Option<u32> {
	let display = PathBuf::from(std::env::var_os("WAYLAND_DISPLAY")?);
	let path = if display.is_absolute() {
		display
	} else {
		PathBuf::from(std::env::var_os("XDG_RUNTIME_DIR")?).join(display)
	};
	let socket = UnixStream::connect(path).ok()?;
	let mut credentials = libc::ucred { pid: 0, uid: 0, gid: 0 };
	let mut length = size_of::<libc::ucred>() as libc::socklen_t;
	// SAFETY: `credentials` and `length` are live, correctly sized out-params
	// for SO_PEERCRED on a connected Unix socket; the kernel keeps no pointer.
	let status = unsafe {
		libc::getsockopt(
			socket.as_raw_fd(),
			libc::SOL_SOCKET,
			libc::SO_PEERCRED,
			(&raw mut credentials).cast(),
			&raw mut length,
		)
	};
	(status == 0 && credentials.pid > 0).then_some(credentials.pid as u32)
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
		Self {
			display,
			ax,
			ax_error,
			input: None,
			input_unavailable: OnceCell::new(),
			displays: Vec::new(),
			compositor_pid: compositor_pid(),
		}
	}

	/// Read on every call: a `LIBEI_SOCKET` set later in the session reaches
	/// EIS directly, whatever the cached portal probe found.
	fn input_unavailable(&self) -> Option<&str> {
		if std::env::var_os("LIBEI_SOCKET").is_some() {
			return None;
		}
		self
			.input_unavailable
			.get_or_init(portal::input_unavailable_reason)
			.as_deref()
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

	fn run_input(
		&mut self,
		target: &Target,
		kind: &str,
		action: impl FnOnce(&mut libei::Libei) -> CoreResult<()>,
	) -> CoreResult<()> {
		control::check()?;
		Self::window_input_error(target, kind)?;
		if self.input.is_none() {
			if let Some(reason) = self.input_unavailable() {
				return Err(DesktopError::permission_denied(reason));
			}
			self.input = Some(libei::Libei::new()?);
		}
		let input = self.input.as_mut().expect("libei was initialized");
		let result = action(input);
		if input.disconnected() {
			self.input = None;
		}
		result
	}

	fn atspi_windows(&self) -> CoreResult<Vec<AtSpiWindow>> {
		self
			.ax
			.as_ref()
			.ok_or_else(|| {
				self
					.ax_error
					.clone()
					.unwrap_or_else(DesktopError::ax_unsupported)
			})?
			.windows()
	}
}

impl Backend for WaylandBackend {
	fn capabilities(&mut self) -> DesktopCapabilities {
		let input_unavailable = self.input.is_none() && self.input_unavailable().is_some();
		let input_permission = if self.input.is_some() {
			"granted"
		} else if input_unavailable {
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
			input: !input_unavailable,
			ax: self.ax.is_some(),
			background_window_input: false,
			takeover: false,
			applications: crate::desktop::applications::supported(),
			menus: self.ax.is_some(),
			held_input: !input_unavailable,
			spaces: false,
			global_escape: false,
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
			screen_locked: false,
			display_asleep: false,
		}
	}

	fn displays(&mut self) -> CoreResult<Vec<DesktopDisplay>> {
		Ok(self.displays.clone())
	}

	fn validate_frame_layout(&mut self, frame: &FrameGeometry) -> CoreResult<()> {
		control::check()?;
		#[cfg(not(feature = "wayland-pipewire"))]
		{
			let _ = frame;
			Err(DesktopError::invalid_coordinate_frame(
				"validating Wayland display geometry requires the wayland-pipewire feature",
			))
		}
		#[cfg(feature = "wayland-pipewire")]
		{
			// ScreenCast exposes geometry only when opening a stream. Enumeration
			// can use the last snapshot, but coordinate delivery needs fresh
			// bounds.
			let geometry = capture::geometry();
			control::check()?;
			let geometry = geometry.map_err(|error| {
				DesktopError::invalid_coordinate_frame(format!(
					"could not refresh Wayland display geometry: {error}"
				))
			})?;
			self.displays = vec![geometry.display()];
			frame.validate_layout(&self.displays)
		}
	}

	fn windows(&mut self) -> CoreResult<Vec<DesktopWindow>> {
		let mut windows = self.atspi_windows()?;
		if let Some(ax) = self.ax.as_ref() {
			resolve_focus(&mut windows, self.compositor_pid, |window| ax.holds_focus(window));
		}
		Ok(windows.into_iter().map(|entry| entry.window).collect())
	}

	/// Reads the unresolved list. A native app's frame has no known position,
	/// so it must keep failing this check until the real outputs are counted;
	/// resolving focus here would refuse GNOME display typing that `main` allows
	/// through the shell frame, or, with a one-monitor shortcut, type on a
	/// monitor the agent cannot see.
	fn focused_keyboard_window(&mut self) -> CoreResult<DesktopWindow> {
		let entry = self
			.atspi_windows()?
			.into_iter()
			.find(|entry| entry.window.focused)
			.ok_or_else(|| DesktopError::invalid_target("no focused Wayland window was found"))?;
		if !entry.position_known {
			return Err(DesktopError::invalid_target(
				"the focused Wayland surface has no known global position; cannot safely target \
				 display keyboard input",
			));
		}
		Ok(entry.window)
	}

	fn capture(
		&mut self,
		target: &Target,
		_caps: &CaptureCaps,
		selector: Option<&DisplaySelector>,
	) -> CoreResult<(RgbaImage, FrameGeometry)> {
		#[cfg(not(feature = "wayland-pipewire"))]
		{
			let _ = (target, selector);
			Err(DesktopError::capture_failed("Wayland capture requires the wayland-pipewire feature"))
		}
		#[cfg(feature = "wayland-pipewire")]
		{
			let (image, geometry) = capture::capture()?;
			self.displays = vec![geometry.display()];
			let explicit = target.display_selector();
			let selected = selector
				.or(explicit.as_ref())
				.unwrap_or(&self.display)
				.select(self.displays.clone(), None)?;
			match target {
				Target::Desktop | Target::Display(_) => {
					Ok((image, FrameGeometry::for_displays(&selected)))
				},
				Target::Window(id) => {
					let entry = self
						.atspi_windows()?
						.into_iter()
						.find(|entry| &entry.window.id == id)
						.ok_or_else(|| {
							DesktopError::window_not_found(format!("Wayland window {id} not found"))
						})?;
					let (x, y, width, height) = geometry.window_crop(&entry)?;
					let cropped = image::imageops::crop_imm(&image, x, y, width, height).to_image();
					let frame =
						FrameGeometry::for_window(&entry.window, cropped.width(), cropped.height());
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
		token: &OperationToken,
	) -> CoreResult<()> {
		token.check()?;
		self.run_input(target, "pointer input", |input| input.pointer(ev))
	}

	fn type_text(
		&mut self,
		target: &Target,
		text: &str,
		_mode: DeliveryMode,
		token: &OperationToken,
	) -> CoreResult<()> {
		token.check()?;
		self.run_input(target, "keyboard input", |input| input.type_text(text))
	}

	fn key_chord(
		&mut self,
		target: &Target,
		keys: &[KeyName],
		_mode: DeliveryMode,
		token: &OperationToken,
	) -> CoreResult<()> {
		token.check()?;
		self.run_input(target, "keyboard input", |input| input.key_chord(keys))
	}

	fn hold_keys(
		&mut self,
		target: &Target,
		keys: &[KeyName],
		duration: std::time::Duration,
		_mode: DeliveryMode,
		token: &OperationToken,
	) -> CoreResult<()> {
		token.check()?;
		self.run_input(target, "held keyboard input", |input| input.hold_keys(keys, duration))
	}

	fn menu_items(
		&mut self,
		window: &DesktopWindow,
		path: &[String],
	) -> CoreResult<Vec<crate::desktop::menus::DesktopMenuItem>> {
		super::menus::items(window, path)
	}

	fn menu_select(
		&mut self,
		window: &DesktopWindow,
		path: &[String],
		token: &OperationToken,
	) -> CoreResult<()> {
		token.check()?;
		super::menus::select(window, path)
	}

	/// Refuses before anything reaches the element's app. The default focuses
	/// the element and then sends through its window's keyboard path, which
	/// Wayland always refuses, so the refused call still moved focus inside
	/// that app (GNOME announced "… is ready").
	fn element_input(
		&mut self,
		_element: &AxHandle,
		_input: &ElementInput,
		_mode: DeliveryMode,
		token: &OperationToken,
	) -> CoreResult<ElementDelivery> {
		token.check()?;
		Err(DesktopError::background_unavailable(
			"wayland-compositor-focus-only: Wayland cannot programmatically activate the element's \
			 window, so el.type and el.press(keys) are refused before the element is focused; \
			 nothing was sent. Use setValue, or click the field where a desktop screenshot shows it \
			 (AX bounds are window-relative here) and then type with desktop input",
		))
	}

	fn raise_window(&mut self, id: &str, token: &OperationToken) -> CoreResult<()> {
		token.check()?;
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
			display:           DisplaySelector::All,
			ax:                None,
			ax_error:          None,
			input:             None,
			input_unavailable: OnceCell::from(None),
			displays:          Vec::new(),
			compositor_pid:    None,
		}
	}
	/// Holds `LIBEI_ENV_LOCK` with `LIBEI_SOCKET` set to a test's value (removed
	/// for `None`) and puts the previous value back when dropped, also while a
	/// failing test unwinds, so no later test sees a leaked value.
	struct LibeiSocket {
		previous: Option<std::ffi::OsString>,
		_lock:    std::sync::MutexGuard<'static, ()>,
	}

	impl LibeiSocket {
		fn set(value: Option<&std::ffi::OsStr>) -> Self {
			let lock = LIBEI_ENV_LOCK
				.lock()
				.unwrap_or_else(std::sync::PoisonError::into_inner);
			let previous = std::env::var_os("LIBEI_SOCKET");
			// SAFETY: LIBEI_ENV_LOCK is held, and every test that writes
			// LIBEI_SOCKET or asserts on what it reads takes it first; std
			// serializes the other env reads.
			unsafe {
				match value {
					Some(value) => std::env::set_var("LIBEI_SOCKET", value),
					None => std::env::remove_var("LIBEI_SOCKET"),
				}
			}
			Self { previous, _lock: lock }
		}
	}

	impl Drop for LibeiSocket {
		fn drop(&mut self) {
			// SAFETY: as in `set`; the lock field is released only after this
			// body.
			unsafe {
				match self.previous.take() {
					Some(previous) => std::env::set_var("LIBEI_SOCKET", previous),
					None => std::env::remove_var("LIBEI_SOCKET"),
				}
			}
		}
	}

	fn with_fake_libei(action: impl FnOnce(&mut WaylandBackend)) -> bool {
		let socket = std::env::temp_dir().join(format!("omp-libei-test-{}", std::process::id()));
		let _env = LibeiSocket::set(Some(socket.as_os_str()));
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
		let mut backend = WaylandBackend::new(DisplaySelector::All);
		action(&mut backend);
		let _ = stop_tx.send(());
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

	/// Runs `action` with `LIBEI_SOCKET` unset, under the same lock as
	/// `with_fake_libei`: `input_unavailable` reads the variable on every call,
	/// so a fake socket from a test on another thread would otherwise report
	/// input as reachable.
	fn without_libei_socket(action: impl FnOnce()) {
		let _env = LibeiSocket::set(None);
		action();
	}

	#[test]
	fn a_desktop_without_a_remote_desktop_portal_reports_and_refuses_input() {
		without_libei_socket(|| {
			let mut backend = backend_without_services();
			backend.input_unavailable = OnceCell::from(Some("no RemoteDesktop portal".to_owned()));
			let capabilities = backend.capabilities();
			assert!(!capabilities.input);
			assert!(!capabilities.held_input);
			assert_eq!(capabilities.input_permission, "unavailable");
			let source = control::CancellationSource::default();
			let error = backend
				.type_text(&Target::Desktop, "x", DeliveryMode::Foreground, &source.token())
				.unwrap_err();
			assert_eq!(error.code.as_str(), "PermissionDenied");
			assert!(error.message.contains("no RemoteDesktop portal"), "{}", error.message);
			assert!(backend.input.is_none());
		});
	}

	#[test]
	fn desktop_input_connects_to_libei_lazily() {
		let connected = with_fake_libei(|backend| {
			let _ = backend.type_text(
				&Target::Desktop,
				"hello",
				DeliveryMode::Foreground,
				&control::CancellationSource::default().token(),
			);
		});
		assert!(connected, "desktop input did not connect to libei");
	}

	/// A probe that already found no portal must not hide an EIS socket set
	/// later in the session.
	#[test]
	fn a_socket_set_after_the_portal_probe_still_reaches_libei() {
		let connected = with_fake_libei(|backend| {
			backend.input_unavailable = OnceCell::from(Some("no RemoteDesktop portal".to_owned()));
			assert!(backend.capabilities().input);
			let _ = backend.type_text(
				&Target::Desktop,
				"hello",
				DeliveryMode::Foreground,
				&control::CancellationSource::default().token(),
			);
		});
		assert!(connected, "a cached portal absence blocked the LIBEI_SOCKET route");
	}

	#[test]
	fn failed_input_request_allows_another_connection_attempt() {
		let connected = with_fake_libei(|backend| {
			let socket = std::env::var_os("LIBEI_SOCKET").expect("fake libei socket");
			unsafe {
				std::env::set_var(
					"LIBEI_SOCKET",
					std::path::Path::new(&socket).with_extension("missing"),
				)
			};
			let first = backend
				.type_text(
					&Target::Desktop,
					"hello",
					DeliveryMode::Foreground,
					&control::CancellationSource::default().token(),
				)
				.expect_err("missing socket must fail");
			assert_eq!(first.code.as_str(), "PermissionDenied");
			let caps = backend.capabilities();
			assert!(caps.input);
			assert_eq!(caps.input_permission, "prompt-or-granted");
			unsafe { std::env::set_var("LIBEI_SOCKET", socket) };
			let _ = backend.type_text(
				&Target::Desktop,
				"hello",
				DeliveryMode::Foreground,
				&control::CancellationSource::default().token(),
			);
		});
		assert!(connected, "a failed input request prevented the next connection attempt");
	}

	#[test]
	fn display_enumeration_preserves_last_capture_snapshot() {
		let mut backend = backend_without_services();
		backend
			.displays
			.push(PortalGeometry::new(None, None, 1920, 1080).display());
		let displays = backend.displays().unwrap();
		assert_eq!(displays.len(), 1);
		assert_eq!((displays[0].width, displays[0].height), (1920, 1080));
	}

	#[test]
	#[cfg(not(feature = "wayland-pipewire"))]
	fn display_validation_never_trusts_cached_portal_geometry() {
		let mut backend = backend_without_services();
		backend
			.displays
			.push(PortalGeometry::new(None, None, 1920, 1080).display());
		let frame = FrameGeometry::for_displays(&backend.displays);
		let error = backend.validate_frame_layout(&frame).unwrap_err();
		assert_eq!(error.code.as_str(), "InvalidCoordinateFrame");
	}

	/// The refusal comes before any AT-SPI call: the default path's first step,
	/// the window lookup, would fail `AxUnsupported` here instead, and its next
	/// step focuses the element.
	#[test]
	fn element_input_is_refused_before_anything_reaches_the_app() {
		let mut backend = backend_without_services();
		let source = control::CancellationSource::default();
		for input in [ElementInput::Text("zz".into()), ElementInput::Chord(vec![KeyName::Enter])] {
			let error = backend
				.element_input(&AxHandle::Test(1), &input, DeliveryMode::Foreground, &source.token())
				.err()
				.expect("Wayland element input is refused");
			assert_eq!(error.code.as_str(), "BackgroundUnavailable");
			assert!(error.message.contains("nothing was sent"), "{}", error.message);
		}
		assert!(backend.input.is_none());
	}

	#[test]
	fn cancelled_mutations_stop_before_initializing_input() {
		let mut backend = backend_without_services();
		let source = control::CancellationSource::default();
		let token = source.token();
		source.cancel();
		assert!(
			backend
				.type_text(&Target::Desktop, "hello", DeliveryMode::Foreground, &token)
				.is_err()
		);
		assert!(backend.input.is_none());
		assert!(
			backend
				.key_chord(&Target::Desktop, &[KeyName::Enter], DeliveryMode::Foreground, &token)
				.is_err()
		);
		assert!(backend.input.is_none());
	}

	#[test]
	fn window_foreground_delivery_reports_compositor_constraint() {
		let mut backend = backend_without_services();
		let target = Target::Window("w1".to_string());
		let err = backend
			.type_text(
				&target,
				"hello",
				DeliveryMode::Foreground,
				&control::CancellationSource::default().token(),
			)
			.expect_err("window foreground input must fail");
		assert_eq!(err.code.as_str(), "BackgroundUnavailable");
	}

	#[test]
	fn window_raise_reports_compositor_constraint() {
		let mut backend = backend_without_services();
		let err = backend
			.raise_window("w1", &control::CancellationSource::default().token())
			.expect_err("Wayland window raise must fail");
		assert_eq!(err.code.as_str(), "BackgroundUnavailable");
	}

	#[test]
	#[cfg(not(feature = "wayland-pipewire"))]
	fn capabilities_report_no_capture_without_pipewire_feature() {
		let mut backend = backend_without_services();
		let caps = backend.capabilities();
		// Shipped builds compile without wayland-pipewire, so the capture path is
		// absent; capabilities() must not advertise capture the binary cannot do.
		assert!(!caps.capture, "capture must be false when the pipewire feature is off");
		assert_eq!(caps.capture_permission, "unavailable");
		let err = backend
			.capture(&Target::Desktop, &CaptureCaps::default(), None)
			.expect_err("capture must fail without the pipewire feature");
		assert_eq!(err.code.as_str(), "CaptureFailed");
	}

	fn portal_window(x: i32, y: i32, width: u32, height: u32, position_known: bool) -> AtSpiWindow {
		AtSpiWindow {
			window: DesktopWindow {
				id: "w".into(),
				title: "T".into(),
				app: "A".into(),
				pid: None,
				x,
				y,
				width,
				height,
				focused: false,
			},
			position_known,
		}
	}

	#[test]
	fn scaled_monitor_maps_screenshot_pixel_to_logical_point() {
		// 2560x2880 buffer for a 1280x1440 logical region at scale 2 (issue
		// #11540).
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
			.window_crop(&portal_window(100, 200, 300, 400, true))
			.expect("window inside monitor");
		assert_eq!(crop, (200, 400, 600, 800));
	}

	#[test]
	fn window_crop_rejects_window_outside_monitor() {
		let geometry = PortalGeometry::new(Some((0, 0)), Some((1280, 1440)), 2560, 2880);
		for window in [portal_window(2000, 0, 100, 100, true), portal_window(-10, 0, 100, 100, true)]
		{
			let err = geometry
				.window_crop(&window)
				.expect_err("window outside monitor");
			assert!(err.message.contains("outside the selected portal monitor"), "{err}");
		}
	}

	#[test]
	fn window_crop_refuses_unknown_screen_position() {
		// Native Wayland clients report AT-SPI Screen extents of 0,0 wherever
		// the compositor placed them; cropping there captured whatever sat at the
		// monitor's top-left instead of the window (issue #13854).
		let geometry = PortalGeometry::new(Some((0, 0)), Some((1920, 1080)), 1920, 1080);
		let err = geometry
			.window_crop(&portal_window(0, 0, 1159, 896, false))
			.expect_err("unknown position must not be cropped");
		assert_eq!(err.code.as_str(), "CaptureFailed");
		assert!(err.message.contains("no known screen position"), "{err}");
	}
}
