//! Typed unary, streaming, artifact, and session answers.

use std::{
	collections::BTreeMap,
	fmt,
	pin::Pin,
	sync::{
		Arc,
		atomic::{AtomicBool, Ordering},
	},
	task,
	task::{Context, Poll},
	time::{Duration, Instant, SystemTime},
};

use bytes::Bytes;
use flume::Receiver;
use futures::{Stream, StreamExt as _};
use omp_core::{SecretString, Str};
use parking_lot::Mutex;
use strum::IntoStaticStr;
use tokio::sync::Notify;

use crate::{
	auth::LoginCancellation,
	body::ByteStream,
	call::{
		AuthInput, RawJson, RealtimeContextAppend, RealtimeDelegationReceipt, ToolResultContent,
	},
	catalog::{ModelKey, ModelSpec, ProviderId, RouteId},
	error::Error,
	event::{ChatEvent, WorkflowResponse},
	id::{AccountId, GenerationHandle, LoginSessionId, PrincipalId, RequestId, ToolCallId},
	operation::{
		job::{
			JobCancelError, JobCancelHandle, JobCancellationReceipt, JobCheckpoint,
			JobCheckpointHandle, JobRef,
		},
		parallel_extract::ParallelExtractResult,
	},
	receipt::{Cost, ExecutionReceipt, Usage, UsageSource},
};

/// Owned asynchronous stream of fallible values.
pub type OutputStream<T> = Pin<Box<dyn Stream<Item = Result<T, Error>> + Send + 'static>>;

/// Canonical chat event stream and its optional same-session response path.
pub struct ChatStream {
	events:  OutputStream<ChatEvent>,
	control: Option<ChatControl>,
}

impl ChatStream {
	/// Creates an ordinary one-way chat stream without allocating control state.
	pub fn ordinary(events: OutputStream<ChatEvent>) -> Self {
		Self { events, control: None }
	}

	/// Creates a bidirectional chat stream over the provider's live response
	/// channel.
	pub(crate) fn duplex(
		events: OutputStream<ChatEvent>,
		responses: flume::Sender<WorkflowResponse>,
	) -> Self {
		Self {
			events,
			control: Some(ChatControl {
				responses,
				state: Arc::new(Mutex::new(ChatControlState::default())),
				closed: Arc::new(Notify::new()),
			}),
		}
	}

	/// Returns a response handle only when the selected provider route is
	/// genuinely bidirectional.
	pub fn control(&self) -> Option<ChatControl> {
		self.control.clone()
	}
}

impl Stream for ChatStream {
	type Item = Result<ChatEvent, Error>;

	fn poll_next(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Option<Self::Item>> {
		let item = self.events.poll_next_unpin(context);
		if let Some(control) = self.control.as_ref() {
			match &item {
				Poll::Ready(Some(Ok(ChatEvent::WorkflowAction(action)))) => {
					let deadline = action.timeout.map(|timeout| Instant::now() + timeout);
					control
						.state
						.lock()
						.pending
						.insert(action.invocation.clone(), deadline);
				},
				Poll::Ready(Some(Ok(ChatEvent::WorkflowCancelled { invocation }))) => {
					control.state.lock().pending.remove(invocation);
				},
				Poll::Ready(Some(Ok(ChatEvent::Completed(_)) | Err(_)) | None) => control.close(),
				_ => {},
			}
		}
		item
	}
}

impl Drop for ChatStream {
	fn drop(&mut self) {
		if let Some(control) = self.control.as_ref() {
			control.close();
		}
	}
}

#[derive(Default)]
struct ChatControlState {
	closed:  bool,
	pending: BTreeMap<Str, Option<Instant>>,
}

/// Clone-cheap handle for responding to live provider workflow actions.
#[derive(Clone)]
pub struct ChatControl {
	responses: flume::Sender<WorkflowResponse>,
	state:     Arc<Mutex<ChatControlState>>,
	closed:    Arc<Notify>,
}

impl ChatControl {
	/// Sends one correlated response to the provider session that emitted the
	/// action.
	pub async fn submit(&self, response: WorkflowResponse) -> Result<(), ChatControlError> {
		let invocation = response.invocation().clone();
		let closed = self.closed.notified();
		let deadline = {
			let mut state = self.state.lock();
			if state.closed {
				return Err(ChatControlError::Closed);
			}
			let Some(deadline) = state.pending.get(&invocation).copied() else {
				return Err(ChatControlError::UnknownInvocation);
			};
			if deadline.is_some_and(|deadline| Instant::now() >= deadline) {
				state.pending.remove(&invocation);
				return Err(ChatControlError::DeadlineExceeded);
			}
			deadline
		};
		let result = if let Some(deadline) = deadline {
			tokio::select! {
				result = self.responses.send_async(response.clone()) => result.map_err(|_| ChatControlError::Closed),
				() = closed => Err(ChatControlError::Closed),
				() = tokio::time::sleep_until(deadline.into()) => Err(ChatControlError::DeadlineExceeded),
			}
		} else {
			tokio::select! {
				result = self.responses.send_async(response.clone()) => result.map_err(|_| ChatControlError::Closed),
				() = closed => Err(ChatControlError::Closed),
			}
		};
		if response.is_terminal() || result == Err(ChatControlError::DeadlineExceeded) {
			self.state.lock().pending.remove(&invocation);
		}
		result
	}

	fn close(&self) {
		let mut state = self.state.lock();
		state.closed = true;
		state.pending.clear();
		self.closed.notify_waiters();
	}
}

/// Rejection from a live chat response path.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ChatControlError {
	/// The stream reached terminal completion or disconnected.
	Closed,
	/// No live provider action has this correlation identity.
	UnknownInvocation,
	/// The provider action deadline elapsed before this response.
	DeadlineExceeded,
}

/// Stream of long-running generation state and artifacts.
pub type GenerationStream<T> = OutputStream<GenerationEvent<T>>;

/// Stream of encoded audio chunks.
pub type AudioStream = OutputStream<AudioChunk>;

/// Stream of incremental transcript events.
pub type TranscriptStream = OutputStream<TranscriptEvent>;

/// Metadata common to every successful answer.
#[derive(Clone, Debug)]
pub struct ResponseMeta {
	/// Logical request identity.
	pub request_id:          RequestId,
	/// Provider selected for the successful attempt.
	pub provider:            ProviderId,
	/// Concrete selected route.
	pub route:               RouteId,
	/// Normalized selected model for model-scoped operations.
	pub model:               Option<ModelKey>,
	/// Sanitized provider request identifier.
	pub provider_request_id: Option<Str>,
	/// Wall-clock time at which the answer handshake completed.
	pub created_at:          SystemTime,
}

/// Successful erased service response.
pub struct Answer {
	/// Response identity and selected route metadata.
	pub meta:    ResponseMeta,
	/// Execution accounting available when the answer handshake completes.
	///
	/// For streaming chat, [`crate::event::Completion::receipt`] is the
	/// authoritative final receipt.
	pub receipt: ExecutionReceipt,
	/// Operation-specific response body.
	pub body:    AnswerBody,
}

impl fmt::Debug for Answer {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter
			.debug_struct("Answer")
			.field("meta", &self.meta)
			.field("receipt", &self.receipt)
			.field("body", &self.body.kind())
			.finish()
	}
}

/// One normalized page of runtime model discovery.
#[derive(Clone, Debug)]
pub struct ModelDiscoveryPage {
	/// Normalized model specifications in provider order.
	pub models:      Vec<ModelSpec>,
	/// Opaque cursor for the next page, when more rows are available.
	pub next_cursor: Option<Str>,
}

/// Closed response body produced by the erased service center.
pub enum AnswerBody {
	/// Canonical chat event stream.
	Chat(ChatStream),
	/// Exact or estimated prompt-token count.
	Tokens(TokenCount),
	/// Token identifier sequence.
	TokenIds(TokenSequence),
	/// Detokenized text with tokenizer provenance.
	Text(DetokenizedText),
	/// Batch of embedding vectors.
	Embeddings(EmbeddingBatch),
	/// Image generation progress and artifacts.
	Images(GenerationStream<ImageArtifact>),
	/// Owned asynchronous video job session with resumable checkpoint and
	/// cancellation.
	Video(GenerationSession<VideoArtifact>),
	/// Encoded audio stream.
	Speech(AudioStream),
	/// Incremental transcript stream.
	Transcript(TranscriptStream),
	/// Owned bidirectional realtime session.
	Realtime(RealtimeSession),
	/// Ranked standalone search results.
	Search(SearchResults),
	/// Lossless bounded Parallel extraction result.
	ParallelExtract(ParallelExtractResult),
	/// Account-scoped provider usage payload, boxed because its lossless,
	/// provider-defined window report is intentionally wider than this enum's
	/// other response bodies.
	Usage(Box<UsageReport>),
	/// Runtime-discovered normalized model page.
	Models(ModelDiscoveryPage),
	/// Authentication or account-management result.
	Auth(AuthAnswer),
	/// Bounded allowlisted native response.
	Native(NativeResponse),
}

impl AnswerBody {
	/// Returns the body variant without consuming stream or session state.
	pub const fn kind(&self) -> AnswerKind {
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
}

/// Discriminant used in structured body-variant mismatch errors.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AnswerKind {
	/// Chat stream.
	Chat,
	/// Token count.
	Tokens,
	/// Token sequence.
	TokenIds,
	/// Detokenized text.
	Text,
	/// Embedding batch.
	Embeddings,
	/// Image generation stream.
	Images,
	/// Video generation stream.
	Video,
	/// Speech audio stream.
	Speech,
	/// Transcript stream.
	Transcript,
	/// Realtime session.
	Realtime,
	/// Search results.
	Search,
	/// Parallel extraction result.
	ParallelExtract,
	/// Usage report.
	Usage,
	/// Discovered models.
	Models,
	/// Authentication result.
	Auth,
	/// Native response.
	Native,
}

/// Provenance of a token-count answer.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TokenizerProvenance {
	/// Stable tokenizer identity.
	pub tokenizer: Str,
	/// Immutable tokenizer revision or digest.
	pub revision:  Str,
	/// Whether the count is exact for the selected wire encoding.
	pub exact:     bool,
}

/// Prompt token count with mandatory provenance.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TokenCount {
	/// Number of tokens.
	pub tokens:     u64,
	/// Tokenizer or provider provenance.
	pub provenance: TokenizerProvenance,
}

/// Tokenization output with tokenizer provenance.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TokenSequence {
	/// Ordered token identifiers.
	pub tokens:     Vec<u32>,
	/// Tokenizer provenance.
	pub provenance: TokenizerProvenance,
}

/// Detokenized text with tokenizer identity and immutable revision.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DetokenizedText {
	/// Reconstructed UTF-8 text.
	pub text:       Str,
	/// Tokenizer provenance.
	pub provenance: TokenizerProvenance,
}

/// One embedding vector and its input position.
#[derive(Clone, Debug, PartialEq)]
pub struct Embedding {
	/// Zero-based input index.
	pub index:  u32,
	/// Dense floating-point vector.
	pub values: Vec<f32>,
}

/// Ordered embedding batch with dimensions and usage.
#[derive(Clone, Debug, PartialEq)]
pub struct EmbeddingBatch {
	/// Vector dimensions after any declared adjustment.
	pub dimensions: u32,
	/// One vector per input.
	pub embeddings: Vec<Embedding>,
	/// Resource usage for embedding generation.
	pub usage:      Usage,
}

/// Stable reference to immutable artifact-store content.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ArtifactRef {
	/// Artifact store namespace.
	pub store:    Str,
	/// Store-local immutable object identifier.
	pub id:       Str,
	/// Content revision used to guarantee repeatable reads.
	pub revision: Str,
}

/// Digest algorithm attached to generated artifacts.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DigestAlgorithm {
	/// SHA-256.
	Sha256,
	/// BLAKE3.
	Blake3,
}

/// Content digest for an artifact.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Digest {
	/// Digest algorithm.
	pub algorithm: DigestAlgorithm,
	/// Raw digest bytes.
	pub value:     Bytes,
}

/// Storage representation for a generated or referenced artifact.
pub enum ArtifactBody {
	/// Small inline immutable bytes.
	Bytes(Bytes),
	/// Owned asynchronous byte stream.
	Stream(ByteStream),
	/// Immutable object in an artifact store.
	Stored(ArtifactRef),
}

impl fmt::Debug for ArtifactBody {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		match self {
			Self::Bytes(bytes) => formatter.debug_tuple("Bytes").field(&bytes.len()).finish(),
			Self::Stream(_) => formatter.write_str("Stream(..)"),
			Self::Stored(reference) => formatter.debug_tuple("Stored").field(reference).finish(),
		}
	}
}

/// Large or small media artifact with integrity metadata.
#[derive(Debug)]
pub struct Artifact {
	/// MIME media type.
	pub media_type: Str,
	/// Declared size in bytes when known.
	pub size:       Option<u64>,
	/// Optional content digest.
	pub digest:     Option<Digest>,
	/// Owned or stored content body.
	pub body:       ArtifactBody,
}

/// Generated image artifact and dimensions.
#[derive(Debug)]
pub struct ImageArtifact {
	/// Generated content.
	pub artifact:       Artifact,
	/// Width in pixels.
	pub width:          u32,
	/// Height in pixels.
	pub height:         u32,
	/// Revised prompt disclosed by the provider, if any.
	pub revised_prompt: Option<Str>,
}

/// Generated video artifact and media metadata.
#[derive(Debug)]
pub struct VideoArtifact {
	/// Generated content.
	pub artifact:          Artifact,
	/// Width in pixels.
	pub width:             u32,
	/// Height in pixels.
	pub height:            u32,
	/// Duration in milliseconds.
	pub duration_ms:       u64,
	/// Frames per second when known.
	pub frames_per_second: Option<u32>,
}

/// Progress or output event for a long-running media generation.
#[derive(Debug)]
pub enum GenerationEvent<T> {
	/// Provider accepted and queued the job.
	Queued {
		/// Provider job handle.
		job: GenerationHandle,
	},
	/// Monotonic progress counters.
	Progress {
		/// Completed work units.
		completed: u64,
		/// Total work units when known.
		total:     Option<u64>,
	},
	/// Provisional preview that is not a final artifact.
	Preview(T),
	/// Final generated artifact.
	Artifact(T),
	/// Job completed with aggregate accounting.
	Completed(GenerationSummary),
}

/// Owned asynchronous generation job with live events, resume state, and
/// cancellation.
///
/// Dropping the session sends one nonblocking cancellation command to the
/// shared job-controller actor unless explicit cancellation was already
/// requested.
pub struct GenerationSession<T> {
	events:     GenerationStream<T>,
	checkpoint: JobCheckpointHandle,
	cancel:     JobCancelHandle,
}

impl<T> GenerationSession<T> {
	/// Creates a session after verifying that the checkpoint and cancellation
	/// handle identify the same job.
	pub fn new(
		events: GenerationStream<T>,
		checkpoint: JobCheckpointHandle,
		mut cancel: JobCancelHandle,
	) -> Result<Self, GenerationSessionError> {
		if &checkpoint.snapshot().job != cancel.job() {
			cancel.disarm();
			return Err(GenerationSessionError::JobMismatch);
		}
		Ok(Self { events, checkpoint, cancel })
	}

	/// Borrows the stable provider-qualified job identity.
	pub const fn job(&self) -> &JobRef {
		self.cancel.job()
	}

	/// Returns a consistent current checkpoint suitable for explicit resume.
	pub fn checkpoint(&self) -> JobCheckpoint {
		self.checkpoint.snapshot()
	}

	/// Borrows the owned event stream for direct stream combinators.
	pub fn events_mut(&mut self) -> &mut GenerationStream<T> {
		&mut self.events
	}

	/// Requests provider cancellation exactly once and waits for typed
	/// acknowledgement evidence.
	pub async fn cancel(&mut self) -> Result<JobCancellationReceipt, JobCancelError> {
		self.cancel.cancel().await
	}

	/// Returns whether this session already dispatched its single cancellation
	/// command.
	pub const fn cancellation_requested(&self) -> bool {
		self.cancel.cancellation_requested()
	}
}

impl<T> fmt::Debug for GenerationSession<T> {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter
			.debug_struct("GenerationSession")
			.field("checkpoint", &self.checkpoint)
			.field("cancellation_requested", &self.cancel.cancellation_requested())
			.finish_non_exhaustive()
	}
}

impl<T> Stream for GenerationSession<T> {
	type Item = Result<GenerationEvent<T>, Error>;

	fn poll_next(
		mut self: Pin<&mut Self>,
		context: &mut task::Context<'_>,
	) -> task::Poll<Option<Self::Item>> {
		self.events.as_mut().poll_next(context)
	}
}

/// Construction failure for an owned generation session.
#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum GenerationSessionError {
	/// The event checkpoint and cancellation handle identify different jobs.
	#[error("generation checkpoint and cancellation handle identify different jobs")]
	JobMismatch,
}

/// Final summary for a long-running generation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GenerationSummary {
	/// Number of final artifacts emitted.
	pub artifacts: u32,
	/// Total job duration.
	pub elapsed:   Duration,
	/// Usage across polling and generation.
	pub usage:     Usage,
	/// Integer job cost.
	pub cost:      Cost,
}

/// One encoded output audio chunk.
#[derive(Clone, Debug)]
pub struct AudioChunk {
	/// Encoded immutable bytes.
	pub bytes:       Bytes,
	/// Start timestamp in milliseconds.
	pub start_ms:    Option<u64>,
	/// End timestamp in milliseconds.
	pub end_ms:      Option<u64>,
	/// Whether this is the final audio chunk.
	pub final_chunk: bool,
}

/// One identified speaker in a transcript.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Speaker {
	/// Stable speaker index within the transcript.
	pub index: u32,
	/// Optional provider label.
	pub label: Option<Str>,
}

/// Incremental speech transcript event.
#[derive(Clone, Debug, PartialEq)]
pub enum TranscriptEvent {
	/// A transcript stream was accepted.
	Started {
		/// Detected or requested language.
		language: Option<Str>,
	},
	/// Provisional text that may be superseded before segment finalization.
	TextDelta {
		/// Provisional transcript text.
		text: Str,
	},
	/// Final timestamped segment.
	Segment {
		/// Monotonic segment index.
		index:    u32,
		/// Final segment text.
		text:     Str,
		/// Inclusive start time in milliseconds.
		start_ms: u64,
		/// Exclusive end time in milliseconds.
		end_ms:   u64,
		/// Identified speaker when available.
		speaker:  Option<Speaker>,
	},
	/// Final timestamped word.
	Word {
		/// Final word text.
		text:       Str,
		/// Inclusive start time in milliseconds.
		start_ms:   u64,
		/// Exclusive end time in milliseconds.
		end_ms:     u64,
		/// Provider confidence when exposed.
		confidence: Option<f32>,
		/// Identified speaker when available.
		speaker:    Option<Speaker>,
	},
	/// Final transcript and usage.
	Completed {
		/// Complete transcript text.
		text:  Str,
		/// Final transcription usage.
		usage: Usage,
	},
}

/// Role represented by a realtime transcript update.
#[derive(Clone, Copy, Debug, Eq, IntoStaticStr, PartialEq)]
#[strum(serialize_all = "lowercase")]
pub enum RealtimeTranscriptRole {
	/// Transcript produced from caller input.
	User,
	/// Transcript produced by the realtime assistant.
	Assistant,
}

/// Incremental or final text for one realtime conversational turn.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RealtimeTranscript {
	/// Speaker role.
	pub role:      RealtimeTranscriptRole,
	/// Monotonic role-local turn number used to coalesce updates.
	pub turn:      u64,
	/// Latest complete text for this update.
	pub text:      Str,
	/// Whether this text is terminal for the role-local turn.
	pub finalized: bool,
}

/// Provider-neutral realtime session activity.
#[derive(Clone, Copy, Debug, Eq, IntoStaticStr, PartialEq)]
#[strum(serialize_all = "lowercase")]
pub enum RealtimePhase {
	/// Establishing signaling and media channels.
	Connecting,
	/// Waiting for caller input.
	Listening,
	/// Executing delegated agent work.
	Working,
	/// Producing assistant audio.
	Speaking,
	/// Caller microphone input is muted.
	Muted,
	/// Closing session resources.
	Closing,
	/// Session reached an error.
	Error,
}

/// Agent work requested by the realtime peer.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RealtimeDelegation {
	/// Stable delegation identity issued by the realtime peer.
	pub id:      Str,
	/// Provider-neutral coding request text.
	pub request: Str,
}

/// Origin of a terminal realtime close.
#[derive(Clone, Copy, Debug, Eq, IntoStaticStr, PartialEq)]
#[strum(serialize_all = "kebab-case")]
pub enum RealtimeCloseOrigin {
	/// The caller requested session closure.
	Caller,
	/// The realtime peer ended the session.
	Provider,
}

/// Reason a realtime session closed.
#[derive(Clone, Copy, Debug, Eq, IntoStaticStr, PartialEq)]
#[strum(serialize_all = "lowercase")]
pub enum RealtimeCloseReason {
	/// Session completed normally.
	Completed,
	/// Session was cancelled.
	Cancelled,
	/// Session terminated after a classified failure.
	Failed,
}

/// Exactly-once evidence of terminal realtime session closure.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RealtimeCloseReceipt {
	/// Side that initiated closure.
	pub origin:    RealtimeCloseOrigin,
	/// Terminal close reason.
	pub reason:    RealtimeCloseReason,
	/// Time at which the session owner settled closure.
	pub closed_at: SystemTime,
}

/// Caller-to-provider message in an owned realtime session.
#[derive(Clone, Debug)]
pub enum RealtimeInput {
	/// Append encoded audio bytes.
	Audio(Bytes),
	/// Append user text.
	Text(Str),
	/// Submit typed ordered content for a completed tool call.
	ToolResult {
		/// Stable completed tool-call identity.
		call:     ToolCallId,
		/// Tool name when required by the wire protocol.
		name:     Option<Str>,
		/// Ordered typed result content.
		content:  Arc<[ToolResultContent]>,
		/// Whether tool execution failed.
		is_error: bool,
	},
	/// Append provider-neutral context to the session or active delegation.
	AppendContext(RealtimeContextAppend),
	/// Enable or disable caller microphone input.
	SetMuted(bool),
	/// Cancel one delegated agent turn without closing the session.
	CancelDelegation {
		/// Stable delegation identity issued by the realtime peer.
		id: Str,
	},
	/// Settle one delegated agent turn exactly once.
	SettleDelegation(RealtimeDelegationReceipt),
	/// Commit current input and request a response.
	Commit,
	/// Cancel the active response.
	CancelResponse,
	/// Close the session.
	Close,
}

/// Provider-to-caller message from an owned realtime session.
#[derive(Debug)]
pub enum RealtimeEvent {
	/// Session handshake completed.
	Ready,
	/// Canonical chat event.
	Chat(ChatEvent),
	/// Encoded output audio.
	Audio(AudioChunk),
	/// Input audio was committed.
	InputCommitted,
	/// Realtime activity phase changed.
	Phase(RealtimePhase),
	/// Incremental or final conversational transcript.
	Transcript(RealtimeTranscript),
	/// Realtime peer delegated agent work.
	Delegation(RealtimeDelegation),
	/// Effective caller microphone mute state changed.
	Muted(bool),
	/// Session closed with an exactly-once terminal receipt.
	CloseReceipt(RealtimeCloseReceipt),
	/// Session closed cleanly without a richer transport receipt.
	Closed,
}

/// Owned bounded bidirectional realtime session.
///
/// Channels are private so all caller input observes backpressure and the
/// single terminal close transition.
pub struct RealtimeSession {
	pub(crate) outbound: flume::Sender<RealtimeInput>,
	pub(crate) inbound:  Receiver<Result<RealtimeEvent, Error>>,
	pub(crate) closed:   Arc<AtomicBool>,
}

impl RealtimeSession {
	/// Creates a session from one bounded channel pair and its shared terminal
	/// state.
	pub(crate) const fn from_channels(
		outbound: flume::Sender<RealtimeInput>,
		inbound: Receiver<Result<RealtimeEvent, Error>>,
		closed: Arc<AtomicBool>,
	) -> Self {
		Self { outbound, inbound, closed }
	}

	/// Returns whether close was requested or the session reached terminal
	/// closure.
	pub fn is_closed(&self) -> bool {
		self.closed.load(Ordering::Acquire)
	}
}

impl fmt::Debug for RealtimeSession {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter
			.debug_struct("RealtimeSession")
			.field("closed", &self.is_closed())
			.field("outbound_disconnected", &self.outbound.is_disconnected())
			.field("inbound_disconnected", &self.inbound.is_disconnected())
			.finish()
	}
}

impl Drop for RealtimeSession {
	fn drop(&mut self) {
		if !self.closed.swap(true, Ordering::AcqRel) {
			let _ = self.outbound.try_send(RealtimeInput::Close);
		}
	}
}

/// One ranked standalone search result.
#[derive(Clone, Debug, PartialEq)]
pub struct SearchResult {
	/// Rank, starting at one.
	pub rank:         u32,
	/// Result URL.
	pub url:          Str,
	/// Result title.
	pub title:        Str,
	/// Provider-produced snippet.
	pub snippet:      Option<Str>,
	/// Relevance score when exposed.
	pub score:        Option<f32>,
	/// Publication time when known.
	pub published_at: Option<SystemTime>,
	/// Author or publisher when exposed.
	pub author:       Option<Str>,
}

/// One inline citation anchoring synthesized search text.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SearchCitation {
	/// Cited URL.
	pub url:        Str,
	/// Provider-supplied citation title.
	pub title:      Option<Str>,
	/// Provider-supplied cited excerpt.
	pub cited_text: Option<Str>,
	/// Inclusive byte offset in the synthesized answer.
	pub start:      Option<u32>,
	/// Exclusive byte offset in the synthesized answer.
	pub end:        Option<u32>,
}

/// Stable category for one failed search-provider attempt.
#[derive(Clone, Copy, Debug, Eq, PartialEq, strum::IntoStaticStr)]
#[strum(serialize_all = "snake_case")]
pub enum SearchFailureKind {
	/// Credentials were absent or rejected.
	Authentication,
	/// The account has insufficient credit or quota.
	Quota,
	/// The requested provider model was not found.
	ModelNotFound,
	/// Provider transport or connectivity failed.
	Transport,
	/// The attempt exceeded its deadline.
	Timeout,
	/// The provider returned another classified failure.
	Provider,
}

/// Bounded, secret-free failed search-provider attempt.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SearchProviderFailure {
	/// Provider attempted.
	pub provider: ProviderId,
	/// Stable failure category.
	pub kind:     SearchFailureKind,
	/// HTTP-like status when available.
	pub status:   Option<u16>,
	/// Sanitized structured provider error code.
	pub code:     Option<Str>,
}

/// Search metadata retained losslessly across tool and RPC boundaries.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SearchMetadata {
	/// Provider that served the successful attempt.
	pub provider:          Option<ProviderId>,
	/// Opaque account identity used for the successful attempt.
	pub account:           Option<AccountId>,
	/// UI-safe credential mode label.
	pub auth_mode:         Option<Str>,
	/// Inline citations anchoring the answer.
	pub citations:         Vec<SearchCitation>,
	/// Provider-generated subqueries.
	pub search_queries:    Vec<Str>,
	/// Provider-generated related questions.
	pub related_questions: Vec<Str>,
	/// Constraint relaxation and provider warnings.
	pub warnings:          Vec<Str>,
	/// Failed attempts preceding success, or every attempt on aggregate failure.
	pub failures:          Vec<SearchProviderFailure>,
}

/// Ranked standalone search answer and optional synthesis.
#[derive(Clone, Debug, PartialEq)]
pub struct SearchResults {
	/// Ordered ranked results.
	pub results:  Vec<SearchResult>,
	/// Optional provider-generated answer synthesis.
	pub answer:   Option<Str>,
	/// Search resource usage.
	pub usage:    Usage,
	/// Provider, citation, warning, and fallback metadata.
	pub metadata: SearchMetadata,
}

/// Type of an account usage or quota window.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum UsageWindowKind {
	/// Request or token rate limit.
	RateLimit,
	/// Account quota.
	Quota,
	/// Billing-period consumption.
	Billing,
	/// Remaining monetary or unit balance.
	Balance,
}

/// Unit in which a usage amount is reported.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum UsageUnit {
	/// Percentage points.
	Percent,
	/// Model tokens.
	Tokens,
	/// Requests or operations.
	Requests,
	/// Provider account credits.
	Credits,
	/// United States dollars.
	Usd,
	/// Minutes.
	Minutes,
	/// Bytes.
	Bytes,
	/// Provider-defined units with no stronger classification.
	Unknown,
}

/// Exact fixed-point quantity.
///
/// The represented value is `units / 10^decimal_exponent`.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct UsageQuantity {
	/// Integer coefficient.
	pub units:            u64,
	/// Base-10 fractional digits.
	pub decimal_exponent: u8,
}

impl UsageQuantity {
	/// Constructs a fixed-point quantity.
	pub const fn new(units: u64, decimal_exponent: u8) -> Self {
		Self { units, decimal_exponent }
	}
}

/// Exact quantities for one usage window.
///
/// Per-value exponents preserve providers whose consumed, remaining, and limit
/// USD amounts use different minor-unit scales. `consumed` may exceed `limit`
/// for provider-reported overage; in that case `remaining` is absent or zero.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct UsageAmount {
	/// Quantity unit shared by every populated field.
	pub unit:      UsageUnit,
	/// Consumed quantity.
	pub consumed:  Option<UsageQuantity>,
	/// Remaining quantity.
	pub remaining: Option<UsageQuantity>,
	/// Total limit.
	pub limit:     Option<UsageQuantity>,
}

/// Provider account metadata safe to expose outside the credential boundary.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct UsageAccountMetadata {
	/// Provider-native account identifier, when distinct from the broker ID.
	pub provider_account_id: Option<Str>,
	/// Account email exposed by the provider.
	pub email:               Option<Str>,
	/// Provider project identifier.
	pub project_id:          Option<Str>,
	/// Provider organization identifier.
	pub organization_id:     Option<Str>,
	/// Provider organization display name.
	pub organization_name:   Option<Str>,
}

/// One saved rate-limit reset credit.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UsageResetCredit {
	/// Time at which the credit was granted.
	pub granted_at: Option<SystemTime>,
	/// Time after which the credit can no longer be redeemed.
	pub expires_at: Option<SystemTime>,
	/// Provider-defined lifecycle state such as `available` or `redeemed`.
	pub status:     Option<Str>,
}

/// Saved rate-limit resets available to an account.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UsageResetCredits {
	/// Number of credits redeemable now.
	pub available: u64,
	/// Per-credit details, including expiry times used for soonest-expiry
	/// selection.
	pub credits:   Box<[UsageResetCredit]>,
}

impl UsageResetCredits {
	/// Returns the soonest expiry among credits that are available or have no
	/// provider status.
	pub fn soonest_expiry(&self) -> Option<SystemTime> {
		self
			.credits
			.iter()
			.filter(|credit| {
				credit
					.status
					.as_deref()
					.is_none_or(|status| status.eq_ignore_ascii_case("available"))
			})
			.filter_map(|credit| credit.expires_at)
			.min()
	}
}

/// Provider-declared state of a usage window.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum UsageStatus {
	/// Usage is below the provider warning threshold.
	Ok,
	/// Usage is near its limit.
	Warning,
	/// Usage is exhausted or provider-declared rate-limited.
	Exhausted,
	/// The provider did not expose enough data to classify the window.
	Unknown,
}

/// Account-scoped usage or quota window.
///
/// The shape covers stable bucket IDs and display labels, fixed-point
/// percent/count/token/USD amounts, model or shared scopes, rolling durations,
/// reset verbs and timestamps, per-window advisories, and provenance.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UsageWindow {
	/// Stable provider-defined limit identifier.
	pub id:          Str,
	/// Window category.
	pub kind:        UsageWindowKind,
	/// Dimension name, such as requests, tokens, credits, or concurrency.
	pub dimension:   Str,
	/// Human-facing provider label.
	pub label:       Option<Str>,
	/// Model, tier, backend counter, or shared-bucket scope.
	pub scope:       Option<Str>,
	/// Exact fixed-point quantities.
	pub amount:      UsageAmount,
	/// Provider-declared status when available.
	pub status:      Option<UsageStatus>,
	/// Rolling or calendar duration when known.
	pub duration:    Option<Duration>,
	/// Window reset time when exposed.
	pub resets_at:   Option<SystemTime>,
	/// Verb describing the reset event, such as `tick` or `regen`.
	pub reset_label: Option<Str>,
	/// Window-specific advisory notes.
	pub notes:       Box<[Str]>,
	/// Observation provenance.
	pub source:      UsageSource,
	/// Time at which this observation was recorded.
	pub observed_at: SystemTime,
}

/// Account-scoped usage, quota, and balance answer.
///
/// This is the lossless usage contract: windows carry fractional or
/// absolute percent/request/token/USD values (including independent minor-unit
/// exponents), stable IDs and labels, model/shared scopes, and reset times;
/// reports add plan and account/source metadata, advisory notes, and saved
/// reset-credit details. The fetch boundary separately declares whether a
/// credential lease is needed and distinguishes retainable unavailability,
/// credential rejection, and protocol failure.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UsageReport {
	/// Provider to which the report belongs.
	pub provider:      ProviderId,
	/// Account to which the report belongs.
	pub account:       AccountId,
	/// Principal owning account affinity.
	pub principal:     Option<PrincipalId>,
	/// Provider plan or tier display name.
	pub plan:          Option<Str>,
	/// Provider account metadata.
	pub account_meta:  UsageAccountMetadata,
	/// Provider-defined observation source label.
	pub source_label:  Option<Str>,
	/// Report-wide advisory notes.
	pub notes:         Box<[Str]>,
	/// Saved rate-limit reset credits, when supported.
	pub reset_credits: Option<UsageResetCredits>,
	/// Typed windows returned by the provider or local runtime.
	pub windows:       Vec<UsageWindow>,
}

/// Non-secret account metadata safe for display and receipts.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AccountSummary {
	/// Opaque account identity.
	pub account:   AccountId,
	/// Provider domain.
	pub provider:  ProviderId,
	/// Authenticated principal identity when known.
	pub principal: Option<PrincipalId>,
	/// Caller-facing label.
	pub label:     Option<Str>,
	/// Current lifecycle state.
	pub state:     AccountState,
}

/// Public lifecycle state of an account.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AccountState {
	/// Account may serve requests.
	Active,
	/// Account must refresh before serving.
	RefreshRequired,
	/// Account is administratively or provider disabled.
	Disabled,
	/// Account credentials were removed.
	LoggedOut,
}

/// Public prompt emitted by an interactive authentication flow.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AuthPrompt {
	/// Stable prompt identity.
	pub id:      Str,
	/// Caller-facing prompt text without secret content.
	pub message: Str,
	/// Expected input form.
	pub input:   AuthPromptKind,
}

/// Expected response form for an authentication prompt.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AuthPromptKind {
	/// OAuth authorization code.
	AuthorizationCode,
	/// Static API key.
	ApiKey,
	/// Provider session token.
	SessionToken,
	/// Visible plain text, including an empty default selection.
	PlainText,
	/// Optional secret text for which an empty response means skip.
	OptionalSecret,
	/// Yes-or-no confirmation.
	Confirmation,
}

/// Authentication flow event; secret-bearing variants deliberately omit
/// `Debug`.
pub enum AuthEvent {
	/// Open a browser at the public authorization URL.
	OpenUrl {
		/// Full provider authorization URL.
		url:    Str,
		/// Short loopback launch URL when a callback server is available.
		launch: Option<Str>,
	},
	/// Display a short-lived secret device code and public verification URL.
	ShowDeviceCode {
		/// Secret short-lived device code.
		code:             SecretString,
		/// Public verification URL.
		verification_url: Str,
	},
	/// Ask the caller for typed input.
	Prompt(AuthPrompt),
	/// The provider is waiting for external completion.
	Waiting,
	/// Authentication completed with a non-secret account summary.
	Complete(AccountSummary),
}

/// Caller response routed back to an interactive authentication flow.
pub struct AuthResponse {
	/// Login session receiving the response.
	pub session: LoginSessionId,
	/// Secret or control input.
	pub input:   AuthInput,
}

/// Owned channels for an interactive authentication flow.
pub struct AuthSession {
	/// Stable login session identity.
	pub id:                  LoginSessionId,
	/// Stream-like channel of authentication events or structured errors.
	pub events:              Receiver<Result<AuthEvent, Error>>,
	/// Response channel back to the authentication engine.
	pub responses:           flume::Sender<AuthResponse>,
	pub(crate) cancellation: LoginCancellation,
}

impl AuthSession {
	/// Cancels the flow immediately, including any in-flight network request.
	pub fn cancel(&self) {
		self.cancellation.cancel();
	}
}

/// Authentication or account-management operation answer.
pub enum AuthAnswer {
	/// Newly started or resumed interactive login session.
	Session(AuthSession),
	/// Non-secret account listing.
	Accounts(Vec<AccountSummary>),
	/// Refreshed account metadata.
	Refreshed(AccountSummary),
	/// Account removed from active use.
	LoggedOut(AccountId),
	/// Input was accepted and flow progress continues on the session channel.
	Submitted(LoginSessionId),
}

/// Bounded native response body.
pub enum NativeResponseBody {
	/// Exact validated JSON response bytes preserved without reserialization.
	Json(RawJson),
	/// Immutable binary response.
	Bytes(Bytes),
	/// Incremental opaque response bytes, including native SSE framing.
	Stream(ByteStream),
}

impl fmt::Debug for NativeResponseBody {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		match self {
			Self::Json(value) => formatter
				.debug_tuple("Json")
				.field(&value.as_bytes().len())
				.finish(),
			Self::Bytes(bytes) => formatter.debug_tuple("Bytes").field(&bytes.len()).finish(),
			Self::Stream(_) => formatter.write_str("Stream(..)"),
		}
	}
}

/// Response from one allowlisted native wire operation.
#[derive(Debug)]
pub struct NativeResponse {
	/// HTTP-like response status.
	pub status:              u16,
	/// Response media type when supplied.
	pub media_type:          Option<Str>,
	/// Bounded response body.
	pub body:                NativeResponseBody,
	/// Sanitized provider request identifier.
	pub provider_request_id: Option<Str>,
}

#[cfg(test)]
mod tests {

	use omp_core::sf;

	use super::*;
	use crate::{
		catalog::OperationKind,
		event::{WorkflowAction, WorkflowActionResponse, WorkflowResponseKind},
		operation::job::JobCommand,
	};

	fn job(handle: &'static str) -> JobRef {
		JobRef {
			provider:  ProviderId::from("provider"),
			route:     RouteId::from("route"),
			operation: OperationKind::GenerateVideo,
			handle:    GenerationHandle::from(handle),
		}
	}

	fn checkpoint(job: JobRef) -> JobCheckpointHandle {
		JobCheckpointHandle::new(JobCheckpoint {
			job,
			completed: 0,
			total: None,
			polls: 0,
			expires_at: None,
			created_at: SystemTime::UNIX_EPOCH,
		})
	}

	fn workflow_action(invocation: &'static str, timeout: Option<Duration>) -> ChatEvent {
		ChatEvent::WorkflowAction(WorkflowAction {
			invocation: sf!(invocation),
			call: None,
			name: sf!("host_action"),
			arguments: Bytes::from_static(b"request"),
			timeout,
			response_kind: WorkflowResponseKind::Action,
		})
	}

	fn workflow_response(invocation: &'static str) -> WorkflowResponse {
		WorkflowResponse::WorkflowActionResponse(WorkflowActionResponse {
			invocation: sf!(invocation),
			response:   Bytes::from_static(b"response"),
			is_error:   false,
		})
	}

	#[tokio::test]
	async fn workflow_action_uses_the_live_response_sink_and_resumes_the_same_stream() {
		let (responses, received) = flume::unbounded::<WorkflowResponse>();
		let events = Box::pin(async_stream::stream! {
			yield Ok(workflow_action("invoke-1", None));
			let response = received.recv_async().await.expect("same live response sink");
			assert_eq!(response.invocation().as_str(), "invoke-1");
			yield Ok(ChatEvent::TextDelta { index: 0, text: sf!("resumed") });
		});
		let mut stream = ChatStream::duplex(events, responses);
		let control = stream.control().expect("duplex control");
		assert!(matches!(
			stream.next().await,
			Some(Ok(ChatEvent::WorkflowAction(WorkflowAction { invocation, .. })))
				if invocation.as_str() == "invoke-1"
		));

		control
			.submit(workflow_response("invoke-1"))
			.await
			.expect("live response accepted");
		assert!(matches!(
			stream.next().await,
			Some(Ok(ChatEvent::TextDelta { text, .. })) if text.as_str() == "resumed"
		));
		assert_eq!(
			control.submit(workflow_response("invoke-1")).await,
			Err(ChatControlError::UnknownInvocation),
			"a completed invocation rejects duplicate responses",
		);
	}

	#[tokio::test]
	async fn cancelled_and_expired_workflow_actions_reject_late_responses() {
		let (responses, _received) = flume::unbounded();
		let events = futures::stream::iter([
			Ok(workflow_action("cancelled", None)),
			Ok(ChatEvent::WorkflowCancelled { invocation: sf!("cancelled") }),
			Ok(workflow_action("expired", Some(Duration::ZERO))),
		]);
		let mut stream = ChatStream::duplex(Box::pin(events), responses);
		let control = stream.control().expect("duplex control");
		assert!(matches!(stream.next().await, Some(Ok(ChatEvent::WorkflowAction(_)))));
		assert!(matches!(stream.next().await, Some(Ok(ChatEvent::WorkflowCancelled { .. }))));
		assert_eq!(
			control.submit(workflow_response("cancelled")).await,
			Err(ChatControlError::UnknownInvocation),
		);
		assert!(matches!(stream.next().await, Some(Ok(ChatEvent::WorkflowAction(_)))));
		assert_eq!(
			control.submit(workflow_response("expired")).await,
			Err(ChatControlError::DeadlineExceeded),
		);
	}

	#[tokio::test]
	async fn ordinary_chat_remains_one_way_and_forwards_events() {
		let mut stream =
			ChatStream::ordinary(Box::pin(futures::stream::iter([Ok(ChatEvent::TextDelta {
				index: 0,
				text:  sf!("ordinary"),
			})])));
		assert!(stream.control().is_none());
		assert!(matches!(
			stream.next().await,
			Some(Ok(ChatEvent::TextDelta { text, .. })) if text.as_str() == "ordinary"
		));
	}

	#[test]
	fn generation_session_rejects_mismatched_job_authority() {
		let (cancel, commands) =
			JobCancelHandle::bounded(job("cancel"), 1).expect("bounded cancellation");
		let result = GenerationSession::<VideoArtifact>::new(
			Box::pin(futures::stream::empty()),
			checkpoint(job("checkpoint")),
			cancel,
		);
		assert!(matches!(result, Err(GenerationSessionError::JobMismatch)));
		assert!(commands.try_recv().is_err(), "rejected ownership must not cancel another job");
	}

	#[test]
	fn dropping_generation_session_dispatches_one_nonblocking_cancel() {
		let job = job("video");
		let (cancel, commands) =
			JobCancelHandle::bounded(job.clone(), 1).expect("bounded cancellation");
		let session = GenerationSession::<VideoArtifact>::new(
			Box::pin(futures::stream::empty()),
			checkpoint(job),
			cancel,
		)
		.expect("matching session");
		drop(session);
		assert!(matches!(commands.try_recv(), Ok(JobCommand::Cancel { acknowledgement: None })));
		assert!(commands.try_recv().is_err());
	}
}
