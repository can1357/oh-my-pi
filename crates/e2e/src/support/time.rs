use std::{
	future::Future,
	sync::{
		Arc,
		atomic::{AtomicBool, Ordering},
	},
	time::Duration,
};

use tokio::{
	sync::{Barrier as TokioBarrier, Notify},
	time,
};

use crate::{Context as _, Result};

/// Default upper bound for one local authority transition.
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(5);

/// Awaits `future` for at most `limit`, retaining a diagnostic label on
/// timeout.
pub async fn within<T>(
	label: &'static str,
	limit: Duration,
	future: impl Future<Output = T>,
) -> Result<T> {
	time::timeout(limit, future)
		.await
		.with_context(|| format!("timed out waiting for {label} after {limit:?}"))
}

/// One deterministic test rendezvous with separately observable arrival and
/// release.
#[derive(Clone, Debug, Default)]
pub struct Gate(Arc<GateInner>);

#[derive(Debug, Default)]
struct GateInner {
	arrived:  AtomicBool,
	released: AtomicBool,
	arrival:  Notify,
	release:  Notify,
}

impl Gate {
	/// Marks the interesting operation as having reached this gate.
	pub fn arrive(&self) {
		self.0.arrived.store(true, Ordering::Release);
		self.0.arrival.notify_waiters();
	}

	/// Waits with a bound until the operation reaches this gate.
	pub async fn wait_arrived(&self, limit: Duration) -> Result<()> {
		within("gate arrival", limit, async {
			loop {
				let notified = self.0.arrival.notified();
				if self.0.arrived.load(Ordering::Acquire) {
					break;
				}
				notified.await;
			}
		})
		.await
	}

	/// Releases every waiter parked at this gate.
	pub fn release(&self) {
		self.0.released.store(true, Ordering::Release);
		self.0.release.notify_waiters();
	}

	/// Marks arrival and waits with a bound for release.
	pub async fn arrive_and_wait(&self, limit: Duration) -> Result<()> {
		self.arrive();
		within("gate release", limit, self.released()).await
	}

	pub(crate) async fn released(&self) {
		loop {
			let notified = self.0.release.notified();
			if self.0.released.load(Ordering::Acquire) {
				break;
			}
			notified.await;
		}
	}
}

/// Reusable N-party barrier whose waits cannot hang a proof indefinitely.
#[derive(Clone, Debug)]
pub struct DeterministicBarrier(Arc<TokioBarrier>);

impl DeterministicBarrier {
	/// Creates an N-party reusable barrier.
	pub fn new(parties: usize) -> Self {
		Self(Arc::new(TokioBarrier::new(parties)))
	}

	/// Waits for every party within `limit`.
	pub async fn wait(&self, limit: Duration) -> Result<()> {
		within("deterministic barrier", limit, self.0.wait()).await?;
		Ok(())
	}
}
