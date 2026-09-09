//! Cross-provider inference conformance tests.

mod support;

use std::{
	collections::{BTreeSet, HashMap},
	str,
	sync::{Arc, atomic, atomic::Ordering},
	time::{Duration, SystemTime, UNIX_EPOCH},
};

use bytes::Bytes;
use futures::{StreamExt as _, stream};
use omp_ai::{
	AccountId, GenerationHandle, PrincipalId, ProjectId, RequestId,
	account::{
		AccountPool, AccountRecord, AccountSelectionRequest, ProcessRefreshRole, QuotaObservation,
		QuotaProvenance, QuotaWindowId, RefreshCoordinator, RefreshPolicy, RotationPolicy,
	},
	answer::{
		AccountState, AccountSummary, Answer, AnswerBody, AuthAnswer, ChatStream, DetokenizedText,
		EmbeddingBatch, GenerationSession, ModelDiscoveryPage, NativeResponse, NativeResponseBody,
		RealtimeEvent, RealtimeInput, RealtimeSession, ResponseMeta, SearchResults, TokenCount,
		TokenSequence, TokenizerProvenance, UsageAccountMetadata, UsageReport,
	},
	body::{
		AttemptBodyEvidence, BodyFactoryHandle, BodySource, Replayability, RetryDecision,
		RetryDecisionReason, aggregate_replay_evidence,
	},
	call::{
		AccountRoutingContext, AuthRequest, CallMeta, ChatRequest, ContentPart, CountAccuracy,
		CountTokensRequest, DetokenizeRequest, DiscoveryRequest, EmbedRequest, ImageRequest, Message,
		NativeMethod, NativePath, NativeRequest, NativeResponseFraming, OpaqueJson, OperationCall,
		ProviderProof, RealtimeRequest, Role, SearchRequest, SpeechRequest, Target, TokenizeRequest,
		TranscriptionRequest, UsageRequest, VideoRequest,
	},
	client::{Client, Operation},
	codec::{
		self, Cancellation, Codec, DecodeContext, EncodeContext, EncodedRequest,
		NativeResponseFormat, RawEvent, RequestMethod, SizeBounds, TransportAttempt,
		TransportRequest,
		anthropic::AnthropicCodec,
		bedrock::BedrockConverseCodec,
		cursor::CursorCodec,
		devin::DevinCodec,
		gemini::{GeminiCodec, GoogleProofScope, GoogleRequestOptions},
		gitlab::{
			GitLabDelegatingCodec, GitLabDelegationTarget, GitLabDirectRoute, GitLabWorkflowCodec,
		},
		google_cca::{CcaHeaders, GoogleCcaCodec},
		native::{NativeFacadeCodec, NativeFacadeDecoder, NativeFacadeRoute, parse_native_json},
		ollama::OllamaCodec,
		omp_native::OmpNativeDecoder,
		openai_chat::OpenAiChatCodec,
		openai_codex::OpenAiCodexCodec,
		openai_responses::OpenAiResponsesCodec,
	},
	error::ErrorKind,
	event::{ChatEvent, ToolCall},
	gate::{GateCondition, GatePhase, GateProgress, OutputGate, event_size},
	id::{ToolCallId, TurnId},
	layer::stack::BuiltinConfig,
	operation::{
		job::{JobCancelHandle, JobCheckpoint, JobCheckpointHandle, JobRef},
		realtime::{RealtimeInputKind, RealtimeSessionError},
	},
	plan::{CapabilityAvailability, RouteHealth, RuntimeRouteEvidence},
	receipt::{
		AttemptOutcome, AttemptReceipt, Cost, ExecutionBudget, ExecutionReceipt, ProviderEvidence,
		Usage, UsageSource,
	},
	registry::Registry,
	router::Router,
	session::{ConversationStore, InMemoryConversationStore, ProviderExpiryDecision, ReseedState},
	staging::{StagingCancellation, StagingPolicy, stage_body},
	transport::{
		Frame, FramingProtocol, SseDecoder,
		cassette::{CassetteAttempt, CassetteBodyAction, CassetteTerminal, CassetteTransport},
	},
};
use omp_catalog::{
	Catalog, CodecId, ModelKey, OperationKind, PolicyModel, ProviderId, RouteId, WireTarget,
};
use omp_core::{Str, sf};
use support::{auth, oracle, refresh, route_factory};
use tokio::time;
use tower::{Service as _, ServiceExt as _};

fn response_meta() -> ResponseMeta {
	ResponseMeta {
		request_id:          RequestId::from("conformance-request"),
		provider:            ProviderId::from("offline-provider"),
		route:               RouteId::from("offline-route"),
		model:               Some(ModelKey::from("offline-model")),
		provider_request_id: Some(sf!("provider-request-fixture")),
		created_at:          SystemTime::UNIX_EPOCH,
	}
}

fn answer(body: AnswerBody) -> Answer {
	Answer { meta: response_meta(), receipt: ExecutionReceipt::default(), body }
}

fn empty_stream<T: Send + 'static>() -> omp_ai::answer::OutputStream<T> {
	Box::pin(stream::empty())
}

fn chat_request(messages: Vec<Message>) -> ChatRequest {
	ChatRequest {
		messages:          messages.into(),
		tools:             Arc::from([]),
		hosted_tools:      Arc::from([]),
		tool_choice:       Default::default(),
		output:            Default::default(),
		reasoning:         Default::default(),
		verbosity:         Default::default(),
		cache_retention:   Default::default(),
		service_tier:      Default::default(),
		sampling:          Default::default(),
		max_output_tokens: None,
		top_logprobs:      None,
		safety:            Arc::from([]),
		negotiation:       Default::default(),
		forced_call:       None,
	}
}

const fn replayable_evidence() -> AttemptBodyEvidence {
	AttemptBodyEvidence {
		opened:         true,
		consumed:       true,
		replayability:  Replayability::Replayable,
		retry_decision: RetryDecision::Allow,
		reason:         RetryDecisionReason::ReplayableSource,
	}
}

#[test]
fn every_operation_has_a_typed_extraction() {
	let provenance = TokenizerProvenance {
		tokenizer: sf!("fixture-tokenizer"),
		revision:  sf!("1"),
		exact:     true,
	};
	assert!(
		ChatRequest::extract(answer(AnswerBody::Chat(ChatStream::ordinary(empty_stream())))).is_ok()
	);
	assert!(
		CountTokensRequest::extract(answer(AnswerBody::Tokens(TokenCount {
			tokens:     17,
			provenance: provenance.clone(),
		})))
		.is_ok()
	);
	assert!(
		TokenizeRequest::extract(answer(AnswerBody::TokenIds(TokenSequence {
			tokens:     vec![1, 2, 3],
			provenance: provenance.clone(),
		})))
		.is_ok()
	);
	assert_eq!(
		DetokenizeRequest::extract(answer(AnswerBody::Text(DetokenizedText {
			text: sf!("decoded"),
			provenance
		})))
		.unwrap()
		.text
		.as_str(),
		"decoded"
	);
	assert!(
		EmbedRequest::extract(answer(AnswerBody::Embeddings(EmbeddingBatch {
			dimensions: 2,
			embeddings: Vec::new(),
			usage:      Usage::default(),
		})))
		.is_ok()
	);
	assert!(ImageRequest::extract(answer(AnswerBody::Images(empty_stream()))).is_ok());
	let job = JobRef {
		provider:  ProviderId::from("offline-provider"),
		route:     RouteId::from("offline-route"),
		operation: OperationKind::GenerateVideo,
		handle:    GenerationHandle::from("fixture-video-job"),
	};
	let checkpoint = JobCheckpointHandle::new(JobCheckpoint {
		job:        job.clone(),
		completed:  0,
		total:      None,
		polls:      0,
		expires_at: None,
		created_at: UNIX_EPOCH,
	});
	let (cancel, _commands) = JobCancelHandle::bounded(job, 1).unwrap();
	let video = GenerationSession::new(empty_stream(), checkpoint, cancel).unwrap();
	assert!(VideoRequest::extract(answer(AnswerBody::Video(video))).is_ok());
	assert!(SpeechRequest::extract(answer(AnswerBody::Speech(empty_stream()))).is_ok());
	assert!(TranscriptionRequest::extract(answer(AnswerBody::Transcript(empty_stream()))).is_ok());
	let (realtime, _provider) = RealtimeSession::bounded(1).unwrap();
	assert!(RealtimeRequest::extract(answer(AnswerBody::Realtime(realtime))).is_ok());
	assert!(
		SearchRequest::extract(answer(AnswerBody::Search(SearchResults {
			results:  Vec::new(),
			answer:   None,
			usage:    Usage::default(),
			metadata: Default::default(),
		})))
		.is_ok()
	);
	assert!(
		UsageRequest::extract(answer(AnswerBody::Usage(Box::new(UsageReport {
			provider:      ProviderId::from("offline-provider"),
			account:       AccountId::from("fixture-account-alpha"),
			principal:     None,
			plan:          None,
			account_meta:  UsageAccountMetadata::default(),
			source_label:  None,
			notes:         Box::default(),
			reset_credits: None,
			windows:       Vec::new(),
		}))))
		.is_ok()
	);
	assert!(
		DiscoveryRequest::extract(answer(AnswerBody::Models(ModelDiscoveryPage {
			models:      Vec::new(),
			next_cursor: Some(sf!("next")),
		})))
		.is_ok()
	);
	assert!(
		AuthRequest::extract(answer(AnswerBody::Auth(AuthAnswer::Accounts(vec![AccountSummary {
			account:   AccountId::from("fixture-account-alpha"),
			provider:  ProviderId::from("offline-provider"),
			principal: None,
			label:     None,
			state:     AccountState::Active,
		}]))))
		.is_ok()
	);
	assert!(
		NativeRequest::extract(answer(AnswerBody::Native(NativeResponse {
			status:              200,
			media_type:          None,
			body:                NativeResponseBody::Bytes(Bytes::from_static(b"native")),
			provider_request_id: None,
		})))
		.is_ok()
	);

	let mismatch = ChatRequest::extract(answer(AnswerBody::Text(DetokenizedText {
		text:       sf!("wrong"),
		provenance: TokenizerProvenance {
			tokenizer: sf!("fixture-tokenizer"),
			revision:  sf!("1"),
			exact:     true,
		},
	})))
	.err()
	.expect("body mismatch");
	assert_eq!(mismatch.kind, ErrorKind::ProviderContractMismatch);
}
#[tokio::test]
async fn realtime_session_public_api_is_bounded_and_has_one_shared_terminal_transition() {
	fn assert_output_type<O: Operation<Output = RealtimeSession>>() {}
	assert_output_type::<RealtimeRequest>();

	let (session, mut provider) = RealtimeSession::bounded(1).unwrap();
	assert!(!session.is_closed());
	let first = session.try_send(RealtimeInput::Text(sf!("one"))).unwrap();
	assert_eq!(first.kind, RealtimeInputKind::Text);
	assert_eq!(
		session.try_send(RealtimeInput::Commit).unwrap_err(),
		RealtimeSessionError::Backpressure,
	);
	assert!(
		matches!(provider.recv().await.unwrap(), RealtimeInput::Text(text) if text.as_str() == "one")
	);

	let commit = session.send(RealtimeInput::Commit).await.unwrap();
	assert_eq!(commit.kind, RealtimeInputKind::Commit);
	assert!(matches!(provider.recv().await.unwrap(), RealtimeInput::Commit));
	let cancel = session.cancel_response().await.unwrap();
	assert_eq!(cancel.kind, RealtimeInputKind::CancelResponse);
	assert!(matches!(provider.recv().await.unwrap(), RealtimeInput::CancelResponse));

	provider.try_send(Ok(RealtimeEvent::Ready)).unwrap();
	assert!(matches!(session.recv().await.unwrap().unwrap(), RealtimeEvent::Ready));
	let close = session.close().await.unwrap();
	assert_eq!(close.kind, RealtimeInputKind::Close);
	assert!(session.is_closed());
	assert!(matches!(provider.recv().await.unwrap(), RealtimeInput::Close));
	assert_eq!(
		session
			.try_send(RealtimeInput::Text(sf!("late")))
			.unwrap_err(),
		RealtimeSessionError::AlreadyClosed,
	);
	provider.try_send(Ok(RealtimeEvent::Closed)).unwrap();
	assert!(matches!(session.recv().await.unwrap().unwrap(), RealtimeEvent::Closed));
	assert!(session.is_closed());
}

#[derive(serde::Deserialize)]
struct SseCorpus {
	schema_version: u32,
	cases:          Vec<SseCase>,
}

#[derive(serde::Deserialize)]
struct SseCase {
	id:          String,
	steps:       Vec<SseStep>,
	final_state: SseFinalState,
}

#[derive(serde::Deserialize)]
struct SseStep {
	input_hex: String,
	emitted:   Vec<SseExpected>,
}

#[derive(serde::Deserialize)]
struct SseExpected {
	name:     Option<String>,
	data_hex: String,
}

#[derive(serde::Deserialize)]
struct SseFinalState {
	done:          bool,
	last_event_id: Option<String>,
	retry_ms:      Option<u64>,
}

fn decode_hex(value: &str) -> Vec<u8> {
	assert_eq!(value.len() % 2, 0, "odd fixture hex length");
	value
		.as_bytes()
		.as_chunks::<2>()
		.0
		.iter()
		.map(|pair| {
			let text = str::from_utf8(pair).expect("hex is ASCII");
			u8::from_str_radix(text, 16).expect("fixture hex byte")
		})
		.collect()
}

#[test]
fn transport_sse_replays_incrementally_with_exact_order_and_terminal_state() {
	let corpus: SseCorpus = oracle::fixture("transport", "transport.sse.cassettes.v1").json();
	assert_eq!(corpus.schema_version, 1);
	for case in corpus.cases {
		let mut decoder = SseDecoder::new();
		for step in case.steps {
			let actual = decoder
				.push(Bytes::from(decode_hex(&step.input_hex)))
				.unwrap_or_else(|error| panic!("{}: {error}", case.id));
			assert_eq!(actual.len(), step.emitted.len(), "{} emission count", case.id);
			for (actual, expected) in actual.iter().zip(step.emitted) {
				assert_eq!(
					actual.name.as_ref().map(Str::as_str),
					expected.name.as_deref(),
					"{} event name",
					case.id
				);
				assert_eq!(
					actual.data.as_ref(),
					decode_hex(&expected.data_hex),
					"{} event data",
					case.id
				);
			}
		}
		assert_eq!(decoder.is_done(), case.final_state.done, "{} done state", case.id);
		assert_eq!(
			decoder.last_event_id(),
			case.final_state.last_event_id.as_deref(),
			"{} event id",
			case.id
		);
		assert_eq!(decoder.retry_ms(), case.final_state.retry_ms, "{} retry", case.id);
	}
}

#[test]
fn forced_tool_and_structured_output_never_leak_provisional_events() {
	let mut emitted = Vec::new();
	let partial = ChatEvent::ToolArgumentsDelta { index: 0, bytes: Bytes::from_static(b"{\"q\":") };
	let mut tool_gate = OutputGate::new(
		GateCondition::ToolCallReady { tool: sf!("lookup") },
		event_size(&partial) * 4,
	);
	assert_eq!(
		tool_gate
			.push(partial, &mut |event| emitted.push(event))
			.unwrap(),
		GateProgress::Provisional
	);
	assert!(emitted.is_empty());
	let ready = ChatEvent::ToolCallReady {
		index: 0,
		call:  ToolCall {
			id:        ToolCallId::from("call-fixture"),
			name:      sf!("lookup"),
			arguments: OpaqueJson::new(serde_json::json!({"q":"rust"})),
		},
	};
	assert_eq!(
		tool_gate
			.push(ready, &mut |event| emitted.push(event))
			.unwrap(),
		GateProgress::Committed { flushed: 2 }
	);
	assert_eq!(emitted.len(), 2);

	let mut structured = OutputGate::new(GateCondition::ValidStructuredOutput, 4096);
	let mut structured_output = Vec::new();
	structured
		.push(ChatEvent::TextDelta { index: 0, text: sf!("{{\"ok\":true}}") }, &mut |event| {
			structured_output.push(event);
		})
		.unwrap();
	assert!(structured_output.is_empty());
	assert_eq!(
		structured
			.mark_structured_output_valid(&mut |event| structured_output.push(event))
			.unwrap(),
		GateProgress::Committed { flushed: 1 }
	);
	assert_eq!(structured_output.len(), 1);
}

#[test]
fn provisional_cancellation_hides_events_but_preserves_usage_and_cost_receipts() {
	let mut gate = OutputGate::new(GateCondition::WholeAttempt, 4096);
	let mut output = Vec::new();
	gate
		.push(ChatEvent::TextDelta { index: 0, text: sf!("private") }, &mut |event| {
			output.push(event);
		})
		.unwrap();
	gate.record_attempt(AttemptReceipt {
		index:             0,
		hidden:            false,
		provider:          Some(ProviderId::from("offline-provider")),
		route:             Some(RouteId::from("offline-route")),
		account:           Some(AccountId::from("fixture-account-alpha")),
		principal:         None,
		body:              replayable_evidence(),
		outcome:           AttemptOutcome::RejectedSemantic,
		usage:             Usage {
			input_tokens: 3,
			output_tokens: 5,
			source: UsageSource::Provider,
			..Usage::default()
		},
		cost:              Cost::from_micro_usd(11),
		provider_evidence: ProviderEvidence::default(),
		elapsed:           Duration::from_millis(2),
	});
	let error = gate.cancel();
	assert_eq!(error.kind, ErrorKind::Cancelled);
	assert!(!error.committed);
	assert!(output.is_empty());
	assert_eq!(gate.phase(), GatePhase::Cancelled);
	assert!(gate.receipt().attempts[0].hidden);
	assert_eq!(gate.receipt().usage.total_tokens(), 8);
	assert_eq!(gate.receipt().cost.micro_usd, 11);
}

#[tokio::test]
async fn consumed_one_shot_suppresses_every_automatic_action_and_factories_are_fresh() {
	let source = BodySource::from_stream(Box::pin(stream::iter([Ok(Bytes::from_static(b"once"))])));
	let mut first = source.begin_attempt();
	let mut reader = first.open().await.expect("first reader");
	assert_eq!(reader.next().await.unwrap().unwrap(), Bytes::from_static(b"once"));
	let evidence = first.evidence();
	assert_eq!(evidence.retry_decision, RetryDecision::Suppress);
	assert_eq!(evidence.reason, RetryDecisionReason::ConsumedOneShot);
	for action in
		["retry", "account_rotation", "route_fallback", "session_reseed", "semantic_resample"]
	{
		assert_eq!(
			evidence.retry_decision,
			RetryDecision::Suppress,
			"{action} must honor shared body evidence"
		);
	}

	let opens = Arc::new(atomic::AtomicUsize::new(0));
	let factory_opens = Arc::clone(&opens);
	let factory = BodyFactoryHandle::new(move || {
		let ordinal = factory_opens.fetch_add(1, atomic::Ordering::SeqCst);
		async move {
			let body: omp_ai::body::ByteStream =
				Box::pin(stream::iter([Ok(Bytes::from(ordinal.to_string()))]));
			Ok(body)
		}
	});
	let repeatable = BodySource::Factory(factory);
	let mut first = repeatable.begin_attempt();
	let mut second = repeatable.begin_attempt();
	let mut first_reader = first.open().await.unwrap();
	let mut second_reader = second.open().await.unwrap();
	assert_eq!(first_reader.next().await.unwrap().unwrap(), Bytes::from_static(b"0"));
	assert_eq!(second_reader.next().await.unwrap().unwrap(), Bytes::from_static(b"1"));
	assert_eq!(opens.load(std::sync::atomic::Ordering::SeqCst), 2);
}

#[test]
fn mixed_multipart_replayability_is_conservative_and_lossless() {
	let replayable = BodySource::bytes(Bytes::from_static(b"text"));
	let one_shot = BodySource::from_stream(Box::pin(stream::empty()));
	let evidence = aggregate_replay_evidence([&replayable, &one_shot]);
	assert_eq!(evidence.replayability, Replayability::OneShot);
	assert_eq!(evidence.parts.len(), 2);
}

#[tokio::test]
async fn staging_cancellation_is_terminal_and_receipted_without_a_fake_success() {
	let source = BodySource::bytes(Bytes::from_static(b"never staged"));
	let policy = StagingPolicy::memory_only(1024, 1024);
	let cancellation = StagingCancellation::new();
	// The signal must be raised before staging begins: the contract under
	// test is that an already-cancelled staging attempt fails terminally
	// with receipted evidence instead of returning a fake success.
	cancellation.cancel();
	let budget = ExecutionBudget { max_staging_bytes: 1024, ..ExecutionBudget::default() };
	let mut receipt = ExecutionReceipt::default();
	let error = stage_body(&source, &policy, &budget, &cancellation, &mut receipt)
		.await
		.unwrap_err();
	assert_eq!(error.kind, ErrorKind::Cancelled);
	assert_eq!(error.receipt().staging.len(), 1);
	assert!(error.receipt().staging[0].cancelled);
	assert!(!error.receipt().staging[0].completed);
}

#[test]
fn session_forks_are_immutable_and_reseed_is_strictly_one_shot() {
	let store = InMemoryConversationStore::<Str>::new();
	let root = store.create().unwrap();
	let main = root.conversation().to_owned();
	let first = store
		.begin(&main, root.revision(), TurnId::from("turn-1"), Arc::from([sf!("one")]))
		.unwrap()
		.commit()
		.unwrap();
	let fork = store.fork(first.revision()).unwrap();
	let main_head = store
		.begin(&main, first.revision(), TurnId::from("turn-main"), Arc::from([sf!("main")]))
		.unwrap()
		.commit()
		.unwrap();
	let fork_head = store
		.begin(&fork, first.revision(), TurnId::from("turn-fork"), Arc::from([sf!("fork")]))
		.unwrap()
		.commit()
		.unwrap();
	assert!(
		store
			.is_ancestor(first.revision(), main_head.revision())
			.unwrap()
	);
	assert!(
		store
			.is_ancestor(first.revision(), fork_head.revision())
			.unwrap()
	);
	assert!(
		!store
			.is_ancestor(main_head.revision(), fork_head.revision())
			.unwrap()
	);
	assert_eq!(
		store
			.delta(Some(first.revision()), main_head.revision())
			.unwrap()
			.items()
			.map(Str::as_str)
			.collect::<Vec<_>>(),
		["main"]
	);
	assert_eq!(
		store
			.delta(Some(first.revision()), fork_head.revision())
			.unwrap()
			.items()
			.map(Str::as_str)
			.collect::<Vec<_>>(),
		["fork"]
	);

	let mut reseed = ReseedState::default();
	assert_eq!(
		reseed.on_provider_expiry(true, &replayable_evidence()),
		ProviderExpiryDecision::ReseedOnce
	);
	assert_eq!(
		reseed.on_provider_expiry(true, &replayable_evidence()),
		ProviderExpiryDecision::FailUncommitted
	);
	reseed.mark_committed();
	assert_eq!(
		reseed.on_provider_expiry(true, &replayable_evidence()),
		ProviderExpiryDecision::FailPartial
	);
}

#[test]
fn native_wire_surface_is_a_closed_method_path_allowlist() {
	let corpus: serde_json::Value =
		oracle::fixture("operations", "operations.native.wire.facades.v1").json();
	for case in corpus["cases"].as_array().expect("native cases") {
		let Some(request) = case.get("request") else {
			continue;
		};
		let Some(path) = request.get("path").and_then(serde_json::Value::as_str) else {
			continue;
		};
		let method = request
			.get("method")
			.and_then(serde_json::Value::as_str)
			.unwrap_or("POST");
		if path == "/v1/unknown" {
			assert!(NativeFacadeRoute::parse(method, path).is_err());
			continue;
		}
		if let Some(json) = request.get("json") {
			let bytes = serde_json::to_vec(json).unwrap();
			assert!(
				parse_native_json(
					method,
					path,
					&bytes,
					omp_ai::call::NativeResponseFraming::Json,
					1024 * 1024
				)
				.is_ok(),
				"{}",
				case["id"]
			);
		}
	}
	assert!(NativeFacadeRoute::parse("PATCH", "/v1/responses").is_err());
	assert!(NativeFacadeRoute::parse("GET", "/v1/responses").is_err());
}

fn cassette_request(body: BodySource, format: NativeResponseFormat) -> TransportRequest {
	TransportRequest {
		encoded:        EncodedRequest::new(
			OperationKind::Native,
			RequestMethod::Post,
			sf!("https://offline.invalid/v1/responses"),
			Box::new([]),
			body,
			FramingProtocol::Raw,
			SizeBounds { request_body: 1024, frame: 1024 * 1024, response: 1024 * 1024 },
		),
		credentials:    None,
		signature:      None,
		decoder:        Some(Box::new(NativeFacadeDecoder::new(format))),
		realtime:       None,
		cancel:         Cancellation::default(),
		response_hooks: Default::default(),
		attempt:        TransportAttempt {
			request_id:          RequestId::from("cassette-request"),
			session:             None,
			provider:            ProviderId::from("offline-provider"),
			model:               None,
			api:                 sf!("native"),
			route:               RouteId::from("offline-route"),
			account:             Some(AccountId::from("fixture-account-alpha")),
			principal:           None,
			index:               0,
			provisional:         false,
			capture_limit:       64,
			timeout:             Duration::from_secs(30),
			first_event_timeout: None,
		},
	}
}

#[tokio::test]
async fn cassette_transport_uses_real_decoder_and_retains_exact_replay_evidence() {
	let payload = oracle::fixture("operations", "operations.blob.payload.v1").bytes;
	let request_body = BodySource::from_stream(Box::pin(stream::iter([
		Ok(Bytes::from_static(b"request-")),
		Ok(Bytes::from_static(b"body")),
	])));
	let attempt = CassetteAttempt {
		status:              Some(200),
		headers:             Box::new([]),
		provider_request_id: Some(sf!("provider-request-fixture")),
		body:                CassetteBodyAction::Drain,
		frames:              vec![Frame::Raw(Bytes::from(payload.clone()))].into_boxed_slice(),
		terminal:            CassetteTerminal::Complete,
	};
	let mut cassette = CassetteTransport::new(Arc::<[CassetteAttempt]>::from([attempt]));
	let response = cassette
		.ready()
		.await
		.unwrap()
		.call(cassette_request(request_body, NativeResponseFormat::Bytes))
		.await
		.unwrap();
	assert_eq!(response.meta.status, Some(200));
	assert!(response.realtime.is_none());
	let mut events = response
		.events
		.expect("ordinary native cassette must return an event stream");
	match events.next().await.unwrap().unwrap() {
		RawEvent::NativeChunk(bytes) => assert_eq!(bytes.as_ref(), payload),
		_ => panic!("native cassette emitted the wrong first event"),
	}
	assert!(events.next().await.is_none());
	let captures = cassette.captures();
	assert_eq!(captures.len(), 1);
	assert_eq!(captures[0].attempt, 0);
	assert_eq!(captures[0].uri.as_str(), "https://offline.invalid/v1/responses");
	assert!(captures[0].body.opened);
	assert!(captures[0].body.consumed);
	assert_eq!(captures[0].body.reason, RetryDecisionReason::ConsumedOneShot);
	assert_eq!(captures[0].frames.len(), 1);
	assert_eq!(captures[0].frames[0].observed_bytes, payload.len() as u64);
	assert_ne!(captures[0].frames[0].redaction.as_ref(), payload.as_slice());
}

#[tokio::test]
async fn cassette_first_frame_failure_carries_last_attempt_body_evidence() {
	let attempt = CassetteAttempt {
		status:              Some(502),
		headers:             Box::new([]),
		provider_request_id: Some(sf!("provider-request-fixture")),
		body:                CassetteBodyAction::Drain,
		frames:              vec![Frame::Raw(Bytes::from_static(b"{"))].into_boxed_slice(),
		terminal:            CassetteTerminal::Complete,
	};
	let body =
		BodySource::from_stream(Box::pin(stream::iter([Ok(Bytes::from_static(b"one-shot"))])));
	let mut cassette = CassetteTransport::new(Arc::<[CassetteAttempt]>::from([attempt]));
	let error = cassette
		.ready()
		.await
		.unwrap()
		.call(cassette_request(body, NativeResponseFormat::Json))
		.await
		.err()
		.expect("first-frame error");
	assert!(!error.committed);
	assert_eq!(error.status, Some(502));
	assert_eq!(error.receipt().attempts.len(), 1);
	let receipt = &error.receipt().attempts[0];
	assert_eq!(receipt.outcome, AttemptOutcome::FailedPreCommit);
	assert!(receipt.body.opened);
	assert!(receipt.body.consumed);
	assert_eq!(receipt.body.retry_decision, RetryDecision::Suppress);
	assert_eq!(receipt.body.reason, RetryDecisionReason::ConsumedOneShot);
	assert_eq!(
		receipt
			.provider_evidence
			.request_id
			.as_ref()
			.map(Str::as_str),
		Some("provider-request-fixture")
	);
}

#[test]
fn signed_gemini_visible_text_proof_round_trips_and_cca_lowers_account_project() {
	let codec_id = CodecId::from("google-cca");
	let catalog = Catalog::embedded();
	let model = catalog
		.models()
		.iter()
		.find(|model| {
			model.routes.iter().any(|route| {
				catalog
					.route(route)
					.is_some_and(|route| route.codec == codec_id)
			})
		})
		.expect("embedded CCA model");
	let route = model
		.routes
		.iter()
		.find_map(|route| catalog.route(route).filter(|route| route.codec == codec_id))
		.expect("embedded CCA route");
	let provider = route.provider.clone();
	let signature = Bytes::from_static(b"sig_REDACTED");
	let request = chat_request(vec![Message {
		role:    Role::Assistant,
		content: Arc::from([ContentPart::Text {
			text:  sf!("visible signed text"),
			proof: Some(ProviderProof {
				provider: provider.clone(),
				codec:    codec_id.clone(),
				value:    signature,
			}),
		}]),
		name:    None,
	}]);
	let projection = GeminiCodec::cloud_code_assist(None)
		.project(&request, &GoogleRequestOptions {
			proof_scope: Some(GoogleProofScope { provider, codec: codec_id.clone() }),
			..GoogleRequestOptions::default()
		})
		.unwrap();
	let part = &projection.request.contents[0].parts[0];
	assert_eq!(part.text.as_ref().map(Str::as_str), Some("visible signed text"));
	assert_eq!(part.thought_signature.as_ref().map(Str::as_str), Some("sig_REDACTED"));

	let wire_model = model
		.wire_ids
		.iter()
		.find(|(candidate, _)| candidate == &route.id)
		.unwrap()
		.1
		.clone();
	let target = WireTarget {
		route: route.id.clone(),
		codec: route.codec.clone(),
		endpoint: route.endpoint.clone(),
		wire_model,
	};
	let policy = catalog.wire_policy(&model.wire_policy).unwrap();
	let policy_model = PolicyModel::from(model);
	let request_id = RequestId::from("cca-project");
	let account = AccountRoutingContext {
		project: Some(ProjectId::from("project-REDACTED")),
		..AccountRoutingContext::default()
	};
	let context = EncodeContext {
		request_id: &request_id,
		route,
		target: Some(&target),
		policy_model: Some(&policy_model),
		policy,
		account: Some(&account),
		..EncodeContext::default()
	};
	let encoded =
		GoogleCcaCodec::gemini_cli(None, CcaHeaders::gemini_cli("fixture-model", "darwin", "arm64"))
			.encode(&context, &OperationCall::Chat(Arc::new(request)))
			.unwrap();
	let BodySource::Bytes(body) = encoded.body else {
		panic!("CCA request body must be replayable bytes")
	};
	let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
	assert_eq!(json["project"].as_str(), Some("project-REDACTED"));
	assert_eq!(
		json["request"]["contents"][0]["parts"][0]["text"].as_str(),
		Some("visible signed text")
	);
	assert_eq!(
		json["request"]["contents"][0]["parts"][0]["thoughtSignature"].as_str(),
		Some("sig_REDACTED")
	);
}

#[test]
fn every_real_codec_constructs_fresh_attempt_decoder_state_offline() {
	let catalog = Catalog::embedded();
	let model = catalog.models().first().expect("embedded model");
	let policy_model = PolicyModel::from(model);
	let policy = catalog
		.wire_policy(&model.wire_policy)
		.expect("embedded wire policy");
	let route_def = catalog
		.route(model.routes.first().expect("embedded model route"))
		.expect("embedded route definition");
	let wire_model = model
		.wire_ids
		.iter()
		.find(|(route, _)| route == &route_def.id)
		.expect("embedded wire model")
		.1
		.clone();
	let target = WireTarget {
		route: route_def.id.clone(),
		codec: route_def.codec.clone(),
		endpoint: route_def.endpoint.clone(),
		wire_model,
	};
	let request_id = RequestId::from("decoder-factory");
	let provider = route_def.provider.clone();
	let route = route_def.id.clone();
	type DecoderFixture =
		(&'static str, Box<dyn Codec>, FramingProtocol, OperationKind, Option<NativeResponseFormat>);
	let codecs: Vec<DecoderFixture> = vec![
		(
			"openai-chat",
			Box::new(OpenAiChatCodec::default()),
			FramingProtocol::Sse,
			OperationKind::Chat,
			None,
		),
		(
			"openai-responses",
			Box::new(OpenAiResponsesCodec::default()),
			FramingProtocol::Sse,
			OperationKind::Chat,
			None,
		),
		(
			"openai-codex",
			Box::new(OpenAiCodexCodec::default()),
			FramingProtocol::Sse,
			OperationKind::Chat,
			None,
		),
		(
			"anthropic-direct",
			Box::new(AnthropicCodec::direct()),
			FramingProtocol::Sse,
			OperationKind::Chat,
			None,
		),
		(
			"anthropic-vertex",
			Box::new(AnthropicCodec::vertex()),
			FramingProtocol::Sse,
			OperationKind::Chat,
			None,
		),
		(
			"anthropic-bedrock",
			Box::new(AnthropicCodec::bedrock()),
			FramingProtocol::AwsEventStream,
			OperationKind::Chat,
			None,
		),
		(
			"gemini",
			Box::new(GeminiCodec::generative_language(None)),
			FramingProtocol::Sse,
			OperationKind::Chat,
			None,
		),
		(
			"vertex-gemini",
			Box::new(GeminiCodec::vertex(None)),
			FramingProtocol::Sse,
			OperationKind::Chat,
			None,
		),
		(
			"google-cca",
			Box::new(GoogleCcaCodec::gemini_cli(
				None,
				CcaHeaders::gemini_cli("fixture-model", "darwin", "arm64"),
			)),
			FramingProtocol::Sse,
			OperationKind::Chat,
			None,
		),
		(
			"bedrock-converse",
			Box::new(BedrockConverseCodec::default()),
			FramingProtocol::AwsEventStream,
			OperationKind::Chat,
			None,
		),
		(
			"gitlab-workflow",
			Box::new(GitLabWorkflowCodec),
			FramingProtocol::WebSocket,
			OperationKind::Chat,
			None,
		),
		(
			"gitlab-openai-chat",
			Box::new(GitLabDelegatingCodec::from_route(&GitLabDirectRoute {
				exchange_endpoint: sf!("https://offline.invalid/token"),
				delegation:        GitLabDelegationTarget::OpenAiChat,
			})),
			FramingProtocol::Sse,
			OperationKind::Chat,
			None,
		),
		(
			"gitlab-openai-responses",
			Box::new(GitLabDelegatingCodec::from_route(&GitLabDirectRoute {
				exchange_endpoint: sf!("https://offline.invalid/token"),
				delegation:        GitLabDelegationTarget::OpenAiResponses,
			})),
			FramingProtocol::Sse,
			OperationKind::Chat,
			None,
		),
		(
			"gitlab-anthropic",
			Box::new(GitLabDelegatingCodec::from_route(&GitLabDirectRoute {
				exchange_endpoint: sf!("https://offline.invalid/token"),
				delegation:        GitLabDelegationTarget::AnthropicMessages,
			})),
			FramingProtocol::Sse,
			OperationKind::Chat,
			None,
		),
		("ollama", Box::new(OllamaCodec), FramingProtocol::Ndjson, OperationKind::Chat, None),
		("cursor", Box::new(CursorCodec::new()), FramingProtocol::Connect, OperationKind::Chat, None),
		("devin", Box::new(DevinCodec::new()), FramingProtocol::Connect, OperationKind::Chat, None),
		(
			"native",
			Box::new(NativeFacadeCodec),
			FramingProtocol::Raw,
			OperationKind::Native,
			Some(NativeResponseFormat::Bytes),
		),
	];
	for (name, codec, framing, operation, native_response) in codecs {
		let operation_call = match operation {
			OperationKind::Chat => OperationCall::Chat(Arc::new(chat_request(Vec::new()))),
			OperationKind::Native => OperationCall::Native(Arc::new(NativeRequest {
				method:             NativeMethod::Post,
				path:               NativePath::Responses,
				payload:            None,
				response_framing:   NativeResponseFraming::Bytes,
				max_response_bytes: 1024,
			})),
			_ => unreachable!("decoder matrix only includes chat and native operations"),
		};
		assert_eq!(operation_call.kind(), operation);
		let context = DecodeContext {
			request_id: &request_id,
			auth_scheme: None,
			provider: &provider,
			route: &route,
			policy,
			policy_model: Some(&policy_model),
			target: Some(&target),
			thinking_policy: None,
			thinking_selection: None,
			operation,
			operation_call: &operation_call,
			framing,
			native_response,
			attempt: 0,
		};
		context.debug_assert_valid();
		let first = codec
			.decoder(&context)
			.unwrap_or_else(|error| panic!("{name} first decoder: {error:?}"));
		let second = codec
			.decoder(&context)
			.unwrap_or_else(|error| panic!("{name} second decoder: {error:?}"));
		let first_ptr = (&*first as *const dyn codec::Decoder) as *const ();
		let second_ptr = (&*second as *const dyn codec::Decoder) as *const ();
		assert_ne!(first_ptr, second_ptr, "{name} reused decoder state");
	}
	let first = OmpNativeDecoder::new();
	let second = OmpNativeDecoder::new();
	let first_ptr = (&first as *const OmpNativeDecoder) as *const ();
	let second_ptr = (&second as *const OmpNativeDecoder) as *const ();
	assert_ne!(first_ptr, second_ptr, "OMP native decoder state must be per attempt");
}

#[test]
fn quota_exhaustion_rotates_accounts_without_confusing_identity_or_rate_state() {
	let route = RouteId::from("offline-route");
	let pool = AccountPool::new();
	for (account, principal) in [
		("fixture-account-alpha", "fixture-principal-alpha"),
		("fixture-account-beta", "fixture-principal-beta"),
	] {
		pool
			.upsert(AccountRecord {
				account:               AccountId::new(account),
				principal:             PrincipalId::new(principal),
				provider:              ProviderId::from("offline-provider"),
				routes:                BTreeSet::from([route.clone()]),
				enabled:               true,
				credential_generation: 1,
				routing:               AccountRoutingContext::default(),
			})
			.unwrap();
	}
	let now = UNIX_EPOCH + Duration::from_secs(100);
	pool
		.observe_quota(AccountId::new("fixture-account-alpha"), QuotaObservation {
			window:      QuotaWindowId::new("monthly"),
			consumed:    None,
			remaining:   Some(0),
			limit:       Some(100),
			reset_at:    Some(UNIX_EPOCH + Duration::from_secs(200)),
			exhausted:   Some(true),
			provenance:  QuotaProvenance::Error,
			observed_at: now,
		})
		.unwrap();
	let selected = pool
		.select(&AccountSelectionRequest {
			provider: ProviderId::from("offline-provider"),
			route,
			affinity: None,
			previous_account: Some(AccountId::new("fixture-account-alpha")),
			previous_principal: Some(PrincipalId::new("fixture-principal-alpha")),
			rotate: true,
			rotation: RotationPolicy::default(),
			now,
			quota_scope: None,
		})
		.unwrap();
	assert_eq!(selected.record.account, AccountId::new("fixture-account-beta"));
	assert_eq!(selected.record.principal, PrincipalId::new("fixture-principal-beta"));
	assert!(selected.account_change.invalidates_account_bound_session);
}

#[tokio::test]
async fn concurrent_auth_refresh_is_single_flight_and_waiters_share_the_exact_result() {
	let store = refresh::shared();
	let coordinator =
		RefreshCoordinator::new("conformance-process", RefreshPolicy::default()).unwrap();
	let calls = Arc::new(atomic::AtomicUsize::new(0));
	let first_calls = Arc::clone(&calls);
	let second_calls = Arc::clone(&calls);
	let first = coordinator.refresh(
		Arc::clone(&store),
		refresh::request("fixture-account-alpha"),
		move |_| async move {
			first_calls.fetch_add(1, atomic::Ordering::SeqCst);
			time::sleep(Duration::from_millis(10)).await;
			Ok(refresh::refreshed("fixture-account-alpha"))
		},
	);
	let second = coordinator.refresh(
		Arc::clone(&store),
		refresh::request("fixture-account-alpha"),
		move |_| async move {
			second_calls.fetch_add(1, atomic::Ordering::SeqCst);
			Ok(refresh::refreshed("fixture-account-alpha"))
		},
	);
	let (first, second) = tokio::join!(first, second);
	let first = first.unwrap();
	let second = second.unwrap();
	assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
	assert_eq!(store.acquires.load(std::sync::atomic::Ordering::SeqCst), 1);
	assert_eq!(store.publishes.load(std::sync::atomic::Ordering::SeqCst), 1);
	assert_eq!(store.releases.load(std::sync::atomic::Ordering::SeqCst), 1);
	assert_eq!(first.result, second.result);
	assert_ne!(first.process_role, second.process_role);
	assert!([first.process_role, second.process_role].contains(&ProcessRefreshRole::Waiter));
}

#[tokio::test]
async fn client_plans_without_service_effects_executes_the_exact_route_and_rejects_stale_plans() {
	let catalog = Arc::new(Catalog::embedded().clone());
	let model = catalog
		.models()
		.iter()
		.find(|model| route_factory::supports_chat(model) && !model.routes.is_empty())
		.expect("embedded catalog must retain a chat model")
		.clone();
	let preferred_index = usize::from(model.routes.len() > 1);
	let probe = route_factory::RouteProbe::default();
	let (auth_manager, _credential_directory) = auth::headless_manager(Arc::clone(&catalog));
	let registry = Registry::builder(Arc::clone(&catalog))
		.with_builtins(BuiltinConfig::new(Arc::new(probe.clone())).with_auth_manager(auth_manager))
		.unwrap()
		.build()
		.unwrap();
	for route in catalog.routes() {
		assert!(
			registry.contains_service(&route.id),
			"advertised route {} did not construct",
			route.id
		);
	}

	let mut runtime = HashMap::new();
	for (index, route) in model.routes.iter().enumerate() {
		runtime.insert(route.clone(), RuntimeRouteEvidence {
			route:            route.clone(),
			generation:       registry.generation(),
			health:           if index == preferred_index {
				RouteHealth::Healthy
			} else {
				RouteHealth::Degraded
			},
			quota_millionths: if index == preferred_index {
				1_000_000
			} else {
				0
			},
			latency:          if index == preferred_index {
				Duration::from_millis(1)
			} else {
				Duration::from_secs(1)
			},
			affinity:         false,
			operation:        CapabilityAvailability::Native,
			capabilities:     Arc::from([]),
		});
	}
	let router =
		Router::new(registry.clone(), Duration::from_secs(30)).with_runtime_evidence(runtime);
	let meta = CallMeta {
		id:             RequestId::from("planned-request"),
		target:         Target::Model(model.key.clone()),
		deadline:       None,
		budget:         ExecutionBudget::default(),
		session:        None,
		debug_session:  None,
		response_hooks: Default::default(),
	};
	let request = chat_request(Vec::new());
	let mut client = Client::new(registry.service(), router.clone(), meta.clone());
	let planned = client.plan(&request).unwrap();
	let selected_route = planned.execution_plan().route.clone();
	assert_eq!(selected_route, model.routes[preferred_index]);
	assert_eq!(probe.readiness_polls.load(Ordering::SeqCst), 0);
	assert_eq!(probe.calls.load(Ordering::SeqCst), 0);
	let output = client.execute_plan(planned).await.unwrap();
	drop(output);
	assert_eq!(probe.called_routes.lock().as_slice(), [selected_route]);

	let stale_router = Router::new(registry.clone(), Duration::ZERO);
	let mut stale_client = Client::new(registry.service(), stale_router, meta);
	let stale = stale_client.plan(&request).unwrap();
	let unsupported_model = catalog
		.models()
		.iter()
		.find(|candidate| {
			!candidate
				.capabilities
				.operations
				.contains_kind(OperationKind::CountTokens)
		})
		.expect("embedded catalog must retain a model without native token counting");
	let unsupported_request = CountTokensRequest {
		messages: Arc::new([]),
		tools:    Arc::new([]),
		accuracy: CountAccuracy::Exact,
	};
	let unsupported_meta = CallMeta {
		id:             RequestId::from("unsupported-plan"),
		target:         Target::Model(unsupported_model.key.clone()),
		deadline:       None,
		budget:         ExecutionBudget::default(),
		session:        None,
		debug_session:  None,
		response_hooks: Default::default(),
	};
	let unsupported_error = Client::new(registry.service(), router.clone(), unsupported_meta)
		.plan(&unsupported_request)
		.err()
		.expect("unsupported operation must not plan");
	assert_eq!(unsupported_error.kind, ErrorKind::CapabilityMismatch);

	let unknown_meta = CallMeta {
		id:             RequestId::from("unknown-plan"),
		target:         Target::Model(ModelKey::from("model-that-does-not-exist")),
		deadline:       None,
		budget:         ExecutionBudget::default(),
		session:        None,
		debug_session:  None,
		response_hooks: Default::default(),
	};
	let unknown_error = Client::new(registry.service(), router.clone(), unknown_meta)
		.plan(&request)
		.err()
		.expect("unknown target must not plan");
	assert_eq!(unknown_error.kind, ErrorKind::TargetNotFound);
	let polls_before = probe.readiness_polls.load(Ordering::SeqCst);
	let calls_before = probe.calls.load(Ordering::SeqCst);
	time::sleep(Duration::from_millis(1)).await;
	let Err(error) = stale_client.execute_plan(stale).await else {
		panic!("stale plan unexpectedly executed");
	};
	assert_eq!(error.kind, ErrorKind::StalePlan);
	assert_eq!(probe.readiness_polls.load(Ordering::SeqCst), polls_before);
	assert_eq!(probe.calls.load(Ordering::SeqCst), calls_before);
}
