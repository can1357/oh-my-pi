//! Deterministic in-memory transport for lifecycle, handshake, and provider
//! capture replay.

use std::{
	collections::VecDeque,
	future::Future,
	mem,
	num::NonZeroUsize,
	pin::Pin,
	sync::{
		Arc,
		atomic::{AtomicBool, Ordering},
	},
	task::{Context, Poll},
	time::Duration,
};

use bytes::{Bytes, BytesMut};
use futures::{Stream, StreamExt as _, future::poll_fn};
use omp_core::Str;
use parking_lot::Mutex;
use tokio::time::{self, Instant, Sleep};
use tower::Service;

mod attempt_deadline {
	use std::time::Duration;

	use tokio::time::Instant;

	#[derive(Clone, Copy)]
	pub(super) struct AttemptDeadline(pub(super) Instant);

	impl AttemptDeadline {
		pub(super) fn after(duration: Duration) -> Self {
			Self(Instant::now() + duration)
		}
	}
}

use attempt_deadline::AttemptDeadline;

use crate::{
	answer::{RealtimeEvent, RealtimeInput, RealtimeSession},
	body::{AttemptBodyEvidence, AttemptEvidenceHandle, BodyAttempt, BodyOpenError},
	catalog::OperationKind,
	codec::{
		Cancellation, HandshakeMeta, HandshakenResponse, RawEvent, RawEventStream, RequestHeader,
		TransportAttempt, TransportRequest,
	},
	error::{Error, ErrorDetail, ErrorKind, ErrorPhase, RetryAction},
	receipt::{ExecutionReceipt, ReasonId},
	transport::{
		Frame, FramingError, SseDecoder, WebSocketMessage, capture::CaptureSnapshot,
		http::record_failure,
	},
};

/// Request-body behavior performed by one scripted attempt.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CassetteBodyAction {
	/// Do not acquire the request body.
	Unopened,
	/// Acquire the body without polling it.
	Opened,
	/// Poll at most this many body chunks.
	PollChunks(usize),
	/// Consume the complete body stream.
	Drain,
}

/// Terminal behavior following the scripted provider frames.
#[derive(Clone, Debug)]
pub enum CassetteTerminal {
	/// Finish the codec normally.
	Complete,
	/// End the connection without a protocol-complete response.
	Disconnect,
	/// Keep the scripted connection open without another frame until the attempt
	/// timeout.
	Stall,
	/// Surface a preconstructed structured transport failure.
	Error(Box<Error>),
}

/// One deterministic provider attempt.
#[derive(Clone, Debug)]
pub struct CassetteAttempt {
	/// HTTP-like status exposed at handshake.
	pub status:              Option<u16>,
	/// Sanitized public response headers.
	pub headers:             Box<[RequestHeader]>,
	/// Provider request identifier.
	pub provider_request_id: Option<Str>,
	/// Request-body acquisition and polling behavior.
	pub body:                CassetteBodyAction,
	/// Already-framed provider input presented to the codec in order.
	pub frames:              Box<[Frame]>,
	/// Terminal behavior after all frames.
	pub terminal:            CassetteTerminal,
}

/// Failure to construct a replay cassette from provider capture artifacts.
#[derive(Debug, thiserror::Error)]
pub enum CassetteReplayBuildError {
	/// A response frame appeared before its request marker.
	#[error("provider capture response sequence {sequence} has no preceding request")]
	ResponseWithoutRequest {
		/// Process-local capture sequence.
		sequence: u64,
	},
	/// A captured SSE response could not be framed.
	#[error("provider capture SSE framing failed")]
	Framing {
		/// Typed framing failure.
		#[source]
		source: FramingError,
	},
}

/// Immutable deterministic replay script built from [`CaptureSnapshot`].
///
/// Capture exchanges are matched in capture order using the first-completed
/// `/v1/messages` exchange queue. Request payloads and credentials are not
/// fingerprinted because the always-on capture intentionally never retains
/// them. Each transport returned by [`Self::transport`] starts at exchange
/// zero.
#[derive(Clone, Debug)]
pub struct CassetteReplayDriver {
	attempts: Arc<[CassetteAttempt]>,
}

struct ReplayAttemptBuilder {
	framer: SseDecoder,
	frames: Vec<Frame>,
}

impl CassetteReplayDriver {
	/// Reconstructs complete SSE attempts from the exact artifacts emitted by
	/// [`crate::transport::global_provider_capture`].
	pub fn from_capture(snapshot: &CaptureSnapshot) -> Result<Self, CassetteReplayBuildError> {
		let mut attempts = Vec::new();
		let mut framer = None;
		for frame in &snapshot.frames {
			match frame.event.as_str() {
				"request.pre_dispatch" => {
					if let Some(framer) = framer.take() {
						attempts.push(finish_replay_attempt(framer)?);
					}
					framer = Some(ReplayAttemptBuilder {
						framer: SseDecoder::for_replay(),
						frames: Vec::new(),
					});
				},
				"sse" => {
					let Some(framer) = framer.as_mut() else {
						return Err(CassetteReplayBuildError::ResponseWithoutRequest {
							sequence: frame.sequence,
						});
					};
					let emitted = framer
						.framer
						.push(Bytes::copy_from_slice(frame.payload.as_bytes()))
						.map_err(|source| CassetteReplayBuildError::Framing { source })?;
					framer.frames.extend(emitted.into_iter().map(Frame::Sse));
				},
				_ => {},
			}
		}
		if let Some(framer) = framer {
			attempts.push(finish_replay_attempt(framer)?);
		}
		Ok(Self { attempts: attempts.into() })
	}

	/// Number of recorded request/response exchanges.
	pub fn len(&self) -> usize {
		self.attempts.len()
	}

	/// Whether the capture contains no replayable request exchange.
	pub fn is_empty(&self) -> bool {
		self.attempts.is_empty()
	}

	/// Creates an order-matched transport with an independent replay cursor.
	pub fn transport(&self) -> CassetteTransport {
		CassetteTransport::new(Arc::clone(&self.attempts))
	}
}

fn finish_replay_attempt(
	mut builder: ReplayAttemptBuilder,
) -> Result<CassetteAttempt, CassetteReplayBuildError> {
	builder.frames.extend(
		builder
			.framer
			.finish()
			.map_err(|source| CassetteReplayBuildError::Framing { source })?
			.into_iter()
			.map(Frame::Sse),
	);
	let frames = builder.frames.into_boxed_slice();
	Ok(CassetteAttempt {
		status: Some(200),
		headers: Box::new([]),
		provider_request_id: None,
		body: CassetteBodyAction::Drain,
		frames,
		terminal: CassetteTerminal::Complete,
	})
}

/// Sanitized structural frame record. Payload bytes are never retained.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CapturedFrame {
	/// Zero-based frame ordinal.
	pub ordinal:        u64,
	/// Stable protocol label.
	pub protocol:       &'static str,
	/// Original payload length.
	pub observed_bytes: u64,
	/// Fixed redaction token, truncated to the configured capture budget.
	pub redaction:      Bytes,
}
/// Exact provider request bytes retained for deterministic test evidence.
///
/// Request payload capture is test-only, explicitly opt-in, potentially
/// sensitive, and bounded. It never includes request headers or credentials.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CapturedRequestBody {
	/// Retained prefix of the exact body chunks consumed by the cassette.
	pub bytes:          Bytes,
	/// Total bytes observed in consumed body chunks, including bytes beyond the
	/// retention bound.
	pub observed_bytes: u64,
	/// Whether any observed body bytes exceeded the retention bound.
	pub truncated:      bool,
}

/// Deterministic evidence retained for one cassette attempt.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CassetteCapture {
	/// Zero-based scripted attempt index.
	pub attempt:      usize,
	/// Request URI; credential middleware must never place secrets here.
	pub uri:          Str,
	/// Exact request-body lifecycle evidence.
	pub body:         AttemptBodyEvidence,
	/// Opt-in bounded request payload evidence. `None` unless explicitly
	/// configured on the cassette transport.
	pub request_body: Option<CapturedRequestBody>,
	/// Bounded, payload-free provider frame records.
	pub frames:       Box<[CapturedFrame]>,
}

#[derive(Clone, Default)]
struct CaptureLog(Arc<Mutex<Vec<CassetteCapture>>>);

/// Deterministic Tower service whose frames are decoded by each request's real
/// decoder.
///
/// Every clone receives an independent script cursor. Captures are shared so a
/// test can inspect all calls without moving the service used for `poll_ready`
/// and `call`.
#[derive(Clone)]
pub struct CassetteTransport {
	attempts:                   Arc<[CassetteAttempt]>,
	cursor:                     usize,
	pending_ready_polls:        usize,
	ready_permit:               bool,
	request_body_capture_limit: Option<NonZeroUsize>,
	captures:                   CaptureLog,
}

struct CassetteCaptureFinalizer {
	log:          CaptureLog,
	attempt:      usize,
	uri:          Str,
	evidence:     AttemptEvidenceHandle,
	frames:       Vec<CapturedFrame>,
	request_body: Option<RequestBodyCaptureSink>,
}

struct RequestBodyCaptureSink {
	bytes:          BytesMut,
	limit:          usize,
	observed_bytes: u64,
	truncated:      bool,
}

impl RequestBodyCaptureSink {
	fn new(limit: NonZeroUsize) -> Self {
		Self {
			bytes:          BytesMut::new(),
			limit:          limit.get(),
			observed_bytes: 0,
			truncated:      false,
		}
	}

	fn observe(&mut self, chunk: &Bytes) {
		self.observed_bytes = self.observed_bytes.saturating_add(chunk.len() as u64);
		let retained = (self.limit - self.bytes.len()).min(chunk.len());
		self.bytes.extend_from_slice(&chunk[..retained]);
		self.truncated |= retained < chunk.len();
	}

	fn finish(self) -> CapturedRequestBody {
		CapturedRequestBody {
			bytes:          self.bytes.freeze(),
			observed_bytes: self.observed_bytes,
			truncated:      self.truncated,
		}
	}
}

impl Drop for CassetteCaptureFinalizer {
	fn drop(&mut self) {
		self.log.0.lock().push(CassetteCapture {
			attempt:      self.attempt,
			uri:          self.uri.clone(),
			body:         self.evidence.evidence(),
			request_body: self.request_body.take().map(RequestBodyCaptureSink::finish),
			frames:       mem::take(&mut self.frames).into_boxed_slice(),
		});
	}
}

impl CassetteTransport {
	/// Creates a cassette with no artificial readiness delay.
	pub fn new(attempts: impl Into<Arc<[CassetteAttempt]>>) -> Self {
		Self {
			attempts:                   attempts.into(),
			cursor:                     0,
			pending_ready_polls:        0,
			ready_permit:               false,
			captures:                   CaptureLog::default(),
			request_body_capture_limit: None,
		}
	}

	/// Makes the next readiness cycle return `Pending` this many times.
	pub const fn with_pending_ready_polls(mut self, polls: usize) -> Self {
		self.pending_ready_polls = polls;
		self
	}

	/// Enables bounded capture of exact request payload bytes for tests.
	///
	/// Payload capture is opt-in because request bodies may be sensitive. At
	/// most `max_bytes` are retained per attempt, while the capture reports the
	/// exact total observed byte count and whether retention was truncated.
	/// Headers and credentials are never captured; provider frames remain
	/// redacted.
	pub const fn with_request_body_capture(mut self, max_bytes: NonZeroUsize) -> Self {
		self.request_body_capture_limit = Some(max_bytes);
		self
	}

	/// Returns a stable snapshot of structural captures and any explicitly
	/// enabled request payload evidence.
	pub fn captures(&self) -> Vec<CassetteCapture> {
		let mut captures = self.captures.0.lock().clone();
		captures.sort_by_key(|capture| capture.attempt);
		captures
	}
}

impl Service<TransportRequest> for CassetteTransport {
	type Error = Error;
	type Response = HandshakenResponse;

	type Future = impl Future<Output = Result<Self::Response, Self::Error>> + Send + 'static;

	fn poll_ready(&mut self, context: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
		if self.pending_ready_polls > 0 {
			self.pending_ready_polls -= 1;
			context.waker().wake_by_ref();
			return Poll::Pending;
		}
		if self.cursor >= self.attempts.len() {
			return Poll::Ready(Err(cassette_miss(self.cursor, self.attempts.len())));
		}
		self.ready_permit = true;
		Poll::Ready(Ok(()))
	}

	fn call(&mut self, request: TransportRequest) -> Self::Future {
		let permit = mem::take(&mut self.ready_permit);
		let index = self.cursor;
		if permit {
			self.cursor += 1;
		}
		let attempt = self.attempts.get(index).cloned();
		let recorded = self.attempts.len();
		let captures = self.captures.clone();
		let request_body_capture_limit = self.request_body_capture_limit;
		async move {
			if !permit {
				return Err(transport_error(ErrorPhase::Readiness, false, "call-without-readiness"));
			}
			let attempt = attempt.ok_or_else(|| cassette_miss(index, recorded))?;
			run_attempt(index, attempt, request, captures, request_body_capture_limit).await
		}
	}
}

async fn run_attempt(
	index: usize,
	attempt: CassetteAttempt,
	mut request: TransportRequest,
	captures: CaptureLog,
	request_body_capture_limit: Option<NonZeroUsize>,
) -> Result<HandshakenResponse, Error> {
	match (request.decoder.is_some(), request.realtime.is_some()) {
		(true, false) => {},
		(false, true) => {
			return run_realtime_attempt(
				index,
				attempt,
				request,
				captures,
				request_body_capture_limit,
			)
			.await;
		},
		_ => {
			let started = Instant::now();
			let body_attempt = request.encoded.body.begin_attempt();
			let evidence = body_attempt.evidence_handle();
			return Err(record_failure(
				transport_error(ErrorPhase::Handshake, false, "transport-decoder-cardinality"),
				&request.attempt,
				&evidence,
				attempt.status,
				attempt.provider_request_id.as_ref(),
				started,
				false,
			));
		},
	}
	let started = Instant::now();
	let transport_attempt = request.attempt.clone();
	let mut body_attempt = request.encoded.body.begin_attempt();
	let evidence = body_attempt.evidence_handle();
	let deadline = AttemptDeadline::after(transport_attempt.timeout);
	let mut capture = CassetteCaptureFinalizer {
		log:          captures,
		attempt:      index,
		uri:          request.encoded.uri.clone(),
		evidence:     evidence.clone(),
		frames:       Vec::new(),
		request_body: request_body_capture_limit.map(RequestBodyCaptureSink::new),
	};
	consume_body(
		&mut body_attempt,
		attempt.body,
		&request.cancel,
		deadline,
		capture.request_body.as_mut(),
	)
	.await
	.map_err(|error| {
		record_failure(
			error,
			&transport_attempt,
			&evidence,
			attempt.status,
			attempt.provider_request_id.as_ref(),
			started,
			false,
		)
	})?;
	let mut decoder = request.decoder.take().ok_or_else(|| {
		record_failure(
			transport_error(ErrorPhase::Handshake, false, "ordinary-decoder-missing"),
			&transport_attempt,
			&evidence,
			attempt.status,
			attempt.provider_request_id.as_ref(),
			started,
			false,
		)
	})?;

	let mut output = VecDeque::new();
	let mut capture_remaining = request.attempt.capture_limit;
	for (ordinal, frame) in attempt.frames.into_vec().into_iter().enumerate() {
		if request.cancel.is_cancelled() {
			return Err(record_failure(
				cancelled(false),
				&transport_attempt,
				&evidence,
				attempt.status,
				attempt.provider_request_id.as_ref(),
				started,
				false,
			));
		}
		capture_frame(&mut capture.frames, ordinal as u64, &frame, &mut capture_remaining);
		let mut emitted = |event| output.push_back(event);
		if let Err(error) = decoder.push(frame, &mut emitted) {
			return Err(record_failure(
				precommit(error),
				&transport_attempt,
				&evidence,
				attempt.status,
				attempt.provider_request_id.as_ref(),
				started,
				false,
			));
		}
		if let Some(position) = output
			.iter()
			.position(|event| matches!(event, RawEvent::Failure(_)))
			&& !output.iter().take(position).any(is_commit_candidate)
		{
			let Some(RawEvent::Failure(error)) = output.remove(position) else {
				unreachable!()
			};
			return Err(record_failure(
				precommit(error),
				&transport_attempt,
				&evidence,
				attempt.status,
				attempt.provider_request_id.as_ref(),
				started,
				false,
			));
		}
	}

	let mut stall_after_commit = false;
	match attempt.terminal {
		CassetteTerminal::Complete => {
			let mut emitted = |event| output.push_back(event);
			if let Err(error) = decoder.finish(&mut emitted) {
				if output.iter().any(is_commit_candidate) {
					output.push_back(RawEvent::Failure(committed(error)));
				} else {
					return Err(record_failure(
						precommit(error),
						&transport_attempt,
						&evidence,
						attempt.status,
						attempt.provider_request_id.as_ref(),
						started,
						false,
					));
				}
			}
		},
		CassetteTerminal::Disconnect if !output.iter().any(is_commit_candidate) => {
			return Err(record_failure(
				transport_error(ErrorPhase::Handshake, false, "disconnect-before-commit-event"),
				&transport_attempt,
				&evidence,
				attempt.status,
				attempt.provider_request_id.as_ref(),
				started,
				false,
			));
		},
		CassetteTerminal::Disconnect => output.push_back(RawEvent::Failure(transport_error(
			ErrorPhase::Streaming,
			true,
			"disconnect-after-partial-output",
		))),
		CassetteTerminal::Error(error) if !output.iter().any(is_commit_candidate) => {
			return Err(record_failure(
				precommit(*error),
				&transport_attempt,
				&evidence,
				attempt.status,
				attempt.provider_request_id.as_ref(),
				started,
				false,
			));
		},
		CassetteTerminal::Stall if !output.iter().any(is_commit_candidate) => {
			tokio::select! {
				() = time::sleep_until(deadline.0) => {
					request.cancel.cancel();
					return Err(record_failure(deadline_exceeded(false), &transport_attempt, &evidence, attempt.status, attempt.provider_request_id.as_ref(), started, false));
				},
				() = poll_fn(|context| request.cancel.poll_cancelled(context)) => {
					return Err(record_failure(cancelled(false), &transport_attempt, &evidence, attempt.status, attempt.provider_request_id.as_ref(), started, false));
				},
			}
		},
		CassetteTerminal::Stall => stall_after_commit = true,
		CassetteTerminal::Error(error) => output.push_back(RawEvent::Failure(committed(*error))),
	}
	if let Some(position) = output
		.iter()
		.position(|event| matches!(event, RawEvent::Failure(_)))
		&& !output.iter().take(position).any(is_commit_candidate)
	{
		let Some(RawEvent::Failure(error)) = output.remove(position) else {
			unreachable!()
		};
		return Err(record_failure(
			precommit(error),
			&transport_attempt,
			&evidence,
			attempt.status,
			attempt.provider_request_id.as_ref(),
			started,
			false,
		));
	}
	if !output.iter().any(is_commit_candidate) {
		return Err(record_failure(
			transport_error(ErrorPhase::Handshake, false, "no-committing-provider-event"),
			&transport_attempt,
			&evidence,
			attempt.status,
			attempt.provider_request_id.as_ref(),
			started,
			false,
		));
	}
	let stream: RawEventStream = Box::pin(CassetteEventStream::new(
		output,
		request.cancel,
		transport_attempt,
		evidence.clone(),
		attempt.status,
		attempt.provider_request_id.clone(),
		stall_after_commit,
		deadline,
		started,
	));
	Ok(HandshakenResponse {
		meta:     HandshakeMeta {
			status:              attempt.status,
			headers:             attempt.headers,
			provider_request_id: attempt.provider_request_id,
		},
		body:     evidence,
		events:   Some(stream),
		control:  None,
		realtime: None,
	})
}

async fn run_realtime_attempt(
	index: usize,
	attempt: CassetteAttempt,
	mut request: TransportRequest,
	captures: CaptureLog,
	request_body_capture_limit: Option<NonZeroUsize>,
) -> Result<HandshakenResponse, Error> {
	let started = Instant::now();
	let transport_attempt = request.attempt.clone();
	let deadline = AttemptDeadline::after(transport_attempt.timeout);
	let mut body_attempt = request.encoded.body.begin_attempt();
	let evidence = body_attempt.evidence_handle();
	let mut capture = CassetteCaptureFinalizer {
		log:          captures,
		attempt:      index,
		uri:          request.encoded.uri.clone(),
		evidence:     evidence.clone(),
		frames:       Vec::new(),
		request_body: request_body_capture_limit.map(RequestBodyCaptureSink::new),
	};
	consume_body(
		&mut body_attempt,
		attempt.body,
		&request.cancel,
		deadline,
		capture.request_body.as_mut(),
	)
	.await
	.map_err(|error| {
		record_failure(
			error,
			&transport_attempt,
			&evidence,
			attempt.status,
			attempt.provider_request_id.as_ref(),
			started,
			false,
		)
	})?;
	if request.encoded.operation != OperationKind::Realtime {
		return Err(record_failure(
			transport_error(ErrorPhase::Handshake, false, "realtime-codec-on-non-realtime-operation"),
			&transport_attempt,
			&evidence,
			attempt.status,
			attempt.provider_request_id.as_ref(),
			started,
			false,
		));
	}
	let mut codec = request.realtime.take().ok_or_else(|| {
		record_failure(
			transport_error(ErrorPhase::Handshake, false, "realtime-codec-missing"),
			&transport_attempt,
			&evidence,
			attempt.status,
			attempt.provider_request_id.as_ref(),
			started,
			false,
		)
	})?;
	let initial_frames = codec.initial_frames().map_err(|error| {
		record_failure(
			precommit(error),
			&transport_attempt,
			&evidence,
			attempt.status,
			attempt.provider_request_id.as_ref(),
			started,
			false,
		)
	})?;
	if initial_frames
		.iter()
		.any(|frame| frame.len() as u64 > request.encoded.bounds.frame)
	{
		return Err(record_failure(
			transport_error(ErrorPhase::Handshake, false, "realtime-initial-frame-limit"),
			&transport_attempt,
			&evidence,
			attempt.status,
			attempt.provider_request_id.as_ref(),
			started,
			false,
		));
	}
	let mut capture_remaining = request.attempt.capture_limit;
	let mut initial = Vec::new();
	let mut decoded_frame = false;
	for (ordinal, frame) in attempt.frames.into_vec().into_iter().enumerate() {
		capture_frame(&mut capture.frames, ordinal as u64, &frame, &mut capture_remaining);
		if let Some(payload) = realtime_payload(frame).map_err(|error| {
			record_failure(
				error,
				&transport_attempt,
				&evidence,
				attempt.status,
				attempt.provider_request_id.as_ref(),
				started,
				false,
			)
		})? {
			let events = codec.decode(payload).map_err(|error| {
				record_failure(
					error,
					&transport_attempt,
					&evidence,
					attempt.status,
					attempt.provider_request_id.as_ref(),
					started,
					false,
				)
			})?;
			decoded_frame = true;
			initial.extend(events);
		}
	}
	if !decoded_frame {
		return Err(record_failure(
			transport_error(ErrorPhase::Handshake, false, "realtime-no-decodable-provider-frame"),
			&transport_attempt,
			&evidence,
			attempt.status,
			attempt.provider_request_id.as_ref(),
			started,
			false,
		));
	}
	match attempt.terminal {
		CassetteTerminal::Disconnect => {
			return Err(record_failure(
				transport_error(ErrorPhase::Handshake, false, "realtime-disconnect-during-handshake"),
				&transport_attempt,
				&evidence,
				attempt.status,
				attempt.provider_request_id.as_ref(),
				started,
				false,
			));
		},
		CassetteTerminal::Error(error) => {
			return Err(record_failure(
				precommit(*error),
				&transport_attempt,
				&evidence,
				attempt.status,
				attempt.provider_request_id.as_ref(),
				started,
				false,
			));
		},
		CassetteTerminal::Complete | CassetteTerminal::Stall => {},
	}
	let (outbound, outbound_rx) = flume::bounded(16);
	let (inbound_tx, inbound) = flume::bounded(16);
	let closed = Arc::new(AtomicBool::new(false));
	inbound_tx
		.send_async(Ok(RealtimeEvent::Ready))
		.await
		.map_err(|_| {
			record_failure(
				cancelled(false),
				&transport_attempt,
				&evidence,
				attempt.status,
				attempt.provider_request_id.as_ref(),
				started,
				false,
			)
		})?;
	for event in initial {
		inbound_tx.send_async(Ok(event)).await.map_err(|_| {
			record_failure(
				cancelled(false),
				&transport_attempt,
				&evidence,
				attempt.status,
				attempt.provider_request_id.as_ref(),
				started,
				false,
			)
		})?;
	}
	let cancel = request.cancel.clone();
	let status = attempt.status;
	let provider_request_id = attempt.provider_request_id.clone();
	let pump_evidence = evidence.clone();
	let pump_closed = Arc::clone(&closed);
	tokio::spawn(async move {
		let _closed = RealtimeClosedGuard(pump_closed);
		loop {
			let input = tokio::select! {
				input = outbound_rx.recv_async() => match input {
					Ok(input) => input,
					Err(_) => break,
				},
				() = poll_fn(|context| cancel.poll_cancelled(context)) => break,
				() = time::sleep_until(deadline.0) => {
					cancel.cancel();
					let error = record_failure(deadline_exceeded(true), &transport_attempt, &pump_evidence, status, provider_request_id.as_ref(), started, true);
					let _ = inbound_tx.send_async(Err(error)).await;
					break;
				},
			};
			if matches!(input, RealtimeInput::Close) {
				let _ = inbound_tx.send_async(Ok(RealtimeEvent::Closed)).await;
				break;
			}
			let frames = match codec.encode(input) {
				Ok(frames)
					if frames
						.iter()
						.all(|frame| frame.len() as u64 <= request.encoded.bounds.frame) =>
				{
					frames
				},
				Ok(_) => {
					let error = record_failure(
						transport_error(ErrorPhase::Streaming, true, "realtime-outbound-frame-limit"),
						&transport_attempt,
						&pump_evidence,
						status,
						provider_request_id.as_ref(),
						started,
						true,
					);
					let _ = inbound_tx.send_async(Err(error)).await;
					break;
				},
				Err(error) => {
					let error = record_failure(
						committed(error),
						&transport_attempt,
						&pump_evidence,
						status,
						provider_request_id.as_ref(),
						started,
						true,
					);
					let _ = inbound_tx.send_async(Err(error)).await;
					break;
				},
			};
			for encoded in frames {
				match codec.decode(encoded) {
					Ok(events) => {
						for event in events {
							if inbound_tx.send_async(Ok(event)).await.is_err() {
								return;
							}
						}
					},
					Err(error) => {
						let error = record_failure(
							committed(error),
							&transport_attempt,
							&pump_evidence,
							status,
							provider_request_id.as_ref(),
							started,
							true,
						);
						let _ = inbound_tx.send_async(Err(error)).await;
						return;
					},
				}
			}
		}
	});
	Ok(HandshakenResponse {
		meta:     HandshakeMeta {
			status:              attempt.status,
			headers:             attempt.headers,
			provider_request_id: attempt.provider_request_id,
		},
		body:     evidence,
		events:   None,
		control:  None,
		realtime: Some(RealtimeSession::from_channels(outbound, inbound, closed)),
	})
}
struct RealtimeClosedGuard(Arc<AtomicBool>);

impl Drop for RealtimeClosedGuard {
	fn drop(&mut self) {
		self.0.store(true, Ordering::Release);
	}
}
fn realtime_payload(frame: Frame) -> Result<Option<Bytes>, Error> {
	match frame {
		Frame::Raw(payload) | Frame::Ndjson(payload) => Ok(Some(payload)),
		Frame::WebSocket(WebSocketMessage::Text(payload) | WebSocketMessage::Binary(payload)) => {
			Ok(Some(payload))
		},
		Frame::WebSocket(WebSocketMessage::Ping(_) | WebSocketMessage::Pong(_)) => Ok(None),
		Frame::WebSocket(WebSocketMessage::Close { .. }) => {
			Err(transport_error(ErrorPhase::Handshake, false, "realtime-close-before-handshake"))
		},
		Frame::Sse(_) | Frame::Connect(_) | Frame::EventStream(_) => {
			Err(transport_error(ErrorPhase::Handshake, false, "realtime-invalid-provider-frame"))
		},
	}
}

async fn consume_body(
	attempt: &mut BodyAttempt,
	action: CassetteBodyAction,
	cancel: &Cancellation,
	deadline: AttemptDeadline,
	mut capture: Option<&mut RequestBodyCaptureSink>,
) -> Result<(), Error> {
	if action == CassetteBodyAction::Unopened {
		return Ok(());
	}
	let reader = tokio::select! {
		result = attempt.open() => result.map_err(|error| match error {
			BodyOpenError::Factory(error) => error,
			BodyOpenError::AttemptAlreadyOpened => transport_error(ErrorPhase::Connecting, false, "body-attempt-already-opened"),
			BodyOpenError::ConcurrentReader => transport_error(ErrorPhase::Connecting, false, "body-concurrent-reader"),
			BodyOpenError::Consumed => transport_error(ErrorPhase::Connecting, false, "body-consumed"),
			BodyOpenError::ReacquisitionUnavailable => transport_error(ErrorPhase::Connecting, false, "body-reacquisition-unavailable"),
		})?,
		() = time::sleep_until(deadline.0) => {
			cancel.cancel();
			return Err(deadline_exceeded(false));
		},
	};
	let mut reader = reader;
	if action == CassetteBodyAction::Opened {
		return Ok(());
	}
	let limit = match action {
		CassetteBodyAction::PollChunks(limit) => Some(limit),
		CassetteBodyAction::Drain => None,
		_ => unreachable!(),
	};
	let mut polled = 0;
	while limit.is_none_or(|limit| polled < limit) {
		let next = tokio::select! {
			next = reader.next() => next,
			() = poll_fn(|context| cancel.poll_cancelled(context)) => return Err(cancelled(false)),
			() = time::sleep_until(deadline.0) => {
				cancel.cancel();
				return Err(deadline_exceeded(false));
			},
		};
		match next {
			Some(Ok(chunk)) => {
				if let Some(capture) = capture.as_deref_mut() {
					capture.observe(&chunk);
				}
				polled += 1;
			},
			Some(Err(error)) => return Err(precommit(error)),
			None => break,
		}
	}
	Ok(())
}

pub(crate) fn capture_frame(
	output: &mut Vec<CapturedFrame>,
	ordinal: u64,
	frame: &Frame,
	remaining: &mut u64,
) {
	if *remaining == 0 {
		return;
	}
	let (protocol, observed) = frame_metadata(frame);
	const REDACTED: &[u8] = b"<redacted>";
	let retained = (*remaining).min(REDACTED.len() as u64) as usize;
	output.push(CapturedFrame {
		ordinal,
		protocol,
		observed_bytes: observed as u64,
		redaction: Bytes::from_static(REDACTED).slice(..retained),
	});
	*remaining -= retained as u64;
}

const fn frame_metadata(frame: &Frame) -> (&'static str, usize) {
	match frame {
		Frame::Raw(data) => ("raw", data.len()),
		Frame::Sse(event) => ("sse", event.data.len()),
		Frame::Ndjson(data) => ("ndjson", data.len()),
		Frame::WebSocket(message) => ("websocket", websocket_payload_len(message)),
		Frame::Connect(envelope) => ("connect", envelope.payload.len()),
		Frame::EventStream(message) => ("aws-eventstream", message.payload.len()),
	}
}

const fn websocket_payload_len(message: &WebSocketMessage) -> usize {
	match message {
		WebSocketMessage::Text(data)
		| WebSocketMessage::Binary(data)
		| WebSocketMessage::Ping(data)
		| WebSocketMessage::Pong(data) => data.len(),
		WebSocketMessage::Close { reason, .. } => reason.len(),
	}
}

pub(crate) fn is_commit_candidate(event: &RawEvent) -> bool {
	match event {
		RawEvent::Chat(event) => event.commits_output(),
		RawEvent::Completion(_)
		| RawEvent::Answer(_)
		| RawEvent::Control(_)
		| RawEvent::NativeChunk(_)
		| RawEvent::DiscoveredModels { .. } => true,
		RawEvent::ToolCallComplete { .. }
		| RawEvent::ProviderState(_)
		| RawEvent::ImageGeneration(_)
		| RawEvent::VideoGeneration(_)
		| RawEvent::Audio(_)
		| RawEvent::Transcript(_)
		| RawEvent::Metadata(_)
		| RawEvent::Telemetry(_)
		| RawEvent::Failure(_) => false,
	}
}

const fn precommit(mut error: Error) -> Error {
	error.committed = false;
	error.phase = ErrorPhase::Handshake;
	error
}

const fn committed(mut error: Error) -> Error {
	error.committed = true;
	error.phase = ErrorPhase::Streaming;
	error.action = RetryAction::Never;
	error
}

fn deadline_exceeded(committed: bool) -> Error {
	Error::new(
		ErrorKind::DeadlineExceeded,
		if committed {
			ErrorPhase::Streaming
		} else {
			ErrorPhase::Handshake
		},
		RetryAction::Never,
		ExecutionReceipt::default(),
	)
	.committed(committed)
}

fn cancelled(committed: bool) -> Error {
	let phase = if committed {
		ErrorPhase::Streaming
	} else {
		ErrorPhase::Handshake
	};
	Error::new(ErrorKind::Cancelled, phase, RetryAction::Never, ExecutionReceipt::default())
		.committed(committed)
}

fn cassette_miss(request_index: usize, recorded: usize) -> Error {
	Error::new(
		ErrorKind::ReplayRequired,
		ErrorPhase::Readiness,
		RetryAction::Never,
		ExecutionReceipt::default(),
	)
	.detail(ErrorDetail::cassette_miss(request_index, recorded))
}

fn transport_error(phase: ErrorPhase, committed: bool, reason: &'static str) -> Error {
	let action = if committed {
		RetryAction::Never
	} else {
		RetryAction::SameRoute { after: Duration::ZERO }
	};
	Error::new(ErrorKind::Connectivity, phase, action, ExecutionReceipt::default())
		.committed(committed)
		.detail(ErrorDetail::protocol(ReasonId(Str::new(reason))))
}

struct CassetteEventStream {
	items:               VecDeque<RawEvent>,
	cancel:              Cancellation,
	attempt:             TransportAttempt,
	evidence:            AttemptEvidenceHandle,
	status:              Option<u16>,
	provider_request_id: Option<Str>,
	stall_after_commit:  bool,
	deadline:            Pin<Box<Sleep>>,
	started:             Instant,
	emitted:             bool,
	finished:            bool,
}

impl CassetteEventStream {
	fn new(
		items: VecDeque<RawEvent>,
		cancel: Cancellation,
		attempt: TransportAttempt,
		evidence: AttemptEvidenceHandle,
		status: Option<u16>,
		provider_request_id: Option<Str>,
		stall_after_commit: bool,
		deadline: AttemptDeadline,
		started: Instant,
	) -> Self {
		Self {
			items,
			cancel,
			attempt,
			evidence,
			status,
			provider_request_id,
			stall_after_commit,
			deadline: Box::pin(time::sleep_until(deadline.0)),
			started,
			emitted: false,
			finished: false,
		}
	}
}

impl Stream for CassetteEventStream {
	type Item = Result<RawEvent, Error>;

	fn poll_next(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Option<Self::Item>> {
		if self.finished {
			return Poll::Ready(None);
		}
		if self.cancel.is_cancelled() {
			self.finished = true;
			let committed = self.emitted;
			let error = record_failure(
				cancelled(committed),
				&self.attempt,
				&self.evidence,
				self.status,
				self.provider_request_id.as_ref(),
				self.started,
				committed,
			);
			return Poll::Ready(Some(Err(error)));
		}
		match self.items.pop_front() {
			Some(RawEvent::Failure(error)) => {
				self.finished = true;
				let committed = self.emitted;
				let error = record_failure(
					error,
					&self.attempt,
					&self.evidence,
					self.status,
					self.provider_request_id.as_ref(),
					self.started,
					committed,
				);
				Poll::Ready(Some(Err(error)))
			},
			Some(event) => {
				self.emitted |= is_commit_candidate(&event);
				Poll::Ready(Some(Ok(event)))
			},
			None if self.stall_after_commit => {
				if self.deadline.as_mut().poll(context).is_pending() {
					return Poll::Pending;
				}
				self.finished = true;
				self.cancel.cancel();
				let error = record_failure(
					deadline_exceeded(true),
					&self.attempt,
					&self.evidence,
					self.status,
					self.provider_request_id.as_ref(),
					self.started,
					true,
				);
				Poll::Ready(Some(Err(error)))
			},
			None => {
				self.finished = true;
				Poll::Ready(None)
			},
		}
	}
}

impl Drop for CassetteEventStream {
	fn drop(&mut self) {
		if !self.finished && !self.items.is_empty() {
			self.cancel.cancel();
		}
	}
}
#[cfg(test)]
mod tests {
	use omp_core::sf;

	use super::is_commit_candidate;
	use crate::{
		codec::RawEvent,
		event::{BlockKind, ChatEvent},
	};

	#[test]
	fn empty_open_blocks_remain_replay_safe_but_whitespace_deltas_commit() {
		assert!(!is_commit_candidate(&RawEvent::Chat(ChatEvent::BlockStarted {
			index: 0,
			kind:  BlockKind::Text,
		})));
		assert!(!is_commit_candidate(&RawEvent::Chat(ChatEvent::TextDelta {
			index: 0,
			text:  sf!(""),
		})));
		assert!(is_commit_candidate(&RawEvent::Chat(ChatEvent::TextDelta {
			index: 0,
			text:  sf!(" \n"),
		})));
		assert!(is_commit_candidate(&RawEvent::Chat(ChatEvent::ThinkingDelta {
			index: 1,
			text:  sf!("thought"),
		})));
	}
}
