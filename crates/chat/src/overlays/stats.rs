//! Pure report builders behind `/stats` and `/trace`: markdown for a
//! [`ReportPanel`](super::report::ReportPanel).
//!
//! `/stats` renders the application's usage index as an Overall, By Model,
//! and By Folder summary. `/trace` renders the last turn as a dashboard
//! summary (wall / model /
//! tool / idle time, one span per request and tool call, tool aggregates)
//! from the replica alone — every element's `id`/`order` ULIDs carry the
//! journal's own timestamps — interleaved with the kernel notifications
//! the journal never sees (retries, readiness).

use std::fmt::Write as _;

use omp_core::{Str, sf};
use omp_dom::{Dom, Handle, KnownTag, Node, PropId, PropKey, Tag, Value};
use omp_journal::EntryId;

use super::services::{StatsGroup, StatsReport, TraceEvent};

/// Rows shown per `/stats` grouping.
pub const STATS_GROUP_LIMIT: usize = 10;

/// `/stats` markdown.
#[must_use]
pub fn stats_report(report: &StatsReport) -> Str {
	let mut out = String::with_capacity(1024);
	let _ = writeln!(
		out,
		"Synced {} changed journal{} ({} total)\n",
		report.synced,
		plural(report.synced),
		report.files
	);
	out.push_str("**Overall**\n\n");
	let _ =
		writeln!(out, "- Requests: {} ({} errors)", number(report.requests), number(report.errors));
	let _ = writeln!(out, "- Error Rate: {}", percent(report.errors, report.requests));
	let _ = writeln!(
		out,
		"- Total Tokens: {}",
		number(report.input_tokens.saturating_add(report.output_tokens))
	);
	let _ = writeln!(out, "- Input Tokens: {}", number(report.input_tokens));
	let _ = writeln!(out, "- Output Tokens: {}", number(report.output_tokens));
	let _ = writeln!(
		out,
		"- Cache Rate: {}",
		percent(report.cache_read, report.input_tokens.saturating_add(report.cache_read))
	);
	let _ =
		writeln!(out, "- API-equivalent estimate: {}", cost(report.cost_nano_usd, report.unpriced));
	let _ = writeln!(
		out,
		"- Avg Duration: {}",
		report
			.avg_duration_ms
			.map_or_else(|| "-".to_owned(), duration)
	);
	let _ =
		writeln!(out, "- Avg TTFT: {}", report.avg_ttft_ms.map_or_else(|| "-".to_owned(), duration));
	if let Some(tps) = report.tokens_per_second {
		let _ = writeln!(out, "- Avg Tokens/s: {tps:.1}");
	}
	if !report.by_model.is_empty() {
		out.push_str("\n**By Model (API-equivalent estimates)**\n\n");
		for group in report.by_model.iter().take(STATS_GROUP_LIMIT) {
			let _ = writeln!(
				out,
				"- {}: {} reqs, {}, {} cache rate",
				group.key,
				number(group.requests),
				cost(group.cost_nano_usd, group.unpriced),
				group_cache_rate(group)
			);
		}
	}
	if !report.by_folder.is_empty() {
		out.push_str("\n**By Folder (API-equivalent estimates)**\n\n");
		for group in report.by_folder.iter().take(STATS_GROUP_LIMIT) {
			let _ = writeln!(
				out,
				"- {}: {} reqs, {}",
				group.key,
				number(group.requests),
				cost(group.cost_nano_usd, group.unpriced)
			);
		}
	}
	if !report.tools.is_empty() {
		out.push_str("\n**Tools**\n\n");
		for tool in &report.tools {
			let _ = writeln!(
				out,
				"- {}: {} call{}, {} error{}",
				tool.tool,
				number(tool.calls),
				plural(tool.calls),
				number(tool.errors),
				plural(tool.errors)
			);
		}
	}
	Str::from(out)
}

fn group_cache_rate(group: &StatsGroup) -> String {
	percent(group.cache_read, group.input_tokens.saturating_add(group.cache_read))
}

/// One span of the last turn's timeline.
struct Span {
	start_ms: u64,
	end_ms:   Option<u64>,
	kind:     &'static str,
	label:    String,
}

/// `/trace` markdown over the last turn of the replica plus the kernel
/// events that fall inside it. `None` when the body has no turn yet.
#[must_use]
pub fn trace_report(dom: &Dom, events: &[TraceEvent]) -> Option<Str> {
	let turn = dom
		.children(dom.body())
		.iter()
		.copied()
		.rev()
		.find(|handle| tag_is(dom, *handle, KnownTag::Turn))?;
	let node = dom.get(turn)?;
	let ordinal = node
		.prop(&PropKey::from(PropId::Turn))
		.and_then(as_int)
		.unwrap_or(0);
	let turn_start = entry_ms(node, PropId::Id)?;
	let mut spans = Vec::new();
	let mut requests = 0_u64;
	let mut tool_calls = 0_u64;
	let mut tokens = 0_u64;
	let mut cost_nano_usd = 0_u64;
	let mut model_ms = 0_u64;
	let mut tool_ms = 0_u64;
	let mut tools: Vec<(Str, u64, u64, u64, u64)> = Vec::new();
	let mut last_ms = turn_start;
	for child in dom.children(turn).iter().copied() {
		let Some(node) = dom.get(child) else { continue };
		// Kernel-patched notices and asides carry no entry id; they sit at
		// the moment of the previous sibling.
		let start = entry_ms(node, PropId::Id)
			.or_else(|| entry_ms(node, PropId::Cause))
			.unwrap_or(last_ms);
		let end = entry_ms(node, PropId::Order).filter(|end| *end > start);
		if let Some(end) = end {
			last_ms = last_ms.max(end);
		}
		last_ms = last_ms.max(start);
		match &node.tag {
			Tag::Known(KnownTag::User) => {
				spans.push(Span {
					start_ms: start,
					end_ms:   None,
					kind:     "user",
					label:    preview(node.content.as_deref().unwrap_or_default(), 80),
				});
			},
			Tag::Known(KnownTag::Developer) => {
				spans.push(Span {
					start_ms: start,
					end_ms:   None,
					kind:     "steer",
					label:    preview(node.content.as_deref().unwrap_or_default(), 80),
				});
			},
			Tag::Known(KnownTag::Assistant) => {
				requests = requests.saturating_add(1);
				let model = prop_str(node, PropId::Model).unwrap_or("model");
				let stop = prop_str(node, PropId::StopReason).unwrap_or("streaming");
				let text = prop_str(node, PropId::Text).unwrap_or_default();
				if let Some(end) = end {
					model_ms = model_ms.saturating_add(end - start);
				}
				spans.push(Span {
					start_ms: start,
					end_ms:   end,
					kind:     "model",
					label:    sf!("{model} · stop {stop} · {} chars", text.chars().count()).to_string(),
				});
			},
			Tag::Known(KnownTag::Usage) => {
				let tokens_in = prop_int(node, PropId::TokensIn);
				let tokens_out = prop_int(node, PropId::TokensOut);
				tokens = tokens.saturating_add(tokens_in).saturating_add(tokens_out);
				cost_nano_usd = cost_nano_usd.saturating_add(prop_int(node, PropId::CostNanoUsd));
				let mut label = sf!("⤵ {tokens_in} ⤴ {tokens_out}").to_string();
				let ttft = node.prop(&PropKey::from(PropId::TtftMs)).and_then(as_int);
				if let Some(ttft) = ttft {
					let _ = write!(label, " · ttft {}", duration(ttft.unsigned_abs()));
				}
				let took = node
					.prop(&PropKey::from(PropId::DurationMs))
					.and_then(as_int);
				if let Some(took) = took {
					let _ = write!(label, " · {}", duration(took.unsigned_abs()));
				}
				spans.push(Span { start_ms: start, end_ms: None, kind: "usage", label });
			},
			Tag::Known(KnownTag::Notice) => {
				let kind = prop_str(node, PropId::Kind).unwrap_or("notice");
				spans.push(Span {
					start_ms: start,
					end_ms:   None,
					kind:     "notice",
					label:    sf!(
						"{kind}: {}",
						preview(node.content.as_deref().unwrap_or_default(), 80)
					)
					.to_string(),
				});
			},
			Tag::Custom(name) => {
				tool_calls = tool_calls.saturating_add(1);
				let status = prop_str(node, PropId::Status).unwrap_or("running");
				let intent = prop_str(node, PropId::I).map(|intent| preview(intent, 60));
				let took = end.map(|end| end - start);
				if let Some(took) = took {
					tool_ms = tool_ms.saturating_add(took);
				}
				let is_error = status == "error";
				match tools.iter_mut().find(|row| row.0.as_str() == name.as_str()) {
					Some(row) => {
						row.1 = row.1.saturating_add(1);
						row.2 = row.2.saturating_add(u64::from(is_error));
						row.3 = row.3.saturating_add(took.unwrap_or(0));
						row.4 = row.4.max(took.unwrap_or(0));
					},
					None => tools.push((
						name.clone(),
						1,
						u64::from(is_error),
						took.unwrap_or(0),
						took.unwrap_or(0),
					)),
				}
				let mut label = sf!("{name} · {status}").to_string();
				if let Some(intent) = intent {
					let _ = write!(label, " · {intent}");
				}
				spans.push(Span { start_ms: start, end_ms: end, kind: "tool", label });
			},
			_ => {},
		}
	}
	let kernel = events
		.iter()
		.filter(|event| event.at_ms >= turn_start)
		.map(|event| Span {
			start_ms: event.at_ms,
			end_ms:   None,
			kind:     "kernel",
			label:    event.label.to_string(),
		});
	spans.extend(kernel);
	spans.sort_by_key(|span| span.start_ms);
	if let Some(latest) = spans
		.iter()
		.map(|span| span.end_ms.unwrap_or(span.start_ms))
		.max()
	{
		last_ms = last_ms.max(latest);
	}
	let wall_ms = last_ms.saturating_sub(turn_start);
	let idle_ms = wall_ms.saturating_sub(model_ms).saturating_sub(tool_ms);

	let mut out = String::with_capacity(1024);
	let _ = writeln!(out, "**Trace · turn {ordinal}**\n");
	let _ = writeln!(
		out,
		"Wall {} · Model {} · Tools {} · Idle {} · Requests {} · Tool Calls {} · Tokens {} · Cost {}",
		duration(wall_ms),
		duration(model_ms),
		duration(tool_ms),
		duration(idle_ms),
		requests,
		tool_calls,
		number(tokens),
		cost(cost_nano_usd, 0)
	);
	out.push_str("\n**Timeline**\n\n```\n");
	for span in &spans {
		let offset = span.start_ms.saturating_sub(turn_start);
		let took = span
			.end_ms
			.map(|end| sf!(" ({})", duration(end.saturating_sub(span.start_ms))))
			.unwrap_or_default();
		let _ = writeln!(out, "{}  {:<7}{}{took}", clock(offset), span.kind, span.label);
	}
	out.push_str("```\n");
	if !tools.is_empty() {
		out.push_str(
			"\n**Tool Aggregates**\n\n| Tool | Calls | Errors | Total | Avg | Max \
			 |\n|---|---|---|---|---|---|\n",
		);
		for (name, calls, errors, total, max) in &tools {
			let _ = writeln!(
				out,
				"| {name} | {calls} | {errors} | {} | {} | {} |",
				duration(*total),
				duration(total / calls.max(&1)),
				duration(*max)
			);
		}
	}
	Some(Str::from(out))
}

fn tag_is(dom: &Dom, handle: Handle, tag: KnownTag) -> bool {
	dom.get(handle)
		.is_some_and(|node| node.tag == Tag::Known(tag))
}

fn entry_ms(node: &Node, prop: PropId) -> Option<u64> {
	node
		.prop(&PropKey::from(prop))
		.and_then(Value::as_str)
		.and_then(|id| id.parse::<EntryId>().ok())
		.map(|id| id.as_ulid().timestamp_ms())
}

fn prop_str(node: &Node, prop: PropId) -> Option<&str> {
	node.prop(&PropKey::from(prop)).and_then(Value::as_str)
}

fn prop_int(node: &Node, prop: PropId) -> u64 {
	node
		.prop(&PropKey::from(prop))
		.and_then(as_int)
		.map_or(0, i64::unsigned_abs)
}

fn as_int(value: &Value) -> Option<i64> {
	match value {
		Value::Int(value) => Some(*value),
		_ => None,
	}
}

fn preview(text: &str, max: usize) -> String {
	let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
	let mut out = flat.chars().take(max).collect::<String>();
	if flat.chars().count() > max {
		out.push('…');
	}
	out
}

/// `mm:ss.mmm` offset into the turn.
fn clock(offset_ms: u64) -> String {
	let seconds = offset_ms / 1000;
	format!("{:02}:{:02}.{:03}", seconds / 60, seconds % 60, offset_ms % 1000)
}

fn plural(count: u64) -> &'static str {
	if count == 1 { "" } else { "s" }
}

/// Thousands-grouped integer.
fn number(value: u64) -> String {
	let digits = value.to_string();
	let mut out = String::with_capacity(digits.len() + digits.len() / 3);
	for (index, ch) in digits.chars().enumerate() {
		if index > 0 && (digits.len() - index) % 3 == 0 {
			out.push(',');
		}
		out.push(ch);
	}
	out
}

fn percent(part: u64, whole: u64) -> String {
	if whole == 0 {
		return "0.0%".to_owned();
	}
	#[expect(clippy::cast_precision_loss, reason = "display precision suffices")]
	let ratio = part as f64 / whole as f64;
	format!("{:.1}%", ratio * 100.0)
}

/// Formats cost as `N/A` when nothing was priced, with more decimals for tiny
/// amounts.
fn cost(nano_usd: u64, unpriced: u64) -> String {
	if nano_usd == 0 && unpriced > 0 {
		return "N/A".to_owned();
	}
	#[expect(clippy::cast_precision_loss, reason = "display precision suffices")]
	let dollars = nano_usd as f64 / 1_000_000_000.0;
	let text = if dollars < 0.01 {
		format!("${dollars:.4}")
	} else if dollars < 1.0 {
		format!("${dollars:.3}")
	} else {
		format!("${dollars:.2}")
	};
	if unpriced > 0 {
		format!("{text} ({unpriced} unpriced)")
	} else {
		text
	}
}

/// Formats duration as `Nms` under a second, then `N.Ns`, then `NmNs`.
fn duration(ms: u64) -> String {
	if ms < 1000 {
		format!("{ms}ms")
	} else if ms < 60_000 {
		#[expect(clippy::cast_precision_loss, reason = "display precision suffices")]
		let seconds = ms as f64 / 1000.0;
		format!("{seconds:.1}s")
	} else {
		format!("{}m{}s", ms / 60_000, (ms % 60_000) / 1000)
	}
}

#[cfg(test)]
mod tests {
	use omp_dom::{Op, Txn};
	use omp_session::{ComponentRegistry, Session};

	use super::*;
	use crate::overlays::services::StatsTool;

	#[test]
	fn stats_report_matches_the_pi_summary_layout() {
		let report = StatsReport {
			synced:            2,
			files:             5,
			requests:          42,
			errors:            3,
			input_tokens:      120_000,
			output_tokens:     3_456,
			cache_read:        80_000,
			cache_write:       1_000,
			cost_nano_usd:     1_234_000_000,
			unpriced:          0,
			avg_duration_ms:   Some(3_200),
			avg_ttft_ms:       Some(800),
			tokens_per_second: Some(45.26),
			by_model:          vec![StatsGroup {
				key: Str::new_static("anthropic/claude-sonnet-4-5"),
				requests: 40,
				cost_nano_usd: 1_234_000_000,
				input_tokens: 100_000,
				cache_read: 100_000,
				..StatsGroup::default()
			}],
			by_folder:         vec![StatsGroup {
				key: Str::new_static("/work/omp"),
				requests: 42,
				unpriced: 2,
				..StatsGroup::default()
			}],
			tools:             vec![StatsTool {
				tool:   Str::new_static("read"),
				calls:  12,
				errors: 1,
			}],
		};
		let text = stats_report(&report);
		assert!(text.contains("Synced 2 changed journals (5 total)"), "{text}");
		assert!(text.contains("- Requests: 42 (3 errors)"), "{text}");
		assert!(text.contains("- Error Rate: 7.1%"), "{text}");
		assert!(text.contains("- Total Tokens: 123,456"), "{text}");
		assert!(text.contains("- Cache Rate: 40.0%"), "{text}");
		assert!(text.contains("- API-equivalent estimate: $1.23"), "{text}");
		assert!(text.contains("- Avg Duration: 3.2s"), "{text}");
		assert!(text.contains("- Avg TTFT: 800ms"), "{text}");
		assert!(text.contains("- Avg Tokens/s: 45.3"), "{text}");
		assert!(
			text.contains("- anthropic/claude-sonnet-4-5: 40 reqs, $1.23, 50.0% cache rate"),
			"{text}"
		);
		assert!(text.contains("- /work/omp: 42 reqs, N/A"), "{text}");
		assert!(text.contains("- read: 12 calls, 1 error"), "{text}");
	}

	#[test]
	fn cost_and_duration_follow_pi_formatting() {
		assert_eq!(cost(0, 3), "N/A");
		assert_eq!(cost(5_000_000, 0), "$0.0050");
		assert_eq!(cost(250_000_000, 1), "$0.250 (1 unpriced)");
		assert_eq!(duration(950), "950ms");
		assert_eq!(duration(61_500), "1m1s");
		assert_eq!(number(1_234_567), "1,234,567");
	}

	#[test]
	fn trace_report_spans_the_last_turn_and_interleaves_kernel_events() {
		let directory = tempfile::tempdir().unwrap();
		let mut session =
			Session::create(directory.path().join("trace.oms"), ComponentRegistry::standard())
				.unwrap();
		assert!(trace_report(session.dom(), &[]).is_none());
		session.begin_turn().unwrap();
		session.user("fix the tests", Vec::new()).unwrap();
		let assistant = session
			.assistant_start("anthropic/claude-sonnet-4-5", "anthropic", "anthropic")
			.unwrap();
		let call = session
			.call(
				"read",
				1,
				"call-1",
				Some(Str::new_static("Reading note")),
				Some(
					serde_json::value::to_raw_value(&serde_json::json!({"path": "note.txt"})).unwrap(),
				),
				None,
			)
			.unwrap();
		session
			.settle(
				call,
				serde_json::value::to_raw_value(
					&serde_json::json!({"kind": "ok", "value": {"text": "hi"}}),
				)
				.unwrap(),
			)
			.unwrap();
		session.assistant_end("tool_calls").unwrap();
		session
			.receipt(omp_journal::data::TurnReceipt {
				tokens_in:                   1_000,
				tokens_out:                  50,
				cost_nano_usd:               7_000_000,
				cache_read:                  0,
				cache_write:                 0,
				ttft_ms:                     Some(400),
				duration_ms:                 Some(1_500),
				premium_requests_millionths: 0,
				identity:                    None,
				recoveries:                  Vec::new(),
			})
			.unwrap();
		let _ = assistant;
		let dom = session.dom();
		let turn_start = dom
			.children(dom.body())
			.first()
			.and_then(|turn| dom.get(*turn))
			.and_then(|node| entry_ms(node, PropId::Id))
			.unwrap();
		let events = [
			TraceEvent { at_ms: turn_start.saturating_sub(10_000), label: Str::new_static("stale") },
			TraceEvent { at_ms: turn_start + 1, label: Str::new_static("inference started") },
		];
		let text = trace_report(dom, &events).unwrap();
		assert!(text.contains("**Trace · turn 1**"), "{text}");
		assert!(text.contains("Requests 1 · Tool Calls 1 · Tokens 1,050 · Cost $0.0070"), "{text}");
		assert!(text.contains("user   fix the tests"), "{text}");
		assert!(text.contains("model  anthropic/claude-sonnet-4-5 · stop tool_calls"), "{text}");
		assert!(text.contains("tool   read · ok · Reading note"), "{text}");
		assert!(text.contains("usage  ⤵ 1000 ⤴ 50 · ttft 400ms · 1.5s"), "{text}");
		assert!(text.contains("kernel inference started"), "{text}");
		assert!(!text.contains("stale"), "events before the turn are excluded:\n{text}");
		assert!(text.contains("| read | 1 | 0 |"), "{text}");
		// A patched-in notice shows as its kind.
		let turn = dom.children(dom.body())[0];
		let cause = session.head().unwrap();
		session
			.patch(Txn {
				cause,
				label: None,
				ops: vec![Op::Ins {
					parent: turn,
					after:  None,
					node:   omp_dom::NodeSpec::new(KnownTag::Notice)
						.with_prop(PropId::Kind, Value::Str(Str::new_static("error")))
						.with_content("boom"),
				}],
			})
			.unwrap();
		let text = trace_report(session.dom(), &[]).unwrap();
		assert!(text.contains("notice error: boom"), "{text}");
	}
}
