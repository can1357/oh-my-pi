//! Production compression sessions over the journal-first kernel and
//! Environment documents.

use std::{
	mem,
	path::{Path, PathBuf},
	str,
	sync::Arc,
};

use async_stream::stream;
use futures::Stream;
use omp_core::{EnvPath, Str, sf};
use omp_env::{EnvClient, TransactionOutcome};
use omp_proto::document::v1::{self as doc_pb, read_selection, text_mutation};
use omp_tool::{
	Abort, ArgIssue, ArgIssueKind, Claims, CommitError, Constraint, Effects, Ev, IncomingParams,
	ParamError, Part, Precedence, Presentation, PromptCaps, Rev, Tool, ToolSpec, ToolTerminal,
};
use parking_lot::Mutex;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;
use url::Url;

use super::{Action, CompressHost, IsolationPolicy, Loss, Status};
use crate::headless::kernel::{ComposedInference, KernelOptions, compose_kernel};

const SYSTEM_PROMPT: &str = include_str!("system_prompt.txt");

/// Failure from production kernel or document ownership.
#[derive(Debug, thiserror::Error)]
pub enum ProductionError {
	/// Filesystem preparation failed.
	#[error("compression filesystem operation failed")]
	Io(#[from] std::io::Error),
	/// Project Environment construction failed.
	#[error(transparent)]
	Environment(#[from] omp_envd::EnvdError),
	/// Journal-first kernel composition failed.
	#[error(transparent)]
	Headless(#[from] crate::headless::HeadlessError),
	/// Kernel turn failed.
	#[error(transparent)]
	Kernel(#[from] omp_agent::KernelError),
	/// Environment DATA document authority rejected or failed an operation.
	#[error(transparent)]
	Document(#[from] omp_env::ClientError),
	/// The caller cancelled an in-flight operation.
	#[error("document operation was cancelled")]
	Cancelled,
	/// Document bytes were not UTF-8.
	#[error("compression source is not UTF-8: {path:?}")]
	Utf8 {
		/// Source document.
		path:   PathBuf,
		/// Decoding failure.
		#[source]
		source: str::Utf8Error,
	},
	/// Whole-document read returned no content body.
	#[error("document authority omitted whole content for {path:?}")]
	MissingContent {
		/// Source document.
		path: PathBuf,
	},
	/// The atomic document transaction was rejected.
	#[error("document authority rejected the approved compression write")]
	WriteRejected,
	/// The document authority reported a partial commit.
	#[error("document authority partially committed the approved compression write")]
	WritePartial,
	/// Restricted tool registration failed.
	#[error(transparent)]
	ToolRegistry(#[from] omp_tool::RegistryError),
	/// No configured default model exists.
	#[error("compress requires --model or model.roles.default")]
	MissingModel,
}

/// One restricted compression child.
pub struct CompressionSession {
	kernel:  omp_agent::Kernel<ComposedInference>,
	session: omp_session::Session,
	actions: Arc<Mutex<Vec<Action>>>,
	first:   bool,
}

/// Presentation-owned progress sink.
pub trait CompressProgress: Send + Sync + 'static {
	/// Observes one file reaching a new status.
	fn update(&self, completed: usize, total: usize, path: &Path, status: Status);
}

/// Production owner for Environment document I/O and restricted children.
pub struct ProductionCompressHost {
	root:           PathBuf,
	data_dir:       PathBuf,
	documents:      EnvClient,
	model_settings: omp_catalog::settings::ModelSettings,
	_environment:   omp_envd::ProjectEnvironment,
	progress:       Arc<dyn CompressProgress>,
}

impl ProductionCompressHost {
	/// Starts the project Environment and binds its document authority.
	pub async fn open(
		root: PathBuf,
		data_dir: PathBuf,
		progress: Arc<dyn CompressProgress>,
	) -> Result<Self, ProductionError> {
		let root = std::fs::canonicalize(root)?;
		let ctx = Arc::new(omp_con::Ctx::new());
		let home = std::env::var_os("HOME").map_or_else(|| root.clone(), PathBuf::from);
		let model_settings =
			omp_catalog::settings::ModelSettings::from_con(&ctx).resolve_path_scopes(&root, &home);
		let state_dir = omp_env::project_state::directory(&data_dir, &root)?;
		std::fs::create_dir_all(&state_dir)?;
		let environment =
			omp_envd::ProjectEnvironment::attach(&root, &state_dir, omp_envd::AttachOptions {
				py_eval:            false,
				approval_mode:      None,
				trusted_extensions: Vec::new(),
				contributed_values: Vec::new(),
				con:                Arc::clone(&ctx),
				bridges:            omp_envd::RegistryBridges::default(),
				spawn_idle_timeout: None,
			})
			.await?;
		let documents = environment.client().clone();
		Ok(Self { root, data_dir, documents, model_settings, _environment: environment, progress })
	}

	fn resolve_model(&self, requested: Option<&str>) -> Result<Str, ProductionError> {
		let catalog = omp_catalog::snapshot::Catalog::try_embedded()
			.map_err(|_| ProductionError::MissingModel)?;
		crate::discovery::roles::resolve_launch_roles(
			catalog,
			&self.model_settings,
			requested,
			None,
			None,
			None,
		)
		.map_err(|_| ProductionError::MissingModel)?
		.primary
		.map(|model| Str::new(model.as_str()))
		.ok_or(ProductionError::MissingModel)
	}
}

impl CompressHost for ProductionCompressHost {
	type Error = ProductionError;
	type Session = CompressionSession;

	fn read_text(
		&self,
		path: &Path,
		cancel: &CancellationToken,
	) -> impl Future<Output = Result<Str, Self::Error>> + Send {
		let path = path.to_owned();
		async move {
			if cancel.is_cancelled() {
				return Err(ProductionError::Cancelled);
			}
			let uri = Url::from_file_path(&path)
				.map_err(|()| ProductionError::MissingContent { path: path.clone() })?;
			let env_path = EnvPath::new(Str::new(uri.as_str()))
				.map_err(|_| ProductionError::MissingContent { path: path.clone() })?;
			let lease = self.documents.open_document(&env_path, None).await?;
			let response = self
				.documents
				.read_document(
					&lease,
					None,
					Some(doc_pb::ReadSelection {
						selection: Some(read_selection::Selection::Whole(doc_pb::WholeDocument {})),
					}),
				)
				.await?;
			let content = response
				.content()
				.cloned()
				.ok_or_else(|| ProductionError::MissingContent { path: path.clone() })?;
			lease.close().await?;
			let text =
				str::from_utf8(&content).map_err(|source| ProductionError::Utf8 { path, source })?;
			Ok(Str::new(text))
		}
	}

	fn open_session(
		&self,
		_name: &str,
		model: Option<&str>,
		policy: IsolationPolicy,
		_cancel: &CancellationToken,
	) -> impl Future<Output = Result<Self::Session, Self::Error>> + Send {
		let model = self.resolve_model(model);
		let root = self.root.clone();
		let data = self.data_dir.clone();
		async move {
			debug_assert_eq!(policy, super::ISOLATION_POLICY);
			let actions = Arc::new(Mutex::new(Vec::new()));
			let registry = Arc::new(compression_registry(Arc::clone(&actions))?);
			let (kernel, session, _) = compose_kernel(
				&data,
				&root,
				model?.as_str(),
				Arc::new(omp_con::Ctx::new()),
				KernelOptions { ephemeral: true, tool_registry: Some(registry), ..Default::default() },
			)
			.await?;
			Ok(CompressionSession { kernel, session, actions, first: true })
		}
	}

	fn turn<'a>(
		&'a self,
		session: &'a mut Self::Session,
		prompt: Str,
		cancel: &'a CancellationToken,
	) -> impl Future<Output = Result<Vec<Action>, Self::Error>> + Send + 'a {
		async move {
			session.actions.lock().clear();
			let text = if mem::take(&mut session.first) {
				Str::new(format!("{SYSTEM_PROMPT}\n\n{prompt}"))
			} else {
				prompt
			};
			session
				.kernel
				.run_turn(
					&mut session.session,
					omp_agent::TurnInput { text, attachments: Vec::new() },
					omp_agent::RunControl::new(cancel.clone(), None),
				)
				.await?;
			Ok(mem::take(&mut *session.actions.lock()))
		}
	}

	fn close_session(
		&self,
		_session: Self::Session,
	) -> impl Future<Output = Result<(), Self::Error>> + Send {
		async { Ok(()) }
	}

	fn write_approved(
		&self,
		path: &Path,
		text: &str,
		cancel: &CancellationToken,
	) -> impl Future<Output = Result<(), Self::Error>> + Send {
		let path = path.to_owned();
		let text = bytes::Bytes::copy_from_slice(text.as_bytes());
		async move {
			if cancel.is_cancelled() {
				return Err(ProductionError::Cancelled);
			}
			let uri = Url::from_file_path(&path)
				.map_err(|()| ProductionError::MissingContent { path: path.clone() })?;
			let env_path = EnvPath::new(Str::new(uri.as_str()))
				.map_err(|_| ProductionError::MissingContent { path: path.clone() })?;
			let mut lease = self.documents.open_document(&env_path, None).await?;
			let outcome = self
				.documents
				.commit_document(
					&mut lease,
					bytes::Bytes::copy_from_slice(omp_core::Ulid::generate().to_string().as_bytes()),
					doc_pb::TextMutation {
						base_revision: None,
						change:        Some(text_mutation::Change::ProposedContent(text)),
						stale_policy:  doc_pb::StalePolicy::Fail as i32,
						format_policy: doc_pb::FormatPolicy::Disabled as i32,
					},
				)
				.await?;
			lease.close().await?;
			match outcome {
				TransactionOutcome::Committed(_) => Ok(()),
				TransactionOutcome::Rejected(_) => Err(ProductionError::WriteRejected),
				TransactionOutcome::Partial(_) => Err(ProductionError::WritePartial),
			}
		}
	}

	fn progress(&self, completed: usize, total: usize, path: &Path, status: Status) {
		self.progress.update(completed, total, path, status);
	}
}

#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize)]
#[serde(deny_unknown_fields)]
struct RewriteParams {
	text:   Str,
	losses: Vec<LossParams>,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize)]
#[serde(deny_unknown_fields)]
struct LossParams {
	content: Str,
	reason:  Str,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize)]
#[serde(deny_unknown_fields)]
struct ApproveParams {
	verdict: Str,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct Ack {
	accepted: bool,
}

#[derive(Debug, Deserialize, Serialize, thiserror::Error)]
enum ToolFault {
	#[error("compression protocol action could not be recorded")]
	Unavailable,
}

struct RewriteTool {
	spec:    ToolSpec,
	actions: Arc<Mutex<Vec<Action>>>,
}

impl RewriteTool {
	fn new(actions: Arc<Mutex<Vec<Action>>>) -> Self {
		Self {
			spec: tool_spec::<RewriteParams>(
				"rewrite",
				"Submit a complete replacement and every deliberate loss.",
			),
			actions,
		}
	}
}

impl Tool for RewriteTool {
	type Fault = ToolFault;
	type Params = RewriteParams;
	type Payload = Ack;
	type Update = Ack;

	fn spec(&self) -> &ToolSpec {
		&self.spec
	}

	fn call<'c>(
		&'c self,
		mut incoming: IncomingParams<'c>,
	) -> impl Stream<Item = Ev<Self::Update, Self::Payload, Self::Fault>> + Send + 'c {
		stream! {
			let params = match incoming.whole::<RewriteParams>().await {
				Ok(params) => params,
				Err(error) => { yield param_event(error); return; },
			};
			if let Err(error) = incoming.interruptable().committed().await {
				yield commit_event(error);
				return;
			}
			self.actions.lock().push(Action::Rewrite {
				text: params.text,
				losses: params.losses.into_iter().map(|loss| Loss { content: loss.content, reason: loss.reason }).collect(),
			});
			yield Ev::Done(ToolTerminal::Done { result: Ok(Ack { accepted: true }), useless: false });
		}
	}

	fn prompt(&self, view: Result<&Ack, &ToolFault>, _: &PromptCaps) -> Vec<Part> {
		vec![Part::Text {
			text: match view {
				Ok(_) => sf!("draft recorded; await review"),
				Err(_) => sf!("draft rejected"),
			},
		}]
	}
}

struct ApproveTool {
	spec:    ToolSpec,
	actions: Arc<Mutex<Vec<Action>>>,
}

impl ApproveTool {
	fn new(actions: Arc<Mutex<Vec<Action>>>) -> Self {
		Self {
			spec: tool_spec::<ApproveParams>(
				"approve",
				"Approve the newest draft after a separate review turn.",
			),
			actions,
		}
	}
}

impl Tool for ApproveTool {
	type Fault = ToolFault;
	type Params = ApproveParams;
	type Payload = Ack;
	type Update = Ack;

	fn spec(&self) -> &ToolSpec {
		&self.spec
	}

	fn call<'c>(
		&'c self,
		mut incoming: IncomingParams<'c>,
	) -> impl Stream<Item = Ev<Self::Update, Self::Payload, Self::Fault>> + Send + 'c {
		stream! {
			let params = match incoming.whole::<ApproveParams>().await {
				Ok(params) => params,
				Err(error) => { yield param_event(error); return; },
			};
			if let Err(error) = incoming.interruptable().committed().await {
				yield commit_event(error);
				return;
			}
			self.actions.lock().push(Action::Approve { verdict: params.verdict });
			yield Ev::Done(ToolTerminal::Done { result: Ok(Ack { accepted: true }), useless: false });
		}
	}

	fn prompt(&self, view: Result<&Ack, &ToolFault>, _: &PromptCaps) -> Vec<Part> {
		vec![Part::Text {
			text: match view {
				Ok(_) => sf!("approval recorded"),
				Err(_) => sf!("approval rejected"),
			},
		}]
	}
}

fn tool_spec<P: JsonSchema>(name: &'static str, description: &'static str) -> ToolSpec {
	ToolSpec {
		name:            sf!(name),
		rev:             Rev { family: sf!("native"), n: 1 },
		description:     sf!(description),
		schema:          omp_tool::schema::<P>(),
		constraint:      Constraint::Schema {
			priority:       100,
			on_unsupported: omp_tool::Fallback::Error,
		},
		effects:         Effects::empty(),
		projection_code: omp_tool::native_projection_code(
			env!("CARGO_PKG_NAME"),
			env!("CARGO_PKG_VERSION"),
			include_bytes!("production.rs"),
		)
		.into_bytes(),
	}
}
fn compression_registry(
	actions: Arc<Mutex<Vec<Action>>>,
) -> Result<omp_tool::Registry, omp_tool::RegistryError> {
	let mut registry = omp_tool::Registry::new();
	let claims =
		Claims { precedence: Precedence::CORE, claimant: sf!("omp/compress"), replaces: None };
	registry.register(RewriteTool::new(Arc::clone(&actions)), Presentation::Slot, claims.clone())?;
	registry.register(ApproveTool::new(actions), Presentation::Slot, claims)?;
	Ok(registry)
}

fn param_event(error: ParamError) -> Ev<Ack, Ack, ToolFault> {
	match error {
		ParamError::Args(issue) => Ev::Args(*issue),
		ParamError::Interrupted(interrupt) => {
			Ev::Aborted(Abort::Interrupted { reason: interrupt.reason })
		},
		ParamError::Protocol(message) => Ev::Args(protocol_issue(message)),
	}
}

fn commit_event(error: CommitError) -> Ev<Ack, Ack, ToolFault> {
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
		expected: sf!("one committed JSON argument object"),
		kind:     ArgIssueKind::Protocol,
		example:  None,
		found:    Some(message),
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn production_registry_advertises_only_protocol_tools() {
		fn assert_host<H: CompressHost>() {}
		assert_host::<ProductionCompressHost>();
		let registry =
			compression_registry(Arc::new(Mutex::new(Vec::new()))).expect("restricted registry");
		let projection = registry.prompt_projection(None);
		let names = projection
			.entries()
			.map(|entry| entry.name.as_str())
			.collect::<Vec<_>>();
		assert_eq!(names, ["approve", "rewrite"]);
		assert_eq!(super::super::ISOLATION_POLICY.tools, ["rewrite", "approve"]);
	}
}
