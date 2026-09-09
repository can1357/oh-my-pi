//! Native desktop capture, input, and accessibility device.

use std::sync::Arc;

use async_stream::stream;
use async_trait::async_trait;
use bytes::Bytes;
use futures::Stream;
use omp_core::{Str, sf};
use omp_tool::{
	Abort, ArgIssue, ArgIssueKind, CallOutcome, CommitError, Constraint, DesktopEffects, Effects,
	Ev, IncomingParams, LiftedCall, ParamError, Part, PromptCaps, RecordedCall, Rev, Tool, ToolSpec,
	ToolTerminal,
};
use schemars::JsonSchema;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;
use tokio_util::sync::CancellationToken;

/// Computer-session lifecycle action.
#[derive(
	Clone,
	Copy,
	Debug,
	Default,
	Deserialize,
	Eq,
	JsonSchema,
	PartialEq,
	Serialize,
	strum::Display,
	strum::IntoStaticStr,
)]
#[serde(rename_all = "snake_case")]
#[strum(serialize_all = "snake_case")]
pub enum Action {
	/// Execute one program in the persistent desktop session.
	#[default]
	Run,
	/// Report native backend and permission capabilities.
	Capabilities,
	/// Permanently close this tool instance's desktop session.
	Close,
}

/// One native operation available to the computer program.
#[derive(
	Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, strum::Display, strum::IntoStaticStr,
)]
#[serde(rename_all = "snake_case")]
#[strum(serialize_all = "snake_case")]
pub enum Operation {
	/// Report capture/input/accessibility capabilities.
	Capabilities,
	/// Close the persistent native session.
	Close,
	/// List attached displays.
	ListDisplays,
	/// List capturable windows.
	ListWindows,
	/// Resolve exactly one window selector.
	ResolveWindow,
	/// Resolve the focused window.
	FocusedWindow,
	/// Capture a desktop or window.
	Capture,
	/// Click a capture-relative point.
	Click,
	/// Move the pointer.
	MoveMouse,
	/// Drag through capture-relative points.
	Drag,
	/// Scroll at a point.
	Scroll,
	/// Type text.
	TypeText,
	/// Press a key chord.
	KeyChord,
	/// Raise a window.
	RaiseWindow,
	/// Capture a bounded accessibility tree.
	AxSnapshot,
	/// Query accessibility nodes.
	AxQuery,
	/// Hit-test an accessibility node.
	AxElementAt,
	/// Return the focused accessibility node.
	AxFocused,
	/// Resolve an accessibility reference.
	AxNode,
	/// Read the current accessibility value.
	AxValue,
	/// Read accessibility bounds in global logical coordinates.
	AxBounds,
	/// Read supported native accessibility actions.
	AxActions,
	/// Read native attributes from an accessibility reference.
	AxAttributes,
	/// Return direct accessibility children.
	AxChildren,
	/// Return an accessibility parent.
	AxParent,
	/// Perform a native accessibility action.
	AxPerform,
	/// Set an accessibility value.
	AxSetValue,
	/// Focus an accessibility element.
	AxFocus,
	/// Click an accessibility element.
	AxClick,
	/// Read host clipboard text.
	ClipboardRead,
	/// Write host clipboard text.
	ClipboardWrite,
}

/// Model-facing persistent computer invocation.
#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Params {
	/// Session action.
	pub action:    Action,
	/// JavaScript-like domain program executed for `run`. Top-level `await` is
	/// accepted and `desktop`, `wait`, `assert`, `display`, and `print` are in
	/// scope.
	pub code:      Option<Str>,
	/// Prohibit input, focus, accessibility mutation, and clipboard writes.
	#[serde(default)]
	pub read_only: bool,
	/// Whole-program run budget in seconds.
	pub timeout:   Option<f64>,
}

/// One native desktop operation after lifting a program call.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct NativeParams {
	/// Operation to perform.
	pub operation:   Operation,
	/// Window id; absence selects the complete desktop.
	pub window:      Option<Str>,
	/// Accessibility reference or window id depending on the action.
	pub reference:   Option<Str>,
	/// Text, key chord, action name, or query role.
	pub value:       Option<Str>,
	/// Window application filter.
	pub app:         Option<Str>,
	/// Window title or accessibility title filter.
	pub title:       Option<Str>,
	/// Accessibility value filter.
	pub query_value: Option<Str>,
	/// Primary x coordinate.
	pub x:           Option<f64>,
	/// Primary y coordinate.
	pub y:           Option<f64>,
	/// Horizontal scroll delta.
	pub dx:          Option<f64>,
	/// Vertical scroll delta.
	pub dy:          Option<f64>,
	/// Drag path as ordered `[x, y]` pairs.
	pub points:      Option<Vec<[f64; 2]>>,
	/// Pointer button.
	pub button:      Option<Str>,
	/// Click count.
	pub count:       Option<u32>,
	/// Modifier chord members.
	pub modifiers:   Option<Vec<Str>>,
	/// Native delivery mode (`background` or `foreground`).
	pub delivery:    Option<Str>,
	/// Capture width cap.
	pub max_width:   Option<u32>,
	/// Capture height cap.
	pub max_height:  Option<u32>,
	/// Accessibility tree depth cap.
	pub max_depth:   Option<u32>,
	/// Accessibility result cap.
	pub limit:       Option<u32>,
	/// Retain otherwise-filtered accessibility nodes.
	pub all:         Option<bool>,
	/// Suppress transcript image reveal while retaining the screenshot artifact.
	#[serde(default)]
	pub silent:      bool,
}

impl NativeParams {
	/// Exact desktop authority required by this invocation.
	pub const fn required_effects(&self) -> DesktopEffects {
		match self.operation {
			Operation::Capabilities
			| Operation::Close
			| Operation::ListDisplays
			| Operation::ListWindows
			| Operation::ResolveWindow
			| Operation::FocusedWindow
			| Operation::ClipboardRead => {
				DesktopEffects { capture: false, accessibility: false, input: false }
			},
			Operation::Capture => {
				DesktopEffects { capture: true, accessibility: false, input: false }
			},
			Operation::AxSnapshot
			| Operation::AxQuery
			| Operation::AxElementAt
			| Operation::AxFocused
			| Operation::AxNode
			| Operation::AxValue
			| Operation::AxBounds
			| Operation::AxActions
			| Operation::AxAttributes
			| Operation::AxChildren
			| Operation::AxParent => {
				DesktopEffects { capture: false, accessibility: true, input: false }
			},
			Operation::AxPerform | Operation::AxSetValue | Operation::AxFocus | Operation::AxClick => {
				DesktopEffects { capture: false, accessibility: true, input: true }
			},
			Operation::Click
			| Operation::MoveMouse
			| Operation::Drag
			| Operation::Scroll
			| Operation::TypeText
			| Operation::KeyChord
			| Operation::RaiseWindow
			| Operation::ClipboardWrite => {
				DesktopEffects { capture: false, accessibility: false, input: true }
			},
		}
	}
}

/// Retained full-resolution screenshot.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct Artifact {
	/// Content-addressed artifact URI.
	pub uri:           Str,
	/// Media type.
	pub mime:          Str,
	/// Whether actors and media-capable models should reveal it inline.
	pub visible:       bool,
	/// Exact retained byte count.
	pub byte_len:      u64,
	/// Returned image width after bounding.
	pub width:         u32,
	/// Returned image height after bounding.
	pub height:        u32,
	/// Native width before bounding.
	pub source_width:  u32,
	/// Native height before bounding.
	pub source_height: u32,
	/// Canonical capture target.
	pub target:        Str,
}

impl<'de> Deserialize<'de> for Artifact {
	fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
		#[derive(Deserialize)]
		#[serde(untagged)]
		enum Wire {
			Legacy(Str),
			Current {
				uri:           Str,
				mime:          Str,
				#[serde(default = "visible")]
				visible:       bool,
				#[serde(default)]
				byte_len:      u64,
				#[serde(default)]
				width:         u32,
				#[serde(default)]
				height:        u32,
				#[serde(default)]
				source_width:  u32,
				#[serde(default)]
				source_height: u32,
				#[serde(default = "desktop_target")]
				target:        Str,
			},
		}
		Ok(match Wire::deserialize(deserializer)? {
			Wire::Legacy(uri) => Self {
				uri,
				mime: sf!("image/png"),
				visible: true,
				byte_len: 0,
				width: 0,
				height: 0,
				source_width: 0,
				source_height: 0,
				target: desktop_target(),
			},
			Wire::Current {
				uri,
				mime,
				visible,
				byte_len,
				width,
				height,
				source_width,
				source_height,
				target,
			} => Self {
				uri,
				mime,
				visible,
				byte_len,
				width,
				height,
				source_width,
				source_height,
				target,
			},
		})
	}
}

const fn visible() -> bool {
	true
}

fn desktop_target() -> Str {
	sf!("desktop")
}

/// Native backend and permission status.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Capabilities {
	/// Backend implementation name.
	pub backend: Str,
	/// Display-server name when applicable.
	pub display_server: Option<Str>,
	/// Screenshot capture availability.
	pub capture: bool,
	/// Pointer and keyboard input availability.
	pub input: bool,
	/// Accessibility availability.
	pub ax: bool,
	/// Background-window input support.
	pub background_window_input: bool,
	/// Supported delivery modes.
	pub delivery_modes: Vec<Str>,
	/// Capture permission status.
	pub capture_permission: Str,
	/// Input permission status.
	pub input_permission: Str,
	/// Accessibility permission status.
	pub ax_permission: Str,
	/// Attached display count.
	pub display_count: u32,
}

/// Computer operation result.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Payload {
	/// Completed session action. Absent only in pre-`computer@3` journals.
	#[serde(default)]
	pub action:       Action,
	/// Exact executed program for `run`.
	#[serde(default)]
	pub code:         Option<Str>,
	/// Structured operation/display/return values in program order.
	#[serde(default)]
	pub results:      Vec<Value>,
	/// Content-addressed screenshots produced during the program.
	#[serde(default)]
	pub artifacts:    Vec<Artifact>,
	/// Capability snapshot for `capabilities` and completed runs.
	#[serde(default)]
	pub capabilities: Option<Capabilities>,
}

/// Stable redacted computer failure category.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, strum::Display)]
#[serde(rename_all = "snake_case")]
#[strum(serialize_all = "snake_case")]
pub enum FaultCode {
	/// Program or operation arguments are invalid.
	InvalidRequest,
	/// The persistent computer session is busy.
	Busy,
	/// The persistent computer session was closed.
	Closed,
	/// A read-only program attempted mutation.
	ReadOnly,
	/// The run was cancelled or closed.
	Cancelled,
	/// The run budget expired.
	Timeout,
	/// Required OS permission is unavailable.
	PermissionDenied,
	/// Screenshot capture failed.
	CaptureFailed,
	/// Native input delivery failed.
	InputFailed,
	/// Background delivery cannot target this window safely.
	BackgroundUnavailable,
	/// Target window no longer exists.
	WindowNotFound,
	/// Capture target or display selector is invalid.
	InvalidTarget,
	/// Key or chord is invalid.
	InvalidKey,
	/// Pointer coordinates have no matching capture frame.
	InvalidCoordinateFrame,
	/// Accessibility reference expired.
	StaleRef,
	/// Accessibility is unavailable.
	AxUnsupported,
	/// Accessibility operation failed.
	AxFailed,
	/// Clipboard access failed.
	ClipboardFailed,
	/// Artifact retention failed.
	ArtifactFailed,
	/// Native desktop worker failed without a safe detail.
	Internal,
}

/// Native desktop failure. Backend diagnostics are deliberately replaced by
/// stable, secret-free text before crossing the host boundary.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, thiserror::Error)]
#[error("{message}")]
pub struct Fault {
	/// Stable typed failure category.
	pub code:      FaultCode,
	/// Secret-free diagnostic.
	pub message:   Str,
	/// Native operation being attempted when known.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub operation: Option<Operation>,
}

/// Typed computer progress streamed into the call element.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Update {
	/// A lifecycle action began.
	Started {
		/// Action being performed.
		action: Action,
	},
	/// One lifted desktop operation began.
	Operation {
		/// Native operation.
		operation: Operation,
	},
	/// A screenshot was retained.
	Artifact {
		/// Content-addressed artifact URI.
		uri:     Str,
		/// Whether this capture is visible inline.
		visible: bool,
	},
}

/// Harness-owned persistent desktop session contract.
#[async_trait]
pub trait ComputerHost: Send + Sync + 'static {
	/// Execute one admission-approved lifecycle action.
	async fn execute(
		&self,
		params: Params,
		cancellation: CancellationToken,
		updates: flume::Sender<Update>,
	) -> Result<Payload, Fault>;
	/// Release resources owned by this tool/session composition.
	fn release(&self);
}

/// Computer tool routed to one native session.
pub struct Computer {
	host: Arc<dyn ComputerHost>,
	spec: ToolSpec,
}

/// Builds the host-free `computer@3` declaration.
pub fn spec() -> ToolSpec {
	ToolSpec {
		name:            sf!("computer"),
		rev:             Rev { family: Str::default(), n: 3 },
		description:     sf!(
			"Controls one persistent, session-owned native desktop. action=run executes a bounded \
			 domain program with desktop, wait, assert, display, and print in scope; \
			 action=capabilities reports backend permissions; action=close permanently releases the \
			 session. Desktop programs can list/resolve windows and displays; capture screenshots; \
			 deliver pointer, keyboard, and clipboard input; inspect/query/act on accessibility \
			 elements; and wait for assertions. Pointer coordinates are pixels in the most recent \
			 screenshot of the same target, while accessibility bounds and hit tests use global \
			 logical coordinates."
		),
		schema:          omp_tool::schema::<Params>(),
		constraint:      Constraint::Schema {
			priority:       100,
			on_unsupported: omp_tool::Fallback::Unspecified,
		},
		effects:         Effects {
			documents: None,
			exec:      None,
			inference: None,
			desktop:   Some(DesktopEffects {
				capture:       true,
				accessibility: true,
				input:         true,
			}),
			subagents: 0,
		},
		projection_code: omp_tool::native_projection_code(
			env!("CARGO_PKG_NAME"),
			env!("CARGO_PKG_VERSION"),
			include_bytes!("computer.rs"),
		)
		.into(),
	}
}

/// Creates `computer@3`.
pub fn tool(host: Arc<dyn ComputerHost>) -> Computer {
	Computer { host, spec: spec() }
}

impl Drop for Computer {
	fn drop(&mut self) {
		self.host.release();
	}
}

impl Tool for Computer {
	type Fault = Fault;
	type Params = Params;
	type Payload = Payload;
	type Update = Update;

	fn spec(&self) -> &ToolSpec {
		&self.spec
	}

	fn call<'c>(
		&'c self,
		mut incoming: IncomingParams<'c>,
	) -> impl Stream<Item = Ev<Update, Payload, Fault>> + Send + 'c {
		stream! {
			let params = match incoming.whole::<Params>().await {
				Ok(params) => params,
				Err(error) => { yield param_event(error); return; },
			};
			if let Err(error) = incoming.interruptable().committed().await {
				yield commit_event(error);
				return;
			}
			let cancellation = CancellationToken::new();
			let (updates, progress) = flume::unbounded();
			let execution = self.host.execute(params, cancellation.clone(), updates);
			tokio::pin!(execution);
			loop {
				tokio::select! {
					biased;
					interrupt = incoming.next_interrupt() => {
						cancellation.cancel();
						let _ = execution.await;
						if let Ok(interrupt) = interrupt {
							yield Ev::Aborted(Abort::Interrupted { reason: interrupt.reason });
						} else {
							yield Ev::Aborted(Abort::InputDropped);
						}
						return;
					},
					result = &mut execution => {
						yield Ev::Done(ToolTerminal::Done { result, useless: false });
						return;
					},
					update = progress.recv_async() => if let Ok(update) = update {
						yield Ev::Update(update);
					},
				}
			}
		}
	}

	fn lift(&self, from: &Rev, call: RecordedCall<'_>) -> Option<LiftedCall> {
		lift_legacy_call(from, call)
	}

	fn prompt(&self, view: Result<&Payload, &Fault>, caps: &PromptCaps) -> Vec<Part> {
		match view {
			Ok(payload) => {
				let mut parts = vec![Part::Text {
					text: Str::new(serde_json::to_string(payload).expect("computer payload serializes")),
				}];
				if caps.media {
					for artifact in payload.artifacts.iter().filter(|artifact| {
						artifact.visible && artifact.byte_len != 0 && artifact.mime.starts_with("image/")
					}) {
						if let Some(hash) = artifact.uri.strip_prefix("artifact://sha256/") {
							parts.push(Part::Blob {
								blob: omp_tool::BlobRef {
									hash:       Str::new(hash),
									media_type: artifact.mime.clone(),
									byte_len:   artifact.byte_len,
								},
								alt:  Some(sf!("Computer screenshot of {}", artifact.target)),
							});
						}
					}
				}
				parts
			},
			Err(fault) => vec![Part::Text { text: fault.message.clone() }],
		}
	}
}

fn lift_legacy_call(from: &Rev, call: RecordedCall<'_>) -> Option<LiftedCall> {
	if !from.family.is_empty() || from.n != 2 {
		return None;
	}
	let mut raw_args = serde_json::from_slice::<Value>(call.raw_args).ok()?;
	let object = raw_args.as_object_mut()?;
	if !object.contains_key("code") || object.contains_key("action") {
		return None;
	}
	object.insert("action".to_owned(), Value::String("run".to_owned()));
	#[derive(Deserialize)]
	struct LegacyFault {
		code:    Str,
		message: Str,
	}
	let verdict = serde_json::from_slice::<CallOutcome<Payload, LegacyFault>>(call.verdict).ok()?;
	let verdict = match verdict {
		CallOutcome::Ok(payload) => CallOutcome::Ok(payload),
		CallOutcome::Faulted(legacy) => {
			let code = if legacy.code.contains("permission") {
				FaultCode::PermissionDenied
			} else if legacy.code.contains("timeout") {
				FaultCode::Timeout
			} else if legacy.code.contains("coordinate") {
				FaultCode::InvalidCoordinateFrame
			} else if legacy.code.contains("stale") {
				FaultCode::StaleRef
			} else {
				FaultCode::Internal
			};
			let message = match code {
				FaultCode::PermissionDenied => sf!("required desktop permission is unavailable"),
				FaultCode::Timeout => sf!("computer program exceeded its timeout"),
				FaultCode::InvalidCoordinateFrame => {
					sf!("pointer input requires a recent screenshot of the same target")
				},
				FaultCode::StaleRef => {
					sf!("accessibility reference expired; take a new accessibility snapshot")
				},
				_ => {
					let _ = legacy.message;
					sf!("legacy computer operation failed")
				},
			};
			CallOutcome::Faulted(Fault { code, message, operation: None })
		},
		CallOutcome::ArgsRejected(issue) => CallOutcome::ArgsRejected(issue),
		CallOutcome::Aborted { abort, kind, policy } => CallOutcome::Aborted { abort, kind, policy },
	};
	Some(LiftedCall {
		raw_args: Bytes::from(serde_json::to_vec(&raw_args).ok()?),
		verdict:  Bytes::from(serde_json::to_vec(&verdict).ok()?),
	})
}

fn param_event(error: ParamError) -> Ev<Update, Payload, Fault> {
	match error {
		ParamError::Args(issue) => Ev::Args(*issue),
		ParamError::Interrupted(interrupt) => {
			Ev::Aborted(Abort::Interrupted { reason: interrupt.reason })
		},
		ParamError::Protocol(message) => Ev::Args(protocol_issue(message)),
	}
}

fn commit_event(error: CommitError) -> Ev<Update, Payload, Fault> {
	match error {
		CommitError::Aborted => Ev::Aborted(Abort::InputDropped),
		CommitError::Interrupted(interrupt) => {
			Ev::Aborted(Abort::Interrupted { reason: interrupt.reason })
		},
		CommitError::Protocol(message) => Ev::Args(protocol_issue(message)),
	}
}

fn protocol_issue(message: Str) -> ArgIssue {
	ArgIssue {
		path:     Vec::new(),
		expected: sf!("one committed computer argument object"),
		kind:     ArgIssueKind::Protocol,
		example:  None,
		found:    Some(message),
	}
}

#[cfg(test)]
mod tests {
	use omp_core::Str;
	use omp_tool::{CallOutcome, RecordedCall, Rev};
	use serde_json::{Value, json};

	use super::{Action, Fault, FaultCode, Params, Payload, lift_legacy_call, spec};

	#[test]
	fn computer_schema_exposes_only_lifecycle_code_surface() {
		let schema: Value = serde_json::from_slice(&spec().schema).expect("computer schema");
		let properties = schema["properties"].as_object().expect("object properties");
		let mut domain = properties
			.keys()
			.filter(|name| !matches!(name.as_str(), "i" | "notrunc"))
			.map(String::as_str)
			.collect::<Vec<_>>();
		domain.sort_unstable();
		assert_eq!(domain, ["action", "code", "read_only", "timeout"]);
		assert_eq!(schema["required"], json!(["i", "action"]));
		let description = properties["code"]["description"]
			.as_str()
			.expect("code description");
		for binding in ["desktop", "wait", "assert", "display", "print"] {
			assert!(description.contains(binding));
		}
	}

	#[test]
	fn computer_schema_accepts_run_capabilities_and_close() {
		let run: Params = serde_json::from_value(json!({
			"action": "run",
			"code": "const windows = await desktop.windows();\nassert(windows.length > 0);",
			"read_only": true,
			"timeout": 12.5
		}))
		.expect("run arguments");
		assert_eq!(run.action, Action::Run);
		assert!(run.read_only);
		assert_eq!(run.timeout, Some(12.5));
		assert!(
			run.code
				.as_deref()
				.is_some_and(|code| code.contains("desktop.windows"))
		);
		for action in ["capabilities", "close"] {
			let params: Params = serde_json::from_value(json!({"action": action})).expect(action);
			assert!(params.code.is_none());
		}
	}

	#[test]
	fn computer_two_lifts_to_explicit_run_action() {
		let payload = Payload {
			action:       Action::Run,
			code:         Some(Str::new_static("return 1")),
			results:      vec![json!(1)],
			artifacts:    Vec::new(),
			capabilities: None,
		};
		let verdict =
			serde_json::to_vec(&CallOutcome::<Payload, Fault>::Ok(payload)).expect("verdict");
		let lifted = lift_legacy_call(&Rev { family: Str::default(), n: 2 }, RecordedCall {
			raw_args: br#"{"i":"Checking desktop","code":"return 1"}"#,
			verdict:  &verdict,
		})
		.expect("lift");
		let args: Value = serde_json::from_slice(&lifted.raw_args).expect("lifted args");
		assert_eq!(args["action"], "run");
	}

	#[test]
	fn fault_codes_are_typed_and_redacted() {
		let fault = Fault {
			code:      FaultCode::PermissionDenied,
			message:   Str::new_static("screen capture permission is unavailable"),
			operation: None,
		};
		let value = serde_json::to_value(fault).expect("fault");
		assert_eq!(value["code"], "permission_denied");
		assert!(!value.to_string().contains("/Users/"));
	}
}
