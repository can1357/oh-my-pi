//! Fixed pools of worker tasks fed through a channel.
//!
//! Per-item work (searching a file, one directory's files) runs on a few
//! long-lived tasks that keep their own state (sessions, buffers, searchers)
//! across items, instead of a task spawned per item. A feeder task drives the
//! input stream into a bounded job channel the workers share; their outputs
//! come back as a stream in input order ([`ordered`]).
//! Dropping the output stream aborts the feeder and the
//! workers at their next suspension point; a panic in `work` resumes in the
//! consumer.
//!
//! # Example
//! ```ignore
//! let lengths = exec::ordered(stream::iter(paths), 4, 64, Vec::new, |mut buf: Vec<u8>, path| async move {
//!     let len = read_into(&path, &mut buf).await;
//!     (buf, len)
//! });
//! ```

use std::{
	any::Any,
	collections::VecDeque,
	panic::AssertUnwindSafe,
	pin::{Pin, pin},
	sync::Arc,
	task::{Context, Poll},
};

use futures::{FutureExt, Stream, StreamExt};
use tokio::{
	sync::{OwnedSemaphorePermit, Semaphore},
	task::AbortHandle,
};

/// A panic payload caught in a worker.
type Panic = Box<dyn Any + Send>;

/// One item handed to a worker.
struct Job<I> {
	seq:    u64,
	item:   I,
	/// The in-flight slot of an [`ordered`] run, released once the output is
	/// yielded.
	permit: OwnedSemaphorePermit,
}

/// One worker's output for the job `seq`.
struct Done<O> {
	seq:    u64,
	output: Result<O, Panic>,
	permit: OwnedSemaphorePermit,
}

/// Aborts a pool's tasks when dropped.
struct Tasks(Vec<AbortHandle>);

impl Drop for Tasks {
	fn drop(&mut self) {
		for task in &self.0 {
			task.abort();
		}
	}
}

/// Spawns the feeder and one worker per state, with at most `window` items
/// in flight between the feeder and the consumer.
fn start<In, I, O, S, W, Fut>(
	inputs: In,
	states: Vec<S>,
	work: W,
	window: usize,
	results: flume::Sender<Done<O>>,
) -> Tasks
where
	In: Stream<Item = I> + Send + 'static,
	I: Send + 'static,
	O: Send + 'static,
	S: Send + 'static,
	W: Fn(S, I) -> Fut + Send + Sync + 'static,
	Fut: Future<Output = (S, O)> + Send + 'static,
{
	let (jobs, queue) = flume::bounded::<Job<I>>(states.len());
	let mut tasks = Vec::with_capacity(states.len() + 1);
	let permits = Arc::new(Semaphore::new(window.max(1)));
	tasks.push(
		tokio::spawn(async move {
			let mut inputs = pin!(inputs);
			let mut seq = 0;
			loop {
				// Take the slot before pulling the input, so a lazy producer
				// (a walk) never runs further ahead than the window.
				let Ok(permit) = Arc::clone(&permits).acquire_owned().await else {
					return;
				};
				let Some(item) = inputs.next().await else {
					return;
				};
				if jobs.send_async(Job { seq, item, permit }).await.is_err() {
					return;
				}
				seq += 1;
			}
		})
		.abort_handle(),
	);
	let work = Arc::new(work);
	for state in states {
		let (queue, results, work) = (queue.clone(), results.clone(), Arc::clone(&work));
		tasks.push(
			tokio::spawn(async move {
				let mut state = Some(state);
				while let Ok(Job { seq, item, permit }) = queue.recv_async().await {
					let current = state
						.take()
						.expect("a worker gets its state back after every job");
					let output = match AssertUnwindSafe(work(current, item)).catch_unwind().await {
						Ok((next, output)) => {
							state = Some(next);
							Ok(output)
						},
						Err(panic) => Err(panic),
					};
					let panicked = output.is_err();
					if results
						.send_async(Done { seq, output, permit })
						.await
						.is_err()
						|| panicked
					{
						return;
					}
				}
			})
			.abort_handle(),
		);
	}
	Tasks(tasks)
}

/// Resumes a worker's panic in the consumer.
fn unwrap_output<O>(output: Result<O, Panic>) -> O {
	output.unwrap_or_else(|panic| std::panic::resume_unwind(panic))
}

/// Runs `work` over `inputs` on `workers` tasks and yields the outputs in
/// input order.
///
/// Each worker owns one state from `init`, handed to `work` and returned with
/// its output. At most `window` items are in flight between pulling an input
/// and yielding its output, so the input stream is pulled lazily.
pub fn ordered<In, I, O, S, W, Fut>(
	inputs: In,
	workers: usize,
	window: usize,
	init: impl FnMut() -> S,
	work: W,
) -> Ordered<O>
where
	In: Stream<Item = I> + Send + 'static,
	I: Send + 'static,
	O: Send + 'static,
	S: Send + 'static,
	W: Fn(S, I) -> Fut + Send + Sync + 'static,
	Fut: Future<Output = (S, O)> + Send + 'static,
{
	let (results, outputs) = flume::unbounded();
	let states = std::iter::repeat_with(init).take(workers.max(1)).collect();
	let tasks = start(inputs, states, work, window.max(workers), results);
	Ordered { outputs: outputs.into_stream(), next: 0, pending: VecDeque::new(), _tasks: tasks }
}

/// An output that finished ahead of its turn, with its in-flight slot.
type Early<O> = (Result<O, Panic>, OwnedSemaphorePermit);

/// The outputs of an [`ordered`] run, in input order.
pub struct Ordered<O: 'static> {
	outputs: flume::r#async::RecvStream<'static, Done<O>>,
	/// Sequence number of the next output to yield.
	next:    u64,
	/// Outputs that finished ahead of `next`, indexed by `seq - next`.
	pending: VecDeque<Option<Early<O>>>,
	_tasks:  Tasks,
}

// Outputs are moved out, never pinned in place.
impl<O: 'static> Unpin for Ordered<O> {}

impl<O: 'static> Stream for Ordered<O> {
	type Item = O;

	fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<O>> {
		let this = &mut *self;
		loop {
			if this.pending.front().is_some_and(Option::is_some) {
				let (output, permit) = this.pending.pop_front().flatten().expect("checked above");
				drop(permit);
				this.next += 1;
				return Poll::Ready(Some(unwrap_output(output)));
			}
			match this.outputs.poll_next_unpin(cx) {
				Poll::Ready(Some(Done { seq, output, permit })) => {
					let index = usize::try_from(seq - this.next).expect("window fits in memory");
					if this.pending.len() <= index {
						this.pending.resize_with(index + 1, || None);
					}
					this.pending[index] = Some((output, permit));
				},
				Poll::Ready(None) => return Poll::Ready(None),
				Poll::Pending => return Poll::Pending,
			}
		}
	}
}

#[cfg(test)]
mod tests {
	use std::time::Duration;

	use futures::stream;

	use super::*;

	/// Outputs come back in input order however long each item takes, and
	/// each worker's state carries over between its items.
	#[tokio::test(flavor = "multi_thread")]
	async fn ordered_keeps_input_order_and_worker_state() {
		let outputs: Vec<(u64, usize)> = ordered(
			stream::iter(0..200_u64),
			4,
			16,
			|| 0_usize,
			|seen, n| async move {
				tokio::time::sleep(Duration::from_micros((n * 7919) % 300)).await;
				(seen + 1, (n, seen))
			},
		)
		.collect()
		.await;
		assert_eq!(outputs.iter().map(|(n, _)| *n).collect::<Vec<_>>(), (0..200).collect::<Vec<_>>());
		// Every worker counted its own items: the counts across workers sum to
		// the items each worker had seen before each one.
		assert!(outputs.iter().any(|(_, seen)| *seen > 0));
	}

	/// The window bounds how far the input stream is pulled ahead of the
	/// consumer.
	#[tokio::test(flavor = "multi_thread")]
	async fn ordered_pulls_at_most_a_window_ahead() {
		let pulled = Arc::new(std::sync::atomic::AtomicU64::new(0));
		let counter = Arc::clone(&pulled);
		let inputs = stream::iter(0..1000_u64).inspect(move |_| {
			counter.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
		});
		let mut outputs = ordered(inputs, 2, 8, || (), |(), n| async move { ((), n) });
		assert_eq!(outputs.next().await, Some(0));
		tokio::time::sleep(Duration::from_millis(50)).await;
		assert!(pulled.load(std::sync::atomic::Ordering::Relaxed) <= 9);
	}

	/// A panic in `work` resumes in the consumer.
	#[tokio::test(flavor = "multi_thread")]
	async fn panics_resume_in_the_consumer() {
		let run = tokio::spawn(async {
			let _: Vec<u8> = ordered(
				stream::iter([1_u8, 2, 3]),
				2,
				2,
				|| (),
				|(), n| async move {
					assert_ne!(n, 2, "boom");
					((), n)
				},
			)
			.collect()
			.await;
		});
		assert!(run.await.unwrap_err().is_panic());
	}
}
