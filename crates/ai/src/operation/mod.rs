//! Shared operation validation and lifecycle state machines.

pub mod artifact;
pub mod discovery;
pub mod embedding;
pub mod image;
pub mod job;
pub mod native;
pub mod parallel_extract;
pub mod realtime;
pub mod search;
pub mod search_aggregate;
pub mod search_hosted;
pub mod search_query;
pub mod speech;
pub mod tokens;
pub mod transcription;
pub mod usage;
pub mod video;

use std::{sync::Arc, time, time::Instant};

use omp_core::Str;

use crate::{
	answer::{Answer, AnswerBody, ResponseMeta},
	call::{Call, CallAffinity, InferenceAttribution, OperationCall, SessionRequest, Target},
	catalog::{ModelKey, OperationKind, ProviderId, RouteId},
	error::{Error, ErrorDetail, ErrorKind, ErrorPhase, RetryAction},
	id::RequestId,
	plan::ExecutionPlan,
	receipt::{ExecutionBudget, ExecutionReceipt, ReasonId},
};

/// Fixed selected-route identity used by route-local operation backends.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RouteIdentity {
	/// Provider domain.
	pub provider: ProviderId,
	/// Concrete route.
	pub route:    RouteId,
	/// Normalized selected model.
	pub model:    ModelKey,
}

impl RouteIdentity {
	/// Creates response metadata for one logical request.
	pub fn response_meta(&self, request_id: RequestId) -> ResponseMeta {
		ResponseMeta {
			request_id,
			provider: self.provider.clone(),
			route: self.route.clone(),
			model: Some(self.model.clone()),
			provider_request_id: None,
			created_at: time::SystemTime::now(),
		}
	}
}

/// Clone-cheap typed input passed from an operation service to its route
/// backend.
#[derive(Clone, Debug)]
pub struct OperationRequest<T> {
	/// Logical request identity.
	pub id:             RequestId,
	/// Resolved model and route constraint.
	pub target:         Target,
	/// Absolute execution deadline.
	pub deadline:       Option<Instant>,
	/// Cross-attempt budget.
	pub budget:         ExecutionBudget,
	/// Optional conversation state.
	pub session:        Option<SessionRequest>,
	/// Observer-only session identity for bounded private wire capture.
	pub debug_session:  Option<Str>,
	/// Session-independent prompt-cache and provider-session identities.
	pub affinity:       CallAffinity,
	/// Bitmap-gated provider request/response hook sink.
	pub response_hooks: crate::codec::ProviderResponseHooks,
	/// Principal and extension charged for this request.
	pub attribution:    InferenceAttribution,
	/// Immutable selected execution plan.
	pub execution:      Option<Arc<ExecutionPlan>>,
	/// Operation-specific immutable payload.
	pub payload:        Arc<T>,
}

impl<T> OperationRequest<T> {
	/// Creates a typed backend request while preserving all shared call
	/// metadata.
	pub(crate) fn from_call(call: &Call, payload: Arc<T>) -> Self {
		Self {
			id: call.id.clone(),
			target: call.target.clone(),
			deadline: call.deadline,
			budget: call.budget.clone(),
			session: call.session.clone(),
			debug_session: call.debug_session.clone(),
			affinity: call.affinity.clone(),
			response_hooks: call.response_hooks.clone(),
			attribution: call.attribution.clone(),
			execution: call.execution.clone(),
			payload,
		}
	}

	/// Reconstructs the closed call for one operation-specific `RouteCodecSet`
	/// entry.
	pub fn into_call(self, wrap: impl FnOnce(Arc<T>) -> OperationCall) -> Call {
		Call {
			id:             self.id,
			target:         self.target,
			deadline:       self.deadline,
			budget:         self.budget,
			session:        self.session,
			debug_session:  self.debug_session,
			affinity:       self.affinity,
			response_hooks: self.response_hooks,
			attribution:    self.attribution,
			execution:      self.execution,
			operation:      wrap(self.payload),
			staging:        None,
		}
	}
}

/// Typed successful output returned by a route-local operation backend.
///
/// The backend supplies selected-route metadata and accounting because those
/// facts are known only after the inner auth/codec/transport stack runs.
#[derive(Clone, Debug)]
pub struct OperationResponse<T> {
	/// Selected-route response metadata.
	pub meta:    ResponseMeta,
	/// Accounting accumulated by the inner stack.
	pub receipt: ExecutionReceipt,
	/// Typed operation output.
	pub output:  T,
}

impl<T> OperationResponse<T> {
	/// Transforms the typed output without changing route evidence.
	pub fn map<U>(self, transform: impl FnOnce(T) -> U) -> OperationResponse<U> {
		OperationResponse {
			meta:    self.meta,
			receipt: self.receipt,
			output:  transform(self.output),
		}
	}

	/// Converts typed route output into the closed erased answer.
	pub fn into_answer(self, body: impl FnOnce(T) -> AnswerBody) -> Answer {
		Answer { meta: self.meta, receipt: self.receipt, body: body(self.output) }
	}
}

/// Merges accounting from a later unary subrequest into the first response.
pub(crate) fn merge_receipts(target: &mut ExecutionReceipt, mut later: ExecutionReceipt) {
	target.adjustments.append(&mut later.adjustments);
	target.attempts.append(&mut later.attempts);
	target.recoveries.append(&mut later.recoveries);
	target.staging.append(&mut later.staging);
	target.usage += later.usage;
	target.cost += later.cost;
	target.timings.queued += later.timings.queued;
	target.timings.planning += later.timings.planning;
	target.timings.authentication += later.timings.authentication;
	target.timings.encoding += later.timings.encoding;
	target.timings.streaming += later.timings.streaming;
	target.timings.total += later.timings.total;
	target.timings.first_frame = match (target.timings.first_frame, later.timings.first_frame) {
		(Some(left), Some(right)) => Some(left + right),
		(left, right) => left.or(right),
	};
	target.timings.completed_at = target.timings.completed_at.max(later.timings.completed_at);
}

pub(crate) fn wrong_operation(call: &Call, expected: OperationKind) -> Error {
	Error::new(
		ErrorKind::InternalInvariant,
		ErrorPhase::Internal,
		RetryAction::Never,
		ExecutionReceipt::default(),
	)
	.detail(ErrorDetail::capability(
		Str::new(expected.to_string()),
		ReasonId(omp_core::sf!("operation_service_mismatch")),
	))
	.request_id(call.id.clone())
}

/// Typed operation-policy or media-lifecycle failure carried through [`Error`].
#[allow(missing_docs, reason = "crate-private variants are documented by their error messages")]
#[derive(Clone, Debug, strum::IntoStaticStr, thiserror::Error)]
#[strum(serialize_all = "snake_case")]
pub(crate) enum MediaOperationError {
	#[error("{0}")]
	#[strum(serialize = "image_operation_failed")]
	Image(#[from] image::ImageError),
	#[error("{0}")]
	#[strum(serialize = "speech_operation_failed")]
	Speech(#[from] speech::SpeechError),
	#[error("{0}")]
	#[strum(serialize = "transcription_operation_failed")]
	Transcription(#[from] transcription::TranscriptionError),
	#[error("{0}")]
	#[strum(serialize = "video_operation_failed")]
	Video(#[from] video::VideoError),
	#[error("{0}")]
	#[strum(serialize = "realtime_operation_failed")]
	Realtime(#[from] realtime::RealtimeSessionError),
	#[error("operation policy requires an execution plan")]
	OperationPolicyRequiresExecutionPlan,
	#[error("embedding policy was not constructed")]
	EmbeddingPolicyNotConstructed,
	#[error("selected model has no embedding capabilities")]
	SelectedModelHasNoEmbeddingCapabilities,
	#[error("embedding batch capacity is zero")]
	ZeroEmbeddingBatchCapacity,
	#[error("one-shot embedding cannot open multiple batches")]
	OneShotEmbeddingCannotOpenMultipleBatches,
	#[error("selected model has no search capabilities")]
	SelectedModelHasNoSearchCapabilities,
	#[error("exact token count policy was not constructed")]
	ExactTokenCountNotConstructed,
	#[error("discovery policy was not constructed")]
	DiscoveryPolicyNotConstructed,
	#[error("discovery page size is invalid")]
	InvalidDiscoveryPageSize,
	#[error("native operation policy was not constructed")]
	NativePolicyNotConstructed,
	#[error("image request was not dispatched")]
	ImageRequestNotDispatched,
	#[error("speech request was not dispatched")]
	SpeechRequestNotDispatched,
	#[error("transcription request was not dispatched")]
	TranscriptionRequestNotDispatched,
	#[error("video request was not dispatched")]
	VideoRequestNotDispatched,
	#[error("realtime request was not dispatched")]
	RealtimeRequestNotDispatched,
	#[error("embedding batch route changed")]
	EmbeddingBatchRouteChanged,
	#[error("embedding page dimensions changed")]
	EmbeddingPageDimensionsChanged,
	#[error("exact token count returned an estimate")]
	ExactTokenCountReturnedEstimate,
	#[error("tokenization returned an estimate")]
	TokenizeReturnedEstimate,
	#[error("detokenization returned an estimate")]
	DetokenizeReturnedEstimate,
	#[error("required embedding dimensions were not returned")]
	RequiredEmbeddingDimensionsNotReturned,
	#[error("normalized discovery page is invalid")]
	InvalidNormalizedDiscoveryPage,
	#[error("discovery page contains an unrequested operation")]
	DiscoveryPageContainsUnrequestedOperation,
}

pub(crate) fn media_validation_error(
	operation: OperationKind,
	failure: impl Into<MediaOperationError>,
) -> Error {
	let failure = failure.into();
	let reason: &'static str = failure.clone().into();
	let reason = ReasonId(Str::new_static(reason));
	Error::new(
		ErrorKind::InvalidRequest,
		ErrorPhase::Planning,
		RetryAction::Never,
		ExecutionReceipt::default(),
	)
	.detail(ErrorDetail::capability(Str::new(operation.to_string()), reason))
	.typed_source(failure)
}

pub(crate) fn media_protocol_error(
	operation: OperationKind,
	failure: impl Into<MediaOperationError>,
) -> Error {
	let failure = failure.into();
	let reason: &'static str = failure.clone().into();
	let reason = ReasonId(Str::new_static(reason));
	Error::new(
		ErrorKind::ProviderContractMismatch,
		ErrorPhase::Streaming,
		RetryAction::Never,
		ExecutionReceipt::default(),
	)
	.committed(true)
	.detail(ErrorDetail::capability(Str::new(operation.to_string()), reason))
	.typed_source(failure)
}
