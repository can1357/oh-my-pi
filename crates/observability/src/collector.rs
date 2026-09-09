//! Per-invocation chat/tool collection and stable run aggregation.

use std::collections::{BTreeMap, BTreeSet};

use omp_core::{FastHashMap, Str};
use omp_proto::omp::inference::v1;

use crate::semconv::ToolStatus;

/// The full-fidelity wire shape is the single in-process provider-usage truth.
///
/// [`Usage`] below is deliberately only a metrics projection; callers retain
/// this type for firehose records and durable telemetry rows.
pub type InferenceUsage = v1::Usage;

/// Raw record for one completed chat step.
#[derive(Clone, Debug, PartialEq)]
pub struct ChatRecord {
	/// Agent-loop step number, or `-1` when the matching start was absent.
	pub step_number:             i64,
	/// Model identifier.
	pub model:                   Str,
	/// Provider identifier.
	pub provider:                Str,
	/// Raw stop reason, when supplied by the provider.
	pub stop_reason:             Option<Str>,
	/// Elapsed wall-clock time in milliseconds.
	pub latency_ms:              f64,
	/// Total cost-bearing input, including cache reads and writes.
	pub input_tokens:            u64,
	/// Output tokens.
	pub output_tokens:           u64,
	/// Cache-read input tokens.
	pub cached_input_tokens:     u64,
	/// Cache-write input tokens.
	pub cache_write_tokens:      u64,
	/// Reasoning output tokens.
	pub reasoning_output_tokens: u64,
	/// Provider-reported (or derived) total tokens.
	pub total_tokens:            u64,
	/// Estimated cost, when pricing was available.
	pub cost_usd:                Option<f64>,
	/// Reason pricing was unavailable.
	pub cost_unavailable_reason: Option<Str>,
	/// Error type attributed to this chat.
	pub error_type:              Option<Str>,
}

/// Raw record for one completed tool invocation.
#[derive(Clone, Debug, PartialEq)]
pub struct ToolRecord {
	/// Provider tool-call identifier.
	pub tool_call_id: Str,
	/// Tool name.
	pub tool_name:    Str,
	/// Terminal tool status.
	pub status:       ToolStatus,
	/// Elapsed wall-clock time in milliseconds.
	pub latency_ms:   f64,
	/// Error type attributed to this call.
	pub error_type:   Option<Str>,
}

/// Per-tool counters included in a run summary.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ToolCounters {
	/// All calls.
	pub total:            u64,
	/// Successful calls.
	pub ok:               u64,
	/// Failed calls.
	pub error:            u64,
	/// Skipped calls.
	pub skipped:          u64,
	/// Blocked calls.
	pub blocked:          u64,
	/// Timed-out calls.
	pub timeout:          u64,
	/// Aborted calls.
	pub aborted:          u64,
	/// Sum of call latency in milliseconds.
	pub total_latency_ms: f64,
}

/// Chat portion of a run summary.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ChatSummary {
	/// Number of chat calls.
	pub total:            u64,
	/// Calls bucketed by raw stop reason, with sorted keys.
	pub by_stop_reason:   BTreeMap<Str, u64>,
	/// Sum of chat latency in milliseconds.
	pub total_latency_ms: f64,
}

/// Tool portion of a run summary.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ToolSummary {
	/// All calls.
	pub total:            u64,
	/// Successful calls.
	pub ok:               u64,
	/// Failed calls.
	pub error:            u64,
	/// Skipped calls.
	pub skipped:          u64,
	/// Blocked calls.
	pub blocked:          u64,
	/// Timed-out calls.
	pub timeout:          u64,
	/// Aborted calls.
	pub aborted:          u64,
	/// Sum of tool latency in milliseconds.
	pub total_latency_ms: f64,
	/// Counters bucketed by tool name, with sorted keys.
	pub by_name:          BTreeMap<Str, ToolCounters>,
}

/// Token usage accumulated over a run.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Usage {
	/// Total cost-bearing input tokens.
	pub input:            u64,
	/// Output tokens.
	pub output:           u64,
	/// Cache-read input tokens.
	pub cached_input:     u64,
	/// Cache-write input tokens.
	pub cache_write:      u64,
	/// Reasoning output tokens.
	pub reasoning_output: u64,
	/// Total tokens.
	pub total:            u64,
}

/// Projects full provider usage into the six metrics buckets without
/// allocating or discarding the source record.
impl From<&InferenceUsage> for Usage {
	fn from(value: &InferenceUsage) -> Self {
		let input = value
			.input_tokens
			.saturating_add(value.cache_read_tokens)
			.saturating_add(value.cache_write_tokens);
		Self {
			input,
			output: value.output_tokens,
			cached_input: value.cache_read_tokens,
			cache_write: value.cache_write_tokens,
			reasoning_output: value.reasoning_tokens.unwrap_or_default(),
			total: value
				.total_tokens
				.unwrap_or_else(|| input.saturating_add(value.output_tokens)),
		}
	}
}

/// Cost portion of a run summary.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct CostSummary {
	/// Sum of all available chat cost estimates.
	pub estimated_usd:       f64,
	/// Sorted, deduplicated reasons that estimates were unavailable.
	pub unavailable_reasons: Vec<Str>,
}

/// Error portion of a run summary.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ErrorSummary {
	/// Total chat and tool errors.
	pub total:   u64,
	/// Errors bucketed by type, with sorted keys.
	pub by_type: BTreeMap<Str, u64>,
}

/// Stable, persistence-safe rollup of one agent invocation.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct RunSummary {
	/// Chat rollup.
	pub chats:      ChatSummary,
	/// Tool rollup.
	pub tools:      ToolSummary,
	/// Token rollup.
	pub usage:      Usage,
	/// Cost rollup.
	pub cost:       CostSummary,
	/// Error rollup.
	pub errors:     ErrorSummary,
	/// Number of agent-loop steps completed.
	pub step_count: u64,
}

/// Registered-versus-used coverage for one invocation.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RunCoverage {
	/// Sorted, deduplicated tool names exposed to the model.
	pub tools_available: Vec<Str>,
	/// Sorted, deduplicated tool names requested by the model.
	pub tools_invoked:   Vec<Str>,
	/// Available tools never requested by the model.
	pub tools_unused:    Vec<Str>,
	/// Sorted, deduplicated model identifiers used.
	pub models_used:     Vec<Str>,
	/// Sorted, deduplicated provider identifiers used.
	pub providers_used:  Vec<Str>,
}

/// Data supplied when a chat completes successfully.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ChatOutcome {
	/// Model identifier from the finalized assistant message.
	pub model:                   Str,
	/// Provider identifier from the finalized assistant message.
	pub provider:                Str,
	/// Raw stop reason.
	pub stop_reason:             Option<Str>,
	/// Input tokens excluding cache-read and cache-write buckets.
	pub input_tokens:            u64,
	/// Output tokens.
	pub output_tokens:           u64,
	/// Cache-read tokens.
	pub cached_input_tokens:     u64,
	/// Cache-write tokens.
	pub cache_write_tokens:      u64,
	/// Reasoning output tokens.
	pub reasoning_output_tokens: u64,
	/// Provider total; when absent it is derived as input plus output.
	pub total_tokens:            Option<u64>,
	/// Estimated USD cost.
	pub cost_usd:                Option<f64>,
	/// Reason cost could not be estimated.
	pub cost_unavailable_reason: Option<Str>,
}

#[derive(Clone, Debug)]
struct ChatStart {
	started_at_ms: f64,
	model:         Str,
	provider:      Str,
}

#[derive(Clone, Debug)]
struct ToolStart {
	tool_name:     Str,
	started_at_ms: f64,
}

/// Per-invocation event buffer.
#[derive(Debug, Default)]
pub struct RunCollector {
	chats:           Vec<ChatRecord>,
	tools:           Vec<ToolRecord>,
	available_tools: BTreeSet<Str>,
	invoked_tools:   BTreeSet<Str>,
	models_used:     BTreeSet<Str>,
	providers_used:  BTreeSet<Str>,
	chat_starts:     FastHashMap<i64, ChatStart>,
	tool_starts:     FastHashMap<Str, ToolStart>,
	run_ended:       bool,
}

impl RunCollector {
	/// Creates an empty collector.
	pub fn new() -> Self {
		Self::default()
	}

	/// Returns whether the run-end transition has already fired.
	pub const fn run_ended(&self) -> bool {
		self.run_ended
	}

	/// Marks the run ended, returning `true` only for the first call.
	pub const fn mark_run_ended(&mut self) -> bool {
		if self.run_ended {
			return false;
		}
		self.run_ended = true;
		true
	}

	/// Records tool names exposed on a chat step.
	pub fn note_available_tools<I, S>(&mut self, tools: I)
	where
		I: IntoIterator<Item = S>,
		S: Into<Str>,
	{
		self
			.available_tools
			.extend(tools.into_iter().map(Into::into));
	}

	/// Starts tracking one chat by step number.
	pub fn begin_chat(
		&mut self,
		step_number: i64,
		model: impl Into<Str>,
		provider: impl Into<Str>,
		started_at_ms: f64,
	) {
		let model = model.into();
		let provider = provider.into();
		self.models_used.insert(model.clone());
		if !provider.is_empty() {
			self.providers_used.insert(provider.clone());
		}
		self
			.chat_starts
			.insert(step_number, ChatStart { started_at_ms, model, provider });
	}

	/// Completes a chat; a missing start still emits a zero-latency record.
	pub fn end_chat(&mut self, step_number: i64, ended_at_ms: f64, outcome: ChatOutcome) {
		let start = self.chat_starts.remove(&step_number);
		let input_tokens =
			outcome.input_tokens + outcome.cached_input_tokens + outcome.cache_write_tokens;
		let total_tokens = outcome
			.total_tokens
			.unwrap_or(input_tokens + outcome.output_tokens);
		let stop_reason = outcome.stop_reason;
		let error_type = stop_reason
			.as_ref()
			.filter(|reason| reason.as_str() == "error" || reason.as_str() == "aborted")
			.cloned();
		self.chats.push(ChatRecord {
			step_number: start.as_ref().map_or(-1, |_| step_number),
			model: start
				.as_ref()
				.map_or_else(|| outcome.model.clone(), |value| value.model.clone()),
			provider: start
				.as_ref()
				.map_or_else(|| outcome.provider.clone(), |value| value.provider.clone()),
			stop_reason,
			latency_ms: start
				.as_ref()
				.map_or(0.0, |value| (ended_at_ms - value.started_at_ms).max(0.0)),
			input_tokens,
			output_tokens: outcome.output_tokens,
			cached_input_tokens: outcome.cached_input_tokens,
			cache_write_tokens: outcome.cache_write_tokens,
			reasoning_output_tokens: outcome.reasoning_output_tokens,
			total_tokens,
			cost_usd: outcome.cost_usd,
			cost_unavailable_reason: outcome.cost_unavailable_reason,
			error_type,
		});
	}

	/// Completes an unfinalized chat as an error.
	pub fn fail_chat(&mut self, step_number: i64, ended_at_ms: f64, error_type: impl Into<Str>) {
		let start = self.chat_starts.remove(&step_number);
		self.chats.push(ChatRecord {
			step_number:             start.as_ref().map_or(-1, |_| step_number),
			model:                   start
				.as_ref()
				.map_or_else(Str::default, |value| value.model.clone()),
			provider:                start
				.as_ref()
				.map_or_else(Str::default, |value| value.provider.clone()),
			stop_reason:             Some(Str::new("error")),
			latency_ms:              start
				.as_ref()
				.map_or(0.0, |value| (ended_at_ms - value.started_at_ms).max(0.0)),
			input_tokens:            0,
			output_tokens:           0,
			cached_input_tokens:     0,
			cache_write_tokens:      0,
			reasoning_output_tokens: 0,
			total_tokens:            0,
			cost_usd:                None,
			cost_unavailable_reason: None,
			error_type:              Some(error_type.into()),
		});
	}

	/// Starts tracking one tool call by its call identifier.
	pub fn begin_tool(
		&mut self,
		tool_call_id: impl Into<Str>,
		tool_name: impl Into<Str>,
		started_at_ms: f64,
	) {
		let tool_call_id = tool_call_id.into();
		let tool_name = tool_name.into();
		self.invoked_tools.insert(tool_name.clone());
		self
			.tool_starts
			.insert(tool_call_id, ToolStart { tool_name, started_at_ms });
	}

	/// Completes a tool; a missing start still emits a zero-latency record.
	pub fn end_tool(
		&mut self,
		tool_call_id: impl Into<Str>,
		ended_at_ms: f64,
		status: ToolStatus,
		error_type: Option<Str>,
	) {
		let tool_call_id = tool_call_id.into();
		let start = self.tool_starts.remove(&tool_call_id);
		self.tools.push(ToolRecord {
			tool_call_id,
			tool_name: start
				.as_ref()
				.map_or_else(Str::default, |value| value.tool_name.clone()),
			status,
			latency_ms: start
				.as_ref()
				.map_or(0.0, |value| (ended_at_ms - value.started_at_ms).max(0.0)),
			error_type,
		});
	}

	/// Records a requested tool that never acquired a tracked start.
	pub fn record_orphan_tool(
		&mut self,
		tool_call_id: impl Into<Str>,
		tool_name: impl Into<Str>,
		status: ToolStatus,
	) {
		let tool_name = tool_name.into();
		self.invoked_tools.insert(tool_name.clone());
		self.tools.push(ToolRecord {
			tool_call_id: tool_call_id.into(),
			tool_name,
			status,
			latency_ms: 0.0,
			error_type: None,
		});
	}

	/// Builds the current summary and coverage without consuming the collector.
	pub fn snapshot(&self, step_count: u64) -> (RunSummary, RunCoverage) {
		(self.build_summary(step_count), self.build_coverage())
	}

	fn build_summary(&self, step_count: u64) -> RunSummary {
		let mut summary = RunSummary { step_count, ..RunSummary::default() };
		let mut unavailable = BTreeSet::new();
		for chat in &self.chats {
			summary.chats.total += 1;
			summary.chats.total_latency_ms += chat.latency_ms;
			if let Some(reason) = &chat.stop_reason {
				*summary
					.chats
					.by_stop_reason
					.entry(reason.clone())
					.or_default() += 1;
			}
			summary.usage.input += chat.input_tokens;
			summary.usage.output += chat.output_tokens;
			summary.usage.cached_input += chat.cached_input_tokens;
			summary.usage.cache_write += chat.cache_write_tokens;
			summary.usage.reasoning_output += chat.reasoning_output_tokens;
			summary.usage.total += chat.total_tokens;
			summary.cost.estimated_usd += chat.cost_usd.unwrap_or(0.0);
			if let Some(reason) = &chat.cost_unavailable_reason {
				unavailable.insert(reason.clone());
			}
			if let Some(error_type) = &chat.error_type {
				*summary
					.errors
					.by_type
					.entry(error_type.clone())
					.or_default() += 1;
			}
		}
		summary.cost.unavailable_reasons = unavailable.into_iter().collect();
		for tool in &self.tools {
			summary.tools.total += 1;
			summary.tools.total_latency_ms += tool.latency_ms;
			increment_status(&mut summary.tools, tool.status);
			let counters = summary
				.tools
				.by_name
				.entry(tool.tool_name.clone())
				.or_default();
			counters.total += 1;
			counters.total_latency_ms += tool.latency_ms;
			increment_tool_status(counters, tool.status);
			if let Some(error_type) = &tool.error_type {
				*summary
					.errors
					.by_type
					.entry(error_type.clone())
					.or_default() += 1;
			}
		}
		summary.errors.total = summary.errors.by_type.values().sum();
		summary
	}

	fn build_coverage(&self) -> RunCoverage {
		RunCoverage {
			tools_available: self.available_tools.iter().cloned().collect(),
			tools_invoked:   self.invoked_tools.iter().cloned().collect(),
			tools_unused:    self
				.available_tools
				.difference(&self.invoked_tools)
				.cloned()
				.collect(),
			models_used:     self.models_used.iter().cloned().collect(),
			providers_used:  self.providers_used.iter().cloned().collect(),
		}
	}
}

const fn increment_status(summary: &mut ToolSummary, status: ToolStatus) {
	match status {
		ToolStatus::Ok => summary.ok += 1,
		ToolStatus::Error => summary.error += 1,
		ToolStatus::Skipped => summary.skipped += 1,
		ToolStatus::Blocked => summary.blocked += 1,
		ToolStatus::Timeout => summary.timeout += 1,
		ToolStatus::Aborted => summary.aborted += 1,
	}
}

const fn increment_tool_status(counters: &mut ToolCounters, status: ToolStatus) {
	match status {
		ToolStatus::Ok => counters.ok += 1,
		ToolStatus::Error => counters.error += 1,
		ToolStatus::Skipped => counters.skipped += 1,
		ToolStatus::Blocked => counters.blocked += 1,
		ToolStatus::Timeout => counters.timeout += 1,
		ToolStatus::Aborted => counters.aborted += 1,
	}
}

/// Sums multiple run summaries, merging keyed maps and sorting set-like output.
pub fn aggregate_summaries(summaries: &[RunSummary]) -> RunSummary {
	let mut out = RunSummary::default();
	let mut unavailable = BTreeSet::new();
	for summary in summaries {
		out.chats.total += summary.chats.total;
		out.chats.total_latency_ms += summary.chats.total_latency_ms;
		merge_counts(&mut out.chats.by_stop_reason, &summary.chats.by_stop_reason);
		out.tools.total += summary.tools.total;
		out.tools.ok += summary.tools.ok;
		out.tools.error += summary.tools.error;
		out.tools.skipped += summary.tools.skipped;
		out.tools.blocked += summary.tools.blocked;
		out.tools.timeout += summary.tools.timeout;
		out.tools.aborted += summary.tools.aborted;
		out.tools.total_latency_ms += summary.tools.total_latency_ms;
		for (name, counters) in &summary.tools.by_name {
			let target = out.tools.by_name.entry(name.clone()).or_default();
			target.total += counters.total;
			target.ok += counters.ok;
			target.error += counters.error;
			target.skipped += counters.skipped;
			target.blocked += counters.blocked;
			target.timeout += counters.timeout;
			target.aborted += counters.aborted;
			target.total_latency_ms += counters.total_latency_ms;
		}
		out.usage.input += summary.usage.input;
		out.usage.output += summary.usage.output;
		out.usage.cached_input += summary.usage.cached_input;
		out.usage.cache_write += summary.usage.cache_write;
		out.usage.reasoning_output += summary.usage.reasoning_output;
		out.usage.total += summary.usage.total;
		out.cost.estimated_usd += summary.cost.estimated_usd;
		unavailable.extend(summary.cost.unavailable_reasons.iter().cloned());
		out.errors.total += summary.errors.total;
		merge_counts(&mut out.errors.by_type, &summary.errors.by_type);
		out.step_count += summary.step_count;
	}
	out.cost.unavailable_reasons = unavailable.into_iter().collect();
	out
}

fn merge_counts(target: &mut BTreeMap<Str, u64>, source: &BTreeMap<Str, u64>) {
	for (key, value) in source {
		*target.entry(key.clone()).or_default() += value;
	}
}

/// Union-merges coverage values and re-derives unused tools.
pub fn aggregate_coverage(coverages: &[RunCoverage]) -> RunCoverage {
	let mut available = BTreeSet::new();
	let mut invoked = BTreeSet::new();
	let mut models = BTreeSet::new();
	let mut providers = BTreeSet::new();
	for coverage in coverages {
		available.extend(coverage.tools_available.iter().cloned());
		invoked.extend(coverage.tools_invoked.iter().cloned());
		models.extend(coverage.models_used.iter().cloned());
		providers.extend(coverage.providers_used.iter().cloned());
	}
	RunCoverage {
		tools_available: available.iter().cloned().collect(),
		tools_invoked:   invoked.iter().cloned().collect(),
		tools_unused:    available.difference(&invoked).cloned().collect(),
		models_used:     models.into_iter().collect(),
		providers_used:  providers.into_iter().collect(),
	}
}

/// Per-million-token model rates used by [`calculate_cost`].
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct CostRates {
	/// Base input rate.
	pub input:       f64,
	/// Output rate.
	pub output:      f64,
	/// Cache-read rate.
	pub cache_read:  f64,
	/// Five-minute cache-write rate (1.25x input for Anthropic models).
	pub cache_write: f64,
}

/// Optional provider-reported cache-write TTL breakdown.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct CacheTtlUsage {
	/// Five-minute ephemeral writes.
	pub ephemeral_5m: Option<f64>,
	/// One-hour ephemeral writes, billed at 2x base input by Anthropic.
	pub ephemeral_1h: Option<f64>,
}

/// Optional orchestration tokens included in billed input/output/read buckets.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct OrchestrationUsage {
	/// Additional input tokens.
	pub input:      f64,
	/// Additional output tokens.
	pub output:     f64,
	/// Additional cache-read tokens.
	pub cache_read: f64,
}

/// Token quantities accepted by [`calculate_cost`].
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct CostUsage {
	/// Input tokens.
	pub input:         f64,
	/// Output tokens.
	pub output:        f64,
	/// Cache-read tokens.
	pub cache_read:    f64,
	/// Cache-write tokens.
	pub cache_write:   f64,
	/// Optional orchestration usage.
	pub orchestration: Option<OrchestrationUsage>,
	/// Optional cache TTL breakdown.
	pub cttl:          Option<CacheTtlUsage>,
}

/// Per-bucket calculated USD cost.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct CalculatedCost {
	/// Input cost.
	pub input:       f64,
	/// Output cost.
	pub output:      f64,
	/// Cache-read cost.
	pub cache_read:  f64,
	/// Cache-write cost.
	pub cache_write: f64,
	/// Sum of every bucket.
	pub total:       f64,
}

/// Calculates per-bucket cost without rounding.
pub fn calculate_cost(rates: CostRates, usage: CostUsage) -> CalculatedCost {
	let orchestration = usage.orchestration.unwrap_or_default();
	let input = rates.input / 1_000_000.0 * (usage.input + orchestration.input);
	let output = rates.output / 1_000_000.0 * (usage.output + orchestration.output);
	let cache_read = rates.cache_read / 1_000_000.0 * (usage.cache_read + orchestration.cache_read);
	let cache_write = cache_write_cost(rates, usage);
	CalculatedCost {
		input,
		output,
		cache_read,
		cache_write,
		total: input + output + cache_read + cache_write,
	}
}

/// Prices cache writes according to the configured TTL policy.
///
/// It uses the flat 5m rate without TTL detail; otherwise it charges 5m plus
/// residual at the stored rate and 1h at twice the base input rate. The stored
/// 5m rate represents Anthropic's 1.25x provider semantics.
pub fn cache_write_cost(rates: CostRates, usage: CostUsage) -> f64 {
	let rate_5m = rates.cache_write / 1_000_000.0;
	let Some(cttl) = usage.cttl else {
		return rate_5m * usage.cache_write;
	};
	let five_minute = cttl.ephemeral_5m.unwrap_or(0.0);
	let one_hour = cttl.ephemeral_1h.unwrap_or(0.0);
	let residual = (usage.cache_write - five_minute - one_hour).max(0.0);
	(rates.input * 2.0 / 1_000_000.0).mul_add(one_hour, rate_5m * (five_minute + residual))
}

#[cfg(test)]
mod tests {
	use super::*;

	fn s(value: &str) -> Str {
		Str::new(value)
	}

	#[test]
	fn cache_write_cost_without_ttl_uses_flat_rate() {
		let rates = CostRates { input: 10.0, cache_write: 12.5, ..CostRates::default() };
		let usage = CostUsage { cache_write: 2_000_000.0, ..CostUsage::default() };
		assert_eq!(cache_write_cost(rates, usage), 25.0);
	}
	#[test]
	fn inference_usage_projection_includes_cached_input_in_input_and_fallback_total() {
		let source = InferenceUsage {
			input_tokens: 10,
			output_tokens: 7,
			cache_read_tokens: 20,
			cache_write_tokens: 30,
			total_tokens: None,
			..InferenceUsage::default()
		};
		assert_eq!(Usage::from(&source), Usage {
			input: 60,
			output: 7,
			cached_input: 20,
			cache_write: 30,
			total: 67,
			..Usage::default()
		});

		let saturated = InferenceUsage {
			input_tokens: u64::MAX,
			output_tokens: 1,
			cache_read_tokens: 1,
			total_tokens: None,
			..InferenceUsage::default()
		};
		assert_eq!(Usage::from(&saturated).input, u64::MAX);
		assert_eq!(Usage::from(&saturated).total, u64::MAX);
	}

	#[test]
	fn calculate_cost_includes_orchestration_without_rounding() {
		let rates =
			CostRates { input: 2.0, output: 3.0, cache_read: 4.0, cache_write: 5.0 };
		let usage = CostUsage {
			input:         1_000_000.0,
			output:        1_000_000.0,
			cache_read:    1_000_000.0,
			cache_write:   2_000_000.0,
			orchestration: Some(OrchestrationUsage {
				input:      1_000_000.0,
				output:     1_000_000.0,
				cache_read: 1_000_000.0,
			}),
			cttl:          None,
		};
		assert_eq!(calculate_cost(rates, usage), CalculatedCost {
			input:       4.0,
			output:      6.0,
			cache_read:  8.0,
			cache_write: 10.0,
			total:       28.0,
		},);
	}

	#[test]
	fn cache_write_cost_with_ttl_prices_residual_and_one_hour_separately() {
		let rates = CostRates { input: 10.0, cache_write: 12.5, ..CostRates::default() };
		let usage = CostUsage {
			cache_write: 1_000_000.0,
			cttl: Some(CacheTtlUsage { ephemeral_5m: Some(200_000.0), ephemeral_1h: Some(300_000.0) }),
			..CostUsage::default()
		};
		assert_eq!(cache_write_cost(rates, usage), 14.75);
	}

	#[test]
	fn cache_write_cost_clamps_negative_residual() {
		let rates = CostRates { input: 10.0, cache_write: 12.5, ..CostRates::default() };
		let usage = CostUsage {
			cache_write: 100.0,
			cttl: Some(CacheTtlUsage { ephemeral_5m: Some(80.0), ephemeral_1h: Some(40.0) }),
			..CostUsage::default()
		};
		assert!((cache_write_cost(rates, usage) - 0.0018).abs() < f64::EPSILON);
	}

	#[test]
	fn summary_aggregation_sums_and_sorts_maps() {
		let mut a = RunSummary::default();
		a.chats.total = 1;
		a.chats.by_stop_reason.insert(s("stop"), 1);
		a.tools.total = 1;
		a.tools.ok = 1;
		a.tools.by_name.insert(s("zeta"), ToolCounters {
			total: 1,
			ok: 1,
			..ToolCounters::default()
		});
		a.usage.input = 2;
		a.cost.estimated_usd = 0.25;
		a.errors.by_type.insert(s("z-error"), 1);
		a.errors.total = 1;
		a.step_count = 2;
		let mut b = a.clone();
		b.chats.by_stop_reason.clear();
		b.chats.by_stop_reason.insert(s("error"), 1);
		b.tools.by_name.clear();
		b.tools.by_name.insert(s("alpha"), ToolCounters {
			total: 1,
			ok: 1,
			..ToolCounters::default()
		});
		b.errors.by_type.clear();
		b.errors.by_type.insert(s("a-error"), 1);
		let merged = aggregate_summaries(&[a, b]);
		assert_eq!(merged.chats.total, 2);
		assert_eq!(merged.usage.input, 4);
		assert_eq!(merged.cost.estimated_usd, 0.5);
		assert_eq!(merged.step_count, 4);
		assert_eq!(
			merged
				.chats
				.by_stop_reason
				.keys()
				.cloned()
				.collect::<Vec<_>>(),
			vec![s("error"), s("stop")]
		);
		assert_eq!(merged.tools.by_name.keys().cloned().collect::<Vec<_>>(), vec![
			s("alpha"),
			s("zeta")
		]);
		assert_eq!(merged.errors.by_type.keys().cloned().collect::<Vec<_>>(), vec![
			s("a-error"),
			s("z-error")
		]);
	}

	#[test]
	fn coverage_derives_sorted_unused_tools() {
		let coverage = aggregate_coverage(&[
			RunCoverage {
				tools_available: vec![s("z"), s("a")],
				tools_invoked: vec![s("a")],
				..RunCoverage::default()
			},
			RunCoverage {
				tools_available: vec![s("b")],
				tools_invoked: vec![s("external")],
				..RunCoverage::default()
			},
		]);
		assert_eq!(coverage.tools_available, vec![s("a"), s("b"), s("z")]);
		assert_eq!(coverage.tools_invoked, vec![s("a"), s("external")]);
		assert_eq!(coverage.tools_unused, vec![s("b"), s("z")]);
	}

	#[test]
	fn collector_produces_complete_summary_and_coverage() {
		let mut collector = RunCollector::new();
		collector.note_available_tools(["read", "write"]);
		collector.begin_chat(3, "model-b", "provider-a", 10.0);
		collector.end_chat(3, 35.0, ChatOutcome {
			model:                   s("response-model"),
			provider:                s("response-provider"),
			stop_reason:             Some(s("error")),
			input_tokens:            10,
			output_tokens:           4,
			cached_input_tokens:     2,
			cache_write_tokens:      3,
			reasoning_output_tokens: 1,
			total_tokens:            Some(19),
			cost_usd:                Some(0.5),
			cost_unavailable_reason: Some(s("missing-secondary-price")),
		});
		collector.begin_tool("call-1", "read", 40.0);
		collector.end_tool("call-1", 48.0, ToolStatus::Ok, None);
		collector.record_orphan_tool("call-2", "undeclared", ToolStatus::Skipped);
		assert!(collector.mark_run_ended());
		assert!(!collector.mark_run_ended());
		let (summary, coverage) = collector.snapshot(4);
		assert_eq!(summary.chats.total, 1);
		assert_eq!(summary.chats.total_latency_ms, 25.0);
		assert_eq!(summary.chats.by_stop_reason.get("error"), Some(&1));
		assert_eq!(summary.usage, Usage {
			input:            15,
			output:           4,
			cached_input:     2,
			cache_write:      3,
			reasoning_output: 1,
			total:            19,
		});
		assert_eq!(summary.cost, CostSummary {
			estimated_usd:       0.5,
			unavailable_reasons: vec![s("missing-secondary-price")],
		});
		assert_eq!(summary.tools.total, 2);
		assert_eq!(summary.tools.ok, 1);
		assert_eq!(summary.tools.skipped, 1);
		assert_eq!(summary.tools.total_latency_ms, 8.0);
		assert_eq!(summary.errors.by_type.get("error"), Some(&1));
		assert_eq!(summary.step_count, 4);
		assert_eq!(coverage.tools_available, vec![s("read"), s("write")]);
		assert_eq!(coverage.tools_invoked, vec![s("read"), s("undeclared")]);
		assert_eq!(coverage.tools_unused, vec![s("write")]);
		assert_eq!(coverage.models_used, vec![s("model-b")]);
		assert_eq!(coverage.providers_used, vec![s("provider-a")]);
	}
}
