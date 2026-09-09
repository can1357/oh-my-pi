//! Secret-free execution observations and receipt completion timing.

use std::{
	task::{Context, Poll},
	time::{Duration, Instant},
};

use tower::{Layer, Service};

use crate::{
	call::Call,
	error::{Error, ErrorKind},
	id::RequestId,
};

/// Sanitized execution-start observation; it intentionally excludes payloads
/// and credentials.
#[derive(Clone, Debug)]
pub struct ExecutionStarted {
	/// Logical request identity.
	pub request_id: RequestId,
	/// Canonical operation kind.
	pub operation:  omp_catalog::OperationKind,
}

/// Sanitized execution-finish observation.
#[derive(Clone, Debug)]
pub struct ExecutionFinished {
	/// Logical request identity.
	pub request_id: RequestId,
	/// Total observed service-call time.
	pub elapsed:    Duration,
	/// Structured failure category, if execution failed.
	pub error:      Option<ErrorKind>,
	/// Whether ordinary output committed before failure.
	pub committed:  bool,
}

/// Receives bounded observations without access to calls, headers, bodies, or
/// leases.
pub trait Observer: Clone + Send + Sync + 'static {
	/// Records execution start.
	fn started(&self, event: ExecutionStarted);
	/// Records execution completion.
	fn finished(&self, event: ExecutionFinished);
}

/// Zero-cost observer used when callers explicitly request no execution
/// telemetry.
#[derive(Clone, Copy, Debug, Default)]
pub struct NoopObserver;
impl Observer for NoopObserver {
	fn started(&self, _: ExecutionStarted) {}

	fn finished(&self, _: ExecutionFinished) {}
}

/// Adds secret-free execution observations.
#[derive(Clone, Debug)]
pub struct ObserveLayer<O> {
	observer: O,
}

impl<O> ObserveLayer<O> {
	/// Creates an observation layer.
	pub const fn new(observer: O) -> Self {
		Self { observer }
	}
}

/// Service instrumented by a sanitized observer.
#[derive(Clone, Debug)]
pub struct ObserveService<S, O> {
	inner:    S,
	observer: O,
}

impl<S, O: Clone> Layer<S> for ObserveLayer<O> {
	type Service = ObserveService<S, O>;

	fn layer(&self, inner: S) -> Self::Service {
		ObserveService { inner, observer: self.observer.clone() }
	}
}

impl<S, O> Service<Call> for ObserveService<S, O>
where
	S: Service<Call, Error = Error>,
	O: Observer,
{
	type Error = Error;
	type Response = S::Response;

	type Future = impl Future<Output = Result<Self::Response, Self::Error>>;

	fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
		self.inner.poll_ready(cx)
	}

	fn call(&mut self, call: Call) -> Self::Future {
		let request_id = call.id.clone();
		self.observer.started(ExecutionStarted {
			request_id: request_id.clone(),
			operation:  call.operation.kind(),
		});
		let started = Instant::now();
		let observer = self.observer.clone();
		let future = self.inner.call(call);
		async move {
			let result = future.await;
			let (error, committed) = result
				.as_ref()
				.err()
				.map_or((None, false), |error| (Some(error.kind), error.committed));
			observer.finished(ExecutionFinished {
				request_id,
				elapsed: started.elapsed(),
				error,
				committed,
			});
			result
		}
	}
}
