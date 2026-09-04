//! Production owned bidirectional WebSocket transport over rustls.

use std::{
	future::Future,
	mem,
	pin::Pin,
	str,
	sync::{
		Arc,
		atomic::{AtomicBool, Ordering},
	},
	task::{Context, Poll},
};

use bytes::{Bytes, BytesMut};
use futures::{SinkExt as _, StreamExt as _, future::poll_fn};
use http::{HeaderName, HeaderValue, Request, header};
use omp_core::Str;
use parking_lot::Mutex;
use tokio::time::Instant;
use tokio_tungstenite::{
	connect_async,
	tungstenite::{Message, client::IntoClientRequest as _},
};
use tower::Service;

use crate::{
	answer::{RealtimeEvent, RealtimeInput, RealtimeSession},
	body::{AttemptBodyEvidence, AttemptEvidenceHandle, BodyOpenError},
	codec::{
		Cancellation, HandshakeMeta, HandshakenResponse, RawEvent, RawEventStream, TransportAttempt,
		TransportRequest,
	},
	error::{Error, ErrorDetail, ErrorKind, ErrorPhase, RetryAction},
	receipt::{ExecutionReceipt, ReasonId},
	transport::{
		Frame, FramingProtocol, WebSocketMessage,
		cassette::{CapturedFrame, capture_frame, is_commit_candidate},
		http::{emit_provider_response, record_failure, request_id, sanitize_headers},
	},
};

const CHANNEL_CAPACITY: usize = 16;

/// Sanitized bounded evidence retained from a live WebSocket attempt.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WebSocketCapture {
	/// Zero-based attempt index.
	pub attempt:             u32,
	/// Upgrade status.
	pub status:              u16,
	/// Sanitized provider request identifier.
	pub provider_request_id: Option<Str>,
	/// Exact request-body consumption evidence.
	pub body:                AttemptBodyEvidence,
	/// Bounded redacted provider data frames.
	pub frames:              Vec<CapturedFrame>,
}

struct LiveCapture {
	attempt:             u32,
	status:              u16,
	provider_request_id: Option<Str>,
	body:                AttemptEvidenceHandle,
	frames:              Vec<CapturedFrame>,
	remaining:           u64,
}

/// Production WebSocket transport transferring an owned bounded realtime
/// channel.
pub struct WebSocketTransport {
	ready_permit: bool,
	captures:     Arc<Mutex<Vec<Arc<Mutex<LiveCapture>>>>>,
}

impl Clone for WebSocketTransport {
	fn clone(&self) -> Self {
		Self { ready_permit: false, captures: Arc::clone(&self.captures) }
	}
}

impl Default for WebSocketTransport {
	fn default() -> Self {
		Self::new()
	}
}

impl WebSocketTransport {
	/// Creates a WebSocket transport using the workspace rustls connector.
	pub fn new() -> Self {
		Self { ready_permit: false, captures: Arc::new(Mutex::new(Vec::new())) }
	}

	/// Returns stable attempt-ordered sanitized capture snapshots.
	pub fn captures(&self) -> Vec<WebSocketCapture> {
		let mut captures = self
			.captures
			.lock()
			.iter()
			.map(|capture| {
				let capture = capture.lock();
				WebSocketCapture {
					attempt:             capture.attempt,
					status:              capture.status,
					provider_request_id: capture.provider_request_id.clone(),
					body:                capture.body.evidence(),
					frames:              capture.frames.clone(),
				}
			})
			.collect::<Vec<_>>();
		captures.sort_by_key(|capture| capture.attempt);
		captures
	}
}

impl Service<TransportRequest> for WebSocketTransport {
	type Error = Error;
	type Future = Pin<Box<dyn Future<Output = Result<Self::Response, Self::Error>> + Send>>;
	type Response = HandshakenResponse;

	fn poll_ready(&mut self, _context: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
		self.ready_permit = true;
		Poll::Ready(Ok(()))
	}

	fn call(&mut self, request: TransportRequest) -> Self::Future {
		let permit = mem::take(&mut self.ready_permit);
		let captures = Arc::clone(&self.captures);
		Box::pin(async move {
			if !permit {
				return Err(simple_error(
					ErrorKind::Protocol,
					ErrorPhase::Readiness,
					false,
					"websocket-call-without-readiness",
				));
			}
			execute(request, captures).await
		})
	}
}

async fn execute(
	mut request: TransportRequest,
	captures: Arc<Mutex<Vec<Arc<Mutex<LiveCapture>>>>>,
) -> Result<HandshakenResponse, Error> {
	let started = Instant::now();
	let attempt = request.attempt.clone();
	let deadline = Instant::now() + attempt.timeout;
	let mut body_attempt = request.encoded.body.begin_attempt();
	let evidence = body_attempt.evidence_handle();
	if request.encoded.framing != FramingProtocol::WebSocket
		|| !matches!(
			(request.decoder.is_some(), request.realtime.is_some()),
			(true, false) | (false, true)
		) {
		return Err(failure(
			simple_error(
				ErrorKind::Protocol,
				ErrorPhase::Handshake,
				false,
				"websocket-decoder-cardinality",
			),
			&request,
			&evidence,
			started,
			false,
		));
	}
	if request.cancel.is_cancelled() {
		return Err(failure(
			simple_error(ErrorKind::Cancelled, ErrorPhase::Handshake, false, "websocket-cancelled"),
			&request,
			&evidence,
			started,
			false,
		));
	}
	let mut reader = body_attempt
		.open()
		.await
		.map_err(|error| failure(body_error(error), &request, &evidence, started, false))?;
	let mut observed = 0_u64;
	let mut request_payload = BytesMut::new();
	while let Some(chunk) = tokio::select! {
		chunk = reader.next() => chunk,
		() = tokio::time::sleep_until(deadline) => {
			request.cancel.cancel();
			return Err(failure(simple_error(ErrorKind::DeadlineExceeded, ErrorPhase::Handshake, false, "websocket-body-timeout"), &request, &evidence, started, false));
		},
	} {
		let chunk = chunk.map_err(|error| failure(error, &request, &evidence, started, false))?;
		observed = observed.saturating_add(chunk.len() as u64);
		if observed > request.encoded.bounds.request_body {
			return Err(failure(
				simple_error(ErrorKind::Protocol, ErrorPhase::Encoding, false, "websocket-body-limit"),
				&request,
				&evidence,
				started,
				false,
			));
		}
		request_payload.extend_from_slice(&chunk);
	}
	let upgrade = request
		.encoded
		.uri
		.as_str()
		.into_client_request()
		.map_err(|_| {
			failure(
				simple_error(
					ErrorKind::Protocol,
					ErrorPhase::Encoding,
					false,
					"invalid-websocket-request",
				),
				&request,
				&evidence,
				started,
				false,
			)
		})?;
	let (parts, ()) = upgrade.into_parts();
	let mut upgrade = Request::from_parts(parts, Bytes::new());
	for item in &request.encoded.headers {
		let name = HeaderName::from_bytes(item.name.as_str().as_bytes()).map_err(|_| {
			failure(
				simple_error(
					ErrorKind::Protocol,
					ErrorPhase::Encoding,
					false,
					"invalid-websocket-header",
				),
				&request,
				&evidence,
				started,
				false,
			)
		})?;
		let value = HeaderValue::from_str(item.value.as_str()).map_err(|_| {
			failure(
				simple_error(
					ErrorKind::Protocol,
					ErrorPhase::Encoding,
					false,
					"invalid-websocket-header",
				),
				&request,
				&evidence,
				started,
				false,
			)
		})?;
		upgrade.headers_mut().insert(name, value);
	}
	upgrade
		.headers_mut()
		.entry(header::USER_AGENT)
		.or_insert(HeaderValue::from_static(omp_core::USER_AGENT));
	if let Some(credentials) = &request.credentials {
		credentials.finalize_buffered(&mut upgrade).map_err(|_| {
			failure(
				simple_error(
					ErrorKind::Authentication,
					ErrorPhase::Authentication,
					false,
					"websocket-credential-finalization",
				),
				&request,
				&evidence,
				started,
				false,
			)
		})?;
	}
	if let Some(signature) = &request.signature
		&& signature.apply(&mut upgrade).is_err()
	{
		return Err(failure(
			simple_error(
				ErrorKind::Authentication,
				ErrorPhase::Authentication,
				false,
				"websocket-provider-signature-finalization",
			),
			&request,
			&evidence,
			started,
			false,
		));
	}
	let upgrade = upgrade.map(|_| ());
	let (mut socket, response) = tokio::select! {
		result = connect_async(upgrade) => result.map_err(|_| failure(simple_error(ErrorKind::Connectivity, ErrorPhase::Connecting, false, "websocket-connect"), &request, &evidence, started, false))?,
		() = tokio::time::sleep_until(deadline) => {
			request.cancel.cancel();
			return Err(failure(simple_error(ErrorKind::DeadlineExceeded, ErrorPhase::Connecting, false, "websocket-connect-timeout"), &request, &evidence, started, false));
		},
	};
	let status = response.status().as_u16();
	let provider_request_id = request_id(response.headers());
	emit_provider_response(&request, status, response.headers(), provider_request_id.clone());
	let headers = sanitize_headers(response.headers());
	let capture = Arc::new(Mutex::new(LiveCapture {
		attempt: request.attempt.index,
		status,
		provider_request_id: provider_request_id.clone(),
		body: evidence.clone(),
		frames: Vec::new(),
		remaining: request.attempt.capture_limit,
	}));
	captures.lock().push(Arc::clone(&capture));
	if let Some(mut decoder) = request.decoder.take() {
		let payload = request_payload.freeze();
		if payload.len() as u64 > request.encoded.bounds.frame {
			return Err(failure(
				simple_error(
					ErrorKind::Protocol,
					ErrorPhase::Handshake,
					false,
					"websocket-initial-frame-limit",
				),
				&request,
				&evidence,
				started,
				false,
			));
		}
		tokio::select! {
			result = socket.send(wire_message(payload)) => result.map_err(|_| failure(simple_error(ErrorKind::Connectivity, ErrorPhase::Handshake, false, "websocket-initial-send"), &request, &evidence, started, false))?,
			() = tokio::time::sleep_until(deadline) => {
				request.cancel.cancel();
				return Err(failure(simple_error(ErrorKind::DeadlineExceeded, ErrorPhase::Handshake, false, "websocket-initial-send-timeout"), &request, &evidence, started, false));
			},
		}
		let (event_tx, event_rx) = flume::bounded::<Result<RawEvent, Error>>(CHANNEL_CAPACITY);
		let (control, control_rx) = if decoder.supports_control() {
			let (sender, receiver) = flume::bounded(CHANNEL_CAPACITY);
			(Some(sender), Some(receiver))
		} else {
			(None, None)
		};
		let cancel = request.cancel.clone();
		let stream_cancel = cancel.clone();
		let bounds = request.encoded.bounds;
		let pump_capture = Arc::clone(&capture);
		let pump_attempt = request.attempt.clone();
		let pump_evidence = evidence.clone();
		let pump_provider_request_id = provider_request_id.clone();
		tokio::spawn(async move {
			let mut emitted = false;
			loop {
				tokio::select! {
					input = async {
						match control_rx.as_ref() {
							Some(receiver) => receiver.recv_async().await.ok(),
							None => std::future::pending().await,
						}
					} => {
						let Some(input) = input else { break };
						match decoder.encode_control(input) {
							Ok(Some(frame)) if frame.len() as u64 <= bounds.frame => {
								if socket.send(wire_message(frame)).await.is_err() {
									let error = pump_error(
										simple_error(ErrorKind::Connectivity, ErrorPhase::Streaming, emitted, "websocket-send-disconnect"),
										&pump_attempt,
										&pump_evidence,
										status,
										pump_provider_request_id.as_ref(),
										started,
										emitted,
									);
									let _ = event_tx.send_async(Err(error)).await;
									break;
								}
							},
							Ok(Some(_)) => {
								let error = pump_error(
									simple_error(ErrorKind::StreamCorruption, ErrorPhase::Streaming, emitted, "websocket-outbound-frame-limit"),
									&pump_attempt,
									&pump_evidence,
									status,
									pump_provider_request_id.as_ref(),
									started,
									emitted,
								);
								let _ = event_tx.send_async(Err(error)).await;
								break;
							},
							Ok(None) => {
								let error = pump_error(
									simple_error(ErrorKind::Protocol, ErrorPhase::Streaming, emitted, "websocket-control-unsupported"),
									&pump_attempt,
									&pump_evidence,
									status,
									pump_provider_request_id.as_ref(),
									started,
									emitted,
								);
								let _ = event_tx.send_async(Err(error)).await;
								break;
							},
							Err(error) => {
								let error = pump_error(
									error,
									&pump_attempt,
									&pump_evidence,
									status,
									pump_provider_request_id.as_ref(),
									started,
									emitted,
								);
								let _ = event_tx.send_async(Err(error)).await;
								break;
							},
						}
					},
					message = socket.next() => match message {
						Some(Ok(Message::Ping(data))) => {
							if socket.send(Message::Pong(data)).await.is_err() {
								let error = pump_error(
									simple_error(ErrorKind::Connectivity, ErrorPhase::Streaming, emitted, "websocket-pong-disconnect"),
									&pump_attempt,
									&pump_evidence,
									status,
									pump_provider_request_id.as_ref(),
									started,
									emitted,
								);
								let _ = event_tx.send_async(Err(error)).await;
								break;
							}
						},
						Some(Ok(Message::Pong(_) | Message::Frame(_))) => {},
						Some(Ok(Message::Text(text))) => {
							let payload = Bytes::copy_from_slice(text.as_bytes());
							if payload.len() as u64 > bounds.frame { break; }
							let frame = Frame::WebSocket(WebSocketMessage::Text(payload));
							capture_socket_frame(&pump_capture, &frame);
							let mut decoded = Vec::new();
							match decoder.push(frame, &mut |event| decoded.push(event)) {
								Ok(()) => for event in decoded {
									if let RawEvent::Failure(error) = event {
										let error = pump_error(error, &pump_attempt, &pump_evidence, status, pump_provider_request_id.as_ref(), started, emitted);
										let _ = event_tx.send_async(Err(error)).await;
										return;
									}
									emitted |= is_commit_candidate(&event);
									if event_tx.send_async(Ok(event)).await.is_err() { return; }
								},
								Err(error) => {
									let error = pump_error(error, &pump_attempt, &pump_evidence, status, pump_provider_request_id.as_ref(), started, emitted);
									let _ = event_tx.send_async(Err(error)).await;
									break;
								},
							}
						},
						Some(Ok(Message::Binary(payload))) => {
							if payload.len() as u64 > bounds.frame { break; }
							let frame = Frame::WebSocket(WebSocketMessage::Binary(payload));
							capture_socket_frame(&pump_capture, &frame);
							let mut decoded = Vec::new();
							match decoder.push(frame, &mut |event| decoded.push(event)) {
								Ok(()) => for event in decoded {
									if let RawEvent::Failure(error) = event {
										let error = pump_error(error, &pump_attempt, &pump_evidence, status, pump_provider_request_id.as_ref(), started, emitted);
										let _ = event_tx.send_async(Err(error)).await;
										return;
									}
									emitted |= is_commit_candidate(&event);
									if event_tx.send_async(Ok(event)).await.is_err() { return; }
								},
								Err(error) => {
									let error = pump_error(error, &pump_attempt, &pump_evidence, status, pump_provider_request_id.as_ref(), started, emitted);
									let _ = event_tx.send_async(Err(error)).await;
									break;
								},
							}
						},
						Some(Ok(Message::Close(_))) | None => {
							let mut decoded = Vec::new();
							match decoder.finish(&mut |event| decoded.push(event)) {
								Ok(()) => for event in decoded {
									if let RawEvent::Failure(error) = event {
										let error = websocket_close_error(error, emitted);
										let error = pump_error(error, &pump_attempt, &pump_evidence, status, pump_provider_request_id.as_ref(), started, emitted);
										let _ = event_tx.send_async(Err(error)).await;
										return;
									}
									emitted |= is_commit_candidate(&event);
									if event_tx.send_async(Ok(event)).await.is_err() { return; }
								},
								Err(error) => {
									let error = pump_error(error, &pump_attempt, &pump_evidence, status, pump_provider_request_id.as_ref(), started, emitted);
									let _ = event_tx.send_async(Err(error)).await;
								},
							}
							break;
						},
						Some(Err(_)) => {
							let error = pump_error(
								simple_error(ErrorKind::Connectivity, ErrorPhase::Streaming, emitted, "websocket-disconnect"),
								&pump_attempt,
								&pump_evidence,
								status,
								pump_provider_request_id.as_ref(),
								started,
								emitted,
							);
							let _ = event_tx.send_async(Err(error)).await;
							break;
						},
					},
					() = poll_fn(|context| cancel.poll_cancelled(context)) => break,
					() = tokio::time::sleep_until(deadline) => {
						cancel.cancel();
						let error = pump_error(
							simple_error(ErrorKind::DeadlineExceeded, ErrorPhase::Streaming, emitted, "websocket-timeout"),
							&pump_attempt,
							&pump_evidence,
							status,
							pump_provider_request_id.as_ref(),
							started,
							emitted,
						);
						let _ = event_tx.send_async(Err(error)).await;
						break;
					},
				}
			}
		});
		// Hold block starts and other noncommitting markers until actual output
		// arrives. A failed attempt drops this preamble before retry, so downstream
		// never receives an orphaned open block that would need a synthetic end.
		let mut preamble = Vec::new();
		loop {
			let first = tokio::select! {
				first = event_rx.recv_async() => first.map_err(|_| failure(simple_error(ErrorKind::Connectivity, ErrorPhase::Handshake, false, "websocket-close-before-first-frame"), &request, &evidence, started, false))?,
				() = tokio::time::sleep_until(deadline) => {
					request.cancel.cancel();
					return Err(failure(simple_error(ErrorKind::DeadlineExceeded, ErrorPhase::Handshake, false, "websocket-first-frame-timeout"), &request, &evidence, started, false));
				},
			};
			match first {
				Err(error) => return Err(error),
				Ok(event) => {
					let committed = is_commit_candidate(&event);
					preamble.push(Ok(event));
					if committed {
						break;
					}
				},
			}
		}
		let events: RawEventStream = Box::pin(async_stream::stream! {
			let _guard = WebSocketCancelOnDrop(stream_cancel);
			for event in preamble {
				yield event;
			}
			while let Ok(event) = event_rx.recv_async().await {
				let failed = event.is_err();
				yield event;
				if failed {
					break;
				}
			}
		});
		return Ok(HandshakenResponse {
			meta: HandshakeMeta { status: Some(status), headers, provider_request_id },
			body: evidence,
			events: Some(events),
			control,
			realtime: None,
		});
	}
	let mut codec = request.realtime.take().expect("cardinality checked");
	let initial = codec
		.initial_frames()
		.map_err(|error| failure(error, &request, &evidence, started, false))?;
	for bytes in initial {
		if bytes.len() as u64 > request.encoded.bounds.frame {
			return Err(failure(
				simple_error(
					ErrorKind::Protocol,
					ErrorPhase::Handshake,
					false,
					"websocket-initial-frame-limit",
				),
				&request,
				&evidence,
				started,
				false,
			));
		}
		tokio::select! {
			result = socket.send(wire_message(bytes)) => result.map_err(|_| failure(simple_error(ErrorKind::Connectivity, ErrorPhase::Handshake, false, "websocket-initial-send"), &request, &evidence, started, false))?,
			() = tokio::time::sleep_until(deadline) => {
				request.cancel.cancel();
				return Err(failure(simple_error(ErrorKind::DeadlineExceeded, ErrorPhase::Handshake, false, "websocket-initial-send-timeout"), &request, &evidence, started, false));
			},
			() = poll_fn(|context| request.cancel.poll_cancelled(context)) => {
				return Err(failure(simple_error(ErrorKind::Cancelled, ErrorPhase::Handshake, false, "websocket-initial-send-cancelled"), &request, &evidence, started, false));
			},
		}
	}
	let first_events = loop {
		let message = tokio::select! {
			message = socket.next() => message,
			() = tokio::time::sleep_until(deadline) => {
				request.cancel.cancel();
				return Err(failure(simple_error(ErrorKind::DeadlineExceeded, ErrorPhase::Handshake, false, "websocket-first-frame-timeout"), &request, &evidence, started, false));
			},
			() = poll_fn(|context| request.cancel.poll_cancelled(context)) => {
				return Err(failure(simple_error(ErrorKind::Cancelled, ErrorPhase::Handshake, false, "websocket-first-frame-cancelled"), &request, &evidence, started, false));
			},
		};
		match message {
			Some(Ok(Message::Ping(data))) => socket.send(Message::Pong(data)).await.map_err(|_| {
				failure(
					simple_error(
						ErrorKind::Connectivity,
						ErrorPhase::Handshake,
						false,
						"websocket-pong-send",
					),
					&request,
					&evidence,
					started,
					false,
				)
			})?,
			Some(Ok(Message::Pong(_))) => {},
			Some(Ok(Message::Text(text))) => {
				let payload = Bytes::copy_from_slice(text.as_bytes());
				if payload.len() as u64 > request.encoded.bounds.frame {
					return Err(failure(
						simple_error(
							ErrorKind::Protocol,
							ErrorPhase::Handshake,
							false,
							"websocket-inbound-frame-limit",
						),
						&request,
						&evidence,
						started,
						false,
					));
				}
				let frame = Frame::WebSocket(WebSocketMessage::Text(payload.clone()));
				capture_socket_frame(&capture, &frame);
				break codec
					.decode(payload)
					.map_err(|error| failure(error, &request, &evidence, started, false))?;
			},
			Some(Ok(Message::Binary(payload))) => {
				if payload.len() as u64 > request.encoded.bounds.frame {
					return Err(failure(
						simple_error(
							ErrorKind::Protocol,
							ErrorPhase::Handshake,
							false,
							"websocket-inbound-frame-limit",
						),
						&request,
						&evidence,
						started,
						false,
					));
				}
				let frame = Frame::WebSocket(WebSocketMessage::Binary(payload.clone()));
				capture_socket_frame(&capture, &frame);
				break codec
					.decode(payload)
					.map_err(|error| failure(error, &request, &evidence, started, false))?;
			},
			Some(Ok(Message::Close(_))) | None => {
				return Err(failure(
					simple_error(
						ErrorKind::Connectivity,
						ErrorPhase::Handshake,
						false,
						"websocket-close-before-first-frame",
					),
					&request,
					&evidence,
					started,
					false,
				));
			},
			Some(Ok(Message::Frame(_))) => {},
			Some(Err(_)) => {
				return Err(failure(
					simple_error(
						ErrorKind::Connectivity,
						ErrorPhase::Handshake,
						false,
						"websocket-read",
					),
					&request,
					&evidence,
					started,
					false,
				));
			},
		}
	};
	let (outbound, outbound_rx) = flume::bounded(CHANNEL_CAPACITY);
	let (inbound_tx, inbound) = flume::bounded(CHANNEL_CAPACITY);
	let closed = Arc::new(AtomicBool::new(false));
	inbound_tx
		.send_async(Ok(RealtimeEvent::Ready))
		.await
		.map_err(|_| {
			failure(
				simple_error(
					ErrorKind::Cancelled,
					ErrorPhase::Handshake,
					false,
					"websocket-consumer-closed",
				),
				&request,
				&evidence,
				started,
				false,
			)
		})?;
	for event in first_events {
		inbound_tx.send_async(Ok(event)).await.map_err(|_| {
			failure(
				simple_error(
					ErrorKind::Cancelled,
					ErrorPhase::Handshake,
					false,
					"websocket-consumer-closed",
				),
				&request,
				&evidence,
				started,
				false,
			)
		})?;
	}
	let cancel = request.cancel.clone();
	let bounds = request.encoded.bounds;
	let pump_closed = Arc::clone(&closed);
	let pump_capture = Arc::clone(&capture);
	let pump_attempt = request.attempt.clone();
	let pump_evidence = evidence.clone();
	let pump_provider_request_id = provider_request_id.clone();
	tokio::spawn(async move {
		let _guard = ClosedGuard(pump_closed);
		loop {
			tokio::select! {
				input = outbound_rx.recv_async() => match input {
					Ok(RealtimeInput::Close) | Err(_) => {
						let _ = socket.send(Message::Close(None)).await;
						let _ = inbound_tx.send_async(Ok(RealtimeEvent::Closed)).await;
						break;
					},
					Ok(input) => match codec.encode(input) {
						Ok(frames) => for frame in frames {
							if frame.len() as u64 > bounds.frame {
								let error = pump_error(simple_error(ErrorKind::StreamCorruption, ErrorPhase::Streaming, true, "websocket-outbound-frame-limit"), &pump_attempt, &pump_evidence, status, pump_provider_request_id.as_ref(), started, true);
								let _ = inbound_tx.send_async(Err(error)).await;
								return;
							}
							if socket.send(wire_message(frame)).await.is_err() {
								let error = pump_error(simple_error(ErrorKind::Connectivity, ErrorPhase::Streaming, true, "websocket-send-disconnect"), &pump_attempt, &pump_evidence, status, pump_provider_request_id.as_ref(), started, true);
								let _ = inbound_tx.send_async(Err(error)).await;
								return;
							}
						},
						Err(error) => {
							let error = pump_error(error, &pump_attempt, &pump_evidence, status, pump_provider_request_id.as_ref(), started, true);
							let _ = inbound_tx.send_async(Err(error)).await;
							break;
						},
					},
				},
				message = socket.next() => match message {
					Some(Ok(Message::Ping(data))) => {
						if socket.send(Message::Pong(data)).await.is_err() {
							let error = pump_error(simple_error(ErrorKind::Connectivity, ErrorPhase::Streaming, true, "websocket-pong-disconnect"), &pump_attempt, &pump_evidence, status, pump_provider_request_id.as_ref(), started, true);
							let _ = inbound_tx.send_async(Err(error)).await;
							break;
						}
					},
					Some(Ok(Message::Pong(_))) => {},
					Some(Ok(Message::Text(text))) => {
						let payload = Bytes::copy_from_slice(text.as_bytes());
						if payload.len() as u64 > bounds.frame {
							let error = pump_error(simple_error(ErrorKind::StreamCorruption, ErrorPhase::Streaming, true, "websocket-inbound-frame-limit"), &pump_attempt, &pump_evidence, status, pump_provider_request_id.as_ref(), started, true);
							let _ = inbound_tx.send_async(Err(error)).await;
							break;
						}
						let frame = Frame::WebSocket(WebSocketMessage::Text(payload.clone()));
						capture_socket_frame(&pump_capture, &frame);
						match codec.decode(payload) {
							Ok(events) => for event in events {
								if inbound_tx.send_async(Ok(event)).await.is_err() { return; }
							},
							Err(error) => {
								let error = pump_error(error, &pump_attempt, &pump_evidence, status, pump_provider_request_id.as_ref(), started, true);
								let _ = inbound_tx.send_async(Err(error)).await;
								break;
							},
						}
					},
					Some(Ok(Message::Binary(payload))) => {
						if payload.len() as u64 > bounds.frame {
							let error = pump_error(simple_error(ErrorKind::StreamCorruption, ErrorPhase::Streaming, true, "websocket-inbound-frame-limit"), &pump_attempt, &pump_evidence, status, pump_provider_request_id.as_ref(), started, true);
							let _ = inbound_tx.send_async(Err(error)).await;
							break;
						}
						let frame = Frame::WebSocket(WebSocketMessage::Binary(payload.clone()));
						capture_socket_frame(&pump_capture, &frame);
						match codec.decode(payload) {
							Ok(events) => for event in events {
								if inbound_tx.send_async(Ok(event)).await.is_err() { return; }
							},
							Err(error) => {
								let error = pump_error(error, &pump_attempt, &pump_evidence, status, pump_provider_request_id.as_ref(), started, true);
								let _ = inbound_tx.send_async(Err(error)).await;
								break;
							},
						}
					},
					Some(Ok(Message::Close(_))) => { let _ = inbound_tx.send_async(Ok(RealtimeEvent::Closed)).await; break; },
					None | Some(Err(_)) => {
						let error = pump_error(simple_error(ErrorKind::Connectivity, ErrorPhase::Streaming, true, "websocket-postcommit-disconnect"), &pump_attempt, &pump_evidence, status, pump_provider_request_id.as_ref(), started, true);
						let _ = inbound_tx.send_async(Err(error)).await;
						break;
					},
					Some(Ok(Message::Frame(_))) => {},
				},
				() = poll_fn(|context| cancel.poll_cancelled(context)) => {
					let _ = socket.send(Message::Close(None)).await;
					let error = pump_error(simple_error(ErrorKind::Cancelled, ErrorPhase::Streaming, true, "websocket-cancelled"), &pump_attempt, &pump_evidence, status, pump_provider_request_id.as_ref(), started, true);
					let _ = inbound_tx.send_async(Err(error)).await;
					break;
				},
				() = tokio::time::sleep_until(deadline) => {
					cancel.cancel();
					let _ = socket.send(Message::Close(None)).await;
					let error = pump_error(simple_error(ErrorKind::DeadlineExceeded, ErrorPhase::Streaming, true, "websocket-timeout"), &pump_attempt, &pump_evidence, status, pump_provider_request_id.as_ref(), started, true);
					let _ = inbound_tx.send_async(Err(error)).await;
					break;
				},
			}
		}
	});
	Ok(HandshakenResponse {
		meta:     HandshakeMeta { status: Some(status), headers, provider_request_id },
		body:     evidence,
		events:   None,
		control:  None,
		realtime: Some(RealtimeSession::from_channels(outbound, inbound, closed)),
	})
}

fn websocket_close_error(mut error: Error, committed: bool) -> Error {
	if !committed && error.code.as_deref() == Some("premature_end") {
		error.kind = ErrorKind::Connectivity;
	}
	error
}

fn pump_error(
	mut error: Error,
	attempt: &TransportAttempt,
	evidence: &AttemptEvidenceHandle,
	status: u16,
	provider_request_id: Option<&Str>,
	started: Instant,
	committed: bool,
) -> Error {
	error.committed = committed;
	error.phase = if committed {
		ErrorPhase::Streaming
	} else {
		ErrorPhase::Handshake
	};
	if committed {
		error.action = RetryAction::Never;
	} else if matches!(error.action, RetryAction::Never)
		&& matches!(error.kind, ErrorKind::Connectivity | ErrorKind::StreamCorruption)
	{
		error.action = RetryAction::SameRoute { after: std::time::Duration::ZERO };
	}
	record_failure(error, attempt, evidence, Some(status), provider_request_id, started, committed)
}

fn capture_socket_frame(capture: &Arc<Mutex<LiveCapture>>, frame: &Frame) {
	let mut capture = capture.lock();
	let ordinal = capture.frames.len() as u64;
	let mut remaining = capture.remaining;
	let mut frames = mem::take(&mut capture.frames);
	capture_frame(&mut frames, ordinal, frame, &mut remaining);
	capture.frames = frames;
	capture.remaining = remaining;
}

fn wire_message(bytes: Bytes) -> Message {
	match str::from_utf8(&bytes) {
		Ok(text) => Message::text(text.to_owned()),
		Err(_) => Message::Binary(bytes),
	}
}

fn body_error(error: BodyOpenError) -> Error {
	match error {
		BodyOpenError::Consumed => {
			simple_error(ErrorKind::Protocol, ErrorPhase::Connecting, false, "body-consumed")
		},
		BodyOpenError::AttemptAlreadyOpened => simple_error(
			ErrorKind::Protocol,
			ErrorPhase::Connecting,
			false,
			"body-attempt-already-opened",
		),
		BodyOpenError::ReacquisitionUnavailable => simple_error(
			ErrorKind::Protocol,
			ErrorPhase::Connecting,
			false,
			"body-reacquisition-unavailable",
		),
		BodyOpenError::ConcurrentReader => {
			simple_error(ErrorKind::Protocol, ErrorPhase::Connecting, false, "body-concurrent-reader")
		},
		BodyOpenError::Factory(error) => error,
	}
}

fn failure(
	error: Error,
	request: &TransportRequest,
	evidence: &AttemptEvidenceHandle,
	started: Instant,
	committed: bool,
) -> Error {
	record_failure(error, &request.attempt, evidence, None, None, started, committed)
}

fn simple_error(
	kind: ErrorKind,
	phase: ErrorPhase,
	committed: bool,
	reason: &'static str,
) -> Error {
	Error::new(kind, phase, RetryAction::Never, ExecutionReceipt::default())
		.committed(committed)
		.detail(ErrorDetail::protocol(ReasonId(Str::new(reason))))
}

struct WebSocketCancelOnDrop(Cancellation);

impl Drop for WebSocketCancelOnDrop {
	fn drop(&mut self) {
		self.0.cancel();
	}
}

struct ClosedGuard(Arc<AtomicBool>);
impl Drop for ClosedGuard {
	fn drop(&mut self) {
		self.0.store(true, Ordering::Release);
	}
}
