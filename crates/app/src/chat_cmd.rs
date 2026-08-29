//! Interactive terminal and GUI host for durable project chat.

use std::{
	collections::{BTreeMap, BTreeSet},
	env, fs, iter,
	path::{Path, PathBuf},
	sync::{
		self, Arc,
		atomic::{AtomicBool, Ordering},
	},
	time::{Duration, Instant},
};

use bytes::{Bytes, BytesMut};
use miette::IntoDiagnostic as _;
#[cfg(unix)]
use nix::sys::signal;
#[cfg(unix)]
use nix::unistd::Pid;
use omp_agent::{
	Agent, AgentHostControl, AgentKind, AgentState, AgentStatus, Budget, GateError, GateEvent,
	GateOutcome, HookEvent, HookPatch, InProcTurnClient, JournalAuthor, RpcTurnClient, TurnClient,
	advisor::{AdviceDelivery, AdvisorAdviceQueue, DeliveryContext},
};
use omp_catalog::snapshot;
use omp_chat_ui::host;
use omp_collab::guest::GuestRelayPump;
use omp_core::{ArtifactDigest, Provenance, Str, sf};
use omp_driver::{
	advisor::{
		engine::{AdviceOutcome, AdvisorEngine, AdvisorEngineOptions, AdvisorPromptJob},
		runtime::{ActiveAdvisorRegime, AdvisorFailureClass},
		transcript::{AdvisorTranscriptRecord, AdvisorUsageTotals},
	},
	autolearn::AutolearnRegime,
	bridges::{AgentGoalControl, InferenceBridge},
	chat::{
		AdvisorChildSpec, AgentsControlAuthority, CHAT_CAPS_BASE, ChatAuthWorker,
		ChatError as DriverChatError, ChatParentHost, ChatProviderControlBackend, ChatScope,
		EphemeralSessions, InteractiveSessionControl, LaunchToolSelection, Session, SessionOpen,
		agent_snapshot, apply_launch_tool_selection, canonical_project, ensure_state_directory,
		extension_regime_control_factory, interrupted_reasoning_dialect, model_context_window,
		model_selector_is_selectable, model_usable_context_window, now_ms, open_session,
		resolve_model_provider, resolve_model_selector, resume_choices, session_blueprint,
		strict_session_id, thinking_effort,
	},
	collab::session::{self, CollabSessionAuthority},
	discovery::{context, roles, runtime},
	hub as hub_backend,
	memory::{InferenceExtractionLane, RuntimePromptMemorySource},
	model_controls::{ProductionProviderApplicationOwner, ProviderControlAuthorityFactory},
	modes::RegimeHandle,
	plan::ModelSelection,
	power::PowerActivity,
	prompt_head::ProductionPromptHead,
	prompt_prep::{PromptSnapshot, settings::PromptSettings},
	rulebook::PromptControlOwner,
	secrets::session::{SecretSessionError, SecretSessionSnapshot},
	session_state::TerminalBreadcrumbs,
	session_title::SessionTitleState,
	stats_api::{
		job_authority::{
			AgentDurableJobRegistrar, ControlPromptProjectionDispatcher, JobAuthority,
			JobAuthorityIdentity,
		},
		telemetry_backend::TelemetryIndexQuery,
	},
	task::prompt_policy,
};
use omp_envd::exthost::{
	JobsControlAuthority, TelemetryControlAuthority, UiControlAuthority,
	backends::EnvdHostOwnerBackends,
	control::{
		ControlAuthority, ControlAuthorityFactory, ControlConnectionIdentity, ControlEffect,
		ControlProtocolError, ControlRequestContext, canonical_session_create,
	},
	dispatch::CallbackDispatcher,
};
use omp_inference::{Registry as InferenceRegistry, layer::stack::BuiltinConfig};
use omp_proto::{
	inference::v1 as inference_pb,
	thread::v1::{item, part},
	toolhost::v1::HookEventId,
};
use omp_sdk::SessionBlueprint;
use omp_settings::manager::{MutationScope, SettingsManager, SettingsManagerError, SettingsPaths};
use omp_storage::{
	blob,
	blob::BlobStore,
	gc,
	gc::ArtifactCatalog,
	index,
	index::SessionIndex,
	telemetry_index::TelemetryIndex,
	transcript::{
		ForeignFormat, Header as JournalHeader, SessionId, import_foreign_session,
		list_foreign_sessions,
	},
};
use omp_tools::eval::EvalSessionControl;
use parking_lot::Mutex;
use tokio::time;
use tokio_util::sync::CancellationToken;
use tonic::transport;
use tracing::Instrument as _;

use crate::{
	chat_ui::{
		self, ChatUiSession,
		presentation::{
			ControlPresentationCallbackDispatcher, PresentationBridge, PublishedUiRoster,
		},
		presentation_authority::{PresentationAuthority, PresentationIdentity},
	},
	cli::ChatArgs,
	pickers::{pick_session, run_list},
	session_manager::{DraftError, DraftStore},
	wizard,
};

macro_rules! session_observe_event {
	($name:ident, $event:ident) => {
		struct $name(serde_json::Value);

		impl HookEvent for $name {
			type Return = ();

			const ID: HookEventId = HookEventId::$event;
			const REV: u32 = 1;

			fn encode_into(&self, out: &mut BytesMut) {
				if let Ok(encoded) = serde_json::to_vec(&self.0) {
					out.extend_from_slice(&encoded);
				}
			}

			fn apply(&mut self, _: &HookPatch) -> Result<(), GateError> {
				Ok(())
			}
		}
	};
}

session_observe_event!(SessionStartHook, HookEventSessionStart);
session_observe_event!(SessionShutdownHook, HookEventSessionShutdown);
session_observe_event!(SessionSwitchedHook, HookEventSessionSwitched);
session_observe_event!(SessionBranchedHook, HookEventSessionBranched);
session_observe_event!(SessionResetHook, HookEventSessionReset);

async fn gate_session_payload(
	gate: &omp_agent::HookGate,
	event: HookEventId,
	name: &'static str,
	payload: serde_json::Value,
) -> Result<serde_json::Value, Str> {
	let requested = serde_json::to_vec(&payload)
		.map(Bytes::from)
		.map_err(|error| sf!("could not encode {name} hook payload: {error}"))?;
	match gate
		.gate(event, GateEvent::new(Str::new_static(name), requested))
		.await
	{
		GateOutcome::Allow { event, .. } => serde_json::from_slice(&event.effective_args)
			.map_err(|error| sf!("could not decode effective {name} hook payload: {error}")),
		GateOutcome::Deny { reason, .. } => Err(reason),
		GateOutcome::Approval { .. } => Err(sf!("{name} hook requested unsupported approval")),
	}
}

/// Runs the session-switch admission chain without constructing a payload
/// when no extension subscribes.
pub(crate) async fn gate_session_switch(
	gate: &omp_agent::HookGate,
	reason: &'static str,
	from_session: Option<&str>,
	to_session: Option<&str>,
	target_cwd: Option<&Path>,
) -> Result<(), Str> {
	if !gate.subscribed(HookEventId::HookEventSessionSwitch) {
		return Ok(());
	}
	gate_session_payload(
		gate,
		HookEventId::HookEventSessionSwitch,
		"session_switch",
		serde_json::json!({
			"reason": reason,
			"from_session": from_session,
			"to_session": to_session,
			"target_cwd": target_cwd.map(|path| path.to_string_lossy()),
		}),
	)
	.await
	.map(|_| ())
}

/// Runs session-branch admission and returns the composed `summarize` value.
pub(crate) async fn gate_session_branch(
	gate: &omp_agent::HookGate,
	at_event: u64,
	keep_event: Option<u64>,
	summarize: bool,
) -> Result<bool, Str> {
	if !gate.subscribed(HookEventId::HookEventSessionBranch) {
		return Ok(summarize);
	}
	let effective = gate_session_payload(
		gate,
		HookEventId::HookEventSessionBranch,
		"session_branch",
		serde_json::json!({
			"at_event": at_event,
			"keep_event": keep_event,
			"reason": "user",
			"summarize": summarize,
		}),
	)
	.await?;
	effective
		.get("summarize")
		.and_then(serde_json::Value::as_bool)
		.ok_or_else(|| sf!("session_branch hook removed summarize"))
}

/// Runs the fail-closed rewind admission chain before the journal is changed.
pub(crate) async fn gate_session_rewind(
	gate: &omp_agent::HookGate,
	to_event: Option<u64>,
	targets: &[omp_agent::RewindTarget],
	dropped_items: usize,
) -> Result<bool, Str> {
	if !gate.subscribed(HookEventId::HookEventSessionRewind) {
		return Ok(false);
	}
	let effective = gate_session_payload(
		gate,
		HookEventId::HookEventSessionRewind,
		"session_rewind",
		serde_json::json!({
			"to_event": to_event,
			"restore_workspace": false,
			"targets": targets.iter().map(|target| serde_json::json!({
				"event_index": target.event,
				"keep_event": target.keep,
				"text": target.text,
			})).collect::<Vec<_>>(),
			"dropped_items": dropped_items,
		}),
	)
	.await?;
	effective
		.get("restore_workspace")
		.and_then(serde_json::Value::as_bool)
		.ok_or_else(|| sf!("session_rewind hook removed restore_workspace"))
}

/// Emits one real session-start transition to extensions already active in
/// the project host.
pub(crate) fn notify_session_start(
	gate: &omp_agent::HookGate,
	session_id: &str,
	root: &Path,
	cwd: &Path,
	dirs: &[PathBuf],
	resumed: bool,
	head_event: u64,
	previous_session: Option<&str>,
) {
	if gate.subscribed(SessionStartHook::ID) {
		// No Rust authority currently projects the prompt revision, extension
		// trust tier, or durable session origin at this seam. Required fields
		// therefore carry their schema zero values; optional origin/agent facts
		// remain absent rather than using a fabricated proxy.
		gate.notify(&SessionStartHook(serde_json::json!({
			"session_id": session_id,
			"root": root.to_string_lossy(),
			"cwd": cwd.to_string_lossy(),
			"dirs": dirs.iter().map(|path| path.to_string_lossy()).collect::<Vec<_>>(),
			"resumed": resumed,
			"trust": "sandboxed",
			"head_event": head_event,
			"prompt_rev": "",
			"previous_session": previous_session,
		})));
	}
}

/// Emits the bounded session-shutdown observation.
pub(crate) fn notify_session_shutdown(
	gate: &omp_agent::HookGate,
	session_id: &str,
	reason: &'static str,
	target_session: Option<&str>,
) {
	if gate.subscribed(SessionShutdownHook::ID) {
		gate.notify(&SessionShutdownHook(serde_json::json!({
			"session_id": session_id,
			"reason": reason,
			"budget": "2s",
			"target_session": target_session,
		})));
	}
}

/// Emits one post-commit session-switched observation.
pub(crate) fn notify_session_switched(
	gate: &omp_agent::HookGate,
	reason: &'static str,
	from_session: Option<&str>,
	to_session: &str,
	head_event: u64,
) {
	if gate.subscribed(SessionSwitchedHook::ID) {
		gate.notify(&SessionSwitchedHook(serde_json::json!({
			"reason": reason,
			"from_session": from_session,
			"to_session": to_session,
			"head_event": head_event,
		})));
	}
}

/// Emits one post-commit session-branched observation.
pub(crate) fn notify_session_branched(
	gate: &omp_agent::HookGate,
	at_event: u64,
	new_head: u64,
	summary_event: Option<u64>,
) {
	if gate.subscribed(SessionBranchedHook::ID) {
		gate.notify(&SessionBranchedHook(serde_json::json!({
			"at_event": at_event,
			"new_head": new_head,
			"summary_event": summary_event,
		})));
	}
}

/// Emits one post-commit session-reset observation.
pub(crate) fn notify_session_reset(gate: &omp_agent::HookGate, at_event: u64, kept_events: u64) {
	if gate.subscribed(SessionResetHook::ID) {
		gate.notify(&SessionResetHook(serde_json::json!({
			"at_event": at_event,
			"kept_events": kept_events,
		})));
	}
}

fn absolute_invocation_deadline(now: Instant, max_time: Option<Duration>) -> Option<Instant> {
	max_time.and_then(|duration| now.checked_add(duration))
}

/// Complete app-owned CONTROL factory bundle for one production chat session.
///
/// Keeping every field required makes it impossible for a session entry point
/// to accidentally activate an extension host with a silently absent domain.
#[doc(hidden)]
pub struct SessionControlFactories {
	/// Policy mutation and approval decisions.
	pub policy:            Arc<dyn ControlAuthorityFactory>,
	/// Invocation parameter cursors.
	pub parameters:        Arc<dyn ControlAuthorityFactory>,
	/// Named worker placement and process ownership.
	pub workers:           Arc<dyn ControlAuthorityFactory>,
	/// Audited trusted direct-filesystem operations.
	pub direct_filesystem: Arc<dyn ControlAuthorityFactory>,
	/// Credential and secret resolution.
	pub credentials:       Arc<dyn ControlAuthorityFactory>,
	/// Typed prompt-head invalidation.
	pub prompts:           Arc<dyn ControlAuthorityFactory>,
	/// Atomic interactive session create/seed/switch ownership.
	pub sessions:          Arc<dyn ControlAuthorityFactory>,
	/// Interactive presentation composition.
	pub ui:                Arc<dyn ControlAuthorityFactory>,
	/// Durable telemetry query and export.
	pub telemetry:         Arc<dyn ControlAuthorityFactory>,
	/// Prompt projection and durable job registration.
	pub jobs:              Arc<dyn ControlAuthorityFactory>,
	/// Inference provider declaration and request ownership.
	pub provider:          Arc<dyn ControlAuthorityFactory>,
	/// Session and turn regime ownership.
	pub regimes:           Arc<dyn ControlAuthorityFactory>,
}

impl SessionControlFactories {
	/// Atomically replaces agents and every app-owned domain under one lease.
	#[must_use]
	pub fn bind(
		self,
		environment: &omp_envd::ProjectEnvironment,
		agents: Arc<dyn ControlAuthorityFactory>,
	) -> omp_envd::exthost::ExternalControlAuthorityBinding {
		environment.bind_external_control_authorities(
			agents,
			omp_envd::exthost::ExternalDomainControlFactories {
				policy:            Some(self.policy),
				parameters:        Some(self.parameters),
				workers:           Some(self.workers),
				direct_filesystem: Some(self.direct_filesystem),
				credentials:       Some(self.credentials),
				prompts:           Some(self.prompts),
				sessions:          Some(self.sessions),
				ui:                Some(self.ui),
				telemetry:         Some(self.telemetry),
				jobs:              Some(self.jobs),
				provider:          Some(self.provider),
				regimes:           Some(self.regimes),
				services:          None,
			},
		)
	}
}

fn session_control_factory(
	root: PathBuf,
	sessions_dir: PathBuf,
	index: Arc<SessionIndex>,
	agent: AgentHostControl,
	bridge: Arc<PresentationBridge>,
	session_control: Arc<InteractiveSessionControl>,
) -> Arc<dyn ControlAuthorityFactory> {
	let transitioning = Arc::new(AtomicBool::new(false));
	Arc::new(move |identity: Arc<ControlConnectionIdentity>| {
		Ok(Arc::new(SessionCreateAuthority {
			identity,
			root: root.clone(),
			sessions_dir: sessions_dir.clone(),
			index: Arc::clone(&index),
			agent: agent.clone(),
			bridge: Arc::clone(&bridge),
			transitioning: Arc::clone(&transitioning),
			session_control: Arc::clone(&session_control),
		}) as Arc<dyn ControlAuthority>)
	})
}

struct SessionCreateAuthority {
	identity:        Arc<ControlConnectionIdentity>,
	root:            PathBuf,
	sessions_dir:    PathBuf,
	index:           Arc<SessionIndex>,
	agent:           AgentHostControl,
	bridge:          Arc<PresentationBridge>,
	transitioning:   Arc<AtomicBool>,
	session_control: Arc<InteractiveSessionControl>,
}

#[async_trait::async_trait]
impl ControlAuthority for SessionCreateAuthority {
	fn handles(&self, operation: &str) -> bool {
		operation == "omp.sessions.create"
	}

	fn authorize(
		&self,
		context: &ControlRequestContext,
		_operation: &str,
		arguments: &serde_json::Map<String, serde_json::Value>,
	) -> Result<(), ControlProtocolError> {
		if self.identity.extension != context.connection.extension
			|| self.identity.host_generation != context.connection.host_generation
			|| self.identity.session_generation != context.connection.session_generation
		{
			return Err(ControlProtocolError::new(
				"StaleGeneration",
				"session creation authority belongs to a replaced connection",
			));
		}
		if self.transitioning.load(Ordering::Acquire) {
			return Err(ControlProtocolError::new(
				"SessionTransitionDenied",
				"interactive UI is already transitioning sessions",
			));
		}
		let _ = arguments;
		Ok(())
	}

	async fn request(
		&self,
		context: ControlRequestContext,
		_operation: Str,
		arguments: serde_json::Map<String, serde_json::Value>,
	) -> Result<serde_json::Value, ControlProtocolError> {
		let request = canonical_session_create(&context, &arguments)?;
		if self
			.transitioning
			.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
			.is_err()
		{
			return Err(ControlProtocolError::new(
				"SessionTransitionDenied",
				"interactive UI is already transitioning sessions",
			));
		}
		let idempotency_key = request.idempotency_key.clone();
		let mut declaration_arguments = serde_json::Map::new();
		declaration_arguments.insert(
			String::from("extension"),
			serde_json::Value::String(self.identity.extension.to_string()),
		);
		let rows = self
			.agent
			.request("omp.journal.entry_kinds", declaration_arguments)
			.await
			.map_err(|_| {
				ControlProtocolError::new(
					"SessionTransitionDenied",
					"live entry-kind registry is unavailable",
				)
			})?;
		let declarations = session_entry_declarations(rows)?;
		for entry in &request.entries {
			if !declarations.iter().any(|declaration| {
				declaration.name == entry.kind
					&& declaration.rev.to_string().as_str() == entry.rev.as_str()
			}) {
				return Err(ControlProtocolError::new(
					"SessionTransitionDenied",
					"session seed is not owned by a live @omp.entry_kind declaration",
				));
			}
		}
		let digest = self
			.identity
			.artifact_digest
			.parse::<ArtifactDigest>()
			.map_err(|_| {
				ControlProtocolError::new(
					"SessionTransitionDenied",
					"authenticated artifact digest is invalid",
				)
			})?;
		let author = JournalAuthor {
			principal:  self.identity.principal.clone(),
			provenance: Provenance::new(
				self.identity.extension.clone(),
				self.identity.extension.clone(),
				Str::new_static("runtime"),
				digest,
				self.identity.layer.clone(),
				self.identity.tier.clone(),
				self.identity.host_generation,
			),
		};
		let root = self.root.clone();
		let sessions_dir = self.sessions_dir.clone();
		let index = Arc::clone(&self.index);
		let extension = self.identity.extension.clone();
		let result = tokio::task::spawn_blocking(move || {
			omp_driver::chat::create_seeded_session(
				&root,
				&sessions_dir,
				index,
				extension.as_str(),
				declarations,
				author,
				request,
			)
		})
		.await
		.map_err(|_| {
			ControlProtocolError::new(
				"SessionTransitionIndeterminate",
				"session creation owner stopped after dispatch",
			)
			.with_details(serde_json::json!({"idempotency_key": idempotency_key}))
		})?
		.map_err(|error| session_create_error(error, &idempotency_key))?;
		self
			.session_control
			.admit(result.id.0.clone(), self.identity.as_ref());
		self
			.bridge
			.transition(result.id.0.clone())
			.await
			.map_err(|_| {
				ControlProtocolError::new(
					"SessionTransitionIndeterminate",
					"session is durable but the interactive switch acknowledgement was lost",
				)
				.with_details(serde_json::json!({"idempotency_key": idempotency_key}))
			})?;
		Ok(session_info_value(&result))
	}

	async fn effect(
		&self,
		_context: ControlRequestContext,
		_effect: ControlEffect,
	) -> Result<(), ControlProtocolError> {
		Err(ControlProtocolError::new(
			"InvalidEffect",
			"session creation authority accepts requests only",
		))
	}
}

fn session_entry_declarations(
	value: serde_json::Value,
) -> Result<Vec<omp_agent::EntryKindDecl>, ControlProtocolError> {
	let rows = value.as_array().ok_or_else(|| {
		ControlProtocolError::new("SessionTransitionDenied", "entry-kind registry is malformed")
	})?;
	rows
		.iter()
		.map(|row| {
			let row = row.as_object().ok_or_else(|| {
				ControlProtocolError::new(
					"SessionTransitionDenied",
					"entry-kind declaration is malformed",
				)
			})?;
			omp_agent::EntryKindDecl::parse(
				Str::new(
					row.get("name")
						.and_then(serde_json::Value::as_str)
						.unwrap_or_default(),
				),
				row.get("rev")
					.and_then(serde_json::Value::as_str)
					.unwrap_or_default(),
				row.get("display")
					.and_then(serde_json::Value::as_bool)
					.unwrap_or(false),
				row.get("projects")
					.and_then(serde_json::Value::as_bool)
					.unwrap_or(false),
				None,
			)
			.map_err(|_| {
				ControlProtocolError::new(
					"SessionTransitionDenied",
					"entry-kind declaration revision is invalid",
				)
			})
		})
		.collect()
}

fn session_create_error(
	error: omp_driver::chat::SeededSessionError,
	idempotency_key: &Str,
) -> ControlProtocolError {
	match error {
		omp_driver::chat::SeededSessionError::Indeterminate { session_id, .. } => {
			ControlProtocolError::new(
				"SessionTransitionIndeterminate",
				"session durability acknowledgement is indeterminate",
			)
			.with_details(serde_json::json!({
				"idempotency_key": idempotency_key,
				"session_id": session_id.0,
			}))
		},
		omp_driver::chat::SeededSessionError::InaccessibleParent => ControlProtocolError::new(
			"SessionTransitionDenied",
			"requested session parent is not accessible",
		),
		omp_driver::chat::SeededSessionError::Journal(_)
		| omp_driver::chat::SeededSessionError::Io(_)
		| omp_driver::chat::SeededSessionError::Index(_)
		| omp_driver::chat::SeededSessionError::MissingIndexRow => ControlProtocolError::new(
			"SessionTransitionDenied",
			"session creation failed before an acknowledged transition",
		),
	}
}

fn session_info_value(info: &index::SessionInfo) -> serde_json::Value {
	serde_json::json!({
		"id": info.id.0.as_str(),
		"title": info.title,
		"title_source": info.title_source.map_or_else(|| "system".to_owned(), |source| source.to_string()),
		"cwd": info.cwd,
		"project": info.project,
		"created_ms": info.created_ms,
		"updated_ms": info.updated_ms,
		"status": info.status.to_string(),
		"kind": info.kind.to_string(),
		"parent": info.parent.as_ref().map(|parent| parent.0.as_str()),
		"entries": info.entries,
		"turns": info.turns,
		"usage": {
			"input": info.usage.input_tokens,
			"output": info.usage.output_tokens,
			"cache_read": info.usage.cache_read_tokens,
			"cache_write": info.usage.cache_write_tokens,
			"reasoning": info.usage.reasoning_tokens.unwrap_or(0),
			"premium_requests": info.usage.premium_requests.unwrap_or(0),
			"context": info.usage.context_tokens,
			"total": info.usage.total_tokens.unwrap_or_else(|| info.usage.input_tokens
				.saturating_add(info.usage.output_tokens)
				.saturating_add(info.usage.cache_read_tokens)
				.saturating_add(info.usage.cache_write_tokens)),
			"accuracy": match inference_pb::usage::Accuracy::try_from(info.usage.accuracy) {
				Ok(inference_pb::usage::Accuracy::Estimated) => "estimated",
				Ok(inference_pb::usage::Accuracy::Mixed) => "mixed",
				_ => "exact",
			},
			"detail": {},
		},
		"cost": {
			"nanos_usd": info.cost.nanos_usd,
			"estimated": info.cost.estimated,
			"input_nanos_usd": info.cost.input_nanos_usd,
			"output_nanos_usd": info.cost.output_nanos_usd,
		},
		"models": info.models,
		"remote": info.remote,
	})
}

fn presentation_control_factory(
	bridge: Arc<PresentationBridge>,
	dispatcher: Arc<dyn CallbackDispatcher>,
) -> Arc<dyn ControlAuthorityFactory> {
	Arc::new(move |identity: Arc<ControlConnectionIdentity>| {
		let presentation_identity = Arc::new(PresentationIdentity {
			principal:          Str::new(identity.principal.id()),
			extension:          identity.extension.clone(),
			artifact_digest:    identity.artifact_digest.clone(),
			host_generation:    identity.host_generation,
			session_generation: identity.session_generation,
			capabilities:       identity.capabilities.clone(),
		});
		let callbacks = Arc::new(ControlPresentationCallbackDispatcher::new(
			Arc::clone(&identity),
			Arc::clone(&dispatcher),
		));
		let owner =
			Arc::new(PresentationAuthority::new(presentation_identity, bridge.clone(), callbacks));
		Ok(Arc::new(UiControlAuthority::new(identity, owner)) as Arc<dyn ControlAuthority>)
	})
}

fn telemetry_control_factory(
	query: Arc<dyn omp_observability::authority::DurableTelemetryQuery>,
) -> Arc<dyn ControlAuthorityFactory> {
	Arc::new(move |identity: Arc<ControlConnectionIdentity>| {
		Ok(Arc::new(TelemetryControlAuthority::new(identity, now_ms(), Arc::clone(&query)))
			as Arc<dyn ControlAuthority>)
	})
}

fn prompt_control_factory(
	head: Arc<dyn omp_driver::rulebook::PromptHeadAuthority>,
) -> Arc<dyn ControlAuthorityFactory> {
	Arc::new(move |identity: Arc<ControlConnectionIdentity>| {
		Ok(Arc::new(PromptControlOwner::new(identity, Arc::clone(&head)))
			as Arc<dyn ControlAuthority>)
	})
}

fn job_control_factory(
	session: Str,
	jobs: omp_agent::JobBoard,
	control: omp_agent::AgentHostControl,
	dispatcher: Arc<dyn CallbackDispatcher>,
) -> Arc<dyn ControlAuthorityFactory> {
	Arc::new(move |identity: Arc<ControlConnectionIdentity>| {
		let job_identity = Arc::new(JobAuthorityIdentity {
			principal:          Str::new(identity.principal.id()),
			extension:          identity.extension.clone(),
			artifact_digest:    identity.artifact_digest.clone(),
			host_generation:    identity.host_generation,
			session_generation: identity.session_generation,
			session:            session.clone(),
			capabilities:       identity.capabilities.clone(),
		});
		let registrar = Arc::new(AgentDurableJobRegistrar::new(control.clone()));
		let projection = Arc::new(ControlPromptProjectionDispatcher::new(
			Arc::clone(&identity),
			Arc::clone(&dispatcher),
		));
		let owner = Arc::new(JobAuthority::new(job_identity, jobs.clone(), registrar, projection));
		Ok(Arc::new(JobsControlAuthority::new(identity, owner)) as Arc<dyn ControlAuthority>)
	})
}

fn provider_control_factory(
	registry: omp_inference::Registry,
	builtins: BuiltinConfig,
	blobs: BlobStore,
) -> Arc<dyn ControlAuthorityFactory> {
	let owner = Arc::new(ProductionProviderApplicationOwner::new(registry, builtins, blobs));
	let backend = Arc::new(ChatProviderControlBackend::new(owner));
	Arc::new(ProviderControlAuthorityFactory::new(backend))
}

fn replace_model_props(mut props: omp_scribe::Props, model: &str) -> omp_scribe::Props {
	let mut fields = match props.get(omp_agent::prompt_keys::MODEL) {
		Some(omp_scribe::Value::Map(fields)) => fields.clone(),
		_ => iter::empty::<(Str, omp_scribe::Value)>().collect(),
	};
	fields.insert(Str::new_static("identifier"), omp_scribe::Value::from(Str::new(model)));
	fields.insert(
		Str::new_static("codex_task_policy"),
		omp_scribe::Value::from(prompt_policy::uses_codex_task_prompt(model)),
	);
	props.set(omp_agent::prompt_keys::MODEL, omp_scribe::Value::Map(fields));
	props
}
/// Failures owned by the interactive presentation boundary.
#[derive(Debug, thiserror::Error)]
enum ChatError {
	/// Live agent composition failed.
	#[error(transparent)]
	Agent(#[from] omp_agent::Error),
	/// Driver-owned durable session composition failed.
	#[error(transparent)]
	Driver(#[from] DriverChatError),
	/// Owner-local draft persistence failed.
	#[error(transparent)]
	Draft(#[from] DraftError),
	/// Session-local secret transformation failed.
	#[error(transparent)]
	Secrets(#[from] SecretSessionError),
	/// Typed settings projection failed.
	#[error(transparent)]
	Settings(#[from] SettingsManagerError),
	/// Owner-local session discovery failed.
	#[error(transparent)]
	SessionResolve(#[from] omp_driver::session_state::SessionResolveError),
	/// Process-global parked session discovery failed.
	#[error(transparent)]
	AgentRegistry(#[from] omp_agent::RegistryError),
	/// Session artifact metadata failed.
	#[error(transparent)]
	Artifact(#[from] gc::Error),
	/// Session blob storage failed.
	#[error(transparent)]
	Blob(#[from] blob::Error),
	/// Durable session telemetry index failed.
	#[error(transparent)]
	Telemetry(#[from] omp_storage::telemetry_index::QueryError),
	/// Regime lifecycle mutation failed.
	#[error(transparent)]
	Regime(#[from] omp_agent::AgentError),
	/// Environment authority binding failed.
	#[error(transparent)]
	Environment(#[from] omp_envd::EnvdError),
	/// Durable transcript journal access failed.
	#[error(transparent)]
	Journal(#[from] omp_agent::JournalError),
	/// A production session entry omitted a required CONTROL owner.
	#[error("required production CONTROL authority `{0}` was not composed")]
	MissingAuthority(&'static str),
	/// Session index mutation failed.
	#[error(transparent)]
	SessionIndex(#[from] index::Error),
	/// Extension UI roster publication conflicted with a live generation.
	#[error(transparent)]
	UiRoster(#[from] omp_envd::exthost::UiRosterConflict),
	/// Interactive terminal or GUI host failed.
	#[error("interactive chat shell failed: {0}")]
	Ui(miette::Report),
}

/// Initial surface selected by the command boundary.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ChatStart {
	/// Open the inline transcript and composer immediately.
	Session,
	/// Open the alternate-screen session index before the transcript.
	SessionIndex,
}
/// Presentation selected for the interactive project-chat session.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ChatPresentation {
	/// Render through the inline terminal host.
	Terminal,
	/// Render through the native GPU window host.
	#[cfg(feature = "gui")]
	Gui,
}
fn shell_argument(value: &str) -> String {
	if !value.is_empty()
		&& value
			.bytes()
			.all(|byte| byte.is_ascii_alphanumeric() || b"_@%+=:,./-".contains(&byte))
	{
		return value.to_owned();
	}
	let mut quoted = String::with_capacity(value.len() + 2);
	quoted.push('\'');
	for (index, fragment) in value.split('\'').enumerate() {
		if index > 0 {
			quoted.push_str("'\"'\"'");
		}
		quoted.push_str(fragment);
	}
	quoted.push('\'');
	quoted
}

fn resume_command(profile: Option<&str>, session_id: &str) -> String {
	let mut command = String::from("omp");
	if let Some(profile) = profile {
		if profile.starts_with('-') {
			command.push_str(" --profile=");
		} else {
			command.push_str(" --profile ");
		}
		command.push_str(&shell_argument(profile));
	}
	if session_id.starts_with('-') {
		command.push_str(" --resume=");
	} else {
		command.push_str(" --resume ");
	}
	command.push_str(&shell_argument(session_id));
	command
}

fn exit_before_ui_for_timing() -> bool {
	if omp_observability::logging::timing_mode() != omp_observability::logging::TimingMode::Exit {
		return false;
	}
	eprintln!("OMP_TIMING startup complete; exiting before UI");
	true
}

#[cfg(test)]
mod resume_hint_tests {
	use super::*;

	#[test]
	fn resume_hint_omits_the_default_profile() {
		assert_eq!(resume_command(None, "abc123"), "omp --resume abc123");
	}

	#[test]
	fn resume_hint_includes_a_named_profile() {
		assert_eq!(
			resume_command(Some("personal"), "abc123"),
			"omp --profile personal --resume abc123"
		);
	}

	#[test]
	fn resume_hint_quotes_shell_metacharacters() {
		assert_eq!(
			resume_command(Some("team's profile"), "session;rm"),
			"omp --profile 'team'\"'\"'s profile' --resume 'session;rm'"
		);
		assert_eq!(
			resume_command(Some("-isolated"), "abc123"),
			"omp --profile=-isolated --resume abc123"
		);
	}
}

/// Runs one interactive durable project-chat session.
#[cfg(any(unix, windows))]
#[expect(
	clippy::future_not_send,
	reason = "the interactive chat future owns a thread-confined terminal scene"
)]
pub(crate) async fn run(
	args: ChatArgs,
	mut start: ChatStart,
	presentation: ChatPresentation,
) -> miette::Result<()> {
	use miette::{Context as _, IntoDiagnostic as _};
	let launch_root = canonical_project(&args.project).map_err(|e| miette::miette!(e))?;
	let data_dir = omp_core::dirs::data_dir(None).into_diagnostic()?;
	let mut root = launch_root.clone();
	let mut selected_sessions_dir = None;
	let mut selected_index_path = None;
	let mut picked_resume = None;
	let mut resume_moved = false;
	if start == ChatStart::SessionIndex {
		let Some(selection) = pick_session(&data_dir, args.session_dir.as_deref())
			.await
			.map_err(|error| miette::miette!(error))?
		else {
			return Ok(());
		};
		picked_resume = Some(selection.session.id.0.clone());
		selected_sessions_dir = Some(selection.sessions_dir);
		selected_index_path = Some(selection.database_path);
		start = ChatStart::Session;
		let recorded_root = PathBuf::from(selection.session.project.as_str());
		if recorded_root.is_dir() {
			root = canonical_project(&recorded_root).map_err(|error| miette::miette!(error))?;
		} else {
			let choices = [
				omp_chat_ui::ListRow {
					key:    sf!("move"),
					label:  sf!("Move session"),
					detail: Str::from(launch_root.to_string_lossy().as_ref()),
				},
				omp_chat_ui::ListRow {
					key:    sf!("cancel"),
					label:  sf!("Cancel"),
					detail: sf!("Keep the journal unchanged"),
				},
			];
			if run_list("Project missing", &choices)
				.await
				.map_err(|error| miette::miette!(error))?
				!= Some(0)
			{
				return Ok(());
			}
			resume_moved = true;
			eprintln!(
				"Session project `{}` no longer exists; moving future workspace access to `{}`.",
				recorded_root.display(),
				launch_root.display()
			);
			tracing::info!(
				session_id = %selection.session.id.0,
				recorded_root = %recorded_root.display(),
				launch_root = %launch_root.display(),
				"session workspace root moved"
			);
		}
	}
	if args.from_claude || args.from_codex {
		let format = if args.from_claude {
			ForeignFormat::ClaudeCode
		} else {
			ForeignFormat::Codex
		};
		let source_label = if args.from_claude {
			"Claude Code"
		} else {
			"Codex"
		};
		let sessions = list_foreign_sessions(format);
		if sessions.is_empty() {
			return Err(miette::miette!("no importable {source_label} sessions were found"));
		}
		let rows: Vec<omp_chat_ui::ListRow> = sessions
			.iter()
			.map(|info| omp_chat_ui::ListRow {
				key:    info.id.clone(),
				label:  info.title.clone().unwrap_or_else(|| info.id.clone()),
				detail: info.cwd.as_ref().map_or_else(
					|| Str::from(info.path.to_string_lossy().as_ref()),
					|cwd| Str::from(cwd.to_string_lossy().as_ref()),
				),
			})
			.collect();
		let title = format!("Import {source_label} session");
		let Some(selected) = run_list(&title, &rows)
			.await
			.map_err(|error| miette::miette!(error))?
		else {
			return Ok(());
		};
		let info = &sessions[selected];
		if let Some(cwd) = info.cwd.as_ref().filter(|cwd| cwd.is_dir()) {
			root = canonical_project(cwd).map_err(|error| miette::miette!(error))?;
		}
		let import_state_dir = omp_env::project_state::directory(&data_dir, &root)
			.map_err(|error| miette::miette!(error))?;
		let import_sessions_dir = import_state_dir.join("sessions");
		ensure_state_directory(&import_sessions_dir).map_err(|error| miette::miette!(error))?;
		let imported_id = Str::from(omp_core::Ulid::generate().to_string());
		let destination = import_sessions_dir.join(format!("{imported_id}.jsonl"));
		let header = JournalHeader {
			v:       4,
			id:      SessionId(imported_id.clone()),
			created: now_ms(),
			cwd:     root.clone(),
		};
		let report = import_foreign_session(info, &destination, header)
			.map_err(|error| miette::miette!(error))?;
		for diagnostic in report.transcript.diagnostics.iter().take(5) {
			eprintln!(
				"Import warning at {source_label} line {}: {}",
				diagnostic.line, diagnostic.reason
			);
			tracing::warn!(
				source = source_label,
				line = diagnostic.line,
				"foreign session import diagnostic"
			);
		}
		eprintln!(
			"Imported {source_label} session {} as {imported_id} ({} events).",
			info.id, report.event_count
		);
		tracing::info!(
			source = source_label,
			session_id = %imported_id,
			event_count = report.event_count,
			diagnostic_count = report.transcript.diagnostics.len(),
			"foreign session imported"
		);
		picked_resume = Some(imported_id);
		selected_sessions_dir = Some(import_sessions_dir);
	}
	let catalog_owner = tracing::debug_span!("catalog_load").in_scope(|| {
		omp_driver::registry::production_catalog(&data_dir).map_err(|error| miette::miette!(error))
	})?;
	let catalog = catalog_owner.as_ref();
	let mut settings_paths = SettingsPaths::discover(&data_dir, Some(&root));
	settings_paths.overlays.extend(args.config.iter().cloned());
	let settings_span = tracing::debug_span!("settings_load");
	let settings_guard = settings_span.enter();
	let settings_manager =
		Arc::new(SettingsManager::open(settings_paths).map_err(|error| miette::miette!(error))?);
	let approval_mode: Option<omp_envd::tool_settings::ApprovalMode> = args
		.effective_approval()
		.map(omp_envd::tool_settings::ApprovalMode::from);
	if let Some(approval_mode) = &approval_mode {
		settings_manager
			.set_sync(MutationScope::Runtime, "tools.approval_mode", &approval_mode.to_string())
			.map_err(|error| miette::miette!(error))?;
	}
	let settings_snapshot = settings_manager.snapshot();
	let mut settings = settings_snapshot
		.project::<omp_driver::settings::Settings>()
		.map_err(|error| miette::miette!(error))?
		.get()
		.clone();
	settings.mnemopi = settings.mnemopi.normalize();
	if let Some(theme) = &args.use_theme {
		settings.appearance.theme = theme.clone();
		settings.appearance.theme_variant = None;
	}
	let workspace_update_overlay: Option<omp_ext::config::UpdateOverlay> =
		fs::read_to_string(root.join(".omp/config.toml"))
			.ok()
			.and_then(|source| toml::from_str::<toml::Value>(&source).ok())
			.and_then(|value| value.get("extensions")?.get("updates").cloned())
			.map(toml::Value::try_into)
			.transpose()
			.map_err(|error| miette::miette!("invalid workspace extension update policy: {error}"))?;
	let extension_update_policy = omp_ext::config::effective_updates(
		settings.extensions.updates.as_ref(),
		workspace_update_overlay.as_ref(),
	)
	.map_err(|error| miette::miette!(error))?;
	let security_enabled = settings.security.enabled;
	let resize_scrollback = match settings.tui.resize_scrollback {
		omp_driver::settings::ResizeScrollbackMode::Append => host::ResizeScrollback::Append,
		omp_driver::settings::ResizeScrollbackMode::Rebuild => host::ResizeScrollback::Rebuild,
		omp_driver::settings::ResizeScrollbackMode::Preserve => host::ResizeScrollback::Preserve,
	};
	let home = env::var_os("HOME").map_or_else(|| root.clone(), PathBuf::from);
	let model_settings = settings_snapshot
		.project::<omp_catalog::settings::ModelSettings>()
		.map_err(|error| miette::miette!(error))?
		.get()
		.resolve_path_scopes(&root, &home);
	let mut skill_settings = settings_snapshot
		.project::<omp_driver::discovery::skills::SkillDiscoverySettings>()
		.map_err(|error| miette::miette!(error))?
		.get()
		.clone();
	if args.no_skills {
		skill_settings.enabled = false;
	}
	skill_settings
		.custom_directories
		.extend(args.skill.iter().cloned());
	let extensions_disabled =
		matches!(args.extension_launch.mode, crate::cli::InvocationExtensionMode::Disabled);
	let extension_scopes = settings
		.extension_scopes(
			omp_driver::settings::workspace_extension_overlay(&root)
				.map_err(|error| miette::miette!("{error}"))?,
		)
		.map_err(|error| miette::miette!("{error}"))?;
	let mut prompt_discovery_settings = omp_driver::discovery::PromptDiscoverySettings {
		model: model_settings.clone(),
		skills: skill_settings.clone(),
		foreign: settings_snapshot
			.project::<omp_driver::discovery::foreign::ForeignContentSettings>()
			.map_err(|error| miette::miette!(error))?
			.get()
			.clone(),
		rules: settings_snapshot
			.project::<omp_driver::rulebook::RulebookSettings>()
			.map_err(|error| miette::miette!(error))?
			.get()
			.clone(),
		native: omp_driver::discovery::native::NativeDiscoveryOptions {
			explicit_roots: if extensions_disabled {
				Vec::new()
			} else {
				args.extension_launch.native_roots.clone()
			},
			root_mode: match args.extension_launch.mode {
				crate::cli::InvocationExtensionMode::Merge => {
					omp_driver::discovery::native::NativeRootMode::Merge
				},
				crate::cli::InvocationExtensionMode::ExplicitOnly
				| crate::cli::InvocationExtensionMode::Disabled => {
					omp_driver::discovery::native::NativeRootMode::ExplicitOnly
				},
			},
			skill_settings,
			prompt_templates: args.prompt_template.clone(),
			themes: args.theme.clone(),
			include_workspace: !args.extension_launch.no_workspace && !extensions_disabled,
			client_installed: Some(data_dir.join("ext/installed.toml")),
			workspace_identity: Some(omp_driver::discovery::workspace_identity(&root)),
		},
		grants: Some(omp_driver::discovery::ExtensionGrantSettings {
			path:    data_dir.join("ext/grants.toml"),
			session: Arc::from([]),
		}),
		extension_scopes,
		extension_overrides: args.extension_launch.settings.clone().into(),
	};
	drop(settings_guard);
	drop(settings_span);
	let mut prompt_discovery = tracing::debug_span!("discovery").in_scope(|| {
		omp_driver::discovery::active_prompt_snapshots(
			&root,
			&args.add_dir,
			&home,
			&prompt_discovery_settings,
		)
	});
	if args.no_prompt_templates {
		prompt_discovery.content.declarations = prompt_discovery
			.content
			.declarations
			.iter()
			.filter(|declaration| {
				!matches!(
					&declaration.payload,
					omp_driver::discovery::manifest::CapabilityPayload::Prompts(_)
				)
			})
			.cloned()
			.collect::<Vec<_>>()
			.into();
	}
	if args.no_context_files {
		prompt_discovery.context = Default::default();
	}
	let extension_admission_span = tracing::debug_span!("extension_admission");
	let mut extension_keys = BTreeSet::new();
	let mut extension_approval_tickets = Vec::new();
	if !prompt_discovery.content.extension_grants.is_empty() {
		let grant_path = data_dir.join("ext/grants.toml");
		let outcome = crate::extension_trust::prompt(
			prompt_discovery.content.extension_grants.as_ref(),
			&grant_path,
		)
		.instrument(extension_admission_span.clone())
		.await?;
		prompt_discovery_settings
			.grants
			.as_mut()
			.expect("interactive discovery installs a grant authority")
			.session = outcome.session_grants.into();
		extension_approval_tickets = outcome.tickets;
		prompt_discovery = tracing::debug_span!("discovery").in_scope(|| {
			omp_driver::discovery::active_prompt_snapshots(
				&root,
				&args.add_dir,
				&home,
				&prompt_discovery_settings,
			)
		});
	}
	let extension_admission_guard = extension_admission_span.enter();
	let mut admitted_extensions = prompt_discovery
		.content
		.extensions
		.iter()
		.chain(args.extension_launch.trusted.iter())
		.map(|extension| {
			if !extension_keys.insert(extension.key.clone()) {
				return Err(miette::miette!("duplicate extension host identity: {:?}", extension.key));
			}
			Ok(extension.clone())
		})
		.collect::<miette::Result<Vec<_>>>()?;
	let mut startup_revoked = BTreeSet::new();
	if let (Ok(key), Ok(revocations)) = (
		fs::read_to_string(data_dir.join("ext/index.key")),
		omp_ext::trust::RevocationsFile::read(&data_dir.join("ext/revocations.json")),
	) && revocations.verify(key.trim()).is_ok()
	{
		for (path, layer) in [
			(data_dir.join("ext/omp.lock"), omp_ext::Layer::Client),
			(root.join(".omp/omp.lock"), omp_ext::Layer::Workspace),
		] {
			let Ok(lock) = omp_ext::lock::LockFile::read(&path, layer) else {
				continue;
			};
			for extension in lock.extensions {
				if revocations
					.revocation_for(&extension.id, &extension.version)
					.is_ok_and(|revocation| revocation.is_some())
				{
					startup_revoked.insert(extension.id);
				}
			}
		}
	}
	if !startup_revoked.is_empty() {
		admitted_extensions.retain(|extension| !startup_revoked.contains(extension.key.extension()));
		for id in startup_revoked {
			eprintln!("SECURITY: revoked extension {id} was not admitted");
			tracing::warn!(extension_id = %id, "revoked extension denied at startup");
		}
	}
	drop(extension_admission_guard);
	drop(extension_admission_span);
	let roles = roles::resolve_launch_roles(
		catalog,
		&model_settings,
		None,
		args.smol.as_deref(),
		args.slow.as_deref(),
		args.plan.as_deref(),
	)
	.map_err(|error| miette::miette!(error))?;
	for selector in args
		.models
		.as_ref()
		.into_iter()
		.flat_map(|selectors| selectors.0.iter())
	{
		resolve_model_selector(catalog, selector).map_err(|error| miette::miette!(error))?;
	}
	for root in &args.add_dir {
		fs::canonicalize(root).into_diagnostic().wrap_err_with(|| {
			format!("additional workspace root `{}` is unavailable", root.display())
		})?;
	}
	let plan_selection = roles
		.plan
		.as_ref()
		.map(|model| ModelSelection::resolved(model.as_str(), roles.plan_thinking.as_deref()))
		.transpose()
		.map_err(|error| miette::miette!(error))?;
	let plan_handoff = if args.plan_yolo {
		match args.plan_yolo_into.as_deref() {
			Some(selector) => {
				let selected = roles::resolve_role_selector(catalog, &model_settings, selector)
					.map_err(|error| miette::miette!(error))?;
				Some(
					ModelSelection::resolved(selected.model.as_str(), selected.thinking.as_deref())
						.map_err(|error| miette::miette!(error))?,
				)
			},
			None => roles
				.smol
				.as_ref()
				.map(|model| ModelSelection::resolved(model.as_str(), None))
				.transpose()
				.map_err(|error| miette::miette!(error))?,
		}
	} else {
		None
	};
	let auto_thinking = settings.auto_thinking;
	let power_mode = settings_snapshot
		.project::<omp_driver::power::PowerSettings>()
		.map_err(|error| miette::miette!(error))?
		.get()
		.sleep_prevention;
	let explicit_model = args.model.clone().or_else(|| {
		roles
			.primary
			.as_ref()
			.map(|model| Str::from(model.as_str()))
	});
	let model = match explicit_model.clone() {
		Some(model) => model,
		None => wizard::run(&data_dir, catalog)
			.await?
			.ok_or_else(|| miette::miette!("no model configured — run `omp` again to finish setup"))?,
	};
	if args.api_key.is_some() && args.model.is_none() && args.models.is_none() {
		return Err(miette::miette!(
			"--api-key requires a model to be specified via --model or --models"
		));
	}
	let state_dir =
		omp_env::project_state::directory(&data_dir, &root).map_err(|e| miette::miette!(e))?;
	ensure_state_directory(&state_dir).map_err(|e| miette::miette!(e))?;
	let ephemeral_sessions = if args.no_session {
		Some(EphemeralSessions::create().map_err(|error| miette::miette!(error))?)
	} else {
		None
	};
	let sessions_dir = if let Some(ephemeral) = &ephemeral_sessions {
		ephemeral.path().to_owned()
	} else if let Some(selected) = selected_sessions_dir {
		selected
	} else if let Some(configured) = args.session_dir.as_deref() {
		ensure_state_directory(configured).map_err(|error| miette::miette!(error))?;
		fs::canonicalize(configured).into_diagnostic()?
	} else {
		state_dir.join("sessions")
	};
	ensure_state_directory(&sessions_dir).map_err(|e| miette::miette!(e))?;
	let requested_resume = picked_resume.or_else(|| args.resume.clone());
	let search_bridge = Arc::new(InferenceBridge::default());
	let goal_control = AgentGoalControl::default();
	let advise_queue = omp_agent::advisor::AdvisorAdviceQueue::default();
	let mut edit_repair_requests = None;
	let edit_repair = if settings.tools.edit_auto_repair {
		let (client, requests) = omp_tools::edit::observer::EditRepairClient::channel();
		edit_repair_requests = Some(requests);
		Some(client)
	} else {
		None
	};
	let bridges = omp_driver::bridges::builtin_with_content(
		&root,
		Arc::clone(&search_bridge),
		goal_control.clone(),
		None,
		advise_queue.clone(),
		&prompt_discovery.content,
	);
	let bridges = omp_envd::RegistryBridges {
		ask_presenter: Some(omp_chat_ui::ask::presenter()),
		edit_model: Some(model.clone()),
		edit_repair,
		// A remote gateway serves search/media itself; leave the host
		// bridge unbound so `bind_remote` can install the gateway client
		// instead of colliding with the pre-seeded local facade.
		search: if args.gateway.is_some() {
			None
		} else {
			bridges.search
		},
		..bridges
	};
	let prompt_head = Arc::new(ProductionPromptHead::from_extension_specs(&admitted_extensions));
	let environment =
		omp_envd::ProjectEnvironment::attach(&root, &state_dir, omp_envd::AttachOptions {
			py_eval: args.py_eval,
			approval_mode,
			trusted_extensions: admitted_extensions.clone(),
			contributed_values: args.extension_launch.contributed.clone(),
			settings: Arc::clone(&settings_snapshot),
			bridges,
			spawn_idle_timeout: args.envd_idle_timeout,
		})
		.instrument(tracing::debug_span!("environment_start"))
		.await
		.map_err(|e| miette::miette!(e))?;
	if let Some(notice) = &environment.fallback_notice {
		eprintln!("{notice}");
		tracing::warn!(
			project_root = %root.display(),
			"project environment started with fallback"
		);
	}
	let evidences = environment.extension_registry_evidences();
	let catalog_owner = Arc::new(tracing::debug_span!("catalog_load").in_scope(|| {
		omp_driver::model_controls::compose_runtime_provider_catalog(
			catalog,
			evidences
				.iter()
				.flat_map(|evidence| evidence.providers.iter()),
		)
		.map_err(|error| miette::miette!(error))
	})?);
	let catalog = catalog_owner.as_ref();
	let model =
		resolve_model_selector(catalog, model.as_str()).map_err(|error| miette::miette!(error))?;
	if !roles::model_selector_allowed(catalog, &model_settings, model.as_str()) {
		return Err(
			miette::miette!("model `{model}` is disabled by effective model settings").into(),
		);
	}
	let credential_provider = args
		.api_key
		.as_ref()
		.map(|_| resolve_model_provider(catalog, model.as_str(), args.provider.as_deref()))
		.transpose()
		.map_err(|error| miette::miette!(error))?;
	prompt_head.bind_provider(environment.extension_prompt_provider());
	let mut resource_roots = Vec::with_capacity(1 + args.add_dir.len() + admitted_extensions.len());
	resource_roots.push(root.clone());
	resource_roots.extend(args.add_dir.iter().cloned());
	resource_roots.extend(admitted_extensions.iter().filter_map(|extension| {
		extension.watch_root.clone().or_else(|| {
			extension
				.entry_path
				.as_ref()?
				.parent()
				.map(Path::to_path_buf)
		})
	}));
	prompt_discovery.content = omp_driver::discovery::gate_resources_discover(
		environment.admission_gate().as_ref(),
		omp_driver::discovery::DiscoverReason::Startup,
		&root,
		&resource_roots,
		&prompt_discovery_settings,
		prompt_discovery.content,
	)
	.instrument(tracing::debug_span!("gate_discovery"))
	.await
	.map_err(|error| miette::miette!(error))?;
	let credential_control_grants =
		omp_driver::secrets::credential_control_grants(&admitted_extensions);
	let session_index = if let Some(database) = selected_index_path {
		Arc::new(
			SessionIndex::open(database)
				.map_err(|error| miette::miette!(DriverChatError::SessionIndex(error)))?,
		)
	} else if args.session_dir.is_some() && !args.no_session {
		Arc::new(
			SessionIndex::open(sessions_dir.join("sessions.sqlite3"))
				.map_err(|error| miette::miette!(DriverChatError::SessionIndex(error)))?,
		)
	} else {
		environment.sessions_index()
	};
	let breadcrumbs = TerminalBreadcrumbs::new(&data_dir).map_err(|error| miette::miette!(error))?;
	let terminal_id = omp_tui::ttyid::terminal_id();
	let resume = if let Some(resume) = requested_resume {
		if strict_session_id(&resume).is_ok() {
			Some(resume)
		} else {
			let root_text = root.to_string_lossy();
			let page = session_index
				.list(&omp_storage::index::SessionFilter {
					project: Some(Str::from(root_text.as_ref())),
					limit: 200,
					..Default::default()
				})
				.map_err(|error| miette::miette!(error))?;
			Some(
				omp_driver::session_state::resolve_session_selector(&page.sessions, resume.as_str())
					.map_err(|error| miette::miette!(error))?
					.0,
			)
		}
	} else if args.continue_session {
		breadcrumbs
			.read(terminal_id.as_str())
			.map_err(|error| miette::miette!(error))?
			.map(|session| session.0)
	} else {
		None
	};
	let fork = if let Some(selector) = args.fork.as_ref() {
		if strict_session_id(selector).is_ok() {
			Some(selector.clone())
		} else {
			let root_text = root.to_string_lossy();
			let page = session_index
				.list(&omp_storage::index::SessionFilter {
					project: Some(Str::from(root_text.as_ref())),
					limit: 200,
					..Default::default()
				})
				.map_err(|error| miette::miette!(error))?;
			Some(
				omp_driver::session_state::resolve_session_selector(&page.sessions, selector.as_str())
					.map_err(|error| miette::miette!(error))?
					.0,
			)
		}
	} else {
		None
	};
	let eval_control = environment.eval_control();

	let registry = environment.registry();
	let session_open = if args.no_session {
		SessionOpen::Ephemeral
	} else if let Some(source) = fork.as_ref() {
		SessionOpen::Fork(source)
	} else if let Some(source) = resume.as_ref() {
		if resume_moved {
			SessionOpen::ResumeMoved(source)
		} else {
			SessionOpen::Resume(source)
		}
	} else {
		SessionOpen::New
	};
	let session_resumed =
		matches!(session_open, SessionOpen::Resume(_) | SessionOpen::ResumeMoved(_));
	let session_open_span = tracing::debug_span!("session_open");
	let mut session = session_open_span
		.in_scope(|| {
			open_session(
				&root,
				&sessions_dir,
				session_open,
				registry.as_ref(),
				(!args.no_session).then(|| Arc::clone(&session_index)),
			)
		})
		.map_err(|e| miette::miette!(e))?;
	for ticket in extension_approval_tickets.drain(..) {
		session
			.journal
			.record_approval_ticket(ticket.created_at_ms, ticket.filed_record())
			.map_err(|error| miette::miette!(error))?;
		if let Some(decision) = ticket.decision_record() {
			session
				.journal
				.record_approval_decision(crate::chat_ui::now_ms(), decision)
				.map_err(|error| miette::miette!(error))?;
		}
	}
	if matches!(session_open, SessionOpen::Resume(_) | SessionOpen::ResumeMoved(_)) {
		let pending_turn = session.journal.pending_turn().is_some();
		let pending_jobs = session.journal.pending_jobs().count();
		if pending_turn || pending_jobs != 0 {
			eprintln!(
				"Warning: resumed session has {} pending tool call(s){}.",
				pending_jobs,
				if pending_turn {
					" and an interrupted turn"
				} else {
					""
				}
			);
			tracing::warn!(
				session_id = %session.id,
				pending_jobs,
				pending_turn,
				"resumed session has pending work"
			);
		}
	}
	let blueprint = session_blueprint(
		model.as_str(),
		catalog,
		&root,
		&args.add_dir,
		&session.id,
		Arc::clone(&registry),
	)
	.map_err(|error| miette::miette!(error))?;
	let mut snapshot = agent_snapshot(&blueprint, catalog, args.external_thinking.then_some(true))
		.map_err(|error| miette::miette!(error))?;
	let mut prompt_facts = blueprint.prompt_facts().clone();
	let prompt_settings = settings_snapshot
		.project::<PromptSettings>()
		.map_err(|error| miette::miette!(error))?
		.get()
		.clone()
		.with_cli(&args.prompt_settings)
		.resolve_inputs(&root, &home)
		.map_err(|error| miette::miette!(error))?;
	prompt_facts.settings = prompt_settings.into();
	prompt_facts.model = omp_agent::ModelPromptInput {
		identifier:        model.clone(),
		codex_task_policy: prompt_policy::uses_codex_task_prompt(model.as_str()),
	};
	if let Some(level) = args.thinking
		&& level != crate::cli::ThinkingLevel::Auto
		&& !args.external_thinking
	{
		let effort = thinking_effort(level.into(), auto_thinking);
		snapshot.turn.params.thinking =
			Some(inference_pb::Reasoning { effort: effort as i32, ..Default::default() });
	}
	if resume.is_some() {
		let path = sessions_dir.join(format!("{}.jsonl", session.id.as_str()));
		let Session { id, journal, initial_items } = session;
		let revived = session_open_span
			.in_scope(|| omp_agent::revive_existing(&path, journal, snapshot))
			.map_err(|error| miette::miette!(error))?;
		session = Session { id, journal: revived.journal, initial_items };
		snapshot = revived.snapshot;
		if let Some(model) = revived.model_override
			&& !model.fallback
		{
			snapshot.turn.params.model = format!("{}/{}", model.model.provider.0, model.model.model.0);
		}
		if !model_selector_is_selectable(catalog, &snapshot.turn.params.model)
			|| !roles::model_selector_allowed(catalog, &model_settings, &snapshot.turn.params.model)
		{
			let saved = snapshot.turn.params.model.clone();
			let fallback = roles::fallback_model_selector(catalog, &model_settings)
				.ok_or_else(|| miette::miette!("no selectable model is available to resume"))?;
			snapshot.turn.params.model = fallback.as_str().to_owned();
			eprintln!(
				"Session model `{saved}` is unavailable; resumed with `{fallback}` without changing \
				 the session pin."
			);
			tracing::warn!(
				session_id = %session.id,
				model = saved,
				fallback_model = %fallback,
				"resumed session model unavailable"
			);
		}
	}
	drop(session_open_span);
	snapshot.compaction = settings.compaction.method_order();
	snapshot.unexpected_stop = settings.interaction.unexpected_stop_detection;
	snapshot.reasoning_dialect = interrupted_reasoning_dialect(catalog, &snapshot.turn.params.model);
	prompt_facts.model.identifier = Str::new(&snapshot.turn.params.model);
	prompt_facts.model.codex_task_policy =
		prompt_policy::uses_codex_task_prompt(&snapshot.turn.params.model);
	let invocation_grant = apply_launch_tool_selection(
		&mut snapshot,
		LaunchToolSelection {
			tools:    args.tools.as_ref().map(|tools| tools.0.as_slice()),
			no_tools: args.no_tools,
			no_lsp:   args.no_lsp,
			no_pty:   args.no_pty,
		},
		registry.as_ref(),
	)
	.map_err(|error| miette::miette!(error))?;
	let env = environment.client().with_invocation_grant(invocation_grant);
	let update_coordinator =
		omp_driver::ext_updates::UpdateCoordinator::new(data_dir.join("ext/update-checks"));
	let update_now_ms = omp_driver::ext_updates::update_now_ms();
	let (update_notifications_tx, update_notifications_rx) = flume::unbounded();
	let client_paths = omp_driver::ext_updates::ClientUpdatePaths::for_data_dir(&data_dir);
	let client_policy = extension_update_policy;
	let _ = omp_driver::ext_updates::schedule_due_update(
		&update_coordinator,
		omp_driver::ext_updates::UpdateScope::Client,
		client_policy,
		update_now_ms,
		update_notifications_tx.clone(),
		move || async move {
			omp_driver::ext_updates::check_client_updates(&client_paths, client_policy, update_now_ms)
				.await
		},
	);
	let workspace_env = env.clone();
	let workspace_policy = extension_update_policy;
	let _ = omp_driver::ext_updates::schedule_due_update(
		&update_coordinator,
		omp_driver::ext_updates::UpdateScope::Workspace,
		workspace_policy,
		update_now_ms,
		update_notifications_tx.clone(),
		move || async move {
			omp_driver::ext_updates::check_workspace_updates(
				&workspace_env,
				workspace_policy,
				update_now_ms,
			)
			.await
		},
	);
	drop(update_notifications_tx);
	let update_quarantine = environment.extension_reload_handle();
	drop(tokio::spawn(async move {
		while let Ok(notification) = update_notifications_rx.recv_async().await {
			if let Some(failure) = notification.failure {
				eprintln!(
					"Extension update {:?} check failed: {:?}{}",
					notification.scope,
					failure.kind,
					failure
						.code
						.map_or_else(String::new, |code| format!(" ({code})"))
				);
				continue;
			}
			let Some(report) = notification.report else {
				continue;
			};
			if !report.quarantined.is_empty() {
				update_quarantine.quarantine(&report.quarantined).await;
			}
			for id in &report.quarantined {
				eprintln!(
					"SECURITY: extension {id} in the startup generation was revoked and quarantined"
				);
				tracing::warn!(
					extension_id = %id,
					"startup extension revoked and quarantined"
				);
			}
			for item in report.items {
				match item.refusal {
					Some(refusal) => {
						eprintln!(
							"Extension update {} {} -> {} is notify-only: {refusal}",
							item.diff.id, item.diff.from_version, item.diff.to_version
						);
						tracing::warn!(
							extension_id = %item.diff.id,
							from_version = %item.diff.from_version,
							to_version = %item.diff.to_version,
							"extension update restricted to notification"
						);
					},
					None => {
						eprintln!(
							"Extension update {} {} -> {} verified",
							item.diff.id, item.diff.from_version, item.diff.to_version
						);
						tracing::info!(
							extension_id = %item.diff.id,
							from_version = %item.diff.from_version,
							to_version = %item.diff.to_version,
							"extension update verified"
						);
					},
				}
			}
		}
	}));
	let configured_autolearn = settings_manager
		.snapshot()
		.project::<omp_driver::settings::Settings>()
		.map_err(|error| miette::miette!(error))?
		.get()
		.autolearn;
	let manage_skill_available = registry
		.devices()
		.any(|device| device.name.as_str() == "manage_skill");
	let autolearn = omp_agent::AutolearnSettings {
		enabled:        configured_autolearn.enabled && manage_skill_available,
		auto_continue:  configured_autolearn.auto_continue,
		min_tool_calls: configured_autolearn.min_tool_calls,
	};
	let active_content = prompt_discovery.content;
	if !active_content.warnings.is_empty() {
		tracing::warn!(
			warning_count = active_content.warnings.len(),
			"extension content loaded with warnings"
		);
	}
	for warning in active_content.warnings.iter() {
		eprintln!("Extension load warning: {warning}");
	}
	if !prompt_discovery.context.diagnostics.is_empty() {
		tracing::warn!(
			diagnostic_count = prompt_discovery.context.diagnostics.len(),
			"context content loaded with diagnostics"
		);
	}
	for diagnostic in prompt_discovery.context.diagnostics.iter() {
		eprintln!("Context load warning: {diagnostic:?}");
	}
	let prompt_rules = if args.no_rules {
		Arc::from([])
	} else {
		omp_driver::rulebook::prompt_inputs(&active_content.rules)
	};
	let prompt_skills = if args.no_skills {
		Arc::from([])
	} else {
		let discovered = omp_driver::skills::prompt_inputs(&active_content.skills);
		match args.skills.as_ref() {
			Some(selected) => discovered
				.iter()
				.filter(|skill| selected.0.iter().any(|selector| selector == &skill.id))
				.cloned()
				.collect::<Vec<_>>()
				.into(),
			None => discovered,
		}
	};
	prompt_facts.context_files = context::prompt_files(&prompt_discovery.context);
	let prompt_freeze_span = tracing::debug_span!("prompt_freeze");
	let prepared_prompt = prompt_freeze_span.in_scope(|| {
		PromptSnapshot::freeze(
			prompt_facts,
			registry.as_ref(),
			Some(&snapshot.enabled_tools),
			Arc::from([]),
			Default::default(),
			Default::default(),
			Default::default(),
			prompt_rules,
			prompt_skills,
			Arc::from([]),
		)
	});
	let mut prompt_facts = prepared_prompt.workspace;
	let prepared =
		omp_driver::prompt_prep::prepare_environment_inputs_bounded(&env, &session.journal, &root)
			.instrument(prompt_freeze_span.clone())
			.await;
	drop(prompt_freeze_span);
	prompt_facts.host = prepared.host;
	prompt_facts.roots = prepared.roots;
	snapshot.props = prompt_facts
		.props()
		.map_err(|error| miette::miette!(error))?;
	let state = AgentState::new(snapshot);
	let initial_regime = (args.plan_mode || args.plan_yolo).then_some("plan");
	let initial_prompt_slot = args.plan_yolo.then_some("plan-yolo");
	let initial_parts =
		crate::print_mode::initial_parts(&args.prompt, settings.images.auto_resize).await?;
	let initial_submission = if initial_parts.is_empty() {
		None
	} else {
		crate::print_mode::initial_message(initial_parts, None).pop()
	};
	let initial_session = session.id.clone();
	let invocation_deadline =
		absolute_invocation_deadline(Instant::now(), args.max_time.map(|duration| duration.0));

	let final_session = if let Some(endpoint) = args.gateway {
		if args.api_key.is_some() || args.prompt_cache_key.is_some() {
			return Err(miette::miette!(
				"--api-key and --prompt-cache-key require in-process inference"
			));
		}
		let inference_build_span = tracing::debug_span!("inference_build");
		let channel = endpoint
			.connect()
			.instrument(inference_build_span.clone())
			.await
			.into_diagnostic()
			.wrap_err_with(|| format!("could not connect to {endpoint}"))?;
		environment
			.search_bridge()
			.bind_remote(channel.clone())
			.into_diagnostic()?;
		drop(inference_build_span);
		if exit_before_ui_for_timing() {
			return Ok(());
		}
		Box::pin(run_ui(
			RpcTurnClient::new(channel.clone()),
			&environment,
			env,
			state,
			autolearn,
			args.advisor,
			session,
			session_resumed,
			blueprint,
			eval_control.clone(),
			edit_repair_requests,
			None,
			goal_control.clone(),
			None,
			Some(channel.clone()),
			Some(runtime::gateway_provider_control_factory(channel.clone())),
			None,
			credential_control_grants,
			Arc::clone(&prompt_head),
			data_dir.clone(),
			Arc::clone(&settings_manager),
			state_dir.clone(),
			power_mode,
			initial_regime,
			initial_prompt_slot,
			initial_submission.clone(),
			plan_selection,
			plan_handoff.clone(),
			auto_thinking,
			args.thinking == Some(crate::cli::ThinkingLevel::Auto),
			invocation_deadline,
			args.external_thinking.then_some(true),
			args.hide_thinking,
			security_enabled,
			!args.no_title,
			resize_scrollback,
			prompt_discovery_settings.clone(),
			Arc::clone(&catalog_owner),
			ChatScope {
				catalog,
				root: &root,
				sessions_dir: &sessions_dir,
				session_index: Arc::clone(&session_index),
				registry,
				advise_queue: advise_queue.clone(),
				persist_sessions: !args.no_session,
			},
			start,
			presentation,
		))
		.await
		.into_diagnostic()
	} else {
		let inference_build_span = tracing::debug_span!("inference_build");
		let omp_driver::registry::ProductionInference {
			registry: inference_registry,
			rpc: inference,
			credential_authority,
			auth_control,
			builtins,
			..
		} = omp_driver::registry::production_inference_for_session(
			&data_dir,
			Arc::clone(&registry),
			Some(&root),
			omp_driver::registry::InferenceSessionOverrides {
				provider:                credential_provider,
				api_key:                 args.api_key.clone(),
				prompt_cache_affinity:   args.prompt_cache_key.clone(),
				usage_fetchers:          Some(environment.usage_fetchers()),
				provider_response_hooks: Some(environment.provider_response_hooks()),
				catalog:                 Some(Arc::clone(&catalog_owner)),
				settings:                Some(Arc::clone(&settings_snapshot)),
			},
		)
		.instrument(inference_build_span.clone())
		.await
		.into_diagnostic()?;
		search_bridge
			.bind(inference.clone())
			.map_err(|_| miette::miette!("workspace search inference is already bound"))?;
		environment
			.github_credentials()
			.bind(credential_authority)
			.map_err(|_| miette::miette!("GitHub credential authority is already bound"))?;
		let client = InProcTurnClient::new(inference)
			.instrument(inference_build_span.clone())
			.await
			.map_err(ChatError::from)
			.into_diagnostic()?;
		drop(inference_build_span);
		if exit_before_ui_for_timing() {
			return Ok(());
		}
		Box::pin(run_ui(
			client,
			&environment,
			env,
			state,
			autolearn,
			args.advisor,
			session,
			session_resumed,
			blueprint,
			eval_control,
			edit_repair_requests,
			Some(inference_registry),
			goal_control,
			Some(auth_control),
			None,
			None,
			Some(builtins),
			credential_control_grants,
			prompt_head,
			data_dir,
			settings_manager,
			state_dir,
			power_mode,
			initial_regime,
			initial_prompt_slot,
			initial_submission,
			plan_selection,
			plan_handoff,
			auto_thinking,
			args.thinking == Some(crate::cli::ThinkingLevel::Auto),
			invocation_deadline,
			args.external_thinking.then_some(true),
			args.hide_thinking,
			security_enabled,
			!args.no_title,
			resize_scrollback,
			prompt_discovery_settings.clone(),
			Arc::clone(&catalog_owner),
			ChatScope {
				catalog,
				root: &root,
				sessions_dir: &sessions_dir,
				session_index: Arc::clone(&session_index),
				registry,
				advise_queue: advise_queue.clone(),
				persist_sessions: !args.no_session,
			},
			start,
			presentation,
		))
		.await
		.into_diagnostic()
	};
	let final_session = match final_session {
		Ok(session) => session,
		Err(error) => {
			if !args.no_session {
				eprintln!(
					"\nResume this session with {}",
					resume_command(omp_core::dirs::selected_profile(), initial_session.as_str())
				);
			}
			return Err(error);
		},
	};
	if !args.no_session {
		eprintln!(
			"\nResume this session with {}",
			resume_command(omp_core::dirs::selected_profile(), final_session.as_str())
		);
	}

	// `environment` is deliberately retained until the agent and UI have been
	// dropped. Its Drop implementation only stops authorities this process
	// autostarted; it does not further affect any joined or draining daemon.
	drop(environment);
	Ok(())
}

/// Reports the platform limitation before touching project state.
#[cfg(not(any(unix, windows)))]
pub(crate) async fn run(
	_args: ChatArgs,
	_start: ChatStart,
	_presentation: ChatPresentation,
) -> miette::Result<()> {
	use miette::IntoDiagnostic as _;
	Err(DriverChatError::UnsupportedPlatform).into_diagnostic()
}

fn bind_goal_todo_context(events: omp_agent::EventSubscription, modes: sync::Weak<RegimeHandle>) {
	drop(tokio::spawn(async move {
		while let Ok(event) = events.recv().await {
			let omp_agent::AgentEvent::ToolFinished { item, .. } = event.as_ref() else {
				continue;
			};
			let Some(item::Kind::ToolResult(result)) = item.kind.as_ref() else {
				continue;
			};
			if result.name != "todo" || result.is_error {
				continue;
			}
			let mut rendered = String::new();
			for part in &result.parts {
				if let Some(part::Kind::Text(text)) = part.kind.as_ref() {
					if !rendered.is_empty() {
						rendered.push('\n');
					}
					rendered.push_str(text);
				}
			}
			let Some(modes) = modes.upgrade() else {
				break;
			};
			modes.set_goal_todo_context(
				(!rendered.trim().is_empty()).then(|| Str::new(rendered.trim())),
			);
		}
	}));
}

/// Shared app adapter joining engine coordination to persistent child
/// execution.
pub(crate) struct AppAdvisorRuntime<C: TurnClient + Clone + Send + Sync + 'static> {
	engine:   Arc<Mutex<AdvisorEngine>>,
	parent:   Arc<ChatParentHost<C>>,
	links:    tokio::sync::Mutex<AdvisorLinks>,
	notices:  flume::Sender<Option<Str>>,
	headless: bool,
}

/// Lazily created advisor children and delivery regimes.
///
/// Held behind a `tokio::sync::Mutex` because the guard genuinely spans the
/// child spawn and batch-run awaits, serializing advisor turns.
#[derive(Default)]
struct AdvisorLinks {
	control:  Option<omp_agent::ControlSender>,
	children: BTreeMap<Str, Str>,
	regimes:  BTreeMap<Str, ActiveAdvisorRegime>,
}

impl<C: TurnClient + Clone + Send + Sync + 'static> AppAdvisorRuntime<C> {
	/// Composes engine workers; children and regimes attach lazily on the
	/// first dispatched batch, so disabled sessions never spawn a child.
	pub(crate) fn compose(
		parent: Arc<ChatParentHost<C>>,
		control: Option<omp_agent::ControlSender>,
		project_root: PathBuf,
		primary_session: Str,
		enabled: bool,
		available_tools: Vec<Str>,
		advice_queue: AdvisorAdviceQueue,
		catalog: &snapshot::Catalog,
		headless: bool,
	) -> (Self, flume::Receiver<Option<Str>>) {
		let engine = Arc::new(Mutex::new(AdvisorEngine::compose(
			AdvisorEngineOptions {
				project_root,
				primary_session,
				enabled,
				immune_turns: 3,
				available_tools,
				advice_queue,
			},
			catalog,
		)));
		let (notices, receiver) = flume::unbounded();
		let links = tokio::sync::Mutex::new(AdvisorLinks { control, ..AdvisorLinks::default() });
		(Self { engine, parent, links, notices, headless }, receiver)
	}

	/// Returns the shared engine used by commands and status presentation.
	pub(crate) fn engine(&self) -> Arc<Mutex<AdvisorEngine>> {
		Arc::clone(&self.engine)
	}

	/// Attaches the persistent child and delivery regime for one advisor.
	///
	/// Returns the supervised child id, or `None` when composition failed and
	/// the batch must be skipped; failures are recorded on the engine.
	async fn ensure_linked(&self, links: &mut AdvisorLinks, advisor_id: &str) -> Option<Str> {
		if !links.children.contains_key(advisor_id) {
			let spec = {
				let engine = self.engine.lock();
				engine
					.workers()
					.find(|worker| worker.id.as_str() == advisor_id)
					.map(|worker| AdvisorChildSpec {
						id:            worker.id.clone(),
						display_name:  worker.display_name.clone(),
						model:         worker.model.clone(),
						tools:         worker.tools.clone(),
						system_prompt: worker.system_prompt.clone(),
					})
			};
			let spec = spec?;
			match self.parent.spawn_advisor(spec).await {
				Ok(child_id) => {
					links.children.insert(Str::from(advisor_id), child_id);
				},
				Err(error) => {
					tracing::warn!(advisor = %advisor_id, %error, "advisor child could not be spawned");
					self
						.engine
						.lock()
						.record_failure(advisor_id, AdvisorFailureClass::Transient);
					return None;
				},
			}
		}
		if !links.regimes.contains_key(advisor_id) {
			if let Some(control) = links.control.clone() {
				match ActiveAdvisorRegime::start(control, advisor_id, Duration::ZERO, 2).await {
					Ok(regime) => {
						links.regimes.insert(Str::from(advisor_id), regime);
					},
					Err(error) => {
						tracing::warn!(advisor = %advisor_id, %error, "advisor delivery regime could not be started");
					},
				}
			}
		}
		links.children.get(advisor_id).cloned()
	}

	/// Applies one primary-loop event and runs any resulting advisor batches.
	pub(crate) async fn observe(&self, event: &omp_agent::AgentEvent) {
		match event {
			omp_agent::AgentEvent::ToolFinished { item, .. } => {
				if let Some(text) = advisor_tool_text(item) {
					self.engine.lock().observe_primary_text(text.as_str());
				}
			},
			omp_agent::AgentEvent::Turn { turn_id, event } => {
				let Some(inference_pb::turn_event::Event::Outcome(outcome)) = event.event.as_ref()
				else {
					return;
				};
				for item in &outcome.output {
					if let Some(text) = advisor_assistant_text(item) {
						self.engine.lock().observe_primary_text(text.as_str());
					}
				}
				let will_continue = outcome.stop == inference_pb::StopReason::StopToolUse as i32;
				let jobs = self.engine.lock().end_primary_turn(will_continue);
				let context = if self.headless {
					DeliveryContext {
						terminal_answer: true,
						deferred_client_turns: true,
						..DeliveryContext::default()
					}
				} else {
					DeliveryContext {
						terminal_answer: !will_continue,
						queued_work: will_continue,
						update_in_progress: will_continue,
						..DeliveryContext::default()
					}
				};
				self.run_jobs(jobs, turn_id.clone(), context).await;
			},
			_ => {},
		}
	}

	/// Runs pending headless catch-up batches until the engine backlog is empty.
	pub(crate) async fn drain(&self) {
		loop {
			let jobs = {
				let mut engine = self.engine.lock();
				if engine.backlog() == 0 {
					break;
				}
				engine.end_primary_turn(false)
			};
			if jobs.is_empty() {
				break;
			}
			self
				.run_jobs(
					jobs,
					omp_agent::TurnId::new(format!("advisor-finalize-{}", omp_core::Ulid::generate())),
					DeliveryContext {
						terminal_answer: true,
						deferred_client_turns: true,
						..DeliveryContext::default()
					},
				)
				.await;
		}
	}

	async fn run_jobs(
		&self,
		jobs: Vec<AdvisorPromptJob>,
		turn_id: omp_agent::TurnId,
		context: DeliveryContext,
	) {
		if jobs.is_empty() {
			return;
		}
		let mut links = self.links.lock().await;
		for job in jobs {
			let chunks = job
				.batch
				.chunks
				.iter()
				.map(|chunk| chunk.text.clone())
				.collect::<Vec<_>>();
			{
				let mut engine = self.engine.lock();
				for chunk in &chunks {
					engine.record_transcript(&AdvisorTranscriptRecord {
						timestamp_ms: now_ms(),
						advisor_id:   job.advisor_id.clone(),
						kind:         sf!("prompt"),
						content:      chunk.clone(),
						usage:        AdvisorUsageTotals::default(),
					});
				}
			}
			let Some(child_id) = self
				.ensure_linked(&mut links, job.advisor_id.as_str())
				.await
			else {
				continue;
			};
			let outcome = match self
				.parent
				.run_advisor_batch(child_id.as_str(), chunks, turn_id.clone())
				.await
			{
				Ok(outcome) => outcome,
				Err(error) => {
					tracing::warn!(advisor = %job.advisor_id, %error, "advisor batch failed");
					let mut engine = self.engine.lock();
					engine.record_failure(job.advisor_id.as_str(), AdvisorFailureClass::Transient);
					engine.record_transcript(&AdvisorTranscriptRecord {
						timestamp_ms: now_ms(),
						advisor_id:   job.advisor_id.clone(),
						kind:         sf!("error"),
						content:      sf!("advisor batch failed"),
						usage:        AdvisorUsageTotals::default(),
					});
					continue;
				},
			};
			let queue = {
				let mut engine = self.engine.lock();
				engine.record_usage(job.advisor_id.as_str(), outcome.usage);
				engine.record_transcript(&AdvisorTranscriptRecord {
					timestamp_ms: now_ms(),
					advisor_id:   job.advisor_id.clone(),
					kind:         sf!("assistant"),
					content:      outcome.final_text,
					usage:        outcome.usage,
				});
				engine.record_success(job.advisor_id.as_str());
				engine.advice_queue(job.advisor_id.as_str())
			};
			let Some(queue) = queue else {
				continue;
			};
			for queued in queue.drain_ready() {
				let admission = self.engine.lock().admit_advice(
					job.advisor_id.as_str(),
					queued.note,
					queued.severity,
					context,
				);
				match admission {
					AdviceOutcome::Deliver { advice, delivery: AdviceDelivery::Preserve } => {
						let _ = self.notices.send(Some(sf!(
							"**Advisor {} ({})**\n\n{}",
							advice.advisor_id,
							advice.severity,
							advice.note
						)));
					},
					AdviceOutcome::Deliver { advice, .. } => {
						if let Some(regime) = links.regimes.get(advice.advisor_id.as_str()) {
							let _ = regime.handle().submit(advice, context);
						}
					},
					AdviceOutcome::Quarantined(reason) => {
						if let Some(regime) = links.regimes.get(job.advisor_id.as_str()) {
							let _ = regime.record_quarantine(reason.to_string()).await;
						}
					},
					AdviceOutcome::Suppressed(_) => {},
				}
			}
			let _ = self.notices.send(None);
		}
	}
}

fn advisor_assistant_text(item: &omp_proto::thread::v1::Item) -> Option<Str> {
	let Some(item::Kind::Message(message)) = item.kind.as_ref() else {
		return None;
	};
	if message.role != omp_proto::thread::v1::Role::Assistant as i32 {
		return None;
	}
	advisor_parts_text(&message.parts)
}

fn advisor_tool_text(item: &omp_proto::thread::v1::Item) -> Option<Str> {
	let Some(item::Kind::ToolResult(result)) = item.kind.as_ref() else {
		return None;
	};
	let text = advisor_parts_text(&result.parts)?;
	Some(sf!("Tool `{}` result:\n\n{}", result.name, text))
}

fn advisor_parts_text(parts: &[omp_proto::thread::v1::Part]) -> Option<Str> {
	let mut rendered = String::new();
	for part in parts {
		let Some(part::Kind::Text(text)) = part.kind.as_ref() else {
			continue;
		};
		if !rendered.is_empty() {
			rendered.push('\n');
		}
		rendered.push_str(text);
	}
	(!rendered.is_empty()).then(|| Str::from(rendered))
}

async fn run_memory_extractions<C>(
	runtime: Arc<omp_memory::MemoryRuntime>,
	lane: InferenceExtractionLane<C>,
	shutdown: CancellationToken,
) where
	C: TurnClient + Clone + Send + Sync + 'static,
{
	let notifications = runtime.extraction_notifications();
	let mut draining = false;
	loop {
		let pending = match runtime.pending_extractions(16) {
			Ok(pending) => pending,
			Err(error) => {
				tracing::warn!(%error, "memory extraction queue read failed");
				if draining {
					time::sleep(Duration::from_millis(250)).await;
				} else {
					tokio::select! {
						() = shutdown.cancelled() => draining = true,
						() = time::sleep(Duration::from_millis(250)) => {},
					}
				}
				continue;
			},
		};
		if pending.is_empty() {
			if draining {
				break;
			}
			tokio::select! {
				() = shutdown.cancelled() => draining = true,
				_ = notifications.recv_async() => {},
			}
			continue;
		}
		for request in pending {
			if let Err(error) = omp_driver::memory::extract(runtime.as_ref(), &lane, request).await {
				tracing::warn!(%error, "automatic memory extraction failed; job remains queued");
				if draining {
					time::sleep(Duration::from_millis(250)).await;
				} else {
					tokio::select! {
						() = shutdown.cancelled() => draining = true,
						() = time::sleep(Duration::from_millis(250)) => {},
					}
				}
				break;
			}
			if let Err(error) = runtime.enqueue() {
				tracing::error!(
					%error,
					"memory extraction persisted but graph reconciliation failed; queued maintenance \
					 will retry on the next runtime enqueue"
				);
			}
		}
	}
}

#[expect(
	clippy::future_not_send,
	reason = "the designed terminal host remains confined to its event-loop thread"
)]
async fn run_ui<C: TurnClient + Clone + Send + Sync + 'static>(
	client: C,
	environment: &omp_envd::ProjectEnvironment,
	env: omp_env::EnvClient,
	mut state: AgentState,
	autolearn: omp_agent::AutolearnSettings,
	advisor_enabled: bool,
	mut session: Session,
	mut session_resumed: bool,
	mut blueprint: SessionBlueprint,
	eval_control: EvalSessionControl,
	edit_repair_requests: Option<flume::Receiver<omp_tools::edit::observer::EditRepairRequest>>,
	auth_registry: Option<InferenceRegistry>,
	goal_control: AgentGoalControl,
	auth_control: Option<omp_inference::auth::AuthControlHandle>,
	gateway_channel: Option<transport::Channel>,
	gateway_provider_factory: Option<Arc<dyn ControlAuthorityFactory>>,
	provider_builtins: Option<BuiltinConfig>,
	credential_control_grants: BTreeMap<Str, omp_driver::auth_backend::CredentialControlGrant>,
	prompt_head: Arc<ProductionPromptHead>,
	data_dir: PathBuf,
	settings_manager: Arc<SettingsManager>,
	state_dir: PathBuf,
	power_mode: omp_driver::power::SleepPrevention,
	initial_regime: Option<&'static str>,
	initial_prompt_slot: Option<&'static str>,
	mut initial_submission: Option<omp_proto::thread::v1::Item>,
	plan_selection: Option<ModelSelection>,
	plan_handoff: Option<ModelSelection>,
	auto_thinking: omp_driver::settings::AutoThinkingSettings,
	auto_thinking_selected: bool,
	invocation_deadline: Option<Instant>,
	external_thinking: Option<bool>,
	hide_thinking: bool,
	security_enabled: bool,
	title_enabled: bool,
	resize_scrollback: host::ResizeScrollback,
	prompt_discovery_settings: omp_driver::discovery::PromptDiscoverySettings,
	catalog_owner: Arc<omp_catalog::snapshot::Catalog>,
	scope: ChatScope<'_>,
	mut start: ChatStart,
	presentation: ChatPresentation,
) -> Result<Str, ChatError> {
	state.update(|snapshot| snapshot.deadline = invocation_deadline);
	let memory_runtime = environment.memory_runtime();
	let mnemopi = memory_runtime.mnemopi_settings().ok().cloned();
	let memory_params = state.snapshot().turn.params.clone();
	let extraction_shutdown = CancellationToken::new();
	let mut extraction_task = mnemopi
		.as_ref()
		.and_then(|mnemopi| {
			InferenceExtractionLane::from_settings(
				client.clone(),
				memory_params.clone(),
				mnemopi,
				"@memory",
			)
		})
		.map(|lane| {
			tokio::spawn(run_memory_extractions(
				Arc::clone(&memory_runtime),
				lane,
				extraction_shutdown.clone(),
			))
		});
	let memory_source =
		Arc::new(RuntimePromptMemorySource::new(Arc::clone(&memory_runtime), usize::MAX));
	let memory_prompt =
		omp_driver::memory::prompt_snapshot(memory_runtime.as_ref(), None, None, usize::MAX)
			.map_err(DriverChatError::from)?;
	state.update(|snapshot| {
		let values = [
			("memory", memory_prompt.memory.content.clone()),
			("standing", memory_prompt.standing.content.clone()),
			("recall", memory_prompt.recall.content.clone()),
		]
		.into_iter()
		.filter_map(|(name, content)| content.map(|content| (name, omp_scribe::Value::from(content))))
		.collect::<omp_scribe::Value>();
		snapshot.props.set(omp_agent::prompt_keys::MEMORY, values);
	});
	let parent = Arc::new(ChatParentHost::new(
		client.clone(),
		env.clone(),
		state.clone(),
		session.id.clone(),
		scope.sessions_dir.to_path_buf(),
		scope.root.to_path_buf(),
		Arc::clone(&scope.session_index),
		security_enabled,
	));
	parent.bind_admission_gate(environment.admission_gate());
	parent.bind_extension_reload(environment.extension_reload_handle());
	parent.set_prompt_discovery_settings(prompt_discovery_settings.clone());
	parent.set_auto_thinking_settings(auto_thinking);
	let edit_repair_service = edit_repair_requests
		.map(|requests| omp_driver::chat::spawn_edit_repair_service(parent.clone(), requests));
	if let Err(error) = environment
		.bind_schedule_delivery(parent.schedule_delivery_backend())
		.await
	{
		// A newer environment composition (another omp session on this project)
		// replaced the durable scheduler owner between open and bind. Delivery
		// is owned there; this session continues without it.
		let omp_envd::EnvdError::Schedule(
			omp_envd::schedules::DurableScheduleError::StaleGeneration { .. },
		) = error
		else {
			return Err(error.into());
		};
		tracing::warn!(%error, "schedule delivery is owned by a newer environment");
	}
	let mut _external_control_binding: Option<omp_envd::exthost::ExternalControlAuthorityBinding> =
		None;
	parent.start_idle_parking();
	let _eval_parent_binding = environment
		.bind_eval_sdk_parent(parent.session_id(), parent.clone())
		.map_err(|error| DriverChatError::EvalBridge(Str::from(error.to_string())))?;
	environment
		.reflection_bridge()
		.bind(Arc::new(InferenceExtractionLane::with_selector(
			client.clone(),
			memory_params,
			"@smol",
		)))
		.map_err(DriverChatError::from)?;
	let cold_agents = scope.sessions_dir.join("eval-agents");
	if cold_agents.is_dir() {
		omp_agent::AgentRegistry::global().discover_transcripts(&cold_agents)?;
	}
	let provider_registry = auth_registry.clone();
	let auth = auth_registry.map(ChatAuthWorker::start);
	let presentation_bridge = Arc::new(PresentationBridge::new(64));
	let extension_callbacks = environment.extension_callback_dispatcher();
	let extension_ui = Arc::new(PublishedUiRoster::default());
	extension_ui
		.replace(environment.extension_registry_evidences(), Arc::clone(&extension_callbacks))?;
	let drafts = DraftStore::new(&data_dir)?;
	let breadcrumbs = TerminalBreadcrumbs::new(&data_dir)?;
	let terminal_id = omp_tui::ttyid::terminal_id();
	let mut reconstructed_draft: Option<Str> = None;
	let mut emit_session_start = true;
	let mut previous_session: Option<Str> = None;
	state.update(|snapshot| {
		snapshot.prompt_source = prompt_head.wrap_prompt_source(Arc::clone(&snapshot.prompt_source));
	});
	let final_id = loop {
		if emit_session_start {
			let head_event = session.journal.load()?.len().saturating_sub(1) as u64;
			notify_session_start(
				environment.admission_gate().as_ref(),
				session.id.as_str(),
				scope.root,
				&blueprint.options().cwd,
				&blueprint.options().additional_roots,
				session_resumed,
				head_event,
				previous_session.as_deref(),
			);
			emit_session_start = false;
		}
		state.update(|snapshot| snapshot.deadline = invocation_deadline);
		let (model, context_window) = {
			let current = state.snapshot();
			(
				Str::from(current.turn.params.model.as_str()),
				model_context_window(scope.catalog, &current.turn.params.model),
			)
		};
		let provider = model
			.split_once('/')
			.map_or_else(|| Str::new_static(""), |(provider, _)| Str::from(provider));
		let mut roots = Vec::with_capacity(1 + blueprint.options().additional_roots.len());
		roots.push(Str::from(scope.root.to_string_lossy().as_ref()));
		roots.extend(
			blueprint
				.options()
				.additional_roots
				.iter()
				.map(|root| Str::from(root.to_string_lossy().as_ref())),
		);
		prompt_head
			.activate(omp_envd::exthost::PromptPullContext {
				session_id: session.id.clone(),
				model,
				provider,
				context_window: context_window.unwrap_or(0),
				epoch: 0,
				cwd: Str::from(blueprint.options().cwd.to_string_lossy().as_ref()),
				roots,
				vcs_branch: None,
				vcs_commit: None,
				is_subagent: false,
				agent_kind: None,
			})
			.await
			.map_err(DriverChatError::from)?;
		if scope.persist_sessions {
			breadcrumbs.restamp(terminal_id.as_str(), &SessionId(session.id.clone()))?;
		}
		parent.update(state.clone(), session.id.clone());
		let approval_book = Arc::new(omp_agent::ApprovalBook::new());
		let session_root = scope.sessions_dir.join(session.id.as_str());
		ensure_state_directory(&session_root)?;
		ensure_state_directory(&session_root.join("local"))?;
		let host_backends = EnvdHostOwnerBackends::production(
			&session_root.join("control"),
			Arc::clone(&approval_book),
		);
		let telemetry_index = Arc::new(TelemetryIndex::open(
			&state_dir.join("telemetry"),
			&state_dir.join("telemetry.sqlite3"),
		)?);
		let Session { id, journal, initial_items } = session;
		let current_id = id.clone();
		let agent_env = env
			.with_principal(id.clone(), id.clone())
			.map_err(|error| DriverChatError::EvalBridge(Str::from(error.to_string())))?;
		let home = env::var_os("HOME")
			.map(PathBuf::from)
			.unwrap_or_else(|| scope.root.to_path_buf());
		let content = omp_driver::discovery::active_prompt_snapshots(
			scope.root,
			&[],
			&home,
			&prompt_discovery_settings,
		)
		.content;
		let (ttsr, ttsr_diagnostics) = omp_driver::rulebook::ttsr_registry(content.rules.as_ref());
		for error in ttsr_diagnostics {
			tracing::warn!(%error, "TTSR rule condition was rejected");
		}
		let mut agent = Agent::new(client.clone(), agent_env, state.clone(), journal, CHAT_CAPS_BASE);
		agent.set_hook_gate(environment.admission_gate());
		parent.bind_agent_controls(
			id.clone(),
			agent.host_control(),
			agent.control(),
			agent.abort_handle(),
			agent.events().clone(),
		);
		agent.set_unexpected_stop_classifier(parent.clone());
		if auto_thinking_selected {
			agent.set_difficulty_classifier(parent.clone());
		}
		let runtime_settings = settings_manager
			.snapshot()
			.project::<omp_driver::settings::Settings>()
			.map_err(|source| SettingsManagerError::Projection { source })?
			.get()
			.clone();
		if runtime_settings.tools.enabled("todo") {
			agent.add_stateful_component(Arc::new(omp_agent::TodoRestore));
		}
		if let Err(error) = agent.restore_session_state().await {
			tracing::warn!(%error, "journal-derived session state was not restored");
		}
		agent.configure_streaming_edit_guard(
			scope.root.to_path_buf(),
			runtime_settings.tools.edit_streaming_abort,
		);
		let secrets = SecretSessionSnapshot::build(
			0,
			&data_dir.join("secrets.toml"),
			&scope.root.join(".omp/secrets.toml"),
			iter::empty(),
		)?;
		if runtime_settings.secrets.enabled {
			agent.set_secret_obfuscator(secrets.transform_handle());
		}
		agent.set_autolearn(omp_agent::AutolearnSettings {
			enabled:        false,
			auto_continue:  false,
			min_tool_calls: autolearn.min_tool_calls,
		});
		agent.set_ttsr_registry(ttsr);
		agent.set_prompt_memory_source(memory_source.clone());
		agent.set_session_memory(omp_memory::session::SessionMemory::top_level(
			environment.memory_runtime(),
		));
		agent.set_steering_mode(runtime_settings.interaction.steering_mode.into());
		let selected_model = {
			let snapshot = state.snapshot();
			scope
				.catalog
				.model(omp_catalog::ModelKey::from_ref(&snapshot.turn.params.model))
				.or_else(|| scope.catalog.resolve_alias(&snapshot.turn.params.model))
		};
		agent.set_context_promotion(omp_agent::ContextPromotionPolicy {
			enabled: runtime_settings.context_promotion.enabled,
			target:  selected_model
				.and_then(|model| model.context_promotion_target.as_ref())
				.map(|target| Str::new(target.as_str())),
		});
		agent.set_mid_turn_compaction(omp_agent::MidTurnCompactionPolicy {
			enabled:          runtime_settings.compaction.enabled
				&& runtime_settings.compaction.mid_turn_enabled,
			threshold_tokens: ((model_usable_context_window(
				scope.catalog,
				&state.snapshot().turn.params.model,
			)
			.unwrap_or(u64::MAX) as f64)
				* runtime_settings.compaction.threshold_fraction) as u64,
		});
		blueprint.configure_agent(&mut agent);
		match omp_driver::registry::production_redemption_authority(&data_dir) {
			Ok(Some(authority)) => agent.set_redemption_authority(authority),
			Ok(None) => {},
			Err(error) => {
				tracing::warn!(%error, "codex redemption authority was not constructed");
			},
		}
		parent.bind_parent_jobs(Arc::clone(agent.jobs()));
		let blob_store = BlobStore::open(&data_dir)?;
		let artifact_catalog = Arc::new(Mutex::new(ArtifactCatalog::open(&blob_store)?));
		agent.set_artifact_catalog(Arc::clone(&artifact_catalog));
		agent.set_blob_store(blob_store.clone());
		let credential_factory = if let Some(control) = auth_control.as_ref() {
			Arc::new(omp_driver::secrets::credential_secret_control_factory(
				control.clone(),
				credential_control_grants.clone(),
				&secrets,
			)) as Arc<dyn ControlAuthorityFactory>
		} else {
			let channel = gateway_channel
				.as_ref()
				.ok_or(ChatError::MissingAuthority("credentials"))?;
			Arc::new(omp_driver::auth_backend::gateway_credential_secret_control_factory(
				channel.clone(),
				credential_control_grants.clone(),
				&secrets,
			)) as Arc<dyn ControlAuthorityFactory>
		};
		let prompt_factory = prompt_control_factory(prompt_head.clone());
		let presentation_factory = presentation_control_factory(
			Arc::clone(&presentation_bridge),
			Arc::clone(&extension_callbacks),
		);
		let session_control = Arc::new(InteractiveSessionControl::new(
			scope.root.to_path_buf(),
			scope.sessions_dir.to_path_buf(),
			Arc::clone(&scope.session_index),
			Arc::clone(&catalog_owner),
			prompt_discovery_settings.model.clone(),
			state.clone(),
			agent.control(),
		));
		session_control.bind_admission_gate(environment.admission_gate());
		let session_factory = session_control_factory(
			scope.root.to_path_buf(),
			scope.sessions_dir.to_path_buf(),
			Arc::clone(&scope.session_index),
			agent.host_control(),
			Arc::clone(&presentation_bridge),
			Arc::clone(&session_control),
		);
		let telemetry_query =
			Arc::new(TelemetryIndexQuery::new(Arc::clone(&telemetry_index), id.clone()));
		let telemetry_factory = telemetry_control_factory(telemetry_query);
		let job_factory = job_control_factory(
			id.clone(),
			agent.jobs().as_ref().clone(),
			agent.host_control(),
			Arc::clone(&extension_callbacks),
		);
		let provider_factory = gateway_provider_factory.clone().or_else(|| {
			provider_registry
				.as_ref()
				.zip(provider_builtins.as_ref())
				.map(|(registry, builtins)| {
					provider_control_factory(registry.clone(), builtins.clone(), blob_store.clone())
				})
		});
		let capture_rx =
			omp_inference::transport::global_provider_capture().subscribe(Some(id.as_str()));
		let capture_store = blob_store;
		let capture_catalog = Arc::clone(&artifact_catalog);
		let capture_session = SessionId(id.clone());
		let capture_task = tokio::spawn(async move {
			while let Ok(frame) = capture_rx.recv_async().await {
				let body = serde_json::json!({
					"sequence": frame.sequence,
					"event": frame.event,
					"payload": frame.payload,
				})
				.to_string();
				let Ok(reference) = capture_store.put(body.as_bytes()) else {
					continue;
				};
				let _ = capture_catalog.lock().adopt(
					&capture_session,
					reference.hash.into_bytes(),
					Some(reference.size),
					omp_tool::ArtifactLifetime::Session,
				);
			}
		});
		agent.set_run_activity(PowerActivity::new(power_mode));
		let autolearn_regime = autolearn.enabled.then(|| AutolearnRegime::new(autolearn));
		let mut recovered_autolearn = false;
		agent.recover_regimes(
			|spec_id| {
				if let Some(core) = omp_agent::core_regime(spec_id) {
					return Some(core);
				}
				let Some((spec, machine, _)) = autolearn_regime.as_ref() else {
					return None;
				};
				if spec_id != omp_driver::autolearn::AUTOLEARN_REGIME_ID || recovered_autolearn {
					return None;
				}
				recovered_autolearn = true;
				Some((Arc::clone(spec), Box::new(machine.clone()) as Box<dyn omp_agent::Regime>))
			},
			now_ms(),
		)?;
		if let Some((spec, machine, _)) = autolearn_regime.as_ref()
			&& !agent
				.arbiter()
				.regimes()
				.records()
				.iter()
				.any(|record| record.spec_id == omp_driver::autolearn::AUTOLEARN_REGIME_ID)
		{
			let _ = agent.start_regime(
				Arc::clone(spec),
				Box::new(machine.clone()),
				omp_agent::StartOptions { now_ms: now_ms(), queue: false },
			)?;
		}
		let autolearn_task = autolearn_regime.as_ref().map(|(_, _, handle)| {
			let events = agent.events().subscribe_lossless();
			let handle = handle.clone();
			tokio::spawn(async move {
				while let Ok(event) = events.recv().await {
					handle.observe(event.as_ref());
				}
			})
		});
		if let Some(spec_id) = initial_regime
			&& agent
				.arbiter()
				.regimes()
				.resources()
				.owner(&omp_agent::Resource::Mode)
				.is_none()
		{
			let (mut spec, machine) =
				omp_agent::core_regime(spec_id).expect("startup names a built-in regime");
			if let Some(prompt_slot) = initial_prompt_slot {
				Arc::make_mut(&mut spec).sets = Arc::from([omp_agent::ScopedSetting {
					slot:  omp_agent::SettingSlot::PromptSlot,
					value: Str::new_static(prompt_slot),
				}]);
			}
			let _ = agent.start_regime(spec, machine, omp_agent::StartOptions {
				now_ms: now_ms(),
				queue:  false,
			})?;
		}
		let modes = Arc::new(RegimeHandle::new());
		modes.sync_regimes(agent.arbiter().regimes());
		bind_goal_todo_context(agent.events().subscribe_lossless(), Arc::downgrade(&modes));
		modes.bind_plan_selection(state.clone(), plan_selection.clone());
		if let Some(handoff) = plan_handoff.clone() {
			modes.bind_plan_handoff(handoff);
		}
		parent.bind_regimes(Arc::clone(&modes));
		let _goal_binding = goal_control.bind(Arc::clone(&modes), agent.control());
		state.update(|snapshot| {
			snapshot.prompt_source = modes.prompt_source(Arc::clone(&snapshot.prompt_source));
		});
		agent.set_continuation_source(modes.clone());
		let regime_factory =
			extension_regime_control_factory(agent.control(), environment.extension_regime_resolver());
		let provider_factory = provider_factory.ok_or(ChatError::MissingAuthority("provider"))?;
		_external_control_binding = Some(
			SessionControlFactories {
				policy:            host_backends.policy_factory,
				parameters:        host_backends.parameter_factory,
				workers:           host_backends.worker_factory,
				direct_filesystem: host_backends.direct_filesystem_factory,
				credentials:       credential_factory,
				prompts:           prompt_factory,
				sessions:          session_factory,
				ui:                presentation_factory,
				telemetry:         telemetry_factory,
				jobs:              job_factory,
				provider:          provider_factory,
				regimes:           regime_factory,
			}
			.bind(
				environment,
				AgentsControlAuthority::factory_with_session_control(
					Arc::clone(&parent),
					session_control,
				),
			),
		);
		let _control_binding = environment.bind_agent_control(agent.control())?;
		environment.bind_device_availability(agent.mailbox());
		let tree = parent.tree();
		let root_budget = state
			.snapshot()
			.turn
			.params
			.task_budget
			.and_then(|budget| budget.remaining_tokens)
			.map_or_else(Budget::default, |remaining| Budget {
				max_output_tokens: Some(remaining),
				..Budget::default()
			});
		let node = match tree.node(id.as_str()) {
			Some(node) => node,
			None => tree
				.register(id.clone(), sf!("Main"), AgentKind::Main, None, id.clone(), root_budget)
				.map_err(|error| DriverChatError::EvalBridge(Str::from(error.to_string())))?,
		};
		node.set_status(AgentStatus::Running);
		let broker = parent.broker();
		let inbox = broker
			.register(&node, agent.mailbox())
			.map_err(|error| DriverChatError::EvalBridge(Str::from(error.to_string())))?;
		let inbox = hub_backend::share_inbox(inbox);
		parent.bind_inbox(id.clone(), Arc::clone(&inbox));
		parent.recover_parked_children().await;
		let _hub = hub_backend::attach(Arc::new(hub_backend::ChatHubBackend::new(
			broker,
			inbox,
			Arc::clone(agent.jobs()),
			env.clone(),
			id.clone(),
			id.clone(),
			Some(agent.events().clone()),
			Some(parent.supervisor()),
		)));
		let _vibe = omp_driver::vibe::attach_chat(Arc::clone(&parent), Arc::clone(&modes));
		let advisor_events = agent.events().subscribe_lossless();
		let available_advisor_tools = scope
			.registry
			.devices()
			.map(|device| device.name.clone())
			.collect();
		let (advisor_runtime, advisor_notices) = AppAdvisorRuntime::compose(
			Arc::clone(&parent),
			Some(agent.control()),
			scope.root.to_path_buf(),
			id.clone(),
			advisor_enabled,
			available_advisor_tools,
			scope.advise_queue.clone(),
			scope.catalog,
			false,
		);
		let advisor_engine = advisor_runtime.engine();
		let advisor_task = tokio::spawn(async move {
			while let Ok(event) = advisor_events.recv().await {
				advisor_runtime.observe(event.as_ref()).await;
			}
		});
		let saved_draft = if let Some(draft) = reconstructed_draft.take() {
			draft.to_string()
		} else if scope.persist_sessions {
			drafts
				.consume(&SessionId(current_id.clone()))?
				.unwrap_or_default()
		} else {
			String::new()
		};
		let initial_draft = Str::from(saved_draft);
		let submission = initial_submission.take();
		let (approval_route, approval_inbox) = omp_agent::ApprovalRoute::new(
			Arc::clone(&approval_book),
			Some(environment.admission_gate()),
		);
		parent.bind_spawn_approval_route(approval_route.clone());
		environment.bind_approval_authority(Some(Arc::clone(&approval_book)), Some(approval_route));
		let (replica_pump, replica) =
			GuestRelayPump::new(data_dir.join("collab"), scope.root.to_path_buf(), now_ms());
		let replica_shutdown = replica.clone();
		let mut replica_task = tokio::spawn(replica_pump.run());
		let collab_subscription = agent
			.subscribe_collaboration()
			.map_err(|error| DriverChatError::EvalBridge(Str::from(error.to_string())))?;
		let collab_state = omp_proto::collab::v1::SessionStateUpdate {
			host_cwd: scope.root.to_string_lossy().into_owned(),
			participants: vec![omp_proto::collab::v1::Participant {
				display_name: runtime_settings.collab.resolved_display_name().to_string(),
				is_host:      true,
				read_only:    false,
				peer_id:      0,
			}],
			..Default::default()
		};
		let (host, host_ports) = omp_driver::collab::session::HostRuntime::new(
			collab_subscription,
			omp_proto::collab::v1::SessionHeader {
				session_id:    id.to_string(),
				title:         String::new(),
				created_at_ms: now_ms(),
				host_cwd:      scope.root.to_string_lossy().into_owned(),
			},
			collab_state.clone(),
			Default::default(),
			agent.mailbox(),
		)
		.map_err(|error| DriverChatError::EvalBridge(Str::from(error.to_string())))?;
		let (collab_authority, collab) =
			CollabSessionAuthority::with_runtimes(Some(replica), Some(host));
		let mut collab_task = session::spawn_session_owner(collab_authority);
		let title = scope
			.session_index
			.subagent_tree(&SessionId(id.clone()))?
			.into_iter()
			.next()
			.map_or_else(SessionTitleState::default, |session| SessionTitleState {
				title:  session.title,
				source: session.title_source,
			});
		let journal_path = scope.sessions_dir.join(format!("{id}.jsonl"));
		let outcome = chat_ui::run(
			agent,
			environment,
			ChatUiSession { session_id: id, journal_path, initial_items, context_window, title },
			Some(advisor_engine),
			advisor_notices,
			Arc::clone(&catalog_owner),
			Arc::clone(&scope.registry),
			parent.tree(),
			Arc::clone(&parent),
			Some(collab),
			Some(host_ports.live),
			Some(host_ports.operations),
			Some(collab_state),
			modes,
			auth.as_ref().map(|worker| worker.ui().clone()),
			auth_control.clone(),
			data_dir.clone(),
			Arc::clone(&settings_manager),
			prompt_discovery_settings.clone(),
			Arc::clone(&telemetry_index),
			Arc::clone(&scope.session_index),
			scope.root.to_path_buf(),
			session_root.join("local"),
			security_enabled,
			title_enabled,
			resize_scrollback,
			vec![
				content
					.commands
					.iter()
					.cloned()
					.map(crate::chat_ui::input::CommandContribution::from)
					.collect(),
			],
			content.skills,
			content.declarations,
			Some(approval_inbox),
			hide_thinking,
			{
				let sessions_dir = scope.sessions_dir.to_path_buf();
				let root = scope.root.to_path_buf();
				let current_id = current_id.clone();
				move || resume_choices(&sessions_dir, &root, Some(&current_id)).into_diagnostic()
			},
			matches!(start, ChatStart::SessionIndex),
			initial_draft,
			submission,
			Arc::clone(&extension_ui),
			Arc::clone(&extension_callbacks),
			presentation,
			Some(presentation_bridge.attach()),
		)
		.await;
		environment.bind_approval_authority(None, None);
		replica_shutdown.stop().await;
		if time::timeout(Duration::from_secs(3), &mut replica_task)
			.await
			.is_err()
		{
			replica_task.abort();
			let _ = replica_task.await;
		}
		if let Some(task) = autolearn_task {
			task.abort();
			let _ = task.await;
		}
		advisor_task.abort();
		let _ = advisor_task.await;
		if let Err(error) = parent.clear_advisors().await {
			tracing::warn!(%error, "advisor children could not be cleared");
		}
		capture_task.abort();
		let _ = capture_task.await;
		if time::timeout(Duration::from_secs(3), &mut collab_task)
			.await
			.is_err()
		{
			collab_task.abort();
			let _ = collab_task.await;
		}
		let outcome = match outcome {
			Ok(outcome) => outcome,
			Err(error) => {
				notify_session_shutdown(
					environment.admission_gate().as_ref(),
					current_id.as_str(),
					"fatal",
					None,
				);
				return Err(ChatError::Ui(error));
			},
		};
		if scope.persist_sessions {
			drafts.save(&SessionId(current_id.clone()), outcome.draft.as_str())?;
		}
		start = ChatStart::Session;
		let switch_request = match &outcome.exit {
			host::HostExit::Resume(id) => Some(("resume", Some(id.as_str()))),
			host::HostExit::NewSession => Some(("new", None)),
			_ => None,
		};
		if let Some((reason, to_session)) = switch_request
			&& let Err(denied) = gate_session_switch(
				environment.admission_gate().as_ref(),
				reason,
				Some(current_id.as_str()),
				to_session,
				None,
			)
			.await
		{
			tracing::warn!(%denied, "session switch denied by extension policy");
			session = open_session(
				scope.root,
				scope.sessions_dir,
				SessionOpen::Resume(&current_id),
				scope.registry.as_ref(),
				scope
					.persist_sessions
					.then(|| Arc::clone(&scope.session_index)),
			)?;
			continue;
		}
		let switched = switch_request.map(|(reason, _)| reason);
		if matches!(&outcome.exit, host::HostExit::Quit) {
			notify_session_shutdown(
				environment.admission_gate().as_ref(),
				current_id.as_str(),
				"user_exit",
				None,
			);
		}
		match outcome.exit {
			host::HostExit::Quit => break current_id,
			host::HostExit::ExternalEditor => {
				let draft = crate::editor::edit_draft_detached(
					outcome.draft.as_str(),
					crate::editor::EditorOptions::default(),
				)
				.map_err(|error| ChatError::Ui(miette::miette!("{error}")))?
				.unwrap_or_else(|| outcome.draft.to_string());
				reconstructed_draft = Some(Str::from(draft.as_str()));
				if scope.persist_sessions {
					drafts.save(&SessionId(current_id.clone()), draft.as_str())?;
				}
				let model = state.snapshot().turn.params.model.clone();
				let prompt_props = state.snapshot().props.clone();
				session = open_session(
					scope.root,
					scope.sessions_dir,
					SessionOpen::Resume(&current_id),
					scope.registry.as_ref(),
					scope
						.persist_sessions
						.then(|| Arc::clone(&scope.session_index)),
				)?;
				let additional_roots = blueprint.options().additional_roots.clone();
				blueprint = session_blueprint(
					&model,
					scope.catalog,
					scope.root,
					&additional_roots,
					&session.id,
					Arc::clone(&scope.registry),
				)?;
				let mut next = agent_snapshot(&blueprint, scope.catalog, external_thinking)?;
				next.props = replace_model_props(prompt_props, &model);
				state = AgentState::new(next);
			},
			host::HostExit::Suspend => {
				#[cfg(unix)]
				if let Err(error) = signal::kill(Pid::from_raw(0), signal::Signal::SIGSTOP) {
					tracing::warn!(%error, "failed to suspend process group");
				}
				eval_control.request_reset();
				let model = state.snapshot().turn.params.model.clone();
				let prompt_props = state.snapshot().props.clone();
				session = open_session(
					scope.root,
					scope.sessions_dir,
					SessionOpen::Resume(&current_id),
					scope.registry.as_ref(),
					scope
						.persist_sessions
						.then(|| Arc::clone(&scope.session_index)),
				)?;
				let additional_roots = blueprint.options().additional_roots.clone();
				blueprint = session_blueprint(
					&model,
					scope.catalog,
					scope.root,
					&additional_roots,
					&session.id,
					Arc::clone(&scope.registry),
				)?;
				let mut next = agent_snapshot(&blueprint, scope.catalog, external_thinking)?;
				next.props = replace_model_props(prompt_props, &model);
				state = AgentState::new(next);
			},
			host::HostExit::Resume(id) => {
				eval_control.request_reset();
				let model = state.snapshot().turn.params.model.clone();
				let prompt_props = state.snapshot().props.clone();
				session = open_session(
					scope.root,
					scope.sessions_dir,
					SessionOpen::Resume(&id),
					scope.registry.as_ref(),
					scope
						.persist_sessions
						.then(|| Arc::clone(&scope.session_index)),
				)?;
				omp_envd::migrate_session_artifacts(
					scope.sessions_dir,
					current_id.as_str(),
					session.id.as_str(),
				)
				.map_err(|source| DriverChatError::ProjectState {
					path: scope.sessions_dir.to_owned(),
					source,
				})?;
				let additional_roots = blueprint.options().additional_roots.clone();
				blueprint = session_blueprint(
					&model,
					scope.catalog,
					scope.root,
					&additional_roots,
					&session.id,
					Arc::clone(&scope.registry),
				)?;
				let mut next = agent_snapshot(&blueprint, scope.catalog, external_thinking)?;
				next.props = replace_model_props(prompt_props, &model);
				state = AgentState::new(next);
			},
			host::HostExit::NewSession => {
				eval_control.request_reset();
				let model = state.snapshot().turn.params.model.clone();
				let prompt_props = state.snapshot().props.clone();
				session = open_session(
					scope.root,
					scope.sessions_dir,
					if scope.persist_sessions {
						SessionOpen::New
					} else {
						SessionOpen::Ephemeral
					},
					scope.registry.as_ref(),
					scope
						.persist_sessions
						.then(|| Arc::clone(&scope.session_index)),
				)?;
				omp_envd::migrate_session_artifacts(
					scope.sessions_dir,
					current_id.as_str(),
					session.id.as_str(),
				)
				.map_err(|source| DriverChatError::ProjectState {
					path: scope.sessions_dir.to_owned(),
					source,
				})?;
				let additional_roots = blueprint.options().additional_roots.clone();
				blueprint = session_blueprint(
					&model,
					scope.catalog,
					scope.root,
					&additional_roots,
					&session.id,
					Arc::clone(&scope.registry),
				)?;
				let mut next = agent_snapshot(&blueprint, scope.catalog, external_thinking)?;
				next.props = replace_model_props(prompt_props, &model);
				state = AgentState::new(next);
			},
		}
		if let Some(reason) = switched {
			let head_event = session.journal.load()?.len().saturating_sub(1) as u64;
			notify_session_shutdown(
				environment.admission_gate().as_ref(),
				current_id.as_str(),
				"switch",
				Some(session.id.as_str()),
			);
			notify_session_switched(
				environment.admission_gate().as_ref(),
				reason,
				Some(current_id.as_str()),
				session.id.as_str(),
				head_event,
			);
			session_resumed = reason == "resume";
			previous_session = Some(current_id.clone());
			emit_session_start = true;
		}
	};
	extraction_shutdown.cancel();
	if let Some(mut task) = extraction_task.take()
		&& time::timeout(
			Duration::from_millis(mnemopi.as_ref().map_or(1000, |m| m.shutdown_timeout_ms)),
			&mut task,
		)
		.await
		.is_err()
	{
		task.abort();
		let _ = task.await;
	}
	if let Some(auth) = auth {
		auth.shutdown().await;
	}
	if let Some(service) = edit_repair_service {
		service.abort();
	}
	Ok(final_id)
}

#[cfg(test)]
mod tests {
	use omp_agent::GateDecision;

	use super::*;

	#[tokio::test]
	async fn session_switch_deny_preserves_state() {
		let (gate, dispatches) = omp_agent::HookGate::delegated_channel();
		gate.replace_union_mask(1_u128 << HookEventId::HookEventSessionSwitch as u32);
		let gate = Arc::new(gate);
		let responder = Arc::clone(&gate);
		let reply = tokio::spawn(async move {
			let dispatch = dispatches.recv_async().await.expect("switch dispatch");
			responder
				.answer(dispatch.dispatch_id, vec![(0, GateDecision::Deny(sf!("blocked")))])
				.expect("answer switch");
		});
		let mut current = sf!("session-a");
		if gate_session_switch(
			gate.as_ref(),
			"resume",
			Some(current.as_str()),
			Some("session-b"),
			None,
		)
		.await
		.is_ok()
		{
			current = sf!("session-b");
		}
		reply.await.expect("switch responder");
		assert_eq!(current, "session-a");
	}

	#[tokio::test]
	async fn session_branch_transform_composes_summarize() {
		let (gate, dispatches) = omp_agent::HookGate::delegated_channel();
		gate.replace_union_mask(1_u128 << HookEventId::HookEventSessionBranch as u32);
		let gate = Arc::new(gate);
		let responder = Arc::clone(&gate);
		let reply = tokio::spawn(async move {
			let dispatch = dispatches.recv_async().await.expect("branch dispatch");
			let payload = serde_json::json!({
				"at_event": 9,
				"keep_event": 9,
				"reason": "user",
				"summarize": true,
			});
			responder
				.answer(dispatch.dispatch_id, vec![(
					0,
					GateDecision::Modify(HookPatch {
						target: None,
						args:   Some(Bytes::from(
							serde_json::to_vec(&payload).expect("effective payload"),
						)),
					}),
				)])
				.expect("answer branch");
		});
		assert!(
			gate_session_branch(gate.as_ref(), 9, Some(9), false)
				.await
				.expect("branch allowed")
		);
		reply.await.expect("branch responder");
	}

	#[test]
	fn session_post_observe_fires_exactly_once() {
		let (gate, dispatches) = omp_agent::HookGate::delegated_channel();
		gate.replace_union_mask(1_u128 << HookEventId::HookEventSessionReset as u32);
		notify_session_reset(&gate, 12, 0);
		let dispatch = dispatches.try_recv().expect("one reset observation");
		assert_eq!(dispatch.event, HookEventId::HookEventSessionReset);
		assert!(dispatches.try_recv().is_err());
	}
	#[test]
	fn session_transition_observations_include_provenance() {
		let (gate, dispatches) = omp_agent::HookGate::delegated_channel();
		gate.replace_union_mask(
			(1_u128 << HookEventId::HookEventSessionStart as u32)
				| (1_u128 << HookEventId::HookEventSessionShutdown as u32),
		);
		notify_session_start(
			&gate,
			"next",
			Path::new("."),
			Path::new("."),
			&[],
			true,
			4,
			Some("previous"),
		);
		notify_session_shutdown(&gate, "previous", "switch", Some("next"));
		let start = dispatches.try_recv().unwrap();
		let shutdown = dispatches.try_recv().unwrap();
		let start: serde_json::Value = serde_json::from_slice(&start.payload).unwrap();
		let shutdown: serde_json::Value = serde_json::from_slice(&shutdown.payload).unwrap();
		assert_eq!(start["previous_session"], "previous");
		assert_eq!(shutdown["target_session"], "next");
		assert!(dispatches.try_recv().is_err());
	}

	#[tokio::test]
	async fn unsubscribed_session_hooks_construct_no_frame() {
		let (gate, dispatches) = omp_agent::HookGate::delegated_channel();
		assert!(
			!gate_session_branch(&gate, 9, Some(9), false)
				.await
				.expect("fast path")
		);
		notify_session_start(&gate, "session", Path::new("."), Path::new("."), &[], false, 0, None);
		notify_session_reset(&gate, 12, 0);
		assert!(dispatches.try_recv().is_err());
	}

	#[test]
	fn max_time_is_one_absolute_deadline() {
		let now = Instant::now();
		let deadline =
			absolute_invocation_deadline(now, Some(Duration::from_secs(30))).expect("deadline");
		assert_eq!(deadline.duration_since(now), Duration::from_secs(30));
		assert_eq!(absolute_invocation_deadline(now, None), None);
	}
}
