#![cfg(any(test, feature = "test-support"))]

//! Deterministic, secret-safe provider scripts for tests and opt-in test
//! support.
//!
//! This module deliberately implements the same erased [`ProviderService`]
//! boundary as a real provider. Scripts are consumed once, in insertion order,
//! and an unconfigured or mismatched call fails with
//! [`ErrorKind::ProviderContractMismatch`]. No production fallback is provided.

use std::{
	collections::VecDeque,
	future::poll_fn,
	mem,
	sync::{
		Arc,
		atomic::{AtomicBool, Ordering},
	},
	task::{Context, Poll},
	time::SystemTime,
};

use futures::{future::BoxFuture, stream, task::AtomicWaker};
use omp_core::{Str, sf};
use parking_lot::Mutex;
use tower::Service;

use super::ProviderService;
use crate::{
	answer::{
		Answer, AnswerBody, AnswerKind, AudioChunk, AuthAnswer, ChatStream, DetokenizedText,
		EmbeddingBatch, GenerationEvent, GenerationSession, ImageArtifact, ModelDiscoveryPage,
		NativeResponse, RealtimeSession, ResponseMeta, SearchResults, TokenCount, TokenSequence,
		TranscriptEvent, UsageReport, VideoArtifact,
	},
	call::{AuthRequest, Call, MediaInput, NativePayload, OperationCall},
	catalog::{ModelKey, OperationKind, ProviderId, RouteId},
	error::{Error, ErrorDetail, ErrorKind, ErrorPhase, RetryAction},
	event::ChatEvent,
	id::RequestId,
	operation::parallel_extract::ParallelExtractResult,
	receipt::{AttemptReceipt, ExecutionBudget, ExecutionReceipt, ReasonId},
};

/// A clone-cheap deterministic provider whose clones share scripts and
/// captures.
#[derive(Clone)]
pub struct FakeProvider {
	provider: ProviderId,
	route:    RouteId,
	state:    Arc<Mutex<FakeState>>,
}

#[derive(Default)]
struct FakeState {
	scripts: VecDeque<FakeScript>,
	calls:   Vec<CapturedCall>,
}

impl FakeProvider {
	/// Creates an empty fake for the selected provider and route identities.
	pub fn new(provider: ProviderId, route: RouteId) -> Self {
		Self { provider, route, state: Arc::new(Mutex::new(FakeState::default())) }
	}

	/// Appends one script to the shared deterministic queue.
	pub fn push(&self, script: FakeScript) {
		self.state.lock().scripts.push_back(script);
	}

	/// Appends several scripts in iteration order.
	pub fn extend(&self, scripts: impl IntoIterator<Item = FakeScript>) {
		self.state.lock().scripts.extend(scripts);
	}

	/// Returns the number of scripts not yet consumed by readiness rejection or
	/// a call.
	pub fn remaining(&self) -> usize {
		self.state.lock().scripts.len()
	}

	/// Returns a snapshot of secret-safe captured calls.
	pub fn calls(&self) -> Vec<CapturedCall> {
		self.state.lock().calls.clone()
	}

	/// Removes and returns all secret-safe captured calls.
	pub fn take_calls(&self) -> Vec<CapturedCall> {
		mem::take(&mut self.state.lock().calls)
	}

	/// Erases this fake through the construction-time provider service boundary.
	pub fn into_service(self) -> ProviderService {
		ProviderService::new(self)
	}
}

impl Service<Call> for FakeProvider {
	type Error = Error;
	type Future = BoxFuture<'static, Result<Answer, Error>>;
	type Response = Answer;

	fn poll_ready(&mut self, context: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
		let mut state = self.state.lock();
		let Some(script) = state.scripts.front_mut() else {
			return Poll::Ready(Ok(()));
		};
		if script.readiness_pending > 0 {
			script.readiness_pending -= 1;
			context.waker().wake_by_ref();
			return Poll::Pending;
		}
		if script.readiness_error.is_some() {
			let mut script = state.scripts.pop_front().expect("front script exists");
			return Poll::Ready(Err(
				script
					.readiness_error
					.take()
					.expect("readiness error exists"),
			));
		}
		Poll::Ready(Ok(()))
	}

	fn call(&mut self, call: Call) -> Self::Future {
		let actual = call.operation.kind();
		let request_id = call.id.clone();
		let mut state = self.state.lock();
		state.calls.push(CapturedCall::from_call(&call));
		let Some(script) = state.scripts.pop_front() else {
			return Box::pin(async move {
				Err(contract_error(
					request_id,
					"fake-provider-unconfigured",
					ExecutionReceipt::default(),
				))
			});
		};
		drop(state);

		if script.operation != actual {
			let receipt = script.receipt;
			return Box::pin(async move {
				Err(contract_error(request_id, "fake-provider-operation-mismatch", receipt))
			});
		}

		let provider = self.provider.clone();
		let route = self.route.clone();
		match script.outcome {
			FakeOutcome::Answer(answer) => {
				let receipt = script.receipt;
				let created_at = script.created_at;
				if answer.kind() != expected_answer_kind(actual) {
					return Box::pin(async move {
						Err(
							Error::new(
								ErrorKind::Protocol,
								ErrorPhase::Handshake,
								RetryAction::Never,
								receipt,
							)
							.detail(ErrorDetail::protocol(ReasonId(sf!(
								"fake scripted answer body mismatches operation",
							)))),
						)
					});
				}
				let answer = *answer;
				Box::pin(async move {
					Ok(Answer {
						meta: ResponseMeta {
							request_id,
							provider,
							route,
							model: None,
							provider_request_id: None,
							created_at,
						},
						receipt,
						body: answer.into_body(),
					})
				})
			},
			FakeOutcome::Error(error) => {
				let error = error.request_id(request_id);
				let error = if error.provider.is_none() {
					error.provider(provider)
				} else {
					error
				};
				let mut error = if error.route.is_none() {
					error.route(route)
				} else {
					error
				};
				error.replace_receipt(script.receipt);
				Box::pin(async move { Err(error) })
			},
			FakeOutcome::Cancelled(cancellation) => {
				let receipt = script.receipt;
				Box::pin(async move {
					poll_fn(|context| cancellation.poll_cancelled(context)).await;
					Err(
						Error::new(
							ErrorKind::Cancelled,
							ErrorPhase::Streaming,
							RetryAction::Never,
							receipt,
						)
						.provider(provider)
						.route(route)
						.request_id(request_id),
					)
				})
			},
		}
	}
}

/// One queued provider interaction.
pub struct FakeScript {
	operation:           OperationKind,
	outcome:             FakeOutcome,
	readiness_pending:   usize,
	readiness_error:     Option<Error>,
	receipt:             ExecutionReceipt,
	model:               Option<ModelKey>,
	provider_request_id: Option<Str>,
	created_at:          SystemTime,
}

enum FakeOutcome {
	Answer(Box<FakeAnswer>),
	Error(Error),
	Cancelled(FakeCancellation),
}

impl FakeScript {
	/// Creates a script from an operation and exact typed answer body.
	///
	/// Prefer the operation-specific constructors below. This general
	/// constructor is useful for tests that intentionally prove typed body
	/// mismatch handling.
	pub fn answer(operation: OperationKind, answer: FakeAnswer) -> Self {
		Self::new(operation, FakeOutcome::Answer(Box::new(answer)))
	}

	/// Scripts canonical chat events, including exact terminal stream errors.
	pub fn chat(events: Vec<Result<ChatEvent, Error>>) -> Self {
		Self::answer(OperationKind::Chat, FakeAnswer::Chat(events))
	}

	/// Scripts an exact token-count result.
	pub fn count_tokens(answer: TokenCount) -> Self {
		Self::answer(OperationKind::CountTokens, FakeAnswer::Tokens(answer))
	}

	/// Scripts an exact tokenization result.
	pub fn tokenize(answer: TokenSequence) -> Self {
		Self::answer(OperationKind::Tokenize, FakeAnswer::TokenIds(answer))
	}

	/// Scripts exact detokenized text.
	pub fn detokenize(answer: DetokenizedText) -> Self {
		Self::answer(OperationKind::Detokenize, FakeAnswer::Text(answer))
	}

	/// Scripts an exact embedding batch.
	pub fn embed(answer: EmbeddingBatch) -> Self {
		Self::answer(OperationKind::Embed, FakeAnswer::Embeddings(answer))
	}

	/// Scripts image generation events and exact stream errors.
	pub fn images(events: Vec<Result<GenerationEvent<ImageArtifact>, Error>>) -> Self {
		Self::answer(OperationKind::GenerateImage, FakeAnswer::Images(events))
	}

	/// Scripts an owned video generation job session.
	pub fn video(session: GenerationSession<VideoArtifact>) -> Self {
		Self::answer(OperationKind::GenerateVideo, FakeAnswer::Video(session))
	}

	/// Scripts encoded speech chunks and exact stream errors.
	pub fn speech(chunks: Vec<Result<AudioChunk, Error>>) -> Self {
		Self::answer(OperationKind::Speak, FakeAnswer::Speech(chunks))
	}

	/// Scripts transcript events and exact stream errors.
	pub fn transcript(events: Vec<Result<TranscriptEvent, Error>>) -> Self {
		Self::answer(OperationKind::Transcribe, FakeAnswer::Transcript(events))
	}

	/// Scripts an owned bidirectional realtime session.
	pub fn realtime(session: RealtimeSession) -> Self {
		Self::answer(OperationKind::Realtime, FakeAnswer::Realtime(session))
	}

	/// Scripts exact standalone search results.
	pub fn search(answer: SearchResults) -> Self {
		Self::answer(OperationKind::Search, FakeAnswer::Search(answer))
	}

	/// Scripts an exact Parallel extraction result.
	pub fn parallel_extract(answer: ParallelExtractResult) -> Self {
		Self::answer(OperationKind::Extract, FakeAnswer::ParallelExtract(answer))
	}

	/// Scripts an exact account usage report.
	pub fn usage(answer: UsageReport) -> Self {
		Self::answer(OperationKind::Usage, FakeAnswer::Usage(Box::new(answer)))
	}

	/// Scripts an exact model discovery page.
	pub fn discover_models(answer: ModelDiscoveryPage) -> Self {
		Self::answer(OperationKind::DiscoverModels, FakeAnswer::Models(answer))
	}

	/// Scripts an exact authentication result or owned authentication session.
	pub fn auth(answer: AuthAnswer) -> Self {
		Self::answer(OperationKind::Auth, FakeAnswer::Auth(answer))
	}

	/// Scripts an exact bounded native response, including an optional byte
	/// stream.
	pub fn native(answer: NativeResponse) -> Self {
		Self::answer(OperationKind::Native, FakeAnswer::Native(answer))
	}

	/// Scripts a structured failure before ordinary output commits.
	pub fn precommit(operation: OperationKind, error: Error) -> Self {
		let error = error.committed(false);
		let receipt = error.receipt().clone();
		Self { receipt, ..Self::new(operation, FakeOutcome::Error(error)) }
	}

	/// Scripts a structured failure after ordinary output commits.
	pub fn committed(operation: OperationKind, error: Error) -> Self {
		let error = error.committed(true);
		let receipt = error.receipt().clone();
		Self { receipt, ..Self::new(operation, FakeOutcome::Error(error)) }
	}

	/// Scripts a call that remains pending until the returned handle is
	/// cancelled.
	pub fn cancellable(operation: OperationKind) -> (Self, FakeCancellation) {
		let cancellation = FakeCancellation::default();
		(Self::new(operation, FakeOutcome::Cancelled(cancellation.clone())), cancellation)
	}

	/// Makes readiness return `Pending` exactly `polls` times before becoming
	/// ready.
	pub const fn readiness_pending(mut self, polls: usize) -> Self {
		self.readiness_pending = polls;
		self
	}

	/// Makes readiness reject this script after any configured pending polls.
	///
	/// A readiness-rejected script is consumed and its call outcome is never
	/// used.
	pub fn readiness_error(mut self, error: Error) -> Self {
		self.readiness_error = Some(error);
		self
	}

	/// Replaces the exact answer or error receipt.
	pub fn receipt(mut self, receipt: ExecutionReceipt) -> Self {
		self.receipt = receipt;
		self
	}

	/// Records one exact attempt and accumulates its usage and cost into the
	/// receipt.
	pub fn attempt(mut self, attempt: AttemptReceipt) -> Self {
		self.receipt.record_attempt(attempt);
		self
	}

	/// Sets normalized selected-model response metadata.
	pub fn model(mut self, model: ModelKey) -> Self {
		self.model = Some(model);
		self
	}

	/// Sets a sanitized provider request identifier.
	pub fn provider_request_id(mut self, request_id: Str) -> Self {
		self.provider_request_id = Some(request_id);
		self
	}

	/// Sets the response creation time; the deterministic default is the Unix
	/// epoch.
	pub const fn created_at(mut self, created_at: SystemTime) -> Self {
		self.created_at = created_at;
		self
	}

	fn new(operation: OperationKind, outcome: FakeOutcome) -> Self {
		Self {
			operation,
			outcome,
			readiness_pending: 0,
			readiness_error: None,
			receipt: ExecutionReceipt::default(),
			model: None,
			provider_request_id: None,
			created_at: SystemTime::UNIX_EPOCH,
		}
	}
}

/// Exact operation body stored by a [`FakeScript`].
pub enum FakeAnswer {
	/// Canonical chat event stream.
	Chat(Vec<Result<ChatEvent, Error>>),
	/// Prompt-token count.
	Tokens(TokenCount),
	/// Token identifier sequence.
	TokenIds(TokenSequence),
	/// Detokenized text.
	Text(DetokenizedText),
	/// Embedding batch.
	Embeddings(EmbeddingBatch),
	/// Image generation stream.
	Images(Vec<Result<GenerationEvent<ImageArtifact>, Error>>),
	/// Owned video generation job session.
	Video(GenerationSession<VideoArtifact>),
	/// Encoded speech stream.
	Speech(Vec<Result<AudioChunk, Error>>),
	/// Incremental transcript stream.
	Transcript(Vec<Result<TranscriptEvent, Error>>),
	/// Owned realtime session.
	Realtime(RealtimeSession),
	/// Ranked search results.
	Search(SearchResults),
	/// Lossless Parallel extraction result.
	ParallelExtract(ParallelExtractResult),
	/// Account usage report, boxed because the lossless provider payload is
	/// intentionally wider than this scripted-answer enum's other variants.
	Usage(Box<UsageReport>),
	/// Runtime-discovered normalized model page.
	Models(ModelDiscoveryPage),
	/// Authentication answer or session.
	Auth(AuthAnswer),
	/// Bounded native response.
	Native(NativeResponse),
}

impl FakeAnswer {
	const fn kind(&self) -> AnswerKind {
		match self {
			Self::Chat(_) => AnswerKind::Chat,
			Self::Tokens(_) => AnswerKind::Tokens,
			Self::TokenIds(_) => AnswerKind::TokenIds,
			Self::Text(_) => AnswerKind::Text,
			Self::Embeddings(_) => AnswerKind::Embeddings,
			Self::Images(_) => AnswerKind::Images,
			Self::Video(_) => AnswerKind::Video,
			Self::Speech(_) => AnswerKind::Speech,
			Self::Transcript(_) => AnswerKind::Transcript,
			Self::Realtime(_) => AnswerKind::Realtime,
			Self::Search(_) => AnswerKind::Search,
			Self::ParallelExtract(_) => AnswerKind::ParallelExtract,
			Self::Usage(_) => AnswerKind::Usage,
			Self::Models(_) => AnswerKind::Models,
			Self::Auth(_) => AnswerKind::Auth,
			Self::Native(_) => AnswerKind::Native,
		}
	}

	fn into_body(self) -> AnswerBody {
		match self {
			Self::Chat(items) => AnswerBody::Chat(ChatStream::ordinary(Box::pin(stream::iter(items)))),
			Self::Tokens(value) => AnswerBody::Tokens(value),
			Self::TokenIds(value) => AnswerBody::TokenIds(value),
			Self::Text(value) => AnswerBody::Text(value),
			Self::Embeddings(value) => AnswerBody::Embeddings(value),
			Self::Images(items) => AnswerBody::Images(Box::pin(stream::iter(items))),
			Self::Video(session) => AnswerBody::Video(session),
			Self::Speech(items) => AnswerBody::Speech(Box::pin(stream::iter(items))),
			Self::Transcript(items) => AnswerBody::Transcript(Box::pin(stream::iter(items))),
			Self::Realtime(value) => AnswerBody::Realtime(value),
			Self::Search(value) => AnswerBody::Search(value),
			Self::ParallelExtract(value) => AnswerBody::ParallelExtract(value),
			Self::Usage(value) => AnswerBody::Usage(value),
			Self::Models(value) => AnswerBody::Models(value),
			Self::Auth(value) => AnswerBody::Auth(value),
			Self::Native(value) => AnswerBody::Native(value),
		}
	}
}

/// Clone-cheap cooperative cancellation for one scripted call.
#[derive(Clone, Default)]
pub struct FakeCancellation {
	state: Arc<FakeCancellationState>,
}

#[derive(Default)]
struct FakeCancellationState {
	cancelled: AtomicBool,
	waker:     AtomicWaker,
}

impl FakeCancellation {
	/// Cancels the scripted call and wakes its pending service future.
	pub fn cancel(&self) {
		self.state.cancelled.store(true, Ordering::Release);
		self.state.waker.wake();
	}

	/// Returns whether cancellation has been requested.
	pub fn is_cancelled(&self) -> bool {
		self.state.cancelled.load(Ordering::Acquire)
	}

	fn poll_cancelled(&self, context: &Context<'_>) -> Poll<()> {
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

/// Secret-free, bounded evidence that a call reached the fake provider.
#[derive(Clone, Debug)]
pub struct CapturedCall {
	/// Logical request identity.
	pub request_id:     RequestId,
	/// Closed operation discriminant.
	pub operation:      OperationKind,
	/// Whether the call carried a deadline; the process-relative instant is not
	/// retained.
	pub has_deadline:   bool,
	/// Exact execution budget.
	pub budget:         ExecutionBudget,
	/// Whether session context was present; conversation identifiers are not
	/// retained.
	pub has_session:    bool,
	/// Whether the attached session explicitly forked from an earlier revision.
	pub session_forked: bool,
	/// Bounded operation shape with text, secrets, URIs, JSON, and media bytes
	/// excluded.
	pub shape:          CapturedOperation,
}

/// Bounded, content-free shape of an operation payload.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CapturedOperation {
	/// Chat counts only.
	Chat {
		/// Message count.
		messages:     usize,
		/// Tool declaration count.
		tools:        usize,
		/// Hosted-tool count.
		hosted_tools: usize,
	},
	/// Token-count input counts only.
	CountTokens {
		/// Message count.
		messages: usize,
		/// Tool declaration count.
		tools:    usize,
	},
	/// Tokenization text byte length only.
	Tokenize {
		/// UTF-8 byte length.
		text_bytes: usize,
	},
	/// Detokenization identifier count only.
	Detokenize {
		/// Token count.
		tokens: usize,
	},
	/// Embedding input count only.
	Embed {
		/// Input count.
		inputs: usize,
	},
	/// Image request media presence and requested output count.
	GenerateImage {
		/// Reference count; reference contents are excluded.
		references: usize,
		/// Whether a mask was supplied.
		has_mask:   bool,
		/// Requested artifact count.
		count:      u32,
	},
	/// Video request media presence only.
	GenerateVideo {
		/// Whether a starting image was supplied.
		has_reference: bool,
	},
	/// Speech input length; text and voice are excluded.
	Speak {
		/// UTF-8 input byte length.
		text_bytes: usize,
	},
	/// Transcription media representation; media contents and names are
	/// excluded.
	Transcribe {
		/// Content-free media shape.
		audio: CapturedMedia,
	},
	/// Realtime modality and tool counts; instructions and voice are excluded.
	Realtime {
		/// Modality count.
		modalities: usize,
		/// Tool declaration count.
		tools:      usize,
	},
	/// Search input lengths and counts; query and domains are excluded.
	Search {
		/// Query UTF-8 byte length.
		query_bytes:     usize,
		/// Included-domain count.
		include_domains: usize,
		/// Excluded-domain count.
		exclude_domains: usize,
		/// Maximum requested rows.
		max_results:     u32,
	},
	/// Parallel extraction input shape; URLs and objective are excluded.
	ParallelExtract {
		/// Number of requested URLs.
		urls:           usize,
		/// Number of excerpt-focus queries.
		search_queries: usize,
		/// Whether complete content was requested.
		full_content:   bool,
	},
	/// Account usage query shape.
	Usage {
		/// Whether a provider restriction exists.
		has_provider: bool,
		/// Whether an account restriction exists.
		has_account:  bool,
	},
	/// Discovery query shape; cursor content is excluded.
	DiscoverModels {
		/// Whether a provider restriction exists.
		has_provider: bool,
		/// Whether a route restriction exists.
		has_route:    bool,
		/// Whether a cursor exists.
		has_cursor:   bool,
		/// Requested page size.
		page_size:    u32,
	},
	/// Authentication control variant; secret input is never retained.
	Auth(CapturedAuthOperation),
	/// Native request shape; opaque JSON and streamed bytes are never retained.
	Native {
		/// Content-free payload shape.
		payload:            Option<CapturedNativePayload>,
		/// Maximum accepted response bytes.
		max_response_bytes: u64,
	},
}

/// Content-free media representation retained in a captured call.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CapturedMedia {
	/// Inline bytes, retaining only their bounded length.
	InlineBytes(usize),
	/// An artifact-store reference whose identifier is excluded.
	Stored,
	/// A remote reference whose URI and metadata are excluded.
	Remote,
	/// A replay-aware body whose frames and metadata are excluded.
	Body,
}

/// Secret-free authentication request discriminant.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CapturedAuthOperation {
	/// Begin login.
	Login,
	/// Submit secret or control input; neither session nor input is retained.
	Submit,
	/// List accounts.
	ListAccounts,
	/// Refresh an account.
	Refresh,
	/// Remove an account.
	Logout,
}

/// Content-free native payload evidence.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CapturedNativePayload {
	/// Opaque JSON was present; its contents and serialized size are excluded.
	Json,
	/// Immutable bytes were present, retaining only their length.
	Bytes(usize),
	/// A replay-aware body was present; its frames are excluded.
	Body,
}

impl CapturedCall {
	fn from_call(call: &Call) -> Self {
		Self {
			request_id:     call.id.clone(),
			operation:      call.operation.kind(),
			has_deadline:   call.deadline.is_some(),
			budget:         call.budget.clone(),
			has_session:    call.session.is_some(),
			session_forked: call.session.as_ref().is_some_and(|session| session.forked),
			shape:          CapturedOperation::from_operation(&call.operation),
		}
	}
}

impl CapturedOperation {
	fn from_operation(operation: &OperationCall) -> Self {
		match operation {
			OperationCall::Chat(request) => Self::Chat {
				messages:     request.messages.len(),
				tools:        request.tools.len(),
				hosted_tools: request.hosted_tools.len(),
			},
			OperationCall::CountTokens(request) => {
				Self::CountTokens { messages: request.messages.len(), tools: request.tools.len() }
			},
			OperationCall::Tokenize(request) => Self::Tokenize { text_bytes: request.text.len() },
			OperationCall::Detokenize(request) => Self::Detokenize { tokens: request.tokens.len() },
			OperationCall::Embed(request) => Self::Embed { inputs: request.inputs.len() },
			OperationCall::GenerateImage(request) => Self::GenerateImage {
				references: request.references.len(),
				has_mask:   request.mask.is_some(),
				count:      request.count,
			},
			OperationCall::GenerateVideo(request) => {
				Self::GenerateVideo { has_reference: request.reference.is_some() }
			},
			OperationCall::Speak(request) => Self::Speak { text_bytes: request.text.len() },
			OperationCall::Transcribe(request) => {
				Self::Transcribe { audio: capture_media(&request.audio) }
			},
			OperationCall::Realtime(request) => {
				Self::Realtime { modalities: request.modalities.len(), tools: request.tools.len() }
			},
			OperationCall::Search(request) => Self::Search {
				query_bytes:     request.query.len(),
				include_domains: request.include_domains.len(),
				exclude_domains: request.exclude_domains.len(),
				max_results:     request.max_results,
			},
			OperationCall::ParallelExtract(request) => Self::ParallelExtract {
				urls:           request.urls.len(),
				search_queries: request.search_queries.len(),
				full_content:   request.full_content,
			},
			OperationCall::Usage(request) => Self::Usage {
				has_provider: request.provider.is_some(),
				has_account:  request.account.is_some(),
			},
			OperationCall::DiscoverModels(request) => Self::DiscoverModels {
				has_provider: request.provider.is_some(),
				has_route:    request.route.is_some(),
				has_cursor:   request.cursor.is_some(),
				page_size:    request.page_size,
			},
			OperationCall::Auth(request) => Self::Auth(match request.as_ref() {
				AuthRequest::Login(_) => CapturedAuthOperation::Login,
				AuthRequest::Submit { .. } => CapturedAuthOperation::Submit,
				AuthRequest::ListAccounts { .. } => CapturedAuthOperation::ListAccounts,
				AuthRequest::Refresh { .. } => CapturedAuthOperation::Refresh,
				AuthRequest::Logout { .. } => CapturedAuthOperation::Logout,
			}),
			OperationCall::Native(request) => Self::Native {
				payload:            request.payload.as_ref().map(|payload| match payload {
					NativePayload::Json(_) => CapturedNativePayload::Json,
					NativePayload::Bytes(bytes) => CapturedNativePayload::Bytes(bytes.len()),
					NativePayload::Body(_) => CapturedNativePayload::Body,
				}),
				max_response_bytes: request.max_response_bytes,
			},
		}
	}
}

const fn capture_media(media: &MediaInput) -> CapturedMedia {
	match media {
		MediaInput::Bytes { data, .. } => CapturedMedia::InlineBytes(data.len()),
		MediaInput::Stored(_) => CapturedMedia::Stored,
		MediaInput::Remote { .. } => CapturedMedia::Remote,
		MediaInput::Body { .. } => CapturedMedia::Body,
	}
}

const fn expected_answer_kind(operation: OperationKind) -> AnswerKind {
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

fn contract_error(request_id: RequestId, reason: &'static str, receipt: ExecutionReceipt) -> Error {
	Error::new(
		ErrorKind::ProviderContractMismatch,
		ErrorPhase::Internal,
		RetryAction::Never,
		receipt,
	)
	.request_id(request_id)
	.detail(ErrorDetail::protocol(ReasonId(Str::new(reason))))
}

#[cfg(test)]
mod tests {
	use std::{
		sync::{Arc, atomic},
		task::{Context, Poll},
		time::{Duration, SystemTime},
	};

	use bytes::Bytes;
	use futures::{StreamExt, future::poll_fn};
	use omp_core::{Str, sf};
	use tower::Service;

	use super::{FakeProvider, FakeScript};
	use crate::{
		answer::{
			AnswerBody, DetokenizedText, GenerationEvent, GenerationSession, RealtimeEvent,
			RealtimeSession, TokenizerProvenance, VideoArtifact,
		},
		body::{AttemptBodyEvidence, Replayability, RetryDecision, RetryDecisionReason},
		call::{
			AuthRequest, Call, ChatRequest, CountAccuracy, CountTokensRequest, DetokenizeRequest,
			DiscoveryRequest, EmbedRequest, ImageRequest, InferenceAttribution, MediaInput,
			NativeRequest, NativeResponseFraming, NegotiationPolicy, OperationCall, RealtimeRequest,
			Sampling, SearchRequest, Setting, SpeechRequest, Target, TokenizeRequest,
			TranscriptionRequest, TruncationPolicy, UsageRequest, UsageScope, VideoRequest,
		},
		catalog::{OperationKind, ProviderId, RouteId},
		error::{Error, ErrorKind, ErrorPhase, RetryAction},
		event::ChatEvent,
		id::{GenerationHandle, RequestId},
		operation::job::{JobCancelHandle, JobCheckpoint, JobCheckpointHandle, JobRef},
		receipt::{
			AttemptOutcome, AttemptReceipt, Cost, ExecutionBudget, ExecutionReceipt, ProviderEvidence,
			Usage, UsageSource,
		},
	};

	fn failure() -> Error {
		Error::new(
			ErrorKind::Connectivity,
			ErrorPhase::Connecting,
			RetryAction::Never,
			ExecutionReceipt::default(),
		)
	}

	fn call(operation: OperationCall) -> Call {
		Call {
			id: RequestId::from("fake-request"),
			target: Target::ProviderService(ProviderId::from("fake-provider")),
			deadline: None,
			budget: ExecutionBudget::default(),
			session: None,
			debug_session: None,
			affinity: Default::default(),
			response_hooks: Default::default(),
			attribution: InferenceAttribution::core(),
			execution: None,
			staging: None,
			operation,
		}
	}

	fn empty_operations() -> Vec<OperationCall> {
		vec![
			OperationCall::Chat(Arc::new(ChatRequest {
				messages:          Arc::from([]),
				tools:             Arc::from([]),
				hosted_tools:      Arc::from([]),
				tool_choice:       Setting::default(),
				output:            Setting::default(),
				reasoning:         Setting::default(),
				verbosity:         Setting::default(),
				cache_retention:   Setting::default(),
				service_tier:      Setting::default(),
				sampling:          Sampling::default(),
				max_output_tokens: None,
				top_logprobs:      None,
				safety:            Arc::from([]),
				negotiation:       NegotiationPolicy::default(),
				forced_call:       None,
			})),
			OperationCall::CountTokens(Arc::new(CountTokensRequest {
				messages: Arc::from([]),
				tools:    Arc::from([]),
				accuracy: CountAccuracy::Exact,
			})),
			OperationCall::Tokenize(Arc::new(TokenizeRequest {
				text:          sf!("secret text"),
				allow_special: false,
			})),
			OperationCall::Detokenize(Arc::new(DetokenizeRequest {
				tokens: Arc::from([1_u32]),
				strict: true,
			})),
			OperationCall::Embed(Arc::new(EmbedRequest {
				inputs:      Arc::from([]),
				dimensions:  Setting::default(),
				normalize:   Setting::default(),
				truncation:  TruncationPolicy::Reject,
				negotiation: NegotiationPolicy::default(),
			})),
			OperationCall::GenerateImage(Arc::new(ImageRequest {
				prompt:      sf!("private prompt"),
				references:  Arc::from([]),
				mask:        None,
				count:       1,
				dimensions:  Setting::default(),
				quality:     Setting::default(),
				background:  Setting::default(),
				format:      Setting::default(),
				style:       Setting::default(),
				safety:      Arc::from([]),
				seed:        None,
				negotiation: NegotiationPolicy::default(),
			})),
			OperationCall::GenerateVideo(Arc::new(VideoRequest {
				prompt:            sf!("private prompt"),
				reference:         None,
				duration_ms:       Setting::default(),
				dimensions:        Setting::default(),
				frames_per_second: Setting::default(),
				audio:             Setting::default(),
				safety:            Arc::from([]),
				seed:              None,
				negotiation:       NegotiationPolicy::default(),
			})),
			OperationCall::Speak(Arc::new(SpeechRequest {
				text:           sf!("private speech"),
				voice:          sf!("voice"),
				format:         Setting::default(),
				sample_rate_hz: Setting::default(),
				speed:          Setting::default(),
				timestamps:     Setting::default(),
				negotiation:    NegotiationPolicy::default(),
			})),
			OperationCall::Transcribe(Arc::new(TranscriptionRequest {
				audio:                MediaInput::Bytes {
					media_type: sf!("audio/pcm"),
					data:       Bytes::from_static(b"private audio"),
				},
				language:             None,
				translate_to_english: false,
				diarization:          Setting::default(),
				timestamps:           Setting::default(),
				prompt:               None,
				negotiation:          NegotiationPolicy::default(),
			})),
			OperationCall::Realtime(Arc::new(RealtimeRequest {
				instructions:   None,
				modalities:     Arc::from([]),
				voice:          None,
				input_audio:    Setting::default(),
				output_audio:   Setting::default(),
				turn_detection: Setting::default(),
				tools:          Arc::from([]),
				negotiation:    NegotiationPolicy::default(),
			})),
			OperationCall::Search(Arc::new(SearchRequest {
				query: sf!("private query"),
				include_domains: Arc::from([]),
				exclude_domains: Arc::from([]),
				recency: None,
				locale: None,
				max_results: 3,
				synthesize_answer: Setting::default(),
				negotiation: NegotiationPolicy::default(),
				..SearchRequest::new(sf!("private query"), 3)
			})),
			OperationCall::Usage(Arc::new(UsageRequest {
				provider:    None,
				account:     None,
				scope:       UsageScope::Current,
				allow_stale: false,
			})),
			OperationCall::DiscoverModels(Arc::new(DiscoveryRequest {
				provider:  None,
				route:     None,
				cursor:    None,
				page_size: 10,
				operation: None,
			})),
			OperationCall::Auth(Arc::new(AuthRequest::ListAccounts { provider: None })),
			OperationCall::Native(Arc::new(NativeRequest {
				method:             crate::call::NativeMethod::Get,
				path:               crate::call::NativePath::Models,
				payload:            None,
				response_framing:   NativeResponseFraming::Json,
				max_response_bytes: 1024,
			})),
		]
	}

	fn video_session(
		events: Vec<Result<GenerationEvent<VideoArtifact>, Error>>,
	) -> GenerationSession<VideoArtifact> {
		let job = JobRef {
			provider:  ProviderId::from("fake-provider"),
			route:     RouteId::from("fake-route"),
			operation: OperationKind::GenerateVideo,
			handle:    GenerationHandle::from("fake-video-job"),
		};
		let checkpoint = JobCheckpointHandle::new(JobCheckpoint {
			job:        job.clone(),
			completed:  0,
			total:      None,
			polls:      0,
			expires_at: None,
			created_at: SystemTime::UNIX_EPOCH,
		});
		let (cancel, _commands) = JobCancelHandle::bounded(job, 1).expect("valid fake job mailbox");
		GenerationSession::new(Box::pin(futures::stream::iter(events)), checkpoint, cancel)
			.expect("matching fake job identity")
	}

	fn detokenized(text: &str) -> DetokenizedText {
		DetokenizedText {
			text:       Str::new(text),
			provenance: TokenizerProvenance {
				tokenizer: sf!("fake-tokenizer"),
				revision:  sf!("1"),
				exact:     true,
			},
		}
	}

	#[tokio::test]
	async fn every_closed_operation_variant_is_consumed_and_captured_without_contents() {
		let fake = FakeProvider::new(ProviderId::from("fake-provider"), RouteId::from("fake-route"));
		let operations = empty_operations();
		let expected: Vec<_> = operations.iter().map(OperationCall::kind).collect();
		fake.extend(
			expected
				.iter()
				.copied()
				.map(|kind| FakeScript::precommit(kind, failure())),
		);
		let mut service = fake.clone();
		for operation in operations {
			poll_fn(|context| service.poll_ready(context))
				.await
				.expect("ready");
			assert_eq!(
				service
					.call(call(operation))
					.await
					.expect_err("scripted failure")
					.kind,
				ErrorKind::Connectivity
			);
		}
		assert_eq!(
			fake
				.calls()
				.iter()
				.map(|call| call.operation)
				.collect::<Vec<_>>(),
			expected
		);
		let capture = format!("{:?}", fake.calls());
		for excluded in
			["secret text", "private prompt", "private speech", "private audio", "private query"]
		{
			assert!(!capture.contains(excluded));
		}
		assert_eq!(fake.remaining(), 0);
	}

	#[tokio::test]
	async fn readiness_is_polled_then_call_is_made_on_the_same_instance() {
		let fake = FakeProvider::new(ProviderId::from("fake-provider"), RouteId::from("fake-route"));
		fake.push(FakeScript::precommit(OperationKind::Tokenize, failure()).readiness_pending(2));
		let mut service = fake;
		let waker = futures::task::noop_waker();
		let mut context = Context::from_waker(&waker);
		assert!(matches!(service.poll_ready(&mut context), Poll::Pending));
		assert!(matches!(service.poll_ready(&mut context), Poll::Pending));
		assert!(matches!(service.poll_ready(&mut context), Poll::Ready(Ok(()))));
		let error = service
			.call(call(empty_operations().remove(2)))
			.await
			.expect_err("scripted failure");
		assert_eq!(error.kind, ErrorKind::Connectivity);
	}

	#[tokio::test]
	async fn scripts_are_consumed_deterministically_and_unconfigured_calls_never_succeed() {
		let fake = FakeProvider::new(ProviderId::from("fake-provider"), RouteId::from("fake-route"));
		fake.extend([
			FakeScript::detokenize(detokenized("first")),
			FakeScript::detokenize(detokenized("second")),
		]);
		let mut service = fake;
		for expected in ["first", "second"] {
			poll_fn(|context| service.poll_ready(context))
				.await
				.expect("ready");
			let answer = service
				.call(call(empty_operations().remove(3)))
				.await
				.expect("scripted answer");
			assert!(matches!(&answer.body, AnswerBody::Text(text) if text.text.as_str() == expected));
		}
		poll_fn(|context| service.poll_ready(context))
			.await
			.expect("empty fake remains readiness-safe");
		let error = service
			.call(call(empty_operations().remove(3)))
			.await
			.expect_err("unconfigured call must fail");
		assert_eq!(error.kind, ErrorKind::ProviderContractMismatch);
	}

	#[tokio::test]
	async fn cancellation_and_precommit_vs_committed_failures_are_exact() {
		let fake = FakeProvider::new(ProviderId::from("fake-provider"), RouteId::from("fake-route"));
		let (cancelled, cancellation) = FakeScript::cancellable(OperationKind::Tokenize);
		fake.extend([
			cancelled,
			FakeScript::precommit(OperationKind::Tokenize, failure()),
			FakeScript::committed(OperationKind::Tokenize, failure()),
		]);
		let mut service = fake;
		let mut pending = service.call(call(empty_operations().remove(2)));
		assert!(matches!(futures::poll!(pending.as_mut()), Poll::Pending));
		cancellation.cancel();
		let cancelled = pending.await.expect_err("cancelled");
		assert_eq!(cancelled.kind, ErrorKind::Cancelled);
		assert!(!cancelled.committed);
		let precommit = service
			.call(call(empty_operations().remove(2)))
			.await
			.expect_err("precommit");
		let committed = service
			.call(call(empty_operations().remove(2)))
			.await
			.expect_err("committed");
		assert!(!precommit.committed);
		assert!(committed.committed);
	}

	#[tokio::test]
	async fn attempt_body_usage_and_cost_are_accounted_once() {
		let fake = FakeProvider::new(ProviderId::from("fake-provider"), RouteId::from("fake-route"));
		let usage = Usage {
			input_tokens: 7,
			output_tokens: 11,
			source: UsageSource::Provider,
			..Usage::default()
		};
		let attempt = AttemptReceipt {
			index: 0,
			hidden: false,
			provider: Some(ProviderId::from("fake-provider")),
			route: Some(RouteId::from("fake-route")),
			account: None,
			principal: None,
			body: AttemptBodyEvidence {
				opened:         true,
				consumed:       true,
				replayability:  Replayability::Replayable,
				retry_decision: RetryDecision::Allow,
				reason:         RetryDecisionReason::ReplayableSource,
			},
			outcome: AttemptOutcome::Succeeded,
			usage,
			cost: Cost::from_micro_usd(23),
			provider_evidence: ProviderEvidence::default(),
			elapsed: Duration::from_millis(4),
		};
		fake.push(FakeScript::detokenize(detokenized("answer")).attempt(attempt));
		let answer = fake
			.clone()
			.call(call(empty_operations().remove(3)))
			.await
			.expect("answer");
		assert_eq!(answer.receipt.attempts.len(), 1);
		assert_eq!(answer.receipt.usage, usage);
		assert_eq!(answer.receipt.cost, Cost::from_micro_usd(23));
		assert!(answer.receipt.attempts[0].body.consumed);
	}

	#[tokio::test]
	async fn event_media_and_realtime_streams_preserve_scripted_items_and_errors() {
		let fake = FakeProvider::new(ProviderId::from("fake-provider"), RouteId::from("fake-route"));
		let (outbound, _outbound_rx) = flume::bounded(2);
		let (inbound_tx, inbound) = flume::bounded(2);
		inbound_tx
			.send(Ok(RealtimeEvent::Ready))
			.expect("open inbound");
		let stream_error = failure().committed(true);
		fake.extend([
			FakeScript::chat(vec![
				Ok(ChatEvent::TextDelta { index: 0, text: sf!("delta") }),
				Err(stream_error),
			]),
			FakeScript::images(vec![Ok(GenerationEvent::Progress {
				completed: 1,
				total:     Some(2),
			})]),
			FakeScript::video(video_session(vec![Ok(GenerationEvent::Progress {
				completed: 2,
				total:     Some(2),
			})])),
			FakeScript::speech(vec![Ok(crate::answer::AudioChunk {
				bytes:       Bytes::from_static(b"audio"),
				start_ms:    Some(0),
				end_ms:      Some(1),
				final_chunk: true,
			})]),
			FakeScript::transcript(vec![Ok(crate::answer::TranscriptEvent::Started {
				language: Some(sf!("en")),
			})]),
			FakeScript::realtime(RealtimeSession::from_channels(
				outbound,
				inbound,
				Arc::new(atomic::AtomicBool::new(false)),
			)),
		]);
		let mut service = fake;
		let mut operations = empty_operations();
		let AnswerBody::Chat(stream) = service
			.call(call(operations.remove(0)))
			.await
			.expect("chat")
			.body
		else {
			panic!("chat body");
		};
		let mut chat = stream;
		assert!(
			matches!(chat.next().await, Some(Ok(ChatEvent::TextDelta { text, .. })) if text.as_str() == "delta")
		);
		assert!(matches!(chat.next().await, Some(Err(error)) if error.committed));
		let AnswerBody::Images(stream) = service
			.call(call(operations.remove(4)))
			.await
			.expect("images")
			.body
		else {
			panic!("images body");
		};
		let mut images = stream;
		assert!(matches!(
			images.next().await,
			Some(Ok(GenerationEvent::Progress { completed: 1, .. }))
		));
		let AnswerBody::Video(stream) = service
			.call(call(operations.remove(4)))
			.await
			.expect("video")
			.body
		else {
			panic!("video body");
		};
		let mut video = stream;
		assert!(matches!(
			video.next().await,
			Some(Ok(GenerationEvent::Progress { completed: 2, .. }))
		));
		let AnswerBody::Speech(stream) = service
			.call(call(operations.remove(4)))
			.await
			.expect("speech")
			.body
		else {
			panic!("speech body");
		};
		let mut speech = stream;
		assert!(matches!(
			speech.next().await,
			Some(Ok(crate::answer::AudioChunk { final_chunk: true, .. }))
		));
		let AnswerBody::Transcript(stream) = service
			.call(call(operations.remove(4)))
			.await
			.expect("transcript")
			.body
		else {
			panic!("transcript body");
		};
		let mut transcript = stream;
		assert!(matches!(
			transcript.next().await,
			Some(Ok(crate::answer::TranscriptEvent::Started { .. }))
		));
		let AnswerBody::Realtime(session) = service
			.call(call(operations.remove(4)))
			.await
			.expect("realtime")
			.body
		else {
			panic!("realtime body");
		};
		assert!(matches!(session.inbound.recv_async().await, Ok(Ok(RealtimeEvent::Ready))));
	}

	#[test]
	fn readiness_rejection_consumes_only_its_script() {
		let fake = FakeProvider::new(ProviderId::from("fake-provider"), RouteId::from("fake-route"));
		fake.extend([
			FakeScript::precommit(OperationKind::Tokenize, failure()).readiness_error(Error::new(
				ErrorKind::RateLimited,
				ErrorPhase::Readiness,
				RetryAction::Never,
				ExecutionReceipt::default(),
			)),
			FakeScript::precommit(OperationKind::Tokenize, failure()),
		]);
		let mut service = fake.clone();
		let waker = futures::task::noop_waker();
		let mut context = Context::from_waker(&waker);
		assert!(
			matches!(service.poll_ready(&mut context), Poll::Ready(Err(error)) if error.kind == ErrorKind::RateLimited)
		);
		assert_eq!(fake.remaining(), 1);
		assert!(matches!(service.poll_ready(&mut context), Poll::Ready(Ok(()))));
	}
}
