//! Append-only conversation history, context planning, and provider-side state.

pub mod binding;
pub mod conversation;
pub mod revision;
pub mod store;

use std::{
	collections::{BTreeMap, HashMap},
	mem,
	path::Path,
	sync::Arc,
	time::{Duration, SystemTime},
};

pub use binding::{
	BindingContext, BindingKey, BindingValidity, CredentialAffinityDigest,
	CredentialGenerationPolicy, PendingServerStateBinding, ProviderExpiryDecision, ReseedReason,
	ReseedState, ServerStateBinding, SessionExpiryError, StoredProviderStateEvent,
};
use bytes::Bytes;
pub use conversation::{
	ConversationError, MessagePersistenceError, StoredCacheRetention, StoredContent, StoredMedia,
	StoredMessage, StoredProof, StoredRole, StoredToolResult, TurnDraft,
};
use omp_core::{Str, sf};
use parking_lot::Mutex;
pub use revision::{CommittedRevision, HistoryDelta};
pub use store::{
	ConversationStore, InMemoryConversationStore, SqliteConversationStore, SqliteTurnDraft,
	TurnReplay,
};

use crate::{
	answer::ArtifactBody,
	call::{
		CacheRetention, Call, ContentPart, ContextStrategy, Message, OpaqueJson, OperationCall,
		PrefixCachePolicy, Role, ServerStatePolicy, SessionRequest,
	},
	catalog::{
		CodecId, ModelKey, ProviderId, RouteId, TrustDomain, capability::CacheRetentionBits,
		model::ContextStrategy as CatalogContextStrategy, snapshot::Catalog,
	},
	codec::ProviderStateEvent,
	error::{Error, ErrorKind, ErrorPhase, RetryAction},
	event::{BlockKind, ChatEvent, Completion},
	id::{ConversationId, RequestId, Revision, TurnId},
	layer::{
		ExecutionContext, SessionAffinity,
		session::{SessionAction, SessionCompletion, SessionPlanner},
	},
	receipt::{ExecutionReceipt, ReasonId, RecoveryKind, RecoveryRecord},
	recovery::repetition::{
		CrossTurnLimits, CrossTurnLoopGuard, LoopSignal, ToolExchangeObservation,
		TurnRecoveryObservation, recovery_record, tool_loop_redirect,
	},
};
#[derive(Default)]
struct PendingRecoveryTurn {
	calls:    Vec<(crate::id::ToolCallId, Str, OpaqueJson)>,
	results:  HashMap<crate::id::ToolCallId, (OpaqueJson, bool)>,
	progress: bool,
}

fn detect_cross_turn_loop(
	history: &HistoryDelta<StoredMessage>,
	input: &[StoredMessage],
) -> Option<LoopSignal> {
	let limits = CrossTurnLimits::default();
	let mut messages = history
		.segments()
		.iter()
		.skip(
			history
				.segments()
				.len()
				.saturating_sub(limits.history_limit),
		)
		.flat_map(|segment| segment.iter())
		.chain(input.iter());
	let mut guard = CrossTurnLoopGuard::new(limits);
	let mut pending: Option<PendingRecoveryTurn> = None;
	let mut latest = None;
	for message in &mut messages {
		if message.role == StoredRole::Assistant {
			if let Some(turn) = pending.take() {
				latest = observe_recovery_turn(&mut guard, turn);
			}
			let mut turn = PendingRecoveryTurn::default();
			for content in message.content.iter() {
				match content {
					StoredContent::Text { text, .. } => {
						turn.progress |= !text.trim().is_empty();
					},
					StoredContent::ToolCall { call, name, arguments, .. } => {
						let Ok(arguments) = serde_json::from_slice(arguments) else {
							continue;
						};
						turn
							.calls
							.push((call.clone(), name.clone(), OpaqueJson::new(arguments)));
					},
					_ => {},
				}
			}
			pending = Some(turn);
			continue;
		}
		let Some(turn) = pending.as_mut() else {
			continue;
		};
		for content in message.content.iter() {
			if let StoredContent::ToolResult { call, content, is_error, .. } = content {
				let Ok(result) = serde_json::to_value(content.as_ref()) else {
					continue;
				};
				turn
					.results
					.insert(call.clone(), (OpaqueJson::new(result), *is_error));
			}
		}
	}
	if let Some(turn) = pending {
		latest = observe_recovery_turn(&mut guard, turn);
	}
	latest
}

fn observe_recovery_turn(
	guard: &mut CrossTurnLoopGuard,
	turn: PendingRecoveryTurn,
) -> Option<LoopSignal> {
	let tool_exchanges = turn
		.calls
		.into_iter()
		.filter_map(|(call_id, name, arguments)| {
			let (result, is_error) = turn.results.get(&call_id)?.clone();
			Some(ToolExchangeObservation { call_id, name, arguments, result, is_error })
		})
		.collect();
	guard.observe(&TurnRecoveryObservation { tool_exchanges, made_textual_progress: turn.progress })
}

/// Stable prefix-cache identity derived solely from immutable history and
/// policy scope.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PrefixCacheIdentity {
	/// Revision whose canonical prefix is cached.
	pub revision: Revision,
	/// Deterministic opaque cache key.
	pub key:      Str,
}

/// Exact canonical context selected for one attempt.
#[derive(Clone, Debug)]
pub enum ContextPlan<I> {
	/// Send complete canonical history.
	Replay {
		/// Canonical messages from the beginning through the requested revision.
		history:              HistoryDelta<I>,
		/// Whether successful provider state should be captured for later deltas.
		capture_server_state: bool,
		/// Typed cause when replay is recovering or intentionally reseeding
		/// state.
		reason:               Option<ReseedReason>,
	},
	/// Send complete history with a revision-derived provider cache identity.
	PrefixCache {
		/// Canonical messages covered by the immutable cache prefix.
		history: HistoryDelta<I>,
		/// Revision-derived identity used to address that prefix.
		cache:   PrefixCacheIdentity,
	},
	/// Send an opaque compatible handle and only items after its committed base.
	ServerState {
		/// Valid provider-state binding scoped to this conversation and route.
		binding: Box<ServerStateBinding>,
		/// Canonical messages committed after the binding's base revision.
		delta:   HistoryDelta<I>,
	},
}

/// Plans replay, prefix-cache, or provider-side delta context without vendor
/// heuristics.
pub fn plan_context<I, S>(
	store: &S,
	strategy: &ContextStrategy,
	head: &Revision<str>,
	binding: Option<&ServerStateBinding>,
	context: Option<&BindingContext<'_>>,
) -> Result<ContextPlan<I>, ConversationError>
where
	S: ConversationStore<I>,
{
	match strategy {
		ContextStrategy::Replay => Ok(ContextPlan::Replay {
			history:              store.delta(None, head)?,
			capture_server_state: false,
			reason:               None,
		}),
		ContextStrategy::PrefixCache(_) => {
			let history = store.delta(None, head)?;
			let key = sf!("prefix:{}", head.as_str());
			Ok(ContextPlan::PrefixCache {
				history,
				cache: PrefixCacheIdentity { revision: head.to_owned(), key },
			})
		},
		ContextStrategy::ServerState(policy) => {
			let Some(binding) = binding else {
				return Ok(ContextPlan::Replay {
					history:              store.delta(None, head)?,
					capture_server_state: true,
					reason:               Some(ReseedReason::FirstTurn),
				});
			};
			let context = context.ok_or(ConversationError::CorruptStore)?;
			let ancestor = store.is_ancestor(&binding.key.base_revision, head)?;
			let mut scoped = context.clone();
			scoped.max_age = match (context.max_age, policy.max_age) {
				(Some(context), Some(policy)) => Some(context.min(policy)),
				(None, policy) => policy,
				(context, None) => context,
			};
			match binding.validity(&scoped, ancestor) {
				BindingValidity::Compatible => Ok(ContextPlan::ServerState {
					binding: Box::new(binding.clone()),
					delta:   store.delta(Some(&binding.key.base_revision), head)?,
				}),
				BindingValidity::Reseed(reason) if policy.allow_reseed => Ok(ContextPlan::Replay {
					history:              store.delta(None, head)?,
					capture_server_state: true,
					reason:               Some(reason),
				}),
				BindingValidity::Reseed(_) => Err(ConversationError::RevisionConflict {
					expected: binding.key.base_revision.clone(),
					actual:   head.to_owned(),
				}),
			}
		},
	}
}

#[derive(Clone)]
struct PreparedTurn {
	request:           RequestId,
	session:           SessionRequest,
	input:             Arc<[StoredMessage]>,
	provider:          ProviderId,
	codec:             CodecId,
	route:             RouteId,
	model:             ModelKey,
	trust_domain:      TrustDomain,
	credential_policy: CredentialGenerationPolicy,
}

type TurnReplayEncoder =
	dyn Fn(&Completion) -> Result<Bytes, ConversationError> + Send + Sync + 'static;

#[derive(Clone)]
struct PendingTurnReplay {
	turn:    TurnId,
	request: Bytes,
	encode:  Arc<TurnReplayEncoder>,
}

#[derive(Clone)]
enum PlannerStore {
	Sqlite(Arc<SqliteConversationStore<StoredMessage>>),
	Memory(Arc<InMemoryConversationStore<StoredMessage>>),
}

enum PlannerDraft {
	Sqlite(SqliteTurnDraft<StoredMessage>),
	Memory {
		draft:  TurnDraft<StoredMessage>,
		store:  Arc<InMemoryConversationStore<StoredMessage>>,
		replay: Option<(TurnId, Bytes, Bytes)>,
	},
}

impl PlannerStore {
	fn create(&self) -> Result<CommittedRevision<StoredMessage>, ConversationError> {
		match self {
			Self::Sqlite(store) => store.create(),
			Self::Memory(store) => store.create(),
		}
	}

	fn fork(&self, at: &Revision<str>) -> Result<ConversationId, ConversationError> {
		match self {
			Self::Sqlite(store) => store.fork(at),
			Self::Memory(store) => store.fork(at),
		}
	}

	fn committed_turn(
		&self,
		conversation: &ConversationId<str>,
		turn: &TurnId<str>,
	) -> Result<Option<CommittedRevision<StoredMessage>>, ConversationError> {
		match self {
			Self::Sqlite(store) => store.committed_turn(conversation, turn),
			Self::Memory(store) => store.committed_turn(conversation, turn),
		}
	}

	fn turn_replay(&self, turn: &TurnId<str>) -> Result<Option<TurnReplay>, ConversationError> {
		match self {
			Self::Sqlite(store) => store.turn_replay(turn),
			Self::Memory(store) => Ok(store.turn_replay(turn)),
		}
	}

	fn commit_turn_replay(
		&self,
		turn: TurnId,
		request: Bytes,
		outcome: Bytes,
	) -> Result<(), ConversationError> {
		match self {
			Self::Sqlite(store) => store.commit_turn_replay(turn, request, outcome),
			Self::Memory(store) => store.commit_turn_replay(turn, request, outcome),
		}
	}

	fn server_state(
		&self,
		conversation: &ConversationId<str>,
	) -> Result<Option<ServerStateBinding>, ConversationError> {
		match self {
			Self::Sqlite(store) => store.server_state(conversation),
			Self::Memory(store) => store.server_state(conversation),
		}
	}

	fn delta(
		&self,
		base: Option<&Revision<str>>,
		head: &Revision<str>,
	) -> Result<HistoryDelta<StoredMessage>, ConversationError> {
		match self {
			Self::Sqlite(store) => store.delta(base, head),
			Self::Memory(store) => store.delta(base, head),
		}
	}

	fn plan(
		&self,
		strategy: &ContextStrategy,
		head: &Revision<str>,
		binding: Option<&ServerStateBinding>,
		context: Option<&BindingContext<'_>>,
	) -> Result<ContextPlan<StoredMessage>, ConversationError> {
		match self {
			Self::Sqlite(store) => plan_context(store.as_ref(), strategy, head, binding, context),
			Self::Memory(store) => plan_context(store.as_ref(), strategy, head, binding, context),
		}
	}

	fn begin(
		&self,
		conversation: &ConversationId<str>,
		revision: &Revision<str>,
		turn: TurnId,
		input: Arc<[StoredMessage]>,
	) -> Result<PlannerDraft, ConversationError> {
		match self {
			Self::Sqlite(store) => store
				.begin(conversation, revision, turn, input)
				.map(PlannerDraft::Sqlite),
			Self::Memory(store) => store
				.begin(conversation, revision, turn, input)
				.map(|draft| PlannerDraft::Memory { draft, store: Arc::clone(store), replay: None }),
		}
	}
}

impl PlannerDraft {
	fn append(&mut self, items: Arc<[StoredMessage]>) {
		match self {
			Self::Sqlite(draft) => draft.append(items),
			Self::Memory { draft, .. } => draft.append(items),
		}
	}

	fn capture_turn_replay(
		&mut self,
		turn: TurnId,
		request: Bytes,
		outcome: Bytes,
	) -> Result<(), ConversationError> {
		match self {
			Self::Sqlite(draft) => draft.capture_turn_replay(turn, request, outcome),
			Self::Memory { draft, replay, .. } => {
				if turn != draft.turn {
					return Err(ConversationError::CorruptStore);
				}
				*replay = Some((turn, request, outcome));
				Ok(())
			},
		}
	}

	fn commit(self) -> Result<CommittedRevision<StoredMessage>, ConversationError> {
		match self {
			Self::Sqlite(draft) => draft.commit(),
			Self::Memory { draft, store, replay } => store.commit_draft(draft, replay, None),
		}
	}

	fn commit_successful_turn(
		self,
		binding: PendingServerStateBinding,
	) -> Result<CommittedRevision<StoredMessage>, ConversationError> {
		match self {
			Self::Sqlite(draft) => draft.commit_successful_turn(binding),
			Self::Memory { draft, store, replay } => store.commit_draft(draft, replay, Some(binding)),
		}
	}
}

/// Clone-cheap durable conversation planner shared by every production route
/// stack.
#[derive(Clone)]
pub struct ConversationSessionPlanner {
	store:    PlannerStore,
	catalog:  Arc<Catalog>,
	prepared: Arc<Mutex<HashMap<RequestId, PreparedTurn>>>,
	replays:  Arc<Mutex<HashMap<RequestId, PendingTurnReplay>>>,
}

impl ConversationSessionPlanner {
	/// Creates a planner backed by an explicitly injected durable SQLite store
	/// and catalog.
	pub fn new(store: Arc<SqliteConversationStore<StoredMessage>>, catalog: Arc<Catalog>) -> Self {
		Self {
			store: PlannerStore::Sqlite(store),
			catalog,
			prepared: Arc::new(Mutex::new(HashMap::new())),
			replays: Arc::new(Mutex::new(HashMap::new())),
		}
	}

	/// Creates a planner over an explicitly injected in-memory store for
	/// deterministic tests.
	pub fn with_in_memory(
		store: Arc<InMemoryConversationStore<StoredMessage>>,
		catalog: Arc<Catalog>,
	) -> Self {
		Self {
			store: PlannerStore::Memory(store),
			catalog,
			prepared: Arc::new(Mutex::new(HashMap::new())),
			replays: Arc::new(Mutex::new(HashMap::new())),
		}
	}

	/// Opens a durable SQLite store at `path` and constructs a planner over it.
	pub fn open(path: impl AsRef<Path>, catalog: Arc<Catalog>) -> Result<Self, ConversationError> {
		Ok(Self::new(Arc::new(SqliteConversationStore::open(path)?), catalog))
	}

	/// Creates a fresh provider conversation and returns its immutable root.
	pub fn create_conversation(
		&self,
	) -> Result<CommittedRevision<StoredMessage>, ConversationError> {
		self.store.create()
	}

	/// Forks provider history at an immutable committed revision.
	pub fn fork_conversation(
		&self,
		at: &Revision<str>,
	) -> Result<ConversationId, ConversationError> {
		self.store.fork(at)
	}

	/// Returns the provider-history commit for one conversation-scoped turn.
	pub fn committed_turn(
		&self,
		conversation: &ConversationId<str>,
		turn: &TurnId<str>,
	) -> Result<Option<CommittedRevision<StoredMessage>>, ConversationError> {
		self.store.committed_turn(conversation, turn)
	}

	/// Returns an exact terminal RPC response retained for logical-turn replay.
	pub fn turn_replay(&self, turn: &TurnId<str>) -> Result<Option<TurnReplay>, ConversationError> {
		self.store.turn_replay(turn)
	}

	/// Retains an exact terminal response outside a provider-session commit.
	///
	/// Stateful turns should use [`Self::stage_turn_replay`] so provider history
	/// and replay become visible in one transaction.
	pub fn commit_turn_replay(
		&self,
		turn: TurnId,
		request: Bytes,
		outcome: Bytes,
	) -> Result<(), ConversationError> {
		self.store.commit_turn_replay(turn, request, outcome)
	}

	/// Stages an exact terminal-response encoder to be committed atomically with
	/// the provider conversation turn.
	pub fn stage_turn_replay<F>(
		&self,
		request: RequestId,
		turn: TurnId,
		request_bytes: Bytes,
		encode: F,
	) where
		F: Fn(&Completion) -> Result<Bytes, ConversationError> + Send + Sync + 'static,
	{
		self.replays.lock().insert(request, PendingTurnReplay {
			turn,
			request: request_bytes,
			encode: Arc::new(encode),
		});
	}

	fn prepare_inner(
		&self,
		call: &mut Call,
		context: &ExecutionContext,
		force_replay: bool,
		input_override: Option<Arc<[StoredMessage]>>,
	) -> Result<SessionAction, Error> {
		let Some(mut session) = call.session.clone() else {
			context.set_session_affinity(None);
			context.set_session_state(None);
			return Ok(SessionAction::None);
		};
		let plan = call
			.execution
			.as_ref()
			.ok_or_else(|| session_error(context, ErrorKind::InvalidRequest, RetryAction::Never))?;
		let model = plan.model.clone().ok_or_else(|| {
			session_error(context, ErrorKind::CapabilityMismatch, RetryAction::Never)
		})?;
		let route = self
			.catalog
			.route(&plan.route)
			.ok_or_else(|| session_error(context, ErrorKind::SessionConflict, RetryAction::Never))?;
		if let Some(policy_model) = plan.policy_model.as_ref() {
			session.strategy = provider_context_strategy(policy_model.context);
		}
		let OperationCall::Chat(request) = &call.operation else {
			return Err(session_error(context, ErrorKind::InvalidRequest, RetryAction::Never));
		};
		let input = match input_override {
			Some(input) => input,
			None => request
				.messages
				.iter()
				.map(StoredMessage::try_from)
				.collect::<Result<Vec<_>, _>>()
				.map_err(|_| session_error(context, ErrorKind::InvalidRequest, RetryAction::Never))?
				.into(),
		};
		let explicit_provider_reset = session.provider_reset;
		let force_replay = force_replay || explicit_provider_reset;
		let binding = if force_replay || session.forked {
			None
		} else {
			self
				.store
				.server_state(&session.conversation)
				.map_err(|_| session_error(context, ErrorKind::SessionConflict, RetryAction::Never))?
		};
		let context_plan = if force_replay {
			ContextPlan::Replay {
				history:              self.store.delta(None, &session.revision).map_err(|_| {
					session_error(context, ErrorKind::SessionConflict, RetryAction::Never)
				})?,
				capture_server_state: matches!(session.strategy, ContextStrategy::ServerState(_)),
				reason:               Some(if explicit_provider_reset {
					ReseedReason::ProviderReset
				} else {
					ReseedReason::ProviderExpired
				}),
			}
		} else if session.forked {
			ContextPlan::Replay {
				history:              self.store.delta(None, &session.revision).map_err(|_| {
					session_error(context, ErrorKind::SessionConflict, RetryAction::Never)
				})?,
				capture_server_state: matches!(session.strategy, ContextStrategy::ServerState(_)),
				reason:               Some(ReseedReason::Fork),
			}
		} else if let Some(binding) = binding.as_ref() {
			let scope = BindingContext {
				conversation:          &session.conversation,
				route:                 &plan.route,
				model:                 &model,
				principal:             &binding.key.principal,
				account_change:        None,
				trust_domain:          &route.trust_domain,
				credential_generation: binding.key.credential_generation,
				now:                   SystemTime::now(),
				max_age:               match &session.strategy {
					ContextStrategy::ServerState(policy) => policy.max_age,
					_ => None,
				},
			};
			self
				.store
				.plan(&session.strategy, &session.revision, Some(binding), Some(&scope))
				.map_err(|_| session_error(context, ErrorKind::SessionConflict, RetryAction::Never))?
		} else {
			self
				.store
				.plan(&session.strategy, &session.revision, None, None)
				.map_err(|_| session_error(context, ErrorKind::SessionConflict, RetryAction::Never))?
		};
		let (history, action, selected_binding) = match context_plan {
			ContextPlan::Replay { history, reason, .. } => {
				if let Some(reseed_reason) = reason.filter(|reason| *reason != ReseedReason::FirstTurn)
				{
					context.with_receipt(|receipt| {
						receipt.recoveries.push(RecoveryRecord {
							attempt:     context.attempts(),
							kind:        RecoveryKind::SessionReseed,
							rule:        ReasonId(sf!(<&'static str>::from(reseed_reason))),
							input_bytes: 0,
							steps:       1,
						});
					});
				}
				(
					history,
					if reason.is_some() {
						SessionAction::Reseed
					} else {
						SessionAction::Replay
					},
					None,
				)
			},
			ContextPlan::PrefixCache { history, .. } => (history, SessionAction::Replay, None),
			ContextPlan::ServerState { binding, delta } => {
				(delta, SessionAction::Reuse, Some(*binding))
			},
		};
		let recovery_history = if history.base().is_some() {
			self
				.store
				.delta(None, &session.revision)
				.map_err(|_| session_error(context, ErrorKind::SessionConflict, RetryAction::Never))?
		} else {
			history.clone()
		};
		let cross_turn_loop = detect_cross_turn_loop(&recovery_history, &input);
		let mut messages = history
			.items()
			.cloned()
			.map(Message::try_from)
			.collect::<Result<Vec<_>, _>>()
			.map_err(|_| session_error(context, ErrorKind::SessionConflict, RetryAction::Never))?;
		messages.extend(
			input
				.iter()
				.cloned()
				.map(Message::try_from)
				.collect::<Result<Vec<_>, _>>()
				.map_err(|_| session_error(context, ErrorKind::SessionConflict, RetryAction::Never))?,
		);
		if let Some(signal) = cross_turn_loop {
			context.with_receipt(|receipt| {
				if !receipt
					.recoveries
					.iter()
					.any(|record| record.kind == RecoveryKind::CrossTurnToolLoop)
				{
					receipt
						.recoveries
						.push(recovery_record(context.attempts(), &signal));
				}
			});
			messages.push(Message {
				role:    Role::System,
				content: Arc::from([ContentPart::Text { text: tool_loop_redirect(), proof: None }]),
				name:    None,
			});
		}
		let mut rewritten = (**request).clone();
		rewritten.messages = messages.into();
		call.operation = OperationCall::Chat(Arc::new(rewritten));
		if let Some(binding) = selected_binding.as_ref() {
			context.set_session_affinity(Some(SessionAffinity {
				principal:             binding.key.principal.clone(),
				credential_generation: binding.key.credential_generation,
				credential_policy:     binding.key.credential_policy,
			}));
		} else {
			context.set_session_affinity(None);
		}
		context.set_session_state(selected_binding);
		let credential_policy = match plan.policy_model.as_ref().map(|model| model.context) {
			Some(CatalogContextStrategy::ServerState(policy))
				if policy.credential_generation_bound =>
			{
				CredentialGenerationPolicy::CredentialGenerationBound
			},
			_ => CredentialGenerationPolicy::PrincipalBound,
		};
		self.prepared.lock().insert(call.id.clone(), PreparedTurn {
			request: call.id.clone(),
			session,
			input,
			provider: plan.provider.clone(),
			codec: plan.codec.clone(),
			route: plan.route.clone(),
			model,
			trust_domain: route.trust_domain.clone(),
			credential_policy,
		});
		Ok(action)
	}
}

impl SessionPlanner for ConversationSessionPlanner {
	fn prepare(&self, call: &mut Call, context: &ExecutionContext) -> Result<SessionAction, Error> {
		self.prepare_inner(call, context, false, None)
	}

	fn reseed(&self, call: &mut Call, context: &ExecutionContext) -> Result<(), Error> {
		let input = self
			.prepared
			.lock()
			.remove(&call.id)
			.map(|prepared| prepared.input);
		context.set_session_affinity(None);
		context.set_session_state(None);
		self.prepare_inner(call, context, true, input).map(|_| ())
	}

	fn completion(
		&self,
		call: &Call,
		context: &ExecutionContext,
	) -> Result<Option<Arc<dyn SessionCompletion>>, Error> {
		let Some(prepared) = self.prepared.lock().remove(&call.id) else {
			return Ok(None);
		};
		let Ok(draft) = self.store.begin(
			&prepared.session.conversation,
			&prepared.session.revision,
			prepared.session.turn.clone(),
			prepared.input.clone(),
		) else {
			return Err(session_error(context, ErrorKind::SessionConflict, RetryAction::Never));
		};
		Ok(Some(Arc::new(DurableCompletion {
			draft: Mutex::new(Some(draft)),
			blocks: Mutex::new(BTreeMap::new()),
			completion: Mutex::new(None),
			prepared,
			prepared_turns: Arc::clone(&self.prepared),
			replays: Arc::clone(&self.replays),
		})))
	}
}

enum AssistantBlock {
	Text(String),
	Reasoning(String),
	Tool(StoredContent),
}

struct DurableCompletion {
	draft:          Mutex<Option<PlannerDraft>>,
	blocks:         Mutex<BTreeMap<u32, AssistantBlock>>,
	completion:     Mutex<Option<Completion>>,
	prepared:       PreparedTurn,
	prepared_turns: Arc<Mutex<HashMap<RequestId, PreparedTurn>>>,
	replays:        Arc<Mutex<HashMap<RequestId, PendingTurnReplay>>>,
}

impl SessionCompletion for DurableCompletion {
	fn record_chat_event(&self, event: &ChatEvent, context: &ExecutionContext) -> Result<(), Error> {
		let mut blocks = self.blocks.lock();
		match event {
			ChatEvent::BlockStarted { index, kind: BlockKind::Text } => {
				blocks
					.entry(*index)
					.or_insert_with(|| AssistantBlock::Text(String::new()));
			},
			ChatEvent::BlockStarted { index, kind: BlockKind::Thinking } => {
				blocks
					.entry(*index)
					.or_insert_with(|| AssistantBlock::Reasoning(String::new()));
			},
			ChatEvent::BlockStarted { .. }
			| ChatEvent::Started(_)
			| ChatEvent::Usage(_)
			| ChatEvent::WorkflowAction(_)
			| ChatEvent::WorkflowResume(_)
			| ChatEvent::WorkflowCancelled { .. } => {},
			ChatEvent::Completed(completion) => {
				*self.completion.lock() = Some(completion.clone());
			},
			ChatEvent::TextDelta { index, text } => match blocks
				.entry(*index)
				.or_insert_with(|| AssistantBlock::Text(String::new()))
			{
				AssistantBlock::Text(output) => output.push_str(text.as_str()),
				_ => {
					return Err(session_error(context, ErrorKind::SessionConflict, RetryAction::Never));
				},
			},
			ChatEvent::ThinkingDelta { index, text } => match blocks
				.entry(*index)
				.or_insert_with(|| AssistantBlock::Reasoning(String::new()))
			{
				AssistantBlock::Reasoning(output) => output.push_str(text.as_str()),
				_ => {
					return Err(session_error(context, ErrorKind::SessionConflict, RetryAction::Never));
				},
			},
			ChatEvent::ToolCallReady { index, call } => {
				blocks.insert(
					*index,
					AssistantBlock::Tool(StoredContent::ToolCall {
						call:      call.id.clone(),
						name:      call.name.clone(),
						arguments: serde_json::to_vec(call.arguments.as_value())
							.map(Bytes::from)
							.map_err(|_| {
								session_error(context, ErrorKind::MalformedModelOutput, RetryAction::Never)
							})?,
						proof:     None,
					}),
				);
			},
			ChatEvent::ToolCallStarted { .. } | ChatEvent::ToolArgumentsDelta { .. } => {},
			ChatEvent::Artifact { index, artifact } => {
				let media = match &artifact.body {
					ArtifactBody::Bytes(data) => StoredMedia::Bytes {
						media_type: artifact.media_type.clone(),
						data:       data.clone(),
					},
					ArtifactBody::Stored(reference) => StoredMedia::Artifact {
						store:    reference.store.clone(),
						id:       reference.id.clone(),
						revision: reference.revision.clone(),
					},
					ArtifactBody::Stream(_) => {
						return Err(session_error(
							context,
							ErrorKind::InvalidRequest,
							RetryAction::Never,
						));
					},
				};
				let content = if artifact.media_type.as_str().starts_with("image/") {
					StoredContent::Image(media)
				} else if artifact.media_type.as_str().starts_with("audio/") {
					StoredContent::Audio(media)
				} else {
					StoredContent::Document(media)
				};
				blocks.insert(*index, AssistantBlock::Tool(content));
			},
		}
		Ok(())
	}

	fn commit(
		&self,
		provider_state: Vec<ProviderStateEvent>,
		_: &ExecutionReceipt,
		context: &ExecutionContext,
	) -> Result<(), Error> {
		let proof = |value: Bytes| StoredProof {
			provider: self.prepared.provider.clone(),
			codec: self.prepared.codec.clone(),
			value,
		};
		let mut blocks = self.blocks.lock();
		for event in &provider_state {
			match event {
				ProviderStateEvent::ReasoningSignature { index, signature } => {
					if let Some(block) = blocks.remove(index) {
						let block = match block {
							AssistantBlock::Reasoning(text) => {
								AssistantBlock::Tool(StoredContent::Reasoning {
									text:  Str::new(text),
									proof: Some(proof(signature.clone())),
								})
							},
							other => other,
						};
						blocks.insert(*index, block);
					}
				},
				ProviderStateEvent::HistoryBlock { index, data } => {
					if let Some(block) = blocks.remove(index) {
						let block = match block {
							AssistantBlock::Text(text) => AssistantBlock::Tool(StoredContent::Text {
								text:  Str::new(text),
								proof: Some(proof(data.clone())),
							}),
							AssistantBlock::Reasoning(text) => {
								AssistantBlock::Tool(StoredContent::Reasoning {
									text:  Str::new(text),
									proof: Some(proof(data.clone())),
								})
							},
							AssistantBlock::Tool(StoredContent::ToolCall {
								call,
								name,
								arguments,
								..
							}) => AssistantBlock::Tool(StoredContent::ToolCall {
								call,
								name,
								arguments,
								proof: Some(proof(data.clone())),
							}),
							other => other,
						};
						blocks.insert(*index, block);
					} else {
						blocks.insert(
							*index,
							AssistantBlock::Tool(StoredContent::Text {
								text:  Str::default(),
								proof: Some(proof(data.clone())),
							}),
						);
					}
				},
				ProviderStateEvent::ToolCallProof { index, value } => {
					if let Some(&mut AssistantBlock::Tool(StoredContent::ToolCall {
						proof: ref mut slot,
						..
					})) = blocks.get_mut(index)
					{
						*slot = Some(proof(value.clone()));
					}
				},
				_ => {},
			}
		}
		let content = mem::take(&mut *blocks)
			.into_values()
			.map(|block| match block {
				AssistantBlock::Text(text) => {
					StoredContent::Text { text: Str::new(text), proof: None }
				},
				AssistantBlock::Reasoning(text) => {
					StoredContent::Reasoning { text: Str::new(text), proof: None }
				},
				AssistantBlock::Tool(content) => content,
			})
			.collect::<Vec<_>>();
		let assistant =
			StoredMessage { role: StoredRole::Assistant, content: content.into(), name: None };
		let mut draft =
			self.draft.lock().take().ok_or_else(|| {
				session_error(context, ErrorKind::SessionConflict, RetryAction::Never)
			})?;
		let replay = { self.replays.lock().get(&self.prepared.request).cloned() };
		if let Some(replay) = replay {
			let completion = self.completion.lock().clone().ok_or_else(|| {
				session_error(context, ErrorKind::SessionConflict, RetryAction::Never)
			})?;
			let outcome = (replay.encode)(&completion)
				.map_err(|_| session_error(context, ErrorKind::SessionConflict, RetryAction::Never))?;
			draft
				.capture_turn_replay(replay.turn, replay.request, outcome)
				.map_err(|_| session_error(context, ErrorKind::SessionConflict, RetryAction::Never))?;
		}
		draft.append(Arc::from([assistant]));
		let capture_binding =
			matches!(self.prepared.session.strategy, ContextStrategy::ServerState(_))
				&& provider_state.iter().any(|event| {
					matches!(
						event,
						ProviderStateEvent::Continuation { .. } | ProviderStateEvent::Checkpoint { .. }
					)
				});
		if capture_binding {
			let account = context.account_routing().ok_or_else(|| {
				session_error(context, ErrorKind::SessionConflict, RetryAction::Never)
			})?;
			let principal = account.principal.ok_or_else(|| {
				session_error(context, ErrorKind::SessionConflict, RetryAction::Never)
			})?;
			let generation = account.credential_generation.ok_or_else(|| {
				session_error(context, ErrorKind::SessionConflict, RetryAction::Never)
			})?;
			let handle = postcard::to_allocvec(
				&provider_state
					.into_iter()
					.map(StoredProviderStateEvent::from)
					.collect::<Vec<_>>(),
			)
			.map(Bytes::from)
			.map_err(|_| session_error(context, ErrorKind::SessionConflict, RetryAction::Never))?;
			draft
				.commit_successful_turn(PendingServerStateBinding {
					conversation: self.prepared.session.conversation.clone(),
					route: self.prepared.route.clone(),
					model: self.prepared.model.clone(),
					principal,
					trust_domain: context
						.effective_trust_domain()
						.unwrap_or_else(|| self.prepared.trust_domain.clone()),
					credential_generation: generation,
					credential_policy: self.prepared.credential_policy,
					created_at: SystemTime::now(),
					expires_at: None,
					handle,
				})
				.map_err(|_| session_error(context, ErrorKind::SessionConflict, RetryAction::Never))?;
		} else {
			draft
				.commit()
				.map_err(|_| session_error(context, ErrorKind::SessionConflict, RetryAction::Never))?;
		}
		self.prepared_turns.lock().remove(&self.prepared.request);
		self.replays.lock().remove(&self.prepared.request);
		Ok(())
	}

	fn abort(&self, retain_preparation: bool) {
		self.draft.lock().take();
		if retain_preparation {
			self
				.prepared_turns
				.lock()
				.insert(self.prepared.request.clone(), self.prepared.clone());
		} else {
			self.prepared_turns.lock().remove(&self.prepared.request);
			self.replays.lock().remove(&self.prepared.request);
		}
	}
}

fn provider_context_strategy(strategy: CatalogContextStrategy) -> ContextStrategy {
	match strategy {
		CatalogContextStrategy::Replay => ContextStrategy::Replay,
		CatalogContextStrategy::PrefixCache(policy) => {
			let retention = if policy.retention.contains(CacheRetentionBits::LONG) {
				CacheRetention::Long
			} else if policy.retention.contains(CacheRetentionBits::STANDARD) {
				CacheRetention::Session
			} else {
				CacheRetention::Request
			};
			ContextStrategy::PrefixCache(PrefixCachePolicy { retention, allow_reseed: true })
		},
		CatalogContextStrategy::ServerState(policy) => {
			ContextStrategy::ServerState(ServerStatePolicy {
				allow_reseed: true,
				max_age:      policy.maximum_lifetime_ms.map(Duration::from_millis),
			})
		},
	}
}

fn session_error(context: &ExecutionContext, kind: ErrorKind, action: RetryAction) -> Error {
	Error::new(kind, ErrorPhase::Session, action, context.receipt())
}

#[cfg(test)]
mod tests {
	use std::{
		collections::{BTreeMap, HashMap},
		sync::{Arc, Barrier},
		thread,
		time::{Duration, Instant, SystemTime},
	};

	use bytes::Bytes;
	use omp_catalog::{
		OperationKind,
		id::{CodecId, ModelKey, ProviderId, RouteId},
		provider::{RedirectTrust, TrustDomain},
		snapshot::Catalog,
	};
	use omp_core::{Str, sf};
	use parking_lot::Mutex;

	use super::{
		ContextPlan, ConversationSessionPlanner, DurableCompletion, HistoryDelta, PlannerStore,
		PreparedTurn, StoredContent, StoredMessage, StoredRole, StoredToolResult,
		binding::{
			BindingContext, BindingValidity, CredentialGenerationPolicy, PendingServerStateBinding,
			ProviderExpiryDecision, ReseedReason, ReseedState,
		},
		conversation::MessagePersistenceError,
		detect_cross_turn_loop, plan_context,
		store::{ConversationStore, InMemoryConversationStore, SqliteConversationStore},
	};
	use crate::{
		account::AccountChangeEvidence,
		body::{AttemptBodyEvidence, BodySource, Replayability, RetryDecision, RetryDecisionReason},
		call::{
			Call, CallMeta, ChatRequest, ContentPart, ContextStrategy, MediaInput, Message,
			NegotiationPolicy, OperationCall, ProviderProof, Role, Sampling, ServerStatePolicy,
			SessionRequest, Setting, Target,
		},
		id::{AccountId, ConversationId, PrincipalId, RequestId, Revision, ToolCallId, TurnId},
		layer::{
			ExecutionContext,
			session::{SessionAction, SessionCompletion},
		},
		plan::{
			CapabilityAvailability, ExecutionPlan, FallbackScope, ReplayPlan, RouteHealth,
			RuntimeRouteEvidence,
		},
		receipt::{ExecutionBudget, RecoveryKind},
	};

	fn trust(origin: &str) -> TrustDomain {
		TrustDomain {
			origin:          Str::new(origin),
			redirects:       RedirectTrust::SameOrigin,
			allow_plaintext: false,
		}
	}
	#[test]
	fn committed_history_drives_cross_turn_tool_redirect_detection() {
		let mut items = Vec::new();
		for index in 0..3 {
			let call = ToolCallId::new(format!("call-{index}"));
			items.push(StoredMessage {
				role:    StoredRole::Assistant,
				content: Arc::from([StoredContent::ToolCall {
					call:      call.clone(),
					name:      Str::new_static("lookup"),
					arguments: Bytes::from_static(br#"{"key":"same"}"#),
					proof:     None,
				}]),
				name:    None,
			});
			items.push(StoredMessage {
				role:    StoredRole::Tool,
				content: Arc::from([StoredContent::ToolResult {
					call,
					name: Some(Str::new_static("lookup")),
					content: Arc::from([StoredToolResult::Json(Bytes::from_static(br#"{"value":1}"#))]),
					is_error: false,
				}]),
				name:    None,
			});
		}
		let history = HistoryDelta::new(None, Revision::new("revision-3"), vec![Arc::from(items)]);
		let signal = detect_cross_turn_loop(&history, &[]).expect("third repeated turn redirects");
		assert_eq!(signal.evidence.kind, crate::recovery::repetition::LoopKind::CrossTurnTool);
	}

	fn pending(
		conversation: ConversationId,
		route: &str,
		model: &str,
		principal: &str,
		created_at: SystemTime,
	) -> PendingServerStateBinding {
		PendingServerStateBinding {
			conversation,
			route: RouteId::new(route),
			model: ModelKey::new(model),
			principal: PrincipalId::new(principal),
			trust_domain: trust("https://route.test"),
			credential_generation: 1,
			credential_policy: CredentialGenerationPolicy::PrincipalBound,
			created_at,
			expires_at: None,
			handle: Bytes::from_static(b"opaque"),
		}
	}

	fn context<'a>(
		conversation: &'a ConversationId<str>,
		route: &'a RouteId<str>,
		model: &'a ModelKey<str>,
		principal: &'a PrincipalId<str>,
		trust_domain: &'a TrustDomain,
		now: SystemTime,
	) -> BindingContext<'a> {
		BindingContext {
			conversation,
			route,
			model,
			principal,
			account_change: None,
			trust_domain,
			credential_generation: 2,
			now,
			max_age: Some(Duration::from_secs(3600)),
		}
	}

	#[test]
	fn durable_message_round_trip_preserves_provider_scoped_proof() {
		let message = Message {
			role:    Role::Assistant,
			content: Arc::from([ContentPart::Text {
				text:  sf!("answer"),
				proof: Some(ProviderProof {
					provider: ProviderId::new("provider"),
					codec:    CodecId::new("codec"),
					value:    Bytes::from_static(b"signed"),
				}),
			}]),
			name:    None,
		};
		let stored = StoredMessage::try_from(&message).unwrap();
		let bytes = postcard::to_allocvec(&stored).unwrap();
		let decoded: StoredMessage = postcard::from_bytes(&bytes).unwrap();
		let restored = Message::try_from(decoded).unwrap();
		match &restored.content[0] {
			ContentPart::Text { text, proof: Some(proof) } => {
				assert_eq!(text.as_str(), "answer");
				assert_eq!(proof.provider.as_str(), "provider");
				assert_eq!(proof.codec.as_str(), "codec");
				assert_eq!(proof.value, Bytes::from_static(b"signed"));
			},
			_ => panic!("durable content changed shape"),
		}
	}

	#[test]
	fn durable_message_rejects_multipart_wire_body() {
		let message = Message {
			role:    Role::User,
			content: Arc::from([ContentPart::Image(MediaInput::Body {
				media_type: sf!("image/png"),
				body:       BodySource::multipart(Arc::from([BodySource::bytes(Bytes::from_static(
					b"wire",
				))])),
				name:       Some(sf!("input.png")),
			})]),
			name:    None,
		};
		assert_eq!(StoredMessage::try_from(&message), Err(MessagePersistenceError::UnstagedBody));
	}
	#[test]
	fn reseed_abort_reopens_fresh_root_draft_and_commits_binding_to_new_revision() {
		let store = Arc::new(InMemoryConversationStore::new());
		let root = store.create().unwrap();
		let input = Arc::from([StoredMessage {
			role:    StoredRole::User,
			content: Arc::from([]),
			name:    None,
		}]);
		let prepared = PreparedTurn {
			request:           RequestId::new("request"),
			session:           SessionRequest {
				conversation:   root.conversation().to_owned(),
				revision:       root.revision().to_owned(),
				turn:           TurnId::new("turn"),
				strategy:       server_strategy(),
				append_only:    true,
				provider_reset: false,
				forked:         false,
			},
			input:             Arc::clone(&input),
			provider:          ProviderId::new("provider"),
			codec:             CodecId::new("codec"),
			route:             RouteId::new("route"),
			model:             ModelKey::new("model"),
			trust_domain:      trust("https://route.test"),
			credential_policy: CredentialGenerationPolicy::PrincipalBound,
		};
		let planner_store = PlannerStore::Memory(Arc::clone(&store));
		let draft = planner_store
			.begin(
				&prepared.session.conversation,
				&prepared.session.revision,
				prepared.session.turn.clone(),
				Arc::clone(&input),
			)
			.unwrap();
		let prepared_turns = Arc::new(Mutex::new(HashMap::new()));
		let completion = DurableCompletion {
			draft:          Mutex::new(Some(draft)),
			blocks:         Mutex::new(BTreeMap::new()),
			completion:     Mutex::new(None),
			prepared:       prepared.clone(),
			prepared_turns: Arc::clone(&prepared_turns),
			replays:        Arc::new(Mutex::new(HashMap::new())),
		};
		SessionCompletion::abort(&completion, true);
		assert_eq!(store.active_drafts(), 0);
		let restored = prepared_turns.lock().remove(&prepared.request).unwrap();
		let fresh = planner_store
			.begin(
				&restored.session.conversation,
				&restored.session.revision,
				restored.session.turn,
				restored.input,
			)
			.unwrap();
		let committed = fresh
			.commit_successful_turn(pending(
				root.conversation().to_owned(),
				"route",
				"model",
				"principal",
				SystemTime::UNIX_EPOCH,
			))
			.unwrap();
		assert_eq!(committed.parent(), Some(root.revision()));
		assert_eq!(
			store
				.server_state(root.conversation())
				.unwrap()
				.unwrap()
				.key
				.base_revision,
			committed.revision().to_owned(),
		);
	}

	fn server_strategy() -> ContextStrategy {
		ContextStrategy::ServerState(ServerStatePolicy {
			allow_reseed: true,
			max_age:      Some(Duration::from_secs(3600)),
		})
	}
	#[test]
	fn explicit_fork_reseeds_replay_and_records_one_recovery() {
		let catalog = Arc::new(Catalog::try_embedded().expect("embedded catalog").clone());
		let (model, route) = catalog
			.models()
			.iter()
			.find_map(|model| {
				if !model
					.capabilities
					.operations
					.contains_kind(OperationKind::Chat)
				{
					return None;
				}
				model
					.routes
					.iter()
					.find_map(|route| catalog.route(route))
					.map(|route| (model, route))
			})
			.expect("catalog chat route");
		let store = Arc::new(InMemoryConversationStore::new());
		let root = store.create().expect("conversation root");
		let planner =
			ConversationSessionPlanner::with_in_memory(Arc::clone(&store), Arc::clone(&catalog));
		let budget = ExecutionBudget::default();
		let plan = ExecutionPlan {
			planned_at:          SystemTime::UNIX_EPOCH,
			catalog_revision:    catalog.revision().clone(),
			registry_generation: 1,
			expires_at:          Instant::now() + Duration::from_secs(60),
			operation:           OperationKind::Chat,
			model:               Some(model.key.clone()),
			provider:            route.provider.clone(),
			route:               route.id.clone(),
			codec:               route.codec.clone(),
			policy_model:        None,
			wire_policy:         Arc::new(
				catalog
					.wire_policy(&model.wire_policy)
					.expect("model wire policy")
					.clone(),
			),
			thinking_policy:     None,
			thinking_selection:  None,
			decisions:           Arc::from([]),
			fallback_scope:      FallbackScope { primary: None, explicit: Arc::from([]) },
			fallbacks:           Arc::from([]),
			replay:              ReplayPlan::Replayable,
			budget:              budget.clone(),
			runtime_evidence:    RuntimeRouteEvidence {
				route:            route.id.clone(),
				generation:       1,
				health:           RouteHealth::Healthy,
				quota_millionths: 1_000_000,
				latency:          Duration::ZERO,
				affinity:         false,
				operation:        CapabilityAvailability::Native,
				capabilities:     Arc::from([]),
			},
			wire_target:         None,
		};
		let mut call = Call::new(
			CallMeta {
				id: RequestId::new("fork-request"),
				target: Target::Route { route: route.id.clone(), model: model.key.clone() },
				deadline: None,
				budget,
				session: Some(SessionRequest {
					conversation:   root.conversation().to_owned(),
					revision:       root.revision().to_owned(),
					turn:           TurnId::new("fork-turn"),
					strategy:       ContextStrategy::Replay,
					append_only:    true,
					provider_reset: false,
					forked:         true,
				}),
				debug_session: None,
				response_hooks: Default::default(),
			},
			OperationCall::Chat(Arc::new(ChatRequest {
				messages:          Arc::from([]),
				tools:             Arc::from([]),
				hosted_tools:      Arc::from([]),
				tool_choice:       Setting::Unset,
				output:            Setting::Unset,
				reasoning:         Setting::Unset,
				verbosity:         Setting::Unset,
				cache_retention:   Setting::Unset,
				service_tier:      Setting::Unset,
				sampling:          Sampling::default(),
				max_output_tokens: None,
				top_logprobs:      None,
				safety:            Arc::from([]),
				negotiation:       NegotiationPolicy::default(),
				forced_call:       None,
			})),
		);
		call.execution = Some(Arc::new(plan));
		let context = ExecutionContext::new(ExecutionBudget::default());

		assert_eq!(
			planner
				.prepare_inner(&mut call, &context, false, None)
				.expect("fork plan"),
			SessionAction::Reseed
		);
		let prepared_plan = call.execution.as_ref().expect("prepared execution plan");
		assert_eq!(prepared_plan.model.as_ref(), Some(&model.key));
		assert_eq!(prepared_plan.provider, route.provider);
		assert_eq!(prepared_plan.route, route.id);
		let receipt = context.receipt();
		assert_eq!(receipt.recoveries.len(), 1);
		assert_eq!(receipt.recoveries[0].kind, RecoveryKind::SessionReseed);
		assert_eq!(receipt.recoveries[0].rule.0.as_str(), "Fork");
	}

	#[test]
	fn first_server_turn_replays_then_compatible_turn_sends_only_delta() {
		let store = InMemoryConversationStore::new();
		let root = store.create().unwrap();
		let first = store
			.begin(root.conversation(), root.revision(), TurnId::new("one"), Arc::from([1]))
			.unwrap();
		let first = first.commit().unwrap();
		let initial =
			plan_context::<i32, _>(&store, &server_strategy(), first.revision(), None, None).unwrap();
		assert!(matches!(initial, ContextPlan::Replay {
			capture_server_state: true,
			reason: Some(ReseedReason::FirstTurn),
			..
		}));

		let now = SystemTime::UNIX_EPOCH + Duration::from_secs(100);
		let mut captured = store
			.begin(first.conversation(), first.revision(), TurnId::new("capture"), Arc::from([2]))
			.unwrap();
		captured
			.capture_server_state(pending(
				first.conversation().to_owned(),
				"route",
				"model",
				"principal",
				now,
			))
			.unwrap();
		let captured = captured.commit().unwrap();
		let binding = store.server_state(first.conversation()).unwrap().unwrap();
		assert_eq!(binding.key.base_revision, *captured.revision());

		let next = store
			.begin(first.conversation(), captured.revision(), TurnId::new("next"), Arc::from([3]))
			.unwrap()
			.commit()
			.unwrap();
		let route = RouteId::new("route");
		let model = ModelKey::new("model");
		let principal = PrincipalId::new("principal");
		let domain = trust("https://route.test");
		let scope = context(first.conversation(), &route, &model, &principal, &domain, now);
		let plan =
			plan_context(&store, &server_strategy(), next.revision(), Some(&binding), Some(&scope))
				.unwrap();
		match plan {
			ContextPlan::ServerState { delta, .. } => {
				assert_eq!(delta.items().copied().collect::<Vec<_>>(), vec![3]);
			},
			other => panic!("expected compatible delta, got {other:?}"),
		}
	}

	#[test]
	fn fork_reseeds_once_then_resumes_deltas() {
		let store = InMemoryConversationStore::new();
		let root = store.create().unwrap();
		let now = SystemTime::UNIX_EPOCH + Duration::from_secs(100);
		let mut original = store
			.begin(root.conversation(), root.revision(), TurnId::new("one"), Arc::from([1]))
			.unwrap();
		original
			.capture_server_state(pending(
				root.conversation().to_owned(),
				"route",
				"model",
				"principal",
				now,
			))
			.unwrap();
		let original = original.commit().unwrap();
		let old_binding = store.server_state(root.conversation()).unwrap().unwrap();
		let fork = store.fork(original.revision()).unwrap();
		let route = RouteId::new("route");
		let model = ModelKey::new("model");
		let principal = PrincipalId::new("principal");
		let domain = trust("https://route.test");
		let fork_scope = context(&fork, &route, &model, &principal, &domain, now);
		assert!(matches!(
			plan_context::<i32, _>(
				&store,
				&server_strategy(),
				original.revision(),
				Some(&old_binding),
				Some(&fork_scope)
			)
			.unwrap(),
			ContextPlan::Replay { reason: Some(ReseedReason::Fork), .. }
		));

		let mut reseed = store
			.begin(&fork, original.revision(), TurnId::new("fork-reseed"), Arc::from([2]))
			.unwrap();
		reseed
			.capture_server_state(pending(fork.clone(), "route", "model", "principal", now))
			.unwrap();
		let reseed = reseed.commit().unwrap();
		let fork_binding = store.server_state(&fork).unwrap().unwrap();
		let next = store
			.begin(&fork, reseed.revision(), TurnId::new("fork-next"), Arc::from([3]))
			.unwrap()
			.commit()
			.unwrap();
		assert!(matches!(
			plan_context(
				&store,
				&server_strategy(),
				next.revision(),
				Some(&fork_binding),
				Some(&fork_scope)
			)
			.unwrap(),
			ContextPlan::ServerState { .. }
		));
	}

	#[test]
	fn binding_scope_changes_have_deterministic_reseed_reasons() {
		let now = SystemTime::UNIX_EPOCH + Duration::from_secs(100);
		let pending =
			pending(ConversationId::new("conversation"), "route", "model", "principal", now);
		let binding = pending.commit(Revision::new("revision"));
		let conversation = ConversationId::new("conversation");
		let route = RouteId::new("route");
		let model = ModelKey::new("model");
		let principal = PrincipalId::new("principal");
		let domain = trust("https://route.test");
		let mut scope = context(&conversation, &route, &model, &principal, &domain, now);
		assert_eq!(binding.validity(&scope, true), BindingValidity::Compatible);

		let changed_route = RouteId::new("other-route");
		scope.route = &changed_route;
		assert_eq!(
			binding.validity(&scope, true),
			BindingValidity::Reseed(ReseedReason::RouteChanged)
		);
		scope.route = &route;
		let changed_model = ModelKey::new("other-model");
		scope.model = &changed_model;
		assert_eq!(
			binding.validity(&scope, true),
			BindingValidity::Reseed(ReseedReason::ModelChanged)
		);
		scope.model = &model;
		let changed_domain = trust("https://other.test");
		scope.trust_domain = &changed_domain;
		assert_eq!(
			binding.validity(&scope, true),
			BindingValidity::Reseed(ReseedReason::TrustDomainChanged)
		);
		scope.trust_domain = &domain;
		let changed_principal = PrincipalId::new("other-principal");
		scope.principal = &changed_principal;
		assert_eq!(
			binding.validity(&scope, true),
			BindingValidity::Reseed(ReseedReason::PrincipalChanged)
		);
		scope.principal = &principal;
		let account_change = AccountChangeEvidence::new(
			Some(AccountId::new("old")),
			Some(principal.clone()),
			AccountId::new("new"),
			principal.clone(),
			now,
		);
		scope.account_change = Some(&account_change);
		assert_eq!(
			binding.validity(&scope, true),
			BindingValidity::Reseed(ReseedReason::AccountChanged)
		);
	}

	#[test]
	fn ordinary_same_principal_refresh_preserves_principal_bound_state() {
		let now = SystemTime::UNIX_EPOCH + Duration::from_secs(100);
		let binding =
			pending(ConversationId::new("conversation"), "route", "model", "principal", now)
				.commit(Revision::new("revision"));
		let conversation = ConversationId::new("conversation");
		let route = RouteId::new("route");
		let model = ModelKey::new("model");
		let principal = PrincipalId::new("principal");
		let domain = trust("https://route.test");
		let scope = context(&conversation, &route, &model, &principal, &domain, now);
		assert_eq!(binding.validity(&scope, true), BindingValidity::Compatible);

		let mut generation_bound = binding;
		generation_bound.key.credential_policy =
			CredentialGenerationPolicy::CredentialGenerationBound;
		assert_eq!(
			generation_bound.validity(&scope, true),
			BindingValidity::Reseed(ReseedReason::CredentialGenerationChanged)
		);
	}

	#[test]
	fn expired_binding_is_classified_before_attempt_as_provider_expiry() {
		let created = SystemTime::UNIX_EPOCH + Duration::from_secs(100);
		let mut pending =
			pending(ConversationId::new("conversation"), "route", "model", "principal", created);
		pending.expires_at = Some(created + Duration::from_secs(10));
		let binding = pending.commit(Revision::new("revision"));
		let conversation = ConversationId::new("conversation");
		let route = RouteId::new("route");
		let model = ModelKey::new("model");
		let principal = PrincipalId::new("principal");
		let domain = trust("https://route.test");
		let scope = context(
			&conversation,
			&route,
			&model,
			&principal,
			&domain,
			created + Duration::from_secs(10),
		);
		assert_eq!(
			binding.validity(&scope, true),
			BindingValidity::Reseed(ReseedReason::ProviderExpired),
		);
	}

	fn replayable() -> AttemptBodyEvidence {
		AttemptBodyEvidence {
			opened:         true,
			consumed:       true,
			replayability:  Replayability::Replayable,
			retry_decision: RetryDecision::Allow,
			reason:         RetryDecisionReason::ReplayableSource,
		}
	}

	#[test]
	fn provider_expiry_reseeds_once_precommit_and_is_partial_postcommit() {
		let mut precommit = ReseedState::default();
		assert_eq!(
			precommit.on_provider_expiry(true, &replayable()),
			ProviderExpiryDecision::ReseedOnce
		);
		assert_eq!(
			precommit.on_provider_expiry(true, &replayable()),
			ProviderExpiryDecision::FailUncommitted
		);

		let mut postcommit = ReseedState::default();
		postcommit.mark_committed();
		assert_eq!(
			postcommit.on_provider_expiry(true, &replayable()),
			ProviderExpiryDecision::FailPartial
		);
	}

	#[test]
	fn consumed_one_shot_body_suppresses_precommit_reseed() {
		let consumed = AttemptBodyEvidence {
			opened:         true,
			consumed:       true,
			replayability:  Replayability::OneShot,
			retry_decision: RetryDecision::Suppress,
			reason:         RetryDecisionReason::ConsumedOneShot,
		};
		assert_eq!(
			ReseedState::default().on_provider_expiry(true, &consumed),
			ProviderExpiryDecision::FailUncommitted,
		);
	}

	#[test]
	fn draft_drop_rolls_back_and_concurrent_same_turn_commit_is_idempotent() {
		let store = Arc::new(InMemoryConversationStore::new());
		let root = store.create().unwrap();
		let dropped = store
			.begin(root.conversation(), root.revision(), TurnId::new("drop"), Arc::from([0]))
			.unwrap();
		assert_eq!(store.active_drafts(), 1);
		drop(dropped);
		assert_eq!(store.active_drafts(), 0);
		assert_eq!(store.head(root.conversation()).unwrap().revision(), root.revision());

		let first = store
			.begin(root.conversation(), root.revision(), TurnId::new("same"), Arc::from([1]))
			.unwrap();
		let second = store
			.begin(root.conversation(), root.revision(), TurnId::new("same"), Arc::from([1]))
			.unwrap();
		let barrier = Arc::new(Barrier::new(2));
		let left_barrier = Arc::clone(&barrier);
		let left = thread::spawn(move || {
			left_barrier.wait();
			first.commit().unwrap()
		});
		let right_barrier = Arc::clone(&barrier);
		let right = thread::spawn(move || {
			right_barrier.wait();
			second.commit().unwrap()
		});
		let left = left.join().unwrap();
		let right = right.join().unwrap();
		assert_eq!(left.revision(), right.revision());
		assert_eq!(
			store
				.delta(Some(root.revision()), left.revision())
				.unwrap()
				.items()
				.copied()
				.collect::<Vec<_>>(),
			vec![1]
		);
	}

	#[test]
	fn sqlite_store_obeys_commit_fork_delta_and_idempotency_laws() {
		let store = SqliteConversationStore::open_in_memory().unwrap();
		let root = store.create().unwrap();
		let first = store
			.begin(root.conversation(), root.revision(), TurnId::new("same"), Arc::from([1_i32]))
			.unwrap()
			.commit()
			.unwrap();
		let repeated = store
			.begin(root.conversation(), root.revision(), TurnId::new("same"), Arc::from([1_i32]))
			.unwrap()
			.commit()
			.unwrap();
		assert_eq!(first.revision(), repeated.revision());
		assert_eq!(
			store
				.committed_turn(root.conversation(), TurnId::from_ref("same"))
				.unwrap()
				.unwrap()
				.revision(),
			first.revision()
		);
		let fork = store.fork(first.revision()).unwrap();
		let next = store
			.begin(&fork, first.revision(), TurnId::new("fork"), Arc::from([2_i32]))
			.unwrap()
			.commit()
			.unwrap();
		assert_eq!(
			store
				.delta(Some(first.revision()), next.revision())
				.unwrap()
				.items()
				.copied()
				.collect::<Vec<_>>(),
			vec![2]
		);
	}

	#[test]
	fn sqlite_turn_replay_survives_reopen_and_rejects_payload_reuse() {
		let state = tempfile::tempdir().unwrap();
		let database = state.path().join("turns.db");
		let turn = TurnId::new("durable-turn");
		{
			let store = SqliteConversationStore::<i32>::open(&database).unwrap();
			store
				.commit_turn_replay(
					turn.clone(),
					Bytes::from_static(b"request"),
					Bytes::from_static(b"outcome"),
				)
				.unwrap();
		}
		let reopened = SqliteConversationStore::<i32>::open(&database).unwrap();
		assert_eq!(
			reopened.turn_replay(&turn).unwrap(),
			Some(super::store::TurnReplay {
				request: Bytes::from_static(b"request"),
				outcome: Bytes::from_static(b"outcome"),
			})
		);
		assert!(matches!(
			reopened.commit_turn_replay(
				turn.clone(),
				Bytes::from_static(b"different"),
				Bytes::from_static(b"outcome"),
			),
			Err(super::ConversationError::TurnConflict(conflict)) if conflict == turn
		));
	}

	#[test]
	fn sqlite_turn_commit_publishes_history_and_replay_together() {
		let state = tempfile::tempdir().unwrap();
		let database = state.path().join("atomic-turns.db");
		let turn = TurnId::new("atomic-turn");
		let conversation;
		let revision;
		{
			let store = SqliteConversationStore::<i32>::open(&database).unwrap();
			let root = store.create().unwrap();
			conversation = root.conversation().to_owned();
			revision = root.revision().to_owned();

			let mut dropped = store
				.begin(&conversation, &revision, TurnId::new("dropped"), Arc::from([7]))
				.unwrap();
			dropped
				.capture_turn_replay(
					TurnId::new("dropped"),
					Bytes::from_static(b"dropped-request"),
					Bytes::from_static(b"dropped-outcome"),
				)
				.unwrap();
			drop(dropped);
			assert!(
				store
					.turn_replay(TurnId::from_ref("dropped"))
					.unwrap()
					.is_none()
			);
			assert!(
				store
					.committed_turn(&conversation, TurnId::from_ref("dropped"))
					.unwrap()
					.is_none()
			);

			let mut draft = store
				.begin(&conversation, &revision, turn.clone(), Arc::from([9]))
				.unwrap();
			draft
				.capture_turn_replay(
					turn.clone(),
					Bytes::from_static(b"request"),
					Bytes::from_static(b"outcome"),
				)
				.unwrap();
			draft.commit().unwrap();
		}

		let reopened = SqliteConversationStore::<i32>::open(&database).unwrap();
		assert_eq!(
			reopened
				.committed_turn(&conversation, &turn)
				.unwrap()
				.unwrap()
				.items(),
			&[9]
		);
		assert_eq!(
			reopened.turn_replay(&turn).unwrap(),
			Some(super::store::TurnReplay {
				request: Bytes::from_static(b"request"),
				outcome: Bytes::from_static(b"outcome"),
			})
		);

		let mut conflict = reopened
			.begin(&conversation, &revision, turn.clone(), Arc::from([9]))
			.unwrap();
		conflict
			.capture_turn_replay(
				turn.clone(),
				Bytes::from_static(b"different"),
				Bytes::from_static(b"outcome"),
			)
			.unwrap();
		assert!(matches!(
			conflict.commit(),
			Err(super::ConversationError::TurnConflict(conflicting)) if conflicting == turn
		));
	}
}
