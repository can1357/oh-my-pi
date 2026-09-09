//! Capability negotiation and canonical-intent lowering before credentials or
//! I/O.

use std::task::{Context, Poll};

use tower::{Layer, Service};

use crate::{call::Call, error::Error, layer::LayerCall, receipt::ExecutionReceipt};

/// Side-effect-free canonical intent planner.
pub trait IntentPlanner: Clone + Send + 'static {
	/// Negotiates explicit settings and records every adjustment in the initial
	/// receipt.
	fn negotiate(&self, call: &mut Call, receipt: &mut ExecutionReceipt) -> Result<(), Error>;
}

/// Adds capability negotiation to a routed call.
#[derive(Clone, Debug)]
pub struct IntentLayer<P> {
	planner: P,
}
impl<P> IntentLayer<P> {
	/// Creates an intent layer.
	pub const fn new(planner: P) -> Self {
		Self { planner }
	}
}

/// Intent-negotiating service.
#[derive(Clone, Debug)]
pub struct IntentService<S, P> {
	inner:   S,
	planner: P,
}
impl<S, P: Clone> Layer<S> for IntentLayer<P> {
	type Service = IntentService<S, P>;

	fn layer(&self, inner: S) -> Self::Service {
		IntentService { inner, planner: self.planner.clone() }
	}
}
impl<S, P> Service<LayerCall<Call>> for IntentService<S, P>
where
	S: Service<LayerCall<Call>, Error = Error>,
	P: IntentPlanner,
{
	type Error = Error;
	type Response = S::Response;

	type Future = impl Future<Output = Result<Self::Response, Error>>;

	fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), Error>> {
		self.inner.poll_ready(cx)
	}

	fn call(&mut self, mut request: LayerCall<Call>) -> Self::Future {
		let planned = request
			.context
			.with_receipt(|receipt| self.planner.negotiate(&mut request.payload, receipt));
		let future = planned.as_ref().ok().map(|()| self.inner.call(request));
		async move {
			planned?;
			future
				.expect("future exists after successful intent negotiation")
				.await
		}
	}
}
