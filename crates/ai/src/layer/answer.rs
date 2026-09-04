//! Final projection from recovered semantic output into the closed [`Answer`]
//! contract.

use std::{
	mem,
	task::{Context, Poll},
	time::SystemTime,
};

use bytes::BytesMut;
use futures::StreamExt;
use omp_core::{Str, sf};
use tower::{Layer, Service};

use crate::{
	answer::{
		Answer, AnswerBody, AnswerKind, AudioStream, ChatStream, GenerationStream, ImageArtifact,
		NativeResponse, NativeResponseBody, OutputStream, ResponseMeta, TranscriptStream,
	},
	body::ByteStream,
	call::{Call, NativeRequest, NativeResponseFraming, OperationCall, RawJson},
	catalog::OperationKind,
	codec::{
		HandshakeMeta, HandshakenResponse, ProviderControlEvent, RawEvent, RawEventStream,
		RequestHeader,
	},
	error::{Error, ErrorDetail, ErrorKind, ErrorPhase, RetryAction},
	event::{ChatEvent, WorkflowAction, WorkflowResponseKind, WorkflowResume},
	layer::{ExecutionContext, LayerCall},
	receipt::ReasonId,
};

/// Projects one post-semantic response into the public typed answer.
#[derive(Clone, Copy, Debug, Default)]
pub struct AnswerLayer;

/// Typed answer projection service.
#[derive(Clone, Debug)]
pub struct AnswerService<S> {
	inner: S,
}

impl<S> Layer<S> for AnswerLayer {
	type Service = AnswerService<S>;

	fn layer(&self, inner: S) -> Self::Service {
		AnswerService { inner }
	}
}
struct AbortOnDrop(ExecutionContext, bool);
impl AbortOnDrop {
	fn disarm(&mut self) {
		assert!(mem::replace(&mut self.1, false), "session abort guard disarmed once");
	}
}
impl Drop for AbortOnDrop {
	fn drop(&mut self) {
		if self.1 {
			self.0.abort_session();
		}
	}
}

impl<S> Service<LayerCall<Call>> for AnswerService<S>
where
	S: Service<LayerCall<Call>, Response = HandshakenResponse, Error = Error> + Clone,
{
	type Error = Error;
	type Response = Answer;

	type Future = impl Future<Output = Result<Answer, Error>>;

	fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), Error>> {
		self.inner.poll_ready(cx)
	}

	fn call(&mut self, request: LayerCall<Call>) -> Self::Future {
		let replacement = self.inner.clone();
		let mut inner = mem::replace(&mut self.inner, replacement);
		async move {
			let mut abort = AbortOnDrop(request.context.clone(), true);
			request.context.checkpoint(ErrorPhase::Streaming)?;
			let operation = request.payload.operation.kind();
			let native = match &request.payload.operation {
				OperationCall::Native(value) => Some(value.clone()),
				_ => None,
			};
			let plan = request
				.payload
				.execution
				.clone()
				.ok_or_else(|| invariant("answer.missing-execution-plan", &request.context))?;
			if plan.operation != operation {
				return Err(invariant("answer.operation-plan-mismatch", &request.context));
			}
			let mut response = match inner.call(request.clone()).await {
				Ok(response) => response,
				Err(error) if matches!(error.action, crate::error::RetryAction::ReseedSession) => {
					request.context.abort_session_for_reseed();
					abort.disarm();
					return Err(error);
				},
				Err(error) => return Err(error),
			};
			let meta = ResponseMeta {
				request_id:          request.payload.id.clone(),
				provider:            plan.provider.clone(),
				route:               plan.route.clone(),
				model:               plan.model.clone(),
				provider_request_id: response.meta.provider_request_id.clone(),
				created_at:          SystemTime::now(),
			};
			if operation == OperationKind::Realtime {
				let session = response
					.realtime
					.take()
					.ok_or_else(|| invariant("realtime.missing-session", &request.context))?;
				if response.events.is_some() || response.control.is_some() {
					return Err(invariant("realtime.unexpected-events", &request.context));
				}
				abort.disarm();
				return Ok(Answer {
					meta,
					receipt: request.context.receipt(),
					body: AnswerBody::Realtime(session),
				});
			}
			if response.realtime.is_some() {
				return Err(invariant("answer.unexpected-realtime-session", &request.context));
			}
			let events = response
				.events
				.take()
				.ok_or_else(|| invariant("answer.missing-events", &request.context))?;
			if operation == OperationKind::Chat {
				let events = chat_stream(events, meta.clone(), request.context.clone());
				let output = match response.control.take() {
					Some(control) => ChatStream::duplex(events, control),
					None => ChatStream::ordinary(events),
				};
				abort.disarm();
				return Ok(Answer {
					meta,
					receipt: request.context.receipt(),
					body: AnswerBody::Chat(output),
				});
			}
			if response.control.is_some() {
				return Err(invariant("answer.unexpected-control-path", &request.context));
			}
			if operation == OperationKind::GenerateImage {
				let output = image_stream(events, request.context.clone());
				abort.disarm();
				return Ok(Answer {
					meta,
					receipt: request.context.receipt(),
					body: AnswerBody::Images(output),
				});
			}
			if operation == OperationKind::Speak {
				let output = audio_stream(events, request.context.clone());
				abort.disarm();
				return Ok(Answer {
					meta,
					receipt: request.context.receipt(),
					body: AnswerBody::Speech(output),
				});
			}
			if operation == OperationKind::Transcribe {
				let output = transcript_stream(events, request.context.clone());
				abort.disarm();
				return Ok(Answer {
					meta,
					receipt: request.context.receipt(),
					body: AnswerBody::Transcript(output),
				});
			}
			if let Some(native) = native.as_ref()
				&& native.response_framing == NativeResponseFraming::Sse
			{
				let status = response
					.meta
					.status
					.ok_or_else(|| invariant("native.missing-status", &request.context))?;
				let provider_request_id = meta.provider_request_id.clone();
				let bytes = native_stream(events, native.max_response_bytes, request.context.clone());
				abort.disarm();
				return Ok(Answer {
					meta,
					receipt: request.context.receipt(),
					body: AnswerBody::Native(NativeResponse {
						status,
						media_type: content_type(&response.meta.headers),
						body: NativeResponseBody::Stream(bytes),
						provider_request_id,
					}),
				});
			}
			let body = match unary_body(
				operation,
				native.as_deref(),
				&response.meta,
				events,
				&request.context,
			)
			.await
			{
				Ok(body) => body,
				Err(error) if matches!(error.action, crate::error::RetryAction::ReseedSession) => {
					request.context.abort_session_for_reseed();
					abort.disarm();
					return Err(error);
				},
				Err(error) => return Err(error),
			};
			request.context.commit_session()?;
			abort.disarm();
			request.context.with_receipt(|receipt| {
				receipt.timings.total = request.context.elapsed();
				receipt.timings.completed_at = Some(SystemTime::now());
			});
			Ok(Answer { meta, receipt: request.context.receipt(), body })
		}
	}
}

fn chat_stream(
	mut input: RawEventStream,
	meta: ResponseMeta,
	context: ExecutionContext,
) -> OutputStream<ChatEvent> {
	Box::pin(async_stream::stream! {
		let mut abort = AbortOnDrop(context.clone(), true);
		if let Err(mut error) = context.checkpoint(ErrorPhase::Streaming) {
			context.finalize_error(&mut error); let error = error.committed(false); context.abort_session(); abort.disarm(); yield Err(error); return;
		}
		yield Ok(ChatEvent::Started(meta));
		loop {
			let item = match next_with_deadline(&mut input, &context).await {
				Ok(item) => item,
				Err(error) => {
					context.cancel(); context.abort_session(); abort.disarm(); let mut error = error.committed(context.is_committed()); error.replace_receipt(context.receipt());
					yield Err(error);
					break;
				},
			};
			match item {
				None => {
					let error = Error::new(ErrorKind::StreamCorruption, ErrorPhase::Streaming, RetryAction::Never, context.receipt())
						.committed(context.is_committed())
						.detail(ErrorDetail::protocol(ReasonId::new_static("chat.missing-terminal-completion")));
					context.abort_session(); abort.disarm();
					yield Err(error);
					break;
				},
				Some(Ok(RawEvent::Chat(ChatEvent::Started(_)))) => {},
				Some(Ok(RawEvent::Chat(mut event))) => {
					let terminal = matches!(event, ChatEvent::Completed(_));
					if let ChatEvent::Completed(completion) = &mut event {
						context.merge_receipt(&completion.receipt);
						completion.receipt = context.receipt().into();
					}
					if let Err(mut error) = context.record_session_event(&event) {
						context.finalize_error(&mut error); let error = error.committed(context.is_committed()); context.abort_session(); abort.disarm(); yield Err(error); break;
					}
					if event.commits_output() { context.commit(); }
					if terminal
						&& let Err(mut error) = context.commit_session()
					{
						context.finalize_error(&mut error); let error = error.committed(context.is_committed()); abort.disarm(); yield Err(error); break;
					}
					yield Ok(event);
					if terminal { abort.disarm(); break; }
				},
				Some(Ok(RawEvent::Control(ProviderControlEvent::WorkflowAction { request_id, name, arguments, timeout_ms }))) => {
					yield Ok(ChatEvent::WorkflowAction(WorkflowAction {
						invocation: request_id.clone(),
						call: Some(crate::id::ToolCallId::from(request_id.as_str())),
						name,
						arguments,
						timeout: timeout_ms.map(std::time::Duration::from_millis),
						response_kind: WorkflowResponseKind::Action,
					}));
				},
				Some(Ok(RawEvent::Control(ProviderControlEvent::WorkflowResume { workflow_id, session_id, last_event_id }))) => {
					yield Ok(ChatEvent::WorkflowResume(WorkflowResume {
						workflow_id,
						session_id,
						last_event_id,
					}));
				},
				Some(Ok(RawEvent::Control(ProviderControlEvent::Cancel { call }))) => {
					yield Ok(ChatEvent::WorkflowCancelled { invocation: call.into_inner() });
				},
				Some(Ok(RawEvent::Control(ProviderControlEvent::ShellInvoke { invocation, call, command, cwd, timeout_ms, exec, streaming }))) => {
					let arguments = bytes::Bytes::from(serde_json::json!({
						"command": command.as_str(),
						"cwd": cwd.as_ref().map(Str::as_str),
						"exec_id": exec.as_ref().map(Str::as_str),
						"streaming": streaming,
					}).to_string());
					yield Ok(ChatEvent::WorkflowAction(WorkflowAction {
						invocation,
						call: Some(call),
						name: sf!("exec.shell"),
						arguments,
						response_kind: WorkflowResponseKind::Invoke,
						timeout: timeout_ms.map(std::time::Duration::from_millis),
					}));
				},
				Some(Ok(RawEvent::Control(ProviderControlEvent::InteractionQuery { .. }))) => {
					// Interaction permission gates are answered by the codec itself
					// (the prepared reply travels on the control event for a
					// duplex-capable transport). They are not agent workflow
					// actions: surfacing them as `Invoke` would demand a client
					// response no consumer can provide and fail the turn.
				},
				Some(Err(mut error)) => { context.finalize_error(&mut error); let error = error.committed(context.is_committed()); context.abort_session(); abort.disarm(); yield Err(error); break; },
				Some(Ok(other)) => { let error = mismatch(OperationKind::Chat, raw_kind(&other), &context); context.abort_session(); abort.disarm(); yield Err(error); break; },
			}
		}
	})
}

fn image_stream(
	mut input: RawEventStream,
	context: ExecutionContext,
) -> GenerationStream<ImageArtifact> {
	Box::pin(async_stream::stream! {
		let mut abort = AbortOnDrop(context.clone(), true);
		loop {
			let item = match next_with_deadline(&mut input, &context).await {
				Ok(Some(item)) => item,
				Ok(None) => { yield Err(finalize_stream_error(invariant("image.missing-terminal", &context), &context)); return; },
				Err(error) => { yield Err(finalize_stream_error(error, &context)); return; },
			};
			match item {
				Ok(RawEvent::ImageGeneration(event)) => {
					let terminal = matches!(event, crate::answer::GenerationEvent::Completed(_));
					if !terminal { context.commit(); }
					yield Ok(event);
					if terminal {
						if let Err(mut error) = context.commit_session() { context.finalize_error(&mut error); yield Err(error); return; }
						abort.disarm();
						return;
					}
				}
				Ok(RawEvent::Metadata(metadata)) => context.observe_provider_metadata(metadata),
				Ok(RawEvent::Telemetry(telemetry)) => context.observe_provider_telemetry(telemetry),
				Ok(RawEvent::Failure(error)) | Err(error) => { yield Err(finalize_stream_error(error, &context)); return; },
				Ok(other) => { yield Err(finalize_stream_error(mismatch(OperationKind::GenerateImage, raw_kind(&other), &context), &context)); return; },
			}
		}
	})
}

fn audio_stream(mut input: RawEventStream, context: ExecutionContext) -> AudioStream {
	Box::pin(async_stream::stream! {
		let mut abort = AbortOnDrop(context.clone(), true);
		loop {
			let item = match next_with_deadline(&mut input, &context).await {
				Ok(Some(item)) => item,
				Ok(None) => { yield Err(finalize_stream_error(invariant("speech.missing-terminal", &context), &context)); return; },
				Err(error) => { yield Err(finalize_stream_error(error, &context)); return; },
			};
			match item {
				Ok(RawEvent::Audio(chunk)) => {
					let terminal = chunk.final_chunk;
					context.commit();
					yield Ok(chunk);
					if terminal {
						if let Err(error) = context.commit_session() { yield Err(error); return; }
						abort.disarm();
						return;
					}
				}
				Ok(RawEvent::Metadata(metadata)) => context.observe_provider_metadata(metadata),
				Ok(RawEvent::Telemetry(telemetry)) => context.observe_provider_telemetry(telemetry),
				Ok(RawEvent::Failure(error)) | Err(error) => { yield Err(finalize_stream_error(error, &context)); return; },
				Ok(other) => { yield Err(finalize_stream_error(mismatch(OperationKind::Speak, raw_kind(&other), &context), &context)); return; },
			}
		}
	})
}

fn transcript_stream(mut input: RawEventStream, context: ExecutionContext) -> TranscriptStream {
	Box::pin(async_stream::stream! {
		let mut abort = AbortOnDrop(context.clone(), true);
		loop {
			let item = match next_with_deadline(&mut input, &context).await {
				Ok(Some(item)) => item,
				Ok(None) => { yield Err(finalize_stream_error(invariant("transcript.missing-terminal", &context), &context)); return; },
				Err(error) => { yield Err(finalize_stream_error(error, &context)); return; },
			};
			match item {
				Ok(RawEvent::Transcript(event)) => {
					let terminal = matches!(event, crate::answer::TranscriptEvent::Completed { .. });
					context.commit();
					yield Ok(event);
					if terminal {
						if let Err(error) = context.commit_session() { yield Err(error); return; }
						abort.disarm();
						return;
					}
				}
				Ok(RawEvent::Metadata(metadata)) => context.observe_provider_metadata(metadata),
				Ok(RawEvent::Telemetry(telemetry)) => context.observe_provider_telemetry(telemetry),
				Ok(RawEvent::Failure(error)) | Err(error) => { yield Err(finalize_stream_error(error, &context)); return; },
				Ok(other) => { yield Err(finalize_stream_error(mismatch(OperationKind::Transcribe, raw_kind(&other), &context), &context)); return; },
			}
		}
	})
}

fn native_stream(mut input: RawEventStream, limit: u64, context: ExecutionContext) -> ByteStream {
	Box::pin(async_stream::stream! {
		let mut abort = AbortOnDrop(context.clone(), true);
		let mut observed = 0_u64;
		loop {
			let item = match next_with_deadline(&mut input, &context).await { Ok(Some(item)) => item, Ok(None) => break, Err(error) => { context.cancel(); context.abort_session(); abort.disarm(); yield Err(finalize_stream_error(error, &context)); return; } };
			match item {
				Ok(RawEvent::NativeChunk(bytes)) => {
					observed = observed.saturating_add(bytes.len() as u64);
					if observed > limit { let error = limit_error(limit, observed, &context); context.abort_session(); abort.disarm(); yield Err(error); return; }
					context.commit(); yield Ok(bytes);
				},
				Ok(RawEvent::Metadata(metadata)) => context.observe_provider_metadata(metadata),
				Ok(RawEvent::Telemetry(telemetry)) => context.observe_provider_telemetry(telemetry),
				Ok(RawEvent::ProviderState(state)) => context.stage_provider_state(state),
				Ok(RawEvent::Failure(mut error)) | Err(mut error) => { context.finalize_error(&mut error); let error = error.committed(context.is_committed()); context.abort_session(); abort.disarm(); yield Err(error); return; },
				Ok(other) => { let error = finalize_stream_error(mismatch(OperationKind::Native, raw_kind(&other), &context), &context); context.abort_session(); abort.disarm(); yield Err(error); return; },
			}
		}
		if let Err(mut error) = context.commit_session() { context.finalize_error(&mut error); yield Err(error); return; }
		abort.disarm();
	})
}

async fn next_with_deadline(
	input: &mut RawEventStream,
	context: &ExecutionContext,
) -> Result<Option<Result<RawEvent, Error>>, Error> {
	loop {
		context.checkpoint(ErrorPhase::Streaming)?;
		let Some(limit) = context.budget().max_elapsed else {
			return Ok(input.next().await);
		};
		let remaining = limit.saturating_sub(context.elapsed());
		tokio::select! {
			biased;
			item = input.next() => return Ok(item),
			() = tokio::time::sleep(remaining) => {
				context.checkpoint(ErrorPhase::Streaming)?;
			},
		}
	}
}

async fn unary_body(
	operation: OperationKind,
	native: Option<&NativeRequest>,
	handshake: &HandshakeMeta,
	mut events: RawEventStream,
	context: &ExecutionContext,
) -> Result<AnswerBody, Error> {
	let mut answer = None;
	let mut native_bytes = BytesMut::new();
	loop {
		let Some(item) = next_with_deadline(&mut events, context).await? else {
			break;
		};
		match item {
			Err(mut error) | Ok(RawEvent::Failure(mut error)) => {
				context.finalize_error(&mut error);
				return Err(error);
			},
			Ok(RawEvent::Answer(body)) if answer.is_none() => answer = Some(body),
			Ok(RawEvent::Answer(body)) => return Err(mismatch(operation, body.kind(), context)),
			Ok(RawEvent::NativeChunk(bytes)) if operation == OperationKind::Native => {
				let limit = native.map_or(0, |request| request.max_response_bytes);
				let observed = native_bytes.len() as u64 + bytes.len() as u64;
				if observed > limit {
					return Err(limit_error(limit, observed, context));
				}
				native_bytes.extend_from_slice(&bytes);
			},
			Ok(RawEvent::ProviderState(state)) => context.stage_provider_state(state),
			Ok(RawEvent::Metadata(metadata)) => context.observe_provider_metadata(metadata),
			Ok(RawEvent::Telemetry(telemetry)) => context.observe_provider_telemetry(telemetry),
			Ok(other) => return Err(mismatch(operation, raw_kind(&other), context)),
		}
	}
	let body = if operation == OperationKind::Native && answer.is_none() {
		let request = native.ok_or_else(|| invariant("native.request-missing", context))?;
		let status = handshake
			.status
			.ok_or_else(|| invariant("native.missing-status", context))?;
		let bytes = native_bytes.freeze();
		let body = match request.response_framing {
			NativeResponseFraming::Json => NativeResponseBody::Json(
				RawJson::new(bytes, request.max_response_bytes)
					.map_err(|_| invariant("native.invalid-json-response", context))?,
			),
			NativeResponseFraming::Bytes => NativeResponseBody::Bytes(bytes),
			NativeResponseFraming::Sse => {
				return Err(invariant("native.streaming-projection-reached-unary", context));
			},
		};
		AnswerBody::Native(NativeResponse {
			status,
			media_type: content_type(&handshake.headers),
			body,
			provider_request_id: handshake.provider_request_id.clone(),
		})
	} else {
		answer.ok_or_else(|| invariant("answer.missing-body", context))?
	};
	if expected_kind(operation) != body.kind() {
		return Err(mismatch(operation, body.kind(), context));
	}
	Ok(body)
}

const fn expected_kind(operation: OperationKind) -> AnswerKind {
	match operation {
		OperationKind::Chat => AnswerKind::Chat,
		OperationKind::CountTokens => AnswerKind::Tokens,
		OperationKind::Tokenize => AnswerKind::TokenIds,
		OperationKind::Detokenize => AnswerKind::Text,
		OperationKind::Embed => AnswerKind::Embeddings,
		OperationKind::GenerateImage => AnswerKind::Images,
		OperationKind::GenerateVideo => AnswerKind::Video,
		OperationKind::Speak => AnswerKind::Speech,
		OperationKind::Transcribe => AnswerKind::Transcript,
		OperationKind::Realtime => AnswerKind::Realtime,
		OperationKind::Search => AnswerKind::Search,
		OperationKind::Extract => AnswerKind::ParallelExtract,
		OperationKind::Usage => AnswerKind::Usage,
		OperationKind::DiscoverModels => AnswerKind::Models,
		OperationKind::Auth => AnswerKind::Auth,
		OperationKind::Native => AnswerKind::Native,
	}
}

const fn raw_kind(event: &RawEvent) -> AnswerKind {
	match event {
		RawEvent::Chat(_) | RawEvent::Completion(_) | RawEvent::ToolCallComplete { .. } => {
			AnswerKind::Chat
		},
		RawEvent::Answer(body) => body.kind(),
		RawEvent::NativeChunk(_) => AnswerKind::Native,
		RawEvent::ImageGeneration(_) => AnswerKind::Images,
		RawEvent::VideoGeneration(_) => AnswerKind::Video,
		RawEvent::Audio(_) => AnswerKind::Speech,
		RawEvent::Transcript(_) => AnswerKind::Transcript,
		RawEvent::DiscoveredModels { .. } => AnswerKind::Models,
		RawEvent::Control(_) => AnswerKind::Realtime,
		RawEvent::ProviderState(_)
		| RawEvent::Metadata(_)
		| RawEvent::Telemetry(_)
		| RawEvent::Failure(_) => AnswerKind::Native,
	}
}
fn finalize_stream_error(mut error: Error, context: &ExecutionContext) -> Error {
	context.finalize_error(&mut error);
	let mut error = error.committed(context.is_committed());
	error.replace_receipt(context.receipt());
	error
}
fn mismatch(expected: OperationKind, actual: AnswerKind, context: &ExecutionContext) -> Error {
	Error::body_variant_mismatch(expected, actual, context.receipt())
}
fn invariant(reason: &'static str, context: &ExecutionContext) -> Error {
	Error::new(
		ErrorKind::ProviderContractMismatch,
		ErrorPhase::Internal,
		RetryAction::Never,
		context.receipt(),
	)
	.detail(ErrorDetail::protocol(ReasonId::new(reason)))
}
fn limit_error(limit: u64, observed: u64, context: &ExecutionContext) -> Error {
	Error::new(
		ErrorKind::PolicyBufferExceeded,
		ErrorPhase::Streaming,
		RetryAction::Never,
		context.receipt(),
	)
	.committed(context.is_committed())
	.detail(ErrorDetail::budget(sf!("native_response_bytes"), limit as u128, observed as u128))
}
fn content_type(headers: &[RequestHeader]) -> Option<Str> {
	headers
		.iter()
		.find(|header| header.name.as_str().eq_ignore_ascii_case("content-type"))
		.map(|header| header.value.clone())
}

#[cfg(test)]
mod tests {
	use std::{
		sync::Arc,
		time::{Duration, Instant, SystemTime},
	};

	use bytes::Bytes;
	use omp_catalog::{OperationKind, snapshot::Catalog};

	use super::*;
	use crate::{
		answer::{AudioChunk, ResponseMeta},
		call::{
			Call, CallMeta, ChatRequest, ContextStrategy, NegotiationPolicy, OperationCall, Sampling,
			SessionRequest, Setting, Target,
		},
		codec::RawEventStream,
		event::{Completion, FinishReason},
		id::{RequestId, TurnId},
		layer::{
			ExecutionContext,
			session::{SessionAction, SessionPlanner as _},
		},
		plan::{
			CapabilityAvailability, ExecutionPlan, FallbackScope, ReplayPlan, RouteHealth,
			RuntimeRouteEvidence,
		},
		receipt::{ExecutionBudget, RecoveryKind, Usage},
		session::{
			ConversationSessionPlanner,
			store::{ConversationStore as _, InMemoryConversationStore},
		},
	};

	#[tokio::test]
	async fn audio_terminal_commits_only_after_final_chunk() {
		let context = ExecutionContext::new(ExecutionBudget::default());
		let input: RawEventStream =
			Box::pin(futures::stream::iter([Ok(RawEvent::Audio(AudioChunk {
				bytes:       bytes::Bytes::from_static(b"audio"),
				start_ms:    Some(0),
				end_ms:      Some(1),
				final_chunk: true,
			}))]));
		assert!(!context.is_committed());
		let mut output = audio_stream(input, context.clone());
		assert!(output.next().await.unwrap().is_ok());
		assert!(output.next().await.is_none());
		assert!(context.is_committed());
	}

	#[tokio::test]
	async fn chat_terminal_stages_the_same_fork_receipt_that_it_yields() {
		fn receipt_bytes(completion: &Completion) -> Bytes {
			Bytes::from(serde_json::to_vec(&completion.receipt).expect("serialize receipt"))
		}

		let catalog = Arc::new(Catalog::try_embedded().expect("embedded catalog").clone());
		let (model, route) = catalog
			.models()
			.iter()
			.find_map(|model| {
				model
					.capabilities
					.operations
					.contains_kind(OperationKind::Chat)
					.then(|| {
						model
							.routes
							.iter()
							.find_map(|route| catalog.route(route))
							.map(|route| (model, route))
					})
					.flatten()
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
		let request_id = RequestId::new("fork-request");
		let turn = TurnId::new("fork-turn");
		let mut call = Call::new(
			CallMeta {
				id: request_id.clone(),
				target: Target::Route { route: route.id.clone(), model: model.key.clone() },
				deadline: None,
				budget,
				session: Some(SessionRequest {
					conversation:   root.conversation().to_owned(),
					revision:       root.revision().to_owned(),
					turn:           turn.clone(),
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
				.prepare(&mut call, &context)
				.expect("prepare explicit fork"),
			SessionAction::Reseed
		);
		context.set_session_completion(
			planner
				.completion(&call, &context)
				.expect("session completion"),
		);
		planner.stage_turn_replay(
			request_id.clone(),
			turn.clone(),
			Bytes::from_static(b"request"),
			|completion| Ok(receipt_bytes(completion)),
		);
		let input: RawEventStream =
			Box::pin(futures::stream::iter([Ok(RawEvent::Chat(ChatEvent::Completed(Completion {
				reason:  FinishReason::Stop,
				blocks:  0,
				usage:   Usage::default(),
				receipt: Default::default(),
			})))]));
		let meta = ResponseMeta {
			request_id,
			provider: route.provider.clone(),
			route: route.id.clone(),
			model: Some(model.key.clone()),
			provider_request_id: None,
			created_at: SystemTime::UNIX_EPOCH,
		};
		let mut output = chat_stream(input, meta, context);
		assert!(matches!(output.next().await, Some(Ok(ChatEvent::Started(_)))));
		let live = match output.next().await {
			Some(Ok(ChatEvent::Completed(completion))) => completion,
			other => panic!("expected terminal completion, got {other:?}"),
		};
		assert_eq!(live.receipt.recoveries.len(), 1);
		assert_eq!(live.receipt.recoveries[0].kind, RecoveryKind::SessionReseed);
		let retained = planner
			.turn_replay(&turn)
			.expect("read staged replay")
			.expect("committed staged replay");
		assert_eq!(retained.outcome, receipt_bytes(&live));
	}

	#[tokio::test]
	async fn audio_failure_after_visible_chunk_is_committed() {
		let context = ExecutionContext::new(ExecutionBudget::default());
		let failure = Error::new(
			ErrorKind::StreamCorruption,
			ErrorPhase::Streaming,
			RetryAction::Never,
			context.receipt(),
		);
		let input: RawEventStream = Box::pin(futures::stream::iter([
			Ok(RawEvent::Audio(AudioChunk {
				bytes:       bytes::Bytes::from_static(b"partial"),
				start_ms:    Some(0),
				end_ms:      Some(1),
				final_chunk: false,
			})),
			Err(failure),
		]));
		let mut output = audio_stream(input, context);
		assert!(output.next().await.unwrap().is_ok());
		let error = output.next().await.unwrap().unwrap_err();
		assert!(error.committed);
	}
}
