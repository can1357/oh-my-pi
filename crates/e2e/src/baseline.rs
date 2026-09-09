//! P8 performance recorder for retained TUI frames and the journal-first
//! kernel.
//!
//! P8 records host measurements but never gates CI on timing.

use std::{
	fs,
	path::Path,
	sync::Arc,
	time::{Duration, Instant},
};

use omp_agent::{DispatchPolicy, Kernel, RunControl, StaticPrompt, TurnInput};
use omp_ai::{BlockKind, ChatEvent, Completion, ExecutionReceipt, FinishReason, Usage};
use omp_core::Str;
use omp_journal::blob::BlobStore;
use omp_session::{ComponentRegistry, Session};
use omp_tool::Registry;
use omp_tui::{Prop, Renderer, Ui, UiContext, components::TextLeaf};
use serde::{Deserialize, Serialize};

use crate::{
	Context as _, Result, error,
	support::{ScriptedInference, scripted_stream},
};

const SCHEMA_VERSION: u32 = 1;
const GROSS_REGRESSION_LIMIT: f64 = 5.0;
const TOKEN: &str = "·";

/// Recorded frame and agent-loop measurements for a baseline run.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct BaselineMetrics {
	/// Version of the serialized baseline schema.
	pub schema_version: u32,
	/// Retained-TUI frame measurements.
	pub frame:          FrameMetrics,
	/// Journal-first kernel measurements.
	pub r#loop:         LoopMetrics,
}

/// Frame-time measurements collected during streaming text updates.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
pub struct FrameMetrics {
	/// Number of streamed tokens measured.
	pub token_count:  usize,
	/// Number of individual frame samples.
	pub sample_count: usize,
	/// Ninety-fifth percentile frame duration in nanoseconds.
	pub p95_frame_ns: u128,
}

/// Kernel throughput measurements collected from canonical event streams.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct LoopMetrics {
	/// Number of tokens processed in each sample.
	pub tokens_per_sample:      usize,
	/// Number of independent loop samples.
	pub sample_count:           usize,
	/// Total raw client-stream duration in nanoseconds.
	pub raw_duration_ns:        u128,
	/// Total end-to-end kernel duration in nanoseconds.
	pub full_loop_duration_ns:  u128,
	/// Raw client-stream throughput in tokens per second.
	pub raw_tokens_per_second:  f64,
	/// End-to-end kernel throughput in tokens per second.
	pub full_tokens_per_second: f64,
	/// Ratio of raw throughput to end-to-end throughput.
	pub slowdown_ratio:         f64,
	/// Threshold used to mark gross throughput regressions.
	pub regression_limit:       f64,
	/// Whether the measured slowdown exceeds the recorder threshold.
	pub gross_regression:       bool,
}

fn token_events(tokens: usize) -> Vec<ChatEvent> {
	let mut events = Vec::with_capacity(tokens.saturating_add(3));
	events.push(ChatEvent::BlockStarted { index: 0, kind: BlockKind::Text });
	for _ in 0..tokens {
		events.push(ChatEvent::TextDelta { index: 0, text: Str::new_static(TOKEN) });
	}
	events.push(ChatEvent::Completed(Completion {
		reason:  FinishReason::Stop,
		blocks:  1,
		usage:   Usage::default(),
		receipt: ExecutionReceipt::default().into(),
	}));
	events
}

/// Measures retained-frame and end-to-end kernel performance.
pub async fn measure(
	frame_tokens: usize,
	loop_tokens: usize,
	samples: usize,
) -> Result<BaselineMetrics> {
	if frame_tokens < 100 || loop_tokens < 100 || samples == 0 {
		return Err(error("baseline requires at least 100 frame and loop tokens and one sample"));
	}
	let frame = measure_frames(frame_tokens)?;
	let raw_duration = measure_raw(loop_tokens, samples).await?;
	let scratch = tempfile::tempdir().context("create loop baseline scratch directory")?;
	let scripts = (0..samples).map(|_| token_events(loop_tokens));
	let (inference, _) = ScriptedInference::new(scripts);
	let mut kernel = Kernel::new(
		inference,
		Arc::new(Registry::new()),
		DispatchPolicy::new(
			BlobStore::open(scratch.path().join("blobs")).context("open blob store")?,
		),
		StaticPrompt(Str::new_static("P8 baseline")),
	);
	let mut full_duration = Duration::ZERO;
	for ordinal in 0..samples {
		let path = scratch.path().join(format!("sample-{ordinal}.oms"));
		let mut session =
			Session::create(path, ComponentRegistry::standard()).context("create baseline session")?;
		let started = Instant::now();
		kernel
			.run_turn(
				&mut session,
				TurnInput { text: Str::new_static("measure"), attachments: Vec::new() },
				RunControl::default(),
			)
			.await
			.context("measure full kernel loop")?;
		full_duration = full_duration.saturating_add(started.elapsed());
	}
	let total_tokens = loop_tokens
		.checked_mul(samples)
		.context("loop token count overflow")?;
	let raw_rate = duration_rate(total_tokens, raw_duration)?;
	let full_rate = duration_rate(total_tokens, full_duration)?;
	let slowdown = slowdown_ratio(raw_rate, full_rate)?;
	Ok(BaselineMetrics {
		schema_version: SCHEMA_VERSION,
		frame,
		r#loop: LoopMetrics {
			tokens_per_sample:      loop_tokens,
			sample_count:           samples,
			raw_duration_ns:        raw_duration.as_nanos(),
			full_loop_duration_ns:  full_duration.as_nanos(),
			raw_tokens_per_second:  raw_rate,
			full_tokens_per_second: full_rate,
			slowdown_ratio:         slowdown,
			regression_limit:       GROSS_REGRESSION_LIMIT,
			gross_regression:       slowdown > GROSS_REGRESSION_LIMIT,
		},
	})
}

fn measure_frames(tokens: usize) -> Result<FrameMetrics> {
	let root = TextLeaf::new().with(Prop::Id, "stream").text("");
	let mut ui = Ui::from_root(root, 80, UiContext::default());
	let mut renderer = Renderer::new(Vec::<u8>::with_capacity(tokens.saturating_mul(16)));
	ui.present(&mut renderer, 24)
		.context("paint warmup frame")?;
	let mut text = String::with_capacity(tokens.saturating_mul(TOKEN.len()));
	let mut elapsed = Vec::with_capacity(tokens);
	for _ in 0..tokens {
		text.push_str(TOKEN);
		let started = Instant::now();
		if !ui.set_text("stream", text.as_str()) {
			return Err(error("token-storm text component stopped accepting updates"));
		}
		ui.present(&mut renderer, 24)
			.context("paint token-storm frame")?;
		elapsed.push(started.elapsed().as_nanos());
	}
	elapsed.sort_unstable();
	let rank = elapsed
		.len()
		.saturating_mul(95)
		.div_ceil(100)
		.saturating_sub(1);
	Ok(FrameMetrics {
		token_count:  tokens,
		sample_count: elapsed.len(),
		p95_frame_ns: elapsed[rank],
	})
}

async fn measure_raw(tokens: usize, samples: usize) -> Result<Duration> {
	use futures::StreamExt as _;
	let mut total = Duration::ZERO;
	for _ in 0..samples {
		let started = Instant::now();
		let mut stream = scripted_stream(token_events(tokens));
		while let Some(event) = stream.next().await {
			event.context("consume canonical inference event")?;
		}
		total = total.saturating_add(started.elapsed());
	}
	Ok(total)
}

/// Computes token throughput from a nonzero duration and token count.
pub fn duration_rate(tokens: usize, duration: Duration) -> Result<f64> {
	if tokens == 0 {
		return Err(error("token count must be non-zero"));
	}
	if duration.is_zero() {
		return Err(error("measured duration must be non-zero"));
	}
	let rate = tokens as f64 / duration.as_secs_f64();
	if !rate.is_finite() || rate <= 0.0 {
		return Err(error("token rate is not finite and positive"));
	}
	Ok(rate)
}

/// Computes the end-to-end slowdown relative to raw token throughput.
pub fn slowdown_ratio(raw_rate: f64, full_rate: f64) -> Result<f64> {
	if !raw_rate.is_finite() || raw_rate <= 0.0 || !full_rate.is_finite() || full_rate <= 0.0 {
		return Err(error("token rates must be finite and positive"));
	}
	Ok(raw_rate / full_rate)
}

/// Serializes measurements to the requested artifact path.
pub fn write_metrics(path: &Path, metrics: &BaselineMetrics) -> Result<()> {
	if let Some(parent) = path.parent()
		&& !parent.as_os_str().is_empty()
	{
		fs::create_dir_all(parent)
			.with_context(|| format!("create artifact directory {}", parent.display()))?;
	}
	let bytes = serde_json::to_vec_pretty(metrics).context("serialize baseline metrics")?;
	fs::write(path, bytes).with_context(|| format!("write baseline artifact {}", path.display()))?;
	Ok(())
}
