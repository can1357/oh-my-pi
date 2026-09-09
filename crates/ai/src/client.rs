//! Typed operation extraction and a same-instance Tower client.

use std::{future::poll_fn, marker::PhantomData, sync::Arc, time::Instant};

use tower::Service;

use crate::{
	answer::{
		Answer, AnswerBody, AudioStream, AuthAnswer, ChatStream, DetokenizedText, EmbeddingBatch,
		GenerationSession, GenerationStream, ImageArtifact, ModelDiscoveryPage, NativeResponse,
		RealtimeSession, SearchResults, TokenCount, TokenSequence, TranscriptStream, UsageReport,
		VideoArtifact,
	},
	call::{
		AuthRequest, Call, CallMeta, ChatRequest, CountTokensRequest, DetokenizeRequest,
		DiscoveryRequest, EmbedRequest, ImageRequest, NativeRequest, OperationCall, RealtimeRequest,
		SearchRequest, SpeechRequest, TokenizeRequest, TranscriptionRequest, UsageRequest,
		VideoRequest,
	},
	catalog::OperationKind,
	error::{Error, ErrorDetail, ErrorKind},
	operation::parallel_extract::{ParallelExtractRequest, ParallelExtractResult},
	plan::{ExecutionPlan, Planner},
	receipt::{ExecutionReceipt, ReasonId},
	staging::{StagingCancellation, StagingPolicy},
};

/// Typed request that can enter the closed erased service center.
pub trait Operation: Clone + Send + Sync + 'static {
	/// Statically known operation-specific answer body.
	type Output: Send + 'static;
	/// Catalog operation capability required by this request.
	const KIND: OperationKind;

	/// Wraps this request in a clone-cheap erased call.
	fn to_call(&self, meta: CallMeta) -> Call;

	/// Extracts the statically matched body or returns a structured protocol
	/// error.
	fn extract(answer: Answer) -> Result<Self::Output, Error>;
}

macro_rules! impl_operation {
	($request:ty, $kind:ident, $call:ident, $body:ident, $output:ty) => {
		impl Operation for $request {
			type Output = $output;

			const KIND: OperationKind = OperationKind::$kind;

			fn to_call(&self, meta: CallMeta) -> Call {
				Call::new(meta, OperationCall::$call(Arc::new(self.clone())))
			}

			fn extract(answer: Answer) -> Result<Self::Output, Error> {
				let Answer { receipt, body, .. } = answer;
				let actual = body.kind();
				match body {
					AnswerBody::$body(output) => Ok(output),
					_ => Err(Error::body_variant_mismatch(Self::KIND, actual, receipt)),
				}
			}
		}
	};
}

impl_operation!(ChatRequest, Chat, Chat, Chat, ChatStream);
impl_operation!(CountTokensRequest, CountTokens, CountTokens, Tokens, TokenCount);
impl_operation!(TokenizeRequest, Tokenize, Tokenize, TokenIds, TokenSequence);
impl_operation!(DetokenizeRequest, Detokenize, Detokenize, Text, DetokenizedText);
impl_operation!(EmbedRequest, Embed, Embed, Embeddings, EmbeddingBatch);
impl_operation!(
	ImageRequest,
	GenerateImage,
	GenerateImage,
	Images,
	GenerationStream<ImageArtifact>
);
impl_operation!(
	VideoRequest,
	GenerateVideo,
	GenerateVideo,
	Video,
	GenerationSession<VideoArtifact>
);
impl_operation!(SpeechRequest, Speak, Speak, Speech, AudioStream);
impl_operation!(TranscriptionRequest, Transcribe, Transcribe, Transcript, TranscriptStream);
impl_operation!(RealtimeRequest, Realtime, Realtime, Realtime, RealtimeSession);
impl_operation!(SearchRequest, Search, Search, Search, SearchResults);
impl_operation!(
	ParallelExtractRequest,
	Extract,
	ParallelExtract,
	ParallelExtract,
	ParallelExtractResult
);
impl_operation!(UsageRequest, Usage, Usage, Usage, Box<UsageReport>);
impl_operation!(DiscoveryRequest, DiscoverModels, DiscoverModels, Models, ModelDiscoveryPage);
impl_operation!(AuthRequest, Auth, Auth, Auth, AuthAnswer);
impl_operation!(NativeRequest, Native, Native, Native, NativeResponse);

/// Credential-free, typed plan produced without polling or calling a service.
pub struct PlannedOperation<O: Operation> {
	call:   Call,
	plan:   Arc<ExecutionPlan>,
	marker: PhantomData<fn() -> O>,
}

impl<O: Operation> PlannedOperation<O> {
	/// Borrows the clone-cheap erased call for inspection.
	pub const fn call(&self) -> &Call {
		&self.call
	}

	/// Borrows the immutable selected execution plan.
	pub fn execution_plan(&self) -> &ExecutionPlan {
		&self.plan
	}

	/// Returns the statically known operation capability.
	pub const fn kind(&self) -> OperationKind {
		O::KIND
	}
}

/// Typed facade over one Tower inference service and one side-effect-free
/// planner.
pub struct Client<S, P> {
	service:  S,
	planner:  P,
	meta:     CallMeta,
	affinity: crate::call::CallAffinity,
	staging:  Option<crate::call::StagingRequest>,
}

impl<S, P> Client<S, P>
where
	P: Planner,
{
	/// Creates a client with a clone-cheap planner and caller-supplied metadata
	/// defaults.
	pub const fn new(service: S, planner: P, meta: CallMeta) -> Self {
		Self { service, planner, meta, affinity: crate::call::CallAffinity::none(), staging: None }
	}

	/// Attaches session-independent prompt-cache and provider-session
	/// identities to every subsequent call.
	pub fn with_affinity(mut self, affinity: crate::call::CallAffinity) -> Self {
		self.affinity = affinity;
		self
	}

	/// Borrows the affinity attached to subsequent calls.
	pub const fn affinity(&self) -> &crate::call::CallAffinity {
		&self.affinity
	}

	/// Borrows the underlying service.
	pub const fn service(&self) -> &S {
		&self.service
	}

	/// Mutably borrows the underlying service.
	pub const fn service_mut(&mut self) -> &mut S {
		&mut self.service
	}

	/// Borrows the side-effect-free planner.
	pub const fn planner(&self) -> &P {
		&self.planner
	}

	/// Borrows the metadata used by subsequent side-effect-free plans.
	pub const fn call_meta(&self) -> &CallMeta {
		&self.meta
	}

	/// Replaces metadata used by subsequent side-effect-free plans.
	pub fn set_call_meta(&mut self, meta: CallMeta) {
		self.meta = meta;
	}

	/// Authorizes secure staging for one-shot bodies in subsequent calls.
	pub fn set_staging(&mut self, policy: StagingPolicy, cancellation: StagingCancellation) {
		self.staging = Some(crate::call::StagingRequest { policy, cancellation });
	}

	/// Returns this client with secure staging authorized for one-shot bodies.
	pub fn with_staging(mut self, policy: StagingPolicy, cancellation: StagingCancellation) -> Self {
		self.set_staging(policy, cancellation);
		self
	}

	/// Returns the service, planner, current call metadata, and staging policy.
	pub fn into_parts(self) -> (S, P, CallMeta, Option<crate::call::StagingRequest>) {
		(self.service, self.planner, self.meta, self.staging)
	}

	/// Selects and negotiates an immutable plan without polling or calling the
	/// service.
	pub fn plan<O: Operation>(&self, operation: &O) -> Result<PlannedOperation<O>, Error> {
		let mut call = operation.to_call(self.meta.clone());
		call.affinity = self.affinity.clone();
		call.staging = self.staging.clone();
		let plan = Arc::new(self.planner.plan(&mut call, Instant::now())?);
		if plan.operation != O::KIND {
			return Err(Error::planning(
				ErrorKind::InternalInvariant,
				ErrorDetail::protocol(ReasonId(omp_core::sf!("planner-operation-mismatch",))),
				ExecutionReceipt::default(),
			));
		}
		call.execution = Some(plan.clone());
		Ok(PlannedOperation { call, plan, marker: PhantomData })
	}
}

impl<S, P> Client<S, P>
where
	S: Service<Call, Response = Answer, Error = Error>,
	P: Planner,
{
	/// Plans and executes a typed operation.
	pub async fn execute<O: Operation>(&mut self, operation: O) -> Result<O::Output, Error> {
		let plan = self.plan(&operation)?;
		self.execute_plan(plan).await
	}

	/// Revalidates and executes an existing typed plan on this exact service
	/// instance.
	pub async fn execute_plan<O: Operation>(
		&mut self,
		plan: PlannedOperation<O>,
	) -> Result<O::Output, Error> {
		self.planner.validate(&plan.plan, Instant::now())?;
		self.dispatch::<O>(plan.call).await
	}

	async fn dispatch<O: Operation>(&mut self, call: Call) -> Result<O::Output, Error> {
		poll_fn(|context| self.service.poll_ready(context)).await?;
		let answer = self.service.call(call).await?;
		O::extract(answer)
	}
}

#[cfg(test)]
mod tests {
	use std::{
		future::{Ready, ready},
		sync::{
			Arc,
			atomic::{AtomicUsize, Ordering},
		},
		task::{Context, Poll},
		time::{Instant, SystemTime},
	};

	use futures::stream;
	use omp_core::sf;
	use tower::Service;

	use super::*;
	use crate::{
		answer::{
			AccountState, AccountSummary, Answer, AnswerBody, AuthAnswer, EmbeddingBatch,
			GenerationSession, NativeResponse, NativeResponseBody, OutputStream, RealtimeSession,
			ResponseMeta, SearchResults, TokenCount, TokenSequence, TokenizerProvenance,
			UsageAccountMetadata, UsageReport,
		},
		call::{CallMeta, CountAccuracy, Target},
		catalog::{ModelKey, OperationKind, ProviderId, RouteId},
		error::{ErrorDetail, ErrorKind},
		id::{AccountId, GenerationHandle, RequestId},
		operation::job::{JobCancelHandle, JobCheckpoint, JobCheckpointHandle, JobRef},
		receipt::{ExecutionBudget, ExecutionReceipt, Usage},
	};

	fn meta() -> ResponseMeta {
		ResponseMeta {
			request_id:          RequestId::from("request"),
			provider:            ProviderId::from("provider"),
			route:               RouteId::from("route"),
			model:               Some(ModelKey::from("model")),
			provider_request_id: None,
			created_at:          SystemTime::UNIX_EPOCH,
		}
	}

	fn answer(body: AnswerBody) -> Answer {
		Answer { meta: meta(), receipt: ExecutionReceipt::default(), body }
	}
	fn empty_stream<T: Send + 'static>() -> OutputStream<T> {
		Box::pin(stream::empty())
	}

	fn generation_session<T: Send + 'static>() -> GenerationSession<T> {
		let job = JobRef {
			provider:  ProviderId::from("provider"),
			route:     RouteId::from("route"),
			operation: OperationKind::GenerateVideo,
			handle:    GenerationHandle::from("job"),
		};
		let checkpoint = JobCheckpointHandle::new(JobCheckpoint {
			job:        job.clone(),
			completed:  0,
			total:      None,
			polls:      0,
			expires_at: None,
			created_at: SystemTime::UNIX_EPOCH,
		});
		let (cancel, _commands) = JobCancelHandle::bounded(job, 1).expect("bounded cancellation");
		GenerationSession::new(empty_stream(), checkpoint, cancel).expect("matching job session")
	}

	#[test]
	fn every_operation_extracts_its_body_without_casts() {
		let provenance =
			TokenizerProvenance { tokenizer: sf!("tok"), revision: sf!("1"), exact: true };
		assert!(
			ChatRequest::extract(answer(AnswerBody::Chat(ChatStream::ordinary(empty_stream()))))
				.is_ok()
		);
		assert!(
			CountTokensRequest::extract(answer(AnswerBody::Tokens(TokenCount {
				tokens:     1,
				provenance: provenance.clone(),
			})))
			.is_ok()
		);
		assert!(
			TokenizeRequest::extract(answer(AnswerBody::TokenIds(TokenSequence {
				tokens:     vec![1],
				provenance: provenance.clone(),
			})))
			.is_ok()
		);
		assert!(
			DetokenizeRequest::extract(answer(AnswerBody::Text(DetokenizedText {
				text: sf!("text"),
				provenance,
			})))
			.is_ok()
		);
		assert!(
			EmbedRequest::extract(answer(AnswerBody::Embeddings(EmbeddingBatch {
				dimensions: 1,
				embeddings: Vec::new(),
				usage:      Usage::default(),
			})))
			.is_ok()
		);
		assert!(ImageRequest::extract(answer(AnswerBody::Images(empty_stream()))).is_ok());
		assert!(VideoRequest::extract(answer(AnswerBody::Video(generation_session()))).is_ok());
		assert!(SpeechRequest::extract(answer(AnswerBody::Speech(empty_stream()))).is_ok());
		assert!(
			TranscriptionRequest::extract(answer(AnswerBody::Transcript(empty_stream()))).is_ok()
		);
		let (realtime, _provider) = RealtimeSession::bounded(1).expect("bounded realtime session");
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
				provider:      ProviderId::from("provider"),
				account:       AccountId::from("account"),
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
			AuthRequest::extract(answer(AnswerBody::Auth(AuthAnswer::Accounts(vec![
				AccountSummary {
					account:   AccountId::from("account"),
					provider:  ProviderId::from("provider"),
					principal: None,
					label:     None,
					state:     AccountState::Active,
				}
			]))))
			.is_ok()
		);
		assert!(
			NativeRequest::extract(answer(AnswerBody::Native(NativeResponse {
				status:              200,
				media_type:          None,
				body:                NativeResponseBody::Bytes(bytes::Bytes::new()),
				provider_request_id: None,
			})))
			.is_ok()
		);
	}

	#[test]
	fn body_mismatch_is_a_structured_internal_protocol_error() {
		let error = ChatRequest::extract(answer(AnswerBody::Text(DetokenizedText {
			text:       sf!("wrong"),
			provenance: TokenizerProvenance {
				tokenizer: sf!("tok"),
				revision:  sf!("1"),
				exact:     true,
			},
		})))
		.err()
		.expect("mismatch");
		assert_eq!(error.kind, ErrorKind::ProviderContractMismatch);
		assert!(matches!(
			error.detail_ref(),
			Some(ErrorDetail::BodyVariantMismatch {
				expected: OperationKind::Chat,
				actual:   crate::answer::AnswerKind::Text,
			})
		));
	}

	#[derive(Clone)]
	struct RejectingPlanner;

	impl Planner for RejectingPlanner {
		fn plan(&self, _: &mut Call, _: Instant) -> Result<ExecutionPlan, Error> {
			Err(Error::planning(
				ErrorKind::CapabilityMismatch,
				ErrorDetail::protocol(ReasonId(sf!("unsupported-test-operation"))),
				ExecutionReceipt::default(),
			))
		}

		fn validate(&self, _: &ExecutionPlan, _: Instant) -> Result<(), Error> {
			Ok(())
		}
	}

	struct ReadinessService {
		phase: Arc<AtomicUsize>,
	}

	impl Service<Call> for ReadinessService {
		type Error = Error;
		type Future = Ready<Result<Answer, Error>>;
		type Response = Answer;

		fn poll_ready(&mut self, _: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
			assert_eq!(
				self
					.phase
					.compare_exchange(0, 1, Ordering::SeqCst, Ordering::SeqCst),
				Ok(0)
			);
			Poll::Ready(Ok(()))
		}

		fn call(&mut self, _: Call) -> Self::Future {
			assert_eq!(
				self
					.phase
					.compare_exchange(1, 2, Ordering::SeqCst, Ordering::SeqCst),
				Ok(1)
			);
			ready(Ok(answer(AnswerBody::Tokens(TokenCount {
				tokens:     7,
				provenance: TokenizerProvenance {
					tokenizer: sf!("tok"),
					revision:  sf!("1"),
					exact:     true,
				},
			}))))
		}
	}

	#[tokio::test]
	async fn readiness_and_call_use_the_same_service_instance() {
		let phase = Arc::new(AtomicUsize::new(0));
		let service = ReadinessService { phase: phase.clone() };
		let call_meta = CallMeta {
			id:             RequestId::from("request"),
			target:         Target::Model(ModelKey::from("model")),
			deadline:       Some(Instant::now()),
			budget:         ExecutionBudget::default(),
			session:        None,
			debug_session:  None,
			response_hooks: Default::default(),
		};
		let mut client = Client::new(service, RejectingPlanner, call_meta.clone());
		let request = CountTokensRequest {
			messages: Arc::new([]),
			tools:    Arc::new([]),
			accuracy: CountAccuracy::Exact,
		};
		let output = client
			.dispatch::<CountTokensRequest>(request.to_call(call_meta))
			.await
			.expect("dispatch");
		assert_eq!(output.tokens, 7);
		assert_eq!(phase.load(Ordering::SeqCst), 2);
	}

	#[test]
	fn impossible_planning_fails_without_polling_the_service() {
		let phase = Arc::new(AtomicUsize::new(0));
		let service = ReadinessService { phase: phase.clone() };
		let call_meta = CallMeta {
			id:             RequestId::from("request"),
			target:         Target::Model(ModelKey::from("model")),
			deadline:       None,
			budget:         ExecutionBudget::default(),
			session:        None,
			debug_session:  None,
			response_hooks: Default::default(),
		};
		let client = Client::new(service, RejectingPlanner, call_meta);
		let request = CountTokensRequest {
			messages: Arc::new([]),
			tools:    Arc::new([]),
			accuracy: CountAccuracy::Exact,
		};
		let Err(error) = client.plan(&request) else {
			panic!("unsupported operation planned")
		};
		assert_eq!(error.kind, ErrorKind::CapabilityMismatch);
		assert_eq!(phase.load(Ordering::SeqCst), 0);
	}
}
