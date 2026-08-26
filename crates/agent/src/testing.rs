use std::{
	collections::VecDeque,
	future,
	future::Future,
	pin::Pin,
	sync::{
		Arc,
		atomic::{AtomicBool, Ordering},
	},
	task::{Context, Poll},
	time::Duration,
};

use futures::Stream;
use omp_proto::inference::v1::TurnEvent;
use parking_lot::Mutex;
use tokio::{sync::Notify, time};

use crate::{Error, InvokeFrame, TurnClient, TurnId, TurnInput, TurnOptions, TurnSession};

/// Failure waiting on a [`Gate`] rendezvous within its bound.
#[derive(Debug, thiserror::Error)]
pub enum GateError {
	/// Arrival was not observed before the bound elapsed.
	#[error("timed out waiting for gate arrival after {limit:?}")]
	ArrivalTimeout {
		/// Bound applied to the wait.
		limit:  Duration,
		/// Timeout observed by the Tokio timer.
		#[source]
		source: time::error::Elapsed,
	},
	/// Release was not observed before the bound elapsed.
	#[error("timed out waiting for gate release after {limit:?}")]
	GateTimeout {
		/// Bound applied to the wait.
		limit:  Duration,
		/// Timeout observed by the Tokio timer.
		#[source]
		source: time::error::Elapsed,
	},
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
	pub async fn wait_arrived(&self, limit: Duration) -> Result<(), GateError> {
		time::timeout(limit, async {
			loop {
				let notified = self.0.arrival.notified();
				if self.0.arrived.load(Ordering::Acquire) {
					break;
				}
				notified.await;
			}
		})
		.await
		.map_err(|source| GateError::ArrivalTimeout { limit, source })
	}

	/// Releases every waiter parked at this gate.
	pub fn release(&self) {
		self.0.released.store(true, Ordering::Release);
		self.0.release.notify_waiters();
	}

	/// Marks arrival and waits with a bound for release.
	pub async fn arrive_and_wait(&self, limit: Duration) -> Result<(), GateError> {
		self.arrive();
		time::timeout(limit, self.released())
			.await
			.map_err(|source| GateError::GateTimeout { limit, source })
	}

	pub async fn released(&self) {
		loop {
			let notified = self.0.release.notified();
			if self.0.released.load(Ordering::Acquire) {
				break;
			}
			notified.await;
		}
	}
}

/// One ordered action in a deterministic turn script.
#[derive(Debug)]
pub enum ScriptedStep {
	/// Emits one canonical event or typed turn failure.
	Event(Result<Box<TurnEvent>, Error>),
	/// Marks arrival, then pauses the stream until the test releases the gate.
	Wait(Gate),
}

impl From<TurnEvent> for ScriptedStep {
	fn from(event: TurnEvent) -> Self {
		Self::Event(Ok(Box::new(event)))
	}
}

impl From<Result<TurnEvent, Error>> for ScriptedStep {
	fn from(event: Result<TurnEvent, Error>) -> Self {
		Self::Event(event.map(Box::new))
	}
}

/// One deterministic turn event stream consumed by [`ScriptedTurnClient`].
#[derive(Debug)]
pub struct ScriptedTurn {
	steps: VecDeque<ScriptedStep>,
}

impl ScriptedTurn {
	/// Scripts an ordered successful event stream.
	pub fn events(events: impl IntoIterator<Item = TurnEvent>) -> Self {
		Self { steps: events.into_iter().map(ScriptedStep::from).collect() }
	}

	/// Scripts an ordered stream that may terminate with a typed turn error.
	pub fn results(events: impl IntoIterator<Item = Result<TurnEvent, Error>>) -> Self {
		Self { steps: events.into_iter().map(ScriptedStep::from).collect() }
	}

	/// Scripts events interleaved with externally released deterministic gates.
	pub fn steps(steps: impl IntoIterator<Item = ScriptedStep>) -> Self {
		Self { steps: steps.into_iter().collect() }
	}
}

/// Exact request observed at the scripted turn seam.
#[derive(Clone, Debug)]
pub struct CapturedTurn {
	/// Stable logical turn identity.
	pub turn_id:   TurnId,
	/// Full or incremental canonical input.
	pub input:     TurnInput,
	/// Per-turn options seen by the transport.
	pub options:   TurnOptions,
	/// Duplex frames submitted in response to server invocations.
	pub submitted: Arc<Mutex<Vec<InvokeFrame>>>,
}

/// Queue-backed deterministic [`TurnClient`] that records every request and
/// duplex response.
#[derive(Clone, Debug)]
pub struct ScriptedTurnClient {
	scripts:  Arc<Mutex<VecDeque<ScriptedTurn>>>,
	captured: Arc<Mutex<Vec<CapturedTurn>>>,
}

impl ScriptedTurnClient {
	/// Creates a client that consumes exactly one script per opened turn.
	pub fn new(scripts: impl IntoIterator<Item = ScriptedTurn>) -> Self {
		Self {
			scripts:  Arc::new(Mutex::new(scripts.into_iter().collect())),
			captured: Arc::new(Mutex::new(Vec::new())),
		}
	}

	/// Returns a stable snapshot of all opened turns and submitted invocation
	/// frames.
	pub fn captures(&self) -> Vec<CapturedTurn> {
		self.captured.lock().clone()
	}

	/// Returns the number of scripts not yet consumed.
	pub fn remaining(&self) -> usize {
		self.scripts.lock().len()
	}
}

impl TurnClient for ScriptedTurnClient {
	type Session<'client> = ScriptedTurnSession;

	fn turn<'client>(
		&'client self,
		turn_id: TurnId,
		input: TurnInput,
		options: &'client TurnOptions,
	) -> impl Future<Output = Result<Self::Session<'client>, Error>> + Send + 'client {
		let script = self.scripts.lock().pop_front();
		let captured = Arc::clone(&self.captured);
		let options = options.clone();
		async move {
			let script = script.ok_or(Error::Invalid("scripted turn queue exhausted"))?;
			let submitted = Arc::new(Mutex::new(Vec::new()));
			captured.lock().push(CapturedTurn {
				turn_id,
				input,
				options,
				submitted: Arc::clone(&submitted),
			});
			Ok(ScriptedTurnSession { steps: script.steps, submitted, waiting: None })
		}
	}
}

/// One live scripted turn session.
pub struct ScriptedTurnSession {
	steps:     VecDeque<ScriptedStep>,
	submitted: Arc<Mutex<Vec<InvokeFrame>>>,
	waiting:   Option<Pin<Box<dyn Future<Output = ()> + Send + 'static>>>,
}

impl TurnSession for ScriptedTurnSession {
	fn events(&mut self) -> impl Stream<Item = Result<TurnEvent, Error>> + Send + Unpin + '_ {
		ScriptedEventStream { steps: &mut self.steps, waiting: &mut self.waiting }
	}

	fn submit(&mut self, frame: InvokeFrame) -> impl Future<Output = Result<(), Error>> + Send + '_ {
		self.submitted.lock().push(frame);
		future::ready(Ok(()))
	}
}

struct ScriptedEventStream<'session> {
	steps:   &'session mut VecDeque<ScriptedStep>,
	waiting: &'session mut Option<Pin<Box<dyn Future<Output = ()> + Send + 'static>>>,
}

impl Unpin for ScriptedEventStream<'_> {}

impl Stream for ScriptedEventStream<'_> {
	type Item = Result<TurnEvent, Error>;

	fn poll_next(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Option<Self::Item>> {
		loop {
			if self
				.waiting
				.as_mut()
				.is_some_and(|waiting| waiting.as_mut().poll(context).is_pending())
			{
				return Poll::Pending;
			}
			if self.waiting.is_some() {
				*self.waiting = None;
				let _ = self.steps.pop_front();
				continue;
			}
			match self.steps.front() {
				Some(ScriptedStep::Event(_)) => {
					let Some(ScriptedStep::Event(event)) = self.steps.pop_front() else {
						return Poll::Ready(None);
					};
					return Poll::Ready(Some(event.map(|event| *event)));
				},
				Some(ScriptedStep::Wait(gate)) => {
					let gate = gate.clone();
					gate.arrive();
					*self.waiting = Some(Box::pin(async move { gate.released().await }));
				},
				None => return Poll::Ready(None),
			}
		}
	}
}

#[cfg(test)]
mod tests {
	use std::{error::Error as _, time::Duration};

	use super::{Gate, GateError};

	#[tokio::test]
	async fn wait_arrived_times_out_with_named_limit() {
		let gate = Gate::default();
		let limit = Duration::from_millis(5);
		let error = gate
			.wait_arrived(limit)
			.await
			.expect_err("unarrived gate times out");
		assert!(
			matches!(error, GateError::ArrivalTimeout { limit: observed, source: _ } if observed == limit)
		);
		assert!(error.source().is_some(), "preserves Tokio Elapsed");
	}

	#[tokio::test]
	async fn arrive_and_wait_times_out_with_named_limit() {
		let gate = Gate::default();
		let limit = Duration::from_millis(5);
		let error = gate
			.arrive_and_wait(limit)
			.await
			.expect_err("unreleased gate times out");
		assert!(
			matches!(error, GateError::GateTimeout { limit: observed, source: _ } if observed == limit)
		);
		assert!(error.source().is_some(), "preserves Tokio Elapsed");
	}
}
