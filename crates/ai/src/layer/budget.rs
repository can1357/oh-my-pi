//! Logical-execution budgets shared by all retries and semantic attempts.

use std::{
	collections::HashMap,
	sync::Arc,
	task::{Context, Poll},
	time::{Duration, Instant},
};

use omp_core::{Str, sf};
use parking_lot::Mutex;
use tower::{Layer, Service};

use crate::{
	call::Call,
	error::{Error, ErrorDetail, ErrorKind, ErrorPhase, RetryAction},
	layer::{ExecutionContext, LayerCall},
	receipt::Cost,
};

/// Hard inference ceilings applied independently to one extension's turn and
/// session ledgers.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct InferenceBudget {
	/// Maximum admitted requests.
	pub max_requests:      Option<u64>,
	/// Maximum aggregate input tokens.
	pub max_input_tokens:  Option<u64>,
	/// Maximum aggregate output and reasoning tokens.
	pub max_output_tokens: Option<u64>,
	/// Maximum aggregate wall-clock time.
	pub max_wall_time:     Option<Duration>,
	/// Maximum aggregate cost in micro-US dollars.
	pub max_usd:           Option<Cost>,
}

/// Per-extension inference ceilings at each mandatory accounting scope.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct InferenceBudgetPolicy {
	/// Ceiling reset for each idempotent turn.
	pub per_turn:    InferenceBudget,
	/// Ceiling retained for the containing conversation session.
	pub per_session: InferenceBudget,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct LedgerKey {
	extension: Str,
	scope:     Str,
}

#[derive(Clone, Copy, Debug, Default)]
struct InferenceSpend {
	requests:      u64,
	input_tokens:  u64,
	output_tokens: u64,
	wall_time:     Duration,
	micro_usd:     i128,
}

#[derive(Default)]
struct LedgerState {
	turn:    HashMap<LedgerKey, InferenceSpend>,
	session: HashMap<LedgerKey, InferenceSpend>,
}

/// Shared, stack-owned inference accounting keyed by extension and turn or
/// extension and session.
#[derive(Clone, Default)]
pub struct InferenceLedger {
	policies: Arc<Mutex<HashMap<Str, InferenceBudgetPolicy>>>,
	default:  Arc<Mutex<InferenceBudgetPolicy>>,
	state:    Arc<Mutex<LedgerState>>,
}

impl InferenceLedger {
	/// Replaces the fallback policy used when an extension has no explicit
	/// inference envelope.
	pub fn set_default_policy(&self, policy: InferenceBudgetPolicy) {
		*self.default.lock() = policy;
	}

	/// Replaces one extension's turn and session policy atomically.
	pub fn set_policy(&self, extension: Str, policy: InferenceBudgetPolicy) {
		self.policies.lock().insert(extension, policy);
	}

	/// Admits one request before any provider-facing service can run.
	pub fn admit(&self, call: &Call, context: &ExecutionContext) -> Result<(), Error> {
		let policy = self
			.policies
			.lock()
			.get(&call.attribution.extension)
			.cloned()
			.unwrap_or_else(|| self.default.lock().clone());
		let turn = LedgerKey {
			extension: call.attribution.extension.clone(),
			scope:     call.session.as_ref().map_or_else(
				|| call.id.clone().into_inner(),
				|session| session.turn.clone().into_inner(),
			),
		};
		let session = LedgerKey {
			extension: call.attribution.extension.clone(),
			scope:     call.session.as_ref().map_or_else(
				|| call.id.clone().into_inner(),
				|request| request.conversation.clone().into_inner(),
			),
		};
		let mut state = self.state.lock();
		check_budget(state.turn.entry(turn.clone()).or_default(), &policy.per_turn, context)?;
		check_budget(
			state.session.entry(session.clone()).or_default(),
			&policy.per_session,
			context,
		)?;
		let turn_spend = state.turn.get_mut(&turn).expect("entry inserted");
		turn_spend.requests = turn_spend.requests.saturating_add(1);
		let session_spend = state.session.get_mut(&session).expect("entry inserted");
		session_spend.requests = session_spend.requests.saturating_add(1);
		Ok(())
	}

	/// Bills completed or failed provider work after it has been measured by
	/// the execution context.
	pub fn charge(&self, call: &Call, context: &ExecutionContext) {
		let receipt = context.receipt();
		let charge = InferenceSpend {
			input_tokens: receipt.usage.input_tokens,
			// `output_tokens` already includes the reasoning subset; adding
			// `reasoning_tokens` again would bill thinking twice.
			output_tokens: receipt.usage.output_tokens,
			wall_time: context.elapsed(),
			micro_usd: receipt.cost.micro_usd,
			..InferenceSpend::default()
		};
		let extension = call.attribution.extension.clone();
		let turn_scope = call
			.session
			.as_ref()
			.map_or_else(|| call.id.clone().into_inner(), |session| session.turn.clone().into_inner());
		let session_scope = call.session.as_ref().map_or_else(
			|| call.id.clone().into_inner(),
			|request| request.conversation.clone().into_inner(),
		);
		let mut state = self.state.lock();
		accumulate(
			state
				.turn
				.entry(LedgerKey { extension: extension.clone(), scope: turn_scope })
				.or_default(),
			charge,
		);
		accumulate(
			state
				.session
				.entry(LedgerKey { extension, scope: session_scope })
				.or_default(),
			charge,
		);
	}
}

fn check_budget(
	spend: &InferenceSpend,
	budget: &InferenceBudget,
	context: &ExecutionContext,
) -> Result<(), Error> {
	if let Some(limit) = budget.max_requests
		&& spend.requests >= limit
	{
		return Err(budget_error(
			context,
			"requests",
			limit.into(),
			spend.requests.saturating_add(1).into(),
		));
	}
	if let Some(limit) = budget.max_input_tokens
		&& spend.input_tokens >= limit
	{
		return Err(budget_error(context, "input_tokens", limit.into(), spend.input_tokens.into()));
	}
	if let Some(limit) = budget.max_output_tokens
		&& spend.output_tokens >= limit
	{
		return Err(budget_error(context, "output_tokens", limit.into(), spend.output_tokens.into()));
	}
	if let Some(limit) = budget.max_wall_time
		&& spend.wall_time >= limit
	{
		return Err(budget_error(
			context,
			"wall_time_nanoseconds",
			limit.as_nanos(),
			spend.wall_time.as_nanos(),
		));
	}
	if let Some(limit) = budget.max_usd
		&& spend.micro_usd >= limit.micro_usd
	{
		return Err(budget_error(
			context,
			"micro_usd",
			limit.micro_usd.max(0) as u128,
			spend.micro_usd.max(0) as u128,
		));
	}
	Ok(())
}

fn budget_error(
	context: &ExecutionContext,
	dimension: &'static str,
	limit: u128,
	observed: u128,
) -> Error {
	Error::new(
		ErrorKind::BudgetExhausted,
		ErrorPhase::Readiness,
		RetryAction::Never,
		context.receipt(),
	)
	.code(sf!("inference.budget_exhausted"))
	.detail(ErrorDetail::budget(sf!(dimension), limit, observed))
}

const fn accumulate(target: &mut InferenceSpend, charge: InferenceSpend) {
	target.input_tokens = target.input_tokens.saturating_add(charge.input_tokens);
	target.output_tokens = target.output_tokens.saturating_add(charge.output_tokens);
	target.wall_time = target.wall_time.saturating_add(charge.wall_time);
	target.micro_usd = target.micro_usd.saturating_add(charge.micro_usd);
}

/// Constructs the outer budget boundary.
#[derive(Clone, Default)]
pub struct OverallBudgetLayer {
	ledger: InferenceLedger,
}

impl OverallBudgetLayer {
	/// Creates the outer execution boundary with one shared inference ledger.
	pub const fn new(ledger: InferenceLedger) -> Self {
		Self { ledger }
	}
}

/// Adds one execution context and enforces its deadline across the inner stack.
#[derive(Clone)]
pub struct OverallBudgetService<S> {
	inner:  S,
	ledger: InferenceLedger,
}

impl<S> Layer<S> for OverallBudgetLayer {
	type Service = OverallBudgetService<S>;

	fn layer(&self, inner: S) -> Self::Service {
		OverallBudgetService { inner, ledger: self.ledger.clone() }
	}
}

impl<S> Service<Call> for OverallBudgetService<S>
where
	S: Service<LayerCall<Call>, Error = Error>,
{
	type Error = Error;
	type Response = S::Response;

	type Future = impl Future<Output = Result<Self::Response, Self::Error>>;

	fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
		self.inner.poll_ready(cx)
	}

	fn call(&mut self, mut call: Call) -> Self::Future {
		if let Some(deadline) = call.deadline {
			let remaining = deadline.saturating_duration_since(Instant::now());
			call.budget.max_elapsed = Some(
				call
					.budget
					.max_elapsed
					.map_or(remaining, |configured| configured.min(remaining)),
			);
		}
		let context = ExecutionContext::new(call.budget.clone());
		context.set_retry_sink(call.response_hooks.retry_sink());
		let result = context
			.checkpoint(ErrorPhase::Readiness)
			.and_then(|()| self.ledger.admit(&call, &context));
		let accounting_call = call.clone();
		let ledger = self.ledger.clone();
		let future = if result.is_ok() {
			Some(
				self
					.inner
					.call(LayerCall { payload: call, context: context.clone() }),
			)
		} else {
			None
		};
		async move {
			result?;
			let response = future
				.expect("future exists after successful budget admission")
				.await;
			ledger.charge(&accounting_call, &context);
			let response = response?;
			context.checkpoint(ErrorPhase::Streaming)?;
			Ok(response)
		}
	}
}

#[cfg(test)]
mod tests {
	use std::sync::{
		Arc,
		atomic::{AtomicUsize, Ordering},
	};

	use tower::{Layer, Service, service_fn};

	use super::{InferenceBudget, InferenceBudgetPolicy, InferenceLedger, OverallBudgetLayer};
	use crate::{
		Error, ErrorKind,
		call::{
			Call, CallMeta, CountAccuracy, CountTokensRequest, InferenceAttribution, OperationCall,
			Target,
		},
		id::{PrincipalId, RequestId},
		layer::LayerCall,
		receipt::{ExecutionBudget, Usage},
	};

	fn call() -> Call {
		Call::new(
			CallMeta {
				id:             RequestId::from("request"),
				target:         Target::Route {
					route: omp_catalog::RouteId::from("route"),
					model: omp_catalog::ModelKey::from("model"),
				},
				deadline:       None,
				budget:         ExecutionBudget::default(),
				session:        None,
				debug_session:  None,
				response_hooks: Default::default(),
			},
			OperationCall::CountTokens(Arc::new(CountTokensRequest {
				messages: Arc::new([]),
				tools:    Arc::new([]),
				accuracy: CountAccuracy::Exact,
			})),
		)
		.with_attribution(InferenceAttribution {
			principal: PrincipalId::from("schedule-owner"),
			extension: omp_core::sf!("extension"),
		})
	}

	#[tokio::test]
	async fn request_budget_exhaustion_rejects_before_dispatch() {
		let ledger = InferenceLedger::default();
		ledger.set_policy(omp_core::sf!("extension"), InferenceBudgetPolicy {
			per_turn:    InferenceBudget { max_requests: Some(1), ..InferenceBudget::default() },
			per_session: InferenceBudget::default(),
		});
		let calls = Arc::new(AtomicUsize::new(0));
		let inner_calls = Arc::clone(&calls);
		let inner = service_fn(move |_| {
			inner_calls.fetch_add(1, Ordering::Relaxed);
			async { Ok::<_, Error>(()) }
		});
		let mut service = OverallBudgetLayer::new(ledger).layer(inner);
		service.call(call()).await.unwrap();
		let error = service
			.call(call())
			.await
			.expect_err("second request must be rejected before provider dispatch");
		assert_eq!(calls.load(Ordering::Relaxed), 1);
		assert_eq!(error.kind, ErrorKind::BudgetExhausted);
		assert_eq!(error.code.as_ref().map(|code| code.as_str()), Some("inference.budget_exhausted"));
	}

	#[tokio::test]
	async fn reasoning_tokens_are_not_billed_twice_against_output_budget() {
		// `Usage::output_tokens` already contains the reasoning subset; the
		// ledger must charge it once. 1000 output (800 of them reasoning)
		// against a 1500 cap must leave headroom for a second request.
		let ledger = InferenceLedger::default();
		ledger.set_policy(omp_core::sf!("extension"), InferenceBudgetPolicy {
			per_turn:    InferenceBudget {
				max_output_tokens: Some(1500),
				..InferenceBudget::default()
			},
			per_session: InferenceBudget::default(),
		});
		let inner = service_fn(move |call: LayerCall<Call>| {
			call.context.with_receipt(|receipt| {
				receipt.usage =
					Usage { output_tokens: 1000, reasoning_tokens: 800, ..Usage::default() };
			});
			async { Ok::<_, Error>(()) }
		});
		let mut service = OverallBudgetLayer::new(ledger.clone()).layer(inner);
		service.call(call()).await.unwrap();
		service
			.call(call())
			.await
			.expect("1000 billed output tokens must not exhaust a 1500 token budget");
		let error = service
			.call(call())
			.await
			.expect_err("2000 billed output tokens must exhaust a 1500 token budget");
		assert_eq!(error.kind, ErrorKind::BudgetExhausted);
	}
}
