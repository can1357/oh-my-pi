use std::{
	future,
	num::NonZeroUsize,
	sync::{
		Arc, Mutex as StdMutex,
		atomic::{AtomicUsize, Ordering},
	},
};

use bytes::Bytes;
use futures::{FutureExt as _, StreamExt as _, stream};
use omp_catalog::{OperationKind, ProviderId, RouteId};
use omp_core::{Str, sf};
use tokio::{
	io::{AsyncReadExt as _, AsyncWriteExt as _},
	net::TcpListener,
	sync::oneshot,
	time,
};
use tokio_tungstenite::tungstenite;
use tower::{Service as _, ServiceExt as _};

use super::{
	CaptureSnapshot, CaptureSummary, CapturedFrame as ProviderCapturedFrame, Frame, FramingProtocol,
	WebSocketTransport, cassette::*, http::HttpTransport,
};
use crate::{
	answer::{RealtimeEvent, RealtimeInput},
	body::{
		BodyFactoryHandle, BodySource, ByteStream, OneShotBody, RetryDecision, RetryDecisionReason,
	},
	call::{NegotiationPolicy, RealtimeModality, RealtimeRequest, Setting},
	codec::{
		Cancellation, Decoder, EncodedRequest, ProviderMetadataEvent, ProviderResponseHooks,
		ProviderResponseObservation, ProviderResponseObserver, ProviderStateEvent, RawCompletion,
		RawEvent, RealtimeEvents, RealtimeWireCodec, RealtimeWireFrames, RequestMethod, SizeBounds,
		TransportAttempt, TransportRequest, openai_realtime::OpenAiRealtimeWireCodec,
	},
	error::{Error, ErrorDetail, ErrorKind, ErrorPhase, RetryAction},
	event::{BlockKind, ChatEvent, FinishReason},
	id::RequestId,
	receipt::{AttemptOutcome, ExecutionReceipt, ReasonId, Usage},
};

#[derive(Default)]
struct ResponseObserver {
	subscribed: bool,
	observed:   StdMutex<Vec<ProviderResponseObservation>>,
}

impl crate::codec::ProviderHookObserver for ResponseObserver {}

impl ProviderResponseObserver for ResponseObserver {
	fn subscribed(&self) -> bool {
		self.subscribed
	}

	fn observe(&self, observation: ProviderResponseObservation) {
		self
			.observed
			.lock()
			.expect("observer lock")
			.push(observation);
	}
}

struct CapturedSseDecoder;

impl Decoder for CapturedSseDecoder {
	fn push(&mut self, frame: Frame, emit: &mut dyn FnMut(RawEvent)) -> Result<(), Error> {
		let Frame::Sse(event) = frame else {
			panic!("replay must preserve SSE framing")
		};
		emit(RawEvent::Chat(ChatEvent::TextDelta {
			index: 0,
			text:  Str::new(String::from_utf8_lossy(&event.data)),
		}));
		Ok(())
	}

	fn finish(&mut self, _emit: &mut dyn FnMut(RawEvent)) -> Result<(), Error> {
		Ok(())
	}
}

struct EmitDecoder;

impl Decoder for EmitDecoder {
	fn push(&mut self, _frame: Frame, emit: &mut dyn FnMut(RawEvent)) -> Result<(), Error> {
		emit(RawEvent::Chat(ChatEvent::TextDelta { index: 0, text: sf!("visible") }));
		Ok(())
	}

	fn finish(&mut self, _emit: &mut dyn FnMut(RawEvent)) -> Result<(), Error> {
		Ok(())
	}
}

struct PreambleThenVisibleDecoder;

impl Decoder for PreambleThenVisibleDecoder {
	fn push(&mut self, _frame: Frame, emit: &mut dyn FnMut(RawEvent)) -> Result<(), Error> {
		emit(RawEvent::Metadata(ProviderMetadataEvent::ResponseId(sf!("response"))));
		emit(RawEvent::Chat(ChatEvent::TextDelta { index: 0, text: sf!("visible") }));
		Ok(())
	}

	fn finish(&mut self, _emit: &mut dyn FnMut(RawEvent)) -> Result<(), Error> {
		Ok(())
	}
}

struct MetadataOnlyDecoder;

impl Decoder for MetadataOnlyDecoder {
	fn push(&mut self, _frame: Frame, emit: &mut dyn FnMut(RawEvent)) -> Result<(), Error> {
		emit(RawEvent::Metadata(ProviderMetadataEvent::ResponseId(sf!("response"))));
		Ok(())
	}

	fn finish(&mut self, _emit: &mut dyn FnMut(RawEvent)) -> Result<(), Error> {
		Ok(())
	}
}

struct StateThenExpiredDecoder;

impl Decoder for StateThenExpiredDecoder {
	fn push(&mut self, _frame: Frame, emit: &mut dyn FnMut(RawEvent)) -> Result<(), Error> {
		emit(RawEvent::ProviderState(ProviderStateEvent::Checkpoint {
			id:   Some(sf!("checkpoint")),
			data: Bytes::from_static(b"opaque"),
		}));
		let error = Error::new(
			ErrorKind::SessionExpired,
			ErrorPhase::Handshake,
			RetryAction::ReseedSession,
			ExecutionReceipt::default(),
		);
		emit(RawEvent::Failure(error));
		Ok(())
	}

	fn finish(&mut self, _emit: &mut dyn FnMut(RawEvent)) -> Result<(), Error> {
		Ok(())
	}
}

struct CompletionOnlyDecoder;

impl Decoder for CompletionOnlyDecoder {
	fn push(&mut self, _frame: Frame, emit: &mut dyn FnMut(RawEvent)) -> Result<(), Error> {
		emit(RawEvent::Completion(RawCompletion {
			reason: FinishReason::Stop,
			blocks: 0,
			usage:  Usage::default(),
		}));
		Ok(())
	}

	fn finish(&mut self, _emit: &mut dyn FnMut(RawEvent)) -> Result<(), Error> {
		Ok(())
	}
}

struct FailDecoder;

impl Decoder for FailDecoder {
	fn push(&mut self, _frame: Frame, _emit: &mut dyn FnMut(RawEvent)) -> Result<(), Error> {
		Err(
			Error::new(
				ErrorKind::Protocol,
				ErrorPhase::Handshake,
				RetryAction::Never,
				ExecutionReceipt::default(),
			)
			.detail(ErrorDetail::protocol(ReasonId(sf!("fixture-first-frame")))),
		)
	}

	fn finish(&mut self, _emit: &mut dyn FnMut(RawEvent)) -> Result<(), Error> {
		Ok(())
	}
}

fn request(
	body: BodySource,
	decoder: impl Decoder + 'static,
	cancel: Cancellation,
) -> TransportRequest {
	TransportRequest {
		encoded: EncodedRequest {
			operation: OperationKind::Chat,
			method: RequestMethod::Post,
			uri: sf!("https://provider.invalid/v1/stream"),
			headers: Box::new([]),
			body,
			framing: FramingProtocol::Raw,
			bounds: SizeBounds { request_body: 1024, frame: 1024, response: 1024 },
			sealed_body: None,
			adjustments: Vec::new(),
		},
		credentials: None,
		signature: None,
		decoder: Some(Box::new(decoder)),
		realtime: None,
		cancel,
		response_hooks: Default::default(),
		attempt: TransportAttempt {
			request_id:          RequestId::new("request"),
			session:             None,
			provider:            ProviderId::new("provider"),
			model:               Some(omp_catalog::ModelKey::new("model")),
			api:                 sf!("test"),
			route:               RouteId::new("route"),
			account:             None,
			principal:           None,
			index:               0,
			provisional:         false,
			timeout:             time::Duration::from_secs(5),
			first_event_timeout: None,
			capture_limit:       10,
		},
	}
}

#[tokio::test]
async fn provider_response_hook_is_bitmap_gated_and_fires_for_each_attempt() {
	let listener = TcpListener::bind("127.0.0.1:0")
		.await
		.expect("bind response fixture");
	let address = listener.local_addr().expect("response fixture address");
	let server = tokio::spawn(async move {
		for response in [
			"HTTP/1.1 503 Service Unavailable\r\nX-RateLimit-Remaining: 4\r\nSet-Cookie: \
			 secret=one\r\nX-Request-Id: req-1\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}",
			"HTTP/1.1 200 OK\r\nAnthropic-RateLimit-Requests-Remaining: 3\r\nSet-Cookie: \
			 secret=two\r\nX-Request-Id: req-2\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok",
			"HTTP/1.1 200 OK\r\nX-RateLimit-Remaining: 2\r\nSet-Cookie: \
			 secret=three\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok",
		] {
			let (mut socket, _) = listener.accept().await.expect("accept response fixture");
			let mut request = [0_u8; 4096];
			let _ = socket.read(&mut request).await.expect("read request");
			socket
				.write_all(response.as_bytes())
				.await
				.expect("write response");
		}
	});
	let observer =
		Arc::new(ResponseObserver { subscribed: true, observed: StdMutex::new(Vec::new()) });
	let mut service = HttpTransport::new();
	for attempt in 0..2 {
		let mut call = request(
			BodySource::Bytes(Bytes::from_static(b"request")),
			EmitDecoder,
			Cancellation::default(),
		);
		call.encoded.uri = sf!("http://{address}/stream");
		call.attempt.index = attempt;
		call.response_hooks = ProviderResponseHooks::new(observer.clone());
		let result = service
			.ready()
			.await
			.expect("transport ready")
			.call(call)
			.await;
		if attempt == 0 {
			assert!(result.is_err(), "first attempt must be retryable failure");
		} else {
			assert!(result.is_ok(), "second attempt must succeed");
		}
	}
	let unsubscribed = Arc::new(ResponseObserver::default());
	let mut call = request(
		BodySource::Bytes(Bytes::from_static(b"request")),
		EmitDecoder,
		Cancellation::default(),
	);
	call.encoded.uri = sf!("http://{address}/stream");
	call.response_hooks = ProviderResponseHooks::new(unsubscribed.clone());
	assert!(
		service
			.ready()
			.await
			.expect("transport ready")
			.call(call)
			.await
			.is_ok()
	);
	server.await.expect("response fixture");

	let observed = observer.observed.lock().expect("observer lock");
	assert_eq!(observed.len(), 2);
	assert_eq!((observed[0].status, observed[1].status), (503, 200));
	assert_eq!(observed[0].request_id.as_deref(), Some("req-1"));
	assert_eq!(observed[1].request_id.as_deref(), Some("req-2"));
	for response in observed.iter() {
		assert!(
			response
				.headers
				.iter()
				.all(|(name, _)| name.as_str() == name.as_str().to_ascii_lowercase())
		);
		assert!(
			!response
				.headers
				.iter()
				.any(|(name, _)| name.as_str() == "set-cookie")
		);
	}
	assert!(
		observed[0]
			.headers
			.iter()
			.any(|(name, value)| name.as_str() == "x-ratelimit-remaining" && value.as_str() == "4")
	);
	assert!(observed[1].headers.iter().any(|(name, value)| {
		name.as_str() == "anthropic-ratelimit-requests-remaining" && value.as_str() == "3"
	}));
	assert!(
		unsubscribed
			.observed
			.lock()
			.expect("observer lock")
			.is_empty()
	);
}

fn attempt(
	body: CassetteBodyAction,
	terminal: CassetteTerminal,
	frame_count: usize,
) -> CassetteAttempt {
	CassetteAttempt {
		status: Some(200),
		headers: Box::new([]),
		provider_request_id: Some(sf!("provider-request")),
		body,
		frames: (0..frame_count)
			.map(|_| Frame::Raw(Bytes::from_static(b"secret-frame")))
			.collect::<Vec<_>>()
			.into_boxed_slice(),
		terminal,
	}
}

fn replay_capture() -> CaptureSnapshot {
	CaptureSnapshot {
		frames:  vec![
			ProviderCapturedFrame {
				sequence: 0,
				session:  Some(sf!("session")),
				event:    sf!("request.pre_dispatch"),
				payload:  sf!("Chat Post https://provider.invalid/v1/stream headers=[]"),
			},
			ProviderCapturedFrame {
				sequence: 1,
				session:  None,
				event:    sf!("sse"),
				payload:  sf!("data: first\n\n"),
			},
			ProviderCapturedFrame {
				sequence: 2,
				session:  None,
				event:    sf!("sse"),
				payload:  sf!("data: second\n\n"),
			},
		],
		summary: CaptureSummary { retained: 3, evicted: 0, subscriber_drops: 0 },
	}
}

async fn replay_text(mut service: CassetteTransport) -> Vec<Str> {
	service.ready().await.expect("cassette ready");
	let response = service
		.call(request(
			BodySource::Bytes(Bytes::from_static(b"same-request")),
			CapturedSseDecoder,
			Cancellation::default(),
		))
		.await
		.expect("replay handshake");
	let mut events = response.events.expect("ordinary event stream");
	let mut text = Vec::new();
	while let Some(event) = events.next().await {
		if let RawEvent::Chat(ChatEvent::TextDelta { text: delta, .. }) = event.expect("replay event")
		{
			text.push(delta);
		}
	}
	text
}

#[tokio::test]
async fn provider_capture_replays_identical_chat_event_streams() {
	let encoded = serde_json::to_vec(&replay_capture()).expect("serialize capture artifact");
	let capture: CaptureSnapshot =
		serde_json::from_slice(&encoded).expect("deserialize exact capture artifact");
	let driver = CassetteReplayDriver::from_capture(&capture).expect("valid capture");
	assert_eq!(driver.len(), 1);
	let first = replay_text(driver.transport()).await;
	let second = replay_text(driver.transport()).await;
	assert_eq!(first, [sf!("first"), sf!("second")]);
	assert_eq!(first, second);
}

#[tokio::test]
async fn provider_capture_reports_typed_cassette_miss() {
	let driver = CassetteReplayDriver::from_capture(&replay_capture()).expect("valid capture");
	let mut service = driver.transport();
	let _ = replay_text(service.clone()).await;
	service.ready().await.expect("first exchange ready");
	let response = service
		.call(request(
			BodySource::Bytes(Bytes::from_static(b"same-request")),
			CapturedSseDecoder,
			Cancellation::default(),
		))
		.await
		.expect("first replay handshake");
	drop(response.events);
	let error = match service.ready().await {
		Ok(_) => panic!("second exchange must miss"),
		Err(error) => error,
	};
	assert_eq!(
		error.detail_ref(),
		Some(&ErrorDetail::CassetteMiss { request_index: 1, recorded: 1 })
	);
}

#[tokio::test]
async fn first_frame_error_remains_precommit_with_exact_body_evidence() {
	let mut service = CassetteTransport::new(Arc::from([attempt(
		CassetteBodyAction::PollChunks(1),
		CassetteTerminal::Complete,
		1,
	)]));
	service.ready().await.expect("cassette ready");
	let error = service
		.call(request(
			BodySource::Bytes(Bytes::from_static(b"request")),
			FailDecoder,
			Cancellation::default(),
		))
		.await
		.err()
		.expect("first frame fails handshake");
	assert!(!error.committed);
	assert_eq!(error.phase, ErrorPhase::Handshake);
	let receipt = error.receipt().attempts.last().expect("attempt receipt");
	assert_eq!(receipt.outcome, AttemptOutcome::FailedPreCommit);
	assert!(receipt.body.opened && receipt.body.consumed);
}

#[tokio::test]
async fn disconnect_after_first_event_is_a_committed_partial_error() {
	let mut service = CassetteTransport::new(Arc::from([attempt(
		CassetteBodyAction::Drain,
		CassetteTerminal::Disconnect,
		1,
	)]));
	service.ready().await.expect("cassette ready");
	let response = service
		.call(request(
			BodySource::Bytes(Bytes::from_static(b"request")),
			EmitDecoder,
			Cancellation::default(),
		))
		.await
		.expect("handshake");
	let mut events = response.events.expect("ordinary event stream");
	assert!(events.next().await.expect("first event").is_ok());
	let Err(error) = events.next().await.expect("partial error") else {
		panic!("disconnect must surface as an error");
	};
	assert!(error.committed);
	assert_eq!(
		error
			.receipt()
			.attempts
			.last()
			.expect("attempt receipt")
			.outcome,
		AttemptOutcome::FailedCommitted
	);
	assert!(events.next().await.is_none(), "committed failure terminates the response stream");
}

#[tokio::test]
async fn readiness_cancellation_and_capture_are_deterministic() {
	let cancel = Cancellation::default();
	let mut service = CassetteTransport::new(Arc::from([attempt(
		CassetteBodyAction::Opened,
		CassetteTerminal::Complete,
		2,
	)]))
	.with_pending_ready_polls(1);
	service
		.ready()
		.await
		.expect("readiness forwards pending then ready");
	let response = service
		.call(request(BodySource::Bytes(Bytes::from_static(b"request")), EmitDecoder, cancel.clone()))
		.await
		.expect("handshake");
	drop(response.events.expect("ordinary event stream"));
	assert!(cancel.is_cancelled());
	let captures = service.captures();
	assert_eq!(captures.len(), 1);
	assert!(captures[0].body.opened && !captures[0].body.consumed);
	assert_eq!(captures[0].frames[0].redaction, Bytes::from_static(b"<redacted>"));
	assert_eq!(captures, service.captures());
}

#[tokio::test]
async fn request_body_capture_is_disabled_by_default() {
	let mut service = CassetteTransport::new(Arc::from([attempt(
		CassetteBodyAction::Drain,
		CassetteTerminal::Complete,
		1,
	)]));
	service.ready().await.expect("cassette ready");
	let response = service
		.call(request(
			BodySource::Bytes(Bytes::from_static(b"sensitive-request")),
			EmitDecoder,
			Cancellation::default(),
		))
		.await
		.expect("handshake");
	drop(response.events.expect("ordinary event stream"));

	let captures = service.captures();
	assert_eq!(captures.len(), 1);
	assert_eq!(captures[0].request_body, None);
}

#[tokio::test]
async fn drain_captures_exact_multi_chunk_request_body() {
	let factory = BodyFactoryHandle::new(|| {
		let body: ByteStream = Box::pin(stream::iter([
			Ok(Bytes::from_static(b"first-")),
			Ok(Bytes::from_static(b"second")),
		]));
		future::ready(Ok(body))
	});
	let mut service = CassetteTransport::new(Arc::from([attempt(
		CassetteBodyAction::Drain,
		CassetteTerminal::Complete,
		1,
	)]))
	.with_request_body_capture(NonZeroUsize::new(64).expect("nonzero capture bound"));
	service.ready().await.expect("cassette ready");
	let response = service
		.call(request(BodySource::Factory(factory), EmitDecoder, Cancellation::default()))
		.await
		.expect("handshake");
	drop(response.events.expect("ordinary event stream"));

	assert_eq!(
		service.captures()[0].request_body,
		Some(CapturedRequestBody {
			bytes:          Bytes::from_static(b"first-second"),
			observed_bytes: 12,
			truncated:      false,
		})
	);
}

#[tokio::test]
async fn bounded_request_body_capture_reports_observed_bytes_and_truncation() {
	let factory = BodyFactoryHandle::new(|| {
		let body: ByteStream =
			Box::pin(stream::iter([Ok(Bytes::from_static(b"ab")), Ok(Bytes::from_static(b"cdef"))]));
		future::ready(Ok(body))
	});
	let mut service = CassetteTransport::new(Arc::from([attempt(
		CassetteBodyAction::Drain,
		CassetteTerminal::Complete,
		1,
	)]))
	.with_request_body_capture(NonZeroUsize::new(3).expect("nonzero capture bound"));
	service.ready().await.expect("cassette ready");
	let response = service
		.call(request(BodySource::Factory(factory), EmitDecoder, Cancellation::default()))
		.await
		.expect("handshake");
	drop(response.events.expect("ordinary event stream"));

	assert_eq!(
		service.captures()[0].request_body,
		Some(CapturedRequestBody {
			bytes:          Bytes::from_static(b"abc"),
			observed_bytes: 6,
			truncated:      true,
		})
	);
}

#[tokio::test]
async fn request_body_capture_finalizes_on_stream_error() {
	let factory = BodyFactoryHandle::new(|| {
		let error = Error::new(
			ErrorKind::Connectivity,
			ErrorPhase::Streaming,
			RetryAction::Never,
			ExecutionReceipt::default(),
		);
		let body: ByteStream =
			Box::pin(stream::iter([Ok(Bytes::from_static(b"prefix")), Err(error)]));
		future::ready(Ok(body))
	});
	let mut service = CassetteTransport::new(Arc::from([attempt(
		CassetteBodyAction::Drain,
		CassetteTerminal::Complete,
		1,
	)]))
	.with_request_body_capture(NonZeroUsize::new(4).expect("nonzero capture bound"));
	service.ready().await.expect("cassette ready");
	let error = service
		.call(request(BodySource::Factory(factory), EmitDecoder, Cancellation::default()))
		.await
		.err()
		.expect("body stream failure");
	assert_eq!(error.kind, ErrorKind::Connectivity);
	assert_eq!(error.action, RetryAction::Never);
	assert_eq!(
		service.captures()[0].request_body,
		Some(CapturedRequestBody {
			bytes:          Bytes::from_static(b"pref"),
			observed_bytes: 6,
			truncated:      true,
		})
	);
}

#[tokio::test]
async fn request_body_capture_finalizes_when_in_flight_attempt_is_dropped() {
	let factory = BodyFactoryHandle::new(|| {
		let body: ByteStream = Box::pin(
			stream::once(future::ready(Ok(Bytes::from_static(b"observed"))))
				.chain(stream::pending::<Result<Bytes, Error>>()),
		);
		future::ready(Ok(body))
	});
	let mut service = CassetteTransport::new(Arc::from([attempt(
		CassetteBodyAction::Drain,
		CassetteTerminal::Complete,
		1,
	)]))
	.with_request_body_capture(NonZeroUsize::new(32).expect("nonzero capture bound"));
	service.ready().await.expect("cassette ready");
	let mut pending = Box::pin(service.call(request(
		BodySource::Factory(factory),
		EmitDecoder,
		Cancellation::default(),
	)));
	assert!(pending.as_mut().now_or_never().is_none());
	drop(pending);

	assert_eq!(
		service.captures()[0].request_body,
		Some(CapturedRequestBody {
			bytes:          Bytes::from_static(b"observed"),
			observed_bytes: 8,
			truncated:      false,
		})
	);
}

#[tokio::test]
async fn replayable_factory_opens_a_fresh_body_for_every_attempt() {
	let opens = Arc::new(AtomicUsize::new(0));
	let factory_opens = Arc::clone(&opens);
	let factory = BodyFactoryHandle::new(move || {
		factory_opens.fetch_add(1, Ordering::SeqCst);
		let body: ByteStream =
			Box::pin(stream::iter([Ok(Bytes::from_static(b"a")), Ok(Bytes::from_static(b"b"))]));
		future::ready(Ok(body))
	});
	let source = BodySource::Factory(factory);
	let attempts: Arc<[CassetteAttempt]> = Arc::from([
		attempt(CassetteBodyAction::PollChunks(1), CassetteTerminal::Complete, 1),
		attempt(CassetteBodyAction::Drain, CassetteTerminal::Complete, 1),
	]);
	let mut service = CassetteTransport::new(attempts)
		.with_request_body_capture(NonZeroUsize::new(16).expect("nonzero capture bound"));
	for index in 0..2 {
		service.ready().await.expect("cassette ready");
		let mut request = request(source.clone(), EmitDecoder, Cancellation::default());
		request.attempt.index = index;
		let response = service.call(request).await.expect("handshake");
		drop(response.events.expect("ordinary event stream"));
	}
	assert_eq!(opens.load(Ordering::SeqCst), 2);
	let captures = service.captures();
	assert_eq!(captures.len(), 2);
	assert_eq!(
		captures[0].request_body,
		Some(CapturedRequestBody {
			bytes:          Bytes::from_static(b"a"),
			observed_bytes: 1,
			truncated:      false,
		})
	);
	assert_eq!(
		captures[1].request_body,
		Some(CapturedRequestBody {
			bytes:          Bytes::from_static(b"ab"),
			observed_bytes: 2,
			truncated:      false,
		})
	);
}

#[tokio::test]
async fn factory_error_is_preserved_and_captured_with_exact_evidence() {
	let expected = {
		Error::new(
			ErrorKind::InvalidRequest,
			ErrorPhase::Encoding,
			RetryAction::Never,
			ExecutionReceipt::default(),
		)
		.detail(ErrorDetail::protocol(ReasonId(sf!("factory-terminal"))))
	};
	let factory = BodyFactoryHandle::new(move || {
		let error = expected.clone();
		async move { Err::<ByteStream, Error>(error) }
	});
	let mut service = CassetteTransport::new(Arc::from([attempt(
		CassetteBodyAction::Opened,
		CassetteTerminal::Complete,
		1,
	)]))
	.with_request_body_capture(NonZeroUsize::new(8).expect("nonzero capture bound"));
	service.ready().await.expect("cassette ready");
	let error = service
		.call(request(BodySource::Factory(factory), EmitDecoder, Cancellation::default()))
		.await
		.err()
		.expect("factory failure");
	assert_eq!(error.kind, ErrorKind::InvalidRequest);
	assert_eq!(error.action, RetryAction::Never);
	assert_eq!(error.phase, ErrorPhase::Encoding);
	assert!(matches!(error.detail_ref(), Some(ErrorDetail::Protocol { .. })));
	let captures = service.captures();
	assert_eq!(captures.len(), 1);
	assert!(!captures[0].body.opened);
	assert_eq!(
		captures[0].request_body,
		Some(CapturedRequestBody {
			bytes:          Bytes::new(),
			observed_bytes: 0,
			truncated:      false,
		})
	);
}

#[tokio::test]
async fn retryable_factory_error_keeps_its_retry_action() {
	let factory = BodyFactoryHandle::new(move || async move {
		Err::<ByteStream, Error>(Error::new(
			ErrorKind::Connectivity,
			ErrorPhase::Connecting,
			RetryAction::SameRoute { after: time::Duration::from_millis(7) },
			ExecutionReceipt::default(),
		))
	});
	let mut service = CassetteTransport::new(Arc::from([attempt(
		CassetteBodyAction::Opened,
		CassetteTerminal::Complete,
		1,
	)]));
	service.ready().await.expect("cassette ready");
	let error = service
		.call(request(BodySource::Factory(factory), EmitDecoder, Cancellation::default()))
		.await
		.err()
		.expect("factory failure");
	assert_eq!(error.kind, ErrorKind::Connectivity);
	assert_eq!(error.action, RetryAction::SameRoute { after: std::time::Duration::from_millis(7) });
	assert_eq!(service.captures().len(), 1);
}

#[tokio::test]
async fn every_precommit_terminal_path_appends_one_capture() {
	let cases = [
		(attempt(CassetteBodyAction::Unopened, CassetteTerminal::Complete, 0), false),
		(attempt(CassetteBodyAction::Unopened, CassetteTerminal::Disconnect, 0), false),
		(attempt(CassetteBodyAction::Unopened, CassetteTerminal::Complete, 1), true),
	];
	for (script, decoder_fails) in cases {
		let mut service = CassetteTransport::new(Arc::from([script]));
		service.ready().await.expect("cassette ready");
		let result = if decoder_fails {
			service
				.call(request(BodySource::Bytes(Bytes::new()), FailDecoder, Cancellation::default()))
				.await
		} else {
			service
				.call(request(BodySource::Bytes(Bytes::new()), EmitDecoder, Cancellation::default()))
				.await
		};
		assert!(result.is_err());
		assert_eq!(service.captures().len(), 1);
	}

	let cancel = Cancellation::default();
	cancel.cancel();
	let mut service = CassetteTransport::new(Arc::from([attempt(
		CassetteBodyAction::Unopened,
		CassetteTerminal::Complete,
		1,
	)]));
	service.ready().await.expect("cassette ready");
	assert!(
		service
			.call(request(BodySource::Bytes(Bytes::new()), EmitDecoder, cancel))
			.await
			.is_err()
	);
	assert_eq!(service.captures().len(), 1);
}

#[tokio::test]
async fn metadata_then_disconnect_remains_precommit_retryable() {
	let mut service = CassetteTransport::new(Arc::from([attempt(
		CassetteBodyAction::Drain,
		CassetteTerminal::Disconnect,
		1,
	)]));
	service.ready().await.expect("cassette ready");
	let error = service
		.call(request(
			BodySource::Bytes(Bytes::from_static(b"request")),
			MetadataOnlyDecoder,
			Cancellation::default(),
		))
		.await
		.err()
		.expect("metadata does not commit");
	assert!(!error.committed);
	assert!(matches!(error.action, RetryAction::SameRoute { .. }));
}

#[tokio::test]
async fn provider_state_then_expiry_preserves_reseed_action() {
	let mut service = CassetteTransport::new(Arc::from([attempt(
		CassetteBodyAction::Unopened,
		CassetteTerminal::Complete,
		1,
	)]));
	service.ready().await.expect("cassette ready");
	let error = service
		.call(request(
			BodySource::Bytes(Bytes::new()),
			StateThenExpiredDecoder,
			Cancellation::default(),
		))
		.await
		.err()
		.expect("state is private preamble");
	assert!(!error.committed);
	assert_eq!(error.kind, ErrorKind::SessionExpired);
	assert_eq!(error.action, RetryAction::ReseedSession);
}

#[tokio::test]
async fn metadata_before_visible_event_is_returned_in_order() {
	let mut service = CassetteTransport::new(Arc::from([attempt(
		CassetteBodyAction::Unopened,
		CassetteTerminal::Complete,
		1,
	)]));
	service.ready().await.expect("cassette ready");
	let response = service
		.call(request(
			BodySource::Bytes(Bytes::new()),
			PreambleThenVisibleDecoder,
			Cancellation::default(),
		))
		.await
		.expect("visible commit candidate");
	let events: Vec<_> = response
		.events
		.expect("ordinary event stream")
		.collect()
		.await;
	assert!(matches!(events.first(), Some(Ok(RawEvent::Metadata(_)))));
	assert!(matches!(events.get(1), Some(Ok(RawEvent::Chat(_)))));
}

#[tokio::test]
async fn consumed_one_shot_preamble_failure_suppresses_retry_evidence() {
	let one_shot = Arc::new(OneShotBody::new(Box::pin(stream::once(future::ready(Ok(
		Bytes::from_static(b"live"),
	))))));
	let mut service = CassetteTransport::new(Arc::from([attempt(
		CassetteBodyAction::PollChunks(1),
		CassetteTerminal::Disconnect,
		1,
	)]));
	service.ready().await.expect("cassette ready");
	let error = service
		.call(request(BodySource::OneShot(one_shot), MetadataOnlyDecoder, Cancellation::default()))
		.await
		.err()
		.expect("metadata then disconnect");
	let body = error
		.receipt()
		.attempts
		.last()
		.expect("attempt receipt")
		.body;
	assert_eq!(body.retry_decision, RetryDecision::Suppress);
	assert_eq!(body.reason, RetryDecisionReason::ConsumedOneShot);
}

#[tokio::test]
async fn completion_only_response_completes_transport_handshake() {
	let mut service = CassetteTransport::new(Arc::from([attempt(
		CassetteBodyAction::Unopened,
		CassetteTerminal::Complete,
		1,
	)]));
	service.ready().await.expect("cassette ready");
	let response = service
		.call(request(
			BodySource::Bytes(Bytes::new()),
			CompletionOnlyDecoder,
			Cancellation::default(),
		))
		.await
		.expect("completion is a terminal success candidate");
	let events: Vec<_> = response
		.events
		.expect("ordinary event stream")
		.collect()
		.await;
	assert!(matches!(events.first(), Some(Ok(RawEvent::Completion(_)))));
}

#[tokio::test]
async fn private_preamble_stall_times_out_precommit() {
	let mut service = CassetteTransport::new(Arc::from([attempt(
		CassetteBodyAction::Unopened,
		CassetteTerminal::Stall,
		1,
	)]));
	service.ready().await.expect("cassette ready");
	let mut call =
		request(BodySource::Bytes(Bytes::new()), MetadataOnlyDecoder, Cancellation::default());
	call.attempt.timeout = time::Duration::from_millis(5);
	let error = service
		.call(call)
		.await
		.err()
		.expect("preamble stall timeout");
	assert_eq!(error.kind, ErrorKind::DeadlineExceeded);
	assert!(!error.committed);
}

#[tokio::test]
async fn postcommit_stall_times_out_as_partial() {
	let mut service = CassetteTransport::new(Arc::from([attempt(
		CassetteBodyAction::Unopened,
		CassetteTerminal::Stall,
		1,
	)]));
	service.ready().await.expect("cassette ready");
	let mut call = request(BodySource::Bytes(Bytes::new()), EmitDecoder, Cancellation::default());
	call.attempt.timeout = time::Duration::from_millis(5);
	let response = service.call(call).await.expect("visible event commits");
	let mut events = response.events.expect("ordinary event stream");
	assert!(matches!(events.next().await, Some(Ok(RawEvent::Chat(_)))));
	let Err(error) = events.next().await.expect("deadline error") else {
		panic!("stalled committed stream must time out");
	};
	assert_eq!(error.kind, ErrorKind::DeadlineExceeded);
	assert!(error.committed);
}

#[tokio::test]
async fn stalled_body_preserves_factory_replay_and_suppresses_consumed_one_shot() {
	let factory =
		BodyFactoryHandle::new(|| async { Ok::<ByteStream, Error>(Box::pin(stream::pending())) });
	let mut replayable = CassetteTransport::new(Arc::from([attempt(
		CassetteBodyAction::PollChunks(1),
		CassetteTerminal::Complete,
		1,
	)]));
	replayable.ready().await.expect("cassette ready");
	let mut call = request(BodySource::Factory(factory), EmitDecoder, Cancellation::default());
	call.attempt.timeout = time::Duration::from_millis(5);
	let error = replayable.call(call).await.err().expect("body timeout");
	let body = error
		.receipt()
		.attempts
		.last()
		.expect("attempt receipt")
		.body;
	assert_eq!(body.retry_decision, RetryDecision::Allow);

	let one_shot = Arc::new(OneShotBody::new(Box::pin(stream::pending())));
	let mut consumed = CassetteTransport::new(Arc::from([attempt(
		CassetteBodyAction::PollChunks(1),
		CassetteTerminal::Complete,
		1,
	)]))
	.with_request_body_capture(NonZeroUsize::new(8).expect("nonzero capture bound"));
	consumed.ready().await.expect("cassette ready");
	let mut call = request(BodySource::OneShot(one_shot), EmitDecoder, Cancellation::default());
	call.attempt.timeout = time::Duration::from_millis(5);
	let error = consumed.call(call).await.err().expect("body timeout");
	let body = error
		.receipt()
		.attempts
		.last()
		.expect("attempt receipt")
		.body;
	assert_eq!(body.retry_decision, RetryDecision::Suppress);
	assert_eq!(body.reason, RetryDecisionReason::ConsumedOneShot);
	assert_eq!(
		consumed.captures()[0].request_body,
		Some(CapturedRequestBody {
			bytes:          Bytes::new(),
			observed_bytes: 0,
			truncated:      false,
		})
	);
}

struct RealtimeEchoCodec;

impl RealtimeWireCodec for RealtimeEchoCodec {
	fn initial_frames(&mut self) -> Result<RealtimeWireFrames, Error> {
		let mut frames = RealtimeWireFrames::new();
		frames.push(Bytes::from_static(b"session"));
		Ok(frames)
	}

	fn encode(&mut self, _input: RealtimeInput) -> Result<RealtimeWireFrames, Error> {
		Ok(RealtimeWireFrames::new())
	}

	fn decode(&mut self, _payload: Bytes) -> Result<RealtimeEvents, Error> {
		let mut events = RealtimeEvents::new();
		events.push(RealtimeEvent::InputCommitted);
		Ok(events)
	}
}

#[tokio::test]
async fn cassette_transfers_owned_realtime_session_only_after_first_frame() {
	let mut service = CassetteTransport::new(Arc::from([attempt(
		CassetteBodyAction::Drain,
		CassetteTerminal::Complete,
		1,
	)]))
	.with_request_body_capture(NonZeroUsize::new(32).expect("nonzero capture bound"));
	service.ready().await.expect("cassette ready");
	let mut call = request(
		BodySource::Bytes(Bytes::from_static(b"realtime-body")),
		EmitDecoder,
		Cancellation::default(),
	);
	call.encoded.operation = OperationKind::Realtime;
	call.encoded.framing = FramingProtocol::WebSocket;
	call.decoder = None;
	call.realtime = Some(Box::new(RealtimeEchoCodec));
	let response = service.call(call).await.expect("realtime handshake");
	assert!(response.events.is_none());
	assert!(response.realtime.is_some());
	assert_eq!(
		service.captures()[0].request_body,
		Some(CapturedRequestBody {
			bytes:          Bytes::from_static(b"realtime-body"),
			observed_bytes: 13,
			truncated:      false,
		})
	);
}
#[tokio::test]
async fn openai_realtime_cassette_preserves_normal_response_through_done() {
	let provider_frames = [
		br#"{"type":"session.created"}"#.as_slice(),
		br#"{"type":"session.updated"}"#,
		br#"{"type":"input_audio_buffer.committed"}"#,
		br#"{"type":"response.created"}"#,
		br#"{"type":"response.output_item.added","output_index":0,"item":{"type":"message"}}"#,
		br#"{"type":"response.content_part.added","item_id":"item_1","output_index":0,"part":{"type":"text"}}"#,
		br#"{"type":"response.text.delta","item_id":"item_1","output_index":0,"delta":"hi"}"#,
		br#"{"type":"response.text.done"}"#,
		br#"{"type":"response.content_part.done"}"#,
		br#"{"type":"response.output_item.done"}"#,
		br#"{"type":"rate_limits.updated","rate_limits":[]}"#,
		br#"{"type":"response.done"}"#,
	];
	let scripted = CassetteAttempt {
		status:              Some(101),
		headers:             Box::new([]),
		provider_request_id: Some(sf!("realtime-request")),
		body:                CassetteBodyAction::Unopened,
		frames:              provider_frames
			.into_iter()
			.map(|payload| Frame::Raw(Bytes::copy_from_slice(payload)))
			.collect::<Vec<_>>()
			.into_boxed_slice(),
		terminal:            CassetteTerminal::Complete,
	};
	let codec = OpenAiRealtimeWireCodec::new(RealtimeRequest {
		instructions:   None,
		modalities:     Arc::from([RealtimeModality::Text]),
		voice:          None,
		input_audio:    Setting::Unset,
		output_audio:   Setting::Unset,
		turn_detection: Setting::Unset,
		tools:          Arc::from([]),
		negotiation:    NegotiationPolicy::default(),
	});
	let mut service = CassetteTransport::new(Arc::from([scripted]));
	service.ready().await.expect("cassette ready");
	let mut call = request(BodySource::Bytes(Bytes::new()), EmitDecoder, Cancellation::default());
	call.encoded.operation = OperationKind::Realtime;
	call.encoded.framing = FramingProtocol::WebSocket;
	call.decoder = None;
	call.realtime = Some(Box::new(codec));
	let response = service.call(call).await.expect("full realtime handshake");
	let session = response.realtime.expect("owned realtime session");
	let mut events = Vec::new();
	for _ in 0..5 {
		events.push(
			session
				.inbound
				.recv_async()
				.await
				.expect("realtime event")
				.expect("successful realtime event"),
		);
	}
	assert!(matches!(events[0], RealtimeEvent::Ready));
	assert!(matches!(events[1], RealtimeEvent::InputCommitted));
	assert!(matches!(
		events[2],
		RealtimeEvent::Chat(ChatEvent::BlockStarted { index: 0, kind: BlockKind::Text })
	));
	assert!(
		matches!(&events[3], RealtimeEvent::Chat(ChatEvent::TextDelta { index: 0, text }) if text.as_str() == "hi")
	);
	assert!(matches!(events[4], RealtimeEvent::Chat(ChatEvent::Completed(_))));
}

#[tokio::test]
async fn websocket_upgrade_sends_initial_frame_before_first_decodable_event() {
	let listener = TcpListener::bind("127.0.0.1:0")
		.await
		.expect("bind websocket fixture");
	let address = listener.local_addr().expect("websocket fixture address");
	let server = tokio::spawn(async move {
		let (socket, _) = listener.accept().await.expect("accept websocket fixture");
		let mut socket = tokio_tungstenite::accept_async(socket)
			.await
			.expect("upgrade websocket fixture");
		let initial = socket
			.next()
			.await
			.expect("initial websocket frame")
			.expect("valid websocket frame");
		assert_eq!(initial.into_data(), Bytes::from_static(b"session"));
		use futures::SinkExt as _;
		socket
			.send(tungstenite::Message::text("provider-ready"))
			.await
			.expect("send provider frame");
	});
	let mut service = WebSocketTransport::new();
	service.ready().await.expect("websocket ready");
	let mut call = request(BodySource::Bytes(Bytes::new()), EmitDecoder, Cancellation::default());
	call.encoded.operation = OperationKind::Realtime;
	call.encoded.framing = FramingProtocol::WebSocket;
	call.encoded.uri = sf!("ws://{address}/realtime");
	call.decoder = None;
	call.realtime = Some(Box::new(RealtimeEchoCodec));
	let response = service.call(call).await.expect("websocket handshake");
	let session = response.realtime.expect("owned realtime session");
	assert!(matches!(session.inbound.recv_async().await, Ok(Ok(RealtimeEvent::Ready))));
	assert!(matches!(session.inbound.recv_async().await, Ok(Ok(RealtimeEvent::InputCommitted))));
	server.await.expect("websocket fixture");
	let captures = service.captures();
	assert_eq!(captures.len(), 1);
	assert_eq!(captures[0].frames.len(), 1);
	assert_eq!(captures[0].frames[0].redaction, Bytes::from_static(b"<redacted>"));
}

#[tokio::test]
async fn stream_first_event_timeout_ms_matches_pi_behavior() {
	let listener = TcpListener::bind("127.0.0.1:0")
		.await
		.expect("bind fixture");
	let address = listener.local_addr().expect("fixture address");
	let server = tokio::spawn(async move {
		let (mut socket, _) = listener.accept().await.expect("accept fixture");
		let mut request = [0_u8; 1024];
		let _ = socket.read(&mut request).await.expect("read request");
		socket
			.write_all(
				b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ntransfer-encoding: chunked\r\n\r\n",
			)
			.await
			.expect("write headers");
		future::pending::<()>().await;
	});
	let mut service = HttpTransport::new();
	service.ready().await.expect("http ready");
	let mut call = request(
		BodySource::Bytes(Bytes::from_static(b"request")),
		EmitDecoder,
		Cancellation::default(),
	);
	call.encoded.uri = sf!("http://{address}/stall");
	call.attempt.timeout = time::Duration::from_secs(5);
	call.attempt.first_event_timeout = Some(time::Duration::from_millis(10));
	let error = service.call(call).await.err().expect("first-event timeout");
	assert_eq!(error.kind, ErrorKind::DeadlineExceeded);
	assert_eq!(error.phase, ErrorPhase::Handshake);
	assert!(!error.committed);
	assert_eq!(error.receipt().attempts.len(), 1);
	// The watchdog is a typed local timeout naming the awaited milestone and
	// the time spent; it never masquerades as a wire protocol violation.
	let Some(ErrorDetail::Timeout { scope, elapsed_ms }) = error.detail_ref() else {
		panic!("watchdog must surface a typed timeout, got {:?}", error.detail_ref());
	};
	assert_eq!(scope.0.as_str(), "stream.first-event-timeout");
	assert!(*elapsed_ms >= 10, "elapsed {elapsed_ms} ms must cover the 10 ms watchdog");
	let rendered = error.to_string();
	assert!(rendered.contains("timed out after"), "{rendered}");
	assert!(!rendered.contains("protocol violation"), "{rendered}");
	server.abort();
}

#[tokio::test]
async fn anthropic_stream_closed_before_output_is_precommit_retryable_with_elapsed_evidence() {
	// Anthropic answered 200, sent `message_start` and keep-alive pings, then
	// closed the chunked body cleanly without `message_stop`. Nothing reached
	// the caller: the failure must be pre-commit, replayable on the same
	// route, and carry how long the body lived and how many frames it had.
	let listener = TcpListener::bind("127.0.0.1:0")
		.await
		.expect("bind fixture");
	let address = listener.local_addr().expect("fixture address");
	let server = tokio::spawn(async move {
		let (mut socket, _) = listener.accept().await.expect("accept fixture");
		let mut request = [0_u8; 4096];
		let _ = socket.read(&mut request).await.expect("read request");
		socket
			.write_all(
				b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ntransfer-encoding: chunked\r\n\r\n",
			)
			.await
			.expect("write headers");
		for frame in [
			&b"event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_1\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"claude-opus-5\",\"content\":[],\"stop_reason\":null,\"usage\":{\"input_tokens\":22029,\"output_tokens\":1}}}\n\n"[..],
			&b"event: ping\ndata: {\"type\":\"ping\"}\n\n"[..],
			&b"event: ping\ndata: {\"type\":\"ping\"}\n\n"[..],
		] {
			socket
				.write_all(format!("{:x}\r\n", frame.len()).as_bytes())
				.await
				.expect("write chunk size");
			socket.write_all(frame).await.expect("write chunk");
			socket.write_all(b"\r\n").await.expect("write chunk end");
			time::sleep(time::Duration::from_millis(5)).await;
		}
		socket
			.write_all(b"0\r\n\r\n")
			.await
			.expect("write terminating chunk");
		socket.shutdown().await.expect("close fixture");
	});
	let mut service = HttpTransport::new();
	service.ready().await.expect("http ready");
	let mut call = request(
		BodySource::Bytes(Bytes::from_static(b"request")),
		crate::codec::anthropic::AnthropicWireDecoder::direct(),
		Cancellation::default(),
	);
	call.encoded.uri = sf!("http://{address}/v1/messages");
	call.encoded.framing = FramingProtocol::Sse;
	call.encoded.bounds =
		SizeBounds { request_body: 1024, frame: 65_536, response: 65_536 };
	let error = service
		.call(call)
		.await
		.err()
		.expect("closed before output");
	assert_eq!(error.kind, ErrorKind::StreamCorruption);
	assert_eq!(error.phase, ErrorPhase::Handshake);
	assert_eq!(error.status, Some(200));
	assert!(!error.committed, "no output reached the caller");
	assert!(
		matches!(error.action, RetryAction::SameRoute { .. }),
		"pre-output truncation must replay on the same route, got {:?}",
		error.action
	);
	let Some(ErrorDetail::StreamEnded { reason, elapsed_ms, frames }) = error.detail_ref() else {
		panic!("body end must carry stream-end evidence, got {:?}", error.detail_ref());
	};
	assert_eq!(reason.0.as_str(), "anthropic.sse.truncated_before_output");
	assert_eq!(*frames, 3, "message_start plus two pings were decoded");
	assert!(*elapsed_ms >= 10, "elapsed {elapsed_ms} ms must span the paced fixture");
	let rendered = error.to_string();
	assert!(rendered.contains("stream ended after"), "{rendered}");
	assert!(rendered.contains("3 frame(s)"), "{rendered}");
	assert!(!rendered.contains("protocol violation"), "{rendered}");
	let receipt = error.receipt().attempts.last().expect("attempt receipt");
	assert_eq!(receipt.outcome, AttemptOutcome::FailedPreCommit);
	server.await.expect("fixture server");
}

/// Anthropic honours the Claude Code profile's `accept-encoding` and gzips the
/// SSE stream. The transport must decode it before framing; the undecoded
/// body previously read as `truncated_before_output` and was silently retried
/// for minutes (owner's `omp chat` stall).
#[tokio::test]
async fn gzip_encoded_anthropic_stream_decodes_to_a_completion() {
	use std::io::Write as _;
	let listener = TcpListener::bind("127.0.0.1:0")
		.await
		.expect("bind fixture");
	let address = listener.local_addr().expect("fixture address");
	let body = b"event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_1\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"claude-opus-5\",\"content\":[],\"stop_reason\":null,\"usage\":{\"input_tokens\":10,\"output_tokens\":1}}}\n\nevent: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\nevent: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"pong\"}}\n\nevent: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\nevent: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":2}}\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n";
	let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
	encoder.write_all(body).expect("gzip body");
	let wire = encoder.finish().expect("finish gzip");
	let server = tokio::spawn(async move {
		let (mut socket, _) = listener.accept().await.expect("accept fixture");
		let mut request = [0_u8; 4096];
		let _ = socket.read(&mut request).await.expect("read request");
		socket
			.write_all(
				b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-encoding: gzip\r\ntransfer-encoding: chunked\r\n\r\n",
			)
			.await
			.expect("write headers");
		// Split the compressed bytes mid-member so the decoder must buffer state
		// across chunks exactly like a paced provider stream.
		for chunk in wire.chunks(7) {
			socket
				.write_all(format!("{:x}\r\n", chunk.len()).as_bytes())
				.await
				.expect("write chunk size");
			socket.write_all(chunk).await.expect("write chunk");
			socket.write_all(b"\r\n").await.expect("write chunk end");
		}
		socket
			.write_all(b"0\r\n\r\n")
			.await
			.expect("write terminating chunk");
		socket.shutdown().await.expect("close fixture");
	});
	let mut service = HttpTransport::new();
	service.ready().await.expect("http ready");
	let mut call = request(
		BodySource::Bytes(Bytes::from_static(b"request")),
		crate::codec::anthropic::AnthropicWireDecoder::direct(),
		Cancellation::default(),
	);
	call.encoded.uri = sf!("http://{address}/v1/messages");
	call.encoded.framing = FramingProtocol::Sse;
	call.encoded.bounds =
		SizeBounds { request_body: 1024, frame: 65_536, response: 65_536 };
	let response = service.call(call).await.expect("gzip stream handshakes");
	let mut events = response.events.expect("ordinary event stream");
	let mut text = String::new();
	let mut completed = false;
	while let Some(event) = events.next().await {
		match event.expect("decoded event") {
			RawEvent::Chat(ChatEvent::TextDelta { text: delta, .. }) => text.push_str(&delta),
			RawEvent::Completion(completion) => {
				assert_eq!(completion.reason, FinishReason::Stop);
				completed = true;
			},
			_ => {},
		}
	}
	assert_eq!(text, "pong");
	assert!(completed, "message_stop must complete the decoded stream");
	server.await.expect("fixture server");
}

#[tokio::test]
async fn unsupported_content_encoding_fails_closed_without_retry() {
	let listener = TcpListener::bind("127.0.0.1:0")
		.await
		.expect("bind fixture");
	let address = listener.local_addr().expect("fixture address");
	let server = tokio::spawn(async move {
		let (mut socket, _) = listener.accept().await.expect("accept fixture");
		let mut request = [0_u8; 4096];
		let _ = socket.read(&mut request).await.expect("read request");
		socket
			.write_all(
				b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-encoding: compress\r\ncontent-length: 0\r\n\r\n",
			)
			.await
			.expect("write headers");
		socket.shutdown().await.expect("close fixture");
	});
	let mut service = HttpTransport::new();
	service.ready().await.expect("http ready");
	let mut call = request(
		BodySource::Bytes(Bytes::from_static(b"request")),
		EmitDecoder,
		Cancellation::default(),
	);
	call.encoded.uri = sf!("http://{address}/v1/messages");
	let error = service
		.call(call)
		.await
		.err()
		.expect("unsupported encoding fails");
	assert_eq!(error.kind, ErrorKind::Protocol);
	assert_eq!(error.phase, ErrorPhase::Handshake);
	assert_eq!(error.action, RetryAction::Never);
	assert!(!error.committed);
	server.await.expect("fixture server");
}

#[tokio::test]
async fn stalled_http_connect_or_headers_honors_attempt_timeout() {
	let listener = TcpListener::bind("127.0.0.1:0")
		.await
		.expect("bind fixture");
	let address = listener.local_addr().expect("fixture address");
	let server = tokio::spawn(async move {
		let (_socket, _) = listener.accept().await.expect("accept fixture");
		future::pending::<()>().await;
	});
	let mut service = HttpTransport::new();
	service.ready().await.expect("http ready");
	let mut call = request(
		BodySource::Bytes(Bytes::from_static(b"request")),
		EmitDecoder,
		Cancellation::default(),
	);
	call.encoded.uri = sf!("http://{address}/stall");
	call.attempt.timeout = time::Duration::from_millis(10);
	let error = service.call(call).await.err().expect("headers timeout");
	assert_eq!(error.kind, ErrorKind::DeadlineExceeded);
	assert!(!error.committed);
	assert_eq!(error.receipt().attempts.len(), 1);
	server.abort();
}

#[tokio::test]
async fn stalled_http_headers_honor_in_flight_cancellation() {
	let listener = TcpListener::bind("127.0.0.1:0")
		.await
		.expect("bind fixture");
	let address = listener.local_addr().expect("fixture address");
	let (accepted_tx, accepted_rx) = oneshot::channel();
	let server = tokio::spawn(async move {
		let (_socket, _) = listener.accept().await.expect("accept fixture");
		let _ = accepted_tx.send(());
		future::pending::<()>().await;
	});
	let mut service = HttpTransport::new();
	service.ready().await.expect("http ready");
	let cancellation = Cancellation::default();
	let mut call =
		request(BodySource::Bytes(Bytes::from_static(b"request")), EmitDecoder, cancellation.clone());
	call.encoded.uri = sf!("http://{address}/stall");
	call.attempt.timeout = time::Duration::from_secs(5);
	let response = service.call(call);
	tokio::pin!(response);
	tokio::select! {
		_ = &mut response => panic!("request ended before cancellation"),
		result = accepted_rx => result.expect("fixture accepted request"),
	}
	cancellation.cancel();
	let error = time::timeout(time::Duration::from_secs(1), response)
		.await
		.expect("cancellation bound")
		.err()
		.expect("cancelled request");
	assert_eq!(error.kind, ErrorKind::Cancelled);
	assert!(!error.committed);
	assert_eq!(error.receipt().attempts.len(), 1);
	server.abort();
}
