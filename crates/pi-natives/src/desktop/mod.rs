mod applications;
mod ax;
mod backend;
mod control;
mod error;
mod frame;
mod keys;
#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
mod menus;
#[cfg(target_os = "macos")]
mod native_helper;
mod types;
#[cfg(any(target_os = "windows", test))]
mod win32;

use std::{
	collections::HashMap,
	panic::AssertUnwindSafe,
	sync::{
		Arc,
		atomic::{AtomicUsize, Ordering},
	},
	thread::{self, JoinHandle},
	time::Duration,
};

pub use applications::{Application, ApplicationOpenOptions, ApplicationQuery};
use ax::{AxRegistry, register_node};
use backend::{Backend, DeliveryMode, MouseButton, PointerEvent, is_raise_action};
use control::{CancellationSource, InputLease, OperationToken};
use error::{CoreResult, DesktopError};
use frame::{FrameGeometry, apply_capture_caps, encode_png};
use keys::{parse_keys, parse_modifiers};
pub use menus::DesktopMenuItem;
use napi::{Result, bindgen_prelude::Uint8Array};
use napi_derive::napi;
use parking_lot::Mutex;
pub use types::*;

use crate::task;

const OPERATION_TIMEOUT: Duration = Duration::from_mins(3);
const CLOSE_TIMEOUT: Duration = Duration::from_secs(2);

enum Response {
	Capabilities(DesktopCapabilities),
	Displays(Vec<DesktopDisplay>),
	Windows(Vec<DesktopWindow>),
	Capture(DesktopCapture),
	Observation(DesktopObservation),
	Applications(Vec<Application>),
	Application(Application),
	MenuItems(Vec<DesktopMenuItem>),
	Unit,
	Snapshot(AxSnapshot),
	Nodes(Vec<AxNode>),
	Node(Option<AxNode>),
	Attributes(Vec<(String, String)>),
}

type Reply = flume::Sender<CoreResult<Response>>;

struct QueuedRequest {
	request: Request,
	token:   OperationToken,
}

enum Request {
	Capabilities {
		reply: Reply,
	},
	ListDisplays {
		reply: Reply,
	},
	ListWindows {
		reply: Reply,
	},
	Capture {
		target: Target,
		caps:   CaptureCaps,
		reply:  Reply,
	},
	CaptureRegion {
		target: Target,
		region: CaptureRegion,
		caps:   CaptureCaps,
		reply:  Reply,
	},
	Observe {
		target:  Target,
		caps:    CaptureCaps,
		options: AxSnapshotOptions,
		reply:   Reply,
	},
	ListApplications {
		options: ApplicationQuery,
		reply:   Reply,
	},
	OpenApplication {
		id:      String,
		options: ApplicationOpenOptions,
		reply:   Reply,
	},
	MenuItems {
		target: Target,
		path:   Vec<String>,
		reply:  Reply,
	},
	MenuSelect {
		target: Target,
		path:   Vec<String>,
		reply:  Reply,
	},
	BringToCurrentSpace {
		id:    String,
		reply: Reply,
	},
	HoldKeys {
		target:   Target,
		keys:     Vec<keys::KeyName>,
		duration: Duration,
		takeover: Option<bool>,
		reply:    Reply,
	},
	HoldMouse {
		target:   Target,
		x:        f64,
		y:        f64,
		button:   MouseButton,
		keys:     Vec<keys::KeyName>,
		duration: Duration,
		takeover: Option<bool>,
		reply:    Reply,
	},
	Click {
		target:  Target,
		x:       f64,
		y:       f64,
		options: ParsedPointerOptions,
		reply:   Reply,
	},
	MoveMouse {
		target:   Target,
		x:        f64,
		y:        f64,
		takeover: Option<bool>,
		reply:    Reply,
	},
	Drag {
		target:  Target,
		path:    Vec<(f64, f64)>,
		options: ParsedPointerOptions,
		reply:   Reply,
	},
	Scroll {
		target:   Target,
		x:        f64,
		y:        f64,
		dx:       f64,
		dy:       f64,
		takeover: Option<bool>,
		reply:    Reply,
	},
	TypeText {
		target:   Target,
		text:     String,
		takeover: Option<bool>,
		reply:    Reply,
	},
	KeyChord {
		target:   Target,
		keys:     Vec<keys::KeyName>,
		takeover: Option<bool>,
		reply:    Reply,
	},
	RaiseWindow {
		id:    String,
		reply: Reply,
	},
	AxSnapshot {
		target:  Target,
		options: AxSnapshotOptions,
		reply:   Reply,
	},
	AxQuery {
		target: Target,
		query:  AxQuery,
		reply:  Reply,
	},
	AxElementAt {
		target: Target,
		x:      f64,
		y:      f64,
		reply:  Reply,
	},
	AxFocused {
		reply: Reply,
	},
	AxNode {
		reference: String,
		reply:     Reply,
	},
	AxAttributes {
		reference: String,
		reply:     Reply,
	},
	AxChildren {
		reference: String,
		reply:     Reply,
	},
	AxParent {
		reference: String,
		reply:     Reply,
	},
	AxPerform {
		reference: String,
		action:    String,
		reply:     Reply,
	},
	AxSetValue {
		reference: String,
		value:     String,
		reply:     Reply,
	},
	AxFocus {
		reference: String,
		reply:     Reply,
	},
	AxClick {
		reference: String,
		options:   ParsedPointerOptions,
		reply:     Reply,
	},
	Close {
		reply: Reply,
	},
}

impl Request {
	fn reply(self, result: CoreResult<Response>) -> bool {
		let reply = match self {
			Self::Capabilities { reply }
			| Self::ListDisplays { reply }
			| Self::ListWindows { reply }
			| Self::Capture { reply, .. }
			| Self::CaptureRegion { reply, .. }
			| Self::Observe { reply, .. }
			| Self::ListApplications { reply, .. }
			| Self::OpenApplication { reply, .. }
			| Self::MenuItems { reply, .. }
			| Self::MenuSelect { reply, .. }
			| Self::BringToCurrentSpace { reply, .. }
			| Self::HoldKeys { reply, .. }
			| Self::HoldMouse { reply, .. }
			| Self::Click { reply, .. }
			| Self::MoveMouse { reply, .. }
			| Self::Drag { reply, .. }
			| Self::Scroll { reply, .. }
			| Self::TypeText { reply, .. }
			| Self::KeyChord { reply, .. }
			| Self::RaiseWindow { reply, .. }
			| Self::AxSnapshot { reply, .. }
			| Self::AxQuery { reply, .. }
			| Self::AxElementAt { reply, .. }
			| Self::AxFocused { reply }
			| Self::AxNode { reply, .. }
			| Self::AxAttributes { reply, .. }
			| Self::AxChildren { reply, .. }
			| Self::AxParent { reply, .. }
			| Self::AxPerform { reply, .. }
			| Self::AxSetValue { reply, .. }
			| Self::AxFocus { reply, .. }
			| Self::AxClick { reply, .. }
			| Self::Close { reply } => reply,
		};
		reply.send(result).is_ok()
	}

	const fn is_mutation(&self) -> bool {
		matches!(
			self,
			Self::Click { .. }
				| Self::MoveMouse { .. }
				| Self::Drag { .. }
				| Self::Scroll { .. }
				| Self::TypeText { .. }
				| Self::KeyChord { .. }
				| Self::RaiseWindow { .. }
				| Self::AxPerform { .. }
				| Self::AxSetValue { .. }
				| Self::AxFocus { .. }
				| Self::AxClick { .. }
				| Self::OpenApplication { .. }
				| Self::MenuSelect { .. }
				| Self::BringToCurrentSpace { .. }
				| Self::HoldKeys { .. }
				| Self::HoldMouse { .. }
		)
	}

	/// Whether this mutation takes over the user's own input or foreground,
	/// which arms the physical-Escape stop: takeover delivery (explicit or
	/// through held control), input to a desktop or display target (it drives
	/// the user's real pointer and keyboard), an explicit raise, and an
	/// activating launch.
	fn takes_over(&self, token: &OperationToken) -> bool {
		let (target, takeover) = match self {
			Self::HoldKeys { target, takeover, .. }
			| Self::HoldMouse { target, takeover, .. }
			| Self::MoveMouse { target, takeover, .. }
			| Self::Scroll { target, takeover, .. }
			| Self::TypeText { target, takeover, .. }
			| Self::KeyChord { target, takeover, .. } => (Some(target), *takeover),
			Self::Click { target, options, .. } | Self::Drag { target, options, .. } => {
				(Some(target), options.takeover)
			},
			Self::AxClick { options, .. } => (None, options.takeover),
			Self::RaiseWindow { .. } => return true,
			Self::OpenApplication { options, .. } => return options.activate.unwrap_or(false),
			Self::AxPerform { action, .. } => return is_raise_action(action),
			_ => return false,
		};
		target.is_some_and(|target| !matches!(target, Target::Window(_)))
			|| delivery_mode(takeover, token) == DeliveryMode::Foreground
	}

	const fn frame_target(&self) -> Option<&Target> {
		match self {
			Self::Capture { target, .. } | Self::Observe { target, .. } => Some(target),
			_ => None,
		}
	}

	const fn is_close(&self) -> bool {
		matches!(self, Self::Close { .. })
	}
}

#[derive(Clone)]
struct ParsedPointerOptions {
	button:    MouseButton,
	count:     u32,
	modifiers: backend::Modifiers,
	keys:      Vec<keys::KeyName>,
	takeover:  Option<bool>,
}
impl ParsedPointerOptions {
	fn parse(options: Option<PointerOptions>) -> CoreResult<Self> {
		let options = options.unwrap_or_default();
		Ok(Self {
			button:    MouseButton::parse(options.button.as_deref())?,
			count:     options.count.unwrap_or(1).max(1),
			modifiers: parse_modifiers(options.modifiers.as_deref().unwrap_or_default())?,
			keys:      parse_keys(options.keys.as_deref().unwrap_or_default())?,
			takeover:  options.takeover,
		})
	}

	fn mode(&self, token: &OperationToken) -> DeliveryMode {
		delivery_mode(self.takeover, token)
	}
}

fn delivery_mode(takeover: Option<bool>, token: &OperationToken) -> DeliveryMode {
	DeliveryMode::from_takeover(Some(takeover.unwrap_or_else(|| token.control_active())))
}

fn hold_duration(seconds: f64) -> CoreResult<Duration> {
	if !seconds.is_finite() || !(0.0..=100.0).contains(&seconds) {
		return Err(DesktopError::input_failed(
			"hold duration must be finite seconds from 0 through 100",
		));
	}
	Ok(Duration::from_secs_f64(seconds))
}

struct Worker {
	backend:      CoreResult<Box<dyn Backend>>,
	registry:     AxRegistry,
	frames:       HashMap<String, FrameGeometry>,
	/// Latest capabilities the worker computed, shared with the session so the
	/// getter can answer while an operation holds the worker.
	capabilities: Arc<Mutex<Option<DesktopCapabilities>>>,
}

impl Worker {
	fn new(
		selector: DisplaySelector,
		capabilities: Arc<Mutex<Option<DesktopCapabilities>>>,
	) -> Self {
		let backend = create_backend(selector);
		Self { backend, registry: AxRegistry::default(), frames: HashMap::new(), capabilities }
	}

	fn backend(&mut self) -> CoreResult<&mut Box<dyn Backend>> {
		self.backend.as_mut().map_err(|error| error.clone())
	}

	fn window(&mut self, target: &Target) -> CoreResult<DesktopWindow> {
		let windows = self.backend()?.windows()?;
		match target {
			Target::Window(id) => windows
				.into_iter()
				.find(|window| window.id == *id)
				.ok_or_else(|| DesktopError::window_not_found(format!("window '{id}' was not found"))),
			Target::Desktop | Target::Display(_) => windows
				.into_iter()
				.find(|window| window.focused)
				.ok_or_else(|| DesktopError::window_not_found("no focused window was found")),
		}
	}

	fn frame(&self, target: &Target) -> CoreResult<FrameGeometry> {
		self.frames.get(target.key()).cloned().ok_or_else(|| {
			DesktopError::invalid_coordinate_frame(format!(
				"no capture of '{}' yet — take a screenshot of this target first; coordinate input is \
				 in pixels of that screenshot",
				target.key()
			))
		})
	}

	fn validated_frame(
		&mut self,
		target: &Target,
	) -> CoreResult<(FrameGeometry, Option<DesktopWindow>)> {
		let frame = self.frame(target)?;
		self.backend()?.validate_frame_layout(&frame)?;
		let current = if matches!(target, Target::Window(_)) {
			Some(self.window(target)?)
		} else {
			None
		};
		frame.validate_window(current.as_ref())?;
		Ok((frame, current))
	}

	fn map_point(
		&mut self,
		target: &Target,
		x: f64,
		y: f64,
	) -> CoreResult<(f64, f64, FrameGeometry)> {
		let (frame, current) = self.validated_frame(target)?;
		let (x, y) = frame.map_point(x, y, current.as_ref())?;
		Ok((x, y, frame))
	}

	fn explicit_window(&mut self, target: &Target) -> CoreResult<DesktopWindow> {
		if !matches!(target, Target::Window(_)) {
			return Err(DesktopError::invalid_target(
				"this operation requires an explicit window target",
			));
		}
		self.window(target)
	}

	fn validate_keyboard_target(&mut self, target: &Target) -> CoreResult<()> {
		if !matches!(target, Target::Display(_)) {
			return Ok(());
		}
		let (frame, _) = self.validated_frame(target)?;
		let window = self.backend()?.focused_keyboard_window()?;
		let displays = self.backend()?.displays()?;
		if !displays.iter().any(|display| {
			i64::from(window.x) < i64::from(display.x) + i64::from(display.width)
				&& i64::from(window.x) + i64::from(window.width) > i64::from(display.x)
				&& i64::from(window.y) < i64::from(display.y) + i64::from(display.height)
				&& i64::from(window.y) + i64::from(window.height) > i64::from(display.y)
		}) {
			return Err(DesktopError::invalid_target(
				"the focused window is outside the known display layout",
			));
		}
		let active = DisplaySelector::Active.select(displays, Some(&window))?;
		if !frame.contains_display(&active[0].id) {
			return Err(DesktopError::invalid_target(
				"the focused window is on another display; focus a window on this display before \
				 keyboard input",
			));
		}
		Ok(())
	}

	fn snapshot(&mut self, target: &Target, options: &AxSnapshotOptions) -> CoreResult<AxSnapshot> {
		let window = self.window(target)?;
		let (backend, registry) = (&mut self.backend, &mut self.registry);
		let ax = backend
			.as_mut()
			.map_err(|error| error.clone())?
			.ax()
			.ok_or_else(DesktopError::ax_unsupported)?;
		ax::snapshot(ax, registry, &window, options)
	}

	fn capture_full(
		&mut self,
		target: &Target,
		caps: &CaptureCaps,
		token: &OperationToken,
	) -> CoreResult<DesktopCapture> {
		let selector = target.display_selector();
		let (image, mut geometry) = self.backend()?.capture(target, caps, selector.as_ref())?;
		let source_width = image.width();
		let source_height = image.height();
		let layout = self.backend()?.displays()?;
		geometry.record_layout(&layout)?;
		let image = apply_capture_caps(image, &mut geometry, caps)?;
		let width = image.width();
		let height = image.height();
		let displays =
			self.capture_metadata(target, &geometry, &layout, source_width, source_height)?;
		token.check()?;
		let png = encode_png(image)?;
		token.check()?;
		self.frames.insert(target.key().to_string(), geometry);
		// Refreshing here keeps the snapshot current for getter reads that
		// land while a later operation holds the worker.
		let capabilities = self.read_capabilities(token)?;
		*self.capabilities.lock() = Some(capabilities.clone());
		Ok(DesktopCapture {
			data: Uint8Array::from(png),
			width,
			height,
			source_width,
			source_height,
			coordinate_width: width,
			coordinate_height: height,
			region: None,
			target: target.key().to_string(),
			displays,
			backend: capabilities.backend,
			display_server: capabilities.display_server,
		})
	}

	fn capture_metadata(
		&mut self,
		target: &Target,
		geometry: &FrameGeometry,
		layout: &[DesktopDisplay],
		source_width: u32,
		source_height: u32,
	) -> CoreResult<Vec<DesktopDisplay>> {
		let source = match target {
			Target::Desktop | Target::Display(_) => return Ok(geometry.display_metadata(layout)),
			Target::Window(_) => {
				let window = self.window(target)?;
				geometry.validate_window(Some(&window))?;
				DesktopDisplay {
					id:           window.id,
					name:         format!("{} — {}", window.app, window.title),
					x:            window.x,
					y:            window.y,
					width:        window.width,
					height:       window.height,
					scale:        f64::from(source_width) / f64::from(window.width.max(1)),
					pixel_x:      0,
					pixel_y:      0,
					pixel_width:  source_width,
					pixel_height: source_height,
					is_primary:   false,
				}
			},
		};
		Ok(geometry.display_metadata(std::slice::from_ref(&source)))
	}

	fn dispatch(&mut self, request: Request, token: &OperationToken) {
		let frame_key = request
			.frame_target()
			.map(|target| target.key().to_string());
		let previous = frame_key.as_ref().and_then(|key| self.frames.remove(key));
		let result = std::panic::catch_unwind(AssertUnwindSafe(|| self.execute(&request, token)))
			.unwrap_or_else(|_| Err(DesktopError::internal("native desktop worker panicked")));
		let failed = result.is_err();
		let delivered = request.reply(result);
		if (failed || !delivered)
			&& let Some(key) = frame_key
		{
			if let Some(frame) = previous {
				self.frames.insert(key, frame);
			} else {
				self.frames.remove(&key);
			}
		}
	}

	fn execute(&mut self, request: &Request, token: &OperationToken) -> CoreResult<Response> {
		if request.is_close() {
			return Ok(Response::Unit);
		}
		token.check()?;
		let _scope = token.enter();
		let _lease = request
			.is_mutation()
			.then(|| InputLease::acquire(token, request.takes_over(token)))
			.transpose()?;
		token.check()?;
		// A full capture replaces coordinates only if it completes in its
		// original generation. Keep the previous frame by move, not by
		// cloning an atlas.
		let previous_frame = request
			.frame_target()
			.and_then(|target| self.frames.remove(target.key()));
		let result = self.process(request, token).and_then(|response| {
			token.check()?;
			Ok(response)
		});
		if result.is_err()
			&& let Some(target) = request.frame_target()
		{
			match previous_frame {
				Some(frame) => {
					self.frames.insert(target.key().to_string(), frame);
				},
				None => {
					self.frames.remove(target.key());
				},
			}
		}
		result
	}

	fn ax(&mut self) -> CoreResult<&mut dyn backend::AxBackend> {
		self
			.backend()?
			.ax()
			.ok_or_else(DesktopError::ax_unsupported)
	}

	/// Backend capabilities, without global Escape once this session's input
	/// has run without its monitor.
	fn read_capabilities(&mut self, token: &OperationToken) -> CoreResult<DesktopCapabilities> {
		let mut capabilities = self.backend()?.capabilities();
		capabilities.global_escape &= !token.escape_unavailable();
		Ok(capabilities)
	}

	fn process(&mut self, request: &Request, token: &OperationToken) -> CoreResult<Response> {
		match request {
			Request::Capabilities { .. } => {
				let caps = self
					.read_capabilities(token)
					.unwrap_or_else(|_| DesktopCapabilities::unavailable());
				*self.capabilities.lock() = Some(caps.clone());
				Ok(Response::Capabilities(caps))
			},
			Request::ListDisplays { .. } => Ok(Response::Displays(self.backend()?.displays()?)),
			Request::ListWindows { .. } => Ok(Response::Windows(self.backend()?.windows()?)),
			Request::Capture { target, caps, .. } => {
				Ok(Response::Capture(self.capture_full(target, caps, token)?))
			},
			Request::Observe { target, caps, options, .. } => {
				let capture = self.capture_full(target, caps, token)?;
				token.check()?;
				let accessibility = self.snapshot(target, options)?;
				Ok(Response::Observation(DesktopObservation { capture, accessibility }))
			},
			Request::ListApplications { options, .. } => {
				Ok(Response::Applications(applications::list(options.clone())?))
			},
			Request::OpenApplication { id, options, .. } => {
				Ok(Response::Application(applications::open(id, options.clone())?))
			},
			Request::MenuItems { target, path, .. } => {
				let window = self.explicit_window(target)?;
				Ok(Response::MenuItems(self.backend()?.menu_items(&window, path)?))
			},
			Request::MenuSelect { target, path, .. } => {
				let window = self.explicit_window(target)?;
				self.backend()?.menu_select(&window, path, token)?;
				Ok(Response::Unit)
			},
			Request::BringToCurrentSpace { id, .. } => {
				let target = Target::Window(id.clone());
				// The window may be off-Space and absent from capturable windows.
				// Resolve its owner through the Space backend, not capture lookup.
				// A refused or partially completed native move may still change
				// geometry, so never retain its old coordinate frame.
				self.frames.remove(target.key());
				self.backend()?.bring_to_current_space(id, token)?;
				Ok(Response::Unit)
			},
			Request::HoldKeys { target, keys, duration, takeover, .. } => {
				self.validate_keyboard_target(target)?;
				self.backend()?.hold_keys(
					target,
					keys,
					*duration,
					delivery_mode(*takeover, token),
					token,
				)?;
				Ok(Response::Unit)
			},
			Request::HoldMouse { target, x, y, button, keys, duration, takeover, .. } => {
				if !keys.is_empty() {
					self.validate_keyboard_target(target)?;
				}
				let (x, y, frame) = self.map_point(target, *x, *y)?;
				self.backend()?.pointer(
					target,
					PointerEvent::Hold {
						x,
						y,
						button: *button,
						keys: keys.clone(),
						duration: *duration,
					},
					&frame,
					delivery_mode(*takeover, token),
					token,
				)?;
				Ok(Response::Unit)
			},
			Request::CaptureRegion { target, region, caps, .. } => {
				let (base, _) = self.validated_frame(target)?;
				base.validate_region(region)?;
				let selector = base.capture_selector();
				token.check()?;
				let (image, fresh) =
					self
						.backend()?
						.capture(target, &CaptureCaps::default(), selector.as_ref())?;
				let layout = self.backend()?.displays().map_err(|error| {
					DesktopError::invalid_coordinate_frame(format!(
						"could not validate captured display layout: {error}"
					))
				})?;
				base.validate_layout(&layout)?;
				let displays =
					self.capture_metadata(target, &base, &layout, image.width(), image.height())?;
				let (image, source_width, source_height) =
					base.crop_region(image, &fresh, region, caps)?;
				let width = image.width();
				let height = image.height();
				let (coordinate_width, coordinate_height) = base.dimensions();
				token.check()?;
				let png = encode_png(image)?;
				let capabilities = self.read_capabilities(token)?;
				*self.capabilities.lock() = Some(capabilities.clone());
				Ok(Response::Capture(DesktopCapture {
					data: Uint8Array::from(png),
					width,
					height,
					source_width,
					source_height,
					coordinate_width,
					coordinate_height,
					region: Some(*region),
					target: target.key().to_string(),
					displays,
					backend: capabilities.backend,
					display_server: capabilities.display_server,
				}))
			},
			Request::Click { target, x, y, options, .. } => {
				if options.modifiers != backend::Modifiers::default() {
					self.validate_keyboard_target(target)?;
				}
				let (x, y, frame) = self.map_point(target, *x, *y)?;
				self.backend()?.pointer(
					target,
					PointerEvent::Click {
						x,
						y,
						button: options.button,
						count: options.count,
						modifiers: options.modifiers,
					},
					&frame,
					options.mode(token),
					token,
				)?;
				Ok(Response::Unit)
			},
			Request::MoveMouse { target, x, y, takeover, .. } => {
				let (x, y, frame) = self.map_point(target, *x, *y)?;
				self.backend()?.pointer(
					target,
					PointerEvent::Move { x, y },
					&frame,
					delivery_mode(*takeover, token),
					token,
				)?;
				Ok(Response::Unit)
			},
			Request::Drag { target, path, options, .. } => {
				if !options.keys.is_empty() || options.modifiers != backend::Modifiers::default() {
					self.validate_keyboard_target(target)?;
				}
				let (frame, current) = self.validated_frame(target)?;
				let mapped = path
					.iter()
					.map(|(x, y)| frame.map_point(*x, *y, current.as_ref()))
					.collect::<CoreResult<Vec<_>>>()?;
				self.backend()?.pointer(
					target,
					PointerEvent::Drag {
						path:      mapped,
						button:    options.button,
						modifiers: options.modifiers,
						keys:      options.keys.clone(),
					},
					&frame,
					options.mode(token),
					token,
				)?;
				Ok(Response::Unit)
			},
			Request::Scroll { target, x, y, dx, dy, takeover, .. } => {
				let (x, y, frame) = self.map_point(target, *x, *y)?;
				self.backend()?.pointer(
					target,
					PointerEvent::Scroll { x, y, dx: *dx, dy: *dy },
					&frame,
					delivery_mode(*takeover, token),
					token,
				)?;
				Ok(Response::Unit)
			},
			Request::TypeText { target, text, takeover, .. } => {
				self.validate_keyboard_target(target)?;
				self
					.backend()?
					.type_text(target, text, delivery_mode(*takeover, token), token)?;
				Ok(Response::Unit)
			},
			Request::KeyChord { target, keys, takeover, .. } => {
				self.validate_keyboard_target(target)?;
				self
					.backend()?
					.key_chord(target, keys, delivery_mode(*takeover, token), token)?;
				Ok(Response::Unit)
			},
			Request::RaiseWindow { id, .. } => {
				self.backend()?.raise_window(id, token)?;
				Ok(Response::Unit)
			},
			Request::AxSnapshot { target, options, .. } => {
				Ok(Response::Snapshot(self.snapshot(target, options)?))
			},
			Request::AxQuery { target, query, .. } => {
				let window = self.window(target)?;
				let (backend, registry) = (&mut self.backend, &mut self.registry);
				let ax = backend
					.as_mut()
					.map_err(|error| error.clone())?
					.ax()
					.ok_or_else(DesktopError::ax_unsupported)?;
				Ok(Response::Nodes(ax::query(ax, registry, &window, query)?))
			},
			Request::AxElementAt { target, x, y, .. } => {
				let (backend, registry) = (&mut self.backend, &mut self.registry);
				let backend = backend
					.as_mut()
					.map_err(|error| error.clone())?
					.ax()
					.ok_or_else(DesktopError::ax_unsupported)?;
				Ok(Response::Node(ax::element_at_node(backend, registry, target.key(), *x, *y)?))
			},
			Request::AxFocused { .. } => {
				let handle = self.ax()?.focused_element()?;
				let node = match handle {
					Some(h) => {
						let (backend, registry) = (&mut self.backend, &mut self.registry);
						let ax = backend
							.as_mut()
							.map_err(|error| error.clone())?
							.ax()
							.ok_or_else(DesktopError::ax_unsupported)?;
						Some(register_node(ax, registry, "desktop", h)?)
					},
					None => None,
				};
				Ok(Response::Node(node))
			},
			Request::AxNode { reference, .. } => {
				let h = self.registry.resolve(reference)?;
				let props = self.ax()?.props(&h)?;
				Ok(Response::Node(Some(ax::node_to_napi(reference.clone(), props))))
			},
			Request::AxAttributes { reference, .. } => {
				let h = self.registry.resolve(reference)?;
				let mut attributes = self.ax()?.attributes(&h)?;
				for (_, value) in &mut attributes {
					if value.chars().count() > 200 {
						*value = value
							.chars()
							.take(199)
							.chain(std::iter::once('…'))
							.collect();
					}
				}
				Ok(Response::Attributes(attributes))
			},
			Request::AxChildren { reference, .. } => {
				let h = self.registry.resolve(reference)?;
				let target = self.registry.target(reference)?;
				let handles = self.ax()?.children(&h)?;
				let mut nodes = Vec::with_capacity(handles.len());
				for h in handles {
					let (backend, registry) = (&mut self.backend, &mut self.registry);
					let ax = backend
						.as_mut()
						.map_err(|error| error.clone())?
						.ax()
						.ok_or_else(DesktopError::ax_unsupported)?;
					nodes.push(register_node(ax, registry, &target, h)?);
				}
				Ok(Response::Nodes(nodes))
			},
			Request::AxParent { reference, .. } => {
				let h = self.registry.resolve(reference)?;
				let target = self.registry.target(reference)?;
				let parent = self.ax()?.parent(&h)?;
				let node = match parent {
					Some(h) => {
						let (backend, registry) = (&mut self.backend, &mut self.registry);
						let ax = backend
							.as_mut()
							.map_err(|error| error.clone())?
							.ax()
							.ok_or_else(DesktopError::ax_unsupported)?;
						Some(register_node(ax, registry, &target, h)?)
					},
					None => None,
				};
				Ok(Response::Node(node))
			},
			Request::AxPerform { reference, action, .. } => {
				let h = self.registry.resolve(reference)?;
				if action.eq_ignore_ascii_case("press") {
					ax::ax_press(self.ax()?, &h)?;
				} else {
					self.ax()?.perform(&h, action)?;
				}
				Ok(Response::Unit)
			},
			Request::AxSetValue { reference, value, .. } => {
				let h = self.registry.resolve(reference)?;
				self.ax()?.set_value(&h, value)?;
				Ok(Response::Unit)
			},
			Request::AxFocus { reference, .. } => {
				let h = self.registry.resolve(reference)?;
				self.ax()?.focus(&h)?;
				Ok(Response::Unit)
			},
			Request::AxClick { reference, options, .. } => {
				let h = self.registry.resolve(reference)?;
				let bounds = self.ax()?.props(&h)?.bounds.ok_or_else(|| {
					DesktopError::ax_failed(format!("{reference} has no clickable bounds"))
				})?;
				let x = bounds.x + bounds.width / 2.0;
				let y = bounds.y + bounds.height / 2.0;
				let windows = self.backend()?.windows()?;
				// Desktop refs and parent traversal can leave the snapshot's
				// original window; only the live element can establish ownership.
				let window_id = self.ax()?.window_id(&h, &windows)?;
				let target = Target::Window(window_id);
				self.backend()?.pointer(
					&target,
					PointerEvent::Click {
						x,
						y,
						button: options.button,
						count: options.count,
						modifiers: options.modifiers,
					},
					&FrameGeometry::identity_global(),
					options.mode(token),
					token,
				)?;
				Ok(Response::Unit)
			},
			Request::Close { .. } => Ok(Response::Unit),
		}
	}
}

#[cfg(target_os = "macos")]
fn create_backend(selector: DisplaySelector) -> CoreResult<Box<dyn Backend>> {
	Ok(Box::new(macos::MacosBackend::new(selector)?))
}
#[cfg(target_os = "windows")]
fn create_backend(selector: DisplaySelector) -> CoreResult<Box<dyn Backend>> {
	Ok(Box::new(win32::Win32Backend::new(selector)?))
}
#[cfg(target_os = "linux")]
fn create_backend(selector: DisplaySelector) -> CoreResult<Box<dyn Backend>> {
	linux::new_backend(selector)
}
#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
fn create_backend(_: DisplaySelector) -> CoreResult<Box<dyn Backend>> {
	Err(DesktopError::capture_failed("desktop backend unavailable on this platform"))
}

struct Lifecycle {
	tx:     Option<flume::Sender<QueuedRequest>>,
	done:   Option<flume::Receiver<()>>,
	join:   Option<JoinHandle<()>>,
	closed: bool,
}
struct SessionCore {
	selector:     DisplaySelector,
	lifecycle:    Mutex<Lifecycle>,
	capabilities: Arc<Mutex<Option<DesktopCapabilities>>>,
	/// `call`s sent to the worker that have not returned yet.
	in_flight:    AtomicUsize,
	cancellation: CancellationSource,
}
impl SessionCore {
	fn new(selector: DisplaySelector) -> Arc<Self> {
		Arc::new(Self {
			selector,
			lifecycle: Mutex::new(Lifecycle {
				tx:     None,
				done:   None,
				join:   None,
				closed: false,
			}),
			capabilities: Arc::default(),
			in_flight: AtomicUsize::new(0),
			cancellation: CancellationSource::default(),
		})
	}

	fn ensure_started(&self) -> CoreResult<flume::Sender<QueuedRequest>> {
		let mut lifecycle = self.lifecycle.lock();
		if lifecycle.closed {
			return Err(DesktopError::closed());
		}
		if let Some(tx) = &lifecycle.tx {
			return Ok(tx.clone());
		}
		let (tx, rx) = flume::unbounded::<QueuedRequest>();
		let (done_tx, done_rx) = flume::bounded(1);
		let selector = self.selector.clone();
		let caps = Arc::clone(&self.capabilities);
		let join = thread::Builder::new()
			.name("omp-desktop-session".into())
			.spawn(move || {
				let mut worker = Worker::new(selector, caps);
				while let Ok(QueuedRequest { request, token }) = rx.recv() {
					let close = request.is_close();
					worker.dispatch(request, &token);
					if close {
						break;
					}
				}
				let _ = done_tx.send(());
			})
			.map_err(|e| {
				DesktopError::internal(format!("failed to start native desktop worker: {e}"))
			})?;
		lifecycle.tx = Some(tx.clone());
		lifecycle.done = Some(done_rx);
		lifecycle.join = Some(join);
		Ok(tx)
	}

	fn call(
		&self,
		token: OperationToken,
		make: impl FnOnce(Reply) -> Request,
	) -> CoreResult<Response> {
		token.check()?;
		// Rendezvous delivery: a timed-out/dropped caller must never commit a
		// capture frame that it did not receive.
		let (txr, rxr) = flume::bounded(0);
		let tx = self.ensure_started()?;
		self.in_flight.fetch_add(1, Ordering::AcqRel);
		let response = tx
			.send(QueuedRequest { request: make(txr), token })
			.map_err(|_| DesktopError::internal("native desktop worker stopped unexpectedly"))
			.and_then(|()| {
				rxr.recv_timeout(OPERATION_TIMEOUT).map_err(|e| {
					self.cancellation.cancel();
					DesktopError::timeout(format!("native desktop operation did not complete: {e}"))
				})
			});
		self.in_flight.fetch_sub(1, Ordering::AcqRel);
		response?
	}

	fn close(&self) -> CoreResult<()> {
		self.cancellation.cancel();
		let mut lifecycle = self.lifecycle.lock();
		lifecycle.closed = true;
		let Some(tx) = lifecycle.tx.take() else {
			return Ok(());
		};
		let (rtx, rrx) = flume::bounded(1);
		tx.send(QueuedRequest {
			request: Request::Close { reply: rtx },
			token:   self.cancellation.token(),
		})
		.map_err(|_| DesktopError::closed())?;
		let _ = rrx.recv_timeout(CLOSE_TIMEOUT).map_err(|e| {
			DesktopError::timeout(format!("timed out closing native desktop worker: {e}"))
		})?;
		if let Some(done) = lifecycle.done.take() {
			done.recv_timeout(CLOSE_TIMEOUT).map_err(|e| {
				DesktopError::timeout(format!("native desktop worker did not exit: {e}"))
			})?;
		}
		if let Some(join) = lifecycle.join.take() {
			join
				.join()
				.map_err(|_| DesktopError::internal("native desktop worker panicked during close"))?;
		}
		Ok(())
	}
}
impl Drop for SessionCore {
	fn drop(&mut self) {
		self.cancellation.cancel();
		let lifecycle = self.lifecycle.get_mut();
		if let Some(tx) = lifecycle.tx.take() {
			let (reply, _) = flume::bounded(1);
			let _ = tx.send(QueuedRequest {
				request: Request::Close { reply },
				token:   self.cancellation.token(),
			});
		}
		let _ = lifecycle.join.take();
	}
}

fn response_unit(response: Response) -> CoreResult<()> {
	if matches!(response, Response::Unit) {
		Ok(())
	} else {
		Err(DesktopError::internal("unexpected desktop worker response"))
	}
}

/// Persistent, serialized native desktop capture/input/accessibility session.
#[napi]
pub struct DesktopSession {
	core: Arc<SessionCore>,
}

impl Drop for DesktopSession {
	fn drop(&mut self) {
		// A running async task can retain SessionCore after its JS wrapper dies.
		// Cancel that work now rather than waiting for the last Arc to disappear.
		self.core.cancellation.cancel();
	}
}
#[napi]
impl DesktopSession {
	#[napi(constructor)]
	pub fn new(options: Option<DesktopSessionOptions>) -> Result<Self> {
		Ok(Self { core: SessionCore::new(DisplaySelector::parse(options.and_then(|o| o.display))) })
	}

	/// Asks the worker when it is idle, so permissions are read live. While
	/// another operation holds the worker, answers from the snapshot of the
	/// latest capabilities read or capture instead of blocking the JS thread
	/// behind it.
	#[napi(getter)]
	pub fn capabilities(&self) -> DesktopCapabilities {
		// An in-flight takeover may have failed to start its stop after the
		// snapshot was taken; the session's record is current.
		let snapshot = || {
			let mut snapshot = self.core.capabilities.lock().clone()?;
			snapshot.global_escape &= !self.core.cancellation.escape_unavailable();
			Some(snapshot)
		};
		if self.core.in_flight.load(Ordering::Acquire) > 0
			&& let Some(snapshot) = snapshot()
		{
			return snapshot;
		}
		match self
			.core
			.call(self.core.cancellation.token(), |reply| Request::Capabilities { reply })
		{
			Ok(Response::Capabilities(c)) => c,
			_ => snapshot().unwrap_or_else(DesktopCapabilities::unavailable),
		}
	}

	#[napi]
	pub fn list_displays(&self) -> Result<task::Promise<Vec<DesktopDisplay>>> {
		let c = Arc::clone(&self.core);
		let token = c.cancellation.token();
		Ok(task::blocking("desktop.listDisplays", (), move |_| {
			match c.call(token, |reply| Request::ListDisplays { reply })? {
				Response::Displays(v) => Ok(v),
				_ => Err(DesktopError::internal("unexpected response")),
			}
			.map_err(Into::into)
		}))
	}

	#[napi]
	pub fn list_windows(&self) -> Result<task::Promise<Vec<DesktopWindow>>> {
		let c = Arc::clone(&self.core);
		let token = c.cancellation.token();
		Ok(task::blocking("desktop.listWindows", (), move |_| {
			match c.call(token, |reply| Request::ListWindows { reply })? {
				Response::Windows(v) => Ok(v),
				_ => Err(DesktopError::internal("unexpected response")),
			}
			.map_err(Into::into)
		}))
	}

	#[napi]
	pub fn list_applications(
		&self,
		options: Option<ApplicationQuery>,
	) -> Result<task::Promise<Vec<Application>>> {
		let c = Arc::clone(&self.core);
		let token = c.cancellation.token();
		Ok(task::blocking("desktop.listApplications", (), move |_| {
			match c.call(token, |reply| Request::ListApplications {
				options: options.unwrap_or_default(),
				reply,
			})? {
				Response::Applications(value) => Ok(value),
				_ => Err(DesktopError::internal("unexpected response")),
			}
			.map_err(Into::into)
		}))
	}

	#[napi]
	pub fn open_application(
		&self,
		id: String,
		options: Option<ApplicationOpenOptions>,
	) -> Result<task::Promise<Application>> {
		let c = Arc::clone(&self.core);
		let token = c.cancellation.token();
		Ok(task::blocking("desktop.openApplication", (), move |_| {
			match c.call(token, |reply| Request::OpenApplication {
				id,
				options: options.unwrap_or_default(),
				reply,
			})? {
				Response::Application(value) => Ok(value),
				_ => Err(DesktopError::internal("unexpected response")),
			}
			.map_err(Into::into)
		}))
	}

	/// Capture and accessibility share one serialized request. Neither a failed
	/// snapshot nor an abandoned reply replaces the last delivered input frame.
	#[napi]
	pub fn observe(
		&self,
		target: String,
		caps: Option<CaptureCaps>,
		ax_options: Option<AxSnapshotOptions>,
	) -> Result<task::Promise<DesktopObservation>> {
		let c = Arc::clone(&self.core);
		let token = c.cancellation.token();
		Ok(task::blocking("desktop.observe", (), move |_| {
			match c.call(token, |reply| Request::Observe {
				target: Target::parse(&target),
				caps: caps.unwrap_or_default(),
				options: ax_options.unwrap_or_default(),
				reply,
			})? {
				Response::Observation(value) => Ok(value),
				_ => Err(DesktopError::internal("unexpected response")),
			}
			.map_err(Into::into)
		}))
	}

	#[napi]
	pub fn menu_items(
		&self,
		target: String,
		path: Option<Vec<String>>,
	) -> Result<task::Promise<Vec<DesktopMenuItem>>> {
		let c = Arc::clone(&self.core);
		let token = c.cancellation.token();
		Ok(task::blocking("desktop.menuItems", (), move |_| {
			match c.call(token, |reply| Request::MenuItems {
				target: Target::parse(&target),
				path: path.unwrap_or_default(),
				reply,
			})? {
				Response::MenuItems(value) => Ok(value),
				_ => Err(DesktopError::internal("unexpected response")),
			}
			.map_err(Into::into)
		}))
	}

	#[napi]
	pub fn menu_select(&self, target: String, path: Vec<String>) -> Result<task::Promise<()>> {
		Ok(self.unit("desktop.menuSelect", move |reply| Request::MenuSelect {
			target: Target::parse(&target),
			path,
			reply,
		}))
	}

	#[napi]
	pub fn bring_to_current_space(&self, window_id: String) -> Result<task::Promise<()>> {
		Ok(self.unit("desktop.bringToCurrentSpace", move |reply| Request::BringToCurrentSpace {
			id: window_id,
			reply,
		}))
	}

	#[napi]
	pub fn hold_keys(
		&self,
		target: String,
		keys: Vec<String>,
		options: HoldOptions,
	) -> Result<task::Promise<()>> {
		let keys = parse_keys(&keys).map_err(napi::Error::from)?;
		if keys.is_empty() {
			return Err(DesktopError::invalid_key("holdKeys requires at least one key").into());
		}
		let duration = hold_duration(options.duration).map_err(napi::Error::from)?;
		Ok(self.unit("desktop.holdKeys", move |reply| Request::HoldKeys {
			target: Target::parse(&target),
			keys,
			duration,
			takeover: options.takeover,
			reply,
		}))
	}

	#[napi]
	pub fn hold_mouse(
		&self,
		target: String,
		x: f64,
		y: f64,
		options: HoldOptions,
	) -> Result<task::Promise<()>> {
		let duration = hold_duration(options.duration).map_err(napi::Error::from)?;
		let button = MouseButton::parse(options.button.as_deref()).map_err(napi::Error::from)?;
		let keys =
			parse_keys(options.keys.as_deref().unwrap_or_default()).map_err(napi::Error::from)?;
		Ok(self.unit("desktop.holdMouse", move |reply| Request::HoldMouse {
			target: Target::parse(&target),
			x,
			y,
			button,
			keys,
			duration,
			takeover: options.takeover,
			reply,
		}))
	}

	/// Native ownership only. Human approval is required by the host before
	/// calling this method.
	#[napi]
	pub fn acquire_control(&self) -> Result<task::Promise<DesktopControlState>> {
		let c = Arc::clone(&self.core);
		let token = c.cancellation.token();
		Ok(task::blocking("desktop.acquireControl", (), move |_| {
			token.check()?;
			if c.lifecycle.lock().closed {
				return Err(DesktopError::closed().into());
			}
			c.cancellation.acquire_control(&token)?;
			if let Err(error) = token.check() {
				c.cancellation.release_control();
				return Err(error.into());
			}
			Ok(DesktopControlState { active: c.cancellation.control_active() })
		}))
	}

	#[napi]
	pub fn release_control(&self) {
		self.core.cancellation.release_control();
	}

	#[napi]
	pub fn control_state(&self) -> DesktopControlState {
		DesktopControlState { active: self.core.cancellation.control_active() }
	}

	/// Retire queued work from a completed helper without revoking task control.
	#[napi]
	pub fn retire(&self) {
		self.core.cancellation.retire();
	}

	#[napi]
	pub fn capture(
		&self,
		target: String,
		caps: Option<CaptureCaps>,
	) -> Result<task::Promise<DesktopCapture>> {
		let c = Arc::clone(&self.core);
		let token = c.cancellation.token();
		let target = Target::parse(&target);
		Ok(task::blocking("desktop.capture", (), move |_| {
			match c.call(token, |reply| Request::Capture {
				target,
				caps: caps.unwrap_or_default(),
				reply,
			})? {
				Response::Capture(v) => Ok(v),
				_ => Err(DesktopError::internal("unexpected response")),
			}
			.map_err(Into::into)
		}))
	}

	/// Capture a fresh native-detail region without replacing the full input
	/// coordinate frame.
	#[napi]
	pub fn capture_region(
		&self,
		target: String,
		region: CaptureRegion,
		caps: Option<CaptureCaps>,
	) -> Result<task::Promise<DesktopCapture>> {
		let c = Arc::clone(&self.core);
		let token = c.cancellation.token();
		let target = Target::parse(&target);
		Ok(task::blocking("desktop.captureRegion", (), move |_| {
			match c.call(token, |reply| Request::CaptureRegion {
				target,
				region,
				caps: caps.unwrap_or_default(),
				reply,
			})? {
				Response::Capture(value) => Ok(value),
				_ => Err(DesktopError::internal("unexpected response")),
			}
			.map_err(Into::into)
		}))
	}

	#[napi]
	pub fn click(
		&self,
		target: String,
		x: f64,
		y: f64,
		opts: Option<PointerOptions>,
	) -> Result<task::Promise<()>> {
		let o = ParsedPointerOptions::parse(opts).map_err(napi::Error::from)?;
		Ok(self.unit("desktop.click", move |reply| Request::Click {
			target: Target::parse(&target),
			x,
			y,
			options: o,
			reply,
		}))
	}

	#[napi]
	pub fn move_mouse(
		&self,
		target: String,
		x: f64,
		y: f64,
		opts: Option<PointerOptions>,
	) -> Result<task::Promise<()>> {
		let takeover = ParsedPointerOptions::parse(opts)
			.map_err(napi::Error::from)?
			.takeover;
		Ok(self.unit("desktop.moveMouse", move |reply| Request::MoveMouse {
			target: Target::parse(&target),
			x,
			y,
			takeover,
			reply,
		}))
	}

	#[napi]
	pub fn drag(
		&self,
		target: String,
		path: Vec<DesktopPoint>,
		opts: Option<PointerOptions>,
	) -> Result<task::Promise<()>> {
		let o = ParsedPointerOptions::parse(opts).map_err(napi::Error::from)?;
		let path = path.into_iter().map(|p| (p.x, p.y)).collect();
		Ok(self.unit("desktop.drag", move |reply| Request::Drag {
			target: Target::parse(&target),
			path,
			options: o,
			reply,
		}))
	}

	#[napi]
	pub fn scroll(
		&self,
		target: String,
		x: f64,
		y: f64,
		dx: f64,
		dy: f64,
		opts: Option<PointerOptions>,
	) -> Result<task::Promise<()>> {
		let takeover = ParsedPointerOptions::parse(opts)
			.map_err(napi::Error::from)?
			.takeover;
		Ok(self.unit("desktop.scroll", move |reply| Request::Scroll {
			target: Target::parse(&target),
			x,
			y,
			dx,
			dy,
			takeover,
			reply,
		}))
	}

	#[napi]
	pub fn type_text(
		&self,
		target: String,
		text: String,
		opts: Option<PointerOptions>,
	) -> Result<task::Promise<()>> {
		let takeover = ParsedPointerOptions::parse(opts)
			.map_err(napi::Error::from)?
			.takeover;
		Ok(self.unit("desktop.typeText", move |reply| Request::TypeText {
			target: Target::parse(&target),
			text,
			takeover,
			reply,
		}))
	}

	#[napi]
	pub fn key_chord(
		&self,
		target: String,
		keys: Vec<String>,
		opts: Option<PointerOptions>,
	) -> Result<task::Promise<()>> {
		let keys = parse_keys(&keys).map_err(napi::Error::from)?;
		let takeover = ParsedPointerOptions::parse(opts)
			.map_err(napi::Error::from)?
			.takeover;
		Ok(self.unit("desktop.keyChord", move |reply| Request::KeyChord {
			target: Target::parse(&target),
			keys,
			takeover,
			reply,
		}))
	}

	#[napi]
	pub fn raise_window(&self, window_id: String) -> Result<task::Promise<()>> {
		Ok(self
			.unit("desktop.raiseWindow", move |reply| Request::RaiseWindow { id: window_id, reply }))
	}

	#[napi]
	pub fn ax_snapshot(
		&self,
		target: String,
		opts: Option<AxSnapshotOptions>,
	) -> Result<task::Promise<AxSnapshot>> {
		let c = Arc::clone(&self.core);
		let token = c.cancellation.token();
		Ok(task::blocking("desktop.axSnapshot", (), move |_| {
			match c.call(token, |reply| Request::AxSnapshot {
				target: Target::parse(&target),
				options: opts.unwrap_or_default(),
				reply,
			})? {
				Response::Snapshot(v) => Ok(v),
				_ => Err(DesktopError::internal("unexpected response")),
			}
			.map_err(Into::into)
		}))
	}

	#[napi]
	pub fn ax_query(&self, target: String, query: AxQuery) -> Result<task::Promise<Vec<AxNode>>> {
		Ok(self.nodes("desktop.axQuery", move |reply| Request::AxQuery {
			target: Target::parse(&target),
			query,
			reply,
		}))
	}

	/// Accessibility hit-test at global logical desktop coordinates; needs no
	/// prior capture.
	#[napi]
	pub fn ax_element_at(
		&self,
		target: String,
		x: f64,
		y: f64,
	) -> Result<task::Promise<Option<AxNode>>> {
		Ok(self.node("desktop.axElementAt", move |reply| Request::AxElementAt {
			target: Target::parse(&target),
			x,
			y,
			reply,
		}))
	}

	#[napi]
	pub fn ax_focused(&self) -> Result<task::Promise<Option<AxNode>>> {
		Ok(self.node("desktop.axFocused", move |reply| Request::AxFocused { reply }))
	}

	#[napi]
	pub fn ax_node(&self, reference: String) -> Result<task::Promise<AxNode>> {
		let c = Arc::clone(&self.core);
		let token = c.cancellation.token();
		Ok(task::blocking("desktop.axNode", (), move |_| {
			match c.call(token, |reply| Request::AxNode { reference, reply })? {
				Response::Node(Some(v)) => Ok(v),
				_ => Err(DesktopError::internal("unexpected response")),
			}
			.map_err(Into::into)
		}))
	}

	#[napi]
	pub fn ax_attributes(&self, reference: String) -> Result<task::Promise<Vec<(String, String)>>> {
		let c = Arc::clone(&self.core);
		let token = c.cancellation.token();
		Ok(task::blocking("desktop.axAttributes", (), move |_| {
			match c.call(token, |reply| Request::AxAttributes { reference, reply })? {
				Response::Attributes(v) => Ok(v),
				_ => Err(DesktopError::internal("unexpected response")),
			}
			.map_err(Into::into)
		}))
	}

	#[napi]
	pub fn ax_children(&self, reference: String) -> Result<task::Promise<Vec<AxNode>>> {
		Ok(self.nodes("desktop.axChildren", move |reply| Request::AxChildren { reference, reply }))
	}

	#[napi]
	pub fn ax_parent(&self, reference: String) -> Result<task::Promise<Option<AxNode>>> {
		Ok(self.node("desktop.axParent", move |reply| Request::AxParent { reference, reply }))
	}

	#[napi]
	pub fn ax_perform(&self, reference: String, action: String) -> Result<task::Promise<()>> {
		Ok(self.unit("desktop.axPerform", move |reply| Request::AxPerform {
			reference,
			action,
			reply,
		}))
	}

	#[napi]
	pub fn ax_set_value(&self, reference: String, value: String) -> Result<task::Promise<()>> {
		Ok(self.unit("desktop.axSetValue", move |reply| Request::AxSetValue {
			reference,
			value,
			reply,
		}))
	}

	#[napi]
	pub fn ax_focus(&self, reference: String) -> Result<task::Promise<()>> {
		Ok(self.unit("desktop.axFocus", move |reply| Request::AxFocus { reference, reply }))
	}

	#[napi]
	pub fn ax_click(
		&self,
		reference: String,
		opts: Option<PointerOptions>,
	) -> Result<task::Promise<()>> {
		let o = ParsedPointerOptions::parse(opts).map_err(napi::Error::from)?;
		Ok(self.unit("desktop.axClick", move |reply| Request::AxClick {
			reference,
			options: o,
			reply,
		}))
	}

	/// Immediately cancel operations submitted before this call. Later
	/// operations may proceed.
	#[napi]
	pub fn cancel(&self) {
		self.core.cancellation.cancel();
	}

	#[napi]
	pub fn close(&self) -> task::Promise<()> {
		self.cancel();
		let c = Arc::clone(&self.core);
		task::blocking("desktop.close", (), move |_| c.close().map_err(Into::into))
	}
}
impl DesktopSession {
	fn unit(
		&self,
		label: &'static str,
		make: impl FnOnce(Reply) -> Request + Send + 'static,
	) -> task::Promise<()> {
		let c = Arc::clone(&self.core);
		let token = c.cancellation.token();
		task::blocking(label, (), move |_| {
			c.call(token, make)
				.and_then(response_unit)
				.map_err(Into::into)
		})
	}

	fn nodes(
		&self,
		label: &'static str,
		make: impl FnOnce(Reply) -> Request + Send + 'static,
	) -> task::Promise<Vec<AxNode>> {
		let c = Arc::clone(&self.core);
		let token = c.cancellation.token();
		task::blocking(label, (), move |_| {
			match c.call(token, make)? {
				Response::Nodes(v) => Ok(v),
				_ => Err(DesktopError::internal("unexpected response")),
			}
			.map_err(Into::into)
		})
	}

	fn node(
		&self,
		label: &'static str,
		make: impl FnOnce(Reply) -> Request + Send + 'static,
	) -> task::Promise<Option<AxNode>> {
		let c = Arc::clone(&self.core);
		let token = c.cancellation.token();
		task::blocking(label, (), move |_| {
			match c.call(token, make)? {
				Response::Node(v) => Ok(v),
				_ => Err(DesktopError::internal("unexpected response")),
			}
			.map_err(Into::into)
		})
	}
}

#[cfg(test)]
mod capture_tests {
	use image::RgbaImage;

	use super::*;
	use crate::desktop::{
		ax::{AxBounds, AxHandle, AxProps},
		backend::{AxBackend, Backend},
		error::ErrorCode,
		keys::KeyName,
	};

	const WAYLAND_ID: &str = "atspi::1.31:/org/a11y/atspi/accessible/1";

	/// Backend that mints a composite AT-SPI window id, mirroring the Wayland
	/// `AtSpiAx` path. Exists to exercise `Worker::process` without a display.
	struct FakeWaylandBackend {
		window:                 DesktopWindow,
		overlap:                Option<DesktopWindow>,
		window_present:         bool,
		clicks:                 Arc<Mutex<Vec<String>>>,
		layout:                 Arc<Mutex<Vec<DesktopDisplay>>>,
		active_display:         Arc<Mutex<String>>,
		captures:               Arc<Mutex<u8>>,
		window_queries:         Arc<Mutex<u32>>,
		cancel_on_capabilities: Arc<Mutex<Option<CancellationSource>>>,
		snapshot_error:         Arc<Mutex<bool>>,
		cancel_on_snapshot:     Arc<Mutex<Option<CancellationSource>>>,
	}

	impl FakeWaylandBackend {
		fn new() -> Self {
			Self {
				window:                 DesktopWindow {
					id:      WAYLAND_ID.to_string(),
					title:   "Obsidian".to_string(),
					app:     "obsidian".to_string(),
					pid:     Some(1234),
					x:       0,
					y:       0,
					width:   64,
					height:  48,
					focused: true,
				},
				overlap:                None,
				window_present:         true,
				clicks:                 Arc::new(Mutex::new(Vec::new())),
				layout:                 Arc::new(Mutex::new(vec![DesktopDisplay {
					id:           "screen-1".to_string(),
					name:         "Test screen".to_string(),
					x:            0,
					y:            0,
					width:        64,
					height:       48,
					scale:        1.0,
					pixel_x:      0,
					pixel_y:      0,
					pixel_width:  64,
					pixel_height: 48,
					is_primary:   true,
				}])),
				active_display:         Arc::new(Mutex::new("screen-1".to_string())),
				captures:               Arc::new(Mutex::new(0)),
				window_queries:         Arc::new(Mutex::new(0)),
				cancel_on_capabilities: Arc::new(Mutex::new(None)),
				snapshot_error:         Arc::new(Mutex::new(false)),
				cancel_on_snapshot:     Arc::new(Mutex::new(None)),
			}
		}
	}

	impl AxBackend for FakeWaylandBackend {
		fn window_root(&mut self, _: &DesktopWindow) -> CoreResult<AxHandle> {
			let source = self.cancel_on_snapshot.lock().take();
			if let Some(source) = source {
				source.cancel();
			}
			if *self.snapshot_error.lock() {
				return Err(DesktopError::ax_failed("snapshot root unavailable"));
			}
			Ok(AxHandle::Test(1))
		}

		fn window_id(&mut self, _: &AxHandle, windows: &[DesktopWindow]) -> CoreResult<String> {
			windows
				.iter()
				.find(|window| window.id == self.window.id)
				.map(|window| window.id.clone())
				.ok_or_else(|| DesktopError::window_not_found("the element's window closed"))
		}

		fn props(&mut self, _: &AxHandle) -> CoreResult<AxProps> {
			Ok(AxProps {
				role:        "button".to_string(),
				native_role: "button".to_string(),
				title:       None,
				value:       None,
				description: None,
				enabled:     true,
				focused:     false,
				bounds:      Some(AxBounds { x: 10.0, y: 10.0, width: 20.0, height: 20.0 }),
				actions:     Vec::new(),
				child_count: 0,
			})
		}

		fn children(&mut self, _: &AxHandle) -> CoreResult<Vec<AxHandle>> {
			Ok(Vec::new())
		}

		fn parent(&mut self, _: &AxHandle) -> CoreResult<Option<AxHandle>> {
			unreachable!("tree traversal not exercised")
		}

		fn perform(&mut self, _: &AxHandle, _: &str) -> CoreResult<()> {
			unreachable!("semantic actions not exercised")
		}

		fn set_value(&mut self, _: &AxHandle, _: &str) -> CoreResult<()> {
			unreachable!("text input not exercised")
		}

		fn focus(&mut self, _: &AxHandle) -> CoreResult<()> {
			unreachable!("focus not exercised")
		}

		fn element_at(&mut self, _: f64, _: f64) -> CoreResult<Option<AxHandle>> {
			unreachable!("hit testing not exercised")
		}

		fn focused_element(&mut self) -> CoreResult<Option<AxHandle>> {
			unreachable!("focus not exercised")
		}

		fn attributes(&mut self, _: &AxHandle) -> CoreResult<Vec<(String, String)>> {
			unreachable!("attributes not exercised")
		}
	}

	impl Backend for FakeWaylandBackend {
		fn capabilities(&mut self) -> DesktopCapabilities {
			let source = self.cancel_on_capabilities.lock().take();
			if let Some(source) = source {
				source.cancel();
			}
			DesktopCapabilities {
				backend: "wayland".to_string(),
				display_server: Some("wayland".to_string()),
				capture: true,
				..DesktopCapabilities::unavailable()
			}
		}

		fn displays(&mut self) -> CoreResult<Vec<DesktopDisplay>> {
			Ok(self.layout.lock().clone())
		}

		fn windows(&mut self) -> CoreResult<Vec<DesktopWindow>> {
			*self.window_queries.lock() += 1;
			Ok(self
				.overlap
				.iter()
				.chain(self.window_present.then_some(&self.window))
				.cloned()
				.collect())
		}

		fn capture(
			&mut self,
			target: &Target,
			_caps: &CaptureCaps,
			selector: Option<&DisplaySelector>,
		) -> CoreResult<(RgbaImage, FrameGeometry)> {
			*self.captures.lock() += 1;
			let generation = *self.captures.lock();
			match target {
				Target::Window(id) if id == &self.window.id => {
					let image = RgbaImage::from_fn(self.window.width, self.window.height, |x, y| {
						image::Rgba([x as u8, y as u8, generation, 255])
					});
					let geometry =
						FrameGeometry::for_window(&self.window, image.width(), image.height());
					Ok((image, geometry))
				},
				Target::Window(id) => {
					Err(DesktopError::window_not_found(format!("Wayland window {id} not found")))
				},
				Target::Desktop | Target::Display(_) => {
					let active = DisplaySelector::Id(self.active_display.lock().clone());
					let mut displays = selector.unwrap_or(&active).select(self.displays()?, None)?;
					let min_x = displays.iter().map(|display| display.x).min().unwrap();
					let min_y = displays.iter().map(|display| display.y).min().unwrap();
					for display in &mut displays {
						display.pixel_x = (display.x - min_x) as u32;
						display.pixel_y = (display.y - min_y) as u32;
					}
					let geometry = FrameGeometry::for_displays(&displays);
					let (width, height) = geometry.dimensions();
					let image = RgbaImage::from_fn(width, height, |x, y| {
						image::Rgba([x as u8, y as u8, generation, 255])
					});
					Ok((image, geometry))
				},
			}
		}

		fn pointer(
			&mut self,
			target: &Target,
			_: PointerEvent,
			_: &FrameGeometry,
			_: DeliveryMode,
			_: &OperationToken,
		) -> CoreResult<()> {
			self.clicks.lock().push(target.key().to_string());
			Ok(())
		}

		fn type_text(
			&mut self,
			_: &Target,
			_: &str,
			_: DeliveryMode,
			_: &OperationToken,
		) -> CoreResult<()> {
			unreachable!("type_text not exercised")
		}

		fn key_chord(
			&mut self,
			_: &Target,
			_: &[KeyName],
			_: DeliveryMode,
			_: &OperationToken,
		) -> CoreResult<()> {
			unreachable!("key_chord not exercised")
		}

		fn hold_keys(
			&mut self,
			_: &Target,
			_: &[KeyName],
			_: Duration,
			_: DeliveryMode,
			_: &OperationToken,
		) -> CoreResult<()> {
			unreachable!("hold_keys not exercised")
		}

		fn menu_items(
			&mut self,
			_: &DesktopWindow,
			_: &[String],
		) -> CoreResult<Vec<DesktopMenuItem>> {
			unreachable!("menu_items not exercised")
		}

		fn menu_select(
			&mut self,
			_: &DesktopWindow,
			_: &[String],
			_: &OperationToken,
		) -> CoreResult<()> {
			unreachable!("menu_select not exercised")
		}

		fn raise_window(&mut self, _: &str, _: &OperationToken) -> CoreResult<()> {
			unreachable!("raise_window not exercised")
		}

		fn ax(&mut self) -> Option<&mut dyn AxBackend> {
			Some(self)
		}
	}

	fn worker_with(backend: impl Backend + 'static) -> Worker {
		Worker {
			backend:      Ok(Box::new(backend)),
			registry:     AxRegistry::default(),
			frames:       HashMap::new(),
			capabilities: Arc::default(),
		}
	}

	fn overlapping_backend() -> FakeWaylandBackend {
		let mut backend = FakeWaylandBackend::new();
		backend.overlap =
			Some(DesktopWindow { id: "unrelated-overlay".to_string(), ..backend.window.clone() });
		backend
	}

	fn click_reference(worker: &mut Worker, origin: &str) -> CoreResult<Response> {
		let (backend, registry) = (&mut worker.backend, &mut worker.registry);
		let ax = backend
			.as_mut()
			.map_err(|error| error.clone())?
			.ax()
			.ok_or_else(DesktopError::ax_unsupported)?;
		let reference = register_node(ax, registry, origin, AxHandle::Test(1))?.ref_;
		let (reply, _rx) = flume::bounded(1);
		worker.process(
			&Request::AxClick { reference, options: ParsedPointerOptions::parse(None)?, reply },
			&CancellationSource::default().token(),
		)
	}

	#[test]
	fn ax_click_targets_element_owner_despite_overlapping_or_snapshot_windows() {
		let backend = overlapping_backend();
		let clicks = Arc::clone(&backend.clicks);
		let mut worker = worker_with(backend);
		// A desktop ref has no snapshot owner; a traversed ref can retain a
		// snapshot origin different from its live native window.
		click_reference(&mut worker, "desktop").expect("desktop element click");
		click_reference(&mut worker, "unrelated-overlay").expect("traversed element click");
		assert_eq!(*clicks.lock(), [WAYLAND_ID, WAYLAND_ID]);
	}

	#[test]
	fn ax_click_never_retargets_a_closed_owner_to_an_overlapping_window() {
		let mut backend = overlapping_backend();
		backend.window_present = false;
		let clicks = Arc::clone(&backend.clicks);
		let mut worker = worker_with(backend);
		let Err(error) = click_reference(&mut worker, WAYLAND_ID) else {
			panic!("closed element window must refuse input");
		};
		assert_eq!(error.code, ErrorCode::WindowNotFound);
		assert!(clicks.lock().is_empty(), "no input may reach the overlapping window");
	}

	fn capture_request(target: Target) -> Request {
		let (reply, _rx) = flume::bounded(1);
		Request::Capture { target, caps: CaptureCaps::default(), reply }
	}

	fn zoom_request(target: Target, region: CaptureRegion, caps: CaptureCaps) -> Request {
		let (reply, _rx) = flume::bounded(1);
		Request::CaptureRegion { target, region, caps, reply }
	}

	#[test]
	fn capture_refreshes_the_nonblocking_capabilities_snapshot() {
		let core = SessionCore::new(DisplaySelector::Active);
		let mut worker = worker_with(FakeWaylandBackend::new());
		worker.capabilities = Arc::clone(&core.capabilities);
		worker
			.process(&capture_request(Target::Desktop), &core.cancellation.token())
			.unwrap();
		core.in_flight.store(1, Ordering::Release);
		let session = DesktopSession { core };
		let capabilities = session.capabilities();
		assert_eq!(capabilities.backend, "wayland");
		assert!(capabilities.capture);
		assert!(
			session.core.lifecycle.lock().tx.is_none(),
			"a busy getter must return the snapshot without starting or querying a worker"
		);
	}

	#[test]
	fn busy_snapshot_reports_an_escape_stop_that_failed_after_it_was_taken() {
		let core = SessionCore::new(DisplaySelector::Active);
		let mut snapshot = DesktopCapabilities::unavailable();
		snapshot.global_escape = true;
		*core.capabilities.lock() = Some(snapshot);
		core.cancellation.fail_escape_for_test();
		core.in_flight.store(1, Ordering::Release);
		let session = DesktopSession { core };
		assert!(!session.capabilities().global_escape);
	}

	#[test]
	fn cancelled_calls_never_start_the_worker_or_count_as_in_flight() {
		let core = SessionCore::new(DisplaySelector::Active);
		let token = core.cancellation.token();
		core.cancellation.cancel();
		assert_eq!(
			core
				.call(token, |reply| Request::ListWindows { reply })
				.err()
				.unwrap()
				.code,
			ErrorCode::Cancelled
		);
		assert_eq!(core.in_flight.load(Ordering::Acquire), 0);
		assert!(core.lifecycle.lock().tx.is_none());
	}

	#[test]
	fn failed_queue_delivery_releases_the_in_flight_count() {
		let core = SessionCore::new(DisplaySelector::Active);
		let (tx, rx) = flume::unbounded();
		core.lifecycle.lock().tx = Some(tx);
		drop(rx);
		assert!(
			core
				.call(core.cancellation.token(), |reply| Request::ListWindows { reply })
				.is_err()
		);
		assert_eq!(core.in_flight.load(Ordering::Acquire), 0);
	}

	#[test]
	fn zoom_uses_fresh_native_pixels_and_preserves_the_full_click_frame() {
		let backend = FakeWaylandBackend::new();
		let captures = Arc::clone(&backend.captures);
		let mut worker = worker_with(backend);
		let token = CancellationSource::default().token();
		let target = Target::Window(WAYLAND_ID.to_string());
		let (reply, _rx) = flume::bounded(1);
		worker
			.process(
				&Request::Capture {
					target: target.clone(),
					caps: CaptureCaps { max_width: Some(32), max_height: None },
					reply,
				},
				&token,
			)
			.unwrap();
		let base = worker.frame(&target).unwrap();
		let region = CaptureRegion { x: 8.0, y: 6.0, width: 8.0, height: 6.0 };
		let Response::Capture(zoom) = worker
			.process(
				&zoom_request(target.clone(), region, CaptureCaps {
					max_width:  Some(8),
					max_height: None,
				}),
				&token,
			)
			.unwrap()
		else {
			panic!("expected zoom capture")
		};
		assert_eq!(*captures.lock(), 2, "zoom must capture again, not enlarge the old PNG");
		assert_eq!((zoom.source_width, zoom.source_height), (16, 12));
		assert_eq!((zoom.width, zoom.height), (8, 6));
		assert_eq!((zoom.coordinate_width, zoom.coordinate_height), (32, 24));
		assert_eq!(zoom.region, Some(region));
		assert_eq!(worker.frame(&target).unwrap(), base);
		assert_eq!(worker.map_point(&target, 16.0, 12.0).unwrap().0, 32.0);
	}

	#[test]
	fn zoom_rejects_missing_invalid_and_stale_frames_before_capture() {
		let backend = FakeWaylandBackend::new();
		let captures = Arc::clone(&backend.captures);
		let layout = Arc::clone(&backend.layout);
		let mut worker = worker_with(backend);
		let token = CancellationSource::default().token();
		let target = Target::Window(WAYLAND_ID.to_string());
		let region = CaptureRegion { x: 0.0, y: 0.0, width: 8.0, height: 6.0 };
		let request = zoom_request(target.clone(), region, CaptureCaps::default());
		assert_eq!(
			worker.process(&request, &token).err().unwrap().code,
			ErrorCode::InvalidCoordinateFrame
		);
		assert_eq!(*captures.lock(), 0);
		worker
			.process(&capture_request(target.clone()), &token)
			.unwrap();
		let invalid =
			zoom_request(target, CaptureRegion { x: f64::NAN, ..region }, CaptureCaps::default());
		assert_eq!(
			worker.process(&invalid, &token).err().unwrap().code,
			ErrorCode::InvalidCoordinateFrame
		);
		layout.lock()[0].scale = 2.0;
		assert_eq!(
			worker.process(&request, &token).err().unwrap().code,
			ErrorCode::InvalidCoordinateFrame
		);
		assert_eq!(*captures.lock(), 1, "invalid zoom must not reach the capture backend");
	}

	#[test]
	fn desktop_zoom_pins_captured_display_after_active_focus_changes() {
		let backend = FakeWaylandBackend::new();
		let mut other = backend.layout.lock()[0].clone();
		other.id = "screen-2".to_string();
		other.x = 64;
		other.is_primary = false;
		backend.layout.lock().push(other);
		let active = Arc::clone(&backend.active_display);
		let mut worker = worker_with(backend);
		let token = CancellationSource::default().token();
		worker
			.process(&capture_request(Target::Desktop), &token)
			.unwrap();
		*active.lock() = "screen-2".to_string();
		assert_eq!(worker.map_point(&Target::Desktop, 10.0, 10.0).unwrap().0, 10.0);
		let Response::Capture(zoom) = worker
			.process(
				&zoom_request(
					Target::Desktop,
					CaptureRegion { x: 0.0, y: 0.0, width: 8.0, height: 6.0 },
					CaptureCaps::default(),
				),
				&token,
			)
			.unwrap()
		else {
			panic!("expected desktop zoom")
		};
		assert_eq!(zoom.displays.len(), 1);
		assert_eq!(zoom.displays[0].id, "screen-1");
		assert_eq!(worker.map_point(&Target::Desktop, 10.0, 10.0).unwrap().0, 10.0);
	}

	#[test]
	fn changed_layout_rejects_pointer_and_drag_before_dispatch() {
		let backend = FakeWaylandBackend::new();
		let clicks = Arc::clone(&backend.clicks);
		let layout = Arc::clone(&backend.layout);
		let mut worker = worker_with(backend);
		let token = CancellationSource::default().token();
		worker
			.process(&capture_request(Target::Desktop), &token)
			.unwrap();
		layout.lock()[0].x += 10;
		let (reply, _rx) = flume::bounded(1);
		let click = Request::Click {
			target: Target::Desktop,
			x: 10.0,
			y: 10.0,
			options: ParsedPointerOptions::parse(None).unwrap(),
			reply,
		};
		assert_eq!(
			worker.process(&click, &token).err().unwrap().code,
			ErrorCode::InvalidCoordinateFrame
		);
		let (reply, _rx) = flume::bounded(1);
		let drag = Request::Drag {
			target: Target::Desktop,
			path: vec![(10.0, 10.0), (20.0, 20.0)],
			options: ParsedPointerOptions::parse(None).unwrap(),
			reply,
		};
		assert_eq!(
			worker.process(&drag, &token).err().unwrap().code,
			ErrorCode::InvalidCoordinateFrame
		);
		assert!(clicks.lock().is_empty());
	}

	#[test]
	fn cancelled_full_capture_restores_previously_delivered_coordinates() {
		let backend = FakeWaylandBackend::new();
		let cancel_on_capabilities = Arc::clone(&backend.cancel_on_capabilities);
		let mut worker = worker_with(backend);
		let source = CancellationSource::default();
		let target = Target::Window(WAYLAND_ID.to_string());
		worker
			.execute(&capture_request(target.clone()), &source.token())
			.unwrap();
		let original = worker.frame(&target).unwrap();
		*cancel_on_capabilities.lock() = Some(source.clone());
		let (reply, _rx) = flume::bounded(1);
		let rejected = worker.execute(
			&Request::Capture {
				target: target.clone(),
				caps: CaptureCaps { max_width: Some(16), max_height: None },
				reply,
			},
			&source.token(),
		);
		assert_eq!(rejected.err().unwrap().code, ErrorCode::Cancelled);
		assert_eq!(worker.frame(&target).unwrap(), original);
		assert_eq!(worker.map_point(&target, 32.0, 24.0).unwrap().0, 32.0);
	}

	#[test]
	fn failed_observation_rolls_back_the_full_capture_frame() {
		let backend = FakeWaylandBackend::new();
		let fail = Arc::clone(&backend.snapshot_error);
		let mut worker = worker_with(backend);
		let source = CancellationSource::default();
		let target = Target::Window(WAYLAND_ID.to_string());
		worker
			.execute(&capture_request(target.clone()), &source.token())
			.unwrap();
		let original = worker.frame(&target).unwrap();
		*fail.lock() = true;
		let (reply, _rx) = flume::bounded(1);
		let request = Request::Observe {
			target: target.clone(),
			caps: CaptureCaps { max_width: Some(16), max_height: None },
			options: AxSnapshotOptions::default(),
			reply,
		};
		assert_eq!(
			worker
				.execute(&request, &source.token())
				.err()
				.unwrap()
				.code,
			ErrorCode::AxFailed
		);
		assert_eq!(worker.frame(&target).unwrap(), original);
		*fail.lock() = false;
		let Response::Observation(observation) = worker.execute(&request, &source.token()).unwrap()
		else {
			panic!("expected observation");
		};
		assert_eq!(observation.capture.coordinate_width, 16);
		assert_eq!(observation.accessibility.node_count, 1);
		assert_eq!(worker.frame(&target).unwrap().dimensions(), (16, 12));
	}

	#[test]
	fn cancellation_during_observation_accessibility_restores_delivered_frame() {
		let backend = FakeWaylandBackend::new();
		let cancel = Arc::clone(&backend.cancel_on_snapshot);
		let mut worker = worker_with(backend);
		let source = CancellationSource::default();
		let target = Target::Window(WAYLAND_ID.to_string());
		worker
			.execute(&capture_request(target.clone()), &source.token())
			.unwrap();
		let original = worker.frame(&target).unwrap();
		*cancel.lock() = Some(source.clone());
		let (reply, _) = flume::bounded(1);
		let request = Request::Observe {
			target: target.clone(),
			caps: CaptureCaps { max_width: Some(16), max_height: None },
			options: AxSnapshotOptions::default(),
			reply,
		};
		assert_eq!(
			worker
				.execute(&request, &source.token())
				.err()
				.unwrap()
				.code,
			ErrorCode::Cancelled
		);
		assert_eq!(worker.frame(&target).unwrap(), original);
		assert!(worker.execute(&request, &source.token()).is_ok());
	}

	#[test]
	fn abandoned_capture_and_observation_replies_never_commit_frames() {
		let mut worker = worker_with(FakeWaylandBackend::new());
		let token = CancellationSource::default().token();
		let target = Target::Window(WAYLAND_ID.to_string());
		// capture_request drops its receiver before dispatch.
		worker.dispatch(capture_request(target.clone()), &token);
		assert!(worker.frame(&target).is_err());
		worker
			.execute(&capture_request(target.clone()), &token)
			.unwrap();
		let original = worker.frame(&target).unwrap();
		let (reply, rx) = flume::bounded(0);
		drop(rx);
		worker.dispatch(
			Request::Observe {
				target: target.clone(),
				caps: CaptureCaps { max_width: Some(16), max_height: None },
				options: AxSnapshotOptions::default(),
				reply,
			},
			&token,
		);
		assert_eq!(worker.frame(&target).unwrap(), original);
	}

	#[test]
	fn display_handles_isolate_frames_and_reject_off_display_keyboard_input() {
		let backend = FakeWaylandBackend::new();
		let mut other = backend.layout.lock()[0].clone();
		other.id = "screen-2".to_string();
		other.x = 64;
		other.is_primary = false;
		backend.layout.lock().push(other);
		let mut worker = worker_with(backend);
		let token = CancellationSource::default().token();
		let left = Target::parse("display:screen-1");
		let right = Target::parse("display:screen-2");
		worker
			.execute(&capture_request(left.clone()), &token)
			.unwrap();
		let original = worker.frame(&left).unwrap();
		worker
			.execute(&capture_request(right.clone()), &token)
			.unwrap();
		assert_eq!(worker.frame(&left).unwrap(), original);
		assert!(worker.frame(&Target::Desktop).is_err());
		assert_eq!(worker.map_point(&left, 10.0, 10.0).unwrap().0, 10.0);
		assert_eq!(worker.map_point(&right, 10.0, 10.0).unwrap().0, 74.0);
		assert!(worker.validate_keyboard_target(&left).is_ok());
		assert_eq!(
			worker.validate_keyboard_target(&right).unwrap_err().code,
			ErrorCode::InvalidTarget
		);
	}

	#[test]
	fn hold_duration_and_takeover_options_are_validated_without_losing_tristate() {
		for seconds in [f64::NAN, f64::INFINITY, -0.1, 100.1] {
			assert!(hold_duration(seconds).is_err());
		}
		assert_eq!(hold_duration(0.0).unwrap(), Duration::ZERO);
		assert_eq!(hold_duration(100.0).unwrap(), Duration::from_secs(100));
		let token = CancellationSource::default().token();
		let default = ParsedPointerOptions::parse(None).unwrap();
		assert_eq!(default.takeover, None);
		assert_eq!(default.mode(&token), DeliveryMode::Background);
		for (takeover, expected) in
			[(false, DeliveryMode::Background), (true, DeliveryMode::Foreground)]
		{
			let options = ParsedPointerOptions::parse(Some(PointerOptions {
				takeover: Some(takeover),
				..PointerOptions::default()
			}))
			.unwrap();
			assert_eq!(options.takeover, Some(takeover));
			assert_eq!(options.mode(&token), expected);
		}
	}

	#[test]
	fn only_takeover_requests_arm_the_physical_escape_stop() {
		let token = CancellationSource::default().token();
		let window = Target::Window("42".to_string());
		let reply = || flume::unbounded().0;
		let typing = |target: &Target, takeover| Request::TypeText {
			target: target.clone(),
			text: "abc".to_string(),
			takeover,
			reply: reply(),
		};
		let holding = |target: &Target, takeover| Request::HoldKeys {
			target: target.clone(),
			keys: parse_keys(&["shift".to_string()]).unwrap(),
			duration: Duration::ZERO,
			takeover,
			reply: reply(),
		};
		let clicking = |target: &Target, takeover| Request::Click {
			target:  target.clone(),
			x:       0.0,
			y:       0.0,
			options: ParsedPointerOptions::parse(Some(PointerOptions {
				takeover,
				..PointerOptions::default()
			}))
			.unwrap(),
			reply:   reply(),
		};
		let perform = |action: &str| Request::AxPerform {
			reference: "e1".to_string(),
			action:    action.to_string(),
			reply:     reply(),
		};
		let open = |activate| Request::OpenApplication {
			id:      "com.apple.TextEdit".to_string(),
			options: ApplicationOpenOptions { activate },
			reply:   reply(),
		};
		let background = [
			typing(&window, None),
			typing(&window, Some(false)),
			holding(&window, None),
			clicking(&window, Some(false)),
			perform("AXPress"),
			perform("showMenu"),
			open(None),
			open(Some(false)),
		];
		for request in background {
			assert!(!request.takes_over(&token), "background input leaves Escape to the user");
		}
		let display = Target::parse("display:screen-1");
		let takeover = [
			typing(&window, Some(true)),
			holding(&window, Some(true)),
			clicking(&window, Some(true)),
			typing(&Target::Desktop, None),
			holding(&Target::Desktop, Some(false)),
			clicking(&display, None),
			Request::RaiseWindow { id: "42".to_string(), reply: reply() },
			perform("raise"),
			perform("AXRaise"),
			open(Some(true)),
		];
		for request in takeover {
			assert!(request.takes_over(&token), "takeover input keeps the Escape stop");
		}
	}

	#[test]
	fn space_move_attempt_invalidates_the_window_coordinate_frame() {
		let mut worker = worker_with(FakeWaylandBackend::new());
		let token = CancellationSource::default().token();
		let target = Target::Window(WAYLAND_ID.to_string());
		worker
			.execute(&capture_request(target.clone()), &token)
			.unwrap();
		let (reply, _) = flume::bounded(1);
		assert_eq!(
			worker
				.process(&Request::BringToCurrentSpace { id: WAYLAND_ID.into(), reply }, &token)
				.err()
				.unwrap()
				.code,
			ErrorCode::SpaceUnsupported,
		);
		assert!(worker.frame(&target).is_err());
	}

	#[test]
	fn cancelled_queue_generation_never_runs_and_later_requests_recover() {
		let backend = FakeWaylandBackend::new();
		let queries = Arc::clone(&backend.window_queries);
		let mut worker = worker_with(backend);
		let source = CancellationSource::default();
		let (queue_tx, queue_rx) = flume::unbounded();
		let (reply, result) = flume::bounded(1);
		queue_tx
			.send(QueuedRequest { request: Request::ListWindows { reply }, token: source.token() })
			.unwrap_or_else(|_| panic!("queue unexpectedly disconnected"));
		source.cancel();
		let queued = queue_rx.recv().unwrap();
		let response = worker.execute(&queued.request, &queued.token);
		queued.request.reply(response);
		assert_eq!(result.recv().unwrap().err().unwrap().code, ErrorCode::Cancelled);
		assert_eq!(*queries.lock(), 0);
		let (reply, _rx) = flume::bounded(1);
		assert!(matches!(
			worker.execute(&Request::ListWindows { reply }, &source.token()),
			Ok(Response::Windows(_))
		));
		assert_eq!(*queries.lock(), 1);
	}

	/// Regression for #7701: a composite AT-SPI window id minted by the Wayland
	/// backend's own `windows()` must reach the backend, not be rejected by a
	/// `u64` pre-parse in the shared request path.
	#[test]
	fn capture_accepts_non_numeric_wayland_window_id() {
		let mut worker = worker_with(FakeWaylandBackend::new());
		let response = worker
			.process(
				&capture_request(Target::Window(WAYLAND_ID.to_string())),
				&CancellationSource::default().token(),
			)
			.expect("wayland window id should be accepted by capture");
		let Response::Capture(capture) = response else {
			panic!("expected a capture response");
		};
		assert_eq!(capture.target, WAYLAND_ID);
		assert_eq!(capture.width, 64);
		assert_eq!(capture.height, 48);
		assert_eq!(capture.backend, "wayland");
	}

	/// Unknown ids still fail — but as `WindowNotFound` from the backend lookup,
	/// never as an `InvalidTarget` pre-parse rejection of a non-`u64` id.
	#[test]
	fn capture_rejects_unknown_window_id_via_backend_lookup() {
		let mut worker = worker_with(FakeWaylandBackend::new());
		let Err(err) = worker.process(
			&capture_request(Target::Window("does-not-exist".to_string())),
			&CancellationSource::default().token(),
		) else {
			panic!("unknown window id should fail");
		};
		assert_eq!(err.code, ErrorCode::WindowNotFound);
	}
}
