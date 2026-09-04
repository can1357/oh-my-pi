//! Conversation context strategy, provider-state binding, and explicit
//! replay-safe reseed actions.

use std::{
	mem,
	sync::Arc,
	task::{Context, Poll},
};

use futures::future::poll_fn;
use tower::{Layer, Service};

use crate::{
	body::{AttemptBodyEvidence, Replayability, RetryDecision, RetryDecisionReason},
	call::Call,
	codec::ProviderStateEvent,
	error::{Error, RetryAction},
	event::ChatEvent,
	layer::{ExecutionContext, LayerCall},
	plan::ReplayPlan,
	receipt::ExecutionReceipt,
};

/// Observable session action selected before attempts begin.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SessionAction {
	/// Reuse a valid provider-state binding.
	Reuse,
	/// Send canonical history without provider-side state.
	Replay,
	/// Reseed expired or invalid provider-side state from canonical history.
	Reseed,
	/// No conversation state applies.
	None,
}
/// Private terminal transaction prepared by session policy for one response.
///
/// Implementations own the concrete `TurnDraft`; `commit` must append history,
/// its pending provider binding, and any terminal replay outcome in one store
/// transaction. Dropping or failing a response calls `abort` and publishes none
/// of them.
pub trait SessionCompletion: Send + Sync + 'static {
	/// Incrementally records one recovered canonical event in the private
	/// assistant-message builder.
	fn record_chat_event(&self, event: &ChatEvent, context: &ExecutionContext) -> Result<(), Error>;
	/// Atomically commits the successful turn, provider-state evidence, and any
	/// staged terminal replay outcome.
	fn commit(
		&self,
		provider_state: Vec<ProviderStateEvent>,
		receipt: &ExecutionReceipt,
		context: &ExecutionContext,
	) -> Result<(), Error>;
	/// Aborts the private draft; `retain_preparation` preserves original input
	/// for one reseed.
	fn abort(&self, retain_preparation: bool);
}

/// Selects context strategy and validates typed provider-state scope.
pub trait SessionPlanner: Clone + Send + 'static {
	/// Applies an initial session decision and records non-secret evidence.
	fn prepare(&self, call: &mut Call, context: &ExecutionContext) -> Result<SessionAction, Error>;
	/// Removes invalid provider state and deterministically replays canonical
	/// history.
	fn reseed(&self, call: &mut Call, context: &ExecutionContext) -> Result<(), Error> {
		self.prepare(call, context).map(|_| ())
	}
	/// Creates the private terminal transaction after preparation. The default
	/// is stateless.
	fn completion(
		&self,
		_call: &Call,
		_context: &ExecutionContext,
	) -> Result<Option<Arc<dyn SessionCompletion>>, Error> {
		Ok(None)
	}
}
/// Adds session preparation and replay-safe reseed routing.
#[derive(Clone, Debug)]
pub struct SessionLayer<P> {
	planner: P,
}
impl<P> SessionLayer<P> {
	/// Creates a session layer.
	pub const fn new(planner: P) -> Self {
		Self { planner }
	}
}
/// Session-aware service.
#[derive(Clone, Debug)]
pub struct SessionService<S, P> {
	inner:   S,
	planner: P,
}
impl<S, P: Clone> Layer<S> for SessionLayer<P> {
	type Service = SessionService<S, P>;

	fn layer(&self, inner: S) -> Self::Service {
		SessionService { inner, planner: self.planner.clone() }
	}
}
impl<S, P> Service<LayerCall<Call>> for SessionService<S, P>
where
	S: Service<LayerCall<Call>, Error = Error> + Clone,
	P: SessionPlanner,
{
	type Error = Error;
	type Response = S::Response;

	type Future = impl Future<Output = Result<S::Response, Error>>;

	fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), Error>> {
		self.inner.poll_ready(cx)
	}

	fn call(&mut self, mut request: LayerCall<Call>) -> Self::Future {
		let prepared = self
			.planner
			.prepare(&mut request.payload, &request.context)
			.and_then(|action| {
				let completion = self
					.planner
					.completion(&request.payload, &request.context)?;
				request.context.set_session_completion(completion);
				Ok(action)
			});
		let replacement = self.inner.clone();
		let mut service = mem::replace(&mut self.inner, replacement);
		let planner = self.planner.clone();
		async move {
			prepared?;
			let mut reseeds = 0_u32;
			loop {
				request
					.context
					.set_body_evidence(prebody_evidence(&request.payload));
				let result = service.call(request.clone()).await;
				let mut error = match result {
					Ok(response) => return Ok(response),
					Err(error) => error,
				};
				if !matches!(&error.action, RetryAction::ReseedSession) {
					return Err(error);
				}
				if let Some(attempt) = error.receipt().attempts.last() {
					request.context.set_body_evidence(attempt.body);
				}
				let replay_safe = request
					.context
					.body_evidence()
					.is_some_and(|evidence| evidence.retry_decision == RetryDecision::Allow);
				if error.committed || !replay_safe || reseeds >= 1 {
					error.action = RetryAction::Never;
					return Err(error);
				}
				for attempt in &error.receipt().attempts {
					request.context.with_receipt(|receipt| {
						if !receipt
							.attempts
							.iter()
							.any(|stored| stored.index == attempt.index)
						{
							let mut hidden = attempt.clone();
							hidden.hidden = true;
							receipt.record_attempt(hidden);
						}
					});
				}
				request.context.abort_session_for_reseed();
				tracing::warn!(
					error_kind = ?error.kind,
					error_phase = ?error.phase,
					"provider session state rejected; reseeding from canonical history"
				);
				planner.reseed(&mut request.payload, &request.context)?;
				let completion = planner.completion(&request.payload, &request.context)?;
				request.context.set_session_completion(completion);
				reseeds += 1;
				poll_fn(|cx| service.poll_ready(cx)).await?;
			}
		}
	}
}

fn prebody_evidence(call: &Call) -> AttemptBodyEvidence {
	match call.execution.as_ref().map(|plan| plan.replay) {
		Some(ReplayPlan::SecureStaging { .. }) => AttemptBodyEvidence {
			opened:         false,
			consumed:       false,
			replayability:  Replayability::Staged,
			retry_decision: RetryDecision::Allow,
			reason:         RetryDecisionReason::StagedSource,
		},
		Some(ReplayPlan::OneShotSingleAttempt) => AttemptBodyEvidence {
			opened:         false,
			consumed:       false,
			replayability:  Replayability::OneShot,
			retry_decision: RetryDecision::Allow,
			reason:         RetryDecisionReason::OneShotUnopened,
		},
		Some(ReplayPlan::Replayable) | None => AttemptBodyEvidence {
			opened:         false,
			consumed:       false,
			replayability:  Replayability::Replayable,
			retry_decision: RetryDecision::Allow,
			reason:         RetryDecisionReason::ReplayableSource,
		},
	}
}
