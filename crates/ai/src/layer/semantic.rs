//! Transactional semantic retries whose provisional output is owned only by
//! `OutputGate`.

use std::{
	mem,
	task::{Context, Poll},
};

use futures::{StreamExt, future::poll_fn, stream};
use tower::{Layer, Service};

use crate::{
	body::RetryDecision,
	codec::{HandshakenResponse, RawEvent},
	error::{Error, ErrorKind, ErrorPhase, RetryAction},
	gate::{GateCondition, GateFinish, GateProgress, OutputGate, SecureGateSpool},
	layer::LayerCall,
	receipt::AttemptOutcome,
};

/// Selects whether an operation requires transactional semantic validation.
pub trait SemanticPolicy<R>: Clone + Send + 'static {
	/// Returns the gate condition, or `None` for ordinary first-event commit
	/// semantics.
	fn condition(&self, request: &R) -> Option<GateCondition>;
	/// Maximum hidden semantic retries; the overall attempt budget remains
	/// authoritative.
	fn max_retries(&self, request: &R) -> u32;
	/// Creates a fresh caller-explicit secure spool for one hidden attempt.
	///
	/// Returning `None` keeps the gate memory-only; the gate never creates or
	/// discovers a spool.
	fn secure_spool(&self, _request: &R) -> Result<Option<Box<dyn SecureGateSpool>>, Box<Error>> {
		Ok(None)
	}
}

/// Adds transactional semantic validation.
#[derive(Clone, Debug)]
pub struct SemanticLayer<P> {
	policy: P,
}
impl<P> SemanticLayer<P> {
	/// Creates a semantic layer.
	pub const fn new(policy: P) -> Self {
		Self { policy }
	}
}
/// Semantic-attempt service.
#[derive(Clone, Debug)]
pub struct SemanticService<S, P> {
	inner:  S,
	policy: P,
}
impl<S, P: Clone> Layer<S> for SemanticLayer<P> {
	type Service = SemanticService<S, P>;

	fn layer(&self, inner: S) -> Self::Service {
		SemanticService { inner, policy: self.policy.clone() }
	}
}

impl<S, P, R> Service<LayerCall<R>> for SemanticService<S, P>
where
	S: Service<LayerCall<R>, Response = HandshakenResponse, Error = Error> + Clone,
	P: SemanticPolicy<R>,
	R: Clone,
{
	type Error = Error;
	type Response = HandshakenResponse;

	type Future = impl Future<Output = Result<HandshakenResponse, Error>>;

	fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), Error>> {
		self.inner.poll_ready(cx)
	}

	fn call(&mut self, request: LayerCall<R>) -> Self::Future {
		let replacement = self.inner.clone();
		let mut service = mem::replace(&mut self.inner, replacement);
		let condition = self.policy.condition(&request.payload);
		let max_retries = self.policy.max_retries(&request.payload);
		let policy = self.policy.clone();
		async move {
			let Some(condition) = condition else {
				return service.call(request).await;
			};
			let mut semantic_retry = 0;
			loop {
				request.context.clear_body_evidence();
				request.context.begin_response_attempt();
				let mut response = service.call(request.clone()).await?;
				request.context.set_body_evidence(response.body.evidence());
				let Some(mut events) = response.events.take() else {
					if response.realtime.is_some() {
						return Ok(response);
					}
					return Err(Error::new(
						ErrorKind::ProviderContractMismatch,
						ErrorPhase::Recovery,
						RetryAction::Never,
						request.context.receipt(),
					));
				};
				let receipt = request.context.receipt();
				let mut gate = match policy
					.secure_spool(&request.payload)
					.map_err(|error| *error)?
				{
					Some(spool) => OutputGate::with_secure_spool(
						condition.clone(),
						request.context.budget().max_provisional_bytes,
						spool,
						receipt,
					),
					None => OutputGate::with_receipt(
						condition.clone(),
						request.context.budget().max_provisional_bytes,
						receipt,
					),
				};
				let mut visible = Vec::new();
				let mut committed = false;
				let mut failure = None;
				let mut terminal = None;
				while let Some(item) = events.next().await {
					match item {
						Ok(RawEvent::Chat(event)) => {
							match gate.push(event, &mut |event| visible.push(Ok(RawEvent::Chat(event)))) {
								Ok(GateProgress::Committed { .. } | GateProgress::PassThrough) => {
									committed = true;
									break;
								},
								Ok(GateProgress::Rejected) => break,
								Ok(GateProgress::Provisional) => {},
								Err(error) => {
									failure = Some(error);
									break;
								},
							}
						},
						Ok(completion @ RawEvent::Completion(_)) => {
							terminal = Some(completion);
							if request.context.structured_output_valid()
								&& matches!(gate.condition(), GateCondition::ValidStructuredOutput)
							{
								match gate.mark_structured_output_valid(&mut |event| {
									visible.push(Ok(RawEvent::Chat(event)));
								}) {
									Ok(GateProgress::Committed { .. }) => committed = true,
									Ok(_) => {
										failure = Some(Error::new(
											ErrorKind::InternalInvariant,
											ErrorPhase::Recovery,
											RetryAction::Never,
											request.context.receipt(),
										));
									},
									Err(error) => failure = Some(error),
								}
							}
							break;
						},
						Ok(_) => {
							failure = Some(Error::new(
								ErrorKind::ProviderContractMismatch,
								ErrorPhase::Recovery,
								RetryAction::Never,
								request.context.receipt(),
							));
							break;
						},
						Err(error) => {
							request.context.set_body_evidence(response.body.evidence());
							if let Some(attempt) = error.receipt().attempts.last() {
								request.context.set_body_evidence(attempt.body);
							}
							failure = Some(gate.fail(error));
							break;
						},
					}
				}
				request.context.merge_receipt(gate.receipt());
				if committed && let Some(terminal) = terminal.take() {
					visible.push(Ok(terminal));
				}
				if committed {
					response.events = Some(Box::pin(stream::iter(visible).chain(events)));
					return Ok(response);
				}
				if failure.is_none() {
					match gate.finish(&mut |event| visible.push(Ok(RawEvent::Chat(event))))? {
						GateFinish::Committed { .. } | GateFinish::AlreadyCommitted => {
							if let Some(terminal) = terminal.take() {
								visible.push(Ok(terminal));
							}
							response.events = Some(Box::pin(stream::iter(visible)));
							return Ok(response);
						},
						GateFinish::Unsatisfied(_) => {},
					}
				}
				request.context.with_receipt(|receipt| {
					if let Some(attempt) = receipt.attempts.last_mut() {
						attempt.hidden = true;
						attempt.outcome = AttemptOutcome::RejectedSemantic;
					}
				});
				request.context.set_body_evidence(response.body.evidence());
				let mut error = failure
					.unwrap_or_else(|| {
						Error::new(
							ErrorKind::ToolNonCompliance,
							ErrorPhase::Recovery,
							RetryAction::SemanticRetry,
							gate.receipt().clone(),
						)
					})
					.committed(false);
				let replay_safe = request
					.context
					.body_evidence()
					.is_some_and(|evidence| evidence.retry_decision == RetryDecision::Allow);
				let retryable_action = matches!(
					&error.action,
					RetryAction::SemanticRetry
						| RetryAction::SameRoute { .. }
						| RetryAction::SameRouteLimited { .. }
				);
				let action_limit = match &error.action {
					RetryAction::SameRouteLimited { max_retries: failure_limit, .. } => {
						max_retries.min(*failure_limit)
					},
					_ => max_retries,
				};
				let retries_exhausted = semantic_retry >= action_limit;
				if retries_exhausted || !replay_safe || !retryable_action {
					error.action =
						exhausted_action(&error, retries_exhausted, replay_safe, retryable_action);
					request.context.finalize_error(&mut error);
					return Err(error);
				}
				tracing::warn!(
					retry_attempt = semantic_retry.saturating_add(1),
					error_kind = ?error.kind,
					error_phase = ?error.phase,
					"semantic validation rejected provider output; retrying"
				);
				semantic_retry += 1;
				poll_fn(|cx| service.poll_ready(cx)).await?;
			}
		}
	}
}

fn exhausted_action(
	error: &Error,
	retries_exhausted: bool,
	replay_safe: bool,
	retryable_action: bool,
) -> RetryAction {
	if retries_exhausted
		&& replay_safe
		&& retryable_action
		&& !error.committed
		&& error.kind == ErrorKind::EmptyCompletion
	{
		// Eventless silence may fail over while the route remains uncommitted,
		// using the `!started` gate. Thought-only completions are
		// terminal `EmptyOutput` errors and therefore never reach this branch;
		// `registry::fallback_is_safe` still requires replay permission before
		// advancing to a sibling route.
		RetryAction::ReselectRoute
	} else {
		RetryAction::Never
	}
}

#[cfg(test)]
mod tests {
	use std::{
		sync::{
			Arc,
			atomic::{AtomicUsize, Ordering},
		},
		time::Duration,
	};

	use bytes::Bytes;
	use futures::stream;
	use omp_core::sf;
	use tower::{Layer, Service, service_fn};

	use super::{SemanticLayer, SemanticPolicy, exhausted_action};
	use crate::{
		body::{AttemptBodyEvidence, BodySource, Replayability, RetryDecision, RetryDecisionReason},
		codec::{HandshakeMeta, HandshakenResponse, RawEvent},
		error::{Error, ErrorKind, ErrorPhase, RetryAction},
		event::ChatEvent,
		gate::GateCondition,
		layer::{ExecutionContext, LayerCall},
		receipt::{
			AttemptOutcome, AttemptReceipt, Cost, ExecutionBudget, ExecutionReceipt, ProviderEvidence,
			Usage,
		},
	};

	#[derive(Clone, Copy)]
	struct WholeAttemptPolicy;

	impl SemanticPolicy<()> for WholeAttemptPolicy {
		fn condition(&self, (): &()) -> Option<GateCondition> {
			Some(GateCondition::WholeAttempt)
		}

		fn max_retries(&self, (): &()) -> u32 {
			1
		}
	}

	fn replayable_body() -> AttemptBodyEvidence {
		AttemptBodyEvidence {
			opened:         true,
			consumed:       true,
			replayability:  Replayability::Replayable,
			retry_decision: RetryDecision::Allow,
			reason:         RetryDecisionReason::ReplayableSource,
		}
	}

	fn attempt() -> AttemptReceipt {
		AttemptReceipt {
			index:             0,
			hidden:            false,
			provider:          None,
			route:             None,
			account:           None,
			principal:         None,
			body:              replayable_body(),
			outcome:           AttemptOutcome::FailedPreCommit,
			usage:             Usage::default(),
			cost:              Cost::default(),
			provider_evidence: ProviderEvidence::default(),
			elapsed:           Duration::ZERO,
		}
	}

	fn receipt() -> ExecutionReceipt {
		let mut receipt = ExecutionReceipt::default();
		receipt.record_attempt(attempt());
		receipt
	}

	fn context() -> ExecutionContext {
		let budget = ExecutionBudget { max_provisional_bytes: 1024, ..ExecutionBudget::default() };
		let context = ExecutionContext::new(budget);
		context.with_receipt(|destination| *destination = receipt());
		context
	}

	async fn exhaust(kind: ErrorKind) -> (Error, usize) {
		let calls = Arc::new(AtomicUsize::new(0));
		let inner_calls = Arc::clone(&calls);
		let inner = service_fn(move |call: LayerCall<()>| {
			inner_calls.fetch_add(1, Ordering::SeqCst);
			async move {
				let body = BodySource::bytes(Bytes::new())
					.begin_attempt()
					.evidence_handle();
				let error = Error::new(
					kind,
					ErrorPhase::Recovery,
					RetryAction::SemanticRetry,
					call.context.receipt(),
				);
				Ok::<_, Error>(HandshakenResponse {
					meta: HandshakeMeta {
						status:              None,
						headers:             Box::new([]),
						provider_request_id: None,
					},
					body,
					events: Some(Box::pin(stream::iter([
						Ok(RawEvent::Chat(ChatEvent::ThinkingDelta {
							index: 0,
							text:  sf!("private reasoning"),
						})),
						Err(error),
					]))),
					control: None,
					realtime: None,
				})
			}
		});
		let mut service = SemanticLayer::new(WholeAttemptPolicy).layer(inner);
		futures::future::poll_fn(|cx| service.poll_ready(cx))
			.await
			.unwrap();
		let Err(error) = service
			.call(LayerCall { payload: (), context: context() })
			.await
		else {
			panic!("semantic exhaustion must fail");
		};
		(error, calls.load(Ordering::SeqCst))
	}

	#[tokio::test]
	async fn empty_completion_exhaustion_reselects_preplanned_fallback() {
		let (error, calls) = exhaust(ErrorKind::EmptyCompletion).await;

		assert_eq!(error.action, RetryAction::ReselectRoute);
		assert!(!error.committed);
		assert_eq!(calls, 2, "{error:?}");
		assert!(error.receipt().attempts.last().is_some_and(|attempt| {
			attempt.outcome != AttemptOutcome::FailedCommitted
				&& attempt.body.retry_decision == RetryDecision::Allow
		}));
		let has_next = true;
		assert!(
			has_next
				&& !error.committed
				&& error.action == RetryAction::ReselectRoute
				&& error.receipt().attempts.last().is_some_and(|attempt| {
					attempt.outcome != AttemptOutcome::FailedCommitted
						&& attempt.body.retry_decision == RetryDecision::Allow
				})
		);
	}

	#[tokio::test]
	async fn non_empty_semantic_exhaustion_stays_terminal() {
		let (error, calls) = exhaust(ErrorKind::ToolNonCompliance).await;

		assert_eq!(error.action, RetryAction::Never);
		assert_eq!(calls, 2, "{error:?}");
	}
	#[tokio::test]
	async fn repeated_reasoning_exhaustion_resamples_the_same_route_then_stays_terminal() {
		// A thinking loop is a same-model resample signal, not a route fault:
		// the loop guard's SemanticRetry re-runs the SAME route, and exhaustion
		// must never promote to ReselectRoute. Walking preplanned fallbacks
		// would swap a healthy turn to another model based on chain contents,
		// not model health.
		let (error, calls) = exhaust(ErrorKind::RepeatedReasoning).await;

		assert_eq!(calls, 2, "loop-guard retries stay on the same route: {error:?}");
		assert_eq!(error.kind, ErrorKind::RepeatedReasoning);
		assert_eq!(error.action, RetryAction::Never);
	}

	#[test]
	fn committed_empty_completion_exhaustion_stays_terminal() {
		let error = Error::new(
			ErrorKind::EmptyCompletion,
			ErrorPhase::Recovery,
			RetryAction::SemanticRetry,
			receipt(),
		)
		.committed(true);

		assert_eq!(exhausted_action(&error, true, true, true), RetryAction::Never);
	}
}
