//! Opaque credential lease acquisition and refresh boundary.

use std::{
	mem,
	task::{Context, Poll},
};

use tower::{Layer, Service};

use crate::{
	error::{Error, ErrorPhase},
	layer::{ExecutionContext, LayerCall, account::Accounted},
};

/// Authenticated request carrying an opaque lease type that outer layers cannot
/// inspect.
#[derive(Clone)]
pub struct Authorized<R, A, L> {
	/// Original planned request.
	pub request:      R,
	/// Non-secret selected account handle.
	pub account:      A,
	/// Opaque secret-bearing credential lease.
	pub(crate) lease: L,
}

/// Acquires an opaque credential lease for the selected account and auth
/// specification.
pub trait LeaseProvider<R, A>: Clone + Send + 'static {
	/// Secret-bearing lease; implementations must redact `Debug` and prohibit
	/// serialization.
	type Lease: Clone + Send + 'static;
	/// Concrete acquisition future.
	type Future<'a>: Future<Output = Result<Self::Lease, Error>> + Send + 'a
	where
		Self: 'a,
		R: 'a,
		A: 'a;
	/// Acquires or refreshes a lease without exposing secret bytes.
	fn acquire<'a>(
		&'a self,
		request: &'a R,
		account: &'a A,
		context: &'a ExecutionContext,
	) -> Self::Future<'a>;
}
/// Adds credential lease acquisition.
#[derive(Clone, Debug)]
pub struct AuthLeaseLayer<P> {
	provider: P,
}
impl<P> AuthLeaseLayer<P> {
	/// Creates an auth lease layer.
	pub const fn new(provider: P) -> Self {
		Self { provider }
	}
}
/// Credential-leasing service.
#[derive(Clone, Debug)]
pub struct AuthLeaseService<S, P> {
	inner:    S,
	provider: P,
}
impl<S, P: Clone> Layer<S> for AuthLeaseLayer<P> {
	type Service = AuthLeaseService<S, P>;

	fn layer(&self, inner: S) -> Self::Service {
		AuthLeaseService { inner, provider: self.provider.clone() }
	}
}
impl<S, P, R, A> Service<LayerCall<Accounted<R, A>>> for AuthLeaseService<S, P>
where
	P: LeaseProvider<R, A>,
	S: Service<LayerCall<Authorized<R, A, P::Lease>>, Error = Error> + Clone,
	R: Send + 'static,
	A: Send + 'static,
{
	type Error = Error;
	type Response = S::Response;

	type Future = impl Future<Output = Result<S::Response, Error>>;

	fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), Error>> {
		self.inner.poll_ready(cx)
	}

	fn call(&mut self, request: LayerCall<Accounted<R, A>>) -> Self::Future {
		let replacement = self.inner.clone();
		let mut ready_inner = mem::replace(&mut self.inner, replacement);
		let provider = self.provider.clone();
		async move {
			request.context.checkpoint(ErrorPhase::Authentication)?;
			let Accounted { request: planned, account } = request.payload;
			let lease = provider
				.acquire(&planned, &account, &request.context)
				.await?;
			request.context.checkpoint(ErrorPhase::Authentication)?;
			ready_inner
				.call(LayerCall {
					payload: Authorized { request: planned, account, lease },
					context: request.context,
				})
				.await
		}
	}
}
