//! Admission-routed native desktop session host.

use std::{
	sync::{
		Arc,
		atomic::{AtomicBool, Ordering},
	},
	time::Duration,
};

use async_trait::async_trait;
use omp_con::Ctx;
use omp_core::{ArtifactUrl, Str, sf};
use omp_desktop::{
	AxNode, AxQuery, AxSnapshotOptions, CaptureCaps, DesktopPoint, DesktopSession,
	DesktopSessionOptions, ErrorCode, PointerOptions, Target,
};
use omp_tools::computer::{
	Action, Artifact, Capabilities, ComputerHost, Fault, FaultCode, NativeParams, Operation, Params,
	Payload, Update,
};
use parking_lot::Mutex;
use serde_json::{Map, Value, json};
use tokio_util::sync::CancellationToken;

use super::blobs::BlobHost;

omp_con::var! {
	/// Composite all displays or select a native display id.
	pub static SV_COMPUTER_DISPLAY = sv_computer_display: Str {
		default: Str::new_static("all"),
		flags: archive,
		meta: {
			"ui.tab": "tools",
			"ui.group": "Computer",
			"ui.label": "Computer Display",
			"legacy.path": "computer.display",
		},
	};
	/// Maximum composite screenshot width in pixels.
	pub static SV_COMPUTER_MAX_WIDTH = sv_computer_max_width: u32 {
		default: 3840,
		min: 1,
		flags: archive,
		meta: {
			"ui.tab": "tools",
			"ui.group": "Computer",
			"ui.label": "Computer Screenshot Width",
			"legacy.path": "computer.maxWidth",
		},
	};
	/// Maximum composite screenshot height in pixels.
	pub static SV_COMPUTER_MAX_HEIGHT = sv_computer_max_height: u32 {
		default: 2400,
		min: 1,
		flags: archive,
		meta: {
			"ui.tab": "tools",
			"ui.group": "Computer",
			"ui.label": "Computer Screenshot Height",
			"legacy.path": "computer.maxHeight",
		},
	};
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ComputerSettings {
	display:    Str,
	max_width:  u32,
	max_height: u32,
}

impl ComputerSettings {
	fn from_con(con: &Ctx) -> Self {
		Self {
			display:    SV_COMPUTER_DISPLAY.get(con),
			max_width:  SV_COMPUTER_MAX_WIDTH.get(con),
			max_height: SV_COMPUTER_MAX_HEIGHT.get(con),
		}
	}
}

/// Persistent native desktop owner shared by every `computer` invocation in a
/// session-scoped Environment registry.
pub(crate) struct ComputerSessionHost {
	session:      DesktopSession,
	capture_caps: CaptureCaps,
	blobs:        BlobHost,
	state:        Mutex<Map<String, Value>>,
	active:       Mutex<Option<CancellationToken>>,
	run_lock:     tokio::sync::Mutex<()>,
	closed:       AtomicBool,
}

impl ComputerSessionHost {
	pub(crate) fn new(blobs: BlobHost, con: &Ctx) -> Arc<Self> {
		let settings = ComputerSettings::from_con(con);
		Arc::new(Self {
			session: DesktopSession::new(Some(DesktopSessionOptions {
				display: Some(settings.display.to_string()),
			})),
			capture_caps: CaptureCaps {
				max_width:  Some(settings.max_width),
				max_height: Some(settings.max_height),
			},
			blobs,
			state: Mutex::new(Map::new()),
			active: Mutex::new(None),
			run_lock: tokio::sync::Mutex::new(()),
			closed: AtomicBool::new(false),
		})
	}
}

#[async_trait]
impl ComputerHost for ComputerSessionHost {
	async fn execute(
		&self,
		params: Params,
		cancellation: CancellationToken,
		updates: flume::Sender<Update>,
	) -> Result<Payload, Fault> {
		let _ = updates.send(Update::Started { action: params.action });
		match params.action {
			Action::Capabilities => {
				validate_non_run(&params)?;
				if self.closed.load(Ordering::Acquire) {
					return Err(fault(FaultCode::Closed, "computer session is closed", None));
				}
				let capabilities = self
					.session
					.capabilities()
					.await
					.map(capabilities)
					.map_err(|error| native_fault(Operation::Capabilities, error))?;
				Ok(Payload {
					action:       Action::Capabilities,
					code:         None,
					results:      Vec::new(),
					artifacts:    Vec::new(),
					capabilities: Some(capabilities),
				})
			},
			Action::Close => {
				validate_non_run(&params)?;
				let should_close = !self.closed.swap(true, Ordering::AcqRel);
				if let Some(active) = self.active.lock().take() {
					active.cancel();
				}
				let _run = self.run_lock.lock().await;
				if should_close {
					self
						.session
						.close()
						.await
						.map_err(|error| native_fault(Operation::Close, error))?;
					self.state.lock().clear();
				}
				Ok(Payload {
					action:       Action::Close,
					code:         None,
					results:      Vec::new(),
					artifacts:    Vec::new(),
					capabilities: None,
				})
			},
			Action::Run => {
				if self.closed.load(Ordering::Acquire) {
					return Err(fault(FaultCode::Closed, "computer session is closed", None));
				}
				let Some(code) = params.code.clone() else {
					return Err(invalid("run requires `code`"));
				};
				let Ok(_run) = self.run_lock.try_lock() else {
					return Err(fault(FaultCode::Busy, "computer session is busy", None));
				};
				*self.active.lock() = Some(cancellation.clone());
				let _active = ActiveRun(&self.active);
				let requested_timeout = params.timeout.unwrap_or(20.0);
				if !requested_timeout.is_finite() || requested_timeout <= 0.0 {
					return Err(invalid("computer timeout must be a finite positive number"));
				}
				let timeout = Duration::from_secs_f64(requested_timeout.min(300.0));
				let program = parse_program(&code)?;
				let execution =
					self.execute_program(program, params.read_only, cancellation.clone(), updates);
				tokio::pin!(execution);
				let (results, artifacts) = tokio::select! {
					_ = cancellation.cancelled() => {
						return Err(fault(FaultCode::Cancelled, "computer program was cancelled", None));
					},
					result = tokio::time::timeout(timeout, &mut execution) => result
						.map_err(|_| fault(FaultCode::Timeout, "computer program exceeded its timeout", None))??,
				};
				let desktop_capabilities = self.session.cached_capabilities();
				Ok(Payload {
					action: Action::Run,
					code: Some(code),
					results,
					artifacts,
					capabilities: Some(capabilities(desktop_capabilities)),
				})
			},
		}
	}

	fn release(&self) {
		if self.closed.swap(true, Ordering::AcqRel) {
			return;
		}
		if let Some(active) = self.active.lock().take() {
			active.cancel();
		}
		self.state.lock().clear();
		if let Ok(runtime) = tokio::runtime::Handle::try_current() {
			let session = self.session.clone();
			drop(runtime.spawn(async move {
				let _ = session.close().await;
			}));
		}
	}
}

struct ActiveRun<'a>(&'a Mutex<Option<CancellationToken>>);

impl Drop for ActiveRun<'_> {
	fn drop(&mut self) {
		self.0.lock().take();
	}
}

impl ComputerSessionHost {
	async fn execute_program(
		&self,
		program: Vec<Statement>,
		read_only: bool,
		cancellation: CancellationToken,
		updates: flume::Sender<Update>,
	) -> Result<(Vec<Value>, Vec<Artifact>), Fault> {
		const MAX_OPERATIONS: usize = 256;
		const MAX_SCREENSHOTS: usize = 32;
		if program.len() > MAX_OPERATIONS {
			return Err(invalid("computer programs are limited to 256 statements"));
		}
		let mut results = Vec::new();
		let mut artifacts = Vec::new();
		for statement in program {
			if cancellation.is_cancelled() {
				return Err(fault(FaultCode::Cancelled, "computer program was cancelled", None));
			}
			match statement {
				Statement::Desktop { bind, mut params } => {
					resolve_bound_params(&mut params, &self.state.lock())?;
					if matches!(params.operation, Operation::Capture)
						&& artifacts.len() >= MAX_SCREENSHOTS
					{
						return Err(invalid("computer programs are limited to 32 screenshots"));
					}
					if read_only && params.required_effects().input {
						return Err(fault(
							FaultCode::ReadOnly,
							"read_only computer programs cannot perform input, focus, accessibility, or \
							 clipboard mutation",
							Some(params.operation),
						));
					}
					let (result, created) = self
						.execute_native(params, cancellation.clone(), &updates)
						.await?;
					if let Some(name) = bind {
						self.state.lock().insert(name.to_string(), result.clone());
					}
					results.push(result);
					artifacts.extend(created);
				},
				Statement::Wait(duration) => tokio::select! {
					_ = cancellation.cancelled() => {
						return Err(fault(FaultCode::Cancelled, "computer program was cancelled", None));
					},
					() = tokio::time::sleep(duration) => {},
				},
				Statement::WaitUntil { expression, timeout, interval } => {
					let deadline = tokio::time::Instant::now() + timeout;
					loop {
						if evaluate_assertion(&expression, &self.state.lock()) {
							results.push(Value::Bool(true));
							break;
						}
						if tokio::time::Instant::now() >= deadline {
							return Err(fault(
								FaultCode::Timeout,
								"computer wait predicate timed out",
								None,
							));
						}
						tokio::select! {
							_ = cancellation.cancelled() => {
								return Err(fault(FaultCode::Cancelled, "computer program was cancelled", None));
							},
							() = tokio::time::sleep(interval) => {},
						}
					}
				},
				Statement::Value { expression } => {
					let value = expression_value(&expression, &self.state.lock())
						.ok_or_else(|| invalid("computer value expression could not be resolved"))?;
					results.push(value);
				},
				Statement::Assert { expression, message } => {
					if !evaluate_assertion(&expression, &self.state.lock()) {
						return Err(fault(
							FaultCode::InvalidRequest,
							message.as_deref().unwrap_or("computer assertion failed"),
							None,
						));
					}
					results.push(Value::Bool(true));
				},
			}
		}
		Ok((results, artifacts))
	}

	async fn execute_native(
		&self,
		params: NativeParams,
		cancellation: CancellationToken,
		updates: &flume::Sender<Update>,
	) -> Result<(Value, Vec<Artifact>), Fault> {
		let operation = params.operation;
		if cancellation.is_cancelled() {
			return Err(fault(
				FaultCode::Cancelled,
				"computer program was cancelled",
				Some(operation),
			));
		}
		let _ = updates.send(Update::Operation { operation });
		let mut artifacts = Vec::new();
		let result = match operation {
			Operation::Close => {
				self
					.session
					.close()
					.await
					.map_err(|error| native_fault(operation, error))?;
				Value::Bool(true)
			},
			Operation::Capabilities => serde_json::to_value(capabilities(
				self
					.session
					.capabilities()
					.await
					.map_err(|error| native_fault(operation, error))?,
			))
			.expect("computer capabilities serialize"),
			Operation::ListDisplays => Value::Array(
				self
					.session
					.list_displays()
					.await
					.map_err(|error| native_fault(operation, error))?
					.into_iter()
					.map(|display| {
						json!({
							"id": display.id,
							"name": display.name,
							"x": display.x,
							"y": display.y,
							"width": display.width,
							"height": display.height,
							"scale": display.scale,
							"pixel_x": display.pixel_x,
							"pixel_y": display.pixel_y,
							"pixel_width": display.pixel_width,
							"pixel_height": display.pixel_height,
							"primary": display.is_primary,
						})
					})
					.collect(),
			),
			Operation::ListWindows | Operation::ResolveWindow | Operation::FocusedWindow => {
				let windows = self
					.session
					.list_windows()
					.await
					.map_err(|error| native_fault(operation, error))?;
				let mut matches =
					windows
						.into_iter()
						.filter(|window| {
							params.window.as_deref().is_none_or(|id| window.id == id)
								&& params.app.as_deref().is_none_or(|app| {
									window.app.to_lowercase().contains(&app.to_lowercase())
								}) && params.title.as_deref().is_none_or(|title| {
								window.title.to_lowercase().contains(&title.to_lowercase())
							}) && (!matches!(operation, Operation::FocusedWindow) || window.focused)
						})
						.map(window)
						.collect::<Vec<_>>();
				match operation {
					Operation::ListWindows => Value::Array(matches),
					Operation::FocusedWindow => matches.pop().unwrap_or(Value::Null),
					Operation::ResolveWindow if matches.is_empty() => {
						return Err(fault(
							FaultCode::WindowNotFound,
							"no window matches the requested selector",
							Some(operation),
						));
					},
					Operation::ResolveWindow if matches.len() > 1 => {
						return Err(fault(
							FaultCode::InvalidRequest,
							"multiple windows match the requested selector",
							Some(operation),
						));
					},
					Operation::ResolveWindow => matches.pop().expect("one resolved window"),
					_ => unreachable!("covered window operation"),
				}
			},
			Operation::Capture => {
				let capture = self
					.session
					.capture(target(&params), CaptureCaps {
						max_width:  bounded_cap(params.max_width, self.capture_caps.max_width),
						max_height: bounded_cap(params.max_height, self.capture_caps.max_height),
					})
					.await
					.map_err(|error| native_fault(operation, error))?;
				let id = self.blobs.put(&capture.data).map_err(|_| {
					fault(
						FaultCode::ArtifactFailed,
						"computer screenshot could not be retained",
						Some(operation),
					)
				})?;
				let uri = Str::new(ArtifactUrl::from_digest(id.hash).as_str());
				let artifact = Artifact {
					uri:           uri.clone(),
					mime:          sf!("image/png"),
					visible:       !params.silent,
					byte_len:      id.size,
					width:         capture.width,
					height:        capture.height,
					source_width:  capture.source_width,
					source_height: capture.source_height,
					target:        Str::new(&capture.target),
				};
				let _ =
					updates.send(Update::Artifact { uri: uri.clone(), visible: artifact.visible });
				artifacts.push(artifact);
				json!({
					"artifact": uri,
					"bytes": id.size,
					"width": capture.width,
					"height": capture.height,
					"source_width": capture.source_width,
					"source_height": capture.source_height,
					"target": capture.target,
					"backend": capture.backend,
					"display_server": capture.display_server,
					"coordinate_space": "capture_pixels",
				})
			},
			Operation::Click => {
				self
					.session
					.click(
						target(&params),
						number(params.x, "x")?,
						number(params.y, "y")?,
						pointer_options(&params),
					)
					.await
					.map_err(|error| native_fault(operation, error))?;
				Value::Bool(true)
			},
			Operation::MoveMouse => {
				self
					.session
					.move_mouse(
						target(&params),
						number(params.x, "x")?,
						number(params.y, "y")?,
						pointer_options(&params),
					)
					.await
					.map_err(|error| native_fault(operation, error))?;
				Value::Bool(true)
			},
			Operation::Drag => {
				let points = params
					.points
					.as_ref()
					.ok_or_else(|| invalid("drag requires `points`"))?
					.iter()
					.map(|point| DesktopPoint { x: point[0], y: point[1] })
					.collect();
				self
					.session
					.drag(target(&params), points, pointer_options(&params))
					.await
					.map_err(|error| native_fault(operation, error))?;
				Value::Bool(true)
			},
			Operation::Scroll => {
				self
					.session
					.scroll(
						target(&params),
						number(params.x, "x")?,
						number(params.y, "y")?,
						params.dx.unwrap_or(0.0),
						params.dy.unwrap_or(0.0),
						pointer_options(&params),
					)
					.await
					.map_err(|error| native_fault(operation, error))?;
				Value::Bool(true)
			},
			Operation::TypeText => {
				self
					.session
					.type_text(target(&params), text(&params)?.to_owned(), pointer_options(&params))
					.await
					.map_err(|error| native_fault(operation, error))?;
				Value::Bool(true)
			},
			Operation::KeyChord => {
				let keys = text(&params)?
					.split('+')
					.map(str::trim)
					.filter(|key| !key.is_empty())
					.map(str::to_owned)
					.collect::<Vec<_>>();
				self
					.session
					.key_chord(target(&params), &keys, pointer_options(&params))
					.await
					.map_err(|error| native_fault(operation, error))?;
				Value::Bool(true)
			},
			Operation::RaiseWindow => {
				self
					.session
					.raise_window(
						required(
							params.reference.as_deref().or(params.window.as_deref()),
							"raise requires a window reference",
						)?
						.to_owned(),
					)
					.await
					.map_err(|error| native_fault(operation, error))?;
				Value::Bool(true)
			},
			Operation::AxSnapshot => {
				let snapshot = self
					.session
					.ax_snapshot(target(&params), AxSnapshotOptions {
						max_depth: params.max_depth,
						max_nodes: params.limit,
						all:       params.all,
					})
					.await
					.map_err(|error| native_fault(operation, error))?;
				json!({
					"text": snapshot.text,
					"node_count": snapshot.node_count,
					"truncated": snapshot.truncated,
					"coordinate_space": "global_logical",
				})
			},
			Operation::AxQuery => Value::Array(
				self
					.session
					.ax_query(target(&params), AxQuery {
						role:  params.value.as_ref().map(ToString::to_string),
						title: params.title.as_ref().map(ToString::to_string),
						value: params.query_value.as_ref().map(ToString::to_string),
						limit: params.limit,
					})
					.await
					.map_err(|error| native_fault(operation, error))?
					.into_iter()
					.map(node)
					.collect(),
			),
			Operation::AxElementAt => self
				.session
				.ax_element_at(target(&params), number(params.x, "x")?, number(params.y, "y")?)
				.await
				.map_err(|error| native_fault(operation, error))?
				.map(node)
				.unwrap_or(Value::Null),
			Operation::AxFocused => self
				.session
				.ax_focused()
				.await
				.map_err(|error| native_fault(operation, error))?
				.map(node)
				.unwrap_or(Value::Null),
			Operation::AxNode => node(
				self
					.session
					.ax_node(reference(&params)?.to_owned())
					.await
					.map_err(|error| native_fault(operation, error))?,
			),
			Operation::AxValue => self
				.session
				.ax_node(reference(&params)?.to_owned())
				.await
				.map_err(|error| native_fault(operation, error))?
				.value
				.map_or(Value::Null, Value::String),
			Operation::AxBounds => {
				let node = self
					.session
					.ax_node(reference(&params)?.to_owned())
					.await
					.map_err(|error| native_fault(operation, error))?;
				match (node.x, node.y, node.width, node.height) {
					(Some(x), Some(y), Some(width), Some(height)) => json!({
						"x": x,
						"y": y,
						"width": width,
						"height": height,
						"coordinate_space": "global_logical",
					}),
					_ => Value::Null,
				}
			},
			Operation::AxActions => Value::Array(
				self
					.session
					.ax_node(reference(&params)?.to_owned())
					.await
					.map_err(|error| native_fault(operation, error))?
					.actions
					.unwrap_or_default()
					.into_iter()
					.map(Value::String)
					.collect(),
			),
			Operation::AxAttributes => Value::Object(
				self
					.session
					.ax_attributes(reference(&params)?.to_owned())
					.await
					.map_err(|error| native_fault(operation, error))?
					.into_iter()
					.map(|(name, value)| (name, Value::String(value)))
					.collect(),
			),
			Operation::AxChildren => Value::Array(
				self
					.session
					.ax_children(reference(&params)?.to_owned())
					.await
					.map_err(|error| native_fault(operation, error))?
					.into_iter()
					.map(node)
					.collect(),
			),
			Operation::AxParent => self
				.session
				.ax_parent(reference(&params)?.to_owned())
				.await
				.map_err(|error| native_fault(operation, error))?
				.map(node)
				.unwrap_or(Value::Null),
			Operation::AxPerform => {
				self
					.session
					.ax_perform(reference(&params)?.to_owned(), text(&params)?.to_owned())
					.await
					.map_err(|error| native_fault(operation, error))?;
				Value::Bool(true)
			},
			Operation::AxSetValue => {
				self
					.session
					.ax_set_value(reference(&params)?.to_owned(), text(&params)?.to_owned())
					.await
					.map_err(|error| native_fault(operation, error))?;
				Value::Bool(true)
			},
			Operation::AxFocus => {
				self
					.session
					.ax_focus(reference(&params)?.to_owned())
					.await
					.map_err(|error| native_fault(operation, error))?;
				Value::Bool(true)
			},
			Operation::AxClick => {
				self
					.session
					.ax_click(reference(&params)?.to_owned(), pointer_options(&params))
					.await
					.map_err(|error| native_fault(operation, error))?;
				Value::Bool(true)
			},
			Operation::ClipboardRead => {
				let value = tokio::task::spawn_blocking(|| {
					let mut clipboard = arboard::Clipboard::new().map_err(|_| ())?;
					clipboard.get_text().map_err(|_| ())
				})
				.await
				.map_err(|_| {
					fault(FaultCode::ClipboardFailed, "clipboard worker failed", Some(operation))
				})?
				.map_err(|()| {
					fault(FaultCode::ClipboardFailed, "clipboard text is unavailable", Some(operation))
				})?;
				Value::String(value)
			},
			Operation::ClipboardWrite => {
				let value = text(&params)?.to_owned();
				tokio::task::spawn_blocking(move || {
					let mut clipboard = arboard::Clipboard::new().map_err(|_| ())?;
					clipboard.set_text(value).map_err(|_| ())
				})
				.await
				.map_err(|_| {
					fault(FaultCode::ClipboardFailed, "clipboard worker failed", Some(operation))
				})?
				.map_err(|()| {
					fault(
						FaultCode::ClipboardFailed,
						"clipboard text could not be written",
						Some(operation),
					)
				})?;
				Value::Bool(true)
			},
		};
		Ok((result, artifacts))
	}
}

enum Statement {
	Desktop { bind: Option<Str>, params: NativeParams },
	Wait(Duration),
	WaitUntil { expression: Str, timeout: Duration, interval: Duration },
	Value { expression: Str },
	Assert { expression: Str, message: Option<Str> },
}

fn parse_program(code: &str) -> Result<Vec<Statement>, Fault> {
	let mut program = Vec::new();
	for raw_statement in split_statements(code)? {
		let mut statement = raw_statement.trim();
		let returns = statement.starts_with("return ");
		if returns {
			statement = statement
				.strip_prefix("return ")
				.expect("return prefix checked")
				.trim();
			if !statement.contains('(') {
				program.push(Statement::Value { expression: Str::new(statement) });
				continue;
			}
		}
		let (bind, assigned) = parse_assignment(statement)?;
		statement = assigned.strip_prefix("await ").unwrap_or(assigned).trim();
		if statement.is_empty() {
			continue;
		}
		let (callee, raw_arguments) = parse_call(statement)?;
		if callee == "assert" {
			let (expression, message) = parse_assertion(raw_arguments)?;
			program.push(Statement::Assert { expression, message });
			continue;
		}
		if callee == "wait" {
			program.push(parse_wait(raw_arguments)?);
			continue;
		}
		if matches!(callee, "display" | "print" | "console.log") {
			let arguments = split_arguments(raw_arguments)?;
			if arguments.is_empty() {
				return Err(invalid("display and print require at least one value"));
			}
			program.extend(
				arguments
					.into_iter()
					.map(|expression| Statement::Value { expression }),
			);
			continue;
		}
		let arguments = parse_arguments(raw_arguments)?;
		let params = if let Some(method) = callee.strip_prefix("desktop.") {
			parse_desktop_call(method, &arguments)?
		} else if let Some((receiver, method)) = callee.rsplit_once('.') {
			let mut params = parse_desktop_call(method, &arguments)?;
			if matches!(
				params.operation,
				Operation::AxValue
					| Operation::AxBounds
					| Operation::AxActions
					| Operation::AxAttributes
					| Operation::AxChildren
					| Operation::AxParent
					| Operation::AxPerform
					| Operation::AxSetValue
					| Operation::AxFocus
					| Operation::AxClick
			) || matches!(params.operation, Operation::AxNode) && method != "ref"
			{
				params.reference = Some(sf!("${receiver}"));
			} else if matches!(params.operation, Operation::AxNode) {
				// `win.ref(\"e5\")` resolves the explicit generation-fenced AX
				// reference; the window receiver adds no second authority.
			} else {
				params.window = Some(sf!("${receiver}"));
			}
			params
		} else {
			return Err(invalid(
				"computer code may call only `desktop`, retained window/element handles, `wait`, \
				 `assert`, `display`, and `print`",
			));
		};
		if returns {
			let return_name = sf!("__return_{}", program.len());
			let result_name = bind.or(Some(return_name.clone()));
			program.push(Statement::Desktop { bind: result_name, params });
			program.push(Statement::Value { expression: return_name });
		} else {
			program.push(Statement::Desktop { bind, params });
		}
	}
	if program.is_empty() {
		return Err(invalid("computer code must contain at least one call"));
	}
	Ok(program)
}

fn parse_wait(arguments: &str) -> Result<Statement, Fault> {
	let arguments = split_arguments(arguments)?;
	let Some(first) = arguments.first() else {
		return Err(invalid("wait requires a duration or predicate"));
	};
	if let Ok(millis) = first.parse::<f64>() {
		if arguments.len() != 1 || !millis.is_finite() || millis < 0.0 {
			return Err(invalid("wait duration must be one finite non-negative millisecond number"));
		}
		return Ok(Statement::Wait(Duration::from_secs_f64(millis / 1_000.0)));
	}
	let expression = first
		.strip_prefix("() =>")
		.or_else(|| first.strip_prefix("async () =>"))
		.map(|value| value.trim())
		.ok_or_else(|| invalid("wait predicate must be an arrow function"))?;
	let options = arguments
		.get(1)
		.map(|raw| serde_json::from_str::<Value>(raw))
		.transpose()
		.map_err(|_| invalid("wait predicate options must be a JSON object"))?;
	if arguments.len() > 2 {
		return Err(invalid("wait predicate accepts at most one options object"));
	}
	let timeout = options
		.as_ref()
		.and_then(|value| value.get("timeout"))
		.and_then(Value::as_f64)
		.unwrap_or(5_000.0);
	let interval = options
		.as_ref()
		.and_then(|value| value.get("interval"))
		.and_then(Value::as_f64)
		.unwrap_or(50.0);
	if !timeout.is_finite() || timeout < 0.0 || !interval.is_finite() || interval <= 0.0 {
		return Err(invalid(
			"wait predicate timeout and interval must be finite positive milliseconds",
		));
	}
	Ok(Statement::WaitUntil {
		expression: Str::new(expression),
		timeout:    Duration::from_secs_f64(timeout / 1_000.0),
		interval:   Duration::from_secs_f64(interval / 1_000.0),
	})
}

fn parse_assignment(statement: &str) -> Result<(Option<Str>, &str), Fault> {
	let declaration = ["const ", "let ", "var "]
		.into_iter()
		.find_map(|prefix| statement.strip_prefix(prefix));
	let Some(declaration) = declaration else {
		return Ok((None, statement));
	};
	let (name, expression) = declaration
		.split_once('=')
		.ok_or_else(|| invalid("computer variable declarations require `=`"))?;
	let name = name.trim();
	if name.is_empty()
		|| !name.bytes().enumerate().all(|(index, byte)| {
			byte == b'_' || byte.is_ascii_alphanumeric() && (index != 0 || !byte.is_ascii_digit())
		}) {
		return Err(invalid("computer variable name is invalid"));
	}
	Ok((Some(Str::new(name)), expression.trim()))
}

fn parse_assertion(arguments: &str) -> Result<(Str, Option<Str>), Fault> {
	let mut depth = 0_u32;
	let mut quote = None;
	let mut escaped = false;
	let mut separator = None;
	for (offset, character) in arguments.char_indices() {
		if let Some(active_quote) = quote {
			if escaped {
				escaped = false;
			} else if character == '\\' {
				escaped = true;
			} else if character == active_quote {
				quote = None;
			}
			continue;
		}
		match character {
			'"' | '\'' => quote = Some(character),
			'(' | '[' | '{' => depth = depth.saturating_add(1),
			')' | ']' | '}' => {
				depth = depth
					.checked_sub(1)
					.ok_or_else(|| invalid("assert has an unmatched delimiter"))?;
			},
			',' if depth == 0 => {
				separator = Some(offset);
				break;
			},
			_ => {},
		}
	}
	let (expression, message) = separator.map_or((arguments, None), |offset| {
		(&arguments[..offset], Some(arguments[offset + 1..].trim()))
	});
	let expression = expression.trim();
	if expression.is_empty() {
		return Err(invalid("assert requires a condition"));
	}
	let message = message
		.map(|message| serde_json::from_str::<Str>(message))
		.transpose()
		.map_err(|_| invalid("assert message must be a JSON string"))?;
	Ok((Str::new(expression), message))
}

fn evaluate_assertion(expression: &str, state: &Map<String, Value>) -> bool {
	for operator in [">=", "<=", "===", "!==", "==", "!=", ">", "<"] {
		if let Some((left, right)) = expression.split_once(operator) {
			let Some(left) = expression_value(left.trim(), state) else {
				return false;
			};
			let Some(right) = expression_value(right.trim(), state) else {
				return false;
			};
			return match operator {
				"==" | "===" => left == right,
				"!=" | "!==" => left != right,
				">" => compare_numbers(&left, &right, |left, right| left > right),
				"<" => compare_numbers(&left, &right, |left, right| left < right),
				">=" => compare_numbers(&left, &right, |left, right| left >= right),
				"<=" => compare_numbers(&left, &right, |left, right| left <= right),
				_ => false,
			};
		}
	}
	expression_value(expression.trim(), state).is_some_and(truthy)
}

fn expression_value(expression: &str, state: &Map<String, Value>) -> Option<Value> {
	if let Ok(literal) = serde_json::from_str(expression) {
		return Some(literal);
	}
	let mut normalized = String::with_capacity(expression.len());
	let mut chars = expression.chars().peekable();
	while let Some(character) = chars.next() {
		match character {
			'[' => {
				normalized.push('.');
				while let Some(next) = chars.next() {
					if next == ']' {
						break;
					}
					normalized.push(next);
				}
			},
			'?' if chars.peek() == Some(&'.') => {
				let _ = chars.next();
				normalized.push('.');
			},
			_ => normalized.push(character),
		}
	}
	let mut segments = normalized.split('.');
	let first = segments.next()?;
	let mut value = state.get(first)?.clone();
	for segment in segments {
		value = if segment == "length" {
			let length = match &value {
				Value::Array(values) => values.len(),
				Value::Object(values) => values.len(),
				Value::String(value) => value.chars().count(),
				_ => return None,
			};
			Value::from(u64::try_from(length).ok()?)
		} else if let Ok(index) = segment.parse::<usize>() {
			value.as_array()?.get(index)?.clone()
		} else {
			value.as_object()?.get(segment)?.clone()
		};
	}
	Some(value)
}

fn truthy(value: Value) -> bool {
	match value {
		Value::Null => false,
		Value::Bool(value) => value,
		Value::Number(value) => value.as_f64().is_some_and(|value| value != 0.0),
		Value::String(value) => !value.is_empty(),
		Value::Array(_) | Value::Object(_) => true,
	}
}

fn compare_numbers(left: &Value, right: &Value, compare: impl FnOnce(f64, f64) -> bool) -> bool {
	left
		.as_f64()
		.zip(right.as_f64())
		.is_some_and(|(left, right)| compare(left, right))
}

fn split_statements(code: &str) -> Result<Vec<&str>, Fault> {
	let mut statements = Vec::new();
	let mut start = 0;
	let mut depth = 0_u32;
	let mut quote = None;
	let mut escaped = false;
	for (offset, character) in code.char_indices() {
		if let Some(active_quote) = quote {
			if escaped {
				escaped = false;
			} else if character == '\\' {
				escaped = true;
			} else if character == active_quote {
				quote = None;
			}
			continue;
		}
		match character {
			'"' | '\'' => quote = Some(character),
			'(' | '[' | '{' => depth = depth.saturating_add(1),
			')' | ']' | '}' => {
				depth = depth
					.checked_sub(1)
					.ok_or_else(|| invalid("computer code has an unmatched closing delimiter"))?;
			},
			';' | '\n' if depth == 0 => {
				statements.push(&code[start..offset]);
				start = offset + character.len_utf8();
			},
			_ => {},
		}
	}
	if quote.is_some() || depth != 0 {
		return Err(invalid("computer code has an unterminated string or delimiter"));
	}
	statements.push(&code[start..]);
	Ok(statements)
}

fn parse_call(statement: &str) -> Result<(&str, &str), Fault> {
	let open = statement
		.find('(')
		.ok_or_else(|| invalid("computer statements must be function calls"))?;
	if !statement.ends_with(')') {
		return Err(invalid("computer statements must end after the function call"));
	}
	Ok((statement[..open].trim(), &statement[open + 1..statement.len() - 1]))
}

fn split_arguments(arguments: &str) -> Result<Vec<Str>, Fault> {
	if arguments.trim().is_empty() {
		return Ok(Vec::new());
	}
	let mut values = Vec::new();
	let mut start = 0;
	let mut depth = 0_u32;
	let mut quote = None;
	let mut escaped = false;
	for (offset, character) in arguments.char_indices() {
		if let Some(active_quote) = quote {
			if escaped {
				escaped = false;
			} else if character == '\\' {
				escaped = true;
			} else if character == active_quote {
				quote = None;
			}
			continue;
		}
		match character {
			'\"' | '\'' => quote = Some(character),
			'(' | '[' | '{' => depth = depth.saturating_add(1),
			')' | ']' | '}' => {
				depth = depth
					.checked_sub(1)
					.ok_or_else(|| invalid("computer call has an unmatched delimiter"))?;
			},
			',' if depth == 0 => {
				values.push(Str::new(arguments[start..offset].trim()));
				start = offset + 1;
			},
			_ => {},
		}
	}
	if quote.is_some() || depth != 0 {
		return Err(invalid("computer call has an unterminated string or delimiter"));
	}
	values.push(Str::new(arguments[start..].trim()));
	Ok(values)
}

fn parse_arguments(arguments: &str) -> Result<Vec<Value>, Fault> {
	split_arguments(arguments)?
		.into_iter()
		.map(|argument| match serde_json::from_str(argument.as_str()) {
			Ok(value) => Ok(value),
			Err(_)
				if argument.bytes().all(|byte| {
					byte == b'_'
						|| byte == b'.'
						|| byte == b'?'
						|| byte == b'['
						|| byte == b']'
						|| byte.is_ascii_alphanumeric()
				}) =>
			{
				Ok(json!({ "$expr": argument }))
			},
			Err(_) => {
				Err(invalid("computer call arguments must be JSON values or retained-value paths"))
			},
		})
		.collect()
}

fn expression_argument(value: &Value) -> Option<Str> {
	value
		.get("$expr")
		.and_then(Value::as_str)
		.map(|expression| sf!("${expression}"))
}

fn parse_desktop_call(method: &str, arguments: &[Value]) -> Result<NativeParams, Fault> {
	if method == "execute" {
		let operation = arguments
			.first()
			.cloned()
			.ok_or_else(|| invalid("desktop.execute requires an operation object"))?;
		let params: NativeParams = serde_json::from_value(operation)
			.map_err(|_| invalid("desktop.execute received an invalid operation object"))?;
		if matches!(params.operation, Operation::Close) {
			return Err(invalid("desktop session close is available only as action=close"));
		}
		return Ok(params);
	}
	let operation = match method {
		"capabilities" => Operation::Capabilities,
		"displays" => Operation::ListDisplays,
		"windows" => Operation::ListWindows,
		"window" => Operation::ResolveWindow,
		"focusedWindow" => Operation::FocusedWindow,
		"screenshot" => Operation::Capture,
		"click" if arguments.len() < 2 => Operation::AxClick,
		"click" | "doubleClick" => Operation::Click,
		"move" => Operation::MoveMouse,
		"drag" => Operation::Drag,
		"scroll" => Operation::Scroll,
		"type" => Operation::TypeText,
		"press" if arguments.is_empty() => Operation::AxPerform,
		"press" => Operation::KeyChord,
		"raise" => Operation::RaiseWindow,
		"ax" => Operation::AxSnapshot,
		"find" => Operation::AxQuery,
		"elementAt" => Operation::AxElementAt,
		"focusedElement" => Operation::AxFocused,
		"ref" => Operation::AxNode,
		"value" => Operation::AxValue,
		"bounds" => Operation::AxBounds,
		"actions" => Operation::AxActions,
		"attributes" => Operation::AxAttributes,
		"children" => Operation::AxChildren,
		"parent" => Operation::AxParent,
		"perform" => Operation::AxPerform,
		"setValue" => Operation::AxSetValue,
		"focus" => Operation::AxFocus,
		"clipboard.read" => Operation::ClipboardRead,
		"clipboard.write" => Operation::ClipboardWrite,
		_ => return Err(invalid("unknown `desktop`, window, or accessibility method")),
	};
	let mut params = NativeParams {
		operation,
		window: None,
		reference: None,
		value: None,
		app: None,
		title: None,
		query_value: None,
		x: None,
		y: None,
		dx: None,
		dy: None,
		points: None,
		button: None,
		count: None,
		modifiers: None,
		delivery: None,
		max_width: None,
		max_height: None,
		max_depth: None,
		limit: None,
		all: None,
		silent: false,
	};
	match operation {
		Operation::Close
		| Operation::Capabilities
		| Operation::ListDisplays
		| Operation::FocusedWindow
		| Operation::AxFocused
		| Operation::ClipboardRead
		| Operation::AxChildren
		| Operation::AxParent
		| Operation::AxFocus
		| Operation::AxNode
		| Operation::AxValue
		| Operation::AxBounds
		| Operation::AxActions
		| Operation::AxAttributes => {
			if !matches!(
				operation,
				Operation::AxValue
					| Operation::AxBounds
					| Operation::AxActions
					| Operation::AxChildren
					| Operation::AxParent
					| Operation::AxFocus
					| Operation::AxNode
					| Operation::AxAttributes
			) {
				require_arity(arguments, 0)?;
			}
		},
		Operation::ListWindows
		| Operation::Capture
		| Operation::AxSnapshot
		| Operation::AxQuery
		| Operation::AxClick => {
			require_arity_at_most(arguments, 1)?;
			if let Some(options) = arguments.first() {
				apply_options(&mut params, options)?;
			}
		},
		Operation::ResolveWindow => {
			require_arity(arguments, 1)?;
			if let Some(id) = arguments[0].as_str() {
				params.window = Some(Str::new(id));
			} else if let Some(expression) = expression_argument(&arguments[0]) {
				params.window = Some(expression);
			} else {
				apply_options(&mut params, &arguments[0])?;
			}
		},
		Operation::Click | Operation::MoveMouse | Operation::AxElementAt => {
			require_arity_range(arguments, 2, 3)?;
			params.x = arguments.first().and_then(Value::as_f64);
			params.y = arguments.get(1).and_then(Value::as_f64);
			if params.x.is_none() || params.y.is_none() {
				return Err(invalid("desktop coordinates must be numbers"));
			}
			if let Some(options) = arguments.get(2) {
				apply_options(&mut params, options)?;
			}
			if method == "doubleClick" {
				params.count = Some(2);
			}
		},
		Operation::Drag => {
			require_arity_range(arguments, 1, 2)?;
			params.points = Some(
				serde_json::from_value(arguments[0].clone())
					.map_err(|_| invalid("desktop.drag requires an array of [x, y] points"))?,
			);
			if params.points.as_ref().is_none_or(Vec::is_empty) {
				return Err(invalid("desktop.drag requires at least one point"));
			}
			if let Some(options) = arguments.get(1) {
				apply_options(&mut params, options)?;
			}
		},
		Operation::Scroll => {
			require_arity_range(arguments, 2, 3)?;
			params.x = arguments.first().and_then(Value::as_f64);
			params.y = arguments.get(1).and_then(Value::as_f64);
			if params.x.is_none() || params.y.is_none() {
				return Err(invalid("desktop coordinates must be numbers"));
			}
			if let Some(options) = arguments.get(2) {
				apply_options(&mut params, options)?;
			}
		},
		Operation::TypeText | Operation::KeyChord | Operation::ClipboardWrite => {
			require_arity_range(arguments, 1, 2)?;
			params.value = arguments.first().and_then(|value| {
				value
					.as_str()
					.map(Str::new)
					.or_else(|| expression_argument(value))
					.or_else(|| {
						value.as_array().map(|keys| {
							Str::new(
								keys
									.iter()
									.filter_map(Value::as_str)
									.collect::<Vec<_>>()
									.join("+"),
							)
						})
					})
			});
			if params.value.is_none() {
				return Err(invalid("desktop text and key chords must be strings or retained values"));
			}
			if let Some(options) = arguments.get(1) {
				apply_options(&mut params, options)?;
			}
		},
		Operation::RaiseWindow => {
			require_arity_at_most(arguments, 1)?;
			params.reference = arguments.first().and_then(Value::as_str).map(Str::new);
		},
		Operation::AxPerform => {
			require_arity_at_most(arguments, 1)?;
			params.value = if method == "press" {
				Some(sf!("press"))
			} else {
				arguments.first().and_then(Value::as_str).map(Str::new)
			};
			if params.value.is_none() {
				return Err(invalid("accessibility perform requires an action name"));
			}
		},
		Operation::AxSetValue => {
			require_arity(arguments, 1)?;
			params.value = arguments.first().and_then(|value| {
				value
					.as_str()
					.map(Str::new)
					.or_else(|| expression_argument(value))
			});
			if params.value.is_none() {
				return Err(invalid("accessibility setValue requires text"));
			}
		},
	}
	if matches!(operation, Operation::AxNode) && method == "ref" {
		require_arity(arguments, 1)?;
		params.reference = arguments.first().and_then(Value::as_str).map(Str::new);
		if params.reference.is_none() {
			return Err(invalid("accessibility ref requires a string"));
		}
	}
	Ok(params)
}

fn apply_options(params: &mut NativeParams, value: &Value) -> Result<(), Fault> {
	let options = value
		.as_object()
		.ok_or_else(|| invalid("desktop options must be an object"))?;
	const KEYS: &[&str] = &[
		"window",
		"reference",
		"app",
		"title",
		"role",
		"value",
		"dx",
		"dy",
		"button",
		"count",
		"modifiers",
		"delivery",
		"maxWidth",
		"maxHeight",
		"maxDepth",
		"limit",
		"all",
		"silent",
	];
	if options.keys().any(|key| !KEYS.contains(&key.as_str())) {
		return Err(invalid("desktop options contain an unknown field"));
	}
	params.window = string_option(options, "window")?.or(params.window.take());
	params.reference = string_option(options, "reference")?.or(params.reference.take());
	params.app = string_option(options, "app")?;
	params.title = string_option(options, "title")?;
	params.value = string_option(options, "role")?.or(params.value.take());
	params.query_value = string_option(options, "value")?;
	params.dx = number_option(options, "dx")?;
	params.dy = number_option(options, "dy")?;
	params.button = string_option(options, "button")?;
	params.count = integer_option(options, "count")?;
	params.modifiers = string_array_option(options, "modifiers")?;
	params.delivery = string_option(options, "delivery")?;
	params.max_width = integer_option(options, "maxWidth")?;
	params.max_height = integer_option(options, "maxHeight")?;
	if params.max_width == Some(0) || params.max_height == Some(0) {
		return Err(invalid("desktop screenshot bounds must be positive"));
	}
	params.max_depth = integer_option(options, "maxDepth")?;
	params.limit = integer_option(options, "limit")?;
	params.all = bool_option(options, "all")?;
	params.silent = bool_option(options, "silent")?.unwrap_or(false);
	Ok(())
}

fn string_option(
	options: &serde_json::Map<String, Value>,
	name: &'static str,
) -> Result<Option<Str>, Fault> {
	options
		.get(name)
		.map(|value| {
			value
				.as_str()
				.map(Str::new)
				.ok_or_else(|| invalid("desktop string option has the wrong type"))
		})
		.transpose()
}

fn string_array_option(
	options: &serde_json::Map<String, Value>,
	name: &'static str,
) -> Result<Option<Vec<Str>>, Fault> {
	options
		.get(name)
		.map(|value| {
			value
				.as_array()
				.ok_or_else(|| invalid("desktop string-array option has the wrong type"))?
				.iter()
				.map(|value| {
					value
						.as_str()
						.map(Str::new)
						.ok_or_else(|| invalid("desktop string-array option has the wrong type"))
				})
				.collect()
		})
		.transpose()
}

fn bool_option(
	options: &serde_json::Map<String, Value>,
	name: &'static str,
) -> Result<Option<bool>, Fault> {
	options
		.get(name)
		.map(|value| {
			value
				.as_bool()
				.ok_or_else(|| invalid("desktop boolean option has the wrong type"))
		})
		.transpose()
}

fn number_option(
	options: &serde_json::Map<String, Value>,
	name: &'static str,
) -> Result<Option<f64>, Fault> {
	options
		.get(name)
		.map(|value| {
			value
				.as_f64()
				.ok_or_else(|| invalid("desktop number option has the wrong type"))
		})
		.transpose()
}

fn integer_option(
	options: &serde_json::Map<String, Value>,
	name: &'static str,
) -> Result<Option<u32>, Fault> {
	options
		.get(name)
		.map(|value| {
			value
				.as_u64()
				.and_then(|value| u32::try_from(value).ok())
				.ok_or_else(|| invalid("desktop integer option has the wrong type"))
		})
		.transpose()
}

fn require_arity(arguments: &[Value], expected: usize) -> Result<(), Fault> {
	if arguments.len() == expected {
		Ok(())
	} else {
		Err(invalid("desktop method received the wrong number of arguments"))
	}
}

fn require_arity_at_most(arguments: &[Value], maximum: usize) -> Result<(), Fault> {
	if arguments.len() <= maximum {
		Ok(())
	} else {
		Err(invalid("desktop method received too many arguments"))
	}
}

fn require_arity_range(arguments: &[Value], minimum: usize, maximum: usize) -> Result<(), Fault> {
	if (minimum..=maximum).contains(&arguments.len()) {
		Ok(())
	} else {
		Err(invalid("desktop method received the wrong number of arguments"))
	}
}

fn bounded_cap(requested: Option<u32>, configured: Option<u32>) -> Option<u32> {
	match configured {
		Some(configured) => Some(requested.map_or(configured, |requested| requested.min(configured))),
		None => requested,
	}
}

fn target(params: &NativeParams) -> Target {
	params
		.window
		.as_deref()
		.map_or(Target::Desktop, Target::parse)
}

fn pointer_options(params: &NativeParams) -> Option<PointerOptions> {
	let configured = params.button.is_some()
		|| params.count.is_some()
		|| params.modifiers.is_some()
		|| params.delivery.is_some();
	configured.then(|| PointerOptions {
		button:        params.button.as_ref().map(ToString::to_string),
		count:         params.count,
		modifiers:     params
			.modifiers
			.as_ref()
			.map(|values| values.iter().map(ToString::to_string).collect()),
		delivery_mode: params.delivery.as_ref().map(ToString::to_string),
	})
}

fn resolve_bound_params(
	params: &mut NativeParams,
	state: &Map<String, Value>,
) -> Result<(), Fault> {
	if let Some(binding) = params
		.window
		.as_deref()
		.and_then(|value| value.strip_prefix('$'))
	{
		let value = expression_value(binding, state)
			.ok_or_else(|| invalid("retained window handle is unavailable"))?;
		if let Some(id) = value
			.as_str()
			.or_else(|| value.get("id").and_then(Value::as_str))
		{
			params.window = Some(Str::new(id));
		} else if let Some(reference) = value.get("ref").and_then(Value::as_str) {
			params.window = None;
			params.reference = Some(Str::new(reference));
			params.operation = match params.operation {
				Operation::Click => Operation::AxClick,
				Operation::KeyChord => Operation::AxPerform,
				other => other,
			};
		} else {
			return Err(invalid("retained receiver is not a window or accessibility element"));
		}
	}
	if let Some(binding) = params
		.reference
		.as_deref()
		.and_then(|value| value.strip_prefix('$'))
	{
		let value = expression_value(binding, state)
			.ok_or_else(|| invalid("retained accessibility handle is unavailable"))?;
		let reference = value
			.as_str()
			.or_else(|| value.get("ref").and_then(Value::as_str))
			.ok_or_else(|| invalid("retained receiver is not an accessibility element"))?;
		params.reference = Some(Str::new(reference));
	}
	if let Some(binding) = params
		.value
		.as_deref()
		.and_then(|value| value.strip_prefix('$'))
	{
		let value = expression_value(binding, state)
			.ok_or_else(|| invalid("retained value is unavailable"))?;
		params.value = Some(match value {
			Value::String(value) => Str::new(value),
			other => Str::new(other.to_string()),
		});
	}
	Ok(())
}

fn capabilities(value: omp_desktop::DesktopCapabilities) -> Capabilities {
	Capabilities {
		backend: Str::new(value.backend),
		display_server: value.display_server.map(Str::new),
		capture: value.capture,
		input: value.input,
		ax: value.ax,
		background_window_input: value.background_window_input,
		delivery_modes: value.delivery_modes.into_iter().map(Str::new).collect(),
		capture_permission: Str::new(value.capture_permission),
		input_permission: Str::new(value.input_permission),
		ax_permission: Str::new(value.ax_permission),
		display_count: value.display_count,
	}
}

fn window(value: omp_desktop::DesktopWindow) -> Value {
	json!({
		"id": value.id,
		"title": value.title,
		"app": value.app,
		"pid": value.pid,
		"x": value.x,
		"y": value.y,
		"width": value.width,
		"height": value.height,
		"focused": value.focused,
		"coordinate_space": "global_logical",
	})
}

fn node(value: AxNode) -> Value {
	json!({
		"ref": value.ref_,
		"role": value.role,
		"native_role": value.native_role,
		"title": value.title,
		"value": value.value,
		"description": value.description,
		"enabled": value.enabled,
		"focused": value.focused,
		"x": value.x,
		"y": value.y,
		"width": value.width,
		"height": value.height,
		"actions": value.actions,
		"child_count": value.child_count,
		"coordinate_space": "global_logical",
	})
}

fn text(params: &NativeParams) -> Result<&str, Fault> {
	required(params.value.as_deref(), "operation requires `value`")
}

fn reference(params: &NativeParams) -> Result<&str, Fault> {
	required(params.reference.as_deref(), "operation requires an accessibility reference")
}

fn number(value: Option<f64>, field: &'static str) -> Result<f64, Fault> {
	let value = value.ok_or_else(|| invalid(field))?;
	if value.is_finite() {
		Ok(value)
	} else {
		Err(invalid("desktop coordinates and deltas must be finite"))
	}
}

fn required<'a>(value: Option<&'a str>, message: &'static str) -> Result<&'a str, Fault> {
	value.ok_or_else(|| invalid(message))
}

fn validate_non_run(params: &Params) -> Result<(), Fault> {
	if params.code.is_some() || params.read_only || params.timeout.is_some() {
		Err(invalid("capabilities and close accept only `action`"))
	} else {
		Ok(())
	}
}

fn invalid(message: &'static str) -> Fault {
	fault(FaultCode::InvalidRequest, message, None)
}

fn fault(code: FaultCode, message: &str, operation: Option<Operation>) -> Fault {
	Fault { code, message: Str::new(message), operation }
}

fn native_fault(operation: Operation, error: omp_desktop::DesktopError) -> Fault {
	let (code, message) = match error.code {
		ErrorCode::PermissionDenied => {
			(FaultCode::PermissionDenied, "required desktop permission is unavailable")
		},
		ErrorCode::CaptureFailed => (FaultCode::CaptureFailed, "desktop capture failed"),
		ErrorCode::InputFailed => (FaultCode::InputFailed, "desktop input delivery failed"),
		ErrorCode::BackgroundUnavailable => (
			FaultCode::BackgroundUnavailable,
			"background delivery is unavailable for this target; retry foreground delivery or \
			 accessibility",
		),
		ErrorCode::WindowNotFound => (FaultCode::WindowNotFound, "desktop window was not found"),
		ErrorCode::InvalidTarget => (FaultCode::InvalidTarget, "desktop target is invalid"),
		ErrorCode::InvalidKey => (FaultCode::InvalidKey, "desktop key chord is invalid"),
		ErrorCode::InvalidCoordinateFrame => (
			FaultCode::InvalidCoordinateFrame,
			"pointer input requires a recent screenshot of the same target",
		),
		ErrorCode::StaleRef => {
			(FaultCode::StaleRef, "accessibility reference expired; take a new accessibility snapshot")
		},
		ErrorCode::AxUnsupported => {
			(FaultCode::AxUnsupported, "accessibility is unavailable on this backend")
		},
		ErrorCode::AxFailed => (FaultCode::AxFailed, "accessibility operation failed"),
		ErrorCode::Timeout => (FaultCode::Timeout, "native desktop operation timed out"),
		ErrorCode::Closed => (FaultCode::Closed, "computer session is closed"),
		ErrorCode::Internal => (FaultCode::Internal, "native desktop worker failed"),
	};
	fault(code, message, Some(operation))
}

#[cfg(test)]
mod tests {
	use omp_con::Ctx;
	use omp_core::Str;
	use serde_json::{Map, json};

	use super::{
		ComputerSettings, Operation, SV_COMPUTER_DISPLAY, SV_COMPUTER_MAX_HEIGHT,
		SV_COMPUTER_MAX_WIDTH, Statement, bounded_cap, evaluate_assertion, parse_program,
	};

	#[test]
	fn computer_settings_project_from_typed_convars() {
		let con = Ctx::new();
		SV_COMPUTER_DISPLAY
			.set(&con, Str::new_static("display-2"))
			.expect("set display");
		SV_COMPUTER_MAX_WIDTH.set(&con, 1600).expect("set width");
		SV_COMPUTER_MAX_HEIGHT.set(&con, 900).expect("set height");

		assert_eq!(ComputerSettings::from_con(&con), ComputerSettings {
			display:    Str::new_static("display-2"),
			max_width:  1600,
			max_height: 900,
		});
		assert_eq!(bounded_cap(None, Some(1600)), Some(1600));
		assert_eq!(bounded_cap(Some(1200), Some(1600)), Some(1200));
		assert_eq!(bounded_cap(Some(2000), Some(1600)), Some(1600));
	}

	#[test]
	fn computer_program_composes_desktop_wait_and_assert() {
		let program = parse_program(
			"const windows = await desktop.windows();\nawait wait(5);\nassert(windows.length > 0, \
			 \"a desktop window is required\");\nawait \
			 desktop.screenshot({\"maxWidth\":1280,\"maxHeight\":896});",
		)
		.expect("parse program");
		assert_eq!(program.len(), 4);
		assert!(matches!(
			&program[0],
			Statement::Desktop { bind: Some(name), params }
				if name == "windows" && matches!(params.operation, Operation::ListWindows)
		));
		assert!(matches!(program[1], Statement::Wait(_)));
		assert!(matches!(program[2], Statement::Assert { .. }));
		assert!(matches!(
			&program[3],
			Statement::Desktop { params, .. }
				if matches!(params.operation, Operation::Capture)
					&& params.max_width == Some(1280)
					&& params.max_height == Some(896)
		));

		let mut state = Map::new();
		state.insert("windows".to_owned(), json!([{"id":"w1"}]));
		assert!(evaluate_assertion("windows.length > 0", &state));
		assert!(evaluate_assertion("windows.0.id == \"w1\"", &state));
		assert!(!evaluate_assertion("windows.length == 0", &state));
	}

	#[test]
	fn computer_program_rejects_non_surface_calls() {
		assert!(parse_program("process.exit(0)").is_err());
		assert!(parse_program("await desktop.click(\"x\", 2)").is_err());
		assert!(parse_program("assert(missing.length > 0)").is_ok());
		assert!(parse_program("await desktop.screenshot({\"unknown\":true})").is_err());
	}

	#[test]
	fn computer_program_lifts_window_ax_clipboard_and_pointer_options() {
		let program = parse_program(
			"const win = await desktop.window({\"app\":\"Terminal\",\"title\":\"omp\"});\nconst shot \
			 = await win.screenshot({\"silent\":true});\nawait win.doubleClick(20, 30, \
			 {\"button\":\"left\",\"modifiers\":[\"shift\"],\"delivery\":\"foreground\"});\nconst \
			 tree = await win.ax({\"all\":true,\"maxDepth\":8});\nconst el = await \
			 win.ref(\"e5\");\nawait el.setValue(\"updated\");\nreturn await el.bounds();\nconst \
			 clip = await desktop.clipboard.read();\nawait wait(() => clip.length > 0, \
			 {\"timeout\":500,\"interval\":10});",
		)
		.expect("parse complete computer surface");
		assert!(program.iter().any(|statement| matches!(
			statement,
			Statement::Desktop { params, .. }
				if params.operation == Operation::ResolveWindow
					&& params.app.as_deref() == Some("Terminal")
					&& params.title.as_deref() == Some("omp")
		)));
		assert!(program.iter().any(|statement| matches!(
			statement,
			Statement::Desktop { params, .. }
				if params.operation == Operation::Click
					&& params.count == Some(2)
					&& params.delivery.as_deref() == Some("foreground")
		)));
		assert!(program.iter().any(|statement| matches!(
			statement,
			Statement::Desktop { params, .. }
				if params.operation == Operation::AxSetValue
					&& params.reference.as_deref() == Some("$el")
		)));
		assert!(
			program
				.iter()
				.any(|statement| { matches!(statement, Statement::WaitUntil { .. }) })
		);
	}

	#[test]
	fn expression_paths_accept_javascript_index_and_optional_chain_syntax() {
		let mut state = Map::new();
		state.insert("windows".to_owned(), json!([{"id":"w1"}]));
		assert_eq!(super::expression_value("windows[0]?.id", &state), Some(json!("w1")));
	}
}
