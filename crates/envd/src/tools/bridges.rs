//! Composition bridges and per-invocation tool scope.

use std::{
	collections::BTreeSet,
	future::Future,
	path::{Path, PathBuf},
	sync::Arc,
};

use futures::StreamExt as _;
use omp_cache::telemetry_cache::TelemetryIndex;
use omp_core::Str;
#[cfg(test)]
use omp_core::sf;
use omp_env::EnvClient;
use omp_proto::{inference::v1, thread::v1::Blob};
use omp_tool::{
	Claims, Ev, ExecutionMode, FetchEffects, IncomingParams, Presentation, Registry, Rev, Tool,
	ToolSpec, ToolTerminal,
};
use omp_tools::{
	goal,
	read::{
		Fault as ReadFault,
		resolver::{ResourceCompletion, ResourceList, SchemeEntry},
		selector::ParsedSelector,
	},
};
use serde_json::Value as JsonValue;

use crate::{
	approval_relay::OwnedApprovals, forge_url::ForgeCredentialBridge,
	reflection_relay::OwnedReflection,
};

tokio::task_local! {
	static PTY_DENIED: bool;
	static INVOCATION_SESSION_ID: Option<Str>;
	static OUTPUT_REQUEST: omp_tool::OutputRequest;
	static EDIT_REPAIR_CONTEXT: InvocationEditRepairContext;
	static ACP_BACKENDS: InvocationAcpBackends;
	static INVOCATION_APPROVALS: Option<OwnedApprovals>;
	static INVOCATION_REFLECTION: Option<OwnedReflection>;
}
/// Session-owned edit repair capability scoped to one native invocation.
#[derive(Clone, Default)]
pub(crate) struct InvocationEditRepairContext {
	repair: Option<omp_tools::edit::observer::EditRepairClient>,
	model:  Option<Str>,
}

impl InvocationEditRepairContext {
	/// Captures the invoking connection's optional repair route and model tag.
	pub(crate) fn new(
		repair: Option<omp_tools::edit::observer::EditRepairClient>,
		model: Option<Str>,
	) -> Self {
		Self { repair, model }
	}
}
/// Editor-owned capabilities authenticated by the invoking Environment
/// connection.
#[derive(Clone, Default)]
pub(crate) struct InvocationAcpBackends {
	documents: Option<crate::editor_base::EditorRoute>,
}

impl InvocationAcpBackends {
	pub(crate) const fn new(documents: Option<crate::editor_base::EditorRoute>) -> Self {
		Self { documents }
	}
}

/// Composition-supplied capabilities the environment host cannot own.
#[derive(Default)]
pub struct RegistryBridges {
	/// Constructs the command-backed credential executor after the environment
	/// client is available.
	pub command_credentials:    Option<Arc<dyn CommandCredentialExecutorFactory>>,
	/// Extra device tools registered verbatim by the composition layer.
	pub dynamic_tools:          Vec<DynamicTool>,
	/// Host tool factories registered before and bound after client creation.
	pub dynamic_tool_factories: Vec<Arc<dyn DynamicToolFactory>>,
	/// Internal-URL resolvers installed into the read resolver table.
	pub url_resolvers:          Vec<Arc<dyn ContentResolver>>,
	/// Goal authority backing the `goal` tool.
	pub goal_control:           Option<Arc<dyn GoalAuthority>>,
	/// Auxiliary inference used by workspace search and media tools.
	pub search:                 Option<Arc<dyn SearchInference>>,
	/// Active model identity captured by edit regression observation.
	pub edit_model:             Option<Str>,
	/// Typed small-model completion bridge for validated edit auto-repair.
	pub edit_repair:            Option<omp_tools::edit::observer::EditRepairClient>,
	/// Host-resource broker used by composition-owned internal resource URLs.
	pub host_resources:         Option<Arc<dyn HostResources>>,
	/// Live session routing authority for `agent://`, `history://`, and
	/// attachments.
	pub session_authority:      Option<Arc<dyn omp_contract::SessionAuthority>>,
	/// Background telemetry delivery started once credentials exist.
	pub telemetry_upload:       Option<Arc<dyn TelemetryUpload>>,
	/// Fallback presenter for interactive `ask` invocations.
	///
	/// The daemon defaults to [`omp_tools::ask::HeadlessPresenter`]; an
	/// interactive composition supplies its own terminal presenter, and a live
	/// session may rebind one later through `bind_ask_presenter`.
	pub ask_presenter:          Option<Arc<dyn omp_tools::ask::AskPresenter>>,
	/// Plain data: active project content and native roots.
	pub content:                ActiveContentInputs,
	/// Built-ins this composition installs.
	///
	/// `None` installs the full production roster. `compose_kernel` sets the
	/// production roster explicitly. A test crate adds a
	/// [`omp_tools::roster::RosterExtension`].
	pub selected_roster:        Option<omp_tools::roster::SelectedRoster>,
}

/// Builds the command credential executor from the live Environment client.
pub trait CommandCredentialExecutorFactory: Send + Sync + 'static {
	/// Creates one executor rooted at the active project workspace.
	fn make(
		&self,
		client: omp_env::EnvClient,
		cwd: &Path,
	) -> Arc<dyn omp_ai::auth::command::CommandCredentialExecutor>;
}
/// Registers host-owned tools before registry freeze, then binds their live
/// Environment client after transport composition.
pub trait DynamicToolFactory: Send + Sync + 'static {
	/// Registers every declaration-backed tool using factory-retained slots.
	fn register(&self, registry: &mut Registry) -> Result<(), omp_tool::RegistryError>;
	/// Binds the live Environment process/data authority exactly once.
	fn bind(&self, client: EnvClient, root: &Path);
}

/// One composition-owned device tool and its admission facts.
pub struct DynamicTool {
	register: Box<dyn FnOnce(&mut Registry) -> Result<(), omp_tool::RegistryError> + Send + 'static>,
}

impl DynamicTool {
	/// Erases one concrete tool only at the startup registration boundary.
	pub fn new<T>(tool: T, presentation: Presentation, claims: Claims) -> Self
	where
		T: Tool,
	{
		Self {
			register: Box::new(move |registry| {
				register_instrumented(registry, tool, presentation, claims)
			}),
		}
	}

	pub(super) fn register(self, registry: &mut Registry) -> Result<(), omp_tool::RegistryError> {
		(self.register)(registry)
	}
}

struct InstrumentedTool<T> {
	inner: T,
}

impl<T> Tool for InstrumentedTool<T>
where
	T: Tool,
{
	type Fault = T::Fault;
	type Params = T::Params;
	type Payload = T::Payload;
	type Update = T::Update;

	const ARGUMENT_SCOPED_EFFECTS: bool = T::ARGUMENT_SCOPED_EFFECTS;

	fn spec(&self) -> &ToolSpec {
		self.inner.spec()
	}

	fn execution_mode(&self) -> ExecutionMode {
		self.inner.execution_mode()
	}

	fn invocation_effects(&self, params: &Self::Params) -> Option<omp_tool::Effects> {
		self.inner.invocation_effects(params)
	}

	fn fetch_locators(&self, params: &Self::Params) -> Vec<Str> {
		self.inner.fetch_locators(params)
	}

	fn prompt_examples(&self) -> &[omp_tool::ToolPromptExample] {
		self.inner.prompt_examples()
	}

	fn prompt_docs(&self) -> Option<&str> {
		self.inner.prompt_docs()
	}

	fn call<'c>(
		&'c self,
		params: IncomingParams<'c>,
	) -> impl futures::Stream<Item = Ev<Self::Update, Self::Payload, Self::Fault>> + Send + 'c {
		let spec = self.inner.spec();
		let span = tracing::debug_span!(
			"tool_invocation",
			tool = %spec.name,
			revision = %spec.rev,
			outcome = tracing::field::Empty,
		);
		let events = self.inner.call(params);
		async_stream::stream! {
			tokio::pin!(events);
			while let Some(event) = events.next().await {
				match &event {
					Ev::Done(ToolTerminal::Done { result: Ok(_), .. }) => {
						span.record("outcome", "success");
					},
					Ev::Done(ToolTerminal::Done { result: Err(_), .. }) => {
						span.record("outcome", "fault");
						tracing::warn!(
							parent: &span,
							outcome = "fault",
							"tool invocation returned error verdict"
						);
					},
					Ev::Done(ToolTerminal::Detached(_)) => {
						span.record("outcome", "detached");
					},
					Ev::Args(_) => {
						span.record("outcome", "invalid_arguments");
					},
					Ev::Aborted(_) => {
						span.record("outcome", "aborted");
					},
					Ev::Update(_) | Ev::Diag(_) => {},
				}
				yield event;
			}
		}
	}

	fn prompt(
		&self,
		view: Result<&Self::Payload, &Self::Fault>,
		caps: &omp_tool::PromptCaps,
	) -> Vec<omp_tool::Part> {
		self.inner.prompt(view, caps)
	}

	fn projection(
		&self,
		view: Result<&Self::Payload, &Self::Fault>,
		caps: &omp_tool::PromptCaps,
	) -> omp_tool::PromptProjection {
		self.inner.projection(view, caps)
	}

	fn authorize_visibility(
		&self,
		view: Result<&Self::Payload, &Self::Fault>,
		receipt: &omp_tool::VisibilityReceipt,
	) -> Result<(), omp_tool::ProjectionAuthorizationError> {
		self.inner.authorize_visibility(view, receipt)
	}

	fn stream_match_text(&self, arguments: &JsonValue) -> Option<Vec<omp_tool::StreamMatchText>> {
		self.inner.stream_match_text(arguments)
	}

	fn invoke_input(
		&self,
		update: &Self::Update,
		invocation_id: &str,
	) -> Option<omp_proto::inference::v1::InvokeInput> {
		self.inner.invoke_input(update, invocation_id)
	}

	fn lift(&self, from: &Rev, call: omp_tool::RecordedCall<'_>) -> Option<omp_tool::LiftedCall> {
		self.inner.lift(from, call)
	}
}

pub(super) fn register_instrumented<T: Tool>(
	registry: &mut Registry,
	tool: T,
	presentation: Presentation,
	claims: Claims,
) -> Result<(), omp_tool::RegistryError> {
	Registry::register(registry, InstrumentedTool { inner: tool }, presentation, claims)
}
/// Registers one concrete executor in the authoritative environment half.
pub(crate) fn environment_registry<T: Tool>(
	registry: &mut Registry,
	tool: T,
	presentation: Presentation,
	claims: Claims,
) -> Result<(), omp_tool::RegistryError> {
	registry.register_environment(InstrumentedTool { inner: tool }, presentation, claims)
}

/// Active project content used to configure environment-owned tool resolvers.
#[derive(Default)]
pub struct ActiveContentInputs {
	/// Skill names authored outside the managed provider.
	pub authored_skills:     BTreeSet<Str>,
	/// Managed-skill authority root.
	pub managed_skills_root: Option<PathBuf>,
	/// Agent Plugins package roots beside the scanned plugin directories
	/// (explicitly named ones and marketplace installs), whose data-only MCP
	/// declarations join automatic discovery at their origin's scope.
	pub agent_plugin_roots:  Vec<crate::mcp::AgentPluginRoot>,
	/// The operator's plugin command approvals: an Agent Plugins stdio MCP
	/// server starts only when its launch is approved. Empty approves
	/// nothing.
	pub command_approvals:   omp_ext::plugin_command::CommandApprovals,
	/// Installed, enabled Claude-layout marketplace plugins whose MCP
	/// declarations join automatic project discovery and whose LSP and DAP
	/// declarations reach the document authority's rosters.
	pub claude_plugins:      Arc<[omp_ext::claude_plugin::ClaudePlugin]>,
	/// The workspace trust decision this environment loads project inputs
	/// under: project MCP servers, LSP/DAP configuration, hosts and vaults.
	/// Untrusted (fail closed) unless the composition decided otherwise.
	pub workspace_trust:     omp_ext::workspace_trust::WorkspaceTrust,
}

/// Object-safe composition boundary for one active internal-URL resolver.
///
/// This mirrors the cold resolver-table calls because
/// [`read::resolver::Resolve`] uses return-position `impl Future`
/// and therefore cannot be used as a trait object.
#[async_trait::async_trait]
pub trait ContentResolver: Send + Sync + 'static {
	/// Returns the scheme metadata installed with this resolver.
	fn entry(&self) -> SchemeEntry;

	/// Reads one addressed resource.
	async fn read(
		&self,
		resource: &str,
		selector: &ParsedSelector,
	) -> Result<omp_core::CowBytes<'static>, ReadFault>;

	/// Reads one addressed resource while preserving its query.
	async fn read_query(
		&self,
		resource: &str,
		query: Option<&str>,
		selector: &ParsedSelector,
	) -> Result<omp_core::CowBytes<'static>, ReadFault> {
		let _ = query;
		self.read(resource, selector).await
	}

	/// Lists direct entries below one resource.
	async fn list(
		&self,
		_resource: &str,
		_max_entries: usize,
		_max_bytes: usize,
	) -> Result<ResourceList, ReadFault> {
		Err(ReadFault::Invalid { message: Str::new_static("This resource cannot be listed.") })
	}

	/// Resolves one resource to an Environment URI without reading bytes.
	async fn path(&self, _resource: &str) -> Result<Option<Str>, ReadFault> {
		Err(ReadFault::Invalid {
			message: Str::new_static("This resource has no materializable path."),
		})
	}

	/// Returns bounded local completion candidates.
	async fn complete(
		&self,
		_query: &str,
		_max_results: usize,
	) -> Result<Vec<ResourceCompletion>, ReadFault> {
		Ok(Vec::new())
	}
}

/// Object-safe goal authority supplied by composition.
///
/// This exists because [`goal::GoalControl`] requires `Clone` and
/// uses return-position `impl Future`, so that tools trait is not
/// dyn-compatible.
#[async_trait::async_trait]
pub trait GoalAuthority: Send + Sync + 'static {
	/// Applies one validated goal operation.
	async fn apply(
		&self,
		params: omp_tools::goal::Params,
	) -> Result<Option<omp_tools::goal::Goal>, goal::Fault>;
}

/// Auxiliary inference used by workspace search and media tools.
#[async_trait::async_trait]
pub trait SearchInference: Send + Sync + 'static {
	/// Performs one web-search request.
	async fn search(
		&self,
		request: v1::SearchRequest,
	) -> Result<v1::SearchResponse, omp_tools::web_search::BackendError>;

	/// Generates or edits images and returns the final blobs.
	async fn generate_image(
		&self,
		request: v1::GenerateImageRequest,
	) -> Result<Vec<Blob>, omp_tools::web_search::BackendError>;

	/// Synthesizes speech and returns the encoded bytes in wire order.
	async fn speak(
		&self,
		request: v1::SpeakRequest,
	) -> Result<Vec<u8>, omp_tools::web_search::BackendError>;
}

/// One host-resource resolution result.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct HostResourceResult {
	/// Optional resolved UTF-8 body.
	pub content: Option<String>,
	/// Human-readable resolution notes.
	pub notes:   Vec<String>,
}

/// Declaration-based judgment for a host URI (ADR 0050 D5 / S3).
///
/// [`Self::Unknown`] names the omit-fetch+credentials case as
/// `Effects::unknown()` **facts** at this API. Live `read@3` Foreign admission
/// stays subset-safe: only [`Self::Fetch`] contributes fetch effects.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HostUriJudgment {
	/// Spelling is not in the live generation.
	Undeclared,
	/// Reserved; not constructed in S3 (not the omit-fetch case).
	Local,
	/// Declared scheme whose extension has fetch capability.
	Fetch(FetchEffects),
	/// Declared scheme whose fold carried no fetch (and no credentials-alone
	/// Fetch). Maps to `Effects::unknown()` facts for the D5 regression.
	Unknown,
}

/// Broker resolving composition-owned internal resources.
#[async_trait::async_trait]
pub trait HostResources: Send + Sync + 'static {
	/// Resolves one host-owned resource read.
	async fn resolve_read(&self, url: &str) -> Result<HostResourceResult, Str>;

	/// Writes one host-owned resource.
	async fn resolve_write(&self, url: &str, content: String) -> Result<HostResourceResult, Str>;

	/// Declaration-based effect judgment for `url` (ADR 0050 D5).
	///
	/// Default: [`HostUriJudgment::Undeclared`].
	fn judge(&self, url: &str) -> HostUriJudgment {
		let _ = url;
		HostUriJudgment::Undeclared
	}
}

/// Starts background telemetry delivery once the credential bridge exists.
pub trait TelemetryUpload: Send + Sync + 'static {
	/// Starts delivery for one Environment telemetry index.
	fn start(&self, index: Arc<TelemetryIndex>, credentials: Arc<ForgeCredentialBridge>);
}

/// Runs one native tool stream under its authenticated invocation restrictions.
pub(crate) async fn with_invocation_scope<T>(
	pty_denied: bool,
	future: impl Future<Output = T>,
) -> T {
	PTY_DENIED.scope(pty_denied, future).await
}

/// Runs one native tool stream with its caller-selected output policy.
///
/// The value is intent only: host implementations always retain their fixed
/// security ceiling.
pub(crate) async fn with_output_request_scope<T>(
	request: omp_tool::OutputRequest,
	future: impl Future<Output = T>,
) -> T {
	OUTPUT_REQUEST.scope(request, future).await
}

/// Runs one native registry stream with its authenticated durable session
/// principal. `None` deliberately represents an invocation without a principal.
pub(crate) async fn with_invocation_session_scope<T>(
	session_id: Option<Str>,
	future: impl Future<Output = T>,
) -> T {
	INVOCATION_SESSION_ID.scope(session_id, future).await
}
/// Runs one native tool stream with its invoking connection's edit repair
/// route.
pub(crate) async fn with_edit_repair_scope<T>(
	context: InvocationEditRepairContext,
	future: impl Future<Output = T>,
) -> T {
	EDIT_REPAIR_CONTEXT.scope(context, future).await
}

/// Runs one native tool stream with editor capabilities from its invoking
/// connection.
pub(crate) async fn with_acp_scope<T>(
	context: InvocationAcpBackends,
	future: impl Future<Output = T>,
) -> T {
	ACP_BACKENDS.scope(context, future).await
}

/// Runs one native tool stream with its invoking connection's approval relay,
/// so the commands it issues prompt that connection.
pub async fn with_invocation_approvals<T>(
	approvals: Option<OwnedApprovals>,
	future: impl Future<Output = T>,
) -> T {
	INVOCATION_APPROVALS.scope(approvals, future).await
}

/// Runs one tool stream with the reflection relay of the connection that
/// issued it, so a `reflect` it runs synthesizes on that connection's session.
pub(crate) async fn with_invocation_reflection<T>(
	reflection: Option<OwnedReflection>,
	future: impl Future<Output = T>,
) -> T {
	INVOCATION_REFLECTION.scope(reflection, future).await
}

/// Which editor binding governs the current call.
pub enum InvocationEditor {
	/// An invocation over an environment connection: only that connection's
	/// binding, if it made one. A connection never reaches another
	/// connection's editor, which keeps subagents (their own compositions)
	/// off the parent's editor.
	Connection(Option<crate::editor_base::EditorRoute>),
	/// An in-process native call by the composition's own kernel.
	InProcess,
}

/// Classifies the current call for editor access.
pub fn invocation_acp_documents() -> InvocationEditor {
	ACP_BACKENDS
		.try_with(|context| context.documents.clone())
		.map_or(InvocationEditor::InProcess, InvocationEditor::Connection)
}

/// Returns the caller-selected output policy for the current invocation.
pub(crate) fn invocation_output_request() -> omp_tool::OutputRequest {
	OUTPUT_REQUEST
		.try_with(|request| *request)
		.unwrap_or(omp_tool::OutputRequest::Bounded)
}

/// Returns the approval relay of the connection that issued the current
/// native invocation; `None` outside one, or when that connection relays no
/// approvals.
pub fn invocation_approvals() -> Option<OwnedApprovals> {
	INVOCATION_APPROVALS.try_with(Clone::clone).ok().flatten()
}

/// Returns the reflection relay of the connection that issued the current
/// call; `None` outside one, or when that connection relays no reflections.
pub(crate) fn invocation_reflection() -> Option<OwnedReflection> {
	INVOCATION_REFLECTION.try_with(Clone::clone).ok().flatten()
}

/// Returns the durable session principal for the current native invocation.
pub(crate) fn invocation_session_id() -> Option<Str> {
	INVOCATION_SESSION_ID.try_with(Clone::clone).ok().flatten()
}

pub(super) async fn invocation_edit_repair(
	prompt: omp_tools::edit::observer::EditRepairPrompt,
) -> Result<Str, omp_tools::edit::observer::EditRepairError> {
	let repair = EDIT_REPAIR_CONTEXT
		.try_with(|context| context.repair.clone())
		.ok()
		.flatten()
		.ok_or(omp_tools::edit::observer::EditRepairError::Unavailable)?;
	repair.complete(prompt).await
}

pub(super) fn invocation_edit_model() -> Option<Str> {
	EDIT_REPAIR_CONTEXT
		.try_with(|context| context.model.clone())
		.ok()
		.flatten()
}

/// Returns whether the current authenticated invocation denies PTY allocation.
pub(crate) fn pty_denied() -> bool {
	PTY_DENIED.try_with(|denied| *denied).unwrap_or(false)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[tokio::test]
	async fn invocation_edit_repair_is_unavailable_without_connection_capability() {
		let result = with_edit_repair_scope(
			InvocationEditRepairContext::default(),
			invocation_edit_repair(omp_tools::edit::observer::EditRepairPrompt {
				language:         sf!("rust"),
				before:           Str::new_static("fn ok() {}"),
				after:            Str::new_static("fn bad( {}"),
				previous_attempt: None,
			}),
		)
		.await;
		assert_eq!(result, Err(omp_tools::edit::observer::EditRepairError::Unavailable));
	}

	#[tokio::test]
	async fn invocation_edit_models_are_task_local() {
		let first = with_edit_repair_scope(
			InvocationEditRepairContext::new(None, Some(sf!("model-a"))),
			async { invocation_edit_model() },
		);
		let second = with_edit_repair_scope(
			InvocationEditRepairContext::new(None, Some(sf!("model-b"))),
			async { invocation_edit_model() },
		);
		let (first, second) = tokio::join!(first, second);
		assert_eq!(first, Some(sf!("model-a")));
		assert_eq!(second, Some(sf!("model-b")));
		assert_eq!(invocation_edit_model(), None);
	}
}
