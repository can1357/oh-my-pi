//! `/trace` feed: a bounded ring of the kernel's ephemeral notifications
//! (retries, inference starts, tool readiness, turn ends) with wall-clock
//! stamps, so the trace report can interleave them with the journal's own
//! ULID-stamped spans. Text and thinking deltas are not recorded one by
//! one: they are the journal's streams already.

use std::{
	collections::VecDeque,
	sync::Arc,
	time::{SystemTime, UNIX_EPOCH},
};

use omp_agent::KernelEvent;
use omp_chat::overlays::services::TraceEvent;
use omp_core::{Str, sf};
use parking_lot::Mutex;

/// Events kept; older ones fall off the front.
const CAPACITY: usize = 4_096;

/// Recorded kernel notifications, oldest first.
#[derive(Default)]
pub struct TraceLog {
	events: Mutex<VecDeque<TraceEvent>>,
}

impl TraceLog {
	/// Starts recording `events` on `runtime`; the log lives as long as the
	/// returned handle.
	#[must_use]
	pub fn record(
		events: flume::Receiver<KernelEvent>,
		runtime: &tokio::runtime::Handle,
	) -> Arc<Self> {
		let log = Arc::new(Self::default());
		let sink = Arc::clone(&log);
		runtime.spawn(async move {
			while let Ok(event) = events.recv_async().await {
				if let Some(label) = label(&event) {
					sink.push(now_ms(), label);
				}
			}
		});
		log
	}

	/// Appends one event at `at_ms`.
	pub fn push(&self, at_ms: u64, label: Str) {
		let mut events = self.events.lock();
		if events.len() == CAPACITY {
			events.pop_front();
		}
		events.push_back(TraceEvent { at_ms, label });
	}

	/// Every recorded event, oldest first.
	#[must_use]
	pub fn events(&self) -> Vec<TraceEvent> {
		self.events.lock().iter().cloned().collect()
	}
}

/// One-line label for the events worth tracing; `None` for per-token
/// deltas.
fn label(event: &KernelEvent) -> Option<Str> {
	Some(match event {
		KernelEvent::InferenceStarted => Str::new_static("inference started"),
		KernelEvent::InferenceRetry { attempt, max_attempts, delay, reason } => {
			sf!("retry {attempt}/{max_attempts} in {:.1}s: {reason}", delay.as_secs_f64())
		},
		KernelEvent::TurnEnded { stop } => sf!("turn ended: {}", format!("{stop:?}").to_lowercase()),
		KernelEvent::ToolReady { call_id, .. } => sf!("tool ready: {call_id}"),
		KernelEvent::ToolSettled { call_id, is_error } => {
			sf!("tool settled: {call_id}{}", if *is_error { " (error)" } else { "" })
		},
		KernelEvent::CompactionSpeculating { percent } => {
			sf!("compaction speculating at {percent}%")
		},
		KernelEvent::CompactionSettled { applied } => {
			sf!("compaction {}", if *applied { "applied" } else { "abandoned" })
		},
		KernelEvent::JobsDelivered { ids } => sf!("jobs delivered: {}", ids.join(", ")),
		KernelEvent::ApprovalRequested(ticket) => sf!("approval requested: {}", ticket.ticket_id),
		KernelEvent::WorkflowActionAnswered { name, is_error, .. } => {
			sf!("workflow action {name}{}", if *is_error { " (error)" } else { "" })
		},
		KernelEvent::Usage { .. }
		| KernelEvent::ToolUpdate { .. }
		| KernelEvent::TextDelta(_)
		| KernelEvent::ThinkingDelta(_) => return None,
	})
}

fn now_ms() -> u64 {
	SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.map_or(0, |elapsed| u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX))
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn ring_keeps_the_newest_events_and_labels_only_traceable_kinds() {
		let log = TraceLog::default();
		for index in 0..(CAPACITY + 2) {
			log.push(index as u64, sf!("e{index}"));
		}
		let events = log.events();
		assert_eq!(events.len(), CAPACITY);
		assert_eq!(events[0].label, "e2");
		assert!(label(&KernelEvent::TextDelta(Str::new_static("x"))).is_none());
		assert_eq!(
			label(&KernelEvent::ToolSettled { call_id: Str::new_static("c1"), is_error: true })
				.unwrap(),
			"tool settled: c1 (error)"
		);
	}
}
