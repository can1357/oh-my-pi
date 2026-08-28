//! Static native custom-tool discovery and lowering.
//!
//! Discovery reads declarations only. Python modules and process handlers are
//! activated later by the owning supervised extension worker or Environment.

use std::{
	collections::{BTreeMap, BTreeSet},
	fmt, fs, io,
	path::{Component, Path, PathBuf},
	sync::Arc,
};

use async_stream::stream;
use bytes::Bytes;
use futures::Stream;
use omp_core::Str;
use omp_env::{EnvClient, ExecEvent};
use omp_proto::env::v1::{
	CloseSessionRequest, ExecOutcome, ExecRequest, OpenSessionRequest, OutputChannel, Script,
	StdinFrame, stdin_frame,
};
use omp_tool::{
	Abort, ArgIssue, ArgIssueKind, CommitError, Constraint, Effects, Ev, ExecEffects,
	IncomingParams, ParamError, Part, Presentation, PromptCaps, Rev, Tool, ToolSpec, ToolTerminal,
};
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use thiserror::Error;

use super::manifest::{ToolHandlerDeclaration, ToolPayload};
#[derive(Clone)]
struct ProcessBinding {
	client: EnvClient,
	cwd:    omp_core::EnvPath,
}

/// Post-connect factory for declaration-fixed native process tools.
pub struct ProcessToolFactory {
	tools:   Vec<ToolPayload>,
	binding: Arc<RwLock<Option<ProcessBinding>>>,
}
impl fmt::Debug for ProcessToolFactory {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter
			.debug_struct("ProcessToolFactory")
			.field("tools", &self.tools.len())
			.finish_non_exhaustive()
	}
}

impl ProcessToolFactory {
	/// Retains only process-backed winners for registration before freeze.
	pub fn new(tools: impl IntoIterator<Item = ToolPayload>) -> Self {
		Self {
			tools:   tools
				.into_iter()
				.filter(|tool| matches!(tool.handler, ToolHandlerDeclaration::Process { .. }))
				.collect(),
			binding: Arc::new(RwLock::new(None)),
		}
	}

	/// Returns whether the factory has any executable declarations.
	pub fn is_empty(&self) -> bool {
		self.tools.is_empty()
	}
}

impl omp_envd::DynamicToolFactory for ProcessToolFactory {
	fn register(
		&self,
		registrar: &mut omp_envd::DynamicToolRegistrar<'_>,
	) -> Result<(), omp_tool::RegistryError> {
		for declaration in &self.tools {
			registrar.register(
				ProcessCustomTool::new(declaration.clone(), Arc::clone(&self.binding)),
				Presentation::Device,
				omp_tool::Claims {
					precedence: omp_tool::Precedence::ENHANCEMENT,
					claimant:   Str::new_static("omp/native-custom-tools"),
					replaces:   None,
				},
			)?;
		}
		Ok(())
	}

	fn bind(&self, client: EnvClient, root: &Path) {
		let cwd = url::Url::from_file_path(root)
			.ok()
			.and_then(|url| omp_core::EnvPath::new(Str::new(url.as_str())).ok());
		if let Some(cwd) = cwd {
			*self.binding.write() = Some(ProcessBinding { client, cwd });
		}
	}
}

struct ProcessCustomTool {
	spec:        ToolSpec,
	declaration: ToolPayload,
	binding:     Arc<RwLock<Option<ProcessBinding>>>,
}

impl ProcessCustomTool {
	fn new(declaration: ToolPayload, binding: Arc<RwLock<Option<ProcessBinding>>>) -> Self {
		let commands: Arc<[Str]> = match &declaration.handler {
			ToolHandlerDeclaration::Process { program, .. } => {
				Arc::from([Str::from(program.to_string_lossy().into_owned())])
			},
			ToolHandlerDeclaration::Python { .. } => Arc::from([]),
		};
		let spec = ToolSpec {
			name:            declaration.name.clone(),
			rev:             Rev { family: Str::new_static("native"), n: 1 },
			description:     declaration.description.clone(),
			schema:          Bytes::from(
				serde_json::to_vec(&declaration.input_schema)
					.expect("discovered tool schema is serializable"),
			),
			constraint:      Constraint::Schema {
				priority:       100,
				on_unsupported: omp_tool::Fallback::Unspecified,
			},
			effects:         Effects {
				exec: Some(ExecEffects { commands, network: false }),
				..Effects::empty()
			},
			projection_code: omp_tool::native_projection_code(
				env!("CARGO_PKG_NAME"),
				env!("CARGO_PKG_VERSION"),
				include_bytes!("custom_tools.rs"),
			)
			.into_bytes(),
		};
		Self { spec, declaration, binding }
	}
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct ProcessPayload {
	stdout:    Str,
	stderr:    Str,
	exit_code: i32,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct ProcessFault {
	message: Str,
}

impl fmt::Display for ProcessFault {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter.write_str(self.message.as_str())
	}
}

#[derive(Clone, Debug, Deserialize, Serialize)]
enum ProcessUpdate {}

impl Tool for ProcessCustomTool {
	type Fault = ProcessFault;
	type Params = Value;
	type Payload = ProcessPayload;
	type Update = ProcessUpdate;

	fn spec(&self) -> &ToolSpec {
		&self.spec
	}

	fn call<'c>(
		&'c self,
		mut incoming: IncomingParams<'c>,
	) -> impl Stream<Item = Ev<Self::Update, Self::Payload, Self::Fault>> + Send + 'c {
		stream! {
			let params = match incoming.whole::<Value>().await {
				Ok(value) => value,
				Err(error) => { yield process_param_event(error); return; }
			};
			if let Err(error) = incoming.interruptable().committed().await {
				yield process_commit_event(error);
				return;
			}
			let Some(binding) = self.binding.read().clone() else {
				yield Ev::Done(ToolTerminal::Done {
					result: Err(ProcessFault { message: Str::new_static("custom tool environment is not bound") }),
					useless: true,
				});
				return;
			};
			let result = execute_process_tool(&binding, &self.declaration, &params).await;
			yield Ev::Done(ToolTerminal::Done { result, useless: false });
		}
	}

	fn prompt(&self, view: Result<&ProcessPayload, &ProcessFault>, _: &PromptCaps) -> Vec<Part> {
		let text = match view {
			Ok(payload) => serde_json::to_string(payload).unwrap_or_else(|_| {
				"{\"error\":\"custom tool result serialization failed\"}".to_owned()
			}),
			Err(error) => error.to_string(),
		};
		vec![Part::Text { text: Str::from(text) }]
	}
}

async fn execute_process_tool(
	binding: &ProcessBinding,
	declaration: &ToolPayload,
	params: &Value,
) -> Result<ProcessPayload, ProcessFault> {
	let ToolHandlerDeclaration::Process { program, args } = &declaration.handler else {
		return Err(ProcessFault {
			message: Str::new_static("custom tool handler is not a process"),
		});
	};
	let opened = binding
		.client
		.open_session(&binding.cwd, OpenSessionRequest::default())
		.await
		.map_err(process_fault)?;
	let session = opened.session.clone();
	let command = std::iter::once(program.to_string_lossy().into_owned())
		.chain(args.iter().map(ToString::to_string))
		.map(|argument| process_shell_word(&argument))
		.collect::<Vec<_>>()
		.join(" ");
	let result = async {
		let mut run = binding
			.client
			.exec(ExecRequest {
				session: opened.session,
				source: Some(Script { text: command, ..Script::default() }),
				..ExecRequest::default()
			})
			.await
			.map_err(process_fault)?;
		let exec = match run.next_event().await.map_err(process_fault)? {
			Some(ExecEvent::Started(started)) => started.exec,
			Some(_) => {
				return Err(ProcessFault {
					message: Str::new_static("custom tool process omitted its start frame"),
				});
			},
			None => {
				return Err(ProcessFault {
					message: Str::new_static("custom tool process stream ended before start"),
				});
			},
		};
		let mut input = serde_json::to_vec(params).map_err(process_fault)?;
		input.push(b'\n');
		run.stdin(StdinFrame {
			exec:  exec.clone(),
			input: Some(stdin_frame::Input::Data(Bytes::from(input))),
			props: None,
		})
		.await
		.map_err(process_fault)?;
		run.stdin(StdinFrame { exec, input: Some(stdin_frame::Input::Eof(true)), props: None })
			.await
			.map_err(process_fault)?;
		let mut stdout = Vec::new();
		let mut stderr = Vec::new();
		loop {
			match run.next_event().await.map_err(process_fault)? {
				Some(ExecEvent::Output(frame)) => {
					let target = if frame.channel == OutputChannel::Stdout as i32 {
						&mut stdout
					} else {
						&mut stderr
					};
					if target.len().saturating_add(frame.data.len()) > 1024 * 1024 {
						return Err(ProcessFault {
							message: Str::new_static("custom tool output exceeds 1 MiB"),
						});
					}
					target.extend_from_slice(&frame.data);
				},
				Some(ExecEvent::Exit(exit)) => {
					let status = exit.status.ok_or_else(|| ProcessFault {
						message: Str::new_static("custom tool exited without status"),
					})?;
					if status.outcome != ExecOutcome::Exited as i32 {
						return Err(ProcessFault {
							message: Str::from(format!(
								"custom tool process ended with outcome {}",
								status.outcome
							)),
						});
					}
					return Ok(ProcessPayload {
						stdout:    Str::from(String::from_utf8_lossy(&stdout).into_owned()),
						stderr:    Str::from(String::from_utf8_lossy(&stderr).into_owned()),
						exit_code: status.exit_code.unwrap_or(-1),
					});
				},
				Some(ExecEvent::Started(_)) => {},
				None => {
					return Err(ProcessFault {
						message: Str::new_static("custom tool process stream ended early"),
					});
				},
			}
		}
	}
	.await;
	let _ = binding
		.client
		.close_session(CloseSessionRequest { session, ..CloseSessionRequest::default() })
		.await;
	result
}

fn process_fault(error: impl fmt::Display) -> ProcessFault {
	ProcessFault { message: Str::new(error.to_string()) }
}

fn process_param_event(error: ParamError) -> Ev<ProcessUpdate, ProcessPayload, ProcessFault> {
	match error {
		ParamError::Args(issue) => Ev::Args(*issue),
		ParamError::Interrupted(interrupt) => {
			Ev::Aborted(Abort::Interrupted { reason: interrupt.reason })
		},
		ParamError::Protocol(message) => Ev::Args(ArgIssue {
			path:     Vec::new(),
			expected: Str::new_static("one custom tool argument object"),
			kind:     ArgIssueKind::Protocol,
			example:  Some(Str::new_static("{}")),
			found:    Some(message),
		}),
	}
}

fn process_commit_event(error: CommitError) -> Ev<ProcessUpdate, ProcessPayload, ProcessFault> {
	match error {
		CommitError::Aborted => Ev::Aborted(Abort::InputDropped),
		CommitError::Interrupted(interrupt) => {
			Ev::Aborted(Abort::Interrupted { reason: interrupt.reason })
		},
		CommitError::Protocol(message) => Ev::Args(ArgIssue {
			path:     Vec::new(),
			expected: Str::new_static("one committed custom tool argument object"),
			kind:     ArgIssueKind::Protocol,
			example:  Some(Str::new_static("{}")),
			found:    Some(message),
		}),
	}
}

fn process_shell_word(word: &str) -> String {
	if !word.is_empty()
		&& word
			.bytes()
			.all(|byte| byte.is_ascii_alphanumeric() || b"-_./:".contains(&byte))
	{
		return word.to_owned();
	}
	format!("'{}'", word.replace('\'', "'\\''"))
}

/// Native source tier for deterministic tool precedence.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum ToolSourceTier {
	/// Project-authored `.omp/tools`.
	Project,
	/// User-authored native config tools.
	User,
	/// Installed signed native package tools.
	Package,
}

impl ToolSourceTier {
	const fn priority(self) -> u8 {
		match self {
			Self::Project => 3,
			Self::User => 2,
			Self::Package => 1,
		}
	}
}

/// One static custom-tool discovery root.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ToolRoot {
	/// Canonical native root containing tool files.
	pub path:         PathBuf,
	/// Source precedence tier.
	pub tier:         ToolSourceTier,
	/// Owning extension identity for package roots.
	pub extension_id: Option<Str>,
}

/// Non-fatal malformed declaration evidence.
#[derive(Debug)]
pub struct ToolWarning {
	/// Source path.
	pub path:  PathBuf,
	/// Typed reason.
	pub error: ToolDiscoveryError,
}

/// Winning static custom tools plus skipped-source diagnostics.
#[derive(Debug, Default)]
pub struct CustomToolDiscovery {
	/// First winner for each tool name, sorted by name.
	pub tools:    BTreeMap<Str, ToolPayload>,
	/// Malformed or duplicate declarations.
	pub warnings: Vec<ToolWarning>,
}

/// Fail-closed static custom-tool declaration error.
#[derive(Debug, Error)]
pub enum ToolDiscoveryError {
	/// Source could not be read.
	#[error("custom tool source could not be read")]
	Io(#[source] io::Error),
	/// JSON declaration was malformed.
	#[error("custom tool JSON declaration is malformed")]
	Json(#[source] serde_json::Error),
	/// Markdown frontmatter was malformed.
	#[error("custom tool Markdown frontmatter is malformed")]
	Yaml(#[source] serde_yaml::Error),
	/// A declaration omitted a required field.
	#[error("custom tool declaration is missing {0}")]
	Missing(&'static str),
	/// Tool name is outside the native identifier vocabulary.
	#[error("custom tool name is invalid")]
	InvalidName,
	/// Input schema is not a frozen local JSON Schema object.
	#[error("custom tool input schema is not a frozen local JSON Schema")]
	InvalidSchema,
	/// Handler escaped its declaration root.
	#[error("custom tool handler escapes its native root")]
	EscapedHandler,
	/// A higher-priority source already claimed the tool name.
	#[error("custom tool name is already claimed")]
	Duplicate,
}

#[derive(Debug, Deserialize)]
struct JsonTool {
	name:         Option<Str>,
	description:  Option<Str>,
	#[serde(default, alias = "inputSchema", alias = "parameters")]
	input_schema: Option<Value>,
	handler:      Option<JsonHandler>,
	module:       Option<Str>,
	callable:     Option<Str>,
	program:      Option<PathBuf>,
	#[serde(default)]
	args:         Vec<Str>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum JsonHandler {
	Python {
		module:   Str,
		callable: Str,
	},
	Process {
		program: PathBuf,
		#[serde(default)]
		args:    Vec<Str>,
	},
}

/// Scans native roots without importing or executing any source. Canonical
/// paths are deduplicated before parsing; source priority and lexical path
/// order make name collisions deterministic.
pub fn discover(roots: impl IntoIterator<Item = ToolRoot>) -> CustomToolDiscovery {
	let mut roots = roots.into_iter().collect::<Vec<_>>();
	roots.sort_by(|left, right| {
		right
			.tier
			.priority()
			.cmp(&left.tier.priority())
			.then_with(|| left.path.cmp(&right.path))
	});
	let mut seen_paths = BTreeSet::new();
	let mut output = CustomToolDiscovery::default();
	for root in roots {
		for path in tool_files(&root.path) {
			let canonical = match path.canonicalize() {
				Ok(path) => path,
				Err(error) => {
					output
						.warnings
						.push(ToolWarning { path, error: ToolDiscoveryError::Io(error) });
					continue;
				},
			};
			if !canonical.starts_with(
				root
					.path
					.canonicalize()
					.unwrap_or_else(|_| root.path.clone()),
			) || !seen_paths.insert(canonical.clone())
			{
				continue;
			}
			match load_tool(&root, &canonical) {
				Ok(tool) if output.tools.contains_key(&tool.name) => output
					.warnings
					.push(ToolWarning { path: canonical, error: ToolDiscoveryError::Duplicate }),
				Ok(tool) => {
					output.tools.insert(tool.name.clone(), tool);
				},
				Err(error) => output.warnings.push(ToolWarning { path: canonical, error }),
			}
		}
	}
	output
}

fn tool_files(root: &Path) -> Vec<PathBuf> {
	if !root.is_dir() {
		return Vec::new();
	}
	let mut pending = vec![root.to_path_buf()];
	let mut files = Vec::new();
	while let Some(directory) = pending.pop() {
		let Ok(entries) = fs::read_dir(directory) else {
			continue;
		};
		for entry in entries.filter_map(Result::ok) {
			let path = entry.path();
			if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
				pending.push(path);
				continue;
			}
			if path
				.extension()
				.and_then(|extension| extension.to_str())
				.is_some_and(|extension| {
					matches!(extension.to_ascii_lowercase().as_str(), "json" | "md" | "py" | "sh")
				}) {
				files.push(path);
			}
		}
	}
	files.sort();
	files
}

fn load_tool(root: &ToolRoot, path: &Path) -> Result<ToolPayload, ToolDiscoveryError> {
	let extension = path
		.extension()
		.and_then(|extension| extension.to_str())
		.unwrap_or_default();
	match extension.to_ascii_lowercase().as_str() {
		"json" => load_json(root, path),
		"md" => load_markdown(root, path),
		"py" => load_python(root, path),
		"sh" => load_process(path),
		_ => Err(ToolDiscoveryError::Missing("supported extension")),
	}
}

fn load_json(root: &ToolRoot, path: &Path) -> Result<ToolPayload, ToolDiscoveryError> {
	let bytes = fs::read(path).map_err(ToolDiscoveryError::Io)?;
	let declaration: JsonTool = serde_json::from_slice(&bytes).map_err(ToolDiscoveryError::Json)?;
	lower(root, path, declaration, None)
}

fn load_markdown(root: &ToolRoot, path: &Path) -> Result<ToolPayload, ToolDiscoveryError> {
	let text = fs::read_to_string(path).map_err(ToolDiscoveryError::Io)?;
	let (frontmatter, body) = markdown_parts(&text)?;
	let declaration: JsonTool =
		serde_yaml::from_str(frontmatter).map_err(ToolDiscoveryError::Yaml)?;
	lower(
		root,
		path,
		declaration,
		body
			.lines()
			.find(|line| !line.trim().is_empty())
			.map(str::trim),
	)
}

fn markdown_parts(text: &str) -> Result<(&str, &str), ToolDiscoveryError> {
	let rest = text
		.strip_prefix("---\n")
		.ok_or(ToolDiscoveryError::Missing("frontmatter"))?;
	let (frontmatter, body) = rest
		.split_once("\n---")
		.ok_or(ToolDiscoveryError::Missing("frontmatter fence"))?;
	Ok((frontmatter, body.trim_start_matches(|character| matches!(character, '\r' | '\n'))))
}

fn load_python(root: &ToolRoot, path: &Path) -> Result<ToolPayload, ToolDiscoveryError> {
	let relative = path
		.strip_prefix(
			root
				.path
				.canonicalize()
				.unwrap_or_else(|_| root.path.clone()),
		)
		.map_err(|_| ToolDiscoveryError::EscapedHandler)?;
	let mut components = relative
		.components()
		.filter_map(|component| match component {
			Component::Normal(value) => value.to_str(),
			_ => None,
		})
		.collect::<Vec<_>>();
	let stem = path
		.file_stem()
		.and_then(|stem| stem.to_str())
		.ok_or(ToolDiscoveryError::InvalidName)?;
	if let Some(last) = components.last_mut() {
		*last = stem;
	}
	let module = components.join(".");
	let name = stem.replace('_', "-");
	validate_name(&name)?;
	Ok(ToolPayload {
		name:         Str::new(&name),
		path:         path.to_path_buf(),
		description:  Str::new(format!("Native custom tool {name}")),
		input_schema: empty_schema(),
		handler:      ToolHandlerDeclaration::Python {
			module:   Str::new(module),
			callable: Str::new_static("run"),
		},
	})
}

fn load_process(path: &Path) -> Result<ToolPayload, ToolDiscoveryError> {
	let name = path
		.file_stem()
		.and_then(|stem| stem.to_str())
		.ok_or(ToolDiscoveryError::InvalidName)?;
	validate_name(name)?;
	Ok(ToolPayload {
		name:         Str::new(name),
		path:         path.to_path_buf(),
		description:  Str::new(format!("Native custom tool {name}")),
		input_schema: empty_schema(),
		handler:      ToolHandlerDeclaration::Process {
			program: path.to_path_buf(),
			args:    Vec::new(),
		},
	})
}

fn lower(
	root: &ToolRoot,
	path: &Path,
	declaration: JsonTool,
	body_description: Option<&str>,
) -> Result<ToolPayload, ToolDiscoveryError> {
	let name = declaration.name.unwrap_or_else(|| {
		Str::new(
			path
				.file_stem()
				.and_then(|stem| stem.to_str())
				.unwrap_or_default(),
		)
	});
	validate_name(&name)?;
	let schema = declaration.input_schema.unwrap_or_else(empty_schema);
	validate_schema(&schema)?;
	let handler = match declaration.handler {
		Some(JsonHandler::Python { module, callable }) => {
			ToolHandlerDeclaration::Python { module, callable }
		},
		Some(JsonHandler::Process { program, args }) => {
			ToolHandlerDeclaration::Process { program: contained_program(root, program)?, args }
		},
		None if declaration.module.is_some() => ToolHandlerDeclaration::Python {
			module:   declaration.module.expect("checked"),
			callable: declaration
				.callable
				.unwrap_or_else(|| Str::new_static("run")),
		},
		None if declaration.program.is_some() => ToolHandlerDeclaration::Process {
			program: contained_program(root, declaration.program.expect("checked"))?,
			args:    declaration.args,
		},
		None => return Err(ToolDiscoveryError::Missing("handler")),
	};
	Ok(ToolPayload {
		name,
		path: path.to_path_buf(),
		description: declaration
			.description
			.or_else(|| body_description.map(Str::new))
			.ok_or(ToolDiscoveryError::Missing("description"))?,
		input_schema: schema,
		handler,
	})
}

fn contained_program(root: &ToolRoot, program: PathBuf) -> Result<PathBuf, ToolDiscoveryError> {
	let candidate = if program.is_absolute() {
		program
	} else {
		root.path.join(program)
	};
	let canonical = candidate.canonicalize().map_err(ToolDiscoveryError::Io)?;
	let canonical_root = root.path.canonicalize().map_err(ToolDiscoveryError::Io)?;
	canonical
		.starts_with(canonical_root)
		.then_some(canonical)
		.ok_or(ToolDiscoveryError::EscapedHandler)
}

fn validate_name(name: &str) -> Result<(), ToolDiscoveryError> {
	if name.is_empty()
		|| name.starts_with('-')
		|| !name
			.bytes()
			.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
	{
		return Err(ToolDiscoveryError::InvalidName);
	}
	Ok(())
}

fn validate_schema(schema: &Value) -> Result<(), ToolDiscoveryError> {
	let Some(object) = schema.as_object() else {
		return Err(ToolDiscoveryError::InvalidSchema);
	};
	if object
		.get("type")
		.and_then(Value::as_str)
		.is_some_and(|kind| kind != "object")
		|| contains_remote_ref(schema)
	{
		return Err(ToolDiscoveryError::InvalidSchema);
	}
	Ok(())
}

fn contains_remote_ref(value: &Value) -> bool {
	match value {
		Value::Object(object) => object.iter().any(|(key, value)| {
			(key == "$ref"
				&& value
					.as_str()
					.is_some_and(|reference| !reference.starts_with('#')))
				|| contains_remote_ref(value)
		}),
		Value::Array(values) => values.iter().any(contains_remote_ref),
		_ => false,
	}
}

fn empty_schema() -> Value {
	let mut schema = Map::new();
	schema.insert("type".to_owned(), json!("object"));
	schema.insert("properties".to_owned(), Value::Object(Map::new()));
	schema.insert("additionalProperties".to_owned(), Value::Bool(false));
	Value::Object(schema)
}
