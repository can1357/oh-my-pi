//! Cloneable structured failures with explicit retry scope.

use std::{
	error,
	fmt::{self, Display},
	mem, sync,
	time::Duration,
};

use omp_core::Str;

use crate::{
	answer::{AnswerKind, SearchFailureKind, SearchProviderFailure},
	auth::AwsCredentialError,
	catalog::{OperationKind, ProviderId, RouteId},
	id::RequestId,
	operation::{MediaOperationError, discovery::CatalogDiscoveryProjectorError},
	receipt::{ExecutionReceipt, ReasonId},
};

/// Stable, policy-consumable failure category.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ErrorKind {
	/// Caller cancellation.
	Cancelled,
	/// Absolute deadline elapsed.
	DeadlineExceeded,
	/// An execution budget dimension was exhausted.
	BudgetExhausted,
	/// Transactional output exceeded its configured in-memory or secure-spool
	/// bound.
	PolicyBufferExceeded,
	/// Domain-name resolution failed.
	Dns,
	/// TLS negotiation or verification failed.
	Tls,
	/// Connection establishment or transport connectivity failed.
	Connectivity,
	/// Wire protocol contract was violated.
	Protocol,
	/// A committed or provisional stream was corrupt.
	StreamCorruption,
	/// Credential was absent, expired, or rejected.
	Authentication,
	/// Durable credentials could not be encrypted because the configured
	/// operating-system credential facility is unavailable.
	CredentialStorageUnavailable,
	/// Principal lacks permission for the operation.
	Authorization,
	/// Account was disabled or rejected.
	AccountDisabled,
	/// A rate window rejected the attempt.
	RateLimited,
	/// Account quota was exhausted.
	QuotaExhausted,
	/// Provider requires payment or credit.
	PaymentRequired,
	/// Canonical request was invalid.
	InvalidRequest,
	/// Requested target or selector resolved to no catalog model.
	TargetNotFound,
	/// Capability support is unknown and caller policy forbids assuming it.
	CapabilityUnknown,
	/// Typed native options do not match the selected codec.
	CodecMismatch,
	/// No constructed service is available for an otherwise eligible route.
	RouteUnavailable,
	/// Catalog or route state changed after a plan was produced.
	StalePlan,
	/// Requested recovery requires replayable input.
	ReplayRequired,
	/// One-shot input requires explicitly enabled secure staging.
	StagingRequired,
	/// Selected model or route cannot satisfy required capability intent.
	CapabilityMismatch,
	/// Provider contradicted its catalog-advertised contract.
	ProviderContractMismatch,
	/// Canonical context exceeds an applicable model or wire limit.
	ContextOverflow,
	/// Fixed request bytes or provider media budgets were rejected.
	PayloadRejected,
	/// Provider content filtering stopped output.
	ContentFilter,
	/// Provider emitted a safety refusal.
	SafetyRefusal,
	/// Model output could not be decoded within protocol bounds.
	MalformedModelOutput,
	/// Structured output could not satisfy its declared contract.
	StructuredOutputFailure,
	/// Required tool-call intent was not satisfied.
	ToolNonCompliance,
	/// Reasoning loop bounds were exceeded.
	RepeatedReasoning,
	/// Repeated tool-call loop bounds were exceeded.
	RepeatedToolCall,
	/// Model produced no usable completion.
	EmptyCompletion,
	/// Provider completed without actionable output, requiring session-level
	/// continuation.
	EmptyOutput,
	/// Provider-side session state expired.
	SessionExpired,
	/// Conversation or provider-state revision conflicted.
	SessionConflict,
	/// Required local model or runtime is unavailable.
	LocalModelUnavailable,
	/// Local memory, compute, storage, or concurrency was exhausted.
	ResourceExhausted,
	/// Native method/path or payload exceeded its allowlist contract.
	NativeRequestRejected,
	/// An internal invariant was violated.
	InternalInvariant,
}

/// Classifies context-capacity versus fixed-payload rejection evidence.
///
/// Context-window or provider history-limit evidence on any source-chain link,
/// or a prior typed overflow, wins over HTTP 413's payload fallback. This
/// permits late response-body finalization to replace a status-only payload
/// inference without losing cause-chain evidence.
pub fn classify_provider_rejection(
	status: Option<u16>,
	message: Option<&str>,
	source: Option<&(dyn error::Error + 'static)>,
	prior: Option<ErrorKind>,
) -> Option<ErrorKind> {
	let source_has_overflow_evidence = source.is_some_and(|root| {
		let mut link = Some(root);
		while let Some(cause) = link {
			if cause
				.downcast_ref::<Error>()
				.is_some_and(|error| error.kind == ErrorKind::ContextOverflow)
				|| has_context_overflow_evidence(&cause.to_string())
			{
				return true;
			}
			link = cause.source();
		}
		false
	});
	if prior == Some(ErrorKind::ContextOverflow)
		|| message.is_some_and(has_context_overflow_evidence)
		|| source_has_overflow_evidence
	{
		return Some(ErrorKind::ContextOverflow);
	}
	if status == Some(413) || message.is_some_and(has_payload_rejection_evidence) {
		return Some(ErrorKind::PayloadRejected);
	}
	None
}

fn has_context_overflow_evidence(text: &str) -> bool {
	const DIRECT: &[&str] = &[
		"prompt is too long",
		"input is too long for requested model",
		"exceeds the context window",
		"maximum context length",
		"maximum prompt length",
		"reduce the length of the messages",
		"exceeds the available context size",
		"context window exceeded",
		"context window overflow",
		"context window too small",
		"context length exceeded",
		"context length overflow",
		"context length too small",
		"context size exceeded",
		"context size overflow",
		"context size too small",
		"too many tokens",
		"token limit exceeded",
		"model_context_window_exceeded",
		"prompt filled the context window",
	];
	DIRECT
		.iter()
		.any(|needle| contains_ascii_case_insensitive(text.as_bytes(), needle.as_bytes()))
		|| (contains_ascii_case_insensitive(text.as_bytes(), b"request_too_large")
			&& contains_ascii_case_insensitive(text.as_bytes(), b"token"))
		|| (contains_ascii_case_insensitive(text.as_bytes(), b"requested token")
			&& (contains_ascii_case_insensitive(text.as_bytes(), b"exceed")
				|| contains_ascii_case_insensitive(text.as_bytes(), b"maximum")))
		|| (contains_ascii_case_insensitive(text.as_bytes(), b"exceeds the limit of")
			&& contains_ascii_case_insensitive(text.as_bytes(), b"token"))
		|| (contains_ascii_case_insensitive(text.as_bytes(), b"chat history exceeds the")
			&& contains_ascii_case_insensitive(text.as_bytes(), b"-message limit"))
}

fn has_payload_rejection_evidence(text: &str) -> bool {
	const PATTERNS: &[&str] = &[
		"payload too large",
		"content too large",
		"request entity too large",
		"request body too large",
		"request body exceeds",
		"maximum request size",
		"request_too_large",
		"image count exceeds",
		"image limit",
		"media limit",
		"413 (no body)",
	];
	PATTERNS
		.iter()
		.any(|needle| contains_ascii_case_insensitive(text.as_bytes(), needle.as_bytes()))
}
/// Returns whether provider text identifies a replay-safe generation fault.
pub fn is_transient_generation_fault(text: &str) -> bool {
	let bytes = text.as_bytes();
	(contains_ascii_case_insensitive(bytes, b"floating point nan")
		|| contains_ascii_case_insensitive(bytes, b"floating-point nan")
		|| contains_ascii_case_insensitive(bytes, b"floating_point nan"))
		&& contains_ascii_case_insensitive(bytes, b"detected in generation")
}

fn contains_ascii_case_insensitive(haystack: &[u8], needle: &[u8]) -> bool {
	needle.is_empty()
		|| haystack.windows(needle.len()).any(|window| {
			window
				.iter()
				.zip(needle)
				.all(|(left, right)| left.eq_ignore_ascii_case(right))
		})
}

/// Execution phase in which a failure was classified.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ErrorPhase {
	/// Side-effect-free planning and capability negotiation.
	Planning,
	/// Tower readiness and queue admission.
	Readiness,
	/// Route/account concurrency admission.
	Admission,
	/// Credential acquisition, refresh, or signing.
	Authentication,
	/// Canonical-to-wire encoding.
	Encoding,
	/// DNS, TLS, or connection establishment.
	Connecting,
	/// Response handshake and first decodable frame.
	Handshake,
	/// Committed or provisional response streaming.
	Streaming,
	/// Sans-I/O recovery or validation.
	Recovery,
	/// Conversation or provider-state handling.
	Session,
	/// Local backend loading or inference.
	LocalRuntime,
	/// Artifact staging, upload, download, or verification.
	Artifact,
	/// Usage or model discovery.
	Discovery,
	/// No narrower phase applies to an invariant failure.
	Internal,
}

/// Explicit action that policy may take for a structured failure.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RetryAction {
	/// No automatic action is safe.
	Never,
	/// Retry the same route and account after a structured delay.
	SameRoute {
		/// Minimum delay before retrying.
		after: Duration,
	},
	/// Retry the same route up to a failure-specific bound.
	SameRouteLimited {
		/// Minimum delay before retrying.
		after:       Duration,
		/// Maximum retries after the first attempt.
		max_retries: u32,
	},
	/// Refresh credentials for the same account and principal.
	RefreshCredential,
	/// Refresh the current credential and replay exactly once without rotating
	/// to a sibling account.
	RefreshCredentialOnce,
	/// Select another eligible account.
	RotateAccount,
	/// Select another allowed route for the same normalized model.
	ReselectRoute,
	/// Replay canonical history to reseed provider-side state.
	ReseedSession,
	/// Run another transactionally gated semantic attempt.
	SemanticRetry,
}

/// Typed supplemental evidence that contains no secret-bearing source text.
#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
pub enum ErrorDetail {
	/// Erased answer variant did not match the typed operation contract.
	#[error("expected {expected:?} answer, got {actual:?}")]
	BodyVariantMismatch {
		/// Expected operation.
		expected: OperationKind,
		/// Actual erased body variant.
		actual:   AnswerKind,
	},
	/// A named budget dimension was exhausted at an integer observed value.
	#[error("budget {dimension} exhausted at {observed} of {limit}")]
	Budget {
		/// Exhausted budget dimension.
		dimension: Str,
		/// Configured integer limit.
		limit:     u128,
		/// Observed integer value.
		observed:  u128,
	},
	/// Context size evidence.
	#[error("context {observed} exceeds limit {limit}")]
	Context {
		/// Configured context limit.
		limit:    u64,
		/// Observed context size.
		observed: u64,
	},
	/// A capability requirement could not be satisfied.
	#[error("capability {feature} unavailable ({})", .reason.0)]
	Capability {
		/// Required feature.
		feature: Str,
		/// Typed failure reason.
		reason:  ReasonId,
	},
	/// An explicitly named tool was absent from the live declarations.
	#[error("named tool {name} is not declared")]
	NamedToolUnavailable {
		/// Requested tool name.
		name: Str,
	},
	/// A selector or target could not resolve.
	#[error("target {selector} did not resolve")]
	Target {
		/// Sanitized selector.
		selector: Str,
	},
	/// A previously produced execution plan is no longer valid.
	#[error("plan revision {planned_revision} superseded by {current_revision}")]
	StalePlan {
		/// Revision used during planning.
		planned_revision: Str,
		/// Current registry revision.
		current_revision: Str,
	},
	/// Replay or staging requirement evidence.
	#[error("replay required ({})", .reason.0)]
	Replay {
		/// Typed replay reason.
		reason: ReasonId,
	},
	/// Sanitized bounded protocol evidence.
	#[error("protocol violation ({})", .reason.0)]
	Protocol {
		/// Typed protocol reason.
		reason: ReasonId,
	},
	/// A local watchdog or attempt deadline elapsed before the awaited wire
	/// milestone.
	#[error("timed out after {elapsed_ms} ms waiting for {}", .scope.0)]
	Timeout {
		/// Typed milestone that was being awaited.
		scope:      ReasonId,
		/// Wall-clock milliseconds since the attempt started.
		elapsed_ms: u64,
	},
	/// The provider closed a successful response body before its terminal
	/// envelope.
	#[error("stream ended after {elapsed_ms} ms and {frames} frame(s) without a terminal event ({})", .reason.0)]
	StreamEnded {
		/// Codec-owned truncation reason.
		reason:     ReasonId,
		/// Wall-clock milliseconds since the attempt started.
		elapsed_ms: u64,
		/// Decoded wire frames observed before the body ended.
		frames:     u64,
	},
	/// An order-matched replay requested an exchange beyond the cassette.
	#[error("cassette miss at request {request_index}; only {recorded} exchanges were recorded")]
	CassetteMiss {
		/// Zero-based request index that could not be served.
		request_index: usize,
		/// Number of exchanges in the cassette.
		recorded:      usize,
	},
	/// Bounded provider message after codec-owned sanitization.
	#[error("{sanitized_message}")]
	Provider {
		/// Sanitized bounded provider message.
		sanitized_message: Str,
	},
	/// Ordered, bounded failures from an automatic search-provider chain.
	#[error("all search providers failed")]
	SearchFailures {
		/// Secret-free failure summary in attempt order.
		failures: sync::Arc<[SearchProviderFailure]>,
	},
	/// Local availability evidence.
	#[error("local backend unavailable ({})", .reason.0)]
	LocalUnavailable {
		/// Typed local-availability reason.
		reason: ReasonId,
	},
}

impl ErrorDetail {
	/// Records an exhausted budget dimension and its observed value.
	pub const fn budget(dimension: Str, limit: u128, observed: u128) -> Self {
		Self::Budget { dimension, limit, observed }
	}

	/// Records context size evidence.
	pub const fn context(limit: u64, observed: u64) -> Self {
		Self::Context { limit, observed }
	}

	/// Records an unsatisfied capability and its typed reason.
	pub const fn capability(feature: Str, reason: ReasonId) -> Self {
		Self::Capability { feature, reason }
	}

	/// Records a sanitized selector that did not resolve.
	pub const fn target(selector: Str) -> Self {
		Self::Target { selector }
	}

	/// Records the planned and current revisions for a stale plan.
	pub const fn stale_plan(planned_revision: Str, current_revision: Str) -> Self {
		Self::StalePlan { planned_revision, current_revision }
	}

	/// Records why replay or staging is required.
	pub const fn replay(reason: ReasonId) -> Self {
		Self::Replay { reason }
	}

	/// Records a sanitized protocol reason.
	pub const fn protocol(reason: ReasonId) -> Self {
		Self::Protocol { reason }
	}

	/// Records an elapsed local deadline and the milestone it was awaiting.
	pub fn timeout(scope: ReasonId, elapsed: Duration) -> Self {
		Self::Timeout { scope, elapsed_ms: u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX) }
	}

	/// Records a provider body that ended before its terminal envelope.
	pub fn stream_ended(reason: ReasonId, elapsed: Duration, frames: u64) -> Self {
		Self::StreamEnded {
			reason,
			elapsed_ms: u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX),
			frames,
		}
	}

	/// Records an order-matched cassette miss.
	pub const fn cassette_miss(request_index: usize, recorded: usize) -> Self {
		Self::CassetteMiss { request_index, recorded }
	}

	/// Records a sanitized provider message.
	pub const fn provider(sanitized_message: Str) -> Self {
		Self::Provider { sanitized_message }
	}

	/// Records ordered, secret-free search-provider failures.
	pub fn search_failures(failures: impl Into<sync::Arc<[SearchProviderFailure]>>) -> Self {
		Self::SearchFailures { failures: failures.into() }
	}

	/// Records why a local backend is unavailable.
	pub const fn local_unavailable(reason: ReasonId) -> Self {
		Self::LocalUnavailable { reason }
	}
}

/// Bulky diagnostics share the receipt's mandatory allocation so [`Error`]
/// remains cheap to return.
#[derive(Clone)]
struct ErrorEvidence {
	receipt:             ExecutionReceipt,
	detail:              Option<ErrorDetail>,
	media_source:        Option<MediaOperationError>,
	projector_source:    Option<CatalogDiscoveryProjectorError>,
	aws_registry_source: Option<AwsCredentialError>,
}

/// Concrete, cloneable, secret-free inference error.
#[derive(Clone)]
pub struct Error {
	/// Stable failure category.
	pub kind:       ErrorKind,
	/// Execution phase where the failure was classified.
	pub phase:      ErrorPhase,
	/// Explicit policy action.
	pub action:     RetryAction,
	/// Provider involved, if selection had completed.
	pub provider:   Option<Box<ProviderId>>,
	/// Route involved, if selection had completed.
	pub route:      Option<Box<RouteId>>,
	/// Logical request identity.
	pub request_id: Option<Box<RequestId>>,
	/// HTTP-like status when structurally available.
	pub status:     Option<u16>,
	/// Structured provider or runtime error code.
	pub code:       Option<Str>,
	/// Whether ordinary output had become visible.
	pub committed:  bool,
	evidence:       Box<ErrorEvidence>,
}

impl fmt::Debug for Error {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		let detail_kind = self.detail_ref().map(|detail| match detail {
			ErrorDetail::BodyVariantMismatch { .. } => "BodyVariantMismatch",
			ErrorDetail::NamedToolUnavailable { .. } => "NamedToolUnavailable",
			ErrorDetail::Budget { .. } => "Budget",
			ErrorDetail::Context { .. } => "Context",
			ErrorDetail::Target { .. } => "Target",
			ErrorDetail::Capability { .. } => "Capability",
			ErrorDetail::Replay { .. } => "Replay",
			ErrorDetail::Protocol { .. } => "Protocol",
			ErrorDetail::Timeout { .. } => "Timeout",
			ErrorDetail::StreamEnded { .. } => "StreamEnded",
			ErrorDetail::CassetteMiss { .. } => "CassetteMiss",
			ErrorDetail::Provider { .. } => "Provider",
			ErrorDetail::SearchFailures { .. } => "SearchFailures",
			ErrorDetail::LocalUnavailable { .. } => "LocalUnavailable",
			ErrorDetail::StalePlan { .. } => "StalePlan",
		});
		formatter
			.debug_struct("Error")
			.field("kind", &self.kind)
			.field("phase", &self.phase)
			.field("action", &self.action)
			.field("provider", &self.provider)
			.field("route", &self.route)
			.field("request_id", &self.request_id)
			.field("status", &self.status)
			.field("code", &self.code)
			.field("committed", &self.committed)
			.field("receipt", &"<accounting redacted>")
			.field("detail_kind", &detail_kind)
			.finish()
	}
}

impl Error {
	/// Constructs a structured error with no provider-specific evidence.
	pub fn new(
		kind: ErrorKind,
		phase: ErrorPhase,
		action: RetryAction,
		receipt: ExecutionReceipt,
	) -> Self {
		let action = if kind == ErrorKind::PayloadRejected {
			RetryAction::Never
		} else {
			action
		};
		Self {
			kind,
			phase,
			action,
			provider: None,
			route: None,
			request_id: None,
			status: None,
			code: None,
			committed: false,
			evidence: Box::new(ErrorEvidence {
				receipt,
				detail: None,
				media_source: None,
				projector_source: None,
				aws_registry_source: None,
			}),
		}
	}

	/// Borrows partial accounting through the failure point.
	pub fn receipt(&self) -> &ExecutionReceipt {
		&self.evidence.receipt
	}

	/// Mutably borrows partial accounting through the failure point.
	pub fn receipt_mut(&mut self) -> &mut ExecutionReceipt {
		&mut self.evidence.receipt
	}

	/// Replaces partial accounting through the failure point.
	pub fn replace_receipt(&mut self, receipt: ExecutionReceipt) {
		self.evidence.receipt = receipt;
	}

	/// Takes partial accounting, leaving an empty receipt.
	pub fn take_receipt(&mut self) -> ExecutionReceipt {
		mem::take(&mut self.evidence.receipt)
	}

	/// Borrows typed supplemental evidence.
	pub fn detail_ref(&self) -> Option<&ErrorDetail> {
		self.evidence.detail.as_ref()
	}

	/// Attaches the provider involved in the failed execution.
	pub fn provider(mut self, provider: ProviderId) -> Self {
		self.provider = Some(Box::new(provider));
		self
	}

	/// Attaches the route involved in the failed execution.
	pub fn route(mut self, route: RouteId) -> Self {
		self.route = Some(Box::new(route));
		self
	}

	/// Attaches the logical request identity.
	pub fn request_id(mut self, request_id: RequestId) -> Self {
		self.request_id = Some(Box::new(request_id));
		self
	}

	/// Attaches an HTTP-like status when available.
	pub const fn status(mut self, status: Option<u16>) -> Self {
		self.status = status;
		self
	}

	/// Attaches a structured provider or runtime error code.
	pub fn code(mut self, code: Str) -> Self {
		self.code = Some(code);
		self
	}

	/// Attaches an optional structured provider or runtime error code.
	pub fn optional_code(mut self, code: Option<Str>) -> Self {
		self.code = code;
		self
	}

	/// Marks whether ordinary output had become visible.
	pub const fn committed(mut self, committed: bool) -> Self {
		self.committed = committed;
		self
	}

	/// Refines status-only payload inference with later provider body text.
	pub fn refine_provider_rejection(&mut self, message: &str) {
		if let Some(kind) =
			classify_provider_rejection(self.status, Some(message), None, Some(self.kind))
		{
			self.kind = kind;
			if matches!(kind, ErrorKind::ContextOverflow | ErrorKind::PayloadRejected) {
				self.action = RetryAction::Never;
			}
		}
	}

	/// Attaches typed supplemental evidence.
	pub fn detail(mut self, detail: ErrorDetail) -> Self {
		self.evidence.detail = Some(detail);
		self
	}

	pub(crate) fn typed_source(mut self, source: MediaOperationError) -> Self {
		self.evidence.media_source = Some(source);
		self
	}

	/// Attaches the typed catalog discovery construction failure.
	pub(crate) fn projector_source(mut self, source: CatalogDiscoveryProjectorError) -> Self {
		self.evidence.projector_source = Some(source);
		self
	}

	/// Attaches the typed AWS registry availability failure.
	pub(crate) fn aws_registry_source(mut self, source: AwsCredentialError) -> Self {
		self.evidence.aws_registry_source = Some(source);
		self
	}

	/// Constructs a terminal planning error with typed evidence.
	pub fn planning(kind: ErrorKind, detail: ErrorDetail, receipt: ExecutionReceipt) -> Self {
		Self::new(kind, ErrorPhase::Planning, RetryAction::Never, receipt).detail(detail)
	}

	/// Constructs the internal protocol error returned for a typed answer
	/// mismatch.
	pub fn body_variant_mismatch(
		expected: OperationKind,
		actual: AnswerKind,
		receipt: ExecutionReceipt,
	) -> Self {
		Self::new(
			ErrorKind::ProviderContractMismatch,
			ErrorPhase::Internal,
			RetryAction::Never,
			receipt,
		)
		.detail(ErrorDetail::BodyVariantMismatch { expected, actual })
	}
}

impl Display for Error {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		write!(formatter, "inference {:?} error during {:?}", self.kind, self.phase)?;
		if let Some(code) = &self.code {
			write!(formatter, " ({code})")?;
		}
		if let Some(status) = self.status {
			write!(formatter, " [http {status}]")?;
		}
		if let Some(detail) = &self.evidence.detail {
			write!(formatter, ": {detail}")?;
		}
		Ok(())
	}
}

impl error::Error for Error {
	fn source(&self) -> Option<&(dyn error::Error + 'static)> {
		if let Some(source) = self.evidence.projector_source.as_ref() {
			return Some(source);
		}
		if let Some(source) = self.evidence.aws_registry_source.as_ref() {
			return Some(source);
		}
		self
			.evidence
			.media_source
			.as_ref()
			.map(|source| source as &(dyn error::Error + 'static))
	}
}

/// Classifies one failed search attempt without retaining provider body text.
pub fn search_provider_failure(error: &Error) -> SearchProviderFailure {
	let kind = match (error.status, error.kind) {
		(Some(401 | 403), _) | (_, ErrorKind::Authentication | ErrorKind::Authorization) => {
			SearchFailureKind::Authentication
		},
		(Some(402 | 429), _)
		| (_, ErrorKind::PaymentRequired | ErrorKind::QuotaExhausted | ErrorKind::RateLimited) => {
			SearchFailureKind::Quota
		},
		(Some(404), _) | (_, ErrorKind::TargetNotFound) => SearchFailureKind::ModelNotFound,
		(_, ErrorKind::DeadlineExceeded) => SearchFailureKind::Timeout,
		(
			_,
			ErrorKind::Dns
			| ErrorKind::Tls
			| ErrorKind::Connectivity
			| ErrorKind::Protocol
			| ErrorKind::StreamCorruption,
		) => SearchFailureKind::Transport,
		_ => SearchFailureKind::Provider,
	};
	SearchProviderFailure {
		provider: error
			.provider
			.as_deref()
			.cloned()
			.unwrap_or_else(|| ProviderId::from("unknown")),
		kind,
		status: error.status,
		code: error.code.clone(),
	}
}

/// Produces one typed aggregate error from an ordered provider fallback chain.
///
/// At most sixteen summaries are retained; the most recent receipt remains the
/// accounting authority and provider diagnostics never enter the aggregate.
pub fn aggregate_search_failures(mut failures: Vec<Error>) -> Error {
	const MAX_FAILURES: usize = 16;
	let retained = failures
		.iter()
		.rev()
		.take(MAX_FAILURES)
		.map(search_provider_failure)
		.collect::<Vec<_>>()
		.into_iter()
		.rev()
		.collect::<Vec<_>>();
	let Some(mut last) = failures.pop() else {
		return Error::new(
			ErrorKind::RouteUnavailable,
			ErrorPhase::Planning,
			RetryAction::Never,
			ExecutionReceipt::default(),
		)
		.detail(ErrorDetail::search_failures(retained));
	};
	last.action = RetryAction::Never;
	last.committed = false;
	last.detail(ErrorDetail::search_failures(retained))
}

#[cfg(test)]
mod tests {
	use std::{io, mem::size_of, time::Duration};

	use omp_core::sf;

	use super::{
		Error, ErrorDetail as SuperErrorDetail, ErrorKind, ErrorPhase, RetryAction,
		classify_provider_rejection,
	};
	use crate::receipt::ExecutionReceipt;

	#[test]
	fn structured_error_debug_contains_no_external_source_text() {
		let error = Error::new(
			ErrorKind::Authentication,
			ErrorPhase::Authentication,
			RetryAction::Never,
			ExecutionReceipt::default(),
		)
		.code(sf!("invalid_credential"));
		let debug = format!("{error:?}");
		assert!(debug.contains("invalid_credential"));
		assert!(!debug.contains("Authorization:"));
		assert!(!debug.contains("source"));
	}

	#[test]
	fn structured_errors_fit_the_inline_result_budget() {
		assert!(size_of::<Error>() <= 128);
	}

	#[test]
	fn display_names_status_and_sanitized_detail() {
		let error = Error::new(
			ErrorKind::InvalidRequest,
			ErrorPhase::Handshake,
			RetryAction::Never,
			ExecutionReceipt::default(),
		)
		.code(sf!("model_archived"))
		.status(Some(404))
		.detail(SuperErrorDetail::Provider { sanitized_message: sf!("model does not exist") });
		let rendered = error.to_string();
		assert!(rendered.contains("(model_archived)"));
		assert!(rendered.contains("[http 404]"));
		assert!(rendered.contains("model does not exist"));
	}

	#[test]
	fn provider_rejection_arbitrates_status_body_and_cause_evidence() {
		assert_eq!(
			classify_provider_rejection(Some(413), None, None, None),
			Some(ErrorKind::PayloadRejected),
		);
		assert_eq!(
			classify_provider_rejection(
				Some(413),
				Some("image count exceeds the limit of 20"),
				None,
				None,
			),
			Some(ErrorKind::PayloadRejected),
		);
		assert_eq!(
			classify_provider_rejection(
				Some(413),
				Some("maximum context length is 128000 tokens"),
				None,
				None,
			),
			Some(ErrorKind::ContextOverflow),
		);
		assert_eq!(
			classify_provider_rejection(
				Some(413),
				Some("Chat history exceeds the 800-message limit"),
				None,
				None,
			),
			Some(ErrorKind::ContextOverflow),
		);

		let nested = io::Error::other("maximum context length is 128000 tokens");
		let wrapper = io::Error::other(nested);
		assert_eq!(
			classify_provider_rejection(
				Some(413),
				Some("Provider returned error"),
				Some(&wrapper),
				None
			),
			Some(ErrorKind::ContextOverflow),
		);
	}

	#[test]
	fn late_body_refinement_clears_status_only_payload_inference() {
		let forced_retry = Error::new(
			ErrorKind::PayloadRejected,
			ErrorPhase::Handshake,
			RetryAction::SameRoute { after: Duration::ZERO },
			ExecutionReceipt::default(),
		);
		assert_eq!(forced_retry.action, RetryAction::Never);

		let mut error = Error::new(
			ErrorKind::PayloadRejected,
			ErrorPhase::Handshake,
			RetryAction::Never,
			ExecutionReceipt::default(),
		)
		.status(Some(413));
		error.refine_provider_rejection("maximum context length is 128000 tokens");
		assert_eq!(error.kind, ErrorKind::ContextOverflow);
		assert_eq!(error.action, RetryAction::Never);
	}
}
