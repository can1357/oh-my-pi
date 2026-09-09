//! Async Rust bindings for Apple's on-device Foundation Models runtime.
//!
//! The framework is loaded dynamically, so this crate builds on every platform
//! while generation remains available only on eligible Apple Silicon Macs with
//! Apple Intelligence enabled.
//!
//! # Example
//!
//! ```no_run
//! use omp_ai::local::applefm::AppleFm;
//!
//! # #[tokio::main]
//! # async fn main() -> Result<(), Box<dyn std::error::Error>> {
//! let model = AppleFm::load().await?;
//! let response = model
//! 	.complete("Summarize on-device inference in one sentence.")
//! 	.await?;
//! println!("{response}");
//! # Ok(())
//! # }
//! ```

use std::{
	collections::VecDeque,
	pin::Pin,
	result,
	sync::{Arc, LazyLock},
	task::{Context, Poll},
	time::Duration,
};

use bytes::{Bytes, BytesMut};
use futures::{Stream, StreamExt};
use omp_core::{IntoStr, Str, sf};
use tokio::{
	runtime,
	task::{self, JoinError},
	time,
};
use tokio_util::sync::CancellationToken;
use tower::Service;

use super::runtime::{AdmissionControl, AdmissionPermit};
use crate::{
	Error,
	body::BodySource,
	call::{ChatRequest, ContentPart, OperationCall, Role, Setting, ToolChoice},
	catalog::{
		DiscoveredModel, ModelAvailability, ModelLimits, OperationBits, OperationKind, ProviderId,
		RouteId, WireModelId,
	},
	codec::{
		Cancellation, Codec, DecodeContext, Decoder, DecoderState, EncodeContext, EncodedRequest,
		HandshakeMeta, HandshakenResponse, RawCompletion, RawEvent, RequestMethod, SizeBounds,
		TransportAttempt, TransportRequest,
	},
	error::{ErrorDetail, ErrorKind, ErrorPhase, RetryAction},
	event::{BlockKind, ChatEvent, FinishReason},
	receipt::{ExecutionReceipt, ReasonId, Usage, UsageSource},
	transport::{Frame, FramingProtocol},
};

#[cfg(target_os = "macos")]
mod abi;
#[cfg(target_os = "macos")]
mod platform;
#[cfg(not(target_os = "macos"))]
mod platform {
	use omp_core::Str;
	use tokio_util::sync::CancellationToken;

	use super::{
		AppleFmAvailability, AppleFmError, AppleFmErrorCode, AppleFmGeneration, AppleFmOptions,
		Result,
	};

	pub(super) fn availability() -> AppleFmAvailability {
		AppleFmAvailability { available: false, reason: Some(sf!("unsupported_operating_system")) }
	}

	pub(super) fn os_version() -> Option<Str> {
		None
	}

	pub(super) fn generate(
		_options: AppleFmOptions,
		_on_delta: impl FnMut(Str) -> bool,
		_cancel: &CancellationToken,
	) -> Result<AppleFmGeneration> {
		Err(AppleFmError::new(
			AppleFmErrorCode::ModelUnavailable,
			"Apple Foundation Models requires macOS",
		))
	}
}
/// Maximum wall-clock duration permitted for one Foundation Models task.
pub const FRAMEWORK_TIMEOUT: Duration = Duration::from_secs(30);
/// Apple's documented on-device context budget from TN3193.
pub(crate) const CONTEXT_SIZE: u32 = 4096;
static APPLE_ADMISSION: LazyLock<Arc<AdmissionControl>> =
	LazyLock::new(|| Arc::new(AdmissionControl::new(1).expect("one is a valid admission limit")));

#[allow(
	missing_docs,
	reason = "strum generates the public string-conversion method in this private module"
)]
mod error_code {
	use strum::{Display, EnumString, IntoStaticStr};

	/// Stable category attached to an [`super::AppleFmError`].
	#[derive(Clone, Copy, Debug, Display, EnumString, Eq, Hash, IntoStaticStr, PartialEq)]
	#[strum(serialize_all = "snake_case", const_into_str)]
	pub enum AppleFmErrorCode {
		/// The caller supplied an invalid request option.
		InvalidInput,
		/// The caller cancelled generation.
		Cancelled,
		/// Generation exceeded the runtime's request deadline.
		TimedOut,
		/// The device or system model cannot currently run the request.
		ModelUnavailable,
		/// This hardware is not eligible for Apple Intelligence.
		DeviceNotEligible,
		/// Apple Intelligence is disabled in System Settings.
		AppleIntelligenceNotEnabled,
		/// The on-device model has not finished downloading or preparing.
		ModelNotReady,
		/// The prompt exceeded the system model's context window.
		ContextOverflow,
		/// Apple's safety policy rejected the request.
		GuardrailBlocked,
		/// Guided generation is unsupported for this request.
		UnsupportedGuide,
		/// The current language or locale is unsupported.
		UnsupportedLocale,
		/// The framework could not decode a response.
		DecodingFailure,
		/// The system model rate-limited the request.
		RateLimited,
		/// Another process-local request is already active.
		ConcurrentRequests,
		/// The Foundation Models or Swift runtime failed unexpectedly.
		#[strum(serialize = "runtime_error", serialize = "runtime")]
		Runtime,
	}

	impl AppleFmErrorCode {
		/// Stable machine-readable string representation of this error code.
		pub const fn as_str(&self) -> &'static str {
			(*self).into_str()
		}
	}
}

#[doc(inline)]
pub use error_code::AppleFmErrorCode;

/// Error returned by Apple Foundation Models availability checks or generation.
#[derive(Clone, Debug, thiserror::Error)]
#[error("{message}")]
pub struct AppleFmError {
	code:    AppleFmErrorCode,
	message: Str,
}

impl AppleFmError {
	/// Stable machine-readable error category.
	pub const fn code(&self) -> AppleFmErrorCode {
		self.code
	}

	/// Native or platform diagnostic suitable for logs and user-facing errors.
	pub fn message(&self) -> &str {
		self.message.as_str()
	}

	fn new(code: AppleFmErrorCode, message: impl IntoStr) -> Self {
		Self { code, message: message.into_str() }
	}

	fn cancelled() -> Self {
		Self::new(AppleFmErrorCode::Cancelled, "Apple Foundation Models generation was cancelled")
	}

	fn timed_out(timeout: Duration) -> Self {
		Self::new(
			AppleFmErrorCode::TimedOut,
			format!("Apple Foundation Models generation exceeded {timeout:?}"),
		)
	}

	fn runtime(message: impl IntoStr) -> Self {
		Self::new(AppleFmErrorCode::Runtime, message)
	}
}

/// Result type used by Apple Foundation Models operations and streams.
pub type Result<T, E = AppleFmError> = result::Result<T, E>;

/// Current usability of Apple's on-device system language model.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AppleFmAvailability {
	/// Whether the system model can generate responses now.
	pub available: bool,
	/// Stable unavailability reason or native loading diagnostic.
	pub reason:    Option<Str>,
}
#[allow(
	missing_docs,
	reason = "strum generates the public string-conversion method in this private module"
)]
mod support_state {
	use strum::{Display, EnumString, IntoStaticStr};

	/// Stable reason why Apple Foundation Models can or cannot run.
	#[derive(Clone, Copy, Debug, Display, EnumString, Eq, IntoStaticStr, PartialEq)]
	#[strum(serialize_all = "snake_case", const_into_str)]
	pub enum AppleFmSupportState {
		/// Generation is available now.
		Available,
		/// The operating system is not macOS.
		UnsupportedOperatingSystem,
		/// The process is not running on Apple Silicon.
		UnsupportedArchitecture,
		/// The Foundation Models framework is absent from this OS release.
		FrameworkUnavailable,
		/// The device is not eligible for Apple Intelligence.
		DeviceNotEligible,
		/// Apple Intelligence is disabled in System Settings.
		#[strum(serialize = "apple_intelligence_not_enabled")]
		SettingsDisabled,
		/// The system model is downloading or preparing.
		ModelNotReady,
		/// The native runtime returned an unclassified failure.
		RuntimeFailure,
	}

	impl AppleFmSupportState {
		/// Returns the stable planning-evidence code for this availability state.
		pub const fn code(self) -> &'static str {
			self.into_str()
		}
	}
}

use std::{env::consts, mem};

#[doc(inline)]
pub use support_state::AppleFmSupportState;

use crate::id::RequestId;

/// Native feature status distinguished from an unrecovered binding.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AppleFmFeatureEvidence {
	/// The direct Swift ABI seam implements the feature.
	Native,
	/// Apple's `Tool` protocol requires a statically compiled Swift associated
	/// argument type and witness table, so arbitrary runtime tools cannot be
	/// represented by this pure-Rust dynamic integration.
	RequiresCompiledSwiftToolConformance,
	/// The framework may expose `DynamicGenerationSchema`, but its value-witness
	/// ABI has not been safely recovered from platform evidence.
	DynamicSchemaAbiUnverified,
}

/// Precise platform, model, settings, and capability evidence.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AppleFmAvailabilityEvidence {
	/// Classified availability state.
	pub state: AppleFmSupportState,
	/// OS version reported without invoking an external process.
	pub os_version: Option<Str>,
	/// Compile-time process architecture.
	pub architecture: &'static str,
	/// Native diagnostic or stable reason.
	pub detail: Option<Str>,
	/// Native incremental snapshot streaming is implemented.
	pub streaming: bool,
	/// Precise reason tools are or are not available.
	pub tool_evidence: AppleFmFeatureEvidence,
	/// Precise reason structured generation is or is not available.
	pub structured_generation_evidence: AppleFmFeatureEvidence,
	/// Documented system-model context budget.
	pub context_tokens: u32,
}

const _: () = assert!(
	std::mem::size_of::<AppleFmAvailabilityEvidence>() <= 128,
	"AppleFmAvailabilityEvidence must stay compact"
);

impl AppleFmAvailabilityEvidence {
	/// Whether the narrow ABI seam exposes native tools.
	pub const fn tools(&self) -> bool {
		matches!(self.tool_evidence, AppleFmFeatureEvidence::Native)
	}

	/// Whether the narrow ABI seam exposes native schema-guided generation.
	pub const fn structured_generation(&self) -> bool {
		matches!(self.structured_generation_evidence, AppleFmFeatureEvidence::Native)
	}
}

/// Controls one Apple Foundation Models request.
#[derive(Clone, Debug, PartialEq)]
pub struct AppleFmOptions {
	/// User prompt sent to the on-device model.
	pub prompt:        Str,
	/// Optional instructions applied to the model session.
	pub system_prompt: Option<Str>,
	/// Enables Apple's permissive content-transformations guardrail mode.
	pub permissive:    bool,
	/// Optional sampling temperature.
	pub temperature:   Option<f64>,
	/// Optional maximum number of response tokens.
	pub max_tokens:    Option<u32>,
}

impl AppleFmOptions {
	/// Creates a request with the framework's default guardrails and sampling.
	pub fn new(prompt: impl Into<Str>) -> Self {
		Self {
			prompt:        prompt.into(),
			system_prompt: None,
			permissive:    false,
			temperature:   None,
			max_tokens:    None,
		}
	}

	/// Applies instructions to the model session.
	pub fn system_prompt(mut self, prompt: impl Into<Str>) -> Self {
		self.system_prompt = Some(prompt.into());
		self
	}

	/// Selects Apple's permissive content-transformations guardrail mode.
	pub const fn permissive(mut self, permissive: bool) -> Self {
		self.permissive = permissive;
		self
	}

	/// Sets the sampling temperature.
	pub const fn temperature(mut self, temperature: f64) -> Self {
		self.temperature = Some(temperature);
		self
	}

	/// Limits the number of response tokens.
	pub const fn max_tokens(mut self, max_tokens: u32) -> Self {
		self.max_tokens = Some(max_tokens);
		self
	}
}

/// Completed response and byte-derived token estimates.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AppleFmGeneration {
	/// Complete generated response.
	pub content:                     Str,
	/// Approximate prompt token count because the framework exposes no
	/// tokenizer.
	pub prompt_tokens_estimated:     u32,
	/// Approximate completion token count because the framework exposes no
	/// tokenizer.
	pub completion_tokens_estimated: u32,
	/// Apple's documented on-device context budget from TN3193.
	pub context_size_documented:     u32,
}

/// Incremental event produced by [`AppleFmStream`].
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AppleFmEvent {
	/// Newly generated text not present in the prior snapshot.
	Delta(Str),
	/// Canonical completed response and usage estimates.
	Finished(AppleFmGeneration),
}

/// Handle to Apple's process-local on-device system language model.
#[derive(Clone, Copy, Debug, Default)]
pub struct AppleFm;

impl AppleFm {
	/// Loads the system framework and verifies that the model is ready.
	pub async fn load() -> Result<Self> {
		let availability = Self::availability().await?;
		if availability.available {
			return Ok(Self);
		}
		let reason = availability
			.reason
			.unwrap_or_else(|| sf!("model_unavailable"));
		Err(AppleFmError::new(availability_error_code(reason.as_str()), reason))
	}

	/// Checks whether Apple Foundation Models can generate on this machine.
	pub async fn availability() -> Result<AppleFmAvailability> {
		task::spawn_blocking(platform::availability)
			.await
			.map_err(join_error)
	}

	/// Returns typed platform, model, settings, and capability evidence.
	pub async fn availability_evidence() -> Result<AppleFmAvailabilityEvidence> {
		let availability = Self::availability().await?;
		let detail = availability.reason;
		let state = if availability.available {
			AppleFmSupportState::Available
		} else {
			classify_support(detail.as_ref().map(Str::as_str))
		};
		Ok(AppleFmAvailabilityEvidence {
			state,
			os_version: platform::os_version(),
			architecture: consts::ARCH,
			detail,
			streaming: true,
			tool_evidence: AppleFmFeatureEvidence::RequiresCompiledSwiftToolConformance,
			structured_generation_evidence: AppleFmFeatureEvidence::DynamicSchemaAbiUnverified,
			context_tokens: CONTEXT_SIZE,
		})
	}

	/// Generates one complete response, respecting cancellation and the
	/// 30-second deadline.
	pub async fn generate(
		&self,
		options: AppleFmOptions,
		cancel: CancellationToken,
	) -> Result<AppleFmGeneration> {
		let _permit = apple_admit()?;
		run_generation(options, cancel, FRAMEWORK_TIMEOUT, |_, _| true).await
	}

	/// Generates one complete response with the framework's default request
	/// settings.
	pub async fn complete(&self, prompt: impl Into<Str>) -> Result<Str> {
		self
			.generate(AppleFmOptions::new(prompt), CancellationToken::new())
			.await
			.map(|generation| generation.content)
	}

	/// Starts a cancellable stream of response deltas followed by one completed
	/// response.
	pub fn stream(&self, options: AppleFmOptions) -> Result<AppleFmStream> {
		validate_options(&options)?;
		let permit = apple_admit()?;
		Self::stream_with_permit(options, permit, FRAMEWORK_TIMEOUT)
	}

	fn stream_with_permit(
		options: AppleFmOptions,
		permit: AdmissionPermit,
		timeout: Duration,
	) -> Result<AppleFmStream> {
		let runtime = runtime::Handle::try_current().map_err(|_| {
			AppleFmError::runtime("Apple Foundation Models streaming requires an active Tokio runtime")
		})?;
		let cancel = CancellationToken::new();
		let task_cancel = cancel.clone();
		let (tx, rx) = flume::bounded(16);
		runtime.spawn(async move {
			let _permit = permit;
			let delta_tx = tx.clone();
			let result = run_generation(options, task_cancel, timeout, move |delta, work_cancel| {
				loop {
					if work_cancel.is_cancelled() {
						return false;
					}
					match delta_tx
						.send_timeout(Ok(AppleFmEvent::Delta(delta.clone())), Duration::from_millis(25))
					{
						Ok(()) => return true,
						Err(flume::SendTimeoutError::Timeout(_)) => {},
						Err(flume::SendTimeoutError::Disconnected(_)) => return false,
					}
				}
			})
			.await;
			match result {
				Ok(generation) => {
					let _ = tx.send_async(Ok(AppleFmEvent::Finished(generation))).await;
				},
				Err(error) if error.code() == AppleFmErrorCode::Cancelled && tx.is_disconnected() => {},
				Err(error) => {
					let _ = tx.send_async(Err(error)).await;
				},
			}
		});
		let stream = futures::stream::unfold(rx, |receiver| async move {
			let item = receiver.recv_async().await.ok()?;
			Some((item, receiver))
		});
		Ok(AppleFmStream { rx: Box::pin(stream), cancel })
	}
}

/// Asynchronous event stream returned by [`AppleFm::stream`].
pub struct AppleFmStream {
	rx:     Pin<Box<dyn Stream<Item = Result<AppleFmEvent>> + Send + 'static>>,
	cancel: CancellationToken,
}

impl AppleFmStream {
	/// Requests cancellation of the active Foundation Models task.
	pub fn cancel(&self) {
		self.cancel.cancel();
	}
}

impl Stream for AppleFmStream {
	type Item = Result<AppleFmEvent>;

	fn poll_next(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Option<Self::Item>> {
		self.rx.as_mut().poll_next(context)
	}
}

impl Drop for AppleFmStream {
	fn drop(&mut self) {
		self.cancel.cancel();
	}
}
/// Sans-I/O codec lowering canonical chat into the private local Apple request
/// shape.
#[derive(Clone, Copy, Debug, Default)]
pub struct AppleFmCodec;

#[derive(serde::Serialize, serde::Deserialize)]
struct AppleWireRequest {
	prompt:          Str,
	system_prompt:   Option<Str>,
	temperature:     Option<f64>,
	max_tokens:      Option<u32>,
	transcript_echo: bool,
}

impl Codec for AppleFmCodec {
	fn encode(
		&self,
		context: &EncodeContext<'_>,
		operation: &OperationCall,
	) -> result::Result<EncodedRequest, Error> {
		if let OperationCall::DiscoverModels(request) = operation {
			if request.cursor.is_some() {
				return Err(apple_codec_error(
					ErrorKind::InvalidRequest,
					"Apple Foundation Models discovery is a single page",
					context,
				));
			}
			if request.page_size == 0 {
				return Err(apple_codec_error(
					ErrorKind::InvalidRequest,
					"Apple Foundation Models discovery page size must be non-zero",
					context,
				));
			}
			if request
				.provider
				.as_ref()
				.is_some_and(|provider| provider != &context.route.provider)
				|| request
					.route
					.as_ref()
					.is_some_and(|route| route != &context.route.id)
			{
				return Err(apple_codec_error(
					ErrorKind::InvalidRequest,
					"Apple Foundation Models discovery scope does not match the route",
					context,
				));
			}
			return Ok(EncodedRequest::new(
				OperationKind::DiscoverModels,
				RequestMethod::Get,
				sf!("local://apple-intelligence/models"),
				Box::new([]),
				BodySource::Bytes(Bytes::new()),
				FramingProtocol::Raw,
				SizeBounds { request_body: 0, frame: 4096, response: 4096 },
			));
		}
		if context.target.is_none() {
			return Err(apple_codec_error(
				ErrorKind::TargetNotFound,
				"Apple Foundation Models requires a model target",
				context,
			));
		}
		let OperationCall::Chat(request) = operation else {
			return Err(apple_codec_error(
				ErrorKind::CapabilityMismatch,
				"Apple Foundation Models supports chat only",
				context,
			));
		};
		let (prompt, system_prompt, transcript_echo) =
			apple_prompt(request, context.request_id, &context.route.provider, &context.route.id)?;
		let max_tokens = request
			.max_output_tokens
			.map(u32::try_from)
			.transpose()
			.map_err(|_| {
				apple_codec_error(
					ErrorKind::InvalidRequest,
					"Apple Foundation Models output limit exceeds u32",
					context,
				)
			})?;
		let body = postcard::to_allocvec(&AppleWireRequest {
			prompt,
			system_prompt,
			temperature: request.sampling.temperature.map(f64::from),
			max_tokens,
			transcript_echo,
		})
		.map_err(|_| {
			apple_codec_error(
				ErrorKind::InternalInvariant,
				"Apple Foundation Models request encoding failed",
				context,
			)
		})?;
		let body_len = u64::try_from(body.len()).unwrap_or(u64::MAX);
		Ok(EncodedRequest::new(
			OperationKind::Chat,
			RequestMethod::Post,
			sf!("local://apple-intelligence"),
			Box::new([]),
			BodySource::Bytes(Bytes::from(body)),
			FramingProtocol::Raw,
			SizeBounds {
				request_body: body_len,
				frame:        64 * 1024,
				response:     4 * 1024 * 1024,
			},
		))
	}

	fn decoder(&self, context: &DecodeContext<'_>) -> result::Result<DecoderState, Error> {
		if !matches!(context.operation, OperationKind::Chat | OperationKind::DiscoverModels) {
			return Err(Error::new(
				ErrorKind::CapabilityMismatch,
				ErrorPhase::Planning,
				RetryAction::Never,
				ExecutionReceipt::default(),
			));
		}
		Ok(Box::new(AppleLocalDecoder))
	}
}

struct AppleLocalDecoder;

impl Decoder for AppleLocalDecoder {
	fn push(&mut self, _frame: Frame, _emit: &mut dyn FnMut(RawEvent)) -> result::Result<(), Error> {
		Err(Error::new(
			ErrorKind::InternalInvariant,
			ErrorPhase::Internal,
			RetryAction::Never,
			ExecutionReceipt::default(),
		))
	}

	fn finish(&mut self, _emit: &mut dyn FnMut(RawEvent)) -> result::Result<(), Error> {
		Ok(())
	}
}

/// Innermost route-local transport for Apple's in-process system model.
pub struct AppleFmTransport {
	ready: Option<AdmissionPermit>,
}

impl Clone for AppleFmTransport {
	fn clone(&self) -> Self {
		Self { ready: None }
	}
}

impl AppleFmTransport {
	/// Constructs the runtime-probed local transport on Apple platforms.
	///
	/// Model availability is intentionally checked per request so discovery can
	/// report a temporarily blocked system model and later observe it becoming
	/// available without rebuilding the registry.
	pub const fn new() -> result::Result<Self, AppleFmAvailabilityEvidence> {
		#[cfg(target_os = "macos")]
		{
			Ok(Self { ready: None })
		}
		#[cfg(not(target_os = "macos"))]
		{
			Err(availability_evidence_sync())
		}
	}

	/// Probes the native framework without constructing or advertising a route.
	pub fn probe() -> AppleFmAvailabilityEvidence {
		availability_evidence_sync()
	}
}

impl Service<TransportRequest> for AppleFmTransport {
	type Error = Error;
	type Response = HandshakenResponse;

	type Future = impl Future<Output = result::Result<HandshakenResponse, Error>> + Send;

	fn poll_ready(&mut self, _context: &mut Context<'_>) -> Poll<result::Result<(), Self::Error>> {
		if self.ready.is_none() {
			match APPLE_ADMISSION.try_acquire() {
				Ok(permit) => self.ready = Some(permit),
				Err(error) => {
					return Poll::Ready(Err(
						Error::new(
							ErrorKind::ResourceExhausted,
							ErrorPhase::Admission,
							RetryAction::Never,
							ExecutionReceipt::default(),
						)
						.code(error.message),
					));
				},
			}
		}
		Poll::Ready(Ok(()))
	}

	fn call(&mut self, request: TransportRequest) -> Self::Future {
		let permit = self.ready.take();
		async move {
			let permit = permit.ok_or_else(|| {
				Error::new(
					ErrorKind::ResourceExhausted,
					ErrorPhase::Readiness,
					RetryAction::Never,
					ExecutionReceipt::default(),
				)
			})?;
			execute_transport(request, permit).await
		}
	}
}

async fn execute_transport(
	request: TransportRequest,
	permit: AdmissionPermit,
) -> result::Result<HandshakenResponse, Error> {
	if request.credentials.is_some() {
		return Err(transport_error(
			ErrorKind::ProviderContractMismatch,
			ErrorPhase::Authentication,
			"local Apple Foundation Models route received credentials",
			&request,
			false,
		));
	}
	let mut body_attempt = request.encoded.body.begin_attempt();
	let evidence = body_attempt.evidence_handle();
	if request.decoder.is_none() || request.realtime.is_some() {
		return Err(transport_error(
			ErrorKind::ProviderContractMismatch,
			ErrorPhase::Encoding,
			"local Apple chat transport requires exactly one ordinary decoder",
			&request,
			false,
		));
	}
	let mut reader = body_attempt.open().await.map_err(|error| {
		transport_error(
			ErrorKind::InvalidRequest,
			ErrorPhase::Encoding,
			&format!("local Apple request body could not open: {error:?}"),
			&request,
			false,
		)
	})?;
	let mut body = BytesMut::new();
	while let Some(chunk) = reader.next().await {
		let chunk = chunk?;
		let next = body.len().saturating_add(chunk.len());
		if u64::try_from(next).unwrap_or(u64::MAX) > request.encoded.bounds.request_body {
			return Err(transport_error(
				ErrorKind::InvalidRequest,
				ErrorPhase::Encoding,
				"local Apple request body exceeded its encoded bound",
				&request,
				false,
			));
		}
		body.extend_from_slice(&chunk);
	}
	if request.encoded.operation == OperationKind::DiscoverModels {
		if !body.is_empty() {
			return Err(transport_error(
				ErrorKind::Protocol,
				ErrorPhase::Encoding,
				"local Apple discovery request body must be empty",
				&request,
				false,
			));
		}
		let availability = task::spawn_blocking(availability_evidence_sync)
			.await
			.map_err(|error| {
				transport_error(
					ErrorKind::LocalModelUnavailable,
					ErrorPhase::Discovery,
					&format!("Apple Foundation Models availability probe failed: {error}"),
					&request,
					false,
				)
			})?;
		let row =
			apple_discovered_model(&request.attempt.provider, &request.attempt.route, &availability);
		let events = futures::stream::once(async move {
			Ok(RawEvent::DiscoveredModels { rows: vec![row], next_cursor: None })
		});
		return Ok(HandshakenResponse {
			meta:     HandshakeMeta {
				status:              None,
				headers:             Box::new([]),
				provider_request_id: None,
			},
			body:     evidence,
			events:   Some(Box::pin(events)),
			control:  None,
			realtime: None,
		});
	}
	if request.encoded.operation != OperationKind::Chat {
		return Err(transport_error(
			ErrorKind::CapabilityMismatch,
			ErrorPhase::Encoding,
			"local Apple transport received an unsupported operation",
			&request,
			false,
		));
	}
	let wire: AppleWireRequest = postcard::from_bytes(&body).map_err(|_| {
		transport_error(
			ErrorKind::Protocol,
			ErrorPhase::Encoding,
			"local Apple request body was not the private typed shape",
			&request,
			false,
		)
	})?;
	if request.cancel.is_cancelled() {
		return Err(transport_error(
			ErrorKind::Cancelled,
			ErrorPhase::Handshake,
			"local Apple request was cancelled before generation",
			&request,
			false,
		));
	}
	let mut options = AppleFmOptions::new(wire.prompt);
	options.system_prompt = wire.system_prompt;
	options.temperature = wire.temperature;
	options.max_tokens = wire.max_tokens;
	let mut native =
		AppleFm::stream_with_permit(options, permit, request.attempt.timeout.min(FRAMEWORK_TIMEOUT))
			.map_err(|error| native_transport_error(&request, &error, false))?;
	let mut cleaner = AppleFmResponseCleaner::new(wire.transcript_echo);
	let first = next_native(&mut native, &request.cancel).await;
	let first = match first {
		NativePoll::Event(event) => event,
		NativePoll::Cancelled => {
			native.cancel();
			reap_stream(&mut native).await;
			return Err(transport_error(
				ErrorKind::Cancelled,
				ErrorPhase::Handshake,
				"local Apple request was cancelled before its first event",
				&request,
				false,
			));
		},
	};
	let mut queued = VecDeque::new();
	let mut block_started = false;
	let terminal = append_native(&request, first, &mut block_started, &mut cleaner, &mut queued)?;
	let attempt = request.attempt.clone();
	let cancel = request.cancel.clone();
	let stream = async_stream::try_stream! {
		while let Some(event) = queued.pop_front() {
			yield event;
		}
		if !terminal {
			loop {
				match next_native(&mut native, &cancel).await {
					NativePoll::Cancelled => {
						native.cancel();
						reap_stream(&mut native).await;
						let error = transport_attempt_error(
							ErrorKind::Cancelled,
							ErrorPhase::Streaming,
							"local Apple request was cancelled",
							&attempt,
							block_started,
						)
						.committed(block_started);
						Err(error)?;
					},
					NativePoll::Event(event) => {
						let mut output = VecDeque::new();
						let done = append_native_attempt(
							&attempt,
							event,
							&mut block_started,
							&mut cleaner,
							&mut output,
						)?;
						while let Some(event) = output.pop_front() {
							yield event;
						}
						if done {
							break;
						}
					},
				}
			}
		}
	};
	Ok(HandshakenResponse {
		meta:     HandshakeMeta {
			status:              None,
			headers:             Box::new([]),
			provider_request_id: None,
		},
		body:     evidence,
		events:   Some(Box::pin(stream)),
		control:  None,
		realtime: None,
	})
}

enum NativePoll {
	Event(Result<AppleFmEvent>),
	Cancelled,
}

async fn next_native(stream: &mut AppleFmStream, cancel: &Cancellation) -> NativePoll {
	tokio::select! {
		event = stream.next() => NativePoll::Event(event.unwrap_or_else(|| {
			Err(AppleFmError::new(
				AppleFmErrorCode::DecodingFailure,
				"Apple Foundation Models stream ended before completion",
			))
		})),
		() = futures::future::poll_fn(|context| cancel.poll_cancelled(context)) => {
			NativePoll::Cancelled
		},
	}
}

async fn reap_stream(stream: &mut AppleFmStream) {
	while stream.next().await.is_some() {}
}
const ASSISTANT_LABEL: &str = "Assistant:";
const USER_BOUNDARIES: [&str; 2] = ["\nUser:", "\n\nUser:"];
// Transcript labels are a private multi-turn prompt dialect. Repair their echo
// only for requests that used that dialect so ordinary single-turn output stays
// byte-for-byte unchanged.

#[derive(Debug)]
struct AppleFmResponseCleaner {
	enabled:   bool,
	leading:   bool,
	saw_delta: bool,
	truncated: bool,
	pending:   String,
}

impl AppleFmResponseCleaner {
	const fn new(enabled: bool) -> Self {
		Self { enabled, leading: enabled, saw_delta: false, truncated: false, pending: String::new() }
	}

	fn push(&mut self, delta: Str) -> (Option<Str>, bool) {
		if !delta.is_empty() {
			self.saw_delta = true;
		}
		if self.truncated {
			return (None, true);
		}
		if !self.enabled {
			return ((!delta.is_empty()).then_some(delta), false);
		}
		self.pending.push_str(delta.as_str());
		if self.leading && !self.resolve_leading_labels() {
			return (None, false);
		}
		self.take_body_delta()
	}

	fn finish(&mut self, completed: Str) -> Option<Str> {
		if self.truncated {
			return None;
		}
		if !self.enabled {
			return (!self.saw_delta && !completed.is_empty()).then_some(completed);
		}
		if !self.saw_delta {
			self.pending.push_str(completed.as_str());
		}
		if self.leading {
			self.resolve_leading_labels();
			self.leading = false;
		}
		self.take_body_delta().0
	}

	fn resolve_leading_labels(&mut self) -> bool {
		let mut consumed = 0;
		loop {
			let remaining = &self.pending[consumed..];
			if remaining.starts_with(ASSISTANT_LABEL) {
				consumed += ASSISTANT_LABEL.len();
				while let Some(character) = self.pending[consumed..].chars().next() {
					if !character.is_whitespace() {
						break;
					}
					consumed += character.len_utf8();
				}
				continue;
			}
			if ASSISTANT_LABEL.starts_with(remaining) {
				self.pending.drain(..consumed);
				return false;
			}
			self.pending.drain(..consumed);
			self.leading = false;
			return true;
		}
	}

	fn take_body_delta(&mut self) -> (Option<Str>, bool) {
		if let Some(boundary) = first_user_boundary(&self.pending) {
			let tail = self.pending.split_off(boundary);
			let text = mem::replace(&mut self.pending, tail);
			self.pending.clear();
			self.truncated = true;
			return ((!text.is_empty()).then(|| text.into()), true);
		}
		let held = boundary_prefix_len(self.pending.as_bytes());
		let emit_len = self.pending.len() - held;
		if emit_len == 0 {
			return (None, false);
		}
		let tail = self.pending.split_off(emit_len);
		let text = mem::replace(&mut self.pending, tail);
		(Some(text.into()), false)
	}
}

fn first_user_boundary(text: &str) -> Option<usize> {
	USER_BOUNDARIES
		.iter()
		.filter_map(|boundary| text.find(boundary))
		.min()
}

fn boundary_prefix_len(text: &[u8]) -> usize {
	let max = USER_BOUNDARIES
		.iter()
		.map(|boundary| boundary.len())
		.max()
		.unwrap_or(0)
		.min(text.len());
	(1..=max)
		.rev()
		.find(|&length| {
			let suffix = &text[text.len() - length..];
			USER_BOUNDARIES
				.iter()
				.any(|boundary| boundary.as_bytes().starts_with(suffix))
		})
		.unwrap_or(0)
}

fn append_native(
	request: &TransportRequest,
	event: Result<AppleFmEvent>,
	block_started: &mut bool,
	cleaner: &mut AppleFmResponseCleaner,
	output: &mut VecDeque<RawEvent>,
) -> result::Result<bool, Error> {
	append_native_attempt(&request.attempt, event, block_started, cleaner, output)
}

fn append_native_attempt(
	attempt: &TransportAttempt,
	event: Result<AppleFmEvent>,
	block_started: &mut bool,
	cleaner: &mut AppleFmResponseCleaner,
	output: &mut VecDeque<RawEvent>,
) -> result::Result<bool, Error> {
	match event {
		Ok(AppleFmEvent::Delta(text)) => {
			let (text, truncated) = cleaner.push(text);
			append_clean_text(block_started, output, text);
			if truncated {
				ensure_clean_text_block(block_started, output);
				append_clean_completion(output, Usage::default());
			}
			Ok(truncated)
		},
		Ok(AppleFmEvent::Finished(generation)) => {
			let text = cleaner.finish(generation.content);
			append_clean_text(block_started, output, text);
			ensure_clean_text_block(block_started, output);
			append_clean_completion(output, Usage {
				input_tokens: u64::from(generation.prompt_tokens_estimated),
				output_tokens: u64::from(generation.completion_tokens_estimated),
				source: UsageSource::Estimated,
				..Usage::default()
			});
			Ok(true)
		},
		Err(error) => {
			let mapped =
				native_attempt_error(attempt, &error, *block_started).committed(*block_started);
			Err(mapped)
		},
	}
}

fn append_clean_text(block_started: &mut bool, output: &mut VecDeque<RawEvent>, text: Option<Str>) {
	let Some(text) = text.filter(|text| !text.is_empty()) else {
		return;
	};
	ensure_clean_text_block(block_started, output);
	output.push_back(RawEvent::Chat(ChatEvent::TextDelta { index: 0, text }));
}
fn ensure_clean_text_block(block_started: &mut bool, output: &mut VecDeque<RawEvent>) {
	if !*block_started {
		output
			.push_back(RawEvent::Chat(ChatEvent::BlockStarted { index: 0, kind: BlockKind::Text }));
		*block_started = true;
	}
}

fn append_clean_completion(output: &mut VecDeque<RawEvent>, usage: Usage) {
	output.push_back(RawEvent::Completion(RawCompletion {
		reason: FinishReason::Stop,
		blocks: 1,
		usage,
	}));
}

fn apple_discovered_model(
	provider: &ProviderId<str>,
	route: &RouteId<str>,
	evidence: &AppleFmAvailabilityEvidence,
) -> DiscoveredModel {
	let mut operations = OperationBits::empty();
	operations.insert_kind(OperationKind::Chat);
	DiscoveredModel {
		provider:              provider.to_owned(),
		route:                 route.to_owned(),
		wire_model:            WireModelId::new("apple-intelligence"),
		aliases:               Box::new([]),
		display_name:          Some(sf!("Apple Intelligence (on-device)")),
		declared_class:        None,
		declared_operations:   operations,
		declared_capabilities: None,
		declared_limits:       Some(ModelLimits {
			context_window:        Some(u64::from(evidence.context_tokens)),
			maximum_input_tokens:  None,
			maximum_output_tokens: None,
			maximum_batch:         Some(1),
		}),
		declared_pricing:      Box::new([]),
		extended_context_mode: None,
		availability:          Some(if evidence.state == AppleFmSupportState::Available {
			ModelAvailability::Available
		} else {
			ModelAvailability::Blocked
		}),
		source:                sf!("apple-foundation-models-runtime"),
		observed_at_ms:        None,
		updated_at_ms:         None,
		deprecated:            Some(false),
	}
}

fn apple_prompt(
	request: &ChatRequest,
	request_id: &RequestId<str>,
	provider: &ProviderId<str>,
	route: &RouteId<str>,
) -> result::Result<(Str, Option<Str>, bool), Error> {
	if !request.tools.is_empty()
		|| !request.hosted_tools.is_empty()
		|| !matches!(
			&request.tool_choice,
			Setting::Unset
				| Setting::Require(ToolChoice::Disabled)
				| Setting::Prefer(ToolChoice::Disabled)
		) || !matches!(&request.output, Setting::Unset)
		|| !matches!(&request.reasoning, Setting::Unset)
		|| !matches!(&request.verbosity, Setting::Unset)
		|| !matches!(&request.cache_retention, Setting::Unset)
		|| !matches!(&request.service_tier, Setting::Unset)
		|| request.sampling.top_p.is_some()
		|| request.sampling.top_k.is_some()
		|| request.sampling.seed.is_some()
		|| !request.sampling.stop.is_empty()
		|| request.sampling.presence_penalty.is_some()
		|| request.sampling.frequency_penalty.is_some()
		|| request.top_logprobs.is_some()
		|| !request.safety.is_empty()
	{
		return Err(codec_route_error(
			ErrorKind::CapabilityMismatch,
			"Apple Foundation Models request contains a feature not exposed by the native seam",
			request_id,
			provider,
			route,
		));
	}
	let mut instructions = String::new();
	// The dynamic binding opens a fresh framework session per request, so the
	// thread is rendered into one prompt: instructions from system/developer
	// messages, conversation turns labeled `User:`/`Assistant:`. A lone user
	// message stays unlabeled to keep the single-turn wire shape unchanged.
	let mut turns: Vec<(Role, String)> = Vec::new();
	for message in request.messages.iter() {
		if message.name.is_some() {
			return Err(codec_route_error(
				ErrorKind::CapabilityMismatch,
				"Apple Foundation Models does not expose named message authors",
				request_id,
				provider,
				route,
			));
		}
		let destination = match message.role {
			Role::System | Role::Developer => {
				if !instructions.is_empty() {
					instructions.push_str("\n\n");
				}
				&mut instructions
			},
			Role::User | Role::Assistant => {
				if turns.last().is_none_or(|(role, _)| *role != message.role) {
					turns.push((message.role, String::new()));
				}
				&mut turns.last_mut().expect("turn pushed above").1
			},
			Role::Tool => {
				return Err(codec_route_error(
					ErrorKind::CapabilityMismatch,
					"Apple Foundation Models does not accept tool result messages",
					request_id,
					provider,
					route,
				));
			},
		};
		for part in message.content.iter() {
			match part {
				ContentPart::Text { text, proof: None } => destination.push_str(text.as_str()),
				ContentPart::Text { proof: Some(_), .. } => {
					return Err(codec_route_error(
						ErrorKind::CapabilityMismatch,
						"Apple Foundation Models cannot consume another codec's text proof",
						request_id,
						provider,
						route,
					));
				},
				_ => {
					return Err(codec_route_error(
						ErrorKind::CapabilityMismatch,
						"Apple Foundation Models accepts text content only",
						request_id,
						provider,
						route,
					));
				},
			}
		}
	}
	if !turns
		.last()
		.is_some_and(|(role, text)| *role == Role::User && !text.trim().is_empty())
	{
		return Err(codec_route_error(
			ErrorKind::InvalidRequest,
			"Apple Foundation Models requires non-empty trailing user text",
			request_id,
			provider,
			route,
		));
	}
	let transcript_echo = !matches!(turns.as_slice(), [(Role::User, _)]);
	let prompt = if let [(Role::User, only)] = turns.as_mut_slice() {
		mem::take(only)
	} else {
		let mut transcript = String::new();
		for (role, text) in &turns {
			if text.trim().is_empty() {
				continue;
			}
			if !transcript.is_empty() {
				transcript.push_str("\n\n");
			}
			transcript.push_str(if *role == Role::User {
				"User: "
			} else {
				"Assistant: "
			});
			transcript.push_str(text);
		}
		transcript
	};
	Ok((prompt.into(), (!instructions.is_empty()).then(|| instructions.into()), transcript_echo))
}

fn availability_evidence_sync() -> AppleFmAvailabilityEvidence {
	let availability = platform::availability();
	let detail = availability.reason;
	let state = if availability.available {
		AppleFmSupportState::Available
	} else {
		classify_support(detail.as_ref().map(Str::as_str))
	};
	AppleFmAvailabilityEvidence {
		state,
		os_version: platform::os_version(),
		architecture: consts::ARCH,
		detail,
		streaming: true,
		tool_evidence: AppleFmFeatureEvidence::RequiresCompiledSwiftToolConformance,
		structured_generation_evidence: AppleFmFeatureEvidence::DynamicSchemaAbiUnverified,
		context_tokens: CONTEXT_SIZE,
	}
}

fn apple_admit() -> Result<AdmissionPermit> {
	APPLE_ADMISSION.try_acquire().map_err(|_| {
		AppleFmError::new(
			AppleFmErrorCode::ConcurrentRequests,
			"another process-local Apple Foundation Models request is active",
		)
	})
}

fn apple_codec_error(kind: ErrorKind, message: &str, context: &EncodeContext<'_>) -> Error {
	codec_route_error(kind, message, context.request_id, &context.route.provider, &context.route.id)
}

fn codec_route_error(
	kind: ErrorKind,
	message: &str,
	request_id: &RequestId<str>,
	provider: &ProviderId<str>,
	route: &RouteId<str>,
) -> Error {
	Error::new(kind, ErrorPhase::Encoding, RetryAction::Never, ExecutionReceipt::default())
		.provider(provider.to_owned())
		.route(route.to_owned())
		.request_id(request_id.to_owned())
		.detail(ErrorDetail::capability(sf!("apple-foundation-models"), ReasonId::new(message)))
}

fn transport_error(
	kind: ErrorKind,
	phase: ErrorPhase,
	message: &str,
	request: &TransportRequest,
	committed: bool,
) -> Error {
	transport_attempt_error(kind, phase, message, &request.attempt, committed)
}

fn transport_attempt_error(
	kind: ErrorKind,
	phase: ErrorPhase,
	message: &str,
	attempt: &TransportAttempt,
	committed: bool,
) -> Error {
	Error::new(kind, phase, RetryAction::Never, ExecutionReceipt::default())
		.provider(attempt.provider.clone())
		.route(attempt.route.clone())
		.request_id(attempt.request_id.clone())
		.committed(committed)
		.detail(ErrorDetail::provider(Str::new(message)))
}

fn native_transport_error(
	request: &TransportRequest,
	error: &AppleFmError,
	committed: bool,
) -> Error {
	native_attempt_error(&request.attempt, error, committed)
}

fn native_attempt_error(
	attempt: &TransportAttempt,
	error: &AppleFmError,
	committed: bool,
) -> Error {
	let (kind, phase) = apple_native_error(error.code(), committed);
	transport_attempt_error(kind, phase, error.message(), attempt, committed)
		.code(sf!(error.code().as_str()))
}

const fn apple_native_error(code: AppleFmErrorCode, committed: bool) -> (ErrorKind, ErrorPhase) {
	let phase = if committed {
		ErrorPhase::Streaming
	} else {
		ErrorPhase::LocalRuntime
	};
	let kind = match code {
		AppleFmErrorCode::InvalidInput => ErrorKind::InvalidRequest,
		AppleFmErrorCode::Cancelled => ErrorKind::Cancelled,
		AppleFmErrorCode::TimedOut => ErrorKind::DeadlineExceeded,
		AppleFmErrorCode::ContextOverflow => ErrorKind::ContextOverflow,
		AppleFmErrorCode::GuardrailBlocked => ErrorKind::SafetyRefusal,
		AppleFmErrorCode::UnsupportedGuide | AppleFmErrorCode::UnsupportedLocale => {
			ErrorKind::CapabilityMismatch
		},
		AppleFmErrorCode::DecodingFailure => ErrorKind::MalformedModelOutput,
		AppleFmErrorCode::RateLimited => ErrorKind::RateLimited,
		AppleFmErrorCode::ConcurrentRequests => ErrorKind::ResourceExhausted,
		AppleFmErrorCode::ModelUnavailable
		| AppleFmErrorCode::DeviceNotEligible
		| AppleFmErrorCode::AppleIntelligenceNotEnabled
		| AppleFmErrorCode::ModelNotReady
		| AppleFmErrorCode::Runtime => ErrorKind::LocalModelUnavailable,
	};
	(kind, phase)
}

async fn run_generation(
	options: AppleFmOptions,
	cancel: CancellationToken,
	timeout: Duration,
	mut on_delta: impl FnMut(Str, &CancellationToken) -> bool + Send + 'static,
) -> Result<AppleFmGeneration> {
	validate_options(&options)?;
	if cancel.is_cancelled() {
		return Err(AppleFmError::cancelled());
	}
	let work_cancel = cancel.child_token();
	let blocking_cancel = work_cancel.clone();
	let mut task = task::spawn_blocking(move || {
		let callback_cancel = blocking_cancel.clone();
		platform::generate(options, move |delta| on_delta(delta, &callback_cancel), &blocking_cancel)
	});
	let outcome = tokio::select! {
		biased;
		result = &mut task => return result.map_err(join_error)?,
		() = cancel.cancelled() => AppleFmError::cancelled(),
		() = time::sleep(timeout) => AppleFmError::timed_out(timeout),
	};
	work_cancel.cancel();
	let _ = task.await;
	Err(outcome)
}

fn validate_options(options: &AppleFmOptions) -> Result<()> {
	if options.prompt.trim().is_empty() {
		return Err(AppleFmError::new(
			AppleFmErrorCode::InvalidInput,
			"Apple Foundation Models requires a non-empty prompt",
		));
	}
	if options
		.temperature
		.is_some_and(|value| !value.is_finite() || value < 0.0)
	{
		return Err(AppleFmError::new(
			AppleFmErrorCode::InvalidInput,
			"temperature must be finite and non-negative",
		));
	}
	if options.max_tokens == Some(0) {
		return Err(AppleFmError::new(
			AppleFmErrorCode::InvalidInput,
			"maximum response tokens must be non-zero",
		));
	}
	Ok(())
}

fn availability_error_code(reason: &str) -> AppleFmErrorCode {
	match reason {
		"device_not_eligible" => AppleFmErrorCode::DeviceNotEligible,
		"apple_intelligence_not_enabled" => AppleFmErrorCode::AppleIntelligenceNotEnabled,
		"model_not_ready" => AppleFmErrorCode::ModelNotReady,
		"model_unavailable"
		| "macOS Apple Silicon only"
		| "unsupported_architecture"
		| "unsupported_operating_system" => AppleFmErrorCode::ModelUnavailable,
		_ => AppleFmErrorCode::Runtime,
	}
}

fn classify_support(reason: Option<&str>) -> AppleFmSupportState {
	let Some(reason) = reason else {
		return AppleFmSupportState::RuntimeFailure;
	};
	match reason {
		"unsupported_operating_system" => AppleFmSupportState::UnsupportedOperatingSystem,
		"unsupported_architecture" | "macOS Apple Silicon only" => {
			AppleFmSupportState::UnsupportedArchitecture
		},
		"device_not_eligible" => AppleFmSupportState::DeviceNotEligible,
		"apple_intelligence_not_enabled" => AppleFmSupportState::SettingsDisabled,
		"model_not_ready" => AppleFmSupportState::ModelNotReady,
		message
			if message.contains("Could not load FoundationModels")
				|| message.contains("Foundation Models symbol") =>
		{
			AppleFmSupportState::FrameworkUnavailable
		},
		_ => AppleFmSupportState::RuntimeFailure,
	}
}

fn join_error(error: JoinError) -> AppleFmError {
	AppleFmError::runtime(format!("Apple Foundation Models worker failed: {error}"))
}

#[cfg(test)]
mod tests {
	use std::{collections::VecDeque, time::Duration};

	use omp_catalog::{ModelAvailability, OperationKind, ProviderId, RouteId};
	use omp_core::Str;
	use tokio_util::sync::CancellationToken;

	use super::{
		AppleFm, AppleFmAvailabilityEvidence, AppleFmError, AppleFmErrorCode, AppleFmEvent,
		AppleFmFeatureEvidence, AppleFmGeneration, AppleFmOptions, AppleFmResponseCleaner,
		AppleFmStream, AppleFmSupportState, append_native_attempt, apple_discovered_model,
		apple_prompt, native_attempt_error, validate_options,
	};
	use crate::{
		call::{
			ChatRequest, ContentPart, Message, NegotiationPolicy, OpaqueJson, Role, Sampling, Setting,
			ToolDefinition, ToolInputConstraint,
		},
		codec::{RawEvent, TransportAttempt},
		error::ErrorKind,
		event::ChatEvent,
		id::RequestId,
	};

	fn chat_request(messages: &[(Role, &str)]) -> ChatRequest {
		ChatRequest {
			messages:          messages
				.iter()
				.map(|(role, text)| Message {
					role:    *role,
					content: [ContentPart::Text { text: (*text).into(), proof: None }].into(),
					name:    None,
				})
				.collect(),
			tools:             [].into(),
			hosted_tools:      [].into(),
			tool_choice:       Setting::Unset,
			output:            Setting::Unset,
			reasoning:         Setting::Unset,
			verbosity:         Setting::Unset,
			cache_retention:   Setting::Unset,
			service_tier:      Setting::Unset,
			sampling:          Sampling::default(),
			max_output_tokens: None,
			top_logprobs:      None,
			safety:            [].into(),
			negotiation:       NegotiationPolicy::default(),
			forced_call:       None,
		}
	}

	fn prompt_of(messages: &[(Role, &str)]) -> Result<(Str, Option<Str>, bool), ErrorKind> {
		let attempt = attempt();
		apple_prompt(&chat_request(messages), &attempt.request_id, &attempt.provider, &attempt.route)
			.map_err(|error| error.kind)
	}

	#[test]
	fn lone_user_message_stays_unlabeled_and_instructions_split_out() {
		let (prompt, instructions, transcript_echo) =
			prompt_of(&[(Role::System, "be terse"), (Role::User, "hello")]).unwrap();
		assert_eq!(prompt.as_str(), "hello");
		assert_eq!(instructions.as_deref(), Some("be terse"));
		assert!(!transcript_echo);
	}

	#[test]
	fn history_is_flattened_into_labeled_transcript() {
		let (prompt, instructions, transcript_echo) = prompt_of(&[
			(Role::System, "be terse"),
			(Role::User, "one"),
			(Role::Assistant, "two"),
			(Role::User, "three"),
		])
		.unwrap();
		assert_eq!(prompt.as_str(), "User: one\n\nAssistant: two\n\nUser: three");
		assert_eq!(instructions.as_deref(), Some("be terse"));
		assert!(transcript_echo);
	}

	#[test]
	fn trailing_assistant_or_empty_user_is_invalid() {
		assert_eq!(
			prompt_of(&[(Role::User, "one"), (Role::Assistant, "two")]).unwrap_err(),
			ErrorKind::InvalidRequest,
		);
		assert_eq!(prompt_of(&[(Role::User, "  ")]).unwrap_err(), ErrorKind::InvalidRequest);
	}

	#[test]
	fn tool_declarations_and_tool_results_stay_rejected() {
		let attempt = attempt();
		let mut request = chat_request(&[(Role::User, "hello")]);
		request.tools = [ToolDefinition {
			name:        omp_core::sf!("read"),
			description: None,
			input:       ToolInputConstraint::JsonSchema {
				parameters: OpaqueJson::new(serde_json::json!({"type": "object"})),
				strict:     false,
			},
		}]
		.into();
		let declared = apple_prompt(&request, &attempt.request_id, &attempt.provider, &attempt.route)
			.unwrap_err();
		assert_eq!(declared.kind, ErrorKind::CapabilityMismatch);

		assert_eq!(
			prompt_of(&[(Role::Tool, "result"), (Role::User, "next")]).unwrap_err(),
			ErrorKind::CapabilityMismatch,
		);
	}

	#[test]
	fn request_validation_rejects_empty_or_invalid_limits() {
		let empty = AppleFmOptions::new("  ");
		assert!(validate_options(&empty).is_err());

		let invalid_temperature = AppleFmOptions::new("hello").temperature(f64::NAN);
		assert!(validate_options(&invalid_temperature).is_err());

		let no_tokens = AppleFmOptions::new("hello").max_tokens(0);
		assert!(validate_options(&no_tokens).is_err());
	}

	#[test]
	fn error_codes_have_stable_wire_names() {
		assert_eq!(AppleFmErrorCode::GuardrailBlocked.as_str(), "guardrail_blocked");
		assert_eq!(AppleFmErrorCode::Runtime.as_str(), "runtime_error");
	}

	fn attempt() -> TransportAttempt {
		TransportAttempt {
			request_id:          RequestId::new("apple-test"),
			session:             None,
			provider:            ProviderId::new("apple-intelligence"),
			model:               Some(omp_catalog::ModelKey::new("apple-intelligence")),
			api:                 sf!("applefm"),
			route:               RouteId::new("apple-intelligence/primary"),
			account:             None,
			principal:           None,
			index:               0,
			provisional:         false,
			capture_limit:       1024,
			timeout:             Duration::from_secs(1),
			first_event_timeout: None,
		}
	}

	fn availability(state: AppleFmSupportState) -> AppleFmAvailabilityEvidence {
		AppleFmAvailabilityEvidence {
			state,
			os_version: Some("26.0".into()),
			architecture: "aarch64",
			detail: (state != AppleFmSupportState::Available).then(|| "model_not_ready".into()),
			streaming: true,
			tool_evidence: AppleFmFeatureEvidence::RequiresCompiledSwiftToolConformance,
			structured_generation_evidence: AppleFmFeatureEvidence::DynamicSchemaAbiUnverified,
			context_tokens: 4096,
		}
	}

	#[test]
	fn specialized_discovery_reports_available_and_blocked_runtime_evidence() {
		let attempt = attempt();
		let available = apple_discovered_model(
			&attempt.provider,
			&attempt.route,
			&availability(AppleFmSupportState::Available),
		);
		assert_eq!(available.availability, Some(ModelAvailability::Available));
		assert!(
			available
				.declared_operations
				.contains_kind(OperationKind::Chat)
		);
		assert_eq!(
			available
				.declared_limits
				.and_then(|limits| limits.context_window),
			Some(4096),
		);

		let blocked = apple_discovered_model(
			&attempt.provider,
			&attempt.route,
			&availability(AppleFmSupportState::ModelNotReady),
		);
		assert_eq!(blocked.availability, Some(ModelAvailability::Blocked));
		assert_eq!(blocked.provider, attempt.provider);
		assert_eq!(blocked.route, attempt.route);
	}

	#[cfg(target_os = "macos")]
	#[test]
	fn transport_construction_does_not_depend_on_transient_model_availability() {
		assert!(super::AppleFmTransport::new().is_ok());
	}
	fn text_output(output: &VecDeque<RawEvent>) -> String {
		output
			.iter()
			.filter_map(|event| match event {
				RawEvent::Chat(ChatEvent::TextDelta { text, .. }) => Some(text.as_str()),
				_ => None,
			})
			.collect()
	}

	#[test]
	fn transcript_echo_is_repaired_across_streaming_deltas() {
		let mut output = VecDeque::new();
		let mut started = false;
		let mut cleaner = AppleFmResponseCleaner::new(true);
		let mut done = false;
		for delta in ["Assist", "ant: hi\nUs", "er: fake"] {
			done = append_native_attempt(
				&attempt(),
				Ok(AppleFmEvent::Delta(delta.into())),
				&mut started,
				&mut cleaner,
				&mut output,
			)
			.unwrap();
		}
		assert!(done);
		assert_eq!(text_output(&output), "hi");
		assert!(
			output
				.iter()
				.any(|event| matches!(event, RawEvent::Completion(_)))
		);
	}
	#[test]
	fn repeated_assistant_labels_and_double_newline_boundary_are_removed() {
		let mut output = VecDeque::new();
		let mut started = false;
		let mut cleaner = AppleFmResponseCleaner::new(true);
		let done = append_native_attempt(
			&attempt(),
			Ok(AppleFmEvent::Delta("Assistant: \tAssistant:\nhi\n\nUser: fake".into())),
			&mut started,
			&mut cleaner,
			&mut output,
		)
		.unwrap();
		assert!(done);
		assert_eq!(text_output(&output), "hi");
	}

	#[test]
	fn single_turn_streaming_text_passes_through_unchanged() {
		let mut output = VecDeque::new();
		let mut started = false;
		let mut cleaner = AppleFmResponseCleaner::new(false);
		let done = append_native_attempt(
			&attempt(),
			Ok(AppleFmEvent::Delta("Assistant: plain\nUser: still model output".into())),
			&mut started,
			&mut cleaner,
			&mut output,
		)
		.unwrap();
		assert!(!done);
		assert_eq!(text_output(&output), "Assistant: plain\nUser: still model output");
	}

	#[test]
	fn user_label_without_a_leading_newline_is_not_a_turn_boundary() {
		let mut output = VecDeque::new();
		let mut started = false;
		let mut cleaner = AppleFmResponseCleaner::new(true);
		let done = append_native_attempt(
			&attempt(),
			Ok(AppleFmEvent::Delta("Assistant: tell User: hello".into())),
			&mut started,
			&mut cleaner,
			&mut output,
		)
		.unwrap();
		assert!(!done);
		assert_eq!(text_output(&output), "tell User: hello");
	}

	#[test]
	fn native_completion_stays_raw_and_preserves_estimated_usage() {
		let mut output = VecDeque::new();
		let mut started = false;
		let mut cleaner = AppleFmResponseCleaner::new(false);
		let done = append_native_attempt(
			&attempt(),
			Ok(AppleFmEvent::Finished(AppleFmGeneration {
				content:                     "complete".into(),
				prompt_tokens_estimated:     3,
				completion_tokens_estimated: 5,
				context_size_documented:     4096,
			})),
			&mut started,
			&mut cleaner,
			&mut output,
		)
		.unwrap();
		assert!(done);
		let completion = output
			.into_iter()
			.find_map(|event| match event {
				RawEvent::Completion(completion) => Some(completion),
				_ => None,
			})
			.expect("native completion must remain internal");
		assert_eq!(completion.usage.input_tokens, 3);
		assert_eq!(completion.usage.output_tokens, 5);
	}

	#[test]
	fn dropping_stream_requests_native_cancellation() {
		let cancel = CancellationToken::new();
		let observed = cancel.clone();
		let stream = AppleFmStream { rx: Box::pin(futures::stream::pending()), cancel };
		drop(stream);
		assert!(observed.is_cancelled());
	}

	#[test]
	fn native_failure_after_delta_is_committed() {
		let mut output = VecDeque::new();
		let mut started = false;
		let mut cleaner = AppleFmResponseCleaner::new(false);
		append_native_attempt(
			&attempt(),
			Ok(AppleFmEvent::Delta("visible".into())),
			&mut started,
			&mut cleaner,
			&mut output,
		)
		.unwrap();
		let error = append_native_attempt(
			&attempt(),
			Err(AppleFmError::new(AppleFmErrorCode::Runtime, "failed after output")),
			&mut started,
			&mut cleaner,
			&mut output,
		)
		.unwrap_err();
		assert!(error.committed);
	}

	#[tokio::test]
	async fn generation_honors_preexisting_cancellation() {
		let cancel = CancellationToken::new();
		cancel.cancel();
		let error = AppleFm
			.generate(AppleFmOptions::new("hello"), cancel)
			.await
			.unwrap_err();
		assert_eq!(error.code(), AppleFmErrorCode::Cancelled);
	}

	#[test]
	fn native_attempt_error_attaches_static_error_code() {
		let error = AppleFmError::new(AppleFmErrorCode::ContextOverflow, "context overflowed");
		let attempt_err = native_attempt_error(&attempt(), &error, false);
		assert_eq!(attempt_err.code.as_deref(), Some("context_overflow"));
		assert_eq!(AppleFmErrorCode::Runtime.as_str(), "runtime_error");
	}

	#[test]
	fn support_state_codes_use_strum_serialization() {
		assert_eq!(AppleFmSupportState::Available.code(), "available");
		assert_eq!(AppleFmSupportState::SettingsDisabled.code(), "apple_intelligence_not_enabled");
	}
}
