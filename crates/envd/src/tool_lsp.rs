//! Production bridge from `lsp@3` to the project document authority.

use std::{
	collections::HashMap,
	fs,
	future::Future,
	path::{Component, Path, PathBuf},
	str,
	sync::Arc,
	time::Duration,
};

use bytes::Bytes;
use globset::Glob;
use omp_core::Str;
use omp_proto::{
	document::v1::{
		self as pb, commit_transaction_response, document_mutation, lsp_response, text_mutation,
	},
	env::v1::{self as env_pb, OutputChannel},
	lsp::PositionEncoding,
};
use omp_tools::lsp::{
	Action, Fault, LspControl, Params, Payload, WorkspaceSymbolOutcome, actions,
	aggregate_workspace_symbols,
	checkers::{self, CheckerExecutor, CheckerFault, CheckerOutput, CheckerRequest, Preset},
	diagnostics::{DiagnosticResult, MAX_GLOB_TARGETS, render as render_diagnostics},
	navigation, refactor, render,
};
use parking_lot::Mutex;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;
use url::Url;

use super::{
	docs::{DocumentError, DocumentHost, lease_target},
	exec::{ExecEvent, ExecHost},
	tool_document::{read_whole, transaction_id},
};
use crate::docserver::{
	diagnostics::parse_pull,
	position::{TextEdit, apply_text_edits},
};

const CHECKER_CAPTURE_BYTES: usize = 8 * 1024 * 1024;

#[derive(Clone)]
struct ExecChecker {
	host:     ExecHost,
	sessions: Arc<Mutex<HashMap<PathBuf, Bytes>>>,
}

impl CheckerExecutor for ExecChecker {
	fn run(
		&self,
		request: CheckerRequest,
		cancel: CancellationToken,
	) -> impl Future<Output = Result<CheckerOutput, CheckerFault>> + Send + '_ {
		async move {
			let cwd_uri =
				Url::from_directory_path(&request.cwd).map_err(|()| CheckerFault::LaunchFailed)?;
			let cached_session = { self.sessions.lock().get(&request.cwd).cloned() };
			let session = if let Some(session) = cached_session {
				session
			} else {
				let opened = self
					.host
					.open_session(env_pb::OpenSessionRequest {
						cwd_uri: cwd_uri.to_string(),
						..Default::default()
					})
					.await
					.map_err(|_| CheckerFault::LaunchFailed)?;
				self
					.sessions
					.lock()
					.insert(request.cwd.clone(), opened.session.clone());
				opened.session
			};
			let command = checker_command(&request);
			let execution = self
				.host
				.exec(
					env_pb::ExecRequest {
						session: session.clone(),
						source: Some(env_pb::Script { text: command, ..Default::default() }),
						..Default::default()
					},
					Some(Duration::from_secs(300)),
				)
				.await;
			let (_, run) = match execution {
				Ok(execution) => execution,
				Err(_) => {
					self.sessions.lock().remove(&request.cwd);
					let _ = self.host.close_session(&session);
					return Err(CheckerFault::LaunchFailed);
				},
			};
			let mut stdout = Vec::new();
			let mut stderr = Vec::new();
			let mut cancelled = false;
			let status = loop {
				let event = if cancelled {
					run.next_event().await
				} else {
					tokio::select! {
						biased;
						() = cancel.cancelled() => {
							run.cancel();
							cancelled = true;
							continue;
						},
						event = run.next_event() => event,
					}
				};
				match event {
					Some(ExecEvent::Output(frame)) if frame.channel == OutputChannel::Stdout as i32 => {
						append_checker_bytes(&mut stdout, &frame.data);
					},
					Some(ExecEvent::Output(frame)) if frame.channel == OutputChannel::Stderr as i32 => {
						append_checker_bytes(&mut stderr, &frame.data);
					},
					Some(ExecEvent::Exit(exit)) => break exit.status,
					Some(ExecEvent::Started { .. } | ExecEvent::Output(_)) => {},
					None => break None,
				}
			};
			let status = status.ok_or(CheckerFault::LaunchFailed)?;
			if cancelled || status.outcome == env_pb::ExecOutcome::Cancelled as i32 {
				return Err(CheckerFault::Cancelled);
			}
			if status.outcome == env_pb::ExecOutcome::Timeout as i32 {
				return Err(CheckerFault::TimedOut);
			}
			Ok(CheckerOutput {
				status: status.exit_code,
				stdout: checker_output(&stdout),
				stderr: checker_output(&stderr),
			})
		}
	}
}

fn checker_command(request: &CheckerRequest) -> String {
	let mut command = shell_quote(request.program.as_str());
	for argument in &request.args {
		command.push(' ');
		command.push_str(&shell_quote(argument.as_str()));
	}
	command
}

fn document_error_detail(error: DocumentError) -> Str {
	match error {
		DocumentError::Wire(_) => Str::new_static("document transport failed"),
		DocumentError::Disconnected => Str::new_static("document server disconnected"),
		DocumentError::Cancelled => Str::new_static("document request was cancelled"),
		DocumentError::Protocol { code, message } => {
			Str::from(format!("document server error {code}: {message}"))
		},
		DocumentError::MalformedResponse(message) => message,
	}
}

fn shell_quote(value: &str) -> String {
	format!("'{}'", value.replace('\'', "'\\''"))
}

fn append_checker_bytes(output: &mut Vec<u8>, bytes: &[u8]) {
	let remaining = CHECKER_CAPTURE_BYTES.saturating_sub(output.len());
	output.extend_from_slice(&bytes[..bytes.len().min(remaining)]);
}

fn checker_output(bytes: &[u8]) -> Str {
	Str::from(String::from_utf8_lossy(bytes).as_ref())
}

fn merge_workspace_edits(edits: &[Value], renamed: Option<(&str, &str)>) -> Result<Value, Fault> {
	let mut changes = serde_json::Map::<String, Value>::new();
	for edit in edits {
		if let Some(entries) = edit.get("changes").and_then(Value::as_object) {
			for (uri, value) in entries {
				append_text_edits(&mut changes, rewrite_uri(uri, renamed), value)?;
			}
		}
		for change in edit
			.get("documentChanges")
			.and_then(Value::as_array)
			.into_iter()
			.flatten()
		{
			if change.get("kind").is_some() {
				return Err(Fault::WorkspaceEdit);
			}
			let uri = change
				.pointer("/textDocument/uri")
				.and_then(Value::as_str)
				.ok_or(Fault::WorkspaceEdit)?;
			let value = change.get("edits").ok_or(Fault::WorkspaceEdit)?;
			append_text_edits(&mut changes, rewrite_uri(uri, renamed), value)?;
		}
	}
	let merged = json!({ "changes": changes });
	refactor::validate_workspace_edit(&merged).map_err(|_| Fault::WorkspaceEdit)?;
	Ok(merged)
}

fn append_text_edits(
	changes: &mut serde_json::Map<String, Value>,
	uri: String,
	edits: &Value,
) -> Result<(), Fault> {
	let incoming = edits.as_array().ok_or(Fault::WorkspaceEdit)?;
	let entry = changes
		.entry(uri)
		.or_insert_with(|| Value::Array(Vec::new()))
		.as_array_mut()
		.ok_or(Fault::WorkspaceEdit)?;
	entry.extend(incoming.iter().cloned());
	Ok(())
}

fn rewrite_uri(uri: &str, renamed: Option<(&str, &str)>) -> String {
	let Some((source, destination)) = renamed else {
		return uri.to_owned();
	};
	if uri == source {
		return destination.to_owned();
	}
	uri.strip_prefix(source)
		.filter(|suffix| suffix.starts_with('/'))
		.map_or_else(|| uri.to_owned(), |suffix| format!("{destination}{suffix}"))
}

fn resolve_diagnostic_targets(
	root: &Path,
	pattern: &str,
	cancel: Option<&CancellationToken>,
) -> Result<(Vec<String>, bool), Fault> {
	const MAX_ENTRIES: usize = 100_000;
	if !pattern
		.bytes()
		.any(|byte| matches!(byte, b'*' | b'?' | b'[' | b'{'))
	{
		return Ok((vec![pattern.to_owned()], false));
	}
	let matcher = Glob::new(pattern)
		.map_err(|_| Fault::InvalidArguments)?
		.compile_matcher();
	let mut directories = vec![root.to_path_buf()];
	let mut targets = Vec::new();
	let mut visited = 0_usize;
	let mut truncated = false;
	while let Some(directory) = directories.pop() {
		for entry in fs::read_dir(directory).map_err(|_| Fault::WorkspaceEdit)? {
			if cancel.is_some_and(CancellationToken::is_cancelled) {
				return Err(Fault::Cancelled);
			}
			let entry = entry.map_err(|_| Fault::WorkspaceEdit)?;
			visited = visited.saturating_add(1);
			if visited > MAX_ENTRIES {
				truncated = true;
				break;
			}
			let file_type = entry.file_type().map_err(|_| Fault::WorkspaceEdit)?;
			if file_type.is_symlink() {
				continue;
			}
			let path = entry.path();
			if file_type.is_dir() {
				if !matches!(
					path.file_name().and_then(|name| name.to_str()),
					Some(".git" | "node_modules")
				) {
					directories.push(path);
				}
			} else if file_type.is_file() {
				let relative = path.strip_prefix(root).map_err(|_| Fault::WorkspaceEdit)?;
				if matcher.is_match(relative) {
					targets.push(relative.to_string_lossy().replace('\\', "/"));
				}
			}
		}
		if visited > MAX_ENTRIES {
			break;
		}
	}
	targets.sort();
	if targets.len() > MAX_GLOB_TARGETS {
		targets.truncate(MAX_GLOB_TARGETS);
		truncated = true;
	}
	Ok((targets, truncated))
}

fn enumerate_directory_rename_pairs(
	source: &Path,
	destination: &Path,
	cancel: Option<&CancellationToken>,
) -> Result<Vec<(String, String)>, Fault> {
	const MAX_RENAME_PAIRS: usize = 1_000;
	let mut directories = vec![source.to_path_buf()];
	let mut pairs = Vec::new();
	while let Some(directory) = directories.pop() {
		let entries = fs::read_dir(&directory).map_err(|_| Fault::WorkspaceEdit)?;
		for entry in entries {
			if cancel.is_some_and(CancellationToken::is_cancelled) {
				return Err(Fault::Cancelled);
			}
			let entry = entry.map_err(|_| Fault::WorkspaceEdit)?;
			let file_type = entry.file_type().map_err(|_| Fault::WorkspaceEdit)?;
			if file_type.is_symlink() {
				continue;
			}
			let path = entry.path();
			if file_type.is_dir() {
				directories.push(path);
				continue;
			}
			if !file_type.is_file() {
				continue;
			}
			if pairs.len() == MAX_RENAME_PAIRS {
				return Err(Fault::WorkspaceEdit);
			}
			let relative = path
				.strip_prefix(source)
				.map_err(|_| Fault::WorkspaceEdit)?;
			let next = destination.join(relative);
			let old_uri = Url::from_file_path(&path).map_err(|()| Fault::WorkspaceEdit)?;
			let new_uri = Url::from_file_path(next).map_err(|()| Fault::WorkspaceEdit)?;
			pairs.push((old_uri.to_string(), new_uri.to_string()));
		}
	}
	pairs.sort();
	Ok(pairs)
}
fn reload_notification(binding: &pb::LspServerBinding) -> pb::LspNotificationRequest {
	pb::LspNotificationRequest {
		server_id:   binding.server_id.clone(),
		method:      "workspace/didChangeConfiguration".into(),
		params_json: binding.settings_json.clone(),
	}
}

fn parse_request_payload(payload: Option<&str>) -> Result<Value, Fault> {
	payload
		.map(serde_json::from_str)
		.transpose()
		.map_err(|_| Fault::InvalidArguments)
		.map(|value| value.unwrap_or_else(|| json!({})))
}

fn render_raw_response(server: &str, method: &str, data: &Value) -> Result<Str, Fault> {
	let body = match data {
		Value::String(text) => text.clone(),
		Value::Null => String::from("null"),
		_ => serde_json::to_string_pretty(data).map_err(|_| Fault::Server)?,
	};
	Ok(Str::from(format!("{server} \u{2190} {method}:\n{body}")))
}

/// Environment-owned implementation of the revisioned LSP tool.
#[derive(Clone)]
pub struct DocumentLspControl {
	documents: DocumentHost,
	checker:   ExecChecker,
}

impl DocumentLspControl {
	/// Binds the project document authority.
	pub fn new(documents: DocumentHost, exec: ExecHost) -> Self {
		Self {
			documents,
			checker: ExecChecker { host: exec, sessions: Arc::new(Mutex::new(HashMap::new())) },
		}
	}

	fn file_uri(&self, file: &str) -> Result<Url, Fault> {
		let mut root = Url::parse(self.documents.hello().root_uri.as_str())
			.map_err(|_| Fault::InvalidArguments)?;
		if file == "*" {
			return Ok(root);
		}
		let path = Path::new(file);
		if path.is_absolute()
			|| path.components().any(|component| {
				matches!(component, Component::ParentDir | Component::RootDir | Component::Prefix(_))
			}) {
			return Err(Fault::InvalidArguments);
		}
		root
			.path_segments_mut()
			.map_err(|_| Fault::InvalidArguments)?
			.pop_if_empty()
			.extend(path.components().filter_map(|component| match component {
				Component::Normal(value) => value.to_str(),
				Component::CurDir => None,
				_ => None,
			}));
		Ok(root)
	}

	async fn apply_workspace_edit(
		&self,
		edit: &Value,
		encoding: PositionEncoding,
		cancel: &CancellationToken,
	) -> Result<usize, Fault> {
		let changes = edit
			.get("changes")
			.and_then(Value::as_object)
			.ok_or(Fault::WorkspaceEdit)?;
		if changes.is_empty() {
			return Ok(0);
		}
		let mut operations = Vec::with_capacity(changes.len());
		for (uri, edits) in changes {
			let lease = self
				.documents
				.open(Str::from(uri.as_str()), None, cancel)
				.await
				.map_err(|_| Fault::WorkspaceEdit)?;
			let content = read_whole(&self.documents, &lease)
				.await
				.map_err(|_| Fault::WorkspaceEdit)?;
			let text = str::from_utf8(&content).map_err(|_| Fault::WorkspaceEdit)?;
			let edits = serde_json::from_value::<Vec<TextEdit>>(edits.clone())
				.map_err(|_| Fault::WorkspaceEdit)?;
			let content =
				apply_text_edits(text, &edits, encoding).map_err(|_| Fault::WorkspaceEdit)?;
			operations.push(pb::DocumentMutation {
				document:  Some(lease_target(&lease)),
				operation: Some(document_mutation::Operation::Text(pb::TextMutation {
					base_revision: lease.head().revision.clone(),
					change:        Some(text_mutation::Change::ProposedContent(content)),
					stale_policy:  pb::StalePolicy::Fail as i32,
					format_policy: pb::FormatPolicy::BestEffort as i32,
				})),
			});
		}
		let response = self
			.documents
			.commit_transaction(
				transaction_id(self.documents.hello().server_epoch.as_ref()),
				operations,
				cancel,
			)
			.await
			.map_err(|_| Fault::WorkspaceEdit)?;
		match response.outcome {
			Some(commit_transaction_response::Outcome::Committed(committed)) => {
				Ok(committed.operations.len())
			},
			_ => Err(Fault::WorkspaceEdit),
		}
	}

	async fn diagnostics(
		&self,
		pattern: &str,
		cancel: &CancellationToken,
	) -> Result<Payload, Fault> {
		let root = Url::parse(self.documents.hello().root_uri.as_str())
			.map_err(|_| Fault::Unavailable)?
			.to_file_path()
			.map_err(|()| Fault::Unavailable)?;
		let authored_pattern = pattern.to_owned();
		let scan_pattern = authored_pattern.clone();
		let (targets, truncated) = {
			let cancel = cancel.clone();
			tokio::task::spawn_blocking(move || {
				resolve_diagnostic_targets(&root, &scan_pattern, Some(&cancel))
			})
		}
		.await
		.map_err(|_| Fault::Server)??;
		if targets.is_empty() {
			return Ok(Payload {
				action:  Action::Diagnostics,
				servers: Vec::new(),
				output:  Str::from(format!("No files matched pattern: {authored_pattern}")),
				data:    json!({"diagnostics": [], "complete": true, "truncatedTargets": false}),
				omitted: 0,
			});
		}
		let mut diagnostics = Vec::new();
		let mut servers = Vec::new();
		let mut complete = !truncated;
		for target in &targets {
			if cancel.is_cancelled() {
				return Err(Fault::Cancelled);
			}
			let uri = self.file_uri(target)?;
			let lease = self
				.documents
				.open(Str::from(uri.as_str()), None, cancel)
				.await
				.map_err(|_| Fault::Unavailable)?;
			let bindings = self
				.documents
				.get_lsp_bindings(
					pb::GetLspBindingsRequest { document: Some(lease_target(&lease)) },
					cancel,
				)
				.await
				.map_err(|_| Fault::Server)?
				.bindings;
			if bindings.is_empty() {
				complete = false;
				continue;
			}
			for binding in bindings {
				let request = json!({"textDocument": {"uri": uri.as_str()}});
				let response = self
					.documents
					.lsp_request(
						pb::LspRequest {
							server_id:    binding.server_id.clone(),
							method:       "textDocument/diagnostic".into(),
							params_json:  Bytes::from(
								serde_json::to_vec(&request).map_err(|_| Fault::InvalidArguments)?,
							),
							document:     Some(lease_target(&lease)),
							revision:     lease.head().revision.clone(),
							stale_policy: pb::LspStalePolicy::Fail as i32,
						},
						cancel,
					)
					.await;
				let Ok(response) = response else {
					complete = false;
					continue;
				};
				let Some(lsp_response::Outcome::ResultJson(bytes)) = response.outcome else {
					complete = false;
					continue;
				};
				match parse_pull(Str::from(uri.as_str()), &bytes, binding.name.as_str()) {
					Ok(Some(mut findings)) => {
						servers.push(Str::from(binding.name.as_str()));
						diagnostics.append(&mut findings);
					},
					Ok(None) | Err(_) => complete = false,
				}
			}
		}
		servers.sort();
		servers.dedup();
		let result = DiagnosticResult::new(diagnostics, complete);
		let output = render_diagnostics(&result);
		let data = json!({
			"targets": targets,
			"truncatedTargets": truncated,
			"diagnostics": result.diagnostics,
			"omitted": result.omitted,
			"complete": result.complete,
		});
		Ok(Payload { action: Action::Diagnostics, servers, output, data, omitted: result.omitted })
	}

	async fn rename_directory(
		&self,
		source: Url,
		destination: Url,
		apply: Option<bool>,
		cancel: &CancellationToken,
	) -> Result<Payload, Fault> {
		let source_path = source.to_file_path().map_err(|()| Fault::WorkspaceEdit)?;
		let destination_path = destination
			.to_file_path()
			.map_err(|()| Fault::WorkspaceEdit)?;
		let workspace_path = Url::parse(self.documents.hello().root_uri.as_str())
			.map_err(|_| Fault::WorkspaceEdit)?
			.to_file_path()
			.map_err(|()| Fault::WorkspaceEdit)?;
		let scan_cancel = cancel.clone();
		let pairs = tokio::task::spawn_blocking(move || {
			let workspace = fs::canonicalize(workspace_path).map_err(|_| Fault::WorkspaceEdit)?;
			let metadata = fs::symlink_metadata(&source_path).map_err(|_| Fault::WorkspaceEdit)?;
			if metadata.file_type().is_symlink() {
				return Err(Fault::WorkspaceEdit);
			}
			let canonical = fs::canonicalize(&source_path).map_err(|_| Fault::WorkspaceEdit)?;
			if !canonical.starts_with(&workspace) {
				return Err(Fault::WorkspaceEdit);
			}
			enumerate_directory_rename_pairs(&canonical, &destination_path, Some(&scan_cancel))
		})
		.await
		.map_err(|_| Fault::WorkspaceEdit)??;
		let params = json!({
			"files": pairs.iter().map(|(old_uri, new_uri)| {
				json!({ "oldUri": old_uri, "newUri": new_uri })
			}).collect::<Vec<_>>(),
		});
		let mut bindings = HashMap::<Vec<u8>, pb::LspServerBinding>::new();
		for (old_uri, _) in &pairs {
			if cancel.is_cancelled() {
				return Err(Fault::Cancelled);
			}
			let lease = self
				.documents
				.open(Str::from(old_uri.as_str()), None, cancel)
				.await
				.map_err(|_| Fault::WorkspaceEdit)?;
			for binding in self
				.documents
				.get_lsp_bindings(
					pb::GetLspBindingsRequest { document: Some(lease_target(&lease)) },
					cancel,
				)
				.await
				.map_err(|_| Fault::Server)?
				.bindings
			{
				bindings
					.entry(binding.server_id.to_vec())
					.or_insert(binding);
			}
		}
		let mut bindings = bindings.into_values().collect::<Vec<_>>();
		bindings.sort_by(|left, right| left.name.cmp(&right.name));
		let mut edits = Vec::new();
		for binding in &bindings {
			let response = self
				.documents
				.lsp_request(
					pb::LspRequest {
						server_id:    binding.server_id.clone(),
						method:       "workspace/willRenameFiles".into(),
						params_json:  Bytes::from(
							serde_json::to_vec(&params).map_err(|_| Fault::InvalidArguments)?,
						),
						document:     None,
						revision:     None,
						stale_policy: pb::LspStalePolicy::Fail as i32,
					},
					cancel,
				)
				.await
				.map_err(|_| Fault::Server)?;
			match response.outcome {
				Some(lsp_response::Outcome::ResultJson(bytes)) => {
					let edit: Value = serde_json::from_slice(&bytes).map_err(|_| Fault::Server)?;
					if !edit.is_null() {
						edits.push(edit);
					}
				},
				Some(lsp_response::Outcome::Error(error)) if error.code == -32_601 => {},
				Some(lsp_response::Outcome::Error(_)) | None => return Err(Fault::Server),
			}
		}
		let preview = merge_workspace_edits(&edits, None)?;
		let servers = bindings
			.iter()
			.map(|binding| Str::from(binding.name.as_str()))
			.collect::<Vec<_>>();
		let data = json!({
			"oldUri": source.as_str(),
			"newUri": destination.as_str(),
			"directory": true,
			"files": params["files"],
			"workspaceEdit": preview,
		});
		if apply == Some(false) {
			return Ok(Payload {
				action: Action::RenameFile,
				servers,
				output: Str::from(format!(
					"Rename preview: {} file(s) under {} -> {}",
					pairs.len(),
					source.path(),
					destination.path(),
				)),
				data,
				omitted: 0,
			});
		}
		self
			.documents
			.rename(
				pb::RenamePathRequest {
					source_uri:           source.to_string(),
					destination_uri:      destination.to_string(),
					overwrite:            pb::DestinationOverwritePolicy::FailIfExists as i32,
					source_revision:      None,
					destination_revision: None,
				},
				cancel,
			)
			.await
			.map_err(|_| Fault::WorkspaceEdit)?;
		let committed = merge_workspace_edits(&edits, Some((source.as_str(), destination.as_str())))?;
		let encoding = bindings
			.first()
			.and_then(|binding| binding.sync_policy.as_ref())
			.map(|policy| PositionEncoding::from_lsp_name(Some(&policy.position_encoding)))
			.unwrap_or_default();
		if !edits.is_empty()
			&& self
				.apply_workspace_edit(&committed, encoding, cancel)
				.await
				.is_err()
		{
			self
				.documents
				.rename(
					pb::RenamePathRequest {
						source_uri:           destination.to_string(),
						destination_uri:      source.to_string(),
						overwrite:            pb::DestinationOverwritePolicy::FailIfExists as i32,
						source_revision:      None,
						destination_revision: None,
					},
					cancel,
				)
				.await
				.map_err(|_| Fault::WorkspaceEdit)?;
			return Err(Fault::WorkspaceEdit);
		}
		for binding in &bindings {
			let _ = self
				.documents
				.lsp_notification(
					pb::LspNotificationRequest {
						server_id:   binding.server_id.clone(),
						method:      "workspace/didRenameFiles".into(),
						params_json: Bytes::from(
							serde_json::to_vec(&params).map_err(|_| Fault::InvalidArguments)?,
						),
					},
					cancel,
				)
				.await;
		}
		Ok(Payload {
			action: Action::RenameFile,
			servers,
			output: Str::from(format!(
				"Renamed {} file(s) under {} to {} with import updates",
				pairs.len(),
				source.path(),
				destination.path(),
			)),
			data,
			omitted: 0,
		})
	}

	async fn workspace_symbols(
		&self,
		query: &str,
		cancel: &CancellationToken,
	) -> Result<Payload, Fault> {
		let roster = self
			.documents
			.lsp_status(pb::LspStatusRequest { reload: false, start: true }, cancel)
			.await
			.map_err(|_| Fault::Server)?;
		let selected = roster.servers;
		if selected.is_empty() {
			return Err(Fault::Unavailable);
		}
		let params_json = Bytes::from(
			serde_json::to_vec(&json!({ "query": query })).map_err(|_| Fault::InvalidArguments)?,
		);
		let mut outcomes = Vec::with_capacity(selected.len());
		for status in selected {
			let result = if status.server_id.is_empty() {
				let detail = if status.detail.is_empty() {
					Str::from(format!("server is {}", lsp_stage_name(status.stage)))
				} else {
					Str::from(status.detail)
				};
				Err(detail)
			} else {
				match self
					.documents
					.lsp_request(
						pb::LspRequest {
							server_id:    status.server_id,
							method:       "workspace/symbol".into(),
							params_json:  params_json.clone(),
							document:     None,
							revision:     None,
							stale_policy: pb::LspStalePolicy::Fail as i32,
						},
						cancel,
					)
					.await
				{
					Ok(response) => match response.outcome {
						Some(lsp_response::Outcome::ResultJson(bytes)) => serde_json::from_slice(&bytes)
							.map_err(|_| Str::new_static("server returned invalid JSON")),
						Some(lsp_response::Outcome::Error(error)) => {
							if error.message.is_empty() {
								Err(Str::from(format!("server returned LSP error {}", error.code)))
							} else {
								Err(Str::from(error.message))
							}
						},
						None => Err(Str::new_static("server returned no response")),
					},
					Err(error) => Err(document_error_detail(error)),
				}
			};
			outcomes.push(WorkspaceSymbolOutcome { server: Str::from(status.name), result });
		}
		aggregate_workspace_symbols(query, outcomes)
	}

	async fn workspace_request(
		&self,
		method: &str,
		payload: Option<&str>,
		cancel: &CancellationToken,
	) -> Result<Payload, Fault> {
		let params = parse_request_payload(payload)?;
		let roster = self
			.documents
			.lsp_status(pb::LspStatusRequest { reload: false, start: true }, cancel)
			.await
			.map_err(|_| Fault::Server)?;
		let server = roster
			.servers
			.into_iter()
			.find(|server| !server.server_id.is_empty())
			.ok_or(Fault::Unavailable)?;
		let response = self
			.documents
			.lsp_request(
				pb::LspRequest {
					server_id:    server.server_id,
					method:       method.into(),
					params_json:  Bytes::from(
						serde_json::to_vec(&params).map_err(|_| Fault::InvalidArguments)?,
					),
					document:     None,
					revision:     None,
					stale_policy: pb::LspStalePolicy::Fail as i32,
				},
				cancel,
			)
			.await
			.map_err(|_| Fault::Server)?;
		let data = match response.outcome {
			Some(lsp_response::Outcome::ResultJson(bytes)) => {
				serde_json::from_slice(&bytes).map_err(|_| Fault::Server)?
			},
			Some(lsp_response::Outcome::Error(_)) | None => return Err(Fault::Server),
		};
		let output = render_raw_response(&server.name, method, &data)?;
		Ok(Payload {
			action: Action::Request,
			servers: vec![Str::from(server.name)],
			output,
			data,
			omitted: 0,
		})
	}

	async fn workspace_diagnostics(&self, cancel: &CancellationToken) -> Result<Payload, Fault> {
		let root = Url::parse(self.documents.hello().root_uri.as_str())
			.map_err(|_| Fault::Unavailable)?
			.to_file_path()
			.map_err(|()| Fault::Unavailable)?;
		let candidates: &[(Preset, &[&str])] = &[
			(Preset::Cargo, &["Cargo.toml"]),
			(Preset::TypeScript, &["tsconfig.json", "tsconfig.base.json"]),
			(Preset::Go, &["go.work", "go.mod"]),
			(Preset::Pyright, &["pyproject.toml", "pyrightconfig.json"]),
			(Preset::Biome, &["biome.json", "biome.jsonc"]),
			(Preset::SwiftLint, &[".swiftlint.yml", "Package.swift"]),
		];
		let mut diagnostics = Vec::new();
		let mut servers = Vec::new();
		let mut failures = Vec::new();
		for (preset, markers) in candidates {
			if !markers.iter().any(|marker| root.join(marker).is_file()) {
				continue;
			}
			servers.push(Str::from(preset.to_string()));
			let request = checkers::request(*preset, &root, None);
			match self.checker.run(request, cancel.child_token()).await {
				Ok(output) => match checkers::parse_output(*preset, &output) {
					Ok(mut findings) => diagnostics.append(&mut findings),
					Err(error) => failures.push(Str::from(error.to_string())),
				},
				Err(error) => failures.push(Str::from(error.to_string())),
			}
		}
		let result = DiagnosticResult::new(diagnostics, failures.is_empty());
		let output = render_diagnostics(&result);
		let data = json!({
			"diagnostics": result.diagnostics,
			"omitted": result.omitted,
			"complete": result.complete,
			"failures": failures,
		});
		Ok(Payload { action: Action::Diagnostics, servers, output, data, omitted: result.omitted })
	}
}

fn lsp_roster_payload(action: Action, roster: pb::LspStatusResponse, workspace: &str) -> Payload {
	let servers = roster
		.servers
		.iter()
		.map(|server| Str::from(server.name.as_str()))
		.collect();
	let entries = roster
		.servers
		.iter()
		.map(|server| {
			let stage = lsp_stage_name(server.stage);
			json!({
				"name": server.name,
				"stage": stage,
				"fileTypes": server.file_types,
				"detail": server.detail,
				"source": server.source,
			})
		})
		.collect::<Vec<_>>();
	let lines = roster
		.servers
		.iter()
		.map(|server| {
			let stage = lsp_stage_name(server.stage);
			let mut line = format!("{}: {stage} ({})", server.name, server.file_types.join(", "));
			if stage == "failed" && !server.detail.is_empty() {
				line.push_str(": ");
				line.push_str(&server.detail);
			}
			line
		})
		.collect::<Vec<_>>();
	let output = if lines.is_empty() {
		Str::new_static("No native language servers discovered")
	} else {
		Str::from(lines.join("\n"))
	};
	Payload {
		action,
		servers,
		output,
		data: json!({ "workspace": workspace, "servers": entries }),
		omitted: 0,
	}
}

fn lsp_capabilities_payload(roster: pb::LspStatusResponse) -> Result<Payload, Fault> {
	let mut servers = Vec::new();
	let mut capabilities = Vec::new();
	for server in roster.servers {
		if server.server_id.is_empty() || server.capabilities_json.is_empty() {
			continue;
		}
		let value: Value =
			serde_json::from_slice(&server.capabilities_json).map_err(|_| Fault::Server)?;
		servers.push(Str::from(server.name.as_str()));
		capabilities.push(json!({"name": server.name, "capabilities": value}));
	}
	if servers.is_empty() {
		return Err(Fault::Unavailable);
	}
	let data = Value::Array(capabilities);
	Ok(Payload {
		action: Action::Capabilities,
		servers,
		output: Str::from(serde_json::to_string_pretty(&data).map_err(|_| Fault::Server)?),
		data,
		omitted: 0,
	})
}

fn lsp_stage_name(stage: i32) -> &'static str {
	match pb::LspServerStage::try_from(stage) {
		Ok(pb::LspServerStage::Available) => "available",
		Ok(pb::LspServerStage::Starting) => "starting",
		Ok(pb::LspServerStage::Indexing) => "indexing",
		Ok(pb::LspServerStage::Ready) => "ready",
		Ok(pb::LspServerStage::Failed) => "failed",
		Ok(pb::LspServerStage::Unspecified) | Err(_) => "unspecified",
	}
}

impl LspControl for DocumentLspControl {
	fn execute(
		&self,
		params: Params,
		_timeout: Duration,
		cancel: CancellationToken,
	) -> impl Future<Output = Result<Payload, Fault>> + Send + '_ {
		async move {
			let file = params.file.as_deref().unwrap_or("*");
			let uri = self.file_uri(file)?;
			if file == "*" {
				if params.action == Action::Diagnostics {
					return self.workspace_diagnostics(&cancel).await;
				}
				if params.action == Action::Symbols {
					return self
						.workspace_symbols(
							params.query.as_deref().ok_or(Fault::InvalidArguments)?,
							&cancel,
						)
						.await;
				}
				if params.action == Action::Request {
					return self
						.workspace_request(
							params.query.as_deref().ok_or(Fault::InvalidArguments)?,
							params.payload.as_deref(),
							&cancel,
						)
						.await;
				}
				if params.action == Action::Capabilities {
					let roster = self
						.documents
						.lsp_status(pb::LspStatusRequest { reload: false, start: true }, &cancel)
						.await
						.map_err(|_| Fault::Server)?;
					return lsp_capabilities_payload(roster);
				}
				if matches!(params.action, Action::Status | Action::Reload) {
					let roster = self
						.documents
						.lsp_status(
							pb::LspStatusRequest {
								reload: params.action == Action::Reload,
								start:  params.action == Action::Reload,
							},
							&cancel,
						)
						.await
						.map_err(|_| Fault::Server)?;
					return Ok(lsp_roster_payload(
						params.action,
						roster,
						self.documents.hello().root_uri.as_str(),
					));
				}
				return Err(Fault::InvalidArguments);
			}
			if params.action == Action::Diagnostics {
				return self.diagnostics(file, &cancel).await;
			}
			if params.action == Action::RenameFile
				&& uri.to_file_path().is_ok_and(|path| path.is_dir())
			{
				let destination =
					self.file_uri(params.new_name.as_deref().ok_or(Fault::InvalidArguments)?)?;
				return self
					.rename_directory(uri, destination, params.apply, &cancel)
					.await;
			}
			let lease = self
				.documents
				.open(Str::from(uri.as_str()), None, &cancel)
				.await
				.map_err(|_| Fault::Unavailable)?;
			let bindings = self
				.documents
				.get_lsp_bindings(
					pb::GetLspBindingsRequest { document: Some(lease_target(&lease)) },
					&cancel,
				)
				.await
				.map_err(|_| Fault::Server)?
				.bindings;
			let mut selected = bindings;
			if !matches!(
				params.action,
				Action::Diagnostics | Action::RenameFile | Action::Capabilities
			) {
				// The registry is priority ordered. Semantic navigation, refactors,
				// and raw requests use the primary type-aware server; only diagnostics,
				// capabilities, and file-rename notifications fan out to every binding.
				selected.truncate(1);
			}
			if selected.is_empty() {
				return Err(Fault::Unavailable);
			}
			let servers = selected
				.iter()
				.map(|binding| Str::from(binding.name.as_str()))
				.collect::<Vec<_>>();
			if params.action == Action::Reload {
				for binding in &selected {
					self
						.documents
						.lsp_notification(reload_notification(binding), &cancel)
						.await
						.map_err(|_| Fault::Server)?;
					if binding.name.contains("rust-analyzer") {
						let _ = self
							.documents
							.lsp_request(
								pb::LspRequest {
									server_id:    binding.server_id.clone(),
									method:       "rust-analyzer/reloadWorkspace".into(),
									params_json:  Bytes::from_static(b"{}"),
									document:     Some(lease_target(&lease)),
									revision:     lease.head().revision.clone(),
									stale_policy: pb::LspStalePolicy::Fail as i32,
								},
								&cancel,
							)
							.await;
					}
				}
				return Ok(Payload {
					action: params.action,
					servers,
					output: Str::new_static("Reloaded selected language-server configuration"),
					data: json!({ "reloaded": true }),
					omitted: 0,
				});
			}
			if params.action == Action::RenameFile {
				let destination =
					self.file_uri(params.new_name.as_deref().ok_or(Fault::InvalidArguments)?)?;
				let rename_params = json!({
					"files": [{ "oldUri": uri.as_str(), "newUri": destination.as_str() }],
				});
				let mut edits = Vec::new();
				for binding in &selected {
					let response = self
						.documents
						.lsp_request(
							pb::LspRequest {
								server_id:    binding.server_id.clone(),
								method:       "workspace/willRenameFiles".into(),
								params_json:  Bytes::from(
									serde_json::to_vec(&rename_params)
										.map_err(|_| Fault::InvalidArguments)?,
								),
								document:     Some(lease_target(&lease)),
								revision:     lease.head().revision.clone(),
								stale_policy: pb::LspStalePolicy::Fail as i32,
							},
							&cancel,
						)
						.await
						.map_err(|_| Fault::Server)?;
					match response.outcome {
						Some(lsp_response::Outcome::ResultJson(bytes)) => {
							let edit: Value = serde_json::from_slice(&bytes).map_err(|_| Fault::Server)?;
							if !edit.is_null() {
								edits.push(edit);
							}
						},
						Some(lsp_response::Outcome::Error(error)) if error.code == -32_601 => {},
						Some(lsp_response::Outcome::Error(_)) | None => return Err(Fault::Server),
					}
				}
				let preview_edit = merge_workspace_edits(&edits, None)?;
				let data = json!({
					"oldUri": uri.as_str(),
					"newUri": destination.as_str(),
					"workspaceEdit": preview_edit,
				});
				if params.apply == Some(false) {
					return Ok(Payload {
						action: params.action,
						servers,
						output: refactor::preview(&preview_edit),
						data,
						omitted: 0,
					});
				}
				let source_revision = lease.head().revision.clone();
				self
					.documents
					.rename(
						pb::RenamePathRequest {
							source_uri: uri.to_string(),
							destination_uri: destination.to_string(),
							overwrite: pb::DestinationOverwritePolicy::FailIfExists as i32,
							source_revision,
							destination_revision: None,
						},
						&cancel,
					)
					.await
					.map_err(|_| Fault::WorkspaceEdit)?;
				let committed_edit =
					merge_workspace_edits(&edits, Some((uri.as_str(), destination.as_str())))?;
				let encoding = selected
					.first()
					.and_then(|binding| binding.sync_policy.as_ref())
					.map(|policy| PositionEncoding::from_lsp_name(Some(&policy.position_encoding)))
					.unwrap_or_default();
				if !edits.is_empty()
					&& self
						.apply_workspace_edit(&committed_edit, encoding, &cancel)
						.await
						.is_err()
				{
					let rollback = self
						.documents
						.open(Str::from(destination.as_str()), None, &cancel)
						.await
						.map_err(|_| Fault::WorkspaceEdit)?;
					self
						.documents
						.rename(
							pb::RenamePathRequest {
								source_uri:           destination.to_string(),
								destination_uri:      uri.to_string(),
								overwrite:            pb::DestinationOverwritePolicy::FailIfExists as i32,
								source_revision:      rollback.head().revision.clone(),
								destination_revision: None,
							},
							&cancel,
						)
						.await
						.map_err(|_| Fault::WorkspaceEdit)?;
					return Err(Fault::WorkspaceEdit);
				}
				for binding in &selected {
					let _ = self
						.documents
						.lsp_notification(
							pb::LspNotificationRequest {
								server_id:   binding.server_id.clone(),
								method:      "workspace/didRenameFiles".into(),
								params_json: Bytes::from(
									serde_json::to_vec(&rename_params)
										.map_err(|_| Fault::InvalidArguments)?,
								),
							},
							&cancel,
						)
						.await;
				}
				return Ok(Payload {
					action: params.action,
					servers,
					output: Str::from(format!(
						"Renamed {} to {} with import updates",
						uri.path(),
						destination.path(),
					)),
					data,
					omitted: 0,
				});
			}
			if params.action == Action::Status {
				let data = Value::Array(selected.iter().map(|binding| json!({ "name": binding.name, "state": "ready", "position_encoding": binding.sync_policy.as_ref().map(|policy| policy.position_encoding.as_str()) })).collect());
				return Ok(Payload {
					action: params.action,
					servers,
					output: render::structured(&data, usize::MAX),
					data,
					omitted: 0,
				});
			}
			if params.action == Action::Capabilities {
				let data = Value::Array(
					selected
						.iter()
						.map(|binding| {
							serde_json::from_slice(&binding.capabilities_json).unwrap_or(Value::Null)
						})
						.collect(),
				);
				return Ok(Payload {
					action: params.action,
					servers,
					output: Str::from(serde_json::to_string_pretty(&data).unwrap_or_default()),
					data,
					omitted: 0,
				});
			}
			let content = read_whole(&self.documents, &lease)
				.await
				.map_err(|_| Fault::Server)?;
			let line = params.line.unwrap_or(1);
			let symbol_target = params
				.symbol
				.as_ref()
				.map(|symbol| navigation::parse_symbol_target(symbol))
				.transpose()
				.map_err(|_| Fault::InvalidArguments)?;
			let source_line = if symbol_target.is_some() {
				let text = str::from_utf8(&content).map_err(|_| Fault::InvalidArguments)?;
				Some(
					text
						.lines()
						.nth(line.saturating_sub(1) as usize)
						.ok_or(Fault::InvalidArguments)?,
				)
			} else {
				None
			};
			let workspace_symbols = params.action == Action::Symbols && params.query.is_some();
			let method = if params.action == Action::Request {
				params.query.as_deref().ok_or(Fault::InvalidArguments)?
			} else if params.action == Action::Reload {
				"rust-analyzer/reloadWorkspace"
			} else if workspace_symbols {
				"workspace/symbol"
			} else {
				actions::method(params.action).ok_or(Fault::InvalidArguments)?
			};
			let mut results = Vec::new();
			let mut pulled_diagnostics = Vec::new();
			let mut diagnostics_complete = true;
			let mut workspace_outcomes = Vec::new();
			for binding in &selected {
				let encoding = binding
					.sync_policy
					.as_ref()
					.map(|policy| PositionEncoding::from_lsp_name(Some(&policy.position_encoding)))
					.unwrap_or_default();
				let character = match (source_line, symbol_target.as_ref()) {
					(Some(source_line), Some(target)) => {
						navigation::resolve_symbol_column(source_line, target, encoding)
							.ok_or(Fault::InvalidArguments)?
					},
					_ => 0,
				};
				let supplied = params
					.payload
					.as_deref()
					.map(|payload| parse_request_payload(Some(payload)))
					.transpose()?;
				let mut request_params = match (params.action, supplied) {
					(Action::Request, Some(payload)) => payload,
					(_, supplied) => actions::auto_parameters(
						supplied,
						Some(uri.as_str()),
						params.line,
						Some(character),
					),
				};
				if params.action == Action::References {
					request_params["context"] = json!({ "includeDeclaration": true });
				}
				if params.action == Action::Rename {
					request_params["newName"] = json!(params.new_name);
				}
				if workspace_symbols {
					request_params = json!({ "query": params.query.as_deref().unwrap_or_default() });
				} else if params.action == Action::Symbols {
					request_params = json!({ "textDocument": { "uri": uri.as_str() } });
				}
				if params.action == Action::CodeActions {
					request_params["range"] = json!({ "start": { "line": line - 1, "character": character }, "end": { "line": line - 1, "character": character } });
					let mut context = json!({ "diagnostics": [], "triggerKind": 1 });
					if params.apply != Some(true)
						&& let Some(query) = params.query.as_deref()
					{
						context["only"] = json!([query]);
					}
					request_params["context"] = context;
				}
				let response = self
					.documents
					.lsp_request(
						pb::LspRequest {
							server_id:    binding.server_id.clone(),
							method:       method.into(),
							params_json:  Bytes::from(
								serde_json::to_vec(&request_params).map_err(|_| Fault::InvalidArguments)?,
							),
							document:     (!workspace_symbols).then(|| lease_target(&lease)),
							revision:     if workspace_symbols {
								None
							} else {
								lease.head().revision.clone()
							},
							stale_policy: pb::LspStalePolicy::Fail as i32,
						},
						&cancel,
					)
					.await;
				if workspace_symbols {
					let result = match response {
						Ok(response) => match response.outcome {
							Some(lsp_response::Outcome::ResultJson(bytes)) => {
								serde_json::from_slice(&bytes)
									.map_err(|_| Str::new_static("server returned invalid JSON"))
							},
							Some(lsp_response::Outcome::Error(error)) => {
								let message = if error.message.is_empty() {
									Str::from(format!("server returned LSP error {}", error.code))
								} else {
									Str::from(error.message)
								};
								Err(message)
							},
							None => Err(Str::new_static("server returned no response")),
						},
						Err(error) => Err(document_error_detail(error)),
					};
					workspace_outcomes.push(WorkspaceSymbolOutcome {
						server: Str::from(binding.name.as_str()),
						result,
					});
					continue;
				}
				let response = response.map_err(|_| Fault::Server)?;
				match response.outcome {
					Some(lsp_response::Outcome::ResultJson(bytes)) => {
						if params.action == Action::Diagnostics {
							match parse_pull(Str::from(uri.as_str()), &bytes, binding.name.as_str())
								.map_err(|_| Fault::Server)?
							{
								Some(mut diagnostics) => pulled_diagnostics.append(&mut diagnostics),
								None => diagnostics_complete = false,
							}
						}
						results.push(serde_json::from_slice(&bytes).map_err(|_| Fault::Server)?)
					},
					Some(lsp_response::Outcome::Error(_)) | None => return Err(Fault::Server),
				}
			}
			if params.action == Action::Diagnostics {
				let result = DiagnosticResult::new(pulled_diagnostics, diagnostics_complete);
				let output = render_diagnostics(&result);
				let data = json!({
					"diagnostics": result.diagnostics,
					"omitted": result.omitted,
					"complete": result.complete,
				});
				return Ok(Payload {
					action: params.action,
					servers,
					output,
					data,
					omitted: result.omitted,
				});
			}
			if workspace_symbols {
				return aggregate_workspace_symbols(
					params.query.as_deref().unwrap_or_default(),
					workspace_outcomes,
				);
			}
			let mut data = if results.len() == 1 {
				results.remove(0)
			} else {
				Value::Array(results)
			};
			if params.action == Action::Rename {
				let edits = data
					.as_array()
					.map_or_else(|| vec![data.clone()], Clone::clone);
				data = merge_workspace_edits(&edits, None)?;
			}
			if matches!(
				params.action,
				Action::Definition
					| Action::TypeDefinition
					| Action::Implementation
					| Action::References
			) {
				data = Value::Array(navigation::normalize_locations(&data, usize::MAX));
			}
			if params.action == Action::Rename {
				refactor::validate_workspace_edit(&data).map_err(|_| Fault::WorkspaceEdit)?;
				if params.apply.unwrap_or(true) {
					let encoding = selected
						.first()
						.and_then(|binding| binding.sync_policy.as_ref())
						.map(|policy| PositionEncoding::from_lsp_name(Some(&policy.position_encoding)))
						.unwrap_or_default();
					let applied = self.apply_workspace_edit(&data, encoding, &cancel).await?;
					let output =
						Str::from(format!("Applied rename transaction across {applied} document(s)"));
					return Ok(Payload { action: params.action, servers, output, data, omitted: 0 });
				}
			}
			if params.action == Action::CodeActions {
				let actions = data
					.as_array()
					.into_iter()
					.flatten()
					.flat_map(|value| {
						value
							.as_array()
							.map_or_else(|| vec![value.clone()], Clone::clone)
					})
					.collect::<Vec<_>>();
				if params.apply == Some(true) {
					let selector = params.query.as_deref().ok_or(Fault::InvalidArguments)?;
					let selector_folded = selector.to_ascii_lowercase();
					let index = selector
						.parse::<usize>()
						.ok()
						.or_else(|| {
							actions.iter().position(|action| {
								action
									.get("title")
									.and_then(Value::as_str)
									.is_some_and(|title| {
										title
											.to_ascii_lowercase()
											.contains(selector_folded.as_str())
									})
							})
						})
						.ok_or(Fault::InvalidArguments)?;
					let mut action = actions.get(index).cloned().ok_or(Fault::InvalidArguments)?;
					if action.get("disabled").is_some() {
						return Err(Fault::InvalidArguments);
					}
					let binding = selected.first().ok_or(Fault::Unavailable)?;
					if action.get("data").is_some() {
						let response = self
							.documents
							.lsp_request(
								pb::LspRequest {
									server_id:    binding.server_id.clone(),
									method:       "codeAction/resolve".into(),
									params_json:  Bytes::from(
										serde_json::to_vec(&action).map_err(|_| Fault::InvalidArguments)?,
									),
									document:     Some(lease_target(&lease)),
									revision:     lease.head().revision.clone(),
									stale_policy: pb::LspStalePolicy::Fail as i32,
								},
								&cancel,
							)
							.await
							.map_err(|_| Fault::Server)?;
						if let Some(lsp_response::Outcome::ResultJson(bytes)) = response.outcome {
							action = serde_json::from_slice(&bytes).map_err(|_| Fault::Server)?;
						}
					}
					let mut applied = 0;
					if let Some(edit) = action.get("edit") {
						let edit = merge_workspace_edits(&[edit.clone()], None)?;
						let encoding = binding
							.sync_policy
							.as_ref()
							.map(|policy| PositionEncoding::from_lsp_name(Some(&policy.position_encoding)))
							.unwrap_or_default();
						applied = self.apply_workspace_edit(&edit, encoding, &cancel).await?;
					}
					if let Some(command) = action.get("command") {
						let (name, arguments) = if let Some(name) = command.as_str() {
							(name, Value::Array(Vec::new()))
						} else {
							(
								command
									.get("command")
									.and_then(Value::as_str)
									.ok_or(Fault::InvalidArguments)?,
								command
									.get("arguments")
									.cloned()
									.unwrap_or_else(|| Value::Array(Vec::new())),
							)
						};
						let response = self
							.documents
							.lsp_request(
								pb::LspRequest {
									server_id:    binding.server_id.clone(),
									method:       "workspace/executeCommand".into(),
									params_json:  Bytes::from(
										serde_json::to_vec(&json!({
											"command": name,
											"arguments": arguments,
										}))
										.map_err(|_| Fault::InvalidArguments)?,
									),
									document:     Some(lease_target(&lease)),
									revision:     lease.head().revision.clone(),
									stale_policy: pb::LspStalePolicy::Fail as i32,
								},
								&cancel,
							)
							.await
							.map_err(|_| Fault::Server)?;
						if !matches!(response.outcome, Some(lsp_response::Outcome::ResultJson(_))) {
							return Err(Fault::Server);
						}
					}
					let output = Str::from(format!(
						"Applied code action {} across {applied} document(s)",
						action
							.get("title")
							.and_then(Value::as_str)
							.unwrap_or(selector),
					));
					return Ok(Payload {
						action: params.action,
						servers,
						output,
						data: action,
						omitted: 0,
					});
				}
				data = Value::Array(actions);
			}
			let output = match params.action {
				Action::Hover => data
					.get("contents")
					.map_or_else(|| Str::from("No hover information"), navigation::hover_text),
				Action::Definition => navigation::render_locations("definition", &data),
				Action::TypeDefinition => navigation::render_locations("type definition", &data),
				Action::Implementation => navigation::render_locations("implementation", &data),
				Action::References => navigation::render_references(&data),
				Action::Request => render_raw_response(
					servers.first().map_or("lsp", Str::as_str),
					params.query.as_deref().unwrap_or_default(),
					&data,
				)?,
				Action::Rename => refactor::preview(&data),
				_ => render::structured(&data, usize::MAX),
			};
			Ok(Payload { action: params.action, servers, output, data, omitted: 0 })
		}
	}
}
#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn workspace_capabilities_keep_exact_initialize_payloads() {
		let payload = lsp_capabilities_payload(pb::LspStatusResponse {
			servers: vec![pb::LspServerStatus {
				name: "rust-analyzer".into(),
				server_id: Bytes::from_static(b"server"),
				capabilities_json: Bytes::from_static(br#"{"hoverProvider":true}"#),
				..Default::default()
			}],
		})
		.expect("capabilities");
		assert_eq!(payload.action, Action::Capabilities);
		assert_eq!(
			payload.data,
			json!([{"name": "rust-analyzer", "capabilities": {"hoverProvider": true}}])
		);
	}

	#[test]
	fn raw_request_projection_names_server_method_and_preserves_nested_json() {
		let output = render_raw_response(
			"rust-analyzer",
			"rust-analyzer/expandMacro",
			&json!({"name": "expanded", "nested": {"ok": true}}),
		)
		.expect("raw response");
		assert!(output.starts_with("rust-analyzer \u{2190} rust-analyzer/expandMacro:\n"));
		assert!(output.contains("\"nested\": {"));
	}

	#[test]
	fn request_payload_is_real_json_or_an_empty_object() {
		assert_eq!(parse_request_payload(None).expect("default payload"), json!({}));
		assert_eq!(
			parse_request_payload(Some(r#"{"context":{"triggerKind":1}}"#)).expect("object payload"),
			json!({"context": {"triggerKind": 1}})
		);
		assert_eq!(
			parse_request_payload(Some(r#"["literal",1]"#)).expect("array payload"),
			json!(["literal", 1])
		);
		assert!(matches!(parse_request_payload(Some("{broken")), Err(Fault::InvalidArguments)));
	}

	#[test]
	fn diagnostic_globs_are_sorted_bounded_and_skip_dependency_trees() {
		let root = tempfile::tempdir().expect("diagnostic root");
		fs::create_dir_all(root.path().join("src")).expect("source directory");
		fs::create_dir_all(root.path().join("node_modules/pkg")).expect("dependency directory");
		for index in (0..25).rev() {
			fs::write(root.path().join(format!("src/{index:02}.ts")), "const x = 1;\n")
				.expect("source file");
		}
		fs::write(root.path().join("node_modules/pkg/hidden.ts"), "bad").expect("dependency file");
		let (targets, truncated) =
			resolve_diagnostic_targets(root.path(), "**/*.ts", None).expect("glob targets");
		assert!(truncated);
		assert_eq!(targets.len(), 20);
		assert_eq!(targets.first().map(String::as_str), Some("src/00.ts"));
		assert_eq!(targets.last().map(String::as_str), Some("src/19.ts"));
		assert!(!targets.iter().any(|path| path.contains("node_modules")));
	}

	#[test]
	fn directory_rename_enumerates_regular_files_and_rewrites_nested_edit_uris() {
		let root = tempfile::tempdir().expect("rename root");
		let source = root.path().join("old");
		let destination = root.path().join("new");
		fs::create_dir_all(source.join("nested")).expect("nested source");
		fs::write(source.join("a.rs"), "mod nested;\n").expect("source file");
		fs::write(source.join("nested/b.rs"), "pub struct B;\n").expect("nested file");
		let pairs =
			enumerate_directory_rename_pairs(&source, &destination, None).expect("rename pairs");
		assert_eq!(pairs.len(), 2);
		assert!(pairs.iter().any(|(_, next)| next.ends_with("/new/a.rs")));
		assert!(
			pairs
				.iter()
				.any(|(_, next)| next.ends_with("/new/nested/b.rs"))
		);

		let old = Url::from_file_path(&source).expect("source URL");
		let new = Url::from_file_path(&destination).expect("destination URL");
		let nested = Url::from_file_path(source.join("nested/b.rs")).expect("nested URL");
		assert_eq!(
			rewrite_uri(nested.as_str(), Some((old.as_str(), new.as_str()))),
			Url::from_file_path(destination.join("nested/b.rs"))
				.expect("rewritten URL")
				.to_string(),
		);
	}

	#[test]
	fn reload_notification_preserves_configured_and_empty_settings() {
		for settings_json in [
			Bytes::from_static(br#"{"settings":{"rust-analyzer":{"cargo":{"features":"all"}}}}"#),
			Bytes::from_static(br#"{"settings":{}}"#),
		] {
			let binding = pb::LspServerBinding {
				server_id: Bytes::from_static(b"active-server"),
				settings_json: settings_json.clone(),
				..Default::default()
			};
			let notification = reload_notification(&binding);
			assert_eq!(notification.server_id, binding.server_id);
			assert_eq!(notification.method, "workspace/didChangeConfiguration");
			assert_eq!(notification.params_json, settings_json);
		}
	}
}
