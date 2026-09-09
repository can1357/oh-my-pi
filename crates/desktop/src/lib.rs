//! Native desktop capture, input, and accessibility automation.
//!
//! One actor thread owns all platform objects for a session. Capture
//! establishes the coordinate frame used by subsequent pointer input, while
//! accessibility references are generation-fenced by the actor registry.

mod ax;
mod backend;
mod error;
mod frame;
mod keys;
#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
mod types;
#[cfg(any(target_os = "windows", test))]
mod win32;

use std::{
	cell::RefCell,
	collections::HashMap,
	iter,
	panic::{self, AssertUnwindSafe},
	sync::{
		Arc,
		atomic::{AtomicBool, Ordering},
	},
	thread,
	thread::JoinHandle,
	time::{Duration, Instant},
};

use ax::{AxRegistry, register_node};
use backend::{Backend, DeliveryMode, MouseButton, PointerEvent};
use bytes::Bytes;
use error::CoreResult;
pub use error::{DesktopError, DesktopResult, ErrorCode};
use flume::Receiver;
use frame::{FrameGeometry, apply_capture_caps, encode_png};
use keys::{parse_keys, parse_modifiers};
use parking_lot::Mutex;
use tokio::task;
pub use types::*;

const OPERATION_TIMEOUT: Duration = Duration::from_mins(1);
const CLOSE_TIMEOUT: Duration = Duration::from_secs(2);

enum Response {
	Capabilities(DesktopCapabilities),
	Displays(Vec<DesktopDisplay>),
	Windows(Vec<DesktopWindow>),
	Capture(DesktopCapture),
	Unit,
	Snapshot(AxSnapshot),
	Nodes(Vec<AxNode>),
	Node(Option<AxNode>),
	Attributes(Vec<(String, String)>),
}

type Reply = flume::Sender<CoreResult<Response>>;
struct OperationState {
	cancelled: AtomicBool,
	deadline:  Instant,
}

impl OperationState {
	fn check(&self) -> CoreResult<()> {
		if self.cancelled.load(Ordering::Acquire) || Instant::now() >= self.deadline {
			Err(DesktopError::timeout("native desktop operation expired before execution"))
		} else {
			Ok(())
		}
	}
}

struct Work {
	request: Request,
	state:   Arc<OperationState>,
}

struct CancelOnDrop(Arc<OperationState>);

impl Drop for CancelOnDrop {
	fn drop(&mut self) {
		self.0.cancelled.store(true, Ordering::Release);
	}
}

thread_local! {
	static ACTIVE_OPERATION: RefCell<Option<Arc<OperationState>>> = const { RefCell::new(None) };
}

struct OperationScope;

impl OperationScope {
	fn enter(state: Arc<OperationState>) -> Self {
		ACTIVE_OPERATION.with_borrow_mut(|active| *active = Some(state));
		Self
	}
}

impl Drop for OperationScope {
	fn drop(&mut self) {
		ACTIVE_OPERATION.with_borrow_mut(Option::take);
	}
}

pub(crate) fn operation_checkpoint() -> CoreResult<()> {
	ACTIVE_OPERATION.with_borrow(|active| {
		active
			.as_ref()
			.map_or(Ok(()), |operation| operation.check())
	})
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
	Click {
		target:  Target,
		x:       f64,
		y:       f64,
		options: ParsedPointerOptions,
		reply:   Reply,
	},
	MoveMouse {
		target: Target,
		x:      f64,
		y:      f64,
		mode:   DeliveryMode,
		reply:  Reply,
	},
	Drag {
		target:  Target,
		path:    Vec<(f64, f64)>,
		options: ParsedPointerOptions,
		reply:   Reply,
	},
	Scroll {
		target: Target,
		x:      f64,
		y:      f64,
		dx:     f64,
		dy:     f64,
		mode:   DeliveryMode,
		reply:  Reply,
	},
	TypeText {
		target: Target,
		text:   String,
		mode:   DeliveryMode,
		reply:  Reply,
	},
	KeyChord {
		target: Target,
		keys:   Vec<keys::KeyName>,
		mode:   DeliveryMode,
		reply:  Reply,
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
	fn reply(self, result: CoreResult<Response>) {
		let reply = match self {
			Self::Capabilities { reply }
			| Self::ListDisplays { reply }
			| Self::ListWindows { reply }
			| Self::Capture { reply, .. }
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
		let _ = reply.send(result);
	}

	const fn is_close(&self) -> bool {
		matches!(self, Self::Close { .. })
	}
}

#[derive(Clone, Copy)]
struct ParsedPointerOptions {
	button:    MouseButton,
	count:     u32,
	modifiers: backend::Modifiers,
	mode:      DeliveryMode,
}
impl ParsedPointerOptions {
	fn parse(options: Option<PointerOptions>) -> CoreResult<Self> {
		let options = options.unwrap_or_default();
		Ok(Self {
			button:    MouseButton::parse(options.button.as_deref())?,
			count:     options.count.unwrap_or(1).max(1),
			modifiers: parse_modifiers(options.modifiers.as_deref().unwrap_or_default())?,
			mode:      DeliveryMode::parse(options.delivery_mode.as_deref()),
		})
	}
}

struct Worker {
	backend:      CoreResult<Box<dyn Backend>>,
	registry:     AxRegistry,
	frames:       HashMap<String, FrameGeometry>,
	capabilities: Arc<Mutex<DesktopCapabilities>>,
}

impl Worker {
	#[tracing::instrument(name = "desktop_device_initialize", level = "debug", skip_all)]
	fn new(selector: DisplaySelector, capabilities: Arc<Mutex<DesktopCapabilities>>) -> Self {
		let backend = create_backend(selector);
		if let Err(error) = &backend {
			tracing::warn!(
				error_code = %error.code,
				%error,
				"desktop device initialization failed"
			);
		}
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
			Target::Desktop => windows
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

	fn map_point(
		&mut self,
		target: &Target,
		x: f64,
		y: f64,
	) -> CoreResult<(f64, f64, FrameGeometry)> {
		let frame = self.frame(target)?;
		let current = if matches!(target, Target::Window(_)) {
			Some(self.window(target)?)
		} else {
			None
		};
		let (x, y) = frame.map_point(x, y, current.as_ref())?;
		Ok((x, y, frame))
	}

	fn ax(&mut self) -> CoreResult<&mut dyn backend::AxBackend> {
		self
			.backend()?
			.ax()
			.ok_or_else(DesktopError::ax_unsupported)
	}

	fn process(&mut self, request: &Request, operation: &OperationState) -> CoreResult<Response> {
		operation.check()?;
		match request {
			Request::Capabilities { .. } => {
				let caps = match self.backend.as_mut() {
					Ok(backend) => backend.capabilities(),
					Err(_) => DesktopCapabilities::unavailable(),
				};
				*self.capabilities.lock() = caps.clone();
				Ok(Response::Capabilities(caps))
			},
			Request::ListDisplays { .. } => Ok(Response::Displays(self.backend()?.displays()?)),
			Request::ListWindows { .. } => Ok(Response::Windows(self.backend()?.windows()?)),
			Request::Capture { target, caps, .. } => {
				let (image, mut geometry) = self.backend()?.capture(target, caps)?;
				let source_width = image.width();
				let source_height = image.height();
				let image = apply_capture_caps(image, &mut geometry, caps)?;
				let width = image.width();
				let height = image.height();
				let source = match target {
					Target::Desktop => self.backend()?.displays()?,
					Target::Window(_) => {
						let w = self.window(target)?;
						vec![DesktopDisplay {
							id:           w.id,
							name:         format!("{} — {}", w.app, w.title),
							x:            w.x,
							y:            w.y,
							width:        w.width,
							height:       w.height,
							scale:        f64::from(width) / f64::from(w.width.max(1)),
							pixel_x:      0,
							pixel_y:      0,
							pixel_width:  width,
							pixel_height: height,
							is_primary:   false,
						}]
					},
				};
				let displays = geometry.display_metadata(&source);
				let png = encode_png(image)?;
				self.frames.insert(target.key().to_string(), geometry);
				let capabilities = self.backend()?.capabilities();
				*self.capabilities.lock() = capabilities.clone();
				Ok(Response::Capture(DesktopCapture {
					data: Bytes::from(png),
					width,
					height,
					source_width,
					source_height,
					target: target.key().to_string(),
					displays,
					backend: capabilities.backend,
					display_server: capabilities.display_server,
				}))
			},
			Request::Click { target, x, y, options, .. } => {
				let (x, y, frame) = self.map_point(target, *x, *y)?;
				operation.check()?;
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
					options.mode,
				)?;
				Ok(Response::Unit)
			},
			Request::MoveMouse { target, x, y, mode, .. } => {
				let (x, y, frame) = self.map_point(target, *x, *y)?;
				operation.check()?;
				self
					.backend()?
					.pointer(target, PointerEvent::Move { x, y }, &frame, *mode)?;
				Ok(Response::Unit)
			},
			Request::Drag { target, path, options, .. } => {
				let frame = self.frame(target)?;
				let current = if matches!(target, Target::Window(_)) {
					Some(self.window(target)?)
				} else {
					None
				};
				let mapped = path
					.iter()
					.map(|(x, y)| frame.map_point(*x, *y, current.as_ref()))
					.collect::<CoreResult<Vec<_>>>()?;
				operation.check()?;
				self.backend()?.pointer(
					target,
					PointerEvent::Drag {
						path:      mapped,
						button:    options.button,
						modifiers: options.modifiers,
					},
					&frame,
					options.mode,
				)?;
				Ok(Response::Unit)
			},
			Request::Scroll { target, x, y, dx, dy, mode, .. } => {
				let (x, y, frame) = self.map_point(target, *x, *y)?;
				operation.check()?;
				self.backend()?.pointer(
					target,
					PointerEvent::Scroll { x, y, dx: *dx, dy: *dy },
					&frame,
					*mode,
				)?;
				Ok(Response::Unit)
			},
			Request::TypeText { target, text, mode, .. } => {
				operation.check()?;
				self.backend()?.type_text(target, text, *mode)?;
				Ok(Response::Unit)
			},
			Request::KeyChord { target, keys, mode, .. } => {
				operation.check()?;
				self.backend()?.key_chord(target, keys, *mode)?;
				Ok(Response::Unit)
			},
			Request::RaiseWindow { id, .. } => {
				operation.check()?;
				self.backend()?.raise_window(id)?;
				Ok(Response::Unit)
			},
			Request::AxSnapshot { target, options, .. } => {
				let window = self.window(target)?;
				let (backend, registry) = (&mut self.backend, &mut self.registry);
				let ax = backend
					.as_mut()
					.map_err(|error| error.clone())?
					.ax()
					.ok_or_else(DesktopError::ax_unsupported)?;
				Ok(Response::Snapshot(ax::snapshot(ax, registry, &window, options)?))
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
				Ok(Response::Node(Some(axnode(reference.clone(), props))))
			},
			Request::AxAttributes { reference, .. } => {
				let h = self.registry.resolve(reference)?;
				let mut attributes = self.ax()?.attributes(&h)?;
				for (_, value) in &mut attributes {
					if value.chars().count() > 200 {
						*value = value.chars().take(199).chain(iter::once('.')).collect();
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
				operation.check()?;
				if action.eq_ignore_ascii_case("press") {
					ax::ax_press(self.ax()?, &h)?;
				} else {
					self.ax()?.perform(&h, action)?;
				}
				Ok(Response::Unit)
			},
			Request::AxSetValue { reference, value, .. } => {
				let h = self.registry.resolve(reference)?;
				operation.check()?;
				self.ax()?.set_value(&h, value)?;
				Ok(Response::Unit)
			},
			Request::AxFocus { reference, .. } => {
				let h = self.registry.resolve(reference)?;
				operation.check()?;
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
				let window = windows
					.into_iter()
					.find(|w| {
						x >= f64::from(w.x)
							&& x < f64::from(w.x + w.width as i32)
							&& y >= f64::from(w.y)
							&& y < f64::from(w.y + w.height as i32)
					})
					.ok_or_else(|| {
						DesktopError::window_not_found(format!("no window contains {reference}"))
					})?;
				let target = Target::Window(window.id);
				operation.check()?;
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
					options.mode,
				)?;
				Ok(Response::Unit)
			},
			Request::Close { .. } => Ok(Response::Unit),
		}
	}
}

fn axnode(reference: String, props: ax::AxProps) -> AxNode {
	let (x, y, width, height) = props
		.bounds
		.map_or((None, None, None, None), |b| (Some(b.x), Some(b.y), Some(b.width), Some(b.height)));
	AxNode {
		ref_: reference,
		role: props.role,
		native_role: props.native_role,
		title: props.title,
		value: props.value,
		description: props.description,
		enabled: props.enabled,
		focused: props.focused,
		x,
		y,
		width,
		height,
		actions: (!props.actions.is_empty()).then_some(props.actions),
		child_count: props.child_count,
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
	tx:     Option<flume::Sender<Work>>,
	done:   Option<Receiver<()>>,
	join:   Option<JoinHandle<()>>,
	closed: bool,
}
struct SessionCore {
	selector:     DisplaySelector,
	lifecycle:    Mutex<Lifecycle>,
	capabilities: Arc<Mutex<DesktopCapabilities>>,
	shutdown:     Arc<AtomicBool>,
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
			capabilities: Arc::new(Mutex::new(DesktopCapabilities::unavailable())),
			shutdown: Arc::new(AtomicBool::new(false)),
		})
	}

	fn ensure_started(&self) -> CoreResult<flume::Sender<Work>> {
		let mut lifecycle = self.lifecycle.lock();
		if lifecycle.closed {
			return Err(DesktopError::closed());
		}
		if let Some(tx) = &lifecycle.tx {
			return Ok(tx.clone());
		}
		let (tx, rx) = flume::unbounded::<Work>();
		let (done_tx, done_rx) = flume::bounded(1);
		let selector = self.selector.clone();
		let caps = Arc::clone(&self.capabilities);
		let shutdown = Arc::clone(&self.shutdown);
		let join = thread::Builder::new()
			.name("omp-desktop-session".into())
			.spawn(move || {
				let mut worker = Worker::new(selector, caps);
				while let Ok(work) = rx.recv() {
					let Work { request, state } = work;
					let close = request.is_close();
					let result = if shutdown.load(Ordering::Acquire) && !close {
						Err(DesktopError::closed())
					} else {
						let _scope = OperationScope::enter(Arc::clone(&state));
						panic::catch_unwind(AssertUnwindSafe(|| worker.process(&request, &state)))
							.unwrap_or_else(|_| {
								Err(DesktopError::internal("native desktop worker panicked"))
							})
					};
					request.reply(result);
					if close {
						break;
					}
				}
				let _ = done_tx.send(());
			})
			.map_err(|e| {
				tracing::warn!(error = %e, "desktop worker initialization failed");
				DesktopError::internal(format!("failed to start native desktop worker: {e}"))
			})?;
		lifecycle.tx = Some(tx.clone());
		lifecycle.done = Some(done_rx);
		lifecycle.join = Some(join);
		Ok(tx)
	}

	fn call(
		&self,
		make: impl FnOnce(Reply) -> Request,
		state: Arc<OperationState>,
	) -> CoreResult<Response> {
		let (txr, rxr) = flume::bounded(1);
		self
			.ensure_started()?
			.send(Work { request: make(txr), state: Arc::clone(&state) })
			.map_err(|_| DesktopError::internal("native desktop worker stopped unexpectedly"))?;
		let result = rxr.recv_deadline(state.deadline).map_err(|e| {
			DesktopError::timeout(format!("native desktop operation did not complete: {e}"))
		});
		if result.is_err() {
			state.cancelled.store(true, Ordering::Release);
		}
		result?
	}

	fn close(&self) -> CoreResult<()> {
		let mut lifecycle = self.lifecycle.lock();
		lifecycle.closed = true;
		self.shutdown.store(true, Ordering::Release);
		let Some(tx) = lifecycle.tx.take() else {
			return Ok(());
		};
		let (rtx, rrx) = flume::bounded(1);
		tx.send(Work {
			request: Request::Close { reply: rtx },
			state:   Arc::new(OperationState {
				cancelled: AtomicBool::new(false),
				deadline:  Instant::now() + CLOSE_TIMEOUT,
			}),
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
		let lifecycle = self.lifecycle.get_mut();
		if let Some(tx) = lifecycle.tx.take() {
			let (reply, _) = flume::bounded(1);
			self.shutdown.store(true, Ordering::Release);
			let _ = tx.send(Work {
				request: Request::Close { reply },
				state:   Arc::new(OperationState {
					cancelled: AtomicBool::new(false),
					deadline:  Instant::now() + CLOSE_TIMEOUT,
				}),
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
///
/// The session owns one dedicated actor thread. Calls are serialized there so
/// platform APIs with thread affinity never race each other. Async methods use
/// Tokio's blocking pool only while awaiting the actor reply.
#[derive(Clone)]
pub struct DesktopSession {
	core: Arc<SessionCore>,
}

impl DesktopSession {
	/// Create a lazily-started session.
	pub fn new(options: Option<DesktopSessionOptions>) -> Self {
		Self { core: SessionCore::new(DisplaySelector::parse(options.and_then(|o| o.display))) }
	}

	/// Return the latest capability snapshot, probing the backend when needed.
	pub async fn capabilities(&self) -> CoreResult<DesktopCapabilities> {
		self
			.operation(
				|reply| Request::Capabilities { reply },
				|response| match response {
					Response::Capabilities(value) => Ok(value),
					_ => Err(DesktopError::internal("unexpected desktop worker response")),
				},
			)
			.await
	}

	/// Return the last capability snapshot without starting the actor.
	pub fn cached_capabilities(&self) -> DesktopCapabilities {
		self.core.capabilities.lock().clone()
	}

	/// List attached displays.
	pub async fn list_displays(&self) -> CoreResult<Vec<DesktopDisplay>> {
		self
			.operation(
				|reply| Request::ListDisplays { reply },
				|response| match response {
					Response::Displays(value) => Ok(value),
					_ => Err(DesktopError::internal("unexpected desktop worker response")),
				},
			)
			.await
	}

	/// List capturable top-level windows.
	pub async fn list_windows(&self) -> CoreResult<Vec<DesktopWindow>> {
		self
			.operation(
				|reply| Request::ListWindows { reply },
				|response| match response {
					Response::Windows(value) => Ok(value),
					_ => Err(DesktopError::internal("unexpected desktop worker response")),
				},
			)
			.await
	}

	/// Capture a desktop or window and remember its coordinate frame.
	#[tracing::instrument(
		name = "desktop_capture",
		level = "debug",
		skip_all,
		fields(target = target.kind())
	)]
	pub async fn capture(&self, target: Target, caps: CaptureCaps) -> CoreResult<DesktopCapture> {
		let target_kind = target.kind();
		let result = self
			.operation(
				move |reply| Request::Capture { target, caps, reply },
				|response| match response {
					Response::Capture(value) => Ok(value),
					_ => Err(DesktopError::internal("unexpected desktop worker response")),
				},
			)
			.await;
		if let Err(error) = &result {
			tracing::warn!(
				target = target_kind,
				error_code = %error.code,
				%error,
				"desktop capture failed"
			);
		}
		result
	}

	/// Click in coordinates from the latest capture of `target`.
	pub async fn click(
		&self,
		target: Target,
		x: f64,
		y: f64,
		options: Option<PointerOptions>,
	) -> CoreResult<()> {
		let options = ParsedPointerOptions::parse(options)?;
		self
			.unit(move |reply| Request::Click { target, x, y, options, reply })
			.await
	}

	/// Move the pointer in coordinates from the latest capture of `target`.
	pub async fn move_mouse(
		&self,
		target: Target,
		x: f64,
		y: f64,
		options: Option<PointerOptions>,
	) -> CoreResult<()> {
		let mode = ParsedPointerOptions::parse(options)?.mode;
		self
			.unit(move |reply| Request::MoveMouse { target, x, y, mode, reply })
			.await
	}

	/// Drag through capture-relative points.
	pub async fn drag(
		&self,
		target: Target,
		path: Vec<DesktopPoint>,
		options: Option<PointerOptions>,
	) -> CoreResult<()> {
		let options = ParsedPointerOptions::parse(options)?;
		let path = path.into_iter().map(|point| (point.x, point.y)).collect();
		self
			.unit(move |reply| Request::Drag { target, path, options, reply })
			.await
	}

	/// Scroll at a capture-relative point.
	pub async fn scroll(
		&self,
		target: Target,
		x: f64,
		y: f64,
		dx: f64,
		dy: f64,
		options: Option<PointerOptions>,
	) -> CoreResult<()> {
		let mode = ParsedPointerOptions::parse(options)?.mode;
		self
			.unit(move |reply| Request::Scroll { target, x, y, dx, dy, mode, reply })
			.await
	}

	/// Type text into the target.
	pub async fn type_text(
		&self,
		target: Target,
		text: String,
		options: Option<PointerOptions>,
	) -> CoreResult<()> {
		let mode = ParsedPointerOptions::parse(options)?.mode;
		self
			.unit(move |reply| Request::TypeText { target, text, mode, reply })
			.await
	}

	/// Press a parsed key chord against the target.
	pub async fn key_chord(
		&self,
		target: Target,
		keys: &[String],
		options: Option<PointerOptions>,
	) -> CoreResult<()> {
		let keys = parse_keys(keys)?;
		let mode = ParsedPointerOptions::parse(options)?.mode;
		self
			.unit(move |reply| Request::KeyChord { target, keys, mode, reply })
			.await
	}

	/// Raise a window by its opaque backend id.
	pub async fn raise_window(&self, id: String) -> CoreResult<()> {
		self
			.unit(move |reply| Request::RaiseWindow { id, reply })
			.await
	}

	/// Capture a bounded accessibility snapshot.
	pub async fn ax_snapshot(
		&self,
		target: Target,
		options: AxSnapshotOptions,
	) -> CoreResult<AxSnapshot> {
		self
			.operation(
				move |reply| Request::AxSnapshot { target, options, reply },
				|response| match response {
					Response::Snapshot(value) => Ok(value),
					_ => Err(DesktopError::internal("unexpected desktop worker response")),
				},
			)
			.await
	}

	/// Query accessibility nodes under a target.
	pub async fn ax_query(&self, target: Target, query: AxQuery) -> CoreResult<Vec<AxNode>> {
		self
			.nodes(move |reply| Request::AxQuery { target, query, reply })
			.await
	}

	/// Hit-test an accessibility node in global logical coordinates.
	pub async fn ax_element_at(&self, target: Target, x: f64, y: f64) -> CoreResult<Option<AxNode>> {
		self
			.node(move |reply| Request::AxElementAt { target, x, y, reply })
			.await
	}

	/// Return the globally focused accessibility node.
	pub async fn ax_focused(&self) -> CoreResult<Option<AxNode>> {
		self.node(|reply| Request::AxFocused { reply }).await
	}

	/// Resolve a previously returned accessibility reference.
	pub async fn ax_node(&self, reference: String) -> CoreResult<AxNode> {
		self
			.operation(
				move |reply| Request::AxNode { reference, reply },
				|response| match response {
					Response::Node(Some(value)) => Ok(value),
					_ => Err(DesktopError::stale_ref("accessibility reference was not found")),
				},
			)
			.await
	}

	/// Read native attributes from an accessibility reference.
	pub async fn ax_attributes(&self, reference: String) -> CoreResult<Vec<(String, String)>> {
		self
			.operation(
				move |reply| Request::AxAttributes { reference, reply },
				|response| match response {
					Response::Attributes(value) => Ok(value),
					_ => Err(DesktopError::internal("unexpected desktop worker response")),
				},
			)
			.await
	}

	/// Return direct children of an accessibility reference.
	pub async fn ax_children(&self, reference: String) -> CoreResult<Vec<AxNode>> {
		self
			.nodes(move |reply| Request::AxChildren { reference, reply })
			.await
	}

	/// Return the parent of an accessibility reference.
	pub async fn ax_parent(&self, reference: String) -> CoreResult<Option<AxNode>> {
		self
			.node(move |reply| Request::AxParent { reference, reply })
			.await
	}

	/// Perform a native accessibility action.
	pub async fn ax_perform(&self, reference: String, action: String) -> CoreResult<()> {
		self
			.unit(move |reply| Request::AxPerform { reference, action, reply })
			.await
	}

	/// Set the value of an accessibility node.
	pub async fn ax_set_value(&self, reference: String, value: String) -> CoreResult<()> {
		self
			.unit(move |reply| Request::AxSetValue { reference, value, reply })
			.await
	}

	/// Move accessibility focus to a node.
	pub async fn ax_focus(&self, reference: String) -> CoreResult<()> {
		self
			.unit(move |reply| Request::AxFocus { reference, reply })
			.await
	}

	/// Click the center of an accessibility node.
	pub async fn ax_click(
		&self,
		reference: String,
		options: Option<PointerOptions>,
	) -> CoreResult<()> {
		let options = ParsedPointerOptions::parse(options)?;
		self
			.unit(move |reply| Request::AxClick { reference, options, reply })
			.await
	}

	/// Close the actor and wait for its platform resources to exit.
	pub async fn close(&self) -> CoreResult<()> {
		let core = Arc::clone(&self.core);
		task::spawn_blocking(move || core.close())
			.await
			.map_err(|error| DesktopError::internal(format!("desktop close task failed: {error}")))?
	}

	async fn operation<T, M, D>(&self, make: M, decode: D) -> CoreResult<T>
	where
		T: Send + 'static,
		M: FnOnce(Reply) -> Request + Send + 'static,
		D: FnOnce(Response) -> CoreResult<T> + Send + 'static,
	{
		let core = Arc::clone(&self.core);
		let state = Arc::new(OperationState {
			cancelled: AtomicBool::new(false),
			deadline:  Instant::now() + OPERATION_TIMEOUT,
		});
		let cancel = CancelOnDrop(Arc::clone(&state));
		let result = task::spawn_blocking(move || decode(core.call(make, state)?))
			.await
			.map_err(|error| {
				DesktopError::internal(format!("desktop operation task failed: {error}"))
			})?;
		drop(cancel);
		result
	}

	async fn unit<M>(&self, make: M) -> CoreResult<()>
	where
		M: FnOnce(Reply) -> Request + Send + 'static,
	{
		self.operation(make, response_unit).await
	}

	async fn nodes<M>(&self, make: M) -> CoreResult<Vec<AxNode>>
	where
		M: FnOnce(Reply) -> Request + Send + 'static,
	{
		self
			.operation(make, |response| match response {
				Response::Nodes(value) => Ok(value),
				_ => Err(DesktopError::internal("unexpected desktop worker response")),
			})
			.await
	}

	async fn node<M>(&self, make: M) -> CoreResult<Option<AxNode>>
	where
		M: FnOnce(Reply) -> Request + Send + 'static,
	{
		self
			.operation(make, |response| match response {
				Response::Node(value) => Ok(value),
				_ => Err(DesktopError::internal("unexpected desktop worker response")),
			})
			.await
	}
}

#[cfg(test)]
mod capture_tests {
	use image::RgbaImage;

	use super::*;
	use crate::{
		backend::{AxBackend, Backend},
		error::ErrorCode,
		keys::KeyName,
	};

	const WAYLAND_ID: &str = "atspi::1.31:/org/a11y/atspi/accessible/1";

	/// Backend that mints a composite AT-SPI window id, mirroring the Wayland
	/// `AtSpiAx` path. Exists to exercise `Worker::process` without a display.
	struct FakeWaylandBackend {
		window: DesktopWindow,
	}

	impl FakeWaylandBackend {
		fn new() -> Self {
			Self {
				window: DesktopWindow {
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
			}
		}
	}

	impl Backend for FakeWaylandBackend {
		fn capabilities(&mut self) -> DesktopCapabilities {
			DesktopCapabilities {
				backend: "wayland".to_string(),
				display_server: Some("wayland".to_string()),
				capture: true,
				..DesktopCapabilities::unavailable()
			}
		}

		fn displays(&mut self) -> CoreResult<Vec<DesktopDisplay>> {
			Ok(Vec::new())
		}

		fn windows(&mut self) -> CoreResult<Vec<DesktopWindow>> {
			Ok(vec![self.window.clone()])
		}

		fn capture(
			&mut self,
			target: &Target,
			_caps: &CaptureCaps,
		) -> CoreResult<(RgbaImage, FrameGeometry)> {
			match target {
				Target::Window(id) if id == &self.window.id => {
					let image = RgbaImage::new(self.window.width, self.window.height);
					let geometry =
						FrameGeometry::for_window(&self.window, image.width(), image.height());
					Ok((image, geometry))
				},
				Target::Window(id) => {
					Err(DesktopError::window_not_found(format!("Wayland window {id} not found")))
				},
				Target::Desktop => Err(DesktopError::capture_failed("desktop capture not exercised")),
			}
		}

		fn pointer(
			&mut self,
			_: &Target,
			_: PointerEvent,
			_: &FrameGeometry,
			_: DeliveryMode,
		) -> CoreResult<()> {
			unreachable!("pointer not exercised")
		}

		fn type_text(&mut self, _: &Target, _: &str, _: DeliveryMode) -> CoreResult<()> {
			unreachable!("type_text not exercised")
		}

		fn key_chord(&mut self, _: &Target, _: &[KeyName], _: DeliveryMode) -> CoreResult<()> {
			unreachable!("key_chord not exercised")
		}

		fn raise_window(&mut self, _: &str) -> CoreResult<()> {
			unreachable!("raise_window not exercised")
		}

		fn ax(&mut self) -> Option<&mut dyn AxBackend> {
			None
		}
	}

	fn worker_with(backend: impl Backend + 'static) -> Worker {
		Worker {
			backend:      Ok(Box::new(backend)),
			registry:     AxRegistry::default(),
			frames:       HashMap::new(),
			capabilities: Arc::new(Mutex::new(DesktopCapabilities::unavailable())),
		}
	}

	fn capture_request(target: Target) -> Request {
		let (reply, _rx) = flume::bounded(1);
		Request::Capture { target, caps: CaptureCaps::default(), reply }
	}
	fn live_operation() -> OperationState {
		OperationState {
			cancelled: AtomicBool::new(false),
			deadline:  Instant::now() + Duration::from_secs(1),
		}
	}

	/// Regression for #7701: a composite AT-SPI window id minted by the Wayland
	/// backend's own `windows()` must reach the backend, not be rejected by a
	/// `u64` pre-parse in the shared request path.
	#[test]
	fn capture_accepts_non_numeric_wayland_window_id() {
		let mut worker = worker_with(FakeWaylandBackend::new());
		let response = worker
			.process(&capture_request(Target::Window(WAYLAND_ID.to_string())), &live_operation())
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
			&live_operation(),
		) else {
			panic!("unknown window id should fail");
		};
		assert_eq!(err.code, ErrorCode::WindowNotFound);
	}
	#[test]
	fn expired_work_is_rejected_before_backend_access() {
		let mut worker = worker_with(FakeWaylandBackend::new());
		let expired = OperationState { cancelled: AtomicBool::new(false), deadline: Instant::now() };
		let error = worker
			.process(&capture_request(Target::Window(WAYLAND_ID.to_string())), &expired)
			.err()
			.expect("expired operation must not reach capture backend");
		assert_eq!(error.code, ErrorCode::Timeout);
	}
}
