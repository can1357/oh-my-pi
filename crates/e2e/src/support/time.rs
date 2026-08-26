use std::{future::Future, sync::Arc, time::Duration};

pub use omp_agent::testing::Gate;
use tokio::{sync::Barrier as TokioBarrier, time};

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
