//! Clone-cheap request envelopes and the closed operation vocabulary.

use std::{
	fmt,
	sync::Arc,
	time::{Duration, Instant, SystemTime},
};

use bytes::Bytes;
use omp_core::{SecretString, Str, encoding::hex, sf};
use omp_proto::thread::v1::{self as thread_pb, item, part};
use serde_json::{Value, value::RawValue};
use strum::IntoStaticStr;

use crate::{
	answer::ArtifactRef,
	body::{BodySource, NativeBodySource},
	catalog::{CodecId, ModelKey, OperationKind, ProviderId, ReasoningEffort, RouteId, ServiceTier},
	id::{
		AccountId, ConversationId, LoginSessionId, OrganizationId, PrincipalId, ProjectId, RegionId,
		RequestId, Revision, TenantId, ToolCallId, TurnId,
	},
	operation::{parallel_extract::ParallelExtractRequest, search_query, search_query::SearchQuery},
	plan::ExecutionPlan,
	receipt::ExecutionBudget,
	staging::{StagingCancellation, StagingPolicy},
};

/// A shared, explicitly opaque JSON value.
///
/// This type is reserved for schemas, tool arguments/results, and native
/// payloads.
#[derive(Clone, Debug)]
pub struct OpaqueJson(pub Arc<Value>);

impl OpaqueJson {
	/// Stores a JSON value behind a clone-cheap shared pointer.
	pub fn new(value: Value) -> Self {
		Self(Arc::new(value))
	}

	/// Borrows the opaque value without interpreting its wire shape.
	pub fn as_value(&self) -> &Value {
		&self.0
	}
}

/// Exact validated JSON wire bytes for lossless native operations.
#[derive(Clone)]
pub struct RawJson(Bytes);

impl RawJson {
	/// Validates one complete JSON value within an explicit byte bound.
	pub fn new(bytes: Bytes, maximum_bytes: u64) -> Result<Self, RawJsonError> {
		if bytes.len() as u64 > maximum_bytes {
			return Err(RawJsonError::TooLarge);
		}
		let _: &RawValue = serde_json::from_slice(&bytes).map_err(|_| RawJsonError::Invalid)?;
		Ok(Self(bytes))
	}

	/// Borrows the exact validated UTF-8 wire bytes.
	pub fn as_bytes(&self) -> &[u8] {
		&self.0
	}

	/// Returns the exact validated bytes without copying.
	pub fn into_bytes(self) -> Bytes {
		self.0
	}
}

impl fmt::Debug for RawJson {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter
			.debug_struct("RawJson")
			.field("bytes", &self.0.len())
			.finish()
	}
}

/// Secret-free validation failure for exact native JSON bytes.
#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum RawJsonError {
	/// Input exceeded the caller-provided size bound.
	#[error("native JSON exceeds size bound")]
	TooLarge,
	/// Input was not exactly one complete JSON value.
	#[error("invalid native JSON")]
	Invalid,
}

/// Selects the catalog domain within which routing must occur.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Target {
	/// Route any eligible deployment of the normalized model.
	Model(ModelKey),
	/// Restrict a normalized model to one provider domain.
	Provider {
		/// Required provider domain.
		provider: ProviderId,
		/// Normalized model within that domain.
		model:    ModelKey,
	},
	/// Pin execution to one concrete route and normalized model.
	Route {
		/// Concrete route.
		route: RouteId,
		/// Normalized model served by the route.
		model: ModelKey,
	},
	/// Address a provider-scoped management operation that has no model.
	ProviderService(ProviderId),
	/// Address a route-scoped management operation that has no model.
	RouteService(RouteId),
}

/// Session context attached to an operation call.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SessionRequest {
	/// Conversation to append or query.
	pub conversation:   ConversationId,
	/// Immutable base revision.
	pub revision:       Revision,
	/// Idempotency identity for the new turn.
	pub turn:           TurnId,
	/// Requested context transport strategy.
	pub strategy:       ContextStrategy,
	/// Preserve a byte-stable prefix and admit only newly appended messages.
	pub append_only:    bool,
	/// Discard provider-native affinity before selecting an account.
	pub provider_reset: bool,
	/// Whether the caller deliberately forked from an earlier revision.
	pub forked:         bool,
}

/// Determines how canonical conversation context reaches a provider.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ContextStrategy {
	/// Replay canonical history on every turn.
	Replay,
	/// Replay while deriving stable provider cache breakpoints.
	PrefixCache(PrefixCachePolicy),
	/// Use typed provider-side state when its binding remains valid.
	ServerState(ServerStatePolicy),
}

/// Policy for provider prompt-prefix caching.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PrefixCachePolicy {
	/// Requested retention class.
	pub retention:    CacheRetention,
	/// Whether route changes may rebuild the prefix cache.
	pub allow_reseed: bool,
}

/// Policy for provider-side conversation state.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ServerStatePolicy {
	/// Whether an expired pre-commit binding may be replay-reseeded once.
	pub allow_reseed: bool,
	/// Maximum accepted binding age.
	pub max_age:      Option<Duration>,
}

/// Non-secret account metadata used for project-, tenant-, organization-, and
/// region-aware routing.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct AccountRoutingContext {
	/// Selected account when account identity is established.
	pub account:               Option<AccountId>,
	/// Authenticated principal when established.
	pub principal:             Option<PrincipalId>,
	/// Credential generation used only when route policy binds server state to
	/// it.
	pub credential_generation: Option<u64>,
	/// Selected cloud or billing project.
	pub project:               Option<ProjectId>,
	/// Selected tenant.
	pub tenant:                Option<TenantId>,
	/// Selected organization.
	pub organization:          Option<OrganizationId>,
	/// Selected routing or billing region.
	pub region:                Option<RegionId>,
}

/// Principal and extension charged for an inference request.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InferenceAttribution {
	/// Authenticated principal whose budget and receipts are charged.
	pub principal: PrincipalId,
	/// Extension identity whose per-turn and per-session ceilings apply.
	pub extension: Str,
}

impl InferenceAttribution {
	/// Attribution for harness-owned requests that have no extension caller.
	pub fn core() -> Self {
		Self { principal: PrincipalId::from("core"), extension: sf!("core") }
	}
}

/// Caller-stable identities that ride on every call regardless of whether a
/// provider conversation is bound.
///
/// Compatible codecs lower these opaque values to their native fields;
/// incompatible codecs ignore them. Neither value is a secret.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct CallAffinity {
	/// Invocation-scoped provider prompt-cache identity (`OpenAI`
	/// `prompt_cache_key`).
	pub prompt_cache:     Option<Str>,
	/// Caller session identity for provider-side attribution (Claude Code
	/// session header, Codex `session_id` metadata).
	pub provider_session: Option<Str>,
}

impl CallAffinity {
	/// Affinity that names nothing.
	pub const fn none() -> Self {
		Self { prompt_cache: None, provider_session: None }
	}
}

/// Shared metadata used to construct a closed call.
#[derive(Clone, Debug)]
pub struct CallMeta {
	/// Logical request identity.
	pub id:             RequestId,
	/// Catalog target and routing constraint.
	pub target:         Target,
	/// Absolute wall-clock deadline.
	pub deadline:       Option<Instant>,
	/// Cross-attempt resource limits.
	pub budget:         ExecutionBudget,
	/// Optional append-only conversation context.
	pub session:        Option<SessionRequest>,
	/// Observer-only session identity for bounded private wire capture.
	pub debug_session:  Option<Str>,
	/// Bitmap-gated provider request/response hook sink.
	pub response_hooks: crate::codec::ProviderResponseHooks,
}

/// Clone-cheap envelope accepted by every provider service.
#[derive(Clone, Debug)]
pub struct Call {
	/// Logical request identity.
	pub id:             RequestId,
	/// Catalog target and routing constraint.
	pub target:         Target,
	/// Absolute wall-clock deadline.
	pub deadline:       Option<Instant>,
	/// Cross-attempt resource limits.
	pub budget:         ExecutionBudget,
	/// Optional append-only conversation context.
	pub session:        Option<SessionRequest>,
	/// Observer-only session identity for bounded private wire capture.
	pub debug_session:  Option<Str>,
	/// Session-independent prompt-cache and provider-session identities.
	pub affinity:       CallAffinity,
	/// Bitmap-gated provider request/response hook sink.
	pub response_hooks: crate::codec::ProviderResponseHooks,
	/// Principal and extension charged for this request.
	pub attribution:    InferenceAttribution,
	/// Immutable selected execution plan; absent only before side-effect-free
	/// planning.
	pub execution:      Option<Arc<ExecutionPlan>>,
	/// Shared operation-specific request payload.
	pub operation:      OperationCall,
	/// Explicit secure-staging policy and cancellation signal, when authorized
	/// by the caller.
	pub staging:        Option<StagingRequest>,
}

/// Caller-owned policy and cancellation input for secure request-body staging.
#[derive(Clone, Debug)]
pub struct StagingRequest {
	/// Storage, encryption, and byte bounds for staging.
	pub policy:       StagingPolicy,
	/// Cancellation shared with staging and every resulting replayable reader.
	pub cancellation: StagingCancellation,
}

impl Call {
	/// Constructs a call from shared metadata and an operation payload.
	pub fn new(meta: CallMeta, operation: OperationCall) -> Self {
		Self {
			id: meta.id,
			target: meta.target,
			deadline: meta.deadline,
			budget: meta.budget,
			session: meta.session,
			debug_session: meta.debug_session,
			affinity: CallAffinity::none(),
			response_hooks: meta.response_hooks,
			attribution: InferenceAttribution::core(),
			operation,
			execution: None,
			staging: None,
		}
	}

	/// Replaces the default harness attribution before request dispatch.
	pub fn with_attribution(mut self, attribution: InferenceAttribution) -> Self {
		self.attribution = attribution;
		self
	}

	/// Attaches session-independent prompt-cache and provider-session
	/// identities.
	pub fn with_affinity(mut self, affinity: CallAffinity) -> Self {
		self.affinity = affinity;
		self
	}

	/// Authorizes secure staging for one-shot request bodies before execution.
	pub fn with_staging(mut self, policy: StagingPolicy, cancellation: StagingCancellation) -> Self {
		self.staging = Some(StagingRequest { policy, cancellation });
		self
	}
}

/// Closed clone-cheap operation request handled by the erased service center.
#[derive(Clone, Debug)]
pub enum OperationCall {
	/// Canonical chat generation.
	Chat(Arc<ChatRequest>),
	/// Prompt token counting.
	CountTokens(Arc<CountTokensRequest>),
	/// Text tokenization.
	Tokenize(Arc<TokenizeRequest>),
	/// Token detokenization.
	Detokenize(Arc<DetokenizeRequest>),
	/// Vector embedding.
	Embed(Arc<EmbedRequest>),
	/// Image generation or editing.
	GenerateImage(Arc<ImageRequest>),
	/// Video generation.
	GenerateVideo(Arc<VideoRequest>),
	/// Text-to-speech synthesis.
	Speak(Arc<SpeechRequest>),
	/// Speech transcription or translation.
	Transcribe(Arc<TranscriptionRequest>),
	/// Bidirectional realtime session creation.
	Realtime(Arc<RealtimeRequest>),
	/// Standalone ranked search.
	Search(Arc<SearchRequest>),
	/// Bounded Parallel document extraction.
	ParallelExtract(Arc<ParallelExtractRequest>),
	/// Account-scoped usage and quota query.
	Usage(Arc<UsageRequest>),
	/// Runtime model discovery.
	DiscoverModels(Arc<DiscoveryRequest>),
	/// Authentication and account management.
	Auth(Arc<AuthRequest>),
	/// Allowlisted lossless native wire operation.
	Native(Arc<NativeRequest>),
}

impl OperationCall {
	/// Returns the catalog operation kind without inspecting provider or model
	/// names.
	pub const fn kind(&self) -> OperationKind {
		match self {
			Self::Chat(_) => OperationKind::Chat,
			Self::CountTokens(_) => OperationKind::CountTokens,
			Self::Tokenize(_) => OperationKind::Tokenize,
			Self::Detokenize(_) => OperationKind::Detokenize,
			Self::Embed(_) => OperationKind::Embed,
			Self::GenerateImage(_) => OperationKind::GenerateImage,
			Self::GenerateVideo(_) => OperationKind::GenerateVideo,
			Self::Speak(_) => OperationKind::Speak,
			Self::Transcribe(_) => OperationKind::Transcribe,
			Self::Realtime(_) => OperationKind::Realtime,
			Self::Search(_) => OperationKind::Search,
			Self::ParallelExtract(_) => OperationKind::Extract,
			Self::Usage(_) => OperationKind::Usage,
			Self::DiscoverModels(_) => OperationKind::DiscoverModels,
			Self::Auth(_) => OperationKind::Auth,
			Self::Native(_) => OperationKind::Native,
		}
	}
}

/// Expresses whether an explicit setting is absent, required, or preferred.
#[derive(Clone, Debug, Default)]
pub enum Setting<T> {
	/// The caller expressed no preference.
	#[default]
	Unset,
	/// The request must fail if the setting cannot be satisfied.
	Require(T),
	/// The setting may be adjusted only with receipt evidence.
	Prefer(T),
}

/// Controls which capability emulations planning may use.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum EmulationPolicy {
	/// Reject every emulation.
	#[default]
	Forbid,
	/// Permit only semantics-preserving emulation.
	AllowLossless,
	/// Permit explicitly declared lossy emulation.
	AllowDeclaredLossy,
}

/// Controls treatment of capabilities whose support is unknown.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum UnknownCapabilityPolicy {
	/// Unknown cannot satisfy a requested setting.
	#[default]
	Reject,
	/// Unknown may satisfy preferences, but never requirements.
	AllowPreferences,
}

/// Controls a typed native-option and selected-codec mismatch.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum MismatchPolicy {
	/// Reject the mismatch.
	#[default]
	Reject,
	/// Drop only a preferred extension and record an adjustment.
	DropPreferred,
}

/// Capability negotiation policy shared by canonical requests.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct NegotiationPolicy {
	/// Permitted emulation strength.
	pub emulation:              EmulationPolicy,
	/// Unknown-capability treatment.
	pub unknown:                UnknownCapabilityPolicy,
	/// Native-option mismatch behavior.
	pub vendor_option_mismatch: MismatchPolicy,
}

/// Canonical conversational role.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Role {
	/// System-level control instruction.
	System,
	/// Developer-level control instruction.
	Developer,
	/// Human or caller input.
	User,
	/// Model output.
	Assistant,
	/// Tool-result input.
	Tool,
}

/// Opaque provider continuation proof scoped to the wire identity that created
/// it.
#[derive(Clone, Debug)]
pub struct ProviderProof {
	/// Provider that issued the proof.
	pub provider: ProviderId,
	/// Codec that can interpret and return the proof.
	pub codec:    CodecId,
	/// Opaque signed or otherwise provider-authenticated bytes.
	pub value:    Bytes,
}

/// Reference to an immutable or inline media input.
#[derive(Clone, Debug)]
pub enum MediaInput {
	/// Inline immutable bytes.
	Bytes {
		/// Declared media type.
		media_type: Str,
		/// Immutable payload.
		data:       Bytes,
	},
	/// Immutable content in an artifact store.
	Stored(ArtifactRef),
	/// Remote media identified by URI and typed display metadata.
	Remote {
		/// Remote URI.
		uri:        Str,
		/// Declared media type when known.
		media_type: Option<Str>,
		/// Display name when supplied.
		name:       Option<Str>,
	},
	/// Replay-aware owned body for streamed or factory-backed media.
	Body {
		/// Declared media type.
		media_type: Str,
		/// Replay-aware body source.
		body:       BodySource,
		/// Display name when supplied.
		name:       Option<Str>,
	},
}

/// One typed block returned by a tool.
#[derive(Clone, Debug)]
pub enum ToolResultContent {
	/// Plain text result.
	Text(Str),
	/// Opaque JSON result.
	Json(OpaqueJson),
	/// Image result.
	Image(MediaInput),
	/// Document result.
	Document(MediaInput),
}

impl ToolResultContent {
	/// Projects one canonical thread part used by a tool result.
	pub fn from_thread_part(part: &thread_pb::Part) -> Result<Self, ThreadProjectionError> {
		tool_result_from_thread(part)
	}
}

/// One canonical message content part.
#[derive(Clone, Debug)]
pub enum ContentPart {
	/// Visible text with an optional provider-scoped continuation proof.
	Text {
		/// Visible text.
		text:  Str,
		/// Provider-scoped continuation proof.
		proof: Option<ProviderProof>,
	},
	/// Historical model reasoning with an optional provider-scoped continuation
	/// proof.
	Reasoning {
		/// Reasoning text.
		text:  Str,
		/// Provider-scoped continuation proof.
		proof: Option<ProviderProof>,
	},
	/// Image content.
	Image(MediaInput),
	/// Audio content.
	Audio(MediaInput),
	/// Document content.
	Document(MediaInput),
	/// Historical fully assembled assistant tool invocation.
	ToolCall {
		/// Stable tool-call identity.
		call:      ToolCallId,
		/// Tool name.
		name:      Str,
		/// Validated opaque arguments.
		arguments: OpaqueJson,
		/// Provider-scoped continuation proof.
		proof:     Option<ProviderProof>,
	},
	/// Structured result for a previous tool call.
	ToolResult {
		/// Stable tool-call identity.
		call:     ToolCallId,
		/// Tool name when required by the wire protocol.
		name:     Option<Str>,
		/// Ordered typed result content.
		content:  Arc<[ToolResultContent]>,
		/// Whether tool execution failed.
		is_error: bool,
	},
	/// Explicit prompt-cache breakpoint in canonical history.
	CachePoint(CacheRetention),
}

/// One canonical conversation message.
#[derive(Clone, Debug)]
pub struct Message {
	/// Semantic author role.
	pub role:    Role,
	/// Ordered multimodal content.
	pub content: Arc<[ContentPart]>,
	/// Optional caller-facing author label.
	pub name:    Option<Str>,
}

impl Message {
	/// Projects canonical thread items into one inference message per item.
	///
	/// The one-to-one mapping is load-bearing for retained context revisions;
	/// provider-specific grouping belongs to codecs.
	pub fn from_thread_items(items: &[thread_pb::Item]) -> Result<Vec<Self>, ThreadProjectionError> {
		items
			.iter()
			.map(|item| match item.kind.as_ref() {
				Some(item::Kind::Message(message)) => message_from_thread(message),
				Some(item::Kind::ToolCall(call)) => Ok(Self {
					role:    Role::Assistant,
					content: Arc::from([ContentPart::ToolCall {
						call:      ToolCallId::from(call.id.as_str()),
						name:      call.name.as_str().into(),
						arguments: thread_opaque_json(&call.args_json, "ToolCall.args_json")?,
						proof:     None,
					}]),
					name:    None,
				}),
				Some(item::Kind::ToolResult(result)) => {
					let content = result
						.parts
						.iter()
						.map(tool_result_from_thread)
						.collect::<Result<Vec<_>, _>>()?;
					Ok(Self {
						role:    Role::Tool,
						content: Arc::from([ContentPart::ToolResult {
							call:     ToolCallId::from(result.call_id.as_str()),
							name:     (!result.name.is_empty()).then(|| result.name.as_str().into()),
							content:  content.into(),
							is_error: result.is_error,
						}]),
						name:    None,
					})
				},
				None => Err(ThreadProjectionError::MissingItemKind),
			})
			.collect()
	}
}

/// A canonical thread item cannot be represented by the inference contract.
#[derive(Debug, thiserror::Error)]
pub enum ThreadProjectionError {
	/// A thread item omitted its required kind.
	#[error("thread item kind is required")]
	MissingItemKind,
	/// A message omitted its required role.
	#[error("message role is required")]
	MissingMessageRole,
	/// A message part omitted its required kind.
	#[error("message part kind is required")]
	MissingPartKind,
	/// A reasoning signature was supplied without provider scope.
	#[error("unscoped reasoning signatures cannot enter canonical inference")]
	UnscopedReasoningSignature,
	/// A legacy part requires an explicit canonical projection.
	#[error("legacy fallback/server-tool parts require an explicit canonical projection")]
	LegacyPart,
	/// A tool result part has no canonical inference representation.
	#[error("tool result contains a part that has no canonical projection")]
	UnsupportedToolResultPart,
	/// A blob omitted its media type.
	#[error("blob media type is required")]
	MissingBlobMediaType,
	/// A blob supplied neither inline bytes nor a content hash.
	#[error("blob requires inline bytes or a content hash")]
	MissingBlobData,
	/// An opaque JSON field was malformed.
	#[error("{field} is invalid JSON")]
	InvalidJson {
		/// Stable field name.
		field:  &'static str,
		/// JSON decoding failure.
		#[source]
		source: serde_json::Error,
	},
}

fn message_from_thread(message: &thread_pb::Message) -> Result<Message, ThreadProjectionError> {
	let role = match thread_pb::Role::try_from(message.role).unwrap_or(thread_pb::Role::Unspecified)
	{
		thread_pb::Role::System => Role::System,
		thread_pb::Role::User => Role::User,
		thread_pb::Role::Assistant => Role::Assistant,
		thread_pb::Role::Unspecified => return Err(ThreadProjectionError::MissingMessageRole),
	};
	let content = message
		.parts
		.iter()
		.map(content_from_thread)
		.collect::<Result<Vec<_>, _>>()?;
	Ok(Message { role, content: content.into(), name: None })
}

fn content_from_thread(part: &thread_pb::Part) -> Result<ContentPart, ThreadProjectionError> {
	match part.kind.as_ref() {
		Some(part::Kind::Text(text)) => {
			Ok(ContentPart::Text { text: text.as_str().into(), proof: None })
		},
		Some(part::Kind::Thinking(thinking)) if thinking.signature.is_empty() => {
			Ok(ContentPart::Reasoning { text: thinking.text.as_str().into(), proof: None })
		},
		Some(part::Kind::Thinking(_)) => Err(ThreadProjectionError::UnscopedReasoningSignature),
		Some(part::Kind::Blob(blob)) => Ok(ContentPart::Image(media_from_thread(blob)?)),
		Some(part::Kind::Fallback(_) | part::Kind::ServerTool(_)) => {
			Err(ThreadProjectionError::LegacyPart)
		},
		None => Err(ThreadProjectionError::MissingPartKind),
	}
}

fn tool_result_from_thread(
	part: &thread_pb::Part,
) -> Result<ToolResultContent, ThreadProjectionError> {
	match part.kind.as_ref() {
		Some(part::Kind::Text(text)) => Ok(ToolResultContent::Text(text.as_str().into())),
		Some(part::Kind::Blob(blob)) => Ok(ToolResultContent::Document(media_from_thread(blob)?)),
		_ => Err(ThreadProjectionError::UnsupportedToolResultPart),
	}
}

/// Converts a thread blob part into an inference media input.
///
/// # Errors
/// Missing media type, or neither inline bytes nor a content hash.
pub fn media_from_thread(blob: &thread_pb::Blob) -> Result<MediaInput, ThreadProjectionError> {
	if blob.mime.is_empty() {
		return Err(ThreadProjectionError::MissingBlobMediaType);
	}
	if !blob.inline.is_empty() {
		// `inline` is already a shared buffer; the request borrows it.
		return Ok(MediaInput::Bytes {
			media_type: blob.mime.as_str().into(),
			data:       blob.inline.clone(),
		});
	}
	if blob.hash.is_empty() {
		return Err(ThreadProjectionError::MissingBlobData);
	}
	let id = hex::encode(&blob.hash).into_string();
	Ok(MediaInput::Stored(ArtifactRef {
		store:    sf!("omp-rpc-blobs"),
		id:       id.as_str().into(),
		revision: id.as_str().into(),
	}))
}

fn thread_opaque_json(
	bytes: &[u8],
	field: &'static str,
) -> Result<OpaqueJson, ThreadProjectionError> {
	serde_json::from_slice(bytes)
		.map(OpaqueJson::new)
		.map_err(|source| ThreadProjectionError::InvalidJson { field, source })
}

/// Grammar language for a freeform tool input.
#[derive(Clone, Copy, Debug, Eq, IntoStaticStr, PartialEq)]
#[strum(serialize_all = "lowercase")]
pub enum ToolGrammarSyntax {
	/// Lark grammar.
	Lark,
	/// Regular expression.
	Regex,
	/// Extended Backus-Naur form.
	Ebnf,
}

/// Complete constrained format for a freeform tool input.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ToolGrammar {
	/// Grammar language.
	pub syntax:     ToolGrammarSyntax,
	/// Complete grammar definition.
	pub definition: Str,
}
/// Canonical argument property carrying a freeform tool input.
///
/// A freeform-capable tool (any [`ToolInputConstraint::Grammar`] declaration,
/// plus schema tools a transport deliberately lowers to a custom/freeform
/// wire shape) is called through one of two wire forms depending on transport
/// capability: raw grammar-constrained text, or a JSON object conforming to
/// the tool's schema. Recovery canonicalizes the freeform form into
/// `{"input": <text>}` so every downstream consumer (journal, history
/// re-encoding, argument decoding) sees exactly one shape. Freeform-capable
/// tools therefore declare a string `input` property; transports re-encoding
/// history into a freeform wire item extract this property back out.
pub const FREEFORM_INPUT_PROPERTY: &str = "input";

/// Complete syntax declaration for one callable tool's input.
#[derive(Clone, Debug)]
pub enum ToolInputConstraint {
	/// JSON arguments validated against an opaque JSON Schema.
	JsonSchema {
		/// Opaque JSON Schema for tool arguments.
		parameters: OpaqueJson,
		/// Whether schema conformance must be enforced strictly.
		strict:     bool,
	},
	/// Freeform text constrained by the exact grammar declaration.
	///
	/// Grammar-capable transports send the grammar and receive freeform text;
	/// all other transports encode the non-strict `fallback` schema and
	/// receive ordinary JSON arguments. Both wire forms are valid for one
	/// declaration — recovery validates whichever form the provider produced
	/// and canonicalizes freeform text under [`FREEFORM_INPUT_PROPERTY`].
	Grammar {
		/// Exact grammar declaration for grammar-capable transports.
		grammar:  ToolGrammar,
		/// Non-strict JSON Schema encoded by transports without
		/// grammar-constrained tools; they ignore the grammar entirely.
		fallback: OpaqueJson,
	},
}
impl ToolInputConstraint {
	/// Returns the JSON Schema declaration when this input is structured JSON.
	pub const fn json_schema(&self) -> Option<(&OpaqueJson, bool)> {
		match self {
			Self::JsonSchema { parameters, strict } => Some((parameters, *strict)),
			Self::Grammar { .. } => None,
		}
	}

	/// Returns the exact grammar declaration when this input is freeform text.
	pub const fn grammar(&self) -> Option<&ToolGrammar> {
		match self {
			Self::JsonSchema { .. } => None,
			Self::Grammar { grammar, .. } => Some(grammar),
		}
	}

	/// Returns the JSON Schema a schema-only transport encodes: the declared
	/// schema for structured inputs, the non-strict fallback for grammar
	/// inputs. Grammar-capable transports check [`Self::grammar`] first.
	pub const fn wire_schema(&self) -> (&OpaqueJson, bool) {
		match self {
			Self::JsonSchema { parameters, strict } => (parameters, *strict),
			Self::Grammar { fallback, .. } => (fallback, false),
		}
	}
}

/// One caller-executable tool declaration.
#[derive(Clone, Debug)]
pub struct ToolDefinition {
	/// Stable tool name.
	pub name:        Str,
	/// Human-readable tool purpose.
	pub description: Option<Str>,
	/// Complete, unambiguous input syntax declaration.
	pub input:       ToolInputConstraint,
}

/// Hosted tool offered directly by a selected provider route.
#[derive(Clone, Debug)]
pub enum HostedTool {
	/// Provider-hosted web search.
	WebSearch {
		/// Domains allowed by the caller.
		allowed_domains: Arc<[Str]>,
		/// Domains denied by the caller.
		blocked_domains: Arc<[Str]>,
		/// Maximum result age in days.
		recency_days:    Option<u32>,
	},
	/// Provider-hosted code execution.
	CodeExecution,
	/// Provider-hosted retrieval over named stores.
	Retrieval {
		/// Named provider stores.
		stores: Arc<[Str]>,
	},
}

/// Caller intent for model tool selection.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ToolChoice {
	/// The model must not call tools.
	Disabled,
	/// The model may choose whether to call a tool.
	Auto,
	/// The model must produce at least one valid tool call.
	Required,
	/// The model must produce a valid call to the named tool.
	Named(Str),
}

/// Structured output enforcement requested from chat.
#[derive(Clone, Debug)]
pub enum StructuredOutput {
	/// Require a syntactically valid JSON object.
	JsonObject,
	/// Require conformance to opaque JSON Schema.
	JsonSchema {
		/// Schema name.
		name:   Str,
		/// Opaque JSON Schema.
		schema: OpaqueJson,
		/// Whether exact conformance is mandatory.
		strict: bool,
	},
	/// Require output matching a regular expression.
	Regex(Str),
	/// Require output matching a Lark grammar.
	Lark(Str),
	/// Require output matching an EBNF grammar.
	Ebnf(Str),
}

/// Requested reasoning behavior.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReasoningRequest {
	/// Visibility of reasoning material.
	pub visibility:          ReasoningVisibility,
	/// Qualitative reasoning effort.
	pub effort:              Option<ReasoningEffort>,
	/// Explicit reasoning-token bound.
	pub max_tokens:          Option<u64>,
	/// Whether provider reasoning signatures must be retained.
	pub preserve_signatures: bool,
}

/// Visibility of model reasoning.
#[derive(Clone, Copy, Debug, Eq, IntoStaticStr, PartialEq)]
pub enum ReasoningVisibility {
	/// Do not expose reasoning text.
	#[strum(serialize = "omitted")]
	Hidden,
	/// Expose a provider-produced summary when available.
	#[strum(serialize = "summarized")]
	Summary,
	/// Expose canonical thinking deltas when supported.
	#[strum(serialize = "visible")]
	Visible,
}

/// Requested text verbosity.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TextVerbosity {
	/// Concise output.
	Low,
	/// Balanced output detail.
	Medium,
	/// Detailed output.
	High,
}

/// Requested prompt-cache retention.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CacheRetention {
	/// Retain only for this request.
	Request,
	/// Retain for the current session.
	Session,
	/// Use a provider-defined short retention period.
	Short,
	/// Use a provider-defined long retention period.
	Long,
}

/// Sampling controls whose absence preserves provider defaults.
#[derive(Clone, Debug, Default)]
pub struct Sampling {
	/// Temperature.
	pub temperature:        Option<f32>,
	/// Nucleus probability.
	pub top_p:              Option<f32>,
	/// Top-k candidate bound.
	pub top_k:              Option<u32>,
	/// Minimum token probability relative to the most likely token.
	pub min_p:              Option<f32>,
	/// Deterministic seed when supported.
	pub seed:               Option<u64>,
	/// Stop sequences.
	pub stop:               Arc<[Str]>,
	/// Presence penalty.
	pub presence_penalty:   Option<f32>,
	/// Frequency penalty.
	pub frequency_penalty:  Option<f32>,
	/// Provider-native repetition penalty.
	pub repetition_penalty: Option<f32>,
}

/// One typed content-safety setting.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SafetySetting {
	/// Stable policy category.
	pub category:  Str,
	/// Requested threshold.
	pub threshold: SafetyThreshold,
}

/// Safety filtering threshold.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SafetyThreshold {
	/// Disable this filter.
	Off,
	/// Permit only low-risk content.
	Low,
	/// Permit low- and medium-risk content.
	Medium,
	/// Block only high-risk content.
	High,
	/// Apply the strictest available filter.
	BlockMost,
}

/// Caller-owned forced-call ladder state carried across turns (ADR 0019).
///
/// The Director states the invariant (`tool_choice` names the tool); inference
/// chooses the rung from these counters plus the route's catalog facts.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct ForcedCall {
	/// Turns on which the model answered without calling the forced tool.
	pub non_compliant_turns: u8,
	/// Remaining paid escalations the caller authorizes.
	pub escalations_left:    u8,
}

/// Complete canonical chat request.
#[derive(Clone, Debug)]
pub struct ChatRequest {
	/// Ordered canonical thread or delta items.
	pub messages:          Arc<[Message]>,
	/// Caller-executable tool declarations.
	pub tools:             Arc<[ToolDefinition]>,
	/// Provider-hosted tool declarations.
	pub hosted_tools:      Arc<[HostedTool]>,
	/// Tool-choice intent.
	pub tool_choice:       Setting<ToolChoice>,
	/// Structured output intent.
	pub output:            Setting<StructuredOutput>,
	/// Reasoning intent.
	pub reasoning:         Setting<ReasoningRequest>,
	/// Text verbosity intent.
	pub verbosity:         Setting<TextVerbosity>,
	/// Prompt-cache retention intent.
	pub cache_retention:   Setting<CacheRetention>,
	/// Service-tier intent.
	pub service_tier:      Setting<ServiceTier>,
	/// Sampling settings.
	pub sampling:          Sampling,
	/// Maximum output tokens.
	pub max_output_tokens: Option<u64>,
	/// Requested number of token log probabilities.
	pub top_logprobs:      Option<u8>,
	/// Content safety settings.
	pub safety:            Arc<[SafetySetting]>,
	/// Capability negotiation policy.
	pub negotiation:       NegotiationPolicy,
	/// Forced-call ladder state; `None` for ordinary tool choice.
	pub forced_call:       Option<ForcedCall>,
}

impl ChatRequest {
	/// Validates that an explicitly named choice occurs in the policy-resolved
	/// live declarations. This runs once at the shared pre-codec boundary.
	pub fn validate_named_tool_choice(&self) -> Result<(), NamedToolChoiceError> {
		let choice = match &self.tool_choice {
			Setting::Require(ToolChoice::Named(name)) | Setting::Prefer(ToolChoice::Named(name)) => {
				name
			},
			Setting::Unset
			| Setting::Require(ToolChoice::Disabled | ToolChoice::Auto | ToolChoice::Required)
			| Setting::Prefer(ToolChoice::Disabled | ToolChoice::Auto | ToolChoice::Required) => {
				return Ok(());
			},
		};
		if self.tools.iter().any(|tool| tool.name == *choice) {
			Ok(())
		} else {
			Err(NamedToolChoiceError { name: choice.clone() })
		}
	}
}

/// A named tool choice absent from the live declarations.
#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
#[error("named tool {name} is not declared")]
pub struct NamedToolChoiceError {
	/// Unavailable tool name.
	pub name: Str,
}

/// Provenance required for token counting.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CountAccuracy {
	/// Require a provider endpoint or exact tokenizer revision.
	Exact,
	/// Permit a clearly identified estimate.
	AllowEstimate,
}

/// Request for prompt token count.
#[derive(Clone, Debug)]
pub struct CountTokensRequest {
	/// Canonical messages to measure.
	pub messages: Arc<[Message]>,
	/// Tool declarations included in the prompt.
	pub tools:    Arc<[ToolDefinition]>,
	/// Required accuracy.
	pub accuracy: CountAccuracy,
}

/// Request to tokenize text with the target model's tokenizer.
#[derive(Clone, Debug)]
pub struct TokenizeRequest {
	/// Text to tokenize.
	pub text:          Str,
	/// Whether special tokens may be recognized.
	pub allow_special: bool,
}

/// Request to detokenize identifiers with the target model's tokenizer.
#[derive(Clone, Debug)]
pub struct DetokenizeRequest {
	/// Ordered token identifiers.
	pub tokens: Arc<[u32]>,
	/// Whether invalid token identifiers should be rejected.
	pub strict: bool,
}

/// One embedding input.
#[derive(Clone, Debug)]
pub enum EmbeddingInput {
	/// UTF-8 text input.
	Text(Str),
	/// Pre-tokenized input.
	Tokens(Arc<[u32]>),
}

/// Behavior when embedding input exceeds a model limit.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TruncationPolicy {
	/// Reject oversized input.
	Reject,
	/// Retain tokens from the start.
	Start,
	/// Retain tokens from the end.
	End,
}

/// Request for one batch of embeddings.
#[derive(Clone, Debug)]
pub struct EmbedRequest {
	/// Ordered embedding inputs.
	pub inputs:      Arc<[EmbeddingInput]>,
	/// Requested vector dimensions.
	pub dimensions:  Setting<u32>,
	/// Whether vectors should be unit-normalized.
	pub normalize:   Setting<bool>,
	/// Explicit truncation behavior.
	pub truncation:  TruncationPolicy,
	/// Capability negotiation policy.
	pub negotiation: NegotiationPolicy,
}

/// Raster dimensions requested for generated media.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Dimensions {
	/// Width in pixels.
	pub width:  u32,
	/// Height in pixels.
	pub height: u32,
}

/// Image generation quality.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ImageQuality {
	/// Fast preview quality.
	Draft,
	/// Standard quality.
	Standard,
	/// Highest available quality.
	High,
}

/// Image background handling.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Background {
	/// Require an opaque background.
	Opaque,
	/// Require transparency.
	Transparent,
	/// Let the model or route choose.
	Auto,
}

/// Generated image encoding.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ImageFormat {
	/// Portable Network Graphics.
	Png,
	/// JPEG.
	Jpeg,
	/// WebP.
	Webp,
}

/// Request for image generation or editing.
#[derive(Clone, Debug)]
pub struct ImageRequest {
	/// Text prompt.
	pub prompt:      Str,
	/// Optional reference images for editing or variation.
	pub references:  Arc<[MediaInput]>,
	/// Optional edit mask.
	pub mask:        Option<MediaInput>,
	/// Number of final artifacts requested.
	pub count:       u32,
	/// Output dimensions.
	pub dimensions:  Setting<Dimensions>,
	/// Output quality.
	pub quality:     Setting<ImageQuality>,
	/// Background handling.
	pub background:  Setting<Background>,
	/// Output encoding.
	pub format:      Setting<ImageFormat>,
	/// Requested visual style identifier.
	pub style:       Setting<Str>,
	/// Content-safety settings.
	pub safety:      Arc<[SafetySetting]>,
	/// Optional deterministic seed.
	pub seed:        Option<u64>,
	/// Capability negotiation policy.
	pub negotiation: NegotiationPolicy,
}

/// Request for video generation.
#[derive(Clone, Debug)]
pub struct VideoRequest {
	/// Text prompt.
	pub prompt:            Str,
	/// Optional starting image.
	pub reference:         Option<MediaInput>,
	/// Requested duration in milliseconds.
	pub duration_ms:       Setting<u64>,
	/// Output dimensions.
	pub dimensions:        Setting<Dimensions>,
	/// Frames per second.
	pub frames_per_second: Setting<u32>,
	/// Whether an audio track is requested.
	pub audio:             Setting<bool>,
	/// Content-safety settings.
	pub safety:            Arc<[SafetySetting]>,
	/// Optional deterministic seed.
	pub seed:              Option<u64>,
	/// Capability negotiation policy.
	pub negotiation:       NegotiationPolicy,
}

/// Audio encoding for speech input or output.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AudioFormat {
	/// Signed 16-bit PCM.
	Pcm16,
	/// Signed 24-bit PCM.
	Pcm24,
	/// 32-bit floating-point PCM.
	F32,
	/// MPEG Layer III.
	Mp3,
	/// Advanced Audio Coding.
	Aac,
	/// Opus.
	Opus,
	/// Free Lossless Audio Codec.
	Flac,
	/// Waveform Audio container.
	Wav,
}

/// Timestamp granularity requested from speech operations.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TimestampGranularity {
	/// Do not emit timestamps.
	None,
	/// Emit segment timestamps.
	Segment,
	/// Emit word timestamps.
	Word,
}

/// Request for streamed text-to-speech synthesis.
#[derive(Clone, Debug)]
pub struct SpeechRequest {
	/// Text to synthesize.
	pub text:           Str,
	/// Catalog/provider voice identity.
	pub voice:          Str,
	/// Output encoding.
	pub format:         Setting<AudioFormat>,
	/// Output sample rate.
	pub sample_rate_hz: Setting<u32>,
	/// Playback-speed multiplier.
	pub speed:          Setting<f32>,
	/// Timestamp metadata granularity.
	pub timestamps:     Setting<TimestampGranularity>,
	/// Capability negotiation policy.
	pub negotiation:    NegotiationPolicy,
}

/// Request for streamed speech transcription or translation.
#[derive(Clone, Debug)]
pub struct TranscriptionRequest {
	/// Audio input.
	pub audio:                MediaInput,
	/// Optional BCP-47 language hint.
	pub language:             Option<Str>,
	/// Whether output should be translated to English.
	pub translate_to_english: bool,
	/// Whether speaker diarization is required or preferred.
	pub diarization:          Setting<bool>,
	/// Timestamp granularity.
	pub timestamps:           Setting<TimestampGranularity>,
	/// Optional vocabulary or style prompt.
	pub prompt:               Option<Str>,
	/// Capability negotiation policy.
	pub negotiation:          NegotiationPolicy,
}

/// Modalities enabled in a realtime session.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RealtimeModality {
	/// Text input and output.
	Text,
	/// Audio input and output.
	Audio,
}

/// Semantic destination for text appended to a realtime session.
#[derive(Clone, Copy, Debug, Eq, IntoStaticStr, PartialEq)]
#[strum(serialize_all = "lowercase")]
pub enum RealtimeContextChannel {
	/// Text suitable for speaking to the user.
	Speakable,
	/// Progress text that should not interrupt the spoken response.
	Commentary,
}

/// Scope receiving appended realtime context.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RealtimeContextTarget {
	/// Session-wide context not tied to delegated work.
	Session,
	/// Context associated with one delegated agent turn.
	Delegation {
		/// Stable delegation identity issued by the realtime peer.
		id: Str,
	},
}

/// Provider-neutral context appended during a realtime session.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RealtimeContextAppend {
	/// Scope receiving the context.
	pub target:  RealtimeContextTarget,
	/// Semantic presentation channel.
	pub channel: RealtimeContextChannel,
	/// Canonical UTF-8 text. Transport chunking is adapter-owned.
	pub text:    Str,
}

/// Terminal state of one delegated agent turn.
#[derive(Clone, Copy, Debug, Eq, IntoStaticStr, PartialEq)]
#[strum(serialize_all = "lowercase")]
pub enum RealtimeDelegationStatus {
	/// The delegated turn produced its final response.
	Completed,
	/// The caller cancelled delegated work.
	Cancelled,
	/// The delegated turn failed before producing a final response.
	Failed,
}

/// Exactly-once settlement evidence for one delegated agent turn.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RealtimeDelegationReceipt {
	/// Stable delegation identity issued by the realtime peer.
	pub delegation_id: Str,
	/// Terminal delegated-turn state.
	pub status:        RealtimeDelegationStatus,
	/// Time at which the core agent bridge settled the turn.
	pub settled_at:    SystemTime,
}

/// Server-side turn detection for realtime audio.
#[derive(Clone, Debug, PartialEq)]
pub enum TurnDetection {
	/// Caller explicitly starts and commits each turn.
	Manual,
	/// Server voice activity detection.
	ServerVad {
		/// Detection threshold.
		threshold:         f32,
		/// Required trailing silence in milliseconds.
		silence_ms:        u32,
		/// Audio retained before detected speech in milliseconds.
		prefix_padding_ms: u32,
	},
	/// Semantic end-of-turn detection.
	SemanticVad {
		/// Requested semantic detector responsiveness.
		eagerness: RealtimeEagerness,
	},
}

/// Responsiveness of semantic realtime turn detection.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RealtimeEagerness {
	/// Wait longer for continued input.
	Low,
	/// Balanced end-of-turn detection.
	Medium,
	/// End turns quickly.
	High,
	/// Let the route select eagerness.
	Auto,
}

/// Request to create an owned bidirectional realtime session.
#[derive(Clone, Debug)]
pub struct RealtimeRequest {
	/// Initial control instructions.
	pub instructions:   Option<Str>,
	/// Enabled modalities.
	pub modalities:     Arc<[RealtimeModality]>,
	/// Optional speech voice.
	pub voice:          Option<Str>,
	/// Input audio encoding.
	pub input_audio:    Setting<AudioFormat>,
	/// Output audio encoding.
	pub output_audio:   Setting<AudioFormat>,
	/// Turn-detection behavior.
	pub turn_detection: Setting<TurnDetection>,
	/// Callable tool declarations.
	pub tools:          Arc<[ToolDefinition]>,
	/// Capability negotiation policy.
	pub negotiation:    NegotiationPolicy,
}

/// Recency filter for standalone search.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SearchRecency {
	/// Previous day.
	Day,
	/// Previous week.
	Week,
	/// Previous month.
	Month,
	/// Previous year.
	Year,
	/// Explicit number of previous days.
	Days(u32),
}

/// Request for standalone ranked web search.
#[derive(Clone, Debug)]
pub struct SearchRequest {
	/// Search query as authored.
	pub query:                Str,
	/// Parsed directives shared across route attempts.
	pub parsed_query:         Arc<SearchQuery>,
	/// Included domains supplied outside query text; empty means unrestricted.
	pub include_domains:      Arc<[Str]>,
	/// Excluded domains supplied outside query text.
	pub exclude_domains:      Arc<[Str]>,
	/// Recency constraint.
	pub recency:              Option<SearchRecency>,
	/// BCP-47 locale hint.
	pub locale:               Option<Str>,
	/// Maximum ranked result count returned to the caller.
	pub max_results:          u32,
	/// Provider retrieval count when distinct from returned results.
	pub retrieval_results:    Option<u32>,
	/// Maximum synthesis output tokens.
	pub max_output_tokens:    Option<u32>,
	/// Synthesis sampling temperature.
	pub temperature:          Option<f32>,
	/// Explicit provider pin, when any.
	pub provider:             Option<ProviderId>,
	/// Configured provider preference order for automatic search.
	pub provider_order:       Arc<[ProviderId]>,
	/// Providers excluded from automatic search.
	pub excluded_providers:   Arc<[ProviderId]>,
	/// Per-provider attempt timeout, already clamped by the owner.
	pub attempt_timeout:      Duration,
	/// Validated endpoint override for a configurable self-hosted route.
	pub endpoint_override:    Option<Str>,
	/// Whether Perplexity uses its Responses-compatible endpoint.
	pub perplexity_responses: bool,
	/// Whether an answer synthesis is requested.
	pub synthesize_answer:    Setting<bool>,
	/// Capability negotiation policy.
	pub negotiation:          NegotiationPolicy,
}

impl SearchRequest {
	/// Constructs a canonical search request with automatic provider selection.
	pub fn new(query: impl Into<Str>, max_results: u32) -> Self {
		let query = query.into();
		Self {
			parsed_query: Arc::new(search_query::parse_search_query(&query)),
			query,
			include_domains: Arc::new([]),
			exclude_domains: Arc::new([]),
			recency: None,
			locale: None,
			max_results,
			retrieval_results: None,
			max_output_tokens: None,
			temperature: None,
			provider: None,
			provider_order: Arc::new([]),
			excluded_providers: Arc::new([]),
			attempt_timeout: Duration::from_secs(60),
			endpoint_override: None,
			perplexity_responses: false,
			synthesize_answer: Setting::Unset,
			negotiation: NegotiationPolicy::default(),
		}
	}
}

/// Usage windows to query.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum UsageScope {
	/// Current active windows.
	Current,
	/// Billing-period usage.
	Billing,
	/// Rate-limit windows.
	RateLimit,
	/// Every available window.
	All,
}

/// Request for account-scoped usage, balance, and quota information.
#[derive(Clone, Debug)]
pub struct UsageRequest {
	/// Optional provider restriction.
	pub provider:    Option<ProviderId>,
	/// Optional account restriction.
	pub account:     Option<AccountId>,
	/// Requested usage windows.
	pub scope:       UsageScope,
	/// Whether stale cached observations are acceptable.
	pub allow_stale: bool,
}

/// Request for runtime model discovery.
#[derive(Clone, Debug)]
pub struct DiscoveryRequest {
	/// Optional provider restriction.
	pub provider:  Option<ProviderId>,
	/// Optional route restriction.
	pub route:     Option<RouteId>,
	/// Opaque provider pagination cursor from a prior typed response.
	pub cursor:    Option<Str>,
	/// Maximum rows requested from one page.
	pub page_size: u32,
	/// Optional required operation capability.
	pub operation: Option<OperationKind>,
}

/// Starts an interactive authentication method for a provider.
#[derive(Clone, Debug)]
pub struct LoginRequest {
	/// Provider whose account should be authenticated.
	pub provider: ProviderId,
	/// Preferred public authentication method.
	pub method:   Option<AuthMethod>,
}

/// Public authentication method selection.
#[derive(Clone, Copy, Debug, Eq, IntoStaticStr, PartialEq)]
#[strum(serialize_all = "kebab-case")]
pub enum AuthMethod {
	/// Static API key.
	ApiKey,
	/// Browser-based OAuth with PKCE.
	OAuthPkce,
	/// OAuth device authorization.
	OAuthDevice,
	/// Application-default credentials.
	ApplicationDefault,
	/// AWS credential chain.
	AwsCredentialChain,
	/// Provider session token.
	SessionToken,
}

/// Caller response submitted to an authentication session.
#[derive(Clone)]
pub enum AuthInput {
	/// Authorization code pasted by the caller.
	AuthorizationCode(SecretString),
	/// API key supplied by the caller.
	ApiKey(SecretString),
	/// Session token supplied by the caller.
	SessionToken(SecretString),
	/// Callback URL containing authorization response parameters.
	CallbackUrl(SecretString),
	/// Visible plain-text response, including an empty default selection.
	PlainText(Str),
	/// Optional secret response for which an empty value means skip.
	OptionalSecret(SecretString),
	/// Confirmation that a device-code step was completed externally.
	DeviceConfirmed,
	/// Caller cancelled the interactive flow.
	Cancel,
}

impl fmt::Debug for AuthInput {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		match self {
			Self::AuthorizationCode(_) => formatter.write_str("AuthorizationCode([REDACTED])"),
			Self::ApiKey(_) => formatter.write_str("ApiKey([REDACTED])"),
			Self::SessionToken(_) => formatter.write_str("SessionToken([REDACTED])"),
			Self::CallbackUrl(_) => formatter.write_str("CallbackUrl([REDACTED])"),
			Self::PlainText(_) => formatter.write_str("PlainText([REDACTED])"),
			Self::OptionalSecret(_) => formatter.write_str("OptionalSecret([REDACTED])"),
			Self::DeviceConfirmed => formatter.write_str("DeviceConfirmed"),
			Self::Cancel => formatter.write_str("Cancel"),
		}
	}
}

/// Authentication and account-management operation.
#[derive(Clone, Debug)]
pub enum AuthRequest {
	/// Begin an interactive login.
	Login(LoginRequest),
	/// Submit a secret or control response to a login session.
	Submit {
		/// Login session receiving the response.
		session: LoginSessionId,
		/// Secret or control input.
		input:   AuthInput,
	},
	/// List non-secret account summaries.
	ListAccounts {
		/// Optional provider restriction.
		provider: Option<ProviderId>,
	},
	/// Refresh one account's credential lease.
	Refresh {
		/// Account to refresh.
		account: AccountId,
	},
	/// Remove one account and its encrypted credentials.
	Logout {
		/// Account to remove.
		account: AccountId,
	},
}

/// Allowlisted HTTP-like method for native wire access.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NativeMethod {
	/// Read an allowlisted resource.
	Get,
	/// Submit an allowlisted request.
	Post,
	/// Delete an allowlisted resource.
	Delete,
}

/// Closed allowlist of native protocol paths.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NativePath {
	/// OpenAI-compatible chat completions.
	ChatCompletions,
	/// OpenAI-compatible responses.
	Responses,
	/// Anthropic-compatible messages.
	Messages,
	/// Anthropic-compatible message token counting.
	MessageTokenCounts,
	/// Embedding endpoint.
	Embeddings,
	/// Image-generation endpoint.
	ImageGenerations,
	/// Speech-synthesis endpoint.
	AudioSpeech,
	/// Transcription endpoint.
	AudioTranscriptions,
	/// Realtime session negotiation endpoint.
	RealtimeSessions,
	/// Model discovery endpoint.
	Models,
	/// Usage or quota endpoint.
	Usage,
}

/// Explicit native payload representation.
#[derive(Clone, Debug)]
pub enum NativePayload {
	/// Validated JSON document retained as exact UTF-8 wire bytes.
	Json(RawJson),
	/// Immutable binary payload.
	Bytes(Bytes),
	/// Replay-declared streaming or factory-backed body.
	Body(NativeBodySource),
}

/// Expected framing of an allowlisted native response.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NativeResponseFraming {
	/// One bounded opaque JSON document.
	Json,
	/// Incremental server-sent events.
	Sse,
	/// One bounded uninterpreted binary body.
	Bytes,
}

/// Lossless request to one allowlisted native wire endpoint.
#[derive(Clone, Debug)]
pub struct NativeRequest {
	/// Allowlisted method.
	pub method:             NativeMethod,
	/// Allowlisted semantic path.
	pub path:               NativePath,
	/// Optional opaque request payload.
	pub payload:            Option<NativePayload>,
	/// Response framing selected without inspecting opaque payload content.
	pub response_framing:   NativeResponseFraming,
	/// Maximum accepted response body bytes.
	pub max_response_bytes: u64,
}

#[cfg(test)]
mod tests {
	use bytes::Bytes;
	use omp_core::SecretString;

	use super::{AuthInput, RawJson};

	#[test]
	fn auth_input_debug_never_exposes_secrets() {
		let input = AuthInput::ApiKey(SecretString::from("super-secret".to_owned()));
		let debug = format!("{input:?}");
		assert!(!debug.contains("super-secret"));
		assert!(debug.contains("REDACTED"));
	}

	#[test]
	fn native_json_validation_preserves_exact_bytes() {
		let bytes = Bytes::from_static(b"{ \"value\": 1 }");
		let raw = RawJson::new(bytes.clone(), bytes.len() as u64).expect("valid JSON");
		assert_eq!(raw.as_bytes(), bytes.as_ref());
		assert!(RawJson::new(Bytes::from_static(b"{} trailing"), 64).is_err());
	}
}
