//! Non-interactive historical usage statistics over durable session journals.
//!
//! This is the CLI adapter for the same journal fold and rebuildable SQLite
//! index that powers chat's `/stats` panel. The journal remains authoritative;
//! invoking the command synchronizes changed `.oms` files before projecting a
//! human or JSON report.

use std::{env, fs};

use miette::IntoDiagnostic as _;
use omp_chat::overlays::services::{StatsGroup, StatsReport, StatsTool};
use serde_json::{Value, json};

use crate::cli::StatsArgs;

/// Synchronizes stored journals and prints one historical usage report.
pub fn run(StatsArgs { json: emit_json, .. }: StatsArgs) -> miette::Result<()> {
	let data_dir = omp_core::dirs::data_dir(None).into_diagnostic()?;
	fs::create_dir_all(&data_dir).into_diagnostic()?;
	let project = env::current_dir().into_diagnostic()?;
	let sessions_dir = omp_env::project_state::directory(&data_dir, &project)
		.into_diagnostic()?
		.join("sessions");
	let report = crate::chat_services::stats::sync(&data_dir, &sessions_dir).into_diagnostic()?;

	if emit_json {
		println!("{}", serde_json::to_string_pretty(&report_json(&report)).into_diagnostic()?);
	} else {
		let summary = omp_chat::overlays::stats::stats_report(&report);
		// The shared projection uses Markdown emphasis inside the chat panel;
		// stdout is plain text; terminal emphasis belongs only on a TTY.
		print!("{}", summary.as_str().replace("**", ""));
	}
	Ok(())
}

fn report_json(report: &StatsReport) -> Value {
	json!({
		"sync": {
			"processed": report.synced,
			"files": report.files,
		},
		"overall": {
			"totalRequests": report.requests,
			"successfulRequests": report.requests.saturating_sub(report.errors),
			"failedRequests": report.errors,
			"errorRate": ratio(report.errors, report.requests),
			"totalInputTokens": report.input_tokens,
			"totalOutputTokens": report.output_tokens,
			"totalCacheReadTokens": report.cache_read,
			"totalCacheWriteTokens": report.cache_write,
			"cacheRate": ratio(
				report.cache_read,
				report.input_tokens.saturating_add(report.cache_read),
			),
			"totalCost": dollars(report.cost_nano_usd),
			"costNanoUsd": report.cost_nano_usd,
			"unpricedRequests": report.unpriced,
			"avgDuration": report.avg_duration_ms,
			"avgTtft": report.avg_ttft_ms,
			"avgTokensPerSecond": report.tokens_per_second,
		},
		"byModel": report
			.by_model
			.iter()
			.map(|group| group_json("model", group))
			.collect::<Vec<_>>(),
		"byFolder": report
			.by_folder
			.iter()
			.map(|group| group_json("folder", group))
			.collect::<Vec<_>>(),
		"tools": report.tools.iter().map(tool_json).collect::<Vec<_>>(),
	})
}

fn group_json(label: &'static str, group: &StatsGroup) -> Value {
	let mut value = json!({
		"totalRequests": group.requests,
		"totalInputTokens": group.input_tokens,
		"totalOutputTokens": group.output_tokens,
		"totalCacheReadTokens": group.cache_read,
		"totalCacheWriteTokens": group.cache_write,
		"cacheRate": ratio(
			group.cache_read,
			group.input_tokens.saturating_add(group.cache_read),
		),
		"totalCost": dollars(group.cost_nano_usd),
		"costNanoUsd": group.cost_nano_usd,
		"unpricedRequests": group.unpriced,
	});
	value[label] = Value::String(group.key.to_string());
	value
}

fn tool_json(tool: &StatsTool) -> Value {
	json!({
		"tool": tool.tool.as_str(),
		"calls": tool.calls,
		"errors": tool.errors,
	})
}

fn ratio(numerator: u64, denominator: u64) -> f64 {
	if denominator == 0 {
		0.0
	} else {
		numerator as f64 / denominator as f64
	}
}

fn dollars(nano_usd: u64) -> f64 {
	nano_usd as f64 / 1_000_000_000.0
}

#[cfg(test)]
mod tests {
	use omp_core::Str;

	use super::*;

	#[test]
	fn json_projection_keeps_aggregate_precision_and_group_identity() {
		let report = StatsReport {
			synced:            2,
			files:             3,
			requests:          4,
			errors:            1,
			input_tokens:      300,
			output_tokens:     100,
			cache_read:        100,
			cache_write:       20,
			cost_nano_usd:     1_250_000_000,
			unpriced:          1,
			avg_duration_ms:   Some(900),
			avg_ttft_ms:       Some(120),
			tokens_per_second: Some(42.5),
			by_model:          vec![StatsGroup {
				key:           Str::new_static("anthropic/claude"),
				requests:      4,
				cost_nano_usd: 1_250_000_000,
				unpriced:      1,
				input_tokens:  300,
				output_tokens: 100,
				cache_read:    100,
				cache_write:   20,
			}],
			by_folder:         Vec::new(),
			tools:             vec![StatsTool {
				tool:   Str::new_static("read"),
				calls:  2,
				errors: 1,
			}],
		};

		let value = report_json(&report);
		assert_eq!(value["sync"]["processed"], 2);
		assert_eq!(value["overall"]["errorRate"], 0.25);
		assert_eq!(value["overall"]["cacheRate"], 0.25);
		assert_eq!(value["overall"]["costNanoUsd"], 1_250_000_000_u64);
		assert_eq!(value["byModel"][0]["model"], "anthropic/claude");
		assert_eq!(value["tools"][0]["errors"], 1);
	}
}
