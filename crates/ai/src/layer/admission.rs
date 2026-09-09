//! Route/account concurrency admission, bounded queuing, and readiness
//! backpressure.

use std::{
	pin,
	sync::{
		Arc,
		atomic::{AtomicUsize, Ordering},
	},
	task::{Context, Poll, Waker},
};

use parking_lot::Mutex;
use tower::{Layer, Service};

use crate::{
	error::{Error, ErrorKind, ErrorPhase, RetryAction},
	layer::LayerCall,
	receipt::ExecutionReceipt,
};

/// Shared bounded concurrency controller.
#[derive(Clone)]
pub struct AdmissionController(Arc<AdmissionState>);
struct AdmissionState {
	limit:       usize,
	queue_limit: usize,
	active:      AtomicUsize,
	waiting:     AtomicUsize,
	wakers:      Mutex<Vec<Waker>>,
}
impl AdmissionController {
	/// Creates a controller with nonzero concurrency and a bounded waiter count.
	pub fn new(limit: usize, queue_limit: usize) -> Self {
		assert!(limit > 0, "admission concurrency must be nonzero");
		Self(Arc::new(AdmissionState {
			limit,
			queue_limit,
			active: AtomicUsize::new(0),
			waiting: AtomicUsize::new(0),
			wakers: Mutex::new(Vec::new()),
		}))
	}

	fn try_acquire(&self) -> Option<AdmissionPermit> {
		let mut active = self.0.active.load(Ordering::Acquire);
		loop {
			if active >= self.0.limit {
				return None;
			}
			match self.0.active.compare_exchange_weak(
				active,
				active + 1,
				Ordering::AcqRel,
				Ordering::Acquire,
			) {
				Ok(_) => return Some(AdmissionPermit(self.clone())),
				Err(observed) => active = observed,
			}
		}
	}

	/// Returns active admitted calls.
	pub fn active(&self) -> usize {
		self.0.active.load(Ordering::Acquire)
	}
}
struct AdmissionPermit(AdmissionController);
impl Drop for AdmissionPermit {
	fn drop(&mut self) {
		self.0.0.active.fetch_sub(1, Ordering::AcqRel);
		for waker in self.0.0.wakers.lock().drain(..) {
			waker.wake();
		}
	}
}

/// Adds admission control before account/auth/network work.
#[derive(Clone)]
pub struct AdmissionLayer {
	controller: AdmissionController,
}
impl AdmissionLayer {
	/// Creates an admission layer.
	pub const fn new(controller: AdmissionController) -> Self {
		Self { controller }
	}
}
/// Service whose readiness reserves the exact permit consumed by `call`.
pub struct AdmissionService<S> {
	inner:      S,
	controller: AdmissionController,
	permit:     Option<AdmissionPermit>,
	waiting:    bool,
}
impl<S: Clone> Clone for AdmissionService<S> {
	fn clone(&self) -> Self {
		Self {
			inner:      self.inner.clone(),
			controller: self.controller.clone(),
			permit:     None,
			waiting:    false,
		}
	}
}
impl<S> Drop for AdmissionService<S> {
	fn drop(&mut self) {
		if self.waiting {
			self.controller.0.waiting.fetch_sub(1, Ordering::AcqRel);
		}
	}
}
impl<S> Layer<S> for AdmissionLayer {
	type Service = AdmissionService<S>;

	fn layer(&self, inner: S) -> Self::Service {
		AdmissionService { inner, controller: self.controller.clone(), permit: None, waiting: false }
	}
}
impl<S, T> Service<LayerCall<T>> for AdmissionService<S>
where
	S: Service<LayerCall<T>, Error = Error>,
{
	type Error = Error;
	type Future = AdmissionFuture<S::Future>;
	type Response = S::Response;

	fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), Error>> {
		if self.permit.is_none() {
			if let Some(permit) = self.controller.try_acquire() {
				self.permit = Some(permit);
				if self.waiting {
					self.controller.0.waiting.fetch_sub(1, Ordering::AcqRel);
					self.waiting = false;
				}
			} else {
				if !self.waiting {
					let waiting = self.controller.0.waiting.fetch_add(1, Ordering::AcqRel);
					if waiting >= self.controller.0.queue_limit {
						self.controller.0.waiting.fetch_sub(1, Ordering::AcqRel);
						return Poll::Ready(Err(Error::new(
							ErrorKind::ResourceExhausted,
							ErrorPhase::Admission,
							RetryAction::Never,
							ExecutionReceipt::default(),
						)));
					}
					self.waiting = true;
				}
				self.controller.0.wakers.lock().push(cx.waker().clone());
				if let Some(permit) = self.controller.try_acquire() {
					self.permit = Some(permit);
					self.controller.0.waiting.fetch_sub(1, Ordering::AcqRel);
					self.waiting = false;
				} else {
					return Poll::Pending;
				}
			}
		}
		match self.inner.poll_ready(cx) {
			Poll::Ready(Err(error)) => {
				self.permit = None;
				Poll::Ready(Err(error))
			},
			other => other,
		}
	}

	fn call(&mut self, request: LayerCall<T>) -> Self::Future {
		let permit = self
			.permit
			.take()
			.expect("call requires successful readiness on this admission service instance");
		AdmissionFuture { inner: self.inner.call(request), _permit: permit }
	}
}

pin_project_lite::pin_project! { /// Future retaining admission through the response handshake.
	pub struct AdmissionFuture<F> { #[pin] inner: F, _permit: AdmissionPermit }
}
impl<F, T> Future for AdmissionFuture<F>
where
	F: Future<Output = Result<T, Error>>,
{
	type Output = Result<T, Error>;

	fn poll(self: pin::Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
		self.project().inner.poll(cx)
	}
}

#[cfg(test)]
mod tests {
	use std::{
		future,
		future::Ready,
		task::{Context, Poll},
	};

	use tower::{Layer, Service};

	use super::{AdmissionController, AdmissionLayer};
	use crate::{
		error::Error,
		layer::{ExecutionContext, LayerCall},
		receipt::ExecutionBudget,
	};
	#[derive(Clone, Default)]
	struct ReadyChecked {
		ready: bool,
	}
	impl Service<LayerCall<()>> for ReadyChecked {
		type Error = Error;
		type Future = Ready<Result<(), Error>>;
		type Response = ();

		fn poll_ready(&mut self, _: &mut Context<'_>) -> Poll<Result<(), Error>> {
			self.ready = true;
			Poll::Ready(Ok(()))
		}

		fn call(&mut self, _: LayerCall<()>) -> Self::Future {
			assert!(std::mem::take(&mut self.ready));
			future::ready(Ok::<(), Error>(()))
		}
	}
	#[tokio::test]
	async fn readiness_and_call_use_same_instance() {
		let mut service =
			AdmissionLayer::new(AdmissionController::new(1, 1)).layer(ReadyChecked::default());
		futures::future::poll_fn(|cx| service.poll_ready(cx))
			.await
			.unwrap();
		service
			.call(LayerCall {
				payload: (),
				context: ExecutionContext::new(ExecutionBudget::default()),
			})
			.await
			.unwrap();
	}
}
