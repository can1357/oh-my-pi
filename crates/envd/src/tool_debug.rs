//! Production bridge from `debug@2` to the Environment DAP wire.

use std::{
	collections::{BTreeMap, BTreeSet},
	future::Future,
	sync::Arc,
	time::Duration,
};

use bytes::Bytes;
use omp_core::{Str, encoding::hex};
use omp_proto::document::v1 as pb;
use omp_tools::{
	debug::{Action, DebugControl, Fault, Params, Payload},
	debug_render::render,
};
use parking_lot::RwLock;
use serde_json::{Map, Value, json};
use tokio_util::sync::CancellationToken;

use super::docs::{DapRegistryEvent, DocumentError, DocumentHost};

#[derive(Clone)]
struct TrackedSession {
	wire:    pb::DapSessionRef,
	adapter: Str,
	program: Option<Str>,
	cwd:     Option<Str>,
	pid:     Option<u32>,
	status:  Str,
}

/// Environment-owned implementation of the revisioned debugger tool.
#[derive(Clone)]
pub struct DocumentDebugControl {
	documents: DocumentHost,
	sessions:  Arc<RwLock<BTreeMap<Str, TrackedSession>>>,
	active:    Arc<RwLock<Option<Str>>>,
}

impl DocumentDebugControl {
	/// Binds the project document authority.
	pub fn new(documents: DocumentHost) -> Self {
		Self {
			documents,
			sessions: Arc::new(RwLock::new(BTreeMap::new())),
			active: Arc::new(RwLock::new(None)),
		}
	}

	fn session(&self, requested: Option<&Str>) -> Result<(Str, TrackedSession), Fault> {
		let sessions = self.sessions.read();
		let id = requested
			.cloned()
			.or_else(|| self.active.read().clone())
			.or_else(|| sessions.keys().next().cloned())
			.ok_or(Fault::Unavailable)?;
		sessions
			.get(&id)
			.cloned()
			.map(|session| (id, session))
			.ok_or(Fault::Unavailable)
	}
}

impl DebugControl for DocumentDebugControl {
	fn execute(
		&self,
		params: Params,
		timeout: Duration,
		cancel: CancellationToken,
	) -> impl Future<Output = Result<Payload, Fault>> + Send + '_ {
		async move {
			if matches!(params.action, Action::Launch | Action::Attach) {
				return self.start(params, &cancel).await;
			}
			if params.action == Action::Sessions && self.sessions.read().is_empty() {
				return Ok(self.sessions_payload());
			}
			if params.action == Action::Terminate && self.sessions.read().is_empty() {
				let data = json!({"terminated": false});
				return Ok(rendered_payload(params.action, None, None, data));
			}
			let (session_id, tracked) = self.session(None)?;
			let arguments = action_arguments(&params);
			let required_capability = if params.action.read_only() {
				pb::DapCapability::Read
			} else {
				pb::DapCapability::Execute
			};
			let (response, events) = self
				.documents
				.dap_action(
					pb::DapActionRequest {
						session:             Some(tracked.wire.clone()),
						expected_revision:   tracked.wire.revision,
						required_capability: required_capability as i32,
						command:             wire_action(&params),
						arguments_json:      Bytes::from(
							serde_json::to_vec(&arguments).map_err(|_| Fault::InvalidArguments)?,
						),
						max_response_bytes:  256 * 1024,
						timeout_ms:          u32::try_from(timeout.as_millis()).unwrap_or(u32::MAX),
					},
					&cancel,
				)
				.await
				.map_err(map_document_error)?;
			let next = response.session.ok_or(Fault::Adapter)?;
			let mut next_tracked = tracked;
			next_tracked.wire = next.clone();
			self
				.sessions
				.write()
				.insert(session_id.clone(), next_tracked.clone());
			let mut data = if response.body_json.is_empty() {
				json!({})
			} else {
				serde_json::from_slice(&response.body_json).map_err(|_| Fault::Adapter)?
			};
			merge_events(&mut data, events);
			if params.action == Action::CustomRequest {
				data = json!({"command": params.command, "body": data});
			}
			if params.action == Action::Sessions {
				self.merge_session_rows(&mut data);
				return Ok(rendered_payload(params.action, self.active.read().clone(), None, data));
			}
			if params.action == Action::Terminate {
				next_tracked.status = Str::new_static("terminated");
				data["terminated"] = json!(true);
			} else if let Some(status) = observed_status(&data) {
				next_tracked.status = Str::new(status);
				self
					.sessions
					.write()
					.insert(session_id.clone(), next_tracked.clone());
			}
			attach_snapshot(&mut data, &session_id, &next_tracked);
			if params.action == Action::Terminate {
				self.sessions.write().remove(&session_id);
				let next_active = self.sessions.read().keys().next().cloned();
				*self.active.write() = next_active;
			} else {
				*self.active.write() = Some(session_id.clone());
			}
			Ok(rendered_payload(params.action, Some(session_id), Some(next.revision), data))
		}
	}
}

impl DocumentDebugControl {
	async fn start(&self, params: Params, cancel: &CancellationToken) -> Result<Payload, Fault> {
		if !self.sessions.read().is_empty() {
			return Err(Fault::Unavailable);
		}
		let adapter = params.adapter.as_deref().unwrap_or_default();
		let configuration = start_arguments(&params);
		let capabilities = vec![
			omp_proto::document::v1::DapCapability::Read as i32,
			omp_proto::document::v1::DapCapability::Execute as i32,
		];
		let workspace_uri = self.documents.hello().root_uri.to_string();
		let encoded =
			Bytes::from(serde_json::to_vec(&configuration).map_err(|_| Fault::InvalidArguments)?);
		let (response, events) = match params.action {
			Action::Launch => {
				self
					.documents
					.dap_launch(
						pb::DapLaunchRequest {
							adapter: adapter.to_owned(),
							workspace_uri,
							configuration_json: encoded,
							capabilities,
							max_event_bytes: 64 * 1024,
						},
						cancel,
					)
					.await
			},
			Action::Attach => {
				self
					.documents
					.dap_attach(
						pb::DapAttachRequest {
							adapter: adapter.to_owned(),
							workspace_uri,
							configuration_json: encoded,
							capabilities,
							max_event_bytes: 64 * 1024,
						},
						cancel,
					)
					.await
			},
			_ => unreachable!("start handles launch and attach only"),
		}
		.map_err(map_document_error)?;
		let session = response.session.ok_or(Fault::Adapter)?;
		let id = Str::from(hex::encode(&session.session_id).into_string());
		let tracked = TrackedSession {
			wire:    session.clone(),
			adapter: Str::new(response.adapter.as_str()),
			program: params.program.clone(),
			cwd:     params.cwd.clone(),
			pid:     params.pid,
			status:  Str::new_static("running"),
		};
		self.sessions.write().insert(id.clone(), tracked.clone());
		*self.active.write() = Some(id.clone());
		let mut data = json!({
			"capabilities": serde_json::from_slice::<Value>(&response.adapter_capabilities_json).unwrap_or(Value::Null),
		});
		merge_events(&mut data, events);
		attach_snapshot(&mut data, &id, &tracked);
		Ok(rendered_payload(params.action, Some(id), Some(session.revision), data))
	}

	fn merge_session_rows(&self, data: &mut Value) {
		let active = self.active.read().clone();
		let mut sessions = self.sessions.write();
		let Some(rows) = data.as_array_mut() else {
			return;
		};
		let live = rows
			.iter()
			.filter_map(|row| row.get("id").and_then(Value::as_str).map(Str::new))
			.collect::<BTreeSet<_>>();
		sessions.retain(|id, _| live.contains(id));
		if active.as_ref().is_some_and(|id| !live.contains(id)) {
			*self.active.write() = sessions.keys().next().cloned();
		}
		for row in rows {
			let Some(id) = row.get("id").and_then(Value::as_str).map(Str::new) else {
				continue;
			};
			let Some(tracked) = sessions.get_mut(&id) else {
				continue;
			};
			if let Some(state) = row.get("state").and_then(Value::as_str).map(Str::new) {
				tracked.status = state.clone();
				row["status"] = json!(state);
			}
			if let Some(pid) = row
				.get("processId")
				.and_then(Value::as_u64)
				.and_then(|pid| u32::try_from(pid).ok())
			{
				tracked.pid = Some(pid);
			}
			row["program"] = json!(tracked.program);
			row["cwd"] = json!(tracked.cwd);
			row["pid"] = json!(tracked.pid);
			row["active"] = json!(active.as_ref() == Some(&id));
		}
	}

	fn sessions_payload(&self) -> Payload {
		let active = self.active.read().clone();
		let data = Value::Array(
			self
				.sessions
				.read()
				.iter()
				.map(|(id, tracked)| session_snapshot(id, tracked, active.as_ref() == Some(id)))
				.collect(),
		);
		rendered_payload(Action::Sessions, active, None, data)
	}
}

fn rendered_payload(
	action: Action,
	session: Option<Str>,
	revision: Option<u64>,
	data: Value,
) -> Payload {
	let rendered = render(action, &data);
	Payload { action, session, revision, output: rendered.text, data, diags: rendered.diags }
}

fn wire_action(params: &Params) -> String {
	match (params.action, params.function.is_some()) {
		(Action::SetBreakpoint, true) => "set_function_breakpoint".to_owned(),
		(Action::RemoveBreakpoint, true) => "remove_function_breakpoint".to_owned(),
		_ => params.action.to_string(),
	}
}

fn session_snapshot(id: &Str, tracked: &TrackedSession, active: bool) -> Value {
	json!({
		"id": id,
		"adapter": tracked.adapter,
		"status": tracked.status,
		"revision": tracked.wire.revision,
		"program": tracked.program,
		"cwd": tracked.cwd,
		"pid": tracked.pid,
		"active": active,
	})
}

fn observed_status(data: &Value) -> Option<&str> {
	data
		.get("state")
		.and_then(Value::as_str)
		.or_else(|| {
			data
				.get("events")
				.and_then(Value::as_array)
				.and_then(|events| events.last())
				.and_then(|event| event.get("body"))
				.and_then(|body| body.get("state"))
				.and_then(Value::as_str)
		})
		.or_else(|| data.get("body").and_then(observed_status))
}

fn attach_snapshot(data: &mut Value, id: &Str, tracked: &TrackedSession) {
	if !data.is_object() {
		*data = json!({"body": std::mem::take(data)});
	}
	let mut snapshot = session_snapshot(id, tracked, true);
	let status = observed_status(data);
	if let Some(status) = status {
		snapshot["status"] = json!(status);
	}
	if let Some(frame) = data.get("frame") {
		snapshot["frame"] = frame.clone();
	}
	data["session"] = snapshot;
}

fn start_arguments(params: &Params) -> Value {
	let mut arguments = Map::new();
	insert_str(&mut arguments, "program", params.program.as_ref());
	insert(&mut arguments, "args", params.args.as_ref());
	insert_str(&mut arguments, "cwd", params.cwd.as_ref());
	if let Some(pid) = params.pid {
		arguments.insert("pid".to_owned(), json!(pid));
		arguments.insert("processId".to_owned(), json!(pid));
	}
	if let Some(port) = params.port {
		arguments.insert("port".to_owned(), json!(port));
	}
	if let Some(host) = &params.host {
		arguments.insert("host".to_owned(), json!(host));
	}
	Value::Object(arguments)
}

fn action_arguments(params: &Params) -> Value {
	let mut arguments = Map::new();
	insert(&mut arguments, "frameId", params.frame_id);
	insert(&mut arguments, "variablesReference", params.variable_ref.or(params.scope_id));
	insert(&mut arguments, "count", params.count);
	insert(&mut arguments, "offset", params.offset);
	insert_str(&mut arguments, "expression", params.expression.as_ref());
	insert_str(&mut arguments, "context", params.context.as_ref());
	if params.context.is_none() && params.action == Action::Evaluate {
		arguments.insert("context".to_owned(), json!("repl"));
	}
	insert_str(&mut arguments, "memoryReference", params.memory_reference.as_ref());
	insert_str(&mut arguments, "data", params.data.as_ref());
	match params.action {
		Action::SetBreakpoint | Action::RemoveBreakpoint if params.function.is_some() => {
			arguments.insert(
				"breakpoint".to_owned(),
				json!({"name": params.function, "condition": params.condition}),
			);
		},
		Action::SetBreakpoint | Action::RemoveBreakpoint => {
			arguments.insert("source".to_owned(), json!({"path": params.file}));
			arguments.insert(
				"breakpoint".to_owned(),
				json!({"line": params.line, "condition": params.condition}),
			);
		},
		Action::SetInstructionBreakpoint | Action::RemoveInstructionBreakpoint => {
			arguments.insert(
				"breakpoint".to_owned(),
				json!({"instructionReference": params.instruction_reference, "offset": params.offset, "condition": params.condition, "hitCondition": params.hit_condition}),
			);
		},
		Action::SetDataBreakpoint | Action::RemoveDataBreakpoint => {
			arguments.insert(
				"breakpoint".to_owned(),
				json!({"dataId": params.data_id, "accessType": params.access_type, "condition": params.condition, "hitCondition": params.hit_condition}),
			);
		},
		Action::DataBreakpointInfo => {
			insert_str(&mut arguments, "name", params.name.as_ref());
		},
		Action::Disassemble => {
			insert(&mut arguments, "instructionOffset", params.instruction_offset);
			insert(&mut arguments, "instructionCount", params.instruction_count);
			insert(&mut arguments, "resolveSymbols", params.resolve_symbols);
		},
		Action::ReadMemory => {
			insert(&mut arguments, "count", params.count);
		},
		Action::WriteMemory => {
			insert(&mut arguments, "allowPartial", params.allow_partial);
		},
		Action::StackTrace => {
			insert(&mut arguments, "startFrame", Some(0_u32));
			insert(&mut arguments, "levels", params.levels);
		},
		Action::Modules => {
			insert(&mut arguments, "startModule", params.start_module);
			insert(&mut arguments, "moduleCount", params.module_count);
		},
		Action::CustomRequest => {
			insert_str(&mut arguments, "command", params.command.as_ref());
			let custom = params.arguments.as_ref().map_or_else(
				|| Value::Object(Map::new()),
				|values| {
					Value::Object(
						values
							.iter()
							.map(|(key, value)| (key.as_str().to_owned(), value.clone()))
							.collect(),
					)
				},
			);
			arguments.insert("arguments".to_owned(), custom);
		},
		_ => {},
	}
	Value::Object(arguments)
}

fn insert<T: serde::Serialize>(map: &mut Map<String, Value>, key: &str, value: Option<T>) {
	if let Some(value) = value {
		map.insert(key.to_owned(), json!(value));
	}
}

fn insert_str(map: &mut Map<String, Value>, key: &str, value: Option<&Str>) {
	if let Some(value) = value {
		map.insert(key.to_owned(), json!(value));
	}
}

fn merge_events(data: &mut Value, events: Vec<DapRegistryEvent>) {
	let mut lifecycle = Vec::new();
	let mut output = Vec::new();
	for event in events {
		match event {
			DapRegistryEvent::Output(event) => output.extend_from_slice(&event.output),
			DapRegistryEvent::Event(event) => lifecycle.push(json!({
				"sequence": event.sequence,
				"event": event.event,
				"body": serde_json::from_slice::<Value>(&event.body_json).unwrap_or(Value::Null),
			})),
		}
	}
	if !lifecycle.is_empty() {
		data["events"] = Value::Array(lifecycle);
	}
	if !output.is_empty() {
		data["output"] = Value::String(String::from_utf8_lossy(&output).into_owned());
	}
}

fn map_document_error(error: DocumentError) -> Fault {
	match error {
		DocumentError::Cancelled => Fault::Cancelled,
		DocumentError::Disconnected => Fault::Unavailable,
		DocumentError::Protocol { code, .. } => match pb::ProtocolErrorCode::try_from(code).ok() {
			Some(pb::ProtocolErrorCode::PermissionDenied) => Fault::Unauthorized,
			Some(
				pb::ProtocolErrorCode::RevisionExpired
				| pb::ProtocolErrorCode::PreconditionFailed
				| pb::ProtocolErrorCode::ContentModified,
			) => Fault::Stale,
			Some(pb::ProtocolErrorCode::NotFound) => Fault::Unavailable,
			Some(pb::ProtocolErrorCode::Cancelled) => Fault::Cancelled,
			_ => Fault::Adapter,
		},
		DocumentError::Wire(_) | DocumentError::MalformedResponse(_) => Fault::Adapter,
	}
}
