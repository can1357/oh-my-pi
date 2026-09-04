//! Pre-commit, replay-evidence-driven transport retry on the same route and
//! account.

use std::{
	future, mem,
	sync::Arc,
	task::{Context, Poll},
	time,
};

use omp_core::Str;
use ring::rand::{SecureRandom as _, SystemRandom};
use tower::{Layer, Service};

use crate::{
	body::RetryDecision,
	error::{Error, ErrorKind, ErrorPhase, RetryAction},
	layer::{ExecutionContext, LayerCall},
};

/// A same-route retry the transport layer is about to wait for.
///
/// Published through the call's retry sink before the backoff sleep starts,
/// so an interactive host can show a `Retrying (X/Y) in Zs…` countdown.
/// The notice is ephemeral: it is never journaled and never affects replay.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RetryNotice {
	/// One-based index of the attempt about to run.
	pub attempt:      u32,
	/// Total attempts the policy allows on this route.
	pub max_attempts: u32,
	/// Backoff the layer waits before the attempt.
	pub delay:        time::Duration,
	/// Classification of the failure being retried.
	pub kind:         ErrorKind,
	/// Human-readable failure summary.
	pub message:      Str,
}

/// Clone-cheap observer for [`RetryNotice`]s.
pub type RetrySink = Arc<dyn Fn(RetryNotice) + Send + Sync>;

/// Full-jitter exponential backoff policy.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RetryBackoff {
	/// First exponential ceiling.
	pub base:    time::Duration,
	/// Largest exponential ceiling; zero disables both provider-wait and
	/// exponential-delay caps.
	pub maximum: time::Duration,
}

impl RetryBackoff {
	#[cfg(test)]
	const ZERO: Self = Self { base: time::Duration::ZERO, maximum: time::Duration::ZERO };

	fn accepts(self, delay: time::Duration) -> bool {
		self.maximum.is_zero() || delay <= self.maximum
	}
}

impl Default for RetryBackoff {
	fn default() -> Self {
		Self { base: time::Duration::from_millis(500), maximum: time::Duration::from_secs(8) }
	}
}

/// Maximum same-route retries; the overall attempt budget remains
/// authoritative.
#[derive(Clone, Copy, Debug)]
pub struct TransportRetryLayer {
	max_retries: u32,
	backoff:     RetryBackoff,
}
impl TransportRetryLayer {
	/// Creates a same-route retry layer.
	pub const fn new(max_retries: u32) -> Self {
		Self {
			max_retries,
			backoff: RetryBackoff {
				base:    time::Duration::from_millis(500),
				maximum: time::Duration::from_secs(8),
			},
		}
	}

	/// Overrides full-jitter bounds from the typed retry settings snapshot.
	pub const fn with_backoff(mut self, backoff: RetryBackoff) -> Self {
		self.backoff = backoff;
		self
	}
}

/// Service implementing retry inside account/auth and outside
/// rate/encode/transport.
#[derive(Clone, Debug)]
pub struct TransportRetryService<S> {
	inner:       S,
	max_retries: u32,
	backoff:     RetryBackoff,
}
impl<S> Layer<S> for TransportRetryLayer {
	type Service = TransportRetryService<S>;

	fn layer(&self, inner: S) -> Self::Service {
		TransportRetryService { inner, max_retries: self.max_retries, backoff: self.backoff }
	}
}

impl<S, R> Service<LayerCall<R>> for TransportRetryService<S>
where
	S: Service<LayerCall<R>, Error = Error> + Clone,
	R: Clone,
{
	type Error = Error;
	type Response = S::Response;

	type Future = impl Future<Output = Result<S::Response, Error>>;

	fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), Error>> {
		self.inner.poll_ready(cx)
	}

	fn call(&mut self, request: LayerCall<R>) -> Self::Future {
		// Move the exact instance whose readiness was observed into the future; leave a
		// fresh clone for later callers.
		let replacement = self.inner.clone();
		let mut service = mem::replace(&mut self.inner, replacement);
		let max_retries = self.max_retries;
		let backoff = self.backoff;
		async move {
			let mut retry_index = 0;
			loop {
				request.context.checkpoint(ErrorPhase::Readiness)?;
				request.context.reserve_attempt()?;
				request.context.clear_body_evidence();
				let result = service.call(request.clone()).await;
				let mut error = match result {
					Ok(response) => return Ok(response),
					Err(error) => error,
				};
				request.context.merge_receipt(error.receipt());
				if let Some(attempt) = error.receipt().attempts.last() {
					request.context.set_body_evidence(attempt.body);
				}
				let limited_exhausted = match &error.action {
					RetryAction::SameRouteLimited { max_retries: failure_limit, .. } => {
						retry_index >= max_retries.min(*failure_limit)
					},
					_ => false,
				};
				if limited_exhausted {
					error.action = RetryAction::Never;
					request.context.finalize_error(&mut error);
					return Err(error);
				}
				let retry_after = match &error.action {
					RetryAction::SameRoute { after }
						if !error.committed && retry_index < max_retries =>
					{
						*after
					},
					RetryAction::SameRouteLimited { after, max_retries: failure_limit }
						if !error.committed && retry_index < max_retries.min(*failure_limit) =>
					{
						*after
					},
					_ => {
						request.context.finalize_error(&mut error);
						return Err(error);
					},
				};
				if !backoff.accepts(retry_after) {
					error.action = RetryAction::ReselectRoute;
					request.context.finalize_error(&mut error);
					return Err(error);
				}
				let replay_safe = request
					.context
					.body_evidence()
					.is_some_and(|evidence| evidence.retry_decision == RetryDecision::Allow);
				if !replay_safe {
					error.action = RetryAction::Never;
					request.context.finalize_error(&mut error);
					return Err(error);
				}
				request.context.checkpoint(ErrorPhase::Readiness)?;
				let jitter = full_jitter_delay(backoff, retry_index, random_u64());
				let delay = retry_after.max(jitter);
				let retry_attempt = retry_index.saturating_add(1);
				let delay_ms = u64::try_from(delay.as_millis()).unwrap_or(u64::MAX);
				if error.code.as_deref()
					== Some(crate::codec::openai_chat::TEMPLATE_EFFORT_REJECTED_CODE)
				{
					tracing::warn!(
						retry_attempt,
						delay_ms,
						error_kind = ?error.kind,
						option = "reasoning_effort_template_kwargs",
						"provider rejected an option encoding; retrying without unsupported option"
					);
				} else {
					tracing::warn!(
						retry_attempt,
						delay_ms,
						error_kind = ?error.kind,
						error_phase = ?error.phase,
						"provider request failed; retrying same route"
					);
				}
				// `attempt` counts retries (1 = first retry) against the retry cap, never
				// the initial try.
				request.context.notify_retry(RetryNotice {
					attempt: retry_attempt,
					max_attempts: max_retries,
					delay,
					kind: error.kind,
					message: Str::new(error.to_string()),
				});
				if !delay.is_zero() {
					wait_retry_delay(request.context.clone(), delay).await?;
				}
				retry_index += 1;
				future::poll_fn(|cx| service.poll_ready(cx)).await?;
			}
		}
	}
}

/// Calculates `Uniform(0, min(maximum, base * 2^attempt))`; a zero maximum
/// leaves the exponential ceiling uncapped.
///
/// `sample` is injected for deterministic tests; production uses OS entropy.
pub fn full_jitter_delay(policy: RetryBackoff, attempt: u32, sample: u64) -> time::Duration {
	let factor = 1_u32.checked_shl(attempt.min(31)).unwrap_or(u32::MAX);
	let ceiling = policy
		.base
		.checked_mul(factor)
		.unwrap_or(time::Duration::MAX);
	let ceiling = if policy.maximum.is_zero() {
		ceiling
	} else {
		ceiling.min(policy.maximum)
	};
	let nanos = ceiling.as_nanos().min(u128::from(u64::MAX)) as u64;
	if nanos == 0 {
		return time::Duration::ZERO;
	}
	time::Duration::from_nanos(sample % nanos.saturating_add(1))
}

fn random_u64() -> u64 {
	let mut bytes = [0_u8; 8];
	if SystemRandom::new().fill(&mut bytes).is_ok() {
		u64::from_le_bytes(bytes)
	} else {
		u64::MAX / 2
	}
}

async fn wait_retry_delay(context: ExecutionContext, delay: time::Duration) -> Result<(), Error> {
	let remaining = context
		.budget()
		.max_elapsed
		.map(|limit| limit.saturating_sub(context.elapsed()));
	if let Some(remaining) = remaining {
		tokio::select! {
			() = tokio::time::sleep(delay) => context.checkpoint(ErrorPhase::Readiness),
			() = tokio::time::sleep(remaining) => context.checkpoint(ErrorPhase::Readiness),
			() = wait_cancelled(context.clone()) => context.checkpoint(ErrorPhase::Readiness),
		}
	} else {
		tokio::select! {
			() = tokio::time::sleep(delay) => context.checkpoint(ErrorPhase::Readiness),
			() = wait_cancelled(context.clone()) => context.checkpoint(ErrorPhase::Readiness),
		}
	}
}

async fn wait_cancelled(context: ExecutionContext) {
	context.cancelled().await;
}

#[cfg(test)]
mod tests {
	use std::{
		sync::{
			Arc,
			atomic::{AtomicUsize, Ordering},
		},
		task::{Context, Poll},
		time::Duration,
	};

	use futures::future::{Ready, ready};
	use tower::Service;

	use super::{RetryBackoff, RetryNotice, RetrySink, TransportRetryService, full_jitter_delay};
	use crate::{
		body::{AttemptBodyEvidence, Replayability, RetryDecision, RetryDecisionReason},
		error::{Error, ErrorKind, ErrorPhase, RetryAction},
		layer::{ExecutionContext, LayerCall},
		receipt::{
			AttemptOutcome, AttemptReceipt, Cost, ExecutionBudget, ExecutionReceipt, ProviderEvidence,
			Usage,
		},
	};

	#[derive(Clone)]
	struct Failing {
		calls: Arc<AtomicUsize>,
		body:  Option<AttemptBodyEvidence>,
	}
	impl Service<LayerCall<()>> for Failing {
		type Error = Error;
		type Future = Ready<Result<(), Error>>;
		type Response = ();

		fn poll_ready(&mut self, _: &mut Context<'_>) -> Poll<Result<(), Error>> {
			Poll::Ready(Ok(()))
		}

		fn call(&mut self, _: LayerCall<()>) -> Self::Future {
			let index = self.calls.fetch_add(1, Ordering::SeqCst) as u32;
			let mut receipt = ExecutionReceipt::default();
			if let Some(body) = self.body {
				receipt.record_attempt(AttemptReceipt {
					index,
					hidden: false,
					provider: None,
					route: None,
					account: None,
					principal: None,
					body,
					outcome: AttemptOutcome::FailedPreCommit,
					usage: Usage { input_tokens: 1, ..Usage::default() },
					cost: Cost::from_micro_usd(1),
					provider_evidence: ProviderEvidence::default(),
					elapsed: Duration::ZERO,
				});
			}
			ready(Err(Error::new(
				ErrorKind::Connectivity,
				ErrorPhase::Connecting,
				RetryAction::SameRoute { after: Duration::ZERO },
				receipt,
			)))
		}
	}
	#[derive(Clone)]
	struct LimitedFailing {
		calls: Arc<AtomicUsize>,
		body:  AttemptBodyEvidence,
		limit: u32,
	}

	impl Service<LayerCall<()>> for LimitedFailing {
		type Error = Error;
		type Future = Ready<Result<(), Error>>;
		type Response = ();

		fn poll_ready(&mut self, _: &mut Context<'_>) -> Poll<Result<(), Error>> {
			Poll::Ready(Ok(()))
		}

		fn call(&mut self, _: LayerCall<()>) -> Self::Future {
			let index = self.calls.fetch_add(1, Ordering::SeqCst) as u32;
			let mut receipt = ExecutionReceipt::default();
			receipt.record_attempt(AttemptReceipt {
				index,
				hidden: false,
				provider: None,
				route: None,
				account: None,
				principal: None,
				body: self.body,
				outcome: AttemptOutcome::FailedPreCommit,
				usage: Usage::default(),
				cost: Cost::default(),
				provider_evidence: ProviderEvidence::default(),
				elapsed: Duration::ZERO,
			});
			ready(Err(Error::new(
				ErrorKind::Protocol,
				ErrorPhase::Streaming,
				RetryAction::SameRouteLimited { after: Duration::ZERO, max_retries: self.limit },
				receipt,
			)))
		}
	}

	#[test]
	fn full_jitter_is_bounded_and_retry_after_can_be_a_floor() {
		let policy =
			RetryBackoff { base: Duration::from_millis(500), maximum: Duration::from_secs(8) };
		assert_eq!(full_jitter_delay(policy, 0, 0), Duration::ZERO);
		assert!(full_jitter_delay(policy, 4, u64::MAX) <= Duration::from_secs(8));
		let uncapped = RetryBackoff { base: Duration::from_millis(500), maximum: Duration::ZERO };
		assert_eq!(full_jitter_delay(uncapped, 4, 8_000_000_000), Duration::from_secs(8));
		assert!(uncapped.accepts(Duration::from_hours(3)));
		let provider_floor = Duration::from_secs(3);
		assert_eq!(provider_floor.max(full_jitter_delay(policy, 0, 1)), provider_floor);
	}

	fn context() -> ExecutionContext {
		ExecutionContext::new(ExecutionBudget { max_attempts: 3, ..ExecutionBudget::default() })
	}

	#[tokio::test]
	async fn failure_specific_retry_cap_overrides_global_limit() {
		let replayable = AttemptBodyEvidence {
			opened:         true,
			consumed:       true,
			replayability:  Replayability::Replayable,
			retry_decision: RetryDecision::Allow,
			reason:         RetryDecisionReason::ReplayableSource,
		};
		let calls = Arc::new(AtomicUsize::new(0));
		let mut limited = TransportRetryService {
			inner:       LimitedFailing { calls: calls.clone(), body: replayable, limit: 1 },
			max_retries: 10,
			backoff:     RetryBackoff::ZERO,
		};
		futures::future::poll_fn(|cx| limited.poll_ready(cx))
			.await
			.unwrap();
		let error = limited
			.call(LayerCall { payload: (), context: context() })
			.await
			.unwrap_err();
		assert_eq!(error.action, RetryAction::Never);
		assert_eq!(calls.load(Ordering::SeqCst), 2);
	}

	#[tokio::test]
	async fn missing_body_evidence_suppresses_retry() {
		let calls = Arc::new(AtomicUsize::new(0));
		let mut service = TransportRetryService {
			inner:       Failing { calls: calls.clone(), body: None },
			max_retries: 2,
			backoff:     RetryBackoff::ZERO,
		};
		futures::future::poll_fn(|cx| service.poll_ready(cx))
			.await
			.unwrap();
		let error = service
			.call(LayerCall { payload: (), context: context() })
			.await
			.unwrap_err();
		assert_eq!(error.action, RetryAction::Never);
		assert_eq!(calls.load(Ordering::SeqCst), 1);
	}

	#[tokio::test]
	async fn consumed_one_shot_evidence_suppresses_retry() {
		let calls = Arc::new(AtomicUsize::new(0));
		let body = AttemptBodyEvidence {
			opened:         true,
			consumed:       true,
			replayability:  Replayability::OneShot,
			retry_decision: RetryDecision::Suppress,
			reason:         RetryDecisionReason::ConsumedOneShot,
		};
		let mut service = TransportRetryService {
			inner:       Failing { calls: calls.clone(), body: Some(body) },
			max_retries: 2,
			backoff:     RetryBackoff::ZERO,
		};
		futures::future::poll_fn(|cx| service.poll_ready(cx))
			.await
			.unwrap();
		let error = service
			.call(LayerCall { payload: (), context: context() })
			.await
			.unwrap_err();
		assert_eq!(error.action, RetryAction::Never);
		assert_eq!(calls.load(Ordering::SeqCst), 1);
	}

	#[derive(Clone)]
	struct FailThenSuccess {
		calls: Arc<AtomicUsize>,
		body:  AttemptBodyEvidence,
	}
	impl Service<LayerCall<()>> for FailThenSuccess {
		type Error = Error;
		type Future = Ready<Result<(), Error>>;
		type Response = ();

		fn poll_ready(&mut self, _: &mut Context<'_>) -> Poll<Result<(), Error>> {
			Poll::Ready(Ok(()))
		}

		fn call(&mut self, _: LayerCall<()>) -> Self::Future {
			if self.calls.fetch_add(1, Ordering::SeqCst) > 0 {
				return ready(Ok(()));
			}
			let mut receipt = ExecutionReceipt::default();
			receipt.record_attempt(AttemptReceipt {
				index:             0,
				hidden:            false,
				provider:          None,
				route:             None,
				account:           None,
				principal:         None,
				body:              self.body,
				outcome:           AttemptOutcome::FailedPreCommit,
				usage:             Usage { input_tokens: 1, ..Usage::default() },
				cost:              Cost::from_micro_usd(1),
				provider_evidence: ProviderEvidence::default(),
				elapsed:           Duration::ZERO,
			});
			ready(Err(Error::new(
				ErrorKind::Connectivity,
				ErrorPhase::Connecting,
				RetryAction::SameRoute { after: Duration::ZERO },
				receipt,
			)))
		}
	}

	fn replayable() -> AttemptBodyEvidence {
		AttemptBodyEvidence {
			opened:         true,
			consumed:       true,
			replayability:  Replayability::Replayable,
			retry_decision: RetryDecision::Allow,
			reason:         RetryDecisionReason::ReplayableSource,
		}
	}

	#[derive(Clone)]
	struct OverflowFailing {
		calls: Arc<AtomicUsize>,
	}
	impl Service<LayerCall<()>> for OverflowFailing {
		type Error = Error;
		type Future = Ready<Result<(), Error>>;
		type Response = ();

		fn poll_ready(&mut self, _: &mut Context<'_>) -> Poll<Result<(), Error>> {
			Poll::Ready(Ok(()))
		}

		fn call(&mut self, _: LayerCall<()>) -> Self::Future {
			let index = self.calls.fetch_add(1, Ordering::SeqCst) as u32;
			let mut receipt = ExecutionReceipt::default();
			receipt.record_attempt(AttemptReceipt {
				index,
				hidden: false,
				provider: None,
				route: None,
				account: None,
				principal: None,
				body: replayable(),
				outcome: AttemptOutcome::FailedPreCommit,
				usage: Usage { input_tokens: 1, ..Usage::default() },
				cost: Cost::from_micro_usd(1),
				provider_evidence: ProviderEvidence::default(),
				elapsed: Duration::ZERO,
			});
			ready(Err(Error::new(
				ErrorKind::ContextOverflow,
				ErrorPhase::Handshake,
				RetryAction::Never,
				receipt,
			)))
		}
	}

	#[tokio::test]
	async fn deterministic_context_overflow_fails_fast_despite_replayable_body() {
		// A retried transport call replays a fixed request, so an input the model
		// cannot fit fails identically on every attempt. Replay-safe body evidence
		// must not override the classifier's `Never`: retrying burns the caller's
		// budget instead of reaching the layer that can actually shrink the input.
		let calls = Arc::new(AtomicUsize::new(0));
		let mut service = TransportRetryService {
			inner:       OverflowFailing { calls: calls.clone() },
			max_retries: 2,
			backoff:     RetryBackoff::ZERO,
		};
		futures::future::poll_fn(|cx| service.poll_ready(cx))
			.await
			.unwrap();
		let error = service
			.call(LayerCall { payload: (), context: context() })
			.await
			.unwrap_err();
		assert_eq!(error.kind, ErrorKind::ContextOverflow);
		assert_eq!(error.action, RetryAction::Never);
		assert_eq!(calls.load(Ordering::SeqCst), 1);
	}

	#[tokio::test]
	async fn fail_then_success_retains_prior_attempt_once() {
		let calls = Arc::new(AtomicUsize::new(0));
		let context = context();
		let mut service = TransportRetryService {
			inner:       FailThenSuccess { calls, body: replayable() },
			max_retries: 1,
			backoff:     RetryBackoff::ZERO,
		};
		futures::future::poll_fn(|cx| service.poll_ready(cx))
			.await
			.unwrap();
		service
			.call(LayerCall { payload: (), context: context.clone() })
			.await
			.unwrap();
		assert_eq!(context.receipt().attempts.len(), 1);
		assert_eq!(context.receipt().usage.input_tokens, 1);
		assert_eq!(context.receipt().cost.micro_usd, 1);
	}

	#[tokio::test]
	async fn retry_notice_reaches_the_installed_sink_before_the_wait() {
		let calls = Arc::new(AtomicUsize::new(0));
		let notices = Arc::new(parking_lot::Mutex::new(Vec::new()));
		let context = context();
		let sink: RetrySink = {
			let notices = notices.clone();
			Arc::new(move |notice: RetryNotice| notices.lock().push(notice))
		};
		context.set_retry_sink(Some(sink));
		let mut service = TransportRetryService {
			inner:       FailThenSuccess { calls, body: replayable() },
			max_retries: 3,
			backoff:     RetryBackoff::ZERO,
		};
		futures::future::poll_fn(|cx| service.poll_ready(cx))
			.await
			.unwrap();
		service
			.call(LayerCall { payload: (), context: context.clone() })
			.await
			.unwrap();
		let notices = notices.lock();
		assert_eq!(notices.len(), 1, "one retry, one notice");
		assert_eq!(notices[0].attempt, 1);
		assert_eq!(notices[0].max_attempts, 3);
		assert_eq!(notices[0].kind, ErrorKind::Connectivity);
		assert_eq!(notices[0].delay, Duration::ZERO);
	}

	#[tokio::test]
	async fn silent_context_retries_without_a_sink() {
		let calls = Arc::new(AtomicUsize::new(0));
		let mut service = TransportRetryService {
			inner:       FailThenSuccess { calls: calls.clone(), body: replayable() },
			max_retries: 1,
			backoff:     RetryBackoff::ZERO,
		};
		futures::future::poll_fn(|cx| service.poll_ready(cx))
			.await
			.unwrap();
		service
			.call(LayerCall { payload: (), context: context() })
			.await
			.unwrap();
		assert_eq!(calls.load(Ordering::SeqCst), 2);
	}

	#[tokio::test]
	async fn fail_then_fail_returns_ordered_deduplicated_receipt() {
		let calls = Arc::new(AtomicUsize::new(0));
		let mut service = TransportRetryService {
			inner:       Failing { calls, body: Some(replayable()) },
			max_retries: 1,
			backoff:     RetryBackoff::ZERO,
		};
		futures::future::poll_fn(|cx| service.poll_ready(cx))
			.await
			.unwrap();
		let error = service
			.call(LayerCall { payload: (), context: context() })
			.await
			.unwrap_err();
		assert_eq!(
			error
				.receipt()
				.attempts
				.iter()
				.map(|attempt| attempt.index)
				.collect::<Vec<_>>(),
			vec![0, 1]
		);
		assert_eq!(error.receipt().usage.input_tokens, 2);
		assert_eq!(error.receipt().cost.micro_usd, 2);
	}

	#[derive(Clone)]
	struct CommittedFailing {
		calls: Arc<AtomicUsize>,
	}
	impl Service<LayerCall<()>> for CommittedFailing {
		type Error = Error;
		type Future = Ready<Result<(), Error>>;
		type Response = ();

		fn poll_ready(&mut self, _: &mut Context<'_>) -> Poll<Result<(), Error>> {
			Poll::Ready(Ok(()))
		}

		fn call(&mut self, _: LayerCall<()>) -> Self::Future {
			self.calls.fetch_add(1, Ordering::SeqCst);
			let mut receipt = ExecutionReceipt::default();
			receipt.record_attempt(AttemptReceipt {
				index:             0,
				hidden:            false,
				provider:          None,
				route:             None,
				account:           None,
				principal:         None,
				body:              replayable(),
				outcome:           AttemptOutcome::FailedCommitted,
				usage:             Usage::default(),
				cost:              Cost::default(),
				provider_evidence: ProviderEvidence::default(),
				elapsed:           Duration::ZERO,
			});
			ready(Err(
				Error::new(
					ErrorKind::ResourceExhausted,
					ErrorPhase::Streaming,
					RetryAction::SameRoute { after: Duration::ZERO },
					receipt,
				)
				.committed(true),
			))
		}
	}

	#[tokio::test]
	async fn committed_transient_failure_is_never_replayed() {
		// A transient classification (overload, throttle) is only replay-safe
		// before output becomes visible; once committed, the same-route retry
		// lane must surface the failure instead of duplicating streamed output.
		let calls = Arc::new(AtomicUsize::new(0));
		let mut service = TransportRetryService {
			inner:       CommittedFailing { calls: calls.clone() },
			max_retries: 2,
			backoff:     RetryBackoff::ZERO,
		};
		futures::future::poll_fn(|cx| service.poll_ready(cx))
			.await
			.unwrap();
		let error = service
			.call(LayerCall { payload: (), context: context() })
			.await
			.unwrap_err();
		assert_eq!(error.kind, ErrorKind::ResourceExhausted);
		assert!(error.committed);
		assert_eq!(calls.load(Ordering::SeqCst), 1);
	}
}
