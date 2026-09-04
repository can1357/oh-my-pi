//! Tonic transport projection over the typed inference registry.

use std::{
	collections::{BTreeMap, BTreeSet},
	mem,
	pin::Pin,
	sync::Arc,
	time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use bytes::Bytes;
use flume::Receiver;
use futures::{Stream, StreamExt as _, stream};
use im::OrdMap;
use omp_ai::{
	Client, ProviderResponseHooks, Registry, RetryAction,
	answer::{
		Artifact, ArtifactBody, AudioChunk, ChatControl, ChatControlError, ChatStream,
		GenerationEvent, ImageArtifact, NativeResponse, NativeResponseBody,
		RealtimeEvent as CanonicalRealtimeEvent, RealtimeInput, SearchFailureKind, SearchResults,
		TranscriptEvent, UsageReport, UsageStatus, UsageUnit, UsageWindowKind, VideoArtifact,
	},
	call::{
		self, CallMeta, ContextStrategy, CountAccuracy, CountTokensRequest, DetokenizeRequest,
		Dimensions, EmbedRequest, EmbeddingInput, ImageFormat, ImageQuality, ImageRequest,
		MediaInput, Message, NativeMethod, NativePath, NativePayload, NativeRequest,
		NativeResponseFraming, NegotiationPolicy, OpaqueJson, RawJson, RealtimeModality,
		RealtimeRequest, Sampling, SearchRecency, SearchRequest, SessionRequest, Setting,
		SpeechRequest, Target, TimestampGranularity, TokenizeRequest, ToolChoice, ToolDefinition,
		ToolGrammar, ToolGrammarSyntax, ToolInputConstraint, ToolResultContent, TranscriptionRequest,
		TruncationPolicy, UsageRequest, UsageScope, VideoRequest,
	},
	error::{Error, ErrorDetail, ErrorKind, aggregate_search_failures, search_provider_failure},
	event::{
		BlockKind, ChatEvent, Completion, FinishReason, InvokeComplete, InvokeInput,
		WorkflowActionResponse, WorkflowResponse, WorkflowResponseKind,
	},
	id::{
		AccountId, ConversationId, RequestId, Revision as ProviderRevision, ToolCallId,
		TurnId as ProviderTurnId,
	},
	operation::{
		discovery::CatalogDiscoveryProjectorError,
		job::{JobCancelError, JobCancellationReceipt},
		search::fallback_allowed as search_fallback_allowed,
		search_query::{parse_date_value, parse_search_query},
	},
	receipt::{Cost, ExecutionBudget, RecoveryKind, Usage, UsageSource},
	router::Router,
	session::{ConversationError, ConversationSessionPlanner, TurnReplay},
};
use omp_catalog::{
	Availability, GrammarBits, ModalityBits, ModelAvailability, ModelKey, ModelSpec, OperationKind,
	ProviderDef, ProviderId, model::ProvenanceKind, provider::AuthSpecKind,
};
use omp_core::{Str, format_rfc3339};
use omp_proto::{
	inference::v1::{
		self as pb, count_tokens_request, exec_status, generate_image_request, generation_status,
		model_card, model_event,
		native_request::{self, Path},
		part_start, realtime_event, realtime_frame, realtime_open, search_request,
		search_response::{self, failure},
		speak_event, tool_choice,
		tool_def::{self, grammar},
		transcribe_request, turn_error, turn_event, turn_frame, turn_request, usage, usage_request,
		usage_response::{reset_credits, window},
		value,
	},
	prost::Message as _,
	thread::v1::{self as thread_pb, blob, item, part},
};
use omp_session::projection::{PROVIDER_RESET_PROP, empty_stop, project_thread_history};
use omp_tool::{CapsBase, LoweringCaps, ModelClass, Registry as ToolRegistry, TOOL_REV_PROP};
use parking_lot::Mutex;
use tokio::sync::{broadcast, oneshot};
use tonic::{Request, Response, Status};

// env/v1/turn carries no per-model projection caps; this bounded text-only
// fallback is valid for every transport and never silently exposes media.
const RPC_HISTORY_CAPS_BASE: CapsBase = CapsBase {
	maximum_parts:      1,
	maximum_text_bytes: 64 * 1024,
	media:              false,
	model_class:        ModelClass::Standard,
};

/// Stream returned by RPC methods whose typed operation produces events.
pub type RpcStream<T> = Pin<Box<dyn Stream<Item = Result<T, Status>> + Send + 'static>>;
/// Authoritative provider application operations exposed only when an
/// extension CONTROL session installs its live provider owner.
///
/// Plain `serve` has no authenticated extension caller or capability grant and
/// must not manufacture one from protobuf identity fields.
#[tonic::async_trait]
pub trait ProviderGatewayAuthority: Send + Sync + 'static {
	/// Returns the current model catalog, optionally filtered to one provider.
	async fn catalog(
		&self,
		request: pb::ProviderCatalogRequest,
	) -> Result<pb::ProviderCatalogResponse, Status>;
	/// Returns catalog events after the request cursor for incremental
	/// synchronization.
	async fn watch_catalog(
		&self,
		request: pb::WatchProviderCatalogRequest,
	) -> Result<pb::WatchProviderCatalogResponse, Status>;
	/// Reports whether the named provider currently has usable credentials.
	async fn authenticated(
		&self,
		request: pb::ProviderAuthenticatedRequest,
	) -> Result<pb::ProviderAuthenticatedResponse, Status>;
	/// Adds a provider declaration if the caller's expected catalog generation
	/// is current.
	async fn declare(
		&self,
		request: pb::ProviderDeclarationRequest,
	) -> Result<pb::ProviderMutationResponse, Status>;
	/// Atomically replaces a provider declaration at the expected catalog
	/// generation.
	async fn replace(
		&self,
		request: pb::ProviderDeclarationRequest,
	) -> Result<pb::ProviderMutationResponse, Status>;
	/// Removes a provider declaration at the expected catalog generation.
	async fn retract(
		&self,
		request: pb::RetractProviderRequest,
	) -> Result<pb::ProviderMutationResponse, Status>;
	/// Executes one provider operation through the authoritative application
	/// owner.
	async fn request(
		&self,
		request: pb::ProviderOperationRequest,
	) -> Result<pb::ProviderOperationResponse, Status>;
	/// Creates a provider-backed session from an operation request.
	async fn mint_session(
		&self,
		request: pb::ProviderOperationRequest,
	) -> Result<pb::ProviderOperationResponse, Status>;
}

/// Projects the canonical catalog and typed operation service onto the retained
/// OMP RPC schema.
#[derive(Clone)]
pub struct InferenceRpc {
	registry:              Registry,
	tool_registry:         Arc<ToolRegistry>,
	sessions:              ConversationSessionPlanner,
	epoch:                 Arc<[u8]>,
	provider_sessions:     bool,
	test_live_responses:   Option<flume::Sender<WorkflowResponse>>,
	contexts:              Arc<Mutex<BTreeMap<String, RpcContext>>>,
	generations:           Arc<Mutex<BTreeMap<String, RpcGeneration>>>,
	search_settings:       Arc<omp_ai::search_settings::WebSearchSettings>,
	session_provider:      Option<ProviderId>,
	prompt_cache_affinity: Option<Str>,
	provider_authority:    Option<Arc<dyn ProviderGatewayAuthority>>,
	response_hooks:        ProviderResponseHooks,
}

#[derive(Clone, Default)]
struct RpcContext {
	revision:              u64,
	messages:              Vec<Message>,
	provider_conversation: Option<ConversationId>,
	provider_revision:     Option<ProviderRevision>,
	provider_heads:        OrdMap<u64, ProviderRevision>,
}

struct ResolvedTurn {
	request_messages:      Vec<Message>,
	committed_messages:    Vec<Message>,
	context_id:            Option<String>,
	provider_session:      Option<SessionRequest>,
	provider_conversation: Option<ConversationId>,
	provider_heads:        OrdMap<u64, ProviderRevision>,
	resolved_route:        Arc<Mutex<ResolvedRoute>>,
}

#[derive(Default)]
struct ResolvedRoute {
	provider: Option<ProviderId>,
	model:    Option<ModelKey>,
}

#[derive(Default)]
struct TurnProjection {
	message_parts: Vec<MessagePart>,
	output:        Vec<thread_pb::Item>,
}

impl TurnProjection {
	/// Appends streamed prose to the assistant message, opening a new part
	/// when the block index or kind changes.
	fn append_part(&mut self, index: u32, thinking: bool, text: &str) {
		match self.message_parts.last_mut() {
			Some(part) if part.index == index && part.thinking == thinking => {
				part.text.push_str(text);
			},
			_ => self
				.message_parts
				.push(MessagePart { index, thinking, text: text.to_owned() }),
		}
	}
}

/// One streamed text or thinking block of the assistant message.
struct MessagePart {
	index:    u32,
	thinking: bool,
	text:     String,
}

#[derive(Clone)]
struct RpcGeneration {
	status:  Arc<Mutex<pb::GenerationStatus>>,
	updates: broadcast::Sender<pb::GenerationStatus>,
	cancel:  flume::Sender<oneshot::Sender<Result<JobCancellationReceipt, JobCancelError>>>,
}

impl InferenceRpc {
	/// Creates an RPC projection over one immutable registry generation and the
	/// same provider-conversation planner installed in its route stack.
	pub fn new(
		registry: Registry,
		sessions: ConversationSessionPlanner,
		tool_registry: Arc<ToolRegistry>,
	) -> Self {
		Self::with_provider_sessions(registry, sessions, tool_registry, true, None)
	}

	/// Constructs the production RPC projection around a deterministic route
	/// registry whose route stack does not install provider-session middleware.
	///
	/// This is an integration-test seam only. Gateway context, turn replay, and
	/// duplex projection remain owned by this service.
	#[doc(hidden)]
	pub fn new_for_test(
		registry: Registry,
		sessions: ConversationSessionPlanner,
		tool_registry: Arc<ToolRegistry>,
		live_responses: flume::Sender<WorkflowResponse>,
	) -> Self {
		Self::with_provider_sessions(registry, sessions, tool_registry, false, Some(live_responses))
	}

	fn with_provider_sessions(
		registry: Registry,
		sessions: ConversationSessionPlanner,
		tool_registry: Arc<ToolRegistry>,
		provider_sessions: bool,
		test_live_responses: Option<flume::Sender<WorkflowResponse>>,
	) -> Self {
		let epoch = format!("{}:{}", registry.catalog_revision(), registry.generation()).into_bytes();
		Self {
			registry,
			tool_registry,
			sessions,
			provider_sessions,
			test_live_responses,
			epoch: epoch.into(),
			contexts: Arc::new(Mutex::new(BTreeMap::new())),
			generations: Arc::new(Mutex::new(BTreeMap::new())),
			search_settings: Arc::new(Default::default()),
			session_provider: None,
			prompt_cache_affinity: None,
			provider_authority: None,
			response_hooks: ProviderResponseHooks::default(),
		}
	}

	/// Installs the session-owned provider response observation sink.
	pub fn with_provider_response_hooks(mut self, response_hooks: ProviderResponseHooks) -> Self {
		self.response_hooks = response_hooks;
		self
	}

	/// Installs the application's live provider owner on the gateway surface.
	pub fn with_provider_authority(mut self, authority: Arc<dyn ProviderGatewayAuthority>) -> Self {
		self.provider_authority = Some(authority);
		self
	}

	fn provider_authority(&self) -> Result<&Arc<dyn ProviderGatewayAuthority>, Status> {
		self.provider_authority.as_ref().ok_or_else(|| {
			Status::failed_precondition(
				"provider application authority is not installed; an extension CONTROL session must \
				 establish provider declaration and operation authority",
			)
		})
	}

	/// Replaces web-search routing settings for this immutable RPC facade.
	pub fn with_search_settings(
		mut self,
		settings: omp_ai::search_settings::WebSearchSettings,
	) -> Self {
		self.search_settings = Arc::new(settings);
		self
	}

	/// Applies invocation-scoped routing and prompt-cache affinity.
	///
	/// These values live only on this RPC facade and are never projected into
	/// agent state or transcript items.
	pub fn with_session_overrides(
		mut self,
		provider: Option<ProviderId>,
		prompt_cache_affinity: Option<Str>,
	) -> Self {
		self.session_provider = provider;
		self.prompt_cache_affinity = prompt_cache_affinity;
		self
	}

	fn cursor(&self) -> pb::Cursor {
		pb::Cursor {
			epoch:      self.epoch.as_ref().to_vec().into(),
			generation: self.registry.generation(),
		}
	}

	fn list_models_response(&self, request: &pb::ListModelsRequest) -> pb::ListModelsResponse {
		let requested_facet = pb::Facet::try_from(request.facet).unwrap_or(pb::Facet::Unspecified);
		let models = self
			.registry
			.catalog()
			.models()
			.iter()
			.filter_map(|model| {
				let provider = model
					.routes
					.first()
					.and_then(|route| self.registry.catalog().route(route))
					.map(|route| route.provider.clone())?;
				if !request.provider.is_empty() && provider.as_str() != request.provider {
					return None;
				}
				if request.available_only && !matches!(model.availability, ModelAvailability::Available)
				{
					return None;
				}
				let facets = model_facets(model);
				if requested_facet != pb::Facet::Unspecified
					&& !facets.contains(&(requested_facet as i32))
				{
					return None;
				}
				Some(model_card(model, provider.as_str(), facets))
			})
			.collect();
		pb::ListModelsResponse { models, cursor: Some(self.cursor()), roles: Default::default() }
	}

	/// Resolves a model selector to a routing target.
	///
	/// Exact catalog keys and aliases canonicalize to their target key. A wire
	/// `provider/model` ID for a provider-local configured key additionally pins
	/// that provider domain. Anything else stays verbatim so the router reports
	/// the typed `TargetNotFound`.
	fn target(&self, selector: &str, operation: OperationKind) -> Result<Target, Status> {
		if !selector.is_empty() {
			let catalog = self.registry.catalog();
			let direct = catalog.model(ModelKey::from_ref(selector));
			let aliased = if direct.is_none() {
				catalog.resolve_alias(selector)
			} else {
				None
			};
			if let Some(spec) = direct.or(aliased) {
				if let Some(provider) = &self.session_provider {
					return Ok(Target::Provider {
						provider: provider.clone(),
						model:    spec.key.clone(),
					});
				}
				return Ok(Target::Model(spec.key.clone()));
			}
			if let Some((provider, local_model)) = selector.split_once('/')
				&& let Some(spec) = catalog.models().iter().find(|model| {
					model.key.as_str() == local_model
						&& model.routes.iter().any(|route| {
							catalog
								.route(route)
								.is_some_and(|route| route.provider.as_str() == provider)
						})
				}) {
				let provider = self
					.session_provider
					.clone()
					.unwrap_or_else(|| ProviderId::from(provider));
				return Ok(Target::Provider { provider, model: spec.key.clone() });
			}
			if let Some(provider) = &self.session_provider {
				return Ok(Target::Provider {
					provider: provider.clone(),
					model:    ModelKey::from(selector),
				});
			}
			return Ok(Target::Model(ModelKey::from(selector)));
		}
		self
			.registry
			.catalog()
			.models()
			.iter()
			.find(|model| model.capabilities.operations.contains_kind(operation))
			.map(|model| Target::Model(model.key.clone()))
			.ok_or_else(|| {
				Status::failed_precondition(format!("no catalog target serves {operation}"))
			})
	}

	fn client(&self, target: Target, request: RequestId) -> Client<omp_ai::ProviderService, Router> {
		self.client_with_deadline(target, request, None)
	}

	fn client_with_deadline(
		&self,
		target: Target,
		request: RequestId,
		deadline: Option<Instant>,
	) -> Client<omp_ai::ProviderService, Router> {
		Client::new(
			self.registry.service(),
			Router::new(self.registry.clone(), Duration::from_secs(30)),
			CallMeta {
				id: request,
				target,
				deadline,
				budget: ExecutionBudget::default(),
				session: None,
				debug_session: None,
				response_hooks: self.response_hooks.clone(),
			},
		)
	}

	fn turn_client(
		&self,
		target: Target,
		request: RequestId,
		session: Option<SessionRequest>,
	) -> Client<omp_ai::ProviderService, Router> {
		Client::new(
			self.registry.service(),
			Router::new(self.registry.clone(), Duration::from_secs(30)),
			CallMeta {
				id: request,
				target,
				deadline: None,
				budget: ExecutionBudget::default(),
				debug_session: session
					.as_ref()
					.map(|session| Str::new(session.conversation.as_str())),
				session,
				response_hooks: self.response_hooks.clone(),
			},
		)
		// The invocation key rides on the call so it reaches the wire whether
		// or not a provider conversation is bound.
		.with_affinity(call::CallAffinity {
			prompt_cache:     self.prompt_cache_affinity.clone(),
			provider_session: None,
		})
	}

	fn management_target(
		&self,
		provider: Option<&ProviderId>,
		operation: OperationKind,
	) -> Result<Target, Status> {
		if let Some(provider) = provider {
			return Ok(Target::ProviderService(provider.to_owned()));
		}
		self
			.registry
			.catalog()
			.providers()
			.iter()
			.find(|provider| provider.management.supports(operation))
			.map(|provider| Target::ProviderService(provider.id.clone()))
			.ok_or_else(|| {
				Status::failed_precondition(format!("no provider service serves {operation}"))
			})
	}

	fn resolve_turn_input(
		&self,
		turn: ProviderTurnId,
		input: Option<&turn_request::Input>,
		provider_reset: bool,
	) -> Result<ResolvedTurn, Status> {
		let strategy = ContextStrategy::Replay;
		match input {
			Some(turn_request::Input::Seed(seed)) => {
				let thread = seed
					.thread
					.as_ref()
					.ok_or_else(|| Status::invalid_argument("Seed.thread is required"))?;
				let projected =
					project_thread_history(thread, &self.tool_registry, &RPC_HISTORY_CAPS_BASE)
						.map_err(|error| Status::invalid_argument(error.to_string()))?;
				let messages = thread_messages(&projected)?;
				if seed.context_id.is_empty() {
					return Ok(ResolvedTurn {
						request_messages:      messages.clone(),
						committed_messages:    messages,
						context_id:            None,
						provider_session:      None,
						provider_conversation: None,
						provider_heads:        OrdMap::new(),
						resolved_route:        Arc::default(),
					});
				}
				if self.contexts.lock().contains_key(&seed.context_id) {
					return Err(Status::aborted("seed context is already held"));
				}
				if !self.provider_sessions {
					return Ok(ResolvedTurn {
						request_messages:      messages.clone(),
						committed_messages:    messages,
						context_id:            Some(seed.context_id.clone()),
						provider_session:      None,
						provider_conversation: None,
						provider_heads:        OrdMap::new(),
						resolved_route:        Arc::default(),
					});
				}
				let root = self
					.sessions
					.create_conversation()
					.map_err(conversation_status)?;
				let conversation = root.conversation().to_owned();
				let revision = root.revision().to_owned();
				let provider_session = SessionRequest {
					conversation: conversation.clone(),
					revision: revision.clone(),
					turn,
					strategy,
					append_only: true,
					provider_reset,
					forked: false,
				};
				Ok(ResolvedTurn {
					request_messages:      messages.clone(),
					committed_messages:    messages,
					context_id:            Some(seed.context_id.clone()),
					provider_session:      Some(provider_session),
					provider_conversation: Some(conversation),
					provider_heads:        [(0u64, revision)].into_iter().collect(),
					resolved_route:        Arc::default(),
				})
			},
			Some(turn_request::Input::Incremental(incremental)) => {
				let context = incremental
					.context
					.as_ref()
					.ok_or_else(|| Status::invalid_argument("Incremental.context is required"))?;
				let held = self
					.contexts
					.lock()
					.get(&context.context_id)
					.cloned()
					.ok_or_else(|| Status::not_found("context is not held"))?;
				validate_revision(context, held.revision)?;
				let delta = incremental
					.delta
					.as_ref()
					.ok_or_else(|| Status::invalid_argument("Incremental.delta is required"))?;
				let retained = delta.truncate_to.unwrap_or(held.revision);
				if retained > held.revision {
					return Err(Status::invalid_argument("truncate_to exceeds context head"));
				}
				let projected = project_thread_history(
					&thread_pb::Thread { items: delta.append.clone() },
					&self.tool_registry,
					&RPC_HISTORY_CAPS_BASE,
				)
				.map_err(|error| Status::invalid_argument(error.to_string()))?;
				let appended = thread_messages(&projected)?;
				let mut committed_messages = held
					.messages
					.iter()
					.take(retained as usize)
					.cloned()
					.collect::<Vec<_>>();
				committed_messages.extend(appended.iter().cloned());
				if !self.provider_sessions {
					return Ok(ResolvedTurn {
						request_messages: committed_messages.clone(),
						committed_messages,
						context_id: Some(context.context_id.clone()),
						provider_session: None,
						provider_conversation: None,
						provider_heads: OrdMap::new(),
						resolved_route: Arc::default(),
					});
				}
				let (request_messages, conversation, revision, provider_heads, forked) =
					if (delta.truncate_to.is_none() || retained == held.revision)
						&& held.provider_heads.contains_key(&retained)
					{
						(
							appended,
							held.provider_conversation.clone().ok_or_else(|| {
								Status::internal("held context has no provider conversation")
							})?,
							held
								.provider_revision
								.clone()
								.ok_or_else(|| Status::internal("held context has no provider revision"))?,
							held.provider_heads,
							false,
						)
					} else if let Some(revision) = held.provider_heads.get(&retained).cloned() {
						let conversation = self
							.sessions
							.fork_conversation(&revision)
							.map_err(conversation_status)?;
						(
							appended,
							conversation,
							revision,
							held
								.provider_heads
								.into_iter()
								.filter(|(head, _)| *head <= retained)
								.collect(),
							true,
						)
					} else {
						let root = self
							.sessions
							.create_conversation()
							.map_err(conversation_status)?;
						(
							committed_messages.clone(),
							root.conversation().to_owned(),
							root.revision().to_owned(),
							[(0u64, root.revision().to_owned())].into_iter().collect(),
							true,
						)
					};
				let provider_session = SessionRequest {
					conversation: conversation.clone(),
					revision,
					turn,
					strategy,
					append_only: true,
					provider_reset,
					forked,
				};
				Ok(ResolvedTurn {
					request_messages,
					committed_messages,
					context_id: Some(context.context_id.clone()),
					provider_session: Some(provider_session),
					provider_conversation: Some(conversation),
					provider_heads,
					resolved_route: Arc::default(),
				})
			},
			None => Err(Status::invalid_argument("TurnRequest.input is required")),
		}
	}

	fn generation(&self, generation_id: &str) -> Result<RpcGeneration, Status> {
		if generation_id.is_empty() {
			return Err(Status::invalid_argument("generation_id is required"));
		}
		self
			.generations
			.lock()
			.get(generation_id)
			.cloned()
			.ok_or_else(|| Status::not_found("generation is not held by this daemon"))
	}
}

#[tonic::async_trait]
impl pb::inference_server::Inference for InferenceRpc {
	type AttachGenerationStream = RpcStream<pb::GenerationStatus>;
	type GenerateImageStream = RpcStream<pb::ImageEvent>;
	type NativeStream = RpcStream<pb::NativeChunk>;
	type RealtimeStream = RpcStream<pb::RealtimeEvent>;
	type SpeakStream = RpcStream<pb::SpeakEvent>;
	type TurnStream = RpcStream<pb::TurnEvent>;
	type WatchModelsStream = RpcStream<pb::ModelEvent>;

	#[tracing::instrument(
		level = "debug",
		skip_all,
		fields(rpc.service = "inference", rpc.method = "turn")
	)]
	async fn turn(
		&self,
		request: Request<tonic::Streaming<pb::TurnFrame>>,
	) -> Result<Response<Self::TurnStream>, Status> {
		let mut incoming = request.into_inner();
		let first = incoming
			.message()
			.await?
			.ok_or_else(|| Status::invalid_argument("Turn requires an opening frame"))?;
		let Some(turn_frame::Frame::Open(open)) = first.frame else {
			return Err(Status::invalid_argument("the first Turn frame must be open"));
		};
		if open.turn_id.is_empty() {
			return Err(Status::invalid_argument("TurnRequest.turn_id is required"));
		}
		let turn = ProviderTurnId::from(open.turn_id.as_str());
		if let Some(replay) = self
			.sessions
			.turn_replay(&turn)
			.map_err(conversation_status)?
		{
			let output = turn_replay_events(replay, &open)?;
			return Ok(Response::new(Box::pin(output)));
		}
		let request_bytes = Bytes::from(open.encode_to_vec());
		let params = open
			.params
			.as_ref()
			.ok_or_else(|| Status::invalid_argument("TurnRequest.params is required"))?;
		let provider_reset = open
			.props
			.as_ref()
			.and_then(|props| props.fields.get(PROVIDER_RESET_PROP))
			.and_then(|value| value.kind.as_ref())
			.is_some_and(|kind| matches!(kind, value::Kind::Bool(true)));
		let mut resolved =
			match self.resolve_turn_input(turn.clone(), open.input.as_ref(), provider_reset) {
				Ok(resolved) => resolved,
				Err(status) => {
					let Some(event) = turn_recovery_event(&status, open.input.as_ref(), &self.contexts)
					else {
						return Err(status);
					};
					return Ok(Response::new(Box::pin(stream::once(async move { Ok(event) }))));
				},
			};
		let projection = Arc::new(Mutex::new(TurnProjection::default()));
		let request_id = RequestId::from(open.turn_id.as_str());
		let chat =
			chat_request(mem::take(&mut resolved.request_messages), params, &self.tool_registry)?;
		let target = self.target(&params.model, OperationKind::Chat)?;
		let mut client =
			self.turn_client(target, request_id.clone(), resolved.provider_session.clone());
		let planned = match client.plan(&chat) {
			Ok(planned) => planned,
			Err(error) => {
				let event = inference_turn_error(error);
				return Ok(Response::new(Box::pin(stream::once(async move { Ok(event) }))));
			},
		};
		{
			let mut route = resolved.resolved_route.lock();
			route.provider = Some(planned.execution_plan().provider.clone());
			route.model = planned.execution_plan().model.clone();
		}
		if resolved.provider_session.is_some() {
			let replay_projection = Arc::clone(&projection);
			let replay_context = resolved.context_id.clone();
			let committed_len = resolved.committed_messages.len();
			let resolved_route = Arc::clone(&resolved.resolved_route);
			self.sessions.stage_turn_replay(
				request_id,
				turn.clone(),
				request_bytes.clone(),
				move |completion| {
					let route = resolved_route.lock();
					Ok(Bytes::from(
						build_turn_outcome(
							&replay_projection.lock(),
							completion,
							replay_context.as_deref(),
							committed_len,
							route.provider.as_ref().map(|provider| provider.as_str()),
							route.model.as_ref().map(|model| model.as_str()),
						)
						.encode_to_vec(),
					))
				},
			);
		}
		let events = match client.execute_plan(planned).await {
			Ok(events) => events,
			Err(error) => {
				let event = inference_turn_error(error);
				return Ok(Response::new(Box::pin(stream::once(async move { Ok(event) }))));
			},
		};
		let output = turn_events(
			events,
			incoming,
			Arc::clone(&self.contexts),
			self.sessions.clone(),
			resolved,
			turn,
			request_bytes,
			projection,
			Arc::clone(&self.tool_registry),
			self.test_live_responses.clone(),
		);
		Ok(Response::new(Box::pin(output)))
	}

	#[tracing::instrument(
		level = "debug",
		skip_all,
		fields(rpc.service = "inference", rpc.method = "realtime")
	)]
	async fn realtime(
		&self,
		request: Request<tonic::Streaming<pb::RealtimeFrame>>,
	) -> Result<Response<Self::RealtimeStream>, Status> {
		let mut incoming = request.into_inner();
		let first = incoming
			.message()
			.await?
			.ok_or_else(|| Status::invalid_argument("Realtime requires an opening frame"))?;
		let Some(realtime_frame::Frame::Open(open)) = first.frame else {
			return Err(Status::invalid_argument("the first Realtime frame must be open"));
		};
		if open.request_id.is_empty() || open.model.is_empty() {
			return Err(Status::invalid_argument("RealtimeOpen.request_id and model are required"));
		}
		let operation = RealtimeRequest {
			instructions:   (!open.instructions.is_empty()).then(|| open.instructions.as_str().into()),
			modalities:     open
				.modalities
				.iter()
				.map(|modality| {
					match realtime_open::Modality::try_from(*modality)
						.unwrap_or(realtime_open::Modality::Unspecified)
					{
						realtime_open::Modality::Text => Ok(RealtimeModality::Text),
						realtime_open::Modality::Audio => Ok(RealtimeModality::Audio),
						realtime_open::Modality::Unspecified => {
							Err(Status::invalid_argument("RealtimeOpen modality is required"))
						},
					}
				})
				.collect::<Result<Vec<_>, _>>()?
				.into(),
			voice:          (!open.voice.is_empty()).then(|| open.voice.as_str().into()),
			input_audio:    realtime_audio_format(open.input_audio),
			output_audio:   realtime_audio_format(open.output_audio),
			turn_detection: Setting::Unset,
			tools:          open
				.tools
				.iter()
				.map(tool_definition)
				.collect::<Result<Vec<_>, _>>()?
				.into(),
			negotiation:    NegotiationPolicy::default(),
		};
		let target = self.target(&open.model, OperationKind::Realtime)?;
		let mut client = self.client(target, RequestId::from(open.request_id.as_str()));
		let session = Arc::new(client.execute(operation).await.map_err(inference_status)?);
		let (input_errors, errors) = flume::bounded(1);
		let input_session = Arc::clone(&session);
		tokio::spawn(async move {
			while let Ok(Some(frame)) = incoming.message().await {
				let close = matches!(frame.frame, Some(realtime_frame::Frame::Close(_)));
				let input = match realtime_input(frame) {
					Ok(input) => input,
					Err(error) => {
						let _ = input_errors.send_async(error).await;
						break;
					},
				};
				if let Err(error) = input_session.send(input).await {
					let _ = input_errors
						.send_async(Status::failed_precondition(format!(
							"realtime input was rejected: {error:?}"
						)))
						.await;
					break;
				}
				if close {
					break;
				}
			}
		});
		let mut errors_open = true;
		let output = async_stream::try_stream! {
			loop {
				let event = tokio::select! {
					error = errors.recv_async(), if errors_open => if let Ok(error) = error { Err(error) } else {
						errors_open = false;
						continue;
					},
					event = session.recv() => match event {
						Ok(Ok(event)) => Ok(event),
						Ok(Err(error)) => Err(inference_status(error)),
						Err(error) => Err(Status::failed_precondition(format!(
							"realtime session receive failed: {error:?}"
						))),
					},
				}?;
				let terminal = matches!(event, CanonicalRealtimeEvent::Closed);
				yield realtime_event(event)?;
				if terminal { break; }
			}
		};
		Ok(Response::new(Box::pin(output)))
	}

	#[tracing::instrument(
		level = "debug",
		skip_all,
		fields(rpc.service = "inference", rpc.method = "fork")
	)]
	async fn fork(
		&self,
		request: Request<pb::ForkRequest>,
	) -> Result<Response<pb::ForkResponse>, Status> {
		let request = request.into_inner();
		let parent = request
			.parent
			.ok_or_else(|| Status::invalid_argument("ForkRequest.parent is required"))?;
		if request.context_id.is_empty() {
			return Err(Status::invalid_argument("ForkRequest.context_id is required"));
		}
		let mut contexts = self.contexts.lock();
		let source = contexts
			.get(&parent.context_id)
			.cloned()
			.ok_or_else(|| Status::not_found("parent context is not held"))?;
		validate_revision(&parent, source.revision)?;
		let at = request.at.unwrap_or(source.revision);
		if at > source.revision {
			return Err(Status::invalid_argument("fork revision exceeds parent head"));
		}
		if contexts.contains_key(&request.context_id) {
			return Err(Status::already_exists("fork context already exists"));
		}
		let provider_revision = source.provider_heads.get(&at).cloned();
		let provider_conversation = provider_revision
			.as_ref()
			.map(|revision| self.sessions.fork_conversation(revision))
			.transpose()
			.map_err(conversation_status)?;
		let provider_heads = if provider_revision.is_some() {
			source
				.provider_heads
				.range(..=at)
				.map(|(head, revision)| (*head, revision.clone()))
				.collect()
		} else {
			OrdMap::new()
		};
		let fork = RpcContext {
			revision: at,
			messages: source.messages.into_iter().take(at as usize).collect(),
			provider_conversation,
			provider_revision,
			provider_heads,
		};
		contexts.insert(request.context_id.clone(), fork);
		Ok(Response::new(pb::ForkResponse { revision: Some(revision(&request.context_id, at)) }))
	}

	#[tracing::instrument(
		level = "debug",
		skip_all,
		fields(rpc.service = "inference", rpc.method = "drop")
	)]
	async fn drop(
		&self,
		request: Request<pb::DropRequest>,
	) -> Result<Response<pb::DropResponse>, Status> {
		let context_id = request.into_inner().context_id;
		if context_id.is_empty() {
			return Err(Status::invalid_argument("DropRequest.context_id is required"));
		}
		if self.contexts.lock().remove(&context_id).is_none() {
			return Err(Status::not_found("context is not held"));
		}
		Ok(Response::new(pb::DropResponse {}))
	}

	#[tracing::instrument(
		level = "debug",
		skip_all,
		fields(rpc.service = "inference", rpc.method = "count_tokens")
	)]
	async fn count_tokens(
		&self,
		request: Request<pb::CountTokensRequest>,
	) -> Result<Response<pb::CountTokensResponse>, Status> {
		let request = request.into_inner();
		let messages = match request.input {
			Some(count_tokens_request::Input::Thread(thread)) => thread_messages(&thread)?,
			Some(count_tokens_request::Input::Context(context)) => {
				let held = self
					.contexts
					.lock()
					.get(&context.context_id)
					.cloned()
					.ok_or_else(|| Status::not_found("context is not held"))?;
				validate_revision(&context, held.revision)?;
				held.messages
			},
			None => return Err(Status::invalid_argument("CountTokensRequest.input is required")),
		};
		let operation = CountTokensRequest {
			messages: messages.into(),
			tools:    request
				.tools
				.iter()
				.map(tool_definition)
				.collect::<Result<Vec<_>, _>>()?
				.into(),

			accuracy: CountAccuracy::AllowEstimate,
		};
		let target = self.target(&request.model, OperationKind::CountTokens)?;
		let mut client = self.client(target, rpc_request_id("count"));
		let answer = client
			.execute(operation)
			.await
			.map_err(|error| capability_status(error, &request.model, OperationKind::CountTokens))?;
		Ok(Response::new(pb::CountTokensResponse {
			tokens:     answer.tokens,
			accuracy:   if answer.provenance.exact {
				usage::Accuracy::Exact as i32
			} else {
				usage::Accuracy::Estimated as i32
			},
			provenance: Some(tokenizer_provenance(answer.provenance)),
		}))
	}

	#[tracing::instrument(
		level = "debug",
		skip_all,
		fields(rpc.service = "inference", rpc.method = "tokenize")
	)]
	async fn tokenize(
		&self,
		request: Request<pb::TokenizeRequest>,
	) -> Result<Response<pb::TokenizeResponse>, Status> {
		let request = request.into_inner();
		let operation = TokenizeRequest {
			text:          request.text.as_str().into(),
			allow_special: request.allow_special,
		};
		let target = self.target(&request.model, OperationKind::Tokenize)?;
		let mut client = self.client(target, rpc_request_id("tokenize"));
		let answer = client
			.execute(operation)
			.await
			.map_err(|error| capability_status(error, &request.model, OperationKind::Tokenize))?;
		Ok(Response::new(pb::TokenizeResponse {
			tokens:     answer.tokens,
			provenance: Some(tokenizer_provenance(answer.provenance)),
		}))
	}

	#[tracing::instrument(
		level = "debug",
		skip_all,
		fields(rpc.service = "inference", rpc.method = "detokenize")
	)]
	async fn detokenize(
		&self,
		request: Request<pb::DetokenizeRequest>,
	) -> Result<Response<pb::DetokenizeResponse>, Status> {
		let request = request.into_inner();
		let operation = DetokenizeRequest { tokens: request.tokens.into(), strict: request.strict };
		let target = self.target(&request.model, OperationKind::Detokenize)?;
		let mut client = self.client(target, rpc_request_id("detokenize"));
		let answer = client.execute(operation).await.map_err(inference_status)?;
		Ok(Response::new(pb::DetokenizeResponse {
			text:       answer.text.as_str().to_owned(),
			provenance: Some(tokenizer_provenance(answer.provenance)),
		}))
	}

	#[tracing::instrument(
		level = "debug",
		skip_all,
		fields(rpc.service = "inference", rpc.method = "embed")
	)]
	async fn embed(
		&self,
		request: Request<pb::EmbedRequest>,
	) -> Result<Response<pb::EmbedResponse>, Status> {
		let request = request.into_inner();
		if request.texts.is_empty() {
			return Err(Status::invalid_argument("EmbedRequest.texts must not be empty"));
		}
		let operation = EmbedRequest {
			inputs:      request
				.texts
				.iter()
				.map(|text| EmbeddingInput::Text(Str::from(text.as_str())))
				.collect::<Vec<_>>()
				.into(),
			dimensions:  request.dimensions.map_or(Setting::Unset, Setting::Prefer),
			normalize:   Setting::Unset,
			truncation:  TruncationPolicy::Reject,
			negotiation: NegotiationPolicy::default(),
		};
		let target = self.target(&request.model, OperationKind::Embed)?;
		let mut client = self.client(target, rpc_request_id("embed"));
		let answer = client.execute(operation).await.map_err(inference_status)?;
		Ok(Response::new(pb::EmbedResponse {
			vectors: answer
				.embeddings
				.into_iter()
				.map(|embedding| pb::embed_response::Vector { values: embedding.values })
				.collect(),
			usage:   Some(proto_usage(answer.usage)),
		}))
	}

	#[tracing::instrument(
		level = "debug",
		skip_all,
		fields(rpc.service = "inference", rpc.method = "generate_image")
	)]
	async fn generate_image(
		&self,
		request: Request<pb::GenerateImageRequest>,
	) -> Result<Response<Self::GenerateImageStream>, Status> {
		let request = request.into_inner();
		if request.prompt.is_empty() {
			return Err(Status::invalid_argument("GenerateImageRequest.prompt is required"));
		}
		let dimensions = request.size.map_or(Setting::Unset, |size| {
			Setting::Prefer(Dimensions { width: size.width, height: size.height })
		});
		let quality = match generate_image_request::Quality::try_from(request.quality)
			.unwrap_or(generate_image_request::Quality::Unspecified)
		{
			generate_image_request::Quality::Low => Setting::Prefer(ImageQuality::Draft),
			generate_image_request::Quality::Medium => Setting::Prefer(ImageQuality::Standard),
			generate_image_request::Quality::High => Setting::Prefer(ImageQuality::High),
			generate_image_request::Quality::Unspecified => Setting::Unset,
		};
		let format = match generate_image_request::Format::try_from(request.format)
			.unwrap_or(generate_image_request::Format::Unspecified)
		{
			generate_image_request::Format::Png => Setting::Prefer(ImageFormat::Png),
			generate_image_request::Format::Webp => Setting::Prefer(ImageFormat::Webp),
			generate_image_request::Format::Jpeg => Setting::Prefer(ImageFormat::Jpeg),
			generate_image_request::Format::Svg => {
				return Err(Status::invalid_argument("SVG is not a canonical generated image format"));
			},
			generate_image_request::Format::Unspecified => Setting::Unset,
		};
		let background = match generate_image_request::Background::try_from(request.background)
			.unwrap_or(generate_image_request::Background::Unspecified)
		{
			generate_image_request::Background::Opaque => Setting::Prefer(call::Background::Opaque),
			generate_image_request::Background::Transparent => {
				Setting::Prefer(call::Background::Transparent)
			},
			generate_image_request::Background::Unspecified => Setting::Unset,
		};
		let operation = ImageRequest {
			prompt: request.prompt.as_str().into(),
			references: request
				.input_images
				.iter()
				.map(media_input)
				.collect::<Result<Vec<_>, _>>()?
				.into(),
			mask: None,
			count: request.n.max(1),
			dimensions,
			quality,
			background,
			format,
			style: Setting::Unset,
			safety: Arc::from([]),
			seed: request.seed,
			negotiation: NegotiationPolicy::default(),
		};
		let target = self.target(&request.model, OperationKind::GenerateImage)?;
		let mut client = self.client(target, rpc_request_id("image"));
		let events = client.execute(operation).await.map_err(inference_status)?;
		Ok(Response::new(Box::pin(image_events(events))))
	}

	#[tracing::instrument(
		level = "debug",
		skip_all,
		fields(rpc.service = "inference", rpc.method = "speak")
	)]
	async fn speak(
		&self,
		request: Request<pb::SpeakRequest>,
	) -> Result<Response<Self::SpeakStream>, Status> {
		let request = request.into_inner();
		if request.text.is_empty() || request.voice.is_empty() {
			return Err(Status::invalid_argument("SpeakRequest.text and voice are required"));
		}
		let format = match pb::AudioEncoding::try_from(request.encoding)
			.unwrap_or(pb::AudioEncoding::Unspecified)
		{
			pb::AudioEncoding::Mp3 => Setting::Prefer(call::AudioFormat::Mp3),
			pb::AudioEncoding::Pcm16 => Setting::Prefer(call::AudioFormat::Pcm16),
			pb::AudioEncoding::Wav => Setting::Prefer(call::AudioFormat::Wav),
			pb::AudioEncoding::Opus => Setting::Prefer(call::AudioFormat::Opus),
			pb::AudioEncoding::Aac => Setting::Prefer(call::AudioFormat::Aac),
			pb::AudioEncoding::Flac => Setting::Prefer(call::AudioFormat::Flac),
			pb::AudioEncoding::Unspecified => Setting::Unset,
		};
		let operation = SpeechRequest {
			text: request.text.as_str().into(),
			voice: request.voice.as_str().into(),
			format,
			sample_rate_hz: request
				.sample_rate_hz
				.map_or(Setting::Unset, Setting::Prefer),
			speed: request
				.speed
				.map_or(Setting::Unset, |speed| Setting::Prefer(speed as f32)),
			timestamps: Setting::Unset,
			negotiation: NegotiationPolicy::default(),
		};
		let target = self.target(&request.model, OperationKind::Speak)?;
		let mut client = self.client(target, rpc_request_id("speak"));
		let events = client.execute(operation).await.map_err(inference_status)?;
		let output = events.map(|event| event.map(speak_event).map_err(inference_status));
		Ok(Response::new(Box::pin(output)))
	}

	#[tracing::instrument(
		level = "debug",
		skip_all,
		fields(rpc.service = "inference", rpc.method = "transcribe")
	)]
	async fn transcribe(
		&self,
		request: Request<pb::TranscribeRequest>,
	) -> Result<Response<pb::TranscribeResponse>, Status> {
		let request = request.into_inner();
		let audio = request
			.audio
			.as_ref()
			.ok_or_else(|| Status::invalid_argument("TranscribeRequest.audio is required"))
			.and_then(media_input)?;
		let granularity = if request.granularities.iter().any(|value| {
			transcribe_request::Granularity::try_from(*value)
				.is_ok_and(|value| value == transcribe_request::Granularity::Word)
		}) {
			Setting::Prefer(TimestampGranularity::Word)
		} else if request.granularities.iter().any(|value| {
			transcribe_request::Granularity::try_from(*value)
				.is_ok_and(|value| value == transcribe_request::Granularity::Segment)
		}) {
			Setting::Prefer(TimestampGranularity::Segment)
		} else {
			Setting::Unset
		};
		let operation = TranscriptionRequest {
			audio,
			language: (!request.language.is_empty()).then(|| request.language.as_str().into()),
			translate_to_english: request.translate,
			diarization: if request.diarize {
				Setting::Require(true)
			} else {
				Setting::Unset
			},
			timestamps: granularity,
			prompt: (!request.prompt.is_empty()).then(|| request.prompt.as_str().into()),
			negotiation: NegotiationPolicy::default(),
		};
		let target = self.target(&request.model, OperationKind::Transcribe)?;
		let mut client = self.client(target, rpc_request_id("transcribe"));
		let mut events = client.execute(operation).await.map_err(inference_status)?;
		let mut response = pb::TranscribeResponse::default();
		while let Some(event) = events.next().await {
			match event.map_err(inference_status)? {
				TranscriptEvent::Started { language } => {
					if let Some(language) = language {
						response.language = language.into();
					}
				},
				TranscriptEvent::TextDelta { .. } => {},
				TranscriptEvent::Segment { text, start_ms, end_ms, speaker, .. } => {
					response.segments.push(pb::transcribe_response::Segment {
						start_ms,
						end_ms,
						text: text.into(),
						speaker: speaker.map(|speaker| speaker.index),
						confidence: None,
					});
				},
				TranscriptEvent::Word { text, start_ms, end_ms, speaker, .. } => {
					response.words.push(pb::transcribe_response::Word {
						start_ms,
						end_ms,
						word: text.into(),
						speaker: speaker.map(|speaker| speaker.index),
					});
				},
				TranscriptEvent::Completed { text, usage } => {
					response.text = text.into();
					response.usage = Some(proto_usage(usage));
				},
			}
		}
		Ok(Response::new(response))
	}

	#[tracing::instrument(
		level = "debug",
		skip_all,
		fields(rpc.service = "inference", rpc.method = "search")
	)]
	async fn search(
		&self,
		request: Request<pb::SearchRequest>,
	) -> Result<Response<pb::SearchResponse>, Status> {
		let request = request.into_inner();
		if request.query.is_empty() {
			return Err(Status::invalid_argument("SearchRequest.query is required"));
		}
		let recency = match search_request::Recency::try_from(request.recency)
			.unwrap_or(search_request::Recency::Unspecified)
		{
			search_request::Recency::Day => Some(SearchRecency::Day),
			search_request::Recency::Week => Some(SearchRecency::Week),
			search_request::Recency::Month => Some(SearchRecency::Month),
			search_request::Recency::Year => Some(SearchRecency::Year),
			search_request::Recency::Unspecified => None,
		};
		let locale = match (request.language.is_empty(), request.country.is_empty()) {
			(false, false) => Some(Str::from(format!("{}-{}", request.language, request.country))),
			(false, true) => Some(request.language.as_str().into()),
			(true, false) => Some(request.country.as_str().into()),
			(true, true) => None,
		};
		let mut parsed_query = parse_search_query(&request.query);
		if !request.after.is_empty() {
			parsed_query.after =
				Some(parse_date_value(&request.after).ok_or_else(|| {
					Status::invalid_argument("SearchRequest.after must be a valid date")
				})?);
		}
		if !request.before.is_empty() {
			parsed_query.before = Some(parse_date_value(&request.before).ok_or_else(|| {
				Status::invalid_argument("SearchRequest.before must be a valid date")
			})?);
		}
		let provider_chain =
			(!request.engine.is_empty()).then(|| configured_search_providers(request.engine.as_str()));
		let provider = provider_chain
			.as_ref()
			.and_then(|providers| providers.first())
			.cloned();
		let timeout = if request.timeout_ms == 0 {
			Duration::from_secs(u64::from(self.search_settings.timeout_seconds))
		} else {
			Duration::from_millis(u64::from(request.timeout_ms)).min(Duration::from_secs(300))
		};
		let temperature = request.temperature.map(|value| value as f32);
		if temperature.is_some_and(|value| !value.is_finite()) {
			return Err(Status::invalid_argument("SearchRequest.temperature must be finite"));
		}
		let excluded_providers = self
			.search_settings
			.exclusions
			.iter()
			.flat_map(|provider| configured_search_providers(provider.as_str()))
			.collect::<Vec<_>>();
		let provider_order = self
			.search_settings
			.order
			.iter()
			.flat_map(|provider| configured_search_providers(provider.as_str()))
			.filter(|provider| !excluded_providers.contains(provider))
			.collect::<Vec<_>>();
		let operation = SearchRequest {
			query: request.query.as_str().into(),
			parsed_query: Arc::new(parsed_query),
			include_domains: request
				.allowed_domains
				.iter()
				.map(|value| Str::from(value.as_str()))
				.collect::<Vec<_>>()
				.into(),
			exclude_domains: request
				.excluded_domains
				.iter()
				.map(|value| Str::from(value.as_str()))
				.collect::<Vec<_>>()
				.into(),
			recency,
			locale,
			max_results: if request.limit == 0 {
				10
			} else {
				request.limit
			},
			retrieval_results: (request.num_search_results != 0).then_some(request.num_search_results),
			max_output_tokens: (request.max_tokens != 0).then_some(request.max_tokens),
			temperature,
			provider: provider.clone(),
			provider_order: provider_order.clone().into(),
			excluded_providers: excluded_providers.into(),
			attempt_timeout: timeout,
			endpoint_override: self.search_settings.searxng_endpoint.clone(),
			perplexity_responses: self.search_settings.perplexity_responses,
			synthesize_answer: Setting::Prefer(true),
			negotiation: NegotiationPolicy::default(),
		};
		let providers = provider_chain.unwrap_or(provider_order);
		if providers.is_empty() {
			return Err(Status::failed_precondition(
				"web search provider order is empty after exclusions",
			));
		}
		let explicit = operation.provider.is_some();
		let explicit_family = explicit && providers.len() > 1;
		let mut failures = Vec::new();
		for (index, provider) in providers.iter().enumerate() {
			let mut client = self.client_with_deadline(
				Target::ProviderService(provider.clone()),
				rpc_request_id("search"),
				Some(Instant::now() + timeout),
			);
			match client.execute(operation.clone()).await {
				Ok(mut answer) => {
					let mut prior = failures
						.iter()
						.map(search_provider_failure)
						.collect::<Vec<_>>();
					prior.append(&mut answer.metadata.failures);
					answer.metadata.failures = prior;
					return Ok(Response::new(search_response(answer)));
				},
				Err(error) => {
					let has_next = (!explicit || explicit_family) && index + 1 < providers.len();
					let can_fallback = has_next
						&& error
							.receipt()
							.attempts
							.last()
							.is_some_and(|attempt| search_fallback_allowed(&error, attempt.body));
					failures.push(error);
					if !can_fallback {
						break;
					}
				},
			}
		}
		Err(inference_status(aggregate_search_failures(failures)))
	}

	#[tracing::instrument(
		level = "debug",
		skip_all,
		fields(rpc.service = "inference", rpc.method = "generate_video")
	)]
	async fn generate_video(
		&self,
		request: Request<pb::GenerateVideoRequest>,
	) -> Result<Response<pb::GenerationStatus>, Status> {
		let request = request.into_inner();
		if request.prompt.is_empty() {
			return Err(Status::invalid_argument("GenerateVideoRequest.prompt is required"));
		}
		if request.end_frame.is_some() || !request.references.is_empty() {
			return Err(Status::invalid_argument(
				"end-frame and multi-reference video inputs have no canonical VideoRequest projection",
			));
		}
		let operation = VideoRequest {
			prompt:            request.prompt.as_str().into(),
			reference:         request.start_frame.as_ref().map(media_input).transpose()?,
			duration_ms:       request
				.duration_seconds
				.map_or(Setting::Unset, |seconds| Setting::Prefer(u64::from(seconds) * 1_000)),
			dimensions:        video_dimensions(request.resolution, request.aspect_ratio),
			frames_per_second: Setting::Unset,
			audio:             request.audio.map_or(Setting::Unset, Setting::Prefer),
			safety:            Arc::from([]),
			seed:              request.seed,
			negotiation:       NegotiationPolicy::default(),
		};
		let target = self.target(&request.model, OperationKind::GenerateVideo)?;
		let mut client = self.client(target, rpc_request_id("video"));
		let session = client.execute(operation).await.map_err(inference_status)?;
		let checkpoint = session.checkpoint();
		let generation_id = checkpoint.job.handle.as_str().to_owned();
		let created_at_ms = system_time_ms(checkpoint.created_at);
		let initial = pb::GenerationStatus {
			generation_id: generation_id.clone(),
			state: generation_status::State::Queued as i32,
			progress_percent: 0.0,
			detail: String::new(),
			artifacts: Vec::new(),
			usage: None,
			cost: None,
			unsupported: Vec::new(),
			created_at_ms,
			updated_at_ms: created_at_ms,
			props: None,
		};
		let status = Arc::new(Mutex::new(initial.clone()));
		let (updates, _) = broadcast::channel(32);
		let (cancel, cancel_rx) = flume::bounded(1);
		self
			.generations
			.lock()
			.insert(generation_id, RpcGeneration {
				status: Arc::clone(&status),
				updates: updates.clone(),
				cancel,
			});
		tokio::spawn(run_generation(session, status, updates, cancel_rx));
		Ok(Response::new(initial))
	}

	#[tracing::instrument(
		level = "debug",
		skip_all,
		fields(rpc.service = "inference", rpc.method = "get_generation")
	)]
	async fn get_generation(
		&self,
		request: Request<pb::GetGenerationRequest>,
	) -> Result<Response<pb::GenerationStatus>, Status> {
		let generation = self.generation(&request.into_inner().generation_id)?;
		let status = generation.status.lock().clone();
		Ok(Response::new(status))
	}

	#[tracing::instrument(
		level = "debug",
		skip_all,
		fields(rpc.service = "inference", rpc.method = "attach_generation")
	)]
	async fn attach_generation(
		&self,
		request: Request<pb::AttachGenerationRequest>,
	) -> Result<Response<Self::AttachGenerationStream>, Status> {
		let generation = self.generation(&request.into_inner().generation_id)?;
		let initial = generation.status.lock().clone();
		let mut receiver = generation.updates.subscribe();
		let output = async_stream::try_stream! {
			yield initial;
			loop {
				match receiver.recv().await {
					Ok(status) => {
						let terminal = matches!(
							generation_status::State::try_from(status.state),
							Ok(generation_status::State::Completed
								| generation_status::State::Failed
								| generation_status::State::Cancelled)
						);
						yield status;
						if terminal { break; }
					},
					Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
						Err(Status::resource_exhausted("generation attachment fell behind"))?
					},
					Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
				}
			}
		};
		Ok(Response::new(Box::pin(output)))
	}

	#[tracing::instrument(
		level = "debug",
		skip_all,
		fields(rpc.service = "inference", rpc.method = "cancel_generation")
	)]
	async fn cancel_generation(
		&self,
		request: Request<pb::CancelGenerationRequest>,
	) -> Result<Response<pb::GenerationStatus>, Status> {
		let generation = self.generation(&request.into_inner().generation_id)?;
		let (reply, result) = oneshot::channel();
		generation
			.cancel
			.send_async(reply)
			.await
			.map_err(|_| Status::failed_precondition("generation actor has stopped"))?;
		result
			.await
			.map_err(|_| {
				Status::failed_precondition("generation cancellation acknowledgement closed")
			})?
			.map_err(|error| {
				Status::failed_precondition(format!("generation cancellation failed: {error:?}"))
			})?;
		let status = generation.status.lock().clone();
		Ok(Response::new(status))
	}

	#[tracing::instrument(
		level = "debug",
		skip_all,
		fields(rpc.service = "inference", rpc.method = "usage")
	)]
	async fn usage(
		&self,
		request: Request<pb::UsageRequest>,
	) -> Result<Response<pb::UsageResponse>, Status> {
		let request = request.into_inner();
		if request.provider.is_empty()
			&& request.account.is_empty()
			&& request.scope == usage_request::Scope::Unspecified as i32
			&& !request.allow_stale
		{
			return Err(Status::invalid_argument("UsageRequest must specify a provider or scope"));
		}
		let provider =
			(!request.provider.is_empty()).then(|| ProviderId::from(request.provider.as_str()));
		let operation = UsageRequest {
			provider:    provider.clone(),
			account:     (!request.account.is_empty())
				.then(|| AccountId::from(request.account.as_str())),
			scope:       match usage_request::Scope::try_from(request.scope)
				.unwrap_or(usage_request::Scope::Unspecified)
			{
				usage_request::Scope::Unspecified | usage_request::Scope::Current => {
					UsageScope::Current
				},
				usage_request::Scope::Billing => UsageScope::Billing,
				usage_request::Scope::RateLimit => UsageScope::RateLimit,
				usage_request::Scope::All => UsageScope::All,
			},
			allow_stale: request.allow_stale,
		};
		let target = self.management_target(provider.as_ref(), OperationKind::Usage)?;
		let mut client = self.client(target, rpc_request_id("usage"));
		let answer = client.execute(operation).await.map_err(inference_status)?;
		Ok(Response::new(usage_response(*answer)))
	}

	#[tracing::instrument(
		level = "debug",
		skip_all,
		fields(rpc.service = "inference", rpc.method = "native")
	)]
	async fn native(
		&self,
		request: Request<pb::NativeRequest>,
	) -> Result<Response<Self::NativeStream>, Status> {
		let request = request.into_inner();
		let method = match native_request::Method::try_from(request.method)
			.unwrap_or(native_request::Method::Unspecified)
		{
			native_request::Method::Get => NativeMethod::Get,
			native_request::Method::Post => NativeMethod::Post,
			native_request::Method::Delete => NativeMethod::Delete,
			native_request::Method::Unspecified => {
				return Err(Status::invalid_argument("NativeRequest.method is required"));
			},
		};
		let path = match Path::try_from(request.path).unwrap_or(Path::Unspecified) {
			Path::ChatCompletions => NativePath::ChatCompletions,
			Path::Responses => NativePath::Responses,
			Path::Messages => NativePath::Messages,
			Path::MessageTokenCounts => NativePath::MessageTokenCounts,
			Path::Embeddings => NativePath::Embeddings,
			Path::ImageGenerations => NativePath::ImageGenerations,
			Path::AudioSpeech => NativePath::AudioSpeech,
			Path::AudioTranscriptions => NativePath::AudioTranscriptions,
			Path::RealtimeSessions => NativePath::RealtimeSessions,
			Path::Models => NativePath::Models,
			Path::Usage => NativePath::Usage,
			Path::Unspecified => {
				return Err(Status::invalid_argument("NativeRequest.path is required"));
			},
		};
		let maximum = request.max_response_bytes.max(1);
		let payload = match request.payload {
			Some(native_request::Payload::Json(bytes)) => Some(NativePayload::Json(
				RawJson::new(bytes, maximum)
					.map_err(|error| Status::invalid_argument(error.to_string()))?,
			)),
			Some(native_request::Payload::Bytes(bytes)) => Some(NativePayload::Bytes(bytes)),
			None => None,
		};
		let response_framing = match native_request::Framing::try_from(request.framing)
			.unwrap_or(native_request::Framing::Unspecified)
		{
			native_request::Framing::Json => NativeResponseFraming::Json,
			native_request::Framing::Sse => NativeResponseFraming::Sse,
			native_request::Framing::Bytes => NativeResponseFraming::Bytes,
			native_request::Framing::Unspecified => {
				return Err(Status::invalid_argument("NativeRequest.framing is required"));
			},
		};
		let operation =
			NativeRequest { method, path, payload, response_framing, max_response_bytes: maximum };
		let target = self.target(&request.model, OperationKind::Native)?;
		let mut client = self.client(target, rpc_request_id("native"));
		let answer = client.execute(operation).await.map_err(inference_status)?;
		Ok(Response::new(Box::pin(native_response_stream(answer))))
	}

	#[tracing::instrument(
		level = "debug",
		skip_all,
		fields(rpc.service = "inference", rpc.method = "list_providers")
	)]
	async fn list_providers(
		&self,
		request: Request<pb::ListProvidersRequest>,
	) -> Result<Response<pb::ListProvidersResponse>, Status> {
		let requested_facet =
			pb::Facet::try_from(request.into_inner().facet).unwrap_or(pb::Facet::Unspecified);
		let providers = self
			.registry
			.catalog()
			.providers()
			.iter()
			.filter_map(|provider| {
				let card = provider_card(&self.registry, provider);
				(requested_facet == pb::Facet::Unspecified
					|| card.facets.contains(&(requested_facet as i32)))
				.then_some(card)
			})
			.collect();
		Ok(Response::new(pb::ListProvidersResponse { providers, cursor: Some(self.cursor()) }))
	}

	#[tracing::instrument(
		level = "debug",
		skip_all,
		fields(rpc.service = "inference", rpc.method = "list_models")
	)]
	async fn list_models(
		&self,
		request: Request<pb::ListModelsRequest>,
	) -> Result<Response<pb::ListModelsResponse>, Status> {
		Ok(Response::new(self.list_models_response(&request.into_inner())))
	}

	#[tracing::instrument(
		level = "debug",
		skip_all,
		fields(rpc.service = "inference", rpc.method = "watch_models")
	)]
	async fn watch_models(
		&self,
		_request: Request<pb::WatchModelsRequest>,
	) -> Result<Response<Self::WatchModelsStream>, Status> {
		let event = pb::ModelEvent {
			cursor: Some(self.cursor()),
			event:  Some(model_event::Event::Reset(pb::model_event::Reset {})),
		};
		Ok(Response::new(Box::pin(stream::once(async move { Ok(event) }))))
	}

	#[tracing::instrument(
		level = "debug",
		skip_all,
		fields(rpc.service = "inference", rpc.method = "refresh_models")
	)]
	async fn refresh_models(
		&self,
		request: Request<pb::RefreshModelsRequest>,
	) -> Result<Response<pb::ListModelsResponse>, Status> {
		let provider = request.into_inner().provider;
		Ok(Response::new(self.list_models_response(&pb::ListModelsRequest {
			provider,
			facet: pb::Facet::Unspecified as i32,
			available_only: false,
		})))
	}

	#[tracing::instrument(
		level = "debug",
		skip_all,
		fields(rpc.service = "inference", rpc.method = "provider_catalog")
	)]
	async fn provider_catalog(
		&self,
		request: Request<pb::ProviderCatalogRequest>,
	) -> Result<Response<pb::ProviderCatalogResponse>, Status> {
		Ok(Response::new(
			self
				.provider_authority()?
				.catalog(request.into_inner())
				.await?,
		))
	}

	#[tracing::instrument(
		level = "debug",
		skip_all,
		fields(rpc.service = "inference", rpc.method = "watch_provider_catalog")
	)]
	async fn watch_provider_catalog(
		&self,
		request: Request<pb::WatchProviderCatalogRequest>,
	) -> Result<Response<pb::WatchProviderCatalogResponse>, Status> {
		Ok(Response::new(
			self
				.provider_authority()?
				.watch_catalog(request.into_inner())
				.await?,
		))
	}

	#[tracing::instrument(
		level = "debug",
		skip_all,
		fields(rpc.service = "inference", rpc.method = "provider_authenticated")
	)]
	async fn provider_authenticated(
		&self,
		request: Request<pb::ProviderAuthenticatedRequest>,
	) -> Result<Response<pb::ProviderAuthenticatedResponse>, Status> {
		Ok(Response::new(
			self
				.provider_authority()?
				.authenticated(request.into_inner())
				.await?,
		))
	}

	#[tracing::instrument(
		level = "debug",
		skip_all,
		fields(rpc.service = "inference", rpc.method = "declare_provider")
	)]
	async fn declare_provider(
		&self,
		request: Request<pb::ProviderDeclarationRequest>,
	) -> Result<Response<pb::ProviderMutationResponse>, Status> {
		Ok(Response::new(
			self
				.provider_authority()?
				.declare(request.into_inner())
				.await?,
		))
	}

	#[tracing::instrument(
		level = "debug",
		skip_all,
		fields(rpc.service = "inference", rpc.method = "replace_provider")
	)]
	async fn replace_provider(
		&self,
		request: Request<pb::ProviderDeclarationRequest>,
	) -> Result<Response<pb::ProviderMutationResponse>, Status> {
		Ok(Response::new(
			self
				.provider_authority()?
				.replace(request.into_inner())
				.await?,
		))
	}

	#[tracing::instrument(
		level = "debug",
		skip_all,
		fields(rpc.service = "inference", rpc.method = "retract_provider")
	)]
	async fn retract_provider(
		&self,
		request: Request<pb::RetractProviderRequest>,
	) -> Result<Response<pb::ProviderMutationResponse>, Status> {
		Ok(Response::new(
			self
				.provider_authority()?
				.retract(request.into_inner())
				.await?,
		))
	}

	#[tracing::instrument(
		level = "debug",
		skip_all,
		fields(rpc.service = "inference", rpc.method = "execute_provider_request")
	)]
	async fn execute_provider_request(
		&self,
		request: Request<pb::ProviderOperationRequest>,
	) -> Result<Response<pb::ProviderOperationResponse>, Status> {
		Ok(Response::new(
			self
				.provider_authority()?
				.request(request.into_inner())
				.await?,
		))
	}

	#[tracing::instrument(
		level = "debug",
		skip_all,
		fields(rpc.service = "inference", rpc.method = "mint_provider_session")
	)]
	async fn mint_provider_session(
		&self,
		request: Request<pb::ProviderOperationRequest>,
	) -> Result<Response<pb::ProviderOperationResponse>, Status> {
		Ok(Response::new(
			self
				.provider_authority()?
				.mint_session(request.into_inner())
				.await?,
		))
	}
}

fn provider_card(registry: &Registry, provider: &ProviderDef) -> pb::ProviderCard {
	let models = registry
		.catalog()
		.models()
		.iter()
		.filter(|model| {
			model.routes.iter().any(|route| {
				registry
					.catalog()
					.route(route)
					.is_some_and(|route| route.provider == provider.id)
			})
		})
		.collect::<Vec<_>>();
	let facets = models
		.iter()
		.flat_map(|model| model_facets(model))
		.collect::<BTreeSet<_>>()
		.into_iter()
		.collect();
	let auth = if provider
		.auth
		.iter()
		.filter_map(|auth| registry.catalog().auth_spec(auth))
		.any(|auth| matches!(auth.kind, AuthSpecKind::None | AuthSpecKind::OptionalBearer))
	{
		vec![pb::provider_card::AuthKind::None as i32]
	} else {
		Vec::new()
	};
	pb::ProviderCard {
		id: provider.id.as_str().to_owned(),
		name: provider.name.as_str().to_owned(),
		facets,
		auth,
		credentialed: provider
			.routes
			.iter()
			.any(|route| registry.contains_service(route)),
		model_count: models.len().try_into().unwrap_or(u32::MAX),
		props: None,
	}
}

fn model_card(model: &ModelSpec, provider: &str, facets: Vec<i32>) -> pb::ModelCard {
	let local_model = model
		.key
		.as_str()
		.strip_prefix(provider)
		.and_then(|model| model.strip_prefix('/'))
		.unwrap_or(model.key.as_str());
	let source = if model
		.provenance
		.sources
		.iter()
		.any(|source| source.kind == ProvenanceKind::Configured)
	{
		model_card::Source::Configured
	} else if model
		.provenance
		.sources
		.iter()
		.any(|source| source.kind == ProvenanceKind::Discovered)
	{
		model_card::Source::Discovered
	} else {
		model_card::Source::Bundled
	};
	pb::ModelCard {
		id: format!("{provider}/{local_model}"),
		provider: provider.to_owned(),
		model: local_model.to_owned(),
		name: model.display_name.as_str().to_owned(),
		family: model.class.as_str().to_owned(),
		facets,
		inputs: model_input_modalities(model),
		outputs: Vec::new(),
		reasoning: model.thinking.is_some(),
		efforts: Vec::new(),
		context_window: model.limits.context_window.unwrap_or_default(),
		max_output_tokens: model.limits.maximum_output_tokens.unwrap_or_default(),
		pricing: Vec::new(),
		availability: match model.availability {
			ModelAvailability::Unspecified => pb::Availability::Unspecified,
			ModelAvailability::Available => pb::Availability::Available,
			ModelAvailability::LoginRequired => pb::Availability::LoginRequired,
			ModelAvailability::Blocked => pb::Availability::Blocked,
			ModelAvailability::Disabled => pb::Availability::Disabled,
		} as i32,
		source: source as i32,
		blocked_until_ms: model.provenance.blocked_until_ms.unwrap_or_default(),
		deprecated: model.provenance.deprecated,
		updated_at_ms: model.provenance.updated_at_ms.unwrap_or_default(),
		props: None,
		supports_tools: model_supports_tools(model),
	}
}

fn model_input_modalities(model: &ModelSpec) -> Vec<i32> {
	let Some(modalities) = model
		.capabilities
		.chat
		.as_ref()
		.and_then(|chat| chat.input_modalities.constraints())
	else {
		return Vec::new();
	};
	[
		(ModalityBits::TEXT, pb::Modality::Text),
		(ModalityBits::IMAGE, pb::Modality::Image),
		(ModalityBits::AUDIO, pb::Modality::Audio),
		(ModalityBits::VIDEO, pb::Modality::Video),
		(ModalityBits::DOCUMENT, pb::Modality::Pdf),
	]
	.into_iter()
	.filter_map(|(bit, modality)| modalities.contains(bit).then_some(modality as i32))
	.collect()
}

fn model_supports_tools(model: &ModelSpec) -> Option<bool> {
	model
		.capabilities
		.chat
		.as_ref()
		.and_then(|chat| matches!(&chat.tools, Availability::Unsupported).then_some(false))
}

fn model_facets(model: &ModelSpec) -> Vec<i32> {
	[
		(OperationKind::Chat, pb::Facet::Chat),
		(OperationKind::Embed, pb::Facet::Embed),
		(OperationKind::GenerateImage, pb::Facet::ImageGen),
		(OperationKind::GenerateVideo, pb::Facet::VideoGen),
		(OperationKind::Speak, pb::Facet::Speak),
		(OperationKind::Transcribe, pb::Facet::Transcribe),
		(OperationKind::Realtime, pb::Facet::Realtime),
		(OperationKind::Search, pb::Facet::Search),
	]
	.into_iter()
	.filter_map(|(operation, facet)| {
		model
			.capabilities
			.operations
			.contains_kind(operation)
			.then_some(facet as i32)
	})
	.collect()
}

fn rpc_request_id(prefix: &str) -> RequestId {
	use std::sync::atomic::{AtomicU64, Ordering};
	static NEXT: AtomicU64 = AtomicU64::new(1);
	RequestId::from(format!("{prefix}-{}", NEXT.fetch_add(1, Ordering::Relaxed)))
}

fn capability_status(error: Error, model: &str, operation: OperationKind) -> Status {
	if matches!(error.kind, ErrorKind::CapabilityMismatch | ErrorKind::CapabilityUnknown) {
		return Status::failed_precondition(format!(
			"model `{model}` lacks required capability `{operation}`"
		));
	}
	inference_status(error)
}

fn inference_status(error: Error) -> Status {
	let request = error
		.request_id
		.as_ref()
		.map_or("<unassigned>", |request| request.as_str());
	let message = format!("{:?} during {:?} (request {request})", error.kind, error.phase);
	match error.kind {
		ErrorKind::Cancelled => Status::cancelled(message),
		ErrorKind::DeadlineExceeded => Status::deadline_exceeded(message),
		ErrorKind::InvalidRequest
		| ErrorKind::PayloadRejected
		| ErrorKind::CodecMismatch
		| ErrorKind::CapabilityMismatch
		| ErrorKind::NativeRequestRejected => Status::invalid_argument(message),
		ErrorKind::TargetNotFound => Status::not_found(message),
		ErrorKind::Authentication => Status::unauthenticated(message),
		ErrorKind::Authorization | ErrorKind::AccountDisabled | ErrorKind::PaymentRequired => {
			Status::permission_denied(message)
		},
		ErrorKind::RateLimited
		| ErrorKind::QuotaExhausted
		| ErrorKind::BudgetExhausted
		| ErrorKind::ResourceExhausted => Status::resource_exhausted(message),
		ErrorKind::SessionConflict | ErrorKind::StalePlan => Status::aborted(message),
		ErrorKind::RouteUnavailable
		| ErrorKind::LocalModelUnavailable
		| ErrorKind::CapabilityUnknown
		| ErrorKind::CredentialStorageUnavailable => Status::failed_precondition(message),
		_ => Status::internal(message),
	}
}
fn inference_turn_error(error: Error) -> pb::TurnEvent {
	let kind = match error.kind {
		ErrorKind::Authentication
		| ErrorKind::CredentialStorageUnavailable
		| ErrorKind::Authorization
		| ErrorKind::AccountDisabled
		| ErrorKind::PaymentRequired => turn_error::Kind::Auth,
		ErrorKind::RateLimited | ErrorKind::QuotaExhausted => turn_error::Kind::RateLimited,
		ErrorKind::BudgetExhausted | ErrorKind::ResourceExhausted => turn_error::Kind::Overloaded,
		ErrorKind::EmptyOutput | ErrorKind::EmptyCompletion => turn_error::Kind::EmptyOutput,
		ErrorKind::ContextOverflow => turn_error::Kind::ContextOverflow,
		ErrorKind::PayloadRejected => turn_error::Kind::PayloadRejected,
		_ => turn_error::Kind::Upstream,
	};
	let detail = if error.kind == ErrorKind::Authentication {
		let mut detail = error.provider.as_ref().map_or_else(
			|| {
				"Authentication failed. Use `/login <provider>` in chat or run `omp auth login \
				 <provider>`."
					.to_owned()
			},
			|provider| {
				format!(
					"Authentication failed for provider `{provider}`. Use `/login {provider}` in chat \
					 or run `omp auth login {provider}`."
				)
			},
		);
		if let Some(ErrorDetail::Provider { sanitized_message }) = error.detail_ref()
			&& !sanitized_message.trim().is_empty()
		{
			detail.push_str(" Provider detail: ");
			detail.push_str(sanitized_message.as_str());
		}
		detail
	} else {
		use std::fmt::Write as _;
		let mut detail = format!("{:?} during {:?}", error.kind, error.phase);
		if let Some(code) = &error.code {
			let _ = write!(detail, " ({code})");
		}
		if let Some(status) = error.status {
			let _ = write!(detail, " [http {status}]");
		}
		if let Some(evidence) = error.detail_ref() {
			let _ = write!(detail, ": {evidence}");
		}
		if error.kind == ErrorKind::RouteUnavailable
			&& let Some(source) = std::error::Error::source(&error)
			&& let Some(projector) = source.downcast_ref::<CatalogDiscoveryProjectorError>()
		{
			let _ = write!(detail, " (source: {projector})");
		}
		detail
	};
	let retry_after_ms = match error.action {
		RetryAction::SameRoute { after } | RetryAction::SameRouteLimited { after, .. } => {
			after.as_millis().try_into().unwrap_or(u64::MAX)
		},
		_ => 0,
	};
	let diagnostics = if kind == turn_error::Kind::EmptyOutput {
		vec![empty_stop_diagnostic(&error)]
	} else {
		Vec::new()
	};
	pb::TurnEvent {
		event: Some(turn_event::Event::Error(pb::TurnError {
			kind: kind as i32,
			detail,
			actual: None,
			unsupported: Vec::new(),
			retry_after_ms,
			diagnostics,
			error_id: None,
		})),
	}
}

/// Projects the gateway's empty-completion classification into one stable
/// diagnostic so the session loop can choose an honest retry-cap message.
///
/// Billed-output evidence uses the final attempt only: earlier hidden
/// attempts bill their own tokens without saying anything about why the last
/// stop was empty. [`Usage::output_tokens`] already excludes separately
/// reported reasoning tokens, so known reasoning-only billing keeps the
/// context hint instead of alleging dropped content.
fn empty_stop_diagnostic(error: &Error) -> pb::Diagnostic {
	let receipt = error.receipt();
	let last_attempt = receipt.attempts.last();
	let billed = last_attempt.map_or(0, |attempt| attempt.usage.output_tokens);
	// The final empty-output recovery record carries the stream classification
	// as `empty-completion/<wire-policy>/<kind>`; only a truly block-free stop
	// (`no-content`) can prove content was dropped downstream.
	let zero_block = receipt
		.recoveries
		.iter()
		.rev()
		.find(|recovery| recovery.kind == RecoveryKind::EmptyOutput)
		.is_some_and(|recovery| recovery.rule.0.as_str().ends_with("/no-content"));
	let (code, detail) = if error.kind == ErrorKind::EmptyOutput {
		(empty_stop::NO_FINAL_OUTPUT, String::new())
	} else if zero_block && billed > 0 {
		(empty_stop::BILLED_OUTPUT, billed.to_string())
	} else {
		(empty_stop::EMPTY, String::new())
	};
	pb::Diagnostic {
		provider: error
			.provider
			.as_deref()
			.map_or_else(String::new, |provider| provider.as_str().to_owned()),
		model: receipt
			.plan
			.model
			.as_ref()
			.map_or_else(String::new, |model| model.as_str().to_owned()),
		attempt: last_attempt.map_or(0, |attempt| attempt.index.saturating_add(1)),
		code: code.to_owned(),
		detail,
		retryability: pb::Retryability::Never as i32,
	}
}

fn conversation_status(error: ConversationError) -> Status {
	match error {
		ConversationError::RevisionConflict { .. } | ConversationError::TurnConflict(_) => {
			Status::aborted(error.to_string())
		},
		ConversationError::UnknownConversation(_) | ConversationError::UnknownRevision(_) => {
			Status::not_found(error.to_string())
		},
		_ => Status::internal(error.to_string()),
	}
}

fn validate_revision(context: &pb::ContextRef, actual: u64) -> Result<(), Status> {
	let expected = context
		.expected
		.as_ref()
		.ok_or_else(|| Status::invalid_argument("ContextRef.expected is required"))?;
	if expected.head != actual
		|| expected.token.as_ref() != revision_token(&context.context_id, actual).as_slice()
	{
		return Err(Status::aborted(format!(
			"context revision conflict: expected {}, actual {actual}",
			expected.head
		)));
	}
	Ok(())
}

fn revision(context: &str, head: u64) -> thread_pb::Revision {
	thread_pb::Revision { head, token: revision_token(context, head).into() }
}

fn revision_token(context: &str, head: u64) -> Vec<u8> {
	let mut token = Vec::with_capacity(context.len() + 8);
	token.extend_from_slice(context.as_bytes());
	token.extend_from_slice(&head.to_be_bytes());
	token
}

/// Exercises the same canonical history and live-definition projection used by
/// [`InferenceRpc::turn`] without opening a transport.
#[doc(hidden)]
pub fn project_provider_turn_for_test(
	thread: &thread_pb::Thread,
	params: &pb::ChatParams,
	tool_registry: &ToolRegistry,
) -> Result<(thread_pb::Thread, omp_ai::call::ChatRequest), Status> {
	let projected = project_thread_history(thread, tool_registry, &RPC_HISTORY_CAPS_BASE)
		.map_err(|error| Status::invalid_argument(error.to_string()))?;
	let request = chat_request(thread_messages(&projected)?, params, tool_registry)?;
	Ok((projected, request))
}

fn thread_messages(thread: &thread_pb::Thread) -> Result<Vec<Message>, Status> {
	items_messages(&thread.items)
}

/// Projects thread items into canonical messages, exactly one per item.
///
/// The 1:1 mapping is load-bearing: context revisions (`Revision.head`,
/// `truncate_to`, `provider_heads`) count items, and the context store indexes
/// its retained message list by those heads. Wire-shape concerns (merging one
/// assistant turn's parallel tool calls into a single provider message) belong
/// to the codecs, never to this projection.
fn items_messages(items: &[thread_pb::Item]) -> Result<Vec<Message>, Status> {
	Message::from_thread_items(items).map_err(|error| Status::invalid_argument(error.to_string()))
}

fn media_input(blob: &thread_pb::Blob) -> Result<MediaInput, Status> {
	call::media_from_thread(blob).map_err(|error| Status::invalid_argument(error.to_string()))
}

fn opaque_json(bytes: &[u8], field: &'static str) -> Result<OpaqueJson, Status> {
	serde_json::from_slice(bytes)
		.map(OpaqueJson::new)
		.map_err(|error| Status::invalid_argument(format!("{field} is invalid JSON: {error}")))
}

fn tool_definition(tool: &pb::ToolDef) -> Result<ToolDefinition, Status> {
	if tool.name.is_empty() {
		return Err(Status::invalid_argument("ToolDef.name is required"));
	}
	let input = match tool.input.as_ref() {
		Some(tool_def::Input::JsonSchema(schema)) => ToolInputConstraint::JsonSchema {
			parameters: opaque_json(&schema.schema_json, "ToolDef.json_schema.schema_json")?,
			strict:     schema.strict.unwrap_or(false),
		},
		Some(tool_def::Input::Grammar(grammar)) => {
			let syntax = match grammar::Syntax::try_from(grammar.syntax) {
				Ok(grammar::Syntax::Lark) => ToolGrammarSyntax::Lark,
				Ok(grammar::Syntax::Regex) => ToolGrammarSyntax::Regex,
				Ok(grammar::Syntax::Ebnf) => ToolGrammarSyntax::Ebnf,
				Ok(grammar::Syntax::Unspecified) | Err(_) => {
					return Err(Status::invalid_argument(
						"ToolDef.grammar.syntax must be LARK, REGEX, or EBNF",
					));
				},
			};
			ToolInputConstraint::Grammar {
				grammar:  ToolGrammar { syntax, definition: grammar.definition.as_str().into() },
				fallback: opaque_json(
					&grammar.fallback_schema_json,
					"ToolDef.grammar.fallback_schema_json",
				)?,
			}
		},
		None => return Err(Status::invalid_argument("ToolDef.input is required")),
	};
	Ok(ToolDefinition {
		name: tool.name.as_str().into(),
		description: (!tool.description.is_empty()).then(|| tool.description.as_str().into()),
		input,
	})
}

/// Lowers proto chat parameters into a canonical [`ChatRequest`].
///
/// `params.tools` is the explicit tool selection: named tools resolve to their
/// live registry definitions, and an empty list advertises no tools at all.
/// The registry projection preserves every canonical input constraint; caller
/// bodies never replace the live executable declarations. Callers such as
/// tool-incapable models and the eval completion bridge rely on an empty list
/// meaning "none", never "everything".
fn chat_request(
	messages: Vec<Message>,
	params: &pb::ChatParams,
	tool_registry: &ToolRegistry,
) -> Result<omp_ai::call::ChatRequest, Status> {
	if let Some(tool) = params
		.tools
		.iter()
		.find(|tool| tool_registry.live_identity(&tool.name).is_none())
	{
		return Err(Status::failed_precondition(format!(
			"executable harness tool `{}` has no live registry identity",
			tool.name
		)));
	}
	let tools: Vec<ToolDefinition> = if params.tools.is_empty() {
		Vec::new()
	} else {
		// Selected advertisement keeps caller-requested hidden slots (`think`
		// under external thinking, subagent `yield`) that plain `advertise`
		// would drop.
		let selected = params
			.tools
			.iter()
			.map(|tool| Str::new(tool.name.as_str()))
			.collect::<Vec<_>>();
		tool_registry
			.advertise_selected(
				LoweringCaps {
					strict_schema:  true,
					grammar:        GrammarBits::ALL,
					maximum_tools:  None,
					maximum_strict: None,
				},
				&selected,
			)
			.map_err(|error| Status::failed_precondition(error.to_string()))?
			.into_iter()
			.map(|tool| tool.definition)
			.collect()
	};
	let tool_choice = params
		.tool_choice
		.as_ref()
		.map_or(Ok(Setting::Unset), |choice| {
			let choice = match tool_choice::Mode::try_from(choice.mode)
				.unwrap_or(tool_choice::Mode::Unspecified)
			{
				tool_choice::Mode::Unspecified | tool_choice::Mode::Auto => ToolChoice::Auto,
				tool_choice::Mode::None => ToolChoice::Disabled,
				tool_choice::Mode::Required => ToolChoice::Required,
				tool_choice::Mode::Named if !choice.name.is_empty() => {
					ToolChoice::Named(choice.name.as_str().into())
				},
				tool_choice::Mode::Named => {
					return Err(Status::invalid_argument("named tool choice requires a name"));
				},
			};
			Ok(Setting::Require(choice))
		})?;
	let sampling = params
		.sampling
		.as_ref()
		.map_or_else(Sampling::default, |sampling| Sampling {
			min_p:              None,
			repetition_penalty: None,
			temperature:        sampling.temperature.map(|value| value as f32),
			top_p:              sampling.top_p.map(|value| value as f32),
			top_k:              sampling.top_k,
			seed:               None,
			stop:               sampling
				.stop
				.iter()
				.map(|value| Str::from(value.as_str()))
				.collect::<Vec<_>>()
				.into(),
			presence_penalty:   sampling.presence_penalty.map(|value| value as f32),
			frequency_penalty:  sampling.frequency_penalty.map(|value| value as f32),
		});
	Ok(omp_ai::call::ChatRequest {
		messages: messages.into(),
		tools: tools.into(),
		hosted_tools: Arc::from([]),
		tool_choice,
		output: Setting::Unset,
		reasoning: Setting::Unset,
		verbosity: Setting::Unset,
		cache_retention: Setting::Unset,
		service_tier: Setting::Unset,
		sampling,
		max_output_tokens: params
			.sampling
			.as_ref()
			.and_then(|sampling| sampling.max_output_tokens),
		top_logprobs: None,
		safety: Arc::from([]),
		negotiation: NegotiationPolicy::default(),
		forced_call: None,
	})
}

fn configured_search_providers(name: &str) -> Vec<ProviderId> {
	let names: &[&str] = match name {
		"perplexity" => {
			&["perplexity-cookie", "perplexity", "perplexity-openrouter", "perplexity-anonymous"]
		},
		"public" => &["startpage", "google-search", "duckduckgo", "ecosia", "mojeek"],
		_ => &[omp_ai::search_settings::catalog_provider_name(name)],
	};
	names.iter().map(|name| ProviderId::from(*name)).collect()
}

fn proto_usage(usage: Usage) -> pb::Usage {
	pb::Usage {
		input_tokens:       usage.input_tokens,
		output_tokens:      usage.output_tokens,
		cache_read_tokens:  usage.cache_read_tokens,
		cache_write_tokens: usage.cache_write_tokens,
		accuracy:           match usage.source {
			UsageSource::Provider | UsageSource::Measured => usage::Accuracy::Exact,
			UsageSource::Estimated => usage::Accuracy::Estimated,
			UsageSource::Mixed => usage::Accuracy::Mixed,
			UsageSource::Unknown => usage::Accuracy::Unspecified,
		} as i32,
		detail:             None,
		total_tokens:       Some(usage.total_tokens()),
		context_tokens:     None,
		orchestration:      None,
		premium_requests:   None,
		reasoning_tokens:   Some(usage.reasoning_tokens),
		cache_ttl:          None,
		server_tools:       (usage.search_calls != 0).then(|| pb::ServerToolUsage {
			web_search_requests: Some(u64::from(usage.search_calls)),
			web_fetch_requests:  None,
		}),
	}
}

fn tokenizer_provenance(
	provenance: omp_ai::answer::TokenizerProvenance,
) -> pb::TokenizerProvenance {
	pb::TokenizerProvenance {
		tokenizer: provenance.tokenizer.as_str().to_owned(),
		revision:  provenance.revision.as_str().to_owned(),
		exact:     provenance.exact,
	}
}

fn proto_cost(cost: Cost) -> pb::Cost {
	pb::Cost {
		nanos_usd:             cost
			.micro_usd
			.max(0)
			.saturating_mul(1_000)
			.try_into()
			.unwrap_or(u64::MAX),
		estimated:             false,
		input_nanos_usd:       None,
		output_nanos_usd:      None,
		cache_read_nanos_usd:  None,
		cache_write_nanos_usd: None,
	}
}

fn tool_revision_props(registry: &ToolRegistry, name: &str) -> Option<pb::ValueMap> {
	let (_, revision) = registry.live_identity(name)?;
	Some(pb::ValueMap {
		fields: BTreeMap::from([(TOOL_REV_PROP.to_owned(), pb::Value {
			kind: Some(value::Kind::String(revision.to_string())),
		})]),
	})
}

fn build_turn_outcome(
	projection: &TurnProjection,
	completion: &Completion,
	context_id: Option<&str>,
	committed_len: usize,
	resolved_provider: Option<&str>,
	resolved_model: Option<&str>,
) -> pb::Outcome {
	let mut output = projection.output.clone();
	let parts = projection
		.message_parts
		.iter()
		.filter(|part| !part.text.is_empty())
		.map(|part| thread_pb::Part {
			kind: Some(if part.thinking {
				part::Kind::Thinking(thread_pb::Thinking {
					text:      part.text.clone(),
					signature: Bytes::new(),
					redacted:  false,
				})
			} else {
				part::Kind::Text(part.text.clone())
			}),
		})
		.collect::<Vec<_>>();
	if !parts.is_empty() {
		output.insert(0, thread_pb::Item {
			seq:           0,
			created_at_ms: 0,
			kind:          Some(item::Kind::Message(thread_pb::Message {
				role: thread_pb::Role::Assistant as i32,
				parts,
				..Default::default()
			})),
			props:         None,
		});
	}
	let mut head = u64::try_from(committed_len).unwrap_or(u64::MAX);
	for item in &mut output {
		head = head.saturating_add(1);
		item.seq = head;
	}
	let provider = resolved_provider
		.or_else(|| {
			completion
				.receipt
				.plan
				.provider
				.as_ref()
				.map(|value| value.as_str())
		})
		.unwrap_or_default()
		.to_owned();
	let model = resolved_model
		.or_else(|| {
			completion
				.receipt
				.plan
				.model
				.as_ref()
				.map(|value| value.as_str())
		})
		.unwrap_or_default()
		.to_owned();
	let diagnostics = completion
		.receipt
		.recoveries
		.iter()
		.map(|recovery| pb::Diagnostic {
			provider:     provider.clone(),
			model:        model.clone(),
			attempt:      recovery.attempt,
			code:         recovery.kind.as_str().to_owned(),
			detail:       recovery.rule.0.as_str().to_owned(),
			retryability: pb::Retryability::Unspecified as i32,
		})
		.collect();
	pb::Outcome {
		output,
		stop: match &completion.reason {
			FinishReason::Stop | FinishReason::Other(_) => 1,
			FinishReason::Length => 3,
			FinishReason::ToolCalls => 2,
			FinishReason::ContentFilter => 4,
			FinishReason::Cancelled => 0,
		},
		usage: Some(proto_usage(completion.usage)),
		cost: Some(proto_cost(completion.receipt.cost)),
		unsupported: Vec::new(),
		revision: context_id.map(|context| revision(context, head)),
		provider,
		model,
		diagnostics,
		upstream_provider: None,
		duration_ms: Some(
			completion
				.receipt
				.timings
				.total
				.as_millis()
				.try_into()
				.unwrap_or(u64::MAX),
		),
		ttft_ms: completion
			.receipt
			.timings
			.first_frame
			.map(|value| value.as_millis().try_into().unwrap_or(u64::MAX)),
		context_snapshot: Some(pb::ContextSnapshot {
			prompt_tokens:                  completion.usage.input_tokens,
			non_message_tokens:             0,
			history_rewrite_tokens_removed: None,
			last_message_timestamp_ms:      None,
			system_tokens:                  completion
				.receipt
				.context
				.as_ref()
				.and_then(|value| value.system_tokens),
			message_tokens:                 completion
				.receipt
				.context
				.as_ref()
				.and_then(|value| value.message_tokens),
			skill_tokens:                   completion
				.receipt
				.context
				.as_ref()
				.and_then(|value| value.skill_tokens),
			tool_tokens:                    completion
				.receipt
				.context
				.as_ref()
				.and_then(|value| value.tool_tokens),
			buffer_tokens:                  completion
				.receipt
				.context
				.as_ref()
				.and_then(|value| value.buffer_tokens),
			unclassified_tokens:            None,
			window_tokens:                  completion
				.receipt
				.context
				.as_ref()
				.and_then(|value| value.window_tokens),
			slack_tokens:                   None,
			snapcompact_savings:            completion
				.receipt
				.context
				.as_ref()
				.and_then(|value| value.snapcompact_savings),
			prompt_anchor:                  completion
				.receipt
				.context
				.as_ref()
				.and_then(|value| value.prompt_anchor),
			context_revision:               completion
				.receipt
				.context
				.as_ref()
				.and_then(|value| value.context_revision),
			compaction_epoch:               completion
				.receipt
				.context
				.as_ref()
				.and_then(|value| value.compaction_epoch),
		}),
		props: None,
	}
}

fn turn_replay_events(
	replay: TurnReplay,
	request: &pb::TurnRequest,
) -> Result<impl Stream<Item = Result<pb::TurnEvent, Status>> + Send + 'static, Status> {
	let stored_request = pb::TurnRequest::decode(replay.request)
		.map_err(|_| Status::internal("stored turn request is corrupt"))?;
	if stored_request != *request {
		return Err(Status::already_exists(
			"turn_id already committed with a different opening request",
		));
	}
	let outcome = pb::Outcome::decode(replay.outcome)
		.map_err(|_| Status::internal("stored turn outcome is corrupt"))?;
	Ok(stream::iter([
		Ok(pb::TurnEvent { event: Some(turn_event::Event::Accepted(pb::Accepted { replay: true })) }),
		Ok(pb::TurnEvent { event: Some(turn_event::Event::Outcome(outcome)) }),
	]))
}

#[derive(Clone)]
struct PendingInvocation {
	kind:       WorkflowResponseKind,
	deadline:   Option<Instant>,
	tool_call:  Option<thread_pb::ToolCall>,
	tool_props: Option<pb::ValueMap>,
}

#[expect(clippy::large_enum_variant, reason = "keeps per-frame dispatch allocation-free")]
enum TurnMux {
	Event(Option<Result<ChatEvent, Error>>),
	Frame(Result<Option<pb::TurnFrame>, Status>),
	Timeout(String),
}
async fn route_live_turn_frame(
	frame: pb::TurnFrame,
	control: Option<&ChatControl>,
	test_live_responses: Option<&flume::Sender<WorkflowResponse>>,
	pending: &mut BTreeMap<String, PendingInvocation>,
	projection: &Arc<Mutex<TurnProjection>>,
) -> Result<(), Status> {
	let mut completion_result = None;
	let response = match frame.frame {
		Some(turn_frame::Frame::Input(input)) if !input.invocation_id.is_empty() => {
			let Some(invocation) = pending.get(&input.invocation_id) else {
				return Err(Status::invalid_argument("unknown or late invocation_id"));
			};
			if invocation.kind != WorkflowResponseKind::Invoke {
				return Err(Status::invalid_argument(
					"provider action does not accept incremental invocation input",
				));
			}
			WorkflowResponse::InvokeInput(InvokeInput {
				invocation: Str::from(input.invocation_id.as_str()),
				payload:    Bytes::from(input.encode_to_vec()),
			})
		},
		Some(turn_frame::Frame::Complete(complete)) if !complete.invocation_id.is_empty() => {
			let Some(invocation) = pending.get(&complete.invocation_id).cloned() else {
				return Err(Status::invalid_argument("unknown or late invocation_id"));
			};
			if let (Some(call), Some(result)) =
				(invocation.tool_call.as_ref(), complete.tool_result.as_ref())
				&& !result.call_id.is_empty()
				&& result.call_id != call.id
			{
				return Err(Status::invalid_argument(
					"tool_result.call_id does not match invocation tool_call",
				));
			}
			completion_result.clone_from(&complete.tool_result);
			match invocation.kind {
				WorkflowResponseKind::Action => {
					let (response, is_error) = workflow_action_result(&complete)?;
					WorkflowResponse::WorkflowActionResponse(WorkflowActionResponse {
						invocation: Str::from(complete.invocation_id.as_str()),
						response,
						is_error,
					})
				},
				WorkflowResponseKind::Invoke => WorkflowResponse::InvokeComplete(InvokeComplete {
					invocation: Str::from(complete.invocation_id.as_str()),
					payload:    Bytes::from(complete.encode_to_vec()),
				}),
			}
		},
		Some(turn_frame::Frame::Open(_)) => {
			return Err(Status::invalid_argument("Turn open frame may only appear first"));
		},
		Some(_) => return Err(Status::invalid_argument("invocation_id is required")),
		None => return Err(Status::invalid_argument("Turn frame body is required")),
	};
	let terminal = response.is_terminal();
	let invocation_id = response.invocation().as_str().to_owned();
	if let Some(control) = control {
		control
			.submit(response)
			.await
			.map_err(|error| match error {
				ChatControlError::DeadlineExceeded => {
					Status::deadline_exceeded("invoke deadline exceeded")
				},
				ChatControlError::UnknownInvocation => {
					Status::invalid_argument("unknown or late invocation_id")
				},
				ChatControlError::Closed => {
					Status::failed_precondition("live invocation path is closed")
				},
			})?;
	} else if let Some(responses) = test_live_responses {
		responses
			.send_async(response)
			.await
			.map_err(|_| Status::failed_precondition("test live invocation observer closed"))?;
	} else {
		return Err(Status::failed_precondition(
			"selected provider does not accept live invocation responses",
		));
	}
	if terminal
		&& let Some(invocation) = pending.remove(&invocation_id)
		&& let (Some(call), Some(result)) = (invocation.tool_call, completion_result)
	{
		let mut projection = projection.lock();
		projection.output.push(thread_pb::Item {
			seq:           0,
			created_at_ms: 0,
			kind:          Some(item::Kind::ToolCall(call)),
			props:         invocation.tool_props,
		});
		projection.output.push(thread_pb::Item {
			seq:           0,
			created_at_ms: 0,
			kind:          Some(item::Kind::ToolResult(result)),
			props:         None,
		});
	}
	Ok(())
}

fn workflow_action_result(complete: &pb::InvokeComplete) -> Result<(Bytes, bool), Status> {
	if let Some(result) = complete.tool_result.as_ref() {
		let mut text = String::new();
		for part in &result.parts {
			match part.kind.as_ref() {
				Some(part::Kind::Text(part)) => text.push_str(part),
				_ => {
					return Err(Status::invalid_argument(
						"workflow action results accept text parts only",
					));
				},
			}
		}
		return Ok((Bytes::from(text), result.is_error));
	}
	if !complete.vendor.is_empty() {
		let is_error = complete
			.status
			.as_ref()
			.is_some_and(|status| status.outcome() != exec_status::Outcome::Exited);
		return Ok((complete.vendor.clone(), is_error));
	}
	Err(Status::invalid_argument(
		"workflow action completion requires tool_result or vendor payload",
	))
}

fn turn_recovery_event(
	status: &Status,
	input: Option<&turn_request::Input>,
	contexts: &Mutex<BTreeMap<String, RpcContext>>,
) -> Option<pb::TurnEvent> {
	let kind = match status.code() {
		tonic::Code::Aborted => turn_error::Kind::Conflict,
		tonic::Code::NotFound => turn_error::Kind::NeedFull,
		_ => return None,
	};
	let context_id = match input {
		Some(turn_request::Input::Seed(seed)) => Some(seed.context_id.as_str()),
		Some(turn_request::Input::Incremental(incremental)) => incremental
			.context
			.as_ref()
			.map(|context| context.context_id.as_str()),
		None => None,
	};
	let actual = (kind == turn_error::Kind::Conflict)
		.then(|| {
			let context_id = context_id?;
			let held = contexts.lock();
			let context = held.get(context_id)?;
			Some(revision(context_id, context.revision))
		})
		.flatten();
	Some(pb::TurnEvent {
		event: Some(turn_event::Event::Error(pb::TurnError {
			kind: kind as i32,
			detail: status.message().to_owned(),
			actual,
			unsupported: Vec::new(),
			retry_after_ms: 0,
			diagnostics: Vec::new(),
			error_id: None,
		})),
	})
}
fn invoke_timeout(invocation_id: &str) -> pb::TurnEvent {
	pb::TurnEvent {
		event: Some(turn_event::Event::Error(pb::TurnError {
			kind:           turn_error::Kind::InvokeTimeout as i32,
			detail:         format!("invocation {invocation_id} exceeded its completion deadline"),
			actual:         None,
			unsupported:    Vec::new(),
			retry_after_ms: 0,
			diagnostics:    Vec::new(),
			error_id:       None,
		})),
	}
}

fn turn_events(
	mut events: ChatStream,
	mut incoming: tonic::Streaming<pb::TurnFrame>,
	contexts: Arc<Mutex<BTreeMap<String, RpcContext>>>,
	sessions: ConversationSessionPlanner,
	mut resolved: ResolvedTurn,
	turn: ProviderTurnId,
	request_bytes: Bytes,
	projection: Arc<Mutex<TurnProjection>>,
	tool_registry: Arc<ToolRegistry>,
	test_live_responses: Option<flume::Sender<WorkflowResponse>>,
) -> impl Stream<Item = Result<pb::TurnEvent, Status>> + Send + 'static {
	let control = events.control();
	async_stream::try_stream! {
		yield pb::TurnEvent {
			event: Some(turn_event::Event::Accepted(pb::Accepted { replay: false })),
		};
		let mut pending = BTreeMap::<String, PendingInvocation>::new();
		let mut incoming_open = true;
		// Index of the currently streaming text/thinking part. Providers close
		// these blocks implicitly (next block start or stream completion), so
		// the projection owes consumers an explicit `PartEnd`.
		let mut open_part: Option<u32> = None;
		loop {
			let event = loop {
				let next_timeout = pending
					.iter()
					.filter_map(|(id, invocation)| invocation.deadline.map(|deadline| (id.clone(), deadline)))
					.min_by_key(|(_, deadline)| *deadline);
				let mux = tokio::select! {
					event = events.next(), if pending.is_empty() || test_live_responses.is_none() => TurnMux::Event(event),
					frame = incoming.message(), if incoming_open => TurnMux::Frame(frame),
					invocation_id = async {
						match next_timeout {
							Some((invocation_id, deadline)) => {
								tokio::time::sleep_until(deadline.into()).await;
								invocation_id
							},
							None => std::future::pending().await,
						}
					} => TurnMux::Timeout(invocation_id),
				};
				match mux {
					TurnMux::Event(event) => break event,
					TurnMux::Frame(frame) => match frame? {
						Some(frame) => {
							let frame_id = match frame.frame.as_ref() {
								Some(turn_frame::Frame::Input(input)) => input.invocation_id.clone(),
								Some(turn_frame::Frame::Complete(complete)) => complete.invocation_id.clone(),
								_ => String::new(),
							};
							if let Err(status) = route_live_turn_frame(
								frame,
								control.as_ref(),
								test_live_responses.as_ref(),
								&mut pending,
								&projection,
							).await {
								if status.code() == tonic::Code::DeadlineExceeded {
									yield invoke_timeout(&frame_id);
									return;
								}
								Err(status)?;
							}
						},
						None => incoming_open = false,
					},
					TurnMux::Timeout(invocation_id) => {
						yield invoke_timeout(&invocation_id);
						return;
					},
				}
			};
			let Some(event) = event else { break };
			let event = match event {
				Ok(event) => event,
				Err(error) if !pending.is_empty() && error.kind == ErrorKind::DeadlineExceeded => {
					let invocation_id = pending.keys().next().expect("pending invocation").clone();
					yield invoke_timeout(&invocation_id);
					return;
				},
				Err(error) => {
					yield inference_turn_error(error);
					return;
				},
			};
			match event {
				ChatEvent::Started(meta) => {
					let mut route = resolved.resolved_route.lock();
					route.provider = Some(meta.provider);
					route.model = meta.model;
				},
				ChatEvent::BlockStarted { index, kind } => {
					let kind = match kind {
						BlockKind::Text => part_start::Kind::Text,
						BlockKind::Thinking => part_start::Kind::Thinking,
						BlockKind::ToolCall => continue,
						BlockKind::Artifact => {
							Err(Status::failed_precondition(
								"chat artifacts must be staged before RPC projection",
							))?
						},
					};
					if open_part.is_some_and(|open| open != index)
						&& let Some(open) = open_part.take()
					{
						yield pb::TurnEvent {
							event: Some(turn_event::Event::PartEnd(pb::PartEnd {
								index:     open,
								signature: Bytes::new(),
							})),
						};
					}
					open_part = Some(index);
					yield pb::TurnEvent {
						event: Some(turn_event::Event::PartStart(pb::PartStart {
							index,
							kind: kind as i32,
							tool_call_id: String::new(),
							tool_name: String::new(),
						})),
					};
				},
				ChatEvent::TextDelta { index, text } => {
					projection.lock().append_part(index, false, text.as_str());
					yield pb::TurnEvent {
						event: Some(turn_event::Event::PartDelta(pb::PartDelta {
							index,
							chunk: Bytes::copy_from_slice(text.as_bytes()),
						})),
					};
				},
				ChatEvent::ThinkingDelta { index, text } => {
					projection.lock().append_part(index, true, text.as_str());
					yield pb::TurnEvent {
						event: Some(turn_event::Event::PartDelta(pb::PartDelta {
							index,
							chunk: Bytes::copy_from_slice(text.as_bytes()),
						})),
					};
				},
				ChatEvent::ToolCallStarted { index, id, name } => {
					if let Some(open) = open_part.take() {
						yield pb::TurnEvent {
							event: Some(turn_event::Event::PartEnd(pb::PartEnd {
								index:     open,
								signature: Bytes::new(),
							})),
						};
					}
					yield pb::TurnEvent {
						event: Some(turn_event::Event::PartStart(pb::PartStart {
							index,
							kind: part_start::Kind::ToolCall as i32,
							tool_call_id: id.as_str().to_owned(),
							tool_name: name.as_str().to_owned(),
						})),
					};
				},
				ChatEvent::ToolArgumentsDelta { index, bytes } => {
					yield pb::TurnEvent {
						event: Some(turn_event::Event::PartDelta(pb::PartDelta {
							index,
							chunk: bytes,
						})),
					};
				},
				ChatEvent::ToolCallReady { index, call } => {
					let arguments = serde_json::to_vec(call.arguments.as_value())
						.map_err(|error| Status::internal(format!("tool arguments serialization failed: {error}")))?;
					let props = tool_revision_props(tool_registry.as_ref(), call.name.as_str());
					projection.lock().output.push(thread_pb::Item {
						seq: 0,
						created_at_ms: 0,
						kind: Some(item::Kind::ToolCall(thread_pb::ToolCall {
							id: call.id.as_str().to_owned(),
							name: call.name.as_str().to_owned(),
							args_json: arguments.into(),
							thought_signature: Bytes::new(),
							intent: None,
							raw: None,
							custom_wire_name: None,
							provider_metadata: None,
						})),
						props,
					});
					yield pb::TurnEvent {
						event: Some(turn_event::Event::PartEnd(pb::PartEnd {
							index,
							signature: Bytes::new(),
						})),
					};
				},
				ChatEvent::Artifact { .. } => {
					Err(Status::failed_precondition(
						"chat artifacts must be staged before RPC projection",
					))?
				},
				ChatEvent::Usage(_) => {},
				ChatEvent::WorkflowAction(action) => {
					if control.is_none() && test_live_responses.is_none() {
						Err(Status::failed_precondition(
							"provider emitted a workflow action without a live response path",
						))?;
					}
					let invocation_id = action.invocation.as_str().to_owned();
					if pending.contains_key(&invocation_id) {
						Err(Status::failed_precondition("provider reused a live invocation_id"))?;
					}
					let deadline = action.timeout.map(|timeout| Instant::now() + timeout);
					let vendor = if action.call.is_none() { action.arguments.clone() } else { Default::default() };
					let tool_props = action
						.call
						.as_ref()
						.and_then(|_| tool_revision_props(tool_registry.as_ref(), action.name.as_str()));
					let tool_call = action.call.map(|call| thread_pb::ToolCall {
						id: call.as_str().to_owned(),
						name: action.name.as_str().to_owned(),
						args_json: action.arguments,
						thought_signature: Bytes::new(),
						intent: None,
						raw: None,
						custom_wire_name: None,
						provider_metadata: None,
					});
					pending.insert(
						invocation_id.clone(),
						PendingInvocation {
							kind: action.response_kind,
							deadline,
							tool_call: tool_call.clone(),
							tool_props,
						},
					);
					yield pb::TurnEvent {
						event: Some(turn_event::Event::Invoke(pb::Invoke {
							invocation_id,
							name: action.name.as_str().to_owned(),
							tool_call,
							vendor,
							timeout_ms: action.timeout.map_or(0, |value| value.as_millis().try_into().unwrap_or(u64::MAX)),
							props: None,
						})),
					};
				},
				ChatEvent::WorkflowResume(_) => {},
				ChatEvent::WorkflowCancelled { invocation } => {
					let invocation_id = invocation.as_str().to_owned();
					pending.remove(&invocation_id);
					yield pb::TurnEvent {
						event: Some(turn_event::Event::InvokeCancel(pb::InvokeCancel {
							invocation_id,
						})),
					};
				},
				ChatEvent::Completed(completion) => {
					if !pending.is_empty() {
						Err(Status::failed_precondition(
							"provider completed with live invocations outstanding",
						))?;
					}
					if let Some(open) = open_part.take() {
						yield pb::TurnEvent {
							event: Some(turn_event::Event::PartEnd(pb::PartEnd {
								index:     open,
								signature: Bytes::new(),
							})),
						};
					}
					let (route_provider, route_model) = {
						let route = resolved.resolved_route.lock();
						(route.provider.clone(), route.model.clone())
					};
					let outcome = build_turn_outcome(
						&projection.lock(),
						&completion,
						resolved.context_id.as_deref(),
						resolved.committed_messages.len(),
						route_provider.as_ref().map(|provider| provider.as_str()),
						route_model.as_ref().map(|model| model.as_str()),
					);
					let provider_revision = if let Some(conversation) =
						resolved.provider_conversation.as_ref()
					{
						Some(
							sessions
								.committed_turn(conversation, &turn)
								.map_err(conversation_status)?
								.ok_or_else(|| {
									Status::internal("completed provider turn has no committed revision")
								})?
								.revision()
								.to_owned(),
						)
					} else {
						None
					};
					let committed_context =
						if let (Some(context_id), Some(next_revision)) =
							(resolved.context_id.as_ref(), outcome.revision.as_ref())
						{
							let mut messages = resolved.committed_messages.clone();
							messages.extend(items_messages(&outcome.output)?);
							let head = next_revision.head;
							if let Some(provider_revision) = provider_revision.as_ref() {
								resolved.provider_heads.insert(head, provider_revision.to_owned());
							}
							Some((
								context_id.clone(),
								RpcContext {
									revision: head,
									messages,
									provider_conversation: resolved.provider_conversation.clone(),
									provider_revision,
									provider_heads: std::mem::take(&mut resolved.provider_heads),
								},
							))
						} else {
							None
						};
					if resolved.provider_session.is_none() {
						sessions
							.commit_turn_replay(
								turn.clone(),
								request_bytes.clone(),
								Bytes::from(outcome.encode_to_vec()),
							)
							.map_err(conversation_status)?;
					}
					if let Some((context_id, context)) = committed_context {
						contexts.lock().insert(context_id, context);
					}
					yield pb::TurnEvent {
						event: Some(turn_event::Event::Outcome(outcome)),
					};
				},
			}
		}
	}
}

fn image_events(
	mut events: omp_ai::answer::GenerationStream<ImageArtifact>,
) -> impl Stream<Item = Result<pb::ImageEvent, Status>> + Send + 'static {
	async_stream::try_stream! {
		let mut images = Vec::new();
		let mut revised_prompt = None::<String>;
		let mut preview_index = 0_u32;
		while let Some(event) = events.next().await {
			match event.map_err(inference_status)? {
				GenerationEvent::Queued { .. } | GenerationEvent::Progress { .. } => {},
				GenerationEvent::Preview(image) => {
					let blob = artifact_blob(image.artifact)?;
					yield pb::ImageEvent {
						event: Some(pb::image_event::Event::Partial(pb::image_event::Partial {
							index: preview_index,
							preview: Some(blob),
						})),
					};
					preview_index = preview_index.saturating_add(1);
				},
				GenerationEvent::Artifact(image) => {
					if revised_prompt.is_none() {
						revised_prompt = image.revised_prompt.map(|value| value.as_str().to_owned());
					}
					images.push(artifact_blob(image.artifact)?);
				},
				GenerationEvent::Completed(summary) => {
					yield pb::ImageEvent {
						event: Some(pb::image_event::Event::Done(pb::image_event::Done {
							images,
							revised_prompt: revised_prompt.unwrap_or_default(),
							text: String::new(),
							usage: Some(proto_usage(summary.usage)),
							cost: Some(proto_cost(summary.cost)),
							unsupported: Vec::new(),
							props: None,
						})),
					};
					break;
				},
			}
		}
	}
}

fn artifact_blob(artifact: Artifact) -> Result<thread_pb::Blob, Status> {
	let (hash, inline) = match artifact.body {
		ArtifactBody::Bytes(bytes) => (
			artifact
				.digest
				.map_or_else(Bytes::new, |digest| digest.value),
			bytes,
		),
		ArtifactBody::Stored(reference) => {
			(Bytes::copy_from_slice(reference.revision.as_bytes()), Bytes::new())
		},
		ArtifactBody::Stream(_) => {
			return Err(Status::failed_precondition(
				"streamed artifacts must be persisted before RPC projection",
			));
		},
	};
	Ok(thread_pb::Blob {
		hash,
		mime: artifact.media_type.as_str().to_owned(),
		size: artifact.size.unwrap_or(inline.len() as u64),
		inline,
		detail: blob::Detail::Original as i32,
	})
}

fn speak_event(chunk: AudioChunk) -> pb::SpeakEvent {
	if chunk.final_chunk {
		pb::SpeakEvent {
			event: Some(speak_event::Event::Done(pb::speak_event::Done {
				audio:       Some(thread_pb::Blob {
					hash:   Bytes::new(),
					mime:   String::new(),
					size:   chunk.bytes.len() as u64,
					inline: chunk.bytes,
					detail: blob::Detail::Original as i32,
				}),
				duration_ms: chunk.end_ms.unwrap_or_default(),
				usage:       None,
				cost:        None,
				unsupported: Vec::new(),
				props:       None,
			})),
		}
	} else {
		pb::SpeakEvent {
			event: Some(speak_event::Event::Chunk(pb::speak_event::Chunk {
				audio:            chunk.bytes,
				transcript_delta: String::new(),
			})),
		}
	}
}

fn search_response(answer: SearchResults) -> pb::SearchResponse {
	let omp_ai::answer::SearchResults { results, answer, usage, metadata } = answer;
	let projected_at = SystemTime::now();
	let engine = metadata
		.provider
		.as_ref()
		.map_or_else(String::new, |provider| provider.as_str().to_owned());
	pb::SearchResponse {
		engine,
		answer: answer.map_or_else(String::new, |answer| answer.as_str().to_owned()),
		sources: results
			.into_iter()
			.map(|result| search_response::Source {
				url:          result.url.as_str().to_owned(),
				title:        result.title.as_str().to_owned(),
				snippet:      result
					.snippet
					.map_or_else(String::new, |snippet| snippet.as_str().to_owned()),
				published_at: result.published_at.map_or_else(String::new, format_rfc3339),
				author:       result
					.author
					.map_or_else(String::new, |author| author.as_str().to_owned()),
				score:        result.score.map(f64::from),
				age_seconds:  result
					.published_at
					.and_then(|time| projected_at.duration_since(time).ok())
					.map_or(0, |age| age.as_secs()),
			})
			.collect(),
		citations: metadata
			.citations
			.into_iter()
			.map(|citation| pb::search_response::Citation {
				url:        citation.url.as_str().to_owned(),
				title:      citation
					.title
					.map_or_else(String::new, |title| title.as_str().to_owned()),
				cited_text: citation
					.cited_text
					.map_or_else(String::new, |text| text.as_str().to_owned()),
				start:      citation.start,
				end:        citation.end,
			})
			.collect(),
		search_queries: metadata
			.search_queries
			.into_iter()
			.map(String::from)
			.collect(),
		related: metadata
			.related_questions
			.into_iter()
			.map(String::from)
			.collect(),
		warnings: metadata.warnings.into_iter().map(String::from).collect(),
		usage: Some(proto_usage(usage)),
		cost: None,
		unsupported: Vec::new(),
		account: metadata
			.account
			.map_or_else(String::new, |account| account.as_str().to_owned()),
		auth_mode: metadata
			.auth_mode
			.map_or_else(String::new, |mode| mode.as_str().to_owned()),
		failures: metadata
			.failures
			.into_iter()
			.map(|failure| pb::search_response::Failure {
				provider: failure.provider.as_str().to_owned(),
				kind:     search_failure_kind(failure.kind) as i32,
				status:   failure.status.map(u32::from),
				code:     failure
					.code
					.map_or_else(String::new, |code| code.as_str().to_owned()),
			})
			.collect(),
		props: None,
	}
}

const fn search_failure_kind(kind: SearchFailureKind) -> failure::Kind {
	match kind {
		SearchFailureKind::Authentication => failure::Kind::Authentication,
		SearchFailureKind::Quota => failure::Kind::Quota,
		SearchFailureKind::ModelNotFound => failure::Kind::ModelNotFound,
		SearchFailureKind::Transport => failure::Kind::Transport,
		SearchFailureKind::Timeout => failure::Kind::Timeout,
		SearchFailureKind::Provider => failure::Kind::Provider,
	}
}
fn usage_response(report: UsageReport) -> pb::UsageResponse {
	pb::UsageResponse {
		provider:         report.provider.as_str().to_owned(),
		account:          report.account.as_str().to_owned(),
		principal:        report
			.principal
			.map_or_else(String::new, |value| value.as_str().to_owned()),
		plan:             report.plan.map(|value| value.as_str().to_owned()),
		account_metadata: Some(pb::usage_response::AccountMetadata {
			provider_account_id: report
				.account_meta
				.provider_account_id
				.map(|value| value.as_str().to_owned()),
			email:               report
				.account_meta
				.email
				.map(|value| value.as_str().to_owned()),
			project_id:          report
				.account_meta
				.project_id
				.map(|value| value.as_str().to_owned()),
			organization_id:     report
				.account_meta
				.organization_id
				.map(|value| value.as_str().to_owned()),
			organization_name:   report
				.account_meta
				.organization_name
				.map(|value| value.as_str().to_owned()),
		}),
		source_label:     report.source_label.map(|value| value.as_str().to_owned()),
		notes:            report
			.notes
			.into_vec()
			.into_iter()
			.map(|value| value.as_str().to_owned())
			.collect(),
		reset_credits:    report
			.reset_credits
			.map(|reset| pb::usage_response::ResetCredits {
				available: reset.available,
				credits:   reset
					.credits
					.into_vec()
					.into_iter()
					.map(|credit| reset_credits::Credit {
						granted_at_ms: credit.granted_at.map(system_time_ms),
						expires_at_ms: credit.expires_at.map(system_time_ms),
						status:        credit.status.map(|value| value.as_str().to_owned()),
					})
					.collect(),
			}),
		windows:          report
			.windows
			.into_iter()
			.map(|window| pb::usage_response::Window {
				kind: match window.kind {
					UsageWindowKind::RateLimit => window::Kind::RateLimit,
					UsageWindowKind::Quota => window::Kind::Quota,
					UsageWindowKind::Billing => window::Kind::Billing,
					UsageWindowKind::Balance => window::Kind::Balance,
				} as i32,
				dimension: window.dimension.as_str().to_owned(),
				consumed: window.amount.consumed.map(|value| value.units),
				remaining: window.amount.remaining.map(|value| value.units),
				limit: window.amount.limit.map(|value| value.units),
				resets_at_ms: window.resets_at.map(system_time_ms),
				accuracy: match window.source {
					UsageSource::Provider | UsageSource::Measured => usage::Accuracy::Exact,
					UsageSource::Estimated => usage::Accuracy::Estimated,
					UsageSource::Mixed => usage::Accuracy::Mixed,
					UsageSource::Unknown => usage::Accuracy::Unspecified,
				} as i32,
				observed_at_ms: system_time_ms(window.observed_at),
				id: window.id.as_str().to_owned(),
				label: window.label.map(|value| value.as_str().to_owned()),
				scope: window.scope.map(|value| value.as_str().to_owned()),
				unit: match window.amount.unit {
					UsageUnit::Percent => window::Unit::Percent,
					UsageUnit::Tokens => window::Unit::Tokens,
					UsageUnit::Requests => window::Unit::Requests,
					UsageUnit::Credits => window::Unit::Credits,
					UsageUnit::Usd => window::Unit::Usd,
					UsageUnit::Minutes => window::Unit::Minutes,
					UsageUnit::Bytes => window::Unit::Bytes,
					UsageUnit::Unknown => window::Unit::Unknown,
				} as i32,
				consumed_decimal_exponent: window
					.amount
					.consumed
					.map_or(0, |value| u32::from(value.decimal_exponent)),
				remaining_decimal_exponent: window
					.amount
					.remaining
					.map_or(0, |value| u32::from(value.decimal_exponent)),
				limit_decimal_exponent: window
					.amount
					.limit
					.map_or(0, |value| u32::from(value.decimal_exponent)),
				status: window.status.map(|status| match status {
					UsageStatus::Ok => window::Status::Ok,
					UsageStatus::Warning => window::Status::Warning,
					UsageStatus::Exhausted => window::Status::Exhausted,
					UsageStatus::Unknown => window::Status::Unknown,
				} as i32),
				duration_ms: window
					.duration
					.map(|value| value.as_millis().try_into().unwrap_or(u64::MAX)),
				reset_label: window.reset_label.map(|value| value.as_str().to_owned()),
				notes: window
					.notes
					.into_vec()
					.into_iter()
					.map(|value| value.as_str().to_owned())
					.collect(),
			})
			.collect(),
	}
}
fn realtime_audio_format(encoding: i32) -> Setting<call::AudioFormat> {
	match pb::AudioEncoding::try_from(encoding).unwrap_or(pb::AudioEncoding::Unspecified) {
		pb::AudioEncoding::Mp3 => Setting::Prefer(call::AudioFormat::Mp3),
		pb::AudioEncoding::Pcm16 => Setting::Prefer(call::AudioFormat::Pcm16),
		pb::AudioEncoding::Wav => Setting::Prefer(call::AudioFormat::Wav),
		pb::AudioEncoding::Opus => Setting::Prefer(call::AudioFormat::Opus),
		pb::AudioEncoding::Aac => Setting::Prefer(call::AudioFormat::Aac),
		pb::AudioEncoding::Flac => Setting::Prefer(call::AudioFormat::Flac),
		pb::AudioEncoding::Unspecified => Setting::Unset,
	}
}

fn realtime_input(frame: pb::RealtimeFrame) -> Result<RealtimeInput, Status> {
	match frame.frame {
		Some(realtime_frame::Frame::Audio(bytes)) => Ok(RealtimeInput::Audio(bytes)),
		Some(realtime_frame::Frame::Text(text)) => Ok(RealtimeInput::Text(text.into())),
		Some(realtime_frame::Frame::ToolResult(result)) => Ok(RealtimeInput::ToolResult {
			call:     ToolCallId::from(result.call_id.as_str()),
			name:     (!result.name.is_empty()).then(|| result.name.as_str().into()),
			content:  result
				.parts
				.iter()
				.map(ToolResultContent::from_thread_part)
				.collect::<Result<Vec<_>, _>>()
				.map_err(|error| Status::invalid_argument(error.to_string()))?
				.into(),
			is_error: result.is_error,
		}),
		Some(realtime_frame::Frame::Commit(_)) => Ok(RealtimeInput::Commit),
		Some(realtime_frame::Frame::CancelResponse(_)) => Ok(RealtimeInput::CancelResponse),
		Some(realtime_frame::Frame::Close(_)) => Ok(RealtimeInput::Close),
		Some(realtime_frame::Frame::Open(_)) => {
			Err(Status::invalid_argument("Realtime open may appear only once"))
		},
		None => Err(Status::invalid_argument("Realtime frame variant is required")),
	}
}

fn realtime_event(event: CanonicalRealtimeEvent) -> Result<pb::RealtimeEvent, Status> {
	let event = match event {
		CanonicalRealtimeEvent::Ready => realtime_event::Event::Ready(pb::RealtimeReady {}),
		CanonicalRealtimeEvent::Audio(chunk) => realtime_event::Event::Audio(pb::RealtimeAudio {
			audio:    chunk.bytes,
			start_ms: chunk.start_ms,
			end_ms:   chunk.end_ms,
			r#final:  chunk.final_chunk,
		}),
		CanonicalRealtimeEvent::InputCommitted => {
			realtime_event::Event::InputCommitted(pb::RealtimeInputCommitted {})
		},
		CanonicalRealtimeEvent::Phase(_)
		| CanonicalRealtimeEvent::Transcript(_)
		| CanonicalRealtimeEvent::Delegation(_)
		| CanonicalRealtimeEvent::Muted(_) => {
			return Err(Status::failed_precondition(
				"core live events require the live voice RPC projection",
			));
		},
		CanonicalRealtimeEvent::CloseReceipt(_) => {
			realtime_event::Event::Closed(pb::RealtimeClosed {})
		},
		CanonicalRealtimeEvent::Closed => realtime_event::Event::Closed(pb::RealtimeClosed {}),
		CanonicalRealtimeEvent::Chat(chat) => realtime_event::Event::Chat(realtime_chat_event(chat)?),
	};
	Ok(pb::RealtimeEvent { event: Some(event) })
}

fn realtime_chat_event(event: ChatEvent) -> Result<pb::TurnEvent, Status> {
	let event = match event {
		ChatEvent::Started(_) => turn_event::Event::Accepted(pb::Accepted { replay: false }),
		ChatEvent::BlockStarted { index, kind } => {
			let kind = match kind {
				BlockKind::Text => part_start::Kind::Text,
				BlockKind::Thinking => part_start::Kind::Thinking,
				BlockKind::ToolCall => part_start::Kind::ToolCall,
				BlockKind::Artifact => {
					return Err(Status::failed_precondition(
						"realtime chat artifacts require an explicit RPC artifact projection",
					));
				},
			};
			turn_event::Event::PartStart(pb::PartStart {
				index,
				kind: kind as i32,
				tool_call_id: String::new(),
				tool_name: String::new(),
			})
		},
		ChatEvent::TextDelta { index, text } | ChatEvent::ThinkingDelta { index, text } => {
			turn_event::Event::PartDelta(pb::PartDelta {
				index,
				chunk: Bytes::copy_from_slice(text.as_bytes()),
			})
		},
		ChatEvent::ToolCallStarted { index, id, name } => {
			turn_event::Event::PartStart(pb::PartStart {
				index,
				kind: part_start::Kind::ToolCall as i32,
				tool_call_id: id.as_str().to_owned(),
				tool_name: name.as_str().to_owned(),
			})
		},
		ChatEvent::ToolArgumentsDelta { index, bytes } => {
			turn_event::Event::PartDelta(pb::PartDelta { index, chunk: bytes })
		},
		ChatEvent::ToolCallReady { index, .. } => {
			turn_event::Event::PartEnd(pb::PartEnd { index, signature: Bytes::new() })
		},
		ChatEvent::Artifact { .. } => {
			return Err(Status::failed_precondition(
				"realtime chat artifacts require an explicit RPC artifact projection",
			));
		},
		ChatEvent::Usage(update) => turn_event::Event::Attempt(pb::Attempt {
			number: 0,
			reason: format!("usage:{}:{}", update.usage.input_tokens, update.usage.output_tokens),
		}),
		ChatEvent::Completed(completion) => turn_event::Event::Outcome(build_turn_outcome(
			&TurnProjection::default(),
			&completion,
			None,
			0,
			None,
			None,
		)),
		ChatEvent::WorkflowAction(_)
		| ChatEvent::WorkflowResume(_)
		| ChatEvent::WorkflowCancelled { .. } => {
			return Err(Status::failed_precondition(
				"workflow control events require the duplex Turn RPC",
			));
		},
	};
	Ok(pb::TurnEvent { event: Some(event) })
}

fn native_response_stream(
	response: NativeResponse,
) -> impl Stream<Item = Result<pb::NativeChunk, Status>> + Send + 'static {
	async_stream::try_stream! {
		let status = u32::from(response.status);
		let media_type =
			response.media_type.map_or_else(String::new, |value| value.as_str().to_owned());
		let provider_request_id = response
			.provider_request_id
			.map_or_else(String::new, |value| value.as_str().to_owned());
		match response.body {
			NativeResponseBody::Json(value) => {
				yield pb::NativeChunk {
					status,
					media_type,
					provider_request_id,
					data: value.into_bytes(),
					r#final: true,
				};
			},
			NativeResponseBody::Bytes(bytes) => {
				yield pb::NativeChunk {
					status,
					media_type,
					provider_request_id,
					data: bytes,
					r#final: true,
				};
			},
			NativeResponseBody::Stream(mut stream) => {
				yield pb::NativeChunk {
					status,
					media_type,
					provider_request_id,
					data: Bytes::new(),
					r#final: false,
				};
				while let Some(chunk) = stream.next().await {
					yield pb::NativeChunk {
						status: 0,
						media_type: String::new(),
						provider_request_id: String::new(),
						data: chunk.map_err(inference_status)?,
						r#final: false,
					};
				}
				yield pb::NativeChunk {
					status: 0,
					media_type: String::new(),
					provider_request_id: String::new(),
					data: Bytes::new(),
					r#final: true,
				};
			},
		}
	}
}

const fn video_dimensions(resolution: i32, aspect_ratio: i32) -> Setting<Dimensions> {
	let height = match resolution {
		1 => 480,
		2 => 720,
		3 => 1_080,
		4 => 2_160,
		_ => return Setting::Unset,
	};
	let width = match aspect_ratio {
		1 => height,
		3 => height * 9 / 16,
		4 => height * 4 / 3,
		5 => height * 3 / 4,
		6 => height * 3 / 2,
		7 => height * 2 / 3,
		8 => height * 21 / 9,
		2 => height * 16 / 9,
		_ => return Setting::Unset,
	};
	Setting::Prefer(Dimensions { width, height })
}

async fn run_generation(
	mut session: omp_ai::answer::GenerationSession<VideoArtifact>,
	status: Arc<Mutex<pb::GenerationStatus>>,
	updates: broadcast::Sender<pb::GenerationStatus>,
	cancel: Receiver<oneshot::Sender<Result<JobCancellationReceipt, JobCancelError>>>,
) {
	let mut cancel_open = true;
	loop {
		tokio::select! {
			command = cancel.recv_async(), if cancel_open => {
				let Ok(command) = command else {
					cancel_open = false;
					continue;
				};
				let result = session.cancel().await;
				if result.as_ref().is_ok_and(|receipt| receipt.acknowledged) {
					publish_generation(&status, &updates, |status| {
						status.state = generation_status::State::Cancelled as i32;
					});
				}
				let terminal = result.as_ref().is_ok_and(|receipt| receipt.acknowledged);
				let _ = command.send(result);
				if terminal { break; }
			},
			event = session.next() => {
				let Some(event) = event else {
					if !generation_terminal(status.lock().state) {
						publish_generation(&status, &updates, |status| {
							status.state = generation_status::State::Failed as i32;
							status.detail = "generation stream ended before a terminal event".into();
						});
					}
					break;
				};
				match event {
					Ok(GenerationEvent::Queued { .. }) => publish_generation(&status, &updates, |status| {
						status.state = generation_status::State::Queued as i32;
					}),
					Ok(GenerationEvent::Progress { completed, total }) => publish_generation(&status, &updates, |status| {
						status.state = generation_status::State::Running as i32;
						status.progress_percent = total
							.filter(|total| *total != 0)
							.map_or(0.0, |total| completed as f64 * 100.0 / total as f64);
					}),
					Ok(GenerationEvent::Preview(_)) => {},
					Ok(GenerationEvent::Artifact(video)) => match artifact_blob(video.artifact) {
						Ok(blob) => publish_generation(&status, &updates, |status| {
							status.artifacts.push(pb::generation_status::Artifact {
								blob: Some(blob),
								variant: "video".into(),
								url: String::new(),
								url_expires_at_ms: 0,
							});
						}),
						Err(error) => {
							publish_generation(&status, &updates, |status| {
								status.state = generation_status::State::Failed as i32;
								status.detail = error.message().into();
							});
							break;
						},
					},
					Ok(GenerationEvent::Completed(summary)) => {
						publish_generation(&status, &updates, |status| {
							status.state = generation_status::State::Completed as i32;
							status.progress_percent = 100.0;
							status.usage = Some(proto_usage(summary.usage));
							status.cost = Some(proto_cost(summary.cost));
						});
						break;
					},
					Err(error) => {
						publish_generation(&status, &updates, |status| {
							status.state = generation_status::State::Failed as i32;
							status.detail = format!("{:?}", error.kind);
						});
						break;
					},
				}
			},
		}
	}
}

fn publish_generation(
	status: &Mutex<pb::GenerationStatus>,
	updates: &broadcast::Sender<pb::GenerationStatus>,
	update: impl FnOnce(&mut pb::GenerationStatus),
) {
	let snapshot = {
		let mut status = status.lock();
		update(&mut status);
		status.updated_at_ms = system_time_ms(SystemTime::now());
		status.clone()
	};
	let _ = updates.send(snapshot);
}

fn generation_terminal(state: i32) -> bool {
	matches!(
		generation_status::State::try_from(state),
		Ok(generation_status::State::Completed
			| generation_status::State::Failed
			| generation_status::State::Cancelled)
	)
}

fn system_time_ms(time: SystemTime) -> u64 {
	time
		.duration_since(UNIX_EPOCH)
		.unwrap_or_default()
		.as_millis()
		.try_into()
		.unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
	use omp_ai::{
		Role, RouteId,
		error::{ErrorPhase, RetryAction},
		receipt::{ExecutionReceipt, ReasonId, RecoveryKind, RecoveryRecord},
	};
	use omp_catalog::snapshot;
	use omp_core::sf;
	use omp_tool::{
		Claims, Constraint, Effects, Ev, GrammarSyntax, IncomingParams, Part, Precedence,
		Presentation, PromptCaps, Rev, Tool, ToolSpec,
	};

	use super::*;

	#[test]
	fn items_project_to_exactly_one_message_each() {
		// Context revisions (`Revision.head`, `truncate_to`, `provider_heads`)
		// count items and index the retained message list by that head, so the
		// projection must stay 1:1. Assistant-run merging for strict OpenAI
		// validators happens in the codecs instead.
		let items = vec![
			thread_pb::Item {
				seq:           0,
				created_at_ms: 0,
				props:         None,
				kind:          Some(item::Kind::Message(thread_pb::Message {
					role:            thread_pb::Role::Assistant as i32,
					parts:           vec![thread_pb::Part {
						kind: Some(part::Kind::Text("writing two files".to_owned())),
					}],
					synthetic:       None,
					user_initiated:  None,
					completed_at_ms: None,
					usage:           None,
				})),
			},
			tool_call_item("call_a"),
			tool_call_item("call_b"),
			tool_result_item("call_a"),
			tool_result_item("call_b"),
		];
		let messages = items_messages(&items).expect("items project");
		assert_eq!(messages.len(), items.len());
		let roles = messages
			.iter()
			.map(|message| message.role)
			.collect::<Vec<_>>();
		assert_eq!(roles, [
			Role::Assistant,
			Role::Assistant,
			Role::Assistant,
			Role::Tool,
			Role::Tool
		]);
	}

	fn tool_call_item(id: &str) -> thread_pb::Item {
		thread_pb::Item {
			seq:           0,
			created_at_ms: 0,
			props:         None,
			kind:          Some(item::Kind::ToolCall(thread_pb::ToolCall {
				id: id.to_owned(),
				name: "write".to_owned(),
				args_json: br#"{"path":"a"}"#.to_vec().into(),
				..Default::default()
			})),
		}
	}

	fn tool_result_item(id: &str) -> thread_pb::Item {
		thread_pb::Item {
			seq:           0,
			created_at_ms: 0,
			props:         None,
			kind:          Some(item::Kind::ToolResult(thread_pb::ToolResult {
				call_id: id.to_owned(),
				name: "write".to_owned(),
				parts: vec![thread_pb::Part { kind: Some(part::Kind::Text("ok".to_owned())) }],
				..Default::default()
			})),
		}
	}

	struct GrammarFixture {
		spec: ToolSpec,
	}

	impl Tool for GrammarFixture {
		type Fault = serde_json::Value;
		type Params = serde_json::Value;
		type Payload = serde_json::Value;
		type Update = serde_json::Value;

		fn spec(&self) -> &ToolSpec {
			&self.spec
		}

		fn call<'c>(
			&'c self,
			_params: IncomingParams<'c>,
		) -> impl futures::Stream<Item = Ev<Self::Update, Self::Payload, Self::Fault>> + Send + 'c {
			futures::stream::empty()
		}

		fn prompt(
			&self,
			_view: Result<&Self::Payload, &Self::Fault>,
			_caps: &PromptCaps,
		) -> Vec<Part> {
			Vec::new()
		}
	}

	fn grammar_tool(name: &str, syntax: grammar::Syntax, definition: &'static str) -> pb::ToolDef {
		pb::ToolDef {
			name:        name.to_owned(),
			description: String::new(),
			input:       Some(tool_def::Input::Grammar(pb::tool_def::Grammar {
				syntax:               syntax as i32,
				definition:           definition.to_owned(),
				fallback_schema_json: Bytes::from_static(br#"{"type":"object"}"#),
			})),
		}
	}

	#[test]
	fn chat_request_keeps_live_edit_style_grammar_native() {
		const LIVE_EDIT_GRAMMAR: &str =
			"start: begin_patch op+ end_patch\ncontent_line: /[^§«»\\n][^\\n]*/ LF";
		let mut registry = ToolRegistry::new();
		registry
			.register(
				GrammarFixture {
					spec: ToolSpec {
						name:            sf!("edit"),
						rev:             Rev { family: sf!("hl"), n: 1 },
						description:     sf!("Sparse edit"),
						schema:          Bytes::from_static(br#"{"type":"object","properties":{"input":{"type":"string"}},"required":["input"]}"#),
						constraint:      Constraint::Grammar {
							syntax:         GrammarSyntax::Lark,
							definition:     Str::new_static(LIVE_EDIT_GRAMMAR),
							priority:       100,
							on_unsupported: pb::Fallback::Unspecified,
						},
						effects:         Effects::empty(),
						projection_code: [0; 32],
					},
				},
				Presentation::Slot,
				Claims { precedence: Precedence::CORE, claimant: sf!("omp/core"), replaces: None },
			)
			.expect("grammar fixture registers");
		let params = pb::ChatParams {
			tools: vec![grammar_tool("edit", grammar::Syntax::Lark, "stale: CALLER")],
			..Default::default()
		};

		let request = chat_request(Vec::new(), &params, &registry).expect("chat request projects");
		let [tool] = request.tools.as_ref() else {
			panic!("one live tool");
		};
		let ToolInputConstraint::Grammar { grammar, fallback } = &tool.input else {
			panic!("edit must remain a native grammar tool");
		};
		assert_eq!(grammar.syntax, ToolGrammarSyntax::Lark);
		assert_eq!(grammar.definition, LIVE_EDIT_GRAMMAR);
		assert_eq!(
			fallback.as_value(),
			&serde_json::json!({"type": "object", "properties": {"input": {"type": "string"}}, "required": ["input"]})
		);
	}

	#[test]
	fn tool_def_grammar_projection_preserves_supported_syntax_and_definition() {
		let cases = [
			(grammar::Syntax::Lark, ToolGrammarSyntax::Lark, "start: WORD\n%import common.WORD"),
			(grammar::Syntax::Regex, ToolGrammarSyntax::Regex, r"^(yes|no)\s+\d+$"),
			(grammar::Syntax::Ebnf, ToolGrammarSyntax::Ebnf, r#"root = "yes" | "no";"#),
		];
		for (wire_syntax, expected_syntax, definition) in cases {
			let projected = tool_definition(&grammar_tool("constrained", wire_syntax, definition))
				.expect("valid grammar");
			let ToolInputConstraint::Grammar { grammar, .. } = projected.input else {
				panic!("grammar input must remain freeform");
			};
			assert_eq!(grammar.syntax, expected_syntax);
			assert_eq!(grammar.definition, definition);
		}
	}

	#[test]
	fn tool_def_rejects_unspecified_unknown_and_missing_input() {
		for syntax in [grammar::Syntax::Unspecified as i32, i32::MAX] {
			let mut tool = grammar_tool("constrained", grammar::Syntax::Lark, "start: WORD");
			let Some(tool_def::Input::Grammar(grammar)) = tool.input.as_mut() else {
				unreachable!();
			};
			grammar.syntax = syntax;
			let error = tool_definition(&tool).expect_err("invalid grammar syntax");
			assert_eq!(error.code(), tonic::Code::InvalidArgument);
		}
		let error =
			tool_definition(&pb::ToolDef { name: "missing".to_owned(), ..Default::default() })
				.expect_err("missing input");
		assert_eq!(error.code(), tonic::Code::InvalidArgument);
	}

	#[test]
	fn tool_def_json_schema_projection_preserves_schema_and_strict_behavior() {
		for (strict, expected) in [(None, false), (Some(false), false), (Some(true), true)] {
			let tool = pb::ToolDef {
				name:        "json".to_owned(),
				description: String::new(),
				input:       Some(tool_def::Input::JsonSchema(tool_def::JsonSchema {
					schema_json: Bytes::from_static(br#"{"type":"object"}"#),
					strict,
				})),
			};
			let projected = tool_definition(&tool).expect("valid JSON Schema");
			let ToolInputConstraint::JsonSchema { parameters, strict } = projected.input else {
				panic!("JSON Schema input must remain structured");
			};
			assert_eq!(parameters.as_value(), &serde_json::json!({"type": "object"}));
			assert_eq!(strict, expected);
		}
	}

	#[test]
	fn model_card_exposes_gateway_discovery_metadata() {
		let mut model = snapshot::Catalog::embedded()
			.models()
			.iter()
			.find(|model| model.capabilities.chat.is_some())
			.expect("embedded chat model")
			.clone();
		model.display_name = sf!("Fixture Display");
		model.limits.context_window = Some(1_000_000);
		model.limits.maximum_output_tokens = Some(128_000);
		model.provenance.sources[0].kind = ProvenanceKind::Configured;
		let chat = model
			.capabilities
			.chat
			.as_mut()
			.expect("selected chat model");
		chat.input_modalities = Availability::Native(ModalityBits::TEXT | ModalityBits::IMAGE);
		chat.tools = Availability::Unsupported;

		let card = model_card(&model, "fixture", Vec::new());
		assert_eq!(card.id, format!("fixture/{}", model.key));
		assert_eq!(card.provider, "fixture");
		assert_eq!(card.model, model.key.as_str());
		assert_eq!(card.source, model_card::Source::Configured as i32);
		assert_eq!(card.name, "Fixture Display");
		assert_eq!(card.context_window, 1_000_000);
		assert_eq!(card.max_output_tokens, 128_000);
		assert_eq!(card.inputs, vec![pb::Modality::Text as i32, pb::Modality::Image as i32]);
		assert_eq!(card.supports_tools, Some(false));
	}

	#[test]
	fn tokenizer_capability_errors_are_failed_preconditions() {
		let error = Error::new(
			ErrorKind::CapabilityMismatch,
			ErrorPhase::Planning,
			RetryAction::Never,
			ExecutionReceipt::default(),
		);
		let status = capability_status(error, "provider/model", OperationKind::Tokenize);
		assert_eq!(status.code(), tonic::Code::FailedPrecondition);
		assert!(status.message().contains("provider/model"));
		assert!(status.message().contains("tokenize"));
		assert!(!status.message().contains("Planning"));
	}

	#[test]
	fn turn_outcome_uses_planned_identity_when_provider_receipt_omits_it() {
		let completion = Completion {
			reason:  FinishReason::Stop,
			blocks:  0,
			usage:   Usage::default(),
			receipt: ExecutionReceipt::default().into(),
		};

		let outcome = build_turn_outcome(
			&TurnProjection::default(),
			&completion,
			None,
			0,
			Some("provider-planned"),
			Some("model-planned"),
		);

		assert_eq!(outcome.provider, "provider-planned");
		assert_eq!(outcome.model, "model-planned");
	}

	#[test]
	fn turn_outcome_preserves_ordered_recovery_diagnostics() {
		let mut receipt = ExecutionReceipt::default();
		receipt.plan.provider = Some(ProviderId::from("provider-a"));
		receipt.plan.model = Some(ModelKey::from("model-a"));
		receipt.recoveries = vec![
			RecoveryRecord {
				attempt:     2,
				kind:        RecoveryKind::SessionReseed,
				rule:        ReasonId(sf!("expired-session")),
				input_bytes: 128,
				steps:       1,
			},
			RecoveryRecord {
				attempt:     3,
				kind:        RecoveryKind::JsonRepair,
				rule:        ReasonId(sf!("bounded-json-repair")),
				input_bytes: 64,
				steps:       2,
			},
		];
		let completion = Completion {
			reason:  FinishReason::Stop,
			blocks:  0,
			usage:   Usage { input_tokens: 321, ..Usage::default() },
			receipt: receipt.into(),
		};

		let outcome =
			build_turn_outcome(&TurnProjection::default(), &completion, None, 0, None, None);

		assert_eq!(outcome.diagnostics, vec![
			pb::Diagnostic {
				provider:     "provider-a".to_owned(),
				model:        "model-a".to_owned(),
				attempt:      2,
				code:         "session_reseed".to_owned(),
				detail:       "expired-session".to_owned(),
				retryability: pb::Retryability::Unspecified as i32,
			},
			pb::Diagnostic {
				provider:     "provider-a".to_owned(),
				model:        "model-a".to_owned(),
				attempt:      3,
				code:         "json_repair".to_owned(),
				detail:       "bounded-json-repair".to_owned(),
				retryability: pb::Retryability::Unspecified as i32,
			},
		]);
		assert_eq!(
			outcome.context_snapshot,
			Some(pb::ContextSnapshot {
				prompt_tokens:                  321,
				non_message_tokens:             0,
				history_rewrite_tokens_removed: None,
				last_message_timestamp_ms:      None,
				system_tokens:                  None,
				message_tokens:                 None,
				skill_tokens:                   None,
				tool_tokens:                    None,
				buffer_tokens:                  None,
				unclassified_tokens:            None,
				window_tokens:                  None,
				slack_tokens:                   None,
				snapcompact_savings:            None,
				prompt_anchor:                  None,
				context_revision:               None,
				compaction_epoch:               None,
			})
		);
	}

	#[test]
	fn fork_reseed_outcome_retains_identity_and_one_recovery() {
		let mut receipt = ExecutionReceipt::default();
		receipt.plan.provider = Some(ProviderId::from("provider-fork"));
		receipt.plan.model = Some(ModelKey::from("model-fork"));
		receipt.plan.route = Some(RouteId::from("route-fork"));
		receipt.recoveries.push(RecoveryRecord {
			attempt:     1,
			kind:        RecoveryKind::SessionReseed,
			rule:        ReasonId(sf!("Fork")),
			input_bytes: 0,
			steps:       1,
		});
		let completion = Completion {
			reason:  FinishReason::Stop,
			blocks:  0,
			usage:   Usage::default(),
			receipt: receipt.into(),
		};

		assert_eq!(
			completion
				.receipt
				.plan
				.route
				.as_ref()
				.map(|route| route.as_str()),
			Some("route-fork")
		);
		assert_eq!(completion.receipt.recoveries.len(), 1);
		let outcome =
			build_turn_outcome(&TurnProjection::default(), &completion, None, 0, None, None);
		assert_eq!(outcome.provider, "provider-fork");
		assert_eq!(outcome.model, "model-fork");
		assert_eq!(outcome.diagnostics.len(), 1);
		assert_eq!(outcome.diagnostics[0].code, "session_reseed");
		assert_eq!(outcome.diagnostics[0].detail, "Fork");
	}

	fn empty_stop_receipt(classification: &str, billed_output: u64) -> ExecutionReceipt {
		use omp_ai::{
			body::{AttemptBodyEvidence, Replayability, RetryDecision, RetryDecisionReason},
			receipt::{AttemptOutcome, AttemptReceipt, ProviderEvidence},
		};
		let mut receipt = ExecutionReceipt::default();
		receipt.plan.model = Some(ModelKey::from("model-a"));
		receipt.record_attempt(AttemptReceipt {
			index:             0,
			hidden:            false,
			provider:          None,
			route:             None,
			account:           None,
			principal:         None,
			body:              AttemptBodyEvidence {
				opened:         true,
				consumed:       true,
				replayability:  Replayability::Replayable,
				retry_decision: RetryDecision::Allow,
				reason:         RetryDecisionReason::ReplayableSource,
			},
			outcome:           AttemptOutcome::FailedPreCommit,
			usage:             Usage { output_tokens: billed_output, ..Usage::default() },
			cost:              Cost::default(),
			provider_evidence: ProviderEvidence::default(),
			elapsed:           Duration::ZERO,
		});
		receipt.recoveries.push(RecoveryRecord {
			attempt:     1,
			kind:        RecoveryKind::EmptyOutput,
			rule:        ReasonId(Str::from(format!("empty-completion/wire/{classification}"))),
			input_bytes: 0,
			steps:       0,
		});
		receipt
	}

	fn empty_stop_error(kind: ErrorKind, receipt: ExecutionReceipt) -> Error {
		Error::new(kind, ErrorPhase::Recovery, RetryAction::Never, receipt)
	}

	#[track_caller]
	fn expect_turn_error(event: pb::TurnEvent) -> pb::TurnError {
		match event.event {
			Some(turn_event::Event::Error(error)) => error,
			other => panic!("expected a turn error event, got {other:?}"),
		}
	}

	#[test]
	fn empty_output_projects_dedicated_turn_error_kind() {
		let thought_only = empty_stop_error(ErrorKind::EmptyOutput, ExecutionReceipt::default());
		let no_content = empty_stop_error(ErrorKind::EmptyCompletion, ExecutionReceipt::default());

		let thought_only = expect_turn_error(inference_turn_error(thought_only));
		assert_eq!(thought_only.kind, turn_error::Kind::EmptyOutput as i32);
		assert_eq!(thought_only.diagnostics.len(), 1);
		assert_eq!(thought_only.diagnostics[0].code, empty_stop::NO_FINAL_OUTPUT);

		// Zero-block empty stops join the session-level bounded continuation
		// instead of failing as opaque upstream errors.
		let no_content = expect_turn_error(inference_turn_error(no_content));
		assert_eq!(no_content.kind, turn_error::Kind::EmptyOutput as i32);
		assert_eq!(no_content.diagnostics.len(), 1);
		assert_eq!(no_content.diagnostics[0].code, empty_stop::EMPTY);
	}

	#[test]
	fn billed_zero_block_empty_stop_names_the_dropped_output_tokens() {
		let error =
			empty_stop_error(ErrorKind::EmptyCompletion, empty_stop_receipt("no-content", 42));
		let error = expect_turn_error(inference_turn_error(error));
		assert_eq!(error.kind, turn_error::Kind::EmptyOutput as i32);
		assert_eq!(error.diagnostics.len(), 1);
		assert_eq!(error.diagnostics[0].code, empty_stop::BILLED_OUTPUT);
		assert_eq!(error.diagnostics[0].detail, "42");
		assert_eq!(error.diagnostics[0].model, "model-a");
		assert_eq!(error.diagnostics[0].attempt, 1);
		assert_eq!(error.diagnostics[0].retryability, pb::Retryability::Never as i32);
	}

	#[test]
	fn billed_output_diagnosis_requires_a_zero_block_stop() {
		// Whitespace-only stops retain a text block: billed usage there is not
		// evidence that deliverable content was dropped downstream.
		let whitespace =
			empty_stop_error(ErrorKind::EmptyCompletion, empty_stop_receipt("whitespace-only", 42));
		let whitespace = expect_turn_error(inference_turn_error(whitespace));
		assert_eq!(whitespace.diagnostics[0].code, empty_stop::EMPTY);

		// Reasoning-only billing is reported in the separate reasoning
		// dimension; a zero-block stop without billed output keeps the
		// context hint.
		let reasoning_only =
			empty_stop_error(ErrorKind::EmptyCompletion, empty_stop_receipt("no-content", 0));
		let reasoning_only = expect_turn_error(inference_turn_error(reasoning_only));
		assert_eq!(reasoning_only.diagnostics[0].code, empty_stop::EMPTY);
	}

	#[test]
	fn authentication_turn_error_names_the_login_command_provider_and_safe_detail() {
		let authentication = Error::new(
			ErrorKind::Authentication,
			ErrorPhase::Authentication,
			RetryAction::Never,
			ExecutionReceipt::default(),
		)
		.provider(ProviderId::from("kimi-code"))
		.detail(ErrorDetail::provider(sf!("device authorization expired")));
		let Some(turn_event::Event::Error(error)) = inference_turn_error(authentication).event else {
			panic!("authentication failure must project a turn error");
		};
		assert_eq!(error.kind, turn_error::Kind::Auth as i32);
		assert!(error.detail.contains("/login kimi-code"));
		assert!(error.detail.contains("omp auth login kimi-code"));
		assert!(error.detail.contains("device authorization expired"));
	}

	#[test]
	fn invocation_timeout_projects_the_dedicated_turn_error_kind() {
		let event = invoke_timeout("invoke-9");
		assert!(matches!(
			event.event,
			Some(turn_event::Event::Error(pb::TurnError {
				kind,
				detail,
				..
			})) if kind == turn_error::Kind::InvokeTimeout as i32
				&& detail.contains("invoke-9")
		));
	}

	#[test]
	fn provider_owned_calls_without_registry_identity_remain_unstamped() {
		let registry = ToolRegistry::new();
		assert_eq!(tool_revision_props(&registry, "provider.search"), None);
	}

	#[test]
	fn workflow_action_completion_preserves_text_and_error_classification() {
		let complete = pb::InvokeComplete {
			invocation_id: "invoke-1".to_owned(),
			tool_result: Some(thread_pb::ToolResult {
				parts: vec![
					thread_pb::Part { kind: Some(part::Kind::Text("first".to_owned())) },
					thread_pb::Part { kind: Some(part::Kind::Text(" second".to_owned())) },
				],
				is_error: true,
				..Default::default()
			}),
			..Default::default()
		};
		let (payload, is_error) = workflow_action_result(&complete).expect("text workflow response");
		assert_eq!(payload.as_ref(), b"first second");
		assert!(is_error);
	}

	#[tokio::test]
	async fn committed_turn_replay_is_exact_and_mismatched_open_is_rejected() {
		let request = pb::TurnRequest { turn_id: "turn-1".to_owned(), ..Default::default() };
		let outcome = pb::Outcome { model: "recorded-model".to_owned(), ..Default::default() };
		let replay = TurnReplay {
			request: Bytes::from(request.encode_to_vec()),
			outcome: Bytes::from(outcome.encode_to_vec()),
		};
		let events = turn_replay_events(replay.clone(), &request)
			.expect("matching replay")
			.collect::<Vec<_>>()
			.await;
		assert!(matches!(
			events.as_slice(),
			[
				Ok(pb::TurnEvent {
					event: Some(turn_event::Event::Accepted(pb::Accepted {
						replay: true
					}))
				}),
				Ok(pb::TurnEvent {
					event: Some(turn_event::Event::Outcome(actual))
				}),
			] if actual == &outcome
		));
		let mismatched = pb::TurnRequest {
			turn_id: "turn-1".to_owned(),
			params: Some(pb::ChatParams { model: "different".to_owned(), ..Default::default() }),
			..Default::default()
		};
		let Err(status) = turn_replay_events(replay, &mismatched) else {
			panic!("mismatched replay payload must be rejected");
		};
		assert_eq!(status.code(), tonic::Code::AlreadyExists);
	}
}
