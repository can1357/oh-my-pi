//! Model benchmark command over the normal inference registry and receipts.

use std::{
	fmt::Write as _,
	time::{Duration, Instant},
};

use futures::{StreamExt as _, stream};
use miette::{IntoDiagnostic as _, miette};
use omp_ai::{
	Client,
	call::{CallMeta, Target},
	event::ChatEvent,
	id::RequestId,
	receipt::{ExecutionBudget, Usage},
	router,
};
use omp_catalog::ModelKey;
use omp_core::Str;
use serde::Serialize;

use crate::{
	cli,
	cli::{BenchArgs, BenchProfile},
};

const DEFAULT_PREFILL_BYTES: usize = 32_768;
const PREFILL_CHUNK: &str = "Deterministic benchmark filler measures prompt ingestion without \
                             carrying semantic instructions. ";
const PREFILL_INSTRUCTION: &str = "The text above is benchmark filler. Ignore its content \
                                   entirely and reply with the single word: OK";
const CHAT_TOPICS: &[&str] = &[
	"how a web browser turns an HTML payload into pixels on screen",
	"how a garbage collector reclaims memory in a managed runtime",
	"how TCP congestion control adapts to packet loss",
	"how a B-tree index accelerates database lookups",
	"how DNS resolves a hostname to an IP address",
	"how an operating system scheduler shares a CPU between processes",
	"how public-key cryptography secures a TLS handshake",
	"how a compiler lowers source code to optimized machine code",
	"how a CPU cache hierarchy hides memory latency",
	"how a distributed consensus protocol keeps replicas consistent",
];
const GENERATION_TOPICS: &[&str] = &[
	"the history of computing",
	"the history of aviation",
	"the history of astronomy",
	"the history of railways",
	"the history of medicine",
	"the history of telecommunications",
	"the history of cartography",
	"the history of shipbuilding",
];

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, strum::Display, strum::IntoStaticStr)]
#[serde(rename_all = "lowercase")]
#[strum(serialize_all = "lowercase")]
enum BenchWorkload {
	Chat,
	Prefill,
	Generation,
}

const WORKLOADS: [BenchWorkload; 3] =
	[BenchWorkload::Chat, BenchWorkload::Prefill, BenchWorkload::Generation];

#[derive(Clone, Debug)]
struct BenchConfig {
	profile:             BenchProfile,
	runs:                u32,
	max_tokens_override: Option<u64>,
	prompt_override:     Option<Str>,
	prefill_bytes:       usize,
}

impl BenchConfig {
	fn resolve(args: &BenchArgs) -> miette::Result<Self> {
		if args.par == 0 {
			return Err(miette!("--par must be greater than zero"));
		}
		let runs = args.runs.unwrap_or(match args.profile {
			BenchProfile::Mix => 9,
			BenchProfile::Chat => 10,
			BenchProfile::Prefill | BenchProfile::Generation => 5,
		});
		if runs == 0 {
			return Err(miette!("--runs must be greater than zero"));
		}
		if args.max_tokens == Some(0) {
			return Err(miette!("--max-tokens must be greater than zero"));
		}
		if args.prefill_bytes == Some(0) {
			return Err(miette!("--prefill-bytes must be greater than zero"));
		}
		let prompt_override = args
			.prompt
			.as_deref()
			.map(str::trim)
			.filter(|prompt| !prompt.is_empty())
			.map(Str::new);
		if prompt_override.is_some()
			&& matches!(args.profile, BenchProfile::Mix | BenchProfile::Prefill)
		{
			return Err(miette!("--prompt requires --profile chat or generation"));
		}
		if args.prefill_bytes.is_some()
			&& matches!(args.profile, BenchProfile::Chat | BenchProfile::Generation)
		{
			return Err(miette!(
				"--prefill-bytes requires prefill workloads (--profile mix or prefill)"
			));
		}
		Ok(Self {
			profile: args.profile,
			runs,
			max_tokens_override: args.max_tokens,
			prompt_override,
			prefill_bytes: args.prefill_bytes.unwrap_or(DEFAULT_PREFILL_BYTES),
		})
	}

	fn workload(&self, run: u32) -> BenchWorkload {
		match self.profile {
			BenchProfile::Mix => WORKLOADS[run as usize % WORKLOADS.len()],
			BenchProfile::Chat => BenchWorkload::Chat,
			BenchProfile::Prefill => BenchWorkload::Prefill,
			BenchProfile::Generation => BenchWorkload::Generation,
		}
	}

	fn max_tokens(&self, workload: BenchWorkload) -> u64 {
		self.max_tokens_override.unwrap_or(match workload {
			BenchWorkload::Chat => 512,
			BenchWorkload::Prefill => 64,
			BenchWorkload::Generation => 2_048,
		})
	}

	fn challenge(&self, run: u32, nonce: &str) -> Challenge {
		let workload = self.workload(run);
		let prompt = match workload {
			BenchWorkload::Chat => self.prompt_override.clone().unwrap_or_else(|| {
				let topic = CHAT_TOPICS[topic_index(nonce, run, CHAT_TOPICS.len())];
				Str::from(format!(
					"Write detailed four-paragraph explanation of {topic}.\n\nForm: plain paragraphs \
					 only; no headings, lists, code fences, preamble. Do not summarize early; explain \
					 until token limit. Output explanation only."
				))
			}),
			BenchWorkload::Prefill => Str::from(prefill_payload(nonce, run, self.prefill_bytes)),
			BenchWorkload::Generation => self.prompt_override.clone().unwrap_or_else(|| {
				let topic = GENERATION_TOPICS[topic_index(nonce, run, GENERATION_TOPICS.len())];
				Str::from(format!(
					"Write an uninterrupted stream of plain prose recounting {topic}, decade by \
					 decade, in chronological order. No headings, lists, code fences, or preamble. Do \
					 not summarize or conclude early; keep adding new detail until the token limit \
					 cuts you off. Output the prose only."
				))
			}),
		};
		Challenge { workload, prompt, max_tokens: self.max_tokens(workload) }
	}
}

#[derive(Clone, Debug)]
struct Challenge {
	workload:   BenchWorkload,
	prompt:     Str,
	max_tokens: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Sample {
	run: u32,
	workload: BenchWorkload,
	cache_phase: &'static str,
	ttft_ms: u64,
	decode_ms: u64,
	elapsed_ms: u64,
	input_tokens: u64,
	output_tokens: u64,
	cache_read_tokens: u64,
	cache_write_tokens: u64,
	tokens_per_second: f64,
	decode_tokens_per_second: f64,
	prefill_tokens_per_second: f64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MetricStats {
	mean: f64,
	min:  f64,
	p50:  f64,
	p95:  f64,
	max:  f64,
}

impl MetricStats {
	fn from_values(values: impl IntoIterator<Item = f64>) -> Self {
		let mut values = values.into_iter().collect::<Vec<_>>();
		debug_assert!(!values.is_empty());
		values.sort_by(f64::total_cmp);
		let mean = values.iter().sum::<f64>() / values.len() as f64;
		Self {
			mean,
			min: values[0],
			p50: nearest_rank(&values, 50),
			p95: nearest_rank(&values, 95),
			max: values[values.len() - 1],
		}
	}
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkloadSummary {
	workload: BenchWorkload,
	runs: usize,
	ttft_ms: MetricStats,
	decode_ms: MetricStats,
	elapsed_ms: MetricStats,
	tokens_per_second: MetricStats,
	decode_tokens_per_second: MetricStats,
	prefill_tokens_per_second: MetricStats,
	mean_input_tokens: f64,
	mean_output_tokens: f64,
	mean_cache_read_tokens: f64,
	mean_cache_write_tokens: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BenchReport {
	profile:    BenchProfile,
	runs:       u32,
	#[serde(skip_serializing_if = "Option::is_none")]
	max_tokens: Option<u64>,
	samples:    Vec<Sample>,
	summaries:  Vec<WorkloadSummary>,
}

/// Executes one bounded benchmark runner through production credentials,
/// routing, retries, and final accounting receipts.
pub async fn run(args: BenchArgs) -> miette::Result<()> {
	let config = BenchConfig::resolve(&args)?;
	let data_dir = omp_core::dirs::data_dir(args.data_dir).into_diagnostic()?;
	let store = omp_driver::registry::open_credential_store(data_dir.join("credentials.db"))
		.into_diagnostic()?;
	let registry = omp_driver::registry::production_registry(&data_dir, store)
		.await
		.into_diagnostic()?;
	let model = ModelKey::from(args.model);
	let batch_nonce = cli::turn_id();
	let challenges = (0..config.runs)
		.map(|run| config.challenge(run, &batch_nonce))
		.collect::<Vec<_>>();
	let jobs = challenges.into_iter().enumerate().map(|(run, challenge)| {
		let registry = registry.clone();
		let model = model.clone();
		async move { sample(registry, model, challenge, run as u32).await }
	});
	let mut samples = stream::iter(jobs)
		.buffer_unordered(args.par)
		.collect::<Vec<_>>()
		.await
		.into_iter()
		.collect::<miette::Result<Vec<_>>>()?;
	samples.sort_by_key(|sample| sample.run);
	let summaries = summarize(&samples);
	let report = BenchReport {
		profile: config.profile,
		runs: config.runs,
		max_tokens: config.max_tokens_override,
		samples,
		summaries,
	};
	if args.json {
		println!("{}", serde_json::to_string_pretty(&report).into_diagnostic()?);
		return Ok(());
	}
	for sample in &report.samples {
		println!(
			"run {:>3} {:>10} {:>4}: TTFT {:>6} ms, decode {:>6} ms, {:>8.2} total tok/s, {:>8.2} \
			 decode tok/s, {} input, {} output, {} cache-read, {} cache-write token(s)",
			sample.run + 1,
			sample.workload,
			sample.cache_phase,
			sample.ttft_ms,
			sample.decode_ms,
			sample.tokens_per_second,
			sample.decode_tokens_per_second,
			sample.input_tokens,
			sample.output_tokens,
			sample.cache_read_tokens,
			sample.cache_write_tokens,
		);
	}
	for summary in &report.summaries {
		println!(
			"{} summary ({} run(s)): TTFT p50/p95 {:.0}/{:.0} ms, decode p50/p95 {:.0}/{:.0} ms, \
			 total tok/s p50/p95 {:.2}/{:.2}, decode tok/s p50/p95 {:.2}/{:.2}, prefill tok/s \
			 p50/p95 {:.2}/{:.2}, cache-write mean {:.1}",
			summary.workload,
			summary.runs,
			summary.ttft_ms.p50,
			summary.ttft_ms.p95,
			summary.decode_ms.p50,
			summary.decode_ms.p95,
			summary.tokens_per_second.p50,
			summary.tokens_per_second.p95,
			summary.decode_tokens_per_second.p50,
			summary.decode_tokens_per_second.p95,
			summary.prefill_tokens_per_second.p50,
			summary.prefill_tokens_per_second.p95,
			summary.mean_cache_write_tokens,
		);
	}
	Ok(())
}

async fn sample(
	registry: omp_ai::Registry,
	model: ModelKey,
	challenge: Challenge,
	run: u32,
) -> miette::Result<Sample> {
	let planner = router::Router::new(registry.clone(), Duration::from_secs(30));
	let meta = CallMeta {
		id:             RequestId::from(format!("omp-bench-{run}")),
		target:         Target::Model(model),
		deadline:       None,
		budget:         ExecutionBudget::default(),
		session:        None,
		debug_session:  None,
		response_hooks: Default::default(),
	};
	let mut request = cli::chat_request(challenge.prompt);
	request.max_output_tokens = Some(challenge.max_tokens);
	let started = Instant::now();
	let mut events = Client::new(registry.service(), planner, meta)
		.execute(request)
		.await
		.into_diagnostic()?;
	let mut first = None;
	let mut completion = None;
	while let Some(event) = events.next().await {
		match event.into_diagnostic()? {
			ChatEvent::TextDelta { .. } => {
				first.get_or_insert_with(Instant::now);
			},
			ChatEvent::Completed(done) => completion = Some(done),
			_ => {},
		}
	}
	let ended = Instant::now();
	let completion =
		completion.ok_or_else(|| miette!("benchmark stream ended without completion"))?;
	let first = first.unwrap_or(ended);
	Ok(sample_metrics(
		run,
		challenge.workload,
		first.duration_since(started),
		ended.duration_since(started),
		completion.usage,
	))
}

fn sample_metrics(
	run: u32,
	workload: BenchWorkload,
	ttft: Duration,
	elapsed: Duration,
	usage: Usage,
) -> Sample {
	let decode = elapsed.saturating_sub(ttft);
	let prompt_tokens = usage
		.input_tokens
		.saturating_add(usage.cache_read_tokens)
		.saturating_add(usage.cache_write_tokens);
	Sample {
		run,
		workload,
		cache_phase: if run % 2 == 0 { "cold" } else { "warm" },
		ttft_ms: millis(ttft),
		decode_ms: millis(decode),
		elapsed_ms: millis(elapsed),
		input_tokens: prompt_tokens,
		output_tokens: usage.output_tokens,
		cache_read_tokens: usage.cache_read_tokens,
		cache_write_tokens: usage.cache_write_tokens,
		tokens_per_second: rate(usage.output_tokens, elapsed),
		decode_tokens_per_second: rate(usage.output_tokens, decode),
		prefill_tokens_per_second: rate(prompt_tokens, ttft),
	}
}

fn summarize(samples: &[Sample]) -> Vec<WorkloadSummary> {
	WORKLOADS
		.into_iter()
		.filter_map(|workload| {
			let samples = samples
				.iter()
				.filter(|sample| sample.workload == workload)
				.collect::<Vec<_>>();
			if samples.is_empty() {
				return None;
			}
			let mean = |value: fn(&Sample) -> u64| -> f64 {
				samples
					.iter()
					.map(|sample| value(sample) as f64)
					.sum::<f64>()
					/ samples.len() as f64
			};
			Some(WorkloadSummary {
				workload,
				runs: samples.len(),
				ttft_ms: MetricStats::from_values(samples.iter().map(|sample| sample.ttft_ms as f64)),
				decode_ms: MetricStats::from_values(
					samples.iter().map(|sample| sample.decode_ms as f64),
				),
				elapsed_ms: MetricStats::from_values(
					samples.iter().map(|sample| sample.elapsed_ms as f64),
				),
				tokens_per_second: MetricStats::from_values(
					samples.iter().map(|sample| sample.tokens_per_second),
				),
				decode_tokens_per_second: MetricStats::from_values(
					samples.iter().map(|sample| sample.decode_tokens_per_second),
				),
				prefill_tokens_per_second: MetricStats::from_values(
					samples
						.iter()
						.map(|sample| sample.prefill_tokens_per_second),
				),
				mean_input_tokens: mean(|sample| sample.input_tokens),
				mean_output_tokens: mean(|sample| sample.output_tokens),
				mean_cache_read_tokens: mean(|sample| sample.cache_read_tokens),
				mean_cache_write_tokens: mean(|sample| sample.cache_write_tokens),
			})
		})
		.collect()
}

fn nearest_rank(sorted: &[f64], percentile: usize) -> f64 {
	let rank = percentile.saturating_mul(sorted.len()).div_ceil(100).max(1);
	sorted[rank.min(sorted.len()) - 1]
}

fn topic_index(nonce: &str, run: u32, topic_count: usize) -> usize {
	let hash = omp_core::fast_hash64(nonce.as_bytes()) ^ u64::from(run);
	usize::try_from(hash % topic_count as u64).unwrap_or(0)
}

fn prefill_payload(nonce: &str, run: u32, bytes: usize) -> String {
	let filler = prefill_filler(bytes);
	let mut payload =
		String::with_capacity(nonce.len() + filler.len() + PREFILL_INSTRUCTION.len() + 32);
	payload.push_str("Benchmark run ");
	payload.push_str(nonce);
	payload.push('-');
	write!(payload, "{run}").expect("writing to a String cannot fail");
	payload.push_str(".\n\n");
	payload.push_str(&filler);
	payload.push_str("\n\n");
	payload.push_str(PREFILL_INSTRUCTION);
	payload
}

fn prefill_filler(bytes: usize) -> String {
	let mut filler = String::with_capacity(bytes);
	while filler.len() < bytes {
		let remaining = bytes - filler.len();
		filler.push_str(&PREFILL_CHUNK[..remaining.min(PREFILL_CHUNK.len())]);
	}
	filler
}

fn rate(tokens: u64, duration: Duration) -> f64 {
	let seconds = duration.as_secs_f64();
	if seconds > 0.0 {
		tokens as f64 / seconds
	} else {
		0.0
	}
}

fn millis(duration: Duration) -> u64 {
	u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
	use super::*;

	fn args(profile: BenchProfile) -> BenchArgs {
		BenchArgs {
			model: Str::new_static("provider/model"),
			data_dir: None,
			runs: None,
			max_tokens: None,
			prompt: None,
			profile,
			prefill_bytes: None,
			par: 1,
			json: true,
		}
	}

	#[test]
	fn profile_defaults_cover_every_workload() {
		let mix = BenchConfig::resolve(&args(BenchProfile::Mix)).expect("mix");
		assert_eq!(mix.runs, 9);
		assert_eq!(mix.max_tokens(BenchWorkload::Chat), 512);
		assert_eq!(mix.max_tokens(BenchWorkload::Prefill), 64);
		assert_eq!(mix.max_tokens(BenchWorkload::Generation), 2_048);
		assert_eq!(
			BenchConfig::resolve(&args(BenchProfile::Chat))
				.unwrap()
				.runs,
			10
		);
		assert_eq!(
			BenchConfig::resolve(&args(BenchProfile::Prefill))
				.unwrap()
				.runs,
			5
		);
		assert_eq!(
			BenchConfig::resolve(&args(BenchProfile::Generation))
				.unwrap()
				.runs,
			5
		);
		for (profile, workload) in [
			(BenchProfile::Chat, BenchWorkload::Chat),
			(BenchProfile::Prefill, BenchWorkload::Prefill),
			(BenchProfile::Generation, BenchWorkload::Generation),
		] {
			let challenge = BenchConfig::resolve(&args(profile))
				.expect("profile")
				.challenge(0, "nonce");
			assert_eq!(challenge.workload, workload);
			assert!(!challenge.prompt.is_empty());
		}
	}

	#[test]
	fn mixed_profile_rotates_deterministically() {
		let config = BenchConfig::resolve(&args(BenchProfile::Mix)).expect("mix");
		let actual = (0..6).map(|run| config.workload(run)).collect::<Vec<_>>();
		assert_eq!(actual, [
			BenchWorkload::Chat,
			BenchWorkload::Prefill,
			BenchWorkload::Generation,
			BenchWorkload::Chat,
			BenchWorkload::Prefill,
			BenchWorkload::Generation,
		]);
	}

	#[test]
	fn prefill_filler_honors_byte_boundaries() {
		for bytes in [1, PREFILL_CHUNK.len() - 1, PREFILL_CHUNK.len(), PREFILL_CHUNK.len() + 1, 4096]
		{
			assert_eq!(prefill_filler(bytes).as_bytes().len(), bytes);
		}
		let first = prefill_payload("nonce", 0, 8);
		let second = prefill_payload("nonce", 1, 8);
		assert_ne!(first.as_bytes(), second.as_bytes());
	}

	#[test]
	fn invalid_profile_flag_combinations_are_rejected() {
		let mut mixed_prompt = args(BenchProfile::Mix);
		mixed_prompt.prompt = Some(Str::new_static("custom"));
		assert!(
			BenchConfig::resolve(&mixed_prompt)
				.unwrap_err()
				.to_string()
				.contains("--prompt")
		);

		let mut chat_prefill = args(BenchProfile::Chat);
		chat_prefill.prefill_bytes = Some(1024);
		assert!(
			BenchConfig::resolve(&chat_prefill)
				.unwrap_err()
				.to_string()
				.contains("--prefill-bytes")
		);

		let mut zero = args(BenchProfile::Prefill);
		zero.prefill_bytes = Some(0);
		assert!(BenchConfig::resolve(&zero).is_err());
	}

	#[test]
	fn nearest_rank_percentiles_cover_small_edges() {
		let one = MetricStats::from_values([7.0]);
		assert_eq!((one.p50, one.p95), (7.0, 7.0));
		let two = MetricStats::from_values([20.0, 10.0]);
		assert_eq!((two.p50, two.p95), (10.0, 20.0));
		let five = MetricStats::from_values([500.0, 100.0, 400.0, 200.0, 300.0]);
		assert_eq!((five.p50, five.p95, five.mean), (300.0, 500.0, 300.0));
	}

	#[test]
	fn metrics_account_for_decode_and_cache_written_prompt_tokens() {
		let usage = Usage {
			input_tokens: 3,
			output_tokens: 10,
			cache_read_tokens: 5,
			cache_write_tokens: 7,
			..Usage::default()
		};
		let cold = sample_metrics(
			0,
			BenchWorkload::Prefill,
			Duration::from_millis(20),
			Duration::from_millis(100),
			usage,
		);
		assert_eq!(cold.cache_phase, "cold");
		assert_eq!(cold.input_tokens, 15);
		assert_eq!(cold.cache_write_tokens, 7);
		assert_eq!(cold.decode_ms, 80);
		assert_eq!(cold.tokens_per_second, 100.0);
		assert_eq!(cold.decode_tokens_per_second, 125.0);
		assert_eq!(cold.prefill_tokens_per_second, 750.0);
		let warm = sample_metrics(
			1,
			BenchWorkload::Prefill,
			Duration::from_millis(20),
			Duration::from_millis(100),
			usage,
		);
		assert_eq!(warm.cache_phase, "warm");
	}

	#[test]
	fn summaries_remain_separate_per_workload() {
		let usage = Usage { input_tokens: 5, output_tokens: 10, ..Usage::default() };
		let samples = WORKLOADS
			.into_iter()
			.enumerate()
			.map(|(run, workload)| {
				sample_metrics(
					run as u32,
					workload,
					Duration::from_millis(10),
					Duration::from_millis(20),
					usage,
				)
			})
			.collect::<Vec<_>>();
		let summaries = summarize(&samples);
		assert_eq!(summaries.len(), 3);
		assert_eq!(
			summaries
				.iter()
				.map(|summary| summary.workload)
				.collect::<Vec<_>>(),
			WORKLOADS
		);
	}
}
