//! Production composition for the journal-first headless agent kernel.

use std::{
	fs,
	path::{Path, PathBuf},
	sync::Arc,
	time::{Duration, SystemTime, UNIX_EPOCH},
};

use bytes::Bytes;
use futures::StreamExt as _;
use omp_agent::{
	CanonicalPromptSource, DirectorRegistry, DispatchPolicy, ExtensionRegistrar,
	ExternalDispatchEvent, ExternalDispatchRequest, ExternalDispatchStream, ExternalToolExecutor,
	Kernel, RouteFacts, RuntimeFlags,
};
use omp_ai::{
	AnswerBody, Call, CallMeta, ChatEvent, ChatRequest, ChatStream, Client, ContentPart,
	ExecutionBudget, Message, NegotiationPolicy, OperationCall, ProviderService, RequestId, Role,
	Sampling, Setting, Target, router::Router,
};
use omp_core::{FastHashMap, Hash32, SecretString, Str, StrMut, Ulid, sf};
use omp_dom::{Op, PropKey, Txn, Value};
use omp_session::{ComponentRegistry, Session};
use omp_tool::{
	Abort, BlobRef as ToolBlobRef, CallOutcome, Claims, Part as ToolPart, Precedence, Presentation,
	Registry,
};
use omp_tools::output_schema::SchemaMode;
use parking_lot::{Mutex, RwLock};

#[path = "con_journal.rs"]
mod con_journal;

use super::{HeadlessError, gateway::GatewayInference};
use crate::registry::{
	InferenceSessionOverrides, ProductionInference as ProductionStack,
	production_inference_for_session,
};

/// Stable prompt projection overrides supplied by one invocation.
#[derive(Clone, Debug)]
pub struct PromptOverrides {
	/// Complete replacement for the customizable prompt bands.
	pub custom_prompt:          Option<Str>,
	/// Guidance appended after the stable prompt.
	pub append_prompt:          Option<Str>,
	/// Resolved personality prompt text.
	pub personality:            Option<Str>,
	/// Whether model identity is included.
	pub include_model:          Option<bool>,
	/// Whether workstation facts are included.
	pub include_workstation:    Option<bool>,
	/// Whether a bounded workspace tree is included.
	pub include_workspace_tree: Option<bool>,
	/// Whether Mermaid guidance is included.
	pub render_mermaid:         Option<bool>,
	/// Whether enabled skills are included.
	pub include_skills:         Option<bool>,
	/// Whether all provider prompt bands are bypassed.
	pub null_prompt:            bool,
	/// Whether discovered context files (AGENTS.md and friends) are included
	/// (`--no-context-files`).
	pub include_context_files:  bool,
	/// Whether discovered rules (`.omp/rules`, `RULES.md`, `.cursor/rules`, …)
	/// are included (`--no-rules`).
	pub include_rules:          bool,
	/// Additional workspace roots the prompt names beside the project.
	pub additional_roots:       Vec<PathBuf>,
}

impl Default for PromptOverrides {
	fn default() -> Self {
		Self {
			custom_prompt:          None,
			append_prompt:          None,
			personality:            None,
			include_model:          None,
			include_workstation:    None,
			include_workspace_tree: None,
			render_mermaid:         None,
			include_skills:         None,
			null_prompt:            false,
			include_context_files:  true,
			include_rules:          true,
			additional_roots:       Vec::new(),
		}
	}
}

/// Native extension-root composition for one invocation.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum NativeExtensionMode {
	/// Merge explicit roots with configured roots.
	#[default]
	Merge,
	/// Admit only explicit roots.
	ExplicitOnly,
	/// Disable native extension discovery.
	Disabled,
}

/// Driver-owned extension policy supplied by one invocation.
#[derive(Clone, Debug)]
pub struct LaunchExtensionPolicy {
	/// Ordered explicit native extension roots.
	pub native_roots:      Vec<PathBuf>,
	/// How explicit roots compose with configured roots.
	pub native_mode:       NativeExtensionMode,
	/// Whether workspace-owned roots participate.
	pub include_workspace: bool,
	/// Exact operator-trusted Python extension hosts.
	pub trusted:           Vec<omp_envd::worker::ExtHostSpec>,
	/// Declaration-owned CLI values delivered at activation.
	pub contributed:       Vec<omp_ext::config::ContributedCliValue>,
	/// Manifest setting overrides applied before environment attachment.
	pub setting_overrides: Vec<omp_ext::config::CliSettingOverride>,
}

impl Default for LaunchExtensionPolicy {
	fn default() -> Self {
		Self {
			native_roots:      Vec::new(),
			native_mode:       NativeExtensionMode::Merge,
			include_workspace: true,
			trusted:           Vec::new(),
			contributed:       Vec::new(),
			setting_overrides: Vec::new(),
		}
	}
}

/// Session selection and invocation-local production options.
#[derive(Clone, Default)]
pub struct KernelOptions {
	/// Resume the newest journal in the project session directory.
	pub continue_session:   bool,
	/// Open this exact journal path or session id.
	pub session:            Option<PathBuf>,
	/// Fork this journal path or session id into a fresh durable session.
	pub fork:               Option<PathBuf>,
	/// Override the project-native durable session directory.
	pub sessions_dir:       Option<PathBuf>,
	/// Create the journal in the system temporary directory.
	pub ephemeral:          bool,
	/// Disable every project tool while retaining normal inference discovery.
	pub no_tools:           bool,
	/// Restrict the registry to these validated stable tool names.
	pub tools:              Option<Vec<Str>>,
	/// Enable the Python evaluation tool in the project environment.
	pub py_eval:            bool,
	/// Detached environment daemon idle timeout.
	pub spawn_idle_timeout: Option<u64>,
	/// Invocation-only provider API key.
	pub api_key:            Option<SecretString>,
	/// Invocation-only approval policy.
	pub approval_mode:      Option<omp_envd::tool_settings::ApprovalMode>,
	/// Whether `model_selector` came from an explicit `--model`.
	pub model_override:     bool,
	/// Stable prompt projection overrides.
	pub prompt:             PromptOverrides,
	/// Skill discovery snapshot shared with an interactive command host.
	pub discovered_skills:  Option<Arc<crate::discovery::skills::ActiveSkills>>,
	/// Invocation extension policy.
	pub extensions:         LaunchExtensionPolicy,
	/// Optional provider routing constraint.
	pub provider:           Option<omp_catalog::ProviderId>,
	/// Connected inference gateway used instead of local provider composition.
	pub gateway:            Option<tonic::transport::Channel>,
	/// Process-local live-session routing authority.
	pub sessions:           Option<Arc<crate::sessions::SessionRegistry>>,
	/// Human-readable routing name for this kernel.
	pub session_name:       Option<Str>,
	/// Authenticated parent session id or routing name for a child kernel.
	pub parent_session:     Option<Str>,
	/// Explicit restricted registry for specialized child compositions.
	pub tool_registry:      Option<Arc<Registry>>,
	/// Child-specific structured output schema installed on `yield@2`.
	pub output_schema:      Option<serde_json::Value>,
	/// Enforcement mode for the child-specific output schema.
	pub schema_mode:        Option<SchemaMode>,
	/// Deny PTY-backed shell sessions to every tool (`--no-pty`).
	pub no_pty:             bool,
	/// Invocation-scoped provider prompt-cache identity (`--prompt-cache-key`).
	pub prompt_cache_key:   Option<Str>,
	/// Invocation-scoped provider session identity (`--provider-session-id`).
	pub provider_session:   Option<Str>,
}

/// Removes a no-session journal and its private blob/local/temp namespace
/// regardless of which presentation adapter or error path drops the composed
/// kernel.
pub struct EphemeralJournal {
	root: PathBuf,
}

impl Drop for EphemeralJournal {
	fn drop(&mut self) {
		if let Err(error) = fs::remove_dir_all(&self.root)
			&& error.kind() != std::io::ErrorKind::NotFound
		{
			tracing::warn!(
				session_root = %self.root.display(),
				%error,
				"ephemeral session cleanup failed"
			);
		}
	}
}

/// Direct production inference client plus the authorities that keep its
/// environment and authentication stack alive.
pub struct ProductionInference {
	client:             Client<ProviderService, Router>,
	/// Call metadata as composed at launch; `ai_model` re-targets a copy.
	meta:               CallMeta,
	/// Model the client is currently targeted at.
	model:              omp_catalog::ModelKey,
	catalog:            Arc<omp_catalog::snapshot::Catalog>,
	_environment:       omp_envd::ProjectEnvironment,
	_agent_control:     Mutex<Option<omp_envd::AgentControlBinding>>,
	_stack:             ProductionStack,
	con:                Arc<omp_con::Ctx>,
	_python_components: Vec<omp_envd::exthost::PyComponent>,
	_eval_parent:       Option<omp_envd::eval::ParentBindingLease>,
	_ephemeral_journal: Option<EphemeralJournal>,
}

impl ProductionInference {
	/// The catalog model `ai_model` currently selects (role selectors such
	/// as `@plan` resolve through the launch roles), else the launch model.
	fn selected_model(&self) -> Str {
		let selector = omp_agent::AI_MODEL.get(&self.con);
		if selector.is_empty() {
			return Str::new(self.model.as_str());
		}
		if let Ok(model) = resolve_model_selector(self.catalog.as_ref(), selector.as_str()) {
			return model;
		}
		let settings = omp_catalog::settings::ModelSettings::from_con(&self.con);
		crate::discovery::roles::resolve_role_selector(
			self.catalog.as_ref(),
			&settings,
			selector.as_str(),
		)
		.map_or_else(|_| Str::new(self.model.as_str()), |selected| Str::new(selected.model.as_str()))
	}

	/// Catalog facts for the model the next request targets (R2 #10: `/model`
	/// switches must not leave compaction, vision, or tool lowering on the
	/// launch model).
	fn route_facts(&self) -> Option<RouteFacts> {
		let model = self.selected_model();
		let spec = self
			.catalog
			.model(omp_catalog::ModelKey::from_ref(model.as_str()))?;
		Some(route_facts(self.catalog.as_ref(), spec))
	}

	/// Applies the control plane to the next call: `ai_model` re-targets the
	/// client when it names a different catalog model (ADR 0012: the convar
	/// is the live route), and `ai_thinking` sets the reasoning effort.
	fn apply_convars(&mut self, request: &mut ChatRequest) {
		let model = self.selected_model();
		if model.as_str() != self.model.as_str() {
			let key = omp_catalog::ModelKey::from(model.as_str());
			let mut meta = self.meta.clone();
			meta.target = match &self.meta.target {
				Target::Provider { provider, .. } => {
					Target::Provider { provider: provider.clone(), model: key.clone() }
				},
				_ => Target::Model(key.clone()),
			};
			self.client.set_call_meta(meta);
			self.model = key;
		}
		// Provider reasoning stays off; the kernel
		// advertises the hidden `think` tool instead.
		if omp_ai::settings::AI_EXTERNAL_THINKING.get(&self.con) {
			request.reasoning = omp_ai::Setting::Unset;
		} else if matches!(request.reasoning, omp_ai::Setting::Unset) {
			let thinking = omp_agent::AI_THINKING.get(&self.con);
			request.reasoning = convar_reasoning(self.catalog.as_ref(), &self.model, &thinking);
		}
		let provider = match &self.meta.target {
			Target::Provider { provider, .. } | Target::ProviderService(provider) => {
				Some(provider.as_str())
			},
			Target::Route { route, .. } | Target::RouteService(route) => self
				.catalog
				.route(route)
				.map(|route| route.provider.as_str()),
			Target::Model(_) => None,
		};
		omp_ai::settings::InferenceSettings::from_con(&self.con).apply_chat_request(
			request,
			provider,
			Some(model.as_str()),
			None,
		);
	}
}

/// Translates the `ai_thinking` convar into the canonical reasoning request
/// the catalog allows for `model` (ADR 0017: code branches on compiled
/// capabilities, never on model names).
///
/// The model's thinking policy and routing decide through
/// [`omp_catalog::ThinkingRouting::resolve`]: an effort above the ladder
/// clamps to the model ceiling, one between rungs clamps down, and `off` on a
/// model that cannot stop reasoning falls back to the catalog's default level
/// (or stays unset so the router applies `ai_default_thinking`). Models
/// without a thinking policy never carry a reasoning request; codecs then
/// spell the resolved effort per route (ADR 0022: one canonical request).
fn convar_reasoning(
	catalog: &omp_catalog::snapshot::Catalog,
	model: &omp_catalog::ModelKey<str>,
	thinking: &str,
) -> omp_ai::Setting<omp_ai::ReasoningRequest> {
	let Some(spec) = catalog.model(model) else {
		return omp_ai::Setting::Unset;
	};
	let Some(policy) = spec
		.thinking
		.as_ref()
		.and_then(|id| catalog.thinking_policy(id))
	else {
		return omp_ai::Setting::Unset;
	};
	let requested = match thinking.parse::<omp_catalog::ReasoningEffort>() {
		Ok(effort) => omp_catalog::ThinkingEffort::from(effort),
		Err(_) => {
			tracing::warn!(value = thinking, "ai_thinking is not a reasoning effort; ignored");
			return omp_ai::Setting::Unset;
		},
	};
	let wire_model = omp_catalog::WireModelId::from_ref(model.as_str());
	let effort = match spec
		.thinking_routing
		.resolve(policy, Some(requested), wire_model)
	{
		Ok(selection) => selection.effort,
		Err(_) => match policy.default_level {
			Some(level) => level,
			None => return omp_ai::Setting::Unset,
		},
	};
	omp_ai::Setting::Prefer(omp_ai::ReasoningRequest {
		visibility:          omp_ai::ReasoningVisibility::Visible,
		effort:              Some(effort.into()),
		max_tokens:          None,
		preserve_signatures: true,
	})
}

/// Environment-routed tool execution: opens the invocation on the project
/// environment, commits the arguments, and answers the environment's
/// admission query by prompting the session's approval authority.
#[derive(Clone)]
pub struct EnvToolExecutor {
	client:    omp_env::EnvClient,
	approvals: omp_agent::ApprovalRoute,
}

impl EnvToolExecutor {
	/// Executes environment tools for `client`; every admission query the
	/// environment raises (an `--approval-mode` tier above the call's
	/// policy) becomes one prompt on `approvals`.
	#[must_use]
	pub const fn new(client: omp_env::EnvClient, approvals: omp_agent::ApprovalRoute) -> Self {
		Self { client, approvals }
	}
}

const OUTCOME_REPLICATION_ATTEMPTS: usize = 3;

#[derive(Debug, thiserror::Error)]
enum OutcomeReplicationError {
	#[error(transparent)]
	Client(#[from] omp_env::ClientError),
	#[error(transparent)]
	Store(#[from] omp_journal::blob::Error),
	#[error("environment outcome retrieval was interrupted")]
	Interrupted,
	#[error("environment outcome identity changed during replication")]
	IdentityChanged,
	#[error("environment verdict media reference is invalid")]
	InvalidMedia,
	#[error("environment verdict media exceeds the host retrieval bound")]
	MediaTooLarge {
		/// Declared media byte length.
		size:  u64,
		/// Maximum accepted byte length.
		limit: u64,
	},
}

fn resumable_blob_error(error: &omp_env::ClientError) -> bool {
	matches!(
		error,
		omp_env::ClientError::TransportClosed
			| omp_env::ClientError::StreamLost(_)
			| omp_env::ClientError::IncompleteBlob
	)
}

async fn replicate_outcome_blob(
	client: &omp_env::EnvClient,
	session_store: &omp_journal::blob::BlobStore,
	invocation_id: &str,
	expected_hash: Hash32,
	expected_size: u64,
	max_bytes: u64,
	cancel: &tokio_util::sync::CancellationToken,
) -> Result<omp_journal::blob::BlobRef, OutcomeReplicationError> {
	let mut stage = session_store.begin_put()?;
	let mut transfer = omp_env::ResumableBlobTransfer::new(expected_hash, expected_size, max_bytes)?;

	for attempt in 0..OUTCOME_REPLICATION_ATTEMPTS {
		let download = match client
			.blob_get_for_invocation(invocation_id, transfer.request())
			.await
		{
			Ok(download) => download,
			Err(source)
				if resumable_blob_error(&source) && attempt + 1 < OUTCOME_REPLICATION_ATTEMPTS =>
			{
				continue;
			},
			Err(source) => return Err(source.into()),
		};
		let received = tokio::select! {
			biased;
			() = cancel.cancelled() => return Err(OutcomeReplicationError::Interrupted),
			received = transfer.receive(download, &mut stage) => received,
		};
		match received {
			Ok(Some(_)) => break,
			Ok(None) => {},
			Err(source)
				if resumable_blob_error(&source) && attempt + 1 < OUTCOME_REPLICATION_ATTEMPTS =>
			{
				continue;
			},
			Err(source) => return Err(source.into()),
		}
	}

	if !transfer.is_complete() {
		return Err(omp_env::ClientError::IncompleteBlob.into());
	}
	let reference = stage.finish()?;
	if reference.hash != expected_hash || reference.size != expected_size {
		return Err(OutcomeReplicationError::IdentityChanged);
	}
	Ok(reference)
}

fn valid_blob_media_type(media_type: &str) -> bool {
	if media_type.bytes().any(|byte| byte.is_ascii_control()) {
		return false;
	}
	let essence = media_type.split(';').next().unwrap_or_default().trim();
	let Some((kind, subtype)) = essence.split_once('/') else {
		return false;
	};
	!kind.is_empty()
		&& !subtype.is_empty()
		&& !essence.bytes().any(|byte| byte.is_ascii_whitespace())
}

async fn replicate_verdict_parts(
	client: &omp_env::EnvClient,
	session_store: &omp_journal::blob::BlobStore,
	invocation_id: &str,
	parts: Vec<omp_proto::thread::v1::Part>,
	max_bytes: u64,
	cancel: &tokio_util::sync::CancellationToken,
) -> Result<Vec<ToolPart>, OutcomeReplicationError> {
	let mut replicated = FastHashMap::<Hash32, u64>::default();
	let mut projected = Vec::with_capacity(parts.len());
	for mut part in parts {
		let Some(omp_proto::thread::v1::part::Kind::Blob(blob)) = part.kind.as_mut() else {
			if let Some(part) = tool_part(part) {
				projected.push(part);
			}
			continue;
		};
		if cancel.is_cancelled() {
			return Err(OutcomeReplicationError::Interrupted);
		}
		if !valid_blob_media_type(&blob.mime) {
			return Err(OutcomeReplicationError::InvalidMedia);
		}
		if blob.size > max_bytes {
			return Err(OutcomeReplicationError::MediaTooLarge { size: blob.size, limit: max_bytes });
		}
		let reference = if blob.inline.is_empty() {
			let hash: [u8; 32] = blob
				.hash
				.as_ref()
				.try_into()
				.map_err(|_| OutcomeReplicationError::InvalidMedia)?;
			omp_journal::blob::BlobRef { hash: Hash32::new(hash), size: blob.size }
		} else {
			let size = u64::try_from(blob.inline.len()).unwrap_or(u64::MAX);
			if size != blob.size {
				return Err(OutcomeReplicationError::InvalidMedia);
			}
			let hash = Hash32::sum(&blob.inline);
			if !blob.hash.is_empty() && blob.hash.as_ref() != hash.as_bytes() {
				return Err(OutcomeReplicationError::InvalidMedia);
			}
			let reference = session_store.put(&blob.inline)?;
			blob.hash = Bytes::copy_from_slice(reference.hash.as_bytes());
			blob.inline = Bytes::new();
			reference
		};
		if let Some(previous_size) = replicated.insert(reference.hash, reference.size) {
			if previous_size != reference.size {
				return Err(OutcomeReplicationError::IdentityChanged);
			}
		} else if session_store.has(&reference) {
			if !session_store.verify(&reference)? {
				return Err(OutcomeReplicationError::IdentityChanged);
			}
		} else {
			let replicated = replicate_outcome_blob(
				client,
				session_store,
				invocation_id,
				reference.hash,
				reference.size,
				max_bytes,
				cancel,
			)
			.await?;
			if replicated != reference {
				return Err(OutcomeReplicationError::IdentityChanged);
			}
		}
		if let Some(part) = tool_part(part) {
			projected.push(part);
		}
	}
	Ok(projected)
}

/// An admission query presents the exact `bash` command, or the tool name and
/// its committed arguments for other tools.
fn admission_spec(
	request: &ExternalDispatchRequest,
	query: &omp_env::frame::AdmitInvocation,
) -> omp_agent::ApprovalSpec {
	let name = request.identity.name.as_str();
	let (kind, subject) = match query.bash.as_ref() {
		Some(bash) => ("exec", Str::new(bash.source.as_str())),
		None => ("tool", Str::new(name)),
	};
	let args = request.args.get();
	let body = match query.bash.as_ref() {
		Some(bash) => sf!("$ {}", bash.source),
		None => sf!("{name} {}", args.chars().take(512).collect::<String>()),
	};
	omp_agent::ApprovalSpec {
		title: sf!("Run {name}"),
		body,
		subject,
		kind: Str::new_static(kind),
		scopes: vec![Str::new_static("once"), Str::new_static("session")],
		default: Some(false),
		route: Str::new_static("user"),
		approver: None,
		timeout_ms: query.deadline_ms,
		unreachable: Str::new_static("deny"),
		require_human: true,
		pattern: None,
		evidence: vec![sf!("tool `{name}` requires approval under the session approval mode")],
	}
}

/// Resolves native-tool approval from the declared effect tier, session
/// approval mode, and per-tool overrides.
pub struct SettingsAdmission {
	settings: omp_envd::tool_settings::ToolSettings,
}

impl SettingsAdmission {
	/// Resolves the policy from the effective control plane plus the
	/// invocation's `--approval-mode` override.
	#[must_use]
	pub fn new(
		ctx: &omp_con::Ctx,
		approval_mode: Option<omp_envd::tool_settings::ApprovalMode>,
	) -> Self {
		Self {
			settings: omp_envd::tool_settings::ToolSettings::from_con(ctx)
				.with_approval_mode_override(approval_mode),
		}
	}
}

impl omp_agent::ToolAdmission for SettingsAdmission {
	fn admit(
		&self,
		name: &str,
		effects: &omp_tool::Effects,
		args: &serde_json::value::RawValue,
	) -> omp_agent::ToolAdmissionVerdict {
		let resolved = self.settings.approval_for(name, name, effects);
		match resolved.policy {
			omp_envd::admission::ApprovalPolicy::Allow => omp_agent::ToolAdmissionVerdict::Allow,
			omp_envd::admission::ApprovalPolicy::Deny => omp_agent::ToolAdmissionVerdict::Deny(sf!(
				"tool `{name}` is denied by approval policy (tools.approval.{name})"
			)),
			omp_envd::admission::ApprovalPolicy::Prompt => {
				let command = serde_json::from_str::<serde_json::Value>(args.get())
					.ok()
					.and_then(|value| {
						value
							.get("command")
							.and_then(serde_json::Value::as_str)
							.map(str::to_owned)
					});
				let (kind, subject, body) = match &command {
					Some(command) => ("exec", Str::new(command.as_str()), sf!("$ {command}")),
					None => (
						"tool",
						Str::new(name),
						sf!("{name} {}", args.get().chars().take(512).collect::<String>()),
					),
				};
				omp_agent::ToolAdmissionVerdict::Prompt(omp_agent::ApprovalSpec {
					title: sf!("Run {name}"),
					body,
					subject,
					kind: Str::new_static(kind),
					scopes: vec![Str::new_static("once"), Str::new_static("session")],
					default: Some(false),
					route: Str::new_static("user"),
					approver: None,
					timeout_ms: 0,
					unreachable: Str::new_static("deny"),
					require_human: true,
					pattern: None,
					evidence: vec![sf!(
						"{} tier under approval mode {}",
						<&'static str>::from(resolved.tier),
						<&'static str>::from(self.settings.approval_mode)
					)],
				})
			},
		}
	}
}

/// The structured denial the environment journals when the prompt refused
/// the call.
fn admission_denial(
	call_id: &str,
	name: &str,
	decision: &omp_agent::ApprovalDecision,
) -> omp_proto::policy::v1::PolicyDenied {
	let by = <&'static str>::from(decision.source);
	omp_proto::policy::v1::PolicyDenied {
		reason:      decision.reason.as_deref().map_or_else(
			|| format!("Tool call denied by {by}: {name}"),
			|reason| format!("Tool call denied by {by}: {name} ({reason})"),
		),
		code:        String::from("approval_denied"),
		decision_id: call_id.to_owned(),
		rules:       vec![format!("tools.approval.{name}")],
		props:       Default::default(),
	}
}

impl ExternalToolExecutor for EnvToolExecutor {
	fn invoke(&self, request: ExternalDispatchRequest) -> ExternalDispatchStream {
		let client = self.client.clone();
		let approvals = self.approvals.clone();
		let outcome_store = request.blobs.clone();
		Box::pin(async_stream::stream! {
			let client = match client.with_principal(request.session_id.clone(), "kernel") {
				Ok(client) => client,
				Err(source) => {
					tracing::warn!(%source, call_id = %request.call_id, "environment tool principal is invalid");
					yield ExternalDispatchEvent::Aborted(Abort::Interrupted {
						reason: Str::new_static("environment tool principal is invalid"),
					});
					return;
				},
			};
			let opened = client.invoke(omp_env::frame::InvokeTool {
				invocation_id: request.call_id.to_string(),
				name: request.identity.name.to_string(),
				rev: request.identity.rev.to_string(),
				deadline_ms: u64::try_from(request.blocking_limit.as_millis()).unwrap_or(u64::MAX),
				output_request: match request.output_request {
					omp_tool::OutputRequest::Bounded => {
						omp_env::frame::OutputRequest::Bounded as i32
					},
					omp_tool::OutputRequest::Complete => {
						omp_env::frame::OutputRequest::Complete as i32
					},
				},
				..Default::default()
			}).await;
			let mut invocation = match opened {
				Ok(invocation) => invocation,
				Err(source) => {
					tracing::warn!(%source, call_id = %request.call_id, "environment tool open failed");
					yield ExternalDispatchEvent::Aborted(Abort::Interrupted {
						reason: Str::new_static("environment tool open failed"),
					});
					return;
				},
			};
			match invocation.next_event().await {
				Ok(Some(omp_env::InvocationEvent::Accepted(_))) => {},
				Ok(_) => {
					yield ExternalDispatchEvent::Aborted(Abort::InputDropped);
					return;
				},
				Err(source) => {
					tracing::warn!(%source, call_id = %request.call_id, "environment tool acceptance failed");
					yield ExternalDispatchEvent::Aborted(Abort::Interrupted {
						reason: Str::new_static("environment tool acceptance failed"),
					});
					return;
				},
			}
			let token = Bytes::from(Ulid::generate().to_string());
			let authorized_at_ms = SystemTime::now()
				.duration_since(UNIX_EPOCH)
				.map_or(0, |duration| u64::try_from(duration.as_millis()).unwrap_or(u64::MAX));
			if let Err(source) = invocation
				.commit_args(Bytes::copy_from_slice(request.args.get().as_bytes()), token, authorized_at_ms, None)
				.await
			{
				tracing::warn!(%source, call_id = %request.call_id, "environment tool commit failed");
				yield ExternalDispatchEvent::Aborted(Abort::Interrupted {
					reason: Str::new_static("environment tool commit failed"),
				});
				return;
			}
			// ADR 0011: the stop request is forwarded to the environment, which
			// interrupts the unit (TERM, `sv_interrupt_grace`, KILL) and reports
			// the unit's own verdict; the dispatcher bounds how long that report
			// may take. Dropping this stream cancels the request as well.
			let mut interrupted = false;
			loop {
				let next = tokio::select! {
					biased;
					() = request.cancellation.cancelled(), if !interrupted => {
						interrupted = true;
						if let Err(source) = invocation.interrupt(Str::new_static("interrupted")).await {
							tracing::warn!(%source, call_id = %request.call_id, "environment tool interrupt failed");
							yield ExternalDispatchEvent::Aborted(Abort::EffectsUnknown {
								reason: Str::new_static("environment tool interrupt failed"),
							});
							return;
						}
						continue;
					},
					next = invocation.next_event() => next,
				};
				match next {
					Ok(Some(omp_env::InvocationEvent::Accepted(_))) => {},
					Ok(Some(omp_env::InvocationEvent::Admission(query))) => {
						let spec = admission_spec(&request, &query);
						let ticket = approvals
							.request_cancellable(
								Some(request.call_id.clone()),
								vec![spec],
								authorized_at_ms,
								request.cancellation.clone(),
							)
							.await;
						let decision = ticket.decision.unwrap_or_else(|| omp_agent::ApprovalDecision {
							approved:   false,
							scope:      omp_agent::ApprovalScope::Once,
							source:     omp_agent::ApprovalSource::Unavailable,
							decided_by: None,
							reason:     Some(Str::new_static("approval prompt settled without a decision")),
							audited:    false,
						});
						let admission = omp_env::frame::Admission {
							invocation_id: query.invocation_id,
							allow: decision.approved,
							denied: (!decision.approved).then(|| {
								admission_denial(request.call_id.as_str(), request.identity.name.as_str(), &decision)
							}),
							..Default::default()
						};
						if let Err(source) = invocation.admit(admission).await {
							tracing::warn!(%source, call_id = %request.call_id, "environment tool admission failed");
							yield ExternalDispatchEvent::Aborted(Abort::Interrupted {
								reason: Str::new_static("environment tool admission failed"),
							});
							return;
						}
					},
					Ok(Some(omp_env::InvocationEvent::Update(update))) => {
						match raw_json(update.json) {
							Ok(update) => yield ExternalDispatchEvent::Update(update),
							Err(()) => {
								yield ExternalDispatchEvent::Aborted(Abort::MissingOutcome);
								return;
							},
						}
					},
					Ok(Some(omp_env::InvocationEvent::Verdict(verdict))) => {
						if verdict.invocation_id != request.call_id.as_str() {
							tracing::warn!(
								call_id = %request.call_id,
								verdict_invocation_id = %verdict.invocation_id,
								"environment verdict provenance does not match the invocation"
							);
							yield ExternalDispatchEvent::Aborted(invalid_outcome_blob());
							return;
						}
						let inline_json = verdict.json;
						let Some(projection) = verdict.projection else {
							tracing::warn!(call_id = %request.call_id, "environment verdict omitted output projection facts");
							yield ExternalDispatchEvent::Aborted(invalid_outcome_blob());
							return;
						};
						let Some(details) = verdict.details_blob else {
							tracing::warn!(call_id = %request.call_id, "environment verdict omitted outcome blob");
							yield ExternalDispatchEvent::Aborted(invalid_outcome_blob());
							return;
						};
						if !valid_output_projection(request.output_request, &projection, &details) {
							tracing::warn!(call_id = %request.call_id, "environment verdict output projection facts are invalid");
							yield ExternalDispatchEvent::Aborted(invalid_outcome_blob());
							return;
						}
						if details.mime != "application/json" || !details.inline.is_empty() {
							tracing::warn!(call_id = %request.call_id, mime = %details.mime, "environment verdict blob provenance is invalid");
							yield ExternalDispatchEvent::Aborted(invalid_outcome_blob());
							return;
						}
						let hash: [u8; 32] = match details.hash.as_ref().try_into() {
							Ok(hash) => hash,
							Err(_) => {
								tracing::warn!(call_id = %request.call_id, hash_bytes = details.hash.len(), "environment verdict blob digest is invalid");
								yield ExternalDispatchEvent::Aborted(invalid_outcome_blob());
								return;
							},
						};
						let expected_hash = Hash32::new(hash);
						let max_bytes = u64::try_from(omp_proto::bounds::FRAME_MAX_BYTES)
							.expect("protocol frame limit fits u64");
						if details.size > max_bytes {
							tracing::warn!(
								call_id = %request.call_id,
								size = details.size,
								limit = max_bytes,
								"environment outcome blob exceeds the host retrieval bound"
							);
							yield ExternalDispatchEvent::Aborted(invalid_outcome_blob());
							return;
						}
						let (source_artifact, bytes) = if inline_json.is_empty() {
							let source_artifact = match replicate_outcome_blob(
								&client,
								&outcome_store,
								request.call_id.as_str(),
								expected_hash,
								details.size,
								max_bytes,
								&request.cancellation,
							)
							.await
							{
								Ok(source_artifact) => source_artifact,
								Err(OutcomeReplicationError::Interrupted) => {
									yield ExternalDispatchEvent::Aborted(Abort::Interrupted {
										reason: Str::new_static("environment outcome retrieval interrupted"),
									});
									return;
								},
								Err(source) => {
									tracing::warn!(%source, call_id = %request.call_id, "environment outcome replication failed");
									yield ExternalDispatchEvent::Aborted(invalid_outcome_blob());
									return;
								},
							};
							let bytes = match outcome_store.get(&source_artifact) {
								Ok(bytes) => bytes,
								Err(source) => {
									tracing::warn!(%source, call_id = %request.call_id, "session outcome artifact read failed");
									yield ExternalDispatchEvent::Aborted(invalid_outcome_blob());
									return;
								},
							};
							(source_artifact, bytes)
						} else {
							let inline_size = u64::try_from(inline_json.len()).unwrap_or(u64::MAX);
							if inline_size != details.size
								|| projection.source_bytes != details.size
								|| projection.inline_bytes != inline_size
								|| projection.omitted
								|| Hash32::sum(&inline_json) != expected_hash
							{
								tracing::warn!(
									call_id = %request.call_id,
									"environment inline outcome does not match its artifact"
								);
								yield ExternalDispatchEvent::Aborted(invalid_outcome_blob());
								return;
							}
							let source_artifact = match outcome_store.put(&inline_json) {
								Ok(source_artifact) => source_artifact,
								Err(source) => {
									tracing::warn!(%source, call_id = %request.call_id, "session outcome artifact write failed");
									yield ExternalDispatchEvent::Aborted(invalid_outcome_blob());
									return;
								},
							};
							(source_artifact, inline_json)
						};
						let outcome = match serde_json::from_slice::<
							CallOutcome<serde_json::Value, serde_json::Value>,
						>(&bytes) {
							Ok(outcome) => outcome,
							Err(source) => {
								tracing::warn!(%source, call_id = %request.call_id, "environment outcome blob is not a CallOutcome");
								yield ExternalDispatchEvent::Aborted(invalid_outcome_blob());
								return;
							},
						};
						let typed_is_error = !matches!(&outcome, CallOutcome::Ok(_));
						if typed_is_error != verdict.is_error {
							tracing::warn!(
								call_id = %request.call_id,
								wire_is_error = verdict.is_error,
								typed_is_error,
								"environment outcome classification mismatch"
							);
							yield ExternalDispatchEvent::Aborted(invalid_outcome_blob());
							return;
						}
						let mut parts = match replicate_verdict_parts(
							&client,
							&outcome_store,
							request.call_id.as_str(),
							verdict.parts,
							max_bytes,
							&request.cancellation,
						)
						.await
						{
							Ok(parts) => parts,
							Err(OutcomeReplicationError::Interrupted) => {
								yield ExternalDispatchEvent::Aborted(Abort::Interrupted {
									reason: Str::new_static("environment media retrieval interrupted"),
								});
								return;
							},
							Err(source) => {
								tracing::warn!(%source, call_id = %request.call_id, "environment verdict media replication failed");
								yield ExternalDispatchEvent::Aborted(invalid_outcome_blob());
								return;
							},
						};
						if parts.is_empty() {
							parts = structured_parts(&outcome);
						}
						yield ExternalDispatchEvent::DoneProjected {
							outcome,
							parts,
							is_error: verdict.is_error,
							source_artifact: Some(source_artifact),
							projection: tool_output_projection(projection),
						};
						return;
					},
					Ok(None) => {
						yield ExternalDispatchEvent::Aborted(Abort::MissingOutcome);
						return;
					},
					Err(source) => {
						tracing::warn!(%source, call_id = %request.call_id, "environment tool stream failed");
						yield ExternalDispatchEvent::Aborted(Abort::Interrupted {
							reason: Str::new_static("environment tool stream failed"),
						});
						return;
					},
				}
			}
		})
	}
}

fn raw_json(bytes: Bytes) -> Result<Box<serde_json::value::RawValue>, ()> {
	let text = String::from_utf8(bytes.to_vec()).map_err(|_| ())?;
	serde_json::value::RawValue::from_string(text).map_err(|_| ())
}

fn structured_parts(outcome: &CallOutcome<serde_json::Value, serde_json::Value>) -> Vec<ToolPart> {
	let value = match outcome {
		CallOutcome::Ok(value) | CallOutcome::Faulted(value) => value,
		CallOutcome::ArgsRejected(_) => {
			return vec![ToolPart::Text { text: Str::new_static("Tool arguments were rejected") }];
		},
		CallOutcome::Aborted { abort, .. } => {
			return vec![ToolPart::Text { text: abort.render() }];
		},
	};
	value
		.get("parts")
		.and_then(serde_json::Value::as_array)
		.into_iter()
		.flatten()
		.filter_map(|part| match part.get("kind").and_then(serde_json::Value::as_str) {
			Some("text") => part
				.get("text")
				.and_then(serde_json::Value::as_str)
				.map(|text| ToolPart::Text { text: Str::new(text) }),
			Some("json") => part
				.get("json")
				.map(|json| ToolPart::Json { json: Bytes::from(json.to_string()) }),
			_ => None,
		})
		.collect()
}

fn tool_output_projection(
	projection: omp_env::frame::OutputProjection,
) -> omp_tool::OutputProjection {
	let request = match omp_env::frame::OutputRequest::try_from(projection.request) {
		Ok(omp_env::frame::OutputRequest::Complete) => omp_tool::OutputRequest::Complete,
		Ok(omp_env::frame::OutputRequest::Bounded | omp_env::frame::OutputRequest::Unspecified)
		| Err(_) => omp_tool::OutputRequest::Bounded,
	};
	let artifact = projection.artifact.map(|artifact| ToolBlobRef {
		hash:       Str::new(omp_core::hex::encode(&artifact.hash).to_string()),
		media_type: Str::new(artifact.mime),
		byte_len:   artifact.size,
	});
	omp_tool::OutputProjection {
		request,
		source_bytes: projection.source_bytes,
		inline_bytes: projection.inline_bytes,
		omitted: projection.omitted,
		artifact,
	}
}

fn valid_output_projection(
	request: omp_tool::OutputRequest,
	projection: &omp_env::frame::OutputProjection,
	details: &omp_proto::thread::v1::Blob,
) -> bool {
	let expected_request = match request {
		omp_tool::OutputRequest::Bounded => omp_env::frame::OutputRequest::Bounded as i32,
		omp_tool::OutputRequest::Complete => omp_env::frame::OutputRequest::Complete as i32,
	};
	let inline_limit = match request {
		omp_tool::OutputRequest::Bounded => omp_agent::DispatchPolicy::DEFAULT_MAX_OUTPUT_BYTES,
		omp_tool::OutputRequest::Complete => omp_agent::DispatchPolicy::MAX_COMPLETE_OUTPUT_BYTES,
	};
	projection.request == expected_request
		&& projection.inline_bytes <= u64::try_from(inline_limit).unwrap_or(u64::MAX)
		&& projection.source_bytes >= projection.inline_bytes
		&& projection.artifact.as_ref().is_some_and(|artifact| {
			artifact.hash == details.hash
				&& artifact.size == details.size
				&& artifact.mime == details.mime
				&& artifact.inline.is_empty()
		})
}

const fn invalid_outcome_blob() -> Abort {
	Abort::EffectsUnknown {
		reason: Str::new_static("environment returned an invalid outcome artifact"),
	}
}

fn tool_part(part: omp_proto::thread::v1::Part) -> Option<ToolPart> {
	match part.kind? {
		omp_proto::thread::v1::part::Kind::Text(text) => {
			Some(ToolPart::Text { text: Str::new(text) })
		},
		omp_proto::thread::v1::part::Kind::Thinking(thinking) => {
			Some(ToolPart::Text { text: Str::new(thinking.text) })
		},
		omp_proto::thread::v1::part::Kind::Blob(blob) => Some(ToolPart::Blob {
			blob: ToolBlobRef {
				hash:       Str::new(omp_core::hex::encode(&blob.hash).to_string()),
				media_type: Str::new(blob.mime),
				byte_len:   blob.size,
			},
			alt:  None,
		}),
		omp_proto::thread::v1::part::Kind::Fallback(_)
		| omp_proto::thread::v1::part::Kind::ServerTool(_) => None,
	}
}

impl omp_agent::Inference for ProductionInference {
	fn chat(
		&mut self,
		mut request: ChatRequest,
	) -> impl Future<Output = Result<ChatStream, omp_ai::Error>> + Send {
		self.apply_convars(&mut request);
		self.client.execute(request)
	}

	/// One isolated call on `selector` (a catalog model, alias, or `@role`
	/// such as the advisor's `@advisor`): the client is re-targeted for the
	/// plan only and restored to the live route afterwards, so the primary's
	/// next request is untouched. An unresolvable selector is a planning
	/// `TargetNotFound` (the advisor journals `no_model`).
	fn chat_on(
		&mut self,
		selector: &str,
		mut request: ChatRequest,
	) -> impl Future<Output = Result<ChatStream, omp_ai::Error>> + Send {
		let resolved = resolve_model_selector(self.catalog.as_ref(), selector).or_else(|_| {
			let settings = omp_catalog::settings::ModelSettings::from_con(&self.con);
			crate::discovery::roles::resolve_role_selector(self.catalog.as_ref(), &settings, selector)
				.map(|selected| Str::new(selected.model.as_str()))
				.map_err(|_| HeadlessError::UnknownModel { selector: Str::new(selector) })
		});
		async move {
			let model = resolved.map_err(|_| {
				omp_ai::Error::planning(
					omp_ai::ErrorKind::TargetNotFound,
					omp_ai::ErrorDetail::target(Str::new(selector)),
					omp_ai::ExecutionReceipt::default(),
				)
			})?;
			let key = omp_catalog::ModelKey::from(model.as_str());
			if matches!(request.reasoning, omp_ai::Setting::Unset)
				&& !omp_ai::settings::AI_EXTERNAL_THINKING.get(&self.con)
			{
				let thinking = omp_agent::AI_THINKING.get(&self.con);
				request.reasoning = convar_reasoning(self.catalog.as_ref(), &key, &thinking);
			}
			let live = self.client.call_meta().clone();
			let mut meta = self.meta.clone();
			meta.target = match &self.meta.target {
				Target::Provider { provider, .. } => {
					Target::Provider { provider: provider.clone(), model: key }
				},
				_ => Target::Model(key),
			};
			self.client.set_call_meta(meta);
			let result = self.client.execute(request).await;
			self.client.set_call_meta(live);
			result
		}
	}

	fn install_retry_sink(&mut self, sink: omp_ai::RetrySink) {
		// Both the launch metadata (the base every `ai_model` re-target copies)
		// and the client's live copy carry the sink.
		self.meta.response_hooks = self.meta.response_hooks.clone().with_retry_sink(sink);
		let mut live = self.client.call_meta().clone();
		live.response_hooks = self.meta.response_hooks.clone();
		self.client.set_call_meta(live);
	}
}

/// A cloneable auxiliary inference handle for enhanced speech rewriting.
///
/// It shares the production registry and credential authorities already
/// composed for the session; it never creates a second provider stack.
#[derive(Clone)]
pub enum SpeechRewriteClient {
	/// Direct provider call sharing the session's registry and credentials.
	Production {
		/// Shared immutable route registry.
		registry: omp_ai::Registry,
		/// Resolved tiny-role model.
		model:    omp_catalog::ModelKey,
	},
	/// Auxiliary call through the already-connected inference gateway.
	Gateway {
		/// Cloneable gateway client.
		inference: GatewayInference,
	},
}

/// Typed failure from one enhanced-speech auxiliary completion.
#[derive(Debug, thiserror::Error)]
pub enum SpeechRewriteClientError {
	/// The operation was cancelled before a final response.
	#[error("speech rewrite was cancelled")]
	Cancelled,
	/// The rewrite exceeded its bounded completion deadline.
	#[error("speech rewrite timed out")]
	Timeout,
	/// The production inference route failed.
	#[error("speech rewrite inference failed")]
	Inference {
		/// Typed provider/runtime source.
		#[source]
		source: omp_ai::Error,
	},
	/// The route completed without emitting speakable text.
	#[error("speech rewrite completed without text")]
	EmptyOutput,
}

impl SpeechRewriteClient {
	/// Rewrites one bounded block on the configured `@tiny` role.
	pub async fn rewrite(
		&self,
		instruction: &'static str,
		text: Str,
		cancel: tokio_util::sync::CancellationToken,
	) -> Result<Str, SpeechRewriteClientError> {
		let message = |role, text| Message {
			role,
			content: Arc::from([ContentPart::Text { text, proof: None }]),
			name: None,
		};
		let request = ChatRequest {
			messages:          Arc::from([
				message(Role::System, Str::new_static(instruction)),
				message(Role::User, text),
			]),
			tools:             Arc::from([]),
			hosted_tools:      Arc::from([]),
			tool_choice:       Setting::Unset,
			output:            Setting::Unset,
			reasoning:         Setting::Unset,
			verbosity:         Setting::Unset,
			cache_retention:   Setting::Unset,
			service_tier:      Setting::Unset,
			sampling:          Sampling::default(),
			max_output_tokens: Some(1_536),
			top_logprobs:      None,
			safety:            Arc::from([]),
			negotiation:       NegotiationPolicy::default(),
			forced_call:       None,
		};
		let mut stream = match self {
			Self::Production { registry, model } => {
				let meta = CallMeta {
					id:             RequestId::from(format!("speech-{}", Ulid::generate())),
					target:         Target::Model(model.clone()),
					deadline:       None,
					budget:         ExecutionBudget::default(),
					session:        None,
					debug_session:  None,
					response_hooks: Default::default(),
				};
				let execute = omp_ai::router::execute_registry_call(
					registry.clone(),
					Call::new(meta, OperationCall::Chat(Arc::new(request))),
					Duration::from_secs(6),
				);
				let answer = tokio::select! {
					biased;
					() = cancel.cancelled() => return Err(SpeechRewriteClientError::Cancelled),
					answer = execute => answer.map_err(|source| SpeechRewriteClientError::Inference { source })?,
				};
				let AnswerBody::Chat(stream) = answer.body else {
					return Err(SpeechRewriteClientError::EmptyOutput);
				};
				stream
			},
			Self::Gateway { inference } => {
				let mut inference = inference.clone();
				let execute = tokio::time::timeout(
					Duration::from_secs(6),
					omp_agent::Inference::chat_on(&mut inference, "@tiny", request),
				);
				tokio::select! {
					biased;
					() = cancel.cancelled() => return Err(SpeechRewriteClientError::Cancelled),
					stream = execute => stream
						.map_err(|_| SpeechRewriteClientError::Timeout)?
						.map_err(|source| SpeechRewriteClientError::Inference { source })?,
				}
			},
		};
		let mut output = StrMut::new("");
		loop {
			let event = tokio::select! {
				biased;
				() = cancel.cancelled() => return Err(SpeechRewriteClientError::Cancelled),
				event = stream.next() => event,
			};
			let Some(event) = event else { break };
			match event.map_err(|source| SpeechRewriteClientError::Inference { source })? {
				ChatEvent::TextDelta { text, .. } => output.push_str(text.as_str()),
				ChatEvent::Started(_)
				| ChatEvent::BlockStarted { .. }
				| ChatEvent::ThinkingDelta { .. }
				| ChatEvent::ToolCallStarted { .. }
				| ChatEvent::ToolArgumentsDelta { .. }
				| ChatEvent::ToolCallReady { .. }
				| ChatEvent::Artifact { .. }
				| ChatEvent::Usage(_)
				| ChatEvent::WorkflowAction(_)
				| ChatEvent::WorkflowResume(_)
				| ChatEvent::WorkflowCancelled { .. }
				| ChatEvent::Completed(_) => {},
			}
		}
		let output = output.freeze();
		if output.trim().is_empty() {
			Err(SpeechRewriteClientError::EmptyOutput)
		} else {
			Ok(output)
		}
	}
}

/// Inference selected by one headless invocation.
pub enum ComposedInference {
	/// Direct production provider stack.
	Production(ProductionInference),
	/// Remote inference gateway plus its local project-tool authority.
	Gateway {
		/// Raw gateway turn adapter.
		inference:          GatewayInference,
		/// Environment owner retained for local tool execution.
		_environment:       omp_envd::ProjectEnvironment,
		/// Active session's generation-fenced Agent CONTROL lease.
		_agent_control:     Mutex<Option<omp_envd::AgentControlBinding>>,
		/// Live Python Component reducers retained for the controller lifetime.
		_python_components: Vec<omp_envd::exthost::PyComponent>,
		/// Authenticated eval-parent binding retained for this kernel.
		_eval_parent:       Option<omp_envd::eval::ParentBindingLease>,
		/// No-session journal cleanup owner.
		_ephemeral_journal: Option<EphemeralJournal>,
	},
}

impl ComposedInference {
	fn retain_ephemeral_journal(&mut self, journal: EphemeralJournal) {
		match self {
			Self::Production(inference) => inference._ephemeral_journal = Some(journal),
			Self::Gateway { _ephemeral_journal, .. } => *_ephemeral_journal = Some(journal),
		}
	}

	fn retain_eval_parent(&mut self, lease: omp_envd::eval::ParentBindingLease) {
		match self {
			Self::Production(inference) => inference._eval_parent = Some(lease),
			Self::Gateway { _eval_parent, .. } => *_eval_parent = Some(lease),
		}
	}

	/// Routes environment-originated checkpoint controls to the kernel mailbox
	/// and clears transient checkpoint state whenever that kernel selects a
	/// different durable session.
	pub fn refresh_agent_control(&self, sender: omp_agent::KernelSender, dom: &omp_dom::Dom) {
		let (environment, slot) = match self {
			Self::Production(inference) => (&inference._environment, &inference._agent_control),
			Self::Gateway { _environment, _agent_control, .. } => (_environment, _agent_control),
		};
		let mut slot = slot.lock();
		if slot.is_none() {
			*slot = Some(environment.bind_agent_control(sender));
		}
		slot
			.as_ref()
			.expect("Agent CONTROL binding was installed")
			.refresh_session(dom);
	}

	/// Borrows the project environment client retained by this composition.
	#[must_use]
	pub fn environment_client(&self) -> &omp_env::EnvClient {
		match self {
			Self::Production(inference) => inference._environment.client(),
			Self::Gateway { _environment, .. } => _environment.client(),
		}
	}

	/// Borrows the project environment retained by this composition (MCP
	/// inspection, extension reload).
	#[must_use]
	pub const fn environment(&self) -> &omp_envd::ProjectEnvironment {
		match self {
			Self::Production(inference) => &inference._environment,
			Self::Gateway { _environment, .. } => _environment,
		}
	}

	/// Returns an auxiliary speech rewriter sharing this session's production
	/// registry or already-connected remote gateway. Direct production returns
	/// `None` only when no tiny role resolves.
	#[must_use]
	pub fn speech_rewriter(&self) -> Option<SpeechRewriteClient> {
		match self {
			Self::Production(inference) => {
				let settings = omp_catalog::settings::ModelSettings::from_con(&inference.con);
				let selected = crate::discovery::roles::resolve_role_selector(
					inference.catalog.as_ref(),
					&settings,
					"@tiny",
				)
				.ok()?;
				Some(SpeechRewriteClient::Production {
					registry: inference._stack.registry.clone(),
					model:    selected.model.clone(),
				})
			},
			Self::Gateway { inference, .. } => {
				Some(SpeechRewriteClient::Gateway { inference: inference.clone() })
			},
		}
	}

	/// Resolves the production target for a side-channel request without
	/// losing an explicit provider constraint from the ordinary turn.
	pub(crate) fn side_channel_target(&self) -> Option<Target> {
		let Self::Production(inference) = self else {
			return None;
		};
		let model = omp_catalog::ModelKey::from(inference.selected_model().as_str());
		Some(match &inference.meta.target {
			Target::Provider { provider, .. } => {
				Target::Provider { provider: provider.clone(), model }
			},
			_ => Target::Model(model),
		})
	}

	/// Borrows the production authentication and usage stack; `None` behind
	/// a remote gateway, whose credentials live on the gateway host.
	#[must_use]
	pub const fn production_stack(&self) -> Option<&ProductionStack> {
		match self {
			Self::Production(inference) => Some(&inference._stack),
			Self::Gateway { .. } => None,
		}
	}

	/// Catalog snapshot the composition routes through; `None` behind a
	/// remote gateway.
	#[must_use]
	pub const fn catalog(&self) -> Option<&Arc<omp_catalog::snapshot::Catalog>> {
		match self {
			Self::Production(inference) => Some(&inference.catalog),
			Self::Gateway { .. } => None,
		}
	}
}

impl omp_agent::Inference for ComposedInference {
	fn chat(
		&mut self,
		request: ChatRequest,
	) -> impl Future<Output = Result<ChatStream, omp_ai::Error>> + Send {
		async move {
			match self {
				Self::Production(inference) => inference.chat(request).await,
				Self::Gateway { inference, .. } => inference.chat(request).await,
			}
		}
	}

	fn chat_on(
		&mut self,
		selector: &str,
		request: ChatRequest,
	) -> impl Future<Output = Result<ChatStream, omp_ai::Error>> + Send {
		async move {
			match self {
				Self::Production(inference) => inference.chat_on(selector, request).await,
				Self::Gateway { inference, .. } => inference.chat_on(selector, request).await,
			}
		}
	}

	fn set_debug_session(&mut self, session: Option<Str>) {
		if let Self::Production(inference) = self {
			inference.meta.debug_session = session;
			inference.client.set_call_meta(inference.meta.clone());
		}
	}

	fn select_session(&self, dom: &omp_dom::Dom) {
		let binding = match self {
			Self::Production(inference) => &inference._agent_control,
			Self::Gateway { _agent_control, .. } => _agent_control,
		};
		if let Some(binding) = binding.lock().as_ref() {
			binding.refresh_session(dom);
		}
	}

	fn install_retry_sink(&mut self, sink: omp_ai::RetrySink) {
		match self {
			Self::Production(inference) => inference.install_retry_sink(sink),
			Self::Gateway { inference, .. } => inference.install_retry_sink(sink),
		}
	}

	fn route_facts(&self) -> Option<RouteFacts> {
		match self {
			Self::Production(inference) => inference.route_facts(),
			Self::Gateway { .. } => None,
		}
	}

	fn selected_model(&self) -> Option<Str> {
		match self {
			Self::Production(inference) => Some(inference.selected_model()),
			Self::Gateway { .. } => None,
		}
	}
}

/// Concrete prompt projection returned by [`compose_kernel`].
pub type PromptSource = CanonicalPromptSource;

fn install_yield_contract(
	registry: Arc<Registry>,
	output_schema: Option<&serde_json::Value>,
	schema_mode: Option<SchemaMode>,
) -> Result<Arc<Registry>, HeadlessError> {
	let Some(output_schema) = output_schema else {
		return Ok(registry);
	};
	let retained = registry
		.live_identities()
		.filter(|(name, _)| name.as_str() != "yield")
		.map(|(name, _)| name.clone())
		.collect::<Vec<_>>();
	let mut registry = registry.restrict(retained.iter().map(Str::as_str));
	registry.register(
		omp_tools::yield_tool::tool_for_schema(output_schema, schema_mode.unwrap_or_default())?,
		Presentation::Hidden,
		Claims {
			precedence: Precedence::CORE,
			claimant:   Str::new_static("omp/core"),
			replaces:   None,
		},
	)?;
	Ok(Arc::new(registry))
}

#[derive(Clone, Copy)]
struct GoalDeclaration;

impl omp_tools::goal::GoalControl for GoalDeclaration {
	fn apply(
		&self,
		_params: omp_tools::goal::Params,
	) -> impl Future<Output = Result<Option<omp_tools::goal::Goal>, omp_tools::goal::Fault>> + Send + '_
	{
		async { Err(omp_tools::goal::Fault::Unavailable) }
	}
}

/// Installs the stable Goal declaration. Live execution is intercepted by the
/// session-owned reducer so no goal state exists outside the session DOM.
fn install_goal_contract(registry: Arc<Registry>) -> Result<Arc<Registry>, HeadlessError> {
	let retained = registry
		.live_names()
		.into_iter()
		.filter(|name| name.as_str() != "goal")
		.collect::<Vec<_>>();
	let mut registry = registry.restrict(retained.iter().map(Str::as_str));
	registry.register(omp_tools::goal::tool(GoalDeclaration), Presentation::Hidden, Claims {
		precedence: Precedence::CORE,
		claimant:   Str::new_static("omp/core"),
		replaces:   None,
	})?;
	Ok(Arc::new(registry))
}

/// Replaces generic `yield` with one strict batch-local workpool contract.
pub(crate) fn install_workpool_yield_contract(
	registry: &Registry,
	items: Vec<omp_tools::yield_tool::WorkpoolItem>,
) -> Result<Arc<Registry>, HeadlessError> {
	let retained = registry
		.live_names()
		.into_iter()
		.filter(|name| name.as_str() != "yield")
		.collect::<Vec<_>>();
	let mut registry = registry.restrict(retained.iter().map(Str::as_str));
	registry.register(
		omp_tools::yield_tool::tool_for_workpool(items)?,
		Presentation::Slot,
		Claims {
			precedence: Precedence::CORE,
			claimant:   Str::new_static("omp/core"),
			replaces:   None,
		},
	)?;
	Ok(Arc::new(registry))
}

/// Composes the production environment, inference route, tools, prompt, and
/// authoritative `.oms` session for a headless command.
pub async fn compose_kernel(
	data_dir: &Path,
	project_root: &Path,
	model_selector: &str,
	ctx: Arc<omp_con::Ctx>,
	options: KernelOptions,
) -> Result<(Kernel<ComposedInference>, Session, PromptSource), HeadlessError> {
	let project_root = fs::canonicalize(project_root)?;
	let state_dir = omp_env::project_state::directory(data_dir, &project_root)?;
	let sessions_dir = options
		.sessions_dir
		.clone()
		.unwrap_or_else(|| state_dir.join("sessions"));
	fs::create_dir_all(&sessions_dir)?;
	let tools_enabled = !options.no_tools;
	let live_sessions = options
		.sessions
		.clone()
		.unwrap_or_else(|| Arc::new(crate::sessions::SessionRegistry::new()));
	let disabled_extensions = crate::discovery::CL_DISABLED_EXTENSIONS.get(&ctx);
	let native_mode = match options.extensions.native_mode {
		NativeExtensionMode::Merge => crate::discovery::native::NativeLoadMode::Merge,
		NativeExtensionMode::ExplicitOnly => crate::discovery::native::NativeLoadMode::ExplicitOnly,
		NativeExtensionMode::Disabled => crate::discovery::native::NativeLoadMode::Disabled,
	};
	let home = if native_mode == crate::discovery::native::NativeLoadMode::Merge {
		omp_core::dirs::home_dir().ok_or(omp_core::dirs::DataDirError::HomeUnset)?
	} else {
		project_root.clone()
	};
	let native_extensions = crate::discovery::native::admit_native_extensions_contained(
		&project_root,
		&home,
		crate::discovery::native::NativeAdmissionOptions {
			explicit_roots:    &options.extensions.native_roots,
			mode:              native_mode,
			include_workspace: options.extensions.include_workspace,
			setting_overrides: &options.extensions.setting_overrides,
			disabled:          &disabled_extensions,
		},
	);
	for error in &native_extensions.errors {
		tracing::warn!(error = %error, "Python extension was not admitted");
	}
	let mut extension_skill_sources = options
		.extensions
		.native_roots
		.iter()
		.filter_map(|root| {
			crate::discovery::skills::agent_plugin_skill_source(
				root,
				crate::discovery::skills::SkillLevel::Project,
			)
		})
		.collect::<Vec<_>>();
	for extension in &native_extensions.extensions {
		let level = if extension.spec.key.layer() == "user" {
			crate::discovery::skills::SkillLevel::User
		} else {
			crate::discovery::skills::SkillLevel::Project
		};
		for root in extension.skill_roots() {
			extension_skill_sources.push(crate::discovery::skills::SkillSource {
				provider: sf!("extension:{}", extension.spec.key.extension()),
				root,
				level,
			});
		}
	}
	let skills = match &options.discovered_skills {
		Some(skills) => {
			let mut merged = (**skills).clone();
			merged.merge_extension_sources(
				&extension_skill_sources,
				&crate::discovery::skills::SkillPolicy::from_con(&ctx),
			);
			Arc::new(merged)
		},
		None => Arc::new(crate::discovery::skills::ActiveSkills::discover_with_sources(
			&ctx,
			&project_root,
			&extension_skill_sources,
		)?),
	};
	let (context_files, rules) = discover_prompt_material(&project_root, &options.prompt)?;
	let facts = {
		let buckets = rules.prompt_facts(crate::discovery::rules::MAIN_AGENT);
		crate::discovery::PromptFacts {
			skills:             skills.prompt_facts(),
			context_files:      context_files.prompt_facts(),
			always_apply_rules: buckets.always_apply,
			rules:              buckets.rulebook,
			active_repository:  crate::discovery::active_repo::resolve(&project_root),
		}
	};
	let inference_bridge =
		tools_enabled.then(|| Arc::new(crate::bridges::InferenceBridge::default()));
	let bridges = if tools_enabled {
		omp_envd::RegistryBridges {
			command_credentials: Some(Arc::new(crate::bridges::CommandCredentials)),
			search: inference_bridge
				.clone()
				.map(|bridge| bridge as Arc<dyn omp_envd::SearchInference>),
			telemetry_upload: Some(Arc::new(crate::bridges::TelemetryDelivery)),
			url_resolvers: vec![skills.resolver(), rules.resolver()],
			content: omp_envd::ActiveContentInputs {
				authored_skills:     skills.names(),
				managed_skills_root: Some(crate::discovery::skills::managed_skills_root(
					&omp_core::dirs::user_config_root()?,
				)),
				agent_plugin_roots:  options
					.extensions
					.native_roots
					.iter()
					.filter(|root| crate::discovery::skills::is_agent_plugin_root(root))
					.cloned()
					.collect(),
			},
			dynamic_tools: vec![
				omp_envd::DynamicTool::new(
					omp_tools::task::tool(crate::subagent::spawn::TaskDeclarationSpawner),
					omp_tool::Presentation::Slot,
					omp_tool::Claims {
						precedence: omp_tool::Precedence::CORE,
						claimant:   Str::new_static("omp/core"),
						replaces:   None,
					},
				),
				omp_envd::DynamicTool::new(
					omp_tools::hub::tool(crate::subagent::hub::HubDeclarationBackend),
					omp_tool::Presentation::Slot,
					omp_tool::Claims {
						precedence: omp_tool::Precedence::CORE,
						claimant:   Str::new_static("omp/core"),
						replaces:   None,
					},
				),
			],
			..omp_envd::RegistryBridges::default()
		}
	} else {
		omp_envd::RegistryBridges::default()
	};

	let mut trusted_extensions = options.extensions.trusted.clone();
	for extension in &mut trusted_extensions {
		omp_ext::config::apply_resolved_setting_overrides(
			extension.key.extension().as_str(),
			&extension.manifest.setting_schemas,
			&mut extension.settings,
			&options.extensions.setting_overrides,
		)?;
	}
	trusted_extensions.extend(
		native_extensions
			.extensions
			.into_iter()
			.map(|extension| extension.spec),
	);
	let environment =
		omp_envd::ProjectEnvironment::attach(&project_root, &state_dir, omp_envd::AttachOptions {
			py_eval: options.py_eval,
			approval_mode: options.approval_mode,
			trusted_extensions,
			contributed_values: options.extensions.contributed.clone(),
			con: Arc::clone(&ctx),
			bridges,
			spawn_idle_timeout: options.spawn_idle_timeout,
		})
		.await?;
	let admission_gate = environment.admission_gate();
	let hub_environment = environment.client().clone();
	let mut component_registry = ComponentRegistry::standard();
	let mut director_registry = DirectorRegistry::standard();
	let mut extension_registrar = ExtensionRegistrar::new();
	let python_components = environment.register_python_extensions(&mut extension_registrar)?;
	let live_python_components = python_components.clone();
	let _installed = extension_registrar.install(&mut director_registry, &mut component_registry);

	let complete_registry = options
		.tool_registry
		.clone()
		.unwrap_or_else(|| environment.registry());
	let complete_registry = if tools_enabled {
		install_goal_contract(complete_registry)?
	} else {
		complete_registry
	};
	let registry = if options.no_tools {
		if options.tools.is_some() {
			return Err(
				std::io::Error::new(
					std::io::ErrorKind::InvalidInput,
					"--tools and --no-tools are mutually exclusive",
				)
				.into(),
			);
		}
		Arc::new(Registry::new())
	} else if let Some(names) = &options.tools {
		validate_tool_names(&complete_registry, names)?;
		Arc::new(complete_registry.restrict(names.iter().map(Str::as_str)))
	} else {
		complete_registry
	};
	let registry = if tools_enabled {
		install_goal_contract(registry)?
	} else {
		registry
	};
	let registry =
		install_yield_contract(registry, options.output_schema.as_ref(), options.schema_mode)?;

	let catalog = if options.gateway.is_some() {
		Arc::new(omp_catalog::snapshot::Catalog::embedded().clone())
	} else {
		crate::registry::production_catalog(data_dir)?
	};
	let model = resolve_model_selector(catalog.as_ref(), model_selector)?;
	let model_key = omp_catalog::ModelKey::from(model.as_str());
	let model_spec = catalog
		.model(&model_key)
		.ok_or_else(|| HeadlessError::UnknownModel { selector: model.clone() })?;
	let route_facts = route_facts(catalog.as_ref(), model_spec);
	let tool_client = if options.no_pty {
		environment
			.client()
			.with_invocation_grant(omp_env::InvocationGrant::unrestricted().deny_pty())
	} else {
		environment.client().clone()
	};

	let mut inference = if let Some(channel) = options.gateway {
		if let Some(bridge) = &inference_bridge {
			bridge.bind_remote(channel.clone())?;
		}
		ComposedInference::Gateway {
			inference:          GatewayInference::new(channel, model.as_str()),
			_environment:       environment,
			_agent_control:     Mutex::new(None),
			_python_components: python_components,
			_eval_parent:       None,
			_ephemeral_journal: None,
		}
	} else {
		let stack = production_inference_for_session(
			data_dir,
			Arc::clone(&registry),
			Some(&project_root),
			InferenceSessionOverrides {
				provider: options.api_key.as_ref().and(options.provider.clone()),
				api_key: options.api_key,
				con: Some(Arc::clone(&ctx)),
				..InferenceSessionOverrides::default()
			},
		)
		.await?;
		if let Some(bridge) = &inference_bridge {
			bridge.bind(stack.rpc.clone())?;
		}
		let planner = Router::new(stack.registry.clone(), Duration::from_secs(30));
		let target = match options.provider {
			Some(provider) => Target::Provider { provider, model: model_key },
			None => Target::Model(model_key),
		};
		let meta = CallMeta {
			id: RequestId::from(format!("omp-print-{}", Ulid::generate())),
			target,
			deadline: None,
			budget: ExecutionBudget::default(),
			session: None,
			debug_session: None,
			response_hooks: Default::default(),
		};
		let client = Client::new(stack.registry.service(), planner, meta.clone()).with_affinity(
			omp_ai::CallAffinity {
				prompt_cache:     options.prompt_cache_key.clone(),
				provider_session: options.provider_session.clone(),
			},
		);
		ComposedInference::Production(ProductionInference {
			client,
			meta,
			model: omp_catalog::ModelKey::from(model.as_str()),
			catalog: Arc::clone(&catalog),
			_environment: environment,
			_agent_control: Mutex::new(None),
			_stack: stack,
			con: Arc::clone(&ctx),
			_python_components: python_components,
			_eval_parent: None,
			_ephemeral_journal: None,
		})
	};

	let terminal = terminal_identity();
	let journal_path = select_journal_path(
		&sessions_dir,
		options.session.as_deref(),
		options.fork.as_deref(),
		options.continue_session,
		options.ephemeral,
		terminal.as_deref(),
	)?;
	let debug_session = journal_path
		.file_stem()
		.and_then(|name| name.to_str())
		.map(Str::new);
	if let ComposedInference::Production(production) = &mut inference {
		production.meta.debug_session = debug_session;
		production.client.set_call_meta(production.meta.clone());
	}
	let ephemeral_journal = options.ephemeral.then(|| EphemeralJournal {
		root: journal_path
			.parent()
			.expect("ephemeral journals always have a private parent")
			.to_path_buf(),
	});
	let mut session = if journal_path.exists() {
		let mut session = Session::open(&journal_path, component_registry)?;
		session.recover_process_disappearance()?;
		session
	} else {
		if let Some(parent) = journal_path.parent() {
			fs::create_dir_all(parent)?;
		}
		Session::create(&journal_path, component_registry)?
	};
	let con_journal = Arc::new(con_journal::ConJournal::attach(Arc::clone(&ctx), session.dom()));
	apply_model_override(&ctx, model.as_str(), options.model_override)?;
	install_prompt_facts(
		&mut session,
		&project_root,
		model.as_str(),
		&options.prompt,
		&facts,
		tools_enabled,
	)?;
	if !options.ephemeral {
		remember_terminal_session(&sessions_dir, terminal.as_deref(), &journal_path)?;
	}
	if let Some(ephemeral_journal) = ephemeral_journal {
		inference.retain_ephemeral_journal(ephemeral_journal);
	}

	let prompt = CanonicalPromptSource;
	// Tool output, provider media, user attachments, and compaction summaries
	// share the project/session CAS. Every durable byte is therefore rooted by
	// the journals that reference it and cannot leak across project namespaces.
	let spill = session.blobs().clone();
	// The environment applies `sv_interrupt_grace` between TERM and KILL; the
	// dispatcher grants that courtesy plus one second for the unit's verdict
	// to travel back before it forces the call closed as effects-unknown.
	let unit_grace = omp_envd::host_settings::SV_INTERRUPT_GRACE
		.get(&ctx)
		.to_std()?;
	let output_spill_bytes =
		usize::try_from(omp_envd::tool_settings::SV_TOOLS_OUTPUT_SPILL_BYTES.get(&ctx))
			.unwrap_or(usize::MAX);
	let artifact_head_bytes =
		usize::try_from(omp_tools::settings::SV_TOOLS_ARTIFACT_HEAD_BYTES.get(&ctx))
			.unwrap_or(usize::MAX);
	let artifact_tail_bytes =
		usize::try_from(omp_tools::settings::SV_TOOLS_ARTIFACT_TAIL_BYTES.get(&ctx))
			.unwrap_or(usize::MAX);
	let artifact_tail_lines =
		usize::try_from(omp_tools::settings::SV_TOOLS_ARTIFACT_TAIL_LINES.get(&ctx))
			.unwrap_or(usize::MAX);
	let output_max_columns = omp_tools::settings::SV_TOOLS_OUTPUT_MAX_COLUMNS.get(&ctx);
	let max_line_bytes = if output_max_columns == 0 {
		usize::MAX
	} else {
		usize::try_from(output_max_columns).unwrap_or(usize::MAX)
	};
	let policy = DispatchPolicy::new(spill)
		.with_limits(output_spill_bytes, max_line_bytes, Duration::from_secs(30))
		.with_artifact_projection(artifact_head_bytes, artifact_tail_bytes, artifact_tail_lines)
		.with_interrupt_grace(unit_grace.saturating_add(Duration::from_secs(1)));
	let runtime_flags = RuntimeFlags {
		automatic_compaction:     ctx
			.get("ai_compaction_enabled")
			.and_then(|value| match value {
				omp_con::Value::Bool(value) => Some(value),
				_ => None,
			})
			.unwrap_or(true),
		goal_enabled:             ctx
			.get("cl_goal_enabled")
			.and_then(|value| match value {
				omp_con::Value::Bool(value) => Some(value),
				_ => None,
			})
			.unwrap_or(true),
		autolearn_enabled:        ctx
			.get("ai_autolearn_enabled")
			.and_then(|value| match value {
				omp_con::Value::Bool(value) => Some(value),
				_ => None,
			})
			.unwrap_or(false),
		autolearn_min_tool_calls: ctx
			.get("ai_autolearn_min_tool_calls")
			.and_then(|value| match value {
				omp_con::Value::Int(value) => usize::try_from(value).ok(),
				_ => None,
			})
			.unwrap_or(5),
		recover_inline_edits:     ctx
			.get("sv_edit_recover_inline_edits")
			.and_then(|value| match value {
				omp_con::Value::Bool(value) => Some(value),
				_ => None,
			})
			.unwrap_or(true),
	};
	let kernel = Kernel::new(inference, registry, policy, prompt)
		.with_director_registry(director_registry)
		.with_file_mention_source(super::file_mentions::EnvFileMentionSource::new(
			hub_environment.clone(),
		))
		.with_route_facts(route_facts)
		.with_runtime_flags(runtime_flags)
		.with_con_context(Arc::clone(&ctx))
		.with_hook_gate(admission_gate)
		.with_session_state_bridge(con_journal.clone());
	// The session's one approval authority: environment policy (sandbox
	// amendments, privileged mutations, dynamic devices) and the tool
	// executor's admission queries all prompt through the kernel mailbox,
	// where each prompt is journaled under `<queues><prompts>` and answered
	// by the host's `Up::Approve`.
	let approvals = kernel.approval_route();
	kernel.inference().environment().bind_approval_authority(
		Some(Arc::new(omp_agent::ApprovalBook::new())),
		Some(approvals.clone()),
	);
	let mut kernel = kernel
		.with_external_executor(Arc::new(EnvToolExecutor::new(tool_client, approvals)))
		.with_tool_admission(Arc::new(SettingsAdmission::new(&ctx, options.approval_mode)));
	kernel.register_live_component(con_journal.live_component());
	for component in live_python_components {
		kernel.register_live_component(Box::new(component));
	}
	kernel = kernel
		.with_session_authority(Arc::clone(&live_sessions) as Arc<dyn omp_agent::SessionAuthority>);
	kernel.reconcile_jobs(&mut session)?;
	let id = journal_path
		.file_stem()
		.and_then(|name| name.to_str())
		.map_or_else(|| Str::new(Ulid::generate().to_string()), Str::new);
	let name = options.session_name.clone().unwrap_or_else(|| id.clone());
	let topology = match options.parent_session.as_deref() {
		Some(parent) => {
			let parent = omp_agent::SessionAuthority::lookup(live_sessions.as_ref(), parent)
				.ok_or_else(|| HeadlessError::ParentSessionUnavailable { parent: Str::new(parent) })?;
			omp_agent::SessionTopology::child(parent.id, parent.topology.main_id)
		},
		None => omp_agent::SessionTopology::main(id.clone()),
	};
	let relay_ctx = Arc::clone(&ctx);
	let relay = crate::sessions::IrcRelayPolicy::new(move || {
		crate::subagent::settings::CL_IRC_RELAY_TO_MAIN.get(&relay_ctx)
	});
	let up = kernel.mailbox();
	let session_mutator = crate::subagent::workpool_scheduler::SessionMutator::new(up.clone());
	kernel
		.inference()
		.refresh_agent_control(up.clone(), session.dom());
	let autoreply = crate::subagent::autoreply::producer(
		kernel.inference(),
		&live_sessions,
		up.clone(),
		kernel.turn_activity(),
		kernel.session_cancellation(),
		kernel.reply_obligations(),
		session.blobs().clone(),
	);
	live_sessions.register(name.clone(), crate::sessions::KernelHandle {
		id: crate::sessions::SessionId::new(id.clone()),
		name: name.clone(),
		up: up.clone(),
		snapshot: Arc::new(RwLock::new(session.dom().snapshot())),
		topology,
		relay,
		autoreply,
	});
	if tools_enabled {
		let cfg: Arc<dyn omp_con::CfgLoader> =
			Arc::new(crate::cfg::CfgFiles::new(Some(&project_root))?);
		let jobs = Arc::clone(kernel.jobs());
		let eval = kernel.inference().environment().eval_control();
		let authority: Arc<dyn omp_agent::SessionAuthority> = live_sessions.clone();
		let producers = Arc::new(crate::subagent::workpool::WorkpoolRegistry::new(authority));
		let launcher = Arc::new(crate::subagent::workpool_scheduler::KernelWorkpoolLauncher::new(
			data_dir.to_path_buf(),
			sessions_dir.clone(),
			Arc::clone(&live_sessions),
			session_mutator.clone(),
			Arc::clone(&jobs),
			hub_environment.clone(),
			Arc::clone(&ctx),
			Arc::clone(&cfg),
			model.clone(),
			Arc::clone(kernel.tool_registry()),
			eval.clone(),
		));
		let scheduler = Arc::new(crate::subagent::workpool_scheduler::SchedulerRegistry::new(
			id.clone(),
			session_mutator,
			jobs,
			session.blobs().clone(),
			producers,
			launcher,
			Arc::new(crate::subagent::workpool_scheduler::ConWorkpoolPolicy::new(Arc::clone(&ctx))),
			eval,
		));
		let parent = Arc::new(crate::subagent::workpool_scheduler::WorkpoolParentHost::new(
			crate::subagent::workpool_scheduler::WorkpoolSessionHost::new(project_root.clone()),
			scheduler,
		));
		let lease = kernel
			.inference()
			.environment()
			.bind_eval_sdk_parent(id, parent)?;
		kernel.inference_mut().retain_eval_parent(lease);

		kernel = kernel.with_session_tool(Arc::new(super::goal::GoalSessionTool::new()));
		// `todo` is a session reducer: every invocation starts from the
		// journal-derived `<meta><todo>` projection, including after resume,
		// rewind, or an observer-authored todo patch.
		kernel = kernel.with_session_tool(Arc::new(super::todo::TodoSessionTool::new()));
		// ADR 0013: `subagent.cfg` and `<agent>.cfg` resolve through the same
		// user (`~/.o2`) and project cfg roots every other `exec` uses.
		// A child at the recursion ceiling never sees `task`,
		// so it cannot plan a delegation the spawner would refuse.
		if !crate::subagent::settings::task_withheld(&ctx) {
			kernel = kernel.with_session_tool(Arc::new(crate::subagent::spawn::TaskSessionTool::new(
				data_dir.to_path_buf(),
				project_root.clone(),
				sessions_dir.clone(),
				Arc::clone(&live_sessions),
				Arc::clone(&ctx),
				Arc::clone(&cfg),
				hub_environment.clone(),
				name.clone(),
				model,
			)));
		}
		kernel = kernel.with_session_tool(Arc::new(crate::subagent::hub::HubSessionTool::new(
			hub_environment,
			project_root.clone(),
			name,
			Arc::clone(&ctx),
		)));
	}
	Ok((kernel, session, prompt))
}

/// Facts fixed at composition that in-chat session switches (`/new`,
/// `/resume`, `/fork`, `/drop`) reuse: where journals live, which project
/// and model the prompt facts name, and the live-session routing index the
/// switched-in session registers with.
#[derive(Clone)]
pub struct SessionHome {
	/// Directory holding this project's `.oms` journals.
	pub sessions_dir:  PathBuf,
	/// Canonical project root recorded in prompt facts.
	pub project_root:  PathBuf,
	/// Resolved model key recorded in prompt facts.
	pub model:         Str,
	/// Invocation prompt projection overrides.
	pub prompt:        PromptOverrides,
	/// Discovered prompt material (skills, context files, rules) projected
	/// into every session's prompt facts.
	pub facts:         crate::discovery::PromptFacts,
	/// Process-local live-session routing authority.
	pub live:          Arc<crate::sessions::SessionRegistry>,
	/// Whether the session's production composition exposes the tool surface.
	pub tools_enabled: bool,
	/// The kernel's upward mailbox, shared by every session it drives.
	pub up:            flume::Sender<omp_agent::Up>,
}

impl SessionHome {
	/// Resolves the session directory exactly as [`compose_kernel`] does.
	pub fn new(
		data_dir: &Path,
		project_root: &Path,
		options: &KernelOptions,
		model: Str,
		up: flume::Sender<omp_agent::Up>,
	) -> Result<Self, HeadlessError> {
		let project_root = fs::canonicalize(project_root)?;
		let state_dir = omp_env::project_state::directory(data_dir, &project_root)?;
		let sessions_dir = options
			.sessions_dir
			.clone()
			.unwrap_or_else(|| state_dir.join("sessions"));
		fs::create_dir_all(&sessions_dir)?;
		let live = options
			.sessions
			.clone()
			.unwrap_or_else(|| Arc::new(crate::sessions::SessionRegistry::new()));
		Ok(Self {
			sessions_dir,
			project_root,
			model,
			prompt: options.prompt.clone(),
			facts: crate::discovery::PromptFacts::default(),
			live,
			tools_enabled: !options.no_tools,
			up,
		})
	}

	/// Records the discovered prompt material so sessions created in-chat
	/// carry the same prompt facts as the launch session.
	#[must_use]
	pub fn with_facts(mut self, facts: crate::discovery::PromptFacts) -> Self {
		self.facts = facts;
		self
	}

	/// Adopts the prompt material [`compose_kernel`] journaled into the launch
	/// session, so `/new`, `/fork`, and `/resume` sessions carry the same
	/// skills, context files, and rules without a second discovery pass.
	#[must_use]
	pub fn with_facts_of(self, session: &Session) -> Self {
		self.with_facts(journaled_prompt_facts(session))
	}

	/// Path of a fresh journal in the session directory.
	#[must_use]
	pub fn fresh_path(&self) -> PathBuf {
		self.sessions_dir.join(format!("{}.oms", Ulid::generate()))
	}

	/// Creates a new journal at `path` (or a fresh one), installs the prompt
	/// facts, and registers it as the live session.
	pub fn create(&self, path: Option<PathBuf>) -> Result<Session, HeadlessError> {
		let path = path.unwrap_or_else(|| self.fresh_path());
		if let Some(parent) = path.parent() {
			fs::create_dir_all(parent)?;
		}
		let mut session = Session::create(&path, ComponentRegistry::standard())?;
		install_prompt_facts(
			&mut session,
			&self.project_root,
			self.model.as_str(),
			&self.prompt,
			&self.facts,
			self.tools_enabled,
		)?;
		self.register(&session);
		Ok(session)
	}

	/// Opens an existing journal and registers it as the live session.
	pub fn open(&self, path: &Path) -> Result<Session, HeadlessError> {
		let path = resolve_session_path(&self.sessions_dir, path);
		let mut session = Session::open(&path, ComponentRegistry::standard())?;
		session.recover_process_disappearance()?;
		install_prompt_facts(
			&mut session,
			&self.project_root,
			self.model.as_str(),
			&self.prompt,
			&self.facts,
			self.tools_enabled,
		)?;
		self.register(&session);
		Ok(session)
	}

	/// Copies `source` and its session-local files to a fresh journal and opens
	/// the copy: the whole branch tree travels with the fork.
	pub fn fork(&self, source: &Path) -> Result<Session, HeadlessError> {
		let source = resolve_session_path(&self.sessions_dir, source);
		let path = self.fresh_path();
		copy_private_file(&source, &path)?;
		if let (Some(source_local), Some(destination_local)) =
			(session_local_tree(&source), session_local_tree(&path))
			&& source_local.is_dir()
			&& let Err(error) = copy_private_tree(&source_local, &destination_local)
		{
			let _ = fs::remove_file(&path);
			let _ = fs::remove_dir_all(&destination_local);
			return Err(error.into());
		}
		match self.open(&path) {
			Ok(session) => Ok(session),
			Err(error) => {
				let _ = fs::remove_file(&path);
				if let Some(local) = session_local_tree(&path) {
					let _ = fs::remove_dir_all(local);
				}
				Err(error)
			},
		}
	}

	/// Registers (or re-registers) `session` under its journal stem.
	pub fn register(&self, session: &Session) {
		let id = session
			.journal_path()
			.file_stem()
			.and_then(|name| name.to_str())
			.map_or_else(|| Str::new(Ulid::generate().to_string()), Str::new);
		let prior = self
			.live
			.list()
			.into_iter()
			.find(|live| live.up.same_channel(&self.up));
		let autoreply = prior.as_ref().and_then(|live| live.autoreply.clone());
		if let Some(producer) = &autoreply {
			producer.rebind(session.blobs().clone());
		}
		let topology = prior.as_ref().map_or_else(
			|| omp_agent::SessionTopology::main(id.clone()),
			|live| live.topology.rebind(id.clone()),
		);
		let relay = prior.map_or_else(crate::sessions::IrcRelayPolicy::default, |live| live.relay);
		self
			.live
			.register(id.clone(), crate::sessions::KernelHandle {
				id: crate::sessions::SessionId::new(id.clone()),
				name: id,
				up: self.up.clone(),
				snapshot: Arc::new(RwLock::new(session.dom().snapshot())),
				topology,
				relay,
				autoreply,
			});
	}

	/// Removes `session`'s journal from the live index (before its file is
	/// deleted or the process switches away).
	pub fn unregister(&self, session: &Session) {
		if let Some(id) = session
			.journal_path()
			.file_stem()
			.and_then(|name| name.to_str())
		{
			self.live.remove(crate::sessions::SessionId::from_ref(id));
		}
	}
}

/// Resolves a session selector the way `--resume` does: a bare id is a
/// stem in the session directory, anything with a directory or extension
/// is a path.
fn resolve_session_path(sessions_dir: &Path, path: &Path) -> PathBuf {
	if path.components().count() > 1 || path.extension().is_some() {
		path.to_path_buf()
	} else {
		sessions_dir.join(path).with_extension("oms")
	}
}

fn apply_model_override(
	ctx: &omp_con::Ctx,
	model: &str,
	explicit: bool,
) -> Result<(), HeadlessError> {
	if explicit {
		omp_agent::AI_MODEL
			.set(ctx, Str::new(model))
			.map_err(|error| std::io::Error::other(error))?;
	}
	Ok(())
}

fn route_facts(
	catalog: &omp_catalog::snapshot::Catalog,
	model: &omp_catalog::ModelSpec,
) -> RouteFacts {
	RouteFacts {
		// `forced_choice` is capability, not cost. Only an affirmative
		// penalty-free named-choice fact skips ADR 0019's soft escalation.
		forced_choice_free: catalog
			.wire_policy(&model.wire_policy)
			.and_then(|policy| policy.tool.named_choice)
			.unwrap_or(false),
		context_window:     model.limits.context_window.unwrap_or(0),
		strict_schema:      model
			.capabilities
			.chat
			.as_ref()
			.and_then(|chat| chat.tools.constraints())
			.is_some_and(|tools| {
				tools
					.features
					.contains(omp_catalog::capability::ToolFeatureBits::STRICT_SCHEMA)
			}),
		grammar:            model
			.capabilities
			.chat
			.as_ref()
			.and_then(|chat| chat.grammar.constraints())
			.copied()
			.unwrap_or_default(),
		maximum_tools:      model
			.capabilities
			.chat
			.as_ref()
			.and_then(|chat| chat.tools.constraints())
			.and_then(|tools| tools.maximum_tools),
		image_input:        model
			.capabilities
			.chat
			.as_ref()
			.and_then(|chat| chat.input_modalities.constraints())
			.is_some_and(|modalities| {
				modalities.contains(omp_catalog::capability::ModalityBits::IMAGE)
			}),
	}
}

#[derive(Debug, thiserror::Error)]
#[error("unknown tool `{name}` in --tools allow-list")]
struct UnknownTool {
	name: Str,
}

fn validate_tool_names(registry: &Registry, names: &[Str]) -> Result<(), HeadlessError> {
	for name in names {
		if registry.live_identity(name.as_str()).is_none() {
			return Err(HeadlessError::Io(std::io::Error::new(
				std::io::ErrorKind::InvalidInput,
				UnknownTool { name: name.clone() },
			)));
		}
	}
	Ok(())
}

fn resolve_model_selector(
	catalog: &omp_catalog::snapshot::Catalog,
	selector: &str,
) -> Result<Str, HeadlessError> {
	if let Some(model) = catalog.model(omp_catalog::ModelKey::from_ref(selector)) {
		return Ok(Str::new(model.key.as_str()));
	}
	if let Some(model) = catalog.resolve_alias(selector) {
		return Ok(Str::new(model.key.as_str()));
	}
	Err(HeadlessError::UnknownModel { selector: Str::new(selector) })
}

fn terminal_identity() -> Option<Str> {
	let environment = [
		"OMP_TERMINAL_ID",
		"TERM_SESSION_ID",
		"WEZTERM_PANE",
		"KITTY_WINDOW_ID",
		"WT_SESSION",
		"TMUX_PANE",
		"SSH_TTY",
		"TTY",
	]
	.into_iter()
	.find_map(|name| {
		let value = std::env::var_os(name)?;
		let value = value.to_string_lossy();
		(!value.is_empty()).then(|| Str::new(value.as_ref()))
	});
	environment.or_else(terminal_device_identity)
}

#[cfg(unix)]
fn terminal_device_identity() -> Option<Str> {
	use std::io::IsTerminal as _;
	if !std::io::stdin().is_terminal() {
		return None;
	}
	["/dev/fd/0", "/proc/self/fd/0"].into_iter().find_map(|fd| {
		let path = fs::canonicalize(fd).ok()?;
		path
			.starts_with("/dev/")
			.then(|| Str::new(path.to_string_lossy()))
	})
}

#[cfg(not(unix))]
const fn terminal_device_identity() -> Option<Str> {
	None
}

fn terminal_marker(sessions_dir: &Path, terminal: &str) -> PathBuf {
	let key = omp_core::Hash32::sum(terminal.as_bytes()).to_hex();
	sessions_dir.join(".continue").join(key.as_str())
}

/// The most recently modified `.oms` journal in `sessions_dir`, if any.
fn newest_project_session(sessions_dir: &Path) -> Result<Option<PathBuf>, HeadlessError> {
	let entries = match fs::read_dir(sessions_dir) {
		Ok(entries) => entries,
		Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
		Err(error) => return Err(error.into()),
	};
	let mut newest: Option<(std::time::SystemTime, PathBuf)> = None;
	for entry in entries {
		let entry = entry?;
		let path = entry.path();
		if path.extension().and_then(|extension| extension.to_str())
			!= Some(omp_journal::FILE_EXTENSION)
			|| !path.is_file()
		{
			continue;
		}
		let modified = entry.metadata()?.modified()?;
		if newest.as_ref().is_none_or(|(when, _)| modified > *when) {
			newest = Some((modified, path));
		}
	}
	Ok(newest.map(|(_, path)| path))
}

fn remembered_terminal_session(
	sessions_dir: &Path,
	terminal: Option<&str>,
) -> Result<Option<PathBuf>, HeadlessError> {
	let Some(terminal) = terminal else {
		return Ok(None);
	};
	let marker = terminal_marker(sessions_dir, terminal);
	let name = match fs::read_to_string(marker) {
		Ok(name) => name,
		Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
		Err(error) => return Err(error.into()),
	};
	let name = name.trim();
	let relative = Path::new(name);
	if name.is_empty()
		|| relative.components().count() != 1
		|| relative
			.extension()
			.and_then(|extension| extension.to_str())
			!= Some(omp_journal::FILE_EXTENSION)
	{
		return Ok(None);
	}
	let path = sessions_dir.join(relative);
	Ok(path.is_file().then_some(path))
}

fn remember_terminal_session(
	sessions_dir: &Path,
	terminal: Option<&str>,
	journal: &Path,
) -> Result<(), HeadlessError> {
	let Some(terminal) = terminal else {
		return Ok(());
	};
	let Ok(relative) = journal.strip_prefix(sessions_dir) else {
		return Ok(());
	};
	if relative.components().count() != 1 {
		return Ok(());
	}
	let Some(name) = relative.file_name() else {
		return Ok(());
	};
	let marker = terminal_marker(sessions_dir, terminal);
	if let Some(parent) = marker.parent() {
		fs::create_dir_all(parent)?;
	}
	fs::write(marker, name.to_string_lossy().as_bytes())?;
	Ok(())
}

fn select_journal_path(
	sessions_dir: &Path,
	explicit: Option<&Path>,
	fork: Option<&Path>,
	continue_session: bool,
	ephemeral: bool,
	terminal: Option<&str>,
) -> Result<PathBuf, HeadlessError> {
	let selected = usize::from(explicit.is_some())
		+ usize::from(fork.is_some())
		+ usize::from(continue_session)
		+ usize::from(ephemeral);
	if selected > 1 {
		return Err(
			std::io::Error::new(
				std::io::ErrorKind::InvalidInput,
				"session, fork, continue, and ephemeral modes are mutually exclusive",
			)
			.into(),
		);
	}
	if let Some(path) = explicit {
		return Ok(resolve_session_path(sessions_dir, path));
	}
	if let Some(source) = fork {
		let source = resolve_session_path(sessions_dir, source);
		let destination = sessions_dir.join(format!("{}.oms", Ulid::generate()));
		copy_private_file(&source, &destination)?;
		if let (Some(source_local), Some(destination_local)) =
			(session_local_tree(&source), session_local_tree(&destination))
			&& source_local.is_dir()
			&& let Err(error) = copy_private_tree(&source_local, &destination_local)
		{
			let _ = fs::remove_file(&destination);
			let _ = fs::remove_dir_all(&destination_local);
			return Err(error.into());
		}
		return Ok(destination);
	}
	if continue_session {
		if let Some(path) = remembered_terminal_session(sessions_dir, terminal)? {
			return Ok(path);
		}
		// No breadcrumb exists for this terminal, so
		// continue the project's newest journal before creating a fresh one.
		if let Some(path) = newest_project_session(sessions_dir)? {
			return Ok(path);
		}
	}
	if !ephemeral {
		return Ok(sessions_dir.join(format!("{}.oms", Ulid::generate())));
	}
	loop {
		let root = std::env::temp_dir().join(format!("omp-session-{}", Ulid::generate()));
		match fs::create_dir(&root) {
			Ok(()) => return Ok(root.join("session.oms")),
			Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {},
			Err(error) => return Err(error.into()),
		}
	}
}

fn session_local_tree(journal: &Path) -> Option<PathBuf> {
	let stem = journal.file_stem().filter(|stem| !stem.is_empty())?;
	Some(journal.with_file_name(stem))
}

fn copy_private_file(source: &Path, destination: &Path) -> std::io::Result<()> {
	let result = (|| {
		let mut source = fs::File::open(source)?;
		let mut destination = fs::OpenOptions::new()
			.write(true)
			.create_new(true)
			.open(destination)?;
		std::io::copy(&mut source, &mut destination)?;
		destination.sync_all()
	})();
	if result.is_err() {
		let _ = fs::remove_file(destination);
	}
	result
}

fn copy_private_tree(source: &Path, destination: &Path) -> std::io::Result<()> {
	fs::create_dir_all(destination)?;
	for entry in fs::read_dir(source)? {
		let entry = entry?;
		let file_type = entry.file_type()?;
		let target = destination.join(entry.file_name());
		if file_type.is_dir() {
			copy_private_tree(&entry.path(), &target)?;
		} else if file_type.is_file() {
			fs::copy(entry.path(), target)?;
		}
	}
	Ok(())
}

/// The discovered prompt material [`install_prompt_facts`] journaled on
/// `session`'s `<meta>`; empty when the session carries no facts.
#[must_use]
pub fn journaled_prompt_facts(session: &Session) -> crate::discovery::PromptFacts {
	let dom = session.dom();
	let mut facts = crate::discovery::PromptFacts::default();
	let Some(Value::Json(raw)) = dom
		.get(dom.meta())
		.and_then(|node| node.prop(&PropKey::Custom(Str::new_static("prompt-facts"))))
	else {
		return facts;
	};
	let Ok(serde_json::Value::Object(mut values)) =
		serde_json::from_str::<serde_json::Value>(raw.get())
	else {
		return facts;
	};
	let mut take = |key: &str| match values.remove(key) {
		Some(serde_json::Value::Array(rows)) => rows,
		_ => Vec::new(),
	};
	facts.skills = take("skills");
	facts.context_files = take("context_files");
	facts.always_apply_rules = take("always_apply_rules");
	facts.rules = take("rules");
	facts.active_repository = values
		.remove("active_repository")
		.and_then(|value| serde_json::from_value(value).ok());
	facts
}

/// Discovers context files and rules for `project_root` under the invocation
/// prompt policy: `--no-context-files` / `--no-rules` yield empty sets so the
/// flags are honest seams rather than post-hoc filters.
fn discover_prompt_material(
	project_root: &Path,
	overrides: &PromptOverrides,
) -> Result<
	(crate::discovery::rules::ContextFiles, Arc<crate::discovery::rules::ActiveRules>),
	HeadlessError,
> {
	use crate::discovery::rules::{ActiveRules, ContextFiles};
	if !overrides.include_context_files && !overrides.include_rules {
		return Ok((ContextFiles::default(), Arc::new(ActiveRules::default())));
	}
	let home = omp_core::dirs::home_dir().ok_or(omp_core::dirs::DataDirError::HomeUnset)?;
	let config_root = omp_core::dirs::user_config_root()?;
	let context_files = if overrides.include_context_files {
		ContextFiles::discover(project_root, &home, &config_root)
	} else {
		ContextFiles::default()
	};
	let rules = if overrides.include_rules {
		ActiveRules::discover(project_root, &home, &config_root)
	} else {
		ActiveRules::default()
	};
	for warning in context_files.warnings.iter().chain(&rules.warnings) {
		tracing::warn!(path = %warning.path.display(), "{}", warning.message);
	}
	Ok((context_files, Arc::new(rules)))
}

fn install_prompt_facts(
	session: &mut Session,
	project_root: &Path,
	model: &str,
	overrides: &PromptOverrides,
	discovered: &crate::discovery::PromptFacts,
	tools_enabled: bool,
) -> Result<(), omp_session::SessionError> {
	let home = std::env::var_os("HOME").map_or_else(|| project_root.to_path_buf(), PathBuf::from);
	let mut facts = serde_json::json!({
		"cwd": project_root.to_string_lossy(),
		"home": home.to_string_lossy(),
		"model": { "identifier": model, "codex_task_policy": false },
		"context_files": discovered.context_files,
		"context_files_enabled": overrides.include_context_files,
		"always_apply_rules": discovered.always_apply_rules,
		"rules": discovered.rules,
		"additional_roots": overrides
			.additional_roots
			.iter()
			.map(|root| root.to_string_lossy().into_owned())
			.collect::<Vec<_>>(),
		"skills": discovered.skills,
		"date": jiff::Zoned::now().strftime("%Y-%m-%d").to_string(),
		"null_prompt": overrides.null_prompt,
	});
	let object = facts.as_object_mut().expect("prompt facts are an object");
	if tools_enabled {
		object.insert(
			"device_guidance".to_owned(),
			serde_json::Value::String(omp_tools::device::PROMPT_GUIDANCE.to_owned()),
		);
		object.insert(
			"auto_qa_guidance".to_owned(),
			serde_json::Value::String(omp_tools::device::AUTO_QA_PROMPT_GUIDANCE.to_owned()),
		);
	}
	// Only a resolved repository is journaled: `active-repo.md` renders
	// whenever the key is present, so a JSON null would misfire.
	if let Some(repository) = &discovered.active_repository {
		object.insert("active_repository".to_owned(), serde_json::to_value(repository)?);
	}
	for (name, value) in [
		("custom_prompt", overrides.custom_prompt.as_ref()),
		("append_prompt", overrides.append_prompt.as_ref()),
		("personality", overrides.personality.as_ref()),
	] {
		if let Some(value) = value {
			object.insert(name.to_owned(), serde_json::Value::String(value.to_string()));
		}
	}
	for (name, value) in [
		("include_model", overrides.include_model),
		("include_workstation", overrides.include_workstation),
		("include_workspace_tree", overrides.include_workspace_tree),
		("render_mermaid", overrides.render_mermaid),
		("include_skills", overrides.include_skills),
	] {
		if let Some(value) = value {
			object.insert(name.to_owned(), serde_json::Value::Bool(value));
		}
	}
	let raw = serde_json::value::to_raw_value(&facts)?;
	session.patch(Txn {
		cause: session
			.head()
			.ok_or(omp_session::SessionError::NoActiveTurn)?,
		label: Some(Str::new_static("prompt.facts")),
		ops:   vec![Op::Set {
			h:     session.dom().meta(),
			prop:  PropKey::Custom(Str::new_static("prompt-facts")),
			value: Value::Json(raw),
		}],
	})?;
	Ok(())
}

#[cfg(test)]
mod tests {
	use std::sync::Arc;

	use omp_ai::{
		ChatRequest, NegotiationPolicy, RequestId, Sampling, Setting,
		codec::{
			EncodeContext,
			openai_responses::{OpenAiResponsesCodec, OpenAiResponsesOptions},
		},
	};
	use omp_catalog::{
		ModelKey, ReasoningEffort, ThinkingEffort, ThinkingPolicy, WireTarget, snapshot::Catalog,
	};
	use omp_core::sf;

	use super::{
		EphemeralJournal, HeadlessError, KernelOptions, PromptOverrides, apply_model_override,
		convar_reasoning, install_prompt_facts, install_workpool_yield_contract,
		install_yield_contract, remember_terminal_session, replicate_outcome_blob,
		replicate_verdict_parts, route_facts, select_journal_path, session_local_tree,
		validate_tool_names,
	};

	const GPT5: &str = "openai/gpt-5";

	#[tokio::test]
	async fn remote_outcome_replication_resumes_with_stable_session_provenance() {
		let (client, transport) = omp_env::EnvClient::in_process(0);
		let client = client
			.with_principal("session-a", "kernel")
			.expect("valid principal");
		let bytes = b"detached outcome crossing hosts";
		let size = u64::try_from(bytes.len()).expect("fixture size fits u64");
		let digest = omp_core::Hash32::sum(bytes);
		let scratch = tempfile::tempdir().expect("temporary CAS");
		let store = omp_journal::blob::BlobStore::open(scratch.path()).expect("open session CAS");
		let cancel = tokio_util::sync::CancellationToken::new();
		let replication = tokio::spawn({
			let client = client.clone();
			let store = store.clone();
			let cancel = cancel.clone();
			async move {
				replicate_outcome_blob(&client, &store, "call-a", digest, size, 1024, &cancel).await
			}
		});

		let first = transport.recv().await.expect("first blob range");
		let first_request = match first.body {
			Some(omp_env::frame::client_frame::Body::BlobGet(request)) => request,
			_ => panic!("expected first blob get"),
		};
		assert_eq!(first_request.offset, 0);
		assert_eq!(
			first.scope.as_ref().map(|scope| (
				scope.session_id.as_str(),
				scope.agent_id.as_str(),
				scope.invocation_id.as_str(),
			)),
			Some(("session-a", "kernel", "call-a"))
		);
		let split = 9;
		transport
			.send(omp_env::frame::ServerFrame {
				request_id: first.request_id,
				body: Some(omp_env::frame::server_frame::Body::BlobChunk(omp_env::blob_frame::Chunk {
					data: bytes::Bytes::copy_from_slice(&bytes[..split]),
					hash: bytes::Bytes::copy_from_slice(digest.as_bytes()),
					size: Some(size),
				})),
				..Default::default()
			})
			.await
			.expect("first blob chunk");
		transport
			.send(omp_env::frame::ServerFrame {
				request_id: first.request_id,
				body: Some(omp_env::frame::server_frame::Body::EventStreamError(
					omp_env::frame::EventStreamError {
						stream: omp_env::frame::EventStreamKind::Unspecified as i32,
						failure: omp_env::frame::EventStreamFailure::Closed as i32,
						message: "remote blob stream interrupted".into(),
						..Default::default()
					},
				)),
				..Default::default()
			})
			.await
			.expect("interrupt first range");

		let resumed = loop {
			let frame = transport.recv().await.expect("resumed blob range");
			if matches!(&frame.body, Some(omp_env::frame::client_frame::Body::BlobGet(_))) {
				break frame;
			}
		};
		let resumed_request = match resumed.body {
			Some(omp_env::frame::client_frame::Body::BlobGet(request)) => request,
			_ => unreachable!("filtered to blob get"),
		};
		assert_eq!(resumed_request.offset, u64::try_from(split).expect("split fits u64"));
		assert_eq!(resumed.scope, first.scope);
		transport
			.send(omp_env::frame::ServerFrame {
				request_id: resumed.request_id,
				body: Some(omp_env::frame::server_frame::Body::BlobChunk(omp_env::blob_frame::Chunk {
					data: bytes::Bytes::copy_from_slice(&bytes[split..]),
					hash: bytes::Bytes::copy_from_slice(digest.as_bytes()),
					size: Some(size),
				})),
				..Default::default()
			})
			.await
			.expect("resumed blob chunk");
		transport
			.send(omp_env::frame::ServerFrame {
				request_id: resumed.request_id,
				body: Some(omp_env::frame::server_frame::Body::BlobGetComplete(
					omp_env::frame::BlobGetComplete {
						hash: bytes::Bytes::copy_from_slice(digest.as_bytes()),
						bytes_sent: u64::try_from(bytes.len() - split).expect("remainder fits u64"),
						..Default::default()
					},
				)),
				..Default::default()
			})
			.await
			.expect("complete resumed range");

		let reference = replication
			.await
			.expect("replication task")
			.expect("replicated outcome");
		assert_eq!(reference.hash, digest);
		assert_eq!(store.get(&reference).expect("read local replica").as_ref(), bytes);
	}

	#[tokio::test]
	async fn inline_tool_media_is_canonicalized_into_the_session_cas() {
		let (client, _transport) = omp_env::EnvClient::in_process(0);
		let scratch = tempfile::tempdir().expect("temporary CAS");
		let store = omp_journal::blob::BlobStore::open(scratch.path()).expect("open session CAS");
		let bytes = bytes::Bytes::from_static(b"tool image");
		let cancel = tokio_util::sync::CancellationToken::new();
		let parts = replicate_verdict_parts(
			&client,
			&store,
			"call-media",
			vec![omp_proto::thread::v1::Part {
				kind: Some(omp_proto::thread::v1::part::Kind::Blob(omp_proto::thread::v1::Blob {
					mime: "image/png".to_owned(),
					size: u64::try_from(bytes.len()).expect("fixture length"),
					inline: bytes.clone(),
					..Default::default()
				})),
			}],
			1024,
			&cancel,
		)
		.await
		.expect("pin media");
		let [omp_tool::Part::Blob { blob, .. }] = parts.as_slice() else {
			panic!("one canonical blob part: {parts:?}");
		};
		let reference = omp_journal::blob::BlobRef::parse_hex(blob.hash.as_str(), blob.byte_len)
			.expect("canonical reference");
		assert_eq!(
			store.get(&reference).expect("session media").as_ref(),
			bytes.as_ref(),
			"tool media resolves without the environment host"
		);
	}

	fn gpt5_policy(catalog: &Catalog) -> &ThinkingPolicy {
		let spec = catalog
			.model(ModelKey::from_ref(GPT5))
			.expect("embedded gpt-5");
		catalog
			.thinking_policy(spec.thinking.as_ref().expect("gpt-5 reasons"))
			.expect("gpt-5 thinking policy")
	}

	fn effort(setting: &Setting<omp_ai::ReasoningRequest>) -> Option<ReasoningEffort> {
		match setting {
			Setting::Unset => None,
			Setting::Require(value) | Setting::Prefer(value) => value.effort,
		}
	}

	/// Lowers the convar-derived request for gpt-5 through the planner's
	/// thinking resolution and the Responses codec, exactly as a live call
	/// would, and returns the serialized `reasoning` object.
	fn gpt5_wire_reasoning(catalog: &Catalog, thinking: &str) -> Option<serde_json::Value> {
		let key = ModelKey::from_ref(GPT5);
		let spec = catalog.model(key).expect("embedded gpt-5");
		let policy = gpt5_policy(catalog);
		let route = spec
			.routes
			.iter()
			.filter_map(|route| catalog.route(route))
			.find(|route| route.codec.as_str() == "openai-responses")
			.expect("gpt-5 Responses route");
		let wire_model = spec
			.wire_ids
			.iter()
			.find(|(candidate, _)| candidate == &route.id)
			.expect("gpt-5 wire id")
			.1
			.clone();
		let wire_policy = catalog
			.wire_policy(&spec.wire_policy)
			.expect("gpt-5 wire policy");
		let request = ChatRequest {
			messages:          Arc::from([]),
			tools:             Arc::from([]),
			hosted_tools:      Arc::from([]),
			tool_choice:       Setting::Unset,
			output:            Setting::Unset,
			reasoning:         convar_reasoning(catalog, key, thinking),
			verbosity:         Setting::Unset,
			cache_retention:   Setting::Unset,
			service_tier:      Setting::Unset,
			sampling:          Sampling::default(),
			max_output_tokens: None,
			top_logprobs:      None,
			safety:            Arc::from([]),
			negotiation:       NegotiationPolicy::default(),
			forced_call:       None,
		};
		let selection = effort(&request.reasoning).map(|effort| {
			spec
				.thinking_routing
				.resolve(policy, Some(effort.into()), &wire_model)
				.expect("convar effort resolves against the catalog")
		});
		let target = WireTarget {
			route: route.id.clone(),
			codec: route.codec.clone(),
			endpoint: route.endpoint.clone(),
			wire_model,
		};
		let request_id = RequestId::new("convar-thinking");
		let context = EncodeContext {
			request_id: &request_id,
			route,
			target: Some(&target),
			policy: wire_policy,
			thinking_policy: Some(policy),
			thinking_selection: selection.as_ref(),
			..EncodeContext::default()
		};
		let encoded = OpenAiResponsesCodec::new(OpenAiResponsesOptions::default())
			.encode_chat(&context, &request)
			.expect("gpt-5 request encodes");
		encoded
			.request
			.reasoning
			.as_ref()
			.map(|reasoning| serde_json::to_value(reasoning).expect("reasoning serializes"))
	}

	#[test]
	fn ai_thinking_off_never_sends_none_to_a_model_without_off() {
		let catalog = Catalog::embedded();
		let policy = gpt5_policy(catalog);
		assert!(
			!policy.efforts.contains(&ThinkingEffort::Off)
				&& policy.efforts.contains(&ThinkingEffort::Minimal),
			"gpt-5 ladder is minimal..high with no wire `none`: {:?}",
			policy.efforts
		);
		let reasoning = gpt5_wire_reasoning(catalog, "off");
		let effort = reasoning
			.as_ref()
			.and_then(|reasoning| reasoning.get("effort"))
			.cloned();
		assert_eq!(effort, None, "reasoning-off must not spell an effort: {reasoning:?}");
	}

	#[test]
	fn ai_thinking_above_the_ladder_clamps_to_the_catalog_ceiling() {
		let catalog = Catalog::embedded();
		let request = convar_reasoning(catalog, ModelKey::from_ref(GPT5), "xhigh");
		assert_eq!(effort(&request), Some(ReasoningEffort::High));
		let reasoning = gpt5_wire_reasoning(catalog, "xhigh").expect("reasoning object");
		assert_eq!(reasoning.get("effort"), Some(&serde_json::json!("high")));
	}

	#[test]
	fn ai_thinking_off_on_a_model_that_requires_effort_uses_the_catalog_default() {
		let catalog = Catalog::embedded();
		let (spec, policy) = catalog
			.models()
			.iter()
			.find_map(|spec| {
				let policy = catalog.thinking_policy(spec.thinking.as_ref()?)?;
				(policy.requires_effort == Some(true)).then_some((spec, policy))
			})
			.expect("embedded catalog has a model that cannot stop reasoning");
		assert!(!policy.supports(ThinkingEffort::Off));
		let request = convar_reasoning(catalog, &spec.key, "off");
		assert_eq!(
			effort(&request),
			policy.default_level.map(ReasoningEffort::from),
			"{}: off falls back to the catalog default level",
			spec.key
		);
	}

	#[test]
	fn ai_thinking_without_a_thinking_policy_leaves_reasoning_unset() {
		let catalog = Catalog::embedded();
		let spec = catalog
			.models()
			.iter()
			.find(|spec| spec.thinking.is_none())
			.expect("embedded catalog has a non-reasoning model");
		assert!(matches!(convar_reasoning(catalog, &spec.key, "high"), Setting::Unset));
	}

	#[test]
	fn explicit_model_replaces_the_restored_session_value() {
		let ctx = omp_con::Ctx::new();
		ctx.restore_session_write("ai_model", "archived/model")
			.expect("restored model");
		apply_model_override(&ctx, "explicit/model", true).expect("explicit model");
		assert_eq!(omp_agent::AI_MODEL.get(&ctx).as_str(), "explicit/model");
		assert!(
			ctx.session_writes()
				.any(|(name, value)| name == "ai_model" && value.to_string() == "explicit/model")
		);

		let inherited = omp_con::Ctx::new();
		inherited
			.restore_session_write("ai_model", "archived/model")
			.expect("restored model");
		apply_model_override(&inherited, "default/model", false).expect("default model");
		assert_eq!(omp_agent::AI_MODEL.get(&inherited).as_str(), "archived/model");
	}

	#[test]
	fn continue_prefers_the_terminal_breadcrumb_then_the_newest_project_session() {
		let scratch = tempfile::tempdir().expect("tempdir");
		let sessions = scratch.path();
		let first = sessions.join("first.oms");
		std::fs::write(&first, b"journal").expect("journal");
		remember_terminal_session(sessions, Some("terminal-a"), &first).expect("breadcrumb");

		let resumed = select_journal_path(sessions, None, None, true, false, Some("terminal-a"))
			.expect("continue");
		assert_eq!(resumed, first);

		// A terminal without its own breadcrumb continues the newest session of the
		// project, not a fresh one.
		let other_terminal =
			select_journal_path(sessions, None, None, true, false, Some("terminal-b"))
				.expect("newest project session");
		assert_eq!(other_terminal, first);

		// A stale breadcrumb with no journals left falls back to a fresh journal.
		std::fs::remove_file(&first).expect("remove stale journal");
		let stale = select_journal_path(sessions, None, None, true, false, Some("terminal-a"))
			.expect("stale fallback");
		assert_ne!(stale, first);
		assert!(!stale.exists());
		assert_eq!(stale.parent(), Some(sessions));
	}

	#[test]
	fn startup_fork_copies_to_a_fresh_project_journal() {
		let scratch = tempfile::tempdir().expect("tempdir");
		let source = scratch.path().join("source.oms");
		std::fs::write(&source, b"authoritative branch").expect("source");
		std::fs::create_dir_all(scratch.path().join("source/local")).expect("local root");
		std::fs::write(scratch.path().join("source/local/plan.md"), b"branch-local")
			.expect("local artifact");
		let fork = select_journal_path(
			scratch.path(),
			None,
			Some(std::path::Path::new("source")),
			false,
			false,
			None,
		)
		.expect("fork");
		assert_ne!(fork, source);
		assert_eq!(std::fs::read(&fork).expect("fork bytes"), b"authoritative branch");
		let fork_local = session_local_tree(&fork).expect("fork local root");
		assert_eq!(
			std::fs::read(fork_local.join("local/plan.md")).expect("fork local artifact"),
			b"branch-local"
		);
	}

	#[test]
	fn ephemeral_cleanup_removes_the_private_journal_and_blob_namespace() {
		let scratch = tempfile::tempdir().expect("tempdir");
		let path =
			select_journal_path(scratch.path(), None, None, false, true, None).expect("private path");
		let root = path.parent().expect("private root").to_path_buf();
		let cleanup = EphemeralJournal { root: root.clone() };
		assert!(root.is_dir(), "selector atomically reserves the owned directory");
		assert_ne!(root, scratch.path());
		std::fs::create_dir_all(root.join("blobs/aa/bb")).expect("blob directories");
		std::fs::create_dir_all(root.join("local")).expect("local directory");
		std::fs::write(&path, b"private transcript").expect("journal");
		std::fs::write(root.join("blobs/aa/bb/content"), b"private media").expect("media");
		std::fs::write(root.join("local/paste.md"), b"private local artifact").expect("local");

		drop(cleanup);

		assert!(!root.exists(), "the no-session namespace must not leak");
	}

	#[test]
	fn prompt_overrides_are_journaled_as_prompt_facts() {
		let scratch = tempfile::tempdir().expect("tempdir");
		let path = scratch.path().join("prompt.oms");
		let mut session =
			omp_session::Session::create(path, omp_session::ComponentRegistry::standard())
				.expect("session");
		let overrides = PromptOverrides {
			custom_prompt: Some(omp_core::Str::new_static("custom")),
			append_prompt: Some(omp_core::Str::new_static("append")),
			include_model: Some(false),
			null_prompt: true,
			..PromptOverrides::default()
		};
		install_prompt_facts(
			&mut session,
			scratch.path(),
			"provider/model",
			&overrides,
			&crate::discovery::PromptFacts::default(),
			true,
		)
		.expect("prompt facts");
		let value = session
			.dom()
			.get(session.dom().meta())
			.and_then(|meta| {
				meta.prop(&omp_dom::PropKey::Custom(omp_core::Str::new_static("prompt-facts")))
			})
			.expect("prompt facts prop");
		let omp_dom::Value::Json(raw) = value else {
			panic!("prompt facts are structured JSON");
		};
		let facts: serde_json::Value = serde_json::from_str(raw.get()).expect("facts JSON");
		assert_eq!(facts["custom_prompt"], "custom");
		assert_eq!(facts["append_prompt"], "append");
		assert_eq!(facts["include_model"], false);
		assert_eq!(facts["null_prompt"], true);
		assert_eq!(facts["device_guidance"], omp_tools::device::PROMPT_GUIDANCE);
		assert_eq!(facts["auto_qa_guidance"], omp_tools::device::AUTO_QA_PROMPT_GUIDANCE,);
	}

	#[test]
	fn discovered_material_round_trips_through_prompt_facts_and_session_home() {
		let scratch = tempfile::tempdir().expect("tempdir");
		let path = scratch.path().join("facts.oms");
		let mut session =
			omp_session::Session::create(path, omp_session::ComponentRegistry::standard())
				.expect("session");
		let discovered = crate::discovery::PromptFacts {
			skills:             vec![serde_json::json!({ "name": "tla", "description": "TLA" })],
			context_files:      vec![
				serde_json::json!({ "origin": "/p/AGENTS.md", "content": "ctx" }),
			],
			always_apply_rules: vec![serde_json::json!({ "name": "RULES", "content": "sticky" })],
			rules:              vec![
				serde_json::json!({ "name": "style", "description": "d", "globs": ["*.rs"] }),
			],
			active_repository:  Some(crate::discovery::active_repo::ActiveRepository {
				relative_root: std::path::PathBuf::from("omp"),
			}),
		};
		install_prompt_facts(
			&mut session,
			scratch.path(),
			"provider/model",
			&PromptOverrides::default(),
			&discovered,
			true,
		)
		.expect("prompt facts");
		let props = omp_agent::prompt::template_props(session.dom());
		for key in ["skills", "context_files", "always_apply_rules", "rules", "active_repository"] {
			assert!(
				props.get(key).is_some_and(omp_scribe::Value::is_truthy),
				"{key} reaches the template props"
			);
		}
		assert_eq!(super::journaled_prompt_facts(&session), discovered, "facts read back for /new");
		use omp_proto::thread::v1::{item, part};
		let rendered = omp_agent::prompt::CanonicalPromptSource
			.system_items(session.dom())
			.expect("system prompt")
			.into_iter()
			.filter_map(|item| match item.kind {
				Some(item::Kind::Message(message)) => Some(message.parts),
				_ => None,
			})
			.flatten()
			.filter_map(|part| match part.kind {
				Some(part::Kind::Text(text)) => Some(text),
				_ => None,
			})
			.collect::<Vec<_>>()
			.join("\n");
		assert!(
			rendered.contains("Exactly one direct-child git repo detected: `omp`"),
			"active-repo.md names the nested repository:\n{rendered}"
		);
	}

	#[test]
	fn cwd_inside_a_repository_journals_no_active_repository() {
		let scratch = tempfile::tempdir().expect("tempdir");
		let path = scratch.path().join("facts.oms");
		let mut session =
			omp_session::Session::create(path, omp_session::ComponentRegistry::standard())
				.expect("session");
		install_prompt_facts(
			&mut session,
			scratch.path(),
			"provider/model",
			&PromptOverrides::default(),
			&crate::discovery::PromptFacts::default(),
			true,
		)
		.expect("prompt facts");
		let props = omp_agent::prompt::template_props(session.dom());
		assert!(
			props.get("active_repository").is_none(),
			"an unresolved repository never reaches the template (a null would render active-repo.md)"
		);
		assert_eq!(super::journaled_prompt_facts(&session).active_repository, None);
	}

	#[test]
	fn no_rules_and_no_context_files_yield_empty_material() {
		let scratch = tempfile::tempdir().expect("tempdir");
		let project = scratch.path().join("proj");
		std::fs::create_dir_all(project.join(".omp/rules")).expect("rules dir");
		std::fs::create_dir_all(project.join(".git")).expect("repo root");
		std::fs::write(project.join(".omp/rules/one.md"), "---\nalwaysApply: true\n---\nbody\n")
			.expect("rule");
		std::fs::write(project.join("AGENTS.md"), "context\n").expect("context file");

		// The developer's own `<config root>` may hold user-level material;
		// only the scratch project's files are asserted.
		use crate::discovery::rules::Level;
		let project_files = |files: &crate::discovery::rules::ContextFiles| {
			files
				.files
				.iter()
				.filter(|file| file.level == Level::Project)
				.count()
		};
		let project_rules = |rules: &crate::discovery::rules::ActiveRules| {
			rules
				.rules
				.iter()
				.filter(|rule| rule.level == Level::Project)
				.count()
		};
		let (files, rules) =
			super::discover_prompt_material(&project, &PromptOverrides::default()).expect("discovery");
		assert_eq!(project_files(&files), 1);
		assert_eq!(project_rules(&rules), 1);

		let no_rules = PromptOverrides { include_rules: false, ..PromptOverrides::default() };
		let (files, rules) = super::discover_prompt_material(&project, &no_rules).expect("discovery");
		assert_eq!(project_files(&files), 1, "--no-rules leaves context files alone");
		assert!(rules.rules.is_empty(), "--no-rules suppresses rule discovery");

		let no_context =
			PromptOverrides { include_context_files: false, ..PromptOverrides::default() };
		let (files, rules) =
			super::discover_prompt_material(&project, &no_context).expect("discovery");
		assert!(files.files.is_empty(), "--no-context-files suppresses context files");
		assert_eq!(project_rules(&rules), 1);
	}

	#[test]
	fn forced_choice_capability_does_not_claim_penalty_free_routing() {
		let catalog = Catalog::embedded();
		let paid = catalog
			.models()
			.iter()
			.find(|model| {
				model.key.as_str().contains("claude")
					&& catalog
						.wire_policy(&model.wire_policy)
						.is_some_and(|policy| {
							policy.tool.forced_choice == Some(true)
								&& policy.tool.named_choice != Some(true)
						})
			})
			.expect("embedded Anthropic model has paid forced choice");
		assert!(!route_facts(catalog, paid).forced_choice_free);
	}

	#[test]
	fn ordinary_kernel_retains_generic_yield_contract() {
		let mut registry = omp_tool::Registry::new();
		registry
			.register(
				omp_tools::yield_tool::tool(),
				omp_tool::Presentation::Hidden,
				omp_tool::Claims {
					precedence: omp_tool::Precedence::CORE,
					claimant:   omp_core::Str::new_static("omp/core"),
					replaces:   None,
				},
			)
			.expect("generic yield");
		let registry = Arc::new(registry);
		let installed =
			install_yield_contract(Arc::clone(&registry), None, None).expect("ordinary registry");
		assert!(Arc::ptr_eq(&registry, &installed));
		assert!(matches!(
			installed.live_spec("yield").expect("yield").constraint,
			omp_tool::Constraint::None
		));
	}

	#[test]
	fn workpool_yield_contract_is_child_local_and_rebuilt_for_each_batch() {
		let mut registry = omp_tool::Registry::new();
		registry
			.register(
				omp_tools::yield_tool::tool(),
				omp_tool::Presentation::Hidden,
				omp_tool::Claims {
					precedence: omp_tool::Precedence::CORE,
					claimant:   omp_core::Str::new_static("omp/core"),
					replaces:   None,
				},
			)
			.expect("generic yield");
		let original = Arc::new(registry);
		let batch = install_workpool_yield_contract(original.as_ref(), vec![
			omp_tools::yield_tool::WorkpoolItem { id: sf!("pool#1"), index: 1 },
			omp_tools::yield_tool::WorkpoolItem { id: sf!("pool#2"), index: 2 },
		])
		.expect("batch contract");
		assert!(matches!(
			original
				.live_spec("yield")
				.expect("parent yield")
				.constraint,
			omp_tool::Constraint::None
		));
		let schema: serde_json::Value =
			serde_json::from_slice(&batch.live_spec("yield").expect("child yield").schema)
				.expect("batch schema");
		assert_eq!(schema["properties"]["key"]["enum"], serde_json::json!([1, 2]));
		assert!(matches!(
			batch.live_spec("yield").expect("child yield").constraint,
			omp_tool::Constraint::None
		));
		assert_eq!(
			batch.presentation("yield").expect("child presentation"),
			omp_tool::Presentation::Slot
		);
		let next = install_workpool_yield_contract(batch.as_ref(), vec![
			omp_tools::yield_tool::WorkpoolItem { id: sf!("pool#3"), index: 1 },
		])
		.expect("next batch contract");
		let next_schema: serde_json::Value =
			serde_json::from_slice(&next.live_spec("yield").expect("next yield").schema)
				.expect("next schema");
		assert_eq!(next_schema["properties"]["key"]["enum"], serde_json::json!([1]));
	}

	#[test]
	fn child_schema_replaces_generic_yield_before_registry_freeze() {
		let mut registry = omp_tool::Registry::new();
		registry
			.register(
				omp_tools::yield_tool::tool(),
				omp_tool::Presentation::Hidden,
				omp_tool::Claims {
					precedence: omp_tool::Precedence::CORE,
					claimant:   omp_core::Str::new_static("omp/core"),
					replaces:   None,
				},
			)
			.expect("generic yield");
		let installed = install_yield_contract(
			Arc::new(registry),
			Some(&serde_json::json!({
				"type": "object",
				"required": ["ok"],
				"properties": {"ok": {"type": "boolean"}},
			})),
			Some(omp_tools::output_schema::SchemaMode::Strict),
		)
		.expect("child yield contract");
		let spec = installed.live_spec("yield").expect("yield");
		assert!(matches!(spec.constraint, omp_tool::Constraint::Schema { priority: 100, .. }));
		assert_eq!(
			installed.presentation("yield").expect("presentation"),
			omp_tool::Presentation::Hidden
		);
		let schema: serde_json::Value =
			serde_json::from_slice(&spec.schema).expect("yield parameter schema");
		assert_eq!(
			schema["properties"]["result"]["oneOf"][0]["properties"]["data"]["anyOf"][0]["properties"]
				["ok"]["type"],
			"boolean"
		);
	}

	#[test]
	fn child_schema_installs_yield_in_an_otherwise_empty_registry() {
		let installed = install_yield_contract(
			Arc::new(omp_tool::Registry::new()),
			Some(&serde_json::json!({"type": "boolean"})),
			None,
		)
		.expect("child yield contract");
		assert_eq!(installed.live_identities().len(), 1);
		assert!(installed.live_identity("yield").is_some());
		assert!(matches!(
			installed.live_spec("yield").expect("yield").constraint,
			omp_tool::Constraint::None
		));
	}

	#[test]
	fn malformed_child_schema_fails_kernel_composition() {
		let result = install_yield_contract(
			Arc::new(omp_tool::Registry::new()),
			Some(&serde_json::json!(["not", "a", "schema"])),
			Some(omp_tools::output_schema::SchemaMode::Strict),
		);
		assert!(matches!(result, Err(HeadlessError::YieldSchema(_))));
	}

	#[test]
	fn unknown_tool_allow_list_is_rejected_before_kernel_construction() {
		let registry = omp_tool::Registry::new();
		let error =
			validate_tool_names(&registry, &[omp_core::Str::new_static("definitely-not-installed")])
				.expect_err("unknown tool");
		let HeadlessError::Io(error) = error else {
			panic!("tool validation is an invalid-input error");
		};
		assert!(error.to_string().contains("definitely-not-installed"));
	}

	#[test]
	fn approval_override_is_typed_in_kernel_options() {
		let options = KernelOptions {
			approval_mode: Some(omp_envd::tool_settings::ApprovalMode::AlwaysAsk),
			..KernelOptions::default()
		};
		assert_eq!(options.approval_mode, Some(omp_envd::tool_settings::ApprovalMode::AlwaysAsk));
	}
}
