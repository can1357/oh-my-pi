//! Allowlisted native-wire operation service with explicit replay and size
//! evidence.

use std::{
	future::Future,
	sync::Arc,
	task::{Context, Poll},
};

use omp_core::{Str, sf};
use tower::Service;

use crate::{
	answer::{Answer, AnswerBody, NativeResponse, NativeResponseBody},
	body::{AttemptBodyEvidence, RetryDecision},
	call::{
		Call, NativeMethod, NativePath, NativePayload, NativeRequest, NativeResponseFraming,
		OperationCall,
	},
	catalog::OperationKind,
	error::{Error, ErrorDetail, ErrorKind, ErrorPhase, RetryAction},
	operation::{OperationRequest, OperationResponse},
	receipt::{ExecutionReceipt, ReasonId},
};

/// Bitset of native methods admitted by one semantic path.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct NativeMethodBits(u8);

impl NativeMethodBits {
	/// DELETE requests.
	pub const DELETE: Self = Self(1 << 2);
	/// GET requests.
	pub const GET: Self = Self(1 << 0);
	/// POST requests.
	pub const POST: Self = Self(1 << 1);

	/// Combines method bits.
	pub const fn union(self, other: Self) -> Self {
		Self(self.0 | other.0)
	}

	/// Reports whether a method is allowlisted.
	pub const fn contains(self, method: NativeMethod) -> bool {
		let bit = match method {
			NativeMethod::Get => Self::GET.0,
			NativeMethod::Post => Self::POST.0,
			NativeMethod::Delete => Self::DELETE.0,
		};
		self.0 & bit != 0
	}
}

/// Bitset of admitted native response framings.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct NativeFramingBits(u8);

impl NativeFramingBits {
	/// One opaque binary response.
	pub const BYTES: Self = Self(1 << 2);
	/// One opaque JSON response.
	pub const JSON: Self = Self(1 << 0);
	/// Incremental SSE bytes.
	pub const SSE: Self = Self(1 << 1);

	/// Combines framing bits.
	pub const fn union(self, other: Self) -> Self {
		Self(self.0 | other.0)
	}

	/// Reports whether a response framing is allowlisted.
	pub const fn contains(self, framing: NativeResponseFraming) -> bool {
		let bit = match framing {
			NativeResponseFraming::Json => Self::JSON.0,
			NativeResponseFraming::Sse => Self::SSE.0,
			NativeResponseFraming::Bytes => Self::BYTES.0,
		};
		self.0 & bit != 0
	}
}

/// One route-owned native method/path/size rule.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct NativeRule {
	/// Closed semantic path.
	pub path:                   NativePath,
	/// Admitted methods.
	pub methods:                NativeMethodBits,
	/// Admitted response representations.
	pub response_framings:      NativeFramingBits,
	/// Whether this path accepts a request payload.
	pub request_body:           bool,
	/// Maximum encoded request body bytes enforced by encode/transport.
	pub maximum_request_bytes:  u64,
	/// Maximum response bytes enforced before exposure.
	pub maximum_response_bytes: u64,
}

/// Validated route-local native allowlist.
#[derive(Clone, Debug)]
pub struct NativePolicy {
	rules: Arc<[NativeRule]>,
}

impl NativePolicy {
	/// Validates an allowlist; duplicate paths and zero limits are rejected.
	pub fn new(rules: impl Into<Arc<[NativeRule]>>) -> Result<Self, Error> {
		let rules = rules.into();
		if rules.is_empty() {
			return Err(rejected("native_allowlist_is_empty"));
		}
		for (index, rule) in rules.iter().enumerate() {
			if rule.methods.0 == 0 || rule.response_framings.0 == 0 {
				return Err(rejected("native_rule_has_empty_method_or_framing_allowlist"));
			}
			if rule.maximum_request_bytes == 0 || rule.maximum_response_bytes == 0 {
				return Err(rejected("native_rule_has_zero_size_bound"));
			}
			if rules[..index]
				.iter()
				.any(|existing| existing.path == rule.path)
			{
				return Err(rejected("duplicate_native_path_rule"));
			}
		}
		Ok(Self { rules })
	}

	/// Returns the validated rule for a request or typed planning evidence.
	pub fn authorize(&self, request: &NativeRequest) -> Result<&NativeRule, Error> {
		let Some(rule) = self.rules.iter().find(|rule| rule.path == request.path) else {
			return Err(rejected("native_path_not_allowlisted"));
		};
		if !rule.methods.contains(request.method) {
			return Err(rejected("native_method_not_allowlisted_for_path"));
		}
		if request.payload.is_some() && !rule.request_body {
			return Err(rejected("native_body_not_allowed_for_path"));
		}
		if !rule.response_framings.contains(request.response_framing) {
			return Err(rejected("native_response_framing_not_allowlisted"));
		}
		if request.max_response_bytes == 0 || request.max_response_bytes > rule.maximum_response_bytes
		{
			return Err(rejected("native_response_size_exceeds_allowlist"));
		}
		if let Some(payload) = &request.payload {
			let encoded_len = payload_len(payload);
			if encoded_len.is_some_and(|length| length > rule.maximum_request_bytes) {
				return Err(rejected("native_request_size_exceeds_allowlist"));
			}
		}
		Ok(rule)
	}
}

/// Concrete native operation service over one auth/codec/transport route
/// backend.
#[derive(Clone, Debug)]
pub struct NativeService<S> {
	inner:  S,
	policy: NativePolicy,
}

impl<S> NativeService<S> {
	/// Constructs a native service from a validated route allowlist.
	pub const fn new(inner: S, policy: NativePolicy) -> Self {
		Self { inner, policy }
	}
}

impl<S> Service<Call> for NativeService<S>
where
	S: Service<
			OperationRequest<NativeRequest>,
			Response = OperationResponse<NativeResponse>,
			Error = Error,
		>,
	S::Future: Send + 'static,
{
	type Error = Error;
	type Response = Answer;

	type Future = impl Future<Output = Result<Answer, Error>> + Send;

	fn poll_ready(&mut self, context: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
		self.inner.poll_ready(context)
	}

	fn call(&mut self, call: Call) -> Self::Future {
		let authorized = match &call.operation {
			OperationCall::Native(request) => self
				.policy
				.authorize(request)
				.map(|rule| (Arc::clone(request), *rule)),
			_ => Err(wrong_operation(&call)),
		};
		let pending = authorized.as_ref().ok().map(|(request, _)| {
			self
				.inner
				.call(OperationRequest::from_call(&call, Arc::clone(request)))
		});
		async move {
			let (request, rule) = authorized?;
			let Some(pending) = pending else {
				return Err(protocol_error("native_backend_not_called"));
			};
			let response = pending.await?;
			validate_native_response(&request, rule, &response.output)?;
			Ok(response.into_answer(AnswerBody::Native))
		}
	}
}

/// Requires explicit body evidence before any native retry, rotation, or
/// fallback.
pub fn retry_allowed(error: &Error, body: AttemptBodyEvidence) -> bool {
	!error.committed
		&& error.kind != ErrorKind::Cancelled
		&& body.retry_decision == RetryDecision::Allow
		&& !matches!(error.action, RetryAction::Never)
}

/// Validates the exact encoded request size after a streaming body has been
/// staged or encoded.
pub fn validate_encoded_request_size(rule: NativeRule, encoded_bytes: u64) -> Result<(), Error> {
	if encoded_bytes > rule.maximum_request_bytes {
		Err(rejected("native_encoded_request_exceeds_allowlist"))
	} else {
		Ok(())
	}
}

pub(crate) fn validate_native_response(
	request: &NativeRequest,
	rule: NativeRule,
	response: &NativeResponse,
) -> Result<(), Error> {
	if !(100..=599).contains(&response.status) {
		return Err(protocol_error("native_response_status_out_of_range"));
	}
	let framing_matches = matches!(
		(request.response_framing, &response.body),
		(NativeResponseFraming::Json, NativeResponseBody::Json(_))
			| (NativeResponseFraming::Bytes, NativeResponseBody::Bytes(_))
			| (NativeResponseFraming::Sse, NativeResponseBody::Stream(_))
	);
	if !framing_matches {
		return Err(protocol_error("native_response_framing_mismatch"));
	}
	let length = match &response.body {
		NativeResponseBody::Json(value) => Some(value.as_bytes().len() as u64),
		NativeResponseBody::Bytes(bytes) => Some(bytes.len() as u64),
		NativeResponseBody::Stream(_) => None,
	};
	let limit = request.max_response_bytes.min(rule.maximum_response_bytes);
	if length.is_some_and(|length| length > limit) {
		return Err(protocol_error("native_response_exceeded_size_bound"));
	}
	Ok(())
}

fn payload_len(payload: &NativePayload) -> Option<u64> {
	match payload {
		NativePayload::Json(value) => Some(value.as_bytes().len() as u64),
		NativePayload::Bytes(bytes) => Some(bytes.len() as u64),
		NativePayload::Body(_) => None,
	}
}

fn wrong_operation(call: &Call) -> Error {
	Error::new(
		ErrorKind::InternalInvariant,
		ErrorPhase::Internal,
		RetryAction::Never,
		ExecutionReceipt::default(),
	)
	.detail(ErrorDetail::capability(
		Str::new(OperationKind::Native.to_string()),
		ReasonId(sf!("operation_service_mismatch")),
	))
	.request_id(call.id.clone())
}

fn rejected(reason: &'static str) -> Error {
	Error::planning(
		ErrorKind::NativeRequestRejected,
		ErrorDetail::capability(sf!("native"), ReasonId(Str::new(reason))),
		ExecutionReceipt::default(),
	)
}

fn protocol_error(reason: &'static str) -> Error {
	Error::new(
		ErrorKind::ProviderContractMismatch,
		ErrorPhase::Recovery,
		RetryAction::Never,
		ExecutionReceipt::default(),
	)
	.detail(ErrorDetail::protocol(ReasonId(Str::new(reason))))
}

#[cfg(test)]
mod tests {
	use std::sync::Arc;

	use super::{NativeFramingBits, NativeMethodBits, NativePolicy, NativeRule};
	use crate::{
		call::{NativeMethod, NativePath, NativeRequest, NativeResponseFraming},
		error::ErrorKind,
	};

	#[test]
	fn route_allowlist_rejects_method_and_response_bound_mismatches() {
		let policy = NativePolicy::new(Arc::<[NativeRule]>::from([NativeRule {
			path:                   NativePath::Embeddings,
			methods:                NativeMethodBits::POST,
			response_framings:      NativeFramingBits::JSON.union(NativeFramingBits::BYTES),
			request_body:           true,
			maximum_request_bytes:  1_024,
			maximum_response_bytes: 2_048,
		}]))
		.expect("valid policy");
		let request = NativeRequest {
			method:             NativeMethod::Post,
			path:               NativePath::Embeddings,
			payload:            None,
			response_framing:   NativeResponseFraming::Json,
			max_response_bytes: 1_024,
		};
		assert!(policy.authorize(&request).is_ok());
		let forbidden = NativeRequest { method: NativeMethod::Get, ..request.clone() };
		assert_eq!(
			policy
				.authorize(&forbidden)
				.expect_err("method must be rejected")
				.kind,
			ErrorKind::NativeRequestRejected,
		);
		let oversized = NativeRequest { max_response_bytes: 4_096, ..request };
		assert!(policy.authorize(&oversized).is_err());
	}
}
