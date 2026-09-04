//! Sans-I/O wire-codec contracts shared by every inference transport.

use std::{
	fmt,
	future::Future,
	pin::Pin,
	sync::{
		Arc,
		atomic::{AtomicBool, Ordering},
	},
	task::{Context, Poll},
	time::Duration,
};

use bytes::Bytes;
use futures::{Stream, task::AtomicWaker};
use omp_catalog::{
	AuthSpecId, CodecId, CodecProfile, CodexTransportPreference, DiscoveredModel, EndpointSpec,
	HeaderProfileId, ModelKey, OperationKind, PolicyModel, ProviderId, RedirectTrust, RouteDef,
	RouteId, RouteRestrictions, ThinkingPolicy, ThinkingSelection, TransportKind, TrustDomain,
	WireTarget, policy::WirePolicy,
};
use omp_core::{IntoStr, Str, sf};
use serde_json::{Map as JsonMap, Value as JsonValue};
use smallvec::SmallVec;

use crate::{
	answer::{
		AnswerBody, AudioChunk, GenerationEvent, ImageArtifact, RealtimeEvent, RealtimeInput,
		RealtimeSession, TranscriptEvent, VideoArtifact,
	},
	auth::{AuthScheme, BodyPlacement, CredentialApplyError, lease::AppliedCredentials},
	body::{AttemptEvidenceHandle, BodySource},
	call::{AccountRoutingContext, CallAffinity, OperationCall, SessionRequest},
	error::Error,
	event::{ChatEvent, FinishReason, WorkflowResponse},
	id::{AccountId, PrincipalId, RequestId, ToolCallId},
	receipt::{Adjustment, Usage},
	session::ServerStateBinding,
	transport::{Frame, FramingProtocol},
};

pub mod anthropic;
pub(crate) mod connect;
pub mod cursor;
pub mod discovery;
pub mod gemini;
pub(crate) mod glyph;
pub mod google_cca;
pub mod ollama;
pub mod openai;
pub mod openai_chat;
pub mod openai_codex;
pub mod openai_embedding;
pub mod openai_media;
pub mod openai_realtime;
pub mod openai_responses;
pub mod provider_hooks;
pub(crate) mod schema;
pub use provider_hooks::{
	ModelsDiscoverHookPage, ModelsDiscoverHookRequest, ProviderHookCredential, ProviderHookError,
	ProviderHookObserver, ProviderLoginHookRequest, ProviderRefreshHookRequest,
	ProviderRefreshReason, ProviderSignHookRequest, ProviderSignature,
};

pub mod bedrock;
pub mod bedrock_mantle;
pub mod devin;
pub mod gitlab;
pub mod native;
pub mod omp_native;
pub mod search_brave;
pub mod search_duckduckgo;
pub mod search_ecosia;
pub mod search_exa;
pub mod search_firecrawl;
pub mod search_google;
pub mod search_hosted;
pub mod search_jina;
mod search_json;
pub mod search_kagi;
pub mod search_mojeek;
pub mod search_parallel;
pub mod search_perplexity;
mod search_scraper;
pub mod search_searxng;
pub mod search_startpage;
pub mod search_tavily;
pub mod search_tinyfish;
/// HTTP method used by a wire request without pulling policy into the
/// transport.
#[derive(Clone, Copy, Debug, Eq, PartialEq, strum::IntoStaticStr)]
#[strum(serialize_all = "UPPERCASE")]
pub enum RequestMethod {
	/// Read a resource.
	Get,
	/// Create or invoke a resource.
	Post,
	/// Replace a resource.
	Put,
	/// Partially update a resource.
	Patch,
	/// Delete a resource.
	Delete,
}

/// A public, non-secret request header produced by a codec.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RequestHeader {
	/// Header name.
	pub name:  Str,
	/// Header value; credentials are prohibited here.
	pub value: Str,
}

impl RequestHeader {
	/// Construct a header.
	#[inline]
	pub fn new(name: impl IntoStr, value: impl IntoStr) -> Self {
		Self { name: name.into_str(), value: value.into_str() }
	}

	/// Construct a static header.
	#[inline]
	pub const fn new_static(name: &'static str, value: &'static str) -> Self {
		Self { name: sf!(name), value: sf!(value) }
	}
}

/// Explicit request and response byte limits enforced by the transport.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SizeBounds {
	/// Maximum encoded request body size.
	pub request_body: u64,
	/// Maximum individual framed payload size.
	pub frame:        u64,
	/// Maximum aggregate response bytes.
	pub response:     u64,
}

/// Crate-private typed request body awaiting credential binding.
///
/// Templates contain no credential material. They are consumed at the
/// innermost transport boundary and deliberately have no serialization or
/// public inspection surface.
pub(crate) enum SealedBodyTemplate {
	Devin(devin::DevinSealedBody),
}

impl SealedBodyTemplate {
	pub(crate) const fn placement(&self) -> BodyPlacement {
		match self {
			Self::Devin(_) => BodyPlacement::DevinMetadata,
		}
	}

	pub(crate) fn bind(self, secret: &str) -> Result<Bytes, CredentialApplyError> {
		match self {
			Self::Devin(template) => template.bind(secret),
		}
	}
}

impl fmt::Debug for SealedBodyTemplate {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter
			.debug_struct("SealedBodyTemplate")
			.field("placement", &self.placement())
			.field("body", &"[REDACTED]")
			.finish()
	}
}

/// Secret-free request emitted by a codec and finalized by credential
/// middleware.
pub struct EncodedRequest {
	/// Operation represented by the request.
	pub operation:          OperationKind,
	/// Wire method.
	pub method:             RequestMethod,
	/// Absolute endpoint URI including non-secret query parameters.
	pub uri:                Str,
	/// Public headers. Credential middleware owns all sensitive headers.
	pub headers:            Box<[RequestHeader]>,
	/// Fresh or one-shot request body with explicit replay semantics.
	pub body:               BodySource,
	/// Response framing selected by the codec.
	pub framing:            FramingProtocol,
	/// Enforced byte limits.
	pub bounds:             SizeBounds,
	pub(crate) sealed_body: Option<SealedBodyTemplate>,
	/// Encode-time degradations (ADR 0021 §3) the route encoder receipts
	/// before transport; never a silent change.
	pub adjustments:        Vec<Adjustment>,
}
impl EncodedRequest {
	/// Constructs an ordinary credential-free encoded request.
	pub const fn new(
		operation: OperationKind,
		method: RequestMethod,
		uri: Str,
		headers: Box<[RequestHeader]>,
		body: BodySource,
		framing: FramingProtocol,
		bounds: SizeBounds,
	) -> Self {
		Self {
			operation,
			method,
			uri,
			headers,
			body,
			framing,
			bounds,
			sealed_body: None,
			adjustments: Vec::new(),
		}
	}

	/// Attaches encode-time receipted degradations.
	pub fn with_adjustments(mut self, adjustments: Vec<Adjustment>) -> Self {
		self.adjustments = adjustments;
		self
	}

	pub(crate) fn with_sealed_body(mut self, template: SealedBodyTemplate) -> Self {
		self.sealed_body = Some(template);
		self
	}

	pub(crate) const fn take_sealed_body(&mut self) -> Option<SealedBodyTemplate> {
		self.sealed_body.take()
	}
}

/// Attempt identity visible to pure encoding without account or credential
/// data.
///
/// Packed as one `u64`: the low 32 bits carry the zero-based attempt index,
/// the high bits carry attempt flags.
#[repr(transparent)]
#[derive(Clone, Copy, Default, Eq, PartialEq)]
pub struct EncodeAttempt(u64);

impl EncodeAttempt {
	/// Output from this attempt is held transactionally.
	const PROVISIONAL: u64 = 1 << 32;
	/// A prior attempt on this route was classified as rejecting the
	/// `chat_template_kwargs.reasoning_effort` spelling.
	const TEMPLATE_EFFORT_REJECTED: u64 = 1 << 33;

	/// Returns the identity with the zero-based attempt index set to `index`.
	pub const fn with_index(self, index: u32) -> Self {
		Self(self.0 & !(u32::MAX as u64) | index as u64)
	}

	/// Returns the zero-based attempt index.
	pub const fn index(self) -> u32 {
		self.0 as u32
	}

	/// Whether output from this attempt is held transactionally.
	pub const fn is_provisional(self) -> bool {
		self.0 & Self::PROVISIONAL != 0
	}

	/// Returns the identity with the transactional-hold flag set to `value`.
	pub const fn with_provisional(self, value: bool) -> Self {
		Self(if value {
			self.0 | Self::PROVISIONAL
		} else {
			self.0 & !Self::PROVISIONAL
		})
	}

	/// Whether a prior attempt on this route was classified as rejecting the
	/// `chat_template_kwargs.reasoning_effort` spelling; effort-capable Qwen
	/// dialects must route the effort onto the top-level field only.
	pub const fn is_template_effort_rejected(self) -> bool {
		self.0 & Self::TEMPLATE_EFFORT_REJECTED != 0
	}

	/// Returns the identity with the template-effort-rejection flag set to
	/// `value`.
	pub const fn with_template_effort_rejected(self, value: bool) -> Self {
		Self(if value {
			self.0 | Self::TEMPLATE_EFFORT_REJECTED
		} else {
			self.0 & !Self::TEMPLATE_EFFORT_REJECTED
		})
	}
}

impl fmt::Debug for EncodeAttempt {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter
			.debug_struct("EncodeAttempt")
			.field("index", &self.index())
			.field("provisional", &self.is_provisional())
			.field("template_effort_rejected", &self.is_template_effort_rejected())
			.finish()
	}
}

/// Secret-free context for canonical-to-wire lowering.
pub struct EncodeContext<'a> {
	/// Logical request identity used by protocols with stable reconnect keys.
	pub request_id:         &'a RequestId,
	/// Non-secret authentication scheme selected for the resolved lease.
	pub auth_scheme:        Option<AuthScheme>,
	/// Complete selected route definition.
	pub route:              &'a RouteDef,
	/// Optional codec-facing target. Model-less management operations carry
	/// none.
	pub target:             Option<&'a WireTarget>,
	/// Exact capability, limit, and pricing evidence selected by the immutable
	/// plan.
	///
	/// Model-less management operations carry none.
	pub policy_model:       Option<&'a PolicyModel>,
	/// Interned lowering policy selected during planning.
	pub policy:             &'a WirePolicy,
	/// Exact model thinking policy resolved during planning.
	pub thinking_policy:    Option<&'a ThinkingPolicy>,
	/// Per-request effort, budget, mode, and wire-model selection resolved by
	/// the immutable plan.
	pub thinking_selection: Option<&'a ThinkingSelection>,
	/// Optional canonical session identity and revision.
	pub session:            Option<&'a SessionRequest>,
	/// Session-independent prompt-cache and provider-session identities.
	pub affinity:           &'a CallAffinity,
	/// Compatible typed provider-side state selected by session planning.
	pub server_state:       Option<&'a ServerStateBinding>,
	/// Non-secret account/project/tenant routing metadata.
	pub account:            Option<&'a AccountRoutingContext>,
	/// Attempt metadata that may affect idempotency fields.
	pub attempt:            EncodeAttempt,
}

static DEFAULT_REQUEST_ID: RequestId = RequestId::empty();
static DEFAULT_AFFINITY: CallAffinity = CallAffinity::none();
static DEFAULT_WIRE_POLICY: WirePolicy = WirePolicy::baseline();
/// Neutral deny-everything route placeholder backing
/// [`EncodeContext::default`].
static DEFAULT_ROUTE: RouteDef = RouteDef {
	id:                 RouteId::empty(),
	provider:           ProviderId::empty(),
	codec_profile:      CodecProfile::Standard,
	codec:              CodecId::empty(),
	transport:          TransportKind::Http,
	endpoint:           EndpointSpec {
		base_url:    Str::empty(),
		region:      None,
		api_version: None,
	},
	auth:               AuthSpecId::empty(),
	headers:            HeaderProfileId::empty(),
	discovery:          None,
	capability_limits:  RouteRestrictions {
		operations:             None,
		maximum_context_tokens: None,
		maximum_output_tokens:  None,
		disable_server_state:   false,
		disable_prompt_caching: false,
		disable_strict_tools:   false,
	},
	trust_domain:       TrustDomain {
		origin:          Str::empty(),
		redirects:       RedirectTrust::Deny,
		allow_plaintext: false,
	},
	codex_transport:    CodexTransportPreference::HttpOnly,
	use_responses_lite: None,
	priority:           None,
};

impl Default for EncodeContext<'_> {
	/// Neutral context for struct-update construction
	/// (`EncodeContext { policy, ..Default::default() }`).
	///
	/// The mandatory borrows point at empty deny-everything placeholders;
	/// production encoding always overrides `request_id`, `route`, and
	/// `policy` from the immutable plan.
	fn default() -> Self {
		Self {
			request_id:         &DEFAULT_REQUEST_ID,
			auth_scheme:        None,
			route:              &DEFAULT_ROUTE,
			target:             None,
			policy_model:       None,
			policy:             &DEFAULT_WIRE_POLICY,
			thinking_policy:    None,
			thinking_selection: None,
			session:            None,
			affinity:           &DEFAULT_AFFINITY,
			server_state:       None,
			account:            None,
			attempt:            EncodeAttempt::default(),
		}
	}
}

/// Lossless response representation requested by a native operation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NativeResponseFormat {
	/// One typed JSON body.
	Json,
	/// One opaque binary body.
	Bytes,
	/// Incremental SSE payload bytes.
	Sse,
}

/// Secret-free context for decoding one provider attempt.
pub struct DecodeContext<'a> {
	/// Logical request identity.
	pub request_id:         &'a RequestId,
	/// Non-secret authentication scheme used for this attempt.
	pub auth_scheme:        Option<AuthScheme>,
	/// Selected provider domain.
	pub provider:           &'a ProviderId,
	/// Selected route.
	pub route:              &'a RouteId,
	/// Optional codec-facing wire target selected by the immutable plan.
	///
	/// Model-less management operations carry none.
	pub target:             Option<&'a WireTarget>,
	/// Exact capability, limit, and pricing evidence selected by the immutable
	/// plan.
	///
	/// Model-less management operations carry none.
	pub policy_model:       Option<&'a PolicyModel>,
	/// Interned lowering policy used to encode the request.
	pub policy:             &'a WirePolicy,
	/// Exact model thinking policy used for this response.
	pub thinking_policy:    Option<&'a ThinkingPolicy>,
	/// Per-request thinking selection used to interpret this response.
	pub thinking_selection: Option<&'a ThinkingSelection>,
	/// Exact credential-free canonical operation used to interpret response
	/// fields omitted on wire.
	pub operation_call:     &'a OperationCall,
	/// Operation being decoded.
	pub operation:          OperationKind,
	/// Framing selected by the encoded request.
	pub framing:            FramingProtocol,
	/// Explicit lossless native representation, when decoding a native
	/// operation.
	pub native_response:    Option<NativeResponseFormat>,
	/// Zero-based attempt index.
	pub attempt:            u32,
}

impl DecodeContext<'_> {
	/// Debug-checks that the fast discriminator matches the exact canonical
	/// operation.
	///
	/// Central context constructors call this before handing the context to a
	/// decoder.
	#[inline]
	pub fn debug_assert_valid(&self) {
		debug_assert_eq!(
			self.operation,
			self.operation_call.kind(),
			"decode operation discriminator must match canonical operation",
		);
	}
}
/// Syntax category of a complete provider tool input.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ToolInputKind {
	/// JSON arguments requiring schema validation.
	Json,
	/// Arbitrary freeform text accepted only by a declared freeform tool.
	Freeform,
}

/// Complete provider tool-call syntax awaiting canonical schema validation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UnvalidatedToolCall {
	/// Canonical call identity.
	pub id:         ToolCallId,
	/// Provider-emitted tool name.
	pub name:       Str,
	/// Input syntax category.
	pub input_kind: ToolInputKind,
	/// Exact assembled input bytes.
	pub arguments:  Bytes,
}

/// Provider-state evidence that must survive canonical event projection.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProviderStateEvent {
	/// An authoritative continuation handle was observed.
	Continuation {
		/// Authoritative continuation handle.
		handle: Str,
	},
	/// Opaque encrypted reasoning material associated with a content block.
	ReasoningSignature {
		/// Content-block index.
		index:     u32,
		/// Opaque reasoning signature.
		signature: Bytes,
	},
	/// Provider-scoped proof required to replay a canonicalized tool call.
	ToolCallProof {
		/// Tool-call index.
		index: u32,
		/// Opaque replay proof.
		value: Bytes,
	},
	/// Codec-scoped opaque canonical-history proof for hosted server blocks.
	HistoryBlock {
		/// Hosted server-block index.
		index: u32,
		/// Opaque history proof.
		data:  Bytes,
	},
	/// Stable server output-item identity used by continuation protocols.
	OutputItem {
		/// Output-item index.
		index: u32,
		/// Stable provider output-item identity.
		id:    Str,
	},
	/// Provider checkpoint identity and its authoritative opaque state bytes.
	Checkpoint {
		/// Optional provider checkpoint identity.
		id:   Option<Str>,
		/// Opaque checkpoint state.
		data: Bytes,
	},
}
/// Provider response metadata that is neither session state nor accounting
/// telemetry.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProviderMetadataEvent {
	/// Stable response identity.
	ResponseId(Str),
	/// Candidate grounding metadata.
	Grounding {
		/// Candidate index.
		candidate: u32,
		/// Opaque grounding metadata.
		data:      Bytes,
	},
	/// Candidate citation metadata.
	Citations {
		/// Candidate index.
		candidate: u32,
		/// Opaque citation metadata.
		data:      Bytes,
	},
	/// Candidate safety ratings.
	SafetyRatings {
		/// Candidate index.
		candidate: u32,
		/// Opaque safety-rating metadata.
		data:      Bytes,
	},
	/// Provider finish explanation.
	FinishMessage {
		/// Candidate index.
		candidate: u32,
		/// Provider finish explanation.
		message:   Str,
	},
	/// Provider-reported rewrite of canonical request input.
	InputTransformation {
		/// Provider transformation kind.
		kind:   Str,
		/// Rewritten request path, when reported.
		path:   Option<Str>,
		/// Provider transformation reason, when reported.
		reason: Option<Str>,
		/// Complete bounded transformation object for forward compatibility.
		data:   Bytes,
	},
	/// Typed auxiliary candidate part whose provider kind is preserved without
	/// interpretation.
	AuxiliaryPart {
		/// Part index.
		index: u32,
		/// Provider-defined part kind.
		kind:  Str,
		/// Optional provider-defined part label.
		label: Option<Str>,
	},
}

/// Normalized provider safety action.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SafetyAction {
	/// No provider action was taken.
	None,
	/// Output was blocked.
	Blocked,
	/// A guardrail intervened without a full block.
	Intervened,
}

/// Category of one provider safety finding.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SafetyFindingKind {
	/// Content classifier finding.
	Content,
	/// Sensitive-information finding.
	SensitiveInformation,
	/// Topic-policy finding.
	Topic,
	/// Word or phrase-policy finding.
	Word,
	/// Contextual-grounding finding.
	ContextualGrounding,
}

/// Typed confidence vocabulary retained from provider safety evidence.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SafetyConfidence {
	/// Low confidence.
	Low,
	/// Medium confidence.
	Medium,
	/// High confidence.
	High,
}

/// Provider safety filter strength.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SafetyStrength {
	/// Low strength.
	Low,
	/// Medium strength.
	Medium,
	/// High strength.
	High,
}

/// One ordered provider safety finding.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SafetyFinding {
	/// Finding category.
	pub kind:                 SafetyFindingKind,
	/// Provider category or policy label.
	pub label:                Str,
	/// Optional concrete policy identifier.
	pub policy:               Option<Str>,
	/// Action taken for this finding.
	pub action:               SafetyAction,
	/// Whether the provider reports an actual detection.
	pub detected:             bool,
	/// Optional typed confidence.
	pub confidence:           Option<SafetyConfidence>,
	/// Optional typed filter strength.
	pub strength:             Option<SafetyStrength>,
	/// Optional threshold represented in millionths.
	pub threshold_millionths: Option<u32>,
	/// Optional score represented in millionths.
	pub score_millionths:     Option<u32>,
	/// Optional matched word, regex text, or entity label.
	pub matched:              Option<Str>,
}

/// Typed telemetry emitted by provider decoders for receipts and observability.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProviderTelemetryEvent {
	/// Model-side latency reported by the provider.
	ModelLatency(Duration),
	/// Ordered safety assessment and guardrail latency.
	SafetyAssessment {
		/// Aggregate provider action.
		action:            SafetyAction,
		/// Ordered normalized findings.
		findings:          Box<[SafetyFinding]>,
		/// Provider-reported guardrail invocation latency.
		guardrail_latency: Option<Duration>,
	},
}

/// Typed protocol control emitted by codecs whose wire protocol is
/// bidirectional.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProviderControlEvent {
	/// Provider requests a correlated shell command through an already declared
	/// tool call.
	ShellInvoke {
		/// Provider invocation identity.
		invocation: Str,
		/// Optional execution identity used across streamed updates.
		exec:       Option<Str>,
		/// Canonical tool-call identity.
		call:       ToolCallId,
		/// Command text.
		command:    Str,
		/// Optional working directory.
		cwd:        Option<Str>,
		/// Optional provider deadline.
		timeout_ms: Option<u64>,
		/// Whether incremental execution updates are expected.
		streaming:  bool,
	},
	/// Provider requests a correlated interactive answer. The codec resolves
	/// permission gates itself; `reply` carries the prepared same-stream
	/// client answer for a duplex-capable transport to write.
	InteractionQuery {
		/// Provider interaction identity.
		id:      u32,
		/// Provider-defined interaction kind.
		kind:    Str,
		/// Opaque interaction payload.
		payload: Bytes,
		/// Prepared client answer frame; `None` when the codec deliberately
		/// leaves the query unanswered.
		reply:   Option<Bytes>,
	},
	/// Provider cancels an outstanding tool or control call.
	Cancel {
		/// Canonical call identity.
		call: ToolCallId,
	},
	/// Provider acknowledges incremental session state.
	StateAccepted {
		/// Accepted session sequence.
		sequence: u64,
	},
	/// Provider asks the client to replay from a sequence boundary.
	ReplayFrom {
		/// Requested replay sequence.
		sequence: u64,
	},
	/// Provider reports an optimistic-concurrency conflict.
	Conflict {
		/// Expected sequence.
		expected: u64,
		/// Actual sequence.
		actual:   u64,
	},
	/// Provider rolls back uncommitted incremental state.
	Rollback {
		/// Rollback sequence.
		sequence: u64,
	},
	/// Provider requests an externally executed workflow action.
	WorkflowAction {
		/// Provider workflow request identity.
		request_id: Str,
		/// Provider workflow action name.
		name:       Str,
		/// Opaque action arguments.
		arguments:  Bytes,
		/// Optional provider deadline.
		timeout_ms: Option<u64>,
	},
	/// Provider supplies a reconnect/resume cursor for a workflow.
	WorkflowResume {
		/// Provider workflow identity.
		workflow_id:   Str,
		/// Provider session identity.
		session_id:    Str,
		/// Optional last observed provider event identity.
		last_event_id: Option<Str>,
	},
	/// Internal envelope accepted a request and reports whether it is replayed.
	Accepted {
		/// Whether the accepted request is replayed.
		replay: bool,
	},
	/// Internal envelope reports an opaque revision conflict.
	RevisionConflict {
		/// Current opaque revision.
		actual_revision: Str,
	},
	/// Internal envelope rolled back to an opaque revision.
	RolledBack {
		/// Optional opaque rollback revision.
		revision: Option<Str>,
	},
	/// Internal envelope confirms cancellation.
	Cancelled,
}

/// Client response accepted only by a live bidirectional provider attempt.
pub type ProviderControlInput = WorkflowResponse;

/// Codec-emitted terminal facts before final accounting is merged.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RawCompletion {
	/// Normalized provider finish reason.
	pub reason: FinishReason,
	/// Number of canonical content blocks emitted by the attempt.
	pub blocks: u32,
	/// Final attempt usage known at codec completion.
	pub usage:  Usage,
}

/// Closed, typed output vocabulary produced by sans-I/O decoders.
pub enum RawEvent {
	/// Non-terminal canonical generative chat event.
	Chat(ChatEvent),
	/// Terminal chat facts retained internally until final receipt accounting is
	/// complete.
	Completion(RawCompletion),
	/// Syntactically complete tool input that recovery must validate before
	/// authorization.
	ToolCallComplete {
		/// Provider tool-call index.
		index: u32,
		/// Complete unvalidated tool call.
		call:  UnvalidatedToolCall,
	},
	/// Typed unary or operation-specific output.
	Answer(AnswerBody),
	/// Provider-side state evidence consumed by session middleware.
	ProviderState(ProviderStateEvent),
	/// Typed bidirectional protocol control.
	Control(ProviderControlEvent),
	/// Incremental image-generation output.
	ImageGeneration(GenerationEvent<ImageArtifact>),
	/// Incremental video-generation output.
	VideoGeneration(GenerationEvent<VideoArtifact>),
	/// Incremental encoded speech output.
	Audio(AudioChunk),
	/// Incremental transcription output.
	Transcript(TranscriptEvent),
	/// Lossless native response bytes emitted incrementally.
	NativeChunk(Bytes),
	/// Typed provider response metadata.
	Metadata(ProviderMetadataEvent),
	/// Typed provider telemetry consumed by receipt and observation layers.
	Telemetry(ProviderTelemetryEvent),
	/// Conservative runtime discovery rows awaiting catalog normalization.
	DiscoveredModels {
		/// Normalized discovery rows.
		rows:        Vec<DiscoveredModel>,
		/// Optional provider pagination cursor.
		next_cursor: Option<Str>,
	},
	/// Structured provider failure. No raw secret-bearing source text is
	/// retained.
	Failure(Error),
}

/// Provider-specific incremental decoder constructed once per attempt.
pub trait Decoder: Send {
	/// Consumes one already-framed transport payload and emits zero or more
	/// typed events.
	fn push(&mut self, frame: Frame, emit: &mut dyn FnMut(RawEvent)) -> Result<(), Error>;

	/// Completes the stream, flushing partial state or returning a typed
	/// truncation error.
	fn finish(&mut self, emit: &mut dyn FnMut(RawEvent)) -> Result<(), Error>;
	/// Returns whether a provider terminal envelope completed the response even
	/// if the transport body remains open.
	fn is_complete(&self) -> bool {
		false
	}
	/// Resets state for one browser-backed replay after this decoder identified
	/// a credential-free navigation challenge.
	fn prepare_browser_retry(&mut self) -> bool {
		false
	}

	/// Returns whether this ordinary decoder owns a live provider response path.
	fn supports_control(&self) -> bool {
		false
	}

	/// Encodes one correlated client response for the same provider session.
	fn encode_control(&mut self, _input: ProviderControlInput) -> Result<Option<Bytes>, Error> {
		Ok(None)
	}
}

/// Construction-time decoder erasure at the transport I/O boundary.
pub type DecoderState = Box<dyn Decoder>;
/// Short bounded batch of provider frames produced by one canonical realtime
/// input.
///
/// A canonical action may require more than one ordered wire message, such as
/// committing buffered audio and then requesting response creation. The
/// transport enforces the frame-size bound on every element.
pub type RealtimeWireFrames = SmallVec<Bytes, 2>;

/// Short bounded batch of canonical events decoded from one realtime provider
/// payload.
///
/// Empty batches represent provider acknowledgements with no canonical meaning.
/// Multiple events preserve semantic ordering when one payload starts a block
/// and its tool call.
pub type RealtimeEvents = SmallVec<RealtimeEvent, 4>;

/// Sans-I/O provider codec for one bidirectional realtime session.
///
/// The transport owns the bounded channel pump and enforces
/// `EncodedRequest::bounds.frame` on every encoded and received frame.
pub trait RealtimeWireCodec: Send + 'static {
	/// Encodes ordered provider initialization frames after upgrade and before
	/// the session is ready.
	///
	/// The transport sends every returned frame before accepting caller input or
	/// emitting [`RealtimeEvent::Ready`].
	fn initial_frames(&mut self) -> Result<RealtimeWireFrames, Error>;

	/// Encodes one canonical caller message into a short ordered batch of
	/// provider wire frames.
	fn encode(&mut self, input: RealtimeInput) -> Result<RealtimeWireFrames, Error>;

	/// Decodes one bounded provider payload into zero or more ordered canonical
	/// events.
	fn decode(&mut self, payload: Bytes) -> Result<RealtimeEvents, Error>;
}

/// Construction-time erasure for one provider realtime wire codec.
pub type RealtimeWireCodecState = Box<dyn RealtimeWireCodec>;

/// Pure wire codec: no network, authentication, account selection, or retry
/// behavior.
pub trait Codec: Send + Sync + 'static {
	/// Lowers one canonical operation into a secret-free wire request.
	fn encode(
		&self,
		context: &EncodeContext<'_>,
		operation: &OperationCall,
	) -> Result<EncodedRequest, Error>;

	/// Lowers a realtime operation into its secret-free bidirectional transport
	/// handshake.
	///
	/// Ordinary codecs return `None`; realtime-capable codecs return the
	/// complete planned handshake without deriving protocol support from
	/// provider or model names.
	fn encode_realtime_handshake(
		&self,
		_context: &EncodeContext<'_>,
		_operation: &OperationCall,
	) -> Result<Option<EncodedRequest>, Error> {
		Ok(None)
	}

	/// Constructs fresh incremental state for one ordinary response attempt.
	fn decoder(&self, context: &DecodeContext<'_>) -> Result<DecoderState, Error>;

	/// Constructs fresh bidirectional wire state for a realtime operation.
	///
	/// Ordinary codecs return `None`; a realtime-capable codec returns `Some`
	/// and the transport request must leave its ordinary decoder absent.
	fn realtime(
		&self,
		_context: &DecodeContext<'_>,
	) -> Result<Option<RealtimeWireCodecState>, Error> {
		Ok(None)
	}
}
/// Clone-cheap cooperative cancellation shared by a transport and its response
/// stream.
#[derive(Clone, Default)]
pub struct Cancellation {
	state: Arc<CancellationState>,
}

#[derive(Default)]
struct CancellationState {
	cancelled: AtomicBool,
	waker:     AtomicWaker,
}

impl Cancellation {
	/// Requests cancellation and wakes a pending transport poll.
	pub fn cancel(&self) {
		self.state.cancelled.store(true, Ordering::Release);
		self.state.waker.wake();
	}

	/// Returns whether cancellation has been requested.
	pub fn is_cancelled(&self) -> bool {
		self.state.cancelled.load(Ordering::Acquire)
	}

	/// Registers a transport waker and observes cancellation without a lost
	/// wakeup.
	pub fn poll_cancelled(&self, context: &mut Context<'_>) -> Poll<()> {
		if self.is_cancelled() {
			return Poll::Ready(());
		}
		self.state.waker.register(context.waker());
		if self.is_cancelled() {
			Poll::Ready(())
		} else {
			Poll::Pending
		}
	}
}

impl fmt::Debug for Cancellation {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter
			.debug_struct("Cancellation")
			.field("cancelled", &self.is_cancelled())
			.finish()
	}
}

/// Attempt metadata required by the wire transport.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TransportAttempt {
	/// Logical request identity.
	pub request_id:          RequestId,
	/// Durable conversation/session identity for private debug capture.
	pub session:             Option<Str>,
	/// Provider selected for this attempt.
	pub provider:            ProviderId,
	/// Normalized model selected for this attempt.
	pub model:               Option<ModelKey>,
	/// Catalog API/codec family selected for this attempt.
	pub api:                 Str,
	/// Route selected for this attempt.
	pub route:               RouteId,
	/// Account selected without credential material.
	pub account:             Option<AccountId>,
	/// Principal selected for affinity.
	pub principal:           Option<PrincipalId>,
	/// Zero-based attempt index.
	pub index:               u32,
	/// Whether events remain provisional behind an output gate.
	pub provisional:         bool,
	/// Attempt-local timeout after composing the call deadline, remaining
	/// execution budget, and transport bound.
	pub timeout:             Duration,
	/// Maximum wait after response headers for the first decoded commit event.
	pub first_event_timeout: Option<Duration>,
	/// Maximum sanitized capture bytes for observability or cassettes.
	pub capture_limit:       u64,
}

/// Sanitized provider response facts offered before stream decoding.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderResponseObservation {
	/// Catalog provider identity.
	pub provider:   ProviderId,
	/// Normalized model identity.
	pub model:      ModelKey,
	/// Catalog API/codec family.
	pub api:        Str,
	/// HTTP status code.
	pub status:     u16,
	/// Lowercase response headers with cookies removed.
	pub headers:    Box<[(Str, Str)]>,
	/// Provider-reported request identity, when present.
	pub request_id: Option<Str>,
}

/// Bounded provider request facts exposed before canonical wire encoding.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BeforeRequestDraft {
	/// Catalog provider identity.
	pub provider:             ProviderId,
	/// Concrete route selected for this attempt.
	pub route:                RouteId,
	/// Normalized model identity, when the operation has one.
	pub model:                Option<ModelKey>,
	/// Closed operation vocabulary.
	pub operation:            OperationKind,
	/// Top-level scalar settings; message content is never included.
	pub scalars:              JsonMap<String, JsonValue>,
	/// Public headers known before codec lowering.
	pub headers:              Box<[RequestHeader]>,
	/// Negotiated intents in their canonical CONTROL representation.
	pub intents:              Box<[JsonValue]>,
	/// Number of canonical chat messages without their content.
	pub message_count:        usize,
	/// Prompt-size estimate when one is already available.
	pub approx_prompt_tokens: Option<u64>,
}

/// Accepted `before_request` transform after ordered host composition.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct BeforeRequestMutation {
	/// Shallow top-level request-body overlay.
	pub body:    JsonMap<String, JsonValue>,
	/// Public header replacements; `None` removes a header.
	pub headers: Box<[(Str, Option<Str>)]>,
	/// Optional narrowing of the draft's capability intents.
	pub intents: Option<Box<[JsonValue]>>,
	/// Optional tighter transport timeout.
	pub timeout: Option<Duration>,
}

/// Explicit `before_request` denial returned by a subscribed extension.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BeforeRequestDenied {
	/// User-safe denial reason.
	pub reason: Str,
	/// Stable extension-provided classifier, when present.
	pub code:   Option<Str>,
}

/// Secret-free credential disable facts emitted by the auth authority.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CredentialDisabledObservation {
	/// Catalog provider identity.
	pub provider: ProviderId,
	/// Stable account identity, when known.
	pub account:  Option<AccountId>,
	/// Authority-supplied disable cause.
	pub cause:    Str,
}

/// Session hook sink for provider request gates and response observations.
pub trait ProviderResponseObserver: provider_hooks::ProviderHookObserver {
	/// Returns the subscription bitmap bit without constructing a payload.
	fn subscribed(&self) -> bool;
	/// Offers one already-sanitized response payload.
	fn observe(&self, observation: ProviderResponseObservation);

	/// Returns whether `before_request` has any subscribed handler.
	fn before_request_subscribed(&self) -> bool {
		false
	}

	/// Composes one bounded pre-encoding request gate.
	///
	/// Callback failures are fail-open and return the default mutation. Only
	/// an explicit hook denial returns [`BeforeRequestDenied`].
	fn before_request<'a>(
		&'a self,
		_draft: &'a BeforeRequestDraft,
	) -> Pin<Box<dyn Future<Output = Result<BeforeRequestMutation, BeforeRequestDenied>> + Send + 'a>>
	{
		Box::pin(async { Ok(BeforeRequestMutation::default()) })
	}

	/// Returns whether `credential_disabled` has any subscribed observer.
	fn credential_disabled_subscribed(&self) -> bool {
		false
	}

	/// Offers one secret-free credential disable observation.
	fn observe_credential_disabled(&self, _observation: CredentialDisabledObservation) {}
}

/// Clone-cheap optional provider request/response hook sink, plus the
/// caller's retry observer (the transport retry layer publishes
/// [`crate::layer::retry::RetryNotice`]s to it before each backoff wait).
#[derive(Clone, Default)]
pub struct ProviderResponseHooks(
	Option<Arc<dyn ProviderResponseObserver>>,
	Option<crate::layer::retry::RetrySink>,
);

impl ProviderResponseHooks {
	/// Wraps one session hook sink.
	pub fn new(observer: Arc<dyn ProviderResponseObserver>) -> Self {
		Self(Some(observer), None)
	}

	/// Returns these hooks with a retry observer installed.
	#[must_use]
	pub fn with_retry_sink(mut self, sink: crate::layer::retry::RetrySink) -> Self {
		self.1 = Some(sink);
		self
	}

	/// The caller's retry observer, if one was installed.
	#[must_use]
	pub fn retry_sink(&self) -> Option<crate::layer::retry::RetrySink> {
		self.1.clone()
	}

	/// Returns the subscription bitmap bit.
	#[inline]
	pub fn subscribed(&self) -> bool {
		self
			.0
			.as_ref()
			.is_some_and(|observer| observer.subscribed())
	}

	/// Offers an encoded observation to the subscribed sink.
	pub fn observe(&self, observation: ProviderResponseObservation) {
		if let Some(observer) = &self.0 {
			observer.observe(observation);
		}
	}

	/// Returns the `before_request` subscription bitmap bit.
	#[inline]
	pub fn before_request_subscribed(&self) -> bool {
		self
			.0
			.as_ref()
			.is_some_and(|observer| observer.before_request_subscribed())
	}

	/// Composes one bounded request gate through the installed session sink.
	pub async fn before_request(
		&self,
		draft: &BeforeRequestDraft,
	) -> Result<BeforeRequestMutation, BeforeRequestDenied> {
		match &self.0 {
			Some(observer) => observer.before_request(draft).await,
			None => Ok(BeforeRequestMutation::default()),
		}
	}

	/// Returns the `credential_disabled` subscription bitmap bit.
	#[inline]
	pub fn credential_disabled_subscribed(&self) -> bool {
		self
			.0
			.as_ref()
			.is_some_and(|observer| observer.credential_disabled_subscribed())
	}

	/// Offers one credential disable observation to the installed session sink.
	pub fn observe_credential_disabled(&self, observation: CredentialDisabledObservation) {
		if let Some(observer) = &self.0 {
			observer.observe_credential_disabled(observation);
		}
	}

	/// Returns whether `provider_login` has a provider-matching handler.
	pub fn provider_login_subscribed(&self, provider: &ProviderId<str>) -> bool {
		self
			.0
			.as_ref()
			.is_some_and(|observer| observer.provider_login_subscribed(provider))
	}

	/// Dispatches one fail-closed extension login.
	pub async fn provider_login(
		&self,
		request: ProviderLoginHookRequest,
	) -> Result<ProviderHookCredential, ProviderHookError> {
		match &self.0 {
			Some(observer) => observer.provider_login(request).await,
			None => Err(ProviderHookError::Unavailable),
		}
	}

	/// Returns whether `provider_refresh` has a provider-matching handler.
	pub fn provider_refresh_subscribed(&self, provider: &ProviderId<str>) -> bool {
		self
			.0
			.as_ref()
			.is_some_and(|observer| observer.provider_refresh_subscribed(provider))
	}

	/// Dispatches one fail-closed extension refresh.
	pub async fn provider_refresh(
		&self,
		request: ProviderRefreshHookRequest,
	) -> Result<ProviderHookCredential, ProviderHookError> {
		match &self.0 {
			Some(observer) => observer.provider_refresh(request).await,
			None => Err(ProviderHookError::Unavailable),
		}
	}

	/// Returns whether `provider_sign` has a provider-matching handler.
	pub fn provider_sign_subscribed(&self, provider: &ProviderId<str>) -> bool {
		self
			.0
			.as_ref()
			.is_some_and(|observer| observer.provider_sign_subscribed(provider))
	}

	/// Dispatches one fail-closed attempt signer.
	pub async fn provider_sign(
		&self,
		request: ProviderSignHookRequest,
	) -> Result<ProviderSignature, ProviderHookError> {
		match &self.0 {
			Some(observer) => observer.provider_sign(request).await,
			None => Err(ProviderHookError::Unavailable),
		}
	}

	/// Returns whether `models_discover` has a provider-matching handler.
	pub fn models_discover_subscribed(&self, provider: &ProviderId<str>) -> bool {
		self
			.0
			.as_ref()
			.is_some_and(|observer| observer.models_discover_subscribed(provider))
	}

	/// Dispatches one fail-open-at-caller extension discovery page.
	pub async fn models_discover(
		&self,
		request: ModelsDiscoverHookRequest,
	) -> Result<ModelsDiscoverHookPage, ProviderHookError> {
		match &self.0 {
			Some(observer) => observer.models_discover(request).await,
			None => Err(ProviderHookError::Unavailable),
		}
	}
}

impl fmt::Debug for ProviderResponseHooks {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter
			.debug_tuple("ProviderResponseHooks")
			.field(&self.0.is_some())
			.field(&self.1.is_some())
			.finish()
	}
}

/// Fully encoded transport call with a fresh decoder and cancellation handle.
pub struct TransportRequest {
	/// Secret-free encoded request, never mutated by credential application.
	pub encoded:        EncodedRequest,
	/// Credentials applied at the innermost boundary and ignored by logs and
	/// cassettes.
	pub credentials:    Option<AppliedCredentials>,
	/// Sensitive extension-produced signing additions applied beside
	/// credentials only at the innermost transport boundary.
	pub signature:      Option<ProviderSignature>,
	/// Fresh ordinary provider decoder, present exactly when `realtime` is
	/// absent.
	pub decoder:        Option<DecoderState>,
	/// Provider realtime wire codec, present exactly when `decoder` is absent.
	pub realtime:       Option<RealtimeWireCodecState>,
	/// Cooperative cancellation handle.
	pub cancel:         Cancellation,
	/// Bitmap-gated provider request/response hook sink.
	pub response_hooks: ProviderResponseHooks,
	/// Attempt identity and capture policy.
	pub attempt:        TransportAttempt,
}

/// Sanitized response handshake metadata.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HandshakeMeta {
	/// HTTP-like status when the transport has one.
	pub status:              Option<u16>,
	/// Public response headers retained after allowlisting.
	pub headers:             Box<[RequestHeader]>,
	/// Provider request identifier, if present.
	pub provider_request_id: Option<Str>,
}

/// Raw event stream returned after the first decodable event or typed error is
/// known.
pub type RawEventStream = Pin<Box<dyn Stream<Item = Result<RawEvent, Error>> + Send + 'static>>;

/// Response returned only after transport handshake and first codec output.
pub struct HandshakenResponse {
	/// Sanitized handshake metadata.
	pub meta:     HandshakeMeta,
	/// Live request-body evidence retained until response stream termination.
	pub body:     AttemptEvidenceHandle,
	/// Ordinary decoded event stream.
	pub events:   Option<RawEventStream>,
	/// Same-session response path for an ordinary bidirectional stream.
	pub control:  Option<flume::Sender<ProviderControlInput>>,
	/// Owned realtime session; present exactly when `events` is absent.
	pub realtime: Option<RealtimeSession>,
}

#[cfg(test)]
mod tests {
	use omp_catalog::Catalog;
	use omp_core::Str;

	use super::{anthropic, gemini, google_cca, openai_chat, openai_codex, openai_responses};

	fn representative_uri(codec: &str, base: &str) -> Str {
		match codec {
			"anthropic" if base.contains(":streamRawPredict") => Str::new(base),
			"anthropic" => anthropic::direct_uri(base),
			"bedrock-converse" => openai_chat::join_uri(base, "/model/test/converse-stream"),
			"cursor" => openai_chat::join_uri(base, "/agent.v1.AgentService/Run"),
			"devin" => {
				openai_chat::join_uri(base, "/exa.api_server_pb.ApiServerService/GetChatMessage")
			},
			"gitlab-duo" | "local" => Str::new(base),
			"google-cca" => openai_chat::join_uri(base, google_cca::STREAM_GENERATE_PATH),
			"google-genai" => {
				openai_chat::join_uri(base, "/models/test:streamGenerateContent?alt=sse")
			},
			"google-vertex" => {
				let path = if gemini::vertex_version_prefix(base).is_empty() {
					"/projects/test/locations/test/publishers/google/models/test:streamGenerateContent?\
					 alt=sse"
				} else {
					"/v1/projects/test/locations/test/publishers/google/models/test:\
					 streamGenerateContent?alt=sse"
				};
				openai_chat::join_uri(base, path)
			},
			"ollama" => openai_chat::join_uri(base, "/api/chat"),
			"openai-chat" => {
				openai_chat::join_uri(base, openai_chat::OpenAiChatProfile::default().path.as_str())
			},
			"openai-codex" => openai_codex::resolve_codex_responses_url(base),
			"openai-responses" | "bedrock-mantle" => openai_responses::responses_uri(base),
			"search-exa" | "search-kagi" | "search-tavily" => openai_chat::join_uri(base, "/search"),
			"search-firecrawl" => openai_chat::join_uri(base, "/search"),
			"search-brave" => openai_chat::join_uri(base, "/res/v1/web/search"),
			"search-duckduckgo" => openai_chat::join_uri(base, "/html/"),
			"search-google" | "search-ecosia" | "search-mojeek" => {
				openai_chat::join_uri(base, "/search")
			},
			"search-startpage" => openai_chat::join_uri(base, "/sp/search"),
			"search-jina" | "search-tinyfish" => Str::new(base),
			"search-searxng" => openai_chat::join_uri(base, "/search"),
			"search-kimi" | "search-synthetic" | "search-zai" => {
				openai_chat::join_uri(base, "/chat/completions")
			},
			"search-parallel" => openai_chat::join_uri(base, "/v1beta/search"),
			"parallel-extract" => openai_chat::join_uri(base, "/v1beta/extract"),
			"search-perplexity" => openai_chat::join_uri(base, "/chat/completions"),
			unknown => panic!("embedded route uses unaudited codec {unknown}"),
		}
	}

	fn duplicated_adjacent_segment(uri: &str) -> Option<&str> {
		let without_query = uri.split_once('?').map_or(uri, |(path, _)| path);
		let path =
			without_query
				.split_once("://")
				.map_or(without_query, |(_, authority_and_path)| {
					authority_and_path
						.find('/')
						.map_or("", |path_start| &authority_and_path[path_start..])
				});
		let mut prior = None;
		for segment in path.split('/').filter(|segment| !segment.is_empty()) {
			if prior == Some(segment) {
				return Some(segment);
			}
			prior = Some(segment);
		}
		None
	}

	#[test]
	fn embedded_catalog_routes_never_duplicate_adjacent_uri_segments() {
		let catalog = Catalog::embedded();
		for route in catalog.routes() {
			let uri = representative_uri(route.codec.as_str(), route.endpoint.base_url.as_str());
			assert_eq!(
				duplicated_adjacent_segment(uri.as_str()),
				None,
				"route {} ({}) joined an adjacent duplicate in {uri}",
				route.id,
				route.codec,
			);
		}

		assert_eq!(
			representative_uri("openai-chat", "https://api.cerebras.ai/v1"),
			"https://api.cerebras.ai/v1/chat/completions",
		);
		assert_eq!(
			representative_uri("openai-responses", "https://api.openai.com/v1"),
			"https://api.openai.com/v1/responses",
		);
	}
}
