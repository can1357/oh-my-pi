//! Per-network-attempt rate reservation, deliberately inside transport retry.

use std::{
	mem,
	task::{Context, Poll},
};

use tower::{Layer, Service};

use crate::{
	error::{Error, ErrorPhase},
	layer::{ExecutionContext, LayerCall},
};

/// Reserves one provider/account rate slot for an actual transport attempt.
pub trait RateLimiter<R>: Clone + Send + 'static {
	/// Concrete unboxed reservation future.
	type Future<'a>: Future<Output = Result<(), Error>> + Send + 'a
	where
		Self: 'a,
		R: 'a;
	/// Waits for capacity; implementations must be cancellation-aware through
	/// the execution context.
	fn reserve<'a>(&'a self, request: &'a R, context: &'a ExecutionContext) -> Self::Future<'a>;
}

/// Adds rate reservation.
#[derive(Clone, Debug)]
pub struct RateLayer<L> {
	limiter: L,
}
impl<L> RateLayer<L> {
	/// Creates a rate layer.
	pub const fn new(limiter: L) -> Self {
		Self { limiter }
	}
}

/// Rate-limited service.
#[derive(Clone, Debug)]
pub struct RateService<S, L> {
	inner:   S,
	limiter: L,
}
impl<S, L: Clone> Layer<S> for RateLayer<L> {
	type Service = RateService<S, L>;

	fn layer(&self, inner: S) -> Self::Service {
		RateService { inner, limiter: self.limiter.clone() }
	}
}
impl<S, L, R> Service<LayerCall<R>> for RateService<S, L>
where
	S: Service<LayerCall<R>, Error = Error> + Clone,
	L: RateLimiter<R>,
{
	type Error = Error;
	type Response = S::Response;

	type Future = impl Future<Output = Result<S::Response, Error>>;

	fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), Error>> {
		self.inner.poll_ready(cx)
	}

	fn call(&mut self, request: LayerCall<R>) -> Self::Future {
		let replacement = self.inner.clone();
		let mut ready_inner = mem::replace(&mut self.inner, replacement);
		let limiter = self.limiter.clone();
		async move {
			request.context.checkpoint(ErrorPhase::Readiness)?;
			limiter.reserve(&request.payload, &request.context).await?;
			request.context.checkpoint(ErrorPhase::Readiness)?;
			ready_inner.call(request).await
		}
	}
}
