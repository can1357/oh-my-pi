//! Cold-path inference hook handle contract.

use std::{
	future::{self, Future},
	task,
	time::Duration,
};

use crate::{
	Call,
	codec::TransportRequest,
	error::{Error, RetryAction},
	layer::{ExecutionContext, LayerCall},
};

/// Injected cold-path hook dispatcher for one inference service stack.
///
/// Implementations bridge to the extension supervisor; the request spine only
/// retains this concrete handle and never erases its futures behind `dyn`.
pub trait HookHandle: Clone + Send + Sync + 'static {
	/// Invokes `before_request` before canonical request encoding.
	fn before_request(
		&self,
		context: &ExecutionContext,
	) -> impl Future<Output = Result<(), Error>> + Send;

	/// Lets `provider_error` replace the retry action before route fallback is
	/// considered. `None` preserves the classified provider action.
	fn provider_error(
		&self,
		error: &Error,
		context: &ExecutionContext,
	) -> impl Future<Output = Option<RetryAction>> + Send;

	/// Invokes `provider_sign` after credential application and before wire
	/// transport. The hook receives only the encoded request surface.
	fn provider_sign(
		&self,
		request: &TransportRequest,
		context: &ExecutionContext,
	) -> impl Future<Output = Result<(), Error>> + Send;

	/// Hard per-attempt upper bound for provider signing.
	fn sign_budget(&self) -> Duration;
}

/// Intercepts classified provider failures before registry fallback safety is
/// evaluated.
#[derive(Clone, Debug)]
pub struct ProviderErrorLayer<H = NoHookHandle> {
	hook: Option<H>,
}

impl ProviderErrorLayer<NoHookHandle> {
	/// Creates a layer with no provider-error subscription.
	pub const fn new() -> Self {
		Self { hook: None }
	}
}

impl ProviderErrorLayer<NoHookHandle> {
	/// Attaches a concrete dispatcher to this route stack.
	pub const fn with_hook<T: HookHandle>(self, hook: T) -> ProviderErrorLayer<T> {
		ProviderErrorLayer { hook: Some(hook) }
	}
}

impl Default for ProviderErrorLayer<NoHookHandle> {
	fn default() -> Self {
		Self::new()
	}
}

/// Service applying a provider-error hook while retaining its inner future
/// type.
#[derive(Clone, Debug)]
pub struct ProviderErrorService<S, H = NoHookHandle> {
	inner: S,
	hook:  Option<H>,
}

impl<S, H> tower::Layer<S> for ProviderErrorLayer<H>
where
	H: HookHandle,
{
	type Service = ProviderErrorService<S, H>;

	fn layer(&self, inner: S) -> Self::Service {
		ProviderErrorService { inner, hook: self.hook.clone() }
	}
}

impl<S, H> tower::Service<LayerCall<Call>> for ProviderErrorService<S, H>
where
	H: HookHandle,
	S: tower::Service<LayerCall<Call>, Error = Error> + Send,
	S::Future: Send,
	S::Response: Send,
{
	type Error = Error;
	type Response = S::Response;

	type Future = impl Future<Output = Result<Self::Response, Error>> + Send;

	fn poll_ready(&mut self, context: &mut task::Context<'_>) -> task::Poll<Result<(), Error>> {
		self.inner.poll_ready(context)
	}

	fn call(&mut self, request: LayerCall<Call>) -> Self::Future {
		let context = request.context.clone();
		let hook = self.hook.clone();
		let future = self.inner.call(request);
		async move {
			match future.await {
				Ok(response) => Ok(response),
				Err(mut error) => {
					if let Some(hook) = hook
						&& let Some(action) = hook.provider_error(&error, &context).await
					{
						error.action = action;
					}
					Err(error)
				},
			}
		}
	}
}

/// Zero-cost default for stacks with no cold-path hook subscriptions.
#[derive(Clone, Copy, Debug, Default)]
pub struct NoHookHandle;

impl HookHandle for NoHookHandle {
	fn before_request(
		&self,
		_: &ExecutionContext,
	) -> impl Future<Output = Result<(), Error>> + Send {
		future::ready(Ok(()))
	}

	fn provider_error(
		&self,
		_: &Error,
		_: &ExecutionContext,
	) -> impl Future<Output = Option<RetryAction>> + Send {
		future::ready(None)
	}

	fn provider_sign(
		&self,
		_: &TransportRequest,
		_: &ExecutionContext,
	) -> impl Future<Output = Result<(), Error>> + Send {
		future::ready(Ok(()))
	}

	fn sign_budget(&self) -> Duration {
		Duration::ZERO
	}
}
